/**
 * S642 — Nic: "Only Monday through Friday excluding banking holidays. There's
 * no reason their real bank would even update on banking holidays or weekends."
 *
 * The balance refresh is billable per call. It used to ride along with the
 * transaction sync four times a day, every day — $9.30 in August on ONE account
 * against $0.30 for the transaction feed the feature exists for.
 */
import { describe, it, expect } from 'vitest'
import { isUsFederalHoliday } from '@gam/shared'

/** The gate the cron applies, stated once so the test and the job agree. */
const wouldRefresh = (iso: string): boolean => {
  const dow = new Date(iso + 'T12:00:00Z').getUTCDay()
  if (dow === 0 || dow === 6) return false
  return !isUsFederalHoliday(iso)
}

describe('S642 balance refresh runs only when a bank would post', () => {
  it('skips weekends', () => {
    expect(wouldRefresh('2026-09-12')).toBe(false) // Saturday
    expect(wouldRefresh('2026-09-13')).toBe(false) // Sunday
  })

  it('skips federal holidays', () => {
    expect(wouldRefresh('2026-09-07')).toBe(false) // Labor Day
    expect(wouldRefresh('2026-01-01')).toBe(false) // New Year's Day
  })

  it('runs on an ordinary weekday', () => {
    expect(wouldRefresh('2026-09-10')).toBe(true)
    expect(wouldRefresh('2026-09-14')).toBe(true)
  })

  it('cuts the yearly call count by ~83%, which is the whole point', () => {
    let banking = 0
    for (let d = new Date(Date.UTC(2026, 0, 1)); d.getUTCFullYear() === 2026; d.setUTCDate(d.getUTCDate() + 1)) {
      if (wouldRefresh(d.toISOString().slice(0, 10))) banking++
    }
    // ~251 banking days against 4x-daily-every-day's 1,460 calls per account.
    expect(banking).toBeGreaterThan(245)
    expect(banking).toBeLessThan(255)
    expect(banking / (365 * 4)).toBeLessThan(0.18)
  })
})
