/**
 * S577 — retroactive late-fee counting (nextAccrualDate accrualFrom modes).
 * Pure date-math proof for the money calc before it's wired into billing.
 *
 * Scenario throughout: rent due the 1st, 3-day grace, DAILY accrual.
 */
import { describe, it, expect } from 'vitest'
import { nextAccrualDate } from '@gam/shared'

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
