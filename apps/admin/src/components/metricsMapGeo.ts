/**
 * 10/13 (Nic): the shapes and the math behind the Metrics heat map — the flat
 * map and the 3D globe. No React here, so it can be tested on its own.
 *
 * Nic: toggle levels for "cities, congressional districts, state legislative
 * districts (senate and house), and ZIP codes", and a globe — "click and drag
 * to rotate the earth ... zooming in and out ... Still like the line art that
 * it is. I like that grayscale kind of stuff" — with a toggle back to flat.
 *
 * WHERE THE SHAPES COME FROM — nothing is fetched from an outside site:
 *   - States and counties: the us-atlas package (Census, bundled into this
 *     app as its own chunk, loaded the first time the map is shown). The
 *     longitude/latitude edition, so the flat map (Albers USA — the picture
 *     us-atlas's own projected file is) and the globe draw the same file the
 *     API places properties in (services/platformMetrics.counties-10m.json).
 *   - Cities, congressional / state senate / state house districts, ZIP codes:
 *     Census boundary files the API keeps and serves behind admin login (GET
 *     /admin/metrics/boundaries), one file per state for all but congressional
 *     districts — the page loads only the state on screen.
 *   - The land around the United States, for the globe: cut from the Natural
 *     Earth download that sits beside the Census files (public domain) and
 *     served by the API the same way, behind the same login.
 *   - 10/17 (Nic): the rest of the world's own levels — countries and their
 *     states and provinces (Natural Earth, public domain, one file each) and
 *     the level below a province in the countries that have one
 *     (geoBoundaries, CC BY 4.0, one file per country so the page loads only
 *     the country on screen). Served by the API behind the same login.
 *     geoBoundaries' credit line is METRICS_MAP_LEVEL_CREDIT, shown under the
 *     map whenever that level is drawn.
 *
 * 10/17 (Nic) also here: loadCensus, the American Community Survey numbers the
 * saturation overlay divides GAM's footprint by, fetched once per level the
 * first time that overlay is turned on (services/platformCensus).
 */
import { feature, mesh } from 'topojson-client'
import {
  geoAlbersUsa, geoBounds, geoCentroid, geoConicEqualArea, geoContains, geoDistance, geoNaturalEarth1,
  geoOrthographic, geoPath,
  type GeoProjection,
} from 'd3-geo'
import type { Topology, GeometryCollection } from 'topojson-specification'
import type { Feature, MultiLineString } from 'geojson'
import type { AxiosInstance } from 'axios'
import {
  METRICS_WORLD_LAYER, zipAreaName, type MetricsBoundaryLayer, type MetricsMapLevel,
} from '@gam/shared'

/** The flat picture's size: us-atlas's own Albers USA frame (scale 1300, centered). */
export const W = 975
export const H = 610

/** One area on a map, in longitude/latitude. */
export interface GeoArea {
  id: string
  name: string
  feature: Feature
  /** geoBounds, for skipping the containment test on the globe. */
  bounds: [[number, number], [number, number]]
}

const toAreas = (topo: Topology, objectName: string, nameOf: (f: Feature) => string): GeoArea[] =>
  (feature(topo, topo.objects[objectName] as GeometryCollection) as any).features
    .filter((f: Feature) => f.geometry)
    .map((f: Feature) => ({ id: String(f.id), name: nameOf(f), feature: f, bounds: geoBounds(f) }))

/** A level's own name for one of its areas. ZIP files carry only the code. */
export function areaName(level: MetricsMapLevel, id: string, props: any): string {
  if (level === 'zcta') return zipAreaName(id)
  return String(props?.label || props?.name || id)
}

/**
 * 10/17 (Nic): the country a world area is in, off the file itself — the
 * provinces carry it, and at the country level the area IS the country. Null
 * for a United States level, which goes by state.
 */
export function areaCountry(level: MetricsMapLevel, id: string, props: any): { code: string; name: string } | null {
  if (level === 'country') return { code: id, name: String(props?.name || id) }
  if (level === 'adm1') {
    return props?.country ? { code: String(props.country), name: String(props.countryName || props.country) } : null
  }
  return null
}

// ── States and counties (us-atlas) ───────────────────────────────────────────

export interface UsAtlas {
  topo: Topology
  /** The whole country as one shape — the gray land under the globe's colors. */
  land: Feature
  states: GeoArea[]
  counties: GeoArea[]
  stateById: Map<string, GeoArea>
  stateName: Map<string, string>
  stateBorders: MultiLineString
  countyBorders: MultiLineString
  nation: MultiLineString
}

/**
 * The whole country as one shape. us-atlas files the nation as a collection,
 * so its pieces are gathered into a single shape here — 10/17: the earlier
 * code called the collection itself a shape, which drew right but read as
 * having no geometry at all.
 */
function nationShape(topo: Topology): Feature {
  const parts = ((feature(topo, topo.objects.nation as GeometryCollection) as any).features ?? []) as Feature[]
  if (parts.length === 1) return parts[0]
  return { type: 'Feature', properties: {}, geometry: { type: 'GeometryCollection', geometries: parts.map(f => f.geometry) } } as Feature
}

export function buildUsAtlas(topo: Topology): UsAtlas {
  const states = toAreas(topo, 'states', f => String(f.properties?.name ?? f.id))
  const counties = toAreas(topo, 'counties', f => String(f.properties?.name ?? f.id))
  const countyObj = topo.objects.counties as GeometryCollection
  return {
    topo, states, counties,
    land: nationShape(topo),
    stateById: new Map(states.map(s => [s.id, s])),
    stateName: new Map(states.map(s => [s.id, s.name])),
    stateBorders: mesh(topo, topo.objects.states as GeometryCollection, (a, b) => a !== b),
    countyBorders: mesh(topo, countyObj, (a, b) => a !== b && String(a.id).slice(0, 2) === String(b.id).slice(0, 2)),
    nation: mesh(topo, topo.objects.nation as GeometryCollection),
  }
}

/** One state's county lines, for the city / district / ZIP maps of that state. */
export function countyLinesIn(us: UsAtlas, stateFips: string): MultiLineString {
  const counties = us.topo.objects.counties as GeometryCollection
  const mine = { type: 'GeometryCollection', geometries: counties.geometries.filter(g => String(g.id).startsWith(stateFips)) } as GeometryCollection
  return mesh(us.topo, mine, (a, b) => a !== b)
}

/** Loaded once per page load; a failed load is forgotten so "Try again" really tries again. */
let usPromise: Promise<UsAtlas> | null = null
export function loadUsAtlas(): Promise<UsAtlas> {
  if (!usPromise) {
    usPromise = import('us-atlas/counties-10m.json')
      .then(m => buildUsAtlas(((m as any).default ?? m) as Topology))
      .catch(e => { usPromise = null; throw e })
  }
  return usPromise
}

// ── Cities, districts, ZIP codes (from the API) ──────────────────────────────

export interface LayerShapes {
  level: MetricsBoundaryLayer
  /**
   * The state the file covers, or — 10/17 (Nic) — the country, for a world
   * level drawn one country at a time. Null for a file that covers the lot
   * (the national congressional districts, every country, every province).
   */
  state: string | null
  areas: GeoArea[]
  /** Every area's outline, each line drawn once (a city's edge stands alone; it has no neighbor). */
  borders: MultiLineString
  /** 10/17: for a world level, each area's country, so a name can read "Entre Ríos, Argentina". */
  country: Map<string, { code: string; name: string }>
}

export function buildLayer(level: MetricsBoundaryLayer, state: string | null, topo: Topology): LayerShapes {
  const obj = topo.objects.areas as GeometryCollection
  const areas = toAreas(topo, 'areas', f => areaName(level, String(f.id), f.properties))
  const country = new Map<string, { code: string; name: string }>()
  for (const g of obj.geometries) {
    const of = areaCountry(level, String(g.id), (g as any).properties)
    if (of) country.set(String(g.id), of)
  }
  return { level, state, areas, borders: mesh(topo, obj), country }
}

const layerCache = new Map<string, Promise<LayerShapes>>()
/**
 * A level's shapes — one state's, or one country's, for a level drawn that way;
 * kept for the page's life. Each is its own fetch, so a level nobody opens is
 * never downloaded (a country's districts are a few tens of kilobytes, and
 * there are 199 of them).
 */
export function loadLayer(api: AxiosInstance, level: MetricsBoundaryLayer, state: string | null): Promise<LayerShapes> {
  const key = state ? `${level}/${state}` : level
  let p = layerCache.get(key)
  if (!p) {
    p = api.get<Topology>(`/admin/metrics/boundaries/${key}`).then(r => buildLayer(level, state, r.data))
    layerCache.set(key, p)
    p.catch(() => layerCache.delete(key))
  }
  return p
}

// ── 10/17 (Nic): the census numbers behind the saturation overlay ────────────

/**
 * One map level's census numbers, as the API serves them (GET
 * /admin/metrics/census/:level — American Community Survey five-year
 * estimates, kept beside the API; services/platformCensus). Each area is keyed
 * by the same code the map uses, so the join is code to code.
 */
export interface CensusLevel {
  level: string
  edition: string
  numbers: string[]
  /** code → [total population, all housing units, renter-occupied homes]. */
  areas: Record<string, [number, number, number]>
}

const censusCache = new Map<string, Promise<CensusLevel>>()
/** Fetched the first time the saturation overlay is turned on for a level; kept for the page's life. */
export function loadCensus(api: AxiosInstance, level: MetricsMapLevel): Promise<CensusLevel> {
  let p = censusCache.get(level)
  if (!p) {
    p = api.get<CensusLevel>(`/admin/metrics/census/${level}`).then(r => r.data)
    censusCache.set(level, p)
    p.catch(() => censusCache.delete(level))
  }
  return p
}

/** Forgets the census numbers, as reloading the page does — so a test can start cold. */
export function forgetCensus(): void { censusCache.clear() }

// ── The world, for the globe ─────────────────────────────────────────────────

/**
 * 10/17: the land around the United States, so the globe Nic asked for ("click
 * and drag to rotate the earth") turns over land and not blank ocean. The file
 * holds one shape per country, so `borders` is the coastlines and the lines
 * between countries — never the province lines inside a country. The United
 * States is not in it: the globe draws it from us-atlas, in finer detail.
 */
export interface WorldLand {
  /** Every country's land as one shape, to fill. */
  land: Feature
  /** The coastlines, and the lines between countries. */
  borders: MultiLineString
}

export function buildWorld(topo: Topology): WorldLand {
  const obj = topo.objects.areas as GeometryCollection
  const parts = ((feature(topo, obj) as any).features ?? []) as Feature[]
  return {
    land: {
      type: 'Feature', properties: {},
      geometry: { type: 'GeometryCollection', geometries: parts.map(f => f.geometry) },
    } as Feature,
    borders: mesh(topo, obj, (a, b) => a !== b),
  }
}

let worldPromise: Promise<WorldLand> | null = null
/** Fetched the first time the globe is shown; a failed load is forgotten, so it is tried again. */
export function loadWorld(api: AxiosInstance): Promise<WorldLand> {
  if (!worldPromise) {
    worldPromise = api.get<Topology>(`/admin/metrics/boundaries/${METRICS_WORLD_LAYER}`)
      .then(r => buildWorld(r.data))
      .catch(e => { worldPromise = null; throw e })
  }
  return worldPromise
}

/** Forgets the land, as reloading the page does — so a test can start cold. */
export function forgetWorld(): void { worldPromise = null }

// ── The flat map ─────────────────────────────────────────────────────────────

/**
 * One area drawn flat. `dot`: where to put a marker when the area is too small
 * to see (a few pixels across — a small town at the state view, a ZIP code in
 * a city), so a place with a number never vanishes from the map.
 */
export interface FlatShape { id: string; name: string; d: string; dot?: [number, number] }

/** An area smaller than this many pixels each way gets a marker when it has a number. */
export const DOT_BELOW_PX = 8
/** The marker's radius, in pixels. */
export const DOT_RADIUS = 5
export interface FlatPicture {
  areas: FlatShape[]
  /** Faint lines under the areas' own: a state's counties, on a city / district / ZIP map. */
  context: string
  /** The lines between this level's areas. */
  borders: string
  states: string
  nation: string
}

/** us-atlas's own Albers USA frame: Alaska and Hawaii inset; the territories are not in it. */
export const nationalProjection = (): GeoProjection => geoAlbersUsa().scale(1300).translate([W / 2, H / 2])

/**
 * 10/17 (Nic): the whole earth flat, for the world's own levels. Natural Earth
 * — the shape a world map is usually drawn in, curved meridians and all —
 * fitted to the same frame the United States is drawn in.
 */
export const worldProjection = (): GeoProjection =>
  geoNaturalEarth1().fitExtent([[2, 2], [W - 2, H - 2]], { type: 'Sphere' } as any)

/**
 * One area filling the frame, drawn equal-area around its own middle (Alaska
 * across the date line too). A state, at the city / district / ZIP levels; a
 * country, at the world's county-or-district level.
 */
export function areaProjection(area: Feature): GeoProjection {
  const [[, s], [, n]] = geoBounds(area)
  const [lng] = geoCentroid(area)
  return geoConicEqualArea()
    .parallels([s + (n - s) / 6, n - (n - s) / 6])
    .rotate([-lng, 0])
    .fitExtent([[12, 12], [W - 12, H - 12]], area)
}

/** The same, named for the state levels it was written for. */
export const stateProjection = areaProjection

function draw(path: ReturnType<typeof geoPath>, areas: GeoArea[]): FlatShape[] {
  return areas.map(a => {
    const d = path(a.feature) ?? ''
    const shape: FlatShape = { id: a.id, name: a.name, d }
    if (d) {
      const [[x0, y0], [x1, y1]] = path.bounds(a.feature)
      const c = path.centroid(a.feature)
      if (x1 - x0 < DOT_BELOW_PX && y1 - y0 < DOT_BELOW_PX && Number.isFinite(c[0]) && Number.isFinite(c[1])) shape.dot = [c[0], c[1]]
    }
    return shape
  })
}

/** The national flat map at the state, county or congressional district level. */
export function flatNational(us: UsAtlas, level: 'state' | 'county' | 'cd', layer?: LayerShapes | null): FlatPicture {
  const path = geoPath(nationalProjection())
  const areas = level === 'state' ? us.states : level === 'county' ? us.counties : layer?.areas ?? []
  return {
    areas: draw(path, areas),
    context: '',
    borders: level === 'county' ? path(us.countyBorders) ?? '' : level === 'cd' && layer ? path(layer.borders) ?? '' : '',
    states: path(us.stateBorders) ?? '',
    nation: path(us.nation) ?? '',
  }
}

/** One state's cities, state legislative districts or ZIP codes, the state filling the map. */
export function flatState(us: UsAtlas, stateFips: string, layer: LayerShapes): FlatPicture | null {
  const state = us.stateById.get(stateFips)
  if (!state) return null
  const path = geoPath(areaProjection(state.feature))
  return {
    areas: draw(path, layer.areas),
    context: path(countyLinesIn(us, stateFips)) ?? '',
    borders: path(layer.borders) ?? '',
    states: '',
    nation: path(state.feature) ?? '',
  }
}

/**
 * 10/17 (Nic): the world flat — every country, or every state and province,
 * with the country lines under them. `countries` is the country layer, which
 * draws those lines (and is the level's own shapes at the country level).
 */
export function flatWorld(layer: LayerShapes, countries: LayerShapes | null): FlatPicture {
  const path = geoPath(worldProjection())
  return {
    areas: draw(path, layer.areas),
    // At the country level the lines between countries ARE the level's own.
    context: layer.level === 'country' || !countries ? '' : path(countries.borders) ?? '',
    borders: path(layer.borders) ?? '',
    states: '',
    nation: '',
  }
}

/**
 * 10/17 (Nic): one country's counties or districts, the country filling the
 * map — "if they have counties within those provinces". `outline` is that
 * country's own shape, from the country layer, drawn around them.
 */
export function flatCountry(layer: LayerShapes, outline: GeoArea | null): FlatPicture | null {
  if (!outline) return null
  const path = geoPath(areaProjection(outline.feature))
  return {
    areas: draw(path, layer.areas),
    context: '',
    borders: path(layer.borders) ?? '',
    states: '',
    nation: path(outline.feature) ?? '',
  }
}

// ── The globe ────────────────────────────────────────────────────────────────

/** Where the globe faces ([longitude, latitude] rotation, as d3 takes it) and how far in it is. */
export interface GlobeView { rotate: [number, number]; zoom: number }

export const MIN_ZOOM = 0.8
export const MAX_ZOOM = 160
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

/** The United States facing out, with the curve of the earth in view. */
export const US_VIEW: GlobeView = { rotate: [98, -36], zoom: 1.35 }

/** 10/17 (Nic): the whole earth, for the world's own levels — nothing zoomed in on. */
export const WORLD_VIEW: GlobeView = { rotate: [20, -15], zoom: 1 }

/** The globe's radius at zoom 1: a little inside the frame. */
export const globeRadius = (width: number, height: number, zoom: number) => Math.min(width, height) * 0.46 * zoom

export function globeProjection(view: GlobeView, width: number, height: number): GeoProjection {
  return geoOrthographic()
    .scale(globeRadius(width, height, view.zoom))
    .translate([width / 2, height / 2])
    .rotate([view.rotate[0], view.rotate[1], 0])
    .clipAngle(90)
    .precision(0.6)
}

/** A drag of (dx, dy) pixels turns the earth under the pointer — slower the further in. */
export function dragRotate(view: GlobeView, dx: number, dy: number, width: number, height: number): GlobeView {
  const degPerPx = 180 / (Math.PI * globeRadius(width, height, view.zoom))
  let lng = view.rotate[0] + dx * degPerPx
  lng = ((lng + 540) % 360) - 180
  return { rotate: [lng, clamp(view.rotate[1] - dy * degPerPx, -89, 89)], zoom: view.zoom }
}

export function zoomBy(view: GlobeView, factor: number): GlobeView {
  return { rotate: view.rotate, zoom: clamp(view.zoom * factor, MIN_ZOOM, MAX_ZOOM) }
}

/** Facing an area, zoomed so it fills most of the frame. */
export function viewFor(f: Feature): GlobeView {
  const c = geoCentroid(f)
  const [[w, s], [e, n]] = geoBounds(f)
  const reach = Math.max(...[[w, s], [w, n], [e, s], [e, n], [c[0], s], [c[0], n]]
    .map(p => geoDistance(c, p as [number, number])))
  const zoom = 0.9 / Math.sin(clamp(reach, 0.002, Math.PI / 2))
  return { rotate: [-c[0], -c[1]], zoom: clamp(zoom, 1, MAX_ZOOM) }
}

/** Is a longitude/latitude inside geoBounds (which run west → east, across the date line when west > east)? */
export function inBounds(b: GeoArea['bounds'], lng: number, lat: number): boolean {
  const [[w, s], [e, n]] = b
  if (lat < s || lat > n) return false
  return w <= e ? lng >= w && lng <= e : lng >= w || lng <= e
}

/** The area under a point on the globe (screen x, y), or null — the far side of the earth is never hit. */
export function areaAt(areas: readonly GeoArea[], projection: GeoProjection, x: number, y: number): GeoArea | null {
  const [cx, cy] = projection.translate()
  if (Math.hypot(x - cx, y - cy) > projection.scale()) return null
  const p = projection.invert?.([x, y])
  if (!p || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) return null
  for (const a of areas) if (inBounds(a.bounds, p[0], p[1]) && geoContains(a.feature, p)) return a
  return null
}

// ── Color ────────────────────────────────────────────────────────────────────

/**
 * Strength of a place's color, 0.18 (a little) to 1 (the most on the map).
 * Square-root, as before.
 *
 * 10/17 (review): a value past `max` is held at full instead of running over
 * it, because the saturation overlay tops its scale out at 100% — as many
 * spaces as the Census counts in an area. One park in a Census place of 47
 * renter-occupied homes reads 211%, and scaling every other area against that
 * one washed the rest of the map out to nothing.
 */
export const strength = (v: number, max: number) =>
  (v > 0 && max > 0 ? 0.18 + 0.82 * Math.sqrt(Math.min(v / max, 1)) : 0)

/**
 * 10/12 (Nic) review: the one solid color for a strength — gold mixed into the
 * card's background. Used by the flat map and the color key alike, so they
 * match; the globe mixes the same two colors itself (mixRgb), as a canvas
 * cannot read CSS.
 */
export const heat = (o: number) =>
  o > 0 ? `color-mix(in srgb, var(--heat-hi) ${Math.round(o * 1000) / 10}%, var(--heat-base))` : 'var(--heat-none)'

/** Mix two colors in sRGB, as CSS color-mix(in srgb, a o, b) does (the flat map's own colors). */
export function mixRgb(a: [number, number, number], b: [number, number, number], o: number): string {
  const c = (i: number) => Math.round(a[i] * o + b[i] * (1 - o))
  return `rgb(${c(0)}, ${c(1)}, ${c(2)})`
}
