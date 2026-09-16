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
 * WHAT IT DOES NOT DO: re-draft. A landlord voids for many reasons, including
 * "this person is not moving in". The household reappears on the front desk as
 * a voided lease, and re-sending is the landlord's decision.
 */
import { AppError } from '../middleware/errorHandler'

type Q = (text: string, params?: any[]) => Promise<{ rows: any[] }>

export async function unwindIssuedLease(
  q: Q,
  doc: { id: string; lease_id: string | null; issued_at: string | Date | null; unit_id: string | null },
): Promise<{ unwound: boolean }> {
  if (!doc.issued_at || !doc.lease_id) return { unwound: false }
  const leaseId = doc.lease_id

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

  // ── Utility: back on hold, out of the unique slot ────────────────────────
  const bills = (await q(
    `SELECT * FROM utility_bills WHERE lease_id = $1`, [leaseId])).rows
  for (const b of bills) {
    const hold = (await q(
      `SELECT id FROM suspended_utility_charges WHERE released_bill_id = $1`, [b.id])).rows[0]
    if (hold) {
      await q(
        `UPDATE suspended_utility_charges
            SET released_at = NULL, released_bill_id = NULL, updated_at = NOW(),
                notes = COALESCE(notes || ' — ', '') || 'held again: the lease it was released onto was voided'
          WHERE id = $1`, [hold.id])
    } else {
      // A bill the monthly run made directly on this lease. Re-raise it as a
      // hold so there stays ONE way a pre-lease charge reaches a tenancy.
      await q(
        `INSERT INTO suspended_utility_charges
           (meter_id, unit_id, landlord_id, billing_cycle_month, utility_type,
            usage_amount, allocation_method, allocation_basis, rate_per_unit,
            base_fee_share, charge_amount, tax_rate_pct, tax_amount,
            sewer_rate_per_unit, reading_start, reading_end,
            reading_start_date, reading_end_date, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,
                 'held: the lease this was billed to was voided before the tenant signed')
         ON CONFLICT DO NOTHING`,
        [b.meter_id, b.unit_id, b.landlord_id, b.billing_cycle_month, b.utility_type,
         b.usage_amount, b.allocation_method, b.allocation_basis, b.rate_per_unit,
         b.base_fee_share, b.charge_amount, b.tax_rate_pct, b.tax_amount,
         b.sewer_rate_per_unit, b.reading_start, b.reading_end,
         b.reading_start_date, b.reading_end_date])
    }
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
