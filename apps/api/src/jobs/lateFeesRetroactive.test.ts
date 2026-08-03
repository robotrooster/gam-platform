/**
 * S577 — retroactive late-fee BILLING (engine end-to-end).
 * Seeds a lease whose accrual counts back to the due date, runs the real
 * late-fee engine, and asserts the generated late_fee rows.
 *
 * Setup: rent due 10 days ago, 3-day grace, $5/day accrual, no initial fee.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { db } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedLease } from '../test/dbHelpers'
import { generateLateFeesForTimezone } from '../jobs/lateFees'

const TZ = 'America/Phoenix'

beforeEach(async () => { await cleanupAllSchema() })

async function seedRetroLease(accrualFrom: string, opts: { grace: number; accrual: number; initial: number; daysOverdue: number; rent?: number }) {
  const rent = opts.rent ?? 1000
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const ll = await seedLandlord(c)
    const propertyId = await seedProperty(c, { landlordId: ll.landlordId, ownerUserId: ll.userId, managedByUserId: ll.userId })
    await c.query(`UPDATE properties SET timezone=$2, late_fee_enabled=TRUE WHERE id=$1`, [propertyId, TZ])
    const unitId = await seedUnit(c, { propertyId, landlordId: ll.landlordId })
    const leaseId = await seedLease(c, { unitId, landlordId: ll.landlordId, rentAmount: rent })
    await c.query(
      `UPDATE leases SET late_fee_enabled=TRUE, late_fee_grace_days=$2,
         late_fee_initial_amount=$3, late_fee_initial_type='flat',
         late_fee_accrual_amount=$4, late_fee_accrual_type='flat', late_fee_accrual_period='daily',
         late_fee_accrual_from=$5 WHERE id=$1`,
      [leaseId, opts.grace, opts.initial, opts.accrual, accrualFrom])
    const inv = await c.query<{ id: string }>(
      `INSERT INTO invoices (landlord_id, lease_id, unit_id, invoice_number, due_date, subtotal_rent, total_amount, status)
       VALUES ($1,$2,$3,$4, (NOW() AT TIME ZONE $5)::date - $6::int, $7, $7, 'pending') RETURNING id`,
      [ll.landlordId, leaseId, unitId, `INV-${Math.random().toString(36).slice(2, 8)}`, TZ, opts.daysOverdue, rent])
    await c.query(
      `INSERT INTO payments (landlord_id, unit_id, lease_id, type, amount, status, entry_description, due_date, invoice_id)
       VALUES ($1,$2,$3,'rent',$4,'pending','RENT',(NOW() AT TIME ZONE $5)::date - $6::int, $7)`,
      [ll.landlordId, unitId, leaseId, rent, TZ, opts.daysOverdue, inv.rows[0].id])
    await c.query('COMMIT')
    return { invoiceId: inv.rows[0].id }
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
