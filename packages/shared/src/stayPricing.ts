// ── 10/6 (Nic): ONE PRICE FOR THE SAME NIGHTS, AT EVERY DOOR — THE CHEAPEST ──
//
// "It's saying six nights for $312. Well, our weekly price is $269. It should
// be charging them the price, the configuration that's going to be the
// cheapest option for them... six days should be charging people the weekly
// rate where the price curve starts to invert and it becomes cheaper to do the
// next time bracket."
//
// For N nights from an arrival date, a stay costs the CHEAPEST combination of
//   • whole months — calendar months from the arrival (Oct 4 → Nov 4), at the
//     monthly rate,
//   • whole weeks — 7 nights, at the weekly rate,
//   • nights — at the nightly rate,
// that COVERS at least N nights. Nightly $49 / weekly $269 / monthly $589:
//   6 nights → 1 week $269;  8 → 1 week + 1 night $318;  13 → 2 weeks $538;
//   25 → 1 month $589.
// A rate the site does not have is skipped (the site's rate, else the
// property's, is decided by the caller exactly as before). Never prorated:
// no week or month is ever cut into pieces (R5).
//
// Lodging tax is figured on the charged base exactly as it always was: a stay
// under 30 nights carries the property's short-term lodging tax, a stay of 30+
// nights does not — and a stay that IS whole calendar months (Feb 1 → Mar 1,
// 28 nights: a month rung up at the register) never has. A 25-night stay
// charged at the monthly rate is still a 25-night stay, and is taxed. Of two
// combinations, the guest is charged the one that costs them less, tax in.
//
// The reservation form, the schedule, the booking site, a pay link, the
// register and the guest/visitor assistant all price from this one function.
// (Leases are billed by their own schedule — computeMonthlyStaySchedule — and
// are not priced here.)

import { roundHalfEvenCents, prorateMoveInRent } from './moveInCharges'

export type StayTier = 'nightly' | 'weekly' | 'monthly'

/** A site's rates (each null/blank/0 when it has none). */
export interface StayRates {
  nightly?: number | string | null
  weekly?: number | string | null
  monthly?: number | string | null
}

/** How many of each the stay is charged as. */
export interface StayPlanCounts { months: number; weeks: number; nights: number }

export interface StayPrice {
  /** Nights stayed (check-out − check-in). */
  nights: number
  /** Nights the charged combination covers — never fewer than `nights`. */
  coveredNights: number
  plan: StayPlanCounts
  /** Before tax. */
  base: number
  tax: number
  total: number
  /** The biggest rate used: monthly when a month is in it, else weekly when a week is, else nightly. */
  tier: StayTier
  /** Lodging tax applies (under 30 nights, and not exactly whole calendar months). */
  taxable: boolean
  /** The lodging tax as a fraction (0.12 for 12%), 0 when none. */
  taxRate: number
  /**
   * 10/6 (review): the bigger rate (`tier`) beat what the smaller rates alone
   * would have cost — so "the lower price" is true. false when the site has
   * no smaller rate to compare (3 nights on a weekly-only site are simply
   * charged as a week) or the tier is nightly.
   */
  lowerPrice: boolean
}

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100

const rateOf = (v: number | string | null | undefined): number | null => {
  if (v == null || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : null
}

const ymdParts = (ymd: string) => {
  const s = String(ymd).slice(0, 10)
  return { y: Number(s.slice(0, 4)), m: Number(s.slice(5, 7)), d: Number(s.slice(8, 10)) }
}
const utcDay = (y: number, m: number, d: number) => Date.UTC(y, m - 1, d)
const pad2 = (n: number) => String(n).padStart(2, '0')
const ymdOf = (t: number) => {
  const x = new Date(t)
  return `${x.getUTCFullYear()}-${pad2(x.getUTCMonth() + 1)}-${pad2(x.getUTCDate())}`
}

/** Nights between two 'YYYY-MM-DD' days — check-out − check-in, the same count the server stores. */
export function stayNightsBetween(checkIn: string, checkOut: string): number {
  const a = ymdParts(checkIn), b = ymdParts(checkOut)
  return Math.round((utcDay(b.y, b.m, b.d) - utcDay(a.y, a.m, a.d)) / 86_400_000)
}

/** 'YYYY-MM-DD' plus whole days. */
export function addStayDays(ymd: string, days: number): string {
  const a = ymdParts(ymd)
  return ymdOf(utcDay(a.y, a.m, a.d) + days * 86_400_000)
}

/**
 * 'YYYY-MM-DD' plus whole calendar months, the day kept (Oct 4 → Nov 4) and
 * held to the month's last day when it has fewer (Jan 31 → Feb 28) — the same
 * as a month added at the register or on the schedule.
 */
export function addCalendarMonths(ymd: string, months: number): string {
  const a = ymdParts(ymd)
  const idx = (a.y * 12 + (a.m - 1)) + months
  const y = Math.floor(idx / 12), m = (idx % 12) + 1
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate()
  return `${y}-${pad2(m)}-${pad2(Math.min(a.d, last))}`
}

/**
 * THE price of `nights` nights from `checkIn` (see the top of this file).
 * `taxPct` is the property's short-term lodging tax as a percent. `total` is 0
 * when the nights are 0 or no rate the site has can price them.
 */
export function priceStay(rates: StayRates, taxPct: number | string | null | undefined, checkIn: string, nights: number): StayPrice {
  const nightly = rateOf(rates.nightly), weekly = rateOf(rates.weekly), monthly = rateOf(rates.monthly)
  const n = Math.max(0, Math.round(Number(nights) || 0))
  const none: StayPrice = {
    nights: n, coveredNights: 0, plan: { months: 0, weeks: 0, nights: 0 },
    base: 0, tax: 0, total: 0, tier: 'nightly', taxable: false, taxRate: 0, lowerPrice: false,
  }
  if (n <= 0) return none

  const pct = Number(taxPct || 0)
  /** Tax applies under 30 nights, unless the stay is exactly whole calendar months. */
  const taxableFor = (plan: StayPlanCounts, covered: number) =>
    n < 30 && !(plan.months > 0 && plan.weeks === 0 && plan.nights === 0 && covered === n)
  type Pick = { cents: number; withTax: number; covered: number; parts: number; plan: StayPlanCounts }
  let best: Pick | null = null
  const consider = (plan: StayPlanCounts, covered: number) => {
    const cents = Math.round(plan.months * (monthly ?? 0) * 100) + Math.round(plan.weeks * (weekly ?? 0) * 100)
      + Math.round(plan.nights * (nightly ?? 0) * 100)
    const withTax = taxableFor(plan, covered) && pct > 0 ? cents + Math.round(cents * pct / 100) : cents
    const parts = plan.months + plan.weeks + plan.nights
    // Cheapest for the guest (tax in) first; at the same price, the fewest
    // extra nights, then the fewest pieces.
    if (!best || withTax < best.withTax || (withTax === best.withTax && (covered < best.covered
        || (covered === best.covered && parts < best.parts)))) {
      best = { cents, withTax, covered, parts, plan }
    }
  }

  for (let months = 0; ; months++) {
    if (months > 0 && monthly == null) break
    const monthNights = months === 0 ? 0 : stayNightsBetween(checkIn, addCalendarMonths(checkIn, months))
    const rest = Math.max(0, n - monthNights)
    if (rest === 0) {
      consider({ months, weeks: 0, nights: 0 }, monthNights)
      break // more months only cost more
    }
    const maxWeeks = weekly == null ? 0 : Math.ceil(rest / 7)
    for (let weeks = 0; weeks <= maxWeeks; weeks++) {
      const left = Math.max(0, rest - weeks * 7)
      if (left > 0 && nightly == null) continue
      consider({ months, weeks, nights: left }, monthNights + weeks * 7 + left)
    }
    if (monthly == null) break
  }
  const won = best as Pick | null
  if (!won) return none

  const base = round2(won.cents / 100)
  const taxable = taxableFor(won.plan, won.covered)
  const taxRate = taxable && pct > 0 ? pct / 100 : 0
  const tax = round2(base * taxRate)
  const tier: StayTier = won.plan.months > 0 ? 'monthly' : won.plan.weeks > 0 ? 'weekly' : 'nightly'
  const total = round2(base + tax)
  // What the smaller rates alone would have cost (none when the tier is nightly).
  const smaller = tier === 'monthly' ? priceStay({ nightly, weekly }, taxPct, checkIn, n)
    : tier === 'weekly' ? priceStay({ nightly }, taxPct, checkIn, n) : null
  const lowerPrice = !!smaller && smaller.total > 0 && smaller.total > total
  return { nights: n, coveredNights: won.covered, plan: won.plan, base, tax, total, tier, taxable, taxRate, lowerPrice }
}

/** priceStay between two days. */
export function priceStayBetween(rates: StayRates, taxPct: number | string | null | undefined, checkIn: string, checkOut: string): StayPrice {
  return priceStay(rates, taxPct, checkIn, stayNightsBetween(checkIn, checkOut))
}

// ── 10/18 (Nic): GIVING MONEY BACK IS THE PROPERTY'S OWN CALL ─────────────
//
// "refunds are pro rated to the next price down. people pay for a week they
// stay 4 days. the 4 day rate against the weekly rate is the difference for
// the refund IF THE LANDLORD DOES REFUNDS AT ALL AT THAT PROPERTY. the only
// way it is different is for longer term people for rent pro ration. moving in
// or out at the middle of a month and also only if the landlord allows the pro
// rate. THESE SHOULD ALL BE PROPERTY LEVEL SETTINGS."
//
// Two questions a landlord answers, per property:
//
//   1. Do you give money back when someone leaves early?  No = the price as
//      booked stands and nothing is offered; the desk is told so plainly
//      rather than being handed choices that this park does not honor.
//   2. Do you prorate rent when a long-term resident moves in or out
//      mid-month?  No = a whole month is a whole month, both ways.
//
// "Next price down" needs no new arithmetic. priceStay already charges the
// CHEAPEST combination of whole months, weeks and nights that covers the days
// — which for every rate set and arrival day we tested is never DEARER than
// pricing at the one rung below what they paid, and usually cheaper (a week
// paid, 4 days stayed: 4 nights at $55 = $220 against the $286 week, so $66
// back, exactly Nic's example; a month paid, 14 nights stayed: $572 at the
// weekly rate, the figure he approved the same day — "So, okay. No, that's
// fine."). The refund is what they paid less what the days they stayed are
// worth, so a cheaper reckoning of those days is a BIGGER refund, never a
// smaller one. See stayPricing.test.ts, "Nic's refund rule".
//
// WHAT THE DEFAULTS MEAN, EXACTLY — the two are not the same story, and saying
// they were would be a lie a landlord could lose money on:
//
//   - refundsEarlyDeparture TRUE is what every live property already does.
//     There was no column, so there was no way to refuse a refund. A landlord
//     who answers nothing sees no change at all.
//   - proratesMidMonth TRUE is what every live property already does for a
//     MOVE-IN (prorateMoveInRent has run on every property since the start),
//     and it is NEW for a long-stay guest who leaves part-way into a month.
//     Before 10/18 those last days were re-rated down the ladder as weeks and
//     nights; `false` is that old behavior and `true` is the rule Nic asked
//     for the same day ("I want that prorated amount to be divided by the 30
//     days or whatever ... not calculated off the weekly rate"). Defaulting it
//     to true ships that rule to every property on the platform with no
//     landlord action, DELIBERATELY: the same stay that offered $17.00 back
//     the day before offers $314.13 after, which is the correction, not a
//     regression. The park that wants the old arithmetic answers No.
//
// Either answer only ever makes a refund BIGGER than the price-ladder figure,
// never smaller, and never charges a guest more than they would pay today
// (pinned both ways in stayPricing.test.ts).

/** The two departure answers a property gives (properties.early_departure_refunds / prorates_mid_month_rent). */
export interface DepartureRules {
  /** Does this property give money back when someone leaves early? */
  refundsEarlyDeparture: boolean
  /** Does it prorate rent when a long-term resident moves in or out mid-month? */
  proratesMidMonth: boolean
}

/**
 * What a column default, and a caller that was never told, both mean. NOT a
 * claim that both are what properties did before the columns existed: see
 * "WHAT THE DEFAULTS MEAN" above — money back is, the long-stay prorated tail
 * is the 10/18 rule arriving on by default.
 */
export const DEPARTURE_RULES_DEFAULT: DepartureRules = { refundsEarlyDeparture: true, proratesMidMonth: true }

/** The two questions, worded the way a landlord answers them. */
export const EARLY_DEPARTURE_REFUNDS_QUESTION = 'Do you give money back when someone leaves early?'
export const EARLY_DEPARTURE_REFUNDS_HINT: Record<'yes' | 'no', string> = {
  yes: 'Yes — when a guest leaves before their booked day, the desk is offered the difference back. '
    + 'The days they did stay are priced at the next rate down (a week paid, four days stayed, four nights charged), '
    + 'so the refund is the part they did not use.',
  no: 'No — the price as booked stands. Nobody is offered a refund at check-out, and money a guest '
    + 'already paid ahead stays on their account. Turn this on if you do give money back.',
}
export const MID_MONTH_PRORATION_QUESTION = 'Do you prorate rent when a long-term resident moves in or out mid-month?'
export const MID_MONTH_PRORATION_HINT: Record<'yes' | 'no', string> = {
  yes: 'Yes — a resident who moves in or out part-way through a month pays for the days they are here, '
    + 'counted against the actual days in that month. A long-stay guest months in who leaves mid-month gets '
    + 'the rest of that month back in proportion.',
  no: 'No — a whole month is a whole month, moving in and moving out alike. Nothing is cut into days.',
}

/**
 * The LAST month of a long-term resident who moves out part-way through it —
 * the "moving in or out at the middle of a month" half of Nic's rule, the one
 * place a day-by-day figure belongs.
 *
 * `moveOut` is the day they are out (exclusive, the way a lease end and a
 * check-out are), `dueDay` the day of the month their rent is due. Prorating
 * off means they owe the whole month.
 *
 * WHICH MONTH THIS IS, because the figure alone does not say and billing it
 * against the wrong one charges a month twice (10/19 review). It is always the
 * rent period CONTAINING THEIR LAST DAY — `finalRentMonthStart` returns the day
 * that period begins, and every caller must bill the two together. Out on the
 * 15th with rent due the 1st: $451.61 for the period that began on the 1st of
 * that month. Out ON a due day: they finished the period before it to the day,
 * so the answer is that whole period's rent — the month they just completed,
 * NOT the one starting the day they left, in which they lived no days at all.
 *
 * ONE proration in GAM: moveInCharges prorateMoveInRent, actual days in the
 * period and never a flat 30. The move-out month is its mirror — what the
 * move-in helper would charge from the move-out day forward is precisely the
 * part of the month they are NOT here for, so the month less that is what they
 * owe. Taking it as a subtraction (rather than writing the same division a
 * second time, the other way round) also means the two halves of a month that
 * has one resident leave and another arrive add up to exactly one month's rent,
 * to the cent, instead of to a penny more or less.
 */
export function finalMonthRentOnMoveOut(
  rent: number | string | null | undefined, moveOut: string, dueDay = 1,
  opts: { proratesMidMonth?: boolean } = {},
): number {
  const r = Number(rent)
  if (!Number.isFinite(r) || !(r > 0)) return 0
  const whole = roundHalfEvenCents(r)
  if (opts.proratesMidMonth === false) return whole
  return roundHalfEvenCents(whole - prorateMoveInRent(r, moveOut, dueDay))
}

/**
 * The day the rent period that finalMonthRentOnMoveOut charges for BEGINS —
 * the period containing the resident's last day. Billing that figure against
 * any other month charges a month twice, so the two are read together.
 *
 * Out on the 15th, rent due the 1st → the 1st of that month. Out ON a due day
 * → the due day a month earlier: they completed that period to the day, and the
 * one starting the day they left has none of their days in it. An unreadable
 * day returns null, the same way the amount falls back to a whole month rather
 * than cutting one on a guess.
 */
export function finalRentMonthStart(moveOut: string, dueDay = 1): string | null {
  const s = String(moveOut ?? '').slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null
  const day = Math.trunc(Number(dueDay) || 1)
  const d = day >= 1 && day <= 28 ? day : 1
  const p = ymdParts(s)
  // On or after this month's due day, the period began this month; before it,
  // the period began last month. Leaving ON the due day finished the period
  // that began a month before it.
  const thisMonth = `${p.y}-${pad2(p.m)}-${pad2(d)}`
  return s > thisMonth ? thisMonth : addCalendarMonths(thisMonth, -1)
}

// ── 10/18 (Nic): A LONG-TERM GUEST'S LAST FEW DAYS ARE PRORATED ───────────
//
// "the calculation for refunds is wrong. Um, well, possibly not. So they
// stayed for 14 nights, but it's calculating it at the ... weekly rate. I see
// what you're doing there. ... So, okay. No, that's fine. It just was
// confusing. ... But if somebody stays for, I don't know, six months or so,
// and they're at the monthly rate, when they go to move out, I want that
// prorated amount to be divided by the 30 days or whatever. So like if they
// paid for a whole month and they're, you know, four or five months in and
// they leave like two weeks later, it would need to be about a 50% refund,
// not calculated off the weekly rate. Because I don't want to do that to
// people that are, you know, long-term good customers."
//
// Selling a stay never prorates (R5, the top of this file): a week is a week.
// But when a guest who has been here for MONTHS leaves part-way into another
// one, what the days they stayed are worth is a different question, and
// running those last days back down the ladder as weeks and nights is what
// Nic is objecting to. Four months in on a $589 month, leaving 14 days into
// the fifth: the ladder charges 2 weeks at $286 = $572 for those 14 days,
// so the guest who paid for the month gets almost nothing back. Those 14
// days are 14 days of that month — $266 out of a 31-day month, $274.87 out of
// a 30-day one.
//
// So: when the days stayed already carry at least one WHOLE calendar month,
// the leftover days after that last whole month are a prorated share of the
// monthly rate — days ÷ the ACTUAL days in the month those days fall in,
// which is how GAM has always prorated rent (moveInCharges prorateMoveInRent),
// never a flat 30. The guest is charged whichever is less, tax in: that
// prorated figure or the ladder's. So nobody can ever pay MORE than they do
// today, a stay that never reached a whole month is untouched (14 nights from
// day one are still 2 weeks — "No, that's fine"), and the long-term customer
// gets the month back in proportion to the days they did not use.

/** priceStay, plus what was prorated when the tail of a long stay was. */
export interface StayedNightsPrice extends StayPrice {
  /** The leftover days after the last whole calendar month; 0 when nothing was prorated. */
  proratedDays: number
  /** The days in the month those leftover days fall in — its own, never a flat 30. */
  prorationPeriodDays: number
  /** What those days come to at the monthly rate, before tax. */
  proratedTail: number
  /** The prorated figure was the cheaper of the two, so it is what is charged. */
  prorated: boolean
}

/**
 * What the days a guest ACTUALLY STAYED are worth (see above) — the cheapest
 * of priceStay's ladder and, for a stay that carries whole calendar months,
 * those months plus a prorated share of one for the days left over. Totals are
 * compared tax in, and the lodging tax rule does not change: a stay under 30
 * nights carries it, 30+ nights never does.
 *
 * Used when a guest checks out early (services/earlyCheckOut). What a stay is
 * SOLD for is priceStay, and still never prorated.
 *
 * 10/18 (Nic): "also only if the landlord allows the pro rate. these should all
 * be property level settings." A guest who has been here whole months and
 * leaves part-way into another one IS the "longer term people ... moving in or
 * out at the middle of a month" case, so this tail is exactly what that
 * setting governs. `proratesMidMonth: false` leaves the ladder alone — a whole
 * month is a whole month. Left out (and so for every caller that has not been
 * told) it prorates, which is what the stay path does today.
 */
export function priceNightsStayed(
  rates: StayRates, taxPct: number | string | null | undefined, checkIn: string, nights: number,
  opts: { proratesMidMonth?: boolean } = {},
): StayedNightsPrice {
  const ladder = priceStay(rates, taxPct, checkIn, nights)
  const asLadder: StayedNightsPrice = { ...ladder, proratedDays: 0, prorationPeriodDays: 0, proratedTail: 0, prorated: false }
  const monthly = rateOf(rates.monthly)
  const n = ladder.nights
  if (opts.proratesMidMonth === false) return asLadder
  if (monthly == null || !(ladder.total > 0)) return asLadder

  // 10/18 (review): what decides this is whether a whole calendar month
  // actually WENT BY in the days the guest stayed — never which rung the price
  // ladder happened to land on. On a site whose month is priced worse than
  // four weeks the ladder prices even a long stay in weeks, and keying off
  // that left exactly the guest Nic is protecting — months in, leaving
  // part-way through another one — with their last days re-rated at the weekly
  // rate. It also made staying one more night cost a WHOLE MONTH less, the
  // night the ladder finally reached for a month; that step is gone.
  //
  // A much smaller step in the same direction is still here, and it is the
  // lodging-tax cliff, not this: a stay under 30 nights carries the tax and a
  // stay of 30+ never does, so the 30th night takes the tax off the whole
  // figure. $55/$286/$589 at 6.35%, in Feb 1: 29 nights stayed are worth
  // $646.61 (a month + 1 prorated day, taxed) and 30 nights $627.00 (a month +
  // 2 days, untaxed) — $19.61 LESS for the longer stay, so a bigger refund.
  // priceStay has the same cliff and stays monotone only because a whole extra
  // NIGHT ($55) outweighs the tax it drops; a single prorated day ($19) does
  // not. It is the tax rule doing exactly what it says, it only ever favors the
  // guest, and the alternative is charging somebody more for staying less.
  // Pinned in stayPricing.test.ts so nobody "fixes" it upward.
  //
  // So: the whole calendar months that FIT inside the days stayed. The ladder
  // may have rounded UP to one more month than fits (25 nights charged as a
  // month); that stay has no whole month in it and is not prorated, and a
  // plain 14-night stay is left exactly as it is.
  let months = 0
  while (stayNightsBetween(checkIn, addCalendarMonths(checkIn, months + 1)) <= n) months++
  if (months < 1) return asLadder
  const monthsEnd = addCalendarMonths(checkIn, months)
  const days = n - stayNightsBetween(checkIn, monthsEnd)
  if (days <= 0) return asLadder // exactly whole months: nothing to prorate

  // 10/19 (review): the days in the month those leftover days FALL IN — this
  // guest's next monthly period, measured from the arrival day, Sep 18 → Oct 18.
  // Measuring it from monthsEnd instead reads the clamp as the real day: in on
  // Jan 31, four weeks later monthsEnd is Feb 28 (addCalendarMonths holds Jan 31
  // to the month's last day), and Feb 28 → Mar 28 is a 28-day window for days
  // that all sit in a 31-day March — 14 of them charged $294.50 instead of
  // $266.00, which is $28.50 less given back than the rule promises.
  const periodDays = stayNightsBetween(monthsEnd, addCalendarMonths(checkIn, months + 1))
  if (periodDays <= 0) return asLadder
  const proratedTail = roundHalfEvenCents(monthly * days / periodDays)
  const base = round2(months * monthly + proratedTail)
  // The tax rule, unchanged: under 30 nights it applies, and a stay with days
  // left over is never "exactly whole calendar months".
  const pct = Number(taxPct || 0)
  const taxable = n < 30
  const taxRate = taxable && pct > 0 ? pct / 100 : 0
  const tax = round2(base * taxRate)
  const total = round2(base + tax)
  // Never more than the guest would pay today.
  if (!(total < ladder.total)) return asLadder
  const smaller = priceStay({ nightly: rates.nightly, weekly: rates.weekly }, taxPct, checkIn, n)
  return {
    nights: n, coveredNights: n, plan: { months, weeks: 0, nights: 0 },
    base, tax, total, tier: 'monthly', taxable, taxRate,
    lowerPrice: smaller.total > 0 && smaller.total > total,
    proratedDays: days, prorationPeriodDays: periodDays, proratedTail, prorated: true,
  }
}

/** priceNightsStayed between two days. */
export function priceNightsStayedBetween(
  rates: StayRates, taxPct: number | string | null | undefined, checkIn: string, checkOut: string,
  opts: { proratesMidMonth?: boolean } = {},
): StayedNightsPrice {
  return priceNightsStayed(rates, taxPct, checkIn, stayNightsBetween(checkIn, checkOut), opts)
}

/** "nightly", "weekly", "monthly" — the rate a tier is, in plain words. */
export const STAY_TIER_WORD: Record<StayTier, string> = { nightly: 'nightly', weekly: 'weekly', monthly: 'monthly' }

/** "1 week + 1 night", "2 weeks", "1 month" — what the stay is charged as. */
export function stayPlanWords(plan: StayPlanCounts): string {
  const one = (k: number, word: string) => `${k} ${word}${k === 1 ? '' : 's'}`
  const out: string[] = []
  if (plan.months) out.push(one(plan.months, 'month'))
  if (plan.weeks) out.push(one(plan.weeks, 'week'))
  if (plan.nights) out.push(one(plan.nights, 'night'))
  return out.join(' + ')
}

/**
 * "charged at the weekly rate, the lower price" — when the stay is charged at
 * a bigger rate than the one the counter would have expected (`expected`: the
 * rate it was rung at; nightly by default), so the guest and the clerk can see
 * why the figure is lower. 10/6 (review): "the lower price" only when the
 * smaller rates would have cost more (`lowerPrice`); a site with no smaller
 * rate says plainly "charged at the weekly rate". null when there is nothing
 * to explain.
 */
export function stayLowerRateWords(price: Pick<StayPrice, 'total' | 'tier' | 'lowerPrice'>, expected: StayTier = 'nightly'): string | null {
  if (!(price.total > 0)) return null
  const rank: Record<StayTier, number> = { nightly: 0, weekly: 1, monthly: 2 }
  if (rank[price.tier] <= rank[expected]) return null
  return price.lowerPrice
    ? `charged at the ${STAY_TIER_WORD[price.tier]} rate, the lower price`
    : `charged at the ${STAY_TIER_WORD[price.tier]} rate`
}
