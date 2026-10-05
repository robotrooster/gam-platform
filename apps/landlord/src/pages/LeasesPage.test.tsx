// @vitest-environment jsdom
/**
 * 10/4 (decisions #46.4, Nic, FINAL): "If they never pay the deposit or never
 * move in, you would just zero it out and end the lease."
 *
 * Step 9 (final fix, fix pass 1): "They never moved in — end the lease" on the
 * Leases page. Staff-screen rules: fresh data at the moment of action (the
 * window reads what would be zeroed when it opens, and the total it showed
 * goes with the close), a confirm that says exactly what is zeroed, a 409 read
 * again in place and said once, a refusal in plain words with the real next
 * step, and Cancel that backs out with nothing sent.
 *
 * Fix pass 2: every mocked answer is built as the SERVER sends it (snake_case)
 * and passed through camelizeKeys — what lib/api does to every response — so
 * a key renamed on either side fails here. And the Leases list offers, for a
 * lease waiting for signatures, exactly what the server will do: Discard only
 * when nobody signed, "Void on the GoldSign page" (the signing page's name in
 * the app — Step 9 final fix, fix pass 1) when only the landlord did,
 * "They never moved in — end the lease" when any tenant did (the server's own
 * test, tenant_signed_any — not signed_by_tenant, set only once EVERYONE has).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from 'react-query'
import { MemoryRouter } from 'react-router-dom'
import { camelizeKeys } from '@gam/shared'

const server = vi.hoisted(() => ({
  answers: [] as any[],          // never-moved-in GET answers, in order (the last one repeats) — server-shaped
  gets: 0,
  leases: [] as any[],           // GET /leases — server-shaped
  leaseGets: 0,
  posts: [] as Array<{ url: string; body: any }>,
  postFail: null as null | { status: number; error: string; code?: string },
  hold: null as null | Promise<void>,   // a POST waits on this (a request still running)
  // What POST /leases/:id/never-moved-in answers, as the server sends it (null: the close's ordinary answer).
  postAnswer: null as null | Record<string, unknown>,
}))
const httpError = (status: number, error: string, code?: string) =>
  Object.assign(new Error(error), { response: { status, data: { success: false, error, ...(code ? { code } : {}) } } })

// lib/api hands a page the response's `data`, camelCased (applyCamelizeInterceptor).
vi.mock('../lib/api', async () => {
  const { camelizeKeys: camel } = await import('@gam/shared')
  return {
    apiGet: async (url: string) => {
      if (url === '/leases') { server.leaseGets++; return camel(server.leases) }
      if (!url.endsWith('/never-moved-in')) throw new Error(`unexpected GET ${url}`)
      const a = server.answers[Math.min(server.gets, server.answers.length - 1)]
      server.gets++
      if (a instanceof Error) throw a
      return camel(a)
    },
    apiPost: async (url: string, body?: any) => {
      server.posts.push({ url, body })
      if (server.hold) await server.hold
      if (server.postFail) { const f = server.postFail; server.postFail = null; throw httpError(f.status, f.error, f.code) }
      // lib/api's apiPost hands back the whole answer — { success, data } —
      // with its inner `data` camelCased (applyCamelizeInterceptor).
      if (url.endsWith('/never-moved-in')) {
        return { success: true, data: camel(server.postAnswer ?? {
          id: 'lease1', status: 'terminated', zeroed_lines: [], zeroed_total: body?.expectedTotal ?? 0,
          reservation_canceled: false, kept: [], kept_total: 0, kept_words: null,
        }) }
      }
      return { success: true, data: camel({ id: 'lease1', status: 'terminated' }) }
    },
    apiPatch: async () => ({}),
  }
})
const toasts = vi.hoisted(() => [] as string[])
vi.mock('../components/dialogs', () => ({ toast: Object.assign((t: string) => { toasts.push(t) }, { error: (t: string) => { toasts.push(`error: ${t}`) } }), appConfirm: vi.fn(async () => true) }))
const perms = vi.hoisted(() => ({ keys: null as null | Set<string> }))
vi.mock('../lib/permissions', () => ({
  usePerms: () => ({ can: (k: string) => perms.keys === null || perms.keys.has(k), isOwner: perms.keys === null }),
}))

import { LeasesPage, NeverMovedInModal, DISCARD_BECAME_SIGNED_NOTE } from './LeasesPage'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

/** What GET /leases/:id/never-moved-in answers, as the server sends it. */
const applies = (o: Record<string, unknown> = {}) => ({
  applies: true, words: null, status: 'active', start_date: '2026-09-24',
  lines: [
    { payment_id: 'p1', label: 'Rent', amount: 1000, due_date: '2026-10-01', utility: false },
    { payment_id: 'p2', label: 'Security deposit', amount: 500, due_date: '2026-10-01', utility: false },
  ],
  total: 1500,
  household: { tenant_names: ['Kim Harland'], unit_number: 'RV 22', property_name: 'Oak Park' },
  ...o,
})
// The server-shaped answer reaches the page camelCased — this is what it reads.
expect((camelizeKeys(applies()) as any).household.tenantNames).toEqual(['Kim Harland'])
const PAID_WORDS = '$500.00 was already paid on this lease, so it can’t be closed as if nothing happened. ' +
  'Use Change → “They’re leaving on…” on the Leases page, then Change → Move out — the move-out settles what they paid and returns what is theirs.'

let host: HTMLDivElement
let root: Root
let closed = 0
beforeEach(() => {
  server.answers = [applies()]; server.gets = 0; server.posts = []; server.postFail = null; server.hold = null; server.postAnswer = null
  server.leases = []; server.leaseGets = 0; perms.keys = null
  toasts.length = 0; closed = 0
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
async function until(check: () => boolean, what: string) {
  for (let i = 0; i < 150; i++) {
    if (check()) return
    await act(async () => { await new Promise(r => setTimeout(r, 10)) })
  }
  throw new Error(`timed out waiting for ${what}; screen: ${text()}`)
}
/**
 * Fix pass 2 (review): pages NOT on screen, cached the way the app caches them
 * — the dashboard under DashboardPage's real key, its to-dos, a Schedule
 * range, its history, the Payments ledger. Each counts its reads.
 */
const OFFSCREEN_KEYS: any[] = [['dashboard', '', 'received'], 'landlord-todos', ['schedule', '2026-10-01', '2026-10-31', 'all', ''], 'schedule-history', ['payments-ledger', 'current']]
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
  await act(async () => {
    root.render(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <NeverMovedInModal lease={{ id: 'lease1', unitNumber: 'RV 22', propertyName: 'Oak Park' }} onClose={() => { closed++ }} />
        </MemoryRouter>
      </QueryClientProvider>)
  })
  await until(() => !text().includes('Reading what this lease owes'), 'the fresh read')
}
async function click(el: Element | undefined) {
  if (!el) throw new Error(`nothing to click; screen: ${text()}`)
  await act(async () => { (el as HTMLElement).click() })
}
const count = (s: string) => text().split(s).length - 1

describe('They never moved in — end the lease', () => {
  it('reads what would be zeroed when it opens and lists it by name — who, each line, the total — with one gold button', async () => {
    await open()
    expect(server.gets).toBe(1)
    expect(host.querySelector('[data-testid="nmi-who"]')?.textContent).toBe('Kim Harland — RV 22, Oak Park')
    const zeroed = host.querySelector('[data-testid="nmi-zeroed"]')!.textContent!
    expect(zeroed).toContain('Rent · due Oct 1, 2026$1,000.00')
    expect(zeroed).toContain('Security deposit · due Oct 1, 2026$500.00')
    expect(zeroed).toContain('No longer owed$1,500.00')
    expect(zeroed).toContain('The tenant never paid or moved in, so ending the lease zeroes their unpaid move-in bill:')
    expect(zeroed).toContain('The move-in bill is voided, the lease ends today and the household is taken off it. Lease paperwork still waiting for signatures is canceled, so it can’t be signed later. Nothing was paid toward what is zeroed, so nothing is refunded.')
    expect(host.querySelector('[data-testid="nmi-kept"]')).toBeNull()
    expect(host.querySelector('[data-testid="nmi-reservation"]')).toBeNull()
    expect(host.querySelector('[data-testid="nmi-old-lease"]')).toBeNull()
    const go = button(/End the lease/)
    expect(go?.textContent).toBe('End the lease — $1,500.00 no longer owed')
    expect(go?.className).toContain('btn-primary')
    expect(button(/^Cancel$/)?.className).toContain('btn-ghost')
  })

  it('ending it sends the total the window showed, says what happened, and closes', async () => {
    await open()
    await click(button(/End the lease/))
    await until(() => closed === 1, 'the window to close')
    expect(server.posts).toEqual([{ url: '/leases/lease1/never-moved-in', body: { expectedTotal: 1500 } }])
    expect(toasts).toEqual(['Lease ended. The $1,500.00 move-in bill they never paid is no longer owed.'])
  })

  it('what the lease owes changed: the 409 is said once and the window reads it again in place, with the new total on the button', async () => {
    const changed = 'What this lease owes changed since you opened this, so nothing was closed. The window now shows what would be zeroed — check it and confirm again.'
    server.answers = [applies(), applies({ total: 1525, lines: [...applies().lines, { payment_id: 'p3', label: 'Late fee', amount: 25, due_date: '2026-10-06', utility: false }] })]
    server.postFail = { status: 409, error: changed }
    await open()
    await click(button(/End the lease/))
    await until(() => server.gets === 2, 'the read again')
    await until(() => button(/End the lease/)?.textContent === 'End the lease — $1,525.00 no longer owed', 'the new total')
    expect(count(changed)).toBe(1)
    expect(closed).toBe(0)
    await click(button(/End the lease/))
    await until(() => closed === 1, 'the window to close')
    expect(server.posts[1].body).toEqual({ expectedTotal: 1525 })
  })

  // Fix pass 3: the window stays open while the close runs, so what comes
  // back (a refusal, a 409) is shown — never set on a window already gone.
  it('a click outside, × or Cancel while ending does not close the window, and a 409 that comes back is still said once', async () => {
    const changed = 'What this lease owes changed since you opened this, so nothing was closed. The window now shows what would be zeroed — check it and confirm again.'
    let release!: () => void
    server.hold = new Promise<void>((r) => { release = r })
    server.postFail = { status: 409, error: changed }
    await open()
    await click(button(/End the lease/))
    await until(() => button(/Ending…/) !== undefined, 'the request to start')
    await click(host.querySelector('.modal-overlay')!)
    await click(host.querySelector('button[aria-label="Close"]')!)
    await click(button(/^Cancel$/))
    expect(closed).toBe(0)
    expect(host.querySelector('[role="dialog"]')).not.toBeNull()
    await act(async () => { release() })
    await until(() => count(changed) === 1, 'the 409 words')
    expect(closed).toBe(0)
    // Once it settles the window closes again as usual.
    await click(button(/^Cancel$/))
    expect(closed).toBe(1)
  })

  it('money was paid: the plain-words refusal names the real next step, said once, and only Close is offered', async () => {
    server.answers = [applies(), { ...applies(), applies: false, words: PAID_WORDS, lines: [], total: 0 }]
    server.postFail = { status: 409, error: PAID_WORDS }
    await open()
    await click(button(/End the lease/))
    await until(() => !!host.querySelector('[data-testid="nmi-refusal"]'), 'the refusal')
    expect(count(PAID_WORDS)).toBe(1)
    expect(button(/End the lease/)).toBeUndefined()
    expect(button(/^Close$/)).toBeTruthy()
  })

  it('a lease it does not apply to from the start: the refusal, no gold button, Close backs out with nothing sent', async () => {
    server.answers = [{ ...applies(), applies: false, words: PAID_WORDS, lines: [], total: 0 }]
    await open()
    expect(host.querySelector('[data-testid="nmi-refusal"]')?.textContent).toBe(PAID_WORDS)
    expect(button(/End the lease/)).toBeUndefined()
    await click(button(/^Close$/))
    expect(closed).toBe(1)
    expect(server.posts).toHaveLength(0)
  })

  it('Cancel backs out with nothing sent', async () => {
    await open()
    await click(button(/^Cancel$/))
    expect(closed).toBe(1)
    expect(server.posts).toHaveLength(0)
  })

  it('nothing owed (the tenant signed, no bill went out): the button just ends the lease', async () => {
    server.answers = [applies({ lines: [], total: 0, status: 'pending' })]
    await open()
    expect(text()).toContain('Nothing is owed on this lease.')
    expect(text()).toContain('The lease ends today and the household is taken off it.')
    expect(button(/End the lease/)?.textContent).toBe('End the lease')
    await click(button(/End the lease/))
    await until(() => closed === 1, 'the window to close')
    expect(toasts).toEqual(['Lease ended. Nothing was owed on it.'])
  })

  // ── Step 9 final fix (fix pass 1) ──
  // Final fix (fix pass 1, decisions #53 — renamed): what stays owed is a
  // list under “Stays owed”, each line by name with why, not one sentence.
  it('GAM’s own fee stays owed: the confirm lists it under “Stays owed”, by name with why, and the total zeroed leaves it out', async () => {
    const keptWords = 'Still owed after this: GAM’s own fee, Declined-payment fee ($1.00) — ending the lease never takes it off. It stays on the household’s balance.'
    server.answers = [applies({ kept: [{ payment_id: 'p9', label: 'Declined-payment fee', amount: 1, why: 'gam_fee' }], kept_total: 1, kept_words: keptWords })]
    await open()
    expect(host.querySelector('[data-testid="nmi-kept"]')?.textContent)
      .toBe('Stays owed — on the household’s balanceDeclined-payment fee · GAM’s own fee — ending the lease never takes it off$1.00')
    expect(count('Declined-payment fee')).toBe(1)
    expect(button(/End the lease/)?.textContent).toBe('End the lease — $1,500.00 no longer owed')
  })

  it('after a close that kept GAM’s own fee, the toast (said once the window is gone) names what stays owed', async () => {
    const fee = [{ payment_id: 'p9', label: 'Declined-payment fee', amount: 1, why: 'gam_fee' }]
    server.answers = [applies({ kept: fee, kept_total: 1, kept_words: 'Still owed after this: …' })]
    server.postAnswer = { id: 'lease1', status: 'terminated', zeroed_lines: [], zeroed_total: 1500, reservation_canceled: false,
      kept: fee, kept_total: 1, kept_words: 'Still owed after this: …' }
    await open()
    await click(button(/End the lease/))
    await until(() => closed === 1, 'the window to close')
    expect(server.posts).toEqual([{ url: '/leases/lease1/never-moved-in', body: { expectedTotal: 1500 } }])
    expect(toasts).toEqual(['Lease ended. The $1,500.00 move-in bill they never paid is no longer owed. Still owed on their balance: Declined-payment fee $1.00.'])
  })

  it('nothing zeroed but GAM’s own fee left: the toast never says “Nothing was owed”', async () => {
    const fee = [{ payment_id: 'p9', label: 'Declined-payment fee', amount: 1, why: 'gam_fee' }]
    server.answers = [applies({ lines: [], total: 0, kept: fee, kept_total: 1, kept_words: 'Still owed after this: …' })]
    server.postAnswer = { id: 'lease1', status: 'terminated', zeroed_lines: [], zeroed_total: 0, reservation_canceled: false,
      kept: fee, kept_total: 1, kept_words: 'Still owed after this: …' }
    await open()
    await click(button(/^End the lease$/))
    await until(() => closed === 1, 'the window to close')
    expect(toasts).toEqual(['Lease ended. Nothing was zeroed. Still owed on their balance: Declined-payment fee $1.00.'])
  })

  // ── Fix pass 3 (review) ──
  it('nothing zeroed but GAM’s own fee left: the window never says “Nothing is owed” or “everything still owed” — it says nothing is zeroed, then what stays owed', async () => {
    const keptWords = 'Still owed after this: GAM’s own fee, Declined-payment fee ($1.00) — ending the lease never takes it off. It stays on the household’s balance.'
    server.answers = [applies({ lines: [], total: 0, kept: [{ payment_id: 'p9', label: 'Declined-payment fee', amount: 1, why: 'gam_fee' }], kept_total: 1, kept_words: keptWords })]
    await open()
    const zeroed = host.querySelector('[data-testid="nmi-zeroed"]')!.textContent!
    expect(host.querySelector('[data-testid="nmi-lead"]')?.textContent).toBe('Nothing on this lease is zeroed.')
    expect(zeroed).not.toMatch(/Nothing is owed/)
    expect(zeroed).not.toMatch(/everything still owed/)
    expect(zeroed).not.toMatch(/Nothing was paid/)
    expect(zeroed).toContain('Stays owed — on the household’s balanceDeclined-payment fee · GAM’s own fee — ending the lease never takes it off$1.00')
    expect(keptWords).toBeTruthy()
    expect(zeroed).toContain('Nothing is refunded.')
  })

  it('lines zeroed and GAM’s own fee kept: the lead says their unpaid move-in bill is zeroed and what stays owed is listed — never “everything still owed”', async () => {
    const keptWords = 'Still owed after this: GAM’s own fee, Declined-payment fee ($1.00) — ending the lease never takes it off. It stays on the household’s balance.'
    server.answers = [applies({ kept: [{ payment_id: 'p9', label: 'Declined-payment fee', amount: 1, why: 'gam_fee' }], kept_total: 1, kept_words: keptWords })]
    await open()
    const zeroed = host.querySelector('[data-testid="nmi-zeroed"]')!.textContent!
    expect(host.querySelector('[data-testid="nmi-lead"]')?.textContent)
      .toBe('The tenant never paid or moved in, so ending the lease zeroes their unpaid move-in bill:')
    expect(host.querySelector('[data-testid="nmi-kept"]')).not.toBeNull()
    expect(zeroed).not.toMatch(/everything still owed/)
    expect(zeroed).not.toMatch(/Nothing is owed/)
    expect(zeroed).toContain('Nothing was paid toward what is zeroed, so nothing is refunded.')
  })

  it('fresh at the moment of action: a GAM fee added after the window opened is named in the toast, from the close’s own answer', async () => {
    // The window opened with nothing kept; by the press a declined retry added GAM’s $1 fee.
    server.postAnswer = { id: 'lease1', status: 'terminated', zeroed_lines: [], zeroed_total: 1500, reservation_canceled: false,
      kept: [{ payment_id: 'p9', label: 'Declined-payment fee', amount: 1, why: 'gam_fee' }], kept_total: 1,
      kept_words: 'Still owed after this: GAM’s own fee, Declined-payment fee ($1.00) — ending the lease never takes it off. It stays on the household’s balance.' }
    await open()
    expect(host.querySelector('[data-testid="nmi-kept"]')).toBeNull()
    await click(button(/End the lease/))
    await until(() => closed === 1, 'the window to close')
    expect(toasts).toEqual(['Lease ended. The $1,500.00 move-in bill they never paid is no longer owed. Still owed on their balance: Declined-payment fee $1.00.'])
  })

  it('a close that canceled the reservation too: the toast says both happened (read from the answer’s data, camelCased)', async () => {
    server.answers = [applies({ reservation_words: 'The reservation it came from (Pat Guest, checking in Oct 9, 2026) still shows on the Schedule as confirmed — it is canceled with the lease, so the space is free on the Schedule.' })]
    server.postAnswer = { id: 'lease1', status: 'terminated', zeroed_lines: [], zeroed_total: 1500, reservation_canceled: true,
      kept: [], kept_total: 0, kept_words: null }
    await open()
    await click(button(/End the lease/))
    await until(() => closed === 1, 'the window to close')
    expect(toasts).toEqual(['Lease ended and its reservation canceled. The $1,500.00 move-in bill they never paid is no longer owed.'])
  })

  // ── Final fix (fix pass 1, decisions #53) ──
  it('a multi-month lease: only the move-in bill is zeroed — the later month is listed under “Stays owed” with its due day, and the toast names it as still owed', async () => {
    const later = [{ payment_id: 'p7', label: 'Rent', amount: 1000, why: 'later_bill', due_date: '2026-11-01' }]
    server.answers = [applies({ kept: later, kept_total: 1000, kept_words: 'Still owed after this: …' })]
    server.postAnswer = { id: 'lease1', status: 'terminated', zeroed_lines: [], zeroed_total: 1500, reservation_canceled: false,
      kept: later, kept_total: 1000, kept_words: 'Still owed after this: …' }
    await open()
    expect(host.querySelector('[data-testid="nmi-kept"]')?.textContent)
      .toBe('Stays owed — on the household’s balanceRent · due Nov 1, 2026 · not on the move-in bill$1,000.00')
    expect(button(/End the lease/)?.textContent).toBe('End the lease — $1,500.00 no longer owed')
    await click(button(/End the lease/))
    await until(() => closed === 1, 'the window to close')
    expect(server.posts).toEqual([{ url: '/leases/lease1/never-moved-in', body: { expectedTotal: 1500 } }])
    expect(toasts).toEqual(['Lease ended. The $1,500.00 move-in bill they never paid is no longer owed. Still owed on their balance: Rent due Nov 1, 2026 $1,000.00.'])
  })

  it('a later month kept owed says the days its rent covers (it stays owed in full — whether to cut it to the day the lease ends is Nic’s call)', async () => {
    const later = [{ payment_id: 'p7', label: 'Rent', amount: 1000, why: 'later_bill', due_date: '2026-11-01', period_start: '2026-11-01', period_end: '2026-11-30' }]
    server.answers = [applies({ kept: later, kept_total: 1000, kept_words: 'Still owed after this: …' })]
    await open()
    expect(host.querySelector('[data-testid="nmi-kept-period"]')?.textContent).toBe(' · for Nov 1, 2026 – Nov 30, 2026')
    expect(host.querySelector('[data-testid="nmi-kept"]')?.textContent)
      .toBe('Stays owed — on the household’s balanceRent · for Nov 1, 2026 – Nov 30, 2026 · due Nov 1, 2026 · not on the move-in bill$1,000.00')
  })

  it('after the close, the dashboard (its real key), its to-dos, the Leases list, the Schedule and the Payments ledger are read again — even when not on screen', async () => {
    await open()
    for (const n of Object.values(reads)) expect(n).toBe(1)
    await click(button(/End the lease/))
    await until(() => closed === 1, 'the window to close')
    await until(() => Object.values(reads).every(n => n === 2), `every page read again (${JSON.stringify(reads)})`)
  })

  it('the window’s own read failed: the error once with its next step, and Read again reads it fresh', async () => {
    server.answers = [new Error('network down'), applies()]
    await open()
    expect(count('What this lease owes could not be read, so nothing was changed. Press Read again.')).toBe(1)
    expect(button(/End the lease/)).toBeUndefined()
    // Fix pass 3 (review): Read again is the next step and the only action, so it is gold.
    expect(button(/^Read again$/)?.className).toContain('btn-primary')
    await click(button(/^Read again$/))
    await until(() => button(/End the lease/)?.textContent === 'End the lease — $1,500.00 no longer owed', 'the fresh read')
    expect(server.gets).toBe(2)
    expect(button(/^Read again$/)).toBeUndefined()
  })

  it('a lease drafted from a reservation: the confirm says the reservation is canceled with it, and the toast says both happened', async () => {
    const words = 'The reservation it came from (Pat Guest, checking in Oct 9, 2026) still shows on the Schedule as confirmed — it is canceled with the lease, so the space is free on the Schedule.'
    server.answers = [applies({ reservation_words: words })]
    await open()
    expect(host.querySelector('[data-testid="nmi-reservation"]')?.textContent).toBe(words)
    expect(text()).not.toMatch(/no-show/)
  })

  it('a lease that already ended with its bill still owed: titled “zero the bill”, says nothing else about the lease changes, and its gold button zeroes the bill', async () => {
    server.answers = [applies({ status: 'terminated', already_ended: true })]
    await open()
    expect(host.querySelector('[role="dialog"]')?.getAttribute('aria-label')).toBe('They never moved in — zero the bill')
    const zeroed = host.querySelector('[data-testid="nmi-zeroed"]')!.textContent!
    expect(zeroed).toContain('this zeroes their unpaid move-in bill')
    expect(zeroed).toContain('The move-in bill is voided. The lease already ended, so nothing else about it changes. Nothing was paid toward what is zeroed, so nothing is refunded.')
    expect(zeroed).not.toContain('the lease ends today')
    const go = button(/Zero the bill/)
    expect(go?.textContent).toBe('Zero the bill — $1,500.00 no longer owed')
    expect(go?.className).toContain('btn-primary')
    await click(go)
    await until(() => closed === 1, 'the window to close')
    expect(toasts).toEqual(['Bill closed. The $1,500.00 move-in bill they never paid is no longer owed.'])
  })

  it('access removed while the window was open: the press fails with a 403 and so does the read again — the error is said exactly once', async () => {
    const words = 'You are not assigned to this property, so you can’t end its leases. Ask the landlord to add this property to your access.'
    server.answers = [applies(), httpError(403, words)]
    server.postFail = { status: 403, error: words }
    await open()
    await click(button(/End the lease/))
    await until(() => server.gets === 2, 'the read again')
    await until(() => count(words) >= 1, 'the error')
    // Give a second render the chance to show it twice.
    await act(async () => { await new Promise(r => setTimeout(r, 30)) })
    expect(count(words)).toBe(1)
    expect(closed).toBe(0)
  })

  it('a lease that started more than a month ago: a plain warning — only use this if nobody ever lived there', async () => {
    const old = new Date(Date.now() - 75 * 86400000).toISOString().slice(0, 10)
    server.answers = [applies({ start_date: old })]
    await open()
    const note = host.querySelector('[data-testid="nmi-old-lease"]')?.textContent ?? ''
    expect(note).toMatch(/^This lease started on .+ — only use this if nobody ever lived there\. If they lived there, end it with a move-out instead\.$/)
  })

  it('a lease that started days ago (the usual case) gets no warning', async () => {
    const recent = new Date(Date.now() - 5 * 86400000).toISOString().slice(0, 10)
    server.answers = [applies({ start_date: recent })]
    await open()
    expect(host.querySelector('[data-testid="nmi-old-lease"]')).toBeNull()
  })
})

// ── Fix pass 2: the Leases list offers what the server will do ──────────────
/** A lease row as GET /leases sends it. */
const leaseRow = (o: Record<string, unknown>) => ({
  id: 'l?', status: 'pending', unit_number: 'RV 1', property_id: 'prop1', property_name: 'Oak Park',
  lease_type: 'fixed_term', start_date: '2026-10-10', end_date: '2027-10-09', rent_amount: '600.00',
  lease_source: 'esigned', signed_by_landlord: false, signed_by_tenant: false,
  tenant_signed_any: false, anyone_signed: false, supersedes_lease_id: null,
  tenants: [{ first_name: 'Pat', last_name: 'Doe', role: 'primary', status: 'active' }],
  ...o,
})
async function openList() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  await cacheOffscreenPages(qc)
  await act(async () => {
    root.render(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <LeasesPage />
        </MemoryRouter>
      </QueryClientProvider>)
  })
  await until(() => !text().includes('Loading…') && text().includes('RV'), 'the list')
}
const rowOf = (unit: string) => [...host.querySelectorAll('tbody tr')].find(tr => (tr.textContent ?? '').includes(unit)) as HTMLElement
const rowButtons = (unit: string) => [...rowOf(unit).querySelectorAll('button')].map(b => (b.textContent ?? '').trim())

describe('the Leases list: which way out a waiting lease offers', () => {
  beforeEach(() => {
    server.leases = [
      leaseRow({ id: 'draft', unit_number: 'RV 1' }),
      leaseRow({ id: 'mine', unit_number: 'RV 2', signed_by_landlord: true, anyone_signed: true }),
      // A roommate lease: the landlord and the primary signed, a co-tenant has
      // not — signed_by_tenant is still false.
      leaseRow({ id: 'roommates', unit_number: 'RV 3', signed_by_landlord: true, signed_by_tenant: false, tenant_signed_any: true, anyone_signed: true }),
    ]
  })

  it('nobody signed: Discard. Only the landlord signed: “Void on the GoldSign page”, never a Discard that can only fail. A tenant signed (even one of several): “They never moved in — end the lease”, never Discard', async () => {
    await openList()
    expect(rowButtons('RV 1')).toContain('Discard')
    expect(rowButtons('RV 1').some(b => /Void on the GoldSign page|They never moved in/.test(b))).toBe(false)
    expect(rowButtons('RV 2')).toContain('Void on the GoldSign page')
    expect(rowButtons('RV 2')).not.toContain('Discard')
    expect(rowButtons('RV 3')).toContain('They never moved in — end the lease')
    expect(rowButtons('RV 3')).not.toContain('Discard')
  })

  it('“They never moved in — end the lease” on the roommate lease opens the confirm, which reads what would be zeroed fresh', async () => {
    await openList()
    await click([...rowOf('RV 3').querySelectorAll('button')].find(b => /They never moved in/.test(b.textContent ?? '')))
    await until(() => !!host.querySelector('[data-testid="nmi-zeroed"]'), 'the confirm')
    expect(server.gets).toBe(1)
  })

  it('a tenant signed since the list was read: Discard is refused (409) — the list reads again in place and the confirm that shows what is zeroed opens instead; no error toast, nothing zeroed', async () => {
    server.postFail = { status: 409, code: 'tenant_signed',
      error: 'A tenant signed this lease, so it isn’t an unsigned draft. Use “They never moved in — end the lease” — it shows exactly what would be zeroed first.' }
    await openList()
    const before = server.leaseGets
    await click([...rowOf('RV 1').querySelectorAll('button')].find(b => (b.textContent ?? '').trim() === 'Discard'))
    await until(() => !!host.querySelector('[role="dialog"][aria-label="They never moved in — end the lease"]'), 'the confirm')
    await until(() => !!host.querySelector('[data-testid="nmi-zeroed"]'), 'the fresh read')
    expect(server.posts).toEqual([{ url: '/leases/draft/discard', body: {} }])
    expect(server.leaseGets).toBeGreaterThan(before)
    expect(toasts.filter(t => t.startsWith('error:'))).toEqual([])
  })

  it('a draft discarded: the dashboard (its real key), its to-dos, the Schedule and the Payments ledger are read again — even when not on screen', async () => {
    await openList()
    for (const n of Object.values(reads)) expect(n).toBe(1)
    await click([...rowOf('RV 1').querySelectorAll('button')].find(b => (b.textContent ?? '').trim() === 'Discard'))
    await until(() => toasts.includes('Draft discarded.'), 'the discard')
    await until(() => Object.values(reads).every(n => n === 2), `every page read again (${JSON.stringify(reads)})`)
  })

  it('the window Discard opens instead says why, once: a tenant signed since the list was read, nothing was changed', async () => {
    server.postFail = { status: 409, code: 'tenant_signed',
      error: 'A tenant signed this lease, so it isn’t an unsigned draft. Use “They never moved in — end the lease” — it shows exactly what would be zeroed first.' }
    await openList()
    await click([...rowOf('RV 1').querySelectorAll('button')].find(b => (b.textContent ?? '').trim() === 'Discard'))
    await until(() => !!host.querySelector('[data-testid="nmi-zeroed"]'), 'the fresh read')
    const note = host.querySelector('[data-testid="nmi-note"]')?.textContent
    expect(note).toBe(DISCARD_BECAME_SIGNED_NOTE)
    expect(count('A tenant signed this lease since the list was read')).toBe(1)
    // Closed and opened again from its own menu item: no leftover note.
    await click(button(/^Cancel$/))
    await until(() => !host.querySelector('[role="dialog"][aria-label="They never moved in — end the lease"]'), 'the window to close')
    server.leases = server.leases.map((l: any) => l.id === 'draft' ? { ...l, tenant_signed_any: true, anyone_signed: true } : l)
    await click([...rowOf('RV 3').querySelectorAll('button')].find(b => /They never moved in/.test(b.textContent ?? '')))
    await until(() => !!host.querySelector('[data-testid="nmi-zeroed"]'), 'the confirm')
    expect(host.querySelector('[data-testid="nmi-note"]')).toBeNull()
  })

  // Fix pass 3: any other refusal reads the list again in place, so the row
  // redraws with the right button instead of a Discard every press of which fails.
  it('the landlord signed since the list was read: Discard is refused (409) — the error is said once and the list reads again, now showing “Void on the GoldSign page”', async () => {
    const words = 'You signed this lease and the tenant hasn’t yet. Void its document on the GoldSign page instead — that takes the lease and its bill back and tells the tenant.'
    server.postFail = { status: 409, code: 'landlord_signed', error: words }
    await openList()
    const before = server.leaseGets
    // What the server now says about that lease: the landlord signed it.
    server.leases = server.leases.map((l: any) => l.id === 'draft' ? { ...l, signed_by_landlord: true, anyone_signed: true } : l)
    await click([...rowOf('RV 1').querySelectorAll('button')].find(b => (b.textContent ?? '').trim() === 'Discard'))
    await until(() => server.leaseGets > before, 'the list to read again')
    await until(() => rowButtons('RV 1').includes('Void on the GoldSign page'), 'the row to redraw')
    expect(rowButtons('RV 1')).not.toContain('Discard')
    expect(toasts.filter(t => t === `error: ${words}`)).toHaveLength(1)
  })

  it('an ended lease whose bill nothing was paid on is still owed (the server’s ended_bill_open): its Change menu offers “They never moved in — zero the bill”; an ended lease without it does not', async () => {
    server.leases = [
      leaseRow({ id: 'gone', unit_number: 'RV 4', status: 'terminated', ended_bill_open: true }),
      leaseRow({ id: 'done', unit_number: 'RV 5', status: 'terminated', ended_bill_open: false }),
    ]
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    await act(async () => {
      root.render(<QueryClientProvider client={qc}><MemoryRouter><LeasesPage /></MemoryRouter></QueryClientProvider>)
    })
    await until(() => !!button(/^History/), 'the History tab')
    await click(button(/^History/))
    await until(() => text().includes('RV 4'), 'the ended leases')
    const menuItems = async (unit: string) => {
      await click([...rowOf(unit).querySelectorAll('button')].find(b => /Change/.test(b.textContent ?? '')))
      const items = [...rowOf(unit).querySelectorAll('button')].map(b => (b.textContent ?? '').trim())
      await click(host.querySelector('div[style*="position: fixed"]') ?? undefined)
      return items
    }
    expect((await menuItems('RV 4')).some(t => t.startsWith('They never moved in — zero the bill'))).toBe(true)
    expect((await menuItems('RV 5')).some(t => t.startsWith('They never moved in'))).toBe(false)
  })

  it('the labels promise only what decisions #53 does: “zero their unpaid move-in bill” — never “zero what they never paid” (a later bill stays owed)', async () => {
    server.leases = [
      leaseRow({ id: 'roommates', unit_number: 'RV 3', signed_by_landlord: true, signed_by_tenant: false, tenant_signed_any: true, anyone_signed: true }),
      leaseRow({ id: 'live', unit_number: 'RV 6', status: 'active', signed_by_landlord: true, signed_by_tenant: true, anyone_signed: true }),
    ]
    await openList()
    const inline = [...rowOf('RV 3').querySelectorAll('button')].find(b => /They never moved in/.test(b.textContent ?? ''))!
    expect(inline.getAttribute('title')).toBe('A tenant signed but they never moved in — zero their unpaid move-in bill and end the lease (shows exactly what first)')
    await click([...rowOf('RV 6').querySelectorAll('button')].find(b => /Change/.test(b.textContent ?? '')))
    const item = [...rowOf('RV 6').querySelectorAll('button')].find(b => /They never moved in — end the lease/.test(b.textContent ?? ''))!
    expect(item.textContent).toContain('Zero their unpaid move-in bill and end it — shows exactly what first')
    expect(text()).not.toMatch(/[Zz]ero what they never paid/)
  })

  it('a team member without "Void documents" is not shown the GoldSign link', async () => {
    perms.keys = new Set(['leases.terminate'])
    await openList()
    expect(rowButtons('RV 2')).not.toContain('Void on the GoldSign page')
    expect(rowButtons('RV 2')).not.toContain('Discard')
  })
})
