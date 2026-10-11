/**
 * 10/3 (final sweep) — a move-out read taken off the reads-due to-do names
 * whose move-out it is.
 *
 * The case: household A left a space with no read of its own; household D has
 * been on it since. When D's move-out read is taken, the move-out rule alone
 * would bill A (a household that left comes first). The to-do row knows the read
 * is D's, so the form sends D's lease and the bill lands on D. A lease from
 * another company is ignored, never an error.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { db } from '../db'
import {
  cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedTenant,
  seedLease, seedLeaseTenant, seedUtilityMeter,
} from '../test/dbHelpers'
import { utilityRouter } from './utility'
import { errorHandler } from '../middleware/errorHandler'
import { unitPendingReads } from '../services/utilityReadingRuns'

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/utility', utilityRouter)
  app.use(errorHandler)
  return app
}

beforeEach(async () => {
  await cleanupAllSchema()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_special_read'
})

const day = async (offset: number) =>
  (await db.query<{ d: string }>(`SELECT to_char(CURRENT_DATE + $1::int, 'YYYY-MM-DD') AS d`, [offset])).rows[0].d

async function seed() {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const a = await seedLandlord(c)
    const b = await seedLandlord(c)
    const prop = await seedProperty(c, { landlordId: a.landlordId, ownerUserId: a.userId, managedByUserId: a.userId })
    const unit = await seedUnit(c, { propertyId: prop, landlordId: a.landlordId })
    const meter = await seedUtilityMeter(c, { propertyId: prop, utilityType: 'electric', billingMethod: 'submeter' })
    await c.query(`UPDATE utility_meters SET rate_per_unit = 0.21, base_fee = 0 WHERE id = $1`, [meter])
    await c.query(`INSERT INTO utility_meter_units (meter_id, unit_id) VALUES ($1, $2)`, [meter, unit])

    const lease = async (landlordId: string, unitId: string) => {
      const id = await seedLease(c, { unitId, landlordId, status: 'active' })
      await seedLeaseTenant(c, { leaseId: id, tenantId: await seedTenant(c) })
      await c.query(`INSERT INTO lease_utility_responsibilities (lease_id, utility_type, tenant_responsible)
                     VALUES ($1, 'electric', TRUE)`, [id])
      return id
    }
    // A: on the space, left five days ago with no read of its own.
    const gone = await lease(a.landlordId, unit)
    await c.query(`UPDATE leases SET start_date = CURRENT_DATE - 200, status = 'expired', end_date = CURRENT_DATE - 5 WHERE id = $1`, [gone])
    // D: on the space since the day after; this is D's move-out read.
    const mover = await lease(a.landlordId, unit)
    await c.query(`UPDATE leases SET start_date = CURRENT_DATE - 4 WHERE id = $1`, [mover])
    await c.query(`UPDATE lease_unit_history SET effective_from = CURRENT_DATE - 4 WHERE lease_id = $1`, [mover])
    // A lease of another company, on its own space.
    const bProp = await seedProperty(c, { landlordId: b.landlordId, ownerUserId: b.userId, managedByUserId: b.userId })
    const foreign = await lease(b.landlordId, await seedUnit(c, { propertyId: bProp, landlordId: b.landlordId }))

    // The read before: ten days ago.
    await c.query(
      `INSERT INTO utility_meter_readings (meter_id, reading_date, reading_value, billing_cycle_month, created_by_user_id, reason)
       VALUES ($1, CURRENT_DATE - 10, 1000, date_trunc('month', CURRENT_DATE - 10)::date, $2, 'monthly_cycle')`, [meter, a.userId])
    await c.query('COMMIT')
    const token = jwt.sign({ userId: a.userId, role: 'landlord', email: 'a@t.dev', profileId: a.landlordId, permissions: {} },
      process.env.JWT_SECRET!, { expiresIn: '1h' })
    return { meter, unit, gone, mover, foreign, token, propertyId: prop, landlordId: a.landlordId }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

const readOut = (f: { meter: string; token: string }, body: object) =>
  request(buildApp()).post(`/api/utility/meters/${f.meter}/reads`)
    .set('Authorization', `Bearer ${f.token}`)
    .send({ readingValue: 1100, reason: 'move_out_final', ...body })

const billedTo = async (meter: string) =>
  (await db.query<{ lease_id: string; usage: number }>(
    `SELECT lease_id, usage_amount::float AS usage FROM utility_bills WHERE meter_id = $1`, [meter])).rows

describe('a move-out read names whose move-out it is', () => {
  it('the to-do sends the leaving household: that household is billed, not one that left earlier', async () => {
    const f = await seed()
    const r = await readOut(f, { leaseId: f.mover })
    expect(r.status).toBe(201)
    expect(r.body.data.billed).toBe(true)
    expect(await billedTo(f.meter)).toEqual([{ lease_id: f.mover, usage: 100 }])
  })

  it('a lease from another company is ignored, never an error: the read bills by the normal rule', async () => {
    const f = await seed()
    const r = await readOut(f, { leaseId: f.foreign })
    expect(r.status).toBe(201)
    expect(r.body.data.billed).toBe(true)
    expect(await billedTo(f.meter)).toEqual([{ lease_id: f.gone, usage: 100 }])
    expect((await db.query(`SELECT 1 FROM utility_bills WHERE lease_id = $1`, [f.foreign])).rows).toHaveLength(0)
  })

  it('the response stays blind: no reading values come back', async () => {
    const f = await seed()
    const r = await readOut(f, { leaseId: f.mover })
    expect(JSON.stringify(r.body)).not.toMatch(/1100|1000/)
  })
})

describe('check-in asks for each meter once', () => {
  it('two departures on one space ask for its meter once, as the billing move-out, with that lease', async () => {
    const f = await seed()
    // D leaves too (yesterday) — tenant-responsible, so its read bills.
    await db.query(`UPDATE leases SET status = 'expired', end_date = $2 WHERE id = $1`, [f.mover, await day(-1)])
    // A's departure no longer bills on this meter (utilities included for it).
    await db.query(`UPDATE lease_utility_responsibilities SET tenant_responsible = FALSE WHERE lease_id = $1`, [f.gone])
    // Read before both departures still only the one from ten days ago.
    const rows = await unitPendingReads(f.unit)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ meter_id: f.meter, reason: 'move_out_final', lease_id: f.mover })
  })

  it('a stay turnover carries no lease', async () => {
    const f = await seed()
    await db.query(`UPDATE lease_utility_responsibilities SET tenant_responsible = FALSE`)
    await db.query(`UPDATE leases SET status = 'expired', end_date = $2 WHERE id = $1`, [f.mover, await day(-1)])
    const rows = await unitPendingReads(f.unit)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ meter_id: f.meter, reason: 'stay_turnover', lease_id: null })
  })
})

// 10/3 (permission-hints check): a staffer who only reads meters reads blind.
describe('a meter reader reads blind', () => {
  async function staff(f: { propertyId: string; landlordId: string }, perms: Record<string, boolean>) {
    const u = await db.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
       VALUES ($1,'x','onsite_manager','Front','Desk',TRUE) RETURNING id`, [`desk-${Math.random().toString(36).slice(2)}@t.dev`])
    await db.query(`INSERT INTO onsite_manager_scopes (user_id, landlord_id, property_ids, all_properties, permissions) VALUES ($1,$2,$3,FALSE,$4)`,
      [u.rows[0].id, f.landlordId, [f.propertyId], JSON.stringify(perms)])
    return jwt.sign({ userId: u.rows[0].id, role: 'onsite_manager', email: 'desk@t.dev', landlordId: f.landlordId, permissions: perms },
      process.env.JWT_SECRET!, { expiresIn: '1h' })
  }
  const meters = (token: string, propertyId: string) =>
    request(buildApp()).get(`/api/utility/meters?propertyId=${propertyId}`).set('Authorization', `Bearer ${token}`)
  async function withOpeningRead(f: { meter: string }) {
    await db.query(`UPDATE utility_meters SET base_fee = 3 WHERE id = $1`, [f.meter])
    await db.query(
      `INSERT INTO utility_meter_readings (meter_id, reading_date, reading_value, billing_cycle_month, created_by_user_id, reason)
       VALUES ($1, CURRENT_DATE - 60, 777, date_trunc('month', CURRENT_DATE - 60)::date,
               (SELECT user_id FROM landlords LIMIT 1), 'baseline')`, [f.meter])
  }

  it('master bills are owner-only: a meter reader gets 403, the owner gets the list', async () => {
    const f = await seed()
    const reader = await staff(f, { 'utility.read_meters': true })
    const r = await request(buildApp()).get(`/api/utility/master-bills?propertyId=${f.propertyId}`).set('Authorization', `Bearer ${reader}`)
    expect(r.status).toBe(403)
    const o = await request(buildApp()).get(`/api/utility/master-bills?propertyId=${f.propertyId}`).set('Authorization', `Bearer ${f.token}`)
    expect(o.status).toBe(200)
  })

  it('the meter list gives a reader no reading value and no prices', async () => {
    const f = await seed()
    await withOpeningRead(f)
    const reader = await staff(f, { 'utility.read_meters': true })
    const r = await meters(reader, f.propertyId)
    expect(r.status).toBe(200)
    const m = r.body.data.find((x: any) => x.id === f.meter)
    expect(m).toBeTruthy()
    expect(m.opening_read).toBeTruthy()
    expect(m.opening_read.value).toBeUndefined()
    expect(m.rate_per_unit).toBeUndefined()
    expect(m.base_fee).toBeUndefined()
    expect(JSON.stringify(r.body)).not.toMatch(/777/)
  })

  it('staff who can see units keep the prices but still never the reading value', async () => {
    const f = await seed()
    await withOpeningRead(f)
    const desk = await staff(f, { 'utility.read_meters': true, 'units.view_status': true })
    const m = (await meters(desk, f.propertyId)).body.data.find((x: any) => x.id === f.meter)
    expect(Number(m.rate_per_unit)).toBeCloseTo(0.21, 2)
    expect(m.opening_read.value).toBeUndefined()
  })

  it('the owner still sees the opening read and the prices', async () => {
    const f = await seed()
    await withOpeningRead(f)
    const m = (await meters(f.token, f.propertyId)).body.data.find((x: any) => x.id === f.meter)
    expect(Number(m.opening_read.value)).toBe(777)
    expect(Number(m.rate_per_unit)).toBeCloseTo(0.21, 2)
    expect(Number(m.base_fee)).toBe(3)
  })
})
