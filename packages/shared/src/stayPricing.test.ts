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
  priceStay, priceStayBetween, priceNightsStayed, priceNightsStayedBetween, stayPlanWords, stayLowerRateWords,
  addCalendarMonths, addStayDays, stayNightsBetween, finalMonthRentOnMoveOut, finalRentMonthStart,
  type StayRates,
} from './stayPricing'
import { prorateMoveInRent, roundHalfEvenCents } from './moveInCharges'

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

/**
 * 10/18 (Nic): "if somebody stays for, I don't know, six months or so, and
 * they're at the monthly rate, when they go to move out, I want that prorated
 * amount to be divided by the 30 days or whatever. So like if they paid for a
 * whole month and they're, you know, four or five months in and they leave
 * like two weeks later, it would need to be about a 50% refund, not calculated
 * off the weekly rate. Because I don't want to do that to people that are, you
 * know, long-term good customers."
 *
 * priceNightsStayed is what the days a guest ACTUALLY STAYED are worth when
 * they leave early. Selling is still priceStay and still never prorates.
 * The site Nic was looking at: $55 a night, $286 a week, $589 a month.
 */
describe('priceNightsStayed — a long-term guest\'s tail is prorated, not re-rated', () => {
  const SITE = { nightly: 55, weekly: 286, monthly: 589 }
  // May 18 → Sep 18 is four whole months (123 nights); Sep 18 → Oct 2 is 14 more.
  const LONG_IN = '2026-05-18'

  it('four months in, leaving 14 days into the fifth: the 14 days are a prorated month, not two weeks', () => {
    expect(stayNightsBetween(LONG_IN, '2026-09-18')).toBe(123)
    const n = stayNightsBetween(LONG_IN, '2026-10-02')
    expect(n).toBe(137)

    // What it used to cost: 4 months ($2,356) + 2 weeks at $286 ($572).
    const ladder = priceStay(SITE, 0, LONG_IN, n)
    expect(ladder).toMatchObject({ base: 2928, total: 2928, plan: { months: 4, weeks: 2, nights: 0 } })

    // What it costs now: 4 months + 14 ÷ 30 of a month (Sep 18 → Oct 18 is 30 days).
    const stayed = priceNightsStayed(SITE, 0, LONG_IN, n)
    expect(stayed).toMatchObject({
      prorated: true, proratedDays: 14, prorationPeriodDays: 30, proratedTail: 274.87,
      base: 2630.87, tax: 0, total: 2630.87, tier: 'monthly', taxable: false,
      plan: { months: 4, weeks: 0, nights: 0 }, coveredNights: 137,
    })
    expect(589 * 14 / 30).toBeCloseTo(274.8667, 4)

    // A guest who paid for five months up front ($2,945) and left on day 137:
    // $17.00 back before, $314.13 back now — about half a month ($294.50).
    const booked = priceStay(SITE, 0, LONG_IN, stayNightsBetween(LONG_IN, '2026-10-18')).total
    expect(booked).toBe(2945)
    expect(Math.round((booked - ladder.total) * 100) / 100).toBe(17)
    expect(Math.round((booked - stayed.total) * 100) / 100).toBe(314.13)
  })

  it('priceNightsStayedBetween prices the same days between two days', () => {
    expect(priceNightsStayedBetween(SITE, 0, LONG_IN, '2026-10-02')).toMatchObject({ total: 2630.87, prorated: true })
  })

  it('a 14-night stay from day one is untouched — still two weeks ("No, that\'s fine")', () => {
    const stayed = priceNightsStayed(SITE, 0, '2026-10-04', 14)
    expect(stayed).toMatchObject({ total: 572, prorated: false, proratedDays: 0, plan: { months: 0, weeks: 2, nights: 0 } })
    expect(stayed.total).toBe(priceStay(SITE, 0, '2026-10-04', 14).total)
  })

  it('a stay the month only COVERS — 20 or 25 nights — is never cut into a prorated piece', () => {
    for (const n of [20, 25]) {
      const stayed = priceNightsStayed(SITE, 10, '2026-10-04', n)
      expect(stayed, `${n} nights`).toMatchObject({ total: 647.9, prorated: false, plan: { months: 1, weeks: 0, nights: 0 } })
    }
  })

  it('a stay of exactly whole calendar months is unchanged and still untaxed', () => {
    // Feb 1 → Mar 1 is 28 nights; Feb 1 → Apr 1 is 59.
    expect(priceNightsStayed(SITE, 10, '2027-02-01', 28)).toMatchObject({
      total: 589, tax: 0, taxable: false, prorated: false, plan: { months: 1, weeks: 0, nights: 0 },
    })
    expect(priceNightsStayed(SITE, 10, '2027-02-01', 59)).toMatchObject({ total: 1178, tax: 0, taxable: false, prorated: false })
  })

  it('when the prorated tail would cost MORE than the ladder, the ladder wins', () => {
    // A $130 week makes two weeks ($260) cheaper than 14 ÷ 30 of the month ($274.87).
    const cheapWeek = { nightly: 55, weekly: 130, monthly: 589 }
    const n = 45 // Oct 4 → Nov 4 is 31 nights, then 14
    const ladder = priceStay(cheapWeek, 0, '2026-10-04', n)
    expect(ladder).toMatchObject({ total: 849, plan: { months: 1, weeks: 2, nights: 0 } })
    expect(priceNightsStayed(cheapWeek, 0, '2026-10-04', n)).toMatchObject({ total: 849, prorated: false, proratedTail: 0 })
  })

  // 10/18 (review): a site whose month costs MORE than four of its weeks
  // ($589 a month, $130 a week). The price ladder sells those stays in weeks,
  // so keying the proration off the ladder's own plan left exactly the
  // long-term guest Nic is protecting re-rated at the weekly rate — and made
  // one more night cheaper than the night before it.
  describe('a site where the month costs more than four weeks still prorates the tail', () => {
    const WEEK_SITE = { nightly: 55, weekly: 130, monthly: 589 }
    const IN = '2026-12-15' // Dec 15 → Jan 15 is 31 nights, so a month is up on night 31

    it('36 nights: a whole month HAS gone by, so the 5 leftover days are a prorated month', () => {
      // The ladder's cheapest plan here holds no month at all — 5 weeks and a night.
      expect(priceStay(WEEK_SITE, 0, IN, 36)).toMatchObject({ total: 705, plan: { months: 0, weeks: 5, nights: 1 } })
      expect(priceNightsStayed(WEEK_SITE, 0, IN, 36)).toMatchObject({
        prorated: true, proratedDays: 5, prorationPeriodDays: 31, proratedTail: 95,
        base: 684, total: 684, tier: 'monthly', plan: { months: 1, weeks: 0, nights: 0 },
      })
    })

    it('one more night never costs the guest less', () => {
      const totals = [31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 45, 50, 60, 62, 70]
        .map((n) => ({ n, total: priceNightsStayed(WEEK_SITE, 0, IN, n).total }))
      expect(totals.map((x) => x.total)).toEqual([589, 608, 627, 646, 650, 684, 703, 719, 741, 760, 849, 950, 1140, 1170, 1300])
      for (let i = 1; i < totals.length; i++) {
        expect(totals[i].total, `${totals[i].n} nights vs ${totals[i - 1].n}`).toBeGreaterThanOrEqual(totals[i - 1].total)
      }
    })

    it('still never more than the guest would have paid before (31 nights the ladder sells as a month)', () => {
      for (let n = 1; n <= 75; n++) {
        const stayed = priceNightsStayed(WEEK_SITE, 0, IN, n)
        expect(stayed.total, `${n} nights`).toBeLessThanOrEqual(priceStay(WEEK_SITE, 0, IN, n).total)
      }
    })
  })

  it('the lodging tax rule does not change: a prorated stay under 30 nights is still taxed, 30+ never', () => {
    // Feb 1 + 29 nights: one whole month (28) and one day left over, under 30 nights.
    const short = priceNightsStayed(SITE, 10, '2027-02-01', 29)
    expect(short).toMatchObject({
      prorated: true, proratedDays: 1, prorationPeriodDays: 31, proratedTail: 19,
      base: 608, tax: 60.8, total: 668.8, taxable: true, taxRate: 0.1,
    })
    expect(priceStay(SITE, 10, '2027-02-01', 29).total).toBe(708.4)
    // 45 nights with the same 10%: 30+ nights, so no tax either way.
    expect(priceNightsStayed(SITE, 10, '2026-10-04', 45)).toMatchObject({ tax: 0, taxable: false, taxRate: 0, total: 863.87 })
  })

  it('the proration uses the ACTUAL days in that month, never a flat 30', () => {
    // Jan 15 → Feb 15 is 31 days, Feb 15 → Mar 15 is 28: the same 10 leftover
    // days are worth more out of the short month.
    const a = priceNightsStayed(SITE, 0, '2027-01-15', 31 + 10)
    expect(a).toMatchObject({ proratedDays: 10, prorationPeriodDays: 28, proratedTail: 210.36 })
    const b = priceNightsStayed(SITE, 0, '2027-02-15', 28 + 10)
    expect(b).toMatchObject({ proratedDays: 10, prorationPeriodDays: 31, proratedTail: 190 })
  })

  it('a site with no monthly rate, and no days at all, price exactly as before', () => {
    expect(priceNightsStayed({ nightly: 55, weekly: 286 }, 0, LONG_IN, 137)).toMatchObject({
      prorated: false, total: priceStay({ nightly: 55, weekly: 286 }, 0, LONG_IN, 137).total,
    })
    expect(priceNightsStayed(SITE, 10, LONG_IN, 0)).toMatchObject({ total: 0, prorated: false })
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

/**
 * 10/18 (Nic) — NIC'S REFUND RULE, AND THE TWO PROPERTY SETTINGS.
 *
 *   "refunds are pro rated to the next price down. people pay for a week they
 *    stay 4 days. the 4 day rate against the weekly rate is the difference for
 *    the refund if the landlord does refunds at all at that property. the only
 *    way it is different is for longer term people for rent pro ration. moving
 *    in or out at the middle of a month and also only if the landlord allows
 *    the pro rate. these should all be property level settings."
 *
 * "Next price down" needed no new arithmetic: priceStay already charges the
 * CHEAPEST combination that covers the days, which is never dearer than pricing
 * at the one rung below what they paid. The refund is what they paid less what
 * the days they stayed are worth, so a cheaper reckoning of those days is a
 * BIGGER refund — never a smaller one.
 *
 * WHICH OF THESE GUARD THE 10/18 CHANGE, and which do not (10/19 review, so
 * nobody reads an invariant as evidence about the change). "The ladder is never
 * dearer than the rung below" and "nobody is charged MORE than the ladder"
 * below are INVARIANTS of priceStay: they held before any of this was written
 * and they still pass with priceNightsStayed deleted and aliased to priceStay.
 * They are here to stay true, not to catch a revert. What catches a revert is
 * the exact figures — $2,630.87, $314.13, $274.87, $266.00, $646.61/$627.00 —
 * and "the prorated path is not the ladder", which fails the moment it is.
 */
describe("Nic's refund rule: pro rated to the next price down", () => {
  const SITE = { nightly: 55, weekly: 286, monthly: 589 }
  const ARRIVE_OCT = '2026-10-04'

  it('a week paid at $286, four days stayed at $55: charged $220, $66 back', () => {
    const stayed = priceNightsStayed(SITE, 0, ARRIVE_OCT, 4)
    expect(stayed).toMatchObject({ total: 220, base: 220, plan: { months: 0, weeks: 0, nights: 4 }, tier: 'nightly' })
    expect(Math.round((286 - stayed.total) * 100) / 100).toBe(66)
  })

  /**
   * THE EXACT STAY NIC APPROVED, read off production 10/19: Mountain View RV
   * Ranch, RV 10 and RV 11, $49 a night / $269 a week / $589 a month, lodging
   * tax 6.35%. Booked Sep 18 -> Oct 18 (a whole calendar month, $589, untaxed);
   * the guest left after 14 nights. Those 14 nights are two weeks at $269 =
   * $538, plus 6.35% = $572.16 -- so $16.84 of the month was unused. That is
   * the figure on both of the live check-out decisions, and nothing in this
   * change may move it.
   *
   *   "they stayed for 14 nights, but it's calculating it at the ... weekly
   *    rate. I see what you're doing there. ... So, okay. No, that's fine."
   */
  it('Mountain View, 10/18: a $589 month, 14 nights stayed, $572.16 worth, $16.84 unused', () => {
    const MOUNTAIN_VIEW = { nightly: 49, weekly: 269, monthly: 589 }
    const stayed = priceNightsStayed(MOUNTAIN_VIEW, 6.35, '2026-09-18', 14)
    expect(stayed).toMatchObject({
      base: 538, tax: 34.16, total: 572.16, taxable: true,
      plan: { months: 0, weeks: 2, nights: 0 }, tier: 'weekly', prorated: false,
    })
    expect(Math.round((589 - stayed.total) * 100) / 100).toBe(16.84)
    // The month they paid for: Sep 18 -> Oct 18 is a whole calendar month, so
    // it is untaxed -- $589 flat, which is what the booking says.
    expect(priceStay(MOUNTAIN_VIEW, 6.35, '2026-09-18', 30)).toMatchObject({ total: 589, taxable: false })
    // Neither answer to the mid-month-proration question may move it: 14 nights
    // from day one never reached a whole month, so there is no tail to prorate.
    for (const proratesMidMonth of [true, false]) {
      expect(priceNightsStayed(MOUNTAIN_VIEW, 6.35, '2026-09-18', 14, { proratesMidMonth }).total,
        `proratesMidMonth=${proratesMidMonth}`).toBe(572.16)
    }
  })

  it('the same shape at round rates: a $589 month, 14 nights, two $286 weeks, $17.00 back', () => {
    const stayed = priceNightsStayed(SITE, 0, ARRIVE_OCT, 14)
    expect(stayed).toMatchObject({ total: 572, plan: { months: 0, weeks: 2, nights: 0 }, tier: 'weekly', prorated: false })
    expect(Math.round((589 - stayed.total) * 100) / 100).toBe(17)
    expect(priceNightsStayed(SITE, 0, ARRIVE_OCT, 14, { proratesMidMonth: false }).total).toBe(572)
  })

  /**
   * Strict "next price down" = price the days at the tier immediately BELOW
   * the one they paid at. The ladder goes further down than that when it is
   * cheaper (10 nights out of a paid month: a week and 3 nights, not 2 weeks),
   * which is a bigger refund. What must never happen is the ladder coming out
   * DEARER than the rung below, because that would be a smaller refund than
   * Nic's rule promises.
   */
  // An INVARIANT of priceStay, true before 10/18 and after: it does not guard
  // the prorated tail (see the note above this describe).
  it('priceStay invariant: the ladder is never dearer than the rung below what they paid', () => {
    const sites: Array<[string, StayRates]> = [
      ['55 / 286 / 589 (the site Nic was looking at)', SITE],
      ['49 / 269 / 589', { nightly: 49, weekly: 269, monthly: 589 }],
      ['a month dearer than four weeks', { nightly: 55, weekly: 130, monthly: 589 }],
      ['no nightly rate', { nightly: null, weekly: 286, monthly: 589 }],
    ]
    const rungBelow: Record<'weekly' | 'monthly', (r: StayRates) => StayRates> = {
      monthly: (r) => ({ nightly: r.nightly, weekly: r.weekly }),
      weekly: (r) => ({ nightly: r.nightly }),
    }
    let compared = 0
    for (const [name, rates] of sites) {
      for (const arrive of ['2026-10-04', '2026-12-15', '2027-01-31', '2027-02-01']) {
        for (let n = 1; n <= 70; n++) {
          for (const paid of ['weekly', 'monthly'] as const) {
            const strict = priceStay(rungBelow[paid](rates), 0, arrive, n).total
            if (!(strict > 0)) continue // no rate below: nothing to compare
            compared++
            expect(priceStay(rates, 0, arrive, n).total, `${name} ${arrive} ${n} nights paid ${paid}`)
              .toBeLessThanOrEqual(strict)
          }
        }
      }
    }
    expect(compared).toBeGreaterThan(1000)
  })
})

/**
 * 10/18 (Nic): "also only if the landlord allows the pro rate. these should all
 * be property level settings." The long-stay tail is the stay-side half of
 * that setting; finalMonthRentOnMoveOut is the rent-side half.
 */
describe('mid-month proration is the property\'s call', () => {
  const SITE = { nightly: 55, weekly: 286, monthly: 589 }
  const LONG_IN = '2026-05-18' // four whole months by Sep 18 (123 nights), 14 more to Oct 2

  it('a park that prorates gives the long-term guest the month back in proportion', () => {
    expect(priceNightsStayed(SITE, 0, LONG_IN, 137, { proratesMidMonth: true })).toMatchObject({
      prorated: true, proratedDays: 14, prorationPeriodDays: 30, total: 2630.87,
    })
    // Left out entirely is the same answer: it is what the stay path does today.
    expect(priceNightsStayed(SITE, 0, LONG_IN, 137).total).toBe(2630.87)
  })

  it('a park where a whole month is a whole month prices those days off the ladder', () => {
    const off = priceNightsStayed(SITE, 0, LONG_IN, 137, { proratesMidMonth: false })
    expect(off).toMatchObject({ prorated: false, proratedDays: 0, proratedTail: 0, total: 2928 })
    expect(off.total).toBe(priceStay(SITE, 0, LONG_IN, 137).total)
    expect(stayPlanWords(off.plan)).toBe('4 months + 2 weeks')
  })

  // Also an invariant — priceNightsStayed returns min(ladder, prorated), so this
  // holds trivially. Kept because "never more than they would pay today" is the
  // promise the whole change rests on, not because it would catch a revert.
  /**
   * 10/19 (review): the prorated tail must be priced out of the month the
   * leftover days ACTUALLY FALL IN. addCalendarMonths holds the 31st to the
   * last day a short month has (Jan 31 → Feb 28), so measuring the window from
   * that clamped day reads February's length onto days that all sit in March.
   */
  it('the window is the days in the month those days fall in, even when the arrival day was clamped', () => {
    // In Jan 31, gone after 42 nights. One whole month fits (Jan 31 → Feb 28,
    // 28 nights); the 14 days left over run Feb 28 → Mar 14, inside a 31-day
    // March, so they are 14/31 of $589 = $266.00 — not 14/28 = $294.50.
    const late = priceNightsStayed(SITE, 0, '2026-01-31', 42)
    expect(late).toMatchObject({
      prorated: true, proratedDays: 14, prorationPeriodDays: 31, proratedTail: 266, base: 855, total: 855,
    })
    expect(Math.round(589 * 14 / 31 * 100) / 100).toBe(266)
    // $28.50 is what the clamp used to cost the guest in refund.
    expect(late.total).toBe(883.5 - 28.5)
    // Still below the ladder, so nobody pays more than they do today.
    expect(priceStay(SITE, 0, '2026-01-31', 42).total).toBe(1161)
    // An arrival on a day every month has reads the same either way.
    expect(priceNightsStayed(SITE, 0, '2026-01-15', 42).prorationPeriodDays).toBe(28)
  })

  /**
   * 10/19 (review): the lodging-tax cliff can make one MORE night stayed worth
   * LESS — a bigger refund, never a bigger charge. Pinned so nobody "fixes" it
   * by charging somebody more for staying less. See the note in stayPricing.ts.
   */
  it('the 30-night tax cliff: one more night stayed is worth less, in the guest\'s favor', () => {
    const in29 = priceNightsStayed(SITE, 6.35, '2026-02-01', 29)
    const in30 = priceNightsStayed(SITE, 6.35, '2026-02-01', 30)
    expect(in29).toMatchObject({ base: 608, taxable: true, total: 646.61 })
    expect(in30).toMatchObject({ base: 627, taxable: false, total: 627 })
    expect(Math.round((in29.total - in30.total) * 100) / 100).toBe(19.61)
    // The ladder rises across the same step — the cliff is there too, but a
    // whole extra night outweighs the tax it drops.
    expect(priceStay(SITE, 6.35, '2026-02-01', 29).total).toBe(684.89)
    expect(priceStay(SITE, 6.35, '2026-02-01', 30).total).toBe(699)
  })

  /**
   * The guard that actually fails on a revert: aliasing priceNightsStayed to
   * priceStay keeps every invariant above true, and breaks this.
   */
  it('the prorated path is not the ladder', () => {
    const LONG = '2026-05-18'
    const stayed = priceNightsStayed(SITE, 0, LONG, 137)
    expect(stayed.prorated).toBe(true)
    expect(stayed.total).toBe(2630.87)
    expect(stayed.total).toBeLessThan(priceStay(SITE, 0, LONG, 137).total)
    expect(priceStay(SITE, 0, LONG, 137).total - stayed.total).toBeCloseTo(297.13, 2)
  })

  it('invariant: nobody is charged MORE than the ladder on any path, at either answer', () => {
    for (const rates of [SITE, { nightly: 55, weekly: 130, monthly: 589 }, { nightly: null, weekly: 286, monthly: 589 }]) {
      for (const arrive of ['2026-05-18', '2026-12-15', '2027-01-31', '2027-02-01']) {
        for (let n = 1; n <= 200; n++) {
          const ladder = priceStay(rates, 10, arrive, n).total
          for (const prorates of [true, false]) {
            expect(priceNightsStayed(rates, 10, arrive, n, { proratesMidMonth: prorates }).total,
              `${arrive} ${n} nights, prorates=${prorates}`).toBeLessThanOrEqual(ladder)
          }
        }
      }
    }
  })
})

/**
 * 10/18 (Nic): "the only way it is different is for longer term people for rent
 * pro ration. moving in or out at the middle of a month and also only if the
 * landlord allows the pro rate."
 *
 * Move-in proration has always been prorateMoveInRent. Moving OUT part-way
 * through a month is its mirror, and these pin the two things that matter: the
 * actual days in THAT month (never a flat 30), and the setting.
 */
describe('finalMonthRentOnMoveOut — a resident who leaves part-way through a month', () => {
  it('a 31-day month: out on the 15th with rent due on the 1st, 14 of 31 days', () => {
    // Oct 1 → Nov 1 is 31 days; here Oct 1 through Oct 14, out on the 15th.
    expect(finalMonthRentOnMoveOut(1000, '2026-10-15', 1)).toBe(451.61)
    expect(Math.round(1000 * 14 / 31 * 100) / 100).toBe(451.61)
    // A flat 30 would have said $466.67 — the figure this must never produce.
    expect(finalMonthRentOnMoveOut(1000, '2026-10-15', 1)).not.toBe(466.67)
  })

  it('a 28-day month: the same 14 days out of February are half the rent', () => {
    expect(finalMonthRentOnMoveOut(1000, '2027-02-15', 1)).toBe(500)
    // A flat 30 would again have said $466.67.
    expect(finalMonthRentOnMoveOut(1000, '2027-02-15', 1)).not.toBe(466.67)
  })

  it('a park where a whole month is a whole month: they owe all of it', () => {
    expect(finalMonthRentOnMoveOut(1000, '2026-10-15', 1, { proratesMidMonth: false })).toBe(1000)
    expect(finalMonthRentOnMoveOut(1000, '2027-02-15', 1, { proratesMidMonth: false })).toBe(1000)
  })

  it('rent due on a day other than the 1st counts from that day', () => {
    // Due the 15th: Oct 15 → Nov 15 is 31 days, and they are here Oct 15–19.
    expect(finalMonthRentOnMoveOut(1000, '2026-10-20', 15)).toBe(161.29)
    expect(Math.round(1000 * 5 / 31 * 100) / 100).toBe(161.29)
  })

  it('leaving ON a due day owes the whole month they just finished', () => {
    expect(finalMonthRentOnMoveOut(1000, '2026-11-01', 1)).toBe(1000)
    expect(finalMonthRentOnMoveOut(1000, '2026-10-15', 15)).toBe(1000)
  })

  it('the leaver and the arriver together pay exactly one month, to the cent', () => {
    // The one place a second proration would show up as a penny gained or lost.
    // Compared in whole cents: two cent-exact figures added in floating point
    // land on 875.3299999999999, which is the adding, not the proration.
    const cents = (n: number) => Math.round(n * 100)
    for (const day of ['2026-10-02', '2026-10-15', '2026-10-31', '2027-02-14', '2027-02-28']) {
      for (const dueDay of [1, 15]) {
        for (const rent of [1000, 589, 1234.57, 875.33]) {
          expect(cents(finalMonthRentOnMoveOut(rent, day, dueDay)) + cents(prorateMoveInRent(rent, day, dueDay)),
            `${day}, due the ${dueDay}, at ${rent}`).toBe(cents(roundHalfEvenCents(rent)))
        }
      }
    }
  })

  /**
   * 10/19 (review): the amount alone does not say WHICH month it is for, and
   * billing it against the wrong one charges a month twice — on a move-out that
   * lands on the due day it is the month they just finished, not the one they
   * left on day zero of. finalRentMonthStart names it, and the two are read
   * together by whoever wires this into the final bill.
   */
  it('names the month it charges for — the period containing their last day', () => {
    // Out on the 15th, due the 1st: the period that began October 1.
    expect(finalRentMonthStart('2026-10-15', 1)).toBe('2026-10-01')
    expect(finalMonthRentOnMoveOut(1000, '2026-10-15', 1)).toBe(451.61)
    // Out ON the due day: they completed the period that began a month before
    // it. Billing the whole month against November — in which they lived no
    // days — would charge the October they already paid a second time.
    expect(finalRentMonthStart('2026-11-01', 1)).toBe('2026-10-01')
    expect(finalMonthRentOnMoveOut(1000, '2026-11-01', 1)).toBe(1000)
    // Rent due on another day, both sides of it.
    expect(finalRentMonthStart('2026-10-20', 15)).toBe('2026-10-15')
    expect(finalRentMonthStart('2026-10-05', 15)).toBe('2026-09-15')
    expect(finalRentMonthStart('2026-10-15', 15)).toBe('2026-09-15')
    // Across a year end, and a day nobody can read.
    expect(finalRentMonthStart('2027-01-01', 1)).toBe('2026-12-01')
    expect(finalRentMonthStart('not-a-day', 1)).toBe(null)
  })

  it('the figure is always a part of the period it names, never more', () => {
    for (const day of ['2026-10-02', '2026-10-15', '2026-10-31', '2026-11-01', '2027-02-14', '2027-03-01']) {
      for (const dueDay of [1, 15]) {
        const start = finalRentMonthStart(day, dueDay)!
        expect(start, `${day}, due the ${dueDay}`).not.toBe(null)
        // The period it names has begun by their last day and contains it.
        expect(start < day, `${day} after ${start}`).toBe(true)
        expect(finalMonthRentOnMoveOut(1000, day, dueDay)).toBeLessThanOrEqual(1000)
      }
    }
  })

  it('no rent, or nonsense, is no charge', () => {
    expect(finalMonthRentOnMoveOut(0, '2026-10-15', 1)).toBe(0)
    expect(finalMonthRentOnMoveOut(null, '2026-10-15', 1)).toBe(0)
    expect(finalMonthRentOnMoveOut(1000, 'not-a-day', 1)).toBe(1000) // unreadable day: never cut a month on a guess
  })
})
