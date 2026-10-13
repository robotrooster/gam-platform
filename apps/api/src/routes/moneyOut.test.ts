/**
 * 10/12 (Nic) — GAM Books, phase P6: money out is one record, through the routes.
 *
 *   L5  "those all sound like real expenses. just let bookkeeper/landlord
 *        create custom labels or categories to charge things off to."
 *   L6  a repair closed with a cost → landlord's choice (auto unpaid bill vs a
 *       'Record as bill' button); cash that never touched the bank is logged
 *       by hand and never has to match a bank line.
 *   L19 bookkeepers filing money coming in → landlord's choice per bookkeeper
 *       (file anything / only after 'Not rent' / never); money out stays open.
 */
import { randomUUID } from 'crypto'
import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { db } from '../db'
import { errorHandler } from '../middleware/errorHandler'
import { expensesRouter } from './expenses'
import { bankFeedRouter } from './bankFeed'
import { booksSettingsRouter } from './booksSettings'
import { maintenanceRouter } from './maintenance'
import { scopesRouter } from './scopes'
import { landlordExpensesTotal } from '../services/landlordExpenses'
import { landlordPLExpenses as plExpenses } from '../services/landlordPL'
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit } from '../test/dbHelpers'

const SECRET = 'test_jwt_secret_money_out'
function app() {
  const a = express()
  a.use(express.json())
  a.use('/api/expenses', expensesRouter)
  a.use('/api/bank-feed', bankFeedRouter)
  a.use('/api/books/setup', booksSettingsRouter)
  a.use('/api/maintenance', maintenanceRouter)
  a.use('/api/scopes', scopesRouter)
  a.use(errorHandler)
  return a
}

interface Co {
  landlordId: string; ownerId: string; owner: string; propertyId: string; unitId: string; connectionId: string
  bkId: string; bk: string
}

const sign = (p: object) => jwt.sign(p, SECRET, { expiresIn: '1h' })

/** A company with a property, a unit, a linked bank; the owner, and a company-wide bookkeeper with write access. */
async function company(o: { moneyIn?: 'any' | 'after_not_rent' | 'never' } = {}): Promise<Co> {
  process.env.JWT_SECRET = SECRET
  const c = await db.connect()
  try {
    const { userId: ownerId, landlordId } = await seedLandlord(c)
    const propertyId = await seedProperty(c, { landlordId, ownerUserId: ownerId, managedByUserId: ownerId })
    const unitId = await seedUnit(c, { propertyId, landlordId })
    const connectionId = (await c.query<{ id: string }>(
      `INSERT INTO bank_connections (landlord_id, provider, status, display_name) VALUES ($1, 'stripe_fc', 'active', 'Operating') RETURNING id`,
      [landlordId])).rows[0].id
    const bkId = (await c.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
       VALUES ($1, 'x', 'bookkeeper', 'Bea', 'Keeper', TRUE) RETURNING id`, [`bk-${randomUUID()}@test.dev`])).rows[0].id
    await c.query(
      `INSERT INTO bookkeeper_scopes (user_id, landlord_id, access_level, property_ids, company_wide, money_in_filing)
       VALUES ($1, $2, 'read_write', $3, TRUE, $4)`, [bkId, landlordId, [propertyId], o.moneyIn ?? 'after_not_rent'])
    return {
      landlordId, ownerId, propertyId, unitId, connectionId, bkId,
      owner: sign({ userId: ownerId, role: 'landlord', email: 'o@t.dev', profileId: landlordId, landlordIds: [landlordId], permissions: {} }),
      bk: sign({ userId: bkId, role: 'bookkeeper', email: 'bk@t.dev', profileId: null, landlordId, permissions: { access_level: 'read_write' } }),
    }
  } finally { c.release() }
}

async function line(co: Co, amount: number, day = '2026-10-05'): Promise<string> {
  return (await db.query<{ id: string }>(
    `INSERT INTO bank_transactions (bank_connection_id, landlord_id, external_id, posted_date, amount, description, normalized_merchant, status, bank_status)
     VALUES ($1, $2, $3, $4, $5, 'MOBILE DEPOSIT', 'MOBILE DEPOSIT', 'needs_review', 'posted') RETURNING id`,
    [co.connectionId, co.landlordId, randomUUID(), day, amount.toFixed(2)])).rows[0].id
}

const as = (tok: string) => ({ Authorization: `Bearer ${tok}` })

beforeEach(async () => { await cleanupAllSchema() })

describe('L5: the company\'s own categories', () => {
  it('the owner lists GAM\'s starting categories, makes one, renames and archives it; a bookkeeper makes one too but points none at an account without the ledger', async () => {
    const co = await company()
    const list = await request(app()).get('/api/expenses/categories?direction=expense').set(as(co.owner))
    expect(list.status).toBe(200)
    const keys = list.body.data.categories.map((c: any) => c.systemKey)
    expect(keys).toEqual(expect.arrayContaining(['repairs', 'utilities', 'owner_draw', 'payroll_take_home']))
    expect(list.body.data.categories.find((c: any) => c.systemKey === 'owner_draw')).toMatchObject({ onProfitAndLoss: false })
    const made = await request(app()).post('/api/expenses/categories').set(as(co.owner)).send({ direction: 'expense', name: 'Septic pumping' })
    expect(made.status).toBe(201)
    expect((await request(app()).patch(`/api/expenses/categories/${made.body.data.id}`).set(as(co.owner)).send({ name: 'Septic' })).status).toBe(200)
    expect((await request(app()).patch(`/api/expenses/categories/${made.body.data.id}`).set(as(co.owner)).send({ archived: true })).status).toBe(200)
    const archived = await request(app()).get('/api/expenses/categories?archived=true').set(as(co.owner))
    expect(archived.body.data.categories.find((c: any) => c.id === made.body.data.id)).toMatchObject({ name: 'Septic', archived: true })
    // A bookkeeper makes categories ("bookkeeper/landlord create custom labels")…
    const bkMade = await request(app()).post('/api/expenses/categories').set(as(co.bk)).send({ direction: 'income', name: 'Firewood sales' })
    expect(bkMade.status).toBe(201)
    // …and the company-wide box carries the ledger, so pointing one is theirs too.
    const acct = (await db.query<{ id: string }>(
      `INSERT INTO books_accounts (landlord_id, code, name, type) VALUES ($1, '4055', 'Firewood', 'income') RETURNING id`, [co.landlordId])).rows[0].id
    expect((await request(app()).patch(`/api/expenses/categories/${bkMade.body.data.id}`).set(as(co.bk)).send({ accountId: acct })).status).toBe(200)
    // A bookkeeper without the ledger may not point one.
    await db.query(`UPDATE bookkeeper_scopes SET company_wide = FALSE, company_ledger = FALSE WHERE user_id = $1`, [co.bkId])
    const refused = await request(app()).patch(`/api/expenses/categories/${bkMade.body.data.id}`).set(as(co.bk)).send({ accountId: acct })
    expect(refused.status).toBe(403)
  })
})

describe('L5: bills and payments on the Expenses record', () => {
  it('a bill (unpaid, due date, bill number) is listed open; paid in part by check, then in full in cash, it is paid; a payment taken back reopens it', async () => {
    const co = await company()
    const made = await request(app()).post('/api/expenses').set(as(co.owner)).send({
      propertyId: co.propertyId, category: 'utilities', amount: 240, expenseDate: '2026-10-01', dueDate: '2026-10-21',
      billNumber: 'APS-1001', unpaid: true,
    })
    expect(made.status).toBe(200)
    const id = made.body.data.id
    let open = await request(app()).get('/api/expenses?state=open').set(as(co.owner))
    expect(open.body.data.map((r: any) => [r.id, r.pay_state, r.unpaid, r.due_date, r.bill_number, r.category_name]))
      .toEqual([[id, 'unpaid', 240, '2026-10-21', 'APS-1001', 'Utilities']])
    expect((await request(app()).post(`/api/expenses/${id}/payments`).set(as(co.owner)).send({ method: 'check', amount: 40, paidOn: '2026-10-08' })).status).toBe(201)
    open = await request(app()).get('/api/expenses?state=open').set(as(co.owner))
    expect(open.body.data[0]).toMatchObject({ pay_state: 'partial', paid: 40, unpaid: 200 })
    // A bookkeeper pays the rest (money going out is open to them).
    const cash = await request(app()).post(`/api/expenses/${id}/payments`).set(as(co.bk)).send({ method: 'cash' })
    expect(cash.status).toBe(201)
    expect((await request(app()).get('/api/expenses?state=open').set(as(co.owner))).body.data).toEqual([])
    const paid = await request(app()).get('/api/expenses?state=paid').set(as(co.owner))
    expect(paid.body.data[0]).toMatchObject({ id, pay_state: 'paid', paid: 240 })
    // "Paid how" never includes the to-classify method by hand.
    expect((await request(app()).post(`/api/expenses/${id}/payments`).set(as(co.owner)).send({ method: 'other' })).status).toBe(400)
    const back = await request(app()).post(`/api/expenses/${id}/payments/${cash.body.data.id}/void`).set(as(co.owner)).send({ reason: 'entered twice' })
    expect(back.status).toBe(200)
    expect((await request(app()).get('/api/expenses?state=open').set(as(co.owner))).body.data[0]).toMatchObject({ unpaid: 200 })
  })

  it('cash logged by hand is paid the day it was logged and never waits on a bank line; an owner draw is never in the P&L', async () => {
    const co = await company()
    const cash = await request(app()).post('/api/expenses').set(as(co.owner)).send({
      propertyId: co.propertyId, category: 'supplies', amount: 18.75, expenseDate: '2026-10-02', paid: { method: 'cash' },
    })
    expect(cash.status).toBe(200)
    const draw = await request(app()).post('/api/expenses').set(as(co.owner)).send({
      category: 'owner_draw', amount: 500, expenseDate: '2026-10-02', paid: { method: 'bank', bankConnectionId: co.connectionId },
    })
    expect(draw.status).toBe(200)
    const rows = (await request(app()).get('/api/expenses').set(as(co.owner))).body.data
    expect(rows.find((r: any) => r.id === cash.body.data.id)).toMatchObject({ pay_state: 'paid', on_profit_and_loss: true })
    expect(rows.find((r: any) => r.id === draw.body.data.id)).toMatchObject({ pay_state: 'paid', on_profit_and_loss: false })
    expect(await landlordExpensesTotal(co.landlordId, '2026-10-01', '2026-10-31')).toBe(18.75)
  })
})

describe('§12: a money-out bank line matches the bill it paid first', () => {
  it('the bill is offered; matched, the line pays it; undone, the bill is owed again', async () => {
    const co = await company()
    const bill = (await request(app()).post('/api/expenses').set(as(co.owner)).send({
      propertyId: co.propertyId, category: 'landscaping', amount: 160, expenseDate: '2026-10-02', unpaid: true,
    })).body.data.id
    const t = await line(co, -160)
    const offered = await request(app()).get(`/api/bank-feed/transactions/${t}/matches`).set(as(co.owner))
    expect(offered.status).toBe(200)
    expect(offered.body.data.expenses[0]).toMatchObject({ expenseId: bill, exact: true, unpaid: 160 })
    const m = await request(app()).post(`/api/bank-feed/transactions/${t}/match-expenses`).set(as(co.bk)).send({ expenseIds: [bill] })
    expect(m.status).toBe(200)
    const listed = (await request(app()).get(`/api/bank-feed/transactions?lineId=${t}`).set(as(co.owner))).body.data[0]
    expect(listed).toMatchObject({ status: 'matched', out_match_kind: 'expenses' })
    expect(listed.out_match_expenses).toHaveLength(1)
    // The Expenses page sends the owner to the Bank page to change it.
    expect((await request(app()).post(`/api/expenses/${bill}/void`).set(as(co.owner))).status).toBe(409)
    const undo = await request(app()).post(`/api/bank-feed/transactions/${t}/undo-filing`).set(as(co.bk)).send({})
    expect(undo.status).toBe(200)
    expect(undo.body.data).toMatchObject({ kind: 'matched', status: 'needs_review' })
    expect((await request(app()).get('/api/expenses?state=open').set(as(co.owner))).body.data[0]).toMatchObject({ id: bill, unpaid: 160 })
  })
})

describe('L19: what a bookkeeper may file of the money coming in is the owner\'s choice', () => {
  it('after "Not rent" (the default): a deposit is refused until the owner marks it; money out is always theirs', async () => {
    const co = await company()
    const out = await line(co, -45)
    expect((await request(app()).post(`/api/bank-feed/transactions/${out}/categorize`).set(as(co.bk))
      .send({ category: 'supplies', scopeKind: 'property_common', propertyId: co.propertyId })).status).toBe(200)
    const dep = await line(co, 120)
    const refused = await request(app()).post(`/api/bank-feed/transactions/${dep}/categorize`).set(as(co.bk))
      .send({ category: 'laundry', scopeKind: 'property_common', propertyId: co.propertyId })
    expect(refused.status).toBe(403)
    expect(refused.body.error).toMatch(/Not rent/)
    expect((await request(app()).post(`/api/bank-feed/transactions/${dep}/ignore`).set(as(co.bk)).send({})).status).toBe(403)
    await db.query(`UPDATE bank_transactions SET auto_settle_undo = jsonb_build_object('notRent', jsonb_build_object('at', now())) WHERE id = $1`, [dep])
    expect((await request(app()).post(`/api/bank-feed/transactions/${dep}/categorize`).set(as(co.bk))
      .send({ category: 'laundry', scopeKind: 'property_common', propertyId: co.propertyId })).status).toBe(200)
  })

  it('never: no deposit at all; any: every deposit; and only the owner changes it', async () => {
    const never = await company({ moneyIn: 'never' })
    const d1 = await line(never, 60)
    await db.query(`UPDATE bank_transactions SET auto_settle_undo = jsonb_build_object('notRent', jsonb_build_object('at', now())) WHERE id = $1`, [d1])
    expect((await request(app()).post(`/api/bank-feed/transactions/${d1}/categorize`).set(as(never.bk))
      .send({ category: 'laundry', scopeKind: 'property_common', propertyId: never.propertyId })).status).toBe(403)
    const any = await company({ moneyIn: 'any' })
    const d2 = await line(any, 60)
    expect((await request(app()).post(`/api/bank-feed/transactions/${d2}/categorize`).set(as(any.bk))
      .send({ category: 'laundry', scopeKind: 'property_common', propertyId: any.propertyId })).status).toBe(200)
    // The owner sets it on the Team page (and it shows there).
    const set = await request(app()).patch(`/api/scopes/bookkeeper/${never.bkId}`).set(as(never.owner)).send({ moneyInFiling: 'any' })
    expect(set.status).toBe(200)
    expect((await db.query(`SELECT money_in_filing FROM bookkeeper_scopes WHERE user_id = $1`, [never.bkId])).rows[0].money_in_filing).toBe('any')
  })
})

describe('L6: a repair closed with a cost', () => {
  async function repair(co: Co): Promise<string> {
    return (await db.query<{ id: string }>(
      `INSERT INTO maintenance_requests (unit_id, landlord_id, title, description, status)
       VALUES ($1, $2, 'Water heater', 'No hot water', 'in_progress') RETURNING id`, [co.unitId, co.landlordId])).rows[0].id
  }

  it('the button: "Record as bill" makes one unpaid bill under Repairs; the P&L counts the cost once', async () => {
    const co = await company()
    const id = await repair(co)
    await db.query(`UPDATE maintenance_requests SET status = 'completed', actual_cost = 410, completed_at = '2026-10-04 18:00:00+00' WHERE id = $1`, [id])
    const before = await plExpenses(co.landlordId, '2026-10-01', '2026-10-31', [])
    expect([before.maintenance, before.enteredExpenses]).toEqual([410, 0])
    const r = await request(app()).post(`/api/expenses/repairs/${id}/bill`).set(as(co.owner)).send({})
    expect(r.status).toBe(201)
    expect((await request(app()).post(`/api/expenses/repairs/${id}/bill`).set(as(co.owner)).send({})).status).toBe(409)
    const bill = (await request(app()).get('/api/expenses?state=open').set(as(co.owner))).body.data[0]
    expect(bill).toMatchObject({ id: r.body.data.expenseId, category: 'repairs', amount: 410, pay_state: 'unpaid', maintenance_request_id: id })
    const after = await plExpenses(co.landlordId, '2026-10-01', '2026-10-31', [])
    expect([after.maintenance, after.enteredExpenses]).toEqual([0, 410])
  })

  it('automatic (the owner\'s Books setting): completing the repair with its cost makes the bill, kept in step while unpaid', async () => {
    const co = await company()
    const s = await request(app()).patch('/api/books/setup/settings').set(as(co.owner)).send({ repairBills: 'automatic' })
    expect(s.status).toBe(200)
    expect(s.body.data.repairBills).toBe('automatic')
    const id = await repair(co)
    const done = await request(app()).patch(`/api/maintenance/${id}`).set(as(co.owner)).send({ status: 'completed', actualCost: 300 })
    expect(done.status).toBe(200)
    let bills = (await request(app()).get('/api/expenses?state=open').set(as(co.owner))).body.data
    expect(bills.map((b: any) => [b.maintenance_request_id, b.amount])).toEqual([[id, 300]])
    await request(app()).patch(`/api/maintenance/${id}`).set(as(co.owner)).send({ actualCost: 325 })
    bills = (await request(app()).get('/api/expenses?state=open').set(as(co.owner))).body.data
    expect(bills.map((b: any) => b.amount)).toEqual([325])
    // A bookkeeper never changes the choice.
    expect((await request(app()).patch('/api/books/setup/settings').set(as(co.bk)).send({ repairBills: 'button' })).status).toBe(403)
  })
})
