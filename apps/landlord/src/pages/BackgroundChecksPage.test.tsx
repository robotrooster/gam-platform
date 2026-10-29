// @vitest-environment jsdom
/**
 * 10/19 (Nic) — NARROWING THE SCREENING LIST BY COMPANY AND BY PARK.
 *
 *   "I can't choose my property on the background check page. I can't go to the
 *    Oak Park ones, I guess. … So we need a way to filter that."
 *
 * He owns two companies and five parks, and every screening arrived in one
 * undifferentiated list. The company control is the same EntityPicker the bank
 * and front-desk pages use, and the park list is built from the screenings the
 * server already sent — so a filter can only ever SHOW LESS. It never asks the
 * API for a wider set, and it offers no company or park whose screenings were
 * not in the response.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from 'react-query'
import { MemoryRouter } from 'react-router-dom'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const server = vi.hoisted(() => ({
  checks: [] as any[],
  entities: [] as any[],
  gets: [] as string[],
}))

vi.mock('../lib/api', () => ({
  api: {},
  apiGet: async (url: string) => {
    server.gets.push(url)
    if (url === '/background') return server.checks
    if (url === '/landlords/me/entities') return server.entities
    return []
  },
  apiPost: async () => ({ success: true, data: {} }),
  apiPut: async () => ({}),
  apiPatch: async () => ({}),
  apiDel: async () => ({}),
}))
vi.mock('../components/dialogs', () => {
  const toast = () => {}
  ;(toast as any).error = () => {}
  return { toast, appConfirm: async () => true }
})

import { BackgroundChecksPage } from './BackgroundChecksPage'

const MV = 'company-mountain-view'
const OP = 'company-oak-park'

const check = (o: Record<string, unknown>) => ({
  status: 'complete', bucket: 'attention', email: 'x@test.dev', unitNumber: null,
  riskLevel: null, reportSummary: null, createdAt: '2026-10-03T19:01:00Z', ...o,
})

const twoCompanies = () => {
  server.entities = [
    { id: MV, businessName: 'Mountain View RV Park Ranch LLC', propertyCount: 2 },
    { id: OP, businessName: 'Oak Park Motel and RV LLC', propertyCount: 1 },
  ]
  server.checks = [
    check({ id: 'c1', firstName: 'Victor', lastName: 'Cardoza', landlordId: MV, propertyId: 'p-mv', propertyName: 'Mountain View' }),
    check({ id: 'c2', firstName: 'Nemesio', lastName: 'Rivera', landlordId: MV, propertyId: 'p-mv', propertyName: 'Mountain View' }),
    check({ id: 'c3', firstName: 'Annie', lastName: 'Annex', landlordId: MV, propertyId: 'p-annex', propertyName: 'Mountain View Annex' }),
    check({ id: 'c4', firstName: 'Olive', lastName: 'Oakley', landlordId: OP, propertyId: 'p-op', propertyName: 'Oak Park Motel' }),
    check({ id: 'c5', firstName: 'Opal', lastName: 'Oldham', landlordId: OP, propertyId: 'p-op', propertyName: 'Oak Park Motel', bucket: 'past', status: 'approved' }),
  ]
}

let host: HTMLDivElement
let root: Root

const flush = async () => { for (let i = 0; i < 8; i++) await act(async () => { await new Promise(r => setTimeout(r, 0)) }) }

async function render() {
  host = document.createElement('div')
  document.body.appendChild(host)
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  await act(async () => {
    root = createRoot(host)
    root.render(<MemoryRouter><QueryClientProvider client={qc}><BackgroundChecksPage /></QueryClientProvider></MemoryRouter>)
  })
  await flush()
}

const rows = () => [...host.querySelectorAll('tbody tr')]
  .map(tr => tr.querySelector('td')?.textContent?.trim() ?? '')
  .filter(t => t && !t.startsWith('Nobody') && !t.startsWith('No screenings'))
const selectWith = (option: string) => [...host.querySelectorAll('select')]
  .find(s => [...s.options].some(o => o.textContent?.includes(option))) as HTMLSelectElement | undefined
const buttonStarting = (label: string) => [...host.querySelectorAll('button')]
  .find(b => b.textContent?.trim().startsWith(label)) as HTMLButtonElement | undefined
async function choose(select: HTMLSelectElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!
  await act(async () => {
    setter.call(select, value)
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await flush()
}
const click = async (el: Element) => { await act(async () => { (el as HTMLElement).click() }); await flush() }

beforeEach(() => {
  server.checks = []
  server.entities = []
  server.gets = []
  window.history.replaceState({}, '', '/')
})
afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
})

describe('narrowing the screening list', () => {
  it('starts on every company, then shows one company and only its parks', async () => {
    twoCompanies()
    await render()
    expect(rows()).toEqual(['Victor Cardoza', 'Nemesio Rivera', 'Annie Annex', 'Olive Oakley'])

    const company = selectWith('Choose a company')!
    expect(company).toBeTruthy()
    // Both parks of Mountain View and Oak Park's are on offer to start with.
    expect([...selectWith('All properties')!.options].map(o => o.textContent))
      .toEqual(['All properties', 'Mountain View', 'Mountain View Annex', 'Oak Park Motel'])

    await choose(company, OP)
    expect(rows()).toEqual(['Olive Oakley'])
    expect(host.textContent).toContain('1 needs attention · 1 past')
    // and the park list is now Oak Park's alone
    expect(selectWith('All properties')).toBeUndefined()   // one park is not a choice
  })

  it('narrows to one park inside a company, and the tab counts follow', async () => {
    twoCompanies()
    await render()
    await choose(selectWith('Choose a company')!, MV)
    expect(rows()).toEqual(['Victor Cardoza', 'Nemesio Rivera', 'Annie Annex'])

    await choose(selectWith('All properties')!, 'p-annex')
    expect(rows()).toEqual(['Annie Annex'])
    expect(host.textContent).toContain('1 needs attention · 0 past')
    expect(buttonStarting('Needs attention')!.textContent).toContain('(1)')
    expect(buttonStarting('Past')!.textContent).toContain('(0)')
  })

  it('a park filter does not survive switching to a company that does not own it', async () => {
    twoCompanies()
    await render()
    await choose(selectWith('All properties')!, 'p-annex')
    expect(rows()).toEqual(['Annie Annex'])
    await choose(selectWith('Choose a company')!, OP)
    // Not an empty table stuck on Mountain View Annex — Oak Park's list.
    expect(rows()).toEqual(['Olive Oakley'])
  })

  it('shows the past list of the chosen company only', async () => {
    twoCompanies()
    await render()
    await choose(selectWith('Choose a company')!, MV)
    await click(buttonStarting('Past')!)
    expect(rows()).toEqual([])
    expect(host.textContent).toContain('No screenings here.')
    await choose(selectWith('Choose a company')!, OP)
    expect(rows()).toEqual(['Opal Oldham'])
  })
})

/**
 * 10/19 (Nic): "they did move in and then they left." A cleared stay that has
 * run its course must not read as a to-do.
 *
 * Whether it has run its course is the server's call (stayOver), decided on the
 * database's own date alongside the list this row sits on. The page prints that
 * answer and never recomputes it from the viewer's clock — a manager on a
 * laptop set to Tokyo time must not be told a Phoenix guest has checked out
 * while the front desk still has them on site.
 */
describe('a cleared stay that is over', () => {
  const ymd = (offsetDays: number) => {
    const d = new Date()
    d.setDate(d.getDate() + offsetDays)
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  }

  it('says the stay finished instead of inviting a check-in', async () => {
    server.entities = [{ id: MV, businessName: 'Mountain View RV Park Ranch LLC', propertyCount: 1 }]
    server.checks = [check({
      id: 'c1', firstName: 'Victor', lastName: 'Cardoza', status: 'approved', bucket: 'past',
      clearedForStay: true, stayOver: true, stayBookingId: 'b1', stayCheckIn: ymd(-15), stayCheckOut: ymd(-1),
      landlordId: MV, propertyId: 'p-mv', propertyName: 'Mountain View',
    })]
    await render()
    await click(buttonStarting('Past')!)
    expect(host.textContent).toContain('Stay finished')
    expect(host.textContent).not.toContain('Cleared for their stay')

    await click(host.querySelector('tbody tr')!)
    expect(host.textContent).toContain('They stayed')
    expect(host.textContent).toContain('That stay is finished — nothing here is waiting on you.')
    expect(host.textContent).not.toContain('They can be checked in from the schedule.')
  })

  it('a stay still to come, or still running, keeps the check-in wording', async () => {
    server.entities = [{ id: MV, businessName: 'Mountain View RV Park Ranch LLC', propertyCount: 1 }]
    server.checks = [check({
      id: 'c1', firstName: 'Victor', lastName: 'Cardoza', status: 'approved', bucket: 'past',
      clearedForStay: true, stayOver: false, stayBookingId: 'b1', stayCheckIn: ymd(0), stayCheckOut: ymd(30),
      landlordId: MV, propertyId: 'p-mv', propertyName: 'Mountain View',
    })]
    await render()
    await click(buttonStarting('Past')!)
    expect(host.textContent).toContain('Cleared for their stay')
    expect(host.textContent).not.toContain('Stay finished')

    await click(host.querySelector('tbody tr')!)
    expect(host.textContent).toContain('They can be checked in from the schedule.')
  })

  it("takes the server's word for it, not the browser's clock", async () => {
    server.entities = [{ id: MV, businessName: 'Mountain View RV Park Ranch LLC', propertyCount: 1 }]
    // Check-out reads as yesterday to THIS machine — a laptop an hour or a
    // day ahead of the park — while the park's own date still has the guest on
    // site and waiting to be checked in. The park wins.
    server.checks = [check({
      id: 'c1', firstName: 'Victor', lastName: 'Cardoza', status: 'approved', bucket: 'past',
      clearedForStay: true, stayOver: false, stayBookingId: 'b1', stayCheckIn: ymd(-15), stayCheckOut: ymd(-1),
      landlordId: MV, propertyId: 'p-mv', propertyName: 'Mountain View',
    })]
    await render()
    await click(buttonStarting('Past')!)
    expect(host.textContent).toContain('Cleared for their stay')
    expect(host.textContent).not.toContain('Stay finished')
    await click(host.querySelector('tbody tr')!)
    expect(host.textContent).toContain('They can be checked in from the schedule.')
    expect(host.textContent).not.toContain('That stay is finished')
  })
})

describe('a filter can only narrow, never widen', () => {
  it('asks the API for nothing but the account-wide list — no company or park goes to the server', async () => {
    twoCompanies()
    await render()
    await choose(selectWith('Choose a company')!, OP)
    await choose(selectWith('Choose a company')!, MV)
    // The SCREENING LIST itself is fetched once, account-wide, and every filter
    // narrows it here in the page — that is the rule this guards, because a
    // filter that goes to the server is a filter that can come back with MORE.
    expect(server.gets.filter(u => u === '/background' || u.startsWith('/background?'))).toEqual(['/background'])
    // No company ever goes to the server for it either.
    expect(server.gets.every(u => !u.includes('landlordId='))).toBe(true)
    // 10/21 (Nic): checks that are PAID FOR and waiting are a separate, small
    // list (routes/background /waiting) and it is scoped server-side to the
    // account — narrowing it by park is a filter it is free to send, because
    // the endpoint only ever answers with this account's own.
    expect(server.gets.filter(u => u.startsWith('/background/waiting'))).toEqual(['/background/waiting'])
  })

  it('offers no company or park the account was not already sent screenings for', async () => {
    twoCompanies()
    // The entities list may name a company with no screenings; it can still
    // only ever filter DOWN to nothing, and it offers no park of its own.
    server.entities = [...server.entities, { id: 'company-third', businessName: 'Somebody Else LLC', propertyCount: 4 }]
    await render()
    await choose(selectWith('Choose a company')!, 'company-third')
    expect(rows()).toEqual([])
    expect(host.textContent).toContain('No screenings here.')
    expect(selectWith('All properties')).toBeUndefined()
  })

  it('a one-company account gets no company control, and loses no row to it', async () => {
    server.entities = [{ id: MV, businessName: 'Mountain View RV Park Ranch LLC', propertyCount: 2 }]
    server.checks = [
      check({ id: 'c1', firstName: 'Victor', lastName: 'Cardoza', landlordId: MV, propertyId: 'p-mv', propertyName: 'Mountain View' }),
      // A row whose company is not in the entities list (an entity created
      // since this login, so it is in the data but not in the token's list)
      // must still be on screen — the picker is not even rendered.
      check({ id: 'c2', firstName: 'Nemesio', lastName: 'Rivera', landlordId: 'company-newer', propertyId: 'p-new', propertyName: 'Copper Canyon' }),
    ]
    await render()
    expect(selectWith('Choose a company')).toBeUndefined()
    expect(rows()).toEqual(['Victor Cardoza', 'Nemesio Rivera'])
  })

  it('a staff login with no company list of its own still sees its screenings', async () => {
    // A team login gets a 403 on the entities list, which reads as none.
    server.entities = []
    server.checks = [check({ id: 'c1', firstName: 'Victor', lastName: 'Cardoza', landlordId: MV, propertyId: 'p-mv', propertyName: 'Mountain View' })]
    await render()
    expect(selectWith('Choose a company')).toBeUndefined()
    expect(rows()).toEqual(['Victor Cardoza'])
  })
})
