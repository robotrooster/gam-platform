/**
 * 10/19 (Nic) — the two things he found in the globe on the Metrics card.
 *
 * THE FREEZE. "There's an issue with the globe view of the map. It's not
 * displaying right. It's offset from the view when I am hovering over Nevada.
 * It's saying Florida. … When I try to drag it, nothing changes on the screen,
 * but now Florida is off the coast of California." The picture had stopped
 * being redrawn while the globe kept turning underneath it, so what was on
 * screen and what was under the pointer were two different rotations of the
 * earth. It came of a frame being cancelled without the pending-frame marker
 * being cleared, which is what first open does every time one of the boundary
 * files lands while a frame is already waiting.
 *
 * THE HALF-DRAWN EARTH. "How come all of the other countries lines go away
 * when I'm clicking and holding to drag? But the United States ones all stay
 * there. When I stop dragging, everything else lights up for boundaries."
 *
 * HOW THESE TESTS LOOK AT THE GLOBE: jsdom has no canvas, so it is given a
 * stand-in that writes down every fill and every stroke WITH THE POINTS it was
 * handed, and which frame drew them. Those points are where the picture really
 * is, so they answer both questions directly: which boundaries a frame drew
 * (each layer here is a line along its own parallel, so a stroke's own points
 * say which layer it is), and whether the place the hit-test names under the
 * pointer is the place the canvas drew there. The animation frames are run by
 * hand too, so a frame can be left waiting on purpose — the state the freeze
 * needed.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { geoBounds } from 'd3-geo'
import type { Feature, MultiLineString } from 'geojson'
import { MetricsGlobe } from './MetricsGlobe'
import {
  US_VIEW, dragRotate, globeProjection,
  type GeoArea, type GlobeView, type LayerShapes, type UsAtlas,
} from './metricsMapGeo'

const W = 975
const H = 610

// ── The shapes ───────────────────────────────────────────────────────────────

/**
 * A square place, in longitude/latitude — big enough on screen to be a shape
 * and not one of the globe's markers. Wound CLOCKWISE: on a sphere a ring's
 * winding is what says which side of it is the inside, and d3 reads clockwise
 * as the inside. Wound the other way this square is the whole earth except the
 * square, which both draws and hit-tests as everywhere.
 */
const square = (id: string, lng: number, lat: number, side = 6): GeoArea => {
  const h = side / 2
  const feature: Feature = {
    type: 'Feature', id, properties: { name: id },
    geometry: { type: 'Polygon', coordinates: [[
      [lng - h, lat - h], [lng - h, lat + h], [lng + h, lat + h], [lng + h, lat - h], [lng - h, lat - h],
    ]] },
  }
  return { id, name: id, feature, bounds: geoBounds(feature) }
}

/**
 * Each boundary layer is a line along its OWN parallel, so a frame's strokes
 * say which layers it drew: turn a stroke's points back into longitude and
 * latitude and the latitude names the layer (`drawnBoundaries`). The grid and
 * the earth's rim span every latitude, so they never answer to a layer.
 */
const BAND = { counties: 13, provinces: 21, countries: 29, states: 37, nation: 45 }
const parallel = (lat: number): MultiLineString =>
  ({ type: 'MultiLineString', coordinates: [[[-106, lat], [-100, lat], [-94, lat]]] })

const layer = (lat: number): LayerShapes => ({
  level: 'country', groups: [], failed: [], areas: [], borders: parallel(lat), country: new Map(),
})

const NEVADA = square('nevada', -117, 39)
const FLORIDA = square('florida', -82, 28)

const us: UsAtlas = {
  topo: {} as UsAtlas['topo'],
  land: square('land', -98, 36, 40).feature,
  states: [], counties: [], stateById: new Map(), stateName: new Map(),
  stateBorders: parallel(BAND.states),
  countyBorders: parallel(99),     // the globe never draws this one
  nation: parallel(BAND.nation),
}

// ── The canvas stand-in ──────────────────────────────────────────────────────

interface Shot { frame: number; color: string; width: number; points: Array<[number, number]> }

function recordCanvas() {
  const fills: Shot[] = []
  const strokes: Shot[] = []
  let points: Array<[number, number]> = []
  let fillStyle = '#808080'
  /** How many frames have painted: the globe sets the canvas transform once a frame, and nothing else does. */
  let frame = 0
  const ctx: any = {
    strokeStyle: '', fillStyle: '#808080', lineWidth: 0, globalAlpha: 1,
    setTransform() { frame++ },
    clearRect() {},
    // The globe's own color reader asks a 1×1 canvas what a CSS color comes
    // out as; jsdom has no stylesheet here, so it reads back the gray it was
    // given first. These tests go by WHERE things were drawn, not their color.
    fillRect() {}, getImageData: () => ({ data: [128, 128, 128] }),
    beginPath() { points = [] },
    moveTo(x: number, y: number) { points.push([x, y]) },
    lineTo(x: number, y: number) { points.push([x, y]) },
    arc(x: number, y: number) { points.push([x, y]) },
    closePath() {},
    fill() { fills.push({ frame, color: String(fillStyle), width: 0, points: [...points] }) },
    stroke() { strokes.push({ frame, color: String(ctx.strokeStyle), width: Number(ctx.lineWidth), points: [...points] }) },
  }
  Object.defineProperty(ctx, 'fillStyle', { get: () => fillStyle, set: (v: string) => { fillStyle = v } })
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx)
  vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue({
    width: W, height: H, top: 0, left: 0, right: W, bottom: H, x: 0, y: 0, toJSON: () => ({}),
  })
  return {
    /** How many frames have painted at all. */
    get frames() { return frame },
    /**
     * What is on the canvas now: the last frame that actually painted. The
     * LAST one and not the only one on purpose — a globe that has stopped
     * painting still SHOWS the picture it drew last, which is what Nic was
     * looking at, so a frozen canvas reads here as the stale picture it is
     * rather than as having drawn nothing.
     */
    get fills() { return fills.filter(s => s.frame === frame) },
    get strokes() { return strokes.filter(s => s.frame === frame) },
  }
}

/** Which boundary layers a frame drew, read off the points it drew them with. */
const drawnBoundaries = (strokes: Shot[], view: GlobeView): Set<string> => {
  const projection = globeProjection(view, W, H)
  const drawn = new Set<string>()
  for (const s of strokes) {
    const lats = s.points.map(p => projection.invert?.(p)?.[1]).filter((l): l is number => Number.isFinite(l))
    if (!lats.length) continue
    for (const [name, lat] of Object.entries(BAND)) {
      if (lats.every(l => Math.abs(l - lat) < 1)) drawn.add(name)
    }
  }
  return drawn
}

/** Where the canvas drew a place: the middle of the points it filled it with. */
const drawnAt = (fill: Shot): [number, number] => {
  const n = fill.points.length
  return [fill.points.reduce((t, p) => t + p[0], 0) / n, fill.points.reduce((t, p) => t + p[1], 0) / n]
}
const apart = (a: [number, number], b: [number, number]) => Math.hypot(a[0] - b[0], a[1] - b[1])

// ── Frames, by hand ──────────────────────────────────────────────────────────

let waiting: Map<number, FrameRequestCallback>
let nextFrame: number

/** Run whatever frame is waiting. The globe paints inside one, never outside. */
const flush = async () => {
  const due = [...waiting.values()]
  waiting.clear()
  await act(async () => { for (const cb of due) cb(0) })
}

// ── Pointers ─────────────────────────────────────────────────────────────────

/** jsdom has no PointerEvent; a mouse event carrying the two fields React reads is enough. */
class TestPointerEvent extends MouseEvent {
  pointerId: number
  pointerType: string
  constructor(type: string, init: MouseEventInit & { pointerId?: number; pointerType?: string } = {}) {
    super(type, { bubbles: true, ...init })
    this.pointerId = init.pointerId ?? 1
    this.pointerType = init.pointerType ?? 'mouse'
  }
}

// React's act() runs only where the test says it is one.
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

interface Globe {
  view?: GlobeView
  areas?: GeoArea[]
  shade?: Map<string, number>
  borders?: MultiLineString | null
  countries?: LayerShapes | null
  provinces?: LayerShapes | null
  focus?: string | null
  stateLines?: boolean
}

let host: HTMLDivElement
let root: Root
let painted: ReturnType<typeof recordCanvas>
let hovered: string | null
let picked: string | null
let standing: Globe

beforeEach(() => {
  waiting = new Map()
  nextFrame = 1
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { waiting.set(nextFrame, cb); return nextFrame++ })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { waiting.delete(id) })
  painted = recordCanvas()
  hovered = null
  picked = null
  standing = {}
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount()); host.remove()
  vi.restoreAllMocks(); vi.unstubAllGlobals()
})

/** The globe, with everything it needs; what is passed in is kept for the next render. */
const show = async (props: Globe = {}) => {
  standing = { ...standing, ...props }
  const p = standing
  await act(async () => {
    root.render(
      <MetricsGlobe
        us={us} world={null}
        countries={p.countries ?? null} provinces={p.provinces ?? null}
        areas={p.areas ?? [NEVADA, FLORIDA]}
        borders={p.borders ?? null}
        shade={p.shade ?? new Map([['nevada', 0.8], ['florida', 0.4]])}
        lean={null}
        stateLines={p.stateLines ?? false}
        focus={p.focus ?? null}
        view={p.view ?? US_VIEW}
        onView={() => {}}
        onHome={() => {}}
        onHover={id => { hovered = id }}
        onPick={id => { picked = id }}
        label="Globe of the United States by state" describedBy="x"/>,
    )
  })
}

const canvas = () => host.querySelector('canvas.mhm-globe') as HTMLCanvasElement
const send = async (type: string, x: number, y: number, pointerId = 1) => {
  await act(async () => {
    canvas().dispatchEvent(new TestPointerEvent(type, { clientX: x, clientY: y, pointerId }))
  })
}
/** A drag, as a hand makes one: down, a few moves, up. */
const drag = async (dx: number, dy: number, steps = 4) => {
  await send('pointerdown', 480, 300)
  for (let i = 1; i <= steps; i++) await send('pointermove', 480 + (dx * i) / steps, 300 + (dy * i) / steps)
  await send('pointerup', 480 + dx, 300 + dy)
}
/** Longer than the globe's own 160ms settle, so it counts as having stopped. */
const stopped = async () => { await act(async () => { await new Promise(r => setTimeout(r, 220)) }) }

/** Where the picture on the canvas has the two places. Every frame fills the land, then Nevada, then Florida. */
const placesDrawn = () => {
  const [, nevada, florida] = painted.fills
  return { nevada: drawnAt(nevada), florida: drawnAt(florida) }
}

// ── 10/19 (Nic): THE FREEZE ──────────────────────────────────────────────────

describe('MetricsGlobe keeps drawing', () => {
  /**
   * The state the freeze needed, which is just what first open does: the globe
   * has painted once, a frame is waiting, and then a boundary file lands —
   * several of them, one after another. Each one cancels the frame that is
   * waiting; before the fix the marker saying "a frame is pending" was left
   * behind, and every redraw after that did nothing at all.
   */
  const layersLandMidFrame = async () => {
    await show()
    await flush()                                    // frame 1: the first picture
    await show({ focus: 'nevada' })                  // something to redraw for: a frame is now waiting
    expect(waiting.size).toBe(1)
    await show({ countries: layer(BAND.countries) }) // a file lands on the waiting frame
    await show({ provinces: layer(BAND.provinces) }) // and another
    await flush()                                    // frame 2: must happen, and must know about both
  }

  it('paints the newest picture when a layer lands on a waiting frame', async () => {
    // Cancel and reschedule, not bail out: a second frame paints, it is the
    // one that knows about both files, and only ever one frame is in flight.
    await layersLandMidFrame()
    expect(painted.frames).toBe(2)
    expect(drawnBoundaries(painted.strokes, US_VIEW)).toEqual(new Set(['countries', 'provinces', 'nation']))
    expect(waiting.size).toBe(0)
  })

  it('still paints after the files have landed — new numbers, a new view, a new pick', async () => {
    // The other half of the freeze: the cancelled frame left the pending
    // marker set, so the globe never drew again, whatever changed. Asserted
    // the way Nic sees it — each change puts a fresh picture on the canvas.
    await layersLandMidFrame()

    await show({ shade: new Map([['nevada', 0.3], ['florida', 0.9]]) })
    await flush()
    expect(painted.frames).toBe(3)

    const elsewhere: GlobeView = { rotate: [60, -20], zoom: 1.1 }
    await show({ view: elsewhere })
    await flush()
    expect(painted.frames).toBe(4)
    // And it drew with the view it was just given, not the one before it.
    expect(drawnBoundaries(painted.strokes, elsewhere)).toContain('nation')

    await show({ focus: 'florida' })
    await flush()
    expect(painted.frames).toBe(5)
  })

  it('the place under the pointer is the place the canvas drew there, after a drag', async () => {
    await layersLandMidFrame()
    const before = placesDrawn()

    await drag(190, 60)
    await flush()
    const after = placesDrawn()

    // Hover where the canvas drew each place, and the globe must name THAT
    // place. This is Nic's own symptom: the picture frozen at one rotation
    // while the pointer was read against another — "it's offset from the view
    // when I am hovering over Nevada. It's saying Florida."
    await send('pointermove', after.nevada[0], after.nevada[1])
    expect(hovered).toBe('nevada')
    await send('pointermove', after.florida[0], after.florida[1])
    expect(hovered).toBe('florida')

    // And the picture really did follow the drag. (A frozen canvas and a
    // frozen hit-test would agree with each other, so this is what makes the
    // check above worth anything.) Nothing is at the old place any more.
    expect(apart(before.nevada, after.nevada)).toBeGreaterThan(50)
    expect(apart(before.florida, after.florida)).toBeGreaterThan(50)
    await send('pointermove', before.nevada[0], before.nevada[1])
    expect(hovered).not.toBe('nevada')

    // A tap reads the same earth a hover does.
    await send('pointerdown', after.florida[0], after.florida[1], 2)
    await send('pointerup', after.florida[0], after.florida[1], 2)
    expect(picked).toBe('florida')
  })
})

// ── 10/19 (Nic): THE BOUNDARIES COME AND GO TOGETHER ─────────────────────────

describe('MetricsGlobe boundaries while it moves', () => {
  const ALL = new Set(['counties', 'provinces', 'countries', 'states', 'nation'])
  const everything = () => show({
    borders: parallel(BAND.counties),
    provinces: layer(BAND.provinces),
    countries: layer(BAND.countries),
    stateLines: true,
  })
  /**
   * Everything but the provinces — so a provinces file landing later is a
   * layer the globe has NEVER drawn, and the frame that restores the lines
   * either knows about it or does not. Handing it a layer it already had would
   * be a test that cannot fail: a stale frame and a fresh one would draw the
   * same line at the same parallel, and only the object's identity would
   * differ.
   */
  const ALL_BUT_PROVINCES = new Set(['counties', 'countries', 'states', 'nation'])
  const allButProvinces = () => show({
    borders: parallel(BAND.counties),
    countries: layer(BAND.countries),
    stateLines: true,
  })

  it('draws every boundary when it is still', async () => {
    await everything()
    await flush()
    expect(drawnBoundaries(painted.strokes, US_VIEW)).toEqual(ALL)
  })

  it('skips every boundary mid-drag — not half of them — and brings them all back', async () => {
    // 10/19 (Nic): "how come all of the other countries lines go away when I'm
    // clicking and holding to drag? But the United States ones all stay
    // there." The state lines and the country's outline sat outside the gate
    // the rest of the line art was behind. All or nothing now.
    await everything()
    await flush()
    const moved = dragRotate(US_VIEW, 190, 60, W, H)

    await drag(190, 60)
    await flush()
    expect(drawnBoundaries(painted.strokes, moved)).toEqual(new Set())

    // What a drag DOES draw: the land, every place GAM is in, and the earth's
    // rim — two strokes, the grid and the rim, neither of them a boundary.
    expect(painted.fills).toHaveLength(3)
    expect(painted.strokes).toHaveLength(2)

    // "When I stop dragging, everything else lights up for boundaries" — all
    // of it, on the rotation the drag left it at.
    await stopped()
    await flush()
    expect(drawnBoundaries(painted.strokes, moved)).toEqual(ALL)
  })

  it('a file landing at the end of a drag brings back the lines — the landed file included', async () => {
    // Found while making the gate one gate (10/19): the timer that ends a drag
    // was being cancelled whenever one of the boundary files landed, so a flick
    // followed by a file arriving left the globe in its moving state — which
    // now means with no lines on it at all — until the next touch.
    await allButProvinces()
    await flush()
    expect(drawnBoundaries(painted.strokes, US_VIEW)).toEqual(ALL_BUT_PROVINCES)
    const moved = dragRotate(US_VIEW, 190, 60, W, H)

    await drag(190, 60)
    await flush()
    expect(drawnBoundaries(painted.strokes, moved)).toEqual(new Set())

    // The provinces land in the moment after the last move, before the drag
    // has settled — a layer the globe has not drawn once yet.
    await show({ provinces: layer(BAND.provinces) })
    await flush()

    // The lines all come back when the drag settles, PROVINCES AMONG THEM:
    // the frame the settle paints is the newest one, not the one the drag
    // started with, so it knows about the file that landed under it. Read
    // against the card's kept view and not the rotation the drag reached,
    // because a file landing re-applies that kept view — a drag the card has
    // not been told about yet snaps back. Separate from the lines, and the
    // card's to answer for.
    await stopped()
    await flush()
    expect(drawnBoundaries(painted.strokes, US_VIEW)).toEqual(ALL)
  })

  it('skips them for a zoom too, not just a drag', async () => {
    await everything()
    await flush()
    await act(async () => {
      canvas().dispatchEvent(new WheelEvent('wheel', { deltaY: -120, bubbles: true, cancelable: true }))
    })
    await flush()
    expect(painted.strokes).toHaveLength(2)

    await stopped()
    await flush()
    expect(drawnBoundaries(painted.strokes, { rotate: US_VIEW.rotate, zoom: US_VIEW.zoom * Math.exp(120 * 0.0018) }))
      .toEqual(ALL)
  })

  it('a wobble under a click is not a drag — every line stays up', async () => {
    // The other side of one gate: `moved()` used to be called on ANY movement
    // at all, so a click with a shaky hand took every boundary off the globe
    // for the 160ms the settle runs and then put them back. Under the 6px that
    // tells a tap from a turn, nothing moves and nothing is redrawn.
    await everything()
    await flush()
    const was = painted.frames
    const where = placesDrawn().nevada

    await send('pointerdown', where[0], where[1])
    await send('pointermove', where[0] + 1, where[1] + 1)
    await send('pointermove', where[0] + 2, where[1] + 1)
    await flush()

    // No frame was asked for, and what is on the canvas is the still picture
    // it already had — every boundary on it.
    expect(painted.frames).toBe(was)
    expect(drawnBoundaries(painted.strokes, US_VIEW)).toEqual(ALL)

    // And it is still a pick, on the place the canvas drew there.
    await send('pointerup', where[0] + 2, where[1] + 1)
    expect(picked).toBe('nevada')
  })

  it('a picked place keeps its outline through a drag — a pick is a marker, not a boundary', async () => {
    await everything()
    await show({ focus: 'nevada' })
    await flush()
    await drag(190, 60)
    await flush()
    // The grid, the rim, and Nevada's own outline: three strokes, no boundary.
    expect(painted.strokes).toHaveLength(3)
    expect(painted.strokes.filter(s => s.width === 1.6)).toHaveLength(1)
    expect(drawnBoundaries(painted.strokes, dragRotate(US_VIEW, 190, 60, W, H))).toEqual(new Set())
  })
})
