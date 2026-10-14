/**
 * 10/13 (Nic) — GAM Books: where a cost goes is picked when it is logged; a
 * fixed asset's money may come from several places (the routes).
 *
 *   Nic, 10/13: "each expense is chosen on the split or specific unit or
 *   property at the time of logging. there should never be a default setting
 *   to apply expenses." And on cash on hand: "they don't pick as a setting,
 *   they pick as the expense happens." And: "Funding: ALLOW A MIX (several
 *   funding lines adding up to the cost; a loan may spread over several
 *   assets)."
 *
 * What the forms can and cannot save, in the words the person reads: an
 * expense, a loan and an asset each name where their cost goes (a unit, a
 * property, or split across the properties by units) or nothing saves; a
 * unit or property that is not the company's is refused; an asset's funding
 * lines add up to its cost, a loan's lines never pass what it lent, an
 * expense is counted whole and once, and an asset owned before the books
 * start is not asked; an edit replaces the lines (kept on record).
 */
import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { db } from '../db'
import { cleanupAllSchema } from '../test/dbHelpers'
import { ledgerCompany, type LedgerCompany } from '../test/ledgerFixtures'
import { booksRouter } from './books'
import { expensesRouter } from './expenses'
import { errorHandler } from '../middleware/errorHandler'
import { EXPENSE_NO_PLACE, NOT_A_COST_SPLIT } from '../services/landlordExpenses'

function app() {
  const a = express()
  a.use(express.json())
  a.use('/api/books', booksRouter)
  a.use('/api/expenses', expensesRouter)
  a.use(errorHandler)
  return a
}

beforeEach(async () => {
  await cleanupAllSchema()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_books_place'
})

const sign = (p: object) => jwt.sign(p, process.env.JWT_SECRET!, { expiresIn: '1h' })
interface World { co: LedgerCompany; tok: string; other: LedgerCompany }
async function world(): Promise<World> {
  const co = await ledgerCompany({ booksStart: '2026-01-01' })
  const other = await ledgerCompany()
  return { co, other, tok: sign({ userId: co.ownerUserId, role: 'landlord', email: 'o@t.dev', profileId: null, landlordIds: [co.landlordId], permissions: {} }) }
}
const get = (w: World, url: string) => request(app()).get(url).set('Authorization', `Bearer ${w.tok}`)
const post = (w: World, url: string, body: unknown = {}) => request(app()).post(url).set('Authorization', `Bearer ${w.tok}`).send(body as object)
const patch = (w: World, url: string, body: unknown = {}) => request(app()).patch(url).set('Authorization', `Bearer ${w.tok}`).send(body as object)

const loanBody = (o: object = {}) => ({
  name: 'Deere loan', lenderName: 'Deere Financial', originalAmount: 10000, annualRate: 6, startDate: '2026-03-01', fundedTo: 'equipment', ...o,
})
const mower = (o: object = {}) => ({
  name: 'Riding mower', assetClass: 'equipment', cost: 8000, salvageValue: 0, acquiredOn: '2026-03-02', lifeYears: 5, ...o,
})

describe('the forms\' choices', () => {
  it('GET /books/cost-places: the company\'s properties and their units, and that the question is asked', async () => {
    const w = await world()
    const r = await get(w, '/api/books/cost-places')
    expect(r.status).toBe(200)
    expect(r.body.data.asked).toBe(true)
    expect(r.body.data.properties.map((p: any) => p.id).sort()).toEqual([w.co.propertyId, w.co.propertyId2].sort())
    expect(r.body.data.properties.find((p: any) => p.id === w.co.propertyId).units.map((u: any) => u.id)).toEqual([w.co.unitId])
  })
})

describe('an expense names where its cost goes', () => {
  it('nothing chosen is refused in words; a split names its company and no property', async () => {
    const w = await world()
    const none = await post(w, '/api/expenses', { category: 'insurance', amount: 400, expenseDate: '2026-10-05' })
    expect([none.status, none.body.error]).toEqual([400, EXPENSE_NO_PLACE])
    const split = await post(w, '/api/expenses', { category: 'insurance', amount: 400, expenseDate: '2026-10-05', costPlace: 'split_by_units',
      landlordId: w.co.landlordId })
    expect(split.status, JSON.stringify(split.body)).toBe(200)
    expect(split.body.data).toMatchObject({ cost_place: 'split_by_units', property_id: null, unit_id: null })
    const wrong = await post(w, '/api/expenses', { category: 'insurance', amount: 400, expenseDate: '2026-10-05', costPlace: 'split_by_units',
      propertyId: w.co.propertyId })
    expect([wrong.status, wrong.body.error]).toEqual([400, 'An expense split across your properties names no one property or unit.'])
    const unit = await post(w, '/api/expenses', { category: 'repairs', amount: 80, expenseDate: '2026-10-05', unitId: w.co.unitId })
    expect(unit.body.data).toMatchObject({ cost_place: 'unit', unit_id: w.co.unitId, property_id: w.co.propertyId })
    // Re-filed on one property, then split again.
    const moved = await patch(w, `/api/expenses/${unit.body.data.id}`, { propertyId: w.co.propertyId2, unitId: null })
    expect(moved.body.data).toMatchObject({ cost_place: 'property', property_id: w.co.propertyId2, unit_id: null })
    const splitAgain = await patch(w, `/api/expenses/${unit.body.data.id}`, { costPlace: 'split_by_units' })
    expect(splitAgain.body.data).toMatchObject({ cost_place: 'split_by_units', property_id: null, unit_id: null })
    const listed = await get(w, '/api/expenses')
    expect(listed.body.data.find((e: any) => e.id === split.body.data.id)).toMatchObject({ cost_place: 'split_by_units' })
  })

  it('a bookkeeper kept to some properties files on those: a split reaches every property, so it is refused in words', async () => {
    const w = await world()
    const bk = (await db.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
       VALUES ($1, 'x', 'bookkeeper', 'Nora', 'Narrow', TRUE) RETURNING id`, [`bkn-${w.co.landlordId}@test.dev`])).rows[0].id
    await db.query(`INSERT INTO bookkeeper_scopes (user_id, landlord_id, access_level, property_ids) VALUES ($1, $2, 'read_write', $3)`,
      [bk, w.co.landlordId, [w.co.propertyId]])
    const tok = sign({ userId: bk, role: 'bookkeeper', email: 'bkn@t.dev', profileId: null, landlordId: w.co.landlordId, permissions: { access_level: 'read_write' } })
    const split = await request(app()).post('/api/expenses').set('Authorization', `Bearer ${tok}`)
      .send({ category: 'insurance', amount: 40, expenseDate: '2026-10-05', costPlace: 'split_by_units' })
    expect([split.status, split.body.error]).toEqual([403,
      'Splitting a cost across all of the company\'s properties takes the whole company\'s books. Choose a property or unit you keep.'])
    const kept = await request(app()).post('/api/expenses').set('Authorization', `Bearer ${tok}`)
      .send({ category: 'insurance', amount: 40, expenseDate: '2026-10-05', propertyId: w.co.propertyId })
    expect(kept.status, JSON.stringify(kept.body)).toBe(200)
    expect(kept.body.data).toMatchObject({ cost_place: 'property', property_id: w.co.propertyId })
  })
})

describe('a loan names where its interest goes', () => {
  it('nothing chosen is refused; a property, a unit (its property comes with it) or a split; never another company\'s', async () => {
    const w = await world()
    const none = await post(w, '/api/books/loans', loanBody())
    expect([none.status, none.body.error]).toEqual([400,
      'Choose where this loan\'s interest goes: one unit, one property, or split across your properties by units.'])
    const split = await post(w, '/api/books/loans', loanBody({ costPlace: 'split_by_units' }))
    expect(split.status, JSON.stringify(split.body)).toBe(201)
    expect(split.body.data).toMatchObject({ cost_place: 'split_by_units', property_id: null, unit_id: null })
    const unit = await post(w, '/api/books/loans', loanBody({ name: 'Shop loan', costPlace: 'unit', unitId: w.co.unitId }))
    expect(unit.body.data).toMatchObject({ cost_place: 'unit', property_id: w.co.propertyId, unit_id: w.co.unitId, unit_number: expect.any(String) })
    const property = await post(w, '/api/books/loans', loanBody({ name: 'Oak loan', propertyId: w.co.propertyId2 }))
    expect(property.body.data).toMatchObject({ cost_place: 'property', property_id: w.co.propertyId2, unit_id: null })
    const theirs = await post(w, '/api/books/loans', loanBody({ costPlace: 'unit', unitId: w.other.unitId }))
    expect([theirs.status, theirs.body.error]).toEqual([404, 'That unit is not this company\'s.'])
    const notThere = await post(w, '/api/books/loans', loanBody({ costPlace: 'unit', unitId: w.co.unitId, propertyId: w.co.propertyId2 }))
    expect([notThere.status, notThere.body.error]).toEqual([400, 'That unit is not on that property.'])
    // An edit that does not say it again keeps it; one that does moves it.
    const renamed = await patch(w, `/api/books/loans/${unit.body.data.id}`, { name: 'Shop note' })
    expect(renamed.body.data).toMatchObject({ name: 'Shop note', cost_place: 'unit', unit_id: w.co.unitId })
    const moved = await patch(w, `/api/books/loans/${unit.body.data.id}`, { costPlace: 'split_by_units', propertyId: null, unitId: null })
    expect(moved.body.data).toMatchObject({ cost_place: 'split_by_units', property_id: null, unit_id: null })
  })
})

describe('a fixed asset names where it goes, and where each part of its money came from', () => {
  it('an $8,000 mower = $6,000 from a loan + $2,000 cash on hand; the same loan pays $4,000 of a trailer and no more', async () => {
    const w = await world()
    const deere = (await post(w, '/api/books/loans', loanBody({ costPlace: 'property', propertyId: w.co.propertyId }))).body.data.id
    const none = await post(w, '/api/books/fixed-assets', mower({ funding: [{ kind: 'cash', amount: 8000 }] }))
    expect([none.status, none.body.error]).toEqual([400,
      'Choose where this asset and its depreciation goes: one unit, one property, or split across your properties by units.'])
    const r = await post(w, '/api/books/fixed-assets', mower({ costPlace: 'property', propertyId: w.co.propertyId,
      funding: [{ kind: 'loan', amount: 6000, loanId: deere }, { kind: 'cash', amount: 2000 }] }))
    expect(r.status, JSON.stringify(r.body)).toBe(201)
    expect(r.body.data).toMatchObject({ cost_place: 'property', property_id: w.co.propertyId, funded_by: null, funded_loan_id: null })
    expect(r.body.data.funding.map((f: any) => [f.kind, Number(f.amount), f.loanId, f.loanName])).toEqual([
      ['loan', 6000, deere, 'Deere loan'], ['cash', 2000, null, null],
    ])
    // The loan says how much of it the assets used.
    expect(Number((await get(w, `/api/books/loans/${deere}`)).body.data.used_by_assets)).toBe(6000)
    const trailer = await post(w, '/api/books/fixed-assets', mower({ name: 'Trailer', cost: 4000, costPlace: 'split_by_units',
      funding: [{ kind: 'loan', amount: 4000, loanId: deere }] }))
    expect(trailer.status, JSON.stringify(trailer.body)).toBe(201)
    const edger = await post(w, '/api/books/fixed-assets', mower({ name: 'Edger', cost: 300, costPlace: 'split_by_units',
      funding: [{ kind: 'loan', amount: 300, loanId: deere }] }))
    expect([edger.status, edger.body.error]).toEqual([409,
      '"Deere loan" lent $10000.00, and $10000.00 of it already paid for other assets, so $0.00 of it is left for this one.'])
    // Lines that do not add up to the cost.
    const short = await post(w, '/api/books/fixed-assets', mower({ name: 'Blower', cost: 500, costPlace: 'split_by_units',
      funding: [{ kind: 'cash', amount: 400 }] }))
    expect([short.status, short.body.error]).toEqual([400,
      'Where the money came from adds up to $400.00, and it cost $500.00. The amounts must add up to what it cost.'])
    // One answer for the whole cost, or the list — never both.
    const both = await post(w, '/api/books/fixed-assets', mower({ costPlace: 'split_by_units', fundedBy: 'cash', funding: [{ kind: 'cash', amount: 8000 }] }))
    expect([both.status, both.body.error]).toEqual([400, 'Say where the money came from once: as the list of where each part came from.'])
    // Owned before the books start: not asked.
    const owned = await post(w, '/api/books/fixed-assets', mower({ acquiredOn: '2025-06-01', costPlace: 'split_by_units',
      funding: [{ kind: 'cash', amount: 8000 }] }))
    expect([owned.status, owned.body.error]).toEqual([400,
      'You owned this before your books start (2026-01-01), so it opens on them at its cost; where its money came from is not asked.'])
    // The loan cannot be voided under its assets.
    const v = await post(w, `/api/books/loans/${deere}/void`, { reason: 'typed twice' })
    expect([v.status, v.body.error]).toEqual([409, 'This loan paid for the fixed asset "Riding mower". Void the asset on the Fixed assets page first.'])
  })

  it('an edit says the lines again (the old ones kept, replaced); a new cost without them is refused', async () => {
    const w = await world()
    const r = await post(w, '/api/books/fixed-assets', mower({ costPlace: 'split_by_units',
      funding: [{ kind: 'cash', amount: 5000 }, { kind: 'owner', amount: 3000 }] }))
    expect(r.status, JSON.stringify(r.body)).toBe(201)
    const id = r.body.data.id
    const cost = await patch(w, `/api/books/fixed-assets/${id}`, { cost: 9000 })
    expect([cost.status, cost.body.error]).toEqual([400, 'You changed what it cost, what it is or the day you bought it: say again where its money came from, '
      + 'so the amounts still add up to what it cost and each loan still fits.'])
    const said = await patch(w, `/api/books/fixed-assets/${id}`, { cost: 9000, funding: [{ kind: 'owner', amount: 9000 }] })
    expect(said.status, JSON.stringify(said.body)).toBe(200)
    expect(said.body.data.funding.map((f: any) => [f.kind, Number(f.amount)])).toEqual([['owner', 9000]])
    const lines = (await db.query<{ kind: string; replaced: boolean }>(
      `SELECT kind, replaced_at IS NOT NULL AS replaced FROM books_fixed_asset_funding WHERE asset_id = $1 ORDER BY created_at, kind`, [id])).rows
    expect(lines.filter(l => l.replaced).length).toBe(2)
    expect(lines.filter(l => !l.replaced)).toEqual([{ kind: 'owner', replaced: false }])
    // Moved to one unit: its property comes with it.
    const unit = await patch(w, `/api/books/fixed-assets/${id}`, { costPlace: 'unit', unitId: w.co.unitId })
    expect(unit.body.data).toMatchObject({ cost_place: 'unit', unit_id: w.co.unitId, property_id: w.co.propertyId })
    // Corrected to a day before the books start: not asked any more (it opens at its cost), so its lines go.
    const owned = await patch(w, `/api/books/fixed-assets/${id}`, { acquiredOn: '2025-11-01', inServiceDate: '2025-11-01' })
    expect(owned.status, JSON.stringify(owned.body)).toBe(200)
    expect(owned.body.data).toMatchObject({ opens_at_books_start: true, funding: [] })
  })

  it('"already an expense" for a part: the expense counts whole, once, and it is no longer listed to link', async () => {
    const w = await world()
    const down = (await post(w, '/api/expenses', { category: 'supplies', amount: 2000, expenseDate: '2026-03-02', propertyId: w.co.propertyId,
      description: 'Mower down payment' })).body.data.id
    expect((await get(w, '/api/books/fixed-assets/linkable-expenses')).body.data.map((e: any) => e.id)).toEqual([down])
    const part = await post(w, '/api/books/fixed-assets', mower({ costPlace: 'split_by_units',
      funding: [{ kind: 'expense', amount: 1500, expenseId: down }, { kind: 'owner', amount: 6500 }] }))
    expect([part.status, part.body.error]).toEqual([400, 'An expense counts toward an asset whole: "Mower down payment" is $2000.00.'])
    // 10/13 review: an expense pays for part of an asset only where the asset is.
    const away = await post(w, '/api/books/fixed-assets', mower({ costPlace: 'property', propertyId: w.co.propertyId2,
      funding: [{ kind: 'expense', amount: 2000, expenseId: down }, { kind: 'owner', amount: 6000 }] }))
    expect([away.status, away.body.error]).toEqual([409, '"Mower down payment" is not filed where this asset goes. An expense pays for part of an asset only '
      + 'where the asset is: put the asset on the property the expense was filed on (or split it, for an expense split across your properties), '
      + 'or choose another expense.'])
    const r = await post(w, '/api/books/fixed-assets', mower({ costPlace: 'unit', unitId: w.co.unitId,
      funding: [{ kind: 'expense', amount: 2000, expenseId: down }, { kind: 'owner', amount: 6000 }] }))
    expect(r.status, JSON.stringify(r.body)).toBe(201)
    expect(r.body.data.funding.map((f: any) => [f.kind, f.expenseId, f.expenseDescription])).toEqual([
      ['expense', down, 'Mower down payment'], ['owner', null, null],
    ])
    expect((await get(w, '/api/books/fixed-assets/linkable-expenses')).body.data).toEqual([])
    const again = await post(w, '/api/books/fixed-assets', mower({ name: 'Second mower', cost: 2000, costPlace: 'split_by_units',
      funding: [{ kind: 'expense', amount: 2000, expenseId: down }] }))
    expect([again.status, again.body.error]).toEqual([409, 'That expense is already a fixed asset.'])
    // The expense keeps its amount and stays while the asset stands.
    expect((await patch(w, `/api/expenses/${down}`, { amount: 2500 })).status).toBe(409)
    expect((await post(w, `/api/expenses/${down}/void`, {})).status).toBe(409)
    // Moved off the expense's property without saying the lines again: refused at commit, in words.
    const moved = await patch(w, `/api/books/fixed-assets/${r.body.data.id}`, { costPlace: 'property', propertyId: w.co.propertyId2 })
    expect([moved.status, moved.body.error]).toEqual([409,
      'The expense "Mower down payment" is not filed where the fixed asset "Riding mower" goes. An expense pays for part of an asset only where the asset is.'])
  })

  it('two assets saved at the same moment never spread one loan past what it lent (the loan is locked while it is read)', async () => {
    const w = await world()
    const deere = (await post(w, '/api/books/loans', loanBody({ costPlace: 'split_by_units' }))).body.data.id
    const [a, b] = await Promise.all([
      post(w, '/api/books/fixed-assets', mower({ name: 'Mower A', cost: 6000, costPlace: 'split_by_units', funding: [{ kind: 'loan', amount: 6000, loanId: deere }] })),
      post(w, '/api/books/fixed-assets', mower({ name: 'Mower B', cost: 6000, costPlace: 'split_by_units', funding: [{ kind: 'loan', amount: 6000, loanId: deere }] })),
    ])
    expect([a.status, b.status].sort()).toEqual([201, 409])
    const refused = a.status === 409 ? a : b
    expect(refused.body.error).toBe('"Deere loan" lent $10000.00, and $6000.00 of it already paid for other assets, so $4000.00 of it is left for this one.')
    expect(Number((await get(w, `/api/books/loans/${deere}`)).body.data.used_by_assets)).toBe(6000)
  })
})

describe('10/13 review: what the forms are told and offered', () => {
  it('a bookkeeper with the whole-company ledger (not the company-wide box) reads the places the Loans, Fixed assets and Run Payroll forms ask from', async () => {
    const w = await world()
    const bk = (await db.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
       VALUES ($1, 'x', 'bookkeeper', 'Lee', 'Ledger', TRUE) RETURNING id`, [`bkl-${w.co.landlordId}@test.dev`])).rows[0].id
    await db.query(`INSERT INTO bookkeeper_scopes (user_id, landlord_id, access_level, property_ids, company_wide, company_ledger)
                    VALUES ($1, $2, 'read_write', $3, FALSE, TRUE)`, [bk, w.co.landlordId, [w.co.propertyId]])
    const tok = sign({ userId: bk, role: 'bookkeeper', email: 'bkl@t.dev', profileId: null, landlordId: w.co.landlordId, permissions: { access_level: 'read_write' } })
    const r = await request(app()).get('/api/books/cost-places').set('Authorization', `Bearer ${tok}`).set('X-Client-Id', w.co.landlordId)
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    expect(r.body.data.properties.map((p: any) => p.id).sort()).toEqual([w.co.propertyId, w.co.propertyId2].sort())
    // Without the ledger box it stays the company-wide box's, as the rest of the books.
    await db.query(`UPDATE bookkeeper_scopes SET company_ledger = FALSE WHERE user_id = $1`, [bk])
    const no = await request(app()).get('/api/books/cost-places').set('Authorization', `Bearer ${tok}`).set('X-Client-Id', w.co.landlordId)
    expect(no.status).toBe(403)
  })

  it('money out that is not a cost (an owner\'s draw) is never split; it goes on a unit, a property or the company', async () => {
    const w = await world()
    const split = await post(w, '/api/expenses', { category: 'owner_draw', amount: 500, expenseDate: '2026-10-05', costPlace: 'split_by_units',
      landlordId: w.co.landlordId })
    expect([split.status, split.body.error]).toEqual([400, `${NOT_A_COST_SPLIT('Owner draw')}`])
    const company = await post(w, '/api/expenses', { category: 'owner_draw', amount: 500, expenseDate: '2026-10-05', landlordId: w.co.landlordId })
    expect(company.status, JSON.stringify(company.body)).toBe(200)
    expect(company.body.data).toMatchObject({ cost_place: null, property_id: null, unit_id: null })
    const onProperty = await post(w, '/api/expenses', { category: 'owner_draw', amount: 200, expenseDate: '2026-10-05', propertyId: w.co.propertyId })
    expect(onProperty.body.data).toMatchObject({ cost_place: 'property', property_id: w.co.propertyId })
    // A cost with no place is still refused; a split cost re-filed under the draw is refused too.
    const cost = await post(w, '/api/expenses', { category: 'insurance', amount: 40, expenseDate: '2026-10-05', costPlace: 'split_by_units',
      landlordId: w.co.landlordId })
    expect(cost.status).toBe(200)
    const drawCat = (await db.query<{ id: string }>(
      `SELECT id FROM books_categories WHERE landlord_id = $1 AND direction = 'expense' AND system_key = 'owner_draw'`, [w.co.landlordId])).rows[0].id
    const recat = await patch(w, `/api/expenses/${cost.body.data.id}`, { categoryId: drawCat })
    expect([recat.status, recat.body.error]).toEqual([400, NOT_A_COST_SPLIT('Owner draw')])
    // The draw on the company re-filed as insurance must say where the cost goes.
    const insCat = (await db.query<{ id: string }>(
      `SELECT id FROM books_categories WHERE landlord_id = $1 AND direction = 'expense' AND system_key = 'insurance'`, [w.co.landlordId])).rows[0].id
    const toCost = await patch(w, `/api/expenses/${company.body.data.id}`, { categoryId: insCat })
    expect([toCost.status, toCost.body.error]).toEqual([400, EXPENSE_NO_PLACE])
  })

  it('the Expenses form is told whether a split is offered: the owner yes, a bookkeeper kept to some properties no', async () => {
    const w = await world()
    expect((await get(w, '/api/expenses/options')).body.data.canSplit).toBe(true)
    const bk = (await db.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
       VALUES ($1, 'x', 'bookkeeper', 'Nora', 'Narrow', TRUE) RETURNING id`, [`bko-${w.co.landlordId}@test.dev`])).rows[0].id
    await db.query(`INSERT INTO bookkeeper_scopes (user_id, landlord_id, access_level, property_ids) VALUES ($1, $2, 'read_write', $3)`,
      [bk, w.co.landlordId, [w.co.propertyId]])
    const tok = sign({ userId: bk, role: 'bookkeeper', email: 'bko@t.dev', profileId: null, landlordId: w.co.landlordId, permissions: { access_level: 'read_write' } })
    const r = await request(app()).get('/api/expenses/options').set('Authorization', `Bearer ${tok}`)
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    expect(r.body.data.canSplit).toBe(false)
  })
})
