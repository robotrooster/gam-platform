/**
 * S655 money plan, Step 14 (fix round) — the Payments ledger.
 *
 * A payment that came back says why: the bank's reason in words with its code,
 * and the zero-tolerance mark (the old payment detail window showed both; the
 * ledger by month must not lose them). And somebody who cannot see the ledger
 * is told where to go next for exactly the switches they have — never a page
 * with no way forward.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from 'react-query'
import { MemoryRouter } from 'react-router-dom'

const server = vi.hoisted(() => ({
  month: null as any,
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

vi.mock('../lib/api', () => ({
  apiGet: async (url: string) => {
    server.gets.push(url)
    if (url.startsWith('/balances/payments-by-month')) return server.month
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

import { PaymentsPage } from './PaymentsPage'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const line = (over: any = {}) => ({
  paymentId: 'c1', label: 'Rent', detail: null, dueDate: '2026-09-01', amount: 460, paid: 460, credit: 0, returned: 0,
  creditReturned: 0, unitNumber: 'MH 04', propertyName: 'Oak Park', ...over,
})
const payment = (over: any = {}) => ({
  id: 'rcpt1', kind: 'receipt', name: 'Glenda Moss', unitNumber: 'MH 04', propertyName: 'Oak Park',
  paidOn: '2026-09-03', arrivedOn: '2026-09-05', owed: 460, amount: 460, creditApplied: 0, returned: 0, creditReturned: 0,
  method: 'ach', methodLabel: 'Bank', status: 'settled', statusLabel: 'Paid', paidFor: 'September rent',
  daysLate: 0, timingLabel: 'On time', lines: [line()], ...over,
})
const month = (payments: any[]) => ({
  month: '2026-09', months: ['2026-10', '2026-09'], payments, workTrade: [], stillOweHouseholds: null,
})

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  server.gets = []; server.paymentRows = []; server.paymentPages = null; server.month = month([])
  server.user = { role: 'landlord', permissions: {} }
  server.leases = []; server.posts = []; server.postHold = null
  window.localStorage.clear()
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
    root.render(<QueryClientProvider client={qc}><MemoryRouter><PaymentsPage /></MemoryRouter></QueryClientProvider>)
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

describe('a payment that came back says why', () => {
  it('shows the bank’s reason in words with its code, and the zero-tolerance mark, on the payment and on its charge', async () => {
    server.month = month([payment({ status: 'returned', statusLabel: 'Returned', returned: 460, lines: [line({ returned: 460 })] })])
    server.paymentRows = [{ id: 'c1', returnCode: 'R10', returnReason: 'Customer advises not authorized', zeroToleranceFlag: true }]
    await render()
    await until(() => text().includes('Bank return:'), 'the reason')
    expect(text()).toContain('Bank return: the account holder told the bank this debit was not authorized (R10)')
    expect(text()).toContain('Zero tolerance — bank payments from them are stopped')
    // Read for the months of the bills that came back only.
    expect(server.gets).toContain('/payments?from=2026-09-01&to=2026-09-30&limit=1000&page=1')
    // One page had it: no more are read.
    expect(server.gets.filter(u => u.startsWith('/payments?'))).toHaveLength(1)
    // Show line items: the charge carries it too.
    const row = host.querySelector('tr.cd-ledger-row') as HTMLElement
    await act(async () => { row.click() })
    expect(host.querySelector('tr.cd-ledger-items')?.textContent).toContain('(R10)')
  })

  it('a returned charge past the first 1,000 charges of the month is still found (a large portfolio), and nothing is said missing', async () => {
    server.month = month([payment({ status: 'returned', statusLabel: 'Returned', returned: 460, lines: [line({ returned: 460 })] })])
    const fill = (n: number, from: number) => Array.from({ length: n }, (_, i) => ({ id: `other${from + i}` }))
    server.paymentPages = {
      1: fill(1000, 0),
      2: [...fill(400, 1000), { id: 'c1', returnCode: 'R01', returnReason: 'Insufficient funds', zeroToleranceFlag: false }, ...fill(599, 1400)],
      3: fill(10, 2000),
    }
    await render()
    await until(() => text().includes('Bank return:'), 'the reason')
    expect(text()).toContain('Bank return: there was not enough money in the account (R01)')
    expect(server.gets.filter(u => u.startsWith('/payments?'))).toEqual([
      '/payments?from=2026-09-01&to=2026-09-30&limit=1000&page=1',
      '/payments?from=2026-09-01&to=2026-09-30&limit=1000&page=2',
    ])
    expect(text()).not.toContain('may show no reason')
  })

  it('a month with nothing returned reads no return details at all', async () => {
    server.month = month([payment()])
    await render()
    await until(() => text().includes('Glenda Moss'), 'the ledger')
    expect(server.gets.some(u => u.startsWith('/payments?'))).toBe(false)
    expect(text()).not.toContain('Bank return')
  })
})

describe('somebody who cannot see the ledger is told the next step', () => {
  it('with Outstanding Balances: a button to it', async () => {
    server.user = { role: 'onsite_manager', permissions: { 'payments.view': true, 'balances.view': true, take_payment: true } }
    await render()
    expect(text()).toContain('To take a payment, use Outstanding Balances.')
    expect([...host.querySelectorAll('button')].some(b => b.textContent === 'Open Outstanding Balances')).toBe(true)
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
})

describe('Issue credit closes only from its own buttons', () => {
  it('a click outside never closes it, and while the credit is being issued Cancel waits — the result is always said', async () => {
    server.leases = [{ id: 'L1', status: 'active', unitNumber: 'MH 04', propertyName: 'Oak Park',
                       tenants: [{ firstName: 'Glenda', lastName: 'Moss' }] }]
    let release!: () => void
    server.postHold = new Promise<void>(r => { release = r })
    await render()
    const btn = (re: RegExp) => [...host.querySelectorAll('button')].find(b => re.test(b.textContent ?? ''))
    const setValue = async (el: HTMLInputElement, v: string) => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      await act(async () => { setter.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })) })
    }
    await until(() => !!btn(/Issue credit/), 'the button')
    await act(async () => { btn(/Issue credit/)!.click() })
    await until(() => !!host.querySelector('.modal-overlay'), 'the window')
    await act(async () => { (host.querySelector('.modal-overlay') as HTMLElement).click() })
    expect(host.querySelector('.modal-overlay')).not.toBeNull()
    await setValue(host.querySelector('.modal-overlay input.form-input') as HTMLInputElement, 'Glenda')
    await until(() => !!btn(/^Glenda Moss · MH 04/), 'the match')
    await act(async () => { btn(/^Glenda Moss · MH 04/)!.click() })
    await setValue(host.querySelector('.modal-overlay input.mono') as HTMLInputElement, '25')
    await act(async () => { btn(/^Issue credit$/)!.click() })
    await until(() => text().includes('Issuing…'), 'the credit on its way')
    expect(btn(/^Cancel$/)!.disabled).toBe(true)
    await act(async () => { btn(/^Cancel$/)!.click() })
    await act(async () => { (host.querySelector('.modal-overlay') as HTMLElement).click() })
    expect(host.querySelector('.modal-overlay')).not.toBeNull()
    await act(async () => { release() })
    await until(() => text().includes('Credit of $25.00 issued.'), 'the result')
    expect(host.querySelector('.modal-overlay')).toBeNull()
    expect(server.posts).toEqual([{ url: '/tenant-credits', body: { leaseId: 'L1', amount: 25, category: 'goodwill', reason: null } }])
  })
})

// ─── Fix pass 2: the ledger screen does what #29, #25 and #36.A ask ──────────

const totals = (over: any = {}) => ({ paid: 920, paidFromCredit: 10, returnedSince: 0, creditReturnedSince: 0, clearing: 460, payments: 2, ...over })
const setSelect = async (el: HTMLSelectElement, v: string) => {
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!
  await act(async () => { setter.call(el, v); el.dispatchEvent(new Event('change', { bubbles: true })) })
}

describe('the month total (decisions #25)', () => {
  it('shows only when the server sent it: paid, from credit and still clearing', async () => {
    server.month = { ...month([payment()]), totals: totals() }
    await render()
    await until(() => text().includes('Glenda Moss'), 'the ledger')
    const line = host.querySelector('.cd-totals')?.textContent
    expect(line).toBe('Paid $920.00From credit $10.00Still clearing $460.00')
  })
  it('is not there at all when the server sent none (anyone but an owner or property manager)', async () => {
    server.month = month([payment()])
    await render()
    await until(() => text().includes('Glenda Moss'), 'the ledger')
    expect(host.querySelector('.cd-totals')).toBeNull()
    expect(text()).not.toContain('Still clearing')
  })
})

describe('what each line says', () => {
  it('a work-trade household reads "Work trade — covered" with no dollar figure', async () => {
    server.month = { ...month([]), workTrade: [{ tenantId: 't9', name: 'Dakota Lane', unitNumber: 'RV 44', propertyName: 'Mountain View', label: 'Work trade — covered' }] }
    await render()
    await until(() => !!host.querySelector('.cd-worktrade-line'), 'the work-trade line')
    expect(host.querySelector('.cd-worktrade-line')!.textContent).toBe('Work trade — covered · Dakota Lane · RV 44 · Mountain View')
    expect(host.querySelector('.cd-worktrade-line')!.textContent).not.toContain('$')
    expect(text()).not.toContain('No payments on this month’s bills yet.')
  })
  it('a bank payment still clearing is listed and marked clearing', async () => {
    server.month = month([payment({ status: 'clearing', statusLabel: 'Clearing', arrivedOn: null })])
    await render()
    await until(() => text().includes('Glenda Moss'), 'the ledger')
    const badge = host.querySelector('tr.cd-ledger-row .badge')!
    expect(badge.textContent).toBe('Clearing')
    expect(badge.className).toContain('badge-blue')
  })
  it('a bill paid from credit reads "from credit" with the credit, never a money amount of its own', async () => {
    server.month = month([payment({ kind: 'credit', amount: 0, creditApplied: 460, method: null, methodLabel: 'Paid from credit',
      arrivedOn: null, lines: [line({ paid: 0, credit: 460 })] })])
    await render()
    await until(() => text().includes('Glenda Moss'), 'the ledger')
    const paidCell = host.querySelectorAll('tr.cd-ledger-row td')[5]
    expect(paidCell.textContent).toBe('from credit$460.00')
    expect(paidCell.textContent).not.toContain('$0.00')
  })
})

describe('credit a dispute or bank return took back (Step 11’s creditReturned)', () => {
  it('a bill paid from credit whose credit was taken back says so on the payment, on its charge and why', async () => {
    server.month = month([payment({ kind: 'credit', amount: 0, creditApplied: 10, creditReturned: 10, owed: 10,
      status: 'returned', statusLabel: 'Returned', method: null, methodLabel: 'Paid from credit', arrivedOn: null,
      lines: [line({ amount: 460, paid: 0, credit: 10, creditReturned: 10 })] })])
    await render()
    await until(() => text().includes('Glenda Moss'), 'the ledger')
    const row = host.querySelector('tr.cd-ledger-row') as HTMLElement
    expect(row.textContent).toContain('$10.00 credit taken back')
    expect(row.textContent).toContain('The payment that put this credit on their account was disputed or returned — this bill is owed again for that part')
    // Its own money was not touched: nothing says money was taken back.
    expect(row.textContent).not.toMatch(/\$10\.00 taken back/)
    await act(async () => { row.click() })
    expect(host.querySelector('tr.cd-ledger-items')!.textContent).toContain('$10.00 from credit$10.00 credit taken back')
  })
  it('the month total says the credit taken back beside "From credit", never inside it', async () => {
    server.month = { ...month([payment()]), totals: totals({ paidFromCredit: 0, creditReturnedSince: 10, clearing: 0 }) }
    await render()
    await until(() => text().includes('Glenda Moss'), 'the ledger')
    expect(host.querySelector('.cd-totals')!.textContent).toBe('Paid $920.00Credit taken back since $10.00')
  })
})

describe('the current month’s pointer (decisions #29)', () => {
  it('shows how many households still owe — a count, never dollars — with the way to Outstanding Balances', async () => {
    server.month = { ...month([payment()]), month: '2026-10', stillOweHouseholds: 3 }
    await render()
    await until(() => !!host.querySelector('.cd-pointer'), 'the pointer')
    const pointer = host.querySelector('.cd-pointer')!.textContent ?? ''
    expect(pointer).toBe('3 households still owe — see Outstanding BalancesOpen Outstanding Balances')
    expect(pointer).not.toContain('$')
  })
  it('a past month (no count sent) has no pointer', async () => {
    server.month = month([payment()])
    await render()
    await until(() => text().includes('Glenda Moss'), 'the ledger')
    expect(host.querySelector('.cd-pointer')).toBeNull()
  })
})

describe('moving around the ledger', () => {
  it('picking a month asks for that month as YYYY-MM', async () => {
    server.month = { ...month([payment()]), month: '2026-10' }
    await render()
    await until(() => text().includes('Glenda Moss'), 'the ledger')
    expect(server.gets).toContain('/balances/payments-by-month')
    await setSelect(host.querySelector('select.cd-month-select') as HTMLSelectElement, '2026-09')
    await until(() => server.gets.includes('/balances/payments-by-month?month=2026-09'), 'the month asked for')
  })
  it('Show line items opens every payment’s charges and is remembered for this person', async () => {
    server.user = { id: 'u1', role: 'landlord', permissions: {} }
    server.month = month([
      payment(),
      payment({ id: 'rcpt2', name: 'Russ Fuller', lines: [line({ paymentId: 'c2', label: 'Rent' }), line({ paymentId: 'c3', label: 'Water', amount: 40, paid: 40 })] }),
    ])
    await render()
    await until(() => text().includes('Russ Fuller'), 'the ledger')
    expect(host.querySelectorAll('tr.cd-ledger-items')).toHaveLength(0)
    const toggle = () => host.querySelector('label.cd-toggle input') as HTMLInputElement
    await act(async () => { toggle().click() })
    expect(host.querySelectorAll('tr.cd-ledger-items')).toHaveLength(3)
    expect(window.localStorage.getItem('gam.payments.showLineItems.u1')).toBe('1')
    // Opened again later: still on.
    act(() => root.unmount())
    root = createRoot(host)
    await render()
    await until(() => text().includes('Russ Fuller'), 'the ledger again')
    expect(toggle().checked).toBe(true)
    expect(host.querySelectorAll('tr.cd-ledger-items')).toHaveLength(3)
  })
})
