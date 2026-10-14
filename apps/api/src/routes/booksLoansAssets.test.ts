/**
 * 10/12 (Nic) — GAM Books: the Loans and Fixed assets routes
 * (routes/booksLoansAssets.ts, on booksRouter).
 *
 *   Nic 10/12: "loans/mortgages (principal / interest / escrow per payment)
 *   and fixed assets with depreciation ARE IN THIS BUILD."
 *
 * What a page can and cannot do, in the words the person reads: a loan made
 * before the books start needs what was owed that day; one made after says
 * where its money went; a payment's parts add up to it and never pay more
 * principal than is owed; a payment that is a bank line is changed on the
 * Bank page; an asset's life is whole months, land has none, depreciation
 * already taken is only for an asset owned before the books start; only an
 * expense filed under a capital-improvement category becomes an asset.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { randomUUID } from 'crypto'
import { db } from '../db'
import { cleanupAllSchema } from '../test/dbHelpers'
import { ledgerCompany, type LedgerCompany } from '../test/ledgerFixtures'
import { booksRouter } from './books'
import { errorHandler } from '../middleware/errorHandler'

function app() {
  const a = express()
  a.use(express.json())
  a.use('/api/books', booksRouter)
  a.use(errorHandler)
  return a
}

beforeEach(async () => {
  await cleanupAllSchema()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_books_la'
})

const sign = (p: object) => jwt.sign(p, process.env.JWT_SECRET!, { expiresIn: '1h' })

interface World { co: LedgerCompany; tok: string; bank: string; other: LedgerCompany; otherTok: string }

async function world(): Promise<World> {
  const co = await ledgerCompany({ booksStart: '2026-01-01' })
  const other = await ledgerCompany()
  const bank = (await db.query<{ id: string }>(
    `INSERT INTO bank_connections (landlord_id, provider, institution_name, account_last4) VALUES ($1, 'csv', 'First Bank', '4321') RETURNING id`,
    [co.landlordId])).rows[0].id
  const tokFor = (c: LedgerCompany) => sign({ userId: c.ownerUserId, role: 'landlord', email: 'o@t.dev', profileId: null, landlordIds: [c.landlordId], permissions: {} })
  return { co, tok: tokFor(co), bank, other, otherTok: tokFor(other) }
}

const get = (tok: string, url: string) => request(app()).get(`/api/books${url}`).set('Authorization', `Bearer ${tok}`)
const post = (tok: string, url: string, body: unknown = {}) => request(app()).post(`/api/books${url}`).set('Authorization', `Bearer ${tok}`).send(body as object)
const patch = (tok: string, url: string, body: unknown = {}) => request(app()).patch(`/api/books${url}`).set('Authorization', `Bearer ${tok}`).send(body as object)

const loanForm = (w: World) => ({
  name: 'Oak Street mortgage', lenderName: 'First Bank', propertyId: w.co.propertyId, originalAmount: 120000, annualRate: 6,
  startDate: '2026-02-01', paymentAmount: 1200, escrowAmount: 200, paymentDay: 1, fundedTo: 'bank', fundedBankConnectionId: w.bank,
})

describe('loans', () => {
  it('adds a loan, lists it with what is owed, and shows it to no other company', async () => {
    const w = await world()
    const made = await post(w.tok, '/loans', loanForm(w))
    expect(made.status).toBe(201)
    expect(made.body.data).toMatchObject({ name: 'Oak Street mortgage', state: 'active', balance: 120000, escrow_held: 0,
      opens_at_books_start: false, property_name: expect.any(String) })
    const list = await get(w.tok, '/loans')
    expect(list.body.data.map((l: any) => l.id)).toEqual([made.body.data.id])
    expect((await get(w.otherTok, `/loans/${made.body.data.id}`)).status).toBe(404)
    expect((await get(w.otherTok, '/loans')).body.data).toEqual([])
  })

  it('made before the books start needs what was owed that day; made after needs where the money went', async () => {
    const w = await world()
    const early = await post(w.tok, '/loans', { ...loanForm(w), startDate: '2019-05-01', fundedTo: '', fundedBankConnectionId: '' })
    expect(early.status).toBe(400)
    expect(early.body.error).toMatch(/before your books start \(2026-01-01\)/)
    const ok = await post(w.tok, '/loans', { ...loanForm(w), startDate: '2019-05-01', fundedTo: '', fundedBankConnectionId: '',
      openingBalance: 98000, openingEscrow: 1500 })
    expect(ok.status).toBe(201)
    expect(ok.body.data).toMatchObject({ opens_at_books_start: true, balance: 98000, escrow_held: 1500 })
    const noWhere = await post(w.tok, '/loans', { ...loanForm(w), fundedTo: '', fundedBankConnectionId: '' })
    expect(noWhere.status).toBe(400)
    expect(noWhere.body.error).toMatch(/where the money from this loan went/)
  })

  it('refuses another company\'s bank account or property, and escrow bigger than the payment', async () => {
    const w = await world()
    const theirBank = (await db.query<{ id: string }>(
      `INSERT INTO bank_connections (landlord_id, provider) VALUES ($1, 'csv') RETURNING id`, [w.other.landlordId])).rows[0].id
    expect((await post(w.tok, '/loans', { ...loanForm(w), fundedBankConnectionId: theirBank })).status).toBe(404)
    expect((await post(w.tok, '/loans', { ...loanForm(w), propertyId: w.other.propertyId })).status).toBe(404)
    const esc = await post(w.tok, '/loans', { ...loanForm(w), escrowAmount: 1300 })
    expect(esc.status).toBe(400)
    expect(esc.body.error).toMatch(/escrow part cannot be more/)
  })

  it('a payment: GAM suggests the split; the parts must add up; never more principal than is owed', async () => {
    const w = await world()
    const id = (await post(w.tok, '/loans', loanForm(w))).body.data.id
    const s = await get(w.tok, `/loans/${id}/suggest?paidOn=2026-03-01`)
    expect(s.body.data).toEqual({ principal: 400, interest: 600, escrow: 200, balanceBefore: 120000 })
    const bad = await post(w.tok, `/loans/${id}/payments`, { paidOn: '2026-03-01', amount: 1200, principal: 400, interest: 600, escrow: 100, method: 'bank' })
    expect(bad.status).toBe(400)
    expect(bad.body.error).toMatch(/add up to the payment/)
    const ok = await post(w.tok, `/loans/${id}/payments`, { paidOn: '2026-03-01', amount: 1200, principal: 400, interest: 600, escrow: 200,
      method: 'bank', bankConnectionId: w.bank })
    expect(ok.status).toBe(201)
    const tooMuch = await post(w.tok, `/loans/${id}/payments`, { paidOn: '2026-04-01', amount: 200000, principal: 200000, interest: 0, escrow: 0, method: 'bank' })
    expect(tooMuch.status).toBe(409)
    expect(tooMuch.body.error).toMatch(/more principal than is still owed/)
    const before = await post(w.tok, `/loans/${id}/payments`, { paidOn: '2026-01-15', amount: 100, principal: 100, interest: 0, escrow: 0, method: 'card' })
    expect(before.status).toBe(400)
    const detail = await get(w.tok, `/loans/${id}`)
    expect(detail.body.data).toMatchObject({ balance: 119600, escrow_held: 200, interest_paid: 600, payments: 1 })
    expect(detail.body.data.paymentsList).toHaveLength(1)
  })

  it('a payment typed by mistake is voided (kept); one that is a bank line is changed on the Bank page', async () => {
    const w = await world()
    const id = (await post(w.tok, '/loans', loanForm(w))).body.data.id
    const p = (await post(w.tok, `/loans/${id}/payments`, { paidOn: '2026-03-01', amount: 1200, principal: 400, interest: 600, escrow: 200, method: 'bank' })).body.data.id
    const noReason = await post(w.tok, `/loans/${id}/payments/${p}/void`, {})
    expect(noReason.status).toBe(400)
    expect((await post(w.tok, `/loans/${id}/payments/${p}/void`, { reason: 'typed twice' })).status).toBe(200)
    expect((await db.query(`SELECT void_reason FROM books_loan_payments WHERE id = $1`, [p])).rows[0].void_reason).toBe('typed twice')
    const line = (await db.query<{ id: string }>(
      `INSERT INTO bank_transactions (bank_connection_id, landlord_id, external_id, posted_date, amount)
       VALUES ($1, $2, 'x1', '2026-04-01', -1200) RETURNING id`, [w.bank, w.co.landlordId])).rows[0].id
    const matched = (await db.query<{ id: string }>(
      `INSERT INTO books_loan_payments (loan_id, landlord_id, paid_on, amount, principal, interest, escrow, method, bank_transaction_id, source)
       VALUES ($1, $2, '2026-04-01', 1200, 400, 600, 200, 'bank', $3, 'bank_line') RETURNING id`, [id, w.co.landlordId, line])).rows[0].id
    const r = await post(w.tok, `/loans/${id}/payments/${matched}/void`, { reason: 'wrong' })
    expect(r.status).toBe(409)
    expect(r.body.error).toMatch(/Bank page/)
    const v = await post(w.tok, `/loans/${id}/void`, { reason: 'entered by mistake' })
    expect(v.status).toBe(409)
  })

  it('voiding a loan voids its payments with it (kept on record); a voided loan does not change', async () => {
    const w = await world()
    const id = (await post(w.tok, '/loans', loanForm(w))).body.data.id
    await post(w.tok, `/loans/${id}/payments`, { paidOn: '2026-03-01', amount: 1200, principal: 400, interest: 600, escrow: 200, method: 'bank' })
    expect((await post(w.tok, `/loans/${id}/void`, { reason: 'entered by mistake' })).status).toBe(200)
    expect((await db.query(`SELECT count(*)::int AS n FROM books_loan_payments WHERE loan_id = $1 AND voided_at IS NOT NULL`, [id])).rows[0].n).toBe(1)
    expect((await get(w.tok, '/loans')).body.data).toEqual([])
    expect((await get(w.tok, '/loans?includeVoided=true')).body.data[0]).toMatchObject({ state: 'voided', void_reason: 'entered by mistake' })
    expect((await patch(w.tok, `/loans/${id}`, { name: 'x' })).status).toBe(409)
  })

  it('a change keeps what is owed at or above nothing', async () => {
    const w = await world()
    const id = (await post(w.tok, '/loans', loanForm(w))).body.data.id
    await post(w.tok, `/loans/${id}/payments`, { paidOn: '2026-03-01', amount: 1200, principal: 1000, interest: 0, escrow: 200, method: 'bank' })
    const r = await patch(w.tok, `/loans/${id}`, { originalAmount: 500 })
    expect(r.status).toBe(409)
    expect(r.body.error).toMatch(/principal already paid is more than the loan/)
    const ok = await patch(w.tok, `/loans/${id}`, { name: 'Oak St. first mortgage', propertyId: w.co.propertyId2 })
    expect(ok.status).toBe(200)
    expect(ok.body.data).toMatchObject({ name: 'Oak St. first mortgage', property_id: w.co.propertyId2, balance: 119000 })
  })

  it('form options: the company\'s bank accounts and its books start date', async () => {
    const w = await world()
    const r = await get(w.tok, '/loans/form-options')
    expect(r.body.data).toMatchObject({ booksStartDate: '2026-01-01', bankAccounts: [{ id: w.bank, name: 'First Bank', account_last4: '4321' }] })
  })
})

describe('fixed assets', () => {
  const assetForm = (w: World) => ({
    name: 'Clubhouse', propertyId: w.co.propertyId, assetClass: 'building', cost: 330000, salvageValue: 0,
    acquiredOn: '2015-01-10', inServiceDate: '2015-02-01', lifeYears: 27.5,
  })

  it('adds an asset bought before the books start; its figures read the straight-line schedule', async () => {
    const w = await world()
    const r = await post(w.tok, '/fixed-assets', assetForm(w))
    expect(r.status).toBe(201)
    expect(r.body.data).toMatchObject({ name: 'Clubhouse', opens_at_books_start: true, depreciates: true, monthly: 1000,
      life_ends: '2042-07-31', problem: null })
    // Every month that ended by today is depreciation so far.
    const today: string = r.body.data.today
    const ended = (Number(today.slice(0, 4)) - 2015) * 12 + Number(today.slice(5, 7)) - 2
    expect(r.body.data.depreciated_to_date).toBe(ended * 1000)
    expect(r.body.data.book_value).toBe(330000 - ended * 1000)
  })

  it('life in whole months; land has none; depreciation already taken only before the books start', async () => {
    const w = await world()
    const odd = await post(w.tok, '/fixed-assets', { ...assetForm(w), lifeYears: 27.3 })
    expect(odd.status).toBe(400)
    expect(odd.body.error).toMatch(/whole number of months/)
    const land = await post(w.tok, '/fixed-assets', { ...assetForm(w), assetClass: 'land', lifeYears: 30 })
    expect(land.status).toBe(400)
    expect(land.body.error).toMatch(/Land never wears out/)
    expect((await post(w.tok, '/fixed-assets', { ...assetForm(w), assetClass: 'land', lifeYears: '' })).status).toBe(201)
    const noLife = await post(w.tok, '/fixed-assets', { ...assetForm(w), lifeYears: '' })
    expect(noLife.status).toBe(400)
    const prior = await post(w.tok, '/fixed-assets', { ...assetForm(w), acquiredOn: '2026-03-01', inServiceDate: '2026-03-01', priorDepreciation: 5000 })
    expect(prior.status).toBe(400)
    expect(prior.body.error).toMatch(/only for an asset you owned before your books start/)
    const tooMuch = await post(w.tok, '/fixed-assets', { ...assetForm(w), priorDepreciation: 400000 })
    expect(tooMuch.status).toBe(400)
    const ok = await post(w.tok, '/fixed-assets', { ...assetForm(w), priorDepreciation: 120000 })
    expect(ok.status).toBe(201)
  })

  it('edits and voids an asset (kept on record)', async () => {
    const w = await world()
    const id = (await post(w.tok, '/fixed-assets', assetForm(w))).body.data.id
    const e = await patch(w.tok, `/fixed-assets/${id}`, { lifeYears: 39, salvageValue: 30000 })
    expect(e.status).toBe(200)
    expect(e.body.data).toMatchObject({ life_years: '39.00', salvage_value: '30000.00' })
    expect((await post(w.tok, `/fixed-assets/${id}/void`, { reason: 'sold' })).status).toBe(200)
    expect((await get(w.tok, '/fixed-assets')).body.data).toEqual([])
    expect((await get(w.tok, '/fixed-assets?includeVoided=true')).body.data[0].void_reason).toBe('sold')
    expect((await patch(w.tok, `/fixed-assets/${id}`, { name: 'x' })).status).toBe(409)
  })

  it('only an expense filed under a capital-improvement category (an asset account) becomes an asset', async () => {
    const w = await world()
    const cat = async (name: string, role: string) => (await db.query<{ id: string }>(
      `INSERT INTO books_categories (landlord_id, direction, name, default_role) VALUES ($1, 'expense', $2, $3) RETURNING id`,
      [w.co.landlordId, name, role])).rows[0].id
    const capital = await cat('Capital improvements', 'rental_property')
    const repairs = await cat('Roof repairs', 'repairs_maintenance')
    const expense = async (categoryId: string) => (await db.query<{ id: string }>(
      `INSERT INTO landlord_expenses (landlord_id, property_id, category, category_id, amount, expense_date, description, payments_tracked)
       VALUES ($1, $2, 'other', $3, 12000, '2026-02-10', 'New roof', TRUE) RETURNING id`, [w.co.landlordId, w.co.propertyId, categoryId])).rows[0].id
    const repair = await expense(repairs)
    const roof = await expense(capital)
    const listed = await get(w.tok, '/fixed-assets/capital-expenses')
    expect(listed.body.data.map((e: any) => e.id)).toEqual([roof])
    const no = await post(w.tok, `/fixed-assets/from-expense/${repair}`, { assetClass: 'improvement', lifeYears: 10 })
    expect(no.status).toBe(409)
    expect(no.body.error).toMatch(/not an asset account/)
    // 10/13 (Nic): where its depreciation goes is asked — it sits where the expense was filed.
    const unsaid = await post(w.tok, `/fixed-assets/from-expense/${roof}`, { assetClass: 'improvement', lifeYears: 10 })
    expect([unsaid.status, unsaid.body.error]).toEqual([400,
      'Choose where this asset and its depreciation goes: the property the expense was filed on, or one of its units.'])
    const split = await post(w.tok, `/fixed-assets/from-expense/${roof}`, { assetClass: 'improvement', lifeYears: 10, costPlace: 'split_by_units' })
    expect([split.status, split.body.error]).toEqual([409,
      'This asset sits where its expense was filed, so its depreciation goes to that property or one of its units.'])
    const yes = await post(w.tok, `/fixed-assets/from-expense/${roof}`, { assetClass: 'improvement', lifeYears: 10, costPlace: 'property' })
    expect(yes.status, JSON.stringify(yes.body)).toBe(201)
    expect(yes.body.data).toMatchObject({ name: 'New roof', cost: '12000.00', acquired_on: '2026-02-10', source_expense_id: roof,
      property_id: w.co.propertyId, cost_place: 'property', unit_id: null, opens_at_books_start: false, monthly: 100 })
    expect((await post(w.tok, `/fixed-assets/from-expense/${roof}`, { assetClass: 'improvement', lifeYears: 10 })).status).toBe(409)
    const keep = await patch(w.tok, `/fixed-assets/${yes.body.data.id}`, { cost: 1 })
    expect(keep.status).toBe(409)
    expect(keep.body.error).toMatch(/made from an expense/)
    expect((await post(w.otherTok, `/fixed-assets/from-expense/${roof}`, { assetClass: 'improvement', lifeYears: 10 })).status).toBe(404)
  })
})

describe('who may', () => {
  it('10/12 (Nic, one level): a bookkeeper with the ledger box reads and keeps loans and assets, even on a row that says read_only; without the box, refused', async () => {
    const w = await world()
    const bk = async (ledger: boolean) => {
      const id = (await db.query<{ id: string }>(
        `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
         VALUES ($1, 'x', 'bookkeeper', 'Bo', 'Keeper', TRUE) RETURNING id`, [`bk-${randomUUID()}@test.dev`])).rows[0].id
      await db.query(
        `INSERT INTO bookkeeper_scopes (user_id, landlord_id, property_ids, company_wide, company_ledger, access_level)
         VALUES ($1, $2, $3, FALSE, $4, 'read_only')`, [id, w.co.landlordId, [w.co.propertyId], ledger])
      return sign({ userId: id, role: 'bookkeeper', email: 'bk@t.dev', profileId: null, landlordId: w.co.landlordId, permissions: { access_level: 'read_only' } })
    }
    const reader = await bk(true)
    const asReader = (fn: typeof get) => (url: string, body?: unknown) =>
      (fn === get ? get(reader, url) : (fn as any)(reader, url, body)).set('X-Client-Id', w.co.landlordId)
    expect((await asReader(get)('/loans')).status).toBe(200)
    expect((await asReader(get)('/fixed-assets')).status).toBe(200)
    expect((await asReader(get)('/vendors/1099?year=2026')).status).toBe(200)
    // 10/12 (Nic, ledger decision 2): "Full bookkeeping … One level, no per-bookkeeper switch".
    expect((await asReader(post as any)('/loans', loanForm(w))).status).toBe(201)
    const outsider = await bk(false)
    const r = await get(outsider, '/loans').set('X-Client-Id', w.co.landlordId)
    expect(r.status).toBe(403)
  })
})
