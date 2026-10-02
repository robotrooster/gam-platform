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

/**
 * S654: a credit is GAM's to release only when GAM holds the money. The default
 * here is what the S609 directive describes — the tenant paid ahead through
 * Stripe (a bank remittance) and the money sits on GAM's balance. `check`
 * seeds the other case: the landlord deposited a check and typed the credit in.
 */
async function bankPrepaid(f: Fixture, amount: number, how: 'ach' | 'check' | 'none' = 'ach') {
  let remittanceId: string | null = null
  if (how !== 'none') {
    const r = await db.query<{ id: string }>(
      `INSERT INTO tenant_remittances
         (tenant_id, landlord_id, amount, applied_amount, unapplied_amount, status, payment_method,
          stripe_payment_intent_id, processing_fee_amount)
       VALUES ($1,$2,$3,$3,0,'settled',$4,$5,0) RETURNING id`,
      [f.tenantId, f.landlordId, amount.toFixed(2), how, how === 'ach' ? `pi_test_${Math.random().toString(36).slice(2)}` : null])
    remittanceId = r.rows[0].id
  }
  await db.query(
    `INSERT INTO lease_prepaid_credits (lease_id, tenant_id, amount_original, amount_remaining, source_remittance_id)
     VALUES ($1,$2,$3,$3,$4)`,
    [f.leaseId, f.tenantId, amount.toFixed(2), remittanceId])
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

  // S637 (Nic, DIRECTIVE): "we don't do partial payments." This used to assert
  // the SPLIT — $400 of prepaid carved a $1,000 month into a $400 settled slice
  // and a $600 pending remainder, and the landlord was paid the slice.
  //
  // A month is now covered WHOLE or left alone, and $400 that cannot clear a
  // $1,000 month stays banked as the tenant's money. Nothing is lost: the pay
  // path nets prepaid off what the tenant is asked for (services/rentCharge.ts),
  // so they are billed $600 and the $400 is spent settling the rest in the same
  // transaction. The landlord is paid when the month is actually covered, not
  // for a fraction of it.
  it('S637: a month the prepaid cannot cover in full is left whole, and stays banked', async () => {
    await bankPrepaid(f, 400)
    const { invoiceId, paymentId } = await makeInvoiceWithRent(f, 1000)
    const r = await release(f, invoiceId)

    // Nothing consumed, nothing settled, nothing split.
    expect(r.consumed).toBeCloseTo(0, 2)
    const charge = await db.query<{ amount: string; status: string }>(
      `SELECT amount::text, status FROM payments WHERE id = $1`, [paymentId])
    expect(Number(charge.rows[0].amount)).toBeCloseTo(1000, 2)
    expect(charge.rows[0].status).toBe('pending')

    const remainder = await db.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM payments WHERE lease_id = $1 AND is_remainder = TRUE`,
      [f.leaseId])
    expect(Number(remainder.rows[0].n)).toBe(0)

    // Still the tenant's money, still held, and the landlord has earned nothing
    // from a month nobody has paid for.
    const left = await db.query<{ remaining: string }>(
      `SELECT SUM(amount_remaining)::text AS remaining FROM lease_prepaid_credits WHERE lease_id = $1`,
      [f.leaseId])
    expect(Number(left.rows[0].remaining)).toBeCloseTo(400, 2)
    expect(await ownerShare(paymentId)).toBeCloseTo(0, 2)
  })

  // S654 (Nic): "Glenda Greek and Todd Niemeyer also paid by check… Mark
  // Rensberger… he's not paid with card ever. Why is that saying that that's
  // going to be dispersed to our account? That's a huge problem."
  it('a check the landlord already deposited settles the month but releases nothing', async () => {
    await bankPrepaid(f, 1000, 'check')
    const { invoiceId, paymentId } = await makeInvoiceWithRent(f, 1000)
    const r = await release(f, invoiceId)
    expect(r.consumed).toBe(1000)
    expect(r.rowsCovered).toBe(1)
    expect(r.releasedToLandlord).toBe(0)
    const { rows: [p] } = await db.query<any>(
      `SELECT status, platform_held, notes FROM payments WHERE id=$1`, [paymentId])
    expect(p.status).toBe('settled')
    expect(p.platform_held).toBe(false)          // the landlord has the money already
    expect(p.notes).toMatch(/collected by the landlord/)
    expect(await ownerShare(paymentId)).toBeNull() // nothing for Tuesday's batch
  })

  it('a credit the landlord typed in with no payment behind it releases nothing either', async () => {
    await bankPrepaid(f, 1000, 'none')
    const { invoiceId, paymentId } = await makeInvoiceWithRent(f, 1000)
    const r = await release(f, invoiceId)
    expect(r.rowsCovered).toBe(1)
    expect(r.releasedToLandlord).toBe(0)
    expect(await ownerShare(paymentId)).toBeNull()
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

// ── S654: paid-ahead pays only what the release can hand the landlord ────────
// A home payment is settled through the home-sale path, not this one — paid
// from GAM-held money here, the landlord was never paid it. A work-trade line
// is paid in hours. A neighbor's utility on a shared bill is not this lease's.
describe('S654 the release passes over rows it cannot pay out', () => {
  let f: Fixture
  beforeAll(async () => {
    await db.query(
      `INSERT INTO platform_processing_rates
         (payment_method, customer_facing_flat, customer_facing_percent,
          stripe_cost_flat, stripe_cost_percent)
       SELECT 'ach', 6, 0, 0, 0.5
        WHERE NOT EXISTS (SELECT 1 FROM platform_processing_rates WHERE payment_method = 'ach')`)
  })
  beforeEach(async () => { await cleanupAllSchema(); f = await fixture() })

  async function line(invoiceId: string, type: string, amount: number, extra: { lease?: string | null; landlord?: string; trade?: boolean } = {}) {
    const r = await db.query<{ id: string }>(
      `INSERT INTO payments (invoice_id, unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description, work_trade_suspended_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'pending', CURRENT_DATE, $8, $9) RETURNING id`,
      [invoiceId, f.unitId, extra.lease === undefined ? f.leaseId : extra.lease, f.tenantId, extra.landlord ?? f.landlordId,
       type, amount.toFixed(2), type === 'home_payment' ? 'HOMEPMT' : 'UTILITY', extra.trade ? new Date() : null])
    return r.rows[0].id
  }

  it('a home payment, a work-trade line and a neighbor’s utility stay open; the rent is paid', async () => {
    await bankPrepaid(f, 2000)
    const { invoiceId, paymentId } = await makeInvoiceWithRent(f, 1000)
    const nb = await (async () => { const c = await db.connect(); try { return await seedLandlord(c) } finally { c.release() } })()
    const home = await line(invoiceId, 'home_payment', 200)
    const trade = await line(invoiceId, 'utility', 8, { trade: true })
    const neighbor = await line(invoiceId, 'utility', 5, { lease: null, landlord: nb.landlordId })

    const r = await release(f, invoiceId)
    expect(r.consumed).toBeCloseTo(1000, 2)
    expect(await ownerShare(paymentId)).toBeCloseTo(1000, 2)
    const { rows } = await db.query(`SELECT id, status FROM payments WHERE id = ANY($1)`, [[home, trade, neighbor]])
    expect(rows.every((x: any) => x.status === 'pending')).toBe(true)
  })

  it('held to named rows, it settles only those', async () => {
    await bankPrepaid(f, 2000)
    const { invoiceId, paymentId } = await makeInvoiceWithRent(f, 1000)
    const water = await line(invoiceId, 'utility', 50)
    const client = await db.connect()
    try {
      await client.query('BEGIN')
      const r = await consumePrepaidCreditForInvoice(client, { leaseId: f.leaseId, invoiceId, rowIds: [water] })
      await client.query('COMMIT')
      expect(r.consumed).toBeCloseTo(50, 2)
    } catch (e) { await client.query('ROLLBACK'); throw e } finally { client.release() }
    const { rows } = await db.query(`SELECT id, status FROM payments WHERE id = ANY($1) ORDER BY amount`, [[water, paymentId]])
    expect(rows.map((x: any) => x.status)).toEqual(['settled', 'pending'])
  })
})
