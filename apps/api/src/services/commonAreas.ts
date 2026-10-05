// Common-area reservation core: overlap-conflict detection under an
// advisory lock, so two concurrent approvals for the same area + window
// can't both win. Field validation (hours, length, lead time) lives in the
// route; this module owns the transactional integrity piece.
//
// Also owns reservation-fee charging (#4): the fee is billed on-platform as a
// normal `payments` row (type='fee', fee_type='amenity_fee') the tenant pays
// through the existing Stripe rails — refundable if cancelled 48h+ ahead.
import type { PoolClient } from 'pg'
import { db, getClient, query, queryOne } from '../db'
import { AppError } from '../middleware/errorHandler'
import { lockHousehold } from './moneyPredicates'
import { createAdminNotification } from './adminNotifications'
import { logger } from '../lib/logger'
import { paymentTriedSql } from '../lib/unwindIssuedLease'
import { supersedeScheduledRetry } from './creditUse'

export interface ConflictRow {
  id: string
  title: string | null
  kind: string
  starts_at: string
  ends_at: string
}

// Serialize all writes for one common area. Mirrors the ledger advisory-lock
// idiom (pg_advisory_xact_lock(hashtextextended(key, 0))). Held until the
// caller's transaction commits/rolls back.
export async function lockArea(client: PoolClient, commonAreaId: string): Promise<void> {
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`common_area:${commonAreaId}`])
}

// An APPROVED reservation occupying the same area in an overlapping window
// hard-blocks a new approval. Pending requests do NOT block — the landlord
// adjudicates those; only a live (approved) hold is a true conflict.
// Must run inside the same transaction as lockArea() above.
export async function findApprovedConflict(
  client: PoolClient,
  commonAreaId: string,
  startsAt: string,
  endsAt: string,
  excludeReservationId?: string | null
): Promise<ConflictRow | null> {
  const { rows } = await client.query<ConflictRow>(
    `SELECT id, title, kind, starts_at, ends_at
       FROM common_area_reservations
      WHERE common_area_id = $1
        AND status = 'approved'
        AND ($4::uuid IS NULL OR id <> $4::uuid)
        AND tstzrange(starts_at, ends_at) && tstzrange($2, $3)
      ORDER BY starts_at
      LIMIT 1`,
    [commonAreaId, startsAt, endsAt, excludeReservationId ?? null]
  )
  return rows[0] ?? null
}

// ── Reservation fee (#4) ──────────────────────────────────────────────

const REFUNDABLE_WINDOW_HOURS = 48

// Demand pricing: a weekend (Fri/Sat/Sun) reservation uses weekend_fee when the
// landlord set one; otherwise the flat reservation_fee. Returns a number.
export function computeReservationFee(
  area: { reservation_fee: any; weekend_fee: any },
  startsAt: string | Date
): number {
  const base = Number(area.reservation_fee ?? 0)
  const wknd = area.weekend_fee != null ? Number(area.weekend_fee) : null
  const dow = new Date(startsAt).getDay() // 0 Sun … 6 Sat
  const isWeekend = dow === 0 || dow === 5 || dow === 6
  return isWeekend && wknd != null ? wknd : base
}

// Bill the reservation fee as a tenant payment (on approval / live). Idempotent:
// skips if there's no reserving tenant, no fee, or it's already billed. Charges
// against the tenant's active lease at the reservation's property.
export async function billReservationFee(reservationId: string): Promise<string | null> {
  const r = await queryOne<any>(
    `SELECT id, reserved_by_tenant_id, property_id, landlord_id, fee_amount, fee_payment_id
       FROM common_area_reservations WHERE id = $1`, [reservationId])
  if (!r || !r.reserved_by_tenant_id || Number(r.fee_amount) <= 0 || r.fee_payment_id) return null

  // The tenant's active lease + unit at this property (where to attach the charge).
  const lease = await queryOne<{ lease_id: string; unit_id: string }>(
    `SELECT l.id AS lease_id, u.id AS unit_id
       FROM v_lease_active_tenants vlat
       JOIN leases l ON l.id = vlat.lease_id AND l.status = 'active'
       JOIN units  u ON u.id = l.unit_id
      WHERE vlat.tenant_id = $1 AND u.property_id = $2
      LIMIT 1`, [r.reserved_by_tenant_id, r.property_id])
  if (!lease) return null // not a resident at this property — can't bill

  const { createLeaseFeePayment } = await import('./leaseFees')
  const res = await createLeaseFeePayment({
    landlordId: r.landlord_id, tenantId: r.reserved_by_tenant_id,
    leaseId: lease.lease_id, unitId: lease.unit_id,
    feeType: 'amenity_fee' as any, amount: Number(r.fee_amount),
    description: 'Amenity reservation fee', source: 'amenity',
  })
  await query(`UPDATE common_area_reservations SET fee_payment_id = $2 WHERE id = $1`, [reservationId, res.paymentId])
  return res.paymentId
}

/** Why a reservation fee a payment had touched was voided (payments.void_reason). */
export const RESERVATION_FEE_VOID_REASON =
  'The reservation it was for was canceled or released, so the fee is no longer owed.'

/**
 * What became of a reservation's fee when the reservation went away.
 * 'waiting': a payment carrying the fee was still going through at the cancel
 * (decisions #52) — nothing is decided, said or flagged yet; the hourly sweep
 * (decideWaitingReservationFee) decides once that payment clears or fails for
 * good.
 */
export type ReservationFeeOutcome = 'none' | 'voided' | 'kept' | 'refund_due' | 'fee_stands' | 'waiting'

/**
 * Why a fee nobody owes any more had to stay on the tenant's account
 * (outcome 'kept'), read fresh by reservationFeeKeptWhy:
 *   credit_spent   account credit was already spent on it (a voided charge
 *                  carries no spent credit — trg_payments_voided_is_a_record);
 *   shared_retry   a bank retry still to come carries it TOGETHER with other
 *                  charges the household owes (their rent): voiding it would
 *                  make services/achRetry drop the whole retry (a line paid
 *                  another way), so the household would lose its rent retry
 *                  to a reservation. The retry is left to run;
 *   payment_moving a card or bank payment on it may still be going through;
 *   disputed       a dispute or bank return took its money back and what it
 *                  reopened cannot simply be voided (none yet, or only part).
 */
export const RESERVATION_FEE_KEPT_WHY = ['credit_spent', 'shared_retry', 'payment_moving', 'disputed'] as const
export type ReservationFeeKeptWhy = typeof RESERVATION_FEE_KEPT_WHY[number]

const PAID_STATUS_LIST = ['settled', 'processing', 'paid_via_deposit'] as const
const PAID_STATUSES = new Set<string>(PAID_STATUS_LIST)

/**
 * Every payments row in the dispute chain of the reservation fee whose
 * payments.id is `feeIdRef` (a SQL expression), the fee itself included — as
 * a recursive CTE named `name` with one column, id. A dispute or bank return
 * that took a row's money back leaves that row 'returned' and reopens what is
 * owed again as a new row (payments.reversal_id → payment_reversals.payment_id
 * = the returned row); that reopened row, paid again, can itself be disputed,
 * and so on. The chain walks every level, so a fee disputed twice and paid a
 * third time reads as paid (a one-level read saw only the second, 'returned'
 * row, and released a paid event with the tenant's money kept).
 */
function feeChainCte(feeIdRef: string, name: string): string {
  return `WITH RECURSIVE ${name}(id) AS (
            SELECT (${feeIdRef})::uuid
            UNION
            SELECT ${name}_n.id
              FROM ${name}
              JOIN payments ${name}_p ON ${name}_p.id = ${name}.id AND ${name}_p.status = 'returned'
              JOIN payment_reversals ${name}_r ON ${name}_r.payment_id = ${name}.id
              JOIN payments ${name}_n ON ${name}_n.reversal_id = ${name}_r.id)`
}

/**
 * The reservation fee whose payments.id is `feeIdRef` (a SQL expression) is
 * paid — as SQL, the one definition every reader of "is this reservation's
 * fee paid?" shares (voidUnpaidReservationFee reads it the same way in TS):
 * the fee row is in `statuses`, or a dispute or bank return took its money
 * back (the fee row is 'returned') and a row that dispute reopened — at any
 * depth of the chain (feeChainCte) — was paid again. Without the chain an
 * event deposit the tenant paid again after a dispute reads as unpaid: it is
 * never announced and is released at its start time. `statuses` defaults to
 * paid or clearing or paid from the deposit; the announcement passes
 * ['settled'] (only money that has arrived announces an event).
 */
export function reservationFeePaidSql(
  feeIdRef: string, statuses: readonly string[] = PAID_STATUS_LIST,
): string {
  const list = statuses.map(st => `'${st.replace(/'/g, "''")}'`).join(',')
  return `EXISTS (${feeChainCte(feeIdRef, 'rfc')}
                  SELECT 1 FROM rfc JOIN payments rf ON rf.id = rfc.id
                   WHERE rf.status IN (${list}))`
}

/**
 * A bank retry still to come carries payments row `p` (SQL over the alias):
 * its pull bounced and services/achRetry will try it again (a row of that
 * pull is 'failed' with next_retry_at set and retries left). decisions #46.1b:
 * a scheduled bank retry is a payment in flight.
 */
const retryToComeSql = (p: string) => `(${p}.status = 'failed' AND ${p}.stripe_payment_intent_id IS NOT NULL
   AND EXISTS (SELECT 1 FROM payments rtc
                WHERE rtc.stripe_payment_intent_id = ${p}.stripe_payment_intent_id
                  AND rtc.status = 'failed' AND rtc.next_retry_at IS NOT NULL
                  AND COALESCE(rtc.retry_count, 0) < 2))`

/**
 * A payment carrying the reservation fee whose payments.id is `feeIdRef` (a
 * SQL expression) is still in flight — as SQL, over the same chain as
 * reservationFeePaidSql (the fee, or any row a dispute reopened on it):
 *   - a row is 'pending' with a card or bank payment already started on it
 *     (stripe_payment_intent_id) — what openBalances.inFlightRowSql counts as
 *     clearing: not owed, not yet paid; or
 *   - a bank retry still to come carries a row (retryToComeSql) — alone, or
 *     bundled with the household's rent (decisions #52, #46.1b).
 * The hourly event sweep never releases an event in this state: it is
 * decided on a later run, once that payment clears (paid — the event is
 * kept) or fails for good (the event is released and the fee voided).
 */
export function reservationFeeMovingSql(feeIdRef: string): string {
  return `EXISTS (${feeChainCte(feeIdRef, 'rmc')}
                  SELECT 1 FROM rmc JOIN payments rm ON rm.id = rmc.id
                   WHERE (rm.status = 'pending' AND rm.stripe_payment_intent_id IS NOT NULL)
                      OR ${retryToComeSql('rm')})`
}

/** Why an event's deposit was not paid when the sweep released it — the tenant is told this, in these words. */
export type EventDepositUnpaidHow = 'taken_back' | 'did_not_go_through' | 'not_paid'

/**
 * Why the reservation fee whose payments.id is `feeIdRef` (a SQL expression)
 * is unpaid, as SQL text over the same chain as reservationFeePaidSql — read
 * BEFORE the release voids it:
 *   'did_not_go_through'  the NEWEST row of the chain (its live end: the
 *                         bill still owed) failed for good — a bounced pull
 *                         with no retry left (decisions #52: the sweep waits
 *                         for the retries, so a release can come days after
 *                         the start). Said first, because it is the latest
 *                         thing that happened: a deposit a dispute took back
 *                         whose reopened bill then bounced is told its
 *                         payment did not go through;
 *   'taken_back'          a dispute or bank return took a payment of it back
 *                         and nothing tried since failed (the reopened bill
 *                         is still owed with nothing tried, or was voided);
 *   'did_not_go_through'  (also) an older row failed with no dispute after it;
 *   'not_paid'            nothing was ever tried.
 * The chain carries its depth so "newest" is the row a dispute reopened last
 * (every reopened row is created after the row it replaces).
 */
export function reservationFeeUnpaidHowSql(feeIdRef: string): string {
  return `(WITH RECURSIVE ruh(id, depth) AS (
             SELECT (${feeIdRef})::uuid, 0
             UNION
             SELECT ruh_n.id, ruh.depth + 1 FROM ruh
               JOIN payments ruh_p ON ruh_p.id = ruh.id AND ruh_p.status = 'returned'
               JOIN payment_reversals ruh_r ON ruh_r.payment_id = ruh.id
               JOIN payments ruh_n ON ruh_n.reversal_id = ruh_r.id
              WHERE ruh.depth < 50)
           SELECT CASE
                    WHEN bool_or(p.status = 'failed' AND ruh.depth = (SELECT max(depth) FROM ruh)) THEN 'did_not_go_through'
                    WHEN bool_or(p.status = 'returned') THEN 'taken_back'
                    WHEN bool_or(p.status = 'failed') THEN 'did_not_go_through'
                    ELSE 'not_paid' END
             FROM ruh JOIN payments p ON p.id = ruh.id)`
}

/**
 * The tenant's notice when the hourly sweep releases their private event
 * (jobs/scheduler processTenantEvents). It says why in plain words — a release
 * can come days after the start (decisions #52: a payment in flight is waited
 * for), so "not paid by the start time" is not always the truth — and says the
 * space is open to everyone only while the event's time has not passed yet.
 */
export function eventReleasedNotice(a: {
  areaName: string; how: EventDepositUnpaidHow; endsAt: string | Date; now?: Date
}): string {
  const why = a.how === 'taken_back'
    ? 'the payment for its deposit was taken back by a dispute or bank return'
    : a.how === 'did_not_go_through'
      ? 'the payment for its deposit did not go through'
      : 'the deposit wasn’t paid by the start time'
  const over = new Date(a.endsAt).getTime() <= (a.now ?? new Date()).getTime()
  return `Your private event at ${a.areaName} was released because ${why}.`
    + (over ? '' : ' The space is open to everyone as usual.')
}

/**
 * Take an unpaid reservation fee off the tenant's bill, inside the caller's
 * transaction (S655 money plan Step 7). The fee is household money, so this
 * takes the household lock (re-entrant — a caller that already holds it loses
 * nothing) and reads the charge fresh under it:
 *   'paid'   settled, clearing or paid from the deposit — the caller decides
 *            (a refund due, or a deposit that stands);
 *   'voided' owed, so it comes off and the reservation is marked fee_voided:
 *            nothing was ever tried on it → it was never charged, and the row
 *            is removed; a payment WAS tried on it (paymentTriedSql, the one
 *            definition in lib/unwindIssuedLease) → receipts and return logs
 *            point at it, so the row is kept as a record with status
 *            'voided' (decisions #48.5): owed by nobody, paid by nothing, in
 *            no balance, never deleted;
 *   'kept'   owed, but it cannot come off here (ReservationFeeKeptWhy): it
 *            stays, and the caller tells GAM after its commit
 *            (alertReservationFeeKept);
 *   'none'   no fee.
 * A credit use given back earlier (released) is not a record: its row is
 * removed and the use keeps its history with no target (credit_uses FK).
 *
 * A FEE A DISPUTE TOOK BACK. When a dispute or bank return took the fee's
 * money back, the fee row is the 'returned' record and what is owed again is
 * the row the dispute reopened (payments.reversal_id → payment_reversals
 * .payment_id = the fee). That reopened row is what goes: re-paid → 'paid';
 * still owed → voided as a record the same way (it carries reversal_id, so
 * it is always a record); already voided by another path → it counts as gone,
 * and when every reopened row is voided the outcome is 'voided' (never a
 * 'disputed' keep with nothing owed). The landlord's recovery of the disputed money is
 * the reversal's own business and is not touched.
 *
 * A VOIDED FEE'S BANK RETRY (money plan Step 7: supersedeScheduledRetry before
 * the fee goes). A bank retry still to come on it is stopped when that pull
 * carries nothing else still owed: its schedule is cleared, anything it set
 * aside is given back ('superseded'), and its intent id is pushed onto `stop`
 * for the caller to cancel after COMMIT (creditUse.cancelSupersededIntents).
 * A retry still to come that ALSO carries other charges the household owes
 * (their rent) keeps the fee 'kept' (shared_retry) and is left to run — no
 * rent retry is lost to a reservation (the rule lib/unwindIssuedLease's
 * stopRetriesForChargesTheVoidRemoves follows too). `stop` is optional;
 * without it nothing is stopped.
 */
export async function voidUnpaidReservationFee(
  client: PoolClient,
  r: { id: string; fee_payment_id: string | null; reserved_by_tenant_id: string | null; landlord_id: string },
  stop?: string[],
): Promise<'none' | 'voided' | 'kept' | 'paid'> {
  if (!r.fee_payment_id) return 'none'
  if (r.reserved_by_tenant_id) await lockHousehold(client, r.reserved_by_tenant_id, r.landlord_id)
  const pay = (await client.query<{ status: string; amount: string }>(
    `SELECT p.status, p.amount::text AS amount FROM payments p WHERE p.id = $1 FOR UPDATE OF p`, [r.fee_payment_id])).rows[0]
  if (!pay) return 'none'
  if (PAID_STATUSES.has(pay.status)) return 'paid'
  if (pay.status === 'voided') return markFeeVoided(client, r.id)
  if (pay.status === 'returned') {
    // Every row the dispute (and any later dispute of a re-paid row) reopened.
    const reopened = await reopenedRows(client, r.fee_payment_id, true)
    if (reopened.some(n => PAID_STATUSES.has(n.status))) return 'paid'
    const sum = (rows: typeof reopened) => cents(rows.reduce((s, n) => s + Number(n.amount), 0))
    // Each 'returned' row (the fee, or a reopened row disputed in its turn)
    // must have been reopened in full. Nothing reopened yet, or only part
    // (the rest is still paid and would need a refund): GAM sorts it out.
    const returned = [{ id: r.fee_payment_id, amount: pay.amount }, ...reopened.filter(n => n.status === 'returned')]
    for (const node of returned) {
      const kids = reopened.filter(n => n.parent_id === node.id
        && ['pending', 'failed', 'voided', 'returned'].includes(n.status))
      if (kids.length === 0 || sum(kids) < cents(Number(node.amount))) return 'kept'
    }
    const leaves = reopened.filter(n => n.status !== 'returned')
    const owed = leaves.filter(n => n.status === 'pending' || n.status === 'failed')
    // A reopened row some other path already voided is owed by nobody: it
    // counts toward the fee being gone, never toward a 'disputed' keep. Any
    // other end state (not owed, not paid, not voided) is GAM's to sort out.
    if (leaves.some(n => !['pending', 'failed', 'voided'].includes(n.status))) return 'kept'
    // Everything the dispute reopened is already voided: nothing is owed and
    // there is nothing to tell anyone about.
    if (owed.length === 0) return markFeeVoided(client, r.id)
    let out: 'voided' | 'kept' = 'voided'
    for (const n of owed) {
      if (await voidOwedRow(client, r.id, n.id, stop, { canDelete: false, keepPointer: true }) === 'kept') out = 'kept'
    }
    return out
  }
  if (pay.status !== 'pending' && pay.status !== 'failed') return 'kept'
  return voidOwedRow(client, r.id, r.fee_payment_id, stop, { canDelete: true, keepPointer: false })
}

const cents = (d: number) => Math.round(d * 100)

/**
 * The fee is already voided (on its own row, or on every row a dispute
 * reopened) by some other path: the reservation is marked fee_voided the same
 * way voidAsRecord marks it, and the outcome is 'voided'.
 */
async function markFeeVoided(client: PoolClient, reservationId: string): Promise<'voided'> {
  await client.query(
    `UPDATE common_area_reservations SET fee_voided = true, updated_at = now() WHERE id = $1 AND fee_voided IS NOT TRUE`,
    [reservationId])
  return 'voided'
}

/**
 * Every row a dispute or bank return of `paymentId` reopened
 * (payments.reversal_id), and — when a reopened row was paid again and then
 * disputed in its turn ('returned') — every row THAT reopened, at any depth.
 * parent_id is the 'returned' row each was reopened from.
 */
async function reopenedRows(
  q: { query: (sql: string, params?: any[]) => Promise<{ rows: any[] }> }, paymentId: string, lock: boolean,
): Promise<Array<{ id: string; status: string; amount: string; parent_id: string }>> {
  return (await q.query(
    `WITH RECURSIVE chain(id, parent_id) AS (
       SELECT n.id, pr.payment_id
         FROM payments n JOIN payment_reversals pr ON pr.id = n.reversal_id
        WHERE pr.payment_id = $1
       UNION
       SELECT n.id, pr.payment_id
         FROM chain c
         JOIN payments cp ON cp.id = c.id AND cp.status = 'returned'
         JOIN payment_reversals pr ON pr.payment_id = c.id
         JOIN payments n ON n.reversal_id = pr.id)
     SELECT n.id, n.status, n.amount::text AS amount, c.parent_id
       FROM chain c JOIN payments n ON n.id = c.id
      ORDER BY n.id${lock ? ' FOR UPDATE OF n' : ''}`, [paymentId])).rows
}

/**
 * The scheduled bank retry of `paymentId` still to come carries other charges
 * still owed by that pull — the pull services/achRetry would drop whole once
 * this row is voided (a line paid another way). As SQL over payments `p`.
 * "A retry still to come" is retryToComeSql — the one definition the sweep's
 * scan uses too — so "in flight" and "shared retry" never disagree (a row
 * with next_retry_at set but no retries left is neither).
 */
const SHARED_RETRY_TO_COME_SQL = `(${retryToComeSql('p')}
   AND EXISTS (SELECT 1 FROM payments o
                WHERE o.stripe_payment_intent_id = p.stripe_payment_intent_id AND o.id <> p.id
                  AND o.status IN ('pending','processing','failed')))`

/**
 * One owed row of a reservation fee (the fee itself, or the row a dispute
 * reopened) comes off — removed when nothing was ever tried on it and
 * `canDelete`, else voided as a record — or is 'kept' (ReservationFeeKeptWhy).
 * The caller holds the household lock.
 */
async function voidOwedRow(
  client: PoolClient, reservationId: string, paymentId: string, stop: string[] | undefined,
  o: { canDelete: boolean; keepPointer: boolean },
): Promise<'voided' | 'kept'> {
  const row = (await client.query<{ status: string; tried: boolean; moving: boolean; shared: boolean }>(
    `SELECT p.status, ${paymentTriedSql('p')} AS tried,
            (p.status = 'pending' AND p.stripe_payment_intent_id IS NOT NULL) AS moving,
            ${SHARED_RETRY_TO_COME_SQL} AS shared
       FROM payments p WHERE p.id = $1 FOR UPDATE OF p`, [paymentId])).rows[0]
  if (!row || (row.status !== 'pending' && row.status !== 'failed')) return 'kept'
  // A payment on it may still be going through, or a retry still to come
  // carries the household's other charges with it: left as it is.
  if (row.moving || row.shared) return 'kept'
  if (row.tried || !o.canDelete) {
    if (stop && row.status === 'failed') stop.push(...await stopRetryOfFeeAlone(client, paymentId))
    return voidAsRecord(client, reservationId, paymentId)
  }
  // Its own savepoint: a record this list does not know about keeps the row
  // instead of rolling back the cancel with it — and then it is voided as a
  // record instead (decisions #48.5), never left owed.
  await client.query('SAVEPOINT reservation_fee_void')
  try {
    await client.query(`DELETE FROM payments WHERE id = $1 AND status IN ('pending','failed')`, [paymentId])
    await client.query('RELEASE SAVEPOINT reservation_fee_void')
  } catch (e) {
    await client.query('ROLLBACK TO SAVEPOINT reservation_fee_void')
    logger.warn({ err: e, reservationId, paymentId }, '[common-areas] unpaid fee could not be removed — voided as a record')
    return voidAsRecord(client, reservationId, paymentId)
  }
  await client.query(
    `UPDATE common_area_reservations SET fee_voided = true, fee_payment_id = NULL, updated_at = now() WHERE id = $1`,
    [reservationId])
  return 'voided'
}

async function creditSpentOn(client: PoolClient, paymentId: string): Promise<boolean> {
  return (await client.query(
    `SELECT 1 FROM credit_uses WHERE payment_id = $1 AND status = 'applied' LIMIT 1`, [paymentId])).rows.length > 0
}

/**
 * decisions #48.5: a charge nobody owes that a payment touched (or that a
 * record points at) is voided in a recorded way — status 'voided', stamped
 * with when and why, kept forever, in no balance (every balance reads
 * pending/failed). The reservation keeps pointing at its fee (fee_payment_id)
 * and is marked fee_voided. Credit already SPENT on it cannot ride on a voided
 * charge (trg_payments_voided_is_a_record): that fee is 'kept' for GAM to
 * sort out with the landlord. The caller holds the household lock and the row.
 */
async function voidAsRecord(client: PoolClient, reservationId: string, paymentId: string): Promise<'voided' | 'kept'> {
  if (await creditSpentOn(client, paymentId)) return 'kept'
  const done = await client.query(
    `UPDATE payments
        SET status = 'voided', voided_at = now(), void_reason = $2, next_retry_at = NULL
      WHERE id = $1 AND status IN ('pending','failed')`,
    [paymentId, RESERVATION_FEE_VOID_REASON])
  if ((done.rowCount ?? 0) !== 1) return 'kept'
  await client.query(
    `UPDATE common_area_reservations SET fee_voided = true, updated_at = now() WHERE id = $1`, [reservationId])
  return 'voided'
}

/**
 * The scheduled bank retry of a fee nobody owes any more, stopped — only when
 * that bank pull carries nothing else still owed (see voidUnpaidReservationFee).
 * Returns the intent ids to cancel after COMMIT; [] when there is nothing to stop.
 */
async function stopRetryOfFeeAlone(client: PoolClient, paymentId: string): Promise<string[]> {
  const alone = (await client.query<{ alone: boolean }>(
    `SELECT NOT EXISTS (SELECT 1 FROM payments o
                         WHERE o.stripe_payment_intent_id = p.stripe_payment_intent_id AND o.id <> p.id
                           AND o.status IN ('pending','processing','failed')) AS alone
       FROM payments p
      WHERE p.id = $1 AND p.status = 'failed' AND p.stripe_payment_intent_id IS NOT NULL`, [paymentId])).rows[0]
  if (!alone?.alone) return []
  return (await supersedeScheduledRetry(client, [paymentId])).cancelAfterCommit
}

/**
 * Why a reservation fee is still on the tenant's account after the
 * reservation went away (outcome 'kept'), read fresh — after the caller's
 * COMMIT, so GAM's alert and the tenant's notice say what is true now. The
 * fee row, or the row a dispute reopened on it. Null when none of the reasons
 * holds any more.
 */
export async function reservationFeeKeptWhy(paymentId: string | null): Promise<ReservationFeeKeptWhy | null> {
  if (!paymentId) return null
  const fee = await queryOne<{ status: string }>(`SELECT status FROM payments WHERE id = $1`, [paymentId])
  if (!fee) return null
  const ids = fee.status === 'returned'
    ? (await reopenedRows(db, paymentId, false))
        .filter(n => n.status === 'pending' || n.status === 'failed').map(n => n.id)  // the live end of the chain
    : [paymentId]
  if (ids.length === 0) return fee.status === 'returned' ? 'disputed' : null
  const r = await queryOne<{ credit: boolean; shared: boolean; moving: boolean }>(
    `SELECT bool_or(EXISTS (SELECT 1 FROM credit_uses u WHERE u.payment_id = p.id AND u.status = 'applied')) AS credit,
            bool_or(${SHARED_RETRY_TO_COME_SQL}) AS shared,
            bool_or(p.status = 'pending' AND p.stripe_payment_intent_id IS NOT NULL) AS moving
       FROM payments p WHERE p.id = ANY($1::uuid[])`, [ids])
  if (r?.credit) return 'credit_spent'
  if (r?.shared) return 'shared_retry'
  if (r?.moving) return 'payment_moving'
  return fee.status === 'returned' ? 'disputed' : null
}

/**
 * A canceled reservation whose fee is still being paid (decisions #52) waits.
 * What will happen is recorded on the reservation's decision_note, AFTER the
 * note the landlord typed when deciding it (never over it), as a stable key
 * (RESERVATION_FEE_WAIT_KEY) followed by plain words. The sweep finds and reads
 * a waiting fee by the KEY only, never by the words, so rewording a note in a
 * later deploy never orphans a fee already waiting. (A dedicated column would
 * be cleaner; that needs a migration this pass does not add.) The words:
 *   refund  a fee that is refundable (a reservation canceled 48 hours or more
 *           ahead, or an event deposit that was unpaid at the cancel and rides
 *           a bank retry shared with the rent): if the payment goes through,
 *           the landlord is told to refund it; if it fails, it is taken off;
 *   stands  an event deposit the tenant was paying at the cancel (event
 *           deposits are not refunded once paid): if the payment goes
 *           through, it stands; if it fails, it is taken off.
 */
export const RESERVATION_FEE_WAIT_NOTE = {
  refund: 'Canceled while a payment for its fee was still going through. If that payment goes through, the fee is to be refunded; if it fails, the fee is taken off.',
  stands: 'Canceled while a payment for its event deposit was still going through. If that payment goes through, the deposit stands; if it fails, the deposit is taken off.',
} as const
/**
 * The same wait words for a private event, whose fee is its deposit (fix pass
 * 2, review LOW: the record said "fee" and "deposit" for the same money). The
 * KEY is the same either way, so the sweep never depends on these words.
 */
export const RESERVATION_DEPOSIT_WAIT_NOTE: Record<keyof typeof RESERVATION_FEE_WAIT_NOTE, string> = {
  refund: 'Canceled while a payment for its event deposit was still going through. If that payment goes through, the deposit is to be refunded; if it fails, the deposit is taken off.',
  stands: RESERVATION_FEE_WAIT_NOTE.stands,
}
/** What a reservation's fee is called: an event's is its deposit (reservation kind 'event'). */
export const reservationFeeWord = (kind: string | null | undefined): 'fee' | 'deposit' =>
  kind === 'event' ? 'deposit' : 'fee'
/**
 * The stable key of a waiting fee's policy on decision_note. Never reworded:
 * the sweep (reservationFeesWaiting, decideWaitingReservationFee) matches it.
 */
export const RESERVATION_FEE_WAIT_KEY = {
  refund: '[fee_wait:refund]',
  stands: '[fee_wait:stands]',
} as const
/** The wait line markFeeWaiting adds after the landlord's note: the key, then the words. */
export const reservationFeeWaitLine = (how: keyof typeof RESERVATION_FEE_WAIT_KEY, kind?: string | null): string =>
  `${RESERVATION_FEE_WAIT_KEY[how]} ${(reservationFeeWord(kind) === 'deposit' ? RESERVATION_DEPOSIT_WAIT_NOTE : RESERVATION_FEE_WAIT_NOTE)[how]}`
/** `add` after `note` (the landlord's), a blank line between; `add` alone when there is no note. */
export const withNote = (note: string | null | undefined, add: string): string =>
  note && note.trim() ? `${note.trimEnd()}\n\n${add}` : add
/**
 * Which policy a decision_note's wait line records, and the note without that
 * wait line (the landlord's own words, or null). how=null: nothing is waiting.
 *
 * Fix pass 1 (review LOW): the wait line is only ever the note's LAST
 * paragraph (markFeeWaiting writes it after a blank line, or alone), so a key
 * counts only where it STARTS that last paragraph — never a key anywhere in
 * the free text. A landlord's own note that happened to contain one (typed on
 * the decide screen or through the assistant) used to make a canceled
 * reservation read as waiting: a fee that should stand could be flagged for a
 * refund, and with the key surviving in `before`, decided again every hour.
 * reservationFeesWaiting finds rows by the same rule (FEE_WAIT_LAST_PARAGRAPH_RE).
 */
export function readFeeWait(note: string | null | undefined): { how: keyof typeof RESERVATION_FEE_WAIT_KEY | null; before: string | null } {
  if (!note) return { how: null, before: note ?? null }
  const cut = note.lastIndexOf('\n\n')
  const last = cut >= 0 ? note.slice(cut + 2) : note
  const how = (Object.keys(RESERVATION_FEE_WAIT_KEY) as Array<keyof typeof RESERVATION_FEE_WAIT_KEY>)
    .find(k => last.startsWith(RESERVATION_FEE_WAIT_KEY[k])) ?? null
  if (!how) return { how: null, before: note }
  const before = (cut >= 0 ? note.slice(0, cut) : '').trimEnd()
  return { how, before: before || null }
}
/**
 * The same rule as readFeeWait, as a PostgreSQL regular expression (an ARE):
 * a key at the start of the note or right after a blank line, with no blank
 * line after it to the end of the note. Built from RESERVATION_FEE_WAIT_KEY,
 * so the keys have one definition.
 */
const escapeRe = (t: string): string => t.replace(/[.*+?^$(){}|[\]\\]/g, '\\$&')
export const FEE_WAIT_LAST_PARAGRAPH_RE: string =
  '(^|\n\n)(' + Object.values(RESERVATION_FEE_WAIT_KEY).map(escapeRe).join('|') + ')((?!\n\n).)*$'
/**
 * A note a landlord typed (deciding a reservation on the page or through the
 * assistant), with anything that reads as a waiting-fee key neutralized — the
 * key is GAM's own record, never the landlord's words. "[fee_wait:" becomes
 * "(fee_wait:"; nothing else changes.
 */
export function landlordDecisionNote(note: string | null | undefined): string | null {
  if (note == null) return null
  return note.split('[fee_wait:').join('(fee_wait:')
}
/** The note once a waiting fee is decided (it replaces the wait line, so the sweep decides it once). */
export const RESERVATION_FEE_DECIDED_NOTE = {
  refund_due: 'Canceled. The payment for its fee went through after the cancel, so the fee is to be refunded.',
  stands: 'Canceled. The payment for its event deposit went through after the cancel, so the deposit stands.',
  voided: 'Canceled. The payment for its fee did not go through, so the fee was taken off.',
  // Fix pass 1 (review LOW): the payment went through and a dispute or bank
  // return then took it back before the sweep decided it — "did not go
  // through" was untrue (reservationFeeUnpaidHowSql 'taken_back').
  voided_taken_back: 'Canceled. The payment for its fee was taken back by a dispute or bank return, so the fee was taken off.',
  kept: 'Canceled. The payment for its fee did not go through, or was taken back, and the fee could not be taken off; GAM was told.',
} as const
/** The same decided words for a private event, whose fee is its deposit (fix pass 2, review LOW). */
export const RESERVATION_DEPOSIT_DECIDED_NOTE: Record<keyof typeof RESERVATION_FEE_DECIDED_NOTE, string> = {
  refund_due: 'Canceled. The payment for its event deposit went through after the cancel, so the deposit is to be refunded.',
  stands: RESERVATION_FEE_DECIDED_NOTE.stands,
  voided: 'Canceled. The payment for its event deposit did not go through, so the deposit was taken off.',
  voided_taken_back: 'Canceled. The payment for its event deposit was taken back by a dispute or bank return, so the deposit was taken off.',
  kept: 'Canceled. The payment for its event deposit did not go through, or was taken back, and the deposit could not be taken off; GAM was told.',
}
/** The decided words for a reservation of `kind` (an event's say "deposit"). */
export const reservationFeeDecidedNote = (key: keyof typeof RESERVATION_FEE_DECIDED_NOTE, kind: string | null | undefined): string =>
  (reservationFeeWord(kind) === 'deposit' ? RESERVATION_DEPOSIT_DECIDED_NOTE : RESERVATION_FEE_DECIDED_NOTE)[key]

/**
 * Is a payment carrying the reservation fee `feePaymentId` (or a row a dispute
 * reopened on it) still going through, so the fee cannot be decided yet?
 *   'clearing'      a card or bank payment on it is clearing ('processing') or
 *                   started and not yet answered (pending with an intent);
 *   'shared_retry'  it bounced, and a bank retry still to come carries it
 *                   together with other charges the household owes (stopping
 *                   it would drop their rent retry);
 *   null            nothing in flight (a retry of the fee ALONE is not a
 *                   reason to wait: the cancel stops it and takes the fee off).
 * The caller holds the household lock.
 */
export async function reservationFeeInFlight(
  client: PoolClient, feePaymentId: string | null,
): Promise<'clearing' | 'shared_retry' | null> {
  if (!feePaymentId) return null
  const r = (await client.query<{ clearing: boolean | null; shared: boolean | null }>(
    `${feeChainCte('$1::uuid', 'rif')}
     SELECT bool_or(p.status = 'processing' OR (p.status = 'pending' AND p.stripe_payment_intent_id IS NOT NULL)) AS clearing,
            bool_or(${SHARED_RETRY_TO_COME_SQL}) AS shared
       FROM rif JOIN payments p ON p.id = rif.id`, [feePaymentId])).rows[0]
  if (r?.clearing) return 'clearing'
  if (r?.shared) return 'shared_retry'
  return null
}

async function markFeeWaiting(client: PoolClient, reservationId: string, how: keyof typeof RESERVATION_FEE_WAIT_NOTE, kind?: string | null): Promise<'waiting'> {
  // After the landlord's note, never over it.
  await client.query(
    `UPDATE common_area_reservations
        SET decision_note = CASE WHEN COALESCE(btrim(decision_note), '') = '' THEN $2
                                 ELSE rtrim(decision_note) || E'\n\n' || $2 END,
            updated_at = now()
      WHERE id = $1`,
    [reservationId, reservationFeeWaitLine(how, kind)])
  return 'waiting'
}

// Apply the cancellation refund policy inside the caller's transaction.
// ≥48h before start → refundable: an unpaid fee nothing was tried on is voided
// (removed, never charged); a paid fee is flagged fee_refund_due for the
// landlord to refund; an unpaid fee a payment was tried on is voided as a kept
// record (decisions #48.5) — or kept and GAM is told when it cannot come off
// (voidUnpaidReservationFee, which also stops a retry of that fee alone —
// `stop` collects the intents to cancel after COMMIT). A fee whose payment is
// still going through (clearing, or a bank retry shared with the rent) is
// neither: it WAITS (decisions #52) — no refund flag, no email to the landlord
// for money that has not arrived, nothing voided under a payment — and the
// hourly sweep decides it once that payment clears or fails for good.
// <48h → the fee stands.
export async function settleReservationFeeOnCancel(
  client: PoolClient,
  r: { id: string; fee_payment_id: string | null; starts_at: string | Date; reserved_by_tenant_id: string | null; landlord_id: string },
  stop?: string[],
): Promise<ReservationFeeOutcome> {
  if (!r.fee_payment_id) return 'none'
  const hoursBefore = (new Date(r.starts_at).getTime() - Date.now()) / 3_600_000
  if (hoursBefore < REFUNDABLE_WINDOW_HOURS) return 'fee_stands'

  if (r.reserved_by_tenant_id) await lockHousehold(client, r.reserved_by_tenant_id, r.landlord_id)
  if (await reservationFeeInFlight(client, r.fee_payment_id)) return markFeeWaiting(client, r.id, 'refund')
  const v = await voidUnpaidReservationFee(client, r, stop)
  if (v === 'paid') {
    await client.query(`UPDATE common_area_reservations SET fee_refund_due = true WHERE id = $1`, [r.id])
    return 'refund_due'
  }
  return v
}

/**
 * W-44: a canceled private event's deposit, inside the caller's transaction.
 * Event deposits are NON-REFUNDABLE by design: a paid deposit stands, an
 * unpaid one is voided (voidUnpaidReservationFee). A deposit still being paid
 * waits (decisions #52), decided by the hourly sweep: one the tenant was
 * paying (clearing) stands if it goes through ('stands'); one that was unpaid
 * at the cancel but rides a bank retry shared with the rent (it cannot be
 * stopped without dropping their rent retry) is refunded if that retry pulls
 * it ('refund') — it was owed by nobody from the cancel on.
 */
export async function settleEventDepositOnCancel(
  client: PoolClient,
  r: { id: string; fee_payment_id: string | null; reserved_by_tenant_id: string | null; landlord_id: string },
  stop?: string[],
): Promise<ReservationFeeOutcome> {
  if (!r.fee_payment_id) return 'none'
  if (r.reserved_by_tenant_id) await lockHousehold(client, r.reserved_by_tenant_id, r.landlord_id)
  const inFlight = await reservationFeeInFlight(client, r.fee_payment_id)
  if (inFlight === 'clearing') return markFeeWaiting(client, r.id, 'stands', 'event')
  if (inFlight === 'shared_retry') return markFeeWaiting(client, r.id, 'refund', 'event')
  const v = await voidUnpaidReservationFee(client, r, stop)
  return v === 'paid' ? 'fee_stands' : v
}

/** The landlord is told to refund a canceled reservation's paid fee. After the caller's COMMIT; never throws. */
export async function notifyReservationFeeRefundDue(r: {
  id: string; common_area_id: string; landlord_id: string; fee_amount: string | number; kind?: string | null
}, afterCancel = false): Promise<void> {
  const word = reservationFeeWord(r.kind)
  try {
    const meta = await queryOne<any>(
      `SELECT lu.id AS landlord_user_id, lu.email, ca.name AS area_name
         FROM common_areas ca JOIN landlords l ON l.id = ca.landlord_id
         JOIN users lu ON lu.id = l.user_id WHERE ca.id = $1`, [r.common_area_id])
    if (!meta?.landlord_user_id) return
    const { createNotification } = await import('./notifications')
    await createNotification({
      userId: meta.landlord_user_id, landlordId: r.landlord_id,
      type: 'amenity_fee_refund_due',
      title: `Refund due — ${meta.area_name} reservation canceled`,
      body: afterCancel
        // Decided by the sweep: the payment was still going through at the cancel.
        ? `A canceled ${meta.area_name} reservation's $${Number(r.fee_amount).toFixed(2)} ${word} was still being paid when it was canceled, and that payment has now gone through. The ${word} is not owed, so refund it.`
        : `A paid ${meta.area_name} reservation was canceled at least 48 hours ahead. Refund the $${Number(r.fee_amount).toFixed(2)} reservation fee.`,
      data: { reservationId: r.id, amount: r.fee_amount },
      sendEmail: true, emailTo: meta.email,
    })
  } catch (e) {
    logger.error({ err: e, reservationId: r.id }, '[common-areas] refund-due notice to the landlord failed')
  }
}

/**
 * GAM and the tenant are told a canceled reservation's fee had to stay
 * (outcome 'kept'), in the same words wherever it happens (the cancel route,
 * and the sweep deciding a fee that waited). `afterCancel`: the sweep decided
 * it, possibly days after the cancel — the tenant's notice says it is an
 * update about a reservation canceled earlier, never a second "Reservation
 * canceled". After the caller's COMMIT; never throws.
 */
export async function tellReservationFeeKept(r: {
  id: string; common_area_id: string; landlord_id: string; reserved_by_tenant_id: string | null
  fee_payment_id: string | null; fee_amount: string | number; kind: string
}, retryStopped: boolean, o: { afterCancel?: boolean } = {}): Promise<void> {
  const why = await reservationFeeKeptWhy(r.fee_payment_id).catch(() => null)
  await alertReservationFeeKept({
    reservationId: r.id, paymentId: r.fee_payment_id, landlordId: r.landlord_id,
    tenantId: r.reserved_by_tenant_id, amount: Number(r.fee_amount), how: 'canceled',
    retryStopped, why,
  })
  if (!r.reserved_by_tenant_id) return
  try {
    const who = await queryOne<{ user_id: string; email: string; area_name: string }>(
      `SELECT tu.id AS user_id, tu.email, ca.name AS area_name
         FROM tenants t JOIN users tu ON tu.id = t.user_id
         JOIN common_areas ca ON ca.id = $2
        WHERE t.id = $1`, [r.reserved_by_tenant_id, r.common_area_id])
    if (!who) return
    const { createNotification } = await import('./notifications')
    await createNotification({
      userId: who.user_id, landlordId: r.landlord_id,
      type: 'amenity_unavailable',
      title: o.afterCancel
        ? `Update on your canceled reservation — ${who.area_name}`
        : `Reservation canceled — ${who.area_name}`,
      body: (o.afterCancel
        ? `An update on your reservation at ${who.area_name}, which was canceled earlier. `
        : `Your reservation at ${who.area_name} was canceled. `) +
        reservationFeeKeptLine(Number(r.fee_amount), retryStopped, r.kind === 'event' ? 'deposit' : 'fee', why),
      data: { reservationId: r.id },
      sendEmail: true, emailTo: who.email,
    })
  } catch (e) {
    logger.error({ err: e, reservationId: r.id }, '[common-areas] kept-fee notice to the tenant failed')
  }
}

/**
 * One page of canceled reservations whose fee still waits on a payment (a
 * decision_note carrying a RESERVATION_FEE_WAIT_KEY), in id order after
 * `after`. Paged by id (decideAllWaitingReservationFees walks every page each
 * run): a fee still in flight is left exactly as it is (its updated_at does
 * not move), so ordering by when a row last changed and taking the first page
 * would recheck the same rows every run and never reach the rest.
 */
export async function reservationFeesWaiting(o: { after?: string | null; limit?: number } = {}): Promise<string[]> {
  return (await query<{ id: string }>(
    `SELECT id FROM common_area_reservations
      WHERE status = 'cancelled'
        AND (strpos(decision_note, $1) > 0 OR strpos(decision_note, $2) > 0)
        AND decision_note ~ $5
        AND ($3::uuid IS NULL OR id > $3::uuid)
      ORDER BY id LIMIT $4`,
    [RESERVATION_FEE_WAIT_KEY.refund, RESERVATION_FEE_WAIT_KEY.stands, o.after ?? null, o.limit ?? 200,
     FEE_WAIT_LAST_PARAGRAPH_RE])).map(r => r.id)
}

/**
 * The hourly sweep's pass over EVERY canceled reservation whose fee waits
 * (decisions #52), page by page, so no waiting fee is starved however many
 * are still in flight. One failing never stops the rest. Returns how each was
 * decided (fees still waiting are left out).
 */
export async function decideAllWaitingReservationFees(pageSize = 200): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  let after: string | null = null
  for (;;) {
    const page = await reservationFeesWaiting({ after, limit: pageSize })
    for (const id of page) {
      try {
        const v = await decideWaitingReservationFee(id)
        if (v && v !== 'waiting') out[id] = v
      } catch (e) { logger.error({ err: e, reservationId: id }, '[common-areas] waiting fee could not be decided') }
    }
    if (page.length < pageSize) return out
    after = page[page.length - 1]
  }
}

/**
 * Decide a canceled reservation's fee that waited on a payment (decisions
 * #52; run by the hourly sweep, jobs/scheduler processTenantEvents). Under the
 * household lock, read fresh:
 *   - still going through (clearing, or a bank retry shared with the rent) →
 *     nothing changes; a later run decides ('waiting');
 *   - the payment went through (money arrived: settled, or paid from the
 *     deposit) → a refundable fee is flagged fee_refund_due and the landlord
 *     is told to refund it ('refund_due'); an event deposit stands ('stands');
 *   - it failed for good, or nothing is left in flight → the fee comes off
 *     (voidUnpaidReservationFee: removed, or voided as a record, and a bank
 *     retry of the fee alone is stopped) — never collected, and the landlord
 *     is never told to refund it ('voided'); a fee that cannot come off
 *     ('kept') is told to GAM and the tenant, as at a cancel.
 * The wait line is replaced by the decided words (the landlord's note stays
 * first), so each fee is decided once.
 */
export async function decideWaitingReservationFee(
  reservationId: string,
): Promise<'waiting' | 'refund_due' | 'stands' | 'voided' | 'kept' | null> {
  const r0 = await queryOne<{ reserved_by_tenant_id: string | null; landlord_id: string }>(
    `SELECT reserved_by_tenant_id, landlord_id FROM common_area_reservations WHERE id = $1`, [reservationId])
  if (!r0) return null
  const stopped: string[] = []
  let out: 'waiting' | 'refund_due' | 'stands' | 'voided' | 'kept' | null = null
  let cur: any
  const client = await getClient()
  try {
    await client.query('BEGIN')
    if (r0.reserved_by_tenant_id) await lockHousehold(client, r0.reserved_by_tenant_id, r0.landlord_id)
    cur = (await client.query<any>(
      `SELECT car.*, car.fee_amount::text AS fee_amount,
              (car.fee_payment_id IS NOT NULL AND ${reservationFeePaidSql('car.fee_payment_id', ['settled', 'paid_via_deposit'])}) AS arrived,
              -- Read before the fee comes off: why it is unpaid (the decided words say it truthfully).
              CASE WHEN car.fee_payment_id IS NULL THEN 'not_paid'
                   ELSE ${reservationFeeUnpaidHowSql('car.fee_payment_id')} END AS unpaid_how
         FROM common_area_reservations car WHERE car.id = $1 FOR UPDATE OF car`, [reservationId])).rows[0]
    const wait = readFeeWait(cur?.decision_note)
    const how = wait.how
    if (!cur || cur.status !== 'cancelled' || !how) {
      await client.query('ROLLBACK')
      return null
    }
    // The decided words replace the wait line; the landlord's note stays first
    // (with any key in it neutralized, so it can never read as waiting again).
    const decided = async (note: string, refundDue = false) => client.query(
      `UPDATE common_area_reservations
          SET decision_note = $2, fee_refund_due = fee_refund_due OR $3, updated_at = now() WHERE id = $1`,
      [reservationId, withNote(landlordDecisionNote(wait.before), note), refundDue])
    if (await reservationFeeInFlight(client, cur.fee_payment_id)) {
      await client.query('ROLLBACK')
      return 'waiting'
    }
    if (cur.arrived) {
      if (how === 'refund') { await decided(reservationFeeDecidedNote('refund_due', cur.kind), true); out = 'refund_due' }
      else { await decided(reservationFeeDecidedNote('stands', cur.kind)); out = 'stands' }
    } else {
      const v = await voidUnpaidReservationFee(client, cur, stopped)
      if (v === 'paid') {
        // A payment landed between the reads: the next run decides it.
        await client.query('ROLLBACK')
        return 'waiting'
      }
      if (v === 'kept') { await decided(reservationFeeDecidedNote('kept', cur.kind)); out = 'kept' }
      else {
        // NOT SETTLED (fix pass 2, review LOW — asked of Nic): a 'stands'
        // event deposit whose payment went through and was then taken back by
        // a dispute before this sweep ran is taken off here, while one disputed
        // after the deposit stood stays owed. Left as it was until Nic decides.
        await decided(reservationFeeDecidedNote(cur.unpaid_how === 'taken_back' ? 'voided_taken_back' : 'voided', cur.kind))
        out = 'voided'
      }
    }
    await client.query('COMMIT')
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    client.release()
  }
  if (stopped.length > 0) {
    const { cancelSupersededIntents } = await import('./creditUse')
    await cancelSupersededIntents(stopped)   // never throws
  }
  if (out === 'refund_due') await notifyReservationFeeRefundDue(cur, true)
  // Days after the cancel: the tenant is told it is about a reservation
  // canceled earlier, never a second "Reservation canceled".
  if (out === 'kept') await tellReservationFeeKept(cur, stopped.length > 0, { afterCancel: true })
  return out
}

/**
 * The hourly sweep found a private event whose start came with its deposit
 * unpaid and no payment on it still going through, but the deposit cannot be
 * taken off (ReservationFeeKeptWhy: account credit already spent on it, or a
 * dispute that reopened only part of it). Releasing it would leave the tenant
 * owing a deposit for an event taken away — so the event is NOT released
 * (the caller rolls back) and GAM is told, once per reservation (the sweep
 * runs hourly), to decide with the landlord. After the caller's ROLLBACK;
 * never throws.
 */
export async function alertEventReleaseHeld(a: {
  reservationId: string; paymentId: string | null; landlordId: string; tenantId: string | null; amount: number
}): Promise<boolean> {
  try {
    const told = await queryOne(
      `SELECT 1 FROM admin_notifications
        WHERE category = 'reservation_fee_kept' AND context->>'reservation_id' = $1 AND context->>'how' = 'release_held'
        LIMIT 1`, [a.reservationId])
    if (told) return false
    const why = await reservationFeeKeptWhy(a.paymentId).catch(() => null)
    await createAdminNotification({
      severity: 'warn',
      category: 'reservation_fee_kept',
      title: `A private event was not released because its deposit could not be taken off (${a.reservationId})`,
      body: `The private event's start time came with its $${a.amount.toFixed(2)} deposit unpaid and no payment on it still going through, ` +
        `so it would have been released — but ${why ? KEPT_WHY_FOR_GAM[why] : 'it could not be voided.'} ` +
        `Releasing it would leave the tenant owing a deposit for an event that was taken away, so the event was left in place ` +
        `(still theirs) and nothing was changed: the deposit is still owed. ` +
        `Decide with the landlord: keep the event, or release it and give back any spent credit and refund any part still paid. ` +
        `The hourly sweep checks it again each run; this alert is sent once.`,
      context: { reservation_id: a.reservationId, payment_id: a.paymentId, landlord_id: a.landlordId, tenant_id: a.tenantId, why, how: 'release_held' },
    })
    return true
  } catch (e) {
    logger.error({ err: e, reservationId: a.reservationId }, '[common-areas] event-release-held alert failed')
    return false
  }
}

/** GAM's words for why the fee had to stay (alertReservationFeeKept). */
const KEPT_WHY_FOR_GAM: Record<ReservationFeeKeptWhy, string> = {
  credit_spent: 'a payment was tried on it and account credit was already spent on it, so it could not be voided (a voided charge carries no spent credit).',
  shared_retry: 'a bank retry still to come carries it together with other charges the household owes (their rent). Voiding it would make that whole retry drop, so the household would lose its rent retry; the retry was left to run, and it will pull this fee too.',
  payment_moving: 'a card or bank payment on it may still be going through, so it could not be voided.',
  disputed: 'a dispute or bank return took its money back, and what that reopened could not simply be voided (nothing reopened yet, or only part of the fee).',
}

/**
 * GAM is told, by name, about a canceled reservation whose fee had to stay on
 * the tenant's account (#48.5) and why (ReservationFeeKeptWhy, read fresh when
 * `why` is not given). After the caller's COMMIT only; never throws. (The
 * hourly sweep never releases an event whose deposit would have to stay: it
 * holds the release instead — alertEventReleaseHeld.)
 */
export async function alertReservationFeeKept(a: {
  reservationId: string; paymentId: string | null; landlordId: string; tenantId: string | null
  amount: number; how: 'canceled'
  /** A bank retry of this fee alone was stopped (voidUnpaidReservationFee). */
  retryStopped?: boolean
  why?: ReservationFeeKeptWhy | null
}): Promise<void> {
  const why = a.why !== undefined ? a.why : await reservationFeeKeptWhy(a.paymentId).catch(() => null)
  const retry = why === 'shared_retry' ? ''
    : a.retryStopped
      ? 'Its bank retry was stopped, so nothing more is pulled for it. '
      : 'If a bank retry is still to come, it also carries other charges, so it was left to run. '
  await createAdminNotification({
    severity: 'warn',
    category: 'reservation_fee_kept',
    title: `A reservation fee is still on a tenant's account after the reservation was canceled (${a.reservationId})`,
    body: `The amenity reservation was canceled, so its $${a.amount.toFixed(2)} fee is no longer owed — but ` +
      `${why ? KEPT_WHY_FOR_GAM[why] : 'it could not be voided.'} ` +
      `It stays on the tenant's balance for now. ${retry}` +
      `Until it is taken off, it is still part of the household's pay-in-full total: autopay and the tenant's next payment will collect it, ` +
      `and account credit can pay it. Act before the next autopay pull. ` +
      `Decide with the landlord: give any spent credit back and void the fee, or refund it if a payment goes through.`,
    context: { reservation_id: a.reservationId, payment_id: a.paymentId, landlord_id: a.landlordId, tenant_id: a.tenantId, why, how: a.how },
  }).catch(() => {})
}

/**
 * What the tenant is told about a fee that stays on their account after the
 * reservation was canceled (outcome 'kept'): one sentence, the same words
 * wherever it is decided — at the cancel (routes/commonAreas), or by the sweep
 * deciding a fee that waited on a payment (tellReservationFeeKept). `what` is how the tenant knows the fee:
 * an event's 'deposit', any other reservation's 'fee'. `retryStopped`: a bank
 * retry of that fee alone was stopped (voidUnpaidReservationFee). `why`
 * (reservationFeeKeptWhy) says why it still shows; without it the line says
 * only that it still shows and went for review.
 *
 * It says only what is true now and promises no removal and no refund (GAM is
 * told: alertReservationFeeKept).
 */
export function reservationFeeKeptLine(
  amount: number, retryStopped: boolean, what: 'deposit' | 'fee', why?: ReservationFeeKeptWhy | null,
): string {
  const money = `$${amount.toFixed(2)}`
  const because: Record<ReservationFeeKeptWhy, string> = {
    credit_spent: ' because account credit was already used on it',
    shared_retry: ' because it is part of a bank payment that will be tried again together with your other charges',
    payment_moving: ' because a payment for it may still be going through',
    disputed: ' because a dispute or bank return on it is still being sorted out',
  }
  const head = `The ${money} ${what} still shows on your account${why ? because[why] : ' for now'}.`
  return retryStopped && why !== 'shared_retry'
    ? `${head} Your bank will not be tried for it again, and the ${what} has been sent for review.`
    : `${head} It has been sent for review.`
}

// S547 (Nic — bad-actor guard): per-person monthly cap. One person can't
// squat an amenity by stacking daily holds. Counts the person's live
// (pending/approved) reservations on this area in the same calendar month
// as the requested start; landlord-created holds are exempt (no person key).
export async function assertMonthlyReservationLimit(
  area: { id: string; name: string; monthly_reservation_limit: number | null },
  person: { tenantId?: string | null; guestBookingId?: string | null },
  startsAt: string,
): Promise<void> {
  const limit = area.monthly_reservation_limit
  if (!limit) return
  const key = person.tenantId
    ? { col: 'reserved_by_tenant_id', val: person.tenantId }
    : person.guestBookingId
    ? { col: 'guest_booking_id', val: person.guestBookingId }
    : null
  if (!key) return
  const row = await queryOne<{ n: string }>(
    `SELECT COUNT(*) AS n FROM common_area_reservations
      WHERE common_area_id = $1 AND ${key.col} = $2
        AND status IN ('pending', 'approved')
        AND date_trunc('month', starts_at) = date_trunc('month', $3::timestamptz)`,
    [area.id, key.val, startsAt])
  if (Number(row?.n ?? 0) >= limit) {
    throw new AppError(400,
      `${area.name} allows ${limit} reservation${limit === 1 ? '' : 's'} per person per month — you've reached this month's limit.`)
  }
}
