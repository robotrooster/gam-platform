/**
 * 10/26 — reading the FlexPay / FlexDeposit price grids.
 *
 * The grids are database tables (flexpay_fee_schedule, flexdeposit_fee_schedule)
 * so Nic can change a price without a deploy. Two consequences this module
 * exists to enforce:
 *
 * 1. A price that was already charged must stay on the record. Each row carries
 *    effective_from, and a quote is always resolved against the rows in effect
 *    on a given date — never "whatever the table says today". Re-running a past
 *    month has to produce the past month's price.
 *
 * 2. A missing row is an ERROR, never a zero and never a guess. If the schedule
 *    does not cover a rent or a deposit, the caller must refuse to quote rather
 *    than enroll somebody at a price nobody set.
 *
 * See packages/shared/src/flexFees.ts for the bracket-matching rules and why
 * the brackets are half-open.
 */
import { query } from '../db'
import {
  pickFeeBracket,
  isAllowedFlexDepositPaymentCount,
  type FeeBracketRow,
  type BenefitWednesday,
} from '@gam/shared'

export interface FlexFeeQuote {
  fee: number
  /** The bracket that produced it, for showing the tenant why. */
  bracketMin: number
  bracketMax: number | null
  effectiveFrom: string
}

interface ScheduleRow extends FeeBracketRow {
  effective_from: string
}

/**
 * Rows of one schedule column in effect on `asOf`.
 *
 * Where a bracket has been re-priced there are several rows for the same floor;
 * only the newest one at or before `asOf` counts. DISTINCT ON does that in the
 * database so a later edit never resurrects an older price.
 */
async function columnRows(
  table: 'flexpay' | 'flexdeposit',
  keyCol: 'benefit_wednesday' | 'payments',
  keyVal: number,
  asOf: string,
): Promise<ScheduleRow[]> {
  const minCol = table === 'flexpay' ? 'rent_min' : 'deposit_min'
  const maxCol = table === 'flexpay' ? 'rent_max' : 'deposit_max'
  const rows = await query<{ min: string; max: string | null; fee: string; effective_from: string }>(
    `SELECT DISTINCT ON (${minCol})
            ${minCol}::text AS min, ${maxCol}::text AS max, fee::text AS fee,
            effective_from::text AS effective_from
       FROM ${table}_fee_schedule
      WHERE ${keyCol} = $1
        AND effective_from <= $2::date
      ORDER BY ${minCol}, effective_from DESC`,
    [keyVal, asOf],
  )
  return rows.map(r => ({
    min: Number(r.min),
    max: r.max === null ? null : Number(r.max),
    fee: Number(r.fee),
    effective_from: r.effective_from,
  }))
}

function quoteFrom(rows: ScheduleRow[], value: number): FlexFeeQuote | null {
  const row = pickFeeBracket(rows, value)
  if (row === null) return null
  return {
    fee: row.fee,
    bracketMin: row.min,
    bracketMax: row.max,
    effectiveFrom: row.effective_from,
  }
}

/**
 * What FlexPay costs a tenant for one month: their rent bracket crossed with
 * the Wednesday their benefit lands on.
 *
 * Returns null when the schedule does not cover that rent, so the caller
 * refuses rather than quoting a price nobody set.
 */
export async function quoteFlexPayFee(
  monthlyRent: number,
  benefitWednesday: BenefitWednesday,
  asOf: string,
): Promise<FlexFeeQuote | null> {
  if (!(monthlyRent >= 0) || !Number.isFinite(monthlyRent)) return null
  const rows = await columnRows('flexpay', 'benefit_wednesday', benefitWednesday, asOf)
  return quoteFrom(rows, monthlyRent)
}

/**
 * What FlexDeposit costs to split a deposit: the deposit bracket crossed with
 * how many payments it is split across. A one-time price, not a monthly fee —
 * the $3/month custody subscription it replaced charged a tenant more the
 * longer they stayed, which had nothing to do with the service.
 */
export async function quoteFlexDepositFee(
  depositTotal: number,
  payments: number,
  asOf: string,
): Promise<FlexFeeQuote | null> {
  if (!(depositTotal >= 0) || !Number.isFinite(depositTotal)) return null
  if (!isAllowedFlexDepositPaymentCount(payments)) return null
  const rows = await columnRows('flexdeposit', 'payments', payments, asOf)
  return quoteFrom(rows, depositTotal)
}

/**
 * ── 10/27 (Nic): A DEPOSIT BIGGER THAN THE GRID STILL GETS A PLAN ───────────
 *
 * The grid stops at $3,000 and a value at or above the top bracket's ceiling
 * has no price, so a $4,000 deposit used to be refused a plan outright. Nic's
 * rule instead:
 *
 *   "We don't do deposits over $3,000. So that means if somebody's splitting a
 *    payment more than that ... say the payment's $4,000 for the deposit. They
 *    can split the $3,000 into four payments, they pay the $167 or whatever the
 *    fee is, for the four payments, they pay the first payment of the $3,000,
 *    so $750, and then they pay the difference of that $1,000 gap from $3,000
 *    to $4,000 all at once."
 *
 * So the plan covers the ceiling and the rest is paid up front. Expressed as a
 * cap rather than a bracket lookup on purpose: the brackets stay half-open and
 * a missing one stays an error, while this is one stated rule above the top of
 * the table.
 *
 * The ceiling is READ from the schedule, not written here — add a $3,000-3,499
 * bracket one day and the cap moves with it. A bracket with no max (open-ended)
 * means there is no ceiling and nothing is ever paid up front.
 *
 * Returns null when the schedule has no rows at all for that payment count:
 * no ceiling can be known, so the caller refuses rather than inventing one.
 */
export interface FlexDepositSplit {
  /** The part a plan covers, priced by the grid. */
  splittable: number
  /** The part collected in full with payment 1 — 0 for almost everybody. */
  payUpFront: number
  /** The top of the schedule, or null when the top bracket is open-ended. */
  ceiling: number | null
}
export async function flexDepositSplit(
  depositTotal: number,
  payments: number,
  asOf: string,
): Promise<FlexDepositSplit | null> {
  if (!(depositTotal >= 0) || !Number.isFinite(depositTotal)) return null
  if (!isAllowedFlexDepositPaymentCount(payments)) return null
  const rows = await columnRows('flexdeposit', 'payments', payments, asOf)
  if (rows.length === 0) return null
  // The ceiling is the top bracket's max. An open-ended top bracket (max null)
  // covers everything, so there is no ceiling and no up-front remainder.
  const top = rows.reduce((hi, r) => (r.min > hi.min ? r : hi), rows[0])
  const ceiling = top.max
  if (ceiling === null || depositTotal < ceiling) {
    return { splittable: depositTotal, payUpFront: 0, ceiling }
  }
  return {
    splittable: ceiling,
    payUpFront: Math.round((depositTotal - ceiling) * 100) / 100,
    ceiling,
  }
}

/**
 * What a deposit of this size costs to split, with the over-ceiling rule
 * applied: a deposit at or above the top of the grid is priced AT the top
 * bracket (the part a plan can cover), not refused.
 *
 * Null still means no price — the schedule does not cover this payment count,
 * or has no rows at all.
 */
export async function quoteFlexDepositFeeCapped(
  depositTotal: number,
  payments: number,
  asOf: string,
): Promise<(FlexFeeQuote & { split: FlexDepositSplit }) | null> {
  const split = await flexDepositSplit(depositTotal, payments, asOf)
  if (split === null) return null
  // Priced on the splittable part — but the brackets are half-open, so the
  // ceiling itself ($3,000) falls OUTSIDE the top bracket ($2,500-3,000) and
  // has no price of its own. A cent under is inside it, and every value in a
  // bracket carries the same fee, so that is the bracket's price. This bites
  // at exactly the ceiling as well as above it: a $3,000 deposit splits whole
  // with nothing up front, and still has to be priced somewhere.
  const atCeiling = split.ceiling !== null && split.splittable >= split.ceiling
  const priceAt = atCeiling ? split.ceiling! - 0.01 : split.splittable
  const q = await quoteFlexDepositFee(priceAt, payments, asOf)
  return q === null ? null : { ...q, split }
}

/**
 * The two flat fees for moving a FlexDeposit custody balance to a new unit
 * (10/27, Nic — flexdeposit_move_fee_schedule):
 *
 *   paidInFull     the top-up collected in ONE pull. Nothing is split, so the
 *                  bracket grid does not come into it, and this is the only
 *                  fee: $25.
 *   splitMovement  charged BESIDE the grid price when the top-up goes on a
 *                  2-or-4 payment plan — $5 "for recording it against the new
 *                  landlord's books".
 *
 * The cost of actually collecting (ACH or card) is a separate pass-through and
 * is not in here.
 *
 * Null when no schedule is in effect on `asOf` — a move with no price is
 * refused, never free.
 */
export async function quoteFlexDepositMoveFees(
  asOf: string,
): Promise<{ paidInFull: number; splitMovement: number; effectiveFrom: string } | null> {
  const rows = await query<{ pif: string; smf: string; effective_from: string }>(
    `SELECT paid_in_full_fee::text AS pif, split_movement_fee::text AS smf,
            effective_from::text AS effective_from
       FROM flexdeposit_move_fee_schedule
      WHERE effective_from <= $1::date
      ORDER BY effective_from DESC
      LIMIT 1`,
    [asOf],
  )
  if (rows.length === 0) return null
  return {
    paidInFull: Number(rows[0].pif),
    splitMovement: Number(rows[0].smf),
    effectiveFrom: rows[0].effective_from,
  }
}

/**
 * The whole FlexPay grid, for the admin screen that shows and edits it.
 * Ordered so it reads as the table Nic designed: cheapest bracket first,
 * Wednesdays left to right.
 */
export async function flexPayGrid(asOf: string): Promise<
  Array<{ min: number; max: number | null; fees: Record<number, number | null> }>
> {
  const cols = [2, 3, 4] as const
  const byCol = new Map<number, ScheduleRow[]>()
  for (const c of cols) byCol.set(c, await columnRows('flexpay', 'benefit_wednesday', c, asOf))

  // Every floor any column defines, so a column missing a bracket shows as a
  // hole instead of silently shifting the rows below it up a line.
  const floors = [...new Set(cols.flatMap(c => byCol.get(c)!.map(r => r.min)))].sort((a, b) => a - b)
  return floors.map(min => {
    const any = cols.map(c => byCol.get(c)!.find(r => r.min === min)).find(Boolean)
    const fees: Record<number, number | null> = {}
    for (const c of cols) fees[c] = byCol.get(c)!.find(r => r.min === min)?.fee ?? null
    return { min, max: any?.max ?? null, fees }
  })
}
