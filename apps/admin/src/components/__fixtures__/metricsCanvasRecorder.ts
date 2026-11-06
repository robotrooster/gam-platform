/**
 * The stand-in canvas the Metrics globe's tests draw onto.
 *
 * jsdom has no canvas, so the globe is handed a context that writes down
 * everything it painted: every fill and every stroke, with the color, the
 * width, how many line commands went into it, and the POINTS it was handed —
 * and which frame drew them. Those points are where the picture really is, so
 * they answer the questions a globe raises directly: which boundaries a frame
 * drew, and whether the place the hit-test names under the pointer is the
 * place the canvas drew there.
 *
 * 10/31: pulled out of the two test files that each had their own copy. One of
 * them recorded colors and could not say WHERE anything was drawn; the other
 * recorded points and could not say what color they were. Neither alone can
 * check a picture the way the flat map's DOM could be checked, which is what
 * re-pointing a flat-map test at the globe needs, so there is one recorder now
 * and it keeps both.
 *
 * It lives under __fixtures__ because that is the one folder every app's
 * tsconfig excludes: it imports vitest, which is hoisted to the root only, and
 * the app's own build is `tsc && vite build`. Beside the tests it would put
 * vitest in the production typecheck.
 */
import { act } from 'react'
import { vi } from 'vitest'

/** The frame the globe draws into (metricsMapGeo W/H). */
export const W = 975
export const H = 610

/**
 * How many points of one shot are kept. The exact count is in `lines`, which
 * is never capped — this is only the geometry, and the two heavy boundary
 * meshes are a hundred thousand points each. Keeping them all is gigabytes
 * across a suite's frames; the shapes a test reads a position off (an area,
 * a marker, a line along one parallel) are nowhere near this.
 */
const POINT_CAP = 4096

export interface Shot {
  /** Which painted frame drew it: the globe sets the canvas transform once a frame, and nothing else does. */
  frame: number
  color: string
  width: number
  /** Line commands since beginPath — the exact count, uncapped. */
  lines: number
  points: Array<[number, number]>
}

/** A CSS color the theme writes → [r, g, b]; null for anything a real canvas would refuse. */
const rgbOf = (css: string): [number, number, number] | null => {
  const m = /^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/.exec(css.trim())
  if (m) return [Number(m[1]), Number(m[2]), Number(m[3])]
  const hex = /^#([0-9a-f]{6})$/i.exec(css.trim())
  if (hex) return [0, 2, 4].map(i => parseInt(hex[1].slice(i, i + 2), 16)) as [number, number, number]
  return null
}

/**
 * The dark theme's own values (main.tsx), so a color test reads what Nic sees.
 * jsdom has no stylesheet, so they are set on the canvas by `dress`.
 */
export const METRICS_THEME: Record<string, string> = {
  '--b1': 'rgb(34, 42, 56)',          // #222a38
  '--b2': 'rgb(42, 53, 71)',          // #2a3547 — the light gray-blue
  '--bg2': 'rgb(18, 21, 25)',         // #121519 — what the state lines used to be
  '--heat-none': 'rgb(24, 28, 34)',   // #181c22 — the land
  '--heat-hi': 'rgb(201, 162, 39)',   // the gold
  '--heat-base': 'rgb(18, 21, 25)',
  '--t0': 'rgb(238, 240, 246)',
  '--t1': 'rgb(184, 196, 216)',
}

export function recordCanvas() {
  const fills: Shot[] = []
  const strokes: Shot[] = []
  const arcs: Array<[number, number]> = []
  let points: Array<[number, number]> = []
  let lines = 0
  let fillStyle = '#808080'
  let painted = '#808080'
  let frame = 0
  const at = (x: number, y: number) => {
    lines++
    if (points.length < POINT_CAP) points.push([x, y])
  }
  const shot = (color: string, width: number): Shot =>
    ({ frame, color, width, lines, points: [...points] })
  const ctx: any = {
    strokeStyle: '', lineWidth: 0, globalAlpha: 1,
    setTransform() { frame++ },
    clearRect() {},
    // The globe's own color reader asks a 1×1 canvas what a CSS color comes
    // out as. A real canvas keeps the last VALID color, so a theme variable
    // that is not set here reads back as the gray it was given first.
    fillRect() { painted = fillStyle },
    getImageData: () => ({ data: rgbOf(painted) ?? [128, 128, 128] }),
    beginPath() { points = []; lines = 0 },
    moveTo(x: number, y: number) { at(x, y) },
    lineTo(x: number, y: number) { at(x, y) },
    arc(x: number, y: number) { at(x, y); arcs.push([x, y]) },
    closePath() {},
    fill() { fills.push(shot(String(fillStyle), 0)) },
    stroke() { strokes.push(shot(String(ctx.strokeStyle), Number(ctx.lineWidth))) },
  }
  Object.defineProperty(ctx, 'fillStyle', {
    get: () => fillStyle,
    set: (v: string) => { if (rgbOf(v)) fillStyle = v },
  })
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx)
  vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue({
    width: W, height: H, top: 0, left: 0, right: W, bottom: H, x: 0, y: 0, toJSON: () => ({}),
  })
  return {
    /** How many frames have painted at all. */
    get frames() { return frame },
    /** Everything painted since the last `reset` — across frames. */
    all: { fills, strokes, arcs },
    /**
     * What is on the canvas NOW: the last frame that actually painted. The
     * last one and not the only one on purpose — a globe that has stopped
     * painting still SHOWS the picture it drew last, which is what Nic was
     * looking at, so a frozen canvas reads here as the stale picture it is
     * rather than as having drawn nothing.
     */
    get fills() { return fills.filter(s => s.frame === frame) },
    get strokes() { return strokes.filter(s => s.frame === frame) },
    reset() { fills.length = 0; strokes.length = 0; arcs.length = 0 },
    /**
     * The theme's variables, which jsdom has no stylesheet for — set on the
     * canvas itself, then the globe is asked to draw again the way a theme
     * change asks it to (it watches the page's own theme attribute). What it
     * drew before the theme was known is thrown away.
     */
    async dress(canvas: HTMLElement | null, theme: Record<string, string> = METRICS_THEME) {
      for (const [k, v] of Object.entries(theme)) canvas?.style.setProperty(k, v)
      this.reset()
      await act(async () => {
        document.documentElement.setAttribute('data-theme', 'dark')
        await new Promise(r => setTimeout(r, 400))
      })
    },
  }
}
