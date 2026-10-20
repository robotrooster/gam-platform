/**
 * Tool: check_against_law (tenant + landlord read).
 *
 * Compares a specific number or timeline the person is using or considering —
 * a late-fee amount, a security-deposit amount, an entry-notice period, a
 * notice-to-vacate period — against the figure in the state statute, and
 * flags an OBJECTIVE factual mismatch (Nic S442: an obvious numeric/timeline
 * mismatch may be flagged factually; it is NOT legal advice). Never interprets
 * the statute or declares a violation — it only states the two figures and the
 * direction of the mismatch, hedged + dated, and tells the person to check the
 * current law and consult an attorney. A tenant's state comes from their
 * lease; a landlord passes the state.
 *
 * 10/20 (Nic): NO PROFILE OFFERS THIS TOOL any more — see LAW_TOOLS in
 * services/agents/profiles.ts for why, since a tool the model can see is a tool
 * it offers, and an offer followed by the refusal below is worse than not
 * offering. The refusal stays as the belt: anything that reaches execute() by
 * another road still gets no verdict, in either direction. Bringing the
 * comparison back is the flag AND that list.
 */

import { queryOne } from '../../../db'
import { checkAgainstStatute, getLatestProvision, STATE_LAW_TOPICS, buildDisclaimer, stateLawWarningsEnabled } from '../../stateLaw'
import type { StateLawTopic } from '../../stateLaw'
import type { AgentTool, AgentActor } from './types'

const TOPIC_KEYS = Object.keys(STATE_LAW_TOPICS) as StateLawTopic[]

export const checkAgainstLaw: AgentTool = {
  name: 'check_against_law',
  description:
    'Compare a specific number or timeline against the state statute and flag an OBJECTIVE factual ' +
    'mismatch — e.g. someone wants a $100/day late fee, a 2-month deposit, or 1 day of entry notice. ' +
    'Pass the topic and the value in its unit: entry_notice_hours (hours), deposit_max_months ' +
    '(months of rent), deposit_return_days (days), notice_to_vacate_days (days), late_fee (dollars ' +
    'per day). A tenant’s state comes from their lease; a landlord gives the state. Report the result ' +
    'factually (not legal advice) and tell them to check current law + consult an attorney. Read-only.',
  parameters: {
    type: 'object',
    properties: {
      topic: { type: 'string', enum: TOPIC_KEYS, description: 'Which statutory figure to compare against.' },
      value: { type: 'number', description: 'The number/timeline to check, in the topic’s unit (see description).' },
      state: { type: 'string', description: 'Two-letter state code (e.g. "AZ"). For a tenant, leave blank to use their lease.' },
    },
    required: ['topic', 'value'],
  },
  audiences: ['tenant', 'landlord'],

  async execute(args, actor: AgentActor) {
    // 10/20 (Nic): "There should be no state law warnings anywhere in the
    // system." This tool's entire output IS a warning — a verdict on someone's
    // number against a statute — so it stands down while the switch in
    // services/stateLaw is off, and comes back with it. Stopping here matters:
    // if it fell through, checkAgainstStatute would return no flag and the
    // answer would read "your number is within the figure in state law", which
    // is a false all-clear and worse than the banner we just took away.
    // Statute RETRIEVAL is untouched — search_state_law and
    // get_applicable_laws still pull the text when a person asks for it.
    if (!(await stateLawWarningsEnabled())) {
      return {
        ok: false,
        error:
          'GAM is not comparing figures against state law right now, so I can’t tell you ' +
          'whether that number lines up. I can pull the statute text itself with ' +
          'search_state_law so you can read it and decide, or talk to an attorney in your state.',
      }
    }
    const topic = String(args.topic ?? '') as StateLawTopic
    const value = Number(args.value)
    let state = String(args.state ?? '').trim().toUpperCase()
    if (!TOPIC_KEYS.includes(topic)) return { ok: false, error: `I can check these against the statute: ${TOPIC_KEYS.join(', ')}.` }
    if (!Number.isFinite(value)) return { ok: false, error: 'Give me the number to check (e.g. the late-fee amount or the notice period).' }

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
    if (!state) return { ok: false, error: 'Which state? Give me the two-letter code (e.g. "AZ").' }

    const provision = await getLatestProvision(state, topic)
    if (!provision) {
      return {
        ok: true,
        state,
        topic,
        value,
        matched: false,
        note: `GAM doesn’t have a ${String(topic).replace(/_/g, ' ')} figure on file for ${state}. Check the state’s official site and a local attorney.`,
        disclaimer: buildDisclaimer(null),
      }
    }

    const flag = await checkAgainstStatute(state, topic, value)
    return {
      ok: true,
      state,
      topic,
      value,
      statute: {
        figure: provision.threshold_numeric != null ? Number(provision.threshold_numeric) : null,
        unit: provision.threshold_unit,
        rule: provision.summary,
        citation: provision.statute_citation,
        source: provision.source_url,
      },
      // mismatch === objective factual flag; otherwise the value is within the
      // figure on file — GAM still gives no opinion on overall compliance.
      mismatch: !!flag,
      message: flag
        ? flag.message
        : `The ${value} you gave is within the ${Number(provision.threshold_numeric)} ${provision.threshold_unit ?? ''} listed in ${state} law${provision.statute_citation ? ` (${provision.statute_citation})` : ''} — but check the current version yourself.`,
      disclaimer: buildDisclaimer(provision.source_date),
    }
  },
}
