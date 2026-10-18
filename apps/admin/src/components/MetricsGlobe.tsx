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
 * moves only the outlines that matter are drawn; the fine lines come back when
 * it stops. A tap picks a place; the far side of the earth is never picked.
 * Every number on it is also in the list beside the map.
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
 */
import React, { useCallback, useEffect, useRef } from 'react'
import { geoGraticule10, geoPath } from 'd3-geo'
import type { MultiLineString } from 'geojson'
import {
  DOT_BELOW_PX, DOT_RADIUS, areaAt, dragRotate, globeProjection, mixRgb, zoomBy,
  type GeoArea, type GlobeView, type UsAtlas, type WorldLand,
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
  /** Strength 0–1 of each area's gold, by id (only areas with a number). */
  shade: Map<string, number>
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
  us, world, areas, borders, shade, focus, stateLines = true, view: target, onView, onHome,
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
  const props = useRef({ areas, borders, shade, focus, stateLines, onHover, onPick, onView })
  props.current = { areas, borders, shade, focus, stateLines, onHover, onPick, onView }

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

    // The sea is the card; the earth is gray line art, the U.S. gray land with gold where GAM is.
    stroke(graticule, rgb('--b1'), 0.5, 0.8)
    // 10/17: the rest of the world's land first, so the United States sits on
    // top of it. Its coastlines come back when the globe stops moving, as the
    // other fine lines do; while it turns, the fill alone shows the land.
    if (world) {
      fill(world.land, rgb('--heat-none'))
      if (!fast) stroke(world.borders, rgb('--bg2'), 0.5, 0.7)
    }
    fill(us.land, rgb('--heat-none'))
    for (const a of p.areas) {
      const o = p.shade.get(a.id)
      if (o) fill(a.feature, mixRgb(hi, base, o))
    }
    if (p.borders && !fast) stroke(p.borders, rgb('--bg2'), 0.5, 0.7)
    if (p.stateLines) stroke(us.stateBorders, rgb('--bg2'), 1)
    stroke(us.nation, rgb('--b2'), 1)
    stroke(sphere, rgb('--b2'), 1)
    const f = p.focus ? p.areas.find(a => a.id === p.focus) : null
    if (f) stroke(f.feature, rgb('--t0'), 1.6)

    // A place with a number too small to see at this zoom gets a marker in its own color (as on the flat map).
    dots.current = []
    for (const a of p.areas) {
      const o = p.shade.get(a.id)
      if (!o) continue
      const [[x0, y0], [x1, y1]] = path.bounds(a.feature)
      const [cx, cy] = path.centroid(a.feature)
      if (!(x1 - x0 < DOT_BELOW_PX && y1 - y0 < DOT_BELOW_PX) || !Number.isFinite(cx) || !Number.isFinite(cy)) continue
      ctx.beginPath(); ctx.arc(cx, cy, DOT_RADIUS, 0, 2 * Math.PI)
      ctx.fillStyle = mixRgb(hi, base, o); ctx.fill()
      ctx.lineWidth = a.id === p.focus ? 2 : 1; ctx.strokeStyle = rgb(a.id === p.focus ? '--t0' : '--t1'); ctx.stroke()
      dots.current.push({ id: a.id, x: cx, y: cy })
    }
  }, [us, world, colorOf])

  /** The place under a point: a marker first (they sit on top), then the shapes. */
  const hitAt = (x: number, y: number): string | null => {
    const dot = dots.current.find(d => Math.hypot(d.x - x, d.y - y) <= DOT_RADIUS + 3)
    if (dot) return dot.id
    return areaAt(props.current.areas, globeProjection(view.current, size.current.w, size.current.h), x, y)?.id ?? null
  }

  const redraw = useCallback(() => {
    if (frame.current == null) frame.current = requestAnimationFrame(paint)
  }, [paint])

  /**
   * While it moves: the light drawing now, the full one a moment after it
   * stops. 10/18 (Nic): and when it stops, the card is told where it ended up,
   * so changing a setting (or going back to the flat map) keeps it.
   */
  const moved = useCallback(() => {
    moving.current = true
    if (settle.current != null) window.clearTimeout(settle.current)
    settle.current = window.setTimeout(() => {
      moving.current = false; settle.current = null; redraw()
      props.current.onView(view.current)
    }, 160)
    redraw()
  }, [redraw])

  /** The same, at once, when a gesture ends — a toggle clicked a moment later must not lose it. */
  const report = useCallback(() => { props.current.onView(view.current) }, [])

  // A new view from the card (its own Reset, a place picked from the list, a
  // level whose picture opens somewhere else) turns the globe there.
  useEffect(() => { view.current = target; redraw() }, [target, redraw])
  // New numbers or a new focus: draw again.
  useEffect(() => { redraw() }, [areas, borders, shade, focus, stateLines, redraw])

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
      if (frame.current != null) cancelAnimationFrame(frame.current)
      if (settle.current != null) window.clearTimeout(settle.current)
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
