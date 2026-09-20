/**
 * S651 — a renter in the pool looking outward at places to live.
 *
 * Nic: "Based on their address from their ID, it shows nearby properties in a
 * radius that are onboarded on the platform. If there's nothing in the area —
 * if somebody signs up in New York and the only properties are in Illinois and
 * freaking Arizona — then it won't show them that there's anywhere close by to
 * live. They can expand their search if they're looking to move further away,
 * but that's it."
 *
 * The New York case is the one worth pinning, because the bug it replaces did
 * the opposite: proximity was measured from the "GAM Renter Pool" shell
 * property in Phoenix, so every renter in the country looked like they lived in
 * Arizona.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { randomUUID } from 'crypto'
import { db } from '../db'
import { cleanupAllSchema, seedLandlord } from '../test/dbHelpers'
import { renterPoolRouter } from './renterPool'
import { errorHandler } from '../middleware/errorHandler'
import { camelCaseKeys } from '../lib/caseConversion'

/**
 * The camelCase middleware is mounted here on purpose.
 *
 * index.ts camelizes every response on the way out, so production serves
 * `distanceMiles` and `openUnits` while a bare router in a test serves
 * `distance_miles` and `open_units`. A test that asserts the snake_case keys
 * passes forever and proves nothing about what the portal actually receives —
 * the page would read undefined everywhere and render blank rows with no error.
 * Including the middleware makes this test check the real wire contract.
 * (memory: gam-camelize-wire-contract-test-gap)
 */
function buildApp() {
  const app = express()
  app.use(express.json())
  app.use((_req, res, next) => {
    const originalJson = res.json.bind(res)
    res.json = (body: any) => originalJson(camelCaseKeys(body))
    next()
  })
  app.use('/api/renter-pool', renterPoolRouter)
  app.use(errorHandler)
  return app
}

beforeEach(async () => {
  await cleanupAllSchema()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_pool'
})

const sign = (claims: any) => jwt.sign(claims, process.env.JWT_SECRET!, { expiresIn: '1h' })

/**
 * A real property at real coordinates, under a real (non-system) company.
 *
 * `leaseTypes` is what decides whether it belongs in the pool at all — not the
 * property's type and not its unit types. An apartment building and an RV park
 * are the same thing here; a nightly/weekly-only operator is not.
 */
async function seedPlaceToLive(
  name: string, city: string, state: string, lat: number, lon: number, vacantUnits = 2,
  leaseTypes: string[] = ['month_to_month', 'long_term'],
) {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const { userId, landlordId } = await seedLandlord(c)
    const p = await c.query<{ id: string }>(
      `INSERT INTO properties (landlord_id, name, street1, city, state, zip,
                               latitude, longitude, owner_user_id, managed_by_user_id)
       VALUES ($1,$2,'1 Main St',$3,$4,'00000',$5,$6,$7,$7) RETURNING id`,
      [landlordId, name, city, state, lat, lon, userId])
    for (let i = 0; i < vacantUnits; i++) {
      await c.query(
        `INSERT INTO units (property_id, landlord_id, unit_number, status,
                            rent_amount, lease_types_allowed)
         VALUES ($1,$2,$3,'vacant',500,$4)`,
        [p.rows[0].id, landlordId, `U${i + 1}`, leaseTypes])
    }
    await c.query('COMMIT')
    return p.rows[0].id
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

/** A renter in the pool, placed at coordinates from the address on their ID. */
async function seedRenterAt(city: string, state: string, lat: number, lon: number) {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const { landlordId } = await seedLandlord(c)
    const u = await c.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
       VALUES ($1,'x','tenant','Renter','Looking',TRUE) RETURNING id`,
      [`renter-${randomUUID()}@test.dev`])
    const bc = await c.query<{ id: string }>(
      `INSERT INTO background_checks (landlord_id, user_id, consent_pool)
       VALUES ($1,$2,TRUE) RETURNING id`, [landlordId, u.rows[0].id])
    await c.query(
      `INSERT INTO application_pool
         (background_check_id, user_id, status, consent_pool, city, state, zip, lat, lon)
       VALUES ($1,$2,'available',TRUE,$3,$4,'00000',$5,$6)`,
      [bc.rows[0].id, u.rows[0].id, city, state, lat, lon])
    await c.query('COMMIT')
    return u.rows[0].id
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

const get = (userId: string, qs = '') =>
  request(buildApp())
    .get(`/api/renter-pool/me/nearby${qs}`)
    .set('Authorization', `Bearer ${sign({ userId, role: 'tenant', email: 'r@t.dev', permissions: {} })}`)

describe('what a renter in the pool sees near them', () => {
  it('shows the place down the road, measured from THEIR address', async () => {
    // Amado AZ, and a renter in Tucson — about 40 miles up I-19.
    await seedPlaceToLive('Mountain View RV Ranch', 'Amado', 'AZ', 31.705296, -111.064567)
    const userId = await seedRenterAt('Tucson', 'AZ', 32.2226, -110.9747)

    const res = await get(userId)
    expect(res.status).toBe(200)
    expect(res.body.data.properties).toHaveLength(1)
    const [park] = res.body.data.properties
    expect(park.name).toBe('Mountain View RV Ranch')
    expect(parseFloat(park.distanceMiles)).toBeLessThan(50)
    expect(Number(park.openUnits)).toBe(2)
    expect(res.body.data.from).toEqual({ city: 'Tucson', state: 'AZ' })
  })

  it('tells a renter in New York there is nothing near them, and how far the nearest is', async () => {
    // Nic's own example. The old shell-property search would have ranked these
    // as though this person lived in Phoenix.
    await seedPlaceToLive('Mountain View RV Ranch', 'Amado', 'AZ', 31.705296, -111.064567)
    await seedPlaceToLive('Country Acres', 'Mattoon', 'IL', 39.4831, -88.3728)
    const userId = await seedRenterAt('New York', 'NY', 40.7128, -74.0060)

    const res = await get(userId)
    expect(res.status).toBe(200)
    expect(res.body.data.properties).toEqual([])
    // Not a bare empty list — the nearest is named, so they can decide whether
    // moving that far is something they want.
    expect(res.body.data.nearestOutsideRadius.city).toBe('Mattoon')
    expect(parseFloat(res.body.data.nearestOutsideRadius.distanceMiles)).toBeGreaterThan(600)
  })

  it('finds it once they widen the search', async () => {
    await seedPlaceToLive('Country Acres', 'Mattoon', 'IL', 39.4831, -88.3728)
    const userId = await seedRenterAt('New York', 'NY', 40.7128, -74.0060)

    expect((await get(userId)).body.data.properties).toEqual([])
    const wide = await get(userId, '?radiusMiles=1000')
    expect(wide.body.data.properties).toHaveLength(1)
    expect(wide.body.data.properties[0].city).toBe('Mattoon')
  })

  it('is not scoped to parks — an apartment building counts the same', async () => {
    // Nic: "we don't want to filter it to parks... any applicable property that
    // allows long-term stays." Nothing here reads the property's type or its
    // unit types; the unit's own lease types are the whole test.
    await seedPlaceToLive('Riverside Apartments', 'Tucson', 'AZ', 32.2226, -110.9747)
    const userId = await seedRenterAt('Tucson', 'AZ', 32.2226, -110.9747)
    const res = await get(userId)
    expect(res.body.data.properties.map((p: any) => p.name)).toEqual(['Riverside Apartments'])
  })

  it('leaves out an operator who only rents by the night or the week', async () => {
    // Somebody running an Airbnb-shaped business has nothing to offer a person
    // looking for a home, and their units say so by carrying no long-term type.
    await seedPlaceToLive('Nightly Cabins', 'Tucson', 'AZ', 32.2226, -110.9747, 4,
      ['nightly', 'weekly'])
    await seedPlaceToLive('Long Stay Court', 'Tucson', 'AZ', 32.2226, -110.9747, 1)
    const userId = await seedRenterAt('Tucson', 'AZ', 32.2226, -110.9747)
    const res = await get(userId)
    expect(res.body.data.properties.map((p: any) => p.name)).toEqual(['Long Stay Court'])
  })

  it('counts only the long-term openings at a property that does both', async () => {
    // Oak Park's shape: a motel with nightly rooms AND long-term residents. It
    // belongs in the pool, but its nightly rooms are not somewhere to live.
    const c = await db.connect()
    let propertyId = '', landlordId = '', userId2 = ''
    try {
      await c.query('BEGIN')
      const l = await seedLandlord(c)
      landlordId = l.landlordId; userId2 = l.userId
      const p = await c.query<{ id: string }>(
        `INSERT INTO properties (landlord_id, name, street1, city, state, zip,
                                 latitude, longitude, owner_user_id, managed_by_user_id)
         VALUES ($1,'Mixed Motel','1 Main St','Tucson','AZ','00000',32.2226,-110.9747,$2,$2)
         RETURNING id`, [landlordId, userId2])
      propertyId = p.rows[0].id
      for (const [n, types] of [['N1', ['nightly']], ['N2', ['nightly']], ['L1', ['long_term']]] as any[]) {
        await c.query(
          `INSERT INTO units (property_id, landlord_id, unit_number, status,
                              rent_amount, lease_types_allowed)
           VALUES ($1,$2,$3,'vacant',500,$4)`, [propertyId, landlordId, n, types])
      }
      await c.query('COMMIT')
    } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }

    const userId = await seedRenterAt('Tucson', 'AZ', 32.2226, -110.9747)
    const res = await get(userId)
    expect(res.body.data.properties).toHaveLength(1)
    expect(Number(res.body.data.properties[0].openUnits)).toBe(1)   // not 3
  })

  it('never offers the GAM Renter Pool shell as a place to live', async () => {
    // The pool was scoped under a system landlord and property only because a
    // tenant portal needed something to attach to. Nobody lives there.
    const c = await db.connect()
    try {
      await c.query('BEGIN')
      const { userId: sysUser, landlordId } = await seedLandlord(c)
      await c.query(`UPDATE landlords SET is_system = TRUE WHERE id = $1`, [landlordId])
      await c.query(
        `INSERT INTO properties (landlord_id, name, street1, city, state, zip,
                                 latitude, longitude, owner_user_id, managed_by_user_id)
         VALUES ($1,'GAM Renter Pool','1 Shell St','Phoenix','AZ','85001',
                 33.4484,-112.0740,$2,$2)`, [landlordId, sysUser])
      await c.query('COMMIT')
    } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }

    const userId = await seedRenterAt('Phoenix', 'AZ', 33.4484, -112.0740)
    const res = await get(userId)
    expect(res.status).toBe(200)
    expect(res.body.data.properties).toEqual([])
  })

  it('says so plainly when the renter could not be placed on a map', async () => {
    // An empty list here would read as "GAM has nowhere to live", which is a
    // different and much worse statement than "we could not find your address".
    await seedPlaceToLive('Mountain View RV Ranch', 'Amado', 'AZ', 31.705296, -111.064567)
    const c = await db.connect()
    let userId = ''
    try {
      await c.query('BEGIN')
      const { landlordId } = await seedLandlord(c)
      const u = await c.query<{ id: string }>(
        `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
         VALUES ($1,'x','tenant','No','Coords',TRUE) RETURNING id`,
        [`nogeo-${randomUUID()}@test.dev`])
      userId = u.rows[0].id
      const bc = await c.query<{ id: string }>(
        `INSERT INTO background_checks (landlord_id, user_id, consent_pool)
         VALUES ($1,$2,TRUE) RETURNING id`, [landlordId, userId])
      await c.query(
        `INSERT INTO application_pool
           (background_check_id, user_id, status, consent_pool, city, state, zip)
         VALUES ($1,$2,'available',TRUE,'Nowhere','TX','00000')`,
        [bc.rows[0].id, userId])
      await c.query('COMMIT')
    } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }

    const res = await get(userId)
    expect(res.status).toBe(409)
    expect(res.body.error).toMatch(/could not place your address/i)
  })

  it('refuses somebody who is not in the pool at all', async () => {
    const c = await db.connect()
    let userId = ''
    try {
      const u = await c.query<{ id: string }>(
        `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
         VALUES ($1,'x','tenant','Not','Pooled',TRUE) RETURNING id`,
        [`nopool-${randomUUID()}@test.dev`])
      userId = u.rows[0].id
    } finally { c.release() }
    expect((await get(userId)).status).toBe(404)
  })
})
