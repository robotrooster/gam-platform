/**
 * 10/11 (Nic) — EVERY PROPERTY IS ITS OWN BOX.
 *
 *   Bookkeeper access is per property. Nothing ticked is refused. A property
 *   added or transferred in later appears unticked. A stored NULL no longer
 *   means "all". "Whole company" = the ticked set holds every property the
 *   company owns right now, worked out per request.
 *
 * The world: one owner account with two companies. Canyon LLC owns Alder and
 * Birch; Delta LLC owns Elm. Bea ticked both of Canyon's parks; Al ticked
 * Alder only.
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
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_bookkeeper_boxes'
})

interface World {
  ownerUserId: string
  canyon: string; delta: string
  alder: string; birch: string; elm: string
  alderUnit: string; birchUnit: string
  bea: string; al: string
  owner: string; tokBea: string; tokAl: string
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
  let w: Omit<World, 'bea' | 'al' | 'tokBea' | 'tokAl'>
  try {
    const { userId: ownerUserId, landlordId: canyon } = await seedLandlord(c)
    await c.query(`UPDATE landlords SET business_name = 'Canyon LLC' WHERE id = $1`, [canyon])
    const delta = (await c.query<{ id: string }>(
      `INSERT INTO landlords (user_id, billing_starts_at, business_name) VALUES ($1, DATE '2000-01-01', 'Delta LLC') RETURNING id`,
      [ownerUserId])).rows[0].id
    const alder = await seedProperty(c, { landlordId: canyon, ownerUserId, managedByUserId: ownerUserId })
    const birch = await seedProperty(c, { landlordId: canyon, ownerUserId, managedByUserId: ownerUserId })
    const elm = await seedProperty(c, { landlordId: delta, ownerUserId, managedByUserId: ownerUserId })
    await c.query(`UPDATE properties SET name = 'Alder' WHERE id = $1`, [alder])
    await c.query(`UPDATE properties SET name = 'Birch' WHERE id = $1`, [birch])
    await c.query(`UPDATE properties SET name = 'Elm' WHERE id = $1`, [elm])
    const alderUnit = await seedUnit(c, { propertyId: alder, landlordId: canyon })
    const birchUnit = await seedUnit(c, { propertyId: birch, landlordId: canyon })
    w = {
      ownerUserId, canyon, delta, alder, birch, elm, alderUnit, birchUnit,
      owner: sign({ userId: ownerUserId, role: 'landlord', email: 'o@t.dev', profileId: null, landlordIds: [canyon, delta], permissions: {} }),
    }
  } finally { c.release() }
  const bea = await bookkeeperUser('Bea')
  const al = await bookkeeperUser('Al')
  await db.query(`INSERT INTO bookkeeper_scopes (user_id, landlord_id, property_ids) VALUES ($1, $2, $3)`, [bea, w.canyon, [w.alder, w.birch]])
  await db.query(`INSERT INTO bookkeeper_scopes (user_id, landlord_id, property_ids) VALUES ($1, $2, $3)`, [al, w.canyon, [w.alder]])
  return { ...w, bea, al, tokBea: bkPass(bea, w.canyon), tokAl: bkPass(al, w.canyon) }
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

async function addProperty(w: World, name: string): Promise<{ id: string; unit: string }> {
  const c = await db.connect()
  try {
    const id = await seedProperty(c, { landlordId: w.canyon, ownerUserId: w.ownerUserId, managedByUserId: w.ownerUserId })
    await c.query(`UPDATE properties SET name = $2 WHERE id = $1`, [id, name])
    const unit = await seedUnit(c, { propertyId: id, landlordId: w.canyon })
    return { id, unit }
  } finally { c.release() }
}

/** Move a property's rows to another company without the transfer service (no pruning). */
async function moveRaw(propertyId: string, toLandlordId: string) {
  await db.query(`UPDATE properties SET landlord_id = $2 WHERE id = $1`, [propertyId, toLandlordId])
  await db.query(`UPDATE units SET landlord_id = $2 WHERE property_id = $1`, [propertyId, toLandlordId])
}

const scopeOf = (tok: string) => request(app()).get('/api/financials/scope').set('Authorization', `Bearer ${tok}`)
const booksGet = (tok: string, url: string, clientId: string) =>
  request(app()).get(url).set('Authorization', `Bearer ${tok}`).set('X-Client-Id', clientId)

describe('every box ticked is every property — the company-wide pages follow their own box (10/12)', () => {
  it('ticking every property gives every property\'s money, never the bank, payouts, payroll or company reports', async () => {
    const w = await world()
    await paidOn(w.alderUnit, w.canyon, 500, '2026-09-03T18:00:00Z')
    const companyExpense = (await db.query<{ id: string }>(
      `INSERT INTO landlord_expenses (landlord_id, created_by, property_id, category, amount, expense_date, vendor)
       VALUES ($1, $2, NULL, 'insurance', 77, '2026-09-05', 'Umbrella Co') RETURNING id`, [w.canyon, w.ownerUserId])).rows[0].id
    await db.query(
      `INSERT INTO landlord_other_income (landlord_id, property_id, category, amount, income_date)
       VALUES ($1, NULL, 'laundry', 50, '2026-09-06')`, [w.canyon])

    // Bea ticked both of Canyon's parks, and not the company-wide box.
    const scope = await scopeOf(w.tokBea)
    expect(scope.status).toBe(200)
    expect(scope.body.data.companyWide).toBe(false)
    expect(scope.body.data.properties.map((p: any) => p.name)).toEqual(['Alder', 'Birch'])
    expect((await request(app()).get('/api/financials/bank-activity').set('Authorization', `Bearer ${w.tokBea}`)).status).toBe(403)
    expect((await request(app()).get('/api/financials/payouts').set('Authorization', `Bearer ${w.tokBea}`)).status).toBe(403)
    expect((await booksGet(w.tokBea, '/api/books/reports/pl', w.canyon)).status).toBe(403)
    expect((await booksGet(w.tokBea, '/api/books/employees', w.canyon)).status).toBe(403)
    // Every property's money is theirs; the company's money on no property is not.
    const income = await request(app()).get('/api/financials/income?from=2026-09-01&to=2026-09-30').set('Authorization', `Bearer ${w.tokBea}`)
    expect(income.body.data.total).toBe(500)
    const expenses = await request(app()).get('/api/expenses').set('Authorization', `Bearer ${w.tokBea}`)
    expect(expenses.body.data.map((e: any) => e.id)).not.toContain(companyExpense)

    // The owner ticks Company-wide for her: the same pass reads the whole company, no sign-in.
    const tick = await request(app()).patch(`/api/scopes/bookkeeper/${w.bea}`).set('Authorization', `Bearer ${w.owner}`)
      .send({ landlordId: w.canyon, companyWide: true })
    expect(tick.status, JSON.stringify(tick.body)).toBe(200)
    expect((await scopeOf(w.tokBea)).body.data.companyWide).toBe(true)
    expect((await request(app()).get('/api/financials/bank-activity').set('Authorization', `Bearer ${w.tokBea}`)).status).toBe(200)
    expect((await request(app()).get('/api/financials/payouts').set('Authorization', `Bearer ${w.tokBea}`)).status).toBe(200)
    // The Books P&L and cash flow are not refused (what the box decides). Not
    // pinned to 200: those reports read ledger columns other work is adding.
    expect((await booksGet(w.tokBea, '/api/books/reports/pl', w.canyon)).status).not.toBe(403)
    expect((await booksGet(w.tokBea, '/api/books/reports/cash-flow', w.canyon)).status).not.toBe(403)
    const all = await request(app()).get('/api/expenses').set('Authorization', `Bearer ${w.tokBea}`)
    expect(all.body.data.map((e: any) => e.id)).toContain(companyExpense)
    const pl = await request(app()).get('/api/reports/monthly-pl?year=2026&month=9').set('Authorization', `Bearer ${w.tokBea}`)
    expect(pl.status).toBe(200)
    expect(pl.body.data.expenses.enteredExpenses).toBe(77)
    const wide = await request(app()).get('/api/financials/income?from=2026-09-01&to=2026-09-30').set('Authorization', `Bearer ${w.tokBea}`)
    expect(wide.body.data.total).toBe(550)

    // Al keeps Alder only, no company-wide box: none of that is his.
    expect((await scopeOf(w.tokAl)).body.data.companyWide).toBe(false)
    expect((await booksGet(w.tokAl, '/api/books/reports/pl', w.canyon)).status).toBe(403)
    const alIncome = await request(app()).get('/api/financials/income?from=2026-09-01&to=2026-09-30').set('Authorization', `Bearer ${w.tokAl}`)
    expect(alIncome.body.data.total).toBe(500)
  })

  it('a property the company adds later arrives unticked — the company-wide box stays, the new park waits for its own box', async () => {
    const w = await world()
    await db.query(`UPDATE bookkeeper_scopes SET company_wide = TRUE WHERE user_id = $1`, [w.bea])
    const cedar = await addProperty(w, 'Cedar')
    await paidOn(cedar.unit, w.canyon, 333, '2026-09-04T18:00:00Z')
    await db.query(
      `INSERT INTO landlord_expenses (landlord_id, created_by, property_id, category, amount, expense_date)
       VALUES ($1, $2, NULL, 'insurance', 77, '2026-09-05')`, [w.canyon, w.ownerUserId])

    const scope = await scopeOf(w.tokBea)
    expect(scope.body.data.companyWide).toBe(true)
    expect(scope.body.data.properties.map((p: any) => p.name)).toEqual(['Alder', 'Birch'])
    // The bank account and the company reports are the company-wide box's — a new park does not take them away.
    expect((await request(app()).get('/api/financials/bank-activity').set('Authorization', `Bearer ${w.tokBea}`)).status).toBe(200)
    expect((await booksGet(w.tokBea, '/api/books/reports/pl', w.canyon)).status).not.toBe(403)
    // Cedar's money is not hers until it is ticked.
    const income = await request(app()).get('/api/financials/income?from=2026-09-01&to=2026-09-30').set('Authorization', `Bearer ${w.tokBea}`)
    expect(income.body.data.total).toBe(0)
    const cedarIncome = await request(app()).get(`/api/financials/income?propertyId=${cedar.id}`).set('Authorization', `Bearer ${w.tokBea}`)
    expect(cedarIncome.status).toBe(403)
    const pl = await request(app()).get('/api/reports/monthly-pl?year=2026&month=9').set('Authorization', `Bearer ${w.tokBea}`)
    expect(pl.status).toBe(200)
    expect(pl.body.data.expenses.enteredExpenses).toBe(0)   // a park unticked: no longer the whole company

    // The Team page shows the new park as not ticked, and the company-wide box.
    const team = await request(app()).get('/api/scopes/team').set('Authorization', `Bearer ${w.owner}`)
    const row = team.body.data.members.find((m: any) => m.user_id === w.bea)
    expect(row.scope).toMatchObject({ propertyIds: [w.alder, w.birch], coversCompany: false, companyWide: true })

    // The owner ticks it: the same pass reads the whole company again, no sign-in.
    const tick = await request(app()).patch(`/api/scopes/bookkeeper/${w.bea}`).set('Authorization', `Bearer ${w.owner}`)
      .send({ landlordId: w.canyon, propertyIds: [w.alder, w.birch, cedar.id] })
    expect(tick.status).toBe(200)
    const after = await request(app()).get('/api/financials/income?from=2026-09-01&to=2026-09-30').set('Authorization', `Bearer ${w.tokBea}`)
    expect(after.body.data.total).toBe(333)
    const whole = await request(app()).get('/api/reports/monthly-pl?year=2026&month=9').set('Authorization', `Bearer ${w.tokBea}`)
    expect(whole.body.data.expenses.enteredExpenses).toBe(77)
  })

  it('a ticked property moved out with no transfer on record drops out; when it was the only box, nothing is left', async () => {
    const w = await world()
    await moveRaw(w.alder, w.delta)
    // Al ticked only Alder, and no transfer names it: none of his properties is Canyon's now.
    const al = await scopeOf(w.tokAl)
    expect(al.status).toBe(403)
    expect(al.body.error).toBe('None of the properties you keep belong to this company now.')
    const alBooks = await booksGet(w.tokAl, '/api/books/rent-roll', w.canyon)
    expect(alBooks.status).toBe(403)
    expect(alBooks.body.error).toBe('None of the properties you keep belong to this company now.')
    // Bea ticked both; Canyon now owns only Birch, which she keeps.
    const bea = await scopeOf(w.tokBea)
    expect(bea.body.data.properties.map((p: any) => p.name)).toEqual(['Birch'])
    expect(bea.body.data.companyWide).toBe(false)
    // Alder does not tick itself for Delta's bookkeeper.
    const dee = await bookkeeperUser('Dee')
    await db.query(`INSERT INTO bookkeeper_scopes (user_id, landlord_id, property_ids) VALUES ($1, $2, $3)`, [dee, w.delta, [w.elm]])
    const d = await scopeOf(bkPass(dee, w.delta))
    expect(d.body.data.properties.map((p: any) => p.name)).toEqual(['Elm'])
  })
})

describe('a property transferred out becomes a former property for every bookkeeper of the old company (10/12)', () => {
  it('unticks it, keeps it dated by the transfer, keeps (and no longer refuses) a bookkeeper whose only box it was, and trims pending invitations', async () => {
    const w = await world()
    const inv = async (email: string, propertyIds: string[]) => {
      const r = await request(app()).post('/api/scopes/bookkeeper/invite').set('Authorization', `Bearer ${w.owner}`)
        .send({ landlordId: w.canyon, email, scope: { propertyIds } })
      expect(r.status, JSON.stringify(r.body)).toBe(201)
      return r.body.data.id as string
    }
    const both = await inv(`both-${randomUUID()}@test.dev`, [w.alder, w.birch])
    const onlyAlder = await inv(`alder-${randomUUID()}@test.dev`, [w.alder])
    const dee = await bookkeeperUser('Dee')
    await db.query(`INSERT INTO bookkeeper_scopes (user_id, landlord_id, property_ids) VALUES ($1, $2, $3)`, [dee, w.delta, [w.elm]])

    const t = await transferProperty({ propertyId: w.alder, fromLandlordId: w.canyon, toLandlordId: w.delta, byUserId: w.ownerUserId })

    const rows = (await db.query<{ id: string; user_id: string; landlord_id: string; property_ids: string[] }>(
      `SELECT id, user_id, landlord_id, property_ids FROM bookkeeper_scopes ORDER BY created_at`)).rows
    expect(rows.find(r => r.user_id === w.bea)!.property_ids).toEqual([w.birch])
    expect(rows.find(r => r.user_id === w.al)!.property_ids).toEqual([])
    expect(rows.find(r => r.user_id === dee)!.property_ids).toEqual([w.elm])  // arrives unticked at Delta
    const former = (await db.query<{ bookkeeper_scope_id: string; property_id: string; property_transfer_id: string }>(
      `SELECT bookkeeper_scope_id, property_id, property_transfer_id FROM bookkeeper_former_properties ORDER BY created_at`)).rows
    expect(former.map(f => f.bookkeeper_scope_id).sort())
      .toEqual([rows.find(r => r.user_id === w.bea)!.id, rows.find(r => r.user_id === w.al)!.id].sort())
    for (const f of former) expect(f).toMatchObject({ property_id: w.alder, property_transfer_id: t.transferId })
    // The grant of the history is journaled.
    expect((await db.query(
      `SELECT 1 FROM audit_row_changes WHERE table_name = 'bookkeeper_former_properties' AND op = 'INSERT'
          AND new_row->>'property_transfer_id' = $1`, [t.transferId])).rowCount).toBe(2)
    // Al keeps Canyon — Alder's history up to the transfer — and is no longer refused.
    const al = await scopeOf(w.tokAl)
    expect(al.status).toBe(200)
    expect(al.body.data.properties).toEqual([expect.objectContaining({ id: w.alder, name: 'Alder', leftOn: expect.any(String) })])
    const team = await request(app()).get('/api/scopes/team').set('Authorization', `Bearer ${w.owner}`)
    const alRow = team.body.data.members.find((m: any) => m.user_id === w.al && m.landlord_id === w.canyon)
    expect(alRow.scope).toMatchObject({ propertyIds: [], coversCompany: false, companyWide: false })
    expect(alRow.scope.formerProperties).toEqual([expect.objectContaining({ propertyId: w.alder, name: 'Alder' })])
    expect((await db.query(
      `SELECT 1 FROM audit_row_changes WHERE table_name = 'bookkeeper_scopes' AND op = 'DELETE' AND old_row->>'user_id' = $1`, [w.al])).rowCount).toBe(0)

    const payload = async (id: string) => (await db.query<{ scope_payload: any }>(
      `SELECT scope_payload FROM invitations WHERE id = $1`, [id])).rows[0].scope_payload.propertyIds
    expect(await payload(both)).toEqual([w.birch])
    expect(await payload(onlyAlder)).toEqual([])
    const tok = (await db.query<{ token: string }>(`SELECT token FROM invitations WHERE id = $1`, [onlyAlder])).rows[0].token
    const acc = await request(app()).post(`/api/invitations/${tok}/accept`).send({ password: 'a-long-password-1', firstName: 'N', lastName: 'K' })
    expect(acc.status).toBe(409)
    expect(acc.body.error).toBe('This invitation names no properties. Ask for a new one.')
  })
})

describe('the writers refuse an empty choice', () => {
  it('PATCH with propertyIds null is refused; leaving it out changes only what was sent', async () => {
    const w = await world()
    const nul = await request(app()).patch(`/api/scopes/bookkeeper/${w.bea}`).set('Authorization', `Bearer ${w.owner}`)
      .send({ landlordId: w.canyon, propertyIds: null })
    expect(nul.status).toBe(400)
    expect(nul.body.error).toBe('Tick at least one property or Company-wide.')
    const level = await request(app()).patch(`/api/scopes/bookkeeper/${w.bea}`).set('Authorization', `Bearer ${w.owner}`)
      .send({ landlordId: w.canyon, accessLevel: 'read_write' })
    expect(level.status).toBe(200)
    const row = (await db.query(`SELECT property_ids, access_level FROM bookkeeper_scopes WHERE user_id = $1`, [w.bea])).rows[0]
    expect(row).toEqual({ property_ids: [w.alder, w.birch], access_level: 'read_write' })
  })

  it('accepting keeps the ticked properties the company still owns, and refuses when none is left', async () => {
    const w = await world()
    const invite = async (propertyIds: string[]) => {
      const email = `acc-${randomUUID()}@test.dev`
      const r = await request(app()).post('/api/scopes/bookkeeper/invite').set('Authorization', `Bearer ${w.owner}`)
        .send({ landlordId: w.canyon, email, scope: { propertyIds } })
      expect(r.status).toBe(201)
      return (await db.query<{ token: string }>(`SELECT token FROM invitations WHERE id = $1`, [r.body.data.id])).rows[0].token
    }
    const some = await invite([w.alder, w.birch])
    const none = await invite([w.birch])
    await moveRaw(w.birch, w.delta)
    const ok = await request(app()).post(`/api/invitations/${some}/accept`).send({ password: 'a-long-password-1', firstName: 'S', lastName: 'K' })
    expect(ok.status).toBe(200)
    expect((await db.query(`SELECT property_ids FROM bookkeeper_scopes WHERE user_id = $1`, [ok.body.data.userId])).rows[0].property_ids)
      .toEqual([w.alder])
    const gone = await request(app()).post(`/api/invitations/${none}/accept`).send({ password: 'a-long-password-1', firstName: 'N', lastName: 'K' })
    expect(gone.status).toBe(409)
  })

  it('10/12: a company with no property yet may have a company-wide bookkeeper; only nothing ticked is refused', async () => {
    const c = await db.connect()
    let pass: string, landlordId: string
    try {
      const l = await seedLandlord(c)
      landlordId = l.landlordId
      pass = sign({ userId: l.userId, role: 'landlord', email: 'n@t.dev', profileId: null, landlordIds: [l.landlordId], permissions: {} })
    } finally { c.release() }
    const none = await request(app()).post('/api/scopes/bookkeeper/invite').set('Authorization', `Bearer ${pass!}`)
      .send({ landlordId: landlordId!, email: `z-${randomUUID()}@test.dev`, scope: { propertyIds: [] } })
    expect(none.status).toBe(400)
    expect(none.body.error).toBe('Tick at least one property or Company-wide.')
    const wide = await request(app()).post('/api/scopes/bookkeeper/invite').set('Authorization', `Bearer ${pass!}`)
      .send({ landlordId: landlordId!, email: `w-${randomUUID()}@test.dev`, scope: { propertyIds: [], companyWide: true } })
    expect(wide.status, JSON.stringify(wide.body)).toBe(201)
    const tok = (await db.query<{ token: string }>(`SELECT token FROM invitations WHERE id = $1`, [wide.body.data.id])).rows[0].token
    // The accept page is told what the invitation gives — no property, the company-wide books.
    const page = await request(app()).get(`/api/invitations/${tok}`)
    expect(page.body.data.bookkeeperAccess).toEqual({
      companyWide: true, showLeaseDates: false, propertyCount: 0,
      // 10/12 (Nic): the ledger, whole-company reports and monthly report boxes, off unless ticked.
      companyLedger: false, wholeCompanyReports: false, seesMonthlyReport: false,
    })
    const acc = await request(app()).post(`/api/invitations/${tok}/accept`).send({ password: 'a-long-password-1', firstName: 'W', lastName: 'K' })
    expect(acc.status, JSON.stringify(acc.body)).toBe(200)
    const row = (await db.query(`SELECT property_ids, company_wide FROM bookkeeper_scopes WHERE user_id = $1`, [acc.body.data.userId])).rows[0]
    expect(row).toEqual({ property_ids: [], company_wide: true })
    const bk = bkPass(acc.body.data.userId, landlordId!)
    const scope = await scopeOf(bk)
    expect(scope.status).toBe(200)
    expect(scope.body.data).toMatchObject({ companyWide: true, properties: [] })
    expect((await request(app()).get('/api/financials/bank-activity').set('Authorization', `Bearer ${bk}`)).status).toBe(200)
  })
})

describe('removing a bookkeeper from one company leaves their other companies alone', () => {
  it('DELETE names the company; with none named, a bookkeeper of two is asked about, not removed from both', async () => {
    const w = await world()
    await db.query(`INSERT INTO bookkeeper_scopes (user_id, landlord_id, property_ids) VALUES ($1, $2, $3)`, [w.bea, w.delta, [w.elm]])
    const ask = await request(app()).delete(`/api/scopes/bookkeeper/${w.bea}`).set('Authorization', `Bearer ${w.owner}`)
    expect(ask.status).toBe(400)
    expect((await db.query(`SELECT 1 FROM bookkeeper_scopes WHERE user_id = $1`, [w.bea])).rowCount).toBe(2)
    const one = await request(app()).delete(`/api/scopes/bookkeeper/${w.bea}?landlordId=${w.canyon}`).set('Authorization', `Bearer ${w.owner}`)
    expect(one.status).toBe(200)
    const left = (await db.query<{ landlord_id: string }>(`SELECT landlord_id FROM bookkeeper_scopes WHERE user_id = $1`, [w.bea])).rows
    expect(left.map(r => r.landlord_id)).toEqual([w.delta])
  })
})

describe('SECURITY: staff give a bookkeeper only properties inside their own scope', () => {
  async function manager(w: World, scope: { propertyIds: string[]; all?: boolean }) {
    const id = (await db.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
       VALUES ($1, 'x', 'property_manager', 'Pat', 'Manager', TRUE) RETURNING id`, [`pm-${randomUUID()}@test.dev`])).rows[0].id
    const perms = { 'team.invite': true, 'team.manage_permissions': true }
    await db.query(
      `INSERT INTO property_manager_scopes (user_id, landlord_id, property_ids, unit_ids, all_properties, permissions)
       VALUES ($1, $2, $3, '{}', $4, $5)`, [id, w.canyon, scope.propertyIds, !!scope.all, JSON.stringify(perms)])
    return sign({ userId: id, role: 'property_manager', email: 'pm@t.dev', profileId: null, landlordId: w.canyon, permissions: perms })
  }

  it('a manager kept to Alder cannot give, change or remove Birch', async () => {
    const w = await world()
    const pm = await manager(w, { propertyIds: [w.alder] })
    for (const propertyIds of [[w.birch], [w.alder, w.birch]]) {
      const give = await request(app()).post('/api/scopes/bookkeeper/invite').set('Authorization', `Bearer ${pm}`)
        .send({ email: `g-${randomUUID()}@test.dev`, scope: { propertyIds } })
      expect(give.status).toBe(403)
      expect(give.body.error).toBe('You can only give a bookkeeper properties you manage yourself.')
    }
    expect((await db.query(`SELECT 1 FROM invitations`)).rowCount).toBe(0)
    // 10/11: Alder is theirs to give (the invite names it; no company sent).
    const own = await request(app()).post('/api/scopes/bookkeeper/invite').set('Authorization', `Bearer ${pm}`)
      .send({ email: `a-${randomUUID()}@test.dev`, scope: { propertyIds: [w.alder] } })
    expect(own.status, JSON.stringify(own.body)).toBe(201)
    // Another company's property is still refused.
    const elm = await request(app()).post('/api/scopes/bookkeeper/invite').set('Authorization', `Bearer ${pm}`)
      .send({ email: `e-${randomUUID()}@test.dev`, scope: { propertyIds: [w.elm] } })
    expect(elm.status).toBe(403)
    await db.query(`DELETE FROM invitations`)

    // Bea keeps Birch too: not the manager's to change or remove.
    const widen = await request(app()).patch(`/api/scopes/bookkeeper/${w.bea}`).set('Authorization', `Bearer ${pm}`)
      .send({ propertyIds: [w.alder] })
    expect(widen.status).toBe(403)
    expect(widen.body.error).toBe('This bookkeeper keeps properties you do not manage. Ask the owner to change or remove them.')
    expect((await request(app()).delete(`/api/scopes/bookkeeper/${w.bea}`).set('Authorization', `Bearer ${pm}`)).status).toBe(403)
    // Al keeps Alder only: the manager may not hand him Birch...
    const grow = await request(app()).patch(`/api/scopes/bookkeeper/${w.al}`).set('Authorization', `Bearer ${pm}`)
      .send({ propertyIds: [w.alder, w.birch] })
    expect(grow.status).toBe(403)
    expect((await db.query(`SELECT property_ids FROM bookkeeper_scopes WHERE user_id = $1`, [w.al])).rows[0].property_ids).toEqual([w.alder])
    // ...but may manage him inside Alder, and remove him.
    expect((await request(app()).patch(`/api/scopes/bookkeeper/${w.al}`).set('Authorization', `Bearer ${pm}`)
      .send({ propertyIds: [w.alder] })).status).toBe(200)
    expect((await request(app()).delete(`/api/scopes/bookkeeper/${w.al}`).set('Authorization', `Bearer ${pm}`)).status).toBe(200)
    expect((await db.query(`SELECT 1 FROM bookkeeper_scopes WHERE user_id = $1`, [w.bea])).rowCount).toBe(1)
  })

  it('10/12: a manager whose list covers every property may tick every box — but never the company-wide box', async () => {
    const w = await world()
    // Not set to every property: Canyon simply owns no other park today.
    const pm = await manager(w, { propertyIds: [w.alder, w.birch] })
    const grow = await request(app()).patch(`/api/scopes/bookkeeper/${w.al}`).set('Authorization', `Bearer ${pm}`)
      .send({ propertyIds: [w.alder, w.birch] })
    expect(grow.status, JSON.stringify(grow.body)).toBe(200)
    expect((await db.query(`SELECT property_ids, company_wide FROM bookkeeper_scopes WHERE user_id = $1`, [w.al])).rows[0])
      .toEqual({ property_ids: [w.alder, w.birch], company_wide: false })
    const wide = await request(app()).patch(`/api/scopes/bookkeeper/${w.al}`).set('Authorization', `Bearer ${pm}`)
      .send({ companyWide: true })
    expect(wide.status).toBe(403)
    expect(wide.body.error).toBe('You can give a bookkeeper the company-wide books (the bank account, payouts and payroll) only if you have company-wide access yourself: every property, with "View books" on.')
    expect((await db.query(`SELECT company_wide FROM bookkeeper_scopes WHERE user_id = $1`, [w.al])).rows[0].company_wide).toBe(false)
    const give = await request(app()).post('/api/scopes/bookkeeper/invite').set('Authorization', `Bearer ${pm}`)
      .send({ email: `w-${randomUUID()}@test.dev`, scope: { propertyIds: [w.alder], companyWide: true } })
    expect(give.status).toBe(403)
    expect((await db.query(`SELECT 1 FROM invitations`)).rowCount).toBe(0)
  })

  it('a manager naming their own company (as the Team page does) may edit and remove inside their scope', async () => {
    const w = await world()
    const pm = await manager(w, { propertyIds: [w.alder] })
    const edit = await request(app()).patch(`/api/scopes/bookkeeper/${w.al}`).set('Authorization', `Bearer ${pm}`)
      .send({ landlordId: w.canyon, propertyIds: [w.alder] })
    expect(edit.status, JSON.stringify(edit.body)).toBe(200)
    // Another company of the owner's account is still not theirs to name.
    const other = await request(app()).delete(`/api/scopes/bookkeeper/${w.al}?landlordId=${w.delta}`).set('Authorization', `Bearer ${pm}`)
    expect(other.status).toBe(403)
    const rm = await request(app()).delete(`/api/scopes/bookkeeper/${w.al}?landlordId=${w.canyon}`).set('Authorization', `Bearer ${pm}`)
    expect(rm.status, JSON.stringify(rm.body)).toBe(200)
    expect((await db.query(`SELECT 1 FROM bookkeeper_scopes WHERE user_id = $1`, [w.al])).rowCount).toBe(0)
  })

  it('a manager over every property may manage any of the company\'s bookkeepers', async () => {
    const w = await world()
    const pm = await manager(w, { propertyIds: [], all: true })
    const r = await request(app()).patch(`/api/scopes/bookkeeper/${w.al}`).set('Authorization', `Bearer ${pm}`)
      .send({ propertyIds: [w.alder, w.birch] })
    expect(r.status).toBe(200)
  })
})

describe('migrations', () => {
  const read = (f: string) => fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', f), 'utf8')
  const BACKFILL = read('20261012160000_bookkeeper_scope_boxes_backfill.sql')
  const AUDIT = read('20261012160100_audit_bookkeeper_scope_grants.sql')

  it('the backfill writes an old NULL row out as every property the company owns, and fills a pending invitation', async () => {
    const w = await world()
    await withRollback(async c => {
      const old = await bookkeeperUser('Olga')
      await c.query(`INSERT INTO bookkeeper_scopes (user_id, landlord_id, property_ids) VALUES ($1, $2, NULL)`, [old, w.canyon])
      const inv = (await c.query<{ id: string }>(
        `INSERT INTO invitations (email, landlord_id, role, scope_payload, invited_by_user_id, token, expires_at)
         VALUES ('o@t.dev', $1, 'bookkeeper', '{"accessLevel":"read_only","propertyIds":null}'::jsonb, $2, $3, NOW() + interval '1 day')
         RETURNING id`, [w.canyon, w.ownerUserId, randomUUID()])).rows[0].id
      const kept = (await c.query<{ id: string; scope_payload: any }>(
        `INSERT INTO invitations (email, landlord_id, role, scope_payload, invited_by_user_id, token, expires_at)
         VALUES ('k@t.dev', $1, 'bookkeeper', $2::jsonb, $3, $4, NOW() + interval '1 day') RETURNING id, scope_payload`,
        [w.canyon, JSON.stringify({ accessLevel: 'read_only', propertyIds: [w.birch] }), w.ownerUserId, randomUUID()])).rows[0]
      await c.query(BACKFILL)
      await c.query(BACKFILL)   // re-running is a no-op
      const row = (await c.query(`SELECT property_ids FROM bookkeeper_scopes WHERE user_id = $1`, [old])).rows[0]
      expect([...row.property_ids].sort()).toEqual([w.alder, w.birch].sort())
      expect((await c.query(`SELECT property_ids FROM bookkeeper_scopes WHERE user_id = $1`, [w.al])).rows[0].property_ids).toEqual([w.alder])
      const patched = (await c.query(`SELECT scope_payload FROM invitations WHERE id = $1`, [inv])).rows[0].scope_payload
      expect([...patched.propertyIds].sort()).toEqual([w.alder, w.birch].sort())
      expect(patched.accessLevel).toBe('read_only')
      expect((await c.query(`SELECT scope_payload FROM invitations WHERE id = $1`, [kept.id])).rows[0].scope_payload).toEqual(kept.scope_payload)
    })
  })

  it('the backfill stops, in words, on a NULL row of a company with no property', async () => {
    await withRollback(async c => {
      const l = await seedLandlord(c)
      const u = (await c.query<{ id: string }>(
        `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
         VALUES ($1, 'x', 'bookkeeper', 'E', 'Mpty', TRUE) RETURNING id`, [`e-${randomUUID()}@test.dev`])).rows[0].id
      await c.query(`INSERT INTO bookkeeper_scopes (user_id, landlord_id, property_ids) VALUES ($1, $2, NULL)`, [u, l.landlordId])
      await expect(c.query(BACKFILL)).rejects.toThrow(/owns no property/)
    })
  })

  it('the change journal records a bookkeeper grant (INSERT), and still only UPDATE/DELETE elsewhere', async () => {
    const w = await world()
    await withRollback(async c => {
      await c.query(AUDIT)
      const u = (await c.query<{ id: string }>(
        `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
         VALUES ($1, 'x', 'bookkeeper', 'J', 'Ournal', TRUE) RETURNING id`, [`j-${randomUUID()}@test.dev`])).rows[0].id
      const id = (await c.query<{ id: string }>(
        `INSERT INTO bookkeeper_scopes (user_id, landlord_id, property_ids) VALUES ($1, $2, $3) RETURNING id`,
        [u, w.canyon, [w.alder]])).rows[0].id
      const grant = (await c.query(
        `SELECT op, old_row, new_row FROM audit_row_changes WHERE table_name = 'bookkeeper_scopes' AND row_id = $1`, [id])).rows
      expect(grant).toHaveLength(1)
      expect(grant[0].op).toBe('INSERT')
      expect(grant[0].old_row).toBeNull()
      expect(grant[0].new_row.property_ids).toEqual([w.alder])
      await c.query(`UPDATE bookkeeper_scopes SET property_ids = $2 WHERE id = $1`, [id, [w.alder, w.birch]])
      const ops = (await c.query<{ op: string }>(
        `SELECT op FROM audit_row_changes WHERE table_name = 'bookkeeper_scopes' AND row_id = $1 ORDER BY id`, [id])).rows.map(r => r.op)
      expect(ops).toEqual(['INSERT', 'UPDATE'])
      // Another audited table still journals no INSERT.
      await seedProperty(c, { landlordId: w.delta, ownerUserId: w.ownerUserId, managedByUserId: w.ownerUserId })
      expect((await c.query(`SELECT 1 FROM audit_row_changes WHERE table_name = 'properties' AND op = 'INSERT'`)).rowCount).toBe(0)
      // An UPDATE row must still carry the row as it was.
      await expect(c.query(
        `INSERT INTO audit_row_changes (table_name, row_id, op, old_row, new_row) VALUES ('x', NULL, 'UPDATE', NULL, '{}'::jsonb)`))
        .rejects.toThrow(/audit_row_changes_old_row_present/)
    })
  })
})
