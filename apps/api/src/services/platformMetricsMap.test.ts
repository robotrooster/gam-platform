/**
 * 10/12 (Nic) — the Metrics page heat map: "toggleable at the state and county
 * levels. darker colors for more units in that area. toggleable between a heat
 * map for units and money."
 *
 * Each map must add up to its tile — units to "Spaces under management", money
 * to "Rent logged through GAM" — once the things that could not be placed
 * (named in `missing`) are added back. Nothing is placed by a guess.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { randomUUID } from 'crypto'
import { createRequire } from 'module'
import { readFileSync } from 'fs'
import { join, resolve } from 'path'
import type { PoolClient } from 'pg'
import { US_STATE_NAME } from '@gam/shared'
import { db } from '../db'
import {
  cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedTenant, seedLease, seedLeaseTenant,
} from '../test/dbHelpers'
import { adminRouter } from '../routes/admin'
import { errorHandler } from '../middleware/errorHandler'
import { clearPlatformMetricsCache, countyAt, MAP_STATE_FIPS } from './platformMetrics'

// Real places, from production's own properties and one Virginia enclave.
const AMADO_AZ = { lat: 31.705296, lng: -111.064567 }       // Santa Cruz County, AZ (04023)
const YARNELL_AZ = { lat: 34.221208, lng: -112.747564 }     // Yavapai County, AZ (04025)
const MATTOON_IL = { lat: 39.498682, lng: -88.369229 }      // Coles County, IL (17029)
const CHARLOTTESVILLE_VA = { lat: 38.0293, lng: -78.4767 }  // an independent city inside Albemarle County

describe('countyAt: a map location to its Census county', () => {
  it('places real locations in their county', async () => {
    expect(await countyAt(AMADO_AZ.lat, AMADO_AZ.lng)).toEqual({ fips: '04023', name: 'Santa Cruz' })
    expect(await countyAt(YARNELL_AZ.lat, YARNELL_AZ.lng)).toEqual({ fips: '04025', name: 'Yavapai' })
    expect(await countyAt(MATTOON_IL.lat, MATTOON_IL.lng)).toEqual({ fips: '17029', name: 'Coles' })
  })

  it('a county with a hole in it does not claim the place inside the hole', async () => {
    // Charlottesville is its own county-level area, cut out of Albemarle County.
    expect((await countyAt(CHARLOTTESVILLE_VA.lat, CHARLOTTESVILLE_VA.lng))?.fips).toBe('51540')
  })

  it('a location in the ocean or at 0,0 is in no county', async () => {
    expect(await countyAt(30, -140)).toBeNull()
    expect(await countyAt(0, 0)).toBeNull()
  })

  it('every state code names the same state the county shapes do', async () => {
    const topo: any = await import('./platformMetrics.counties-10m.json')
    const shapes = (topo.default ?? topo).objects.states.geometries as Array<{ id: string; properties: { name: string } }>
    const byFips = new Map(shapes.map(s => [s.id, s.properties.name]))
    for (const [abbr, name] of Object.entries(US_STATE_NAME)) {
      expect(MAP_STATE_FIPS[abbr], abbr).toBeTruthy()
      expect(byFips.get(MAP_STATE_FIPS[abbr]), abbr).toBe(name)
    }
    for (const abbr of ['AS', 'GU', 'MP', 'PR', 'VI']) expect(byFips.has(MAP_STATE_FIPS[abbr]), abbr).toBe(true)
  })

  // 10/12 (Nic) review: the server places properties in its own copy of the
  // shapes and the admin page draws them from its us-atlas package. Pinned to
  // the same edition, so every county code the server sends has a shape there
  // (a later edition redraws counties — Connecticut's 2022 planning regions).
  it('the admin page draws the same pinned edition of the county shapes the server places with', async () => {
    const adminDir = resolve(__dirname, '../../../admin')
    const adminPkg = JSON.parse(readFileSync(join(adminDir, 'package.json'), 'utf8'))
    expect(adminPkg.dependencies['us-atlas']).toBe('3.0.1')
    const fromAdmin = createRequire(join(adminDir, 'package.json'))
    expect(fromAdmin('us-atlas/package.json').version).toBe('3.0.1')
    // 10/13 (Nic): the flat map and the globe both draw the longitude/latitude
    // file (components/metricsMapGeo loadUsAtlas) — the very file the server
    // keeps beside this one, byte for byte. The territories are drawn on the
    // globe; the flat map's Albers USA picture leaves them out and names them.
    const drawnFile = readFileSync(fromAdmin.resolve('us-atlas/counties-10m.json'))
    const serverFile = readFileSync(join(__dirname, 'platformMetrics.counties-10m.json'))
    expect(serverFile.equals(drawnFile)).toBe(true)
    const drawn = JSON.parse(drawnFile.toString('utf8'))
    expect(drawn.objects.counties.geometries.length).toBeGreaterThan(3000)
    const loader = readFileSync(join(adminDir, 'src/components/metricsMapGeo.ts'), 'utf8')
    expect(loader).toContain("import('us-atlas/counties-10m.json')")
  })
})

// ─── The map in GET /api/admin/metrics ──────────────────────────────────────

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/admin', adminRouter)
  app.use(errorHandler)
  return app
}

beforeEach(async () => {
  await cleanupAllSchema()
  clearPlatformMetricsCache()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_admin_metrics_map'
})

async function metrics() {
  clearPlatformMetricsCache()
  const u = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
     VALUES ($1, 'x', 'super_admin', 'A', 'D', TRUE) RETURNING id`, [`sa-${randomUUID()}@test.dev`])
  const token = jwt.sign({ userId: u.rows[0].id, role: 'super_admin', email: 'x@test.dev', profileId: u.rows[0].id, permissions: {} },
    process.env.JWT_SECRET!, { expiresIn: '1h' })
  const res = await request(buildApp()).get('/api/admin/metrics').set('Authorization', `Bearer ${token}`)
  expect(res.status).toBe(200)
  return res.body.data
}

/** A property at a place, with `spaces` open spaces, one lease on the first, and rent paid on it. */
async function place(c: PoolClient, landlord: { userId: string; landlordId: string }, o: {
  state: string; at?: { lat: number; lng: number }; spaces: number; retired?: number; live?: boolean
  rent?: Array<{ amount: number; method: string }>
}) {
  const { userId, landlordId } = landlord
  const propertyId = await seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: userId })
  await c.query(`UPDATE properties SET state = $2, latitude = $3, longitude = $4 WHERE id = $1`,
    [propertyId, o.state, o.at?.lat ?? null, o.at?.lng ?? null])
  const units: string[] = []
  for (let i = 0; i < o.spaces + (o.retired ?? 0); i++) units.push(await seedUnit(c, { propertyId, landlordId }))
  for (const u of units.slice(o.spaces)) await c.query(`UPDATE units SET retired_at = NOW() WHERE id = $1`, [u])
  if (o.live === false) return { propertyId, unitId: units[0] }
  const tenantId = await seedTenant(c)
  const leaseId = await seedLease(c, { unitId: units[0], landlordId, rentAmount: 500 })
  await seedLeaseTenant(c, { leaseId, tenantId })
  let due = 0
  for (const r of o.rent ?? []) {
    const p = await c.query<{ id: string }>(
      `INSERT INTO payments (unit_id, tenant_id, landlord_id, lease_id, type, amount, status, entry_description, due_date)
       VALUES ($1,$2,$3,$4,'rent',$5,'settled','RENT',CURRENT_DATE - $6::int) RETURNING id`,
      [units[0], tenantId, landlordId, leaseId, r.amount, due++])
    const electronic = r.method === 'card' || r.method === 'ach'
    const rem = await c.query<{ id: string }>(
      `INSERT INTO tenant_remittances (tenant_id, landlord_id, lease_id, amount, applied_amount, status,
                                       payment_method, stripe_payment_intent_id, settled_at)
       VALUES ($1,$2,$3,$4,$4,'settled',$5,$6,NOW()) RETURNING id`,
      [tenantId, landlordId, leaseId, r.amount, r.method, electronic ? `pi_${randomUUID()}` : null])
    await c.query(`INSERT INTO remittance_applications (remittance_id, payment_id, amount_applied) VALUES ($1,$2,$3)`,
      [rem.rows[0].id, p.rows[0].id, r.amount])
  }
  return { propertyId, unitId: units[0], tenantId, leaseId }
}

async function inTx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const out = await fn(c)
    await c.query('COMMIT')
    return out
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

const sum = (xs: any[], k: 'units' | 'occupied' | 'money' | 'properties') => xs.reduce((s, x) => s + x[k], 0)

describe('GET /api/admin/metrics: the heat map', () => {
  it('totals units and rent by state and county, and adds up to the tiles with what it could not place', async () => {
    const fx = await inTx(async c => {
      const a = await seedLandlord(c)
      // Santa Cruz County, AZ: 3 open spaces (a retired one is gone), $1,500 rent.
      const amado = await place(c, a, { state: 'AZ', at: AMADO_AZ, spaces: 3, retired: 1,
        rent: [{ amount: 1000, method: 'card' }, { amount: 500, method: 'cash' }] })
      // Yavapai County, AZ: 1 space, $300 rent by check.
      await place(c, a, { state: 'AZ', at: YARNELL_AZ, spaces: 1, rent: [{ amount: 300, method: 'check' }] })
      // Coles County, IL: 2 spaces, no rent yet.
      await place(c, a, { state: 'IL', at: MATTOON_IL, spaces: 2 })
      // Arizona, but no map location on file: on the state map only.
      await place(c, a, { state: 'AZ', spaces: 1, rent: [{ amount: 200, method: 'ach' }] })
      // The address says North Carolina; the map location is in Arizona: NC on the state map, no county.
      await place(c, a, { state: 'nc', at: AMADO_AZ, spaces: 1 })
      // A state GAM cannot read: on neither map.
      await place(c, a, { state: 'ZZ', at: MATTOON_IL, spaces: 1, rent: [{ amount: 40, method: 'cash' }] })
      // Never went live (no lease, no stay, no billed month): not on GAM yet, not on the map.
      await place(c, a, { state: 'UT', at: YARNELL_AZ, spaces: 4, live: false })

      // Rent on a bill with no space and no lease on record: logged, but there is nowhere to put it.
      const t = await seedTenant(c)
      const bill = await c.query<{ id: string }>(
        `INSERT INTO payments (tenant_id, landlord_id, type, amount, status, entry_description, due_date)
         VALUES ($1,$2,'rent',25,'settled','RENT',CURRENT_DATE) RETURNING id`, [t, a.landlordId])
      const rem = await c.query<{ id: string }>(
        `INSERT INTO tenant_remittances (tenant_id, landlord_id, amount, applied_amount, status, payment_method, settled_at)
         VALUES ($1,$2,25,25,'settled','cash',NOW()) RETURNING id`, [t, a.landlordId])
      await c.query(`INSERT INTO remittance_applications (remittance_id, payment_id, amount_applied) VALUES ($1,$2,25)`,
        [rem.rows[0].id, bill.rows[0].id])

      // A demo landlord in Santa Cruz County: left out of everything.
      const demo = await seedLandlord(c)
      await c.query(`UPDATE landlords SET is_demo = TRUE WHERE id = $1`, [demo.landlordId])
      await place(c, demo, { state: 'AZ', at: AMADO_AZ, spaces: 9, rent: [{ amount: 9999, method: 'card' }] })
      return { amado }
    })

    const m = await metrics()
    const map = m.map
    const state = Object.fromEntries(map.states.map((s: any) => [s.abbr, s]))
    const county = Object.fromEntries(map.counties.map((x: any) => [x.fips, x]))
    const missing = Object.fromEntries(map.missing.map((x: any) => [x.reason, x]))

    expect(state.AZ).toMatchObject({ fips: '04', name: 'Arizona', units: 5, money: 2000, properties: 3 })
    expect(state.IL).toMatchObject({ fips: '17', name: 'Illinois', units: 2, money: 0, properties: 1 })
    expect(state.NC).toMatchObject({ fips: '37', name: 'North Carolina', units: 1, money: 0, properties: 1 })
    expect(state.UT).toBeUndefined()
    expect(Object.keys(state).sort()).toEqual(['AZ', 'IL', 'NC'])

    expect(county['04023']).toMatchObject({ name: 'Santa Cruz', state: 'AZ', units: 3, money: 1500, properties: 1 })
    expect(county['04025']).toMatchObject({ name: 'Yavapai', state: 'AZ', units: 1, money: 300, properties: 1 })
    expect(county['17029']).toMatchObject({ name: 'Coles', state: 'IL', units: 2, money: 0, properties: 1 })
    expect(map.counties).toHaveLength(3)

    expect(missing.no_location).toMatchObject({ offStateMap: false, properties: 1, units: 1, money: 200 })
    expect(missing.wrong_state).toMatchObject({ offStateMap: false, properties: 1, units: 1, money: 0 })
    expect(missing.unknown_state).toMatchObject({ offStateMap: true, properties: 1, units: 1, money: 40 })
    expect(missing.no_property).toMatchObject({ offStateMap: true, properties: 0, units: 0, money: 25 })
    expect(missing.outside_map).toBeUndefined()
    for (const x of map.missing) expect(x.label).toMatch(/^[a-z]/)   // words, never the code

    // Each map + what it could not place = the tile.
    const offState = map.missing.filter((x: any) => x.offStateMap)
    expect(m.footprint.units).toBe(9)
    expect(sum(map.states, 'units') + sum(offState, 'units')).toBe(m.footprint.units)
    expect(sum(map.counties, 'units') + sum(map.missing, 'units')).toBe(m.footprint.units)
    expect(m.rent.logged.total).toBeCloseTo(2065, 2)
    expect(sum(map.states, 'money') + sum(offState, 'money')).toBeCloseTo(m.rent.logged.total, 2)
    expect(sum(map.counties, 'money') + sum(map.missing, 'money')).toBeCloseTo(m.rent.logged.total, 2)
    expect(fx.amado.propertyId).toBeTruthy()

    // 10/12 (Nic, H1): occupied the way GAM bills — every live place leases its
    // first space and no other — adds up to the tile's occupied figure the same way.
    expect(state.AZ.occupied).toBe(3)
    expect(state.IL.occupied).toBe(1)
    expect(state.NC.occupied).toBe(1)
    expect(county['04023'].occupied).toBe(1)
    expect(missing.unknown_state.occupied).toBe(1)
    expect(missing.no_property.occupied).toBe(0)
    expect(m.footprint).toMatchObject({ occupiedSpaces: 6, vacantSpaces: 3 })
    expect(sum(map.states, 'occupied') + sum(offState, 'occupied')).toBe(m.footprint.occupiedSpaces)
    expect(sum(map.counties, 'occupied') + sum(map.missing, 'occupied')).toBe(m.footprint.occupiedSpaces)
  })

  it('a disputed rent payment and its re-payment count once, in the county the rent was for', async () => {
    const w = await inTx(async c => {
      const a = await seedLandlord(c)
      return { ...(await place(c, a, { state: 'AZ', at: YARNELL_AZ, spaces: 1 })), landlordId: a.landlordId }
    })
    const bill = async (reversalId: string | null) => (await db.query<{ id: string }>(
      `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, entry_description,
                             due_date, reversal_id, settled_at)
       VALUES ($1,$2,$3,$4,'rent',460,'settled','RENT',CURRENT_DATE - 20,$5,NOW()) RETURNING id`,
      [w.unitId, w.leaseId, w.tenantId, w.landlordId, reversalId])).rows[0].id
    const pay = async (paymentId: string, method: string) => {
      const r = (await db.query<{ id: string }>(
        `INSERT INTO tenant_remittances (tenant_id, landlord_id, lease_id, amount, applied_amount, status,
                                         payment_method, stripe_payment_intent_id, settled_at)
         VALUES ($1,$2,$3,460,460,'settled',$4,$5,NOW()) RETURNING id`,
        [w.tenantId, w.landlordId, w.leaseId, method, method === 'card' ? `pi_${randomUUID()}` : null])).rows[0].id
      await db.query(`INSERT INTO remittance_applications (remittance_id, payment_id, amount_applied) VALUES ($1,$2,460)`,
        [r, paymentId])
    }
    const original = await bill(null)
    await pay(original, 'card')
    const rev = (await db.query<{ id: string }>(
      `INSERT INTO payment_reversals (payment_id, landlord_id, tenant_id, lease_id, reversal_type, reversed_amount,
                                      stripe_event_id, raw_event)
       VALUES ($1,$2,$3,$4,'card_dispute',460,$5,'{}') RETURNING id`,
      [original, w.landlordId, w.tenantId, w.leaseId, `evt_${randomUUID()}`])).rows[0].id
    await db.query(`UPDATE payments SET status = 'returned' WHERE id = $1`, [original])
    await pay(await bill(rev), 'cash')

    const m = await metrics()
    expect(m.rent.logged.total).toBeCloseTo(460, 2)
    expect(m.map.counties).toHaveLength(1)
    expect(m.map.counties[0]).toMatchObject({ fips: '04025', money: 460, units: 1 })
    expect(m.map.states[0]).toMatchObject({ abbr: 'AZ', money: 460, units: 1 })
    expect(m.map.missing).toEqual([])
  })

  // 10/12 (Nic) review: an address edit does not look the map location up
  // again, so a point found for the old address would put the property in the
  // old county with no warning. Named under the map instead, never placed.
  it('a property whose address changed after its map location was found is named, not placed in the old county', async () => {
    const ids = await inTx(async c => {
      const a = await seedLandlord(c)
      const located = async (o: { at: { lat: number; lng: number }; spaces: number; rent: number;
                                  level: 'geocoded' | 'parcel' | 'unverified'; foundDaysAgo: number | null;
                                  editedDaysAgo: number | null }) => {
        const p = await place(c, a, { state: 'AZ', at: o.at, spaces: o.spaces, rent: [{ amount: o.rent, method: 'check' }] })
        await c.query(
          `UPDATE properties SET address_verification = $2,
                  address_verified_at = CASE WHEN $3::int IS NULL THEN NULL ELSE NOW() - make_interval(days => $3::int) END
            WHERE id = $1`, [p.propertyId, o.level, o.foundDaysAgo])
        if (o.editedDaysAgo != null) {
          await c.query(
            `INSERT INTO audit_log (user_id, action, entity_type, entity_id, old_value, new_value, created_at)
             VALUES ($1, 'property_address_changed', 'property', $2, '{"street1":"1 Old Rd"}', '{"street1":"2 New Rd"}',
                     NOW() - make_interval(days => $3::int))`, [a.userId, p.propertyId, o.editedDaysAgo])
        }
        return p.propertyId
      }
      // Found 30 days ago, address edited 5 days ago, never looked up again: stale.
      const stale = await located({ at: YARNELL_AZ, spaces: 2, rent: 100, level: 'geocoded', foundDaysAgo: 30, editedDaysAgo: 5 })
      // Edited, then a look-up that found it ran after the edit: placed.
      const relooked = await located({ at: AMADO_AZ, spaces: 3, rent: 200, level: 'geocoded', foundDaysAgo: 1, editedDaysAgo: 5 })
      // Edited, then a look-up after the edit found nothing (the old point was kept): stale.
      const triedAndFailed = await located({ at: AMADO_AZ, spaces: 1, rent: 40, level: 'unverified', foundDaysAgo: 1, editedDaysAgo: 5 })
      // A point with no look-up on record and an edit: nothing says the point is for the new address.
      const neverLooked = await located({ at: YARNELL_AZ, spaces: 1, rent: 10, level: 'unverified', foundDaysAgo: null, editedDaysAgo: 5 })
      // Never edited: placed, whatever its look-up history.
      const untouched = await located({ at: YARNELL_AZ, spaces: 4, rent: 300, level: 'unverified', foundDaysAgo: 90, editedDaysAgo: null })
      return { stale, relooked, triedAndFailed, neverLooked, untouched }
    })

    const m = await metrics()
    const county = Object.fromEntries(m.map.counties.map((x: any) => [x.fips, x]))
    const missing = Object.fromEntries(m.map.missing.map((x: any) => [x.reason, x]))

    expect(county['04023']).toMatchObject({ units: 3, money: 200, properties: 1 })   // relooked only
    expect(county['04025']).toMatchObject({ units: 4, money: 300, properties: 1 })   // untouched only
    expect(missing.stale_location).toMatchObject({ offStateMap: false, properties: 3, units: 4, money: 150 })
    expect(missing.stale_location.label).toBe('its address changed and no map location has been found for the new address')
    // Still on the state map by its address, and every map still adds up to the tiles.
    expect(m.map.states).toHaveLength(1)
    expect(m.map.states[0]).toMatchObject({ abbr: 'AZ', units: 11, money: 650, properties: 5 })
    expect(sum(m.map.counties, 'units') + sum(m.map.missing, 'units')).toBe(m.footprint.units)
    expect(sum(m.map.counties, 'money') + sum(m.map.missing, 'money')).toBeCloseTo(m.rent.logged.total, 2)
    expect(ids.stale).toBeTruthy()
  })

  it('nothing live and no rent: empty maps, nothing missing', async () => {
    const m = await metrics()
    const { levels, ...map } = m.map
    expect(map).toEqual({ states: [], counties: [], missing: [] })
    // 10/13 (Nic): the city, district and ZIP code maps are empty too.
    expect(Object.keys(levels).sort()).toEqual(['cd', 'place', 'sldl', 'sldu', 'zcta'])
    for (const l of Object.values(levels) as any[]) {
      expect(l.areas).toEqual([])
      expect(l.missing).toEqual([])
    }
  })
})
