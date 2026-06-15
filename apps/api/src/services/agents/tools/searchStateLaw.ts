/**
 * Tool: search_state_law (tenant + landlord read).
 *
 * Answers OBSCURE landlord/tenant-law questions by full-text searching the
 * verbatim statute corpus (state_law_section_texts) for the relevant state
 * and returning the actual matching section(s) — number, title, text — so
 * the agent can ground its answer in the real statute instead of guessing.
 * A tenant's state is resolved from their own lease; a landlord passes the
 * state. Always hedged + dated (S442 Nic-authorized carve-out): every result
 * carries the source citation/URL + the "may be newer info; not legal advice;
 * confirm with a local attorney" disclaimer.
 */

import { queryOne } from '../../../db'
import {
  searchStateLawText,
  buildDisclaimer,
  citationFor,
  detectStubbedCategory,
  STUBBED_CATEGORY_LABELS,
} from '../../stateLaw'
import type { AgentTool, AgentActor } from './types'

const MAX_EXCERPT = 2000 // bound each section's text in the tool result

export const searchStateLaw: AgentTool = {
  name: 'search_state_law',
  description:
    'Search the actual text of a state’s landlord/tenant statutes for a specific or unusual question ' +
    '(e.g. “what happens to abandoned property?”, “rules on subletting”, “repainting charges”). ' +
    'Returns the relevant statute section(s) verbatim. A tenant’s state comes from their lease; a ' +
    'landlord should give the state. Present what it returns and tell the person to read it, compare ' +
    'it to what they’re trying to do, and check for newer law — do NOT interpret it or say whether ' +
    'they comply (GAM gives no legal guidance). Read-only.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'The specific legal question or topic to search for.' },
      state: { type: 'string', description: 'Two-letter state code (e.g. "AZ"). For a tenant, leave blank to use their lease.' },
    },
    required: ['query'],
  },
  audiences: ['tenant', 'landlord'],

  async execute(args, actor: AgentActor) {
    const q = String(args.query ?? '').trim()
    let state = String(args.state ?? '').trim().toUpperCase()
    if (q.length < 2) return { ok: false, error: 'What would you like me to look up in the state’s statutes?' }

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
      return { ok: false, error: 'Which state? Give me the two-letter code (e.g. "AZ") and I’ll search its statutes.' }
    }

    // Broader real-estate areas GAM hasn't deeply ingested yet (property tax,
    // zoning/land-use, environmental/condition disclosure) — defer gracefully
    // instead of guessing. Classify the QUESTION itself (not the search hits):
    // the corpus's one huge section, NY §233, satisfies almost any full-term
    // match, so a results-based gate is unreliable. Patterns are conservative
    // enough not to hijack genuine landlord/tenant questions.
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

    const hits = await searchStateLawText(state, q, 4)
    if (hits.length === 0) {
      return {
        ok: true,
        state,
        query: q,
        results: [],
        note: `I couldn’t find a matching statute section for ${state} in what GAM has on file. Try rephrasing the question, or check ${state}’s official statute site or a local attorney.`,
        disclaimer: buildDisclaimer(null),
      }
    }

    const latest = hits.map((h) => h.source_date).filter(Boolean).sort().pop() ?? null
    return {
      ok: true,
      state,
      query: q,
      results: hits.map((h) => ({
        // Proper per-state citation (A.R.S. § / NRS / Cal. Civ. Code § / Fla.
        // Stat. § / generic fallback) — single source in stateLaw.citationFor.
        citation: citationFor(state, h.section_number),
        section: h.section_number,
        title: h.section_title,
        text: h.full_text.length > MAX_EXCERPT ? h.full_text.slice(0, MAX_EXCERPT) + '… [truncated — see source]' : h.full_text,
        source: h.source_url,
      })),
      disclaimer: buildDisclaimer(latest),
    }
  },
}
