// @vitest-environment jsdom
/**
 * Final fix (fix pass 1, decisions #53): "never runs blind — Cancel
 * reservation on the Schedule opens the same confirm, showing fresh figures
 * and names, before anything is zeroed, and the server refuses a cancel that
 * would zero something without the expected total."
 *
 * CancelReservationModal: it reads GET …/cancel-check fresh when it opens (the
 * people by name, the move-in bill lines zeroed, what stays owed, or the
 * refusal words), the gold button sends the total it showed, a 409 is said once
 * and read again in place, and on success a toast says what happened and the
 * Schedule, the Leases page and the dashboard read again. Every mocked answer
 * is built as the SERVER sends it (snake_case) and passed through camelizeKeys,
 * as lib/api does.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from 'react-query'
import { MemoryRouter } from 'react-router-dom'

const server = vi.hoisted(() => ({
  answers: [] as any[],      // cancel-check answers, in order (the last one repeats) — server-shaped
  gets: [] as string[],
  patches: [] as Array<{ url: string; body: any }>,
  patchFail: null as null | { status: number; error: string },
  patchAnswer: null as null | Record<string, unknown>,
}))
const httpError = (status: number, error: string) =>
  Object.assign(new Error(error), { response: { status, data: { success: false, error } } })

vi.mock('../lib/api', async () => {
  const { camelizeKeys: camel } = await import('@gam/shared')
  return {
    apiGet: async (url: string) => {
      if (!url.endsWith('/cancel-check')) throw new Error(`unexpected GET ${url}`)
      const a = server.answers[Math.min(server.gets.length, server.answers.length - 1)]
      server.gets.push(url)
      if (a instanceof Error) throw a
      return camel(a)
    },
    // lib/api's apiPatch hands back the answer's `data`, camelCased.
    apiPatch: async (url: string, body?: any) => {
      server.patches.push({ url, body })
      if (server.patchFail) { const f = server.patchFail; server.patchFail = null; throw httpError(f.status, f.error) }
      return camel(server.patchAnswer ?? { id: 'b1', status: 'cancelled' })
    },
    apiPost: async () => ({ success: true, data: {} }),
    apiDelete: async () => ({}),
  }
})
const toasts = vi.hoisted(() => [] as string[])
vi.mock('../components/dialogs', () => ({
  toast: Object.assign((t: string) => { toasts.push(t) }, { error: (t: string) => { toasts.push(`error: ${t}`) } }),
  appConfirm: vi.fn(async () => true), appPrompt: vi.fn(async () => null),
}))
vi.mock('../lib/permissions', () => ({ usePerms: () => ({ can: () => true, isOwner: true }) }))

import { CancelReservationModal, CancelReservationButton } from './SchedulePage'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const BOOKING = { id: 'b1', unitId: 'u1', guestName: 'Pat Guest', checkIn: '2026-10-09', checkOut: '2026-12-08', status: 'confirmed' }

/** What GET …/cancel-check answers for a stay with one drafted lease, as the server sends it. */
const withLease = (o: Record<string, unknown> = {}) => ({
  booking: { id: 'b1', unit_id: 'u1', guest_name: 'Pat Guest', status: 'confirmed', check_in: '2026-10-09', check_out: '2026-12-08' },
  applies: true, words: null,
  leases: [{
    lease_id: 'l1', status: 'active', applies: true, words: null, start_date: '2026-10-09',
    lines: [
      { payment_id: 'p1', label: 'Rent', amount: 1000, due_date: '2026-10-09', utility: false },
      { payment_id: 'p2', label: 'Deposit', amount: 500, due_date: '2026-10-09', utility: false },
    ],
    total: 1500,
    kept: [{ payment_id: 'p3', label: 'Rent', amount: 1000, why: 'later_bill', due_date: '2026-11-09' }],
    kept_total: 1000, kept_words: 'Still owed after this: …', reservation_words: null,
    household: { tenant_names: ['Pat Guest', 'Lee Guest'], unit_number: 'RV 22', property_name: 'Oak Park' },
  }],
  total: 1500, kept_total: 1000, needs_total: true,
  ...o,
})
const noLease = () => withLease({ leases: [], total: 0, kept_total: 0, needs_total: false })

let host: HTMLDivElement
let root: Root
let closed = 0
let done = 0
let invalidated: string[] = []
beforeEach(() => {
  server.answers = [withLease()]; server.gets = []; server.patches = []; server.patchFail = null; server.patchAnswer = null
  toasts.length = 0; closed = 0; done = 0; invalidated = []
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const text = () => host.textContent ?? ''
const button = (re: RegExp) => [...host.querySelectorAll('button')].find(b => re.test(b.textContent ?? '')) as HTMLButtonElement | undefined
const count = (s: string) => text().split(s).length - 1
async function until(check: () => boolean, what: string) {
  for (let i = 0; i < 150; i++) {
    if (check()) return
    await act(async () => { await new Promise(r => setTimeout(r, 10)) })
  }
  throw new Error(`timed out waiting for ${what}; screen: ${text()}`)
}
/**
 * Fix pass 2 (review): pages NOT on screen, cached the way the app caches them
 * — the dashboard under DashboardPage's real key, its to-dos, the Leases list,
 * a Schedule range, its history, the Payments ledger. Each counts its reads.
 */
const OFFSCREEN_KEYS: any[] = [['dashboard', '', 'received'], 'landlord-todos', 'leases', ['schedule', '2026-10-01', '2026-10-31', 'all', ''], 'schedule-history', ['payments-ledger', 'current'],
  // Fix pass 1 of the #53 close (review): the Schedule's Reservations list.
  ['bookings', 'status=upcoming']]
let reads: Record<string, number> = {}
async function cacheOffscreenPages(qc: QueryClient) {
  reads = {}
  for (const k of OFFSCREEN_KEYS) {
    const name = JSON.stringify(k)
    reads[name] = 0
    await qc.fetchQuery(k, async () => { reads[name]++; return {} })
  }
}

async function open() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  await cacheOffscreenPages(qc)
  const inv = qc.invalidateQueries.bind(qc)
  qc.invalidateQueries = ((key: any, ...rest: any[]) => { invalidated.push(String(key)); return (inv as any)(key, ...rest) }) as any
  await act(async () => {
    root.render(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <CancelReservationModal booking={BOOKING} onClose={() => { closed++ }} onDone={() => { done++ }} />
        </MemoryRouter>
      </QueryClientProvider>)
  })
  await until(() => !text().includes('Reading what canceling this changes'), 'the fresh read')
}
async function click(el: Element | undefined) {
  if (!el) throw new Error(`nothing to click; screen: ${text()}`)
  await act(async () => { (el as HTMLElement).click() })
}

describe('Cancel reservation opens the never-moved-in confirm (decisions #53)', () => {
  it('reads fresh when it opens and shows the guest, the people on the lease by name, what is zeroed and what stays owed, with one gold button carrying the total', async () => {
    await open()
    expect(server.gets).toEqual(['/units/u1/bookings/b1/cancel-check'])
    expect(host.querySelector('[data-testid="cancel-who"]')?.textContent).toBe('Pat Guest — Oct 9, 2026 – Dec 8, 2026')
    expect(host.querySelector('[data-testid="cancel-lease-who"]')?.textContent)
      .toBe('Lease drafted with this stay: Pat Guest and Lee Guest — RV 22, Oak Park')
    const body = host.querySelector('[data-testid="nmi-zeroed"]')!.textContent!
    expect(body).toContain('The tenant never paid or moved in, so ending the lease zeroes their unpaid move-in bill:')
    expect(body).toContain('Rent · due Oct 9, 2026$1,000.00')
    expect(body).toContain('Deposit · due Oct 9, 2026$500.00')
    expect(body).toContain('No longer owed$1,500.00')
    expect(host.querySelector('[data-testid="nmi-kept"]')?.textContent)
      .toBe('Stays owed — on the household’s balanceRent · due Nov 9, 2026 · not on the move-in bill$1,000.00')
    const go = button(/^Cancel reservation/)
    expect(go?.textContent).toBe('Cancel reservation — $1,500.00 no longer owed')
    expect(go?.className).toContain('btn-primary')
    expect(button(/^Keep the reservation$/)?.className).toContain('btn-ghost')
  })

  it('the press sends the total it showed; on success a toast says what happened and the Schedule, the Leases page and the dashboard read again', async () => {
    const closedWords = 'Pat Guest\'s lease drafted with this reservation ended with it. Nothing was paid on it, so the $1,500.00 move-in bill is no longer owed.'
    server.patchAnswer = { id: 'b1', status: 'cancelled', leaseClosed: closedWords }
    await open()
    await click(button(/^Cancel reservation/))
    await until(() => done === 1, 'the window to finish')
    expect(server.patches).toEqual([{ url: '/units/u1/bookings/b1', body: { status: 'cancelled', expectedNeverMovedInTotal: 1500, expectedNeverMovedInLeases: 1 } }])
    expect(toasts).toEqual([`Reservation canceled. ${closedWords}`])
    // Fix pass 2 (review): the real keys, never the dead 'landlord-dashboard'.
    for (const k of ['schedule', 'schedule-history', 'bookings', 'leases', 'dashboard', 'landlord-todos', 'payments-ledger']) expect(invalidated).toContain(k)
    expect(invalidated).not.toContain('landlord-dashboard')
  })

  it('on success the dashboard (its real key), its to-dos, the Leases list, the Schedule, its Reservations list and the Payments ledger are read again — even when not on screen', async () => {
    server.patchAnswer = { id: 'b1', status: 'cancelled', leaseClosed: 'closed' }
    await open()
    for (const n of Object.values(reads)) expect(n).toBe(1)
    await click(button(/^Cancel reservation/))
    await until(() => done === 1, 'the window to finish')
    await until(() => Object.values(reads).every(n => n === 2), `every page read again (${JSON.stringify(reads)})`)
  })

  it('the dashboard key refreshed is the one DashboardPage reads (and its to-dos key)', async () => {
    const { readFileSync, existsSync } = await import('fs')
    const { resolve } = await import('path')
    const file = [resolve(process.cwd(), 'src/pages/DashboardPage.tsx'), resolve(process.cwd(), 'apps/landlord/src/pages/DashboardPage.tsx')].find(f => existsSync(f))!
    const src = readFileSync(file, 'utf8')
    expect(src).toMatch(/useQuery<DashStats>\(\s*\['dashboard', propertyId, basis\]/)
    expect(src).toMatch(/useQuery<any>\(\s*'landlord-todos'/)
    const { LEASE_CLOSE_REFRESH_KEYS } = await import('./LeasesPage')
    expect(LEASE_CLOSE_REFRESH_KEYS).toEqual(expect.arrayContaining(['dashboard', 'landlord-todos', 'leases', 'schedule']))
  })

  it('the Reservations-list key refreshed is the one the Schedule’s Reservations tab reads — a stay canceled on the calendar never shows its old status there', async () => {
    const { readFileSync, existsSync } = await import('fs')
    const { resolve } = await import('path')
    const file = [resolve(process.cwd(), 'src/pages/SchedulePage.tsx'), resolve(process.cwd(), 'apps/landlord/src/pages/SchedulePage.tsx')].find(f => existsSync(f))!
    expect(readFileSync(file, 'utf8')).toMatch(/\['bookings', resvQueryString\]/)
    const { LEASE_CLOSE_REFRESH_KEYS } = await import('./LeasesPage')
    expect(LEASE_CLOSE_REFRESH_KEYS).toContain('bookings')
  })

  it('the window’s own read failed: the error once with its next step, and Read again reads it fresh', async () => {
    server.answers = [new Error('network down'), withLease()]
    await open()
    expect(text()).toContain('What canceling this changes could not be read, so nothing was changed. Press Read again.')
    expect(button(/^Cancel reservation/)).toBeUndefined()
    // Fix pass 3 (review): Read again is the next step and the only action, so it is gold;
    // backing out stays gray.
    expect(button(/^Read again$/)?.className).toContain('btn-primary')
    expect(button(/^Keep the reservation$/)?.className).toContain('btn-ghost')
    await click(button(/^Read again$/))
    await until(() => button(/^Cancel reservation/)?.textContent === 'Cancel reservation — $1,500.00 no longer owed', 'the fresh read')
    expect(server.gets).toHaveLength(2)
    expect(button(/^Read again$/)).toBeUndefined()
  })

  it('a 409 (something changed) is said once and the window reads again in place, with the new total on the button', async () => {
    const changed = 'What this lease owes changed since you opened this, so nothing was closed. The window now shows what would be zeroed — check it and confirm again.'
    const later = withLease()
    ;(later.leases[0] as any).lines = [...later.leases[0].lines, { payment_id: 'p4', label: 'Late fee', amount: 25, due_date: '2026-10-14', utility: false }]
    ;(later.leases[0] as any).total = 1525
    server.answers = [withLease(), { ...later, total: 1525 }]
    server.patchFail = { status: 409, error: changed }
    await open()
    await click(button(/^Cancel reservation/))
    await until(() => server.gets.length === 2, 'the read again')
    await until(() => button(/^Cancel reservation/)?.textContent === 'Cancel reservation — $1,525.00 no longer owed', 'the new total')
    expect(count(changed)).toBe(1)
    expect(done).toBe(0)
    await click(button(/^Cancel reservation/))
    await until(() => done === 1, 'the window to finish')
    expect(server.patches[1].body).toEqual({ status: 'cancelled', expectedNeverMovedInTotal: 1525, expectedNeverMovedInLeases: 1 })
  })

  it('a refusal (the guest was checked in): the words, said once, only Close — nothing sent', async () => {
    const words = 'Pat Guest\'s reservation has a lease drafted with it, and canceling the reservation ends that lease — but their stay was checked in on Oct 4, 2026 (the Schedule shows it as Confirmed now), so they moved in. End the lease with a move-out instead: use Change → “They’re leaving on…” on the Leases page, then Change → Move out.'
    server.answers = [withLease({ applies: false, words, total: 0 })]
    await open()
    expect(host.querySelector('[data-testid="cancel-refusal"]')?.textContent).toBe(words)
    expect(count(words)).toBe(1)
    expect(button(/^Cancel reservation/)).toBeUndefined()
    await click(button(/^Close$/))
    expect(closed).toBe(1)
    expect(server.patches).toHaveLength(0)
  })

  it('a stay with no lease drafted: plain words, the press sends the $0 total and no leases it showed, and the toast says it was canceled', async () => {
    server.answers = [noLease()]
    await open()
    expect(host.querySelector('[data-testid="cancel-plain"]')?.textContent).toBe('The reservation comes off the Schedule and the site is free for those nights.')
    expect(button(/^Cancel reservation/)?.textContent).toBe('Cancel reservation')
    await click(button(/^Cancel reservation/))
    await until(() => done === 1, 'the window to finish')
    // Fix pass 2 (review): always the total it showed ($0) and the leases it
    // showed (none) — a lease drafted since is answered "changed since you
    // opened this" and read again here, never "use Cancel reservation".
    expect(server.patches).toEqual([{ url: '/units/u1/bookings/b1', body: { status: 'cancelled', expectedNeverMovedInTotal: 0, expectedNeverMovedInLeases: 0 } }])
    expect(toasts).toEqual(['Reservation canceled.'])
  })

  it('Keep the reservation backs out with nothing sent', async () => {
    await open()
    await click(button(/^Keep the reservation$/))
    expect(closed).toBe(1)
    expect(server.patches).toHaveLength(0)
  })
})

describe('the detail panel offers Cancel reservation only on a stay that can still be canceled (fix pass 3, review)', () => {
  const panelButton = async (status: string) => {
    let pressed = 0
    await act(async () => {
      root.render(<CancelReservationButton booking={{ status }} onCancel={() => { pressed++ }} />)
    })
    return { el: button(/^Cancel reservation$/), pressed: () => pressed }
  }
  for (const status of ['checked_in', 'checked_out', 'no_show', 'cancelled']) {
    it(`no Cancel reservation on a ${status} stay`, async () => {
      expect((await panelButton(status)).el).toBeUndefined()
    })
  }
  for (const status of ['confirmed', 'tentative']) {
    it(`Cancel reservation on a ${status} stay opens the confirm`, async () => {
      const b = await panelButton(status)
      expect(b.el).toBeDefined()
      await click(b.el)
      expect(b.pressed()).toBe(1)
    })
  }
})
