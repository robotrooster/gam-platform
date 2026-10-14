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
 * 10/13 (Nic), the afternoon answers: bookkeepers see it read-only; the
 * Outstanding Balances tab is gone (front-desk staff without "View all
 * payments" find who owes and Record payment here); stay guests' money shows
 * with its details; a red "Delinquent" tag beside the name; phones get one
 * card per household.
 *
 * Fixtures are typed with the wire types from @gam/shared (camelCase keys as
 * the server builds them — the camelize contract).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from 'react-query'
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom'
import type { OpenMonthRoll, OpenMonthRow, RentRollProperty, RentRollPayment, RentRollCharge, OpenMonthOtherMoney, OpenMonthSalePart, OpenMonthTotals } from '@gam/shared'

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
  payments: [payment()], charges: [charge()], stay: null, otherMoney: [], otherIn: 0, otherRefunded: 0, ...over,
})
const vacant = (space: string, unitId: string): OpenMonthRow => row({
  key: `vacant:${unitId}`, unitId, space, leaseId: null, householdId: null, residents: [],
  invoiced: 0, paid: 0, owed: 0, methods: [], status: 'vacant', statusLabel: 'Vacant', statusColor: 'gray',
  dueDate: null, payments: [], charges: [],
})
const roll = (rows: OpenMonthRow[], over: Partial<OpenMonthRoll> = {}): OpenMonthRoll => ({
  propertyId: 'p-oak', propertyName: 'Oak Park', month: '2026-10', rows, otherMoney: [], ...over,
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
/** A register line's cells: its day, what it was for (who and how under it), its amount — never the caret. */
const lineCells = (li: Element) => [...li.querySelector('.pay-other-row')!.children].filter(c => !c.classList.contains('pay-caret')).map(c => c.textContent)

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

  // 10/13 (Nic): "can we have it where the vacant units are still like the unit
  // number is still directly in line with the ones that are occupied? ... just
  // make them all clickable even if they're vacant and just show you know an
  // expanded box with nothing".
  it('an empty space is a gray Vacant row in its spot, with no money — its number in line with the rest, and it opens to say nothing is billed', async () => {
    await render()
    await loaded()
    const c = cells('vacant:u3')
    expect(c.slice(0, 7)).toEqual(['▸MH 03', '—', '', '', '', '', 'Vacant'])
    const pill = rowOf('vacant:u3')!.querySelector('.pay-pill')!
    expect(pill.className).toBe('pay-pill gray')
    // Every space number sits after the same caret, so they line up.
    const spaces = [...host.querySelectorAll('tr.pay-row > td.pay-space')]
    expect(spaces.map(td => td.firstElementChild?.className)).toEqual(Array(5).fill('pay-caret'))
    expect([...host.querySelectorAll('tr.pay-row')].every(r => r.classList.contains('pay-click') && r.getAttribute('tabindex') === '0')).toBe(true)
    expect(rowOf('vacant:u3')!.getAttribute('aria-expanded')).toBe('false')
    await click(rowOf('vacant:u3'))
    expect(rowOf('vacant:u3')!.getAttribute('aria-expanded')).toBe('true')
    expect(cells('vacant:u3')[0]).toBe('▾MH 03')
    const detail = host.querySelector('tr.pay-detail')!
    expect(detail.querySelector('[data-block="space-only"]')!.textContent).toBe('Vacant — nothing billed this month.')
    // An empty box: no payments, no charges, nothing to press, nothing read.
    expect(detail.querySelectorAll('tr[data-line]')).toHaveLength(0)
    expect(detail.querySelectorAll('button')).toHaveLength(0)
    expect(server.gets.some(u => u.startsWith('/balances/payments-by-month') || u.startsWith('/payments?'))).toBe(false)
    await click(rowOf('vacant:u3'))
    expect(host.querySelector('tr.pay-detail')).toBeNull()
  })

  // 10/13 review: an occupied space is never "Vacant".
  it('a space in use with nobody on a lease says what is there, and who, in gray — with no money; opened, nothing billed', async () => {
    const inUse = (key: string, space: string, label: string, occupant: string | null) => row({
      key, unitId: key, space, leaseId: null, householdId: null, residents: [], occupant,
      invoiced: 0, paid: 0, owed: 0, methods: [], status: 'occupied', statusLabel: label, statusColor: 'gray',
      dueDate: null, payments: [], charges: [],
    })
    server.rolls['p-oak'] = roll([inUse('space:u3', 'MH 03', 'Owner Use', null), inUse('space:u10', 'RV 10', 'Checked in', 'Gina Guest')])
    await render()
    await loaded()
    expect(cells('space:u3').slice(0, 7)).toEqual(['▸MH 03', '—', '', '', '', '', 'Owner Use'])
    expect(cells('space:u10').slice(0, 7)).toEqual(['▸RV 10', 'Gina Guest', '', '', '', '', 'Checked in'])
    expect(rowOf('space:u10')!.querySelector('.pay-pill')!.className).toBe('pay-pill gray')
    expect(rowOf('space:u10')!.getAttribute('tabindex')).toBe('0')
    expect(rowOf('space:u10')!.querySelector('button')).toBeNull()
    await click(rowOf('space:u10'))
    expect(host.querySelector('tr.pay-detail [data-block="space-only"]')!.textContent).toBe('Checked in — no lease here, nothing billed this month.')
    expect(host.querySelectorAll('tr.pay-detail tr[data-line]')).toHaveLength(0)
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
    // An empty space too (10/13, Nic: "make them all clickable").
    const v = rowOf('vacant:u3')!
    expect(v.getAttribute('tabindex')).toBe('0')
    await act(async () => { v.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
    expect(rowOf('vacant:u3')!.getAttribute('aria-expanded')).toBe('true')
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
    server.rolls['p-oak'] = roll([russ], { totals: { invoiced: 960, lateFees: 0, paid: 700, credit: 0, workTrade: 0, owed: 260, owedEarlier: 0, stays: 0, staysRefunded: 0 } })
    await render()
    await loaded()
    expect(host.querySelector('.cd-totals')!.textContent).toBe('Invoiced $960.00Paid $700.00Owed $260.00')
  })
  it('adds work trade and what is owed from earlier months when there is some — as the Rent Roll does', async () => {
    server.rolls['p-oak'] = roll([russ], { totals: { invoiced: 1460, lateFees: 0, paid: 700, credit: 0, workTrade: 500, owed: 260, owedEarlier: 120, stays: 0, staysRefunded: 0 } })
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

// 10/14 (Nic), about Lisa Scheeler (Mountain View's on-site manager: "View who
// owes" and "Take payments", not "View all payments"): "they should see at
// least the payments tab ... kind of the same way that I see it, but not with
// that top view ... not show all the totals, the work trade, all these things
// at the top in the header. Just have it show the record payment like it does
// and down the list, everybody else who's paid or paid late or whatever."
describe('10/14 (Nic): the front desk sees the Payments page, without the top view', () => {
  const lisa = { role: 'onsite_manager', permissions: { 'payments.view': true, 'balances.view': true, take_payment: true } }

  it('the month for their property: its header, Record payment, every row — no totals, no report from a name, nothing more read', async () => {
    server.user = lisa
    // The server sends the desk no sums (routes/balances); the page shows what it was sent.
    await render()
    await loaded()
    expect(host.querySelector('.pay-title')!.textContent).toBe('Oak Park · October 2026')
    expect(btn(/^Change property$/)).toBeUndefined()
    expect(host.querySelector('.cd-totals')).toBeNull()
    expect(text()).not.toContain('Outstanding Balances')
    // Everybody: owing, due, paid, vacant, paid late — in the server's order.
    expect([...host.querySelectorAll('tr.pay-row')].map(r => r.getAttribute('data-key')))
      .toEqual(['lease:L7', 'lease:L12', 'lease:L2', 'vacant:u3', 'lease:L10'])
    expect(cells('lease:L7').slice(2, 7)).toEqual(['$460.00', '$200.00', '$260.00', 'Cash', 'Owes +3'])
    expect(cells('lease:L10').slice(6, 7)).toEqual(['Paid late +5'])
    // Record payment at the top and on a row that owes; no Issue credit or Import (not her switches).
    expect(btn(/^Record payment$/)).toBeDefined()
    expect(rowOf('lease:L7')!.querySelector('.pay-record button')!.textContent).toBe('Record payment')
    expect(btn(/Issue credit/)).toBeUndefined()
    expect(btn(/Import payment history/)).toBeUndefined()
    // The name is just the name: the tenant report is "View all payments".
    expect(host.querySelector('.pay-name')).toBeNull()
    expect(cells('lease:L7')[1]).toContain('Russ Fuller & Ann Fuller')
    // A row opens to its payments and charges from the row itself — the Payments ledger is never asked.
    await click(rowOf('lease:L7'))
    expect(host.querySelectorAll('tr[data-line="payment"]')).toHaveLength(1)
    expect(host.querySelectorAll('tr[data-line="charge"]')).toHaveLength(1)
    expect(server.gets.every(u => u.startsWith('/balances/rent-roll/'))).toBe(true)
  })

  it('logs a payment right here: the desk window on the row\'s charge, the month read again when it closes', async () => {
    server.user = lisa
    await render()
    await loaded()
    await click(rowOf('lease:L7')!.querySelector('.pay-record button'))
    expect(host.querySelector('.stub-desk')!.textContent).toContain('DESK anchor=chg-russ tenant=t-russ name=Russ Fuller & Ann Fuller')
    const before = openMonthReads().length
    await click(btn(/stub record and close/))
    await until(() => text().includes('Recorded $260.00 from Russ Fuller.'), 'the result')
    await until(() => openMonthReads().length > before, 'the month read again')
  })

  it('more than one property in their scope: Which property?, then Change property', async () => {
    server.user = lisa
    server.properties = [property(), property({ propertyId: 'p-mv', name: 'Mountain View RV', spaces: 61 })]
    server.rolls['p-mv'] = roll([row({ key: 'lease:M1', space: 'RV 1', residents: [{ tenantId: 't-m', name: 'Mo Reyes', primary: true }] })],
      { propertyId: 'p-mv', propertyName: 'Mountain View RV' })
    await render()
    await until(() => text().includes('Which property?'), 'the picker')
    await click(btn(/^Mountain View RV/))
    await until(() => text().includes('Mo Reyes'), 'Mountain View')
    expect(host.querySelector('.pay-title')!.textContent).toBe('Mountain View RV · October 2026')
    expect(btn(/^Change property$/)).toBeDefined()
  })

  it('seeing who owes without taking payments: the month, and no Record payment anywhere', async () => {
    server.user = { role: 'onsite_manager', permissions: { 'balances.view': true } }
    await render()
    await loaded()
    expect(btn(/Record payment/)).toBeUndefined()
    expect([...host.querySelectorAll('table.pay-table thead th')]).toHaveLength(7)
  })
})

describe('somebody who cannot see the page is told the next step', () => {
  it('taking payments without seeing who owes: who to ask, and for which switch', async () => {
    server.user = { role: 'onsite_manager', permissions: { 'payments.view': true, take_payment: true } }
    await render()
    expect(text()).toContain('Payments are taken here once your account can see who owes. Ask the account owner to turn on “View who owes + contact” for you under Team.')
    expect(text()).not.toContain('Outstanding Balances')
    expect(server.gets).toEqual([])
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

// ─── 10/13 (Nic), the afternoon answers ──────────────────────────────────────

describe('10/13 (Nic): a bookkeeper sees the Payments page read-only', () => {
  it('the month for their properties, and no Record payment, Issue credit, Import, tenant report or ledger reads', async () => {
    server.user = { role: 'bookkeeper', permissions: { access_level: 'read_write' } }
    await render()
    await loaded()
    expect(cells('lease:L7').slice(2, 7)).toEqual(['$460.00', '$200.00', '$260.00', 'Cash', 'Owes +3'])
    expect(btn(/Record payment/)).toBeUndefined()
    expect(btn(/Issue credit/)).toBeUndefined()
    expect(btn(/Import payment history/)).toBeUndefined()
    // The name is just the name: the tenant report is not theirs.
    expect(host.querySelector('.pay-name')).toBeNull()
    expect(cells('lease:L7')[1]).toContain('Russ Fuller & Ann Fuller')
    // A row still opens to its payments and charges — from the row itself, nothing more is read.
    await click(rowOf('lease:L7'))
    expect(host.querySelectorAll('tr[data-line="payment"]')).toHaveLength(1)
    expect(server.gets.some(u => u.startsWith('/balances/payments-by-month') || u.startsWith('/payments?'))).toBe(false)
  })
})

// 10/13 (Nic): "the payments page ... should show all money coming in. The people
// that paid short-term stays like Space RV 10 and 11 at Mountain View, those
// should have details of the money that was paid."
describe('a stay guest\'s money: on their row, with its details', () => {
  const stayRow = (over: Partial<OpenMonthRow> = {}): OpenMonthRow => row({
    key: 'stay:b10', unitId: 'u10', space: 'RV 10', leaseId: null, householdId: null, residents: [], occupant: 'Rhea Register',
    invoiced: 0, paid: 589, owed: 0, methods: ['Cash'], status: 'stay', statusLabel: 'Checked in', statusColor: 'gray', dueDate: null,
    payments: [payment({ paymentId: 'sp1', paidOn: '2026-10-06', amount: 589, statusLabel: 'Settled', forLabel: 'Stay Oct 4 – Nov 4 · pay link' })],
    charges: [], stay: { bookingId: 'b10', checkIn: '2026-10-04', checkOut: '2026-11-04', nights: 31, statusLabel: 'Checked in',
                         owed: 0, balanceBilledOn: null, refunded: 0, refunds: [] },
    ...over,
  })

  it('the row: the guest, what was paid this month and how — no Invoiced, nothing owed, no Record payment', async () => {
    server.rolls['p-oak'] = roll([russ, stayRow()], {
      totals: { invoiced: 460, lateFees: 0, paid: 200, credit: 0, workTrade: 0, owed: 260, owedEarlier: 0, stays: 589, staysRefunded: 0 },
    })
    await render()
    await loaded()
    // 10/13 (Nic, round 3): "Stay rows SHOW what's still owed" — the Owed cell says it ("—": nothing).
    expect(cells('stay:b10').slice(1, 7)).toEqual(['Rhea Register', '', '$589.00', '—', 'Cash', 'Checked in'])
    expect(rowOf('stay:b10')!.querySelector('.pay-pill')!.className).toBe('pay-pill gray')
    expect(rowOf('stay:b10')!.querySelector('.pay-name')).toBeNull()
    expect(rowOf('stay:b10')!.querySelector('td.pay-record')!.textContent).toBe('')
    // The stays' money is its own total, apart from the bills.
    expect(host.querySelector('.cd-totals')!.textContent).toBe('Invoiced $460.00Paid $200.00Owed $260.00Stays $589.00')
    // Never in the header's "who is paying?" list.
    await click(btn(/^Record payment$/))
    expect(host.querySelector('.modal-overlay')!.textContent).not.toContain('Rhea Register')
  })

  it('opens to each payment — date, amount, method and what it was for — and the stay; nothing more is read', async () => {
    server.rolls['p-oak'] = roll([stayRow()])
    await render()
    await loaded()
    await click(rowOf('stay:b10'))
    const line = host.querySelector('tr[data-line="stay-payment"]')!
    expect([...line.querySelectorAll('td')].map(td => td.textContent)).toEqual(['Oct 6', '$589.00', 'Cash', 'Stay Oct 4 – Nov 4 · pay link'])
    expect(host.querySelector('tr[data-line="stay"]')!.textContent).toBe('Oct 4 – Nov 431 nightsChecked in')
    expect(server.gets.some(u => u.startsWith('/balances/payments-by-month') || u.startsWith('/payments?'))).toBe(false)
  })

  it('money an early check-out gave back this month is said under Paid and in the details', async () => {
    server.rolls['p-oak'] = roll([stayRow({
      statusLabel: 'Checked out', paid: 300,
      payments: [payment({ paymentId: 'sp2', paidOn: '2026-10-01', amount: 300, forLabel: 'Stay Oct 1 – Oct 8 · at the register' })],
      stay: { bookingId: 'b10', checkIn: '2026-10-01', checkOut: '2026-10-08', nights: 7, statusLabel: 'Checked out', owed: 0, balanceBilledOn: null, refunded: 100,
              refunds: [{ refundId: 'rf1', refundedOn: '2026-10-04', amount: 100, label: 'Cash · register Oct 1' }] },
    })], { totals: { invoiced: 0, lateFees: 0, paid: 0, credit: 0, workTrade: 0, owed: 0, owedEarlier: 0, stays: 300, staysRefunded: 100 } })
    await render()
    await loaded()
    expect(cells('stay:b10')[3]).toBe('$300.00$100.00 refunded')
    expect(host.querySelector('.cd-totals')!.textContent).toContain('Stays $300.00 ($100.00 refunded)')
    await click(rowOf('stay:b10'))
    const back = host.querySelector('tr[data-line="stay-refund"]')!
    expect([...back.querySelectorAll('td')].map(td => td.textContent)).toEqual(['Oct 4', '−$100.00', 'Refunded', 'Back to the guest — Cash · register Oct 1'])
  })
})

// 10/13 (Nic): "the payments page ... should show all money coming in."
describe('the register\'s and pay links\' money that is no bill and no stay', () => {
  const line = (over: Partial<OpenMonthOtherMoney> = {}): OpenMonthOtherMoney => ({
    id: 'sale1', saleId: 'sale1', kind: 'sale', day: '2026-10-01', amount: 23.92, methodLabel: 'Cash',
    forLabel: 'Propane · at the register', who: null, ...over,
  })
  const lines = [
    line(),
    line({ id: 'sale2', saleId: 'sale2', day: '2026-10-06', amount: 752.17, methodLabel: 'Card · online',
      forLabel: 'Electric (per kWh), RV site — monthly · pay link', who: 'Andres Razo' }),
    line({ id: 'ref1', saleId: 'sale1', kind: 'refund', day: '2026-10-07', amount: 5, forLabel: 'Refund at the register · Propane' }),
  ]
  const totals = (over: Partial<OpenMonthTotals> = {}): OpenMonthTotals => ({
    invoiced: 460, lateFees: 0, paid: 200, credit: 0, workTrade: 0, owed: 260, owedEarlier: 0, stays: 0, staysRefunded: 0, staysOwed: 0,
    otherIn: 776.09, otherRefunded: 5, folderIn: 776.09, folderRefunded: 5, ...over,
  })

  it('a folder under the month, closed until opened, its count and sums on its head; each line its day, what for, who, how and the amount', async () => {
    server.rolls['p-oak'] = roll([russ], { otherMoney: lines, totals: totals() })
    await render()
    await loaded()
    // Its own sum beside the bills', apart from them.
    expect(host.querySelector('.cd-totals')!.textContent)
      .toBe('Invoiced $460.00Paid $200.00Owed $260.00Register & pay links $776.09 ($5.00 refunded)')
    const folder = host.querySelector('[data-section="other-money"]')!
    const head = folder.querySelector('button.pay-other-head')!
    expect(head.textContent).toBe('▸Register sales and pay links2 sales · 1 refund · $776.09 · $5.00 refunded')
    expect(head.getAttribute('aria-expanded')).toBe('false')
    expect(folder.querySelector('.pay-other-list')).toBeNull()
    await click(head)
    const shown = [...folder.querySelectorAll('li.pay-other-line')]
    expect(shown.map(li => [li.getAttribute('data-line'), ...lineCells(li)])).toEqual([
      ['sale', 'Oct 1', 'Propane · at the registerNo name given · Cash', '$23.92'],
      ['sale', 'Oct 6', 'Electric (per kWh), RV site — monthly · pay linkAndres Razo · Card · online', '$752.17'],
      ['refund', 'Oct 7', 'Refund at the register · PropaneNo name given · Cash', '−$5.00'],
    ])
    // Money already in: nothing to press on it (these lines carry no breakdown), and nothing more is read.
    expect(folder.querySelectorAll('li button')).toHaveLength(0)
    expect(server.gets.some(u => u.startsWith('/balances/payments-by-month') || u.startsWith('/payments?'))).toBe(false)
    await click(head)
    expect(folder.querySelector('.pay-other-list')).toBeNull()
  })

  it('without the sums (decisions #25) the folder says only how many; with nothing of the kind there is no folder', async () => {
    server.rolls['p-oak'] = roll([russ], { otherMoney: lines })
    await render()
    await loaded()
    expect(host.querySelector('button.pay-other-head')!.textContent).toBe('▸Register sales and pay links2 sales · 1 refund')
    act(() => root.unmount())
    root = createRoot(host)
    server.rolls['p-oak'] = roll([russ])
    await render()
    await loaded()
    expect(host.querySelector('[data-section="other-money"]')).toBeNull()
  })

  it('on a phone it sits under the cards, one line each — never a table that scrolls sideways', async () => {
    ;(window as any).matchMedia = (q: string) => ({ matches: true, media: q, addEventListener: () => {}, removeEventListener: () => {} })
    try {
      server.rolls['p-oak'] = roll([russ], { otherMoney: lines })
      await render()
      await until(() => !!host.querySelector('.pay-cards'), 'the cards')
      const folder = host.querySelector('[data-section="other-money"]')!
      expect(folder.querySelector('table')).toBeNull()
      await click(folder.querySelector('button.pay-other-head'))
      expect(folder.querySelectorAll('li.pay-other-line')).toHaveLength(3)
    } finally { delete (window as any).matchMedia }
  })
})

describe('10/13 (Nic): "a \'Delinquent\' tag beside the name"', () => {
  it('a small red tag on the name\'s line, only on a delinquent household', async () => {
    server.rolls['p-oak'] = roll([{ ...russ, delinquent: true }, glenda])
    await render()
    await loaded()
    const tag = rowOf('lease:L7')!.querySelector('.pay-tag.delinquent')!
    expect(tag.textContent).toBe('Delinquent')
    expect(tag.parentElement!.tagName).toBe('TD')
    expect(tag.previousElementSibling!.textContent).toBe('Russ Fuller & Ann Fuller')
    expect(rowOf('lease:L2')!.querySelector('.pay-tag.delinquent')).toBeNull()
  })
})

// 10/13 (Nic): "phones = one card per household".
describe('on a phone: one card per household, never a table that scrolls sideways', () => {
  const phone = (matches: boolean) => {
    ;(window as any).matchMedia = (q: string) => ({ matches, media: q, addEventListener: () => {}, removeEventListener: () => {} })
  }
  afterEach(() => { delete (window as any).matchMedia })

  it('each row is a card with its figures, method, pill and Record payment; tapping opens its details in the card', async () => {
    phone(true)
    await render()
    await until(() => !!host.querySelector('.pay-cards'), 'the cards')
    expect(host.querySelector('table.pay-table')).toBeNull()
    const cards = [...host.querySelectorAll('.pay-card')]
    expect(cards.map(c => c.getAttribute('data-card-key'))).toEqual(['lease:L7', 'lease:L12', 'lease:L2', 'vacant:u3', 'lease:L10'])
    const russCard = cards[0]
    expect(russCard.querySelector('.pay-pill')!.textContent).toBe('Owes +3')
    expect([...russCard.querySelectorAll('.pay-card-figs > div')].map(d => d.textContent)).toEqual(['Invoiced$460.00', 'Paid$200.00', 'Owed$260.00'])
    expect(russCard.querySelector('.pay-card-method')!.textContent).toBe('Payment method: Cash')
    expect(russCard.querySelector('.pay-card-record button')!.textContent).toBe('Record payment')
    // An empty space: just the space and its pill — its number after the same caret, and it opens too.
    expect(cards[3].querySelector('.pay-card-figs')).toBeNull()
    expect(cards[3].querySelector('.pay-pill')!.textContent).toBe('Vacant')
    expect(cards.map(c => c.querySelector('.pay-space')!.firstElementChild?.className)).toEqual(Array(5).fill('pay-caret'))
    expect(cards[3].querySelector('.pay-space')!.textContent).toBe('▸MH 03')
    await click(cards[3].querySelector('.pay-card-head'))
    expect(cards[3].querySelector('.pay-card-detail')!.textContent).toBe('Vacant — nothing billed this month.')
    await click(russCard.querySelector('.pay-card-head'))
    expect(russCard.querySelectorAll('.pay-card-detail tr[data-line="payment"]')).toHaveLength(1)
    // Record payment from the card opens the desk window, not the details.
    await click(cards[1].querySelector('.pay-card-record button'))
    expect(host.querySelector('.stub-desk')!.textContent).toContain('anchor=chg-nora')
    expect(cards[1].querySelector('.pay-card-detail')).toBeNull()
  })

  it('a desk-sized screen keeps the table', async () => {
    phone(false)
    await render()
    await loaded()
    expect(host.querySelector('.pay-cards')).toBeNull()
  })
})

// ─── 10/13 (Nic), round 3 ────────────────────────────────────────────────────

describe('10/13 (Nic), round 3: "Stay rows SHOW what\'s still owed"', () => {
  const owing = (): OpenMonthRow => row({
    key: 'stay:b30', unitId: 'u30', space: 'RV 30', leaseId: null, householdId: null, residents: [], occupant: 'Bea Balance',
    invoiced: 0, paid: 0, owed: 360, methods: [], status: 'stay', statusLabel: 'Confirmed', statusColor: 'gray', dueDate: null,
    payments: [], charges: [], recordWith: null,
    stay: { bookingId: 'b30', checkIn: '2026-10-12', checkOut: '2026-10-19', nights: 7, statusLabel: 'Confirmed',
            owed: 360, balanceBilledOn: '2026-10-12', refunded: 0, refunds: [] },
  })

  it('the row\'s Owed is what is owed on the stay now, the day its pay link went out under it; its sum beside the stays\'', async () => {
    server.rolls['p-oak'] = roll([owing(), russ], {
      totals: { invoiced: 460, lateFees: 0, paid: 200, credit: 0, workTrade: 0, owed: 260, owedEarlier: 0, stays: 0, staysRefunded: 0,
                staysOwed: 360, otherIn: 0, otherRefunded: 0, folderIn: 0, folderRefunded: 0 },
    })
    await render()
    await loaded()
    // The server's order: owing first — the stay with its balance, in its space order.
    expect([...host.querySelectorAll('tr.pay-row')].map(r => r.getAttribute('data-key'))).toEqual(['stay:b30', 'lease:L7'])
    expect(cells('stay:b30').slice(1, 7)).toEqual(['Bea Balance', '', '—', '$360.00pay link sent Oct 12', '—', 'Confirmed'])
    // A stay is never taken at the desk.
    expect(rowOf('stay:b30')!.querySelector('td.pay-record')!.textContent).toBe('')
    expect(host.querySelector('.cd-totals')!.textContent).toBe('Invoiced $460.00Paid $200.00Owed $260.00Owed on stays $360.00')
    await click(rowOf('stay:b30'))
    expect([...host.querySelector('tr[data-line="stay-owed"]')!.querySelectorAll('td')].map(td => td.textContent))
      .toEqual(['Still owed on the stay', '$360.00', 'Pay link sent Oct 12'])
  })

  it('a balance not owed yet (before arrival, not billed) says what is left and when it comes due; on a phone the card shows Paid and Owed', async () => {
    ;(window as any).matchMedia = (q: string) => ({ matches: true, media: q, addEventListener: () => {}, removeEventListener: () => {} })
    try {
      const dee = owing()
      server.rolls['p-oak'] = roll([{ ...dee, paid: 50, owed: 0, stay: { ...dee.stay!, owed: 150, balanceBilledOn: null } }])
      await render()
      await until(() => !!host.querySelector('.pay-cards'), 'the cards')
      const card = host.querySelector('.pay-card')!
      expect(card.querySelector('.pay-card-figs')!.className).toBe('pay-card-figs two')
      expect([...card.querySelectorAll('.pay-card-figs > div')].map(d => d.textContent))
        .toEqual(['Paid$50.00', 'Owed—$150.00 due on arrival, Oct 12'])
      await click(card.querySelector('.pay-card-head'))
      expect(card.querySelector('tr[data-line="stay-owed"]')!.textContent).toBe('Still owed on the stay$150.00Due on arrival, Oct 12')
    } finally { delete (window as any).matchMedia }
  })

  it('a stay owing now with no pay link sent (here, its balance never billed) says so in the details', async () => {
    const hal = owing()
    server.rolls['p-oak'] = roll([{ ...hal, occupant: 'Hal Here', owed: 200, statusLabel: 'Checked in',
                                    stay: { ...hal.stay!, owed: 200, balanceBilledOn: null, statusLabel: 'Checked in' } }])
    await render()
    await loaded()
    expect(cells('stay:b30').slice(1, 7)).toEqual(['Hal Here', '', '—', '$200.00', '—', 'Checked in'])
    await click(rowOf('stay:b30'))
    expect([...host.querySelector('tr[data-line="stay-owed"]')!.querySelectorAll('td')].map(td => td.textContent))
      .toEqual(['Still owed on the stay', '$200.00', 'No pay link sent yet'])
  })
})

describe('10/13 (Nic), round 3: "Pay links / register sales that name a space go ON that space\'s row"', () => {
  const andres = (over: Partial<OpenMonthOtherMoney> = {}): OpenMonthOtherMoney => ({
    id: 'sale27', saleId: 'sale27', kind: 'sale', day: '2026-10-06', amount: 752.17, methodLabel: 'Card · online',
    forLabel: 'Electric (per kWh), Electric (per kWh) — September, RV 27, RV site — monthly · pay link', who: 'Andres Razo', ...over,
  })
  const rv27 = (): OpenMonthRow => ({
    ...vacant('RV 27', 'u27'),
    otherMoney: [andres(), andres({ id: 'ref27', kind: 'refund', day: '2026-10-07', amount: 10, methodLabel: 'Cash', forLabel: 'Refund at the register · Electric' })],
    otherIn: 752.17, otherRefunded: 10,
  })
  const walkIn: OpenMonthOtherMoney = {
    id: 'sale1', saleId: 'sale1', kind: 'sale', day: '2026-10-01', amount: 23.92, methodLabel: 'Cash',
    forLabel: 'Propane · at the register', who: null,
  }

  it('an empty space a sale names says the money under Paid and how it came, and opens to its lines; the folder keeps the rest', async () => {
    server.rolls['p-oak'] = roll([russ, rv27(), { ...glenda, otherMoney: [andres({ id: 'sale2', saleId: 'sale2', amount: 20, methodLabel: 'Cash', who: null, forLabel: 'Propane — rv02 · at the register' })], otherIn: 20 }], {
      otherMoney: [walkIn],
      totals: { invoiced: 920, lateFees: 0, paid: 660, credit: 0, workTrade: 0, owed: 260, owedEarlier: 0, stays: 0, staysRefunded: 0,
                staysOwed: 0, otherIn: 796.09, otherRefunded: 10, folderIn: 23.92, folderRefunded: 0 },
    })
    await render()
    await loaded()
    // Still a gray Vacant row in its spot — Invoiced and Owed are a bill's; the money is under Paid, never in it.
    expect(cells('vacant:u27').slice(2, 7)).toEqual(['', '$752.17 register & pay links$10.00 refunded', '', 'Card · online', 'Vacant'])
    expect(rowOf('vacant:u27')!.getAttribute('aria-expanded')).toBe('false')
    // Beside a household's bills: "+".
    expect(cells('lease:L2')[3]).toBe('$460.00+ $20.00 register & pay links')
    expect(cells('lease:L2')[5]).toBe('Cash')
    // The header: all of it; the folder's head: only its own.
    expect(host.querySelector('.cd-totals')!.textContent).toContain('Register & pay links $796.09 ($10.00 refunded)')
    expect(host.querySelector('button.pay-other-head')!.textContent).toBe('▸Register sales and pay links1 sale · $23.92')
    await click(rowOf('vacant:u27'))
    const block = host.querySelector('tr.pay-detail [data-block="space-money"]')!
    // Still said to be Vacant, nothing billed — its money is no bill.
    expect(host.querySelector('tr.pay-detail [data-block="space-only"]')!.textContent).toBe('Vacant — nothing billed this month.')
    expect([...block.querySelectorAll('li.pay-other-line')].map(li => [li.getAttribute('data-line'), ...lineCells(li)])).toEqual([
      ['sale', 'Oct 6', 'Electric (per kWh), Electric (per kWh) — September, RV 27, RV site — monthly · pay linkAndres Razo · Card · online', '$752.17'],
      ['refund', 'Oct 7', 'Refund at the register · ElectricAndres Razo · Cash', '−$10.00'],
    ])
    // Money already in: nothing to press, and nothing more is read.
    expect(block.querySelectorAll('button')).toHaveLength(0)
    expect(server.gets.some(u => u.startsWith('/balances/payments-by-month') || u.startsWith('/payments?'))).toBe(false)
  })

  it('a space whose only register money this month is a refund (its sale an earlier month\'s) says the refund, never "$0.00"', async () => {
    const back = andres({ id: 'ref27', kind: 'refund', day: '2026-10-07', amount: 10, methodLabel: 'Cash', forLabel: 'Refund at the register · Electric' })
    server.rolls['p-oak'] = roll([russ, { ...vacant('RV 27', 'u27'), otherMoney: [back], otherIn: 0, otherRefunded: 10 }])
    await render()
    await loaded()
    expect(cells('vacant:u27').slice(2, 7)).toEqual(['', '—$10.00 refunded', '', '—', 'Vacant'])
  })

  it('an empty space no sale names shows no money, and opens to say nothing is billed', async () => {
    await render()
    await loaded()
    expect(rowOf('vacant:u3')!.classList.contains('pay-click')).toBe(true)
    expect(cells('vacant:u3').slice(2, 6)).toEqual(['', '', '', ''])
    await click(rowOf('vacant:u3'))
    const detail = host.querySelector('tr.pay-detail')!
    expect(detail.textContent).toBe('Vacant — nothing billed this month.')
    expect(detail.querySelector('[data-block="space-money"]')).toBeNull()
  })
})

// 10/13 (Nic): "When Andres Razo paid by card online for his stay ... it looks
// like that charge is just for electric. It's not. ... It's not clickable to
// show an expanded breakdown. It shows electric per kilowatt hour, electric per
// kilowatt hour, September, RV 27, RV site monthly pay link. It's not got a
// good breakdown between what's a billback on the electricity and what is not."
describe('10/13 (Nic): a register sale or pay link opens to its breakdown', () => {
  // As production has it (read-only, 10/13): pay link ff58520a…, Oct 6, card
  // online, $752.17 + $26.88 card fee = $779.05 charged; its three line items.
  const part = (over: Partial<OpenMonthSalePart>): OpenMonthSalePart => ({
    kind: 'item', label: '', what: null, qty: null, unitPrice: null, unit: null, amount: 0, ...over,
  })
  const andres: OpenMonthOtherMoney = {
    id: 'ff58520a', saleId: 'ff58520a', kind: 'sale', day: '2026-10-06', amount: 752.17, methodLabel: 'Card · online',
    forLabel: 'Electric (per kWh), Electric (per kWh) — September, RV 27, RV site — monthly · pay link', who: 'Andres Razo',
    parts: [
      part({ label: 'Electric (per kWh)', what: 'Electric bill-back', qty: 387, unitPrice: 0.21, unit: 'kWh', amount: 81.27 }),
      part({ label: 'Electric (per kWh) — September, RV 27', what: 'Electric bill-back', qty: 390, unitPrice: 0.21, unit: 'kWh', amount: 81.9 }),
      part({ label: 'RV site — monthly', what: 'Site rent', qty: 1, unitPrice: 589, amount: 589 }),
    ],
    cardFee: 26.88,
  }
  const propane: OpenMonthOtherMoney = {
    id: '37fe8a03', saleId: '37fe8a03', kind: 'sale', day: '2026-10-06', amount: 23.92, methodLabel: 'Cash',
    forLabel: 'Propane · at the register', who: null, cardFee: 0,
    parts: [
      part({ label: 'Propane', qty: 6.8, unitPrice: 3.3, amount: 22.44 }),
      part({ kind: 'tax', label: 'Transaction privilege tax', amount: 1.48 }),
    ],
  }
  const breakdown = (li: Element) => [...li.querySelectorAll('[data-block="sale-parts"] tr')]
    .map(tr => [tr.getAttribute('data-part'), ...[...tr.querySelectorAll('td')].map(td => td.textContent)])

  it('on its space\'s row: each part, what it is — the electric bill-backs apart from the site rent — and its own amount', async () => {
    server.rolls['p-oak'] = roll([russ, { ...vacant('RV 27', 'u27'), otherMoney: [andres], otherIn: 752.17 }])
    await render()
    await loaded()
    await click(rowOf('vacant:u27'))
    const li = host.querySelector('tr.pay-detail [data-block="space-money"] li.pay-other-line')!
    const open = li.querySelector('button.pay-other-row')!
    expect(open.getAttribute('aria-expanded')).toBe('false')
    expect(lineCells(li)).toEqual([
      'Oct 6', 'Electric (per kWh), Electric (per kWh) — September, RV 27, RV site — monthly · pay linkAndres Razo · Card · online', '$752.17',
    ])
    expect(li.querySelector('[data-block="sale-parts"]')).toBeNull()
    await click(open)
    expect(li.querySelector('button.pay-other-row')!.getAttribute('aria-expanded')).toBe('true')
    expect(breakdown(li)).toEqual([
      ['item', 'Electric (per kWh)Electric bill-back · 387 kWh × $0.21', '$81.27'],
      ['item', 'Electric (per kWh) — September, RV 27Electric bill-back · 390 kWh × $0.21', '$81.90'],
      ['item', 'RV site — monthlySite rent', '$589.00'],
      ['total', 'In all', '$752.17'],
      ['card-fee', 'Card fee the payer paid on top — not in the $752.17', '$26.88'],
    ])
    // Opening the sale never closes the row, and nothing more is read.
    expect(rowOf('vacant:u27')!.getAttribute('aria-expanded')).toBe('true')
    expect(server.gets.some(u => u.startsWith('/balances/payments-by-month') || u.startsWith('/payments?'))).toBe(false)
    await click(li.querySelector('button.pay-other-row'))
    expect(li.querySelector('[data-block="sale-parts"]')).toBeNull()
  })

  it('in the folder too: a counter sale\'s gallons and its tax; a refund has no breakdown, its day still in line', async () => {
    const back: OpenMonthOtherMoney = {
      id: 'ref1', saleId: '37fe8a03', kind: 'refund', day: '2026-10-07', amount: 5, methodLabel: 'Cash',
      forLabel: 'Refund at the register · Propane', who: null, parts: [], cardFee: 0,
    }
    server.rolls['p-oak'] = roll([russ], { otherMoney: [propane, back] })
    await render()
    await loaded()
    const folder = host.querySelector('[data-section="other-money"]')!
    await click(folder.querySelector('button.pay-other-head'))
    const [saleLi, refundLi] = [...folder.querySelectorAll('li.pay-other-line')]
    expect(refundLi.querySelector('button')).toBeNull()
    // The caret's place is kept on the refund, so both days start in the same column.
    expect(refundLi.querySelector('.pay-other-row')!.firstElementChild!.className).toBe('pay-caret')
    expect(refundLi.querySelector('.pay-other-row')!.firstElementChild!.textContent).toBe('')
    await click(saleLi.querySelector('button.pay-other-row'))
    expect(breakdown(saleLi)).toEqual([
      ['item', 'Propane6.8 × $3.30', '$22.44'],
      ['tax', 'Transaction privilege tax', '$1.48'],
      ['total', 'In all', '$23.92'],
    ])
  })

  it('on a phone the breakdown opens inside the card', async () => {
    ;(window as any).matchMedia = (q: string) => ({ matches: true, media: q, addEventListener: () => {}, removeEventListener: () => {} })
    try {
      server.rolls['p-oak'] = roll([{ ...vacant('RV 27', 'u27'), otherMoney: [andres], otherIn: 752.17 }])
      await render()
      await until(() => !!host.querySelector('.pay-cards'), 'the cards')
      const card = host.querySelector('.pay-card')!
      await click(card.querySelector('.pay-card-head'))
      await click(card.querySelector('.pay-card-detail button.pay-other-row'))
      expect(card.querySelectorAll('[data-block="sale-parts"] tr[data-part="item"]')).toHaveLength(3)
    } finally { delete (window as any).matchMedia }
  })
})

// ─── 10/14 (Nic): "show in the moved-out section of Payments" ────────────────

describe('10/14 (Nic): "Moved out, still owes" under the month', () => {
  const olaf = {
    key: 'stay:b35', kind: 'stay' as const, space: 'RV 35', leaseId: null, householdId: null, residents: [],
    guest: 'Olaf Over', leftOn: '2026-09-27', stayDates: 'Sep 20 – Sep 27', owed: 360, months: [],
  }
  const moe = {
    key: 'lease:L5', kind: 'household' as const, space: 'MH 05', leaseId: 'L5', householdId: 't-moe',
    residents: [{ tenantId: 't-moe', name: 'Moe Moved', primary: true }], guest: null, leftOn: '2026-09-30', stayDates: null,
    owed: 495, months: [{ month: '2026-09', owed: 495 }],
  }

  it('a closed folder with who is in it and, with the sums, what they owe; opened, each space, who, when they left and what is owed', async () => {
    server.rolls['p-oak'] = roll([russ], {
      movedOutOwing: [moe, olaf],
      totals: { invoiced: 460, lateFees: 0, paid: 200, credit: 0, workTrade: 0, owed: 260, owedEarlier: 0, stays: 0, staysRefunded: 0,
                staysOwed: 0, otherIn: 0, otherRefunded: 0, folderIn: 0, folderRefunded: 0, movedOutOwed: 855 },
    })
    await render()
    await loaded()
    const head = host.querySelector('[data-section="moved-out"] button.pay-other-head')!
    expect(head.textContent).toBe('▸Moved out, still owes1 household · 1 stay guest · $855.00 owed')
    expect(host.querySelector('.cd-totals')!.textContent).toContain('Moved out, still owes $855.00')
    // Nobody in it is a row.
    expect(rowOf('stay:b35')).toBeNull()
    await click(head)
    const lines = [...host.querySelectorAll('[data-section="moved-out"] li')].map(li => lineCells(li))
    expect(lines).toEqual([
      ['MH 05', 'Moe MovedLease ended Sep 30 · still owes for Sep 2026 $495.00', '$495.00'],
      ['RV 35', 'Olaf OverStay Sep 20 – Sep 27 · checked out Sep 27', '$360.00'],
    ])
  })

  it('without the sums, the folder still says who; nobody in it, no folder', async () => {
    server.rolls['p-oak'] = roll([russ], { movedOutOwing: [olaf] })
    await render()
    await loaded()
    expect(host.querySelector('[data-section="moved-out"] button.pay-other-head')!.textContent).toBe('▸Moved out, still owes1 stay guest')
    server.rolls['p-oak'] = roll([russ])
    act(() => root.unmount())
    root = createRoot(host)
    await render()
    await loaded()
    expect(host.querySelector('[data-section="moved-out"]')).toBeNull()
  })
})
