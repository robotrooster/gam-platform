/**
 * LATE, ONE RULE (10/12, Nic) — the lateness rule every money screen and the
 * credit history share. services/openBalances re-exports all of it (it is the
 * one place the platform says who owes what and how late); it lives in this
 * leaf module, which imports nothing of GAM's, so the credit-history emitter
 * (services/creditLedgerEmitters) can use the same rule without an import
 * cycle through openBalances → creditUse → settleHooks → the emitter.
 * 10/12 (Nic): "the payment history should be a health percentage. one mark
 * per invoice." The credit history's marks are now one per bill, judged by the
 * payment-health rule on these same fragments (services/creditBillMarks).
 */
import { FALLBACK_TIMEZONE } from '@gam/shared'

const IDENT = /^[a-z_][a-z0-9_]*$/i
function alias(a: string): string {
  if (!IDENT.test(a)) throw new Error(`lateness: "${a}" is not a table alias`)
  return a
}

/**
 * The note rentCharge and manualPaymentSettle write on the rest of a row that
 * was paid in part (an old balance paid down): that row carries over a bill
 * written earlier, it is not a new one. (Re-exported by creditLedgerEmitters.)
 */
export const PART_PAID_REST_NOTE = 'What is left of the old balance after a part payment'

/**
 * 10/5 (Nic): the note manualPaymentSettle writes on the rest of a bill (rent)
 * a part payment did not cover. The rest is its own open row (is_remainder) on
 * the same bill, so late fees keep applying to it; like the rest of an old
 * balance, it carries over the bill it belongs to, so its on-time or late mark
 * — written the day it is paid, i.e. the day the bill is paid in full — counts
 * from that bill. (Re-exported by creditLedgerEmitters.)
 */
export const PART_PAYMENT_REST_NOTE = 'What is left of this bill after a part payment'

// ─── Late, one rule ───────────────────────────────────────────────────────────
//
// decisions #29: Outstanding shows how late a household is, and the Payments
// ledger says "on time" or "N days late" for each payment, "honoring the grace
// period". THE ONE PLACE the platform decides when a charge is late and by how
// much — the credit history (one mark per bill: services/creditBillMarks, 10/12;
// creditLedgerEmitters.classifyPaymentTier keeps the tiers for old records), the
// Outstanding list, the Payments ledger, the Rent Roll and the tenant report
// (services/householdMonths), the morning delinquency job (jobs/scheduler).
//
// 10/12 (Nic):
//   "First LATE day = due/lateness-start + grace days (rent due the 1st, 5-day
//    grace → the 6th is late, the day late fees start)."
//   "Lateness start = due date, or the day GAM wrote the bill when later."
//   "Grace = lease, else property, else 5 — the only chain."
//   "'Days late' = days past the grace period everywhere."
// So the 1st through the 5th are the grace days, the 6th is the first late day
// (late fees charge at midnight on it: jobs/lateFees, today >= due + grace),
// and a bill paid on the 6th is 1 day past grace. A bill can never be late on
// the day lateness starts: with a grace of 0 the first late day is the day
// after (paying on the due date is on time).
//
// The lateness start is lateCountsFrom (creditLedgerEmitters): a bill cannot be
// paid before GAM wrote it, so a bill written after its due date counts from
// the day it was written — unless it was written after the money came in (a
// record of an older bill: an import, a backfill, the desk writing up a payment
// it took earlier), which counts from its due date. Days are the property's
// calendar days.

/** The grace period when neither the lease nor the property names one (lateFees, creditLedgerEmitters). */
export const DEFAULT_LATE_GRACE_DAYS = 5

/** The grace days of a charge: its lease's, else its property's, else the default. */
export function graceDaysSql(l: string, pr: string): string {
  return `COALESCE(${alias(l)}.late_fee_grace_days, ${alias(pr)}.late_fee_grace_days, ${DEFAULT_LATE_GRACE_DAYS})`
}

/** The same chain in code (a null lease or property grace falls through). */
export function graceDaysOf(leaseGrace: number | null | undefined, propertyGrace: number | null | undefined): number {
  if (leaseGrace != null && Number.isFinite(Number(leaseGrace))) return Number(leaseGrace)
  if (propertyGrace != null && Number.isFinite(Number(propertyGrace))) return Number(propertyGrace)
  return DEFAULT_LATE_GRACE_DAYS
}

/** The property's calendar day of an instant (the property alias may be NULL: GAM's fallback zone). */
export function propertyDaySql(instant: string, pr: string): string {
  return `((${instant}) AT TIME ZONE COALESCE(${alias(pr)}.timezone, '${FALLBACK_TIMEZONE}'))::date`
}

/** The first late day for lateness starting `start` with `grace` days (SQL dates). */
export function firstLateDaySql(start: string, grace: string): string {
  return `((${start}) + GREATEST((${grace})::int, 1))`
}

/** Is `day` on or after the first late day? (the late-fee boundary: the 6th for the 1st with 5 days). */
export function pastGraceSql(day: string, start: string, grace: string): string {
  return `((${day}) >= ${firstLateDaySql(start, grace)})`
}

/**
 * Days past the grace period on `day` for lateness starting `start` with
 * `grace` days: 0 through the last grace day, 1 on the first late day.
 */
export function daysPastGraceSql(day: string, start: string, grace: string): string {
  return `(CASE WHEN ${pastGraceSql(day, start, grace)}
                THEN (${day}) - ${firstLateDaySql(start, grace)} + 1 ELSE 0 END)`
}

/**
 * The day lateness counts from, in SQL (creditLedgerEmitters.lateCountsFrom):
 * the day GAM wrote the bill when that is after its due date and on or before
 * the day it was paid (`paidDay`: today while unpaid); else its due date.
 */
export function lateCountsFromSql(due: string, written: string, paidDay: string): string {
  return `(CASE WHEN (${written}) IS NOT NULL AND (${written}) > (${due}) AND (${written}) <= (${paidDay})
                THEN (${written}) ELSE (${due}) END)`
}

/**
 * 10/12 (Nic): the notes a charge carries while work trade holds it — written
 * when the line is billed suspended (jobs/invoiceGeneration, jobs/moveInBundle,
 * jobs/serviceAgreementInvoices, services/utilityBilling: services/
 * workTradeCoverage WT_SUSPENDED_NOTE) — and the note a line gets when the
 * landlord takes it back out of the trade (workTradeCoverage PUT_BACK_NOTE).
 * Matched as substrings: later notes are appended after them.
 */
export const WORK_TRADE_HELD_NOTE_PARTS = [
  'suspended while the hours are worked',
  'suspended until month close',
  'No longer covered by the work trade',
] as const

/**
 * The moment work trade let go of row `x`, or NULL when it never held it — in
 * SQL. 10/12 (Nic): "Lateness start = due date, or the day GAM wrote the bill
 * when later." A line work trade holds is billed before its due date but owed
 * by nobody (suspended); it becomes a bill the resident can pay only when the
 * month close lowers it to what the hours did not cover and lifts the
 * suspension (jobs/workTradeSettlement creditInvoice, about the 1st of the
 * next month), or when the landlord takes it back out of the trade. Counted
 * from its due date, a lapse paid the day it was billed read "paid late, 27
 * days" — on an invoice that is late_fee_exempt for exactly this reason. So
 * such a line is written when it was released. Every change to a payment is
 * journaled (audit_row_changes, the audit_payments trigger), so the release is
 * on record: the change whose old row was suspended and whose new row is not.
 */
function workTradeReleasedAtSql(x: string): string {
  const held = WORK_TRADE_HELD_NOTE_PARTS.map(n => `${x}.notes LIKE '%${n.replace(/'/g, "''")}%'`).join(' OR ')
  return `(CASE WHEN ${x}.work_trade_suspended_at IS NULL AND (${held})
                THEN (SELECT MAX(wr.changed_at) FROM audit_row_changes wr
                       WHERE wr.table_name = 'payments' AND wr.row_id = ${x}.id
                         AND wr.old_row->>'work_trade_suspended_at' IS NOT NULL
                         AND wr.new_row->>'work_trade_suspended_at' IS NULL) END)`
}

/**
 * When GAM wrote the charge row `p` (a timestamp): its own creation, except a
 * row that carries over an older bill — a row a reversal reopened, or the rest
 * of a row paid in part — counts from the earliest row of the same bill (same
 * lease, person, kind, due date and invoice). A line work trade held counts
 * from when it was released (workTradeReleasedAtSql). The credit history's
 * bill marks read it too (services/creditBillMarks, 10/12).
 */
export function writtenAtSql(p = 'p'): string {
  const x = alias(p)
  // The notes rentCharge / manualPaymentSettle write on the rest of a row paid in part.
  const notes = [PART_PAID_REST_NOTE, PART_PAYMENT_REST_NOTE]
    .map(n => `${x}.notes LIKE '${n.replace(/'/g, "''")}%'`).join(' OR ')
  // GREATEST skips a NULL release: a line work trade never held is written when it was created.
  return `(CASE WHEN ${x}.reversal_id IS NOT NULL OR (${x}.is_remainder AND (${notes}))
                THEN (SELECT MIN(GREATEST(wf.created_at, ${workTradeReleasedAtSql('wf')})) FROM payments wf
                       WHERE wf.lease_id IS NOT DISTINCT FROM ${x}.lease_id
                         AND wf.tenant_id IS NOT DISTINCT FROM ${x}.tenant_id
                         AND wf.type = ${x}.type
                         AND wf.due_date = ${x}.due_date
                         AND wf.invoice_id IS NOT DISTINCT FROM ${x}.invoice_id
                         AND wf.created_at <= ${x}.created_at)
                ELSE GREATEST(${x}.created_at, ${workTradeReleasedAtSql(x)}) END)`
}

/** 'YYYY-MM-DD' → epoch days, for the code versions below. */
function dayNumber(ymd: string): number {
  return Math.round(Date.UTC(Number(ymd.slice(0, 4)), Number(ymd.slice(5, 7)) - 1, Number(ymd.slice(8, 10))) / 86_400_000)
}

/** 'YYYY-MM-DD' plus n days. */
function plusDays(ymd: string, n: number): string {
  return new Date((dayNumber(ymd) + n) * 86_400_000).toISOString().slice(0, 10)
}

/** The first late day in code ('YYYY-MM-DD'): the 6th for lateness starting the 1st with 5 grace days. */
export function firstLateDay(start: string, graceDays: number): string {
  return plusDays(start, Math.max(Math.trunc(graceDays), 1))
}

/** The last grace day: the day before the first late day. */
export function lastGraceDay(start: string, graceDays: number): string {
  return plusDays(firstLateDay(start, graceDays), -1)
}

/** Days past the grace period on `day`, in code: 0 through the last grace day, 1 on the first late day. */
export function daysPastGrace(start: string, day: string, graceDays: number): number {
  const after = dayNumber(day) - dayNumber(lastGraceDay(start, graceDays))
  return after > 0 ? after : 0
}

/**
 * Days late on `day` for lateness starting `start`. 10/12 (Nic): "days late"
 * means days past the grace period everywhere — the Outstanding list, the
 * Payments ledger, the digest — so this is daysPastGraceSql under the name its
 * callers already use.
 */
export function daysLateSql(day: string, start: string, grace: string): string {
  return daysPastGraceSql(day, start, grace)
}

/** The same rule in code, on 'YYYY-MM-DD' calendar days (days past grace). */
export function daysLate(start: string, day: string, graceDays: number): number {
  return daysPastGrace(start, day, graceDays)
}

