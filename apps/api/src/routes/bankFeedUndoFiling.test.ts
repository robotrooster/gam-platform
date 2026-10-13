/**
 * 10/12 (Nic) — every bank filing can be undone, the Expenses page sends a
 * bank-filed expense back to the Bank page, and a split asks about the payer.
 *
 *   "every bank filing (hand-filed too) can be undone (kept on record)"
 *   "voiding a bank-filed expense on the Expenses page is REFUSED there and
 *    sends you to the Bank page to change it"
 *   "after a split, ASK whether future deposits from that payer should stop
 *    filing automatically"
 *   "keep splitting money GOING OUT into several expenses too"
 *
 * Undo (POST /bank-feed/transactions/:id/undo-filing) takes back how a line is
 * filed — one category, a filing the feed made itself, a split, or the owner's
 * Ignore. What it booked is voided, never deleted, and stamped with the line;
 * the line goes back to review and is never filed by itself again. Filing it
 * again carries what the undone filing held (a receipt, a corrected vendor).
 */
import { randomUUID } from 'crypto'
import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { db, getClient } from '../db'
import { bankFeedRouter } from './bankFeed'
import { expensesRouter } from './expenses'
import { errorHandler } from '../middleware/errorHandler'
import { reconcileDeposits, upsertTransactions } from '../services/bankFeed'
import { landlordExpensesTotal } from '../services/landlordExpenses'
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit } from '../test/dbHelpers'

const SECRET = 'test_jwt_secret_bank_undo_filing'
function app() {
  const a = express()
  a.use(express.json())
  a.use('/api/bank-feed', bankFeedRouter)
  a.use('/api/expenses', expensesRouter)
  a.use(errorHandler)
  return a
}

interface Co {
  landlordId: string; userId: string; token: string; connectionId: string
  propertyId: string; otherPropertyId: string; unitId: string
}

/** A company with two properties, a unit on the first, a linked bank, the owner signed in. */
async function company(): Promise<Co> {
  const client = await getClient()
  try {
    const { userId, landlordId } = await seedLandlord(client)
    const propertyId = await seedProperty(client, { landlordId, ownerUserId: userId, managedByUserId: userId })
    const otherPropertyId = await seedProperty(client, { landlordId, ownerUserId: userId, managedByUserId: userId })
    const unitId = await seedUnit(client, { propertyId, landlordId, rentAmount: 450 })
    const connectionId = (await client.query(
      `INSERT INTO bank_connections (landlord_id, provider, status, display_name) VALUES ($1,'stripe_fc','active','Operating') RETURNING id`,
      [landlordId])).rows[0].id
    process.env.JWT_SECRET = SECRET
    const token = jwt.sign({ userId, role: 'landlord', email: 'owner@t.dev', profileId: landlordId,
      landlordIds: [landlordId], permissions: {} }, SECRET, { expiresIn: '1h' })
    return { landlordId, userId, token, connectionId, propertyId, otherPropertyId, unitId }
  } finally { client.release() }
}

async function line(co: Co, amount: number, opts: { description?: string; merchant?: string; day?: string } = {}): Promise<string> {
  return (await db.query(
    `INSERT INTO bank_transactions
       (bank_connection_id, landlord_id, external_id, posted_date, amount, description, normalized_merchant, status, bank_status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'needs_review','posted') RETURNING id`,
    [co.connectionId, co.landlordId, randomUUID(), opts.day ?? '2026-10-01', amount.toFixed(2),
     opts.description ?? 'Square Inc SQ261001 261001 T3H80F2ZQ67M', opts.merchant ?? 'SQUARE INC'])).rows[0].id
}
const homeDepot = (co: Co) => line(co, -120.5, { description: 'HOME DEPOT #4410', merchant: 'HOME DEPOT' })

const as = (co: Co) => ({ Authorization: `Bearer ${co.token}` })
const fileAs = (co: Co, id: string, body: any) =>
  request(app()).post(`/api/bank-feed/transactions/${id}/categorize`).set(as(co)).send(body)
const split = (co: Co, id: string, parts: any[]) =>
  request(app()).post(`/api/bank-feed/transactions/${id}/split`).set(as(co)).send({ parts })
const undo = (co: Co, id: string) =>
  request(app()).post(`/api/bank-feed/transactions/${id}/undo-filing`).set(as(co)).send({})
const stopPayer = (co: Co, id: string) =>
  request(app()).post(`/api/bank-feed/transactions/${id}/stop-auto-filing`).set(as(co)).send({})
const txn = async (id: string) => (await db.query(
  `SELECT status, ignored_reason, landlord_other_income_id, expense_id, auto_filed_rule_id, auto_settle_undo
     FROM bank_transactions WHERE id = $1`, [id])).rows[0]
const expense = async (id: string) => (await db.query(
  `SELECT id, status, voided_at, bank_transaction_id, category, vendor, receipt_name FROM landlord_expenses WHERE id = $1`, [id])).rows[0]
const income = async (id: string) => (await db.query(
  `SELECT id, status, voided_at, bank_transaction_id FROM landlord_other_income WHERE id = $1`, [id])).rows[0]
const activeIncome = async (co: Co) => Number((await db.query(
  `SELECT COALESCE(SUM(amount), 0)::float AS s FROM landlord_other_income WHERE landlord_id = $1 AND status = 'active'`,
  [co.landlordId])).rows[0].s)
const octSpend = (co: Co) => landlordExpensesTotal(co.landlordId, '2026-10-01', '2026-10-31')
const attach = (expenseId: string, name: string, extra = '') => db.query(
  `UPDATE landlord_expenses SET receipt_url = $2, receipt_name = $3, receipt_mime = 'application/pdf', receipt_size = 1000 ${extra}
    WHERE id = $1`, [expenseId, `/api/expenses/receipt-files/${name}`, name])
const rule = async (co: Co, payer = 'SQUARE INC') => (await db.query(
  `SELECT category, scope_kind, property_id, last_direction, auto_file_income FROM landlord_merchant_rules
    WHERE landlord_id = $1 AND normalized_merchant = $2`, [co.landlordId, payer])).rows[0]
const squareFilesItself = (co: Co, category = 'propane_fuel') => db.query(
  `INSERT INTO landlord_merchant_rules (landlord_id, normalized_merchant, category, scope_kind, property_id, last_direction, auto_file_income)
   VALUES ($1, 'SQUARE INC', $3, 'property_common', $2, 'in', TRUE)`, [co.landlordId, co.propertyId, category])

/** Mountain View's deposit: $30 of propane on the property, $18.39 for a night on the unit. */
const nicsParts = (co: Co) => [
  { category: 'propane_fuel', amount: 30, scopeKind: 'property_common', propertyId: co.propertyId },
  { category: 'other', amount: 18.39, scopeKind: 'unit', unitId: co.unitId },
]
const hdParts = (co: Co) => [
  { category: 'repairs', amount: 80.5, scopeKind: 'unit', unitId: co.unitId },
  { category: 'supplies', amount: 40, scopeKind: 'property_common', propertyId: co.otherPropertyId },
]

beforeEach(cleanupAllSchema)

describe('undoing a line filed as one category', () => {
  it('money out: the expense is voided (kept, stamped with the line), the line is back in review, out of every total', async () => {
    const co = await company()
    const id = await homeDepot(co)
    const filed = await fileAs(co, id, { category: 'repairs', scopeKind: 'property_common', propertyId: co.propertyId })
    expect(filed.status).toBe(200)
    const expenseId = filed.body.data.expenseId
    expect(await octSpend(co)).toBe(120.5)

    const res = await undo(co, id)
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.data).toMatchObject({ kind: 'one_category', voided: 1, status: 'needs_review' })
    const e = await expense(expenseId)
    expect(e.status).toBe('voided')
    expect(e.voided_at).not.toBeNull()
    expect(e.bank_transaction_id).toBe(id)
    const t = await txn(id)
    expect(t).toMatchObject({ status: 'needs_review', expense_id: null })
    expect(t.auto_settle_undo.filingUndone).toMatchObject({ expenseId, by: co.userId, was: 'one_category' })
    expect(await octSpend(co)).toBe(0)
    const page = await request(app()).get('/api/expenses').set(as(co))
    expect(page.body.data.map((x: any) => x.id)).not.toContain(expenseId)

    // Back in review it files again, once.
    const again = await fileAs(co, id, { category: 'supplies', scopeKind: 'unit', unitId: co.unitId })
    expect(again.status).toBe(200)
    expect(await octSpend(co)).toBe(120.5)
    // And that filing can be undone too.
    expect((await undo(co, id)).status).toBe(200)
    expect(await octSpend(co)).toBe(0)
  })

  it('money in: the income is voided and that deposit never files itself again (the payer\'s next one still does)', async () => {
    const co = await company()
    const id = await line(co, 48.39)
    const filed = await fileAs(co, id, { category: 'propane_fuel', scopeKind: 'property_common', propertyId: co.propertyId })
    expect(filed.status).toBe(200)
    const incomeId = filed.body.data.incomeId
    // Filing it taught GAM the payer: their next deposit files itself.
    expect(await rule(co)).toMatchObject({ last_direction: 'in', auto_file_income: true })

    const res = await undo(co, id)
    expect(res.body.data).toMatchObject({ kind: 'one_category', voided: 1, status: 'needs_review' })
    expect(await income(incomeId)).toMatchObject({ status: 'voided', bank_transaction_id: id })
    expect(await activeIncome(co)).toBe(0)

    const fresh = await line(co, 12.5, { day: '2026-10-02' })
    await reconcileDeposits(co.landlordId)
    expect((await txn(fresh)).status).toBe('categorized')
    expect((await txn(id)).status).toBe('needs_review')
    expect(await activeIncome(co)).toBe(12.5)
  })

  it('what the owner added to the expense rides onto the filing that replaces it', async () => {
    const co = await company()
    const id = await homeDepot(co)
    const filed = await fileAs(co, id, { category: 'repairs', scopeKind: 'property_common', propertyId: co.propertyId })
    await attach(filed.body.data.expenseId, 'hd-4410.pdf', `, vendor = 'Home Depot Pro'`)
    expect((await undo(co, id)).status).toBe(200)

    const again = await fileAs(co, id, { category: 'supplies', scopeKind: 'property_common', propertyId: co.propertyId })
    expect(again.status).toBe(200)
    expect(await expense(again.body.data.expenseId)).toMatchObject({
      status: 'active', category: 'supplies', receipt_name: 'hd-4410.pdf', vendor: 'Home Depot Pro',
    })
    // Undone again and split this time: every part carries the one receipt.
    expect((await undo(co, id)).status).toBe(200)
    const parts = await split(co, id, hdParts(co))
    expect(parts.status).toBe(200)
    for (const partId of parts.body.data.expenseIds) {
      expect(await expense(partId)).toMatchObject({ receipt_name: 'hd-4410.pdf', vendor: 'Home Depot Pro' })
    }
  })

  it('10/12 (Nic) review: a carried receipt opens by the expense that holds it now, never through the voided one it left', async () => {
    const co = await company()
    const id = await homeDepot(co)
    const filed = await fileAs(co, id, { category: 'repairs', scopeKind: 'property_common', propertyId: co.propertyId })
    const name = `hd-${randomUUID()}.pdf`
    await attach(filed.body.data.expenseId, name)
    expect((await undo(co, id)).status).toBe(200)
    // Filed again on the other property: the new expense carries the receipt; the old one is kept, voided.
    const again = await fileAs(co, id, { category: 'repairs', scopeKind: 'property_common', propertyId: co.otherPropertyId })
    expect((await expense(again.body.data.expenseId)).receipt_name).toBe(name)
    const bookkeeperOn = async (propertyId: string) => {
      const userId = (await db.query<{ id: string }>(
        `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
         VALUES ($1,'x','bookkeeper','Bo','Keeper',TRUE) RETURNING id`, [`bk-${randomUUID()}@t.dev`])).rows[0].id
      await db.query(`INSERT INTO bookkeeper_scopes (user_id, landlord_id, property_ids, access_level) VALUES ($1,$2,$3,'read_only')`,
        [userId, co.landlordId, [propertyId]])
      return jwt.sign({ userId, role: 'bookkeeper', email: 'bk@t.dev', profileId: null, landlordId: co.landlordId,
        permissions: { access_level: 'read_only' } }, SECRET, { expiresIn: '1h' })
    }
    const open = (tok: string) => request(app()).get(`/api/expenses/receipt-files/${name}`).set({ Authorization: `Bearer ${tok}` })
    // Allowed reads reach the file itself (none on disk in a test: 404); refused ones stop at 403.
    expect((await open(await bookkeeperOn(co.otherPropertyId))).status).toBe(404)
    expect((await open(await bookkeeperOn(co.propertyId))).status).toBe(403)
    expect((await open(co.token)).status).toBe(404)
  })

  it('10/12 (Nic) review: after an undo the bank is linked again — the copy kept carries the undone filing\'s receipt when it is filed', async () => {
    const co = await company()
    await db.query(`UPDATE bank_connections SET institution_name = 'PNC', account_last4 = '2971' WHERE id = $1`, [co.connectionId])
    const id = await homeDepot(co)
    const filed = await fileAs(co, id, { category: 'repairs', scopeKind: 'property_common', propertyId: co.propertyId })
    await attach(filed.body.data.expenseId, 'hd-relink.pdf', `, vendor = 'Home Depot Pro'`)
    expect((await undo(co, id)).status).toBe(200)
    // The bank is linked again: the new link sends the same charge under a new id.
    const relink = (await db.query(
      `INSERT INTO bank_connections (landlord_id, provider, status, display_name, institution_name, account_last4)
       VALUES ($1,'stripe_fc','active','Operating','PNC','2971') RETURNING id`, [co.landlordId])).rows[0].id
    await upsertTransactions(relink, co.landlordId,
      [{ externalId: `relink-${randomUUID()}`, postedDate: '2026-10-01', amount: -120.5, description: 'HOME DEPOT #4410', status: 'posted' }])
    const kept = (await db.query(`SELECT id FROM bank_transactions WHERE bank_connection_id = $1`, [relink])).rows[0].id
    expect(await txn(id)).toMatchObject({ status: 'ignored', ignored_reason: 'duplicate' })
    const again = await fileAs(co, kept, { category: 'repairs', scopeKind: 'property_common', propertyId: co.propertyId })
    expect(again.status, JSON.stringify(again.body)).toBe(200)
    expect(await expense(again.body.data.expenseId)).toMatchObject({ status: 'active', receipt_name: 'hd-relink.pdf', vendor: 'Home Depot Pro' })
  })

  it('parts that held different receipts are never filed again as one expense; split again, each keeps its own', async () => {
    const co = await company()
    const id = await homeDepot(co)
    const first = await split(co, id, hdParts(co))
    const [repairsId, suppliesId] = first.body.data.expenseIds
    await attach(repairsId, 'repairs.pdf')
    await attach(suppliesId, 'supplies.pdf')
    const undone = await undo(co, id)
    expect(undone.body.data).toMatchObject({ kind: 'split', voided: 2, status: 'needs_review' })

    const one = await fileAs(co, id, { category: 'repairs', scopeKind: 'property_common', propertyId: co.propertyId })
    expect(one.status).toBe(409)
    expect(one.body.error).toMatch(/2 different receipts/)
    expect((await txn(id)).status).toBe('needs_review')

    const again = await split(co, id, hdParts(co))
    expect(again.status).toBe(200)
    const [r2, s2] = again.body.data.expenseIds
    expect((await expense(r2)).receipt_name).toBe('repairs.pdf')
    expect((await expense(s2)).receipt_name).toBe('supplies.pdf')
  })

  it('a filed line the bank voided comes back set aside as the bank\'s void, not in review', async () => {
    const co = await company()
    const id = await homeDepot(co)
    const filed = await fileAs(co, id, { category: 'repairs', scopeKind: 'property_common', propertyId: co.propertyId })
    await db.query(`UPDATE bank_transactions SET bank_status = 'void' WHERE id = $1`, [id])
    const res = await undo(co, id)
    expect(res.body.data).toMatchObject({ kind: 'one_category', status: 'ignored' })
    expect(await txn(id)).toMatchObject({ status: 'ignored', ignored_reason: 'bank_void', expense_id: null })
    expect((await expense(filed.body.data.expenseId)).status).toBe('voided')
  })

  it('an expense removed on the Expenses page before 10/12 still lets its line come back', async () => {
    const co = await company()
    const id = await homeDepot(co)
    const filed = await fileAs(co, id, { category: 'repairs', scopeKind: 'property_common', propertyId: co.propertyId })
    // What the old Remove did: the expense voided, the line left saying "filed".
    await db.query(`UPDATE landlord_expenses SET status = 'voided', voided_at = now() WHERE id = $1`, [filed.body.data.expenseId])
    const res = await undo(co, id)
    expect(res.status).toBe(200)
    expect(res.body.data).toMatchObject({ kind: 'one_category', voided: 0, status: 'needs_review' })
    expect((await expense(filed.body.data.expenseId)).bank_transaction_id).toBe(id)
    expect((await fileAs(co, id, { category: 'repairs', scopeKind: 'property_common', propertyId: co.propertyId })).status).toBe(200)
  })
})

describe('one Undo for every kind of filing', () => {
  it('takes back a deposit that filed itself, stamping the income with its line', async () => {
    const co = await company()
    await squareFilesItself(co)
    const id = await line(co, 48.39)
    await reconcileDeposits(co.landlordId)
    const before = await txn(id)
    expect(before.status).toBe('categorized')
    const res = await undo(co, id)
    expect(res.body.data).toMatchObject({ kind: 'auto_filed', voided: 1, status: 'needs_review' })
    expect(await income(before.landlord_other_income_id)).toMatchObject({ status: 'voided', bank_transaction_id: id })
    expect(await activeIncome(co)).toBe(0)
  })

  it('takes back the owner\'s own Ignore: the line is back in review', async () => {
    const co = await company()
    const id = await homeDepot(co)
    expect((await request(app()).post(`/api/bank-feed/transactions/${id}/ignore`).set(as(co)).send({})).status).toBe(200)
    expect(await txn(id)).toMatchObject({ status: 'ignored', ignored_reason: 'landlord' })
    const res = await undo(co, id)
    expect(res.body.data).toMatchObject({ kind: 'ignored', voided: 0, status: 'needs_review' })
    expect(await txn(id)).toMatchObject({ status: 'needs_review', ignored_reason: null })
    expect((await fileAs(co, id, { category: 'repairs', scopeKind: 'property_common', propertyId: co.propertyId })).status).toBe(200)
  })

  it('refuses where there is no filing: a line in review, a GAM payout, a copy GAM set aside', async () => {
    const co = await company()
    const review = await homeDepot(co)
    expect((await undo(co, review)).status).toBe(409)
    const payout = await line(co, 900, { description: 'STRIPE TRANSFER', merchant: 'STRIPE TRANSFER' })
    await db.query(`UPDATE bank_transactions SET status = 'matched' WHERE id = $1`, [payout])
    const r = await undo(co, payout)
    expect(r.status).toBe(409)
    expect(r.body.error).toMatch(/matched/)
    const before = await homeDepot(co)
    await db.query(`UPDATE bank_transactions SET status = 'ignored', ignored_reason = 'before_books' WHERE id = $1`, [before])
    expect((await undo(co, before)).status).toBe(409)
    expect((await txn(before)).status).toBe('ignored')
  })

  it('another company\'s line is not reachable, and a bookkeeper cannot undo (filing is the owner\'s)', async () => {
    const co = await company()
    const stranger = await company()
    const id = await homeDepot(co)
    await fileAs(co, id, { category: 'repairs', scopeKind: 'property_common', propertyId: co.propertyId })
    expect((await undo(stranger, id)).status).toBe(404)
    const bk = jwt.sign({ userId: co.userId, role: 'bookkeeper', email: 'bk@t.dev', profileId: co.landlordId,
      landlordIds: [co.landlordId], permissions: { access_level: 'read_write' } }, SECRET, { expiresIn: '1h' })
    const res = await request(app()).post(`/api/bank-feed/transactions/${id}/undo-filing`)
      .set({ Authorization: `Bearer ${bk}` }).send({})
    expect(res.status).toBe(403)
    expect((await txn(id)).status).toBe('categorized')
  })
})

describe('the Expenses page sends a bank-filed expense to the Bank page', () => {
  it('refuses to remove it there, says which bank line it came from; a hand-logged expense is removed as always', async () => {
    const co = await company()
    const id = await homeDepot(co)
    const filed = await fileAs(co, id, { category: 'repairs', scopeKind: 'property_common', propertyId: co.propertyId })
    const expenseId = filed.body.data.expenseId

    const page = await request(app()).get('/api/expenses').set(as(co))
    const row = page.body.data.find((x: any) => x.id === expenseId)
    expect(row).toMatchObject({ from_bank: true, can_remove: false, bank_line_id: id, landlord_id: co.landlordId })
    const refused = await request(app()).post(`/api/expenses/${expenseId}/void`).set(as(co)).send({})
    expect(refused.status).toBe(409)
    expect(refused.body.error).toMatch(/Bank page/)
    expect((await expense(expenseId)).status).toBe('active')
    expect(await octSpend(co)).toBe(120.5)

    // Cash that never went through the bank: logged and removed here, as always.
    const cash = await request(app()).post('/api/expenses').set(as(co)).send({
      propertyId: co.propertyId, category: 'supplies', amount: 12, expenseDate: '2026-10-03', isCommon: true,
    })
    expect(cash.status).toBe(200)
    const listed = (await request(app()).get('/api/expenses').set(as(co))).body.data.find((x: any) => x.id === cash.body.data.id)
    expect(listed).toMatchObject({ from_bank: false, can_remove: true, bank_line_id: null })
    expect((await request(app()).post(`/api/expenses/${cash.body.data.id}/void`).set(as(co)).send({})).status).toBe(200)
  })

  it('money going out still splits into several expenses, each pointing at its line and refused alone', async () => {
    const co = await company()
    const id = await homeDepot(co)
    const res = await split(co, id, hdParts(co))
    expect(res.status).toBe(200)
    expect(res.body.data.payerQuestion).toBeNull()
    for (const partId of res.body.data.expenseIds) {
      const r = await request(app()).post(`/api/expenses/${partId}/void`).set(as(co)).send({})
      expect(r.status).toBe(409)
      expect(r.body.error).toMatch(/split/)
    }
    const page = await request(app()).get('/api/expenses').set(as(co))
    expect(page.body.data.filter((x: any) => x.bank_line_id === id)).toHaveLength(2)
  })

  it('the Bank page opens on that one line, only for its own company', async () => {
    const co = await company()
    const stranger = await company()
    const id = await homeDepot(co)
    await homeDepot(co)
    const one = await request(app()).get(`/api/bank-feed/transactions?lineId=${id}`).set(as(co))
    expect(one.status).toBe(200)
    expect(one.body.data.map((t: any) => t.id)).toEqual([id])
    const theirs = await request(app()).get(`/api/bank-feed/transactions?lineId=${id}`).set(as(stranger))
    expect(theirs.body.data).toEqual([])
  })
})

describe('after a deposit is split, the owner is asked about its payer', () => {
  it('a payer that files itself: asked, and yes stops it — the next deposit waits', async () => {
    const co = await company()
    await squareFilesItself(co)
    const id = await line(co, 48.39)
    const res = await split(co, id, nicsParts(co))
    expect(res.status).toBe(200)
    expect(res.body.data.payerQuestion).toEqual({ payer: 'SQUARE INC', filesItself: true, category: 'propane_fuel' })

    const yes = await stopPayer(co, id)
    expect(yes.status).toBe(200)
    expect(yes.body.data).toEqual({ payer: 'SQUARE INC', alreadyStopped: false })
    expect(await rule(co)).toMatchObject({ auto_file_income: false, category: 'propane_fuel' })
    const fresh = await line(co, 12.5, { day: '2026-10-02' })
    await reconcileDeposits(co.landlordId)
    expect((await txn(fresh)).status).toBe('needs_review')
    // Pressing it twice is harmless.
    expect((await stopPayer(co, id)).body.data).toEqual({ payer: 'SQUARE INC', alreadyStopped: true })
    // Already stopped: the next split asks nothing.
    expect((await split(co, fresh, [
      { category: 'propane_fuel', amount: 10, scopeKind: 'property_common', propertyId: co.propertyId },
      { category: 'vending', amount: 2.5, scopeKind: 'property_common', propertyId: co.propertyId },
    ])).body.data.payerQuestion).toBeNull()
  })

  it('no leaves it: the payer\'s next deposit still files itself', async () => {
    const co = await company()
    await squareFilesItself(co)
    const id = await line(co, 48.39)
    expect((await split(co, id, nicsParts(co))).body.data.payerQuestion).toMatchObject({ filesItself: true })
    const fresh = await line(co, 12.5, { day: '2026-10-02' })
    await reconcileDeposits(co.landlordId)
    expect((await txn(fresh)).status).toBe('categorized')
  })

  it('a payer GAM never remembered: asked as one that would file itself; yes keeps it from ever starting', async () => {
    const co = await company()
    const id = await line(co, 48.39)
    expect((await split(co, id, nicsParts(co))).body.data.payerQuestion)
      .toEqual({ payer: 'SQUARE INC', filesItself: false, category: null })
    expect((await stopPayer(co, id)).body.data).toEqual({ payer: 'SQUARE INC', alreadyStopped: false })
    // Remembered from the split's largest part, with no direction: it pre-fills, never files.
    expect(await rule(co)).toMatchObject({
      category: 'propane_fuel', scope_kind: 'property_common', property_id: co.propertyId,
      last_direction: null, auto_file_income: false,
    })
    // Filing the next one as one category teaches the direction, and still nothing files itself.
    const second = await line(co, 20, { day: '2026-10-02' })
    expect((await fileAs(co, second, { category: 'propane_fuel', scopeKind: 'property_common', propertyId: co.propertyId })).status).toBe(200)
    expect(await rule(co)).toMatchObject({ last_direction: 'in', auto_file_income: false })
    const third = await line(co, 7, { day: '2026-10-03' })
    await reconcileDeposits(co.landlordId)
    expect((await txn(third)).status).toBe('needs_review')
  })

  it('not asked when the answer could change nothing; money going out is refused', async () => {
    const co = await company()
    const named = (description: string, merchant: string) => line(co, 48.39, { description, merchant })
    for (const id of [
      await named('MOBILE DEPOSIT', 'MOBILE DEPOSIT'),
      await named('DOORLOOP INC PAYOUT 0921', 'DOORLOOP INC PAYOUT'),
      await named('ONLINE TRANSFER FROM SAVINGS', 'ONLINE TRANSFER FROM SAVINGS'),
    ]) {
      const res = await split(co, id, nicsParts(co))
      expect(res.status, JSON.stringify(res.body)).toBe(200)
      expect(res.body.data.payerQuestion).toBeNull()
    }
    const out = await homeDepot(co)
    const r = await stopPayer(co, out)
    expect(r.status).toBe(409)
    expect(r.body.error).toMatch(/Money going out/)
    const nobody = await named('MOBILE DEPOSIT', 'MOBILE DEPOSIT')
    expect((await stopPayer(co, nobody)).status).toBe(409)
  })
})
