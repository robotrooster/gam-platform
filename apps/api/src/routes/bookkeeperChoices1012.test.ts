/**
 * 10/12 (Nic) — THREE MORE BOXES ON A BOOKKEEPER, EACH THE OWNER'S CHOICE.
 *
 *   BK1  "May use the whole-company ledger": the GAM Books ledger (chart,
 *        journal, transactions, bank reconciliation, bills, vendors, payroll,
 *        tax, P&L, balance sheet) for a bookkeeper WITHOUT the company-wide
 *        box. Never the bank account or payouts, nor the Books cash flow and
 *        owner statements (they carry the payouts).
 *   BK2  "Company reports show the whole company": the Books company reports
 *        (P&L, cash flow, owner statements) carry the whole company's money;
 *        unticked, only their properties'. A sold property they never kept
 *        stays hidden (BK3). The financial pages never widen.
 *   BK-report  "Sees the monthly property report on screen": their current
 *        properties only.
 *   SECURITY: every box is enforced on the server where its surface is
 *        served, and staff may only give what they hold themselves.
 *
 * The world: Canyon LLC owns Alder, Birch and Cedar; Delta LLC (the same
 * owner) owns Elm. Alder earned 500 in September, Birch 300.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { randomUUID } from 'crypto'
import { db } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedTenant, seedLease, seedLeaseTenant, withRollback } from '../test/dbHelpers'
import { errorHandler } from '../middleware/errorHandler'
import { financialsRouter } from './financials'
import { expensesRouter } from './expenses'
import { reportsRouter } from './reports'
import { booksRouter } from './books'
import { scopesRouter, invitationsRouter } from './scopes'
import { transferProperty } from '../services/propertyTransfer'
import { bookkeeperScopesOf, requestScopeOf, HIDDEN_HISTORY } from '../lib/bookkeeperScope'
import { bookkeeperAccessSummary } from '@gam/shared'

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/financials', financialsRouter)
  app.use('/api/expenses', expensesRouter)
  app.use('/api/reports', reportsRouter)
  app.use('/api/books', booksRouter)
  app.use('/api/scopes', scopesRouter)
  app.use('/api/invitations', invitationsRouter)
  app.use(errorHandler)
  return app
}
const app = () => buildApp()
const sign = (p: object) => jwt.sign(p, process.env.JWT_SECRET!, { expiresIn: '1h' })

beforeEach(async () => {
  await cleanupAllSchema()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_bookkeeper_choices_1012'
})

interface World {
  ownerUserId: string
  canyon: string; delta: string
  alder: string; birch: string; cedar: string; elm: string
  alderUnit: string; birchUnit: string
  owner: string
}

async function world(): Promise<World> {
  const c = await db.connect()
  try {
    const { userId: ownerUserId, landlordId: canyon } = await seedLandlord(c)
    await c.query(`UPDATE landlords SET business_name = 'Canyon LLC' WHERE id = $1`, [canyon])
    const delta = (await c.query<{ id: string }>(
      `INSERT INTO landlords (user_id, billing_starts_at, business_name) VALUES ($1, DATE '2000-01-01', 'Delta LLC') RETURNING id`,
      [ownerUserId])).rows[0].id
    const mk = async (landlordId: string, name: string) => {
      const id = await seedProperty(c, { landlordId, ownerUserId, managedByUserId: ownerUserId })
      await c.query(`UPDATE properties SET name = $2, timezone = 'America/Phoenix' WHERE id = $1`, [id, name])
      return id
    }
    const alder = await mk(canyon, 'Alder'), birch = await mk(canyon, 'Birch'), cedar = await mk(canyon, 'Cedar')
    const elm = await mk(delta, 'Elm')
    const alderUnit = await seedUnit(c, { propertyId: alder, landlordId: canyon })
    const birchUnit = await seedUnit(c, { propertyId: birch, landlordId: canyon })
    return {
      ownerUserId, canyon, delta, alder, birch, cedar, elm, alderUnit, birchUnit,
      owner: sign({ userId: ownerUserId, role: 'landlord', email: 'o@t.dev', profileId: null, landlordIds: [canyon, delta], permissions: {} }),
    }
  } finally { c.release() }
}

interface Boxes {
  companyWide?: boolean; companyLedger?: boolean; wholeCompanyReports?: boolean; seesMonthlyReport?: boolean
  accessLevel?: 'read_only' | 'read_write'
}
async function bookkeeper(landlordId: string, propertyIds: string[], b: Boxes = {}): Promise<{ id: string; tok: string }> {
  const id = (await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
     VALUES ($1, 'x', 'bookkeeper', 'Bo', 'Keeper', TRUE) RETURNING id`, [`bk-${randomUUID()}@test.dev`])).rows[0].id
  await db.query(
    `INSERT INTO bookkeeper_scopes (user_id, landlord_id, property_ids, company_wide, company_ledger,
                                    whole_company_reports, sees_monthly_report, access_level)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [id, landlordId, propertyIds, !!b.companyWide, !!b.companyLedger, !!b.wholeCompanyReports, !!b.seesMonthlyReport,
     b.accessLevel ?? 'read_only'])
  return { id, tok: sign({ userId: id, role: 'bookkeeper', email: 'bk@t.dev', profileId: null, landlordId, permissions: { access_level: b.accessLevel ?? 'read_only' } }) }
}

/** A settled rent payment on a unit, on the day named. */
async function paidOn(unitId: string, landlordId: string, amount: number, at: string) {
  const c = await db.connect()
  try {
    const tenantId = await seedTenant(c)
    const leaseId = await seedLease(c, { unitId, landlordId, rentAmount: amount })
    await seedLeaseTenant(c, { leaseId, tenantId })
    await c.query(
      `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, entry_description, due_date, settled_at)
       VALUES ($1,$2,$3,$4,'rent',$5,'settled','RENT',$6::date,$6::timestamptz)`,
      [unitId, leaseId, tenantId, landlordId, amount, at])
  } finally { c.release() }
}
async function september(w: World) {
  await paidOn(w.alderUnit, w.canyon, 500, '2026-09-03T18:00:00Z')
  await paidOn(w.birchUnit, w.canyon, 300, '2026-09-04T18:00:00Z')
}
/** Canyon sells a property to Delta, the sale dated 9/20 noon Phoenix. */
async function sell(w: World, propertyId: string) {
  const t = await transferProperty({ propertyId, fromLandlordId: w.canyon, toLandlordId: w.delta, byUserId: w.ownerUserId })
  await db.query(`UPDATE property_transfers SET transferred_at = '2026-09-20T19:00:00Z' WHERE id = $1`, [t.transferId])
  await db.query(`UPDATE bookkeeper_former_properties SET left_at = '2026-09-20T19:00:00Z' WHERE property_transfer_id = $1`, [t.transferId])
}

const get = (tok: string, url: string) => request(app()).get(url).set('Authorization', `Bearer ${tok}`)
const booksGet = (tok: string, url: string, clientId: string) => get(tok, url).set('X-Client-Id', clientId)
const scopeOf = async (userId: string, landlordId: string) => requestScopeOf((await bookkeeperScopesOf(userId, landlordId))[0])
const SEPT = 'startDate=2026-09-01&endDate=2026-09-30'
const LEDGER_NO = "The company's ledger (its accounts, journal, bills, payroll and tax) is not among what the owner has given you. Ask the owner for it."

describe('BK1: "May use the whole-company ledger" without the company-wide box', () => {
  it('opens the whole Books ledger — and never the bank account, payouts, cash flow or owner statements', async () => {
    const w = await world()
    await september(w)
    const al = await bookkeeper(w.canyon, [w.alder], { companyLedger: true })
    for (const url of [
      '/api/books/accounts', '/api/books/employees', '/api/books/vendors', '/api/books/loans', '/api/books/fixed-assets',
      '/api/books/payroll/runs', '/api/books/journal', '/api/books/transactions', '/api/books/transactions/summary',
      '/api/books/bills', '/api/books/tax/summary', '/api/books/reports/balance-sheet',
      `/api/books/reports/pl?${SEPT}`,
    ]) {
      const r = await booksGet(al.tok, url, w.canyon)
      expect(r.status, `${url} ${JSON.stringify(r.body)}`).toBe(200)
    }
    // Bank reconciliation is the ledger's: it asks for an account, it does not refuse.
    expect((await booksGet(al.tok, '/api/books/reconciliation', w.canyon)).status).toBe(400)
    for (const url of [`/api/books/reports/cash-flow?${SEPT}`, `/api/books/reports/owner-statements?${SEPT}`]) {
      const r = await booksGet(al.tok, url, w.canyon)
      expect(r.status, url).toBe(403)
      expect(r.body.error, url).toBe('This report is in the company-wide books (the bank account, payouts and payroll), which the owner has not given you. Ask the owner for it.')
    }
    expect((await get(al.tok, '/api/financials/bank-activity')).status).toBe(403)
    expect((await get(al.tok, '/api/financials/payouts')).status).toBe(403)
    const scope = await get(al.tok, '/api/financials/scope')
    expect(scope.body.data).toMatchObject({ companyWide: false, ledger: true, seesMonthlyReport: false })
    // The client list gives the payroll counts with the ledger.
    const clients = await get(al.tok, '/api/books/bookkeeper/clients')
    expect(clients.body.data[0]).toMatchObject({ company_wide: false, company_ledger: true })
    expect(Number(clients.body.data[0].employee_count)).toBe(0)
  })

  it('the P&L inside the ledger carries only their properties\' money (unless BK2)', async () => {
    const w = await world()
    await september(w)
    const al = await bookkeeper(w.canyon, [w.alder], { companyLedger: true })
    const pl = await booksGet(al.tok, `/api/books/reports/pl?${SEPT}`, w.canyon)
    expect(pl.body.data.gamRentIncome).toBe(500)
    const wide = await bookkeeper(w.canyon, [w.alder], { companyLedger: true, wholeCompanyReports: true })
    expect((await booksGet(wide.tok, `/api/books/reports/pl?${SEPT}`, w.canyon)).body.data.gamRentIncome).toBe(800)
  })

  // 10/12 (Nic, ledger decision 2): "Full bookkeeping … One level, no
  // per-bookkeeper switch" — a row that still says read_only writes too.
  it('writes are every ledger bookkeeper\'s, whatever their row\'s old access level says (one level)', async () => {
    const w = await world()
    const ro = await bookkeeper(w.canyon, [w.alder], { companyLedger: true })
    const rw = await bookkeeper(w.canyon, [w.alder], { companyLedger: true, accessLevel: 'read_write' })
    const account = (tok: string, code: string) => request(app()).post('/api/books/accounts').set('Authorization', `Bearer ${tok}`)
      .set('X-Client-Id', w.canyon).send({ code, name: 'Office supplies', type: 'expense' })
    const one = await account(ro.tok, '6901')
    expect(one.status, JSON.stringify(one.body)).toBeLessThan(300)
    const ok = await account(rw.tok, '6902')
    expect(ok.status, JSON.stringify(ok.body)).toBeLessThan(300)
    expect((await db.query(`SELECT code FROM books_accounts WHERE landlord_id = $1 AND code LIKE '690%' ORDER BY code`, [w.canyon])).rows)
      .toEqual([{ code: '6901' }, { code: '6902' }])
  })

  it('SECURITY: without either box the ledger is refused, in words; the rent roll stays theirs', async () => {
    const w = await world()
    const al = await bookkeeper(w.canyon, [w.alder])
    for (const url of ['/api/books/accounts', '/api/books/payroll/runs', `/api/books/reports/pl?${SEPT}`]) {
      const r = await booksGet(al.tok, url, w.canyon)
      expect(r.status, url).toBe(403)
      expect(r.body.error, url).toBe(LEDGER_NO)
    }
    expect((await booksGet(al.tok, '/api/books/rent-roll', w.canyon)).status).toBe(200)
    expect((await get(al.tok, '/api/financials/scope')).body.data.ledger).toBe(false)
  })

  it('SECURITY: a Books route nobody has called ledger stays the company-wide box\'s (deny by default)', async () => {
    const w = await world()
    const al = await bookkeeper(w.canyon, [w.alder], { companyLedger: true })
    const r = await booksGet(al.tok, '/api/books/some-new-thing', w.canyon)
    expect(r.status).toBe(403)
    expect(r.body.error).toMatch(/company-wide books/)
  })
})

describe('10/12 (Nic) review, SECURITY: the ledger box ends with the last property they kept', () => {
  it('Alder sold: the whole-company ledger, its payroll counts and the whole-company reports end; Alder\'s history up to the sale stays readable', async () => {
    const w = await world()
    await september(w)
    const al = await bookkeeper(w.canyon, [w.alder], { companyLedger: true, wholeCompanyReports: true })
    expect((await booksGet(al.tok, '/api/books/accounts', w.canyon)).status).toBe(200)
    await sell(w, w.alder)
    const s = await scopeOf(al.id, w.canyon)
    expect(s).toMatchObject({ ledger: false, keepsNothing: false, propertyIds: [w.alder] })
    expect(s.companyReports.propertyIds).toEqual([w.alder])
    for (const url of ['/api/books/accounts', '/api/books/payroll/runs', '/api/books/journal', `/api/books/reports/pl?${SEPT}`]) {
      const r = await booksGet(al.tok, url, w.canyon)
      expect(r.status, url).toBe(403)
      expect(r.body.error, url).toBe(LEDGER_NO)
    }
    expect((await get(al.tok, '/api/financials/scope')).body.data.ledger).toBe(false)
    const clients = await get(al.tok, '/api/books/bookkeeper/clients')
    expect(clients.body.data[0]).toMatchObject({ company_ledger: false, employee_count: null })
    // Alder's history up to the sale is still theirs.
    expect((await get(al.tok, '/api/financials/income?from=2026-09-01&to=2026-09-30')).body.data.total).toBe(500)
  })
})

describe('BK2: "Company reports show the whole company"', () => {
  it('company-wide + Alder: the Books P&L, cash flow and owner statements carry the whole company; the financial pages do not widen', async () => {
    const w = await world()
    await september(w)
    const bea = await bookkeeper(w.canyon, [w.alder], { companyWide: true, wholeCompanyReports: true })
    const pl = await booksGet(bea.tok, `/api/books/reports/pl?${SEPT}`, w.canyon)
    expect(pl.body.data.gamRentIncome).toBe(800)
    const cf = await booksGet(bea.tok, `/api/books/reports/cash-flow?${SEPT}`, w.canyon)
    expect(cf.body.data.operating.inflows.rentCollected).toBe(800)
    const os = await booksGet(bea.tok, `/api/books/reports/owner-statements?${SEPT}`, w.canyon)
    expect(os.body.data[0].properties.map((p: any) => p.name)).toEqual(['Alder', 'Birch', 'Cedar'])
    expect(os.body.data[0].totalCollected).toBe(800)
    // Their property money everywhere else stays Alder's.
    expect((await get(bea.tok, '/api/financials/income?from=2026-09-01&to=2026-09-30')).body.data.total).toBe(500)
    expect((await get(bea.tok, '/api/reports/monthly-pl?year=2026&month=9')).body.data.gross.total).toBe(500)
    expect((await booksGet(bea.tok, '/api/books/rent-roll', w.canyon)).body.data.units.map((u: any) => u.unit_id)).toEqual([w.alderUnit])
    // Unticked: Alder only (the 10/12 review rule).
    const al = await bookkeeper(w.canyon, [w.alder], { companyWide: true })
    expect((await booksGet(al.tok, `/api/books/reports/pl?${SEPT}`, w.canyon)).body.data.gamRentIncome).toBe(500)
  })

  it('SECURITY (BK3): a sold property they never kept stays hidden from the whole company\'s reports; one they kept counts up to its sale', async () => {
    const w = await world()
    await september(w)
    await paidOn(w.alderUnit, w.canyon, 700, '2026-09-25T18:00:00Z')   // after Alder's sale: never anyone's here
    await sell(w, w.birch)
    const bea = await bookkeeper(w.canyon, [w.alder], { companyWide: true, wholeCompanyReports: true })
    // Birch was never hers: hidden whole.
    expect((await scopeOf(bea.id, w.canyon)).companyReports.cutoffs).toEqual([{ propertyId: w.birch, lastDay: HIDDEN_HISTORY }])
    expect((await booksGet(bea.tok, `/api/books/reports/pl?${SEPT}`, w.canyon)).body.data.gamRentIncome).toBe(1200)
    const os = await booksGet(bea.tok, `/api/books/reports/owner-statements?${SEPT}`, w.canyon)
    expect(os.body.data[0].properties.map((p: any) => p.name)).toEqual(['Alder', 'Cedar'])
    // Dee kept Alder and Birch when Birch sold: Birch counts up to 9/20.
    const w2 = await world()
    await september(w2)
    const dee = await bookkeeper(w2.canyon, [w2.alder, w2.birch], { companyWide: true, wholeCompanyReports: true })
    await sell(w2, w2.birch)
    expect((await booksGet(dee.tok, `/api/books/reports/pl?${SEPT}`, w2.canyon)).body.data.gamRentIncome).toBe(800)
  })
})

describe('BK3: hired after a sale, every current box + company-wide = the whole company for what it still owns', () => {
  it('the scope: whole, the sold property hidden whole; a company that owns nothing is never "whole"', async () => {
    const w = await world()
    await sell(w, w.birch)
    const hired = await bookkeeper(w.canyon, [w.alder, w.cedar], { companyWide: true })
    const s = await scopeOf(hired.id, w.canyon)
    expect(s).toMatchObject({ propertyIds: null, currentIds: null, cutoffs: [{ propertyId: w.birch, lastDay: HIDDEN_HISTORY }] })
    // A company that sold everything: never the whole company, even with every (no) box.
    await sell(w, w.alder); await sell(w, w.cedar)
    const s2 = await scopeOf(hired.id, w.canyon)
    expect(s2.propertyIds).not.toBeNull()
  })
})

describe('10/12 (Nic) review, BK3: the Payouts page never names a sold property never theirs', () => {
  it('every GAM charge is listed and counted; one at the hidden property carries no property name', async () => {
    const w = await world()
    await db.query(
      `INSERT INTO landlord_gam_charges (landlord_id, property_id, kind, amount, source_type, created_at)
       VALUES ($1, $2, 'subscription', 24, 'platform_fee', '2026-09-02T18:00:00Z'),
              ($1, $3, 'subscription', 16, 'platform_fee', '2026-09-02T18:00:00Z')`, [w.canyon, w.alder, w.birch])
    await sell(w, w.birch)
    const hired = await bookkeeper(w.canyon, [w.alder, w.cedar], { companyWide: true })
    const kept = await bookkeeper(w.canyon, [w.alder], { companyWide: true })
    for (const tok of [hired.tok, kept.tok]) {
      const r = await get(tok, '/api/financials/payouts')
      expect(r.status, JSON.stringify(r.body)).toBe(200)
      expect(r.body.data.gamCharges.map((c: any) => [c.amount, c.propertyName]).sort()).toEqual([[16, null], [24, 'Alder']])
      expect(r.body.data.gamChargesOutstanding).toBe(40)
      expect(JSON.stringify(r.body)).not.toContain('Birch')
    }
    // The owner reads every name.
    const own = await get(w.owner, '/api/financials/payouts')
    expect(own.body.data.gamCharges.map((c: any) => c.propertyName).sort()).toEqual(['Alder', 'Birch'])
  })
})

describe('"Sees the monthly property report on screen"', () => {
  it('SECURITY: refused without the box; with it, their current properties only, scrubbed', async () => {
    const w = await world()
    await september(w)
    const al = await bookkeeper(w.canyon, [w.alder])
    expect((await get(al.tok, '/api/reports/monthly-report?month=2026-09')).status).toBe(403)
    expect((await get(al.tok, '/api/reports/monthly-report/pdf?month=2026-09')).status).toBe(403)
    expect((await get(al.tok, '/api/financials/scope')).body.data.seesMonthlyReport).toBe(false)

    const ann = await bookkeeper(w.canyon, [w.alder], { seesMonthlyReport: true })
    const r = await get(ann.tok, '/api/reports/monthly-report?month=2026-09')
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    expect(r.body.data.properties.map((p: any) => p.property.name)).toEqual(['Alder'])
    expect(r.body.data.notInTotals).toBeNull()
    expect(JSON.stringify(r.body)).not.toMatch(/@test\.dev|@t\.dev/)
    expect((await get(ann.tok, `/api/reports/monthly-report?month=2026-09&propertyId=${w.birch}`)).status).toBe(404)
    expect((await get(ann.tok, `/api/reports/monthly-report?month=2026-09&landlordId=${w.delta}`)).status).toBe(403)
    const pdf = await get(ann.tok, '/api/reports/monthly-report/pdf?month=2026-09').buffer(true)
      .parse((res, cb) => { const chunks: Buffer[] = []; res.on('data', (x: Buffer) => chunks.push(x)); res.on('end', () => cb(null, Buffer.concat(chunks))) })
    expect(pdf.status).toBe(200)
    expect(pdf.headers['content-type']).toMatch(/application\/pdf/)
    // Never the recipient list (the owner's alone).
    expect((await get(ann.tok, '/api/reports/monthly-report/recipients')).status).toBe(403)
    expect((await get(ann.tok, '/api/financials/scope')).body.data.seesMonthlyReport).toBe(true)
  })

  it('a whole-company bookkeeper gets every current property, never a sold one\'s money outside them', async () => {
    const w = await world()
    await september(w)
    await sell(w, w.birch)
    const bea = await bookkeeper(w.canyon, [w.alder, w.cedar], { companyWide: true, seesMonthlyReport: true })
    const r = await get(bea.tok, '/api/reports/monthly-report?month=2026-09')
    expect(r.status).toBe(200)
    expect(r.body.data.properties.map((p: any) => p.property.name)).toEqual(['Alder', 'Cedar'])
    expect(r.body.data.notInTotals).toBeNull()
    // The owner's own report still reads the whole company (Birch's money outside the listed properties).
    const owner = await get(w.owner, `/api/reports/monthly-report?month=2026-09&landlordId=${w.canyon}`)
    expect(owner.body.data.notInTotals?.received).toBe(300)
  })
})

describe('the Team page: the boxes ride the invitation, the edit and the accept', () => {
  it('the owner ticks them; the team list, invitation, accept page and accept carry every one', async () => {
    const w = await world()
    const r = await request(app()).post('/api/scopes/bookkeeper/invite').set('Authorization', `Bearer ${w.owner}`)
      .send({ landlordId: w.canyon, email: `a-${randomUUID()}@test.dev`,
              scope: { propertyIds: [w.alder], companyLedger: true, wholeCompanyReports: true, seesMonthlyReport: true } })
    expect(r.status, JSON.stringify(r.body)).toBe(201)
    const team = await request(app()).get('/api/scopes/team').set('Authorization', `Bearer ${w.owner}`)
    expect(team.body.data.bookkeeperMoreBoxes).toBe(true)
    expect(team.body.data.invitations[0]).toMatchObject({ company_ledger: true, whole_company_reports: true, sees_monthly_report: true })
    const tok = (await db.query<{ token: string }>(`SELECT token FROM invitations WHERE id = $1`, [r.body.data.id])).rows[0].token
    const page = await request(app()).get(`/api/invitations/${tok}`)
    expect(page.body.data.bookkeeperAccess).toEqual({
      companyWide: false, showLeaseDates: false, propertyCount: 1,
      companyLedger: true, wholeCompanyReports: true, seesMonthlyReport: true,
    })
    const acc = await request(app()).post(`/api/invitations/${tok}/accept`).send({ password: 'a-long-password-1', firstName: 'A', lastName: 'K' })
    expect(acc.status, JSON.stringify(acc.body)).toBe(200)
    const row = (await db.query(
      `SELECT company_wide, company_ledger, whole_company_reports, sees_monthly_report FROM bookkeeper_scopes WHERE user_id = $1`,
      [acc.body.data.userId])).rows[0]
    expect(row).toEqual({ company_wide: false, company_ledger: true, whole_company_reports: true, sees_monthly_report: true })
    const listed = (await request(app()).get('/api/scopes/team').set('Authorization', `Bearer ${w.owner}`)).body.data.members
      .find((m: any) => m.user_id === acc.body.data.userId)
    expect(listed.scope).toMatchObject({ companyLedger: true, wholeCompanyReports: true, seesMonthlyReport: true })
  })

  it('the owner turns them on and off on the edit; a field left out stays; nothing alone is not enough', async () => {
    const w = await world()
    const al = await bookkeeper(w.canyon, [w.alder])
    const patch = (body: object) => request(app()).patch(`/api/scopes/bookkeeper/${al.id}`).set('Authorization', `Bearer ${w.owner}`)
      .send({ landlordId: w.canyon, ...body })
    expect((await patch({ companyLedger: true, seesMonthlyReport: true })).status).toBe(200)
    expect((await patch({ showLeaseDates: true })).status).toBe(200)
    const read = async () => (await db.query(
      `SELECT company_ledger, whole_company_reports, sees_monthly_report, show_lease_dates FROM bookkeeper_scopes WHERE user_id = $1`, [al.id])).rows[0]
    expect(await read()).toEqual({ company_ledger: true, whole_company_reports: false, sees_monthly_report: true, show_lease_dates: true })
    expect((await patch({ companyLedger: false, wholeCompanyReports: true })).status).toBe(200)
    expect(await read()).toEqual({ company_ledger: false, whole_company_reports: true, sees_monthly_report: true, show_lease_dates: true })
    // The ledger box alone is not something to keep.
    const none = await patch({ propertyIds: [], companyLedger: true })
    expect(none.status).toBe(400)
    expect(none.body.error).toBe('Tick at least one property or Company-wide.')
    // Journaled with the rest of the row.
    expect((await db.query(`SELECT 1 FROM audit_row_changes WHERE table_name = 'bookkeeper_scopes' AND op = 'UPDATE'`)).rowCount).toBeGreaterThan(0)
  })
})

describe('SECURITY: staff may only give a bookkeeper what they hold themselves', () => {
  async function manager(w: World, scope: { propertyIds: string[]; all?: boolean; perms?: string[] }) {
    const id = (await db.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
       VALUES ($1, 'x', 'property_manager', 'Pat', 'Manager', TRUE) RETURNING id`, [`pm-${randomUUID()}@test.dev`])).rows[0].id
    const perms: Record<string, boolean> = { 'team.invite': true, 'team.manage_permissions': true }
    for (const p of scope.perms ?? []) perms[p] = true
    await db.query(
      `INSERT INTO property_manager_scopes (user_id, landlord_id, property_ids, unit_ids, all_properties, permissions)
       VALUES ($1, $2, $3, '{}', $4, $5)`, [id, w.canyon, scope.propertyIds, !!scope.all, JSON.stringify(perms)])
    return sign({ userId: id, role: 'property_manager', email: 'pm@t.dev', profileId: null, landlordId: w.canyon, permissions: perms })
  }
  const invite = (tok: string, scope: object) => request(app()).post('/api/scopes/bookkeeper/invite')
    .set('Authorization', `Bearer ${tok}`).send({ email: `i-${randomUUID()}@test.dev`, scope })

  it('a manager kept to Alder cannot give the ledger, the whole company\'s reports, or a report they do not see', async () => {
    const w = await world()
    const pm = await manager(w, { propertyIds: [w.alder], perms: ['books.view'] })
    const l = await invite(pm, { propertyIds: [w.alder], companyLedger: true })
    expect(l.status).toBe(403)
    expect(l.body.error).toBe('You can give a bookkeeper the whole-company ledger only if you have company-wide access yourself: every property, with "View books" on.')
    const r = await invite(pm, { propertyIds: [w.alder], wholeCompanyReports: true })
    expect(r.status).toBe(403)
    expect(r.body.error).toBe('You can give a bookkeeper the whole company\'s reports only if you have company-wide access yourself: every property, with "View books" on.')
    const m = await invite(pm, { propertyIds: [w.alder], seesMonthlyReport: true })
    expect(m.status).toBe(403)
    expect(m.body.error).toBe('You can give a bookkeeper the monthly property report only if you see it yourself.')
    expect((await db.query(`SELECT 1 FROM invitations`)).rowCount).toBe(0)
    // Nor by an edit.
    const al = await bookkeeper(w.canyon, [w.alder])
    for (const body of [{ companyLedger: true }, { wholeCompanyReports: true }, { seesMonthlyReport: true }]) {
      const p = await request(app()).patch(`/api/scopes/bookkeeper/${al.id}`).set('Authorization', `Bearer ${pm}`).send(body)
      expect(p.status, JSON.stringify(body)).toBe(403)
    }
    expect((await db.query(`SELECT company_ledger, whole_company_reports, sees_monthly_report FROM bookkeeper_scopes WHERE user_id = $1`, [al.id])).rows[0])
      .toEqual({ company_ledger: false, whole_company_reports: false, sees_monthly_report: false })
  })

  it('a manager who sees the monthly report gives it for their own properties; company-wide staff give the ledger and reports', async () => {
    const w = await world()
    const seer = await manager(w, { propertyIds: [w.alder], perms: ['reports.tab.monthly'] })
    expect((await invite(seer, { propertyIds: [w.alder], seesMonthlyReport: true })).status).toBe(201)
    expect((await invite(seer, { propertyIds: [w.birch], seesMonthlyReport: true })).status).toBe(403)
    const wide = await manager(w, { propertyIds: [], all: true, perms: ['books.view'] })
    expect((await invite(wide, { propertyIds: [w.alder], companyLedger: true, wholeCompanyReports: true })).status).toBe(201)
  })

  it('a manager who could not give a box cannot change or remove a bookkeeper who holds it', async () => {
    const w = await world()
    const pm = await manager(w, { propertyIds: [w.alder] })
    for (const boxes of [{ companyLedger: true }, { wholeCompanyReports: true }, { seesMonthlyReport: true }]) {
      const bk = await bookkeeper(w.canyon, [w.alder], boxes)
      const ch = await request(app()).patch(`/api/scopes/bookkeeper/${bk.id}`).set('Authorization', `Bearer ${pm}`).send({ showLeaseDates: true })
      expect(ch.status, JSON.stringify(boxes)).toBe(403)
      // 10/12: refused for the box, not for properties (Alder is the manager's).
      expect(ch.body.error).toBe('This bookkeeper has access you cannot give yourself. Ask the owner, or someone who has that access, to change or remove them.')
      expect((await request(app()).delete(`/api/scopes/bookkeeper/${bk.id}`).set('Authorization', `Bearer ${pm}`)).status).toBe(403)
    }
  })
})

describe('what the owner and the invitee are told (packages/shared bookkeeperAccessSummary)', () => {
  it('names the ledger without the bank or payouts, whose money the reports carry, and the monthly report', () => {
    const ledger = bookkeeperAccessSummary({ propertyCount: 1, companyWide: false, companyLedger: true })
    expect(ledger).toMatch(/Also uses the company's Books ledger: chart of accounts, journal, bills, vendors, payroll, tax, P&L and balance sheet, with only the ticked properties' money in the P&L\. Never the bank account or payouts\./)
    expect(bookkeeperAccessSummary({ propertyCount: 1, companyWide: false, companyLedger: true, wholeCompanyReports: true }))
      .toMatch(/with the whole company's money in the P&L/)
    expect(bookkeeperAccessSummary({ propertyCount: 2, companyWide: true, wholeCompanyReports: true }))
      .toMatch(/Company-wide: also .*, with the whole company's money in them\./)
    expect(bookkeeperAccessSummary({ propertyCount: 2, companyWide: true }))
      .toMatch(/with only the ticked properties' money in them\./)
    expect(bookkeeperAccessSummary({ propertyCount: 1, companyWide: false, seesMonthlyReport: true }, 'invitee'))
      .toMatch(/You see the monthly property report on screen for your properties\./)
    // Nothing about the ledger, payroll or the bank when no box gives them.
    const plain = bookkeeperAccessSummary({ propertyCount: 1, companyWide: false })
    expect(plain).not.toMatch(/ledger|payroll|bank|monthly/)
  })
})

describe('migration 20261013230500 (expand only)', () => {
  const SQL = fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', '20261013230500_bookkeeper_ledger_reports_monthly_boxes.sql'), 'utf8')
  it('adds three boxes, off for every existing bookkeeper; re-running is a no-op; nothing else changes', async () => {
    const w = await world()
    const al = await bookkeeper(w.canyon, [w.alder], { companyWide: true })
    await withRollback(async c => {
      await c.query(SQL)
      await c.query(SQL)
      const row = (await c.query(
        `SELECT company_wide, company_ledger, whole_company_reports, sees_monthly_report, property_ids
           FROM bookkeeper_scopes WHERE user_id = $1`, [al.id])).rows[0]
      expect(row).toEqual({ company_wide: true, company_ledger: false, whole_company_reports: false, sees_monthly_report: false, property_ids: [w.alder] })
    })
    const statements = SQL.split('\n').filter(l => !l.trim().startsWith('--')).join('\n')
    expect(statements).not.toMatch(/\b(DROP|UPDATE|DELETE)\b/i)
  })
})
