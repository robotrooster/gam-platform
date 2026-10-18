/**
 * The screen math the Reports page and the dashboard share.
 *
 * 10/12 (Nic): "NO 'Money received / Money billed' toggle anywhere — show
 * Charged, Received and Owed side by side as columns, with a short line
 * showing how they tie." The switch (S655 Step 15) is retired; these are the
 * helpers that put the three columns on a screen.
 */
import { describe, it, expect } from 'vitest'
import { MONEY_COLUMNS, MONEY_COLUMN_LABEL } from '@gam/shared'
import {
  moneyColumns, moneyCardView, billedPartsAddUp, sumThree, threeAddUp, tieAddsUp, netsOf,
  rentBillsPaidRate, healthStatus, HEALTH_STATUS_LABEL,
  activeCategories, categoryLabel, categoryThree,
  expenseLines, expenseCategoryLabel, incomeLineLabel, INCOME_LINES_ORDER,
  localDay, partsText, noChargeRemainder, sumAmounts, linesAddUp,
  usDay, chargeDay, chargeKey, reportErrorText, latestOnly,
  dayRows, expensesLoggedText, daysAddUp, monthToDate, lastTwelveMonths, lastMonthKey,
  PAID_AHEAD_COUNTED_NOTE,
  type CategoryRow, type MoneyView,
} from './incomeBasis'

describe('the three columns, in Nic\'s order', () => {
  it('Received, Charged, Owed — the shared labels and plain notes', () => {
    const cols = moneyColumns()
    expect(cols.map(c => c.key)).toEqual([...MONEY_COLUMNS])
    expect(cols.map(c => c.label)).toEqual(['Received', 'Charged', 'Owed'])
    for (const c of cols) expect(c.note.length).toBeGreaterThan(10)
  })

  it('rows add up to their totals in every column, to the cent', () => {
    const rows = [{ charged: 460, received: 0, owed: 460 }, { charged: 30.1, received: 30.1, owed: 0 }, { charged: 0.2, received: 0.2, owed: 0 }]
    expect(sumThree(rows)).toEqual({ charged: 490.3, received: 30.3, owed: 460 })
    expect(threeAddUp(rows, { charged: 490.3, received: 30.3, owed: 460 })).toBe(true)
    expect(threeAddUp(rows, { charged: 490.3, received: 30.31, owed: 460 })).toBe(false)
  })

  it('the tie line can be trusted: each split adds back to its column', () => {
    const v = {
      charged: 1000, received: 900,
      tie: {
        charged: { collected: 700, clearing: 50, owed: 250, other: 0 },
        received: { forPeriodBills: 600, forEarlierBills: 100, paidAhead: 150, noBill: 50 },
        stillClearing: 0,
      },
    } as Pick<MoneyView, 'charged' | 'received' | 'tie'>
    expect(tieAddsUp(v)).toBe(true)
    expect(tieAddsUp({ ...v, received: 901 })).toBe(false)
  })

  it('the net on each money column is that column less the same expenses', () => {
    expect(netsOf({ charged: 1000, received: 900 }, 125.5)).toEqual({ charged: 874.5, received: 774.5 })
    expect(netsOf(null, 10)).toEqual({ charged: -10, received: -10 })
  })
})

describe('this month\'s card: Charged, Received and Owed side by side (dashboard and Reports overview)', () => {
  // Todd Niemeyer (10/2): one check in September paid September and October.
  const sept = {
    received: { amount: 920, paidAhead: 460, clearing: 0 },
    billed: { amount: 460, collected: 460, clearing: 0, stillOwed: 0 },
  }
  const oct = {
    received: { amount: 0, paidAhead: 0, clearing: 0 },
    billed: { amount: 460, collected: 460, clearing: 0, stillOwed: 0 },
  }

  it('Todd\'s September: $460 charged, $920 received (the paid-ahead half inside it), nothing owed', () => {
    const v = moneyCardView(sept)
    expect([v.charged, v.received, v.owed]).toEqual([460, 920, 0])
    // 10/12 (Nic, L2): Received leads.
    expect(v.notes).toEqual([
      'Received includes $460.00 paid ahead for later bills',
      'Of $460.00 charged: $460.00 collected · $0.00 still owed',
    ])
  })

  it('Todd\'s October: $460 charged and collected by the money paid ahead, $0 received', () => {
    const v = moneyCardView(oct)
    expect([v.charged, v.received, v.owed]).toEqual([460, 0, 0])
    expect(v.notes).toEqual(['Of $460.00 charged: $460.00 collected · $0.00 still owed'])
  })

  it('money still clearing is named, never inside Received', () => {
    const v = moneyCardView({
      received: { amount: 500, paidAhead: 0, clearing: 120 },
      billed: { amount: 1000, collected: 500, clearing: 120, stillOwed: 380 },
    })
    expect([v.charged, v.received, v.owed]).toEqual([1000, 500, 380])
    expect(v.notes).toEqual([
      '$120.00 more is still clearing',
      'Of $1,000.00 charged: $500.00 collected · $120.00 clearing · $380.00 still owed',
    ])
    expect(billedPartsAddUp({ amount: 1000, collected: 500, clearing: 120, stillOwed: 380 })).toBe(true)
  })

  it('reads an empty card as $0 rather than failing', () => {
    const v = moneyCardView(null)
    expect([v.charged, v.received, v.owed]).toEqual([0, 0, 0])
  })
})

describe('paid-ahead money counted the day it arrived (§0.0, Todd)', () => {
  it('the note says it is in Received already, never "not in" it', () => {
    expect(PAID_AHEAD_COUNTED_NOTE).toMatch(/Received/)
    expect(PAID_AHEAD_COUNTED_NOTE).not.toMatch(/not in/i)
  })
})

describe('a bill\'s due day in American words', () => {
  it('reads the calendar day as written, never shifted by the viewer\'s zone', () => inPhoenix(() => {
    expect(usDay('2026-10-01')).toBe('Oct 1, 2026')
  }))

  it('shows a dash for a bill with no due day', () => {
    expect(usDay(null)).toBe('—')
  })
})

describe('the property-health card', () => {
  // 10/17 (Nic): "the property health matches what was invoiced and what was
  // paid." The API hands over both figures with work trade already out of each.
  it('rates this month\'s rent bills: paid over invoiced', () => {
    expect(rentBillsPaidRate({ invoiced: 1000, paid: 900 })).toBeCloseTo(0.9)
  })

  // Mountain View's October, measured 10/16: $18,502 invoiced once the seven
  // bills on hold for work trade are out, $16,441 of it settled.
  it('reads 89% for Mountain View, not the 67% the Money billed figures gave', () => {
    const pct = (r: number | null) => r == null ? null : Math.round(r * 100)
    expect(pct(rentBillsPaidRate({ invoiced: 18502, paid: 16441, owed: 2061, workTradeHeld: 3478 }))).toBe(89)
  })

  it('has no rate when nothing is invoiced yet', () => {
    expect(rentBillsPaidRate({ invoiced: 0, paid: 0 })).toBeNull()
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

describe('income by category (decision #4), three columns', () => {
  const row = (category: string, f: Partial<CategoryRow>): CategoryRow =>
    ({ category, billed: 0, collected: 0, clearing: 0, stillOwed: 0, amount: 0, ...f })
  const rows = [
    row('space_rent', { billed: 920, collected: 460, amount: 460, charged: 920, received: 460, owed: 460 }),
    row('electric', { billed: 180.4, collected: 150.4, amount: 150.4, charged: 180.4, received: 150.4, owed: 30 }),
    row('water', {}),
    row('late_fees', { billed: 25, stillOwed: 25 }),
  ]

  it('hides categories with no money in the period and keeps the report\'s order', () => {
    expect(activeCategories(rows).map(r => r.category)).toEqual(['space_rent', 'electric', 'late_fees'])
  })

  it('labels each category in plain words, never the raw key', () => {
    expect(categoryLabel(rows[0])).toBe('Lot/space rent')
    expect(categoryLabel(rows[1])).toBe('Electric')
    expect(categoryLabel({ category: 'some_new_thing' })).toBe('Some New Thing')
  })

  it('reads Charged, Received and Owed off a row (an older reply: billed, collected, still owed)', () => {
    expect(categoryThree(rows[1])).toEqual({ charged: 180.4, received: 150.4, owed: 30 })
    expect(categoryThree(rows[3])).toEqual({ charged: 25, received: 0, owed: 25 })
  })
})

describe('P&L lines add up to their totals', () => {
  it('expense lines always show the platform fee and add up to the expense total', () => {
    const lines = expenseLines({ platformFee: 10, maintenance: 75, lotRent: 0, enteredExpenses: 120 })
    expect(lines.map(l => l.key)).toEqual(['platformFee', 'maintenance', 'enteredExpenses', 'processingFees'])
    expect(sumAmounts(lines)).toBe(205)
    expect(linesAddUp(lines, 205)).toBe(true)
  })

  it('10/12 (Nic): the payment processing fees line shows wherever expenses are listed — $0 included', () => {
    const none = expenseLines({ platformFee: 10, maintenance: 0 })
    expect(none.find(l => l.key === 'processingFees')).toEqual({ key: 'processingFees', label: 'Payment processing fees', amount: 0 })
    const some = expenseLines({ platformFee: 10, maintenance: 0, processingFees: 12.4 })
    expect(some.find(l => l.key === 'processingFees')?.amount).toBe(12.4)
    expect(sumAmounts(some)).toBe(22.4)
  })

  it('an entered-expense category finds its label from the camelized key the API sends', () => {
    expect(expenseCategoryLabel('propertyTax')).toBe('Property tax')
    expect(expenseCategoryLabel('property_tax')).toBe('Property tax')
    expect(expenseCategoryLabel('mortgageInterest')).toBe('Mortgage interest')
  })

  it('every income line has a plain label, including the API\'s "moved to credit"', () => {
    for (const l of INCOME_LINES_ORDER) expect(incomeLineLabel(l)).not.toMatch(/[A-Z][a-z]+[A-Z]|_/)
    expect(incomeLineLabel('movedToCredit')).toBe('Moved to credit')
    expect(incomeLineLabel('paidAhead')).toBe('Paid ahead for later bills')
  })
})

describe('the payments behind Received', () => {
  it('says what became of a bill, in report order', () => {
    expect(partsText({ stillOwed: 25, paid: 460 })).toBe('Paid $460.00 · Still owed $25.00')
  })

  it('names the part of the total with no single charge behind it (money paid ahead, register sales, ...)', () => {
    expect(noChargeRemainder(1380, 920)).toBe(460)
  })

  it('an entry is filed under the day the report gives, else its settle day on the viewer\'s calendar', () => inPhoenix(() => {
    const evening = '2026-09-30T01:30:00Z' // 6:30 pm Sep 29, Arizona
    expect(chargeDay({ id: 'a', day: '2026-09-29', settledAt: evening, dueDate: null, amount: 1 })).toBe('2026-09-29')
    expect(chargeDay({ id: 'a', settledAt: evening, dueDate: null, amount: 1 })).toBe('2026-09-29')
    expect(localDay(evening)).toBe('2026-09-29')
  }))

  it('one charge listed on two days (a payment and its dispute) has two keys', () => {
    const payment = { id: 'p', day: '2026-09-03', key: 'p:2026-09-03', settledAt: null, dueDate: null, amount: 460 }
    const dispute = { id: 'p', day: '2026-10-10', key: 'p:2026-10-10', settledAt: null, dueDate: null, amount: -460 }
    expect(chargeKey(dispute)).not.toBe(chargeKey(payment))
    expect(chargeKey({ id: 'z', settledAt: null, dueDate: null, amount: 0 })).toBe('z')
  })
})

describe('the monthly P&L: one line per day (10/12, Nic)', () => {
  const payments = [
    { id: 'p1', key: 'p1:2026-09-03', day: '2026-09-03', settledAt: null, dueDate: '2026-09-01', amount: 460 },
    { id: 'p2', key: 'p2:2026-09-03', day: '2026-09-03', settledAt: null, dueDate: '2026-09-01', amount: 30 },
    { id: 'p3', key: 'p3:2026-09-05', day: '2026-09-05', settledAt: null, dueDate: '2026-09-01', amount: 460 },
  ]
  const days = [
    { day: '2026-09-05', received: 460, chargesTotal: 460, noCharge: 0, paymentCount: 1, paymentKeys: ['p3:2026-09-05'], expensesLogged: 2000, expenseCount: 1 },
    { day: '2026-09-03', received: 950, chargesTotal: 490, noCharge: 460, paymentCount: 2, paymentKeys: ['p1:2026-09-03', 'p2:2026-09-03'], expensesLogged: 0, expenseCount: 0 },
  ]

  it('a day opens to the people who paid that day', () => {
    expect(dayRows(days[1], payments).map(p => p.id)).toEqual(['p1', 'p2'])
    expect(dayRows(days[0], payments).map(p => p.id)).toEqual(['p3'])
  })

  it('the expenses logged that day read in Nic\'s words', () => {
    expect(expensesLoggedText(2000, 1)).toBe('You logged $2,000.00 of expenses')
    expect(expensesLoggedText(2150.5, 3)).toBe('You logged $2,150.50 of expenses (3)')
  })

  it('the days add up to the month\'s Received', () => {
    expect(daysAddUp(days, 1410)).toBe(true)
    expect(daysAddUp(days, 1410.01)).toBe(false)
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
    const first = runs.start()
    const second = runs.start()
    expect(runs.isLatest(second)).toBe(true)
    expect(runs.isLatest(first)).toBe(false)
  })
})

/** Run `fn` with the process in Arizona time (no daylight saving). */
function inPhoenix<T>(fn: () => T): T {
  const tz = process.env.TZ
  process.env.TZ = 'America/Phoenix'
  try { return fn() } finally { process.env.TZ = tz }
}

describe('"this month so far", last month and the T-12 range come from the viewer\'s calendar', () => {
  it('at 8 pm on Oct 3 in Arizona, this month starts Oct 1 and today is Oct 3', () => inPhoenix(() => {
    const now = new Date('2026-10-04T03:00:00Z') // 8 pm Oct 3, Arizona
    expect(monthToDate(now)).toEqual({ monthStart: '2026-10-01', today: '2026-10-03' })
  }))

  it('at 8 pm on the 1st in Arizona, the month still starts that day', () => inPhoenix(() => {
    const now = new Date('2026-10-02T03:00:00Z') // 8 pm Oct 1, Arizona
    expect(monthToDate(now)).toEqual({ monthStart: '2026-10-01', today: '2026-10-01' })
  }))

  it('the monthly report opens on last month — September on the evening of Oct 1 in Arizona, December in January', () => inPhoenix(() => {
    expect(lastMonthKey(new Date('2026-10-02T03:00:00Z'))).toBe('2026-09')
    expect(lastMonthKey(new Date('2027-01-15T19:00:00Z'))).toBe('2026-12')
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

describe('the column labels are the shared words (no copy of them on the page)', () => {
  it('Charged / Received / Owed', () => {
    expect(MONEY_COLUMN_LABEL).toEqual({ charged: 'Charged', received: 'Received', owed: 'Owed' })
  })
})

// 10/12 (Nic, ledger P8): once the books are live, the P&L lists each expense
// account — incurred beside Charged, paid beside Received — and still always
// lists the processing fees the landlord covers.
describe('expense lines on the books', () => {
  it('one line per account with what was paid and what was incurred; processing fees always listed', () => {
    const lines = expenseLines({
      platformFee: 10, maintenance: 150, cashTotal: 160,
      byAccount: [
        { accountId: 'a1', code: '5040', name: 'Repairs and maintenance', role: 'repairs_maintenance', incurred: 150, paid: 150 },
        { accountId: 'a2', code: '5155', name: 'GAM platform fees', role: 'gam_platform_fees', incurred: 10, paid: 10 },
      ],
    })
    expect(lines).toEqual([
      { key: 'a1', label: 'Repairs and maintenance', amount: 150, paid: 150 },
      { key: 'a2', label: 'GAM platform fees', amount: 10, paid: 10 },
      { key: 'processingFees', label: 'Payment processing fees', amount: 0, paid: 0 },
    ])
    const withFees = expenseLines({
      platformFee: 0, maintenance: 0,
      byAccount: [{ accountId: 'a3', code: '5115', name: 'Processing fees you pay', role: 'processing_fees', incurred: 6, paid: 6 }],
    })
    expect(withFees.map(l => l.key)).toEqual(['a3'])
  })
})
