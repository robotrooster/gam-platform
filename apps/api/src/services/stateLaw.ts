/**
 * State landlord/tenant law — compliance-warning engine (S442, Nic-authorized).
 *
 * Powers hedged "this may not comply with the laws of <state>" warnings for
 * BOTH landlord and tenant, keyed off a property's state + the unit type.
 * Reads the SOURCED, DATED catalog in state_landlord_tenant_acts /
 * state_law_provisions (see the migration header for why this is a
 * sanctioned extension of the no-state-legal rule). The engine NEVER asserts
 * the law as fact — every result carries the source date + a "may be newer
 * information; confirm with a local attorney" disclaimer, and warnings are
 * always phrased as "looks like it may…".
 *
 * No legal logic is hard-coded here — code only does data lookup + numeric
 * comparison against the catalog's rule_kind/threshold. The legal content
 * lives entirely as verified, cited DATA.
 */

import { query } from '../db'

/** Canonical unit + label per known topic. The catalog's `topic` strings
 *  match these keys; a value passed to checkCompliance must be in this unit. */
export const STATE_LAW_TOPICS = {
  entry_notice_hours: { unit: 'hours', label: 'advance notice before entry' },
  deposit_max_months: { unit: 'months of rent', label: 'security-deposit maximum' },
  deposit_return_days: { unit: 'days', label: 'deposit-return window' },
  late_fee_grace_days: { unit: 'days', label: 'late-fee grace period' },
  late_fee_max_pct: { unit: '% of rent', label: 'maximum late fee' },
  late_fee: { unit: 'per day', label: 'late fee' },
  notice_to_vacate_days: { unit: 'days', label: 'notice to vacate' },
} as const
export type StateLawTopic = keyof typeof STATE_LAW_TOPICS

export interface ActRow {
  id: string
  state_code: string
  act_key: string
  act_name: string
  unit_types: string[]
  official_url: string | null
  summary: string | null
  source_date: string
  effective_year: number
}

export interface ProvisionRow {
  id: string
  topic: string
  rule_kind: 'min' | 'max' | 'required' | 'info'
  threshold_numeric: string | null
  threshold_unit: string | null
  summary: string
  statute_citation: string | null
  source_url: string | null
  source_date: string
  effective_year: number
}

/**
 * The standing posture (Nic, S442): GAM RETRIEVES statute text and gives NO
 * guidance — the user compares it to their own situation, checks for newer
 * law, and consults an attorney. This disclaimer is attached to anything the
 * catalog surfaces.
 */
export function buildDisclaimer(sourceDate: string | null | undefined): string {
  const asOf = sourceDate ? ` as of ${String(sourceDate).slice(0, 10)}` : ''
  return `GAM provides this as legal information only — not legal advice, and GAM offers no opinion on whether you comply. Read the statute yourself, compare it to what you're trying to do, check whether a newer version exists, and consult a licensed attorney in your state. This reflects GAM's records${asOf} and may be out of date.`
}

/** The landlord/tenant acts that govern this unit type in this state, latest
 *  effective year first. Empty when the catalog has no entry yet. */
export async function getApplicableActs(stateCode: string, unitType: string): Promise<ActRow[]> {
  const st = String(stateCode || '').trim().toUpperCase()
  if (st.length !== 2 || !unitType) return []
  return query<ActRow>(
    `SELECT id, state_code, act_key, act_name, unit_types, official_url, summary, source_date, effective_year
       FROM state_landlord_tenant_acts
      WHERE state_code = $1 AND $2 = ANY(unit_types)
      ORDER BY effective_year DESC, act_name`,
    [st, unitType]
  )
}

/** All provisions belonging to the given acts (for "what laws apply to my unit?"). */
export async function getProvisionsForActIds(actIds: string[]): Promise<(ProvisionRow & { act_id: string })[]> {
  if (!actIds.length) return []
  return query<ProvisionRow & { act_id: string }>(
    `SELECT id, act_id, topic, rule_kind, threshold_numeric, threshold_unit, summary,
            statute_citation, source_url, source_date, effective_year
       FROM state_law_provisions
      WHERE act_id = ANY($1)
      ORDER BY topic`,
    [actIds]
  )
}

/** The most-recent provision for (state, topic), or null if uncatalogued. */
export async function getLatestProvision(stateCode: string, topic: StateLawTopic): Promise<ProvisionRow | null> {
  const st = String(stateCode || '').trim().toUpperCase()
  if (st.length !== 2) return null
  const rows = await query<ProvisionRow>(
    `SELECT id, topic, rule_kind, threshold_numeric, threshold_unit, summary,
            statute_citation, source_url, source_date, effective_year
       FROM state_law_provisions
      WHERE state_code = $1 AND topic = $2
      ORDER BY effective_year DESC
      LIMIT 1`,
    [st, topic]
  )
  return rows[0] ?? null
}

export interface SectionTextHit {
  act_key: string
  section_number: string
  section_title: string | null
  full_text: string
  source_url: string | null
  source_date: string
  rank: number
}

/**
 * Full-text search over the verbatim statute corpus for a state — lets the
 * agent answer OBSCURE questions by pulling the actual relevant section(s).
 * Uses Postgres websearch_to_tsquery against the GIN-indexed tsvector; no
 * embedding-server dependency. Empty for unsourced states / too-short query.
 */
export async function searchStateLawText(stateCode: string, queryText: string, limit = 4): Promise<SectionTextHit[]> {
  const st = String(stateCode || '').trim().toUpperCase()
  const q = String(queryText || '').trim()
  if (st.length !== 2 || q.length < 2) return []
  return query<SectionTextHit>(
    `SELECT act_key, section_number, section_title, full_text, source_url, source_date,
            ts_rank(search_tsv, websearch_to_tsquery('english', $2)) AS rank
       FROM state_law_section_texts
      WHERE state_code = $1 AND search_tsv @@ websearch_to_tsquery('english', $2)
      ORDER BY rank DESC, section_number
      LIMIT $3`,
    [st, q, Math.min(Math.max(Math.trunc(limit) || 4, 1), 8)]
  )
}

export interface LawFlag {
  topic: string
  message: string
  citation: string | null
  sourceUrl: string | null
  sourceDate: string
  disclaimer: string
}

/**
 * OBJECTIVE, factual comparison of a value (in the topic's canonical unit)
 * against the catalogued statutory figure (Nic S442: an obvious numeric or
 * timeline mismatch — a late fee, deposit amount, notice period — may be
 * flagged factually; that is NOT legal advice). Returns a hedged, FACTUAL
 * mismatch flag when the number is above a 'max' figure or below a 'min'
 * figure — never a legal conclusion (no "you're in violation", no "should").
 * Null when the value is within range, the topic is uncatalogued, or the rule
 * isn't directional (no false alarms, no interpretation). Pure number compare.
 */
export async function checkAgainstStatute(
  stateCode: string,
  topic: StateLawTopic,
  value: number
): Promise<LawFlag | null> {
  const p = await getLatestProvision(stateCode, topic)
  if (!p || p.threshold_numeric == null) return null
  if (p.rule_kind !== 'min' && p.rule_kind !== 'max') return null // only directional figures
  const threshold = Number(p.threshold_numeric)
  if (!Number.isFinite(threshold) || !Number.isFinite(value)) return null

  let dir = ''
  if (p.rule_kind === 'min' && value < threshold) dir = 'below'
  else if (p.rule_kind === 'max' && value > threshold) dir = 'above'
  if (!dir) return null

  const st = String(stateCode).toUpperCase()
  const unit = p.threshold_unit || STATE_LAW_TOPICS[topic]?.unit || ''
  const label = STATE_LAW_TOPICS[topic]?.label ?? String(topic).replace(/_/g, ' ')
  const cite = p.statute_citation ? ` (${p.statute_citation})` : ''
  return {
    topic: String(topic),
    message: `Heads up — the ${label} of ${value} ${unit} is ${dir} the ${threshold} ${unit} listed in ${st} law${cite}. That's a factual comparison, not legal advice: the law may have changed, so check the current version and consider consulting an attorney.`,
    citation: p.statute_citation,
    sourceUrl: p.source_url,
    sourceDate: p.source_date,
    disclaimer: buildDisclaimer(p.source_date),
  }
}
