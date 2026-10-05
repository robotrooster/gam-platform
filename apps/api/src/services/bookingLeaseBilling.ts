// ============================================================
// S548 — calendar-aligned billing for booking-sourced leases (Nic).
//
// A 30+ night stay books at a monthly rate, billed like a resident:
// prorated arrival month (days × monthly / days in that month), flat monthly on the 1st
// with all tenants, prorated departure month. The public quote, the
// booking's stored total, and the INVOICES all come from the same
// shared computeMonthlyStaySchedule — they can never disagree.
//
// This module gives the two billing writers (moveInBundle for the
// arrival invoice, invoiceGeneration for the 1st-of-month cycle) their
// per-due-date amounts, and owns the Master Schedule → lease sync:
// date changes update the lease, drop no-longer-owed unpaid rent that
// carries no history, give back credit the landlord gave that paid rent for
// nights no longer in the stay (decisions #30), and bank any overpayment of the
// guest's own money as money paid ahead (lease_prepaid_credits,
// funded_by 'reclassified') — which pays the final bill once the
// tenant chooses to use it, or by itself when it covers the whole bill
// (the final one carries the last meter-read utility bills, so "credit
// minus final meter read" falls out of the credit machinery).
//
// Regular (non-booking) leases are untouched: their move-in proration
// and full-month cycle keep the long-standing behavior.
// ============================================================
import type { PoolClient } from 'pg'
import { computeMonthlyStaySchedule, UTILITY_TYPE_LABEL, type UtilityType, type CreditUseSource } from '@gam/shared'
import { query, queryOne, getClient } from '../db'
import { logger } from '../lib/logger'
import { createNotification } from './notifications'
import { createAdminNotification } from './adminNotifications'
import { lockHousehold } from './moneyPredicates'
import {
  createPaidAhead, voidPaidAhead, supersedeScheduledRetry, cancelSupersededIntents, runWholeBillCheckAfterCommit,
  rentPastStayEndSql, applyCredit,
} from './creditUse'
import { RESERVATION_PAID_SQL } from './bookingLeaseDraft'
import { todayIn } from '../lib/timezone'

/**
 * The note on money paid ahead that a shortened stay banked (funded_by
 * 'reclassified'). It is what tells this credit apart from the other
 * reclassified kind, a reservation deposit's leftover (moveInBundle
 * STAY_DEPOSIT_CREDIT_NOTE): only this one is taken back when the stay gets
 * longer again (billLongerStay).
 */
export const STAY_SHORTENED_CREDIT_NOTE = 'Stay shortened — rent already paid past the new end'

/** True when this lease bills on the booking schedule: sourced from a
 *  reservation and date-bounded. (lease end_date inherits the booking's
 *  exclusive check_out, so it feeds the schedule directly.) */
export function isBookingScheduleLease(lease: { lease_source?: string | null; end_date?: string | null }): boolean {
  return lease.lease_source === 'booking_draft' && !!lease.end_date
}

/**
 * Rent owed on an invoice dated `dueDate` for a booking-schedule lease.
 * The schedule's segments each start on their invoice date (arrival day,
 * then each 1st); a dueDate that starts no segment owes nothing (null).
 */
export function bookingRentForDueDate(
  startDate: string, endDateExclusive: string, monthlyRent: number, dueDate: string,
): number | null {
  const sched = computeMonthlyStaySchedule(startDate.slice(0, 10), endDateExclusive.slice(0, 10), monthlyRent)
  const seg = sched.segments.find(s => s.from === dueDate.slice(0, 10))
  return seg ? seg.amount : null
}

/**
 * A charge row that carries history, so it is never deleted (Nic: GAM keeps
 * everything). Money was tried on it (a card or bank intent: a bounce, a pull
 * that may still land), it was reopened after a dispute, or another record
 * points at it: a receipt applied to it (remittance_applications, written the
 * moment a portal or autopay charge covers it), a bank-return log, a FlexPay
 * advance, a reversal, a one-off charge, a bank-deposit match, a live credit
 * use, a legacy paid-ahead draw, or a credit it created. Most of those foreign
 * keys have no ON DELETE action, so deleting the row would also fail and take
 * the whole schedule edit down with it. A credit use released before the row
 * goes is not history (its foreign key sets NULL and the use keeps its record).
 */
function rowCarriesHistorySql(a: string): string {
  return `(${a}.stripe_payment_intent_id IS NOT NULL
      OR ${a}.reversal_id IS NOT NULL
      OR EXISTS (SELECT 1 FROM remittance_applications x WHERE x.payment_id = ${a}.id)
      OR EXISTS (SELECT 1 FROM ach_monitoring_log x WHERE x.payment_id = ${a}.id)
      OR EXISTS (SELECT 1 FROM flexpay_advances x WHERE x.rent_payment_id = ${a}.id OR x.fee_payment_id = ${a}.id)
      OR EXISTS (SELECT 1 FROM payment_reversals x WHERE x.payment_id = ${a}.id)
      OR EXISTS (SELECT 1 FROM tenant_one_off_charges x WHERE x.payment_id = ${a}.id)
      OR EXISTS (SELECT 1 FROM bank_deposit_allocations x WHERE x.payment_id = ${a}.id)
      OR EXISTS (SELECT 1 FROM bank_transactions x WHERE x.matched_payment_id = ${a}.id)
      OR EXISTS (SELECT 1 FROM credit_uses x WHERE x.payment_id = ${a}.id AND x.status <> 'released')
      OR EXISTS (SELECT 1 FROM lease_prepaid_credit_draws x WHERE x.payment_id = ${a}.id)
      OR EXISTS (SELECT 1 FROM lease_prepaid_credits x WHERE x.source_payment_id = ${a}.id))`
}

/** Unpaid rent past a shortened stay's new end that had to stay on the account; `amount` is what is still unpaid on it. */
interface KeptRent { id: string; dueDate: string; amount: number; status: string; reason: 'history' | 'could_not_remove' }

/**
 * A charge still owed INSIDE the stay whose scheduled bank retry the new dates
 * canceled: it rode the same bank pull as rent past the new end (canceling that
 * pull, so nobody pulls rent for a month the guest is not staying, canceled
 * this line's retry too), or its own rent was re-priced to the new dates (the
 * retry would have pulled the old amount). `pullHadPastEndRent` says which.
 * `repricedFrom` is the line's amount before the new dates re-priced it.
 */
interface RetryCanceledLine {
  id: string; intent: string; landlordId: string; label: string; dueDate: string; owed: number
  pullHadPastEndRent: boolean; repricedFrom: number | null
}

/**
 * Unpaid rent inside the stay that the new dates re-priced to the booking
 * schedule (the old final month, or the new one). `to` 0 means nothing is
 * owed for that due date any more.
 */
interface RepricedRent { id: string; dueDate: string; from: number; to: number; status: string; outcome: 'repriced' | 'removed' | 'zeroed' }

/**
 * Rent a longer stay billed (billLongerStay): the rest of a month that was
 * already paid (or being paid) at the shorter stay's amount, or a whole month
 * the longer stay added that the regular bill run would bill but will never
 * write (that date's bill already went out without it, or the date is past the
 * run's catch-up window).
 */
interface LongerStayBill { id: string; dueDate: string; amount: number; kind: 'rest_of_month' | 'month' }

/** What billLongerStay did. */
interface LongerStayResult {
  billed: LongerStayBill[]
  /** Stay-shortened credit withdrawn (unused, so voided): those days are owed again. */
  creditTakenBack: number
  /**
   * Stay-shortened credit that should have come back but could not: part of it
   * was already used, or a payment still clearing has it set aside. It is
   * billed as rent instead (inside `billed`), and the guest keeps what is left of it.
   */
  creditInUse: Array<{ creditId: string; amount: number; used: number; left: number }>
  /** Rent that could not be written (GAM is told). */
  notBilled: Array<{ dueDate: string; amount: number; reason: string }>
}
const NO_LONGER_STAY: LongerStayResult = { billed: [], creditTakenBack: 0, creditInUse: [], notBilled: [] }

/** A charge's line name as the tenant reads it — the utility by its type (decisions #17), never "Utilities". */
function lineLabel(type: string, utilityType: string | null): string {
  if (type === 'rent') return 'Rent'
  if (type === 'late_fee') return 'Late fee'
  if (type === 'utility') return (utilityType && UTILITY_TYPE_LABEL[utilityType as UtilityType]) || 'Utility bill'
  return 'Fee'
}

const money2 = (n: number) => `$${n.toFixed(2)}`
const round2 = (n: number) => Math.round(n * 100) / 100
const monthName = (ymd: string) =>
  new Date(`${ymd.slice(0, 10)}T12:00:00Z`).toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' })
const longDate = (ymd: string) =>
  new Date(`${ymd.slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' })

/**
 * The first date an end can cut nights from: the start of the schedule's last
 * segment (the month the stay ends in). Every later date is that month or past
 * the end. Every earlier date is a whole month the end does not touch: its
 * bills stand as written, so nothing on them is nights cut — a rent changed
 * mid-stay (a signed terms addendum moves leases.rent_amount) makes the
 * schedule ask a whole month at the new rate, and that difference is not nights
 * the stay lost.
 */
function firstCuttableDate(segments: ReadonlyArray<{ from: string }>): string {
  return segments.length > 0 ? segments[segments.length - 1].from : '9999-12-31'
}

/**
 * How much of the landlord-issued credit spent on one date of the stay (cents)
 * counts against the nights the end cut from that date, never the nights
 * still in the stay. `date` is the date's key (a segment's start, or a bill's
 * own due date past the end), `cutFrom` firstCuttableDate of the schedule now.
 * `billedCents` is what the date's rent bills ask (gross, plus the
 * reservation's share on the arrival date), `owedCents` what the schedule owes
 * for the date now. A date before `cutFrom` is wholly inside the stay and was
 * cut by nothing, so all of its credit paid nights the guest stays, whatever
 * its bills ask; on the month the end cuts, or a date past it, the credit
 * counts against the cut nights first, up to what was cut, and only the rest
 * paid nights still in the stay. bankOverpayment (issuedCreditOnStayNights),
 * billLongerStay and giveBackCreditOnCutNights all count it here, so a
 * shortening and a later lengthening never turn the landlord's credit into the
 * guest's money, and the give-back returns exactly that credit to the guest as
 * credit (decisions #30). Which comes back first on a month the end cuts only
 * in part — the landlord's credit or the guest's money — is the last line.
 */
function creditOnCutNights(date: string, cutFrom: string, billedCents: number, owedCents: number, creditCents: number): number {
  if (date < cutFrom) return 0
  return Math.min(creditCents, Math.max(0, billedCents - owedCents))
}

/**
 * A rent row on an invoice was removed or re-priced: the invoice's rent and
 * total follow it (a bill that still carries other lines — the final meter
 * reads ride the last one — must not keep showing rent that is gone). Never
 * below zero; a voided invoice is left as it is.
 */
async function adjustInvoiceRent(client: PoolClient, invoiceId: string | null, delta: number): Promise<void> {
  if (!invoiceId || Math.abs(delta) < 0.005) return
  await client.query(
    `UPDATE invoices
        SET subtotal_rent = GREATEST(0, subtotal_rent + $2::numeric),
            total_amount  = GREATEST(0, total_amount  + $2::numeric),
            updated_at = now()
      WHERE id = $1 AND status <> 'void'`,
    [invoiceId, delta.toFixed(2)])
}

/**
 * Master Schedule → lease sync (S548). Called after a booking's dates
 * change. Best-effort by design — the caller .catch()es and logs; a sync
 * failure never unwinds the booking edit. When it does fail, GAM is told by
 * name (guest, unit) here, before the error goes back to the caller.
 *
 * pending lease  → dates simply follow the booking (still unsigned).
 * active lease   → end_date follows; unpaid rent falling past the new end is
 *                  deleted only when it carries no history (a plain pending
 *                  bill nobody tried to pay). A scheduled bank retry on such
 *                  rent is canceled and its held credit given back first. Rent
 *                  with history — a bounced card or bank payment, a receipt
 *                  applied to it — is kept (GAM never erases a record), its
 *                  retry still superseded so nobody pulls rent for a month the
 *                  guest is not staying, and the landlord and GAM are told by
 *                  name. Each delete runs in its own savepoint, so no row can
 *                  undo the date move or the banking. Unpaid rent INSIDE the
 *                  stay whose month the new dates change (the old final month,
 *                  or the new one) is re-priced to the schedule, so the guest
 *                  is asked only for the days they stay (decisions #19: an
 *                  unpaid bill is adjusted); a bank retry scheduled on it is
 *                  canceled first (it would pull the old amount) and the tenant
 *                  is asked to pay the new one. Credit the landlord gave
 *                  that paid rent for nights the stay no longer has goes
 *                  back to the guest as credit (giveBackCreditOnCutNights,
 *                  decisions #30). Rent money already PAID past
 *                  the new obligation becomes money paid ahead
 *                  (bankShortenedStayOverpayment). A LONGER stay bills what
 *                  the new days add to a month already paid at the shorter
 *                  amount, and any month the bill run will not write, after
 *                  taking back stay-shortened credit for days that are part of
 *                  the stay again (billLongerStay); a kept past-end bill the
 *                  new dates bring back inside the stay is re-priced to the
 *                  schedule. After commit the whole-bill rule runs whenever the
 *                  bill or the credit changed, so a final bill that credit
 *                  covers settles at once. A check-IN change on an active lease
 *                  is NOT auto-applied — the landlord is notified to amend the
 *                  signed document.
 */
export async function syncLeaseWithBookingDates(bookingId: string): Promise<void> {
  const lease = await queryOne<any>(
    `SELECT l.id, l.status, l.lease_source, l.rent_amount, l.landlord_id,
            to_char(l.start_date, 'YYYY-MM-DD') AS start_date,
            to_char(l.end_date,   'YYYY-MM-DD') AS end_date,
            to_char(b.check_in,   'YYYY-MM-DD') AS check_in,
            to_char(b.check_out,  'YYYY-MM-DD') AS check_out,
            b.guest_name, u.unit_number
       FROM leases l
       JOIN unit_bookings b ON b.id = l.source_booking_id
       JOIN units u ON u.id = l.unit_id
      WHERE l.source_booking_id = $1`,
    [bookingId])
  if (!lease) return
  if (lease.start_date === lease.check_in && lease.end_date === lease.check_out) return

  if (lease.status === 'pending') {
    await query(
      `UPDATE leases SET start_date = $2, end_date = $3, updated_at = now() WHERE id = $1`,
      [lease.id, lease.check_in, lease.check_out])
    logger.info({ leaseId: lease.id, bookingId }, '[booking-lease-sync] pending draft dates follow the booking')
    return
  }
  if (lease.status !== 'active') return

  const startMoved = lease.start_date !== lease.check_in
  const endMoved = lease.end_date !== lease.check_out
  const who = `${lease.guest_name || 'the guest'} on unit ${lease.unit_number}`

  let banked: { amount: number; tenantId: string | null } = { amount: 0, tenantId: null }
  let cancelAfterCommit: string[] = []
  const kept: KeptRent[] = []
  // Unpaid rent inside the stay the new dates re-priced, and any they could not.
  const repriced: RepricedRent[] = []
  const unrepriced: RepricedRent[] = []
  let retryCanceled: RetryCanceledLine[] = []
  // The household this lease's money belongs to (resolved under the lock,
  // used again after commit for the whole-bill check).
  let hhTenantId: string | null = null
  // What a longer stay billed or took back (billLongerStay).
  let longer: LongerStayResult = NO_LONGER_STAY
  // Landlord credit on nights the stay no longer has, given back (decisions #30).
  let given: GiveBackResult = NO_GIVE_BACK
  let givenFailed = false
  // Unpaid rent past the new end that was removed.
  let removedPastEnd = 0
  // The stay now ends later than the lease did.
  const lengthened = endMoved && !!lease.end_date && !!lease.check_out && lease.check_out > lease.end_date
  if (endMoved) {
    const client = await getClient()
    try {
      await client.query('BEGIN')
      // S655: every writer of a household's money takes the household lock first.
      const hh = await client.query<{ tenant_id: string | null }>(
        `SELECT COALESCE(
                  (SELECT t.tenant_id FROM v_lease_active_tenants t WHERE t.lease_id = $1
                    ORDER BY (t.role = 'primary') DESC, t.added_at, t.tenant_id LIMIT 1),
                  (SELECT p.tenant_id FROM payments p WHERE p.lease_id = $1 AND p.tenant_id IS NOT NULL
                    ORDER BY p.created_at, p.id LIMIT 1)) AS tenant_id`,
        [lease.id])
      hhTenantId = hh.rows[0]?.tenant_id ?? null
      if (hhTenantId) await lockHousehold(client, hhTenantId, lease.landlord_id)

      await client.query(`UPDATE leases SET end_date = $2, updated_at = now() WHERE id = $1`, [lease.id, lease.check_out])

      if (isBookingScheduleLease({ lease_source: lease.lease_source, end_date: lease.check_out })) {
        // Removes a plain unpaid rent row (one that carries no history) and
        // takes it off its invoice. Its own savepoint: a record pointing at the
        // row that rowCarriesHistorySql does not know about keeps the row
        // instead of rolling back the date move and the banking with it.
        const removeRow = async (id: string, amount: number): Promise<boolean> => {
          await client.query('SAVEPOINT stay_shortened_row')
          let invoiceId: string | null
          try {
            const d = await client.query<{ invoice_id: string | null }>(
              `DELETE FROM payments WHERE id = $1 AND status IN ('pending','failed') RETURNING invoice_id`,
              [id])
            await client.query('RELEASE SAVEPOINT stay_shortened_row')
            if (d.rowCount === 0) return false
            invoiceId = d.rows[0]?.invoice_id ?? null
          } catch (e) {
            await client.query('ROLLBACK TO SAVEPOINT stay_shortened_row')
            logger.warn({ err: e, leaseId: lease.id, paymentId: id }, '[booking-lease-sync] unpaid rent the new dates no longer owe could not be removed — kept')
            return false
          }
          if (!invoiceId) return true
          // The bill keeps its other lines (the final meter reads ride the
          // last one), so its rent and total drop by the rent that went.
          await adjustInvoiceRent(client, invoiceId, -amount)
          // An invoice left with no payments is an empty shell — remove it,
          // unless something still points at it (then it stays, harmless).
          await client.query('SAVEPOINT stay_shortened_invoice')
          try {
            await client.query(
              `DELETE FROM invoices i WHERE i.id = $1
                 AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.invoice_id = i.id)`,
              [invoiceId])
            await client.query('RELEASE SAVEPOINT stay_shortened_invoice')
          } catch (e) {
            await client.query('ROLLBACK TO SAVEPOINT stay_shortened_invoice')
            logger.warn({ err: e, leaseId: lease.id, invoiceId }, '[booking-lease-sync] empty invoice left in place — a record still points at it')
          }
          return true
        }

        // Unpaid rent that is no longer owed: due on/after the new end (the
        // final prorated segment's invoice is dated its own 1st, which is before
        // the end, so it survives). The one definition credit also reads, so
        // a row kept here is never paid from the guest's credit.
        const unpaid = (await client.query<{ id: string; status: string; amount: string; due_date: string; intent: string | null }>(
          `SELECT p.id, p.status, p.amount::text AS amount, to_char(p.due_date, 'YYYY-MM-DD') AS due_date,
                  p.stripe_payment_intent_id AS intent
             FROM payments p JOIN leases l ON l.id = p.lease_id
            WHERE p.lease_id = $1 AND p.status IN ('pending','failed')
              AND ${rentPastStayEndSql('p', 'l')}
            ORDER BY p.id FOR UPDATE OF p`,
          [lease.id])).rows

        // Unpaid rent INSIDE the stay whose month the new dates change — the old
        // final month (shortened: October now ends on the 15th) or the new one
        // (lengthened). It is re-priced by the schedule's change for its due
        // date, so whatever was taken off that bill when it was written (the
        // reservation's deposit, decisions #15) stays taken off. Only rows
        // nothing is moving on: pending with no intent, or failed. Money in
        // flight is left alone — it settles at what was pulled, and what is
        // over is banked as it settles (what is short is billed below,
        // billLongerStay). A reopened row (a dispute) owes what it lost, not a
        // segment; a work-trade row is paid by labor.
        const inStay = (await client.query<{
          id: string; status: string; amount: string; due_date: string; invoice_id: string | null; retry: boolean
        }>(
          `SELECT p.id, p.status, p.amount::text AS amount, to_char(p.due_date, 'YYYY-MM-DD') AS due_date, p.invoice_id,
                  (p.status = 'failed' AND p.stripe_payment_intent_id IS NOT NULL
                   AND (p.next_retry_at IS NOT NULL
                        OR EXISTS (SELECT 1 FROM credit_uses u WHERE u.payment_id = p.id AND u.status = 'held'))) AS retry
             FROM payments p JOIN leases l ON l.id = p.lease_id
            WHERE p.lease_id = $1 AND p.type = 'rent'
              AND (p.status = 'failed' OR (p.status = 'pending' AND p.stripe_payment_intent_id IS NULL))
              AND p.reversal_id IS NULL AND p.work_trade_suspended_at IS NULL
              AND NOT ${rentPastStayEndSql('p', 'l')}
            -- newest first within a date: a change comes off (or goes onto)
            -- the latest bill for that date first (the rest of a month billed
            -- when the stay got longer, before the month's own bill).
            ORDER BY p.due_date, p.created_at DESC, p.id DESC FOR UPDATE OF p`,
          [lease.id])).rows
        const rent = Number(lease.rent_amount)
        // Every live rent bill for a date, so a date coming back inside the stay
        // is asked only what the schedule owes for it less what its other bills
        // already ask (a reopened row re-asks what a dispute took, so it is not one).
        const billedOnDate = new Map((await client.query<{ d: string; total: string }>(
          `SELECT to_char(p.due_date, 'YYYY-MM-DD') AS d, SUM(p.amount)::text AS total
             FROM payments p
            WHERE p.lease_id = $1 AND p.type = 'rent' AND p.reversal_id IS NULL
              AND p.status IN ('pending','failed','processing','settled','paid_via_deposit','returned')
            GROUP BY p.due_date`,
          [lease.id])).rows.map(r => [r.d, Number(r.total)]))
        // One change per DATE, however many unpaid bills that date has. Rises
        // go onto the newest bill; cuts come off newest first, each bill to $0
        // at most, the rest from the next.
        const byDate = new Map<string, typeof inStay>()
        for (const r of inStay) byDate.set(r.due_date, [...(byDate.get(r.due_date) ?? []), r])
        const toReprice: Array<(typeof inStay)[number] & { from: number; to: number }> = []
        for (const [due, rows] of byDate) {
          const now = bookingRentForDueDate(lease.start_date, lease.check_out, rent, due)
          if (now == null) continue
          const was = lease.end_date ? bookingRentForDueDate(lease.start_date, lease.end_date, rent, due) : null
          // A date that started no stay segment under the old end — rent past a
          // shortened stay's end that had to be kept (a payment was tried on it)
          // and that the new dates bring back inside the stay — owes the
          // schedule's amount for it. Never the arrival date (it always starts
          // a segment), so no reservation deposit was taken off it.
          let delta = was != null ? round2(now - was) : round2(now - (billedOnDate.get(due) ?? 0))
          if (Math.abs(delta) < 0.005) continue
          for (const r of rows) {
            if (Math.abs(delta) < 0.005) break
            const from = Number(r.amount)
            const to = delta > 0 ? round2(from + delta) : Math.max(0, round2(from + delta))
            delta = round2(delta - (to - from))
            if (Math.abs(to - from) >= 0.005) toReprice.push({ ...r, from, to })
            if (delta > 0) break
          }
        }

        // A bank retry scheduled on rent past the new end would pull rent for a
        // month the guest is not staying; one scheduled on re-priced rent would
        // pull the old amount. Supersede both (the held credit comes back, the
        // schedule is cleared on every row of that pull, the pull is canceled
        // after commit). Only failed rows carry a retry; a pending row with an
        // intent has money in flight and is left alone — if it settles, the
        // settle-path hook (bankShortenedStaysAfterSettle) banks what is over.
        const pastEndFailed = unpaid.filter(r => r.status === 'failed')
        const pastEndIntents = new Set(pastEndFailed.map(r => r.intent).filter((x): x is string => !!x))
        cancelAfterCommit = (await supersedeScheduledRetry(client, [
          ...pastEndFailed.map(r => r.id),
          ...toReprice.filter(r => r.retry).map(r => r.id),
        ])).cancelAfterCommit

        // Re-price, after the supersede gave any held credit back. Credit
        // already spent on the row stays within it (never below what it paid).
        for (const r of toReprice) {
          const note = `Stay now ends ${longDate(lease.check_out)}: rent for this date changed from ${money2(r.from)} to ${money2(r.to)}`
          if (r.to <= 0) {
            // Nothing is owed for this date any more (the reservation's deposit
            // already covers the shorter stay): a plain bill goes, one with
            // history is closed at $0 with the reason on it.
            const history = (await client.query(
              `SELECT 1 FROM payments p WHERE p.id = $1 AND ${rowCarriesHistorySql('p')}`, [r.id])).rowCount! > 0
            if (!history && await removeRow(r.id, r.from)) {
              repriced.push({ id: r.id, dueDate: r.due_date, from: r.from, to: 0, status: r.status, outcome: 'removed' })
              continue
            }
            const z = await client.query(
              `UPDATE payments p
                  SET amount = 0, status = 'settled', settled_at = now(), next_retry_at = NULL,
                      notes = CONCAT_WS(' · ', NULLIF(p.notes, ''), $2::text)
                WHERE p.id = $1 AND p.status IN ('pending','failed')
                  AND NOT EXISTS (SELECT 1 FROM credit_uses u WHERE u.payment_id = p.id AND u.status IN ('held','applied'))`,
              [r.id, `${note}; nothing is owed for it`])
            if (z.rowCount === 0) {
              logger.warn({ leaseId: lease.id, paymentId: r.id }, '[booking-lease-sync] rent the new dates no longer owe carries spent credit — left for GAM')
              unrepriced.push({ id: r.id, dueDate: r.due_date, from: r.from, to: 0, status: r.status, outcome: 'zeroed' })
              continue
            }
            await adjustInvoiceRent(client, r.invoice_id, -r.from)
            repriced.push({ id: r.id, dueDate: r.due_date, from: r.from, to: 0, status: r.status, outcome: 'zeroed' })
            continue
          }
          const u = await client.query(
            `UPDATE payments p
                SET amount = $2::numeric,
                    notes = CONCAT_WS(' · ', NULLIF(p.notes, ''), $3::text)
              WHERE p.id = $1 AND p.status IN ('pending','failed')
                AND COALESCE((SELECT SUM(u.amount) FROM credit_uses u
                               WHERE u.payment_id = p.id AND u.status IN ('held','applied')), 0) <= $2::numeric`,
            [r.id, r.to.toFixed(2), note])
          if (u.rowCount === 0) {
            logger.warn({ leaseId: lease.id, paymentId: r.id }, '[booking-lease-sync] rent the new dates re-price carries more spent credit than the new amount — left for GAM')
            unrepriced.push({ id: r.id, dueDate: r.due_date, from: r.from, to: r.to, status: r.status, outcome: 'repriced' })
            continue
          }
          await adjustInvoiceRent(client, r.invoice_id, round2(r.to - r.from))
          repriced.push({ id: r.id, dueDate: r.due_date, from: r.from, to: r.to, status: r.status, outcome: 'repriced' })
        }

        // Decisions #30 / #35.3: landlord credit spent on rent for nights the
        // stay no longer has goes back to the guest as saved credit — after the
        // re-price (an unpaid bill comes down first) and before anything past
        // the new end is removed (a row whose only history was that credit can
        // then go) or banked (only money is banked).
        // An unpaid bill the re-price could not bring down (it carries credit)
        // is left for GAM, as it is told below; the give-back waits on its
        // date until it is paid, on this path and on every settle after it.
        const g = await giveBackCreditSafely(client, lease.id)
        if (g) given = g
        else givenFailed = true

        // One bank pull can carry a month still inside the stay (September
        // beside October), and a re-priced month's own retry went too. That
        // line is owed again with nothing scheduled: the tenant is told and
        // asked to pay (after commit), and the landlord's notice names it —
        // at what is owed NOW (a re-priced month at its new amount).
        if (cancelAfterCommit.length > 0) {
          const priorAmount = new Map(repriced.map(r => [r.id, r.from]))
          retryCanceled = (await client.query<{
            id: string; intent: string; landlord_id: string; type: string; utility_type: string | null; due_date: string; owed: string
          }>(
            `SELECT p.id, p.stripe_payment_intent_id AS intent, p.landlord_id, p.type,
                    (SELECT ub.utility_type FROM utility_bills ub WHERE ub.payment_id = p.id
                      ORDER BY ub.created_at LIMIT 1) AS utility_type,
                    to_char(p.due_date, 'YYYY-MM-DD') AS due_date,
                    (p.amount - COALESCE((SELECT SUM(u.amount) FROM credit_uses u
                                           WHERE u.payment_id = p.id AND u.status = 'applied'), 0))::text AS owed
               FROM payments p
              WHERE p.stripe_payment_intent_id = ANY($1::text[]) AND p.status = 'failed'
                AND NOT (p.id = ANY($2::uuid[]))
              ORDER BY p.due_date, p.id`,
            [cancelAfterCommit, unpaid.map(r => r.id)])).rows
            .map(r => ({
              id: r.id, intent: r.intent, landlordId: r.landlord_id,
              label: lineLabel(r.type, r.utility_type), dueDate: r.due_date, owed: Number(r.owed),
              pullHadPastEndRent: pastEndIntents.has(r.intent), repricedFrom: priorAmount.get(r.id) ?? null,
            }))
            .filter(r => r.owed > 0.005)
        }

        // History is read after the supersede and the give-back (a released
        // use is not history), and so are the amounts: credit given back took
        // its row's amount down. A kept row names what is still unpaid on it,
        // not what credit already paid.
        const ids = unpaid.map(r => r.id)
        const history = ids.length === 0 ? new Set<string>() : new Set((await client.query<{ id: string }>(
          `SELECT p.id FROM payments p WHERE p.id = ANY($1::uuid[]) AND ${rowCarriesHistorySql('p')}`,
          [ids])).rows.map(r => r.id))
        const nowOn = new Map((ids.length === 0 ? [] : (await client.query<{ id: string; amount: string; unpaid: string }>(
          `SELECT p.id, p.amount::text AS amount,
                  (p.amount - COALESCE((SELECT SUM(u.amount) FROM credit_uses u
                                         WHERE u.payment_id = p.id AND u.status = 'applied'), 0))::text AS unpaid
             FROM payments p WHERE p.id = ANY($1::uuid[])`,
          [ids])).rows).map(r => [r.id, { amount: Number(r.amount), unpaid: Number(r.unpaid) }]))

        for (const r of unpaid) {
          const on = nowOn.get(r.id) ?? { amount: Number(r.amount), unpaid: Number(r.amount) }
          const row = { id: r.id, dueDate: r.due_date, amount: on.unpaid, status: r.status }
          if (history.has(r.id)) {
            // Money in flight is not "kept": it either settles (and is banked)
            // or fails (a failed row past the end — the bank's failure handler
            // must not schedule a retry on it).
            if (!(r.status === 'pending' && r.intent)) kept.push({ ...row, reason: 'history' })
            continue
          }
          if (await removeRow(r.id, on.amount)) removedPastEnd++
          else kept.push({ ...row, reason: 'could_not_remove' })
        }
        // A longer stay: what the new days add to a month already paid (or
        // being paid) at the shorter amount, and a month the bill run will
        // never write, are billed now; stay-shortened credit for days that are
        // part of the stay again is taken back first.
        if (lengthened) {
          longer = await billLongerStay(client, {
            leaseId: lease.id, landlordId: lease.landlord_id, tenantId: hhTenantId,
            startDate: lease.start_date, oldEnd: lease.end_date, newEnd: lease.check_out, rent,
          })
        }
        // The give-back already ran above (leaving GAM's unpaid bills alone).
        banked = await bankOverpayment(client, lease.id, { giveBackFirst: false })
      }
      await client.query('COMMIT')
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {})
      // The caller only logs, so GAM hears about it here, by name.
      await createAdminNotification({
        severity: 'warn',
        category: 'booking_lease_sync_failed',
        title: `Stay dates changed but the lease did not follow — ${who}`,
        body: `The reservation now ends ${lease.check_out}, but the lease could not be moved to match (${e instanceof Error ? e.message : String(e)}). ` +
          `The lease still ends ${lease.end_date} and keeps billing to that date; nothing was banked or removed. Fix the cause, then save the reservation's dates again.`,
        context: { lease_id: lease.id, booking_id: bookingId, landlord_id: lease.landlord_id, old_end: lease.end_date, new_end: lease.check_out },
      }).catch(() => {})
      throw e
    } finally {
      client.release()
    }
    await cancelSupersededIntents(cancelAfterCommit)
  }

  const keptTotal = Math.round(kept.reduce((s, k) => s + k.amount, 0) * 100) / 100
  const keptMonths = [...new Set(kept.map(k => monthName(k.dueDate)))].join(', ')
  const sumOwed = (xs: RetryCanceledLine[]) => Math.round(xs.reduce((s, r) => s + r.owed, 0) * 100) / 100
  const owedLines = (xs: RetryCanceledLine[]) => xs.map(r => `${r.label}, ${monthName(r.dueDate)} ${money2(r.owed)}`).join('; ')
  // Lines that rode a bank pull with rent past the new end (that pull was
  // canceled so nobody pulls rent for a month the guest is not staying), and
  // lines whose own rent the new dates re-priced (the retry would have pulled
  // the old amount).
  const besidePastEnd = retryCanceled.filter(r => r.pullHadPastEndRent)
  const stillOwedTotal = sumOwed(besidePastEnd)
  const stillOwedLines = owedLines(besidePastEnd)
  // The landlord hears only about their own charges (a neighbor landlord's
  // utility can ride the same household pull, S616).
  const ownRetryCanceled = retryCanceled.filter(r => r.landlordId === lease.landlord_id)
  const ownBesidePastEnd = ownRetryCanceled.filter(r => r.pullHadPastEndRent)
  const ownRepricedPull = ownRetryCanceled.filter(r => !r.pullHadPastEndRent)
  const repricedList = repriced
    .map(r => `${monthName(r.dueDate)} ${money2(r.from)} → ${r.to > 0 ? money2(r.to) : 'nothing owed'}`).join('; ')
  if (unrepriced.length > 0) {
    // Spent credit on the row is more than the new amount (a state no payment
    // path should leave): the bill keeps its old amount until GAM looks.
    await createAdminNotification({
      severity: 'warn',
      category: 'stay_shortened_rent_not_repriced',
      title: `Unpaid rent was not re-priced to a stay's new dates — ${who}`,
      body: `The stay now ends ${lease.check_out}. The schedule now asks ` +
        unrepriced.map(r => `${monthName(r.dueDate)} ${r.to > 0 ? money2(r.to) : 'nothing'} (the bill says ${money2(r.from)})`).join('; ') +
        `, but credit already spent on that bill is more than the new amount, so it was left as it is. Settle it with the landlord.`,
      context: { lease_id: lease.id, booking_id: bookingId, landlord_id: lease.landlord_id, unrepriced },
    }).catch(() => {})
  }
  if (kept.length > 0) {
    // Taking it off their balance in a recorded way is not built yet; until it
    // is, it stays, GAM decides with the landlord, and credit never pays it
    // (creditUse.rentPastStayEndSql). Written BEFORE the whole-bill check below,
    // which then knows GAM has already been told about this lease.
    await createAdminNotification({
      severity: 'warn',
      category: 'stay_shortened_rent_kept',
      title: `Rent past a shortened stay is still on the account — ${who}`,
      body: `The stay now ends ${lease.check_out}. ${money2(keptTotal)} of unpaid rent due after that (${keptMonths}) could not be removed: ` +
        kept.map(k => `${monthName(k.dueDate)} ${money2(k.amount)} (${k.status === 'failed' ? 'a card or bank payment on it failed' : 'other records point at it'}${k.reason === 'could_not_remove' ? '; the delete was refused' : ''})`).join('; ') +
        `. Any bank retry on it was canceled` +
        (besidePastEnd.length > 0
          ? `; that bank pull also carried ${money2(stillOwedTotal)} still owed inside the stay (${stillOwedLines}), whose retry went with it — the tenant has been asked to pay that now`
          : '') +
        `. It stays on their balance until it is taken off in a recorded way — decide with the landlord. Their account credit is not used on it.`,
      context: { lease_id: lease.id, booking_id: bookingId, landlord_id: lease.landlord_id, kept, retry_canceled: retryCanceled },
    }).catch(() => {})
  }
  // A longer stay: GAM hears about stay-shortened credit that could not be
  // taken back (already used, or set aside by a payment still clearing) and
  // about rent that could not be billed.
  const longerBilledTotal = round2(longer.billed.reduce((s, b) => s + b.amount, 0))
  const longerLines = longer.billed
    .map(b => `${b.kind === 'rest_of_month' ? `the rest of ${monthName(b.dueDate)}` : monthName(b.dueDate)} ${money2(b.amount)}`).join('; ')
  const creditInUseTotal = round2(longer.creditInUse.reduce((s, c) => s + c.amount, 0))
  if (longer.creditInUse.length > 0) {
    await createAdminNotification({
      severity: 'warn',
      category: 'stay_lengthened_credit_in_use',
      title: `A longer stay could not take back credit already used — ${who}`,
      body: `The stay now ends ${lease.check_out}, so days the stay-shortened credit came from are part of the stay again and ` +
        `${money2(creditInUseTotal)} of that credit should come back. It could not be withdrawn: ` +
        longer.creditInUse.map(c => `${money2(c.used)} of it was already used or is set aside by a payment still clearing, and ${money2(c.left)} is unused`).join('; ') +
        `. So ${money2(creditInUseTotal)} was billed to the guest as rent instead (${longerLines}), and they keep the unused part to pay it with. ` +
        `If that is not how it should be settled, decide it with the landlord.`,
      context: { lease_id: lease.id, booking_id: bookingId, landlord_id: lease.landlord_id, credit_in_use: longer.creditInUse, billed: longer.billed },
    }).catch(() => {})
  }
  if (givenFailed) {
    await createAdminNotification({
      severity: 'warn',
      category: CREDIT_NOT_GIVEN_BACK,
      ...creditNotGivenBackAlert(who, lease.check_out, 'dates'),
      context: { lease_id: lease.id, booking_id: bookingId, landlord_id: lease.landlord_id },
    }).catch(() => {})
  }
  if (longer.notBilled.length > 0) {
    await createAdminNotification({
      severity: 'warn',
      category: 'stay_lengthened_rent_not_billed',
      title: `Rent for a longer stay could not be billed — ${who}`,
      body: `The stay now ends ${lease.check_out}. This rent the new dates add could not be written: ` +
        longer.notBilled.map(n => `${monthName(n.dueDate)} ${money2(n.amount)} (${n.reason})`).join('; ') +
        `. Bill it by hand, or fix the cause and save the reservation's dates again.`,
      context: { lease_id: lease.id, booking_id: bookingId, landlord_id: lease.landlord_id, not_billed: longer.notBilled },
    }).catch(() => {})
  }
  // The tenant's bounce email promised a retry that will no longer happen.
  if (retryCanceled.length > 0) {
    await notifyRetryCanceledByShortening({
      lines: retryCanceled, newEnd: lease.check_out, landlordId: lease.landlord_id, leaseId: lease.id,
    })
  }
  // The guest owes more for the longer stay, or lost credit for days they now stay.
  if (longer.billed.length > 0 || longer.creditTakenBack > 0) {
    await notifyLongerStay({ result: longer, newEnd: lease.check_out, leaseId: lease.id, tenantId: hhTenantId })
  }
  // The whole-bill rule runs after commit whenever the bill or the credit
  // changed so that credit may now cover it: money paid ahead was created, a
  // bill came down or went (a final bill can drop below credit the guest
  // already holds — a stay that is ending has no next bill run to settle it,
  // and a late fee could land meanwhile), or new rent was billed. A bill still
  // carrying kept rent past the new end never settles from credit.
  const billCameDown = repriced.some(r => r.to < r.from) || removedPastEnd > 0
  const wholeBillTenant = banked.tenantId ?? hhTenantId
  if (wholeBillTenant && (banked.amount > 0 || billCameDown || longer.billed.length > 0 || given.total > 0)) {
    await runWholeBillCheckAfterCommit({ tenantId: wholeBillTenant, landlordId: lease.landlord_id, onlyLeaseIds: [lease.id] })
  }

  // Tell the landlord what the schedule edit did to the money.
  try {
    const owner = await queryOne<{ user_id: string }>(
      `SELECT user_id FROM landlords WHERE id = $1`, [lease.landlord_id])
    if (owner && (endMoved || startMoved)) {
      const bits: string[] = []
      if (endMoved) bits.push(`lease end moved to ${lease.check_out}`)
      if (banked.amount > 0) bits.push(`${money2(banked.amount)} of rent already paid past the new end is now money paid ahead on their account; it pays their final bill (utilities included) when they use it, or by itself if it covers the whole bill`)
      if (given.total > 0) bits.push(`${money2(given.total)} of credit you gave them had paid rent for nights no longer in the stay (${[...new Set(given.given.map(x => monthName(x.dueDate)))].join(', ')}); it went back to them as credit they can use on a later bill, and that rent bill came down by the same amount`)
      if (repriced.length > 0) bits.push(`unpaid rent changed to match the new dates (${repricedList}); they are asked only for the new amount`)
      if (kept.length > 0) bits.push(`${money2(keptTotal)} of unpaid rent due after the new end (${keptMonths}) stays on their account for now, because a payment or another record is tied to it and GAM never erases a record; their account credit is not used on it, and GAM has been told and will clear it with you`)
      if (ownBesidePastEnd.length > 0) bits.push(`the bank payment GAM was going to try again also carried ${money2(sumOwed(ownBesidePastEnd))} they still owe for the stay (${owedLines(ownBesidePastEnd)}); that retry was canceled with the rest of the pull because the stay changed, and they have been asked to pay it now`)
      if (ownRepricedPull.length > 0) bits.push(`the bank payment GAM was going to try again for that rent was canceled, because it would have pulled the old amount; they have been asked to pay ${money2(sumOwed(ownRepricedPull))} now (${owedLines(ownRepricedPull)})`)
      if (longer.creditTakenBack > 0) bits.push(`${money2(longer.creditTakenBack)} of money paid ahead from when the stay was shortened was taken back, because those days are part of the stay again`)
      if (longer.billed.length > 0) bits.push(`${money2(longerBilledTotal)} more rent is billed for the longer stay (${longerLines}) and they have been asked to pay it`)
      if (creditInUseTotal > 0) bits.push(`${money2(creditInUseTotal)} of that is stay-shortened credit that could not be taken back because part of it was already used; they keep the ${money2(round2(longer.creditInUse.reduce((s, c) => s + c.left, 0)))} still unused to pay with, and GAM has been told`)
      if (longer.notBilled.length > 0) bits.push(`${money2(round2(longer.notBilled.reduce((s, n) => s + n.amount, 0)))} of rent the new dates add could not be billed (${longer.notBilled.map(n => monthName(n.dueDate)).join(', ')}); GAM has been told and will sort it out with you`)
      if (startMoved) bits.push(`the signed lease still starts ${lease.start_date} — amend the document if the ${lease.check_in} arrival is right`)
      await createNotification({
        userId: owner.user_id,
        landlordId: lease.landlord_id,
        type: 'booking_lease_sync',
        title: `Stay dates changed — ${lease.guest_name || 'guest'} on unit ${lease.unit_number}`,
        body: `The reservation's dates changed: ${bits.join('; ')}.`,
        data: {
          leaseId: lease.id, bookingId, creditAmount: banked.amount, creditGivenBack: given.total,
          keptRent: keptTotal, retryCanceledOwed: sumOwed(ownRetryCanceled),
          repricedRent: repriced.map(r => ({ paymentId: r.id, dueDate: r.dueDate, from: r.from, to: r.to })),
          longerStayRent: longer.billed.map(b => ({ paymentId: b.id, dueDate: b.dueDate, amount: b.amount, kind: b.kind })),
          creditTakenBack: longer.creditTakenBack,
        },
        actionUrl: `/leases?open=${lease.id}`,
      })
    }
  } catch (err) {
    logger.error({ err, bookingId }, '[booking-lease-sync] notification failed')
  }
}

/**
 * New stay dates canceled a bank retry that carried charges still owed inside
 * the stay: the pull also carried rent past the new end, or the new dates
 * re-priced its rent. The tenant's bounce email said the bank would be tried
 * again; it will not, so they are told why, what is still owed (a re-priced
 * month at its new amount), and given the Pay now link (the signed sign-in
 * link every pay email uses). One notice per bank pull, to the person that
 * pull's charges name. After COMMIT only; never throws.
 */
async function notifyRetryCanceledByShortening(a: {
  lines: RetryCanceledLine[]; newEnd: string; landlordId: string; leaseId: string
}): Promise<void> {
  const byIntent = new Map<string, RetryCanceledLine[]>()
  for (const l of a.lines) byIntent.set(l.intent, [...(byIntent.get(l.intent) ?? []), l])
  for (const [intent, lines] of byIntent) {
    try {
      const { pullNoticeContext } = await import('./achRetry')
      const { payNowLink } = await import('./invoiceNotice')
      const pctx = await pullNoticeContext(lines[0].id)
      if (!pctx) {
        logger.warn({ intent, leaseId: a.leaseId }, '[booking-lease-sync] retry canceled by a shortened stay — no tenant account to tell')
        continue
      }
      const owed = Math.round(lines.reduce((s, l) => s + l.owed, 0) * 100) / 100
      const endsOn = longDate(a.newEnd)
      const list = lines.map(l => `${l.label}, ${monthName(l.dueDate)}: ${money2(l.owed)}`
        + (l.repricedFrom != null ? ` (was ${money2(l.repricedFrom)}, changed to match your stay's new dates)` : ''))
      let payUrl: string
      try {
        payUrl = payNowLink({ tenant_user_id: pctx.tenant_user_id, tenant_email: pctx.tenant_email })
      } catch (e) {
        logger.error({ err: e, intent }, '[booking-lease-sync] pay link failed')
        payUrl = payNowLink({ tenant_user_id: null, tenant_email: null })
      }
      const where = `${pctx.property_name} Unit ${pctx.unit_number}`
      const lead = lines.some(l => l.pullHadPastEndRent)
        ? `Your stay at ${where} now ends ${endsOn}, so the bank payment we were going to try again was canceled — part of it was rent for after your stay ends.`
        : `Your stay at ${where} now ends ${endsOn}, so the rent on the bank payment we were going to try again changed, and that payment was canceled.`
      const next = `${money2(owed)} is still owed for your stay: ${list.join('; ')}. We won't try your bank again on our own, so please pay it now with a bank account or a card.`
      await createNotification({
        userId: pctx.tenant_user_id,
        type: 'stay_shortened_retry_canceled',
        title: `Your bank payment won't be tried again — Unit ${pctx.unit_number}`,
        body: `${lead} ${next}`,
        data: { leaseId: a.leaseId, amount: owed, paymentIds: lines.map(l => l.id) },
        actionUrl: '/payments',
        sendEmail: true,
        emailTo: pctx.tenant_email,
        emailSubject: `Your bank payment won't be tried again — Unit ${pctx.unit_number}`,
        emailHtml: `<p>${lead}</p>`
          + `<p><b>${money2(owed)}</b> is still owed for your stay:</p>`
          + `<ul>${list.map(x => `<li>${x}</li>`).join('')}</ul>`
          + `<p>We won't try your bank again on our own, so please pay it now with a bank account or a card.</p>`
          + `<p><a href="${payUrl}" style="display:inline-block;background:#c9a227;color:#060809;font-weight:700;padding:10px 20px;border-radius:8px;text-decoration:none">Pay now</a></p>`,
        // 10/5: replies reach the people who run this property (services/replyRouting).
        replyTo: { kind: 'property', propertyId: pctx.property_id },
      })
    } catch (e) {
      logger.error({ err: e, intent, leaseId: a.leaseId }, '[booking-lease-sync] could not tell the tenant their retry was canceled')
    }
  }
}

/**
 * The guest's stay got longer and that changed what they owe: rent billed for
 * the new days (the rest of a month they already paid at the shorter amount, or
 * a month the bill run will not write), and stay-shortened credit taken back
 * because the days it came from are part of the stay again. One notice, in-app
 * and by email, with Pay now when something is owed. After COMMIT; never throws.
 */
async function notifyLongerStay(a: {
  result: LongerStayResult; newEnd: string; leaseId: string; tenantId: string | null
}): Promise<void> {
  try {
    const tenantId = a.tenantId ?? (await queryOne<{ tenant_id: string }>(
      `SELECT tenant_id FROM payments WHERE id = $1`, [a.result.billed[0]?.id ?? null]))?.tenant_id ?? null
    if (!tenantId) {
      logger.warn({ leaseId: a.leaseId }, '[booking-lease-sync] longer stay — no tenant account to tell')
      return
    }
    const ctx = await queryOne<{ tenant_user_id: string; tenant_email: string | null; unit_number: string; property_name: string; property_id: string }>(
      `SELECT t.user_id AS tenant_user_id, tu.email AS tenant_email, un.unit_number, pr.name AS property_name, pr.id AS property_id
         FROM tenants t
         JOIN users tu ON tu.id = t.user_id
         JOIN leases l ON l.id = $1
         JOIN units un ON un.id = l.unit_id
         JOIN properties pr ON pr.id = un.property_id
        WHERE t.id = $2`,
      [a.leaseId, tenantId])
    if (!ctx) {
      logger.warn({ leaseId: a.leaseId, tenantId }, '[booking-lease-sync] longer stay — no tenant account to tell')
      return
    }
    const where = `${ctx.property_name} Unit ${ctx.unit_number}`
    const owed = round2(a.result.billed.reduce((s, b) => s + b.amount, 0))
    const inUse = round2(a.result.creditInUse.reduce((s, c) => s + c.amount, 0))
    const list = a.result.billed.map(b =>
      `Rent, ${b.kind === 'rest_of_month' ? `the rest of ${monthName(b.dueDate)}` : monthName(b.dueDate)}: ${money2(b.amount)}`)
    const parts: string[] = [`Your stay at ${where} now ends ${longDate(a.newEnd)}.`]
    if (a.result.creditTakenBack > 0) {
      parts.push(`The ${money2(a.result.creditTakenBack)} credit you were given when your stay was shortened was taken back, because those days are part of your stay again.`)
    }
    if (owed > 0) {
      parts.push(`${money2(owed)} more rent is owed for your stay: ${list.join('; ')}.`)
      if (inUse > 0) {
        const left = round2(a.result.creditInUse.reduce((s, c) => s + c.left, 0))
        parts.push(`${money2(inUse)} of it is the credit from when your stay was shortened: part of that credit was already used, so it could not simply be taken back.`
          + (left > 0 ? ` The ${money2(left)} of it you still have can go toward this bill.` : ''))
      }
      parts.push('Please pay it with a bank account or a card.')
    }
    let payUrl: string | null = null
    if (owed > 0) {
      const { payNowLink } = await import('./invoiceNotice')
      try {
        payUrl = payNowLink({ tenant_user_id: ctx.tenant_user_id, tenant_email: ctx.tenant_email })
      } catch (e) {
        logger.error({ err: e, leaseId: a.leaseId }, '[booking-lease-sync] pay link failed')
        payUrl = payNowLink({ tenant_user_id: null, tenant_email: null })
      }
    }
    const title = owed > 0 ? `More rent is owed for your longer stay — Unit ${ctx.unit_number}` : `Your stay got longer — Unit ${ctx.unit_number}`
    await createNotification({
      userId: ctx.tenant_user_id,
      type: 'stay_lengthened_rent_billed',
      title,
      body: parts.join(' '),
      data: {
        leaseId: a.leaseId, amount: owed, creditTakenBack: a.result.creditTakenBack,
        paymentIds: a.result.billed.map(b => b.id),
      },
      actionUrl: '/payments',
      sendEmail: true,
      emailTo: ctx.tenant_email ?? undefined,
      emailSubject: title,
      emailHtml: parts.map(p => `<p>${p}</p>`).join('')
        + (payUrl
          ? `<p><a href="${payUrl}" style="display:inline-block;background:#c9a227;color:#060809;font-weight:700;padding:10px 20px;border-radius:8px;text-decoration:none">Pay now</a></p>`
          : ''),
      // 10/5: replies reach the people who run this property (services/replyRouting).
      replyTo: { kind: 'property', propertyId: ctx.property_id },
    })
  } catch (e) {
    logger.error({ err: e, leaseId: a.leaseId }, '[booking-lease-sync] could not tell the tenant about the longer stay')
  }
}

/**
 * The stay got longer (S655 review): rent the new dates add that nothing
 * else bills, and stay-shortened credit for days the guest now stays again.
 *
 * Unpaid bills inside the stay were already re-priced to the new schedule (an
 * unpaid bill is adjusted, decisions #19). What is left:
 *   - A month already PAID, or being paid, at the shorter stay's amount (a
 *     prorated final month that is now a whole one). Nothing re-prices a paid
 *     bill, so the rest of that month was billed nowhere and the landlord
 *     collected less than the lease says (decisions #19 applied to rent: paid
 *     and undercharged → billed). It is billed now as its own rent line for
 *     that month (is_remainder: the month's bill exists), "the rest of <month>".
 *   - A month THIS lengthening added (on or after the old end) that the regular
 *     bill run would bill but never will: that date's bill already went out
 *     without rent (the rent was removed when the stay was shortened, the bill
 *     kept its other lines), or the date is past the run's catch-up window.
 *     Billed now, whole. Which dates the run bills is the run's own answer
 *     (invoiceGeneration billDatesForLease, over the added dates): never before
 *     the property's first billing cycle, nothing while the lease is
 *     hibernating or held for review. A month inside the old stay that has no
 *     rent is never billed here — the run chose not to write it (a snowbird's
 *     off-season, a month before the first billing cycle). A month the run
 *     will still write is left to it.
 *   - Stay-shortened credit (STAY_SHORTENED_CREDIT_NOTE): money banked when
 *     the stay was shortened, for days that are now owed again. It is taken back
 *     before anything is billed — withdrawn through voidPaidAhead (never by
 *     zeroing what is left), and re-made for any part that is still over. A
 *     credit already used, or set aside by a payment still clearing, cannot be
 *     withdrawn: that part is billed as rent instead, the guest keeps the
 *     unused rest to pay with, and GAM is told (creditInUse). The reservation
 *     deposit's leftover credit is never touched: it is counted on the arrival
 *     date as the part of the reservation the first bill did not use.
 *
 * One figure decides it, over the dates the stay owes and that have been
 * billed (so a month a bill is still coming for nets nothing):
 *   gap = Σ (what the schedule owes for the date − every live rent bill for it,
 *            paid or not, plus the reservation's share on the arrival date
 *            + landlord-issued credit on those bills that counts against
 *              nights still cut from the date: creditOnCutNights)
 *         − rent money already received for dates past the new end
 *         + stay-shortened credit still standing
 * Above zero, the guest is short by that much: the credit comes back first,
 * then the rest is billed on the short dates, oldest first. At or below zero
 * nothing is billed (what is over is banked by bankOverpayment). Rent past the
 * end that is unpaid or still clearing is not counted: it is not owed, or not
 * money yet. Rent money past the end is counted exactly as bankOverpayment
 * counts it — settled and paid-via-deposit rows, a month re-paid after a
 * dispute included, net of credit the landlord issued (nobody paid that part)
 * — and landlord credit on a date still in the stay exactly as it does too, so
 * what is taken back here and what bankOverpayment banks after it add up to
 * the money that is over, and the notices name the real figures.
 *
 * Inside the caller's transaction, holding the household lock. Each bill is
 * written in its own savepoint; one that cannot be written is reported, never
 * thrown.
 */
async function billLongerStay(client: PoolClient, a: {
  leaseId: string; landlordId: string; tenantId: string | null; startDate: string
  /** The lease's end before this change (exclusive, like newEnd): dates before it were the old stay's. */
  oldEnd: string
  newEnd: string; rent: number
}): Promise<LongerStayResult> {
  const out: LongerStayResult = { billed: [], creditTakenBack: 0, creditInUse: [], notBilled: [] }
  const cents = (n: number | string) => Math.round(Number(n) * 100)
  const dollars = (c: number) => Math.round(c) / 100

  // Read on the caller's client: the lease's end already moved in this
  // transaction. The lease fields are the ones the bill run's own date rules
  // read (invoiceGeneration ACTIVE_LEASE_SELECT / billDatesForLease), so the
  // run is asked which added dates it bills, never guessed at here.
  const info = (await client.query<{
    unit_id: string; tz: string; reservation_paid: string
    rent_due_day: number; is_existing_tenancy: boolean; first_billing_cycle: string | null
    property_added_on: string | null; move_in_first_month_rent: string | null
    lease_source: string | null; supersedes_lease_id: string | null; successor_start_date: string | null
    run_skips: boolean
  }>(
    `SELECT l.unit_id, COALESCE(pr.timezone, 'America/Phoenix') AS tz,
            COALESCE(CASE WHEN l.is_existing_tenancy OR l.supersedes_lease_id IS NOT NULL THEN 0
                          ELSE ${RESERVATION_PAID_SQL}
                     END, 0)::text AS reservation_paid,
            l.rent_due_day, COALESCE(l.is_existing_tenancy, false) AS is_existing_tenancy,
            to_char(pr.first_billing_cycle, 'YYYY-MM-DD') AS first_billing_cycle,
            to_char((COALESCE(pr.onboarding_started_at, pr.created_at)
                     AT TIME ZONE COALESCE(pr.timezone, 'America/Phoenix'))::date, 'YYYY-MM-DD') AS property_added_on,
            l.move_in_first_month_rent::text AS move_in_first_month_rent,
            l.lease_source, l.supersedes_lease_id,
            -- invoiceGeneration RENEWAL_COLUMNS: a landlord-signed new lease of
            -- this one owns the dates from its start.
            (SELECT to_char(MIN(s.start_date), 'YYYY-MM-DD') FROM leases s
              WHERE s.supersedes_lease_id = l.id
                AND s.lease_source = 'esigned'
                AND s.status IN ('pending', 'active')
                AND s.signed_by_landlord) AS successor_start_date,
            -- The run writes nothing for a lease that is not active, is held
            -- for review, or is hibernating (a snowbird's off-season).
            (l.status <> 'active' OR COALESCE(l.needs_review, false) OR l.is_hibernating) AS run_skips
       FROM leases l
       JOIN units u ON u.id = l.unit_id
       JOIN properties pr ON pr.id = u.property_id
       LEFT JOIN unit_bookings b ON b.id = l.source_booking_id
      WHERE l.id = $1`,
    [a.leaseId])).rows[0]
  if (!info) return out

  const segments = computeMonthlyStaySchedule(a.startDate, a.newEnd, a.rent).segments
  if (segments.length === 0) return out
  const segOf = (d: string) => {
    let s: typeof segments[number] | null = null
    for (const x of segments) if (x.from <= d) s = x
    return s
  }

  // Every live rent bill on the lease, and the reopened rows a dispute or a
  // bank return left behind.
  const rows = (await client.query<{
    id: string; due_date: string; amount: string; issued: string; status: string; tenant_id: string | null; reopened: boolean
  }>(
    `SELECT p.id, to_char(p.due_date, 'YYYY-MM-DD') AS due_date, p.amount::text AS amount,
            p.issued_credit_amount::text AS issued, p.status, p.tenant_id, (p.reversal_id IS NOT NULL) AS reopened
       FROM payments p
      WHERE p.lease_id = $1 AND p.type = 'rent'
        AND p.status IN ('pending','failed','processing','settled','paid_via_deposit','returned')
      ORDER BY p.due_date, p.created_at, p.id`,
    [a.leaseId])).rows
  const covered = new Map<string, number>()   // segment start → cents billed for it
  const issuedOn = new Map<string, number>()  // segment start → cents of landlord-issued credit spent on those bills
  let pastEndPaid = 0
  for (const r of rows) {
    if (r.due_date < a.startDate) continue
    if (r.due_date >= a.newEnd) {
      // Rent money received for a date past the new end — the rows
      // bankOverpayment counts as paid: a month re-paid after a dispute (the
      // reopened row; its returned original brought no money) counts, and
      // credit the landlord issued on it does not (nobody paid that part).
      if (r.status === 'settled' || r.status === 'paid_via_deposit') pastEndPaid += cents(r.amount) - cents(r.issued)
      continue
    }
    // A reopened row re-asks what a dispute took back from a bill counted here
    // already (its original row, returned or not, bills the date).
    if (r.reopened) continue
    const s = segOf(r.due_date)
    if (s) {
      covered.set(s.from, (covered.get(s.from) ?? 0) + cents(r.amount))
      issuedOn.set(s.from, (issuedOn.get(s.from) ?? 0) + cents(r.issued))
    }
  }

  const credits = (await client.query<{
    id: string; tenant_id: string; note: string | null; amount_original: string; amount_remaining: string
    received_at: Date | null; created_at: Date; anchor_due: string | null; in_use: string
  }>(
    `SELECT c.id, c.tenant_id, c.note, c.amount_original::text, c.amount_remaining::text, c.received_at, c.created_at,
            to_char(sp.due_date, 'YYYY-MM-DD') AS anchor_due,
            COALESCE((SELECT SUM(u.amount) FROM credit_uses u
                       WHERE u.prepaid_credit_id = c.id AND u.status IN ('held','applied')), 0)::text AS in_use
       FROM lease_prepaid_credits c
       LEFT JOIN payments sp ON sp.id = c.source_payment_id
      WHERE c.lease_id = $1 AND c.funded_by = 'reclassified' AND c.voided_at IS NULL
      ORDER BY c.created_at DESC, c.id DESC
        FOR UPDATE OF c`,
    [a.leaseId])).rows
  // The arrival date: the reservation paid toward it what the first bill took
  // off its rent (decisions #15) — the reservation less the leftover kept as
  // credit. With nothing paid toward the reservation and no arrival bill, the
  // move-in bill is not written yet and is not this function's to count.
  const { STAY_DEPOSIT_CREDIT_NOTE } = await import('../jobs/moveInBundle')
  const leftover = credits.filter(c => c.note === STAY_DEPOSIT_CREDIT_NOTE).reduce((s, c) => s + cents(c.amount_original), 0)
  const credited = Math.max(0, cents(Math.round(Number(info.reservation_paid) * 100) / 100) - leftover)
  const arrival = segments[0].from
  if (credited > 0) covered.set(arrival, (covered.get(arrival) ?? 0) + credited)

  // A month this lengthening added (on or after the old end) with no rent bill,
  // that the bill run would bill but never will. Only added months: a month
  // inside the old stay with no rent is one the run chose not to write (a
  // hibernating snowbird's off-season, a month before the property's first
  // billing cycle, a lease held for review), and the guest is never charged
  // for it here. Which added dates the run bills is its own answer
  // (billDatesForLease over them); nothing at all while it skips the lease.
  const today = todayIn(info.tz)
  const { CATCHUP_DAYS, billDatesForLease } = await import('../jobs/invoiceGeneration')
  const runFloor = new Date(Date.parse(`${today}T12:00:00Z`) - CATCHUP_DAYS * 86400000).toISOString().slice(0, 10)
  const runBills = info.run_skips ? new Set<string>() : new Set(billDatesForLease({
    id: a.leaseId, unit_id: info.unit_id, landlord_id: a.landlordId, rent_amount: a.rent.toFixed(2),
    rent_due_day: Number(info.rent_due_day) || 1, start_date: a.startDate, end_date: a.newEnd,
    is_existing_tenancy: info.is_existing_tenancy, first_billing_cycle: info.first_billing_cycle,
    property_added_on: info.property_added_on, tenant_id: a.tenantId, property_tz: info.tz,
    lease_source: info.lease_source, move_in_first_month_rent: info.move_in_first_month_rent,
    supersedes_lease_id: info.supersedes_lease_id, successor_start_date: info.successor_start_date,
    // A booking-schedule lease is never a renewal (isRenewalSuccessor), so the
    // lease it continues plays no part in its dates.
    predecessor_end_date: null, predecessor_due_day: null,
  }, new Date(), { explicitWindow: { from: a.oldEnd, to: a.newEnd } }).dueDates)
  const wholeMonths: typeof segments = []
  for (const s of segments.slice(1)) {
    if (covered.has(s.from)) continue
    if (s.from < a.oldEnd || !runBills.has(s.from)) continue
    const billWent = (await client.query(
      `SELECT 1 FROM invoices WHERE lease_id = $1 AND due_date = $2::date AND status <> 'void' LIMIT 1`,
      [a.leaseId, s.from])).rowCount! > 0
    if (billWent || s.from < runFloor) wholeMonths.push(s)
  }

  // The gap over the dates billed so far.
  const shortOn = new Map<string, number>()
  let gap = -pastEndPaid
  const cutFrom = firstCuttableDate(segments)
  for (const s of segments) {
    const c = covered.get(s.from)
    if (c == null) continue
    // Landlord credit on the nights still cut from this date is not money
    // over (bankOverpayment counts it the same way: creditOnCutNights).
    const short = cents(s.amount) - c + creditOnCutNights(s.from, cutFrom, c, cents(s.amount), issuedOn.get(s.from) ?? 0)
    gap += short
    if (short > 0) shortOn.set(s.from, short)
  }
  const standing = credits.filter(c => c.note === STAY_SHORTENED_CREDIT_NOTE)
  gap += standing.reduce((s, c) => s + cents(c.amount_original), 0)

  // The credit comes back first: unused credit (withdrawn), then credit in
  // use (billed instead), newest first within each.
  let toTake = Math.max(0, gap)
  let billInstead = 0
  let inUseAnchor: string | null = null
  const ordered = [...standing.filter(c => cents(c.in_use) === 0), ...standing.filter(c => cents(c.in_use) > 0)]
  for (const c of ordered) {
    if (toTake <= 0) break
    const original = cents(c.amount_original)
    const take = Math.min(toTake, original)
    toTake -= take
    if (cents(c.in_use) === 0) {
      await voidPaidAhead(client, c.id,
        `The stay now ends ${a.newEnd}: the days this credit came from are part of the stay again`)
      if (original - take > 0) {
        // What is still over stays the guest's, in a credit of its own (the
        // withdrawn one keeps its record and its anchor).
        await createPaidAhead(client, {
          leaseId: a.leaseId, tenantId: c.tenant_id, amount: dollars(original - take), fundedBy: 'reclassified',
          receivedAt: c.received_at ?? c.created_at, sourcePaymentId: null, note: STAY_SHORTENED_CREDIT_NOTE,
        })
      }
      out.creditTakenBack += take
    } else {
      billInstead += take
      if (!inUseAnchor && c.anchor_due && c.anchor_due >= a.startDate && c.anchor_due < a.newEnd) {
        inUseAnchor = segOf(c.anchor_due)?.from ?? null
      }
      out.creditInUse.push({
        creditId: c.id, amount: dollars(take),
        used: dollars(original - cents(c.amount_remaining)), left: dollars(cents(c.amount_remaining)),
      })
    }
  }
  out.creditTakenBack = dollars(out.creditTakenBack)

  // What is left of the gap is billed on the short dates, oldest first; credit
  // in use that is still unplaced goes on the month it came from (else the
  // last month billed so far).
  let toBill = Math.max(0, gap - Math.round(out.creditTakenBack * 100))
  const onDate = new Map<string, number>()
  for (const s of segments) {
    if (toBill <= 0) break
    const short = shortOn.get(s.from)
    if (!short) continue
    const put = Math.min(short, toBill)
    onDate.set(s.from, put)
    toBill -= put
  }
  if (toBill > 0) {
    const lastBilled = [...segments].reverse().find(s => covered.has(s.from))?.from ?? null
    const at = inUseAnchor ?? lastBilled
    if (at) onDate.set(at, (onDate.get(at) ?? 0) + toBill)
    else out.notBilled.push({ dueDate: a.newEnd, amount: dollars(toBill), reason: 'no month of the stay has been billed yet' })
  }

  const tenantId = a.tenantId ?? rows.find(r => r.tenant_id)?.tenant_id ?? null
  const endsOn = longDate(a.newEnd)
  const write = async (dueDate: string, amountCents: number, kind: LongerStayBill['kind']) => {
    const amount = dollars(amountCents)
    if (!tenantId) {
      out.notBilled.push({ dueDate, amount, reason: 'the lease has no tenant to bill' })
      return
    }
    await client.query('SAVEPOINT longer_stay_rent')
    try {
      const r = await client.query<{ id: string }>(
        `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date,
                               entry_description, notes, is_remainder, revenue_owner)
         VALUES ($1, $2, $3, $4, 'rent', $5::numeric, 'pending', $6::date, 'RENT', $7, $8, 'landlord')
         RETURNING id`,
        [info.unit_id, a.leaseId, tenantId, a.landlordId, amount.toFixed(2), dueDate,
         kind === 'rest_of_month'
           ? `Stay now ends ${endsOn}: the rest of ${monthName(dueDate)}`
           : `Stay now ends ${endsOn}: rent for ${monthName(dueDate)}`,
         kind === 'rest_of_month'])
      await client.query('RELEASE SAVEPOINT longer_stay_rent')
      out.billed.push({ id: r.rows[0].id, dueDate, amount, kind })
    } catch (e) {
      await client.query('ROLLBACK TO SAVEPOINT longer_stay_rent')
      logger.error({ err: e, leaseId: a.leaseId, dueDate, amount }, '[booking-lease-sync] rent for a longer stay could not be billed')
      out.notBilled.push({ dueDate, amount, reason: e instanceof Error ? e.message : String(e) })
    }
  }
  for (const s of segments) {
    const c = onDate.get(s.from)
    if (c && c > 0) await write(s.from, c, 'rest_of_month')
  }
  for (const s of wholeMonths) await write(s.from, cents(s.amount), 'month')
  return out
}

/**
 * S655 — rent already paid past a shortened stay's new end becomes money paid
 * ahead ("Stay shortened"), and only money that ARRIVED counts:
 *   rent money received = settled + paid-via-deposit rent rows, net of credit
 *                         the landlord issued (nobody paid that part)
 *                       + what was paid toward the reservation the lease was
 *                         drafted from (decisions #15: the move-in bill takes it
 *                         off the arrival rent, so the rent row is billed NET
 *                         of it — the same expression moveInBundle uses:
 *                         the whole quoted total once the balance was paid,
 *                         else the deposit once it was paid)
 *   − what the stay owes now (the booking schedule over the LEASE's dates —
 *     the dates its bills are written from; a moved check-in is not applied to
 *     a signed lease), less the landlord-issued credit already spent on rent
 *     for nights still in the stay (issuedCreditOnStayNights): that credit
 *     paid those nights, so the guest's money owes only the rest. Credit on
 *     nights the new end cut, or on a date past it, is not money and is not
 *     banked.
 *   − 'reclassified' credit already on the lease (stay-shortened credit banked
 *     before, and the reservation deposit's leftover moveInBundle kept as
 *     credit: its later uses are counted through the rows they paid)
 * Landlord-issued credit on nights the stay no longer has is never banked: it
 * goes back to the guest as credit first (giveBackCreditOnCutNights), which
 * leaves every row's own money as it was.
 * Rent not paid yet is owed and nets against what was paid; rent still
 * clearing is not counted. So when ANY rent row of the lease settles later —
 * by any path, money or credit — this must run again
 * (bankShortenedStaysAfterSettle, the settle-path hook): it is idempotent
 * (what was banked before is subtracted) and banks the rest then.
 *
 * The credit is funded_by 'reclassified': the money already went out to the
 * landlord with the original rent, so it is never paid out again, and under
 * "Money received" it is not new money (it arrived with that rent). It is
 * anchored to the latest settled rent row (source_payment_id), the row it
 * reclassifies; one row anchors one credit, so a second shortening against the
 * same row is dated by its creation day instead.
 *
 * The caller holds the household lock (lockHousehold) inside its transaction,
 * and runs the whole-bill check (creditUse.runWholeBillCheckAfterCommit) after
 * its own commit when this banked anything. Returns the dollars banked now (0
 * when nothing is over).
 */
export async function bankShortenedStayOverpayment(client: PoolClient, leaseId: string): Promise<number> {
  return (await bankOverpayment(client, leaseId)).amount
}

/** What the settle-path hook banked for one lease. */
export interface StayShortenedBanked { leaseId: string; tenantId: string; landlordId: string; amount: number }

/**
 * The settle-path hook for shortened stays. After rows settle — on ANY path
 * (card or bank webhook, desk, bank-deposit match, posted payment, credit-only
 * or whole-bill settle, FlexPay cover) — every booking-schedule lease that one
 * of those rows is RENT on is re-checked (bankShortenedStayOverpayment): rent
 * that was unpaid or still clearing when the stay was shortened, and has now
 * settled, is banked as money paid ahead. Other leases cost one query and bank
 * nothing; a lease nothing is over on banks nothing (idempotent).
 *
 * Call inside the settling transaction, after the rows are settled, holding
 * the household lock. For each result, run creditUse.runWholeBillCheckAfterCommit
 * after commit (a final bill the new credit covers settles then).
 */
export async function bankShortenedStaysAfterSettle(client: PoolClient, paymentIds: readonly string[]): Promise<StayShortenedBanked[]> {
  if (paymentIds.length === 0) return []
  const leases = (await client.query<{ lease_id: string; landlord_id: string }>(
    `SELECT DISTINCT p.lease_id, l.landlord_id
       FROM payments p JOIN leases l ON l.id = p.lease_id
      WHERE p.id = ANY($1::uuid[]) AND p.type = 'rent' AND p.status IN ('settled','paid_via_deposit')
        AND l.lease_source = 'booking_draft' AND l.end_date IS NOT NULL
      ORDER BY p.lease_id`,
    [[...paymentIds]])).rows
  const out: StayShortenedBanked[] = []
  for (const l of leases) {
    const b = await bankOverpayment(client, l.lease_id)
    if (b.amount > 0 && b.tenantId) out.push({ leaseId: l.lease_id, tenantId: b.tenantId, landlordId: l.landlord_id, amount: b.amount })
  }
  return out
}

/**
 * bankShortenedStayOverpayment, plus the tenant the money was banked for (the
 * whole-bill check runs for them). `giveBackFirst` false: the caller (the
 * shortening) already gave back landlord credit on cut nights.
 */
async function bankOverpayment(
  client: PoolClient, leaseId: string, opts: { giveBackFirst?: boolean } = {},
): Promise<{ amount: number; tenantId: string | null }> {
  const NONE = { amount: 0, tenantId: null }
  const lease = (await client.query<{
    id: string; lease_source: string | null; rent_amount: string
    start_date: string | null; end_date: string | null; reservation_paid: string
  }>(
    `SELECT l.id, l.lease_source, l.rent_amount::text,
            -- The lease's own dates: its bills are written from them
            -- (invoiceGeneration, moveInBundle), and the shortening moved its
            -- end to the booking's check-out in this transaction.
            to_char(l.start_date, 'YYYY-MM-DD') AS start_date,
            to_char(l.end_date,   'YYYY-MM-DD') AS end_date,
            -- moveInBundle (decisions #15) takes this off the arrival rent of a
            -- lease drafted from a reservation: not a renewal, not an onboarding
            -- resident's existing tenancy. The ONE definition of "paid toward
            -- the reservation" (services/bookingLeaseDraft RESERVATION_PAID_SQL).
            COALESCE(CASE WHEN l.is_existing_tenancy OR l.supersedes_lease_id IS NOT NULL THEN 0
                          ELSE ${RESERVATION_PAID_SQL}
                     END, 0)::text AS reservation_paid
       FROM leases l LEFT JOIN unit_bookings b ON b.id = l.source_booking_id
      WHERE l.id = $1
        FOR UPDATE OF l`,
    [leaseId])).rows[0]
  if (!lease || !lease.start_date || !lease.end_date) return NONE
  if (!isBookingScheduleLease({ lease_source: lease.lease_source, end_date: lease.end_date })) return NONE

  // Landlord credit on nights the stay no longer has goes back to the guest
  // first (decisions #30): rent that settles after the shortening with credit
  // on it (credit a card or bank payment set aside, spent when it cleared)
  // reaches here through the settle-path hook. A no-op when nothing is on cut
  // nights, as after the shortening's own give-back. When it fails, GAM is
  // told on this transaction (the shortening tells GAM itself).
  if (opts.giveBackFirst !== false && !(await giveBackCreditSafely(client, leaseId))) {
    await tellGamCreditNotGivenBackOnSettle(client, leaseId)
  }

  const schedule = computeMonthlyStaySchedule(lease.start_date, lease.end_date, Number(lease.rent_amount))
  const owedNow = schedule.total
  const inStayCredit = await issuedCreditOnStayNights(client, {
    leaseId, startDate: lease.start_date, endDate: lease.end_date, segments: schedule.segments,
    reservationPaid: Number(lease.reservation_paid),
  })
  const money = (await client.query<{ paid: string; banked: string }>(
    `SELECT COALESCE((SELECT SUM(p.amount - p.issued_credit_amount) FROM payments p
                       WHERE p.lease_id = $1 AND p.type = 'rent'
                         AND p.status IN ('settled','paid_via_deposit')), 0)::text AS paid,
            COALESCE((SELECT SUM(c.amount_original) FROM lease_prepaid_credits c
                       WHERE c.lease_id = $1 AND c.funded_by = 'reclassified'
                         AND c.voided_at IS NULL), 0)::text AS banked`,
    [leaseId])).rows[0]
  const paid = Number(money.paid) + Math.round(Number(lease.reservation_paid) * 100) / 100
  // What the guest's own money owes: the stay, less the landlord credit that
  // already paid nights still in it.
  const over = Math.round((paid - (owedNow - inStayCredit) - Number(money.banked)) * 100) / 100
  if (over <= 0.005) return NONE

  const anchor = (await client.query<{ id: string; tenant_id: string | null; settled_at: Date | null; taken: boolean }>(
    `SELECT p.id, p.tenant_id, p.settled_at,
            EXISTS (SELECT 1 FROM lease_prepaid_credits c WHERE c.source_payment_id = p.id) AS taken
       FROM payments p
      WHERE p.lease_id = $1 AND p.type = 'rent' AND p.status IN ('settled','paid_via_deposit')
      ORDER BY p.due_date DESC, p.created_at DESC, p.id DESC
      LIMIT 1`,
    [leaseId])).rows[0]
  const tenant = (await client.query<{ tenant_id: string | null }>(
    `SELECT COALESCE(
              (SELECT t.tenant_id FROM v_lease_active_tenants t WHERE t.lease_id = $1
                ORDER BY (t.role = 'primary') DESC, t.added_at, t.tenant_id LIMIT 1),
              $2::uuid) AS tenant_id`,
    [leaseId, anchor?.tenant_id ?? null])).rows[0]?.tenant_id
  if (!tenant) {
    logger.error({ leaseId, over }, '[booking-lease-sync] rent paid past the new end has no tenant to bank it for')
    return NONE
  }
  await createPaidAhead(client, {
    leaseId,
    tenantId: tenant,
    amount: over,
    fundedBy: 'reclassified',
    receivedAt: anchor?.settled_at ?? new Date(),
    sourcePaymentId: anchor && !anchor.taken ? anchor.id : null,
    note: STAY_SHORTENED_CREDIT_NOTE,
  })
  logger.info({ leaseId, over }, '[booking-lease-sync] stay shortened — rent paid past the new end banked as money paid ahead')
  return { amount: over, tenantId: tenant }
}

/**
 * Landlord-issued credit already spent on rent for nights still in the stay
 * (dollars). That credit paid those nights, so the guest's own money owes only
 * the rest of them; bankOverpayment takes it off what the stay owes before it
 * banks what is over. Without this the guest's money was asked to pay nights
 * the landlord's credit had already paid, and that much of their money paid
 * for nights they no longer stay was never banked.
 *
 * Per date of the schedule (a bill belongs to the segment it falls in, as in
 * billLongerStay): the issued credit on the date's live rent bills, less what
 * of it counts against nights the new end cut from that date
 * (creditOnCutNights: only the month the stay ends in can have lost nights;
 * the arrival date's bills count the reservation's share the first bill took
 * off). A reopened row carries no credit (credit never
 * pays one) and is not a bill of its own. Credit on a date past the end paid
 * nothing the stay still owes, so it is not counted here.
 */
async function issuedCreditOnStayNights(client: PoolClient, a: {
  leaseId: string; startDate: string; endDate: string
  segments: ReadonlyArray<{ from: string; amount: number }>
  reservationPaid: number
}): Promise<number> {
  const cents = (n: number | string) => Math.round(Number(n) * 100)
  const bills = (await client.query<{ due_date: string; amount: string; issued: string }>(
    `SELECT to_char(p.due_date, 'YYYY-MM-DD') AS due_date, p.amount::text AS amount,
            p.issued_credit_amount::text AS issued
       FROM payments p
      WHERE p.lease_id = $1 AND p.type = 'rent' AND p.reversal_id IS NULL
        AND p.status IN ('pending','failed','processing','settled','paid_via_deposit','returned')
        AND p.due_date >= $2::date AND p.due_date < $3::date`,
    [a.leaseId, a.startDate, a.endDate])).rows
  if (!bills.some(b => cents(b.issued) > 0) || a.segments.length === 0) return 0

  const segOf = (d: string) => {
    let s: (typeof a.segments)[number] | null = null
    for (const x of a.segments) if (x.from <= d) s = x
    return s
  }
  const billed = new Map<string, number>()
  const issued = new Map<string, number>()
  for (const b of bills) {
    const s = segOf(b.due_date)
    if (!s) continue
    billed.set(s.from, (billed.get(s.from) ?? 0) + cents(b.amount))
    issued.set(s.from, (issued.get(s.from) ?? 0) + cents(b.issued))
  }
  // The arrival date: the reservation paid toward it what the first bill took
  // off its rent (decisions #15) — the reservation less the leftover kept as
  // credit, as billLongerStay counts it.
  const arrival = a.segments[0].from
  if ((issued.get(arrival) ?? 0) > 0 && a.reservationPaid > 0) {
    const { STAY_DEPOSIT_CREDIT_NOTE } = await import('../jobs/moveInBundle')
    const leftover = (await client.query<{ total: string }>(
      `SELECT COALESCE(SUM(c.amount_original), 0)::text AS total FROM lease_prepaid_credits c
        WHERE c.lease_id = $1 AND c.funded_by = 'reclassified' AND c.voided_at IS NULL AND c.note = $2`,
      [a.leaseId, STAY_DEPOSIT_CREDIT_NOTE])).rows[0]?.total ?? '0'
    const share = Math.max(0, cents(a.reservationPaid) - cents(leftover))
    if (share > 0) billed.set(arrival, (billed.get(arrival) ?? 0) + share)
  }
  let onStay = 0
  const cutFrom = firstCuttableDate(a.segments)
  for (const s of a.segments) {
    const c = issued.get(s.from) ?? 0
    if (c <= 0) continue
    onStay += c - creditOnCutNights(s.from, cutFrom, billed.get(s.from) ?? 0, cents(s.amount), c)
  }
  return onStay / 100
}

/** Landlord-issued credit a shorter stay gave back, by the date of the rent it had paid. */
interface CreditGivenBack { dueDate: string; amount: number }

/** What giveBackCreditOnCutNights did. */
interface GiveBackResult {
  given: CreditGivenBack[]
  /** Dollars given back in all. */
  total: number
}
const NO_GIVE_BACK: GiveBackResult = { given: [], total: 0 }

/**
 * Decisions #30 / #35.3 (Nic: "landlord credit spent on nights no longer in
 * the stay comes back as SAVED credit"). Credit the landlord issued that paid
 * rent for nights the stay no longer has goes back to the guest, unspent, for a
 * later bill; the guest's own money for those nights is banked as money paid
 * ahead (bankOverpayment), never this credit. Every dollar once.
 *
 * Per date of the schedule, over every live rent bill for it (a bill belongs to
 * the segment it falls in; a date on or after the end owes nothing): the
 * credit that counts against nights the new end cut from that date
 * (creditOnCutNights — the ONE rule bankOverpayment and billLongerStay count
 * by, so what comes back here is exactly the credit they leave out of the
 * guest's money). Only the month the stay ends in and dates past the end can
 * have lost nights; a whole month inside the stay is never touched here, even
 * when its bill asks more than the schedule now does (a rent lowered mid-stay
 * by a signed addendum is not a shorter stay). Its uses go back newest first (credit_uses released,
 * 'stay_shortened'): the ledger trigger puts the amount back on the credit and
 * takes the rent row's amount down by the same amount, so the row's own money
 * never moves and no report or payout counts the credit as money. The row and
 * its invoice say so. A use is a record and never changes amount, so when the
 * last one goes back past what the cut nights took, the part of it that still
 * pays nights in the stay is spent again from the same credit on a rent row of
 * its own for that date ("still paid by the landlord's credit"), settled at
 * once: the date bills what it did less what came back. Such a row that a
 * later, shorter end takes all of its credit back from is left at $0 and says
 * nothing is owed or paid on it any more.
 *
 * Only credit that can be used again comes back: a credit the landlord voided
 * keeps its spends, and so does credit on a row a dispute or return took the
 * money back from (the reopened row carries that). Deposit interest and
 * paid-ahead money are the guest's money; bankOverpayment banks them.
 *
 * Idempotent (credit already given back is not on the row any more), so the
 * shortening runs it before anything past the new end is removed (a row whose
 * only history was that credit can then go), and bankOverpayment runs it
 * again for rent that settles later with credit on it — both paths by the same
 * rules. A date still in the stay that has an UNPAID bill (pending or failed)
 * carrying credit is left alone until that bill is paid: the shortening
 * re-prices an unpaid bill money-first, and the one left with credit on it is
 * the bill it could not bring down (more credit spent on it than the new
 * amount; GAM is told then, and settles it with the landlord). Giving the
 * credit back there would leave the guest asked for more than those nights
 * are worth. Once that bill is paid, the credit on its cut nights comes back
 * and any money over is banked. A date past the end is never held back: none
 * of it is owed, and a row whose only history was that credit can then go.
 * Inside the caller's transaction, holding the household lock.
 */
async function giveBackCreditOnCutNights(client: PoolClient, leaseId: string): Promise<GiveBackResult> {
  const cents = (n: number | string) => Math.round(Number(n) * 100)
  const dollars = (c: number) => Math.round(c) / 100
  const lease = (await client.query<{
    lease_source: string | null; rent_amount: string; start_date: string | null; end_date: string | null; reservation_paid: string
  }>(
    `SELECT l.lease_source, l.rent_amount::text,
            to_char(l.start_date, 'YYYY-MM-DD') AS start_date,
            to_char(l.end_date,   'YYYY-MM-DD') AS end_date,
            COALESCE(CASE WHEN l.is_existing_tenancy OR l.supersedes_lease_id IS NOT NULL THEN 0
                          ELSE ${RESERVATION_PAID_SQL}
                     END, 0)::text AS reservation_paid
       FROM leases l LEFT JOIN unit_bookings b ON b.id = l.source_booking_id
      WHERE l.id = $1`,
    [leaseId])).rows[0]
  if (!lease || !lease.start_date || !lease.end_date) return NO_GIVE_BACK
  if (!isBookingScheduleLease({ lease_source: lease.lease_source, end_date: lease.end_date })) return NO_GIVE_BACK
  const endDate = lease.end_date
  const segments = computeMonthlyStaySchedule(lease.start_date, endDate, Number(lease.rent_amount)).segments
  if (segments.length === 0) return NO_GIVE_BACK

  // Every live rent bill of the stay (a reopened row re-asks what a dispute
  // took and carries no credit; it is not a bill of its own). `unpaid_with_credit`:
  // not paid yet, with credit set aside or spent on it (the re-price's own
  // measure of credit on a bill).
  const bills = (await client.query<{ id: string; due_date: string; amount: string; issued: string; unpaid_with_credit: boolean }>(
    `SELECT p.id, to_char(p.due_date, 'YYYY-MM-DD') AS due_date, p.amount::text AS amount,
            p.issued_credit_amount::text AS issued,
            (p.status IN ('pending','failed')
             AND EXISTS (SELECT 1 FROM credit_uses u WHERE u.payment_id = p.id AND u.status IN ('held','applied'))) AS unpaid_with_credit
       FROM payments p
      WHERE p.lease_id = $1 AND p.type = 'rent' AND p.reversal_id IS NULL
        AND p.status IN ('pending','failed','processing','settled','paid_via_deposit','returned')
        AND p.due_date >= $2::date
      ORDER BY p.id FOR UPDATE OF p`,
    [leaseId, lease.start_date])).rows
  if (!bills.some(b => cents(b.issued) > 0)) return NO_GIVE_BACK

  const segOf = (d: string) => {
    let s: (typeof segments)[number] | null = null
    for (const x of segments) if (x.from <= d) s = x
    return s
  }
  const cutFrom = firstCuttableDate(segments)
  const dates = new Map<string, { owed: number; billed: number; issued: number; ids: string[]; unpaidWithCredit: boolean }>()
  for (const b of bills) {
    const s = b.due_date >= endDate ? null : segOf(b.due_date)
    const key = s ? s.from : b.due_date
    const g = dates.get(key) ?? { owed: s ? cents(s.amount) : 0, billed: 0, issued: 0, ids: [], unpaidWithCredit: false }
    g.billed += cents(b.amount)
    g.issued += cents(b.issued)
    g.ids.push(b.id)
    g.unpaidWithCredit ||= b.unpaid_with_credit
    dates.set(key, g)
  }
  // The arrival date: the reservation paid toward it what the first bill took
  // off its rent (decisions #15), counted as issuedCreditOnStayNights counts it.
  const arrival = dates.get(segments[0].from)
  if (arrival && arrival.issued > 0 && Number(lease.reservation_paid) > 0) {
    const { STAY_DEPOSIT_CREDIT_NOTE } = await import('../jobs/moveInBundle')
    const leftover = (await client.query<{ total: string }>(
      `SELECT COALESCE(SUM(c.amount_original), 0)::text AS total FROM lease_prepaid_credits c
        WHERE c.lease_id = $1 AND c.funded_by = 'reclassified' AND c.voided_at IS NULL AND c.note = $2`,
      [leaseId, STAY_DEPOSIT_CREDIT_NOTE])).rows[0]?.total ?? '0'
    arrival.billed += Math.max(0, cents(lease.reservation_paid) - cents(leftover))
  }

  const out: GiveBackResult = { given: [], total: 0 }
  const endsOn = longDate(endDate)
  for (const [date, g] of [...dates].sort(([a], [b]) => a.localeCompare(b))) {
    if (g.issued <= 0) continue
    // A date in the stay with an unpaid bill carrying credit waits until that
    // bill is paid (see above); a date past the end never waits.
    if (date < endDate && g.unpaidWithCredit) continue
    const cut = creditOnCutNights(date, cutFrom, g.billed, g.owed, g.issued)
    if (cut <= 0) continue
    const uses = (await client.query<{
      id: string; amount: string; tenant_credit_id: string; payment_id: string; billing_month: string
      source: CreditUseSource; created_by: string | null
      due_date: string; invoice_id: string | null; tenant_id: string | null; unit_id: string | null; landlord_id: string
    }>(
      `SELECT u.id, u.amount::text AS amount, u.tenant_credit_id, u.payment_id,
              to_char(u.billing_month, 'YYYY-MM-DD') AS billing_month, u.source, u.created_by,
              to_char(p.due_date, 'YYYY-MM-DD') AS due_date, p.invoice_id, p.tenant_id, p.unit_id, p.landlord_id
         FROM credit_uses u
         JOIN tenant_credits tc ON tc.id = u.tenant_credit_id
         JOIN payments p ON p.id = u.payment_id
        WHERE u.payment_id = ANY($1::uuid[]) AND u.status = 'applied'
          AND tc.category <> 'deposit_interest' AND tc.status = 'active'
          AND p.status <> 'returned'
        ORDER BY u.applied_at DESC, u.id DESC`,
      [g.ids])).rows
    const give = Math.min(cut, uses.reduce((s, u) => s + cents(u.amount), 0))
    if (give <= 0) continue

    let released = 0
    let last: (typeof uses)[number] | null = null
    const offRow = new Map<string, { cents: number; invoiceId: string | null }>()
    for (const u of uses) {
      if (released >= give) break
      // The ledger trigger puts it back on the credit and takes the rent row's
      // amount down by the same amount.
      const r = await client.query(
        `UPDATE credit_uses SET status = 'released', released_at = now(), release_reason = 'stay_shortened'
          WHERE id = $1 AND status = 'applied'`,
        [u.id])
      if (r.rowCount === 0) continue
      released += cents(u.amount)
      last = u
      const off = offRow.get(u.payment_id) ?? { cents: 0, invoiceId: u.invoice_id }
      off.cents += cents(u.amount)
      offRow.set(u.payment_id, off)
    }
    for (const [paymentId, r] of offRow) {
      // The trigger already took the amount down. A row that asked only for
      // credit (the rent a shorter end left on credit, spent again on a row of
      // its own) is now $0: it says so, so nobody reads it as still paid.
      const back = `Stay now ends ${endsOn}: ${money2(dollars(r.cents))} of credit the landlord gave, spent on this rent, went back to the guest as credit`
      await client.query(
        `UPDATE payments p
            SET notes = CONCAT_WS(' · ', NULLIF(p.notes, ''),
                                  CASE WHEN p.amount = 0 THEN $3::text ELSE $2::text END)
          WHERE p.id = $1`,
        [paymentId, back, `${back}; nothing is owed or paid on this line any more`])
      await adjustInvoiceRent(client, r.invoiceId, -dollars(r.cents))
    }

    // The part of the last use that still pays nights in the stay: spent again
    // from the same credit, on a rent row of its own for that date.
    const keep = released - give
    if (keep > 0 && last) {
      const row = await client.query<{ id: string }>(
        `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, invoice_id, type, amount, status, due_date,
                               entry_description, notes, is_remainder, revenue_owner)
         VALUES ($1, $2, $3, $4, $5, 'rent', $6::numeric, 'pending', $7::date, 'RENT', $8, true, 'landlord')
         RETURNING id`,
        [last.unit_id, leaseId, last.tenant_id, last.landlord_id, last.invoice_id, dollars(keep).toFixed(2), last.due_date,
         `Stay now ends ${endsOn}: rent for ${monthName(last.due_date)} still paid by credit the landlord gave`])
      const rowId = row.rows[0].id
      await applyCredit(client, [{
        creditKind: 'issued', creditId: last.tenant_credit_id, paymentId: rowId, leaseId,
        amount: dollars(keep), billingMonth: last.billing_month,
      }], {
        // The spend it continues; the deploy backfill's own source is only for that backfill.
        source: last.source === 'backfill' ? 'whole_bill' : last.source,
        createdBy: last.created_by,
      })
      // Landlord-issued credit pays the landlord nothing (they gave it), so
      // nothing is held for a payout.
      await client.query(
        `UPDATE payments SET status = 'settled', settled_at = now(), platform_held = false WHERE id = $1 AND status = 'pending'`,
        [rowId])
      await adjustInvoiceRent(client, last.invoice_id, dollars(keep))
    }
    out.given.push({ dueDate: date, amount: dollars(give) })
    out.total += give
  }
  out.total = dollars(out.total)
  if (out.total > 0) logger.info({ leaseId, given: out.given }, '[booking-lease-sync] stay shortened — landlord credit on nights no longer in the stay given back')
  return out
}

/** The admin alert category for a give-back that failed, on either path. */
const CREDIT_NOT_GIVEN_BACK = 'stay_shortened_credit_not_given_back'

/**
 * What GAM is told when the give-back failed. `when` says which path ran it:
 * the stay's dates changing, or rent on the stay settling. Saving the same
 * dates again changes nothing (the lease already ends there), so the retry it
 * names is the real one: every later rent settle on the stay runs it again.
 */
function creditNotGivenBackAlert(who: string, endsOn: string, when: 'dates' | 'settle'): { title: string; body: string } {
  return {
    title: `Credit on nights no longer in a stay was not given back — ${who}`,
    body: (when === 'dates'
      ? `The stay now ends ${endsOn}. `
      : `Rent on this stay was paid. The stay ends ${endsOn}. `) +
      `Credit the landlord gave that paid rent for nights no longer in the stay should have gone back to the guest as credit, ` +
      `but it could not (see the API log). It stays spent for now, and only the guest's own money was banked as money paid ahead. ` +
      `It is tried again each time rent on this stay is paid; if no more rent is coming, fix the cause and settle it with the landlord.`,
  }
}

/**
 * The give-back failed while rent on the stay settled (bankOverpayment on the
 * settle-path hook). GAM is told as the shortening tells it, written on the
 * settle's own transaction so the alert exists exactly when the settle does:
 * the callers (card and bank webhook, desk, credit-only and whole-bill
 * settles) have no after-commit step for it. Its own savepoint; never throws.
 */
async function tellGamCreditNotGivenBackOnSettle(client: PoolClient, leaseId: string): Promise<void> {
  await client.query('SAVEPOINT stay_shortened_credit_back_alert')
  try {
    const l = (await client.query<{
      landlord_id: string; booking_id: string | null; guest_name: string | null; unit_number: string | null; end_date: string | null
    }>(
      `SELECT l.landlord_id, l.source_booking_id AS booking_id, b.guest_name, u.unit_number,
              to_char(l.end_date, 'YYYY-MM-DD') AS end_date
         FROM leases l
         LEFT JOIN unit_bookings b ON b.id = l.source_booking_id
         LEFT JOIN units u ON u.id = l.unit_id
        WHERE l.id = $1`,
      [leaseId])).rows[0]
    const who = `${l?.guest_name || 'the guest'} on unit ${l?.unit_number || 'unknown'}`
    const { title, body } = creditNotGivenBackAlert(who, l?.end_date ?? 'unknown', 'settle')
    await client.query(
      `INSERT INTO admin_notifications (severity, category, title, body, context)
       VALUES ('warn', $1, $2, $3, $4)`,
      [CREDIT_NOT_GIVEN_BACK, title, body,
       JSON.stringify({ lease_id: leaseId, booking_id: l?.booking_id ?? null, landlord_id: l?.landlord_id ?? null })])
    await client.query('RELEASE SAVEPOINT stay_shortened_credit_back_alert')
  } catch (e) {
    await client.query('ROLLBACK TO SAVEPOINT stay_shortened_credit_back_alert')
    logger.error({ err: e, leaseId }, '[booking-lease-sync] could not tell GAM the credit was not given back')
  }
}

/**
 * giveBackCreditOnCutNights in its own savepoint: a failure is logged and
 * never undoes the date move or a settle (the credit then stays spent, as it
 * was, and bankOverpayment still banks only money). Null when it failed; the
 * caller tells GAM.
 */
async function giveBackCreditSafely(client: PoolClient, leaseId: string): Promise<GiveBackResult | null> {
  await client.query('SAVEPOINT stay_shortened_credit_back')
  try {
    const r = await giveBackCreditOnCutNights(client, leaseId)
    await client.query('RELEASE SAVEPOINT stay_shortened_credit_back')
    return r
  } catch (e) {
    await client.query('ROLLBACK TO SAVEPOINT stay_shortened_credit_back')
    logger.error({ err: e, leaseId }, '[booking-lease-sync] landlord credit on nights no longer in the stay could not be given back')
    return null
  }
}
