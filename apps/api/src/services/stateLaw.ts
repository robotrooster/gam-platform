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
import { LAW_CATEGORY_VALUES, type LawCategory, type PropertyTaxTopic } from '@gam/shared'

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

/**
 * Formal statutory citation prefix per state for the full-text corpus (the
 * provisions table already carries its own statute_citation; the corpus does
 * not, so the search tool builds one). Section numbers embed their chapter —
 * AZ "33-1343", NV "118A.330", CA "1950.5", FL "83.49" — so the prefix is all
 * that's needed. Falls back to "<STATE> §" for states not yet mapped.
 * NOTE: CA assumes the Civil Code (the only code currently in the CA corpus).
 * If CCP (unlawful detainer) or another code is added for CA, make this
 * act/code-aware rather than per-state.
 */
const STATE_CITATION: Record<string, (n: string) => string> = {
  AZ: (n) => `A.R.S. § ${n}`,
  NV: (n) => `NRS ${n}`,
  CA: (n) => `Cal. Civ. Code § ${n}`,
  FL: (n) => `Fla. Stat. § ${n}`,
  OH: (n) => `Ohio Rev. Code § ${n}`,
  NC: (n) => `N.C. Gen. Stat. § ${n}`,
  MI: (n) => `MCL § ${n}`,
  VA: (n) => `Va. Code § ${n}`,
  WA: (n) => `RCW ${n}`,
  MO: (n) => `Mo. Rev. Stat. § ${n}`,
  // NY spans four landlord/tenant laws with DISTINCT citation prefixes, so the
  // bare section number isn't self-citing. The ingested ranges don't overlap
  // (RPL 220-238, RPAPL 701-768, GOL 7-1xx, ETPA 1-14), so we resolve the law
  // from the number shape. Extend this if more NY laws (e.g. MDW) are ingested.
  NY: (n) => {
    const s = n.trim()
    if (/^7-1\d\d/.test(s)) return `N.Y. Gen. Oblig. Law § ${s}` // GOL deposits 7-101..7-109
    if (/^7[0-6]\d/.test(s)) return `N.Y. Real Prop. Acts. Law § ${s}` // RPAPL 701-768
    if (/^2[23]\d/.test(s)) return `N.Y. Real Prop. Law § ${s}` // RPL 220-238 (Landlord & Tenant)
    if (/^\d{1,2}(-[A-Z])?$/.test(s)) return `N.Y. Emerg. Tenant Prot. Act § ${s}` // ETPA 1-14
    return `N.Y. § ${s}`
  },
  // MA omitted on purpose: a proper cite is "Mass. Gen. Laws ch. 186, § 15B",
  // but the corpus stores only the per-chapter section number ("15B") — citing
  // needs the chapter (derivable from act_key). Falls back to "MA § 15B" until
  // citationFor is made act/chapter-aware.
}
export function citationFor(stateCode: string, sectionNumber: string): string {
  const st = String(stateCode || '').trim().toUpperCase()
  const n = String(sectionNumber || '').trim()
  return STATE_CITATION[st]?.(n) ?? `${st} § ${n}`
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
/**
 * Full-text search the verbatim statute corpus for ONE law_category. Strategy:
 *  1. Recall via OR — websearch_to_tsquery ANDs every term, so a verbose
 *     question ("can my landlord keep my security deposit") matched ZERO
 *     sections; we also build an OR variant (& -> |) and rank full-AND matches
 *     first (precision when exact, recall fill otherwise).
 *  2. Length-normalized rank (ts_rank flag 1) so one huge section (NY §233 at
 *     ~50 KB) can't dominate every query by sheer word count.
 *  3. Dedup by verbatim text — the same section is often filed under >1 act_key
 *     (act_key isn't returned), so byte-identical copies would waste slots.
 */
async function searchLawTextByCategory(
  st: string,
  q: string,
  limit: number,
  category: LawCategory
): Promise<SectionTextHit[]> {
  return query<SectionTextHit>(
    `WITH tq AS (
       SELECT websearch_to_tsquery('english', $2) AS and_q,
              replace(websearch_to_tsquery('english', $2)::text, '&', '|')::tsquery AS or_q
     ),
     matches AS (
       SELECT s.act_key, s.section_number, s.section_title, s.full_text, s.source_url, s.source_date,
              ts_rank(s.search_tsv, tq.and_q, 1) AS and_rank,
              ts_rank(s.search_tsv, tq.or_q, 1) AS or_rank
         FROM state_law_section_texts s, tq
        WHERE s.state_code = $1 AND s.law_category = $4 AND s.search_tsv @@ tq.or_q
     ),
     deduped AS (
       SELECT DISTINCT ON (md5(full_text))
              act_key, section_number, section_title, full_text, source_url, source_date, and_rank, or_rank
         FROM matches
        ORDER BY md5(full_text), (and_rank > 0) DESC, and_rank DESC, or_rank DESC, section_number
     )
     SELECT act_key, section_number, section_title, full_text, source_url, source_date,
            GREATEST(and_rank, or_rank) AS rank
       FROM deduped
      ORDER BY (and_rank > 0) DESC, and_rank DESC, or_rank DESC, section_number
      LIMIT $3`,
    [st, q, Math.min(Math.max(Math.trunc(limit) || 4, 1), 8), category]
  )
}

/** Landlord/tenant statute retrieval — the live CS-agent surface (search_state_law). */
export async function searchStateLawText(stateCode: string, queryText: string, limit = 4): Promise<SectionTextHit[]> {
  const st = String(stateCode || '').trim().toUpperCase()
  const q = String(queryText || '').trim()
  if (st.length !== 2 || q.length < 2) return []
  return searchLawTextByCategory(st, q, limit, 'landlord_tenant')
}

/** Property-tax statute retrieval — for the property-tax feature (43 states ingested). */
export async function searchPropertyTaxText(stateCode: string, queryText: string, limit = 4): Promise<SectionTextHit[]> {
  const st = String(stateCode || '').trim().toUpperCase()
  const q = String(queryText || '').trim()
  if (st.length !== 2 || q.length < 2) return []
  return searchLawTextByCategory(st, q, limit, 'property_tax')
}

/**
 * Generic real-estate statute retrieval by law_category — backend for future
 * investor/agent surfaces over the broad corpus (conveyancing_title, condo_coop,
 * broker_licensing, mortgage_lien_foreclosure, general_real_property, …). Returns
 * [] for an unknown category. (searchStateLawText / searchPropertyTaxText are the
 * named convenience wrappers for the two live domains.)
 */
export async function searchRealEstateLaw(
  stateCode: string,
  queryText: string,
  category: string,
  limit = 4
): Promise<SectionTextHit[]> {
  const st = String(stateCode || '').trim().toUpperCase()
  const q = String(queryText || '').trim()
  const cat = String(category || '').trim()
  if (st.length !== 2 || q.length < 2) return []
  if (!(LAW_CATEGORY_VALUES as readonly string[]).includes(cat)) return []
  return searchLawTextByCategory(st, q, limit, cat as LawCategory)
}

/** The populated real-estate categories beyond landlord/tenant (excludes the
 *  stubbed land_use_zoning / environmental_disclosure — those defer). */
export const REAL_ESTATE_SEARCH_CATEGORIES: readonly LawCategory[] = [
  'property_tax',
  'conveyancing_title',
  'condo_coop',
  'broker_licensing',
  'mortgage_lien_foreclosure',
  'general_real_property',
]

export interface RealEstateHit extends SectionTextHit {
  law_category: LawCategory
}

/**
 * Cross-category full-text search over the broad real-estate corpus (all the
 * non-landlord/tenant, non-stubbed categories at once), labeling each hit with
 * its law_category so the agent can say which area it's from. Same OR-recall +
 * length-normalized + dedup strategy as searchLawTextByCategory.
 */
export async function searchRealEstateCorpus(stateCode: string, queryText: string, limit = 5): Promise<RealEstateHit[]> {
  const st = String(stateCode || '').trim().toUpperCase()
  const q = String(queryText || '').trim()
  if (st.length !== 2 || q.length < 2) return []
  return query<RealEstateHit>(
    `WITH tq AS (
       SELECT websearch_to_tsquery('english', $2) AS and_q,
              replace(websearch_to_tsquery('english', $2)::text, '&', '|')::tsquery AS or_q
     ),
     matches AS (
       SELECT s.law_category, s.act_key, s.section_number, s.section_title, s.full_text, s.source_url, s.source_date,
              ts_rank(s.search_tsv, tq.and_q, 1) AS and_rank,
              ts_rank(s.search_tsv, tq.or_q, 1) AS or_rank
         FROM state_law_section_texts s, tq
        WHERE s.state_code = $1 AND s.law_category = ANY($4) AND s.search_tsv @@ tq.or_q
     ),
     deduped AS (
       SELECT DISTINCT ON (md5(full_text))
              law_category, act_key, section_number, section_title, full_text, source_url, source_date, and_rank, or_rank
         FROM matches
        ORDER BY md5(full_text), (and_rank > 0) DESC, and_rank DESC, or_rank DESC, section_number
     )
     SELECT law_category, act_key, section_number, section_title, full_text, source_url, source_date,
            GREATEST(and_rank, or_rank) AS rank
       FROM deduped
      ORDER BY (and_rank > 0) DESC, and_rank DESC, or_rank DESC, section_number
      LIMIT $3`,
    [st, q, Math.min(Math.max(Math.trunc(limit) || 5, 1), 8), REAL_ESTATE_SEARCH_CATEGORIES as unknown as string[]]
  )
}

export interface PropertyTaxProvisionRow {
  topic: PropertyTaxTopic
  subtype: string | null
  summary: string
  params: Record<string, unknown>
  statute_citation: string | null
  source_url: string | null
  source_date: string
  effective_year: number
}

/**
 * The latest-year STRUCTURED property-tax facts for a state (exemptions,
 * assessment-appeal deadline, payment, redemption …). Returns the most recent
 * effective_year's rows only (annual-refresh inserts new years; we never show a
 * stale year alongside the current one). Empty for uncatalogued states. The
 * feature reads `params` per the shared PropertyTax*Params shapes;
 * `params.locally_variable` flags state-framework-but-locally-set facts.
 */
export async function getPropertyTaxProvisions(stateCode: string): Promise<PropertyTaxProvisionRow[]> {
  const st = String(stateCode || '').trim().toUpperCase()
  if (st.length !== 2) return []
  return query<PropertyTaxProvisionRow>(
    `SELECT topic, subtype, summary, params, statute_citation, source_url, source_date, effective_year
       FROM state_property_tax_provisions
      WHERE state_code = $1
        AND jurisdiction_level = 'state'
        AND effective_year = (
          SELECT MAX(effective_year) FROM state_property_tax_provisions
           WHERE state_code = $1 AND jurisdiction_level = 'state'
        )
      ORDER BY topic, subtype NULLS FIRST`,
    [st]
  )
}

/**
 * Broad real-estate categories GAM has intentionally STUBBED — recognized but
 * not deeply ingested (zoning/land-use is partly municipal home-rule; disclosure
 * law overlaps habitability and is thin/shifting). When a question is clearly in
 * one of these areas AND the landlord/tenant corpus returns nothing, the agent
 * defers gracefully ("still gathering this; consult an attorney") rather than a
 * bare "not found" or guessing. Keep keys in sync with the stubbed
 * LAW_CATEGORY_VALUES; remove a category once it's truly ingested.
 * (property_tax is NOT stubbed — it's being ingested for a near-term GAM feature.)
 */
export const STUBBED_CATEGORY_LABELS: Record<string, string> = {
  land_use_zoning: 'zoning & land-use',
  environmental_disclosure: 'property-condition & environmental disclosure',
}
// Patterns are deliberately CONSERVATIVE: each must read as clearly zoning /
// sale-side-disclosure so a genuine landlord/tenant question is never hijacked
// into a defer. (Bare "lead paint" / "mold" / "asbestos" are omitted — in a
// rental those are habitability questions the L/T corpus should answer; we only
// catch them in an explicit *disclosure* phrasing.)
const STUB_PATTERNS: { category: keyof typeof STUBBED_CATEGORY_LABELS; re: RegExp }[] = [
  { category: 'land_use_zoning', re: /\b(zoning|rezon|variance|setback|land[- ]?use|subdivision|special use permit|conditional use|planning board|site plan|nonconforming use)\b/i },
  { category: 'environmental_disclosure', re: /\b(property condition disclosure|seller'?s? disclosure|disclosure statement|environmental disclosure|lead[- ]?based paint disclosure|radon disclosure|mold disclosure|asbestos disclosure|underground storage tank|brownfield|environmental site assessment)\b/i },
]
/** The stubbed real-estate category a question is about, or null. */
export function detectStubbedCategory(queryText: string): keyof typeof STUBBED_CATEGORY_LABELS | null {
  const q = String(queryText || '')
  for (const { category, re } of STUB_PATTERNS) if (re.test(q)) return category
  return null
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

/**
 * S483: lease state-law check composer. Wraps three calls to
 * checkAgainstStatute (deposit_max_months, late_fee_max_pct,
 * late_fee_grace_days) so lease PATCH and tenant GET share one
 * source of truth. Pass undefined for fields the caller doesn't
 * want checked — PATCH skips untouched fields, GET passes all
 * persisted values so the tenant sees the same warnings.
 *
 * Late-fee percent check fires only when type === 'percent_of_rent'
 * (flat-dollar fees aren't comparable to a percent cap).
 *
 * Returns [] when stateCode is null/undefined or no flags fire.
 * NEVER throws — best-effort wrapper around individual checks; any
 * single check failure logs but doesn't abort the others.
 */
export async function checkLeaseAgainstStateLaw(args: {
  stateCode:            string | null | undefined
  rentAmount:           number | null | undefined
  securityDepositAmount?: number | null
  lateFeeInitialAmount?: number | null
  lateFeeInitialType?:   'flat' | 'percent_of_rent' | null
  lateFeeGraceDays?:     number | null
}): Promise<LawFlag[]> {
  const out: LawFlag[] = []
  if (!args.stateCode) return out
  const state = args.stateCode

  // Deposit: dollars → months-of-rent ratio.
  if (
    args.securityDepositAmount != null &&
    args.rentAmount != null && args.rentAmount > 0
  ) {
    try {
      const months = Number(args.securityDepositAmount) / Number(args.rentAmount)
      const flag = await checkAgainstStatute(state, 'deposit_max_months', months)
      if (flag) out.push(flag)
    } catch { /* per-check failure swallowed; other checks continue */ }
  }

  // Late fee: only check percent type against the percent cap.
  if (
    args.lateFeeInitialAmount != null &&
    args.lateFeeInitialType === 'percent_of_rent'
  ) {
    try {
      const flag = await checkAgainstStatute(state, 'late_fee_max_pct', Number(args.lateFeeInitialAmount))
      if (flag) out.push(flag)
    } catch { /* swallowed */ }
  }

  // Grace period: state min vs configured value.
  if (args.lateFeeGraceDays != null) {
    try {
      const flag = await checkAgainstStatute(state, 'late_fee_grace_days', Number(args.lateFeeGraceDays))
      if (flag) out.push(flag)
    } catch { /* swallowed */ }
  }

  return out
}
