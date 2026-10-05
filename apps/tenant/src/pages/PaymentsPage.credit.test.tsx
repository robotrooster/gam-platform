/**
 * S655 money plan, Step 13 — account credit on the tenant's Payments page.
 *
 * Nic (10/2): the full balance is shown, with the credit beside it; the credit
 * is the tenant's to use or save at Pay, and it pays a bill by itself only when
 * it covers the whole bill. Deposit interest is named for what it is.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from 'react-query'

const server = vi.hoisted(() => ({
  balance: null as any,
  remittances: null as any,
  payTargets: [] as any[],
  methods: [] as any[],
  history: [] as any[],
  /** POST /payments/quote: what the server prices a charge at. */
  quotes: [] as any[],
  achFee: 6,
  passthrough: 0,
  quoteFails: false,
}))
const r2 = (n: number) => Math.round(n * 100) / 100

vi.mock('../lib/api', () => ({
  apiGet: async (url: string) => {
    if (url === '/payments/balance-context') return server.balance
    if (url === '/declared-deposits') return []
    if (url === '/tenants/payments') return server.history
    if (url === '/payments/remittances') return server.remittances
    if (url === '/tenants/me/deposit-interest') return { deposit: null, rate: null, accruals: [] }
    throw new Error(`unexpected GET ${url}`)
  },
  apiPost: async (url: string, body: any) => {
    if (url === '/payments/quote') {
      server.quotes.push(body)
      if (server.quoteFails) throw new Error('Network Error')
      // The server's own pricing: the property's fee payer (achFee 0 = the
      // landlord covers bank fees) and any tenant-payer platform fee on top.
      const fee = r2((body.method === 'ach' ? server.achFee : body.amount * 0.035 + 0.55) + server.passthrough)
      return { success: true, data: { base: body.amount, fee, total: r2(body.amount + fee), method: body.method } }
    }
    throw new Error(`unexpected POST ${url}`)
  },
  apiPut: vi.fn(), apiPatch: vi.fn(), apiDelete: vi.fn(),
}))
vi.mock('./payShared', () => ({
  AddPaymentMethodModal: () => null,
  PayNowModal: (p: any) => { server.payTargets.push(p.target); return null },
  SavedMethodsCard: () => null,
  VerifyMicrodepositsCard: () => null,
  useTenantPaymentMethods: () => ({ data: server.methods, isLoading: false }),
  readBalanceContext: async () => server.balance,
  // decisions.md #48.4: drawn by the page for held card payments (PaymentsPage.awaiting.test.tsx).
  AwaitingCardPayments: () => null,
}))
vi.mock('./AutopayCard', () => ({ AutopaySection: () => null }))

import { PaymentsPage } from './PaymentsPage'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const lease = (over: any = {}) => ({
  leaseId: 'L1', propertyName: 'Oak Park', unitNumber: 'MH 09', paymentBlocked: false,
  outstanding: 935.45, carriedBalance: 0, requiredNow: 935.45, usableCredit: 450, creditOnFile: 450,
  payIfUsed: 485.45, payIfSaved: 935.45, coversWholeBill: false, suggestedPayAhead: 2000,
  methodCosts: [{ method: 'ach', label: 'Bank account', fee: 6, total: 941.45 }], rows: [], ...over,
})

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  server.payTargets = []
  server.methods = []
  server.history = []
  server.quotes = []
  server.achFee = 6
  server.passthrough = 0
  server.quoteFails = false
  server.remittances = { remittances: [], prepaidRemaining: 0, depositInterestCredit: 0, otherCreditTotal: 0 }
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
  await act(async () => { root.render(<QueryClientProvider client={qc}><PaymentsPage /></QueryClientProvider>) })
}
const text = () => host.textContent ?? ''
const times = (s: string) => text().split(s).length - 1
/** The server's own figures for a bill (balance-context methodCosts): bank, card, and cash free. */
const billCosts = (amount: number, o: { achFee?: number; passthrough?: number } = {}) => {
  const ach = r2((o.achFee ?? 6) + (o.passthrough ?? 0))
  const card = r2(amount * 0.035 + 0.55 + (o.passthrough ?? 0))
  return [
    { method: 'ach', label: 'Bank account', fee: ach, total: r2(amount + ach) },
    { method: 'card', label: 'Card', fee: card, total: r2(amount + card) },
    { method: 'manual', label: 'Cash, check or money order — free', fee: 0, total: amount },
  ]
}
const button = (label: string) => [...host.querySelectorAll('button')].find((b) => b.textContent === label)
async function until(check: () => boolean, what: string) {
  for (let i = 0; i < 100; i++) {
    if (check()) return
    await act(async () => { await new Promise((r) => setTimeout(r, 10)) })
  }
  throw new Error(`timed out waiting for ${what}\n${text()}`)
}

describe('account credit on the Payments page', () => {
  it('the balance is the full bill, with the credit available beside it — never netted', async () => {
    server.balance = { totalOutstanding: 935.45, paymentBlocked: false, rows: [], leases: [lease()] }
    await render()
    await until(() => text().includes('Outstanding balance'), 'the balance card')
    expect(text()).toContain('$935.45')
    expect(text()).toContain('You have $450.00 credit available — you can use it when you pay.')
    expect(button('Pay your bill')).toBeTruthy()
    expect(text()).not.toContain('$485.45')
  })

  it('Pay opens the credit question on that lease (the modal reads the live bill)', async () => {
    server.balance = { totalOutstanding: 935.45, paymentBlocked: false, rows: [], leases: [lease()] }
    await render()
    await until(() => !!button('Pay your bill'), 'the Pay button')
    await act(async () => { button('Pay your bill')!.click() })
    await until(() => server.payTargets.length > 0, 'the pay screen')
    expect(server.payTargets.at(-1)).toMatchObject({ leaseId: 'L1', amount: 935.45, requiredNow: 935.45, endpoint: '/payments/pay-balance' })
  })

  it('the full balance includes an old balance, and the credit sentence covers both leases on Pay all', async () => {
    server.balance = { totalOutstanding: 1400, paymentBlocked: false, rows: [], leases: [
      lease({ outstanding: 1035.45, carriedBalance: 100, usableCredit: 450 }),
      lease({ leaseId: 'L2', unitNumber: 'RV 22', outstanding: 300, requiredNow: 300, usableCredit: 50, payIfUsed: 250, payIfSaved: 300 }),
    ] }
    await render()
    await until(() => text().includes('What this covers'), 'the combined card')
    expect(text()).toContain('$1,035.45')
    expect(text()).toContain('$1,335.45')
    expect(text()).toContain('You have $500.00 credit available — you can use it when you pay.')
    // With credit there is no one figure until the tenant answers Use / Save.
    expect(button('Pay $1,335.45')).toBeUndefined()
    await act(async () => { button('Pay your bill')!.click() })
    await until(() => server.payTargets.length > 0, 'the pay screen')
    expect(server.payTargets.at(-1).batch).toEqual([{ leaseId: 'L1', amount: 1035.45 }, { leaseId: 'L2', amount: 300 }])
  })

  it('the account credit card says how credit is used, and names deposit interest', async () => {
    server.balance = { totalOutstanding: 0, paymentBlocked: false, rows: [], leases: [] }
    server.remittances = { remittances: [], prepaidRemaining: 37.6, depositInterestCredit: 12.5, otherCreditTotal: 10 }
    await render()
    await until(() => text().includes('Account credit'), 'the credit card')
    expect(text()).toContain('$60.10')
    expect(text()).toContain('Use it when you pay. It is applied by itself only when it covers a whole bill.')
    expect(text()).toContain('Statutory interest on your deposit$12.50')
    expect(text()).toContain('Paid ahead$37.60')
    expect(text()).toContain('Credit from your landlord$10.00')
    expect(text()).not.toContain('automatically as it arrives')
  })

  it('a payment that used account credit lists the credit on its own line', async () => {
    server.balance = { totalOutstanding: 0, paymentBlocked: false, rows: [], leases: [] }
    server.remittances = {
      prepaidRemaining: 0, depositInterestCredit: 0, otherCreditTotal: 0,
      remittances: [{ id: 'r1', amount: 485.45, appliedAmount: 485.45, unappliedAmount: 0, status: 'settled',
        paymentMethod: 'ach', createdAt: '2026-10-01T12:00:00Z', settledAt: '2026-10-03T12:00:00Z', creditUsed: 450,
        lines: [{ paymentId: 'p1', amountApplied: 485.45, type: 'rent', dueDate: '2026-10-01', entryDescription: 'RENT', paymentStatus: 'settled' }] }],
    }
    await render()
    await until(() => text().includes('Payments you’ve made'), 'the history card')
    expect(text()).toContain('+ $450.00 account credit')
    expect(text()).toContain('Paid')
    await act(async () => { [...host.querySelectorAll('button')].find((b) => b.textContent?.includes('$485.45'))!.click() })
    expect(text()).toContain('Account credit used$450.00')
  })

  it('a failed payment shows no credit line — its credit went back to the account', async () => {
    server.balance = { totalOutstanding: 0, paymentBlocked: false, rows: [], leases: [] }
    server.remittances = {
      prepaidRemaining: 0, depositInterestCredit: 0, otherCreditTotal: 0,
      remittances: [{ id: 'r1', amount: 485.45, appliedAmount: 485.45, unappliedAmount: 0, status: 'failed',
        paymentMethod: 'ach', createdAt: '2026-10-01T12:00:00Z', settledAt: null, creditUsed: 450,
        lines: [{ paymentId: 'p1', amountApplied: 485.45, type: 'rent', dueDate: '2026-10-01', entryDescription: 'RENT', paymentStatus: 'failed' }] }],
    }
    await render()
    await until(() => text().includes('Payments you’ve made'), 'the history card')
    await act(async () => { [...host.querySelectorAll('button')].find((b) => b.textContent?.includes('$485.45'))!.click() })
    expect(text()).not.toContain('Account credit set aside')
    expect(text()).not.toContain('Account credit used')
  })

  it('a failed payment that paid ahead never says the extra is kept as credit', async () => {
    server.balance = { totalOutstanding: 0, paymentBlocked: false, rows: [], leases: [] }
    server.remittances = {
      prepaidRemaining: 0, depositInterestCredit: 0, otherCreditTotal: 0,
      remittances: [{ id: 'r1', amount: 1500, appliedAmount: 500, unappliedAmount: 1000, status: 'failed',
        paymentMethod: 'ach', createdAt: '2026-10-01T12:00:00Z', settledAt: null, creditUsed: 0,
        lines: [{ paymentId: 'p1', amountApplied: 500, type: 'rent', dueDate: '2026-10-01', entryDescription: 'RENT', paymentStatus: 'failed' }] }],
    }
    await render()
    await until(() => text().includes('Payments you’ve made'), 'the history card')
    await act(async () => { [...host.querySelectorAll('button')].find((b) => b.textContent?.includes('$1,500.00'))!.click() })
    expect(text()).toContain('This payment didn’t go through')
    expect(text()).not.toContain('kept as credit')
    expect(text()).not.toContain('Paid ahead')
  })

  it('a payment still clearing that paid ahead says the extra is kept once it settles', async () => {
    server.balance = { totalOutstanding: 0, paymentBlocked: false, rows: [], leases: [] }
    server.remittances = {
      prepaidRemaining: 0, depositInterestCredit: 0, otherCreditTotal: 0,
      remittances: [{ id: 'r1', amount: 1500, appliedAmount: 500, unappliedAmount: 1000, status: 'processing',
        paymentMethod: 'ach', createdAt: '2026-10-01T12:00:00Z', settledAt: null, creditUsed: 0,
        lines: [{ paymentId: 'p1', amountApplied: 500, type: 'rent', dueDate: '2026-10-01', entryDescription: 'RENT', paymentStatus: 'processing' }] }],
    }
    await render()
    await until(() => text().includes('Payments you’ve made'), 'the history card')
    await act(async () => { [...host.querySelectorAll('button')].find((b) => b.textContent?.includes('$1,500.00'))!.click() })
    expect(text()).toContain('Paid ahead — kept as credit on your account once this payment settles')
  })
})

describe('Pay all names what it charges (S622)', () => {
  // Two of one landlord's leases, both with an earlier balance: every space's
  // current bill is claimed first, so one earlier balance waits for after.
  const twoOwing = (over: any = {}) => [
    lease({ leaseId: 'L1', landlordId: 'LL1', unitNumber: 'MH 01', outstanding: 600, requiredNow: 500, carriedBalance: 100,
      usableCredit: 0, creditOnFile: 0, payIfUsed: 500, payIfSaved: 500,
      methodCosts: billCosts(500), ...over }),
    lease({ leaseId: 'L2', landlordId: 'LL1', unitNumber: 'MH 02', outstanding: 350, requiredNow: 300, carriedBalance: 50,
      usableCredit: 0, creditOnFile: 0, payIfUsed: 300, payIfSaved: 300,
      methodCosts: billCosts(300) }),
  ]

  it('two leases with earlier balances and no credit: the button names the charge, and the card says which earlier balance waits', async () => {
    server.balance = { totalOutstanding: 950, paymentBlocked: false, rows: [], leases: twoOwing() }
    await render()
    await until(() => text().includes('What this covers'), 'the combined card')
    // The full balance is still the headline.
    expect(text()).toContain('$950.00')
    // What is charged: both current bills and the one earlier balance that rides the last charge.
    expect(button('Pay $850.00')).toBeTruthy()
    expect(button('Pay $950.00')).toBeUndefined()
    expect(text()).toContain('Unit MH 01$500.00')
    expect(text()).toContain('Unit MH 02$350.00')
    expect(text()).toContain('The earlier balance on Unit MH 01 ($100.00) isn\'t in this payment — you can pay it down once this one goes through.')
    expect(text()).not.toContain('Everything you owe, in one payment')
    // Ways to pay prices the same charges: each its own payment with its own fee.
    await until(() => text().includes('Bank account · +$12.00 fee$862.00'), 'the server-priced ways to pay')
    expect(text()).toContain('Cash, check or money order — free$850.00')
    // MH 01 is charged its bill alone — the server's own figures; MH 02's
    // charge carries its earlier balance, so the server is asked for that amount.
    expect(server.quotes.map((q) => [q.leaseId, q.amount, q.method]).sort()).toEqual([['L2', 350, 'ach'], ['L2', 350, 'card']])
    await act(async () => { button('Pay $850.00')!.click() })
    await until(() => server.payTargets.length > 0, 'the pay screen')
    expect(server.payTargets.at(-1).batch).toEqual([{ leaseId: 'L1', amount: 600 }, { leaseId: 'L2', amount: 350 }])
  })

  it('nothing held back: the button is the whole balance, said as before', async () => {
    server.balance = { totalOutstanding: 800, paymentBlocked: false, rows: [], leases: [
      lease({ leaseId: 'L1', landlordId: 'LL1', unitNumber: 'MH 01', outstanding: 500, requiredNow: 500, carriedBalance: 0, usableCredit: 0, creditOnFile: 0, payIfUsed: 500, payIfSaved: 500 }),
      lease({ leaseId: 'L2', landlordId: 'LL1', unitNumber: 'MH 02', outstanding: 300, requiredNow: 300, carriedBalance: 0, usableCredit: 0, creditOnFile: 0, payIfUsed: 300, payIfSaved: 300 }),
    ] }
    await render()
    await until(() => !!button('Pay $800.00'), 'the Pay button')
    expect(text()).toContain('Everything you owe, in one payment')
    expect(text()).not.toContain('isn\'t in this payment')
  })

  it('with credit: no figure on the button until the tenant answers Use / Save on the pay screen', async () => {
    server.balance = { totalOutstanding: 950, paymentBlocked: false, rows: [], leases: twoOwing({ usableCredit: 100, creditOnFile: 100, payIfUsed: 400 }) }
    await render()
    await until(() => !!button('Pay your bill'), 'the Pay button')
    expect(text()).toContain('You have $100.00 credit available — you can use it when you pay.')
    expect([...host.querySelectorAll('button')].some((b) => /^Pay \$/.test(b.textContent ?? ''))).toBe(false)
  })
})

describe('one lease with an earlier balance: ways to pay prices what Pay names', () => {
  it('the bank and cash figures include the earlier balance the Pay button includes', async () => {
    server.balance = { totalOutstanding: 600, paymentBlocked: false, rows: [], leases: [
      lease({ outstanding: 600, requiredNow: 500, carriedBalance: 100, usableCredit: 0, creditOnFile: 0, payIfUsed: 500, payIfSaved: 500,
        // The server prices the bill alone (its payIfSaved).
        methodCosts: billCosts(500) }),
    ] }
    await render()
    await until(() => !!button('Pay $600.00'), 'the Pay button')
    await until(() => text().includes('Bank account · +$6.00 fee$606.00'), 'the server-priced ways to pay')
    expect(text()).toContain('Cash, check or money order — free$600.00')
    expect(text()).not.toContain('$506.00')
  })

  it('a landlord who covers bank fees: the bank is shown with no fee, as the charge takes it', async () => {
    server.achFee = 0
    server.balance = { totalOutstanding: 600, paymentBlocked: false, rows: [], leases: [
      lease({ outstanding: 600, requiredNow: 500, carriedBalance: 100, usableCredit: 0, creditOnFile: 0, payIfUsed: 500, payIfSaved: 500,
        methodCosts: billCosts(500, { achFee: 0 }) }),
    ] }
    await render()
    await until(() => text().includes('Card · +$21.55 fee$621.55'), 'the server-priced ways to pay')
    expect(text()).toContain('Bank account$600.00')
    expect(text()).not.toContain('+$6.00 fee')
    expect(server.quotes.map((q) => [q.amount, q.method]).sort()).toEqual([[600, 'ach'], [600, 'card']])
  })

  it('a landlord who covers bank fees, no earlier balance: the server\'s own bill figures, nothing re-priced', async () => {
    server.balance = { totalOutstanding: 500, paymentBlocked: false, rows: [], leases: [
      lease({ outstanding: 500, requiredNow: 500, carriedBalance: 0, usableCredit: 0, creditOnFile: 0, payIfUsed: 500, payIfSaved: 500,
        methodCosts: billCosts(500, { achFee: 0 }) }),
    ] }
    await render()
    await until(() => !!button('Pay $500.00'), 'the Pay button')
    expect(text()).not.toContain('+$6.00 fee')
    expect(text()).toContain('Card · +$18.05 fee$518.05')
    expect(server.quotes).toEqual([])
  })

  it('a tenant-payer platform fee rides on top: the ways to pay include it, with an earlier balance and without', async () => {
    server.passthrough = 2.5
    server.balance = { totalOutstanding: 600, paymentBlocked: false, rows: [], leases: [
      lease({ outstanding: 600, requiredNow: 500, carriedBalance: 100, usableCredit: 0, creditOnFile: 0, payIfUsed: 500, payIfSaved: 500,
        methodCosts: billCosts(500, { passthrough: 2.5 }) }),
    ] }
    await render()
    await until(() => text().includes('Bank account · +$8.50 fee$608.50'), 'the server-priced ways to pay')
    expect(text()).toContain('Card · +$24.05 fee$624.05')
  })

  it('a fee the server could not price is never guessed: no figure, and Pay still shows the exact fee', async () => {
    server.quoteFails = true
    server.balance = { totalOutstanding: 600, paymentBlocked: false, rows: [], leases: [
      lease({ outstanding: 600, requiredNow: 500, carriedBalance: 100, usableCredit: 0, creditOnFile: 0, payIfUsed: 500, payIfSaved: 500,
        methodCosts: billCosts(500) }),
    ] }
    await render()
    await until(() => text().includes('We couldn\'t work out the fees just now.'), 'the plain failure line')
    expect(times('We couldn\'t work out the fees just now.')).toBe(1)
    expect(text()).not.toContain('Bank account · ')
    expect(text()).not.toContain('$606.00')
    expect(button('Pay $600.00')).toBeTruthy()
  })

  it('with credit: the button names no figure, and the ways to pay are the bill the answers name — never the balance plus the earlier one', async () => {
    // $500 bill, $100 earlier balance, $50 credit: the pay screen offers
    // "Use all $50 — pay $450" / "Save it for later — pay $500". A "Pay $600"
    // button matched neither.
    server.balance = { totalOutstanding: 600, paymentBlocked: false, rows: [], leases: [
      lease({ outstanding: 600, requiredNow: 500, carriedBalance: 100, usableCredit: 50, creditOnFile: 50, payIfUsed: 450, payIfSaved: 500,
        methodCosts: billCosts(500) }),
    ] }
    await render()
    await until(() => !!button('Pay your bill'), 'the Pay button')
    // The balance is still the whole of it, with the credit beside it.
    expect(text()).toContain('$600.00')
    expect(text()).toContain('You have $50.00 credit available — you can use it when you pay.')
    expect([...host.querySelectorAll('button')].some((b) => /^Pay \$/.test(b.textContent ?? ''))).toBe(false)
    expect(text()).toContain('Bank account · +$6.00 fee$506.00')
    expect(text()).toContain('Cash, check or money order — free$500.00')
    expect(text()).not.toContain('$606.00')
    await act(async () => { button('Pay your bill')!.click() })
    await until(() => server.payTargets.length > 0, 'the pay screen')
    expect(server.payTargets.at(-1)).toMatchObject({ leaseId: 'L1', amount: 600, requiredNow: 500 })
  })
})

describe('a receipt names each utility it paid (decisions #17)', () => {
  it('a utility line on a payment is Water, Trash… — never a generic "Utilities"', async () => {
    server.balance = { totalOutstanding: 0, paymentBlocked: false, rows: [], leases: [] }
    server.remittances = {
      prepaidRemaining: 0, depositInterestCredit: 0, otherCreditTotal: 0,
      remittances: [{ id: 'r1', amount: 60.45, appliedAmount: 60.45, unappliedAmount: 0, status: 'settled',
        paymentMethod: 'ach', createdAt: '2026-10-01T12:00:00Z', settledAt: '2026-10-03T12:00:00Z', creditUsed: 0,
        lines: [
          { paymentId: 'u1', amountApplied: 10.45, type: 'utility', dueDate: '2026-10-01', entryDescription: 'UTILITY', paymentStatus: 'settled', notes: 'Water — meter 1200 → 1450' },
          { paymentId: 'u2', amountApplied: 25, type: 'utility', dueDate: '2026-10-01', entryDescription: 'UTILITY', paymentStatus: 'settled', utilityType: 'trash' },
          { paymentId: 'u3', amountApplied: 25, type: 'utility', dueDate: '2026-10-01', entryDescription: 'UTILITY', paymentStatus: 'settled' },
        ] }],
    }
    await render()
    await until(() => text().includes('Payments you’ve made'), 'the history card')
    await act(async () => { [...host.querySelectorAll('button')].find((b) => b.textContent?.includes('$60.45'))!.click() })
    const receipt = [...host.querySelectorAll('table')].find((t) => t.querySelector('th')?.textContent === 'Applied to')!
    const applied = [...receipt.querySelectorAll('tbody tr')].map((tr) => tr.querySelector('td')?.textContent ?? '')
    expect(applied).toEqual(['Water', 'Trash', 'Utility'])
    expect(text()).not.toContain('Utilities')
  })
})

describe('a bank still verifying, on the Payments page', () => {
  const bankAt = (step: 'deposits' | 'checking') => ({
    id: `pm_${step}`, type: 'ach', bankName: 'Wells Fargo', last4: '2222', verified: false, verifying: true,
    verificationStep: step, chargeable: false, isDefault: true,
  })

  it('a bank being checked is told there is nothing more to do — never to confirm a deposit', async () => {
    server.methods = [bankAt('checking')]
    server.balance = { totalOutstanding: 935.45, paymentBlocked: false, rows: [], leases: [lease()] }
    await render()
    await until(() => text().includes('Your bank is being checked'), 'the checking notice')
    expect(text()).toContain('there is nothing more to do')
    expect(text()).not.toContain('Your bank needs one more step from you')
    expect(text()).not.toContain('confirm it in the box')
  })

  it('a bank waiting on its deposits is asked to confirm them', async () => {
    server.methods = [bankAt('deposits')]
    server.balance = { totalOutstanding: 935.45, paymentBlocked: false, rows: [], leases: [lease()] }
    await render()
    await until(() => text().includes('Your bank needs one more step from you'), 'the deposits notice')
    expect(text()).not.toContain('Your bank is being checked')
  })
})

describe('a utility bill on the Payments page names each utility (decisions #17)', () => {
  it('each line is Water, Trash… — never a generic "Utilities"', async () => {
    server.balance = { totalOutstanding: 60.45, paymentBlocked: false, rows: [], leases: [], serviceAgreements: [{
      serviceAgreementId: 'SA1', outstanding: 60.45, unitNumber: 'Lot 3', propertyName: 'Oak Park', dueDate: '2026-10-01',
      rows: [
        { id: 'u1', amount: 10.45, dueDate: '2026-10-01', type: 'utility', notes: 'Water — meter 1200 → 1450' },
        { id: 'u2', amount: 25, dueDate: '2026-10-01', type: 'utility', notes: null, utilityType: 'trash' },
        { id: 'u3', amount: 25, dueDate: '2026-10-01', type: 'utility', notes: null },
      ],
    }] }
    await render()
    await until(() => text().includes('Utility bill — Oak Park'), 'the utility card')
    expect(text()).toContain('Water$10.45')
    expect(text()).toContain('Trash$25.00')
    expect(text()).toContain('Utility$25.00')
    expect(text()).not.toContain('Utilities')
  })

  it('the payment history names a utility line by its utility too', async () => {
    server.balance = { totalOutstanding: 0, paymentBlocked: false, rows: [], leases: [] }
    server.history = [{ id: 'h1', dueDate: '2026-10-01', type: 'utility', amount: 10.45, status: 'pending',
      entryDescription: 'UTILITY', notes: 'Water — meter 1200 → 1450' }]
    await render()
    await until(() => text().includes('$10.45'), 'the history row')
    expect(text()).toContain('Water')
  })
})
