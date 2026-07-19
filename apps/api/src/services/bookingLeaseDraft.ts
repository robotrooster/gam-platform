import { query, queryOne } from '../db'
import { logger } from '../lib/logger'
import { createNotification } from './notifications'

// S547 (Nic): the long-stay ping is a DECISION for the landlord — screen
// first, or send the lease directly if they know the guest. The system never
// auto-sends a background check. To inform that decision we surface the
// guest's GAM history: prior completed stays with this landlord, any approved
// background check already in the system, and whether they've had continuous
// tenancy in GAM since that check (approved check + continuous tenancy since
// = no new check needed).
const CONTINUITY_GAP_DAYS = 30   // move-between-units grace when chaining leases

interface GuestScreeningContext {
  priorStays: number
  approvedCheckAt: string | null           // date of latest approved GAM check
  continuousTenancySince: boolean          // leases chain from that check to today
}

async function guestScreeningContext(guestEmail: string | null, landlordId: string): Promise<GuestScreeningContext> {
  const out: GuestScreeningContext = { priorStays: 0, approvedCheckAt: null, continuousTenancySince: false }
  if (!guestEmail) return out

  const person = await queryOne<{ user_id: string; tenant_id: string | null }>(
    `SELECT u.id AS user_id, t.id AS tenant_id
       FROM users u LEFT JOIN tenants t ON t.user_id = u.id
      WHERE LOWER(u.email) = LOWER($1) LIMIT 1`, [guestEmail])

  const stays = await queryOne<{ n: string }>(
    `SELECT COUNT(*) AS n FROM unit_bookings
      WHERE LOWER(guest_email) = LOWER($1) AND landlord_id = $2
        AND status IN ('checked_out', 'confirmed', 'checked_in')
        AND check_out < CURRENT_DATE`, [guestEmail, landlordId])
  out.priorStays = Number(stays?.n ?? 0)
  if (!person) return out

  // decided_at can be NULL on older approved rows — fall back to created_at.
  const check = await queryOne<{ at: string }>(
    `SELECT COALESCE(decided_at, created_at) AS at FROM background_checks
      WHERE status = 'approved' AND (user_id = $1 OR tenant_id = $2)
      ORDER BY COALESCE(decided_at, created_at) DESC LIMIT 1`,
    [person.user_id, person.tenant_id])
  if (!check?.at) return out
  // pg returns a Date object — normalize to YYYY-MM-DD.
  out.approvedCheckAt = new Date(check.at).toISOString().slice(0, 10)

  if (person.tenant_id) {
    // Continuous = their leases (any GAM landlord, via the lease_tenants
    // junction), merged with a small move-between-properties grace, cover
    // check-date → today.
    const leases = await query<{ start_date: string; end_date: string | null }>(
      `SELECT l.start_date, l.end_date
         FROM leases l
         JOIN lease_tenants lt ON lt.lease_id = l.id
        WHERE lt.tenant_id = $1 AND l.status NOT IN ('pending', 'cancelled')
        ORDER BY l.start_date ASC`, [person.tenant_id])
    let cover = new Date(out.approvedCheckAt + 'T12:00:00Z')
    const today = new Date()
    for (const l of leases) {
      const s = new Date(String(l.start_date).slice(0, 10) + 'T12:00:00Z')
      const e = l.end_date ? new Date(String(l.end_date).slice(0, 10) + 'T12:00:00Z') : today
      if (s.getTime() - cover.getTime() > CONTINUITY_GAP_DAYS * 86400000) break
      if (e > cover) cover = e
    }
    out.continuousTenancySince = today.getTime() - cover.getTime() <= CONTINUITY_GAP_DAYS * 86400000
  }
  return out
}

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
    `SELECT b.id, b.unit_id, b.landlord_id, b.status, b.check_in, b.check_out, b.guest_name, b.guest_email,
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
        const ctx = await guestScreeningContext(booking.guest_email, booking.landlord_id)
        const history = ctx.approvedCheckAt && ctx.continuousTenancySince
          ? ` They passed a GAM background check on ${ctx.approvedCheckAt} and have had continuous tenancy in GAM since — no new check is needed.`
          : ctx.approvedCheckAt
          ? ` They passed a GAM background check on ${ctx.approvedCheckAt}, but haven't had continuous tenancy since.`
          : ctx.priorStays > 0
          ? ` They've stayed with you ${ctx.priorStays} time${ctx.priorStays === 1 ? '' : 's'} before; no background check is on file.`
          : ' No GAM history is on file for this guest.'
        await createNotification({
          userId: owner.user_id,
          landlordId: booking.landlord_id,
          type: 'lease_drafted_from_booking',
          title: 'Long stay — screen or send the lease',
          body: `${booking.guest_name || 'A guest'} is requesting a ${nights}-night stay on unit ${booking.unit_number}. A draft lease is ready on your Leases page — request a background check first, or send the lease directly if you know them.${history} Consistency note: apply screening evenly — requiring checks from some guests but not others in the same situation can be considered discriminatory. Screen everyone in comparable situations, or apply the same no-screening policy to all.`,
          data: {
            leaseId, bookingId,
            priorStays: ctx.priorStays,
            approvedCheckAt: ctx.approvedCheckAt,
            continuousTenancySince: ctx.continuousTenancySince,
          },
          actionUrl: `/leases?open=${leaseId}`,   // S527 W-1: deep-link to the draft
        })
      }
    } catch (err) {
      logger.error({ err, bookingId, leaseId }, '[booking-lease-draft] notification failed')
    }
  }
  return { drafted: !!leaseId, leaseId }
}
