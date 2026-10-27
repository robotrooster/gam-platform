/**
 * 10/26 — FlexPay and FlexDeposit pricing, rebuilt (Nic).
 *
 * Both products used to be a flat subscription: FlexPay $25/month regardless of
 * anything, FlexDeposit $3/month while GAM held the deposit. Nic replaced both,
 * because a flat price is unfair in both directions — "it wasn't fair to people
 * only borrowing for the shorter time, and it wasn't fair to the people who
 * borrowed for longer."
 *
 * Now each is a GRID: the amount involved crossed with how long GAM's money is
 * out.
 *
 *   FlexPay      rent bracket   x  the tenant's benefit Wednesday (2nd/3rd/4th)
 *   FlexDeposit  deposit bracket x  how many payments (2..6)
 *
 * ── WHY A BRACKET AND NOT A PERCENTAGE ─────────────────────────────────────
 * Nic: "we're trying to stay out of lender territory and it's like a fixed price
 * for anything in that bracket is that price." Every rent inside a bracket pays
 * the same dollars. The brackets were CHOSEN so that the fee lands at a similar
 * share of rent across them (his requirement: "try to break it down where
 * different rent amounts are kind of coming out as a somewhat similar
 * percentage"), but the price a tenant is quoted is a flat bracket price and is
 * never computed from their particular rent.
 *
 * ── THE NUMBERS LIVE IN THE DATABASE ───────────────────────────────────────
 * flexpay_fee_schedule and flexdeposit_fee_schedule are the source of truth, so
 * Nic can change a price without a deploy and so a price that was already
 * charged stays on the record. This module is the pure matching logic: give it
 * the rows and a value, it tells you which bracket wins. No numbers hardcoded
 * here — a stale copy of a price schedule is worse than none.
 */

/** A row of either schedule: a half-open bracket [min, max) and its price. */
export interface FeeBracketRow {
  /** Inclusive floor. */
  min: number
  /** EXCLUSIVE ceiling; null means the bracket is open at the top. */
  max: number | null
  fee: number
}

/**
 * The Wednesday of the month a tenant's Social Security or SSI lands on, which
 * is set by their birth date, not by their choosing. There is no 1st-Wednesday
 * column: Nic, "I don't think we really had one for first Wednesday" — a
 * benefit landing that early rarely needs FlexPay at all.
 */
export const BENEFIT_WEDNESDAYS = [2, 3, 4] as const
export type BenefitWednesday = typeof BENEFIT_WEDNESDAYS[number]

/** Nic: "deposits could be paid over 2 to 6 payments." */
/**
 * 10/26 (Nic) — FLEXDEPOSIT SELLS EXACTLY TWO SPLITS: 2 OR 4.
 *
 *   "Why don't we just make every bracket four payments? If they need six,
 *    that's too much. And two might not be enough... That way there's no
 *    adverse anything. People don't have a choice. There's no 'in part' by
 *    limiting their options."
 *
 * Not a range. Three, five and six are not sold and have no rows in
 * flexdeposit_fee_schedule, whose CHECK is (2, 4) so they cannot be written.
 * Everyone sees both choices at the same price for their deposit size — that
 * uniformity is what keeps this a service price rather than a decision made
 * about the applicant.
 */
export const FLEX_DEPOSIT_PAYMENT_CHOICES = [2, 4] as const
export type FlexDepositPaymentCount = typeof FLEX_DEPOSIT_PAYMENT_CHOICES[number]
export const FLEX_DEPOSIT_MIN_PAYMENTS = 2
export const FLEX_DEPOSIT_MAX_PAYMENTS = 4

/**
 * The bracket a value falls in, or null when no row covers it.
 *
 * Brackets are half-open — [min, max) — so a rent of exactly $1,500 sits in the
 * 1,500-1,999 bracket and never in the one below it. An off-by-one here would
 * misprice every tenant sitting on a boundary, which is where round rents
 * cluster.
 *
 * Rows are matched on the HIGHEST floor at or below the value, so a schedule
 * with overlapping or gapped rows still resolves predictably rather than
 * silently taking whichever row happened to come back first.
 */
export function pickFeeBracket<T extends FeeBracketRow>(rows: readonly T[], value: number): T | null {
  if (!Number.isFinite(value)) return null
  let best: T | null = null
  for (const r of rows) {
    if (value < r.min) continue
    if (r.max !== null && value >= r.max) continue
    if (best === null || r.min > best.min) best = r
  }
  return best
}

/** The price for a value, or null when the schedule does not cover it. */
export function feeForValue(rows: readonly FeeBracketRow[], value: number): number | null {
  const row = pickFeeBracket(rows, value)
  return row === null ? null : row.fee
}

/**
 * Which Wednesday column an existing FlexPay enrollment belongs to.
 *
 * Enrollments store a pull DAY of the month (1..28) chosen to sit near when the
 * tenant's benefit lands. The actual 2nd Wednesday moves between the 8th and
 * the 14th from month to month, so a fixed day can only ever approximate it —
 * the day-of-month ranges below are the Wednesday windows exactly:
 *
 *   2nd Wednesday  always falls on the 8th-14th
 *   3rd Wednesday  always falls on the 15th-21st
 *   4th Wednesday  always falls on the 22nd-28th
 *
 * A pull day before the 8th is EARLIER than any 2nd Wednesday, so GAM's money
 * is out for less time than the cheapest column assumes; it prices at that
 * column rather than inventing a fourth. Days 1-5 are not selectable at all
 * (FLEXPAY_FORBIDDEN_PULL_DAYS), so in practice this is the 6th and 7th.
 *
 * Returns null above the 28th, which no enrollment can hold.
 */
export function benefitWednesdayForPullDay(pullDay: number): BenefitWednesday | null {
  if (!Number.isInteger(pullDay) || pullDay < 1) return null
  if (pullDay <= 14) return 2
  if (pullDay <= 21) return 3
  if (pullDay <= 28) return 4
  return null
}

/** Is this a payment count FlexDeposit will split a deposit across? */
export function isAllowedFlexDepositPaymentCount(n: number): boolean {
  // Membership, not a range: 3 sits inside 2..4 and is not sold.
  return (FLEX_DEPOSIT_PAYMENT_CHOICES as readonly number[]).includes(n)
}
