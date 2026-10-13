/**
 * 10/13 (Nic) — THE PAYMENTS PAGE: THE RENT ROLL FOR THE OPEN MONTH.
 *
 *   "the payments page is the rent roll for the open month ... you select
 *    either property and view only those properties ... in order of space
 *    number ... what was invoiced what was paid any difference in the balance
 *    if they make a partial payment ... I don't think we need to have the on
 *    time column at all ... outstanding balances are always at the top of this
 *    list. And then once it's paid, it drops down and inserts itself in order
 *    of space number."
 *   "payments first. with a way to log the payments."
 *
 * The page asks which property first (one property opens straight to it), lays
 * out the server's rows in the server's order — every space, owed first — with
 * Invoiced / Paid / Owed, the payment method and one status pill in Nic's
 * colors; a row opens its payments and charges, a name opens the tenant
 * report, and a payment is logged right here through the desk window (the one
 * way to log a payment by hand). What the Payments ledger said on a payment
 * (S655: why it came back; 10/5: the bank receipt photo, the deposit date
 * flag) is kept on the opened row, and somebody who cannot see the page is
 * told where to go next.
 *
 * Fixtures are typed with the wire types from @gam/shared (camelCase keys as
 * the server builds them — the camelize contract).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from 'react-query'
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom'
import type { OpenMonthRoll, OpenMonthRow, RentRollProperty, RentRollPayment, RentRollCharge } from '@gam/shared'

const server = vi.hoisted(() => ({
  properties: [] as any[],
  /** propertyId → the open month. */
  rolls: {} as Record<string, any>,
  /** propertyId → a refusal { status, error }. */
  refuse: {} as Record<string, { status: number; error: string }>,
  propertiesStatus: null as number | null,
  ledger: null as any,
  paymentRows: [] as any[],
  /** When set, GET /payments answers page by page (page number → rows). */
  paymentPages: null as Record<number, any[]> | null,
  gets: [] as string[],
  user: { role: 'landlord', permissions: {} } as any,
  leases: [] as any[],
  posts: [] as { url: string; body: any }[],
  /** When set, a POST waits on it (in flight). */
  postHold: null as Promise<void> | null,
}))

const refusal = (status: number, error: string) => Object.assign(new Error(error), { response: { status, data: { error } } })

vi.mock('../lib/api', () => ({
  apiGet: async (url: string) => {
    server.gets.push(url)
    if (url === '/balances/rent-roll/properties') {
      if (server.propertiesStatus) throw refusal(server.propertiesStatus, 'Not allowed.')
      return server.properties
    }
    if (url.startsWith('/balances/rent-roll/open-month?propertyId=')) {
      const id = decodeURIComponent(url.slice('/balances/rent-roll/open-month?propertyId='.length))
      const r = server.refuse[id]
      if (r) throw refusal(r.status, r.error)
      return server.rolls[id]
    }
    if (url.startsWith('/balances/payments-by-month')) return server.ledger
    if (url.startsWith('/payments?')) {
      if (server.paymentPages) return server.paymentPages[Number(/[?&]page=(\d+)/.exec(url)?.[1] ?? 1)] ?? []
      return server.paymentRows
    }
    if (url === '/leases') return server.leases
    throw new Error(`unexpected GET ${url}`)
  },
  apiPost: vi.fn(async (url: string, body: any) => {
    server.posts.push({ url, body })
    if (server.postHold) await server.postHold
    return { success: true, data: {} }
  }),
}))
vi.mock('../context/AuthContext', () => ({ useAuth: () => ({ user: server.user }) }))
// The desk window and posting ahead are the existing way to log a payment
// (tested on their own); here only what the page hands them is checked.
vi.mock('../components/RecordPaymentWindow', async () => {
  const { createElement: h } = await import('react')
  return {
    RecordPaymentWindow: (p: any) => h('div', { className: 'stub-desk' },
      `DESK anchor=${p.anchorPaymentId} tenant=${p.tenantId} name=${p.name}`,
      h('button', { onClick: () => { p.onRecorded('Recorded $260.00 from Russ Fuller.'); p.onClose() } }, 'stub record and close')),
    PostPaymentForm: (p: any) => h('div', { className: 'stub-post' },
      `POST tenant=${p.tenantId} name=${p.name}`,
      h('button', { onClick: () => p.onPosted('Posted $50.00 from Dakota Lane — $50.00 kept as paid ahead.') }, 'stub post')),
    sendDepositPhoto: async () => null,
  }
})

import { PaymentsPage } from './PaymentsPage'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

// ─── Fixtures (the wire types) ───────────────────────────────────────────────

const property = (over: Partial<RentRollProperty> = {}): RentRollProperty => ({
  propertyId: 'p-oak', name: 'Oak Park', spaces: 29, owned: true, ...over,
})
const payment = (over: Partial<RentRollPayment> = {}): RentRollPayment => ({
  paymentId: 'rcpt1', paidOn: '2026-10-03', amount: 460, credit: 0, methodLabel: 'Cash',
  status: 'settled', statusLabel: 'Paid', reference: null, ...over,
})
const charge = (over: Partial<RentRollCharge> = {}): RentRollCharge => ({
  chargeId: 'c1', label: 'Rent', detail: null, dueDate: '2026-10-01', month: '2026-10',
  invoiced: 460, paid: 460, credit: 0, workTrade: 0, owed: 0, paidOn: '2026-10-03', howPaid: 'Cash',
  daysPastGrace: 0, isLateFee: false, loggedAfterLateFee: false, ...over,
})
const row = (over: Partial<OpenMonthRow> = {}): OpenMonthRow => ({
  key: 'lease:L4', unitId: 'u4', space: 'MH 04', leaseId: 'L4', householdId: 't-glenda',
  residents: [{ tenantId: 't-glenda', name: 'Glenda Moss', primary: true }], occupant: null, movedOut: false,
  invoiced: 460, lateFees: 0, paid: 460, clearing: 0, credit: 0, workTrade: 0, owed: 0, owedEarlier: 0,
  methods: ['Cash'], status: 'paid', statusLabel: 'Paid', statusColor: 'green', daysPastGrace: 0,
  dueDate: '2026-10-01', workTradeOnly: false, evictionMode: false, delinquent: false, recordWith: null,
  payments: [payment()], charges: [charge()], ...over,
})
const vacant = (space: string, unitId: string): OpenMonthRow => row({
  key: `vacant:${unitId}`, unitId, space, leaseId: null, householdId: null, residents: [],
  invoiced: 0, paid: 0, owed: 0, methods: [], status: 'vacant', statusLabel: 'Vacant', statusColor: 'gray',
  dueDate: null, payments: [], charges: [],
})
const roll = (rows: OpenMonthRow[], over: Partial<OpenMonthRoll> = {}): OpenMonthRoll => ({
  propertyId: 'p-oak', propertyName: 'Oak Park', month: '2026-10', rows, ...over,
})

// A month as the server orders it: still owing first, then space order.
const russ = row({
  key: 'lease:L7', unitId: 'u7', space: 'MH 07', leaseId: 'L7', householdId: 't-russ',
  residents: [{ tenantId: 't-russ', name: 'Russ Fuller', primary: true }, { tenantId: 't-ann', name: 'Ann Fuller', primary: false }],
  invoiced: 460, paid: 200, owed: 260, methods: ['Cash'], status: 'owes', statusLabel: 'Owes +3', statusColor: 'red',
  daysPastGrace: 3, recordWith: 'chg-russ', payments: [payment({ paymentId: 'rcpt7', amount: 200 })],
  charges: [charge({ chargeId: 'c7', paid: 200, owed: 260, paidOn: null })],
})
const nora = row({
  key: 'lease:L12', unitId: 'u12', space: 'MH 12', leaseId: 'L12', householdId: 't-nora',
  residents: [{ tenantId: 't-nora', name: 'Nora Hale', primary: true }],
  invoiced: 500, paid: 0, owed: 500, methods: [], status: 'due', statusLabel: 'Due Oct 1', statusColor: 'gray',
  recordWith: 'chg-nora', payments: [], charges: [charge({ chargeId: 'c12', invoiced: 500, paid: 0, owed: 500, paidOn: null, howPaid: null })],
})
const glenda = row({ key: 'lease:L2', unitId: 'u2', space: 'MH 02', leaseId: 'L2' })
const dakota = row({
  key: 'lease:L10', unitId: 'u10', space: 'MH 10', leaseId: 'L10', householdId: 't-dakota',
  residents: [{ tenantId: 't-dakota', name: 'Dakota Lane', primary: true }],
  status: 'paid_late', statusLabel: 'Paid late +5', statusColor: 'orange', daysPastGrace: 5,
  methods: ['Cash', 'Card · online'],
  payments: [payment({ paymentId: 'rcpt10a', amount: 200 }), payment({ paymentId: 'rcpt10b', paidOn: '2026-10-11', amount: 260, methodLabel: 'Card · online' })],
})
const month = () => roll([russ, nora, glenda, vacant('MH 03', 'u3'), dakota])

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  server.properties = [property()]
  server.rolls = { 'p-oak': month() }
  server.refuse = {}; server.propertiesStatus = null
  server.ledger = { month: '2026-10', months: ['2026-10'], payments: [], workTrade: [], stillOweHouseholds: null }
  server.gets = []; server.paymentRows = []; server.paymentPages = null
  server.user = { role: 'landlord', permissions: {} }
  server.leases = []; server.posts = []; server.postHold = null
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

function ReportProbe() {
  const loc = useLocation()
  return <div className="report-probe">REPORT {loc.pathname}{loc.search}</div>
}
async function render(at = '/payments') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  await act(async () => {
    root.render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={[at]}>
          <Routes>
            <Route path="/payments" element={<PaymentsPage />} />
            <Route path="/tenants/:id/report" element={<ReportProbe />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>)
  })
}
const text = () => host.textContent ?? ''
async function until(check: () => boolean, what: string) {
  for (let i = 0; i < 150; i++) {
    if (check()) return
    await act(async () => { await new Promise(r => setTimeout(r, 10)) })
  }
  throw new Error(`timed out waiting for ${what}\n${text()}`)
}
const btn = (re: RegExp) => [...host.querySelectorAll('button')].find(b => re.test(b.textContent ?? ''))
const click = async (el: Element | null | undefined) => { await act(async () => { (el as HTMLElement).click() }) }
/** A button inside the open window (the table's own names are buttons too). */
const inWindow = (re: RegExp) => [...host.querySelectorAll('.modal-overlay button')].find(b => re.test(b.textContent ?? ''))
const rowOf = (key: string) => host.querySelector(`tr.pay-row[data-key="${key}"]`) as HTMLTableRowElement | null
const cells = (key: string) => [...rowOf(key)!.querySelectorAll(':scope > td')].map(td => td.textContent ?? '')
const openMonthReads = () => server.gets.filter(u => u.startsWith('/balances/rent-roll/open-month'))
const setValue = async (el: HTMLInputElement, v: string) => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  await act(async () => { setter.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })) })
}
const loaded = () => until(() => !!host.querySelector('table.pay-table'), 'the month')

// ─── Pick the property first ─────────────────────────────────────────────────

describe('one property at a time, picked first', () => {
  it('asks which property, never one a sale took out of the account; picking one shows only it, and Change property asks again', async () => {
    server.properties = [
      property({ propertyId: 'p-oak', name: 'Oak Park', spaces: 29 }),
      property({ propertyId: 'p-mv', name: 'Mountain View', spaces: 61 }),
      property({ propertyId: 'p-sold', name: 'Sold Acres', spaces: 0, owned: false }),
    ]
    server.rolls['p-mv'] = roll([row({ key: 'lease:M1', space: 'RV 1', residents: [{ tenantId: 't-m', name: 'Mo Reyes', primary: true }] })],
      { propertyId: 'p-mv', propertyName: 'Mountain View' })
    await render()
    await until(() => text().includes('Which property?'), 'the picker')
    expect([...host.querySelectorAll('.pay-prop-name')].map(e => e.textContent)).toEqual(['Mountain View', 'Oak Park'])
    expect(text()).not.toContain('Sold Acres')
    expect(text()).toContain('61 spaces')
    expect(openMonthReads()).toEqual([])
    expect(host.querySelector('table.pay-table')).toBeNull()

    await click(btn(/^Oak Park/))
    await loaded()
    expect(openMonthReads()).toEqual(['/balances/rent-roll/open-month?propertyId=p-oak'])
    expect(host.querySelector('.pay-title')!.textContent).toBe('Oak Park · October 2026')
    expect(text()).not.toContain('Mo Reyes')
    expect(text()).not.toContain('Which property?')

    await click(btn(/^Change property$/))
    await until(() => text().includes('Which property?'), 'the picker again')
    expect(host.querySelector('table.pay-table')).toBeNull()
    await click(btn(/^Mountain View/))
    await until(() => text().includes('Mo Reyes'), 'Mountain View')
    expect(text()).not.toContain('Glenda Moss')
  })

  it('a company with only one property opens straight to it, with nothing to change', async () => {
    server.properties = [property(), property({ propertyId: 'p-sold', name: 'Sold Acres', owned: false })]
    await render()
    await loaded()
    expect(text()).not.toContain('Which property?')
    expect(btn(/^Change property$/)).toBeUndefined()
    expect(host.querySelector('.pay-title')!.textContent).toBe('Oak Park · October 2026')
  })

  it('the property in the address opens directly', async () => {
    server.properties = [property(), property({ propertyId: 'p-mv', name: 'Mountain View' })]
    await render('/payments?property=p-oak')
    await loaded()
    expect(openMonthReads()).toEqual(['/balances/rent-roll/open-month?propertyId=p-oak'])
    expect(btn(/^Change property$/)).toBeDefined()
  })

  it('a property the server will not show says why, with the way back to the list', async () => {
    server.properties = [property(), property({ propertyId: 'p-mv', name: 'Mountain View' })]
    server.refuse['p-gone'] = { status: 404, error: 'That property is not one you can see.' }
    await render('/payments?property=p-gone')
    await until(() => text().includes('That property is not one you can see.'), 'the refusal')
    expect(btn(/Read it again/)).toBeUndefined()
    await click(btn(/^Change property$/))
    await until(() => text().includes('Which property?'), 'the picker')
  })
})

// ─── The rows ────────────────────────────────────────────────────────────────

describe('one row per household, in the server’s order, every space', () => {
  it('owed first, then space order, exactly as sent — the page never re-sorts', async () => {
    await render()
    await loaded()
    const keys = [...host.querySelectorAll('tr.pay-row')].map(r => r.getAttribute('data-key'))
    expect(keys).toEqual(['lease:L7', 'lease:L12', 'lease:L2', 'vacant:u3', 'lease:L10'])
  })

  it('the columns are Space, Tenant, Invoiced, Paid, Owed, Payment method and Status — no On time column', async () => {
    await render()
    await loaded()
    const heads = [...host.querySelectorAll('table.pay-table thead th')].map(th => th.textContent)
    expect(heads).toEqual(['Space', 'Tenant', 'Invoiced', 'Paid', 'Owed', 'Payment method', 'Status', ''])
    expect(text()).not.toContain('On time')
  })

  it('a partial payment shows what was invoiced, what was paid and the difference still owed', async () => {
    await render()
    await loaded()
    const c = cells('lease:L7')
    expect(c[0]).toBe('▸MH 07')
    expect(c[1]).toBe('Russ Fuller & Ann Fuller')
    expect(c.slice(2, 7)).toEqual(['$460.00', '$200.00', '$260.00', 'Cash', 'Owes +3'])
  })

  it('an empty space is a gray Vacant row in its spot, with no money and nothing to open', async () => {
    await render()
    await loaded()
    const c = cells('vacant:u3')
    expect(c.slice(0, 7)).toEqual(['MH 03', '—', '', '', '', '', 'Vacant'])
    const pill = rowOf('vacant:u3')!.querySelector('.pay-pill')!
    expect(pill.className).toBe('pay-pill gray')
    await click(rowOf('vacant:u3'))
    expect(host.querySelector('tr.pay-detail')).toBeNull()
  })

  // 10/13 review: an occupied space is never "Vacant".
  it('a space in use with nobody on a lease says what is there, and who, in gray — with no money and nothing to open', async () => {
    const inUse = (key: string, space: string, label: string, occupant: string | null) => row({
      key, unitId: key, space, leaseId: null, householdId: null, residents: [], occupant,
      invoiced: 0, paid: 0, owed: 0, methods: [], status: 'occupied', statusLabel: label, statusColor: 'gray',
      dueDate: null, payments: [], charges: [],
    })
    server.rolls['p-oak'] = roll([inUse('space:u3', 'MH 03', 'Owner Use', null), inUse('space:u10', 'RV 10', 'Checked in', 'Gina Guest')])
    await render()
    await loaded()
    expect(cells('space:u3').slice(0, 7)).toEqual(['MH 03', '—', '', '', '', '', 'Owner Use'])
    expect(cells('space:u10').slice(0, 7)).toEqual(['RV 10', 'Gina Guest', '', '', '', '', 'Checked in'])
    expect(rowOf('space:u10')!.querySelector('.pay-pill')!.className).toBe('pay-pill gray')
    expect(rowOf('space:u10')!.getAttribute('tabindex')).toBeNull()
    expect(rowOf('space:u10')!.querySelector('button')).toBeNull()
    await click(rowOf('space:u10'))
    expect(host.querySelector('tr.pay-detail')).toBeNull()
    await click(btn(/^Record payment$/))
    expect(host.querySelector('.modal-overlay')!.textContent).not.toContain('Gina Guest')
  })

  it('two payments in the month list both methods', async () => {
    await render()
    await loaded()
    expect(cells('lease:L10')[5]).toBe('Cash, Card · online')
  })

  it('a household that moved out this month is marked', async () => {
    server.rolls['p-oak'] = roll([row({ movedOut: true })])
    await render()
    await loaded()
    expect(rowOf('lease:L4')!.querySelector('.pay-tag')!.textContent).toBe('Moved out')
  })
})

describe('the status pill: one, in Nic’s colors, with the days past grace', () => {
  it('green Paid, orange Paid late +N, yellow Partial, red Owes +N, gray Due <date>, gray Vacant', async () => {
    server.rolls['p-oak'] = roll([
      row({ key: 'a', status: 'owes', statusLabel: 'Owes +3', statusColor: 'red', daysPastGrace: 3, owed: 460, paid: 0 }),
      row({ key: 'b', status: 'partial', statusLabel: 'Partial', statusColor: 'yellow', owed: 160, paid: 300 }),
      row({ key: 'c', status: 'due', statusLabel: 'Due Oct 1', statusColor: 'gray', owed: 460, paid: 0 }),
      row({ key: 'd', status: 'paid', statusLabel: 'Paid', statusColor: 'green' }),
      row({ key: 'e', status: 'paid_late', statusLabel: 'Paid late +5', statusColor: 'orange', daysPastGrace: 5 }),
      vacant('MH 09', 'u9'),
    ])
    await render()
    await loaded()
    const pills = [...host.querySelectorAll('tr.pay-row .pay-pill')].map(p => `${p.textContent}|${p.className}`)
    expect(pills).toEqual([
      'Owes +3|pay-pill red', 'Partial|pay-pill yellow', 'Due Oct 1|pay-pill gray',
      'Paid|pay-pill green', 'Paid late +5|pay-pill orange', 'Vacant|pay-pill gray',
    ])
  })

  // As on the Rent Roll: work trade's value beside Paid, so Invoiced = Paid + work trade + Owed reads on the row.
  it('work trade covering the month is green Paid, method Work trade, its value beside Paid as on the Rent Roll', async () => {
    server.rolls['p-oak'] = roll([row({
      paid: 0, workTrade: 460, owed: 0, methods: ['Work trade'], workTradeOnly: true, payments: [],
      charges: [charge({ paid: 0, workTrade: 460, howPaid: 'Work trade' })],
    })])
    await render()
    await loaded()
    const c = cells('lease:L4')
    expect(c.slice(2, 7)).toEqual(['$460.00', '—$460.00 work trade', '—', 'Work trade', 'Paid'])
    expect(rowOf('lease:L4')!.querySelector('.pay-pill')!.className).toBe('pay-pill green')
    await click(rowOf('lease:L4'))
    const line = host.querySelector('tr[data-line="charge"]')!
    expect([...line.querySelectorAll('td')].map(td => td.textContent)).toEqual(['Rent', 'Oct 1', '$460.00', '—$460.00 work trade', '—'])
  })

  it('work trade covering part of the month: what was paid, plus the work trade, and what is still owed add up to Invoiced', async () => {
    server.rolls['p-oak'] = roll([row({
      invoiced: 500, paid: 200, workTrade: 260, owed: 40, methods: ['Cash', 'Work trade'], status: 'partial', statusLabel: 'Partial',
      statusColor: 'yellow', recordWith: 'chg-g',
    })])
    await render()
    await loaded()
    expect(cells('lease:L4').slice(2, 5)).toEqual(['$500.00', '$200.00+ $260.00 work trade', '$40.00'])
  })

  it('money still clearing is said under Paid', async () => {
    server.rolls['p-oak'] = roll([row({ clearing: 460, methods: ['Bank (ACH)'] })])
    await render()
    await loaded()
    expect(cells('lease:L4')[3]).toBe('$460.00$460.00 still clearing')
  })
})

describe('eviction mode blocks payments, and the row says so', () => {
  it('shows the flag and offers no Record payment, though the household owes', async () => {
    server.rolls['p-oak'] = roll([row({
      key: 'lease:L5', space: 'MH 05', evictionMode: true, owed: 460, paid: 0, status: 'owes', statusLabel: 'Owes +12',
      statusColor: 'red', recordWith: null, methods: [], payments: [],
    }), russ])
    await render()
    await loaded()
    expect(rowOf('lease:L5')!.querySelector('.pay-tag.evict')!.textContent).toBe('Eviction mode — payments blocked')
    expect(rowOf('lease:L5')!.querySelector('button.btn')).toBeNull()
    expect(rowOf('lease:L7')!.querySelector('button.btn')!.textContent).toBe('Record payment')
  })
})

// ─── Opening a row, opening a name ───────────────────────────────────────────

describe('click the row for its payments and charges; click the name for the report', () => {
  it('the row opens each payment (date, amount, method) and every charge with what it is for, and closes again', async () => {
    server.rolls['p-oak'] = roll([row({
      paid: 500, invoiced: 500,
      payments: [payment({ amount: 460, reference: '1042', methodLabel: 'Check' }), payment({ paymentId: 'rcpt2', paidOn: '2026-10-09', amount: 40, credit: 40, methodLabel: 'Paid from credit' })],
      charges: [charge({ paid: 460 }), charge({ chargeId: 'c2', label: 'Water', detail: '3,200 gal', invoiced: 40, paid: 40, credit: 40 })],
    })])
    await render()
    await loaded()
    expect(host.querySelector('tr.pay-detail')).toBeNull()
    await click(rowOf('lease:L4'))
    const pays = [...host.querySelectorAll('tr[data-line="payment"]')].map(r => [...r.querySelectorAll('td')].map(td => td.textContent))
    expect(pays).toEqual([
      ['Oct 3', '$460.00', 'Check#1042', ''],
      ['Oct 9', '$40.00', 'Paid from credit', ''],
    ])
    const lines = [...host.querySelectorAll('tr[data-line="charge"]')].map(r => [...r.querySelectorAll('td')].map(td => td.textContent))
    expect(lines).toEqual([
      ['Rent', 'Oct 1', '$460.00', '$460.00', '—'],
      ['Water · 3,200 gal', 'Oct 1', '$40.00', '$40.00', '—'],
    ])
    await click(rowOf('lease:L4'))
    expect(host.querySelector('tr.pay-detail')).toBeNull()
  })

  it('a partial’s charge shows what is still owed on it, and a payment logged after the late fee says it counts late', async () => {
    server.rolls['p-oak'] = roll([row({
      ...russ, charges: [charge({ chargeId: 'c7', paid: 200, owed: 260, loggedAfterLateFee: true })],
    })])
    await render()
    await loaded()
    await click(rowOf('lease:L7'))
    const line = host.querySelector('tr[data-line="charge"]')!
    expect(line.textContent).toContain('Logged after the late fee posted — late from the day it was logged')
    expect([...line.querySelectorAll('td')].slice(2).map(td => td.textContent)).toEqual(['$460.00', '$200.00', '$260.00'])
  })

  it('a row opens from the keyboard too (Enter)', async () => {
    await render()
    await loaded()
    const r = rowOf('lease:L2')!
    expect(r.getAttribute('aria-expanded')).toBe('false')
    await act(async () => { r.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
    expect(rowOf('lease:L2')!.getAttribute('aria-expanded')).toBe('true')
    expect(host.querySelector('tr.pay-detail')).not.toBeNull()
    expect(rowOf('vacant:u3')!.getAttribute('tabindex')).toBeNull()
  })

  it('nothing paid yet says so', async () => {
    await render()
    await loaded()
    await click(rowOf('lease:L12'))
    expect(host.querySelector('tr.pay-detail')!.textContent).toContain('No payment on this month’s bills yet.')
  })

  it('the name opens that household’s report, for its lease, without opening the row', async () => {
    await render()
    await loaded()
    await click(rowOf('lease:L7')!.querySelector('button.pay-name'))
    await until(() => !!host.querySelector('.report-probe'), 'the report')
    expect(host.querySelector('.report-probe')!.textContent).toBe('REPORT /tenants/t-russ/report?leaseId=L7')
  })
})

// ─── Logging a payment ───────────────────────────────────────────────────────

describe('logging a payment right here (the desk window — the one way)', () => {
  it('a row that owes has Record payment: the desk window opens on its charge, for its household; when it closes the result shows and the month is read again', async () => {
    await render()
    await loaded()
    // Only rows that still owe this month.
    expect(rowOf('lease:L2')!.querySelector('button.btn')).toBeNull()
    expect(rowOf('lease:L10')!.querySelector('button.btn')).toBeNull()
    const before = openMonthReads().length
    await click(rowOf('lease:L7')!.querySelector('button.btn'))
    expect(host.querySelector('tr.pay-detail')).toBeNull()
    expect(host.querySelector('.stub-desk')!.textContent).toContain('DESK anchor=chg-russ tenant=t-russ name=Russ Fuller & Ann Fuller')
    await click(btn(/stub record and close/))
    expect(host.querySelector('.stub-desk')).toBeNull()
    expect(host.querySelector('.cd-notice')!.textContent).toContain('Recorded $260.00 from Russ Fuller.')
    await until(() => openMonthReads().length > before, 'the month read again')
  })

  it('Record payment at the top lists this property’s households: one who owes opens the desk window, one paid up posts ahead, eviction mode is said with nothing to press', async () => {
    server.rolls['p-oak'] = roll([
      russ,
      row({ key: 'lease:L5', space: 'MH 05', householdId: 't-ed', residents: [{ tenantId: 't-ed', name: 'Ed Price', primary: true }],
        evictionMode: true, owed: 460, paid: 0, status: 'owes', statusLabel: 'Owes +12', statusColor: 'red', recordWith: null }),
      row({ ...dakota, owedEarlier: 0 }),
      vacant('MH 03', 'u3'),
    ])
    await render()
    await loaded()
    await click(btn(/^Record payment$/))
    const picker = () => host.querySelector('.modal-overlay')!
    expect(picker().textContent).toContain('Who is paying?')
    const items = [...picker().querySelectorAll('.cd-picker-item')].map(i => i.textContent)
    expect(items).toEqual([
      'Russ Fuller & Ann FullerMH 07owes $260.00',
      'Ed PriceMH 05Eviction mode — payments blocked',
      'Dakota LaneMH 10nothing owed — paying ahead',
    ])
    expect(picker().querySelector('div.cd-picker-info')!.textContent).toContain('Ed Price')
    await setValue(picker().querySelector('input') as HTMLInputElement, 'mh 10')
    expect([...picker().querySelectorAll('.cd-picker-item')].map(i => i.textContent)).toEqual(['Dakota LaneMH 10nothing owed — paying ahead'])
    await click(inWindow(/^Dakota Lane/))
    expect(host.querySelector('.stub-post')!.textContent).toContain('POST tenant=t-dakota name=Dakota Lane')
    await click(btn(/stub post/))
    expect(host.querySelector('.cd-notice')!.textContent).toContain('Posted $50.00 from Dakota Lane')

    await click(btn(/^Record payment$/))
    await click(inWindow(/^Russ Fuller/))
    expect(host.querySelector('.stub-desk')!.textContent).toContain('DESK anchor=chg-russ tenant=t-russ')
  })

  it('the whole balance here is what the list says is owed, earlier months included', async () => {
    server.rolls['p-oak'] = roll([row({ owedEarlier: 120, recordWith: 'chg-sept' })])
    await render()
    await loaded()
    await click(btn(/^Record payment$/))
    expect(host.querySelector('.cd-picker-item')!.textContent).toBe('Glenda MossMH 04owes $120.00')
  })

  // 10/13 (Nic): "outstanding balances are always at the top of this list ...
  // once it's paid, it drops down" — a balance from an earlier month too.
  it('paid this month but owing an earlier one: the row says how much from earlier months, and takes the payment', async () => {
    server.rolls['p-oak'] = roll([row({ owedEarlier: 120, recordWith: 'chg-sept' }), row({ ...russ, owedEarlier: 50 })])
    await render()
    await loaded()
    expect(cells('lease:L4').slice(2, 7)).toEqual(['$460.00', '$460.00', '—$120.00 from earlier months', 'Cash', 'Paid'])
    expect(cells('lease:L7')[4]).toBe('$260.00+ $50.00 from earlier months')
    expect(rowOf('lease:L4')!.querySelector('.pay-earlier')).not.toBeNull()
    await click(rowOf('lease:L4')!.querySelector('button.btn'))
    expect(host.querySelector('.stub-desk')!.textContent).toContain('DESK anchor=chg-sept tenant=t-glenda')
  })

  it('somebody who does not take payments sees no Record payment anywhere', async () => {
    server.user = { role: 'onsite_manager', permissions: { 'payments.view_all': true } }
    await render()
    await loaded()
    expect(btn(/Record payment/)).toBeUndefined()
    expect([...host.querySelectorAll('table.pay-table thead th')]).toHaveLength(7)
  })
})

describe('the month total (decisions #25)', () => {
  it('shows only when the server sent it', async () => {
    server.rolls['p-oak'] = roll([russ], { totals: { invoiced: 960, lateFees: 0, paid: 700, credit: 0, workTrade: 0, owed: 260, owedEarlier: 0 } })
    await render()
    await loaded()
    expect(host.querySelector('.cd-totals')!.textContent).toBe('Invoiced $960.00Paid $700.00Owed $260.00')
  })
  it('adds work trade and what is owed from earlier months when there is some — as the Rent Roll does', async () => {
    server.rolls['p-oak'] = roll([russ], { totals: { invoiced: 1460, lateFees: 0, paid: 700, credit: 0, workTrade: 500, owed: 260, owedEarlier: 120 } })
    await render()
    await loaded()
    expect(host.querySelector('.cd-totals')!.textContent)
      .toBe('Invoiced $1,460.00Paid $700.00Work trade $500.00Owed $260.00Owed from earlier months $120.00')
  })
  it('is not there at all when the server sent none', async () => {
    await render()
    await loaded()
    expect(host.querySelector('.cd-totals')).toBeNull()
  })
})

// ─── What the ledger said on a payment, kept ─────────────────────────────────

const ledgerPayment = (over: any = {}) => ({
  id: 'rcpt7', kind: 'receipt', name: 'Russ Fuller', unitNumber: 'MH 07', propertyName: 'Oak Park',
  paidOn: '2026-10-03', arrivedOn: '2026-10-05', applied: 200, amount: 200, creditApplied: 0, returned: 0, creditReturned: 0,
  method: 'ach', methodLabel: 'Bank', status: 'settled', statusLabel: 'Paid', paidFor: 'October rent',
  daysLate: 0, timingLabel: 'On time', receiptId: 'rm7', reference: null,
  lines: [{ paymentId: 'c7', label: 'Rent', detail: null, dueDate: '2026-10-01', amount: 460, paid: 200, credit: 0, returned: 0, creditReturned: 0, unitNumber: 'MH 07', propertyName: 'Oak Park' }],
  ...over,
})
const returnedMonth = () => roll([row({
  ...russ, payments: [payment({ paymentId: 'rcpt7', amount: 200, methodLabel: 'Bank', status: 'returned', statusLabel: 'Returned' })],
})])

describe('a payment that came back says why', () => {
  it('shows the bank’s reason in words with its code, and the zero-tolerance mark, on the payment and on its charge', async () => {
    server.rolls['p-oak'] = returnedMonth()
    server.ledger = { ...server.ledger, payments: [ledgerPayment({ status: 'returned', statusLabel: 'Returned', returned: 200, lines: [{ ...ledgerPayment().lines[0], returned: 200 }] })] }
    server.paymentRows = [{ id: 'c7', returnCode: 'R10', returnReason: 'Customer advises not authorized', zeroToleranceFlag: true }]
    await render()
    await loaded()
    await click(rowOf('lease:L7'))
    await until(() => text().includes('Bank return:'), 'the reason')
    const pay = host.querySelector('tr[data-line="payment"]')!.textContent
    expect(pay).toContain('Returned')
    expect(pay).toContain('Bank return: the account holder told the bank this debit was not authorized (R10)')
    expect(pay).toContain('Zero tolerance — bank payments from them are stopped')
    expect(host.querySelector('tr[data-line="charge"]')!.textContent).toContain('(R10)')
    expect(server.gets).toContain('/balances/payments-by-month?month=2026-10')
    expect(server.gets.filter(u => u.startsWith('/payments?'))).toEqual(['/payments?from=2026-10-01&to=2026-10-31&limit=1000&page=1'])
  })

  it('a returned charge past the first 1,000 charges of the month is still found, and nothing is said missing', async () => {
    server.rolls['p-oak'] = returnedMonth()
    const fill = (n: number, from: number) => Array.from({ length: n }, (_, i) => ({ id: `other${from + i}` }))
    server.paymentPages = {
      1: fill(1000, 0),
      2: [...fill(400, 1000), { id: 'c7', returnCode: 'R01', returnReason: 'Insufficient funds', zeroToleranceFlag: false }, ...fill(599, 1400)],
      3: fill(10, 2000),
    }
    await render()
    await loaded()
    await click(rowOf('lease:L7'))
    await until(() => text().includes('Bank return:'), 'the reason')
    expect(text()).toContain('Bank return: there was not enough money in the account (R01)')
    expect(server.gets.filter(u => u.startsWith('/payments?'))).toEqual([
      '/payments?from=2026-10-01&to=2026-10-31&limit=1000&page=1',
      '/payments?from=2026-10-01&to=2026-10-31&limit=1000&page=2',
    ])
    expect(text()).not.toContain('may show no reason')
  })

  it('a row with nothing returned reads no return details at all', async () => {
    await render()
    await loaded()
    await click(rowOf('lease:L10'))
    await until(() => server.gets.some(u => u.startsWith('/balances/payments-by-month')), 'the ledger')
    expect(server.gets.some(u => u.startsWith('/payments?'))).toBe(false)
    expect(text()).not.toContain('Bank return')
  })

  it('credit a dispute took back says so on the payment, and why', async () => {
    server.rolls['p-oak'] = roll([row({ ...russ, payments: [payment({ paymentId: 'rcpt7', amount: 10, credit: 10, methodLabel: 'Paid from credit' })] })])
    server.ledger = { ...server.ledger, payments: [ledgerPayment({ kind: 'credit', amount: 0, creditApplied: 10, creditReturned: 10, method: null, methodLabel: 'Paid from credit', receiptId: null })] }
    await render()
    await loaded()
    await click(rowOf('lease:L7'))
    await until(() => text().includes('credit taken back'), 'the credit taken back')
    const pay = host.querySelector('tr[data-line="payment"]')!.textContent
    expect(pay).toContain('$10.00 credit taken back')
    expect(pay).toContain('The payment that put this credit on their account was disputed or returned — this bill is owed again for that part')
  })
})

// 10/5 (Nic): "if they say they paid on time and it was actually late ... they
// get flagged for false information." A payment made from a reported bank
// deposit the bank showed on a later day says so, plainly, on its line.
describe('a payment from a bank deposit the tenant dated earlier than the bank', () => {
  it('shows the flag with both dates, and the tenant’s photo of the bank receipt', async () => {
    server.rolls['p-oak'] = roll([row({ ...russ, payments: [payment({ paymentId: 'rcpt7', amount: 200, methodLabel: 'Bank deposit' })] })])
    server.ledger = { ...server.ledger, payments: [ledgerPayment({
      method: 'bank_deposit', methodLabel: 'Bank deposit', depositPhotoUrl: '/api/payments/remittances/rm7/deposit-photo',
      depositDateFlag: { said: '2026-10-01', bank: '2026-10-06' },
      tenantReceiptPhotoUrl: '/api/declared-deposits/receipt-photos/r.jpg',
    })] }
    await render()
    await loaded()
    await click(rowOf('lease:L7'))
    await until(() => text().includes('Said they deposited'), 'the flag')
    expect(text()).toContain('Said they deposited Oct 1 — the bank shows Oct 6.')
    expect(btn(/^Tenant's photo of the bank receipt$/)).toBeDefined()
    expect(btn(/^Bank receipt photo$/)).toBeDefined()
  })

  it('a bank deposit with no photo can have one added by someone who takes payments', async () => {
    server.rolls['p-oak'] = roll([row({ ...russ, payments: [payment({ paymentId: 'rcpt7', amount: 200, methodLabel: 'Bank deposit' })] })])
    server.ledger = { ...server.ledger, payments: [ledgerPayment({ method: 'bank_deposit', methodLabel: 'Bank deposit', depositPhotoUrl: null })] }
    await render()
    await loaded()
    await click(rowOf('lease:L7'))
    await until(() => text().includes('Add a photo of the bank\'s receipt'), 'the add button')
    expect(text()).not.toContain('Said they deposited')
  })
})

// ─── Who may see it ──────────────────────────────────────────────────────────

describe('somebody who cannot see the page is told the next step', () => {
  it('with Outstanding Balances: a button to it, and nothing is read', async () => {
    server.user = { role: 'onsite_manager', permissions: { 'payments.view': true, 'balances.view': true, take_payment: true } }
    await render()
    expect(text()).toContain('To take a payment, use Outstanding Balances.')
    expect([...host.querySelectorAll('button')].some(b => b.textContent === 'Open Outstanding Balances')).toBe(true)
    expect(server.gets).toEqual([])
  })
  it('taking payments without Outstanding Balances: who to ask, and for which switch', async () => {
    server.user = { role: 'onsite_manager', permissions: { 'payments.view': true, take_payment: true } }
    await render()
    expect(text()).toContain('Payments are taken on Outstanding Balances, which your account cannot open yet. Ask the account owner to turn on “View who owes + contact” for you under Team.')
    expect([...host.querySelectorAll('button')].some(b => b.textContent === 'Open Outstanding Balances')).toBe(false)
  })
  it('neither: ask the account owner', async () => {
    server.user = { role: 'onsite_manager', permissions: { 'payments.view': true } }
    await render()
    expect(text()).toContain('If you need to see payments, ask the account owner.')
  })
  it('the server refusing the page says the same', async () => {
    server.user = { role: 'onsite_manager', permissions: { 'payments.view_all': true } }
    server.propertiesStatus = 403
    await render()
    await until(() => text().includes('If you need to see payments, ask the account owner.'), 'the next step')
  })
})

describe('Issue credit and Import payment history stay where they were', () => {
  it('both sit at the top, on the property list and in a property', async () => {
    server.properties = [property(), property({ propertyId: 'p-mv', name: 'Mountain View' })]
    await render()
    await until(() => text().includes('Which property?'), 'the picker')
    expect(btn(/Issue credit/)).toBeDefined()
    expect(btn(/^Import payment history$/)).toBeDefined()
    expect(btn(/^Record payment$/)).toBeUndefined()
    await click(btn(/^Oak Park/))
    await loaded()
    expect(btn(/Issue credit/)).toBeDefined()
    expect(btn(/^Import payment history$/)).toBeDefined()
  })
})

describe('Issue credit closes only from its own buttons', () => {
  it('a click outside never closes it, and while the credit is being issued Cancel waits — the result is always said', async () => {
    server.leases = [{ id: 'L1', status: 'active', unitNumber: 'MH 04', propertyName: 'Oak Park',
                       tenants: [{ firstName: 'Glenda', lastName: 'Moss' }] }]
    let release!: () => void
    server.postHold = new Promise<void>(r => { release = r })
    await render()
    await loaded()
    await click(btn(/Issue credit/))
    await until(() => !!host.querySelector('.modal-overlay'), 'the window')
    await click(host.querySelector('.modal-overlay'))
    expect(host.querySelector('.modal-overlay')).not.toBeNull()
    await setValue(host.querySelector('.modal-overlay input.form-input') as HTMLInputElement, 'Glenda')
    await until(() => !!btn(/^Glenda Moss · MH 04/), 'the match')
    await click(btn(/^Glenda Moss · MH 04/))
    await setValue(host.querySelector('.modal-overlay input.mono') as HTMLInputElement, '25')
    await click(btn(/^Issue credit$/))
    await until(() => text().includes('Issuing…'), 'the credit on its way')
    expect(btn(/^Cancel$/)!.disabled).toBe(true)
    await click(btn(/^Cancel$/))
    await click(host.querySelector('.modal-overlay'))
    expect(host.querySelector('.modal-overlay')).not.toBeNull()
    const before = openMonthReads().length
    await act(async () => { release() })
    await until(() => text().includes('Credit of $25.00 issued.'), 'the result')
    expect(host.querySelector('.modal-overlay')).toBeNull()
    expect(server.posts).toEqual([{ url: '/tenant-credits', body: { leaseId: 'L1', amount: 25, category: 'goodwill', reason: null } }])
    // A credit can pay a bill by itself: the month is read again.
    await until(() => openMonthReads().length > before, 'the month read again')
  })
})
