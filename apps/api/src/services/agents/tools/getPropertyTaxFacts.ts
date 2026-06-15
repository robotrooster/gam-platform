/**
 * Tool: get_property_tax_facts (tenant + landlord read).
 *
 * Returns the KEY STRUCTURED property-tax figures GAM has on file for a state —
 * exemptions (homestead/senior/veteran/disability), the assessment-appeal
 * deadline + review body, payment timing, and the tax-sale redemption period.
 * Crisp facts for conversation (vs search_real_estate_law's raw statute text).
 * Each fact carries its statute citation; some are flagged "locally set" where
 * the state frames it but the county/municipality sets the actual number.
 * Sanctioned carve-out: factual + cited + dated, never advice. Tenant state
 * comes from their lease; a landlord passes it.
 */

import { queryOne } from '../../../db'
import { getPropertyTaxProvisions, buildDisclaimer } from '../../stateLaw'
import type { AgentTool, AgentActor } from './types'

const TOPIC_LABEL: Record<string, string> = {
  exemption: 'exemption',
  assessment: 'assessment',
  assessment_appeal: 'assessment appeal / grievance',
  payment: 'payment / due dates',
  delinquency_redemption: 'delinquency & redemption',
}

export const getPropertyTaxFacts: AgentTool = {
  name: 'get_property_tax_facts',
  description:
    'Get the key STRUCTURED property-tax facts for a state — exemptions (homestead, senior, veteran, ' +
    'disability), the assessment-appeal/grievance deadline & review body, payment timing, and the ' +
    'tax-sale redemption period — with statute citations. Use for property-tax questions like “what ' +
    'senior exemption is there?”, “when is the assessment-appeal deadline?”, “how long to redeem after ' +
    'a tax sale?”. A tenant’s state comes from their lease; a landlord should give the state. Many ' +
    'figures are set LOCALLY (county/municipality) within a state framework — say so when flagged, and ' +
    'tell them to confirm the current figure with their assessor and check for newer law. Not legal ' +
    'advice. Read-only.',
  parameters: {
    type: 'object',
    properties: {
      state: { type: 'string', description: 'Two-letter state code (e.g. "TX"). For a tenant, leave blank to use their lease.' },
    },
    required: [],
  },
  audiences: ['tenant', 'landlord'],

  async execute(args, actor: AgentActor) {
    let state = String(args.state ?? '').trim().toUpperCase()

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
      return { ok: false, error: 'Which state? Give me the two-letter code (e.g. "TX") and I’ll pull its property-tax facts.' }
    }

    const provisions = await getPropertyTaxProvisions(state)
    if (provisions.length === 0) {
      return {
        ok: true,
        state,
        facts: [],
        note: `GAM doesn’t have structured property-tax facts on file for ${state} yet. Check ${state}’s department of revenue / assessor or a local attorney.`,
        disclaimer: buildDisclaimer(null),
      }
    }

    const latest = provisions.map((p) => p.source_date).filter(Boolean).sort().pop() ?? null
    return {
      ok: true,
      state,
      facts: provisions.map((p) => ({
        area: TOPIC_LABEL[p.topic] ?? p.topic,
        subtype: p.subtype,
        summary: p.summary,
        figures: p.params, // structured params (age_min, income_max, benefit, deadline_desc, redemption_period_months, locally_variable, …)
        locally_set: (p.params as { locally_variable?: boolean }).locally_variable === true,
        citation: p.statute_citation,
        source: p.source_url,
      })),
      disclaimer: buildDisclaimer(latest),
    }
  },
}
