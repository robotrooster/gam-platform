/**
 * S607 — autopay scheduling helpers.
 *
 * Reduced alongside the service (Nic): the late-fee projection is gone. Autopay
 * reads the live outstanding balance at charge time rather than predicting it,
 * so there is no forecast left to test — only the date arithmetic that decides
 * WHEN the charge runs.
 */
import { describe, it, expect } from 'vitest'
import { payDateForPullDay } from './autopayProjection'

describe('payDateForPullDay', () => {
  it('null means the due date itself', () => {
    expect(payDateForPullDay('2026-09-01', null)).toBe('2026-09-01')
  })

  it('a later day is the same month', () => {
    expect(payDateForPullDay('2026-09-01', 9)).toBe('2026-09-09')
  })

  it('the due day itself is the due date', () => {
    expect(payDateForPullDay('2026-09-05', 5)).toBe('2026-09-05')
  })

  it('an earlier day rolls to next month — it cannot mean "before it is owed"', () => {
    expect(payDateForPullDay('2026-09-05', 1)).toBe('2026-10-01')
  })

  it('rolls the year at December', () => {
    expect(payDateForPullDay('2026-12-05', 1)).toBe('2027-01-01')
  })

  // 28 is the ceiling the table enforces: 29-31 do not exist every month, and a
  // schedule that silently skips February is worse than no schedule.
  it('handles the 28th, the highest day the table allows', () => {
    expect(payDateForPullDay('2026-02-01', 28)).toBe('2026-02-28')
  })
})
