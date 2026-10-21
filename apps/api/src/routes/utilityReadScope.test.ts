/**
 * 10/20 — A PROPERTY ID IN THE QUERY STRING IS NOT PERMISSION TO READ IT.
 *
 * Every utility read that takes ?propertyId= asks the same two questions: does
 * this person work for the company that owns the property, and is this one of
 * the properties they were put on? The first was asked everywhere. The second
 * kept being left off, and "landlord-wide access" is the COMPANY, not the park
 * — so a desk clerk or a manager held to Mountain View typed an Oak Park id in
 * the address bar and the handler answered.
 *
 * What that cost on the readings spreadsheet, which is why this file exists:
 * one row per meter and, per month, both the reading and the wrap-aware usage.
 * That is last month's figure and the plausible range for this month, side by
 * side, handed to the person who is supposed to walk the park blind (S559). A
 * reader who knows the previous number can type one that produces normal-
 * looking usage, and the rollover check, the usage alerts and the landlord's
 * double-check window all pass together.
 *
 * So each route gets two tests: the owner still reads their own property, and
 * a scoped worker asking for a property that is not theirs is refused.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { randomUUID } from 'crypto'
import { db } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedUtilityMeter } from '../test/dbHelpers'
import { utilityRouter } from './utility'
import { errorHandler } from '../middleware/errorHandler'

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/utility', utilityRouter)
  app.use(errorHandler)
  return app
}

beforeEach(async () => {
  await cleanupAllSchema()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_utility_read_scope'
})

interface World {
  landlordId: string
  ownerUserId: string
  mountain: string      // the property the staff are put on
  oak: string           // another park in the SAME company — never theirs
  mountainMeter: string
  ownerToken: string
}

/** One company, two parks, a read on the Mountain View meter. */
async function seed(): Promise<World> {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const a = await seedLandlord(c)
    const mountain = await seedProperty(c, { landlordId: a.landlordId, ownerUserId: a.userId, managedByUserId: a.userId })
    const oak = await seedProperty(c, { landlordId: a.landlordId, ownerUserId: a.userId, managedByUserId: a.userId })
    const unit = await seedUnit(c, { propertyId: mountain, landlordId: a.landlordId })
    const meter = await seedUtilityMeter(c, { propertyId: mountain, utilityType: 'electric', billingMethod: 'submeter' })
    await c.query(`INSERT INTO utility_meter_units (meter_id, unit_id) VALUES ($1, $2)`, [meter, unit])
    await c.query(
      `INSERT INTO utility_meter_readings (meter_id, reading_date, reading_value, billing_cycle_month, created_by_user_id, reason)
       VALUES ($1, '2026-09-30', 4211, '2026-09-01', $2, 'monthly_cycle')`, [meter, a.userId])
    // An Oak Park meter with a read of its own, so a leak there has something
    // to leak — a 200 on an empty park would prove nothing.
    const oakUnit = await seedUnit(c, { propertyId: oak, landlordId: a.landlordId })
    const oakMeter = await seedUtilityMeter(c, { propertyId: oak, utilityType: 'electric', billingMethod: 'submeter' })
    await c.query(`INSERT INTO utility_meter_units (meter_id, unit_id) VALUES ($1, $2)`, [oakMeter, oakUnit])
    await c.query(
      `INSERT INTO utility_meter_readings (meter_id, reading_date, reading_value, billing_cycle_month, created_by_user_id, reason)
       VALUES ($1, '2026-09-30', 9357, '2026-09-01', $2, 'monthly_cycle')`, [oakMeter, a.userId])
    await c.query('COMMIT')
    return {
      landlordId: a.landlordId, ownerUserId: a.userId, mountain, oak, mountainMeter: meter,
      ownerToken: jwt.sign(
        { userId: a.userId, role: 'landlord', email: 'owner@t.dev', profileId: a.landlordId, permissions: {} },
        process.env.JWT_SECRET!, { expiresIn: '1h' }),
    }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

/** A team member of this company, put on these properties and nothing else. */
async function staff(
  w: World,
  role: 'property_manager' | 'onsite_manager',
  permissions: Record<string, boolean>,
  propertyIds: string[],
): Promise<string> {
  const u = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
     VALUES ($1,'x',$2,'Team','Member',TRUE) RETURNING id`, [`${role}-${randomUUID()}@t.dev`, role])
  const table = role === 'property_manager' ? 'property_manager_scopes' : 'onsite_manager_scopes'
  await db.query(
    `INSERT INTO ${table} (user_id, landlord_id, property_ids, all_properties, permissions)
     VALUES ($1,$2,$3,FALSE,$4)`,
    [u.rows[0].id, w.landlordId, propertyIds, JSON.stringify(permissions)])
  return jwt.sign(
    { userId: u.rows[0].id, role, email: 'team@t.dev', profileId: null, landlordId: w.landlordId, permissions },
    process.env.JWT_SECRET!, { expiresIn: '1h' })
}

const get = (token: string, url: string) =>
  request(buildApp()).get(url).set('Authorization', `Bearer ${token}`)

describe('the readings spreadsheet is the owner\'s, at the owner\'s own park', () => {
  const url = (p: string) => `/api/utility/readings/export?propertyId=${p}`

  it('the owner downloads their park: a row per meter, the month\'s reading in it', async () => {
    const w = await seed()
    const r = await get(w.ownerToken, url(w.mountain))
    expect(r.status, r.text).toBe(200)
    expect(r.headers['content-type']).toMatch(/text\/csv/)
    expect(r.text).toContain('2026-09 reading')
    expect(r.text).toContain('4211')
  })

  it('a desk clerk who can see unit status is refused — the walk is blind', async () => {
    const w = await seed()
    const desk = await staff(w, 'onsite_manager',
      { 'utility.read_meters': true, 'units.view_status': true }, [w.mountain])
    const r = await get(desk, url(w.mountain))
    expect(r.status).toBe(403)
    expect(r.text).not.toContain('4211')
  })

  it('a manager put on Mountain View cannot download Oak Park', async () => {
    const w = await seed()
    const pm = await staff(w, 'property_manager', { 'properties.edit': true }, [w.mountain])
    const theirs = await get(pm, url(w.mountain))
    expect(theirs.status, theirs.text).toBe(200)
    const other = await get(pm, url(w.oak))
    expect(other.status).toBe(403)
    expect(other.text).not.toContain('9357')
  })
})

describe('the rest of the utility reads that take a propertyId', () => {
  // Readings held for the landlord's double-check: entered and prior value
  // side by side. Landlord-only already — but "landlord" was the company.
  it('the double-check window is one park\'s: a manager cannot open another park\'s', async () => {
    const w = await seed()
    const pm = await staff(w, 'property_manager', { 'properties.edit': true }, [w.mountain])
    expect((await get(pm, `/api/utility/readings/flagged?propertyId=${w.mountain}`)).status).toBe(200)
    expect((await get(pm, `/api/utility/readings/flagged?propertyId=${w.oak}`)).status).toBe(403)
    expect((await get(w.ownerToken, `/api/utility/readings/flagged?propertyId=${w.oak}`)).status).toBe(200)
  })

  // Spent / billed back / collected, in dollars, for one park.
  it('the recovery report is one park\'s money: a manager cannot read another park\'s', async () => {
    const w = await seed()
    const pm = await staff(w, 'property_manager', { 'properties.edit': true }, [w.mountain])
    const range = 'from=2026-01-01&to=2026-12-31'
    expect((await get(pm, `/api/utility/recovery?propertyId=${w.mountain}&${range}`)).status).toBe(200)
    expect((await get(pm, `/api/utility/recovery?propertyId=${w.oak}&${range}`)).status).toBe(403)
  })

  // Every reading of every meter at a park, with the usage worked out — the
  // same figures as the spreadsheet, on screen instead of in a file.
  it('reading history is one park\'s: a manager cannot read another park\'s', async () => {
    const w = await seed()
    const pm = await staff(w, 'property_manager', { 'properties.edit': true }, [w.mountain])
    expect((await get(pm, `/api/utility/reading-history?propertyId=${w.mountain}`)).status).toBe(200)
    const other = await get(pm, `/api/utility/reading-history?propertyId=${w.oak}`)
    expect(other.status).toBe(403)
    expect(other.text).not.toContain('9357')
  })

  // Prices and taxes: the desk legitimately needs these to ring up a fill, at
  // the park they are standing in.
  it('the tax rates and the prices are the desk\'s park only', async () => {
    const w = await seed()
    const desk = await staff(w, 'onsite_manager',
      { 'utility.read_meters': true, 'units.view_status': true }, [w.mountain])
    expect((await get(desk, `/api/utility/tax-rates?propertyId=${w.mountain}`)).status).toBe(200)
    expect((await get(desk, `/api/utility/tax-rates?propertyId=${w.oak}`)).status).toBe(403)
    expect((await get(desk, `/api/utility/property-rates?propertyId=${w.mountain}`)).status).toBe(200)
    expect((await get(desk, `/api/utility/property-rates?propertyId=${w.oak}`)).status).toBe(403)
  })

  it('a propertyId that is not a uuid is a bad request, not a crash', async () => {
    const w = await seed()
    const r = await get(w.ownerToken, '/api/utility/property-rates?propertyId=not-a-uuid')
    expect(r.status).toBe(400)
  })
})
