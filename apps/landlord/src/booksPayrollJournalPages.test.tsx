// @vitest-environment jsdom
/**
 * 10/12 (Nic, ledger P7): the Journal Entries and Run Payroll screens. A
 * journal line names its property (none = the whole company), an entry is an
 * ordinary or an adjusting one, and Reverse takes one back on a day the
 * bookkeeper picks. A payroll run takes each paycheck's unemployment taxes,
 * puts W-2 work-trade hours on the run as their own paycheck, and records 1099
 * hours as a contractor bill. Plain words throughout, never a raw value. The
 * same files ship in GAM Books (bookkeeping-parity.test.ts).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from 'react-query'
import { MemoryRouter } from 'react-router-dom'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const server = vi.hoisted(() => ({
  gets: {} as Record<string, any>,
  posts: [] as Array<{ url: string; body: any }>,
  patches: [] as Array<{ url: string; body: any }>,
  replies: {} as Record<string, any>,
}))

vi.mock('./lib/api', () => ({
  api: {
    get: async (url: string) => {
      if (!(url in server.gets)) throw new Error(`unexpected GET ${url}`)
      return { data: { success: true, data: server.gets[url] } }
    },
    post: async (url: string, body: any) => {
      server.posts.push({ url, body })
      return { data: { success: true, data: server.replies[url] ?? {} } }
    },
    patch: async (url: string, body: any) => {
      server.patches.push({ url, body })
      return { data: { success: true, data: {} } }
    },
  },
}))
vi.mock('./context/AuthContext', () => ({ useAuth: () => ({ user: { id: 'u1', role: 'landlord' } }) }))
vi.mock('./components/dialogs', () => ({ toast: Object.assign(() => {}, { error: () => {} }), appConfirm: async () => true }))

import { JournalEntriesPage } from './bookkeeping/JournalEntriesPage'
import { RunPayrollPage } from './bookkeeping/RunPayrollPage'
import { ChartOfAccountsPage } from './bookkeeping/ChartOfAccountsPage'

let root: Root | null = null
let host: HTMLDivElement | null = null
const flush = async () => { for (let i = 0; i < 6; i++) await act(async () => { await new Promise(r => setTimeout(r, 0)) }) }
const text = () => host!.textContent || ''
const button = (label: string) => [...host!.querySelectorAll('button')].find(b => b.textContent?.trim() === label) as HTMLButtonElement | undefined

async function render(el: JSX.Element) {
  host = document.createElement('div')
  document.body.appendChild(host)
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  await act(async () => {
    root = createRoot(host!)
    root.render(<QueryClientProvider client={qc}><MemoryRouter>{el}</MemoryRouter></QueryClientProvider>)
  })
  await flush()
}

/** Types into a controlled input or picks in a select, the way a person would. */
async function setValue(el: Element, value: string) {
  const isSelect = el instanceof HTMLSelectElement
  const proto = isSelect ? HTMLSelectElement.prototype : HTMLInputElement.prototype
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value)
    el.dispatchEvent(new Event(isSelect ? 'change' : 'input', { bubbles: true }))
  })
}
const submit = async (form: Element) => {
  await act(async () => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })
  await flush()
}

beforeEach(() => {
  server.gets = {}
  server.posts = []
  server.patches = []
  server.replies = {}
})
afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  root = null; host = null
})

describe('Journal Entries', () => {
  beforeEach(() => {
    server.gets = {
      '/books/journal': [{ id: 'j1', entryNumber: 7, date: '2026-03-31', description: 'Accrue the plumber', type: 'manual', status: 'posted', totalDebits: '300.00', reversedByEntryId: null }],
      '/books/accounts': [
        { id: 'a1', code: '5040', name: 'Repairs and maintenance', type: 'expense' },
        { id: 'a2', code: '1010', name: 'Checking', type: 'asset' },
      ],
      '/books/properties': [{ id: 'p1', name: 'Blu Meadows' }],
      '/books/journal/j1': {
        id: 'j1', entryNumber: 7, date: '2026-03-31', description: 'Accrue the plumber', type: 'manual', status: 'posted',
        totalDebits: '300.00', totalCredits: '300.00', reversedByEntryId: null, reversedByEntryNumber: null, reversesEntryNumber: null,
        adjustsRecordLabel: null, voidedAt: null,
        lines: [
          { id: 'l1', code: '5040', accountName: 'Repairs and maintenance', propertyName: 'Blu Meadows', unitNumber: null, debit: '300.00', credit: '0.00' },
          { id: 'l2', code: '1010', accountName: 'Checking', propertyName: null, unitNumber: null, debit: '0.00', credit: '300.00' },
        ],
      },
    }
  })

  it('a line names its property or the whole company, and the kind of entry reads in words', async () => {
    await render(<JournalEntriesPage />)
    await act(async () => { button('+ New Entry')!.click() })
    const form = host!.querySelector('form')!
    const kind = [...form.querySelectorAll('select')].find(s => [...s.options].some(o => o.value === 'adjusting'))!
    expect([...kind.options].map(o => o.textContent)).toEqual(['Journal entry', 'Adjusting entry'])
    await setValue(form.querySelector('input[placeholder^="e.g."]')!, 'Repair paid from the office account')
    const rows = [...form.querySelectorAll('tbody tr')]
    const [acct1, prop1] = [...rows[0].querySelectorAll('select')]
    const [acct2, prop2] = [...rows[1].querySelectorAll('select')]
    expect([...prop1.options].map(o => o.textContent)).toEqual(['Whole company', 'Blu Meadows'])
    await setValue(acct1, 'a1'); await setValue(prop1, 'p1')
    await setValue(rows[0].querySelectorAll('input[type="number"]')[0], '120')
    await setValue(acct2, 'a2')
    await setValue(rows[1].querySelectorAll('input[type="number"]')[1], '120')
    expect(prop2.value).toBe('')
    await submit(form)
    expect(server.posts).toEqual([{ url: '/books/journal', body: {
      date: expect.any(String), description: 'Repair paid from the office account', reference: '', type: 'manual',
      lines: [
        { accountId: 'a1', description: '', debit: 120, credit: 0, propertyId: 'p1' },
        { accountId: 'a2', description: '', debit: 0, credit: 120, propertyId: null },
      ],
    } }])
  })

  it('an entry shows each line\'s property, and Reverse dates the reversal', async () => {
    server.replies['/books/journal/j1/reverse'] = { id: 'j2', entryNumber: 8 }
    server.gets['/books/journal/j2'] = { ...server.gets['/books/journal/j1'], id: 'j2', entryNumber: 8, type: 'reversing', reversesEntryNumber: 7 }
    await render(<JournalEntriesPage />)
    await act(async () => { (host!.querySelector('tbody tr') as HTMLElement).click() })
    await flush()
    expect(text()).toContain('Blu Meadows')
    expect(text()).toContain('Whole company')
    expect(text()).not.toContain('manual')
    await act(async () => { button('Reverse…')!.click() })
    const form = [...host!.querySelectorAll('form')].pop()!
    const day = form.querySelector('input[type="date"]') as HTMLInputElement
    expect(day.min).toBe('2026-03-31')
    await setValue(day, '2026-04-01')
    await submit(form)
    expect(server.posts).toEqual([{ url: '/books/journal/j1/reverse', body: { date: '2026-04-01' } }])
  })
})

describe('Run Payroll', () => {
  beforeEach(() => {
    server.gets = {
      '/books/employees': [{ id: 'e1', firstName: 'Ann', lastName: 'Worker', payType: 'salary', payRate: 52000, status: 'active', title: '' }],
      '/books/work-trade-pay': [
        { id: 'x1', payMethod: 'payroll_w2', hours: 6, rate: 15, amount: 90, periodMonth: '2026-09-01', tenantFirst: 'Pat', tenantLast: 'Trader', employeeId: 'e1', draftRunId: null },
        { id: 'x2', payMethod: 'contractor_1099', hours: 4, rate: 20, amount: 80, periodMonth: '2026-09-01', tenantFirst: 'Lee', tenantLast: 'Helper', employeeId: null, draftRunId: null },
      ],
      '/books/vendors': [{ id: 'v1', name: 'Acme Plumbing' }],
      // 10/13 (Nic): where each run's wages go is asked on the run.
      '/books/cost-places': { asked: true, properties: [{ id: 'p1', name: 'Oak Park', units: [{ id: 'u1', unitNumber: '7' }] }] },
    }
    server.replies['/books/payroll/runs'] = {
      id: 'r1', lines: [], employeeCount: 2, payFrequency: 'biweekly', payDate: '2026-03-20', periodStart: '2026-03-01', periodEnd: '2026-03-14',
      totalGross: '2090', totalFederalTax: '0', totalStateTax: '0', totalSs: '129.58', totalMedicare: '30.31', totalNet: '1930.11',
      totalEmployerSs: '129.58', totalEmployerMedicare: '30.31', totalFuta: '12', totalSuta: '0',
      costPlace: 'split_by_units', propertyId: null, unitId: null,
    }
  })

  it('takes each paycheck\'s unemployment taxes and puts W-2 work-trade hours on the run as their own paycheck', async () => {
    await render(<RunPayrollPage />)
    const t = text()
    expect(t).toContain('Payroll (W-2)')
    expect(t).toContain('Contractor payment (1099)')
    expect(t).not.toContain('payroll_w2')
    expect(t).not.toContain('contractor_1099')
    const form = host!.querySelector('form')!
    const dates = [...form.querySelectorAll('input[type="date"]')]
    await setValue(dates[0], '2026-03-01'); await setValue(dates[1], '2026-03-14'); await setValue(dates[2], '2026-03-20')
    await act(async () => { (host!.querySelector('input[aria-label="Pay Ann Worker"]') as HTMLInputElement).click() })
    await act(async () => { (host!.querySelector('input[aria-label="Pay Pat Trader on this run"]') as HTMLInputElement).click() })
    // Ann's federal unemployment (the ninth column).
    const annRow = (host!.querySelector('input[aria-label="Pay Ann Worker"]') as HTMLElement).closest('tr')!
    const annTaxes = annRow.querySelectorAll('input[type="number"]')
    await setValue(annTaxes[annTaxes.length - 2], '12')
    // 10/13 (Nic): nothing is chosen for where the wages go; it is asked, and the run waits for it.
    expect(text()).toContain('Where this payroll\'s cost (wages and employer taxes) goes')
    const calc = [...form.querySelectorAll('button[type="submit"]')].pop() as HTMLButtonElement
    expect(calc.disabled).toBe(true)
    await act(async () => { (host!.querySelector('input[name="payrollPlace"][value="split_by_units"]') as HTMLInputElement).click() })
    await flush()
    expect(calc.disabled).toBe(false)
    await submit(form)
    expect(server.posts).toEqual([{ url: '/books/payroll/runs', body: {
      periodStart: '2026-03-01', periodEnd: '2026-03-14', payDate: '2026-03-20', payFrequency: 'biweekly',
      employeeIds: ['e1'], hoursMap: {},
      taxMap: { e1: { federal: 0, state: 0, futa: 12, suta: 0 } },
      extraHours: [{ id: 'x1', employeeId: 'e1', federal: 0, state: 0, futa: 0, suta: 0 }],
      costPlace: 'split_by_units', propertyId: null, unitId: null,
    } }])
    // The review reads the employer's taxes the server recorded, and where the wages go.
    expect(text()).toContain('Federal unemployment')
    expect(text()).toContain('$12.00')
    expect(text()).toContain('Split across your properties by units')
  })

  it('records 1099 hours as a contractor bill — to the person themselves unless another vendor is picked', async () => {
    await render(<RunPayrollPage />)
    const select = host!.querySelector('select[aria-label="Vendor Lee Helper is paid as"]') as HTMLSelectElement
    expect([...select.options].map(o => o.textContent)).toEqual(['Lee Helper (contractor)', 'Acme Plumbing'])
    // 10/13 (Nic): "except gams charge all those costs get logged by a person" —
    // where the bill's cost goes is asked on it; nothing records until it is.
    expect(text()).toContain('Where Lee Helper\'s contractor bill goes')
    expect([...host!.querySelectorAll('input[name="contractorPlace-x2"]')].some(r => (r as HTMLInputElement).checked)).toBe(false)
    expect(button('Record contractor bill')!.disabled).toBe(true)
    await act(async () => { (host!.querySelector('input[name="contractorPlace-x2"][value="split_by_units"]') as HTMLInputElement).click() })
    await flush()
    await act(async () => { button('Record contractor bill')!.click() })
    await flush()
    expect(server.posts).toEqual([{ url: '/books/work-trade-pay/x2/contractor-payment',
      body: { costPlace: 'split_by_units', propertyId: null, unitId: null } }])
    // Asked again on the next one: nothing carries over.
    expect([...host!.querySelectorAll('input[name="contractorPlace-x2"]')].some(r => (r as HTMLInputElement).checked)).toBe(false)
    await setValue(select, 'v1')
    await act(async () => { (host!.querySelector('input[name="contractorPlace-x2"][value="unit"]') as HTMLInputElement).click() })
    await flush()
    const property = [...host!.querySelectorAll('select')].find(s => s.options[0]?.textContent === 'Choose the property') as HTMLSelectElement
    await setValue(property, 'p1')
    const unit = [...host!.querySelectorAll('select')].find(s => s.options[0]?.textContent === 'Choose the unit') as HTMLSelectElement
    await setValue(unit, 'u1')
    await act(async () => { button('Record contractor bill')!.click() })
    await flush()
    expect(server.posts[1]).toEqual({ url: '/books/work-trade-pay/x2/contractor-payment',
      body: { vendorId: 'v1', costPlace: 'unit', propertyId: 'p1', unitId: 'u1' } })
  })
})

describe('Chart of Accounts', () => {
  it('an account the books hold entries on is turned off by choosing the account that takes its place', async () => {
    server.gets = {
      '/books/accounts': [
        { id: 'a1', code: '5901', name: 'Odd jobs', type: 'expense', active: true, inUse: true, balance: '0', normalBalance: 0 },
        { id: 'a2', code: '5902', name: 'Odd jobs (new)', type: 'expense', active: true, inUse: false, balance: '0', normalBalance: 0 },
        { id: 'a3', code: '1010', name: 'Checking', type: 'asset', active: true, inUse: true, balance: '0', normalBalance: 0 },
      ],
    }
    await render(<ChartOfAccountsPage />)
    const row = [...host!.querySelectorAll('tbody tr')].find(r => r.textContent?.includes('Odd jobs') && !r.textContent?.includes('(new)'))!
    await act(async () => { ([...row.querySelectorAll('button')].find(b => b.textContent === 'Deactivate') as HTMLButtonElement).click() })
    const form = [...host!.querySelectorAll('form')].pop()!
    const select = form.querySelector('select') as HTMLSelectElement
    expect([...select.options].map(o => o.textContent)).toEqual(['Choose…', '5902 · Odd jobs (new)'])
    await setValue(select, 'a2')
    await submit(form)
    expect(server.patches).toEqual([{ url: '/books/accounts/a1', body: { active: false, replacementAccountId: 'a2' } }])
  })
})
