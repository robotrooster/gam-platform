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
    if (ci < DateTime.now().startOf('day')) return { ok: false, error: 'That check-in date is in the past.' }

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
