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

import { chargeLeaseBalance, suggestedPayAheadFor, prepaidNettable, CREDIT_COVERS_BALANCE, openLeaseGroups, settleLeaseFromCredit } from './rentCharge'
import { netTenantLeaseBalances } from './openBalances'
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

  // ── S637: A CREDIT REDUCES WHAT THE TENANT IS ASKED FOR ──────────────────
  //
  // Nic (DIRECTIVE): "It's a credit against the overall ledger." Credits stopped
  // pre-settling charges, so the charge row stays whole and the credit sits on
  // the account. If the pay-in-full gate did not net it, a tenant holding a
  // credit would be told to pay the gross, refused when they paid what they
  // actually owe, and take a late fee for a debt the LANDLORD owed THEM.
  it('S637: a credit lowers the pay-in-full figure — paying the net is accepted', async () => {
    await seedCharge(f, 800, '2026-09-01')
    await db.query(
      `INSERT INTO tenant_credits (landlord_id, tenant_id, lease_id, amount_original, amount_remaining, category)
       VALUES ($1,$2,$3,300,300,'other')`,
      [f.landlordId, f.tenantId, f.leaseId])

    // Owed is 800 − 300 = 500. The gross would have been refused before netting.
    const r = await charge(f, 500)
    expect(r.appliedTotal).toBeGreaterThan(0)

    // END STATE: the $800 is covered WHOLE by $500 cash + $300 credit, in one
    // transaction. Nothing is left owed and the credit is spent — the tenant
    // does not pay exactly what they owe and still show a balance.
    const owed = await db.query<{ owed: string }>(
      `SELECT COALESCE(SUM(amount),0)::text AS owed FROM payments
        WHERE lease_id=$1 AND status='pending'`, [f.leaseId])
    expect(Number(owed.rows[0].owed)).toBe(0)

    const credit = await db.query<{ r: string }>(
      `SELECT amount_remaining::text AS r FROM tenant_credits WHERE lease_id=$1`, [f.leaseId])
    expect(Number(credit.rows[0].r)).toBe(0)

    // The one remainder row here is the ALLOCATION splitting $800 against $500
    // of cash — not a credit splitting a charge. It is settled by the credit
    // immediately, in the same transaction, so it is never an open partial.
    const rem = await db.query<{ status: string }>(
      `SELECT status FROM payments WHERE lease_id=$1 AND is_remainder = TRUE`, [f.leaseId])
    for (const r of rem.rows) expect(r.status).toBe('settled')
  })

  it('S637: still refuses below the CREDITED figure — the rule holds, the number moved', async () => {
    await seedCharge(f, 800, '2026-09-01')
    await db.query(
      `INSERT INTO tenant_credits (landlord_id, tenant_id, lease_id, amount_original, amount_remaining, category)
       VALUES ($1,$2,$3,300,300,'other')`,
      [f.landlordId, f.tenantId, f.leaseId])
    // 499.99 is still short of the 500 they owe. Pay-in-full is not softened by
    // a credit — it is measured against the right number.
    await expect(charge(f, 499.99)).rejects.toMatchObject({ statusCode: 422 })
  })

  it('refuses every amount below the current charges, however close', async () => {
    await seedCarried(f, 1000, '2026-01-01')
    await seedCharge(f, 800, '2026-09-01')
    for (const amt of [0.01, 100, 799, 799.99]) {
      await expect(charge(f, amt), `$${amt} should be refused`).rejects.toMatchObject({ statusCode: 422 })
    }
  })
})

// ── S622: current charges come first, across the landlord's leases ──
//
// Nic: "they couldn't just pay eight hundred dollars on space b while leaving
// the five hundred dollar lease open." Three Oak Park tenants rent two spaces
// each; paying old arrears on one while current rent sits open on the other
// earns a late fee and starts an eviction clock on the unpaid space.
describe('S622 arrears wait for every space to be current', () => {
  let f: Fixture
  beforeEach(async () => {
    await cleanupAllSchema()
    ;(stripeConnect.createRentPlatformCharge as any).mockClear()
    f = await fixture()
  })

  async function secondSpace(landlordId: string, tenantId: string) {
    const c = await db.connect()
    try {
      await c.query('BEGIN')
      const propertyId = await seedProperty(c, {
        landlordId, ownerUserId: f.userId, managedByUserId: f.userId })
      const unitId = await seedUnit(c, { propertyId, landlordId, withLateFeeDecision: true })
      const leaseId = await seedLease(c, { unitId, landlordId })
      await seedLeaseTenant(c, { leaseId, tenantId })
      await c.query('COMMIT')
      return { unitId, leaseId }
    } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
  }

  const openRent = (unitId: string, leaseId: string, amt: number) => db.query(
    `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description)
     VALUES ($1,$2,$3,$4,'rent',$5,'pending','2026-09-01','RENT')`,
    [unitId, leaseId, f.tenantId, f.landlordId, amt.toFixed(2)])

  it('refuses to touch arrears while the OTHER space still owes rent', async () => {
    const b = await secondSpace(f.landlordId, f.tenantId)
    await seedCharge(f, 300, '2026-09-01')        // space A rent (this lease)
    await seedCarried(f, 1000, '2026-01-01')      // space A arrears
    await openRent(b.unitId, b.leaseId, 500)      // space B rent, unpaid

    // $800 = A's rent plus $500 into arrears, leaving B open. Refused.
    await expect(charge(f, 800)).rejects.toMatchObject({ statusCode: 422 })
    // Paying exactly what this lease owes is still fine.
    const r = await charge(f, 300)
    expect(r.appliedTotal).toBeCloseTo(300, 2)
  })

  it('allows the arrears once every space is current', async () => {
    const b = await secondSpace(f.landlordId, f.tenantId)
    await seedCharge(f, 300, '2026-09-01')
    await seedCarried(f, 1000, '2026-01-01')
    // Space B has nothing open.
    const r = await charge(f, 800)
    expect(r.appliedTotal).toBeCloseTo(800, 2)
  })

  // The trap that makes a portfolio-wide version wrong: a unit in eviction mode
  // cannot be paid at all, so requiring it to be current would permanently bar
  // the tenant from paying arrears anywhere. A floor must always be clearable.
  it('SKIPS a space in eviction hold — an unpayable lease cannot block arrears', async () => {
    const b = await secondSpace(f.landlordId, f.tenantId)
    await seedCharge(f, 300, '2026-09-01')
    await seedCarried(f, 1000, '2026-01-01')
    await openRent(b.unitId, b.leaseId, 500)
    await db.query(`UPDATE units SET payment_block = TRUE WHERE id = $1`, [b.unitId])

    const r = await charge(f, 800)
    expect(r.appliedTotal).toBeCloseTo(800, 2)
  })

  it('does not reach across LANDLORDS — GAM never withholds one landlord’s money for another', async () => {
    const other = await seedOtherLandlordSpace(f)
    await seedCharge(f, 300, '2026-09-01')
    await seedCarried(f, 1000, '2026-01-01')
    await db.query(
      `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description)
       VALUES ($1,$2,$3,$4,'rent',500,'pending','2026-09-01','RENT')`,
      [other.unitId, other.leaseId, f.tenantId, other.landlordId])

    const r = await charge(f, 800)
    expect(r.appliedTotal).toBeCloseTo(800, 2)
  })

  async function seedOtherLandlordSpace(f: Fixture) {
    const c = await db.connect()
    try {
      await c.query('BEGIN')
      const ll = await seedLandlord(c)
      const propertyId = await seedProperty(c, {
        landlordId: ll.landlordId, ownerUserId: ll.userId, managedByUserId: ll.userId })
      const unitId = await seedUnit(c, { propertyId, landlordId: ll.landlordId, withLateFeeDecision: true })
      const leaseId = await seedLease(c, { unitId, landlordId: ll.landlordId })
      await seedLeaseTenant(c, { leaseId, tenantId: f.tenantId })
      await c.query('COMMIT')
      return { unitId, leaseId, landlordId: ll.landlordId }
    } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
  }
})

// ── S654: MH 25 — the $10 paid ahead comes off what the tenant is asked ──────
//
// The bill email said $450 (a $460 bill less $10 paid ahead by check); the
// portal asked $460 and took it, leaving the $10 unspent. One rule now —
// prepaidNettable — feeds the charge, the portal and the outstanding list.
describe('S654 paid-ahead credit nets the ask (MH 25)', () => {
  let f: Fixture
  beforeEach(async () => {
    await cleanupAllSchema()
    ;(stripeConnect.createRentPlatformCharge as any).mockClear()
    f = await fixture()
  })

  /** One $460 October bill on an invoice, and $10 paid ahead by check. */
  async function mh25(f: Fixture) {
    const inv = await db.query<{ id: string }>(
      `INSERT INTO invoices (landlord_id, tenant_id, lease_id, unit_id, invoice_number,
                             due_date, subtotal_rent, total_amount, status)
       VALUES ($1,$2,$3,$4,'INV-S654-MH25','2026-10-01',460,460,'pending') RETURNING id`,
      [f.landlordId, f.tenantId, f.leaseId, f.unitId])
    const invoiceId = inv.rows[0].id
    await db.query(
      `INSERT INTO payments (invoice_id, unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description)
       VALUES ($1,$2,$3,$4,$5,'rent',460,'pending','2026-10-01','RENT')`,
      [invoiceId, f.unitId, f.leaseId, f.tenantId, f.landlordId])
    await db.query(
      `INSERT INTO lease_prepaid_credits (lease_id, tenant_id, amount_original, amount_remaining, note)
       VALUES ($1,$2,10,10,'check over the September bill')`, [f.leaseId, f.tenantId])
    return invoiceId
  }

  it('prepaidNettable reads the credit for the open bill — from the tenant, or from rows in hand', async () => {
    const invoiceId = await mh25(f)
    expect(await prepaidNettable(db, f.leaseId, { tenantId: f.tenantId })).toBe(10)
    const rows = [{ id: 'x', amount: 460, due_date: '2026-10-01', type: 'rent',
                    invoice_id: invoiceId, lease_id: f.leaseId, status: 'pending' }]
    expect(await prepaidNettable(db, f.leaseId, { rows })).toBe(10)
    // Never against a failed attempt — cash retries that row.
    expect(await prepaidNettable(db, f.leaseId, { rows: [{ ...rows[0], status: 'failed' }] })).toBe(0)
  })

  it('a monthly draw cap limits what comes off', async () => {
    await mh25(f)
    await db.query(`UPDATE leases SET prepaid_monthly_draw = 4 WHERE id = $1`, [f.leaseId])
    expect(await prepaidNettable(db, f.leaseId, { tenantId: f.tenantId })).toBe(4)
  })

  it('paying $450 settles the $460 bill, with the $10 drawn', async () => {
    const invoiceId = await mh25(f)
    const r = await charge(f, 450)
    expect(r.appliedTotal).toBeCloseTo(450, 2)
    expect(r.payAhead).toBeCloseTo(0, 2)

    // Nothing left open on the bill: $450 in flight, $10 settled from the credit.
    const open = await db.query<{ owed: string }>(
      `SELECT COALESCE(SUM(amount),0)::text AS owed FROM payments
        WHERE invoice_id = $1 AND status IN ('pending','failed')`, [invoiceId])
    expect(Number(open.rows[0].owed)).toBe(0)
    const settledByCredit = await db.query<{ amount: string; platform_held: boolean }>(
      `SELECT amount::text, platform_held FROM payments
        WHERE invoice_id = $1 AND status = 'settled'`, [invoiceId])
    expect(settledByCredit.rows.map(x => Number(x.amount))).toEqual([10])
    // A check the landlord deposited: settles like cash, nothing paid out (S654).
    expect(settledByCredit.rows[0].platform_held).toBe(false)

    const credit = await db.query<{ r: string }>(
      `SELECT amount_remaining::text AS r FROM lease_prepaid_credits WHERE lease_id = $1`, [f.leaseId])
    expect(Number(credit.rows[0].r)).toBe(0)
    const draws = await db.query<{ amount: string; billing_month: string }>(
      `SELECT amount::text, billing_month::text FROM lease_prepaid_credit_draws WHERE lease_id = $1`, [f.leaseId])
    expect(draws.rows).toEqual([{ amount: '10.00', billing_month: '2026-10-01' }])
  })

  it('still refuses below the netted figure', async () => {
    await mh25(f)
    await expect(charge(f, 449.99)).rejects.toMatchObject({ statusCode: 422 })
  })

  it('chargeRequiredOnly charges the server’s figure, whatever amount was passed', async () => {
    await mh25(f)
    const r = await chargeLeaseBalance({
      tenantId: f.tenantId, leaseId: f.leaseId, amount: 460, chargeRequiredOnly: true,
      paymentMethodId: 'pm_test', paymentMethodType: 'ach', source: 'autopay',
    })
    expect(r.appliedTotal).toBeCloseTo(450, 2)
    expect(r.payAhead).toBeCloseTo(0, 2)
    // 450 + the flat $6 tenant-borne bank fee — never the gross 460.
    const sent = (stripeConnect.createRentPlatformCharge as any).mock.calls[0][0].amount
    expect(sent).toBeCloseTo(456, 2)
  })

  // S654: it used to refuse with 409 and leave the bill open behind a $0
  // portal. The credit now settles it — still no remittance, no Stripe call.
  it('chargeRequiredOnly settles from credit, charging nothing, when credit covers the bill', async () => {
    const invoiceId = await mh25(f)
    await db.query(`UPDATE lease_prepaid_credits SET amount_original = 500, amount_remaining = 500 WHERE lease_id = $1`, [f.leaseId])
    const r = await chargeLeaseBalance({
      tenantId: f.tenantId, leaseId: f.leaseId, amount: 460, chargeRequiredOnly: true,
      paymentMethodId: 'pm_test', paymentMethodType: 'ach', source: 'autopay',
    })
    expect(r).toMatchObject({ status: 'settled_by_credit', chargeAmount: 0, creditNetted: 460 })
    const rem = await db.query(`SELECT 1 FROM tenant_remittances WHERE tenant_id = $1`, [f.tenantId])
    expect(rem.rows).toHaveLength(0)
    expect(stripeConnect.createRentPlatformCharge).not.toHaveBeenCalled()
    const { rows: [p] } = await db.query(`SELECT status FROM payments WHERE invoice_id = $1`, [invoiceId])
    expect(p.status).toBe('settled')
    const { rows: [c] } = await db.query(`SELECT amount_remaining::text AS r FROM lease_prepaid_credits WHERE lease_id = $1`, [f.leaseId])
    expect(c.r).toBe('40.00')
  })
})

// Shared by the S654 blocks below: a bill on its own invoice, the two credits,
// and the lease's ledger after a payment.
let seq = 0
async function bill(f: Fixture, due: string, lines: Array<[string, number]>) {
  const total = lines.reduce((s, [, a]) => s + a, 0)
  const inv = await db.query<{ id: string }>(
    `INSERT INTO invoices (landlord_id, tenant_id, lease_id, unit_id, invoice_number, due_date, total_amount, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'pending') RETURNING id`,
    [f.landlordId, f.tenantId, f.leaseId, f.unitId, `INV-S654-B-${++seq}`, due, total])
  for (const [type, amt] of lines) {
    await db.query(
      `INSERT INTO payments (invoice_id, unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'pending',$8,$9)`,
      [inv.rows[0].id, f.unitId, f.leaseId, f.tenantId, f.landlordId, type, amt, due,
       type === 'rent' ? 'RENT' : 'UTILITY'])
  }
  return inv.rows[0].id
}
const paidAhead = (f: Fixture, amt: number) => db.query(
  `INSERT INTO lease_prepaid_credits (lease_id, tenant_id, amount_original, amount_remaining)
   VALUES ($1,$2,$3,$3)`, [f.leaseId, f.tenantId, amt])
const landlordCredit = (f: Fixture, amt: number) => db.query(
  `INSERT INTO tenant_credits (landlord_id, tenant_id, lease_id, amount_original, amount_remaining, category)
   VALUES ($1,$2,$3,$4,$4,'goodwill')`, [f.landlordId, f.tenantId, f.leaseId, amt])

/** The lease after the payment: open, in flight, settled, the whole, and the credit left. */
async function ledger(f: Fixture) {
  const { rows: [x] } = await db.query<Record<string, string>>(`
    SELECT COALESCE(SUM(amount) FILTER (WHERE status IN ('pending','failed')), 0)::text AS open,
           COALESCE(SUM(amount) FILTER (WHERE status = 'processing'), 0)::text AS flight,
           COALESCE(SUM(amount) FILTER (WHERE status = 'settled'), 0)::text AS settled,
           COALESCE(SUM(amount), 0)::text AS total,
           (SELECT COALESCE(SUM(amount_remaining), 0) FROM lease_prepaid_credits WHERE lease_id = $1)::text AS prepaid,
           (SELECT COALESCE(SUM(amount_remaining), 0) FROM tenant_credits WHERE lease_id = $1)::text AS credit
      FROM payments WHERE lease_id = $1`, [f.leaseId])
  return { open: Number(x.open), flight: Number(x.flight), settled: Number(x.settled),
           total: Number(x.total), prepaidLeft: Number(x.prepaid), creditLeft: Number(x.credit) }
}
const draws = async (f: Fixture) => (await db.query(
  `SELECT billing_month::text AS month, SUM(amount)::text AS amount FROM lease_prepaid_credit_draws
    WHERE lease_id = $1 GROUP BY 1 ORDER BY 1`, [f.leaseId])).rows


// ── S654: both credits, and every open bill, settle with the payment ─────────
//
// Round 2 netted paid-ahead and landlord credit from the ask, but each credit
// clears whole rows only. Paying the net split the rent into the cash part and a
// remainder NEITHER credit could clear ($460, $10 paid ahead, $50 credit, paid
// $400: a $60 remainder), and a later bill's paid-ahead share was netted but
// never spent. Both left a bill open behind a $0 portal — and a late fee.
describe('S654 both credits and every open bill settle with the payment', () => {
  let f: Fixture
  beforeEach(async () => {
    await cleanupAllSchema()
    ;(stripeConnect.createRentPlatformCharge as any).mockClear()
    f = await fixture()
  })

  it('$460 bill, $10 paid ahead, $50 credit: paying $400 settles it and spends both', async () => {
    await bill(f, '2026-10-01', [['rent', 460]])
    await paidAhead(f, 10)
    await landlordCredit(f, 50)
    await expect(charge(f, 399.99)).rejects.toMatchObject({ statusCode: 422 })

    const r = await charge(f, 400)
    expect(r.appliedTotal).toBeCloseTo(400, 2)
    expect(r.payAhead).toBe(0)
    // Every dollar once: $400 in flight, $60 settled from the two credits, the
    // $460 bill whole and nothing open.
    expect(await ledger(f)).toEqual({ open: 0, flight: 400, settled: 60, total: 460, prepaidLeft: 0, creditLeft: 0 })
    expect(await draws(f)).toEqual([{ month: '2026-10-01', amount: '10.00' }])
    const { rows: [rem] } = await db.query(
      `SELECT amount::text, unapplied_amount::text FROM tenant_remittances WHERE id = $1`, [r.remittanceId])
    expect(rem).toEqual({ amount: '400.00', unapplied_amount: '0.00' })
    const settled = await db.query<{ amount: string; notes: string }>(
      `SELECT amount::text, notes FROM payments WHERE lease_id = $1 AND status = 'settled' ORDER BY amount`, [f.leaseId])
    expect(settled.rows.map(x => x.amount)).toEqual(['10.00', '50.00'])
    expect(settled.rows[0].notes).toMatch(/prepaid credit/)
    expect(settled.rows[1].notes).toMatch(/account credit/)
  })

  it('autopay’s server figure with both credits: $400 plus the fee, and the bill closes', async () => {
    await bill(f, '2026-10-01', [['rent', 460]])
    await paidAhead(f, 10)
    await landlordCredit(f, 50)
    await chargeLeaseBalance({
      tenantId: f.tenantId, leaseId: f.leaseId, amount: 460, chargeRequiredOnly: true,
      paymentMethodId: 'pm_test', paymentMethodType: 'ach', source: 'autopay',
    })
    expect((stripeConnect.createRentPlatformCharge as any).mock.calls[0][0].amount).toBeCloseTo(406, 2)
    expect(await ledger(f)).toEqual({ open: 0, flight: 400, settled: 60, total: 460, prepaidLeft: 0, creditLeft: 0 })
  })

  it('two open bills with $470 paid ahead: the ask is $450 and paying it closes both', async () => {
    const sept = await bill(f, '2026-09-01', [['rent', 460]])
    const oct = await bill(f, '2026-10-01', [['rent', 460]])
    await paidAhead(f, 470)
    expect(await prepaidNettable(db, f.leaseId, { tenantId: f.tenantId })).toBe(470)
    await expect(charge(f, 449.99)).rejects.toMatchObject({ statusCode: 422 })

    await charge(f, 450)
    expect(await ledger(f)).toEqual({ open: 0, flight: 450, settled: 470, total: 920, prepaidLeft: 0, creditLeft: 0 })
    // Each bill drew against its own month, oldest first.
    expect(await draws(f)).toEqual([{ month: '2026-09-01', amount: '460.00' }, { month: '2026-10-01', amount: '10.00' }])
    for (const inv of [sept, oct]) {
      const { rows: [o] } = await db.query<{ n: string }>(
        `SELECT COUNT(*)::text AS n FROM payments WHERE invoice_id = $1 AND status IN ('pending','failed')`, [inv])
      expect(o.n).toBe('0')
    }
  })

  it('a $100 monthly draw over two open bills: $100 off each, drawn against each month', async () => {
    await bill(f, '2026-09-01', [['rent', 460]])
    await bill(f, '2026-10-01', [['rent', 460]])
    await paidAhead(f, 1000)
    await db.query(`UPDATE leases SET prepaid_monthly_draw = 100 WHERE id = $1`, [f.leaseId])
    expect(await prepaidNettable(db, f.leaseId, { tenantId: f.tenantId })).toBe(200)

    await charge(f, 720)
    expect(await ledger(f)).toEqual({ open: 0, flight: 720, settled: 200, total: 920, prepaidLeft: 800, creditLeft: 0 })
    expect(await draws(f)).toEqual([{ month: '2026-09-01', amount: '100.00' }, { month: '2026-10-01', amount: '100.00' }])
  })

  it('rent and two utilities, $40 paid ahead and a $20 credit: every line closes', async () => {
    await bill(f, '2026-10-01', [['rent', 400], ['utility', 30], ['utility', 30]])
    await paidAhead(f, 40)
    await landlordCredit(f, 20)
    await charge(f, 400)
    expect(await ledger(f)).toEqual({ open: 0, flight: 400, settled: 60, total: 460, prepaidLeft: 0, creditLeft: 0 })
  })

  it('paying above the floor uses that much less credit — the rest stays on the account', async () => {
    await bill(f, '2026-10-01', [['rent', 460]])
    await paidAhead(f, 10)
    await landlordCredit(f, 50)
    await charge(f, 430)
    // Paid-ahead first ($10), then $20 of the landlord credit; $30 of it is left.
    expect(await ledger(f)).toEqual({ open: 0, flight: 430, settled: 30, total: 460, prepaidLeft: 0, creditLeft: 30 })
  })

  it('a failed attempt keeps its cash part; the credit takes its own piece', async () => {
    const inv = await bill(f, '2026-10-01', [['rent', 460]])
    await db.query(`UPDATE payments SET status = 'failed', stripe_payment_intent_id = 'pi_failed_once' WHERE invoice_id = $1`, [inv])
    await landlordCredit(f, 50)
    await charge(f, 410)
    expect(await ledger(f)).toEqual({ open: 0, flight: 410, settled: 50, total: 460, prepaidLeft: 0, creditLeft: 0 })
  })

  it('older arrears on the lease do not soak up the credit meant for this bill', async () => {
    await seedCarried(f, 20, '2026-01-01')
    await bill(f, '2026-10-01', [['rent', 460]])
    await landlordCredit(f, 50)
    await charge(f, 410)
    // The bill is closed; the $20 of arrears is still owed, on its own.
    expect(await ledger(f)).toEqual({ open: 20, flight: 410, settled: 50, total: 480, prepaidLeft: 0, creditLeft: 0 })
    const { rows: [o] } = await db.query<{ type: string }>(
      `SELECT type FROM payments WHERE lease_id = $1 AND status = 'pending'`, [f.leaseId])
    expect(o.type).toBe('carried_balance')
  })

  it('a quote (dry run) writes nothing and nets both credits', async () => {
    await bill(f, '2026-10-01', [['rent', 460]])
    await paidAhead(f, 10)
    await landlordCredit(f, 50)
    const q = await chargeLeaseBalance({
      tenantId: f.tenantId, leaseId: f.leaseId, amount: 0, chargeEverything: true, dryRun: true,
      paymentMethodType: 'card_present', source: 'front_desk_reader',
    })
    expect(q.appliedTotal).toBeCloseTo(400, 2)
    expect(q.creditNetted).toBeCloseTo(60, 2)
    expect(await ledger(f)).toEqual({ open: 460, flight: 0, settled: 0, total: 460, prepaidLeft: 10, creditLeft: 50 })
  })
})

// ── S654: credits that cover the bill, and rows a credit may not touch ───────
//
// The credit is netted from the ask everywhere; these are the shapes where the
// charge then could not honor it. Credits covering the whole floor left the bill
// open behind a $0 portal (and a late fee). A neighbor's utility on the bill was
// netted by this landlord's credit and the payment refused. Paid-ahead was
// planned onto a home payment the release never pays out, and onto a work-trade
// line. A general credit was netted on whichever lease was charged. A credit
// smaller than a late fee cut it in two, which the database refuses.
const leaseGroupsNet = async (f: Fixture) => {
  const groups = await openLeaseGroups(f.tenantId)
  return netTenantLeaseBalances(f.tenantId, groups)
}
const autopayCharge = (f: Fixture, leaseId = f.leaseId) => chargeLeaseBalance({
  tenantId: f.tenantId, leaseId, amount: 0, chargeRequiredOnly: true,
  paymentMethodId: 'pm_test', paymentMethodType: 'ach', source: 'autopay',
})
const remittances = async (f: Fixture) => (await db.query(
  `SELECT amount::text FROM tenant_remittances WHERE tenant_id = $1`, [f.tenantId])).rows

describe('S654 credits that cover the bill, and rows a credit may not touch', () => {
  let f: Fixture
  // A release of GAM-held money books the landlord's share, which reads this rate.
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

  it('$10 paid ahead and a $450 credit cover a $460 bill: it settles with nothing charged, and no late fee follows', async () => {
    const inv = await bill(f, '2026-09-01', [['rent', 460]])
    await paidAhead(f, 10)
    await landlordCredit(f, 450)
    expect((await leaseGroupsNet(f)).get(f.leaseId)).toMatchObject({ outstanding: 0, requiredNow: 0 })

    const r = await autopayCharge(f)
    expect(r.status).toBe('settled_by_credit')
    expect(r.chargeAmount).toBe(0)
    expect(stripeConnect.createRentPlatformCharge).not.toHaveBeenCalled()
    expect(await remittances(f)).toEqual([])
    expect(await ledger(f)).toEqual({ open: 0, flight: 0, settled: 460, total: 460, prepaidLeft: 0, creditLeft: 0 })
    expect(await draws(f)).toEqual([{ month: '2026-09-01', amount: '10.00' }])

    // The bill is closed, so the late-fee engine has nothing to fee.
    const { rows: [i] } = await db.query(`SELECT status FROM invoices WHERE id = $1`, [inv])
    expect(i.status).toBe('settled')
    await db.query(`UPDATE properties SET timezone = 'America/Phoenix', late_fee_enabled = TRUE WHERE id = $1`, [f.propertyId])
    await db.query(
      `UPDATE leases SET late_fee_enabled = TRUE, late_fee_grace_days = 0, late_fee_initial_type = 'flat',
              late_fee_initial_amount = 15 WHERE id = $1`, [f.leaseId])
    const { generateLateFeesForInvoice } = await import('../jobs/lateFees')
    await generateLateFeesForInvoice(inv)
    const fees = await db.query(`SELECT 1 FROM payments WHERE invoice_id = $1 AND type = 'late_fee'`, [inv])
    expect(fees.rows).toHaveLength(0)
  })

  it('$1,000 held under a $100 monthly draw and a $360 credit cover a $460 bill', async () => {
    await bill(f, '2026-10-01', [['rent', 460]])
    await paidAhead(f, 1000)
    await db.query(`UPDATE leases SET prepaid_monthly_draw = 100 WHERE id = $1`, [f.leaseId])
    await landlordCredit(f, 360)
    const r = await autopayCharge(f)
    expect(r.status).toBe('settled_by_credit')
    expect(await ledger(f)).toEqual({ open: 0, flight: 0, settled: 460, total: 460, prepaidLeft: 900, creditLeft: 0 })
    expect(await draws(f)).toEqual([{ month: '2026-10-01', amount: '100.00' }])
  })

  it('paid-ahead alone covering two bills settles both, each against its own month', async () => {
    await bill(f, '2026-09-01', [['rent', 460]])
    await bill(f, '2026-10-01', [['rent', 460]])
    await paidAhead(f, 920)
    const r = await autopayCharge(f)
    expect(r.status).toBe('settled_by_credit')
    expect(await ledger(f)).toEqual({ open: 0, flight: 0, settled: 920, total: 920, prepaidLeft: 0, creditLeft: 0 })
    expect(await draws(f)).toEqual([{ month: '2026-09-01', amount: '460.00' }, { month: '2026-10-01', amount: '460.00' }])
  })

  it('the counter settles from credit when it covers everything, arrears included; the reader still refuses a $0 card', async () => {
    await seedCarried(f, 20, '2026-01-01')
    await bill(f, '2026-10-01', [['rent', 460]])
    await landlordCredit(f, 500)
    await expect(chargeLeaseBalance({
      tenantId: f.tenantId, leaseId: f.leaseId, amount: 0, chargeEverything: true, dryRun: true,
      paymentMethodType: 'card_present', source: 'front_desk_reader',
    })).rejects.toMatchObject({ statusCode: 409, message: expect.stringContaining(CREDIT_COVERS_BALANCE) })

    const r = await chargeLeaseBalance({
      tenantId: f.tenantId, leaseId: f.leaseId, amount: 0, chargeEverything: true,
      paymentMethodType: 'card_present', source: 'front_desk_reader',
    })
    expect(r.status).toBe('settled_by_credit')
    expect(await ledger(f)).toEqual({ open: 0, flight: 0, settled: 480, total: 480, prepaidLeft: 0, creditLeft: 20 })
  })

  it('with only arrears open there is nothing due now — autopay settles nothing', async () => {
    await seedCarried(f, 20, '2026-01-01')
    await landlordCredit(f, 500)
    await expect(autopayCharge(f)).rejects.toMatchObject({ statusCode: 409, message: CREDIT_COVERS_BALANCE })
    expect(await ledger(f)).toMatchObject({ open: 20, creditLeft: 500 })
  })

  it('a neighbor’s utility on the bill is never netted by this landlord’s credit', async () => {
    const inv = await bill(f, '2026-10-01', [['rent', 460]])
    const nb = await (async () => {
      const c = await db.connect()
      try { return await seedLandlord(c) } finally { c.release() }
    })()
    await db.query(
      `INSERT INTO payments (invoice_id, unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description)
       VALUES ($1,$2,NULL,$3,$4,'utility',40,'pending','2026-10-01','UTILITY')`,
      [inv, f.unitId, f.tenantId, nb.landlordId])
    await landlordCredit(f, 480)
    expect((await leaseGroupsNet(f)).get(f.leaseId)).toMatchObject({ requiredNow: 40, creditApplied: 460 })

    await autopayCharge(f)
    // $40 for the neighbor's utility plus the $6 bank fee; the rent is the credit's.
    expect((stripeConnect.createRentPlatformCharge as any).mock.calls[0][0].amount).toBeCloseTo(46, 2)
    expect(await ledger(f)).toMatchObject({ open: 0, settled: 460, creditLeft: 20 })
    const { rows: [n] } = await db.query(`SELECT status, amount::text FROM payments WHERE landlord_id = $1`, [nb.landlordId])
    expect(n).toEqual({ status: 'processing', amount: '40.00' })
  })

  it('paid-ahead never goes on a home payment: the floor is the home payment, paid in cash', async () => {
    const inv = await bill(f, '2026-10-01', [['rent', 460]])
    await db.query(
      `INSERT INTO payments (invoice_id, unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description)
       VALUES ($1,$2,$3,$4,$5,'home_payment',200,'pending','2026-10-01','HOMEPMT')`,
      [inv, f.unitId, f.leaseId, f.tenantId, f.landlordId])
    // $650 paid ahead through the bank — GAM holds it.
    const { rows: [rem] } = await db.query<{ id: string }>(
      `INSERT INTO tenant_remittances (tenant_id, landlord_id, amount, applied_amount, unapplied_amount, status,
                                       payment_method, stripe_payment_intent_id, processing_fee_amount)
       VALUES ($1,$2,650,0,650,'settled','ach','pi_s654_home',0) RETURNING id`, [f.tenantId, f.landlordId])
    await db.query(
      `INSERT INTO lease_prepaid_credits (lease_id, tenant_id, amount_original, amount_remaining, source_remittance_id)
       VALUES ($1,$2,650,650,$3)`, [f.leaseId, f.tenantId, rem.id])
    expect(await prepaidNettable(db, f.leaseId, { tenantId: f.tenantId })).toBe(460)
    await expect(charge(f, 199.99)).rejects.toMatchObject({ statusCode: 422 })

    await charge(f, 200)
    const rows = (await db.query<{ type: string; status: string; amount: string; platform_held: boolean; id: string }>(
      `SELECT id, type, status, amount::text, platform_held FROM payments WHERE lease_id = $1 ORDER BY type`, [f.leaseId])).rows
    expect(rows.map(r => [r.type, r.status, r.amount])).toEqual([['home_payment', 'processing', '200.00'], ['rent', 'settled', '460.00']])
    // The rent was GAM-held paid-ahead money, so the landlord is paid it.
    const rent = rows.find(r => r.type === 'rent')!
    expect(rent.platform_held).toBe(true)
    const { rows: [share] } = await db.query(
      `SELECT amount::text FROM user_balance_ledger WHERE reference_id = $1 AND type = 'allocation_owner_share'`, [rent.id])
    expect(Number(share.amount)).toBeCloseTo(460, 2)
    expect(await ledger(f)).toMatchObject({ open: 0, prepaidLeft: 190 })
  })

  it('an $8 work-trade line on the bill: paying the $400 shown closes the bill and leaves the trade line alone', async () => {
    const inv = await bill(f, '2026-10-01', [['rent', 460]])
    await db.query(
      `INSERT INTO payments (invoice_id, unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description, work_trade_suspended_at)
       VALUES ($1,$2,$3,$4,$5,'utility',8,'pending','2026-10-01','UTILITY',NOW())`,
      [inv, f.unitId, f.leaseId, f.tenantId, f.landlordId])
    await paidAhead(f, 10)
    await landlordCredit(f, 50)
    expect((await leaseGroupsNet(f)).get(f.leaseId)).toMatchObject({ requiredNow: 400 })
    await charge(f, 400)
    const { rows: [l] } = await db.query<Record<string, string>>(`
      SELECT COALESCE(SUM(amount) FILTER (WHERE status IN ('pending','failed') AND work_trade_suspended_at IS NULL), 0)::text AS open,
             (SELECT status || ' ' || amount::text FROM payments WHERE lease_id = $1 AND work_trade_suspended_at IS NOT NULL) AS trade
        FROM payments WHERE lease_id = $1`, [f.leaseId])
    expect(l).toEqual({ open: '0', trade: 'pending 8.00' })
    expect(await ledger(f)).toMatchObject({ prepaidLeft: 0, creditLeft: 0 })
    const alerts = await db.query(`SELECT 1 FROM admin_notifications WHERE category IN ('credit_not_applied','prepaid_release_failed')`)
    expect(alerts.rows).toHaveLength(0)
  })

  it('a general credit nets only on the lease the portal gives it to — the oldest bill', async () => {
    // Lease 1 (this fixture) has September open; lease 2, same landlord, October.
    const two = await (async () => {
      const c = await db.connect()
      try {
        await c.query('BEGIN')
        const unitId = await seedUnit(c, { propertyId: f.propertyId, landlordId: f.landlordId, withLateFeeDecision: true })
        const leaseId = await seedLease(c, { unitId, landlordId: f.landlordId, rentAmount: 300 })
        await seedLeaseTenant(c, { leaseId, tenantId: f.tenantId })
        await c.query('COMMIT')
        return { ...f, unitId, leaseId }
      } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
    })()
    await bill(f, '2026-09-01', [['rent', 460]])
    await bill(two, '2026-10-01', [['rent', 300]])
    await db.query(
      `INSERT INTO tenant_credits (landlord_id, tenant_id, lease_id, amount_original, amount_remaining, category)
       VALUES ($1,$2,NULL,50,50,'goodwill')`, [f.landlordId, f.tenantId])
    const net = await leaseGroupsNet(f)
    expect(net.get(f.leaseId)).toMatchObject({ outstanding: 410, creditApplied: 50 })
    expect(net.get(two.leaseId)).toMatchObject({ outstanding: 300, creditApplied: 0 })

    await autopayCharge(f, two.leaseId)
    expect((stripeConnect.createRentPlatformCharge as any).mock.calls[0][0].amount).toBeCloseTo(306, 2)
    const { rows: [c] } = await db.query(`SELECT amount_remaining::text AS r FROM tenant_credits WHERE tenant_id = $1`, [f.tenantId])
    expect(c.r).toBe('50.00')
    expect((await leaseGroupsNet(f)).get(f.leaseId)).toMatchObject({ outstanding: 410 })
  })

  it('a $10 credit never cuts a $15 late fee in two — it goes on the rent', async () => {
    await bill(f, '2026-10-01', [['rent', 460], ['late_fee', 15]])
    await landlordCredit(f, 10)
    await charge(f, 465)
    expect(await ledger(f)).toEqual({ open: 0, flight: 465, settled: 10, total: 475, prepaidLeft: 0, creditLeft: 0 })
    const { rows: [lf] } = await db.query(`SELECT status, amount::text FROM payments WHERE lease_id = $1 AND type = 'late_fee'`, [f.leaseId])
    expect(lf).toEqual({ status: 'processing', amount: '15.00' })
  })

  it('above the floor, when a smaller credit cannot lie on whole late fees, the extra cash is banked as paid-ahead', async () => {
    await bill(f, '2026-10-01', [['late_fee', 15]])
    await bill(f, '2026-10-02', [['late_fee', 10]])
    await landlordCredit(f, 20)
    // The $20 credit can clear the $15 fee whole, never part of either: the floor is $10.
    expect((await leaseGroupsNet(f)).get(f.leaseId)).toMatchObject({ requiredNow: 10, creditApplied: 15 })
    const r = await charge(f, 12)
    expect(r.payAhead).toBeCloseTo(2, 2)
    expect(await ledger(f)).toEqual({ open: 0, flight: 10, settled: 15, total: 25, prepaidLeft: 0, creditLeft: 5 })
    const { rows: [rem] } = await db.query(`SELECT unapplied_amount::text AS u FROM tenant_remittances WHERE id = $1`, [r.remittanceId])
    expect(rem.u).toBe('2.00')
  })

  it('a failed attempt the credit covers whole is settled from it, with nothing charged', async () => {
    const inv = await bill(f, '2026-10-01', [['rent', 460]])
    await db.query(`UPDATE payments SET status = 'failed', stripe_payment_intent_id = 'pi_failed_once', next_retry_at = NOW() WHERE invoice_id = $1`, [inv])
    await landlordCredit(f, 500)
    expect((await leaseGroupsNet(f)).get(f.leaseId)).toMatchObject({ requiredNow: 0 })
    const r = await autopayCharge(f)
    expect(r.status).toBe('settled_by_credit')
    expect(await ledger(f)).toEqual({ open: 0, flight: 0, settled: 460, total: 460, prepaidLeft: 0, creditLeft: 40 })
    const { rows: [p] } = await db.query(`SELECT stripe_payment_intent_id, next_retry_at FROM payments WHERE invoice_id = $1`, [inv])
    expect(p).toEqual({ stripe_payment_intent_id: null, next_retry_at: null })
  })

  it('settleLeaseFromCredit closes a covered bill and never charges an uncovered one', async () => {
    await bill(f, '2026-10-01', [['rent', 460]])
    await paidAhead(f, 10)
    await landlordCredit(f, 400)
    // $50 would still be owed: nothing is written and nothing is charged.
    expect(await settleLeaseFromCredit(f.tenantId, f.leaseId)).toBe(0)
    expect(await ledger(f)).toEqual({ open: 460, flight: 0, settled: 0, total: 460, prepaidLeft: 10, creditLeft: 400 })
    await landlordCredit(f, 50)
    expect(await settleLeaseFromCredit(f.tenantId, f.leaseId)).toBe(460)
    expect(await ledger(f)).toEqual({ open: 0, flight: 0, settled: 460, total: 460, prepaidLeft: 0, creditLeft: 0 })
    expect(stripeConnect.createRentPlatformCharge).not.toHaveBeenCalled()
    expect(await remittances(f)).toEqual([])
    // Nothing left to settle.
    expect(await settleLeaseFromCredit(f.tenantId, f.leaseId)).toBe(0)
  })

  it('a landlord passing the platform fee to the tenant: the fee and the pass-through come back apart', async () => {
    await bill(f, '2026-10-01', [['rent', 460]])
    await db.query(
      `INSERT INTO platform_fee_accruals (landlord_id, property_id, accrual_month, rate_per_unit, min_per_connect_account, total_amount, payer)
       VALUES ($1,$2,'2026-10-01',2,10,10,'tenant')`, [f.landlordId, f.propertyId])
    const r = await autopayCharge(f)
    expect(r.processingFee).toBeCloseTo(6, 2)
    expect(r.platformFeePassthrough).toBeCloseTo(10, 2)
    expect(r.chargeAmount).toBeCloseTo(476, 2)
  })
})

// ── S654: every dollar once, across shapes nobody wrote a test for ──────────
//
// One to three bills with utilities, late fees, a home payment, a work-trade
// line and a neighbor's utility; a failed attempt, older arrears; paid-ahead
// (GAM-held or not) with and without a monthly draw; a lease or general landlord
// credit, sometimes covering everything; a second lease sharing the general
// credit — paid at the floor, above it, at the counter, or by autopay.
// Whatever the shape:
//   the portal's figure is the floor (a cent less is refused) and is what
//   autopay and the counter take; afterwards the portal asks for nothing;
//   every settled dollar is a credit drawn and every dollar in flight is the
//   payment's; a work-trade line, a home payment and a neighbor's utility are
//   never paid from paid-ahead; the other lease's figure does not move.
describe('S654 credit split — random shapes (fixed seed)', () => {
  beforeAll(async () => {
    await db.query(
      `INSERT INTO platform_processing_rates
         (payment_method, customer_facing_flat, customer_facing_percent,
          stripe_cost_flat, stripe_cost_percent)
       SELECT 'ach', 6, 0, 0, 0.5
        WHERE NOT EXISTS (SELECT 1 FROM platform_processing_rates WHERE payment_method = 'ach')`)
  })

  it('portal figure == pay floor == what settles, every dollar once', async () => {
    let seed = 12345
    let ran = 0
    const modes: Record<string, number> = {}
    const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648 }
    const pick = (lo: number, hi: number) => Math.round((lo + rnd() * (hi - lo)) * 100) / 100
    const withClient = async <T>(fn: (c: any) => Promise<T>) => {
      const c = await db.connect()
      try { await c.query('BEGIN'); const r = await fn(c); await c.query('COMMIT'); return r }
      catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
    }
    const failures: string[] = []
    for (let iter = 0; iter < 90; iter++) {
      await cleanupAllSchema()
      ;(stripeConnect.createRentPlatformCharge as any).mockClear()
      const f = await fixture()
      const shape: any = { bills: [], prepaid: 0, held: false, cap: null, credit: 0, general: false, carried: 0, failed: false, second: null }
      let nb: string | null = null
      const neighbor = async () => (nb ??= (await withClient(c => seedLandlord(c))).landlordId)
      const nBills = 1 + Math.floor(rnd() * 3)
      for (let b = 0; b < nBills; b++) {
        const due = `2026-0${7 + b}-01`
        const lines: Array<{ type: string; amt: number; neighbor?: boolean; trade?: boolean }> = [{ type: 'rent', amt: pick(100, 600) }]
        const extra = Math.floor(rnd() * 3)
        for (let k = 0; k < extra; k++) lines.push({ type: 'utility', amt: pick(1, 80) })
        if (rnd() < 0.25) lines.push({ type: 'late_fee', amt: pick(5, 40) })
        if (rnd() < 0.15) lines.push({ type: 'home_payment', amt: pick(50, 300) })
        if (rnd() < 0.2) lines.push({ type: 'utility', amt: pick(1, 50), trade: true })
        if (rnd() < 0.15) lines.push({ type: 'utility', amt: pick(5, 60), neighbor: true })
        const total = lines.filter(l => !l.trade).reduce((x, l) => x + l.amt, 0)
        const inv = await db.query<{ id: string }>(
          `INSERT INTO invoices (landlord_id, tenant_id, lease_id, unit_id, invoice_number, due_date, total_amount, status)
           VALUES ($1,$2,$3,$4,$5,$6,$7,'pending') RETURNING id`,
          [f.landlordId, f.tenantId, f.leaseId, f.unitId, `INV-S654-R-${iter}-${b}`, due, total.toFixed(2)])
        for (const l of lines) {
          await db.query(
            `INSERT INTO payments (invoice_id, unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description, work_trade_suspended_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,'pending',$8,$9,$10)`,
            [inv.rows[0].id, f.unitId, l.neighbor ? null : f.leaseId, f.tenantId, l.neighbor ? await neighbor() : f.landlordId,
             l.type, l.amt.toFixed(2), due,
             ({ rent: 'RENT', late_fee: 'LATEFEE', home_payment: 'HOMEPMT' } as Record<string, string>)[l.type] ?? 'UTILITY',
             l.trade ? new Date() : null])
        }
        shape.bills.push(lines.map(l => `${l.type}${l.neighbor ? '(nb)' : ''}${l.trade ? '(wt)' : ''}:${l.amt}`))
      }
      if (rnd() < 0.2) {
        await db.query(`UPDATE payments SET status='failed', stripe_payment_intent_id='pi_fail_x'
                         WHERE id = (SELECT id FROM payments WHERE lease_id=$1 AND work_trade_suspended_at IS NULL ORDER BY due_date, created_at LIMIT 1)`, [f.leaseId])
        shape.failed = true
      }
      if (rnd() < 0.3) { shape.carried = pick(5, 200); await seedCarried(f, shape.carried, '2026-01-01') }
      if (rnd() < 0.75) {
        shape.prepaid = pick(1, 1500)
        shape.held = rnd() < 0.5
        let remId: string | null = null
        if (shape.held) {
          remId = (await db.query<{ id: string }>(
            `INSERT INTO tenant_remittances (tenant_id, landlord_id, amount, applied_amount, unapplied_amount, status,
                                             payment_method, stripe_payment_intent_id, processing_fee_amount)
             VALUES ($1,$2,$3,0,$3,'settled','ach',$4,0) RETURNING id`,
            [f.tenantId, f.landlordId, shape.prepaid, `pi_held_${iter}`])).rows[0].id
        }
        await db.query(`INSERT INTO lease_prepaid_credits (lease_id, tenant_id, amount_original, amount_remaining, source_remittance_id) VALUES ($1,$2,$3,$3,$4)`,
          [f.leaseId, f.tenantId, shape.prepaid, remId])
        if (rnd() < 0.4) { shape.cap = pick(5, 300); await db.query(`UPDATE leases SET prepaid_monthly_draw=$2 WHERE id=$1`, [f.leaseId, shape.cap]) }
      }
      const ownRequired = Number((await db.query<{ t: string }>(
        `SELECT COALESCE(SUM(amount),0)::text AS t FROM payments WHERE lease_id=$1 AND type <> 'carried_balance' AND work_trade_suspended_at IS NULL`, [f.leaseId])).rows[0].t)
      const cr = rnd()
      if (cr < 0.6) {
        // One in four: a credit big enough to cover everything (credits-cover-all).
        shape.credit = cr < 0.15 ? Math.round((ownRequired + pick(0, 200)) * 100) / 100 : pick(1, 400)
        shape.general = rnd() < 0.5
        await db.query(`INSERT INTO tenant_credits (landlord_id, tenant_id, lease_id, amount_original, amount_remaining, category)
                        VALUES ($1,$2,$3,$4,$4,'goodwill')`, [f.landlordId, f.tenantId, shape.general ? null : f.leaseId, shape.credit])
      }
      let second: { leaseId: string } | null = null
      if (rnd() < 0.2) {
        const due = rnd() < 0.5 ? '2026-06-01' : '2026-12-01'
        second = await withClient(async c => {
          const unitId = await seedUnit(c, { propertyId: f.propertyId, landlordId: f.landlordId, withLateFeeDecision: true })
          const leaseId = await seedLease(c, { unitId, landlordId: f.landlordId, rentAmount: 300 })
          await seedLeaseTenant(c, { leaseId, tenantId: f.tenantId })
          await c.query(`INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description)
                         VALUES ($1,$2,$3,$4,'rent',$5,'pending',$6,'RENT')`, [unitId, leaseId, f.tenantId, f.landlordId, pick(100, 500), due])
          return { leaseId }
        })
        shape.second = due
      }

      const sums = async () => (await db.query<Record<string, string>>(`
        SELECT COALESCE(SUM(p.amount), 0)::text AS total,
               COALESCE(SUM(p.amount) FILTER (WHERE p.status = 'settled' AND p.lease_id = $2), 0)::text AS settled,
               COALESCE(SUM(p.amount) FILTER (WHERE p.status = 'processing'), 0)::text AS flight,
               COALESCE(SUM(p.amount) FILTER (WHERE p.status IN ('pending','failed') AND p.work_trade_suspended_at IS NULL
                                                AND p.type <> 'carried_balance'
                                                AND (p.lease_id = $2 OR p.invoice_id IN (SELECT id FROM invoices WHERE lease_id = $2))), 0)::text AS open_required,
               COALESCE(SUM(p.amount) FILTER (WHERE p.status IN ('pending','failed') AND p.work_trade_suspended_at IS NULL
                                                AND (p.lease_id = $2 OR p.invoice_id IN (SELECT id FROM invoices WHERE lease_id = $2))), 0)::text AS open_all,
               COALESCE(SUM(p.amount) FILTER (WHERE p.work_trade_suspended_at IS NOT NULL AND p.status <> 'pending'), 0)::text AS trade_touched,
               COALESCE(SUM(p.amount) FILTER (WHERE p.landlord_id <> $3 AND p.status = 'settled'), 0)::text AS neighbor_settled,
               COALESCE(SUM(p.amount) FILTER (WHERE p.type IN ('home_payment','deposit') AND p.notes LIKE '%prepaid credit%'), 0)::text AS home_by_prepaid,
               (SELECT COALESCE(SUM(amount_original - amount_remaining), 0) FROM lease_prepaid_credits WHERE lease_id = $2)::text AS prepaid_used,
               (SELECT COALESCE(SUM(amount_original - amount_remaining), 0) FROM tenant_credits WHERE tenant_id = $1)::text AS credit_used,
               (SELECT COUNT(*) FROM admin_notifications WHERE category IN ('credit_not_applied','prepaid_release_failed'))::text AS alerts
          FROM payments p WHERE p.tenant_id = $1`, [f.tenantId, f.leaseId, f.landlordId])).rows[0]
      const before = await sums()
      const netBefore = await leaseGroupsNet(f)
      const mine = netBefore.get(f.leaseId)!
      const otherBefore = second ? netBefore.get(second.leaseId)?.outstanding ?? 0 : null
      const requiredBefore = Math.round((Number(before.open_required)) * 100) / 100
      const landlordRequired = Math.round((requiredBefore - mine.prepaidApplied - mine.requiredNow) * 100) / 100

      const r0 = rnd()
      let mode = r0 < 0.35 ? 'floor' : r0 < 0.55 ? 'over' : r0 < 0.75 ? 'counter' : 'autopay'
      if ((mode === 'floor' || mode === 'over') && mine.requiredNow < 0.01) mode = 'autopay'
      modes[mode] = (modes[mode] ?? 0) + 1
      const problems: string[] = []
      let amount = 0
      try {
        if (mode === 'floor') {
          amount = mine.requiredNow
          await expect(charge(f, Math.round((amount - 0.01) * 100) / 100)).rejects.toMatchObject({ statusCode: 422 })
          await charge(f, amount)
        } else if (mode === 'over') {
          amount = Math.round((mine.requiredNow + Math.round(rnd() * Math.min(landlordRequired + mine.prepaidApplied, 100) * 100) / 100) * 100) / 100
          if (shape.carried && second && amount > mine.requiredNow + 0.005) {
            // S622: above the floor with arrears open while the other space owes
            // rent — refused, nothing written. The floor itself is still taken.
            await expect(charge(f, amount)).rejects.toMatchObject({ statusCode: 422, message: expect.stringContaining('Bring your other rent current first') })
            amount = mine.requiredNow
          }
          await charge(f, amount)
        } else if (mode === 'counter') {
          amount = mine.outstanding
          const counter = () => chargeLeaseBalance({ tenantId: f.tenantId, leaseId: f.leaseId, amount: 0, chargeEverything: true,
            paymentMethodId: 'pm_test', paymentMethodType: 'ach', source: 'portal' })
          if (second && amount > mine.requiredNow + 0.005) {
            // S622: the counter takes the arrears too, and arrears wait while the
            // other space owes rent — refused, nothing written. The floor is taken.
            await expect(counter()).rejects.toMatchObject({ statusCode: 422, message: expect.stringContaining('Bring your other rent current first') })
            mode = 'floor'
            amount = mine.requiredNow
            if (amount >= 0.01) await charge(f, amount); else await autopayCharge(f)
          } else {
            const r = await counter()
            if (amount < 0.01 && r.status !== 'settled_by_credit') problems.push(`counter at $0 status ${r.status}`)
          }
        } else {
          amount = mine.requiredNow
          const r = await autopayCharge(f)
          if (amount < 0.01 && r.status !== 'settled_by_credit') problems.push(`autopay at $0 status ${r.status}`)
        }
      } catch (e: any) {
        failures.push(`iter ${iter} ${mode} threw ${e.message} ${JSON.stringify(shape)} net=${JSON.stringify(mine)}`)
        continue
      }
      ran++
      const a = await sums()
      const n = (k: string) => Number(a[k])
      const rem = (await db.query<{ amount: string; applied: string; unapplied: string }>(
        `SELECT amount::text, applied_amount::text AS applied, unapplied_amount::text AS unapplied FROM tenant_remittances
          WHERE tenant_id = $1 AND stripe_payment_intent_id IS NOT NULL AND stripe_payment_intent_id NOT LIKE 'pi_held_%'`, [f.tenantId])).rows
      const cash = rem.reduce((x, r) => x + Number(r.amount), 0)
      const applied = rem.reduce((x, r) => x + Number(r.applied), 0)
      // The portal's figure is what was taken.
      if (Math.abs(cash - amount) > 0.005) problems.push(`cash ${cash} vs portal ${amount}`)
      if (amount < 0.01 && (stripeConnect.createRentPlatformCharge as any).mock.calls.length) problems.push('Stripe called at $0')
      // Every dollar once: nothing created or lost; each settled dollar is a credit drawn; each dollar in flight is the payment's.
      if (Math.abs(n('total') - Number(before.total)) > 0.005) problems.push(`total ${a.total} vs ${before.total}`)
      if (Math.abs(n('settled') - (n('prepaid_used') + n('credit_used'))) > 0.005) problems.push(`settled ${a.settled} vs credit drawn ${n('prepaid_used') + n('credit_used')}`)
      if (Math.abs(n('flight') - applied) > 0.005) problems.push(`flight ${a.flight} vs applied ${applied}`)
      // What settles is what was netted.
      if (mode !== 'over' && Math.abs(n('prepaid_used') - mine.prepaidApplied) > 0.005) problems.push(`prepaid used ${a.prepaid_used} vs ${mine.prepaidApplied}`)
      if (mode === 'over' && n('prepaid_used') > mine.prepaidApplied + 0.005) problems.push(`prepaid used ${a.prepaid_used} over ${mine.prepaidApplied}`)
      if (mode !== 'over' && n('credit_used') < (mode === 'counter' ? mine.creditApplied : landlordRequired) - 0.005) problems.push(`credit used ${a.credit_used} under netted`)
      if (n(mode === 'counter' ? 'open_all' : 'open_required') > 0.005) problems.push(`still open ${mode === 'counter' ? a.open_all : a.open_required}`)
      const after = (await leaseGroupsNet(f)).get(f.leaseId)
      if (after && (after.requiredNow > 0.005 || (mode === 'counter' && after.outstanding > 0.005))) problems.push(`portal after ${JSON.stringify(after)}`)
      // Paying above the floor frees general credit for the other lease; at the
      // floor, the counter or autopay its figure must not move (each lease nets
      // only the share the portal gives it).
      if (second && mode !== 'over' && Math.abs(((await leaseGroupsNet(f)).get(second.leaseId)?.outstanding ?? 0) - otherBefore!) > 0.005) problems.push('the other lease’s figure moved')
      if (n('trade_touched') > 0.005) problems.push('work-trade line touched')
      if (n('neighbor_settled') > 0.005) problems.push('neighbor’s utility settled by credit')
      if (n('home_by_prepaid') > 0.005) problems.push('home payment paid from paid-ahead')
      if (a.alerts !== '0') problems.push(`alerts ${a.alerts}`)
      if (problems.length) failures.push(`iter ${iter} ${mode}: ${problems.join('; ')} ${JSON.stringify(shape)} net=${JSON.stringify(mine)}`)
    }
    expect(failures).toEqual([])
    expect(ran).toBeGreaterThan(70)
    // Every way in was exercised, including credits covering everything.
    for (const m of ['floor', 'over', 'counter', 'autopay']) expect(modes[m] ?? 0).toBeGreaterThan(5)
  }, 240_000)
})
