/**
 * S655 money plan, Step 14 — the tenant page.
 *
 * Nic (10/2): the credit card shows ALL the credit on their account and what
 * of it would pay their bills right now. Staff screens are foolproof: a window
 * that adds money owed closes only from its own buttons, and not while it is
 * saving. Days are calendar days on this device — a due date never shows as the
 * day before, and "today" is never tomorrow's UTC day in the evening.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from 'react-query'
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom'

const server = vi.hoisted(() => ({
  profile: null as any,
  gets: [] as string[],
  posts: [] as { url: string; body: any }[],
  /** When set, a POST waits on it (in flight). */
  postHold: null as Promise<void> | null,
}))

vi.mock('../lib/api', () => ({
  apiGet: async (url: string) => {
    server.gets.push(url)
    if (url === '/tenants/t1/profile' || url.startsWith('/tenants/t1/profile?')) return JSON.parse(JSON.stringify(server.profile))
    return []
  },
  apiPost: async (url: string, body: any) => {
    server.posts.push({ url, body })
    if (server.postHold) await server.postHold
    return { success: true, data: {} }
  },
  apiPatch: async () => ({ success: true, data: {} }),
}))
const auth = vi.hoisted(() => ({ user: { role: 'landlord', permissions: {} as Record<string, boolean> } }))
vi.mock('../context/AuthContext', () => ({ useAuth: () => ({ user: auth.user }) }))
vi.mock('../components/dialogs', () => ({
  toast: Object.assign(vi.fn(), { error: vi.fn() }),
  appConfirm: vi.fn(async () => false),
}))

import { TenantDetailPage } from './TenantDetailPage'
import { appConfirm } from '../components/dialogs'
import { localToday } from '../lib/creditDesk'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const profile = (over: any = {}) => ({
  tenant: { firstName: 'Glenda', lastName: 'Moss', email: 'glenda@example.test', phone: null, achVerified: true, accountCreated: '2026-01-05T17:00:00.000Z' },
  units: [{ id: 'u1', unitNumber: 'MH 04', propertyName: 'Oak Park', street1: '1 Main', city: 'Mesa', rentAmount: 460,
            startDate: '2026-01-01T00:00:00.000Z', endDate: null, isCurrent: true }],
  payments: [],
  maintenance: [],
  stats: { onTimeRate: 100, firstPayment: '2026-01-01T00:00:00.000Z', tenantMonths: 9, totalPaid: 4140, unitsOccupied: 1,
           settledCount: 9, lateCount: 0, failedCount: 0, avgPayment: 460 },
  credit: null,
  ...over,
})

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  server.gets = []; server.posts = []; server.postHold = null; server.profile = profile()
  auth.user = { role: 'landlord', permissions: {} }
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

async function render() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  await act(async () => {
    root.render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={['/tenants/t1']}>
          <Routes>
            <Route path="/tenants/:id" element={<TenantDetailPage />} />
            <Route path="/tenants/:id/report" element={<ReportProbe />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>)
  })
  await until(() => text().includes('Glenda Moss'), 'the page')
}
function ReportProbe() {
  const loc = useLocation()
  return <div className="report-probe">REPORT {loc.pathname}{loc.search}</div>
}
const text = () => host.textContent ?? ''
const btn = (re: RegExp) => [...host.querySelectorAll('button')].find(b => re.test(b.textContent ?? ''))
async function until(check: () => boolean, what: string) {
  for (let i = 0; i < 150; i++) {
    if (check()) return
    await act(async () => { await new Promise(r => setTimeout(r, 10)) })
  }
  throw new Error(`timed out waiting for ${what}\n${text()}`)
}
async function setValue(el: HTMLInputElement, v: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  await act(async () => { setter.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })) })
}

describe('the account credit card', () => {
  it('shows the total on their account and what of it can pay now, each kind named', async () => {
    server.profile = profile({ credit: { total: 300, usable: 120, paidAhead: 200, fromLandlord: 100, depositInterest: 0 } })
    await render()
    const card = host.querySelector('.cd-credit-card')!
    expect(card.textContent).toContain('$300.00 on their account — $120.00 of it can pay what they owe now.')
    expect(card.textContent).toContain('Paid ahead$200.00')
    expect(card.textContent).toContain('Credit you gave$100.00')
    expect(card.textContent).not.toContain('Statutory interest')
    expect(card.textContent).toContain('pays a bill by itself only when it covers that whole bill')
  })
  it('is left out when there is no credit', async () => {
    await render()
    expect(host.querySelector('.cd-credit-card')).toBeNull()
  })
})

describe('days are calendar days', () => {
  it('a due date or a start date sent as midnight UTC shows as its own day, and each status in words', async () => {
    server.profile = profile({
      payments: [{ id: 'p1', dueDate: '2026-10-01T00:00:00.000Z', propertyName: 'Oak Park', unitNumber: 'MH 04', amount: 460, status: 'paid_via_deposit' }],
    })
    await render()
    expect(text()).toContain('Oct 1, 2026')
    expect(text()).toContain('Paid from deposit')
    expect(text()).not.toContain('Paid via deposit')
    expect(text()).toContain('Jan 1, 2026 - Present')
    expect(text()).toContain('January 2026')
  })
})

describe('each status wears its own color', () => {
  it('a voided charge is muted, never the amber of a bill still owed; paid from deposit is green', async () => {
    server.profile = profile({
      payments: [
        { id: 'p1', dueDate: '2026-10-01', propertyName: 'Oak Park', unitNumber: 'MH 04', amount: 50, status: 'voided' },
        { id: 'p2', dueDate: '2026-10-01', propertyName: 'Oak Park', unitNumber: 'MH 04', amount: 460, status: 'pending' },
        { id: 'p3', dueDate: '2026-09-01', propertyName: 'Oak Park', unitNumber: 'MH 04', amount: 460, status: 'paid_via_deposit' },
      ],
    })
    await render()
    const badge = (label: string) => [...host.querySelectorAll('span.badge')].find(b => b.textContent === label)!
    expect(badge('Voided').className).toContain('badge-muted')
    expect(badge('Voided').className).not.toContain('badge-amber')
    expect(badge('Not paid yet').className).toContain('badge-amber')
    expect(badge('Paid from deposit').className).toContain('badge-green')
  })
})

describe('Add a charge', () => {
  it('starts on today’s calendar day, and closes only from its own buttons — not while the charge is being added', async () => {
    let release!: () => void
    server.postHold = new Promise<void>(r => { release = r })
    await render()
    await act(async () => { btn(/Add a charge/)!.click() })
    await until(() => !!host.querySelector('.modal-overlay'), 'the window')
    const modal = host.querySelector('.modal-overlay')!
    expect((modal.querySelector('input[type="date"]') as HTMLInputElement).value).toBe(localToday())
    await act(async () => { (modal as HTMLElement).click() })
    expect(host.querySelector('.modal-overlay')).not.toBeNull()
    const inputs = [...modal.querySelectorAll('input.form-input')] as HTMLInputElement[]
    await setValue(inputs[0], '50')
    await setValue(inputs[1], 'Parking in the fire lane')
    await act(async () => { btn(/^Add charge$/)!.click() })
    await until(() => text().includes('Adding…'), 'the charge on its way')
    expect(btn(/^Cancel$/)!.disabled).toBe(true)
    await act(async () => { btn(/^Cancel$/)!.click() })
    await act(async () => { (host.querySelector('.modal-overlay') as HTMLElement).click() })
    expect(host.querySelector('.modal-overlay')).not.toBeNull()
    await act(async () => { release() })
    await until(() => !host.querySelector('.modal-overlay'), 'the window closed by its result')
    expect(server.posts.filter(p => p.url === '/one-off-charges')).toHaveLength(1)
    expect(server.posts[0].body).toMatchObject({ tenantId: 't1', chargeType: 'violation', amount: 50, incidentDate: localToday() })
  })
})

describe('10/6 (Nic): "Delete this late fee" on the Payment History', () => {
  it('shows a gold button only on a line the server marks, asks in-app first, then deletes it', async () => {
    server.profile = profile({
      payments: [
        { id: 'lf1', type: 'late_fee', dueDate: '2026-10-06', propertyName: 'Oak Park', unitNumber: 'MH 04', amount: 0, status: 'settled', canDeleteLateFee: true },
        { id: 'lf2', type: 'late_fee', dueDate: '2026-09-06', propertyName: 'Oak Park', unitNumber: 'MH 04', amount: 0, status: 'settled' },
      ],
    })
    ;(appConfirm as any).mockClear()
    await render()
    const buttons = [...host.querySelectorAll('button')].filter(b => b.textContent === 'Delete this late fee')
    expect(buttons).toHaveLength(1)
    expect(buttons[0].className).toContain('btn-primary')
    // Declined: nothing is sent.
    await act(async () => { buttons[0].click() })
    expect(appConfirm).toHaveBeenCalledTimes(1)
    expect(server.posts).toEqual([])
    // Confirmed: deleted.
    ;(appConfirm as any).mockImplementationOnce(async () => true)
    await act(async () => { btn(/^Delete this late fee$/)!.click() })
    await until(() => server.posts.length === 1, 'the delete')
    expect(server.posts[0].url).toBe('/payments/lf1/delete-late-fee')
  })
})

describe('10/12 (Nic): the Payment History is the household\'s, with what each charge is for, a page at a time', () => {
  const charge = (i: number) => ({ id: `c${i}`, type: 'rent', label: i % 2 ? 'Electric' : 'Rent', detail: null, dueDate: '2026-10-01',
    propertyName: 'Oak Park', unitNumber: 'MH 04', amount: 460, status: 'pending' })

  it('says what each charge is for, and turns pages from the server — no 36-row cap', async () => {
    server.profile = profile({
      payments: Array.from({ length: 50 }, (_, i) => charge(i)),
      paymentsPage: { page: 1, pageSize: 50, total: 57 },
    })
    await render()
    expect(text()).toContain("What it's for")
    expect(text()).toContain('Electric')
    expect(text()).toContain('Charges 1–50 of 57, newest first')
    const older = btn(/^Older$/)!
    expect(older.className).toContain('btn-primary')
    expect(btn(/^Newer$/)!.disabled).toBe(true)
    server.profile = profile({ payments: Array.from({ length: 7 }, (_, i) => charge(50 + i)), paymentsPage: { page: 2, pageSize: 50, total: 57 } })
    await act(async () => { older.click() })
    await until(() => server.gets.includes('/tenants/t1/profile?historyPage=2'), 'page two')
    await until(() => text().includes('Charges 51–57 of 57'), 'page two on screen')
    expect(btn(/^Older$/)!.disabled).toBe(true)
  })

  it('one page needs no pager', async () => {
    server.profile = profile({ payments: [charge(1)], paymentsPage: { page: 1, pageSize: 50, total: 1 } })
    await render()
    expect(text()).not.toContain('newest first')
    expect(btn(/^Older$/)).toBeUndefined()
  })

  it('the health card shows the one figure in the shared color and opens the full report', async () => {
    server.profile = profile({ stats: { ...profile().stats, onTimeRate: 72,
      health: { percent: 72, onTime: 8, counted: 11, paidLate: 2, partial: 1, outstanding: 0, label: '72%, 8 of 11 months' } } })
    await render()
    expect(text()).toContain('72%, 8 of 11 months')
    // 10/12 (Nic): all time, since the household joined GAM — never "last 12 months".
    expect(text()).toContain('since joining GAM')
    expect(text()).not.toContain('last 12 months')
    expect(text()).toContain('Needs attention')
    expect(text()).toContain('8 of 11')
    expect(btn(/^Full report$/)!.className).toContain('btn-primary')
  })

  // 10/12: the report's gate is "View all payments". Staff who see the health
  // through the books permission are not offered a report they cannot open.
  it('staff with only the books permission see the health but no way into the report', async () => {
    auth.user = { role: 'property_manager', permissions: { 'books.view': true } }
    server.profile = profile({ stats: { ...profile().stats, onTimeRate: 72,
      health: { percent: 72, onTime: 8, counted: 11, paidLate: 2, partial: 1, outstanding: 0, label: '72%, 8 of 11 months' } } })
    await render()
    expect(text()).toContain('72%, 8 of 11 months')
    expect(text()).not.toContain('Full report')
    expect(btn(/^Full report$/)).toBeUndefined()
  })
})

// 10/13 (Nic): "Tenants list + tenant profile: split health BY LEASE."
describe('payment health, lease by lease', () => {
  const leaseHealth = (leaseId: string, unitNumber: string, percent: number | null, current = true, status = current ? 'active' : 'expired') => ({
    leaseId, unitNumber, propertyName: 'Mountain View', current, status, startDate: '2026-01-01', endDate: null,
    health: percent === null ? null : {
      percent, onTime: percent === 100 ? 1 : 0, counted: 1, paidLate: percent === 100 ? 0 : 1, partial: 0, outstanding: 0,
      label: `${percent}%, ${percent === 100 ? 1 : 0} of 1 month`,
    },
  })
  const click = async (el: Element | null | undefined) => { await act(async () => { (el as HTMLElement).click() }) }

  it('a person on two leases sees each lease\'s own health, each opening its own report — never one number for both', async () => {
    server.profile = profile({ stats: { ...profile().stats, onTimeRate: 50,
      health: { percent: 50, onTime: 1, counted: 2, paidLate: 1, partial: 0, outstanding: 0, label: '50%, 1 of 2 months' },
      healthByLease: [leaseHealth('L30', 'RV 30', 100), leaseHealth('L31', 'RV 31', 0)] } })
    await render()
    expect(text()).toContain('Payment Health — by lease')
    const blocks = [...host.querySelectorAll('[data-lease]')]
    expect(blocks.map(b => b.getAttribute('data-lease'))).toEqual(['L30', 'L31'])
    expect(blocks[0].textContent).toContain('RV 30 · Mountain View')
    expect(blocks[0].textContent).toContain('100%, 1 of 1 month')
    expect(blocks[1].textContent).toContain('0%, 0 of 1 month')
    expect(blocks[1].textContent).toContain('1 late, 0 partial, 0 outstanding')
    // The tile names each lease; the household's one number is not shown.
    expect(text()).toContain('RV 30 100% · RV 31 0%')
    expect(text()).not.toContain('50%, 1 of 2 months')
    await click([...blocks[1].querySelectorAll('button')].find(b => b.textContent === 'Report'))
    await until(() => text().includes('REPORT /tenants/t1/report?leaseId=L31'), 'that lease\'s report')
  })

  // 10/13 review: Arturo Melendez's new MH 15 lease, waiting for signatures,
  // read "Ended" beside his MH 23.
  it('each lease says where it stands: Current, Pending (not signed yet) or Ended', async () => {
    server.profile = profile({ stats: { ...profile().stats,
      healthByLease: [leaseHealth('L23', 'MH 23', 100), leaseHealth('L15', 'MH 15', null, false, 'pending'), leaseHealth('L09', 'MH 09', 0, false)] } })
    await render()
    const badge = (lease: string) => host.querySelector(`[data-lease="${lease}"] .badge`)!
    expect([badge('L23').textContent, badge('L15').textContent, badge('L09').textContent]).toEqual(['Current', 'Pending', 'Ended'])
    expect(badge('L15').className).toBe('badge badge-gold')
    expect(host.querySelector('[data-lease="L15"]')!.textContent).toContain('No months to judge yet')
  })

  it('one lease: its figure on the card, and the full report opens for that lease', async () => {
    server.profile = profile({ stats: { ...profile().stats, onTimeRate: 72,
      health: { percent: 72, onTime: 8, counted: 11, paidLate: 2, partial: 1, outstanding: 0, label: '72%, 8 of 11 months' },
      healthByLease: [leaseHealth('L4', 'MH 04', 100)] } })
    await render()
    expect(text()).not.toContain('by lease')
    expect(text()).toContain('100%, 1 of 1 month')
    await click(btn(/^Full report$/))
    await until(() => text().includes('REPORT /tenants/t1/report?leaseId=L4'), 'the lease\'s report')
  })
})
