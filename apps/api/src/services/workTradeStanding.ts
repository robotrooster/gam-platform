// S624 — where a work-trade tenant actually stands, in hours.
//
// Nic (S623): the next invoice must state "both the new month's hours owed and
// the hours still owed from the carried balance." A tenant who is told only
// "80 hours" when they actually need 100 to get straight has been told the least
// useful true thing available.
//
// And the landlord's side (Nic, S624): "at some point, a landlord's gonna know
// that somebody's never gonna be able to physically catch up. There's just not
// that many hours in a month." That judgement should not require arithmetic in
// someone's head, so `catchUpHours` is stated plainly and `catchUpPlausible`
// says whether a human could actually work it.

import { round2h } from './workTradeSettlement'
import { round2 } from './workTradeCredit'

export interface CarriedPeriod {
  periodMonth: string
  hoursOutstanding: number
  hourRate: number
  /** Further closes this period may still survive before it is billed. */
  closesRemaining: number
}

export interface WorkTradeStanding {
  /** Hours the CURRENT month asks for on its own. */
  currentMonthHours: number
  /** Hours still owed from earlier months. */
  carriedHours: number
  /** Everything owed: current + carried, less anything banked. */
  catchUpHours: number
  /** Hours already worked ahead. */
  bankedHours: number
  /**
   * What the carried hours would cost in cash if the agreement ended today —
   * each period at its own frozen rate.
   */
  carriedValue: number
  /**
   * Is `catchUpHours` something a person could actually work this month?
   *
   * A deliberately generous ceiling: 12 hours a day, every day. Anything above
   * it is not a tenant who is behind, it is an arrangement that has failed, and
   * the landlord should be told so rather than left to discover it when the
   * leniency window finally closes.
   */
  catchUpPlausible: boolean
  /** The soonest month a carried deficit gets billed, if nothing changes. */
  nextBillingMonth: string | null
  /** One sentence for the invoice. Never a raw enum, never bare numbers. */
  summary: string
}

/** Days in the month a period-month string names. */
function daysInMonth(periodMonth: string): number {
  const [y, m] = periodMonth.split('-').map(Number)
  return new Date(Date.UTC(y, m, 0)).getUTCDate()
}

const MAX_WORKABLE_HOURS_PER_DAY = 12

export function workTradeStanding(input: {
  currentMonth: string
  currentMonthTarget: number
  currentMonthApplied: number
  carried: CarriedPeriod[]
  bankedHours: number
}): WorkTradeStanding {
  const currentMonthHours = Math.max(0,
    round2h(input.currentMonthTarget - input.currentMonthApplied))
  const carriedHours = round2h(
    input.carried.reduce((s, c) => s + Math.max(0, c.hoursOutstanding), 0))
  const banked = round2h(Math.max(0, input.bankedHours))
  const catchUpHours = Math.max(0, round2h(currentMonthHours + carriedHours - banked))
  const carriedValue = round2(
    input.carried.reduce((s, c) => s + Math.max(0, c.hoursOutstanding) * c.hourRate, 0))

  const ceiling = daysInMonth(input.currentMonth) * MAX_WORKABLE_HOURS_PER_DAY
  const catchUpPlausible = catchUpHours <= ceiling

  // The carried period closest to the end of its window is the one that bills
  // first. `closesRemaining` is 0 when this coming close is its last.
  const soonest = [...input.carried]
    .filter(c => c.hoursOutstanding > 0)
    .sort((a, b) => a.closesRemaining - b.closesRemaining)[0] ?? null

  return {
    currentMonthHours, carriedHours, catchUpHours, bankedHours: banked,
    carriedValue, catchUpPlausible,
    nextBillingMonth: soonest ? soonest.periodMonth : null,
    summary: summarise({ currentMonthHours, carriedHours, catchUpHours, banked, carriedValue }),
  }
}

function hrs(n: number): string {
  const s = Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0$/, '')
  return `${s} ${n === 1 ? 'hour' : 'hours'}`
}

function summarise(x: {
  currentMonthHours: number; carriedHours: number; catchUpHours: number
  banked: number; carriedValue: number
}): string {
  if (x.currentMonthHours === 0 && x.carriedHours === 0) {
    return x.banked > 0
      ? `You're fully covered, with ${hrs(x.banked)} worked ahead.`
      : `You're fully covered for this month.`
  }
  if (x.carriedHours === 0) {
    const ahead = x.banked > 0 ? ` (${hrs(x.banked)} banked already counts toward it.)` : ''
    return `${hrs(x.currentMonthHours)} covers this month.${ahead}`
  }
  // The case the whole thing exists for: say BOTH numbers, and the total.
  const ahead = x.banked > 0 ? ` ${hrs(x.banked)} banked comes off that.` : ''
  return `${hrs(x.currentMonthHours)} covers this month, and ${hrs(x.carriedHours)} ` +
    `is still owed from earlier — $${x.carriedValue.toFixed(2)} if it isn't worked. ` +
    `${hrs(x.catchUpHours)} in total gets you straight.${ahead}`
}

// ── loading it from the ledger ──────────────────────────────────────────────

import { query, queryOne } from '../db'
import { DateTime } from 'luxon'

/**
 * Assemble the standing for one agreement as of `asOfMonth` (ISO first-of-month;
 * defaults to the current month in Phoenix, which is where the settlement cron
 * runs).
 *
 * The CURRENT month is the period whose invoice is open right now. Anything
 * older that is still open is carried. A period already `settled` or `billed`
 * is finished with and contributes nothing.
 */
export async function loadWorkTradeStanding(
  agreementId: string, asOfMonth?: string,
): Promise<WorkTradeStanding | null> {
  const month = asOfMonth
    ?? DateTime.now().setZone('America/Phoenix').startOf('month').toISODate()!

  const ag = await queryOne<{ banked_hours: string; carry_forward_months: number }>(
    `SELECT banked_hours, carry_forward_months
       FROM work_trade_agreements WHERE id = $1`, [agreementId])
  if (!ag) return null

  const rows = await query<any>(
    `SELECT to_char(period_month,'YYYY-MM-DD') AS period_month,
            target_hours::float  AS target_hours,
            hours_applied::float AS hours_applied,
            hour_rate::float     AS hour_rate,
            -- Closes this period has already survived. Mirrors the settlement
            -- job's derivation exactly so the two can never disagree about when
            -- something bills.
            GREATEST(0, (DATE_PART('year',  $2::date) - DATE_PART('year',  period_month)) * 12
                      + (DATE_PART('month', $2::date) - DATE_PART('month', period_month)) - 1
            )::int AS aged_closes
       FROM work_trade_settlements
      WHERE agreement_id = $1 AND status = 'open' AND period_month <= $2::date
      ORDER BY period_month`,
    [agreementId, month])

  const current = rows.find((r: any) => r.period_month === month)
  const carried: CarriedPeriod[] = rows
    .filter((r: any) => r.period_month !== month)
    .map((r: any) => ({
      periodMonth: r.period_month,
      hoursOutstanding: Math.max(0, round2h(Number(r.target_hours) - Number(r.hours_applied))),
      hourRate: Number(r.hour_rate),
      closesRemaining: Math.max(0,
        Number(ag.carry_forward_months) - Number(r.aged_closes)),
    }))
    .filter(c => c.hoursOutstanding > 0)

  return workTradeStanding({
    currentMonth: month,
    currentMonthTarget: current ? Number(current.target_hours) : 0,
    currentMonthApplied: current ? Number(current.hours_applied) : 0,
    carried,
    bankedHours: Number(ag.banked_hours),
  })
}
