/**
 * 10/13 (Nic) — the Rent Roll without the moved-out setting, imported payment
 * history, the onboarding month, two companies on one bill and a property sold
 * out of the account, through the routes.
 *
 *   "Remove the 'keep moved-out households' setting entirely. Rent Roll =
 *    current residents + a collapsed 'Moved out, still owes' folder until
 *    paid." (10/13 answers; replaces 10/12's "who stays on the Rent Roll after
 *    moving out = LANDLORD'S CHOICE")
 *   "CSV-imported old payment history does NOT count toward payment health —
 *    health starts with the first bill GAM wrote; imported history still shows
 *    in the report." (10/12)
 *   The onboarding month is the first rent GAM wrote — never a voided line.
 */
import { randomUUID } from 'crypto'
import { describe, it, expect, beforeEach } from 'vitest'
import request from 'supertest'
import express from 'express'
import jwt from 'jsonwebtoken'
import { db } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedLease, seedTenant, seedLeaseTenant } from '../test/dbHelpers'
import { balancesRouter } from './balances'
import { tenantsRouter } from './tenants'
import { errorHandler } from '../middleware/errorHandler'
import { currentBillMonth, addMonths, importedNoteParts, importedFromLabel } from '../services/householdMonths'

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret'

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/balances', balancesRouter)
  app.use('/api/tenants', tenantsRouter)
  app.use(errorHandler)
  return app
}

beforeEach(cleanupAllSchema)

const THIS = currentBillMonth()
const LAST = addMonths(THIS, -1)

async function park(name = 'Mountain View RV Ranch', company = 'Mountain View LLC') {
  const c = await db.connect()
  try {
    const ll = await seedLandlord(c)
    await c.query(`UPDATE landlords SET business_name = $2 WHERE id = $1`, [ll.landlordId, company])
    const propertyId = await seedProperty(c, { landlordId: ll.landlordId, ownerUserId: ll.userId, managedByUserId: ll.userId })
    await c.query(`UPDATE properties SET name = $2, timezone = 'America/Phoenix', late_fee_grace_days = 5 WHERE id = $1`, [propertyId, name])
    return { ...ll, propertyId }
  } finally { c.release() }
}

interface Hh { unitId: string; leaseId: string; tenantId: string }

async function household(p: { landlordId: string; propertyId: string }, unitNumber: string, name: string,
                         o: { movedOut?: boolean; existingTenancy?: boolean } = {}): Promise<Hh> {
  const c = await db.connect()
  try {
    const unitId = await seedUnit(c, { propertyId: p.propertyId, landlordId: p.landlordId, rentAmount: 495 })
    await c.query(`UPDATE units SET unit_number = $2 WHERE id = $1`, [unitId, unitNumber])
    const leaseId = await seedLease(c, { unitId, landlordId: p.landlordId, rentAmount: 495, startDate: '2024-01-01' })
    if (o.movedOut) await c.query(`UPDATE leases SET status = 'expired' WHERE id = $1`, [leaseId])
    if (o.existingTenancy) await c.query(`UPDATE leases SET is_existing_tenancy = TRUE WHERE id = $1`, [leaseId])
    const tenantId = await seedTenant(c)
    const [first, last] = name.split(' ')
    await c.query(`UPDATE users SET first_name = $2, last_name = $3 WHERE id = (SELECT user_id FROM tenants WHERE id = $1)`, [tenantId, first, last])
    await seedLeaseTenant(c, { leaseId, tenantId, role: 'primary' })
    return { unitId, leaseId, tenantId }
  } finally { c.release() }
}

/** A bill due the 1st of `month`, written that day; `paidDay` settles it in cash on that day of the month. */
async function rent(p: { landlordId: string }, h: Hh, month: string, amount: number, paidDay?: number) {
  const inv = (await db.query<{ id: string }>(
    `INSERT INTO invoices (landlord_id, tenant_id, lease_id, unit_id, invoice_number, due_date, total_amount, status, created_at)
     VALUES ($1,$2,$3,$4,$5,$6::date,$7,'pending',$6::date) RETURNING id`,
    [p.landlordId, h.tenantId, h.leaseId, h.unitId, `INV-${randomUUID().slice(0, 8)}`, `${month}-01`, amount])).rows[0].id
  await db.query(
    `INSERT INTO payments (invoice_id, unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description,
                           created_at, settled_at, manual_method)
     VALUES ($1,$2,$3,$4,$5,'rent',$6,$7,$8::date,'RENT',$8::date,
             CASE WHEN $9::int IS NULL THEN NULL ELSE ($8::date + ($9::int - 1) * interval '1 day' + interval '19 hours') END,
             CASE WHEN $9::int IS NULL THEN NULL ELSE 'cash' END)`,
    [inv, h.unitId, h.leaseId, h.tenantId, p.landlordId, amount, paidDay ? 'settled' : 'pending', `${month}-01`, paidDay ?? null])
  return inv
}

/** A payment the payment-history CSV import wrote (routes/landlords onboard-payment-history-csv/commit). */
async function imported(p: { landlordId: string }, h: Hh, day: string, amount: number, source: string, notes: string) {
  await db.query(
    `INSERT INTO payments (landlord_id, tenant_id, lease_id, unit_id, type, entry_description, amount, status,
                           due_date, settled_at, processed_at, notes, import_source, imported_at)
     VALUES ($1,$2,$3,$4,'rent','RENT',$5,'settled',$6::date,$6::date,$6::date,$7,$8,NOW())`,
    [p.landlordId, h.tenantId, h.leaseId, h.unitId, amount, day, notes, source])
}

const ownerToken = (f: { userId: string }, landlordIds: string[]) => jwt.sign(
  { userId: f.userId, role: 'landlord', email: 'll@t.dev', profileId: null, landlordIds, permissions: {} },
  process.env.JWT_SECRET!, { expiresIn: '10m' })

const get = (token: string, path: string) => request(buildApp()).get(path).set('Authorization', `Bearer ${token}`)
const history = (token: string, propertyId: string, q: string) => get(token, `/api/balances/rent-roll/history?propertyId=${propertyId}&${q}`)
const names = (rows: any[]) => rows.map((r: any) => r.residents[0]?.name).sort()

describe('no moved-out setting: current residents, and "Moved out, still owes" until paid', () => {
  it('the company\'s old setting decides nothing any more', async () => {
    const p = await park()
    const owner = ownerToken(p, [p.landlordId])
    await rent(p, await household(p, 'RV 10', 'Lena Living'), THIS, 495, 2)
    const gone = await household(p, 'RV 30', 'Gus Gone', { movedOut: true })
    await rent(p, gone, addMonths(THIS, -13), 495, 2)                   // moved out over a year ago, paid
    const owes = await household(p, 'RV 40', 'Owen Owes', { movedOut: true })
    await rent(p, owes, addMonths(THIS, -14), 495)                      // moved out over a year ago, still owes
    const before = (await history(owner, p.propertyId, `from=${THIS}&to=${THIS}`)).body.data
    // The column is left in place (expand, then contract) — and read by nothing.
    for (const rule of ['all_time', 'while_owing', 'billed_last_12_months']) {
      await db.query(`UPDATE landlords SET rent_roll_moved_out = $2 WHERE id = $1`, [p.landlordId, rule])
      const d = (await history(owner, p.propertyId, `from=${THIS}&to=${THIS}`)).body.data
      expect(d).toEqual(before)
    }
    expect(names(before.rows)).toEqual(['Lena Living'])
    expect(names(before.movedOutOwing)).toEqual(['Owen Owes'])
    // A staff member sees exactly the same.
    const u = await db.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
       VALUES ($1,'x','property_manager','Team','Member',TRUE) RETURNING id`, [`pm-${randomUUID()}@t.dev`])
    await db.query(`INSERT INTO property_manager_scopes (user_id, landlord_id, all_properties, property_ids) VALUES ($1,$2,TRUE,'{}')`,
      [u.rows[0].id, p.landlordId])
    const staff = jwt.sign({ userId: u.rows[0].id, role: 'property_manager', email: 'pm@t.dev', profileId: null, landlordId: p.landlordId,
      permissions: { 'payments.view_all': true } }, process.env.JWT_SECRET!, { expiresIn: '10m' })
    const seen = (await history(staff, p.propertyId, `from=${THIS}&to=${THIS}`)).body.data
    expect(names(seen.rows)).toEqual(['Lena Living'])
    expect(names(seen.movedOutOwing)).toEqual(['Owen Owes'])
  })

  it('a property sold out of the account: the seller still finds its own old bills on the Rent Roll, and no open month', async () => {
    const p = await park('Alder Park', 'Seller LLC')
    const owner = ownerToken(p, [p.landlordId])
    const sam = await household(p, 'RV 1', 'Sam Sold', { movedOut: true })
    await rent(p, sam, addMonths(THIS, -20), 495)
    // Alder is transferred to another account's company (properties are never deleted).
    const buyer = await park('Buyer Home', 'Buyer LLC')
    await db.query(`UPDATE properties SET landlord_id = $2 WHERE id = $1`, [p.propertyId, buyer.landlordId])
    await db.query(`UPDATE units SET landlord_id = $2 WHERE property_id = $1`, [p.propertyId, buyer.landlordId])
    const picker = (await get(owner, '/api/balances/rent-roll/properties')).body.data
    expect(picker).toEqual([expect.objectContaining({ propertyId: p.propertyId, name: 'Alder Park', owned: false })])
    const d = (await history(owner, p.propertyId, 'range=all')).body.data
    // Sam moved out still owing: the "Moved out, still owes" folder holds him,
    // and only it (10/13, Nic) — never a row as well.
    expect(d.rows).toEqual([])
    expect(names(d.movedOutOwing)).toEqual(['Sam Sold'])
    expect((await get(owner, `/api/balances/rent-roll/open-month?propertyId=${p.propertyId}`)).status).toBe(404)
    // The buyer never sees the seller's bills.
    const buyerSees = (await history(ownerToken(buyer, [buyer.landlordId]), p.propertyId, 'range=all')).body.data
    expect(buyerSees.rows).toEqual([])
    expect(buyerSees.movedOutOwing).toEqual([])
  })

  it('one lease billed by two of the account\'s companies in the same month: one household, the months add up', async () => {
    const a = await park('Alpha Park', 'Alpha LLC')
    const bId = (await db.query<{ id: string }>(
      `INSERT INTO landlords (user_id, business_name, billing_starts_at) VALUES ($1, 'Bravo LLC', DATE '2000-01-01') RETURNING id`, [a.userId])).rows[0].id
    const h = await household(a, 'A1', 'Hal Both')
    const inv = await rent(a, h, THIS, 495, 2)
    // A neighbor company's charge on the household's bill (S616), and one on no bill.
    await db.query(
      `INSERT INTO payments (invoice_id, unit_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description, created_at)
       VALUES ($1,$2,$3,$4,'fee',30,'pending',$5::date,'OTHERFEE',$5::date)`, [inv, h.unitId, h.tenantId, bId, `${THIS}-01`])
    await db.query(
      `INSERT INTO payments (unit_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description, created_at)
       VALUES ($1,$2,$3,'fee',20,'pending',$4::date,'OTHERFEE',$4::date)`, [h.unitId, h.tenantId, a.landlordId, `${THIS}-01`])
    const d = (await history(ownerToken(a, [a.landlordId, bId]), a.propertyId, `from=${THIS}&to=${THIS}`)).body.data
    expect(d.rows).toHaveLength(1)
    expect(d.rows[0]).toMatchObject({ leaseId: h.leaseId, invoiced: 545, paid: 495, owed: 50 })
    expect(d.totals).toMatchObject({ invoiced: 545, owed: 50 })
  })
})

describe('imported payment history: shown in the report, never counted', () => {
  it('health, the strip, the onboarding month and the history start with the first bill GAM wrote; the report lists the import, labeled', async () => {
    const p = await park()
    const owner = ownerToken(p, [p.landlordId])
    const h = await household(p, 'RV 7', 'Ivy Import', { existingTenancy: true })
    const before = addMonths(LAST, -3)
    await imported(p, h, `${before}-14`, 495, 'buildium', 'Imported from buildium. method: Check | ref: 1042')
    await imported(p, h, `${addMonths(LAST, -2)}-01`, 495, 'generic', 'Imported from generic.')
    await rent(p, h, LAST, 495, 12)     // the first bill GAM wrote — the onboarding month, paid late
    await rent(p, h, THIS, 495, 2)      // on time

    const rep = await get(owner, `/api/tenants/${h.tenantId}/payment-report`)
    expect(rep.status, JSON.stringify(rep.body)).toBe(200)
    const r = rep.body.data
    expect(r.on_gam_since).toBe(LAST)
    expect(r.onboarding_month).toBe(LAST)
    // The onboarding month is good news only: paid late, it is left out. The imports never count.
    expect(r.health).toMatchObject({ percent: 100, on_time: 1, counted: 1, from: LAST })
    expect(r.stamps.map((s: any) => s.month)).toEqual([LAST, THIS])
    expect(r.history).toHaveLength(2)
    expect(r.history.every((l: any) => l.month >= LAST)).toBe(true)
    expect(r.imported).toEqual([
      expect.objectContaining({ paid_on: `${addMonths(LAST, -2)}-01`, label: 'Rent', amount: 495, imported_from: 'your previous software', method: null, reference: null }),
      expect.objectContaining({ paid_on: `${before}-14`, label: 'Rent', amount: 495, imported_from: 'Buildium', method: 'Check', reference: '1042', unit_number: 'RV 7' }),
    ])

    // The Rent Roll, all time: from the first bill GAM wrote — the imports are no month.
    const d = (await history(owner, p.propertyId, 'range=all')).body.data
    expect(d).toMatchObject({ from: LAST, to: THIS, months: [LAST, THIS] })
    const row = d.rows.find((x: any) => x.householdId === h.tenantId)
    expect(row.health).toMatchObject({ percent: 100, counted: 1 })
    expect(row.stamps.map((s: any) => s.month)).toEqual([LAST, THIS])
    expect(row.stamps[0]).toMatchObject({ status: 'paid_late', onboarding: true })
    expect(row).toMatchObject({ invoiced: 990, paid: 990, owed: 0 })
  })

  it('the import\'s note in words', () => {
    expect(importedNoteParts('Imported from yardi. method: Money order | ref: A-7')).toEqual({ method: 'Money order', reference: 'A-7' })
    expect(importedNoteParts('Imported from yardi. ref: 99')).toEqual({ method: null, reference: '99' })
    expect(importedNoteParts(null)).toEqual({ method: null, reference: null })
    expect(importedFromLabel('appfolio')).toBe('AppFolio')
    expect(importedFromLabel('generic')).toBe('your previous software')
    expect(importedFromLabel('nobody')).toBe('your previous software')
  })
})

describe('the onboarding month is the first rent GAM wrote', () => {
  it('a voided rent line never moves it back', async () => {
    const p = await park()
    const owner = ownerToken(p, [p.landlordId])
    const h = await household(p, 'RV 9', 'Vera Void', { existingTenancy: true })
    // A first bill thrown away (voided) two months back.
    await db.query(
      `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description, created_at,
                             voided_at, void_reason)
       VALUES ($1,$2,$3,$4,'rent',495,'voided',$5::date,'RENT',$5::date,$5::date + interval '2 days','Written by mistake')`,
      [h.unitId, h.leaseId, h.tenantId, p.landlordId, `${addMonths(LAST, -1)}-01`])
    await rent(p, h, LAST, 495, 12)     // the real first bill: onboarding, paid late — left out
    await rent(p, h, THIS, 495, 2)
    const r = (await get(owner, `/api/tenants/${h.tenantId}/payment-report`)).body.data
    expect(r.onboarding_month).toBe(LAST)
    expect(r.health).toMatchObject({ percent: 100, on_time: 1, counted: 1 })
  })
})
