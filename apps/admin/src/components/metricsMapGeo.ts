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
 *     districts. 10/18 (Nic): "when I change it to the city view, I have to
 *     then select between Arizona and Illinois. I can't just see them all in
 *     the city breakdown, like all every state." So the page loads a file per
 *     state and merges them (loadLayerGroups) — every state GAM has data in by
 *     default, every state at all on demand — and there is nothing to pick.
 *   - The land around the United States, for the globe: cut from the Natural
 *     Earth download that sits beside the Census files (public domain) and
 *     served by the API the same way, behind the same login.
 *   - 10/17 (Nic): the rest of the world's own levels — countries and their
 *     states and provinces (Natural Earth, public domain, one file each) and
 *     the level below a province in the countries that have one
 *     (geoBoundaries, CC BY 4.0, one file per country, merged the same way the
 *     states are). Served by the API behind the same login. geoBoundaries'
 *     credit line is METRICS_MAP_LEVEL_CREDIT, shown under the map whenever
 *     that level is drawn.
 *
 * 10/17 (Nic) also here: loadCensus, the American Community Survey numbers the
 * saturation overlay divides GAM's footprint by, fetched once per level the
 * first time that overlay is turned on (services/platformCensus).
 *
 * 10/18 (Nic) also here: MapView, where the map is looking — "I would like to
 * see about not having the map reset every time I change a setting. I'd like
 * it to stay — if I zoom in on a certain depth or whatever." One view the flat
 * map and the globe both read, so changing a setting (or the picture) keeps
 * the middle and the depth instead of snapping home.
 */
import { feature, mesh } from 'topojson-client'
import {
  geoAlbersUsa, geoBounds, geoCentroid, geoContains, geoDistance, geoNaturalEarth1,
  geoOrthographic, geoPath,
  type GeoProjection,
} from 'd3-geo'
import type { Topology, GeometryCollection } from 'topojson-specification'
import type { Feature, MultiLineString } from 'geojson'
import type { AxiosInstance } from 'axios'
import {
  METRICS_LEAN_FULL, METRICS_WORLD_LAYER, zipAreaName,
  type MetricsBoundaryLayer, type MetricsElectionFile, type MetricsMapLevel,
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
 *
 * 10/18 (Nic): a district's own file carries no country, because it used to be
 * the only country on screen. Several countries are drawn at once now, so the
 * country is read off the district's code ("CAN.0036"), which is how
 * build-geo-boundaries writes it. The country's NAME is not in that file; the
 * page has it from the country shapes (countryNameOf).
 */
export function areaCountry(level: MetricsMapLevel, id: string, props: any): { code: string; name: string } | null {
  if (level === 'country') return { code: id, name: String(props?.name || id) }
  if (level === 'adm1') {
    return props?.country ? { code: String(props.country), name: String(props.countryName || props.country) } : null
  }
  if (level === 'adm2') {
    const code = /^([A-Z]{3})\./.exec(id)?.[1]
    return code ? { code, name: String(props?.countryName || code) } : null
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

/**
 * The county lines of the states a city / district / ZIP map is drawn for,
 * faint under the level's own shapes. 10/18 (Nic): several states now, not one
 * — every state GAM has data in is on the map at once.
 */
export function countyLinesIn(us: UsAtlas, stateFips: readonly string[]): MultiLineString {
  const counties = us.topo.objects.counties as GeometryCollection
  const want = new Set(stateFips)
  const mine = { type: 'GeometryCollection', geometries: counties.geometries.filter(g => want.has(String(g.id).slice(0, 2))) } as GeometryCollection
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
   * 10/18 (Nic): the states (or — 10/17 — the countries) this picture covers,
   * in order: what was asked for, which is what it IS. Empty for a level that
   * comes in one file covering the lot (the national congressional districts,
   * every country, every province).
   */
  groups: string[]
  /**
   * 10/18 (Nic): a state (or country) in `groups` whose file would not load.
   * Its shapes are simply not in the picture — one file failing must never
   * blank the other states — and the page names it under the map. The picture
   * is still the one that was asked for, so nothing sits waiting for it.
   */
  failed: string[]
  areas: GeoArea[]
  /** Every area's outline, each line drawn once (a city's edge stands alone; it has no neighbor). */
  borders: MultiLineString
  /** 10/17: for a world level, each area's country, so a name can read "Entre Ríos, Argentina". */
  country: Map<string, { code: string; name: string }>
}

export function buildLayer(level: MetricsBoundaryLayer, group: string | null, topo: Topology): LayerShapes {
  const obj = topo.objects.areas as GeometryCollection
  const areas = toAreas(topo, 'areas', f => areaName(level, String(f.id), f.properties))
  const country = new Map<string, { code: string; name: string }>()
  for (const g of obj.geometries) {
    const of = areaCountry(level, String(g.id), (g as any).properties)
    if (of) country.set(String(g.id), of)
  }
  return { level, groups: group ? [group] : [], failed: [], areas, borders: mesh(topo, obj), country }
}

/** What a picture covers, as one string: the level, and the files it is made of. */
export const layerKey = (level: MetricsBoundaryLayer, groups: readonly string[]): string =>
  (groups.length ? `${level}/${[...groups].join('+')}` : level)

/**
 * 10/18 (Nic): several states' (or countries') files as one picture — "I can't
 * just see them all in the city breakdown, like all every state." Each file is
 * still its own fetch and its own cache entry; only the shapes are joined
 * here, so a state nobody is in is never downloaded and a state whose file
 * fails is left out by name instead of taking the others down.
 */
export function mergeLayers(
  level: MetricsBoundaryLayer,
  groups: readonly string[],
  parts: readonly LayerShapes[],
  failed: readonly string[] = [],
): LayerShapes {
  const country = new Map<string, { code: string; name: string }>()
  for (const p of parts) for (const [id, of] of p.country) country.set(id, of)
  return {
    level,
    groups: [...groups],
    failed: [...failed],
    areas: parts.flatMap(p => p.areas),
    borders: { type: 'MultiLineString', coordinates: parts.flatMap(p => p.borders.coordinates) },
    country,
  }
}

const layerCache = new Map<string, Promise<LayerShapes>>()
/**
 * One file's shapes — one state's, or one country's, for a level that comes
 * that way; kept for the page's life. Each is its own fetch, so a level nobody
 * opens is never downloaded (a country's districts are a few tens of
 * kilobytes, and there are 199 of them).
 */
export function loadLayer(api: AxiosInstance, level: MetricsBoundaryLayer, group: string | null): Promise<LayerShapes> {
  const key = group ? `${level}/${group}` : level
  let p = layerCache.get(key)
  if (!p) {
    p = api.get<Topology>(`/admin/metrics/boundaries/${key}`).then(r => buildLayer(level, group, r.data))
    layerCache.set(key, p)
    p.catch(() => layerCache.delete(key))
  }
  return p
}

/** Assembled pictures, so going back to a level does not re-join its files. */
const mergedCache = new Map<string, Promise<LayerShapes>>()
/**
 * 10/18 (Nic): a level's whole picture — every state GAM has data in by
 * default, every state at all on demand, and no state to pick. `groups` null
 * is a level that comes in one national file.
 *
 * Only a picture with nothing missing is remembered, so "Try again" really
 * does try the file that failed again. All of them failing rejects, which is
 * the page's "could not be drawn" — anything less draws what arrived.
 */
export function loadLayerGroups(api: AxiosInstance, level: MetricsBoundaryLayer, groups: readonly string[] | null): Promise<LayerShapes> {
  if (!groups) return loadLayer(api, level, null)
  const key = layerKey(level, groups)
  let p = mergedCache.get(key)
  if (!p) {
    p = Promise.all(groups.map(g => loadLayer(api, level, g).then(l => l, () => null)))
      .then(parts => {
        const got = parts.filter((l): l is LayerShapes => !!l)
        const failed = groups.filter((_, i) => !parts[i])
        if (!got.length) throw new Error(`no ${level} shapes could be loaded`)
        const merged = mergeLayers(level, groups, got, failed)
        if (failed.length) mergedCache.delete(key)
        return merged
      })
    mergedCache.set(key, p)
    p.catch(() => mergedCache.delete(key))
  }
  return p
}

/** Forgets every loaded shape, as reloading the page does — so a test can start cold. */
export function forgetLayers(): void { layerCache.clear(); mergedCache.clear() }

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
export interface FlatShape {
  id: string
  name: string
  d: string
  /**
   * 10/18 (Nic): the middle of the shape, on every shape that was drawn — the
   * lean overlay marks EVERY area GAM has spaces in, whatever its size, so a
   * big county's gold marker sits on top of its own voting color ("where our
   * strong areas tend to be in Democratic areas or Republican areas").
   */
  at?: [number, number]
  dot?: [number, number]
  /**
   * 10/18 (Nic): how wide the shape is in the frame's own units, on a shape
   * small enough for a marker — so the marker can go away once he has zoomed
   * in far enough to see the shape itself (dotNeeded).
   */
  span?: number
}

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
 * 10/18 (Nic): there is no "one state filling the frame" projection any more.
 * Every level of the United States is drawn in nationalProjection and every
 * world level in worldProjection, and looking closely at one state (or one
 * country) is zoom and pan over that one picture — flatLook below — which is
 * what "I'd like it to stay" needs: changing the level cannot change the frame
 * out from under the view.
 */

function draw(path: ReturnType<typeof geoPath>, areas: GeoArea[]): FlatShape[] {
  return areas.map(a => {
    const d = path(a.feature) ?? ''
    const shape: FlatShape = { id: a.id, name: a.name, d }
    if (d) {
      const [[x0, y0], [x1, y1]] = path.bounds(a.feature)
      const c = path.centroid(a.feature)
      if (Number.isFinite(c[0]) && Number.isFinite(c[1])) shape.at = [c[0], c[1]]
      if (x1 - x0 < DOT_BELOW_PX && y1 - y0 < DOT_BELOW_PX && shape.at) {
        shape.dot = [c[0], c[1]]
        shape.span = Math.max(x1 - x0, y1 - y0)
      }
    }
    return shape
  })
}

/**
 * 10/18 (Nic): is this shape still too small to see? A marker stands in for a
 * shape a few pixels across, and zooming in makes the shape itself big enough
 * — so past that depth the marker is in the way rather than the point.
 */
export const dotNeeded = (shape: FlatShape, depth: number): boolean =>
  !!shape.dot && (shape.span ?? 0) * depth < DOT_BELOW_PX

/**
 * The whole United States, at whichever level is on screen.
 *
 * 10/18 (Nic): the city, state-legislative-district and ZIP levels are drawn
 * here too now — "I can't just see them all in the city breakdown, like all
 * every state" — so every level of the United States is one picture in one
 * frame, and zoom and pan (MapView) are how a state gets looked at closely.
 * The faint lines underneath are the county lines of the states the picture is
 * made of; a level that comes in one national file (congressional districts)
 * has no states of its own and gets none.
 */
export function flatNational(us: UsAtlas, level: 'state' | 'county' | MetricsBoundaryLayer, layer?: LayerShapes | null): FlatPicture {
  const path = geoPath(nationalProjection())
  const areas = level === 'state' ? us.states : level === 'county' ? us.counties : layer?.areas ?? []
  return {
    areas: draw(path, areas),
    context: layer && layer.groups.length ? path(countyLinesIn(us, layer.groups)) ?? '' : '',
    borders: level === 'county' ? path(us.countyBorders) ?? '' : layer ? path(layer.borders) ?? '' : '',
    states: path(us.stateBorders) ?? '',
    nation: path(us.nation) ?? '',
  }
}

/**
 * 10/17 (Nic): the world flat — every country, or every state and province,
 * with the country lines under them. `countries` is the country layer, which
 * draws those lines (and is the level's own shapes at the country level).
 *
 * 10/18 (Nic): the counties-and-districts level is drawn here too, for every
 * country GAM has data in at once, by the same rule as the states.
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

// ── 10/18 (Nic): where the map is looking ───────────────────────────────────

/**
 * 10/18 (Nic): "I would like to see about not having the map reset every time
 * I change a setting. I'd like it to stay — if I zoom in on a certain depth or
 * whatever. Changing between state and county view leaves it the same."
 *
 * One view for both pictures, kept on the card across every setting change —
 * the level, units or money, occupied or all, the saturation denominator, the
 * overlays, and the flat map / globe toggle itself. It is held as a place on
 * the earth and a depth rather than as pixels or a rotation, because that is
 * the one description the flat map and the globe can both honor.
 */
export interface MapView {
  /** The middle of the picture, longitude and latitude; null is wherever the picture opens. */
  center: [number, number] | null
  /** How far in, as a multiple of the picture's own opening framing (1 = as it opens). */
  depth: number
}

/** The picture as it opens: its own middle, nothing zoomed in on. */
export const HOME_VIEW: MapView = { center: null, depth: 1 }

/**
 * How far in the view may go. The shallow end lets the globe pull back past
 * the lower 48 to the whole earth (MIN_ZOOM / US_VIEW.zoom); the deep end is
 * the globe's own limit, which on the flat map is a ZIP code filling a good
 * part of the frame.
 */
export const MIN_DEPTH = 0.5
export const MAX_DEPTH = MAX_ZOOM
export const atDepth = (depth: number): number => clamp(depth, MIN_DEPTH, MAX_DEPTH)

/** Where a level's picture opens, when nothing has been zoomed or turned yet. */
export const homeView = (worldLevel: boolean): GlobeView => (worldLevel ? WORLD_VIEW : US_VIEW)

/** The globe's own rotation and zoom for a kept view, around where that level opens. */
export function globeViewOf(view: MapView, home: GlobeView): GlobeView {
  return {
    rotate: view.center ? [-view.center[0], -view.center[1]] : home.rotate,
    zoom: clamp(home.zoom * view.depth, MIN_ZOOM, MAX_ZOOM),
  }
}

/** And back: what a turned, zoomed globe means as a kept view. */
export function viewOfGlobe(globe: GlobeView, home: GlobeView): MapView {
  return { center: [-globe.rotate[0], -globe.rotate[1]], depth: atDepth(globe.zoom / home.zoom) }
}

/** Facing an area, zoomed to it, as a kept view — a place picked from the list. */
export const viewOfArea = (f: Feature, home: GlobeView): MapView => viewOfGlobe(viewFor(f), home)

/**
 * The flat picture's own look at a kept view: how much to scale the 975×610
 * frame, and where to slide it, so `center` sits in the middle at `depth`.
 *
 * A projection that cannot draw that place at all — Albers USA has nothing to
 * say about Argentina — opens where it opens instead. The kept view is not
 * touched by that, so going back to the level that could draw it finds it
 * where it was.
 */
export function flatLook(projection: GeoProjection, view: MapView): { k: number; x: number; y: number } {
  const k = atDepth(view.depth)
  // Nothing panned yet: the frame's own middle, so the zoom buttons zoom into
  // the middle of the picture rather than refusing to do anything.
  const at = view.center ? projection(view.center) : ([W / 2, H / 2] as [number, number])
  if (!at || !Number.isFinite(at[0]) || !Number.isFinite(at[1])) return { k: 1, x: 0, y: 0 }
  return { k, x: W / 2 - at[0] * k, y: H / 2 - at[1] * k }
}

/** Where the middle of the flat picture sits, in the frame's own units. */
export function flatCenterPoint(projection: GeoProjection, view: MapView): [number, number] {
  const look = flatLook(projection, view)
  return [(W / 2 - look.x) / look.k, (H / 2 - look.y) / look.k]
}

/** A place on the earth this flat picture can actually draw, or null. */
function flatPlace(projection: GeoProjection, point: [number, number]): [number, number] | null {
  const lngLat = projection.invert?.(point)
  if (!lngLat || !Number.isFinite(lngLat[0]) || !Number.isFinite(lngLat[1])) return null
  const back = projection(lngLat as [number, number])
  if (!back || !Number.isFinite(back[0]) || !Number.isFinite(back[1])) return null
  return [lngLat[0], lngLat[1]]
}

/**
 * Dragging the flat map: the land moves with the pointer, so the middle moves
 * the other way. (dx, dy) are in the frame's own units. A drag that would
 * carry the middle off the edge of what this projection draws keeps the view
 * it had, which is what stops the map being dragged into nowhere.
 */
export function flatPan(projection: GeoProjection, view: MapView, dx: number, dy: number): MapView {
  const [cx, cy] = flatCenterPoint(projection, view)
  const k = atDepth(view.depth)
  const next = flatPlace(projection, [cx - dx / k, cy - dy / k])
  return next ? { center: next, depth: k } : view
}

/**
 * Zooming the flat map about a point in it (the pointer, or the middle): that
 * point stays where it is on screen and everything else moves around it.
 */
export function flatZoom(projection: GeoProjection, view: MapView, factor: number, about?: [number, number]): MapView {
  const k = atDepth(view.depth)
  const next = atDepth(k * factor)
  const [cx, cy] = flatCenterPoint(projection, view)
  const [ax, ay] = about ?? [cx, cy]
  const at = flatPlace(projection, [ax + (cx - ax) * (k / next), ay + (cy - ay) * (k / next)])
  return at ? { center: at, depth: next } : { center: view.center, depth: next }
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

// ── 10/18 (Nic): how an area votes ──────────────────────────────────────────

/**
 * 10/18 (Nic): the election results behind the lean overlay — "the overlay to
 * show which way those certain districts vote, and where our strong areas tend
 * to be in Democratic areas or Republican areas". Fetched once per level the
 * first time that overlay is turned on there (GET
 * /admin/metrics/elections/:level, services/platformElections), and only for a
 * level that has a file: counties are the only level these are published by,
 * and the page says so at the others rather than inventing a district margin.
 *
 * It holds CONTESTS, not a presidency — Nic also asked for "mayor data,
 * governor data, city council data, voting on public policy" — so each result
 * sits under its contest's id and each contest names its own two sides.
 */
const electionsCache = new Map<string, Promise<MetricsElectionFile>>()
export function loadElections(api: AxiosInstance, level: MetricsMapLevel): Promise<MetricsElectionFile> {
  let p = electionsCache.get(level)
  if (!p) {
    p = api.get<MetricsElectionFile>(`/admin/metrics/elections/${level}`).then(r => r.data)
    electionsCache.set(level, p)
    p.catch(() => electionsCache.delete(level))
  }
  return p
}

/** Forgets the election results, as reloading the page does — so a test can start cold. */
export function forgetElections(): void { electionsCache.clear() }

/**
 * THE DIVERGING SCALE. Red for the right, blue for the left, a neutral gray
 * between them — the two ends are ColorBrewer's RdBu middle stops, which are
 * the colour-blind-safe pair for exactly this (red and green would not be),
 * and both sit at a middling lightness so they read on the dark page and on
 * the light one without either end turning into the background.
 *
 * It is NOT the gold scale and must never be confused with it: gold on this
 * map always means GAM's own number, so in this overlay the area's color is
 * its vote and GAM's footprint is the gold marker on top of it.
 */
export const LEAN_RIGHT_RGB: [number, number, number] = [214, 96, 77]
export const LEAN_LEFT_RGB: [number, number, number] = [67, 147, 195]
export const LEAN_EVEN_RGB: [number, number, number] = [138, 146, 158]

/** How far along the scale a margin sits, 0 (dead even) to 1 (the top, or past it). */
export const leanStrength = (margin: number): number =>
  (Number.isFinite(margin) ? Math.min(Math.abs(margin) / METRICS_LEAN_FULL, 1) : 0)

/** An area's color for its margin: positive is the contest's right, negative its left. */
export const leanColor = (margin: number): string =>
  mixRgb(margin > 0 ? LEAN_RIGHT_RGB : LEAN_LEFT_RGB, LEAN_EVEN_RGB, leanStrength(margin))

/** The color key's own steps, left to right: the top of one side, through even, to the other. */
export const LEAN_KEY_STEPS: readonly number[] =
  [-METRICS_LEAN_FULL, -METRICS_LEAN_FULL / 2, 0, METRICS_LEAN_FULL / 2, METRICS_LEAN_FULL]
