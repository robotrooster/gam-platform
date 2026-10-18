/**
 * 10/12 (Nic): the Metrics page heat map.
 *
 * "toggleable at the state and county levels. darker colors for more units in
 * that area. toggleable between a heat map for units and money."
 *
 * The numbers come from GET /admin/metrics (`map`, services/platformMetrics):
 * per state and per county (Census FIPS codes), units = the "Spaces under
 * management" tile and money = the "Rent logged through GAM" tile, by place.
 * What the server could not place is listed under the map with the reason —
 * nothing is placed by a guess, and nothing is quietly left off.
 *
 * The shapes are the Census county boundaries in the us-atlas package, already
 * projected to a 975×610 picture (Albers USA, with Alaska and Hawaii inset).
 * They are bundled into this app as their own chunk and loaded the first time
 * the map is shown — never fetched from a CDN. The server places properties
 * in the same edition of the same shapes, so every county code it sends has a
 * shape here. The territories (Puerto Rico and the rest) are not in the drawn
 * picture; a territory with units or rent is named under the map instead.
 *
 * 10/12 (Nic, H1): "heat map Units: TOGGLE BOTH (occupied/billed vs all
 * spaces)". The Units view shows either the spaces occupied this month as GAM
 * bills them (`occupied`: a lease, a month stay, owner use or a utility
 * arrangement — the Overview's Active Units count) or every space under
 * management (`units`). H2 (Nic: "brightest = most (OK)"): unchanged.
 *
 * "Darker for more": the color runs from faint to strong gold. In the light
 * theme strong is a deep, dark gold; on the dark theme strong is full gold —
 * the strongest color that page has (a near-black "most" would vanish into
 * the dark page). 10/12 (Nic) review: so the caption says "the stronger the
 * gold", which is true on both themes. The scale is square-root so one big
 * park does not wash every smaller place out to nothing; the exact number is
 * on hover or tap, and every place with a number is in the list beside the
 * map, which a keyboard or a screen reader reaches.
 *
 * 10/12 (Nic) review: each place is painted one solid color, the gold mixed
 * into the card's own background (heat()), and the color key is painted the
 * same way from the same strengths — so a place and its number in the key are
 * the same color, on either theme.
 *
 * 10/13 (Nic): more levels and a globe. "Toggle levels for cities,
 * congressional districts, state legislative districts (senate and house),
 * and ZIP codes", beside state and county; and "a 3D globe ... click and drag
 * to rotate the earth ... zooming in and out ... Still like the line art that
 * it is. I like that grayscale kind of stuff", with a toggle back to the flat
 * map. Each level's numbers come from the same endpoint (`map.levels`,
 * services/platformMetricsGeo) and add up to the tiles the same way; each has
 * its own "Not on this map" list. Cities, state legislative districts and ZIP
 * codes are drawn one state at a time (a state picker; it opens on the state
 * with the most of GAM's spaces) — tens of thousands of them nationwide.
 * Their shapes are Census boundary files the API serves behind admin login,
 * never from an outside site; the flat map now projects the longitude /
 * latitude edition of us-atlas exactly as its own Albers file was drawn, so
 * the flat map, the globe and the server all use one file. The globe is
 * MetricsGlobe; the shapes and the math are in metricsMapGeo.
 *
 * 10/14: the globe is its own chunk, loaded the first time it is shown, so the
 * flat map never pays for it (loadGlobe).
 *
 * 10/17: so is the land around the United States, which the globe turns over —
 * fetched from the API the first time the globe is shown (loadWorld).
 *
 * 10/17 (Nic): THE REST OF THE WORLD, and two overlays.
 *
 * The level menu is in two groups now. "That's only pertinent to the United
 * States for now. Just break the rest of the countries down by states or
 * province and then possibly cities as well or counties, if they have counties
 * within those provinces." So: countries, their states and provinces, and —
 * for the 199 countries that have a level below their provinces — that
 * country's counties or districts, drawn one country at a time the way a
 * state's cities are. Voting districts stay United States only. A property
 * lands on a world level by its map location alone: GAM holds a U.S. state on
 * an address, never a country, so there is nothing on an address to place one
 * by, and one with no map location is named under the map as always. The
 * shapes are Natural Earth and geoBoundaries, served by the API behind admin
 * login; geoBoundaries is CC BY 4.0 and the credit line under the map says so
 * whenever that level is drawn (METRICS_MAP_LEVEL_CREDIT).
 *
 * SATURATION — "overlay against census data and say, hey, look, we're in Santa
 * Cruz County and we are responsible for 30% of the population or 60% of the
 * total rental units ... so we can target areas that have room to grow.
 * Whereas if we're already highly saturated ... we may not want to have any
 * more marketing dollars spent there." The color becomes GAM's share of the
 * area's own market, so the strongest gold is where GAM is most saturated and
 * the faint places are the room to grow. Three denominators, each its own view
 * — "show all. because we are doing short term rentals as well as living
 * situations. its not only regular rentals. toggle each view/metric": renter-
 * occupied homes, all housing units, total population. The numerator is shown
 * BOTH ways side by side (every space on GAM, and the spaces occupied this
 * month); the Occupied / All spaces toggle picks which one the color follows.
 * The numbers are American Community Survey five-year estimates, fetched once
 * per level the first time the overlay is turned on (services/platformCensus).
 * The caption says in words what the percentage on screen is a percentage of.
 *
 * CONCENTRATION — "an overlay to show what areas GAM is heavily concentrated
 * in and how those voting districts kind of line up, and see where we can
 * focus." Over the congressional and state legislative districts (Nic: United
 * States only). The color is that district's share of every space GAM has
 * placed at that level — a share of GAM, not a share of the district, which
 * the caption says outright so it is never read as saturation.
 */
import React, { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { AxiosInstance } from 'axios'
import type { MultiLineString } from 'geojson'
import {
  CENSUS_BASIS_SLOT, censusCountsNothing, formatCurrency, formatShare, hasCensus, hasConcentration,
  isMetricsWorldLevel,
  METRICS_CENSUS_BASES, METRICS_CENSUS_BASIS_LABEL, METRICS_CENSUS_BASIS_MEANING, METRICS_CENSUS_BASIS_NOUN,
  METRICS_CENSUS_OVER_MEANING,
  METRICS_CONCENTRATION_MEANING, METRICS_MAP_COUNTRY_LEVELS, METRICS_MAP_LEVELS, METRICS_MAP_LEVEL_CREDIT,
  METRICS_MAP_LEVEL_LABEL, METRICS_MAP_LEVEL_NOUN, METRICS_MAP_LEVEL_PLURAL, METRICS_MAP_MEASURES,
  METRICS_MAP_MEASURE_LABEL, METRICS_MAP_STATE_LEVELS, METRICS_MAP_WORLD_LEVELS, METRICS_MAP_WORLD_NOTE,
  METRICS_SATURATION_FULL, sharePercent,
  type MetricsBoundaryLayer, type MetricsCensusBasis, type MetricsMapLevel, type MetricsMapMeasure,
} from '@gam/shared'
import {
  DOT_RADIUS, H, W, US_VIEW, WORLD_VIEW, flatCountry, flatNational, flatState, flatWorld, heat, loadCensus,
  loadLayer, loadUsAtlas, loadWorld, strength, viewFor,
  type CensusLevel, type FlatPicture, type FlatShape, type GeoArea, type GlobeView, type LayerShapes,
  type UsAtlas, type WorldLand,
} from './metricsMapGeo'
import type { MetricsGlobe as MetricsGlobeView } from './MetricsGlobe'

export interface MapArea { fips: string; name: string; units: number; occupied?: number; money: number; properties: number }
export interface MapMissing {
  reason: string
  label: string
  offStateMap: boolean
  properties: number
  units: number
  /** 10/12 (Nic, H1): of `units`, occupied this month as GAM bills them. */
  occupied?: number
  money: number
}
/** 10/13 (Nic): one city, district or ZIP code (services/platformMetricsGeo), with the state it is drawn with. */
export interface LevelArea extends MapArea {
  state: string
  stateFips: string
  /** 10/17 (Nic): for an area outside the United States, the country it is in and that country's name. */
  country?: string
  countryName?: string
}
export interface LevelMissing { reason: string; label: string; properties: number; units: number; occupied?: number; money: number }
export interface PlatformMapData {
  states: Array<MapArea & { abbr: string }>
  counties: Array<MapArea & { state: string }>
  missing: MapMissing[]
  /**
   * 10/13 (Nic): cities, congressional / state senate / state house districts,
   * ZIP codes. 10/17 (Nic): and the rest of the world — countries, their states
   * and provinces, and the counties or districts of the countries that have them.
   */
  levels?: Partial<Record<MetricsBoundaryLayer, {
    areas: LevelArea[]; missing: LevelMissing[]; states: string[]; countries?: string[]
  }>>
}

type Level = MetricsMapLevel
/** 10/13 (Nic): "a toggle back to the flat map". */
type View = 'flat' | 'globe'
/** 10/17 (Nic): Units, Money, and the two overlays — saturation and concentration. */
type Measure = MetricsMapMeasure
/** 10/12 (Nic, H1): which spaces the Units view counts. */
type Spaces = 'occupied' | 'all'
/** The number a place is colored by. */
type Field = 'units' | 'occupied' | 'money'
/** A place in the list: its numbers and the state (or country) it is drawn with. */
type Listed = MapArea & { stateFips: string; country?: string; countryName?: string }

const count = (n: number) => Math.round(n).toLocaleString('en-US')
const unitsText = (n: number) => `${count(n)} ${n === 1 ? 'unit' : 'units'}`
const occupiedText = (n: number) => `${count(n)} occupied ${n === 1 ? 'unit' : 'units'}`
const valueText = (field: Field, n: number) =>
  field === 'money' ? formatCurrency(n) : field === 'occupied' ? occupiedText(n) : unitsText(n)
/** A place's number for a field; an API that does not send `occupied` yet reads as none. */
const valueOf = (a: { units: number; occupied?: number; money: number }, field: Field) => Number(a[field] ?? 0)
const propertiesText = (n: number) => `${count(n)} ${n === 1 ? 'property' : 'properties'}`
/** 10/17 (review): GAM's own side of a saturation share, in words that hold when it is the bigger number. */
const spacesText = (n: number) => `${count(n)} ${n === 1 ? 'space' : 'spaces'}`
const capitalized = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

/** How many places the side list shows before "Show all". */
const TOP = 8

/** The globe, its own chunk; a failed load is forgotten so "Try again" really tries again. */
type Globe = typeof MetricsGlobeView
let globePromise: Promise<Globe> | null = null
function loadGlobe(): Promise<Globe> {
  if (!globePromise) {
    globePromise = import('./MetricsGlobe')
      .then(m => m.MetricsGlobe)
      .catch(e => { globePromise = null; throw e })
  }
  return globePromise
}

/** Each flat picture is drawn once per page load (thousands of paths), then reused. */
const flatCache = new WeakMap<object, Map<string, FlatPicture | null>>()
function cachedFlat(owner: object, key: string, make: () => FlatPicture | null): FlatPicture | null {
  let m = flatCache.get(owner)
  if (!m) { m = new Map(); flatCache.set(owner, m) }
  if (!m.has(key)) m.set(key, make())
  return m.get(key) ?? null
}

/** The colored areas. Memoized: hovering re-draws only the outline on top, not ~3,100 counties. */
const AreaLayer = React.memo(function AreaLayer({ shapes, shade }: { shapes: FlatShape[]; shade: Map<string, number> }) {
  return (
    <g>
      {shapes.map(s => (s.d
        ? <path key={s.id} d={s.d} data-fips={s.id} style={{ fill: heat(shade.get(s.id) ?? 0) }}/>
        : null))}
    </g>
  )
})

function Toggle<T extends string>({ label, value, options, onChange }: {
  label: string; value: T; options: Array<{ value: T; label: string }>; onChange: (v: T) => void
}) {
  return (
    <div className="mhm-seg" role="group" aria-label={label}>
      {options.map(o => (
        <button key={o.value} type="button" aria-pressed={o.value === value}
          className={o.value === value ? 'on' : ''} onClick={() => onChange(o.value)}>{o.label}</button>
      ))}
    </div>
  )
}

export function MetricsHeatMap({ data, api }: { data: PlatformMapData | null | undefined; api?: AxiosInstance }) {
  const [view, setView] = useState<View>('flat')
  const [level, setLevel] = useState<Level>('state')
  // 10/13 (Nic): cities, state legislative districts and ZIP codes are drawn one state at a time.
  const [chosenState, setChosenState] = useState<string | null>(null)
  // 10/17 (Nic): and the world's counties or districts one country at a time.
  const [chosenCountry, setChosenCountry] = useState<string | null>(null)
  const [chosenMeasure, setMeasure] = useState<Measure>('units')
  const [spaces, setSpaces] = useState<Spaces>('occupied')
  // 10/17 (Nic): which census number the saturation overlay divides by.
  const [basis, setBasis] = useState<MetricsCensusBasis>('renter')
  // 10/17 (Nic): the saturation overlay needs census numbers for this level,
  // and the concentration overlay is the voting districts only — a level that
  // has neither simply does not offer it, and his pick comes back when he
  // returns to a level that does.
  const measures = useMemo(() => METRICS_MAP_MEASURES.filter(m =>
    m === 'saturation' ? hasCensus(level) : m === 'concentration' ? hasConcentration(level) : true), [level])
  const measure: Measure = measures.includes(chosenMeasure) ? chosenMeasure : 'units'
  const share = measure === 'saturation' || measure === 'concentration'
  const field: Field = measure === 'money' ? 'money' : spaces === 'occupied' ? 'occupied' : 'units'
  const [us, setUs] = useState<UsAtlas | null>(null)
  const [usFailed, setUsFailed] = useState(false)
  const [layer, setLayer] = useState<LayerShapes | null>(null)
  const [layerFailed, setLayerFailed] = useState(false)
  // 10/17 (Nic): the country shapes, for the world's levels — the lines under
  // the provinces, and the outline around one country's own districts.
  const [countryLayer, setCountryLayer] = useState<LayerShapes | null>(null)
  // 10/17 (Nic): this level's census numbers, fetched the first time the
  // saturation overlay is turned on for it.
  const [census, setCensus] = useState<CensusLevel | null>(null)
  const [censusFailed, setCensusFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [GlobeView, setGlobeView] = useState<Globe | null>(null)
  const [globeFailed, setGlobeFailed] = useState(false)
  // 10/17: the land around the United States, for the globe only.
  const [world, setWorld] = useState<WorldLand | null>(null)
  const [hover, setHover] = useState<{ fips: string; x: number; y: number } | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  // 10/12 (Nic) review: the side list is the keyboard and screen-reader way to
  // every place's number, so it can show all of them, not only the top eight.
  const [showAll, setShowAll] = useState(false)
  const [target, setTarget] = useState<GlobeView>(US_VIEW)
  const boxRef = useRef<HTMLDivElement>(null)
  const listId = useId()

  useEffect(() => {
    let live = true
    setUsFailed(false)
    loadUsAtlas().then(s => { if (live) setUs(s) }).catch(() => { if (live) setUsFailed(true) })
    return () => { live = false }
  }, [attempt])

  // The globe's code loads the first time it is asked for.
  useEffect(() => {
    if (view !== 'globe' || GlobeView) return
    let live = true
    setGlobeFailed(false)
    loadGlobe().then(g => { if (live) setGlobeView(() => g) }).catch(() => { if (live) setGlobeFailed(true) })
    return () => { live = false }
  }, [view, GlobeView, attempt])

  // 10/17: the land around the United States, fetched the first time the globe
  // is shown — the flat map of the United States never shows it, so it never
  // pays for it. If it cannot be fetched the globe draws without it: the
  // numbers on it are the page's point, and none of them are in this file.
  useEffect(() => {
    if (view !== 'globe' || !api || world) return
    let live = true
    loadWorld(api).then(w => { if (live) setWorld(w) }).catch(() => {})
    return () => { live = false }
  }, [view, api, world, attempt])

  // A pick belongs to one level; switching levels starts clean.
  useEffect(() => { setSelected(null); setHover(null) }, [level])

  const boundary: MetricsBoundaryLayer | null = level === 'state' || level === 'county' ? null : level
  const perState = !!boundary && METRICS_MAP_STATE_LEVELS.includes(boundary)
  // 10/17 (Nic): the world's own levels — placed by map location, drawn on the
  // whole earth, and (at the county-or-district level) one country at a time.
  const worldLevel = isMetricsWorldLevel(level)
  const perCountry = !!boundary && METRICS_MAP_COUNTRY_LEVELS.includes(boundary)
  const levelData = boundary ? data?.levels?.[boundary] : undefined

  const areas: Listed[] = useMemo(() => {
    if (level === 'state') return (data?.states ?? []).map(a => ({ ...a, stateFips: a.fips }))
    if (level === 'county') return (data?.counties ?? []).map(a => ({ ...a, stateFips: a.fips.slice(0, 2) }))
    return levelData?.areas ?? []
  }, [data, level, levelData])

  // The state on screen at a one-state-at-a-time level: the one picked, else
  // the one with the most of GAM's spaces at this level (steady while the
  // Units / Money toggles change), else the one with the most spaces overall.
  const stateOptions = useMemo(() => (perState ? levelData?.states ?? [] : []), [perState, levelData])
  const defaultState = useMemo(() => {
    if (!perState) return null
    const totals = new Map<string, [number, number]>()
    for (const a of areas) {
      const t = totals.get(a.stateFips) ?? [0, 0]
      totals.set(a.stateFips, [t[0] + a.units, t[1] + a.money])
    }
    const best = [...totals.entries()].filter(([s, t]) => stateOptions.includes(s) && (t[0] > 0 || t[1] > 0))
      .sort((a, b) => b[1][0] - a[1][0] || b[1][1] - a[1][1])[0]?.[0]
    if (best) return best
    const byUnits = [...(data?.states ?? [])].filter(s => stateOptions.includes(s.fips)).sort((a, b) => b.units - a.units)[0]?.fips
    return byUnits ?? stateOptions[0] ?? null
  }, [perState, areas, stateOptions, data])
  const drawnState = perState ? (chosenState && stateOptions.includes(chosenState) ? chosenState : defaultState) : null

  // 10/17 (Nic): the country on screen at the world's county-or-district level
  // — the one picked, else the one with the most of GAM's spaces there.
  const countryOptions = useMemo(() => (perCountry ? levelData?.countries ?? [] : []), [perCountry, levelData])
  const defaultCountry = useMemo(() => {
    if (!perCountry) return null
    const totals = new Map<string, number>()
    for (const a of areas) if (a.country) totals.set(a.country, (totals.get(a.country) ?? 0) + a.units)
    const best = [...totals.entries()].filter(([c]) => countryOptions.includes(c))
      .sort((x, y) => y[1] - x[1])[0]?.[0]
    return best ?? countryOptions[0] ?? null
  }, [perCountry, areas, countryOptions])
  const drawnCountry = perCountry ? (chosenCountry && countryOptions.includes(chosenCountry) ? chosenCountry : defaultCountry) : null
  /** The file this level is drawn from: a state, a country, or the lot. */
  const drawnGroup = perState ? drawnState : perCountry ? drawnCountry : null
  const perGroup = perState || perCountry

  // The level's shapes from the API (behind admin login): the state or country
  // on screen's, or every congressional district, country or province at once.
  useEffect(() => {
    setLayer(null)
    setLayerFailed(false)
    if (!boundary || (perGroup && !drawnGroup)) return
    if (!api) { setLayerFailed(true); return }
    let live = true
    loadLayer(api, boundary, perGroup ? drawnGroup : null)
      .then(l => { if (live) setLayer(l) })
      .catch(() => { if (live) setLayerFailed(true) })
    return () => { live = false }
  }, [api, boundary, perGroup, drawnGroup, attempt])

  // 10/17 (Nic): the country shapes, for the world's levels only — the lines
  // under the provinces, and the outline around one country's own districts.
  // The country level draws them as its own areas, so it needs no second copy.
  useEffect(() => {
    if (!worldLevel || level === 'country' || !api) return
    let live = true
    loadLayer(api, 'country', null)
      .then(l => { if (live) setCountryLayer(l) })
      .catch(() => { if (live) setLayerFailed(true) })
    return () => { live = false }
  }, [worldLevel, level, api, attempt])

  // 10/17 (Nic): this level's census numbers, the first time the saturation
  // overlay asks for them. Nothing else on the page waits on them.
  //
  // 10/17 (review): the flag is cleared BEFORE the guard, the way the sibling
  // effects above do it. It used to be cleared after, so one failed fetch left
  // it set for the rest of the page's life: switching back to Units replaced
  // the whole map — Units, Money and all — with "could not be drawn", and Try
  // again returned at the guard without ever clearing it. Only a reload did.
  useEffect(() => {
    setCensusFailed(false)
    if (measure !== 'saturation' || !hasCensus(level) || census?.level === level) return
    if (!api) { setCensusFailed(true); return }
    let live = true
    loadCensus(api, level)
      .then(c => { if (live) setCensus(c) })
      .catch(() => { if (live) setCensusFailed(true) })
    return () => { live = false }
  }, [measure, level, api, census, attempt])

  const layerReady = !boundary || (!!layer && layer.level === boundary && layer.state === (perGroup ? drawnGroup : null))
  // 10/17 (Nic): the world's provinces and districts also wait on the country
  // shapes they are drawn over, and the saturation overlay on its census numbers.
  const worldReady = !worldLevel || level === 'country' || !!countryLayer
  const censusReady = measure !== 'saturation' || (!!census && census.level === level)
  const ready = !!us && layerReady && worldReady && censusReady
  const geoAreas: GeoArea[] = useMemo(() => (!us || !layerReady ? []
    : level === 'state' ? us.states : level === 'county' ? us.counties : layer?.areas ?? []), [us, layerReady, level, layer])
  /** 10/17: the country on screen's own shape, for the outline around its districts. */
  const countryShape = useMemo(() => (drawnCountry && countryLayer
    ? countryLayer.areas.find(a => a.id === drawnCountry) ?? null : null), [drawnCountry, countryLayer])
  const flat = useMemo((): FlatPicture | null => {
    if (view !== 'flat' || !us || !layerReady || !worldReady) return null
    if (level === 'state' || level === 'county') return cachedFlat(us, level, () => flatNational(us, level))
    if (!layer) return null
    if (level === 'cd') return cachedFlat(layer, 'cd', () => flatNational(us, 'cd', layer))
    // 10/17 (Nic): the world. Countries and provinces fill the earth; a
    // country's own districts fill the frame, as a state's cities do.
    if (level === 'country' || level === 'adm1') return cachedFlat(layer, level, () => flatWorld(layer, countryLayer))
    if (level === 'adm2') return drawnCountry ? cachedFlat(layer, drawnCountry, () => flatCountry(layer, countryShape)) : null
    return drawnState ? cachedFlat(layer, drawnState, () => flatState(us, drawnState, layer)) : null
  }, [view, us, layerReady, worldReady, level, layer, countryLayer, countryShape, drawnState, drawnCountry])
  const globeBorders: MultiLineString | null = !us ? null
    : level === 'county' ? us.countyBorders : boundary && layer ? layer.borders : null

  // The globe faces the state or country on screen, the lower 48, or — at a
  // world level — the whole earth; the flat map needs no turning.
  useEffect(() => {
    if (!us) return
    if (worldLevel) { setTarget(countryShape ? viewFor(countryShape.feature) : WORLD_VIEW); return }
    const s = perState && drawnState ? us.stateById.get(drawnState) : null
    setTarget(s ? viewFor(s.feature) : US_VIEW)
  }, [us, worldLevel, countryShape, perState, drawnState])

  const onMap = useMemo(() => (perState ? areas.filter(a => a.stateFips === drawnState)
    : perCountry ? areas.filter(a => a.country === drawnCountry) : areas),
  [perState, perCountry, areas, drawnState, drawnCountry])
  const byFips = useMemo(() => new Map(areas.map(a => [a.fips, a])), [areas])

  /**
   * 10/17 (Nic): the number the color stands for. Units and Money are the
   * place's own count; the two overlays are percentages of different wholes —
   * saturation is GAM's share of THAT AREA's market (census), concentration is
   * that area's share of EVERYTHING GAM has placed on this map.
   */
  const placedTotal = useMemo(() => {
    const t = { units: 0, occupied: 0, money: 0 }
    for (const a of areas) { t.units += a.units; t.occupied += Number(a.occupied ?? 0); t.money += a.money }
    return t
  }, [areas])
  /** An area's census denominator for the view on screen, or 0 when the Census has none for it. */
  const denominatorOf = (fips: string): number => Number(census?.areas?.[fips]?.[CENSUS_BASIS_SLOT[basis]] ?? 0)
  const shareOf = (a: { units: number; occupied?: number; money: number }, which: Field, fips: string): number =>
    measure === 'saturation' ? sharePercent(valueOf(a, which), denominatorOf(fips))
      : sharePercent(valueOf(a, which), placedTotal[which])
  const shown = (a: Listed): number => (share ? shareOf(a, field, a.fips) : valueOf(a, field))
  const shownText = (v: number) => (share ? formatShare(v) : valueText(field, v))

  const max = useMemo(() => Math.max(0, ...onMap.map(shown)), [onMap, field, measure, basis, census, placedTotal])
  /**
   * 10/17 (review): the top of the color scale. For a count it is the biggest
   * number on screen. For saturation it stops at 100% — as many spaces as the
   * Census counts in that area — because a park in a Census place of 47
   * renter-occupied homes reads 211%, and running the whole scale up to that
   * one washed every other area out to a faint smudge. The number itself is
   * never clipped: the hover, the list and the key all say 211%.
   */
  const scaleTop = measure === 'saturation' ? Math.min(max, METRICS_SATURATION_FULL) : max
  const shade = useMemo(() => {
    const m = new Map<string, number>()
    for (const a of onMap) { const o = strength(shown(a), scaleTop); if (o > 0) m.set(a.fips, o) }
    return m
  }, [onMap, field, measure, basis, census, placedTotal, scaleTop])
  const shapeName = useMemo(() => new Map(geoAreas.map(a => [a.id, a.name])), [geoAreas])

  const stateNameOf = (fips: string) => us?.stateName.get(fips) ?? data?.states.find(s => s.fips === fips)?.name ?? fips
  const countryNameOf = (code: string) => countryLayer?.areas.find(a => a.id === code)?.name
    ?? areas.find(a => a.country === code)?.countryName ?? code
  const placeName = (fips: string): string => {
    const a = byFips.get(fips)
    const name = a?.name || shapeName.get(fips) || fips
    if (level === 'state' || level === 'country') return name
    // 10/17 (Nic): outside the United States a place reads with its country —
    // "Entre Ríos, Argentina" — and inside it with its state.
    if (worldLevel) {
      const c = a?.country ?? drawnCountry ?? layer?.country.get(fips)?.code
      return c ? `${name}, ${countryNameOf(c)}` : name
    }
    // A territory has no shape on the flat map; the server's own state list names it.
    const st = a?.stateFips ?? (perState ? drawnState : fips.slice(0, 2))
    return st ? `${name}, ${stateNameOf(st)}` : name
  }

  // Places with a number that the picture on screen has no shape for: the
  // territories on the flat map (Albers USA leaves them out; the globe has them).
  const drawnIds = useMemo(() => (flat ? new Set(flat.areas.filter(s => s.d).map(s => s.id))
    : view === 'globe' && ready ? new Set(geoAreas.map(a => a.id)) : null), [flat, view, ready, geoAreas])
  const undrawn = drawnIds ? onMap.filter(a => valueOf(a, field) !== 0 && !drawnIds.has(a.fips)) : []
  const missing: Array<MapMissing | LevelMissing> = (level === 'state' ? (data?.missing ?? []).filter(x => x.offStateMap)
    : level === 'county' ? data?.missing ?? [] : levelData?.missing ?? [])
    .filter(x => valueOf(x, field) !== 0)
  const rankedAll = useMemo(
    () => areas.filter(a => shown(a) > 0).sort((a, b) => shown(b) - shown(a)),
    [areas, field, measure, basis, census, placedTotal])
  const ranked = showAll ? rankedAll : rankedAll.slice(0, TOP)
  /**
   * 10/17 (review): the areas GAM IS in that the Census counts nothing in.
   *
   * There is no share to draw for them, so they have no color and they are not
   * in the ranked list — and nothing under the map named them either, so a
   * real city with a hundred spaces simply vanished when the overlay came on.
   * Amado, Arizona is one: 41 people, 41 housing units, no renter-occupied
   * home in the survey at all. 3,343 of the 32,325 Census places and 2,727 of
   * the 33,772 ZIP areas are like that, so this is GAM's market, not an edge.
   * They are named with the reason instead.
   */
  const noCensus = useMemo(() => (measure !== 'saturation' || !census ? []
    : areas.filter(a => valueOf(a, field) > 0 && !(denominatorOf(a.fips) > 0))
      .sort((a, b) => valueOf(b, field) - valueOf(a, field))),
  [measure, census, areas, field, basis])
  const noun = METRICS_MAP_LEVEL_NOUN[level]
  const plural = METRICS_MAP_LEVEL_PLURAL[level]
  const what = field === 'money' ? 'rent' : field === 'occupied' ? 'occupied units' : 'units'
  const nothingAnywhere = areas.every(a => !(shown(a) > 0))
  const nothingHere = onMap.every(a => !(shown(a) > 0))
  // 10/12 (Nic) review: no `map` at all (an API that does not send it yet) is
  // not an empty map — it must not say "no units" beside tiles with real totals.
  const unavailable = data == null || (!!boundary && !levelData)
  const emptyText = unavailable
    ? 'Map numbers are not available yet.'
    // There are numbers, but none could be placed on this map (named below).
    : missing.some(x => valueOf(x, field) > 0)
      ? `No ${what} could be placed on the ${noun} map — see below.`
      // 10/17 (Nic): there are spaces, but no percentage to draw — the Census
      // counts nothing in any area GAM is in at this level.
      : share && areas.some(a => valueOf(a, field) > 0)
        ? measure === 'saturation'
          ? `The Census counts no ${METRICS_CENSUS_BASIS_NOUN[basis]} in any ${noun} GAM is in.`
          : `No ${what} could be placed on the ${noun} map.`
        : field === 'money' ? 'No rent has been logged yet.'
          : field === 'occupied' ? 'No units are occupied this month.' : 'No units under management yet.'
  // 10/13 (Nic): a one-state map with nothing in that state, while other states have some.
  const whereElse = perCountry ? (drawnCountry ? countryNameOf(drawnCountry) : 'this country')
    : drawnState ? stateNameOf(drawnState) : 'this state'
  const overlayText = nothingAnywhere ? emptyText
    : share
      ? `No ${noun} in ${whereElse} has a share to draw — the list beside the map has every ${noun} that does.`
      : `No ${what} in ${whereElse} — the list beside the map has every ${noun} with ${what}.`

  // 10/12 (Nic) review: the color key, painted from the same strengths as the
  // map — the faint end is the smallest place's own color, the full end the
  // biggest's, and the steps between are even steps in value.
  // 10/17 (review): the full end is the scale's top, which for saturation is
  // 100% however far past it the biggest area goes (scaleTop).
  const onMapRanked = onMap.filter(a => shown(a) > 0)
  const lowest = onMapRanked.length ? Math.min(...onMapRanked.map(shown)) : 0
  const keySteps = lowest > 0 && lowest < scaleTop
    ? [0, 1, 2, 3, 4].map(i => lowest + ((scaleTop - lowest) * i) / 4) : [scaleTop]

  const focus = hover?.fips ?? selected
  const focusShape = focus && flat ? flat.areas.find(s => s.id === focus && s.d) : undefined

  const fipsAt = (e: React.SyntheticEvent) => (e.target as Element).getAttribute?.('data-fips') ?? null
  // Hover is for a mouse only: a tap on a phone also sends pointer moves, and
  // the tap's own pick (named under the map) is the answer there.
  const onMove = (e: React.PointerEvent) => {
    if (e.pointerType !== 'mouse') return
    const fips = fipsAt(e)
    const box = boxRef.current?.getBoundingClientRect()
    if (!fips || !box) { setHover(null); return }
    setHover({ fips, x: e.clientX - box.left, y: e.clientY - box.top })
  }
  const onTap = (e: React.MouseEvent) => {
    const fips = fipsAt(e)
    setSelected(cur => (fips && fips !== cur ? fips : null))
  }
  // A place picked from the list: drawn with its own state or country, and faced on the globe.
  const pickFromList = (a: Listed) => {
    const next = selected === a.fips ? null : a.fips
    setSelected(next)
    if (!next) return
    if (perState && a.stateFips !== drawnState) { setChosenState(a.stateFips); return }
    if (perCountry && a.country && a.country !== drawnCountry) { setChosenCountry(a.country); return }
    const shape = geoAreas.find(g => g.id === a.fips)
    if (view === 'globe' && shape) setTarget(viewFor(shape.feature))
  }

  /**
   * 10/17 (Nic): what the color on screen means, in words — the caption, the
   * picture's own description, and the sentence that says plainly what a
   * percentage is a percentage of.
   */
  const measureWord = measure === 'saturation'
    ? `GAM's share of the ${METRICS_CENSUS_BASIS_NOUN[basis]} the Census counts in each ${noun}`
    : measure === 'concentration'
      ? `each ${noun}'s share of every space GAM has placed at this level`
      : field === 'money' ? 'rent logged through GAM (all time)'
        : field === 'occupied' ? 'units occupied this month, counted the way GAM bills them' : 'units under management'
  const meaning = measure === 'saturation' ? METRICS_CENSUS_BASIS_MEANING[basis]
    : measure === 'concentration' ? METRICS_CONCENTRATION_MEANING : ''
  /**
   * 10/17 (review): a share over 100% is real — a park is routinely bigger
   * than its whole Census place — so when one is on screen the caption says
   * what it means instead of leaving a number that looks like a mistake.
   */
  const anyOver = measure === 'saturation' && onMap.some(a => shown(a) > METRICS_SATURATION_FULL)

  const readout = (fips: string) => {
    const a = byFips.get(fips)
    const out = {
      name: placeName(fips),
      value: a && valueOf(a, field) !== 0 ? valueText(field, valueOf(a, field))
        : field === 'money' ? 'No rent logged' : field === 'occupied' ? 'None occupied' : 'No units',
      sub: a && a.properties > 0 ? propertiesText(a.properties) : '',
      /** 10/17 (Nic): the share, and the two numbers it came from, spelled out. */
      share: '',
      /** 10/17 (Nic): the numerator BOTH ways, side by side — every space, and occupied spaces. */
      both: '',
    }
    if (!share || !a) return out
    out.value = shownText(shown(a))
    if (measure === 'saturation') {
      const d = denominatorOf(fips)
      // 10/17 (review): "99 of 47 renter-occupied homes here" is nonsense, and
      // a park in a small Census place reads exactly that. One wording that is
      // true either way round: the spaces GAM has, beside the Census's count.
      out.share = d > 0
        ? `${spacesText(valueOf(a, field))} where the Census counts ${count(d)} ${METRICS_CENSUS_BASIS_NOUN[basis]}`
        : censusCountsNothing(METRICS_CENSUS_BASIS_NOUN[basis])
      out.both = d > 0
        ? `All spaces ${formatShare(shareOf(a, 'units', fips))} · Occupied ${formatShare(shareOf(a, 'occupied', fips))}`
        : ''
    } else {
      out.share = `${count(valueOf(a, field))} of GAM's ${count(placedTotal[field])} at this level`
      out.both = `All spaces ${formatShare(shareOf(a, 'units', fips))} · Occupied ${formatShare(shareOf(a, 'occupied', fips))}`
    }
    return out
  }
  const tip = hover ? readout(hover.fips) : null
  const pinned = !hover && selected ? readout(selected) : null
  const boxWidth = boxRef.current?.clientWidth ?? W
  // 10/17 (review): a census fetch only stops the overlay that reads it — the
  // globe's own failure is scoped the same way on this line. Units and Money
  // need no census numbers and must not go down with them.
  const failed = usFailed || layerFailed || (measure === 'saturation' && censusFailed)
    || (view === 'globe' && globeFailed)
  const where = perState && drawnState ? stateNameOf(drawnState)
    : perCountry && drawnCountry ? countryNameOf(drawnCountry)
      : worldLevel ? 'the world' : 'the United States'
  const picture = `${view === 'globe' ? 'Globe' : 'Map'} of ${where} by ${noun}, colored by ${measureWord}`
  const stateChoices = [...stateOptions].sort((a, b) => stateNameOf(a).localeCompare(stateNameOf(b)))
  const countryChoices = [...countryOptions].sort((a, b) => countryNameOf(a).localeCompare(countryNameOf(b)))
  /** 10/17 (Nic): the level menu in two groups — the United States, and the rest of the world. */
  const usLevels = METRICS_MAP_LEVELS.filter(l => !isMetricsWorldLevel(l))

  return (
    <div className="card mhm" style={{ marginBottom: 16 }}>
      <div className="mhm-head">
        <div className="ct" style={{ marginBottom: 0 }}>Heat map</div>
        <div className="mhm-controls">
          <Toggle label="Flat map or globe" value={view} onChange={v => { setView(v); setHover(null) }}
            options={[{ value: 'flat', label: 'Flat map' }, { value: 'globe', label: 'Globe' }]}/>
          <select className="mhm-select" aria-label="Map level" value={level}
            onChange={e => { setLevel(e.target.value as Level); setShowAll(false) }}>
            <optgroup label="United States">
              {usLevels.map(l => <option key={l} value={l}>{METRICS_MAP_LEVEL_LABEL[l]}</option>)}
            </optgroup>
            {/* 10/17 (Nic): "break the rest of the countries down by states or
                province and then possibly cities as well or counties". Voting
                districts stay United States only — they are in the group above. */}
            <optgroup label="Worldwide">
              {METRICS_MAP_WORLD_LEVELS.map(l => <option key={l} value={l}>{METRICS_MAP_LEVEL_LABEL[l]}</option>)}
            </optgroup>
          </select>
          {perState && stateChoices.length > 0 && (
            <select className="mhm-select" aria-label="State on the map" value={drawnState ?? ''}
              onChange={e => { setChosenState(e.target.value); setSelected(null); setHover(null) }}>
              {stateChoices.map(s => <option key={s} value={s}>{stateNameOf(s)}</option>)}
            </select>
          )}
          {perCountry && countryChoices.length > 0 && (
            <select className="mhm-select" aria-label="Country on the map" value={drawnCountry ?? ''}
              onChange={e => { setChosenCountry(e.target.value); setSelected(null); setHover(null) }}>
              {countryChoices.map(c => <option key={c} value={c}>{countryNameOf(c)}</option>)}
            </select>
          )}
          <Toggle label="What the color shows" value={measure} onChange={setMeasure}
            options={measures.map(m => ({ value: m, label: METRICS_MAP_MEASURE_LABEL[m] }))}/>
          {measure !== 'money' && (
            <Toggle label="Which units" value={spaces} onChange={setSpaces}
              options={[{ value: 'occupied', label: 'Occupied (billed)' }, { value: 'all', label: 'All spaces' }]}/>
          )}
          {/* 10/17 (Nic): "show all. because we are doing short term rentals as
              well as living situations. its not only regular rentals. toggle
              each view/metric" — each denominator is its own view. */}
          {measure === 'saturation' && (
            <Toggle label="Share of what" value={basis} onChange={setBasis}
              options={METRICS_CENSUS_BASES.map(b => ({ value: b, label: METRICS_CENSUS_BASIS_LABEL[b] }))}/>
          )}
        </div>
      </div>
      <div className="ks" style={{ margin: '4px 0 12px' }}>
        The stronger the gold, the more {measureWord}.
        {meaning && ` ${meaning}`}
        {/* 10/17 (review): a share past 100% and the world's own coastline
            rule are both said here, rather than left to be puzzled over. */}
        {anyOver && ` ${METRICS_CENSUS_OVER_MEANING}`}
        {worldLevel && ` ${METRICS_MAP_WORLD_NOTE}`}
        {perState && ` ${capitalized(plural)} are drawn one state at a time.`}
        {perCountry && ` ${capitalized(plural)} are drawn one country at a time.`}
      </div>

      <div className="mhm-body">
        <div>
          <div className="mhm-map" ref={boxRef} onPointerLeave={() => setHover(null)}>
            {failed ? (
              <div className="mhm-msg">
                <div>The map could not be drawn just now.</div>
                <button type="button" className="btn btn-primary btn-sm" onClick={() => setAttempt(n => n + 1)}>Try again</button>
              </div>
            ) : boundary && (unavailable || (perGroup && !drawnGroup)) ? (
              // Nothing to draw: an API that does not send this level yet, or
              // no state (or country) to draw it for.
              <div className="mhm-msg">{unavailable ? emptyText : `No ${plural} can be drawn just now.`}</div>
            ) : !ready || !us || (view === 'globe' && !GlobeView) ? (
              <div className="mhm-msg"><span className="spinner"/> Drawing the map…</div>
            ) : view === 'flat' && !flat ? (
              // 10/17: everything is in hand and the flat picture still cannot
              // be drawn — a state or country the flat map has no shape for.
              // Say so, rather than leaving an empty box with no explanation.
              <div className="mhm-msg">{`No ${plural} can be drawn flat just now — the globe draws them.`}</div>
            ) : (
              <>
                {view === 'globe' && GlobeView ? (
                  <GlobeView us={us} world={world} areas={geoAreas} borders={globeBorders} shade={shade} focus={focus}
                    stateLines={!worldLevel}
                    target={target} label={picture} describedBy={listId}
                    onHover={(fips, x, y) => setHover(fips ? { fips, x, y } : null)}
                    onPick={fips => setSelected(cur => (fips && fips !== cur ? fips : null))}/>
                ) : flat ? (
                  // A picture to a screen reader; every number in it is in the list beside it.
                  <svg viewBox={`0 0 ${W} ${H}`} role="img" onPointerMove={onMove} onClick={onTap}
                    aria-label={picture} aria-describedby={listId}>
                    {flat.context && <path d={flat.context} className="mhm-context-line" vectorEffect="non-scaling-stroke"/>}
                    <AreaLayer shapes={flat.areas} shade={shade}/>
                    {flat.borders && <path d={flat.borders} className={level === 'county' ? 'mhm-county-line' : 'mhm-area-line'} vectorEffect="non-scaling-stroke"/>}
                    {flat.states && <path d={flat.states} className="mhm-state-line" vectorEffect="non-scaling-stroke"/>}
                    {flat.nation && <path d={flat.nation} className="mhm-nation-line" vectorEffect="non-scaling-stroke"/>}
                    {/* A place with a number that is too small to see gets a marker in its own color. */}
                    {flat.areas.map(s => (s.dot && shade.get(s.id)
                      ? <circle key={`dot-${s.id}`} cx={s.dot[0]} cy={s.dot[1]} r={DOT_RADIUS} data-fips={s.id}
                          className={`mhm-dot${focus === s.id ? ' on' : ''}`} style={{ fill: heat(shade.get(s.id)!) }}/>
                      : null))}
                    {focusShape && <path d={focusShape.d} className="mhm-focus" vectorEffect="non-scaling-stroke"/>}
                  </svg>
                ) : null}
                {nothingHere && (
                  <div className="mhm-empty">
                    <span>{overlayText}</span>
                  </div>
                )}
                {tip && hover && (
                  <div className="mhm-tip" style={{
                    left: Math.min(hover.x + 14, Math.max(0, boxWidth - 200)),
                    top: hover.y + 14,
                  }}>
                    <div className="mhm-tip-name">{tip.name}</div>
                    <div className="mhm-tip-value">{tip.value}</div>
                    {/* 10/17 (Nic): the share, what it is a share of, and the
                        numerator both ways — every space, and occupied spaces. */}
                    {tip.share && <div className="mhm-tip-sub">{tip.share}</div>}
                    {tip.both && <div className="mhm-tip-sub">{tip.both}</div>}
                    {tip.sub && <div className="mhm-tip-sub">{tip.sub}</div>}
                  </div>
                )}
              </>
            )}
          </div>

          {/* Tapped on a phone (no hover there): the pick stays named under the map. */}
          <div className="mhm-readout" aria-live="polite">
            {pinned ? <><strong>{pinned.name}</strong> · {pinned.value}
                {pinned.share ? ` · ${pinned.share}` : ''}
                {pinned.both ? ` · ${pinned.both}` : ''}
                {pinned.sub ? ` · ${pinned.sub}` : ''}</>
              : <span style={{ color: 'var(--t3)' }}>
                Hover or tap a {noun} to see its number, or pick one from the list.
                {view === 'globe' && ' Drag to turn the globe; scroll or pinch to zoom.'}
              </span>}
          </div>

          {ready && !nothingHere && (
            <div className="mhm-legend" aria-label="Color key">
              <span className="mhm-key"><span className="mhm-swatch" style={{ background: 'var(--heat-none)' }}/>None</span>
              <span className="mhm-key">
                <span className="mhm-ramp">
                  {keySteps.map((v, i) => <span key={i} style={{ background: heat(strength(v, scaleTop)) }}/>)}
                </span>
              </span>
              {keySteps.length > 1 && <>
                <span className="mhm-key mono">{shownText(lowest)}</span>
                <span style={{ color: 'var(--t3)' }}>to</span>
              </>}
              {/* 10/17 (review): the full end of the ramp is the scale's top.
                  When something on screen is past it (over 100% saturated),
                  the key says so instead of naming one area's own number. */}
              <span className="mhm-key mono">{shownText(scaleTop)}{max > scaleTop ? ' or more' : ''}</span>
            </div>
          )}

          {/* 10/17 (Nic): "Credit geoBoundaries on the map (CC BY 4.0)" — the
              line says where the shapes on screen came from, whichever level
              that is, and the census edition when the overlay is reading it. */}
          <div className="ks mhm-credit">
            {METRICS_MAP_LEVEL_CREDIT[level]}
            {measure === 'saturation' && census ? ` Numbers: ${census.edition}` : ''}
          </div>
        </div>

        <div className="mhm-side" id={listId}>
          <div className="kl">
            {showAll || rankedAll.length <= TOP ? capitalized(plural) : `Top ${plural}`}
          </div>
          {/* 10/17 (Nic): the list is the keyboard and screen-reader way to
              every number, so it says what its percentages are of. */}
          {share && (
            <div className="ks" style={{ marginBottom: 4 }}>
              {measure === 'saturation'
                ? `Share of ${METRICS_CENSUS_BASIS_NOUN[basis]} — all spaces · occupied`
                : 'Share of every space GAM has placed at this level — all spaces · occupied'}
            </div>
          )}
          {ranked.length === 0
            ? <div style={{ color: 'var(--t3)', fontSize: '.78rem' }}>{emptyText}</div>
            : ranked.map(a => (
              <button key={a.fips} type="button" aria-pressed={selected === a.fips}
                className={`mhm-row${selected === a.fips ? ' on' : ''}`}
                onClick={() => pickFromList(a)}>
                <span className="mhm-row-name">{placeName(a.fips)}</span>
                <span className="mhm-row-value mono">{share
                  ? `${formatShare(shareOf(a, 'units', a.fips))} · ${formatShare(shareOf(a, 'occupied', a.fips))}`
                  : valueText(field, valueOf(a, field))}</span>
              </button>
            ))}
          {rankedAll.length > TOP && (
            <button type="button" className="btn btn-primary btn-sm mhm-more" aria-expanded={showAll}
              onClick={() => setShowAll(v => !v)}>
              {showAll ? `Show the top ${TOP}` : `Show all ${count(rankedAll.length)} ${plural}`}
            </button>
          )}
        </div>
      </div>

      {(missing.length > 0 || undrawn.length > 0) && (
        <div className="mhm-missing">
          <div className="kl" style={{ marginBottom: 4 }}>Not on this map</div>
          {missing.map(x => (
            <div key={x.reason} className="ks">
              {x.properties > 0 ? `${propertiesText(x.properties)} · ` : ''}{valueText(field, valueOf(x, field))} — {x.label}
            </div>
          ))}
          {undrawn.map(a => (
            <div key={a.fips} className="ks">
              {placeName(a.fips)} · {valueText(field, valueOf(a, field))} — {view === 'flat' && !worldLevel
                ? 'outside the flat map (U.S. territories are drawn on the globe)'
                : 'no shape for it on this map'}
            </div>
          ))}
        </div>
      )}

      {/* 10/17 (review): the areas GAM is in that the Census counts nothing
          in. They have no share, so they have no color and they are not in the
          list beside the map — and before this they were nowhere at all, which
          read as "GAM is not there". Amado, Arizona is one of them. */}
      {noCensus.length > 0 && (
        <div className="mhm-missing">
          <div className="kl" style={{ marginBottom: 4 }}>No Census count here</div>
          <div className="ks" style={{ marginBottom: 4 }}>
            {censusCountsNothing(METRICS_CENSUS_BASIS_NOUN[basis])}
            {` Each of these ${plural} is drawn with no color, and its spaces are still counted in the tiles above.`}
          </div>
          {noCensus.map(a => (
            <div key={a.fips} className="ks">
              {placeName(a.fips)} · {valueText(field, valueOf(a, field))}
              {a.properties > 0 ? ` · ${propertiesText(a.properties)}` : ''}
            </div>
          ))}
        </div>
      )}

      <style>{`
        .mhm { --heat-hi: var(--gold); --heat-base: var(--bg2); --heat-none: var(--bg3); }
        :root[data-theme="light"] .mhm { --heat-hi: var(--gold-ink, #7a5f0f); }
        .mhm-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; }
        .mhm-controls { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
        .mhm-seg { display: inline-flex; border: 1px solid var(--b1); border-radius: 7px; overflow: hidden; }
        .mhm-seg button { background: transparent; border: none; color: var(--t3); font-size: .72rem; font-weight: 600; padding: 5px 12px; cursor: pointer; }
        .mhm-seg button + button { border-left: 1px solid var(--b1); }
        .mhm-seg button.on { background: var(--bg4); color: var(--t0); }
        .mhm-seg button:focus-visible { outline: 2px solid var(--gold); outline-offset: -2px; }
        .mhm-select { background: var(--bg3); border: 1px solid var(--b1); border-radius: 7px; color: var(--t0); font-size: .72rem; font-weight: 600; padding: 5px 8px; max-width: 100%; }
        .mhm-select:focus-visible { outline: 2px solid var(--gold); outline-offset: 1px; }
        .mhm-body { display: grid; grid-template-columns: minmax(0, 3fr) minmax(200px, 1fr); gap: 16px; align-items: start; }
        @media (max-width: 900px) { .mhm-body { grid-template-columns: minmax(0, 1fr); } }
        .mhm-map { position: relative; width: 100%; aspect-ratio: ${W} / ${H}; }
        .mhm-map svg { display: block; width: 100%; height: 100%; cursor: pointer; touch-action: manipulation; }
        .mhm-globe { display: block; width: 100%; height: 100%; touch-action: none; cursor: grab; border-radius: 8px; }
        .mhm-globe:active { cursor: grabbing; }
        .mhm-globe:focus-visible { outline: 2px solid var(--gold); outline-offset: 2px; }
        .mhm-globe-tools { position: absolute; right: 8px; bottom: 8px; display: flex; gap: 6px; }
        .mhm-globe-tools .btn { min-width: 32px; }
        .mhm-county-line { fill: none; stroke: var(--bg2); stroke-width: .35px; stroke-opacity: .7; pointer-events: none; }
        .mhm-area-line { fill: none; stroke: var(--bg2); stroke-width: .5px; stroke-opacity: .8; pointer-events: none; }
        .mhm-context-line { fill: none; stroke: var(--b1); stroke-width: .5px; pointer-events: none; }
        .mhm-state-line { fill: none; stroke: var(--bg2); stroke-width: 1px; pointer-events: none; }
        .mhm-nation-line { fill: none; stroke: var(--b2); stroke-width: 1px; pointer-events: none; }
        .mhm-focus { fill: none; stroke: var(--t0); stroke-width: 1.6px; pointer-events: none; }
        .mhm-dot { stroke: var(--t1); stroke-width: 1px; vector-effect: non-scaling-stroke; }
        .mhm-dot.on { stroke: var(--t0); stroke-width: 2px; }
        .mhm-msg, .mhm-empty { position: absolute; inset: 0; display: flex; flex-direction: column; gap: 10px; align-items: center; justify-content: center; text-align: center; color: var(--t3); font-size: .8rem; padding: 12px; }
        .mhm-msg { flex-direction: row; flex-wrap: wrap; background: var(--bg3); border-radius: 8px; }
        .mhm-empty { pointer-events: none; color: var(--t1); }
        .mhm-empty span { background: var(--bg2); border: 1px solid var(--b1); border-radius: 6px; padding: 4px 10px; max-width: 90%; }
        .mhm-tip { position: absolute; pointer-events: none; background: var(--bg2); border: 1px solid var(--b2); border-radius: 8px; padding: 7px 10px; font-size: .74rem; color: var(--t1); box-shadow: 0 4px 16px rgba(0,0,0,.25); max-width: 200px; z-index: 2; }
        .mhm-tip-name { color: var(--t0); font-weight: 600; }
        .mhm-tip-value { font-family: var(--font-m); color: var(--t0); }
        .mhm-tip-sub { color: var(--t3); font-size: .68rem; }
        .mhm-readout { font-size: .76rem; color: var(--t1); min-height: 1.4em; margin-top: 8px; overflow-wrap: anywhere; }
        .mhm-readout strong { color: var(--t0); }
        .mhm-legend { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; margin-top: 8px; font-size: .7rem; color: var(--t2); }
        .mhm-key { display: inline-flex; align-items: center; gap: 6px; }
        .mhm-key.mono { font-size: .7rem; }
        .mhm-swatch { width: 12px; height: 12px; border-radius: 3px; border: 1px solid var(--b1); }
        .mhm-ramp { display: inline-flex; border-radius: 3px; overflow: hidden; }
        .mhm-ramp span { width: 18px; height: 12px; }
        .mhm-side { min-width: 0; }
        .mhm-row { display: flex; width: 100%; justify-content: space-between; gap: 10px; background: none; border: none; border-bottom: 1px solid var(--b0); padding: 7px 4px; font-size: .78rem; color: var(--t1); text-align: left; cursor: pointer; }
        .mhm-row:hover, .mhm-row.on { background: var(--bg3); color: var(--t0); }
        .mhm-row:focus-visible { outline: 2px solid var(--gold); outline-offset: -2px; }
        .mhm-row-name { min-width: 0; overflow-wrap: anywhere; }
        .mhm-row-value { white-space: nowrap; color: var(--t0); }
        .mhm-more { margin-top: 8px; }
        .mhm-missing { margin-top: 12px; padding-top: 10px; border-top: 1px solid var(--b0); }
        .mhm-credit { margin-top: 6px; color: var(--t3); }
      `}</style>
    </div>
  )
}
