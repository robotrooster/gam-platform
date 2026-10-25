// @vitest-environment jsdom
/**
 * 10/18 (Nic): "I want to know why the green reservations, the stays that are
 * checked in, are highlighted yellow around each square. Like, it's almost
 * highlighted like you have it clicked on… I want the color to be yellow when
 * they're not checked in and green when they're checked in. And they can stay
 * blue when they have a lease. And when they are checked out… the blue ones are
 * locked. You can't adjust the dates on them because they're tied to the lease.
 * But the stays that are green, once they've been here and gone and they're
 * checked out, those also need to be locked. So I can't move it around. I can't
 * change the dates accidentally… It's that reservation becomes locked as part of
 * the history."
 *
 * The Schedule's timeline, rendered with one site per state of a stay, so the
 * colors and the locks are read off the page the way Nic reads them off the
 * screen. Every answer is built as the SERVER sends it (snake_case) and passed
 * through camelizeKeys, as lib/api does.
 */
import { readFileSync } from 'node:fs'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from 'react-query'
import { MemoryRouter } from 'react-router-dom'

const server = vi.hoisted(() => ({
  properties: [] as any[],
  schedule: null as any,
  asked: [] as string[],
}))

vi.mock('../lib/api', async () => {
  const { camelizeKeys: camel } = await import('@gam/shared')
  const get = async (url: string) => {
    server.asked.push(url)
    if (url === '/properties') return camel(server.properties)
    if (url.startsWith('/units/schedule/master')) return camel(server.schedule)
    return []
  }
  return {
    api: { get: async (url: string) => ({ data: { success: true, data: await get(url) } }) },
    apiGet: get,
    apiPost: async () => ({ success: true, data: {} }),
    apiPatch: async () => ({}),
    apiPut: async () => ({}),
    apiDel: async () => ({}),
    apiDelete: async () => ({}),
    openPdfInNewTab: async () => {},
    ACCOUNT_LOCKED_EVENT: 'gam:account-locked',
  }
})
vi.mock('../components/dialogs', () => ({
  toast: Object.assign(() => {}, { error: () => {} }),
  appConfirm: vi.fn(async () => true),
  appPrompt: vi.fn(async () => null),
  appChoose: vi.fn(async () => null),
}))
vi.mock('../lib/permissions', () => ({ usePerms: () => ({ can: () => true, isOwner: true }) }))

import { SchedulePage, scheduleBarKind, isScheduleBarLocked, SCHEDULE_BAR_COLOR, SCHEDULE_BAR_TEXT, SCHEDULE_BAR_THEME_CSS } from './SchedulePage'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
// The floating-name overlay measures its rows with a ResizeObserver; jsdom has none.
;(globalThis as any).ResizeObserver = class {
  observe() {} unobserve() {} disconnect() {}
}

/** The same day the page calls today, and plain day math on top of it. */
const TODAY = new Date().toISOString().split('T')[0]
const day = (n: number) => {
  const d = new Date(TODAY + 'T12:00:00Z')
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().split('T')[0]
}
/** Dates reach the browser as full ISO timestamps (the S526 rule). */
const stamp = (d: string) => `${d}T00:00:00.000Z`

const PROPERTY = { id: 'p1', name: 'Sunset Palms RV Resort' }

const site = (id: string, number: string) => ({
  id, unit_number: number, unit_type: 'rv_spot', status: 'available', is_bookable: true,
  property_id: 'p1', property_name: PROPERTY.name, nightly_rate: 55,
})

/** A stay as the master-schedule endpoint sends it. */
const stay = (o: Record<string, unknown>) => ({
  requires_booking_acknowledgment: false, acknowledgment_signed_at: null,
  guest_email: 'guest@example.com', total_amount: 220, notes: null,
  ...o,
  check_in: stamp(o.check_in as string),  // wire-ok: the RAW shape the master-schedule endpoint sends, camelized by the mock above exactly as lib/api does
  check_out: stamp(o.check_out as string),  // wire-ok: the RAW shape the master-schedule endpoint sends, camelized by the mock above exactly as lib/api does
})

const SCHEDULE = () => ({
  units: [site('u1', 'RV 1'), site('u2', 'RV 2'), site('u3', 'RV 3'), site('u4', 'RV 4'), site('u5', 'RV 5')],
  bookings: [
    // Booked, nobody has arrived — and its property-rules acknowledgment is the
    // one that used to draw a yellow box around every square.
    stay({ id: 'b_reserved', unit_id: 'u1', guest_name: 'Pat Reserved', status: 'confirmed',
           check_in: day(5), check_out: day(8),
           requires_booking_acknowledgment: true, acknowledgment_signed_at: null }),
    stay({ id: 'b_tentative', unit_id: 'u2', guest_name: 'Sam Tentative', status: 'tentative',
           check_in: day(20), check_out: day(23) }),
    stay({ id: 'b_in', unit_id: 'u3', guest_name: 'Dana Arrived', status: 'checked_in',
           check_in: day(-1), check_out: day(3) }),
    stay({ id: 'b_out', unit_id: 'u4', guest_name: 'Lee Gone', status: 'checked_out',
           check_in: day(-20), check_out: day(-15) }),
    stay({ id: 'b_noshow', unit_id: 'u2', guest_name: 'Rory Never Came', status: 'no_show',
           check_in: day(-10), check_out: day(-8) }),
  ],
  leases: [{
    id: 'l1', unit_id: 'u5', first_name: 'Dakota', last_name: 'Lane', status: 'active',
    start_date: stamp(day(-5)), end_date: stamp(day(40)), rent_amount: 650,
    unit_number: 'RV 5', unit_type: 'rv_spot', property_name: PROPERTY.name,
  }],
  out_of_order: [],
  out_of_order_history: [],
})

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  server.properties = [PROPERTY]
  server.schedule = SCHEDULE()
  server.asked = []
  try { localStorage.clear() } catch { /* private mode */ }
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

async function openTimeline() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  await act(async () => {
    root.render(
      <QueryClientProvider client={qc}>
        <MemoryRouter><SchedulePage /></MemoryRouter>
      </QueryClientProvider>,
    )
  })
  await until(() => cells('b_in').length > 0, 'the timeline to draw its bars')
}
async function until(check: () => boolean, what: string) {
  for (let i = 0; i < 200; i++) {
    if (check()) return
    await act(async () => { await new Promise(r => setTimeout(r, 10)) })
  }
  throw new Error(`timed out waiting for ${what}`)
}

/** Every day cell of one bar, in date order. */
const cells = (id: string) =>
  [...host.querySelectorAll(`[data-bar-id="${id}"]`)] as HTMLElement[]
const backgrounds = (id: string) => [...new Set(cells(id).map(c => c.style.background))]
/** The one floating name pinned over a bar. */
const name = (id: string) => host.querySelector(`[data-testid="bar-name-${id}"]`) as HTMLElement | null
const grips = (id: string) =>
  cells(id).flatMap(c => [...c.querySelectorAll('span[title^="Drag this edge"]')])
const modalTitle = () => host.querySelector('.modal-title')?.textContent ?? null
/** Right-click, then let the window's own lookups settle before we read it. */
const rightClick = async (el: HTMLElement) => {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
  })
  await act(async () => { await new Promise(r => setTimeout(r, 20)) })
}

describe('what a bar on the Schedule is colored', () => {
  it('a lease is blue, not arrived is yellow, checked in is green', async () => {
    await openTimeline()
    expect(backgrounds('l1')).toEqual(['var(--blue)'])
    expect(backgrounds('b_reserved')).toEqual(['var(--amber)'])
    expect(backgrounds('b_tentative')).toEqual(['var(--amber)'])
    expect(backgrounds('b_in')).toEqual(['var(--green)'])
  })

  it('a stay that has been here and gone is dim green, a no-show dim red', async () => {
    await openTimeline()
    expect(backgrounds('b_out')).toEqual(['var(--sched-fill-checked-out)'])
    expect(backgrounds('b_noshow')).toEqual(['var(--sched-fill-no-show)'])
  })

  it('every bar paints one color for its whole length, with a name on it', async () => {
    await openTimeline()
    // Three nights booked = three day cells, all one color.
    expect(cells('b_reserved')).toHaveLength(3)
    expect(name('b_reserved')?.textContent).toBe('Pat Reserved')
    expect(name('b_in')?.textContent).toBe('Dana Arrived')
  })
})

describe('the yellow box around every square is gone', () => {
  it('no bar carries a per-cell amber border — the single dot is the whole ack signal', async () => {
    await openTimeline()
    const everyBar = [...host.querySelectorAll('[data-bar-id]')] as HTMLElement[]
    expect(everyBar.length).toBeGreaterThan(0)
    for (const bar of everyBar) {
      expect(bar.style.border).not.toContain('amber')
      expect(bar.getAttribute('style') ?? '').not.toContain('border: 1px solid var(--amber)')
    }
    // The acknowledgment is still said — once, at the bar's start, and in words.
    const start = cells('b_reserved')[0]
    expect(start.querySelectorAll('span[style*="border-radius: 50%"]').length).toBe(1)
    expect(start.getAttribute('title')).toContain('acknowledgment pending')
  })

  // 10/18 (review): everything in this app is border-box (globals.css sets it on
  // `*`), so a ring is taken OUT of the dot instead of added around it — a 2px
  // ring on an 8px dot leaves a 4px amber core, a FAINTER pending mark than
  // before the ring existed. And the dot fires on a checked-in guest too, so
  // that weaker mark would land on the green and blue bars, which were never
  // part of what Nic was complaining about. 10px keeps the 6px core it had.
  it('the ack dot keeps its 6px amber core inside the new ring', async () => {
    await openTimeline()
    const dot = cells('b_reserved')[0]
      .querySelector('span[style*="border-radius: 50%"]') as HTMLElement
    expect(dot.style.width).toBe('10px')
    expect(dot.style.height).toBe('10px')
    expect(dot.getAttribute('style') ?? '').toContain('2px solid')
  })
})

describe('history is locked on the calendar', () => {
  it('a checked-out stay cannot be dragged and has no edge grips', async () => {
    await openTimeline()
    for (const c of cells('b_out')) {
      expect(c.draggable).toBe(false)
      expect(c.style.cursor).toBe('default')
    }
    expect(grips('b_out')).toHaveLength(0)
    expect(name('b_out')?.textContent).toBe('🔒 Lee Gone')
  })

  it('a no-show is locked the same way', async () => {
    await openTimeline()
    expect(cells('b_noshow').every(c => c.draggable === false)).toBe(true)
    expect(grips('b_noshow')).toHaveLength(0)
    expect(name('b_noshow')?.textContent).toBe('🔒 Rory Never Came')
  })

  it('a lease stays locked, as it always was', async () => {
    await openTimeline()
    expect(cells('l1').every(c => c.draggable === false)).toBe(true)
    expect(grips('l1')).toHaveLength(0)
    expect(name('l1')?.textContent).toBe('🔒 Dakota Lane')
  })

  it('a stay still to come is draggable, with a grip on each end', async () => {
    await openTimeline()
    for (const c of cells('b_reserved')) {
      expect(c.draggable).toBe(true)
      expect(c.style.cursor).toBe('grab')
    }
    expect(grips('b_reserved')).toHaveLength(2)
    expect(name('b_reserved')?.textContent).toBe('Pat Reserved')
  })

  it('a checked-in stay is still draggable — it has not finished yet', async () => {
    await openTimeline()
    expect(cells('b_in').every(c => c.draggable === true)).toBe(true)
  })
})

describe('right-clicking a bar', () => {
  it('a checked-out stay opens its window to read, never straight into the date editor', async () => {
    await openTimeline()
    await rightClick(cells('b_out')[0])
    expect(modalTitle()).toContain('Reservation')
    expect(modalTitle()).not.toContain('Edit reservation')
    expect(host.querySelector('input[placeholder="e.g. RV 12, RV 14"]')).toBeNull()
  })

  // 10/18 (review): the accident Nic named is the mouse — dragging a finished
  // stay onto new dates. Correcting one on purpose is still something the desk
  // has to be able to do: an arrival day typed a day early sold and priced a
  // night that was never stayed, and no other screen in the portal can fix it
  // (the check-out screen never asks for a date on a stay already checked out).
  it('a checked-out stay still offers Edit, and pressing it opens the date editor', async () => {
    await openTimeline()
    await rightClick(cells('b_out')[0])
    const edit = [...host.querySelectorAll('button')].find(b => b.textContent === 'Edit') as HTMLButtonElement
    expect(edit).toBeTruthy()
    expect(edit.title).toContain('correct what was recorded')
    await act(async () => { edit.click() })
    await act(async () => { await new Promise(r => setTimeout(r, 20)) })
    expect(modalTitle()).toContain('Edit reservation')
    // The window's own Check-in / Check-out, prefilled with the dates on
    // record — the page's Jump-to-date box is a date input too, so read the
    // pair inside the modal.
    const dates = [...host.querySelectorAll('.modal input[type="date"]')] as HTMLInputElement[]
    expect(dates.map(i => i.value).slice(0, 2)).toEqual([day(-20), day(-15)])
  })

  it('a no-show opens its window to read, never the date editor', async () => {
    await openTimeline()
    await rightClick(cells('b_noshow')[0])
    expect(modalTitle()).not.toContain('Edit reservation')
  })

  it('a stay still to come opens straight into the date editor, as before', async () => {
    await openTimeline()
    await rightClick(cells('b_reserved')[0])
    expect(modalTitle()).toContain('Edit reservation')
    expect(host.querySelector('input[placeholder="e.g. RV 12, RV 14"]')).not.toBeNull()
  })
})

describe('the legend says what the colors mean', () => {
  it('names every color with the shared status wording', async () => {
    await openTimeline()
    const legend = host.textContent ?? ''
    expect(legend).toContain('Lease (managed on Leases page)')
    // 10/18 (review): the amber swatch must not claim "Confirmed" — a tentative
    // hold paints the same amber, and a clerk who reads the board as confirmed
    // turns away a walk-in who would have paid for that site.
    //
    // 10/24 (Nic): the money now splits that amber, and the wording carries the
    // same guard further than it did. Amber SAYS nothing has been paid, which is
    // exactly the thing a clerk needs to know before turning a walk-in away: an
    // unpaid hold yields to somebody with money, a paid one does not. Both
    // statuses stay named on the amber swatch, because both can be unpaid.
    expect(legend).toContain('Booked, nothing paid yet (Tentative or Confirmed)')
    expect(legend).not.toContain('Confirmed — not arrived yet')
    expect(legend).toContain('Booked and paid')
    expect(legend).toContain('Checked in')
    expect(legend).toContain('Checked out')
    expect(legend).toContain('No-show')
  })
})

describe('scheduleBarKind / isScheduleBarLocked', () => {
  it('reads the kind off the booking, and locks exactly the finished ones', () => {
    expect(scheduleBarKind({ startDate: '2026-10-01' })).toBe('lease')
    expect(scheduleBarKind({ isLease: true })).toBe('lease')
    expect(scheduleBarKind({ status: 'tentative' })).toBe('reserved')
    expect(scheduleBarKind({ status: 'confirmed' })).toBe('reserved')
    // 10/24 (Nic): money in hand splits the amber. All three ways it arrives —
    // the deposit cleared, the whole balance cleared, or they paid at the
    // register on the way in — mean the same thing to the board.
    expect(scheduleBarKind({ status: 'tentative', depositPaidAt: '2026-10-24T00:00:00Z' })).toBe('reserved_paid')
    expect(scheduleBarKind({ status: 'confirmed', depositPaidAt: '2026-10-24T00:00:00Z' })).toBe('reserved_paid')
    expect(scheduleBarKind({ status: 'confirmed', balancePaidAt: '2026-10-24T00:00:00Z' })).toBe('reserved_paid')
    expect(scheduleBarKind({ status: 'confirmed', posTransactionId: 'd2f1c0de-0000-4000-8000-000000000001' })).toBe('reserved_paid')
    // A stay somebody has arrived at is green whether it is paid or not — the
    // purple is only ever about an un-arrived reservation.
    expect(scheduleBarKind({ status: 'checked_in', depositPaidAt: '2026-10-24T00:00:00Z' })).toBe('checked_in')
    expect(scheduleBarKind({ status: 'checked_out', balancePaidAt: '2026-10-24T00:00:00Z' })).toBe('checked_out')
    expect(scheduleBarKind({ status: 'checked_in' })).toBe('checked_in')
    expect(scheduleBarKind({ status: 'checked_out' })).toBe('checked_out')
    expect(scheduleBarKind({ status: 'no_show' })).toBe('no_show')

    expect(isScheduleBarLocked({ status: 'confirmed' })).toBe(false)
    // Paying does not settle the dates. A paid guest who rings to move a day
    // still gets moved, and compression may still relocate them.
    expect(isScheduleBarLocked({ status: 'confirmed', depositPaidAt: '2026-10-24T00:00:00Z' })).toBe(false)
    expect(isScheduleBarLocked({ status: 'checked_in' })).toBe(false)
    expect(isScheduleBarLocked({ status: 'checked_out' })).toBe(true)
    expect(isScheduleBarLocked({ status: 'no_show' })).toBe(true)
    expect(isScheduleBarLocked({ startDate: '2026-10-01' })).toBe(true)
  })

  it('every kind has a color, and no two live states share one', () => {
    expect(SCHEDULE_BAR_COLOR.lease).toBe('var(--blue)')
    expect(SCHEDULE_BAR_COLOR.reserved).toBe('var(--amber)')
    expect(SCHEDULE_BAR_COLOR.reserved_paid).toBe('var(--sched-fill-reserved-paid)')  // wire-ok: a schedule bar-kind key on a shared map, not a field off an API response
    expect(SCHEDULE_BAR_COLOR.checked_in).toBe('var(--green)')  // wire-ok: a booking-status key on a shared map, not a field off an API response
    expect(SCHEDULE_BAR_COLOR.checked_out).toBe('var(--sched-fill-checked-out)')  // wire-ok: a booking-status key on a shared map, not a field off an API response
    expect(SCHEDULE_BAR_COLOR.no_show).toBe('var(--sched-fill-no-show)')  // wire-ok: a booking-status key on a shared map, not a field off an API response
    expect(new Set(Object.values(SCHEDULE_BAR_COLOR)).size).toBe(6)
  })

  it('every fill but the lease bar takes its ink from the theme', () => {
    // All of those fills invert between the dark and light themes, so one fixed
    // ink would be unreadable in whichever theme it was not picked for.
    for (const kind of ['reserved', 'reserved_paid', 'checked_in', 'checked_out', 'no_show'] as const) {
      expect(SCHEDULE_BAR_TEXT[kind]).toMatch(/^var\(--sched-ink-/)
    }
    // Blue is dark in both themes, so it keeps its one light ink.
    expect(SCHEDULE_BAR_TEXT.lease).toMatch(/^#/)
    expect(SCHEDULE_BAR_THEME_CSS).toContain('--sched-ink-reserved')
    expect(SCHEDULE_BAR_THEME_CSS).toContain(':root[data-theme="light"]')
  })
})

/**
 * 10/18 (review) — THE COLORS, RESOLVED FOR REAL.
 *
 * Pinning the token NAMES proves nothing about what a landlord sees. One bar
 * said var(--green) and another said var(--green-dim), both assertions passed,
 * and on the light theme those two resolved to within a hair of each other
 * (1.40:1) — the difference Nic asked for, invisible, with the padlock on the
 * floating name the only cue left. So this reads the real palette out of
 * styles/globals.css plus the timeline's own theme block, resolves every bar
 * fill and every ink to a hex, and measures how far apart they actually land.
 *
 * Distance is CIE76 deltaE, not a luminance ratio: yellow and bright green sit at
 * almost identical luminance (1.06:1) and are still never mistaken for one
 * another, while the broken pair was one hue a shade apart. deltaE catches that and
 * lets the hue differences through. For scale: the broken green pair measured
 * 14.9, and the dark theme's working pair measures 46.
 */
// jsdom swaps in its own URL class, which node:fs refuses as a path — so the
// file URL goes through fileURLToPath as a string.
// Read off disk by this file's own folder. (jsdom replaces the global URL with
// one that resolves a relative path against the fake document origin instead of
// the base it is handed, so new URL(..., import.meta.url) is no good here.)
const GLOBALS_CSS = readFileSync(`${import.meta.dirname}/../styles/globals.css`, 'utf8')

/** Every `--token: value` declared in one block of CSS. */
const declsIn = (body: string): Record<string, string> => {
  const out: Record<string, string> = {}
  for (const m of body.matchAll(/--([\w-]+)\s*:\s*([^;\n]+)/g)) out[`--${m[1]}`] = m[2].trim()
  return out
}
const blockFor = (css: string, re: RegExp, what: string): Record<string, string> => {
  const m = css.match(re)
  if (!m) throw new Error(`the ${what} block is gone from the stylesheet`)
  return declsIn(m[1])
}
const DARK_RE = /:root\s*\{([^}]*)\}/
const LIGHT_RE = /:root\[data-theme="light"\]\s*\{([^}]*)\}/

const DARK_TOKENS = {
  ...blockFor(GLOBALS_CSS, DARK_RE, 'globals dark'),
  ...blockFor(SCHEDULE_BAR_THEME_CSS, DARK_RE, 'timeline dark'),
}
const LIGHT_TOKENS = {
  ...DARK_TOKENS,
  ...blockFor(GLOBALS_CSS, LIGHT_RE, 'globals light'),
  ...blockFor(SCHEDULE_BAR_THEME_CSS, LIGHT_RE, 'timeline light'),
}

/** var(--a) → var(--b) → #hex, the way the browser does it. */
const resolve = (value: string, tokens: Record<string, string>): string => {
  let v = value.trim()
  for (let i = 0; i < 8 && v.includes('var('); i++) {
    v = v.replace(/var\(\s*(--[\w-]+)\s*\)/g, (_m, name: string) => tokens[name] ?? '').trim()
  }
  if (!/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(v)) throw new Error(`${value} resolved to "${v}", not a color`)
  return v
}

const rgb = (hex: string): number[] => {
  let h = hex.replace('#', '')
  if (h.length === 3) h = h.split('').map(c => c + c).join('')
  return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16))
}
const toLinear = (c: number) => (c /= 255) <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
const luminance = (hex: string) => {
  const [r, g, b] = rgb(hex).map(toLinear)
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
/** WCAG contrast — the right question for INK on a fill. */
const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}
/** CIE76 deltaE — the right question for one fill against another. */
const toLab = (hex: string): number[] => {
  const [r, g, b] = rgb(hex).map(toLinear)
  const x = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047
  const y = 0.2126 * r + 0.7152 * g + 0.0722 * b
  const z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883
  const f = (t: number) => t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))]
}
const deltaE = (a: string, b: string) => {
  const [A, B] = [toLab(a), toLab(b)]
  return Math.hypot(A[0] - B[0], A[1] - B[1], A[2] - B[2])
}

const KINDS = ['lease', 'reserved', 'reserved_paid', 'checked_in', 'checked_out', 'no_show'] as const
/** Comfortably above the 14.9 that read as one color, below every real pair. */
const TELL_APART = 25

describe.each([
  ['dark', DARK_TOKENS],
  ['light', LIGHT_TOKENS],
])('the bar colors a landlord on the %s theme actually sees', (_theme, tokens) => {
  it('no two states paint the same color', () => {
    const fills = KINDS.map(k => [k, resolve(SCHEDULE_BAR_COLOR[k], tokens)] as const)
    const tooClose: string[] = []
    for (let i = 0; i < fills.length; i++) {
      for (let j = i + 1; j < fills.length; j++) {
        const d = deltaE(fills[i][1], fills[j][1])
        if (d < TELL_APART) tooClose.push(`${fills[i][0]} ${fills[i][1]} / ${fills[j][0]} ${fills[j][1]} — deltaE ${d.toFixed(1)}`)
      }
    }
    expect(tooClose).toEqual([])
  })

  it('a guest living on the site and one who has been and gone are plainly different greens', () => {
    // The one the review caught: both resolved off --green / --green-dim, and
    // the light theme redefines only the first of those two.
    const living = resolve(SCHEDULE_BAR_COLOR.checked_in, tokens)  // wire-ok: a booking-status key on a shared map, not a field off an API response
    const gone = resolve(SCHEDULE_BAR_COLOR.checked_out, tokens)  // wire-ok: a booking-status key on a shared map, not a field off an API response
    expect(living).not.toBe(gone)
    expect(deltaE(living, gone)).toBeGreaterThan(TELL_APART)
  })

  it('a paid reservation is plainly not a lease, and plainly not the brand gold', () => {
    // 10/24 (Nic), the two things he asked of the color: "I don't know what,
    // more of a purplish color that won't be too close to anything" — and,
    // earlier, "something that doesn't match our gold color on other things."
    //
    // Blue is the near neighbour, because the lease bars sit on the same grid;
    // gold is not a bar fill at all but it IS what the Today column, the drag
    // preview and every action button wear, so purple has to clear it too.
    const paid = resolve(SCHEDULE_BAR_COLOR.reserved_paid, tokens)  // wire-ok: a schedule bar-kind key on a shared map, not a field off an API response
    const lease = resolve(SCHEDULE_BAR_COLOR.lease, tokens)
    const gold = resolve('var(--gold)', tokens)
    expect(deltaE(paid, lease)).toBeGreaterThan(TELL_APART)
    expect(deltaE(paid, gold)).toBeGreaterThan(TELL_APART)
  })

  it('an un-arrived stay that has paid and one that has not are plainly different', () => {
    // The whole point of the split: these two were ONE amber, and the only way
    // to tell them apart was to open every bar on the board one at a time.
    const unpaid = resolve(SCHEDULE_BAR_COLOR.reserved, tokens)
    const paid = resolve(SCHEDULE_BAR_COLOR.reserved_paid, tokens)  // wire-ok: a schedule bar-kind key on a shared map, not a field off an API response
    expect(unpaid).not.toBe(paid)
    expect(deltaE(unpaid, paid)).toBeGreaterThan(TELL_APART)
  })

  it('the guest name is readable on every bar', () => {
    const faint = KINDS
      .map(k => [k, contrast(resolve(SCHEDULE_BAR_COLOR[k], tokens), resolve(SCHEDULE_BAR_TEXT[k], tokens))] as const)
      .filter(([, ratio]) => ratio < 3)
      .map(([k, ratio]) => `${k} — ${ratio.toFixed(2)}:1`)
    expect(faint).toEqual([])
  })
})
