/**
 * S655 money plan, Step 13 — FlexPay in the tenant app: the pull days offered,
 * the card that says what FlexPay did with this month's bill, and the words.
 */
import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import { FLEXPAY_FORBIDDEN_PULL_DAYS, FLEXPAY_TERMS } from '@gam/shared'
import {
  FLEXPAY_PULL_DAY_OPTIONS, FLEXPAY_FIRST_PULL_DAY, offeredPullDay, pullDayRangeText, flexPayBillCard, localToday,
} from './flexpayCard'

describe('FlexPay pull days', () => {
  it('the 1st through the 5th are never offered; the 6th through the 28th are', () => {
    for (const d of FLEXPAY_FORBIDDEN_PULL_DAYS) expect(FLEXPAY_PULL_DAY_OPTIONS).not.toContain(d)
    expect(FLEXPAY_PULL_DAY_OPTIONS[0]).toBe(6)
    expect(FLEXPAY_PULL_DAY_OPTIONS[FLEXPAY_PULL_DAY_OPTIONS.length - 1]).toBe(28)
    expect(FLEXPAY_PULL_DAY_OPTIONS).toHaveLength(23)
    expect(pullDayRangeText()).toBe('6th through the 28th')
  })

  it('a day stored before the rule starts the picker at the first offered day', () => {
    expect(offeredPullDay(3)).toBe(FLEXPAY_FIRST_PULL_DAY)
    expect(offeredPullDay(1)).toBe(6)
    expect(offeredPullDay(15)).toBe(15)
    expect(offeredPullDay(null)).toBe(15)
    expect(offeredPullDay(31)).toBe(28)
  })
})

const covered = (over: any = {}, body = 'FlexPay paid your October bill of $612.40 to your landlord on time, so it gets no late fee. On October 20, GAM collects $612.40 plus the $25.00 monthly fee from your bank account.') => ({
  type: 'flexpay_bill_covered',
  title: 'FlexPay paid your October bill',
  body,
  data: { cycle: '2026-10-01', covered: 612.4, collect_total: 612.4, pull_date: '2026-10-20', still_due: [], retry_called_off: [], ...over },
})

describe('the FlexPay bill card', () => {
  it('says the bill was paid on time and what is drawn, and when', () => {
    const card = flexPayBillCard([covered()], '2026-10-06')
    expect(card?.headline).toBe('Your October bill was paid on time by FlexPay. $637.40 will be drawn from your bank on Oct 20.')
    expect(card?.drawAmount).toBe(637.4)
    expect(card?.stillDue).toBeNull()
  })

  it('a bill paid late is never called on time', () => {
    const card = flexPayBillCard([covered({}, 'FlexPay paid your October bill of $612.40 to your landlord. On October 20, GAM collects $612.40 plus the $25.00 monthly fee from your bank account.')], '2026-10-06')
    expect(card?.headline).toBe('FlexPay paid your October bill. $637.40 will be drawn from your bank on Oct 20.')
  })

  it('a month the tenant already paid still draws only the $25', () => {
    const card = flexPayBillCard([covered({ covered: 0, collect_total: 0 }, 'Your October bill was already paid, so FlexPay paid nothing this month.')], '2026-10-06')
    expect(card?.headline).toBe('Your October bill was already paid, so FlexPay paid nothing this month. $25.00 will be drawn from your bank on Oct 20.')
  })

  it('names what is still the tenant\'s to pay', () => {
    const card = flexPayBillCard([covered({ still_due: [{ label: 'Water', amount: 10.45 }, { label: 'Late fee', amount: 25 }] })], '2026-10-06')
    expect(card?.stillDue).toBe('Still yours to pay on this bill: Water $10.45, Late fee $25.00.')
  })

  it('names the lines a called-off bank retry carried — the notice says they are still due', () => {
    const card = flexPayBillCard([covered({
      still_due: [{ label: 'Water', amount: 10.45 }],
      retry_called_off: [{ label: 'Late fee', amount: 25 }, { label: 'Electric', amount: 40.1 }],
    })], '2026-10-06')
    expect(card?.stillDue).toBe('Still yours to pay: Water $10.45, Late fee $25.00, Electric $40.10.')
    const onlyRetry = flexPayBillCard([covered({ retry_called_off: [{ label: 'Late fee', amount: 25 }] })], '2026-10-06')
    expect(onlyRetry?.stillDue).toBe('Still yours to pay: Late fee $25.00.')
  })

  it('names the bill as the notice does: by its due date, not the cycle', () => {
    // FlexPay's payment went onto an earlier open bill: the server says "your bill due September 28".
    const earlier = flexPayBillCard([{ ...covered(), title: 'FlexPay paid your bill due September 28' }], '2026-10-06')
    expect(earlier?.headline).toBe('Your bill due September 28 was paid on time by FlexPay. $637.40 will be drawn from your bank on Oct 20.')
    // A due date in the notice's data wins over the cycle's month.
    const byDue = flexPayBillCard([covered({ due_date: '2026-11-01' }, 'FlexPay paid your November bill of $612.40 to your landlord.')], '2026-10-06')
    expect(byDue?.headline).toBe('FlexPay paid your November bill. $637.40 will be drawn from your bank on Oct 20.')
    // The title's month, when the data has no due date.
    const byTitle = flexPayBillCard([{ ...covered(), title: 'FlexPay paid your November bill' }], '2026-10-06')
    expect(byTitle?.headline).toBe('Your November bill was paid on time by FlexPay. $637.40 will be drawn from your bank on Oct 20.')
    // The server's cycle record names it by its due date too.
    const cycle = { cycleMonth: '2026-10-01', covered: 500, collectTotal: 500, pullDate: '2026-10-20', late: false,
      dueDate: '2026-09-28', addedToEarlier: true, retryCalledOff: [{ label: 'Water', amount: 12 }] }
    const fromCycle = flexPayBillCard([], '2026-10-06', cycle)
    expect(fromCycle?.headline).toBe('Your bill due September 28 was paid on time by FlexPay. $525.00 will be drawn from your bank on Oct 20.')
    expect(fromCycle?.stillDue).toBe('Still yours to pay: Water $12.00.')
  })

  it('goes away once the draw day has passed, and with no FlexPay notice', () => {
    expect(flexPayBillCard([covered()], '2026-10-20')).not.toBeNull()
    expect(flexPayBillCard([covered()], '2026-10-21')).toBeNull()
    expect(flexPayBillCard([{ type: 'rent_receipt', data: {} }], '2026-10-06')).toBeNull()
  })

  it('reads the newest FlexPay notice, and data sent as text', () => {
    const older = covered({ cycle: '2026-09-01', pull_date: '2026-10-25' })
    const newer = { ...covered(), data: JSON.stringify(covered().data) }
    expect(flexPayBillCard([newer, older], '2026-10-06')?.drawOn).toBe('2026-10-20')
  })

  it('reads the server\'s current cycle first — a tenant with in-app notices off still sees the card', () => {
    const cycle = { cycleMonth: '2026-10-01', covered: 612.4, collectTotal: 612.4, pullDate: '2026-10-20', late: false, stillDue: [] }
    const card = flexPayBillCard([], '2026-10-06', cycle)
    expect(card?.headline).toBe('Your October bill was paid on time by FlexPay. $637.40 will be drawn from your bank on Oct 20.')
    expect(card?.drawAmount).toBe(637.4)
  })

  it('the server\'s cycle wins over an older notice, and a late cover is never called on time', () => {
    const cycle = { cycleMonth: '2026-11-01', covered: 500, collectTotal: 500, pullDate: '2026-11-20', late: true,
      stillDue: [{ label: 'Water', amount: 10.45 }] }
    const card = flexPayBillCard([covered()], '2026-11-06', cycle)
    expect(card?.headline).toBe('FlexPay paid your November bill. $525.00 will be drawn from your bank on Nov 20.')
    expect(card?.stillDue).toBe('Still yours to pay on this bill: Water $10.45.')
  })

  it('the server\'s cycle goes away once its draw day has passed; with no cycle sent, the notice is read', () => {
    const cycle = { cycleMonth: '2026-10-01', covered: 0, collectTotal: 0, pullDate: '2026-10-20', late: false }
    expect(flexPayBillCard([], '2026-10-21', cycle)).toBeNull()
    expect(flexPayBillCard([covered()], '2026-10-06', null)?.drawOn).toBe('2026-10-20')
  })

  it('today is the tenant\'s own calendar day', () => {
    expect(localToday(new Date(2026, 9, 3, 23, 30))).toBe('2026-10-03')
  })

  it('never says FlexPay advances, fronts, lends or loans money', () => {
    for (const n of [covered(), covered({ covered: 0 })]) {
      const card = flexPayBillCard([n], '2026-10-06')!
      expect(`${card.headline} ${card.stillDue ?? ''}`).not.toMatch(/advanc|front|lend|loan/i)
    }
  })
})

describe('the tenant app shell (main.tsx)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'main.tsx'), 'utf8')

  it('never posts to the removed /tenants/verify-ach (a bank is verified only by microdeposits on the Payments page)', () => {
    // Any string literal naming the route — a fetch, a post, a URL built from parts.
    expect(src).not.toMatch(/['"`][^'"`\n]*\/tenants\/verify-ach/)
    expect(src).not.toContain('AchVerifyForm')
  })

  it('no FlexPay pull-day slider starts at the 1st', () => {
    // (The "what day does your money arrive" slider is the income day, 1–28.)
    expect(src).not.toMatch(/min=\{1\} max=\{28\} value=\{pullDay\}/)
    expect(src.match(/min=\{FLEXPAY_FIRST_PULL_DAY\} max=\{FLEXPAY_LAST_PULL_DAY\}/g)?.length).toBe(2)
  })

  it('the utility-service home names each bill line by its utility, never a generic "Utilities" (decisions #17)', () => {
    expect(src).not.toMatch(/'Late fee' : 'Utilities'/)
    expect(src).toContain('utilityLine(c).label')
  })

  it('the FlexPay bill card reads the server\'s current cycle before the in-app notice', () => {
    expect(src).toMatch(/flexPayBillCard\(notices, localToday\(\), \(fp\?\.currentCycle/)
  })

  it('the FlexPay terms shown at enrollment are the shared FLEXPAY_TERMS', () => {
    expect(FLEXPAY_TERMS.length).toBeGreaterThan(0)
    expect(src).toContain('FLEXPAY_TERMS.map(')
  })

  it('FlexPay is described as payment-date coordination: no "you pay later", never fronted or lent', () => {
    const flexpayLines = src.split('\n').filter((l) => /FlexPay/.test(l) && !/^\s*(\/\/|\*|\{\/\*)/.test(l))
    for (const l of flexpayLines) {
      // "not a loan" / "does not advance funds" is the framing; describing
      // FlexPay as fronting, lending or advancing money is not.
      expect(l).not.toMatch(/you pay later|\bfronts?\b|\bfronting\b|lends? you|advances? (you|your)|loans? you/i)
    }
    expect(src).not.toContain('you pay later')
  })
})
