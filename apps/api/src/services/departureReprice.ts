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
import { query, getClient } from '../db'
// The ONE way a charge that is still owed stops being owed: voided under its
// own lock, with a reason, and refused for any charge a record points at
// (services/chargeVoids). services/lateFeeDelete is NOT this — it is the
// onboarding waiver, and only takes a late fee that was already credited.
import { voidUnowedCharges } from './chargeVoids'
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

/**
 * 10/22 (Nic), CORRECTING the first cut of this the same evening:
 *
 *   "the refund being a figure and not a button needs to be a button because
 *    it's situational where we may refund somebody or we may not, depending on
 *    the situation. The only deciding factor cannot be if they leave before
 *    half of their paid time was over. That's just one factor for the wash on
 *    electric, but that's not a factor for whether or not there's a refund at
 *    all."
 *
 * So the halfway point answers ONE question — do we call the final utility a
 * wash — and it answers nothing about whether money goes back. A refund is a
 * person's decision at the desk, made with the figure in front of them, at any
 * point in the month. Exactly as a stay's check-out already works: the desk is
 * shown "Refund the unused nights ($X)" and chooses.
 *
 * The first cut had the halfway point gating both, which would have meant GAM
 * refusing to hand back money on a departure the landlord wanted to refund.
 */
export type DepartureMoney =
  /** Half or more of the paid nights used, money in hand, nothing given back. */
  | 'wash'
  /** Not a wash — the final utility bills as usual. Money may still go back. */
  | 'bills'
  /** Nothing to settle: they used the whole month, or no rent was taken or billed. */
  | 'nothing'

export interface DepartureReprice {
  /** The WASH question, and only that. Never whether money goes back. */
  which: DepartureMoney
  /** Plain words for the desk and for the record — about the wash. */
  why: string
  /**
   * CAN money go back at all: they paid something, and the property gives money
   * back when somebody leaves early. Whether it SHOULD is the desk's call.
   */
  canRefund: boolean
  /** Why not, when it cannot — in words for the screen. */
  whyNoRefund: string | null
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
  lease_source: string | null; has_predecessor: boolean; source_booking_id: string | null
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
            l.lease_source, l.source_booking_id,
            (l.supersedes_lease_id IS NOT NULL) AS has_predecessor,
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

  // ── HAVE THEY BEEN HERE LONGER THAN THIS MONTH? ──────────────────────────
  //
  // 10/22 (Nic), on the two RV residents he was checking out: "These guys don't
  // have lodging tax, though. They've been here for multiple months, right? So
  // there needs to be a distinction. It's going to be always a gray area on
  // like an onboarding type of month, but if they've been here more than a
  // month and the proration doesn't mean we add the short-term tax. We need
  // that distinction in there."
  //
  // THE LEASE'S START DATE IS NOT THE ANSWER, and his own two leases are why:
  // both were e-signed in September for people who had been on those sites far
  // longer, because that is when the park came onto GAM. A landlord who
  // onboards in October and imports a resident of three years has a lease that
  // starts this month. Pricing that person as a nine-night tourist would put a
  // short-term lodging tax on somebody who owes none.
  //
  // So anything that shows they were here before this month makes them a
  // resident, and the doubt goes that way on purpose — GAM never charges
  // short-term tax to somebody who may not owe it:
  //   • the lease started before this month;
  //   • it came in from the old system (imported at onboarding);
  //   • it replaced an earlier lease (a renewal);
  //   • rent was billed for an earlier month;
  //   • the stay behind it checked in before this month.
  const been = (await q.query<{ earlier_rent: boolean; earlier_stay: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM payments pr
                     WHERE pr.lease_id = $1 AND pr.type = 'rent' AND pr.due_date < $2::date) AS earlier_rent,
            EXISTS (SELECT 1 FROM unit_bookings b
                     WHERE b.id = $3::uuid AND b.check_in < $2::date) AS earlier_stay`,
    [args.leaseId, month.start, l.source_booking_id])).rows[0]
  const beenHereLonger = l.start_date < month.start
    || l.lease_source === 'imported'
    || l.has_predecessor === true
    || been?.earlier_rent === true
    || been?.earlier_stay === true

  // ── What the nights they used are worth ──────────────────────────────────
  //
  // THEIR FIRST MONTH, so they were never a resident: the register's ladder,
  // tax and all. "if that's the only month they've been there, they get charged
  // the weekly rate."
  const firstMonth = !beenHereLonger
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
  const as = basis === 'stay_rates'
    ? `${plan ?? `${nightsUsed} nights`} at the register's rates${lodgingTax > 0 ? ', lodging tax included' : ''}`
    : 'the monthly rent divided by the days in that month'
  const worthWords = `The ${nightsUsed} nights they used are worth ${money(repricedTotal)} — ${as}.`

  if (usedItAll || (paid <= 0 && unpaid <= 0)) {
    which = 'nothing'
    why = usedItAll
      ? 'They used every night of the month they paid for, so there is nothing to re-price and their final utility bills as usual.'
      : 'No rent was taken or billed for that month, so there is nothing to re-price.'
  } else if (!firstHalf && paid > 0 && givesMoneyBack) {
    which = 'wash'
    why = `${worthWords} They used ${nightsUsed} of the ${daysInPeriod} nights — half the month or more — `
      + 'so their final utility is a wash, unless money goes back.'
  } else if (paid > 0 && !givesMoneyBack) {
    // A PROPERTY THAT GIVES NOTHING BACK WASHES WHENEVER THEY LEFT. 10/18: it
    // has nothing to ask and nothing went back by definition, so the money kept
    // is real and the final utility is what it is set against — and the earlier
    // they left, the more there is to set it against. The halfway point is one
    // factor for the wash (10/22), not the only one, and this is the other.
    which = 'wash'
    why = `${worthWords} This property does not give money back when somebody leaves early, `
      + 'so the month stands and their final utility is a wash.'
  } else {
    which = 'bills'
    why = firstHalf
      ? `${worthWords} They left with ${daysInPeriod - nightsUsed} of ${daysInPeriod} nights unused — `
        + 'fewer than half the month gone — so their final utility bills as usual.'
      : `${worthWords} Nothing was taken for that month, so there is no money kept to set a utility against `
        + 'and their final utility bills as usual.'
  }

  // WHAT WOULD GO BACK IF SOMEBODY PRESSED IT — worked out whatever the wash
  // says, because the two questions are not the same question (10/22).
  const refundDue = Math.max(0, round2(paid - repricedTotal))
  const canRefund = paid > 0 && givesMoneyBack && refundDue > 0 && !usedItAll
  const whyNoRefund = canRefund ? null
    : usedItAll ? 'They used every night they paid for, so there is nothing to give back.'
    : !(paid > 0) ? 'Nothing was paid for that month, so there is nothing to give back.'
    : !givesMoneyBack ? 'This property does not give money back when somebody leaves early.'
    : 'The nights they used are worth everything they paid, so there is nothing to give back.'

  const billBecomes = unpaid > 0 ? Math.max(0, round2(repricedTotal - paid)) : unpaid

  return {
    which, why, canRefund, whyNoRefund, period, daysInPeriod, nightsUsed, leftOn,
    worth, lodgingTax, repricedTotal, basis, plan,
    paid, unpaid, refundDue, billBecomes,
  }
}

/** The note left on a bill the departure re-priced, so the history reads. */
export const DEPARTURE_ADJUSTED_NOTE =
  'Re-priced when they left part way through the month (departure adjustment)'

export interface UnpaidDepartureAdjustment {
  applied: boolean
  why: string
  /** What the month was billed at, and what it becomes. */
  rentWas: number
  rentNow: number
  /** Late fees taken off, and how many rows that was. */
  lateFeesOff: number
  lateFeeRows: number
  /** The re-priced figure the bill was set to, tax included where tax applies. */
  repricedTotal: number
  lodgingTax: number
  nightsUsed: number
  daysInPeriod: number
}

const NOTHING = (why: string): UnpaidDepartureAdjustment => ({
  applied: false, why, rentWas: 0, rentNow: 0, lateFeesOff: 0, lateFeeRows: 0,
  repricedTotal: 0, lodgingTax: 0, nightsUsed: 0, daysInPeriod: 0,
})

/**
 * 10/22 (Nic) — THEY NEVER PAID THE MONTH THEY LEFT IN, SO THE BILL CHANGES
 * INSTEAD OF MONEY GOING BACK.
 *
 *   "somebody doesn't pay on the first of the month, because they think they're
 *    going to be leaving in a week. You know, or shortly after the grace period
 *    ends. So they don't pay. It racks up late fees. They go to check out on
 *    the seventh... let's say they check out on the ninth. We want to adjust the
 *    bill so that there's no late fees but also get them prorated."
 *
 * Two things happen, and the second is the one that needs saying out loud:
 *
 *   THE RENT IS RE-PRICED to what they actually used — the register's ladder in
 *   a first month, monthly ÷ days in that month for a resident, by the one rule
 *   above. Lodging tax rides inside the figure where a short stay owes it.
 *
 *   THE LATE FEES COME OFF. They were charged for waiting on a month the person
 *   was never going to use, and Nic's answer is that they should not be there.
 *   They come off through the SAME path a landlord's own "Delete this late fee"
 *   uses (services/lateFeeDelete), so the fee is kept in the audit log, its own
 *   credit is released, and the bill's late mark is re-rated — rather than a
 *   second way to remove a late fee that does four fewer things.
 *
 * REFUSED, in plain words, when:
 *   - any of that month's rent actually arrived. Money in hand is the wash's
 *     question or a refund's, not an adjustment's.
 *   - they used half the month or more. "if they used more than half the month,
 *     we're not going to prorate them."
 *   - the month carries more than one unpaid rent row. One bill is the normal
 *     shape; several is somebody's hand-correction, and quietly rewriting the
 *     first of them is how a figure nobody can explain gets into the books.
 */
export async function adjustUnpaidDepartureBill(args: {
  leaseId: string
  landlordId: string
  leftOn?: string | null
  byUserId: string | null
  client?: PoolClient
}): Promise<UnpaidDepartureAdjustment> {
  const own = !args.client
  const client = args.client ?? await getClient()
  try {
    if (own) await client.query('BEGIN')
    const fork = await repriceDeparture(
      { leaseId: args.leaseId, landlordId: args.landlordId, leftOn: args.leftOn }, client)
    if (!fork) {
      if (own) await client.query('COMMIT')
      return NOTHING('That lease is not on this landlord\'s books, or there is no day they left.')
    }
    const shape = { repricedTotal: fork.repricedTotal, lodgingTax: fork.lodgingTax,
                    nightsUsed: fork.nightsUsed, daysInPeriod: fork.daysInPeriod }
    const no = (why: string) => ({ ...NOTHING(why), ...shape })

    if (fork.paid > 0) {
      if (own) await client.query('COMMIT')
      return no(`They paid ${money(fork.paid)} toward that month, so this is not a bill to adjust — `
        + 'it is a refund or a wash. Settle it on the check-out screen.')
    }
    if (fork.which === 'nothing') {
      if (own) await client.query('COMMIT')
      return no(fork.why)
    }
    // 10/22 (Nic): the halfway point does NOT gate this either. It is the same
    // situational call as a refund — "it's situational where we may refund
    // somebody or we may not" — and an unpaid month is the same money question
    // with the cash still on their side of the table. The screen says how much
    // of the month they used; the person pressing decides.
    if (!(fork.unpaid > 0)) {
      if (own) await client.query('COMMIT')
      return no('Nothing is billed for that month, so there is nothing to adjust.')
    }

    const rent = (await client.query<{ id: string; amount: string; invoice_id: string | null }>(
      `SELECT id, amount, invoice_id FROM payments
        WHERE lease_id = $1 AND landlord_id = $2 AND type = 'rent'
          AND status IN ('pending', 'failed')
          AND due_date >= $3::date AND due_date <= $4::date
        ORDER BY due_date, id
        FOR UPDATE`,
      [args.leaseId, args.landlordId, fork.period.start, fork.period.end])).rows
    if (rent.length !== 1) {
      if (own) await client.query('COMMIT')
      return no(`That month has ${rent.length} unpaid rent charges on it, not one, so nothing was changed — `
        + 'put the month right on the Payments page first, then adjust it here.')
    }
    const row = rent[0]
    const was = num(row.amount)

    await client.query(
      `UPDATE payments
          SET amount = $2,
              notes = TRIM(COALESCE(notes || ' · ', '') || $3)
        WHERE id = $1`,
      [row.id, fork.repricedTotal.toFixed(2), DEPARTURE_ADJUSTED_NOTE])

    // THE LATE FEES THAT CAME OF WAITING ON THIS BILL.
    //
    // Voided, not deleted: GAM never erases, the row keeps its reason, and the
    // change journal holds what it said before. A fee some other record points
    // at (a receipt application, a bank match) is left alone by
    // voidUnowedCharges and reported as held, rather than torn out from under
    // whatever points at it.
    let lateFeesOff = 0, lateFeeRows = 0, lateFeesHeld = 0
    if (row.invoice_id) {
      const fees = (await client.query<{ id: string }>(
        `SELECT id FROM payments
          WHERE invoice_id = $1 AND type = 'late_fee' AND status IN ('pending', 'failed')`,
        [row.invoice_id])).rows
      if (fees.length) {
        const out = await voidUnowedCharges(
          ((sql: string, params?: any[]) => client.query(sql, params as any)) as any,
          fees.map(f => f.id),
          'Left part way through the month they never paid for; the late fees were waiting on a month they did not use.')
        lateFeeRows = out.voided.length
        lateFeesOff = round2(out.voided.reduce((n, v) => n + v.amount, 0))
        lateFeesHeld = out.held.length
      }
    }

    if (own) await client.query('COMMIT')
    return {
      applied: true, ...shape,
      rentWas: was, rentNow: fork.repricedTotal, lateFeesOff, lateFeeRows,
      why: `${fork.why}`
        + (lateFeeRows > 0
            ? ` ${money(lateFeesOff)} of late fees came off — they were waiting on a month they did not use.`
            : '')
        + (lateFeesHeld > 0
            ? ` ${lateFeesHeld} late fee${lateFeesHeld === 1 ? '' : 's'} stayed: money is recorded against ${lateFeesHeld === 1 ? 'it' : 'them'}.`
            : ''),
    }
  } catch (e) {
    if (own) await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    if (own) client.release()
  }
}
