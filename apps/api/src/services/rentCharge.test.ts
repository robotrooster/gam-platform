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
