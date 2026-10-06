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
import { MemoryRouter, Routes, Route } from 'react-router-dom'

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
    if (url === '/tenants/t1/profile') return JSON.parse(JSON.stringify(server.profile))
    return []
  },
  apiPost: async (url: string, body: any) => {
    server.posts.push({ url, body })
    if (server.postHold) await server.postHold
    return { success: true, data: {} }
  },
  apiPatch: async () => ({ success: true, data: {} }),
}))
vi.mock('../context/AuthContext', () => ({ useAuth: () => ({ user: { role: 'landlord', permissions: {} } }) }))
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
          <Routes><Route path="/tenants/:id" element={<TenantDetailPage />} /></Routes>
        </MemoryRouter>
      </QueryClientProvider>)
  })
  await until(() => text().includes('Glenda Moss'), 'the page')
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
