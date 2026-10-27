/**
 * 10/25 (Nic): THE TRAILER PAYMENT'S OWN CARD.
 *
 *   "Should trailer payments get their own invoice separately payable from lot
 *    rent? Yeah, let's do that, and they need to be clearly labeled — I've had
 *    some people literally try to say, oh, I paid my rent, and then it's like,
 *    no, that was the trailer payment, you have the space rent too."
 *
 * So the page must make three things impossible to miss: the trailer payment
 * is a separate bill, paying it does NOT pay the space rent, and the two
 * amounts are never added into one Pay button.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from 'react-query'

const server = vi.hoisted(() => ({ balance: null as any }))
/** What the pay modal was opened for — the page's own choice of bill. */
const opened = vi.hoisted(() => ({ target: null as any }))
/** What the page PUT, so the autopay toggle can be read exactly. */
const sent = vi.hoisted(() => ({ calls: [] as Array<{ url: string; body: any }> }))

vi.mock('../lib/api', () => ({
  apiGet: async (url: string) => {
    if (url === '/payments/balance-context') return server.balance
    if (url === '/declared-deposits') return []
    if (url === '/tenants/payments') return []
    if (url === '/payments/remittances') return { remittances: [], prepaidRemaining: 0 }
    if (url === '/tenants/me/deposit-interest') return { deposit: null, rate: null, accruals: [] }
    throw new Error(`unexpected GET ${url}`)
  },
  apiPost: vi.fn(), apiPatch: vi.fn(), apiDelete: vi.fn(),
  apiPut: async (url: string, body: any) => { sent.calls.push({ url, body }); return { success: true } },
}))
vi.mock('./payShared', () => ({
  AddPaymentMethodModal: () => null,
  // The page hands the modal exactly one bill; the test reads which.
  PayNowModal: (p: any) => { opened.target = p?.target ?? null; return null },
  SavedMethodsCard: () => null,
  VerifyMicrodepositsCard: () => null,
  useTenantPaymentMethods: () => ({ data: [], isLoading: false }),
  readBalanceContext: async () => server.balance,
  AwaitingCardPayments: () => null,
}))
vi.mock('./AutopayCard', () => ({ AutopaySection: () => null }))

import { PaymentsPage } from './PaymentsPage'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const LEASE = 'lease-mh01'
const CONTRACT = 'contract-mh01'
/** Lisa Scheeler's shape: work trade, so no rent bill — and a $333.33 trailer bill. */
const trailerOnly = {
  totalOutstanding: 333.33,
  paymentBlocked: false,
  rows: [],
  leases: [],
  serviceAgreements: [],
  homeContracts: [{
    homeSaleContractId: CONTRACT, outstanding: 333.33,
    unitNumber: 'MH 01', propertyName: 'Mountain View RV Ranch', dueDate: '2026-10-10',
    installmentsTotal: 34, installmentsPaid: 0, monthlyPayment: 333.33,
    rows: [{ id: 'h1', amount: 333.33, dueDate: '2026-10-10', type: 'home_payment', notes: 'Home payment 1 of 34', label: 'Home payment' }],
    methodCosts: [{ method: 'ach', label: 'Bank account', fee: 6, total: 339.33 }],
  }],
}
/** A resident who owes both: the space rent and the trailer, as two bills. */
const bothBills = {
  ...trailerOnly,
  totalOutstanding: 783.33,
  leases: [{
    leaseId: LEASE, propertyName: 'Mountain View RV Ranch', unitNumber: 'MH 01',
    paymentBlocked: false, outstanding: 450,
    methodCosts: [{ method: 'ach', label: 'Bank account', fee: 6, total: 456 }],
  }],
}

let host: HTMLDivElement
let root: Root
async function render(balance: any) {
  server.balance = balance
  opened.target = null
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  await act(async () => {
    root.render(<QueryClientProvider client={qc}><PaymentsPage /></QueryClientProvider>)
  })
}
beforeEach(() => { opened.target = null; sent.calls = [] })
afterEach(() => {
  if (root) act(() => root.unmount())
  if (host) host.remove()
})

const text = () => host.textContent ?? ''
const buttons = () => [...host.querySelectorAll('button')].map(b => b.textContent ?? '')
const button = (label: string) => [...host.querySelectorAll('button')].find(b => b.textContent === label)
async function until(check: () => boolean, what: string) {
  for (let i = 0; i < 100; i++) {
    if (check()) return
    await act(async () => { await new Promise(r => setTimeout(r, 10)) })
  }
  throw new Error(`timed out waiting for ${what}\n${text()}`)
}

describe('the trailer payment on the tenant\'s payments page', () => {
  it('is its own card, says what it is, and says it does not pay the space rent', async () => {
    await render(trailerOnly)
    await until(() => text().includes('Home payment'), 'the trailer card')
    expect(text()).toContain('Home payment — MH 01, Mountain View RV Ranch')
    expect(text()).toContain('$333.33')
    expect(text()).toContain('Due 2026-10-10')
    // The sentence that exists because people said "I paid my rent".
    expect(text()).toContain('It does not pay your space rent.')
    // Where they are in the contract, so the bill is never a mystery figure.
    expect(text()).toContain('Payment 1 of 34')
  })

  it('pays only the trailer bill — never the space rent with it', async () => {
    await render(bothBills)
    await until(() => !!button('Pay $333.33'), 'the trailer Pay button')
    await act(async () => { button('Pay $333.33')!.click() })
    expect(opened.target).toMatchObject({
      amount: 333.33,
      kind: 'home',
      homeSaleContractId: CONTRACT,
      endpoint: '/payments/pay-balance',
    })
    // It names no lease, so the charge cannot reach into the space rent.
    expect(opened.target.leaseId).toBeUndefined()
    expect(opened.target.subheader).toContain('does not pay your space rent')
  })

  it('never offers one button for both bills — the two are paid separately', async () => {
    await render(bothBills)
    await until(() => !!button('Pay $333.33'), 'the trailer Pay button')
    // $783.33 is the sum of the two; no control ever offers it.
    expect(buttons().some(b => b.includes('783.33'))).toBe(false)
    expect(buttons()).toContain('Pay $333.33')
  })

  it('a buyer who rents no space here is not told to "pay rent"', async () => {
    // The investor who owns homes in parks he does not own: no lease at all.
    await render(trailerOnly)
    await until(() => text().includes('Home payment'), 'the trailer card')
    expect(text()).toContain('Billing')
    expect(text()).not.toContain('Pay rent and view history')
  })
})

describe('the trailer bill\'s own payment rules', () => {
  it('says so, and offers no card, when the contract bars cards', async () => {
    // 10/25 (Nic): Dominic Gonzalez's installment is the trust's money, so a
    // chargeback would have to be unwound across two sets of books.
    await render({
      ...trailerOnly,
      homeContracts: [{
        ...trailerOnly.homeContracts[0],
        cardsBlocked: true,
        // The server prices the ways to pay and drops card on such a bill.
        methodCosts: [
          { method: 'ach', label: 'Bank account', fee: 6, total: 339.33 },
          { method: 'manual', label: 'Cash, check or money order — free', fee: 0, total: 333.33 },
        ],
      }],
    })
    await until(() => text().includes('Home payment'), 'the trailer card')
    expect(text()).toContain('This one is paid by bank transfer, cash or check — not by card.')
  })

  it('autopay on the trailer is its own switch, and names only the contract', async () => {
    await render(bothBills)
    await until(() => !!button('Pay this automatically each month'), 'the autopay button')
    await act(async () => { button('Pay this automatically each month')!.click() })
    expect(sent.calls).toHaveLength(1)
    expect(sent.calls[0].url).toBe('/autopay')
    // Only the contract — never a lease, so enrolling this cannot touch rent.
    expect(sent.calls[0].body).toMatchObject({ homeSaleContractId: CONTRACT, enabled: true })
    expect(sent.calls[0].body.leaseId).toBeUndefined()
  })

  it('reads as on, and offers to turn it off, once it is enrolled', async () => {
    await render({
      ...trailerOnly,
      homeContracts: [{ ...trailerOnly.homeContracts[0], autopayOn: true, autopayPullDay: 10 }],
    })
    await until(() => !!button('Turn off automatic payments'), 'the off button')
    await act(async () => { button('Turn off automatic payments')!.click() })
    expect(sent.calls[0].body).toMatchObject({ homeSaleContractId: CONTRACT, enabled: false, pullDay: 10 })
  })
})
