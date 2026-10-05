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
  creditChoiceNeeded, creditToUseFor, deskOwedCents, oldBalanceOwedCents, postAnchor, planTender, recordedMessage,
  serverMessage, serverStatus, readerChoiceParams, readerQuoteQuery, readerReady, readerLeases, withReaderTaken, readerFinishedMessage,
  postConfirmQuestion, numberRequired, tenantCreditLines, tenantCreditHeadline,
  readShowLineItems, writeShowLineItems, ledgerMatches, stillOweLine,
  deskFigures, sameFigures, figuresMovedMessage, payerHits, matchPayerHits, returnDetail, chargeMonthsRange,
  readChargesById, plainRefusal, localToday, calendarDay, localDayOf, chargeTimeliness, awaitingOpensAtWord,
  type DeskQuote, type DeskQuoteRow, type TenderInput, type OutstandingRow, type LedgerPayment, type PickerLease,
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
    expect(daysLateText(1)).toBe('1 day late')
    expect(daysLateText(12)).toBe('12 days late')
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
    expect(postConfirmQuestion('check', 92000)).toBe('Is the check really $920.00? Check the amount written on it. What is open is paid first; the rest is kept on their account as paid ahead.')
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
  const p: LedgerPayment = {
    id: 'x', name: 'Jane Doe', unitNumber: 'RV 14', propertyName: 'Mountain View', paidOn: '2026-10-01',
    owed: 925, amount: 925, creditApplied: 0, returned: 0, creditReturned: 0, methodLabel: 'Card', status: 'settled',
    statusLabel: 'Paid', paidFor: 'October rent', daysLate: 0, timingLabel: 'On time',
  }
  it('searches who, where and what it paid for', () => {
    expect(ledgerMatches(p, 'jane')).toBe(true)
    expect(ledgerMatches(p, 'rv 14')).toBe(true)
    expect(ledgerMatches(p, 'october')).toBe(true)
    expect(ledgerMatches(p, 'trash')).toBe(false)
  })
  it('the current month points to Outstanding Balances with a count, never dollars', () => {
    expect(stillOweLine(3)).toBe('3 households still owe — see Outstanding Balances')
    expect(stillOweLine(1)).toBe('1 household still owes — see Outstanding Balances')
    expect(stillOweLine(0)).toBeNull()
    expect(stillOweLine(null)).toBeNull()
  })
  it('remembers Show line items per person, off by default', () => {
    const data: Record<string, string> = {}
    const store = { getItem: (k: string) => data[k] ?? null, setItem: (k: string, v: string) => { data[k] = v } }
    expect(readShowLineItems('u1', store)).toBe(false)
    writeShowLineItems('u1', true, store)
    expect(readShowLineItems('u1', store)).toBe(true)
    expect(readShowLineItems('u2', store)).toBe(false)
  })
  it('blocked storage never breaks the page (the toggle just is not remembered)', () => {
    const broken = { getItem: () => { throw new Error('blocked') }, setItem: () => { throw new Error('blocked') } }
    expect(readShowLineItems('u1', broken)).toBe(false)
    expect(() => writeShowLineItems('u1', true, broken)).not.toThrow()
    expect(readShowLineItems('u1', null)).toBe(false)
  })
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

describe('how on time each charge was (the tenant page’s timeliness window)', () => {
  const today = '2026-10-10'
  it('paid on the due day in the evening is on time; days after are late', () => {
    const evening = new Date(2026, 9, 1, 18, 0).toISOString()
    expect(chargeTimeliness({ status: 'settled', dueDate: '2026-10-01', settledAt: evening }, today))
      .toMatchObject({ late: 0, label: 'On time', tone: 'good' })
    const later = new Date(2026, 9, 4, 9, 0).toISOString()
    expect(chargeTimeliness({ status: 'settled', dueDate: '2026-10-01', settledAt: later }, today))
      .toMatchObject({ late: 3, label: '3 days late', tone: 'warn' })
  })
  it('an open charge past due is overdue by the days since', () => {
    expect(chargeTimeliness({ status: 'pending', dueDate: '2026-10-01' }, today)).toMatchObject({ late: 9, label: '9 days overdue', tone: 'bad' })
    expect(chargeTimeliness({ status: 'pending', dueDate: '2026-10-15' }, today)).toMatchObject({ late: 0, label: 'Not paid yet' })
  })
  it('a payment clearing or a charge paid from the deposit is never overdue, and every status is said in words', () => {
    expect(chargeTimeliness({ status: 'processing', dueDate: '2026-10-01' }, today)).toMatchObject({ late: 0, label: 'Clearing', tone: 'info' })
    expect(chargeTimeliness({ status: 'paid_via_deposit', dueDate: '2026-09-01' }, today)).toMatchObject({ late: 0, label: 'Paid from deposit' })
    expect(chargeTimeliness({ status: 'failed', dueDate: '2026-10-01' }, today)).toMatchObject({ label: 'Failed', tone: 'bad' })
    expect(chargeTimeliness({ status: 'returned', dueDate: '2026-10-01' }, today)).toMatchObject({ label: 'Returned', tone: 'bad' })
  })
  it('a voided charge (decisions #48.5) reads "Voided" — never "Unknown", never overdue, never late', () => {
    expect(chargeTimeliness({ status: 'voided', dueDate: '2026-09-01' }, today))
      .toEqual({ due: '2026-09-01', settled: null, late: 0, label: 'Voided', tone: 'muted' })
    expect(plainRefusal('This charge is not open (status: voided)')).toBe('This charge is no longer open — it is voided now.')
  })
  it('every payment status in the shared list has its own words on the desk', () => {
    for (const st of PAYMENT_STATUSES) {
      expect(chargeTimeliness({ status: st, dueDate: '2026-10-20' }, today).label).not.toBe('Unknown')
      expect(PAYMENT_STATUS_LABEL[st]).toBeTruthy()
    }
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
