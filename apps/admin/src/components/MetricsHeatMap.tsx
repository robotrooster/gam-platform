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
 */
import React, { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { AxiosInstance } from 'axios'
import type { MultiLineString } from 'geojson'
import {
  formatCurrency, METRICS_MAP_LEVELS, METRICS_MAP_LEVEL_LABEL, METRICS_MAP_LEVEL_NOUN, METRICS_MAP_LEVEL_PLURAL,
  METRICS_MAP_STATE_LEVELS, type MetricsBoundaryLayer, type MetricsMapLevel,
} from '@gam/shared'
import {
  DOT_RADIUS, H, W, US_VIEW, flatNational, flatState, heat, loadLayer, loadUsAtlas, loadWorld, strength, viewFor,
  type FlatPicture, type FlatShape, type GeoArea, type GlobeView, type LayerShapes, type UsAtlas, type WorldLand,
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
export interface LevelArea extends MapArea { state: string; stateFips: string }
export interface LevelMissing { reason: string; label: string; properties: number; units: number; occupied?: number; money: number }
export interface PlatformMapData {
  states: Array<MapArea & { abbr: string }>
  counties: Array<MapArea & { state: string }>
  missing: MapMissing[]
  /** 10/13 (Nic): cities, congressional / state senate / state house districts, ZIP codes. */
  levels?: Partial<Record<MetricsBoundaryLayer, { areas: LevelArea[]; missing: LevelMissing[]; states: string[] }>>
}

type Level = MetricsMapLevel
/** 10/13 (Nic): "a toggle back to the flat map". */
type View = 'flat' | 'globe'
type Measure = 'units' | 'money'
/** 10/12 (Nic, H1): which spaces the Units view counts. */
type Spaces = 'occupied' | 'all'
/** The number a place is colored by. */
type Field = 'units' | 'occupied' | 'money'
/** A place in the list: its numbers and the state it is drawn with. */
type Listed = MapArea & { stateFips: string }

const count = (n: number) => Math.round(n).toLocaleString('en-US')
const unitsText = (n: number) => `${count(n)} ${n === 1 ? 'unit' : 'units'}`
const occupiedText = (n: number) => `${count(n)} occupied ${n === 1 ? 'unit' : 'units'}`
const valueText = (field: Field, n: number) =>
  field === 'money' ? formatCurrency(n) : field === 'occupied' ? occupiedText(n) : unitsText(n)
/** A place's number for a field; an API that does not send `occupied` yet reads as none. */
const valueOf = (a: { units: number; occupied?: number; money: number }, field: Field) => Number(a[field] ?? 0)
const propertiesText = (n: number) => `${count(n)} ${n === 1 ? 'property' : 'properties'}`
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
  const [measure, setMeasure] = useState<Measure>('units')
  const [spaces, setSpaces] = useState<Spaces>('occupied')
  const field: Field = measure === 'money' ? 'money' : spaces === 'occupied' ? 'occupied' : 'units'
  const [us, setUs] = useState<UsAtlas | null>(null)
  const [usFailed, setUsFailed] = useState(false)
  const [layer, setLayer] = useState<LayerShapes | null>(null)
  const [layerFailed, setLayerFailed] = useState(false)
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

  // The level's shapes from the API (behind admin login): the state on screen's, or every congressional district.
  useEffect(() => {
    setLayer(null)
    setLayerFailed(false)
    if (!boundary || (perState && !drawnState)) return
    if (!api) { setLayerFailed(true); return }
    let live = true
    loadLayer(api, boundary, perState ? drawnState : null)
      .then(l => { if (live) setLayer(l) })
      .catch(() => { if (live) setLayerFailed(true) })
    return () => { live = false }
  }, [api, boundary, perState, drawnState, attempt])

  const layerReady = !boundary || (!!layer && layer.level === boundary && layer.state === (perState ? drawnState : null))
  const ready = !!us && layerReady
  const geoAreas: GeoArea[] = useMemo(() => (!us || !layerReady ? []
    : level === 'state' ? us.states : level === 'county' ? us.counties : layer?.areas ?? []), [us, layerReady, level, layer])
  const flat = useMemo((): FlatPicture | null => {
    if (view !== 'flat' || !us || !layerReady) return null
    if (level === 'state' || level === 'county') return cachedFlat(us, level, () => flatNational(us, level))
    if (!layer) return null
    if (level === 'cd') return cachedFlat(layer, 'cd', () => flatNational(us, 'cd', layer))
    return drawnState ? cachedFlat(layer, drawnState, () => flatState(us, drawnState, layer)) : null
  }, [view, us, layerReady, level, layer, drawnState])
  const globeBorders: MultiLineString | null = !us ? null
    : level === 'county' ? us.countyBorders : boundary && layer ? layer.borders : null

  // The globe faces the state on screen, or the lower 48; the flat map needs no turning.
  useEffect(() => {
    if (!us) return
    const s = perState && drawnState ? us.stateById.get(drawnState) : null
    setTarget(s ? viewFor(s.feature) : US_VIEW)
  }, [us, perState, drawnState])

  const onMap = useMemo(() => (perState ? areas.filter(a => a.stateFips === drawnState) : areas), [perState, areas, drawnState])
  const byFips = useMemo(() => new Map(areas.map(a => [a.fips, a])), [areas])
  const max = useMemo(() => Math.max(0, ...onMap.map(a => valueOf(a, field))), [onMap, field])
  const shade = useMemo(() => {
    const m = new Map<string, number>()
    for (const a of onMap) { const o = strength(valueOf(a, field), max); if (o > 0) m.set(a.fips, o) }
    return m
  }, [onMap, field, max])
  const shapeName = useMemo(() => new Map(geoAreas.map(a => [a.id, a.name])), [geoAreas])

  const stateNameOf = (fips: string) => us?.stateName.get(fips) ?? data?.states.find(s => s.fips === fips)?.name ?? fips
  const placeName = (fips: string): string => {
    const a = byFips.get(fips)
    const name = a?.name || shapeName.get(fips) || fips
    if (level === 'state') return name
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
    () => areas.filter(a => valueOf(a, field) > 0).sort((a, b) => valueOf(b, field) - valueOf(a, field)),
    [areas, field])
  const ranked = showAll ? rankedAll : rankedAll.slice(0, TOP)
  const noun = METRICS_MAP_LEVEL_NOUN[level]
  const plural = METRICS_MAP_LEVEL_PLURAL[level]
  const what = field === 'money' ? 'rent' : field === 'occupied' ? 'occupied units' : 'units'
  const nothingAnywhere = areas.every(a => !(valueOf(a, field) > 0))
  const nothingHere = onMap.every(a => !(valueOf(a, field) > 0))
  // 10/12 (Nic) review: no `map` at all (an API that does not send it yet) is
  // not an empty map — it must not say "no units" beside tiles with real totals.
  const unavailable = data == null || (!!boundary && !levelData)
  const emptyText = unavailable
    ? 'Map numbers are not available yet.'
    // There are numbers, but none could be placed on this map (named below).
    : missing.some(x => valueOf(x, field) > 0)
      ? `No ${what} could be placed on the ${noun} map — see below.`
      : field === 'money' ? 'No rent has been logged yet.'
        : field === 'occupied' ? 'No units are occupied this month.' : 'No units under management yet.'
  // 10/13 (Nic): a one-state map with nothing in that state, while other states have some.
  const overlayText = nothingAnywhere ? emptyText
    : `No ${what} in ${drawnState ? stateNameOf(drawnState) : 'this state'} — the list beside the map has every ${noun} with ${what}.`

  // 10/12 (Nic) review: the color key, painted from the same strengths as the
  // map — the faint end is the smallest place's own color, the full end the
  // biggest's, and the steps between are even steps in value.
  const onMapRanked = onMap.filter(a => valueOf(a, field) > 0)
  const lowest = onMapRanked.length ? Math.min(...onMapRanked.map(a => valueOf(a, field))) : 0
  const keySteps = lowest > 0 && lowest < max ? [0, 1, 2, 3, 4].map(i => lowest + ((max - lowest) * i) / 4) : [max]

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
  // A place picked from the list: drawn with its own state, and faced on the globe.
  const pickFromList = (a: Listed) => {
    const next = selected === a.fips ? null : a.fips
    setSelected(next)
    if (!next) return
    if (perState && a.stateFips !== drawnState) { setChosenState(a.stateFips); return }
    const shape = geoAreas.find(g => g.id === a.fips)
    if (view === 'globe' && shape) setTarget(viewFor(shape.feature))
  }

  const measureWord = field === 'money' ? 'rent logged through GAM (all time)'
    : field === 'occupied' ? 'units occupied this month, counted the way GAM bills them' : 'units under management'
  const readout = (fips: string) => {
    const a = byFips.get(fips)
    return {
      name: placeName(fips),
      value: a && valueOf(a, field) !== 0 ? valueText(field, valueOf(a, field))
        : field === 'money' ? 'No rent logged' : field === 'occupied' ? 'None occupied' : 'No units',
      sub: a && a.properties > 0 ? propertiesText(a.properties) : '',
    }
  }
  const tip = hover ? readout(hover.fips) : null
  const pinned = !hover && selected ? readout(selected) : null
  const boxWidth = boxRef.current?.clientWidth ?? W
  const failed = usFailed || layerFailed || (view === 'globe' && globeFailed)
  const where = perState && drawnState ? stateNameOf(drawnState) : 'the United States'
  const picture = `${view === 'globe' ? 'Globe' : 'Map'} of ${where} by ${noun}, colored by ${measureWord}`
  const stateChoices = [...stateOptions].sort((a, b) => stateNameOf(a).localeCompare(stateNameOf(b)))

  return (
    <div className="card mhm" style={{ marginBottom: 16 }}>
      <div className="mhm-head">
        <div className="ct" style={{ marginBottom: 0 }}>Heat map</div>
        <div className="mhm-controls">
          <Toggle label="Flat map or globe" value={view} onChange={v => { setView(v); setHover(null) }}
            options={[{ value: 'flat', label: 'Flat map' }, { value: 'globe', label: 'Globe' }]}/>
          <select className="mhm-select" aria-label="Map level" value={level}
            onChange={e => { setLevel(e.target.value as Level); setShowAll(false) }}>
            {METRICS_MAP_LEVELS.map(l => <option key={l} value={l}>{METRICS_MAP_LEVEL_LABEL[l]}</option>)}
          </select>
          {perState && stateChoices.length > 0 && (
            <select className="mhm-select" aria-label="State on the map" value={drawnState ?? ''}
              onChange={e => { setChosenState(e.target.value); setSelected(null); setHover(null) }}>
              {stateChoices.map(s => <option key={s} value={s}>{stateNameOf(s)}</option>)}
            </select>
          )}
          <Toggle label="What the color shows" value={measure} onChange={setMeasure}
            options={[{ value: 'units', label: 'Units' }, { value: 'money', label: 'Money' }]}/>
          {measure === 'units' && (
            <Toggle label="Which units" value={spaces} onChange={setSpaces}
              options={[{ value: 'occupied', label: 'Occupied (billed)' }, { value: 'all', label: 'All spaces' }]}/>
          )}
        </div>
      </div>
      <div className="ks" style={{ margin: '4px 0 12px' }}>
        The stronger the gold, the more {measureWord}.
        {perState && ` ${capitalized(plural)} are drawn one state at a time.`}
      </div>

      <div className="mhm-body">
        <div>
          <div className="mhm-map" ref={boxRef} onPointerLeave={() => setHover(null)}>
            {failed ? (
              <div className="mhm-msg">
                <div>The map could not be drawn just now.</div>
                <button type="button" className="btn btn-primary btn-sm" onClick={() => setAttempt(n => n + 1)}>Try again</button>
              </div>
            ) : boundary && (unavailable || (perState && !drawnState)) ? (
              // Nothing to draw: an API that does not send this level yet, or no state to draw it for.
              <div className="mhm-msg">{unavailable ? emptyText : `No ${plural} can be drawn just now.`}</div>
            ) : !ready || !us || (view === 'globe' && !GlobeView) ? (
              <div className="mhm-msg"><span className="spinner"/> Drawing the map…</div>
            ) : (
              <>
                {view === 'globe' && GlobeView ? (
                  <GlobeView us={us} world={world} areas={geoAreas} borders={globeBorders} shade={shade} focus={focus}
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
                    {tip.sub && <div className="mhm-tip-sub">{tip.sub}</div>}
                  </div>
                )}
              </>
            )}
          </div>

          {/* Tapped on a phone (no hover there): the pick stays named under the map. */}
          <div className="mhm-readout" aria-live="polite">
            {pinned ? <><strong>{pinned.name}</strong> · {pinned.value}{pinned.sub ? ` · ${pinned.sub}` : ''}</>
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
                  {keySteps.map((v, i) => <span key={i} style={{ background: heat(strength(v, max)) }}/>)}
                </span>
              </span>
              {keySteps.length > 1 && <>
                <span className="mhm-key mono">{valueText(field, lowest)}</span>
                <span style={{ color: 'var(--t3)' }}>to</span>
              </>}
              <span className="mhm-key mono">{valueText(field, max)}</span>
            </div>
          )}
        </div>

        <div className="mhm-side" id={listId}>
          <div className="kl">
            {showAll || rankedAll.length <= TOP ? capitalized(plural) : `Top ${plural}`}
          </div>
          {ranked.length === 0
            ? <div style={{ color: 'var(--t3)', fontSize: '.78rem' }}>{emptyText}</div>
            : ranked.map(a => (
              <button key={a.fips} type="button" aria-pressed={selected === a.fips}
                className={`mhm-row${selected === a.fips ? ' on' : ''}`}
                onClick={() => pickFromList(a)}>
                <span className="mhm-row-name">{placeName(a.fips)}</span>
                <span className="mhm-row-value mono">{valueText(field, valueOf(a, field))}</span>
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
              {placeName(a.fips)} · {valueText(field, valueOf(a, field))} — {view === 'flat'
                ? 'outside the flat map (U.S. territories are drawn on the globe)'
                : 'no shape for it on this map'}
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
      `}</style>
    </div>
  )
}
