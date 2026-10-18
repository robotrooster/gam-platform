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
 */
import { feature, mesh } from 'topojson-client'
import {
  geoAlbersUsa, geoBounds, geoCentroid, geoConicEqualArea, geoContains, geoDistance, geoOrthographic, geoPath,
  type GeoProjection,
} from 'd3-geo'
import type { Topology, GeometryCollection } from 'topojson-specification'
import type { Feature, MultiLineString } from 'geojson'
import type { AxiosInstance } from 'axios'
import { METRICS_WORLD_LAYER, zipAreaName, type MetricsBoundaryLayer, type MetricsMapLevel } from '@gam/shared'

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
  /** The state the file covers; null for the national congressional file. */
  state: string | null
  areas: GeoArea[]
  /** Every area's outline, each line drawn once (a city's edge stands alone; it has no neighbor). */
  borders: MultiLineString
}

export function buildLayer(level: MetricsBoundaryLayer, state: string | null, topo: Topology): LayerShapes {
  const areas = toAreas(topo, 'areas', f => areaName(level, String(f.id), f.properties))
  return { level, state, areas, borders: mesh(topo, topo.objects.areas as GeometryCollection) }
}

const layerCache = new Map<string, Promise<LayerShapes>>()
/** A level's shapes (a state's, for a level drawn one state at a time); kept for the page's life. */
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

/** A state filling the frame, drawn equal-area around its own middle (Alaska across the date line too). */
export function stateProjection(state: Feature): GeoProjection {
  const [[, s], [, n]] = geoBounds(state)
  const [lng] = geoCentroid(state)
  return geoConicEqualArea()
    .parallels([s + (n - s) / 6, n - (n - s) / 6])
    .rotate([-lng, 0])
    .fitExtent([[12, 12], [W - 12, H - 12]], state)
}

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
  const path = geoPath(stateProjection(state.feature))
  return {
    areas: draw(path, layer.areas),
    context: path(countyLinesIn(us, stateFips)) ?? '',
    borders: path(layer.borders) ?? '',
    states: '',
    nation: path(state.feature) ?? '',
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

/** Strength of a place's color, 0.18 (a little) to 1 (the most on the map). Square-root, as before. */
export const strength = (v: number, max: number) => (v > 0 && max > 0 ? 0.18 + 0.82 * Math.sqrt(v / max) : 0)

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
