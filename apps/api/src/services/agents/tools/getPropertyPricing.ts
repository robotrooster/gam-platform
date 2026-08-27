/**
 * Tool: get_property_pricing (visitor). Live rate card for THIS property — every
 * bookable site type with its nightly / weekly / monthly rate, the layout
 * (back-in vs pull-through) and amp service that distinguish types, plus the
 * deposit and short-term lodging tax. Hard-scoped to actor.propertyId. Read-only.
 *
 * Rates are read live from the landlord's settings, so a price change shows up on
 * the next question — the agent never memorizes or invents a number. The weekly
 * rate is the built-in weekly discount (charged instead of 7× nightly on 7+ night
 * stays); the agent can point that out. For a real quote on specific dates the
 * agent should use check_availability, which prorates + adds tax.
 */

import { resolvePropertyById, listSiteTypePricing } from '../../propertyBookingQuote'
import type { AgentTool, AgentActor } from './types'

const LAYOUT_LABEL: Record<string, string> = { back_in: 'Back-in', pull_through: 'Pull-through', none: '' }

export const getPropertyPricing: AgentTool = {
  name: 'get_property_pricing',
  description:
    'The live rate card for THIS property — each site type with its nightly, weekly, and monthly rate, whether ' +
    'it’s a back-in or pull-through site, its amp service, and the deposit + lodging tax. Use for “how much is a ' +
    'pull-through?”, “what are your rates?”, “do you have monthly?”, or any pricing question BEFORE specific ' +
    'dates are chosen. For a firm total on real dates, use check_availability instead. Read-only.',
  parameters: { type: 'object', properties: {} },
  audiences: ['visitor'],

  async execute(_args, actor: AgentActor) {
    if (!actor.propertyId) return { ok: false, error: 'No property is associated with this session.' }
    const prop = await resolvePropertyById(actor.propertyId)
    if (!prop) return { ok: false, error: 'This property’s booking site is not available.' }

    const pricing = await listSiteTypePricing(prop)
    if (pricing.siteTypes.length === 0) {
      return { ok: true, propertyName: pricing.propertyName, siteTypes: [], note: 'This property has no bookable site types published yet — offer to pass the question to the host.' }
    }

    return {
      ok: true,
      propertyName: pricing.propertyName,
      depositPct: pricing.depositPct,
      shortTermTaxRatePct: pricing.shortTermTaxRatePct,
      utilitiesBilledOnMonthly: pricing.utilitiesBilledOnMonthly,
      siteTypes: pricing.siteTypes.map((t) => ({
        id: t.id,
        name: t.name,
        layout: t.layout ? (LAYOUT_LABEL[t.layout] ?? t.layout) : null,
        ampService: t.ampService && t.ampService !== 'none' ? `${t.ampService} amp` : null,
        nightlyRate: t.nightlyRate,
        weeklyRate: t.weeklyRate,
        monthlyRate: t.monthlyRate,
        minStayNights: t.minStayNights,
        maxStayNights: t.maxStayNights,
      })),
      note:
        'Rates are per site. The weekly rate is the discounted 7-night price (charged instead of 7× nightly); ' +
        'monthly is the long-stay rate. Deposit and lodging tax apply — quote the exact total with ' +
        'check_availability once the guest has dates. Amounts are US dollars.\n' +
        // S626 (Nic): "Give the WEEKLY rate as an upsell with the actual
        // number; saying 'better rates for weekly and monthly' without the
        // figures wastes the pitch. RV people expect longer stays to be
        // cheaper." The discount is the strongest thing on this rate card and
        // it was being described instead of shown.
        'QUOTE THE WEEKLY FIGURE, DO NOT ALLUDE TO IT. When you give a nightly rate, give the weekly ' +
        'number alongside it — "$48 a night, or $290 for the week" — and say what that works out to ' +
        'per night if it is lower. Never say "we have better rates for longer stays" without the ' +
        'actual figures; the discount is the reason someone books a week, and a vague version of it ' +
        'persuades nobody. Same for monthly on a long-stay question.',
    }
  },
}
