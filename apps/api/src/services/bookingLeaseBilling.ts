// ============================================================
// S548 — calendar-aligned billing for booking-sourced leases (Nic).
//
// A 30+ night stay books at a monthly rate, billed like a resident:
// prorated arrival month (days × monthly/30), flat monthly on the 1st
// with all tenants, prorated departure month. The public quote, the
// booking's stored total, and the INVOICES all come from the same
// shared computeMonthlyStaySchedule — they can never disagree.
//
// This module gives the two billing writers (moveInBundle for the
// arrival invoice, invoiceGeneration for the 1st-of-month cycle) their
// per-due-date amounts, and owns the Master Schedule → lease sync:
// date changes update the lease, drop no-longer-owed pending rent, and
// bank any overpayment as a lease_prepaid_credit — which invoice
// generation already nets against the NEXT invoice (the final one
// carries the last meter-read utility bills, so "credit minus final
// meter read" falls out of the existing machinery).
//
// Regular (non-booking) leases are untouched: their move-in proration
// and full-month cycle keep the long-standing behavior.
// ============================================================
import { computeMonthlyStaySchedule } from '@gam/shared'
import { query, queryOne } from '../db'
import { logger } from '../lib/logger'
import { createNotification } from './notifications'

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
 * Master Schedule → lease sync (S548). Called after a booking's dates
 * change. Best-effort by design — callers .catch(); a sync failure never
 * unwinds the booking edit.
 *
 * pending lease  → dates simply follow the booking (still unsigned).
 * active lease   → end_date follows; pending rent falling past the new
 *                  end is deleted; rent settled beyond the new obligation
 *                  becomes a lease_prepaid_credit (netted automatically
 *                  against the next/final invoice). A check-IN change on
 *                  an active lease is NOT auto-applied — the landlord is
 *                  notified to amend the signed document.
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
  if (endMoved) {
    await query(`UPDATE leases SET end_date = $2, updated_at = now() WHERE id = $1`, [lease.id, lease.check_out])
  }

  let creditAmount = 0
  if (endMoved && isBookingScheduleLease({ lease_source: lease.lease_source, end_date: lease.check_out })) {
    // Drop pending rent that's no longer owed (due on/after the new end —
    // the final prorated segment's invoice is dated its own 1st, which is
    // before the end, so it survives).
    const dropped = await query<{ id: string; invoice_id: string | null }>(
      `DELETE FROM payments
        WHERE lease_id = $1 AND type = 'rent' AND status = 'pending'
          AND due_date >= $2::date
        RETURNING id, invoice_id`,
      [lease.id, lease.check_out])
    for (const d of dropped) {
      if (!d.invoice_id) continue
      // An invoice left with no payments is an empty shell — remove it.
      await query(
        `DELETE FROM invoices i WHERE i.id = $1
           AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.invoice_id = i.id)`,
        [d.invoice_id])
    }

    // Overpayment: rent settled beyond the new obligation → prepaid credit.
    const owedNow = computeMonthlyStaySchedule(lease.check_in, lease.check_out, Number(lease.rent_amount)).total
    const settled = await queryOne<{ s: string }>(
      `SELECT COALESCE(SUM(amount), 0) AS s FROM payments
        WHERE lease_id = $1 AND type = 'rent'
          AND status IN ('settled', 'processing', 'paid_via_deposit')`,
      [lease.id])
    creditAmount = Math.round(Math.max(0, Number(settled?.s ?? 0) - owedNow) * 100) / 100
    if (creditAmount > 0) {
      const tenant = await queryOne<{ tenant_id: string }>(
        `SELECT tenant_id FROM v_lease_active_tenants WHERE lease_id = $1 AND role = 'primary' LIMIT 1`,
        [lease.id])
      await query(
        `INSERT INTO lease_prepaid_credits (lease_id, tenant_id, amount_original, amount_remaining)
         VALUES ($1, $2, $3, $3)`,
        [lease.id, tenant?.tenant_id ?? null, creditAmount.toFixed(2)])
      logger.info({ leaseId: lease.id, bookingId, creditAmount },
        '[booking-lease-sync] stay shortened — overpaid rent banked as prepaid credit')
    }
  }

  // Tell the landlord what the schedule edit did to the money.
  try {
    const owner = await queryOne<{ user_id: string }>(
      `SELECT user_id FROM landlords WHERE id = $1`, [lease.landlord_id])
    if (owner && (endMoved || startMoved)) {
      const bits: string[] = []
      if (endMoved) bits.push(`lease end moved to ${lease.check_out}`)
      if (creditAmount > 0) bits.push(`$${creditAmount.toFixed(2)} already paid past the new end is banked as a credit and will offset their final bill (utilities included)`)
      if (startMoved) bits.push(`the signed lease still starts ${lease.start_date} — amend the document if the ${lease.check_in} arrival is right`)
      await createNotification({
        userId: owner.user_id,
        landlordId: lease.landlord_id,
        type: 'booking_lease_sync',
        title: `Stay dates changed — ${lease.guest_name || 'guest'} on unit ${lease.unit_number}`,
        body: `The reservation's dates changed: ${bits.join('; ')}.`,
        data: { leaseId: lease.id, bookingId, creditAmount },
        actionUrl: `/leases?open=${lease.id}`,
      })
    }
  } catch (err) {
    logger.error({ err, bookingId }, '[booking-lease-sync] notification failed')
  }
}
