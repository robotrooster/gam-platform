/**
 * 10/19 (Nic) — "SHOW IT WHILE PAUSED", IN THE TENANT'S PORTAL.
 *
 * Asked whether a tenant should see their work trade while it is paused, Nic
 * chose to show it while paused: the tab stays and says plainly which situation
 * they are in — hours still counting, or nothing being counted.
 *
 * Four tenant surfaces read ONE route for this (routes/tenants /work-trade):
 * the nav tab, this page, the Meter Readings page, and — through its own tool —
 * the tenant assistant. All four asked for the ACTIVE agreement, so a paused
 * one came back empty and the tab disappeared, taking the honest sentence with
 * it. The route's own widening is pinned in apps/api routes/tenants-misc.test;
 * this file is the two tenant screens.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from 'react-query'

const server = vi.hoisted(() => ({
  /** What GET /tenants/work-trade answers. */
  agreement: null as any,
  /** Every URL the screen asked for, so a paused screen can be shown to ask for nothing. */
  gets: [] as string[],
  runs: [] as any[],
}))

vi.mock('../lib/api', () => ({
  apiGet: async (url: string) => {
    server.gets.push(url)
    if (url === '/tenants/work-trade') return server.agreement
    if (url.startsWith('/utility/reading-runs')) return server.runs
    if (url === '/work-trade/jobs') return { mine: [], available: [], toCheck: [] }
    if (url.endsWith('/standing')) return {
      currentMonthHours: 20, carriedHours: 0, catchUpHours: 20, bankedHours: 0, carriedValue: null,
      paused: true, hoursCounted: true, hoursNotCounted: false,
      summary: 'This work trade is paused, but the space is still being used, so your hours keep counting.',
      extraHours: { mode: 'bank', recent: [], summary: null },
    }
    if (url.startsWith('/work-trade/')) return {
      agreement: server.agreement, logs: [], jobs: [],
      stats: { target: 80, hoursApprovedThisMonth: 0, pendingCount: 0, creditPct: 0, reviewBy: '2026-07-31' },
      record: { submitted: 0 },
    }
    throw new Error(`unexpected GET ${url}`)
  },
  apiPost: async () => ({}),
  apiPatch: async () => ({}),
  apiUpload: async () => ({}),
}))
vi.mock('../components/dialogs', () => ({ toast: Object.assign(() => {}, { error: () => {} }) }))

import { WorkTradePage } from './WorkTradePage'
import { MeterReadingsPage } from './MeterReadingsPage'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  server.gets = []
  server.runs = []
  server.agreement = {
    id: 'a1', status: 'paused', tracksHours: true, pausedSpaceOccupied: true, hoursCounted: true,
    unitNumber: 'RV 50', propertyName: 'Mountain View RV Ranch', propertyId: 'p1',
    coveredCharges: ['rent'], skills: [], fieldPermissions: ['read_meters'], trusted: false,
    tenantFirst: 'Pat', tenantLast: 'Q',
  }
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const text = () => host.textContent ?? ''
const buttons = () => Array.from(host.querySelectorAll('button')) as HTMLButtonElement[]
const until = async (f: () => boolean, what: string) => {
  for (let i = 0; i < 80; i++) {
    if (f()) return
    await act(async () => { await new Promise(r => setTimeout(r, 10)) })
  }
  throw new Error(`timed out waiting for ${what}: ${text().slice(0, 300)}`)
}
const show = async (Page: () => JSX.Element) => {
  await act(async () => {
    root.render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <Page />
      </QueryClientProvider>)
  })
}

describe('the Work Trade page while the trade is paused', () => {
  it('opens the window instead of saying they have no agreement', async () => {
    await show(WorkTradePage)
    await until(() => text().includes('RV 50'), 'the paused agreement to load')
    expect(text()).not.toContain('You have no work trade agreement')
    // The panel's own sentence for this situation: hours are still counting.
    expect(text()).toContain('your space is still being used, so your hours keep counting')
  })

  it('offers no hours to turn in and no job to take', async () => {
    await show(WorkTradePage)
    await until(() => text().includes('RV 50'), 'the paused agreement to load')
    // A paused trade must not look actionable: the route refuses hours on one
    // (routes/workTrade POST /:id/logs), so the button must not be there.
    expect(buttons().map(b => (b.textContent ?? '').trim())).not.toContain('Log hours')
    expect(text()).toContain('Jobs are paused along with your agreement')
    expect(text()).not.toContain('Nothing open right now')
  })

  it('the empty state is only for a tenant with no agreement at all', async () => {
    server.agreement = null
    await show(WorkTradePage)
    await until(() => text().includes('no work trade agreement'), 'the empty state')
    // Not "no ACTIVE agreement" — a paused one reaches this page now.
    expect(text()).not.toContain('active work trade')
  })
})

describe('the Meter Readings page while the trade is paused', () => {
  it('says why there is nothing to read, and starts nothing', async () => {
    await show(MeterReadingsPage)
    await until(() => text().includes('paused'), 'the paused reason')
    expect(text()).toContain('no meter readings to take right now')
    expect(buttons().map(b => (b.textContent ?? '').trim())).not.toContain('Start reading')
    // Field work is not paused work, so it does not even ask the property for a
    // reading run.
    expect(server.gets.some(u => u.startsWith('/utility/reading-runs'))).toBe(false)
  })

  it('still reads meters once the trade is running again', async () => {
    server.agreement = { ...server.agreement, status: 'active' }
    await show(MeterReadingsPage)
    await until(() => text().includes('Meter readings'), 'the meter page')
    expect(text()).not.toContain('no meter readings to take right now')
    expect(server.gets.some(u => u.startsWith('/utility/reading-runs'))).toBe(true)
  })

  it('still says no when reading meters was never part of the agreement', async () => {
    server.agreement = { ...server.agreement, status: 'active', fieldPermissions: [] }
    await show(MeterReadingsPage)
    await until(() => text().includes('not part of your work trade'), 'the not-your-job reason')
  })
})
