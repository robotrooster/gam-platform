/**
 * 10/11 (Nic) — A BOOKKEEPER FOR MOUNTAIN VIEW, AND NOTHING ELSE.
 *
 *   "I need to invite somebody to be a bookkeeper for the Mountain View
 *    property. They don't need to see anything with Oak Park. They don't
 *    necessarily need to see anything to do with non-bookkeeping related stuff.
 *    They just need to see the financials, money coming in, money going out,
 *    maintenance... the maintenance costs... any receipts that I upload as
 *    expenses whether they're tacked on to a unit or to a whole property...
 *    maybe not even necessarily people's names."
 *
 * Later the same day, on names: "let's probably have it actually just show
 * their names." So tenant NAMES reach a bookkeeper wherever the books need
 * them (who paid, whose unit); contact details never do.
 *
 * The world: one owner account with two companies — Mountain View (two parks:
 * MV and MV Annex) and Oak Park. A bookkeeper keeps Mountain View's books
 * (every property); a second keeps only the MV park. Tenants are named Zebulon
 * Quixote — a name a bookkeeper may read — and carry an email and a phone
 * number that must never reach one.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import fs from 'fs'
import path from 'path'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { randomUUID } from 'crypto'
import { db } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedTenant, seedLease, seedLeaseTenant } from '../test/dbHelpers'
import { errorHandler } from '../middleware/errorHandler'
import { BOOKKEEPER_REFUSAL } from '../lib/bookkeeperAccess'
import { financialsRouter } from './financials'
import { expensesRouter } from './expenses'
import { reportsRouter } from './reports'
import { booksRouter } from './books'
import { scopesRouter, invitationsRouter } from './scopes'
import { tenantsRouter } from './tenants'
import { leasesRouter } from './leases'
import { documentsRouter } from './documents'
import { esignRouter } from './esign'
import { bookingsRouter } from './bookings'
import { backgroundRouter } from './background'
import { landlordsRouter } from './landlords'
import { paymentsRouter } from './payments'
import { balancesRouter } from './balances'
import { maintenanceRouter } from './maintenance'
import { notificationsRouter } from './notifications'
import { unitsRouter } from './units'
import { propertiesRouter } from './properties'
import { bankFeedRouter } from './bankFeed'
import { disbursementsRouter } from './disbursements'
import { incomeTotals } from '../services/incomeBasis'
import { financialsScope } from '../lib/financialsScope'

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/financials', financialsRouter)
  app.use('/api/expenses', expensesRouter)
  app.use('/api/reports', reportsRouter)
  app.use('/api/books', booksRouter)
  app.use('/api/scopes', scopesRouter)
  app.use('/api/invitations', invitationsRouter)
  app.use('/api/tenants', tenantsRouter)
  app.use('/api/leases', leasesRouter)
  app.use('/api/documents', documentsRouter)
  app.use('/api/esign', esignRouter)
  app.use('/api/bookings', bookingsRouter)
  app.use('/api/background', backgroundRouter)
  app.use('/api/landlords', landlordsRouter)
  app.use('/api/payments', paymentsRouter)
  app.use('/api/balances', balancesRouter)
  app.use('/api/maintenance', maintenanceRouter)
  app.use('/api/notifications', notificationsRouter)
  app.use('/api/units', unitsRouter)
  app.use('/api/properties', propertiesRouter)
  app.use('/api/bank-feed', bankFeedRouter)
  app.use('/api/disbursements', disbursementsRouter)
  app.use(errorHandler)
  return app
}

const SECRET_FIRST = 'Zebulon'
const SECRET_LAST = 'Quixote'
const SECRET_EMAIL_PART = 'zebulon.quixote'
const SECRET_PHONE = '480-555-0199'

interface World {
  ownerUserId: string
  mv: string; op: string                       // companies
  mvPark: string; mvAnnex: string; opPark: string
  mvUnit: string; mvStayUnit: string; annexUnit: string; opUnit: string
  bk: string; bkNarrow: string
  owner: string; tokBk: string; tokBkNarrow: string; tokOtherOwner: string
  ownerExpense: string; opExpense: string
}

const sign = (p: object) => jwt.sign(p, process.env.JWT_SECRET!, { expiresIn: '1h' })

beforeEach(async () => {
  await cleanupAllSchema()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_bookkeeper_fin'
})

async function world(): Promise<World> {
  const c = await db.connect()
  try {
    const { userId: ownerUserId, landlordId: mv } = await seedLandlord(c)
    const op = (await c.query<{ id: string }>(
      `INSERT INTO landlords (user_id, billing_starts_at, business_name) VALUES ($1, DATE '2000-01-01', 'Oak Park LLC') RETURNING id`,
      [ownerUserId])).rows[0].id
    await c.query(`UPDATE landlords SET business_name = 'Mountain View LLC' WHERE id = $1`, [mv])
    await c.query(`INSERT INTO landlord_members (landlord_id, user_id) VALUES ($1, $3), ($2, $3) ON CONFLICT DO NOTHING`, [mv, op, ownerUserId])
      .catch(() => { /* founding ownership (landlords.user_id) is enough */ })
    const mvPark = await seedProperty(c, { landlordId: mv, ownerUserId, managedByUserId: ownerUserId })
    const mvAnnex = await seedProperty(c, { landlordId: mv, ownerUserId, managedByUserId: ownerUserId })
    const opPark = await seedProperty(c, { landlordId: op, ownerUserId, managedByUserId: ownerUserId })
    await c.query(`UPDATE properties SET name = 'Mountain View' WHERE id = $1`, [mvPark])
    await c.query(`UPDATE properties SET name = 'MV Annex' WHERE id = $1`, [mvAnnex])
    await c.query(`UPDATE properties SET name = 'Oak Park' WHERE id = $1`, [opPark])
    const mvUnit = await seedUnit(c, { propertyId: mvPark, landlordId: mv, unitType: 'rv_spot' })
    const mvStayUnit = await seedUnit(c, { propertyId: mvPark, landlordId: mv, unitType: 'rv_spot' })
    const annexUnit = await seedUnit(c, { propertyId: mvAnnex, landlordId: mv, unitType: 'rv_spot' })
    const opUnit = await seedUnit(c, { propertyId: opPark, landlordId: op })

    const bk = (await c.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
       VALUES ($1, 'x', 'bookkeeper', 'Bea', 'Keeper', TRUE) RETURNING id`, [`bk-${randomUUID()}@test.dev`])).rows[0].id
    const bkNarrow = (await c.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
       VALUES ($1, 'x', 'bookkeeper', 'Nora', 'Narrow', TRUE) RETURNING id`, [`bkn-${randomUUID()}@test.dev`])).rows[0].id
    // 10/11: every box ticked by hand. 10/12 (Nic): the company-wide box (bank
    // account, payouts, payroll) is the owner's own choice, ticked here for Bea.
    await c.query(`INSERT INTO bookkeeper_scopes (user_id, landlord_id, access_level, property_ids, company_wide) VALUES ($1, $2, 'read_only', $3, TRUE)`,
      [bk, mv, [mvPark, mvAnnex]])
    await c.query(`INSERT INTO bookkeeper_scopes (user_id, landlord_id, access_level, property_ids) VALUES ($1, $2, 'read_only', $3)`,
      [bkNarrow, mv, [mvPark]])

    const ownerExpense = (await c.query<{ id: string }>(
      `INSERT INTO landlord_expenses (landlord_id, created_by, property_id, unit_id, category, amount, expense_date, vendor, description)
       VALUES ($1, $2, $3, $4, 'repairs', 120, '2026-09-05', 'Pump Co', 'pump seal') RETURNING id`,
      [mv, ownerUserId, mvPark, mvUnit])).rows[0].id
    const opExpense = (await c.query<{ id: string }>(
      `INSERT INTO landlord_expenses (landlord_id, created_by, property_id, category, amount, expense_date, is_common)
       VALUES ($1, $2, $3, 'insurance', 900, '2026-09-06', TRUE) RETURNING id`,
      [op, ownerUserId, opPark])).rows[0].id

    const other = await seedLandlord(c)
    return {
      ownerUserId, mv, op, mvPark, mvAnnex, opPark, mvUnit, mvStayUnit, annexUnit, opUnit, bk, bkNarrow, ownerExpense, opExpense,
      owner: sign({ userId: ownerUserId, role: 'landlord', email: 'o@t.dev', profileId: null, landlordIds: [mv, op], permissions: {} }),
      tokBk: sign({ userId: bk, role: 'bookkeeper', email: 'bk@t.dev', profileId: null, landlordId: mv, permissions: { access_level: 'read_only' } }),
      tokBkNarrow: sign({ userId: bkNarrow, role: 'bookkeeper', email: 'bkn@t.dev', profileId: null, landlordId: mv, permissions: { access_level: 'read_only' } }),
      tokOtherOwner: sign({ userId: other.userId, role: 'landlord', email: 'x@t.dev', profileId: null, landlordIds: [other.landlordId], permissions: {} }),
    }
  } finally { c.release() }
}

/** A tenant named Zebulon Quixote on a unit, with a lease; returns ids. */
async function residentOn(unitId: string, landlordId: string, opts: { bookingType?: string } = {}) {
  const c = await db.connect()
  try {
    const tenantId = await seedTenant(c)
    await c.query(
      `UPDATE users SET first_name = $2, last_name = $3, email = $4, phone = $5
        WHERE id = (SELECT user_id FROM tenants WHERE id = $1)`,
      [tenantId, SECRET_FIRST, SECRET_LAST, `${SECRET_EMAIL_PART}.${randomUUID().slice(0, 6)}@test.dev`, SECRET_PHONE])
    const leaseId = await seedLease(c, { unitId, landlordId, rentAmount: 500 })
    await seedLeaseTenant(c, { leaseId, tenantId })
    if (opts.bookingType) {
      const b = await c.query<{ id: string }>(
        `INSERT INTO unit_bookings (unit_id, landlord_id, tenant_id, check_in, check_out, lease_type, status, guest_name)
         VALUES ($1, $2, $3, '2026-09-08', '2026-09-12', $4, 'checked_in', $5) RETURNING id`,
        [unitId, landlordId, tenantId, opts.bookingType, `${SECRET_FIRST} ${SECRET_LAST}`])
      await c.query(`UPDATE leases SET source_booking_id = $2 WHERE id = $1`, [leaseId, b.rows[0].id])
    }
    return { tenantId, leaseId }
  } finally { c.release() }
}

async function paid(o: { unitId: string; leaseId: string; tenantId: string; landlordId: string
  type: string; amount: number; at: string; entry?: string; notes?: string }) {
  await db.query(
    `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, entry_description,
                           due_date, settled_at, notes)
     VALUES ($1,$2,$3,$4,$5,$6,'settled',$7,$8::date,$8::timestamptz,$9)`,
    [o.unitId, o.leaseId, o.tenantId, o.landlordId, o.type, o.amount,
     o.entry ?? (o.type === 'rent' ? 'RENT' : o.type === 'utility' ? 'UTILITY' : 'OTHERFEE'), o.at, o.notes ?? null])
}

/** September money: MV park rent + electric + a nightly stay; Annex rent; Oak Park rent. */
async function september(w: World) {
  const mvRes = await residentOn(w.mvUnit, w.mv)
  await paid({ ...mvRes, unitId: w.mvUnit, landlordId: w.mv, type: 'rent', amount: 500, at: '2026-09-03T18:00:00Z' })
  await paid({ ...mvRes, unitId: w.mvUnit, landlordId: w.mv, type: 'utility', amount: 40, at: '2026-09-03T19:00:00Z',
    notes: 'Electric — Aug 2026 (190 kWh)' })
  const nightly = await residentOn(w.mvStayUnit, w.mv, { bookingType: 'nightly' })
  await paid({ ...nightly, unitId: w.mvStayUnit, landlordId: w.mv, type: 'rent', amount: 100, at: '2026-09-10T18:00:00Z' })
  const annex = await residentOn(w.annexUnit, w.mv)
  await paid({ ...annex, unitId: w.annexUnit, landlordId: w.mv, type: 'rent', amount: 300, at: '2026-10-02T18:00:00Z' })
  const opRes = await residentOn(w.opUnit, w.op)
  await paid({ ...opRes, unitId: w.opUnit, landlordId: w.op, type: 'rent', amount: 700, at: '2026-09-04T18:00:00Z' })
}

/**
 * 10/11 (Nic): nothing in a bookkeeper's answer reaches a person — no email,
 * phone number, address or date of birth, under any key, at any depth. Names
 * are allowed (who paid is half of keeping the books).
 */
function expectNoContact(body: unknown) {
  const s = JSON.stringify(body)
  expect(s).not.toContain(SECRET_EMAIL_PART)
  expect(s).not.toContain(SECRET_PHONE)
  expect(s).not.toMatch(/"[A-Za-z0-9_]*(email|phone|phoneNumber|phone_number|address)"\s*:/i)
  expect(s).not.toMatch(/"[A-Za-z0-9_]*(dateOfBirth|date_of_birth|dob|tenantUserId|tenant_user_id)"\s*:/i)
}

const app = () => buildApp()

// Receipt files this suite uploads (routes/expenses keeps them in
// <cwd>/uploads/expense-receipts); removed when the suite ends.
const uploaded: string[] = []
afterAll(() => {
  for (const u of uploaded) {
    try { fs.unlinkSync(path.join(process.cwd(), 'uploads', 'expense-receipts', path.basename(u))) } catch { /* already gone */ }
  }
})
const remember = (res: any) => { const u = res?.body?.data?.receipt_url ?? res?.body?.data?.receiptUrl; if (u) uploaded.push(u); return res }

describe('income pools — money in by type, by month and by day', () => {
  it("a Mountain View bookkeeper sees Mountain View's pools with correct totals and no one's contact details", async () => {
    const w = await world(); await september(w)
    const r = await request(app()).get('/api/financials/income?from=2026-09-01&to=2026-10-31').set('Authorization', `Bearer ${w.tokBk}`)
    expect(r.status).toBe(200)
    const d = r.body.data
    expect(d.total).toBe(940)                         // 500 + 40 + 100 + 300; never Oak Park's 700
    const pool = (k: string) => d.pools.find((p: any) => p.key === k)?.amount ?? 0
    expect(pool('monthly_rent')).toBe(800)
    expect(pool('nightly_stays')).toBe(100)
    expect(pool('electric')).toBe(40)
    expect(d.pools.find((p: any) => p.key === 'electric').label).toBe('Electric')
    expect(d.pools.find((p: any) => p.key === 'nightly_stays').label).toBe('Nightly stays')
    // By month.
    const sep = d.months.find((m: any) => m.month === '2026-09')
    const oct = d.months.find((m: any) => m.month === '2026-10')
    expect(sep.total).toBe(640)
    expect(oct.total).toBe(300)
    // By day (the property's calendar: Phoenix).
    const sep3 = d.days.find((x: any) => x.day === '2026-09-03')
    expect(sep3.total).toBe(540)
    expect(sep3.pools.find((p: any) => p.key === 'electric').amount).toBe(40)
    expect(d.days.reduce((s: number, x: any) => s + x.total, 0)).toBe(940)
    expectNoContact(r.body)
  })

  it("is the P&L's income total for the same days and properties", async () => {
    const w = await world(); await september(w)
    const r = await request(app()).get('/api/financials/income?from=2026-09-01&to=2026-09-30').set('Authorization', `Bearer ${w.tokBk}`)
    const t = await incomeTotals({ landlordIds: [w.mv], start: '2026-09-01', end: '2026-09-30', basis: 'received' })
    expect(r.body.data.total).toBe(t.total)
  })

  it('cannot read Oak Park, by property or otherwise', async () => {
    const w = await world(); await september(w)
    const r = await request(app()).get(`/api/financials/income?from=2026-09-01&to=2026-09-30&propertyId=${w.opPark}`).set('Authorization', `Bearer ${w.tokBk}`)
    expect(r.status).toBe(403)
    const scope = await request(app()).get('/api/financials/scope').set('Authorization', `Bearer ${w.tokBk}`)
    expect(scope.body.data.properties.map((p: any) => p.name).sort()).toEqual(['MV Annex', 'Mountain View'])
    expect(scope.body.data.companies.map((c: any) => c.name)).toEqual(['Mountain View LLC'])
    // 10/12 (Nic, ledger decision 2): one level — a bookkeeper removes expenses too.
    expect(scope.body.data.canRemoveExpenses).toBe(true)
  })

  it('a bookkeeper kept to one park sees that park only', async () => {
    const w = await world(); await september(w)
    const r = await request(app()).get('/api/financials/income?from=2026-09-01&to=2026-10-31').set('Authorization', `Bearer ${w.tokBkNarrow}`)
    expect(r.body.data.total).toBe(640)               // the Annex's 300 is not theirs
    const annex = await request(app()).get(`/api/financials/income?propertyId=${w.mvAnnex}`).set('Authorization', `Bearer ${w.tokBkNarrow}`)
    expect(annex.status).toBe(403)
    const scope = await request(app()).get('/api/financials/scope').set('Authorization', `Bearer ${w.tokBkNarrow}`)
    expect(scope.body.data.properties.map((p: any) => p.name)).toEqual(['Mountain View'])
    expect(scope.body.data.companyWide).toBe(false)
  })

  it('the owner reads the same page across both companies, or the one GAM Books has open', async () => {
    const w = await world(); await september(w)
    const all = await request(app()).get('/api/financials/income?from=2026-09-01&to=2026-10-31').set('Authorization', `Bearer ${w.owner}`)
    expect(all.body.data.total).toBe(1640)
    const mvOnly = await request(app()).get('/api/financials/income?from=2026-09-01&to=2026-10-31')
      .set('Authorization', `Bearer ${w.owner}`).set('X-Client-Id', w.mv)
    expect(mvOnly.body.data.total).toBe(940)
    const notTheirs = await request(app()).get('/api/financials/income').set('Authorization', `Bearer ${w.tokOtherOwner}`).set('X-Client-Id', w.mv)
    expect(notTheirs.status).toBe(403)
  })
})

describe('everything else a bookkeeper session could reach is refused', () => {
  const REFUSED: Array<[string, string]> = [
    ['get', '/api/tenants'], ['get', '/api/tenants/' + randomUUID()],
    ['get', '/api/leases'], ['get', '/api/leases/' + randomUUID()],
    ['get', '/api/documents'], ['get', '/api/esign/documents'], ['get', '/api/esign/landlord-pending'],
    ['get', '/api/bookings'], ['get', '/api/background/checks'],
    ['get', '/api/scopes/team'], ['post', '/api/scopes/bookkeeper/invite'],
    ['get', '/api/landlords/me'], ['patch', '/api/landlords/me'], ['get', '/api/landlords/me/entities'],
    ['get', '/api/payments'], ['post', '/api/payments/' + randomUUID() + '/record-manual'],
    ['get', '/api/balances'], ['get', '/api/maintenance'], ['get', '/api/maintenance/' + randomUUID()],
    ['get', '/api/notifications'], ['get', '/api/units'], ['get', '/api/properties'],
    // 10/12 (Nic, L19): bank lines are open with the company-wide box (below);
    // a tenant's payment never is.
    ['post', '/api/bank-feed/deposits/' + randomUUID() + '/confirm'], ['post', '/api/bank-feed/link-session'],
    // 10/12 (Nic, ledger decision 2): removing an expense is bookkeeping now
    // (below); a tenant's account never is.
    ['get', '/api/disbursements'], ['post', '/api/payments/' + randomUUID() + '/void'],
    ['get', '/api/reports/monthly-statement'], ['get', '/api/reports/tax-summary'],
    ['get', '/api/reports/work-trade-1099'], ['get', '/api/reports/query'], ['get', '/api/reports/t12'],
  ]
  for (const [method, path] of REFUSED) {
    it(`${method.toUpperCase()} ${path} → 403, in words`, async () => {
      const w = await world()
      const r = await (request(app()) as any)[method](path).set('Authorization', `Bearer ${w.tokBk}`).send({})
      expect(r.status).toBe(403)
      expect(r.body.error).toBe(BOOKKEEPER_REFUSAL)
    })
  }

  // 10/12 (Nic, L19): the bank lines follow the company-wide box — a
  // bookkeeper kept to a property is told so, in words.
  it('GET /api/bank-feed/transactions → the company-wide refusal for a property bookkeeper', async () => {
    const w = await world()
    const r = await request(app()).get('/api/bank-feed/transactions').set('Authorization', `Bearer ${w.tokBkNarrow}`)
    expect(r.status).toBe(403)
    expect(r.body.error).toMatch(/company-wide books/)
  })

  // 10/11 (Nic): names are allowed where the books need them, so the Books
  // rent roll is a bookkeeper's again — their properties, names in, contact out.
  it('the Books rent roll answers a bookkeeper: their properties, the tenant’s name, no email or phone', async () => {
    const w = await world(); await september(w)
    const r = await request(app()).get('/api/books/rent-roll').set('Authorization', `Bearer ${w.tokBk}`).set('X-Client-Id', w.mv)
    expect(r.status).toBe(200)
    expect(r.body.data.units.map((u: any) => u.property_name).sort()).toEqual(['MV Annex', 'Mountain View', 'Mountain View'])
    expect(r.body.data.units.some((u: any) => u.tenant_first === SECRET_FIRST && u.tenant_last === SECRET_LAST)).toBe(true)
    expectNoContact(r.body)
    const narrow = await request(app()).get('/api/books/rent-roll').set('Authorization', `Bearer ${w.tokBkNarrow}`).set('X-Client-Id', w.mv)
    expect(narrow.status).toBe(200)
    expect(new Set(narrow.body.data.units.map((u: any) => u.property_name))).toEqual(new Set(['Mountain View']))
    expectNoContact(narrow.body)
  })

  it('a bookkeeper whose access was removed loses it on the next request', async () => {
    const w = await world()
    const before = await request(app()).get('/api/financials/scope').set('Authorization', `Bearer ${w.tokBk}`)
    expect(before.status).toBe(200)
    await db.query(`DELETE FROM bookkeeper_scopes WHERE user_id = $1`, [w.bk])
    const after = await request(app()).get('/api/financials/scope').set('Authorization', `Bearer ${w.tokBk}`)
    expect(after.status).toBe(403)
  })

  it('naming a company they do not keep is refused', async () => {
    const w = await world()
    const r = await request(app()).get('/api/financials/scope').set('Authorization', `Bearer ${w.tokBk}`).set('X-Client-Id', w.op)
    expect(r.status).toBe(403)
  })
})

describe('expenses — full bookkeeping on the properties they keep (10/12, one level); receipts by row', () => {
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')

  it('adds an expense with a receipt on a unit, and one on the whole property', async () => {
    const w = await world()
    const onUnit = await request(app()).post('/api/expenses').set('Authorization', `Bearer ${w.tokBk}`)
      .send({ unitId: w.mvUnit, category: 'supplies', amount: 42.5, expenseDate: '2026-09-07', description: 'fuel for the mower' })
    expect(onUnit.status).toBe(200)
    expect(onUnit.body.data.landlord_id ?? onUnit.body.data.landlordId).toBe(w.mv)
    expect(onUnit.body.data.property_id ?? onUnit.body.data.propertyId).toBe(w.mvPark)
    const id = onUnit.body.data.id
    const up = await request(app()).post(`/api/expenses/${id}/receipt`).set('Authorization', `Bearer ${w.tokBk}`)
      .attach('receipt', png, { filename: 'fuel.png', contentType: 'image/png' })
    remember(up)
    expect(up.status).toBe(200)

    const common = await request(app()).post('/api/expenses').set('Authorization', `Bearer ${w.tokBk}`)
      .send({ propertyId: w.mvAnnex, isCommon: true, category: 'utilities', utilityType: 'electric', amount: 310, expenseDate: '2026-09-08' })
    expect(common.status).toBe(200)
    expect(common.body.data.is_common ?? common.body.data.isCommon).toBe(true)

    const list = await request(app()).get('/api/expenses').set('Authorization', `Bearer ${w.tokBk}`)
    const ids = list.body.data.map((e: any) => e.id)
    expect(ids).toEqual(expect.arrayContaining([id, common.body.data.id, w.ownerExpense]))
    expect(ids).not.toContain(w.opExpense)               // Oak Park's never shows
    const mine = list.body.data.find((e: any) => e.id === id)
    const owners = list.body.data.find((e: any) => e.id === w.ownerExpense)
    expect(mine.can_edit ?? mine.canEdit).toBe(true)
    // 10/12 (Nic, ledger decision 2): one level — the owner's expense on a park
    // they keep is theirs to correct and remove too (a read_only row decides nothing).
    expect(owners.can_edit ?? owners.canEdit).toBe(true)
    expect(mine.can_remove ?? mine.canRemove).toBe(true)
    expect(owners.can_remove ?? owners.canRemove).toBe(true)
  })

  it('cannot file an expense on Oak Park, nor on a park it does not keep', async () => {
    const w = await world()
    const op = await request(app()).post('/api/expenses').set('Authorization', `Bearer ${w.tokBk}`)
      .send({ unitId: w.opUnit, category: 'repairs', amount: 10, expenseDate: '2026-09-07' })
    expect(op.status).toBe(403)
    const annex = await request(app()).post('/api/expenses').set('Authorization', `Bearer ${w.tokBkNarrow}`)
      .send({ propertyId: w.mvAnnex, isCommon: true, category: 'repairs', amount: 10, expenseDate: '2026-09-07' })
    expect(annex.status).toBe(403)
    const companyWide = await request(app()).post('/api/expenses').set('Authorization', `Bearer ${w.tokBkNarrow}`)
      .send({ category: 'repairs', amount: 10, expenseDate: '2026-09-07' })
    expect(companyWide.status).toBe(400)
  })

  it('10/12: edits and removes any expense on a park it keeps — the owner’s too; never Oak Park’s, never onto a park it does not keep', async () => {
    const w = await world()
    const mine = (await request(app()).post('/api/expenses').set('Authorization', `Bearer ${w.tokBkNarrow}`)
      .send({ unitId: w.mvUnit, category: 'supplies', amount: 20, expenseDate: '2026-09-07' })).body.data.id
    const ok = await request(app()).patch(`/api/expenses/${mine}`).set('Authorization', `Bearer ${w.tokBkNarrow}`)
      .send({ amount: 25, vendor: 'Gas Stop' })
    expect(ok.status).toBe(200)
    expect(Number(ok.body.data.amount)).toBe(25)
    // 10/12 (Nic, ledger decision 2): full bookkeeping — the owner's expense on their park too.
    const owners = await request(app()).patch(`/api/expenses/${w.ownerExpense}`).set('Authorization', `Bearer ${w.tokBkNarrow}`).send({ amount: 1 })
    expect(owners.status).toBe(200)
    expect(Number(owners.body.data.amount)).toBe(1)
    const oak = await request(app()).patch(`/api/expenses/${w.opExpense}`).set('Authorization', `Bearer ${w.tokBk}`).send({ amount: 1 })
    expect(oak.status).toBe(404)
    const oakRemove = await request(app()).post(`/api/expenses/${w.opExpense}/void`).set('Authorization', `Bearer ${w.tokBk}`)
    expect(oakRemove.status).toBe(404)
    const move = await request(app()).patch(`/api/expenses/${mine}`).set('Authorization', `Bearer ${w.tokBkNarrow}`)
      .send({ propertyId: w.mvAnnex, unitId: null })
    expect(move.status).toBe(403)
    // An expense on a park the narrow bookkeeper does not keep reads as missing.
    const annexOne = (await request(app()).post('/api/expenses').set('Authorization', `Bearer ${w.tokBk}`)
      .send({ propertyId: w.mvAnnex, isCommon: true, category: 'repairs', amount: 15, expenseDate: '2026-09-07' })).body.data.id
    expect((await request(app()).post(`/api/expenses/${annexOne}/void`).set('Authorization', `Bearer ${w.tokBkNarrow}`)).status).toBe(404)
    const remove = await request(app()).post(`/api/expenses/${mine}/void`).set('Authorization', `Bearer ${w.tokBkNarrow}`)
    expect(remove.status).toBe(200)
    // Kept on record, voided.
    expect((await db.query(`SELECT status FROM landlord_expenses WHERE id = $1`, [mine])).rows[0].status).toBe('voided')
    // The owner still edits and removes theirs.
    const ownerEdit = await request(app()).patch(`/api/expenses/${w.ownerExpense}`).set('Authorization', `Bearer ${w.owner}`).send({ vendor: 'Pump Co.' })
    expect(ownerEdit.status).toBe(200)
  })

  it('a refused receipt upload leaves no file behind', async () => {
    const w = await world()
    const dir = path.join(process.cwd(), 'uploads', 'expense-receipts')
    const before = fs.existsSync(dir) ? fs.readdirSync(dir).length : 0
    // Oak Park's expense is not this bookkeeper's, nor (for the one kept to the
    // park) an expense on the annex. 10/12 (Nic, one level): the owner's
    // expense on a property they keep IS theirs to give a receipt.
    const annexExpense = (await db.query<{ id: string }>(
      `INSERT INTO landlord_expenses (landlord_id, created_by, property_id, category, amount, expense_date, is_common)
       VALUES ($1, $2, $3, 'repairs', 40, '2026-09-05', TRUE) RETURNING id`, [w.mv, w.ownerUserId, w.mvAnnex])).rows[0].id
    for (const [id, tok] of [[w.opExpense, w.tokBk], [annexExpense, w.tokBkNarrow]]) {
      const r = await request(app()).post(`/api/expenses/${id}/receipt`).set('Authorization', `Bearer ${tok}`)
        .attach('receipt', Buffer.from('89504e470d0a1a0a', 'hex'), { filename: 'x.png', contentType: 'image/png' })
      expect(r.status).toBe(404)
    }
    expect(fs.existsSync(dir) ? fs.readdirSync(dir).length : 0).toBe(before)
  })

  it('serves a receipt photo per row — to the bookkeeper who keeps it, to no one else', async () => {
    const w = await world()
    const onAnnex = (await request(app()).post('/api/expenses').set('Authorization', `Bearer ${w.tokBk}`)
      .send({ unitId: w.annexUnit, category: 'supplies', amount: 9, expenseDate: '2026-09-07' })).body.data.id
    const up = await request(app()).post(`/api/expenses/${onAnnex}/receipt`).set('Authorization', `Bearer ${w.tokBk}`)
      .attach('receipt', png, { filename: 'r.png', contentType: 'image/png' })
    remember(up)
    const url: string = up.body.data.receipt_url ?? up.body.data.receiptUrl
    expect(url).toMatch(/^\/api\/expenses\/receipt-files\//)
    expect((await request(app()).get(url).set('Authorization', `Bearer ${w.tokBk}`)).status).toBe(200)
    expect((await request(app()).get(url).set('Authorization', `Bearer ${w.owner}`)).status).toBe(200)
    expect((await request(app()).get(url).set('Authorization', `Bearer ${w.tokBkNarrow}`)).status).toBe(403)
    expect((await request(app()).get(url).set('Authorization', `Bearer ${w.tokOtherOwner}`)).status).toBe(403)
    // A receipt on Oak Park's expense is never a Mountain View bookkeeper's.
    const opUp = await request(app()).post(`/api/expenses/${w.opExpense}/receipt`).set('Authorization', `Bearer ${w.owner}`)
      .attach('receipt', png, { filename: 'op.png', contentType: 'image/png' })
    remember(opUp)
    const opUrl: string = opUp.body.data.receipt_url ?? opUp.body.data.receiptUrl
    expect((await request(app()).get(opUrl).set('Authorization', `Bearer ${w.tokBk}`)).status).toBe(403)
  })
})

describe('the financial scope never widens a bookkeeper by default', () => {
  it('a pass without their properties on it reads the scope row — a park-only bookkeeper stays on the park', async () => {
    const w = await world()
    const scope = await financialsScope({
      user: { userId: w.bkNarrow, role: 'bookkeeper', landlordId: w.mv, permissions: {} }, headers: {}, query: {},
    })
    expect(scope.propertyIds).toEqual([w.mvPark])
    expect(scope.narrowed).toBe(true)
    const whole = await financialsScope({
      user: { userId: w.bk, role: 'bookkeeper', landlordId: w.mv, permissions: {} }, headers: {}, query: {},
    })
    expect(whole.propertyIds).toBeNull()
  })
})

describe('maintenance costs — the cost, never the request', () => {
  it('returns amounts, days and kinds, without the request’s words (which name the tenant)', async () => {
    const w = await world()
    await residentOn(w.mvUnit, w.mv)
    await db.query(
      `INSERT INTO maintenance_requests (unit_id, landlord_id, title, description, category, status, actual_cost, completed_at)
       VALUES ($1, $2, $3, $4, 'plumbing', 'completed', 185.50, '2026-09-09T20:00:00Z'),
              ($5, $6, 'Oak Park roof', 'roof', 'roofing', 'completed', 999, '2026-09-09T20:00:00Z'),
              ($1, $2, 'No cost yet', 'n/a', 'general', 'completed', NULL, '2026-09-09T20:00:00Z')`,
      [w.mvUnit, w.mv, `Leaky faucet in ${SECRET_FIRST}'s bathroom`, `${SECRET_FIRST} ${SECRET_LAST} says it drips`, w.opUnit, w.op])
    const r = await request(app()).get('/api/financials/maintenance-costs?from=2026-09-01&to=2026-09-30').set('Authorization', `Bearer ${w.tokBk}`)
    expect(r.status).toBe(200)
    expect(r.body.data.total).toBe(185.5)
    expect(r.body.data.lines).toHaveLength(1)
    expect(r.body.data.lines[0]).toMatchObject({ day: '2026-09-09', categoryLabel: 'Plumbing', amount: 185.5, propertyName: 'Mountain View' })
    const s = JSON.stringify(r.body)
    expect(s).not.toContain('Leaky')
    expect(s).not.toContain('drips')
    expect(s).not.toContain('Oak Park')
    expect(s).not.toContain(SECRET_FIRST)          // only the request's words named them
    expectNoContact(r.body)
  })
})

describe('reports — the P&L, with who paid and no contact details', () => {
  it("the month's P&L reads Mountain View's money and who paid it, and no one's email or phone", async () => {
    const w = await world(); await september(w)
    const r = await request(app()).get('/api/reports/monthly-pl?year=2026&month=9').set('Authorization', `Bearer ${w.tokBk}`)
    expect(r.status).toBe(200)
    expect(r.body.data.gross.total).toBe(640)
    expect(r.body.data.payments.length).toBeGreaterThan(0)
    // 10/11 (Nic): who paid is half of keeping the books.
    for (const p of r.body.data.payments) {
      expect(p).toMatchObject({ tenantName: `${SECRET_FIRST} ${SECRET_LAST}`, tenantFirst: SECRET_FIRST, tenantLast: SECRET_LAST })
    }
    expectNoContact(r.body)
  })

  it('a property detail of Oak Park is not theirs; the narrowed bookkeeper gets its own park only', async () => {
    const w = await world(); await september(w)
    const oak = await request(app()).get(`/api/reports/property-detail?propertyId=${w.opPark}&year=2026&month=9`).set('Authorization', `Bearer ${w.tokBk}`)
    expect(oak.status).toBe(404)
    const annex = await request(app()).get(`/api/reports/property-detail?propertyId=${w.mvAnnex}&year=2026`).set('Authorization', `Bearer ${w.tokBkNarrow}`)
    expect(annex.status).toBe(404)
    const pl = await request(app()).get('/api/reports/property-pl?year=2026').set('Authorization', `Bearer ${w.tokBkNarrow}`)
    expect(pl.status).toBe(200)
    const names = JSON.stringify(pl.body)
    expect(names).not.toContain('MV Annex')
    expect(names).not.toContain('Oak Park')
    expectNoContact(pl.body)
  })

  it('a property detail gives a bookkeeper the rent roll with names, and maintenance costs by kind — never the request’s words', async () => {
    const w = await world(); await september(w)
    await db.query(
      `INSERT INTO maintenance_requests (unit_id, landlord_id, title, description, category, status, actual_cost, completed_at)
       VALUES ($1, $2, $3, 'drips', 'plumbing', 'completed', 185.50, '2026-09-09T20:00:00Z')`,
      [w.mvUnit, w.mv, `Leaky faucet in ${SECRET_FIRST}'s bathroom`])
    const r = await request(app()).get(`/api/reports/property-detail?propertyId=${w.mvPark}&year=2026&month=9`).set('Authorization', `Bearer ${w.tokBk}`)
    expect(r.status).toBe(200)
    // 10/11 (Nic): the park's rent roll — unit, status, rent, occupied and the
    // tenant's name. Nothing else rides on a row.
    expect(r.body.data.units).toHaveLength(2)
    for (const u of r.body.data.units) {
      expect(Object.keys(u).sort()).toEqual(['bathrooms', 'bedrooms', 'id', 'isOccupied', 'rent', 'status', 'tenantName', 'unitNumber'])
    }
    expect(r.body.data.units.find((u: any) => u.id === w.mvUnit)).toMatchObject({ isOccupied: true, tenantName: `${SECRET_FIRST} ${SECRET_LAST}` })
    expect(r.body.data.property.totalUnits).toBeGreaterThan(0)
    expect(r.body.data.maintenance).toHaveLength(1)
    expect(r.body.data.maintenance[0]).toMatchObject({ categoryLabel: 'Plumbing', actualCost: 185.5 })
    expect(r.body.data.maintenance[0]).not.toHaveProperty('title')
    expect(JSON.stringify(r.body)).not.toContain('Leaky')
    expectNoContact(r.body)
    // The owner reads the same rent roll, and keeps the request's words.
    const owner = await request(app()).get(`/api/reports/property-detail?propertyId=${w.mvPark}&year=2026&month=9`).set('Authorization', `Bearer ${w.owner}`)
    expect(owner.body.data.maintenance[0].title).toContain('Leaky')
    expect(owner.body.data.units).toEqual(r.body.data.units)
  })

  it('the By Property report sends only what its table shows — never the lease signer or office contact', async () => {
    const w = await world()
    await db.query(`UPDATE properties SET lease_signing_name = $2, lease_signing_email = 'signer@t.dev' WHERE id = $1`,
      [w.mvPark, `${SECRET_FIRST} ${SECRET_LAST}`])
    const r = await request(app()).get('/api/reports/property-pl?year=2026').set('Authorization', `Bearer ${w.tokBk}`)
    expect(r.status).toBe(200)
    for (const p of r.body.data.properties) {
      for (const k of Object.keys(p)) expect(k, k).not.toMatch(/signing|office|owner_user|managed_by|stripe/i)
    }
    expect(JSON.stringify(r.body)).not.toContain('signer@t.dev')
    expectNoContact(r.body)
  })

  it('the overview answers, with no one\'s contact details', async () => {
    const w = await world(); await september(w)
    const r = await request(app()).get('/api/reports/summary').set('Authorization', `Bearer ${w.tokBk}`)
    expect(r.status).toBe(200)
    expectNoContact(r.body)
  })
})

describe('bank activity and payouts — company-wide, read only', () => {
  // 10/11 (Nic): names are allowed where the books need them, and the payee on a
  // bank line is how it is reconciled — so a bookkeeper reads the bank's memo as
  // the owner does, with what it was filed as in its own column. Contact details
  // stay out: an email or phone number on a memo is taken out of their copy.
  it('a bookkeeper reads the bank memo as the owner does, and what it was filed as — never an email or phone number on it', async () => {
    const w = await world()
    const conn = (await db.query<{ id: string }>(
      `INSERT INTO bank_connections (landlord_id, display_name) VALUES ($1, 'MV Operating') RETURNING id`, [w.mv])).rows[0].id
    const pay = await residentOn(w.mvUnit, w.mv)
    const pid = (await db.query<{ id: string }>(
      `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, entry_description, due_date, settled_at)
       VALUES ($1,$2,$3,$4,'rent',500,'settled','RENT','2026-09-02','2026-09-02T18:00:00Z') RETURNING id`,
      [w.mvUnit, pay.leaseId, pay.tenantId, w.mv])).rows[0].id
    await db.query(
      `INSERT INTO bank_transactions (bank_connection_id, landlord_id, external_id, posted_date, amount, description, status, matched_payment_id)
       VALUES ($1, $2, 'a', '2026-09-02', 500, $3, 'matched', $4),
              ($1, $2, 'b', '2026-09-03', -25, 'HOME DEPOT #123', 'needs_review', NULL)`,
      [conn, w.mv, `ZELLE FROM ${SECRET_FIRST.toUpperCase()} ${SECRET_LAST.toUpperCase()}`, pid])
    // Money OUT names who was paid too — a deposit refund by Zelle — and a filed
    // one says what it was filed as beside its memo.
    await db.query(
      `INSERT INTO bank_transactions (bank_connection_id, landlord_id, external_id, posted_date, amount, description, normalized_merchant, status)
       VALUES ($1, $2, 'c', '2026-09-04', -150, $3, $3, 'needs_review')`,
      [conn, w.mv, `ZELLE PAYMENT TO ${SECRET_FIRST.toUpperCase()} ${SECRET_LAST.toUpperCase()}`])
    await db.query(
      `INSERT INTO bank_transactions (bank_connection_id, landlord_id, external_id, posted_date, amount, description, status, expense_id)
       VALUES ($1, $2, 'd', '2026-09-05', -120, $3, 'categorized', $4)`,
      [conn, w.mv, `CHECK 1042 ${SECRET_LAST.toUpperCase()}`, w.ownerExpense])
    // A Zelle memo can carry the phone number and email the money went to.
    await db.query(
      `INSERT INTO bank_transactions (bank_connection_id, landlord_id, external_id, posted_date, amount, description, status)
       VALUES ($1, $2, 'e', '2026-09-06', -10, 'ZELLE TO PAT 480-555-1234 pat.lee@example.com', 'needs_review')`,
      [conn, w.mv])
    const bk = await request(app()).get('/api/financials/bank-activity?from=2026-09-01&to=2026-09-30').set('Authorization', `Bearer ${w.tokBk}`)
    expect(bk.status).toBe(200)
    expect(bk.body.data.moneyIn).toBe(500)
    expect(bk.body.data.moneyOut).toBe(305)
    const name = `${SECRET_FIRST.toUpperCase()} ${SECRET_LAST.toUpperCase()}`
    const byDay = (body: any) => Object.fromEntries(body.data.transactions.map((t: any) => [t.day, t]))
    const b = byDay(bk.body)
    expect(b['2026-09-02']).toMatchObject({ description: `ZELLE FROM ${name}`, filedAs: 'Tenant’s bank deposit' })
    expect(b['2026-09-03']).toMatchObject({ description: 'HOME DEPOT #123', filedAs: null })
    expect(b['2026-09-04']).toMatchObject({ description: `ZELLE PAYMENT TO ${name}`, filedAs: null })
    expect(b['2026-09-05']).toMatchObject({ description: `CHECK 1042 ${SECRET_LAST.toUpperCase()}`, filedAs: 'Repairs' })
    expect(b['2026-09-06'].description).toBe('ZELLE TO PAT (phone hidden) (email hidden)')
    expect(JSON.stringify(bk.body)).not.toContain('480-555-1234')
    expect(JSON.stringify(bk.body)).not.toContain('pat.lee@example.com')
    const owner = await request(app()).get('/api/financials/bank-activity?from=2026-09-01&to=2026-09-30').set('Authorization', `Bearer ${w.owner}`)
    const o = byDay(owner.body)
    // The owner reads the same lines, and the contact details on them.
    for (const day of ['2026-09-02', '2026-09-03', '2026-09-04', '2026-09-05']) expect(o[day], day).toEqual(b[day])
    expect(o['2026-09-06'].description).toBe('ZELLE TO PAT 480-555-1234 pat.lee@example.com')
  })

  it('a bookkeeper without the company-wide box is told the bank and payouts are in it', async () => {
    const w = await world()
    const bank = await request(app()).get('/api/financials/bank-activity').set('Authorization', `Bearer ${w.tokBkNarrow}`)
    expect(bank.status).toBe(403)
    expect(bank.body.error).toMatch(/company-wide books/)
    const pay = await request(app()).get('/api/financials/payouts').set('Authorization', `Bearer ${w.tokBkNarrow}`)
    expect(pay.status).toBe(403)
  })

  it("payouts and GAM's charges are the company's, and name no one", async () => {
    const w = await world()
    await db.query(
      `INSERT INTO disbursements (user_id, landlord_id, amount, status, trigger_type, created_at)
       VALUES ($1, $2, 1200, 'settled', 'auto_friday', '2026-09-12T15:00:00Z'),
              ($1, $3, 5000, 'settled', 'auto_friday', '2026-09-12T15:00:00Z')`,
      [w.ownerUserId, w.mv, w.op])
    await db.query(
      `INSERT INTO landlord_gam_charges (landlord_id, property_id, kind, amount, source_type)
       VALUES ($1, $2, 'subscription', 24, 'platform_fee'), ($3, $4, 'subscription', 99, 'platform_fee')`,
      [w.mv, w.mvPark, w.op, w.opPark])
    const r = await request(app()).get('/api/financials/payouts').set('Authorization', `Bearer ${w.tokBk}`)
    expect(r.status).toBe(200)
    expect(r.body.data.payouts.map((p: any) => p.amount)).toEqual([1200])
    expect(r.body.data.gamCharges.map((c: any) => c.amount)).toEqual([24])
    expect(r.body.data.gamCharges[0].kindLabel).toBe('Platform fee')
    expect(JSON.stringify(r.body)).not.toMatch(/"(firstName|lastName|email)"/)
  })
})

describe('the Team page invite: a company, and its properties', () => {
  it('invites a bookkeeper to Mountain View narrowed to one park; accepting keeps the narrowing', async () => {
    const w = await world()
    const inv = await request(app()).post('/api/scopes/bookkeeper/invite').set('Authorization', `Bearer ${w.owner}`)
      .send({ landlordId: w.mv, email: `newbk-${randomUUID()}@test.dev`, firstName: 'New', lastName: 'Keeper',
              scope: { propertyIds: [w.mvPark] } })
    expect(inv.status).toBe(201)
    const tok = (await db.query<{ token: string }>(`SELECT token FROM invitations WHERE id = $1`, [inv.body.data.id])).rows[0].token
    const acc = await request(app()).post(`/api/invitations/${tok}/accept`).send({ password: 'a-long-password-1', firstName: 'New', lastName: 'Keeper' })
    expect(acc.status).toBe(200)
    const row = (await db.query<{ landlord_id: string; property_ids: string[] | null; access_level: string }>(
      `SELECT landlord_id, property_ids, access_level FROM bookkeeper_scopes WHERE user_id = $1`, [acc.body.data.userId])).rows[0]
    // 10/12 (Nic, ledger decision 2): one level — written 'read_write' (full bookkeeping).
    expect(row).toEqual({ landlord_id: w.mv, property_ids: [w.mvPark], access_level: 'read_write' })
  })

  it("refuses an Oak Park property on a Mountain View bookkeeper", async () => {
    const w = await world()
    const inv = await request(app()).post('/api/scopes/bookkeeper/invite').set('Authorization', `Bearer ${w.owner}`)
      .send({ landlordId: w.mv, email: `x-${randomUUID()}@test.dev`, scope: { propertyIds: [w.opPark] } })
    expect(inv.status).toBe(400)
  })

  it('the owner changes their properties and removes them', async () => {
    const w = await world()
    const ch = await request(app()).patch(`/api/scopes/bookkeeper/${w.bk}`).set('Authorization', `Bearer ${w.owner}`)
      .send({ landlordId: w.mv, propertyIds: [w.mvAnnex] })
    expect(ch.status).toBe(200)
    const narrowed = await request(app()).get('/api/financials/scope').set('Authorization', `Bearer ${w.tokBk}`)
    expect(narrowed.body.data.properties.map((p: any) => p.name)).toEqual(['MV Annex'])
    // 10/11: ticking nothing is refused, and the boxes stay as they were.
    // 10/12: "nothing" is no property AND no company-wide box.
    const none = await request(app()).patch(`/api/scopes/bookkeeper/${w.bk}`).set('Authorization', `Bearer ${w.owner}`)
      .send({ landlordId: w.mv, propertyIds: [], companyWide: false })
    expect(none.status).toBe(400)
    expect(none.body.error).toBe('Tick at least one property or Company-wide.')
    expect((await db.query(`SELECT property_ids FROM bookkeeper_scopes WHERE user_id = $1`, [w.bk])).rows[0].property_ids).toEqual([w.mvAnnex])
    const team = await request(app()).get('/api/scopes/team').set('Authorization', `Bearer ${w.owner}`)
    const member = team.body.data.members.find((m: any) => (m.user_id ?? m.userId) === w.bk)
    expect(member.scope).toMatchObject({ propertyIds: [w.mvAnnex], coversCompany: false })
    const del = await request(app()).delete(`/api/scopes/bookkeeper/${w.bk}?landlordId=${w.mv}`).set('Authorization', `Bearer ${w.owner}`)
    expect(del.status).toBe(200)
    expect((await request(app()).get('/api/financials/income').set('Authorization', `Bearer ${w.tokBk}`)).status).toBe(403)
  })
})

describe('GAM Books — the bookkeeper portal shows the same pages, for exactly their properties', () => {
  // Books names the open company on every request (X-Client-Id), as every
  // Books page does. Every shared page's endpoint, as Books calls it.
  const PAGES = [
    '/api/financials/scope', '/api/financials/units',
    '/api/financials/income?from=2026-09-01&to=2026-10-31',
    '/api/financials/maintenance-costs?from=2026-09-01&to=2026-10-31',
    '/api/financials/bank-activity?from=2026-09-01&to=2026-10-31', '/api/financials/payouts',
    '/api/expenses', '/api/reports/summary', '/api/reports/property-pl?year=2026',
    '/api/reports/monthly-pl?year=2026&month=9', '/api/reports/site-downtime?year=2026',
  ]

  it('a Mountain View bookkeeper never sees Oak Park on any page, nor anyone\'s contact details', async () => {
    const w = await world(); await september(w)
    for (const url of PAGES) {
      const r = await request(app()).get(url).set('Authorization', `Bearer ${w.tokBk}`).set('X-Client-Id', w.mv)
      expect(r.status, url).toBe(200)
      expect(JSON.stringify(r.body), url).not.toContain('Oak Park')
      // 10/12: Oak Park's 700 as an amount — never inside a random id or seeded
      // unit number (a uuid holding "700" made this fail at random).
      const money = JSON.stringify(r.body)
        .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '')
        .replace(/U-[0-9A-F]{6}/g, '')
      expect(money, url).not.toContain('700')
      expectNoContact(r.body)
    }
  })

  it('a bookkeeper kept to one park sees only it on every page that can be cut by property', async () => {
    const w = await world(); await september(w)
    for (const url of PAGES) {
      const r = await request(app()).get(url).set('Authorization', `Bearer ${w.tokBkNarrow}`).set('X-Client-Id', w.mv)
      if (url.includes('bank-activity') || url.includes('payouts')) { expect(r.status, url).toBe(403); continue }
      expect(r.status, url).toBe(200)
      expect(JSON.stringify(r.body), url).not.toContain('MV Annex')
      expect(JSON.stringify(r.body), url).not.toContain('Oak Park')
    }
  })

  it('a Books client they no longer keep refuses the pages but still lists their clients, so they can pick again', async () => {
    const w = await world()
    const stale = w.op   // Books remembers a company this bookkeeper does not keep
    const page = await request(app()).get('/api/financials/scope').set('Authorization', `Bearer ${w.tokBk}`).set('X-Client-Id', stale)
    expect(page.status).toBe(403)
    const clients = await request(app()).get('/api/books/bookkeeper/clients').set('Authorization', `Bearer ${w.tokBk}`).set('X-Client-Id', stale)
    expect(clients.status).toBe(200)
    expect(clients.body.data.map((c: any) => c.landlord_id ?? c.landlordId)).toEqual([w.mv])
  })

  it("a bookkeeper who keeps two clients' books sees the one Books has open", async () => {
    const w = await world(); await september(w)
    const c = await db.connect()
    let otherCompany: string
    try {
      const other = await seedLandlord(c)
      otherCompany = other.landlordId
      const park = await seedProperty(c, { landlordId: otherCompany, ownerUserId: other.userId, managedByUserId: other.userId })
      await c.query(`UPDATE properties SET name = 'Elsewhere Park' WHERE id = $1`, [park])
      await c.query(`INSERT INTO bookkeeper_scopes (user_id, landlord_id, access_level, property_ids) VALUES ($1, $2, 'read_only', $3)`,
        [w.bk, otherCompany, [park]])
    } finally { c.release() }
    const mv = await request(app()).get('/api/financials/scope').set('Authorization', `Bearer ${w.tokBk}`).set('X-Client-Id', w.mv)
    expect(mv.body.data.properties.map((p: any) => p.name).sort()).toEqual(['MV Annex', 'Mountain View'])
    const other = await request(app()).get('/api/financials/scope').set('Authorization', `Bearer ${w.tokBk}`).set('X-Client-Id', otherCompany!)
    expect(other.body.data.properties.map((p: any) => p.name)).toEqual(['Elsewhere Park'])
    const income = await request(app()).get('/api/financials/income?from=2026-09-01&to=2026-10-31')
      .set('Authorization', `Bearer ${w.tokBk}`).set('X-Client-Id', otherCompany!)
    expect(income.body.data.total).toBe(0)
  })
})
