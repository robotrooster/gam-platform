/**
 * Tool: get_applicable_laws (tenant + landlord read).
 *
 * Surfaces the landlord/tenant law that applies to a unit — which act(s)
 * govern it and the key sections to read — from the SOURCED, DATED state-law
 * KB (S442). For a tenant, the state + unit type are resolved from their own
 * active lease; a landlord passes the state + unit type (their portfolio can
 * span states).
 *
 * POSTURE (Nic): GAM only RETRIEVES the statute — it gives NO guidance and NO
 * compliance opinion. The result is informational pointers + the verbatim-text
 * search tool, plus a disclaimer telling the user to read it, compare it to
 * their own situation, check for newer law, and consult an attorney. The
 * engine returns nothing for states GAM hasn't sourced yet. See
 * services/stateLaw.ts + the migration headers — this is the Nic-authorized
 * carve-out of the no-state-legal rule, NOT a violation.
 */

import { queryOne } from '../../../db'
import { getApplicableActs, getProvisionsForActIds, buildDisclaimer } from '../../stateLaw'
import type { AgentTool, AgentActor } from './types'

export const getApplicableLaws: AgentTool = {
  name: 'get_applicable_laws',
  description:
    'Look up the landlord/tenant laws that apply to a rental — which state act(s) govern the unit ' +
    'and key rules (entry notice, deposits, notice to vacate). For a tenant it uses their own lease; ' +
    'a landlord should give the state and unit type (e.g. "AZ", "rv_spot"). Always presents results ' +
    'as hedged, dated, "not legal advice — confirm locally". Use for “what are the rules for my ' +
    'unit?”, “how much deposit can my landlord charge in Arizona?”, or to sanity-check a setting.',
  parameters: {
    type: 'object',
    properties: {
      state: { type: 'string', description: 'Two-letter state code (e.g. "AZ"). For a tenant, leave blank to use their own lease.' },
      unitType: { type: 'string', description: 'Unit type: apartment, single_family, rv_spot, mobile_home, storage, or commercial. For a tenant, leave blank to use their own lease.' },
    },
  },
  audiences: ['tenant', 'landlord'],

  async execute(args, actor: AgentActor) {
    let state = String(args.state ?? '').trim().toUpperCase()
    let unitType = String(args.unitType ?? '').trim()

    // Tenant: resolve state + unit type from their OWN active lease.
    if ((!state || !unitType) && actor.role === 'tenant') {
      const r = await queryOne<{ state: string | null; unit_type: string | null }>(
        `SELECT p.state, u.unit_type
           FROM v_lease_active_tenants vlat
           JOIN leases l ON l.id = vlat.lease_id AND l.status = 'active'
           JOIN units u ON u.id = l.unit_id
           JOIN properties p ON p.id = u.property_id
          WHERE vlat.tenant_id = $1
          LIMIT 1`,
        [actor.profileId]
      )
      if (r) {
        if (!state) state = String(r.state ?? '').trim().toUpperCase()
        if (!unitType) unitType = String(r.unit_type ?? '').trim()
      }
    }

    if (!state || !unitType) {
      return { ok: false, error: 'Tell me the state and unit type (e.g. "AZ" and "rv_spot") and I’ll pull the landlord-tenant laws that apply.' }
    }

    const acts = await getApplicableActs(state, unitType)
    if (acts.length === 0) {
      return {
        ok: true,
        state,
        unitType,
        acts: [],
        note: `GAM doesn’t have ${state} landlord-tenant law on file for ${unitType} units yet — check your state’s official site or a local attorney.`,
        disclaimer: buildDisclaimer(null),
      }
    }

    const provisions = await getProvisionsForActIds(acts.map((a) => a.id))
    const dates = [...acts.map((a) => a.source_date), ...provisions.map((p) => p.source_date)].filter(Boolean).sort()
    const latest = dates[dates.length - 1] ?? null

    return {
      ok: true,
      state,
      unitType,
      acts: acts.map((a) => ({ name: a.act_name, governs: a.unit_types, summary: a.summary, source: a.official_url })),
      // Pointers to the relevant sections — NOT a compliance judgment. The
      // person reads the statute and compares it to their own situation.
      keySections: provisions.map((p) => ({ topic: p.topic, addresses: p.summary, citation: p.statute_citation, source: p.source_url })),
      note: 'These are the statute sections that govern this unit. Read them and compare to what you’re trying to do yourself — GAM does not advise on whether you comply. Use search_state_law to pull the full text of any section.',
      disclaimer: buildDisclaimer(latest),
    }
  },
}
