/**
 * 10/22 (Nic) — WHAT A PAID MONTH IS WORTH WHEN SOMEBODY LEAVES PART WAY IN,
 * AND WHICH WAY THE MONEY GOES.
 *
 * THE FORK IS THE HALFWAY POINT OF THEIR PAID MONTH. His words:
 *
 *   "if they used more than half the month, we're not going to prorate them. We
 *    would just either wash the electric or other utilities. And if they are
 *    leaving before half the paid for time, then we could prorate a refund back
 *    to their payment method on file."
 *
 * So early in the month, money goes BACK — somebody who paid for October and
 * drove out on the 4th kept nothing and is owed the difference. Late in the
 * month it is the wash: keep what is left and eat their final utility, which is
 * the whole mechanism from 10/20 and the thing that "evens out over the long
 * run".
 *
 * WHAT THE DAYS THEY USED ARE WORTH — the second half of the rule, and it turns
 * on how long they have been there, not on what their paperwork is called:
 *
 *   "it's kind of at the discretion of how long they've been there. Like if
 *    that's the only month they've been there, they get charged the weekly rate.
 *    But if they've been there for a while, and they're month to month on a
 *    lease, like that'll be the determining factor. Stays versus leases."
 *
 *   FIRST MONTH — they never became a resident, so they are priced the way the
 *   register prices anybody: the nightly/weekly/monthly ladder, cheapest that
 *   covers the nights. Nine nights is a week plus two nights.
 *
 *   A RESIDENT — monthly rent ÷ the days in THAT month × the nights they used.
 *   10/22: "when people have been there 5-6 months they would be pro rated at
 *   the monthly divided by days of the month not the daily rate." A resident of
 *   six months is never re-priced as a tourist.
 *
 * AND THE LODGING TAX IS PART OF THE RE-PRICED TOTAL. 10/22, after thinking
 * about it out loud and landing firmly:
 *
 *   "It's a week plus 2 days on short-term pricing. And the tax also needs to
 *    be added into it. Because you don't want to refund them more money. This
 *    property is still responsible to local government for lodging tax. And if
 *    we don't factor that out of their repricing structure, we're shorting
 *    ourselves... it's not technically billed, but it needs to get adjusted
 *    against that total and get reported correctly."
 *
 * So the refund is `paid − (what the nights are worth + the tax those nights
 * owe)`. The tax is not a new charge anybody pays; it is part of what the stay
 * cost, and leaving it out of the re-price would hand the guest money the
 * property still owes the town. A RESIDENT'S prorate carries NO tax — a
 * long-term stay is not taxable, and the shared pricer already knows the
 * thirty-night cliff, so neither rule is written twice.
 *
 * THE DAY THEY LEAVE IS NOT CHARGED, here as everywhere: "RVs usually bill by
 * the night, just like hotel rooms... We're not charging them for the leaving
 * day."
 */
import type { PoolClient } from 'pg'
// The ONE ladder: the same function, rates and proration answer the register
// quotes a stay with and the wash prices nights stayed with.
import { priceNightsStayedBetween, stayPlanWords, type StayRates } from '@gam/shared'
import { query } from '../db'
import { departureRuleSql } from './departureRules'


type Q = Pick<PoolClient, 'query'>
const round2 = (n: number) => Math.round(n * 100) / 100
const num = (v: unknown): number => (v == null ? 0 : round2(Number(v)))
const money = (n: number): string =>
  `$${round2(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

const daysBetween = (from: string, to: string) =>
  Math.round((Date.parse(to + 'T12:00:00Z') - Date.parse(from + 'T12:00:00Z')) / 86400000)

/** The paid period containing `onDay`, for rent due on `dueDay` of the month. */
export function rentPeriodAround(onDay: string, dueDay: number): { start: string; end: string } {
  // Out of range falls back to the 1st rather than clamping — the same rule
  // the rest of the system uses for a rent due day (renewalSuccessor), and
  // clamping 31 to the 28th would quietly invent a period nobody agreed to.
  const n = Math.floor(Number(dueDay))
  const d = Number.isFinite(n) && n >= 1 && n <= 28 ? n : 1
  const [y, m, day] = onDay.split('-').map(Number)
  // The period starts on the due day of this month, unless they are standing
  // before it — then it started on the due day of last month.
  const startY = day >= d ? y : (m === 1 ? y - 1 : y)
  const startM = day >= d ? m : (m === 1 ? 12 : m - 1)
  const iso = (yy: number, mm: number, dd: number) =>
    `${yy}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`
  const start = iso(startY, startM, d)
  // Ends the day before the next due day.
  const nextY = startM === 12 ? startY + 1 : startY
  const nextM = startM === 12 ? 1 : startM + 1
  const endDate = new Date(Date.UTC(nextY, nextM - 1, d))
  endDate.setUTCDate(endDate.getUTCDate() - 1)
  return { start, end: endDate.toISOString().slice(0, 10) }
}

export interface ProratedUnused {
  /** Days the paid period covers — the real length of THEIR month. */
  daysInPeriod: number
  /** Days after the one they left on. The day they leave counts as used. */
  daysUnused: number
  /** Monthly rent divided by the days in that period. */
  perDay: number
  /** What a pro-rated refund would have handed back. */
  wouldRefund: number
}

/**
 * What a pro-rated refund would have returned — the figure the wash keeps
 * instead of paying out.
 *
 * THE DAY THEY LEAVE IS NOT CHARGED. 10/22 (Nic), correcting the first cut,
 * which counted it as used:
 *
 *   "RVs usually bill by the night, just like hotel rooms. So you're still
 *    there in the morning of the next day, but you're checking out early so the
 *    room can be prepped for the next night's stay. So think of it like that.
 *    We're not charging them for the leaving day. They're paid by the night."
 *
 * So a site is sold by the NIGHT, and the night of the day you leave is a night
 * you did not have — it is sold to whoever comes next. Leave on the 20th and
 * the nights of the 20th through the 31st are all unused. Leave on the 1st of
 * the next month and you used every night of the one you paid for, which is
 * his "if they leave right at the end of the time they paid for, we still
 * bill."
 */
export function proratedUnusedRent(args: {
  monthlyRent: number
  period: { start: string; end: string }
  leftOn: string
}): ProratedUnused {
  const days = (from: string, to: string) =>
    Math.round((Date.parse(to + 'T12:00:00Z') - Date.parse(from + 'T12:00:00Z')) / 86400000)
  const daysInPeriod = Math.max(1, days(args.period.start, args.period.end) + 1)
  const perDay = args.monthlyRent / daysInPeriod
  // +1 because the night of the leaving day is itself unused — they are gone
  // that morning and the site can be sold again that night. Clamped: a
  // move-out dated after the period refunds nothing, and one dated before it
  // never refunds more than the period itself.
  const unused = Math.max(0, Math.min(daysInPeriod, days(args.leftOn, args.period.end) + 1))
  return {
    daysInPeriod,
    daysUnused: unused,
    perDay: round2(perDay),
    wouldRefund: round2(perDay * unused),
  }
}

/** How the nights they used were priced. */
export type RepriceBasis = 'stay_rates' | 'monthly_prorated'

/** Which way the money goes, by the halfway rule. */
export type DepartureMoney =
  /** Fewer than half the nights used, and the property gives money back. */
  | 'prorate'
  /** Half or more used, or a property that gives nothing back: keep it, eat the utility. */
  | 'wash'
  /** Nothing to decide — they used the whole month, or there is no paid month. */
  | 'nothing'

export interface DepartureReprice {
  which: DepartureMoney
  /** Plain words for the desk and for the record. */
  why: string
  /** Their paid month, and the part of it their money covered. */
  period: { start: string; end: string }
  daysInPeriod: number
  nightsUsed: number
  leftOn: string
  /** What the nights they used are worth, before tax. */
  worth: number
  /** The lodging tax those nights owe — only ever on a short stay. */
  lodgingTax: number
  /** worth + lodgingTax: the figure the money is settled against. */
  repricedTotal: number
  basis: RepriceBasis
  /** "1 week + 2 nights" for a stay ladder; null for a resident's prorate. */
  plan: string | null
  /** Rent the landlord has actually taken for that month. */
  paid: number
  /** Rent billed for the month and still unpaid. */
  unpaid: number
  /** paid − repricedTotal, when money is going back. */
  refundDue: number
  /** What an unpaid bill becomes. */
  billBecomes: number
}

interface LeaseFacts {
  lease_type: string; unit_type: string; rent: string; due_day: number | null
  start_date: string; left_on: string | null
  refunds: boolean; prorates: boolean
  nightly: string | null; weekly: string | null; monthly: string | null
  tax_pct: string | null
  paid: string; unpaid: string; rent_rows: string
}

/**
 * The one query behind the answer: the lease, the site's own rates, the
 * property's two departure settings, and what has actually been taken and
 * billed for the month they are leaving in.
 *
 * `leftOn` is PASSED, never read as "today". 10/22 (Nic): "those guys actually
 * ended up leaving about 2 days ago... in case somebody leaves on a Sunday when
 * the office is closed and we don't check them out till Monday. Or they're
 * going to be checking out on Sunday and we settle them up on Saturday."
 */
export async function repriceDeparture(
  args: { leaseId: string; landlordId: string; leftOn?: string | null },
  q: Q = { query: (async (sql: string, p?: any[]) => ({ rows: await query(sql, p) })) as any },
): Promise<DepartureReprice | null> {
  const l = (await q.query<LeaseFacts>(
    `SELECT l.lease_type, u.unit_type, l.rent_amount AS rent,
            COALESCE(l.rent_due_day, p.rent_due_day) AS due_day,
            to_char(l.start_date, 'YYYY-MM-DD') AS start_date,
            to_char(NULLIF(LEAST(COALESCE(l.end_date, 'infinity'::date),
                                 COALESCE(timezone(p.timezone, l.terminated_at)::date, 'infinity'::date)),
                           'infinity'::date), 'YYYY-MM-DD') AS left_on,
            ${departureRuleSql('early_departure_refunds')} AS refunds,
            ${departureRuleSql('prorates_mid_month_rent')} AS prorates,
            COALESCE(u.nightly_rate, p.nightly_rate) AS nightly,
            COALESCE(u.weekly_rate,  p.weekly_rate)  AS weekly,
            COALESCE(u.monthly_rate, p.monthly_rate) AS monthly,
            COALESCE(p.short_term_tax_rate, 0) AS tax_pct,
            '0' AS paid, '0' AS unpaid, '0' AS rent_rows
       FROM leases l
       JOIN units u ON u.id = l.unit_id
       JOIN properties p ON p.id = u.property_id
      WHERE l.id = $1 AND l.landlord_id = $2`,
    [args.leaseId, args.landlordId])).rows[0]
  if (!l) return null

  const leftOn = args.leftOn ?? l.left_on
  if (!leftOn || !/^\d{4}-\d{2}-\d{2}$/.test(leftOn)) return null

  const month = rentPeriodAround(leftOn, Number(l.due_day) || 1)
  // Their money covers from the day it was billed for: the period's own start
  // in an ordinary month, the move-in day in a first part month.
  const start = l.start_date > month.start ? l.start_date : month.start
  const period = { start, end: month.end }
  const daysInPeriod = Math.max(1, daysBetween(period.start, period.end) + 1)
  // The leaving night is theirs no longer, so it is not a night they used.
  const nightsUsed = Math.max(0, Math.min(daysInPeriod, daysBetween(period.start, leftOn)))

  // What the landlord actually has for that month, and what is still owed on it.
  const m = (await q.query<{ paid: string; unpaid: string; rows: string }>(
    `SELECT COALESCE(SUM(amount) FILTER (WHERE status IN ('settled','processing','paid_via_deposit')), 0) AS paid,
            COALESCE(SUM(amount) FILTER (WHERE status IN ('pending','failed')), 0) AS unpaid,
            COUNT(*) FILTER (WHERE status IN ('pending','failed')) AS rows
       FROM payments
      WHERE lease_id = $1 AND landlord_id = $2 AND type = 'rent'
        AND due_date >= $3::date AND due_date <= $4::date`,
    [args.leaseId, args.landlordId, month.start, month.end])).rows[0]
  const paid = num(m?.paid)
  const unpaid = num(m?.unpaid)

  // ── What the nights they used are worth ──────────────────────────────────
  //
  // THEIR FIRST MONTH, so they were never a resident: the register's ladder,
  // tax and all. "if that's the only month they've been there, they get charged
  // the weekly rate."
  const firstMonth = l.start_date >= month.start
  let worth = 0, lodgingTax = 0, plan: string | null = null
  let basis: RepriceBasis = 'monthly_prorated'

  if (firstMonth) {
    const rates: StayRates = { nightly: l.nightly, weekly: l.weekly, monthly: l.monthly }
    if (rates.nightly == null && rates.weekly == null && rates.monthly == null) {
      // No rates on the site, so the ladder cannot price it. Fall through to
      // the resident's arithmetic rather than invent a figure — the money they
      // paid divided by the days it covered is still a real answer.
      basis = 'monthly_prorated'
    } else {
      const priced = priceNightsStayedBetween(rates, l.tax_pct, period.start, leftOn,
        { proratesMidMonth: l.prorates !== false })
      worth = round2(priced.base)
      lodgingTax = round2(priced.tax)
      plan = stayPlanWords(priced.plan) || null
      basis = 'stay_rates'
    }
  }

  if (basis === 'monthly_prorated') {
    // A resident: the monthly ÷ the days in THEIR month × the nights used.
    // Taken off the money that was actually billed for the month where there is
    // some, so a part first month is divided by the days it covered — and off
    // the lease's rent otherwise.
    const billedForTheMonth = paid + unpaid
    const monthly = billedForTheMonth > 0 ? billedForTheMonth : num(l.rent)
    const pro = proratedUnusedRent({ monthlyRent: monthly, period, leftOn })
    worth = round2(monthly - pro.wouldRefund)
    // A long-term stay is not taxable and rent is not a stay price.
    lodgingTax = 0
  }

  const repricedTotal = round2(worth + lodgingTax)

  // ── Which way the money goes ─────────────────────────────────────────────
  const usedItAll = nightsUsed >= daysInPeriod
  const firstHalf = nightsUsed * 2 < daysInPeriod
  const givesMoneyBack = l.refunds !== false && l.prorates !== false

  let which: DepartureMoney
  let why: string
  if (usedItAll || (paid <= 0 && unpaid <= 0)) {
    which = 'nothing'
    why = usedItAll
      ? 'They used every night of the month they paid for, so there is nothing to re-price and their final utility bills as usual.'
      : 'No rent was taken or billed for that month, so there is nothing to re-price.'
  } else if (!firstHalf) {
    which = 'wash'
    why = `They used ${nightsUsed} of the ${daysInPeriod} nights — half the month or more — so the month stands and `
      + 'their final utility is a wash instead of a pro-rate.'
  } else if (!givesMoneyBack) {
    which = 'wash'
    why = 'This property does not pro-rate or give money back when somebody leaves early, so the month stands '
      + 'and their final utility is a wash.'
  } else {
    which = 'prorate'
    const as = basis === 'stay_rates'
      ? `${plan ?? `${nightsUsed} nights`} at the register's rates${lodgingTax > 0 ? `, lodging tax included` : ''}`
      : 'the monthly rent divided by the days in that month'
    why = `They left with ${daysInPeriod - nightsUsed} of ${daysInPeriod} nights unused — fewer than half the month gone — `
      + `so the ${nightsUsed} nights they used are re-priced as ${as}: ${money(repricedTotal)}.`
  }

  const refundDue = which === 'prorate' ? Math.max(0, round2(paid - repricedTotal)) : 0
  const billBecomes = which === 'prorate' && unpaid > 0
    ? Math.max(0, round2(repricedTotal - paid))
    : unpaid

  return {
    which, why, period, daysInPeriod, nightsUsed, leftOn,
    worth, lodgingTax, repricedTotal, basis, plan,
    paid, unpaid, refundDue, billBecomes,
  }
}
