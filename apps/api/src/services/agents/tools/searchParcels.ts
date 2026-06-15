/**
 * Tool: search_parcels (landlord/investor read).
 *
 * Looks up county-assessor PARCEL records from GAM's property-intelligence
 * corpus (gam_properties — 3.4M+ parcels) by address, owner name, city, or APN.
 * For landlords/investors evaluating or researching property: assessed value,
 * owner, type, units, year built, last sale, lot size, location. When the query
 * is a specific APN with a single match, also returns the owner's portfolio
 * footprint (how many parcels / which states & counties they own in).
 *
 * Public-record data — landlord audience only (the property-intel surface is
 * owner/investor-facing; owner-name lookups aren't a tenant CS use case).
 * Read-only.
 */
import { searchParcels, getParcelByApn } from '../../parcels'
import type { AgentTool, AgentActor } from './types'

const APN_RE = /^[0-9][0-9.\- ]{2,}$/

export const searchParcelsTool: AgentTool = {
  name: 'search_parcels',
  description:
    'Look up county-assessor PARCEL records (property-intelligence data: assessed value, owner, ' +
    'property type, units, year built, last sale, lot size, location) by address, owner name, city, ' +
    'or APN. Use for landlord/investor property research — e.g. “who owns 123 Main St, Phoenix?”, ' +
    '“parcels owned by ACME LLC in AZ”, “assessed value of APN 123-45-678”. Optionally filter by a ' +
    'two-letter state. Returns the matching parcels (and the owner’s portfolio footprint for a single ' +
    'APN match). This is PUBLIC county-record data and may be out of date — present it as-is and tell ' +
    'them to confirm with the county assessor for anything that matters. Read-only.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Address, owner name, city, or APN to search for.' },
      state: { type: 'string', description: 'Optional two-letter state code (e.g. "AZ") to narrow the search.' },
    },
    required: ['query'],
  },
  audiences: ['landlord'],

  async execute(args, _actor: AgentActor) {
    const q = String(args.query ?? '').trim()
    const state = String(args.state ?? '').trim().toUpperCase()
    if (q.length < 2) return { ok: false, error: 'What address, owner, city, or APN should I look up?' }

    const results = await searchParcels(q, { state: state || undefined, limit: 12 })
    if (results.length === 0) {
      return {
        ok: true,
        query: q,
        state: state || null,
        results: [],
        note: `No parcel on file matching “${q}”${state ? ` in ${state}` : ''}. Try the full street address, the owner’s name, or the APN; coverage is strongest in states GAM has ingested.`,
      }
    }

    // Specific-APN lookup with a single hit → enrich with owner portfolio detail.
    let detail = null
    if (APN_RE.test(q) && results.length === 1) {
      detail = await getParcelByApn(results[0].apn)
    }

    return {
      ok: true,
      query: q,
      state: state || null,
      count: results.length,
      results,
      detail,
      note: 'Public county-assessor records — values, owners, and sale data may be out of date. Confirm with the county assessor for anything that matters.',
    }
  },
}
