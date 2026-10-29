/**
 * 10/12 (Nic) — GAM Books, phase P7: what a payroll run leaves owed, and
 * work-trade extra hours paid as a contractor, are money out on ONE record —
 * the Expenses record (Nic 10/12, L5; gam-ledger-design-2026-10-12 §6 J3, I6).
 *
 * Payroll's side of the contract with the Expenses record (phase P6:
 * createMoneyOutExpense, voidLandlordExpense, the expense's payments): the
 * unpaid expenses a run leaves, the links it keeps (payroll_run_expenses,
 * books_reference_id), when a run may still be voided, and a work trader's
 * contractor bill paying their extra hours.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { randomUUID } from 'crypto'
import { db } from '../db'
import { booksRouter } from './books'
import { workTradeRouter } from './workTrade'
import { errorHandler } from '../middleware/errorHandler'
import { cleanupAllSchema, seedLandlord, seedTenant, seedProperty, seedUnit, seedLease } from '../test/dbHelpers'
import { inTx } from '../test/ledgerFixtures'
import { payrollLiabilityRolesOfExpenses, createPayrollMoneyOut } from '../services/payrollMoneyOut'
import { WORK_TRADE_EXTRA_PAID_HOW_RECORDED } from '@gam/shared'
import { CONTRACTOR_BILL_NO_PLACE } from '../services/workTradeBooksPay'
import { listLandlordExpenses, updateLandlordExpense } from '../services/landlordExpenses'

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_books_p7_moneyout'
const app = express()
app.use(express.json())
app.use('/api/books', booksRouter)
app.use('/api/work-trade', workTradeRouter)
app.use(errorHandler)

interface Co { landlordId: string; ownerUserId: string; tenantId: string; unitId: string; propertyId: string; token: string }
async function company(): Promise<Co> {
  return inTx(async c => {
    const { userId, landlordId } = await seedLandlord(c)
    const tenantId = await seedTenant(c)
    const propertyId = await seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: userId })
    const unitId = await seedUnit(c, { propertyId, landlordId })
    await seedLease(c, { unitId, landlordId })
    const token = jwt.sign({ userId, role: 'landlord', email: 'o@t.dev', profileId: null, landlordIds: [landlordId], permissions: {} },
      process.env.JWT_SECRET!, { expiresIn: '1h' })
    return { landlordId, ownerUserId: userId, tenantId, unitId, propertyId, token }
  })
}
const post = (co: Co, url: string, body: object = {}) =>
  request(app).post(`/api/books${url}`).set('Authorization', `Bearer ${co.token}`).send(body)
const get = (co: Co, url: string) => request(app).get(`/api/books${url}`).set('Authorization', `Bearer ${co.token}`)

beforeEach(async () => {
  await cleanupAllSchema()
})
afterAll(async () => { await cleanupAllSchema() })

async function employee(co: Co, first: string, rate: number): Promise<string> {
  const r = await db.query<{ id: string }>(
    // 10/14 (Nic): each employee says where their pay goes (here: company level).
    `INSERT INTO books_employees (landlord_id, first_name, last_name, pay_type, pay_rate, pay_frequency, filing_status,
                                  state_withholding_pct, status, pay_place)
     VALUES ($1, $2, 'Worker', 'salary', $3, 'biweekly', 'single', 0, 'active', 'company') RETURNING id`, [co.landlordId, first, rate])
  return r.rows[0].id
}

async function approved(co: Co, body: object): Promise<string> {
  const calc = await post(co, '/payroll/runs', { periodStart: '2026-03-01', periodEnd: '2026-03-14', payDate: '2026-03-20', payFrequency: 'biweekly',
    ...body })
  expect(calc.status, JSON.stringify(calc.body)).toBe(201)
  const ok = await post(co, `/payroll/runs/${calc.body.data.id}/approve`)
  expect(ok.status, JSON.stringify(ok.body)).toBe(200)
  return calc.body.data.id
}

async function links(runId: string) {
  return (await db.query<any>(
    `SELECT x.kind, x.liability_role, x.payroll_run_line_id, x.expense_id, e.amount::float AS amount,
            c.system_key AS category, e.due_date::text AS due_date, e.status, e.expense_date::text AS expense_date,
            e.created_by,
            NOT EXISTS (SELECT 1 FROM landlord_expense_payments p WHERE p.expense_id = e.id AND p.voided_at IS NULL) AS unpaid
       FROM payroll_run_expenses x JOIN landlord_expenses e ON e.id = x.expense_id
       LEFT JOIN books_categories c ON c.id = e.category_id
      WHERE x.payroll_run_id = $1 ORDER BY x.kind, x.liability_role`, [runId])).rows
}

describe('an approved run leaves its take-home pay and taxes as unpaid expenses (J3, L5)', () => {
  it('one per paycheck and one per liability, each linked to what it clears', async () => {
    const co = await company()
    const a = await employee(co, 'Ann', 52000)   // 2,000
    const b = await employee(co, 'Bo', 26000)    // 1,000
    const runId = await approved(co, { employeeIds: [a, b], taxMap: { [a]: { federal: 150, state: 40, futa: 12, suta: 30 } } })
    const ls = await links(runId)
    expect(ls.filter(l => l.kind === 'payroll_net').map(l => [l.amount, l.category, l.due_date]).sort()).toEqual([
      [2000 - 150 - 40 - 124 - 29, 'payroll_take_home', '2026-03-20'],
      [1000 - 62 - 14.5, 'payroll_take_home', '2026-03-20'],
    ].sort())
    expect(ls.filter(l => l.kind === 'tax_payment').map(l => [l.liability_role, l.amount, l.category, l.due_date])).toEqual([
      ['payroll_federal_withholding', 150, 'payroll_taxes', null],
      ['payroll_fica', (186 + 43.5) * 2, 'payroll_taxes', null],
      ['payroll_futa', 12, 'payroll_taxes', null],
      ['payroll_state_withholding', 40, 'payroll_taxes', null],
      ['payroll_suta', 30, 'payroll_taxes', null],
    ])
    expect(ls.every(l => l.expense_date === '2026-03-20' && l.created_by === co.ownerUserId && l.unpaid)).toBe(true)
    // What the expense's posting reads to clear the right liability.
    const roles = await payrollLiabilityRolesOfExpenses(db as any, ls.map(l => l.expense_id))
    expect(ls.every(l => roles.get(l.expense_id) === l.liability_role)).toBe(true)
    // Approving twice never makes them twice.
    const c = await db.connect()
    try {
      await c.query('BEGIN')
      expect(await createPayrollMoneyOut(c, { runId, landlordId: co.landlordId, createdBy: null })).toEqual({ created: 0 })
      await c.query('COMMIT')
    } finally { c.release() }
    expect((await links(runId)).length).toBe(ls.length)
  })

  it('voiding the run voids what it left — refused while any of it is paid', async () => {
    const co = await company()
    const a = await employee(co, 'Ann', 26000)
    const runId = await approved(co, { employeeIds: [a] })
    const net = (await links(runId)).find(l => l.kind === 'payroll_net')!
    const pay = await db.query<{ id: string }>(
      `INSERT INTO landlord_expense_payments (expense_id, landlord_id, paid_on, amount, method, source, created_by)
       VALUES ($1, $2, '2026-03-20', $3, 'check', 'payment', $4) RETURNING id`, [net.expense_id, co.landlordId, net.amount, co.ownerUserId])
    const refused = await post(co, `/payroll/runs/${runId}/void`)
    expect(refused.status).toBe(409)
    expect(refused.body.error).toMatch(/already been paid/)
    expect((await db.query(`SELECT status FROM payroll_runs WHERE id = $1`, [runId])).rows[0].status).toBe('approved')
    await db.query(`UPDATE landlord_expense_payments SET voided_at = NOW(), voided_by = $2, void_reason = 'test' WHERE id = $1`,
      [pay.rows[0].id, co.ownerUserId])
    const ok = await post(co, `/payroll/runs/${runId}/void`)
    expect(ok.status, JSON.stringify(ok.body)).toBe(200)
    expect((await links(runId)).every(l => l.status === 'voided')).toBe(true)
  })
})

describe('work-trade extra hours sent to GAM Books (I6)', () => {
  it('the database\'s list of how extra hours were paid is the shared list', async () => {
    const r = await db.query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'work_trade_extra_hours_paid_how_check'`)
    const listed = [...r.rows[0].def.matchAll(/'([a-z_]+)'::text/g)].map(m => m[1]).sort()
    expect(listed).toEqual([...WORK_TRADE_EXTRA_PAID_HOW_RECORDED].sort())
  })

  async function extraHours(co: Co, payMethod: 'payroll_w2' | 'contractor_1099'): Promise<string> {
    return inTx(async c => {
      const agreementId = (await c.query<{ id: string }>(
        `INSERT INTO work_trade_agreements
           (unit_id, tenant_id, landlord_id, start_date, status, monthly_hours_target, tracks_hours,
            carry_forward_months, extra_hours_mode, extra_hours_rate, extra_hours_pay_method)
         VALUES ($1,$2,$3,'2026-09-01','active',80,TRUE,3,'pay',15,$4) RETURNING id`,
        [co.unitId, co.tenantId, co.landlordId, payMethod])).rows[0].id
      return (await c.query<{ id: string }>(
        `INSERT INTO work_trade_extra_hours (agreement_id, landlord_id, tenant_id, period_month, period_start, hours, rate, amount,
                                             pay_method, status, sent_to_books_at, sent_to_books_by)
         VALUES ($1, $2, $3, '2026-09-01', '2026-09-01', 6, 15, 90, $4, 'sent_to_books', NOW(), $5) RETURNING id`,
        [agreementId, co.landlordId, co.tenantId, payMethod, co.ownerUserId])).rows[0].id
    })
  }
  async function vendor(co: Co): Promise<string> {
    return (await db.query<{ id: string }>(
      `INSERT INTO books_vendors (landlord_id, name, status) VALUES ($1, $2, 'active') RETURNING id`,
      [co.landlordId, `Pat Trader ${randomUUID().slice(0, 4)}`])).rows[0].id
  }

  it('a contractor payment (1099) becomes an unpaid contractor expense to the vendor, once; voided, it waits again', async () => {
    const co = await company()
    const x = await extraHours(co, 'contractor_1099')
    const v = await vendor(co)
    expect((await get(co, '/work-trade-pay')).body.data.map((r: any) => r.id)).toEqual([x])
    // 10/13 (Nic): "each expense is chosen on the split or specific unit or
    // property at the time of logging" — confirmed with no place, nothing records.
    const noPlace = await post(co, `/work-trade-pay/${x}/contractor-payment`, { vendorId: v })
    expect([noPlace.status, noPlace.body.error]).toEqual([400, CONTRACTOR_BILL_NO_PLACE])
    expect((await get(co, '/work-trade-pay')).body.data.map((r: any) => r.id)).toEqual([x])
    const made = await post(co, `/work-trade-pay/${x}/contractor-payment`, { vendorId: v, costPlace: 'unit', unitId: co.unitId })
    expect(made.status, JSON.stringify(made.body)).toBe(201)
    const e = (await db.query<any>(
      `SELECT c.system_key AS category, e.amount::float AS amount, e.vendor_id, e.work_trade_extra_hours_id, e.cost_place, e.unit_id
         FROM landlord_expenses e LEFT JOIN books_categories c ON c.id = e.category_id WHERE e.id = $1`,
      [made.body.data.expenseId])).rows[0]
    expect([e.category, e.amount, e.vendor_id, e.work_trade_extra_hours_id]).toEqual(['contractor_payments', 90, v, x])
    // Where the person confirming it said it goes.
    expect([e.cost_place, e.unit_id]).toEqual(['unit', co.unitId])
    // 10/13 review: that place is the bill's own — the Expenses form does not
    // ask it again (place_fixed), and its words are still corrected there.
    const listed = (await listLandlordExpenses(co.landlordId)).find((r: any) => r.id === made.body.data.expenseId)
    expect([listed.place_fixed, listed.system_linked]).toEqual([true, false])
    const words = await updateLandlordExpense(made.body.data.expenseId, co.landlordId, { description: 'Pat, September extra hours' })
    expect(words.description).toBe('Pat, September extra hours')
    await expect(updateLandlordExpense(made.body.data.expenseId, co.landlordId, { costPlace: 'split_by_units' }))
      .rejects.toThrow(/pays a work trader's extra hours as a contractor/)
    const rec = (await db.query<any>(`SELECT status, books_reference_id FROM work_trade_extra_hours WHERE id = $1`, [x])).rows[0]
    expect([rec.status, rec.books_reference_id]).toEqual(['sent_to_books', made.body.data.expenseId])
    expect((await get(co, '/work-trade-pay')).body.data).toEqual([])
    expect((await post(co, `/work-trade-pay/${x}/contractor-payment`, { vendorId: v })).status).toBe(409)
    // Marked paid by hand on the Work Trade page too, the same hours would be paid twice.
    const byHand = await request(app).post(`/api/work-trade/extra-hours/${x}/mark-paid`).set('Authorization', `Bearer ${co.token}`)
      .send({ paidOn: '2026-10-01', paidHow: 'check', costPlace: 'split_by_units' })
    expect([byHand.status, byHand.body.error]).toEqual([409, 'These extra hours are a contractor bill in GAM Books. Pay that bill there, or void it first.'])
    // The expense voided on the Expenses page: the hours are waiting for Books again.
    await db.query(`UPDATE landlord_expenses SET status = 'voided', voided_at = NOW() WHERE id = $1`, [made.body.data.expenseId])
    expect((await get(co, '/work-trade-pay')).body.data.map((r: any) => r.id)).toEqual([x])
    expect((await post(co, `/work-trade-pay/${x}/contractor-payment`, { vendorId: v, costPlace: 'property', propertyId: co.propertyId })).status).toBe(201)
  })

  it('paying the contractor bill pays the hours; taking the payment back puts them back to waiting', async () => {
    const co = await company()
    const x = await extraHours(co, 'contractor_1099')
    // No vendor picked: the vendor list's own record of this person, made once.
    const made = await post(co, `/work-trade-pay/${x}/contractor-payment`, { costPlace: 'split_by_units' })
    expect(made.status, JSON.stringify(made.body)).toBe(201)
    const vendorRow = (await db.query<any>(`SELECT tenant_id, vendor_type, is_1099 FROM books_vendors WHERE id = $1`, [made.body.data.vendorId])).rows[0]
    expect(vendorRow).toEqual({ tenant_id: co.tenantId, vendor_type: 'contractor', is_1099: true })
    const status = async () => (await db.query<any>(`SELECT status, paid_how, paid_on::text AS paid_on FROM work_trade_extra_hours WHERE id = $1`, [x])).rows[0]
    const part = await db.query<{ id: string }>(
      `INSERT INTO landlord_expense_payments (expense_id, landlord_id, paid_on, amount, method, source, created_by)
       VALUES ($1, $2, '2026-10-05', 40, 'check', 'payment', $3) RETURNING id`, [made.body.data.expenseId, co.landlordId, co.ownerUserId])
    expect(await status()).toEqual({ status: 'sent_to_books', paid_how: null, paid_on: null })
    const rest = await db.query<{ id: string }>(
      `INSERT INTO landlord_expense_payments (expense_id, landlord_id, paid_on, amount, method, source, created_by)
       VALUES ($1, $2, '2026-10-06', 50, 'cash', 'payment', $3) RETURNING id`, [made.body.data.expenseId, co.landlordId, co.ownerUserId])
    expect(await status()).toEqual({ status: 'paid', paid_how: 'gam_books', paid_on: '2026-10-06' })
    await db.query(`UPDATE landlord_expense_payments SET voided_at = NOW(), voided_by = $2, void_reason = 'test' WHERE id = $1`,
      [rest.rows[0].id, co.ownerUserId])
    expect(await status()).toEqual({ status: 'sent_to_books', paid_how: null, paid_on: null })
    expect(part.rows[0].id).toBeTruthy()
  })

  it('W-2 hours are refused as a contractor payment; a vendor that is not the company\'s is refused', async () => {
    const co = await company()
    const other = await company()
    const w2 = await extraHours(co, 'payroll_w2')
    const r1 = await post(co, `/work-trade-pay/${w2}/contractor-payment`, { vendorId: await vendor(co) })
    expect([r1.status, r1.body.error]).toEqual([409, 'These extra hours were sent as payroll (W-2). Put them on a payroll run.'])
    const x = await extraHours(co, 'contractor_1099')
    const r2 = await post(co, `/work-trade-pay/${x}/contractor-payment`, { vendorId: await vendor(other) })
    expect(r2.status).toBe(404)
    const r3 = await post(other, `/work-trade-pay/${x}/contractor-payment`, { vendorId: await vendor(other) })
    expect(r3.status).toBe(404)
  })

  it('W-2 hours go on a payroll run as their own paycheck; approving pays them in GAM Books, voiding puts them back', async () => {
    const co = await company()
    const x = await extraHours(co, 'payroll_w2')
    const emp = await employee(co, 'Pat', 26000)
    const runId = await approved(co, { employeeIds: [], extraHours: [{ id: x, employeeId: emp, federal: 5 }] })
    const line = (await db.query<any>(`SELECT gross_pay::float AS gross, federal_tax::float AS fed, work_trade_extra_hours_id FROM payroll_run_lines WHERE run_id = $1`, [runId])).rows
    expect(line).toEqual([{ gross: 90, fed: 5, work_trade_extra_hours_id: x }])
    const paid = (await db.query<any>(`SELECT status, paid_how, books_reference_id, paid_on::text AS paid_on FROM work_trade_extra_hours WHERE id = $1`, [x])).rows[0]
    expect(paid).toEqual({ status: 'paid', paid_how: 'gam_books', books_reference_id: runId, paid_on: '2026-03-20' })
    expect((await db.query(`SELECT tenant_id FROM books_employees WHERE id = $1`, [emp])).rows[0].tenant_id).toBe(co.tenantId)
    expect((await post(co, `/payroll/runs/${runId}/void`)).status).toBe(200)
    const back = (await db.query<any>(`SELECT status, paid_how, books_reference_id FROM work_trade_extra_hours WHERE id = $1`, [x])).rows[0]
    expect(back).toEqual({ status: 'sent_to_books', paid_how: null, books_reference_id: null })
  })
})
