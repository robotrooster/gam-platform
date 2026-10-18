/**
 * 10/13 (Nic): the Metrics map's new levels — "toggle levels for cities,
 * congressional districts, state legislative districts (senate and house), and
 * ZIP codes" — beside the state and county levels it had (10/12,
 * services/platformMetrics buildPlatformMap).
 *
 * THE SHAPES are U.S. Census cartographic boundary files (Nic approved the
 * download), simplified into small TopoJSON files by
 * apps/admin/scripts/build-geo-boundaries.mjs and kept in apps/api/geo
 * (gzipped). The API reads them from disk — nothing is fetched from anywhere —
 * and serves them to the admin page behind admin login (GET
 * /api/admin/metrics/boundaries, gam-nothing-public-rule), so the page draws
 * the very shapes the server placed each property in. Cities, state
 * legislative districts and ZIP codes come one file per state (tens of
 * thousands of them nationwide; the page loads only the state on screen);
 * congressional districts are one national file.
 *
 * WHERE A PROPERTY GOES, at each level (properties carry an address and,
 * usually, a map location — properties.latitude/longitude from the address
 * look-up; there is no outside geocoding here):
 *   - ZIP code: the ZIP on its address — the Census ZIP area of that code.
 *     When Census draws no area for that code (P.O. box and single-building
 *     ZIPs have none), the ZIP area its map location falls in.
 *   - City: the city on its address — the Census place (city, town, or
 *     Census-designated place) of that name in its state. That is the city the
 *     "Cities" tile counts, so an RV park outside the town line with the town
 *     on its address is on the town. When no place of that name is in its
 *     state, the place its map location falls in. Two places of one name in
 *     one state (a village and a CDP, say): the one its map location is in,
 *     else the incorporated one.
 *   - Congressional, state senate and state house districts: its map
 *     location. A ZIP code or a city can cross district lines, so there is no
 *     fair way to place a property without one — it is named under the map
 *     ("no map location"), as is a location found for an address that has
 *     since changed (the same rule as the county map).
 * Anything that cannot be placed is counted under the map with the reason, so
 * each level still adds up to the tiles — never placed by a guess.
 *
 * Simplified lines mean a property within a few hundred yards of a line can
 * land in the neighbor — fine for a heat map, not for anything legal or billed.
 */
import fs from 'fs'
import path from 'path'
import zlib from 'zlib'
import { promisify } from 'util'
import {
  METRICS_BOUNDARY_LAYERS, METRICS_MAP_STATE_LEVELS, METRICS_WORLD_LAYER, isMetricsBoundaryLayer, zipAreaName,
  type MetricsBoundaryLayer,
} from '@gam/shared'
import { formatState } from '../lib/format'
import { logger } from '../lib/logger'

const gunzip = promisify(zlib.gunzip)

/** apps/api/geo, from src/services (ts-node, vitest) and from dist/services (the built API) alike. */
export const GEO_DIR = path.resolve(__dirname, '../../geo')

// ── The files ────────────────────────────────────────────────────────────────

interface GeoIndex {
  layers: Partial<Record<MetricsBoundaryLayer | typeof METRICS_WORLD_LAYER, { states?: string[]; file?: string }>>
}

let indexPromise: Promise<GeoIndex> | null = null
function loadIndex(): Promise<GeoIndex> {
  if (!indexPromise) {
    indexPromise = fs.promises.readFile(path.join(GEO_DIR, 'index.json'), 'utf8')
      .then(t => JSON.parse(t) as GeoIndex)
      // A failed read is tried again next time, not remembered.
      .catch(e => { indexPromise = null; throw e })
  }
  return indexPromise
}

/** State FIPS codes with a file for a per-state layer. */
async function statesWith(layer: MetricsBoundaryLayer): Promise<Set<string>> {
  return new Set((await loadIndex()).layers[layer]?.states ?? [])
}

/**
 * The file for a layer — and, for a per-state layer, a state — or null when
 * there is none. The path is built only from a known layer and a state code
 * the index lists, never from what a request typed.
 */
export async function boundaryFile(layer: unknown, state?: unknown): Promise<string | null> {
  // 10/17: the globe's world land is served the same way, from the same folder,
  // behind the same login — but it is not a map level, so it is not one of the
  // boundary layers above.
  if (!isMetricsBoundaryLayer(layer) && layer !== METRICS_WORLD_LAYER) return null
  const index = await loadIndex()
  if (layer === METRICS_WORLD_LAYER || !METRICS_MAP_STATE_LEVELS.includes(layer)) {
    const file = index.layers[layer]?.file
    return state == null && file && /^[a-z]+\.json\.gz$/.test(file) ? path.join(GEO_DIR, file) : null
  }
  if (typeof state !== 'string' || !/^\d{2}$/.test(state)) return null
  if (!(index.layers[layer]?.states ?? []).includes(state)) return null
  return path.join(GEO_DIR, layer, `${state}.json.gz`)
}

/**
 * 10/13 (Nic): a boundary file for the admin page, gzipped as it sits on disk
 * (every browser takes it that way); unzipped only for a client that asks for
 * plain JSON. Null when there is no such file.
 */
export async function readBoundary(layer: unknown, state: unknown, acceptsGzip: boolean): Promise<{ body: Buffer; gzipped: boolean } | null> {
  const file = await boundaryFile(layer, state)
  if (!file) return null
  const gz = await fs.promises.readFile(file)
  return acceptsGzip ? { body: gz, gzipped: true } : { body: await gunzip(gz), gzipped: false }
}

// ── Shapes, for "which area is this point in" ────────────────────────────────

export interface GeoShape {
  id: string
  name: string
  /** For a city: its full Census name when another place in the state shares its name ("Lisbon village"). */
  label?: string
  /** [west, south, east, north] over every piece — skips the ray test for nearly every area. */
  box: [number, number, number, number]
  /** Polygons → rings → flat [lng, lat, lng, lat, …]. */
  polygons: number[][][]
}

/**
 * A TopoJSON object's areas, decoded into rings. A polygon is only its arcs,
 * delta-decoded and joined; the API carries no map library for this.
 */
export function decodeTopology(topo: any, objectName: string): GeoShape[] {
  const [sx, sy] = topo.transform?.scale ?? [1, 1]
  const [tx, ty] = topo.transform?.translate ?? [0, 0]
  const quantized = !!topo.transform
  const arcs: number[][] = topo.arcs.map((arc: number[][]) => {
    const out: number[] = []
    let x = 0, y = 0
    for (const [dx, dy] of arc) {
      if (quantized) { x += dx; y += dy } else { x = dx; y = dy }
      out.push(quantized ? x * sx + tx : x, quantized ? y * sy + ty : y)
    }
    return out
  })
  const ring = (ids: number[]): number[] => {
    const out: number[] = []
    for (const id of ids) {
      const a = arcs[id < 0 ? ~id : id]
      const n = a.length / 2
      // Each arc after the first starts where the last one ended; skip the repeat.
      for (let k = out.length ? 1 : 0; k < n; k++) {
        const j = id < 0 ? n - 1 - k : k
        out.push(a[2 * j], a[2 * j + 1])
      }
    }
    return out
  }
  return (topo.objects[objectName]?.geometries ?? []).map((g: any): GeoShape => {
    const parts: number[][][] = g.type === 'Polygon' ? [g.arcs] : g.type === 'MultiPolygon' ? g.arcs : []
    const polygons = parts.map(rings => rings.map(ring))
    const box: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity]
    for (const poly of polygons) {
      const outer = poly[0] ?? []
      for (let i = 0; i < outer.length; i += 2) {
        box[0] = Math.min(box[0], outer[i]); box[2] = Math.max(box[2], outer[i])
        box[1] = Math.min(box[1], outer[i + 1]); box[3] = Math.max(box[3], outer[i + 1])
      }
    }
    const shape: GeoShape = { id: String(g.id), name: String(g.properties?.name ?? ''), box, polygons }
    if (g.properties?.label) shape.label = String(g.properties.label)
    return shape
  })
}

/** Even-odd across every ring of one polygon, so a point in a hole is outside it. */
export function insideRings(x: number, y: number, rings: number[][]): boolean {
  let inside = false
  for (const r of rings) {
    for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) {
      const xi = r[i], yi = r[i + 1], xj = r[j], yj = r[j + 1]
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
    }
  }
  return inside
}

/** The area a point is in, or null. */
export function shapeAt(shapes: readonly GeoShape[], lat: number, lng: number): GeoShape | null {
  for (const s of shapes) {
    if (lng < s.box[0] || lng > s.box[2] || lat < s.box[1] || lat > s.box[3]) continue
    if (s.polygons.some(poly => insideRings(lng, lat, poly))) return s
  }
  return null
}

interface LayerShapes {
  shapes: GeoShape[]
  byId: Map<string, GeoShape>
  /** Places by cityKey(name) — several when two places of a state share a name. */
  byName: Map<string, GeoShape[]>
}

/** Decoded once per file, on the first map build that needs it — never at start-up. */
const decoded = new Map<string, Promise<LayerShapes | null>>()
async function layerShapes(layer: MetricsBoundaryLayer, state?: string): Promise<LayerShapes | null> {
  const key = state ? `${layer}/${state}` : layer
  let p = decoded.get(key)
  if (!p) {
    p = (async () => {
      const file = await boundaryFile(layer, state)
      if (!file) return null
      const topo = JSON.parse((await gunzip(await fs.promises.readFile(file))).toString('utf8'))
      const shapes = decodeTopology(topo, 'areas')
      const byName = new Map<string, GeoShape[]>()
      if (layer === 'place') {
        for (const s of shapes) { const k = cityKey(s.name); byName.set(k, [...(byName.get(k) ?? []), s]) }
      }
      return { shapes, byId: new Map(shapes.map(s => [s.id, s])), byName }
    })()
    decoded.set(key, p)
    // A failed read is tried again next time, not remembered.
    p.catch(() => decoded.delete(key))
  }
  return p
}

/** Which state's ZIP file holds each ZIP code (a ZIP across a state line is filed with one state). */
let zipStates: Promise<Map<string, string>> | null = null
function zipFiledWith(): Promise<Map<string, string>> {
  if (!zipStates) {
    zipStates = fs.promises.readFile(path.join(GEO_DIR, 'zcta-states.json.gz'))
      .then(gz => gunzip(gz))
      .then(buf => {
        const index = JSON.parse(buf.toString('utf8')) as Record<string, string>
        const m = new Map<string, string>()
        for (const [state, zips] of Object.entries(index)) for (const z of zips.split(' ')) m.set(z, state)
        return m
      })
      .catch(e => { zipStates = null; throw e })
  }
  return zipStates
}

/** A city name as written on an address or by Census, made comparable: "St. George" = "Saint George". */
export function cityKey(name: string): string {
  return name.normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[.'’]/g, '').replace(/[^a-z0-9]+/g, ' ').trim()
    .replace(/^(saint|ste?) /, m => (m.startsWith('ste') ? 'sainte ' : 'saint '))
    .replace(/ (saint|ste?) /g, m => (m.trim().startsWith('ste') ? ' sainte ' : ' saint '))
}

// ── Placing properties ───────────────────────────────────────────────────────

/** One property (or rent with no property) as buildPlatformMap reads it — MAP_ROWS. */
export interface GeoRow {
  property_id: string | null
  state: string | null
  city?: string | null
  zip?: string | null
  lat: number | null
  lng: number | null
  location_stale: boolean
  units: number
  occupied: number
  money: string
}

/** Why something is not on a level's map. Never shown raw — each carries its own words. */
export type LevelGap =
  | 'unknown_state' | 'no_property' | 'no_location' | 'stale_location' | 'outside' | 'wrong_state'
  | 'no_match' | 'two_places' | 'no_layer' | 'no_shapes'

export interface LevelArea {
  /** The Census code: a place's 7 digits, a district's state + district, a ZIP code. */
  fips: string
  name: string
  /** Two-letter state the area's file is drawn with. */
  state: string
  stateFips: string
  units: number
  occupied: number
  money: number
  properties: number
}

export interface LevelMissing { reason: LevelGap; label: string; properties: number; units: number; occupied: number; money: number }

export interface MapLevel {
  areas: LevelArea[]
  missing: LevelMissing[]
  /** For a level drawn one state at a time: the states (FIPS) GAM has a property in at this level. */
  states: string[]
}

export type MapLevels = Record<MetricsBoundaryLayer, MapLevel>

const NOUN: Record<MetricsBoundaryLayer, { one: string; many: string }> = {
  place: { one: 'city or town', many: 'cities and towns' },
  cd: { one: 'congressional district', many: 'congressional districts' },
  sldu: { one: 'state senate district', many: 'state senate districts' },
  sldl: { one: 'state house district', many: 'state house districts' },
  zcta: { one: 'ZIP code area', many: 'ZIP code areas' },
}

/** Each reason in words, for this level's list under the map. */
export function levelGapLabel(level: MetricsBoundaryLayer, gap: LevelGap): string {
  const n = NOUN[level]
  switch (gap) {
    case 'unknown_state': return 'the state on its address is not a U.S. state or territory'
    case 'no_property': return 'rent on a bill with no space or lease on record'
    case 'no_location': return 'no map location on file for its address'
    case 'stale_location': return 'its address changed and no map location has been found for the new address'
    case 'outside': return `its map location is not inside any ${n.one} of its state`
    case 'wrong_state': return 'its map location is in a different state than its address'
    case 'no_match': return level === 'zcta'
      ? 'Census draws no area for the ZIP code on its address, and no map location puts it inside one'
      : 'the city on its address is not a Census city or town in its state, and no map location puts it inside one'
    case 'two_places': return 'two Census places in its state have the name of the city on its address, and no map location tells them apart'
    case 'no_layer': return `Census draws no ${n.many} for its state`
    case 'no_shapes': return `the ${n.one} map could not be read on the server`
  }
}

type Counts = { units: number; occupied: number; money: number }
const r2 = (n: number) => Math.round(n * 100) / 100

/**
 * 10/13 (Nic): every property placed at every new level — the per-area totals
 * and, per level, what could not be placed and why. `stateFips` is the Census
 * code for each two-letter state (platformMetrics STATE_FIPS).
 */
export async function buildMapLevels(rows: readonly GeoRow[], stateFips: Readonly<Record<string, string>>): Promise<MapLevels> {
  const abbrOf = new Map(Object.entries(stateFips).map(([abbr, f]) => [f, abbr]))
  const areas = new Map<MetricsBoundaryLayer, Map<string, LevelArea>>()
  const missing = new Map<MetricsBoundaryLayer, Map<LevelGap, LevelMissing>>()
  for (const l of METRICS_BOUNDARY_LAYERS) { areas.set(l, new Map()); missing.set(l, new Map()) }

  const miss = (level: MetricsBoundaryLayer, reason: LevelGap, n: Counts, isProperty: boolean) => {
    const m = missing.get(level)!
    const x = m.get(reason) ?? { reason, label: levelGapLabel(level, reason), properties: 0, units: 0, occupied: 0, money: 0 }
    x.properties += isProperty ? 1 : 0
    x.units += n.units; x.occupied += n.occupied; x.money += n.money
    m.set(reason, x)
  }
  const add = (level: MetricsBoundaryLayer, shape: GeoShape, fileState: string, n: Counts) => {
    const m = areas.get(level)!
    const a = m.get(shape.id) ?? {
      fips: shape.id,
      name: level === 'zcta' ? zipAreaName(shape.id) : shape.label || shape.name,
      state: abbrOf.get(fileState) ?? fileState, stateFips: fileState,
      units: 0, occupied: 0, money: 0, properties: 0,
    }
    a.properties += 1
    a.units += n.units; a.occupied += n.occupied; a.money += n.money
    m.set(shape.id, a)
  }

  // A file that cannot be read empties its level for this build (named under
  // the map), and is tried again on the next one.
  const unreadable = new Set<string>()
  const shapesFor = async (level: MetricsBoundaryLayer, state?: string): Promise<LayerShapes | null | 'unreadable'> => {
    const key = state ? `${level}/${state}` : level
    if (unreadable.has(key)) return 'unreadable'
    try { return await layerShapes(level, state) } catch (e) {
      unreadable.add(key)
      logger.error({ err: e, file: key }, '[platformMetricsGeo] a boundary file could not be read; that map is empty')
      return 'unreadable'
    }
  }

  let perState: Map<MetricsBoundaryLayer, Set<string>>
  try {
    perState = new Map(await Promise.all(METRICS_MAP_STATE_LEVELS.map(async l => [l, await statesWith(l)] as const)))
  } catch (e) {
    logger.error({ err: e }, '[platformMetricsGeo] the boundary index could not be read; the new map levels are empty')
    perState = new Map()
    for (const l of METRICS_BOUNDARY_LAYERS) unreadable.add(l)
  }

  for (const row of rows) {
    const n: Counts = { units: Number(row.units ?? 0), occupied: Number(row.occupied ?? 0), money: Number(row.money ?? 0) }
    if (!row.property_id) {
      for (const l of METRICS_BOUNDARY_LAYERS) miss(l, 'no_property', { units: 0, occupied: 0, money: n.money }, false)
      continue
    }
    const fips = stateFips[formatState(row.state ?? '')]
    if (!fips) { for (const l of METRICS_BOUNDARY_LAYERS) miss(l, 'unknown_state', n, true); continue }
    const hasPoint = row.lat != null && row.lng != null
    const usable = hasPoint && !row.location_stale
    const lat = Number(row.lat), lng = Number(row.lng)

    for (const level of METRICS_BOUNDARY_LAYERS) {
      if (unreadable.has(level)) { miss(level, 'no_shapes', n, true); continue }
      const byState = METRICS_MAP_STATE_LEVELS.includes(level)
      if (byState && !perState.get(level)?.has(fips)) { miss(level, 'no_layer', n, true); continue }
      const file = await shapesFor(level, byState ? fips : undefined)
      if (file === 'unreadable' || !file) { miss(level, 'no_shapes', n, true); continue }

      if (level === 'zcta') {
        const zip = String(row.zip ?? '').trim().match(/^(\d{5})(?:-?\d{4})?$/)?.[1]
        const own = zip ? file.byId.get(zip) : undefined
        if (own) { add(level, own, fips, n); continue }
        // Filed with the state its middle is in, when it crosses a state line.
        const elsewhere = zip ? await zipFiledWith().then(m => m.get(zip)).catch(() => undefined) : undefined
        if (elsewhere && elsewhere !== fips) {
          const other = await shapesFor(level, elsewhere)
          const shape = other && other !== 'unreadable' ? other.byId.get(zip!) : undefined
          if (shape) { add(level, shape, elsewhere, n); continue }
        }
        const at = usable ? shapeAt(file.shapes, lat, lng) : null
        if (at) add(level, at, fips, n)
        else miss(level, 'no_match', n, true)
        continue
      }

      if (level === 'place') {
        const key = cityKey(String(row.city ?? ''))
        const named = key ? file.byName.get(key) ?? [] : []
        if (named.length === 1) { add(level, named[0], fips, n); continue }
        const at = usable ? shapeAt(file.shapes, lat, lng) : null
        if (named.length > 1) {
          // Two places of one name: the one its map location is in, else the incorporated one.
          const incorporated = named.filter(s => !/\bCDP$/.test(s.label ?? ''))
          const pick = at && named.includes(at) ? at : incorporated.length === 1 ? incorporated[0] : null
          if (pick) add(level, pick, fips, n)
          else miss(level, 'two_places', n, true)
          continue
        }
        if (at) add(level, at, fips, n)
        else miss(level, 'no_match', n, true)
        continue
      }

      // Districts: by the map location only.
      if (!hasPoint) { miss(level, 'no_location', n, true); continue }
      if (row.location_stale) { miss(level, 'stale_location', n, true); continue }
      const at = shapeAt(file.shapes, lat, lng)
      if (!at) { miss(level, 'outside', n, true); continue }
      // The congressional file is national; a state's own files hold only its districts.
      if (!byState && at.id.slice(0, 2) !== fips) { miss(level, 'wrong_state', n, true); continue }
      add(level, at, byState ? fips : at.id.slice(0, 2), n)
    }
  }

  const byCode = (a: { fips: string; stateFips: string }, b: { fips: string; stateFips: string }) =>
    a.stateFips.localeCompare(b.stateFips) || a.fips.localeCompare(b.fips)
  const out = {} as MapLevels
  for (const level of METRICS_BOUNDARY_LAYERS) {
    const placed = [...areas.get(level)!.values()].map(a => ({ ...a, money: r2(a.money) })).sort(byCode)
    out[level] = {
      areas: placed,
      missing: [...missing.get(level)!.values()].map(m => ({ ...m, money: r2(m.money) })),
      // 10/17 (review): the state picker offers the states GAM is actually in,
      // not every state these files cover — it was offering all 56, 55 of them
      // with nothing on the map (gam-scope-staff-no-choices: scope it here and
      // the pointless choices are simply gone). A state whose properties could
      // not be placed is named under the map by reason, as before.
      states: METRICS_MAP_STATE_LEVELS.includes(level) ? [...new Set(placed.map(a => a.stateFips))].sort() : [],
    }
  }
  return out
}
