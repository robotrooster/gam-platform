// Common-area reservation core: overlap-conflict detection under an
// advisory lock, so two concurrent approvals for the same area + window
// can't both win. Field validation (hours, length, lead time) lives in the
// route; this module owns the transactional integrity piece.
//
// Also owns reservation-fee charging (#4): the fee is billed on-platform as a
// normal `payments` row (type='fee', fee_type='amenity_fee') the tenant pays
// through the existing Stripe rails — refundable if cancelled 48h+ ahead.
import type { PoolClient } from 'pg'
import { query, queryOne } from '../db'

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

// Apply the cancellation refund policy. ≥48h before start → refundable: an unpaid
// (pending/failed) fee is voided (deleted, never charged); a paid (settled) fee is
// flagged fee_refund_due for the admin to refund via Stripe. <48h → fee stands.
export async function settleReservationFeeOnCancel(
  r: { id: string; fee_payment_id: string | null; starts_at: string | Date }
): Promise<'none' | 'voided' | 'refund_due' | 'fee_stands'> {
  if (!r.fee_payment_id) return 'none'
  const hoursBefore = (new Date(r.starts_at).getTime() - Date.now()) / 3_600_000
  if (hoursBefore < REFUNDABLE_WINDOW_HOURS) return 'fee_stands'

  const pay = await queryOne<{ status: string }>(`SELECT status FROM payments WHERE id = $1`, [r.fee_payment_id])
  if (!pay) return 'none'
  if (pay.status === 'settled' || pay.status === 'processing') {
    await query(`UPDATE common_area_reservations SET fee_refund_due = true WHERE id = $1`, [r.id])
    return 'refund_due'
  }
  // pending / failed → never charged; void it so the tenant isn't billed.
  await query(`DELETE FROM payments WHERE id = $1 AND status IN ('pending','failed')`, [r.fee_payment_id])
  await query(`UPDATE common_area_reservations SET fee_voided = true, fee_payment_id = NULL WHERE id = $1`, [r.id])
  return 'voided'
}
