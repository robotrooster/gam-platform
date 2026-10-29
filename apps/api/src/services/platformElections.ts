/**
 * 10/18 (Nic): the election results the Metrics map's lean overlay colors an
 * area by. Nic: "the overlay to show which way those certain districts vote,
 * and where our strong areas tend to be in Democratic areas or Republican
 * areas, for the landlord onboarding process and total unit count."
 *
 * AND NOT ONLY PRESIDENTIAL — the same day: "I don't only want presidential
 * stuff, I want mayor data, governor data, city council data, voting on public
 * policy, whether it's left-leaning or conservative. I want the data at every
 * level that we can get it... get what you can for now." So a file holds
 * CONTESTS, each an office and a year with its two sides named, and an area's
 * margin in each — a governor, a mayor, a council seat or a ballot measure
 * drops in as another contest with nothing reshaped (@gam/shared metricsMap).
 *
 * THE FILES are official county presidential returns (public data, no key),
 * cut into one small file per map level by
 * apps/admin/scripts/build-election-results.mjs and kept in apps/api/elections
 * (gzipped). The API reads them from disk — nothing is fetched from anywhere —
 * and serves them to the admin page behind admin login (GET
 * /api/admin/metrics/elections/:level, gam-nothing-public-rule). Each area is
 * keyed by the SAME code the boundary files use, so the join is code to code
 * with nothing matched by name.
 *
 * ONLY COUNTIES ARE EXACT. Presidential results are published county by county
 * and there is no free keyless source for a congressional or legislative
 * district, so the county level is the only one with a file. Every other level
 * has none, and the page says so plainly instead of working a district's
 * margin out of county votes — a made-up district margin is worse than none.
 *
 * Internal metrics only; the margin is a fact about an area, never anything
 * GAM shows a landlord or a tenant.
 */
import fs from 'fs'
import path from 'path'
import zlib from 'zlib'
import { promisify } from 'util'
import { METRICS_ELECTION_LEVELS, type MetricsElectionFile, type MetricsMapLevel } from '@gam/shared'

const gunzip = promisify(zlib.gunzip)

/** apps/api/elections, from src/services (ts-node, vitest) and from dist/services (the built API) alike. */
export const ELECTIONS_DIR = path.resolve(__dirname, '../../elections')

export const isElectionLevel = (v: unknown): v is MetricsMapLevel =>
  typeof v === 'string' && (METRICS_ELECTION_LEVELS as readonly string[]).includes(v)

/** The file for a level, or null when that level has no election results. */
export function electionsFile(level: unknown): string | null {
  // The path is built only from a level this list names, never from what a
  // request typed.
  return isElectionLevel(level) ? path.join(ELECTIONS_DIR, `${level}.json.gz`) : null
}

/**
 * 10/18 (Nic): a level's election results for the admin page, gzipped as they
 * sit on disk (every browser takes them that way); unzipped only for a client
 * that asks for plain JSON. Null when there is no such level.
 */
export async function readElections(level: unknown, acceptsGzip: boolean): Promise<{ body: Buffer; gzipped: boolean } | null> {
  const file = electionsFile(level)
  if (!file) return null
  const gz = await fs.promises.readFile(file)
  return acceptsGzip ? { body: gz, gzipped: true } : { body: await gunzip(gz), gzipped: false }
}

/** Read once per level, on the first ask — never at start-up. */
const parsed = new Map<string, Promise<MetricsElectionFile>>()

/**
 * A level's election results, parsed. The API itself does not need them to
 * serve the page, so this is for anything on the server that wants to read a
 * margin (and for the tests, which check real counties against them).
 */
export function electionsLevel(level: MetricsMapLevel): Promise<MetricsElectionFile> {
  let p = parsed.get(level)
  if (!p) {
    const file = electionsFile(level)
    p = file
      ? fs.promises.readFile(file).then(gz => gunzip(gz)).then(buf => JSON.parse(buf.toString('utf8')) as MetricsElectionFile)
      : Promise.reject(new Error(`[platformElections] ${level} has no election results`))
    parsed.set(level, p)
    // A failed read is tried again next time, not remembered.
    p.catch(() => parsed.delete(level))
  }
  return p
}
