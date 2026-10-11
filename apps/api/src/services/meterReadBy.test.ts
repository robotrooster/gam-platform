/**
 * S648 (Nic): a tenant billed on their own day has their meter read the last
 * business day before it — "If their due date is going to be Monday, read it on
 * Friday... if the day before is a holiday... read it the last business day
 * before the due date, but also not a holiday."
 */
import { describe, it, expect } from 'vitest'
import { lastBusinessDayBefore, meterReadBy } from './utilityReadingRuns'

describe('meter read-by dates', () => {
  it('Monday due → Friday read', () => {
    // Monday 19 Oct 2026
    expect(lastBusinessDayBefore('2026-10-19')).toBe('2026-10-16')
  })
  it('Friday due → Thursday read', () => {
    expect(lastBusinessDayBefore('2026-10-16')).toBe('2026-10-15')
  })
  it('skips a federal holiday', () => {
    // Tue 13 Oct 2026 due; Mon 12 Oct is Columbus Day → Fri 9 Oct
    expect(lastBusinessDayBefore('2026-10-13')).toBe('2026-10-09')
  })
  it('due on the 1st reads on the last business day of the cycle month, as always', () => {
    expect(meterReadBy('2026-09-01', 1)).toBe('2026-09-30')
  })
  it('due on the 15th reads the business day before the 15th of the next month', () => {
    // Thu 15 Oct 2026
    expect(meterReadBy('2026-09-01', 15)).toBe('2026-10-14')
  })
  it('crosses the year', () => {
    // Fri 15 Jan 2027
    expect(meterReadBy('2026-12-01', 15)).toBe('2027-01-14')
  })
})
