/**
 * 10/13 (Nic): the Metrics heat map as a 3D globe. "Click and drag to rotate
 * the earth ... zooming in and out ... Still like the line art that it is. I
 * like that grayscale kind of stuff." The same places, numbers and gold as the
 * flat map, on an orthographic globe drawn in gray lines; a toggle on the card
 * goes back to the flat map.
 *
 * Drawn on a canvas (thousands of counties redrawn every frame of a drag would
 * stall an SVG): drag or swipe to turn it, scroll or pinch to zoom, and the
 * keyboard (arrows turn it, + and − zoom, 0 goes home) does the same. While it
 * moves it draws the land, every place GAM is in, the faint grid, the edge of
 * the globe, and the outline of whatever place is picked. What it leaves off is
 * every BOUNDARY, and those come and go together (10/19) — the United States'
 * own lines with everyone else's — all of them back a moment after it stops. A
 * tap picks a place; the far side of the earth is never picked. Every number on
 * it is also in the list beside the map.
 *
 * 10/18 (Nic): where it is facing is the CARD's, not its own — one kept view
 * for the globe and the flat map, so "I'd like it to stay" holds through every
 * setting change and through the toggle between the two pictures. It is given
 * that view (`view`) and hands back where a turn or a zoom ended (`onView`);
 * the zoom and Reset buttons live on the card beside both pictures.
 *
 * 10/17: the land around the United States is drawn under it (the countries
 * from the API's own world file — see metricsMapGeo loadWorld), so the earth
 * turns over land and not blank ocean. It arrives a moment after the globe
 * does; until then, and if it cannot be fetched, the globe draws without it.
 *
 * 10/17 (Nic): at a world level — countries, states and provinces, counties
 * and districts — the areas can be whole countries, so the United States' own
 * state lines are left off (`stateLines`): they would only cut a gold country
 * into pieces that mean nothing at that level.
 *
 * 10/18 (Nic): THE DIVISIONS. "The globe draws only the United States with a
 * light gray-blue halo and black lines between states; nothing else on Earth
 * has any division at all." So it now draws the same country borders and the
 * same provinces the flat map draws (`countries`, `provinces` — the API's own
 * files, fetched by the card the first time the globe is shown), and DECIDED
 * (Nic asked, and he was told): every state and province boundary is drawn in
 * the same light gray-blue, so Alaska and Hawaii stop looking like a different
 * kind of thing from Arizona. Black lines read as cracks on a dark globe, so
 * no boundary on it is black any more — a country's edge is the same color, a
 * shade heavier, which is the only hierarchy the globe needs.
 *
 * 10/18 (Nic): and the lean overlay (`lean`) — an area's color is how it VOTED
 * there, on a diverging red/blue scale, with GAM's own number as the gold
 * marker on top of it. Gold on this globe always means GAM.
 */
import React, { useCallback, useEffect, useRef } from 'react'
import { geoGraticule10, geoPath } from 'd3-geo'
import type { MultiLineString } from 'geojson'
import {
  DOT_BELOW_PX, DOT_RADIUS, areaAt, dragRotate, globeProjection, leanColor, mixRgb, zoomBy,
  type GeoArea, type GlobeView, type LayerShapes, type UsAtlas, type WorldLand,
} from './metricsMapGeo'

interface Props {
  us: UsAtlas
  /** 10/17: the land around the United States; null until it arrives, or if it cannot be fetched. */
  world?: WorldLand | null
  /** The level's areas, colored by `shade`. */
  areas: GeoArea[]
  /** The lines between the level's areas (counties, districts, cities, ZIP codes); null at the state level. */
  borders: MultiLineString | null
  /**
   * 10/17 (Nic): draw the United States' own state lines over the colors.
   * False at a world level, where a whole country can be one gold shape and
   * the state lines would only cut it up.
   */
  stateLines?: boolean
  /**
   * 10/18 (Nic): the country shapes and the provinces, for the lines between
   * them — the same files the flat map draws. Null until they arrive, or if
   * they cannot be fetched, in which case the globe draws the coarse country
   * lines it has from the world file and nothing else changes.
   */
  countries?: LayerShapes | null
  provinces?: LayerShapes | null
  /** Strength 0–1 of each area's gold, by id (only areas with a number). */
  shade: Map<string, number>
  /**
   * 10/18 (Nic): the lean overlay — each area's voting margin by id, positive
   * for the contest's right. When it is given, an area's COLOR is its vote and
   * every area with a gold number is marked whatever its size; an area with no
   * result published is left uncolored rather than painted as if it were even.
   */
  lean?: Map<string, number> | null
  focus: string | null
  /**
   * 10/18 (Nic): where to face and how far in — the card's own kept view, so
   * the globe comes back where it was left ("I'd like it to stay"). A new
   * object turns the globe there.
   */
  view: GlobeView
  /**
   * 10/18 (Nic): and back the other way, once a turn or a zoom has settled, so
   * the card keeps it and the flat map picks it up. Not every frame: the card
   * would re-draw its whole picture under a drag.
   */
  onView: (view: GlobeView) => void
  /** Reset: the card decides where home is, and the keyboard's 0 asks for it. */
  onHome: () => void
  onHover: (id: string | null, x: number, y: number) => void
  onPick: (id: string | null) => void
  label: string
  describedBy: string
}

const graticule = geoGraticule10()
const sphere = { type: 'Sphere' } as const

/** A CSS color (any form the theme writes) → [r, g, b], read back from a 1×1 canvas. */
function makeColorReader() {
  const cache = new Map<string, [number, number, number]>()
  let probe: CanvasRenderingContext2D | null = null
  return (css: string): [number, number, number] => {
    const key = css.trim()
    const hit = cache.get(key)
    if (hit) return hit
    if (!probe) probe = document.createElement('canvas').getContext('2d', { willReadFrequently: true })
    let rgb: [number, number, number] = [128, 128, 128]
    if (probe) {
      probe.clearRect(0, 0, 1, 1)
      probe.fillStyle = '#808080'
      probe.fillStyle = key
      probe.fillRect(0, 0, 1, 1)
      const d = probe.getImageData(0, 0, 1, 1).data
      rgb = [d[0], d[1], d[2]]
    }
    cache.set(key, rgb)
    return rgb
  }
}

export function MetricsGlobe({
  us, world, countries, provinces, areas, borders, shade, lean, focus, stateLines = true,
  view: target, onView, onHome,
  onHover, onPick, label, describedBy,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const view = useRef<GlobeView>(target)
  const size = useRef({ w: 0, h: 0 })
  const moving = useRef(false)
  const settle = useRef<number | null>(null)
  const frame = useRef<number | null>(null)
  const colorOf = useRef(makeColorReader()).current
  /** The markers drawn last frame (places too small to see), for hover and tap. */
  const dots = useRef<Array<{ id: string; x: number; y: number }>>([])
  // The latest props, for the drawing loop and the pointer handlers.
  const props = useRef({ areas, borders, shade, lean, focus, stateLines, onHover, onPick, onView })
  props.current = { areas, borders, shade, lean, focus, stateLines, onHover, onPick, onView }

  const paint = useCallback(() => {
    frame.current = null
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx) return
    const { w, h } = size.current
    if (!w || !h) return
    const dpr = window.devicePixelRatio || 1
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr)
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, w, h)

    const css = getComputedStyle(canvas)
    const v = (name: string) => css.getPropertyValue(name)
    const rgb = (name: string) => `rgb(${colorOf(v(name)).join(', ')})`
    const hi = colorOf(v('--heat-hi')), base = colorOf(v('--heat-base'))
    const projection = globeProjection(view.current, w, h)
    const path = geoPath(projection, ctx)
    const fast = moving.current
    const p = props.current
    const stroke = (geo: any, color: string, width: number, alpha = 1) => {
      ctx.beginPath(); path(geo)
      ctx.globalAlpha = alpha; ctx.strokeStyle = color; ctx.lineWidth = width; ctx.stroke(); ctx.globalAlpha = 1
    }
    const fill = (geo: any, color: string) => { ctx.beginPath(); path(geo); ctx.fillStyle = color; ctx.fill() }

    // The sea is the card; the earth is gray line art, the land gray with gold
    // where GAM is. 10/18 (Nic): every boundary on it — a state's, a
    // province's, a country's — is the one light gray-blue, a country's a
    // shade heavier. Nothing on the globe is drawn in black.
    const line = rgb('--b2')
    stroke(graticule, rgb('--b1'), 0.5, 0.8)
    // 10/17: the rest of the world's land first, so the United States sits on
    // top of it. Its coastlines come back when the globe stops moving, as the
    // other fine lines do; while it turns, the fill alone shows the land.
    if (world) fill(world.land, rgb('--heat-none'))
    fill(us.land, rgb('--heat-none'))
    for (const a of p.areas) {
      // 10/18 (Nic): the lean overlay colors an area by its vote; everywhere
      // else the color is GAM's own number, in gold.
      if (p.lean) {
        const margin = p.lean.get(a.id)
        if (margin != null) fill(a.feature, leanColor(margin))
        continue
      }
      const o = p.shade.get(a.id)
      if (o) fill(a.feature, mixRgb(hi, base, o))
    }
    /**
     * 10/19 (Nic): "how come all of the other countries lines go away when I'm
     * clicking and holding to drag? But the United States ones all stay there.
     * When I stop dragging, everything else lights up for boundaries."
     *
     * So every boundary is on the one gate now: while the globe is moving the
     * whole line art is skipped, and all of it comes back together when it
     * stops. The United States' own lines used to sit outside this gate — the
     * state lines and the country's outline stayed up through a drag while
     * every other country's vanished, which is the half-drawn earth he saw.
     *
     * Which way to make them agree was MEASURED, not guessed (10/19, one frame
     * at the county level, 975×610, the 3,000-county fill): the fills, the grid
     * and the rim cost 27ms on their own; the boundaries on top of them cost
     * another 130ms — the provinces 78ms, the lines between countries 46ms, the
     * county lines 5ms — against 2ms for the two United States layers. Drawing
     * them all through a drag would be six frames a second, so the consistent
     * answer is the fast one: during a drag NO boundary is drawn. The land is
     * still there (it is filled, not outlined), so is every place GAM is in,
     * and the lines are back a moment after the globe stops.
     *
     * What a drag still shows of the United States is its COASTLINE: the world
     * file holds every country except the United States (metricsMapGeo
     * loadWorld), so the land it fills stops where the country starts and the
     * sea is the card behind it. The United States' lines that do go are its
     * land edges with Canada and Mexico — and they go with every other
     * country's land edges, which is the whole of what he asked for. Putting
     * either one back on its own is the half-drawn earth again.
     *
     * 10/18 (Nic): the world's own divisions, over the colors — the country
     * lines from the same file the flat map draws (until it arrives, the coarse
     * world file's own lines between countries: that file's mesh is the shared
     * edges only, so no coastline is in it either way — a coast is where the
     * land fill stops), and the provinces inside them.
     */
    if (!fast) {
      if (p.borders) stroke(p.borders, line, 0.5, 0.7)
      // A province is the same kind of thing as a state, so it is drawn
      // exactly like one — same color, same weight. That is the whole point of
      // Nic's decision: "Alaska and Hawaii stop looking like a different kind
      // of thing from Arizona."
      if (provinces) stroke(provinces.borders, line, 0.7)
      if (countries) stroke(countries.borders, line, 1)
      else if (world) stroke(world.borders, line, 1)
      if (p.stateLines) stroke(us.stateBorders, line, 0.7)
      stroke(us.nation, line, 1)
    }
    // The earth's rim is not a boundary — it is the edge of the globe, one
    // circle, and a turning globe with no rim has no shape at all.
    stroke(sphere, line, 1)
    // Nor is the outline of the place that is picked: it is the marker saying
    // which one it is, so it stays up through a drag like the gold does.
    const f = p.focus ? p.areas.find(a => a.id === p.focus) : null
    if (f) stroke(f.feature, rgb('--t0'), 1.6)

    // A place with a number too small to see at this zoom gets a marker in its
    // own color (as on the flat map). 10/18 (Nic): in the lean overlay EVERY
    // area GAM is in is marked, whatever its size — the area's own color is
    // its vote there, so the marker is the only thing saying GAM is in it.
    dots.current = []
    for (const a of p.areas) {
      const o = p.shade.get(a.id)
      if (!o) continue
      const [[x0, y0], [x1, y1]] = path.bounds(a.feature)
      const [cx, cy] = path.centroid(a.feature)
      if (!Number.isFinite(cx) || !Number.isFinite(cy)) continue
      if (!p.lean && !(x1 - x0 < DOT_BELOW_PX && y1 - y0 < DOT_BELOW_PX)) continue
      ctx.beginPath(); ctx.arc(cx, cy, DOT_RADIUS, 0, 2 * Math.PI)
      ctx.fillStyle = mixRgb(hi, base, o); ctx.fill()
      ctx.lineWidth = a.id === p.focus ? 2 : 1; ctx.strokeStyle = rgb(a.id === p.focus ? '--t0' : '--t1'); ctx.stroke()
      dots.current.push({ id: a.id, x: cx, y: cy })
    }
  }, [us, world, countries, provinces, colorOf])

  /** The place under a point: a marker first (they sit on top), then the shapes. */
  const hitAt = (x: number, y: number): string | null => {
    const dot = dots.current.find(d => Math.hypot(d.x - x, d.y - y) <= DOT_RADIUS + 3)
    if (dot) return dot.id
    return areaAt(props.current.areas, globeProjection(view.current, size.current.w, size.current.h), x, y)?.id ?? null
  }

  /**
   * 10/19 (Nic): "there's an issue with the globe view of the map. It's not
   * displaying right. It's offset from the view when I am hovering over
   * Nevada. It's saying Florida. … When I try to drag it, nothing changes on
   * the screen, but now Florida is off the coast of California."
   *
   * The drawing was frozen while the hit-test kept following the drag, so the
   * picture on screen and the place under the pointer were two different
   * rotations of the earth. Cause: this used to bail out whenever a frame was
   * already pending (`if (frame.current == null)`), and the effect below
   * CANCELLED a pending frame without clearing the ref. That effect re-runs
   * every time `paint` changes identity — which is every time one of the
   * globe's boundary layers finishes downloading on first open. So the first
   * layer to land mid-frame cancelled the pending draw, left a dead frame id
   * in the ref, and from then on every redraw was a silent no-op: the canvas
   * never painted again, while `view.current` kept turning under it.
   *
   * Cancel and reschedule instead of bailing. A pending frame can no longer
   * wedge the canvas, and the newest `paint` always wins — which also fixes a
   * quieter version of the same thing, where a frame scheduled before a layer
   * arrived drew with the closure that did not have it yet.
   */
  const redraw = useCallback(() => {
    if (frame.current != null) cancelAnimationFrame(frame.current)
    frame.current = requestAnimationFrame(paint)
  }, [paint])

  /** The newest `redraw`, for a timer armed earlier in a gesture to call. */
  const latestRedraw = useRef(redraw)
  latestRedraw.current = redraw

  /**
   * While it moves: the light drawing now, the full one a moment after it
   * stops. 10/18 (Nic): and when it stops, the card is told where it ended up,
   * so changing a setting (or going back to the flat map) keeps it.
   */
  const moved = useCallback(() => {
    moving.current = true
    if (settle.current != null) window.clearTimeout(settle.current)
    settle.current = window.setTimeout(() => {
      // The NEWEST draw, not the one this gesture started with: a boundary
      // file can land between the last move and this timer, and the frame that
      // puts the lines back has to be the one that knows about it.
      moving.current = false; settle.current = null; latestRedraw.current()
      props.current.onView(view.current)
    }, 160)
    redraw()
  }, [redraw])

  /** The same, at once, when a gesture ends — a toggle clicked a moment later must not lose it. */
  const report = useCallback(() => { props.current.onView(view.current) }, [])

  /**
   * 10/19: the end of a gesture is the GESTURE's to clean up, so the settle
   * timer is cleared on the way out and nowhere else. It used to be cleared by
   * the effect below as well — which re-runs every time `paint` changes
   * identity, so a boundary file landing in the 160ms after the last move of a
   * drag cancelled the END of that drag. The globe stayed in its moving state,
   * which now means with none of its lines on it, until the next touch.
   */
  useEffect(() => () => {
    if (settle.current != null) { window.clearTimeout(settle.current); settle.current = null }
  }, [])

  // A new view from the card (its own Reset, a place picked from the list, a
  // level whose picture opens somewhere else) turns the globe there.
  useEffect(() => { view.current = target; redraw() }, [target, redraw])
  // New numbers or a new focus: draw again.
  useEffect(() => { redraw() }, [areas, borders, shade, lean, focus, stateLines, redraw])

  // Fit the canvas to its box, and keep it fitted.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const fit = () => {
      const r = canvas.getBoundingClientRect()
      size.current = { w: r.width, h: r.height }
      redraw()
    }
    fit()
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(fit) : null
    ro?.observe(canvas)
    if (!ro) window.addEventListener('resize', fit)
    // The theme can change under it (light / dark): read the colors again.
    const mo = typeof MutationObserver !== 'undefined' ? new MutationObserver(redraw) : null
    mo?.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class'] })
    return () => {
      ro?.disconnect(); mo?.disconnect()
      if (!ro) window.removeEventListener('resize', fit)
      // Clearing the ref is the load-bearing half: a cancelled frame id left
      // behind used to block every later redraw (see `redraw` above).
      if (frame.current != null) { cancelAnimationFrame(frame.current); frame.current = null }
    }
  }, [redraw])

  // Scroll to zoom. A wheel listener that can stop the page scrolling must not be passive.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      view.current = zoomBy(view.current, Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0018)))
      moved()
    }
    canvas.addEventListener('wheel', onWheel, { passive: false })
    return () => canvas.removeEventListener('wheel', onWheel)
  }, [moved])

  // Drag to turn it, two fingers to zoom, a tap to pick.
  const pointers = useRef(new Map<number, { x: number; y: number }>())
  const gesture = useRef<{ startX: number; startY: number; travel: number; pinch: number | null }>({ startX: 0, startY: 0, travel: 0, pinch: null })
  const local = (e: React.PointerEvent) => {
    const r = canvasRef.current!.getBoundingClientRect()
    return { x: e.clientX - r.left, y: e.clientY - r.top }
  }
  const spread = () => {
    const [a, b] = [...pointers.current.values()]
    return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : null
  }
  const onPointerDown = (e: React.PointerEvent) => {
    const at = local(e)
    pointers.current.set(e.pointerId, at)
    canvasRef.current?.setPointerCapture?.(e.pointerId)
    if (pointers.current.size === 1) gesture.current = { startX: at.x, startY: at.y, travel: 0, pinch: null }
    else gesture.current.pinch = spread()
  }
  const onPointerMove = (e: React.PointerEvent) => {
    const at = local(e)
    const prev = pointers.current.get(e.pointerId)
    if (!prev) {
      // Hover is for a mouse only; a tap's own pick is the answer on a phone.
      if (e.pointerType !== 'mouse') return
      props.current.onHover(hitAt(at.x, at.y), at.x, at.y)
      return
    }
    pointers.current.set(e.pointerId, at)
    if (pointers.current.size >= 2) {
      const now = spread()
      if (now && gesture.current.pinch) view.current = zoomBy(view.current, now / gesture.current.pinch)
      gesture.current.pinch = now
      gesture.current.travel += 10
    } else {
      gesture.current.travel += Math.abs(at.x - prev.x) + Math.abs(at.y - prev.y)
      /**
       * 10/19: a wobble under a click is not a drag. Under the same 6px that
       * tells a tap from a turn below, the earth does not move and nothing is
       * redrawn — so a click with a shaky hand no longer takes every line off
       * the globe for a sixth of a second and puts them back (which is the
       * flicker the one gate above would otherwise have handed him on a plain
       * click). A gesture that stays under it is a tap, and a tap picks a
       * place; it would be two answers at once for it to also turn the earth.
       */
      if (gesture.current.travel < 6) return
      view.current = dragRotate(view.current, at.x - prev.x, at.y - prev.y, size.current.w, size.current.h)
      props.current.onHover(null, 0, 0)
    }
    moved()
  }
  const onPointerUp = (e: React.PointerEvent) => {
    const was = pointers.current.size
    pointers.current.delete(e.pointerId)
    if (was === 1 && gesture.current.travel < 6) {
      const at = local(e)
      props.current.onPick(hitAt(at.x, at.y))
    } else if (gesture.current.travel >= 6) report()
    if (pointers.current.size < 2) gesture.current.pinch = null
  }

  const turn = (dx: number, dy: number) => {
    view.current = dragRotate(view.current, dx, dy, size.current.w || 975, size.current.h || 610)
    moved()
  }
  const zoom = (factor: number) => { view.current = zoomBy(view.current, factor); moved() }
  const onKeyDown = (e: React.KeyboardEvent) => {
    const step = 40
    const keys: Record<string, () => void> = {
      ArrowLeft: () => turn(step, 0), ArrowRight: () => turn(-step, 0),
      ArrowUp: () => turn(0, step), ArrowDown: () => turn(0, -step),
      '+': () => zoom(1.4), '=': () => zoom(1.4), '-': () => zoom(1 / 1.4), _: () => zoom(1 / 1.4),
      // 10/18 (Nic): home is the card's to decide now — the same thing the
      // Reset button beside the globe does, for both pictures.
      '0': () => onHome(),
    }
    const act = keys[e.key]
    if (act) { e.preventDefault(); act() }
  }

  // 10/18 (Nic): the zoom and Reset buttons are the card's now (.mhm-tools) —
  // the flat map zooms too, and both read the one kept view.
  return (
    <canvas ref={canvasRef} className="mhm-globe" role="img" tabIndex={0}
      aria-label={`${label}. Drag or use the arrow keys to turn the globe; scroll, pinch, or plus and minus to zoom.`}
      aria-describedby={describedBy}
      onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp}
      onPointerCancel={e => { pointers.current.delete(e.pointerId); gesture.current.pinch = null }}
      onPointerLeave={e => { if (e.pointerType === 'mouse' && !pointers.current.size) props.current.onHover(null, 0, 0) }}
      onKeyDown={onKeyDown}/>
  )
}
