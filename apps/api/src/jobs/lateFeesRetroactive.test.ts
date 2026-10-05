/**
 * S577 — retroactive late-fee BILLING (engine end-to-end).
 * Seeds a lease whose accrual counts back to the due date, runs the real
 * late-fee engine, and asserts the generated late_fee rows.
 *
 * Setup: rent due 10 days ago, 3-day grace, $5/day accrual, no initial fee.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { db } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedLease, seedTenant, seedLeaseTenant } from '../test/dbHelpers'

// A bill the credit pays gets its receipt after the commit (S655).
const sendPaymentReceipt = vi.hoisted(() => vi.fn(async (_o: any) => 'msg_test'))
vi.mock('../services/paymentReceipt', async (orig) => ({
  ...(await orig<typeof import('../services/paymentReceipt')>()),
  sendPaymentReceipt,
}))

import { generateLateFeesForTimezone } from '../jobs/lateFees'
import { createPaidAhead } from '../services/creditUse'
import { lockHousehold } from '../services/moneyPredicates'

const TZ = 'America/Phoenix'

beforeEach(async () => { await cleanupAllSchema(); sendPaymentReceipt.mockClear() })

async function seedRetroLease(accrualFrom: string, opts: { grace: number; accrual: number; initial: number; daysOverdue: number; rent?: number; withTenant?: boolean }) {
  const rent = opts.rent ?? 1000
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const ll = await seedLandlord(c)
    const propertyId = await seedProperty(c, { landlordId: ll.landlordId, ownerUserId: ll.userId, managedByUserId: ll.userId })
    await c.query(`UPDATE properties SET timezone=$2, late_fee_enabled=TRUE WHERE id=$1`, [propertyId, TZ])
    const unitId = await seedUnit(c, { propertyId, landlordId: ll.landlordId })
    const leaseId = await seedLease(c, { unitId, landlordId: ll.landlordId, rentAmount: rent })
    // S655: a household, so the whole-bill credit rule has someone to look at.
    const tenantId = opts.withTenant ? await seedTenant(c) : null
    if (tenantId) await seedLeaseTenant(c, { leaseId, tenantId, role: 'primary' })
    await c.query(
      `UPDATE leases SET late_fee_enabled=TRUE, late_fee_grace_days=$2,
         late_fee_initial_amount=$3, late_fee_initial_type='flat',
         late_fee_accrual_amount=$4, late_fee_accrual_type='flat', late_fee_accrual_period='daily',
         late_fee_accrual_from=$5 WHERE id=$1`,
      [leaseId, opts.grace, opts.initial, opts.accrual, accrualFrom])
    const inv = await c.query<{ id: string }>(
      `INSERT INTO invoices (landlord_id, tenant_id, lease_id, unit_id, invoice_number, due_date, subtotal_rent, total_amount, status)
       VALUES ($1,$8,$2,$3,$4, (NOW() AT TIME ZONE $5)::date - $6::int, $7, $7, 'pending') RETURNING id`,
      [ll.landlordId, leaseId, unitId, `INV-${Math.random().toString(36).slice(2, 8)}`, TZ, opts.daysOverdue, rent, tenantId])
    const pay = await c.query<{ id: string }>(
      `INSERT INTO payments (landlord_id, tenant_id, unit_id, lease_id, type, amount, status, entry_description, due_date, invoice_id)
       VALUES ($1,$8,$2,$3,'rent',$4,'pending','RENT',(NOW() AT TIME ZONE $5)::date - $6::int, $7) RETURNING id`,
      [ll.landlordId, unitId, leaseId, rent, TZ, opts.daysOverdue, inv.rows[0].id, tenantId])
    await c.query('COMMIT')
    return { invoiceId: inv.rows[0].id, rentId: pay.rows[0].id, leaseId, tenantId, landlordId: ll.landlordId }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

async function lateFeeRows(invoiceId: string) {
  const r = await db.query<{ amount: string; entry_description: string }>(
    `SELECT amount::text AS amount, entry_description FROM payments WHERE invoice_id=$1 AND type='late_fee' ORDER BY due_date`, [invoiceId])
  return r.rows
}

describe('retroactive late-fee billing', () => {
  it('due_date_inclusive: $5/day back to the due date, no initial fee', async () => {
    // due 10 days ago, inclusive → ticks due..today = 11 days × $5 = $55
    const { invoiceId } = await seedRetroLease('due_date_inclusive', { grace: 3, accrual: 5, initial: 0, daysOverdue: 10 })
    await generateLateFeesForTimezone(TZ)
    const rows = await lateFeeRows(invoiceId)
    const total = rows.reduce((s, r) => s + Number(r.amount), 0)
    expect(total).toBe(55)
    expect(rows).toHaveLength(11)
  })

  it('due_date (exclusive): counts the day AFTER the due date', async () => {
    // due 10 days ago, exclusive → ticks due+1..today = 10 days × $5 = $50
    const { invoiceId } = await seedRetroLease('due_date', { grace: 3, accrual: 5, initial: 0, daysOverdue: 10 })
    await generateLateFeesForTimezone(TZ)
    const total = (await lateFeeRows(invoiceId)).reduce((s, r) => s + Number(r.amount), 0)
    expect(total).toBe(50)
  })

  it('grace_end: unchanged legacy behavior (initial fee + accrual after grace)', async () => {
    // grace 3, due 10 days ago → initial $25 at day+3, then $5/day for days 4..10 (7 ticks)
    const { invoiceId } = await seedRetroLease('grace_end', { grace: 3, accrual: 5, initial: 25, daysOverdue: 10 })
    await generateLateFeesForTimezone(TZ)
    const rows = await lateFeeRows(invoiceId)
    const total = rows.reduce((s, r) => s + Number(r.amount), 0)
    // initial $25 + 7 daily ticks (day+4 .. today) × $5 = $25 + $35 = $60
    expect(total).toBe(60)
  })
})

// S607 (Nic): "if a landlord gives credit for an accidental late fee or part of
// a late fee, and there's still a balance outstanding, that is outside of the
// accrual where that late fee is not gonna keep adding more late fees."
//
// Already true by construction — the fee basis is the invoice's RENT rows only
// (jobs/lateFees.ts sums `type='rent'`), so nothing else on the invoice can
// inflate it. This holds that in place: a future change that based the fee on
// the whole outstanding balance would compound fees on fees, and would break
// here rather than on somebody's bill.
describe('S607: late fees never compound on late fees', () => {
  it('an unpaid late fee does not raise the next late fee', async () => {
    const { invoiceId } = await seedRetroLease('grace_end',
      { grace: 2, accrual: 5, initial: 20, daysOverdue: 6, rent: 1000 })

    await generateLateFeesForTimezone(TZ)
    const first = (await lateFeeRows(invoiceId)).reduce((s, r) => s + Number(r.amount), 0)
    expect(first).toBeGreaterThan(0)

    // Those late fees are now sitting unpaid on the invoice. Re-running must not
    // treat them as part of the amount being penalized.
    await generateLateFeesForTimezone(TZ)
    const second = (await lateFeeRows(invoiceId)).reduce((s, r) => s + Number(r.amount), 0)

    // Only the flat per-period accrual may have moved; the BASIS is unchanged.
    const basis = (await db.query<{ t: string }>(
      `SELECT COALESCE(SUM(amount),0)::text AS t FROM payments
        WHERE invoice_id = $1 AND type = 'rent'`, [invoiceId])).rows[0].t
    expect(Number(basis)).toBeCloseTo(1000, 2)
    expect(second).toBeCloseTo(first, 2)   // same day, no new ticks
  })
})

// ── S655 (Nic, 10/2): SAVED CREDIT IS NOT A PAYMENT ─────────────────────────
//
//   "Saved credit doesn't stop a late fee unless it covers the whole bill."
//
// The late-fee job runs the whole-bill rule right before each fee, under the
// household lock, and reads the bill again before raising anything.
describe('S655: late fees and account credit', () => {
  const paidAhead = async (f: { leaseId: string; tenantId: string | null }, amount: number) => {
    const c = await db.connect()
    try {
      await c.query('BEGIN')
      const id = await createPaidAhead(c, { leaseId: f.leaseId, tenantId: f.tenantId!, amount, fundedBy: 'landlord', receivedAt: '2026-01-15T12:00:00Z' })
      await c.query('COMMIT')
      return id
    } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
  }
  const left = async (creditId: string) =>
    Number((await db.query<{ r: string }>(`SELECT amount_remaining::text AS r FROM lease_prepaid_credits WHERE id = $1`, [creditId])).rows[0].r)
  const statusOf = async (id: string) => (await db.query<{ status: string }>(`SELECT status FROM payments WHERE id = $1`, [id])).rows[0].status

  it('saved credit smaller than the bill does not stop a late fee', async () => {
    const f = await seedRetroLease('grace_end', { grace: 3, accrual: 5, initial: 25, daysOverdue: 10, withTenant: true })
    const credit = await paidAhead(f, 10)
    await generateLateFeesForTimezone(TZ)
    const fees = await lateFeeRows(f.invoiceId)
    expect(fees.reduce((s, r) => s + Number(r.amount), 0)).toBe(60)
    // The $10 is still there for the tenant to use or save; nothing was spent.
    expect(await left(credit)).toBe(10)
    expect(await statusOf(f.rentId)).toBe('pending')
    expect(sendPaymentReceipt).not.toHaveBeenCalled()
  })

  it('a credit covering the whole bill is applied before the fee', async () => {
    const f = await seedRetroLease('grace_end', { grace: 3, accrual: 5, initial: 25, daysOverdue: 10, withTenant: true })
    const credit = await paidAhead(f, 1000)
    await generateLateFeesForTimezone(TZ)
    expect(await lateFeeRows(f.invoiceId)).toEqual([])
    expect(await statusOf(f.rentId)).toBe('settled')
    expect(await left(credit)).toBe(0)
    const uses = await db.query<{ source: string; status: string }>(
      `SELECT source, status FROM credit_uses WHERE payment_id = $1`, [f.rentId])
    expect(uses.rows).toEqual([{ source: 'whole_bill', status: 'applied' }])
    // The tenant is told their bill was paid with their account credit.
    expect(sendPaymentReceipt).toHaveBeenCalledTimes(1)
    expect(sendPaymentReceipt.mock.calls[0][0]).toMatchObject({ paymentIds: [f.rentId], method: 'your account credit' })
  })

  it('an invoice written without a tenant is checked against the lease resident\'s credit before the fee', async () => {
    const f = await seedRetroLease('grace_end', { grace: 3, accrual: 5, initial: 25, daysOverdue: 10, withTenant: true })
    await db.query(`UPDATE invoices SET tenant_id = NULL WHERE id = $1`, [f.invoiceId])
    const credit = await paidAhead(f, 1000)
    await generateLateFeesForTimezone(TZ)
    expect(await lateFeeRows(f.invoiceId)).toEqual([])
    expect(await statusOf(f.rentId)).toBe('settled')
    expect(await left(credit)).toBe(0)
  })

  it('a bill paid while the job waited on the household gets no fee (it reads the bill again under the lock)', async () => {
    const f = await seedRetroLease('grace_end', { grace: 3, accrual: 5, initial: 25, daysOverdue: 10, withTenant: true })
    const holder = await db.connect()
    try {
      await holder.query('BEGIN')
      await lockHousehold(holder, f.tenantId!, f.landlordId)
      // The desk records the rent inside its own transaction...
      await holder.query(`UPDATE payments SET status = 'settled', settled_at = now(), manual_method = 'cash' WHERE id = $1`, [f.rentId])
      // ...while the late-fee job, which already picked the invoice, waits.
      const run = generateLateFeesForTimezone(TZ)
      let waiting = false
      for (let i = 0; i < 100 && !waiting; i++) {
        const w = await db.query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted
            AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`)
        waiting = Number(w.rows[0].n) > 0
        if (!waiting) await new Promise(r => setTimeout(r, 50))
      }
      expect(waiting).toBe(true)
      await holder.query('COMMIT')
      const r = await run
      expect(r.invoicesScanned).toBe(1)
      expect(r.errors).toEqual([])
    } finally { holder.release() }
    expect(await lateFeeRows(f.invoiceId)).toEqual([])
  })
})
