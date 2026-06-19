/**
 * Booking-guest access tokens — the security boundary for the no-login guest
 * agent door. Verifies issue → resolve, and that revoked / expired tokens
 * fail closed (resolve to null).
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { db, query } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit } from '../test/dbHelpers'
import {
  issueBookingGuestToken,
  resolveBookingGuestToken,
  bookingGuestQrDataUrl,
  revokeBookingGuestTokens,
} from './bookingGuestTokens'

async function seedBooking(opts: { daysFromNowCheckout?: number } = {}) {
  const client = await db.connect()
  try {
    const { userId, landlordId } = await seedLandlord(client)
    const propertyId = await seedProperty(client, { landlordId, ownerUserId: userId, managedByUserId: userId })
    const unitId = await seedUnit(client, { propertyId, landlordId })
    const checkout = new Date(Date.now() + (opts.daysFromNowCheckout ?? 5) * 86400000)
    const checkin = new Date(Date.now() + 1 * 86400000)
    const b = await client.query<{ id: string }>(
      `INSERT INTO unit_bookings (unit_id, landlord_id, lease_type, check_in, check_out, guest_name, guest_email, status)
       VALUES ($1, $2, 'nightly', $3, $4, 'Sam Rivera', 'sam@guest.dev', 'confirmed') RETURNING id`,
      [unitId, landlordId, checkin.toISOString().slice(0, 10), checkout.toISOString().slice(0, 10)]
    )
    return { bookingId: b.rows[0].id, landlordId }
  } finally {
    client.release()
  }
}

beforeEach(async () => { await cleanupAllSchema() })

describe('bookingGuestTokens', () => {
  it('issues a token that resolves to its booking', async () => {
    const { bookingId, landlordId } = await seedBooking()
    const issued = await issueBookingGuestToken({ bookingId, landlordId })
    expect(issued.url).toContain(issued.token)

    const resolved = await resolveBookingGuestToken(issued.token)
    expect(resolved).not.toBeNull()
    expect(resolved!.bookingId).toBe(bookingId)
    expect(resolved!.landlordId).toBe(landlordId)
  })

  it('stamps last_used_at on resolve', async () => {
    const { bookingId, landlordId } = await seedBooking()
    const issued = await issueBookingGuestToken({ bookingId, landlordId })
    await resolveBookingGuestToken(issued.token)
    const rows = await query<{ last_used_at: string | null }>(
      `SELECT last_used_at FROM booking_guest_access_tokens WHERE token = $1`, [issued.token])
    expect(rows[0].last_used_at).not.toBeNull()
  })

  it('fails closed on an unknown token', async () => {
    expect(await resolveBookingGuestToken('deadbeef'.repeat(8))).toBeNull()
  })

  it('fails closed on a revoked token', async () => {
    const { bookingId, landlordId } = await seedBooking()
    const issued = await issueBookingGuestToken({ bookingId, landlordId })
    await query(`UPDATE booking_guest_access_tokens SET revoked_at = now() WHERE token = $1`, [issued.token])
    expect(await resolveBookingGuestToken(issued.token)).toBeNull()
  })

  it('fails closed on an expired token', async () => {
    const { bookingId, landlordId } = await seedBooking()
    const issued = await issueBookingGuestToken({ bookingId, landlordId })
    await query(`UPDATE booking_guest_access_tokens SET expires_at = now() - interval '1 day' WHERE token = $1`, [issued.token])
    expect(await resolveBookingGuestToken(issued.token)).toBeNull()
  })

  it('expiry tracks checkout + buffer (future checkout → future expiry)', async () => {
    const { bookingId, landlordId } = await seedBooking({ daysFromNowCheckout: 10 })
    const issued = await issueBookingGuestToken({ bookingId, landlordId })
    expect(issued.expiresAt.getTime()).toBeGreaterThan(Date.now())
  })

  it('revoke kills every outstanding link for the booking', async () => {
    const { bookingId, landlordId } = await seedBooking()
    const a = await issueBookingGuestToken({ bookingId, landlordId })
    const b = await issueBookingGuestToken({ bookingId, landlordId })
    // both live before revoke
    expect(await resolveBookingGuestToken(a.token)).not.toBeNull()
    expect(await resolveBookingGuestToken(b.token)).not.toBeNull()

    const { revoked } = await revokeBookingGuestTokens({ bookingId, landlordId })
    expect(revoked).toBe(2)
    // both fail closed after
    expect(await resolveBookingGuestToken(a.token)).toBeNull()
    expect(await resolveBookingGuestToken(b.token)).toBeNull()
  })

  it('revoke is idempotent (second call revokes nothing)', async () => {
    const { bookingId, landlordId } = await seedBooking()
    await issueBookingGuestToken({ bookingId, landlordId })
    expect((await revokeBookingGuestTokens({ bookingId, landlordId })).revoked).toBe(1)
    expect((await revokeBookingGuestTokens({ bookingId, landlordId })).revoked).toBe(0)
  })

  it('revoke is scoped to the booking (does not touch another booking)', async () => {
    const one = await seedBooking()
    const two = await seedBooking()
    const tokenTwo = await issueBookingGuestToken({ bookingId: two.bookingId, landlordId: two.landlordId })
    await issueBookingGuestToken({ bookingId: one.bookingId, landlordId: one.landlordId })

    await revokeBookingGuestTokens({ bookingId: one.bookingId, landlordId: one.landlordId })
    // the other booking's link is untouched
    expect(await resolveBookingGuestToken(tokenTwo.token)).not.toBeNull()
  })

  it('produces a scannable QR data URL', async () => {
    const { bookingId, landlordId } = await seedBooking()
    const issued = await issueBookingGuestToken({ bookingId, landlordId })
    const qr = await bookingGuestQrDataUrl(issued.token)
    expect(qr.startsWith('data:image/png;base64,')).toBe(true)
  })
})
