// @vitest-environment jsdom
/**
 * 10/20 (Nic, his own catch) — A GUEST PROMISED A SPACE IS NOT DRAGGED OFF IT
 * QUIETLY, AND THE PANEL NEVER CLAIMS THE NEW SPACE WAS PROMISED.
 *
 *   "The import does not send the emails because... when we have to think about
 *    this from people migrating where they may have already paid a deposit.
 *    They may have already gotten a confirmation on a space number. Our system
 *    with compression and expansion is going to kind of screw that up if they
 *    think they're locked to a specific site already."
 *
 * Dale Carter came in from the old system promised RV 14, so his reservation is
 * pinned with lock_reason 'promised_before_gam'. The schedule's own movers all
 * refuse to touch him. A PERSON may move him — the guest agreed on the phone,
 * the site flooded — and that is deliberately allowed. What is tested here:
 *
 *   - his bar still DRAGS, because the lock is about the space, not the dates
 *     (a snowbird adds a month all the time);
 *   - dropping him on another space stops and asks, naming the number he
 *     already has and saying GAM will email him the new one;
 *   - the confirmed drag sends overrideLocked, which is what the server needs
 *     before it will write the move;
 *   - and afterwards the detail panel does NOT say "Promised this space before
 *     GAM" about a space nobody ever promised him.
 *
 * Every answer is built as the SERVER sends it (snake_case) and passed through
 * camelizeKeys, as lib/api does.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from 'react-query'
import { MemoryRouter } from 'react-router-dom'

const server = vi.hoisted(() => ({
  properties: [] as any[],
  schedule: null as any,
  patched: [] as { url: string; body: any }[],
}))
const dialogs = vi.hoisted(() => ({
  confirm: vi.fn(async () => true),
  toasts: [] as string[],
}))

vi.mock('../lib/api', async () => {
  const { camelizeKeys: camel } = await import('@gam/shared')
  const get = async (url: string) => {
    if (url === '/properties') return camel(server.properties)
    if (url.startsWith('/units/schedule/master')) return camel(server.schedule)
    return []
  }
  return {
    api: { get: async (url: string) => ({ data: { success: true, data: await get(url) } }) },
    apiGet: get,
    apiPost: async () => ({ success: true, data: {} }),
    apiPatch: async (url: string, body: any) => { server.patched.push({ url, body }); return {} },
    apiPut: async () => ({}),
    apiDel: async () => ({}),
    apiDelete: async () => ({}),
    openPdfInNewTab: async () => {},
    ACCOUNT_LOCKED_EVENT: 'gam:account-locked',
  }
})
vi.mock('../components/dialogs', () => ({
  toast: Object.assign((m: string) => { dialogs.toasts.push(m) }, { error: (m: string) => { dialogs.toasts.push(m) } }),
  appConfirm: dialogs.confirm,
  appPrompt: vi.fn(async () => null),
  appChoose: vi.fn(async () => null),
}))
vi.mock('../lib/permissions', () => ({ usePerms: () => ({ can: () => true, isOwner: true }) }))

import {
  SchedulePage, isScheduleBarLocked, isScheduleBarSiteLocked,
  promisedSiteWords, scheduleStayLockWords, SITE_MOVED_BY_HAND_REASON,
} from './SchedulePage'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
;(globalThis as any).ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }

const TODAY = new Date().toISOString().split('T')[0]
const day = (n: number) => {
  const d = new Date(TODAY + 'T12:00:00Z')
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().split('T')[0]
}
const stamp = (d: string) => `${d}T00:00:00.000Z`

const PROPERTY = { id: 'p1', name: 'Mountain View RV Park' }
const site = (id: string, number: string) => ({
  id, unit_number: number, unit_type: 'rv_spot', status: 'available', is_bookable: true,
  property_id: 'p1', property_name: PROPERTY.name, nightly_rate: 55,
  lease_types_allowed: ['nightly', 'weekly'],
})
const stay = (o: Record<string, unknown>) => ({
  requires_booking_acknowledgment: false, acknowledgment_signed_at: null,
  guest_email: 'dale@t.dev', total_amount: 280, notes: null, lease_type: 'weekly',
  locked_to_unit: false, lock_reason: null, avoided_unit_ids: null,
  ...o,
  check_in: stamp(o.check_in as string),   // wire-ok: the RAW shape the master-schedule endpoint sends, camelized by the mock above exactly as lib/api does
  check_out: stamp(o.check_out as string), // wire-ok: the RAW shape the master-schedule endpoint sends, camelized by the mock above exactly as lib/api does
})

/** Dale on RV 14, pinned because the old system gave him that number. */
const DALE = (over: Record<string, unknown> = {}) => stay({
  id: 'b_dale', unit_id: 'u14', guest_name: 'Dale Carter', status: 'confirmed',
  check_in: day(3), check_out: day(10),
  locked_to_unit: true, lock_reason: 'promised_before_gam',
  migrated_door: 'file', told_outside_gam: true,
  ...over,
})

const SCHEDULE = (bookings: any[]) => ({
  units: [site('u14', 'RV 14'), site('u09', 'RV 09')],
  bookings, leases: [], out_of_order: [], out_of_order_history: [],
})

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  server.properties = [PROPERTY]
  server.schedule = SCHEDULE([DALE()])
  server.patched = []
  dialogs.toasts = []
  dialogs.confirm.mockClear()
  dialogs.confirm.mockResolvedValue(true as any)
  try { localStorage.clear() } catch { /* private mode */ }
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

async function until(check: () => boolean, what: string) {
  for (let i = 0; i < 200; i++) {
    if (check()) return
    await act(async () => { await new Promise(r => setTimeout(r, 10)) })
  }
  throw new Error(`timed out waiting for ${what}`)
}
async function openTimeline() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  await act(async () => {
    root.render(
      <QueryClientProvider client={qc}>
        <MemoryRouter><SchedulePage /></MemoryRouter>
      </QueryClientProvider>,
    )
  })
  await until(() => cells('b_dale').length > 0, 'the timeline to draw Dale\'s bar')
}

const cells = (id: string) => [...host.querySelectorAll(`[data-bar-id="${id}"]`)] as HTMLElement[]
const cellFor = (unitId: string, date: string) =>
  host.querySelector(`td[data-unit="${unitId}"][data-date="${date}"]`) as HTMLElement

/** A drag event jsdom will carry, with the dataTransfer the handlers touch. */
function dragEvent(type: string) {
  const e: any = new MouseEvent(type, { bubbles: true, cancelable: true })
  e.dataTransfer = { effectAllowed: '', dropEffect: '', setData() {}, getData: () => '' }
  return e
}
/**
 * Pick the bar up by a middle day (so the grab is a MOVE, not an edge resize),
 * hover the target site, and let go.
 */
async function dragTo(barId: string, grabDate: string, toUnitId: string, hoverDate: string) {
  const grab = cells(barId).find(c => c.closest('td')?.dataset.date === grabDate)
  if (!grab) throw new Error(`no cell of ${barId} on ${grabDate}`)
  await act(async () => { grab.dispatchEvent(dragEvent('dragstart')) })
  await act(async () => { cellFor(toUnitId, hoverDate).dispatchEvent(dragEvent('dragover')) })
  await act(async () => { cellFor(toUnitId, hoverDate).dispatchEvent(dragEvent('drop')) })
  await act(async () => { await new Promise(r => setTimeout(r, 30)) })
}

describe('what kind of locked a pinned stay is', () => {
  it('its space is locked and its dates are not', () => {
    const pinned = { status: 'confirmed', lockedToUnit: true }
    expect(isScheduleBarSiteLocked(pinned)).toBe(true)
    // The bar still drags: a snowbird adding a month is the most ordinary
    // thing on the board, and freezing the dates would take that away.
    expect(isScheduleBarLocked(pinned)).toBe(false)
  })

  it('an ordinary reservation is pinned to nothing', () => {
    expect(isScheduleBarSiteLocked({ status: 'confirmed', lockedToUnit: false })).toBe(false)
    expect(isScheduleBarSiteLocked({ status: 'tentative' })).toBe(false)
  })

  it('the board marks which bars will stop to ask', async () => {
    await openTimeline()
    const dale = cells('b_dale')
    expect(dale.length).toBeGreaterThan(0)
    expect(dale.every(c => c.dataset.barSiteLocked === 'true')).toBe(true)
    expect(dale.every(c => c.dataset.barLocked === 'false')).toBe(true)
    expect(dale.every(c => c.getAttribute('draggable') === 'true')).toBe(true)
  })
})

describe('the question asked before a promised space is given up', () => {
  it('names the number in the guest\'s hand, where they are going, and who tells them', () => {
    const words = promisedSiteWords(
      { guestName: 'Dale Carter', unitNumber: 'RV 14', guestEmail: 'dale@t.dev', lockReason: 'promised_before_gam' },
      'RV 09')
    expect(words).toContain('Dale Carter was promised this space before GAM, in the old system')
    expect(words).toContain('RV 14 is the number they have')
    expect(words).toContain('Moving them to RV 09 means RV 14 is no longer theirs')
    expect(words).toContain('We will email them that their site is now RV 09')
  })

  it('says a phone call is owed when there is nobody to email', () => {
    const words = promisedSiteWords(
      { guestName: 'Dale Carter', unitNumber: 'RV 14', guestEmail: '', lockReason: 'promised_at_the_counter' },
      'RV 09')
    expect(words).toContain('was promised this space at the desk')
    expect(words).toContain('somebody has to call them')
    expect(words).not.toContain('We will email')
  })

  it('a snowbird the landlord pinned says so, rather than inventing a promise', () => {
    const words = promisedSiteWords({ guestName: 'Dale Carter', unitNumber: 'RV 14', guestEmail: 'd@t.dev' }, 'RV 09')
    expect(words).toContain('Dale Carter is pinned to this space by hand')
    expect(words).not.toContain('promised')
  })
})

describe('dragging a promised stay to another space', () => {
  it('stops and asks, and sends the move only once it is confirmed', async () => {
    await openTimeline()
    await dragTo('b_dale', day(5), 'u09', day(5))

    expect(dialogs.confirm).toHaveBeenCalledTimes(1)
    const [message, opts] = dialogs.confirm.mock.calls[0] as any[]
    expect(message).toContain('Dale Carter was promised this space before GAM, in the old system')
    expect(message).toContain('RV 14 is the number they have')
    expect(message).toContain('We will email them that their site is now RV 09')
    expect(message).toContain('Move them there anyway?')
    expect(opts).toMatchObject({ confirmLabel: 'Move them there' })

    // Confirmed, it goes — and it carries the word the server is waiting for.
    expect(server.patched).toHaveLength(1)
    expect(server.patched[0].url).toBe('/units/u09/bookings/b_dale')
    expect(server.patched[0].body).toMatchObject({ unitId: 'u09', overrideLocked: true })
  })

  it('writes nothing when the question is answered no', async () => {
    dialogs.confirm.mockResolvedValue(false as any)
    await openTimeline()
    await dragTo('b_dale', day(5), 'u09', day(5))

    // The damning assertion first: nothing may reach the server on a no. A
    // screen that never asked moves the guest here, which is the whole defect.
    expect(server.patched).toEqual([])
    expect(dialogs.confirm).toHaveBeenCalledTimes(1)
  })

  it('asks nothing when the drag only moves the dates on its own space', async () => {
    await openTimeline()
    await dragTo('b_dale', day(5), 'u14', day(6))

    expect(dialogs.confirm).not.toHaveBeenCalled()
    expect(server.patched).toHaveLength(1)
    expect(server.patched[0].body.unitId).toBe('u14')
    expect(server.patched[0].body.overrideLocked).toBeUndefined()
  })

  it('leaves an unpinned reservation to be dragged anywhere, as before', async () => {
    server.schedule = SCHEDULE([DALE({ locked_to_unit: false, lock_reason: null })])
    await openTimeline()
    await dragTo('b_dale', day(5), 'u09', day(5))

    expect(dialogs.confirm).not.toHaveBeenCalled()
    expect(server.patched).toHaveLength(1)
    expect(server.patched[0].body.overrideLocked).toBeUndefined()
  })
})

describe('the panel never claims a space nobody promised', () => {
  it('reads the reason the hand move wrote, not the promise it replaced', () => {
    // Before: the old system's promise, about the space the old system gave.
    expect(scheduleStayLockWords('promised_before_gam')).toContain('Promised this space before GAM')
    // After a hand move: still pinned, but nothing here calls it promised.
    const after = scheduleStayLockWords(SITE_MOVED_BY_HAND_REASON)
    expect(after).toContain('Moved here by hand, off the space they were promised')
    expect(after).not.toMatch(/^Promised this space/)
    // And the fact that matters is on the screen: a stale number is out there.
    expect(after).toContain('the space in their confirmation is no longer theirs')
  })

  it('says it on the stay that was moved, where the desk reads it', async () => {
    server.schedule = SCHEDULE([DALE({ unit_id: 'u09', lock_reason: SITE_MOVED_BY_HAND_REASON })])
    await openTimeline()
    await act(async () => { cells('b_dale')[0].dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise(r => setTimeout(r, 30)) })

    const reason = host.querySelector('[data-testid="stay-lock-reason"]') as HTMLElement
    expect(reason, 'the detail panel to show why the stay is locked').toBeTruthy()
    expect(reason.textContent).toContain('Moved here by hand, off the space they were promised')
    expect(reason.textContent).not.toContain('Promised this space before GAM')
  })
})
