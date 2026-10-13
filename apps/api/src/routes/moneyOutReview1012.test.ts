/**
 * 10/12 (Nic) review — GAM Books, phase P6: the fixes from the money-out review.
 *
 *   - a bookkeeper's money-out write (a payment, a category, a repair's bill,
 *     the bank) is judged on THIS company's scope row, live — never the
 *     sign-in pass (10/12, Nic: one level, so the row's read-only box is gone)
 *   - a money-out line that fits a record to the cent is matched first
 *     (409 MATCH_FIRST), filed as a new expense only on "none of these"
 *   - a transfer files the money arriving too, under the owner's L19 choice
 *   - a bank void of a line filed as a new expense voids its payment, and
 *     (10/13, Nic) the expense itself, kept on record as voided
 *   - a bill GAM keeps for something else (a fixed asset here) keeps its
 *     amount and is removed where it came from; archiving a starting category
 *     never stops the bills GAM makes there
 *   - the P&L outside the ledger judges an expense by its category's account
 *     on the expense's own day; Cash Flow counts money out by payment day
 */
import { randomUUID } from 'crypto'
import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { BANK_MATCH_FIRST_CODE } from '@gam/shared'
import { db } from '../db'
import { errorHandler } from '../middleware/errorHandler'
import { expensesRouter } from './expenses'
import { bankFeedRouter } from './bankFeed'
import { createMoneyOutExpense, landlordExpensesTotal } from '../services/landlordExpenses'
import { landlordExpensesPaidOut } from '../services/landlordPL'
import { upsertTransactions } from '../services/bankFeed'
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit } from '../test/dbHelpers'

const SECRET = 'test_jwt_secret_money_out_review'
function app() {
  const a = express()
  a.use(express.json())
  a.use('/api/expenses', expensesRouter)
  a.use('/api/bank-feed', bankFeedRouter)
  a.use(errorHandler)
  return a
}
const sign = (p: object) => jwt.sign(p, SECRET, { expiresIn: '1h' })
const as = (tok: string) => ({ Authorization: `Bearer ${tok}` })

interface Co {
  landlordId: string; ownerId: string; owner: string; propertyId: string; unitId: string; connectionId: string
  bkId: string; bk: string
}

async function company(o: { access?: 'read_only' | 'read_write'; moneyIn?: 'any' | 'after_not_rent' | 'never'; bkId?: string } = {}): Promise<Co> {
  process.env.JWT_SECRET = SECRET
  const c = await db.connect()
  try {
    const { userId: ownerId, landlordId } = await seedLandlord(c)
    const propertyId = await seedProperty(c, { landlordId, ownerUserId: ownerId, managedByUserId: ownerId })
    const unitId = await seedUnit(c, { propertyId, landlordId })
    const connectionId = (await c.query<{ id: string }>(
      `INSERT INTO bank_connections (landlord_id, provider, status, display_name) VALUES ($1, 'stripe_fc', 'active', 'Operating') RETURNING id`,
      [landlordId])).rows[0].id
    const bkId = o.bkId ?? (await c.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
       VALUES ($1, 'x', 'bookkeeper', 'Bea', 'Keeper', TRUE) RETURNING id`, [`bk-${randomUUID()}@test.dev`])).rows[0].id
    await c.query(
      `INSERT INTO bookkeeper_scopes (user_id, landlord_id, access_level, property_ids, company_wide, money_in_filing)
       VALUES ($1, $2, $3, $4, TRUE, $5)`, [bkId, landlordId, o.access ?? 'read_write', [propertyId], o.moneyIn ?? 'after_not_rent'])
    return {
      landlordId, ownerId, propertyId, unitId, connectionId, bkId,
      owner: sign({ userId: ownerId, role: 'landlord', email: 'o@t.dev', profileId: landlordId, landlordIds: [landlordId], permissions: {} }),
      // The pass claims read-and-write whatever the scope row says (the review's case).
      bk: sign({ userId: bkId, role: 'bookkeeper', email: 'bk@t.dev', profileId: null, landlordId, permissions: { access_level: 'read_write' } }),
    }
  } finally { c.release() }
}

async function line(co: Co, amount: number, day = '2026-10-05', connectionId = co.connectionId): Promise<{ id: string; externalId: string }> {
  const externalId = randomUUID()
  const id = (await db.query<{ id: string }>(
    `INSERT INTO bank_transactions (bank_connection_id, landlord_id, external_id, posted_date, amount, description, normalized_merchant, status, bank_status)
     VALUES ($1, $2, $3, $4, $5, 'ACME SUPPLY', 'ACME SUPPLY', 'needs_review', 'posted') RETURNING id`,
    [connectionId, co.landlordId, externalId, day, amount.toFixed(2)])).rows[0].id
  return { id, externalId }
}

const paidOn = async (expenseId: string) => (await db.query(
  `SELECT paid_on::text AS day, amount::text AS amount, voided_at IS NOT NULL AS voided, source FROM landlord_expense_payments
    WHERE expense_id = $1 ORDER BY created_at, id`, [expenseId])).rows

beforeEach(async () => { await cleanupAllSchema() })

describe('a bookkeeper\'s writes follow THIS company\'s scope row, live — one level (10/12, Nic)', () => {
  // 10/12 (Nic, ledger decision 2): "Full bookkeeping … never tenant-account
  // actions … One level, no per-bookkeeper switch." A row that still says
  // read_only (written before the one level) decides nothing.
  it('a bookkeeper whose row says read_only does the money-out writes and is offered them; the bank files', async () => {
    const co = await company({ access: 'read_only' })
    const bill = await request(app()).post('/api/expenses').set(as(co.owner)).send({
      propertyId: co.propertyId, category: 'utilities', amount: 90, expenseDate: '2026-10-01', unpaid: true })
    expect(bill.status).toBe(200)
    const id = bill.body.data.id
    expect((await request(app()).post('/api/expenses').set(as(co.bk))
      .send({ propertyId: co.propertyId, category: 'supplies', amount: 5, expenseDate: '2026-10-01' })).status).toBe(200)
    const listed = (await request(app()).get('/api/expenses').set(as(co.bk))).body.data.find((e: any) => e.id === id)
    expect(listed).toMatchObject({ can_pay: true, can_edit: true, can_remove: true })   // the owner's bill too: full bookkeeping
    expect((await request(app()).get('/api/expenses/options').set(as(co.bk))).body.data).toMatchObject({ canWrite: true, canPointAccounts: true })
    expect((await request(app()).post(`/api/expenses/${id}/payments`).set(as(co.bk)).send({ method: 'cash' })).status).toBe(201)
    expect((await request(app()).post('/api/expenses/categories').set(as(co.bk)).send({ direction: 'expense', name: 'Septic' })).status).toBe(201)
    // A repair that is not there reads as missing — never refused for the level.
    expect((await request(app()).post(`/api/expenses/repairs/${randomUUID()}/bill`).set(as(co.bk)).send({})).status).toBe(404)
    const t = await line(co, -12)
    const filed = await request(app()).post(`/api/bank-feed/transactions/${t.id}/categorize`).set(as(co.bk))
      .send({ category: 'supplies', scopeKind: 'property_common', propertyId: co.propertyId })
    expect(filed.status).toBe(200)
  })

  it('a bookkeeper never writes the books of a company that does not keep them, whatever the pass says', async () => {
    const a = await company({ access: 'read_write' })
    const b = await company({ bkId: a.bkId })
    // The owner of b removed them: no scope row on b any more.
    await db.query(`DELETE FROM bookkeeper_scopes WHERE user_id = $1 AND landlord_id = $2`, [a.bkId, b.landlordId])
    const t = await line(b, -30)
    const res = await request(app()).post(`/api/bank-feed/transactions/${t.id}/categorize`).set(as(a.bk)).set('X-Client-Id', b.landlordId)
      .send({ category: 'supplies', scopeKind: 'property_common', propertyId: b.propertyId })
    expect(res.status).toBe(403)
    expect(res.body.error).toMatch(/not assigned to that company/)
    expect((await db.query(`SELECT status FROM bank_transactions WHERE id = $1`, [t.id])).rows[0].status).toBe('needs_review')
  })
})

describe('a money-out line is matched first (L5, design §12)', () => {
  it('an open bill for the same amount: filing it as a new expense is refused with the bill named; "none of these" files it', async () => {
    const co = await company()
    const bill = (await request(app()).post('/api/expenses').set(as(co.owner)).send({
      propertyId: co.propertyId, category: 'repairs', amount: 240, expenseDate: '2026-10-01', unpaid: true })).body.data.id
    const t = await line(co, -240, '2026-10-04')
    const body = { category: 'repairs', scopeKind: 'property_common', propertyId: co.propertyId }
    const refused = await request(app()).post(`/api/bank-feed/transactions/${t.id}/categorize`).set(as(co.owner)).send(body)
    expect(refused.status).toBe(409)
    expect(refused.body.code).toBe(BANK_MATCH_FIRST_CODE)
    expect(refused.body.matches).toEqual([expect.objectContaining({ kind: 'expense', id: bill })])
    // A split is matched first too.
    const split = await request(app()).post(`/api/bank-feed/transactions/${t.id}/split`).set(as(co.owner)).send({ parts: [
      { category: 'repairs', amount: 200, scopeKind: 'property_common', propertyId: co.propertyId },
      { category: 'supplies', amount: 40, scopeKind: 'property_common', propertyId: co.propertyId },
    ] })
    expect(split.status).toBe(409)
    expect(split.body.code).toBe(BANK_MATCH_FIRST_CODE)
    const filed = await request(app()).post(`/api/bank-feed/transactions/${t.id}/categorize`).set(as(co.owner)).send({ ...body, notAMatch: true })
    expect(filed.status).toBe(200)
    // Nothing fits a different amount: filed as before.
    const other = await line(co, -17)
    expect((await request(app()).post(`/api/bank-feed/transactions/${other.id}/categorize`).set(as(co.owner)).send(body)).status).toBe(200)
  })
})

describe('L19: a transfer files the money arriving too', () => {
  it('a bookkeeper who never files money coming in is neither offered nor allowed a transfer; the owner is', async () => {
    const co = await company({ moneyIn: 'never' })
    const savings = (await db.query<{ id: string }>(
      `INSERT INTO bank_connections (landlord_id, provider, status, display_name) VALUES ($1, 'stripe_fc', 'active', 'Savings') RETURNING id`,
      [co.landlordId])).rows[0].id
    const out = await line(co, -500, '2026-10-05')
    const arrived = await line(co, 500, '2026-10-06', savings)
    const offered = await request(app()).get(`/api/bank-feed/transactions/${out.id}/matches`).set(as(co.bk))
    expect(offered.status).toBe(200)
    expect(offered.body.data.records.filter((r: any) => r.kind === 'transfer')).toEqual([])
    const refused = await request(app()).post(`/api/bank-feed/transactions/${out.id}/match-record`).set(as(co.bk))
      .send({ kind: 'transfer', recordId: arrived.id })
    expect(refused.status).toBe(403)
    expect((await db.query(`SELECT status FROM bank_transactions WHERE id = $1`, [arrived.id])).rows[0].status).toBe('needs_review')
    const ownerOffered = await request(app()).get(`/api/bank-feed/transactions/${out.id}/matches`).set(as(co.owner))
    expect(ownerOffered.body.data.records).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'transfer', id: arrived.id })]))
    expect((await request(app()).post(`/api/bank-feed/transactions/${out.id}/match-record`).set(as(co.owner))
      .send({ kind: 'transfer', recordId: arrived.id })).status).toBe(200)
    // Undoing it releases the money arriving too — refused to the bookkeeper as well.
    expect((await request(app()).post(`/api/bank-feed/transactions/${out.id}/undo-filing`).set(as(co.bk)).send({})).status).toBe(403)
  })
})

describe('a bank void of a line filed as a new expense (design §12; 10/13, Nic)', () => {
  // 10/13 (Nic): "Bank voids a line filed as a new expense: VOID the expense
  // too (kept on record as voided)."
  const expenseRow = async (id: string) => (await db.query(
    `SELECT status, voided_at IS NOT NULL AS voided, bank_transaction_id FROM landlord_expenses WHERE id = $1`, [id])).rows[0]
  const lineRow = async (id: string) => (await db.query(
    `SELECT status, ignored_reason, bank_status, expense_id, auto_settle_undo FROM bank_transactions WHERE id = $1`, [id])).rows[0]
  // 10/13 review: the owner is told — the line is hidden as the bank's void now.
  const toldOwner = async (co: Co) => (await db.query(
    `SELECT n.user_id = l.user_id AS to_owner, n.title, n.body, n.action_url, n.email_sent
       FROM notifications n JOIN landlords l ON l.id = n.landlord_id
      WHERE n.landlord_id = $1 AND n.type = 'bank_line_voided' ORDER BY n.created_at`, [co.landlordId])).rows

  it('voids the payment the filing made and the expense itself (kept), and sets the line aside as the bank\'s void', async () => {
    const co = await company()
    const t = await line(co, -64, '2026-10-02')
    const filed = await request(app()).post(`/api/bank-feed/transactions/${t.id}/categorize`).set(as(co.owner))
      .send({ category: 'supplies', scopeKind: 'property_common', propertyId: co.propertyId })
    expect(filed.status).toBe(200)
    const expenseId = filed.body.data.expenseId
    expect((await paidOn(expenseId)).map(p => p.voided)).toEqual([false])
    expect(await landlordExpensesTotal(co.landlordId, '2026-10-01', '2026-10-31')).toBe(64)
    await upsertTransactions(co.connectionId, co.landlordId, [{ externalId: t.externalId, postedDate: '2026-10-02', amount: -64, status: 'void' }])
    expect((await paidOn(expenseId)).map(p => p.voided)).toEqual([true])
    // Kept on record, voided, stamped with the line it came from — never deleted.
    expect(await expenseRow(expenseId)).toEqual({ status: 'voided', voided: true, bank_transaction_id: t.id })
    expect(await landlordExpensesTotal(co.landlordId, '2026-10-01', '2026-10-31')).toBe(0)
    const after = await lineRow(t.id)
    expect(after).toMatchObject({ status: 'ignored', ignored_reason: 'bank_void', bank_status: 'void', expense_id: null })
    expect(after.auto_settle_undo.bankVoidedFiling).toMatchObject({ was: 'one_category', expenseIds: [expenseId], by: null })
    // Nothing is owed on it: it is not an open bill.
    expect((await request(app()).get('/api/expenses?state=open').set(as(co.owner))).body.data).toEqual([])
    // The owner is told, once, in the portal's notices (no email).
    expect(await toldOwner(co)).toEqual([{
      to_owner: true, title: 'Your bank voided a transaction you filed as an expense',
      body: 'Your bank voided the $64.00 transaction of Oct 2, 2026 (ACME SUPPLY) — the money never left. The expense you filed it as was voided too; it stays on record as voided.',
      action_url: '/expenses', email_sent: false,
    }])
    // The bank saying it again changes nothing and tells nobody again.
    await upsertTransactions(co.connectionId, co.landlordId, [{ externalId: t.externalId, postedDate: '2026-10-02', amount: -64, status: 'void' }])
    expect(await toldOwner(co)).toHaveLength(1)
  })

  it('a split line: every part is voided (kept), and the line is set aside', async () => {
    const co = await company()
    const t = await line(co, -100, '2026-10-02')
    const split = await request(app()).post(`/api/bank-feed/transactions/${t.id}/split`).set(as(co.owner)).send({ parts: [
      { category: 'supplies', amount: 60, scopeKind: 'property_common', propertyId: co.propertyId },
      { category: 'repairs', amount: 40, scopeKind: 'unit', unitId: co.unitId },
    ] })
    expect(split.status, JSON.stringify(split.body)).toBe(200)
    const parts: string[] = split.body.data.expenseIds
    expect(parts).toHaveLength(2)
    await upsertTransactions(co.connectionId, co.landlordId, [{ externalId: t.externalId, postedDate: '2026-10-02', amount: -100, status: 'void' }])
    for (const id of parts) expect(await expenseRow(id)).toEqual({ status: 'voided', voided: true, bank_transaction_id: t.id })
    const after = await lineRow(t.id)
    expect(after).toMatchObject({ status: 'ignored', ignored_reason: 'bank_void' })
    expect(after.auto_settle_undo.bankVoidedFiling).toMatchObject({ was: 'split' })
    expect([...after.auto_settle_undo.bankVoidedFiling.expenseIds].sort()).toEqual([...parts].sort())
    expect((await toldOwner(co)).map(n => [n.to_owner, n.title, n.body])).toEqual([[true,
      'Your bank voided a transaction you split into expenses',
      'Your bank voided the $100.00 transaction of Oct 2, 2026 (ACME SUPPLY) — the money never left. The 2 expenses you split it into were voided too; they stay on record as voided.']])
  })

  it('an expense another record keeps (it became a fixed asset) is left filed and flagged for the owner, as before', async () => {
    const co = await company()
    const t = await line(co, -4000, '2026-10-02')
    const filed = await request(app()).post(`/api/bank-feed/transactions/${t.id}/categorize`).set(as(co.owner))
      .send({ category: 'supplies', scopeKind: 'property_common', propertyId: co.propertyId })
    const expenseId = filed.body.data.expenseId
    await db.query(
      `INSERT INTO books_fixed_assets (landlord_id, property_id, name, asset_class, cost, salvage_value, acquired_on, in_service_date,
                                       life_years, method, source_expense_id)
       VALUES ($1, $2, 'Mower', 'equipment', 4000, 0, '2026-10-02', '2026-10-02', 5, 'straight_line', $3)`, [co.landlordId, co.propertyId, expenseId])
    await upsertTransactions(co.connectionId, co.landlordId, [{ externalId: t.externalId, postedDate: '2026-10-02', amount: -4000, status: 'void' }])
    expect((await expenseRow(expenseId)).status).toBe('active')
    expect(await lineRow(t.id)).toMatchObject({ status: 'categorized', bank_status: 'void', expense_id: expenseId })
    // Left on the Bank page with its flag: no notice of an expense voided.
    expect(await toldOwner(co)).toEqual([])
  })

  it('money coming in filed as income is not an expense, and stays filed and flagged', async () => {
    const co = await company()
    const t = await line(co, 75, '2026-10-02')
    const filed = await request(app()).post(`/api/bank-feed/transactions/${t.id}/categorize`).set(as(co.owner))
      .send({ category: 'laundry', scopeKind: 'property_common', propertyId: co.propertyId })
    expect(filed.status, JSON.stringify(filed.body)).toBe(200)
    await upsertTransactions(co.connectionId, co.landlordId, [{ externalId: t.externalId, postedDate: '2026-10-02', amount: 75, status: 'void' }])
    expect(await lineRow(t.id)).toMatchObject({ status: 'categorized', bank_status: 'void' })
  })
})

describe('bills GAM keeps for something else', () => {
  it('an expense that became a fixed asset keeps its amount and is not removed here; archiving Repairs never stops a repair\'s bill', async () => {
    const co = await company()
    const e = (await request(app()).post('/api/expenses').set(as(co.owner)).send({
      propertyId: co.propertyId, category: 'supplies', amount: 4000, expenseDate: '2026-10-01' })).body.data.id
    await db.query(
      `INSERT INTO books_fixed_assets (landlord_id, property_id, name, asset_class, cost, salvage_value, acquired_on, in_service_date,
                                       life_years, method, source_expense_id)
       VALUES ($1, $2, 'Mower', 'equipment', 4000, 0, '2026-10-01', '2026-10-01', 5, 'straight_line', $3)`, [co.landlordId, co.propertyId, e])
    const moved = await request(app()).patch(`/api/expenses/${e}`).set(as(co.owner)).send({ amount: 4500 })
    expect(moved.status).toBe(409)
    expect(moved.body.error).toMatch(/fixed asset/)
    expect((await request(app()).patch(`/api/expenses/${e}`).set(as(co.owner)).send({ description: 'Riding mower' })).status).toBe(200)
    const removed = await request(app()).post(`/api/expenses/${e}/void`).set(as(co.owner)).send({})
    expect(removed.status).toBe(409)
    expect((await request(app()).get('/api/expenses').set(as(co.owner))).body.data.find((x: any) => x.id === e)).toMatchObject({ can_remove: false })
    // Archive Repairs; GAM's repair bill still goes under it.
    const repairs = (await db.query<{ id: string }>(
      `SELECT id FROM books_categories WHERE landlord_id = $1 AND system_key = 'repairs' AND direction = 'expense'`, [co.landlordId])).rows[0].id
    expect((await request(app()).patch(`/api/expenses/categories/${repairs}`).set(as(co.owner)).send({ archived: true })).status).toBe(200)
    const c = await db.connect()
    try {
      await c.query('BEGIN')
      const made = await createMoneyOutExpense(c, { landlordId: co.landlordId, categoryKey: 'repairs', amount: 75, expenseDate: '2026-10-03', propertyId: co.propertyId })
      await c.query('COMMIT')
      expect((await db.query(`SELECT category_id FROM landlord_expenses WHERE id = $1`, [made.id])).rows[0].category_id).toBe(repairs)
    } finally { c.release() }
  })
})

describe('the P&L outside the ledger, and Cash Flow', () => {
  it('an expense counts by its category\'s account ON ITS OWN DAY; a repoint from a later day leaves it where it was', async () => {
    const co = await company()
    await db.query(`SELECT books_seed_categories($1)`, [co.landlordId])
    const supplies = (await db.query<{ id: string }>(
      `SELECT id FROM books_categories WHERE landlord_id = $1 AND system_key = 'supplies' AND direction = 'expense'`, [co.landlordId])).rows[0].id
    const cost = (await db.query<{ id: string }>(`INSERT INTO books_accounts (landlord_id, code, name, type) VALUES ($1, '5400', 'Supplies', 'expense') RETURNING id`, [co.landlordId])).rows[0].id
    const equip = (await db.query<{ id: string }>(`INSERT INTO books_accounts (landlord_id, code, name, type) VALUES ($1, '1530', 'Equipment', 'asset') RETURNING id`, [co.landlordId])).rows[0].id
    await db.query(
      `INSERT INTO books_account_map (landlord_id, map_kind, map_value, account_id, effective_from)
       VALUES ($1, 'expense_category', $2, $3, '0001-01-01'), ($1, 'expense_category', $2, $4, '2026-10-10')`,
      [co.landlordId, supplies, cost, equip])
    for (const [amount, day] of [[100, '2026-10-01'], [900, '2026-10-11']] as const) {
      expect((await request(app()).post('/api/expenses').set(as(co.owner)).send({
        propertyId: co.propertyId, categoryId: supplies, amount, expenseDate: day })).status).toBe(200)
    }
    expect(await landlordExpensesTotal(co.landlordId, '2026-10-01', '2026-10-31')).toBe(100)
  })

  it('Cash Flow counts money out on the day it was paid: an unpaid bill is not cash, a part-payment is', async () => {
    const co = await company()
    const bill = (await request(app()).post('/api/expenses').set(as(co.owner)).send({
      propertyId: co.propertyId, category: 'repairs', amount: 300, expenseDate: '2026-09-20', unpaid: true })).body.data.id
    expect(await landlordExpensesPaidOut(co.landlordId, '2026-09-01', '2026-10-31')).toBe(0)
    expect((await request(app()).post(`/api/expenses/${bill}/payments`).set(as(co.owner))
      .send({ method: 'cash', amount: 120, paidOn: '2026-10-02' })).status).toBe(201)
    expect(await landlordExpensesPaidOut(co.landlordId, '2026-09-01', '2026-09-30')).toBe(0)
    expect(await landlordExpensesPaidOut(co.landlordId, '2026-10-01', '2026-10-31')).toBe(120)
  })
})
