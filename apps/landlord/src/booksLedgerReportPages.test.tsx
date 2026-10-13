// @vitest-environment jsdom
/**
 * 10/12 (Nic, ledger P8): the Books statements once the books are live — the
 * P&L with Received first (L2), Charged and Owed beside it and the strip that
 * ties Owed; expenses paid and incurred; the trial balance and the general
 * ledger. No raw stored value on any page; a company whose books are not live
 * is told why. The same files ship in GAM Books (bookkeeping-parity.test.ts).
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from 'react-query'
import { MemoryRouter } from 'react-router-dom'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const server = vi.hoisted(() => ({ replies: {} as Record<string, any>, asked: [] as string[] }))

vi.mock('./lib/api', () => ({
  api: {
    get: async (url: string) => {
      server.asked.push(url)
      const key = Object.keys(server.replies).find(k => url.startsWith(k))
      if (!key) throw new Error(`unexpected GET ${url}`)
      return { data: { success: true, data: server.replies[key] } }
    },
  },
}))
vi.mock('./context/AuthContext', () => ({ useAuth: () => ({ user: { id: 'u1', role: 'landlord' } }) }))
vi.mock('./components/dialogs', () => ({ toast: Object.assign(() => {}, { error: () => {} }), appConfirm: async () => false }))

import { ProfitLossPage } from './bookkeeping/ProfitLossPage'
import { TrialBalancePage } from './bookkeeping/TrialBalancePage'
import { GeneralLedgerPage } from './bookkeeping/GeneralLedgerPage'
import { CashFlowPage } from './bookkeeping/CashFlowPage'

let root: Root | null = null
let host: HTMLDivElement | null = null
const flush = async () => { for (let i = 0; i < 6; i++) await act(async () => { await new Promise(r => setTimeout(r, 0)) }) }
const text = () => host!.textContent || ''

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
afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  root = null; host = null
  server.replies = {}; server.asked = []
})

const PL = {
  source: 'ledger', lead: 'received', period: { start: '2026-10-01', end: '2026-10-31', label: 'October' },
  view: {
    received: 400, charged: 1300, owed: 1200, source: 'ledger',
    categories: [{ category: 'space_rent', label: 'Lot/space rent', received: 400, charged: 1300, owed: 1200 }],
    uncategorized: [],
    tieText: ['Of $400.00 received, $400.00 was for bills due in October.',
      'Owed $300.00 at the end of Sep 30, 2026 + billed $1,300.00 − received against bills $400.00 = owed $1,200.00 at the end of Oct 31, 2026.'],
    beside: [{ key: 'taxCollected', label: 'Tax collected (owed to the government)', amount: 12 }],
  },
  incomeAccounts: [{ accountId: 'a1', code: '4010', name: 'Space and lot rent', charged: 1300 }],
  expenses: { rows: [{ accountId: 'e1', code: '5040', name: 'Repairs and maintenance', paid: 150, incurred: 150 }], paid: 150, incurred: 150 },
  nets: { received: 250, charged: 1150 },
}
const MONEY_OUT = {
  live: true, rows: [{ key: 'Repairs', label: 'Repairs', incurred: 150, paid: 150, unpaid: 0 }],
  notExpenses: [{ kind: 'equity', label: 'Owner draws and money taken out', paid: 500 }],
  unpaidByVendor: [], totals: { incurred: 150, paid: 150, unpaid: 0 },
}

describe('the Books P&L on the books', () => {
  it('leads with Received, shows Charged and Owed beside it, the strip, both nets and money out — no raw value', async () => {
    server.replies = {
      '/books/reports/pl': { ...PL, chargedBeside: [{ key: 'depositsBilled', label: 'Deposits billed (held for tenants, never income)', amount: 500 }],
        corrections: [{ month: '2026-09', received: 0, charged: 25, expensesIncurred: 0 }] },
      '/books/reports/money-out': MONEY_OUT,
      '/books/reports/receivables': {
        live: true, asOf: '2026-10-31',
        rows: [{ tenantId: 't1', tenantName: 'Rosa Diaz', propertyId: 'p1', propertyName: 'Blu Meadows', total: 1200,
          buckets: { current: 0, days1to30: 900, days31to60: 300, days61to90: 0, over90: 0 } }],
        totals: { total: 1200, buckets: { current: 0, days1to30: 900, days31to60: 300, days61to90: 0, over90: 0 } },
        bucketLabels: { current: 'Not due yet or due today', days1to30: '1–30 days late', days31to60: '31–60 days late', days61to90: '61–90 days late', over90: 'Over 90 days late' },
      },
    }
    await render(<ProfitLossPage />)
    const t = text()
    expect(t).toContain('From your books')
    const head = [...host!.querySelectorAll('thead th')].map(th => th.textContent).slice(1, 4)
    expect(head).toEqual(['Received', 'Charged', 'Owed'])
    expect(t).toContain('= owed $1,200.00 at the end of Oct 31, 2026.')
    expect(t).toContain('Tax collected (owed to the government) (beside the total)')
    expect(t).toContain('Received less expenses paid')
    expect(t).toContain('$250.00')
    expect(t).toContain('Charged less expenses incurred')
    expect(t).toContain('Owner draws and money taken out (not a cost)')
    expect(t).toContain('What tenants still owed at the end of the period')
    expect(t).toContain('Deposits billed (held for tenants, never income) (beside Charged)')
    expect(t).toContain('by tenant and age')
    expect(t).toContain('Rosa Diaz')
    expect(t).toContain('31–60 days late')
    expect(t).not.toContain('Over 90 days late')
    expect(t).not.toContain('Could not load')
    expect(t).toContain('Corrections to September 2026')
    for (const raw of ['space_rent', 'taxCollected', 'equity', 'ledger', 'days1to30', 'depositsBilled']) expect(t).not.toContain(raw)
  })
})

describe('the trial balance and the general ledger', () => {
  it('the trial balance lists each account with Dr / Cr balances and says it balances; an account opens its ledger', async () => {
    server.replies = {
      '/books/properties': [{ id: 'p1', name: 'Blu Meadows' }],
      '/books/reports/trial-balance': {
        live: true, period: { start: '2026-01-01', end: '2026-10-31' }, property: 'all', balances: true,
        rows: [
          { accountId: 'a1', code: '1100', name: 'Accounts receivable: tenants', type: 'asset', opening: 300, debits: 1300, credits: 400, closing: 1200 },
          { accountId: 'a2', code: '4010', name: 'Space and lot rent', type: 'income', opening: -300, debits: 0, credits: 1300, closing: -1600 },
        ],
        totals: { debits: 1300, credits: 1700, closingDebits: 1200, closingCredits: 1600 },
      },
    }
    await render(<TrialBalancePage />)
    const t = text()
    expect(t).toContain('✓ Balanced')
    expect(t).toContain('$1,200.00 Dr')
    expect(t).toContain('$1,600.00 Cr')
    expect(t).toContain("The company's own (no property)")
    const link = [...host!.querySelectorAll('a')].find(a => a.textContent?.includes('1100'))!
    expect(link.getAttribute('href')).toMatch(/^\/bookkeeping\/general-ledger\?accountId=a1&startDate=/)
  })

  it('a company whose books are not live is told why', async () => {
    server.replies = {
      '/books/properties': [],
      '/books/reports/trial-balance': { live: false, reason: 'Your books start once you pick their start date in Books settings.', rows: [] },
    }
    await render(<TrialBalancePage />)
    expect(text()).toContain('Your books start once you pick their start date in Books settings.')
  })

  it('the general ledger runs the balance, names the record behind each line, and marks a correction', async () => {
    server.replies = {
      '/books/accounts': [{ id: 'a1', code: '1100', name: 'Accounts receivable: tenants' }],
      '/books/reports/general-ledger': {
        live: true, account: { id: 'a1', code: '1100', name: 'Accounts receivable: tenants', type: 'asset' },
        period: { start: '2026-10-01', end: '2026-10-31' }, opening: 300, closing: 1200, hiddenCorrections: 2,
        lines: [
          { lineId: 'l1', postingId: 'p1', day: '2026-10-01', intendedDay: '2026-10-01', debit: 1300, credit: 0, balance: 1600,
            memo: null, postingMemo: 'Billed', propertyId: 'pr1', propertyName: 'Blu Meadows', tenantName: 'Rosa Diaz', vendorName: null,
            source: { type: 'payment', id: 'x', label: 'A tenant bill' }, correction: false },
          { lineId: 'l2', postingId: 'p2', day: '2026-10-03', intendedDay: '2026-09-30', debit: 0, credit: 400, balance: 1200,
            memo: null, postingMemo: 'Payment received at the desk', propertyId: 'pr1', propertyName: 'Blu Meadows', tenantName: 'Rosa Diaz', vendorName: null,
            source: { type: 'remittance', id: 'y', label: 'A payment received' }, correction: true },
        ],
      },
    }
    await render(<GeneralLedgerPage />, '/bookkeeping/general-ledger?accountId=a1&startDate=2026-10-01&endDate=2026-10-31')
    const t = text()
    expect(t).toContain('Balance at the start')
    expect(t).toContain('A tenant bill')
    expect(t).toContain('A payment received')
    expect(t).toContain('Correction')
    expect(t).toContain('Balance at the end')
    expect(t).toContain('$1,200.00')
    expect(t).toContain('2 lines of corrections made the same day are folded away')
    expect(server.asked.some(u => u.startsWith('/books/reports/general-ledger?accountId=a1&startDate=2026-10-01&endDate=2026-10-31'))).toBe(true)
    for (const raw of ['remittance', 'payment:']) expect(t).not.toContain(raw)
  })
})

describe('the cash flow on the books', () => {
  it('cash at the start, each section, cash at the end', async () => {
    server.replies = {
      '/books/reports/cash-flow': {
        source: 'ledger', period: { start: '2026-01-01', end: '2026-10-31' }, openingCash: 0, closingCash: 250, netChange: 250,
        rows: [
          { section: 'operating', key: 'ar_tenants', label: 'Accounts receivable: tenants', amount: 400 },
          { section: 'operating', key: 'ap:expense', label: 'Expenses paid', amount: -150 },
        ],
        totals: { operating: 250, investing: 0, financing: 0, opening: 0 },
      },
    }
    await render(<CashFlowPage />)
    const t = text()
    expect(t).toContain('Operating activities')
    expect(t).toContain('Expenses paid')
    expect(t).toContain('($150.00)')
    expect(t).toContain('Cash at the end')
    expect(t).not.toContain('ar_tenants')
  })
})
