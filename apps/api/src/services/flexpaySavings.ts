// 10/26-27 (Nic) — WHAT FLEXPAY WOULD HAVE DONE FOR THIS RESIDENT.
//
//   "I want flex pay to not show a flat price. For the people. I want it to
//    say learn more and kind of probe them for information before revealing
//    the price. If they see that price without having done any of the work to
//    get verified, they're just going to take the late fee."
//
// So the price is never a poster — it is the answer to a question they have
// already answered, set beside the thing it replaces. Spec in
// FLEXPAY_SAVINGS_SPEC.md; this file is the arithmetic behind it.
//
// THE ONE RULE THAT SHAPES THE WHOLE FILE: the comparison is built from what
// actually happened to THIS resident, never from a model of what might have.
//
//   "what they could have been charged ... with waived and credited fees added
//    back" — not what they happened to be charged.
//
// A late fee the landlord waived is still evidence the resident was late, and
// a waiver is one landlord's decision on one day, not a promise. So a voided
// late-fee row counts at its original amount. His reason, about the counter
// rather than this screen but the same point: "even if the landlord waived the
// late fee, we need to track, boom, this person was late."
//
// WHY THIS DOES NOT RECOMPUTE LATE FEES FROM THE POLICY. It would have to
// reproduce jobs/lateFees.ts exactly — grace, accrual period, accrual-from,
// the cap, and the first-charged anchoring that re-bases the whole calendar —
// and any disagreement would show a resident a fee their landlord's engine
// would never have charged. Reading the rows the engine actually wrote cannot
// drift from the engine. Where a property has late fees switched off there are
// no rows, the comparison honestly shows FlexPay costing more, and the spec is
// explicit that the loss case is shown and the enroll path stays open:
//
//   "they can do it out of spite for the landlord so the landlord doesn't get
//    any late fees if they wanted to."
//
// WHAT IS DELIBERATELY NOT HERE: no table of brackets, and nothing about what
// anybody else pays. Nic withdrew the cross-property comparison in the same
// breath he proposed it — "if other late fees are less, then that's just going
// to create them haggling with the landlord, and the landlord doesn't want
// that." Their own lease, their own history, their own price.

import { query, queryOne } from '../db'
import {
  benefitWednesdayForPullDay, FLEXPAY_FORBIDDEN_PULL_DAYS, formatCurrency, type BenefitWednesday,
} from '@gam/shared'
import { AppError } from '../middleware/errorHandler'
import type { ResolvedLateFeePolicy } from './lateFeePolicy'
import { quoteFlexPayFee } from './flexFees'
import { coverableLineTypeSql } from './flexpay'
import { todayIn } from '../lib/timezone'

/**
 * ── 10/26 (Nic): NOBODY OPTS IN COLD — THE SURVEY IS EARNED ─────────────────
 *
 * Two doors, either of which opens the income survey:
 *
 *   1. TWO MONTHS WITH A LATE PAYMENT. Being late gets them there SOONER:
 *      "they can get on it sooner if they're late, if they verify their
 *      income." The product is for the person who is struggling with the date.
 *   2. THREE MONTHS OF CLEAN HISTORY.
 *
 * Either way it leads to finding out whether they are eligible, never straight
 * to enrolling — the survey, then an admin verifies income, then enrollment.
 *
 * LATENESS IS NOT THE SAME AS A FEE BEING CHARGED. Nic: "even if the landlord
 * waived the late fee, we need to track, boom, this person was late." So a
 * month counts late on the FACTS of the bill, and a late-fee row (charged or
 * waived) is taken as the engine's own judgment on top of that. A property
 * that charges no late fees at all still produces late months.
 *
 * Grace is the resident's own, resolved the way every other late-fee figure is
 * — lease, then the property's unit-type setting, then the property, never a
 * platform default. Paying inside the grace their lease grants them is not
 * being late.
 */
export interface FlexPaySurveyDoor {
  /** May this resident be shown the survey yet? */
  open:         boolean
  /** Which door opened it, for the copy on the screen. */
  via:          'late_months' | 'clean_months' | null
  late_months:  number
  clean_months: number
  /** The months still needed on the shorter remaining path, for "not yet" copy. */
  needs:        { late_months: number; clean_months: number }
}

export const FLEXPAY_DOOR_LATE_MONTHS = 2
export const FLEXPAY_DOOR_CLEAN_MONTHS = 3

export async function flexPaySurveyDoor(tenantId: string): Promise<FlexPaySurveyDoor> {
  const rows = await query<{ month: string; late: boolean }>(
    // One row per cycle that had a rent bill, saying whether it was late.
    `WITH grace AS (
       SELECT l.id AS lease_id,
              COALESCE(l.late_fee_grace_days,
                       put.late_fee_grace_days,
                       pr.late_fee_grace_days, 0) AS days
         FROM lease_tenants lt
         JOIN leases l     ON l.id = lt.lease_id
         JOIN units u      ON u.id = l.unit_id
         JOIN properties pr ON pr.id = u.property_id
         LEFT JOIN property_unit_type_late_fees put
                ON put.property_id = pr.id AND put.unit_type = u.unit_type
        WHERE lt.tenant_id = $1
     ),
     fee_months AS (
       -- Charged OR waived: a waiver is the landlord's discretion on one day,
       -- not evidence the resident paid on time.
       SELECT DISTINCT to_char(p.due_date, 'YYYY-MM') AS month
         FROM payments p
        WHERE p.tenant_id = $1 AND p.type = 'late_fee'
     ),
     -- The three ways a cycle counts late are flagged per ROW first, then
     -- folded per month. Flagging them in the GROUP BY select would reference
     -- the ungrouped due_date, which Postgres refuses.
     bills AS (
       SELECT to_char(p.due_date, 'YYYY-MM') AS month,
              (p.settled_at IS NOT NULL
                 AND (p.settled_at AT TIME ZONE 'UTC')::date > p.due_date + g.days) AS paid_late,
              (p.settled_at IS NULL AND p.status <> 'voided'
                 AND CURRENT_DATE > p.due_date + g.days) AS still_unpaid,
              (f.month IS NOT NULL) AS had_fee
         FROM payments p
         JOIN grace g ON g.lease_id = p.lease_id
         LEFT JOIN fee_months f ON f.month = to_char(p.due_date, 'YYYY-MM')
        WHERE p.tenant_id = $1
          AND p.type = 'rent'
          AND p.voided_at IS NULL
          -- Work-trade rent settles in hours at month close, so it is neither
          -- late nor on time in cash terms and cannot count either way.
          AND p.work_trade_suspended_at IS NULL
     )
     SELECT month,
            bool_or(paid_late) OR bool_or(still_unpaid) OR bool_or(had_fee) AS late
       FROM bills
      GROUP BY month
      ORDER BY month`,
    [tenantId],
  )

  const late = rows.filter((r) => r.late === true).length
  const clean = rows.length - late
  const via = late >= FLEXPAY_DOOR_LATE_MONTHS ? 'late_months' as const
    : clean >= FLEXPAY_DOOR_CLEAN_MONTHS ? 'clean_months' as const
    : null
  return {
    open:  via !== null,
    via,
    late_months:  late,
    clean_months: clean,
    needs: {
      late_months:  Math.max(0, FLEXPAY_DOOR_LATE_MONTHS - late),
      clean_months: Math.max(0, FLEXPAY_DOOR_CLEAN_MONTHS - clean),
    },
  }
}

export interface FlexPaySavingsMonth {
  /** 'YYYY-MM' — the cycle the rent was for. */
  month:                 string
  /** The whole bill FlexPay would have fronted that cycle, utilities included. */
  bill:                  number
  /** Late fees on that cycle that stood. */
  late_fee_charged:      number
  /** Late fees on that cycle that were posted and then waived — added back. */
  late_fee_waived:       number
  /** The two together: what the lease allowed, before anybody's goodwill. */
  could_have_been_charged: number
  /** FlexPay's price for that bill at their pull day, or null above the grid. */
  would_have_paid:       number | null
}

export interface FlexPaySavings {
  months:                  FlexPaySavingsMonth[]
  /** Totals over the months that could be priced. */
  could_have_been_charged: number
  would_have_paid:         number
  /** Positive means FlexPay would have cost them less. Negative is shown too. */
  difference:              number
  months_compared:         number
  /**
   * Months left out of the totals because the bill was at or above the top of
   * the grid, where FlexPay is not offered. Counted and named rather than
   * silently dropped — a total that quietly skips months is a wrong total.
   */
  months_unpriced:         number
  pull_day:                number | null
  benefit_wednesday:       BenefitWednesday | null
  /**
   * True when this resident's property charges no late fees at all, so the
   * honest comparison is against zero. The screen says so in words rather
   * than showing a $0 that looks like missing data.
   */
  no_late_fee_policy:      boolean
}

interface CycleRow {
  month:            string
  bill:             string
  late_fee_charged: string
  late_fee_waived:  string
}

const money = (v: string | number | null | undefined) =>
  Math.round(Number(v ?? 0) * 100) / 100

/**
 * The resident's own history, cycle by cycle.
 *
 * `bill` is every rent and rent-riding charge for that cycle, which is what
 * FlexPay fronts — Nic: the fee is set by "the amount GAM actually fronts that
 * cycle (the whole bill — utilities billed back ride it, and that money is out
 * too)". Work-trade rent is excluded: it settles in hours at month close, not
 * in cash, so FlexPay would never have fronted it and counting it would
 * inflate both sides.
 *
 * A late fee is attributed to the cycle of the bill it accrued against, so the
 * two columns line up month by month instead of being two separate totals.
 */
async function cycles(tenantId: string, sinceMonths: number): Promise<CycleRow[]> {
  return query<CycleRow>(
    `WITH bills AS (
       -- The cycle is the bill's DUE DATE month. payments has no cycle_month
       -- column (checked against the live schema) — rent and the utilities
       -- riding it share a due date, which is what makes them one cycle.
       SELECT to_char(p.due_date, 'YYYY-MM') AS month,
              p.id,
              p.amount,
              p.type,
              p.voided_at,
              (${coverableLineTypeSql('p')}) AS coverable
         FROM payments p
        WHERE p.tenant_id = $1
          AND p.work_trade_suspended_at IS NULL
          AND p.due_date
                >= (date_trunc('month', CURRENT_DATE) - ($2::int || ' months')::interval)::date
     )
     SELECT month,
            -- What FlexPay would have fronted: only the kinds of line it
            -- actually covers, from the engine's own definition
            -- (coverableLineTypeSql). Never a late fee — GAM charges none of
            -- its own and never fronts one.
            COALESCE(SUM(amount) FILTER (
              WHERE coverable AND voided_at IS NULL), 0)::text AS bill,
            COALESCE(SUM(amount) FILTER (
              WHERE type = 'late_fee' AND voided_at IS NULL), 0)::text AS late_fee_charged,
            -- Added back: a waiver is the landlord's discretion on one day,
            -- not evidence the resident paid on time.
            COALESCE(SUM(amount) FILTER (
              WHERE type = 'late_fee' AND voided_at IS NOT NULL), 0)::text AS late_fee_waived
       FROM bills
      GROUP BY month
      HAVING COALESCE(SUM(amount) FILTER (
               WHERE coverable AND voided_at IS NULL), 0) > 0
      ORDER BY month`,
    [tenantId, sinceMonths],
  )
}

/**
 * The comparison the resident is shown, after they have answered the survey.
 *
 * `pullDay` is their own — derived from when their money arrives, never chosen
 * for convenience (Nic: "If they get paid on the second Wednesday, they cannot
 * choose the third Wednesday just for the heck of it"). Without one there is
 * no price to quote and this returns nulls rather than guessing a column.
 */
export async function flexPaySavings(args: {
  tenantId:    string
  /** Their derived pull day (1-28). Null before the survey is answered. */
  pullDay:     number | null
  /** How far back to look. 12 is a year of their own history. */
  sinceMonths?: number
  /** Price as of this date, so a re-price never restates the past. */
  asOf?:       string
}): Promise<FlexPaySavings> {
  const since = Math.max(1, Math.min(60, args.sinceMonths ?? 12))
  const asOf = args.asOf ?? todayIn(null)
  const wednesday = args.pullDay == null ? null : benefitWednesdayForPullDay(args.pullDay)

  const rows = await cycles(args.tenantId, since)

  // Does their property charge late fees at all? Read off the lease's unit, so
  // it is their own policy and never a platform default.
  const policy = await queryOne<{ enabled: boolean }>(
    `SELECT p.late_fee_enabled AS enabled
       FROM lease_tenants lt
       JOIN leases l  ON l.id = lt.lease_id
       JOIN units u   ON u.id = l.unit_id
       JOIN properties p ON p.id = u.property_id
      WHERE lt.tenant_id = $1
        AND l.status IN ('active', 'pending')
      ORDER BY l.start_date DESC
      LIMIT 1`,
    [args.tenantId],
  )

  const months: FlexPaySavingsMonth[] = []
  for (const r of rows) {
    const bill = money(r.bill)
    const charged = money(r.late_fee_charged)
    const waived = money(r.late_fee_waived)
    // Null above the top bracket, where FlexPay is not offered. quoteFlexPayFee
    // returns null for a missing bracket and the callers treat that as an
    // error rather than a zero — "not offered" must never read as "free".
    // quoteFlexPayFee returns the bracket it matched as well as the price;
    // only the price is shown, because the resident is never given the grid.
    const quote = wednesday == null
      ? null
      : (await quoteFlexPayFee(bill, wednesday, asOf))?.fee ?? null
    months.push({
      month: r.month,
      bill,
      late_fee_charged: charged,
      late_fee_waived:  waived,
      could_have_been_charged: money(charged + waived),
      would_have_paid: quote,
    })
  }

  const priced = months.filter((m) => m.would_have_paid != null)
  const could = money(priced.reduce((s, m) => s + m.could_have_been_charged, 0))
  const would = money(priced.reduce((s, m) => s + (m.would_have_paid ?? 0), 0))

  return {
    months,
    could_have_been_charged: could,
    would_have_paid:         would,
    difference:              money(could - would),
    months_compared:         priced.length,
    months_unpriced:         months.length - priced.length,
    pull_day:                args.pullDay,
    benefit_wednesday:       wednesday,
    no_late_fee_policy:      policy ? policy.enabled !== true : false,
  }
}

/**
 * ── "LEARN MORE": PROBE, THEN REVEAL ────────────────────────────────────────
 *
 * One call, because the screen is one thought: are you allowed to ask yet, what
 * does your own lease say about being late, when does your money arrive, and —
 * once we know that — what would this have cost you against what being late
 * could have cost you.
 *
 * WHAT IS NEVER IN HERE, and the reasons are Nic's own:
 *   • the price grid. "We don't want to show tenants the table." They are told
 *     their own price, derived, and nothing about the shape it came from.
 *   • anybody else's late fee. He proposed showing the comparison and withdrew
 *     it in the same breath: "if other late fees are less, then that's just
 *     going to create them haggling with the landlord, and the landlord doesn't
 *     want that." Their own lease, their own property, their own price.
 *
 * And the loss case is shown exactly as plainly as the win: a resident FlexPay
 * would have cost more is told so, and the enrol path stays open, because "they
 * can do it out of spite for the landlord so the landlord doesn't get any late
 * fees if they wanted to."
 */
export interface FlexPayLearnMore {
  /** Is the product being offered at all (flexpay_rollout_visible)? */
  offered:        boolean
  /** Has this resident earned the right to be asked (two doors)? */
  door:           FlexPaySurveyDoor
  /** Their answer: the day of the month their money lands. Null if never asked. */
  money_arrives_day: number | null
  /** Derived from it, and the only day GAM would draw on. */
  pull_day:       number | null
  /**
   * True when their money lands early enough that there is no gap to cover —
   * rent is not late yet when they are paid. Told plainly instead of quoting a
   * price for something they do not need.
   */
  arrives_before_rent_is_late: boolean
  /** Their own figures. Null until they have said when their money arrives. */
  savings:        FlexPaySavings | null
  /** What their own lease says, in plain words. Null when no policy resolves. */
  late_fee_words: string | null
  /** Past performance is not a promise: a landlord may re-price at renewal. */
  disclaimer:     string
}

export const FLEXPAY_PAST_PERFORMANCE =
  'This is your own history, not a promise. Your landlord can change their late '
  + 'fee when your lease renews, so what happened before is not what will happen next.'

/** Their lease's late fee, said the way a person would say it. */
export function lateFeeInWords(p: ResolvedLateFeePolicy | null): string | null {
  if (!p) return null
  const amount = (v: string | null, t: string | null): string =>
    v == null ? '' : t === 'percent_of_rent' ? `${Number(v)}% of your rent` : formatCurrency(Number(v))
  const grace = p.late_fee_grace_days > 0
    ? `after a ${p.late_fee_grace_days}-day grace period`
    : 'the day rent is late'
  let s = `Your lease allows a late fee of ${amount(p.late_fee_initial_amount, p.late_fee_initial_type)} ${grace}`
  if (p.late_fee_accrual_amount != null && p.late_fee_accrual_period) {
    const per = { daily: 'day', weekly: 'week', monthly: 'month' }[p.late_fee_accrual_period]
    s += `, then ${amount(p.late_fee_accrual_amount, p.late_fee_accrual_type)} per ${per}`
  }
  if (p.late_fee_cap_amount != null) {
    s += `, up to ${amount(p.late_fee_cap_amount, p.late_fee_cap_type)}`
  }
  return `${s}. Whether it is actually charged has been your landlord's call each time.`
}

export async function flexPayLearnMore(tenantId: string): Promise<FlexPayLearnMore> {
  const { isFeatureEnabled } = await import('./systemFeatures')
  const offered = await isFeatureEnabled('flexpay_rollout_visible')

  const t = await queryOne<{ day: number | null; pull: number | null }>(
    `SELECT flexpay_money_arrives_day AS day, flexpay_pull_day AS pull
       FROM tenants WHERE id = $1`, [tenantId])
  const day = t?.day ?? null

  const door = await flexPaySurveyDoor(tenantId)

  // Their unit, for their own late-fee policy — never a platform default.
  const unit = await queryOne<{ unit_id: string }>(
    `SELECT l.unit_id
       FROM lease_tenants lt
       JOIN leases l ON l.id = lt.lease_id
      WHERE lt.tenant_id = $1 AND l.status IN ('active', 'pending')
      ORDER BY l.start_date DESC
      LIMIT 1`, [tenantId])
  const { resolveLateFeePolicyForUnit } = await import('./lateFeePolicy')
  const policy = unit ? await resolveLateFeePolicyForUnit(unit.unit_id) : null

  // A pull day only exists where there is a gap to cover. Money landing on the
  // 1st through the 5th is there before rent is late anywhere, and those days
  // are not drawable in any case (FLEXPAY_FORBIDDEN_PULL_DAYS).
  const early = day != null && (FLEXPAY_FORBIDDEN_PULL_DAYS as readonly number[]).includes(day)
  const pullDay = day == null || early ? null : day

  return {
    offered,
    door,
    money_arrives_day: day,
    pull_day: pullDay ?? t?.pull ?? null,
    arrives_before_rent_is_late: early,
    savings: pullDay == null ? null : await flexPaySavings({ tenantId, pullDay }),
    late_fee_words: lateFeeInWords(policy),
    disclaimer: FLEXPAY_PAST_PERFORMANCE,
  }
}

/**
 * Their answer, and the pull day derived from it.
 *
 *   "We don't ask them when they want to pay. If they get paid on the second
 *    Wednesday, they cannot choose the third Wednesday just for the heck of
 *    it."
 *
 * So the pull day IS the day their money lands; it is not offered as a choice
 * anywhere. A day in the 1st-5th is recorded as their answer and derives no
 * pull day at all — there is nothing to cover.
 */
export async function recordMoneyArrivesDay(tenantId: string, day: number): Promise<{ pullDay: number | null }> {
  if (!Number.isInteger(day) || day < 1 || day > 28) {
    throw new AppError(400, 'Pick the day of the month your money arrives, from the 1st to the 28th.')
  }
  const early = (FLEXPAY_FORBIDDEN_PULL_DAYS as readonly number[]).includes(day)
  const pullDay = early ? null : day
  await query(
    `UPDATE tenants
        SET flexpay_money_arrives_day = $2,
            flexpay_money_arrives_answered_at = NOW(),
            -- Derived, never chosen. An enrolled resident keeps the day they
            -- are already being drawn on: re-pricing a live enrollment from a
            -- survey answer is a change to their bill, not an answer to a
            -- question.
            flexpay_pull_day = CASE WHEN flexpay_enrolled THEN flexpay_pull_day ELSE $3 END,
            updated_at = NOW()
      WHERE id = $1`,
    [tenantId, day, pullDay])
  return { pullDay }
}
