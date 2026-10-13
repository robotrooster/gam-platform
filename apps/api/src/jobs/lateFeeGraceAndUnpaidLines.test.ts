/**
 * 10/12 (Nic) — when a bill is late, and what keeps it late.
 *
 *   "Grace = lease, else property, else 5 — the only chain."
 *   "First LATE day = due + grace days (rent due the 1st, 5-day grace → the
 *    6th is late, the day late fees start)."
 *   A bill is never "unpaid" because of a $0 line: only a line with money on
 *   it, still owed, that is not a late fee and not covered by work trade keeps
 *   the fees running.
 *
 * And (10/12, Nic): with a grace of 0 the NEXT day is late — paying on the
 * due date is on time; and a bill written after its due date starts its grace
 * the day it was written. Fees already charged stand.
 *
 * The engine used to skip the property (lease → service agreement → 5), and
 * counted any line not yet 'settled' as unpaid — a $0 line, a work-trade line,
 * a line paid from the deposit or voided — so a bill the tenant had paid in
 * full could go on collecting fees.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { db } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedLease, seedTenant } from '../test/dbHelpers'
import { generateLateFeesForTimezone } from './lateFees'
import { createHomeSaleContract } from '../services/homeSale'

const TZ = 'America/Phoenix'
beforeEach(async () => { await cleanupAllSchema() })

type Line = {
  type: 'rent' | 'utility' | 'fee'
  amount: number
  status?: 'pending' | 'settled' | 'failed' | 'paid_via_deposit' | 'voided'
  workTrade?: boolean
}

/**
 * A $25 flat late fee (no accrual unless `accrual` is given) on a bill that
 * came due `daysAgo` days ago in the park's calendar.
 * `leaseGrace: null` = the lease names no grace; `propertyGrace` undefined =
 * the property's own default (5).
 */
async function seedBill(o: {
  daysAgo: number
  leaseGrace: number | null
  propertyGrace?: number
  lines?: Line[]
  accrual?: number
  /** How often `accrual` charges (default daily). */
  period?: 'daily' | 'weekly'
  /** S639/S648: an existing resident's first bill, and the property's answer to the waiver. */
  existingTenancy?: boolean
  waiver?: boolean
  /** 10/12: the park's day GAM wrote the bill, as days ago (default: 3 days before it came due). */
  writtenDaysAgo?: number
  /** Where an accrual counts from (default grace_end). */
  accrualFrom?: 'grace_end' | 'due_date' | 'due_date_inclusive'
  /** The first fee (default $25; 0 for a count-back with no first fee). */
  initial?: number
}) {
  const lines: Line[] = o.lines ?? [{ type: 'rent', amount: 800 }]
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const ll = await seedLandlord(c)
    const propertyId = await seedProperty(c, { landlordId: ll.landlordId, ownerUserId: ll.userId, managedByUserId: ll.userId })
    await c.query(`UPDATE properties SET timezone = $2, late_fee_enabled = TRUE, onboarding_late_fee_waiver = $3 WHERE id = $1`,
      [propertyId, TZ, o.waiver ?? null])
    if (o.propertyGrace !== undefined) {
      await c.query(`UPDATE properties SET late_fee_grace_days = $2 WHERE id = $1`, [propertyId, o.propertyGrace])
    }
    const unitId = await seedUnit(c, { propertyId, landlordId: ll.landlordId })
    const leaseId = await seedLease(c, { unitId, landlordId: ll.landlordId, rentAmount: 800 })
    await c.query(
      `UPDATE leases SET late_fee_enabled = TRUE, late_fee_grace_days = $2,
              late_fee_initial_type = 'flat', late_fee_initial_amount = $8,
              late_fee_accrual_type = $3, late_fee_accrual_amount = $4,
              late_fee_accrual_period = $5, late_fee_accrual_from = $7,
              is_existing_tenancy = $6
        WHERE id = $1`,
      [leaseId, o.leaseGrace,
       o.accrual ? 'flat' : null, o.accrual ?? null, o.accrual ? (o.period ?? 'daily') : null, !!o.existingTenancy,
       o.accrualFrom ?? 'grace_end', o.initial ?? 25])
    const total = lines.reduce((s, l) => s + l.amount, 0)
    const due = (await c.query<{ d: string }>(
      `SELECT ((NOW() AT TIME ZONE $1)::date - $2::int)::text AS d`, [TZ, o.daysAgo])).rows[0].d
    // Written at noon in the park on its written day (default: 3 days before it came due).
    const written = o.writtenDaysAgo === undefined ? null : (await c.query<{ d: string }>(
      `SELECT ((NOW() AT TIME ZONE $1)::date - $2::int)::text AS d`, [TZ, o.writtenDaysAgo])).rows[0].d
    const invoiceId = (await c.query<{ id: string }>(
      `INSERT INTO invoices (landlord_id, lease_id, unit_id, invoice_number, due_date,
                             subtotal_rent, total_amount, status, created_at)
       VALUES ($1,$2,$3,$4,$5::date,$6,$6,'pending',
               COALESCE(($7::date + TIME '12:00') AT TIME ZONE $8, $5::date - 3)) RETURNING id`,
      [ll.landlordId, leaseId, unitId, `INV-${Math.random().toString(36).slice(2, 10)}`, due, total, written, TZ])).rows[0].id
    for (const l of lines) {
      const status = l.status ?? 'pending'
      await c.query(
        `INSERT INTO payments (landlord_id, unit_id, lease_id, type, amount, status, entry_description,
                               due_date, invoice_id, settled_at, voided_at, void_reason, work_trade_suspended_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::date,$9,
                 CASE WHEN $6 = 'settled' THEN NOW() END,
                 CASE WHEN $6 = 'voided' THEN NOW() END,
                 CASE WHEN $6 = 'voided' THEN 'test' END,
                 CASE WHEN $10 THEN NOW() END)`,
        [ll.landlordId, unitId, leaseId, l.type, l.amount, status,
         l.type === 'rent' ? 'RENT' : l.type === 'utility' ? 'UTILITY' : 'OTHERFEE',
         due, invoiceId, !!l.workTrade])
    }
    await c.query('COMMIT')
    return { invoiceId, due, written, unitId, leaseId, landlordId: ll.landlordId }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

const fees = async (invoiceId: string) => (await db.query<{ amount: number; due_date: string }>(
  `SELECT amount::float AS amount, due_date::text AS due_date FROM payments
    WHERE invoice_id = $1 AND type = 'late_fee' ORDER BY due_date`, [invoiceId])).rows

const plusDays = async (d: string, n: number) =>
  (await db.query<{ d: string }>(`SELECT ($1::date + $2::int)::text AS d`, [d, n])).rows[0].d

describe('grace: the lease, else the property, else 5', () => {
  it("a lease that names no grace uses the property's, not the platform's 5", async () => {
    // Two days past due with the park's 2-day grace: today is the first late
    // day. On the platform's 5 days it would not be late for three more.
    const s = await seedBill({ daysAgo: 2, leaseGrace: null, propertyGrace: 2 })
    await generateLateFeesForTimezone(TZ)
    expect(await fees(s.invoiceId)).toEqual([{ amount: 25, due_date: await plusDays(s.due, 2) }])
  })

  it("the lease's own grace wins over the property's", async () => {
    const early = await seedBill({ daysAgo: 3, leaseGrace: 7, propertyGrace: 2 })
    await generateLateFeesForTimezone(TZ)
    expect(await fees(early.invoiceId)).toEqual([])

    const late = await seedBill({ daysAgo: 7, leaseGrace: 7, propertyGrace: 2 })
    await generateLateFeesForTimezone(TZ)
    expect(await fees(late.invoiceId)).toEqual([{ amount: 25, due_date: await plusDays(late.due, 7) }])
  })

  it('a lease grace of 0 is a grace of 0, not "none named"', async () => {
    // A day past due: late on the lease's 0 days, nowhere near the park's 9.
    const s = await seedBill({ daysAgo: 1, leaseGrace: 0, propertyGrace: 9 })
    await generateLateFeesForTimezone(TZ)
    expect(await fees(s.invoiceId)).toHaveLength(1)
  })
})

describe('the first late day is the due date + grace — the 6th for a 5-day grace', () => {
  it('the 5th is still grace: no fee', async () => {
    const s = await seedBill({ daysAgo: 4, leaseGrace: null })   // property default: 5
    await generateLateFeesForTimezone(TZ)
    expect(await fees(s.invoiceId)).toEqual([])
  })

  it('the 6th is late: the fee charges that day, dated that day', async () => {
    const s = await seedBill({ daysAgo: 5, leaseGrace: null })
    await generateLateFeesForTimezone(TZ)
    expect(await fees(s.invoiceId)).toEqual([{ amount: 25, due_date: await plusDays(s.due, 5) }])
  })
})

describe('a bill is never unpaid because of a $0 line', () => {
  it('rent paid, a $0 water line still open: no fee', async () => {
    const s = await seedBill({ daysAgo: 10, leaseGrace: 3, lines: [
      { type: 'rent', amount: 800, status: 'settled' },
      { type: 'utility', amount: 0 },
    ] })
    await generateLateFeesForTimezone(TZ)
    expect(await fees(s.invoiceId)).toEqual([])
  })

  it('rent paid, $12 of water still owed: the fee charges as before', async () => {
    const s = await seedBill({ daysAgo: 10, leaseGrace: 3, lines: [
      { type: 'rent', amount: 800, status: 'settled' },
      { type: 'utility', amount: 12 },
    ] })
    await generateLateFeesForTimezone(TZ)
    expect(await fees(s.invoiceId)).toEqual([{ amount: 25, due_date: await plusDays(s.due, 3) }])
  })

  it('a line covered by work trade is never owed, so it keeps nothing late', async () => {
    const s = await seedBill({ daysAgo: 10, leaseGrace: 3, lines: [
      { type: 'rent', amount: 800, status: 'settled' },
      { type: 'utility', amount: 40, workTrade: true },
    ] })
    await generateLateFeesForTimezone(TZ)
    expect(await fees(s.invoiceId)).toEqual([])
  })

  it('nor does a line paid from the deposit, or a voided line', async () => {
    const s = await seedBill({ daysAgo: 10, leaseGrace: 3, lines: [
      { type: 'rent', amount: 800, status: 'settled' },
      { type: 'fee', amount: 50, status: 'paid_via_deposit' },
      { type: 'utility', amount: 30, status: 'voided' },
    ] })
    await generateLateFeesForTimezone(TZ)
    expect(await fees(s.invoiceId)).toEqual([])
  })

  it('a failed payment is still owed and keeps the bill late', async () => {
    const s = await seedBill({ daysAgo: 10, leaseGrace: 3, lines: [{ type: 'rent', amount: 800, status: 'failed' }] })
    await generateLateFeesForTimezone(TZ)
    expect(await fees(s.invoiceId)).toEqual([{ amount: 25, due_date: await plusDays(s.due, 3) }])
  })

  it('once the only line left is $0, a daily fee stops accruing', async () => {
    // Late with $3 a day; the rent is paid, and only the $0 line is left.
    const s = await seedBill({ daysAgo: 6, leaseGrace: 3, accrual: 3, lines: [
      { type: 'rent', amount: 800 },
      { type: 'utility', amount: 0 },
    ] })
    await generateLateFeesForTimezone(TZ)
    const before = await fees(s.invoiceId)
    expect(before.length).toBe(4)   // $25 on the first late day, then $3 for each day since
    await db.query(
      `UPDATE payments SET status = 'settled', settled_at = NOW() WHERE invoice_id = $1 AND type = 'rent'`, [s.invoiceId])
    // The next night: nothing new, and the days already charged stay charged.
    await db.query(`DELETE FROM payments WHERE invoice_id = $1 AND type = 'late_fee' AND due_date = (
                      SELECT MAX(due_date) FROM payments WHERE invoice_id = $1 AND type = 'late_fee')`, [s.invoiceId])
    await generateLateFeesForTimezone(TZ)
    expect(await fees(s.invoiceId)).toEqual(before.slice(0, -1))
  })
})

// 10/12 (Nic): grace follows the property's setting, which the landlord can
// edit while a bill is late. The first fee on the bill fixes where its fees
// start: an edit afterwards never charges the first fee again on a new day,
// never back-fills days that were inside the grace when they passed, and never
// moves a weekly fee onto a new day.
describe('a grace edit never fines a bill twice', () => {
  const setPropertyGrace = (unitId: string, days: number) => db.query(
    `UPDATE properties SET late_fee_grace_days = $2 WHERE id = (SELECT property_id FROM units WHERE id = $1)`,
    [unitId, days])

  async function fineThenEdit(o: { daysAgo: number; accrual?: number; period?: 'daily' | 'weekly' }) {
    const s = await seedBill({ daysAgo: o.daysAgo, leaseGrace: null, propertyGrace: 5, accrual: o.accrual, period: o.period })
    await generateLateFeesForTimezone(TZ)
    const before = await fees(s.invoiceId)
    expect(before[0]).toEqual({ amount: 25, due_date: await plusDays(s.due, 5) })
    for (const g of [2, 7, 0, 5]) {
      await setPropertyGrace(s.unitId, g)
      await generateLateFeesForTimezone(TZ)
      expect(await fees(s.invoiceId)).toEqual(before)
    }
    return before
  }

  it('a flat fee: lowering or raising the grace charges no second fee', async () => {
    expect(await fineThenEdit({ daysAgo: 8 })).toHaveLength(1)
  })

  it('a daily fee: a lowered grace back-fills nothing', async () => {
    // $25 on day 5, then $3 for days 6, 7 and 8.
    expect(await fineThenEdit({ daysAgo: 8, accrual: 3 })).toHaveLength(4)
  })

  it('a weekly fee stays on its own days', async () => {
    // $25 on day 5, then $3 on days 12 and 19 — not again on 14 or 9.
    expect(await fineThenEdit({ daysAgo: 20, accrual: 3, period: 'weekly' })).toHaveLength(3)
  })

  it('a bill not yet fined takes the edited grace', async () => {
    const s = await seedBill({ daysAgo: 3, leaseGrace: null, propertyGrace: 5 })
    await generateLateFeesForTimezone(TZ)
    expect(await fees(s.invoiceId)).toEqual([])
    await setPropertyGrace(s.unitId, 2)
    await generateLateFeesForTimezone(TZ)
    expect(await fees(s.invoiceId)).toEqual([{ amount: 25, due_date: await plusDays(s.due, 2) }])
  })
})

describe('kept as they were', () => {
  it("the onboarding waiver: an existing resident's first bill is not fined where the landlord waived it", async () => {
    const s = await seedBill({ daysAgo: 10, leaseGrace: null, propertyGrace: 2, existingTenancy: true, waiver: true })
    await generateLateFeesForTimezone(TZ)
    expect(await fees(s.invoiceId)).toEqual([])
  })

  // e25afa8: a home payment added to a bill after it went late never keeps it
  // late. "After it went late" is the same grace the rest of the engine uses —
  // here the property's 3 days, where the platform's 5 would have counted a
  // line added on day 4 as part of the bill.
  async function homePaymentAddedOnDay(day: number) {
    const s = await seedBill({ daysAgo: 10, leaseGrace: null, propertyGrace: 3, lines: [{ type: 'rent', amount: 800, status: 'settled' }] })
    const c = await db.connect()
    try {
      await c.query('BEGIN')
      const tenantId = await seedTenant(c)
      const k = await createHomeSaleContract(c, {
        unitId: s.unitId, leaseId: null, tenantId, landlordId: s.landlordId,
        salePrice: 1200, downPayment: 0, annualInterestRate: 0, termMonths: 12,
        startMonth: s.due.slice(0, 7) + '-01', planType: 'flat',
      })
      const inst = (await c.query<{ id: string }>(
        `SELECT id FROM home_sale_installments WHERE contract_id = $1 AND installment_number = 1`, [k.id])).rows[0].id
      await c.query(
        `INSERT INTO payments (invoice_id, unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date,
                               entry_description, home_sale_installment_id, created_at)
         VALUES ($1,$2,$3,$4,$5,'home_payment',100,'pending',$6,'HOMEPMT',$7,$6::date + $8::int)`,
        [s.invoiceId, s.unitId, s.leaseId, tenantId, s.landlordId, s.due, inst, day])
      await c.query('COMMIT')
    } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
    await generateLateFeesForTimezone(TZ)
    return fees(s.invoiceId)
  }

  it('a home payment added on day 4 of a 3-day grace keeps nothing late', async () => {
    expect(await homePaymentAddedOnDay(4)).toEqual([])
  })

  it('one written with the bill still counts', async () => {
    expect(await homePaymentAddedOnDay(-3)).toHaveLength(1)
  })
})

/** Fees charged on a bill before 10/12 (the old rule: counted from the due date). */
async function finedBefore(s: { invoiceId: string; unitId: string; leaseId: string; landlordId: string },
                           fees: { day: string; amount: number }[]) {
  for (const f of fees) {
    await db.query(
      `INSERT INTO payments (landlord_id, unit_id, lease_id, type, amount, status, entry_description, due_date, invoice_id)
       VALUES ($1,$2,$3,'late_fee',$4,'pending','LATEFEE',$5::date,$6)`,
      [s.landlordId, s.unitId, s.leaseId, f.amount, f.day, s.invoiceId])
  }
}

// 10/12 (Nic) LF1: "zero grace: NEXT DAY is late (paying on the due date is on
// time)". The first late day is the lateness start + GREATEST(grace, 1).
describe('a grace of 0: paying on the due date is on time, the next day is late', () => {
  it('due today with no grace: not late', async () => {
    const s = await seedBill({ daysAgo: 0, leaseGrace: 0 })
    await generateLateFeesForTimezone(TZ)
    expect(await fees(s.invoiceId)).toEqual([])
  })

  it("the property's grace of 0 too (the lease names none)", async () => {
    const s = await seedBill({ daysAgo: 0, leaseGrace: null, propertyGrace: 0 })
    await generateLateFeesForTimezone(TZ)
    expect(await fees(s.invoiceId)).toEqual([])
  })

  it('the day after the due date is late: the fee is dated that day', async () => {
    const s = await seedBill({ daysAgo: 1, leaseGrace: 0 })
    await generateLateFeesForTimezone(TZ)
    expect(await fees(s.invoiceId)).toEqual([{ amount: 25, due_date: await plusDays(s.due, 1) }])
  })

  it('a daily fee follows the first fee — nothing is charged on the due date', async () => {
    const s = await seedBill({ daysAgo: 3, leaseGrace: 0, accrual: 3 })
    await generateLateFeesForTimezone(TZ)
    expect(await fees(s.invoiceId)).toEqual([
      { amount: 25, due_date: await plusDays(s.due, 1) },
      { amount: 3, due_date: await plusDays(s.due, 2) },
      { amount: 3, due_date: await plusDays(s.due, 3) },
    ])
  })
})

// 10/12 (Nic) LF2: "bill written after its due date: late counts from the DAY
// IT WAS WRITTEN (grace starts then)" — lateness start = the due date, or the
// day GAM wrote the bill when later (services/lateness lateCountsFrom).
describe('a bill written after its due date: its grace starts the day it was written', () => {
  it('the onboarding bill written mid-month is not late until its own grace has run', async () => {
    // Due the 1st (11 days ago), written 4 days ago, 5 days of grace: the
    // due date's grace ran out long ago, the bill's has a day left.
    const early = await seedBill({ daysAgo: 11, writtenDaysAgo: 4, leaseGrace: null })
    await generateLateFeesForTimezone(TZ)
    expect(await fees(early.invoiceId)).toEqual([])

    // Written 5 days ago: today is its first late day.
    const late = await seedBill({ daysAgo: 11, writtenDaysAgo: 5, leaseGrace: null })
    await generateLateFeesForTimezone(TZ)
    expect(await fees(late.invoiceId)).toEqual([{ amount: 25, due_date: await plusDays(late.written!, 5) }])
  })

  it('a monthly run that caught up two days late: fees count from its written day, and a re-run adds nothing', async () => {
    // Due 10 days ago, written 8 days ago: first late day = written + 5
    // (3 days ago), not due + 5 (5 days ago).
    const s = await seedBill({ daysAgo: 10, writtenDaysAgo: 8, leaseGrace: 5, accrual: 3 })
    await generateLateFeesForTimezone(TZ)
    const expected = [
      { amount: 25, due_date: await plusDays(s.written!, 5) },
      { amount: 3, due_date: await plusDays(s.written!, 6) },
      { amount: 3, due_date: await plusDays(s.written!, 7) },
      { amount: 3, due_date: await plusDays(s.written!, 8) },
    ]
    expect(await fees(s.invoiceId)).toEqual(expected)
    await generateLateFeesForTimezone(TZ)
    expect(await fees(s.invoiceId)).toEqual(expected)
  })

  it('a grace of 0 on a bill written late: the day after it was written', async () => {
    const s = await seedBill({ daysAgo: 5, writtenDaysAgo: 2, leaseGrace: 0 })
    await generateLateFeesForTimezone(TZ)
    expect(await fees(s.invoiceId)).toEqual([{ amount: 25, due_date: await plusDays(s.written!, 1) }])
  })

  it('a count back to the start counts back to the written day, not the due date', async () => {
    // $5 a day counted back (the day itself included) once the 3-day grace
    // from the written day has run: the written day through today, 8 days.
    const s = await seedBill({
      daysAgo: 12, writtenDaysAgo: 7, leaseGrace: 3, accrual: 5, initial: 0, accrualFrom: 'due_date_inclusive',
    })
    await generateLateFeesForTimezone(TZ)
    const f = await fees(s.invoiceId)
    expect(f).toHaveLength(8)
    expect(f[0]).toEqual({ amount: 5, due_date: s.written })
  })

  it('a weekly count-back not yet fined counts its weeks from the written day', async () => {
    // Written 5 days after its due date, 3 days of grace, $10 a week counted
    // from the day after the start: written + 7 and written + 14.
    const s = await seedBill({
      daysAgo: 20, writtenDaysAgo: 15, leaseGrace: 3, accrual: 10, initial: 0, period: 'weekly', accrualFrom: 'due_date',
    })
    await generateLateFeesForTimezone(TZ)
    expect(await fees(s.invoiceId)).toEqual([
      { amount: 10, due_date: await plusDays(s.written!, 7) },
      { amount: 10, due_date: await plusDays(s.written!, 14) },
    ])
  })
})

// 10/12: "do not add a second set of fees to bills that already have late
// fees" — fees charged before the rule stand, and the bill's next fees follow
// its first fee's calendar.
describe('fees charged before 10/12 stand: no second set', () => {
  it("a bill fined from its due date gets no second first fee on the written day's first late day", async () => {
    // Due 12 days ago, written 9 days ago, 5 days of grace, $3 a day. Fined
    // the old way: $25 on due + 5, $3 a day through yesterday.
    const s = await seedBill({ daysAgo: 12, writtenDaysAgo: 9, leaseGrace: 5, accrual: 3 })
    const old = [{ day: await plusDays(s.due, 5), amount: 25 }]
    for (let d = 6; d <= 11; d++) old.push({ day: await plusDays(s.due, d), amount: 3 })
    await finedBefore(s, old)
    await generateLateFeesForTimezone(TZ)
    const f = await fees(s.invoiceId)
    expect(f).toHaveLength(8)
    expect(f.filter(x => x.amount === 25)).toEqual([{ amount: 25, due_date: await plusDays(s.due, 5) }])
    expect(f[f.length - 1]).toEqual({ amount: 3, due_date: await plusDays(s.due, 12) })
  })

  it("a fined bill keeps accruing while the written day's grace would still be running", async () => {
    // Written 4 days after its due date: its first late day would be due + 9,
    // tomorrow. Already fined on due + 5, it is already late — today's $3 lands.
    const s = await seedBill({ daysAgo: 8, writtenDaysAgo: 4, leaseGrace: 5, accrual: 3 })
    await finedBefore(s, [
      { day: await plusDays(s.due, 5), amount: 25 },
      { day: await plusDays(s.due, 6), amount: 3 },
      { day: await plusDays(s.due, 7), amount: 3 },
    ])
    await generateLateFeesForTimezone(TZ)
    const f = await fees(s.invoiceId)
    expect(f).toHaveLength(4)
    expect(f[3]).toEqual({ amount: 3, due_date: await plusDays(s.due, 8) })
  })

  it("a weekly count-back fined from the due date stays on the due date's weeks", async () => {
    // The same bill as above, fined the old way on due + 7 and due + 14: the
    // written day's weeks (written + 7 = due + 12, due + 19) would charge those
    // weeks twice. Its next fee is due + 21, after today.
    const s = await seedBill({
      daysAgo: 20, writtenDaysAgo: 15, leaseGrace: 3, accrual: 10, initial: 0, period: 'weekly', accrualFrom: 'due_date',
    })
    await finedBefore(s, [
      { day: await plusDays(s.due, 7), amount: 10 },
      { day: await plusDays(s.due, 14), amount: 10 },
    ])
    await generateLateFeesForTimezone(TZ)
    expect(await fees(s.invoiceId)).toEqual([
      { amount: 10, due_date: await plusDays(s.due, 7) },
      { amount: 10, due_date: await plusDays(s.due, 14) },
    ])
  })
})
