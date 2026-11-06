/**
 * The contractor's own screen — the first test this app has ever had.
 *
 * 10/31. apps/business had no test infrastructure at all until the marketplace
 * gave it a surface that decides money: this is where a contractor reads what
 * they keep and what GAM's cut is, and where they place a price no other
 * contractor may ever see.
 *
 * The load-bearing assertions are the two things Nic decided:
 *
 *  - THE BOARD IS ANONYMOUS. A browsing contractor gets the city and state and
 *    nothing nearer — not the park name, not the street, not the landlord, not
 *    the unit. "Oak Park Estates, Mesa AZ" is one search from the front gate.
 *  - BIDS ARE PRIVATE. The screen must never show a bid count, a low bid, a
 *    spread, or anything else that tells one contractor what another charged.
 *    That privacy is the product: "it helps keep it fair."
 *
 * And the one money rule: the cut comes from the rate endpoint, never a
 * hardcoded 3%, because the rate is a price card and a snapshot taken at award.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from 'react-query'

const server = vi.hoisted(() => ({
  me: null as any,
  board: [] as any[],
  myBids: [] as any[],
  myJobs: [] as any[],
  percent: 3,
  gets: [] as string[],
  posts: [] as { url: string; body: any }[],
  puts: [] as { url: string; body: any }[],
  toasts: [] as string[],
  confirms: [] as string[],
  confirmAnswer: true,
}))

vi.mock('../lib/api', () => ({
  apiGet: async (url: string) => {
    server.gets.push(url)
    if (url === '/marketplace/me') return server.me
    if (url === '/marketplace/rate') return { percent: server.percent }
    if (url.startsWith('/marketplace/board?')) {
      return { jobs: server.board, me: { insured: false, bonded: false } }
    }
    if (url === '/marketplace/my-bids') return server.myBids
    if (url === '/marketplace/my-jobs') return server.myJobs
    if (url === '/marketplace/me/credentials') return []
    if (url.startsWith('/marketplace/placement')) return null
    throw new Error(`unexpected GET ${url}`)
  },
  apiPost: vi.fn(async (url: string, body: any) => {
    server.posts.push({ url, body })
    return { success: true, data: {} }
  }),
  apiPut: vi.fn(async (url: string, body: any) => {
    server.puts.push({ url, body })
    return { success: true, data: {} }
  }),
  apiPatch: vi.fn(async () => ({})),
  apiDelete: vi.fn(async () => ({})),
}))
vi.mock('../components/dialogs', () => ({
  toast: (t: string) => { server.toasts.push(t) },
  appConfirm: async (message: string) => {
    server.confirms.push(message)
    return server.confirmAnswer
  },
}))

import { ContractorBidsPage } from './ContractorBidsPage'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const profile = (over: any = {}) => ({
  id: 'c1', name: 'Bob Kowalski', businessName: null, trades: ['plumbing'],
  status: 'active', rating: null, completedJobs: 7,
  insuranceVerified: false, insuranceExpiry: null,
  bondVerified: false, bondExpiry: null,
  city: 'Mesa', state: 'AZ', zip: null, serviceRadiusMiles: 50,
  connectPayoutsEnabled: false, acceptedTermsAt: '2026-10-01T00:00:00Z',
  createdAt: '2026-10-01T00:00:00Z', ...over,
})

const boardJob = (over: any = {}) => ({
  id: 'job1',
  title: 'Replace the water heater',
  description: 'The 40-gallon unit is leaking from the base and needs replacing.',
  trades: ['plumbing'], requiresInsured: false, requiresBonded: false,
  propertyCity: 'Mesa', propertyState: 'AZ',
  bidsCloseAt: null, alreadyBid: false,
  createdAt: '2026-10-31T12:00:00Z', ...over,
})

let host: HTMLDivElement
let root: Root

async function render() {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}><ContractorBidsPage /></QueryClientProvider>)
  })
  // Let the queries settle.
  await act(async () => { await Promise.resolve() })
  return host.textContent ?? ''
}

beforeEach(() => {
  server.me = profile()
  server.board = [boardJob()]
  server.myBids = []
  server.myJobs = []
  server.percent = 3
  server.gets = []; server.posts = []; server.puts = []
  server.toasts = []; server.confirms = []; server.confirmAnswer = true
})
afterEach(async () => {
  await act(async () => { root.unmount() })
  host.remove()
})

describe('a contractor with no profile yet', () => {
  it('is given the one thing there is to do, not an empty board', async () => {
    server.me = null
    const text = await render()
    // The screen asks for the details rather than announcing "set up your
    // profile" — the thing they came to do is bid, so that is what it says.
    expect(text).toMatch(/Start bidding/i)
    expect(text).toMatch(/Your name/i)
    expect(text).toMatch(/What you do/i)
    // And it never pretends there is work to look at yet.
    expect(text).not.toMatch(/Replace the water heater/)
  })

  it('is told joining and bidding both cost nothing', async () => {
    server.me = null
    const text = await render()
    expect(text).toMatch(/nothing to join/i)
    expect(text).toMatch(/nothing to bid/i)
  })

  it('is told the cut from the price card, not a hardcoded 3%', async () => {
    server.me = null
    server.percent = 4.5
    const text = await render()
    expect(text).toContain('4.5%')
    expect(text).not.toMatch(/\b3%/)
  })
})

describe('the board is anonymous', () => {
  it('names the town so they can plan the drive', async () => {
    const text = await render()
    expect(text).toMatch(/Mesa/)
    expect(text).toMatch(/AZ/)
  })

  it('never names the park, the street, the landlord or the unit', async () => {
    // The API does not send these fields at all (two separate selects, so no
    // single query could hand them over). This is the screen's half of that
    // promise: if a later change starts rendering whatever it is given, a
    // field like this appearing in the payload must not reach the page.
    server.board = [boardJob({
      propertyName: 'Oak Park Estates',
      propertyStreet1: '1400 W Main St',
      propertyZip: '85201',
      landlordName: 'Rhoades Holdings LLC',
      unitNumber: 'RV 12',
    } as any)]
    const text = await render()
    for (const leak of ['Oak Park Estates', '1400 W Main', '85201',
                        'Rhoades Holdings', 'RV 12']) {
      expect(text, `leaked ${leak}`).not.toContain(leak)
    }
  })
})

describe('bids stay private', () => {
  it('shows no bid count, no low bid and no spread', async () => {
    server.board = [boardJob({ bidCount: '4', lowestBid: '1200.00' } as any)]
    const text = await render()
    expect(text).not.toMatch(/\b4 bids?\b/i)
    expect(text).not.toMatch(/lowest|low bid|spread|outbid|beat/i)
    expect(text).not.toContain('1,200')
  })

  it('and never asks the server for anything that would carry another price', async () => {
    await render()
    for (const url of server.gets) {
      expect(url, url).not.toMatch(/bids\b(?!.*my-bids)/)
    }
    expect(server.gets.some(u => u.startsWith('/marketplace/board'))).toBe(true)
  })
})

describe("GAM's cut is read, never assumed", () => {
  it('states the rate the price card actually returned', async () => {
    server.percent = 4.5
    const text = await render()
    expect(text).toContain('4.5%')
    expect(text).not.toMatch(/\b3%/)
  })

  it('says nothing is charged on a job they do not win', async () => {
    const text = await render()
    expect(text).toMatch(/don't win|do not win|nothing on a job/i)
  })
})

describe('the free board', () => {
  it('tells them it is free to use', async () => {
    const text = await render()
    expect(text).toMatch(/free/i)
  })
})
