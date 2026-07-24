/**
 * Tool: request_booking_change (guest action).
 *
 * A booking guest asks for a stay change (late checkout, early check-in, an
 * extra night, or some other request). S552 (Nic): when the MASTER SCHEDULE
 * HAS ROOM, the structured types (late_checkout / early_checkin /
 * extra_night) are applied AUTOMATICALLY — extra_night extends the booking
 * itself — and the host is INFORMED (front-desk awareness), not asked.
 * Schedule-conflicted and 'other' requests fall back to the original
 * host-decides flow (booking_change_requests row stays 'requested').
 * Auto-approved rows are status 'approved' with resolved_by_user_id NULL —
 * NULL resolver = the system, an intentional audit distinction.
 *
 * Hard-scoped to actor.bookingId. Confirm the specifics with the guest
 * before calling.
 */

import { query } from '../../../db'
import { createNotification } from '../../notifications'
import {
  BOOKING_CHANGE_REQUEST_TYPES,
  BOOKING_CHANGE_REQUEST_TYPE_LABEL,
  type BookingChangeRequestType,
} from '@gam/shared'
import type { AgentTool, AgentActor } from './types'
import { loadGuestBookingContext } from './getGuestBooking'
import { findStayConflict } from '../../unitAvailability'
import { findStaffWithPermission } from '../../staffNotify'

function normalizeType(raw: string): BookingChangeRequestType | null {
  const v = raw.trim().toLowerCase().replace(/[\s-]+/g, '_')
  return (BOOKING_CHANGE_REQUEST_TYPES as readonly string[]).includes(v)
    ? (v as BookingChangeRequestType)
    : null
}

export const requestBookingChange: AgentTool = {
  name: 'request_booking_change',
  description:
    'Change the guest’s stay — a late checkout, an early check-in, an extra night, or some other request. ' +
    'When the schedule has room, late checkout / early check-in / extra night are CONFIRMED automatically and ' +
    'the host is notified; if the schedule is tight (or for "other" requests) it goes to the host to decide. ' +
    'Confirm the specifics with the guest first (e.g. what time, which night), then call. request_type must be ' +
    'one of: late_checkout, early_checkin, extra_night, other. Put the detail (a time, a date, the ask in their ' +
    'words) in `details`. Relay the tool’s note to the guest — it says whether the change is confirmed or pending.',
  parameters: {
    type: 'object',
    properties: {
      request_type: { type: 'string', description: 'One of: late_checkout, early_checkin, extra_night, other.' },
      details: { type: 'string', description: 'The specifics in plain language — e.g. "checkout at 2pm instead of 11am" or "one more night, through the 14th".' },
    },
    required: ['request_type'],
  },
  audiences: ['guest'],
  async execute(args, actor: AgentActor) {
    if (!actor.bookingId) return { ok: false, error: 'No booking is associated with this session.' }
    const type = normalizeType(String(args.request_type ?? ''))
    if (!type) return { ok: false, error: 'Tell me which kind of request: a late checkout, early check-in, extra night, or something else.' }

    const b = await loadGuestBookingContext(actor.bookingId)
    if (!b) return { ok: false, error: 'That booking could not be found.' }
    if (['cancelled', 'checked_out', 'no_show'].includes(b.status)) {
      return { ok: false, error: `This stay is ${b.status.replace('_', ' ')}, so a change request can’t be submitted. The host can still be reached directly.` }
    }

    const details = typeof args.details === 'string' && args.details.trim() ? args.details.trim() : null

    // Don't stack duplicate open requests of the same kind.
    const existing = await query<{ id: string }>(
      `SELECT id FROM booking_change_requests
        WHERE booking_id = $1 AND request_type = $2 AND status = 'requested' LIMIT 1`,
      [actor.bookingId, type]
    )
    if (existing[0]) {
      return { ok: true, alreadyRequested: true, note: `A ${BOOKING_CHANGE_REQUEST_TYPE_LABEL[type].toLowerCase()} request is already with the host for this stay.` }
    }

    // S552 (Nic): schedule-permitting changes apply AUTOMATICALLY — the host
    // is INFORMED (front desk needs to know about check-in/out shifts), not
    // asked. Room is judged against the master schedule via findStayConflict
    // (bookings + active leases + pending tenants). 'other' requests are
    // unstructured, so they stay host-decided. Dates are day-granular; slice
    // defends against ISO-timestamp serialization (gam-dates rule).
    const dayOnly = (d: string) => String(d).slice(0, 10)
    const addDays = (d: string, n: number) => {
      const t = new Date(`${dayOnly(d)}T00:00:00Z`)
      t.setUTCDate(t.getUTCDate() + n)
      return t.toISOString().slice(0, 10)
    }
    let autoApproved = false
    let newCheckOut: string | null = null
    if (b.unit_id && ['late_checkout', 'early_checkin', 'extra_night'].includes(type)) {
      // The night(s) the change would occupy: late checkout + extra night
      // both need the unit free on the departure day; early check-in needs
      // the night before arrival free (a same-day-turnover predecessor
      // correctly blocks auto-approval — the host decides those).
      const win = type === 'early_checkin'
        ? { checkIn: addDays(b.check_in, -1), checkOut: dayOnly(b.check_in) }
        : { checkIn: dayOnly(b.check_out), checkOut: addDays(b.check_out, 1) }
      const conflict = await findStayConflict(b.unit_id, { ...win, excludeBookingId: actor.bookingId })
      if (!conflict) {
        autoApproved = true
        if (type === 'extra_night') {
          newCheckOut = addDays(b.check_out, 1)
          await query(
            `UPDATE unit_bookings
                SET check_out = check_out + INTERVAL '1 day',
                    nights = COALESCE(nights, 0) + 1
              WHERE id = $1`,
            [actor.bookingId]
          )
        }
      }
    }

    const ins = await query<{ id: string }>(
      `INSERT INTO booking_change_requests (booking_id, landlord_id, request_type, details, status, resolved_at)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [actor.bookingId, b.landlord_id, type, details,
       autoApproved ? 'approved' : 'requested',
       autoApproved ? new Date() : null]
    )

    const where = b.property_name ? `${b.property_name}${b.unit_number ? ` (unit ${b.unit_number})` : ''}` : 'a booking'
    const label = BOOKING_CHANGE_REQUEST_TYPE_LABEL[type]
    // S552 (Nic): notify the people RUNNING the front counter directly —
    // every staff member holding a booking-desk permission for this
    // property — plus the owner. The owner should never have to relay a
    // schedule change to their own front desk.
    const recipients = new Map<string, true>()
    recipients.set(b.landlord_user_id, true)
    try {
      const staff = await findStaffWithPermission(b.landlord_id, b.property_id ?? null,
        ['bookings.change_requests', 'bookings.resolve_change_request', 'bookings.view'])
      for (const s of staff) recipients.set(s.user_id, true)
    } catch { /* best-effort — owner still notified */ }
    const title = autoApproved ? `Stay change confirmed: ${label}` : `Guest requested: ${label}`
    const body = autoApproved
      ? `${b.guest_name ?? 'A guest'} at ${where}: ${label.toLowerCase()}${details ? ` — ${details}` : ''}` +
        (newCheckOut ? `. Checkout is now ${newCheckOut}.` : '.') +
        ' The schedule had room, so it was confirmed automatically.'
      : `${b.guest_name ?? 'A guest'} at ${where} requested ${label.toLowerCase()}${details ? ` — ${details}` : ''}.`
    for (const userId of recipients.keys()) {
      await createNotification({
        userId,
        landlordId: b.landlord_id,
        type: 'booking_change_request',
        title,
        body,
        data: { bookingId: actor.bookingId, changeRequestId: ins[0]?.id, requestType: type, autoApproved },
      }).catch(() => { /* best-effort */ })
    }

    if (autoApproved) {
      return {
        ok: true,
        requestId: ins[0]?.id,
        requestType: type,
        label,
        details,
        autoApproved: true,
        ...(newCheckOut ? { newCheckOut } : {}),
        note: type === 'extra_night'
          ? `Confirmed — the stay now runs through ${newCheckOut}. Any charge for the extra night is settled with the property as usual. The host has been notified.`
          : `Confirmed — the schedule has room, so the ${label.toLowerCase()} is approved. The host has been notified.`,
      }
    }
    return {
      ok: true,
      requestId: ins[0]?.id,
      requestType: type,
      label,
      details,
      note: 'Sent to the host. They’ll approve or decline and follow up — nothing on the booking has changed yet.',
    }
  },
}
