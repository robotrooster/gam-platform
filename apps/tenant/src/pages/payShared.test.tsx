/**
 * S655 money plan, Step 13 — the tenant's pay screen and saved methods.
 *
 * Nic (10/2): the tenant sees the full bill; when credit could pay part of it
 * they choose "Use all $X — pay $Y" or "Save it for later — pay $Z"; when it
 * covers the whole bill, "Pay with credit — nothing charged". A credit that
 * moved is a 409 and the screen reads the bill again and asks again IN PLACE.
 * Item L: every bank is listed; Remove says the server's reason before sending
 * anything when the bank must stay.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from 'react-query'

const server = vi.hoisted(() => ({
  balance: null as any,
  posts: [] as { url: string; body: any }[],
  payFails: [] as { status: number; error: string; then?: () => void }[],
  deletes: [] as string[],
  deleteResult: null as any,
  deleteFails: null as { status: number; error: string } | null,
  microdeposits: { pending: false } as any,
  verifyResult: null as any,
  /** Play the server's S622 refusal: money toward an old balance while another
   *  of the same landlord's leases still owes a current bill. */
  s622: false,
  claimed: new Set<string>(),
  /** The bill cannot be read (the connection is down). */
  balanceFails: false,
  /** What a charge that goes through answers with. */
  payStatus: 'processing' as string,
  /** The server's bank fee on a quote (0 = the landlord covers bank fees). */
  achFee: 6,
  /** A tenant-payer platform fee the server adds on top of every quote with money in it. */
  passthrough: 0,
  /** How many quote requests fail next (the connection drops). */
  quoteFails: 0,
  /** Card quotes wait on this gate until a test opens it. */
  cardQuoteGate: null as Promise<void> | null,
  runCreditWaiting: 0 as number,
  /** decisions.md #48.4: extra fields a charge answers with (clientSecret, paymentIntentId). */
  payData: {} as any,
  /** POST /payments/pay-balance/release answers this outcome; null = the request fails. */
  releaseOutcome: 'released' as string | null,
  /** POST /payments/pay-balance/release says the card's bank declined the payment itself. */
  releaseDeclined: false,
  /** When set, POST /payments/pay-balance/release answers only once this settles (the button's working label). */
  releaseGate: null as Promise<void> | null,
  /** POST /payments/pay-balance/resume answers this. */
  resumeData: null as any,
  /** POST /payments/pay-balance/release and /resume fail with this (an HTTP error, or a dropped connection). */
  awaitingError: null as any,
}))

const httpError = (status: number, error: string) =>
  Object.assign(new Error(error), { response: { status, data: { success: false, error } } })

vi.mock('../lib/api', () => ({
  apiGet: async (url: string) => {
    if (url === '/payments/balance-context') {
      if (server.balanceFails) throw new Error('Network Error')
      return server.balance
    }
    if (url === '/stripe/tenant/microdeposits') return server.microdeposits
    if (url === '/stripe/tenant/payment-methods') return []
    throw new Error(`unexpected GET ${url}`)
  },
  apiPost: async (url: string, body: any) => {
    server.posts.push({ url, body })
    if (url === '/payments/quote' && body.runLeaseIds) {
      // The run's one held-credit figure for bills that are not balance-context's run.
      return { success: true, data: { runLeaseIds: body.runLeaseIds, runCreditWaiting: server.runCreditWaiting ?? 0, runCreditWaitingNote: null } }
    }
    if (url === '/payments/quote') {
      if (server.quoteFails > 0) { server.quoteFails--; throw new Error('Network Error') }
      if (body.method === 'card' && server.cardQuoteGate) await server.cardQuoteGate
      const base = body.useCredit ? (body.leaseId === 'L2' ? 0 : 450) : body.amount
      // The shared table: a bank payment is a flat $6; a card is 3.5% + $0.55.
      const fee = Math.round(((body.method === 'card' ? base * 0.035 + 0.55 : server.achFee)
        + (base > 0 ? server.passthrough : 0)) * 100) / 100
      return { success: true, data: { base, fee, total: Math.round((base + fee) * 100) / 100, method: body.method, intlCardSurcharge: false } }
    }
    if (url === '/payments/pay-balance') {
      const fail = server.payFails.shift()
      // status 0: the answer never arrived (the request may still have landed).
      if (fail) { fail.then?.(); throw fail.status ? httpError(fail.status, fail.error) : new Error(fail.error) }
      if (server.s622) {
        const leases: any[] = server.balance?.leases ?? []
        const mine = leases.find((l) => l.leaseId === body.leaseId)
        if (mine && body.amount > mine.requiredNow + 0.005) {
          const other = leases.find((l) => l.leaseId !== mine.leaseId && l.landlordId === mine.landlordId
            && l.requiredNow > 0 && !server.claimed.has(l.leaseId))
          if (other) throw httpError(422, `Bring your other rent current first — ${other.unitNumber} still owes for this period.`)
        }
        server.claimed.add(body.leaseId)
      }
      return { success: true, data: { status: server.payStatus, ...server.payData } }
    }
    if ((url === '/payments/pay-balance/release' || url === '/payments/pay-balance/resume') && server.awaitingError) {
      throw server.awaitingError
    }
    if (url === '/payments/pay-balance/release') {
      if (server.releaseGate) await server.releaseGate
      if (server.releaseOutcome == null) throw httpError(502, 'Stripe did not answer')
      return { success: true, data: { outcome: server.releaseOutcome, declined: server.releaseDeclined } }
    }
    if (url === '/payments/pay-balance/resume') return { success: true, data: server.resumeData }
    if (url === '/stripe/tenant/microdeposits/verify') return server.verifyResult
    throw new Error(`unexpected POST ${url}`)
  },
  apiPatch: vi.fn(async () => ({})),
  apiDelete: async (url: string) => {
    server.deletes.push(url)
    if (server.deleteFails) throw httpError(server.deleteFails.status, server.deleteFails.error)
    return server.deleteResult
  },
}))

import { PayNowModal, AwaitingCardPayments, CARD_ALREADY_RELEASED_TEXT, SavedMethodsCard, VerifyMicrodepositsCard, OUTCOME_UNKNOWN_TEXT, LOST_ANSWER_WAIT, REQUIRES_ACTION_NEXT, paidText, readBalanceContext,
  CARD_CONFIRM, CARD_NOT_CONFIRMED_TEXT, CARD_CONFIRM_UNAVAILABLE_TEXT, CARD_RELEASE_LATER_TEXT, CARD_DECLINED_TEXT, CARD_DECLINED_LATER_TEXT,
  declinedByCardBankError, type SavedPaymentMethod } from './payShared'

const realHandleNextAction = CARD_CONFIRM.handleNextAction

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const bank: SavedPaymentMethod = {
  id: 'pm_bank', type: 'ach', bankName: 'Chase', last4: '1111', verified: true, verifying: false,
  verificationStep: null, chargeable: true, isDefault: true, canRemove: true, removeBlockedReason: null,
}
const lease = (over: any = {}) => ({
  leaseId: 'L1', propertyName: 'Oak Park', unitNumber: 'MH 09', paymentBlocked: false,
  outstanding: 500, carriedBalance: 0, requiredNow: 500,
  usableCredit: 50, creditOnFile: 50, payIfUsed: 450, payIfSaved: 500, coversWholeBill: false,
  scheduledRetries: [], suggestedPayAhead: 1200, ...over,
})

let host: HTMLDivElement
let root: Root
let qc: QueryClient
let onPaid: ReturnType<typeof vi.fn>
beforeEach(() => {
  server.posts = []
  server.payFails = []
  server.deletes = []
  server.deleteResult = null
  server.deleteFails = null
  server.microdeposits = { pending: false }
  server.verifyResult = null
  server.s622 = false
  server.claimed = new Set()
  server.balanceFails = false
  server.payStatus = 'processing'
  server.achFee = 6
  server.passthrough = 0
  server.quoteFails = 0
  server.cardQuoteGate = null
  server.runCreditWaiting = 0
  server.payData = {}
  server.releaseOutcome = 'released'
  server.releaseDeclined = false
  server.releaseGate = null
  server.resumeData = null
  server.awaitingError = null
  CARD_CONFIRM.handleNextAction = realHandleNextAction
  // The wait after a lost answer, shortened (10 seconds on the real screen).
  LOST_ANSWER_WAIT.ms = 40
  onPaid = vi.fn()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.useRealTimers()
})
// A wait for the screen is bounded by UNTIL_MS of real time; a test may wait
// more than once, so its own limit is well above that.
vi.setConfig({ testTimeout: 30_000 })

async function render(ui: React.ReactNode) {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  await act(async () => { root.render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>) })
}
const text = () => host.textContent ?? ''
const buttons = () => [...host.querySelectorAll('button')]
const button = (label: string) => buttons().find((b) => b.textContent === label || b.getAttribute('aria-label') === label)
/**
 * Wait for the screen to show something. Bounded by real time (performance.now,
 * never faked), not by a count of steps: on a busy machine (suites run side by
 * side) each step takes longer, and a step count ran out before the screen had
 * finished — a flaky test, not a broken screen.
 */
const UNTIL_MS = 10_000
async function until(check: () => boolean, what: string) {
  const end = performance.now() + UNTIL_MS
  while (performance.now() < end) {
    if (check()) return
    await act(async () => { await new Promise((r) => setTimeout(r, 10)) })
  }
  if (check()) return
  throw new Error(`timed out waiting for ${what}\n${text()}`)
}
async function press(label: string) {
  await until(() => !!button(label) && !button(label)!.disabled, `an enabled "${label}" button`)
  await act(async () => { button(label)!.click() })
}
const times = (s: string) => text().split(s).length - 1
const pays = () => server.posts.filter((p) => p.url === '/payments/pay-balance').map((p) => p.body)

const singleTarget = {
  amount: 500, endpoint: '/payments/pay-balance', subheader: 'applied to your oldest balance first',
  kind: 'rent' as const, sendAmountInBody: true, leaseId: 'L1', suggestedPayAhead: 1200, requiredNow: 500,
}
const modal = (methods: SavedPaymentMethod[] = [bank], target: any = singleTarget) =>
  <PayNowModal target={target} methods={methods} onClose={() => {}} onAddMethod={() => {}} onPaid={onPaid} />

describe('the pay screen asks what to do with account credit', () => {
  it('shows the full bill and offers Use all / Save it for later, with nothing to pay until one is chosen', async () => {
    server.balance = { leases: [lease()] }
    await render(modal())
    await until(() => text().includes('You have $50.00 credit.'), 'the credit question')
    expect(text()).toContain('Your balance$500.00')
    expect(button('Use all $50.00 — pay $450.00')).toBeTruthy()
    expect(button('Save it for later — pay $500.00')).toBeTruthy()
    expect(buttons().some((b) => /^Pay \$/.test(b.textContent ?? ''))).toBe(false)
    expect(server.posts.filter((p) => p.url === '/payments/quote')).toEqual([])
  })

  it('Use all sends the answer with the credit figure shown and charges only the rest', async () => {
    server.balance = { leases: [lease()] }
    await render(modal())
    await press('Use all $50.00 — pay $450.00')
    await press('Pay $456.00')
    await until(() => pays().length === 1, 'the payment')
    expect(pays()[0]).toEqual({
      paymentMethodId: 'pm_bank', paymentMethodType: 'ach', amount: 450, leaseId: 'L1',
      useCredit: true, expectedCredit: 50,
    })
  })

  it('Save it for later charges the whole bill and still sends the figure it answered', async () => {
    server.balance = { leases: [lease()] }
    await render(modal())
    await press('Save it for later — pay $500.00')
    await press('Pay $506.00')
    await until(() => pays().length === 1, 'the payment')
    expect(pays()[0]).toMatchObject({ amount: 500, leaseId: 'L1', useCredit: false, expectedCredit: 50 })
  })

  it('Change backs out of the answer with nothing sent', async () => {
    server.balance = { leases: [lease()] }
    await render(modal())
    await press('Use all $50.00 — pay $450.00')
    await press('Change')
    expect(button('Use all $50.00 — pay $450.00')).toBeTruthy()
    expect(pays()).toEqual([])
  })

  it('a credit that changed is a 409: the bill is read again and the question asked again in place, said once', async () => {
    server.balance = { leases: [lease()] }
    const moved = 'Your credit changed — it\'s now $30.00. Look at the bill again and choose how to pay.'
    server.payFails = [{ status: 409, error: moved, then: () => { server.balance = { leases: [lease({ usableCredit: 30, creditOnFile: 30, payIfUsed: 470 })] } } }]
    await render(modal())
    await press('Use all $50.00 — pay $450.00')
    await press('Pay $456.00')
    await until(() => !!button('Use all $30.00 — pay $470.00'), 'the question asked again with the new figure')
    expect(times(moved)).toBe(1)
    expect(text()).toContain('You have $30.00 credit.')
    expect(onPaid).not.toHaveBeenCalled()
    // Asked again, answered again: the new figure travels.
    await press('Use all $30.00 — pay $470.00')
    expect(text()).not.toContain(moved)
    await until(() => !!buttons().find((b) => /^Pay \$/.test(b.textContent ?? '') && !b.disabled), 'the Pay button')
    await act(async () => { buttons().find((b) => /^Pay \$/.test(b.textContent ?? ''))!.click() })
    await until(() => pays().length === 2, 'the second payment')
    expect(pays()[1]).toMatchObject({ useCredit: true, expectedCredit: 30, amount: 470 })
  })

  it('credit that appeared since the screen loaded is asked about, never spent unasked', async () => {
    server.balance = { leases: [lease({ usableCredit: 0, creditOnFile: 0, payIfUsed: 500 })] }
    const ask = 'You have $25.00 of account credit. Choose "Use all $25.00" or "Save it for later" before paying.'
    server.payFails = [{ status: 422, error: ask, then: () => { server.balance = { leases: [lease({ usableCredit: 25, creditOnFile: 25, payIfUsed: 475 })] } } }]
    await render(modal())
    await press('Pay $506.00')
    await until(() => !!button('Use all $25.00 — pay $475.00'), 'the credit question')
    expect(pays()[0]).not.toHaveProperty('useCredit')
    expect(times(ask)).toBe(1)
  })

  it('Pay with credit — nothing charged, no bank or card needed: no method is sent', async () => {
    server.balance = { leases: [lease({ usableCredit: 500, creditOnFile: 520, payIfUsed: 0, coversWholeBill: true })] }
    await render(modal([]))
    await until(() => text().includes('It covers this whole bill.'), 'the covered bill')
    expect(text()).toContain('You have $520.00 credit. $500.00 of it can pay this bill.')
    expect(text()).not.toContain('You don\'t have a payment method on file yet')
    await press('Pay with credit — nothing charged')
    await until(() => text().includes('Paid with your account credit — nothing was charged.'), 'the result')
    // No method fields at all: should the credit no longer cover the bill, the
    // refusal is the plain "Choose a saved bank account or card to pay with."
    expect(pays()).toEqual([{ amount: 0, leaseId: 'L1', useCredit: true, expectedCredit: 500 }])
  })

  // 10/4: credit an earlier bank payment still holds is left alone and the
  // rest of the bill is charged; the screen says so and pays the free figure.
  it('credit another bank payment still holds is said to be waiting, and Use all pays with only the free credit', async () => {
    server.balance = { leases: [lease({ usableCredit: 30, creditOnFile: 80, creditWaiting: 50, payIfUsed: 470 })] }
    await render(modal())
    await until(() => text().includes('set aside for an earlier bank payment'), 'the waiting sentence')
    expect(text()).toContain('$50.00 of your credit is set aside for an earlier bank payment that has not cleared yet. If that payment clears, the credit goes toward that earlier bill. If it does not, the credit comes back to your account.')
    expect(times('$50.00 of your credit is set aside for an earlier bank payment that has not cleared yet. If that payment clears, the credit goes toward that earlier bill. If it does not, the credit comes back to your account.')).toBe(1)
    await press('Use all $30.00 — pay $470.00')
    await until(() => !!buttons().find((b) => /^Pay \$/.test(b.textContent ?? '') && !b.disabled), 'the Pay button')
    await act(async () => { buttons().find((b) => /^Pay \$/.test(b.textContent ?? ''))!.click() })
    await until(() => pays().length === 1, 'the payment')
    expect(pays()[0]).toMatchObject({ useCredit: true, expectedCredit: 30, amount: 470 })
  })

  it('no credit: the old screen — the amount box, the method and the fee', async () => {
    server.balance = { leases: [lease({ usableCredit: 0, creditOnFile: 0, payIfUsed: 500 })] }
    await render(modal())
    await until(() => !!button('Pay $506.00'), 'the quoted Pay button')
    expect(text()).not.toContain('credit.')
    await press('Pay $506.00')
    await until(() => pays().length === 1, 'the payment')
    expect(pays()[0]).toEqual({ paymentMethodId: 'pm_bank', paymentMethodType: 'ach', amount: 500, leaseId: 'L1' })
  })

  it('with an old balance, Use all and Save are both this bill — the old balance is said before the choice', async () => {
    server.balance = { leases: [lease({ outstanding: 600, carriedBalance: 100, requiredNow: 500 })] }
    await render(modal([bank], { ...singleTarget, amount: 600 }))
    await until(() => text().includes('You have $50.00 credit.'), 'the credit question')
    expect(text()).toContain('Your balance$600.00')
    expect(button('Use all $50.00 — pay $450.00')).toBeTruthy()
    // The server's own payIfSaved: the bill, never the bill plus the old balance.
    expect(button('Save it for later — pay $500.00')).toBeTruthy()
    expect(times('Neither figure includes your earlier balance of $100.00')).toBe(1)
  })

  it('Save with an old balance: the box starts at the bill it named, and the old balance is one press away', async () => {
    server.balance = { leases: [lease({ outstanding: 600, carriedBalance: 100, requiredNow: 500 })] }
    await render(modal([bank], { ...singleTarget, amount: 600 }))
    await press('Save it for later — pay $500.00')
    await until(() => (host.querySelector('input[aria-label="Amount"]') as HTMLInputElement | null)?.value === '500.00', 'the box at the bill')
    expect(text()).toContain('The remaining $100.00 of your earlier balance stays on your account')
    await press('Just what I owe')
    expect((host.querySelector('input[aria-label="Amount"]') as HTMLInputElement).value).toBe('600.00')
    await press('Pay $606.00')
    await until(() => pays().length === 1, 'the payment')
    expect(pays()[0]).toMatchObject({ amount: 600, leaseId: 'L1', useCredit: false, expectedCredit: 50 })
  })

  it('a scheduled bank retry is named: paying now takes its place', async () => {
    server.balance = { leases: [lease({ usableCredit: 0, payIfUsed: 500, scheduledRetries: [{ nextRetryAt: '2026-10-08T12:00:00Z' }] })] }
    await render(modal())
    await until(() => text().includes('set to be tried again on Oct 8'), 'the retry note')
    expect(text()).toContain('Paying now takes its place')
  })
})

describe('Pay all splits the credit lease by lease', () => {
  const batchTarget = {
    amount: 800, endpoint: '/payments/pay-balance', subheader: 'across your 2 leases', kind: 'rent' as const,
    batch: [{ leaseId: 'L1', amount: 500 }, { leaseId: 'L2', amount: 300 }],
  }
  it('Use all: each lease carries its own share, and a lease the credit covers is sent at $0', async () => {
    server.balance = { leases: [
      lease(),
      lease({ leaseId: 'L2', outstanding: 300, requiredNow: 300, usableCredit: 300, creditOnFile: 350, payIfUsed: 0, payIfSaved: 300, coversWholeBill: true }),
    ] }
    await render(modal([bank], batchTarget))
    await press('Use all $350.00 — pay $450.00')
    await press('Pay $456.00')
    await until(() => pays().length === 2, 'both leases')
    expect(pays().map((b) => [b.leaseId, b.amount, b.useCredit, b.expectedCredit])).toEqual([
      ['L1', 450, true, 50],
      ['L2', 0, true, 300],
    ])
    await until(() => onPaid.mock.calls.length === 1, 'the modal to finish')
  })

  it('a lease paid before a refusal drops off, and the rest is offered again in place', async () => {
    server.balance = { leases: [lease({ usableCredit: 0, payIfUsed: 500 }), lease({ leaseId: 'L2', outstanding: 300, requiredNow: 300, usableCredit: 0, payIfUsed: 300, payIfSaved: 300 })] }
    // L1 goes through; L2 is refused because its bill moved.
    server.payFails = []
    let calls = 0
    const realPush = server.posts.push.bind(server.posts)
    server.posts.push = (x: any) => {
      if (x.url === '/payments/pay-balance' && ++calls === 2) {
        server.payFails.push({ status: 409, error: 'Nothing outstanding to pay', then: () => {} })
        server.balance = { leases: [lease({ outstanding: 0, requiredNow: 0, usableCredit: 0, payIfUsed: 0, payIfSaved: 0 }),
          lease({ leaseId: 'L2', outstanding: 340, requiredNow: 340, usableCredit: 0, payIfUsed: 340, payIfSaved: 340 })] }
      }
      return realPush(x)
    }
    await render(modal([bank], batchTarget))
    await press('Pay $812.00')
    await until(() => text().includes('1 of 2 paid. Nothing outstanding to pay'), 'the partial result')
    await until(() => !!button('Pay $346.00'), 'the rest offered again')
    expect(onPaid).not.toHaveBeenCalled()
    expect(times('1 of 2 paid.')).toBe(1)
  })
})

// 10/4: the old lease's bank retry holds $50 of an $80 credit that moved to
// the renewal. Charged alone the renewal can use $30; in "Pay all" the old
// lease goes first, replacing its retry, so the renewal's charge finds $80.
// The run is sent those figures (balance-context payAll), quoted the same way.
describe('Pay all with Use all sends each lease the figure its charge will find', () => {
  const run = { order: ['L1', 'L2'] }
  const balance = () => ({ leases: [
    lease({ leaseId: 'L2', unitNumber: 'MH 09', outstanding: 480, requiredNow: 480, usableCredit: 30, creditOnFile: 80,
      creditWaiting: 50, creditWaitingNote: 'The server sentence.', payIfUsed: 450, payIfSaved: 480,
      payAll: { ...run, usableCredit: 80, payIfUsed: 400, coversWholeBill: false, creditWaiting: 0, creditWaitingNote: null } }),
    lease({ leaseId: 'L1', unitNumber: 'MH 09', outstanding: 460, requiredNow: 460, usableCredit: 0, creditOnFile: 80,
      payIfUsed: 460, payIfSaved: 460, scheduledRetries: [{ nextRetryAt: '2026-10-08T12:00:00Z' }],
      payAll: { ...run, usableCredit: 0, payIfUsed: 460, coversWholeBill: false, creditWaiting: 0, creditWaitingNote: null } }),
  ] })
  const target = {
    amount: 940, endpoint: '/payments/pay-balance', subheader: 'across your 2 leases', kind: 'rent' as const,
    batch: [{ leaseId: 'L2', amount: 480 }, { leaseId: 'L1', amount: 460 }],
  }
  it('the old lease first, then the renewal with all $80 — one run, no "Your credit changed", and each line quoted as it will be charged', async () => {
    server.balance = balance()
    await render(modal([bank], target))
    await press('Use all $80.00 — pay $860.00')
    // The renewal's credit is not waiting in this run: the run's own first charge frees it.
    expect(text()).not.toContain('The server sentence.')
    await until(() => !!buttons().find((b) => /^Pay \$/.test(b.textContent ?? '') && !b.disabled), 'the Pay button')
    const quotes = server.posts.filter((p) => p.url === '/payments/quote').map((p) => p.body)
    expect(quotes.find((q) => q.leaseId === 'L2' && q.method === 'ach')).toMatchObject({ amount: 400, useCredit: true, afterLeaseIds: ['L1'] })
    expect(quotes.find((q) => q.leaseId === 'L1' && q.method === 'ach')?.afterLeaseIds).toBeUndefined()
    await act(async () => { buttons().find((b) => /^Pay \$/.test(b.textContent ?? ''))!.click() })
    await until(() => pays().length === 2, 'both leases')
    expect(pays().map((b) => [b.leaseId, b.amount, b.useCredit, b.expectedCredit])).toEqual([
      ['L1', 460, false, 0],
      ['L2', 400, true, 80],
    ])
    await until(() => onPaid.mock.calls.length === 1, 'the modal to finish')
  })

  it('the renewal alone says why only $30 of the $80 can pay it, in the server\'s words', async () => {
    server.balance = balance()
    await render(modal([bank], { ...singleTarget, leaseId: 'L2', amount: 480, requiredNow: 480 }))
    await until(() => text().includes('The server sentence.'), 'the waiting sentence')
    expect(text()).toContain('You have $80.00 credit. $30.00 of it can pay this bill.')
    expect(times('The server sentence.')).toBe(1)
  })
})

// Fix pass 2: a paused lease's bank retry holds the whole $50 credit. Each of
// the two other bills could use those same $50, so adding the bills up said
// "$100.00 set aside" with $50.00 on file. The run's one figure is said once.
describe('Pay all says credit a paused lease\'s retry holds once', () => {
  const WAITING_50 = '$50.00 of your credit is set aside for an earlier bank payment that has not cleared yet. If that payment clears, the credit goes toward that earlier bill. If it does not, the credit comes back to your account.'
  const run = { order: ['L1', 'L2'], runCreditWaiting: 50, runCreditWaitingNote: WAITING_50 }
  const target = {
    amount: 400, endpoint: '/payments/pay-balance', subheader: 'across your 2 leases', kind: 'rent' as const,
    batch: [{ leaseId: 'L1', amount: 200 }, { leaseId: 'L2', amount: 200 }],
  }
  it('the sentence names $50.00 once, never $100.00', async () => {
    server.balance = { leases: ['L1', 'L2'].map((id) => lease({
      leaseId: id, landlordId: 'LL1', unitNumber: id, outstanding: 200, requiredNow: 200, usableCredit: 0, creditOnFile: 50,
      creditWaiting: 50, creditWaitingNote: WAITING_50, payIfUsed: 200, payIfSaved: 200,
      payAll: { ...run, usableCredit: 0, payIfUsed: 200, coversWholeBill: false, creditWaiting: 50, creditWaitingNote: WAITING_50 },
    })) }
    await render(modal([bank], target))
    await until(() => text().includes('set aside for an earlier bank payment'), 'the waiting sentence')
    expect(times(WAITING_50)).toBe(1)
    expect(text()).not.toContain('$100.00 of your credit')
  })
})

// Fix pass 3: every dollar of the credit on file is explained on one bill.
describe('where the rest of the credit goes', () => {
  const REST = '$20.00 of your credit is kept for a bill on another lease.'
  it('one bill: the rest sentence is said beside "You have $X credit", once', async () => {
    server.balance = { leases: [lease({ usableCredit: 30, creditOnFile: 100, creditWaiting: 50, creditWaitingNote: 'The server sentence.',
      creditRestNote: REST, payIfUsed: 470 })] }
    await render(modal())
    await until(() => text().includes(REST), 'the rest sentence')
    expect(text()).toContain(`You have $100.00 credit. $30.00 of it can pay this bill. ${REST}`)
    expect(times(REST)).toBe(1)
    expect(times('The server sentence.')).toBe(1)
  })

  it('no credit can pay this bill: the rest sentence is said on its own', async () => {
    server.balance = { leases: [lease({ usableCredit: 0, creditOnFile: 20, payIfUsed: 500, creditRestNote: REST })] }
    await render(modal())
    await until(() => text().includes(REST), 'the rest sentence')
    expect(times(REST)).toBe(1)
    expect(text()).not.toContain('Use all')
  })
})

// Fix pass 3: bills paid together that are not balance-context's run (no
// payAll figures) used to say only the largest bill's held figure; two holds
// of $50, one per bill, read as $50. The page asks the server for the run.
describe('bills that are not the server\'s run ask the server for their held-credit figure', () => {
  const target = {
    amount: 400, endpoint: '/payments/pay-balance', subheader: 'across your 2 leases', kind: 'rent' as const,
    batch: [{ leaseId: 'L1', amount: 200 }, { leaseId: 'L2', amount: 200 }],
  }
  it('says the run figure the server worked out — $100.00, not the largest bill\'s $50.00', async () => {
    server.runCreditWaiting = 100
    server.balance = { leases: ['L1', 'L2'].map((id) => lease({
      leaseId: id, landlordId: 'LL1', unitNumber: id, outstanding: 200, requiredNow: 200, usableCredit: 0, creditOnFile: 100,
      creditWaiting: 50, payIfUsed: 200, payIfSaved: 200, payAll: null,
    })) }
    await render(modal([bank], target))
    await until(() => text().includes('$100.00 of your credit is set aside'), 'the run figure')
    expect(server.posts.filter((p) => p.body?.runLeaseIds)).toHaveLength(1)
    expect(server.posts.find((p) => p.body?.runLeaseIds)!.body).toEqual({ method: 'ach', runLeaseIds: ['L1', 'L2'] })
    expect(text()).not.toContain('$50.00 of your credit is set aside')
  })
})

describe('Pay all on two leases of one landlord, both with old balances (S622)', () => {
  const owing = (over: any = {}) => [
    lease({ leaseId: 'L1', landlordId: 'LL1', unitNumber: 'MH 01', outstanding: 600, requiredNow: 500, carriedBalance: 100,
      usableCredit: 0, creditOnFile: 0, payIfUsed: 500, payIfSaved: 500, ...over }),
    lease({ leaseId: 'L2', landlordId: 'LL1', unitNumber: 'MH 02', outstanding: 350, requiredNow: 300, carriedBalance: 50,
      usableCredit: 0, creditOnFile: 0, payIfUsed: 300, payIfSaved: 300 }),
  ]
  const target = {
    amount: 950, endpoint: '/payments/pay-balance', subheader: 'across your 2 leases', kind: 'rent' as const,
    batch: [{ leaseId: 'L1', amount: 600 }, { leaseId: 'L2', amount: 350 }],
  }

  it('no credit: each current bill is claimed first, one old balance rides the last charge, and the run goes through', async () => {
    server.s622 = true
    server.balance = { leases: owing() }
    await render(modal([bank], target))
    await until(() => text().includes('The earlier balance on MH 01 ($100.00) isn\'t in this payment'), 'the held-back note')
    await press('Pay $862.00')
    await until(() => text().includes('All 2 payments submitted.'), 'both payments')
    expect(pays().map((b) => [b.leaseId, b.amount])).toEqual([['L1', 500], ['L2', 350]])
    expect(text()).not.toContain('Bring your other rent current first')
  })

  it('Save it for later: the bills only, and the run goes through', async () => {
    server.s622 = true
    server.balance = { leases: owing({ usableCredit: 100, creditOnFile: 100, payIfUsed: 400 }) }
    await render(modal([bank], target))
    await until(() => text().includes('You have $100.00 credit.'), 'the credit question')
    expect(text()).toContain('Your balance$950.00')
    expect(button('Use all $100.00 — pay $700.00')).toBeTruthy()
    await press('Save it for later — pay $800.00')
    expect(times('Your earlier balance of $150.00 stays on your account — it isn\'t part of this payment.')).toBe(1)
    await press('Pay $812.00')
    await until(() => text().includes('All 2 payments submitted.'), 'both payments')
    expect(pays().map((b) => [b.leaseId, b.amount, b.useCredit, b.expectedCredit])).toEqual([
      ['L1', 500, false, 100],
      ['L2', 300, false, 0],
    ])
  })
})

describe('a refusal that leaves nothing payable here', () => {
  it('a lease whose payments became paused says so, with the refusal — never "nothing is owed"', async () => {
    server.balance = { leases: [lease({ usableCredit: 0, creditOnFile: 0, payIfUsed: 500 })] }
    const why = 'Payments on this lease are on hold. Contact your landlord.'
    server.payFails = [{ status: 409, error: why, then: () => { server.balance = { leases: [lease({ usableCredit: 0, creditOnFile: 0, payIfUsed: 500, paymentBlocked: true })] } } }]
    await render(modal())
    await press('Pay $506.00')
    await until(() => text().includes('Payments on this lease are paused. Contact your landlord.'), 'the paused line')
    expect(times(why)).toBe(1)
    expect(text()).not.toContain('Nothing is owed')
    expect(onPaid).not.toHaveBeenCalled()
  })

  it('a bill that dropped off still shows the reason it was refused, once', async () => {
    server.balance = { leases: [lease({ usableCredit: 0, creditOnFile: 0, payIfUsed: 500 })] }
    const why = 'Nothing outstanding to pay'
    server.payFails = [{ status: 409, error: why, then: () => { server.balance = { leases: [lease({ outstanding: 0, requiredNow: 0, usableCredit: 0, creditOnFile: 0, payIfUsed: 0, payIfSaved: 0 })] } } }]
    await render(modal())
    await press('Pay $506.00')
    await until(() => text().includes('Nothing is owed on this bill right now.'), 'the empty bill')
    expect(times(why)).toBe(1)
  })
})

describe('a payment whose answer was lost is never paid twice', () => {
  // S655 review: the charge went through but the answer never came back. The
  // server now holds the bill as processing and only the old balance is open;
  // a second press on the old figures would send the whole bill again and the
  // server would take it as the old balance plus paid-ahead money — a second
  // charge with a second fee.
  const afterCharge = () => lease({ outstanding: 100, carriedBalance: 100, requiredNow: 0,
    usableCredit: 0, creditOnFile: 50, payIfUsed: 0, payIfSaved: 0 })
  /**
   * The wait after a lost answer, ended by the test (endTheWait), not by the
   * machine's speed: fake timers that otherwise move with real time, so the
   * screen's own short waits still run.
   */
  const endWaitByHand = () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    LOST_ANSWER_WAIT.ms = 60_000
  }
  const endTheWait = async () => { await act(async () => { vi.advanceTimersByTime(LOST_ANSWER_WAIT.ms + 1) }) }

  it('the bill is read again before Pay can be pressed, and the screen offers only the old balance — never the $500 again', async () => {
    // The wait after the lost answer is ended by the test, never by the
    // machine's speed (it flaked on a busy machine with a real 40 ms wait).
    endWaitByHand()
    server.balance = { leases: [lease({ outstanding: 600, carriedBalance: 100, requiredNow: 500 })] }
    server.payFails = [{ status: 0, error: 'Network Error', then: () => { server.balance = { leases: [afterCharge()] } } }]
    await render(modal([bank], { ...singleTarget, amount: 600 }))
    await press('Save it for later — pay $500.00')
    await press('Pay $506.00')
    await until(() => text().includes(OUTCOME_UNKNOWN_TEXT), 'the unclear-outcome message')
    expect(times(OUTCOME_UNKNOWN_TEXT)).toBe(1)
    expect(text()).not.toContain('Network Error')
    await endTheWait()
    // The re-read bill: the old balance only, nothing else.
    await until(() => !!button('Pay $106.00'), 'the re-read bill offered')
    expect(buttons().some((b) => b.textContent === 'Pay $506.00')).toBe(false)
    expect((host.querySelector('input[aria-label="Amount"]') as HTMLInputElement).value).toBe('100.00')
    await press('Pay $106.00')
    await until(() => pays().length === 2, 'the second payment')
    expect(pays()[1]).toEqual({ paymentMethodId: 'pm_bank', paymentMethodType: 'ach', amount: 100, leaseId: 'L1' })
    expect(pays().filter((b) => b.amount === 500)).toHaveLength(1)
  })

  it('a server error after the charge is treated the same: the bill is read again first', async () => {
    endWaitByHand()
    server.balance = { leases: [lease({ usableCredit: 0, creditOnFile: 0, payIfUsed: 500 })] }
    server.payFails = [{ status: 502, error: 'Bad gateway', then: () => {
      server.balance = { leases: [lease({ outstanding: 0, requiredNow: 0, usableCredit: 0, creditOnFile: 0, payIfUsed: 0, payIfSaved: 0 })] }
    } }]
    await render(modal())
    await press('Pay $506.00')
    await until(() => text().includes(OUTCOME_UNKNOWN_TEXT), 'the unclear-outcome message')
    await endTheWait()
    await until(() => text().includes('Nothing is owed on this bill right now.'), 'the re-read bill')
    expect(times(OUTCOME_UNKNOWN_TEXT)).toBe(1)
    expect(buttons().some((b) => /^Pay \$/.test(b.textContent ?? ''))).toBe(false)
    expect(pays()).toHaveLength(1)
  })

  it('a bill that cannot be read again keeps Pay off until Check again reads it', async () => {
    endWaitByHand()
    server.balance = { leases: [lease({ usableCredit: 0, creditOnFile: 0, payIfUsed: 500 })] }
    server.payFails = [{ status: 0, error: 'Network Error', then: () => { server.balanceFails = true } }]
    await render(modal())
    await press('Pay $506.00')
    await until(() => text().includes(OUTCOME_UNKNOWN_TEXT), 'the unclear-outcome message')
    await endTheWait()
    await until(() => text().includes("We couldn't read your bill just now."), 'the re-read failure')
    const pay = () => buttons().find((b) => /^Pay \$/.test(b.textContent ?? ''))
    expect(pay()?.disabled).toBe(true)
    // The connection is back: the charge had gone through, only the old balance is open.
    server.balanceFails = false
    server.balance = { leases: [afterCharge()] }
    await press('Check again')
    await until(() => !!button('Pay $106.00') && !button('Pay $106.00')!.disabled, 'the bill read again')
    expect(text()).not.toContain('read your bill just now')
    expect(pays()).toHaveLength(1)
  })

  it('a card declined is read again too, and the answer is asked again before anything is sent', async () => {
    server.balance = { leases: [lease()] }
    const declined = 'Your card was declined.'
    server.payFails = [{ status: 402, error: declined }]
    await render(modal())
    await press('Use all $50.00 — pay $450.00')
    await press('Pay $456.00')
    await until(() => text().includes(declined), 'the decline')
    expect(times(declined)).toBe(1)
    await until(() => !!button('Use all $50.00 — pay $450.00'), 'the question asked again')
    expect(pays()).toHaveLength(1)
  })

  it('a bill read while the lost charge may still be landing never unlocks Pay — only a read after the wait does, and it names what is clearing', async () => {
    // The bill read takes no household lock: a read answered while the first
    // charge is still being written shows the bill as it was. Pressing Pay on
    // that would charge the $500 again, and the server would take it as the
    // old balance plus paid-ahead credit — a second charge with a second fee.
    // The wait is ended by the test, not by the machine's speed: the clock
    // only jumps past it when the test says so (fake timers that otherwise
    // move with real time, so the screen's own short waits still run).
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    LOST_ANSWER_WAIT.ms = 60_000
    const before = lease({ outstanding: 600, carriedBalance: 100, requiredNow: 500,
      usableCredit: 0, creditOnFile: 0, payIfUsed: 500, payIfSaved: 500 })
    server.balance = { leases: [before] }
    server.payFails = [{ status: 0, error: 'Network Error' }]
    await render(modal([bank], { ...singleTarget, amount: 600 }))
    await press('Pay $606.00')
    await until(() => text().includes(OUTCOME_UNKNOWN_TEXT), 'the unclear-outcome message')
    // A read lands before the first charge's write has finished: the old bill.
    await act(async () => { await qc.refetchQueries('balance-context') })
    expect(text()).toContain('Checking whether that payment went through…')
    expect(buttons().filter((b) => /^Pay \$/.test(b.textContent ?? '')).every((b) => b.disabled)).toBe(true)
    // The first charge's write finishes: its $500 is processing, the old balance is open.
    server.balance = { leases: [lease({ outstanding: 100, carriedBalance: 100, requiredNow: 0,
      usableCredit: 0, creditOnFile: 0, payIfUsed: 0, payIfSaved: 0, clearing: 500 })] }
    // Still inside the wait: Pay stays off.
    expect(buttons().filter((b) => /^Pay \$/.test(b.textContent ?? '')).every((b) => b.disabled)).toBe(true)
    // The wait ends.
    await act(async () => { vi.advanceTimersByTime(60_000) })
    await until(() => !!button('Pay $106.00') && !button('Pay $106.00')!.disabled, 'the bill read after the wait')
    expect(times('$500.00 already paid on this bill is still clearing — it isn\'t owed again.')).toBe(1)
    expect(text()).not.toContain('Checking whether that payment went through')
    expect(pays()).toHaveLength(1)
  })

  it('a read that started during the wait never unlocks Pay, even when it lands after it — only one that started after', async () => {
    // A refetch on focus can leave during the wait and land after it, with the
    // timer's own read failing: it shows the bill from before the lost charge.
    const before = lease({ usableCredit: 0, creditOnFile: 0, payIfUsed: 500 })
    server.balance = { leases: [before] }
    server.payFails = [{ status: 0, error: 'Network Error', then: () => { server.balanceFails = true } }]
    await render(modal())
    const pressedAt = Date.now()
    await press('Pay $506.00')
    await until(() => text().includes('We couldn’t read your bill just now') || text().includes("We couldn't read your bill just now"), 'the failed re-read')
    // The read that left before the wait was over lands now.
    await act(async () => { qc.setQueryData('balance-context', { leases: [before], readStartedAt: pressedAt }) })
    expect(buttons().filter((b) => /^Pay \$/.test(b.textContent ?? '')).every((b) => b.disabled)).toBe(true)
    // A read that starts now unlocks it.
    server.balanceFails = false
    server.balance = { leases: [lease({ outstanding: 0, requiredNow: 0, usableCredit: 0, creditOnFile: 0, payIfUsed: 0, payIfSaved: 0, clearing: 500 })] }
    await press('Check again')
    await until(() => text().includes('Nothing is owed on this bill right now.'), 'the bill read after the wait')
    expect(pays()).toHaveLength(1)
  })

  it('every bill read is stamped with the moment it started', async () => {
    server.balance = { leases: [lease()] }
    const t0 = Date.now()
    const read = await readBalanceContext<any>()
    expect(read.leases).toHaveLength(1)
    expect(read.readStartedAt).toBeGreaterThanOrEqual(t0)
    expect(read.readStartedAt).toBeLessThanOrEqual(Date.now())
  })

  it('a bill with nothing left after a lost answer still says what is clearing', async () => {
    server.balance = { leases: [lease({ usableCredit: 0, creditOnFile: 0, payIfUsed: 500 })] }
    server.payFails = [{ status: 0, error: 'Network Error', then: () => {
      server.balance = { leases: [lease({ outstanding: 0, requiredNow: 0, usableCredit: 0, creditOnFile: 0, payIfUsed: 0, payIfSaved: 0, clearing: 500 })] }
    } }]
    await render(modal())
    await press('Pay $506.00')
    await until(() => text().includes('Nothing is owed on this bill right now.'), 'the re-read bill')
    expect(times('$500.00 already paid on this bill is still clearing — it isn\'t owed again.')).toBe(1)
    expect(buttons().some((b) => /^Pay \$/.test(b.textContent ?? ''))).toBe(false)
  })
})

describe('what the screen says once a payment is sent — plain words, never a status value', () => {
  const STATUSES = ['processing', 'requires_action', 'requires_payment_method', 'requires_capture', 'canceled', 'succeeded']

  it('no outcome is ever printed as the processor\'s status value', () => {
    for (const type of ['card', 'ach'] as const) {
      for (const s of STATUSES) {
        const said = paidText(type, [s])
        // "processing" is a plain word and may be said as one; the rest are
        // the processor's own values and never appear.
        if (s !== 'processing') expect(said).not.toContain(s)
        expect(said).not.toContain('_')
        expect(said.toLowerCase()).not.toContain('status')
      }
    }
  })

  it('a card still processing, and a card its bank wants confirmed, are each said plainly', () => {
    expect(paidText('card', ['processing'])).toBe('Your card payment is processing. We’ll email your receipt when it goes through.')
    expect(paidText('card', ['requires_action'])).toBe(`Your card’s bank wants to confirm this payment before it goes through — nothing has been charged for it yet. ${REQUIRES_ACTION_NEXT}`)
    expect(paidText('card', ['succeeded'])).toBe('Card charged. Receipt emailed.')
    expect(paidText('ach', ['processing'])).toBe('Payment submitted. ACH typically settles in 3–5 business days.')
  })

  it('Pay all with a lease the credit paid in full says so, never that every lease was charged', () => {
    expect(paidText('card', ['succeeded', 'succeeded'], 1))
      .toBe('All 2 leases charged. Receipts emailed. One lease was paid with your account credit — nothing charged on it.')
    expect(paidText('ach', [], 2)).toBe('Paid with your account credit — nothing was charged.')
  })

  it('a card payment still processing on the pay screen is said in plain words', async () => {
    const card: SavedPaymentMethod = {
      id: 'pm_card', type: 'card', brand: 'visa', last4: '4242', expMonth: 1, expYear: 2030, country: 'US',
      verified: true, verifying: false, verificationStep: null, chargeable: true, isDefault: true, canRemove: true, removeBlockedReason: null,
    }
    server.payStatus = 'processing'
    server.balance = { leases: [lease({ usableCredit: 0, creditOnFile: 0, payIfUsed: 500 })] }
    await render(modal([card]))
    await press('Pay $518.05')
    await until(() => text().includes('Your card payment is processing.'), 'the result')
    expect(text()).not.toContain('Card status')
  })

  // decisions.md #48.4: renamed — the bank's window is normally shown on the
  // spot (below). With no confirmation details to show it, the screen says to
  // confirm from the Payments page within the 30-minute hold.
  it('a card its bank wants confirmed with no bank window to show: the screen stays open on what to do next, and Close is the one way out', async () => {
    const card: SavedPaymentMethod = {
      id: 'pm_card', type: 'card', brand: 'visa', last4: '4242', expMonth: 1, expYear: 2030, country: 'US',
      verified: true, verifying: false, verificationStep: null, chargeable: true, isDefault: true, canRemove: true, removeBlockedReason: null,
    }
    server.payStatus = 'requires_action'
    server.balance = { leases: [lease({ usableCredit: 0, creditOnFile: 0, payIfUsed: 500 })] }
    await render(modal([card]))
    await press('Pay $518.05')
    await until(() => text().includes('nothing has been charged for it yet'), 'the result')
    expect(times(REQUIRES_ACTION_NEXT)).toBe(1)
    expect(text()).not.toContain('✓ Submitted')
    // It does not close by itself (a charged payment closes after 1.5 s).
    await act(async () => { await new Promise((r) => setTimeout(r, 1700)) })
    expect(onPaid).not.toHaveBeenCalled()
    await press('Close')
    expect(onPaid).toHaveBeenCalledTimes(1)
  })
})

describe('the card fee line says only what is true', () => {
  const card: SavedPaymentMethod = {
    id: 'pm_card', type: 'card', brand: 'visa', last4: '4242', expMonth: 1, expYear: 2030, country: 'US',
    verified: true, verifying: false, verificationStep: null, chargeable: true, isDefault: true, canRemove: true, removeBlockedReason: null,
  }

  it('a card fee above the bank fee says to pay by bank — and never that GAM doesn\'t profit from it', async () => {
    server.balance = { leases: [lease({ usableCredit: 0, creditOnFile: 0, payIfUsed: 500 })] }
    await render(modal([card]))
    await until(() => text().includes('Card processing fee'), 'the card quote')
    expect(text()).toContain('$18.05')
    expect(times('Pay by bank to lower the fee.')).toBe(1)
    expect(text()).not.toContain('profit')
  })

  it('a landlord who covers bank fees: the bank is $0, so a card fee says to pay by bank — the server\'s bank figure, asked for the same charge', async () => {
    server.achFee = 0
    server.balance = { leases: [lease({ outstanding: 100, requiredNow: 100, usableCredit: 0, creditOnFile: 0, payIfUsed: 100, payIfSaved: 100, suggestedPayAhead: 400 })] }
    await render(modal([card], { ...singleTarget, amount: 100, requiredNow: 100, suggestedPayAhead: 400 }))
    await until(() => text().includes('Card processing fee'), 'the card quote')
    expect(times('Pay by bank to lower the fee.')).toBe(1)
    const quotes = server.posts.filter((p) => p.url === '/payments/quote').map((p) => [p.body.method, p.body.amount, p.body.leaseId])
    expect(quotes).toContainEqual(['card', 100, 'L1'])
    expect(quotes).toContainEqual(['ach', 100, 'L1'])
  })

  it('a tenant-payer platform fee on a small bill: the bank costs more than the card, so it never says to pay by bank', async () => {
    // $100: card $3.50 + $0.55 + $3.00 = $7.05; bank $6.00 + $3.00 = $9.00.
    // The shared list price ($6) would have said the bank was cheaper.
    server.passthrough = 3
    server.balance = { leases: [lease({ outstanding: 100, requiredNow: 100, usableCredit: 0, creditOnFile: 0, payIfUsed: 100, payIfSaved: 100, suggestedPayAhead: 400 })] }
    await render(modal([card], { ...singleTarget, amount: 100, requiredNow: 100, suggestedPayAhead: 400 }))
    await until(() => text().includes('Card processing fee'), 'the card quote')
    expect(text()).toContain('$7.05')
    expect(text()).not.toContain('Pay by bank to lower the fee.')
  })

  it('on a small bill, where the card fee is below the flat bank fee, it never says the bank is cheaper', async () => {
    server.balance = { leases: [lease({ outstanding: 100, requiredNow: 100, usableCredit: 0, creditOnFile: 0, payIfUsed: 100, payIfSaved: 100, suggestedPayAhead: 400 })] }
    await render(modal([card], { ...singleTarget, amount: 100, requiredNow: 100, suggestedPayAhead: 400 }))
    await until(() => text().includes('Card processing fee'), 'the card quote')
    expect(text()).toContain('$4.05')
    expect(text()).not.toContain('Pay by bank to lower the fee.')
    expect(text()).not.toContain('profit')
  })
})

describe('Pay charges only the fee on screen, for the way chosen', () => {
  const card: SavedPaymentMethod = {
    id: 'pm_card', type: 'card', brand: 'visa', last4: '4242', expMonth: 1, expYear: 2030, country: 'US',
    verified: true, verifying: false, verificationStep: null, chargeable: true, isDefault: false, canRemove: true, removeBlockedReason: null,
  }
  const noCredit = () => ({ leases: [lease({ usableCredit: 0, creditOnFile: 0, payIfUsed: 500 })] })
  const payButton = () => buttons().find((b) => /^(Pay|Pay \$.*)$/.test(b.textContent ?? ''))
  const pickCard = async () => {
    const radio = [...host.querySelectorAll('input[type="radio"]')]
      .find((r) => r.closest('label')?.textContent?.includes('VISA')) as HTMLInputElement
    await act(async () => { radio.click() })
  }

  it('a quote that fails keeps Pay off, says so once, and Try again asks again', async () => {
    server.quoteFails = 1
    server.balance = noCredit()
    await render(modal())
    await until(() => text().includes("We couldn't work out the fee just now"), 'the failed quote')
    expect(times('work out the fee just now')).toBe(1)
    expect(payButton()!.textContent).toBe('Pay')
    expect(payButton()!.disabled).toBe(true)
    expect(text()).not.toContain('be charged')
    await act(async () => { payButton()!.click() })
    expect(pays()).toEqual([])
    await press('Try again')
    await until(() => !!button('Pay $506.00'), 'the quote asked again')
    expect(text()).not.toContain('work out the fee just now')
    await press('Pay $506.00')
    await until(() => pays().length === 1, 'the payment')
  })

  it('switching from bank to card keeps Pay off until the card quote lands, and never shows the bank figure under the card', async () => {
    server.balance = noCredit()
    await render(modal([bank, card]))
    await until(() => !!button('Pay $506.00'), 'the bank quote')
    let open!: () => void
    server.cardQuoteGate = new Promise<void>((r) => { open = r })
    await pickCard()
    // The bank quote is gone the moment the card is chosen.
    expect(text()).not.toContain('Bank (ACH) fee')
    expect(text()).not.toContain('$506.00')
    expect(text()).toContain('Working out the fee…')
    expect(payButton()!.textContent).toBe('Pay')
    expect(payButton()!.disabled).toBe(true)
    await act(async () => { payButton()!.click() })
    expect(pays()).toEqual([])
    await act(async () => { open() })
    await until(() => !!button('Pay $518.05'), 'the card quote')
    expect(text()).toContain('Card processing fee')
    await press('Pay $518.05')
    await until(() => pays().length === 1, 'the payment')
    expect(pays()[0]).toMatchObject({ paymentMethodType: 'card', amount: 500 })
  })

  it('a typed amount drops the old quote: Pay waits for the new figure', async () => {
    server.balance = noCredit()
    await render(modal([card]))
    await until(() => !!button('Pay $518.05'), 'the card quote')
    let open!: () => void
    server.cardQuoteGate = new Promise<void>((r) => { open = r })
    const input = host.querySelector('input[aria-label="Amount"]') as HTMLInputElement
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      set.call(input, '1000')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(text()).not.toContain('$518.05')
    expect(payButton()!.textContent).toBe('Pay')
    expect(payButton()!.disabled).toBe(true)
    await act(async () => { open() })
    // $1,000 by card: 3.5% + $0.55 = $35.55.
    await until(() => !!button('Pay $1,035.55'), 'the new quote')
    await press('Pay $1,035.55')
    await until(() => pays().length === 1, 'the payment')
    expect(pays()[0]).toMatchObject({ paymentMethodType: 'card', amount: 1000 })
  })

  it('the screen names no list-price fee of its own — every figure is the server\'s quote', async () => {
    server.achFee = 0
    server.balance = noCredit()
    await render(modal())
    await until(() => !!button('Pay $500.00'), 'the quote')
    expect(text()).toContain('Bank (ACH) fee — covered by your landlord')
    expect(text()).not.toContain('$6.00 flat')
    expect(text()).not.toContain('card fees are usually higher')
    expect(text()).toContain('Bank and card fees are shown before you pay')
  })
})

describe('a bank still verifying: the note matches its step', () => {
  const card: SavedPaymentMethod = {
    id: 'pm_card', type: 'card', brand: 'visa', last4: '4242', expMonth: 1, expYear: 2030, country: 'US',
    verified: true, verifying: false, verificationStep: null, chargeable: true, isDefault: true, canRemove: true, removeBlockedReason: null,
  }
  const pending = (step: 'deposits' | 'checking'): SavedPaymentMethod => ({
    id: `pm_${step}`, type: 'ach', bankName: 'Wells Fargo', last4: '2222', verified: false, verifying: true,
    verificationStep: step, chargeable: false, isDefault: false, canRemove: true, removeBlockedReason: null,
  })

  it('being checked: nothing more to do — never "confirm the small deposit"', async () => {
    server.balance = { leases: [lease({ usableCredit: 0, creditOnFile: 0, payIfUsed: 500 })] }
    await render(modal([pending('checking'), card]))
    await until(() => text().includes('Being checked'), 'the badge')
    expect(times('Your bank is being checked — nothing more to do; you can pay by card in the meantime.')).toBe(1)
    expect(text()).not.toContain('confirm the small deposit')
  })

  it('waiting on the deposits: confirm the small deposit', async () => {
    server.balance = { leases: [lease({ usableCredit: 0, creditOnFile: 0, payIfUsed: 500 })] }
    await render(modal([pending('deposits'), card]))
    await until(() => text().includes('Pending verification'), 'the badge')
    expect(text()).toContain('confirm the small deposit we sent to it')
    expect(text()).not.toContain('Your bank is being checked')
  })
})

describe('saved methods: every bank, and Remove that says why first', () => {
  const only: SavedPaymentMethod = {
    ...bank, canRemove: false,
    removeBlockedReason: 'This is your only verified bank, and you still owe a balance. Add and verify another bank first, or pay what you owe, then you can remove this one.',
  }
  const waiting: SavedPaymentMethod = {
    id: 'pm_new', type: 'ach', bankName: 'Wells Fargo', last4: '2222', verified: false, verifying: true,
    verificationStep: 'deposits', chargeable: false, isDefault: false, canRemove: true, removeBlockedReason: null,
  }
  const card: SavedPaymentMethod = {
    id: 'pm_card', type: 'card', brand: 'visa', last4: '4242', expMonth: 1, expYear: 2030, country: 'US',
    verified: true, verifying: false, verificationStep: null, chargeable: true, isDefault: false, canRemove: true, removeBlockedReason: null,
  }

  it('lists every bank with where it stands, and offers default only for a method that can be charged', async () => {
    // A verified bank whose bank payments are paused cannot be charged, so it
    // is never offered as the default (autopay on "my default" would point at it).
    const paused: SavedPaymentMethod = {
      id: 'pm_paused', type: 'ach', bankName: 'US Bank', last4: '3333', verified: true, verifying: false,
      verificationStep: null, chargeable: false, isDefault: false, canRemove: true, removeBlockedReason: null,
    }
    await render(<SavedMethodsCard methods={[only, waiting, paused, card]} loading={false} />)
    expect(text()).toContain('Chase ····1111')
    expect(text()).toContain('Wells Fargo ····2222')
    expect(text()).toContain('Waiting on your deposits')
    expect(text()).toContain('Bank payments paused')
    expect(button('Make Wells Fargo ····2222 my default')).toBeUndefined()
    expect(button('Make US Bank ····3333 my default')).toBeUndefined()
    expect(button('Make VISA ····4242 my default')).toBeTruthy()
    expect(text()).toContain('Adding a bank keeps the ones you have until you remove them')
  })

  it('the only verified bank: Remove shows the guard text and sends nothing', async () => {
    await render(<SavedMethodsCard methods={[only, waiting, card]} loading={false} />)
    await press('Remove Chase ····1111')
    expect(times(only.removeBlockedReason!)).toBe(1)
    expect(server.deletes).toEqual([])
  })

  it('a bank that may go: asked once in place, then removed and the list shown as the server left it', async () => {
    server.deleteResult = { removedId: 'pm_new', methods: [only, card] }
    await render(<SavedMethodsCard methods={[only, waiting, card]} loading={false} />)
    await press('Remove Wells Fargo ····2222')
    expect(text()).toContain('Remove Wells Fargo ····2222? You can add it again later.')
    await press('Keep it')
    expect(text()).not.toContain('You can add it again later.')
    expect(server.deletes).toEqual([])
    await press('Remove Wells Fargo ····2222')
    await press('Yes, remove Wells Fargo ····2222')
    await until(() => text().includes('Wells Fargo ····2222 was removed.'), 'the removal')
    expect(server.deletes).toEqual(['/stripe/tenant/payment-methods/pm_new'])
  })

  it('a refusal that arrives anyway is shown once, under the bank', async () => {
    const reason = 'A payment from this bank is still clearing. You can remove it once that payment has cleared (a bank payment takes about 4 business days).'
    server.deleteFails = { status: 409, error: reason }
    await render(<SavedMethodsCard methods={[{ ...bank }, waiting, card]} loading={false} />)
    await press('Remove Chase ····1111')
    await press('Yes, remove Chase ····1111')
    await until(() => text().includes(reason), 'the refusal')
    expect(times(reason)).toBe(1)
  })
})

describe('confirming the microdeposits', () => {
  it('a code Stripe is still checking says the bank is being checked — never that it is verified', async () => {
    server.microdeposits = { pending: true, microdepositType: 'descriptor_code' }
    server.verifyResult = { success: true, data: { verified: false, verificationStep: 'checking',
      message: 'We received the verification you entered for this bank and are checking it now. There is nothing more you need to do — the bank can be used as soon as the check finishes.' } }
    await render(<VerifyMicrodepositsCard />)
    await until(() => !!host.querySelector('input'), 'the code box')
    const input = host.querySelector('input')!
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      set.call(input, 'SM12AB')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await press('Verify my bank account')
    await until(() => text().includes('Your bank is being checked'), 'the checking state')
    expect(text()).not.toContain('verified')
    expect(text()).not.toContain('default')
    // The card re-reads only for a few seconds; a check that takes minutes must
    // not be promised a page that updates itself.
    expect(text()).not.toContain('updates on its own')
    expect(text()).toContain('come back to this page later')
  })

  it('a verified answer says so and names the default', async () => {
    server.microdeposits = { pending: true, microdepositType: 'descriptor_code' }
    server.verifyResult = { success: true, data: { verified: true, verificationStep: null, message: 'Bank account verified.' } }
    await render(<VerifyMicrodepositsCard />)
    await until(() => !!host.querySelector('input'), 'the code box')
    const input = host.querySelector('input')!
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      set.call(input, 'SM12AB')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await press('Verify my bank account')
    await until(() => text().includes('your bank is verified'), 'the verified state')
    // No list price: a landlord who covers bank fees, or a tenant-payer platform
    // fee, makes any list figure wrong for this property. The fee is quoted at Pay.
    expect(text()).not.toMatch(/\$\d/)
    expect(text()).not.toMatch(/\d%/)
    expect(text()).toContain('the fee for each way to pay is')
  })
})

describe('no saved way to pay', () => {
  it('names no fee comparison as fact — the fee is shown before paying', async () => {
    server.balance = { leases: [lease({ usableCredit: 0, creditOnFile: 0, payIfUsed: 500 })] }
    await render(modal([]))
    await until(() => text().includes('You don\'t have a payment method on file yet'), 'the no-methods notice')
    expect(text()).not.toContain('ACH is the cheapest')
    expect(text()).toContain('usually cheapest')
    expect(text()).toContain('The fee for each way to pay is shown')
    expect(button('Add bank →')).toBeTruthy()
  })
})

// decisions.md #48.4: a card whose bank asks the cardholder to confirm the
// payment (3-D Secure) is confirmed on the spot; the bill is held while they
// do, and released at once when they do not.
describe('a card its bank wants confirmed is confirmed on the spot', () => {
  const card: SavedPaymentMethod = {
    id: 'pm_card', type: 'card', brand: 'visa', last4: '4242', expMonth: 1, expYear: 2030, country: 'US',
    verified: true, verifying: false, verificationStep: null, chargeable: true, isDefault: true, canRemove: true, removeBlockedReason: null,
  }
  const releases = () => server.posts.filter((p) => p.url === '/payments/pay-balance/release').map((p) => p.body)
  const noCredit = () => ({ leases: [lease({ usableCredit: 0, creditOnFile: 0, payIfUsed: 500 })] })
  beforeEach(() => {
    server.payStatus = 'requires_action'
    server.payData = { paymentIntentId: 'pi_3ds', clientSecret: 'pi_3ds_secret', confirmBy: '2026-10-04T18:30:00Z' }
  })

  it('a card payment asks the server to let the screen confirm it; a bank payment does not', async () => {
    server.payStatus = 'processing'; server.payData = {}
    server.balance = noCredit()
    await render(modal([card]))
    await press('Pay $518.05')
    await until(() => pays().length === 1, 'the payment')
    expect(pays()[0]).toMatchObject({ paymentMethodType: 'card', confirmOnScreen: true })
  })

  it('the bank\'s window is shown and the confirmed payment goes through — nothing is canceled', async () => {
    const shown: string[] = []
    CARD_CONFIRM.handleNextAction = async (cs) => { shown.push(cs); return { status: 'succeeded', failed: false } }
    server.balance = noCredit()
    await render(modal([card]))
    await press('Pay $518.05')
    await until(() => text().includes('Card charged. Receipt emailed.'), 'the result')
    expect(shown).toEqual(['pi_3ds_secret'])
    expect(releases()).toEqual([])
    await until(() => onPaid.mock.calls.length === 1, 'the modal to finish')
  })

  it('the bank did not confirm: the payment is canceled at once, the screen says so once, and the bill is read again to pay another way', async () => {
    CARD_CONFIRM.handleNextAction = async () => ({ status: 'requires_payment_method', failed: true })
    server.balance = noCredit()
    await render(modal([card]))
    const reads = () => server.posts.length
    await press('Pay $518.05')
    await until(() => text().includes(CARD_NOT_CONFIRMED_TEXT), 'the not-confirmed message')
    expect(releases()).toEqual([{ paymentIntentId: 'pi_3ds' }])
    expect(times(CARD_NOT_CONFIRMED_TEXT)).toBe(1)
    expect(onPaid).not.toHaveBeenCalled()
    expect(reads()).toBeGreaterThan(0)
    // Pay again is offered (the bill was read again, not left locked).
    await until(() => !!button('Pay $518.05'), 'Pay offered again')
  })

  it('the bank confirmed the cardholder and then declined the payment: the screen says declined, never "didn\'t confirm"', async () => {
    CARD_CONFIRM.handleNextAction = async () => ({ status: 'requires_payment_method', failed: true })
    server.releaseDeclined = true
    server.balance = noCredit()
    await render(modal([card]))
    await press('Pay $518.05')
    await until(() => text().includes(CARD_DECLINED_TEXT), 'the declined message')
    expect(times(CARD_DECLINED_TEXT)).toBe(1)
    expect(text()).not.toContain(CARD_NOT_CONFIRMED_TEXT)
    expect(releases()).toEqual([{ paymentIntentId: 'pi_3ds' }])
  })

  // Fix pass 3: the decline is read from the bank's window as it happens —
  // Stripe clears it once the charge is canceled, so the server may no longer see it.
  it('the bank\'s window itself says declined: the screen says declined even when the server can no longer tell', async () => {
    CARD_CONFIRM.handleNextAction = async () => ({ status: 'requires_payment_method', failed: true, declined: true })
    server.releaseDeclined = false
    server.balance = noCredit()
    await render(modal([card]))
    await press('Pay $518.05')
    await until(() => text().includes(CARD_DECLINED_TEXT), 'the declined message')
    expect(times(CARD_DECLINED_TEXT)).toBe(1)
    expect(text()).not.toContain(CARD_NOT_CONFIRMED_TEXT)
  })

  it('declined, and the cancel could not be sent: says declined, and that the bill opens again by itself', async () => {
    CARD_CONFIRM.handleNextAction = async () => ({ status: 'requires_payment_method', failed: true, declined: true })
    server.releaseOutcome = null
    server.balance = noCredit()
    await render(modal([card]))
    await press('Pay $518.05')
    await until(() => text().includes(CARD_DECLINED_LATER_TEXT), 'the message')
    expect(text()).not.toContain(CARD_RELEASE_LATER_TEXT)
  })

  it('only a card error other than a failed bank confirmation is read as declined', () => {
    expect(declinedByCardBankError({ type: 'card_error', code: 'card_declined' })).toBe(true)
    expect(declinedByCardBankError({ type: 'card_error', code: 'payment_intent_authentication_failure' })).toBe(false)
    expect(declinedByCardBankError({ type: 'validation_error', code: 'x' })).toBe(false)
    expect(declinedByCardBankError(null)).toBe(false)
  })

  it('a payment the bank confirmed just as it was canceled counts as paid, never as failed', async () => {
    CARD_CONFIRM.handleNextAction = async () => ({ status: null, failed: true })
    server.releaseOutcome = 'went_through'
    server.balance = noCredit()
    await render(modal([card]))
    await press('Pay $518.05')
    await until(() => text().includes('Your card payment is processing.'), 'the result')
    expect(text()).not.toContain(CARD_NOT_CONFIRMED_TEXT)
  })

  it('the bank\'s window could not be shown here: says so plainly, and the bill opens again', async () => {
    // No Stripe key in the test build: the real confirmer has no Stripe.js.
    server.balance = noCredit()
    await render(modal([card]))
    await press('Pay $518.05')
    await until(() => text().includes(CARD_CONFIRM_UNAVAILABLE_TEXT), 'the message')
    expect(releases()).toEqual([{ paymentIntentId: 'pi_3ds' }])
  })

  it('a cancel that could not be sent says the bill opens again by itself within 30 minutes', async () => {
    CARD_CONFIRM.handleNextAction = async () => ({ status: 'requires_payment_method', failed: true })
    server.releaseOutcome = null
    server.balance = noCredit()
    await render(modal([card]))
    await press('Pay $518.05')
    await until(() => text().includes(CARD_RELEASE_LATER_TEXT), 'the message')
    expect(times(CARD_RELEASE_LATER_TEXT)).toBe(1)
  })

  it('Pay all: a bank that does not confirm stops the run — the leases after it are not charged', async () => {
    CARD_CONFIRM.handleNextAction = async () => ({ status: 'requires_payment_method', failed: true })
    server.balance = { leases: [lease({ usableCredit: 0, creditOnFile: 0, payIfUsed: 500 }),
      lease({ leaseId: 'L2', outstanding: 300, requiredNow: 300, usableCredit: 0, creditOnFile: 0, payIfUsed: 300, payIfSaved: 300 })] }
    await render(modal([card], {
      amount: 800, endpoint: '/payments/pay-balance', subheader: 'across your 2 leases', kind: 'rent' as const,
      batch: [{ leaseId: 'L1', amount: 500 }, { leaseId: 'L2', amount: 300 }],
    }))
    await until(() => !!buttons().find((b) => /^Pay \$/.test(b.textContent ?? '') && !b.disabled), 'the Pay button')
    await act(async () => { buttons().find((b) => /^Pay \$/.test(b.textContent ?? ''))!.click() })
    await until(() => text().includes(CARD_NOT_CONFIRMED_TEXT), 'the message')
    expect(pays()).toHaveLength(1)
  })
})

describe('a card payment still waiting on its bank, picked up again', () => {
  const waiting = { paymentIntentId: 'pi_wait', amount: 518.05, confirmBy: '2026-10-04T18:30:00Z', canConfirm: true }
  const held = (over: any = {}) => ({ leases: [lease({
    outstanding: 0, requiredNow: 0, usableCredit: 0, creditOnFile: 0, payIfUsed: 0, payIfSaved: 0, clearing: 0,
    awaitingConfirmation: [waiting], ...over,
  })] })

  it('says it is waiting on the bank, not clearing, with Confirm and Cancel', async () => {
    server.balance = held()
    await render(modal())
    await until(() => text().includes('A card payment of $518.05 is waiting for your card\'s bank to confirm it.'), 'the waiting note')
    expect(text()).not.toContain('still clearing')
    expect(text()).not.toContain('Nothing is owed on this bill right now.')
    expect(button('Confirm with your bank')).toBeTruthy()
    expect(button('Cancel it and pay another way')).toBeTruthy()
  })

  it('Cancel it and pay another way releases it and says nothing was charged', async () => {
    server.balance = held()
    await render(modal())
    await press('Cancel it and pay another way')
    await until(() => text().includes('Canceled — nothing was charged. Your bill is open to pay.'), 'the note')
    expect(server.posts.filter((p) => p.url === '/payments/pay-balance/release').map((p) => p.body)).toEqual([{ paymentIntentId: 'pi_wait' }])
  })

  it('Confirm with your bank shows the bank\'s window again and the payment goes through', async () => {
    server.resumeData = { status: 'requires_action', clientSecret: 'pi_wait_secret' }
    const shown: string[] = []
    CARD_CONFIRM.handleNextAction = async (cs) => { shown.push(cs); return { status: 'succeeded', failed: false } }
    server.balance = held()
    await render(modal())
    await press('Confirm with your bank')
    await until(() => text().includes('Card charged. Receipt emailed.'), 'the result')
    expect(shown).toEqual(['pi_wait_secret'])
    expect(server.posts.filter((p) => p.url === '/payments/pay-balance/release')).toEqual([])
  })

  it('a payment the bank already said no to offers only Cancel, and says the bill opens by itself otherwise', async () => {
    server.balance = held({ awaitingConfirmation: [{ ...waiting, canConfirm: false }] })
    await render(modal())
    await until(() => !!button('Cancel it and pay another way'), 'Cancel')
    expect(button('Confirm with your bank')).toBeUndefined()
    expect(text()).toContain('Your card\'s bank didn\'t confirm a card payment of $518.05, so nothing was charged. Cancel it to pay another way — otherwise your bill opens again by itself at')
    expect(text()).not.toContain('If it isn\'t canceled by')
  })

  it('a Cancel that fails with no word from the server says the written next step, never the connection error', async () => {
    server.awaitingError = new Error('Network Error')
    server.balance = held()
    await render(modal())
    await press('Cancel it and pay another way')
    await until(() => text().includes('That payment couldn’t be canceled just now. It is canceled by itself within 30 minutes, and your bill opens again.'), 'the next step')
    expect(text()).not.toContain('Network Error')
  })

  it('a Cancel the server broke on (500) says the written next step, not the HTTP text', async () => {
    server.awaitingError = Object.assign(new Error('Request failed with status code 500'), { response: { status: 500, data: {} } })
    server.balance = held()
    await render(modal())
    await press('Cancel it and pay another way')
    await until(() => text().includes('It is canceled by itself within 30 minutes'), 'the next step')
    expect(text()).not.toContain('status code 500')
  })

  it('a Cancel of a payment already released (404) says the bill is open to pay', async () => {
    server.awaitingError = httpError(404, 'That card payment was not found on your account.')
    server.balance = held()
    await render(modal())
    await press('Cancel it and pay another way')
    await until(() => text().includes(CARD_ALREADY_RELEASED_TEXT), 'the note')
    expect(times(CARD_ALREADY_RELEASED_TEXT)).toBe(1)
    expect(text()).not.toContain('was not found on your account')
  })

  it('Confirm past the time the screen showed: the server canceled it, and the screen says the bill is open', async () => {
    server.resumeData = { status: 'canceled', outcome: 'released', declined: false, expired: true, clientSecret: null }
    const shown: string[] = []
    CARD_CONFIRM.handleNextAction = async (cs) => { shown.push(cs); return { status: 'succeeded', failed: false } }
    server.balance = held()
    await render(modal())
    await press('Confirm with your bank')
    await until(() => text().includes('That payment wasn’t confirmed in time, so it was canceled — nothing was charged and your bill is open to pay.'), 'the note')
    expect(shown).toEqual([])
  })

  it('a co-tenant sees whose card\'s bank it waits on, named once, with no Confirm or Cancel', async () => {
    server.balance = held({ awaitingConfirmation: [{ ...waiting, canConfirm: false, mine: false, payerName: 'Jane Doe' }] })
    await render(modal())
    await until(() => text().includes('A card payment of $518.05 on this bill is waiting on Jane Doe\'s card\'s bank to confirm it. Nothing has been charged yet.'), 'the note')
    expect(times('Jane Doe')).toBe(1)
    expect(button('Confirm with your bank')).toBeUndefined()
    expect(button('Cancel it and pay another way')).toBeUndefined()
    expect(text()).not.toContain('still clearing')
  })

  it('Confirm on a payment that went through meanwhile says so — never "can no longer be confirmed"', async () => {
    server.resumeData = { status: 'succeeded', outcome: 'went_through', clientSecret: null }
    server.balance = held()
    await render(modal())
    await press('Confirm with your bank')
    await until(() => text().includes('That card payment went through after all — it isn’t owed again.'), 'the note')
    expect(text()).not.toContain('can no longer be confirmed')
    expect(host.querySelector('.alert.a-green')?.textContent).toContain('went through after all')
  })

  it('Confirm on a payment another tab already canceled says it was already canceled — never that it ran out of time', async () => {
    server.resumeData = { status: 'canceled', outcome: 'released', declined: false, expired: false, clientSecret: null }
    server.balance = held()
    await render(modal())
    await press('Confirm with your bank')
    await until(() => text().includes(CARD_ALREADY_RELEASED_TEXT), 'the note')
    expect(text()).not.toContain('wasn’t confirmed in time')
    expect(text()).not.toContain('can no longer be confirmed')
  })

  it('Confirm on a payment its card\'s bank already declined says it was declined — never that it ran out of time', async () => {
    server.resumeData = { status: 'canceled', outcome: 'released', declined: true, expired: false, clientSecret: null }
    server.balance = held()
    await render(modal())
    await press('Confirm with your bank')
    await until(() => text().includes(CARD_DECLINED_TEXT), 'the note')
    expect(text()).not.toContain('wasn’t confirmed in time')
    expect(text()).not.toContain('already canceled')
  })

  it('Cancel on a payment its card\'s bank already declined says it was declined, as the history row does — never "Canceled"', async () => {
    server.releaseDeclined = true
    server.balance = held()
    await render(modal())
    await press('Cancel it and pay another way')
    await until(() => text().includes(CARD_DECLINED_TEXT), 'the note')
    expect(text()).not.toContain('Canceled — nothing was charged')
    expect(host.querySelector('.alert.a-warn')?.textContent).toContain('Your card was declined')
  })

  it('a good outcome is shown as a green note, a problem as a warning', async () => {
    server.balance = held()
    await render(modal())
    await press('Cancel it and pay another way')
    await until(() => text().includes('Canceled — nothing was charged.'), 'the note')
    expect(host.querySelector('.alert.a-green')?.textContent).toContain('Canceled — nothing was charged.')
    expect(host.querySelector('.alert.a-warn')).toBeNull()
  })

  it('a co-tenant is told about a payer with no name on file in a sentence that reads right', async () => {
    server.balance = held({ awaitingConfirmation: [{ ...waiting, canConfirm: false, mine: false, payerName: null }] })
    await render(modal())
    await until(() => text().includes('A card payment of $518.05 on this bill is waiting on another household member\'s card\'s bank to confirm it. Nothing has been charged yet.'), 'the note')
    expect(text()).not.toContain('null')
  })

  it('Cancel says "Canceling…" while it works, and Confirm keeps its own label', async () => {
    let release!: () => void
    server.releaseGate = new Promise<void>((r) => { release = r })
    server.balance = held()
    await render(modal())
    await press('Cancel it and pay another way')
    await until(() => !!button('Canceling…'), 'the Canceling… label')
    expect(button('Canceling…')!.disabled).toBe(true)
    expect(button('Confirm with your bank')!.disabled).toBe(true)
    expect(button('Waiting on your bank…')).toBeUndefined()
    release()
    await until(() => text().includes('Canceled — nothing was charged.'), 'the note')
    expect(button('Canceling…')).toBeUndefined()
  })

  it('a payer with no lease (a service agreement) gets the same Confirm and Cancel on its pay screen', async () => {
    server.balance = { leases: [], serviceAgreements: [{ serviceAgreementId: 'SA1', awaitingConfirmation: [waiting] }] }
    const target = { amount: 80, endpoint: '/payments/pay-balance', subheader: 'your utility bill, paid in full', kind: 'utility' as const,
      sendAmountInBody: true, serviceAgreementId: 'SA1' }
    await render(<></>)
    qc.setQueryData('balance-context', server.balance)
    await act(async () => { root.render(<QueryClientProvider client={qc}>{modal([bank], target)}</QueryClientProvider>) })
    await until(() => text().includes('A card payment of $518.05 is waiting for your card\'s bank to confirm it.'), 'the waiting note')
    await press('Cancel it and pay another way')
    await until(() => text().includes('Canceled — nothing was charged.'), 'the note')
    expect(server.posts.filter((p) => p.url === '/payments/pay-balance/release').map((p) => p.body)).toEqual([{ paymentIntentId: 'pi_wait' }])
  })
})

// The Payments page draws a lease's Pay button only when something is owed; a
// bill held whole by a card payment owes nothing, so the page shows this block
// itself (balance-context awaitingCardConfirmations).
describe('the held card payment block on its own (the Payments page)', () => {
  const waiting = { paymentIntentId: 'pi_wait', amount: 518.05, confirmBy: '2026-10-04T18:30:00Z', canConfirm: true, mine: true }
  it('shows Confirm and Cancel for a bill whose whole amount is held, and Cancel opens the bill again', async () => {
    server.balance = { leases: [] }
    await render(<AwaitingCardPayments items={[waiting]} />)
    expect(text()).toContain('A card payment of $518.05 is waiting for your card\'s bank to confirm it. Nothing has been charged yet.')
    expect(button('Confirm with your bank')).toBeTruthy()
    await press('Cancel it and pay another way')
    await until(() => text().includes('Canceled — nothing was charged. Your bill is open to pay.'), 'the note')
  })

  it('renders nothing when no payment is held', async () => {
    await render(<AwaitingCardPayments items={[]} />)
    expect(text()).toBe('')
  })
})

// autopaycredit2 review problem 3: Pay all explained only the credit the bills
// use; the Account credit card above it showed the whole credit on file.
describe('Pay all explains every dollar of the credit on file', () => {
  const REST = '$600.00 of your credit stays on your account for a later bill.'
  const run = { order: ['L1', 'L2'], runCreditWaiting: 0, runCreditWaitingNote: null, runCreditOnFile: 1270, runCreditRestNote: REST }
  const target = {
    amount: 1600, endpoint: '/payments/pay-balance', subheader: 'across your 2 leases', kind: 'rent' as const,
    batch: [{ leaseId: 'L1', amount: 800 }, { leaseId: 'L2', amount: 800 }],
  }
  it('says "You have $1,270.00 credit. $670.00 of it can pay these bills." and where the rest goes, once', async () => {
    server.balance = { leases: [
      lease({ leaseId: 'L1', landlordId: 'LL1', outstanding: 800, requiredNow: 800, usableCredit: 400, creditOnFile: 1270, payIfUsed: 400, payIfSaved: 800,
        payAll: { ...run, usableCredit: 400, payIfUsed: 400, coversWholeBill: false } }),
      lease({ leaseId: 'L2', landlordId: 'LL1', outstanding: 800, requiredNow: 800, usableCredit: 400, creditOnFile: 1270, payIfUsed: 400, payIfSaved: 800,
        payAll: { ...run, usableCredit: 270, payIfUsed: 530, coversWholeBill: false } }),
    ] }
    await render(modal([bank], target))
    await until(() => text().includes(REST), 'the rest sentence')
    expect(text()).toContain(`You have $1,270.00 credit. $670.00 of it can pay these bills. ${REST}`)
    expect(times(REST)).toBe(1)
  })
})
