/**
 * Tool: request_booking_change (guest — light action, record-only).
 *
 * A booking guest asks for a stay change (late checkout, early check-in, an
 * extra night, or some other request). The agent RECORDS the request and
 * notifies the host — it does NOT change the booking. The host approves or
 * declines on their side. This is draft-with-approval from the guest's
 * angle: the request is the durable, append-only record
 * (booking_change_requests); the host finalizes it.
 *
 * Hard-scoped to actor.bookingId. Confirm the specifics with the guest
 * before calling (the request goes straight to the host).
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

function normalizeType(raw: string): BookingChangeRequestType | null {
  const v = raw.trim().toLowerCase().replace(/[\s-]+/g, '_')
  return (BOOKING_CHANGE_REQUEST_TYPES as readonly string[]).includes(v)
    ? (v as BookingChangeRequestType)
    : null
}

export const requestBookingChange: AgentTool = {
  name: 'request_booking_change',
  description:
    'Send the host a request to change the guest’s stay — a late checkout, an early check-in, an extra night, ' +
    'or some other request. Use when the guest asks for any of these. You are NOT changing the booking yourself: ' +
    'the host approves or declines. Confirm the specifics with the guest first (e.g. what time, which night), then ' +
    'call. request_type must be one of: late_checkout, early_checkin, extra_night, other. Put the detail (a time, a ' +
    'date, the ask in their words) in `details`.',
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

    const ins = await query<{ id: string }>(
      `INSERT INTO booking_change_requests (booking_id, landlord_id, request_type, details)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [actor.bookingId, b.landlord_id, type, details]
    )

    const where = b.property_name ? `${b.property_name}${b.unit_number ? ` (unit ${b.unit_number})` : ''}` : 'a booking'
    await createNotification({
      userId: b.landlord_user_id,
      landlordId: b.landlord_id,
      type: 'booking_change_request',
      title: `Guest requested: ${BOOKING_CHANGE_REQUEST_TYPE_LABEL[type]}`,
      body: `${b.guest_name ?? 'A guest'} at ${where} requested ${BOOKING_CHANGE_REQUEST_TYPE_LABEL[type].toLowerCase()}${details ? ` — ${details}` : ''}.`,
      data: { bookingId: actor.bookingId, changeRequestId: ins[0]?.id, requestType: type },
    }).catch(() => { /* best-effort */ })

    return {
      ok: true,
      requestId: ins[0]?.id,
      requestType: type,
      label: BOOKING_CHANGE_REQUEST_TYPE_LABEL[type],
      details,
      note: 'Sent to the host. They’ll approve or decline and follow up — nothing on the booking has changed yet.',
    }
  },
}
