/**
 * 10/12 (Nic) — "A/R totals visible to bookkeepers."
 *
 * decisions #25 kept a grand total of what everyone owes from everyone but the
 * account owner and property managers (services/openBalances seesGrandTotals).
 * A bookkeeper now sees it too — over THEIR properties only, and for a
 * property the company sold, only its bills due by the day it left (the clean
 * cut at a sale). The figure a bookkeeper can open is the Reports overview's
 * Outstanding Balance (GET /api/reports/summary).
 *
 * The world: Canyon LLC owns Alder and Birch; Delta LLC (the same owner) buys
 * Alder on 9/20. Open bills: Alder $300 due 9/15 and $400 due 9/25, Birch $200
 * due 9/10. Al keeps Alder; Bea keeps Alder, Birch and the company-wide box;
 * Cara keeps the company-wide box only.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { randomUUID } from 'crypto'
import { db } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedTenant, seedLease, seedLeaseTenant } from '../test/dbHelpers'
import { errorHandler } from '../middleware/errorHandler'
import { reportsRouter } from './reports'
import { transferProperty } from '../services/propertyTransfer'

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/reports', reportsRouter)
  app.use(errorHandler)
  return app
}
const sign = (p: object) => jwt.sign(p, process.env.JWT_SECRET!, { expiresIn: '1h' })

beforeEach(async () => {
  await cleanupAllSchema()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_bookkeeper_grand_totals'
})

async function bookkeeper(first: string, landlordId: string, propertyIds: string[], companyWide: boolean): Promise<string> {
  const userId = (await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
     VALUES ($1, 'x', 'bookkeeper', $2, 'Keeper', TRUE) RETURNING id`, [`${first.toLowerCase()}-${randomUUID()}@test.dev`, first])).rows[0].id
  await db.query(`INSERT INTO bookkeeper_scopes (user_id, landlord_id, property_ids, company_wide) VALUES ($1, $2, $3, $4)`,
    [userId, landlordId, propertyIds, companyWide])
  return sign({ userId, role: 'bookkeeper', email: 'bk@t.dev', profileId: null, landlordId, permissions: { access_level: 'read_only' } })
}

/**
 * An open bill on a space: an invoice due `due` with nothing paid on it, AND
 * the rent charge that is its line — the real shape, where the bill is the
 * cover and the payments rows are what is owed on it. 10/18: the Outstanding
 * Balance reads those rows (lib/rentCollected outstandingBalanceOf), so a bill
 * with no lines owes nothing, here as in production.
 */
async function openBill(unitId: string, landlordId: string, amount: number, due: string) {
  const c = await db.connect()
  try {
    const tenantId = await seedTenant(c)
    const leaseId = await seedLease(c, { unitId, landlordId, rentAmount: amount })
    await seedLeaseTenant(c, { leaseId, tenantId })
    const invoiceId = (await c.query<{ id: string }>(
      `INSERT INTO invoices (landlord_id, tenant_id, lease_id, unit_id, invoice_number, due_date, subtotal_rent, total_amount, status)
       VALUES ($1,$2,$3,$4,$5,$6::date,$7,$7,'pending') RETURNING id`,
      [landlordId, tenantId, leaseId, unitId, `INV-${randomUUID().slice(0, 8)}`, due, amount])).rows[0].id
    await c.query(
      `INSERT INTO payments (invoice_id, unit_id, lease_id, tenant_id, landlord_id, type, amount, status,
                             due_date, entry_description)
       VALUES ($1,$2,$3,$4,$5,'rent',$6,'pending',$7::date,'RENT')`,
      [invoiceId, unitId, leaseId, tenantId, landlordId, amount, due])
  } finally { c.release() }
}

async function world() {
  const c = await db.connect()
  let base: { ownerUserId: string; canyon: string; delta: string; alder: string; birch: string; alderUnit: string; birchUnit: string }
  try {
    const { userId: ownerUserId, landlordId: canyon } = await seedLandlord(c)
    const delta = (await c.query<{ id: string }>(
      `INSERT INTO landlords (user_id, billing_starts_at, business_name) VALUES ($1, DATE '2000-01-01', 'Delta LLC') RETURNING id`,
      [ownerUserId])).rows[0].id
    const alder = await seedProperty(c, { landlordId: canyon, ownerUserId, managedByUserId: ownerUserId })
    const birch = await seedProperty(c, { landlordId: canyon, ownerUserId, managedByUserId: ownerUserId })
    await c.query(`UPDATE properties SET timezone = 'America/Phoenix' WHERE id = ANY($1::uuid[])`, [[alder, birch]])
    const alderUnit = await seedUnit(c, { propertyId: alder, landlordId: canyon })
    const birchUnit = await seedUnit(c, { propertyId: birch, landlordId: canyon })
    base = { ownerUserId, canyon, delta, alder, birch, alderUnit, birchUnit }
  } finally { c.release() }
  await openBill(base.alderUnit, base.canyon, 300, '2026-09-15')
  await openBill(base.alderUnit, base.canyon, 400, '2026-09-25')
  await openBill(base.birchUnit, base.canyon, 200, '2026-09-10')
  return {
    ...base,
    owner: sign({ userId: base.ownerUserId, role: 'landlord', email: 'o@t.dev', profileId: null, landlordIds: [base.canyon, base.delta], permissions: {} }),
    al: await bookkeeper('Al', base.canyon, [base.alder], false),
    bea: await bookkeeper('Bea', base.canyon, [base.alder, base.birch], true),
    cara: await bookkeeper('Cara', base.canyon, [], true),
  }
}

/** Alder is sold to Delta, the sale dated 9/20 noon Phoenix (transferProperty stamps now). */
async function sellAlder(w: Awaited<ReturnType<typeof world>>) {
  const t = await transferProperty({ propertyId: w.alder, fromLandlordId: w.canyon, toLandlordId: w.delta, byUserId: w.ownerUserId })
  await db.query(`UPDATE property_transfers SET transferred_at = '2026-09-20T19:00:00Z' WHERE id = $1`, [t.transferId])
  await db.query(`UPDATE bookkeeper_former_properties SET left_at = '2026-09-20T19:00:00Z' WHERE property_transfer_id = $1`, [t.transferId])
}

const outstanding = async (token: string) => {
  const r = await request(buildApp()).get('/api/reports/summary').set('Authorization', `Bearer ${token}`)
  expect(r.status, JSON.stringify(r.body)).toBe(200)
  return r.body.data.outstanding as number | undefined
}

describe('10/12 (Nic): A/R totals visible to bookkeepers — over their own properties', () => {
  it('a bookkeeper sees the Outstanding Balance of the properties they keep, never the others', async () => {
    const w = await world()
    expect(await outstanding(w.owner)).toBe(900)
    expect(await outstanding(w.al)).toBe(700)     // Alder only
    expect(await outstanding(w.bea)).toBe(900)    // Alder and Birch
    // The company-wide box opens the bank, payouts and payroll — no property's
    // money. 10/12 (Nic): no "$0" card that says nobody owes anything — the
    // card is left out for them.
    expect(await outstanding(w.cara)).toBeUndefined()
  })

  it('a sold property counts only its bills due by the day it left (the clean cut)', async () => {
    const w = await world()
    await sellAlder(w)
    expect(await outstanding(w.al)).toBe(300)     // the 9/25 bill is after the sale
    expect(await outstanding(w.bea)).toBe(500)    // Alder's 9/15 bill and Birch's
    // The owner's books keep every bill the company wrote.
    expect(await outstanding(w.owner)).toBe(900)
  })

  it('front desk staff still never get the total (decisions #25)', async () => {
    const w = await world()
    const u = (await db.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
       VALUES ($1,'x','onsite_manager','Desk','Staff',TRUE) RETURNING id`, [`desk-${randomUUID()}@t.dev`])).rows[0].id
    await db.query(`INSERT INTO onsite_manager_scopes (user_id, landlord_id, all_properties, property_ids) VALUES ($1,$2,TRUE,'{}')`, [u, w.canyon])
    const desk = sign({ userId: u, role: 'onsite_manager', email: 'desk@t.dev', profileId: null, landlordId: w.canyon, permissions: { 'payments.view_all': true } })
    expect(await outstanding(desk)).toBeUndefined()

    // The Owed column is the same kind of total (what is still owed of every
    // household's bills): left out of the overview, the per-property P&L and
    // the report engine for the desk, and kept for the owner.
    const summary = async (token: string) => {
      const r = await request(buildApp()).get('/api/reports/summary').set('Authorization', `Bearer ${token}`)
      expect(r.status, JSON.stringify(r.body)).toBe(200)
      return r.body.data
    }
    const d = await summary(desk)
    expect(d.ytd.owed).toBeUndefined()
    expect(d.thisMonth.owed).toBeUndefined()
    expect(d.thisMonth.collected).toBeUndefined()
    expect(d.monthly.length).toBeGreaterThan(0)
    expect(d.monthly.every((m: any) => !('owed' in m))).toBe(true)
    expect(d.ytdMonthly.every((m: any) => !('owed' in m))).toBe(true)
    expect(d.incomeCard.billed.stillOwed).toBeUndefined()
    expect(d.thisMonth.tieText.join(' ')).not.toMatch(/owed/i)
    const o = await summary(w.owner)
    expect(typeof o.ytd.owed).toBe('number')
    expect(typeof o.thisMonth.owed).toBe('number')
    expect(o.monthly.every((m: any) => typeof m.owed === 'number')).toBe(true)

    const ppl = await request(buildApp()).get('/api/reports/property-pl?year=2026&month=9').set('Authorization', `Bearer ${desk}`)
    expect(ppl.status, JSON.stringify(ppl.body)).toBe(200)
    expect(ppl.body.data.properties.length).toBeGreaterThan(0)
    expect(ppl.body.data.properties.every((p: any) => !('owed' in p))).toBe(true)
    const q = await request(buildApp()).get('/api/reports/query?start=2026-09-01&end=2026-09-30&level=property&bucket=total')
      .set('Authorization', `Bearer ${desk}`)
    expect(q.status, JSON.stringify(q.body)).toBe(200)
    expect(q.body.data.totals.money.owed).toBeUndefined()
    const qo = await request(buildApp()).get('/api/reports/query?start=2026-09-01&end=2026-09-30&level=property&bucket=total')
      .set('Authorization', `Bearer ${w.owner}`)
    expect(typeof qo.body.data.totals.money.owed).toBe('number')
  })
})
