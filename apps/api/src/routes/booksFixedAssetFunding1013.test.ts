/**
 * 10/13 (Nic) — GAM Books: the Fixed assets form ASKS where the money came
 * from (routes/booksLoansAssets.ts, on booksRouter).
 *
 *   Nic, 10/13: "Fixed asset typed by hand: the form ASKS where the money came
 *   from (cash on hand / owner put money in / loan / already an expense) and
 *   posts to that"; "hand-typed asset 'already an expense' → LINK that expense
 *   (cost moves to the asset)".
 *
 * What the page can and cannot do, in the words the person reads: an asset
 * bought on or after the books start must say where its money came from; one
 * bought before is not asked; a loan must be one whose money went straight to
 * the seller of what the asset is; "already an expense" takes the expense's
 * cost, day and property, and lists only an expense that is no asset yet; a
 * loan an asset stands on cannot be voided.
 *
 * 10/13 review: a loan and the asset it paid for sit on the same side of the
 * books start (a loan made before it never put the asset's cost on the books;
 * one made after it would put it there a second time) — on the form, when the
 * loan's day moves, and when the books start moves; and a repair's bill that
 * can still change with its repair (nothing paid on it yet) is no asset yet.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { db } from '../db'
import { cleanupAllSchema } from '../test/dbHelpers'
import { ledgerCompany, type LedgerCompany } from '../test/ledgerFixtures'
import { booksRouter } from './books'
import { booksSettingsRouter } from './booksSettings'
import { errorHandler } from '../middleware/errorHandler'
import { syncRepairBill } from '../services/repairBills'

function app() {
  const a = express()
  a.use(express.json())
  a.use('/api/books/setup', booksSettingsRouter)
  a.use('/api/books', booksRouter)
  a.use(errorHandler)
  return a
}

beforeEach(async () => {
  await cleanupAllSchema()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_books_la'
})

const sign = (p: object) => jwt.sign(p, process.env.JWT_SECRET!, { expiresIn: '1h' })

interface World { co: LedgerCompany; tok: string; other: LedgerCompany; otherTok: string }

async function world(): Promise<World> {
  const co = await ledgerCompany({ booksStart: '2026-01-01' })
  const other = await ledgerCompany()
  const tokFor = (c: LedgerCompany) => sign({ userId: c.ownerUserId, role: 'landlord', email: 'o@t.dev', profileId: null, landlordIds: [c.landlordId], permissions: {} })
  return { co, tok: tokFor(co), other, otherTok: tokFor(other) }
}

const get = (tok: string, url: string) => request(app()).get(`/api/books${url}`).set('Authorization', `Bearer ${tok}`)
const post = (tok: string, url: string, body: unknown = {}) => request(app()).post(`/api/books${url}`).set('Authorization', `Bearer ${tok}`).send(body as object)
const patch = (tok: string, url: string, body: unknown = {}) => request(app()).patch(`/api/books${url}`).set('Authorization', `Bearer ${tok}`).send(body as object)

const mower = (w: World) => ({
  name: 'Riding mower', propertyId: w.co.propertyId, assetClass: 'equipment', cost: 6000, salvageValue: 600,
  acquiredOn: '2026-02-15', inServiceDate: '2026-03-01', lifeYears: 5,
})

async function loan(w: World, fundedTo: 'bank' | 'property' | 'equipment', company = w.co): Promise<string> {
  return (await db.query<{ id: string }>(
    `INSERT INTO books_loans (landlord_id, property_id, name, lender_name, original_amount, annual_rate, start_date, funded_to)
     VALUES ($1, $2, $3, 'First Bank', 6000, 5, '2026-02-15', $4) RETURNING id`,
    [company.landlordId, company.propertyId, `Loan to ${fundedTo}`, fundedTo])).rows[0].id
}

describe('where the money for a hand-typed asset came from', () => {
  it('bought on or after the books start: asked, and refused without it; bought before: not asked', async () => {
    const w = await world()
    const none = await post(w.tok, '/fixed-assets', mower(w))
    expect(none.status).toBe(400)
    expect(none.body.error).toBe('Say where the money for it came from: cash on hand, the owner put money in, a loan, or already an expense.')
    const bad = await post(w.tok, '/fixed-assets', { ...mower(w), fundedBy: 'credit' })
    expect(bad.status).toBe(400)
    const cash = await post(w.tok, '/fixed-assets', { ...mower(w), fundedBy: 'cash' })
    expect(cash.status, JSON.stringify(cash.body)).toBe(201)
    expect(cash.body.data).toMatchObject({ funded_by: 'cash', funded_loan_id: null, source_expense_id: null })
    const owned = await post(w.tok, '/fixed-assets', { ...mower(w), acquiredOn: '2025-05-01', inServiceDate: '2025-05-01' })
    expect(owned.status, JSON.stringify(owned.body)).toBe(201)
    expect(owned.body.data).toMatchObject({ funded_by: null, opens_at_books_start: true })
  })

  it('a loan: the company\'s own, live, and one whose money went straight to the seller of what this is', async () => {
    const w = await world()
    const noLoan = await post(w.tok, '/fixed-assets', { ...mower(w), fundedBy: 'loan' })
    expect(noLoan.status).toBe(400)
    expect(noLoan.body.error).toMatch(/Choose the loan/)
    const intoBank = await post(w.tok, '/fixed-assets', { ...mower(w), fundedBy: 'loan', fundedLoanId: await loan(w, 'bank') })
    expect(intoBank.status).toBe(409)
    expect(intoBank.body.error).toMatch(/went into your bank account.*"Already an expense"/)
    const property = await post(w.tok, '/fixed-assets', { ...mower(w), fundedBy: 'loan', fundedLoanId: await loan(w, 'property') })
    expect(property.status).toBe(409)
    expect(property.body.error).toMatch(/paid the seller of a property; this asset is equipment or a vehicle/)
    const theirs = await post(w.tok, '/fixed-assets', { ...mower(w), fundedBy: 'loan', fundedLoanId: await loan(w, 'equipment', w.other) })
    expect(theirs.status).toBe(404)
    const equipment = await loan(w, 'equipment')
    const ok = await post(w.tok, '/fixed-assets', { ...mower(w), fundedBy: 'loan', fundedLoanId: equipment })
    expect(ok.status, JSON.stringify(ok.body)).toBe(201)
    expect(ok.body.data).toMatchObject({ funded_by: 'loan', funded_loan_id: equipment, funded_loan_name: 'Loan to equipment' })
    // A loan an asset stands on is not voided under it.
    const v = await post(w.tok, `/loans/${equipment}/void`, { reason: 'typed twice' })
    expect(v.status).toBe(409)
    expect(v.body.error).toMatch(/paid for the fixed asset "Riding mower"\. Void the asset on the Fixed assets page first/)
  })

  it('"already an expense": the expense is linked — its cost, day and property are the asset\'s; listed only until it is one', async () => {
    const w = await world()
    await db.query(`SELECT books_seed_categories($1)`, [w.co.landlordId])
    const repairs = (await db.query<{ id: string }>(
      `SELECT id FROM books_categories WHERE landlord_id = $1 AND direction = 'expense' AND system_key = 'repairs'`, [w.co.landlordId])).rows[0].id
    const roof = (await db.query<{ id: string }>(
      `INSERT INTO landlord_expenses (landlord_id, property_id, category, category_id, amount, expense_date, description, payments_tracked)
       VALUES ($1, $2, 'other', $3, 12000, '2026-02-10', 'New roof', TRUE) RETURNING id`, [w.co.landlordId, w.co.propertyId2, repairs])).rows[0].id
    const listed = await get(w.tok, '/fixed-assets/linkable-expenses')
    expect(listed.status).toBe(200)
    expect(listed.body.data.map((e: any) => [e.id, e.amount, e.category_name])).toEqual([[roof, 12000, 'Repairs']])
    expect((await get(w.otherTok, '/fixed-assets/linkable-expenses')).body.data).toEqual([])
    const missing = await post(w.tok, '/fixed-assets', { name: 'New roof', assetClass: 'improvement', lifeYears: 10, fundedBy: 'expense' })
    expect(missing.status).toBe(400)
    expect(missing.body.error).toBe('Choose the expense it was.')
    const theirs = await post(w.otherTok, '/fixed-assets', { name: 'New roof', assetClass: 'improvement', lifeYears: 10, fundedBy: 'expense', expenseId: roof })
    expect(theirs.status).toBe(404)
    const r = await post(w.tok, '/fixed-assets', {
      name: 'New roof', assetClass: 'improvement', lifeYears: 10, fundedBy: 'expense', expenseId: roof,
      cost: 1, acquiredOn: '2026-09-01', propertyId: w.co.propertyId,   // ignored: the expense's are the asset's
    })
    expect(r.status, JSON.stringify(r.body)).toBe(201)
    expect(r.body.data).toMatchObject({ cost: '12000.00', acquired_on: '2026-02-10', property_id: w.co.propertyId2,
      source_expense_id: roof, funded_by: 'expense', monthly: 100 })
    expect((await get(w.tok, '/fixed-assets/linkable-expenses')).body.data).toEqual([])
    const again = await post(w.tok, '/fixed-assets', { name: 'Roof', assetClass: 'improvement', lifeYears: 10, fundedBy: 'expense', expenseId: roof })
    expect(again.status).toBe(409)
    expect(again.body.error).toBe('That expense is already a fixed asset.')
    // Its cost and day are the expense's; so is what paid for it.
    const id = r.body.data.id
    expect((await patch(w.tok, `/fixed-assets/${id}`, { cost: 5 })).status).toBe(409)
    const swap = await patch(w.tok, `/fixed-assets/${id}`, { fundedBy: 'cash' })
    expect(swap.status).toBe(409)
    expect(swap.body.error).toMatch(/made from an expense, so the expense paid for it/)
  })

  it('an expense that is no purchase cannot be one', async () => {
    const w = await world()
    const draw = (await db.query<{ id: string }>(
      `INSERT INTO books_categories (landlord_id, direction, name, default_role) VALUES ($1, 'expense', 'Owner draw', 'owner_draws') RETURNING id`,
      [w.co.landlordId])).rows[0].id
    const e = (await db.query<{ id: string }>(
      `INSERT INTO landlord_expenses (landlord_id, category, category_id, amount, expense_date, payments_tracked)
       VALUES ($1, 'other', $2, 500, '2026-02-10', TRUE) RETURNING id`, [w.co.landlordId, draw])).rows[0].id
    expect((await get(w.tok, '/fixed-assets/linkable-expenses')).body.data).toEqual([])
    const r = await post(w.tok, '/fixed-assets', { name: 'Draw', assetClass: 'equipment', lifeYears: 5, fundedBy: 'expense', expenseId: e })
    expect(r.status).toBe(409)
    expect(r.body.error).toMatch(/not a purchase/)
  })

  it('an edit may say or correct where the money came from; an expense is linked only when the asset is added', async () => {
    const w = await world()
    // Entered before 10/13: nothing said — an edit of its name still saves.
    const legacy = (await db.query<{ id: string }>(
      `INSERT INTO books_fixed_assets (landlord_id, property_id, name, asset_class, cost, salvage_value, acquired_on, in_service_date, life_years)
       VALUES ($1, $2, 'Old mower', 'equipment', 6000, 600, '2026-02-15', '2026-03-01', 5) RETURNING id`, [w.co.landlordId, w.co.propertyId])).rows[0].id
    expect((await patch(w.tok, `/fixed-assets/${legacy}`, { name: 'Older mower' })).status).toBe(200)
    const said = await patch(w.tok, `/fixed-assets/${legacy}`, { fundedBy: 'owner' })
    expect(said.status, JSON.stringify(said.body)).toBe(200)
    expect(said.body.data).toMatchObject({ funded_by: 'owner' })
    const link = await patch(w.tok, `/fixed-assets/${legacy}`, { fundedBy: 'expense' })
    expect(link.status).toBe(409)
    expect(link.body.error).toMatch(/void this asset and add it again as "Already an expense"/)
    // A class the loan did not buy is refused on an edit too.
    const equipment = await loan(w, 'equipment')
    expect((await patch(w.tok, `/fixed-assets/${legacy}`, { fundedBy: 'loan', fundedLoanId: equipment })).status).toBe(200)
    const building = await patch(w.tok, `/fixed-assets/${legacy}`, { assetClass: 'building', lifeYears: 39 })
    expect(building.status).toBe(409)
    expect(building.body.error).toMatch(/paid the seller of equipment or a vehicle/)
    const back = await patch(w.tok, `/fixed-assets/${legacy}`, { fundedBy: 'cash' })
    expect(back.status).toBe(200)
    expect(back.body.data).toMatchObject({ funded_by: 'cash', funded_loan_id: null })
  })
})

describe('a loan and the asset it paid for sit on the same side of the books start (10/13 review)', () => {
  async function loanOn(w: World, startDate: string): Promise<string> {
    return (await db.query<{ id: string }>(
      `INSERT INTO books_loans (landlord_id, property_id, name, lender_name, original_amount, annual_rate, start_date, funded_to, opening_balance)
       VALUES ($1, $2, 'Deere loan', 'Deere Financial', 6000, 5, $3, 'equipment', CASE WHEN $3::date < '2026-01-01' THEN 5800 END) RETURNING id`,
      [w.co.landlordId, w.co.propertyId, startDate])).rows[0].id
  }

  it('the form: a loan made before the books start is refused for an asset bought after it, and the other way round', async () => {
    const w = await world()   // books start 2026-01-01
    const before = await loanOn(w, '2025-12-20')
    const a = await post(w.tok, '/fixed-assets', { ...mower(w), acquiredOn: '2026-01-05', inServiceDate: '2026-01-05', fundedBy: 'loan', fundedLoanId: before })
    expect(a.status).toBe(409)
    expect(a.body.error).toBe('"Deere loan" was made on 2025-12-20, before your books start (2026-01-01), so your books open with what was still owed on it ' +
      'and its money never put this asset\'s cost on them. If it paid for this asset, the asset was bought before your books start too: enter the day the loan paid the seller.')
    // Bought before the books start too: it opens there at its cost, as the loan does — allowed.
    const both = await post(w.tok, '/fixed-assets', { ...mower(w), acquiredOn: '2025-12-20', inServiceDate: '2025-12-20', fundedBy: 'loan', fundedLoanId: before })
    expect(both.status, JSON.stringify(both.body)).toBe(201)
    expect(both.body.data).toMatchObject({ opens_at_books_start: true })
    // A loan made after the start posts the cost itself; an asset bought before it opens with its cost too.
    const after = await loanOn(w, '2026-02-15')
    const twice = await post(w.tok, '/fixed-assets', { ...mower(w), acquiredOn: '2025-12-01', inServiceDate: '2025-12-01', fundedBy: 'loan', fundedLoanId: after })
    expect(twice.status).toBe(409)
    expect(twice.body.error).toMatch(/^"Deere loan" was made on 2026-02-15, on or after your books start \(2026-01-01\), and put this asset's cost on your books that day\. .*would count twice: check the day you bought it\.$/)
    // An edit that moves the asset across the start is refused the same way.
    const ok = await post(w.tok, '/fixed-assets', { ...mower(w), fundedBy: 'loan', fundedLoanId: after })
    expect(ok.status, JSON.stringify(ok.body)).toBe(201)
    const moved = await patch(w.tok, `/fixed-assets/${ok.body.data.id}`, { acquiredOn: '2025-12-01', inServiceDate: '2025-12-01' })
    expect(moved.status).toBe(409)
    expect(moved.body.error).toMatch(/would count twice/)
    expect((await db.query(`SELECT acquired_on::text AS d FROM books_fixed_assets WHERE id = $1`, [ok.body.data.id])).rows[0].d).toBe('2026-02-15')
  })

  it('while the asset stands, the loan\'s day does not move across the books start, nor the books start between them', async () => {
    const w = await world()
    const deere = await loanOn(w, '2026-02-10')
    const a = await post(w.tok, '/fixed-assets', { ...mower(w), fundedBy: 'loan', fundedLoanId: deere })   // bought 2026-02-15
    expect(a.status, JSON.stringify(a.body)).toBe(201)
    // The loan's day: within the same side, fine; across the start, refused.
    expect((await patch(w.tok, `/loans/${deere}`, { startDate: '2026-02-12' })).status).toBe(200)
    const across = await patch(w.tok, `/loans/${deere}`, { startDate: '2025-12-20', openingBalance: 5800 })
    expect(across.status).toBe(409)
    expect(across.body.error).toBe('This loan paid for the fixed asset "Riding mower", bought on 2026-02-15. Your books start on 2026-01-01, and the loan\'s day ' +
      'cannot be on the other side of that day from the asset\'s (the asset\'s cost would count twice, or not at all). Change the asset\'s day on the Fixed assets page first.')
    expect((await db.query(`SELECT start_date::text AS d FROM books_loans WHERE id = $1`, [deere])).rows[0].d).toBe('2026-02-12')
    // The books start: before both, or after both, is fine; between them is refused, on Books settings and in the database.
    const between = await patch(w.tok, '/setup/settings', { historyStart: 'start_date', startDate: '2026-02-14' })
    expect(between.status).toBe(409)
    expect(between.body.error).toBe('Your books cannot start on 2026-02-14: the fixed asset "Riding mower" (bought on 2026-02-15) and the loan "Deere loan" ' +
      'that paid for it (made on 2026-02-12) would be on different sides of that day, so the asset\'s cost would count twice, or not at all. ' +
      'Change the asset\'s day or the loan\'s first.')
    await expect(db.query(`UPDATE landlords SET books_start_date = '2026-02-13' WHERE id = $1`, [w.co.landlordId]))
      .rejects.toThrow(/Your books cannot start on 2026-02-13/)
    expect((await db.query(`SELECT books_start_date::text AS d FROM landlords WHERE id = $1`, [w.co.landlordId])).rows[0].d).toBe('2026-01-01')
    const earlier = await patch(w.tok, '/setup/settings', { historyStart: 'start_date', startDate: '2025-12-01' })
    expect(earlier.status, JSON.stringify(earlier.body)).toBe(200)
    // Once voided, the asset holds nothing.
    expect((await post(w.tok, `/fixed-assets/${a.body.data.id}/void`, { reason: 'typed twice' })).status).toBe(200)
    expect((await db.query(`UPDATE landlords SET books_start_date = '2026-02-14' WHERE id = $1 RETURNING id`, [w.co.landlordId])).rowCount).toBe(1)
  })
})

describe('a repair\'s bill that can still change with its repair (10/13 review)', () => {
  it('is no asset until something is paid on it; once paid, the repair\'s own sync leaves the bill, and so the asset, alone', async () => {
    const w = await world()
    await db.query(`UPDATE landlords SET books_repair_bills = 'automatic' WHERE id = $1`, [w.co.landlordId])
    const job = (await db.query<{ id: string }>(
      `INSERT INTO maintenance_requests (unit_id, landlord_id, title, description, status, actual_cost, completed_at)
       VALUES ($1, $2, 'Roof', 'Leaks', 'completed', 12000, '2026-02-10 18:00:00+00') RETURNING id`, [w.co.unitId, w.co.landlordId])).rows[0].id
    const bill = await syncRepairBill(job, null)
    expect(bill).toBeTruthy()
    // Unpaid: it still follows the repair — not listed, refused on both paths.
    expect((await get(w.tok, '/fixed-assets/linkable-expenses')).body.data).toEqual([])
    const refusal = 'That expense is the bill for a repair, and nothing is paid on it yet, so it can still change with the repair ' +
      '(its cost or day corrected). Record what was paid on it first, then make it a fixed asset.'
    const linked = await post(w.tok, '/fixed-assets', { name: 'New roof', assetClass: 'improvement', lifeYears: 10, fundedBy: 'expense', expenseId: bill })
    expect(linked.status).toBe(409)
    expect(linked.body.error).toBe(refusal)
    const capital = (await db.query<{ id: string }>(
      `INSERT INTO books_categories (landlord_id, direction, name, default_role) VALUES ($1, 'expense', 'Capital improvements', 'rental_property') RETURNING id`,
      [w.co.landlordId])).rows[0].id
    const repairs = (await db.query<{ c: string }>(`SELECT category_id AS c FROM landlord_expenses WHERE id = $1`, [bill])).rows[0].c
    await db.query(`UPDATE landlord_expenses SET category_id = $2 WHERE id = $1`, [bill, capital])
    expect((await get(w.tok, '/fixed-assets/capital-expenses')).body.data).toEqual([])
    const fromExpense = await post(w.tok, `/fixed-assets/from-expense/${bill}`, { assetClass: 'improvement', lifeYears: 10 })
    expect(fromExpense.status).toBe(409)
    expect(fromExpense.body.error).toBe(refusal)
    await db.query(`UPDATE landlord_expenses SET category_id = $2 WHERE id = $1`, [bill, repairs])
    // A payment on it: the sync leaves it alone from here, so it can be an asset.
    await db.query(
      `INSERT INTO landlord_expense_payments (expense_id, landlord_id, paid_on, amount, method, source) VALUES ($1, $2, '2026-02-20', 2000, 'cash', 'payment')`,
      [bill, w.co.landlordId])
    expect((await get(w.tok, '/fixed-assets/linkable-expenses')).body.data.map((e: any) => [e.id, e.amount])).toEqual([[bill, 12000]])
    const r = await post(w.tok, '/fixed-assets', { name: 'New roof', assetClass: 'improvement', lifeYears: 10, fundedBy: 'expense', expenseId: bill })
    expect(r.status, JSON.stringify(r.body)).toBe(201)
    expect(r.body.data).toMatchObject({ cost: '12000.00', acquired_on: '2026-02-10', source_expense_id: bill })
    // The repair's cost corrected afterwards: the bill (and so the asset) stays as it was.
    await db.query(`UPDATE maintenance_requests SET actual_cost = 11500 WHERE id = $1`, [job])
    expect(await syncRepairBill(job, null)).toBeNull()
    const after = (await db.query<{ amount: string; cost: string }>(
      `SELECT e.amount::text AS amount, a.cost::text AS cost FROM landlord_expenses e JOIN books_fixed_assets a ON a.source_expense_id = e.id
        WHERE e.id = $1`, [bill])).rows[0]
    expect(after).toEqual({ amount: '12000.00', cost: '12000.00' })
  })
})
