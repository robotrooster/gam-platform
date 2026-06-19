/**
 * Booking-guest access tokens — identity for a no-account booking guest
 * (RV/STR/extended-stay stay in unit_bookings) talking to the guest agent.
 *
 * Unlike the single-use card-update token, this token is REUSABLE for the
 * whole stay (the guest chats repeatedly) and expires at checkout + a
 * buffer. It is the bearer credential for /api/guest/chat — possession of
 * the token == access to exactly one booking. Delivered by email-link or
 * shown on-site as a QR the host prints/displays (no SMS, per product
 * decision). The host can revoke at any time.
 *
 * Token is 32-byte hex (256 bits). Resolution checks revoked_at + expiry
 * and stamps last_used_at.
 */

import crypto from 'crypto'
import QRCode from 'qrcode'
import { query, queryOne } from '../db'
import { logger } from '../lib/logger'

// Days past check_out the token stays valid — covers late checkout, a guest
// circling back the morning after, clock skew on the date-only check_out.
const GUEST_TOKEN_BUFFER_DAYS = 2

export type GuestTokenDelivery = 'email' | 'qr'

interface IssueResult {
  token: string
  url: string
  expiresAt: Date
}

/** Public URL a guest opens to reach their stay assistant. */
export function guestStayUrl(token: string): string {
  const base = process.env.MARKETING_URL || 'http://localhost:3004'
  return `${base}/stay/${token}`
}

/** Mint a reusable access token for one booking. Expiry = check_out + buffer. */
export async function issueBookingGuestToken(args: {
  bookingId: string
  landlordId: string
  delivery?: GuestTokenDelivery
  createdByUserId?: string | null
}): Promise<IssueResult> {
  const booking = await queryOne<{ check_out: string; landlord_id: string }>(
    `SELECT check_out, landlord_id FROM unit_bookings WHERE id = $1`,
    [args.bookingId]
  )
  if (!booking) throw new Error(`booking ${args.bookingId} not found`)

  const checkout = new Date(booking.check_out)
  const expiresAt = new Date(checkout.getTime() + GUEST_TOKEN_BUFFER_DAYS * 24 * 60 * 60 * 1000)
  const token = crypto.randomBytes(32).toString('hex')

  await queryOne(
    `INSERT INTO booking_guest_access_tokens
       (token, booking_id, landlord_id, delivery_method, expires_at, created_by_user_id)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id`,
    [token, args.bookingId, args.landlordId, args.delivery ?? 'email',
     expiresAt.toISOString(), args.createdByUserId ?? null]
  )
  return { token, url: guestStayUrl(token), expiresAt }
}

/** A QR (data-URL PNG) the host can display/print so a guest scans on-site. */
export async function bookingGuestQrDataUrl(token: string): Promise<string> {
  return QRCode.toDataURL(guestStayUrl(token), { margin: 1, width: 320 })
}

export interface ResolvedGuest {
  tokenId: string
  bookingId: string
  landlordId: string
}

/**
 * Validate a bearer token → the booking it scopes to. Returns null when the
 * token is unknown, revoked, or expired. Stamps last_used_at on success.
 * This is the guest-agent door's authentication.
 */
export async function resolveBookingGuestToken(token: string): Promise<ResolvedGuest | null> {
  if (!token || token.length < 16) return null
  const row = await queryOne<{
    id: string; booking_id: string; landlord_id: string;
    expires_at: string; revoked_at: string | null
  }>(
    `SELECT id, booking_id, landlord_id, expires_at, revoked_at
       FROM booking_guest_access_tokens WHERE token = $1`,
    [token]
  )
  if (!row) return null
  if (row.revoked_at) return null
  if (new Date(row.expires_at).getTime() < Date.now()) return null

  // Best-effort usage stamp — never block the conversation on it.
  await query(
    `UPDATE booking_guest_access_tokens SET last_used_at = now() WHERE id = $1`,
    [row.id]
  ).catch((err) => logger.error({ err }, '[guest-token] last_used_at stamp failed'))

  return { tokenId: row.id, bookingId: row.booking_id, landlordId: row.landlord_id }
}

/**
 * Revoke every active access token for a booking. The host's kill switch:
 * one booking can have several outstanding links (each issue/re-issue mints a
 * fresh token without touching prior ones), so revoking access means revoking
 * them ALL. Idempotent — already-revoked rows are skipped via the NULL guard,
 * so a second call is a no-op. Returns how many were revoked so the caller can
 * tell the host whether anything was actually live.
 */
export async function revokeBookingGuestTokens(args: {
  bookingId: string
  landlordId: string
}): Promise<{ revoked: number }> {
  const rows = await query<{ id: string }>(
    `UPDATE booking_guest_access_tokens
        SET revoked_at = now()
      WHERE booking_id = $1 AND landlord_id = $2 AND revoked_at IS NULL
      RETURNING id`,
    [args.bookingId, args.landlordId]
  )
  return { revoked: rows.length }
}

/**
 * End-to-end email delivery: issue a token + email the guest the link.
 * Returns false (silent skip) when the booking has no guest_email; throws on
 * hard email failure so the caller can surface it. The booking-create path
 * logs and continues — a missing token must never fail a booking.
 */
export async function sendBookingGuestAccessEmail(args: {
  bookingId: string
  landlordId: string
  createdByUserId?: string | null
}): Promise<boolean> {
  const booking = await queryOne<{
    guest_name: string | null; guest_email: string | null;
    check_in: string; check_out: string; unit_id: string
  }>(
    `SELECT guest_name, guest_email, check_in, check_out, unit_id
       FROM unit_bookings WHERE id = $1`,
    [args.bookingId]
  )
  if (!booking?.guest_email) {
    logger.info({ bookingId: args.bookingId }, '[guest-token] no guest_email; skipping email')
    return false
  }

  const unit = await queryOne<{ property_name: string | null; unit_number: string | null }>(
    `SELECT p.name AS property_name, u.unit_number
       FROM units u JOIN properties p ON p.id = u.property_id
      WHERE u.id = $1`,
    [booking.unit_id]
  )

  const issued = await issueBookingGuestToken({
    bookingId: args.bookingId,
    landlordId: args.landlordId,
    delivery: 'email',
    createdByUserId: args.createdByUserId,
  })

  const { emailBookingGuestAccess } = await import('./email')
  await emailBookingGuestAccess({
    to: booking.guest_email,
    guestName: booking.guest_name,
    propertyName: unit?.property_name ?? null,
    unitNumber: unit?.unit_number ?? null,
    checkIn: booking.check_in,
    checkOut: booking.check_out,
    stayUrl: issued.url,
    expiresAt: issued.expiresAt,
    ctx: { landlordId: args.landlordId, bookingId: args.bookingId },
  })
  return true
}
