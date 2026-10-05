/**
 * S653 (Nic): "she prepays ahead of time with her tax return but she likes part
 * of the tax return to be credited on her bill each month so she still pays a
 * little bit out of pocket each month... use only a dedicated amount of the
 * credit each month, to where she would still get a partial bill each month."
 *
 * leases.prepaid_monthly_draw caps what one billing month may take from the
 * paid-ahead money. S655: every spend reads the cap from the credit ledger
 * (credit_uses, held + applied, by billing month), whoever spends it:
 *   - the bill run (whole bills only: Nic 10/2, credit applies by itself only
 *     when it covers the whole bill — a cap below the bill means the tenant
 *     chooses, and nothing settles by itself);
 *   - the tenant's Pay Now and the desk, which offer "credit available $X" from
 *     the household quote (creditUse.planCredit) and spend it when chosen.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { db } from '../db'
import { consumePrepaidCreditForInvoice, prepaidDrawAvailable } from './prepaidRelease'
import { householdQuote, planCredit, applyCredit } from './creditUse'
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

  // S655 (Nic 10/2): this used to settle the $60 water line by itself and leave
  // the $589 rent open — credit picking off part of a bill. Credit now applies
  // by itself only when it covers the WHOLE bill; a $200 cap cannot cover $649,
  // so nothing settles and the $200 is offered to the tenant when they pay.
  it('with a $200 cap, the invoice run leaves a $589 rent and a $60 water line both open — whole bills only', async () => {
    const f = await fixture(200)
    const inv = await invoiceFor(f, '2026-11-01', [
      { type: 'rent', amount: 589, entry: 'RENT' }, { type: 'utility', amount: 60, entry: 'UTILITY' }])
    const r = await release(f, inv.invoiceId)
    expect(r.consumed).toBe(0)
    expect(await status(inv.paymentIds[0])).toBe('pending')
    expect(await status(inv.paymentIds[1])).toBe('pending')
    expect(await prepaidDrawAvailable(db as any, f.leaseId, '2026-11-01'))
      .toMatchObject({ remaining: 2000, cap: 200, drawnThisMonth: 0, available: 200 })
  })

  it('a bill the month\'s draw does cover settles by itself and counts toward the month', async () => {
    const f = await fixture(200)
    const inv = await invoiceFor(f, '2026-11-01', [{ type: 'utility', amount: 60, entry: 'UTILITY' }])
    const r = await release(f, inv.invoiceId)
    expect(r.consumed).toBe(60)
    expect(await status(inv.paymentIds[0])).toBe('settled')
    expect(await prepaidDrawAvailable(db as any, f.leaseId, '2026-11-01'))
      .toMatchObject({ remaining: 1940, cap: 200, drawnThisMonth: 60, available: 140 })
    // December is a fresh month.
    expect((await prepaidDrawAvailable(db as any, f.leaseId, '2026-12-01')).available).toBe(200)
  })

  it('at the desk, a $200 cap offers $200 of credit on a $589 bill; using it leaves $389 to pay', async () => {
    const f = await fixture(200)
    const inv = await invoiceFor(f, '2026-11-01', [{ type: 'rent', amount: 589, entry: 'RENT' }])
    const c = await db.connect()
    try {
      await c.query('BEGIN')
      const q = await householdQuote(c, { tenantId: f.tenantId, landlordId: f.landlordId, lock: true })
      expect(q.leases[0].usableCredit).toBe(200)
      expect(q.leases[0].requiredTotal - q.leases[0].usableCredit).toBe(389)
      await applyCredit(c, planCredit(q, f.leaseId), { source: 'desk' })
      await c.query('COMMIT')
    } finally { c.release() }
    expect(await remaining(f.leaseId)).toBe(1800)
    const uses = (await db.query(`SELECT amount::float AS a, billing_month::text AS m, payment_id, source FROM credit_uses WHERE lease_id=$1`, [f.leaseId])).rows
    expect(uses).toEqual([{ a: 200, m: '2026-11-01', payment_id: inv.paymentIds[0], source: 'desk' }])
    expect((await prepaidDrawAvailable(db as any, f.leaseId, '2026-11-01')).available).toBe(0)
  })

  it('at the desk, a $100 cap offers only $100', async () => {
    const f = await fixture(100)
    await invoiceFor(f, '2026-11-01', [{ type: 'rent', amount: 589, entry: 'RENT' }])
    const c = await db.connect()
    try {
      const q = await householdQuote(c, { tenantId: f.tenantId, landlordId: f.landlordId })
      expect(q.leases[0].usableCredit).toBe(100)
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
        const q = await householdQuote(c, { tenantId: f.tenantId, landlordId: f.landlordId, lock: true })
        expect(planCredit(q, f.leaseId)).toMatchObject([{ paymentId: inv.paymentIds[0], amount: 200, billingMonth: due }])
        await applyCredit(c, planCredit(q, f.leaseId), { source: 'desk' })
        // The desk then records the $389 cash for the rest.
        await c.query(`UPDATE payments SET status='settled', settled_at=now(), manual_method='cash' WHERE id=$1`, [inv.paymentIds[0]])
        await c.query('COMMIT')
      } finally { c.release() }
      expect(await status(inv.paymentIds[0])).toBe('settled')
    }
    expect(await remaining(f.leaseId)).toBe(1600)
  })

  it('a withdrawn paid-ahead credit is out of the month\'s available money', async () => {
    const f = await fixture(null)
    await db.query(`UPDATE lease_prepaid_credits SET voided_at = now(), void_reason = 'bank deposit undone' WHERE lease_id = $1`, [f.leaseId])
    expect(await prepaidDrawAvailable(db as any, f.leaseId, '2026-11-01')).toMatchObject({ remaining: 0, available: 0 })
  })
})
