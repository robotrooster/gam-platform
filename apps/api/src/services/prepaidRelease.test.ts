/**
 * S609 — prepaid credit must reach the landlord as each month comes due.
 *
 * Nic: "If somebody prepays a full year ahead of time, that money sits on GAM's
 * books, and we disburse to the landlord each month as invoice comes due."
 *
 * The regression these lock down is the one that shipped silently in S537: the
 * tenant's bill was marked paid by their prepaid credit and NOTHING told the
 * payout side the landlord had earned anything, so the money stayed on GAM's
 * books forever. Nobody would have noticed — the tenant's balance was right and
 * the landlord had no line to miss.
 */

import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { db } from '../db'
import { consumePrepaidCreditForInvoice } from './prepaidRelease'
import {
  cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedTenant,
  seedLease, seedLeaseTenant, seedAllocationRule,
} from '../test/dbHelpers'

interface Fixture {
  landlordId: string; userId: string; propertyId: string
  unitId: string; tenantId: string; leaseId: string
}

async function fixture(): Promise<Fixture> {
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    const ll = await seedLandlord(client)
    const propertyId = await seedProperty(client, {
      landlordId: ll.landlordId, ownerUserId: ll.userId, managedByUserId: ll.userId })
    // Owner is self-managing, tenant bears the ACH fee — the launch shape.
    await seedAllocationRule(client, { propertyId, achFeePayer: 'tenant', cardFeePayer: 'tenant' })
    const unitId = await seedUnit(client, { propertyId, landlordId: ll.landlordId, withLateFeeDecision: true })
    const tenantId = await seedTenant(client)
    const leaseId = await seedLease(client, { unitId, landlordId: ll.landlordId, rentAmount: 1000 })
    await seedLeaseTenant(client, { leaseId, tenantId })
    await client.query('COMMIT')
    return { ...ll, propertyId, unitId, tenantId, leaseId }
  } catch (e) { await client.query('ROLLBACK'); throw e } finally { client.release() }
}

/** An invoice carrying one pending rent charge. */
async function makeInvoiceWithRent(f: Fixture, amount: number) {
  const inv = await db.query<{ id: string }>(
    `INSERT INTO invoices (lease_id, unit_id, tenant_id, landlord_id,
                           invoice_number, due_date, subtotal_rent, total_amount, status)
     VALUES ($1,$2,$3,$4, 'INV-' || substr(md5(random()::text), 1, 10),
             CURRENT_DATE, $5, $5, 'pending')
     RETURNING id`,
    [f.leaseId, f.unitId, f.tenantId, f.landlordId, amount.toFixed(2)])
  const pay = await db.query<{ id: string }>(
    `INSERT INTO payments (invoice_id, unit_id, lease_id, tenant_id, landlord_id,
                           type, amount, status, due_date, entry_description)
     VALUES ($1,$2,$3,$4,$5,'rent',$6,'pending', CURRENT_DATE, 'RENT')
     RETURNING id`,
    [inv.rows[0].id, f.unitId, f.leaseId, f.tenantId, f.landlordId, amount.toFixed(2)])
  return { invoiceId: inv.rows[0].id, paymentId: pay.rows[0].id }
}

async function bankPrepaid(f: Fixture, amount: number) {
  await db.query(
    `INSERT INTO lease_prepaid_credits (lease_id, tenant_id, amount_original, amount_remaining)
     VALUES ($1,$2,$3,$3)`,
    [f.leaseId, f.tenantId, amount.toFixed(2)])
}

async function release(f: Fixture, invoiceId: string) {
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    const r = await consumePrepaidCreditForInvoice(client, { leaseId: f.leaseId, invoiceId })
    await client.query('COMMIT')
    return r
  } catch (e) { await client.query('ROLLBACK'); throw e } finally { client.release() }
}

const ownerShare = async (paymentId: string): Promise<number | null> => {
  const r = await db.query<{ amount: string }>(
    `SELECT amount::text FROM user_balance_ledger
      WHERE reference_id = $1 AND reference_type = 'payment'
        AND type = 'allocation_owner_share'`, [paymentId])
  return r.rows[0] ? Number(r.rows[0].amount) : null
}

describe('S609 prepaid release', () => {
  let f: Fixture

  // platform_processing_rates is deliberately NOT wiped between tests, so seed
  // the ACH row once. Allocation reads it even on a release (the fee is then
  // suppressed), so it has to be present.
  beforeAll(async () => {
    await db.query(
      `INSERT INTO platform_processing_rates
         (payment_method, customer_facing_flat, customer_facing_percent,
          stripe_cost_flat, stripe_cost_percent)
       SELECT 'ach', 6, 0, 0, 0.5
        WHERE NOT EXISTS (SELECT 1 FROM platform_processing_rates WHERE payment_method = 'ach')`)
  })

  beforeEach(async () => { await cleanupAllSchema(); f = await fixture() })

  it('THE BUG: a prepaid-covered month books the landlord their share', async () => {
    await bankPrepaid(f, 1000)
    const { invoiceId, paymentId } = await makeInvoiceWithRent(f, 1000)

    const r = await release(f, invoiceId)
    expect(r.consumed).toBeCloseTo(1000, 2)
    expect(r.releasedToLandlord).toBeGreaterThan(0)

    // Before S609 both of these were absent and the money was stranded on
    // GAM's books with nothing pointing at the gap.
    expect(await ownerShare(paymentId)).toBeCloseTo(1000, 2)

    const row = await db.query<{ status: string; platform_held: boolean }>(
      `SELECT status, platform_held FROM payments WHERE id = $1`, [paymentId])
    expect(row.rows[0].status).toBe('settled')
    expect(row.rows[0].platform_held).toBe(true)
  })

  it('charges no second processing fee — it came out when the tenant paid ahead', async () => {
    await bankPrepaid(f, 1000)
    const { invoiceId, paymentId } = await makeInvoiceWithRent(f, 1000)
    await release(f, invoiceId)

    // The owner share is the WHOLE rent: nothing shaved off for a bank fee
    // already collected months ago on the original charge.
    expect(await ownerShare(paymentId)).toBeCloseTo(1000, 2)

    const spread = await db.query(
      `SELECT 1 FROM platform_revenue_ledger
        WHERE reference_id = $1 AND type = 'banking_spread'`, [paymentId])
    expect(spread.rowCount).toBe(0)
  })

  it('a year paid up front releases ONE month, not the year', async () => {
    await bankPrepaid(f, 12000)                     // twelve months at $1,000
    const { invoiceId, paymentId } = await makeInvoiceWithRent(f, 1000)

    const r = await release(f, invoiceId)
    expect(r.consumed).toBeCloseTo(1000, 2)
    expect(await ownerShare(paymentId)).toBeCloseTo(1000, 2)

    // The other eleven months stay GAM's to hold — still the tenant's money
    // until the month it belongs to arrives.
    const left = await db.query<{ remaining: string }>(
      `SELECT SUM(amount_remaining)::text AS remaining FROM lease_prepaid_credits WHERE lease_id = $1`,
      [f.leaseId])
    expect(Number(left.rows[0].remaining)).toBeCloseTo(11000, 2)
  })

  it('a partly covered month settles the covered slice and leaves the rest owed', async () => {
    await bankPrepaid(f, 400)
    const { invoiceId, paymentId } = await makeInvoiceWithRent(f, 1000)
    await release(f, invoiceId)

    const covered = await db.query<{ amount: string; status: string }>(
      `SELECT amount::text, status FROM payments WHERE id = $1`, [paymentId])
    expect(Number(covered.rows[0].amount)).toBeCloseTo(400, 2)
    expect(covered.rows[0].status).toBe('settled')

    const remainder = await db.query<{ amount: string; status: string }>(
      `SELECT amount::text, status FROM payments WHERE lease_id = $1 AND is_remainder = TRUE`,
      [f.leaseId])
    expect(Number(remainder.rows[0].amount)).toBeCloseTo(600, 2)
    expect(remainder.rows[0].status).toBe('pending')

    // The landlord earned only the covered slice.
    expect(await ownerShare(paymentId)).toBeCloseTo(400, 2)
  })

  it('no prepaid credit is a clean no-op', async () => {
    const { invoiceId, paymentId } = await makeInvoiceWithRent(f, 1000)
    const r = await release(f, invoiceId)
    expect(r).toEqual({ consumed: 0, rowsCovered: 0, releasedToLandlord: 0 })

    const row = await db.query<{ status: string }>(`SELECT status FROM payments WHERE id = $1`, [paymentId])
    expect(row.rows[0].status).toBe('pending')
  })
})

/**
 * S609 (Nic, DIRECTIVE): "Late fees that come from the lease and are on the
 * invoice need to go to the landlord according to the lease. If you're talking
 * about late fees that would be in the one-off charges, those also need to go to
 * the landlord. I don't know why that would go to GAM. The only fees we collect
 * are retries on ACH, pass-through on card processing, and the subscription for
 * various tenant opt-in products."
 *
 * These run through the prepaid-release path because it is the one place a
 * charge settles and allocates in a single call, which makes "did the landlord
 * get it?" directly observable.
 */
describe('S609 whose money a charge is', () => {
  let f: Fixture
  beforeEach(async () => { await cleanupAllSchema(); f = await fixture() })

  async function invoiceWithCharge(
    amount: number, type: string, desc: string, owner: 'landlord' | 'gam' = 'landlord',
  ) {
    const inv = await db.query<{ id: string }>(
      `INSERT INTO invoices (lease_id, unit_id, tenant_id, landlord_id,
                             invoice_number, due_date, subtotal_rent, total_amount, status)
       VALUES ($1,$2,$3,$4, 'INV-' || substr(md5(random()::text), 1, 10),
               CURRENT_DATE, $5, $5, 'pending')
       RETURNING id`,
      [f.leaseId, f.unitId, f.tenantId, f.landlordId, amount.toFixed(2)])
    const pay = await db.query<{ id: string }>(
      `INSERT INTO payments (invoice_id, unit_id, lease_id, tenant_id, landlord_id,
                             type, amount, status, due_date, entry_description, revenue_owner)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'pending', CURRENT_DATE, $8, $9)
       RETURNING id`,
      [inv.rows[0].id, f.unitId, f.leaseId, f.tenantId, f.landlordId,
       type, amount.toFixed(2), desc, owner])
    return { invoiceId: inv.rows[0].id, paymentId: pay.rows[0].id }
  }

  it('THE FIX: a late fee off the lease reaches the landlord', async () => {
    await bankPrepaid(f, 50)
    const { invoiceId, paymentId } = await invoiceWithCharge(50, 'late_fee', 'LATEFEE')
    const r = await release(f, invoiceId)

    expect(r.releasedToLandlord).toBeCloseTo(50, 2)
    expect(await ownerShare(paymentId)).toBeCloseTo(50, 2)

    const row = await db.query<{ platform_held: boolean }>(
      `SELECT platform_held FROM payments WHERE id = $1`, [paymentId])
    expect(row.rows[0].platform_held).toBe(true)
  })

  it('a one-off charge the landlord billed reaches the landlord', async () => {
    await bankPrepaid(f, 75)
    const { invoiceId, paymentId } = await invoiceWithCharge(75, 'fee', 'SUBSCRIP')
    await release(f, invoiceId)
    expect(await ownerShare(paymentId)).toBeCloseTo(75, 2)
  })

  it("GAM's own fee stays with GAM", async () => {
    // Byte-identical to the charge above apart from revenue_owner — which is
    // exactly why the column exists. A landlord's hand-billed fee and a GAM
    // subscription are both written as type 'fee', description 'SUBSCRIP'.
    await bankPrepaid(f, 10)
    const { invoiceId, paymentId } = await invoiceWithCharge(10, 'fee', 'SUBSCRIP', 'gam')
    const r = await release(f, invoiceId)

    // The tenant's charge is still settled by their credit — they paid it.
    const row = await db.query<{ status: string; platform_held: boolean }>(
      `SELECT status, platform_held FROM payments WHERE id = $1`, [paymentId])
    expect(row.rows[0].status).toBe('settled')
    // But no owner share, and it is not queued for the landlord's payout.
    expect(await ownerShare(paymentId)).toBeNull()
    expect(row.rows[0].platform_held).toBe(false)
    expect(r.releasedToLandlord).toBeCloseTo(0, 2)
  })

  it('an ACH return fee stays with GAM', async () => {
    await bankPrepaid(f, 4)
    const { invoiceId, paymentId } = await invoiceWithCharge(4, 'fee', 'RETURNFEE', 'gam')
    await release(f, invoiceId)
    expect(await ownerShare(paymentId)).toBeNull()
  })
})
