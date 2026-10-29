/**
 * 10/17 (Nic) — the census numbers behind the Metrics map's saturation
 * overlay. Nic: "overlay against census data and say, hey, look, we're in
 * Santa Cruz County and we are responsible for 30% of the population or 60% of
 * the total rental units ... so we can target areas that have room to grow.
 * Whereas if we're already highly saturated ... we may not want to have any
 * more marketing dollars spent there."
 *
 * The three denominators are each their own view — Nic: "show all. because we
 * are doing short term rentals as well as living situations. its not only
 * regular rentals. toggle each view/metric".
 *
 * The files are American Community Survey five-year bulk tables, cut by
 * apps/admin/scripts/build-census-saturation.mjs and kept in apps/api/census.
 * What matters here: the numbers are the Census's own, the codes are the SAME
 * codes the boundary files use (so the join is code to code, nothing matched by
 * name), and nothing is served to anyone but a super admin.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { randomUUID } from 'crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'fs'
import { join } from 'path'
import { gunzipSync } from 'zlib'
import {
  CENSUS_BASIS_SLOT, METRICS_CENSUS_BASES, METRICS_CENSUS_LEVELS, METRICS_MAP_LEVELS, formatShare, hasCensus,
  sharePercent,
} from '@gam/shared'
import { db } from '../db'
import { cleanupAllSchema } from '../test/dbHelpers'
import { adminRouter } from '../routes/admin'
import { errorHandler } from '../middleware/errorHandler'
import { CENSUS_DIR, censusFile, censusLevel, isCensusLevel, readCensus } from './platformCensus'
import { GEO_DIR } from './platformMetricsGeo'

const index = () => JSON.parse(readFileSync(join(CENSUS_DIR, 'index.json'), 'utf8'))

describe('the census files', () => {
  it('are on disk for every level the overlay offers, small, and say which survey they are', () => {
    const i = index()
    expect(i.about).toMatch(/build-census-saturation\.mjs/)
    expect(i.edition).toMatch(/American Community Survey/)
    // The three denominators, each named with the table it came from.
    expect(i.numbers.map((n: any) => n.table)).toEqual(['B01003_E001', 'B25001_E001', 'B25003_E003'])
    expect(i.numbers.map((n: any) => n.what)).toEqual(['total population', 'all housing units', 'renter-occupied homes'])

    for (const level of METRICS_CENSUS_LEVELS) {
      expect(existsSync(join(CENSUS_DIR, `${level}.json.gz`)), level).toBe(true)
      expect(i.levels[level].areas, level).toBeGreaterThan(0)
    }
    // The world's own levels are not U.S. Census counts; there is no file and
    // the page says so instead of drawing a percentage of nothing.
    for (const level of METRICS_MAP_LEVELS.filter(l => !hasCensus(l))) {
      expect(existsSync(join(CENSUS_DIR, `${level}.json.gz`)), level).toBe(false)
    }

    // Each is one fetch when the overlay is opened on that level; the two big
    // ones (every city, every ZIP code) stay a few hundred kilobytes.
    let bytes = 0
    for (const f of readdirSync(CENSUS_DIR)) bytes += statSync(join(CENSUS_DIR, f)).size
    expect(bytes).toBeLessThan(1.5e6)
    for (const level of METRICS_CENSUS_LEVELS) {
      expect(statSync(join(CENSUS_DIR, `${level}.json.gz`)).size, level).toBeLessThan(400e3)
    }
  })

  it("holds the Census's own numbers for Nic's own example", async () => {
    // Santa Cruz County, California — 266,021 people, 106,635 housing units,
    // 38,771 of them rented (ACS 2019–2023 five-year estimates).
    const county = await censusLevel('county')
    expect(county.numbers).toEqual(['total population', 'all housing units', 'renter-occupied homes'])
    expect(county.areas['06087']).toEqual([266021, 106635, 38771])
    // Each view divides by its own one of the three.
    expect(county.areas['06087'][CENSUS_BASIS_SLOT.people]).toBe(266021)
    expect(county.areas['06087'][CENSUS_BASIS_SLOT.homes]).toBe(106635)
    expect(county.areas['06087'][CENSUS_BASIS_SLOT.renter]).toBe(38771)
    // 1,240 spaces on GAM there would be 3.2% of its rental market.
    expect(formatShare(sharePercent(1240, county.areas['06087'][CENSUS_BASIS_SLOT.renter]))).toBe('3.2%')

    const state = await censusLevel('state')
    expect(state.areas['06']).toEqual([39242785, 14532683, 5940036])
    expect(Object.keys(state.areas)).toHaveLength(52)   // the 50 states, DC and Puerto Rico
  })

  it('every number is a whole count, and every area has all three', async () => {
    for (const level of METRICS_CENSUS_LEVELS) {
      const file = await censusLevel(level)
      const rows = Object.entries(file.areas)
      expect(rows.length, level).toBeGreaterThan(0)
      for (const [code, nums] of rows) {
        expect(nums, `${level} ${code}`).toHaveLength(3)
        for (const n of nums) expect(Number.isInteger(n) && n >= 0, `${level} ${code}`).toBe(true)
      }
      // A rented home is one of the housing units; it can never be more.
      for (const [code, [, homes, renter]] of rows) {
        expect(renter, `${level} ${code}`).toBeLessThanOrEqual(homes)
      }
    }
  })

  it('is keyed by the same codes the boundary files are, so the join is code to code', async () => {
    // 10/17: the overlay divides GAM's number for an area by the Census's
    // number for THE SAME area. Matched by name it would be guesswork; matched
    // by code it is exact — so a shape the map draws has a row under its own code.
    const topo = (rel: string) => JSON.parse(gunzipSync(readFileSync(join(GEO_DIR, `${rel}.json.gz`))).toString('utf8'))
    const ids = (rel: string) => topo(rel).objects.areas.geometries.map((g: any) => String(g.id)) as string[]
    const unmatchedIn = async (level: typeof METRICS_CENSUS_LEVELS[number], rel: string) => {
      const file = await censusLevel(level)
      return ids(rel).filter(id => !file.areas[id])
    }

    // Every state and every state house district, including the ones whose
    // codes are not all digits — Vermont's are "50R-B" and Maryland's "2401A",
    // and the two files have to spell them the same way.
    for (const state of ['04', '06', '17', '24', '31', '50', '72']) {
      expect(await unmatchedIn('sldu', `sldu/${state}`), `sldu/${state}`).toEqual([])
      if (!['31', '11'].includes(state)) expect(await unmatchedIn('sldl', `sldl/${state}`), `sldl/${state}`).toEqual([])
    }
    // The cities and ZIP code areas of the states GAM is in.
    for (const state of ['04', '06', '17', '31']) {
      expect(await unmatchedIn('place', `place/${state}`), `place/${state}`).toEqual([])
      expect(await unmatchedIn('zcta', `zcta/${state}`), `zcta/${state}`).toEqual([])
    }

    // WHERE THE SURVEY STOPS: the American Community Survey's own tables cover
    // the fifty states, DC and Puerto Rico. The four smaller territories have a
    // delegate's district in the boundary file and no row in the survey, so the
    // overlay has no denominator for them and says so rather than drawing a
    // percentage it cannot compute.
    expect(await unmatchedIn('cd', 'cd')).toEqual(['6698', '6098', '6998', '7898'])
  })

  it('a file is found only for a level that has census numbers — never from a path typed into the address', () => {
    expect(censusFile('county')).toBe(join(CENSUS_DIR, 'county.json.gz'))
    expect(censusFile('zcta')).toBe(join(CENSUS_DIR, 'zcta.json.gz'))
    for (const level of METRICS_CENSUS_LEVELS) expect(isCensusLevel(level), level).toBe(true)
    for (const bad of ['country', 'adm1', 'adm2', '../geo/index', 'county.json.gz', 'COUNTY', '', undefined, null, 7]) {
      expect(censusFile(bad), String(bad)).toBeNull()
      expect(isCensusLevel(bad), String(bad)).toBe(false)
    }
  })

  it('reads gzipped as it sits on disk, and unzips only for a client that asks for plain JSON', async () => {
    const gz = await readCensus('county', true)
    expect(gz!.gzipped).toBe(true)
    expect(JSON.parse(gunzipSync(gz!.body).toString('utf8')).areas['06087']).toEqual([266021, 106635, 38771])
    const plain = await readCensus('county', false)
    expect(plain!.gzipped).toBe(false)
    expect(JSON.parse(plain!.body.toString('utf8')).level).toBe('county')
    expect(await readCensus('adm2', true)).toBeNull()
  })
})

// ─── Behind admin login ─────────────────────────────────────────────────────

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/admin', adminRouter)
  app.use(errorHandler)
  return app
}

beforeEach(async () => {
  await cleanupAllSchema()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_platform_census'
})

async function tokenFor(role: 'super_admin' | 'admin') {
  const u = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
     VALUES ($1, 'x', $2, 'A', 'D', TRUE) RETURNING id`, [`${role}-${randomUUID()}@test.dev`, role])
  return jwt.sign({ userId: u.rows[0].id, role, email: 'x@test.dev', profileId: u.rows[0].id, permissions: {} },
    process.env.JWT_SECRET!, { expiresIn: '1h' })
}

describe('GET /api/admin/metrics/census/:level', () => {
  it('serves a level to a super admin, gzipped, cached a day', async () => {
    const token = await tokenFor('super_admin')
    const res = await request(buildApp()).get('/api/admin/metrics/census/county')
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    expect(res.headers['content-encoding']).toBe('gzip')
    expect(res.headers['content-type']).toMatch(/application\/json/)
    expect(res.headers['cache-control']).toBe('private, max-age=86400')
    expect(res.body.level).toBe('county')
    expect(res.body.edition).toMatch(/American Community Survey/)
    expect(res.body.areas['06087']).toEqual([266021, 106635, 38771])
    expect(METRICS_CENSUS_BASES.every(b => typeof res.body.areas['06087'][CENSUS_BASIS_SLOT[b]] === 'number')).toBe(true)
  })

  it('is not public, not for the admin role, and has nothing for a level with no census numbers', async () => {
    const app = buildApp()
    expect((await request(app).get('/api/admin/metrics/census/county')).status).toBe(401)
    const admin = await tokenFor('admin')
    expect((await request(app).get('/api/admin/metrics/census/county').set('Authorization', `Bearer ${admin}`)).status).toBe(403)
    const token = await tokenFor('super_admin')
    for (const level of ['country', 'adm1', 'adm2', 'nonsense', '..%2Findex', 'county.json.gz']) {
      const res = await request(app).get(`/api/admin/metrics/census/${level}`).set('Authorization', `Bearer ${token}`)
      expect(res.status, level).toBe(404)
      expect(res.body.error ?? res.body.message, level).toMatch(/census numbers/i)
    }
  })
})
