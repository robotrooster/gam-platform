/**
 * S655 review — "I hadn't paid" on a report the server will no longer take
 * back, seen on the whole payments page.
 *
 * The refused report has usually just been matched to the tenant's deposit and
 * applied to their bill — often paying it off. The reload that follows the
 * refusal then shows a balance of $0, and the balance card (the only place the
 * list of reports sits) goes away. When the list held the server's answer, the
 * answer went with it: the tenant who pressed "I hadn't paid" watched the card
 * vanish and never read that the deposit had been applied, or who to contact
 * if they didn't make it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from 'react-query'

// What the server answers right now; each test moves it along.
const server = vi.hoisted(() => ({
  balance: null as any,
  reports: [] as any[],
  deleteFails: null as string | null,
}))

vi.mock('../lib/api', () => ({
  apiGet: async (url: string) => {
    if (url === '/payments/balance-context') return server.balance
    if (url === '/declared-deposits') return server.reports
    if (url === '/tenants/payments') return []
    if (url === '/payments/remittances') return { remittances: [], prepaidRemaining: 0 }
    if (url === '/tenants/me/deposit-interest') return { deposit: null, rate: null, accruals: [] }
    throw new Error(`unexpected GET ${url}`)
  },
  apiPost: vi.fn(), apiPut: vi.fn(), apiPatch: vi.fn(),
  apiDelete: async () => {
    if (server.deleteFails) throw new Error(server.deleteFails)
    return { success: true }
  },
}))
// The payment-method cards and autopay are not what is under test, and they
// load Stripe.
vi.mock('./payShared', () => ({
  AddPaymentMethodModal: () => null,
  PayNowModal: () => null,
  SavedMethodsCard: () => null,
  VerifyMicrodepositsCard: () => null,
  useTenantPaymentMethods: () => ({ data: [], isLoading: false }),
  readBalanceContext: async () => server.balance,
  // decisions.md #48.4: drawn by the page for held card payments (PaymentsPage.awaiting.test.tsx).
  AwaitingCardPayments: () => null,
}))
vi.mock('./AutopayCard', () => ({ AutopaySection: () => null }))

import { PaymentsPage } from './PaymentsPage'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const LEASE = 'lease-mh21'
const owing = (outstanding: number) => ({
  totalOutstanding: outstanding,
  paymentBlocked: false,
  rows: [],
  leases: [{
    leaseId: LEASE, propertyName: 'Country Acres', unitNumber: '21', paymentBlocked: false, outstanding,
    methodCosts: [
      { method: 'ach', label: 'Bank account', fee: 6, total: outstanding + 6 },
      { method: 'manual', label: 'Cash, check or money order — free', fee: 0, total: outstanding },
    ],
  }],
})
const pending = {
  id: 'report-1', leaseId: LEASE, amount: 666.5, declaredDate: '2026-09-30', method: 'cash',
  status: 'pending', bankFeedLinked: true,
}

let host: HTMLDivElement
let root: Root
beforeEach(async () => {
  server.balance = owing(666.5)
  server.reports = [pending]
  server.deleteFails = null
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  await act(async () => {
    root.render(<QueryClientProvider client={qc}><PaymentsPage /></QueryClientProvider>)
  })
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const text = () => host.textContent ?? ''
const button = (label: string) => [...host.querySelectorAll('button')].find(b => b.textContent === label)
async function until(check: () => boolean, what: string) {
  for (let i = 0; i < 100; i++) {
    if (check()) return
    await act(async () => { await new Promise(r => setTimeout(r, 10)) })
  }
  throw new Error(`timed out waiting for ${what}\n${text()}`)
}
async function press(label: string) {
  await until(() => !!button(label), `a "${label}" button`)
  await act(async () => { button(label)!.click() })
}
const times = (s: string) => text().split(s).length - 1

describe('taking back a deposit report the server refuses, on the payments page', () => {
  it('the report paid the bill off: the balance card goes, and the answer stays on screen until OK', async () => {
    await until(() => text().includes('Deposits you\'ve reported'), 'the report under the balance')

    // Meanwhile the deposit was matched and applied: nothing is owed now.
    server.deleteFails = 'That report can no longer be withdrawn'
    server.balance = owing(0)
    server.reports = [{ ...pending, status: 'confirmed', confirmedOn: '2026-10-01' }]
    await press('I hadn’t paid')

    await until(() => !text().includes('Outstanding balance'), 'the reload to take the paid-off balance away')
    await until(() => text().includes('applied to your bill on Oct 1'), 'where the report stands')
    expect(times('That report can no longer be withdrawn')).toBe(1)
    expect(text()).toContain('If you didn’t make this deposit, contact your landlord.')
    expect(button('I hadn’t paid')).toBeUndefined()

    await press('OK')
    expect(text()).not.toContain('That report can no longer be withdrawn')
    expect(text()).not.toContain('Deposits you\'ve reported')
  })

  it('the bill is still owed: the answer stays in the balance card, said once', async () => {
    await until(() => text().includes('Deposits you\'ve reported'), 'the report under the balance')

    server.deleteFails = 'We could not reach GAM. Try again.'
    await press('I hadn’t paid')
    await until(() => text().includes('We could not reach GAM. Try again.'), 'the server’s answer')
    // Let the reload land, then check nothing was said twice.
    await act(async () => { await new Promise(r => setTimeout(r, 50)) })
    expect(text()).toContain('Outstanding balance')
    expect(times('We could not reach GAM. Try again.')).toBe(1)
    expect(times('Deposits you\'ve reported')).toBe(1)
    expect(button('I hadn’t paid')).toBeTruthy()
  })
})

describe('10/6 (Nic): "I paid at the bank" only where the landlord takes rent deposited at their bank', () => {
  async function rerender() {
    act(() => root.unmount())
    root = createRoot(host)
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    await act(async () => {
      root.render(<QueryClientProvider client={qc}><PaymentsPage /></QueryClientProvider>)
    })
    await until(() => text().includes('Outstanding balance'), 'the balance')
  }
  const withBank = (taken: boolean) => {
    const b = owing(666.5)
    b.leases[0] = { ...b.leases[0], bankDepositsTaken: taken } as any
    return b
  }

  it('the property does not take them: no report button', async () => {
    server.balance = withBank(false)
    server.reports = []
    await rerender()
    expect(button('I paid at the bank — report a deposit')).toBeUndefined()
  })

  it('the property takes them: the report button is offered', async () => {
    server.balance = withBank(true)
    server.reports = []
    await rerender()
    expect(button('I paid at the bank — report a deposit')).toBeTruthy()
  })
})
