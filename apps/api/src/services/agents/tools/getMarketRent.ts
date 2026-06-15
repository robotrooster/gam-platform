/**
 * Tool: get_market_rent (landlord read).
 *
 * Tells a landlord where their rent sits vs the local market for a unit type,
 * using ANONYMIZED, AGGREGATED GAM rent data (Nic 2026-06-15, evolving S442 —
 * see project_market_rent_transparency). Returns a median + quartile band for
 * (unit_type, city, state), built only from markets with enough DISTINCT
 * landlords that no individual's rent is identifiable, and EXCLUDING the asking
 * landlord. Never names another landlord or shows a single-landlord figure.
 * Directional market context, not an appraisal. Read-only.
 */
import { getMarketRent, positionVsMarket } from '../../marketRent'
import type { AgentTool, AgentActor } from './types'

const POSITION_PHRASE: Record<string, string> = {
  below: 'below the local market (under the bottom quartile)',
  low: 'a bit under the local median',
  typical: 'in line with the local market (around the median)',
  above: 'above the local market (over the top quartile)',
}

export const getMarketRentTool: AgentTool = {
  name: 'get_market_rent',
  description:
    'Show how a rent compares to the local market for a unit type, using GAM’s anonymized aggregated ' +
    'rent data — median + quartile range for a city. Use for landlord questions like “is my 2BR rent ' +
    'competitive in Phoenix?” or “what’s market rent for a single-family in Mesa?”. Give unit_type ' +
    '(apartment, single_family, rv_spot, mobile_home, storage, commercial), city, and 2-letter state; ' +
    'optionally your_rent to see where it sits. Returns aggregate market figures only — NEVER another ' +
    'landlord’s specific rent. If the market is too thin to anonymize, it says so. Present as directional ' +
    'market context, not an appraisal. Read-only.',
  parameters: {
    type: 'object',
    properties: {
      unit_type: { type: 'string', description: 'apartment | single_family | rv_spot | mobile_home | storage | commercial' },
      city: { type: 'string', description: 'City name (e.g. "Phoenix").' },
      state: { type: 'string', description: 'Two-letter state code (e.g. "AZ").' },
      your_rent: { type: 'number', description: 'Optional — the landlord’s current rent, to compare against the market band.' },
    },
    required: ['unit_type', 'city', 'state'],
  },
  audiences: ['landlord'],

  async execute(args, actor: AgentActor) {
    const unitType = String(args.unit_type ?? '').trim()
    const city = String(args.city ?? '').trim()
    const state = String(args.state ?? '').trim().toUpperCase()
    const yourRent = args.your_rent != null ? Number(args.your_rent) : null
    if (!unitType || !city || state.length !== 2) {
      return { ok: false, error: 'Give me the unit type, city, and 2-letter state and I’ll pull the local market range.' }
    }

    // Exclude the asking landlord from the aggregate (market vs them).
    const stat = await getMarketRent(unitType, city, state, actor.profileId)
    if (!stat) {
      return {
        ok: true,
        market: null,
        note: `GAM doesn’t have enough ${unitType} rent data in ${city}, ${state} yet to show an anonymized market range. As more leases come onto the platform there, this will fill in.`,
      }
    }

    const result: Record<string, unknown> = {
      ok: true,
      market: {
        unit_type: stat.unit_type,
        city: stat.city,
        state: stat.state,
        median_rent: stat.median_rent,
        typical_range: { low: stat.p25_rent, high: stat.p75_rent },
        based_on: { leases: stat.n_leases, landlords: stat.n_landlords },
      },
      note: 'Anonymized aggregate from GAM lease data (no individual landlord identified). Directional market context, not an appraisal — confirm against your own comps.',
    }
    if (yourRent != null && yourRent > 0) {
      result.your_rent = yourRent
      result.position = positionVsMarket(yourRent, stat)
      result.position_phrase = `Your $${yourRent} is ${POSITION_PHRASE[positionVsMarket(yourRent, stat)]} (median $${stat.median_rent}, typical $${stat.p25_rent}–$${stat.p75_rent}).`
    }
    return result
  },
}
