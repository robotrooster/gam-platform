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
