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
  /** 10/21: what the park's task / supply list answers. */
  lists: [] as any[],
}))

vi.mock('../lib/api', () => ({
  apiGet: async (url: string) => {
    server.gets.push(url)
    if (url === '/tenants/work-trade') return server.agreement
    if (url.startsWith('/utility/reading-runs')) return server.runs
    if (url === '/work-trade/jobs') return { mine: [], available: [], toCheck: [] }
    // 10/21: the park's two lists, which a work-trade resident reads from here.
    if (url.startsWith('/property-task-list/')) return server.lists
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
  server.lists = []
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

/**
 * 10/21 (Nic) — "we need work trade people to be able to see this task list in
 * the system. And then we also need a way for maybe maintenance people or work
 * trade people to put in sort of a collected shopping cart pool."
 *
 * It goes on THIS page rather than a nav item of its own, because this page
 * already exists only while the agreement is live — which is exactly who should
 * be looking at the park's jobs — and it is the page they open to check their
 * hours. The panel is the owner's own (shared-ui), with the owner's controls
 * off: they tick a job and they ask for supplies, and the task list stays the
 * owner's to write.
 */
describe('10/21: the park\'s task list and supply list, in the work trader\'s portal', () => {
  it('asks for both lists on the park named by their agreement', async () => {
    await show(WorkTradePage)
    await until(() => text().includes('Task list'), 'the task list')
    expect(server.gets).toContain('/property-task-list/p1?kind=job')
    expect(server.gets).toContain('/property-task-list/p1?kind=supply')
    // Not the owner's read: a resident never asks for what was taken off the list.
    expect(server.gets.every(u => !u.includes('withHidden'))).toBe(true)
  })

  it('reads the jobs and can tick one off, but has no box to write the task list', async () => {
    server.lists = [{
      id: 'i1', kind: 'job', body: 'Take pictures of MH 14 and get it listed',
      addedByUserId: 'u1', addedByName: 'Nic Rhoades', mine: false,
      doneAt: null, doneByUserId: null, doneByName: null, hiddenAt: null,
    }]
    await show(WorkTradePage)
    await until(() => text().includes('Take pictures of MH 14'), 'the job')
    // The tick is there …
    expect(buttons().some(b => b.getAttribute('aria-label') === 'Mark it done')).toBe(true)
    // … and so is the supply box, because anybody working the park may ask.
    expect(text()).toContain('Things to buy for this property')
    // The task list's own words say what does NOT belong on it.
    expect(text()).toContain('a closing read is taken at the counter')
  })

  it('shows a paused work trader the lists too — they are back on site before anybody un-pauses them', async () => {
    expect(server.agreement.status).toBe('paused')
    await show(WorkTradePage)
    await until(() => text().includes('Task list'), 'the task list while paused')
    expect(text()).toContain('Supply list')
  })

  it('a resident with no agreement sees no lists at all, because the page itself is not theirs', async () => {
    server.agreement = null
    await show(WorkTradePage)
    await until(() => text().includes('no work trade agreement'), 'the empty state')
    expect(text()).not.toContain('Task list')
    expect(server.gets.every(u => !u.startsWith('/property-task-list/'))).toBe(true)
  })
})
