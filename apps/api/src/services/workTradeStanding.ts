// S624 — where a work-trade tenant actually stands, in hours.
//
// Nic (S623): the next invoice must state "both the new month's hours owed and
// the hours still owed from the carried balance." A tenant who is told only
// "80 hours" when they actually need 100 to get straight has been told the least
// useful true thing available.
//
// And the landlord's side (Nic, S624): "at some point, a landlord's gonna know
// that somebody's never gonna be able to physically catch up. There's just not
// that many hours in a month." That judgment should not require arithmetic in
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
   *
   * S643 (Nic, DIRECTIVE): NULL for the tenant. "Don't show the tenant any sort
   * of hourly rate — that's when they decide it's not worth it. They're bad at
   * calculation, some people think they're getting three dollars an hour in rent
   * but they forget all the conveniences they get along the way."
   *
   * A dollar figure printed beside an hour count IS an hourly rate; it is one
   * division away. The landlord still gets it — they are pricing an arrangement
   * and need to know what a shortfall is worth.
   */
  carriedValue: number | null
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
  /**
   * 10/12 (Nic): hours worked beyond what a month and any carried shortfall
   * needed — banked or paid, per the agreement. Filled by loadWorkTradeStanding.
   */
  extraHours?: ExtraHoursStanding
}

/** One month's extra hours, as a close recorded them. */
export interface ExtraHoursEntry {
  periodMonth: string
  hours: number
  /** banked — toward future months; paid — paid separately by the landlord. */
  how: 'banked' | 'paid'
  /**
   * PAID extra hours only. Nic, 10/12: the tenant sees the rate and amount for
   * paid EXTRA hours ("6 extra hours × $15 = $90"). Banked hours never carry a
   * dollar figure, and neither do the trade hours (S643).
   */
  rate: number | null
  amount: number | null
  /** PAID extra hours only: unpaid, sent_to_books or paid. */
  status: string | null
}

export interface ExtraHoursStanding {
  /** What this agreement does with extra hours now. */
  mode: 'bank' | 'pay'
  /** Newest first — the last six closes that recorded any. */
  recent: ExtraHoursEntry[]
  /** The newest entry as one sentence, or null when there is none. */
  summary: string | null
}

function monthName(periodMonth: string): string {
  return DateTime.fromISO(periodMonth).toFormat('LLLL')
}

const money = (n: number) => `$${n.toFixed(2)}`

/**
 * "6 extra hours in September — banked" / "6 extra hours in September × $15.00
 * = $90.00 — paid separately by your landlord". The PAID wording names a rate
 * because those hours are wages; it is the only place a work-trade hour is
 * ever priced for the tenant, and it prices only hours beyond the trade.
 */
export function extraHoursSentence(e: ExtraHoursEntry): string {
  const n = Number.isInteger(e.hours) ? String(e.hours) : e.hours.toFixed(2).replace(/0$/, '')
  const h = `${n} extra ${e.hours === 1 ? 'hour' : 'hours'} in ${monthName(e.periodMonth)}`
  if (e.how === 'banked' || e.rate == null || e.amount == null) return `${h} — banked toward future months`
  return `${h} × ${money(e.rate)} = ${money(e.amount)} — paid separately by your landlord`
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
  /** Who is reading. Defaults to the landlord's full view. */
  audience?: 'tenant' | 'landlord'
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

  const forTenant = input.audience === 'tenant'
  return {
    currentMonthHours, carriedHours, catchUpHours, bankedHours: banked,
    carriedValue: forTenant ? null : carriedValue,
    catchUpPlausible,
    nextBillingMonth: soonest && soonest.closesRemaining < Number.MAX_SAFE_INTEGER ? soonest.periodMonth : null,
    summary: summarize({
      currentMonthHours, carriedHours, catchUpHours, banked, carriedValue, forTenant,
    }),
  }
}

function hrs(n: number): string {
  const s = Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0$/, '')
  return `${s} ${n === 1 ? 'hour' : 'hours'}`
}

function summarize(x: {
  currentMonthHours: number; carriedHours: number; catchUpHours: number
  banked: number; carriedValue: number; forTenant?: boolean
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
  // S643: the tenant's version carries no dollar figure. Hours beside dollars is
  // an hourly rate whether or not it is labeled one, and the tenant page's own
  // language is fractions of the bill for exactly that reason. They are still
  // told plainly that an unworked hour becomes a balance — just not priced.
  const cost = x.forTenant ? '' : ` — $${x.carriedValue.toFixed(2)} if it isn't worked`
  return `${hrs(x.currentMonthHours)} covers this month, and ${hrs(x.carriedHours)} ` +
    `is still owed from earlier${cost}. ` +
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
  audience: 'tenant' | 'landlord' = 'landlord',
): Promise<WorkTradeStanding | null> {
  const month = asOfMonth
    ?? DateTime.now().setZone('America/Phoenix').startOf('month').toISODate()!

  const ag = await queryOne<{ banked_hours: string; carry_forward_months: number; carry_forward_indefinite: boolean }>(
    `SELECT banked_hours, carry_forward_months, carry_forward_indefinite
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
      // S652: floated indefinitely — no close ever bills it.
      closesRemaining: ag.carry_forward_indefinite ? Number.MAX_SAFE_INTEGER : Math.max(0,
        Number(ag.carry_forward_months) - Number(r.aged_closes)),
    }))
    .filter(c => c.hoursOutstanding > 0)

  const standing = workTradeStanding({
    currentMonth: month,
    currentMonthTarget: current ? Number(current.target_hours) : 0,
    currentMonthApplied: current ? Number(current.hours_applied) : 0,
    carried,
    bankedHours: Number(ag.banked_hours),
    audience,
  })
  return { ...standing, extraHours: await loadExtraHours(agreementId) }
}

/**
 * 10/12: the extra hours the month closes recorded for this agreement — banked
 * (hours only) and paid (hours, rate, amount). The same for both audiences: the
 * rate shown is the one the landlord pays for EXTRA hours, never what a trade
 * hour is worth, and banked entries carry no money at all.
 */
export async function loadExtraHours(agreementId: string): Promise<ExtraHoursStanding> {
  // A database without the extra-hours migrations has never banked or paid an
  // extra hour: say so, rather than fail the standing (the /standing route and
  // both agents' tools read this).
  if (!(await extraHoursSchemaReady())) return { mode: 'bank', recent: [], summary: null }
  const ag = await queryOne<{ mode: string | null; tracks_hours: boolean }>(
    `SELECT extra_hours_mode AS mode, tracks_hours FROM work_trade_agreements WHERE id = $1`, [agreementId])
  const banked = await query<{ period_month: string; hours: number }>(
    `SELECT to_char(period_month,'YYYY-MM-DD') AS period_month, extra_hours_banked::float AS hours
       FROM work_trade_settlements
      WHERE agreement_id = $1 AND extra_hours_banked > 0
      ORDER BY period_start DESC LIMIT 6`, [agreementId])
  const paid = await query<{ period_month: string; hours: number; rate: number; amount: number; status: string }>(
    `SELECT to_char(period_month,'YYYY-MM-DD') AS period_month, hours::float AS hours,
            rate::float AS rate, amount::float AS amount, status
       FROM work_trade_extra_hours
      WHERE agreement_id = $1
      ORDER BY period_start DESC, created_at DESC LIMIT 6`, [agreementId])
  const recent: ExtraHoursEntry[] = [
    ...banked.map(b => ({ periodMonth: b.period_month, hours: round2h(Number(b.hours)), how: 'banked' as const,
                          rate: null, amount: null, status: null })),
    ...paid.map(p => ({ periodMonth: p.period_month, hours: round2h(Number(p.hours)), how: 'paid' as const,
                        rate: round2(Number(p.rate)), amount: round2(Number(p.amount)), status: p.status })),
  ].sort((a, b) => b.periodMonth.localeCompare(a.periodMonth)).slice(0, 6)
  return {
    mode: ag?.mode === 'pay' && ag.tracks_hours !== false ? 'pay' : 'bank',
    recent,
    summary: recent.length ? extraHoursSentence(recent[0]) : null,
  }
}

let extraHoursSchemaSeen = false

/**
 * 10/12: are the three extra-hours migrations (20261012180000–180200) applied?
 * Migrations reach the live database before the code that needs them
 * (expand, then contract), but a month close and the standing must never stop
 * over a setting if they have not: the close then banks as it always did and
 * writes no extra-hours record, and the standing reports none. Read from the
 * catalog; a yes is remembered (a schema does not lose them), a no is asked
 * again next time.
 */
export async function extraHoursSchemaReady(q: { query: Function } = { query }): Promise<boolean> {
  if (extraHoursSchemaSeen) return true
  const out = await q.query(
    `SELECT (SELECT COUNT(*) FROM information_schema.columns
              WHERE table_schema = 'public'
                AND ((table_name = 'work_trade_agreements'
                      AND column_name IN ('extra_hours_mode', 'extra_hours_rate', 'extra_hours_pay_method'))
                  OR (table_name = 'work_trade_settlements' AND column_name = 'extra_hours_banked'))) = 4
            AND to_regclass('public.work_trade_extra_hours') IS NOT NULL AS ready`, [])
  const rows = Array.isArray(out) ? out : out?.rows ?? []
  extraHoursSchemaSeen = rows[0]?.ready === true
  return extraHoursSchemaSeen
}
