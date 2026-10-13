/**
 * 10/12 (Nic) — GAM BOOKS: BOOKS SETTINGS AND OPENING BALANCES
 *
 * Every landlord's-choice books setting (Nic's 10/12 answers: the books start
 * — since joining GAM or a date the owner picks —, who may close and reopen a
 * month, where an open month's fixes show, home sales, work trade, register
 * stock, company-level costs, who may write off) and the Opening balances step
 * (bank balances on the start date, pre-GAM deposits the landlord holds, other
 * opening balances, home-sale balances worked out from the contracts).
 *
 * Owner-only edits; a bookkeeper reads with the ledger box (bank balances only
 * with the company-wide box); every change marks the company's opening posting
 * for the engine. Runs on committed rows (the engine posts on its own pool).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { randomUUID } from 'crypto'
import {
  BOOKS_HISTORY_STARTS, BOOKS_HOME_SALE_METHODS, BOOKS_WORK_TRADE_METHODS,
  LEDGER_REGISTER_STOCK_METHODS, BOOKS_COMPANY_COST_METHODS, LEDGER_WRITE_OFF_PERMISSIONS, LEDGER_OPENING_ITEM_KINDS,
  LEDGER_CAPTURE_COLUMNS,
} from '@gam/shared'
import { db } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedTenant, seedLease, seedLeaseTenant } from '../test/dbHelpers'
import { booksSettingsRouter } from './booksSettings'
import { BOOKS_CHOOSE_COMPANY } from './books'
import { errorHandler } from '../middleware/errorHandler'
import { LEDGER_REFUSAL } from '../lib/bookkeeperScope'
import { postSource, registerLedgerProjector, unregisterLedgerProjector, registeredLedgerSourceTypes } from '../services/ledgerEngine'
import { otherIncomeTestProjector } from '../services/ledgerTestProjector'
import { loadBooksChoices } from '../services/booksSettings'

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/books/setup', booksSettingsRouter)
  app.use(errorHandler)
  return app
}
const app = buildApp()
const sign = (p: object) => jwt.sign(p, process.env.JWT_SECRET!, { expiresIn: '1h' })

beforeEach(async () => {
  await cleanupAllSchema()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_books_settings'
})
afterEach(() => {
  for (const t of registeredLedgerSourceTypes()) unregisterLedgerProjector(t)
})

interface World {
  ownerUserId: string
  canyon: string; delta: string; stranger: string
  alder: string; alderUnit: string
  tenantId: string; leaseId: string
  bank: string; strangerBank: string; strangerLease: string
  owner: string
  /** "May use the whole-company ledger", one property, no company-wide box. */
  ledgerKeeper: string
  /** The company-wide box. */
  wideKeeper: string
  /** One property only. */
  propertyKeeper: string
}

async function bookkeeperUser(first: string): Promise<string> {
  return (await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
     VALUES ($1, 'x', 'bookkeeper', $2, 'Keeper', TRUE) RETURNING id`, [`${first.toLowerCase()}-${randomUUID()}@test.dev`, first])).rows[0].id
}
const bkPass = (userId: string, landlordId: string) =>
  sign({ userId, role: 'bookkeeper', email: 'bk@t.dev', profileId: null, landlordId, permissions: { access_level: 'read_only' } })

async function bankConnection(landlordId: string, o: { balance?: number | null; name?: string } = {}): Promise<string> {
  return (await db.query<{ id: string }>(
    `INSERT INTO bank_connections (landlord_id, institution_name, account_last4, status, current_balance, balance_as_of)
     VALUES ($1, $2, '4321', 'active', $3, now()) RETURNING id`,
    [landlordId, o.name ?? 'Desert Bank', o.balance === undefined ? null : o.balance])).rows[0].id
}

async function bankLine(conn: string, landlordId: string, day: string, amount: number,
  o: { status?: string; ignoredReason?: string | null; duplicateOf?: string } = {}): Promise<string> {
  return (await db.query<{ id: string }>(
    `INSERT INTO bank_transactions (bank_connection_id, landlord_id, external_id, posted_date, amount, status, ignored_reason, duplicate_of_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [conn, landlordId, `x-${randomUUID()}`, day, amount, o.status ?? 'needs_review', o.ignoredReason ?? null,
     o.duplicateOf ?? null])).rows[0].id
}

async function world(): Promise<World> {
  const c = await db.connect()
  let base: Omit<World, 'ledgerKeeper' | 'wideKeeper' | 'propertyKeeper' | 'bank' | 'strangerBank'>
  try {
    const { userId: ownerUserId, landlordId: canyon } = await seedLandlord(c)
    await c.query(`UPDATE landlords SET business_name = 'Canyon LLC' WHERE id = $1`, [canyon])
    const delta = (await c.query<{ id: string }>(
      `INSERT INTO landlords (user_id, billing_starts_at, business_name) VALUES ($1, DATE '2000-01-01', 'Delta LLC') RETURNING id`,
      [ownerUserId])).rows[0].id
    const { userId: strangerUser, landlordId: stranger } = await seedLandlord(c)
    const alder = await seedProperty(c, { landlordId: canyon, ownerUserId, managedByUserId: ownerUserId })
    await c.query(`UPDATE properties SET name = 'Alder', timezone = 'America/Phoenix' WHERE id = $1`, [alder])
    const alderUnit = await seedUnit(c, { propertyId: alder, landlordId: canyon })
    const tenantId = await seedTenant(c)
    const leaseId = await seedLease(c, { unitId: alderUnit, landlordId: canyon, startDate: '2024-03-01' })
    await seedLeaseTenant(c, { leaseId, tenantId })
    const strangerProp = await seedProperty(c, { landlordId: stranger, ownerUserId: strangerUser, managedByUserId: strangerUser })
    const strangerUnit = await seedUnit(c, { propertyId: strangerProp, landlordId: stranger })
    const strangerLease = await seedLease(c, { unitId: strangerUnit, landlordId: stranger })
    base = {
      ownerUserId, canyon, delta, stranger, alder, alderUnit, tenantId, leaseId, strangerLease,
      owner: sign({ userId: ownerUserId, role: 'landlord', email: 'o@t.dev', profileId: null, landlordIds: [canyon, delta], permissions: {} }),
    }
  } finally { c.release() }
  const ledgerUser = await bookkeeperUser('Lee')
  const wideUser = await bookkeeperUser('Wynn')
  const propUser = await bookkeeperUser('Pat')
  await db.query(`INSERT INTO bookkeeper_scopes (user_id, landlord_id, property_ids, company_ledger) VALUES ($1, $2, $3, TRUE)`,
    [ledgerUser, base.canyon, [base.alder]])
  await db.query(`INSERT INTO bookkeeper_scopes (user_id, landlord_id, property_ids, company_wide) VALUES ($1, $2, $3, TRUE)`,
    [wideUser, base.canyon, [base.alder]])
  await db.query(`INSERT INTO bookkeeper_scopes (user_id, landlord_id, property_ids) VALUES ($1, $2, $3)`,
    [propUser, base.canyon, [base.alder]])
  return {
    ...base,
    bank: await bankConnection(base.canyon, { balance: 1000 }),
    strangerBank: await bankConnection(base.stranger, { balance: 5 }),
    ledgerKeeper: bkPass(ledgerUser, base.canyon),
    wideKeeper: bkPass(wideUser, base.canyon),
    propertyKeeper: bkPass(propUser, base.canyon),
  }
}

const asOwner = (w: World, company: string | null = null) => {
  const h: Record<string, string> = { Authorization: `Bearer ${w.owner}` }
  if (company ?? w.canyon) h['X-Client-Id'] = company ?? w.canyon
  return h
}
const asKeeper = (pass: string, company: string) => ({ Authorization: `Bearer ${pass}`, 'X-Client-Id': company })

async function landlordRow(id: string): Promise<any> {
  return (await db.query(`SELECT books_start_date::text AS books_start_date, books_history_start, books_home_sale_method,
                                 books_work_trade_method, books_register_stock, books_register_stock_from::text AS books_register_stock_from,
                                 books_company_costs_method,
                                 books_write_off_by, books_close_by, books_reopen_by, books_open_month_fixes
                            FROM landlords WHERE id = $1`, [id])).rows[0]
}

async function outboxOpening(landlordId: string): Promise<number> {
  return (await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM ledger_outbox WHERE source_type = 'opening' AND source_id = $1`, [landlordId])).rows[0].n
}

async function setStart(w: World, date: string) {
  const r = await request(app).patch('/api/books/setup/settings').set(asOwner(w)).send({ historyStart: 'start_date', startDate: date })
  expect(r.status, JSON.stringify(r.body)).toBe(200)
}

/** The CHECK's allowed values, read back from the database. */
async function checkValues(table: string, constraint: string): Promise<string[]> {
  const def = (await db.query<{ d: string }>(
    `SELECT pg_get_constraintdef(c.oid) AS d FROM pg_constraint c
      WHERE c.conrelid = $1::regclass AND c.conname = $2`, [table, constraint])).rows[0]?.d ?? ''
  return [...def.matchAll(/'([a-z_]+)'::text/g)].map(m => m[1]).sort()
}

// ═════════════════════════════════════════════════════════════════════════════
describe('Books settings — the owner\'s choices', () => {
  it('reads nothing chosen at first: no start date, no method, write-offs the owner\'s only', async () => {
    const w = await world()
    const r = await request(app).get('/api/books/setup/settings').set(asOwner(w))
    expect(r.status).toBe(200)
    const s = r.body.data
    expect(s).toMatchObject({
      companyName: 'Canyon LLC', canEdit: true, viewer: 'owner',
      booksStartDate: null, historyStart: null,
      homeSaleMethod: null, workTradeMethod: null, companyCostsMethod: null,
      // Register stock starts on the register lane's default (expense when bought), from the books' start.
      registerStockMethod: 'expense_when_bought', registerStockFrom: null,
      writeOffBy: 'owner', closeBy: 'owner_or_bookkeeper', reopenBy: 'owner', openMonthFixes: 'restate',
      closedThrough: null, hasPostings: false, openingItems: 0,
    })
    expect(s.joinMonthStart).toBe(`${s.joinedOn.slice(0, 7)}-01`)
  })

  it('an owner of two companies names one; a company that is not theirs is refused', async () => {
    const w = await world()
    const none = await request(app).get('/api/books/setup/settings').set({ Authorization: `Bearer ${w.owner}` })
    expect(none.status).toBe(400)
    expect(none.body.error).toBe(BOOKS_CHOOSE_COMPANY)
    const other = await request(app).get('/api/books/setup/settings').set(asOwner(w, w.stranger))
    expect(other.status).toBe(403)
    const delta = await request(app).get('/api/books/setup/settings').set(asOwner(w, w.delta))
    expect(delta.status).toBe(200)
    expect(delta.body.data.companyName).toBe('Delta LLC')
  })

  it('saves every choice in one press; a bad value is refused in plain words', async () => {
    const w = await world()
    const r = await request(app).patch('/api/books/setup/settings').set(asOwner(w)).send({
      homeSaleMethod: 'income_as_paid', workTradeMethod: 'rent_discount', registerStockMethod: 'cost_per_item_sold',
      companyCostsMethod: 'split_by_units', writeOffBy: 'owner_or_property_manager',
      closeBy: 'owner', reopenBy: 'owner_or_bookkeeper', openMonthFixes: 'day_made',
    })
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    expect(r.body.data).toMatchObject({
      homeSaleMethod: 'income_as_paid', workTradeMethod: 'rent_discount', registerStockMethod: 'cost_per_item_sold', registerStockFrom: null,
      companyCostsMethod: 'split_by_units', writeOffBy: 'owner_or_property_manager',
      closeBy: 'owner', reopenBy: 'owner_or_bookkeeper', openMonthFixes: 'day_made',
    })
    expect(await landlordRow(w.canyon)).toMatchObject({
      books_home_sale_method: 'income_as_paid', books_work_trade_method: 'rent_discount',
      books_register_stock: 'cost_per_item_sold', books_register_stock_from: null, books_company_costs_method: 'split_by_units',
      books_write_off_by: 'owner_or_property_manager', books_close_by: 'owner', books_reopen_by: 'owner_or_bookkeeper',
      books_open_month_fixes: 'day_made',
    })
    // The other company is untouched.
    expect((await landlordRow(w.delta)).books_home_sale_method).toBeNull()
    // A choice of a method marks the opening posting (it reads the home-sale method).
    expect(await outboxOpening(w.canyon)).toBeGreaterThan(0)
    // The posting rules read the same choices.
    expect(await loadBooksChoices(db, w.canyon)).toMatchObject({ homeSaleMethod: 'income_as_paid', writeOffBy: 'owner_or_property_manager' })

    const bad = await request(app).patch('/api/books/setup/settings').set(asOwner(w)).send({ homeSaleMethod: 'later' })
    expect(bad.status).toBe(400)
    expect(bad.body.error).toBe('Choose how home sales count.')
    const badWho = await request(app).patch('/api/books/setup/settings').set(asOwner(w)).send({ writeOffBy: 'bookkeeper' })
    expect(badWho.status).toBe(400)
    expect(badWho.body.error).toBe('Choose who may write off a balance.')
  })

  it('a start date the owner picks: the bank feed\'s cutoff moves with it and the opening posting is marked', async () => {
    const w = await world()
    await bankLine(w.bank, w.canyon, '2026-07-15', 40)
    await bankLine(w.bank, w.canyon, '2026-08-15', 60)
    await db.query(`DELETE FROM ledger_outbox`)
    await setStart(w, '2026-08-01')
    expect(await landlordRow(w.canyon)).toMatchObject({ books_start_date: '2026-08-01', books_history_start: 'start_date' })
    const lines = (await db.query(`SELECT posted_date::text AS d, status, ignored_reason FROM bank_transactions
                                    WHERE landlord_id = $1 ORDER BY posted_date`, [w.canyon])).rows
    expect(lines).toEqual([
      { d: '2026-07-15', status: 'ignored', ignored_reason: 'before_books' },
      { d: '2026-08-15', status: 'needs_review', ignored_reason: null },
    ])
    expect(await outboxOpening(w.canyon)).toBeGreaterThan(0)

    // Moving it back brings the set-aside line back to review.
    await setStart(w, '2026-07-01')
    expect((await db.query(`SELECT status FROM bank_transactions WHERE landlord_id = $1 AND posted_date = '2026-07-15'`, [w.canyon])).rows[0].status)
      .toBe('needs_review')
    // A start date picked on the Bank page before this setting reads as "a date you pick".
    await db.query(`UPDATE landlords SET books_history_start = NULL WHERE id = $1`, [w.canyon])
    const r = await request(app).get('/api/books/setup/settings').set(asOwner(w))
    expect(r.body.data).toMatchObject({ booksStartDate: '2026-07-01', historyStart: 'start_date' })
  })

  it('since joining GAM: the first day of the month the company joined', async () => {
    const w = await world()
    await db.query(`UPDATE landlords SET created_at = '2026-08-28 17:34:25-07' WHERE id = $1`, [w.canyon])
    const r = await request(app).patch('/api/books/setup/settings').set(asOwner(w)).send({ historyStart: 'since_joining' })
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    expect(r.body.data).toMatchObject({ booksStartDate: '2026-08-01', historyStart: 'since_joining', joinedOn: '2026-08-28', joinMonthStart: '2026-08-01' })
    expect(await landlordRow(w.canyon)).toMatchObject({ books_start_date: '2026-08-01', books_history_start: 'since_joining' })
    // Moved on the Bank page afterwards: a date the owner picked.
    await db.query(`UPDATE landlords SET books_start_date = '2026-09-01' WHERE id = $1`, [w.canyon])
    const after = await request(app).get('/api/books/setup/settings').set(asOwner(w))
    expect(after.body.data).toMatchObject({ booksStartDate: '2026-09-01', historyStart: 'start_date' })
  })

  it('a start date must be a real day, given with how the books start, within the next year', async () => {
    const w = await world()
    const cases: [object, string][] = [
      [{ historyStart: 'start_date' }, 'Enter the date your books start.'],
      [{ historyStart: 'start_date', startDate: '2026-02-30' }, 'Enter the date your books start.'],
      [{ historyStart: 'start_date', startDate: '2099-01-01' }, 'Pick a start date within the next year.'],
      [{ startDate: '2026-08-01' }, 'Say how your books start along with the date.'],
      [{ historyStart: 'whenever' }, 'Choose when your books start: since joining GAM, or a date you pick.'],
    ]
    for (const [body, message] of cases) {
      const r = await request(app).patch('/api/books/setup/settings').set(asOwner(w)).send(body)
      expect(r.status, JSON.stringify(body)).toBe(400)
      expect(r.body.error).toBe(message)
    }
    expect((await landlordRow(w.canyon)).books_start_date).toBeNull()
  })

  it('a method is chosen once: after the books post it no longer changes; one never chosen still can be', async () => {
    const w = await world()
    await setStart(w, '2026-01-01')
    let r = await request(app).patch('/api/books/setup/settings').set(asOwner(w)).send({ homeSaleMethod: 'whole_sale_at_signing' })
    expect(r.status).toBe(200)
    // Before anything posts it may still change.
    r = await request(app).patch('/api/books/setup/settings').set(asOwner(w)).send({ homeSaleMethod: 'income_as_paid' })
    expect(r.status).toBe(200)

    // The books post (the engine's test source: money in filed as other income).
    registerLedgerProjector(otherIncomeTestProjector)
    const income = (await db.query<{ id: string }>(
      `INSERT INTO landlord_other_income (landlord_id, property_id, category, amount, income_date)
       VALUES ($1, $2, 'other', 25, '2026-02-01') RETURNING id`, [w.canyon, w.alder])).rows[0].id
    const posted = await postSource('other_income', income)
    expect(posted.posted).toBe(1)
    unregisterLedgerProjector('other_income')

    r = await request(app).get('/api/books/setup/settings').set(asOwner(w))
    expect(r.body.data.hasPostings).toBe(true)
    r = await request(app).patch('/api/books/setup/settings').set(asOwner(w)).send({ homeSaleMethod: 'whole_sale_at_signing' })
    expect(r.status).toBe(409)
    expect(r.body.error).toMatch(/already posted under how home sales count/)
    expect((await landlordRow(w.canyon)).books_home_sale_method).toBe('income_as_paid')
    // Never chosen: nothing posted under it.
    r = await request(app).patch('/api/books/setup/settings').set(asOwner(w)).send({ workTradeMethod: 'rent_and_labor' })
    expect(r.status).toBe(200)
    // Register stock changes any time, from the day it changes (sales already booked keep theirs).
    const today = r.body.data.today
    r = await request(app).patch('/api/books/setup/settings').set(asOwner(w)).send({ registerStockMethod: 'cost_per_item_sold' })
    expect(r.status).toBe(200)
    expect(r.body.data).toMatchObject({ registerStockMethod: 'cost_per_item_sold', registerStockFrom: today })
    // 10/12 (Nic, ledger review): every change is kept with its day — what was
    // in force before (from the start) and each change after — so a second
    // change never re-dates sales booked under the first.
    r = await request(app).patch('/api/books/setup/settings').set(asOwner(w)).send({ registerStockMethod: 'expense_when_bought' })
    expect(r.status).toBe(200)
    expect((await db.query<{ method: string; from: string | null }>(
      `SELECT method, effective_from::text AS from FROM books_register_stock_changes WHERE landlord_id = $1 ORDER BY id`, [w.canyon])).rows)
      .toEqual([
        { method: 'expense_when_bought', from: null },
        { method: 'cost_per_item_sold', from: today },
        { method: 'expense_when_bought', from: today },
      ])
    // Who may act changes any time.
    r = await request(app).patch('/api/books/setup/settings').set(asOwner(w)).send({ closeBy: 'owner', writeOffBy: 'owner_or_property_manager' })
    expect(r.status).toBe(200)
    // The same choice again is no change at all.
    r = await request(app).patch('/api/books/setup/settings').set(asOwner(w)).send({ homeSaleMethod: 'income_as_paid' })
    expect(r.status).toBe(200)
  })

  it('a bookkeeper reads with the ledger box and changes nothing; property-only bookkeepers do not read it', async () => {
    const w = await world()
    const read = await request(app).get('/api/books/setup/settings').set(asKeeper(w.ledgerKeeper, w.canyon))
    expect(read.status).toBe(200)
    expect(read.body.data).toMatchObject({ canEdit: false, viewer: 'bookkeeper' })
    const wide = await request(app).get('/api/books/setup/settings').set(asKeeper(w.wideKeeper, w.canyon))
    expect(wide.status).toBe(200)
    const change = await request(app).patch('/api/books/setup/settings').set(asKeeper(w.wideKeeper, w.canyon)).send({ closeBy: 'owner' })
    expect(change.status).toBe(403)
    expect(change.body.error).toBe('Only the owner changes the books settings.')
    expect((await landlordRow(w.canyon)).books_close_by).toBe('owner_or_bookkeeper')
    const narrow = await request(app).get('/api/books/setup/settings').set(asKeeper(w.propertyKeeper, w.canyon))
    expect(narrow.status).toBe(403)
    expect(narrow.body.error).toBe(LEDGER_REFUSAL)
    // A company they do not keep.
    const elsewhere = await request(app).get('/api/books/setup/settings').set(asKeeper(w.ledgerKeeper, w.stranger))
    expect(elsewhere.status).toBe(403)
  })

  it('the database holds the same lists as the shared code', async () => {
    const sorted = (a: readonly string[]) => [...a].sort()
    expect(await checkValues('landlords', 'landlords_books_history_start_check')).toEqual(sorted(BOOKS_HISTORY_STARTS))
    expect(await checkValues('landlords', 'landlords_books_home_sale_method_check')).toEqual(sorted(BOOKS_HOME_SALE_METHODS))
    expect(await checkValues('landlords', 'landlords_books_work_trade_method_check')).toEqual(sorted(BOOKS_WORK_TRADE_METHODS))
    expect(await checkValues('landlords', 'landlords_books_register_stock_check')).toEqual(sorted(LEDGER_REGISTER_STOCK_METHODS))
    expect(await checkValues('landlords', 'landlords_books_company_costs_method_check')).toEqual(sorted(BOOKS_COMPANY_COST_METHODS))
    expect(await checkValues('landlords', 'landlords_books_write_off_by_check')).toEqual(sorted(LEDGER_WRITE_OFF_PERMISSIONS))
    expect(await checkValues('books_opening_items', 'books_opening_items_kind_check')).toEqual(sorted(LEDGER_OPENING_ITEM_KINDS))
    // The opening posting re-projects when an item's account changes: the capture reads account_id.
    const src = (await db.query<{ src: string }>(
      `SELECT p.prosrc AS src FROM pg_proc p WHERE p.proname = 'ledger_capture_books_opening_items_upd'`)).rows[0].src
    expect(/-- ledger columns: ([^\n]*)/.exec(src)?.[1]).toBe((LEDGER_CAPTURE_COLUMNS.books_opening_items as readonly string[]).join(','))
    expect(LEDGER_CAPTURE_COLUMNS.books_opening_items).toContain('account_id')
  })
})

// ═════════════════════════════════════════════════════════════════════════════
describe('Opening balances', () => {
  it('nothing is entered before the books have a start date', async () => {
    const w = await world()
    const r = await request(app).post('/api/books/setup/opening-balances').set(asOwner(w))
      .send({ kind: 'bank', bankConnectionId: w.bank, amount: '100.00' })
    expect(r.status).toBe(409)
    expect(r.body.error).toBe('Pick when your books start first, on Books Settings.')
  })

  it('a bank balance is dated the start date, marks the opening posting, and a second one replaces the first', async () => {
    const w = await world()
    await setStart(w, '2026-08-01')
    await db.query(`DELETE FROM ledger_outbox`)
    let r = await request(app).post('/api/books/setup/opening-balances').set(asOwner(w))
      .send({ kind: 'bank', bankConnectionId: w.bank, amount: '1,234.56', memo: 'From the July statement' })
    expect(r.status, JSON.stringify(r.body)).toBe(201)
    const first = r.body.data.id
    const item = r.body.data.items.find((i: any) => i.id === first)
    expect(item).toMatchObject({ kind: 'bank', amount: '1234.56', asOf: '2026-08-01', memo: 'From the July statement', stale: false, voidedAt: null })
    expect(item.bankName).toMatch(/Desert Bank/)
    expect(await outboxOpening(w.canyon)).toBeGreaterThan(0)

    r = await request(app).post('/api/books/setup/opening-balances').set(asOwner(w))
      .send({ kind: 'bank', bankConnectionId: w.bank, amount: -12.5 })
    expect(r.status).toBe(201)
    const rows = (await db.query(`SELECT id, amount::text AS amount, voided_at, void_reason FROM books_opening_items
                                   WHERE landlord_id = $1 AND kind = 'bank' ORDER BY entered_at`, [w.canyon])).rows
    expect(rows).toHaveLength(2)
    expect(rows[0].id).toBe(first)
    expect(rows[0].voided_at).not.toBeNull()
    expect(rows[0].void_reason).toBe('Replaced by a new balance for this bank account.')
    expect(rows[1]).toMatchObject({ amount: '-12.50', voided_at: null })

    // Another company's bank account.
    r = await request(app).post('/api/books/setup/opening-balances').set(asOwner(w))
      .send({ kind: 'bank', bankConnectionId: w.strangerBank, amount: 5 })
    expect(r.status).toBe(404)
    // Not a dollar amount.
    r = await request(app).post('/api/books/setup/opening-balances').set(asOwner(w))
      .send({ kind: 'bank', bankConnectionId: w.bank, amount: '12.345' })
    expect(r.status).toBe(400)
    expect(r.body.error).toBe('Enter the amount in dollars and cents.')
  })

  it('suggests a bank balance: today\'s less what the feed posted since the start, when the feed reaches back that far', async () => {
    const w = await world()
    await bankLine(w.bank, w.canyon, '2026-07-20', 50, { status: 'categorized' })
    const original = await bankLine(w.bank, w.canyon, '2026-08-05', 300)
    await bankLine(w.bank, w.canyon, '2026-08-10', -100, { status: 'categorized' })
    await bankLine(w.bank, w.canyon, '2026-08-12', 999, { status: 'ignored', ignoredReason: 'duplicate', duplicateOf: original })
    const late = await bankConnection(w.canyon, { balance: 70, name: 'Late Bank' })
    await bankLine(late, w.canyon, '2026-09-01', 10)
    await setStart(w, '2026-08-01')
    const r = await request(app).get('/api/books/setup/opening-balances').set(asOwner(w))
    expect(r.status).toBe(200)
    const byId = Object.fromEntries((r.body.data.bankAccounts as any[]).map(b => [b.id, b]))
    expect(byId[w.bank]).toMatchObject({ suggested: '800.00', feedFrom: '2026-07-20' })
    expect(byId[late]).toMatchObject({ suggested: null, feedFrom: '2026-09-01' })
    expect(byId[w.strangerBank]).toBeUndefined()
  })

  it('a deposit held from before GAM takes the lease\'s tenant and property and must be paid by the start', async () => {
    const w = await world()
    await setStart(w, '2026-08-01')
    const opts = (await request(app).get('/api/books/setup/opening-balances').set(asOwner(w))).body.data
    expect((opts.leases as any[]).map(l => l.leaseId)).toEqual([w.leaseId])
    expect(opts.leases[0]).toMatchObject({ propertyName: 'Alder', tenantName: 'Test Tenant', gamDeposit: null })

    let r = await request(app).post('/api/books/setup/opening-balances').set(asOwner(w))
      .send({ kind: 'deposit_held', leaseId: w.leaseId, amount: 500, paidOn: '2026-09-01' })
    expect(r.status).toBe(400)
    expect(r.body.error).toMatch(/after your books start/)
    r = await request(app).post('/api/books/setup/opening-balances').set(asOwner(w))
      .send({ kind: 'deposit_held', leaseId: w.leaseId, amount: 0, paidOn: '2024-03-01' })
    expect(r.status).toBe(400)
    r = await request(app).post('/api/books/setup/opening-balances').set(asOwner(w))
      .send({ kind: 'deposit_held', leaseId: w.strangerLease, amount: 500, paidOn: '2024-03-01' })
    expect(r.status).toBe(404)
    r = await request(app).post('/api/books/setup/opening-balances').set(asOwner(w))
      .send({ kind: 'deposit_held', leaseId: w.leaseId, amount: 500, paidOn: '2024-03-01' })
    expect(r.status, JSON.stringify(r.body)).toBe(201)
    const row = (await db.query(`SELECT tenant_id, property_id, lease_id, amount::text AS amount, paid_on::text AS paid_on, as_of::text AS as_of
                                   FROM books_opening_items WHERE id = $1`, [r.body.data.id])).rows[0]
    expect(row).toEqual({ tenant_id: w.tenantId, property_id: w.alder, lease_id: w.leaseId, amount: '500.00', paid_on: '2024-03-01', as_of: '2026-08-01' })
    const view = r.body.data.items.find((i: any) => i.id === r.body.data.id)
    expect(view).toMatchObject({ tenantName: 'Test Tenant', propertyName: 'Alder', paidOn: '2024-03-01' })

    // Moving the start date before the day it was paid flags it to be checked.
    await setStart(w, '2024-01-01')
    const after = (await request(app).get('/api/books/setup/opening-balances').set(asOwner(w))).body.data
    expect(after.items.find((i: any) => i.id === r.body.data.id).stale).toBe(true)
  })

  it('another opening balance needs the chart and one of the company\'s own balance-sheet accounts', async () => {
    const w = await world()
    await setStart(w, '2026-08-01')
    let r = await request(app).post('/api/books/setup/opening-balances').set(asOwner(w))
      .send({ kind: 'other', accountId: randomUUID(), amount: 250 })
    expect(r.status).toBe(409)
    expect(r.body.error).toBe('Set up the chart of accounts for your books first.')

    r = await request(app).post('/api/books/setup/opening-balances/chart').set(asOwner(w))
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    expect(r.body.data.chartReady).toBe(true)
    const codes = (r.body.data.accounts as any[]).map(a => a.code)
    expect(codes).toContain('1020')   // Savings
    expect(codes).toContain('1530')   // Equipment
    expect(codes).toContain('2100')   // Mortgage payable
    for (const never of ['1100', '1050', '1070', '2020', '2050', '3900', '3950', '3030', '4010', '5040']) expect(codes).not.toContain(never)
    const id = (code: string) => (db.query<{ id: string }>(`SELECT id FROM books_accounts WHERE landlord_id = $1 AND code = $2`, [w.canyon, code]))
      .then(x => x.rows[0].id)

    r = await request(app).post('/api/books/setup/opening-balances').set(asOwner(w))
      .send({ kind: 'other', accountId: await id('1100'), amount: 250 })
    expect(r.status).toBe(400)
    expect(r.body.error).toMatch(/never by hand/)
    r = await request(app).post('/api/books/setup/opening-balances').set(asOwner(w))
      .send({ kind: 'other', accountId: await id('1020'), amount: 250, memo: 'Savings at the credit union' })
    expect(r.status, JSON.stringify(r.body)).toBe(201)
    expect(r.body.data.items.find((i: any) => i.id === r.body.data.id)).toMatchObject({
      kind: 'other', accountCode: '1020', accountType: 'asset', amount: '250.00', asOf: '2026-08-01',
    })
    // The database holds the rule too.
    await expect(db.query(`INSERT INTO books_opening_items (landlord_id, kind, amount, as_of) VALUES ($1, 'other', 5, '2026-08-01')`, [w.canyon]))
      .rejects.toThrow(/books_opening_items_other_names_account/)
  })

  it('a void says why and is kept', async () => {
    const w = await world()
    await setStart(w, '2026-08-01')
    const added = await request(app).post('/api/books/setup/opening-balances').set(asOwner(w))
      .send({ kind: 'bank', bankConnectionId: w.bank, amount: 10 })
    const id = added.body.data.id
    let r = await request(app).post(`/api/books/setup/opening-balances/${id}/void`).set(asOwner(w)).send({ reason: '  ' })
    expect(r.status).toBe(400)
    expect(r.body.error).toBe('Say why this opening balance is being voided.')
    await db.query(`DELETE FROM ledger_outbox`)
    r = await request(app).post(`/api/books/setup/opening-balances/${id}/void`).set(asOwner(w)).send({ reason: 'Wrong account' })
    expect(r.status).toBe(200)
    expect(r.body.data.items.find((i: any) => i.id === id)).toMatchObject({ voidReason: 'Wrong account' })
    expect(await outboxOpening(w.canyon)).toBeGreaterThan(0)
    r = await request(app).post(`/api/books/setup/opening-balances/${id}/void`).set(asOwner(w)).send({ reason: 'Again' })
    expect(r.status).toBe(409)
    r = await request(app).post(`/api/books/setup/opening-balances/${randomUUID()}/void`).set(asOwner(w)).send({ reason: 'Nope' })
    expect(r.status).toBe(404)
    expect((await db.query(`SELECT count(*)::int AS n FROM books_opening_items WHERE id = $1`, [id])).rows[0].n).toBe(1)
    // The database refuses a void with no reason.
    const other = await request(app).post('/api/books/setup/opening-balances').set(asOwner(w))
      .send({ kind: 'bank', bankConnectionId: w.bank, amount: 20 })
    await expect(db.query(`UPDATE books_opening_items SET voided_at = now(), voided_by = $2 WHERE id = $1`, [other.body.data.id, w.ownerUserId]))
      .rejects.toThrow(/books_opening_items_void_says_why/)
  })

  it('paid-ahead money from before GAM is not entered here yet', async () => {
    const w = await world()
    await setStart(w, '2026-08-01')
    const r = await request(app).post('/api/books/setup/opening-balances').set(asOwner(w))
      .send({ kind: 'paid_ahead_held', leaseId: w.leaseId, amount: 100 })
    expect(r.status).toBe(400)
    expect(r.body.error).toBe('Choose a bank balance, a deposit you hold, or another opening balance.')
  })

  it('a bookkeeper reads with the ledger box, sees bank balances only with the company-wide box, and enters nothing', async () => {
    const w = await world()
    await setStart(w, '2026-08-01')
    await request(app).post('/api/books/setup/opening-balances').set(asOwner(w)).send({ kind: 'bank', bankConnectionId: w.bank, amount: 10 })
    await request(app).post('/api/books/setup/opening-balances').set(asOwner(w))
      .send({ kind: 'deposit_held', leaseId: w.leaseId, amount: 300, paidOn: '2025-01-05' })

    const narrow = (await request(app).get('/api/books/setup/opening-balances').set(asKeeper(w.ledgerKeeper, w.canyon))).body.data
    expect(narrow).toMatchObject({ canEdit: false, seesBank: false, bankAccounts: null, leases: [], accounts: [] })
    expect((narrow.items as any[]).map(i => i.kind)).toEqual(['deposit_held'])
    const wide = (await request(app).get('/api/books/setup/opening-balances').set(asKeeper(w.wideKeeper, w.canyon))).body.data
    expect(wide.seesBank).toBe(true)
    expect((wide.items as any[]).map(i => i.kind).sort()).toEqual(['bank', 'deposit_held'])
    expect((wide.bankAccounts as any[]).map(b => b.id)).toEqual([w.bank])

    const add = await request(app).post('/api/books/setup/opening-balances').set(asKeeper(w.wideKeeper, w.canyon))
      .send({ kind: 'bank', bankConnectionId: w.bank, amount: 1 })
    expect(add.status).toBe(403)
    const chart = await request(app).post('/api/books/setup/opening-balances/chart').set(asKeeper(w.wideKeeper, w.canyon))
    expect(chart.status).toBe(403)
    const id = (wide.items as any[])[0].id
    const vd = await request(app).post(`/api/books/setup/opening-balances/${id}/void`).set(asKeeper(w.wideKeeper, w.canyon)).send({ reason: 'x' })
    expect(vd.status).toBe(403)
    const none = await request(app).get('/api/books/setup/opening-balances').set(asKeeper(w.propertyKeeper, w.canyon))
    expect(none.status).toBe(403)
  })

  it('home-sale balances still owed are worked out from the contracts, for sales before the start', async () => {
    const w = await world()
    await setStart(w, '2026-08-01')
    await request(app).patch('/api/books/setup/settings').set(asOwner(w)).send({ homeSaleMethod: 'whole_sale_at_signing' })
    // One live sale per home: each contract gets its own unit.
    const contract = async (o: { start: string; status: string; activatedAt: string | null; cancelledAt?: string | null; financed: number }) => {
      const unit = (await db.query<{ id: string }>(
        `INSERT INTO units (property_id, landlord_id, unit_number, rent_amount, unit_type)
         VALUES ($1, $2, $3, 500, 'apartment') RETURNING id`, [w.alder, w.canyon, `H${randomUUID().slice(0, 5)}`])).rows[0].id
      return (await db.query<{ id: string }>(
        `INSERT INTO home_sale_contracts (unit_id, tenant_id, landlord_id, sale_price, down_payment, financed_amount,
                                          annual_interest_rate, term_months, monthly_payment, start_month, status,
                                          installments_total, activated_at, cancelled_at)
         VALUES ($1, $2, $3, $4, 0, $4, 0, 100, 100, $5, $6, 100, $7, $8) RETURNING id`,
        [unit, w.tenantId, w.canyon, o.financed, o.start, o.status, o.activatedAt, o.cancelledAt ?? null])).rows[0].id
    }
    const installment = async (contractId: string, n: number, month: string, principal: number, o: { offPlatform?: boolean; pendingPayment?: number } = {}) => {
      let paymentId: string | null = null
      if (o.pendingPayment) {
        paymentId = (await db.query<{ id: string }>(
          `INSERT INTO payments (unit_id, tenant_id, landlord_id, type, amount, status, entry_description, due_date)
           VALUES ($1, $2, $3, 'rent', $4, 'pending', 'HOMEPMT', $5) RETURNING id`,
          [w.alderUnit, w.tenantId, w.canyon, o.pendingPayment, month])).rows[0].id
      }
      await db.query(
        `INSERT INTO home_sale_installments (contract_id, installment_number, billing_month, amount, principal_portion,
                                             interest_portion, remaining_balance, payment_id, settled_off_platform_at)
         VALUES ($1, $2, $3, $4, $5, $6, 0, $7, $8)`,
        [contractId, n, month, o.pendingPayment ?? principal, principal, (o.pendingPayment ?? principal) - principal, paymentId,
         o.offPlatform ? '2025-02-01' : null])
    }
    const old = await contract({ start: '2025-01-01', status: 'active', activatedAt: '2026-07-20 10:00-07', financed: 10000 })
    await installment(old, 1, '2025-01-01', 400, { offPlatform: true })
    await installment(old, 2, '2026-07-01', 500, { pendingPayment: 600 })
    await installment(old, 3, '2026-08-01', 450)
    await contract({ start: '2025-06-01', status: 'cancelled', activatedAt: '2025-06-01 09:00-07', cancelledAt: '2026-06-01 09:00-07', financed: 7000 })
    await contract({ start: '2026-09-01', status: 'active', activatedAt: '2026-09-02 09:00-07', financed: 8250 })
    await contract({ start: '2025-03-01', status: 'pending_signature', activatedAt: null, financed: 5000 })

    const r = await request(app).get('/api/books/setup/opening-balances').set(asOwner(w))
    expect(r.status).toBe(200)
    expect(r.body.data.homeSaleMethod).toBe('whole_sale_at_signing')
    expect(r.body.data.homeSales).toEqual([expect.objectContaining({
      contractId: old, buyerName: 'Test Tenant', propertyName: 'Alder', status: 'active',
      financed: '10000.00', principalBeforeStart: '900.00', stillOwed: '9100.00', billedUnpaid: '600.00',
    })])
  })
})
