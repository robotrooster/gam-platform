/**
 * 10/17 (Nic): the census numbers the Metrics map's saturation overlay divides
 * GAM's own footprint by. Nic: "overlay against census data and say, hey,
 * look, we're in Santa Cruz County and we are responsible for 30% of the
 * population or 60% of the total rental units ... so we can target areas that
 * have room to grow. Whereas if we're already highly saturated ... we may not
 * want to have any more marketing dollars spent there."
 *
 * THREE denominators, each its own view on the page — Nic: "show all. because
 * we are doing short term rentals as well as living situations. its not only
 * regular rentals. toggle each view/metric":
 *   renter-occupied homes · all housing units · total population
 *
 * THE FILES are American Community Survey five-year estimates (Nic approved
 * the download), cut into one small file per map level by
 * apps/admin/scripts/build-census-saturation.mjs and kept in apps/api/census
 * (gzipped). The API reads them from disk — nothing is fetched from anywhere,
 * and the Census API's new key is nobody's to sign up for — and serves them to
 * the admin page behind admin login (GET /api/admin/metrics/census/:level,
 * gam-nothing-public-rule). Each area is keyed by the SAME code the boundary
 * files use, so the join is code to code with nothing matched by name.
 *
 * The page does the dividing, because it already holds GAM's own numbers for
 * every area on screen (GET /admin/metrics, `map`) and the percentage is one
 * division. There is one set of census numbers behind both the map and the
 * list beside it, and one place that spells out what each percentage means
 * (packages/shared metricsMap).
 *
 * These are U.S. Census counts, so they reach the U.S. levels only — a state,
 * a county, a city or town, a congressional district, a state senate or house
 * district, a ZIP code area. The world's own levels have none and the page
 * says so plainly instead of drawing a percentage of nothing.
 */
import fs from 'fs'
import path from 'path'
import zlib from 'zlib'
import { promisify } from 'util'
import { METRICS_CENSUS_LEVELS, type MetricsMapLevel } from '@gam/shared'

const gunzip = promisify(zlib.gunzip)

/** apps/api/census, from src/services (ts-node, vitest) and from dist/services (the built API) alike. */
export const CENSUS_DIR = path.resolve(__dirname, '../../census')

/** One census level's file, as the builder writes it. */
export interface CensusLevelFile {
  level: string
  edition: string
  /** What each of an area's three numbers is, in the order they are written. */
  numbers: string[]
  /** code → [total population, all housing units, renter-occupied homes]. */
  areas: Record<string, [number, number, number]>
}

export const isCensusLevel = (v: unknown): v is MetricsMapLevel =>
  typeof v === 'string' && (METRICS_CENSUS_LEVELS as readonly string[]).includes(v)

/** The file for a level, or null when that level has no census numbers. */
export function censusFile(level: unknown): string | null {
  // The path is built only from a level this list names, never from what a
  // request typed.
  return isCensusLevel(level) ? path.join(CENSUS_DIR, `${level}.json.gz`) : null
}

/**
 * 10/17 (Nic): a level's census numbers for the admin page, gzipped as they
 * sit on disk (every browser takes them that way); unzipped only for a client
 * that asks for plain JSON. Null when there is no such level.
 */
export async function readCensus(level: unknown, acceptsGzip: boolean): Promise<{ body: Buffer; gzipped: boolean } | null> {
  const file = censusFile(level)
  if (!file) return null
  const gz = await fs.promises.readFile(file)
  return acceptsGzip ? { body: gz, gzipped: true } : { body: await gunzip(gz), gzipped: false }
}

/** Read once per level, on the first ask — never at start-up. */
const parsed = new Map<string, Promise<CensusLevelFile>>()

/**
 * A level's census numbers, parsed. The API itself does not need them to serve
 * the page, so this is for anything on the server that wants to read a
 * denominator (and for the tests, which check real places against them).
 */
export function censusLevel(level: MetricsMapLevel): Promise<CensusLevelFile> {
  let p = parsed.get(level)
  if (!p) {
    const file = censusFile(level)
    p = file
      ? fs.promises.readFile(file).then(gz => gunzip(gz)).then(buf => JSON.parse(buf.toString('utf8')) as CensusLevelFile)
      : Promise.reject(new Error(`[platformCensus] ${level} has no census numbers`))
    parsed.set(level, p)
    // A failed read is tried again next time, not remembered.
    p.catch(() => parsed.delete(level))
  }
  return p
}
