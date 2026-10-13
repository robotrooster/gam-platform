/**
 * 10/12 review (Nic) — THE BOOKKEEPER BOXES, AFTER A SALE AND IN THE COMPANY
 * REPORTS.
 *
 *   1. SECURITY: what a company owns TODAY never decides what a bookkeeper was
 *      given. Selling the property a company-wide bookkeeper was never given
 *      (or every property) never shows them that property's history. 10/12
 *      (Nic, BK3): with every property the company still owns ticked and the
 *      company-wide box, they ARE the whole company for what it still owns —
 *      hired before the sale or after — and only the sold property's history
 *      stays hidden.
 *   2. The property money inside the Books company reports (P&L, cash flow,
 *      owner statements) follows the property boxes: a company-wide-only
 *      bookkeeper sees the ledger, payroll and payouts there, and no
 *      property's own money ("the property boxes keep governing property
 *      money").
 *   3. The same company report never depends on unrelated boxes, and never
 *      shows money after a sale.
 *   4. SECURITY: staff kept to some properties cannot remove a bookkeeper who
 *      keeps the history of a property outside them.
 *   5. The Team page is told the API reads the boxes (deploy order).
 *   6. A property's costs are its companies' own: the buyer's bookkeeper never
 *      sees the seller's repairs or expenses from before the sale.
 *   7. A former property is a row of By Property (and opens), so the table
 *      adds up to the P&L beside it.
 *
 * The world: Canyon LLC owns Alder, Birch and Cedar; Delta LLC (the same
 * owner) owns Elm.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { randomUUID } from 'crypto'
import { db } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedTenant, seedLease, seedLeaseTenant } from '../test/dbHelpers'
import { errorHandler } from '../middleware/errorHandler'
import { financialsRouter } from './financials'
import { expensesRouter } from './expenses'
import { reportsRouter } from './reports'
import { booksRouter } from './books'
import { scopesRouter } from './scopes'
import { transferProperty } from '../services/propertyTransfer'
import { bookkeeperScopesOf, requestScopeOf, HIDDEN_HISTORY } from '../lib/bookkeeperScope'

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/financials', financialsRouter)
  app.use('/api/expenses', expensesRouter)
  app.use('/api/reports', reportsRouter)
  app.use('/api/books', booksRouter)
  app.use('/api/scopes', scopesRouter)
  app.use(errorHandler)
  return app
}
const app = () => buildApp()
const sign = (p: object) => jwt.sign(p, process.env.JWT_SECRET!, { expiresIn: '1h' })

beforeEach(async () => {
  await cleanupAllSchema()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_bookkeeper_scope_review'
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

async function bookkeeper(landlordId: string, propertyIds: string[], companyWide: boolean): Promise<{ id: string; tok: string }> {
  const id = (await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
     VALUES ($1, 'x', 'bookkeeper', 'Bo', 'Keeper', TRUE) RETURNING id`, [`bk-${randomUUID()}@test.dev`])).rows[0].id
  await db.query(`INSERT INTO bookkeeper_scopes (user_id, landlord_id, property_ids, company_wide) VALUES ($1, $2, $3, $4)`,
    [id, landlordId, propertyIds, companyWide])
  return { id, tok: sign({ userId: id, role: 'bookkeeper', email: 'bk@t.dev', profileId: null, landlordId, permissions: { access_level: 'read_only' } }) }
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
const expense = async (w: World, landlordId: string, propertyId: string | null, amount: number, day: string) => (await db.query<{ id: string }>(
  `INSERT INTO landlord_expenses (landlord_id, created_by, property_id, category, amount, expense_date)
   VALUES ($1, $2, $3, 'repairs', $4, $5) RETURNING id`, [landlordId, w.ownerUserId, propertyId, amount, day])).rows[0].id
const repair = (unitId: string, landlordId: string, cost: number, at: string) => db.query(
  `INSERT INTO maintenance_requests (unit_id, landlord_id, title, description, category, status, actual_cost, completed_at)
   VALUES ($1, $2, 'Fix', 'fix', 'plumbing', 'completed', $3, $4)`, [unitId, landlordId, cost, at])

/** Canyon sells a property to Delta, the sale dated 9/20 noon Phoenix. */
async function sell(w: World, propertyId: string) {
  const t = await transferProperty({ propertyId, fromLandlordId: w.canyon, toLandlordId: w.delta, byUserId: w.ownerUserId })
  await db.query(`UPDATE property_transfers SET transferred_at = '2026-09-20T19:00:00Z' WHERE id = $1`, [t.transferId])
  await db.query(`UPDATE bookkeeper_former_properties SET left_at = '2026-09-20T19:00:00Z' WHERE property_transfer_id = $1`, [t.transferId])
}

const get = (tok: string, url: string) => request(app()).get(url).set('Authorization', `Bearer ${tok}`)
const booksGet = (tok: string, url: string, clientId: string) => get(tok, url).set('X-Client-Id', clientId)
const scopeOf = async (userId: string, landlordId: string) => requestScopeOf((await bookkeeperScopesOf(userId, landlordId))[0])

describe('1. SECURITY + BK3: a sold property never theirs is hidden; it never decides whether they are the whole company', () => {
  /**
   * 10/12 (Nic, BK3): "a bookkeeper hired AFTER a property sale, with every
   * current box + company-wide: YES whole-company for everything still owned;
   * only the sold property's history hidden." The 10/12 review's hole (the
   * null scope read a never-given property's pre-sale history by company) is
   * closed by hiding that history, not by refusing them the whole company.
   */
  async function birchSoldWithHistory(w: World) {
    await paidOn(w.alderUnit, w.canyon, 500, '2026-09-03T18:00:00Z')
    await paidOn(w.birchUnit, w.canyon, 300, '2026-09-04T18:00:00Z')
    const birchExpense = await expense(w, w.canyon, w.birch, 77, '2026-09-05')
    const birchReceipt = `/api/expenses/receipt-files/r-${randomUUID()}.pdf`
    await db.query(`UPDATE landlord_expenses SET receipt_url = $2 WHERE id = $1`, [birchExpense, birchReceipt])
    const companyExpense = await expense(w, w.canyon, null, 12, '2026-09-08')
    await repair(w.birchUnit, w.canyon, 33, '2026-09-06T18:00:00Z')
    return { birchExpense, birchReceipt, companyExpense }
  }

  async function expectWholeButBirchHidden(w: World, bk: { id: string; tok: string }, h: { birchExpense: string; birchReceipt: string; companyExpense: string }) {
    const scope = await scopeOf(bk.id, w.canyon)
    // The whole company for everything it still owns ...
    expect(scope.propertyIds).toBeNull()
    expect(scope.currentIds).toBeNull()
    // ... and Birch's history hidden whole.
    expect(scope.cutoffs).toEqual([{ propertyId: w.birch, lastDay: HIDDEN_HISTORY }])

    expect((await get(bk.tok, '/api/financials/income?from=2026-09-01&to=2026-09-30')).body.data.total).toBe(500)
    expect((await get(bk.tok, '/api/financials/maintenance-costs?from=2026-09-01&to=2026-09-30')).body.data.total).toBe(0)
    const pl = await get(bk.tok, '/api/reports/monthly-pl?year=2026&month=9')
    expect(pl.body.data.gross.total).toBe(500)
    // The company's own expense (no property) is theirs now; Birch's is not.
    expect(pl.body.data.expenses.enteredExpenses).toBe(12)
    expect(pl.body.data.expenses.maintenance).toBe(0)
    const listed = (await get(bk.tok, '/api/expenses')).body.data.map((e: any) => e.id)
    expect(listed).not.toContain(h.birchExpense)
    expect(listed).toContain(h.companyExpense)
    expect((await get(bk.tok, h.birchReceipt)).status).toBe(403)
    const props = (await get(bk.tok, '/api/financials/scope')).body.data.properties.map((p: any) => p.id)
    expect(props).not.toContain(w.birch)
    expect((await get(bk.tok, `/api/financials/income?propertyId=${w.birch}`)).status).toBe(403)
    expect((await get(bk.tok, `/api/reports/property-detail?propertyId=${w.birch}&year=2026&month=9`)).status).toBe(404)
    const byProperty = (await get(bk.tok, '/api/reports/property-pl?year=2026&month=9')).body.data.properties.map((p: any) => p.id)
    expect(byProperty).not.toContain(w.birch)
    const summary = await get(bk.tok, '/api/reports/summary')
    expect(summary.body.data.monthly.find((m: any) => m.month === '2026-09')?.collected).toBe(500)
    // The Books company reports: the whole company, Birch hidden.
    const books = await booksGet(bk.tok, '/api/books/reports/pl?startDate=2026-09-01&endDate=2026-09-30', w.canyon)
    expect(books.status).toBe(200)
    expect(books.body.data.gamRentIncome).toBe(500)
    const cf = await booksGet(bk.tok, '/api/books/reports/cash-flow?startDate=2026-09-01&endDate=2026-09-30', w.canyon)
    expect(cf.body.data.operating.inflows.rentCollected).toBe(500)
    // And they file at company level (that is the whole company's).
    const file = await request(app()).post('/api/expenses').set('Authorization', `Bearer ${bk.tok}`)
      .send({ category: 'repairs', amount: 5, expenseDate: '2026-09-07' })
    expect(file.status, JSON.stringify(file.body)).toBe(200)
    expect(file.body.data.property_id ?? file.body.data.propertyId ?? null).toBeNull()
    // The owner's books keep what the rows say.
    expect((await get(w.owner, '/api/financials/income?from=2026-09-01&to=2026-09-30')).body.data.total).toBe(800)
  }

  it('company-wide + Alder (+ Cedar): Birch, never ticked, is sold — whole company, Birch hidden everywhere', async () => {
    const w = await world()
    const h = await birchSoldWithHistory(w)
    const bea = await bookkeeper(w.canyon, [w.alder, w.cedar], true)
    expect((await get(bea.tok, '/api/financials/income?from=2026-09-01&to=2026-09-30')).body.data.total).toBe(500)
    await sell(w, w.birch)
    await expectWholeButBirchHidden(w, bea, h)
  })

  it('BK3: hired AFTER the sale with every current box and Company-wide — the same', async () => {
    const w = await world()
    const h = await birchSoldWithHistory(w)
    await sell(w, w.birch)
    const hired = await bookkeeper(w.canyon, [w.alder, w.cedar], true)
    await expectWholeButBirchHidden(w, hired, h)
    // A one-off expense of theirs on Birch before it was unticked (impossible
    // for a hire after the sale, made here by hand) is not theirs to change.
    const old = (await db.query<{ id: string }>(
      `INSERT INTO landlord_expenses (landlord_id, created_by, property_id, category, amount, expense_date)
       VALUES ($1, $2, $3, 'repairs', 9, '2026-09-02') RETURNING id`, [w.canyon, hired.id, w.birch])).rows[0].id
    const edit = await request(app()).patch(`/api/expenses/${old}`).set('Authorization', `Bearer ${hired.tok}`).send({ amount: 10 })
    expect(edit.status).toBe(404)
    expect((await db.query(`SELECT amount::float AS a FROM landlord_expenses WHERE id = $1`, [old])).rows[0].a).toBe(9)
  })

  it('SECURITY: without every current property, or without Company-wide, a sale never widens them', async () => {
    const w = await world()
    await birchSoldWithHistory(w)
    await sell(w, w.birch)
    const someOnly = await bookkeeper(w.canyon, [w.alder], true)
    const noBox = await bookkeeper(w.canyon, [w.alder, w.cedar], false)
    for (const bk of [someOnly, noBox]) {
      const scope = await scopeOf(bk.id, w.canyon)
      expect(scope.propertyIds).not.toBeNull()
      expect((await get(bk.tok, '/api/financials/income?from=2026-09-01&to=2026-09-30')).body.data.total).toBe(500)
      const file = await request(app()).post('/api/expenses').set('Authorization', `Bearer ${bk.tok}`)
        .send({ category: 'repairs', amount: 5, expenseDate: '2026-09-07' })
      expect(file.status).toBe(400)
    }
  })

  it('company-wide only: the company sells everything — still no property money', async () => {
    const w = await world()
    await paidOn(w.alderUnit, w.canyon, 500, '2026-09-03T18:00:00Z')
    await paidOn(w.birchUnit, w.canyon, 300, '2026-09-04T18:00:00Z')
    const cy = await bookkeeper(w.canyon, [], true)
    expect((await get(cy.tok, '/api/financials/income?from=2026-09-01&to=2026-09-30')).body.data.total).toBe(0)
    await sell(w, w.alder); await sell(w, w.birch); await sell(w, w.cedar)

    const scope = await scopeOf(cy.id, w.canyon)
    expect(scope.propertyIds).toEqual([])
    expect(scope.companyWide).toBe(true)
    expect((await get(cy.tok, '/api/financials/income?from=2026-09-01&to=2026-09-30')).body.data.total).toBe(0)
    expect((await get(cy.tok, '/api/reports/monthly-pl?year=2026&month=9')).body.data.gross.total).toBe(0)
    // The company-wide books are still theirs.
    expect((await get(cy.tok, '/api/financials/bank-activity')).status).toBe(200)
  })

  it('a bookkeeper who had the sold property when it left stays the whole company (cut at the sale)', async () => {
    const w = await world()
    await paidOn(w.birchUnit, w.canyon, 300, '2026-09-04T18:00:00Z')
    await paidOn(w.birchUnit, w.canyon, 700, '2026-09-25T18:00:00Z')
    const dee = await bookkeeper(w.canyon, [w.alder, w.birch, w.cedar], true)
    await sell(w, w.birch)
    const scope = await scopeOf(dee.id, w.canyon)
    expect(scope.propertyIds).toBeNull()
    expect(scope.cutoffs).toEqual([{ propertyId: w.birch, lastDay: '2026-09-20' }])
    expect((await get(dee.tok, '/api/financials/income?from=2026-09-01&to=2026-09-30')).body.data.total).toBe(300)
  })
})

describe('1b. the cut leaves the other properties alone (10/12, BK3 review)', () => {
  it('a sold Alder cut at 9/20 never hides Birch\'s later expenses (the cut once compared itself)', async () => {
    const w = await world()
    const al = await bookkeeper(w.canyon, [w.alder, w.birch], false)
    await expense(w, w.canyon, w.alder, 40, '2026-09-05')
    await expense(w, w.canyon, w.alder, 90, '2026-09-26')   // after Alder left: out
    await expense(w, w.canyon, w.birch, 25, '2026-09-27')   // Birch, still theirs: in
    await sell(w, w.alder)
    const pl = await get(al.tok, '/api/reports/monthly-pl?year=2026&month=9')
    expect(pl.status).toBe(200)
    expect(pl.body.data.expenses.enteredExpenses).toBe(65)
    const listed = (await get(al.tok, '/api/expenses')).body.data.map((e: any) => Number(e.amount)).sort((a: number, b: number) => a - b)
    expect(listed).toEqual([25, 40])
  })
})

describe('2-3. the Books company reports: property money follows the property boxes, and nothing after a sale', () => {
  it('company-wide only: the Books P&L, cash flow and owner statements carry no property\'s money', async () => {
    const w = await world()
    await paidOn(w.alderUnit, w.canyon, 500, '2026-09-03T18:00:00Z')
    await expense(w, w.canyon, w.alder, 40, '2026-09-05')
    const cy = await bookkeeper(w.canyon, [], true)
    const pl = await booksGet(cy.tok, '/api/books/reports/pl?startDate=2026-09-01&endDate=2026-09-30', w.canyon)
    expect(pl.status).toBe(200)
    expect(pl.body.data.gamRentIncome).toBe(0)
    expect(pl.body.data.gamPL.expenses.enteredExpenses).toBe(0)
    const cf = await booksGet(cy.tok, '/api/books/reports/cash-flow?startDate=2026-09-01&endDate=2026-09-30', w.canyon)
    expect(cf.status).toBe(200)
    expect(cf.body.data.operating.inflows.rentCollected).toBe(0)
    const os = await booksGet(cy.tok, '/api/books/reports/owner-statements?startDate=2026-09-01&endDate=2026-09-30', w.canyon)
    expect(os.status).toBe(200)
    expect(os.body.data[0].properties).toEqual([])
    expect(os.body.data[0].totalCollected).toBe(0)
    // The owner's own statement is the whole company.
    const owner = await booksGet(w.owner, '/api/books/reports/owner-statements?startDate=2026-09-01&endDate=2026-09-30', w.canyon)
    expect(owner.body.data[0].properties.map((p: any) => p.name)).toEqual(['Alder', 'Birch', 'Cedar'])
    expect(owner.body.data[0].totalCollected).toBe(500)
  })

  it('company-wide + Alder: the reports carry Alder\'s money and only Alder\'s', async () => {
    const w = await world()
    await paidOn(w.alderUnit, w.canyon, 500, '2026-09-03T18:00:00Z')
    await paidOn(w.birchUnit, w.canyon, 300, '2026-09-04T18:00:00Z')
    const bea = await bookkeeper(w.canyon, [w.alder], true)
    const pl = await booksGet(bea.tok, '/api/books/reports/pl?startDate=2026-09-01&endDate=2026-09-30', w.canyon)
    expect(pl.body.data.gamRentIncome).toBe(500)
    const os = await booksGet(bea.tok, '/api/books/reports/owner-statements?startDate=2026-09-01&endDate=2026-09-30', w.canyon)
    expect(os.body.data[0].properties.map((p: any) => [p.name, p.collected])).toEqual([['Alder', 500]])
  })

  it('the same report gives the same total whatever the unrelated boxes, and never counts money after a sale', async () => {
    const w = await world()
    await paidOn(w.alderUnit, w.canyon, 200, '2026-09-05T18:00:00Z')
    await paidOn(w.birchUnit, w.canyon, 300, '2026-09-04T18:00:00Z')
    await paidOn(w.birchUnit, w.canyon, 700, '2026-09-25T18:00:00Z')   // late rent paid to the seller after the sale
    await sell(w, w.birch)
    const bea = await bookkeeper(w.canyon, [w.alder], true)
    const read = async () => {
      const pl = await booksGet(bea.tok, '/api/books/reports/pl?startDate=2026-09-01&endDate=2026-09-30', w.canyon)
      const cf = await booksGet(bea.tok, '/api/books/reports/cash-flow?startDate=2026-09-01&endDate=2026-09-30', w.canyon)
      return [pl.body.data.gamRentIncome, cf.body.data.operating.inflows.rentCollected]
    }
    expect(await read()).toEqual([200, 200])
    // Ticking Cedar (now every property Canyon owns) changes nothing about Birch.
    await db.query(`UPDATE bookkeeper_scopes SET property_ids = $2 WHERE user_id = $1`, [bea.id, [w.alder, w.cedar]])
    expect(await read()).toEqual([200, 200])
  })
})

describe('4. SECURITY: staff cannot remove a bookkeeper who keeps history outside their own properties', () => {
  it('a manager kept to Alder cannot remove (or change) a bookkeeper with sold Birch\'s history', async () => {
    const w = await world()
    const al = await bookkeeper(w.canyon, [w.alder, w.birch], false)
    await sell(w, w.birch)
    const pmId = (await db.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
       VALUES ($1, 'x', 'property_manager', 'Pat', 'Manager', TRUE) RETURNING id`, [`pm-${randomUUID()}@test.dev`])).rows[0].id
    const perms = { 'team.invite': true, 'team.manage_permissions': true }
    await db.query(`INSERT INTO property_manager_scopes (user_id, landlord_id, property_ids, unit_ids, all_properties, permissions)
                    VALUES ($1, $2, $3, '{}', FALSE, $4)`, [pmId, w.canyon, [w.alder], JSON.stringify(perms)])
    const pm = sign({ userId: pmId, role: 'property_manager', email: 'pm@t.dev', profileId: null, landlordId: w.canyon, permissions: perms })
    const del = await request(app()).delete(`/api/scopes/bookkeeper/${al.id}`).set('Authorization', `Bearer ${pm}`)
    expect(del.status).toBe(403)
    expect(del.body.error).toBe('This bookkeeper keeps properties you do not manage. Ask the owner to change or remove them.')
    const ch = await request(app()).patch(`/api/scopes/bookkeeper/${al.id}`).set('Authorization', `Bearer ${pm}`).send({ showLeaseDates: true })
    expect(ch.status).toBe(403)
    expect((await db.query(`SELECT 1 FROM bookkeeper_former_properties fp JOIN bookkeeper_scopes bs ON bs.id = fp.bookkeeper_scope_id
                             WHERE bs.user_id = $1`, [al.id])).rowCount).toBe(1)
    // The owner can.
    const owner = await request(app()).delete(`/api/scopes/bookkeeper/${al.id}?landlordId=${w.canyon}`).set('Authorization', `Bearer ${w.owner}`)
    expect(owner.status).toBe(200)
  })
})

describe('5. the Team page is told the API reads the bookkeeper boxes', () => {
  it('/scopes/team says so', async () => {
    const w = await world()
    const team = await request(app()).get('/api/scopes/team').set('Authorization', `Bearer ${w.owner}`)
    expect(team.status).toBe(200)
    expect(team.body.data.bookkeeperBoxes).toBe(true)
  })
})

describe('6. a property\'s costs are its companies\' own: the buyer never reads the seller\'s', () => {
  it('Delta\'s bookkeeper, ticked for Alder after it moved from Canyon, sees none of Canyon\'s costs from before', async () => {
    const w = await world()
    await repair(w.alderUnit, w.canyon, 60, '2026-09-06T18:00:00Z')
    await expense(w, w.canyon, w.alder, 40, '2026-09-05')
    await sell(w, w.alder)
    await repair(w.alderUnit, w.delta, 25, '2026-09-28T18:00:00Z')
    const dee = await bookkeeper(w.delta, [w.alder, w.elm], true)
    const pd = await get(dee.tok, `/api/reports/property-detail?propertyId=${w.alder}&year=2026&month=9`)
    expect(pd.status).toBe(200)
    expect(pd.body.data.maintenance.map((m: any) => m.actualCost)).toEqual([25])
    expect(pd.body.data.expenses).toMatchObject({ maintenance: 25, enteredExpenses: 0 })
    const pp = await get(dee.tok, '/api/reports/property-pl?year=2026&month=9')
    const alder = pp.body.data.properties.find((p: any) => p.id === w.alder)
    expect(alder).toMatchObject({ maint_cost: 25, entered_expenses: 0, left_on: null })
  })

  it('the owner of both companies reads both companies\' facts on the row and in its drill-in alike', async () => {
    const w = await world()
    await paidOn(w.alderUnit, w.canyon, 500, '2026-09-03T18:00:00Z')
    await repair(w.alderUnit, w.canyon, 60, '2026-09-06T18:00:00Z')
    await sell(w, w.alder)
    await repair(w.alderUnit, w.delta, 25, '2026-09-28T18:00:00Z')
    const pp = await get(w.owner, '/api/reports/property-pl?year=2026&month=9')
    const row = pp.body.data.properties.find((p: any) => p.id === w.alder)
    const pd = await get(w.owner, `/api/reports/property-detail?propertyId=${w.alder}&year=2026&month=9`)
    expect(row).toMatchObject({ income_total: 500, maint_cost: 85 })
    expect(pd.body.data.breakdown.total).toBe(500)
    expect(pd.body.data.expenses.maintenance).toBe(85)
    expect(pd.body.data.net).toBe(row.net_income)
  })
})

describe('7. a former property is a row of By Property, and opens', () => {
  it('Al (Alder only): after the sale his table adds up to his P&L, history only, nothing after', async () => {
    const w = await world()
    await paidOn(w.alderUnit, w.canyon, 500, '2026-09-03T18:00:00Z')
    await paidOn(w.alderUnit, w.canyon, 700, '2026-09-25T18:00:00Z')
    await expense(w, w.canyon, w.alder, 40, '2026-09-05')
    await expense(w, w.canyon, w.alder, 90, '2026-09-26')
    await repair(w.alderUnit, w.canyon, 60, '2026-09-06T18:00:00Z')
    await repair(w.alderUnit, w.canyon, 80, '2026-09-27T18:00:00Z')
    const al = await bookkeeper(w.canyon, [w.alder], false)
    await sell(w, w.alder)

    const pl = await get(al.tok, '/api/reports/monthly-pl?year=2026&month=9')
    expect(pl.body.data.gross.total).toBe(500)
    expect(pl.body.data.expenses.maintenance).toBe(60)
    expect(pl.body.data.expenses.enteredExpenses).toBe(40)

    const pp = await get(al.tok, '/api/reports/property-pl?year=2026&month=9')
    expect(pp.status).toBe(200)
    expect(pp.body.data.properties).toHaveLength(1)
    const row = pp.body.data.properties[0]
    expect(row).toMatchObject({
      id: w.alder, name: 'Alder', left_on: '2026-09-20', landlord_id: w.canyon,
      total_units: null, occupied_units: null, occupancy_rate: null,
      income_total: 500, maint_cost: 60, entered_expenses: 40,
    })

    const pd = await get(al.tok, `/api/reports/property-detail?propertyId=${w.alder}&year=2026&month=9`)
    expect(pd.status).toBe(200)
    expect(pd.body.data.property).toMatchObject({ leftOn: '2026-09-20', totalUnits: null, occupiedUnits: null })
    expect(pd.body.data.breakdown.total).toBe(500)
    expect(pd.body.data.expenses).toMatchObject({ maintenance: 60, enteredExpenses: 40 })
    expect(pd.body.data.maintenance.map((m: any) => m.actualCost)).toEqual([60])
    expect(pd.body.data.units).toEqual([])
    expect(pd.body.data.net).toBe(row.net_income)
    // October is after the sale: nothing.
    const oct = await get(al.tok, `/api/reports/property-detail?propertyId=${w.alder}&year=2026&month=10`)
    expect(oct.body.data.breakdown.total).toBe(0)

    // A property that was never his still 404s, and the owner's table is unchanged.
    expect((await get(al.tok, `/api/reports/property-detail?propertyId=${w.birch}&year=2026&month=9`)).status).toBe(404)
    const owner = await get(w.owner, '/api/reports/property-pl?year=2026&month=9')
    expect(owner.body.data.properties.every((p: any) => p.left_on === null)).toBe(true)
  })
})
