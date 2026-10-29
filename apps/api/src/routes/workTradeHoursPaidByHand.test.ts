/**
 * 10/12 (Nic) — EXTRA WORK-TRADE HOURS PAID BY HAND ARE AN EXPENSE (money out is one record).
 *
 *   Paid extra hours are paid "Both" ways — by hand (Mark paid on the Work
 *   Trade page, a check or cash) or through GAM Books. L5: every dollar out is
 *   an Expense. Mark paid now records ONE PAID expense under the company's
 *   "Work trade labor" category (the chart's Work-trade labor account):
 *     - to the contractor vendor who is the work trader when the agreement
 *       pays them as a 1099 contractor (the same person is one vendor);
 *     - a plain expense when they are W-2 wages paid outside payroll;
 *   paid that day by that check or cash. It posts through the expense; the
 *   hours themselves post nothing (no double count). Removing the expense puts
 *   the hours back to owed; its payment is never taken back alone.
 *
 * Real routes, real tables, the production ledger projectors (each test starts
 * from a clean database).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { db } from '../db'
import { cleanupAllSchema, seedTenant } from '../test/dbHelpers'
import { ledgerCompany, inTx, type LedgerCompany } from '../test/ledgerFixtures'
import { active, balance } from '../test/ledgerP5Fixtures'
import { drainLedgerOutbox } from '../services/ledgerEngine'
import {
  registerProductionLedgerProjectors, unregisterProductionLedgerProjectors, LEDGER_SOURCE_TYPES_NOT_POSTED_YET,
  productionLedgerProjectors,
} from '../services/ledgerProjectors'
import { BOOKS_DEFAULT_EXPENSE_CATEGORIES } from '@gam/shared'
import { workTradeRouter } from './workTrade'
import { expensesRouter } from './expenses'
import { errorHandler } from '../middleware/errorHandler'

const SECRET = 'test_jwt_secret_work_trade_paid_by_hand'
function app() {
  const a = express()
  a.use(express.json())
  a.use('/api/work-trade', workTradeRouter)
  a.use('/api/expenses', expensesRouter)
  a.use(errorHandler)
  return a
}
const sign = (p: object) => jwt.sign(p, SECRET, { expiresIn: '1h' })
const as = (tok: string) => ({ Authorization: `Bearer ${tok}` })

beforeEach(async () => {
  process.env.JWT_SECRET = SECRET
  await cleanupAllSchema()
  registerProductionLedgerProjectors()
})
afterEach(() => unregisterProductionLedgerProjectors())

interface World extends LedgerCompany {
  tenantId: string; agreementId: string; ownerToken: string
}

/** A company on the books (ledgerCompany) with a work trader, Wanda Worker, on its first property. */
async function world(payMethod: 'payroll_w2' | 'contractor_1099'): Promise<World> {
  const co = await ledgerCompany()
  return inTx(async (c) => {
    const tenantId = await seedTenant(c)
    await c.query(`UPDATE users SET first_name = 'Wanda', last_name = 'Worker' WHERE id = (SELECT user_id FROM tenants WHERE id = $1)`, [tenantId])
    const agreementId = (await c.query<{ id: string }>(
      `INSERT INTO work_trade_agreements
         (unit_id, tenant_id, landlord_id, start_date, status, monthly_hours_target, tracks_hours,
          carry_forward_months, extra_hours_mode, extra_hours_rate, extra_hours_pay_method)
       VALUES ($1, $2, $3, '2026-09-01', 'active', 80, TRUE, 3, 'pay', 15, $4) RETURNING id`,
      [co.unitId, tenantId, co.landlordId, payMethod])).rows[0].id
    return {
      ...co, tenantId, agreementId,
      ownerToken: sign({ userId: co.ownerUserId, role: 'landlord', email: 'o@t.dev', profileId: null, landlordIds: [co.landlordId], permissions: {} }),
    }
  })
}

/** Paid extra hours owed for a month (what the month close writes). */
async function hours(w: World, month = '2026-09-01', hrs = 6): Promise<string> {
  const r = await db.query<{ id: string }>(
    `INSERT INTO work_trade_extra_hours (agreement_id, landlord_id, tenant_id, period_month, period_start, hours, rate, amount, pay_method)
     SELECT $1, $2, $3, $4::date, $4::date, $5::numeric, 15, $5::numeric * 15, a.extra_hours_pay_method FROM work_trade_agreements a WHERE a.id = $1
     RETURNING id`, [w.agreementId, w.landlordId, w.tenantId, month, hrs])
  return r.rows[0].id
}

/** Mark paid; 10/14 (Nic): where the cost goes is asked every time — the work trader's property unless the test says. */
const markPaid = (w: World, id: string, body: object) =>
  request(app()).post(`/api/work-trade/extra-hours/${id}/mark-paid`).set(as(w.ownerToken))
    .send({ costPlace: 'property', propertyId: w.propertyId, ...body })

const record = async (id: string) => (await db.query(
  `SELECT status, paid_how, to_char(paid_on, 'YYYY-MM-DD') AS paid_on, paid_at IS NOT NULL AS stamped, books_reference_id
     FROM work_trade_extra_hours WHERE id = $1`, [id])).rows[0]

const expenseOf = async (id: string) => (await db.query(
  `SELECT e.id, e.status, e.amount::float AS amount, to_char(e.expense_date, 'YYYY-MM-DD') AS day, e.vendor_id, e.property_id,
          e.unit_id, e.is_common, e.work_trade_extra_hours_id, e.description, e.payments_tracked,
          c.system_key AS category_key, c.name AS category_name
     FROM landlord_expenses e JOIN books_categories c ON c.id = e.category_id WHERE e.id = $1`, [id])).rows[0]

const paymentsOf = async (expenseId: string) => (await db.query(
  `SELECT id, method, amount::float AS amount, to_char(paid_on, 'YYYY-MM-DD') AS paid_on, source, memo, voided_at IS NOT NULL AS voided
     FROM landlord_expense_payments WHERE expense_id = $1 ORDER BY created_at, id`, [expenseId])).rows

describe('Mark paid records one PAID expense under Work trade labor', () => {
  it('W-2 wages paid by check: a plain expense on the property, paid that day by that check; the hours name it', async () => {
    const w = await world('payroll_w2')
    const x = await hours(w)
    const r = await markPaid(w, x, { paidOn: '2026-10-05', paidHow: 'check', note: 'check #1042' })
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    const rec = await record(x)
    expect(rec).toMatchObject({ status: 'paid', paid_how: 'check', paid_on: '2026-10-05', stamped: true })
    expect(r.body.data.books_reference_id).toBe(rec.books_reference_id)

    const e = await expenseOf(rec.books_reference_id)
    expect(e).toMatchObject({
      status: 'active', amount: 90, day: '2026-10-05', vendor_id: null, property_id: w.propertyId, unit_id: null, is_common: true,
      work_trade_extra_hours_id: x, category_key: 'work_trade_labor', category_name: 'Work trade labor', payments_tracked: true,
    })
    expect(e.description).toBe('Work-trade extra hours, 2026-09: Wanda Worker (wages paid outside payroll)')
    expect(await paymentsOf(e.id)).toMatchObject([{ method: 'check', amount: 90, paid_on: '2026-10-05', source: 'payment', memo: 'check #1042', voided: false }])

    // The Expenses page lists it paid, says what it is, and removes it (never its payment alone).
    const listed = (await request(app()).get('/api/expenses').set(as(w.ownerToken))).body.data.find((row: any) => row.id === e.id)
    expect(listed).toMatchObject({ pay_state: 'paid', work_trade_paid_by_hand: true, can_remove: true, category_name: 'Work trade labor' })
  })

  it('a 1099 contractor paid in cash: to the vendor who is the work trader — one vendor, every month', async () => {
    const w = await world('contractor_1099')
    const sept = await hours(w, '2026-09-01', 6)
    const oct = await hours(w, '2026-10-01', 4)
    expect((await markPaid(w, sept, { paidOn: '2026-10-05', paidHow: 'cash' })).status).toBe(200)
    expect((await markPaid(w, oct, { paidOn: '2026-10-10', paidHow: 'cash' })).status).toBe(200)
    const a = await expenseOf((await record(sept)).books_reference_id)
    const b = await expenseOf((await record(oct)).books_reference_id)
    expect(a.vendor_id).toBeTruthy()
    expect(b.vendor_id).toBe(a.vendor_id)
    const v = (await db.query(`SELECT name, tenant_id, is_1099, vendor_type FROM books_vendors WHERE id = $1`, [a.vendor_id])).rows[0]
    expect(v).toEqual({ name: 'Wanda Worker', tenant_id: w.tenantId, is_1099: true, vendor_type: 'contractor' })
    expect(a.description).toBe('Work-trade extra hours, 2026-09: Wanda Worker (contractor, 1099)')
    expect([a.category_key, b.category_key]).toEqual(['work_trade_labor', 'work_trade_labor'])
    expect((await paymentsOf(a.id))[0]).toMatchObject({ method: 'cash', amount: 90 })
    // The vendor's 1099 total is every payment to them.
    const paid = (await db.query<{ n: number }>(
      `SELECT sum(p.amount)::float AS n FROM landlord_expense_payments p JOIN landlord_expenses e ON e.id = p.expense_id
        WHERE e.vendor_id = $1 AND p.voided_at IS NULL`, [a.vendor_id])).rows[0].n
    expect(paid).toBe(150)
  })

  it('posts through the expense — Work-trade labor / Accounts payable, then Accounts payable / the check — and the hours post nothing', async () => {
    expect(LEDGER_SOURCE_TYPES_NOT_POSTED_YET).not.toHaveProperty('work_trade_hours')
    expect(productionLedgerProjectors().map(p => p.sourceType)).toContain('work_trade_hours')
    const w = await world('payroll_w2')
    const x = await hours(w)
    await markPaid(w, x, { paidOn: '2026-10-05', paidHow: 'check' })
    const expenseId = (await record(x)).books_reference_id
    expect(await drainLedgerOutbox()).toMatchObject({ failed: 0 })
    expect((await active('expense', expenseId)).map(l => [l.role, l.dr, l.cr]))
      .toEqual([['work_trade_labor', 90, 0], ['accounts_payable', 0, 90]])
    const [p] = await paymentsOf(expenseId)
    expect((await active('expense_payment', p.id)).map(l => [l.role, l.dr, l.cr, l.cash]))
      .toEqual([['accounts_payable', 90, 0, 'out'], ['outstanding_checks', 0, 90, null]])
    expect(await balance(w.landlordId, 'work_trade_labor')).toBe(90)
    expect(await balance(w.landlordId, 'accounts_payable')).toBe(0)
    // The hours' own marks drained, and posted nothing.
    expect((await db.query(`SELECT count(*)::int AS n FROM ledger_outbox WHERE source_type = 'work_trade_hours'`)).rows[0].n).toBe(0)
    expect((await db.query(`SELECT count(*)::int AS n FROM ledger_postings WHERE source_type = 'work_trade_hours'`)).rows[0].n).toBe(0)
  })

  it('a company that named its own "Work trade labor" before GAM\'s arrived files under its own', async () => {
    const w = await world('payroll_w2')
    const own = (await db.query<{ id: string }>(
      `INSERT INTO books_categories (landlord_id, direction, name) VALUES ($1, 'expense', 'Work Trade Labor') RETURNING id`,
      [w.landlordId])).rows[0].id
    const x = await hours(w)
    expect((await markPaid(w, x, { paidOn: '2026-10-05', paidHow: 'cash' })).status).toBe(200)
    const e = (await db.query(`SELECT category_id FROM landlord_expenses WHERE id = $1`, [(await record(x)).books_reference_id])).rows[0]
    expect(e.category_id).toBe(own)
  })

  it('GAM\'s starting categories carry Work trade labor (the seed and the shared list agree)', async () => {
    const w = await world('payroll_w2')
    await db.query(`SELECT books_seed_categories($1)`, [w.landlordId])
    const keys = (await db.query<{ k: string }>(
      `SELECT system_key AS k FROM books_categories WHERE landlord_id = $1 AND direction = 'expense' AND system_key IS NOT NULL`,
      [w.landlordId])).rows.map(r => r.k).sort()
    expect(keys).toEqual(BOOKS_DEFAULT_EXPENSE_CATEGORIES.map(c => c.key).sort())
    expect(BOOKS_DEFAULT_EXPENSE_CATEGORIES.find(c => c.key === 'work_trade_labor')).toMatchObject({ name: 'Work trade labor', role: 'work_trade_labor' })
  })
})

describe('the Work Trade page says what the books say', () => {
  it('removing the expense puts the hours back to owed; paying again records a new one', async () => {
    const w = await world('payroll_w2')
    const x = await hours(w)
    await markPaid(w, x, { paidOn: '2026-10-05', paidHow: 'check', note: 'check #1042' })
    const first = (await record(x)).books_reference_id
    // Its payment is never taken back alone; its amount and day are the hours'.
    const [p] = await paymentsOf(first)
    const takeBack = await request(app()).post(`/api/expenses/${first}/payments/${p.id}/void`).set(as(w.ownerToken)).send({})
    expect(takeBack.status).toBe(409)
    expect(takeBack.body.error).toMatch(/remove this expense/)
    const edit = await request(app()).patch(`/api/expenses/${first}`).set(as(w.ownerToken)).send({ amount: 50 })
    expect(edit.status).toBe(409)
    expect(edit.body.error).toMatch(/Work Trade page/)
    expect((await request(app()).patch(`/api/expenses/${first}`).set(as(w.ownerToken)).send({ description: 'Wanda, September' })).status).toBe(200)

    const removed = await request(app()).post(`/api/expenses/${first}/void`).set(as(w.ownerToken)).send({})
    expect(removed.status, JSON.stringify(removed.body)).toBe(200)
    expect(await record(x)).toMatchObject({ status: 'unpaid', paid_how: null, paid_on: null, stamped: false })
    const owed = await request(app()).get('/api/work-trade/extra-hours').set(as(w.ownerToken))
    expect(owed.body.data.map((r: any) => r.id)).toEqual([x])

    expect((await markPaid(w, x, { paidOn: '2026-10-06', paidHow: 'cash' })).status).toBe(200)
    const second = (await record(x)).books_reference_id
    expect(second).not.toBe(first)
    expect((await expenseOf(first)).status).toBe('voided')
    expect(await expenseOf(second)).toMatchObject({ status: 'active', day: '2026-10-06', amount: 90 })
  })

  it('hours sent to GAM Books and then paid by hand go back to waiting for Books when the expense is removed', async () => {
    const w = await world('contractor_1099')
    const x = await hours(w)
    expect((await request(app()).post(`/api/work-trade/extra-hours/${x}/send-to-books`).set(as(w.ownerToken)).send({})).status).toBe(200)
    expect((await markPaid(w, x, { paidOn: '2026-10-05', paidHow: 'cash' })).status).toBe(200)
    const e = (await record(x)).books_reference_id
    expect((await request(app()).post(`/api/expenses/${e}/void`).set(as(w.ownerToken)).send({})).status).toBe(200)
    expect(await record(x)).toMatchObject({ status: 'sent_to_books', paid_how: null, stamped: false })
  })

  it('a second record of the same month already owed: removing the expense is refused, in words, and nothing changes', async () => {
    const w = await world('payroll_w2')
    const x = await hours(w)
    await markPaid(w, x, { paidOn: '2026-10-05', paidHow: 'cash' })
    const e = (await record(x)).books_reference_id
    await hours(w)   // more hours of September, owed again
    const r = await request(app()).post(`/api/expenses/${e}/void`).set(as(w.ownerToken)).send({})
    expect(r.status).toBe(409)
    expect(r.body.error).toMatch(/same month/)
    expect((await expenseOf(e)).status).toBe('active')
    expect((await record(x)).status).toBe('paid')
  })

  it('paid once is paid: a second Mark paid makes no second expense', async () => {
    const w = await world('payroll_w2')
    const x = await hours(w)
    expect((await markPaid(w, x, { paidOn: '2026-10-05', paidHow: 'cash' })).status).toBe(200)
    expect((await markPaid(w, x, { paidOn: '2026-10-05', paidHow: 'cash' })).status).toBe(409)
    expect((await db.query(`SELECT count(*)::int AS n FROM landlord_expenses WHERE work_trade_extra_hours_id = $1`, [x])).rows[0].n).toBe(1)
  })
})

// 10/14 (Nic): "Work Trade 'Mark paid': ask where it goes every time (split,
// property or unit), like other expenses." Nothing is chosen for the person.
describe('Mark paid asks where the cost goes, every time (10/14, Nic)', () => {
  const bare = (w: World, id: string, body: object) =>
    request(app()).post(`/api/work-trade/extra-hours/${id}/mark-paid`).set(as(w.ownerToken)).send(body)

  it('no place: refused in words, and nothing is paid or recorded', async () => {
    const w = await world('payroll_w2')
    const x = await hours(w)
    const r = await bare(w, x, { paidOn: '2026-10-05', paidHow: 'check' })
    expect([r.status, r.body.error]).toEqual([400,
      'Choose where the cost of these extra hours goes: one unit, one property, or split across your properties by units.'])
    expect(await record(x)).toMatchObject({ status: 'unpaid', books_reference_id: null })
    expect((await db.query(`SELECT 1 FROM landlord_expenses WHERE work_trade_extra_hours_id = $1`, [x])).rows).toEqual([])
  })

  it('one unit, or split across the properties by units — the expense goes where the person said', async () => {
    const w = await world('payroll_w2')
    const sept = await hours(w, '2026-09-01')
    const oct = await hours(w, '2026-10-01')
    expect((await bare(w, sept, { paidOn: '2026-10-05', paidHow: 'cash', costPlace: 'unit', unitId: w.unitId })).status).toBe(200)
    expect((await bare(w, oct, { paidOn: '2026-10-10', paidHow: 'cash', costPlace: 'split_by_units' })).status).toBe(200)
    const placed = async (x: string) => (await db.query(
      `SELECT e.cost_place, e.property_id, e.unit_id, e.is_common FROM landlord_expenses e
        JOIN work_trade_extra_hours h ON h.books_reference_id = e.id WHERE h.id = $1`, [x])).rows[0]
    expect(await placed(sept)).toEqual({ cost_place: 'unit', property_id: w.propertyId, unit_id: w.unitId, is_common: false })
    expect(await placed(oct)).toEqual({ cost_place: 'split_by_units', property_id: null, unit_id: null, is_common: false })
  })

  it('another company\'s property is refused; the form reads only the paying company\'s places', async () => {
    const w = await world('contractor_1099')
    const x = await hours(w)
    const other = await ledgerCompany()
    const r = await bare(w, x, { paidOn: '2026-10-05', paidHow: 'cash', costPlace: 'property', propertyId: other.propertyId })
    expect([r.status, r.body.error]).toEqual([404, 'That property is not this company\'s.'])
    expect((await record(x)).status).toBe('unpaid')
    const places = await request(app()).get(`/api/work-trade/extra-hours/${x}/cost-places`).set(as(w.ownerToken))
    expect(places.status).toBe(200)
    expect(places.body.data.properties.map((p: any) => p.id)).toContain(w.propertyId)
    expect(places.body.data.properties.map((p: any) => p.id)).not.toContain(other.propertyId)
  })
})
