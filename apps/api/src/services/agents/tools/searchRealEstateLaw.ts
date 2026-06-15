/**
 * Tool: search_real_estate_law (tenant + landlord read).
 *
 * The companion to search_state_law, but for real-estate law BEYOND the
 * landlord/tenant relationship: property tax, deeds & conveyancing/recording,
 * condominiums & co-ops, real-estate broker licensing, and mortgages/liens/
 * foreclosure. Full-text searches the verbatim corpus (state_law_section_texts,
 * the non-landlord/tenant categories) and returns the matching section(s) +
 * which area + citation, so the agent grounds its answer in real statute.
 * Same sanctioned posture as search_state_law: retrieve + cite + date, hedged,
 * never advice. Tenant state comes from their lease; a landlord passes it.
 * (For property-tax FIGURES — exemptions, appeal deadlines — prefer
 * get_property_tax_facts, which returns crisp structured numbers.)
 */

import { queryOne } from '../../../db'
import { searchRealEstateCorpus, buildDisclaimer, detectStubbedCategory, STUBBED_CATEGORY_LABELS } from '../../stateLaw'
import type { AgentTool, AgentActor } from './types'

const MAX_EXCERPT = 2000

// Human-readable label per law_category, so the agent can say which area a hit
// is from ("from property-tax law", "from the broker-licensing act").
const AREA_LABEL: Record<string, string> = {
  property_tax: 'property tax',
  conveyancing_title: 'deeds & conveyancing',
  condo_coop: 'condominium/co-op',
  broker_licensing: 'real estate broker licensing',
  mortgage_lien_foreclosure: 'mortgages, liens & foreclosure',
  general_real_property: 'general real property',
}

export const searchRealEstateLaw: AgentTool = {
  name: 'search_real_estate_law',
  description:
    'Search a state’s broader REAL-ESTATE statutes — property tax, deeds/recording & conveyancing, ' +
    'condos & co-ops, real-estate broker licensing, and mortgages/liens/foreclosure — for questions ' +
    'BEYOND the landlord/tenant relationship (use search_state_law for landlord/tenant). E.g. ' +
    '“how do I record a deed?”, “condo association assessments”, “what does a broker license require?”, ' +
    '“mechanic’s lien foreclosure”. Returns the relevant statute section(s) verbatim with the area ' +
    'they’re from. A tenant’s state comes from their lease; a landlord should give the state. Present ' +
    'what it returns and tell the person to read it and check for newer law — do NOT interpret it or ' +
    'advise on compliance. For property-tax numbers (exemptions, deadlines) prefer get_property_tax_facts. Read-only.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'The real-estate legal question or topic to search for.' },
      state: { type: 'string', description: 'Two-letter state code (e.g. "AZ"). For a tenant, leave blank to use their lease.' },
    },
    required: ['query'],
  },
  audiences: ['tenant', 'landlord'],

  async execute(args, actor: AgentActor) {
    const q = String(args.query ?? '').trim()
    let state = String(args.state ?? '').trim().toUpperCase()
    if (q.length < 2) return { ok: false, error: 'What real-estate-law topic would you like me to look up?' }

    if (!state && actor.role === 'tenant') {
      const r = await queryOne<{ state: string | null }>(
        `SELECT p.state
           FROM v_lease_active_tenants vlat
           JOIN leases l ON l.id = vlat.lease_id AND l.status = 'active'
           JOIN units u ON u.id = l.unit_id
           JOIN properties p ON p.id = u.property_id
          WHERE vlat.tenant_id = $1
          LIMIT 1`,
        [actor.profileId]
      )
      if (r?.state) state = String(r.state).trim().toUpperCase()
    }
    if (!state) {
      return { ok: false, error: 'Which state? Give me the two-letter code (e.g. "AZ") and I’ll search its real-estate statutes.' }
    }

    // Zoning/land-use + environmental/condition disclosure are intentionally
    // not deeply ingested — defer gracefully rather than guess.
    const stub = detectStubbedCategory(q)
    if (stub) {
      return {
        ok: true,
        state,
        query: q,
        results: [],
        note: `GAM is still working on getting the latest ${STUBBED_CATEGORY_LABELS[stub]} law for ${state} and doesn’t have it on file yet. For this kind of question, please consult a licensed attorney in ${state}. (This isn’t legal advice.)`,
        disclaimer: buildDisclaimer(null),
      }
    }

    const hits = await searchRealEstateCorpus(state, q, 5)
    if (hits.length === 0) {
      return {
        ok: true,
        state,
        query: q,
        results: [],
        note: `I couldn’t find a matching real-estate statute for ${state} in what GAM has on file. Try rephrasing, or check ${state}’s official statute site or a local attorney.`,
        disclaimer: buildDisclaimer(null),
      }
    }

    const latest = hits.map((h) => h.source_date).filter(Boolean).sort().pop() ?? null
    return {
      ok: true,
      state,
      query: q,
      results: hits.map((h) => ({
        area: AREA_LABEL[h.law_category] ?? h.law_category,
        // Generic citation: the per-state citationFor() map is tuned to
        // landlord/tenant section ranges and would mislabel these; the section
        // number + official source carry the precision.
        citation: `${state} § ${h.section_number}`,
        section: h.section_number,
        title: h.section_title,
        text: h.full_text.length > MAX_EXCERPT ? h.full_text.slice(0, MAX_EXCERPT) + '… [truncated — see source]' : h.full_text,
        source: h.source_url,
      })),
      disclaimer: buildDisclaimer(latest),
    }
  },
}
