/**
 * 10/18 (Nic) — THE TWO DEPARTURE QUESTIONS ON THE PROPERTY'S PAGE.
 *
 *   "refunds are pro rated to the next price down ... if the landlord does
 *    refunds at all at that property. the only way it is different is for
 *    longer term people for rent pro ration. moving in or out at the middle of
 *    a month and also only if the landlord allows the pro rate. these should
 *    all be property level settings."
 *
 * Worded as questions a landlord answers, not as flags. Both read Yes until
 * the landlord says otherwise — including when the page is older than the
 * migration and the answers are simply not in what it loaded, which must read
 * as "what every property does today" and never as No.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from 'react-query'

const server = vi.hoisted(() => ({
  patches: [] as { url: string; body: any }[],
  /** The next PATCH fails with this, the way the API refuses one. */
  refuse: null as string | null,
}))
vi.mock('../lib/api', () => ({
  apiGet: async () => ({}),
  apiPost: async () => ({}),
  apiPatch: async (url: string, body: any) => {
    server.patches.push({ url, body })
    // 'bare' = a failure with no message of its own (the network dropped).
    if (server.refuse === 'bare') throw new Error('network')
    if (server.refuse) throw { response: { data: { error: server.refuse } } }
    return {}
  },
}))
const toasts = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }))
vi.mock('../components/dialogs', () => ({ toast: toasts }))

import { DepartureRulesCard } from './PropertyDetailPage'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  server.patches = []
  server.refuse = null
  toasts.error.mockClear(); toasts.success.mockClear()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const text = () => host.textContent ?? ''
const qc = () => new QueryClient({ defaultOptions: { queries: { retry: false } } })
async function show(property: any, onSaved = () => {}) {
  await act(async () => {
    root.render(
      <QueryClientProvider client={qc()}>
        <DepartureRulesCard property={property} onSaved={onSaved} />
      </QueryClientProvider>)
  })
}
/** The Yes/No buttons, in order: refunds Yes, refunds No, proration Yes, proration No. */
const buttons = () => Array.from(host.querySelectorAll('button')) as HTMLButtonElement[]
const picked = () => buttons().filter(b => b.className.includes('btn-primary')).map(b => b.textContent)
const until = async (f: () => boolean, what: string) => {
  for (let i = 0; i < 60; i++) {
    if (f()) return
    await act(async () => { await new Promise(r => setTimeout(r, 10)) })
  }
  throw new Error(`timed out waiting for ${what}`)
}

describe('the two departure questions', () => {
  it('asks both as questions, and both read Yes to start', async () => {
    await show({ id: 'p1', earlyDepartureRefunds: true, proratesMidMonthRent: true })
    expect(text()).toContain('Do you give money back when someone leaves early?')
    expect(text()).toContain('Do you prorate rent when a long-term resident moves in or out mid-month?')
    expect(picked()).toEqual(['Yes', 'Yes'])
    // The Yes answers explain what happens, in the landlord's own terms.
    expect(text()).toContain('The days they did stay are priced at the next rate down')
    expect(text()).toContain('counted against the actual days in that month')
  })

  it('a page loaded before the answers existed still reads Yes, never No', async () => {
    await show({ id: 'p1' })
    expect(picked()).toEqual(['Yes', 'Yes'])
  })

  it('answering No to refunds saves that one answer and says what it means', async () => {
    const onSaved = vi.fn()
    await show({ id: 'p1', earlyDepartureRefunds: true, proratesMidMonthRent: true }, onSaved)
    const no = buttons().find(b => b.textContent === 'No')!
    await act(async () => { no.click() })
    await until(() => server.patches.length === 1, 'the answer saved')
    expect(server.patches[0]).toEqual({ url: '/properties/p1/departure-rules', body: { refundsEarlyDeparture: false } })
    await until(() => onSaved.mock.calls.length === 1, 'the page told')
  })

  it('answering No to proration saves only that answer', async () => {
    await show({ id: 'p1', earlyDepartureRefunds: true, proratesMidMonthRent: true })
    const nos = buttons().filter(b => b.textContent === 'No')
    await act(async () => { nos[1].click() })
    await until(() => server.patches.length === 1, 'the answer saved')
    expect(server.patches[0]).toEqual({ url: '/properties/p1/departure-rules', body: { proratesMidMonth: false } })
  })

  it('a park that answers No to both says so plainly', async () => {
    await show({ id: 'p1', earlyDepartureRefunds: false, proratesMidMonthRent: false })
    expect(picked()).toEqual(['No', 'No'])
    expect(text()).toContain('the price as booked stands')
    expect(text()).toContain('a whole month is a whole month, moving in and moving out alike')
  })

  it('pressing the answer already given saves nothing', async () => {
    await show({ id: 'p1', earlyDepartureRefunds: true, proratesMidMonthRent: true })
    const yes = buttons().filter(b => b.textContent === 'Yes')
    await act(async () => { yes[0].click(); yes[1].click() })
    expect(server.patches).toEqual([])
  })

  /**
   * 10/19 (review): the one way this really fails is GAM part-way through an
   * update, where the answer cannot be stored yet. The server says so in plain
   * words; "Could not save that answer" sent the landlord back to press the
   * same button with nothing to go on.
   */
  it('a refused answer says what the server said, not a generic failure', async () => {
    server.refuse = 'GAM is part-way through an update, so that answer cannot be saved just yet. '
      + 'Until it is, this property gives money back when someone leaves early and prorates a mid-month '
      + 'move, the way it always has. Try again in a few minutes.'
    await show({ id: 'p1', earlyDepartureRefunds: true, proratesMidMonthRent: true })
    const no = buttons().find(b => b.textContent === 'No')!
    await act(async () => { no.click() })
    await until(() => toasts.error.mock.calls.length === 1, 'the landlord told')
    expect(toasts.error.mock.calls[0][0]).toBe(server.refuse)
  })

  it('a failure with nothing to say still tells the landlord it did not save', async () => {
    server.refuse = 'bare'
    await show({ id: 'p1', earlyDepartureRefunds: true, proratesMidMonthRent: true })
    const no = buttons().find(b => b.textContent === 'No')!
    await act(async () => { no.click() })
    await until(() => toasts.error.mock.calls.length === 1, 'the landlord told')
    expect(toasts.error.mock.calls[0][0]).toBe('Could not save that answer')
  })

  it('says the answers apply from now on — history is not revisited', async () => {
    await show({ id: 'p1', earlyDepartureRefunds: true, proratesMidMonthRent: true })
    expect(text()).toContain('A refund already sent and a month already billed are not revisited.')
  })
})
