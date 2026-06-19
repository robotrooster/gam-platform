/**
 * Tool: get_guest_booking (guest). The booking guest's window into THEIR
 * ONE stay. Hard-scoped to actor.bookingId (set by the guest-agent door from
 * the access token) — a guest can only ever read the booking their token
 * grants, never another. Read-only.
 *
 * The exported loadGuestBookingContext is reused by request_booking_change
 * so both guest tools resolve the same booking + host the same way.
 */

import { queryOne } from '../../../db'
import type { AgentTool, AgentActor } from './types'

export interface GuestBookingContext {
  booking_id: string
  guest_name: string | null
  check_in: string
  check_out: string
  nights: number | null
  status: string
  lease_type: string | null
  total_amount: string | null
  notes: string | null
  landlord_id: string
  landlord_user_id: string
  property_name: string | null
  property_city: string | null
  property_state: string | null
  unit_number: string | null
}

/** Load the full booking + host context for a guest-scoped booking id, or null. */
export async function loadGuestBookingContext(bookingId: string): Promise<GuestBookingContext | null> {
  return queryOne<GuestBookingContext>(
    `SELECT b.id AS booking_id, b.guest_name, b.check_in, b.check_out, b.nights,
            b.status, b.lease_type, b.total_amount, b.notes,
            b.landlord_id, lo.user_id AS landlord_user_id,
            p.name AS property_name, p.city AS property_city, p.state AS property_state,
            u.unit_number
       FROM unit_bookings b
       JOIN landlords lo ON lo.id = b.landlord_id
       LEFT JOIN units u ON u.id = b.unit_id
       LEFT JOIN properties p ON p.id = u.property_id
      WHERE b.id = $1`,
    [bookingId]
  )
}

export const getGuestBooking: AgentTool = {
  name: 'get_guest_booking',
  description:
    'Look up the guest’s own stay — check-in and check-out dates, number of nights, the property and unit, ' +
    'status, total, and any note from the host. Use this for “when do I check in/out?”, “where am I staying?”, ' +
    '“how much is my stay?”, or any question about their booking. Read-only.',
  parameters: { type: 'object', properties: {} },
  audiences: ['guest'],
  async execute(_args, actor: AgentActor) {
    if (!actor.bookingId) return { ok: false, error: 'No booking is associated with this session.' }
    const b = await loadGuestBookingContext(actor.bookingId)
    if (!b) return { ok: false, error: 'That booking could not be found.' }

    const location = [b.property_city, b.property_state].filter(Boolean).join(', ') || null
    return {
      ok: true,
      guestName: b.guest_name,
      property: b.property_name,
      location,
      unit: b.unit_number,
      checkIn: b.check_in,
      checkOut: b.check_out,
      nights: b.nights,
      status: b.status,
      type: b.lease_type,
      total: b.total_amount != null ? Number(b.total_amount) : null,
      hostNote: b.notes,
    }
  },
}
