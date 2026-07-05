import { query, queryOne } from '../db'
import { logger } from '../lib/logger'
import { createNotification } from './notifications'

// S526 (Nic): "anyone staying 30 or more days needs to be drafted a lease
// automatically" — guests often just keep staying. When a reservation is
// created or its dates change and the stay meets the property's threshold
// (30 days; 7 when the property runs weekly leases — weekly_lease_mode),
// draft a PENDING lease from the booking for the landlord to review:
//   * lease_source 'booking_draft', needs_review TRUE (landlord completes:
//     attach the tenant account, adjust rent/terms, send for signature)
//   * rent = the unit's monthly rent (fallback: its monthly stay rate)
//   * idempotent per booking via the unique source_booking_id index —
//     re-checks (extend, move) never create a second draft.
// Best-effort by design: callers .catch() so a draft failure never fails
// the reservation itself.
export async function maybeDraftLeaseFromBooking(bookingId: string): Promise<{ drafted: boolean; leaseId?: string }> {
  const booking = await queryOne<any>(
    `SELECT b.id, b.unit_id, b.landlord_id, b.status, b.check_in, b.check_out, b.guest_name,
            u.rent_amount, u.monthly_rate, u.unit_number,
            p.weekly_lease_mode
       FROM unit_bookings b
       JOIN units u ON u.id = b.unit_id
       JOIN properties p ON p.id = u.property_id
      WHERE b.id = $1`,
    [bookingId],
  )
  if (!booking) return { drafted: false }
  if (['cancelled', 'no_show', 'checked_out'].includes(booking.status)) return { drafted: false }

  const nights = Math.round(
    (new Date(booking.check_out).getTime() - new Date(booking.check_in).getTime()) / 86400000,
  )
  const threshold = booking.weekly_lease_mode ? 7 : 30
  if (nights < threshold) return { drafted: false }

  // One draft per booking — the unique partial index backs this up.
  const existing = await queryOne<{ id: string }>(
    `SELECT id FROM leases WHERE source_booking_id = $1`,
    [bookingId],
  )
  if (existing) return { drafted: false, leaseId: existing.id }

  const rent = Number(booking.rent_amount) > 0
    ? Number(booking.rent_amount)
    : Number(booking.monthly_rate) > 0 ? Number(booking.monthly_rate) : 0

  const rows = await query<any>(
    `INSERT INTO leases
       (unit_id, landlord_id, rent_amount, lease_type, status, start_date, end_date,
        needs_review, lease_source, source_booking_id)
     VALUES ($1, $2, $3, 'fixed_term', 'pending', $4, $5, TRUE, 'booking_draft', $6)
     ON CONFLICT (source_booking_id) WHERE source_booking_id IS NOT NULL DO NOTHING
     RETURNING id`,
    [booking.unit_id, booking.landlord_id, rent, booking.check_in, booking.check_out, bookingId],
  )
  const leaseId = rows[0]?.id
  if (leaseId) {
    logger.info({ bookingId, leaseId, nights, threshold },
      '[booking-lease-draft] stay met the lease threshold — draft lease created')
    // In-app heads-up to the landlord — the draft needs a tenant + review.
    // Best-effort: a notification failure never unwinds the draft.
    try {
      const owner = await queryOne<{ user_id: string }>(
        `SELECT user_id FROM landlords WHERE id = $1`, [booking.landlord_id])
      if (owner) {
        await createNotification({
          userId: owner.user_id,
          landlordId: booking.landlord_id,
          type: 'lease_drafted_from_booking',
          title: 'Lease drafted from a long stay',
          body: `${booking.guest_name || 'A guest'} on unit ${booking.unit_number} is staying ${nights} nights — a draft lease was created for your review on the Leases page.`,
          data: { leaseId, bookingId },
          actionUrl: `/leases?open=${leaseId}`,   // S527 W-1: deep-link to the draft
        })
      }
    } catch (err) {
      logger.error({ err, bookingId, leaseId }, '[booking-lease-draft] notification failed')
    }
  }
  return { drafted: !!leaseId, leaseId }
}
