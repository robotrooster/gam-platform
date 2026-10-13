/**
 * 10/12 (Nic) — THE BOOKKEEPER'S COMPANY-WIDE BOX, THE CLEAN CUT AT A SALE,
 * AND THE LEASE-DATES BOX.
 *
 *   1. "Company-wide: bank account, payouts and payroll" is its own box, the
 *      owner's choice. It alone opens the bank account, payouts, payroll and
 *      the company's Books ledger and reports. The property boxes keep
 *      deciding property money.
 *   2. A company-wide-only bookkeeper (no property ticked) is allowed.
 *   3. A sold or transferred property is a CLEAN CUT: the bookkeeper keeps
 *      read access to its history for the days it was the company's, forever,
 *      and sees nothing after the transfer.
 *   4. Lease start and end dates on the rent roll: the owner's box per
 *      bookkeeper, off unless ticked.
 *
 * The world: Canyon LLC owns Alder and Birch; Delta LLC (the same owner)
 * owns Elm. Al ticked Alder only; Bea ticked both and the company-wide box.
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
import { pastCutoff } from '../lib/bookkeeperScope'

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
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_bookkeeper_company_wide'
})

interface World {
  ownerUserId: string
  canyon: string; delta: string
  alder: string; birch: string; elm: string
  alderUnit: string; birchUnit: string
  al: string; bea: string
  owner: string; tokAl: string; tokBea: string
}

async function bookkeeperUser(first: string): Promise<string> {
  return (await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
     VALUES ($1, 'x', 'bookkeeper', $2, 'Keeper', TRUE) RETURNING id`, [`${first.toLowerCase()}-${randomUUID()}@test.dev`, first])).rows[0].id
}
const bkPass = (userId: string, landlordId: string) =>
  sign({ userId, role: 'bookkeeper', email: 'bk@t.dev', profileId: null, landlordId, permissions: { access_level: 'read_only' } })

async function world(): Promise<World> {
  const c = await db.connect()
  let w: Omit<World, 'al' | 'bea' | 'tokAl' | 'tokBea'>
  try {
    const { userId: ownerUserId, landlordId: canyon } = await seedLandlord(c)
    await c.query(`UPDATE landlords SET business_name = 'Canyon LLC' WHERE id = $1`, [canyon])
    const delta = (await c.query<{ id: string }>(
      `INSERT INTO landlords (user_id, billing_starts_at, business_name) VALUES ($1, DATE '2000-01-01', 'Delta LLC') RETURNING id`,
      [ownerUserId])).rows[0].id
    const alder = await seedProperty(c, { landlordId: canyon, ownerUserId, managedByUserId: ownerUserId })
    const birch = await seedProperty(c, { landlordId: canyon, ownerUserId, managedByUserId: ownerUserId })
    const elm = await seedProperty(c, { landlordId: delta, ownerUserId, managedByUserId: ownerUserId })
    await c.query(`UPDATE properties SET name = 'Alder', timezone = 'America/Phoenix' WHERE id = $1`, [alder])
    await c.query(`UPDATE properties SET name = 'Birch' WHERE id = $1`, [birch])
    await c.query(`UPDATE properties SET name = 'Elm' WHERE id = $1`, [elm])
    const alderUnit = await seedUnit(c, { propertyId: alder, landlordId: canyon })
    const birchUnit = await seedUnit(c, { propertyId: birch, landlordId: canyon })
    w = {
      ownerUserId, canyon, delta, alder, birch, elm, alderUnit, birchUnit,
      owner: sign({ userId: ownerUserId, role: 'landlord', email: 'o@t.dev', profileId: null, landlordIds: [canyon, delta], permissions: {} }),
    }
  } finally { c.release() }
  const al = await bookkeeperUser('Al')
  const bea = await bookkeeperUser('Bea')
  await db.query(`INSERT INTO bookkeeper_scopes (user_id, landlord_id, property_ids) VALUES ($1, $2, $3)`, [al, w.canyon, [w.alder]])
  await db.query(`INSERT INTO bookkeeper_scopes (user_id, landlord_id, property_ids, company_wide) VALUES ($1, $2, $3, TRUE)`,
    [bea, w.canyon, [w.alder, w.birch]])
  return { ...w, al, bea, tokAl: bkPass(al, w.canyon), tokBea: bkPass(bea, w.canyon) }
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

const get = (tok: string, url: string) => request(app()).get(url).set('Authorization', `Bearer ${tok}`)
const booksGet = (tok: string, url: string, clientId: string) => get(tok, url).set('X-Client-Id', clientId)

describe('1. the company-wide box is its own — never inferred from the property boxes', () => {
  it('SECURITY: a property-only bookkeeper is refused the bank, payouts, payroll and the company books, in words', async () => {
    const w = await world()
    // Al keeps Alder; make him keep every property — still no company-wide box.
    await db.query(`UPDATE bookkeeper_scopes SET property_ids = $2 WHERE user_id = $1`, [w.al, [w.alder, w.birch]])
    const bank = await get(w.tokAl, '/api/financials/bank-activity')
    expect(bank.status).toBe(403)
    expect(bank.body.error).toBe('The bank account is in the company-wide books (the bank account, payouts and payroll), which the owner has not given you. Ask the owner for it.')
    expect((await get(w.tokAl, '/api/financials/payouts')).status).toBe(403)
    // 10/12 (Nic, BK1): the ledger is refused as the ledger (its own box, or
    // Company-wide), the reports that carry the payouts as company-wide books.
    for (const url of [
      '/api/books/employees', '/api/books/vendors', '/api/books/loans', '/api/books/fixed-assets', '/api/books/payroll/runs', '/api/books/tax/summary',
      '/api/books/accounts', '/api/books/journal', '/api/books/transactions', '/api/books/bills',
      '/api/books/reports/pl', '/api/books/reports/balance-sheet',
    ]) {
      const r = await booksGet(w.tokAl, url, w.canyon)
      expect(r.status, url).toBe(403)
      expect(r.body.error, url).toBe("The company's ledger (its accounts, journal, bills, payroll and tax) is not among what the owner has given you. Ask the owner for it.")
    }
    for (const url of ['/api/books/reports/cash-flow', '/api/books/reports/owner-statements']) {
      const r = await booksGet(w.tokAl, url, w.canyon)
      expect(r.status, url).toBe(403)
      expect(r.body.error, url).toMatch(/company-wide books/)
    }
    // A write is refused the same way (a payroll run), and nothing is written.
    const run = await request(app()).post('/api/books/payroll/runs').set('Authorization', `Bearer ${w.tokAl}`).set('X-Client-Id', w.canyon)
      .send({ payPeriodStart: '2026-09-01', payPeriodEnd: '2026-09-15', payDate: '2026-09-16', frequency: 'biweekly' })
    expect(run.status).toBe(403)
    expect((await db.query(`SELECT 1 FROM payroll_runs`)).rowCount).toBe(0)
    // The client list does not count their payroll either.
    const clients = await get(w.tokAl, '/api/books/bookkeeper/clients')
    expect(clients.status).toBe(200)
    expect(clients.body.data[0]).toMatchObject({ company_wide: false, employee_count: null, contractor_count: null, payroll_run_count: null })
    // Their properties' money is theirs, and their rent roll.
    expect((await get(w.tokAl, '/api/financials/scope')).body.data.companyWide).toBe(false)
    expect((await booksGet(w.tokAl, '/api/books/rent-roll', w.canyon)).status).toBe(200)
  })

  it('a company-wide bookkeeper reaches the bank, payouts, payroll and the company books', async () => {
    const w = await world()
    expect((await get(w.tokBea, '/api/financials/bank-activity')).status).toBe(200)
    expect((await get(w.tokBea, '/api/financials/payouts')).status).toBe(200)
    expect((await booksGet(w.tokBea, '/api/books/employees', w.canyon)).status).toBe(200)
    expect((await booksGet(w.tokBea, '/api/books/payroll/runs', w.canyon)).status).toBe(200)
    expect((await booksGet(w.tokBea, '/api/books/reports/pl', w.canyon)).status).not.toBe(403)
    expect((await booksGet(w.tokBea, '/api/books/reports/owner-statements', w.canyon)).status).not.toBe(403)
    const clients = await get(w.tokBea, '/api/books/bookkeeper/clients')
    expect(clients.body.data[0].company_wide).toBe(true)
    expect(Number(clients.body.data[0].employee_count)).toBe(0)
  })

  it('SECURITY: a company-wide-only bookkeeper sees no property money', async () => {
    const w = await world()
    await paidOn(w.alderUnit, w.canyon, 500, '2026-09-03T18:00:00Z')
    const expense = (await db.query<{ id: string }>(
      `INSERT INTO landlord_expenses (landlord_id, created_by, property_id, category, amount, expense_date)
       VALUES ($1, $2, $3, 'repairs', 40, '2026-09-05') RETURNING id`, [w.canyon, w.ownerUserId, w.alder])).rows[0].id
    await db.query(
      `INSERT INTO maintenance_requests (unit_id, landlord_id, title, description, category, status, actual_cost, completed_at)
       VALUES ($1, $2, 'Pump', 'pump', 'plumbing', 'completed', 60, '2026-09-06T18:00:00Z')`, [w.alderUnit, w.canyon])
    const cy = await bookkeeperUser('Cy')
    await db.query(`INSERT INTO bookkeeper_scopes (user_id, landlord_id, property_ids, company_wide) VALUES ($1, $2, '{}', TRUE)`, [cy, w.canyon])
    const tok = bkPass(cy, w.canyon)

    const scope = await get(tok, '/api/financials/scope')
    expect(scope.status).toBe(200)
    expect(scope.body.data).toMatchObject({ companyWide: true, properties: [] })
    expect((await get(tok, '/api/financials/bank-activity')).status).toBe(200)
    expect((await get(tok, '/api/financials/income?from=2026-09-01&to=2026-09-30')).body.data.total).toBe(0)
    expect((await get(tok, '/api/financials/maintenance-costs?from=2026-09-01&to=2026-09-30')).body.data.total).toBe(0)
    expect((await get(tok, '/api/expenses')).body.data.map((e: any) => e.id)).not.toContain(expense)
    expect((await get(tok, `/api/financials/income?propertyId=${w.alder}`)).status).toBe(403)
    const pl = await get(tok, '/api/reports/monthly-pl?year=2026&month=9')
    expect(pl.body.data.gross.total).toBe(0)
    expect(pl.body.data.expenses.maintenance).toBe(0)
    expect(pl.body.data.expenses.enteredExpenses).toBe(0)
    const roll = await booksGet(tok, '/api/books/rent-roll', w.canyon)
    expect(roll.status).toBe(200)
    expect(roll.body.data.units).toEqual([])
    // Filing an expense on a property is not theirs either.
    const file = await request(app()).post('/api/expenses').set('Authorization', `Bearer ${tok}`)
      .send({ propertyId: w.alder, category: 'repairs', amount: 5, expenseDate: '2026-09-07' })
    expect(file.status).toBe(403)
  })
})

describe('1. SECURITY: who may give the company-wide box', () => {
  async function manager(w: World, scope: { propertyIds: string[]; all?: boolean; booksView?: boolean }) {
    const id = (await db.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
       VALUES ($1, 'x', 'property_manager', 'Pat', 'Manager', TRUE) RETURNING id`, [`pm-${randomUUID()}@test.dev`])).rows[0].id
    const perms: Record<string, boolean> = { 'team.invite': true, 'team.manage_permissions': true }
    if (scope.booksView) perms['books.view'] = true
    await db.query(
      `INSERT INTO property_manager_scopes (user_id, landlord_id, property_ids, unit_ids, all_properties, permissions)
       VALUES ($1, $2, $3, '{}', $4, $5)`, [id, w.canyon, scope.propertyIds, !!scope.all, JSON.stringify(perms)])
    return sign({ userId: id, role: 'property_manager', email: 'pm@t.dev', profileId: null, landlordId: w.canyon, permissions: perms })
  }
  const invite = (tok: string, scope: object) => request(app()).post('/api/scopes/bookkeeper/invite')
    .set('Authorization', `Bearer ${tok}`).send({ email: `i-${randomUUID()}@test.dev`, scope })
  // 10/12: a team member with company-wide access gives it too, so the refusal says so (not "Only the owner").
  const NOT_OWNER = 'You can give a bookkeeper the company-wide books (the bank account, payouts and payroll) only if you have company-wide access yourself: every property, with "View books" on.'

  it('staff kept to some properties, or over every property without "View books", cannot give it', async () => {
    const w = await world()
    const kept = await manager(w, { propertyIds: [w.alder], booksView: true })
    const r1 = await invite(kept, { propertyIds: [w.alder], companyWide: true })
    expect(r1.status).toBe(403)
    expect(r1.body.error).toBe(NOT_OWNER)
    const every = await manager(w, { propertyIds: [], all: true })
    const r2 = await invite(every, { propertyIds: [], companyWide: true })
    expect(r2.status).toBe(403)
    const p = await request(app()).patch(`/api/scopes/bookkeeper/${w.al}`).set('Authorization', `Bearer ${every}`).send({ companyWide: true })
    expect(p.status).toBe(403)
    expect((await db.query(`SELECT 1 FROM invitations`)).rowCount).toBe(0)
    expect((await db.query(`SELECT company_wide FROM bookkeeper_scopes WHERE user_id = $1`, [w.al])).rows[0].company_wide).toBe(false)
  })

  it('staff with the team permission AND company-wide access of their own (every property, "View books") can', async () => {
    const w = await world()
    const pm = await manager(w, { propertyIds: [], all: true, booksView: true })
    expect((await invite(pm, { propertyIds: [], companyWide: true })).status).toBe(201)
    expect((await request(app()).patch(`/api/scopes/bookkeeper/${w.al}`).set('Authorization', `Bearer ${pm}`).send({ companyWide: true })).status).toBe(200)
  })

  it('staff without it cannot change or remove a company-wide bookkeeper, even inside their own properties', async () => {
    const w = await world()
    await db.query(`UPDATE bookkeeper_scopes SET company_wide = TRUE WHERE user_id = $1`, [w.al])
    const pm = await manager(w, { propertyIds: [w.alder] })
    const ch = await request(app()).patch(`/api/scopes/bookkeeper/${w.al}`).set('Authorization', `Bearer ${pm}`)
      .send({ propertyIds: [w.alder], companyWide: false })
    expect(ch.status).toBe(403)
    expect((await request(app()).delete(`/api/scopes/bookkeeper/${w.al}`).set('Authorization', `Bearer ${pm}`)).status).toBe(403)
    expect((await db.query(`SELECT company_wide FROM bookkeeper_scopes WHERE user_id = $1`, [w.al])).rows[0].company_wide).toBe(true)
  })

  it('the owner gives and takes it back; a change that leaves nothing ticked is refused, the lease-dates box alone is not', async () => {
    const w = await world()
    const on = await request(app()).patch(`/api/scopes/bookkeeper/${w.al}`).set('Authorization', `Bearer ${w.owner}`)
      .send({ landlordId: w.canyon, companyWide: true, propertyIds: [] })
    expect(on.status, JSON.stringify(on.body)).toBe(200)
    expect((await db.query(`SELECT property_ids, company_wide FROM bookkeeper_scopes WHERE user_id = $1`, [w.al])).rows[0])
      .toEqual({ property_ids: [], company_wide: true })
    const off = await request(app()).patch(`/api/scopes/bookkeeper/${w.al}`).set('Authorization', `Bearer ${w.owner}`)
      .send({ landlordId: w.canyon, companyWide: false })
    expect(off.status).toBe(400)
    expect(off.body.error).toBe('Tick at least one property or Company-wide.')
    const dates = await request(app()).patch(`/api/scopes/bookkeeper/${w.al}`).set('Authorization', `Bearer ${w.owner}`)
      .send({ landlordId: w.canyon, showLeaseDates: true })
    expect(dates.status).toBe(200)
    expect((await db.query(`SELECT company_wide, show_lease_dates FROM bookkeeper_scopes WHERE user_id = $1`, [w.al])).rows[0])
      .toEqual({ company_wide: true, show_lease_dates: true })
  })

  it('the accept page is told what the invitation gives; accepting writes every box', async () => {
    const w = await world()
    const r = await request(app()).post('/api/scopes/bookkeeper/invite').set('Authorization', `Bearer ${w.owner}`)
      .send({ landlordId: w.canyon, email: `a-${randomUUID()}@test.dev`, scope: { propertyIds: [w.birch], companyWide: false, showLeaseDates: true } })
    expect(r.status).toBe(201)
    const tok = (await db.query<{ token: string }>(`SELECT token FROM invitations WHERE id = $1`, [r.body.data.id])).rows[0].token
    expect((await request(app()).get(`/api/invitations/${tok}`)).body.data.bookkeeperAccess)
      .toEqual({ companyWide: false, showLeaseDates: true, propertyCount: 1,
                 companyLedger: false, wholeCompanyReports: false, seesMonthlyReport: false })
    const team = await request(app()).get('/api/scopes/team').set('Authorization', `Bearer ${w.owner}`)
    expect(team.body.data.invitations[0]).toMatchObject({ property_ids: [w.birch], company_wide: false, show_lease_dates: true })
    const acc = await request(app()).post(`/api/invitations/${tok}/accept`).send({ password: 'a-long-password-1', firstName: 'A', lastName: 'K' })
    expect(acc.status).toBe(200)
    expect((await db.query(`SELECT property_ids, company_wide, show_lease_dates FROM bookkeeper_scopes WHERE user_id = $1`, [acc.body.data.userId])).rows[0])
      .toEqual({ property_ids: [w.birch], company_wide: false, show_lease_dates: true })
  })
})

describe('3. a sold property is a clean cut: its history up to the transfer, forever, and nothing after', () => {
  /**
   * Alder earns 500 on 9/3 and 700 on 9/25 (late rent still the seller's),
   * costs 40 (9/5) and 90 (9/26) in expenses and 60 (9/6) and 80 (9/27) in
   * repairs. It is sold to Delta, the sale dated 9/20 noon Phoenix.
   */
  async function sold(w: World) {
    await paidOn(w.alderUnit, w.canyon, 500, '2026-09-03T18:00:00Z')
    await paidOn(w.alderUnit, w.canyon, 700, '2026-09-25T18:00:00Z')
    const ex = async (amount: number, day: string, by = w.ownerUserId) => (await db.query<{ id: string }>(
      `INSERT INTO landlord_expenses (landlord_id, created_by, property_id, category, amount, expense_date, receipt_url)
       VALUES ($1, $2, $3, 'repairs', $4, $5, $6) RETURNING id`,
      [w.canyon, by, w.alder, amount, day, `/api/expenses/receipt-files/r-${randomUUID()}.pdf`])).rows[0].id
    const before = await ex(40, '2026-09-05')
    const after = await ex(90, '2026-09-26')
    const alsOwn = await ex(15, '2026-09-10', w.al)
    for (const [cost, at] of [[60, '2026-09-06T18:00:00Z'], [80, '2026-09-27T18:00:00Z']] as const) {
      await db.query(
        `INSERT INTO maintenance_requests (unit_id, landlord_id, title, description, category, status, actual_cost, completed_at)
         VALUES ($1, $2, 'Fix', 'fix', 'plumbing', 'completed', $3, $4)`, [w.alderUnit, w.canyon, cost, at])
    }
    const t = await transferProperty({ propertyId: w.alder, fromLandlordId: w.canyon, toLandlordId: w.delta, byUserId: w.ownerUserId })
    // The sale's own date (transferProperty stamps now).
    await db.query(`UPDATE property_transfers SET transferred_at = '2026-09-20T19:00:00Z' WHERE id = $1`, [t.transferId])
    await db.query(`UPDATE bookkeeper_former_properties SET left_at = '2026-09-20T19:00:00Z' WHERE property_transfer_id = $1`, [t.transferId])
    return { transferId: t.transferId, before, after, alsOwn }
  }
  const receiptOf = async (id: string) =>
    (await db.query<{ receipt_url: string }>(`SELECT receipt_url FROM landlord_expenses WHERE id = $1`, [id])).rows[0].receipt_url

  it('a property-only bookkeeper reads the history before the transfer date on every page — and nothing after', async () => {
    const w = await world()
    const s = await sold(w)

    const scope = await get(w.tokAl, '/api/financials/scope')
    expect(scope.status).toBe(200)
    expect(scope.body.data.properties).toEqual([{ id: w.alder, name: 'Alder', landlordId: w.canyon, leftOn: '2026-09-20' }])

    const income = await get(w.tokAl, '/api/financials/income?from=2026-09-01&to=2026-09-30')
    expect(income.body.data.total).toBe(500)
    expect(income.body.data.days.map((d: any) => d.day)).toEqual(['2026-09-03'])
    const narrowed = await get(w.tokAl, `/api/financials/income?from=2026-09-01&to=2026-09-30&propertyId=${w.alder}`)
    expect(narrowed.status).toBe(200)
    expect(narrowed.body.data.total).toBe(500)
    const october = await get(w.tokAl, '/api/financials/income?from=2026-09-21&to=2026-10-31')
    expect(october.body.data.total).toBe(0)

    const maint = await get(w.tokAl, '/api/financials/maintenance-costs?from=2026-09-01&to=2026-09-30')
    expect(maint.body.data.total).toBe(60)

    const ids = (await get(w.tokAl, '/api/expenses')).body.data.map((e: any) => e.id)
    expect(ids).toContain(s.before)
    expect(ids).toContain(s.alsOwn)
    expect(ids).not.toContain(s.after)

    const pl = await get(w.tokAl, '/api/reports/monthly-pl?year=2026&month=9')
    expect(pl.status).toBe(200)
    expect(pl.body.data.gross.total).toBe(500)
    expect(pl.body.data.expenses.enteredExpenses).toBe(55)   // 40 + Al's own 15; never the 90 after
    expect(pl.body.data.expenses.maintenance).toBe(60)
    const summary = await get(w.tokAl, '/api/reports/summary')
    expect(summary.body.data.monthly.find((m: any) => m.month === '2026-09')?.collected).toBe(500)

    // A receipt dated after the sale is refused; one before it passes the gate (no file on disk: 404).
    expect((await get(w.tokAl, await receiptOf(s.after))).status).toBe(403)
    expect((await get(w.tokAl, await receiptOf(s.before))).status).toBe(404)
  })

  it('the former property is read only: nothing is filed on it or changed on it', async () => {
    const w = await world()
    const s = await sold(w)
    const file = await request(app()).post('/api/expenses').set('Authorization', `Bearer ${w.tokAl}`)
      .send({ propertyId: w.alder, category: 'repairs', amount: 5, expenseDate: '2026-09-07' })
    expect(file.status).toBe(403)
    const edit = await request(app()).patch(`/api/expenses/${s.alsOwn}`).set('Authorization', `Bearer ${w.tokAl}`).send({ amount: 16 })
    expect(edit.status).toBe(403)
    expect(edit.body.error).toBe('That property has left the company. Its books are read only.')
    expect((await get(w.tokAl, '/api/expenses')).body.data.find((e: any) => e.id === s.alsOwn).can_edit).toBe(false)
    // And he still never reaches the bank (no company-wide box).
    expect((await get(w.tokAl, '/api/financials/bank-activity')).status).toBe(403)
  })

  it('a whole-company bookkeeper is cut the same way; the owner is not (the cut is the bookkeeper\'s)', async () => {
    const w = await world()
    await sold(w)
    // Bea: company-wide, and Birch (all Canyon owns now) ticked — the whole company.
    const bea = await get(w.tokBea, '/api/financials/income?from=2026-09-01&to=2026-09-30')
    expect(bea.body.data.total).toBe(500)
    const pl = await get(w.tokBea, '/api/reports/monthly-pl?year=2026&month=9')
    expect(pl.body.data.gross.total).toBe(500)
    expect(pl.body.data.expenses.maintenance).toBe(60)
    expect(pl.body.data.expenses.enteredExpenses).toBe(55)
    const books = await booksGet(w.tokBea, '/api/books/reports/pl?startDate=2026-09-01&endDate=2026-09-30', w.canyon)
    if (books.status === 200) expect(books.body.data.gamRentIncome).toBe(500)
    else expect(books.status).not.toBe(403)
    // The owner's books keep what the rows say: both payments are Canyon's.
    const owner = await get(w.owner, '/api/financials/income?from=2026-09-01&to=2026-09-30')
    expect(owner.body.data.total).toBe(1200)
  })

  it('history stays after re-reads, and a bookkeeper removed loses it whole (journaled)', async () => {
    const w = await world()
    const s = await sold(w)
    expect((await db.query(`SELECT property_ids FROM bookkeeper_scopes WHERE user_id = $1`, [w.al])).rows[0].property_ids).toEqual([])
    const former = (await db.query(`SELECT property_id, property_transfer_id FROM bookkeeper_former_properties fp
        JOIN bookkeeper_scopes bs ON bs.id = fp.bookkeeper_scope_id WHERE bs.user_id = $1`, [w.al])).rows
    expect(former).toEqual([{ property_id: w.alder, property_transfer_id: s.transferId }])
    const alScope = (await db.query<{ id: string }>(`SELECT id FROM bookkeeper_scopes WHERE user_id = $1`, [w.al])).rows[0].id
    const del = await request(app()).delete(`/api/scopes/bookkeeper/${w.al}?landlordId=${w.canyon}`).set('Authorization', `Bearer ${w.owner}`)
    expect(del.status).toBe(200)
    expect((await get(w.tokAl, '/api/financials/income')).status).toBe(403)
    expect((await db.query(`SELECT 1 FROM bookkeeper_former_properties WHERE property_transfer_id = $1`, [s.transferId])).rowCount).toBe(1)  // Bea's
    expect((await db.query(
      `SELECT 1 FROM audit_row_changes WHERE table_name = 'bookkeeper_former_properties' AND op = 'DELETE'
          AND old_row->>'bookkeeper_scope_id' = $1`, [alScope])).rowCount).toBe(1)
  })

  it('pastCutoff: the last day is in, the day after is out, other properties are untouched', () => {
    const cut = [{ propertyId: 'p1', lastDay: '2026-09-20' }]
    expect(pastCutoff(cut, 'p1', '2026-09-20')).toBe(false)
    expect(pastCutoff(cut, 'p1', '2026-09-21')).toBe(true)
    expect(pastCutoff(cut, 'p1', '2026-09-21T03:00:00Z')).toBe(true)
    expect(pastCutoff(cut, 'p2', '2027-01-01')).toBe(false)
    expect(pastCutoff(cut, null, '2027-01-01')).toBe(false)
    expect(pastCutoff([], 'p1', '2027-01-01')).toBe(false)
  })
})

describe('4. lease start and end dates on the rent roll are the owner\'s box per bookkeeper', () => {
  async function leased(w: World) {
    const c = await db.connect()
    try {
      const tenantId = await seedTenant(c)
      const leaseId = await seedLease(c, { unitId: w.birchUnit, landlordId: w.canyon, rentAmount: 900, startDate: '2026-01-01' })
      await c.query(`UPDATE leases SET end_date = '2026-12-31' WHERE id = $1`, [leaseId])
      await seedLeaseTenant(c, { leaseId, tenantId })
    } finally { c.release() }
  }
  const birchRow = (r: any, w: World) => r.body.data.units.find((u: any) => u.unit_id === w.birchUnit)

  it('off by default: no dates; ticked: the dates and nothing more; the owner sees them', async () => {
    const w = await world()
    await leased(w)
    const off = await booksGet(w.tokBea, '/api/books/rent-roll', w.canyon)
    expect(off.status).toBe(200)
    expect(off.body.data.showLeaseDates).toBe(false)
    const row = birchRow(off, w)
    expect(row.tenant_first).toBeTruthy()
    expect(Object.keys(row).filter(k => /lease/i.test(k))).toEqual([])

    await db.query(`UPDATE bookkeeper_scopes SET show_lease_dates = TRUE WHERE user_id = $1`, [w.bea])
    const on = await booksGet(w.tokBea, '/api/books/rent-roll', w.canyon)
    expect(on.body.data.showLeaseDates).toBe(true)
    expect(birchRow(on, w)).toMatchObject({ lease_start_date: '2026-01-01', lease_end_date: '2026-12-31' })
    // Never the lease itself, its documents, or the tenant's contact details.
    expect(Object.keys(birchRow(on, w)).filter(k => /lease/i.test(k)).sort()).toEqual(['lease_end_date', 'lease_start_date'])
    expect(JSON.stringify(on.body)).not.toMatch(/tenant_email|@test\.dev/)

    const owner = await booksGet(w.owner, '/api/books/rent-roll', w.canyon)
    expect(birchRow(owner, w)).toMatchObject({ lease_start_date: '2026-01-01', lease_end_date: '2026-12-31' })
  })
})

describe('migrations', () => {
  const read = (f: string) => fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', f), 'utf8')
  const BOXES = read('20261012170000_bookkeeper_company_wide_and_lease_dates.sql')
  const FORMER = read('20261012170100_bookkeeper_former_properties.sql')

  it('the company-wide backfill: nobody loses access — a row covering every property keeps the company-wide pages', async () => {
    const w = await world()
    await withRollback(async c => {
      await c.query(`UPDATE bookkeeper_scopes SET company_wide = FALSE`)
      const old = await bookkeeperUser('Olga')
      await c.query(`INSERT INTO bookkeeper_scopes (user_id, landlord_id, property_ids) VALUES ($1, $2, NULL)`, [old, w.canyon])
      const inv = async (propertyIds: string[] | null) => (await c.query<{ id: string }>(
        `INSERT INTO invitations (email, landlord_id, role, scope_payload, invited_by_user_id, token, expires_at)
         VALUES ($1, $2, 'bookkeeper', $3::jsonb, $4, $5, NOW() + interval '1 day') RETURNING id`,
        [`${randomUUID()}@t.dev`, w.canyon, JSON.stringify({ accessLevel: 'read_only', propertyIds }), w.ownerUserId, randomUUID()])).rows[0].id
      const all = await inv([w.alder, w.birch])
      const some = await inv([w.alder])
      await c.query(BOXES)
      await c.query(BOXES)   // re-running is a no-op
      const cw = async (u: string) => (await c.query(`SELECT company_wide, show_lease_dates FROM bookkeeper_scopes WHERE user_id = $1`, [u])).rows[0]
      expect(await cw(w.bea)).toEqual({ company_wide: true, show_lease_dates: false })   // Alder + Birch = every property
      expect(await cw(w.al)).toEqual({ company_wide: false, show_lease_dates: false })   // Alder only
      expect((await cw(old)).company_wide).toBe(true)                                    // NULL = every property
      const payload = async (id: string) => (await c.query(`SELECT scope_payload FROM invitations WHERE id = $1`, [id])).rows[0].scope_payload
      expect((await payload(all)).companyWide).toBe(true)
      expect((await payload(some)).companyWide).toBe(false)
      // An empty property list is allowed now (company-wide only).
      await c.query(`UPDATE bookkeeper_scopes SET property_ids = '{}' WHERE user_id = $1`, [w.al])
    })
  })

  it('the former-property backfill moves a stranded sold box (the 10/11 pruning\'s leftover) into the dated history', async () => {
    const w = await world()
    await withRollback(async c => {
      const t = (await c.query<{ id: string }>(
        `INSERT INTO property_transfers (property_id, from_landlord_id, to_landlord_id, transferred_at)
         VALUES ($1, $2, $3, '2026-09-20T19:00:00Z') RETURNING id`, [w.alder, w.canyon, w.delta])).rows[0].id
      await c.query(`UPDATE properties SET landlord_id = $2 WHERE id = $1`, [w.alder, w.delta])
      await c.query(FORMER)
      await c.query(FORMER)   // re-running is a no-op
      const rows = (await c.query(
        `SELECT bs.user_id, bs.property_ids, fp.property_id, fp.property_transfer_id, fp.left_at
           FROM bookkeeper_scopes bs LEFT JOIN bookkeeper_former_properties fp ON fp.bookkeeper_scope_id = bs.id
          ORDER BY bs.created_at`)).rows
      const al = rows.find((r: any) => r.user_id === w.al)
      expect(al).toMatchObject({ property_ids: [], property_id: w.alder, property_transfer_id: t })
      expect(new Date(al.left_at).toISOString()).toBe('2026-09-20T19:00:00.000Z')
      const bea = rows.find((r: any) => r.user_id === w.bea)
      expect(bea).toMatchObject({ property_ids: [w.birch], property_id: w.alder })
    })
  })
})
