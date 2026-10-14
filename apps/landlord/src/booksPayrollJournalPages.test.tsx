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
  // 10/14 afternoon: who is looking (the owner changes an employee's pay place).
  role: 'landlord',
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
vi.mock('./context/AuthContext', () => ({ useAuth: () => ({ user: { id: 'u1', role: server.role } }) }))
vi.mock('./components/dialogs', () => ({ toast: Object.assign(() => {}, { error: () => {} }), appConfirm: async () => true }))

import { JournalEntriesPage } from './bookkeeping/JournalEntriesPage'
import { RunPayrollPage } from './bookkeeping/RunPayrollPage'
import { ChartOfAccountsPage } from './bookkeeping/ChartOfAccountsPage'
import { EmployeesPage } from './bookkeeping/EmployeesPage'

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
  server.role = 'landlord'
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
      // 10/14 (Nic): each employee says where their pay goes, set once.
      '/books/employees': [{ id: 'e1', firstName: 'Ann', lastName: 'Worker', payType: 'salary', payRate: 52000, status: 'active', title: '',
        payPlace: 'property', payPropertyId: 'p1', payPropertyName: 'Oak Park' }],
      '/books/work-trade-pay': [
        { id: 'x1', payMethod: 'payroll_w2', hours: 6, rate: 15, amount: 90, periodMonth: '2026-09-01', tenantFirst: 'Pat', tenantLast: 'Trader', employeeId: 'e1', draftRunId: null },
        { id: 'x2', payMethod: 'contractor_1099', hours: 4, rate: 20, amount: 80, periodMonth: '2026-09-01', tenantFirst: 'Lee', tenantLast: 'Helper', employeeId: null, draftRunId: null },
      ],
      '/books/vendors': [{ id: 'v1', name: 'Acme Plumbing' }],
      // 10/13 (Nic): where a contractor bill's cost goes is asked on each one.
      '/books/cost-places': { asked: true, properties: [{ id: 'p1', name: 'Oak Park', units: [{ id: 'u1', unitNumber: '7' }] }] },
    }
    server.replies['/books/payroll/runs'] = {
      id: 'r1', employeeCount: 2,
      lines: [{ id: 'l1', firstName: 'Ann', lastName: 'Worker', payType: 'salary', grossPay: '2000', federalTax: '0', ssTax: '124', medicareTax: '29',
        stateTax: '0', netPay: '1847', payPlace: 'property', payPropertyId: 'p1', payPropertyName: 'Oak Park' }], payFrequency: 'biweekly', payDate: '2026-03-20', periodStart: '2026-03-01', periodEnd: '2026-03-14',
      totalGross: '2090', totalFederalTax: '0', totalStateTax: '0', totalSs: '129.58', totalMedicare: '30.31', totalNet: '1930.11',
      totalEmployerSs: '129.58', totalEmployerMedicare: '30.31', totalFuta: '12', totalSuta: '0',
      costPlace: null, propertyId: null, unitId: null,
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
    // 10/14 (Nic): each paycheck follows its employee's place — the run asks nothing.
    expect(text()).not.toContain('Where this payroll\'s cost')
    expect(host!.querySelector('input[name="payrollPlace"]')).toBeNull()
    const calc = [...form.querySelectorAll('button[type="submit"]')].pop() as HTMLButtonElement
    expect(calc.disabled).toBe(false)
    await submit(form)
    expect(server.posts).toEqual([{ url: '/books/payroll/runs', body: {
      periodStart: '2026-03-01', periodEnd: '2026-03-14', payDate: '2026-03-20', payFrequency: 'biweekly',
      employeeIds: ['e1'], hoursMap: {},
      taxMap: { e1: { federal: 0, state: 0, futa: 12, suta: 0 } },
      extraHours: [{ id: 'x1', employeeId: 'e1', federal: 0, state: 0, futa: 0, suta: 0 }],
    } }])
    // The review reads the employer's taxes the server recorded, and where each paycheck goes.
    expect(text()).toContain('Federal unemployment')
    expect(text()).toContain('$12.00')
    expect(text()).toContain('Pay goes to Oak Park')
  })

  it('an employee with no place yet is named, and the run waits until it is set on the Employees page (10/14, Nic)', async () => {
    server.gets['/books/employees'] = [{ id: 'e1', firstName: 'Ann', lastName: 'Worker', payType: 'salary', payRate: 52000, status: 'active', title: '' }]
    await render(<RunPayrollPage />)
    const form = host!.querySelector('form')!
    await act(async () => { (host!.querySelector('input[aria-label="Pay Ann Worker"]') as HTMLInputElement).click() })
    await flush()
    expect(text()).toContain('Set where this employee\'s pay goes on the Employees page first: Ann Worker.')
    const calc = [...form.querySelectorAll('button[type="submit"]')].pop() as HTMLButtonElement
    expect(calc.disabled).toBe(true)
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

describe('Employees: where each one\'s pay goes (10/14, Nic) — the owner changes it (10/14 afternoon)', () => {
  beforeEach(() => {
    server.gets = {
      '/books/employees': [
        { id: 'e1', firstName: 'Ann', lastName: 'Worker', payType: 'salary', payRate: 52000, payFrequency: 'biweekly', status: 'active', ytdGross: 0 },
        { id: 'e2', firstName: 'Bo', lastName: 'Keeper', payType: 'hourly', payRate: 20, payFrequency: 'biweekly', status: 'active', ytdGross: 0,
          payPlace: 'property', payPropertyId: 'p1', payPropertyName: 'Oak Park' },
      ],
      '/books/cost-places': { asked: true, properties: [{ id: 'p1', name: 'Oak Park', units: [] }, { id: 'p2', name: 'Mountain View', units: [] }] },
    }
  })

  it('a set place is shown, with Change for the owner; one with none is set here, nothing chosen for the person', async () => {
    await render(<EmployeesPage />)
    const boRow = [...host!.querySelectorAll('tr')].find(r => r.textContent?.includes('Bo Keeper'))!
    expect(boRow.textContent).toContain('Oak Park')
    expect(boRow.textContent).not.toContain('Set where pay goes')
    expect([...boRow.querySelectorAll('button')].some(b => b.textContent === 'Change')).toBe(true)
    await act(async () => { button('Set where pay goes')!.click() })
    await flush()
    expect(text()).toContain('Each paycheck goes here. Only the owner can change it later.')
    const radios = [...host!.querySelectorAll('input[name="payPlaceSet"]')] as HTMLInputElement[]
    expect(radios.map(r => r.checked)).toEqual([false, false])
    expect(button('Save')!.disabled).toBe(true)
    await act(async () => { (host!.querySelector('input[name="payPlaceSet"][value="company"]') as HTMLInputElement).click() })
    await flush()
    expect(button('Save')!.disabled).toBe(false)
    await act(async () => { button('Save')!.click() })
    await flush()
    expect(server.patches).toEqual([{ url: '/books/employees/e1', body: { payPlace: 'company', payPropertyId: null } }])
  })

  it('the owner changes a set place: only the next paychecks follow, said in words; nothing is chosen for him', async () => {
    await render(<EmployeesPage />)
    const boRow = [...host!.querySelectorAll('tr')].find(r => r.textContent?.includes('Bo Keeper'))!
    await act(async () => { ([...boRow.querySelectorAll('button')].find(b => b.textContent === 'Change') as HTMLButtonElement).click() })
    await flush()
    expect(text()).toContain('Their pay goes to Oak Park now. Their next paychecks go to the new place; paychecks already approved stay where they were booked.')
    const radios = [...host!.querySelectorAll('input[name="payPlaceSet"]')] as HTMLInputElement[]
    expect(radios.map(r => r.checked)).toEqual([false, false])
    expect(button('Save')!.disabled).toBe(true)
    await act(async () => { (host!.querySelector('input[name="payPlaceSet"][value="property"]') as HTMLInputElement).click() })
    await flush()
    const pick = [...host!.querySelectorAll('select')].find(x => [...x.options].some(o => o.textContent === 'Choose the property'))!
    await setValue(pick, 'p2')
    await flush()
    await act(async () => { button('Save')!.click() })
    await flush()
    expect(server.patches).toEqual([{ url: '/books/employees/e2', body: { payPlace: 'property', payPropertyId: 'p2' } }])
  })

  it('a bookkeeper sees where pay goes, never a Change button (only the owner changes it)', async () => {
    server.role = 'bookkeeper'
    await render(<EmployeesPage />)
    const boRow = [...host!.querySelectorAll('tr')].find(r => r.textContent?.includes('Bo Keeper'))!
    expect(boRow.textContent).toContain('Oak Park')
    expect([...boRow.querySelectorAll('button')].some(b => b.textContent === 'Change')).toBe(false)
    // One with none is still set by whoever keeps the books.
    expect(button('Set where pay goes')).toBeTruthy()
  })

  it('Add Employee asks where their pay goes and does not save until it is answered', async () => {
    await render(<EmployeesPage />)
    await act(async () => { button('+ Add Employee')!.click() })
    await flush()
    expect(text()).toContain('Where their pay goes')
    const add = [...host!.querySelectorAll('button[type="submit"]')].pop() as HTMLButtonElement
    expect(add.disabled).toBe(true)
    await act(async () => { (host!.querySelector('input[name="payPlace"][value="property"]') as HTMLInputElement).click() })
    await flush()
    expect(add.disabled).toBe(true)
    const pick = [...host!.querySelectorAll('select')].find(x => [...x.options].some(o => o.textContent === 'Choose the property'))!
    await setValue(pick, 'p2')
    await flush()
    expect(add.disabled).toBe(false)
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
