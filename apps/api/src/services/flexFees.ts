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
