/**
 * S655 money plan, Step 15 — the "Money received" / "Money billed" switch and
 * the screen math the Reports page and the dashboard share.
 *
 * Nic (10/2): "a landlord should be able to see how much money came in this
 * month, ACTUALLY came in, versus how much money actually was SCHEDULED to
 * come in... people need to be able to see it both ways."
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { INCOME_BASIS_NOTE } from '@gam/shared'
import {
  parseBasis, readIncomeBasis, writeIncomeBasis, INCOME_BASIS_STORAGE_KEY, withBasis,
  basisLabel, basisNote, perMonthTitle,
  incomeCardView, billedPartsAddUp, rentBillsPaidRate, healthStatus, HEALTH_STATUS_LABEL,
  activeCategories, categoryColumns, categoryLabel, breakdownTotal,
  expenseLines, expenseCategoryLabel, incomeLineLabel, INCOME_LINES_ORDER,
  groupCharges, localDay, partsText, noChargeRemainder, sumAmounts, linesAddUp,
  billedOutcome, besideNotInTotal, usDay, chargeDay, chargeKey, reportErrorText, latestOnly,
  figuresBasis, resultIsStale, showsBillOutcome,
  paidAheadOnHand, taxYearBeside, PAID_AHEAD_COUNTED_NOTE, arrivalDay, monthToDate, lastTwelveMonths,
  type CategoryRow,
} from './incomeBasis'

/** A tiny in-memory storage, as localStorage behaves. */
function memoryStore(initial: Record<string, string> = {}) {
  const data = { ...initial }
  return {
    data,
    getItem: (k: string) => (k in data ? data[k] : null),
    setItem: (k: string, v: string) => { data[k] = v },
  }
}
const throwingStore = {
  getItem: () => { throw new Error('SecurityError: storage blocked') },
  setItem: () => { throw new Error('QuotaExceededError') },
}

describe('the switch remembers the viewer\'s choice, per browser', () => {
  it('defaults to Money received when nothing is saved', () => {
    expect(readIncomeBasis(memoryStore())).toBe('received')
  })

  it('defaults to Money received when there is no storage at all (private window, preview)', () => {
    expect(readIncomeBasis(null)).toBe('received')
  })

  it('remembers Money billed once it is chosen', () => {
    const store = memoryStore()
    writeIncomeBasis('billed', store)
    expect(store.data[INCOME_BASIS_STORAGE_KEY]).toBe('billed')
    expect(readIncomeBasis(store)).toBe('billed')
  })

  it('reads anything it does not know as Money received (an old or hand-edited value)', () => {
    expect(readIncomeBasis(memoryStore({ [INCOME_BASIS_STORAGE_KEY]: 'cash' }))).toBe('received')
    expect(parseBasis(' BILLED ')).toBe('billed')
    expect(parseBasis(undefined)).toBe('received')
    expect(parseBasis(42)).toBe('received')
  })

  it('falls back to Money received when reading storage throws', () => {
    expect(readIncomeBasis(throwingStore)).toBe('received')
  })

  it('does not break when saving the choice throws', () => {
    expect(() => writeIncomeBasis('billed', throwingStore)).not.toThrow()
  })
})

describe('every report query carries the switch', () => {
  it('adds basis to a path with no query', () => {
    expect(withBasis('/reports/summary', 'billed')).toBe('/reports/summary?basis=billed')
  })

  it('adds basis to a path that already has a query', () => {
    expect(withBasis('/reports/property-pl?year=2026&month=10', 'received'))
      .toBe('/reports/property-pl?year=2026&month=10&basis=received')
  })

  it('names the basis and its note in the shared words the API echoes as meta.basis', () => {
    expect(basisLabel('received')).toBe('Money received')
    expect(basisLabel('billed')).toBe('Money billed')
    expect(basisNote('received')).toBe(INCOME_BASIS_NOTE.received)
    expect(basisNote('received')).toMatch(/day the money arrived/)
    expect(perMonthTitle('billed')).toBe('Money billed by month')
  })
})

describe('the income card (dashboard and Reports overview)', () => {
  // Todd Niemeyer: one $920 check on Sep 18 for September and October.
  const septemberCard = {
    received: { amount: 920, paidAhead: 460, clearing: 0 },
    billed: { amount: 460, collected: 460, clearing: 0, stillOwed: 0 },
  }
  const octoberCard = {
    received: { amount: 0, paidAhead: 0, clearing: 0 },
    billed: { amount: 460, collected: 460, clearing: 0, stillOwed: 0 },
  }

  it('Money received counts the day money arrived: Todd\'s September shows both months, the paid-ahead half inside it', () => {
    const v = incomeCardView(septemberCard, 'received', 'this month', n => `$${n}`)
    expect(v.label).toBe('Money received this month')
    expect(v.amount).toBe(920)
    expect(v.notes).toEqual(['incl. $460 paid ahead for later bills'])
  })

  it('Money received shows $0 from Todd in October, when his paid-ahead money pays the bill', () => {
    const v = incomeCardView(octoberCard, 'received')
    expect(v.amount).toBe(0)
    expect(v.notes).toEqual([])
  })

  it('Money billed shows October\'s $460 bill, collected so far', () => {
    const v = incomeCardView(octoberCard, 'billed', 'this month', n => `$${n}`)
    expect(v.label).toBe('Money billed this month')
    expect(v.amount).toBe(460)
    expect(v.notes).toEqual(['Collected so far $460 · still owed $0'])
  })

  it('money still clearing sits beside Money received, never inside it', () => {
    const v = incomeCardView({ received: { amount: 1200, paidAhead: 0, clearing: 460 } }, 'received', 'this month', n => `$${n}`)
    expect(v.amount).toBe(1200)
    expect(v.notes).toEqual(['+ $460 still clearing'])
  })

  it('Money billed: collected so far, clearing and still owed add up to the bill', () => {
    const b = { amount: 2885.45, collected: 1960, clearing: 460, stillOwed: 465.45 }
    expect(billedPartsAddUp(b)).toBe(true)
    const v = incomeCardView({ billed: b }, 'billed', 'this month', n => `$${n}`)
    expect(v.notes).toEqual(['Collected so far $1960 · clearing $460 · still owed $465.45'])
    expect(billedPartsAddUp({ amount: 100, collected: 50, clearing: 0, stillOwed: 40 })).toBe(false)
  })

  it('reads an empty card as $0 rather than failing', () => {
    expect(incomeCardView(undefined, 'received').amount).toBe(0)
    expect(incomeCardView(null, 'billed').amount).toBe(0)
  })
})

describe('figures beside a total', () => {
  // October under Money billed, as /reports/monthly-pl and /monthly-statement send them.
  const billedBeside = [
    { key: 'collectedSoFar', label: 'Collected so far', amount: 1435.4 },
    { key: 'clearing', label: 'Still clearing', amount: 1150 },
    { key: 'stillOwed', label: 'Still owed', amount: 1239.1 },
    { key: 'depositsHeld', label: 'Deposits received (held)', amount: 500 },
  ]
  // Money received, as besideList sends it: paid-ahead money on hand is one of
  // the API's beside figures under both bases.
  const receivedBeside = [
    { key: 'clearing', label: 'Still clearing', amount: 1150 },
    { key: 'creditsYouGave', label: 'Credits you gave', amount: 150 },
    { key: 'paidAheadUnused', label: 'Paid ahead, not used yet', amount: 460 },
  ]
  const receivedNotInTotal = receivedBeside.filter(i => i.key !== 'paidAheadUnused')

  it('Money billed: still owed and still clearing are inside the total, so they are never listed beside it', () => {
    expect(besideNotInTotal(billedBeside, 'billed').map(i => i.key)).toEqual(['collectedSoFar', 'depositsHeld'])
  })

  it('Money billed with what became of the bills already shown: collected so far is not repeated beside the total', () => {
    expect(besideNotInTotal(billedBeside, 'billed', { outcomeShown: true }).map(i => i.key)).toEqual(['depositsHeld'])
  })

  it('Money billed: collected so far, still clearing and still owed are what became of the bills, and add up to the total', () => {
    const outcome = billedOutcome(billedBeside, 'billed')
    expect(outcome.map(i => i.label)).toEqual(['Collected so far', 'Still clearing', 'Still owed'])
    expect(linesAddUp(outcome, 3824.5)).toBe(true)
  })

  it('Money received: money still clearing has not arrived, so it stays beside the total; there is no bill outcome', () => {
    expect(besideNotInTotal(receivedBeside, 'received')).toEqual(receivedNotInTotal)
    expect(billedOutcome(receivedBeside, 'received')).toEqual([])
  })

  it('reads a missing list as nothing to show', () => {
    expect(besideNotInTotal(undefined, 'billed')).toEqual([])
    expect(billedOutcome(null, 'billed')).toEqual([])
  })

  it('the month P&L under Money billed lists what became of the bills, so collected so far ($1,435.40) is never shown as "not in" the total', () => {
    const outcomeShown = showsBillOutcome('billed', 4)
    expect(outcomeShown).toBe(true)
    const beside = besideNotInTotal(billedBeside, 'billed', { outcomeShown })
    expect(beside.map(i => i.key)).toEqual(['depositsHeld'])
    expect(beside.some(i => i.label === 'Collected so far')).toBe(false)
  })

  it('a month P&L with no bill parts (or under Money received) lists no outcome, so nothing is held back from beside the total', () => {
    expect(showsBillOutcome('billed', 0)).toBe(false)
    expect(showsBillOutcome('received', 4)).toBe(false)
    expect(besideNotInTotal(receivedBeside, 'received', { outcomeShown: showsBillOutcome('received', 4) })).toEqual(receivedNotInTotal)
  })
})

describe('paid-ahead money is never called "not in" a Money received total (§0.0, Todd)', () => {
  // Todd's September P&L under Money received: one check paid September and
  // October. Rent $460 + Paid ahead for later bills $460 = $920, and the $460
  // for October is still on hand at Sep 30.
  const toddSeptember = {
    lines: [
      { line: 'rent', label: 'Rent', amount: 460 },
      { line: 'paidAhead', label: 'Paid ahead for later bills', amount: 460 },
    ],
    total: 920,
    beside: [{ key: 'paidAheadUnused', label: 'Paid ahead, not used yet', amount: 460 }],
  }

  it('Todd\'s September: the $460 paid ahead, not used yet, is never listed beside the $920 total as not in it', () => {
    expect(linesAddUp(toddSeptember.lines, toddSeptember.total)).toBe(true)
    expect(besideNotInTotal(toddSeptember.beside, 'received')).toEqual([])
    expect(besideNotInTotal(toddSeptember.beside, 'received', { outcomeShown: false })).toEqual([])
  })

  it('Todd\'s September: the $460 is shown on its own line, saying it counted on the day it arrived', () => {
    expect(paidAheadOnHand(toddSeptember.beside, 'received')).toEqual({ key: 'paidAheadUnused', label: 'Paid ahead, not used yet', amount: 460 })
    expect(PAID_AHEAD_COUNTED_NOTE).toBe('Counted on the day it arrived; $0 again when it pays a bill.')
    expect(PAID_AHEAD_COUNTED_NOTE).not.toMatch(/not in/i)
  })

  it('Money billed: paid-ahead money on hand stays beside the total (no bill it pays is in it yet), never on the counted line', () => {
    expect(besideNotInTotal(toddSeptember.beside, 'billed').map(i => i.key)).toEqual(['paidAheadUnused'])
    expect(paidAheadOnHand(toddSeptember.beside, 'billed')).toBeNull()
  })

  it('no paid-ahead money on hand shows no counted line', () => {
    expect(paidAheadOnHand([], 'received')).toBeNull()
    expect(paidAheadOnHand(undefined, 'received')).toBeNull()
    expect(paidAheadOnHand([{ key: 'paidAheadUnused', label: 'Paid ahead, not used yet', amount: 0 }], 'received')).toBeNull()
  })

  it('the tax page, Money received: $920 paid ahead for next year\'s bills, counted in the $920 total, is never in the "not in them" box; work trade still is', () => {
    const tax = { income: { totalRent: 920 }, paidAheadNextYear: { label: "Paid ahead for next year's bills", amount: 920 } }
    const { onHand, notIn } = taxYearBeside(tax.paidAheadNextYear, 300, 'received')
    expect(onHand).toEqual({ key: 'paidAheadUnused', label: "Paid ahead for next year's bills", amount: 920 })
    expect(notIn.map(i => i.key)).toEqual(['workTrade'])
    expect(notIn.some(i => /paid ahead/i.test(i.label))).toBe(false)
  })

  it('the tax page, Money billed: paid ahead and work trade are both outside the totals', () => {
    const { onHand, notIn } = taxYearBeside({ label: "Paid ahead for next year's bills", amount: 920 }, 300, 'billed')
    expect(onHand).toBeNull()
    expect(notIn.map(i => [i.key, i.amount])).toEqual([['paidAheadUnused', 920], ['workTrade', 300]])
  })

  it('the tax page with nothing paid ahead and no work trade has nothing beside the totals', () => {
    expect(taxYearBeside(null, 0, 'received')).toEqual({ onHand: null, notIn: [] })
    expect(taxYearBeside({ amount: 0 }, null, 'billed')).toEqual({ onHand: null, notIn: [] })
  })

  it('the tax page names the paid-ahead money by the server\'s label, else "Paid ahead, not used yet"', () => {
    expect(taxYearBeside({ amount: 50 }, 0, 'received').onHand?.label).toBe('Paid ahead, not used yet')
  })
})

describe('a bill\'s due day in American words', () => {
  it('reads the calendar day as written, never shifted by the viewer\'s zone', () => {
    const tz = process.env.TZ
    process.env.TZ = 'America/Phoenix'
    try {
      expect(usDay('2026-10-01')).toBe('Oct 1, 2026')
    } finally { process.env.TZ = tz }
  })

  it('shows a dash for a bill with no due day', () => {
    expect(usDay(null)).toBe('—')
  })
})

describe('the property-health card', () => {
  it('rates this month\'s rent bills paid, money still clearing counted as paid', () => {
    expect(rentBillsPaidRate({ amount: 1000, collected: 700, clearing: 200 })).toBeCloseTo(0.9)
  })

  it('has no rate when nothing is billed yet', () => {
    expect(rentBillsPaidRate({ amount: 0, collected: 0, clearing: 0 })).toBeNull()
    expect(rentBillsPaidRate(undefined)).toBeNull()
  })

  it('reads fully collected at 100%, healthy from 85%, needs attention below', () => {
    expect(healthStatus(null)).toBe('awaiting')
    expect(healthStatus(1)).toBe('full')
    expect(healthStatus(0.85)).toBe('healthy')
    expect(healthStatus(0.84)).toBe('attention')
    expect(HEALTH_STATUS_LABEL.attention).toBe('Needs attention')
  })
})

describe('income by category (decision #4)', () => {
  const row = (category: string, f: Partial<CategoryRow>): CategoryRow =>
    ({ category, billed: 0, collected: 0, clearing: 0, stillOwed: 0, amount: 0, ...f })
  const rows = [
    row('space_rent', { billed: 920, collected: 460, amount: 460 }),
    row('electric', { billed: 180.4, collected: 150.4, amount: 150.4 }),
    row('water', {}),
    row('late_fees', { billed: 25, stillOwed: 25 }),
  ]

  it('hides categories with no money in the period and keeps the report\'s order', () => {
    expect(activeCategories(rows).map(r => r.category)).toEqual(['space_rent', 'electric', 'late_fees'])
    expect(activeCategories(null)).toEqual([])
  })

  it('labels each category in plain words, never the raw key', () => {
    expect(categoryLabel({ category: 'space_rent' })).toBe('Lot/space rent')
    expect(categoryLabel({ category: 'home_payments' })).toBe('Home/trailer payments')
    expect(categoryLabel({ category: 'something_new', label: 'Something new' })).toBe('Something new')
    expect(categoryLabel({ category: 'something_new' })).not.toMatch(/_/)
  })

  it('Money received shows billed vs received; Money billed shows what became of each bill', () => {
    expect(categoryColumns('received').map(c => c.label)).toEqual(['Billed', 'Received'])
    expect(categoryColumns('billed').map(c => c.label)).toEqual(['Billed', 'Collected so far', 'Still clearing', 'Still owed'])
  })

  it('the breakdown\'s total is every category under the switch plus the money with no category', () => {
    const received = activeCategories(rows)
    // Money paid ahead has no category: its own line inside the total.
    expect(breakdownTotal(received, [{ amount: 460 }])).toBe(460 + 150.4 + 0 + 460)
  })
})

describe('P&L lines add up to their totals', () => {
  it('expense lines always show the platform fee and add up to the expense total', () => {
    const lines = expenseLines({ platformFee: 26, maintenance: 0, lotRent: 400, enteredExpenses: 82.5 })
    expect(lines.map(l => l.label)).toEqual(['GAM platform fee', 'Lot rent', 'Your expenses'])
    expect(sumAmounts(lines)).toBe(508.5)
    expect(linesAddUp(lines, 508.5)).toBe(true)
    expect(expenseLines(null)).toEqual([])
  })

  it('income lines that take money off (credits given) count against the total', () => {
    const kim = [{ amount: 935.45 }, { amount: -450 }]
    expect(linesAddUp(kim, 485.45)).toBe(true)
    expect(linesAddUp(kim, 935.45)).toBe(false)
  })

  it('an entered-expense category finds its label from the camelized key the API sends', () => {
    expect(expenseCategoryLabel('propertyTax')).toBe('Property tax')
    expect(expenseCategoryLabel('property_tax')).toBe('Property tax')
    expect(expenseCategoryLabel('mortgageInterest')).toBe('Mortgage interest')
    // A category the catalog does not know yet still reads as words, not 'someNewThing'.
    expect(expenseCategoryLabel('someNewThing')).toBe('Some New Thing')
  })

  it('every income line has a plain label, including the API\'s "moved to credit"', () => {
    expect(incomeLineLabel('paidAhead')).toBe('Paid ahead for later bills')
    expect(incomeLineLabel('creditsGiven')).toBe('Credits given')
    expect(incomeLineLabel('movedToCredit')).toBe('Moved to credit')
    expect(INCOME_LINES_ORDER).toContain('movedToCredit')
    expect(INCOME_LINES_ORDER.indexOf('rent')).toBe(0)
  })
})

describe('the charges behind a total', () => {
  const tz = process.env.TZ
  beforeAll(() => { process.env.TZ = 'America/Phoenix' })
  afterAll(() => { process.env.TZ = tz })

  const rows = [
    { id: 'a', settledAt: '2026-10-01T02:30:00Z', dueDate: '2026-10-01', amount: 460 },   // 7:30 pm Sep 30 in Phoenix
    { id: 'b', settledAt: '2026-09-30T16:00:00Z', dueDate: '2026-09-01', amount: 25 },
    { id: 'c', settledAt: null, dueDate: '2026-10-01', amount: 180.4, parts: { stillOwed: 180.4 } },
  ]

  it('Money received groups payments by the day the money arrived on the viewer\'s calendar (an evening payment stays on its day)', () => {
    expect(localDay('2026-10-01T02:30:00Z')).toBe('2026-09-30')
    const g = groupCharges(rows.slice(0, 2), 'received')
    expect(g).toHaveLength(1)
    expect(g[0].date).toBe('2026-09-30')
    expect(g[0].total).toBe(485)
  })

  it('Money billed groups bills by the day each was due, newest first', () => {
    const g = groupCharges(rows, 'billed')
    expect(g.map(x => x.date)).toEqual(['2026-10-01', '2026-09-01'])
    expect(g[0].total).toBe(640.4)
  })

  it('says what became of a bill, in report order', () => {
    expect(partsText({ stillOwed: 25, paid: 435 }, n => `$${n}`)).toBe('Paid $435 · Still owed $25')
    expect(partsText(undefined)).toBe('')
  })

  it('names the part of the total with no single charge behind it (money paid ahead, register sales, ...)', () => {
    expect(noChargeRemainder(1380, 920)).toBe(460)
    expect(noChargeRemainder(485.45, 485.45)).toBe(0)
  })
})

describe('an entry is filed under the day it counted, from the report', () => {
  // Todd-shaped: $460 paid Sep 18, disputed Oct 10. October's P&L lists the
  // dispute as a negative on Oct 10 — never under its September settle date.
  const dispute = { id: 'p1', key: 'p1:2026-10-10', day: '2026-10-10', settledAt: '2026-09-18T17:00:00Z', dueDate: '2026-09-01', amount: -460 }
  const payment = { id: 'p1', key: 'p1:2026-10-03', day: '2026-10-03', settledAt: '2026-10-03T17:00:00Z', dueDate: '2026-10-01', amount: 460 }

  it('a dispute of a September payment is grouped on its October day, as a negative', () => {
    const g = groupCharges([dispute], 'received')
    expect(g.map(x => [x.date, x.total])).toEqual([['2026-10-10', -460]])
  })

  it('a payment and its dispute in one month sit on their own days, and the days add up to the total', () => {
    const g = groupCharges([dispute, payment], 'received')
    expect(g.map(x => [x.date, x.total])).toEqual([['2026-10-10', -460], ['2026-10-03', 460]])
    expect(sumAmounts(g.map(x => ({ amount: x.total })))).toBe(0)
  })

  it('the day the report gives wins over the viewer\'s own calendar; an older reply falls back', () => {
    expect(chargeDay({ id: 'x', day: '2026-09-30', settledAt: '2026-10-01T09:00:00Z', dueDate: null, amount: 1 }, 'received')).toBe('2026-09-30')
    expect(chargeDay({ id: 'x', settledAt: null, dueDate: '2026-09-01', amount: 1 }, 'billed')).toBe('2026-09-01')
  })

  it('one charge listed on two days has two keys', () => {
    expect(chargeKey(dispute)).not.toBe(chargeKey(payment))
    expect(chargeKey({ id: 'z', settledAt: null, dueDate: null, amount: 0 })).toBe('z')
  })
})

describe('a report that could not load says why once, with the right next step', () => {
  const failed = (status: number, message: string) => Object.assign(new Error(message), { response: { status } })

  it('a refusal is shown alone — "try again" never helps there', () => {
    const text = reportErrorText(failed(403, 'The owner statement covers the whole company, and you are assigned to some of its properties. Ask the owner for it.'), 'the owner statement')
    expect(text).toBe('The owner statement covers the whole company, and you are assigned to some of its properties. Ask the owner for it.')
    expect(text).not.toMatch(/Try again/)
  })

  it('a request to choose a company is shown alone', () => {
    expect(reportErrorText(failed(400, 'You own more than one company. Choose which one this report belongs to.'), 'the tax summary'))
      .not.toMatch(/Try again/)
  })

  it('a server failure or a dropped connection says to try again, never a raw status code', () => {
    expect(reportErrorText(failed(500, 'Request failed with status code 500'), 'the summary')).toBe('Could not load the summary. Try again in a moment.')
    expect(reportErrorText(new Error('Network Error'), 'the summary')).toBe('Could not load the summary. Try again in a moment.')
    expect(reportErrorText(failed(503, 'The reports service is restarting.'), 'the summary')).toBe('The reports service is restarting. Try again in a moment.')
  })

  it('a refusal with no sentence from the server falls back to plain words, never "Request failed with status code 4xx"', () => {
    // The API client keeps axios' own message when the reply has no sentence in it.
    const text = reportErrorText(failed(404, 'Request failed with status code 404'), 'the summary')
    expect(text).toBe('Could not load the summary.')
    expect(text).not.toMatch(/status code|Try again/)
    expect(reportErrorText(failed(403, 'timeout of 30000ms exceeded'), 'the summary')).toBe('Could not load the summary.')
  })

  it('too many requests (the rate limit answers 429 in plain text) says to try again in plain words', () => {
    const text = reportErrorText(failed(429, 'Request failed with status code 429'), 'your dashboard figures')
    expect(text).toBe('Could not load your dashboard figures. Try again in a moment.')
    expect(text).not.toMatch(/status code|429/)
  })

  it('a server crash never shows its insides (a database message), only plain words and try again', () => {
    const text = reportErrorText(failed(500, 'relation "v_payment_money" does not exist'), 'your dashboard figures')
    expect(text).toBe('Could not load your dashboard figures. Try again in a moment.')
    expect(text).not.toMatch(/relation|does not exist/)
  })
})

describe('a report run that overlaps another', () => {
  it('only the newest run may land: an older answer arriving last is dropped', () => {
    const runs = latestOnly()
    const received = runs.start()
    const billed = runs.start()
    expect(runs.isLatest(billed)).toBe(true)
    expect(runs.isLatest(received)).toBe(false)
  })
})

describe('a figure never sits under the other basis\'s name while a flip loads', () => {
  it('the dashboard labels the figures by the basis the API counted them under, not the switch mid-flip', () => {
    // The switch now says Money received; the Money billed answer is still on screen.
    expect(figuresBasis('billed', 'received')).toBe('billed')
    expect(figuresBasis('received', 'billed')).toBe('received')
  })

  it('with no echo from the API (nothing loaded yet, or an older reply) the switch names the figures', () => {
    expect(figuresBasis(undefined, 'billed')).toBe('billed')
    expect(figuresBasis(null, 'received')).toBe('received')
    expect(figuresBasis('accrual', 'received')).toBe('received')
  })

  it('a Custom/T-12 result counted under Money received is stale once the switch says Money billed', () => {
    expect(resultIsStale('received', 'billed', false)).toBe(true)
  })

  it('a result is stale while any run is in flight, and current once the answer under the switch lands', () => {
    expect(resultIsStale('billed', 'billed', true)).toBe(true)
    expect(resultIsStale('billed', 'billed', false)).toBe(false)
  })

  it('a result with no basis echoed is judged by the run alone', () => {
    expect(resultIsStale(undefined, 'received', false)).toBe(false)
    expect(resultIsStale(undefined, 'received', true)).toBe(true)
  })
})

/** Run `fn` with the process in Arizona time (no daylight saving). */
function inPhoenix<T>(fn: () => T): T {
  const tz = process.env.TZ
  process.env.TZ = 'America/Phoenix'
  try { return fn() } finally { process.env.TZ = tz }
}

describe('the owner statement CSV\'s "Money arrived" column is a calendar day, never the UTC date', () => {
  // 6:30 pm Sep 29 in Arizona is 01:30 Sep 30 in UTC.
  const eveningSep29 = '2026-09-30T01:30:00Z'

  it('an evening settle reads the day it arrived, the same as "Counted on"', () => inPhoenix(() => {
    const row = { id: 'p1', day: '2026-09-29', settledAt: eveningSep29, dueDate: '2026-09-01', amount: 460 }
    expect(arrivalDay(row, 'received')).toBe('2026-09-29')
    expect(arrivalDay(row, 'received')).toBe(chargeDay(row, 'received'))
    expect(String(row.settledAt).slice(0, 10)).toBe('2026-09-30') // the old, wrong reading
  }))

  it('a Sep 30 evening payment on the September statement reads Sep 30, not Oct 1', () => inPhoenix(() => {
    const row = { id: 'p2', day: '2026-09-30', settledAt: '2026-10-01T02:15:00Z', dueDate: '2026-09-01', amount: 460 }
    expect(arrivalDay(row, 'received')).toBe('2026-09-30')
  }))

  it('Money billed: the bill\'s money arrived on its own settle day, read on the calendar (the due day is its own column)', () => inPhoenix(() => {
    const row = { id: 'p3', day: '2026-09-01', settledAt: eveningSep29, dueDate: '2026-09-01', amount: 460 }
    expect(arrivalDay(row, 'billed')).toBe('2026-09-29')
  }))

  it('a dispute listed on its take-back day still says when the money first arrived', () => inPhoenix(() => {
    const row = { id: 'p4', day: '2026-10-10', settledAt: eveningSep29, dueDate: '2026-09-01', amount: -460 }
    expect(arrivalDay(row, 'received')).toBe('2026-09-29')
  }))

  it('an entry with no money arrived leaves the column empty', () => {
    expect(arrivalDay({ id: 'p5', settledAt: null, dueDate: '2026-09-01', amount: 460 }, 'billed')).toBe('')
  })
})

describe('"this month so far" and the T-12 range come from the viewer\'s calendar', () => {
  it('at 8 pm on Oct 3 in Arizona, this month starts Oct 1 and today is Oct 3', () => inPhoenix(() => {
    const now = new Date('2026-10-04T03:00:00Z') // 8 pm Oct 3, Arizona
    expect(monthToDate(now)).toEqual({ monthStart: '2026-10-01', today: '2026-10-03' })
  }))

  it('at 8 pm on the 1st in Arizona, the month still starts that day', () => inPhoenix(() => {
    const now = new Date('2026-10-02T03:00:00Z') // 8 pm Oct 1, Arizona
    expect(monthToDate(now)).toEqual({ monthStart: '2026-10-01', today: '2026-10-01' })
  }))

  it('on the last evening of September in Arizona, September is not yet a complete month', () => inPhoenix(() => {
    const now = new Date('2026-10-01T03:00:00Z') // 8 pm Sep 30, Arizona
    expect(lastTwelveMonths(now)).toEqual({ start: '2025-09-01', end: '2026-08-31' })
  }))

  it('in October, the last twelve complete months run Oct 1 last year to Sep 30', () => inPhoenix(() => {
    expect(lastTwelveMonths(new Date('2026-10-03T19:00:00Z'))).toEqual({ start: '2025-10-01', end: '2026-09-30' })
  }))

  it('in January, the range reaches back across the year', () => inPhoenix(() => {
    expect(lastTwelveMonths(new Date('2027-01-15T19:00:00Z'))).toEqual({ start: '2026-01-01', end: '2026-12-31' })
  }))
})
