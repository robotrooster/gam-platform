/**
 * S653 (Nic): "she prepays ahead of time with her tax return but she likes part
 * of the tax return to be credited on her bill each month so she still pays a
 * little bit out of pocket each month... use only a dedicated amount of the
 * credit each month, to where she would still get a partial bill each month."
 *
 * leases.prepaid_monthly_draw caps what one billing month may take from the
 * paid-ahead money. Three places spend that money and all three read the cap:
 * the invoice run (whole bills only), the tenant's Pay Now (nets the capped
 * amount, then spends it), and the desk (cash + capped credit settle one bill).
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { db } from '../db'
import { consumePrepaidCreditForInvoice, prepaidDrawAvailable } from './prepaidRelease'
import { postTenantPayment } from './postPayment'
import {
  cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedTenant,
  seedLease, seedLeaseTenant, seedAllocationRule,
} from '../test/dbHelpers'

async function fixture(monthlyDraw: number | null) {
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    const ll = await seedLandlord(client)
    const propertyId = await seedProperty(client, { landlordId: ll.landlordId, ownerUserId: ll.userId, managedByUserId: ll.userId })
    await seedAllocationRule(client, { propertyId, achFeePayer: 'tenant', cardFeePayer: 'tenant' })
    const unitId = await seedUnit(client, { propertyId, landlordId: ll.landlordId, withLateFeeDecision: true })
    const tenantId = await seedTenant(client)
    const leaseId = await seedLease(client, { unitId, landlordId: ll.landlordId, rentAmount: 589, status: 'active' })
    await seedLeaseTenant(client, { leaseId, tenantId, role: 'primary' })
    await client.query(`UPDATE leases SET prepaid_monthly_draw = $2 WHERE id = $1`, [leaseId, monthlyDraw])
    // The tax return: $2,000 paid ahead.
    await client.query(`INSERT INTO lease_prepaid_credits (lease_id, tenant_id, amount_original, amount_remaining) VALUES ($1,$2,2000,2000)`, [leaseId, tenantId])
    await client.query('COMMIT')
    return { ...ll, propertyId, unitId, tenantId, leaseId }
  } catch (e) { await client.query('ROLLBACK'); throw e } finally { client.release() }
}

async function invoiceFor(f: any, dueDate: string, lines: Array<{ type: string; amount: number; entry: string }>) {
  const inv = await db.query<{ id: string }>(
    `INSERT INTO invoices (lease_id, unit_id, tenant_id, landlord_id, invoice_number, due_date, subtotal_rent, total_amount, status)
     VALUES ($1,$2,$3,$4, 'INV-' || substr(md5(random()::text), 1, 10), $5, $6, $6, 'pending') RETURNING id`,
    [f.leaseId, f.unitId, f.tenantId, f.landlordId, dueDate, lines.reduce((s, l) => s + l.amount, 0).toFixed(2)])
  const ids: string[] = []
  for (const l of lines) {
    const p = await db.query<{ id: string }>(
      `INSERT INTO payments (invoice_id, unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'pending',$8,$9) RETURNING id`,
      [inv.rows[0].id, f.unitId, f.leaseId, f.tenantId, f.landlordId, l.type, l.amount.toFixed(2), dueDate, l.entry])
    ids.push(p.rows[0].id)
  }
  return { invoiceId: inv.rows[0].id, paymentIds: ids }
}

async function release(f: any, invoiceId: string) {
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    const r = await consumePrepaidCreditForInvoice(client, { leaseId: f.leaseId, invoiceId })
    await client.query('COMMIT')
    return r
  } catch (e) { await client.query('ROLLBACK'); throw e } finally { client.release() }
}

const remaining = async (leaseId: string) => Number((await db.query(
  `SELECT COALESCE(SUM(amount_remaining),0)::float AS a FROM lease_prepaid_credits WHERE lease_id=$1`, [leaseId])).rows[0].a)
const status = async (id: string) => (await db.query(`SELECT status FROM payments WHERE id=$1`, [id])).rows[0].status

beforeAll(async () => {
  await db.query(
    `INSERT INTO platform_processing_rates (payment_method, customer_facing_flat, customer_facing_percent, stripe_cost_flat, stripe_cost_percent)
     SELECT 'ach', 6, 0, 0, 0.5 WHERE NOT EXISTS (SELECT 1 FROM platform_processing_rates WHERE payment_method = 'ach')`)
})
beforeEach(async () => { await cleanupAllSchema() })

describe('a monthly draw on paid-ahead credit', () => {
  it('with no cap, the credit covers the whole bill — as it always has', async () => {
    const f = await fixture(null)
    const inv = await invoiceFor(f, '2026-11-01', [{ type: 'rent', amount: 589, entry: 'RENT' }])
    const r = await release(f, inv.invoiceId)
    expect(r.consumed).toBe(589)
    expect(await remaining(f.leaseId)).toBe(2000 - 589)
  })

  it('with a $200 cap, the invoice run leaves a $589 rent whole — but covers a $60 water line, which counts toward the month', async () => {
    const f = await fixture(200)
    const inv = await invoiceFor(f, '2026-11-01', [
      { type: 'rent', amount: 589, entry: 'RENT' }, { type: 'utility', amount: 60, entry: 'UTILITY' }])
    const r = await release(f, inv.invoiceId)
    expect(r.consumed).toBe(60)
    expect(await status(inv.paymentIds[0])).toBe('pending')
    expect(await status(inv.paymentIds[1])).toBe('settled')
    const avail = await prepaidDrawAvailable(db as any, f.leaseId, '2026-11-01')
    expect(avail).toMatchObject({ remaining: 1940, cap: 200, drawnThisMonth: 60, available: 140 })
    // December is a fresh month
    expect((await prepaidDrawAvailable(db as any, f.leaseId, '2026-12-01')).available).toBe(200)
  })

  it('at the desk, a $200 cap means she pays $389 on a $589 bill and the credit takes the rest', async () => {
    const f = await fixture(200)
    const inv = await invoiceFor(f, '2026-11-01', [{ type: 'rent', amount: 589, entry: 'RENT' }])
    const c = await db.connect()
    try {
      await c.query('BEGIN')
      const r = await postTenantPayment(c, { tenantId: f.tenantId, landlordIds: [f.landlordId], method: 'cash', amount: 389, postedBy: f.userId })
      await c.query('COMMIT')
      expect(r.applied).toBe(389)
      expect(r.paidAhead).toBe(0)
    } finally { c.release() }
    expect(await status(inv.paymentIds[0])).toBe('settled')
    expect(await remaining(f.leaseId)).toBe(1800)
    const draws = (await db.query(`SELECT amount::float AS a, billing_month::text AS m, payment_id FROM lease_prepaid_credit_draws WHERE lease_id=$1`, [f.leaseId])).rows
    expect(draws).toHaveLength(1)
    expect(draws[0]).toMatchObject({ a: 200, m: '2026-11-01', payment_id: inv.paymentIds[0] })
    // the landlord's $200 is GAM-held money — it rides the payout as a held item
    const held = (await db.query(`SELECT amount::float AS a, source_type FROM held_payout_items WHERE source_id=$1`, [inv.paymentIds[0]])).rows
    expect(held).toEqual([{ a: 200, source_type: 'prepaid_draw' }])
  })

  it('at the desk, $389 is short when the cap is only $100', async () => {
    const f = await fixture(100)
    await invoiceFor(f, '2026-11-01', [{ type: 'rent', amount: 589, entry: 'RENT' }])
    const c = await db.connect()
    try {
      await c.query('BEGIN')
      await expect(postTenantPayment(c, { tenantId: f.tenantId, landlordIds: [f.landlordId], method: 'cash', amount: 389, postedBy: f.userId }))
        .rejects.toThrow()
      await c.query('ROLLBACK')
    } finally { c.release() }
  })

  it('the cap is per month: November used, December starts over', async () => {
    const f = await fixture(200)
    for (const due of ['2026-11-01', '2026-12-01']) {
      // each month's bill arrives after the last was paid, as in life
      const inv = await invoiceFor(f, due, [{ type: 'rent', amount: 589, entry: 'RENT' }])
      const c = await db.connect()
      try {
        await c.query('BEGIN')
        await postTenantPayment(c, { tenantId: f.tenantId, landlordIds: [f.landlordId], method: 'cash', amount: 389, postedBy: f.userId })
        await c.query('COMMIT')
      } finally { c.release() }
      expect(await status(inv.paymentIds[0])).toBe('settled')
    }
    expect(await remaining(f.leaseId)).toBe(1600)
  })
})
