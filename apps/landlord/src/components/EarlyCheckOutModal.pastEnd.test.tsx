// @vitest-environment jsdom
/**
 * 10/13 (Nic): "void the cancelled nights: owner + managers with booking
 * permission" — "OWNER + PROPERTY MANAGERS only (not on-site staff)." The
 * Check out window asks about rent a payment was tried on
 * past the day they left with only the answers the server offered: somebody
 * who may not take the charges off sees "Keep them owed" alone, with the
 * server's reason why; the owner sees both. A quote that names no answers
 * still offers "Keep them owed" (the window used to break on it).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from 'react-query'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const server = vi.hoisted(() => ({
  quote: null as any,
  posts: [] as Array<{ url: string; body: any }>,
}))

vi.mock('../lib/api', () => ({
  apiGet: async (url: string) => {
    if (url.startsWith('/units/u1/bookings/b1/check-out')) return server.quote
    throw new Error(`unexpected GET ${url}`)
  },
  apiPost: async (url: string, body: any) => {
    server.posts.push({ url, body })
    return { data: { words: ['Checked out.'] } }
  },
}))

import { EarlyCheckOutModal } from './EarlyCheckOutModal'

const REFUSED = 'Only the owner, or a property manager who can edit reservations, can take those charges off.'

function quote(pastEnd: any) {
  return {
    bookingId: 'b1', unitId: 'u1', unitNumber: 'RV 14', guest: 'Dana Guest', status: 'checked_in',
    today: '2026-10-13', checkIn: '2026-09-01', leftOn: '2026-10-13', checkedOut: false, early: true,
    booked: { checkOut: '2026-11-01', nights: 61, price: 1800 },
    stayed: { checkOut: '2026-10-13', nights: 42, worth: 1240 },
    paid: 900, owedAsBooked: 900,
    lease: { id: 'l1', endsOn: '2026-10-13', words: 'Checking out ends the lease on Oct 13.' },
    sources: [], question: 'none', unused: 0, maxRefund: 0, choices: [], canRefund: true, canCheckOut: true,
    pastEndAttempted: pastEnd, waitsForRefund: null, waitsForCheckOut: null, decision: null, quoteToken: 'qt1',
  }
}

let root: Root | null = null
let host: HTMLDivElement | null = null
const flush = async () => { for (let i = 0; i < 6; i++) await act(async () => { await new Promise(r => setTimeout(r, 0)) }) }
async function render() {
  host = document.createElement('div')
  document.body.appendChild(host)
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  await act(async () => {
    root = createRoot(host!)
    root.render(<QueryClientProvider client={qc}><EarlyCheckOutModal unitId="u1" bookingId="b1" onClose={() => {}} /></QueryClientProvider>)
  })
  await flush()
}
const buttons = () => [...host!.querySelectorAll('button')].map(b => (b.textContent ?? '').trim())
const press = async (label: string) => {
  const b = [...host!.querySelectorAll('button')].find(x => (x.textContent ?? '').trim() === label)
  if (!b) throw new Error(`no button "${label}" — have: ${buttons().join(' | ')}`)
  await act(async () => { b.click() })
  await flush()
}

beforeEach(() => { server.posts = [] })
afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  root = null; host = null
})

describe('Check out window — rent a payment was tried on past the day they left (10/13, Nic)', () => {
  it('somebody who may not take the charges off sees "Keep them owed" only, and why', async () => {
    server.quote = quote({
      words: 'Rent for Oct 14–31 was tried on. What should happen to those charges?',
      charges: [{ paymentId: 'p1', dueDate: '2026-10-14', amount: 540 }],
      choices: { keep: 'Keep them owed' }, voidRefused: REFUSED,
    })
    await render()
    expect(buttons()).toContain('Keep them owed')
    expect(buttons()).not.toContain('Take those charges off')
    expect(host!.textContent).toContain(REFUSED)
    // Nothing to press until they answer; then the check-out carries "keep".
    expect(buttons()).not.toContain('Check out Dana Guest')
    await press('Keep them owed')
    await press('Check out Dana Guest')
    expect(server.posts).toHaveLength(1)
    expect(server.posts[0].body).toMatchObject({ pastEndAttempted: 'keep', quoteToken: 'qt1' })
  })

  it('the owner sees both answers, and no reason line', async () => {
    server.quote = quote({
      words: 'Rent for Oct 14–31 was tried on. What should happen to those charges?',
      charges: [{ paymentId: 'p1', dueDate: '2026-10-14', amount: 540 }],
      choices: { void: 'Take those charges off', keep: 'Keep them owed' }, voidRefused: null,
    })
    await render()
    expect(buttons()).toEqual(expect.arrayContaining(['Take those charges off', 'Keep them owed']))
    expect(host!.textContent).not.toContain(REFUSED)
    await press('Take those charges off')
    await press('Check out Dana Guest')
    expect(server.posts[0].body).toMatchObject({ pastEndAttempted: 'void' })
  })

  it('a quote that names no answers still offers "Keep them owed" (never "Take those charges off")', async () => {
    server.quote = quote({
      words: 'Rent for Oct 14–31 was tried on. What should happen to those charges?',
      charges: [{ paymentId: 'p1', dueDate: '2026-10-14', amount: 540 }],
    })
    await render()
    expect(buttons()).toContain('Keep them owed')
    expect(buttons()).not.toContain('Take those charges off')
  })
})
