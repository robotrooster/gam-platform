/**
 * 10/12 (Nic) — a day a bill was fined is a day it was fined, whatever has
 * happened to the money since; and a monthly fee charges once a month.
 *
 *   1. A bounced pull. Autopay or "pay in full" pulls the rent and the late
 *      fees in one bank debit; when the bank refuses it, every line of that
 *      pull goes 'failed' (routes/webhooks failIntentRows) and is still owed —
 *      the retry (services/achRetry) or any other payment picks those same
 *      rows up again. The engine only counted a fee as charged while it was
 *      pending, processing or settled, so the night after a bounce it charged
 *      the first fee and every daily fee again on the same days, past the cap,
 *      and the retry of the whole pull — rent included — then ran into the
 *      one-fee-per-day index (ux_payments_late_fee_idempotent) and could never
 *      run. A fee paid from the deposit was the same: charged again.
 *   2. A monthly fee whose first charge landed on a short month's last day (a
 *      calendar on the 31st: June 30th) moved every later month onto the 30th
 *      and charged July and August twice.
 *   3. Nic, 10/12: a charge added to a bill after it went late "rides the
 *      original due date. landlord can issue credit against late fee if
 *      desired" — the bill's own late clock, as the engine has always done.
 *      Only a home payment added late keeps nothing late (e25afa8; pinned in
 *      lateFeeGraceAndUnpaidLines.test.ts).
 */
import { vi, describe, it, expect, beforeEach } from 'vitest'

// The retry cron confirms the pull with Stripe and may write the tenant; both
// are stubbed so the test exercises only GAM's own rows.
vi.mock('../lib/stripe', () => ({
  getStripe: () => ({
    paymentIntents: {
      retrieve: vi.fn(async (id: string) => ({
        id, status: 'requires_payment_method', payment_method: null, payment_method_types: ['us_bank_account'],
        last_payment_error: { code: 'insufficient_funds', payment_method: { id: 'pm_tenant_bank', type: 'us_bank_account' } },
      })),
      confirm: vi.fn(async (id: string) => ({ id })),
      cancel: vi.fn(async (id: string) => ({ id, status: 'canceled' })),
      update: vi.fn(async (id: string) => ({ id })),
    },
  }),
}))
vi.mock('../services/email', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, sendNotificationEmail: vi.fn(async () => 'msg_mock') }
})

import { db } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedLease, seedTenant } from '../test/dbHelpers'
import { addAccrualPeriods } from '@gam/shared'
import { generateLateFeesForTimezone } from './lateFees'
import { processAchRetries } from '../services/achRetry'

const TZ = 'America/Phoenix'
beforeEach(async () => { await cleanupAllSchema() })

/**
 * A bill with $800 of rent still owed and a $25 first fee, written three days
 * before it came due (on time). `due` is a date, or `daysAgo` days before the
 * park's today. `leaseGrace: null` = the property's grace.
 */
async function seedBill(o: {
  due?: string
  daysAgo?: number
  leaseGrace: number | null
  propertyGrace?: number
  initial?: number
  accrual?: number
  period?: 'daily' | 'weekly' | 'monthly'
  cap?: number
  /** The first fee and the cap as a percent of the rent (default: flat dollars). */
  percent?: boolean
  rentStatus?: 'pending' | 'settled'
}) {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const ll = await seedLandlord(c)
    const tenantId = await seedTenant(c)
    const propertyId = await seedProperty(c, { landlordId: ll.landlordId, ownerUserId: ll.userId, managedByUserId: ll.userId })
    await c.query(`UPDATE properties SET timezone = $2, late_fee_enabled = TRUE, late_fee_grace_days = $3 WHERE id = $1`,
      [propertyId, TZ, o.propertyGrace ?? 5])
    const unitId = await seedUnit(c, { propertyId, landlordId: ll.landlordId })
    const leaseId = await seedLease(c, { unitId, landlordId: ll.landlordId, rentAmount: 800 })
    await c.query(
      `UPDATE leases SET late_fee_enabled = TRUE, late_fee_grace_days = $2,
              late_fee_initial_type = $9, late_fee_initial_amount = $3,
              late_fee_accrual_type = $4, late_fee_accrual_amount = $5, late_fee_accrual_period = $6,
              late_fee_accrual_from = 'grace_end',
              late_fee_cap_type = $7, late_fee_cap_amount = $8
        WHERE id = $1`,
      [leaseId, o.leaseGrace, o.initial ?? 25,
       o.accrual ? 'flat' : null, o.accrual ?? null, o.accrual ? (o.period ?? 'daily') : null,
       o.cap != null ? (o.percent ? 'percent_of_rent' : 'flat') : null, o.cap ?? null,
       o.percent ? 'percent_of_rent' : 'flat'])
    const due = o.due ?? (await c.query<{ d: string }>(
      `SELECT ((NOW() AT TIME ZONE $1)::date - $2::int)::text AS d`, [TZ, o.daysAgo ?? 0])).rows[0].d
    const invoiceId = (await c.query<{ id: string }>(
      `INSERT INTO invoices (landlord_id, lease_id, unit_id, tenant_id, invoice_number, due_date,
                             subtotal_rent, total_amount, status, created_at)
       VALUES ($1,$2,$3,$4,$5,$6::date,800,800,'pending', (($6::date - 3) + TIME '12:00') AT TIME ZONE $7) RETURNING id`,
      [ll.landlordId, leaseId, unitId, tenantId, `INV-${Math.random().toString(36).slice(2, 10)}`, due, TZ])).rows[0].id
    const rentStatus = o.rentStatus ?? 'pending'
    await c.query(
      `INSERT INTO payments (landlord_id, unit_id, lease_id, tenant_id, type, amount, status, entry_description,
                             due_date, invoice_id, settled_at, created_at)
       VALUES ($1,$2,$3,$4,'rent',800,$7,'RENT',$5::date,$6,
               CASE WHEN $7 = 'settled' THEN (($5::date - 1) + TIME '12:00') AT TIME ZONE $8 END,
               (($5::date - 3) + TIME '12:00') AT TIME ZONE $8)`,
      [ll.landlordId, unitId, leaseId, tenantId, due, invoiceId, rentStatus, TZ])
    await c.query('COMMIT')
    return { invoiceId, due, unitId, leaseId, tenantId, landlordId: ll.landlordId }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

type Fee = { amount: number; due_date: string; status: string }
const fees = async (invoiceId: string) => (await db.query<Fee>(
  `SELECT amount::float AS amount, due_date::text AS due_date, status FROM payments
    WHERE invoice_id = $1 AND type = 'late_fee' ORDER BY due_date, status`, [invoiceId])).rows
const days = (f: Fee[]) => f.map(x => x.due_date)
const plusDays = async (d: string, n: number) =>
  (await db.query<{ d: string }>(`SELECT ($1::date + $2::int)::text AS d`, [d, n])).rows[0].d
const parkToday = async () =>
  (await db.query<{ d: string }>(`SELECT (NOW() AT TIME ZONE $1)::date::text AS d`, [TZ])).rows[0].d

/** The bank refuses the pull that covered every line still owed on the bill; a retry is scheduled (webhooks failIntentRows). */
async function bounce(invoiceId: string, pi: string) {
  await db.query(
    `UPDATE payments SET status = 'failed', stripe_payment_intent_id = $2, return_code = 'R01',
                         retry_count = 0, next_retry_at = NOW() - INTERVAL '1 minute'
      WHERE invoice_id = $1 AND status = 'pending'`, [invoiceId, pi])
}

describe('a bounced pull: the fees it covered stay charged', () => {
  it('the night after the bounce charges no fee a second time, and the retry of the whole pull still runs', async () => {
    // Due 10 days ago, 3 days of grace, $3 a day: $25 on due + 3, then $3 for
    // due + 4 through today.
    const s = await seedBill({ daysAgo: 10, leaseGrace: 3, accrual: 3 })
    await generateLateFeesForTimezone(TZ)
    const fined = await fees(s.invoiceId)
    expect(fined).toHaveLength(8)
    expect(fined[0]).toEqual({ amount: 25, due_date: await plusDays(s.due, 3), status: 'pending' })

    await bounce(s.invoiceId, 'pi_bounced_pull')
    await generateLateFeesForTimezone(TZ)
    const after = await fees(s.invoiceId)
    expect(after).toEqual(fined.map(f => ({ ...f, status: 'failed' })))

    // The retry claims every line of the pull — the rent and each fee.
    const r = await processAchRetries()
    expect(r.errors).toEqual([])
    expect(r.fired).toBe(1)
    const { rows } = await db.query<{ status: string; n: number }>(
      `SELECT status, COUNT(*)::int AS n FROM payments WHERE invoice_id = $1 GROUP BY status`, [s.invoiceId])
    expect(rows).toEqual([{ status: 'processing', n: 9 }])
  })

  it('a bounced fee still counts toward the cap', async () => {
    // $25 then $3 a day, capped at $31: due + 3, + 4 and + 5, then nothing.
    const s = await seedBill({ daysAgo: 10, leaseGrace: 3, accrual: 3, cap: 31 })
    await generateLateFeesForTimezone(TZ)
    expect((await fees(s.invoiceId)).reduce((t, f) => t + f.amount, 0)).toBe(31)
    await bounce(s.invoiceId, 'pi_bounced_capped')
    // The next night (every date one day further back): still nothing — the
    // cap is reached by the fees the bounced pull covered.
    await db.query(`UPDATE invoices SET due_date = due_date - 1 WHERE id = $1`, [s.invoiceId])
    await db.query(`UPDATE payments SET due_date = due_date - 1 WHERE invoice_id = $1`, [s.invoiceId])
    await generateLateFeesForTimezone(TZ)
    const f = await fees(s.invoiceId)
    expect(f.reduce((t, x) => t + x.amount, 0)).toBe(31)
    expect(f.every(x => x.status === 'failed')).toBe(true)
  })

  it('a bounced rent is still the rent a percent fee and a percent cap are figured on', async () => {
    // 5% of the $800 rent ($40) first, then $3 a day, capped at 10% ($80).
    const s = await seedBill({ daysAgo: 6, leaseGrace: 3, initial: 5, percent: true, accrual: 3, cap: 10 })
    await generateLateFeesForTimezone(TZ)
    expect((await fees(s.invoiceId)).map(f => f.amount)).toEqual([40, 3, 3, 3])
    await bounce(s.invoiceId, 'pi_bounced_percent')
    // The next night: $3 more — the cap is still 10% of $800, not of nothing.
    await db.query(`UPDATE invoices SET due_date = due_date - 1 WHERE id = $1`, [s.invoiceId])
    await db.query(`UPDATE payments SET due_date = due_date - 1 WHERE invoice_id = $1`, [s.invoiceId])
    await generateLateFeesForTimezone(TZ)
    const f = await fees(s.invoiceId)
    expect(f.map(x => x.amount)).toEqual([40, 3, 3, 3, 3])
    expect(f[4]).toEqual({ amount: 3, due_date: await plusDays(await plusDays(s.due, -1), 7), status: 'pending' })
  })

  it('a fee paid from the deposit is charged — its day is never charged again', async () => {
    const s = await seedBill({ daysAgo: 6, leaseGrace: 3, accrual: 3 })
    await generateLateFeesForTimezone(TZ)
    const fined = await fees(s.invoiceId)
    expect(fined).toHaveLength(4)
    await db.query(
      `UPDATE payments SET status = 'paid_via_deposit' WHERE invoice_id = $1 AND type = 'late_fee'`, [s.invoiceId])
    await generateLateFeesForTimezone(TZ)
    expect(await fees(s.invoiceId)).toEqual(fined.map(f => ({ ...f, status: 'paid_via_deposit' })))
  })
})

describe('a monthly fee charges once a month', () => {
  // Due 5/26 with 5 days of grace: the first late day is 5/31, and a monthly
  // fee falls on the 31st — clamped to the last day of a shorter month.
  async function monthlyBill(propertyGrace?: number) {
    const s = await seedBill({
      due: '2026-05-26', leaseGrace: propertyGrace === undefined ? 5 : null, propertyGrace,
      initial: 0, accrual: 10, period: 'monthly',
    })
    const today = await parkToday()
    const expected: string[] = []
    for (let n = 1; ; n++) {
      const d = addAccrualPeriods('2026-05-31', 'monthly', n)
      if (d > today) break
      expected.push(d)
    }
    return { s, expected }
  }

  it('a first fee on June 30th keeps the calendar on the 31st: a second night charges no month twice', async () => {
    const { s, expected } = await monthlyBill()
    expect(expected.slice(0, 4)).toEqual(['2026-06-30', '2026-07-31', '2026-08-31', '2026-09-30'])
    await generateLateFeesForTimezone(TZ)
    expect(days(await fees(s.invoiceId))).toEqual(expected)
    await generateLateFeesForTimezone(TZ)
    const f = await fees(s.invoiceId)
    expect(days(f)).toEqual(expected)
    const months = f.map(x => x.due_date.slice(0, 7))
    expect(new Set(months).size).toBe(months.length)
  })

  it('a grace edit after the first monthly fee charges no month twice either', async () => {
    const { s, expected } = await monthlyBill(5)
    await generateLateFeesForTimezone(TZ)
    expect(days(await fees(s.invoiceId))).toEqual(expected)
    for (const g of [3, 7, 0, 5]) {
      await db.query(`UPDATE properties SET late_fee_grace_days = $2
                       WHERE id = (SELECT property_id FROM units WHERE id = $1)`, [s.unitId, g])
      await generateLateFeesForTimezone(TZ)
      expect(days(await fees(s.invoiceId))).toEqual(expected)
    }
  })
})

// Nic, 10/12: "it rides the original due date. landlord can issue credit
// against late fee if desired."
describe('a charge added to a bill after it went late rides the bill’s own late clock', () => {
  it('rent paid, water added yesterday: fees from the bill’s first late day, as before', async () => {
    // Due 10 days ago, 5 days of grace, $3 a day. The rent was paid the day
    // before it was due; a $40 water line joined the bill yesterday.
    const s = await seedBill({ daysAgo: 10, leaseGrace: 5, accrual: 3, rentStatus: 'settled' })
    await db.query(
      `INSERT INTO payments (landlord_id, unit_id, lease_id, tenant_id, type, amount, status, entry_description,
                             due_date, invoice_id, created_at)
       VALUES ($1,$2,$3,$4,'utility',40,'pending','UTILITY',$5::date,$6, NOW() - INTERVAL '1 day')`,
      [s.landlordId, s.unitId, s.leaseId, s.tenantId, s.due, s.invoiceId])
    await db.query(`UPDATE invoices SET status = 'partial' WHERE id = $1`, [s.invoiceId])
    await generateLateFeesForTimezone(TZ)
    const f = await fees(s.invoiceId)
    expect(f[0]).toEqual({ amount: 25, due_date: await plusDays(s.due, 5), status: 'pending' })
    expect(days(f)).toEqual(await Promise.all([5, 6, 7, 8, 9, 10].map(n => plusDays(s.due, n))))
  })
})
