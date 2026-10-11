/** S582: platform lease-date rules — start (available_date/today) + month-end term. */
import { describe, it, expect } from 'vitest'
import { serverTodayYmd, computeLeaseStart, computeLeaseEnd } from './leaseDates'

// Fixed "now" = noon Aug 5, 2026 in Phoenix, as an absolute instant (S654: a
// server-local Date meant the test's "today" moved with the machine's zone).
const NOW = new Date('2026-08-05T19:00:00Z')
const TZ = 'America/Phoenix'

describe('leaseDates', () => {
  it('serverTodayYmd formats local Y-M-D', () => {
    const local = new Date(2026, 7, 5, 12, 0, 0)
    expect(serverTodayYmd(local)).toBe('2026-08-05')
  })

  describe('computeLeaseStart', () => {
    it('future available_date → uses it', () => {
      expect(computeLeaseStart('2026-09-01', NOW, TZ)).toBe('2026-09-01')
    })
    it('past available_date → today (never backdated)', () => {
      expect(computeLeaseStart('2026-01-10', NOW, TZ)).toBe('2026-08-05')
    })
    it('no available_date → today', () => {
      expect(computeLeaseStart(null, NOW, TZ)).toBe('2026-08-05')
    })
    it('today is the property\'s day: 6 pm Phoenix is still Aug 5 though UTC is Aug 6 (S654)', () => {
      const evening = new Date('2026-08-06T01:00:00Z')
      expect(computeLeaseStart(null, evening, TZ)).toBe('2026-08-05')
      expect(computeLeaseStart('2026-08-05', evening, TZ)).toBe('2026-08-05')
    })
    it('accepts a Date object', () => {
      expect(computeLeaseStart(new Date(Date.UTC(2026, 8, 15, 12)), NOW, TZ)).toBe('2026-09-15')
    })
  })

  describe('computeLeaseEnd (month-end snap)', () => {
    it('mid-month start + 12mo → last day of the 12th full month', () => {
      // Aug 15 2026: prorate Aug, first full month Sep 2026, +12 full → Aug 31 2027.
      expect(computeLeaseEnd('2026-08-15', 12)).toBe('2027-08-31')
    })
    it('first-of-month start + 12mo → 12 full months, month-end', () => {
      // Aug 1 2026: 12 full months Aug 2026..Jul 2027 → Jul 31 2027.
      expect(computeLeaseEnd('2026-08-01', 12)).toBe('2027-07-31')
    })
    it('handles month-length differences (1mo from Jan 15 → Feb 28)', () => {
      expect(computeLeaseEnd('2026-01-15', 1)).toBe('2026-02-28')
    })
    it('6mo from Jan 31 → Jul 31 (partial Jan + 6 full Feb–Jul)', () => {
      expect(computeLeaseEnd('2026-01-31', 6)).toBe('2026-07-31')
    })
    it('non-positive / null term → null (month-to-month, no end)', () => {
      expect(computeLeaseEnd('2026-08-15', 0)).toBeNull()
      expect(computeLeaseEnd('2026-08-15', null)).toBeNull()
    })
    it('always ends ≥ a full year for a 12mo term', () => {
      const end = computeLeaseEnd('2026-08-15', 12)!
      expect(end >= '2027-08-15').toBe(true) // ≥ 12 months after the start
    })
  })
})
