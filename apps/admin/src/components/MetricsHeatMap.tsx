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
 */
import React, { useEffect, useId, useMemo, useRef, useState } from 'react'
import { feature, mesh } from 'topojson-client'
import { geoPath } from 'd3-geo'
import type { Topology, GeometryCollection } from 'topojson-specification'
import { formatCurrency } from '@gam/shared'

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
export interface PlatformMapData {
  states: Array<MapArea & { abbr: string }>
  counties: Array<MapArea & { state: string }>
  missing: MapMissing[]
}

type Level = 'state' | 'county'
type Measure = 'units' | 'money'
/** 10/12 (Nic, H1): which spaces the Units view counts. */
type Spaces = 'occupied' | 'all'
/** The number a place is colored by. */
type Field = 'units' | 'occupied' | 'money'

interface Shape { fips: string; name: string; d: string }
interface Shapes {
  states: Shape[]
  counties: Shape[]
  stateBorders: string
  countyBorders: string
  nation: string
  stateName: Map<string, string>
}

const W = 975, H = 610

/** Built once per page load; a failed load is forgotten so "Try again" really tries again. */
let shapesPromise: Promise<Shapes> | null = null
function loadShapes(): Promise<Shapes> {
  if (!shapesPromise) {
    shapesPromise = import('us-atlas/counties-albers-10m.json')
      .then(m => buildShapes((m as any).default ?? m))
      .catch(e => { shapesPromise = null; throw e })
  }
  return shapesPromise
}

function buildShapes(topo: Topology): Shapes {
  const path = geoPath()
  const states = topo.objects.states as GeometryCollection<{ name: string }>
  const counties = topo.objects.counties as GeometryCollection<{ name: string }>
  const toShapes = (o: GeometryCollection<{ name: string }>): Shape[] =>
    (feature(topo, o) as any).features.map((f: any) => ({ fips: String(f.id), name: String(f.properties?.name ?? ''), d: path(f) ?? '' }))
  const stateShapes = toShapes(states)
  return {
    states: stateShapes,
    counties: toShapes(counties),
    stateBorders: path(mesh(topo, states, (a, b) => a !== b)) ?? '',
    countyBorders: path(mesh(topo, counties, (a, b) => a !== b && String(a.id).slice(0, 2) === String(b.id).slice(0, 2))) ?? '',
    nation: path(mesh(topo, topo.objects.nation as GeometryCollection)) ?? '',
    stateName: new Map(stateShapes.map(s => [s.fips, s.name])),
  }
}

const count = (n: number) => Math.round(n).toLocaleString('en-US')
const unitsText = (n: number) => `${count(n)} ${n === 1 ? 'unit' : 'units'}`
const occupiedText = (n: number) => `${count(n)} occupied ${n === 1 ? 'unit' : 'units'}`
const valueText = (field: Field, n: number) =>
  field === 'money' ? formatCurrency(n) : field === 'occupied' ? occupiedText(n) : unitsText(n)
/** A place's number for a field; an API that does not send `occupied` yet reads as none. */
const valueOf = (a: { units: number; occupied?: number; money: number }, field: Field) => Number(a[field] ?? 0)
const propertiesText = (n: number) => `${count(n)} ${n === 1 ? 'property' : 'properties'}`

/** Strength of a place's color, 0.18 (a little) to 1 (the most anywhere). */
const strength = (v: number, max: number) => (v > 0 && max > 0 ? 0.18 + 0.82 * Math.sqrt(v / max) : 0)

/**
 * 10/12 (Nic) review: the one solid color for a strength — gold mixed into the
 * card's background. Used by the map and the color key alike, so they match.
 */
const heat = (o: number) =>
  o > 0 ? `color-mix(in srgb, var(--heat-hi) ${Math.round(o * 1000) / 10}%, var(--heat-base))` : 'var(--heat-none)'

/** How many places the side list shows before "Show all". */
const TOP = 8

/** The colored areas. Memoized: hovering re-draws only the outline on top, not ~3,100 counties. */
const AreaLayer = React.memo(function AreaLayer({ shapes, shade }: { shapes: Shape[]; shade: Map<string, number> }) {
  return (
    <g>
      {shapes.map(s => {
        return <path key={s.fips} d={s.d} data-fips={s.fips} style={{ fill: heat(shade.get(s.fips) ?? 0) }}/>
      })}
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

export function MetricsHeatMap({ data }: { data: PlatformMapData | null | undefined }) {
  const [level, setLevel] = useState<Level>('state')
  const [measure, setMeasure] = useState<Measure>('units')
  const [spaces, setSpaces] = useState<Spaces>('occupied')
  const field: Field = measure === 'money' ? 'money' : spaces === 'occupied' ? 'occupied' : 'units'
  const [shapes, setShapes] = useState<Shapes | null>(null)
  const [failed, setFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [hover, setHover] = useState<{ fips: string; x: number; y: number } | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  // 10/12 (Nic) review: the side list is the keyboard and screen-reader way to
  // every place's number, so it can show all of them, not only the top eight.
  const [showAll, setShowAll] = useState(false)
  const boxRef = useRef<HTMLDivElement>(null)
  const listId = useId()

  useEffect(() => {
    let live = true
    setFailed(false)
    loadShapes().then(s => { if (live) setShapes(s) }).catch(() => { if (live) setFailed(true) })
    return () => { live = false }
  }, [attempt])

  // A pick belongs to one level; switching levels starts clean.
  useEffect(() => { setSelected(null); setHover(null) }, [level])

  const areas: MapArea[] = useMemo(
    () => (level === 'state' ? data?.states : data?.counties) ?? [],
    [data, level])
  const byFips = useMemo(() => new Map(areas.map(a => [a.fips, a])), [areas])
  const max = useMemo(() => Math.max(0, ...areas.map(a => valueOf(a, field))), [areas, field])
  const shade = useMemo(() => {
    const m = new Map<string, number>()
    for (const a of areas) { const o = strength(valueOf(a, field), max); if (o > 0) m.set(a.fips, o) }
    return m
  }, [areas, field, max])
  const drawn = shapes ? (level === 'state' ? shapes.states : shapes.counties) : []
  const drawnFips = useMemo(() => new Set(drawn.map(s => s.fips)), [drawn])

  const placeName = (fips: string): string => {
    const a = byFips.get(fips)
    const shape = drawn.find(s => s.fips === fips)
    const name = a?.name || shape?.name || fips
    if (level === 'state') return name
    // A territory has no shape in the drawn picture; the server's own state list names it.
    const st = fips.slice(0, 2)
    const state = shapes?.stateName.get(st) ?? data?.states.find(s => s.fips === st)?.name
    return state ? `${name}, ${state}` : name
  }

  // Places with a number that the drawn picture has no shape for (the territories).
  const undrawn = shapes ? areas.filter(a => valueOf(a, field) !== 0 && !drawnFips.has(a.fips)) : []
  const missing = (data?.missing ?? [])
    .filter(x => (level === 'county' || x.offStateMap) && valueOf(x, field) !== 0)
  const rankedAll = useMemo(
    () => areas.filter(a => valueOf(a, field) > 0).sort((a, b) => valueOf(b, field) - valueOf(a, field)),
    [areas, field])
  const ranked = showAll ? rankedAll : rankedAll.slice(0, TOP)
  const nothing = areas.every(a => !(valueOf(a, field) > 0))
  // 10/12 (Nic) review: no `map` at all (an API that does not send it yet) is
  // not an empty map — it must not say "no units" beside tiles with real totals.
  const unavailable = data == null
  const emptyText = unavailable
    ? 'Map numbers are not available yet.'
    // There are numbers, but none could be placed on this map (named below).
    : missing.some(x => valueOf(x, field) > 0)
      ? `No ${field === 'money' ? 'rent' : field === 'occupied' ? 'occupied units' : 'units'} could be placed on the ${level === 'state' ? 'state' : 'county'} map — see below.`
      : field === 'money' ? 'No rent has been logged yet.'
        : field === 'occupied' ? 'No units are occupied this month.' : 'No units under management yet.'

  // 10/12 (Nic) review: the color key, painted from the same strengths as the
  // map — the faint end is the smallest place's own color, the full end the
  // biggest's, and the steps between are even steps in value.
  const lowest = rankedAll.length ? valueOf(rankedAll[rankedAll.length - 1], field) : 0
  const keySteps = lowest > 0 && lowest < max ? [0, 1, 2, 3, 4].map(i => lowest + ((max - lowest) * i) / 4) : [max]

  const focus = hover?.fips ?? selected
  const focusShape = focus ? drawn.find(s => s.fips === focus) : undefined

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

  const measureWord = field === 'money' ? 'rent logged through GAM (all time)'
    : field === 'occupied' ? 'units occupied this month, counted the way GAM bills them' : 'units under management'
  const levelWord = level === 'state' ? 'state' : 'county'
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

  return (
    <div className="card mhm" style={{ marginBottom: 16 }}>
      <div className="mhm-head">
        <div className="ct" style={{ marginBottom: 0 }}>Heat map</div>
        <div className="mhm-controls">
          <Toggle label="Map level" value={level} onChange={setLevel}
            options={[{ value: 'state', label: 'State' }, { value: 'county', label: 'County' }]}/>
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
      </div>

      <div className="mhm-body">
        <div>
          <div className="mhm-map" ref={boxRef} onPointerLeave={() => setHover(null)}>
            {failed ? (
              <div className="mhm-msg">
                <div>The map could not be drawn just now.</div>
                <button type="button" className="btn btn-primary btn-sm" onClick={() => setAttempt(n => n + 1)}>Try again</button>
              </div>
            ) : !shapes ? (
              <div className="mhm-msg"><span className="spinner"/> Drawing the map…</div>
            ) : (
              <>
                {/* A picture to a screen reader; every number in it is in the list beside it. */}
                <svg viewBox={`0 0 ${W} ${H}`} role="img" onPointerMove={onMove} onClick={onTap}
                  aria-label={`Map of the United States by ${levelWord}, colored by ${measureWord}`}
                  aria-describedby={listId}>
                  <AreaLayer shapes={drawn} shade={shade}/>
                  {level === 'county' && <path d={shapes.countyBorders} className="mhm-county-line" vectorEffect="non-scaling-stroke"/>}
                  <path d={shapes.stateBorders} className="mhm-state-line" vectorEffect="non-scaling-stroke"/>
                  <path d={shapes.nation} className="mhm-nation-line" vectorEffect="non-scaling-stroke"/>
                  {focusShape && <path d={focusShape.d} className="mhm-focus" vectorEffect="non-scaling-stroke"/>}
                </svg>
                {nothing && (
                  <div className="mhm-empty">
                    <span>{emptyText}</span>
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
              : <span style={{ color: 'var(--t3)' }}>Hover or tap a {levelWord} to see its number, or pick one from the list.</span>}
          </div>

          {shapes && !nothing && (
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
            {showAll || rankedAll.length <= TOP
              ? (level === 'state' ? 'States' : 'Counties')
              : (level === 'state' ? 'Top states' : 'Top counties')}
          </div>
          {ranked.length === 0
            ? <div style={{ color: 'var(--t3)', fontSize: '.78rem' }}>{emptyText}</div>
            : ranked.map(a => (
              <button key={a.fips} type="button" aria-pressed={selected === a.fips}
                className={`mhm-row${selected === a.fips ? ' on' : ''}`}
                onClick={() => setSelected(cur => (cur === a.fips ? null : a.fips))}>
                <span className="mhm-row-name">{placeName(a.fips)}</span>
                <span className="mhm-row-value mono">{valueText(field, valueOf(a, field))}</span>
              </button>
            ))}
          {rankedAll.length > TOP && (
            <button type="button" className="btn btn-primary btn-sm mhm-more" aria-expanded={showAll}
              onClick={() => setShowAll(v => !v)}>
              {showAll ? `Show the top ${TOP}` : `Show all ${count(rankedAll.length)} ${level === 'state' ? 'states' : 'counties'}`}
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
              {placeName(a.fips)} · {valueText(field, valueOf(a, field))} — outside the drawn map (U.S. territories are not drawn)
            </div>
          ))}
        </div>
      )}

      <style>{`
        .mhm { --heat-hi: var(--gold); --heat-base: var(--bg2); --heat-none: var(--bg3); }
        :root[data-theme="light"] .mhm { --heat-hi: var(--gold-ink, #7a5f0f); }
        .mhm-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; }
        .mhm-controls { display: flex; gap: 8px; flex-wrap: wrap; }
        .mhm-seg { display: inline-flex; border: 1px solid var(--b1); border-radius: 7px; overflow: hidden; }
        .mhm-seg button { background: transparent; border: none; color: var(--t3); font-size: .72rem; font-weight: 600; padding: 5px 12px; cursor: pointer; }
        .mhm-seg button + button { border-left: 1px solid var(--b1); }
        .mhm-seg button.on { background: var(--bg4); color: var(--t0); }
        .mhm-seg button:focus-visible { outline: 2px solid var(--gold); outline-offset: -2px; }
        .mhm-body { display: grid; grid-template-columns: minmax(0, 3fr) minmax(200px, 1fr); gap: 16px; align-items: start; }
        @media (max-width: 900px) { .mhm-body { grid-template-columns: minmax(0, 1fr); } }
        .mhm-map { position: relative; width: 100%; aspect-ratio: ${W} / ${H}; }
        .mhm-map svg { display: block; width: 100%; height: 100%; cursor: pointer; touch-action: manipulation; }
        .mhm-county-line { fill: none; stroke: var(--bg2); stroke-width: .35px; stroke-opacity: .7; pointer-events: none; }
        .mhm-state-line { fill: none; stroke: var(--bg2); stroke-width: 1px; pointer-events: none; }
        .mhm-nation-line { fill: none; stroke: var(--b2); stroke-width: 1px; pointer-events: none; }
        .mhm-focus { fill: none; stroke: var(--t0); stroke-width: 1.6px; pointer-events: none; }
        .mhm-msg, .mhm-empty { position: absolute; inset: 0; display: flex; flex-direction: column; gap: 10px; align-items: center; justify-content: center; text-align: center; color: var(--t3); font-size: .8rem; padding: 12px; }
        .mhm-msg { flex-direction: row; flex-wrap: wrap; background: var(--bg3); border-radius: 8px; }
        .mhm-empty { pointer-events: none; color: var(--t1); }
        .mhm-empty span { background: var(--bg2); border: 1px solid var(--b1); border-radius: 6px; padding: 4px 10px; }
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
