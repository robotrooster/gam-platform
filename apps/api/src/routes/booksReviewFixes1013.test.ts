/**
 * 10/12 (Nic) — GAM Books ledger: the review of the reports (P8), the close
 * and reconciliation (P9) and the fixes lane, fixed — through the routes the
 * pages call (gam-ledger-design-2026-10-12 §10, §11, §13).
 *
 *   Nic, 10/12: bookkeepers do "Full bookkeeping … One level" (decision 2);
 *   BK1 / BK2 / BK3 decide what of the company a bookkeeper reads.
 *
 * Real tables, real capture triggers, the real engine with the production
 * projector set (it commits on its own connections, so every test starts from
 * a clean database).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { randomUUID } from 'crypto'
import { db } from '../db'
import { booksRouter } from './books'
import { reportsRouter } from './reports'
import { expensesRouter } from './expenses'
import { workTradeRouter } from './workTrade'
import { bankReconciliationRouter } from './bankReconciliation'
import { booksCloseRouter, booksReconcileRouter } from './booksClose'
import { errorHandler } from '../middleware/errorHandler'
import { tenantCo, bill, receipt, drain, addLease, cleanupTenantLedger, type TenantCo } from '../test/ledgerTenantFixtures'
import { inTx } from '../test/ledgerFixtures'
import { seedTenant } from '../test/dbHelpers'
import { registerProductionLedgerProjectors, unregisterProductionLedgerProjectors } from '../services/ledgerProjectors'
import { markLedgerLive } from '../test/ledgerReportFixtures'
import { createLandlordExpense } from '../services/landlordExpenses'
import { categorizeTransaction } from '../services/bankFeed'

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/books/close', booksCloseRouter)
  app.use('/api/books/reconcile', booksReconcileRouter)
  app.use('/api/books', booksRouter)
  app.use('/api/reports', reportsRouter)
  app.use('/api/expenses', expensesRouter)
  app.use('/api/work-trade', workTradeRouter)
  app.use('/api/bank-reconciliations', bankReconciliationRouter)
  app.use(errorHandler)
  return app
}
const app = buildApp()
const sign = (p: object) => jwt.sign(p, process.env.JWT_SECRET!, { expiresIn: '1h' })
const bearer = (tok: string, client?: string) => ({ Authorization: `Bearer ${tok}`, ...(client ? { 'X-Client-Id': client } : {}) })

beforeEach(async () => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_books_review_fixes_1013'
  await cleanupTenantLedger()
  registerProductionLedgerProjectors()
})
afterEach(() => unregisterProductionLedgerProjectors())

interface World extends TenantCo { ownerTok: string }

/** $1,000 rent on property 1 (paid $400 cash), $300 rent on property 2 (unpaid), October. */
async function world(): Promise<World> {
  const co = await tenantCo()
  const rent = await bill(co, { amount: 1000, due: '2026-10-01' })
  await receipt(co, { method: 'cash', settledAt: '2026-10-03T17:00:00Z', apps: [{ paymentId: rent, amount: 400 }], settleRows: false })
  const second = await addLease(co)
  await bill(co, { amount: 300, due: '2026-10-01', unitId: second.unitId, leaseId: second.leaseId })
  await drain()
  return {
    ...co,
    ownerTok: sign({ userId: co.ownerUserId, role: 'landlord', email: 'o@t.dev', profileId: null, landlordIds: [co.landlordId], permissions: {} }),
  }
}

async function bookkeeper(w: TenantCo, propertyIds: string[], b: { companyWide?: boolean; ledger?: boolean; wholeReports?: boolean } = {}): Promise<{ id: string; scopeId: string; tok: string }> {
  const id = (await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
     VALUES ($1, 'x', 'bookkeeper', 'Bo', 'Keeper', TRUE) RETURNING id`, [`bk-${randomUUID()}@test.dev`])).rows[0].id
  const scopeId = (await db.query<{ id: string }>(
    `INSERT INTO bookkeeper_scopes (user_id, landlord_id, property_ids, company_wide, company_ledger, whole_company_reports, access_level)
     VALUES ($1, $2, $3, $4, $5, $6, 'read_write') RETURNING id`,
    [id, w.landlordId, propertyIds, !!b.companyWide, !!b.ledger, !!b.wholeReports])).rows[0].id
  return { id, scopeId, tok: sign({ userId: id, role: 'bookkeeper', email: 'bk@t.dev', profileId: null, landlordId: w.landlordId, permissions: { access_level: 'read_write' } }) }
}

/** A property manager with "View books", assigned to `propertyIds` (or every property). */
async function manager(w: TenantCo, propertyIds: string[] | 'all'): Promise<string> {
  const uid = (await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, role, first_name, last_name) VALUES ($1, 'x', 'property_manager', 'P', 'M') RETURNING id`,
    [`pm-${randomUUID()}@t.dev`])).rows[0].id
  await db.query(
    `INSERT INTO property_manager_scopes (user_id, landlord_id, property_ids, all_properties) VALUES ($1, $2, $3::uuid[], $4)`,
    [uid, w.landlordId, propertyIds === 'all' ? [] : propertyIds, propertyIds === 'all'])
  return sign({ userId: uid, role: 'property_manager', email: 'pm@t.dev', profileId: null, landlordId: w.landlordId,
                permissions: { 'books.view': true, 'payments.view_all': true } })
}

describe('the whole-company books are refused to a team member assigned to some properties', () => {
  it('the balance sheet is refused in plain words; the chart keeps its stored balances, never the books\'', async () => {
    const w = await world()
    await markLedgerLive(w.landlordId)
    const some = await manager(w, [w.propertyId2])
    const bs = await request(app).get('/api/books/reports/balance-sheet?asOf=2026-10-31').set(bearer(some))
    expect(bs.status).toBe(403)
    expect(bs.body.error).toMatch(/covers the whole company.*Ask the owner/)
    expect(JSON.stringify(bs.body)).not.toMatch(/1300|900/)
    const all = await manager(w, 'all')
    expect((await request(app).get('/api/books/reports/balance-sheet?asOf=2026-10-31').set(bearer(all))).status).toBe(200)

    const chart = await request(app).get('/api/books/accounts').set(bearer(some))
    expect(chart.status).toBe(200)
    expect(chart.body.data.length).toBeGreaterThan(0)
    expect(chart.body.data.some((a: any) => a.balance_source === 'ledger')).toBe(false)
    const ar = (await request(app).get('/api/books/accounts').set(bearer(w.ownerTok))).body.data.find((a: any) => a.code === '1100')
    expect(ar).toMatchObject({ balance_source: 'ledger' })
  })

  it('the tax summary: refused to the assigned manager; a bookkeeper\'s year is their properties\' unless "whole company" (BK2)', async () => {
    const w = await world()
    await markLedgerLive(w.landlordId)
    const some = await manager(w, [w.propertyId2])
    const refused = await request(app).get('/api/books/tax/summary?year=2026').set(bearer(some))
    expect(refused.status).toBe(403)
    expect(refused.body.error).toMatch(/covers the whole company/)

    const own = await bookkeeper(w, [w.propertyId], { ledger: true })
    const mine = await request(app).get('/api/books/tax/summary?year=2026').set(bearer(own.tok, w.landlordId))
    expect(mine.status, JSON.stringify(mine.body)).toBe(200)
    expect(mine.body.data.ledger.income).toEqual({ received: 400, charged: 1000 })
    const whole = await bookkeeper(w, [w.propertyId], { ledger: true, wholeReports: true })
    const all = await request(app).get('/api/books/tax/summary?year=2026').set(bearer(whole.tok, w.landlordId))
    expect(all.body.data.ledger.income).toEqual({ received: 400, charged: 1300 })
    expect((await request(app).get('/api/books/tax/summary?year=2026').set(bearer(w.ownerTok))).body.data.ledger.income.charged).toBe(1300)
  })
})

describe('the Reports overview never mixes the books and the money records for one account', () => {
  it('two companies, only one on the books: every month reads both from the money records', async () => {
    const a = await tenantCo()
    const b = (await db.query<{ id: string }>(
      `INSERT INTO landlords (user_id, billing_starts_at, business_name) VALUES ($1, DATE '2000-01-01', 'Second LLC') RETURNING id`,
      [a.ownerUserId])).rows[0].id
    const rent = await bill(a, { amount: 1000, due: '2026-10-01' })
    await receipt(a, { method: 'cash', settledAt: '2026-10-02T17:00:00Z', apps: [{ paymentId: rent, amount: 1000 }] })
    // An unpaid repair bill: the books count it paid only when paid; the records by its date.
    await createLandlordExpense({ landlordId: a.landlordId, category: 'repairs', amount: 150, expenseDate: '2026-10-04', propertyId: a.propertyId, payment: null })
    await drain()
    await markLedgerLive(a.landlordId)
    const tok = sign({ userId: a.ownerUserId, role: 'landlord', email: 'o@t.dev', profileId: null, landlordIds: [a.landlordId, b], permissions: {} })
    const r = await request(app).get('/api/reports/summary').set(bearer(tok))
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    const oct = r.body.data.monthly.find((m: any) => m.month === '2026-10')
    expect(oct.expenses).toBeGreaterThanOrEqual(150)
    // The money records count one figure for both nets (paid = incurred there).
    expect(oct.netReceived).toBe(Math.round((oct.received - oct.expenses) * 100) / 100)
  })

  it('on the books the year\'s Owed is the balance at its end, never the months added up', async () => {
    const co = await tenantCo()
    await bill(co, { amount: 300, due: '2026-09-01' })
    await bill(co, { amount: 300, due: '2026-10-01' })
    await drain()
    await markLedgerLive(co.landlordId)
    const tok = sign({ userId: co.ownerUserId, role: 'landlord', email: 'o@t.dev', profileId: null, landlordIds: [co.landlordId], permissions: {} })
    const r = await request(app).get('/api/reports/summary').set(bearer(tok))
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    const sep = r.body.data.ytdMonthly.find((m: any) => m.month === '2026-09')
    const oct = r.body.data.ytdMonthly.find((m: any) => m.month === '2026-10')
    expect([sep.owed, oct.owed]).toEqual([300, 600])
    expect(r.body.data.ytd.owed).toBe(600)
  })
})

describe('a bookkeeper who keeps only a sold property\'s history reads it, read only', () => {
  it('cannot make or change the company\'s categories (and is not offered to)', async () => {
    const w = await world()
    const gone = await bookkeeper(w, [])
    await db.query(
      `INSERT INTO bookkeeper_former_properties (bookkeeper_scope_id, property_id, left_at) VALUES ($1, $2, '2026-09-20T19:00:00Z')`,
      [gone.scopeId, w.propertyId2])
    const made = await request(app).post('/api/expenses/categories').set(bearer(gone.tok)).send({ direction: 'expense', name: 'Septic' })
    expect(made.status).toBe(403)
    expect(made.body.error).toBe('That property has left the company. Its books are read only.')
    const list = await request(app).get('/api/expenses/categories?direction=expense').set(bearer(gone.tok))
    expect(list.status, JSON.stringify(list.body)).toBe(200)
    expect(list.body.data).toMatchObject({ canWrite: false, canPointAccounts: false })
    const id = list.body.data.categories[0].id
    expect((await request(app).patch(`/api/expenses/categories/${id}`).set(bearer(gone.tok)).send({ name: 'Renamed' })).status).toBe(403)
    // One who keeps a current property still does (one level).
    const keeps = await bookkeeper(w, [w.propertyId])
    expect((await request(app).post('/api/expenses/categories').set(bearer(keeps.tok)).send({ direction: 'expense', name: 'Septic' })).status).toBe(201)
  })
})

describe('extra work-trade hours paid by hand, then the expense removed', () => {
  it('W-2: the hours name no expense again and go on a payroll run, which approves', async () => {
    const co = await tenantCo()
    const tenantId = await inTx(c => seedTenant(c))
    const agreementId = (await db.query<{ id: string }>(
      `INSERT INTO work_trade_agreements
         (unit_id, tenant_id, landlord_id, start_date, status, monthly_hours_target, tracks_hours,
          carry_forward_months, extra_hours_mode, extra_hours_rate, extra_hours_pay_method)
       VALUES ($1, $2, $3, '2026-09-01', 'active', 80, TRUE, 3, 'pay', 15, 'payroll_w2') RETURNING id`,
      [co.unitId, tenantId, co.landlordId])).rows[0].id
    const x = (await db.query<{ id: string }>(
      `INSERT INTO work_trade_extra_hours (agreement_id, landlord_id, tenant_id, period_month, period_start, hours, rate, amount,
                                           pay_method, status, sent_to_books_at, sent_to_books_by)
       VALUES ($1, $2, $3, '2026-09-01', '2026-09-01', 6, 15, 90, 'payroll_w2', 'sent_to_books', NOW(), $4) RETURNING id`,
      [agreementId, co.landlordId, tenantId, co.ownerUserId])).rows[0].id
    const tok = sign({ userId: co.ownerUserId, role: 'landlord', email: 'o@t.dev', profileId: null, landlordIds: [co.landlordId], permissions: {} })

    const paid = await request(app).post(`/api/work-trade/extra-hours/${x}/mark-paid`).set(bearer(tok)).send({ paidOn: '2026-10-05', paidHow: 'check' })
    expect(paid.status, JSON.stringify(paid.body)).toBe(200)
    const expenseId = paid.body.data.books_reference_id
    expect((await request(app).post(`/api/expenses/${expenseId}/void`).set(bearer(tok)).send({})).status).toBe(200)
    const back = (await db.query(`SELECT status, books_reference_id FROM work_trade_extra_hours WHERE id = $1`, [x])).rows[0]
    expect(back).toEqual({ status: 'sent_to_books', books_reference_id: null })
    // The removed expense still names the hours.
    expect((await db.query(`SELECT work_trade_extra_hours_id FROM landlord_expenses WHERE id = $1`, [expenseId])).rows[0].work_trade_extra_hours_id).toBe(x)

    const emp = (await db.query<{ id: string }>(
      `INSERT INTO books_employees (landlord_id, first_name, last_name, pay_type, pay_rate, pay_frequency, filing_status, state_withholding_pct, status)
       VALUES ($1, 'Wanda', 'Worker', 'salary', 26000, 'biweekly', 'single', 0, 'active') RETURNING id`, [co.landlordId])).rows[0].id
    const run = await request(app).post('/api/books/payroll/runs').set(bearer(tok)).send({
      periodStart: '2026-10-01', periodEnd: '2026-10-14', payDate: '2026-10-20', payFrequency: 'biweekly',
      employeeIds: [], extraHours: [{ id: x, employeeId: emp }],
    })
    expect(run.status, JSON.stringify(run.body)).toBe(201)
    const ok = await request(app).post(`/api/books/payroll/runs/${run.body.data.id}/approve`).set(bearer(tok)).send({})
    expect(ok.status, JSON.stringify(ok.body)).toBe(200)
    expect((await db.query(`SELECT status, paid_how, books_reference_id FROM work_trade_extra_hours WHERE id = $1`, [x])).rows[0])
      .toEqual({ status: 'paid', paid_how: 'gam_books', books_reference_id: run.body.data.id })
  })
})

describe('a statement that let a month close stays while the month is closed', () => {
  it('a statement running 9/11–10/10 closed September: it cannot be undone until September is reopened', async () => {
    const co = await tenantCo()
    await db.query(`UPDATE landlords SET books_company_costs_method = 'company_bucket' WHERE id = $1`, [co.landlordId])
    const connectionId = (await db.query<{ id: string }>(
      `INSERT INTO bank_connections (landlord_id, provider, status, display_name, account_last4) VALUES ($1, 'stripe_fc', 'active', 'Operating', '4321') RETURNING id`,
      [co.landlordId])).rows[0].id
    const owner = bearer(sign({ userId: co.ownerUserId, role: 'landlord', email: 'o@t.dev', profileId: null, landlordIds: [co.landlordId], permissions: {} }), co.landlordId)
    const line = (await db.query<{ id: string }>(
      `INSERT INTO bank_transactions (bank_connection_id, landlord_id, external_id, posted_date, amount, description, normalized_merchant, status, bank_status)
       VALUES ($1, $2, $3, '2026-09-04', 500, 'LAUNDRY CO', 'LAUNDRY CO', 'needs_review', 'posted') RETURNING id`,
      [connectionId, co.landlordId, randomUUID()])).rows[0].id
    await categorizeTransaction(co.landlordId, line, { category: 'laundry', scopeKind: 'property_common', propertyId: co.propertyId })
    expect(await drain()).toMatchObject({ failed: 0 })

    const accounts = (await request(app).get('/api/books/reconcile/accounts').set(owner)).body.data
    const acct = accounts.find((x: any) => x.bankConnectionId === connectionId)
    const finish = async (statementDate: string, statementBalance: number) => {
      const start = await request(app).post(`/api/books/reconcile/accounts/${acct.accountId}/start`).set(owner).send({ statementDate, statementBalance })
      expect(start.status, JSON.stringify(start.body)).toBe(200)
      const ws = start.body.data
      const done = await request(app).post(`/api/books/reconcile/${ws.reconciliation.id}/finish`).set(owner)
      expect(done.status, JSON.stringify(done.body)).toBe(200)
      return ws.reconciliation.id as string
    }
    await finish('2026-09-10', 500)
    const late = await finish('2026-10-10', 500)
    const closed = await request(app).post('/api/books/close').set(owner).send({ through: '2026-09-30' })
    expect(closed.status, JSON.stringify(closed.body)).toBe(200)
    const undo = await request(app).post(`/api/books/reconcile/${late}/undo`).set(owner).send({ reason: 'Bank corrected it' })
    expect(undo.status).toBe(409)
    expect(undo.body.error).toMatch(/closed through 2026-09-30. Reopen that month/)
    // Reopened, it can.
    expect((await request(app).post('/api/books/close/reopen').set(owner).send({ month: '2026-09-01', reason: 'Statement corrected' })).status).toBe(200)
    expect((await request(app).post(`/api/books/reconcile/${late}/undo`).set(owner).send({ reason: 'Bank corrected it' })).status).toBe(200)
  })

  it('the assistant\'s door names the bank account the way people say it', async () => {
    const co = await tenantCo()
    await db.query(`UPDATE landlords SET books_company_costs_method = 'company_bucket' WHERE id = $1`, [co.landlordId])
    const banks = (await db.query<{ id: string }>(
      `INSERT INTO bank_connections (landlord_id, provider, status, display_name, account_last4) VALUES ($1, 'stripe_fc', 'active', 'PNC Bank', '9677'),
                                                                                                       ($1, 'stripe_fc', 'active', 'Wells Fargo', '8739')
       RETURNING id`, [co.landlordId])).rows.map(r => r.id)
    // Each bank is on the books once something was paid from it.
    for (const bankConnectionId of banks) {
      await createLandlordExpense({ landlordId: co.landlordId, category: 'supplies', amount: 10, expenseDate: '2026-09-10', propertyId: co.propertyId,
        payment: { method: 'bank', bankConnectionId } })
    }
    expect(await drain()).toMatchObject({ failed: 0 })
    const tok = bearer(sign({ userId: co.ownerUserId, role: 'landlord', email: 'o@t.dev', profileId: null, landlordIds: [co.landlordId], permissions: {} }))
    // Two banks and none named: it asks which, in words.
    const which = await request(app).post('/api/bank-reconciliations').set(tok).send({ periodEnd: '2026-09-30', statementBalance: 0 })
    expect([400, 409]).toContain(which.status)
    const started = await request(app).post('/api/bank-reconciliations').set(tok).send({ periodEnd: '2026-09-30', statementBalance: 0, accountId: 'PNC ••9677' })
    expect(started.status, JSON.stringify(started.body)).toBe(200)
    expect(started.body.data.account.name).toMatch(/PNC Bank/)
  })
})
