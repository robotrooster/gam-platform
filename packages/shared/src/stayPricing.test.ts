/**
 * 10/6 (Nic): "It's saying six nights for $312. Well, our weekly price is
 * $269. It should be charging them ... the cheapest option for them."
 *
 * priceStay is THE price of a stay at every door: the cheapest whole months
 * (calendar months from arrival), weeks (7 nights) and nights that cover the
 * nights stayed. These pin it down with the rates Nic quoted (nightly $49,
 * weekly $269, monthly $589), with each rate missing in turn, and the lodging
 * tax rule (under 30 nights, unless the stay is exactly whole calendar months).
 */
import { describe, it, expect } from 'vitest'
import {
  priceStay, priceStayBetween, stayPlanWords, stayLowerRateWords, addCalendarMonths, addStayDays, stayNightsBetween,
} from './stayPricing'

const ALL = { nightly: 49, weekly: 269, monthly: 589 }
const ARRIVE = '2026-10-04' // Oct 4 → Nov 4 is a 31-night month

describe('priceStay — the cheapest whole months, weeks and nights that cover the stay', () => {
  // [nights, base, charged as]
  const table: Array<[number, number, string]> = [
    [6, 269, '1 week'],              // the week is cheaper than six nights ($294)
    [7, 269, '1 week'],
    [8, 318, '1 week + 1 night'],
    [13, 538, '2 weeks'],            // two weeks beat a week and six nights ($563)
    [14, 538, '2 weeks'],
    [20, 589, '1 month'],            // a month beats 2 weeks + 6 nights ($832) and 3 weeks ($807)
    [25, 589, '1 month'],
    [30, 589, '1 month'],
    [31, 589, '1 month'],            // Oct 4 → Nov 4
    [45, 1127, '1 month + 2 weeks'], // 31 nights, then 14
  ]
  for (const [nights, base, words] of table) {
    it(`${nights} nights → ${words}, $${base} before tax`, () => {
      const p = priceStay(ALL, 0, ARRIVE, nights)
      expect(p.base).toBe(base)
      expect(p.total).toBe(base)
      expect(stayPlanWords(p.plan)).toBe(words)
      expect(p.coveredNights).toBeGreaterThanOrEqual(nights)
    })
  }

  it('the lodging tax is figured on the charged base: under 30 nights, never at 30+', () => {
    expect(priceStay(ALL, 10, ARRIVE, 6)).toMatchObject({ base: 269, tax: 26.9, total: 295.9, taxable: true, taxRate: 0.1 })
    expect(priceStay(ALL, 10, ARRIVE, 8)).toMatchObject({ base: 318, tax: 31.8, total: 349.8 })
    // A 25-night stay charged at the monthly rate is still a 25-night stay.
    expect(priceStay(ALL, 10, ARRIVE, 25)).toMatchObject({ base: 589, tax: 58.9, total: 647.9, taxable: true })
    expect(priceStay(ALL, 10, ARRIVE, 30)).toMatchObject({ base: 589, tax: 0, total: 589, taxable: false })
    expect(priceStay(ALL, 10, ARRIVE, 45)).toMatchObject({ base: 1127, tax: 0, total: 1127 })
  })

  it('a stay that is exactly a calendar month is never taxed (a month rung up at the register)', () => {
    // Feb 1 → Mar 1 is 28 nights.
    expect(priceStay(ALL, 10, '2027-02-01', 28)).toMatchObject({ base: 589, tax: 0, total: 589, plan: { months: 1, weeks: 0, nights: 0 } })
  })

  it('the guest pays the lower total, tax in', () => {
    // 13 nights: two weeks $538 + 10% = $591.80; a month would be $589 + 10% = $647.90.
    expect(priceStay(ALL, 10, ARRIVE, 13)).toMatchObject({ total: 591.8, plan: { months: 0, weeks: 2, nights: 0 } })
  })

  it('31 nights from a 30-day-month arrival needs a month and a night', () => {
    // Nov 4 → Dec 4 is 30 nights.
    expect(priceStay(ALL, 0, '2026-11-04', 31)).toMatchObject({ base: 589 + 49, plan: { months: 1, weeks: 0, nights: 1 } })
  })

  describe('a rate the site does not have is skipped', () => {
    const cases: Array<[string, Record<string, number | null>, Array<[number, number]>]> = [
      ['no nightly rate', { nightly: null, weekly: 269, monthly: 589 },
        [[6, 269], [7, 269], [8, 538], [13, 538], [14, 538], [20, 589], [25, 589], [30, 589], [31, 589], [45, 1127]]],
      ['no weekly rate', { nightly: 49, weekly: null, monthly: 589 },
        [[6, 294], [7, 343], [8, 392], [13, 589], [14, 589], [20, 589], [25, 589], [30, 589], [31, 589], [45, 1178]]],
      ['no monthly rate', { nightly: 49, weekly: 269, monthly: null },
        [[6, 269], [7, 269], [8, 318], [13, 538], [14, 538], [20, 807], [25, 1003], [30, 1174], [31, 1223], [45, 1761]]],
      ['only a nightly rate', { nightly: 49, weekly: null, monthly: null },
        [[6, 294], [7, 343], [30, 1470], [45, 2205]]],
      ['only a monthly rate', { nightly: null, weekly: null, monthly: 589 },
        [[6, 589], [31, 589], [45, 1178]]],
    ]
    for (const [name, rates, rows] of cases) {
      it(name, () => {
        for (const [nights, base] of rows) {
          expect(priceStay(rates, 0, ARRIVE, nights).base, `${nights} nights`).toBe(base)
        }
      })
    }
    it('no rate at all prices nothing', () => {
      expect(priceStay({ nightly: null, weekly: '', monthly: 0 }, 10, ARRIVE, 6)).toMatchObject({ total: 0, base: 0, tax: 0 })
    })
  })

  it('rates and tax may arrive as database strings', () => {
    expect(priceStay({ nightly: '49.00', weekly: '269.00', monthly: '589.00' }, '10', ARRIVE, 6).total).toBe(295.9)
  })

  it('priceStayBetween counts nights as check-out − check-in', () => {
    // Leaving on the 5th from the 30th is five nights, not six.
    expect(priceStayBetween(ALL, 0, '2026-09-30', '2026-10-05')).toMatchObject({ nights: 5, base: 245 })
  })
})

describe('the words that say how a stay is charged', () => {
  it('says when a bigger rate made it the lower price', () => {
    expect(stayLowerRateWords(priceStay(ALL, 0, ARRIVE, 6))).toBe('charged at the weekly rate, the lower price')
    expect(stayLowerRateWords(priceStay(ALL, 0, ARRIVE, 25))).toBe('charged at the monthly rate, the lower price')
    expect(stayLowerRateWords(priceStay(ALL, 0, ARRIVE, 3))).toBeNull()
    // Rung up as a week, charged as a week: nothing to explain.
    expect(stayLowerRateWords(priceStay(ALL, 0, ARRIVE, 7), 'weekly')).toBeNull()
  })

  it('never says "the lower price" when there was no smaller rate to beat (10/6 review)', () => {
    // A weekly-only site: three nights are simply charged as a week.
    const weeklyOnly = priceStay({ weekly: 269 }, 0, ARRIVE, 3)
    expect(weeklyOnly.lowerPrice).toBe(false)
    expect(stayLowerRateWords(weeklyOnly)).toBe('charged at the weekly rate')
    // A monthly-only site, 10 nights.
    expect(stayLowerRateWords(priceStay({ monthly: 589 }, 0, ARRIVE, 10))).toBe('charged at the monthly rate')
    // Nightly + weekly where the smaller rate is beaten: it is the lower price.
    expect(priceStay(ALL, 0, ARRIVE, 6).lowerPrice).toBe(true)
  })
})

describe('the first month of a 30+ night stay booked online (10/6 review)', () => {
  it('a February month priced with no tax picks the cheaper of the month and four weeks', () => {
    // Weekly $100: four weeks ($400) beat the month ($589) for Feb 1 → Mar 1.
    const p = priceStay({ nightly: 49, weekly: 100, monthly: 589 }, 0, '2027-02-01', 28)
    expect(p).toMatchObject({ total: 400, tax: 0, plan: { months: 0, weeks: 4, nights: 0 } })
  })
})

describe('calendar days', () => {
  it('a month from arrival keeps the day, held to a short month', () => {
    expect(addCalendarMonths('2026-10-04', 1)).toBe('2026-11-04')
    expect(addCalendarMonths('2027-01-31', 1)).toBe('2027-02-28')
    expect(addCalendarMonths('2028-01-31', 1)).toBe('2028-02-29')
    expect(addCalendarMonths('2026-12-15', 2)).toBe('2027-02-15')
  })
  it('days and nights', () => {
    expect(addStayDays('2026-10-30', 4)).toBe('2026-11-03')
    expect(stayNightsBetween('2026-10-30', '2026-11-03')).toBe(4)
  })
})
