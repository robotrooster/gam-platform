// apps/api/src/services/reversalRecovery.ts
//
// S561 (money-flow platform-holds, Phase 3): reversal recovery decision engine.
//
// When a post-settlement reversal opens a receivable against an already-paid
// landlord (services/paymentReversal.ts), GAM must reclaim the reversed RENT
// from that landlord. Two ways:
//   - NETTING: subtract it from the landlord's next Tuesday batch payout. Free,
//     can't bounce, but slower to recover (waits for the influx to arrive).
//   - ACH PULL: directly debit the landlord's bank. Recovers in ~4 business
//     days, but costs a debit + can bounce + is more friction.
//
// DECISION (Nic, S561): look ahead REVERSAL_NETTING_WINDOW_DAYS for GUARANTEED
// lease rent (actual active leases only — never short-term bookings) that FULLY
// COVERS the amount owed. Covering influx in-window → netting; else → ACH pull.
//
// The actual Stripe money movement for an ACH pull (bank debit / transfer
// reversal) is C4/live-gated — this engine makes the DECISION and sets the DB
// state; the netting is applied inside the Tuesday batch, and the ACH-pull
// executor is wired when live keys land.

import { query, queryOne } from '../db'
import { logger } from '../lib/logger'
import { US_FEDERAL_HOLIDAYS } from '../jobs/autoPayouts'

// Hard cap on how long a receivable may sit scheduled-to-net before GAM stops
// waiting. If the anticipated influx never arrives within this window (e.g. the
// tenant didn't pay, the landlord went quiet), the receivable flips to an ACH
// pull so GAM isn't floating it indefinitely. Two weeks (Nic, S561).
export const MAX_NETTING_AGE_DAYS = 14

// Guaranteed-lease lookahead for the net-vs-pull decision. Kept SHORT
// deliberately: netting is always slower to recover than a pull — its only edge
// is being free + bounce-proof — so this window just controls how much EXTRA
// float GAM eats to avoid a pull. Rent due on the 1st doesn't reach GAM until
// the tenant ACH settles (~4 biz days) + the next Tuesday batch, so waiting on
// an influx more than a few days out floats the reversed amount ~2 weeks. 5 ≈
// the ACH-pull completion time: only wait to net when the influx is due about
// as soon as a pull would land anyway. TUNABLE with live payout-timing data
// (like the Tuesday batch-day pin — see gam-money-flow-platform-holds).
export const REVERSAL_NETTING_WINDOW_DAYS = 5

// ── Effective-banking-date helpers ─────────────────────────────────────────
// A rent due date only matters for netting on the day the tenant's ACH can
// actually START processing. Banks don't process ACH on weekends or US federal
// holidays, so a due date on Sat the 1st doesn't move until Mon the 3rd. We
// roll each due date forward to that effective banking day, then test it
// against the window — so a weekend/holiday due date correctly falls OUT of the
// window and we ACH-pull instead of floating on a delayed influx (Nic, S561).

function utcDateOnly(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
}
function addDaysUtc(d: Date, n: number): Date {
  const x = new Date(d); x.setUTCDate(x.getUTCDate() + n); return x
}
function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10)
}
function isBankingDay(d: Date): boolean {
  const dow = d.getUTCDay()               // 0 = Sun … 6 = Sat
  if (dow === 0 || dow === 6) return false
  return !US_FEDERAL_HOLIDAYS.has(isoDate(d))
}
function rollToBankingDay(d: Date): Date {
  let x = d
  while (!isBankingDay(x)) x = addDaysUtc(x, 1)
  return x
}
// The rent_due_day occurrence in the given month, clamped to month length
// (a rent_due_day of 31 → the 30th in a 30-day month, the 28th in Feb).
function clampedDueDate(anchor: Date, monthOffset: number, dueDay: number): Date {
  const y = anchor.getUTCFullYear()
  const m = anchor.getUTCMonth() + monthOffset
  const daysInMonth = new Date(Date.UTC(y, m + 1, 0)).getUTCDate()
  return new Date(Date.UTC(y, m, Math.min(dueDay, daysInMonth)))
}
// True if this lease's next rent due date — rolled forward to its effective
// banking day — falls within [asOf, asOf + windowDays - 1]. Checks this month
// and next month (a ≤ ~7-day window never needs more).
export function effectiveDueWithinWindow(dueDay: number, anchor: Date, windowDays: number): boolean {
  const start = utcDateOnly(anchor)
  const end = addDaysUtc(start, windowDays - 1)
  for (const monthOffset of [0, 1]) {
    const eff = rollToBankingDay(clampedDueDate(start, monthOffset, dueDay))
    if (eff >= start && eff <= end) return true
  }
  return false
}

/**
 * Sum of GUARANTEED lease rent (active leases only) whose next rent due date —
 * measured at its EFFECTIVE BANKING DATE (weekend/holiday-rolled) — falls within
 * `windowDays` of `asOf` (default: today). Short-term bookings/reservations are
 * intentionally excluded: only a signed lease is a legally guaranteed
 * obligation. Month-end due days are clamped.
 */
export async function anticipatedLeaseInflux(
  landlordId: string,
  windowDays: number = REVERSAL_NETTING_WINDOW_DAYS,
  asOf?: string,
): Promise<number> {
  const anchor = asOf ? new Date(asOf + 'T00:00:00Z') : utcDateOnly(new Date())
  const leases = await query<{ rent_amount: string; rent_due_day: number }>(
    `SELECT rent_amount::text AS rent_amount, rent_due_day
       FROM leases
      WHERE landlord_id = $1
        AND status = 'active'
        AND (end_date IS NULL OR end_date >= $2::date)`,
    [landlordId, isoDate(anchor)]
  )
  let sum = 0
  for (const l of leases) {
    if (effectiveDueWithinWindow(l.rent_due_day, anchor, windowDays)) {
      sum += parseFloat(l.rent_amount)
    }
  }
  return Math.round(sum * 100) / 100
}

export interface RecoveryDecision {
  reversalId: string
  method:     'netting' | 'ach_pull'
  needed:     number
  influx:     number
}

/**
 * Decide how to reclaim a single open reversal's rent from the landlord, and
 * stamp the decision. No-op if the reversal is already decided/resolved.
 *   - netting  → recovery_status 'scheduled_netting' (the Tuesday batch nets it)
 *   - ach_pull → recovery_status stays 'pending' with method 'ach_pull' (the
 *                C4 executor performs the actual Stripe bank debit)
 */
export async function decideReversalRecovery(
  reversalId: string,
  asOf?: string,
): Promise<RecoveryDecision | null> {
  const rev = await queryOne<{ landlord_id: string; reversed_amount: string; recovered_amount: string }>(
    `SELECT landlord_id,
            reversed_amount::text  AS reversed_amount,
            recovered_amount::text AS recovered_amount
       FROM payment_reversals
      WHERE id = $1 AND status <> 'resolved'
        AND recovery_status = 'pending' AND recovery_method IS NULL`,
    [reversalId]
  )
  if (!rev) return null

  // GAM reclaims the reversed RENT from the landlord. The reversal fee is the
  // tenant's (billed on the reopened invoice), never clawed from the landlord.
  const needed = parseFloat(rev.reversed_amount) - parseFloat(rev.recovered_amount)
  const influx = await anticipatedLeaseInflux(rev.landlord_id, REVERSAL_NETTING_WINDOW_DAYS, asOf)
  const method: 'netting' | 'ach_pull' = influx >= needed ? 'netting' : 'ach_pull'
  const recoveryStatus = method === 'netting' ? 'scheduled_netting' : 'pending'

  await query(
    `UPDATE payment_reversals
        SET recovery_method = $2, recovery_status = $3, status = 'recovering', updated_at = NOW()
      WHERE id = $1`,
    [reversalId, method, recoveryStatus]
  )
  logger.info({ reversalId, method, needed, influx }, '[reversal_recovery] decided')
  return { reversalId, method, needed, influx }
}

/**
 * Scan freshly-opened reversals awaiting a recovery decision and decide each.
 * Cron entry (runs alongside the daily money jobs).
 */
export async function processPendingReversalRecoveries(): Promise<{ decided: number; netting: number; achPull: number }> {
  const rows = await query<{ id: string }>(
    `SELECT id FROM payment_reversals
      WHERE status <> 'resolved' AND recovery_status = 'pending' AND recovery_method IS NULL`
  )
  let netting = 0, achPull = 0
  for (const row of rows) {
    try {
      const d = await decideReversalRecovery(row.id)
      if (d?.method === 'netting') netting++
      else if (d?.method === 'ach_pull') achPull++
    } catch (e) {
      logger.error({ err: e, reversalId: row.id }, '[reversal_recovery] decision failed')
    }
  }
  return { decided: netting + achPull, netting, achPull }
}

/**
 * 2-week-cap backstop: any receivable that has sat 'scheduled_netting' longer
 * than MAX_NETTING_AGE_DAYS without being netted (its anticipated influx never
 * arrived) flips to an ACH pull so GAM stops floating it. Daily cron.
 */
export async function escalateStaleNetting(maxAgeDays: number = MAX_NETTING_AGE_DAYS): Promise<{ escalated: number }> {
  const rows = await query<{ id: string }>(
    `UPDATE payment_reversals
        SET recovery_method = 'ach_pull', recovery_status = 'pending', updated_at = NOW()
      WHERE status <> 'resolved'
        AND recovery_status = 'scheduled_netting'
        AND created_at < NOW() - make_interval(days => $1)
      RETURNING id`,
    [maxAgeDays]
  )
  for (const r of rows) logger.info({ reversalId: r.id }, '[reversal_recovery] stale netting → ACH pull (2-week cap)')
  return { escalated: rows.length }
}
