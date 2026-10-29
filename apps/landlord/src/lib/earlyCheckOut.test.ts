/**
 * 10/4 (decisions #37.B, #38) — the schedule's Check out window, display logic.
 * The server decides every figure; these only word it and gate the one button.
 */
import { describe, it, expect } from 'vitest'
import {
  summaryLines, parseMoney, canConfirm, confirmLabel, refundAmountFor, waitLine, doneLines, failedPart, retryParts, windowTitle, dayWord, money,
  type CheckoutQuote,
} from './earlyCheckOut'

const quote = (over: Partial<CheckoutQuote> = {}): CheckoutQuote => ({
  bookingId: 'b1', unitId: 'u1', unitNumber: 'RV 07', guest: 'Jane Doe', status: 'checked_in', today: '2026-10-02',
  checkIn: '2026-09-28', leftOn: '2026-10-02', checkedOut: false, early: true,
  booked: { checkOut: '2026-10-06', nights: 8, price: 480 }, stayed: { checkOut: '2026-10-02', nights: 4, worth: 240 },
  paid: 300, owedAsBooked: 180, lease: null,
  sources: [{ key: 's1', kind: 'card', label: 'Card · register Oct 1', paid: 300, refundable: 300 }],
  question: 'overpaid', unused: 60, maxRefund: 300,
  choices: [
    { choice: 'no_refund', label: 'No refund (keep the price as booked)', result: 'Nothing goes back, and they still owe $180.00' },
    { choice: 'refund_unused', label: 'Refund the unused nights ($60.00)', result: '$62.21 back to the card they paid with (Card · register Oct 1)',
      refund: { amount: 60, cost: 'Stripe keeps…', parts: [{ kind: 'card', label: 'Card · register Oct 1', amount: 62.21, words: '…' }] } },
    { choice: 'refund_other', label: 'Refund a different amount', result: 'Type any amount up to $300.00' },
  ],
  canRefund: true, waitsForRefund: null, decision: null, quoteToken: 't',
  ...over,
})

describe('the three plain lines', () => {
  it('say what was booked, stayed and paid', () => {
    expect(summaryLines(quote())).toEqual({
      booked: 'Booked: to Oct 6 · 8 nights · $480.00',
      stayed: 'Stayed: 4 nights (left Oct 2) · worth $240.00',
      paid: 'Paid: $300.00 (Card · register Oct 1)',
    })
    expect(summaryLines(quote({ early: false })).stayed).toBe('Leaving Oct 2 · on or after the booked day')
    expect(summaryLines(quote({ lease: { id: 'l', endsOn: '2026-10-02', words: '' } })).stayed).toBe('Leaving Oct 2 · the lease ends that day')
  })
  it('read days and money without a clock', () => {
    expect(dayWord('2026-10-06')).toBe('Oct 6')
    expect(money(1451.6)).toBe('$1,451.60')
  })
})

describe('the one button', () => {
  it('names the action', () => {
    expect(confirmLabel(quote(), null, '')).toBe('Check out Jane Doe')
    expect(confirmLabel(quote(), 'refund_unused', '')).toBe('Check out and refund $60.00')
    expect(confirmLabel(quote(), 'refund_other', '25')).toBe('Check out and refund $25.00')
    expect(confirmLabel(quote(), 'no_refund', '')).toBe('Check out — no refund')
    expect(confirmLabel(quote({ question: 'owes', choices: [] }), 'nights_only', '')).toBe('Check out and charge $240.00')
    expect(confirmLabel(quote({ checkedOut: true }), 'refund_unused', '')).toBe('Refund $60.00')
    expect(confirmLabel(quote({ checkedOut: true }), 'no_refund', '')).toBe('No refund')
  })
  it('waits for a choice that fits, and a typed amount inside the limit', () => {
    expect(canConfirm(quote(), null, '')).toBe(false)
    expect(canConfirm(quote(), 'refund_unused', '')).toBe(true)
    expect(canConfirm(quote(), 'refund_other', '')).toBe(false)
    expect(canConfirm(quote(), 'refund_other', '0')).toBe(false)
    expect(canConfirm(quote(), 'refund_other', '300.01')).toBe(false)
    expect(canConfirm(quote(), 'refund_other', '$300')).toBe(true)
    expect(canConfirm(quote(), 'keep_price', '')).toBe(false)           // not one of this question's choices
    expect(canConfirm(quote({ question: 'none', choices: [] }), null, '')).toBe(true)
    expect(canConfirm(quote({ question: 'none', choices: [], checkedOut: true }), null, '')).toBe(false)
    // Without "Issue refunds": check them out, the money waits.
    expect(canConfirm(quote({ canRefund: false, choices: [] }), null, '')).toBe(true)
    expect(canConfirm(quote({ canRefund: false, choices: [], checkedOut: true }), null, '')).toBe(false)
    expect(canConfirm(quote({ decision: { id: 'd', status: 'decided' } as any }), 'refund_unused', '')).toBe(false)
  })
  it('reads the refund amount from the server for the unused nights, from the box otherwise', () => {
    expect(refundAmountFor(quote(), 'refund_unused', '')).toBe(60)
    expect(refundAmountFor(quote(), 'refund_other', '12.5')).toBe(12.5)
    expect(refundAmountFor(quote(), 'no_refund', '')).toBeNull()
  })
})

describe('typed money', () => {
  it('takes dollars and cents, nothing else', () => {
    expect(parseMoney('1,234.56')).toBe(1234.56)
    expect(parseMoney('$40')).toBe(40)
    expect(parseMoney('4.567')).toBeNull()
    expect(parseMoney('abc')).toBeNull()
    expect(parseMoney('')).toBeNull()
  })
})

describe('after the press', () => {
  it('puts cash to hand back first', () => {
    expect(doneLines(['$20.81 back to the card they paid with (Card · register Sep 29) — sent.', 'Hand back $380.00 in cash now.'])).toEqual({
      first: 'Hand back $380.00 in cash now.', rest: ['$20.81 back to the card they paid with (Card · register Sep 29) — sent.'],
    })
    expect(doneLines(['Jane Doe is checked out.'])).toEqual({ first: null, rest: ['Jane Doe is checked out.'] })
  })
  it('offers Try again on a card refund that failed', () => {
    const d = { id: 'd', status: 'decided', parts: [
      { id: 'p1', kind: 'cash', label: 'Cash', amount: 10, status: 'handed_back', words: 'x', failure: null },
      { id: 'p2', kind: 'card', label: 'Card', amount: 20, status: 'failed', words: 'y', failure: 'Stripe could not send this refund just now — press Try again.' },
    ] } as any
    expect(failedPart({ decision: d })).toEqual({ id: 'p2', words: 'Stripe could not send this refund just now — press Try again.' })
    expect(failedPart({ decision: null })).toBeNull()
  })
  it('says the money waits for someone who can refund', () => {
    expect(waitLine(quote({ canRefund: false, waitsForRefund: 'It waits.' }))).toBe('It waits.')
    expect(waitLine(quote())).toBeNull()
  })
  // 10/18 (Nic): "if the landlord does refunds at all at that property." At a
  // park that does not, the server asks no question — so the window shows the
  // sentence that says why, and the only button is Check out.
  it('says plainly when the property does not give money back', () => {
    const noMoneyBack = 'Jane Doe paid $60.00 more than the nights they stayed are worth, but this property does not '
      + 'give money back when a guest leaves early \u2014 so nothing goes back and the price as booked, $480.00, stands. '
      + "Check them out and the stay closes. The property's settings are where that changes."
    const q = quote({ question: 'none', choices: [], unused: 0, maxRefund: 0, noRefunds: noMoneyBack })
    expect(waitLine(q)).toBe(noMoneyBack)
    // One button, and it checks them out — nothing to pick.
    expect(canConfirm(q, null, '')).toBe(true)
    expect(confirmLabel(q, null, '')).toBe('Check out Jane Doe')
    // Opened again after they are out: the sentence stays, the button closes.
    const after = quote({ ...q, checkedOut: true, noRefunds: noMoneyBack })
    expect(waitLine(after)).toBe(noMoneyBack)
    expect(canConfirm(after, null, '')).toBe(false)
    expect(confirmLabel(after, null, '')).toBe('Close')
  })
  it('a park that DOES give money back is unchanged: the choices speak for themselves', () => {
    expect(waitLine(quote({ noRefunds: null }))).toBeNull()
    expect(waitLine(quote())).toBeNull()
  })
  /**
   * 10/19 (review): a question asked BEFORE the landlord answered No is still
   * open, so the owner must be able to clear it. The window shows the real
   * figure, the one answer this park honors, and the sentence saying why — the
   * server sends question 'overpaid' with maxRefund 0 for exactly this.
   */
  it('a question already open at a park that gives no money back can still be answered', () => {
    const noMoneyBack = 'Jane Doe paid $60.00 more than the nights they stayed are worth, but this property does not '
      + 'give money back when a guest leaves early \u2014 so nothing goes back and the price as booked, $480.00, stands. '
      + '$180.00 of that price is still owed and stays on the stay after they are checked out. '
      + "The property's settings are where that changes."
    const q = quote({
      checkedOut: true, question: 'overpaid', unused: 60, maxRefund: 0, noRefunds: noMoneyBack,
      choices: [{ choice: 'no_refund', label: 'No refund (keep the price as booked)',
                  result: 'Nothing goes back, and they still owe $180.00' }],
      decision: { id: 'd1', status: 'pending', choice: null, choiceLabel: null, leftOn: '2026-10-02',
                  decidedBy: null, decidedAt: null, refundTotal: 0, priceAfter: null, parts: [] },
    })
    // The figure the owner reads is the real one, never $0.00.
    expect(q.unused).toBe(60)
    expect(waitLine(q)).toBe(noMoneyBack)
    // No answer picked yet: no button. Pick the one answer and there is one.
    expect(canConfirm(q, null, '')).toBe(false)
    expect(canConfirm(q, 'no_refund', '')).toBe(true)
    expect(confirmLabel(q, 'no_refund', '')).toBe('No refund')
    // The answers this park does not honor are not offerable, even by hand.
    expect(canConfirm(q, 'refund_unused', '')).toBe(false)
    expect(canConfirm(q, 'refund_other', '300')).toBe(false)
  })
  it('a clerk who cannot issue refunds reads the amount that is really waiting', () => {
    const q = quote({ checkedOut: true, question: 'overpaid', unused: 60, maxRefund: 0, canRefund: false,
      choices: [], waitsForRefund: 'Jane Doe paid $60.00 more than the nights they stayed are worth. …' })
    expect(waitLine(q)).toContain('$60.00')
    expect(canConfirm(q, null, '')).toBe(false)
  })
  it('says a price choice waits for someone who can check guests out, and offers no button for it', () => {
    const owes = quote({ question: 'owes', choices: [], checkedOut: true, canCheckOut: false, waitsForCheckOut: 'Only someone with "Check guests out" can choose.' })
    expect(waitLine(owes)).toBe('Only someone with "Check guests out" can choose.')
    expect(canConfirm(owes, 'nights_only', '')).toBe(false)
  })
  it('a guest not checked out yet, opened by someone without "Check guests out": no button, one line saying who can', () => {
    const words = 'Jane Doe is not checked out yet. Only someone with "Check guests out" can check them out.'
    const q = quote({ choices: [], canCheckOut: false, waitsForCheckOut: words })
    expect(waitLine(q)).toBe(words)
    expect(canConfirm(q, null, '')).toBe(false)
    expect(canConfirm(quote({ canCheckOut: false }), 'refund_unused', '')).toBe(false)
    expect(canConfirm(quote({ question: 'none', choices: [], canCheckOut: false }), null, '')).toBe(false)
  })
})

describe('opened later on a decided stay', () => {
  const decided = (parts: any[]) => ({ id: 'd', status: 'decided', choice: 'refund_unused', choiceLabel: 'Refund the unused nights',
    leftOn: '2026-10-02', decidedBy: 'Test Landlord', decidedAt: null, refundTotal: 60, priceAfter: 480, parts }) as any
  const failed = { id: 'p2', kind: 'card', label: 'Card', amount: 20, status: 'failed', words: 'y', failure: 'Stripe could not send this refund just now — press Try again.' }
  it('offers Try again on every refund part that did not go out, for someone who can issue refunds', () => {
    const q = quote({ checkedOut: true, question: 'none', choices: [], decision: decided([
      { id: 'p1', kind: 'card', label: 'Card', amount: 10, status: 'refunded', words: 'x', failure: null }, failed, { ...failed, id: 'p3' },
    ]) })
    expect(retryParts(q).map((p) => p.id)).toEqual(['p2', 'p3'])
    expect(retryParts({ ...q, canRefund: false })).toEqual([])
    expect(retryParts(quote())).toEqual([])
    expect(canConfirm(q, null, '')).toBe(false)
  })
  it('is titled for what it is', () => {
    expect(windowTitle(quote())).toBe('Check out')
    expect(windowTitle(quote({ checkedOut: true }))).toBe('Decide the money')
    expect(windowTitle(quote({ checkedOut: true, decision: decided([failed]) }))).toBe('Early check-out refund')
  })
})
