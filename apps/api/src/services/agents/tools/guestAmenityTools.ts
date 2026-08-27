/**
 * Guest amenity tools (S553) — the stay-link guest's amenity window.
 *
 * get_guest_amenities (READ) — the amenities at the property the
 * guest is staying at, plus their own reservations. Scoped through
 * actor.bookingId only.
 *
 * request_guest_amenity_reservation (ACTION, confirm-first) — mirrors
 * POST /public/property/:slug/stay/:token/amenity/:areaId/reserve exactly:
 * the window must fall inside the stay dates, the per-person monthly cap
 * applies, instant-book areas confirm on the spot, approval areas land as a
 * pending request for the host. The FEE MUST BE DISCLOSED and accepted by
 * the guest BEFORE calling. Guest fees are not billed by the platform —
 * they ride the reservation and the property collects with the stay.
 */

import { query, queryOne, getClient } from '../../../db'
import {
  lockArea, findApprovedConflict, computeReservationFee, assertMonthlyReservationLimit,
} from '../../commonAreas'
import { loadArea, validateWindow, fireAmenityAlert } from '../../../routes/commonAreas'
import { notifyReservationRequested } from '../../notifications'
import { loadGuestBookingContext } from './getGuestBooking'
import type { AgentTool, AgentActor } from './types'

export const getGuestAmenities: AgentTool = {
  name: 'get_guest_amenities',
  description:
    'The amenities at the property the guest is staying at — name, description, capacity, hours, whether it ' +
    'can be reserved at all, and if so whether booking is instant or needs the host’s approval — plus the ' +
    'guest’s own reservations. Use for “is there a pool? / is there laundry? / what can I book?” and before ' +
    'requesting a reservation. Includes amenities that CANNOT be booked (a laundry room, a walk-up pool); ' +
    'those still answer the question of whether the property has one. ' +
    // S624: asked "is there a pool or clubhouse I can book during my stay?", the
    // agent called get_guest_booking first. It takes no arguments and resolves
    // the guest's property itself, so looking up the booking to find out WHERE
    // they are is a wasted turn — say so, since "during my stay" is what pulls
    // the model toward the booking tool.
    'You do NOT need their booking first — this resolves their property on its own. Read-only.',
  parameters: { type: 'object', properties: {} },
  audiences: ['guest'],

  async execute(_args, actor: AgentActor) {
    if (!actor.bookingId) return { ok: false, error: 'No booking is associated with this session.' }
    const b = await loadGuestBookingContext(actor.bookingId)
    if (!b?.property_id) return { ok: true, amenities: [], reservations: [], note: 'This stay has no property amenities to show.' }
    // S626: this filtered on `AND reservable`, and that made the tool lie.
    //
    // It is the tool that answers "is there a pool?" — its own description says
    // so — but it only ever returned areas a guest can BOOK. The demo property's
    // Community Laundry is active and not reservable, so a guest asking about
    // laundry was told the property has none. An amenity you can walk to is
    // still an amenity; it simply cannot be reserved, and the `reservable`
    // column now carries that distinction into the answer instead of deciding
    // in silence that the thing does not exist.
    const areas = await query<any>(
      `SELECT id, name, description, requires_approval, capacity,
              reservation_fee::float AS reservation_fee, open_time, close_time,
              max_reservation_hours, events_enabled,
              event_deposit_amount::float AS event_deposit_amount, reservable
         FROM common_areas
        WHERE property_id = $1 AND active
        ORDER BY name`, [b.property_id])
    const mine = await query<any>(
      `SELECT car.id, ca.name AS area_name, car.kind, car.starts_at, car.ends_at,
              car.status, car.fee_amount::float AS fee_amount
         FROM common_area_reservations car
         JOIN common_areas ca ON ca.id = car.common_area_id
        WHERE car.guest_booking_id = $1
        ORDER BY car.starts_at DESC
        LIMIT 20`, [actor.bookingId])
    return {
      ok: true,
      amenities: areas,
      reservations: mine,
      note: 'ANSWER THE QUESTION THEY ASKED FIRST. "Is there a pool?" is a yes/no question about the ' +
        'property — answer it, with the hours and whatever the description says about it. Only mention ' +
        'reserving, approval or fees if they ask to book it or the answer needs it. Do not open with ' +
        'the reservation mechanics and do not propose a time slot they did not ask for.\n' +
        'reservable=false means the area is there to use but cannot be booked — say it exists, and do ' +
        'NOT tell them it needs approval or offer to reserve it. reservable=true areas can be booked: ' +
        'requires_approval=false confirms instantly, otherwise it goes to the host. Reservations must ' +
        'fall within the stay dates. Weekend dates can carry a different fee — the exact fee is computed ' +
        'when a request is made and the property collects it with the stay.',
    }
  },
}

export const requestGuestAmenityReservation: AgentTool = {
  name: 'request_guest_amenity_reservation',
  description:
    'Reserve an amenity for the guest during their stay. CONFIRM FIRST: state the area, the exact start/end ' +
    'time, and the fee (from get_guest_amenities; weekend rates may differ — the result reports the final fee, ' +
    'which the property collects with the stay) and get an explicit yes before calling. The window must fall ' +
    'within the stay dates. areaId comes from get_guest_amenities; times are ISO datetimes.',
  parameters: {
    type: 'object',
    properties: {
      areaId: { type: 'string', description: 'The amenity id (from get_guest_amenities).' },
      startsAt: { type: 'string', description: 'Start, ISO datetime (e.g. 2026-08-02T14:00:00).' },
      endsAt: { type: 'string', description: 'End, ISO datetime.' },
      title: { type: 'string', description: 'Optional short label (e.g. "Family BBQ").' },
      guestCount: { type: 'number', description: 'Optional expected head count.' },
    },
    required: ['areaId', 'startsAt', 'endsAt'],
  },
  audiences: ['guest'],

  async execute(args, actor: AgentActor) {
    if (!actor.bookingId) return { ok: false, error: 'No booking is associated with this session.' }
    const areaId = String(args.areaId ?? '').trim()
    const startsAt = String(args.startsAt ?? '').trim()
    const endsAt = String(args.endsAt ?? '').trim()
    const title = typeof args.title === 'string' && args.title.trim() ? args.title.trim().slice(0, 160) : null
    const guestCount = typeof args.guestCount === 'number' && args.guestCount > 0 ? Math.floor(args.guestCount) : null
    if (!areaId || !startsAt || !endsAt) return { ok: false, error: 'areaId, startsAt, and endsAt are all required.' }

    const b = await loadGuestBookingContext(actor.bookingId)
    if (!b?.property_id) return { ok: false, error: 'This stay could not be matched to a property.' }

    const area = await loadArea(areaId)
    if (!area || area.property_id !== b.property_id || !area.active) return { ok: false, error: 'No such amenity at this property.' }
    // S626: a dead-end string became a likelier path the moment the list above
    // stopped hiding non-reservable areas — a guest who can now SEE the laundry
    // will ask to book it. The error says what to tell them instead, because a
    // tool error is what the agent repeats.
    if (!area.reservable) {
      return {
        ok: false,
        error: `${area.name} is open to use during the stay but is not something that gets reserved — ` +
          'there is no booking to make. Tell them it is there and free to use, with the hours if the ' +
          'listing gives any. Do not apologise for it and do not offer to ask the host.',
      }
    }

    // The reservation day must fall inside THIS stay (same check as the
    // public stay-link route — status + date window).
    const stay = await queryOne<any>(
      `SELECT b.id, b.guest_name FROM unit_bookings b
        WHERE b.id = $1
          AND b.status IN ('tentative', 'confirmed', 'checked_in')
          AND $2::date BETWEEN b.check_in AND b.check_out`,
      [actor.bookingId, startsAt.slice(0, 10)])
    if (!stay) return { ok: false, error: 'Amenity reservations must fall within the stay dates.' }

    try {
      // Advance cap skipped: the stay-date bound above is the guest's limit.
      validateWindow(area, startsAt, endsAt, { skipAdvanceLimit: true })
      await assertMonthlyReservationLimit(area, { guestBookingId: stay.id }, startsAt)
    } catch (e: any) {
      return { ok: false, error: e?.message || 'That window is not bookable.' }
    }
    const fee = computeReservationFee(area, startsAt)

    if (!area.requires_approval) {
      const client = await getClient()
      let id: string
      try {
        await client.query('BEGIN')
        await lockArea(client, area.id)
        const conflict = await findApprovedConflict(client, area.id, startsAt, endsAt)
        if (conflict) { await client.query('ROLLBACK'); return { ok: false, error: 'That window is already reserved — pick another time.' } }
        const ins = await client.query<{ id: string }>(
          `INSERT INTO common_area_reservations
             (common_area_id, property_id, landlord_id, guest_booking_id,
              title, kind, starts_at, ends_at, status, guest_count, notes, fee_amount,
              notify_residents, decided_at)
           VALUES ($1,$2,$3,$4,$5,'guest_reservation',$6,$7,'approved',$8,NULL,$9,true,now()) RETURNING id`,
          [area.id, b.property_id, b.landlord_id, stay.id,
           title, startsAt, endsAt, guestCount, fee])
        id = ins.rows[0].id
        await client.query('COMMIT')
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {})
        throw e
      } finally { client.release() }
      await fireAmenityAlert(id)
      return {
        ok: true, reservationId: id, status: 'approved', fee,
        message: `Booked — ${area.name} is reserved.` +
          (fee > 0 ? ` The $${fee.toFixed(2)} fee will be collected by the property with the stay.` : ''),
      }
    }

    const ins = await queryOne<{ id: string }>(
      `INSERT INTO common_area_reservations
         (common_area_id, property_id, landlord_id, guest_booking_id,
          title, kind, starts_at, ends_at, status, guest_count, notes, fee_amount, notify_residents)
       VALUES ($1,$2,$3,$4,$5,'guest_reservation',$6,$7,'pending',$8,NULL,$9,true) RETURNING id`,
      [area.id, b.property_id, b.landlord_id, stay.id,
       title, startsAt, endsAt, guestCount, fee])
    const meta = await queryOne<any>(
      `SELECT lu.id AS landlord_user_id, lu.email AS landlord_email
         FROM landlords l JOIN users lu ON lu.id = l.user_id WHERE l.id = $1`, [b.landlord_id])
    if (meta?.landlord_user_id) {
      await notifyReservationRequested({
        landlordUserId: meta.landlord_user_id, landlordId: b.landlord_id,
        landlordEmail: meta.landlord_email,
        tenantName: `${stay.guest_name || 'A guest'} (short-term guest)`,
        areaName: area.name, propertyName: b.property_name ?? 'the property',
        startsAt, endsAt, reservationId: ins!.id, guestCount,
      }).catch(() => { /* best-effort */ })
    }
    return {
      ok: true, reservationId: ins!.id, status: 'pending', fee,
      message: `Request sent — ${area.name} needs the host's approval. ` +
        (fee > 0 ? `If approved, the $${fee.toFixed(2)} fee applies (collected by the property). ` : '') +
        'The guest will hear back once the host decides.',
    }
  },
}
