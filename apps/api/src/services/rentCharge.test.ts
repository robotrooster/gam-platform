/**
 * S609 — paying ahead, and the guard that still blocks paying short.
 *
 * Two rules that look symmetrical and are not:
 *
 *   UNDER-payment stays blocked (Nic, standing directive) — a partial payment
 *   can reset a landlord's eviction clock.
 *
 *   OVER-payment is now allowed. The old code rejected it too, but the comment
 *   beside that guard said "no pay-ahead — the UI has no amount field", which
 *   recorded a MISSING INPUT BOX, not a policy decision.
 *
 * And NO CEILING (Nic, DIRECTIVE): a lease-term cap was written and then
 * reversed the same session — utilities aren't known until a meter is read, so
 * any cap lands wrong at the end of every lease and forces the refund churn it
 * was meant to prevent.
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { db } from '../db'
import {
  cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedTenant,
  seedLease, seedLeaseTenant, seedAllocationRule,
} from '../test/dbHelpers'

vi.mock('./stripeConnect', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    createRentPlatformCharge: vi.fn(async () => ({ id: 'pi_s609_test', status: 'processing' })),
  }
})
vi.mock('../lib/stripe', () => ({
  getStripe: () => ({ paymentMethods: { retrieve: vi.fn(async () => ({ card: { country: 'US' } })) } }),
}))

import { chargeLeaseBalance, suggestedPayAheadFor } from './rentCharge'
import * as stripeConnect from './stripeConnect'

interface Fixture {
  landlordId: string; userId: string; propertyId: string
  unitId: string; tenantId: string; leaseId: string
}

/** `monthsLeft` sets the lease end — used only by the screen's suggestion. */
async function fixture(monthsLeft = 6): Promise<Fixture> {
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    const ll = await seedLandlord(client)
    const propertyId = await seedProperty(client, {
      landlordId: ll.landlordId, ownerUserId: ll.userId, managedByUserId: ll.userId })
    await seedAllocationRule(client, { propertyId, achFeePayer: 'tenant', cardFeePayer: 'tenant' })
    const unitId = await seedUnit(client, { propertyId, landlordId: ll.landlordId, withLateFeeDecision: true })
    const tenantId = await seedTenant(client)
    await client.query(`UPDATE tenants SET stripe_customer_id='cus_s609' WHERE id=$1`, [tenantId])
    const leaseId = await seedLease(client, { unitId, landlordId: ll.landlordId, rentAmount: 1000 })
    await client.query(
      `UPDATE leases SET end_date = (CURRENT_DATE + ($2 || ' months')::interval)::date WHERE id = $1`,
      [leaseId, String(monthsLeft)])
    await seedLeaseTenant(client, { leaseId, tenantId })
    await client.query('COMMIT')
    return { ...ll, propertyId, unitId, tenantId, leaseId }
  } catch (e) { await client.query('ROLLBACK'); throw e } finally { client.release() }
}

async function seedCharge(f: Fixture, amount: number, dueDate: string) {
  const r = await db.query<{ id: string }>(
    `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description)
     VALUES ($1,$2,$3,$4,'rent',$5,'pending',$6,'RENT') RETURNING id`,
    [f.unitId, f.leaseId, f.tenantId, f.landlordId, amount.toFixed(2), dueDate])
  return r.rows[0].id
}

async function seedCarried(f: Fixture, amount: number, dueDate: string) {
  const r = await db.query<{ id: string }>(
    `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description)
     VALUES ($1,$2,$3,$4,'carried_balance',$5,'pending',$6,'BALANCE') RETURNING id`,
    [f.unitId, f.leaseId, f.tenantId, f.landlordId, amount.toFixed(2), dueDate])
  return r.rows[0].id
}

const charge = (f: Fixture, amount: number) => chargeLeaseBalance({
  tenantId: f.tenantId, leaseId: f.leaseId, amount,
  paymentMethodId: 'pm_test', paymentMethodType: 'ach', source: 'portal',
})

describe('S609 pay-ahead', () => {
  let f: Fixture

  beforeAll(async () => {
    await db.query(
      `INSERT INTO platform_processing_rates
         (payment_method, customer_facing_flat, customer_facing_percent,
          stripe_cost_flat, stripe_cost_percent)
       SELECT 'ach', 6, 0, 0, 0.5
        WHERE NOT EXISTS (SELECT 1 FROM platform_processing_rates WHERE payment_method = 'ach')`)
  })

  beforeEach(async () => {
    await cleanupAllSchema()
    ;(stripeConnect.createRentPlatformCharge as any).mockClear()
    f = await fixture()
  })

  it('paying MORE than the balance banks the surplus as pay-ahead', async () => {
    await seedCharge(f, 1000, '2026-08-01')
    const r = await charge(f, 3000)              // this month plus two ahead

    expect(r.appliedTotal).toBeCloseTo(1000, 2)
    expect(r.payAhead).toBeCloseTo(2000, 2)

    // The surplus is recorded on the remittance; the webhook banks it as
    // prepaid credit when the charge settles.
    const rem = await db.query<{ unapplied_amount: string }>(
      `SELECT unapplied_amount::text FROM tenant_remittances WHERE id = $1`, [r.remittanceId])
    expect(Number(rem.rows[0].unapplied_amount)).toBeCloseTo(2000, 2)
  })

  it('Stripe is charged the WHOLE amount including the surplus', async () => {
    await seedCharge(f, 1000, '2026-08-01')
    await charge(f, 3000)
    // 3000 + the flat $6 tenant-borne bank fee.
    const sent = (stripeConnect.createRentPlatformCharge as any).mock.calls[0][0].amount
    expect(sent).toBeCloseTo(3006, 2)
  })

  it('paying LESS than the balance is still refused', async () => {
    await seedCharge(f, 1000, '2026-08-01')
    await expect(charge(f, 600)).rejects.toMatchObject({ statusCode: 422 })
  })

  it('paying exactly the balance still works, unchanged', async () => {
    await seedCharge(f, 1000, '2026-08-01')
    const r = await charge(f, 1000)
    expect(r.appliedTotal).toBeCloseTo(1000, 2)
    expect(r.payAhead).toBeCloseTo(0, 2)
  })

  // S609 (Nic, DIRECTIVE — reversed the lease-term ceiling the same session it
  // was written): "It shouldn't be the rest of their lease term specifically
  // because a tenant that's getting billed utilities... they never know what
  // it's gonna be until the meters are read. So let's just not put any cap on
  // it, to eliminate those pinch points."
  it('takes far more than the lease term is worth — there is NO cap', async () => {
    await seedCharge(f, 1000, '2026-08-01')
    const r = await charge(f, 20000)          // six months left; pays twenty
    expect(r.appliedTotal).toBeCloseTo(1000, 2)
    expect(r.payAhead).toBeCloseTo(19000, 2)
  })

  it('a lease at its very end can still pay ahead', async () => {
    const g = await fixture(0)
    await seedCharge(g, 1000, '2026-08-01')
    const r = await charge(g, 5000)
    expect(r.payAhead).toBeCloseTo(4000, 2)
  })

  it('the screen SUGGESTION is the rest of the lease term — advisory only', async () => {
    expect(await suggestedPayAheadFor(f.leaseId)).toBeCloseTo(6000, 2)
  })

  it('a month-to-month lease suggests a year', async () => {
    await db.query(`UPDATE leases SET end_date = NULL WHERE id = $1`, [f.leaseId])
    expect(await suggestedPayAheadFor(f.leaseId)).toBeCloseTo(12000, 2)
  })
})

// ── S622: arrears are payable in part; the lease's own charges are not ──
//
// Nic: "if they are behind a thousand dollars and we're carrying forward, they
// need to be paying on the new lease and making payments towards the outstanding
// balance... that balance should allow partial payments. The invoiced portion of
// the lease shouldn't allow partial payments."
//
// Before this, the two rules collided and trapped the tenant: arrears are the
// oldest charge, so pay-in-full demanded rent PLUS the whole old debt before it
// would accept anything. Someone $1,000 behind could not pay their rent at all,
// and took a late fee every month for it.
describe('S622 carried-forward balance', () => {
  let f: Fixture
  beforeEach(async () => {
    await cleanupAllSchema()
    ;(stripeConnect.createRentPlatformCharge as any).mockClear()
    f = await fixture()
  })

  it('rent alone is payable while $1,000 of arrears sits on the ledger', async () => {
    await seedCarried(f, 1000, '2026-01-01')   // older than the rent
    await seedCharge(f, 800, '2026-09-01')

    const r = await charge(f, 800)
    expect(r.appliedTotal).toBeCloseTo(800, 2)
    // Every cent went to RENT — the arrears did not crowd it out despite being
    // eight months older. Applications are recorded on the remittance.
    const applied = await db.query<{ type: string; amount_applied: string }>(
      `SELECT p.type, ra.amount_applied::text
         FROM remittance_applications ra JOIN payments p ON p.id = ra.payment_id
        WHERE ra.remittance_id = $1`, [r.remittanceId])
    expect(applied.rows.length).toBe(1)
    expect(applied.rows[0].type).toBe('rent')
    expect(Number(applied.rows[0].amount_applied)).toBeCloseTo(800, 2)
  })

  it('paying above the rent chips away at the arrears — a PARTIAL payment on them', async () => {
    await seedCarried(f, 1000, '2026-01-01')
    await seedCharge(f, 800, '2026-09-01')

    const r = await charge(f, 950)
    expect(r.appliedTotal).toBeCloseTo(950, 2)

    // $150 of the arrears was applied...
    const applied = await db.query<{ amount_applied: string }>(
      `SELECT ra.amount_applied::text
         FROM remittance_applications ra JOIN payments p ON p.id = ra.payment_id
        WHERE ra.remittance_id = $1 AND p.type = 'carried_balance'`, [r.remittanceId])
    expect(applied.rows.length).toBe(1)
    expect(Number(applied.rows[0].amount_applied)).toBeCloseTo(150, 2)

    // ...and the rest stays open as a remainder row. A partial payment on
    // arrears is allowed and expected — this is the whole carve-out.
    const stillOwed = await db.query<{ total: string }>(
      `SELECT COALESCE(SUM(amount),0)::text AS total FROM payments
        WHERE lease_id=$1 AND type='carried_balance' AND status='pending'`, [f.leaseId])
    expect(Number(stillOwed.rows[0].total)).toBeCloseTo(850, 2)
  })

  it('still refuses an underpayment of the RENT itself', async () => {
    await seedCarried(f, 1000, '2026-01-01')
    await seedCharge(f, 800, '2026-09-01')
    // The carve-out is only for arrears; the lease's own charges stay all-or-nothing.
    await expect(charge(f, 600)).rejects.toMatchObject({ statusCode: 422 })
  })

  it('with no rent outstanding, the arrears can be paid down in any amount', async () => {
    await seedCarried(f, 1000, '2026-01-01')
    const r = await charge(f, 250)
    expect(r.appliedTotal).toBeCloseTo(250, 2)
    expect(r.payAhead).toBeCloseTo(0, 2)
  })

  // Nic, double-checking S622: "they definitely cannot in any way, shape, or
  // form pay a partial amount on a current new charge. All new charges are paid
  // in full, and that's that."
  //
  // The carve-out must not have opened a side door. Sweep a range of amounts and
  // assert the invariant directly: whatever the tenant pays, every NON-carried
  // charge is either untouched or paid to the cent — never split.
  it('NO current charge is ever partially applied, at any payable amount', async () => {
    await seedCarried(f, 1000, '2026-01-01')
    await seedCharge(f, 800, '2026-09-01')
    await db.query(
      `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description)
       VALUES ($1,$2,$3,$4,'utility',120,'pending','2026-08-20','PROPANE')`,
      [f.unitId, f.leaseId, f.tenantId, f.landlordId])

    // requiredInFull = 800 rent + 120 propane = 920. Anything at or above it is
    // payable; walk across the arrears too.
    for (const amt of [920, 921, 1000, 1500, 1920, 2500]) {
      await cleanupAllSchema()
      f = await fixture()
      await seedCarried(f, 1000, '2026-01-01')
      await seedCharge(f, 800, '2026-09-01')
      await db.query(
        `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description)
         VALUES ($1,$2,$3,$4,'utility',120,'pending','2026-08-20','PROPANE')`,
        [f.unitId, f.leaseId, f.tenantId, f.landlordId])

      const r = await charge(f, amt)
      const partials = await db.query<{ type: string; n: string }>(
        `SELECT p.type, COUNT(*)::text AS n
           FROM payments p
          WHERE p.lease_id = $1 AND p.is_remainder = TRUE
          GROUP BY p.type`, [f.leaseId])
      const nonCarriedSplits = partials.rows.filter(x => x.type !== 'carried_balance')
      expect(nonCarriedSplits, `paying $${amt} split a current charge`).toEqual([])
      expect(r.appliedTotal).toBeGreaterThanOrEqual(920)
    }
  })

  it('refuses every amount below the current charges, however close', async () => {
    await seedCarried(f, 1000, '2026-01-01')
    await seedCharge(f, 800, '2026-09-01')
    for (const amt of [0.01, 100, 799, 799.99]) {
      await expect(charge(f, amt), `$${amt} should be refused`).rejects.toMatchObject({ statusCode: 422 })
    }
  })
})
