/**
 * S647 — voiding a lease the landlord has signed takes the lease back too.
 *
 * Since S647 the landlord's signature ISSUES a lease: it creates the lease row,
 * the move-in invoice and its charges, releases held utility onto that invoice,
 * and — for a work-trade tenancy — creates the agreement. Voiding the document
 * used to flip only the document. The lease stayed active and the invoice stayed
 * pending: a bill for a tenancy nobody had agreed to, which the tenant would see
 * the next time they signed in.
 *
 * Called inside the void transaction, and only for a document that was issued
 * and that no tenant has signed (the void routes refuse the latter already).
 *
 * WHAT IT REFUSES. Any money that actually moved on the lease — settled,
 * processing, or paid from a deposit. Unwinding that is a refund, not a void, and
 * the landlord has to supersede the document instead.
 *
 * WHAT IT KEEPS. The lease row (terminated, with the reason), its lease_tenants
 * (void), the invoices (void) and the document itself. GAM does not erase a
 * record that something happened.
 *
 * WHAT IT REMOVES. Charge rows that were never owed — nothing was signed by the
 * person they bill — the same precedent bookingLeaseBilling follows for rent
 * that stopped being owed. And utility bills, which must LEAVE the
 * one-per-meter-per-cycle slot: a voided bill left in place would make the
 * re-signed lease's release treat the charge as already accounted for, and drop
 * it. The charge itself is not lost — it goes back on hold (below).
 *
 * A RENEWAL'S DEPOSIT GOES BACK. Signing a renewal moves the household's
 * deposit record onto the new lease (and a deposit increase raises its target).
 * Cancelling the renewal used to leave that funded deposit on the cancelled
 * lease, so the lease they still live under had no deposit on record and their
 * eventual move-out found nothing to return. The record moves back, the
 * uncollected increase comes off its target, and the renewal request reopens.
 * The fee rows copied onto the cancelled lease stay there as its history.
 *
 * WHAT IT DOES NOT DO: re-draft. A landlord voids for many reasons, including
 * "this person is not moving in". The household reappears on the front desk as
 * a voided lease, and re-sending is the landlord's decision.
 *
 * S655 (money plan Step 7) — THE HOUSEHOLD'S MONEY:
 *   - It runs under the household lock, like every writer of a household's
 *     money (services/moneyPredicates.lockHousehold), so a payment, the desk or
 *     the bill run never interleaves with the unwind.
 *   - A charge a payment was TRIED on — a bank or card payment that bounced or
 *     is being retried, a receipt applied to it, account credit set aside on it
 *     — is a record GAM keeps, and the database refuses to delete it anyway.
 *     The void is refused in plain words, before anything changes, exactly as
 *     it is for money that moved.
 *   - A renewal's credits go back to the lease still in force when anything of
 *     them is the household's: money left, or money a payment in flight has
 *     set aside (it comes back to them on that lease if the payment fails).
 *   - The renewal's deposit move is renewalSuccessor.returnDepositToEndedLease,
 *     the one copy of it, through returnDepositCountedOnce: what a deposit
 *     payment made on the new lease added to the record's collected amount
 *     comes off it first (only what it added — fix round 2), so the household
 *     never gets that money back twice, and never gets less than it paid.
 *   - Charges the landlord recorded for real usage — a one-off charge, a
 *     propane installment — either ride the bill being removed (they point at
 *     its rows) or wait on this lease for its next bill. For a RENEWAL they
 *     are released and go back to the lease still in force, and are billed
 *     there. For any other lease there is no lease in force to carry them:
 *     left on a terminated lease, the bill run never reaches them again and
 *     the landlord would lose the charge without a word. Where such a charge
 *     goes then is Nic's call; until he makes it, the void is refused in plain
 *     words, naming the charge (fix round 1).
 */
import type { PoolClient } from 'pg'
import { AppError } from '../middleware/errorHandler'
import { lockHousehold } from '../services/moneyPredicates'
import { newLeaseBlocksEarlyEnd, returnDepositToEndedLease, sayMoney } from '../services/renewalSuccessor'
import { supersedeScheduledRetry } from '../services/creditUse'
import { depositCollectedBySql } from '../services/leaseFeesSync'
import { recordBookingEvent } from '../services/bookingEvents'
import { RESERVATION_PAID_SQL } from '../services/bookingLeaseDraft'
import { BOOKING_STATUS_LABEL, LEASE_COLUMN_LABEL, chargeLabel, type PaymentType } from '@gam/shared'

type Q = (text: string, params?: any[]) => Promise<{ rows: any[] }>

/**
 * The charge rows this void removes: unpaid rows on the lease, on its
 * invoices, and the rows its utility bills point at. `$1` is the lease id,
 * `a` the payments alias.
 */
function voidRemovesSql(a: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(a)) throw new Error(`voidRemovesSql: "${a}" is not a table alias`)
  return `${a}.status IN ('pending','failed')
      AND (${a}.lease_id = $1
           OR ${a}.invoice_id IN (SELECT i.id FROM invoices i WHERE i.lease_id = $1)
           OR ${a}.id IN (SELECT ub.payment_id FROM utility_bills ub WHERE ub.lease_id = $1 AND ub.payment_id IS NOT NULL))`
}
const VOID_REMOVES_SQL = voidRemovesSql('p')

/**
 * A charge a payment was tried on or that carries a record (S655): a card or
 * bank intent (a bounce, a retry still to come, a pull that may still land), a
 * dispute's reopened row, a receipt applied to it, account credit set aside or
 * spent on it (a use given back — released — is not a record), or a
 * bank-return log. GAM never deletes such a row (Nic: "GAM never erases"),
 * and the database refuses to anyway (the receipt and the return log point at
 * it). One definition for every path that removes unpaid charges (this file,
 * services/commonAreas). `a` is the payments alias.
 */
export function paymentTriedSql(a = 'p'): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(a)) throw new Error(`paymentTriedSql: "${a}" is not a table alias`)
  return `(${a}.stripe_payment_intent_id IS NOT NULL
      OR ${a}.reversal_id IS NOT NULL
      OR EXISTS (SELECT 1 FROM remittance_applications x WHERE x.payment_id = ${a}.id)
      OR EXISTS (SELECT 1 FROM credit_uses x WHERE x.payment_id = ${a}.id AND x.status <> 'released')
      OR EXISTS (SELECT 1 FROM ach_monitoring_log x WHERE x.payment_id = ${a}.id))`
}

/**
 * How many of the charge rows a void of lease `leaseId` would remove carry a
 * payment that was tried (paymentTriedSql) — the rows that make the void
 * refuse. Zero means the tried-payment refusal will not fire. One definition
 * for the void and for everything that has to judge it the same way before
 * calling it (the 15-minute cancel job in jobs/scheduler; a Cancel button).
 */
export async function countTriedCharges(q: Q, leaseId: string): Promise<number> {
  return Number((await q(
    `SELECT COUNT(*)::int AS n FROM payments p
      WHERE ${VOID_REMOVES_SQL} AND ${paymentTriedSql('p')}`, [leaseId])).rows[0]?.n ?? 0)
}

/**
 * A lease that will never start still has bank retries scheduled on its bill:
 * stop the ones that would pull money ONLY for charges on that bill (the rows
 * a void of `leaseId` removes) — their schedule is cleared, credit they set
 * aside is given back ('superseded'), and their intent ids are returned for
 * the caller to cancel after COMMIT (creditUse.cancelSupersededIntents). A
 * pull that also carries anything else the household owes (rent on the lease
 * they are on) is left to run, so no owed retry is lost — the same rule the
 * reservation-fee release follows (services/commonAreas). Inside the caller's
 * transaction, under the household lock.
 */
export async function stopRetriesForChargesTheVoidRemoves(client: PoolClient, leaseId: string): Promise<string[]> {
  const ids = (await client.query<{ id: string }>(
    `WITH r AS (SELECT p.id, p.status, p.stripe_payment_intent_id AS pi FROM payments p WHERE ${VOID_REMOVES_SQL})
     SELECT r.id FROM r
      WHERE r.status = 'failed' AND r.pi IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM payments o
                         WHERE o.stripe_payment_intent_id = r.pi
                           AND o.id NOT IN (SELECT id FROM r))
      ORDER BY r.id`, [leaseId])).rows.map(x => x.id)
  if (ids.length === 0) return []
  return (await supersedeScheduledRetry(client, ids)).cancelAfterCommit
}

/** "September 14, 2026" */
function sayDay(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d))
    .toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
}

/** A one-off charge's kind, in a sentence (tenant_one_off_charges.charge_type → words; never the raw value). */
const ONE_OFF_CHARGE_WORDS: Record<string, string> = {
  violation: 'violation charge', damage: 'damage charge', replacement: 'replacement charge',
  service: 'service charge', other: 'charge',
}

/**
 * The charges a landlord recorded for this household that a void of `leaseId`
 * would strand — a one-off charge (damage, violation…) or a propane
 * installment that rides a row the void removes, or that waits on this lease
 * for its next bill (the bill run reaches one only through an active lease) —
 * named for the refusal: `the $75.00 damage charge "Broken window" (September
 * 14, 2026)`, `propane payment 2 of 4 ($40.00, filled September 3, 2026)`.
 * `cancelable`: a one-off charge not billed yet, which the landlord can cancel
 * on the tenant's page (routes/oneOffCharges PATCH /:id/cancel). A billed one
 * or a propane installment has no cancel.
 */
async function recordedChargesTheVoidStrands(
  q: Q, leaseId: string, o: { waitingOnly?: boolean } = {},
): Promise<Array<{ words: string; cancelable: boolean }>> {
  // `waitingOnly` (the never-moved-in close, Step 9 final fix): only the ones
  // still waiting on the lease for its next bill. A billed one keeps its own
  // charge row, which the close leaves owed.
  const rides = o.waitingOnly ? 'FALSE' : `c.payment_id IN (SELECT p.id FROM payments p WHERE ${VOID_REMOVES_SQL})`
  const ridesPropane = o.waitingOnly ? 'FALSE' : `i.payment_id IN (SELECT p.id FROM payments p WHERE ${VOID_REMOVES_SQL})`
  const rows = (await q(
    `SELECT 'one_off' AS kind, c.charge_type, c.amount::text AS amount, c.reason,
            to_char(c.incident_date, 'YYYY-MM-DD') AS on_date, NULL::int AS n, NULL::int AS of_n,
            (c.status = 'pending') AS cancelable
       FROM tenant_one_off_charges c
      WHERE ${rides}
         OR (c.lease_id = $1 AND c.status = 'pending')
     UNION ALL
     SELECT 'propane', NULL, i.amount::text, NULL,
            to_char(f.fill_date, 'YYYY-MM-DD'), i.installment_number, f.installment_count, FALSE
       FROM propane_fill_installments i JOIN propane_fills f ON f.id = i.fill_id
      WHERE ${ridesPropane}
         OR (f.lease_id = $1 AND i.payment_id IS NULL)
     ORDER BY on_date, kind, n`, [leaseId])).rows
  return rows.map((r: any) => ({
    words: r.kind === 'one_off'
      ? `the ${sayMoney(Number(r.amount))} ${ONE_OFF_CHARGE_WORDS[r.charge_type] ?? 'charge'} "${r.reason}" (${sayDay(r.on_date)})`
      : `propane payment ${r.n} of ${r.of_n} (${sayMoney(Number(r.amount))}, filled ${sayDay(r.on_date)})`,
    cancelable: r.cancelable === true,
  }))
}

/** "a, b and c" */
function listInWords(items: string[]): string {
  return items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
}

/**
 * The household's deposit record goes back from a new lease to the lease it
 * followed, counting each dollar once (10/3 sweep).
 *
 * A deposit payment billed on the new lease — its renewal top-up — that the
 * household paid by card or bank raised the record's collected amount when it
 * settled (the Stripe webhook calls leaseFeesSync
 * .reconcileSettledDepositPayment). That payment stays on the new lease: it is
 * returned to the household (or, if the bank sent it back, it already was).
 * Left in the record's collected amount, the household would get the same
 * money back a second time in the deposit return on the lease that ended. So
 * what the new lease's own deposit payments ADDED to the record comes off it
 * first; then the record moves back with the increase taken off its target
 * (renewalSuccessor.returnDepositToEndedLease, the one copy of the move). Pet,
 * key and cleaning deposits (they carry a lease fee) never fed this record and
 * are left alone, as is a FlexDeposit record, which the move leaves where it
 * is.
 *
 * WHAT THEY ADDED (fix round 2). Only dollars that actually raised the record
 * come off — never a payment the record skipped:
 *   - 10/4 (decisions #46.3): EVERY settle of a security-deposit payment
 *     raises the record now — the Stripe webhook, and every settle outside
 *     Stripe through services/manualPaymentSettle (the desk's cash, check or
 *     money order, the landlord agent's cash payment, a posted receipt, the
 *     bank-deposit match), all through leaseFeesSync
 *     .reconcileSettledDepositPayment, which also records who holds it. So
 *     every payment collected through GAM or by hand counts below
 *     (depositCollectedBySql). The one settle that still does not raise the
 *     record is the onboarding "paid before GAM" mark (routes/payments.ts,
 *     manual_method 'prior_arrangement'), so it is left out; a row with
 *     neither fact on it (hand-made) raised nothing either. (Before: only a
 *     payment with a Stripe intent and no manual method counted, because only
 *     the webhook raised the record — fix pass 1: counting a desk top-up took
 *     $100 the record never got.) chargeDeleteGuard.test 'a renewal top-up
 *     paid in cash at the desk goes back at $500' holds with both changes.
 *   - It raises the record only while the record is not yet funded
 *     (reconcileSettledDepositPayment skips a funded record, and never raises
 *     it past its target). Nothing lowers it again: a bank return or a dispute
 *     (services/paymentReversal) leaves the record as it was and reopens the
 *     charge.
 *   - The webhook raises the record on its own connection while its settle is
 *     still uncommitted. The new lease's deposit charges are locked first, so
 *     a settle in progress finishes (record raised, charge settled) before
 *     they are counted — never one without the other.
 *   - So while the record still reads short of its target, every new-lease
 *     deposit payment that ever settled — still settled, or settled and since
 *     sent back — added its whole amount: all of it comes off.
 *   - Once the record reads funded, a payment that settled after that added
 *     nothing. The typical case: the $500 deposit was paid in full, the
 *     renewal raised it to $600, the $100 top-up settled (the record reads
 *     $600, funded), the bank sent it back (still $600), and the household
 *     paid the reopened $100 (skipped: funded — still $600). Taking off both
 *     $100 payments put the record back at $400, shorting the household $100
 *     at move-out. What the new lease's payments could have added to a funded
 *     record is the renewal's increase (the deposit before it was paid in
 *     full), so no more than that comes off: it goes back at $500.
 *   - Known edge: a deposit that was NOT paid in full before the renewal, whose
 *     top-up the bank sent back and the household paid again, was raised twice
 *     for one top-up (the return never lowered it). If that second raise made
 *     it read funded, it goes back that much high. The cure is at the source —
 *     a return or dispute of a deposit payment lowers the record — and when it
 *     does, the funded cap below gives way to "what the new lease's payments
 *     still hold" (settled, plus the part of a returned payment the bank did
 *     not take back).
 *
 * Idempotent: once the record has moved, nothing is left on the new lease.
 * Used by the void (unwindIssuedLease) and by the job that holds a new lease
 * that can never start (jobs/scheduler processNewLeaseSignings).
 */
export async function returnDepositCountedOnce(q: Q, newLeaseId: string, endedLeaseId: string): Promise<number> {
  // The new lease's deposit charges, locked (the caller holds the household
  // lock): a Stripe settle of one that is under way commits first, and the
  // count below — a fresh statement — sees it settled and the record raised.
  await q(
    `SELECT p.id FROM payments p
      WHERE p.lease_id = $1 AND p.type = 'deposit' AND p.lease_fee_id IS NULL
      ORDER BY p.id FOR UPDATE`, [newLeaseId])
  await q(
    `WITH rec AS (
       SELECT x.id, x.flex_deposit_enabled,
              COALESCE(x.collected_amount, 0) >= x.total_amount AS reads_funded
         FROM security_deposits x WHERE x.lease_id = $1
        ORDER BY x.created_at DESC, x.id DESC LIMIT 1),
     own AS (
       -- Every deposit payment on the new lease that ever settled in a way
       -- that raises the record — through GAM or by hand (decisions #46.3,
       -- see above): the top-up and any charge a return reopened, still
       -- settled or since sent back. Never the onboarding "paid before GAM" mark.
       SELECT COALESCE(SUM(p.amount), 0) AS paid
         FROM payments p
        WHERE p.lease_id = $1 AND p.type = 'deposit' AND p.lease_fee_id IS NULL
          AND p.status IN ('settled','returned')
          AND ${depositCollectedBySql('p')} IS NOT NULL
          AND p.manual_method IS DISTINCT FROM 'prior_arrangement'
          -- A reopened charge paid again never raises the record a second
          -- time (leaseFeesSync.reconcileSettledDepositPayment, Step 9 review
          -- fix pass 2): the payment it reopened already did.
          AND p.reversal_id IS NULL),
     raised AS (
       -- What the renewal raised the target by: the figure the move takes off
       -- it (renewalSuccessor.returnDepositToEndedLease reads the same rows).
       SELECT COALESCE(SUM(f.amount), 0) AS increase
         FROM lease_fees f
        WHERE f.lease_id = $1 AND f.due_timing = 'move_in' AND f.is_refundable = TRUE
          AND f.description LIKE '[deposit top-up on renewal]%'),
     added AS (
       SELECT rec.id,
              CASE WHEN rec.reads_funded THEN LEAST(own.paid, raised.increase) ELSE own.paid END AS amount
         FROM rec, own, raised
        WHERE rec.flex_deposit_enabled = FALSE)
     UPDATE security_deposits sd
        SET collected_amount = GREATEST(sd.collected_amount - added.amount, 0),
            status = CASE
                       WHEN sd.status NOT IN ('funded','partial') THEN sd.status
                       WHEN GREATEST(sd.collected_amount - added.amount, 0) >= sd.total_amount THEN 'funded'
                       WHEN GREATEST(sd.collected_amount - added.amount, 0) > 0 THEN 'partial'
                       ELSE 'pending' END,
            updated_at = NOW()
       FROM added
      WHERE sd.id = added.id
        AND added.amount > 0`,
    [newLeaseId])
  return returnDepositToEndedLease(q, newLeaseId, endedLeaseId)
}

/**
 * S655: the household lock for a void of lease `leaseId` — the first lock the
 * void takes (household, then its leases, then rows). The household is the
 * lease's person, whatever their row's status by now (the void's own cascade
 * may already have voided it), else whoever its charges name. Inside the
 * caller's transaction, through its query function.
 *
 * The unwind takes it itself. A caller that locks a row of its own before the
 * void — the 15-minute cancel in jobs/scheduler takes the document — takes
 * this first, so it resolves the same household and the same key; the
 * unwind's second take is free (an advisory lock is re-entrant in its
 * session). Returns the household, or null when the lease names nobody.
 */
export async function lockLeaseHousehold(q: Q, leaseId: string): Promise<{ tenantId: string; landlordId: string } | null> {
  const hh = (await q(
    `SELECT l.landlord_id,
            COALESCE(
              (SELECT lt.tenant_id FROM lease_tenants lt WHERE lt.lease_id = l.id
                ORDER BY (lt.role = 'primary') DESC, lt.added_at, lt.tenant_id LIMIT 1),
              (SELECT p.tenant_id FROM payments p WHERE p.lease_id = l.id AND p.tenant_id IS NOT NULL
                ORDER BY p.created_at, p.id LIMIT 1)) AS tenant_id
       FROM leases l WHERE l.id = $1`, [leaseId])).rows[0]
  if (!hh?.tenant_id) return null
  await lockHousehold({ query: q } as unknown as PoolClient, hh.tenant_id, hh.landlord_id)
  return { tenantId: hh.tenant_id, landlordId: hh.landlord_id }
}

/**
 * A utility bill on a tenancy that never happened goes back on hold, so the
 * charge is not lost: a hold that was released onto it opens again, and a bill
 * the monthly run made directly on the lease is raised as a hold (ONE way a
 * pre-lease charge reaches a tenancy). The caller then takes the bill out of
 * its one-per-meter-per-cycle slot. `b` is the utility_bills row.
 */
async function holdUtilityBillAgain(q: Q, b: any, why: { released: string; raised: string }): Promise<void> {
  const hold = (await q(
    `SELECT id FROM suspended_utility_charges WHERE released_bill_id = $1`, [b.id])).rows[0]
  if (hold) {
    await q(
      `UPDATE suspended_utility_charges
          SET released_at = NULL, released_bill_id = NULL, updated_at = NOW(),
              notes = COALESCE(notes || ' — ', '') || $2
        WHERE id = $1`, [hold.id, why.released])
    return
  }
  await q(
    `INSERT INTO suspended_utility_charges
       (meter_id, unit_id, landlord_id, billing_cycle_month, utility_type,
        usage_amount, allocation_method, allocation_basis, rate_per_unit,
        base_fee_share, charge_amount, tax_rate_pct, tax_amount,
        sewer_rate_per_unit, reading_start, reading_end,
        reading_start_date, reading_end_date, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
     ON CONFLICT DO NOTHING`,
    [b.meter_id, b.unit_id, b.landlord_id, b.billing_cycle_month, b.utility_type,
     b.usage_amount, b.allocation_method, b.allocation_basis, b.rate_per_unit,
     b.base_fee_share, b.charge_amount, b.tax_rate_pct, b.tax_amount,
     b.sewer_rate_per_unit, b.reading_start, b.reading_end,
     b.reading_start_date, b.reading_end_date, why.raised])
}

/** The note on every line of a move-in bill closed because the tenant never moved in (decisions #46.4). */
export const NEVER_MOVED_IN_NOTE =
  'Closed when the lease ended: the tenant never paid the move-in bill or moved in, so nothing on it is owed'

/** The reason a lease ended through "They never moved in — end the lease". */
export const NEVER_MOVED_IN_REASON = 'The tenant never moved in'

/** What a never-moved-in line is, by its payment type (the landlord's confirm lists each line by name). */
const NEVER_MOVED_IN_TYPE_LABEL: Record<PaymentType, string> = {
  rent: 'Rent',
  fee: 'Fee',
  deposit: 'Deposit',
  utility: 'Utility',
  float_fee: 'Fee',
  late_fee: 'Late fee',
  platform_fee: 'Platform fee',
  home_payment: 'Home payment',
}

/** Why a lease can't be closed as never moved in. */
export type NeverMovedInWhyNot =
  | 'not_found' | 'ended' | 'imported' | 'renewal' | 'moved_spaces' | 'moved_in'
  | 'money_paid' | 'payment_on_its_way' | 'opening_balance'
  /** A household's new lease waits after this one (renewalSuccessor.newLeaseBlocksEarlyEnd). */
  | 'new_lease_waiting'
  /**
   * Step 9 final fix (fix pass 1): a charge the landlord recorded for this
   * household waits on the lease for its next bill (a one-off charge not
   * billed yet, a propane installment). With the lease ended no bill run
   * reaches it again, so it would be lost without a word (the void refuses
   * the same way; where such a charge goes is decisions #49.4, Nic's call).
   */
  | 'recorded_charge'
  /** Without the landlord's word (an ordinary lease end): the lease came into force, or ran a second bill. */
  | 'in_force' | 'second_bill' | 'nothing_to_close'

/** One line the close zeroes, as the landlord's confirm lists it. */
export interface NeverMovedInLine {
  paymentId: string
  label: string
  amount: number
  dueDate: string | null
  /** A utility charge goes back on hold for whoever the space is billed to next (it is real usage). */
  utility: boolean
}

/**
 * Step 9 final fix (fix pass 1): why a line on the lease is NOT zeroed and
 * stays owed (the confirm says so plainly):
 *   - 'gam_fee': GAM's own pass-through line (revenue_owner 'gam' — the $1
 *     declined-card fee, the returned-payment fee). GAM absorbs nothing, so a
 *     landlord's "they never moved in" never zeroes it.
 *   - 'billed_charge': a charge billed on purpose — Charge an amount, Bill a
 *     fee, a one-off charge, a propane installment, an amenity fee.
 *     decisions #46.4: "Damage, unpaid rent and unpaid fees still go on the
 *     final bill as usual" — only the move-in bill is zeroed.
 *   - 'later_bill' (fix pass 1 of the final fix, decisions #53): a line that is
 *     not on the move-in bill — a later month's rent the lease billed, or a
 *     line on no bill. The close zeroes ONLY the unpaid move-in bill (the first
 *     invoice: the deposit, the move-in fees and the first rent); everything
 *     else the lease billed stays owed — the lease is law.
 */
export type NeverMovedInKeptWhy = 'gam_fee' | 'billed_charge' | 'later_bill'

/** One line that stays owed after the close, as the confirm lists it. */
export interface NeverMovedInKeptLine {
  paymentId: string
  label: string
  amount: number
  why: NeverMovedInKeptWhy
  /** The day it is due (the confirm says it beside a later bill's line). */
  dueDate: string | null
  /**
   * Final fix (fix pass 2, review): the days a later month's RENT covers
   * (YYYY-MM-DD, null for anything that is not rent): its due day through the
   * day before the lease's next rent, at most a month and never past the
   * lease's end. The confirm says it beside the line, so staff see a kept
   * month runs past the day the close ends the lease. (Whether such a month
   * should be cut to that day is Nic's call — it stays owed in full today.)
   */
  periodStart?: string | null
  periodEnd?: string | null
}

/** The reservation the close also cancels (a lease drafted from a stay the Schedule still shows as coming). */
export interface NeverMovedInReservation {
  bookingId: string
  unitId: string
  landlordId: string
  guestName: string | null
  status: string
  checkIn: string | null
}

export interface NeverMovedInAssessment {
  applies: boolean
  whyNot: NeverMovedInWhyNot | null
  /** Plain words for a refusal, with the real next step (null when it applies). */
  words: string | null
  status: string | null
  startDate: string | null
  /**
   * The bill the close voids: the move-in bill (the lease's first invoice),
   * when it is still open. Decisions #53: never a later bill.
   */
  invoiceIds: string[]
  lines: NeverMovedInLine[]
  /** What the close zeroes, in dollars. */
  total: number
  /** Lines that stay owed (GAM's own fees, charges billed on purpose) — never zeroed. */
  kept: NeverMovedInKeptLine[]
  /** Their total, in dollars. */
  keptTotal: number
  /** Plain words for the kept lines (null when there are none). */
  keptWords: string | null
  /**
   * The reservation the close cancels with the lease: the stay the lease was
   * drafted from, still showing as coming on the Schedule (null when none, or
   * when the caller is the Schedule's own Cancel reservation).
   */
  reservation: NeverMovedInReservation | null
  /** The lease had already ended: the close zeroes what is left and changes nothing else about the lease. */
  alreadyEnded: boolean
}

/**
 * Who is reading a refusal, so its next step is one they can take. “They’re
 * leaving on…” needs "Edit leases" or "Mark who is leaving"; Move out needs
 * "Deposit return / move-out". Missing (an ordinary lease end): the full step.
 */
export interface NeverMovedInReader {
  canMarkLeaving: boolean
  canMoveOut: boolean
}

const MOVE_OUT_PATH = 'Change → “They’re leaving on…” on the Leases page, then Change → Move out'
/**
 * Fix pass 3: a lease with a leaving date already on file shows “Leaving date —
 * change or call off” in that menu, never “They’re leaving on…” — so its step
 * names only the button that is there.
 */
const MOVE_OUT_PATH_NOTICE_ON_FILE = 'Change → Move out on the Leases page'

/** The way to a move-out for this lease, by the buttons it actually shows. */
const moveOutPath = (o: { noticeOnFile?: boolean } = {}): string =>
  o.noticeOnFile ? MOVE_OUT_PATH_NOTICE_ON_FILE : MOVE_OUT_PATH

/**
 * The move-out step, said to whoever reads it: someone who can't take it is
 * told to ask the landlord. `when`: the lease has not started yet, and starts
 * on that (future) day. `noticeOnFile`: a leaving date is already written down.
 */
export function moveOutStepWords(reader?: NeverMovedInReader, o: { when?: string; noticeOnFile?: boolean } = {}): string {
  const can = !reader || (reader.canMarkLeaving && reader.canMoveOut)
  const path = moveOutPath(o)
  const lead = o.when ? `When the lease starts (${o.when}), ` : ''
  return can
    ? `${lead ? lead + 'use' : 'Use'} ${path} — the move-out settles what they paid and returns what is theirs.`
    : `${lead ? lead + 'ask' : 'Ask'} the landlord to end it with a move-out (${path}) — the move-out settles what they paid and returns what is theirs.`
}

const stepThroughMoveOut = (reader?: NeverMovedInReader, o: { noticeOnFile?: boolean } = {}): string =>
  !reader || (reader.canMarkLeaving && reader.canMoveOut)
    ? `To end it, use ${moveOutPath(o)}.`
    : `To end it, ask the landlord to use ${moveOutPath(o)}.`

/**
 * Fix pass 3: the real next step for a lease that has not come into force.
 * A pending lease becomes active only once the LANDLORD has signed (the
 * scheduler's activation): one the landlord never signed stays pending past
 * its start date for good, so "when the lease starts (<a day gone by>)" was a
 * dead end. Its step is the landlord's signature on the GoldSign page (the
 * signing page's name in the app — Step 9 final fix, fix pass 1). A
 * landlord-signed lease whose start date has passed starts overnight; one
 * whose start date is ahead starts that day.
 */
function notStartedStepWords(
  lease: { status: string; signed_by_landlord: boolean | null; start_date: string | null; starts_later: boolean | null },
  reader?: NeverMovedInReader,
): string {
  if (lease.signed_by_landlord !== true) {
    return 'The landlord hasn’t signed this lease, so it hasn’t started. The landlord signs it on the GoldSign page; ' +
      `once it starts, ${moveOutStepWords(reader).replace(/^./, (ch) => ch.toLowerCase())}`
  }
  if (lease.starts_later === true) return moveOutStepWords(reader, { when: dayWords(lease.start_date) })
  return `Once the lease is in force (GAM starts it overnight), ${moveOutStepWords(reader).replace(/^./, (ch) => ch.toLowerCase())}`
}

/** A calendar day (YYYY-MM-DD) as "Oct 4, 2026" — a day, so no time zone can move it. */
const dayWords = (ymd: string | null): string => ymd
  ? new Date(`${String(ymd).slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
  : 'its start date'

/**
 * SQL — whether a line on the lease stays owed through a never-moved-in close,
 * and why (NeverMovedInKeptWhy), else NULL. `a` is the payments alias.
 *   - GAM's own line (revenue_owner 'gam': the declined-card fee the Stripe
 *     webhook adds on every refused card attempt, the returned-payment fee):
 *     GAM absorbs nothing, so the landlord's word never zeroes it.
 *   - A charge billed on purpose: Charge an amount / Bill a fee / the landlord
 *     assistant / an amenity fee (services/leaseFees.createLeaseFeePayment
 *     writes '<who>-billed: …' as its note), a one-off charge or a propane
 *     installment billed onto a bill (decisions #46.4: "Damage, unpaid rent
 *     and unpaid fees still go on the final bill as usual").
 */
export function keptThroughNeverMovedInSql(a = 'p'): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(a)) throw new Error(`keptThroughNeverMovedInSql: "${a}" is not a table alias`)
  return `(CASE WHEN ${a}.revenue_owner = 'gam' THEN 'gam_fee'
               WHEN ${a}.notes ~ '^(admin|agent|amenity)-billed: '
                 OR EXISTS (SELECT 1 FROM tenant_one_off_charges kc WHERE kc.payment_id = ${a}.id)
                 OR EXISTS (SELECT 1 FROM propane_fill_installments ki WHERE ki.payment_id = ${a}.id)
               THEN 'billed_charge' END)`
}

/**
 * SQL — the id of lease `a`'s MOVE-IN bill: its first invoice ever (a voided
 * one too, so a later bill never stands in for it). Decisions #53: the
 * never-moved-in close zeroes this bill and no other. One ordering for the
 * close (assessNeverMovedIn reads the same rows in the same order) and for the
 * Leases page's "zero the bill" offer. `a` is the leases alias.
 */
export function moveInInvoiceIdSql(a = 'l'): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(a)) throw new Error(`moveInInvoiceIdSql: "${a}" is not a table alias`)
  return `(SELECT mi.id FROM invoices mi WHERE mi.lease_id = ${a}.id ORDER BY mi.created_at, mi.due_date, mi.id LIMIT 1)`
}

/**
 * "$1,500.00" for a figure in cents — the same way the landlord's pages write
 * money (fmt), so the confirm, its toast and every refusal say one figure one
 * way (Step 9 final fix, fix pass 3: this used to say "$1500.00").
 */
export const centsWords = (c: number) =>
  `$${(Math.round(c) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

/** The plain words for the lines that stay owed (null when there are none). */
function keptWordsFor(kept: NeverMovedInKeptLine[]): string | null {
  if (kept.length === 0) return null
  const item = (k: NeverMovedInKeptLine) => `${k.label} (${centsWords(Math.round(k.amount * 100))})`
  const dated = (k: NeverMovedInKeptLine) => k.dueDate
    ? `${k.label} due ${dayWords(k.dueDate)} (${centsWords(Math.round(k.amount * 100))})` : item(k)
  const gam = kept.filter(k => k.why === 'gam_fee')
  const billed = kept.filter(k => k.why === 'billed_charge')
  const later = kept.filter(k => k.why === 'later_bill')
  const parts: string[] = []
  if (later.length > 0) {
    // Decisions #53: only the move-in bill is zeroed; the lease is law.
    parts.push(`what is not on the move-in bill, ${listInWords(later.map(dated))} — only the move-in bill is zeroed`)
  }
  if (gam.length > 0) {
    parts.push(`GAM’s own ${gam.length === 1 ? 'fee' : 'fees'}, ${listInWords(gam.map(item))} — ending the lease never takes ${gam.length === 1 ? 'it' : 'them'} off`)
  }
  if (billed.length > 0) {
    parts.push(`${billed.length === 1 ? 'the charge' : 'the charges'} billed on purpose, ${listInWords(billed.map(item))}`)
  }
  // Fix pass 2 (review): a later month's rent says the days it covers — it
  // stays owed in full, even where they run past the day the lease ends.
  const covers = later.filter(k => k.periodStart && k.periodEnd && k.dueDate)
    .map(k => `${k.label} due ${dayWords(k.dueDate)} covers ${dayWords(k.periodStart!)} – ${dayWords(k.periodEnd!)}.`)
  return `Still owed after this: ${parts.join('; and ')}. ${covers.length > 0 ? `${covers.join(' ')} ` : ''}`
    + `${kept.length === 1 ? 'It stays' : 'They stay'} on the household’s balance.`
}

/**
 * 10/4 (decisions #46.4, Nic, FINAL): "If they signed, got the move-in
 * invoice, and never paid / never moved in: zero it out and end the lease."
 *
 * Whether a lease is one whose tenant never paid and never came — and, when it
 * is, every unpaid line the close zeroes. One reading for the landlord's
 * confirm (no locks) and for the close itself (`lock`: under the household
 * lock, the lease, its bills and its lines locked — fresh at the moment of
 * action).
 *
 * THREE WAYS IN:
 *   - An ordinary lease end (routes/leases.ts PATCH status 'terminated' /
 *     'expired') — `attested: false`. GAM cannot tell "never moved in" from
 *     "moved in and never paid" on its own: a lease goes 'active' on its start
 *     date whether or not anything was paid (jobs/scheduler), and ending such a
 *     lease in its first month (an eviction) must leave the rent for the days
 *     they lived there owed. So the bill closes only when the lease plainly
 *     never came into force (still 'pending', or its start date is after the
 *     property's today) and has exactly one bill.
 *   - "They never moved in — end the lease" (and Discard on a lease the
 *     tenant signed) — `attested: true`. Staff say it in so many words, and
 *     the confirm lists exactly what is zeroed: that statement is what tells
 *     GAM the tenant never came, so it also closes a lease the scheduler
 *     already made active on its start date (fix pass 1, step 9 final fix —
 *     the usual case: the day came and the tenant never showed). It zeroes
 *     ONLY the unpaid move-in bill — the lease's first invoice, with the
 *     deposit, the move-in fees and the first rent (decisions #53, reading
 *     #46.4 literally). A later bill the lease ran stays owed (the lease is
 *     law) and the confirm lists it as "stays owed" (`kept`, 'later_bill').
 *   - Cancel reservation on the Schedule (routes/units.ts) for a stay whose
 *     lease was drafted with it — `attested: true, cancelingBooking` (Step 9
 *     final fix, fix pass 1): canceling the stay is staff saying the guest is
 *     not coming. Before, the cancel ended the lease with a bare UPDATE and
 *     left its move-in bill owed. Fix pass 3 (review, HIGH): that includes a
 *     drafted lease the scheduler already made 'active' on its start date —
 *     the usual no-show is noticed on or after the check-in day, when the
 *     landlord-signed lease is already active; the cancel used to leave it
 *     active, billing, its move-in bill owed. A status of 'no_show' sent
 *     through the API or the landlord assistant runs the same close.
 *
 * Step 9 final fix (fix pass 1):
 *   - A lease drafted from a stay the Schedule still shows as coming: the
 *     close cancels that reservation too, in the same transaction (the confirm
 *     says so). There is no no-show button on the Schedule, and "they never
 *     moved in" is the same fact as canceling the stay — so both doors end in
 *     the same place: reservation canceled, lease ended, move-in bill zeroed.
 *   - GAM's own fees and charges billed on purpose are never zeroed: they stay
 *     owed (`kept`), and the confirm says so plainly.
 *   - A bank pull set to be tried again that pays ONLY this lease's lines is
 *     stopped by the close (as the void stops it — stopRetriesForChargesTheVoidRemoves's
 *     rule): GAM never pulls money for a tenancy staff just said never
 *     happened. One that also pays something else the household owes is left
 *     to run, and the close waits for it.
 *   - A lease that already ended (canceled before this fix, or by a lapsed
 *     hold) with its never-moved-in bill still owed: the close zeroes what is
 *     left — never "Nothing else to do" while a bill is still owed. A lease
 *     that ended with a move-out, or that a new lease followed, keeps what it
 *     owes.
 *
 * Either way it never closes:
 *   - an imported or onboarded tenancy (those people already live there);
 *   - a renewal (supersedes_lease_id, or a signing that renews a lease) or a
 *     lease whose household moved spaces (unit_moved_on) — they live there.
 *     Not a lease GAM moved along with its stay's unpaid hold before arrival
 *     (services/holdDisplacement) when nobody moved the household by hand:
 *     that move says nothing about anyone living anywhere (fix pass 2);
 *   - a lease GAM's own records say they moved into: a finalized move-in
 *     walkthrough, or the stay it came from EVER checked in — read from the
 *     stay's history, not only its status now (decisions #53): a stay
 *     checked in and then set back to Confirmed still had a guest in it;
 *   - a lease with an opening-balance bill (money owed from before GAM);
 *   - a lease anything was ever paid on or is on its way on: a line settled
 *     with money, clearing, paid from a deposit or sent back, a payment
 *     started, a receipt applied, account credit set aside or spent on it;
 *     and (fix pass 2) money sitting on the lease itself — paid-ahead money,
 *     a deposit record with money in it (carried over or paid), unspent
 *     account credit, money received and not yet put toward a bill — or on
 *     its way to it: a receipt still clearing, the tenant's unmatched report
 *     that they paid at the bank;
 *     and money paid toward the reservation the lease was drafted from, once
 *     the lease has a move-in bill (the bill takes it off its rent —
 *     decisions #15; fix pass 1 of the #53 close);
 *   - a lease with a charge the landlord recorded still waiting for its next
 *     bill (it would be lost with the lease);
 *   - (attested) a lease with a household's new lease waiting after it.
 * Refusals come with plain words naming the real next step (`words`), said to
 * the reader (`reader`: someone who can't run a move-out is told to ask the
 * landlord).
 */
export async function assessNeverMovedIn(
  q: Q, leaseId: string,
  o: { attested: boolean; lock: boolean; reader?: NeverMovedInReader; cancelingBooking?: string },
): Promise<NeverMovedInAssessment> {
  const out = (whyNot: NeverMovedInWhyNot, words: string | null, extra: Partial<NeverMovedInAssessment> = {}): NeverMovedInAssessment =>
    ({
      applies: false, whyNot, words, status: null, startDate: null, invoiceIds: [], lines: [], total: 0,
      kept: [], keptTotal: 0, keptWords: null, reservation: null, alreadyEnded: false, ...extra,
    })
  if (o.lock) {
    // The stay the lease came from, before the household: the Schedule's save
    // takes the stay's row first too (routes/units.ts stayChangedSince), so the
    // two doors never wait on each other in opposite orders.
    await q(
      `SELECT b.id FROM unit_bookings b
        WHERE b.id = (SELECT l.source_booking_id FROM leases l WHERE l.id = $1)
        FOR UPDATE`, [leaseId])
    await lockLeaseHousehold(q, leaseId)
  }
  // The note jobs/moveInBundle writes on the reservation money the arrival
  // rent did not use (one definition; loaded here, not at the top, so this
  // lib never pulls the billing job in when it loads).
  const { STAY_DEPOSIT_CREDIT_NOTE } = await import('../jobs/moveInBundle')
  const lease = (await q(
    `SELECT l.id, l.lease_source, l.is_existing_tenancy, l.status, l.supersedes_lease_id, l.unit_moved_on,
            l.signed_by_landlord, (l.move_out_notice_at IS NOT NULL) AS notice_on_file,
            to_char(l.start_date, 'YYYY-MM-DD') AS start_date,
            (l.start_date IS NOT NULL AND l.start_date > (now() AT TIME ZONE COALESCE(pr.timezone, 'America/Phoenix'))::date) AS starts_later,
            EXISTS (SELECT 1 FROM lease_documents d WHERE d.lease_id = l.id AND d.renews_lease_id IS NOT NULL) AS renews,
            EXISTS (SELECT 1 FROM deposit_returns dr WHERE dr.lease_id = l.id AND dr.finalized_at IS NOT NULL) AS moved_out,
            EXISTS (SELECT 1 FROM leases nx WHERE nx.supersedes_lease_id = l.id) AS followed,
            (SELECT to_char(MAX(i.finalized_at) AT TIME ZONE COALESCE(pr.timezone, 'America/Phoenix'), 'YYYY-MM-DD')
               FROM unit_inspections i
              WHERE i.lease_id = l.id AND i.inspection_type = 'move_in' AND i.status = 'finalized') AS walkthrough_on,
            -- Decisions #53 (final fix, fix pass 1): EVER checked in, read
            -- from the stay's history as well as its status now. A stay
            -- checked in and then set back to Confirmed (or canceled) still
            -- had a guest in it; its status alone hid that, and the close then
            -- zeroed rent for nights that were stayed. The day is the first
            -- check-in the history records (on the property's calendar), else
            -- the stay's arrival day.
            (SELECT to_char(COALESCE(
                      (SELECT (MIN(e.created_at) AT TIME ZONE COALESCE(pr.timezone, 'America/Phoenix'))::date
                         FROM unit_booking_events e
                        WHERE e.booking_id = b.id AND e.detail->>'to_status' = 'checked_in'),
                      b.check_in), 'YYYY-MM-DD')
               FROM unit_bookings b
              WHERE b.id = l.source_booking_id
                AND (b.status IN ('checked_in', 'checked_out')
                     OR EXISTS (SELECT 1 FROM unit_booking_events e
                                 WHERE e.booking_id = b.id
                                   AND (e.detail->>'to_status' IN ('checked_in', 'checked_out')
                                        OR e.detail->>'from_status' IN ('checked_in', 'checked_out'))))) AS checked_in_on,
            (SELECT b.status FROM unit_bookings b WHERE b.id = l.source_booking_id) AS booking_status_now,
            -- Step 9 final fix (fix pass 1 of #53, review MEDIUM): money paid
            -- toward the reservation this lease was drafted from (decisions
            -- #15 — the counter or the booking site takes the deposit and the
            -- lease bills the rest). jobs/moveInBundle takes it off the
            -- move-in bill's rent (the same RESERVATION_PAID_SQL), so it is
            -- money paid on this lease's bills — read below.
            (SELECT ${RESERVATION_PAID_SQL} FROM unit_bookings b WHERE b.id = l.source_booking_id)::text AS reservation_paid,
            -- What of it the arrival rent did not use: kept on the lease as
            -- paid-ahead money (its own fact below — or, the part spent on a
            -- bill, the money paid on it), so not said twice. Fix pass 2
            -- (review): only a leftover still standing (not voided), as
            -- services/bookingLeaseBilling counts it. A withdrawn one is no
            -- longer the leftover — a lease unwound and signed again gets a
            -- new one (jobs/moveInBundle), and counting both took the
            -- leftover off twice, understating the money paid.
            (SELECT COALESCE(SUM(c.amount_original), 0) FROM lease_prepaid_credits c
              WHERE c.lease_id = l.id AND c.funded_by = 'reclassified' AND c.note = $2
                AND c.voided_at IS NULL)::text AS reservation_leftover,
            -- Final fix (fix pass 2, review): GAM moved the stay's unpaid hold
            -- to another site before arrival (services/holdDisplacement, which
            -- also moves the pending lease drafted with it and stamps
            -- unit_moved_on), and nobody ever moved this household by hand
            -- (a move on the Leases page — services/unitMove — always records
            -- who moved them). Such a lease never occupied the first site: the
            -- move says nothing about anyone living there.
            --
            -- Fix pass 3 (review): not only the absence of a recorded mover.
            -- The hold move takes the stay AND its lease to the same site; a
            -- hand move (services/unitMove) moves the lease alone. So the lease
            -- must still be on the site its stay is on — a move by hand that
            -- recorded no mover (a future caller passing no actor) leaves them
            -- apart and still reads as the household moving spaces.
            (l.source_booking_id IS NOT NULL
             AND EXISTS (SELECT 1 FROM unit_bookings hb WHERE hb.id = l.source_booking_id AND hb.displaced_at IS NOT NULL
                                                          AND hb.unit_id = l.unit_id)
             AND NOT EXISTS (SELECT 1 FROM lease_unit_history h WHERE h.lease_id = l.id AND h.moved_by_user_id IS NOT NULL)
            ) AS moved_only_with_hold,
            (SELECT json_build_object('id', b.id, 'unit_id', b.unit_id, 'landlord_id', b.landlord_id,
                                      'guest_name', b.guest_name, 'status', b.status,
                                      'check_in', to_char(b.check_in, 'YYYY-MM-DD'))
               FROM unit_bookings b
              WHERE b.id = l.source_booking_id AND b.status IN ('tentative', 'confirmed')) AS live_booking
       FROM leases l
       LEFT JOIN units u ON u.id = l.unit_id
       LEFT JOIN properties pr ON pr.id = u.property_id
      WHERE l.id = $1
      ${o.lock ? 'FOR UPDATE OF l' : ''}`, [leaseId, STAY_DEPOSIT_CREDIT_NOTE])).rows[0]
  if (!lease) return out('not_found', 'This lease is no longer on the account.')
  const ended = lease.status === 'terminated' || lease.status === 'expired'
  const base = { status: lease.status as string, startDate: lease.start_date as string | null, alreadyEnded: ended }
  // An ended lease has nothing left to end: a refusal on it says what stays
  // owed, never "to end it, use …".
  const OWED_STAYS = 'What it still owes stays owed.'
  // A lease not yet in force has no Change menu on the Leases page: its step
  // is the one that starts it (notStartedStepWords), never "Change → …".
  const notInForce = lease.status === 'pending' || lease.status === 'draft'
  const endStep = (step: string) => ended ? OWED_STAYS : notInForce ? notStartedStepWords(lease, o.reader) : step
  if (ended) {
    if (!o.attested) return out('ended', 'This lease has already ended. Nothing else to do.', base)
    if (lease.moved_out) {
      return out('ended', 'This lease already ended with a move-out, so what it still owes stays owed — the move-out put it on their final bill.', base)
    }
    if (lease.followed) {
      return out('ended', 'This lease already ended and the household went on to a new lease, so what it still owes stays owed.', base)
    }
    // Otherwise read on: a lease ended before the close could run (a reservation
    // canceled before this fix, a hold that lapsed) may still carry its
    // never-moved-in bill — the close zeroes what is left.
  }
  if (lease.lease_source === 'imported' || lease.is_existing_tenancy) {
    return out('imported', 'This tenancy was brought into GAM from before, so the household already lives there and what it owes stays owed. ' +
      endStep(stepThroughMoveOut(o.reader, { noticeOnFile: lease.notice_on_file === true })), base)
  }
  if (!o.attested && !(lease.status === 'pending' || lease.starts_later === true)) return out('in_force', null, base)
  if (o.attested && !ended) {
    // Fix pass 2: a household's new lease waiting after this one — leaving
    // and staying can't both be true (the refusal every early-end door gives).
    // Read here, so the confirm shows it (only Close) instead of a gold button
    // whose every press is refused.
    const blocked = await newLeaseBlocksEarlyEnd(q, leaseId, 'landlord')
    if (blocked) return out('new_lease_waiting', blocked, base)
  }
  if (lease.supersedes_lease_id || lease.renews) {
    return out('renewal', 'This lease renews one the household already lives under, so its bills are ordinary rent they owe. ' +
      endStep(stepThroughMoveOut(o.reader, { noticeOnFile: lease.notice_on_file === true })), base)
  }
  // Final fix (fix pass 2, review): a move that only followed the unpaid hold
  // to another site before arrival is not a household moving spaces — whether
  // they ever arrived is the check-in history, read just below.
  if (lease.unit_moved_on && lease.moved_only_with_hold !== true) {
    return out('moved_spaces', 'This household moved to this space from another one on the same lease, so they live here and what it owes stays owed. ' +
      endStep(stepThroughMoveOut(o.reader, { noticeOnFile: lease.notice_on_file === true })), base)
  }
  if (lease.walkthrough_on || lease.checked_in_on) {
    return out('moved_in', (lease.walkthrough_on
      ? `A move-in walkthrough was finalized on ${dayWords(lease.walkthrough_on)}, so they moved in. `
      : `Their stay was checked in on ${dayWords(lease.checked_in_on)}${
          lease.booking_status_now && !['checked_in', 'checked_out'].includes(lease.booking_status_now)
            ? ` (the Schedule shows it as ${((BOOKING_STATUS_LABEL as Record<string, string>)[lease.booking_status_now] ?? lease.booking_status_now)} now)`
            : ''}, so they moved in. `) +
      (ended ? OWED_STAYS
        : notInForce ? notStartedStepWords(lease, o.reader)
        : !o.reader || (o.reader.canMarkLeaving && o.reader.canMoveOut)
          ? `End the lease with a move-out instead: use ${moveOutPath({ noticeOnFile: lease.notice_on_file === true })}.`
          : `End the lease with a move-out instead: ask the landlord to use ${moveOutPath({ noticeOnFile: lease.notice_on_file === true })}.`), base)
  }
  // Step 9 final fix (fix pass 1): the stay this lease was drafted from, still
  // showing on the Schedule as coming, is canceled by the close (attested
  // only). The Schedule's own Cancel reservation cancels it itself.
  const lb = lease.live_booking as { id: string; unit_id: string; landlord_id: string; guest_name: string | null; status: string; check_in: string | null } | null
  const reservation: NeverMovedInReservation | null = o.attested && lb && lb.id !== o.cancelingBooking
    ? { bookingId: lb.id, unitId: lb.unit_id, landlordId: lb.landlord_id, guestName: lb.guest_name, status: lb.status, checkIn: lb.check_in }
    : null
  // Every bill of the lease, oldest first — a voided one too, so the move-in
  // bill is always the FIRST bill the lease ever had (decisions #53): once it
  // is voided (closed before, or taken back), a later bill never takes its
  // place and is never zeroed as if it were the move-in bill.
  const allInvoices = (await q(
    `SELECT id, is_opening_balance, status FROM invoices WHERE lease_id = $1 ORDER BY created_at, due_date, id
      ${o.lock ? 'FOR UPDATE' : ''}`,
    [leaseId])).rows
  const invoices = allInvoices.filter((i: any) => i.status !== 'void')
  if (invoices.some((i: any) => i.is_opening_balance)) {
    return out('opening_balance', 'This lease carries a balance brought in from before GAM, so what it owes stays owed. ' +
      endStep(stepThroughMoveOut(o.reader, { noticeOnFile: lease.notice_on_file === true })), base)
  }
  if (!o.attested && invoices.length !== 1) return out('second_bill', null, base)
  // Every open bill: what was paid or is on its way on ANY of them decides
  // whether the close applies at all (money paid on a later month is money
  // paid on the lease).
  const invoiceIds: string[] = invoices.map((i: any) => i.id)
  // Decisions #53: the ONE bill the close zeroes and voids — the move-in bill,
  // the lease's first invoice, while it is still open.
  const moveInIds: string[] = allInvoices.length > 0 && allInvoices[0].status !== 'void' ? [allInvoices[0].id] : []
  // GAM's own lines are GAM's, never the lease's money: neither what was paid
  // on them nor a payment on them decides anything here (and they stay owed).
  const scope = `(p.lease_id = $1 OR p.invoice_id = ANY($2::uuid[]))`
  const leaseMoney = `${scope} AND p.revenue_owner IS DISTINCT FROM 'gam'`
  // Step 9 final fix (fix pass 1): a bank pull set to be tried again that
  // carries ONLY this lease's lines (GAM's own included) — the close stops it
  // (creditUse.supersedeScheduledRetry clears its schedule and gives back what
  // it set aside; its intent is canceled after the commit). Its rows, its
  // receipt and the credit it set aside are therefore not "on its way".
  //
  // Decisions #53: only a pull whose every row is on the MOVE-IN bill ($3) —
  // a pull that also carries a later bill's rent (which stays owed) is not
  // stopped; the close waits for it, as for any pull that pays something else.
  const stoppableAt = (n: number) => `(SELECT DISTINCT s.stripe_payment_intent_id FROM payments s
                       WHERE s.invoice_id = ANY($${n}::uuid[])
                         AND s.status = 'failed' AND s.next_retry_at IS NOT NULL AND s.stripe_payment_intent_id IS NOT NULL
                         AND NOT EXISTS (SELECT 1 FROM payments o
                                          WHERE o.stripe_payment_intent_id = s.stripe_payment_intent_id
                                            AND NOT COALESCE(o.invoice_id = ANY($${n}::uuid[]), FALSE)))`
  // The money query below carries the move-in bill as $3; the held query as $2.
  const stoppable = stoppableAt(3)
  // Fix pass 2: what was paid, told apart so the words are true — money
  // settled on a line (or paid from a deposit), account credit or paid-ahead
  // money spent on one, and a payment the bank sent back (never counted as
  // paid: the bank took it back).
  //
  // Fix pass 3 (review, HIGH): a receipt's applications count by what became
  // of the receipt. A card or bank payment writes its applications when it
  // STARTS (rentCharge — the receipt 'processing'); a decline or a bounce marks
  // the receipt 'failed' and leaves them in place. Counting any application
  // as "paid" refused for good, as "Money was already paid", the tenant who
  // tried to pay the move-in bill and was declined — the usual never-paid
  // case — and sent staff to a move-out that bills rent for a tenancy that
  // never happened. Now: a SETTLED receipt's applications are money paid; a
  // receipt still 'processing' (clearing, or a bank pull set to be tried
  // again) is money on its way; a FAILED one is nothing.
  const moved = (await q(
    `SELECT COALESCE(SUM(p.amount) FILTER (WHERE (p.status = 'settled' AND p.amount > 0) OR p.status = 'paid_via_deposit'), 0)::text AS paid,
            COUNT(*) FILTER (WHERE (p.status = 'settled' AND p.amount > 0)
                                OR p.status = 'paid_via_deposit'
                                OR EXISTS (SELECT 1 FROM remittance_applications x
                                             JOIN tenant_remittances xr ON xr.id = x.remittance_id
                                            WHERE x.payment_id = p.id AND xr.status = 'settled'))::int AS paid_n,
            COALESCE(SUM(p.amount) FILTER (WHERE p.type = 'deposit' AND ((p.status = 'settled' AND p.amount > 0) OR p.status = 'paid_via_deposit')), 0)::text AS deposit_paid,
            COALESCE(SUM(ABS(p.amount)) FILTER (WHERE p.status = 'returned'), 0)::text AS returned,
            COUNT(*) FILTER (WHERE p.status = 'returned')::int AS returned_n,
            COALESCE(SUM((SELECT SUM(x.amount) FROM credit_uses x WHERE x.payment_id = p.id AND x.status = 'applied'))
                     FILTER (WHERE p.status NOT IN ('settled', 'paid_via_deposit')), 0)::text AS credit_spent,
            COUNT(*) FILTER (WHERE (p.stripe_payment_intent_id IS NULL OR p.stripe_payment_intent_id NOT IN ${stoppable})
                               AND (p.status = 'processing'
                                    OR (p.status = 'pending' AND p.stripe_payment_intent_id IS NOT NULL)
                                    OR (p.status = 'failed' AND p.next_retry_at IS NOT NULL)
                                    OR EXISTS (SELECT 1 FROM remittance_applications x
                                                 JOIN tenant_remittances xr ON xr.id = x.remittance_id
                                                WHERE x.payment_id = p.id AND xr.status = 'processing'
                                                  AND (xr.stripe_payment_intent_id IS NULL OR xr.stripe_payment_intent_id NOT IN ${stoppable}))
                                    OR EXISTS (SELECT 1 FROM credit_uses x WHERE x.payment_id = p.id AND x.status = 'held')))::int AS moving_n,
            -- Fix pass 3: a bank pull that failed and is set to be tried again
            -- — the day of its next try, said on the property's calendar. Only
            -- one the close cannot stop (it also pays something else).
            to_char(MIN(p.next_retry_at) FILTER (WHERE p.status = 'failed' AND p.next_retry_at IS NOT NULL
                                                   AND p.stripe_payment_intent_id NOT IN ${stoppable})
                      AT TIME ZONE COALESCE((SELECT pr.timezone FROM leases ll JOIN units u ON u.id = ll.unit_id
                                               JOIN properties pr ON pr.id = u.property_id WHERE ll.id = $1::uuid), 'America/Phoenix'),
                    'YYYY-MM-DD') AS retry_on
       FROM payments p
      WHERE ${leaseMoney}`,
    [leaseId, invoiceIds, moveInIds])).rows[0]
  // Fix pass 2: money that sits ON the lease without a settled line there —
  // the tenant's either way, so closing as if nothing was paid would strand
  // it (and "Nothing was paid, so nothing is refunded" would be untrue):
  //   - paid-ahead money (lease_prepaid_credits) — including money a landlord
  //     left as their credit that followed them onto this lease;
  //   - a deposit record with money in it (carried over by a renewal or a move
  //     between leases, or paid in);
  //   - account credit given on this lease and not spent;
  //   - money received and not yet put toward a bill.
  // And money on its way: a receipt still clearing (not one whose pull the
  // close stops), or the tenant's report that they paid at the bank, not yet
  // matched (closing would leave it with nothing to settle when the bank line
  // comes in).
  const held = (await q(
    `SELECT
       (SELECT COALESCE(SUM(c.amount_remaining), 0) FROM lease_prepaid_credits c
         WHERE c.lease_id = $1 AND c.voided_at IS NULL AND c.amount_remaining > 0)::text AS paid_ahead,
       (SELECT COALESCE(SUM(sd.collected_amount), 0) FROM security_deposits sd
         WHERE sd.lease_id = $1 AND COALESCE(sd.collected_amount, 0) > 0)::text AS deposit,
       EXISTS (SELECT 1 FROM security_deposits sd
                WHERE sd.lease_id = $1 AND sd.carried_from_deposit_id IS NOT NULL AND COALESCE(sd.collected_amount, 0) > 0) AS deposit_carried,
       (SELECT COALESCE(SUM(tc.amount_remaining), 0) FROM tenant_credits tc
         WHERE tc.lease_id = $1 AND tc.status = 'active' AND tc.voided_at IS NULL AND tc.amount_remaining > 0)::text AS credit,
       (SELECT COALESCE(SUM(r.unapplied_amount), 0) FROM tenant_remittances r
         WHERE r.lease_id = $1 AND r.status = 'settled' AND r.unapplied_amount > 0
           AND NOT EXISTS (SELECT 1 FROM lease_prepaid_credits c WHERE c.source_remittance_id = r.id))::text AS unapplied,
       (SELECT COUNT(*) FROM tenant_remittances r WHERE r.lease_id = $1 AND r.status = 'processing'
           AND (r.stripe_payment_intent_id IS NULL OR r.stripe_payment_intent_id NOT IN ${stoppableAt(2)}))::int AS clearing_n,
       (SELECT json_build_object('amount', d.amount::text, 'day', to_char(d.declared_date, 'YYYY-MM-DD'))
          FROM tenant_declared_deposits d
         WHERE d.lease_id = $1 AND d.status = 'pending'
         ORDER BY d.declared_date, d.created_at LIMIT 1) AS reported`,
    [leaseId, moveInIds])).rows[0]
  const cents = (v: unknown) => Math.round(Number(v ?? 0) * 100)
  const money = centsWords
  const facts: string[] = []
  // Step 9 final fix (fix pass 1 of #53, review MEDIUM): money paid toward
  // the reservation, once the lease has a move-in bill (the bill is where the
  // reservation money goes — a lease never billed has taken none of it). The
  // close's gate is "refused for a lease anything was ever paid on": before,
  // a reservation deposit bigger than the first rent left paid-ahead money
  // and was refused, while a smaller one (taken off the rent line) was
  // ignored — the close zeroed the bill and said "Nothing was paid".
  const reservationCents = allInvoices.length > 0
    ? cents(lease.reservation_paid) - cents(lease.reservation_leftover) : 0
  if (reservationCents > 0) facts.push(`${money(reservationCents)} was paid toward the reservation this lease was drafted from`)
  if ((moved?.paid_n ?? 0) > 0) facts.push(cents(moved.paid) > 0 ? `${money(cents(moved.paid))} was already paid on this lease` : 'Money was already paid on this lease')
  if (cents(moved?.credit_spent) > 0) facts.push(`${money(cents(moved.credit_spent))} of their credit was already used on its bills`)
  if (cents(held?.paid_ahead) > 0) facts.push(`${money(cents(held.paid_ahead))} they paid ahead is on this lease`)
  // A deposit paid on this lease's own bill raised its record too: counted
  // once, as paid above. Only the rest of the record (carried over, or paid
  // some other way) is said here.
  const depositBeyondLines = cents(held?.deposit) - cents(moved?.deposit_paid)
  if (depositBeyondLines > 0) {
    facts.push(held.deposit_carried === true
      ? `${money(depositBeyondLines)} of security deposit carried over from their last lease is on this lease`
      : `${money(depositBeyondLines)} of security deposit was paid toward this lease`)
  }
  if (cents(held?.credit) > 0) facts.push(`${money(cents(held.credit))} of account credit is on this lease`)
  if (cents(held?.unapplied) > 0) facts.push(`${money(cents(held.unapplied))} they paid has not been put toward a bill yet`)
  if (facts.length === 0 && (moved?.returned_n ?? 0) > 0) {
    facts.push(`A ${money(cents(moved.returned))} payment on this lease was sent back by their bank`)
  }
  if (facts.length > 0) {
    const first = facts[0].charAt(0).toUpperCase() + facts[0].slice(1)
    const said = facts.length === 1 ? first
      : `${[first, ...facts.slice(1, -1)].join(', ')} and ${facts[facts.length - 1]}`
    // Fix pass 3: a lease not yet in force is told the step that starts it
    // (a landlord who never signed it signs it; never "when it starts" on a
    // day gone by), and a leaving date on file names only Move out.
    const next = ended ? OWED_STAYS
      : notInForce
        ? notStartedStepWords(lease, o.reader)
        : moveOutStepWords(o.reader, { noticeOnFile: lease.notice_on_file === true })
    return out('money_paid', `${said}, so it can’t be closed as if nothing happened. ${next}`, base)
  }
  if (held?.reported) {
    return out('payment_on_its_way',
      `The tenant reported paying ${money(cents(held.reported.amount))} at the bank on ${dayWords(held.reported.day)}, and it hasn’t been matched yet, ` +
      'so the lease can’t be closed as if nothing was paid. Match it on the Bank page when it shows up (or wait for the report to lapse), then try again.', base)
  }
  if (moved?.retry_on) {
    return out('payment_on_its_way',
      `A bank payment on this lease didn’t go through and is set to be tried again on ${dayWords(moved.retry_on)}. ` +
      'That try also pays other bills the household owes, so it can’t be stopped here and the lease can’t be closed yet. ' +
      'Try again once that try clears or fails.', base)
  }
  if ((moved?.moving_n ?? 0) > 0 || (held?.clearing_n ?? 0) > 0) {
    return out('payment_on_its_way',
      'A payment on this lease is still on its way, so it can’t be closed yet. Try again once it clears or fails — usually within a few days.', base)
  }
  // Step 9 final fix (fix pass 1): a charge the landlord recorded that waits
  // on this lease for its next bill would be lost with the lease (no bill run
  // reaches an ended lease) — refused, naming it, as the void refuses.
  const waiting = await recordedChargesTheVoidStrands(q, leaseId, { waitingOnly: true })
  if (waiting.length > 0) {
    const one = waiting.length === 1
    const next = waiting.every(r => r.cancelable)
      ? `If ${one ? 'it should' : 'they should'} not be billed, cancel ${one ? 'it' : 'them'} on the tenant’s page first, then try again.`
      : ended ? OWED_STAYS
      : notInForce
        ? notStartedStepWords(lease, o.reader)
        : moveOutStepWords(o.reader, { noticeOnFile: lease.notice_on_file === true })
    return out('recorded_charge',
      `You recorded ${one ? 'a charge' : 'charges'} for this household that ${one ? 'waits' : 'wait'} on this lease for its next bill: ` +
      `${listInWords(waiting.map(r => r.words))}. Ending the lease would leave ${one ? 'it' : 'them'} with no bill to go on, ` +
      `so it can’t be closed this way. ${next}`, base)
  }
  // Every unpaid line the lease owes (attested: every open bill and any line
  // on no bill; an ordinary end: the move-in bill only). Decisions #53: only a
  // line on the MOVE-IN bill is zeroed — every other one stays owed and the
  // confirm lists it ('later_bill'), as it lists GAM's own fees and the
  // charges billed on purpose.
  const rows = (await q(
    `SELECT p.id, p.type, p.amount::text AS amount, to_char(p.due_date, 'YYYY-MM-DD') AS due_date,
            p.entry_description, p.notes, lf.fee_type, NULLIF(btrim(lf.description), '') AS fee_description,
            EXISTS (SELECT 1 FROM utility_bills ub WHERE ub.payment_id = p.id) AS utility,
            COALESCE(p.invoice_id = ANY($3::uuid[]), FALSE) AS on_move_in_bill,
            ${keptThroughNeverMovedInSql('p')} AS kept,
            CASE WHEN p.type = 'rent' THEN to_char(p.due_date, 'YYYY-MM-DD') END AS period_start,
            CASE WHEN p.type = 'rent' THEN to_char(LEAST(
                   (p.due_date + interval '1 month' - interval '1 day')::date,
                   COALESCE((SELECT MIN(nx.due_date) - 1 FROM payments nx
                              WHERE nx.lease_id = $1::uuid AND nx.type = 'rent' AND nx.due_date > p.due_date
                                AND nx.status <> 'voided'), 'infinity'::date),
                   COALESCE((SELECT le.end_date FROM leases le WHERE le.id = $1::uuid), 'infinity'::date)),
                 'YYYY-MM-DD') END AS period_end
       FROM payments p
       LEFT JOIN lease_fees lf ON lf.id = p.lease_fee_id
      WHERE ${o.attested
        ? `(p.invoice_id = ANY($2::uuid[]) OR (p.lease_id = $1::uuid AND p.invoice_id IS NULL))`
        : `(p.invoice_id = ANY($3::uuid[]) AND $1::uuid IS NOT NULL AND $2::uuid[] IS NOT NULL)`}
        AND p.status IN ('pending', 'failed')
        AND p.amount > 0
      ORDER BY p.due_date NULLS LAST, (p.type = 'rent') DESC, p.type, p.id
      ${o.lock ? 'FOR UPDATE OF p' : ''}`, [leaseId, invoiceIds, moveInIds])).rows
  const labelOf = (r: any): string => r.fee_description
    ?? (r.fee_type ? (LEASE_COLUMN_LABEL as Record<string, string>)[r.fee_type] : undefined)
    ?? (r.type === 'fee' || r.type === 'late_fee' ? chargeLabel(r.entry_description, r.notes) : undefined)
    ?? NEVER_MOVED_IN_TYPE_LABEL[r.type as PaymentType]
    ?? 'Charge'
  const keptWhy = (r: any): NeverMovedInKeptWhy | null =>
    (r.kept as NeverMovedInKeptWhy | null) ?? (r.on_move_in_bill === true ? null : 'later_bill')
  const toZero = rows.filter((r: any) => keptWhy(r) === null)
  const kept: NeverMovedInKeptLine[] = rows.filter((r: any) => keptWhy(r) !== null).map((r: any) => ({
    paymentId: r.id, label: labelOf(r), amount: Math.round(Number(r.amount) * 100) / 100, why: keptWhy(r)!,
    dueDate: r.due_date ?? null,
    periodStart: keptWhy(r) === 'later_bill' ? r.period_start ?? null : null,
    periodEnd: keptWhy(r) === 'later_bill' ? r.period_end ?? null : null,
  }))
  const keptTotal = Math.round(kept.reduce((t, l) => t + Math.round(l.amount * 100), 0)) / 100
  if (toZero.length === 0 && !o.attested) return out('nothing_to_close', null, { ...base, invoiceIds: moveInIds })
  if (toZero.length === 0 && ended) {
    return out('ended', kept.length > 0
      ? `This lease has already ended and nothing on it is left to close. ${keptWordsFor(kept)}`
      : 'This lease has already ended and nothing on it is still owed. Nothing else to do.', { ...base, kept, keptTotal, keptWords: keptWordsFor(kept) })
  }
  const lines: NeverMovedInLine[] = toZero.map((r: any) => ({
    paymentId: r.id,
    label: labelOf(r),
    amount: Math.round(Number(r.amount) * 100) / 100,
    dueDate: r.due_date,
    utility: r.utility === true,
  }))
  const total = Math.round(lines.reduce((t, l) => t + Math.round(l.amount * 100), 0)) / 100
  return {
    // The close voids the move-in bill only — never a later bill (#53).
    applies: true, whyNot: null, words: null, ...base, invoiceIds: moveInIds, lines, total,
    kept, keptTotal, keptWords: keptWordsFor(kept), reservation,
  }
}

/** Plain words for the reservation a never-moved-in close cancels with the lease (the confirm shows them). */
export function reservationCanceledWords(r: NeverMovedInReservation): string {
  const status = (BOOKING_STATUS_LABEL as Record<string, string>)[r.status] ?? r.status
  return `The reservation it came from (${r.guestName ? `${r.guestName}, ` : ''}checking in ${dayWords(r.checkIn)}) still shows on the Schedule as ` +
    `${status.toLowerCase()} — it is canceled with the lease, so the space is free on the Schedule.`
}

/** The note a never-moved-in close writes on the reservation's history. */
const RESERVATION_CANCELED_SUMMARY = (guest: string | null) =>
  `Reservation for ${guest || 'Guest'} canceled — they never moved in, and the lease drafted from it was ended`

/**
 * The close itself (decisions #46.4): called inside the transaction that ENDS
 * the lease — routes/leases.ts (PATCH status 'terminated' / 'expired', and
 * "They never moved in — end the lease" / Discard on a lease the tenant
 * signed) and routes/units.ts (Cancel reservation, through
 * endLeaseNeverMovedIn) — BEFORE the lease's status is changed in that same
 * transaction, so it reads the status the lease had, under the household lock
 * it takes. assessNeverMovedIn decides whether it applies (read under the
 * locks here).
 *
 * Then every unpaid line ON THE MOVE-IN BILL — rent, fees, deposits, rent
 * paid ahead, late fees — is zeroed and marked settled with
 * NEVER_MOVED_IN_NOTE (decisions #53: only the move-in bill; a later bill
 * stays owed, untouched, on its own invoice) (the row and its
 * history stay) — a line a payment was tried on too, until the reports' Money
 * billed leaves 'voided' rows out (fix pass 2; see the UPDATE below). The bills are voided, a bank retry on them is stopped (its intent
 * returned to cancel after COMMIT), a utility charge goes back on hold so the
 * landlord does not lose it, and a deposit record that never had a dollar is
 * removed (as the void does). GAM's own fees and charges billed on purpose
 * stay owed, taken off the voided bill so they stand on their own. The stay
 * the lease came from, still showing as coming, is canceled too. When it does
 * not apply, nothing changes: an ordinary lease end, and what was owed stays
 * owed. Returns what it closed, and the assessment (so a caller can refuse in
 * its words).
 */
export async function closeNeverMovedInBill(
  client: PoolClient, leaseId: string,
  o: { attested?: boolean; reader?: NeverMovedInReader; cancelingBooking?: string; actorUserId?: string | null } = {},
): Promise<{
  closed: boolean; invoiceId: string | null; invoiceIds: string[]; closedAmount: number
  closedPaymentIds: string[]; cancelAfterCommit: string[]; voidedDocumentIds: string[]; assessment: NeverMovedInAssessment
  /** The reservation canceled with the lease (its site's waitlist may be told after the commit). */
  canceledBooking: NeverMovedInReservation | null
}> {
  const q: Q = (text, params) => client.query(text, params)
  const a = await assessNeverMovedIn(q, leaseId, {
    attested: o.attested === true, lock: true, reader: o.reader, cancelingBooking: o.cancelingBooking,
  })
  if (!a.applies) {
    return {
      closed: false, invoiceId: null, invoiceIds: [], closedAmount: 0, closedPaymentIds: [], cancelAfterCommit: [],
      voidedDocumentIds: [], assessment: a, canceledBooking: null,
    }
  }
  const ids = a.lines.map(l => l.paymentId)
  // A bank retry carrying only this lease's lines stops here (the assessment
  // waited for one that also pays something else). GAM's own lines on the
  // same pull lose its schedule with it and stay owed.
  const cancelAfterCommit = ids.length > 0 ? (await supersedeScheduledRetry(client, ids)).cancelAfterCommit : []
  // A utility charge on the bill is real usage on the space: back on hold for
  // whoever the space is billed to next, out of its one-per-cycle slot.
  for (const b of (await q(
    `SELECT * FROM utility_bills WHERE payment_id = ANY($1::uuid[])`, [ids])).rows) {
    await holdUtilityBillAgain(q, b, {
      released: 'held again: the tenant it was billed to never moved in',
      raised: 'held: the tenant this was billed to never moved in',
    })
    await q(`UPDATE utility_bills SET payment_id = NULL WHERE id = $1`, [b.id])
    await q(`DELETE FROM utility_bills WHERE id = $1`, [b.id])
  }
  if (ids.length > 0) {
    // Every line is zeroed with the note (its row and its history stay) —
    // a line a payment was tried on (a declined card, a bounced bank pull)
    // too. Step 9 final fix (fix pass 2, review): decisions #48.5 would give
    // such a line the recorded 'voided' status with its amount kept, but the
    // reports' Money billed (services/incomeBasis payCte / ownBilledPartsSql,
    // round 4a's file) still reads a 'voided' row at its full amount as
    // "still owed" — the landlord would see the whole move-in bill owed by
    // nobody, on the usual never-paid close (a declined card). Until Money
    // billed leaves voided rows out, these lines are zeroed and settled as
    // before, so they drop out of every report and balance at $0.
    await q(
      `UPDATE payments p
          SET amount = 0, status = 'settled', settled_at = NOW(), next_retry_at = NULL, platform_held = FALSE,
              notes = LEFT(COALESCE(p.notes || E'\\n', '') || $2, 2000)
        WHERE p.id = ANY($1::uuid[]) AND p.status IN ('pending', 'failed')`,
      [ids, NEVER_MOVED_IN_NOTE])
  }
  if (a.invoiceIds.length > 0) {
    // What stays owed (GAM's own fees, charges billed on purpose) stands on
    // its own, off the bill being voided, so it is never hidden inside a
    // voided bill.
    if (a.kept.length > 0) {
      await q(
        `UPDATE payments SET invoice_id = NULL
          WHERE id = ANY($1::uuid[]) AND invoice_id = ANY($2::uuid[])`,
        [a.kept.map(k => k.paymentId), a.invoiceIds])
    }
    await q(
      `UPDATE invoices SET status = 'void', total_amount = 0, updated_at = NOW(),
              notes = LEFT(COALESCE(notes || E'\\n', '') || $2, 2000)
        WHERE id = ANY($1::uuid[])`, [a.invoiceIds, NEVER_MOVED_IN_NOTE])
  }
  await q(
    `DELETE FROM security_deposits
      WHERE lease_id = $1 AND status = 'pending'
        AND COALESCE(collected_amount, 0) = 0
        AND carried_from_deposit_id IS NULL
        AND COALESCE(flex_deposit_enabled, FALSE) = FALSE`, [leaseId])
  // Fix pass 2: the lease's own paperwork still waiting for signatures ends
  // with it. A lease the tenant signed and the landlord had not: left open,
  // the landlord's signature later issued it (buildLeaseFromDocument) and
  // billed a household for a lease that had already ended. A roommate's
  // signature still to come would have completed a document for an ended
  // lease. Voided documents can't be signed (routes/esign), and stay
  // readable. Home-sale paperwork (a purchase agreement, a bill of sale, a
  // general contract) is not the lease's and is left alone.
  const voidedDocumentIds: string[] = (await q(
    `UPDATE lease_documents
        SET status = 'voided', voided_at = NOW(), updated_at = NOW(), void_reason = $2
      WHERE lease_id = $1
        AND status IN ('pending', 'sent', 'in_progress')
        AND document_type IN ('original_lease', 'addendum_add', 'addendum_remove', 'addendum_terms',
                              'work_trade_addendum', 'sublease_agreement')
      RETURNING id`, [leaseId, `The lease ended: ${NEVER_MOVED_IN_REASON.charAt(0).toLowerCase()}${NEVER_MOVED_IN_REASON.slice(1)}`])).rows.map((r: any) => r.id)
  if (voidedDocumentIds.length > 0) {
    // As every void does (lib/voidDocument): a voided document's money
    // changes never reach billing.
    await q(
      `UPDATE scheduled_lease_changes SET status = 'cancelled', updated_at = NOW()
        WHERE source_document_id = ANY($1::uuid[]) AND status IN ('draft', 'scheduled')`, [voidedDocumentIds])
  }
  // Step 9 final fix (fix pass 1): the stay the lease came from, still showing
  // as coming, is canceled with it (its row was locked first, in the
  // assessment) — the same end state as the Schedule's Cancel reservation.
  let canceledBooking: NeverMovedInReservation | null = null
  if (a.reservation) {
    const done = (await q(
      `UPDATE unit_bookings
          SET status = 'cancelled', cancelled_at = COALESCE(cancelled_at, NOW()), updated_at = NOW()
        WHERE id = $1 AND status IN ('tentative', 'confirmed')
        RETURNING id`, [a.reservation.bookingId])).rows.length > 0
    if (done) {
      canceledBooking = a.reservation
      await recordBookingEvent({
        client, bookingId: a.reservation.bookingId, unitId: a.reservation.unitId, landlordId: a.reservation.landlordId,
        eventType: 'cancelled', summary: RESERVATION_CANCELED_SUMMARY(a.reservation.guestName),
        detail: { from_status: a.reservation.status, never_moved_in_lease_id: leaseId }, actorUserId: o.actorUserId ?? null,
      })
    }
  }
  return {
    closed: true, invoiceId: a.invoiceIds[0] ?? null, invoiceIds: a.invoiceIds, closedAmount: a.total,
    closedPaymentIds: ids, cancelAfterCommit, voidedDocumentIds, assessment: a, canceledBooking,
  }
}

/**
 * The household comes off a lease that ended, and the space empties when no
 * other lease is in force or waiting on it. One copy for every door that ends
 * a lease (routes/leases.ts PATCH status, "They never moved in", the
 * Schedule's Cancel reservation).
 */
export async function cascadeLeaseEnd(c: { query: PoolClient['query'] }, leaseId: string, unitId: string): Promise<void> {
  // Final sweep (10/3): an add-a-roommate spot nobody signed ('pending_add')
  // never joined this lease, so it is void (as voiding its addendum leaves
  // it, lib/leaseDocCascade.ts), not 'removed' / lease_ended like the
  // people who were on it. Both stamp updated_at (this one never did).
  await c.query(
    `UPDATE lease_tenants SET status='void', updated_at=NOW() WHERE lease_id=$1 AND status='pending_add'`,
    [leaseId])
  await c.query(
    `UPDATE lease_tenants
     SET status='removed',
         removed_at=NOW(),
         removed_reason='lease_ended',
         updated_at=NOW()
     WHERE lease_id=$1 AND status IN ('active','pending_remove')`,
    [leaseId])
  // The space empties only when no other lease is in force or waiting on it
  // (as lib/unwindIssuedLease and services/unitMove do): ending a pending
  // lease whose start date has passed must not empty the space the lease
  // that replaced it occupies.
  await c.query(
    `UPDATE units SET status='vacant', updated_at=NOW()
      WHERE id=$1
        AND NOT EXISTS (SELECT 1 FROM leases l
                         WHERE l.unit_id = $1 AND l.id <> $2 AND l.status IN ('active','pending'))`,
    [unitId, leaseId])
  await c.query('UPDATE leases SET terminated_at=NOW() WHERE id=$1 AND terminated_at IS NULL', [leaseId])
}

/**
 * The people on a lease and its space, by name — the never-moved-in confirm
 * on the Schedule shows who the close is about (staff screens show attached
 * people by name). Everyone on it now, or taken off it when it ended.
 */
export async function leaseHouseholdNames(q: Q, leaseId: string): Promise<{
  tenantNames: string[]; unitNumber: string | null; propertyName: string | null
}> {
  const space = (await q(
    `SELECT u.unit_number, p.name AS property_name
       FROM leases l JOIN units u ON u.id = l.unit_id JOIN properties p ON p.id = u.property_id
      WHERE l.id = $1`, [leaseId])).rows[0]
  const people = (await q(
    `SELECT btrim(COALESCE(tu.first_name, '') || ' ' || COALESCE(tu.last_name, '')) AS name
       FROM lease_tenants lt
       JOIN tenants t ON t.id = lt.tenant_id
       JOIN users tu ON tu.id = t.user_id
      WHERE lt.lease_id = $1
        AND (lt.status IN ('active', 'pending_remove', 'pending_add')
             OR (lt.status = 'removed' AND lt.removed_reason = 'lease_ended'))
      ORDER BY CASE lt.role WHEN 'primary' THEN 0 ELSE 1 END, lt.added_at ASC NULLS LAST, lt.created_at ASC`,
    [leaseId])).rows
  return {
    tenantNames: people.map((x: any) => String(x.name ?? '')).filter((n: string) => n.length > 0),
    unitNumber: space?.unit_number ?? null,
    propertyName: space?.property_name ?? null,
  }
}

/** The plain-words 409 when what the lease owes changed since the confirm opened. */
export const NEVER_MOVED_IN_CHANGED_WORDS = 'What this lease owes changed since you opened this, so nothing was closed. ' +
  'The window now shows what would be zeroed — check it and confirm again.'

/**
 * The one close for a lease the tenant never moved into (decisions #46.4),
 * inside the caller's transaction: zero the unpaid move-in bill and void it
 * (decisions #53 — a later bill stays owed), end
 * the lease and take the household off it (a lease that already ended keeps
 * its status — only what is left on it is closed), cancel the stay it was
 * drafted from. Refuses (AppError 409, nothing changed once the caller rolls
 * back) in the assessment's plain words when it does not apply, and when
 * `expectedTotal` (what the confirm showed) is not what it would zero now.
 * Used by "They never moved in — end the lease" / Discard (routes/leases.ts)
 * and by Cancel reservation on the Schedule (routes/units.ts, with
 * `cancelingBooking` and `refusalLead`). The caller cancels
 * `cancelAfterCommit` after COMMIT (creditUse.cancelSupersededIntents).
 */
export async function endLeaseNeverMovedIn(
  client: PoolClient, lease: { id: string; unit_id: string },
  o: {
    reader?: NeverMovedInReader; expectedTotal?: number; cancelingBooking?: string; actorUserId?: string | null
    /** Said before the assessment's words on a refusal (the Schedule's cancel). */
    refusalLead?: string
  } = {},
): Promise<Awaited<ReturnType<typeof closeNeverMovedInBill>>> {
  const closed = await closeNeverMovedInBill(client, lease.id, {
    attested: true, reader: o.reader, cancelingBooking: o.cancelingBooking, actorUserId: o.actorUserId,
  })
  if (!closed.closed) {
    const words = closed.assessment.words ?? 'This lease can’t be closed as never moved in.'
    throw new AppError(409, o.refusalLead ? `${o.refusalLead}${words.charAt(0).toLowerCase()}${words.slice(1)}` : words)
  }
  if (o.expectedTotal !== undefined && Math.round(o.expectedTotal * 100) !== Math.round(closed.closedAmount * 100)) {
    throw new AppError(409, NEVER_MOVED_IN_CHANGED_WORDS)
  }
  if (!closed.assessment.alreadyEnded) {
    await client.query(
      `UPDATE leases
          SET status = 'terminated', needs_review = FALSE, updated_at = NOW(),
              termination_reason = COALESCE(termination_reason, $2)
        WHERE id = $1`, [lease.id, NEVER_MOVED_IN_REASON])
    await cascadeLeaseEnd(client, lease.id, lease.unit_id)
  }
  return closed
}

export async function unwindIssuedLease(
  q: Q,
  doc: { id: string; lease_id: string | null; issued_at: string | Date | null; unit_id: string | null },
): Promise<{ unwound: boolean }> {
  if (!doc.issued_at || !doc.lease_id) return { unwound: false }
  const leaseId = doc.lease_id

  // S655: the household lock first (household, then its leases, then rows).
  await lockLeaseHousehold(q, leaseId)

  const lease = (await q(
    `SELECT id, unit_id, status, start_date FROM leases WHERE id = $1 FOR UPDATE`, [leaseId])).rows[0]
  if (!lease) return { unwound: false }

  const moved = (await q(
    `SELECT COUNT(*)::int AS n FROM payments
      WHERE lease_id = $1 AND status IN ('settled','processing','paid_via_deposit')`,
    [leaseId])).rows[0].n
  if (moved > 0) {
    throw new AppError(409,
      'Money has already been paid on this lease, so it cannot be voided. ' +
      'Create a superseding document instead.')
  }

  // S655: a charge a payment was tried on is a record GAM keeps (and its
  // receipt or credit points at it, so it could not be removed anyway). Asked
  // up front, under the lock, so a refusal changes nothing.
  if (await countTriedCharges(q, leaseId) > 0) {
    throw new AppError(409,
      'A payment was tried on this lease\'s bill (it did not go through, or it is being tried again), ' +
      'so the lease cannot be voided. Create a superseding document instead.')
  }

  const renews: string | null = (await q(
    `SELECT renews_lease_id FROM lease_documents WHERE id = $1`, [doc.id])).rows[0]?.renews_lease_id ?? null

  // Charges the landlord recorded for real usage — a one-off charge, a
  // propane installment — on the bill being removed (they point at its rows)
  // or waiting on this lease for its next bill. A renewal sends them back to
  // the lease still in force (below). Any other lease has no lease in force to
  // carry them, and left on a terminated lease the bill run never reaches them
  // again: the landlord would lose the charge without a word. Until Nic
  // decides where such a charge goes, the void is refused, naming it, before
  // anything changes.
  if (!renews) {
    const recorded = await recordedChargesTheVoidStrands(q, leaseId)
    if (recorded.length > 0) {
      const one = recorded.length === 1
      // The next step that works: when every one of them is a charge not
      // billed yet, canceling it on the tenant's page lets this void go
      // through (a canceled charge is not stranded). A billed charge or a
      // propane payment has no cancel, so only the superseding document is
      // left. Where a stranded charge should go is still Nic's call.
      const next = recorded.every(r => r.cancelable)
        ? `If ${one ? 'it should' : 'they should'} not be billed, cancel ${one ? 'it' : 'them'} on the tenant's page first, ` +
          'then void this lease. Otherwise, create a superseding document.'
        : 'Create a superseding document instead.'
      throw new AppError(409,
        `You recorded ${one ? 'a charge' : 'charges'} for this household on this lease: ${listInWords(recorded.map(r => r.words))}. ` +
        `Voiding the lease would leave ${one ? 'it' : 'them'} with no lease to be billed on, so the lease cannot be voided. ` +
        next)
    }
  }

  // ── A renewal: the deposit goes back to the lease still in force ─────────
  // Before the pending-deposit cleanup below, which would otherwise delete a
  // carried record that was never collected.
  if (renews) {
    // The recorded charges the removed rows carried are released first — back
    // to waiting to be billed — so the rows can go (the delete used to fail on
    // them and take the whole void down), then follow the household to the
    // lease they are on (below).
    await q(
      `UPDATE tenant_one_off_charges
          SET status = 'pending', payment_id = NULL, billed_at = NULL, updated_at = NOW()
        WHERE payment_id IN (SELECT p.id FROM payments p WHERE ${VOID_REMOVES_SQL})`, [leaseId])
    await q(
      `UPDATE propane_fill_installments SET payment_id = NULL
        WHERE payment_id IN (SELECT p.id FROM payments p WHERE ${VOID_REMOVES_SQL})`, [leaseId])
    // The deposit record goes back, with the increase this renewal raised its
    // target by taken off. Nothing settled on it (refused above), and a top-up
    // the bank sent back always leaves its reopened charge behind, which
    // refuses the void too — so here the counted-once step finds nothing to
    // take off; it is the job holding a new lease that never starts that meets
    // a returned top-up (jobs/scheduler). The one copy of the move.
    await returnDepositCountedOnce(q, leaseId, renews)
    // The renewal request it completed is open again — the landlord still has
    // a renewal to decide.
    await q(
      `UPDATE lease_renewal_requests SET status = 'approved', updated_at = NOW()
        WHERE lease_id = $1 AND status = 'completed'`, [renews])
    // Anything the household owes that reached the renewal (the lease-end
    // hand-off moves open items onto it) goes back to the lease they are on.
    // Their utility usage is real and theirs: it returns unbilled to their
    // lease rather than going on hold like a move-in that never happened.
    for (const b of (await q(
      `SELECT id, payment_id FROM utility_bills WHERE lease_id = $1`, [leaseId])).rows) {
      await q(
        `UPDATE utility_bills
            SET lease_id = $2, payment_id = NULL,
                status = CASE WHEN status = 'billed' THEN 'unbilled' ELSE status END,
                updated_at = NOW()
          WHERE id = $1`, [b.id, renews])
      if (b.payment_id) {
        await q(`DELETE FROM payments WHERE id = $1 AND status IN ('pending','failed')`, [b.payment_id])
      }
    }
    await q(
      `UPDATE tenant_one_off_charges SET lease_id = $2, updated_at = NOW()
        WHERE lease_id = $1 AND status = 'pending'`, [leaseId, renews])
    await q(
      `UPDATE propane_fills f SET lease_id = $2
        WHERE f.lease_id = $1
          AND EXISTS (SELECT 1 FROM propane_fill_installments i
                       WHERE i.fill_id = f.id AND i.payment_id IS NULL)`, [leaseId, renews])
    // S655: a credit goes back when anything of it is still the household's —
    // money left on it, or money a payment in flight has set aside (if that
    // payment fails, it comes back to them on the lease they are on). A
    // withdrawn paid-ahead credit can never be used and stays put.
    await q(
      `UPDATE tenant_credits tc SET lease_id = $2, updated_at = NOW()
        WHERE tc.lease_id = $1 AND tc.status = 'active'
          AND (tc.amount_remaining > 0
               OR EXISTS (SELECT 1 FROM credit_uses u WHERE u.tenant_credit_id = tc.id AND u.status = 'held'))`,
      [leaseId, renews])
    await q(
      `UPDATE lease_prepaid_credits c SET lease_id = $2, updated_at = NOW()
        WHERE c.lease_id = $1 AND c.voided_at IS NULL
          AND (c.amount_remaining > 0
               OR EXISTS (SELECT 1 FROM credit_uses u WHERE u.prepaid_credit_id = c.id AND u.status = 'held'))`,
      [leaseId, renews])
    // Autopay set up on (or moved to) the renewal keeps pulling for the lease
    // they are on — unless that lease already has its own.
    await q(
      `UPDATE tenant_autopay SET lease_id = $2, updated_at = NOW()
        WHERE lease_id = $1
          AND NOT EXISTS (SELECT 1 FROM tenant_autopay x WHERE x.lease_id = $2)`, [leaseId, renews])
  }

  // ── Utility: back on hold, out of the unique slot ────────────────────────
  const bills = (await q(
    `SELECT * FROM utility_bills WHERE lease_id = $1`, [leaseId])).rows
  for (const b of bills) {
    await holdUtilityBillAgain(q, b, {
      released: 'held again: the lease it was released onto was voided',
      raised: 'held: the lease this was billed to was voided before the tenant signed',
    })
    // The bill points at its charge row, not the other way round.
    const paymentId = b.payment_id
    await q(`UPDATE utility_bills SET payment_id = NULL WHERE id = $1`, [b.id])
    if (paymentId) {
      await q(`DELETE FROM payments WHERE id = $1 AND status IN ('pending','failed')`, [paymentId])
    }
    await q(`DELETE FROM utility_bills WHERE id = $1`, [b.id])
  }

  // ── Charges and invoices ─────────────────────────────────────────────────
  const invoices = (await q(
    `SELECT id FROM invoices WHERE lease_id = $1`, [leaseId])).rows.map(r => r.id)
  await q(
    `DELETE FROM payments WHERE lease_id = $1 AND status IN ('pending','failed')`, [leaseId])
  if (invoices.length) {
    await q(
      `DELETE FROM payments WHERE invoice_id = ANY($1::uuid[]) AND status IN ('pending','failed')`,
      [invoices])
    // A settlement period on a void invoice has nothing left to credit.
    await q(
      `DELETE FROM work_trade_settlements WHERE invoice_id = ANY($1::uuid[]) AND status = 'open'`,
      [invoices])
    await q(
      `UPDATE invoices SET status = 'void', total_amount = 0, updated_at = NOW()
        WHERE id = ANY($1::uuid[])`, [invoices])
  }

  // A deposit that was only ever a pending line, with nothing collected, is not
  // a deposit. (No .catch here or anywhere in this file: inside a transaction a
  // failed statement has already aborted it, so swallowing the error would only
  // hide why the void failed.)
  await q(
    `DELETE FROM security_deposits
      WHERE lease_id = $1 AND status = 'pending'
        AND COALESCE(collected_amount, 0) = 0
        AND carried_from_deposit_id IS NULL`, [leaseId])

  // ── The tenancy itself ───────────────────────────────────────────────────
  // The work-trade agreement this issuance created. Left active, a re-signed
  // lease would create a second one beside it — there is no uniqueness on it.
  await q(
    `UPDATE work_trade_agreements wta
        SET status = 'ended', end_date = COALESCE(end_date, CURRENT_DATE), updated_at = NOW()
      WHERE wta.unit_id = $1 AND wta.status = 'active'
        AND wta.start_date = $2::date
        AND wta.tenant_id IN (SELECT tenant_id FROM lease_tenants WHERE lease_id = $3)`,
    [lease.unit_id, lease.start_date, leaseId])

  await q(
    `UPDATE lease_tenants SET status = 'void', updated_at = NOW()
      WHERE lease_id = $1 AND status IN ('active','pending_add','pending_remove')`, [leaseId])
  await q(
    `UPDATE leases
        SET status = 'terminated', terminated_at = NOW(),
            termination_reason = COALESCE(termination_reason,
              'Lease document voided before the tenant signed'),
            updated_at = NOW()
      WHERE id = $1`, [leaseId])
  await q(
    `UPDATE units SET status = 'vacant', updated_at = NOW()
      WHERE id = $1
        AND NOT EXISTS (SELECT 1 FROM leases l
                         WHERE l.unit_id = $1 AND l.id <> $2 AND l.status IN ('active','pending'))`,
    [lease.unit_id, leaseId])

  // The invite this lease closed goes back to open, still pointing at the voided
  // document — so the household shows on the front desk as a lease to re-send.
  await q(
    `UPDATE pending_tenant_intents
        SET resolved_at = NULL, resolved_lease_id = NULL, updated_at = NOW()
      WHERE resolved_lease_id = $1`, [leaseId])

  return { unwound: true }
}
