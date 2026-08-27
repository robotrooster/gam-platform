/**
 * Tool: check_availability (visitor). A real quote for THIS property on specific
 * dates — which site types are open and the exact total (auto-tiered
 * nightly/weekly/monthly, prorated, with lodging tax and deposit). Hard-scoped to
 * actor.propertyId. Read-only — it never holds a site; use create_booking_checkout
 * to reserve. Mirrors the public booking site's availability engine exactly
 * (same source), so the number the agent quotes matches the booking form.
 */

import { DateTime } from 'luxon'
import {
  resolvePropertyById, bookableUnits, groupSiteTypes, resolveSiteType, typeAvailability,
} from '../../propertyBookingQuote'
import type { AgentTool, AgentActor } from './types'

const LAYOUT_LABEL: Record<string, string> = { back_in: 'Back-in', pull_through: 'Pull-through', none: '' }

export const checkPropertyAvailability: AgentTool = {
  name: 'check_availability',
  description:
    'Check open site types and the EXACT total for THIS property on specific dates. Use once the guest gives a ' +
    'check-in and check-out ("are you open Aug 2–6?", "what would 5 nights on a pull-through run?"). Returns ' +
    'each type’s availability, the auto-tiered total (nightly/weekly/monthly, prorated + tax), and the deposit ' +
    'due now. If a type is full it may offer a shorter stay that fits. Dates are YYYY-MM-DD. Read-only — does ' +
    'not hold anything.',
  parameters: {
    type: 'object',
    properties: {
      checkIn: { type: 'string', description: 'Check-in date, YYYY-MM-DD.' },
      checkOut: { type: 'string', description: 'Check-out date, YYYY-MM-DD (must be after check-in).' },
      siteTypeId: { type: 'string', description: 'Optional — limit the quote to one site type id (from get_property_pricing).' },
    },
    required: ['checkIn', 'checkOut'],
  },
  audiences: ['visitor'],

  async execute(args, actor: AgentActor) {
    if (!actor.propertyId) return { ok: false, error: 'No property is associated with this session.' }
    const prop = await resolvePropertyById(actor.propertyId)
    if (!prop) return { ok: false, error: 'This property’s booking site is not available.' }

    const checkIn = String(args.checkIn ?? '').trim()
    const checkOut = String(args.checkOut ?? '').trim()
    const ci = DateTime.fromISO(checkIn)
    const co = DateTime.fromISO(checkOut)
    if (!ci.isValid || !co.isValid) return { ok: false, error: 'Please give valid check-in and check-out dates (YYYY-MM-DD).' }
    const nights = Math.round(co.startOf('day').diff(ci.startOf('day'), 'days').days)
    if (nights <= 0) return { ok: false, error: 'Check-out must be after check-in.' }
    // S626: this used to return the bare string "That check-in date is in the
    // past." — and the model, quite reasonably, said that to the customer.
    //
    // profiles.ts already tells the booking agent that a bare day number is
    // never in the past and to ASK WHICH MONTH, but a prompt bullet loses to a
    // tool result every time: the result is the most recent and most specific
    // thing in the context, and it said "in the past" in plain English. So the
    // agent told someone trying to hand over money that their dates had already
    // happened, and apologised for "using the current date".
    //
    // The error now carries the instruction instead of the phrase, and offers
    // the month they most likely meant so the question can be a confirmation
    // rather than an interrogation.
    if (ci < DateTime.now().startOf('day')) {
      const likely = ci.plus({ months: 1 }) >= DateTime.now().startOf('day')
        ? ci.plus({ months: 1 })
        : ci.plus({ years: 1 })
      // The same span, moved to the soonest month those day numbers can fall in.
      const likelyOut = likely.plus({ days: nights })
      return {
        ok: false,
        needsMonth: true,
        likelyCheckIn: likely.toISODate(),
        likelyCheckOut: likelyOut.toISODate(),
        likelyMonth: likely.toFormat('LLLL yyyy'),
        error:
          // S626, second pass. The first version of this still described the
          // dates as having "gone by", and the agent duly told the customer
          // their dates had "already passed" — the exact thing it was being
          // told not to say. Naming a banned phrase in the instruction is how
          // you get the banned phrase. This version never mentions the calendar
          // at all; it only says what to do next.
          //
          // It also hands over the exact ISO dates, because the agent invented
          // a YEAR. Asked to try September it called with 2024 — also in the
          // past — got this error again, and asked which month a second time.
          // That was the loop: an ambiguous month became an infinite question.
          `The month is ambiguous — they gave day numbers without naming a month, and this year's ` +
          `have already been taken off the calendar. The soonest those days can fall is ` +
          `${likely.toFormat('LLLL yyyy')}.\n` +
          `Ask them to confirm the month in one short question — "September?" — and as soon as they ` +
          `do, call this tool again with EXACTLY checkIn="${likely.toISODate()}" and ` +
          `checkOut="${likelyOut.toISODate()}" (adjusting only if they name a different month). ` +
          `Use those strings verbatim; do not compose a date yourself and never state a year other ` +
          `than ${likely.year}.\n` +
          `Say nothing about the calendar, nothing about which dates are or are not still available ` +
          `in time, and do not apologise or mention any date you assumed. Just ask the month.`,
      }
    }

    const units = await bookableUnits(prop.id)
    if (units.length === 0) return { ok: true, nights, siteTypes: [], note: 'This property has no bookable sites published yet.' }

    const wanted = args.siteTypeId ? [resolveSiteType(units, String(args.siteTypeId))] : groupSiteTypes(units)
    const siteTypes = []
    for (const t of wanted) {
      const a = await typeAvailability(prop, t, nights, checkIn, checkOut)
      siteTypes.push({
        id: t.id,
        name: t.name,
        layout: t.requiredLayout ? (LAYOUT_LABEL[t.requiredLayout] ?? t.requiredLayout) : null,
        available: a.available,
        unavailableReason: a.unavailableReason,
        tier: a.tier,
        total: a.total,
        depositDueNow: a.depositAmount,
        taxIncluded: a.taxable ? a.tax : 0,
        // If full for the whole range, the longest stay from the same check-in that WOULD fit.
        alternativeStay: a.altStay,
      })
    }

    return {
      ok: true,
      nights,
      checkIn,
      checkOut,
      depositPct: Number(prop.booking_deposit_pct),
      siteTypes,
      note:
        'Totals are the full stay in US dollars, tax included where it applies; depositDueNow is what the guest ' +
        'pays now to reserve (the rest is due per the host). To actually book an available type, confirm the ' +
        'details with the guest and use create_booking_checkout.',
    }
  },
}
