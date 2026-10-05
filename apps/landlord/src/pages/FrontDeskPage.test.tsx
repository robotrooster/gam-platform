// @vitest-environment jsdom
/**
 * decisions.md #48.2 (line 20: "staff tick what went in the bag"): front-desk
 * staff who take payments make the bank deposit on the Front Desk page, without
 * the owner-only bank matching. Staff who do not take payments never see it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from 'react-query'

const state = vi.hoisted(() => ({
  // The permissions exactly as the login response carries them. The API
  // camelizes every response, so the dotless key take_payment arrives as
  // takePayment; the real usePerms hook (not a mock) must read that spelling.
  perms: {} as Record<string, boolean>,
  isOwner: false,
  entities: null as null | { id: string; businessName: string }[],
  /** Holds the company list back until released (an owner's slow first load). */
  entitiesGate: null as null | Promise<void>,
  panels: [] as { entityId?: string; canMatchBank?: boolean }[],
  asked: [] as string[],
  /** URL prefix → the server refuses it with this status and sentence. */
  refuse: {} as Record<string, { status: number; error: string }>,
  /** What GET /balances answers with. */
  balances: [] as any[],
  /** When set, GET /balances waits for it (the balances still on their way). */
  balancesGate: null as null | Promise<void>,
  /** What GET /landlords/me/pending-tenants answers with. */
  pending: [] as any[],
  /** When set, a re-send invite is refused with this status and sentence. */
  patchFail: null as null | { status: number; error: string },
  /**
   * When set, the GET answers pass through the API's own response converter
   * (apps/api lib/caseConversion), the way they reach the browser, so the page
   * is proven against the server's real snake_case rows.
   */
  wire: null as null | ((x: any) => any),
}))
const refusal = (url: string) => {
  const hit = Object.entries(state.refuse).find(([prefix]) => url.startsWith(prefix))
  if (!hit) return null
  return Object.assign(new Error(hit[1].error), { response: { status: hit[1].status, data: { success: false, error: hit[1].error } } })
}

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: state.isOwner
      ? { id: 'u_owner', role: 'landlord', permissions: {} }
      : { id: 'u_staff', role: 'onsite_manager', permissions: state.perms },
  }),
}))
vi.mock('../lib/api', () => ({
  api: { get: async (url: string) => {
    state.asked.push(url)
    const no = refusal(url); if (no) throw no
    if (url === '/balances' && state.balancesGate) await state.balancesGate
    const out = state.wire ?? ((x: any) => x)
    return { data: out({ data: url === '/balances' ? state.balances : [] }) }
  } },
  apiGet: async (url: string) => {
    state.asked.push(url)
    const no = refusal(url); if (no) throw no
    if (url === '/landlords/me/entities') {
      if (state.entitiesGate) await state.entitiesGate
      // A team login gets a 403 here; the page treats it as no list.
      if (!state.entities) throw Object.assign(new Error('Forbidden'), { response: { status: 403 } })
      return state.entities
    }
    if (url === '/landlords/me/pending-tenants') return (state.wire ?? ((x: any) => x))(JSON.parse(JSON.stringify(state.pending)))
    return []
  },
  apiPatch: async () => {
    if (state.patchFail) {
      const f = state.patchFail
      throw Object.assign(new Error(f.error), { response: { status: f.status, data: { success: false, error: f.error } } })
    }
    return { resent: true }
  },
  apiPost: async () => ({}),
  apiPut: async () => ({}),
  apiDelete: async () => ({}),
}))
vi.mock('./MakeDepositPanel', () => ({
  MakeDepositPanel: (p: { entityId?: string; canMatchBank?: boolean }) => {
    state.panels.push(p)
    return <div data-testid="make-deposit">Make a bank deposit panel for {p.entityId || 'the staffer’s company'}</div>
  },
}))

import { FrontDeskPage } from './FrontDeskPage'
import { camelCaseKeys } from '../../../api/src/lib/caseConversion'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  state.perms = {}; state.isOwner = false; state.entities = null; state.entitiesGate = null
  state.panels = []; state.asked = []; state.refuse = {}; state.balances = []
  state.balancesGate = null; state.pending = []; state.patchFail = null; state.wire = null
  window.history.replaceState(null, '', '/front-desk')
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
 * `portal` builds the QueryClient the way the landlord portal does (main.tsx:
 * answers kept 5 minutes, never refetched on mount), so a tab opened again is
 * proven to read its list again rather than show the cached one.
 */
async function open(opts: { portal?: boolean } = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: opts.portal
    ? { retry: false, staleTime: 300000, refetchOnWindowFocus: false, refetchOnMount: false }
    : { retry: false } } })
  await act(async () => {
    root.render(<QueryClientProvider client={qc}><FrontDeskPage /></QueryClientProvider>)
  })
  await until(() => text().includes('Front Desk'), 'the page')
}

describe('Make a bank deposit on the Front Desk', () => {
  it('a staffer who takes payments gets it, without bank matching', async () => {
    state.perms = { 'front_desk.view': true, takePayment: true }
    await open()
    const tab = button(/^Make a bank deposit$/)
    expect(tab).toBeTruthy()
    expect(tab!.className).toContain('btn-ghost')
    await act(async () => { tab!.click() })
    await until(() => !!host.querySelector('[data-testid="make-deposit"]'), 'the deposit panel')
    expect(button(/^Make a bank deposit$/)!.className).toContain('btn-primary')
    expect(state.panels.at(-1)).toEqual({ entityId: '', canMatchBank: false })
    // A team login names no company: the server knows theirs. The company list
    // is the owner's, so it is never asked for (it would only be refused).
    expect(text()).not.toContain('Choose the company')
    expect(state.asked).not.toContain('/landlords/me/entities')
    expect(new URLSearchParams(window.location.search).get('tab')).toBe('deposit')
  })

  it('a staffer who does not take payments never sees it, even from a saved address', async () => {
    state.perms = { 'front_desk.view': true }
    window.history.replaceState(null, '', '/front-desk?tab=deposit')
    await open()
    expect(button(/^Make a bank deposit$/)).toBeUndefined()
    expect(host.querySelector('[data-testid="make-deposit"]')).toBeNull()
    expect(button(/^Call list/)!.className).toContain('btn-primary')
  })

  it('a staffer who only takes payments lands on the bank deposit', async () => {
    // The wire spelling, through the real permission hook.
    state.perms = { takePayment: true }
    await open()
    await until(() => !!host.querySelector('[data-testid="make-deposit"]'), 'the deposit panel')
    expect(button(/^Make a bank deposit$/)!.className).toContain('btn-primary')
  })

  it('a staffer who only takes payments is told nothing about calls and never asks for the call lists', async () => {
    state.perms = { takePayment: true }
    await open()
    await until(() => !!host.querySelector('[data-testid="make-deposit"]'), 'the deposit panel')
    expect(text()).not.toMatch(/need(s)? contacting/)
    expect(button(/^Call list/)).toBeUndefined()
    expect(state.asked).not.toContain('/balances')
    expect(state.asked).not.toContain('/landlords/me/pending-tenants')
  })

  it('a saved call-list address opens the bank deposit for a staffer without the call list', async () => {
    state.perms = { takePayment: true }
    window.history.replaceState(null, '', '/front-desk?tab=calls')
    await open()
    await until(() => !!host.querySelector('[data-testid="make-deposit"]'), 'the deposit panel')
    expect(host.querySelector('input[placeholder^="Name, email"]')).toBeNull()
  })

  it('a staffer with the call list and "View who owes" sees the count, the Call list tab, and what is owed', async () => {
    state.perms = { 'front_desk.view': true, 'balances.view': true }
    await open()
    await until(() => /people need contacting/.test(text()), 'the call count')
    expect(button(/^Call list/)).toBeTruthy()
    expect(state.asked).toContain('/balances')
  })

  it('a staffer with the call list but not "View who owes" never asks for the balances it would be refused', async () => {
    state.perms = { 'front_desk.view': true }
    await open()
    await until(() => /people need contacting/.test(text()), 'the call count')
    expect(state.asked).toContain('/landlords/me/pending-tenants')
    expect(state.asked).not.toContain('/balances')
  })

  it('an owner of several companies never gets a company-less panel while the company list is loading', async () => {
    state.isOwner = true
    state.entities = [{ id: 'co_mv', businessName: 'Mountain View LLC' }, { id: 'co_op', businessName: 'Oak Park LLC' }]
    let release!: () => void
    state.entitiesGate = new Promise<void>(r => { release = r })
    window.history.replaceState(null, '', '/front-desk?tab=deposit')
    await open()
    await until(() => text().includes('Loading…'), 'the loading line')
    expect(state.panels).toEqual([])
    await act(async () => { release() })
    await until(() => text().includes('Choose the company whose cash is going to the bank.'), 'the company question')
    expect(state.panels).toEqual([])
  })

  it('an owner of one company gets the panel for that company, never a company-less one first', async () => {
    state.isOwner = true
    state.entities = [{ id: 'co_mv', businessName: 'Mountain View LLC' }]
    window.history.replaceState(null, '', '/front-desk?tab=deposit')
    await open()
    await until(() => !!host.querySelector('[data-testid="make-deposit"]'), 'the deposit panel')
    expect(state.panels.every(p => p.entityId === 'co_mv')).toBe(true)
  })

  it('an owner of several companies names the company first, then gets the panel for it', async () => {
    state.isOwner = true
    state.entities = [{ id: 'co_mv', businessName: 'Mountain View LLC' }, { id: 'co_op', businessName: 'Oak Park LLC' }]
    window.history.replaceState(null, '', '/front-desk?tab=deposit')
    await open()
    await until(() => text().includes('Choose the company whose cash is going to the bank.'), 'the company question')
    expect(host.querySelector('[data-testid="make-deposit"]')).toBeNull()
    const select = host.querySelector('select') as HTMLSelectElement
    await act(async () => {
      select.value = 'co_op'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await until(() => !!host.querySelector('[data-testid="make-deposit"]'), 'the deposit panel')
    expect(state.panels.at(-1)).toEqual({ entityId: 'co_op', canMatchBank: false })
  })
})

describe('every Front Desk tab a staffer sees works for them', () => {
  it('a staffer who only takes payments never sees Emergency contacts, even from ?tab=emergency', async () => {
    state.perms = { takePayment: true }
    window.history.replaceState(null, '', '/front-desk?tab=emergency')
    await open()
    await until(() => !!host.querySelector('[data-testid="make-deposit"]'), 'the deposit panel')
    expect(button(/^Emergency contacts$/)).toBeUndefined()
    expect(state.asked).not.toContain('/emergency-contacts')
  })

  it('a staffer who only marks residents leaving never sees Emergency contacts, and lands on Move-outs', async () => {
    state.perms = { 'front_desk.mark_leaving': true }
    window.history.replaceState(null, '', '/front-desk?tab=emergency')
    await open()
    await until(() => text().includes('Nobody is on a space right now.'), 'the move-outs list')
    expect(button(/^Emergency contacts$/)).toBeUndefined()
    expect(button(/^Move-outs$/)!.className).toContain('btn-primary')
    expect(state.asked).not.toContain('/emergency-contacts')
  })

  it('a staffer with the call list sees Emergency contacts and gets the roster', async () => {
    state.perms = { 'front_desk.view': true }
    await open()
    await act(async () => { button(/^Emergency contacts$/)!.click() })
    await until(() => text().includes('Nobody is on a space right now.'), 'the roster')
    expect(state.asked).toContain('/emergency-contacts')
  })

  it('a staffer who does not mark residents leaving never sees Move-outs, even from ?tab=moveouts', async () => {
    state.perms = { takePayment: true }
    window.history.replaceState(null, '', '/front-desk?tab=moveouts')
    await open()
    await until(() => !!host.querySelector('[data-testid="make-deposit"]'), 'the deposit panel')
    expect(button(/^Move-outs$/)).toBeUndefined()
    expect(state.asked.some(u => u.startsWith('/leases/desk/residents'))).toBe(false)
  })

  it('a staffer who reached Front Desk with no key for any tab is told what to ask for, and nothing is asked of the server', async () => {
    state.perms = { 'tenant_onboarding.view': true }
    window.history.replaceState(null, '', '/front-desk?tab=moveouts')
    await open()
    await until(() => text().includes('Nothing on the Front Desk is turned on for you yet.'), 'the message')
    expect([...host.querySelectorAll('button')].map(b => b.textContent)).toEqual([])
    expect(state.asked).toEqual([])
  })

  it('a refused call list says so once with the next step, never "Nobody here" or a count of zero', async () => {
    state.perms = { 'front_desk.view': true }
    state.refuse = { '/landlords/me/pending-tenants': { status: 500, error: 'The call list could not be read.' } }
    await open()
    await until(() => text().includes('The call list could not be read.'), 'the error')
    expect(text().split('The call list could not be read.').length - 1).toBe(1)
    expect(text()).toContain('tell GAM support')
    expect(text()).not.toContain('Nobody here')
    expect(text()).not.toMatch(/need(s)? contacting/)
  })

  it('a refused emergency contact list says so once instead of an empty roster, with signing in again as the step', async () => {
    state.perms = { 'front_desk.view': true }
    state.refuse = { '/emergency-contacts': { status: 403, error: 'Insufficient permissions' } }
    window.history.replaceState(null, '', '/front-desk?tab=emergency')
    await open()
    const said = 'The emergency contact list is not open to you right now.'
    await until(() => text().includes(said), 'the refusal')
    expect(text().split(said).length - 1).toBe(1)
    // The switch was just turned on (the tab shows) but the sign-in predates it:
    // never "not turned on for you", and never a refresh that would not help.
    expect(text()).toContain('sign out and back in to pick it up')
    expect(text()).toContain('ask the owner to turn on "Front desk to-do list" for you')
    expect(text()).not.toContain('Insufficient permissions')
    expect(text()).not.toContain('Refresh the page')
    expect(text()).not.toContain('No residents match that.')
    expect(text()).not.toContain('Nobody is on a space right now.')
  })

  it('a refused call list (switch just turned on) names the switch and says to sign in again', async () => {
    state.perms = { 'front_desk.view': true }
    state.refuse = { '/landlords/me/pending-tenants': { status: 403, error: 'Insufficient permissions' } }
    await open()
    await until(() => text().includes('The call list is not open to you right now.'), 'the refusal')
    expect(text()).toContain('sign out and back in to pick it up')
    expect(text()).toContain('"Front desk to-do list"')
    expect(text()).not.toContain('Insufficient permissions')
    expect(text()).not.toContain('Nobody here')
    expect(button(/^Call list/)!.textContent).toBe('Call list')
  })

  it('a refused move-out list (switch just turned on) names the switch and says to sign in again', async () => {
    state.perms = { 'front_desk.mark_leaving': true }
    state.refuse = { '/leases/desk/residents': { status: 403, error: 'Insufficient permissions' } }
    await open()
    await until(() => text().includes('The move-out list is not open to you right now.'), 'the refusal')
    expect(text()).toContain('sign out and back in to pick it up')
    expect(text()).toContain('"Mark a resident as leaving"')
    expect(text()).not.toContain('Insufficient permissions')
    expect(text()).not.toContain('Nobody found')
  })

  it('a refused balances list says so once, never "Nobody here" or a count of zero', async () => {
    state.perms = { 'front_desk.view': true, 'balances.view': true }
    state.refuse = { '/balances': { status: 500, error: 'The balances could not be read' } }
    await open()
    await until(() => text().includes('The balances could not be read.'), 'the error')
    expect(text().split('The balances could not be read.').length - 1).toBe(1)
    expect(text()).toContain('The balances could not be read. Refresh the page; if it keeps happening, tell GAM support.')
    expect(text()).not.toContain('Nobody here')
    expect(text()).not.toMatch(/need(s)? contacting/)
  })

  it('a refused balances list (switch just turned on) names "View who owes + contact"', async () => {
    state.perms = { 'front_desk.view': true, 'balances.view': true }
    state.refuse = { '/balances': { status: 403, error: 'Insufficient permissions' } }
    await open()
    await until(() => text().includes('Who owes money is not open to you right now.'), 'the refusal')
    expect(text()).toContain('"View who owes + contact"')
    expect(text()).not.toContain('Nobody here')
  })

  it('a staffer with the call list but not "View who owes" is told the money lines are not shown, once', async () => {
    state.perms = { 'front_desk.view': true }
    await open()
    const said = 'Who owes money is not shown here. Ask the owner to turn on "View who owes + contact" for you.'
    await until(() => text().includes(said), 'the note')
    expect(text().split(said).length - 1).toBe(1)
    expect(button(/^Owes/)).toBeUndefined()
    expect(state.asked).not.toContain('/balances')
  })

  it('a staffer with "View who owes" is not told anything is hidden', async () => {
    state.perms = { 'front_desk.view': true, 'balances.view': true }
    await open()
    await until(() => /people need contacting/.test(text()), 'the call count')
    expect(text()).not.toContain('Who owes money is not shown here.')
  })

  it('the call list is read again when the desk comes back to it: somebody who now owes shows', async () => {
    state.perms = { 'front_desk.view': true, 'balances.view': true }
    await open({ portal: true })
    await until(() => text().includes('Nobody here'), 'the empty list')
    const before = state.asked.filter(u => u === '/balances').length
    state.balances = [{ tenantId: 't1', firstName: 'Kim', lastName: 'Harland', email: 'kim@t.dev', phone: null,
      unitNumber: 'APT 04', propertyId: 'p1', propertyName: 'Mountain View', balance: '460.00',
      creditAvailable: 0, creditOnAccount: 0, oldestDueDate: '2020-01-01', openInvoices: 1 }]
    await act(async () => { button(/^Emergency contacts$/)!.click() })
    await until(() => text().includes('Nobody is on a space right now.'), 'the roster')
    await act(async () => { button(/^Call list/)!.click() })
    await until(() => text().includes('Kim Harland'), 'Kim on the call list')
    expect(state.asked.filter(u => u === '/balances').length).toBeGreaterThan(before)
  })

  it('the call list is read again when the desk comes back to the page (a payment taken elsewhere meanwhile)', async () => {
    state.perms = { 'front_desk.view': true, 'balances.view': true }
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 300000, refetchOnWindowFocus: false, refetchOnMount: false } } })
    state.balances = [{ tenantId: 't1', firstName: 'Kim', lastName: 'Harland', email: 'kim@t.dev', phone: null,
      unitNumber: 'APT 04', propertyId: 'p1', propertyName: 'Mountain View', balance: '460.00',
      creditAvailable: 0, creditOnAccount: 0, oldestDueDate: '2020-01-01', openInvoices: 1 }]
    await act(async () => { root.render(<QueryClientProvider client={qc}><FrontDeskPage /></QueryClientProvider>) })
    await until(() => text().includes('Kim Harland'), 'Kim on the call list')
    // Off to another page (Kim pays there), then back to the Front Desk.
    await act(async () => { root.render(<QueryClientProvider client={qc}><div>Outstanding Balances</div></QueryClientProvider>) })
    state.balances = []
    const before = state.asked.filter(u => u === '/balances').length
    await act(async () => { root.render(<QueryClientProvider client={qc}><FrontDeskPage /></QueryClientProvider>) })
    await until(() => text().includes('Nobody here'), 'Kim gone from the call list')
    expect(state.asked.filter(u => u === '/balances').length).toBeGreaterThan(before)
  })

  it('the first open asks the server for each call list once', async () => {
    state.perms = { 'front_desk.view': true, 'balances.view': true }
    await open({ portal: true })
    await until(() => /people need contacting/.test(text()), 'the call count')
    expect(state.asked.filter(u => u === '/balances')).toHaveLength(1)
    expect(state.asked.filter(u => u === '/landlords/me/pending-tenants')).toHaveLength(1)
  })

  it('the emergency contact list is read again when the desk comes back to it', async () => {
    state.perms = { 'front_desk.view': true }
    window.history.replaceState(null, '', '/front-desk?tab=emergency')
    await open({ portal: true })
    await until(() => text().includes('Nobody is on a space right now.'), 'the roster')
    const before = state.asked.filter(u => u === '/emergency-contacts').length
    await act(async () => { button(/^Call list/)!.click() })
    await act(async () => { button(/^Emergency contacts$/)!.click() })
    await until(() => state.asked.filter(u => u === '/emergency-contacts').length > before, 'the roster read again')
  })

  it('the move-out list is read again when the desk comes back to it', async () => {
    state.perms = { 'front_desk.view': true, 'front_desk.mark_leaving': true }
    window.history.replaceState(null, '', '/front-desk?tab=moveouts')
    await open({ portal: true })
    await until(() => text().includes('Nobody is on a space right now.'), 'the move-outs list')
    const reads = () => state.asked.filter(u => u.startsWith('/leases/desk/residents')).length
    const before = reads()
    await act(async () => { button(/^Call list/)!.click() })
    await act(async () => { button(/^Move-outs$/)!.click() })
    await until(() => reads() > before, 'the move-outs read again')
  })

  it('a refused move-out list says so instead of "Nobody found"', async () => {
    state.perms = { 'front_desk.mark_leaving': true }
    state.refuse = { '/leases/desk/residents': { status: 500, error: 'The residents could not be read.' } }
    await open()
    await until(() => text().includes('The residents could not be read.'), 'the error')
    expect(text()).not.toContain('Nobody found')
  })

  it('a call list refused for its own reason (403) says that reason, not the switch', async () => {
    state.perms = { 'front_desk.view': true }
    state.refuse = { '/landlords/me/pending-tenants': { status: 403, error: 'You are not assigned to this property' } }
    await open()
    await until(() => text().includes('You are not assigned to this property.'), 'the server\u2019s reason')
    expect(text()).not.toContain('sign out and back in')
    expect(text()).not.toContain('ask the owner to turn on')
    expect(text()).not.toContain('Nobody here')
  })

  it('an empty call list with the balances still on their way never shows "Nobody here" or a count of 0', async () => {
    state.perms = { 'front_desk.view': true, 'balances.view': true }
    let release!: () => void
    state.balancesGate = new Promise<void>(r => { release = r })
    state.balances = [{ tenantId: 't1', firstName: 'Kim', lastName: 'Harland', email: 'kim@t.dev', phone: null,
      unitNumber: 'APT 04', propertyId: 'p1', propertyName: 'Mountain View', balance: '460.00',
      creditAvailable: 0, creditOnAccount: 0, oldestDueDate: '2020-01-01', openInvoices: 1 }]
    await open()
    await until(() => state.asked.includes('/landlords/me/pending-tenants'), 'the call list read')
    await act(async () => { await new Promise(r => setTimeout(r, 30)) })
    expect(text()).toContain('Loading…')
    expect(text()).not.toContain('Nobody here')
    expect(text()).not.toMatch(/\b0 people need contacting/)
    expect(button(/^Everyone/)!.textContent).toBe('Everyone')
    await act(async () => { release() })
    await until(() => text().includes('Kim Harland'), 'Kim on the call list')
    expect(text()).toContain('1 person needs contacting')
    expect(button(/^Everyone/)!.textContent).toBe('Everyone (1)')
  })

  it('with one list refused, the chips carry no counts (half a count is not said)', async () => {
    state.perms = { 'front_desk.view': true, 'balances.view': true }
    state.refuse = { '/balances': { status: 500, error: 'The balances could not be read' } }
    state.pending = [{ intentId: 'i1', firstName: 'Dana', lastName: 'Ortiz', email: 'dana@t.dev', phone: null,
      heldUnitNumber: 'RV 11', propertyName: 'Mountain View', inviteState: 'invited',
      inviteExpiresAt: '2099-01-01T00:00:00Z', leaseDocStatus: null, leaseWaitingOnRole: null,
      leaseWaitingOnName: null, householdPendingNames: null }]
    await open()
    await until(() => text().includes('Dana Ortiz') && text().includes('The balances could not be read.'), 'the half that loaded')
    expect(button(/^Everyone/)!.textContent).toBe('Everyone')
    expect(button(/^Accept the invite/)!.textContent).toBe('Accept the invite')
    expect(button(/^Call list/)!.textContent).toBe('Call list')
    expect(text()).not.toMatch(/need(s)? contacting/)
  })

  const expiredInvite = () => ({ intentId: 'i1', firstName: 'Dana', lastName: 'Ortiz', email: 'dana@t.dev', phone: null,
    heldUnitNumber: 'RV 11', propertyName: 'Mountain View', inviteState: 'invited',
    inviteExpiresAt: '2020-01-01T00:00:00Z', leaseDocStatus: null, leaseWaitingOnRole: null,
    leaseWaitingOnName: null, householdPendingNames: null })

  it('an expired invite says to press Re-send invite on the row, never a page the desk may not open', async () => {
    state.perms = { 'front_desk.view': true }
    state.pending = [expiredInvite()]
    await open()
    await until(() => text().includes('Dana Ortiz'), 'Dana on the call list')
    expect(text()).toContain("Dana's invite has expired. Press Re-send invite, then ask them to accept.")
    expect(text()).not.toContain('pending pool')
    expect(button(/^Re-send invite$/)).toBeTruthy()
  })

  // Renamed from 'a re-send the server refuses says its reason once; a
  // front-desk-only staffer is pointed at the owner or a manager', which
  // appended "Try again" to a refusal for good (a 400). A 4xx is final: it is
  // said as the server said it, and the call list is read again.
  it('a re-send that fails and may pass (5xx) says its reason once; a front-desk-only staffer is pointed at the owner or a manager', async () => {
    state.perms = { 'front_desk.view': true }
    state.pending = [expiredInvite()]
    state.patchFail = { status: 502, error: 'The email service did not answer' }
    await open()
    await until(() => !!button(/^Re-send invite$/), 'the button')
    await act(async () => { button(/^Re-send invite$/)!.click() })
    const said = 'The email service did not answer. Try again; if it keeps failing, ask the owner or a manager to re-send it.'
    await until(() => text().includes(said), 'the refusal')
    expect(text().split('The email service did not answer').length - 1).toBe(1)
    expect(text()).not.toContain('pending pool')
    expect(button(/^Re-send invite$/)).toBeTruthy()
  })

  it('a re-send refused for good (409 "They have already signed") says that once, never "Try again", and the call list is read again', async () => {
    state.perms = { 'front_desk.view': true }
    state.pending = [expiredInvite()]
    state.patchFail = { status: 409, error: 'They have already signed — their account is their own now.' }
    await open()
    await until(() => !!button(/^Re-send invite$/), 'the button')
    const asked = () => state.asked.filter(u => u === '/landlords/me/pending-tenants').length
    const before = asked()
    // They signed meanwhile: the list read again shows where they are now.
    state.pending = [{ ...expiredInvite(), leaseDocStatus: 'completed' }]
    await act(async () => { button(/^Re-send invite$/)!.click() })
    await until(() => text().includes('They have already signed — their account is their own now. The list shows where they are now.'), 'the refusal')
    await until(() => asked() > before, 'the call list read again')
    expect(text().split('They have already signed').length - 1).toBe(1)
    expect(text()).not.toContain('Try again')
    await until(() => text().includes('Lease signed for RV 11. Nothing needed.'), 'the row in its current phase')
    expect(button(/^Re-send invite$/)).toBeUndefined()
  })

  // Renamed from 'a re-send refused because the invite is gone (404) never
  // says "Try again"', which kept the row in the list read again. The owner
  // cancelled the invite meanwhile, so the list read again drops the row
  // (routes/landlords pending-tenants leaves cancelled invites out) — and the
  // refusal must not vanish with it.
  it('a re-send refused because the invite is gone (404): the row leaves the list read again, and the refusal is said once above the list, naming them, never "Try again"', async () => {
    state.perms = { 'tenants.create': true }
    state.pending = [expiredInvite()]
    state.patchFail = { status: 404, error: 'That invite no longer exists.' }
    await open()
    await until(() => !!button(/^Re-send invite$/), 'the button')
    const asked = () => state.asked.filter(u => u === '/landlords/me/pending-tenants').length
    const before = asked()
    state.pending = []   // cancelled meanwhile: the list read again no longer holds Dana
    await act(async () => { button(/^Re-send invite$/)!.click() })
    await until(() => asked() > before, 'the call list read again')
    // Dana is not on the list any more, so "The list shows where they are
    // now" would be false: the banner says she is gone and the step that works.
    const said = "Re-sending Dana Ortiz's invite: That invite no longer exists. Dana is no longer on this list, so there is no invite to re-send. If they should still get one, invite them again from the pending pool."
    await until(() => text().includes(said), 'the refusal above the list')
    await until(() => !button(/^Re-send invite$/), 'the row gone')
    expect(text().split('That invite no longer exists').length - 1).toBe(1)
    expect(text()).not.toContain('Try again')
    expect(text()).not.toContain('The list shows where they are now')
  })

  it('a re-send refused with a bare "Forbidden" whose person the list read again no longer holds: says they are gone and to ask the owner or a manager, never that the list shows them', async () => {
    state.perms = { 'front_desk.view': true }
    state.pending = [expiredInvite()]
    state.patchFail = { status: 403, error: 'Forbidden' }
    await open()
    await until(() => !!button(/^Re-send invite$/), 'the button')
    const asked = () => state.asked.filter(u => u === '/landlords/me/pending-tenants').length
    const before = asked()
    state.pending = []   // another company's invite: the list read again does not hold Dana
    await act(async () => { button(/^Re-send invite$/)!.click() })
    await until(() => asked() > before, 'the call list read again')
    const said = "Re-sending Dana Ortiz's invite: That invite belongs to a company you are not on, so it cannot be re-sent from here. Dana is no longer on this list, so there is no invite to re-send. If they should still get one, ask the owner or a manager to invite them again."
    await until(() => text().includes(said), 'the refusal above the list')
    expect(text()).not.toContain('The list shows where they are now')
    expect(text()).not.toContain('Forbidden')
    expect(text()).not.toContain('Try again')
  })

  it('a re-send that fails and may pass (500), whose person then leaves the list read again: the banner says the reason and that they are gone, never "Try again"', async () => {
    state.perms = { 'tenants.create': true }
    state.pending = [expiredInvite()]
    state.patchFail = { status: 500, error: 'The invite could not be sent' }
    await open()
    await until(() => !!button(/^Re-send invite$/), 'the button')
    const asked = () => state.asked.filter(u => u === '/landlords/me/pending-tenants').length
    const before = asked()
    state.pending = []   // the owner cancelled the invite meanwhile
    await act(async () => { button(/^Re-send invite$/)!.click() })
    await until(() => asked() > before, 'the call list read again')
    const said = "Re-sending Dana Ortiz's invite: The invite could not be sent. Dana is no longer on this list, so there is no invite to re-send. If they should still get one, invite them again from the pending pool."
    await until(() => text().includes(said), 'the refusal above the list')
    expect(text()).not.toContain('Try again')
    expect(text().split('The invite could not be sent').length - 1).toBe(1)
  })

  it('a re-send banner for somebody no longer on the list has a × that puts it away', async () => {
    state.perms = { 'tenants.create': true }
    state.pending = [expiredInvite()]
    state.patchFail = { status: 404, error: 'That invite no longer exists.' }
    await open()
    await until(() => !!button(/^Re-send invite$/), 'the button')
    state.pending = []
    await act(async () => { button(/^Re-send invite$/)!.click() })
    await until(() => text().includes('That invite no longer exists.'), 'the banner')
    const x = host.querySelector('button[aria-label="Put away the message about Dana Ortiz"]') as HTMLButtonElement
    expect(x).toBeTruthy()
    expect(x.classList.contains('btn')).toBe(true)
    await act(async () => { x.click() })
    await until(() => !text().includes('That invite no longer exists.'), 'the banner put away')
  })

  it('a re-send turned away by the rate limit (429) may pass: it says so in plain words, with try again', async () => {
    state.perms = { 'front_desk.view': true }
    state.pending = [expiredInvite()]
    state.patchFail = { status: 429, error: '' }
    await open()
    await until(() => !!button(/^Re-send invite$/), 'the button')
    await act(async () => { button(/^Re-send invite$/)!.click() })
    await until(() => text().includes('GAM was too busy to send it just now. Try again; if it keeps failing, ask the owner or a manager to re-send it.'), 'the sentence')
    expect(text()).not.toContain('status code')
    expect(text()).not.toContain('The list shows where they are now')
    expect(button(/^Re-send invite$/)).toBeTruthy()
  })

  // Renamed from 'a re-send refused with the route's bare "Forbidden" (another
  // company's invite) is said in plain words, never the raw word or a switch':
  // the sentence now ends with the step that works.
  it('a re-send refused with the route\'s bare "Forbidden" (another company\'s invite) is said in plain words with the next step (the owner or a manager), never the raw word or a switch', async () => {
    state.perms = { 'front_desk.view': true }
    state.pending = [expiredInvite()]
    state.patchFail = { status: 403, error: 'Forbidden' }
    await open()
    await until(() => !!button(/^Re-send invite$/), 'the button')
    await act(async () => { button(/^Re-send invite$/)!.click() })
    await until(() => text().includes('That invite belongs to a company you are not on, so it cannot be re-sent from here. The list shows where they are now. If they should still get one, ask the owner or a manager to re-send it.'), 'the sentence with its next step')
    expect(text()).not.toContain('Forbidden')
    expect(text()).not.toContain('Try again')
    expect(text()).not.toContain('not open to you right now')
  })

  it('a re-send that fails for somebody who can open the pending pool names it', async () => {
    state.perms = { 'tenants.create': true }
    state.pending = [expiredInvite()]
    state.patchFail = { status: 500, error: 'The invite could not be sent' }
    await open()
    await until(() => !!button(/^Re-send invite$/), 'the button')
    await act(async () => { button(/^Re-send invite$/)!.click() })
    await until(() => text().includes('The invite could not be sent. Try again, or re-send it from the pending pool.'), 'the refusal')
  })

  it('a re-send refused by a switch (bare 403) names the switch, once', async () => {
    state.perms = { 'front_desk.view': true }
    state.pending = [expiredInvite()]
    state.patchFail = { status: 403, error: 'Insufficient permissions' }
    await open()
    await until(() => !!button(/^Re-send invite$/), 'the button')
    await act(async () => { button(/^Re-send invite$/)!.click() })
    await until(() => text().includes('Re-sending an invite is not open to you right now.'), 'the refusal')
    expect(text()).not.toContain('Insufficient permissions')
    expect(text()).not.toContain('Try again')
  })
})

// The call list never sends somebody to a page or a role they do not have.
describe('call-list sentences fit who is looking', () => {
  const lease = (o: Record<string, any>) => ({ intentId: 'i9', firstName: 'Dana', lastName: 'Ortiz', email: 'dana@t.dev',
    phone: null, heldUnitNumber: 'RV 11', propertyName: 'Mountain View', inviteState: 'invited',
    inviteExpiresAt: null, leaseDocStatus: null, leaseWaitingOnRole: null, leaseWaitingOnName: null,
    householdPendingNames: null, ...o })
  const payLink = () => ({ tenantId: null, payLinkId: 'pl1', firstName: 'Russ', lastName: 'Fuller', email: 'russ@t.dev',
    phone: null, unitNumber: null, propertyId: 'p1', propertyName: 'Mountain View', balance: '37.60',
    creditAvailable: 0, creditOnAccount: 0, oldestDueDate: '2020-01-01', openInvoices: 1,
    payLink: { label: 'Propane', items: [] } })

  it('a drafted lease waits on the owner\'s signature for a staffer, and on YOUR signature for the owner', async () => {
    state.perms = { 'front_desk.view': true }
    state.pending = [lease({ leaseDocStatus: 'sent', leaseWaitingOnRole: 'landlord' })]
    await open()
    await until(() => text().includes('Dana Ortiz'), 'Dana')
    expect(text()).toContain("Their lease for RV 11 is drafted and waiting on the owner's signature.")
    expect(text()).toContain('Waiting on the owner to sign')
    expect(text()).not.toMatch(/YOUR signature|Waiting on you to sign/)
    act(() => root.unmount())
    root = createRoot(host)
    state.isOwner = true
    await open()
    await until(() => text().includes('Dana Ortiz'), 'Dana for the owner')
    expect(text()).toContain('Their lease for RV 11 is drafted and waiting on YOUR signature.')
    expect(text()).toContain('Waiting on you to sign')
  })

  it('a voided lease offers no Re-send invite (it would not replace the lease) and says who sends a new one', async () => {
    state.perms = { 'front_desk.view': true }
    state.pending = [lease({ leaseDocStatus: 'voided' })]
    await open()
    await until(() => text().includes('Dana Ortiz'), 'Dana')
    expect(text()).toContain('Their lease for RV 11 was voided. Ask the owner or a manager to send a new lease — re-sending the invite does not replace it.')
    expect(button(/^Re-send invite$/)).toBeUndefined()
    act(() => root.unmount())
    root = createRoot(host)
    state.perms = { 'front_desk.view': true, 'esign.tab.documents': true }
    await open()
    await until(() => text().includes('Dana Ortiz'), 'Dana for an E-Sign staffer')
    expect(text()).toContain('Send a new lease from E-Sign')
  })

  it('an accepted household row names E-Sign only for somebody who can open it', async () => {
    state.perms = { 'front_desk.view': true }
    state.pending = [lease({ inviteState: 'accepted', householdPendingNames: ['Sam Ortiz'] })]
    await open()
    await until(() => text().includes('Dana Ortiz'), 'Dana')
    expect(text()).toContain("Their lease hasn't been drafted yet; ask the owner or a manager to check it.")
    expect(text()).not.toContain('check E-Sign')
  })

  it('a pay link names the register only for somebody who can open it', async () => {
    state.perms = { 'front_desk.view': true, 'balances.view': true }
    state.balances = [payLink()]
    await open()
    await until(() => text().includes('Russ Fuller'), 'Russ')
    expect(text()).toContain('They can pay the link, or ask the owner or a manager to settle it at the register.')
    expect(text()).not.toContain('Register →')
    act(() => root.unmount())
    root = createRoot(host)
    state.perms = { 'front_desk.view': true, 'balances.view': true, 'pos.tab.register': true }
    await open()
    await until(() => text().includes('Russ Fuller'), 'Russ for a register staffer')
    expect(text()).toContain('settle it here: Register → open tickets & pay links.')
  })

  it('reads the server\'s snake_case rows as they arrive on the wire (balances and the call list)', async () => {
    state.perms = { 'front_desk.view': true, 'balances.view': true }
    state.wire = (x: any) => camelCaseKeys(x)
    state.balances = [{ tenant_id: null, pay_link_id: 'pl1', first_name: 'Russ', last_name: 'Fuller', email: 'russ@t.dev',
      phone: null, unit_number: null, property_id: 'p1', property_name: 'Mountain View', balance: '37.60',
      credit_available: 0, credit_on_account: 0, oldest_due_date: '2020-01-01', open_invoices: 1,
      pay_link: { label: 'Propane', items: [] } }]
    state.pending = [{ intent_id: 'i1', first_name: 'Dana', last_name: 'Ortiz', email: 'dana@t.dev', phone: null,
      held_unit_number: 'RV 11', property_name: 'Mountain View', invite_state: 'invited',
      invite_expires_at: '2020-01-01T00:00:00Z', lease_doc_status: null, lease_waiting_on_role: null,
      lease_waiting_on_name: null, household_pending_names: null }]
    await open()
    await until(() => text().includes('Russ Fuller') && text().includes('Dana Ortiz'), 'both rows')
    expect(text()).toContain('Russ owes $37.60 on an emailed pay link')
    expect(text()).toContain("Dana's invite has expired. Press Re-send invite, then ask them to accept.")
    expect(button(/^Re-send invite$/)).toBeTruthy()
  })
})
