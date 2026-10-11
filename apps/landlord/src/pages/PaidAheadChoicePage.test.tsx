// @vitest-environment jsdom
/**
 * 10/4 (decisions #46.1) — the landlord's screen for money paid ahead left on
 * an ended lease. The server decides every figure and choice
 * (routes/paidAheadChoice); this page shows them and sends the choice.
 *
 * Review fix pass 3: the REAL responses are captured by
 * services/paidAheadChoice.test.ts into __fixtures__/paidAheadChoice.real.json
 * (ids and instants made stable). The last block here drives the page on
 * them, and the small hand-made fixtures above it are checked to use only
 * fields the real responses carry — so a field the server renames fails here.
 *
 * Staff-screen rules checked here: the confirm says what it does; fresh at the
 * moment of action (a 409 shows the server's latest in place and the next
 * press is a NEW press, with a new key); each error is said once with the next
 * step; Back writes nothing; a refund that did not go out is offered Try again
 * on its own line (once).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from 'react-query'
import { MemoryRouter, Route, Routes } from 'react-router-dom'

process.env.TZ = 'America/Phoenix'

const server = vi.hoisted(() => ({
  views: [] as any[],             // GET answers for the screen, in order (the last one repeats)
  gets: 0,
  getFail: null as null | { status: number; error: string },
  previews: new Map<string, any>(),  // amount → preview answer
  previewDelayMs: new Map<string, number>(),  // amount → how long its answer takes
  previewFail: null as null | { status: number; error: string },
  posts: [] as Array<{ url: string; body: any }>,
  postDelayMs: 0,
  postAnswers: [] as Array<{ ok: any } | { fail: { status: number; error: string; code?: string; data?: any; raw?: string } } | { network: true }>,
}))
const httpError = (status: number, error: string, extra: Record<string, unknown> = {}) =>
  Object.assign(new Error(error), { response: { status, data: { success: false, error, ...extra } } })

vi.mock('../lib/api', () => ({
  apiGet: async (url: string) => {
    if (url.includes('/refund-preview?amount=')) {
      if (server.previewFail) throw httpError(server.previewFail.status, server.previewFail.error)
      const amount = url.split('amount=')[1]
      const p = server.previews.get(amount)
      if (!p) throw new Error(`no preview for ${amount}`)
      const wait = server.previewDelayMs.get(amount) ?? 0
      if (wait) await new Promise((r) => setTimeout(r, wait))
      return p
    }
    if (!url.endsWith('/paid-ahead-choice')) throw new Error(`unexpected GET ${url}`)
    if (server.getFail) throw httpError(server.getFail.status, server.getFail.error)
    const v = server.views[Math.min(server.gets, server.views.length - 1)]
    server.gets++
    return v
  },
  apiPost: async (url: string, body?: any) => {
    server.posts.push({ url, body })
    const a = server.postAnswers.shift()
    if (!a) throw new Error(`unexpected POST ${url}`)
    if (server.postDelayMs) await new Promise((r) => setTimeout(r, server.postDelayMs))
    if ('network' in a) throw new Error('Network Error')   // no answer at all: no response on the error
    // A proxy's own page (Cloudflare's 502/524): a body that is not the server's JSON.
    if ('fail' in a && a.fail.raw !== undefined) throw Object.assign(new Error('Request failed'), { response: { status: a.fail.status, data: a.fail.raw } })
    if ('fail' in a) throw httpError(a.fail.status, a.fail.error, { code: a.fail.code, data: a.fail.data })
    return { success: true, data: a.ok }
  },
}))

import { PaidAheadChoicePage } from './PaidAheadChoicePage'
import real from './__fixtures__/paidAheadChoice.real.json'
import states from './__fixtures__/paidAheadChoice.states.real.json'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const MO = 'Money order · Sep 3'
/** The screen as GET /api/leases/:id/paid-ahead-choice answers it: $40 paid ahead by money order, the landlord has it. */
const viewOf = (o: Record<string, unknown> = {}) => ({
  leaseId: 'lease1', unit: { id: 'u1', number: 'MH 08' }, property: { id: 'p1', name: 'Oak Park' },
  tenants: [{ id: 't1', name: 'Glenda Ross' }], leaseStatus: 'expired', endedOn: '2026-09-30', ended: true,
  left: 40,
  credits: [{ id: 'c1', amount: 40, howPaid: MO, receivedOn: '2026-09-03', gamHeld: false, refundAnswered: false }],
  sources: [{ key: 'c1:r1', kind: 'money_order', label: MO, refundable: 40 }],
  maxRefund: 40, refundAnswered: 0, refundNotes: [], owedOnLease: 0, waits: null,
  refundOptions: [
    { choice: 'no_refund', label: 'No refund', result: 'Nothing goes back. You choose next what happens to the $40.00.' },
    { choice: 'refund_all', label: 'Refund the unused days ($40.00)', result: `$40.00 back at the desk — they paid by money order (${MO}); you are told to give it back after you confirm`,
      refund: { amount: 40, cost: null, parts: [{ kind: 'money_order', label: MO, amount: 40, words: `$40.00 back at the desk — they paid by money order (${MO}); you are told to give it back after you confirm` }],
        rest: 0, restOptions: [] } },
    { choice: 'refund_other', label: 'Refund a different amount', result: 'Type any amount up to $40.00. You choose next what happens to the rest.' },
  ],
  restOptions: [
    { choice: 'keep', label: 'Keep it', result: '$40.00 becomes your money — you already have it, so it is recorded as yours' },
    { choice: 'credit', label: 'Leave it as their credit', result: '$40.00 stays theirs as money paid ahead — if they rent from you again it pays their bills there, and it cannot be taken back later. You already have it, and you hold it for them.' },
  ],
  latest: null, quoteToken: 'q1',
  ...o,
})
/** A decision as the API sums it up (decided 6:30pm Phoenix on Oct 4 = 01:30 UTC Oct 5). */
const decided = (o: Record<string, unknown> = {}) => ({
  id: 'pc1', refundChoice: 'no_refund', refundChoiceLabel: 'No refund', restChoice: 'keep', restChoiceLabel: 'Keep it',
  leftAmount: 40, refundTotal: 0, restAmount: 40, releasedAmount: 0, leftGamHeld: 0, decidedBy: 'Test Landlord',
  decidedAt: '2026-10-05T01:30:00.000Z', decidedOn: 'October 4, 2026 at 6:30 PM', parts: [], words: ['$40.00 is now your money (you already had it).'],
  ...o,
})
const decidedView = (o: Record<string, unknown> = {}) => viewOf({ left: 0, credits: [], sources: [], maxRefund: 0, refundOptions: [], restOptions: [], latest: decided(o) })

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  // A press whose answer was lost is kept per lease in session storage (choice46d fix pass 3): every test starts clean.
  window.sessionStorage.clear()
  server.views = [viewOf()]; server.gets = 0; server.getFail = null
  server.previews = new Map(); server.previewDelayMs = new Map(); server.previewFail = null
  server.posts = []; server.postAnswers = []; server.postDelayMs = 0
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
async function open(waitFor = 'Money paid ahead') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  await act(async () => {
    root.render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={['/leases/lease1/paid-ahead-choice']}>
          <Routes>
            <Route path="/leases/:leaseId/paid-ahead-choice" element={<PaidAheadChoicePage />} />
            <Route path="/leases" element={<div>The leases list</div>} />
            <Route path="/leases/:id/deposit-return" element={<div>The deposit return page</div>} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>)
  })
  await until(() => text().includes(waitFor) && !text().includes('Loading…'), 'the page')
}
async function click(el: Element | undefined) {
  if (!el) throw new Error(`nothing to click; screen: ${text()}`)
  await act(async () => { (el as HTMLElement).click() })
}
async function type(value: string) {
  const input = host.querySelector('input') as HTMLInputElement
  if (!input) throw new Error('no amount box')
  await act(async () => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    set.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('Money paid ahead: the server\'s choices, shown and sent', () => {
  it('shows the tenant, the space, the money and how it was paid, and the three refund choices', async () => {
    await open()
    expect(text()).toContain('Glenda Ross · MH 08 · Oak Park')
    expect(text()).toContain('$40.00 paid ahead is still on this lease')
    expect(text()).toContain(`$40.00 — ${MO} (you have it)`)
    expect(button(/^No refund/)).toBeTruthy()
    expect(button(/^Refund the unused days \(\$40\.00\)/)).toBeTruthy()
    expect(button(/^Refund a different amount/)).toBeTruthy()
  })

  it('No refund, then Keep it: the confirm names the action and sends the choice with the figures it showed', async () => {
    server.views = [viewOf(), decidedView()]
    server.postAnswers = [{ ok: { leaseId: 'lease1', choice: decided(), words: decided().words, next: 'done' } }]
    await open()
    await click(button(/^No refund/))
    expect(text()).toContain('What happens to the $40.00 that is not refunded?')
    // Nothing can be confirmed until the rest is decided.
    expect(button(/^Confirm$/)?.disabled).toBe(true)
    await click(button(/^Keep it/))
    const confirm = button(/^Keep \$40\.00$/)
    expect(confirm?.disabled).toBe(false)
    expect(confirm?.className).toContain('btn-primary')
    await click(confirm)
    await until(() => text().includes('$40.00 is now your money (you already had it).'), 'the result')
    expect(server.posts).toHaveLength(1)
    expect(server.posts[0].url).toBe('/leases/lease1/paid-ahead-choice')
    expect(server.posts[0].body).toEqual({ refundChoice: 'no_refund', refundAmount: null, restChoice: 'keep', quoteToken: 'q1',
      idempotencyKey: expect.any(String) })
    expect(text()).toContain('Done by Test Landlord on October 4, 2026')
  })

  it('a 409 "already decided": the decided card in place, the reason said once, no choice buttons', async () => {
    const why = 'Test Landlord already decided this on Oct 4: No refund, then Keep it. Nothing else was changed.'
    server.postAnswers = [{ fail: { status: 409, error: why, code: 'already_decided', data: decidedView() } }]
    await open()
    await click(button(/^Refund the unused days/))
    await click(button(/^Refund \$40\.00$/))
    await until(() => text().includes(why), 'the reason')
    expect(count(why)).toBe(1)
    expect(text()).toContain('Decided by Test Landlord on October 4, 2026')
    expect(text()).toContain('$40.00 is now your money (you already had it).')
    expect(button(/^No refund/)).toBeUndefined()
    expect(button(/^Keep it/)).toBeUndefined()
  })

  it('a 409 "changed": the new figures in place, and the next press is a new press with a new key and the new figures', async () => {
    const why = 'The money paid ahead on this lease changed a moment ago, so nothing was saved. The latest is shown now — look it over and choose again.'
    const fresh = viewOf({
      left: 50, quoteToken: 'q2',
      refundOptions: viewOf().refundOptions.map((o: any) => o.choice === 'no_refund' ? { ...o, result: 'Nothing goes back. You choose next what happens to the $50.00.' } : o),
      restOptions: [
        { choice: 'keep', label: 'Keep it', result: '$50.00 becomes your money — you already have it, so it is recorded as yours' },
        { choice: 'credit', label: 'Leave it as their credit', result: '$50.00 stays theirs as money paid ahead — if they rent from you again it pays their bills there, and it cannot be taken back later. You already have it, and you hold it for them.' },
      ],
    })
    server.postAnswers = [
      { fail: { status: 409, error: why, code: 'paid_ahead_changed', data: fresh } },
      { ok: { leaseId: 'lease1', choice: decided({ leftAmount: 50, restAmount: 50, words: ['$50.00 is now your money (you already had it).'] }), words: [], next: 'done' } },
    ]
    server.views = [viewOf(), decidedView()]
    await open()
    await click(button(/^No refund/))
    await click(button(/^Keep it/))
    await click(button(/^Keep \$40\.00$/))
    await until(() => text().includes(why), 'the reason')
    expect(count(why)).toBe(1)
    expect(text()).toContain('$50.00 paid ahead is still on this lease')
    // The choice it still offers stays picked; the confirm reads the new figure.
    const again = button(/^Keep \$50\.00$/)
    expect(again).toBeTruthy()
    await click(again)
    await until(() => server.posts.length === 2, 'the second press')
    expect(server.posts[1].body.quoteToken).toBe('q2')
    expect(server.posts[1].body.idempotencyKey).not.toBe(server.posts[0].body.idempotencyKey)
  })

  it('a wait the server reports at the moment of action is said once (as the wait), with the button to go finish it', async () => {
    const words = 'This lease\'s move-out is still being worked out. Finish the deposit return first — what is paid ahead may be needed for the move-out bill — then come back here.'
    const waiting = viewOf({ waits: { words, href: '/leases/lease1/deposit-return', linkLabel: 'Open the deposit return' }, refundOptions: [], restOptions: [] })
    server.postAnswers = [{ fail: { status: 409, error: words, code: 'paid_ahead_changed', data: waiting } }]
    await open()
    await click(button(/^No refund/))
    await click(button(/^Keep it/))
    await click(button(/^Keep \$40\.00$/))
    await until(() => text().includes('Open the deposit return'), 'the wait')
    expect(count(words)).toBe(1)
    await click(button(/^Open the deposit return/))
    await until(() => text().includes('The deposit return page'), 'the deposit return')
  })

  it('without "Issue refunds": the permission sentence on load, said once, and nothing to press but Back', async () => {
    const perm = 'Deciding what happens to money paid ahead needs the "Issue refunds" permission, and nothing was changed. Ask the account owner to turn it on for you in My Team.'
    server.getFail = { status: 403, error: perm }
    await open(perm)
    expect(count(perm)).toBe(1)
    // A permission refusal is not something pressing again can fix: no Try again.
    expect([...host.querySelectorAll('button')].map((b) => b.textContent?.trim())).toEqual(['Back to leases'])
  })

  it('a page that could not load (no answer): said in plain words, with Try again that loads it in place', async () => {
    server.getFail = { status: 502, error: undefined as any }
    await open('could not be loaded')
    expect(count('This page could not be loaded just now. Check the connection, then press Try again.')).toBe(1)
    server.getFail = null
    await click(button(/^Try again$/))
    await until(() => text().includes('$40.00 paid ahead is still on this lease'), 'the page')
  })

  it('Back writes nothing', async () => {
    await open()
    await click(button(/^No refund/))
    await click(button(/^Keep it/))
    const backs = [...host.querySelectorAll('button')].filter((b) => /Back to leases/.test(b.textContent ?? ''))
    await click(backs[backs.length - 1])
    await until(() => text().includes('The leases list'), 'the leases list')
    expect(server.posts).toEqual([])
  })

  it('Refund a different amount: a bad amount is said once under the box; a preview the server refuses is said, never a silent disabled button', async () => {
    await open()
    await click(button(/^Refund a different amount/))
    await type('0')
    expect(count('Type how much to refund (more than $0.00).')).toBe(1)
    expect(button(/^Refund \$0\.00$/)?.disabled).toBe(true)
    await type('41')
    expect(text()).toContain('That is more than can be refunded — $40.00 at most.')
    // More than two places after the point is said as that — not as "more than $0.00".
    await type('12.345')
    expect(count('Use dollars and cents, like 12.34.')).toBe(1)
    expect(count('Type how much to refund (more than $0.00).')).toBe(0)
    server.previewFail = { status: 400, error: 'That is more than can be refunded — $30.00 at most.' }
    await type('35')
    await until(() => text().includes('$30.00 at most.'), 'the preview refusal')
    expect(count('That is more than can be refunded — $30.00 at most.')).toBe(1)
    expect(button(/^Refund \$35\.00$/)?.disabled).toBe(true)
  })

  it('Refund a different amount + Leave it as their credit: the preview\'s figures and rest choices, and the amount goes with the choice', async () => {
    server.previews.set('25', {
      amount: 25, cost: null, rest: 15,
      parts: [{ kind: 'money_order', label: MO, amount: 25, words: `$25.00 back at the desk — they paid by money order (${MO}); you are told to give it back after you confirm` }],
      restOptions: [
        { choice: 'keep', label: 'Keep it', result: '$15.00 becomes your money — you already have it, so it is recorded as yours' },
        { choice: 'credit', label: 'Leave it as their credit', result: '$15.00 stays theirs as money paid ahead — if they rent from you again it pays their bills there, and it cannot be taken back later. You already have it, and you hold it for them.' },
      ],
    })
    server.postAnswers = [{ ok: { leaseId: 'lease1', choice: decided({ refundChoice: 'refund_other', refundChoiceLabel: 'Refund a different amount', restChoice: 'credit', restChoiceLabel: 'Leave it as their credit', refundTotal: 25, restAmount: 15, words: [] }), words: [], next: 'done' } }]
    server.views = [viewOf(), decidedView()]
    await open()
    await click(button(/^Refund a different amount/))
    await type('25')
    await until(() => text().includes('What happens to the $15.00 that is not refunded?'), 'the preview')
    expect(text()).toContain(`$25.00 back at the desk — they paid by money order (${MO}); you are told to give it back after you confirm`)
    await click(button(/^Leave it as their credit/))
    await click(button(/^Refund \$25\.00 and leave \$15\.00 as their credit$/))
    await until(() => server.posts.length === 1, 'the press')
    expect(server.posts[0].body).toMatchObject({ refundChoice: 'refund_other', refundAmount: 25, restChoice: 'credit' })
  })

  it('a card refund that did not go out — failed, or still "sending" after 10 minutes — is offered Try again on its own line, said once', async () => {
    const failure = 'Stripe could not send this refund just now — press Try again, or give it back in cash instead.'
    server.views = [viewOf({
      left: 0, credits: [], sources: [], maxRefund: 0, refundOptions: [], restOptions: [],
      latest: decided({ refundChoice: 'refund_all', refundChoiceLabel: 'Refund the unused days', restChoice: null, restChoiceLabel: null,
        refundTotal: 40, restAmount: 0, words: [],
        parts: [
          { id: 'rp1', kind: 'card', label: 'Card · Sep 3', amount: 20, status: 'failed', words: '$20.00 could not be refunded to the card yet — press Try again', failure, stale: false, attention: true, retry: true, cashInstead: true },
          { id: 'rp2', kind: 'card', label: 'Card · Sep 1', amount: 20, status: 'pending', words: '$20.00 to the card has not gone out yet — press Try again', failure: null, stale: true, attention: true, retry: true, cashInstead: false },
        ] }),
    }), decidedView({ refundChoice: 'refund_all', refundChoiceLabel: 'Refund the unused days', restChoice: null, restChoiceLabel: null, words: ['$40.00 back to the card they paid with (Card · Sep 3) — sent.'] })]
    server.postAnswers = [{ ok: { leaseId: 'lease1', choice: decided({ words: ['$20.00 back to the card they paid with (Card · Sep 3) — sent.'] }), words: [], next: 'done' } }]
    await open()
    expect(count(failure)).toBe(1)
    expect(count('could not be refunded to the card yet')).toBe(0)
    expect(count('$20.00 to the card has not gone out yet — press Try again')).toBe(1)
    const tries = [...host.querySelectorAll('button')].filter((b) => /^Try again$/.test(b.textContent?.trim() ?? ''))
    expect(tries).toHaveLength(2)
    // Only the failed one can be handed back in cash (one still being sent cannot).
    expect([...host.querySelectorAll('button')].filter((b) => /^Give it back in cash instead$/.test(b.textContent?.trim() ?? ''))).toHaveLength(1)
    await click(tries[0])
    await until(() => server.posts.length === 1, 'the retry')
    expect(server.posts[0].url).toBe('/leases/lease1/paid-ahead-choice/parts/rp1/retry')
  })

  it('Refund a different amount: a preview answer that comes back after the amount changed is dropped — the cost, the rest and Confirm are always for the amount in the box', async () => {
    const preview = (amount: number) => ({
      amount, cost: null, rest: 40 - amount,
      parts: [{ kind: 'money_order', label: MO, amount, words: `Give back $${amount.toFixed(2)} — they paid by money order (${MO})` }],
      restOptions: [
        { choice: 'keep', label: 'Keep it', result: `$${(40 - amount).toFixed(2)} becomes your money` },
        { choice: 'credit', label: 'Leave it as their credit', result: `$${(40 - amount).toFixed(2)} stays theirs as money paid ahead` },
      ],
    })
    server.previews.set('1', preview(1)); server.previewDelayMs.set('1', 700)
    server.previews.set('10', preview(10)); server.previewDelayMs.set('10', 100)
    await open()
    await click(button(/^Refund a different amount/))
    await type('1')
    // Its preview request goes out (after the 250ms pause) but has not answered yet…
    await act(async () => { await new Promise((r) => setTimeout(r, 300)) })
    await type('10')
    // …nothing is confirmable until the answer for $10.00 arrives.
    expect(button(/^Refund \$10\.00/)?.disabled).toBe(true)
    await until(() => text().includes('What happens to the $30.00 that is not refunded?'), 'the $10 preview')
    // The late $1 answer lands now, and is ignored.
    await act(async () => { await new Promise((r) => setTimeout(r, 600)) })
    expect(text()).toContain('What happens to the $30.00 that is not refunded?')
    expect(text()).not.toContain('$39.00')
    await click(button(/^Keep it/))
    expect(button(/^Refund \$10\.00 and keep \$30\.00$/)?.disabled).toBe(false)
  })

  it('the decision\'s time is the property\'s, as the server names it — never this browser\'s own day', async () => {
    // Decided 01:30 UTC Oct 5: Oct 4 in this browser (Phoenix), Oct 5 at a property in another time zone.
    server.views = [decidedView({ decidedAt: '2026-10-05T01:30:00.000Z', decidedOn: 'October 5, 2026 at 9:30 AM' })]
    await open()
    expect(text()).toContain('Decided by Test Landlord on October 5, 2026 at 9:30 AM')
    expect(text()).not.toContain('October 4')
  })

  it('while one refund is being tried again, only its own button says so', async () => {
    server.views = [viewOf({
      left: 0, credits: [], sources: [], maxRefund: 0, refundOptions: [], restOptions: [],
      latest: decided({ refundChoice: 'refund_all', refundChoiceLabel: 'Refund the unused days', restChoice: null, restChoiceLabel: null,
        refundTotal: 40, restAmount: 0, words: [],
        parts: [
          { id: 'rp1', kind: 'card', label: 'Card · Sep 3', amount: 20, status: 'failed', words: 'w1', failure: 'f1', stale: false, attention: true, retry: true, cashInstead: true },
          { id: 'rp2', kind: 'card', label: 'Card · Sep 1', amount: 20, status: 'failed', words: 'w2', failure: 'f2', stale: false, attention: true, retry: true, cashInstead: true },
        ] }),
    })]
    server.postDelayMs = 300
    server.postAnswers = [{ ok: { leaseId: 'lease1', choice: decided(), words: [], next: 'done' } }]
    await open()
    const tries = () => [...host.querySelectorAll('button')].filter((b) => /^(Try again|Sending…)$/.test(b.textContent?.trim() ?? ''))
    await act(async () => { (tries()[0] as HTMLElement).click() })
    expect(tries().map((b) => b.textContent?.trim())).toEqual(['Sending…', 'Try again'])
    // "Give it back in cash instead" is an action: gold, like every action.
    expect([...host.querySelectorAll('button')].filter((b) => /Give it back in cash instead/.test(b.textContent ?? '')).every((b) => b.className.includes('btn-primary'))).toBe(true)
    await until(() => server.posts.length === 1 && !text().includes('Sending…'), 'the retry')
  })

  it('a 409 that carries no fresh page still refetches it in place (never "reload"), and the next press is a new press', async () => {
    const why = 'This page was out of date, so nothing was saved. The latest is shown now — look it over and choose again.'
    server.views = [viewOf(), viewOf({ quoteToken: 'q3' })]
    server.postAnswers = [{ fail: { status: 409, error: why } }, { ok: { leaseId: 'lease1', choice: decided(), words: decided().words, next: 'done' } }]
    await open()
    await click(button(/^No refund/))
    await click(button(/^Keep it/))
    await click(button(/^Keep \$40\.00$/))
    await until(() => text().includes(why) && server.gets >= 2, 'the refetch')
    expect(count(why)).toBe(1)
    await click(button(/^Keep \$40\.00$/))
    await until(() => server.posts.length === 2, 'the second press')
    expect(server.posts[1].body.quoteToken).toBe('q3')
    expect(server.posts[1].body.idempotencyKey).not.toBe(server.posts[0].body.idempotencyKey)
  })

  it('money that cannot be refunded from here is said once, and Keep it / Leave it as their credit are still offered', async () => {
    const note = '$200.00 has no payment GAM can send it back to, so it cannot be refunded from here. You can keep it or leave it as their credit.'
    server.views = [viewOf({
      left: 200, maxRefund: 0, refundNotes: [note],
      credits: [{ id: 'c1', amount: 200, howPaid: 'Paid ahead Sep 3 — no payment on file to send it back to', receivedOn: '2026-09-03', gamHeld: true, refundAnswered: false }],
      refundOptions: [{ choice: 'no_refund', label: 'No refund', result: 'Nothing goes back. You choose next what happens to the $200.00.' }],
      restOptions: [
        { choice: 'keep', label: 'Keep it', result: '$200.00 becomes your money — $200.00 that GAM holds is added to your next payout' },
        { choice: 'credit', label: 'Leave it as their credit', result: '$200.00 stays theirs as money paid ahead.' },
      ],
    })]
    await open()
    expect(text()).toContain('None of it can be refunded from here.')
    expect(count(note)).toBe(1)
    expect(button(/^Refund/)).toBeUndefined()
    await click(button(/^No refund/))
    expect(button(/^Keep it/)).toBeTruthy()
    expect(button(/^Leave it as their credit/)).toBeTruthy()
  })
})


describe('review fix pass 2 (choice46b): fresh at the moment of action, every desk order in gold, waits you can check again', () => {
  const failedPart = { id: 'rp1', kind: 'card', label: 'Card · Sep 3', amount: 20, status: 'failed', words: '$20.00 could not be refunded to the card yet — press Try again',
    failure: 'Stripe could not send this refund just now — press Try again, or hand it back in cash and press "Give it back in cash instead".', stale: false,
    attention: true, retry: true, cashInstead: true }
  const refundAll = { refundChoice: 'refund_all', refundChoiceLabel: 'Refund the unused days', restChoice: null, restChoiceLabel: null, refundTotal: 20, restAmount: 0, leftAmount: 20 }
  const failedView = viewOf({ left: 0, credits: [], sources: [], maxRefund: 0, refundOptions: [], restOptions: [],
    latest: decided({ ...refundAll, words: [], parts: [failedPart] }) })
  const goldLines = () => [...host.querySelectorAll('div')].filter((d) => d.style.border.includes('var(--gold)')).map((d) => d.textContent)

  for (const [what, fail, after] of [
    ['a 404 (the refund was replaced meanwhile)', { status: 404, error: 'That refund is not on this lease any more, so nothing was changed. The page now shows the latest.' },
      { ...failedPart, kind: 'cash', status: 'handed_back', words: '$20.00 handed back in cash instead of to the card', attention: false, retry: false, cashInstead: false, failure: null }],
    ['a 409 (it is being sent to the card right now)', { status: 409, error: 'This refund is being sent to the card right now — the page shows it; nothing was handed back.' },
      { ...failedPart, status: 'pending', words: '$20.00 to the card — sending now', attention: false, retry: false, cashInstead: false, failure: null }],
  ] as const) {
    it(`after a reply, a cash press that answers ${what}: the part lines come from the refetched view — no stale Try again, cash button or open confirm, and the reason is said once`, async () => {
      server.views = [failedView, failedView, viewOf({ ...failedView, latest: decided({ ...refundAll, words: [after.words + '.'], parts: [after] }) })]
      // Try again first: Stripe is still down, so the reply still shows the part failed.
      server.postAnswers = [
        { ok: { leaseId: 'lease1', choice: decided({ ...refundAll, words: [], parts: [failedPart] }), words: [], handBack: [], next: 'try_again' } },
        { fail: fail as any },
      ]
      await open()
      await click(button(/^Try again$/))
      await until(() => server.posts.length === 1 && server.gets >= 2 && !text().includes('Sending…'), 'the retry reply')
      await click(button(/^Give it back in cash instead$/))
      await click(button(/^Give back \$20\.00 in cash$/))
      await until(() => server.posts.length === 2 && server.gets >= 3 && text().includes(fail.error), 'the refetch')
      expect(count(fail.error)).toBe(1)
      expect(button(/^Try again$/)).toBeUndefined()
      expect(button(/^Give it back in cash instead$/)).toBeUndefined()
      expect(button(/^Give back \$/)).toBeUndefined()
      expect(text()).not.toContain('Give $20.00 back in cash instead of to the card?')
      expect(text()).not.toContain('Hand back $20.00')
      expect(text()).toContain(after.words)
    })
  }

  it('every money-to-give-back-now line of the reply is in the gold box, wherever it falls — two cash parts and a check — and the record lines are not', async () => {
    const words = ['Give back $25.00 — they paid by check (Check · Sep 6).', 'Hand back $20.00 in cash now.', 'Hand back $15.00 in cash now.', '$5.00 is now your money (you already had it).']
    server.views = [viewOf(), decidedView({ words: ['$25.00 given back — they paid by check (Check · Sep 6).', '$20.00 handed back in cash.', '$15.00 handed back in cash.', words[3]] })]
    server.postAnswers = [{ ok: { leaseId: 'lease1', choice: decided({ words }), words, handBack: [true, true, true, false], next: 'done' } }]
    await open()
    await click(button(/^No refund/))
    await click(button(/^Keep it/))
    await click(button(/^Keep \$40\.00$/))
    await until(() => text().includes('Hand back $15.00 in cash now.'), 'the reply')
    expect(goldLines()).toEqual(words.slice(0, 3))
  })

  it('a wait with nowhere to go has a gold "Check again" (an action, not a back-out) that looks again in place — never a reload', async () => {
    const words = 'A payment using some of this money paid ahead is still going through. Wait for it to finish, then come back here — what is left then is shown to decide.'
    server.views = [viewOf({ waits: { words, href: null, linkLabel: null }, refundOptions: [], restOptions: [] }), viewOf()]
    await open()
    expect(count(words)).toBe(1)
    const again = button(/^Check again$/)
    expect(again?.className).toContain('btn-primary')
    expect(again?.className).not.toContain('btn-ghost')
    await click(again)
    await until(() => !!button(/^No refund/), 'the choices')
    expect(text()).not.toContain(words)
    expect(server.posts).toEqual([])
  })

  it('a refetch that fails after a press is said once, with Try again that loads it in place', async () => {
    const refunded = { ...failedPart, status: 'refunded', words: '$20.00 back to the card they paid with (Card · Sep 3) — sent', failure: null, cashInstead: false }
    server.views = [failedView, viewOf({ ...failedView, latest: decided({ ...refundAll, words: [refunded.words + '.'], parts: [refunded] }) })]
    server.postAnswers = [{ ok: { leaseId: 'lease1', choice: decided({ ...refundAll, words: [refunded.words + '.'], parts: [refunded] }), words: [refunded.words + '.'], handBack: [false], next: 'done' } }]
    await open()
    server.getFail = { status: 502, error: undefined as any }
    await click(button(/^Try again$/))
    const words = 'This page could not be loaded just now. Check the connection, then press Try again.'
    await until(() => text().includes(words), 'the load error')
    expect(count(words)).toBe(1)
    server.getFail = null
    await click(button(/^Try again$/))
    await until(() => !text().includes(words), 'the page')
    expect(text()).toContain('$20.00 back to the card they paid with (Card · Sep 3) — sent.')
  })
})

/** Every field path an object carries ("refundOptions[].refund.rest"). */
function paths(v: unknown, at = '', out = new Set<string>()): Set<string> {
  if (Array.isArray(v)) { for (const x of v) paths(x, `${at}[]`, out); return out }
  if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) { const p = at ? `${at}.${k}` : k; out.add(p); paths(x, p, out) }
  }
  return out
}

describe('on the real responses (captured from the server)', () => {
  const r = real as any

  it('the hand-made fixtures above use only fields the server really sends', () => {
    const view = new Set([...paths(r.open), ...paths(r.sentBack), ...paths(r.conflict.body.data)])
    const extra = [...paths(viewOf()), ...paths(decidedView()), ...paths(viewOf({ latest: decided({ parts: [
      { id: 'x', kind: 'card', label: 'l', amount: 1, status: 'failed', words: 'w', failure: null, stale: false, attention: true, retry: true, cashInstead: true }] }) }))]
      .filter((p) => !view.has(p))
    expect(extra).toEqual([])
    const result = paths(r.decided)
    expect([...paths({ leaseId: 'l', choice: decided(), words: [], next: 'done' })].filter((p) => !result.has(p))).toEqual([])
    const previewShape = { amount: 1, cost: null, rest: 1, parts: [{ kind: 'k', label: 'l', amount: 1, words: 'w' }], restOptions: [{ choice: 'keep', label: 'l', result: 'r' }] }
    expect([...paths(previewShape)].filter((p) => !paths(r.preview).has(p))).toEqual([])
  })

  it('"Refund all that can go back": the rest and its choices are that refund\'s own — never the whole amount\'s — and confirm waits for the rest', async () => {
    server.views = [r.open, r.sentBack]
    server.postAnswers = [{ ok: r.decided }]
    await open()
    expect(text()).toContain('$200.00 paid ahead is still on this lease')
    expect(count(r.open.refundNotes[0])).toBe(1)
    await click(button(/^Refund all that can go back \(\$140\.00\)/))
    expect(text()).toContain('What happens to the $60.00 that is not refunded?')
    expect(text()).toContain('$60.00 becomes your money — $60.00 that GAM holds is added to your next payout')
    expect(text()).not.toContain('$200.00 becomes your money')
    expect(text()).toContain(r.open.refundOptions[1].refund.cost)
    expect(button(/^Refund \$140\.00$/)?.disabled).toBe(true)
    await click(button(/^Leave it as their credit/))
    await click(button(/^Refund \$140\.00 and leave \$60\.00 as their credit$/))
    await until(() => server.posts.length === 1, 'the press')
    expect(server.posts[0].body).toEqual({ refundChoice: 'refund_all', refundAmount: null, restChoice: 'credit', quoteToken: 'quote-token',
      idempotencyKey: expect.any(String) })
    await until(() => text().includes('Done by Test Landlord'), 'the result')
    expect(text()).toContain('Refund all that can go back, then Leave it as their credit')
    // The reply to this press: the cash as an order, first, in the gold box — said once.
    expect(count('Hand back $40.00 in cash now.')).toBe(1)
    const box = [...host.querySelectorAll('div')].find((d) => d.textContent === 'Hand back $40.00 in cash now.') as HTMLDivElement
    expect(box.style.border).toContain('var(--gold)')
  })

  it('a refund Stripe sent back: Try again, or Give it back in cash instead after one inline confirm (Cancel writes nothing) — the press comes before the hand-back, and only the reply orders it, in gold', async () => {
    server.views = [r.sentBack]
    const part = r.sentBack.latest.parts.find((p: any) => p.status === 'failed')
    await open()
    expect(count(part.failure)).toBe(1)
    await click(button(/^Give it back in cash instead$/))
    // The confirm never tells the worker to hand money over yet: GAM checks the card first.
    expect(text()).toContain('Give $103.55 back in cash instead of to the card? GAM first checks that it did not reach the card after all, then tells you to hand it over.')
    expect(text()).not.toContain('Hand back $103.55')
    expect(button(/^I handed back/)).toBeUndefined()
    await click(button(/^Cancel$/))
    expect(server.posts).toEqual([])
    await click(button(/^Give it back in cash instead$/))
    server.views = [r.sentBack, r.revisit]
    server.postAnswers = [{ ok: r.cashReply }]
    await click(button(/^Give back \$103\.55 in cash$/))
    await until(() => server.posts.length === 1, 'the press')
    expect(server.posts[0].url).toBe(`/leases/lease1/paid-ahead-choice/parts/${part.id}/cash`)
    // The real reply: the order, once, in the gold box; what was recorded beside it, not in gold.
    expect(r.cashReply.words[0]).toBe('Hand back $103.55 in cash now.')
    expect(r.cashReply.handBack.slice(0, 2)).toEqual([true, false])
    await until(() => text().includes(r.cashReply.words[0]), 'the reply')
    expect(count(r.cashReply.words[0])).toBe(1)
    const gold = [...host.querySelectorAll('div')].filter((d) => d.style.border.includes('var(--gold)')).map((d) => d.textContent)
    expect(gold).toEqual(['Hand back $103.55 in cash now.'])
    expect(count(r.cashReply.words[1])).toBe(1)
  })

  it('a later visit says money given back at the desk in the past tense — cash given instead of a card refund as recorded, by whom and when — never an order to hand it back again', async () => {
    server.views = [r.revisit]
    await open()
    expect(text()).toContain('$103.55 recorded as handed back in cash instead of to the card by Test Landlord on October 4, 2026 at 11:30 AM')
    expect(text()).toContain('$40.00 handed back in cash.')
    expect(text()).not.toMatch(/Hand back \$/)
    // No gold "hand back" box on a visit.
    expect([...host.querySelectorAll('div')].some((d) => d.style.border.includes('var(--gold)') && /handed back/.test(d.textContent ?? ''))).toBe(false)
  })

  it('a Try again that could not try (another request held that refund at that moment) says so once — never a silent no-op', async () => {
    server.views = [r.sentBack, r.sentBack]
    server.postAnswers = [{ ok: r.busyRetry }]
    await open()
    const busy = 'This refund was being worked on by another request at that same moment, so it was not sent again. Wait a moment, then press Try again.'
    expect(r.busyRetry.words).toContain(busy)
    await click(button(/^Try again$/))
    await until(() => text().includes(busy), 'the busy words')
    expect(count(busy)).toBe(1)
  })

  it('cash instead when the refund had reached the card after all: the reply says so once, before any money leaves the drawer — no order, nothing in gold', async () => {
    server.views = [r.sentBack, r.sentBack]
    const after = 'This refund had already gone to the card after all, so nothing is handed back in cash.'
    const recording = 'It is being recorded right now — wait a moment, then press Try again to finish recording it.'
    server.postAnswers = [{ ok: { ...r.busyRetry, words: [after, recording, ...r.sentBack.latest.words] } }]
    const part = r.sentBack.latest.parts.find((p: any) => p.status === 'failed')
    await open()
    await click(button(/^Give it back in cash instead$/))
    // Until the server answers, nothing on the page tells the worker to hand money over.
    expect(text()).not.toMatch(/Hand (them|back) \$103\.55/)
    await click(button(/^Give back \$103\.55 in cash$/))
    await until(() => text().includes(recording), 'the reply')
    expect(count(after)).toBe(1)
    expect(count(recording)).toBe(1)
    expect(text()).not.toMatch(/Hand back \$/)
    expect([...host.querySelectorAll('div')].some((d) => d.style.border.includes('var(--gold)'))).toBe(false)
    expect(server.posts[0].url).toBe(`/leases/lease1/paid-ahead-choice/parts/${part.id}/cash`)
  })

  it('the real 409: the decided card in place, its reason said once', async () => {
    server.views = [r.open]
    server.postAnswers = [{ fail: { status: 409, error: r.conflict.body.error, code: r.conflict.body.code, data: r.conflict.body.data } }]
    await open()
    await click(button(/^No refund/))
    await click(button(/^Keep it/))
    await click(button(/^Keep \$200\.00$/))
    await until(() => text().includes(r.conflict.body.error), 'the reason')
    expect(count(r.conflict.body.error)).toBe(1)
    expect(button(/^No refund/)).toBeUndefined()
  })

  it('a 502 with no words of its own (a proxy page) may have saved: said as "could not tell", never "nothing was saved" — and never raw "status code 502"', async () => {
    server.views = [r.open]
    await open()
    server.postAnswers = [{ fail: { status: 502, error: undefined as any } }]
    await click(button(/^No refund/))
    await click(button(/^Keep it/))
    await click(button(/^Keep \$200\.00$/))
    await until(() => text().includes('We could not tell if that saved. Press it again — it will not be done twice.'), 'the words')
    expect(text()).not.toMatch(/Network Error|status code|nothing was saved/)
  })

  it('a 4xx refusal with the server\'s own words is said as it is', async () => {
    server.views = [r.open]
    await open()
    server.postAnswers = [{ fail: { status: 400, error: 'Choose what happens to the $200.00 that is not refunded — Keep it, or Leave it as their credit — then confirm again.' } }]
    await click(button(/^No refund/))
    await click(button(/^Keep it/))
    await click(button(/^Keep \$200\.00$/))
    await until(() => text().includes('then confirm again.'), 'the words')
    expect(text()).not.toMatch(/could not tell/)
  })

  it('no answer at all (a dropped connection): it may have saved — "press it again, it will not be done twice", and the next press is the SAME press', async () => {
    server.views = [r.open]
    await open()
    server.postAnswers = [{ network: true }, { ok: r.decided }]
    await click(button(/^No refund/))
    await click(button(/^Keep it/))
    await click(button(/^Keep \$200\.00$/))
    await until(() => text().includes('We could not tell if that saved. Press it again — it will not be done twice.'), 'the words')
    expect(text()).not.toMatch(/Network Error|nothing was saved/)
    await click(button(/^Keep \$200\.00$/))
    await until(() => server.posts.length === 2, 'the second press')
    expect(server.posts[1].body.idempotencyKey).toBe(server.posts[0].body.idempotencyKey)
  })
})

describe('choice46c: a refund that can never be sent has no Try again, and a later press is never credited to who decided it', () => {
  const r = real as any
  const refundAll = { refundChoice: 'refund_all', refundChoiceLabel: 'Refund the unused days', restChoice: null, restChoiceLabel: null, refundTotal: 20, restAmount: 0, leftAmount: 20 }

  it('the real response for a refund whose register sale was already refunded at the register: no Try again and no cash button — the reason, with what to do, said once', async () => {
    server.views = [r.noRoom]
    const part = r.noRoom.latest.parts[0]
    expect(part).toMatchObject({ attention: true, retry: false, cashInstead: false })
    await open()
    expect(count(part.failure)).toBe(1)
    expect(part.failure).toMatch(/Check at the register what the tenant got back/)
    expect(button(/^Try again$/)).toBeUndefined()
    expect(button(/^Give it back in cash instead$/)).toBeUndefined()
    // The server refuses a Try again for it in the same plain words (the page never offers one).
    expect(r.noRoomRetry).toMatchObject({ status: 409, body: { error: `${part.failure} The page now shows the latest.` } })
  })

  it('the real response for a partial dispute of a refund that had not gone out: the part the dispute took back is said done once; the rest has no Try again — only "Give it back in cash instead"', async () => {
    const st = states as any
    server.views = [st.split]
    const [taken, rest] = st.split.latest.parts
    expect(taken).toMatchObject({ attention: false, retry: false, cashInstead: false })
    expect(rest).toMatchObject({ attention: true, retry: false, cashInstead: true })
    await open()
    expect(count(taken.words)).toBe(1)
    expect(count(rest.failure)).toBe(1)
    expect(rest.failure).toMatch(/Press "Give it back in cash instead" \(GAM first checks that it did not reach the card, then tells you when to hand the cash over\)\.$/)
    expect(button(/^Try again$/)).toBeUndefined()
    expect([...host.querySelectorAll('button')].filter((b) => /^Give it back in cash instead$/.test(b.textContent ?? ''))).toHaveLength(1)
    expect(button(/^Give it back in cash instead$/)?.className).toContain('btn-primary')
  })

  it('after a Try again press (a different worker, a later day), the header names the decision as a record — "Decided by …" — never "Done by" whoever decided it', async () => {
    const failed = { id: 'rp1', kind: 'card', label: 'Card · Sep 3', amount: 20, status: 'failed', words: '$20.00 could not be refunded to the card yet — press Try again',
      failure: 'Stripe could not send this refund just now — press Try again, or give it back in cash instead.', stale: false, attention: true, retry: true, cashInstead: true }
    const sent = { ...failed, status: 'refunded', words: '$20.00 back to the card they paid with (Card · Sep 3) — sent', failure: null, attention: false, retry: false, cashInstead: false }
    const before = viewOf({ left: 0, credits: [], sources: [], maxRefund: 0, refundOptions: [], restOptions: [],
      latest: decided({ ...refundAll, words: [], parts: [failed] }) })
    server.views = [before, before]
    server.postAnswers = [{ ok: { leaseId: 'lease1', choice: decided({ ...refundAll, words: [sent.words + '.'], parts: [sent] }), words: [sent.words + '.'], handBack: [false], next: 'done' } }]
    await open()
    await click(button(/^Try again$/))
    await until(() => server.posts.length === 1 && text().includes(sent.words), 'the reply')
    expect(text()).toContain('Decided by Test Landlord on October 4, 2026 at 6:30 PM')
    expect(text()).not.toContain('Done by')
  })
})

describe('choice46c fix pass 2: no cash for a refund that reached the card, "Check again" while one is being stopped, each reason once', () => {
  const r = real as any

  it('the real response for a refund that went to the card but was not recorded: its amount and "nothing is sent again", only Try again (never cash), and the press reads "Recording…" — never "Sending…"', async () => {
    const st = states as any
    const part = st.unrecorded.latest.parts[0]
    expect(part).toMatchObject({ retry: true, cashInstead: false, recordOnly: true })
    server.views = [st.unrecorded, { ...st.unrecorded, latest: st.unrecordedRetry.choice }]
    server.postAnswers = [{ ok: st.unrecordedRetry }]
    server.postDelayMs = 150
    await open()
    expect(count(part.failure)).toBe(1)
    expect(part.failure).toMatch(/^\$103\.55 went back to the card, but GAM could not finish recording it — press Try again to record it \(nothing is sent again\)\.$/)
    expect(button(/^Give it back in cash instead$/)).toBeUndefined()
    const tryAgain = button(/^Try again$/)
    expect(tryAgain?.className).toContain('btn-primary')
    await click(tryAgain)
    expect(button(/^Recording…$/)).toBeDefined()
    expect(text()).not.toContain('Sending…')
    await until(() => server.posts.length === 1 && text().includes(st.unrecordedRetry.words[0]), 'the reply')
    expect(button(/^Try again$/)).toBeUndefined()
  })

  it('the real responses for a refund being stopped (its payment was disputed while it was sending): the line says so with a gold "Check again" that looks again in place — then cash is offered', async () => {
    const st = states as any
    const part = st.stopping.latest.parts[0]
    expect(part).toMatchObject({ checkAgain: true, retry: false, cashInstead: false })
    server.views = [st.stopping, st.stopped]
    await open()
    expect(count(part.failure)).toBe(1)
    expect(button(/^Give it back in cash instead$/)).toBeUndefined()
    expect(button(/^Try again$/)).toBeUndefined()
    const again = button(/^Check again$/)
    expect(again?.className).toContain('btn-primary')
    await click(again)
    await until(() => !!button(/^Give it back in cash instead$/), 'the cash button')
    expect(text()).not.toContain(part.failure)
    expect(count(st.stopped.latest.parts[0].failure)).toBe(1)
    expect(button(/^Check again$/)).toBeUndefined()
    expect(server.posts).toEqual([])
  })

  it('the real 409 for a Try again that raced (the sale was refunded at the register after the page loaded): the reason is said once — on the refetched line, never again in the error box', async () => {
    const live = r.noRoom.latest.parts[0]
    // The page as it was before the register refund: Try again was still offered.
    const before = { ...r.noRoom, latest: { ...r.noRoom.latest, parts: [{ ...live, retry: true, failure: 'Stripe could not send this refund just now — press Try again.' }] } }
    server.views = [before, r.noRoom]
    server.postAnswers = [{ fail: { status: 409, error: r.noRoomRetry.body.error } }]
    await open()
    await click(button(/^Try again$/))
    await until(() => server.posts.length === 1 && server.gets >= 2 && text().includes(live.failure), 'the refetched line')
    expect(count('Nothing was sent to the card: this sale was already refunded at the register')).toBe(1)
    expect(text()).not.toContain('The page now shows the latest.')
    expect(button(/^Try again$/)).toBeUndefined()
  })
})

describe('choice46d: the press always comes before the hand-back, and a lost answer shows the true state', () => {
  const r = real as any
  const failedOf = (v: any) => v.latest.parts.find((p: any) => p.status === 'failed')
  const gold = () => [...host.querySelectorAll('div')].filter((d) => d.style.border.includes('var(--gold)')).map((d) => d.textContent)

  it('the real line for a card refund sent back says it in this screen\'s words: press first, GAM checks the card, then says when to hand the cash over — never "hand it back in cash and press"', async () => {
    server.views = [r.sentBack]
    const part = failedOf(r.sentBack)
    await open()
    expect(count(part.failure)).toBe(1)
    expect(part.failure).toMatch(/press "Give it back in cash instead" \(GAM first checks that it did not reach the card, then tells you when to hand the cash over\)\.$/)
    expect(text()).not.toMatch(/hand it back in cash and press/i)
    expect(text()).not.toMatch(/Hand back \$/)
  })

  it('a cash press whose answer was lost, that the server did record: the server\'s words for it, said once — recorded by you, when, and "if you have not handed it over yet" in gold; never a bare order, never only a past-tense "handed back", never "press it again" with no button', async () => {
    const part = failedOf(r.sentBack)
    const cash = r.revisit.latest.parts.find((p: any) => p.replacesPartId === part.id)
    expect(cash).toMatchObject({ kind: 'cash', status: 'handed_back', amount: 103.55, cashReplyHandBack: [true, false] })
    const mine = cash.cashReply[0]
    expect(mine).toMatch(/^This was recorded as given back in cash \(\$103\.55\) by you at .+ If you have not handed that \$103\.55 over yet, hand it back in cash now; if you have, give nothing more\.$/)
    server.views = [r.sentBack, r.revisit]
    server.postAnswers = [{ network: true }]
    await open()
    await click(button(/^Give it back in cash instead$/))
    await click(button(/^Give back \$103\.55 in cash$/))
    await until(() => text().includes(mine), 'the words')
    expect(count(mine)).toBe(1)
    expect(gold()).toEqual([mine])
    expect(text()).not.toContain('Hand back $103.55 in cash now.')
    expect(text()).not.toMatch(/Press it again|could not tell/)
    expect(button(/^Give it back in cash instead$/)).toBeUndefined()
    // Said once: a later look (Check again, a reload) is a visit, in the past tense.
    expect(server.posts).toHaveLength(1)
  })

  it('a cash press whose answer was lost before anything was saved: the button is still there, nothing is to be handed back yet, and pressing again is safe', async () => {
    server.views = [r.sentBack, r.sentBack]
    server.postAnswers = [{ network: true }]
    await open()
    await click(button(/^Give it back in cash instead$/))
    await click(button(/^Give back \$103\.55 in cash$/))
    const words = 'We could not tell if that saved, and nothing is to be handed back yet. Press "Give it back in cash instead" again — it will not be done twice.'
    await until(() => text().includes(words), 'the words')
    expect(count(words)).toBe(1)
    expect(button(/^Give it back in cash instead$/)).toBeDefined()
    expect(text()).not.toMatch(/Hand back \$/)
    expect(gold()).toEqual([])
  })

  it('a Try again whose answer was lost and that went through: says what the refund reads now — never "press Try again" with no button', async () => {
    const part = failedOf(r.sentBack)
    const sentWords = '$103.55 back to the card they paid with (Card · Sep 3) — sent'
    const after = { ...r.sentBack, latest: { ...r.sentBack.latest, parts: r.sentBack.latest.parts.map((p: any) => p.id === part.id
      ? { ...p, status: 'refunded', words: sentWords, failure: null, attention: false, retry: false, cashInstead: false }
      : p) } }
    server.views = [r.sentBack, after]
    server.postAnswers = [{ network: true }]
    await open()
    await click(button(/^Try again$/))
    await until(() => text().includes(`This refund now reads: ${sentWords}.`), 'the words')
    expect(text()).toContain('We could not tell if that went through.')
    expect(text()).not.toMatch(/Press (it|Try) again/)
    expect(button(/^Try again$/)).toBeUndefined()
  })

  it('a Try again whose answer was lost, still not sent: "press Try again — it will not be sent twice", with the button there', async () => {
    server.views = [r.sentBack, r.sentBack]
    server.postAnswers = [{ network: true }]
    await open()
    await click(button(/^Try again$/))
    const words = 'We could not tell if that went through. Press Try again — it will not be sent twice.'
    await until(() => text().includes(words), 'the words')
    expect(count(words)).toBe(1)
    expect(button(/^Try again$/)).toBeDefined()
  })

  it('a partial dispute\'s split (real): the taken-back part says its own amount only — never "Nothing more goes back" beside the cash button', async () => {
    const st = states as any
    server.views = [st.split]
    await open()
    expect(text()).toContain('so that $10.00 already went back to them')
    expect(text()).not.toMatch(/Nothing more goes back/)
    expect(button(/^Give it back in cash instead$/)).toBeDefined()
  })

  it('a record-only Try again (real reply) says it recorded what had already gone out — never "— sent." as if a second refund went', async () => {
    const st = states as any
    server.views = [st.unrecorded, { ...st.unrecorded, latest: st.unrecordedRetry.choice }]
    server.postAnswers = [{ ok: st.unrecordedRetry }]
    await open()
    await click(button(/^Try again$/))
    await until(() => text().includes('Recorded — the $103.55 had already gone back to the card; nothing was sent again.'), 'the reply')
    expect(text()).not.toMatch(/— sent\./)
  })
})

describe('choice46d fix pass 2: a cash press whose answer was lost is kept until it is settled', () => {
  const st = states as any
  const r = real as any
  const gold = () => [...host.querySelectorAll('div')].filter((d) => d.style.border.includes('var(--gold)')).map((d) => d.textContent)
  const ORDER = 'Hand back $103.55 in cash now.'
  const RECORDED = 'It is recorded as given back — nothing goes to the card. The $100.00 GAM held for them is added to your next payout.'
  const cashOf = (v: any) => v.latest.parts.find((p: any) => p.kind === 'cash')
  /** The look's words for the cash the landlord's own lost press recorded (gold), and for someone else looking (ask them; not gold). */
  const MINE = 'This was recorded as given back in cash ($103.55) by you at October 4, 2026 at 11:30 AM — GAM checked first that it did not reach the card. If you have not handed that $103.55 over yet, hand it back in cash now; if you have, give nothing more.'
  const OTHER = 'This was recorded as given back in cash ($103.55) by Test Landlord at October 4, 2026 at 11:30 AM — GAM checked first that it did not reach the card. Ask Test Landlord whether it was handed over before giving anything.'
  const STILL_THERE = 'We could not tell if that saved, and nothing is to be handed back yet. Press "Give it back in cash instead" again — it will not be done twice.'
  const press = async () => {
    await click(button(/^Give it back in cash instead$/))
    await click(button(/^Give back \$103\.55 in cash$/))
  }

  it('the real fixtures carry what the page reads: the busy 409 is coded and names Check again, and the recorded cash part carries when and by whom — gold only for the person who recorded it', () => {
    expect(st.cashBusy).toMatchObject({ status: 409, body: { code: 'refund_busy' } })
    expect(st.cashBusy.body.error).toBe('Another request is working on this refund right now, so nothing was handed back. Wait a moment, then press Check again.')
    const cash = cashOf(st.cashDone)
    expect(cash.replacesPartId).toBe(st.cashOpen.latest.parts[0].id)
    expect([cash.cashReply, cash.cashReplyHandBack]).toEqual([[MINE, RECORDED], [true, false]])
    const other = cashOf(st.cashDoneOther)
    expect([other.cashReply, other.cashReplyHandBack]).toEqual([[OTHER, RECORDED], [false, false]])
  })

  it('a 502 with a proxy\'s HTML page on a cash press the server DID record: recorded by you, when, and "if you have not handed it over yet" in gold once, then what was recorded — never a bare order, never "nothing was saved", never the past-tense line beside it', async () => {
    server.views = [st.cashOpen, st.cashDone]
    server.postAnswers = [{ fail: { status: 502, error: undefined as any, raw: '<html><body>502 Bad Gateway</body></html>' } }]
    await open()
    await press()
    await until(() => text().includes(MINE), 'the words')
    expect(gold()).toEqual([MINE])
    expect(count(MINE)).toBe(1)
    expect(text()).not.toContain(ORDER)
    expect(text()).toContain(RECORDED)
    expect(text()).not.toMatch(/nothing was saved|could not tell|Bad Gateway|handed back in cash instead of to the card/)
  })

  it('a 500 the server could not vouch for (outcome_unknown), recorded: read from the next look the same way', async () => {
    server.views = [st.cashOpen, st.cashDone]
    server.postAnswers = [{ fail: { status: 500, error: 'GAM could not tell if that went through. The page now shows the latest — look at that line again before giving anything.', code: 'outcome_unknown' } }]
    await open()
    await press()
    await until(() => text().includes(MINE), 'the words')
    expect(gold()).toEqual([MINE])
    expect(text()).not.toMatch(/could not tell/)
  })

  it('lost, still there, pressed again, "another request is working on it" (409) while the reload still shows it: the server\'s words once with Check again beside them, nothing in gold; Check again that still shows it waiting says to press the button again', async () => {
    server.views = [st.cashOpen, st.cashOpen, st.cashOpen, st.cashOpen]
    server.postAnswers = [{ network: true }, { fail: { status: 409, error: st.cashBusy.body.error, code: 'refund_busy' } }]
    await open()
    await press()
    await until(() => text().includes(STILL_THERE), 'press it again')
    expect(gold()).toEqual([])
    await press()
    await until(() => text().includes(st.cashBusy.body.error) && server.gets === 3, 'the busy words')
    expect(count(st.cashBusy.body.error)).toBe(1)
    expect(text()).not.toContain(STILL_THERE)
    expect(gold()).toEqual([])
    expect(button(/^Give it back in cash instead$/)).toBeDefined()
    // The words' own next step is on the screen, in gold (btn-primary), and looks again in place.
    const check = button(/^Check again$/)
    expect(check?.className).toContain('btn-primary')
    await click(check)
    const still = 'Nothing was handed back yet. Press "Give it back in cash instead" again — GAM checks first, so it is never done twice.'
    await until(() => text().includes(still) && server.gets === 4, 'the next step')
    expect(text()).not.toContain(st.cashBusy.body.error)
    expect(button(/^Check again$/)).toBeUndefined()
    expect(gold()).toEqual([])
  })

  it('a busy press, and then ANOTHER worker\'s press shows up recorded: who recorded it and when, and to ask them — never an order, nothing in gold', async () => {
    server.views = [st.cashOpen, st.cashDoneOther]
    server.postAnswers = [{ fail: { status: 409, error: st.cashBusy.body.error, code: 'refund_busy' } }]
    await open()
    await press()
    await until(() => text().includes(OTHER), 'who recorded it')
    expect(count(OTHER)).toBe(1)
    expect(gold()).toEqual([])
    expect(text()).not.toContain(ORDER)
    expect(text()).not.toMatch(/If you have not handed/)
    expect(text()).toContain(RECORDED)
  })

  it('a busy press, Check again, and the other worker\'s press shows up recorded on that look: the same — ask them, nothing in gold', async () => {
    server.views = [st.cashOpen, st.cashOpen, st.cashDoneOther]
    server.postAnswers = [{ fail: { status: 409, error: st.cashBusy.body.error, code: 'refund_busy' } }]
    await open()
    await press()
    await until(() => !!button(/^Check again$/) && server.gets === 2, 'Check again')
    await click(button(/^Check again$/))
    await until(() => text().includes(OTHER), 'who recorded it')
    expect(gold()).toEqual([])
    expect(text()).not.toContain(st.cashBusy.body.error)
  })

  it('lost, still there, pressed again, the 409, and then this worker\'s first press shows up recorded: recorded by you, "if you have not handed it over yet", in gold once — never a bare order, never a bare "handed back"', async () => {
    server.views = [st.cashOpen, st.cashOpen, st.cashDone]
    server.postAnswers = [{ network: true }, { fail: { status: 409, error: st.cashBusy.body.error, code: 'refund_busy' } }]
    await open()
    await press()
    await until(() => text().includes(STILL_THERE), 'press it again')
    await press()
    await until(() => text().includes(MINE), 'the words')
    expect(gold()).toEqual([MINE])
    expect(count(MINE)).toBe(1)
    expect(text()).not.toContain(ORDER)
    expect(text()).toContain(RECORDED)
    expect(text()).not.toMatch(/handed back in cash instead of to the card|could not tell|Another request/)
  })

  it('lost, then pressed again after the first was recorded: the server\'s reply says when it was recorded and the next step, in gold, once', async () => {
    server.views = [st.cashOpen, st.cashOpen, st.cashDone]
    server.postAnswers = [{ network: true }, { ok: st.cashAgain }]
    await open()
    await press()
    await until(() => text().includes(STILL_THERE), 'press it again')
    await press()
    await until(() => text().includes('This was already recorded as given back in cash'), 'the reply')
    expect(gold()).toEqual([st.cashAgain.words[0]])
    expect(text()).toContain(RECORDED)
    expect(text()).not.toContain(ORDER)
    expect(text()).not.toMatch(/handed back in cash instead of to the card/)
  })

  it('a decision press whose answer was lost, and the page now shows it decided: "Show what was done" sends the SAME press again, and its order shows in gold', async () => {
    const decidedNow = { ...r.open, left: 0, credits: [], sources: [], maxRefund: 0, refundOptions: [], restOptions: [], refundNotes: [], latest: r.decided.choice }
    server.views = [r.open, decidedNow]
    server.postAnswers = [{ network: true }, { ok: r.decided }]
    await open()
    await click(button(/^Refund all that can go back/))
    await click(button(/^Leave it as their credit/))
    await click(button(/^Refund \$140\.00 and leave \$60\.00 as their credit$/))
    await until(() => !!button(/^Show what was done$/), 'the way to see it')
    expect(text()).toContain('We could not tell if that saved. Press "Show what was done" — it sends the same press again, so nothing is done twice.')
    // Before it is pressed, the screen never says cash was handed back (the worker never heard the order).
    expect(text()).not.toMatch(/handed back in cash|Hand back \$/)
    expect(gold()).toEqual([])
    expect(button(/^Show what was done$/)?.className).toContain('btn-primary')
    await click(button(/^Show what was done$/))
    await until(() => text().includes('Hand back $40.00 in cash now.'), 'the order')
    expect(gold()).toEqual(['Hand back $40.00 in cash now.'])
    expect(server.posts[1].body).toEqual(server.posts[0].body)
  })

  it('a decision press whose answer was lost survives leaving the page: opened again (a reload, Back, a later visit), "Show what was done" is still offered and the record\'s hand-back lines stay hidden until it is pressed', async () => {
    const decidedNow = { ...r.open, left: 0, credits: [], sources: [], maxRefund: 0, refundOptions: [], restOptions: [], refundNotes: [], latest: r.decided.choice }
    server.views = [r.open, decidedNow]
    server.postAnswers = [{ network: true }]
    await open()
    await click(button(/^Refund all that can go back/))
    await click(button(/^Leave it as their credit/))
    await click(button(/^Refund \$140\.00 and leave \$60\.00 as their credit$/))
    await until(() => !!button(/^Show what was done$/), 'the way to see it')
    // Back to leases is never locked (one-button back-out); the press is kept for this browser session.
    expect(button(/Back to leases$/)?.disabled).toBe(false)
    const sent = server.posts[0].body
    act(() => root.unmount())
    root = createRoot(host)
    server.views = [decidedNow]; server.gets = 0
    server.postAnswers = [{ ok: r.decided }]
    await open()
    await until(() => !!button(/^Show what was done$/), 'the way to see it, again')
    expect(text()).not.toMatch(/handed back in cash|Hand back \$/)
    await click(button(/^Show what was done$/))
    await until(() => text().includes('Hand back $40.00 in cash now.'), 'the order')
    expect(gold()).toEqual(['Hand back $40.00 in cash now.'])
    expect(server.posts[1].body).toEqual(sent)
    // Settled: a later visit offers nothing more.
    act(() => root.unmount())
    root = createRoot(host)
    server.views = [decidedNow]; server.gets = 0
    await open()
    await until(() => server.gets >= 1, 'the look')
    expect(button(/^Show what was done$/)).toBeUndefined()
  })

  it('a cash press whose answer was lost survives leaving the page: opened again, the look that shows it recorded says recorded by you, "if you have not handed it over yet", in gold, once', async () => {
    server.views = [st.cashOpen, st.cashOpen]
    server.postAnswers = [{ network: true }]
    await open()
    await press()
    await until(() => text().includes('We could not tell if that saved, and nothing is to be handed back yet.'), 'the lost words')
    act(() => root.unmount())
    root = createRoot(host)
    server.views = [st.cashDone]; server.gets = 0
    await open()
    const mine = st.cashDone.latest.parts.find((p: any) => p.kind === 'cash').cashReply[0]
    await until(() => text().includes(mine), 'the words')
    expect(gold()).toEqual([mine])
    expect(count(mine)).toBe(1)
  })

  it('no line on the screen orders cash before the press: "give it back in cash" appears only as the quoted button name', async () => {
    for (const v of [r.sentBack, st.stopping, st.stopped, st.split, st.cashOpen]) {
      server.views = [v]; server.gets = 0
      await open()
      const clone = host.cloneNode(true) as HTMLElement
      clone.querySelectorAll('button').forEach((b) => b.remove())
      expect((clone.textContent ?? '').replace(/"Give it back in cash instead"/g, '')).not.toMatch(/give it back in cash/i)
      act(() => root.unmount())
      root = createRoot(host)
    }
  })
})

describe('choice46e: no order before the press, one answer per press, Check again beside the busy words', () => {
  const st = states as any
  const r = real as any
  const BUSY = 'Another request is working on this refund right now, so nothing was handed back. Wait a moment, then press Check again.'
  const pressCash = async () => {
    await click(button(/^Give it back in cash instead$/))
    await click(button(/^Give back \$103\.55 in cash$/))
  }

  it('the real cash-source view: choosing a refund shows what will happen — the cash at the desk is never ordered before Confirm, in the choice or in the lines under it', async () => {
    server.views = [r.open]
    server.previews.set('120', r.preview)
    await open()
    expect(text()).not.toMatch(/Hand back|Give back/)
    await click(button(/^Refund all that can go back/))
    expect(text()).toContain('$40.00 back in cash at the desk — you are told to hand it over after you confirm')
    expect(text()).not.toMatch(/Hand back|Give back/)
    await click(button(/^Refund a different amount/))
    await type('120')
    await until(() => text().includes(r.preview.parts[0].words), 'the preview')
    expect(text()).not.toMatch(/Hand back|Give back/)
    expect(server.posts).toEqual([])
  })

  it('a busy cash press, Check again, then Try again goes through: exactly one message — the reply — and never "could not tell", now or on the next look', async () => {
    const failed = r.sentBack.latest.parts.find((p: any) => p.status === 'failed')
    const sent = { ...failed, status: 'refunded', attention: false, retry: false, cashInstead: false, failure: null,
                   words: '$103.55 back to the card they paid with (Card · Sep 3) — sent' }
    const after = { ...r.sentBack, latest: { ...r.sentBack.latest, parts: r.sentBack.latest.parts.map((p: any) => (p.id === failed.id ? sent : p)) } }
    const reply = { leaseId: r.sentBack.leaseId, choice: after.latest, words: ['$103.55 back to the card they paid with (Card · Sep 3) — sent.'], handBack: [false], next: 'done' }
    server.views = [r.sentBack, r.sentBack, r.sentBack, after]
    server.postAnswers = [{ fail: { status: 409, error: BUSY, code: 'refund_busy' } }, { ok: reply }]
    await open()
    await pressCash()
    await until(() => text().includes(BUSY) && server.gets === 2, 'the busy words')
    await click(button(/^Check again$/))
    await until(() => server.gets === 3 && text().includes('Nothing was handed back yet.'), 'the look')
    await click(button(/^Try again$/))
    await until(() => text().includes(reply.words[0]) && server.gets === 4, 'the reply and the look after it')
    await act(async () => { await new Promise((res) => setTimeout(res, 50)) })
    expect(count(reply.words[0])).toBe(1)
    expect(text()).not.toMatch(/could not tell|Nothing was handed back|Another request/)
    expect(window.sessionStorage.getItem('gam:paid-ahead-pending:lease1')).toBeNull()
  })

  it('a busy cash press, then a Try again the server refuses in words: that refusal only — the earlier press is not said again as "could not tell"', async () => {
    const failed = r.sentBack.latest.parts.find((p: any) => p.status === 'failed')
    const refusal = 'This refund will not be sent: the payment it came from was disputed with their card company. Nothing was sent — the page now shows the latest.'
    server.views = [r.sentBack, r.sentBack, r.sentBack]
    server.postAnswers = [{ fail: { status: 409, error: BUSY, code: 'refund_busy' } }, { fail: { status: 409, error: refusal } }]
    await open()
    await pressCash()
    await until(() => text().includes(BUSY) && server.gets === 2, 'the busy words')
    await click(button(/^Try again$/))
    await until(() => text().includes(refusal) && server.gets === 3, 'the refusal and the look after it')
    await act(async () => { await new Promise((res) => setTimeout(res, 50)) })
    expect(count(refusal)).toBe(1)
    expect(text()).not.toMatch(/could not tell|Nothing was handed back yet|Another request/)
    expect(server.posts[1].url).toBe(`/leases/lease1/paid-ahead-choice/parts/${failed.id}/retry`)
  })

  it('a decided choice with a failed card refund AND new money paid ahead to decide: the busy words show with their Check again beside them, in the choices card', async () => {
    const both = { ...r.open, latest: r.sentBack.latest }
    server.views = [both, both, both]
    server.postAnswers = [{ fail: { status: 409, error: BUSY, code: 'refund_busy' } }]
    await open()
    expect(button(/^No refund/)).toBeTruthy()
    await pressCash()
    await until(() => text().includes(BUSY) && server.gets === 2, 'the busy words')
    expect(count(BUSY)).toBe(1)
    const check = button(/^Check again$/)
    expect(check?.className).toContain('btn-primary')
    await click(check)
    await until(() => server.gets === 3, 'the look in place')
  })

  it('the real refund states carry the record line as recorded, by whom and when', () => {
    const cash = st.cashDone.latest.parts.find((p: any) => p.kind === 'cash')
    expect(cash.words).toBe('$103.55 recorded as handed back in cash instead of to the card by Test Landlord on October 4, 2026 at 11:30 AM')
  })
})
