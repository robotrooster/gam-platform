#!/usr/bin/env node
/**
 * 10/17 (Nic): builds the census numbers the admin Metrics map's saturation
 * overlay divides GAM's own footprint by. Nic: "overlay against census data
 * and say, hey, look, we're in Santa Cruz County and we are responsible for
 * 30% of the population or 60% of the total rental units ... so we can target
 * areas that have room to grow. Whereas if we're already highly saturated ...
 * we may not want to have any more marketing dollars spent there."
 *
 * THREE denominators, because GAM is not only year-round homes — Nic: "show
 * all. because we are doing short term rentals as well as living situations.
 * its not only regular rentals. toggle each view/metric":
 *
 *   B25003_003  renter-occupied homes   the rental market GAM competes in
 *   B25001      all housing units       every home, rented, owned or empty
 *   B01003      total population        people, for a population share
 *
 * Built from the American Community Survey five-year bulk table files Nic
 * approved downloading, which sit beside the boundary files in ~/gam-geo-raw/acs
 * (public data). Nothing is fetched: the Census API now wants an account and a
 * key, the bulk files do not, and signing up for one is not this script's to do.
 *
 *   acsdt5y2023-b01003.dat   GEO_ID|B01003_E001|B01003_M001
 *   acsdt5y2023-b25001.dat   GEO_ID|B25001_E001|B25001_M001
 *   acsdt5y2023-b25003.dat   GEO_ID|B25003_E001|…|B25003_E003|B25003_M003
 *
 * Usage (from anywhere — the raw folder is only ever read, never run from):
 *   node apps/admin/scripts/build-census-saturation.mjs [rawDir] [outDir]
 *   rawDir defaults to ~/gam-geo-raw/acs, outDir to apps/api/census.
 *
 * What it writes — one file per map level, gzipped, served by the API behind
 * admin login (GET /api/admin/metrics/census/:level, never on a public site or
 * a CDN) and read by the page when the saturation overlay is turned on for
 * that level. The levels are the map's own: a state, a county, a city or town,
 * a congressional district, a state senate or house district, a ZIP code area.
 *
 *   state.json.gz  county.json.gz  place.json.gz
 *   cd.json.gz  sldu.json.gz  sldl.json.gz  zcta.json.gz
 *   index.json     the edition, and how many areas each level holds (plain JSON)
 *
 * Each area is keyed by the SAME code the boundary files and the map use — a
 * state's two FIPS digits, a county's five, a place's seven, a district's state
 * plus district, a ZIP code — so the join is code to code with nothing matched
 * by name. Its three numbers are in one array, smallest file for the job:
 *   [ total population, all housing units, renter-occupied homes ]
 *
 * ACS five-year estimates are a survey, not a count, and a small area's
 * figures carry real margins. The page says so: a share of a small ZIP code is
 * a rough share.
 */
import fs from 'node:fs'
import zlib from 'node:zlib'
import path from 'node:path'
import os from 'node:os'
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const [rawArg, outArg] = process.argv.slice(2).filter(a => !a.startsWith('--'))
const RAW = path.resolve(rawArg ?? path.join(os.homedir(), 'gam-geo-raw/acs'))
const OUT = path.resolve(outArg ?? path.join(HERE, '../../api/census'))

const EDITION = 'American Community Survey 2019–2023 five-year estimates (U.S. Census Bureau, public data)'

/**
 * How each map level is written in an ACS GEO_ID: the three-digit summary
 * level, the two-character geographic component, "00US", then the area's own
 * code. The congressional districts are the 118th Congress ("18"), the state
 * legislative districts the 2018 sessions ("U8" / "L8") and the ZIP code areas
 * the 2020 ones ("Z2") — the same editions the boundary files are cut from.
 */
const LEVELS = {
  state:  { prefix: '0400000US', digits: 2 },
  county: { prefix: '0500000US', digits: 5 },
  place:  { prefix: '1600000US', digits: 7 },
  cd:     { prefix: '5001800US', digits: 4 },
  sldu:   { prefix: '610U800US', digits: 5 },
  sldl:   { prefix: '620L800US', digits: 5 },
  zcta:   { prefix: '860Z200US', digits: 5 },
}

/** Which column of which file each number comes from (1-based, after GEO_ID). */
const SOURCES = [
  { file: 'acsdt5y2023-b01003.dat', column: 'B01003_E001', what: 'total population' },
  { file: 'acsdt5y2023-b25001.dat', column: 'B25001_E001', what: 'all housing units' },
  { file: 'acsdt5y2023-b25003.dat', column: 'B25003_E003', what: 'renter-occupied homes' },
]

const t0 = Date.now()
const log = (...m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...m)

/** level → code → [population, housingUnits, renterHomes]; a number missing from a file stays 0. */
const areas = Object.fromEntries(Object.keys(LEVELS).map(l => [l, new Map()]))

/** The level and code a GEO_ID belongs to, or null — anything but the map's own levels. */
function placeOf(geoId) {
  for (const [level, { prefix, digits }] of Object.entries(LEVELS)) {
    if (geoId.length === prefix.length + digits && geoId.startsWith(prefix)) {
      const code = geoId.slice(prefix.length)
      // Mostly digits, but not always: Vermont's state house districts are
      // "50R-B" and Maryland's "2401A", and the boundary files spell them the
      // same way, so the join is still code to code.
      if (/^[0-9A-Z-]+$/.test(code)) return { level, code }
    }
  }
  return null
}

async function readTable(slot, { file, column }) {
  const full = path.join(RAW, file)
  const rl = readline.createInterface({ input: fs.createReadStream(full), crlfDelay: Infinity })
  let at = -1
  let rows = 0
  for await (const line of rl) {
    const cells = line.split('|')
    if (at < 0) {
      at = cells.indexOf(column)
      if (at < 1) throw new Error(`${file}: no ${column} column (header: ${cells.join('|')})`)
      continue
    }
    const where = placeOf(cells[0])
    if (!where) continue
    const value = cells[at]
    // Every estimate in these three tables is a whole number; a cell that is
    // not is a change in the file's shape, not something to guess at.
    if (!/^\d+$/.test(value)) throw new Error(`${file}: ${cells[0]} has ${column} = "${value}"`)
    const row = areas[where.level].get(where.code) ?? [0, 0, 0]
    row[slot] = Number(value)
    areas[where.level].set(where.code, row)
    rows++
  }
  log(`${file} ${column}: ${rows.toLocaleString('en-US')} areas`)
}

for (const [slot, source] of SOURCES.entries()) await readTable(slot, source)

fs.mkdirSync(OUT, { recursive: true })
const index = {}
let bytes = 0
for (const level of Object.keys(LEVELS)) {
  const rows = [...areas[level].entries()].sort(([a], [b]) => a.localeCompare(b))
  const body = zlib.gzipSync(JSON.stringify({
    level, edition: EDITION,
    numbers: SOURCES.map(s => s.what),
    areas: Object.fromEntries(rows),
  }), { level: 9 })
  fs.writeFileSync(path.join(OUT, `${level}.json.gz`), body)
  bytes += body.length
  index[level] = { areas: rows.length, file: `${level}.json.gz` }
  log(`${level}: ${rows.length.toLocaleString('en-US')} areas, ${(body.length / 1e3).toFixed(0)} KB`)
}
fs.writeFileSync(path.join(OUT, 'index.json'), JSON.stringify({
  about: 'Built by apps/admin/scripts/build-census-saturation.mjs from American Community Survey five-year bulk table files (U.S. Census Bureau, public data). Do not edit by hand; re-run the script.',
  edition: EDITION,
  numbers: SOURCES.map(s => ({ what: s.what, table: s.column })),
  levels: index,
}, null, 1))
log(`done: ${(bytes / 1e6).toFixed(2)} MB (gzipped) written to ${OUT}`)
