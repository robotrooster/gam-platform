/**
 * 10/22 (Nic) — WHAT A PRO-RATED REFUND WOULD HAVE GIVEN BACK.
 *
 *   "instead of refunding the difference when people leave early... they paid
 *    for a month, they leave in the middle of the month, and we just call it a
 *    wash on the last electric. If they leave right at the end of the time they
 *    paid for, we still bill. And that was the whole point of the wash, was to
 *    figure out how much we would have refunded that we're not refunding, and
 *    how much electric we didn't bill that we could be billing."
 *
 *   "they would be pro rated at the monthly divided by days of the month not
 *    the daily rate. just for rvs."
 *
 * The real case this was built for: Tyler Schroeder on RV 20 and Donavan Denny
 * on RV 41, both month-to-month at $589 with rent due the 1st.
 */
import { describe, it, expect } from 'vitest'
import { rentPeriodAround, proratedUnusedRent } from './earlyDepartureWash'

const RENT = 589

describe('the month they are actually in', () => {
  it('rent due the 1st is the calendar month', () => {
    expect(rentPeriodAround('2026-10-20', 1)).toEqual({ start: '2026-10-01', end: '2026-10-31' })
    expect(rentPeriodAround('2026-02-14', 1)).toEqual({ start: '2026-02-01', end: '2026-02-28' })
  })

  it('a due day mid-month straddles two calendar months', () => {
    expect(rentPeriodAround('2026-10-20', 15)).toEqual({ start: '2026-10-15', end: '2026-11-14' })
    expect(rentPeriodAround('2026-10-02', 15)).toEqual({ start: '2026-09-15', end: '2026-10-14' })
  })

  it('crosses the new year both ways', () => {
    expect(rentPeriodAround('2027-01-05', 10)).toEqual({ start: '2026-12-10', end: '2027-01-09' })
    expect(rentPeriodAround('2026-12-20', 10)).toEqual({ start: '2026-12-10', end: '2027-01-09' })
  })

  it('a nonsense due day falls back to the 1st rather than inventing a period', () => {
    for (const bad of [0, -3, 31, NaN]) {
      expect(rentPeriodAround('2026-10-20', bad as number).start).toBe('2026-10-01')
    }
  })
})

describe('what would have gone back', () => {
  const period = rentPeriodAround('2026-10-20', 1)

  it('Donavan and Tyler: $589 in a 31-day month is $19.00 a night', () => {
    const out = proratedUnusedRent({ monthlyRent: RENT, period, leftOn: '2026-10-20' })
    expect(out.daysInPeriod).toBe(31)
    expect(out.perDay).toBe(19)
    // Gone the morning of the 20th, so the NIGHTS of the 20th through the 31st
    // are all unused — twelve of them.
    expect(out.daysUnused).toBe(12)
    expect(out.wouldRefund).toBe(228)
  })

  // 10/22 (Nic): "RVs usually bill by the night, just like hotel rooms... We're
  // not charging them for the leaving day."
  it('the night of the leaving day is NOT charged — the site is sold again that night', () => {
    const a = proratedUnusedRent({ monthlyRent: RENT, period, leftOn: '2026-10-20' })
    const b = proratedUnusedRent({ monthlyRent: RENT, period, leftOn: '2026-10-21' })
    expect(a.daysUnused - b.daysUnused).toBe(1)
    // Leaving on the last day still leaves that night unsold.
    expect(proratedUnusedRent({ monthlyRent: RENT, period, leftOn: '2026-10-31' }).daysUnused).toBe(1)
  })

  it('using every night they paid for refunds nothing, so nothing washes', () => {
    // They stayed the night of the 31st and left the next morning.
    const out = proratedUnusedRent({ monthlyRent: RENT, period, leftOn: '2026-11-01' })
    expect(out.daysUnused).toBe(0)
    expect(out.wouldRefund).toBe(0)
  })

  it('it is THEIR month being divided, not an average one', () => {
    // The same rent and the same "left on the 20th" gives a different day rate
    // in February than in July, which is the point of dividing by the days in
    // that month rather than by 30.
    const feb = proratedUnusedRent({ monthlyRent: RENT, period: rentPeriodAround('2026-02-20', 1), leftOn: '2026-02-20' })
    const jul = proratedUnusedRent({ monthlyRent: RENT, period: rentPeriodAround('2026-07-20', 1), leftOn: '2026-07-20' })
    expect(feb.daysInPeriod).toBe(28)
    expect(jul.daysInPeriod).toBe(31)
    expect(feb.perDay).toBeGreaterThan(jul.perDay)
  })

  it('is never the nightly rate — a six-month resident is not re-priced as a tourist', () => {
    // RV 20's site is $49 a night. Twelve nights at that would be $588, almost
    // the entire month's rent, and is not what he asked for.
    const out = proratedUnusedRent({ monthlyRent: RENT, period, leftOn: '2026-10-20' })
    expect(out.wouldRefund).toBeLessThan(12 * 49)
    expect(out.wouldRefund).toBe(round2(RENT / 31 * 12))
  })

  it('a move-out dated before the period started never refunds more than the period', () => {
    const out = proratedUnusedRent({ monthlyRent: RENT, period, leftOn: '2026-09-15' })
    expect(out.daysUnused).toBe(31)
    expect(out.wouldRefund).toBe(RENT)
  })

  it('a move-out dated after the period refunds nothing at all', () => {
    const out = proratedUnusedRent({ monthlyRent: RENT, period, leftOn: '2026-12-05' })
    expect(out.daysUnused).toBe(0)
    expect(out.wouldRefund).toBe(0)
  })
})

const round2 = (n: number) => Math.round(n * 100) / 100
