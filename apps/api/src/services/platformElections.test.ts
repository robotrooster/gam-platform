/**
 * 10/18 (Nic) — the election results behind the Metrics map's lean overlay.
 * Nic: "the overlay to show which way those certain districts vote, and where
 * our strong areas tend to be in Democratic areas or Republican areas, for the
 * landlord onboarding process and total unit count."
 *
 * AND NOT ONLY PRESIDENTIAL, the same day: "I don't only want presidential
 * stuff, I want mayor data, governor data, city council data, voting on public
 * policy, whether it's left-leaning or conservative. I want the data at every
 * level that we can get it... get what you can for now." So what matters here
 * is the SHAPE as much as the numbers: an area, a contest (an office and a
 * year with its two sides named), and a margin — a governor's race or a ballot
 * measure has to drop in without reshaping anything.
 *
 * ONLY COUNTIES ARE EXACT. There is one file, the county one, because these
 * returns are published county by county; every other level has none and the
 * page says so rather than carrying a district margin nobody reported.
 *
 * The file is built by apps/admin/scripts/build-election-results.mjs and kept
 * in apps/api/elections. What matters: the margins are the votes' own
 * arithmetic, the codes are the SAME codes the boundary files use (so the join
 * is code to code, nothing matched by name), a state that did not report by
 * county is left out BY NAME with the reason instead of being joined to the
 * wrong areas, and nothing is served to anyone but a super admin.
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
  METRICS_ELECTION_LEVELS, METRICS_ELECTION_OFFICES, METRICS_LEAN_FULL, METRICS_MAP_LEVELS,
  hasElections, marginText, offersLean,
} from '@gam/shared'
import { db } from '../db'
import { cleanupAllSchema } from '../test/dbHelpers'
import { adminRouter } from '../routes/admin'
import { errorHandler } from '../middleware/errorHandler'
import { ELECTIONS_DIR, electionsFile, electionsLevel, isElectionLevel, readElections } from './platformElections'
import { GEO_DIR } from './platformMetricsGeo'
import { censusLevel } from './platformCensus'

const index = () => JSON.parse(readFileSync(join(ELECTIONS_DIR, 'index.json'), 'utf8'))

describe('the election files', () => {
  it('are on disk for every level that has results, small, and say how a margin is worked out', () => {
    const i = index()
    expect(i.about).toMatch(/build-election-results\.mjs/)
    // One number, one meaning, whatever the office.
    expect(i.margin).toMatch(/right minus votes on the left, over every vote cast/i)
    expect(i.shape).toMatch(/office and a year/i)

    for (const level of METRICS_ELECTION_LEVELS) {
      expect(existsSync(join(ELECTIONS_DIR, `${level}.json.gz`)), level).toBe(true)
      expect(i.levels[level].areas, level).toBeGreaterThan(3000)
    }
    // ONLY COUNTIES ARE EXACT: no file for any other level, and none invented.
    expect(METRICS_ELECTION_LEVELS).toEqual(['county'])
    for (const level of METRICS_MAP_LEVELS.filter(l => !hasElections(l))) {
      expect(existsSync(join(ELECTIONS_DIR, `${level}.json.gz`)), level).toBe(false)
    }
    // The overlay is still offered at every United States level (it says so on
    // screen there), and never at a world one — these are U.S. returns.
    for (const level of METRICS_MAP_LEVELS) {
      expect(offersLean(level), level).toBe(!['country', 'adm1', 'adm2'].includes(level))
    }

    // One fetch when the overlay is opened, so it stays small.
    let bytes = 0
    for (const f of readdirSync(ELECTIONS_DIR)) bytes += statSync(join(ELECTIONS_DIR, f)).size
    expect(bytes).toBeLessThan(400e3)
  })

  it('holds a contest, its two sides and its source — not a presidency', async () => {
    // The shape is what lets a governor's race, a mayor or a ballot measure
    // drop in later without reshaping anything.
    const county = await electionsLevel('county')
    expect(county.level).toBe('county')
    expect(county.contests.map(c => c.id)).toEqual(['president-2024', 'president-2020', 'president-2016'])
    for (const c of county.contests) {
      expect(METRICS_ELECTION_OFFICES, c.id).toContain(c.office)
      expect(c.year, c.id).toBeGreaterThan(2000)
      expect(c.label, c.id).toMatch(/^\d{4} .+ margin$/)
      // The two sides are NAMED, so nothing on the page assumes the words.
      expect(c.right, c.id).toBe('Republican')
      expect(c.left, c.id).toBe('Democratic')
      // 10/19: this pinned the phrase "public data", which came from a credit
      // line that called these OFFICIAL county returns. They are not — they are
      // compiled from news-outlet reporting, and the line now says so. What the
      // test is actually for is that every contest states where it came from, so
      // nothing on the page shows a margin with no provenance.
      expect(c.source, c.id).toBeTruthy()
      expect((c.source ?? '').length, c.id).toBeGreaterThan(20)
      expect(c.areas, c.id).toBeGreaterThan(3000)
    }
    // Newest first: that is the order the overlay offers them in, so the color
    // is the latest result until he picks another.
    expect(county.contests.map(c => c.year)).toEqual([...county.contests.map(c => c.year)].sort((a, b) => b - a))
  })

  it("is the votes' own arithmetic, for Nic's own county", async () => {
    // Santa Cruz County, Arizona (04023) in 2024: 11,265 Democratic, 7,699
    // Republican, 19,121 votes cast — Democratic by 18.6 points. In 2016 it
    // was Democratic by 47.1, which is the swing he wants to be able to read.
    const county = await electionsLevel('county')
    const santaCruz = county.areas['04023']
    expect(santaCruz['president-2024']).toEqual({ m: -18.6, r: 7699, l: 11265, t: 19121 })
    expect(santaCruz['president-2020'].m).toBe(-35.5)
    expect(santaCruz['president-2016'].m).toBe(-47.1)
    expect(marginText(santaCruz['president-2024'].m, 'Republican', 'Democratic')).toBe('Democratic +18.6')

    // Every margin is the votes, divided the one way, in percentage points.
    for (const [code, results] of Object.entries(county.areas)) {
      for (const [id, r] of Object.entries(results)) {
        expect(Math.abs(r.m), `${code} ${id}`).toBeLessThanOrEqual(100)
        expect(r.t, `${code} ${id}`).toBeGreaterThan(0)
        expect(r.r! + r.l!, `${code} ${id}`).toBeLessThanOrEqual(r.t!)
        expect(r.m, `${code} ${id}`).toBeCloseTo(Math.round(((r.r! - r.l!) / r.t!) * 1000) / 10, 6)
      }
    }
  })

  it('is keyed by the same codes the map draws, so the join is code to code', async () => {
    // The overlay colors a shape the map draws by the result under that
    // shape's own code. Matched by name it would be guesswork.
    const atlas = require('us-atlas/counties-10m.json')
    const shapes: string[] = atlas.objects.counties.geometries.map((g: any) => String(g.id))
    const county = await electionsLevel('county')
    const newest = county.contests[0].id

    // Nearly every county the map draws has a result, and every code in the
    // file is a county either the map or the Census file knows (the two differ
    // on Connecticut, which replaced its counties with planning regions).
    const census = await censusLevel('county')
    const known = new Set([...shapes, ...Object.keys(census.areas)])
    expect(Object.keys(county.areas).filter(code => !known.has(code))).toEqual([])
    const withNewest = shapes.filter(id => county.areas[id]?.[newest])
    expect(withNewest.length).toBeGreaterThan(3050)

    // WHERE A STATE DID NOT REPORT BY COUNTY, it is left out by name with the
    // reason — never joined to the wrong areas. Alaska reports by state house
    // district, and three of its 2024 district numbers are also real borough
    // codes (02013 is both), so a join would have hung a district's margin on
    // a borough. The District of Columbia's 2024 rows are its wards, and Ward
    // 1's number IS the District's own county code.
    const gaps2024 = county.contests[0].gaps ?? {}
    expect(Object.keys(gaps2024).sort()).toEqual(['02', '11'])
    expect(gaps2024['02'].name).toBe('Alaska')
    expect(gaps2024['02'].why).toContain('not by county')
    expect(gaps2024['11'].why).toContain('not by county')
    for (const code of ['02013', '02020', '11001']) {
      expect(county.areas[code]?.['president-2024'], code).toBeUndefined()
    }
    // Alaska is out of all three, the 2016 one because that cut carries one
    // statewide figure under every borough's code.
    for (const c of county.contests) expect(Object.keys(c.gaps ?? {}), c.id).toContain('02')
    expect(county.contests[2].gaps!['02'].why).toContain('one figure for the whole state')

    // Connecticut's 2024 result is by planning region, so its counties read
    // their 2020 and 2016 margins and the page says the 2024 one is not
    // reported for them — rather than a wrong number under a county's code.
    expect(county.areas['09001']['president-2024']).toBeUndefined()
    expect(county.areas['09001']['president-2020'].m).toBe(-27.2)
    expect(county.areas['09110']['president-2024'].m).toBe(-21.9)
  })

  it('every county the overlay draws reads inside the scale it is drawn on', async () => {
    const county = await electionsLevel('county')
    const margins = Object.values(county.areas).map(r => r['president-2024']?.m).filter((m): m is number => m != null)
    // The color tops out at 60 points either way; most counties are inside it
    // and the ones past it are held at the end of the key, which is why that
    // is where the scale stops (METRICS_LEAN_FULL).
    expect(METRICS_LEAN_FULL).toBe(60)
    expect(margins.filter(m => Math.abs(m) <= METRICS_LEAN_FULL).length / margins.length).toBeGreaterThan(0.6)
    expect(Math.min(...margins)).toBeGreaterThan(-100)
    expect(Math.max(...margins)).toBeLessThan(100)
  })

  it('a file is found only for a level that has results — never from a path typed into the address', () => {
    expect(electionsFile('county')).toBe(join(ELECTIONS_DIR, 'county.json.gz'))
    for (const level of METRICS_ELECTION_LEVELS) expect(isElectionLevel(level), level).toBe(true)
    for (const bad of ['state', 'cd', 'zcta', 'country', '../geo/index', 'county.json.gz', 'COUNTY', '', undefined, null, 7]) {
      expect(electionsFile(bad), String(bad)).toBeNull()
      expect(isElectionLevel(bad), String(bad)).toBe(false)
    }
    expect(GEO_DIR).not.toBe(ELECTIONS_DIR)
  })

  it('reads gzipped as it sits on disk, and unzips only for a client that asks for plain JSON', async () => {
    const gz = await readElections('county', true)
    expect(gz!.gzipped).toBe(true)
    expect(JSON.parse(gunzipSync(gz!.body).toString('utf8')).areas['04023']['president-2024'].m).toBe(-18.6)
    const plain = await readElections('county', false)
    expect(plain!.gzipped).toBe(false)
    expect(JSON.parse(plain!.body.toString('utf8')).level).toBe('county')
    expect(await readElections('cd', true)).toBeNull()
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
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_platform_elections'
})

async function tokenFor(role: 'super_admin' | 'admin') {
  const u = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
     VALUES ($1, 'x', $2, 'A', 'D', TRUE) RETURNING id`, [`${role}-${randomUUID()}@test.dev`, role])
  return jwt.sign({ userId: u.rows[0].id, role, email: 'x@test.dev', profileId: u.rows[0].id, permissions: {} },
    process.env.JWT_SECRET!, { expiresIn: '1h' })
}

describe('GET /api/admin/metrics/elections/:level', () => {
  it('serves the county level to a super admin, gzipped, cached a day', async () => {
    const token = await tokenFor('super_admin')
    const res = await request(buildApp()).get('/api/admin/metrics/elections/county')
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    expect(res.headers['content-encoding']).toBe('gzip')
    expect(res.headers['content-type']).toMatch(/application\/json/)
    expect(res.headers['cache-control']).toBe('private, max-age=86400')
    expect(res.body.level).toBe('county')
    expect(res.body.contests[0].label).toBe('2024 presidential margin')
    expect(res.body.areas['04023']['president-2024'].m).toBe(-18.6)
  })

  it('is not public, not for the admin role, and has nothing for a level with no results', async () => {
    const app = buildApp()
    expect((await request(app).get('/api/admin/metrics/elections/county')).status).toBe(401)
    const admin = await tokenFor('admin')
    expect((await request(app).get('/api/admin/metrics/elections/county').set('Authorization', `Bearer ${admin}`)).status).toBe(403)
    const token = await tokenFor('super_admin')
    // Every level with no file, and anything typed into the address.
    for (const level of ['state', 'cd', 'sldu', 'sldl', 'place', 'zcta', 'country', 'adm1', 'adm2',
      'nonsense', '..%2Findex', 'county.json.gz']) {
      const res = await request(app).get(`/api/admin/metrics/elections/${level}`).set('Authorization', `Bearer ${token}`)
      expect(res.status, level).toBe(404)
      expect(res.body.error ?? res.body.message, level).toMatch(/election results/i)
    }
  })
})
