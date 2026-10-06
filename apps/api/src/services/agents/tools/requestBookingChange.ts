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

import { query, db } from '../../../db'
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
import { continuousStayNights, syncStayUtilityAgreement } from '../../stayTerms'
import { logger } from '../../../lib/logger'
import { STAY_SCREENING_NIGHTS, STAY_LEASE_CHOICE_NIGHTS } from '@gam/shared'
import { scheduleStayPrice, reservationDue } from '../../registerStay'

function normalizeType(raw: string): BookingChangeRequestType | null {
  const v = raw.trim().toLowerCase().replace(/[\s-]+/g, '_')
  return (BOOKING_CHANGE_REQUEST_TYPES as readonly string[]).includes(v)
    ? (v as BookingChangeRequestType)
    : null
}

// S620: `dayOnly` used to be String(d).slice(0,10), which assumed these
// came back as ISO STRINGS. They do not — pg hands back a `date` column as
// a JavaScript Date, so String(d) is "Fri Jul 10 2026 00:00:00 GMT-0700"
// and slicing it gives "Fri Jul 10". addDays then built
// new Date("Fri Jul 10T00:00:00Z") — Invalid Date — and toISOString threw
// RangeError for EVERY structured change type.
//
// Consequence: the S552 auto-approval path ("schedule-permitting changes
// apply AUTOMATICALLY") could never run. A guest asking for an extra night
// — which is more money for the landlord — got "I couldn't get that extra
// night for you right now." Found by the two-turn harness; invisible on
// turn one because the tool only fires once the guest gives specifics.
//
// LOCAL parts, not toISOString(). pg builds the Date at LOCAL midnight for
// a date column, so local getters return exactly the stored day in any
// timezone. toISOString() would be correct only at or west of UTC and
// would silently shift the day back on a UTC+ host — which matters,
// because the database is moving off this Mac to a droplet.
const pad2 = (n: number) => String(n).padStart(2, '0')
const dayOnly = (d: string | Date): string => {
  if (d instanceof Date) {
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
  }
  return String(d).slice(0, 10)
}
const addDays = (d: string | Date, n: number): string => {
  const t = new Date(`${dayOnly(d)}T00:00:00Z`)
  t.setUTCDate(t.getUTCDate() + n)
  return t.toISOString().slice(0, 10)
}

/**
 * 10/6 (Nic): "one price for the same nights at every door" — what one more
 * night adds is what the stay costs with it less what it costs without it, at
 * the site's rates (else the property's), by the one rule every door prices a
 * stay with (registerStay scheduleStayPrice → shared priceStay: the cheapest
 * whole months, weeks and nights that cover it, plus the lodging tax). A sixth
 * night can cost nothing extra when six nights are charged the week's price.
 * null when the site has no rate to price it.
 */
async function extraNightPrice(b: { unit_id?: string | null; check_in?: string | Date | null; check_out?: string | Date | null }):
    Promise<{ extra: number; before: number; after: number; nightsAfter: number } | null> {
  if (!b.unit_id || !b.check_in || !b.check_out) return null
  const r = (await query<any>(
    `SELECT COALESCE(u.nightly_rate, p.nightly_rate)::float AS nightly,
            COALESCE(u.weekly_rate, p.weekly_rate)::float AS weekly,
            COALESCE(u.monthly_rate, p.monthly_rate)::float AS monthly,
            p.short_term_tax_rate::float AS tax_pct
       FROM units u JOIN properties p ON p.id = u.property_id WHERE u.id = $1`, [b.unit_id]))[0]
  if (!r) return null
  const rates = { nightly: r.nightly, weekly: r.weekly, monthly: r.monthly }
  const checkIn = dayOnly(b.check_in), checkOut = dayOnly(b.check_out)
  const before = scheduleStayPrice(rates, r.tax_pct, checkIn, checkOut)
  const after = scheduleStayPrice(rates, r.tax_pct, checkIn, addDays(checkOut, 1))
  if (!(before.total > 0) || !(after.total > 0)) return null
  return { extra: Math.round(Math.max(0, after.total - before.total) * 100) / 100, before: before.total, after: after.total, nightsAfter: after.nights }
}

export const requestBookingChange: AgentTool = {
  name: 'request_booking_change',
  description:
    'Change the guest’s stay — a late checkout, an early check-in, an extra night, or some other request. ' +
    'When the schedule has room, late checkout / early check-in / extra night are CONFIRMED automatically and ' +
    'the host is notified; if the schedule is tight (or for "other" requests) it goes to the host to decide. ' +
    'An extra night that makes the stay 22 or 30 nights in a row also goes to the host to decide. ' +
    'An EXTRA NIGHT COSTS MONEY, so it is two steps: call once without `confirmed` and you get the price ' +
    'back — tell them what it costs and ask if they want it — then call again with confirmed: true. Never ' +
    'book a paid night off "is it available?"; being available is not being agreed to.\n' +
    'Confirm the specifics with the guest first (e.g. what time, which night), then call. request_type must be ' +
    'one of: late_checkout, early_checkin, extra_night, other. Put the detail (a time, a date, the ask in their ' +
    'words) in `details`. Relay the tool’s note to the guest — it says whether the change is confirmed or pending.',
  parameters: {
    type: 'object',
    properties: {
      request_type: { type: 'string', description: 'One of: late_checkout, early_checkin, extra_night, other.' },
      details: { type: 'string', description: 'The specifics in plain language — e.g. "checkout at 2pm instead of 11am" or "one more night, through the 14th".' },
      confirmed: { type: 'boolean', description: 'For an EXTRA NIGHT only: true once you have told them the price and they have said yes to it. Leave it out the first time — you will get the price back to quote.' },
    },
    required: ['request_type'],
  },
  audiences: ['guest'],
  async execute(args, actor: AgentActor) {
    if (!actor.bookingId) return { ok: false, error: 'No booking is associated with this session.' }
    const type = normalizeType(String(args.request_type ?? ''))
    if (!type) return { ok: false, error: 'Tell me which kind of request: a late checkout, early check-in, extra night, or something else.' }

    const b = await loadGuestBookingContext(actor.bookingId)
    // The average nightly they are already paying — total over nights. Not the
    // published rate card (that can have moved since they booked), which is the
    // point: this is the number that applies to THEM.
    const bookedNights = Number((b as any)?.nights)
    const bookedTotal = Number((b as any)?.total_amount)
    const nightlyRate =
      Number.isFinite(bookedNights) && bookedNights > 0 && Number.isFinite(bookedTotal) && bookedTotal > 0
        ? bookedTotal / bookedNights
        : null
    if (!b) return { ok: false, error: 'That booking could not be found.' }
    // 10/6 (Nic): the extra night at the one price every door charges (above);
    // the average they are paying stands in only when the site has no rate.
    const ruled = type === 'extra_night' ? await extraNightPrice(b as any).catch(() => null) : null
    const extraPrice = ruled ? ruled.extra : nightlyRate == null ? null : Math.round(nightlyRate * 100) / 100
    const extraWords = (p: number) => p > 0
      ? `one more night is $${p.toFixed(2)}`
      : 'one more night costs nothing extra — the stay is already charged the lower weekly or monthly price that covers it'

    // S630 (Nic): "it skips that confirmation step... maybe it's out of their
    // price range." A guest asking "is there room for one more night?" is asking
    // about availability, and the reply booked and charged the night. Being
    // available is not being agreed to.
    //
    // So a paid change quotes first and does nothing. The price comes back for
    // the agent to say out loud; the second call, after the guest says yes,
    // performs it. Free changes (late checkout, early check-in) are unaffected —
    // there is nothing to agree to.
    if (type === 'extra_night' && args.confirmed !== true) {
      return {
        ok: true,
        quoteOnly: true,
        nightlyRate: nightlyRate == null ? null : Math.round(nightlyRate * 100) / 100,
        extraNightPrice: extraPrice,
        message: extraPrice == null
          ? 'NOT booked yet. Tell them you can add the night, that you will confirm what it costs, and ask if they want it. Call again with confirmed: true only after they say yes.'
          : ruled
            ? `NOT booked yet. Tell them ${extraWords(extraPrice)}, and ask if they want it. Call again with confirmed: true only after they say yes. Do NOT say it is booked.`
            : `NOT booked yet. Tell them one more night is $${extraPrice.toFixed(2)} — the same nightly rate they are already paying — and ask if they want it. Call again with confirmed: true only after they say yes. Do NOT say it is booked.`,
      }
    }
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
    let autoApproved = false
    let newCheckOut: string | null = null
    // 10/5 (Nic, R1/R2): one more night can make a stay more than three weeks
    // (a background check before check-in, with its fee) or 30 nights (lease or
    // stay — the desk's answer, and "either way, it goes to me"). The assistant
    // can take neither, so an extra night that crosses 22 or 30 continuous
    // nights (back-to-back stays add up, R7) is never confirmed on its own: it
    // goes to the host to decide, like a night the schedule has no room for.
    let crossesStayRule = false
    let crossNote = ''
    if (type === 'extra_night' && b.unit_id && b.property_id) {
      const checkIn = dayOnly(b.check_in)
      const before = await continuousStayNights({
        propertyId: b.property_id, bookingId: actor.bookingId,
        checkIn, checkOut: dayOnly(b.check_out),
      })
      const after = await continuousStayNights({
        propertyId: b.property_id, bookingId: actor.bookingId,
        checkIn, checkOut: addDays(b.check_out, 1),
      })
      const crossesCheck = before.nights < STAY_SCREENING_NIGHTS && after.nights >= STAY_SCREENING_NIGHTS
      const crossesLease = before.nights < STAY_LEASE_CHOICE_NIGHTS && after.nights >= STAY_LEASE_CHOICE_NIGHTS
      crossesStayRule = crossesCheck || crossesLease
      if (crossesStayRule) {
        crossNote = ` One more night makes it ${after.nights} nights in a row, which `
          + (crossesLease
              ? 'needs a lease or a stay chosen for it'
              : 'needs a background check before check-in')
          + ', so it was not confirmed automatically. Make the change on the schedule, where you will be asked.'
      }
    }
    if (b.unit_id && !crossesStayRule && ['late_checkout', 'early_checkin', 'extra_night'].includes(type)) {
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
          // 10/6 (Nic): the night is priced as the schedule prices a longer
          // stay — what the quote said goes on the reservation's price, so the
          // desk collects it like any balance. (A stay of 30+ nights is billed
          // by its lease or a month at a time, and is left as it was.)
          const addToPrice = ruled && ruled.nightsAfter < STAY_LEASE_CHOICE_NIGHTS && Number(b.total_amount) > 0 ? ruled.extra : 0
          // 10/6 (Nic): what was already paid stays paid toward the longer
          // stay, and the night is what is owed now — the same way Add a month
          // keeps it (extendStayByMonth). Without this a stay paid in full kept
          // its "paid" stamp, the bigger price read as paid, and nobody was
          // ever asked for the night.
          const paidBefore = addToPrice > 0 ? ((await reservationDue(db, actor.bookingId))?.paid ?? 0) : 0
          await query(
            // 10/3 (decisions #33): booked_check_out is the length the stay
            // is sold for, and the extra night is sold — it moves with check_out
            // (as a schedule edit and an added month move it).
            `UPDATE unit_bookings
                SET check_out = check_out + INTERVAL '1 day',
                    booked_check_out = CASE WHEN booked_check_out IS NULL THEN NULL
                                            ELSE GREATEST(booked_check_out, (check_out + INTERVAL '1 day')::date) END,
                    nights = COALESCE(nights, 0) + 1,
                    total_amount = CASE WHEN $2::numeric > 0 THEN total_amount + $2::numeric ELSE total_amount END,
                    deposit_amount = CASE WHEN $2::numeric > 0 AND $3::numeric > 0 THEN $3::numeric ELSE deposit_amount END,
                    deposit_paid_at = CASE WHEN $2::numeric > 0 AND $3::numeric > 0 THEN COALESCE(deposit_paid_at, NOW()) ELSE deposit_paid_at END,
                    balance_paid_at = CASE WHEN $2::numeric > 0 THEN NULL ELSE balance_paid_at END
              WHERE id = $1`,
            [actor.bookingId, addToPrice, paidBefore]
          )
          // R11: a stay's utility agreement (a 30+ night stay with no lease)
          // follows its new check-out. Best-effort — the night is booked.
          await syncStayUtilityAgreement(actor.bookingId).catch((err) =>
            logger.error({ err, bookingId: actor.bookingId }, '[guest-agent] stay utility agreement did not follow the extra night'))
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
      : `${b.guest_name ?? 'A guest'} at ${where} requested ${label.toLowerCase()}${details ? ` — ${details}` : ''}.${crossNote}`
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
          // S626 (Nic): "Confirm the nightly rate when offering the extension.
          // It can already read the booking, so it can read the property's
          // rates — quote them rather than making the guest ask." "Any charge
          // ... is settled with the property as usual" is the sentence that
          // makes someone ask how much, which is the one thing they were always
          // going to ask. The average nightly off their OWN booking is a real
          // figure and needs no extra lookup.
          ? `Confirmed — the stay now runs through ${newCheckOut}.` +
            (ruled
              ? ` Tell them ${extraWords(ruled.extra)}${ruled.extra > 0 ? ', settled with the property as usual' : ''}.`
              : nightlyRate != null
              ? ` Tell them the extra night is about $${nightlyRate.toFixed(2)}, the same nightly rate as the rest of the stay, settled with the property as usual.`
              : ' Any charge for the extra night is settled with the property as usual.') +
            ' The host has been notified.'
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
