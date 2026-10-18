/**
 * 10/13 (Nic) — the Metrics map's new levels: "toggle levels for cities,
 * congressional districts, state legislative districts (senate and house), and
 * ZIP codes". The shapes are Census boundary files kept beside the API
 * (apps/api/geo, built by apps/admin/scripts/build-geo-boundaries.mjs) and
 * served to the admin page behind admin login — never from an outside site.
 *
 * Every level must add up to the tiles once what it could not place (named,
 * with the reason) is added back — the same rule as the state and county maps.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { randomUUID } from 'crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'fs'
import { join } from 'path'
import { gunzipSync } from 'zlib'
import type { PoolClient } from 'pg'
import { METRICS_BOUNDARY_LAYERS, METRICS_MAP_STATE_LEVELS } from '@gam/shared'
import { db } from '../db'
import {
  cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedTenant, seedLease, seedLeaseTenant,
} from '../test/dbHelpers'
import { adminRouter } from '../routes/admin'
import { errorHandler } from '../middleware/errorHandler'
import { clearPlatformMetricsCache, MAP_STATE_FIPS } from './platformMetrics'
import { boundaryFile, buildMapLevels, cityKey, GEO_DIR, type GeoRow } from './platformMetricsGeo'

// Real places — production's own properties, and a few the rules need.
const YARNELL_AZ = { lat: 34.221208, lng: -112.747564 }
const AMADO_AZ = { lat: 31.705296, lng: -111.064567 }
const MATTOON_IL = { lat: 39.498682, lng: -88.369229 }
const DOWNTOWN_PHOENIX = { lat: 33.4484, lng: -112.0740 }
const LINCOLN_NE = { lat: 40.8136, lng: -96.7026 }

const row = (o: Partial<GeoRow>): GeoRow => ({
  property_id: randomUUID(), state: 'AZ', city: null, zip: null, lat: null, lng: null,
  location_stale: false, units: 1, occupied: 1, money: '0', ...o,
})
const only = async (o: Partial<GeoRow>) => buildMapLevels([row(o)], MAP_STATE_FIPS)
/** 10/17 (Nic): the United States' own levels, and the rest of the world's. */
const US_LAYERS = ['place', 'cd', 'sldu', 'sldl', 'zcta'] as const
const WORLD_LAYERS = ['country', 'adm1', 'adm2'] as const
const placed = (levels: any) => Object.fromEntries(Object.entries(levels).map(([k, v]: any) =>
  [k, v.areas.length ? `${v.areas[0].fips} ${v.areas[0].name}` : v.missing.map((m: any) => m.reason).join(',')]))

describe('the boundary files', () => {
  it('are on disk for every level, small, and say where they came from', () => {
    const index = JSON.parse(readFileSync(join(GEO_DIR, 'index.json'), 'utf8'))
    // 10/17 (Nic): the United States' levels are Census; the rest of the
    // world's are Natural Earth and geoBoundaries, and geoBoundaries' licence
    // has to be named — Nic: "Credit geoBoundaries on the map (CC BY 4.0)".
    for (const layer of ['place', 'cd', 'sldu', 'sldl', 'zcta'] as const) {
      expect(index.layers[layer]?.edition, layer).toMatch(/Census/)
    }
    for (const layer of ['country', 'adm1'] as const) {
      expect(index.layers[layer]?.edition, layer).toMatch(/Natural Earth/)
    }
    expect(index.layers.adm2.edition).toMatch(/geoBoundaries/)
    expect(index.layers.adm2.edition).toMatch(/CC BY 4\.0/)
    for (const layer of METRICS_BOUNDARY_LAYERS) expect(index.layers[layer]?.edition, layer).toBeTruthy()
    expect(index.about).toMatch(/build-geo-boundaries\.mjs/)
    let bytes = 0
    const walk = (dir: string) => {
      for (const f of readdirSync(dir)) {
        const p = join(dir, f)
        if (statSync(p).isDirectory()) walk(p); else bytes += statSync(p).size
      }
    }
    walk(GEO_DIR)
    // Nic: keep what is committed small.
    expect(bytes).toBeLessThan(20e6)
    // 10/17: the land around the United States, for the globe (Natural Earth,
    // not Census), one shape per country and the United States left out.
    expect(index.layers.world).toMatchObject({ file: 'world.json.gz' })
    expect(index.layers.world.edition).toMatch(/Natural Earth/)
    expect(existsSync(join(GEO_DIR, 'world.json.gz'))).toBe(true)
    // It is fetched on every globe, so it stays a few hundred kilobytes.
    expect(statSync(join(GEO_DIR, 'world.json.gz')).size).toBeLessThan(400e3)
    // Fifty states, DC and Puerto Rico have state senate districts; Nebraska
    // (one chamber) and DC have no state house districts.
    expect(index.layers.sldu.states).toEqual(expect.arrayContaining(['04', '11', '31', '72']))
    expect(index.layers.sldl.states).not.toContain('31')
    expect(index.layers.sldl.states).not.toContain('11')
    for (const layer of METRICS_MAP_STATE_LEVELS) {
      for (const s of index.layers[layer].states) expect(existsSync(join(GEO_DIR, layer, `${s}.json.gz`)), `${layer}/${s}`).toBe(true)
    }

    // 10/17 (Nic): the rest of the world. Countries and provinces are one file
    // each, drawn and placed in at the same detail; the level below a province
    // is one file per country, so the page loads only the country on screen.
    expect(index.layers.country).toMatchObject({ file: 'country.json.gz' })
    expect(index.layers.adm1).toMatchObject({ file: 'adm1.json.gz' })
    for (const f of ['country.json.gz', 'adm1.json.gz']) {
      // Each is one fetch when a world level is opened, so each stays small.
      expect(statSync(join(GEO_DIR, f)).size, f).toBeLessThan(1.5e6)
    }
    // Nic: "if they have counties within those provinces" — the countries that
    // have that level have a file and the rest have none, which IS the rule.
    expect(index.layers.adm2.countries.length).toBeGreaterThan(150)
    expect(index.layers.adm2.countries).toEqual(expect.arrayContaining(['USA', 'CAN', 'MEX', 'BRA', 'GBR']))
    expect(index.layers.adm2.countries).not.toContain('HKG')
    for (const c of index.layers.adm2.countries) {
      expect(/^[A-Z]{3}$/.test(c), c).toBe(true)
      expect(existsSync(join(GEO_DIR, 'adm2', `${c}.json.gz`)), `adm2/${c}`).toBe(true)
    }
  })

  it('the countries and provinces carry their country, so one file can name "Entre Ríos, Argentina"', () => {
    const topo = JSON.parse(gunzipSync(readFileSync(join(GEO_DIR, 'adm1.json.gz'))).toString('utf8'))
    const geoms = topo.objects.areas.geometries as Array<{ id: string; properties: any }>
    expect(geoms.length).toBeGreaterThan(4000)
    for (const g of geoms) {
      expect(/^[A-Z]{3}$/.test(g.properties.country), g.id).toBe(true)
      expect(g.properties.countryName, g.id).toBeTruthy()
      expect(g.properties.name, g.id).toBeTruthy()
    }
    const entre = geoms.find(g => g.properties.name === 'Entre Ríos')
    expect(entre?.properties).toMatchObject({ country: 'ARG', countryName: 'Argentina' })
    // 10/17 (review): geoBoundaries writes Latin-1, and read as UTF-8 every
    // accented district name came out broken.
    const names = (c: string) => (JSON.parse(gunzipSync(readFileSync(join(GEO_DIR, 'adm2', `${c}.json.gz`))).toString('utf8'))
      .objects.areas.geometries as Array<{ properties: any }>).map(g => g.properties.name as string)
    expect(names('ALB')).toContain('Malësi e Madhe')
    // 10/17 (second review): that file is MIXED — fourteen of its rows are
    // UTF-8 bytes among 5,280 Latin-1 ones, and read as Latin-1 those fourteen
    // shipped as "WaitematÄ Local Board Area". Both kinds have to come out
    // right, and nothing anywhere may carry a C1 byte or a replacement mark.
    expect(names('NZL')).toContain('Waitematā Local Board Area')
    expect(names('NZL')).toContain('Ōtorohanga District')
    expect(names('PER')).toContain('Cañete')
    for (const c of ['ALB', 'NZL', 'PER', 'RUS', 'SWE', 'NOR']) {
      for (const n of names(c)) expect(/[\u0080-\u009f�]/.test(n), `${c} ${n}`).toBe(false)
    }
    // geoBoundaries lost the alphabet altogether for 654 districts (51 of them
    // the same row of question marks); a row of punctuation is not a name.
    for (const n of names('RUS')) expect(/[\p{L}\p{N}]/u.test(n), n).toBe(true)
  })

  it('every country with districts is a country a property can actually reach', () => {
    // 10/17 (review): geoBoundaries keys a country by ISO 3166 and Natural
    // Earth by its own three letters. Three disagreed (XKX/KOS, SSD/SDS,
    // ESH/SAH), and because a property reaches this level through the province
    // it is in — Natural Earth's — those three files could never be opened:
    // Kosovo's districts sat on disk while a property in Pristina was told its
    // country has none. The two vocabularies have to be the same one here.
    const provinces = JSON.parse(gunzipSync(readFileSync(join(GEO_DIR, 'adm1.json.gz'))).toString('utf8'))
    const countries = new Set((provinces.objects.areas.geometries as Array<{ properties: any }>)
      .map(g => g.properties.country as string))
    const index = JSON.parse(readFileSync(join(GEO_DIR, 'index.json'), 'utf8'))
    for (const c of index.layers.adm2.countries) expect(countries.has(c), `adm2/${c}`).toBe(true)
    for (const c of ['KOS', 'SDS', 'SAH']) expect(index.layers.adm2.countries, c).toContain(c)
    for (const c of ['XKX', 'SSD', 'ESH']) {
      expect(index.layers.adm2.countries, c).not.toContain(c)
      expect(existsSync(join(GEO_DIR, 'adm2', `${c}.json.gz`)), c).toBe(false)
    }
  })

  it('every ZIP code file holds TopoJSON areas named by their codes', () => {
    const topo = JSON.parse(gunzipSync(readFileSync(join(GEO_DIR, 'zcta', '04.json.gz'))).toString('utf8'))
    expect(topo.type).toBe('Topology')
    const ids = topo.objects.areas.geometries.map((g: any) => g.id)
    expect(ids).toContain('85362')
    expect(ids.every((id: string) => /^\d{5}$/.test(id))).toBe(true)
  })

  it('a file is found only for a known level and a listed state — never from a path typed into the address', async () => {
    expect(await boundaryFile('cd')).toBe(join(GEO_DIR, 'cd.json.gz'))
    expect(await boundaryFile('zcta', '04')).toBe(join(GEO_DIR, 'zcta', '04.json.gz'))
    // 10/17: the globe's world land is served the same way, and takes no state.
    expect(await boundaryFile('world')).toBe(join(GEO_DIR, 'world.json.gz'))
    expect(await boundaryFile('world', '04')).toBeNull()
    // 10/17 (Nic): the world's own levels. Countries and provinces take
    // nothing; the level below a province takes a country code the index lists.
    expect(await boundaryFile('country')).toBe(join(GEO_DIR, 'country.json.gz'))
    expect(await boundaryFile('adm1')).toBe(join(GEO_DIR, 'adm1.json.gz'))
    expect(await boundaryFile('adm2', 'USA')).toBe(join(GEO_DIR, 'adm2', 'USA.json.gz'))
    expect(await boundaryFile('adm2')).toBeNull()            // per country: a country is needed
    expect(await boundaryFile('adm1', 'USA')).toBeNull()     // one file for the world: no country
    expect(await boundaryFile('adm2', 'HKG')).toBeNull()     // has no level below its districts
    expect(await boundaryFile('adm2', 'usa')).toBeNull()
    expect(await boundaryFile('adm2', '04')).toBeNull()
    expect(await boundaryFile('adm2', '../../geo/index')).toBeNull()
    expect(await boundaryFile('adm2', 'USA.json.gz')).toBeNull()
    expect(await boundaryFile('cd', '04')).toBeNull()        // national: no state
    expect(await boundaryFile('zcta')).toBeNull()            // per state: a state is needed
    expect(await boundaryFile('sldl', '31')).toBeNull()      // Nebraska has no state house
    expect(await boundaryFile('zcta', '99')).toBeNull()
    expect(await boundaryFile('zcta', '../index')).toBeNull()
    expect(await boundaryFile('../geo', '04')).toBeNull()
    expect(await boundaryFile('county', '04')).toBeNull()
    expect(await boundaryFile(undefined)).toBeNull()
  })
})

describe('cityKey: a city as written on an address matches it as Census writes it', () => {
  it('ignores case, spacing, periods and accents, and reads St. as Saint', () => {
    expect(cityKey('  MATTOON ')).toBe(cityKey('Mattoon'))
    expect(cityKey('Saint George')).toBe(cityKey('St. George'))
    expect(cityKey('Port St Lucie')).toBe(cityKey('Port St. Lucie'))
    expect(cityKey('Ste. Genevieve')).toBe(cityKey('Sainte Genevieve'))
    expect(cityKey('Canon City')).toBe(cityKey('Cañon City'))
    expect(cityKey("Coeur d'Alene")).toBe(cityKey('COEUR DALENE'))
    expect(cityKey('Mesa')).not.toBe(cityKey('Mesa del Caballo'))
  })
})

describe('buildMapLevels: where a property goes at each level', () => {
  it('places real properties in their city, districts and ZIP code', async () => {
    expect(placed(await only({ state: 'AZ', city: 'Yarnell', zip: '85362', ...YARNELL_AZ }))).toEqual({
      place: '0484980 Yarnell', cd: '0402 Congressional District 2', sldu: '04001 State Senate District 1',
      sldl: '04001 State House District 1', zcta: '85362 ZIP 85362',
      // 10/17 (Nic): the same property on the world's levels — a United States
      // property is on the world map too, at whichever levels it reaches.
      country: 'USA United States of America', adm1: 'USA-3520 Arizona', adm2: 'USA.1184 Yavapai',
    })
    expect(placed(await only({ state: 'AZ', city: 'Amado', zip: '85645-1234', ...AMADO_AZ }))).toEqual({
      place: '0401990 Amado', cd: '0407 Congressional District 7', sldu: '04021 State Senate District 21',
      sldl: '04021 State House District 21', zcta: '85645 ZIP 85645',
      country: 'USA United States of America', adm1: 'USA-3520 Arizona', adm2: 'USA.2292 Santa Cruz',
    })
    expect(placed(await only({ state: 'il', city: 'mattoon', zip: '61938', ...MATTOON_IL }))).toEqual({
      place: '1747553 Mattoon', cd: '1715 Congressional District 15', sldu: '17051 State Senate District 51',
      sldl: '17101 State House District 101', zcta: '61938 ZIP 61938',
      country: 'USA United States of America', adm1: 'USA-3546 Illinois', adm2: 'USA.2965 Coles',
    })
  })

  it('goes by the city and ZIP on the address, even with no map location', async () => {
    const l = await only({ state: 'AZ', city: 'Yarnell', zip: '85362' })
    expect(l.place.areas[0]).toMatchObject({ fips: '0484980', state: 'AZ', stateFips: '04', units: 1, properties: 1 })
    expect(l.zcta.areas[0]).toMatchObject({ fips: '85362', state: 'AZ', stateFips: '04' })
    // Districts need the map location: a ZIP or a city can cross a district line.
    for (const level of ['cd', 'sldu', 'sldl'] as const) {
      expect(l[level].areas).toEqual([])
      expect(l[level].missing).toEqual([expect.objectContaining({ reason: 'no_location', properties: 1, units: 1 })])
    }
  })

  it('a city name Census does not draw, and a ZIP with no Census area, go by the map location', async () => {
    // "Phx" is not a place; 85001 is a post-office-box ZIP Census draws no area for.
    expect(placed(await only({ state: 'AZ', city: 'Phx', zip: '85001', ...DOWNTOWN_PHOENIX }))).toMatchObject({
      place: '0455000 Phoenix', zcta: '85003 ZIP 85003', cd: '0403 Congressional District 3',
    })
    // …and with no map location they are named under the map, not guessed.
    const l = await only({ state: 'AZ', city: 'Phx', zip: '85001' })
    expect(l.place.missing[0]).toMatchObject({ reason: 'no_match', label: expect.stringMatching(/^the city on its address/) })
    expect(l.zcta.missing[0]).toMatchObject({ reason: 'no_match', label: expect.stringMatching(/^Census draws no area for the ZIP code/) })
  })

  it('names what it cannot place, level by level, in words', async () => {
    const stale = await only({ state: 'AZ', city: 'Yarnell', zip: '85362', ...YARNELL_AZ, location_stale: true })
    expect(stale.place.areas).toHaveLength(1)      // by its address
    expect(stale.zcta.areas).toHaveLength(1)
    expect(stale.cd.missing[0]).toMatchObject({ reason: 'stale_location' })

    // The address says North Carolina; the map location is in Arizona.
    const wrong = await only({ state: 'NC', city: 'Nowhere Special', zip: '27601', ...YARNELL_AZ })
    expect(wrong.cd.missing[0]).toMatchObject({ reason: 'wrong_state', label: 'its map location is in a different state than its address' })
    expect(wrong.sldu.missing[0]).toMatchObject({ reason: 'outside', label: 'its map location is not inside any state senate district of its state' })

    // Nebraska's one-chamber legislature: senate districts, no house districts.
    const ne = await only({ state: 'NE', city: 'Lincoln', zip: '68508', ...LINCOLN_NE })
    expect(ne.sldu.areas[0]).toMatchObject({ fips: '31028', name: 'State Senate District 28', state: 'NE' })
    expect(ne.sldl.missing[0]).toMatchObject({ reason: 'no_layer', label: 'Census draws no state house districts for its state' })

    const unknown = await only({ state: 'ZZ', ...YARNELL_AZ })
    for (const l of US_LAYERS) expect(unknown[l].missing[0]).toMatchObject({ reason: 'unknown_state', properties: 1 })
    // 10/17 (Nic): the world's levels know nothing of U.S. states. A property
    // whose state GAM does not recognize is still somewhere on the earth, and
    // its map location says where — so it is placed, not named as a gap.
    for (const l of WORLD_LAYERS) {
      expect(unknown[l].missing, l).toEqual([])
      expect(unknown[l].areas, l).toHaveLength(1)
    }

    const orphan = await buildMapLevels([row({ property_id: null, state: null, units: 0, occupied: 0, money: '25' })], MAP_STATE_FIPS)
    for (const l of METRICS_BOUNDARY_LAYERS) expect(orphan[l].missing[0]).toMatchObject({ reason: 'no_property', properties: 0, money: 25 })

    for (const levels of [stale, wrong, ne, unknown, orphan]) {
      for (const l of METRICS_BOUNDARY_LAYERS) for (const m of levels[l].missing) expect(m.label).toMatch(/^[a-zA-Z]/)
    }
  })

  it('the state picker offers the states GAM is in, not every state the files cover', async () => {
    // 10/17 (review): it used to offer every state a Census file exists for —
    // all 56, 55 of them with nothing on the map (gam-scope-staff-no-choices).
    const none = await buildMapLevels([], MAP_STATE_FIPS)
    for (const level of METRICS_BOUNDARY_LAYERS) {
      expect(none[level].areas).toEqual([])
      expect(none[level].states, level).toEqual([])
    }

    const two = await buildMapLevels([
      row({ state: 'AZ', city: 'Yarnell', zip: '85362', ...YARNELL_AZ }),
      row({ state: 'IL', city: 'Mattoon', zip: '61938', ...MATTOON_IL }),
    ], MAP_STATE_FIPS)
    // Arizona and Illinois, and nothing else — a level drawn nationally has no picker.
    for (const level of METRICS_MAP_STATE_LEVELS) expect(two[level].states, level).toEqual(['04', '17'])
    expect(two.cd.states).toEqual([])
  })
})

// ─── 10/17 (Nic): the rest of the world ─────────────────────────────────────
//
// Nic: "that's only pertinent to the United States for now. Just break the
// rest of the countries down by states or province and then possibly cities as
// well or counties, if they have counties within those provinces." A property
// lands on these by its map location alone — GAM holds a U.S. state on an
// address, never a country.

const TORONTO_ON = { lat: 43.6532, lng: -79.3832 }
const MEXICO_CITY = { lat: 19.4326, lng: -99.1332 }
const HONG_KONG = { lat: 22.3193, lng: 114.1694 }
const MID_PACIFIC = { lat: 0, lng: -150 }
/**
 * 10/17 (review): places the world's own shapes do not have under them.
 * Miami, Venice and Nuuk are outside the land in the RAW Natural Earth file;
 * Key West is an island the simplifier used to throw away. Kosovo and South
 * Sudan are the two countries the two downloads call by different codes.
 */
const MIAMI_FL = { lat: 25.7617, lng: -80.1918 }
const KEY_WEST_FL = { lat: 24.5551, lng: -81.78 }
const NUUK_GRL = { lat: 64.1835, lng: -51.7216 }
const VENICE_ITA = { lat: 45.4408, lng: 12.3155 }
const PRISTINA_KOS = { lat: 42.6629, lng: 21.1655 }
const JUBA_SSD = { lat: 4.8594, lng: 31.5713 }

describe('buildMapLevels: the world levels', () => {
  it('places a property outside the United States in its country, province and district', async () => {
    const l = await only({ state: 'ON', city: 'Toronto', zip: 'M5H 2N2', ...TORONTO_ON })
    expect(l.country.areas[0]).toMatchObject({ fips: 'CAN', name: 'Canada', country: 'CAN', countryName: 'Canada', units: 1, properties: 1 })
    expect(l.adm1.areas[0]).toMatchObject({ fips: 'CAN-682', name: 'Ontario', country: 'CAN', countryName: 'Canada' })
    expect(l.adm2.areas[0]).toMatchObject({ name: 'Toronto', country: 'CAN', countryName: 'Canada' })
    // A world area is drawn with its country, never a state.
    for (const level of WORLD_LAYERS) expect(l[level].areas[0]).toMatchObject({ state: '', stateFips: '' })
    // Ontario is not a U.S. state, so every United States level names it as a gap.
    for (const level of US_LAYERS) expect(l[level].missing[0], level).toMatchObject({ reason: 'unknown_state' })
  })

  it('a waterfront address, which the world file draws as water, is placed by the nearest province', async () => {
    // 10/17 (review): downtown Miami, Key West and Nuuk were in no country on
    // earth. Two separate faults: the Keys and every island under about 29
    // square kilometers were thrown away by the simplifier (the world levels
    // are cut four times finer now), and Miami, Venice, Copenhagen and Nuuk
    // are outside the land in the RAW Natural Earth file, which no amount of
    // detail reaches — so a location inside nothing is counted in the province
    // it is within WORLD_SNAP_KM of.
    for (const [where, at, country, province] of [
      ['downtown Miami', MIAMI_FL, 'USA', 'Florida'],
      ['Key West', KEY_WEST_FL, 'USA', 'Florida'],
      ['Nuuk', NUUK_GRL, 'GRL', 'Kommuneqarfik Sermersooq'],
      ['Venice', VENICE_ITA, 'ITA', 'Venezia'],
    ] as const) {
      const l = await only({ state: 'FL', ...at })
      expect(l.country.areas[0], where).toMatchObject({ fips: country })
      expect(l.adm1.areas[0], where).toMatchObject({ name: province, country })
      expect(l.country.missing, where).toEqual([])
    }
    // Miami is miles inside the county the Census draws, which is how it reads
    // on the county map too — the snap does not move it anywhere else.
    expect((await only({ state: 'FL', ...MIAMI_FL })).adm2.areas[0]).toMatchObject({ name: 'Miami-Dade', country: 'USA' })
    // Three miles of tolerance still leaves the open sea in no country.
    const sea = await only({ state: 'HI', ...MID_PACIFIC })
    for (const level of WORLD_LAYERS) expect(sea[level].areas, level).toEqual([])
  })

  it('the three countries whose two sources disagree reach their own districts', async () => {
    // 10/17 (review): Kosovo, South Sudan and Western Sahara are KOS/SDS/SAH
    // in Natural Earth and XKX/SSD/ESH in geoBoundaries. A property in
    // Pristina was told "its country has no counties and districts below its
    // states and provinces" while 18 KB of Kosovo's districts sat on disk.
    const ks = await only({ state: 'XK', city: 'Pristina', ...PRISTINA_KOS })
    expect(ks.country.areas[0]).toMatchObject({ fips: 'KOS' })
    expect(ks.adm1.areas[0]).toMatchObject({ name: 'Priština', country: 'KOS' })
    expect(ks.adm2.areas[0]).toMatchObject({ name: 'Municipality of Pristina', country: 'KOS' })
    expect(ks.adm2.missing).toEqual([])

    const ss = await only({ state: 'CE', city: 'Juba', ...JUBA_SSD })
    expect(ss.adm1.areas[0]).toMatchObject({ name: 'Central Equatoria', country: 'SDS' })
    expect(ss.adm2.areas[0]).toMatchObject({ name: 'Juba', country: 'SDS' })
  })

  it('a province whose country has no level below it says so, instead of drawing nothing', async () => {
    // 10/17 (review): the first cut piled a country's provinces into one shape
    // and the simplifier dropped every piece under a pixel and a half — Mexico
    // City came out as a hole punched through Mexico, inside no country at all.
    const mx = await only({ state: 'CDMX', city: 'Ciudad de México', ...MEXICO_CITY })
    expect(mx.country.areas[0]).toMatchObject({ fips: 'MEX', name: 'Mexico' })
    expect(mx.adm1.areas[0]).toMatchObject({ name: 'Distrito Federal', country: 'MEX' })
    expect(mx.adm2.areas[0]).toMatchObject({ name: 'Cuauhtémoc', country: 'MEX' })

    // Hong Kong has provinces of its own and nothing below them.
    const hk = await only({ state: 'HK', city: 'Hong Kong', ...HONG_KONG })
    expect(hk.country.areas[0]).toMatchObject({ fips: 'HKG' })
    expect(hk.adm1.areas).toHaveLength(1)
    expect(hk.adm2.areas).toEqual([])
    expect(hk.adm2.missing[0]).toMatchObject({
      reason: 'no_districts',
      label: 'its country has no counties and districts below its states and provinces',
    })
  })

  it('names what it cannot place on the world map, in words', async () => {
    // No map location: the world levels have nothing else to go on.
    const noPoint = await only({ state: 'ON', city: 'Toronto', zip: 'M5H 2N2' })
    for (const level of WORLD_LAYERS) {
      expect(noPoint[level].areas, level).toEqual([])
      expect(noPoint[level].missing[0], level).toMatchObject({ reason: 'no_location', properties: 1, units: 1 })
    }
    const stale = await only({ state: 'ON', ...TORONTO_ON, location_stale: true })
    for (const level of WORLD_LAYERS) expect(stale[level].missing[0], level).toMatchObject({ reason: 'stale_location' })

    // The middle of the Pacific is in no country.
    const sea = await only({ state: 'HI', ...MID_PACIFIC })
    expect(sea.country.missing[0]).toMatchObject({
      reason: 'outside',
      label: 'its map location is out at sea, inside no country on the world map and not within a few miles of one',
    })
    expect(sea.adm1.missing[0]).toMatchObject({ reason: 'outside' })
    expect(sea.adm2.missing[0]).toMatchObject({
      reason: 'no_country',
      label: 'its map location is out at sea, inside no country on the world map and not within a few miles of one',
    })

    const orphan = await buildMapLevels([row({ property_id: null, state: null, units: 0, occupied: 0, money: '25' })], MAP_STATE_FIPS)
    for (const level of WORLD_LAYERS) expect(orphan[level].missing[0]).toMatchObject({ reason: 'no_property', money: 25 })
  })

  it('the country picker offers the countries GAM is in, and only the level drawn that way has one', async () => {
    const some = await buildMapLevels([
      row({ state: 'AZ', city: 'Yarnell', zip: '85362', ...YARNELL_AZ }),
      row({ state: 'ON', city: 'Toronto', ...TORONTO_ON }),
      row({ state: 'HK', city: 'Hong Kong', ...HONG_KONG }),
    ], MAP_STATE_FIPS)
    // Hong Kong has no districts, so it is not a country this level can draw.
    expect(some.adm2.countries).toEqual(['CAN', 'USA'])
    // Countries and provinces are one file for the world: no picker.
    expect(some.country.countries).toEqual([])
    expect(some.adm1.countries).toEqual([])
    for (const level of METRICS_MAP_STATE_LEVELS) expect(some[level].countries, level).toEqual([])
    expect(some.country.areas.map(a => a.fips).sort()).toEqual(['CAN', 'HKG', 'USA'])
  })

  it('every level still adds up to the tiles, the world levels among them', async () => {
    const rows = [
      row({ state: 'AZ', city: 'Yarnell', zip: '85362', ...YARNELL_AZ, units: 10, occupied: 7, money: '100' }),
      row({ state: 'ON', city: 'Toronto', ...TORONTO_ON, units: 4, occupied: 4, money: '50' }),
      row({ state: 'HK', city: 'Hong Kong', ...HONG_KONG, units: 2, occupied: 1, money: '20' }),
      row({ state: 'ON', city: 'Toronto', units: 3, occupied: 0, money: '5' }),   // no map location
      row({ property_id: null, state: null, units: 0, occupied: 0, money: '25' }),
    ]
    const levels = await buildMapLevels(rows, MAP_STATE_FIPS)
    const total = (xs: Array<{ units: number; occupied: number; money: number }>) => xs.reduce(
      (t, x) => ({ units: t.units + x.units, occupied: t.occupied + x.occupied, money: t.money + x.money }),
      { units: 0, occupied: 0, money: 0 })
    for (const level of METRICS_BOUNDARY_LAYERS) {
      const sum = total([...levels[level].areas, ...levels[level].missing])
      expect(sum, level).toEqual({ units: 19, occupied: 12, money: 200 })
    }
  })
})

// ─── In GET /api/admin/metrics, and the boundaries the page draws ───────────

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
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_admin_metrics_geo'
})

async function tokenFor(role: 'super_admin' | 'admin') {
  const u = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
     VALUES ($1, 'x', $2, 'A', 'D', TRUE) RETURNING id`, [`${role}-${randomUUID()}@test.dev`, role])
  return jwt.sign({ userId: u.rows[0].id, role, email: 'x@test.dev', profileId: u.rows[0].id, permissions: {} },
    process.env.JWT_SECRET!, { expiresIn: '1h' })
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

/** A live property (one lease on its first space) at an address, with rent paid on it. */
async function property(c: PoolClient, landlord: { userId: string; landlordId: string }, o: {
  state: string; city: string; zip: string; at?: { lat: number; lng: number }; spaces: number; rent?: number
}) {
  const { userId, landlordId } = landlord
  const propertyId = await seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: userId })
  await c.query(`UPDATE properties SET state = $2, city = $3, zip = $4, latitude = $5, longitude = $6 WHERE id = $1`,
    [propertyId, o.state, o.city, o.zip, o.at?.lat ?? null, o.at?.lng ?? null])
  const units: string[] = []
  for (let i = 0; i < o.spaces; i++) units.push(await seedUnit(c, { propertyId, landlordId }))
  const tenantId = await seedTenant(c)
  const leaseId = await seedLease(c, { unitId: units[0], landlordId, rentAmount: 500 })
  await seedLeaseTenant(c, { leaseId, tenantId })
  if (o.rent) {
    const p = await c.query<{ id: string }>(
      `INSERT INTO payments (unit_id, tenant_id, landlord_id, lease_id, type, amount, status, entry_description, due_date)
       VALUES ($1,$2,$3,$4,'rent',$5,'settled','RENT',CURRENT_DATE) RETURNING id`,
      [units[0], tenantId, landlordId, leaseId, o.rent])
    const rem = await c.query<{ id: string }>(
      `INSERT INTO tenant_remittances (tenant_id, landlord_id, lease_id, amount, applied_amount, status, payment_method, settled_at)
       VALUES ($1,$2,$3,$4,$4,'settled','check',NOW()) RETURNING id`, [tenantId, landlordId, leaseId, o.rent])
    await c.query(`INSERT INTO remittance_applications (remittance_id, payment_id, amount_applied) VALUES ($1,$2,$3)`,
      [rem.rows[0].id, p.rows[0].id, o.rent])
  }
  return propertyId
}

const sum = (xs: any[], k: 'units' | 'occupied' | 'money') => xs.reduce((s, x) => s + x[k], 0)

describe('GET /api/admin/metrics: the new levels add up to the tiles', () => {
  it('cities, districts and ZIP codes each add up, with what they could not place', async () => {
    await inTx(async c => {
      const a = await seedLandlord(c)
      await property(c, a, { state: 'AZ', city: 'Yarnell', zip: '85362', at: YARNELL_AZ, spaces: 3, rent: 300 })
      await property(c, a, { state: 'AZ', city: 'Yarnell', zip: '85362', at: YARNELL_AZ, spaces: 1, rent: 50 })
      await property(c, a, { state: 'IL', city: 'Mattoon', zip: '61938', at: MATTOON_IL, spaces: 2 })
      // No map location: in its city and ZIP, named under each district map.
      await property(c, a, { state: 'AZ', city: 'Amado', zip: '85645', spaces: 1, rent: 20 })
      // Nebraska: no state house districts.
      await property(c, a, { state: 'NE', city: 'Lincoln', zip: '68508', at: LINCOLN_NE, spaces: 2 })
    })
    const token = await tokenFor('super_admin')
    const res = await request(buildApp()).get('/api/admin/metrics').set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    const m = res.body.data
    const levels = m.map.levels

    expect(levels.place.areas.map((x: any) => [x.name, x.state, x.units, x.money, x.properties])).toEqual([
      ['Amado', 'AZ', 1, 20, 1], ['Yarnell', 'AZ', 4, 350, 2], ['Mattoon', 'IL', 2, 0, 1], ['Lincoln', 'NE', 2, 0, 1],
    ])
    expect(levels.zcta.areas.map((x: any) => x.fips)).toEqual(['85362', '85645', '61938', '68508'])
    expect(levels.cd.areas.map((x: any) => [x.fips, x.units])).toEqual([['0402', 4], ['1715', 2], ['3101', 2]])
    expect(levels.cd.missing).toEqual([expect.objectContaining({ reason: 'no_location', properties: 1, units: 1, money: 20 })])
    expect(levels.sldl.missing.map((x: any) => x.reason).sort()).toEqual(['no_layer', 'no_location'])

    expect(m.footprint.units).toBe(9)
    for (const level of METRICS_BOUNDARY_LAYERS) {
      const l = levels[level]
      expect(sum(l.areas, 'units') + sum(l.missing, 'units'), level).toBe(m.footprint.units)
      expect(sum(l.areas, 'occupied') + sum(l.missing, 'occupied'), level).toBe(m.footprint.occupiedSpaces)
      expect(sum(l.areas, 'money') + sum(l.missing, 'money'), level).toBeCloseTo(m.rent.logged.total, 2)
    }
    // The state and county maps are as they were.
    expect(m.map.states.map((s: any) => s.abbr)).toEqual(['AZ', 'IL', 'NE'])
    expect(m.map.counties.map((x: any) => x.fips)).toEqual(['04025', '17029', '31109'])
  })
})

describe('GET /api/admin/metrics/boundaries: the shapes, behind admin login', () => {
  it('serves a state\'s file to a super admin, gzipped, and plain JSON to a client that does not take gzip', async () => {
    const token = await tokenFor('super_admin')
    const app = buildApp()
    const gz = await request(app).get('/api/admin/metrics/boundaries/zcta/04').set('Authorization', `Bearer ${token}`)
    expect(gz.status).toBe(200)
    expect(gz.headers['content-encoding']).toBe('gzip')
    expect(gz.headers['content-type']).toMatch(/application\/json/)
    expect(gz.headers['cache-control']).toBe('private, max-age=86400')
    expect(gz.body.type).toBe('Topology')
    expect(gz.body.objects.areas.geometries.some((g: any) => g.id === '85362')).toBe(true)

    const plain = await request(app).get('/api/admin/metrics/boundaries/cd')
      .set('Authorization', `Bearer ${token}`).set('Accept-Encoding', 'identity')
    expect(plain.status).toBe(200)
    expect(plain.headers['content-encoding']).toBeUndefined()
    expect(plain.body.objects.areas.geometries).toHaveLength(441)
  })

  it('is not public, not for the admin role, and has nothing for an unknown level or state', async () => {
    const app = buildApp()
    expect((await request(app).get('/api/admin/metrics/boundaries/cd')).status).toBe(401)
    const admin = await tokenFor('admin')
    expect((await request(app).get('/api/admin/metrics/boundaries/cd').set('Authorization', `Bearer ${admin}`)).status).toBe(403)
    const token = await tokenFor('super_admin')
    for (const url of ['/cd/04', '/zcta', '/zcta/99', '/sldl/31', '/county/04', '/zcta/..%2Findex', '/..%2Fgeo/04',
                       '/world/04']) {
      const res = await request(app).get(`/api/admin/metrics/boundaries${url}`).set('Authorization', `Bearer ${token}`)
      expect(res.status, url).toBe(404)
    }
  })
})
