/**
 * Tool: create_booking_checkout (visitor, ACTION — confirm first). Reserves a
 * site of the chosen type for the guest and returns a ready Stripe deposit
 * checkout link, so the guest only pays — they never re-type their dates, name,
 * or email into a separate form. Hard-scoped to actor.propertyId.
 *
 * CONFIRM-FIRST: the agent must read back the site type, exact dates, total, and
 * deposit (from check_availability) and get an explicit yes BEFORE calling. No
 * card details are ever taken in chat — payment happens on Stripe's page via the
 * returned link.
 *
 * 10/5 (Nic): a stay of 30+ nights needs the guest's own answer — a lease or a
 * stay (R2) — and the tool refuses without it rather than choose for them. A
 * stay of 22+ nights carries the background check's fee on the same charge
 * (R8); the result returns every figure the checkout charges, so the agent
 * never quotes less than the guest pays.
 *
 * Reuses the SAME engine as the public booking form: best-fit unit ranking +
 * services/propertyBooking.bookStay (per-unit advisory lock, tentative hold,
 * Stripe deposit checkout). W-20: the guest books a TYPE; the system assigns the
 * actual site.
 */

import { DateTime } from 'luxon'
import {
  resolvePropertyById, bookableUnits, groupSiteTypes,
} from '../../propertyBookingQuote'
import { bookStay, UnitFullError, StayTermsNeededError } from '../../propertyBooking'
import { LEASE_OR_STAY_WORDS } from '../../propertyBookingQuote'
import { rankUnitsBestFit } from '../../scheduleCompression'
import { todayIn } from '../../../lib/timezone'
import { STAY_TERMS, type StayTerms } from '@gam/shared'
import type { AgentTool, AgentActor } from './types'

export const createBookingCheckout: AgentTool = {
  name: 'create_booking_checkout',
  description:
    'Reserve a site and get the guest a pay-now checkout link — use this to actually BOOK after they’ve picked ' +
    'an available site type and dates (from check_availability) and said yes. CONFIRM FIRST: read back the site ' +
    'type, exact check-in/out, total, and what is due now (dueNow from check_availability), and get an explicit yes. You need the guest’s name and email ' +
    '(phone optional). No card details in chat — the returned link opens Stripe’s secure checkout for the ' +
    'deposit. Dates are YYYY-MM-DD. A stay of 30 nights or more needs stayTerms — ask the guest, in these words: "' +
    LEASE_OR_STAY_WORDS + '" — and pass "lease" or "stay" as THEY choose; never choose for them.',
  parameters: {
    type: 'object',
    properties: {
      siteTypeId: { type: 'string', description: 'The site type id to book (from get_property_pricing / check_availability).' },
      checkIn: { type: 'string', description: 'Check-in date, YYYY-MM-DD.' },
      checkOut: { type: 'string', description: 'Check-out date, YYYY-MM-DD.' },
      guestName: { type: 'string', description: 'The guest’s full name.' },
      guestEmail: { type: 'string', description: 'The guest’s email — the booking + payment receipt go here.' },
      guestPhone: { type: 'string', description: 'Optional phone number.' },
      note: { type: 'string', description: 'Optional message/question to the host to attach to the booking.' },
      stayTerms: { type: 'string', enum: [...STAY_TERMS], description: 'For a stay of 30 nights or more: "lease" or "stay", exactly as the guest chose.' },
    },
    required: ['siteTypeId', 'checkIn', 'checkOut', 'guestName', 'guestEmail'],
  },
  audiences: ['visitor'],

  async execute(args, actor: AgentActor) {
    if (!actor.propertyId) return { ok: false, error: 'No property is associated with this session.' }
    const prop = await resolvePropertyById(actor.propertyId)
    if (!prop) return { ok: false, error: 'This property’s booking site is not available.' }

    const siteTypeId = String(args.siteTypeId ?? '').trim()
    const checkIn = String(args.checkIn ?? '').trim()
    const checkOut = String(args.checkOut ?? '').trim()
    const guestName = String(args.guestName ?? '').trim()
    const guestEmail = String(args.guestEmail ?? '').trim()
    const guestPhone = typeof args.guestPhone === 'string' && args.guestPhone.trim() ? args.guestPhone.trim().slice(0, 40) : null
    const note = typeof args.note === 'string' && args.note.trim() ? args.note.trim().slice(0, 2000) : null
    const stayTerms: StayTerms | null = (STAY_TERMS as readonly string[]).includes(String(args.stayTerms))
      ? args.stayTerms as StayTerms : null

    if (!siteTypeId) return { ok: false, error: 'Which site type? Get it from get_property_pricing first.' }
    if (!guestName) return { ok: false, error: 'The guest’s name is required to book.' }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(guestEmail)) return { ok: false, error: 'A valid email is required to book.' }

    const ci = DateTime.fromISO(checkIn)
    const co = DateTime.fromISO(checkOut)
    if (!ci.isValid || !co.isValid) return { ok: false, error: 'Please give valid check-in and check-out dates (YYYY-MM-DD).' }
    if (co.startOf('day') <= ci.startOf('day')) return { ok: false, error: 'Check-out must be after check-in.' }
    // S654: "past" on the park's calendar, as the booking engine decides it.
    if (ci.toISODate()! < todayIn(prop.timezone)) return { ok: false, error: 'That check-in date is in the past.' }

    const units = await bookableUnits(prop.id)
    const siteType = groupSiteTypes(units).find((t) => t.id === siteTypeId)
    if (!siteType) return { ok: false, error: 'That site type isn’t available at this property — check get_property_pricing.' }

    // Same best-fit + hold + Stripe checkout as POST /property/:slug/book: the
    // stay slots into the snuggest compatible gap; a per-unit advisory lock in
    // bookStay is the race guard; UnitFullError just advances to the next site.
    const ranked = await rankUnitsBestFit(siteType.units.map((u: any) => u.id), { checkIn, checkOut })
    let lastFull: UnitFullError | null = null
    for (const unitId of ranked) {
      try {
        const r = await bookStay({
          slug: prop.booking_slug, unitId, guestName, guestEmail, guestPhone,
          checkIn, checkOut, note, stayTerms,
          requiredSiteLayout: siteType.requiredLayout ?? 'none',
          requiredAmpService: siteType.requiredAmp ?? 'none',
        })
        return {
          ok: true,
          checkoutUrl: r.checkoutUrl,
          // S648: card only, the card fee on the whole charge. 10/5: the
          // background check (R8) is its own line and part of what is due now.
          deposit: r.depositAmount,
          backgroundCheckFee: r.screeningFee,
          cardFee: r.cardFee,
          // Everything charged now — the figure check_availability quoted as dueNow.
          dueNow: r.dueNow,
          total: r.total,
          bookingId: r.bookingId,
          siteType: siteType.name,
          checkIn,
          // A stay with no lease is booked a month at a time (R5) — this is
          // the check-out the booking covers.
          checkOut: r.checkOut,
          stayTerms: r.stayTerms,
          heldThrough: r.heldWords,
          note: 'Give the guest the checkoutUrl to pay — that link holds their dates. The hold expires ' +
            'if it isn’t paid, so encourage them to complete it now. Do not read card details in chat.' +
            (r.screeningFee > 0 ? ' Tell them the background check is required for stays over three weeks; once paid, its link is emailed to them.' : '') +
            (r.heldWords ? ` Read them this: "${r.heldWords}"` : '') +
            (r.stayTerms === 'lease' ? ' The host reviews the lease and sends it to them to sign.' : ''),
        }
      } catch (e) {
        if (e instanceof UnitFullError) { lastFull = e; continue }
        if (e instanceof StayTermsNeededError) {
          return { ok: false, needsStayTerms: true, error: `This stay is 30 nights or more. Ask the guest, in these words: "${e.words}" Then call again with stayTerms "lease" or "stay" as they choose.` }
        }
        throw e
      }
    }
    return { ok: false, full: true, error: 'Those exact dates just filled for that site type — try check_availability for an open type or a shorter stay.', _lastFull: !!lastFull }
  },
}
