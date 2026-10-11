/**
 * decisions.md #48.4 (3-D Secure), on the whole Payments page.
 *
 * A card payment waiting on its card's bank holds the bill it pays. When it
 * holds the whole bill, nothing is owed, so the page draws no balance card and
 * no Pay button — and the pay window, which carried "Confirm with your bank"
 * and "Cancel it and pay another way", is never opened. The page shows the
 * held payment itself, from balance-context's awaitingCardConfirmations,
 * whatever else is owed: the payer gets both buttons; the rest of the
 * household is told whose card's bank it waits on.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from 'react-query'

const server = vi.hoisted(() => ({
  balance: null as any,
  remittances: [] as any[],
  posts: [] as { url: string; body: any }[],
  /** What the server's history says once a held card payment is released. */
  remittancesAfterRelease: null as any[] | null,
}))

vi.mock('../lib/api', () => ({
  apiGet: async (url: string) => {
    if (url === '/payments/balance-context') return server.balance
    if (url === '/declared-deposits') return []
    if (url === '/tenants/payments') return []
    if (url === '/payments/remittances') return { remittances: server.remittances, prepaidRemaining: 0 }
    if (url === '/tenants/me/deposit-interest') return { deposit: null, rate: null, accruals: [] }
    throw new Error(`unexpected GET ${url}`)
  },
  apiPost: async (url: string, body: any) => {
    server.posts.push({ url, body })
    if (url === '/payments/pay-balance/release') {
      // Released: the bill opens again.
      server.balance = { ...server.balance, awaitingCardConfirmations: [] }
      if (server.remittancesAfterRelease) server.remittances = server.remittancesAfterRelease
      return { success: true, data: { outcome: 'released', declined: false } }
    }
    throw new Error(`unexpected POST ${url}`)
  },
  apiPut: vi.fn(), apiPatch: vi.fn(), apiDelete: vi.fn(),
}))
// The real held-payment block; the rest of the pay screen is not under test.
vi.mock('./payShared', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  AddPaymentMethodModal: () => null,
  PayNowModal: () => null,
  SavedMethodsCard: () => null,
  VerifyMicrodepositsCard: () => null,
  useTenantPaymentMethods: () => ({ data: [], isLoading: false }),
  readBalanceContext: async () => server.balance,
}))
vi.mock('./AutopayCard', () => ({ AutopaySection: () => null }))

import { PaymentsPage } from './PaymentsPage'
// GET /payments/balance-context's real answer for a held card payment (the
// payer's view and a co-tenant's), as the wire carries it — written by
// apps/api/src/routes/payments.test.ts ("…is the Payments page's fixture").
import real from './__fixtures__/balanceContext.awaiting.real.json'
// GET /payments/remittances's real answer for card payments released before
// anything was charged — one canceled, one declined by its bank, one ordinary
// failure — written by payments.test.ts ("payment history: …").
import realHistory from './__fixtures__/remittances.cardReleased.real.json'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const held = (over: any = {}) => ({
  paymentIntentId: 'pi_wait', amount: 518.05, confirmBy: '2026-10-04T18:30:00Z',
  canConfirm: true, mine: true, payerName: null, leaseId: 'L1', serviceAgreementId: null, ...over,
})
/** balance-context as the server answers it while a card payment holds the whole bill: nothing owed. */
const heldWhole = (items: any[], leases: any[] = [lease()]) => ({
  totalOutstanding: 0, paymentBlocked: false, rows: [], serviceAgreements: [],
  leases, awaitingCardConfirmations: items,
})
const lease = (over: any = {}) => ({
  leaseId: 'L1', propertyName: 'Oak Park', unitNumber: 'MH 09', paymentBlocked: false,
  outstanding: 0, carriedBalance: 0, requiredNow: 0, usableCredit: 0, creditOnFile: 0,
  payIfUsed: 0, payIfSaved: 0, coversWholeBill: false, clearing: 0, rows: [], ...over,
})

let host: HTMLDivElement
let root: Root
async function show(balance: any) {
  server.balance = balance
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  await act(async () => {
    root.render(<QueryClientProvider client={qc}><PaymentsPage /></QueryClientProvider>)
  })
}
beforeEach(() => { server.posts = []; server.remittances = []; server.remittancesAfterRelease = null })
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const text = () => host.textContent ?? ''
const button = (label: string) => [...host.querySelectorAll('button')].find((b) => b.textContent === label)
async function until(check: () => boolean, what: string) {
  for (let i = 0; i < 200; i++) {
    if (check()) return
    await act(async () => { await new Promise((r) => setTimeout(r, 10)) })
  }
  throw new Error(`timed out waiting for ${what}\n${text()}`)
}

describe('a card payment waiting on its bank, on the Payments page', () => {
  it('nothing else owed: the payer still sees it with Confirm with your bank and Cancel it and pay another way', async () => {
    await show(heldWhole([held()]))
    await until(() => text().includes('A card payment of $518.05 is waiting for your card\'s bank to confirm it.'), 'the held payment')
    expect(button('Confirm with your bank')).toBeTruthy()
    expect(button('Cancel it and pay another way')).toBeTruthy()
    expect(text()).not.toContain('Outstanding balance')
  })

  it('Cancel it and pay another way releases it from the page and the block goes once the bill is read again', async () => {
    await show(heldWhole([held()]))
    await until(() => !!button('Cancel it and pay another way'), 'Cancel')
    await act(async () => { button('Cancel it and pay another way')!.click() })
    await until(() => text().includes('Canceled — nothing was charged. Your bill is open to pay.'), 'the note')
    expect(server.posts.map((p) => p.url)).toEqual(['/payments/pay-balance/release'])
    await until(() => !button('Confirm with your bank'), 'the block gone after the re-read')
  })

  it('a co-tenant sees whose card\'s bank it waits on, by name, with no buttons', async () => {
    await show(heldWhole([held({ mine: false, canConfirm: false, payerName: 'Jane Doe' })]))
    await until(() => text().includes('waiting on Jane Doe\'s card\'s bank to confirm it. Nothing has been charged yet.'), 'the co-tenant note')
    expect(button('Confirm with your bank')).toBeUndefined()
    expect(button('Cancel it and pay another way')).toBeUndefined()
  })

  it('with more than one bill on the page, the held payment names the space it is for', async () => {
    await show(heldWhole([held({ mine: false, canConfirm: false, payerName: 'Jane Doe' })],
      [lease(), lease({ leaseId: 'L2', unitNumber: 'MH 10', outstanding: 300, requiredNow: 300, payIfUsed: 300, payIfSaved: 300 })]))
    await until(() => text().includes('A card payment of $518.05 for Oak Park · Unit MH 09 is waiting on Jane Doe\'s card\'s bank to confirm it.'), 'the named space')
  })

  it('nothing held: nothing drawn', async () => {
    await show(heldWhole([]))
    await act(async () => { await new Promise((r) => setTimeout(r, 30)) })
    expect(text()).not.toContain('waiting for your card')
    expect(button('Confirm with your bank')).toBeUndefined()
  })
})

describe('the held card payment, from the server\'s real answer', () => {
  it('the hand-made held payment above uses only fields the server really sends', () => {
    const realKeys = new Set(Object.keys(real.payer.awaitingCardConfirmations[0]))
    expect(Object.keys(held()).filter((k) => !realKeys.has(k))).toEqual([])
    const realLeaseKeys = new Set(Object.keys(real.payer.leases[0]))
    expect(Object.keys(lease()).filter((k) => !realLeaseKeys.has(k))).toEqual([])
  })

  it('the payer: nothing else owed, and the page still shows it with both buttons', async () => {
    await show(real.payer)
    const amount = real.payer.awaitingCardConfirmations[0].amount.toLocaleString('en-US', { minimumFractionDigits: 2 })
    await until(() => text().includes(`A card payment of $${amount} is waiting for your card's bank to confirm it.`), 'the held payment')
    expect(button('Confirm with your bank')).toBeTruthy()
    expect(button('Cancel it and pay another way')).toBeTruthy()
  })

  it('a co-tenant: told whose card\'s bank it waits on, by name, with no buttons', async () => {
    await show(real.coTenant)
    await until(() => text().includes('waiting on Jane Doe\'s card\'s bank to confirm it. Nothing has been charged yet.'), 'the co-tenant note')
    expect(button('Confirm with your bank')).toBeUndefined()
    expect(button('Cancel it and pay another way')).toBeUndefined()
  })
})

describe('payment history names a card payment\'s state in plain words', () => {
  const remit = (over: any = {}) => ({
    id: 'R1', amount: 1005, appliedAmount: 1000, unappliedAmount: 0, status: 'processing', paymentMethod: 'card',
    createdAt: '2026-10-04T18:00:00Z', settledAt: null, creditUsed: 0, canceledBeforeCharge: false, lines: [], ...over,
  })

  it('a card payment held for its bank reads "Waiting on your bank" — never "Processing" beside "nothing has been charged yet"', async () => {
    server.remittances = [remit({ id: real.payer.awaitingCardConfirmations[0].remittanceId })]
    await show(real.payer)
    await until(() => text().includes('Waiting on your bank'), 'the history label')
    expect(text()).not.toContain('Processing')
  })

  it('a card payment canceled before anything was charged reads "Canceled — nothing charged", never a red Failed', async () => {
    server.remittances = [remit({ status: 'failed', canceledBeforeCharge: true })]
    await show(heldWhole([]))
    await until(() => text().includes('Canceled — nothing charged'), 'the history label')
    expect(text()).not.toContain('Failed')
    const badge = [...host.querySelectorAll('.badge')].find((b) => b.textContent === 'Canceled — nothing charged')
    expect(badge?.className).not.toContain('b-red')
    await act(async () => { [...host.querySelectorAll('button')].find((b) => b.textContent?.includes('Canceled — nothing charged'))!.click() })
    expect(text()).toContain('This card payment was canceled before anything was charged, and the charges below went back on your bill.')
    expect(text()).not.toContain('didn’t go through')
  })

  it('an ordinary failed card payment (not released before charge) reads Failed', async () => {
    server.remittances = [remit({ status: 'failed', canceledBeforeCharge: false })]
    await show(heldWhole([]))
    await until(() => text().includes('Failed'), 'the Failed badge')
    expect(text()).not.toContain('Canceled — nothing charged')
  })
})

describe('payment history from the server\'s real answer (decisions.md #48.4, fix pass 3)', () => {
  const fromWire = (i: number) => realHistory.remittances[i]
  const canceledOne = realHistory.remittances.find((r) => r.canceledBeforeCharge)!
  const declinedOne = realHistory.remittances.find((r) => r.declinedBeforeCharge)!
  const plainFailed = realHistory.remittances.find((r) => !r.canceledBeforeCharge && !r.declinedBeforeCharge)!

  it('the hand-made receipt in the tests above uses only fields the server really sends', () => {
    const realKeys = new Set(Object.keys(fromWire(0)))
    const handMade = { id: 'R1', amount: 1, appliedAmount: 1, unappliedAmount: 0, status: 'processing', paymentMethod: 'card',
      createdAt: '', settledAt: null, creditUsed: 0, canceledBeforeCharge: false, lines: [] }
    expect(Object.keys(handMade).filter((k) => !realKeys.has(k))).toEqual([])
  })

  it('canceled before anything was charged reads "Canceled — nothing charged"; declined by the bank reads "Declined — nothing charged"; an ordinary failure reads Failed', async () => {
    server.remittances = [canceledOne, declinedOne, plainFailed]
    await show(heldWhole([]))
    await until(() => text().includes('Declined — nothing charged'), 'the declined label')
    expect(text()).toContain('Canceled — nothing charged')
    expect(text()).toContain('Failed')
    const open = async (label: string) => {
      await act(async () => { [...host.querySelectorAll('button')].find((b) => b.textContent?.includes(label))!.click() })
    }
    await open('Declined — nothing charged')
    expect(text()).toContain('Your card’s bank declined this payment before anything was charged, and the charges below went back on your bill.')
    expect(text()).not.toContain('open to pay again')
  })

  it('after Cancel it and pay another way, the history row reads "Canceled — nothing charged" — never Clearing or Processing beside the note', async () => {
    const remittanceId = real.payer.awaitingCardConfirmations[0].remittanceId
    // Before: the receipt is processing (shown as waiting on the bank).
    server.remittances = [{ ...canceledOne, id: remittanceId, status: 'processing', canceledBeforeCharge: false }]
    // After the release: the server's history says canceled before anything was charged.
    server.remittancesAfterRelease = [{ ...canceledOne, id: remittanceId }]
    await show(real.payer)
    await until(() => text().includes('Waiting on your bank'), 'the waiting label')
    await act(async () => { button('Cancel it and pay another way')!.click() })
    await until(() => text().includes('Canceled — nothing was charged. Your bill is open to pay.'), 'the note')
    await until(() => text().includes('Canceled — nothing charged'), 'the history row read again')
    expect(text()).not.toContain('Clearing')
    expect(text()).not.toContain('Processing')
    expect(text()).not.toContain('Waiting on your bank')
  })
})
