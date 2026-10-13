/**
 * S637 — filtering the dashboard to one property.
 *
 * Nic: "I need to be able to filter from the dashboard to see what other
 * co-owners are seeing. Right now, all properties are blended on the
 * dashboard. And when a co-owner only sees one property because they don't
 * own all the properties together with me, they're seeing different
 * information on the cards."
 *
 * The one that matters most is the last: propertyId arrives in a query
 * string, and an unchecked one would read another landlord's portfolio
 * through an endpoint that has already passed its auth check.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { randomUUID } from 'crypto'
import { db } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedLease } from '../test/dbHelpers'
// The camelCase middleware lives in index.ts, not on the router — a test
// harness mounting the router alone sees the raw snake_case columns.
import { landlordsRouter } from './landlords'
import { errorHandler } from '../middleware/errorHandler'

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/landlords', landlordsRouter)
  app.use(errorHandler)
  return app
}

const SECRET = 'test_jwt_secret_dashfilter'
let token: string, propA: string, propB: string, otherProp: string

beforeEach(async () => {
  await cleanupAllSchema()
  process.env.JWT_SECRET = SECRET
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const me = await seedLandlord(c)
    propA = await seedProperty(c, { landlordId: me.landlordId, ownerUserId: me.userId, managedByUserId: me.userId })
    propB = await seedProperty(c, { landlordId: me.landlordId, ownerUserId: me.userId, managedByUserId: me.userId })
    // Two occupied units on A, one on B — so a filter changes the numbers.
    // 10/12 (Nic): Expected Monthly Rent is the rent the active LEASES bill.
    for (const rent of [500, 700]) {
      const u = await seedUnit(c, { propertyId: propA, landlordId: me.landlordId })
      await c.query(`UPDATE units SET status='active', rent_amount=$2 WHERE id=$1`, [u, rent])
      await seedLease(c, { unitId: u, landlordId: me.landlordId, rentAmount: rent })
    }
    const ub = await seedUnit(c, { propertyId: propB, landlordId: me.landlordId })
    await c.query(`UPDATE units SET status='active', rent_amount=300 WHERE id=$1`, [ub])
    await seedLease(c, { unitId: ub, landlordId: me.landlordId, rentAmount: 300 })

    const other = await seedLandlord(c)
    otherProp = await seedProperty(c, { landlordId: other.landlordId, ownerUserId: other.userId, managedByUserId: other.userId })
    await c.query('COMMIT')
    token = jwt.sign(
      { userId: me.userId, role: 'landlord', email: 'me@t.dev', profileId: null,
        landlordIds: [me.landlordId], permissions: {} },
      SECRET, { expiresIn: '1h' })
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
})

const dash = (qs = '') => request(buildApp())
  .get(`/api/landlords/me/dashboard${qs}`).set('Authorization', `Bearer ${token}`)

describe('GET /landlords/me/dashboard?propertyId=', () => {
  it('blends every property when nothing is chosen', async () => {
    const res = await dash()
    expect(res.status).toBe(200)
    expect(res.body.data.total_units).toBe(3)
    expect(Number(res.body.data.monthly_rent_volume)).toBe(1500)
    expect(res.body.data.property_count).toBe(2)
  })

  // 10/12 (Nic): the leases' rent, never a unit's listing — the figure the
  // Rent Roll the card opens totals (R&N's Springville SFH TOWN HOME read
  // $1,750 here and $0 there).
  it('a space marked occupied with no active lease adds nothing', async () => {
    const c = await db.connect()
    try {
      const { rows: [{ landlord_id }] } = await c.query(`SELECT landlord_id FROM properties WHERE id=$1`, [propB])
      const u = await seedUnit(c, { propertyId: propB, landlordId: landlord_id })
      await c.query(`UPDATE units SET status='active', rent_amount=1750 WHERE id=$1`, [u])
    } finally { c.release() }
    const res = await dash()
    expect(Number(res.body.data.monthly_rent_volume)).toBe(1500)
    expect(res.body.data.payable_rent_units).toBe(3)
  })

  it('narrows the cards to the chosen property', async () => {
    const res = await dash(`?propertyId=${propA}`)
    expect(res.status).toBe(200)
    expect(res.body.data.total_units).toBe(2)
    expect(Number(res.body.data.monthly_rent_volume)).toBe(1200)
    expect(res.body.data.property_count).toBe(1)
  })

  it('narrows to the smaller one too — this is the co-owner view', async () => {
    const res = await dash(`?propertyId=${propB}`)
    expect(res.body.data.total_units).toBe(1)
    expect(Number(res.body.data.monthly_rent_volume)).toBe(300)
  })

  it("REFUSES another landlord's property id", async () => {
    const res = await dash(`?propertyId=${otherProp}`)
    expect(res.status).toBe(404)
  })

  it('refuses an id that does not exist at all', async () => {
    const res = await dash(`?propertyId=${randomUUID()}`)
    expect(res.status).toBe(404)
  })

  it('treats an empty propertyId as the blended view, not an error', async () => {
    const res = await dash('?propertyId=')
    expect(res.status).toBe(200)
    expect(res.body.data.total_units).toBe(3)
  })
})

// S654 (Nic): "until a unit is actually delinquent past its grace period, I
// would really love for that to say outstanding units… flag a difference
// between outstanding and delinquent based on when the grace period ends."
// And of the old "late fees accruing on 7": "make sure that's accurate."
describe('S654 outstanding vs delinquent vs accruing', () => {
  // The bill is written three days before it is due (on time), unless
  // `writtenDaysAgo` says when GAM wrote it (10/12, Nic: a bill written after
  // its due date is late counted from the day it was written).
  async function unitOwing(opts: {
    daysPastDue: number; graceDays: number; fee: number; exempt?: boolean
    amount?: number; writtenDaysAgo?: number; dailyFee?: number
  }) {
    const c = await db.connect()
    try {
      await c.query('BEGIN')
      const { rows: [{ landlord_id }] } = await c.query(`SELECT landlord_id FROM properties WHERE id=$1`, [propA])
      const unitId = await seedUnit(c, { propertyId: propA, landlordId: landlord_id })
      await c.query(`UPDATE units SET status='active' WHERE id=$1`, [unitId])
      const { rows: [lease] } = await c.query<{ id: string }>(
        `INSERT INTO leases (unit_id, landlord_id, rent_amount, lease_type, status, start_date,
                             late_fee_enabled, late_fee_initial_amount, late_fee_initial_type, late_fee_grace_days,
                             late_fee_accrual_type, late_fee_accrual_amount, late_fee_accrual_period, late_fee_accrual_from)
         VALUES ($1,$2,500,'month_to_month','active', CURRENT_DATE - 60, true, $3, 'flat', $4,
                 CASE WHEN $5::numeric IS NOT NULL THEN 'flat' END, $5,
                 CASE WHEN $5::numeric IS NOT NULL THEN 'daily' END, 'due_date_inclusive') RETURNING id`,
        [unitId, landlord_id, opts.fee, opts.graceDays, opts.dailyFee ?? null])
      // Days in the property's own calendar (seedProperty's zone), noon there.
      const { rows: [{ due, written }] } = await c.query<{ due: string; written: Date }>(
        `SELECT ((NOW() AT TIME ZONE pr.timezone)::date - $2::int)::text AS due,
                ((((NOW() AT TIME ZONE pr.timezone)::date - COALESCE($3::int, $2::int + 3)) + TIME '12:00')
                   AT TIME ZONE pr.timezone) AS written
           FROM properties pr WHERE pr.id = $1`, [propA, opts.daysPastDue, opts.writtenDaysAgo ?? null])
      const { rows: [inv] } = await c.query<{ id: string }>(
        `INSERT INTO invoices (landlord_id, lease_id, unit_id, invoice_number, due_date, subtotal_rent, total_amount, status, late_fee_exempt, created_at)
         VALUES ($1,$2,$3,$4, $5::date, $7, $7, 'pending', $6, $8) RETURNING id`,
        [landlord_id, lease.id, unitId, `INV-${randomUUID().slice(0, 8)}`, due, !!opts.exempt, opts.amount ?? 500, written])
      await c.query(
        `INSERT INTO payments (invoice_id, unit_id, lease_id, landlord_id, type, amount, status, due_date, entry_description, created_at)
         VALUES ($1,$2,$3,$4,'rent',$6,'pending', $5::date, 'RENT', $7)`,
        [inv.id, unitId, lease.id, landlord_id, due, opts.amount ?? 500, written])
      await c.query('COMMIT')
    } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
  }

  it('counts owing, past-grace, and fee-will-be-charged separately', async () => {
    await unitOwing({ daysPastDue: 0,  graceDays: 5, fee: 50 })              // due today: outstanding only
    await unitOwing({ daysPastDue: 10, graceDays: 5, fee: 0 })               // past grace, $0 fee: delinquent, no fee
    await unitOwing({ daysPastDue: 10, graceDays: 5, fee: 50, exempt: true }) // past grace, waived: delinquent, no fee
    await unitOwing({ daysPastDue: 10, graceDays: 5, fee: 50 })              // past grace, real fee: accruing
    await unitOwing({ daysPastDue: 3,  graceDays: 5, fee: 50 })              // inside grace: outstanding only
    const res = await dash()
    expect(res.status).toBe(200)
    expect(res.body.data.units_owing).toBe(5)
    expect(res.body.data.units_past_grace).toBe(3)
    expect(res.body.data.delinquent_units_accruing_late_fees).toBe(1)
  })

  it('a longer grace period keeps a unit outstanding, not delinquent', async () => {
    await unitOwing({ daysPastDue: 10, graceDays: 15, fee: 50 })
    const res = await dash()
    expect(res.body.data.units_owing).toBe(1)
    expect(res.body.data.units_past_grace).toBe(0)
    expect(res.body.data.delinquent_units_accruing_late_fees).toBe(0)
  })

  // 10/12 (Nic): the dashboard reads the one lateness rule every money screen
  // and the late-fee engine use (services/lateness): late from the lateness
  // start + GREATEST(grace, 1), the start being the due date or the day GAM
  // wrote the bill when later. It used to say "today > due + grace", so the
  // first late day — the day the fee charges — read "not past grace".
  it('the first late day is past grace: the 6th, with 5 days of grace', async () => {
    await unitOwing({ daysPastDue: 4, graceDays: 5, fee: 50 })   // the 5th: grace
    await unitOwing({ daysPastDue: 5, graceDays: 5, fee: 50 })   // the 6th: late, the fee charges tonight
    const res = await dash()
    expect(res.body.data.units_owing).toBe(2)
    expect(res.body.data.units_past_grace).toBe(1)
    expect(res.body.data.delinquent_units_accruing_late_fees).toBe(1)
  })

  it('a grace of 0: due today is on time, due yesterday is late', async () => {
    await unitOwing({ daysPastDue: 0, graceDays: 0, fee: 50 })
    await unitOwing({ daysPastDue: 1, graceDays: 0, fee: 50 })
    const res = await dash()
    expect(res.body.data.units_past_grace).toBe(1)
  })

  it('a bill written after its due date counts its grace from the day it was written', async () => {
    // Due 10 days ago, written 2 days ago, 5 days of grace: still in grace.
    await unitOwing({ daysPastDue: 10, writtenDaysAgo: 2, graceDays: 5, fee: 50 })
    // Written 5 days ago: today is its first late day.
    await unitOwing({ daysPastDue: 10, writtenDaysAgo: 5, graceDays: 5, fee: 50 })
    const res = await dash()
    expect(res.body.data.units_owing).toBe(2)
    expect(res.body.data.units_past_grace).toBe(1)
  })

  it('a $0 line is never past grace, and a unit owing only $0 does not owe', async () => {
    await unitOwing({ daysPastDue: 10, graceDays: 5, fee: 50, amount: 0 })
    const res = await dash()
    // 10/12 (Nic): $0 lines are ignored — the headline said "owes" with nothing owed.
    expect(res.body.data.units_owing).toBe(0)
    expect(res.body.data.units_past_grace).toBe(0)
    expect(res.body.data.delinquent_units_accruing_late_fees).toBe(0)
  })

  // 10/12 (Nic, Q-a): "it rides the original due date." A line added to a bill
  // already late is fined from the BILL's late clock (the engine starts on the
  // day the bill was written), so the unit is accruing — while the line itself,
  // written yesterday, is still inside its own grace (Outstanding's rule).
  it('a line added to a late bill is accruing on the bill\'s clock', async () => {
    // Oak Park terms: no first fee, $5 a day counted back to the due date.
    await unitOwing({ daysPastDue: 10, graceDays: 5, fee: 0, dailyFee: 5 })
    const { rows: [rent] } = await db.query<{ id: string; invoice_id: string; unit_id: string; lease_id: string; landlord_id: string; due_date: string }>(
      `SELECT p.id, p.invoice_id, p.unit_id, p.lease_id, p.landlord_id, p.due_date::text AS due_date
         FROM payments p JOIN units u ON u.id = p.unit_id WHERE u.property_id = $1 AND p.type = 'rent'`, [propA])
    // The rent was paid before the due date; a $40 utility line joined the bill yesterday.
    await db.query(`UPDATE payments SET status = 'settled', settled_at = NOW() - INTERVAL '12 days', manual_method = 'cash' WHERE id = $1`, [rent.id])
    await db.query(
      `INSERT INTO payments (invoice_id, unit_id, lease_id, landlord_id, type, amount, status, due_date, entry_description, created_at)
       VALUES ($1,$2,$3,$4,'utility',40,'pending',$5::date,'UTILITY', NOW() - INTERVAL '1 day')`,
      [rent.invoice_id, rent.unit_id, rent.lease_id, rent.landlord_id, rent.due_date])
    const res = await dash()
    expect(res.body.data.units_owing).toBe(1)
    expect(res.body.data.units_past_grace).toBe(0)
    expect(res.body.data.delinquent_units_accruing_late_fees).toBe(1)
  })

  // Every Oak Park lease: no first fee, $5 a day counted back to the due date.
  // The engine charges it; the card said "no fee will be charged".
  it('a daily fee with a $0 first fee is accruing', async () => {
    await unitOwing({ daysPastDue: 10, graceDays: 5, fee: 0, dailyFee: 5 })
    const res = await dash()
    expect(res.body.data.units_past_grace).toBe(1)
    expect(res.body.data.delinquent_units_accruing_late_fees).toBe(1)
  })
})

// S655 (decision #4): the trend and the property-health card read the same
// category totals as the property report. They used to sum EVERY settled row,
// so a deposit held for a tenant and GAM's own fee showed as the landlord's
// revenue on the heartbeat.
describe('S655 the trend and the property-health card count income only', () => {
  async function rowsOn(propertyId: string, rows: Array<[string, string, number, string]>) {
    const { rows: [u] } = await db.query<{ id: string; landlord_id: string }>(
      `SELECT id, landlord_id FROM units WHERE property_id = $1 ORDER BY id LIMIT 1`, [propertyId])
    const { rows: [{ d }] } = await db.query<{ d: string }>(`SELECT (now() AT TIME ZONE 'America/Phoenix')::date::text AS d`)
    for (const [i, [type, entry, amount, owner]] of rows.entries()) {
      await db.query(
        `INSERT INTO payments (unit_id, landlord_id, type, amount, status, entry_description, due_date, settled_at, revenue_owner)
         VALUES ($1,$2,$3,$4,'settled',$5,$6::date - $8::int,now(),$7)`,
        [u.id, u.landlord_id, type, amount, entry, d, owner, i])
    }
  }

  it('a deposit held and a GAM fee are not revenue on the trend', async () => {
    await rowsOn(propA, [
      ['rent', 'RENT', 500, 'landlord'],
      ['utility', 'UTILITY', 40, 'landlord'],
      ['deposit', 'DEPOSIT', 700, 'held'],
      ['fee', 'DECLINEFEE', 6, 'gam'],
    ])
    const res = await dash()
    const now = res.body.data.trend[res.body.data.trend.length - 1]
    expect(now.revenue).toBe(540)
    expect(now.rent_revenue).toBe(500)
    expect(now.other_revenue).toBe(40)
    expect(res.body.data.property_health.total).toBe(540)
    expect(res.body.data.trend).toHaveLength(6)
  })

  it('narrowing to a property narrows the trend and the property-health card too', async () => {
    await rowsOn(propA, [['rent', 'RENT', 500, 'landlord']])
    await rowsOn(propB, [['rent', 'RENT', 300, 'landlord']])
    expect((await dash()).body.data.property_health.total).toBe(800)
    const a = (await dash(`?propertyId=${propA}`)).body.data
    expect(a.property_health.total).toBe(500)
    expect(a.trend[a.trend.length - 1].revenue).toBe(500)
    expect((await dash(`?propertyId=${propB}`)).body.data.property_health.total).toBe(300)
  })

  it('refuses an unknown basis', async () => {
    expect((await dash('?basis=accrual')).status).toBe(400)
  })
})
