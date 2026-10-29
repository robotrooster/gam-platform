/**
 * 10/12 (Nic) — GAM Books, phase P8: the Books statements read the ledger
 * (routes/booksLedgerReports), with every bookkeeper box honored:
 *   - the P&L and money out are company reports: a bookkeeper's property money
 *     is their properties' unless "Company reports show the whole company"
 *     (BK2) is ticked;
 *   - the balance sheet, trial balance and general ledger are the
 *     whole-company ledger (the company-wide box or "May use the whole-company
 *     ledger", BK1); without either they are refused in plain words;
 *   - a company whose books are not live keeps the older reports (P&L) or is
 *     told why there is no ledger report yet.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { randomUUID } from 'crypto'
import { db } from '../db'
import { booksRouter } from './books'
import { errorHandler } from '../middleware/errorHandler'
import { tenantCo, bill, receipt, drain, addLease, cleanupTenantLedger, type TenantCo } from '../test/ledgerTenantFixtures'
import { registerProductionLedgerProjectors, unregisterProductionLedgerProjectors } from '../services/ledgerProjectors'
import { markLedgerLive } from '../test/ledgerReportFixtures'

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/books', booksRouter)
  app.use(errorHandler)
  return app
}
const sign = (p: object) => jwt.sign(p, process.env.JWT_SECRET!, { expiresIn: '1h' })

beforeEach(async () => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_books_ledger_reports'
  await cleanupTenantLedger()
  registerProductionLedgerProjectors()
})
afterEach(() => unregisterProductionLedgerProjectors())

interface World extends TenantCo { ownerTok: string; secondUnit: string; secondLease: string }

/** A company: $1,000 rent on property 1 (paid $400 cash), $300 rent on property 2 (unpaid). */
async function world(): Promise<World> {
  const co = await tenantCo()
  const rent = await bill(co, { amount: 1000, due: '2026-10-01' })
  await receipt(co, { method: 'cash', settledAt: '2026-10-03T17:00:00Z', apps: [{ paymentId: rent, amount: 400 }], settleRows: false })
  const second = await addLease(co)
  await bill(co, { amount: 300, due: '2026-10-01', unitId: second.unitId, leaseId: second.leaseId })
  await drain()
  return {
    ...co, secondUnit: second.unitId, secondLease: second.leaseId,
    ownerTok: sign({ userId: co.ownerUserId, role: 'landlord', email: 'o@t.dev', profileId: null, landlordIds: [co.landlordId], permissions: {} }),
  }
}

async function bookkeeper(w: World, propertyIds: string[], b: { companyWide?: boolean; ledger?: boolean; wholeReports?: boolean } = {}): Promise<string> {
  const id = (await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
     VALUES ($1, 'x', 'bookkeeper', 'Bo', 'Keeper', TRUE) RETURNING id`, [`bk-${randomUUID()}@test.dev`])).rows[0].id
  await db.query(
    `INSERT INTO bookkeeper_scopes (user_id, landlord_id, property_ids, company_wide, company_ledger, whole_company_reports, access_level)
     VALUES ($1, $2, $3, $4, $5, $6, 'read_only')`,
    [id, w.landlordId, propertyIds, !!b.companyWide, !!b.ledger, !!b.wholeReports])
  return sign({ userId: id, role: 'bookkeeper', email: 'bk@t.dev', profileId: null, landlordId: w.landlordId, permissions: { access_level: 'read_only' } })
}

const get = (url: string, tok: string, client?: string) => {
  const r = request(buildApp()).get(url).set('Authorization', `Bearer ${tok}`)
  return client ? r.set('X-Client-Id', client) : r
}
const OCT = 'startDate=2026-10-01&endDate=2026-10-31'

describe('the P&L', () => {
  it('keeps the older report until the books are live, then reads the ledger: three columns, the strip, both nets', async () => {
    const w = await world()
    const before = await get(`/api/books/reports/pl?${OCT}`, w.ownerTok)
    expect(before.status).toBe(200)
    expect(before.body.data.source).toBeUndefined()

    await markLedgerLive(w.landlordId)
    const r = await get(`/api/books/reports/pl?${OCT}`, w.ownerTok)
    expect(r.status).toBe(200)
    const d = r.body.data
    expect(d.source).toBe('ledger')
    expect(d.lead).toBe('received')
    expect([d.view.received, d.view.charged, d.view.owed]).toEqual([400, 1300, 900])
    expect(d.view.proof).toMatchObject({ owedAtStart: 0, billed: 1300, received: 400, owedAtEnd: 900 })
    expect(d.view.tieText[1]).toMatch(/= owed \$900\.00 at the end of Oct 31, 2026\./)
    expect(d.nets).toEqual({ received: 400, charged: 1300 })
    expect(d.meta.columns.map((c: any) => c.key)).toEqual(['received', 'charged', 'owed'])
    expect(d.meta.columns[2].note).toMatch(/at the end of the period/)
  })

  it('a bookkeeper\'s P&L is their properties\' money unless the owner ticked "whole company" (BK2)', async () => {
    const w = await world()
    await markLedgerLive(w.landlordId)
    const own = await bookkeeper(w, [w.propertyId], { ledger: true })
    const r1 = await get(`/api/books/reports/pl?${OCT}`, own, w.landlordId)
    expect(r1.status).toBe(200)
    expect([r1.body.data.view.charged, r1.body.data.view.owed]).toEqual([1000, 600])
    const whole = await bookkeeper(w, [w.propertyId], { ledger: true, wholeReports: true })
    const r2 = await get(`/api/books/reports/pl?${OCT}`, whole, w.landlordId)
    expect(r2.body.data.view.charged).toBe(1300)
  })

  it('bad dates are refused in plain words', async () => {
    const w = await world()
    await markLedgerLive(w.landlordId)
    const r = await get('/api/books/reports/pl?startDate=2026-10-31&endDate=2026-10-01', w.ownerTok)
    expect(r.status).toBe(400)
    expect(r.body.error).toBe('The start date is after the end date.')
  })
})

describe('the whole-company ledger: balance sheet, trial balance, general ledger', () => {
  it('the balance sheet and trial balance balance; a property\'s trial balance on its own does too', async () => {
    const w = await world()
    await markLedgerLive(w.landlordId)
    const bs = await get('/api/books/reports/balance-sheet?asOf=2026-10-31', w.ownerTok)
    expect(bs.body.data).toMatchObject({ source: 'ledger', balances: true })
    for (const p of ['all', w.propertyId, w.propertyId2]) {
      const tb = await get(`/api/books/reports/trial-balance?${OCT}&property=${p}`, w.ownerTok)
      expect(tb.status).toBe(200)
      expect(tb.body.data.balances, p).toBe(true)
    }
  })

  it('a bookkeeper with the ledger box reads the whole company\'s ledger; one without it is refused', async () => {
    const w = await world()
    await markLedgerLive(w.landlordId)
    const withLedger = await bookkeeper(w, [w.propertyId], { ledger: true })
    const tb = await get(`/api/books/reports/trial-balance?${OCT}`, withLedger, w.landlordId)
    expect(tb.status).toBe(200)
    expect(tb.body.data.rows.find((r: any) => r.code === '1100').closing).toBe(900)
    const without = await bookkeeper(w, [w.propertyId])
    const refused = await get(`/api/books/reports/trial-balance?${OCT}`, without, w.landlordId)
    expect(refused.status).toBe(403)
    expect(refused.body.error).toMatch(/ledger/)
  })

  it('the general ledger opens one account of these books, with a running balance and the record behind each line', async () => {
    const w = await world()
    await markLedgerLive(w.landlordId)
    const ar = (await db.query<{ id: string }>(
      `SELECT DISTINCT account_id AS id FROM ledger_posting_lines WHERE landlord_id = $1 AND account_role = 'ar_tenants'`, [w.landlordId])).rows[0].id
    const r = await get(`/api/books/reports/general-ledger?${OCT}&accountId=${ar}`, w.ownerTok)
    expect(r.status).toBe(200)
    expect(r.body.data.closing).toBe(900)
    expect(r.body.data.lines.map((l: any) => l.source.label)).toEqual(expect.arrayContaining(['A tenant bill', 'A payment received']))
    expect((await get(`/api/books/reports/general-ledger?${OCT}`, w.ownerTok)).status).toBe(400)
    const other = await world()
    const theirs = (await db.query<{ id: string }>(
      `SELECT DISTINCT account_id AS id FROM ledger_posting_lines WHERE landlord_id = $1 AND account_role = 'ar_tenants'`, [other.landlordId])).rows[0].id
    expect((await get(`/api/books/reports/general-ledger?${OCT}&accountId=${theirs}`, w.ownerTok)).status).toBe(404)
  })

  it('a company whose books are not live is told why, with no figures', async () => {
    const w = await world()
    const r = await get(`/api/books/reports/trial-balance?${OCT}`, w.ownerTok)
    expect(r.status).toBe(200)
    expect(r.body.data).toMatchObject({ live: false, rows: [] })
    expect(r.body.data.reason).toMatch(/being built/)
    const s = await get('/api/books/reports/ledger-status', w.ownerTok)
    expect(s.body.data.live).toBe(false)
    await markLedgerLive(w.landlordId)
    expect((await get('/api/books/reports/ledger-status', w.ownerTok)).body.data).toEqual({ live: true, reason: null })
  })
})

describe('the chart of accounts', () => {
  it('shows each account\'s balance on the books once they are live', async () => {
    const w = await world()
    await markLedgerLive(w.landlordId)
    const r = await get('/api/books/accounts', w.ownerTok)
    expect(r.status).toBe(200)
    const ar = r.body.data.find((a: any) => a.code === '1100')
    expect(ar).toMatchObject({ balance: '900.00', balance_source: 'ledger', normal_balance: 900 })
    // 10/14 (Nic I1): an apartment's rent books to its own line, "Apartment
    // rent", under 4010 Space and lot rent (which carries none itself now).
    const parent = r.body.data.find((a: any) => a.code === '4010')
    const rent = r.body.data.find((a: any) => a.code === '4010-1')
    expect(rent).toMatchObject({ name: 'Apartment rent', parent_account_id: parent.id, normal_balance: 1300 })
    expect(parent.normal_balance).toBe(0)
  })
})

describe('what tenants owe, by household and age', () => {
  it('the owner sees it; a bookkeeper\'s is their properties\' (BK2)', async () => {
    const w = await world()
    await markLedgerLive(w.landlordId)
    const r = await get('/api/books/reports/receivables?asOf=2026-10-31', w.ownerTok)
    expect(r.status).toBe(200)
    expect(r.body.data.totals.total).toBe(900)
    expect(r.body.data.rows.map((x: any) => x.total).sort()).toEqual([300, 600])
    expect(r.body.data.bucketLabels.days1to30).toBe('1–30 days late')
    const own = await bookkeeper(w, [w.propertyId], { ledger: true })
    const b = await get('/api/books/reports/receivables?asOf=2026-10-31', own, w.landlordId)
    expect(b.body.data.totals.total).toBe(600)
  })
})

describe('money out and cash flow', () => {
  it('money out answers on the ledger; cash flow ties opening + rows to closing', async () => {
    const w = await world()
    await markLedgerLive(w.landlordId)
    const mo = await get(`/api/books/reports/money-out?${OCT}`, w.ownerTok)
    expect(mo.status).toBe(200)
    expect(mo.body.data.totals).toEqual({ incurred: 0, paid: 0, unpaid: 0 })
    const cf = await get(`/api/books/reports/cash-flow?${OCT}`, w.ownerTok)
    expect(cf.body.data.source).toBe('ledger')
    const rows = cf.body.data.rows.reduce((t: number, r: any) => t + r.amount, 0)
    expect(cf.body.data.openingCash + rows).toBeCloseTo(cf.body.data.closingCash, 2)
    expect(cf.body.data.closingCash).toBe(400)
  })
})
