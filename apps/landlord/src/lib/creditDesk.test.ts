/**
 * S655 money plan, Step 14 — the landlord payment screens.
 *
 * Nic (10/2): landlord screens show the full balance with "credit available
 * $X" beside it; credit is used only when the payer says so (Use / Save), and
 * pays a bill by itself only when it covers the whole bill. Decisions #25,
 * #26, #29, #35.1, #36.A (10/3): Record payment on Outstanding Balances, the
 * Payments tab a ledger by month, no grand total for on-site staff.
 * Harland-credits (10/3): a typed round-up on a check or money order is asked
 * about before it becomes a credit; cash over the bill is never defaulted.
 */
import { describe, it, expect } from 'vitest'
import {
  money, parseAmount, monthTitle, monthWord, dayWord, daysLateText,
  creditBesideText, monthsOwedText, sliceByProperty, serverTotals, folderTotal, deskBalanceSentence,
  creditChoiceNeeded, creditToUseFor, deskOwedCents, oldBalanceOwedCents, postAnchor, planTender, recordedMessage, lateFeeDeleteRefusalText, lateFeeOutcomeText,
  serverMessage, serverStatus, readerChoiceParams, readerQuoteQuery, readerReady, readerLeases, withReaderTaken, readerFinishedMessage,
  postConfirmQuestion, numberRequired, tenantCreditLines, tenantCreditHeadline,
  deskFigures, sameFigures, figuresMovedMessage, payerHits, matchPayerHits, returnDetail, chargeMonthsRange,
  readChargesById, plainRefusal, localToday, calendarDay, localDayOf, awaitingOpensAtWord,
  billsBySpace, canPickBill, togglePick, picksStillOpen, quoteMatchesPick, pickBillName,
  type DeskQuote, type DeskQuoteBill, type DeskQuoteRow, type TenderInput, type OutstandingRow, type PickerLease,
} from './creditDesk'
import { PAYMENT_STATUSES, PAYMENT_STATUS_LABEL } from '@gam/shared'

const row = (over: Partial<DeskQuoteRow> = {}): DeskQuoteRow => ({
  id: 'r1', leaseId: 'L1', type: 'rent', entryDescription: 'RENT', amount: 460, dueDate: '2026-10-01',
  creditAlreadyApplied: 0, notes: null, unitNumber: 'MH 04', propertyName: 'Oak Park', ...over,
})

/** A desk quote for a bill of `current` with `usable` credit that could pay part of it. */
function quote(over: Partial<DeskQuote> = {}): DeskQuote {
  const rows = over.rows ?? [row()]
  const current = rows.reduce((s, r) => s + r.amount, 0)
  const usable = over.creditAvailable ?? 0
  return {
    anchorPaymentId: rows[0]?.id ?? 'r1', anchorOpen: true, paymentsPaused: false,
    rows, currentTotal: current, oldBalance: [], oldBalanceTotal: 0,
    payOnline: [], payOnlineTotal: 0, paused: [], pausedTotal: 0, clearing: 0,
    creditAlreadyApplied: 0, creditAvailable: usable, creditSetAsideElsewhere: 0, creditOnFile: usable,
    owedIfUsed: Math.max(0, current - usable), owedIfSaved: current, fullBalance: current,
    scheduledRetries: [],
    ...over,
  }
}

const tender = (over: Partial<TenderInput> = {}): TenderInput => ({
  method: 'cash', tenderedCents: null, choice: null, towardOldCents: null,
  surplusHandling: null, writtenConfirmed: false, ...over,
})

describe('money on these screens', () => {
  it('formats every figure as dollars and cents', () => {
    expect(money(1234.5)).toBe('$1,234.50')
    expect(money('0.35')).toBe('$0.35')
    expect(money(-12)).toBe('−$12.00')
  })
  it('reads a typed amount, and nothing usable as nothing', () => {
    expect(parseAmount('$486.00')).toBe(48600)
    expect(parseAmount('1,000')).toBe(100000)
    expect(parseAmount('')).toBeNull()
    expect(parseAmount('abc')).toBeNull()
    expect(parseAmount('.')).toBeNull()
  })
})

describe('the credit beside a balance (Nic, 10/2: shown beside it, never taken off it)', () => {
  it('says the usable credit as "credit available $X"', () => {
    expect(creditBesideText(450, 450)).toBe('credit available $450.00')
  })
  it('says how much more is on file when not all of it can pay this bill', () => {
    expect(creditBesideText(10, 460)).toBe('credit available $10.00 ($460.00 on file)')
  })
  it('says plainly when credit is on file but none of it can pay this balance', () => {
    expect(creditBesideText(0, 25)).toBe('$25.00 credit on file — none of it can pay this balance')
  })
  it('says nothing when there is no credit', () => {
    expect(creditBesideText(0, 0)).toBeNull()
  })
  it('the Front Desk sentence keeps the full balance and asks about the credit, never "already taken off"', () => {
    const said = deskBalanceSentence({ first: 'Kim', owed: 935.45, credit: 450, when: 'Sep 1', overdue: true })
    expect(said).toBe('Kim owes $935.45 — oldest bill was due Sep 1. They have $450.00 of credit that can go toward it — ask whether they want to use it or save it. Whatever is left is taken in full; rent cannot be part-paid.')
    expect(said).not.toMatch(/taken off/)
    expect(deskBalanceSentence({ first: 'Russ', owed: 460, credit: 0, when: null, overdue: false }))
      .toBe('Russ owes $460.00. Take the full amount; rent cannot be part-paid.')
  })
  it('10/5: where the property takes part payments, the Front Desk never says rent cannot be part-paid', () => {
    expect(deskBalanceSentence({ first: 'Russ', owed: 460, credit: 0, when: null, overdue: false, partialOk: true }))
      .toBe('Russ owes $460.00. They can pay part; what they do not pay stays owed, and late fees still apply.')
    const withCredit = deskBalanceSentence({ first: 'Kim', owed: 935.45, credit: 450, when: 'Sep 1', overdue: true, partialOk: true })
    expect(withCredit).toMatch(/ask whether they want to use it or save it\. They can pay part of what is left; what they do not pay stays owed, and late fees still apply\.$/)
    expect(withCredit).not.toMatch(/cannot be part-paid/)
  })
})

describe('Outstanding Balances (decisions #29)', () => {
  it('lists every unpaid month as "$X from <month>", oldest first', () => {
    expect(monthsOwedText([{ month: '2026-09', amount: 460 }, { month: '2026-08', amount: 450 }], '2026-10-03'))
      .toBe('$450.00 from August · $460.00 from September')
  })
  it('names the year of a month from another year', () => {
    expect(monthsOwedText([{ month: '2025-12', amount: 20 }], '2026-10-03')).toBe('$20.00 from December 2025')
  })
  it('says how late in days (the server counts it, grace honored), and nothing when not late', () => {
    expect(daysLateText(0)).toBeNull()
    expect(daysLateText(1)).toBe('1 day past grace')
    expect(daysLateText(12)).toBe('12 days past grace')
  })

  const twoParks: OutstandingRow = {
    tenantId: 't1', firstName: 'Jane', lastName: 'Doe', phone: null, email: 'j@x.test',
    unitNumber: 'RV 14, MH 04', propertyId: 'pA', propertyName: 'Mountain View, Oak Park',
    balance: '900.00', creditAvailable: 40, creditOnAccount: 60, months: [], daysLate: 7, clearing: 0,
    workTrade: true, status: 'owes', recordWith: [{ landlordId: 'llA', paymentId: 'pay-a' }, { landlordId: 'llB', paymentId: 'pay-b' }],
    spaces: [
      { landlordId: 'llA', leaseId: 'L1', unitNumber: 'RV 14', propertyId: 'pA', propertyName: 'Mountain View',
        balance: 500, creditAvailable: 40, months: [{ month: '2026-10', amount: 500 }], daysLate: 7, clearing: 0 },
      { landlordId: 'llB', leaseId: 'L2', unitNumber: 'MH 04', propertyId: 'pB', propertyName: 'Oak Park',
        balance: 400, creditAvailable: 0, months: [{ month: '2026-09', amount: 400 }], daysLate: 0, clearing: 25 },
    ],
  }

  it('puts a person at two properties under each, with only what is owed there and credit counted once', () => {
    const slices = sliceByProperty([twoParks])
    expect(slices.map(s => [s.propertyName, s.balance, s.creditAvailable, s.daysLate, s.clearing])).toEqual([
      ['Mountain View', 500, 40, 7, 0],
      ['Oak Park', 400, 0, 0, 25],
    ])
    expect(slices.reduce((t, s) => t + s.creditAvailable, 0)).toBe(40)
  })
  it('opens Record payment on the company the person owes at that property', () => {
    const [a, b] = sliceByProperty([twoParks])
    expect(a.anchors).toEqual([{ landlordId: 'llA', paymentId: 'pay-a' }])
    expect(b.anchors).toEqual([{ landlordId: 'llB', paymentId: 'pay-b' }])
  })
  it('marks work trade without an amount, on every slice of the household', () => {
    expect(sliceByProperty([twoParks]).every(s => s.workTrade)).toBe(true)
  })
  it('a household whose only money is a payment clearing is "Payment clearing", owes nothing and has no Record button', () => {
    const [s] = sliceByProperty([{
      tenantId: 't2', firstName: 'Al', lastName: 'Bee', phone: null, email: null, unitNumber: 'RV 2',
      propertyId: 'pA', propertyName: 'Mountain View', balance: '0.00', clearing: 460, status: 'clearing',
      statusLabel: 'Payment clearing', recordWith: [], spaces: [],
    }])
    expect([s.status, s.balance, s.clearing, s.anchors.length]).toEqual(['clearing', 0, 460, 0])
  })

  it('shows a grand total only when the server sent one (decisions #25: owners and property managers)', () => {
    expect(serverTotals(undefined)).toBeNull()
    expect(serverTotals({})).toBeNull()
    expect(folderTotal(null, 'pA')).toBeNull()
    const t = serverTotals({ totals: { owed: 900, households: 1, clearing: 25,
      byProperty: [{ propertyId: 'pA', propertyName: 'Mountain View', owed: 500, clearing: 0 }] } })
    expect(t?.owed).toBe(900)
    expect(folderTotal(t, 'pA')).toBe(500)
    expect(folderTotal(t, 'pB')).toBe(0)
  })
})

describe('Record payment at the top: "who is paying?" finds everyone (decisions #29)', () => {
  const resident = (over: Partial<OutstandingRow>): OutstandingRow => ({
    tenantId: 't1', firstName: 'Jane', lastName: 'Doe', phone: null, email: null, unitNumber: 'RV 14',
    propertyId: 'pA', propertyName: 'Mountain View', balance: '460.00', status: 'owes', recordWith: [], spaces: [], ...over,
  })
  const lease = (tenantId: string, firstName: string, over: Partial<PickerLease> = {}): PickerLease => ({
    status: 'active', propertyId: 'pA', unitNumber: 'RV 14', propertyName: 'Mountain View',
    tenants: [{ tenantId, status: 'active', firstName, lastName: 'Doe' }], ...over,
  })

  it('somebody who owes at the desk opens their desk window, and is not offered as paying ahead too', () => {
    const hits = payerHits([resident({ recordWith: [{ landlordId: 'llA', paymentId: 'pay-1' }] })], [lease('t1', 'Jane')], null)
    expect(hits.map(h => [h.key, h.owes?.anchor.paymentId ?? null, h.aheadTenantId ?? null])).toEqual([['owes:pA:t1:pay-1', 'pay-1', null]])
  })
  it('a resident whose only money owed is an open register ticket is still found, with the reason, and can pay ahead', () => {
    const ticket = resident({ ticketId: 'tk1', unitNumber: null, balance: '25.00', firstName: 'Bob', lastName: 'Ray', tenantId: 't9' })
    const hits = payerHits([ticket], [lease('t9', 'Bob')], null)
    expect(hits).toHaveLength(1)
    expect(hits[0].aheadTenantId).toBe('t9')
    expect(hits[0].note).toBe('owes $25.00 on an open register ticket — settle it at the register')
  })
  it('a resident owing only what the desk cannot take (GAM charges, an eviction pause) is found with the reason', () => {
    const hits = payerHits([resident({ balance: '12.00' })], [lease('t1', 'Jane')], null)
    expect(hits).toHaveLength(1)
    expect(hits[0].aheadTenantId).toBe('t1')
    expect(hits[0].note).toMatch(/^owes \$12\.00 that is not taken at the desk/)
  })
  it('a former resident with only a register ticket and no lease here is listed with the reason and nothing to press', () => {
    const hits = payerHits([resident({ tenantId: 't7', ticketId: 'tk7', unitNumber: null, balance: '40.00', firstName: 'Ann' })], [], null)
    expect(hits).toEqual([{ key: 'elsewhere:t7', name: 'Ann Doe', where: 'Mountain View',
      note: 'owes $40.00 on an open register ticket — settle it at the register' }])
  })
  it('anyone else on a lease here pays ahead; a staffer kept to one property is offered only that property', () => {
    const leases = [lease('t2', 'Amy'), lease('t3', 'Cal', { propertyId: 'pB', propertyName: 'Oak Park', unitNumber: 'MH 04' })]
    expect(payerHits([], leases, null).map(h => h.aheadTenantId)).toEqual(['t2', 't3'])
    expect(payerHits([], leases, new Set(['pB'])).map(h => h.aheadTenantId)).toEqual(['t3'])
  })
  it('lists nothing under two letters, matches a name or a space, at most 12, by name', () => {
    const many = Array.from({ length: 20 }, (_, i) => lease(`t${i}`, `Zed${String(i).padStart(2, '0')}`))
    const hits = payerHits([], many, null)
    expect(matchPayerHits(hits, 'z')).toEqual([])
    expect(matchPayerHits(hits, 'zed')).toHaveLength(12)
    expect(matchPayerHits(hits, 'zed')[0].name).toBe('Zed00 Doe')
    expect(matchPayerHits(payerHits([], [lease('t1', 'Jane')], null), 'rv 14').map(h => h.name)).toEqual(['Jane Doe'])
  })
})

describe('the desk window: Use or Save (Nic, 10/2)', () => {
  it('asks Use or Save whenever credit could pay part of the bill, and records nothing until it is answered', () => {
    const q = quote({ creditAvailable: 450 })
    expect(creditChoiceNeeded(q)).toBe(true)
    const p = planTender(q, tender({ tenderedCents: 48545 }))
    expect(p.stop).toBe('choose_credit')
    expect(p.body).toBeNull()
  })
  it('never asks when there is no credit', () => {
    expect(creditChoiceNeeded(quote())).toBe(false)
    expect(creditToUseFor(quote(), null)).toBeUndefined()
  })
  it('Use owes exactly the bill minus the credit and sends the figure shown; Save owes the whole bill and sends 0', () => {
    const q = quote({ rows: [row({ amount: 935.45 })], creditAvailable: 450 })
    expect(deskOwedCents(q, 'use')).toBe(48545)
    expect(deskOwedCents(q, 'save')).toBe(93545)
    const used = planTender(q, tender({ choice: 'use', tenderedCents: 48545 }))
    expect(used.stop).toBeNull()
    expect(used.body).toEqual({ method: 'cash', amountTendered: 485.45, creditToUse: 450 })
    const saved = planTender(q, tender({ choice: 'save', tenderedCents: 93545 }))
    expect(saved.body).toEqual({ method: 'cash', amountTendered: 935.45, creditToUse: 0 })
  })
  it('a credit that covers the whole bill takes nothing: $0 handed over, no method asked', () => {
    const q = quote({ creditAvailable: 460 })
    const p = planTender(q, tender({ choice: 'use' }))
    expect(p.stop).toBeNull()
    expect(p.body).toEqual({ method: 'cash', amountTendered: 0, creditToUse: 460 })
  })
  it('sends the credit figure the desk was shown when it said Use, never one it was not shown', () => {
    expect(creditToUseFor(quote({ creditAvailable: 450 }), 'use', 5000)).toBe(50)
    expect(creditToUseFor(quote({ creditAvailable: 450 }), 'save', 5000)).toBe(0)
    const same = planTender(quote({ creditAvailable: 50 }), tender({ choice: 'use', answeredCreditCents: 5000, tenderedCents: 41000 }))
    expect(same.body).toEqual({ method: 'cash', amountTendered: 410, creditToUse: 50 })
  })
  it('a credit that moved after Use is asked again, never sent silently', () => {
    const p = planTender(quote({ creditAvailable: 450 }), tender({ choice: 'use', answeredCreditCents: 5000, tenderedCents: 1000 }))
    expect(p.stop).toBe('credit_moved')
    expect(p.body).toBeNull()
    expect(p.message).toBe('Their credit changed — it is now $450.00. Ask them again: use it or save it.')
  })
  it('a credit that moved after Save is asked again too (it may now pay the whole bill)', () => {
    const p = planTender(quote({ creditAvailable: 460 }), tender({ choice: 'save', answeredCreditCents: 5000, tenderedCents: 46000 }))
    expect(p.stop).toBe('credit_moved')
    expect(p.body).toBeNull()
  })
})

describe('the desk window keeps the figures it answered against', () => {
  it('any change in the credit, what is owed or the old balance counts as moved', () => {
    const a = deskFigures(quote({ creditAvailable: 50 }))
    expect(sameFigures(a, deskFigures(quote({ creditAvailable: 50 })))).toBe(true)
    expect(sameFigures(a, deskFigures(quote({ creditAvailable: 450 })))).toBe(false)
    expect(sameFigures(a, deskFigures(quote({ creditAvailable: 50, rows: [row({ amount: 485 })] })))).toBe(false)
    expect(sameFigures(a, deskFigures(quote({ creditAvailable: 50, oldBalanceTotal: 20 })))).toBe(false)
  })
  it('says what moved, once, with the next step', () => {
    const before = deskFigures(quote({ creditAvailable: 50 }))
    expect(figuresMovedMessage(before, deskFigures(quote({ creditAvailable: 450 }))))
      .toBe('Their credit changed — it is now $450.00. Ask them again: use it or save it.')
    expect(figuresMovedMessage(before, deskFigures(quote({ creditAvailable: 0 }))))
      .toBe('Their credit changed — none of it can pay this bill now. Check the figures above and take what they show.')
    expect(figuresMovedMessage(before, deskFigures(quote({ creditAvailable: 50, rows: [row({ amount: 485 })], oldBalanceTotal: 20 }))))
      .toBe('What they owe changed while this window was open — this bill is now $485.00, with a $20.00 old balance. Check the figures above and answer again.')
  })
})

describe('the desk window: pay in full, and every dollar over accounted for', () => {
  it('refuses less than is owed, in the words the server uses', () => {
    const p = planTender(quote(), tender({ tenderedCents: 40000 }))
    expect(p.stop).toBe('short')
    expect(p.message).toBe('That is $60.00 short — $400.00 against $460.00 owed. Rent is paid in full.')
  })
  it('records nothing until an amount is typed', () => {
    expect(planTender(quote(), tender()).stop).toBe('amount')
  })
  it('exactly the bill in cash records with no question', () => {
    const p = planTender(quote(), tender({ tenderedCents: 46000 }))
    expect(p.stop).toBeNull()
    expect(p.body).toEqual({ method: 'cash', amountTendered: 460 })
  })

  it('a money order typed over the bill asks "is it really $X?" before anything is recorded (Kim Harland, $486 vs $485.45)', () => {
    const q = quote({ rows: [row({ amount: 485.45 })] })
    const p = planTender(q, tender({ method: 'money_order', tenderedCents: 48600 }))
    expect(p.stop).toBe('written_confirm')
    expect(p.message).toBe('You typed $486.00 against $485.45 owed — is the money order really $486.00? Check the amount written on it, then confirm.')
    const ok = planTender(q, tender({ method: 'money_order', tenderedCents: 48600, writtenConfirmed: true }))
    expect(ok.stop).toBeNull()
    expect(ok.keptAsCreditCents).toBe(55)
    expect(ok.body).toEqual({ method: 'money_order', amountTendered: 486, surplusHandling: 'credit', confirmWrittenAmount: true })
  })
  it('a check over the bill and an old balance names both in the question', () => {
    const q = quote({ oldBalance: [row({ id: 'c1', type: 'carried_balance', amount: 100 })] })
    const p = planTender(q, tender({ method: 'check', tenderedCents: 92000 }))
    expect(p.message).toBe('You typed $920.00 against the $460.00 bill and a $100.00 old balance — is the check really $920.00? Check the amount written on it, then confirm.')
  })
  it('a check over the bill pays the old balance first and keeps the rest as credit, with no change', () => {
    const q = quote({ oldBalance: [row({ id: 'c1', type: 'carried_balance', amount: 100 })] })
    const p = planTender(q, tender({ method: 'check', tenderedCents: 92000, writtenConfirmed: true }))
    expect([p.toOldCents, p.keptAsCreditCents, p.changeCents]).toEqual([10000, 36000, 0])
    expect(p.body).not.toHaveProperty('towardOldBalance')
  })

  it('cash over the bill chooses nothing for them: Give change or Keep it, with each option’s figures', () => {
    const q = quote({ oldBalance: [row({ id: 'c1', type: 'carried_balance', amount: 30 })] })
    const p = planTender(q, tender({ tenderedCents: 50000 }))
    expect(p.stop).toBe('surplus_choice')
    expect(p.ifChange).toEqual({ changeCents: 4000, toOldCents: 0 })
    expect(p.ifKept).toEqual({ toOldCents: 3000, creditCents: 1000 })
    expect(p.body).toBeNull()
  })
  it('Give change hands the extra back and sends the choice', () => {
    const p = planTender(quote(), tender({ tenderedCents: 50000, surplusHandling: 'change' }))
    expect([p.changeCents, p.keptAsCreditCents]).toEqual([4000, 0])
    expect(p.body).toEqual({ method: 'cash', amountTendered: 500, surplusHandling: 'change' })
  })
  it('Keep it — no change on hand pays the old balance first, then keeps the rest as credit', () => {
    const q = quote({ oldBalance: [row({ id: 'c1', type: 'carried_balance', amount: 30 })] })
    const p = planTender(q, tender({ tenderedCents: 50000, surplusHandling: 'credit' }))
    expect([p.toOldCents, p.keptAsCreditCents, p.changeCents]).toEqual([3000, 1000, 0])
    expect(p.body).toEqual({ method: 'cash', amountTendered: 500, surplusHandling: 'credit' })
  })
  it('with change given, part may go to the old balance — never more than is over it or owed on it', () => {
    const q = quote({ oldBalance: [row({ id: 'c1', type: 'carried_balance', amount: 30 })] })
    const p = planTender(q, tender({ tenderedCents: 50000, surplusHandling: 'change', towardOldCents: 2000 }))
    expect([p.toOldCents, p.changeCents]).toEqual([2000, 2000])
    expect(p.body).toEqual({ method: 'cash', amountTendered: 500, surplusHandling: 'change', towardOldBalance: 20 })
    const tooMuch = planTender(q, tender({ tenderedCents: 50000, surplusHandling: 'change', towardOldCents: 3500 }))
    expect(tooMuch.stop).toBe('too_much_to_old')
    expect(tooMuch.message).toBe('At most $30.00 can go toward the old balance.')
  })
  it('keeping cash as credit while credit is being used is refused: it can only be handed back as change', () => {
    const q = quote({ creditAvailable: 100 })
    const p = planTender(q, tender({ choice: 'use', tenderedCents: 40000, surplusHandling: 'credit' }))
    expect(p.stop).toBe('credit_and_keep')
    expect(p.message).toBe('Credit is being used on this bill, so the $40.00 extra can only be handed back as change.')
  })
  it('a check over the bill while using credit is told to choose Save BEFORE being asked whether the check is really $X (the server’s order)', () => {
    const q = quote({ creditAvailable: 100 })
    // Not yet confirmed: the refusal comes first, so the desk never confirms an amount and is then refused.
    const p = planTender(q, tender({ method: 'check', choice: 'use', tenderedCents: 40000 }))
    expect(p.stop).toBe('credit_and_keep')
    expect(p.message).toBe('Credit is being used on this bill and the check is $40.00 over it. Choose Save instead.')
    // Saved instead: now, and only now, the written amount is asked about.
    const saved = planTender(q, tender({ method: 'check', choice: 'save', tenderedCents: 50000 }))
    expect(saved.stop).toBe('written_confirm')
  })
  it('the written-amount question is the last one: a check with nothing it could pay is refused without asking it', () => {
    const q = quote({ rows: [], oldBalance: [] })
    const p = planTender(q, tender({ method: 'check', tenderedCents: 5000 }))
    expect(p.stop).toBe('nothing_to_pay')
  })
  it('Keep it with the extra no more than the old balance records it to the old balance (fix round 2: no dead end)', () => {
    // $460 bill, $100 old balance, $520 cash: "Keep it" puts all $60 on the old balance.
    const q = quote({ oldBalance: [row({ id: 'c1', type: 'carried_balance', amount: 100 })], oldBalanceTotal: 100 })
    const p = planTender(q, tender({ tenderedCents: 52000, surplusHandling: 'credit' }))
    expect(p.stop).toBeNull()
    expect([p.toOldCents, p.surplusCents, p.keptAsCreditCents, p.changeCents]).toEqual([6000, 0, 0, 0])
    // The Keep answer is sent even with nothing left as credit — without it the
    // server reads the cash as not kept and refuses with "Choose Give change or Keep it".
    expect(p.body).toEqual({ method: 'cash', amountTendered: 520, surplusHandling: 'credit' })
    // Exactly the old balance over the bill: the same.
    const all = planTender(q, tender({ tenderedCents: 56000, surplusHandling: 'credit' }))
    expect(all.body).toEqual({ method: 'cash', amountTendered: 560, surplusHandling: 'credit' })
  })
  it('Keep it while credit is being used is allowed when all of the extra pays the old balance (nothing kept as credit)', () => {
    const q = quote({ creditAvailable: 100, oldBalance: [row({ id: 'c1', type: 'carried_balance', amount: 100 })], oldBalanceTotal: 100 })
    const p = planTender(q, tender({ choice: 'use', tenderedCents: 42000, surplusHandling: 'credit', answeredCreditCents: 10000 }))
    expect(p.stop).toBeNull()
    expect(p.toOldCents).toBe(6000)
    expect(p.body).toEqual({ method: 'cash', amountTendered: 420, creditToUse: 100, surplusHandling: 'credit' })
  })
  it('with only the old balance open, cash goes to it first, and $0 is never "recorded" for nothing', () => {
    const q = quote({ rows: [], oldBalance: [row({ id: 'c1', type: 'carried_balance', amount: 80 })] })
    expect(oldBalanceOwedCents(q)).toBe(8000)
    const p = planTender(q, tender({ tenderedCents: 8000 }))
    expect([p.stop, p.toOldCents]).toEqual([null, 8000])
    const nothing = planTender(q, tender({ tenderedCents: 0 }))
    expect(nothing.stop).toBe('nothing_to_pay')
  })
})

describe('the desk window self-heals', () => {
  it('Record posts to the charge it opened on while it is open, else the oldest one the desk takes', () => {
    const q = quote({ rows: [row({ id: 'a' }), row({ id: 'b' })] })
    expect(postAnchor(q)).toBe('a')
    expect(postAnchor({ ...q, anchorPaymentId: 'paid-elsewhere', anchorOpen: false })).toBe('a')
    expect(postAnchor({ ...q, anchorOpen: false, rows: [], oldBalance: [row({ id: 'old' })] })).toBe('old')
    expect(postAnchor({ ...q, anchorOpen: false, rows: [], oldBalance: [] })).toBeNull()
  })
  it('a refusal naming a charge’s raw status is said in plain words; anything else as the server wrote it', () => {
    expect(plainRefusal('This charge is not open (status: settled)')).toBe('This charge is no longer open — it is paid now.')
    expect(plainRefusal('This charge is not open (status: paid_via_deposit)')).toBe('This charge is no longer open — it is paid from deposit now.')
    expect(plainRefusal('This charge is not open (status: something_new)')).toBe('This charge is no longer open.')
    expect(serverMessage({ response: { status: 409, data: { error: 'This charge is not open (status: processing)' } } }, 'x'))
      .toBe('This charge is no longer open — it is clearing now.')
    expect(plainRefusal('That is $25.00 short — $500.00 against $525.00 owed. Rent is paid in full.'))
      .toBe('That is $25.00 short — $500.00 against $525.00 owed. Rent is paid in full.')
  })
  it('says the server’s own refusal once, and knows a 409 (something moved) from the rest', () => {
    const moved = { response: { status: 409, data: { error: "The credit available changed — it's now $50.00. Look at the bill again and choose Use or Save." } } }
    expect(serverStatus(moved)).toBe(409)
    expect(serverMessage(moved, 'x')).toBe("The credit available changed — it's now $50.00. Look at the bill again and choose Use or Save.")
    expect(serverMessage({ message: 'Request failed with status code 500' }, 'Try again.')).toBe('Try again.')
    expect(serverStatus(new Error('offline'))).toBeNull()
  })
  it('after Record it says what happened, the change to hand back included', () => {
    expect(recordedMessage('Kim Harland', { amountSettled: 485.45, creditUsed: 450 }))
      .toBe('Recorded $485.45 from Kim Harland — $450.00 of their credit used.')
    expect(recordedMessage('Russ Fuller', { amountSettled: 460, changeGiven: 40, surplus: 40 }))
      .toBe('Recorded $460.00 from Russ Fuller — give $40.00 change.')
    expect(recordedMessage('Todd', { amountSettled: 460, surplus: 460, creditId: 'c' }))
      .toBe('Recorded $460.00 from Todd — $460.00 kept on their account as credit.')
    expect(recordedMessage('Todd', { amountSettled: 0, creditUsed: 460 })).toBe("Paid Todd's bill with their credit.")
  })
  it('10/6: a ticked onboarding box the server could not carry out is said plainly, once', () => {
    const money = 'Money is recorded against this late fee, so it can\'t be deleted. It stays credited — it no longer counts toward what they owe, and it still counts as a late payment on their history.'
    expect(recordedMessage('Rae Tull', {
      amountSettled: 600, depositedOn: '2026-10-01', lateFeesUnbilled: 25, lateFeeCountsLate: true, lateFeeDeleteRefusals: [money, money],
    })).toBe(`Recorded $600.00 from Rae Tull. The late fee was credited. It still counts as a late payment on their history. ${money}`)
    expect(recordedMessage('Rae Tull', { amountSettled: 600, lateFeeDeleteRefusals: [] })).toBe('Recorded $600.00 from Rae Tull.')
    expect(lateFeeDeleteRefusalText(undefined)).toBeNull()
    expect(lateFeeDeleteRefusalText([money, ' ', 3])).toBe(money)
  })
  it('10/6 (Nic): a late fee is credited and still counts late — or, deleted in the onboarding month, nothing shows', () => {
    expect(lateFeeOutcomeText({})).toBeNull()
    expect(lateFeeOutcomeText({ lateFeesUnbilled: 25, lateFeeCountsLate: true }))
      .toBe('The late fee was credited. It still counts as a late payment on their history.')
    expect(lateFeeOutcomeText({ lateFeesRefunded: 25, lateFeeCountsLate: true }))
      .toBe('The late fee was credited. It still counts as a late payment on their history. $25.00 they had already paid was given back as credit.')
    expect(lateFeeOutcomeText({ lateFeesDeleted: 1 })).toBe('The late fee was deleted — nothing shows on their record.')
    // Review fix: what is said follows what is left on the bill, not what was done.
    expect(lateFeeOutcomeText({ lateFeesDeleted: 1, lateFeeCountsLate: true, lateFeeDeletedStillLate: true }))
      .toBe('The late fee was deleted, but another late fee is still on that bill, so it still counts as a late payment on their history.')
    expect(lateFeeOutcomeText({ lateFeesDeleted: 1, lateFeesRefunded: 25, lateFeeCountsLate: true, lateFeeDeletedStillLate: true }))
      .not.toMatch(/nothing shows/)
    // A late fee left owed (none credited) is never called credited.
    expect(lateFeeOutcomeText({ lateFeeCountsLate: true })).toBeNull()
    // Only a bank deposit dated back says anything about late fees.
    expect(recordedMessage('Rae Tull', { amountSettled: 600, lateFeesUnbilled: 25, lateFeeCountsLate: true })).toBe('Recorded $600.00 from Rae Tull.')
  })
})

describe('the card reader at the desk', () => {
  it('asks Use or Save before the amount is sent to the reader', () => {
    expect(readerReady({ usableCredit: 50, total: 480 }, null))
      .toEqual({ ready: false, reason: 'Ask whether to use their $50.00 credit or save it, before sending the amount to the reader.' })
    expect(readerReady({ usableCredit: 50, total: 480 }, 'save').ready).toBe(true)
    expect(readerReady({ usableCredit: 0, total: 480 }, null).ready).toBe(true)
  })
  it('a credit that covers the whole bill puts nothing on a card', () => {
    expect(readerReady({ usableCredit: 460, total: 0 }, 'use').ready).toBe(false)
    expect(readerReady({ usableCredit: 460, total: 0, creditUsed: 460, outstanding: 460, oldBalance: 0 }, 'use'))
      .toEqual({ ready: false, reason: 'The credit covers this whole bill — nothing goes on a card. Choose Cash, then Use, and record it with nothing taken.' })
  })
  it('a space with only an old balance open asks for an amount toward it — never says the credit covers it', () => {
    expect(readerReady({ usableCredit: 0, total: 0, creditUsed: 0, outstanding: 200, oldBalance: 200 }, null))
      .toEqual({ ready: false, reason: 'Only an old balance is open on this space. Enter an amount toward the old balance to send it to the reader.' })
    expect(readerReady({ usableCredit: 50, total: 0, creditUsed: 0, outstanding: 200, oldBalance: 200 }, 'save').reason)
      .toBe('Only an old balance is open on this space. Enter an amount toward the old balance to send it to the reader.')
    expect(readerReady({ usableCredit: 0, total: 52.3, creditUsed: 0, outstanding: 200, oldBalance: 200 }, null).ready).toBe(true)
  })
  it('sends the answer with the credit figure the desk read out, and any old-balance amount', () => {
    expect(readerChoiceParams(50, 'use', 2500)).toEqual({ useCredit: true, expectedCredit: 50, towardOldBalance: 25 })
    expect(readerChoiceParams(50, 'save', null)).toEqual({ useCredit: false, expectedCredit: 50 })
    expect(readerChoiceParams(50, null, null)).toEqual({})
    expect(readerQuoteQuery(50, 'use', null)).toBe('?useCredit=true&expectedCredit=50')
    expect(readerQuoteQuery(0, null, null)).toBe('')
  })
  it('takes one lease at a time, each on one of its own charges', () => {
    const q = quote({ rows: [row({ id: 'a', leaseId: 'L1', unitNumber: 'RV 1' }), row({ id: 'b', leaseId: 'L2', unitNumber: 'RV 2' }), row({ id: 'c', leaseId: 'L1' })] })
    expect(readerLeases(q)).toEqual([
      { leaseId: 'L1', anchorId: 'a', unitNumber: 'RV 1', label: 'Space RV 1' },
      { leaseId: 'L2', anchorId: 'b', unitNumber: 'RV 2', label: 'Space RV 2' },
    ])
    expect(readerLeases(quote())).toEqual([{ leaseId: 'L1', anchorId: 'r1', unitNumber: 'MH 04', label: null }])
  })
  it('a space taken on the reader stays listed, as it was, after the bill is read again without it — and the other space keeps its name', () => {
    // RV 1 was taken; the bill read again lists only RV 2.
    const after = quote({ rows: [row({ id: 'b', leaseId: 'L2', unitNumber: 'RV 2' })] })
    expect(readerLeases(after, [{ leaseId: 'L1', anchorId: 'a', unitNumber: 'RV 1' }])).toEqual([
      { leaseId: 'L1', anchorId: 'a', unitNumber: 'RV 1', label: 'Space RV 1' },
      { leaseId: 'L2', anchorId: 'b', unitNumber: 'RV 2', label: 'Space RV 2' },
    ])
    // Its old balance still open: the space is listed once, as it was when taken.
    const oldLeft = quote({ rows: [row({ id: 'b', leaseId: 'L2', unitNumber: 'RV 2' })],
      oldBalance: [row({ id: 'c', leaseId: 'L1', unitNumber: 'RV 1', type: 'carried_balance' })] })
    expect(readerLeases(oldLeft, [{ leaseId: 'L1', anchorId: 'a', unitNumber: 'RV 1' }]).map(s => [s.leaseId, s.anchorId]))
      .toEqual([['L1', 'a'], ['L2', 'b']])
  })
  it('a household paid on the reader and at the desk in one visit hears both', () => {
    expect(withReaderTaken('Recorded $460.00 from Kim Harland.', 476.65))
      .toBe('Took $476.65 by card on the reader. Recorded $460.00 from Kim Harland.')
    expect(withReaderTaken('Recorded $460.00 from Kim Harland.', 0)).toBe('Recorded $460.00 from Kim Harland.')
  })
  it('every space taken on the reader: what was taken, and an old balance still open is said', () => {
    const paid = quote({ rows: [], oldBalance: [] })
    expect(readerFinishedMessage('Kim', 476.65, paid)).toBe('Took $476.65 by card on the reader from Kim.')
    const oldLeft = quote({ rows: [], oldBalance: [row({ id: 'o', type: 'carried_balance', amount: 200 })] })
    expect(readerFinishedMessage('Kim', 476.65, oldLeft))
      .toBe('Took $476.65 by card on the reader from Kim. Their $200.00 old balance is still open (it is paid last) — use Record payment again to take it.')
    const moreLeft = quote({ rows: [row({ id: 'w', type: 'utility', amount: 40 })], oldBalance: [row({ id: 'o', type: 'carried_balance', amount: 200 })] })
    expect(readerFinishedMessage('Kim', 476.65, moreLeft))
      .toBe('Took $476.65 by card on the reader from Kim. $240.00 is still open — use Record payment again to take it.')
    // The read after the last card failed: nothing more is claimed.
    expect(readerFinishedMessage('Kim', 476.65, null)).toBe('Took $476.65 by card on the reader from Kim.')
  })
})

describe('posting a payment that arrived before its bill', () => {
  it('a check or money order asks "is it really $X?"; cash does not', () => {
    expect(postConfirmQuestion('check', 92000)).toBe('Is the check really $920.00? Check the amount written on it. It pays what is open first, oldest bill first; anything over what is owed is kept on their account as paid ahead.')
    expect(postConfirmQuestion('cash', 92000)).toBeNull()
  })
  it('a check or money order needs its number; cash does not', () => {
    expect([numberRequired('check'), numberRequired('money_order'), numberRequired('cash')]).toEqual([true, true, false])
  })
})

describe('the tenant page shows total credit and usable credit', () => {
  it('says the total on their account and how much of it can pay now', () => {
    expect(tenantCreditHeadline({ total: 460, usable: 10, paidAhead: 450, fromLandlord: 10, depositInterest: 0 }))
      .toBe('$460.00 on their account — $10.00 of it can pay what they owe now.')
    expect(tenantCreditHeadline({ total: 37.6, usable: 37.6, paidAhead: 37.6, fromLandlord: 0, depositInterest: 0 }))
      .toBe('$37.60 on their account — all of it can pay what they owe now.')
    expect(tenantCreditHeadline({ total: 0, usable: 0, paidAhead: 0, fromLandlord: 0, depositInterest: 0 })).toBeNull()
    // Todd: $460 paid ahead and nothing owed yet — it waits for a bill.
    expect(tenantCreditHeadline({ total: 460, usable: 0, paidAhead: 460, fromLandlord: 0, depositInterest: 0 }))
      .toBe('$460.00 on their account. Nothing they owe right now can be paid from it.')
  })
  it('names each kind, deposit interest as statutory interest, and leaves out an empty kind', () => {
    expect(tenantCreditLines({ total: 75, usable: 75, paidAhead: 50, fromLandlord: 0, depositInterest: 25 })).toEqual([
      { label: 'Paid ahead', amount: 50 },
      { label: 'Statutory interest on their deposit', amount: 25 },
    ])
  })
})

describe('the Payments ledger (decisions #26, #29)', () => {
  it('says why a payment came back in words, with the bank code beside it and the zero-tolerance mark', () => {
    expect(returnDetail({ returnCode: 'R01', returnReason: 'Insufficient funds', zeroToleranceFlag: false }))
      .toEqual({ text: 'Bank return: there was not enough money in the account (R01)', zeroTolerance: false })
    expect(returnDetail({ returnCode: 'R10', zeroToleranceFlag: true }))
      .toEqual({ text: 'Bank return: the account holder told the bank this debit was not authorized (R10)', zeroTolerance: true })
    expect(returnDetail({ returnCode: 'card_dispute' })).toEqual({ text: 'Card dispute', zeroTolerance: false })
    expect(returnDetail({ returnCode: 'R16', returnReason: 'Account frozen' })).toEqual({ text: 'Returned: Account frozen (R16)', zeroTolerance: false })
    expect(returnDetail({ returnCode: null })).toBeNull()
    expect(returnDetail(undefined)).toBeNull()
  })
  it('reads the return details page by page until every returned charge is found (a month can be more than one page)', async () => {
    const pages: Record<number, Array<{ id: string; returnCode?: string }>> = {
      1: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
      2: [{ id: 'd' }, { id: 'x', returnCode: 'R01' }, { id: 'e' }],
      3: [{ id: 'f' }, { id: 'y', returnCode: 'R10' }],
    }
    const asked: number[] = []
    const got = await readChargesById(async page => { asked.push(page); return pages[page] ?? [] }, new Set(['x', 'y']), 3)
    expect(got.complete).toBe(true)
    expect(got.rows.map(r => r.id)).toEqual(['x', 'y'])
    expect(asked).toEqual([1, 2, 3])
  })
  it('stops reading as soon as every returned charge is found', async () => {
    const asked: number[] = []
    const got = await readChargesById(async page => { asked.push(page); return [{ id: 'x' }, { id: 'z' }] }, new Set(['x']), 2)
    expect(asked).toEqual([1])
    expect(got).toEqual({ rows: [{ id: 'x' }], complete: true })
  })
  it('a short page is the last one; a charge never found there is simply not readable', async () => {
    const asked: number[] = []
    const got = await readChargesById(async page => { asked.push(page); return page === 1 ? [{ id: 'a' }, { id: 'b' }] : [{ id: 'c' }] }, new Set(['q']), 2)
    expect(asked).toEqual([1, 2])
    expect(got).toEqual({ rows: [], complete: true })
  })
  it('says the read is incomplete only when the page limit stopped it with charges still missing', async () => {
    const got = await readChargesById(async () => [{ id: 'a' }, { id: 'b' }], new Set(['q']), 2, 3)
    expect(got.complete).toBe(false)
  })
  it('reads return details for the whole months of the bills that came back', () => {
    expect(chargeMonthsRange(['2026-09-01', '2026-08-15'])).toEqual({ from: '2026-08-01', to: '2026-09-30' })
    expect(chargeMonthsRange(['2026-02-01'])).toEqual({ from: '2026-02-01', to: '2026-02-28' })
    expect(chargeMonthsRange([])).toBeNull()
  })
  it('titles a month and a day as calendar dates, never shifted by time zone', () => {
    expect(monthTitle('2026-09')).toBe('September 2026')
    expect(monthWord('2026-08', '2026-10-03')).toBe('August')
    expect(dayWord('2026-10-01', '2026')).toBe('Oct 1')
    expect(dayWord('2025-12-31', '2026')).toBe('Dec 31, 2025')
    expect(dayWord(null)).toBe('—')
  })
})

describe('days on the tenant page are calendar days, never shifted by time zone', () => {
  it('today is this device’s calendar day, even late in the evening', () => {
    expect(localToday(new Date(2026, 9, 3, 23, 30))).toBe('2026-10-03')
    expect(localToday(new Date(2026, 0, 1, 0, 5))).toBe('2026-01-01')
  })
  it('a due date is its own day whether it comes as a day or as midnight in any zone', () => {
    expect(calendarDay('2026-10-01')).toBe('2026-10-01')
    expect(calendarDay('2026-10-01T00:00:00.000Z')).toBe('2026-10-01')
    expect(calendarDay('2026-10-01T07:00:00.000Z')).toBe('2026-10-01')
    expect(calendarDay(null)).toBeNull()
  })
  it('the day a payment settled is the day on this device, not the UTC day', () => {
    const evening = new Date(2026, 9, 1, 18, 0)          // Oct 1, 6 pm here
    expect(localDayOf(evening.toISOString())).toBe('2026-10-01')
    expect(localDayOf('2026-10-01')).toBe('2026-10-01')
    expect(localDayOf('not a day')).toBeNull()
  })
})

// 10/12 (Nic): the tenant page's per-charge timeliness window (which counted
// days late from the due date, with no grace) is gone — the Payment Health
// card opens the household's payment report, where how late is days past the
// grace period (the server's one rule).
describe('the desk says every charge status in words', () => {
  it('a voided charge reads as voided in a refusal', () => {
    expect(plainRefusal('This charge is not open (status: voided)')).toBe('This charge is no longer open — it is voided now.')
  })
  it('every payment status in the shared list has its own words', () => {
    for (const st of PAYMENT_STATUSES) expect(PAYMENT_STATUS_LABEL[st]).toBeTruthy()
  })
})

describe('awaitingOpensAtWord — the hour a card hold opens the bill at the desk', () => {
  // 21:45 UTC = 2:45 PM in Phoenix (no daylight time) = 4:45 PM in Chicago (CDT).
  const confirmBy = '2026-10-04T21:45:00.000Z'

  it('is said on the property\'s clock when the quote names its time zone, whatever the browser\'s zone', () => {
    expect(awaitingOpensAtWord({ confirmBy, timezone: 'America/Phoenix' })).toBe('2:45 PM')
    expect(awaitingOpensAtWord({ confirmBy, timezone: 'America/Chicago' })).toBe('4:45 PM')
  })

  it('without a time zone, the browser\'s clock names its zone, so it is never a bare time that disagrees with the park\'s', () => {
    expect(awaitingOpensAtWord({ confirmBy })).toMatch(/^\d{1,2}:\d{2} [AP]M \S+$/)
    expect(awaitingOpensAtWord({ confirmBy, timezone: null })).toMatch(/^\d{1,2}:\d{2} [AP]M \S+$/)
  })

  it('an unknown time zone falls back to the browser\'s clock with its zone named, never throwing', () => {
    expect(awaitingOpensAtWord({ confirmBy, timezone: 'Not/AZone' })).toMatch(/^\d{1,2}:\d{2} [AP]M \S+$/)
  })
})

// ─── 10/5 (Nic): bank deposits and part payments ─────────────────────────────

import {
  planTender as planTender105, partialPlan, billName, stillOwedText, numberRequired as numberRequired105,
  numberMissingMessage, depositPhotoProblem, postConfirmQuestion as postConfirmQuestion105, lateFeesBackOnShortBills,
  type DeskQuote as DeskQuote105,
} from './creditDesk'

const bill105 = (rows: Array<{ id: string; type: string; amount: number; dueDate: string; creditIfUsed?: number }>,
                 over: Partial<DeskQuote105> = {}): DeskQuote105 => {
  const total = rows.reduce((t, r) => t + r.amount, 0)
  return {
    anchorPaymentId: rows[0]?.id ?? 'x', anchorOpen: true, paymentsPaused: false,
    rows: rows.map(r => ({ leaseId: 'L1', entryDescription: null, creditAlreadyApplied: 0, notes: null, unitNumber: null, propertyName: null, ...r })),
    currentTotal: total, oldBalance: [], oldBalanceTotal: 0, payOnline: [], payOnlineTotal: 0, paused: [], pausedTotal: 0,
    clearing: 0, creditAlreadyApplied: 0, creditAvailable: 0, creditSetAsideElsewhere: 0, creditOnFile: 0,
    owedIfUsed: total, owedIfSaved: total, fullBalance: total, scheduledRetries: [], ...over,
  }
}
const tender105 = (q: DeskQuote105, method: any, cents: number) => planTender105(q, {
  method, tenderedCents: cents, choice: null, towardOldCents: null, surplusHandling: null, writtenConfirmed: false,
  nameOf: r => (r.type === 'rent' ? 'Rent' : r.type === 'utility' ? 'Water' : r.type),
})

describe('10/5: a bank deposit is identified by the reference on the bank\'s receipt', () => {
  it('the number is required for a check, a money order and a bank deposit — never cash', () => {
    expect(numberRequired105('bank_deposit')).toBe(true)
    expect(numberRequired105('check')).toBe(true)
    expect(numberRequired105('cash')).toBe(false)
    expect(numberMissingMessage('bank_deposit')).toMatch(/deposit reference number from the bank's receipt/)
    expect(numberMissingMessage('money_order')).toBe('Enter the money order number — it is the receipt if the payment is ever questioned.')
  })
  it('a bank deposit over the bill is confirmed against the bank\'s receipt, and kept as credit — never change', () => {
    const q = bill105([{ id: 'r1', type: 'rent', amount: 600, dueDate: '2026-10-01' }])
    const ask = tender105(q, 'bank_deposit', 65000)
    expect(ask.stop).toBe('written_confirm')
    expect(ask.message).toBe("You typed $650.00 against $600.00 owed — is the bank deposit really $650.00? Check the amount on the bank's receipt, then confirm.")
    const ok = planTender105(q, { method: 'bank_deposit', tenderedCents: 65000, choice: null, towardOldCents: null, surplusHandling: null, writtenConfirmed: true })
    expect(ok.stop).toBeNull()
    expect(ok.changeCents).toBe(0)
    expect(ok.keptAsCreditCents).toBe(5000)
    expect(ok.body).toEqual({ method: 'bank_deposit', amountTendered: 650, surplusHandling: 'credit', confirmWrittenAmount: true })
    expect(postConfirmQuestion105('bank_deposit', 30000)).toMatch(/^Is the bank deposit really \$300\.00\? Check the amount on the bank's receipt\./)
  })
  it('the photo: images only, within the size limit', () => {
    expect(depositPhotoProblem(null)).toBeNull()
    expect(depositPhotoProblem({ type: 'image/jpeg', size: 1000 })).toBeNull()
    expect(depositPhotoProblem({ type: 'image/heic', size: 1000 })).toBeNull()
    expect(depositPhotoProblem({ type: 'application/pdf', size: 1000 })).toMatch(/Choose a photo/)
    expect(depositPhotoProblem({ type: 'image/png', size: 50 * 1024 * 1024 })).toMatch(/too large/)
  })
})

describe('10/5: part payments, where the property takes them', () => {
  const oct = { id: 'r1', type: 'rent', amount: 600, dueDate: '2026-10-01' }
  it('off: short is refused, as before', () => {
    const p = tender105(bill105([oct]), 'cash', 50000)
    expect(p.stop).toBe('short')
    expect(p.message).toBe('That is $100.00 short — $500.00 against $600.00 owed. Rent is paid in full.')
  })
  it('on: short is recorded, and the window says what stays owed', () => {
    const p = tender105(bill105([oct], { partialPaymentsAllowed: true }), 'bank_deposit', 50000)
    expect(p.stop).toBeNull()
    expect(p.stillOwedCents).toBe(10000)
    expect(p.stillOwedText).toBe('$100.00 stays owed on October rent — late fees still apply.')
    expect(p.body).toEqual({ method: 'bank_deposit', amountTendered: 500 })
    expect(p.changeCents).toBe(0)
  })
  it('the oldest bill is paid first, a rent bill in part, and a bill that cannot be paid in part is passed by', () => {
    const q = bill105([
      { id: 's', type: 'rent', amount: 600, dueDate: '2026-09-01' },
      { id: 'w', type: 'utility', amount: 50, dueDate: '2026-09-01' },
      { id: 'o', type: 'rent', amount: 600, dueDate: '2026-10-01' },
    ], { partialPaymentsAllowed: true })
    // $620: September rent in full; September water ($50) cannot be paid in part — passed by; $20 to October rent.
    expect(partialPlan(q, null, 62000, r => (r.type === 'rent' ? 'Rent' : 'Water'))).toEqual({ stillOwedCents: 63000, names: ['September water', 'October rent'], toOldCents: 0, keptCents: 0, keptOnBalanceCents: 0, shortInvoiceIds: [] })
    expect(tender105(q, 'cash', 62000).stillOwedText).toBe('$630.00 stays owed on September water and October rent — late fees still apply.')
  })
  it('with Use, the credit the plan spends on each charge comes off it first', () => {
    const q = bill105([{ ...oct, creditIfUsed: 50 }], { partialPaymentsAllowed: true, creditAvailable: 50, owedIfUsed: 550 })
    const p = planTender105(q, { method: 'cash', tenderedCents: 50000, choice: 'use', towardOldCents: null, surplusHandling: null,
      writtenConfirmed: false, answeredCreditCents: 5000, nameOf: () => 'Rent' })
    expect(p.stop).toBeNull()
    expect(p.stillOwedText).toBe('$50.00 stays owed on October rent — late fees still apply.')
    expect(p.body).toEqual({ method: 'cash', amountTendered: 500, creditToUse: 50 })
  })
  // 10/5 (Nic): a bank deposit dated back that pays a bill only in part — the
  // late fees the window left off THAT bill go back on it; a bill paid in full keeps them off.
  it('a dated-back deposit paid in part: the short bill\'s own late fees are added back to what stays owed', () => {
    const q = bill105([
      { id: 's', type: 'rent', amount: 600, dueDate: '2026-09-01', invoiceId: 'INV-SEP' } as any,
      { id: 'o', type: 'rent', amount: 600, dueDate: '2026-10-01', invoiceId: 'INV-OCT' } as any,
    ], {
      partialPaymentsAllowed: true, lateFeesOffIfPaidInFull: 50,
      lateFeesOffByBill: [{ invoiceId: 'INV-SEP', amount: 25 }, { invoiceId: 'INV-OCT', amount: 25 }],
    })
    const p = tender105(q, 'bank_deposit', 90000)
    expect(p.shortInvoiceIds).toEqual(['INV-OCT'])
    expect(p.stillOwedNames).toEqual(['October rent'])
    expect(lateFeesBackOnShortBills(q, p.shortInvoiceIds)).toBe(2500)
    expect(stillOwedText(p.stillOwedCents + 2500, p.stillOwedNames)).toBe('$325.00 stays owed on October rent — late fees still apply.')
  })
  it('names a bill by its month and what it is', () => {
    expect(billName('2026-10-01', 'Rent')).toBe('October rent')
    expect(billName('2026-09-15', 'Water · Aug 1–31')).toBe('September water')
    expect(stillOwedText(2500, [])).toBe('$25.00 stays owed — late fees still apply.')
  })
})

// ─── 10/6 (Nic): credit against the whole balance; no credit talk on a part payment ──

import {
  partPaymentLines, backdatedLateFeeText, deskBillBalance, CREDIT_USE_RULE,
} from './creditDesk'
import { placePartPayment } from '@gam/shared'

describe('10/6 (Nic): a part payment never turns into credit while the balance is owed', () => {
  // The Bowmans (Country Acres MH 30): $450 rent, $39.60 water, $100 home payment, $50 late fee.
  const bowmans = bill105([
    { id: 'r', type: 'rent', amount: 450, dueDate: '2026-10-01', invoiceId: 'INV-OCT' } as any,
    { id: 'w', type: 'utility', amount: 39.60, dueDate: '2026-10-01', invoiceId: 'INV-OCT' } as any,
    { id: 'h', type: 'home_payment', amount: 100, dueDate: '2026-10-01', invoiceId: 'INV-OCT' } as any,
    { id: 'f', type: 'late_fee', amount: 50, dueDate: '2026-10-06', invoiceId: 'INV-OCT' } as any,
  ], { partialPaymentsAllowed: true })

  it('the Bowmans\' $500: the lines that cannot be paid in part are paid, the rent takes the rest — $139.60 stays owed, nothing kept', () => {
    const p = tender105(bowmans, 'bank_deposit', 50000)
    expect(p.stop).toBeNull()
    expect(p.stillOwedCents).toBe(13960)
    expect(p.keptAsCreditCents).toBe(0)
    expect(p.toOldCents).toBe(0)
    expect(p.stillOwedNames).toEqual(['October rent'])
    expect(p.body).toEqual({ method: 'bank_deposit', amountTendered: 500 })
  })

  it('what the window says: owed, paying, what stays owed, late fees still apply — and never "credit"', () => {
    const p = tender105(bowmans, 'bank_deposit', 50000)
    const lines = partPaymentLines({ owedCents: p.owedCents, payingCents: 50000, stillOwedCents: p.stillOwedCents, names: p.stillOwedNames,
      toOldCents: p.toOldCents, keptCents: p.keptAsCreditCents })
    expect(lines).toEqual(['Owed $639.60', 'Paying $500.00', 'Stays owed $139.60 on October rent — late fees still apply.'])
    expect(lines.join(' ')).not.toMatch(/credit/i)
  })

  it('placePartPayment: the rent on the bill a line was passed on is paid last on that bill; with no rent to take it, the rest is left', () => {
    const rows = [{ id: 'r', type: 'rent', invoiceId: 'OCT' }, { id: 'w', type: 'utility', invoiceId: 'OCT' }, { id: 'h', type: 'home_payment', invoiceId: 'OCT' }]
    const owed: Record<string, number> = { r: 45000, w: 3960, h: 10000 }
    const p = placePartPayment(rows, r => owed[r.id], 50000)
    expect(p.left).toBe(0)
    expect(p.partSplits).toEqual([{ row: rows[0], take: 36040, owedOnRow: 45000 }])
    expect(p.paid.map(x => [x.row.id, x.cents])).toEqual([['w', 3960], ['h', 10000], ['r', 36040]])
    expect(p.notReached).toEqual([])
    const noRent = placePartPayment(rows.slice(1), r => owed[r.id], 5000)
    expect(noRent).toMatchObject({ left: 1040, notReached: [rows[2]] })
  })

  it('placePartPayment (review fix): oldest bill first — an older bill\'s rent is never moved behind a newer bill', () => {
    // September rent paid in full, then October's utility and late fee. The
    // late fee cannot be paid in part, but September's rent is on another
    // bill: it is never left owing so October can be paid. What is left over
    // is left (it goes on the rest of the balance as money paid ahead).
    const rows = [
      { id: 'sepRent', type: 'rent', invoiceId: 'SEP' },
      { id: 'octUtil', type: 'utility', invoiceId: 'OCT' },
      { id: 'octFee', type: 'late_fee', invoiceId: 'OCT' },
    ]
    const owed: Record<string, number> = { sepRent: 45000, octUtil: 2000, octFee: 5000 }
    const p = placePartPayment(rows, r => owed[r.id], 48000)
    expect(p.paid.map(x => [x.row.id, x.cents])).toEqual([['sepRent', 45000], ['octUtil', 2000]])
    expect(p.partSplits).toEqual([])
    expect(p.notReached).toEqual([rows[2]])
    expect(p.left).toBe(1000)
  })

  it('placePartPayment (review fix): a moved rent goes last on its OWN bill, before any newer bill', () => {
    // October: rent, home payment, late fee. November: a utility. The rent is
    // paid last on October's bill — never after November's utility.
    const rows = [
      { id: 'octRent', type: 'rent', invoiceId: 'OCT' },
      { id: 'octHome', type: 'home_payment', invoiceId: 'OCT' },
      { id: 'octFee', type: 'late_fee', invoiceId: 'OCT' },
      { id: 'novUtil', type: 'utility', invoiceId: 'NOV' },
    ]
    const owed: Record<string, number> = { octRent: 45000, octHome: 10000, octFee: 5000, novUtil: 2000 }
    const p = placePartPayment(rows, r => owed[r.id], 48000)
    expect(p.paid.map(x => [x.row.id, x.cents])).toEqual([['octHome', 10000], ['octFee', 5000], ['octRent', 33000]])
    expect(p.notReached).toEqual([rows[3]])
    expect(p.left).toBe(0)
  })

  it('a backdated deposit says nothing about late fees until the amount typed pays that bill in full', () => {
    const q = { ...bowmans, lateFeesOffIfPaidInFull: 50, lateFeesOffByBill: [{ invoiceId: 'INV-OCT', amount: 50 }] }
    const part = tender105(q, 'bank_deposit', 50000)
    expect(backdatedLateFeeText(q, part, '2026-10-05', 50000)).toBeNull()       // paid only in part: nothing
    expect(backdatedLateFeeText(q, part, '2026-10-05', null)).toBeNull()        // nothing typed: nothing
    const full = tender105({ ...q, rows: q.rows.filter(r => r.type !== 'late_fee'), currentTotal: 589.60, owedIfSaved: 589.60, owedIfUsed: 589.60 },
      'bank_deposit', 58960)
    expect(backdatedLateFeeText(q, full, '2026-10-05', 58960)).toBe(
      `Deposited ${dayWord('2026-10-05')}, before $50.00 in late fees were charged. This pays the bill in full, so those late fees are credited; `
      + 'the payment still counts as late on their history. When your bank feed shows this deposit, the bank\'s date decides.')
  })
})

describe('10/6 (Nic): credit goes on the bill, never held back by the pay-in-full rule', () => {
  const oct = { id: 'r1', type: 'rent', amount: 300, dueDate: '2026-10-01' }
  it('"Use" with nothing handed over applies credit that pays only part, even where part payments are off', () => {
    const q = bill105([{ ...oct, creditIfUsed: 100 }], { partialPaymentsAllowed: false, creditAvailable: 100, owedIfUsed: 200, owedIfSaved: 300 })
    const p = planTender105(q, { method: 'cash', tenderedCents: 0, choice: 'use', towardOldCents: null, surplusHandling: null,
      writtenConfirmed: false, answeredCreditCents: 10000, nameOf: () => 'Rent' })
    expect(p.stop).toBeNull()
    expect(p.stillOwedCents).toBe(20000)
    expect(p.body).toEqual({ method: 'cash', amountTendered: 0, creditToUse: 100 })
  })
  it('their own short cash is still refused where part payments are off', () => {
    const q = bill105([{ ...oct, creditIfUsed: 100 }], { partialPaymentsAllowed: false, creditAvailable: 100, owedIfUsed: 200, owedIfSaved: 300 })
    const p = planTender105(q, { method: 'cash', tenderedCents: 15000, choice: 'use', towardOldCents: null, surplusHandling: null,
      writtenConfirmed: false, answeredCreditCents: 10000, nameOf: () => 'Rent' })
    expect(p.stop).toBe('short')
  })
  it('the bill as one balance: charges, credit applied, still owed (Marc: $300, −$282.36, $17.64)', () => {
    expect(deskBillBalance({ currentTotal: 300, creditAlreadyApplied: 282.36 })).toEqual({ charges: 30000, creditApplied: 28236, stillOwed: 1764 })
    expect(deskBillBalance({ currentTotal: 460, creditAlreadyApplied: 0 })).toEqual({ charges: 46000, creditApplied: 0, stillOwed: 46000 })
  })
  it('the rule as landlords read it: paid-ahead money goes on by itself, part of a bill allowed', () => {
    expect(CREDIT_USE_RULE).toMatch(/^Money they paid ahead goes on their balance by itself, oldest bill first — on part of a bill when it cannot pay all of it\./)
  })
})

import { postAheadText } from './creditDesk'

describe('review fix (10/6): no credit talk while a balance is owed, and no "paid the bill" for part of one', () => {
  it('credit that pays only part of the bill is "applied", never "paid the bill"', () => {
    expect(recordedMessage('Marc', { amountSettled: 0, creditUsed: 282.36, stillOwed: 17.64, stillOwedNames: ['October rent'] }))
      .toBe("Applied $282.36 of Marc's credit — $17.64 stays owed on October rent — late fees still apply.")
    // Paid in full by credit: still "paid the bill".
    expect(recordedMessage('Todd', { amountSettled: 0, creditUsed: 460 })).toBe("Paid Todd's bill with their credit.")
  })

  it('a part payment\'s leftover is said as going on the rest of what they owe — never "kept as credit"', () => {
    const msg = recordedMessage('Pat', {
      amountSettled: 470, surplus: 10, creditId: 'c', leftoverOnBalance: 10, stillOwed: 40, stillOwedNames: ['October late fee'],
    })
    expect(msg).toBe('Recorded $470.00 from Pat — $10.00 went on the rest of what they owe — $40.00 stays owed on October late fee — late fees still apply.')
    expect(msg).not.toMatch(/credit/i)
    // Nothing open can take it (only a home payment is left): kept toward the next bill, still not "credit".
    const kept = recordedMessage('Pat', { amountSettled: 470, surplus: 10, creditId: 'c', leftoverOnBalance: 0, stillOwed: 100, stillOwedNames: ['October home payment'] })
    expect(kept).toBe('Recorded $470.00 from Pat — $10.00 kept toward their next bill — $100.00 stays owed on October home payment — late fees still apply.')
  })

  it('partPaymentLines: leftover an open line takes goes on the rest of what they owe', () => {
    expect(partPaymentLines({ owedCents: 52000, payingCents: 48000, stillOwedCents: 4000, names: ['October late fee'], keptCents: 1000, keptOnBalanceCents: 1000 }))
      .toEqual(['Owed $520.00', 'Paying $480.00', 'Stays owed $40.00 on October late fee — late fees still apply.', '$10.00 of it goes on the rest of what they owe.'])
    expect(partPaymentLines({ owedCents: 52000, payingCents: 48000, stillOwedCents: 5000, names: ['October home payment'], keptCents: 1000, keptOnBalanceCents: 0 })[3])
      .toBe('$10.00 of it cannot go on what is left (only rent can be paid in part), so it is kept toward their next bill.')
  })

  it('Post a payment speaks of money kept ahead only when the amount is more than they owe', () => {
    expect(postAheadText(null, 300)).toBeNull()
    expect(postAheadText(30000, 300)).toBeNull()
    expect(postAheadText(20000, 300)).toBeNull()
    expect(postAheadText(40000, 300)).toBe('They owe $300.00 now. That is paid first; the other $100.00 is kept as paid ahead and goes on their bills by itself as they come.')
    expect(postAheadText(40000, 0)).toBe('They owe nothing now. The $400.00 is kept as paid ahead and goes on their bills by itself as they come.')
    expect(postAheadText(40000, undefined)).toBeNull()
  })
})

describe('10/14 (Nic): the desk ticks the bills — each invoice is its own thing', () => {
  // Billy Miranda: RV 34 and RV 35, two leases, a September and an October bill each.
  const b = (id: string, leaseId: string, unit: string, dueDate: string, older: string[] = []): DeskQuoteBill => ({
    id, leaseId, unitNumber: unit, dueDate, total: 100, creditAlreadyApplied: 0, owed: 100, olderBillIds: older,
    rows: [row({ id: `${id}-rent`, leaseId, unitNumber: unit, dueDate, invoiceId: id })],
  })
  const bills = [
    b('34sep', 'L34', 'RV 34', '2026-09-01'), b('35sep', 'L35', 'RV 35', '2026-09-01'),
    b('34oct', 'L34', 'RV 34', '2026-10-01', ['34sep']), b('35oct', 'L35', 'RV 35', '2026-10-01', ['35sep']),
  ]

  it('lists the bills by space, oldest first, named by month', () => {
    const g = billsBySpace(bills)
    expect(g.map(x => [x.label, x.bills.map(y => y.id)])).toEqual([['Space RV 34', ['34sep', '34oct']], ['Space RV 35', ['35sep', '35oct']]])
    expect(pickBillName(bills[2])).toBe('October bill')
  })

  it('October waits for September within a space; the other space is independent', () => {
    expect(canPickBill(bills[2], [])).toBe(false)
    expect(canPickBill(bills[2], ['34sep'])).toBe(true)
    expect(canPickBill(bills[2], ['35sep'])).toBe(false)
    // A newer bill whose older bill is not ticked stays unticked.
    expect(togglePick(bills, [], '34oct')).toEqual([])
    expect(togglePick(bills, [], '34sep')).toEqual(['34sep'])
    expect(togglePick(bills, ['34sep'], '34oct')).toEqual(['34sep', '34oct'])
    // RV 35 alone, without touching RV 34.
    expect(togglePick(bills, [], '35sep')).toEqual(['35sep'])
  })

  it('unticking a bill unticks the newer bills of its space, and only those', () => {
    expect(togglePick(bills, ['34sep', '35sep', '34oct', '35oct'], '34sep')).toEqual(['35sep', '35oct'])
    expect(togglePick(bills, ['34sep', '34oct'], '34oct')).toEqual(['34sep'])
  })

  it('a ticked bill paid meanwhile drops off; Record waits for a read of exactly the bills ticked', () => {
    expect(picksStillOpen(bills.slice(1), ['34sep', '35sep'])).toEqual(['35sep'])
    expect(quoteMatchesPick({ bills, pickedBillIds: ['35sep', '34sep'] }, ['34sep', '35sep'])).toBe(true)
    expect(quoteMatchesPick({ bills, pickedBillIds: ['34sep'] }, ['34sep', '35sep'])).toBe(false)
    expect(quoteMatchesPick({ bills, pickedBillIds: [] }, [])).toBe(true)
    // An older server sends no bills: nothing to match.
    expect(quoteMatchesPick({ pickedBillIds: undefined }, ['x'])).toBe(true)
  })

  it('nothing ticked: Record still has a charge to post to, and the reader still lists every space', () => {
    const q = quote({ rows: [], anchorOpen: false, bills })
    expect(postAnchor(q)).toBe('34sep-rent')
    expect(readerLeases(q).map(x => x.leaseId)).toEqual(['L34', 'L35'])
  })
})
