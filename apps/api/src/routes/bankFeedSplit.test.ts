/**
 * 10/12 (Nic) — splitting one bank line into parts.
 *
 *   "categories are separate. if a deposit is multiple sources it should be
 *    split for record keeping"
 *
 * Mountain View's $48.39 Square deposit of 10/1 is propane sales and an
 * overnight stay. The owner splits a bank line into parts, each with its own
 * category and its own unit or property, adding up to the bank's amount to
 * the cent (POST /bank-feed/transactions/:id/split). Each part is one
 * landlord_other_income row (money in) or landlord_expenses row (money out)
 * pointing at the line, so every reader that counts those rows counts each
 * part in its own category with no change. Changing or undoing a split voids
 * the old parts — never deletes them.
 */
import { randomUUID } from 'crypto'
import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { db, getClient } from '../db'
import { bankFeedRouter } from './bankFeed'
import { financialsRouter } from './financials'
import { expensesRouter } from './expenses'
import { errorHandler } from '../middleware/errorHandler'
import { reconcileDeposits, categorizeTransaction } from '../services/bankFeed'
import { incomeTotals } from '../services/incomeBasis'
import {
  listLandlordExpenses, landlordExpensesTotal, voidLandlordExpense, updateLandlordExpense,
} from '../services/landlordExpenses'
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit } from '../test/dbHelpers'

const SECRET = 'test_jwt_secret_bank_split'
function app() {
  const a = express()
  a.use(express.json())
  a.use('/api/bank-feed', bankFeedRouter)
  a.use('/api/financials', financialsRouter)
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

const as = (co: Co) => ({ Authorization: `Bearer ${co.token}` })
const split = (co: Co, id: string, parts: any[]) =>
  request(app()).post(`/api/bank-feed/transactions/${id}/split`).set(as(co)).send({ parts })
const unsplit = (co: Co, id: string) =>
  request(app()).post(`/api/bank-feed/transactions/${id}/split/undo`).set(as(co)).send({})
const txn = async (id: string) => (await db.query(
  `SELECT status, landlord_other_income_id, expense_id, auto_filed_rule_id, auto_settle_undo
     FROM bank_transactions WHERE id = $1`, [id])).rows[0]
const incomeRows = async (id: string) => (await db.query(
  `SELECT id, category, amount::float AS amount, status, property_id, unit_id, payer,
          to_char(income_date, 'YYYY-MM-DD') AS day
     FROM landlord_other_income WHERE bank_transaction_id = $1 ORDER BY status, amount DESC`, [id])).rows
const expenseRows = async (id: string) => (await db.query(
  `SELECT id, category, amount::float AS amount, status, property_id, unit_id
     FROM landlord_expenses WHERE bank_transaction_id = $1 ORDER BY status, amount DESC`, [id])).rows
/** Every active other-income dollar in the company, however it is linked. */
const activeIncome = async (co: Co) => Number((await db.query(
  `SELECT COALESCE(SUM(amount), 0)::float AS s FROM landlord_other_income WHERE landlord_id = $1 AND status = 'active'`,
  [co.landlordId])).rows[0].s)

/** Nic's deposit: $30 of propane on the property, $18.39 for a night on the unit. */
const nicsParts = (co: Co) => [
  { category: 'propane_fuel', amount: 30, scopeKind: 'property_common', propertyId: co.propertyId },
  { category: 'other', amount: 18.39, scopeKind: 'unit', unitId: co.unitId },
]

beforeEach(cleanupAllSchema)

describe('splitting a deposit', () => {
  it('files each part in its own category and place, and the line as filed in parts', async () => {
    const co = await company()
    const id = await line(co, 48.39)
    const res = await split(co, id, nicsParts(co))
    expect(res.status).toBe(200)
    expect(res.body.data.incomeIds).toHaveLength(2)
    expect(res.body.data.replaced).toBe(0)

    expect(await txn(id)).toMatchObject({ status: 'categorized', landlord_other_income_id: null, expense_id: null })
    const rows = await incomeRows(id)
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ category: 'propane_fuel', amount: 30, status: 'active', property_id: co.propertyId,
      unit_id: null, payer: 'SQUARE INC', day: '2026-10-01' })
    // A unit part records the unit's property too, as a one-category filing does.
    expect(rows[1]).toMatchObject({ category: 'other', amount: 18.39, status: 'active', property_id: co.propertyId, unit_id: co.unitId })

    // The Bank page lists the parts.
    const feed = await request(app()).get('/api/bank-feed/transactions').set(as(co))
    const row = feed.body.data.find((t: any) => t.id === id)
    expect(row.split_parts.map((p: any) => [p.category, p.amount])).toEqual([['propane_fuel', 30], ['other', 18.39]])
    // The deposit is off the review queue.
    const review = await request(app()).get('/api/bank-feed/transactions?status=needs_review').set(as(co))
    expect(review.body.data.map((t: any) => t.id)).not.toContain(id)
  })

  it('each part reports in its own category in the P&L (incomeBasis reads the rows, no change of its own)', async () => {
    const co = await company()
    const id = await line(co, 100, { description: 'MOBILE DEPOSIT', merchant: 'MOBILE DEPOSIT' })
    expect((await split(co, id, [
      { category: 'laundry', amount: 60, scopeKind: 'property_common', propertyId: co.propertyId },
      { category: 'owner_contribution', amount: 40, scopeKind: 'property_common', propertyId: co.otherPropertyId },
    ])).status).toBe(200)
    const t = await incomeTotals({ landlordIds: [co.landlordId], start: '2026-10-01', end: '2026-10-31', basis: 'received' })
    // Laundry is income; the owner's own money put in is beside the total, never income.
    expect(t.lines.otherIncome).toBe(60)
    expect(t.total).toBe(60)
    expect(t.beside.ownerContributions).toBe(40)
    // Each part on its own property.
    const byProp = await incomeTotals({ landlordIds: [co.landlordId], start: '2026-10-01', end: '2026-10-31',
      basis: 'received', propertyIds: [co.otherPropertyId] })
    expect(byProp.total).toBe(0)
    expect(byProp.beside.ownerContributions).toBe(40)
  })

  it('the parts must add up to the bank amount to the cent; nothing is written otherwise', async () => {
    const co = await company()
    const id = await line(co, 48.39)
    const short = await split(co, id, [
      { category: 'propane_fuel', amount: 30, scopeKind: 'property_common', propertyId: co.propertyId },
      { category: 'other', amount: 18.38, scopeKind: 'property_common', propertyId: co.propertyId },
    ])
    expect(short.status).toBe(400)
    expect(short.body.error).toContain('$0.01 is not in any part yet')
    const over = await split(co, id, [
      { category: 'propane_fuel', amount: 30, scopeKind: 'property_common', propertyId: co.propertyId },
      { category: 'other', amount: 18.40, scopeKind: 'property_common', propertyId: co.propertyId },
    ])
    expect(over.status).toBe(400)
    expect(over.body.error).toContain('$0.01 too much')
    const fraction = await split(co, id, [
      { category: 'propane_fuel', amount: 30.005, scopeKind: 'property_common', propertyId: co.propertyId },
      { category: 'other', amount: 18.385, scopeKind: 'property_common', propertyId: co.propertyId },
    ])
    expect(fraction.status).toBe(400)
    const one = await split(co, id, [{ category: 'other', amount: 48.39, scopeKind: 'property_common', propertyId: co.propertyId }])
    expect(one.status).toBe(400)
    expect(one.body.error).toContain('at least two parts')
    const unplaced = await split(co, id, [
      { category: 'propane_fuel', amount: 30, scopeKind: 'property_common', propertyId: co.propertyId },
      { category: 'other', amount: 18.39, scopeKind: 'unit' },
    ])
    expect(unplaced.status).toBe(400)
    expect(await txn(id)).toMatchObject({ status: 'needs_review' })
    expect(await incomeRows(id)).toHaveLength(0)
  })

  it('refuses an expense category on money in, and a place that is another company’s', async () => {
    const co = await company()
    const stranger = await company()
    const id = await line(co, 48.39)
    const crossed = await split(co, id, [
      { category: 'repairs', amount: 30, scopeKind: 'property_common', propertyId: co.propertyId },
      { category: 'other', amount: 18.39, scopeKind: 'property_common', propertyId: co.propertyId },
    ])
    expect(crossed.status).toBe(400)
    const theirs = await split(co, id, [
      { category: 'propane_fuel', amount: 30, scopeKind: 'property_common', propertyId: co.propertyId },
      { category: 'other', amount: 18.39, scopeKind: 'unit', unitId: stranger.unitId },
    ])
    expect(theirs.status).toBe(400)
    // The first part was written before the second was refused: it rolled back with it.
    expect(await incomeRows(id)).toHaveLength(0)
    expect(await txn(id)).toMatchObject({ status: 'needs_review' })
    // And another company's line is not reachable at all.
    const notMine = await split(stranger, id, nicsParts(co))
    expect(notMine.status).toBe(404)
  })

  it('refuses a deposit matched to money GAM already has on record (it would count twice)', async () => {
    const co = await company()
    const id = await line(co, 48.39)
    await db.query(`UPDATE bank_transactions SET status = 'matched' WHERE id = $1`, [id])
    const res = await split(co, id, nicsParts(co))
    expect(res.status).toBe(409)
    expect(await incomeRows(id)).toHaveLength(0)
  })
})

describe('changing how a line is filed — everything kept', () => {
  it('splits a deposit already filed as one category: the old filing is voided, stamped, never deleted', async () => {
    const co = await company()
    const id = await line(co, 48.39)
    const filed = await request(app()).post(`/api/bank-feed/transactions/${id}/categorize`).set(as(co))
      .send({ category: 'other', scopeKind: 'property_common', propertyId: co.propertyId })
    expect(filed.status).toBe(200)
    const oldId = filed.body.data.incomeId
    expect(await activeIncome(co)).toBe(48.39)

    const res = await split(co, id, nicsParts(co))
    expect(res.status).toBe(200)
    expect(res.body.data.replaced).toBe(1)
    expect(await txn(id)).toMatchObject({ status: 'categorized', landlord_other_income_id: null })
    const old = (await db.query(`SELECT status, voided_at, bank_transaction_id FROM landlord_other_income WHERE id = $1`, [oldId])).rows[0]
    expect(old.status).toBe('voided')
    expect(old.voided_at).not.toBeNull()
    expect(old.bank_transaction_id).toBe(id)
    // Counted once: the parts replace the old filing, they do not add to it.
    expect(await activeIncome(co)).toBe(48.39)
  })

  it('changes a split: the old parts are voided, the new ones written, the total unchanged', async () => {
    const co = await company()
    const id = await line(co, 48.39)
    await split(co, id, nicsParts(co))
    const res = await split(co, id, [
      { category: 'propane_fuel', amount: 20, scopeKind: 'property_common', propertyId: co.propertyId },
      { category: 'other', amount: 18.39, scopeKind: 'unit', unitId: co.unitId },
      { category: 'vending', amount: 10, scopeKind: 'property_common', propertyId: co.propertyId },
    ])
    expect(res.status).toBe(200)
    expect(res.body.data.replaced).toBe(2)
    const rows = await incomeRows(id)
    expect(rows.filter((r: any) => r.status === 'active').map((r: any) => [r.category, r.amount]))
      .toEqual([['propane_fuel', 20], ['other', 18.39], ['vending', 10]])
    expect(rows.filter((r: any) => r.status === 'voided')).toHaveLength(2)
    expect(await activeIncome(co)).toBe(48.39)
  })

  it('splits a deposit that filed itself (before 10/14): the filing is the owner’s now', async () => {
    const co = await company()
    const ruleId = (await db.query(
      `INSERT INTO landlord_merchant_rules (landlord_id, normalized_merchant, category, scope_kind, property_id, last_direction, auto_file_income)
       VALUES ($1, 'SQUARE INC', 'propane_fuel', 'property_common', $2, 'in', TRUE) RETURNING id`,
      [co.landlordId, co.propertyId])).rows[0].id
    const id = await line(co, 48.39)
    // 10/14 (Nic, answer 16): nothing files itself any more — a line that did
    // before sits on file filed as one category, with the rule that filed it.
    await categorizeTransaction(co.landlordId, id, { category: 'propane_fuel', scopeKind: 'property_common', propertyId: co.propertyId })
    await db.query(`UPDATE bank_transactions SET auto_filed_rule_id = $2, auto_filed_at = now() WHERE id = $1`, [id, ruleId])
    const before = await txn(id)
    expect(before).toMatchObject({ status: 'categorized', auto_filed_rule_id: ruleId })
    expect(before.landlord_other_income_id).not.toBeNull()

    expect((await split(co, id, nicsParts(co))).status).toBe(200)
    expect(await txn(id)).toMatchObject({ status: 'categorized', auto_filed_rule_id: null, landlord_other_income_id: null })
    expect(await activeIncome(co)).toBe(48.39)
    // The payer's rule is the owner's to change; a split does not touch it.
    const rule = (await db.query(`SELECT category, auto_file_income FROM landlord_merchant_rules WHERE id = $1`, [ruleId])).rows[0]
    expect(rule).toMatchObject({ category: 'propane_fuel', auto_file_income: true })
  })

  it('undoing a split voids its parts, puts the line back in review, and the feed never files it by itself again', async () => {
    const co = await company()
    await db.query(
      `INSERT INTO landlord_merchant_rules (landlord_id, normalized_merchant, category, scope_kind, property_id, last_direction, auto_file_income)
       VALUES ($1, 'SQUARE INC', 'propane_fuel', 'property_common', $2, 'in', TRUE)`, [co.landlordId, co.propertyId])
    const id = await line(co, 48.39)
    // Set aside as "not rent" first: that mark must survive the undo.
    await db.query(`UPDATE bank_transactions SET auto_settle_undo = '{"notRent":{"at":"x"}}'::jsonb WHERE id = $1`, [id])
    expect((await split(co, id, nicsParts(co))).status).toBe(200)

    const res = await unsplit(co, id)
    expect(res.status).toBe(200)
    expect(res.body.data.voidedParts).toBe(2)
    const t = await txn(id)
    expect(t.status).toBe('needs_review')
    expect(t.auto_settle_undo.splitUndone.incomeIds).toHaveLength(2)
    expect(t.auto_settle_undo.notRent).toBeTruthy()
    const rows = await incomeRows(id)
    expect(rows).toHaveLength(2)
    expect(rows.every((r: any) => r.status === 'voided')).toBe(true)
    expect(await activeIncome(co)).toBe(0)

    // 10/14 (Nic, answer 16): no deposit files itself from its payer's name —
    // neither a fresh one from the same payer nor the one a person undid.
    const fresh = await line(co, 12.5, { day: '2026-10-02' })
    await reconcileDeposits(co.landlordId)
    expect((await txn(fresh)).status).toBe('needs_review')
    expect((await txn(id)).status).toBe('needs_review')

    // Back in review, it can be filed again — as one category or split again.
    expect((await split(co, id, nicsParts(co))).status).toBe(200)
  })

  it('undo is refused on a line that is not split', async () => {
    const co = await company()
    const id = await line(co, 48.39)
    expect((await unsplit(co, id)).status).toBe(409)
    await request(app()).post(`/api/bank-feed/transactions/${id}/categorize`).set(as(co))
      .send({ category: 'other', scopeKind: 'property_common', propertyId: co.propertyId })
    expect((await unsplit(co, id)).status).toBe(409)
    expect((await txn(id)).status).toBe('categorized')
  })
})

describe('splitting money out', () => {
  it('files each part as its own expense; the parts keep the bank amount and are voided only together', async () => {
    const co = await company()
    const id = await line(co, -120.5, { description: 'HOME DEPOT #4410', merchant: 'HOME DEPOT' })
    const res = await split(co, id, [
      { category: 'repairs', amount: 80.5, scopeKind: 'unit', unitId: co.unitId },
      { category: 'supplies', amount: 40, scopeKind: 'property_common', propertyId: co.otherPropertyId },
    ])
    expect(res.status).toBe(200)
    expect(res.body.data.expenseIds).toHaveLength(2)
    expect(await txn(id)).toMatchObject({ status: 'categorized', expense_id: null })
    const rows = await expenseRows(id)
    expect(rows.map((r: any) => [r.category, r.amount, r.status])).toEqual([['repairs', 80.5, 'active'], ['supplies', 40, 'active']])
    expect(rows[0]).toMatchObject({ unit_id: co.unitId, property_id: co.propertyId })
    expect(rows[1]).toMatchObject({ unit_id: null, property_id: co.otherPropertyId })

    // Expense readers count each part in its own category.
    expect(await landlordExpensesTotal(co.landlordId, '2026-10-01', '2026-10-31')).toBe(120.5)
    const listed = await listLandlordExpenses(co.landlordId)
    expect(listed.every((e: any) => e.from_bank === true)).toBe(true)

    // One part alone cannot change its amount or be voided: the parts would
    // stop adding up to what the bank shows.
    await expect(updateLandlordExpense(rows[0].id, co.landlordId, { amount: 70 })).rejects.toMatchObject({ statusCode: 409 })
    await expect(voidLandlordExpense(rows[0].id, co.landlordId)).rejects.toMatchObject({ statusCode: 409 })
    // Its category and place can still change.
    await updateLandlordExpense(rows[0].id, co.landlordId, { category: 'maintenance' })
    // 10/12 review: the Expenses page never offers Remove on a part (the server would refuse it).
    const page = await request(app()).get('/api/expenses').set(as(co))
    expect(page.status).toBe(200)
    const parts = page.body.data.filter((e: any) => [rows[0].id, rows[1].id].includes(e.id))
    expect(parts).toHaveLength(2)
    expect(parts.every((e: any) => (e.canRemove ?? e.can_remove) === false)).toBe(true)

    // An income category on money out is refused.
    const other = await line(co, -10, { description: 'APS', merchant: 'APS' })
    expect((await split(co, other, [
      { category: 'laundry', amount: 5, scopeKind: 'property_common', propertyId: co.propertyId },
      { category: 'repairs', amount: 5, scopeKind: 'property_common', propertyId: co.propertyId },
    ])).status).toBe(400)

    expect((await unsplit(co, id)).status).toBe(200)
    expect((await expenseRows(id)).every((r: any) => r.status === 'voided')).toBe(true)
    expect(await landlordExpensesTotal(co.landlordId, '2026-10-01', '2026-10-31')).toBe(0)
  })

  // 10/13 (Nic): "each expense is chosen on the split or specific unit or
  // property at the time of logging." A part going out may be split across
  // the company's properties by units (naming none); a part coming in may not.
  it('a part going out may be split across the properties by units; the line lists it so', async () => {
    const co = await company()
    const id = await line(co, -1300, { description: 'STATE FARM', merchant: 'STATE FARM' })
    const named = await split(co, id, [
      { category: 'insurance', amount: 1200, scopeKind: 'split_by_units', propertyId: co.propertyId },
      { category: 'repairs', amount: 100, scopeKind: 'unit', unitId: co.unitId },
    ])
    expect([named.status, named.body.error]).toEqual([400, 'Part 1: a part split across your properties names no one property or unit'])
    const res = await split(co, id, [
      { category: 'insurance', amount: 1200, scopeKind: 'split_by_units' },
      { category: 'repairs', amount: 100, scopeKind: 'unit', unitId: co.unitId },
    ])
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    const rows = (await db.query<any>(
      `SELECT category, cost_place, property_id, unit_id, is_common FROM landlord_expenses
        WHERE bank_transaction_id = $1 AND status = 'active' ORDER BY amount DESC`, [id])).rows
    expect(rows).toEqual([
      { category: 'insurance', cost_place: 'split_by_units', property_id: null, unit_id: null, is_common: false },
      { category: 'repairs', cost_place: 'unit', property_id: co.propertyId, unit_id: co.unitId, is_common: false },
    ])
    const listed = (await request(app()).get(`/api/bank-feed/transactions?lineId=${id}`).set(as(co))).body.data[0]
    expect((listed.splitParts ?? listed.split_parts).map((p: any) => p.costPlace ?? p.cost_place)).toEqual(['split_by_units', 'unit'])

    const deposit = await line(co, 48.39)
    const inSplit = await split(co, deposit, [
      { category: 'other', amount: 30, scopeKind: 'split_by_units' },
      { category: 'other', amount: 18.39, scopeKind: 'property_common', propertyId: co.propertyId },
    ])
    expect([inSplit.status, inSplit.body.error]).toEqual([400, 'Part 1: money coming in is filed on a unit or a property'])
  })
})

describe('10/12 review: what a re-split keeps, and a line the bank voided', () => {
  const receiptOf = async (expenseId: string) => (await db.query(
    `SELECT receipt_url, receipt_name, vendor, utility_type FROM landlord_expenses WHERE id = $1`, [expenseId])).rows[0]
  const attach = (expenseId: string, name: string, extra = '') => db.query(
    `UPDATE landlord_expenses SET receipt_url = $2, receipt_name = $3, receipt_mime = 'application/pdf', receipt_size = 1000 ${extra}
      WHERE id = $1`, [expenseId, `/uploads/expense-receipts/${name}`, name])

  it('a receipt on the filed expense rides onto every new part when the line is split', async () => {
    const co = await company()
    const id = await line(co, -120.5, { description: 'HOME DEPOT #4410', merchant: 'HOME DEPOT' })
    const filed = await request(app()).post(`/api/bank-feed/transactions/${id}/categorize`).set(as(co))
      .send({ category: 'repairs', scopeKind: 'property_common', propertyId: co.propertyId })
    expect(filed.status).toBe(200)
    // The owner attached the receipt on the Expenses page and corrected the vendor.
    await attach(filed.body.data.expenseId, 'hd-4410.pdf', `, vendor = 'Home Depot Pro'`)
    const res = await split(co, id, [
      { category: 'repairs', amount: 80.5, scopeKind: 'unit', unitId: co.unitId },
      { category: 'supplies', amount: 40, scopeKind: 'property_common', propertyId: co.otherPropertyId },
    ])
    expect(res.status).toBe(200)
    for (const partId of res.body.data.expenseIds) {
      expect(await receiptOf(partId)).toMatchObject({ receipt_name: 'hd-4410.pdf', vendor: 'Home Depot Pro' })
    }
    // Still on the Expenses page (the voided filing is listed nowhere).
    const listed = await listLandlordExpenses(co.landlordId)
    expect(listed.filter((e: any) => e.receipt_name === 'hd-4410.pdf')).toHaveLength(2)
  })

  it('several receipts each stay with the part of the same category and amount; one that would be lost refuses the change', async () => {
    const co = await company()
    const id = await line(co, -120.5, { description: 'HOME DEPOT #4410', merchant: 'HOME DEPOT' })
    const first = await split(co, id, [
      { category: 'repairs', amount: 80.5, scopeKind: 'unit', unitId: co.unitId },
      { category: 'supplies', amount: 40, scopeKind: 'property_common', propertyId: co.otherPropertyId },
    ])
    const [repairsId, suppliesId] = first.body.data.expenseIds
    await attach(repairsId, 'repairs.pdf')
    await attach(suppliesId, 'supplies.pdf')
    // Moving the supplies part to the other property keeps both receipts where they were.
    const moved = await split(co, id, [
      { category: 'repairs', amount: 80.5, scopeKind: 'unit', unitId: co.unitId },
      { category: 'supplies', amount: 40, scopeKind: 'property_common', propertyId: co.propertyId },
    ])
    expect(moved.status).toBe(200)
    const [r2, s2] = moved.body.data.expenseIds
    expect((await receiptOf(r2)).receipt_name).toBe('repairs.pdf')
    expect((await receiptOf(s2)).receipt_name).toBe('supplies.pdf')
    // A change that would leave one of them on no part is refused, and nothing changes.
    const lost = await split(co, id, [
      { category: 'repairs', amount: 100.5, scopeKind: 'unit', unitId: co.unitId },
      { category: 'supplies', amount: 20, scopeKind: 'property_common', propertyId: co.propertyId },
    ])
    expect(lost.status).toBe(409)
    expect(lost.body.error).toMatch(/receipt/)
    expect((await expenseRows(id)).filter((r: any) => r.status === 'active').map((r: any) => r.id).sort()).toEqual([r2, s2].sort())
  })

  it('a part refused for its place says which part', async () => {
    const co = await company()
    const stranger = await company()
    const id = await line(co, 48.39)
    const res = await split(co, id, [
      { category: 'propane_fuel', amount: 30, scopeKind: 'property_common', propertyId: co.propertyId },
      { category: 'other', amount: 18.39, scopeKind: 'property_common', propertyId: stranger.propertyId },
    ])
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/^Part 2: /)
  })

  it('undoing the split of a line the bank voided sets it aside as the bank\'s void, not back in review', async () => {
    const co = await company()
    const id = await line(co, 48.39)
    expect((await split(co, id, nicsParts(co))).status).toBe(200)
    await db.query(`UPDATE bank_transactions SET bank_status = 'void' WHERE id = $1`, [id])
    const res = await unsplit(co, id)
    expect(res.status).toBe(200)
    const t = (await db.query(`SELECT status, ignored_reason FROM bank_transactions WHERE id = $1`, [id])).rows[0]
    expect(t).toEqual({ status: 'ignored', ignored_reason: 'bank_void' })
    expect((await incomeRows(id)).every((r: any) => r.status === 'voided')).toBe(true)
  })
})

describe('who may split, and what the books show', () => {
  it('Bank activity says what each part was filed as', async () => {
    const co = await company()
    const id = await line(co, 48.39)
    await split(co, id, nicsParts(co))
    const r = await request(app()).get('/api/financials/bank-activity?from=2026-10-01&to=2026-10-31').set(as(co))
    expect(r.status).toBe(200)
    const row = r.body.data.transactions.find((t: any) => t.id === id)
    expect(row.filedAs).toBe('Split: Propane / fuel $30.00, Other income $18.39')
    expect(row.statusLabel).toBe('Filed')
  })

  it('a bookkeeper cannot split (filing a bank line is the owner’s, as it always was)', async () => {
    const co = await company()
    const id = await line(co, 48.39)
    const bk = jwt.sign({ userId: co.userId, role: 'bookkeeper', email: 'bk@t.dev', profileId: co.landlordId,
      landlordIds: [co.landlordId], permissions: { access_level: 'read_write' } }, SECRET, { expiresIn: '1h' })
    const res = await request(app()).post(`/api/bank-feed/transactions/${id}/split`)
      .set({ Authorization: `Bearer ${bk}` }).send({ parts: nicsParts(co) })
    expect(res.status).toBe(403)
    expect(await incomeRows(id)).toHaveLength(0)
  })
})
