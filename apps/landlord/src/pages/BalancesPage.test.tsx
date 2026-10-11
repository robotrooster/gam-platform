/**
 * S655 money plan, Step 14 (fix round) — Outstanding Balances and the Front
 * Desk call list.
 *
 * A pay link's breakdown is read from the register with the link's own
 * property (an account that owns two companies names which register it means;
 * without it the read is refused and Adjust cannot find the link). And Record
 * payment at the top finds everyone on the list — including somebody whose
 * only money owed is something the desk does not take — with the reason
 * beside them (decisions #29).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from 'react-query'

const server = vi.hoisted(() => ({
  balances: [] as any[],
  leases: [] as any[],
  gets: [] as string[],
  posts: [] as { url: string; body: any }[],
  user: { role: 'landlord', permissions: {} } as any,
}))

vi.mock('../lib/api', () => ({
  api: {
    get: async (url: string) => {
      server.gets.push(url)
      if (url.startsWith('/balances')) return { data: { success: true, data: server.balances } }
      throw new Error(`unexpected api.get ${url}`)
    },
  },
  apiGet: async (url: string) => {
    server.gets.push(url)
    if (url === '/leases') return server.leases
    if (url === '/landlords/me/pending-tenants') return []
    // A link for a reservation plus one other line: Adjust reads the link as stored, by its property.
    if (url.startsWith('/pos/tickets/')) {
      return { label: 'Stay balance', total: 142, items: [
        { id: 'stay1', name: 'RV 33 stay', qty: 1, price: 100, reservation: true },
        { name: 'Electric', qty: 1, price: 42 }] }
    }
    if (url.startsWith('/pos/pay-links?propertyId=')) {
      return [{ id: 'pl1', status: 'open', items: [
        { id: 'stay1', name: 'RV 33 stay', qty: 1, price: 100 }, { id: null, name: 'Electric', qty: 1, price: 42 }] }]
    }
    if (url.startsWith('/balances/')) return []
    if (url.includes('/record-manual/quote')) return deskQuote(url.split('/')[2])
    if (url.startsWith('/payments?type=rent')) return []
    throw new Error(`unexpected GET ${url}`)
  },
  apiPost: vi.fn(async (url: string, body: any) => {
    server.posts.push({ url, body })
    if (url.endsWith('/record-manual')) return { success: true, data: { amountSettled: body.amountTendered } }
    return { success: true, data: {} }
  }),
  apiPatch: vi.fn(async () => ({})),
  apiDelete: vi.fn(async () => ({})),
  apiPut: vi.fn(async () => ({})),
}))
vi.mock('../context/AuthContext', () => ({ useAuth: () => ({ user: server.user }) }))
vi.mock('../lib/terminal', () => ({ TAP_WINDOW_SECONDS: 10 }))

import { BalancesPage } from './BalancesPage'
import { FrontDeskPage } from './FrontDeskPage'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

/** The desk quote for one household's $460 rent charge. */
function deskQuote(id: string) {
  return {
    anchorPaymentId: id, anchorOpen: true, paymentsPaused: false,
    rows: [{ id, leaseId: `L-${id}`, type: 'rent', entryDescription: 'RENT', amount: 460, dueDate: '2026-10-01',
             creditAlreadyApplied: 0, notes: null, unitNumber: 'MH 04', propertyName: 'Oak Park' }],
    currentTotal: 460, oldBalance: [], oldBalanceTotal: 0, payOnline: [], payOnlineTotal: 0, paused: [], pausedTotal: 0,
    clearing: 0, creditAlreadyApplied: 0, creditAvailable: 0, creditSetAsideElsewhere: 0, creditOnFile: 0,
    owedIfUsed: 460, owedIfSaved: 460, fullBalance: 460, scheduledRetries: [],
  }
}
const owingRow = (tenantId: string, first: string, paymentId: string) => ({
  tenantId, firstName: first, lastName: 'Moss', phone: null, email: null, unitNumber: 'MH 04',
  propertyId: 'prop-op', propertyIds: ['prop-op'], propertyName: 'Oak Park', balance: '460.00',
  creditAvailable: 0, creditOnAccount: 0, months: [{ month: '2026-10', amount: 460 }], daysLate: 0, clearing: 0,
  workTrade: false, status: 'owes', recordWith: [{ landlordId: 'll1', paymentId }],
})

const payLinkRow = {
  tenantId: null, payLinkId: 'pl1', firstName: 'Andres', lastName: 'Razo', phone: null, email: 'a@x.test',
  unitNumber: null, propertyId: 'prop-mv', propertyIds: ['prop-mv'], propertyName: 'Mountain View',
  balance: '42.00', creditAvailable: 0, creditOnAccount: 0, oldestDueDate: '2026-10-01',
  months: [{ month: '2026-10', amount: 42 }], daysLate: 0, clearing: 0, workTrade: false,
  status: 'owes', statusLabel: 'Owes', recordWith: [], openInvoices: 1,
  payLink: { label: 'Move-out bill', items: [{ name: 'Electric', qty: 1, price: 42 }] },
}

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  server.gets = []; server.posts = []; server.balances = []; server.leases = []
  server.user = { role: 'landlord', permissions: {} }
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

async function render(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  await act(async () => { root.render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>) })
}
const text = () => host.textContent ?? ''
async function until(check: () => boolean, what: string) {
  for (let i = 0; i < 150; i++) {
    if (check()) return
    await act(async () => { await new Promise(r => setTimeout(r, 10)) })
  }
  throw new Error(`timed out waiting for ${what}\n${text()}`)
}
const button = (re: RegExp) => [...host.querySelectorAll('button')].find(b => re.test(b.textContent ?? ''))
async function type(el: HTMLInputElement, v: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  await act(async () => { setter.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })) })
}
const linkReads = () => server.gets.filter(u => u.startsWith('/pos/tickets/pl1'))

describe('the pay-link breakdown is given its property', () => {
  it('on Outstanding Balances: the register read names the link’s property, and Adjust finds the link', async () => {
    server.balances = [payLinkRow]
    await render(<BalancesPage />)
    await until(() => text().includes('Andres Razo'), 'the pay link row')
    const row = [...host.querySelectorAll('tr.cd-row')].find(tr => tr.textContent?.includes('Andres Razo')) as HTMLElement
    await act(async () => { row.click() })
    await until(() => linkReads().length > 0, 'the register read')
    expect(linkReads()[0]).toBe('/pos/tickets/pl1?kind=pay_link&propertyId=prop-mv')
    await until(() => !!button(/^Adjust the other lines$/), 'Adjust')
    await act(async () => { button(/^Adjust the other lines$/)!.click() })
    await until(() => text().includes('New total'), 'the link open to adjust')
    expect(text()).not.toContain('property could not be found')
    expect(server.gets).toContain('/pos/pay-links?propertyId=prop-mv')
  })

  it('on the Front Desk call list too', async () => {
    server.balances = [payLinkRow]
    await render(<FrontDeskPage />)
    await until(() => text().includes('Andres Razo'), 'the pay link line')
    await act(async () => { button(/what.s on it/)!.click() })
    await until(() => linkReads().length > 0, 'the register read')
    expect(linkReads()[0]).toBe('/pos/tickets/pl1?kind=pay_link&propertyId=prop-mv')
  })
})

describe('Record payment at the top finds everyone on the list', () => {
  it('a resident whose only money owed is an open register ticket is found, with the reason, and can pay ahead', async () => {
    server.balances = [{
      tenantId: 't9', ticketId: 'tk1', firstName: 'Bob', lastName: 'Ray', phone: null, email: null, unitNumber: null,
      propertyId: 'prop-mv', propertyIds: ['prop-mv'], propertyName: 'Mountain View', balance: '25.00',
      creditAvailable: 0, creditOnAccount: 0, months: [{ month: '2026-10', amount: 25 }], daysLate: 0, clearing: 0,
      workTrade: false, status: 'owes', recordWith: [], ticket: { note: null, items: [] },
    }]
    server.leases = [{ id: 'L9', status: 'active', propertyId: 'prop-mv', unitNumber: 'RV 33', propertyName: 'Mountain View',
      tenants: [{ tenantId: 't9', status: 'active', firstName: 'Bob', lastName: 'Ray' }] }]
    await render(<BalancesPage />)
    await until(() => text().includes('Bob Ray'), 'the list')
    await act(async () => { button(/^Record payment$/)!.click() })
    await type(host.querySelector('input[placeholder="Name or space…"]') as HTMLInputElement, 'bob')
    await until(() => text().includes('on an open register ticket'), 'Bob found')
    expect(text()).toContain('owes $25.00 on an open register ticket — settle it at the register.')
    const item = [...host.querySelectorAll('.cd-picker-item')].find(e => e.textContent?.includes('Bob Ray')) as HTMLButtonElement
    expect(item.tagName).toBe('BUTTON')
    await act(async () => { item.click() })
    await until(() => text().includes('Post a payment'), 'the post-a-payment form')
  })

  it('front desk staff never see a grand total the server did not send (decisions #25)', async () => {
    server.user = { role: 'onsite_manager', permissions: { 'balances.view': true, take_payment: true } }
    server.balances = [payLinkRow]
    await render(<BalancesPage />)
    await until(() => text().includes('Andres Razo'), 'the list')
    expect(text()).not.toContain('Total owed')
  })
})

describe('what the desk window recorded is said once, after it closes', () => {
  it('said when its window closes — and never again after another window is canceled', async () => {
    server.balances = [owingRow('t1', 'Glenda', 'p1'), owingRow('t2', 'Ray', 'p2')]
    await render(<BalancesPage />)
    await until(() => text().includes('Glenda Moss') && text().includes('Ray Moss'), 'the list')
    const recordFor = (who: string) => {
      const tr = [...host.querySelectorAll('tr.cd-row')].find(r => r.textContent?.includes(who)) as HTMLElement
      return [...tr.querySelectorAll('button')].find(b => b.textContent === 'Record payment') as HTMLButtonElement
    }
    await act(async () => { recordFor('Glenda Moss').click() })
    await until(() => !!button(/^Cash$/), 'Glenda’s window')
    await act(async () => { button(/^Cash$/)!.click() })
    await type(host.querySelector('.cd-window input.form-input.mono') as HTMLInputElement, '460')
    await until(() => !!button(/^Record \$460\.00/) && !button(/^Record \$460\.00/)!.disabled, 'Record')
    await act(async () => { button(/^Record \$460\.00/)!.click() })
    await until(() => !!button(/^Done$/), 'recorded')
    await act(async () => { button(/^Done$/)!.click() })
    await until(() => !!host.querySelector('.cd-notice'), 'the notice')
    expect(host.querySelector('.cd-notice')?.textContent).toContain('Recorded $460.00 from Glenda Moss.')
    // Another household's window, backed out of: nothing recorded is said.
    await act(async () => { recordFor('Ray Moss').click() })
    await until(() => !!button(/^Cancel$/), 'Ray’s window')
    expect(host.querySelector('.cd-notice')).toBeNull()
    await act(async () => { button(/^Cancel$/)!.click() })
    expect(host.querySelector('.cd-window')).toBeNull()
    expect(host.querySelector('.cd-notice')).toBeNull()
    expect(server.posts.filter(p => p.url.endsWith('/record-manual'))).toHaveLength(1)
  })
})
