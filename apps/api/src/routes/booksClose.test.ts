/**
 * 10/12 (Nic) — GAM Books ledger, phase P9: close a month, reconcile a bank
 * account on the ledger (gam-ledger-design-2026-10-12 §13).
 *
 *   L3 "close/reopen month: landlord's choice (owner decides who can close and
 *       reopen)"; decision 2 "Full bookkeeping (bank lines, reconciling,
 *       journal entries, bills, payroll, vendors) … One level".
 *
 * Real tables, real capture triggers, the real engine with the production
 * projector set (it commits on its own connections, so every test starts from
 * a clean database), driven through the routes the Books pages call.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { randomUUID } from 'crypto'
import {
  BANK_RECONCILIATION_STATUSES, BANK_RECONCILIATION_ITEM_SOURCES, BANK_RECONCILIATION_ITEM_RELEASES, LEDGER_CLOSE_WARNINGS,
} from '@gam/shared'
import { db } from '../db'
import { cleanupAllSchema } from '../test/dbHelpers'
import { ledgerCompany, inTx, type LedgerCompany } from '../test/ledgerFixtures'
import { checkOwner } from '../services/ledgerCheck'
import { errorHandler } from '../middleware/errorHandler'
import { LEDGER_REFUSAL } from '../lib/bookkeeperScope'
import { booksCloseRouter, booksReconcileRouter } from './booksClose'
import { drainLedgerOutbox } from '../services/ledgerEngine'
import { registerProductionLedgerProjectors, unregisterProductionLedgerProjectors } from '../services/ledgerProjectors'
import { createLandlordExpense, voidLandlordExpense } from '../services/landlordExpenses'
import { categorizeTransaction } from '../services/bankFeed'
import { matchLineToRecord } from '../services/bankMoneyOut'

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/books/close', booksCloseRouter)
  app.use('/api/books/reconcile', booksReconcileRouter)
  app.use(errorHandler)
  return app
}
const app = buildApp()
const sign = (p: object) => jwt.sign(p, process.env.JWT_SECRET!, { expiresIn: '1h' })

beforeEach(async () => {
  await cleanupAllSchema()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_books_close'
  registerProductionLedgerProjectors()
})
afterEach(() => unregisterProductionLedgerProjectors())

interface World extends LedgerCompany {
  connectionId: string
  asOwner: Record<string, string>
  /** The company-wide box. */
  wide: Record<string, string>
  /** "May use the whole-company ledger", one property, no company-wide box. */
  ledger: Record<string, string>
  /** One property only. */
  property: Record<string, string>
}

async function keeper(co: LedgerCompany, o: { companyWide?: boolean; ledger?: boolean }): Promise<Record<string, string>> {
  const u = (await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
     VALUES ($1, 'x', 'bookkeeper', 'Book', 'Keeper', TRUE) RETURNING id`, [`bk-${randomUUID()}@test.dev`])).rows[0].id
  await db.query(
    `INSERT INTO bookkeeper_scopes (user_id, landlord_id, property_ids, company_wide, company_ledger) VALUES ($1, $2, $3, $4, $5)`,
    [u, co.landlordId, [co.propertyId], !!o.companyWide, !!o.ledger])
  const pass = sign({ userId: u, role: 'bookkeeper', email: 'bk@t.dev', profileId: null, landlordId: co.landlordId, permissions: { access_level: 'read_write' } })
  return { Authorization: `Bearer ${pass}`, 'X-Client-Id': co.landlordId }
}

async function world(): Promise<World> {
  const co = await ledgerCompany()
  await db.query(`UPDATE landlords SET books_company_costs_method = 'company_bucket' WHERE id = $1`, [co.landlordId])
  const connectionId = (await db.query<{ id: string }>(
    `INSERT INTO bank_connections (landlord_id, provider, status, display_name, account_last4) VALUES ($1, 'stripe_fc', 'active', 'Operating', '4321') RETURNING id`,
    [co.landlordId])).rows[0].id
  const ownerPass = sign({ userId: co.ownerUserId, role: 'landlord', email: 'o@t.dev', profileId: null, landlordIds: [co.landlordId], permissions: {} })
  return {
    ...co, connectionId,
    asOwner: { Authorization: `Bearer ${ownerPass}`, 'X-Client-Id': co.landlordId },
    wide: await keeper(co, { companyWide: true }),
    ledger: await keeper(co, { ledger: true }),
    property: await keeper(co, {}),
  }
}

async function bankLine(w: World, day: string, amount: number, merchant = 'ACME'): Promise<string> {
  return (await db.query<{ id: string }>(
    `INSERT INTO bank_transactions (bank_connection_id, landlord_id, external_id, posted_date, amount, description, normalized_merchant, status, bank_status)
     VALUES ($1, $2, $3, $4, $5, $6, $6, 'needs_review', 'posted') RETURNING id`,
    [w.connectionId, w.landlordId, randomUUID(), day, amount.toFixed(2), merchant])).rows[0].id
}

/** September on the books: $500 in from the feed (laundry), $82.50 out from the feed (utilities), $40 paid from the bank by hand. */
async function september(w: World): Promise<{ handExpense: string }> {
  const inLine = await bankLine(w, '2026-09-04', 500, 'LAUNDRY CO')
  await categorizeTransaction(w.landlordId, inLine, { category: 'laundry', scopeKind: 'property_common', propertyId: w.propertyId })
  const outLine = await bankLine(w, '2026-09-05', -82.5, 'CITY WATER')
  await categorizeTransaction(w.landlordId, outLine, { category: 'utilities', scopeKind: 'property_common', propertyId: w.propertyId })
  const hand = await createLandlordExpense({
    landlordId: w.landlordId, propertyId: w.propertyId, category: 'repairs', amount: 40, expenseDate: '2026-09-06',
    payment: { method: 'bank', bankConnectionId: w.connectionId },
  })
  expect(await drainLedgerOutbox()).toMatchObject({ failed: 0 })
  return { handExpense: hand.id }
}

async function linkedAccount(w: World, as = w.asOwner): Promise<any> {
  const r = await request(app).get('/api/books/reconcile/accounts').set(as)
  expect(r.status, JSON.stringify(r.body)).toBe(200)
  const a = r.body.data.find((x: any) => x.bankConnectionId === w.connectionId)
  expect(a).toBeTruthy()
  return a
}

const lineOf = (ws: any, amount: number) => ws.lines.find((l: any) => l.amount === amount)

/** The CHECK's allowed values, read back from the database. */
async function checkValues(table: string, constraint: string): Promise<string[]> {
  const def = (await db.query<{ d: string }>(
    `SELECT pg_get_constraintdef(c.oid) AS d FROM pg_constraint c
      WHERE c.conrelid = $1::regclass AND c.conname = $2`, [table, constraint])).rows[0]?.d ?? ''
  return [...def.matchAll(/'([a-z_]+)'::(?:text|character varying)/g)].map(m => m[1]).sort()
}

// ═════════════════════════════════════════════════════════════════════════════
describe('reconciling a bank account on the ledger', () => {
  it('lines the feed matched arrive ticked; the rest are ticked by hand; it finishes only at a $0.00 difference and then freezes', async () => {
    const w = await world()
    await september(w)
    const acct = await linkedAccount(w)
    expect(acct).toMatchObject({ linked: true, ledgerBalance: 377.5, reconciledThrough: null, inProgress: null })

    // A statement after today, before the books start, or with no balance is refused.
    const bad = await request(app).post(`/api/books/reconcile/accounts/${acct.accountId}/start`).set(w.asOwner)
      .send({ statementDate: '2099-01-31', statementBalance: 1 })
    expect(bad.status).toBe(400)
    expect(bad.body.error).toMatch(/after today/)
    expect((await request(app).post(`/api/books/reconcile/accounts/${acct.accountId}/start`).set(w.asOwner)
      .send({ statementDate: '2025-12-31', statementBalance: 1 })).body.error).toMatch(/books start/)

    const start = await request(app).post(`/api/books/reconcile/accounts/${acct.accountId}/start`).set(w.asOwner)
      .send({ statementDate: '2026-09-30', statementBalance: '377.50' })
    expect(start.status, JSON.stringify(start.body)).toBe(200)
    let ws = start.body.data
    expect(ws.reconciliation).toMatchObject({ status: 'open', statementDate: '2026-09-30', statementBalance: 377.5 })
    expect(ws.lines).toHaveLength(3)
    expect(lineOf(ws, 500)).toMatchObject({ clearing: 'bank_line', automatic: true })
    expect(lineOf(ws, 500).bankLine).toMatchObject({ day: '2026-09-04' })
    expect(lineOf(ws, -82.5)).toMatchObject({ clearing: 'bank_line', automatic: true })
    expect(lineOf(ws, -40)).toMatchObject({ clearing: null, automatic: false })
    expect(ws).toMatchObject({ beginningBalance: 0, clearedBalance: 417.5, difference: -40, canFinish: false, ledgerBalance: 377.5, notCleared: -40 })

    // A second statement for the same account while one is open is refused.
    const twice = await request(app).post(`/api/books/reconcile/accounts/${acct.accountId}/start`).set(w.asOwner)
      .send({ statementDate: '2026-09-30', statementBalance: 1 })
    expect(twice.status).toBe(409)

    const recId = ws.reconciliation.id
    const early = await request(app).post(`/api/books/reconcile/${recId}/finish`).set(w.asOwner)
    expect(early.status).toBe(409)
    expect(early.body.error).toMatch(/\$40\.00 apart/)

    // A line the bank already matched cannot be taken off here.
    const off = await request(app).post(`/api/books/reconcile/${recId}/tick`).set(w.asOwner)
      .send({ lineIds: [lineOf(ws, 500).lineId], cleared: false })
    expect(off.status).toBe(409)
    expect(off.body.error).toMatch(/Bank page/)

    // Tick, untick (kept), tick again.
    ws = (await request(app).post(`/api/books/reconcile/${recId}/tick`).set(w.asOwner).send({ lineIds: [lineOf(ws, -40).lineId], cleared: true })).body.data
    expect(ws).toMatchObject({ difference: 0, canFinish: true })
    ws = (await request(app).post(`/api/books/reconcile/${recId}/tick`).set(w.asOwner).send({ lineIds: [lineOf(ws, -40).lineId], cleared: false })).body.data
    expect(ws).toMatchObject({ difference: -40, canFinish: false })
    ws = (await request(app).post(`/api/books/reconcile/${recId}/tick`).set(w.asOwner).send({ lineIds: [lineOf(ws, -40).lineId], cleared: true })).body.data
    const items = await db.query(`SELECT source, released_at IS NOT NULL AS released, release_reason FROM bank_reconciliation_items WHERE reconciliation_id = $1 ORDER BY ticked_at`, [recId])
    expect(items.rows).toEqual([
      { source: 'ticked', released: true, release_reason: 'unticked' },
      { source: 'ticked', released: false, release_reason: null },
    ])

    const done = await request(app).post(`/api/books/reconcile/${recId}/finish`).set(w.asOwner)
    expect(done.status, JSON.stringify(done.body)).toBe(200)
    expect(done.body.data.reconciliation).toBeNull()
    expect(done.body.data.history[0]).toMatchObject({ status: 'completed', statementDate: '2026-09-30', clearedBalance: 377.5, beginningBalance: 0 })
    const live = await db.query<{ source: string; amount: string; bank: boolean }>(
      `SELECT source, amount::text AS amount, bank_transaction_id IS NOT NULL AS bank FROM bank_reconciliation_items
        WHERE reconciliation_id = $1 AND released_at IS NULL ORDER BY amount::numeric`, [recId])
    expect(live.rows).toEqual([
      { source: 'bank_line', amount: '-82.50', bank: true },
      { source: 'ticked', amount: '-40.00', bank: false },
      { source: 'bank_line', amount: '500.00', bank: true },
    ])
    const rec = (await db.query(`SELECT status, cleared_balance::text AS c, book_balance::text AS b, difference::text AS d FROM bank_reconciliations WHERE id = $1`, [recId])).rows[0]
    expect(rec).toEqual({ status: 'completed', c: '377.50', b: '377.50', d: '0.00' })

    // Frozen: a cleared line never changes or goes away; a completed statement never changes but by being undone.
    await expect(db.query(`UPDATE bank_reconciliation_items SET amount = 1 WHERE reconciliation_id = $1`, [recId])).rejects.toThrow(/frozen/)
    await expect(db.query(`UPDATE bank_reconciliation_items SET released_at = now(), release_reason = 'unticked' WHERE reconciliation_id = $1 AND released_at IS NULL`, [recId]))
      .rejects.toThrow(/stays cleared/)
    await expect(db.query(`DELETE FROM bank_reconciliation_items WHERE reconciliation_id = $1`, [recId])).rejects.toThrow(/kept on record/)
    await expect(db.query(`UPDATE bank_reconciliations SET statement_balance = 1 WHERE id = $1`, [recId])).rejects.toThrow(/frozen/)
    await expect(db.query(`DELETE FROM bank_reconciliations WHERE id = $1`, [recId])).rejects.toThrow(/kept on record/)

    // The next statement starts from what this one cleared; an earlier statement is refused.
    expect((await request(app).post(`/api/books/reconcile/accounts/${acct.accountId}/start`).set(w.asOwner)
      .send({ statementDate: '2026-09-15', statementBalance: 1 })).body.error).toMatch(/reconciled through 2026-09-30/)
    const oct = await request(app).post(`/api/books/reconcile/accounts/${acct.accountId}/start`).set(w.asOwner)
      .send({ statementDate: '2026-10-05', statementBalance: 377.5 })
    expect(oct.status, JSON.stringify(oct.body)).toBe(200)
    expect(oct.body.data).toMatchObject({ beginningBalance: 377.5, clearedBalance: 377.5, difference: 0, canFinish: true, lines: [] })
    expect((await linkedAccount(w)).reconciledThrough).toBe('2026-09-30')
  })

  it('a line and the line that took it back on the same statement clear together at $0.00 and are not listed', async () => {
    const w = await world()
    const { handExpense } = await september(w)
    await voidLandlordExpense(handExpense, w.landlordId)
    expect(await drainLedgerOutbox()).toMatchObject({ failed: 0 })
    const acct = await linkedAccount(w)
    const ws = (await request(app).post(`/api/books/reconcile/accounts/${acct.accountId}/start`).set(w.asOwner)
      .send({ statementDate: '2026-09-30', statementBalance: 417.5 })).body.data
    expect(ws.lines.map((l: any) => l.amount).sort()).toEqual([-82.5, 500])
    expect(ws).toMatchObject({ canceledPairs: 1, difference: 0, canFinish: true })
    const done = await request(app).post(`/api/books/reconcile/${ws.reconciliation.id}/finish`).set(w.asOwner)
    expect(done.status, JSON.stringify(done.body)).toBe(200)
    const src = await db.query<{ source: string; n: number }>(
      `SELECT source, count(*)::int AS n FROM bank_reconciliation_items WHERE reconciliation_id = $1 AND released_at IS NULL GROUP BY 1 ORDER BY 1`,
      [ws.reconciliation.id])
    expect(src.rows).toEqual([{ source: 'bank_line', n: 2 }, { source: 'cancels_out', n: 2 }])
  })

  it('changing the statement\'s last day takes off ticks after it; an open statement is set aside with why; only the latest completed one is undone', async () => {
    const w = await world()
    await september(w)
    const acct = await linkedAccount(w)
    let ws = (await request(app).post(`/api/books/reconcile/accounts/${acct.accountId}/start`).set(w.asOwner)
      .send({ statementDate: '2026-09-30', statementBalance: 377.5 })).body.data
    const recId = ws.reconciliation.id
    ws = (await request(app).post(`/api/books/reconcile/${recId}/tick`).set(w.asOwner).send({ lineIds: [lineOf(ws, -40).lineId], cleared: true })).body.data
    expect(ws.canFinish).toBe(true)
    // Moved to Sept 5: the Sept 6 tick comes off, and the line is not on it.
    ws = (await request(app).patch(`/api/books/reconcile/${recId}`).set(w.asOwner).send({ statementDate: '2026-09-05', statementBalance: 417.5 })).body.data
    expect(ws.reconciliation).toMatchObject({ statementDate: '2026-09-05', statementBalance: 417.5 })
    expect(ws.lines.map((l: any) => l.amount).sort()).toEqual([-82.5, 500])
    expect(ws).toMatchObject({ difference: 0 })

    expect((await request(app).post(`/api/books/reconcile/${recId}/undo`).set(w.asOwner).send({ reason: ' ' })).status).toBe(400)
    const aside = await request(app).post(`/api/books/reconcile/${recId}/undo`).set(w.asOwner).send({ reason: 'Typed the wrong statement' })
    expect(aside.status, JSON.stringify(aside.body)).toBe(200)
    expect(aside.body.data.history[0]).toMatchObject({ status: 'undone', undoReason: 'Typed the wrong statement' })

    // Aug, then Sept, reconciled; Aug cannot be undone while Sept stands.
    const aug = (await request(app).post(`/api/books/reconcile/accounts/${acct.accountId}/start`).set(w.asOwner)
      .send({ statementDate: '2026-08-31', statementBalance: 0 })).body.data
    expect((await request(app).post(`/api/books/reconcile/${aug.reconciliation.id}/finish`).set(w.asOwner)).status).toBe(200)
    ws = (await request(app).post(`/api/books/reconcile/accounts/${acct.accountId}/start`).set(w.asOwner)
      .send({ statementDate: '2026-09-30', statementBalance: 377.5 })).body.data
    ws = (await request(app).post(`/api/books/reconcile/${ws.reconciliation.id}/tick`).set(w.asOwner).send({ lineIds: [lineOf(ws, -40).lineId], cleared: true })).body.data
    const sept = ws.reconciliation.id
    expect((await request(app).post(`/api/books/reconcile/${sept}/finish`).set(w.asOwner)).status).toBe(200)
    const augUndo = await request(app).post(`/api/books/reconcile/${aug.reconciliation.id}/undo`).set(w.asOwner).send({ reason: 'x' })
    expect(augUndo.status).toBe(409)
    expect(augUndo.body.error).toMatch(/latest/)
    const septUndo = await request(app).post(`/api/books/reconcile/${sept}/undo`).set(w.asOwner).send({ reason: 'Bank corrected the statement' })
    expect(septUndo.status, JSON.stringify(septUndo.body)).toBe(200)
    const released = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM bank_reconciliation_items WHERE reconciliation_id = $1 AND release_reason = 'reconciliation_undone'`, [sept])
    expect(released.rows[0].n).toBe(3)
    // Its lines are free again: the account is reconciled through August.
    expect((await linkedAccount(w)).reconciledThrough).toBe('2026-08-31')
  })

  it('a transfer between two linked accounts arrives ticked on each side, against each side\'s own bank line, once that line is on the statement', async () => {
    const w = await world()
    const savings = (await db.query<{ id: string }>(
      `INSERT INTO bank_connections (landlord_id, provider, status, display_name) VALUES ($1, 'stripe_fc', 'active', 'Savings') RETURNING id`,
      [w.landlordId])).rows[0].id
    const out = await bankLine(w, '2026-09-10', -500, 'TRANSFER')
    const arrived = (await db.query<{ id: string }>(
      `INSERT INTO bank_transactions (bank_connection_id, landlord_id, external_id, posted_date, amount, description, normalized_merchant, status, bank_status)
       VALUES ($1, $2, $3, '2026-09-11', 500, 'TRANSFER', 'TRANSFER', 'needs_review', 'posted') RETURNING id`,
      [savings, w.landlordId, randomUUID()])).rows[0].id
    await matchLineToRecord({ landlordId: w.landlordId, lineId: out, kind: 'transfer', recordId: arrived, by: null })
    expect(await drainLedgerOutbox()).toMatchObject({ failed: 0 })
    const accounts = (await request(app).get('/api/books/reconcile/accounts').set(w.asOwner)).body.data
    const sav = accounts.find((x: any) => x.bankConnectionId === savings)
    const chk = accounts.find((x: any) => x.bankConnectionId === w.connectionId)
    // The money arrived in savings on the 11th: a statement through the 10th does not show it yet.
    let ws = (await request(app).post(`/api/books/reconcile/accounts/${sav.accountId}/start`).set(w.asOwner)
      .send({ statementDate: '2026-09-10', statementBalance: 0 })).body.data
    expect(ws.lines).toHaveLength(1)
    expect(ws.lines[0]).toMatchObject({ amount: 500, clearing: null, bankLine: { id: arrived, day: '2026-09-11' } })
    ws = (await request(app).patch(`/api/books/reconcile/${ws.reconciliation.id}`).set(w.asOwner).send({ statementDate: '2026-09-30', statementBalance: 500 })).body.data
    expect(ws.lines[0]).toMatchObject({ amount: 500, clearing: 'bank_line', automatic: true })
    expect(ws.canFinish).toBe(true)
    const wc = (await request(app).post(`/api/books/reconcile/accounts/${chk.accountId}/start`).set(w.asOwner)
      .send({ statementDate: '2026-09-30', statementBalance: -500 })).body.data
    expect(wc.lines).toEqual([expect.objectContaining({ amount: -500, clearing: 'bank_line', bankLine: expect.objectContaining({ id: out }) })])
    expect(wc.canFinish).toBe(true)
  })

  it('who may reconcile: the owner and a bookkeeper with the company\'s ledger; a property-only bookkeeper may not', async () => {
    const w = await world()
    await september(w)
    const acct = await linkedAccount(w, w.ledger)
    expect((await request(app).get('/api/books/reconcile/accounts').set(w.wide)).status).toBe(200)
    const refused = await request(app).get('/api/books/reconcile/accounts').set(w.property)
    expect(refused.status).toBe(403)
    expect(refused.body.error).toBe(LEDGER_REFUSAL)
    const started = await request(app).post(`/api/books/reconcile/accounts/${acct.accountId}/start`).set(w.ledger)
      .send({ statementDate: '2026-09-30', statementBalance: 377.5 })
    expect(started.status, JSON.stringify(started.body)).toBe(200)
    expect((await request(app).post(`/api/books/reconcile/${started.body.data.reconciliation.id}/tick`).set(w.property)
      .send({ lineIds: [lineOf(started.body.data, -40).lineId], cleared: true })).status).toBe(403)
  })
})

describe('journal entries on a bank account, and the nightly look at each bank', () => {
  it('a bookkeeper\'s journal line on the bank is listed apart as a reconciling item; the night\'s run notes it and the bank\'s own balance beside the books', async () => {
    const w = await world()
    await september(w)
    const acct = await linkedAccount(w)
    const interest = (await db.query<{ id: string }>(
      `SELECT account_id AS id FROM books_account_map WHERE landlord_id = $1 AND map_kind = 'role' AND map_value = 'interest_earned'`, [w.landlordId])).rows[0].id
    await inTx(async (c) => {
      const e = await c.query<{ id: string }>(
        `INSERT INTO journal_entries (landlord_id, date, description, type) VALUES ($1, '2026-09-25', 'Bank interest', 'manual') RETURNING id`, [w.landlordId])
      await c.query(`INSERT INTO journal_entry_lines (entry_id, account_id, debit, credit) VALUES ($1, $2, 1.25, 0), ($1, $3, 0, 1.25)`,
        [e.rows[0].id, acct.accountId, interest])
    })
    await db.query(`UPDATE bank_connections SET current_balance = 400, balance_as_of = now() WHERE id = $1`, [w.connectionId])
    expect(await drainLedgerOutbox()).toMatchObject({ failed: 0 })

    const ws = (await request(app).post(`/api/books/reconcile/accounts/${acct.accountId}/start`).set(w.asOwner)
      .send({ statementDate: '2026-09-30', statementBalance: 378.75 })).body.data
    expect(ws.lines.filter((l: any) => l.journalEntry)).toEqual([expect.objectContaining({ amount: 1.25, clearing: null, automatic: false })])

    const run = await checkOwner(w.owner, { repair: false })
    const info = run.findings.filter(f => f.severity === 'info' && f.check.startsWith('bank_'))
    expect(info).toEqual(expect.arrayContaining([
      expect.objectContaining({ check: 'bank_reconciling_items', detail: expect.objectContaining({ accountId: acct.accountId, lines: 1, net: 1.25 }) }),
      expect.objectContaining({ check: 'bank_balance_vs_books', detail: expect.objectContaining({ accountId: acct.accountId, bankBalance: 400, onTheBooks: 378.75, notCleared: 21.25 }) }),
    ]))
    // Informational: never a block on the close.
    const st = await request(app).get('/api/books/close?through=2026-08-31').set(w.asOwner)
    expect(st.body.data.blockers).toEqual([])
  })
})

describe('closing a month', () => {
  it('a linked bank with money on the books blocks the close until reconciled through the month\'s end; warnings never block and stay on the close', async () => {
    const w = await world()
    await september(w)
    await bankLine(w, '2026-09-20', -12.34, 'UNKNOWN')                 // not filed
    await createLandlordExpense({                                        // a bill past due
      landlordId: w.landlordId, propertyId: w.propertyId, category: 'utilities', amount: 60, expenseDate: '2026-09-01',
      dueDate: '2026-09-15', payment: null,
    })
    await db.query(
      `INSERT INTO landlord_other_income (landlord_id, property_id, category, amount, income_date, description)
       VALUES ($1, $2, 'other', 25, '2026-09-10', 'Cash, not sure what for')`, [w.landlordId, w.propertyId])
    expect(await drainLedgerOutbox()).toMatchObject({ failed: 0 })

    const s1 = await request(app).get('/api/books/close?through=2026-09-30').set(w.asOwner)
    expect(s1.status, JSON.stringify(s1.body)).toBe(200)
    expect(s1.body.data).toMatchObject({ through: '2026-09-30', ready: false, canClose: true, canReopen: false, closedThrough: null })
    expect(s1.body.data.blockers).toHaveLength(1)
    expect(s1.body.data.blockers[0].text).toMatch(/Checking: Operating.*not reconciled yet.*through 2026-09-30/)
    expect(s1.body.data.warnings.map((x: any) => x.kind).sort()).toEqual(['overdue_bills', 'suspense_balance', 'unfiled_bank_lines'])
    expect(s1.body.data.warnings.find((x: any) => x.kind === 'suspense_balance')).toMatchObject({ amount: 25 })
    expect(s1.body.data.warnings.find((x: any) => x.kind === 'overdue_bills')).toMatchObject({ count: 1, amount: 60 })

    const refused = await request(app).post('/api/books/close').set(w.asOwner).send({ through: '2026-09-30' })
    expect(refused.status).toBe(409)
    expect(refused.body.error).toMatch(/not ready to close: .*reconcile its statement through 2026-09-30/)

    // August has no money on the linked bank: it closes, with September's warnings nowhere.
    const aug = await request(app).post('/api/books/close').set(w.wide).send({ through: '2026-08-31' })
    expect(aug.status, JSON.stringify(aug.body)).toBe(200)

    // Reconcile September (the unfiled line is not on the books, so not on the worksheet).
    const acct = await linkedAccount(w)
    let ws = (await request(app).post(`/api/books/reconcile/accounts/${acct.accountId}/start`).set(w.asOwner)
      .send({ statementDate: '2026-09-30', statementBalance: 377.5 })).body.data
    ws = (await request(app).post(`/api/books/reconcile/${ws.reconciliation.id}/tick`).set(w.asOwner).send({ lineIds: [lineOf(ws, -40).lineId], cleared: true })).body.data
    const sept = ws.reconciliation.id
    expect((await request(app).post(`/api/books/reconcile/${sept}/finish`).set(w.asOwner)).status).toBe(200)

    const s2 = await request(app).post('/api/books/close/check').set(w.asOwner).send({ through: '2026-09-30' })
    expect(s2.status, JSON.stringify(s2.body)).toBe(200)
    expect(s2.body.data).toMatchObject({ ready: true, blockers: [] })
    const closed = await request(app).post('/api/books/close').set(w.asOwner).send({ through: '2026-09-30', note: 'September done' })
    expect(closed.status, JSON.stringify(closed.body)).toBe(200)
    expect(closed.body.data).toMatchObject({ closedThrough: '2026-09-30' })
    const st = closed.body.data.status
    expect(st).toMatchObject({ closedThrough: '2026-09-30', canReopen: true })
    expect(st.history[0]).toMatchObject({ action: 'close', closedThrough: '2026-09-30', reason: 'September done' })
    expect(st.history[0].warnings.map((x: any) => x.kind).sort()).toEqual(['overdue_bills', 'suspense_balance', 'unfiled_bank_lines'])
    expect(st.history[1]).toMatchObject({ action: 'close', closedThrough: '2026-08-31', warnings: [] })

    // A reconciliation inside a closed month cannot be undone.
    const undo = await request(app).post(`/api/books/reconcile/${sept}/undo`).set(w.asOwner).send({ reason: 'x' })
    expect(undo.status).toBe(409)
    expect(undo.body.error).toMatch(/closed through 2026-09-30/)

    // Reopen (the owner, by default), always saying why.
    expect((await request(app).post('/api/books/close/reopen').set(w.wide).send({ month: '2026-09-01', reason: 'late bill' })).status).toBe(403)
    expect((await request(app).post('/api/books/close/reopen').set(w.asOwner).send({ month: '2026-09-01' })).status).toBe(400)
    const re = await request(app).post('/api/books/close/reopen').set(w.asOwner).send({ month: '2026-09-01', reason: 'late bill' })
    expect(re.status, JSON.stringify(re.body)).toBe(200)
    expect(re.body.data.status).toMatchObject({ closedThrough: '2026-08-31' })
    expect(re.body.data.status.history[0]).toMatchObject({ action: 'reopen', closedThrough: '2026-08-31', reason: 'late bill', warnings: [] })
  })

  it('the close screen is the company-wide box\'s: a ledger-only or property-only bookkeeper is refused, and a company-wide one closes when the owner allows it', async () => {
    const w = await world()
    expect((await request(app).get('/api/books/close').set(w.ledger)).status).toBe(403)
    expect((await request(app).get('/api/books/close').set(w.property)).status).toBe(403)
    const s = await request(app).get('/api/books/close').set(w.wide)
    expect(s.status, JSON.stringify(s.body)).toBe(200)
    // Nothing on the books yet: the next month to close is the books' first month.
    expect(s.body.data).toMatchObject({ nextThrough: '2026-01-31', through: '2026-01-31', ready: true, canClose: true, canReopen: false })
    await db.query(`UPDATE landlords SET books_close_by = 'owner' WHERE id = $1`, [w.landlordId])
    const owners = await request(app).get('/api/books/close').set(w.wide)
    expect(owners.body.data).toMatchObject({ canClose: false, closeRefusal: 'Only the owner closes a month in these books.' })
    expect((await request(app).post('/api/books/close').set(w.wide).send({ through: '2026-01-31' })).status).toBe(403)
    expect((await request(app).post('/api/books/close').set(w.asOwner).send({ through: '2026-01-31' })).status).toBe(200)
    expect((await request(app).get('/api/books/close').set(w.asOwner)).body.data).toMatchObject({ closedThrough: '2026-01-31', nextThrough: '2026-02-28' })
  })
})

describe('the shared lists match the database', () => {
  it('statuses, how a line cleared, why it was let go, and the close warnings', async () => {
    expect(await checkValues('bank_reconciliations', 'bank_reconciliations_status_check')).toEqual([...BANK_RECONCILIATION_STATUSES].sort())
    expect(await checkValues('bank_reconciliation_items', 'bank_reconciliation_items_source_check')).toEqual([...BANK_RECONCILIATION_ITEM_SOURCES].sort())
    expect(await checkValues('bank_reconciliation_items', 'bank_reconciliation_items_release_check')).toEqual([...BANK_RECONCILIATION_ITEM_RELEASES].sort())
    expect(new Set(LEDGER_CLOSE_WARNINGS).size).toBe(4)
  })
})
