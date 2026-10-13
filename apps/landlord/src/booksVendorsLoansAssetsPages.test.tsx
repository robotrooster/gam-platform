// @vitest-environment jsdom
/**
 * 10/12 (Nic): Vendors (one list of everyone the company pays — contractors
 * get a 1099 box), Loans and Fixed assets, the screens. Every value reads in
 * plain words (never a raw stored value), a taxpayer ID only by its last four,
 * a loan payment's parts must add up before it records, and the old
 * Contractors address opens Vendors. The same files ship in GAM Books
 * (bookkeeping-parity.test.ts).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from 'react-query'
import { MemoryRouter, Routes, Route } from 'react-router-dom'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const server = vi.hoisted(() => ({
  gets: {} as Record<string, any>,
  posts: [] as Array<{ url: string; body: any }>,
  patches: [] as Array<{ url: string; body: any }>,
}))

vi.mock('./lib/api', () => ({
  api: {
    get: async (url: string) => {
      const key = Object.keys(server.gets).find(k => url === k || url.startsWith(`${k}?`))
      if (!key) throw new Error(`unexpected GET ${url}`)
      const v = server.gets[key]
      return { data: { success: true, data: typeof v === 'function' ? v(url) : v } }
    },
    post: async (url: string, body: any) => { server.posts.push({ url, body }); return { data: { success: true, data: { id: 'new1' } } } },
    patch: async (url: string, body: any) => { server.patches.push({ url, body }); return { data: { success: true, data: { id: 'x' } } } },
  },
}))
vi.mock('./context/AuthContext', () => ({ useAuth: () => ({ user: { id: 'u1', role: 'landlord' } }) }))
vi.mock('./components/dialogs', () => ({ toast: Object.assign(() => {}, { error: () => {} }), appConfirm: async () => false }))

import { VendorsPage } from './bookkeeping/VendorsPage'
import { ContractorsPage } from './bookkeeping/ContractorsPage'
import { LoansPage } from './bookkeeping/LoansPage'
import { FixedAssetsPage } from './bookkeeping/FixedAssetsPage'
import { BOOKS_PATHS } from './bookkeeping/adapter'

const VENDORS = [
  { id: 'v1', name: 'Jose Ruiz', contactName: 'Jose Ruiz', email: 'jose@t.dev', vendorType: 'contractor', is1099: true, w9OnFile: false,
    taxClassification: 'individual', taxIdLast4: '1234', hasTaxId: true, trade: 'Landscaping', payRate: 25, payUnit: 'hour',
    paymentTerms: 'due_on_receipt', status: 'active', paidThisYear: 2100, paidByCardThisYear: 100, reportableThisYear: 2000, owed: 300, year: 2026 },
  { id: 'v2', name: 'APS', contactName: 'Billing', email: 'b@aps.test', vendorType: 'utility', is1099: false, w9OnFile: false,
    taxIdLast4: null, hasTaxId: false, paymentTerms: 'net30', status: 'active', paidThisYear: 400, paidByCardThisYear: 0, owed: 0, year: 2026 },
]
const LOAN = {
  id: 'l1', name: 'Oak Street mortgage', lenderName: 'First Bank', propertyName: 'Oak Park', annualRate: '6.0000', paymentAmount: '1200.00',
  escrowAmount: '200.00', originalAmount: '120000.00', startDate: '2026-02-01', fundedTo: 'bank', state: 'active', balance: 119600,
  escrowHeld: 200, interestPaid: 600, principalPaid: 400, payments: 1, lastPaidOn: '2026-03-01', opensAtBooksStart: false,
  paymentsList: [{ id: 'p1', paidOn: '2026-03-01', amount: 1200, principal: 400, interest: 600, escrow: 200, method: 'bank', bankTransactionId: 'bt1', voidedAt: null }],
}
const ASSET = {
  id: 'a1', name: 'Clubhouse', assetClass: 'building', propertyName: 'Oak Park', inServiceDate: '2015-02-01', acquiredOn: '2015-01-10',
  cost: '330000.00', salvageValue: '0.00', lifeYears: '27.50', depreciates: true, monthly: 1000, monthsLeft: 190, depreciatedToDate: 140000,
  bookValue: 190000, opensAtBooksStart: true, problem: null, voidedAt: null, sourceExpenseId: null,
}

let root: Root | null = null
let host: HTMLDivElement | null = null
const flush = async () => { for (let i = 0; i < 8; i++) await act(async () => { await new Promise(r => setTimeout(r, 0)) }) }
const text = () => host!.textContent || ''
const button = (label: string) => [...host!.querySelectorAll('button')].find(b => b.textContent?.trim() === label) as HTMLButtonElement | undefined

async function render(el: JSX.Element, at = '/') {
  host = document.createElement('div')
  document.body.appendChild(host)
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  await act(async () => {
    root = createRoot(host!)
    root.render(<QueryClientProvider client={qc}><MemoryRouter initialEntries={[at]}>{el}</MemoryRouter></QueryClientProvider>)
  })
  await flush()
}

beforeEach(() => {
  server.posts = []
  server.patches = []
  server.gets = {
    '/books/vendors': VENDORS,
    '/books/loans': [LOAN],
    '/books/loans/l1': LOAN,
    '/books/loans/l1/suggest': { principal: 398, interest: 602, escrow: 200, balanceBefore: 119600 },
    '/books/loans/form-options': { booksStartDate: '2026-01-01', today: '2026-10-12', bankAccounts: [{ id: 'b1', name: 'First Bank', accountLast4: '4321' }] },
    '/books/properties': [{ id: 'p1', name: 'Oak Park' }],
    '/books/fixed-assets': [ASSET],
    '/books/fixed-assets/capital-expenses': [{ id: 'e1', description: 'New roof', categoryName: 'Capital improvements', propertyName: 'Oak Park', expenseDate: '2026-02-10', amount: 12000 }],
  }
})
afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  root = null; host = null
})

const RAW = ['contractor_1099', 'due_on_receipt', 'net30', 'straight_line', 'owner_paid', 'paid_off', 'fixed_asset', 'loan_payment']

describe('Vendors', () => {
  it('one list: each type in words, the 1099 box and a missing W-9, the year\'s payments, a taxpayer ID by its last four only', async () => {
    await render(<VendorsPage />)
    const t = text()
    expect(t).toContain('Jose Ruiz')
    expect(t).toContain('Contractor')
    expect(t).toContain('Utility company')
    expect(t).toContain('1099 · no W-9')
    expect(t).toContain('$2,100.00')
    expect(t).toContain('$100.00 by card')
    expect(t).toContain('••1234')
    for (const raw of RAW) expect(t).not.toContain(raw)
  })

  it('the old Contractors address opens Vendors on its Contractors tab', async () => {
    await render(<Routes>
      <Route path={BOOKS_PATHS.contractors} element={<ContractorsPage />} />
      <Route path={BOOKS_PATHS.vendors} element={<VendorsPage />} />
    </Routes>, BOOKS_PATHS.contractors)
    expect(text()).toContain('Jose Ruiz')
    expect(text()).not.toContain('APS')
  })

  it('editing keeps the taxpayer ID on file unless a new one is typed, and shows the contractor\'s 1099 details', async () => {
    await render(<VendorsPage />)
    await act(async () => { [...host!.querySelectorAll('button')].filter(b => b.textContent === 'Edit')[0].click() })
    await flush()
    const tin = [...host!.querySelectorAll('input')].find(i => i.placeholder.includes('••1234'))
    expect(tin).toBeTruthy()
    expect(text()).toContain('Gets a 1099')
    await act(async () => { button('Save')!.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })
    await flush()
    expect(server.patches).toHaveLength(1)
    expect(server.patches[0].url).toBe('/books/vendors/v1')
    expect(server.patches[0].body).not.toHaveProperty('taxId')
    expect(server.patches[0].body).toMatchObject({ vendorType: 'contractor', is1099: true, payRate: 25 })
  })
})

describe('Loans', () => {
  it('lists each loan with what is owed, and a payment\'s parts must add up before it records', async () => {
    await render(<LoansPage />)
    const t = text()
    expect(t).toContain('Oak Street mortgage')
    expect(t).toContain('$119,600.00')
    expect(t).toContain('Being paid')
    for (const raw of RAW) expect(t).not.toContain(raw)
    await act(async () => { button('Open')!.click() })
    await flush()
    expect(text()).toContain('GAM suggests $398.00 principal, $602.00 interest, $200.00 escrow')
    expect(text()).toContain('Bank line')
    expect(button('Record payment')!.disabled).toBe(true)
    await act(async () => { button('Use this split')!.click() })
    expect(button('Record payment')!.disabled).toBe(false)
    await act(async () => { button('Record payment')!.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })
    await flush()
    expect(server.posts).toEqual([{ url: '/books/loans/l1/payments', body: expect.objectContaining({
      paidOn: '2026-10-12', amount: 1200, principal: 398, interest: 602, escrow: 200, method: 'bank' }) }])
    // A payment that is a bank line is changed on the Bank page: no Void beside it.
    expect(button('Void')).toBeUndefined()
  })
})

describe('Fixed assets', () => {
  it('lists each asset with its depreciation in words, and offers the capital improvements not yet assets', async () => {
    await render(<FixedAssetsPage />)
    const t = text()
    expect(t).toContain('Clubhouse')
    expect(t).toContain('Building')
    expect(t).toContain('owned before your books start')
    expect(t).toContain('27.5 yr')
    expect(t).toContain('$190,000.00')
    expect(t).toContain('New roof')
    expect(t).toContain('Make it an asset')
    for (const raw of RAW) expect(t).not.toContain(raw)
  })
})
