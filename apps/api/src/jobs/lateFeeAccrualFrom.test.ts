/**
 * S577 — retroactive late-fee counting (nextAccrualDate accrualFrom modes).
 * Pure date-math proof for the money calc before it's wired into billing.
 *
 * Scenario throughout: rent due the 1st, 3-day grace, DAILY accrual.
 */
import { describe, it, expect } from 'vitest'
import { nextAccrualDate, lateFeeStartDate, addAccrualPeriods } from '@gam/shared'

const DUE = '2026-05-01'
const GRACE = 3

// Collect the daily tick dates from occ=1 up to (and including) a pay date.
function ticksUpTo(payDate: string, accrualFrom: any): string[] {
  const out: string[] = []
  for (let occ = 1; occ <= 400; occ++) {
    const d = nextAccrualDate(DUE, GRACE, 'daily', occ, accrualFrom)
    if (d > payDate) break
    out.push(d)
  }
  return out
}

describe('nextAccrualDate — accrualFrom modes', () => {
  it('grace_end (default): daily accrual starts the day AFTER grace ends', () => {
    // grace end = 2026-05-04; occ 1 = 05-05
    expect(nextAccrualDate(DUE, GRACE, 'daily', 1)).toBe('2026-05-05')
    expect(nextAccrualDate(DUE, GRACE, 'daily', 1, 'grace_end')).toBe('2026-05-05')
    // paid the 10th → ticks 05-05..05-10 = 6 days
    expect(ticksUpTo('2026-05-10', 'grace_end')).toHaveLength(6)
  })

  it('due_date: counts each day AFTER the due date (exclusive of the 1st)', () => {
    expect(nextAccrualDate(DUE, GRACE, 'daily', 1, 'due_date')).toBe('2026-05-02')
    // paid the 10th → 05-02..05-10 = 9 days
    expect(ticksUpTo('2026-05-10', 'due_date')).toHaveLength(9)
  })

  it('due_date_inclusive: counts the due date itself as day one', () => {
    expect(nextAccrualDate(DUE, GRACE, 'daily', 1, 'due_date_inclusive')).toBe('2026-05-01')
    // paid the 10th → 05-01..05-10 = 10 days ($5/day → $50)
    expect(ticksUpTo('2026-05-10', 'due_date_inclusive')).toHaveLength(10)
  })

  it('weekly retroactive anchors on the due date', () => {
    expect(nextAccrualDate(DUE, GRACE, 'weekly', 1, 'due_date_inclusive')).toBe('2026-05-01')
    expect(nextAccrualDate(DUE, GRACE, 'weekly', 2, 'due_date_inclusive')).toBe('2026-05-08')
    expect(nextAccrualDate(DUE, GRACE, 'weekly', 1, 'due_date')).toBe('2026-05-08')
  })

  it('monthly retroactive anchors on the due date with last-day clamp', () => {
    expect(nextAccrualDate('2026-01-31', 0, 'monthly', 1, 'due_date_inclusive')).toBe('2026-01-31')
    expect(nextAccrualDate('2026-01-31', 0, 'monthly', 2, 'due_date_inclusive')).toBe('2026-02-28')
  })
})

// 10/12 (Nic): "zero grace: NEXT DAY is late (paying on the due date is on
// time)" — the first late day is the start + max(grace, 1).
describe('a grace of 0: the first late day is the day after', () => {
  it('lateFeeStartDate never returns the due date itself', () => {
    expect(lateFeeStartDate(DUE, 0)).toBe('2026-05-02')
    expect(lateFeeStartDate(DUE, 1)).toBe('2026-05-02')
    expect(lateFeeStartDate(DUE, 5)).toBe('2026-05-06')
  })

  it('counted from the grace end, the first daily fee after it is the next day', () => {
    expect(nextAccrualDate(DUE, 0, 'daily', 1, 'grace_end')).toBe('2026-05-03')
  })

  it('a count back still starts at the due date (grace never moves it)', () => {
    expect(nextAccrualDate(DUE, 0, 'daily', 1, 'due_date_inclusive')).toBe('2026-05-01')
  })
})

describe('addAccrualPeriods', () => {
  it('days, weeks, and months clamped from the anchor day', () => {
    expect(addAccrualPeriods('2026-05-06', 'daily', 3)).toBe('2026-05-09')
    expect(addAccrualPeriods('2026-05-06', 'weekly', 2)).toBe('2026-05-20')
    expect(addAccrualPeriods('2026-01-31', 'monthly', 1)).toBe('2026-02-28')
    expect(addAccrualPeriods('2026-01-31', 'monthly', 2)).toBe('2026-03-31')
    expect(addAccrualPeriods('2026-11-15', 'monthly', 3)).toBe('2027-02-15')
  })
})
