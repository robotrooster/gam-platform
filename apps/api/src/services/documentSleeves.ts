/**
 * S652 — SLEEVES AND CARDS.
 *
 * Nic: "if I upload my Arizona property and twelve documents are anticipated,
 * that shows twelve blanks. The landlord can just upload into spots they want to
 * use. They're not required to use the blank spots. But that hint of hey,
 * there's more things to upload is there." The SLEEVE is the slot (one state,
 * the kinds of space it is for, what goes in it); the CARD is the template that
 * fills it.
 *
 * A landlord sees the sleeves for the states they hold property in, narrowed to
 * the unit types they actually run there — "as soon as somebody uploads a
 * property in Texas, boom, the Texas documents show up." Government forms from
 * the library appear as sleeves that come already filled. Nothing here says a
 * document is required; an empty sleeve is simply empty.
 */
import { AppError } from '../middleware/errorHandler'
import { NOTICES_WHEN_IT_HAPPENS } from '@gam/shared'

type Exec = { query: (sql: string, params: any[]) => Promise<{ rows: any[] }> }

/**
 * Which heading a sleeve sits under on the Templates page. Nic: "maybe we break
 * it down... some of them say RV or mobile home or campsites... it needs more
 * organization." So a state's sleeves are grouped by what they are for:
 * the leases and contracts, then the documents for every rental, then those for
 * mobile home lots, RV and camp sites, and storage — the kind of space the act
 * that put the sleeve there governs.
 */
// Nic: free government versions go "underneath all of that" — last.
export const SLEEVE_GROUPS = ['contracts', 'all_rentals', 'mobile_home_lots', 'rv_sites', 'storage', 'notices_later', 'government'] as const
export function groupOf(kind: string, unitTypes: string[], disclosureType?: string | null): typeof SLEEVE_GROUPS[number] {
  if (kind === 'lease' || kind === 'sale_contract') return 'contracts'
  // Sent when something happens, never handed over at signing — their own
  // heading, and packages leave them out.
  if (disclosureType && (NOTICES_WHEN_IT_HAPPENS as readonly string[]).includes(disclosureType)) return 'notices_later'
  if (unitTypes.length === 1 && unitTypes[0] === 'mobile_home') return 'mobile_home_lots'
  if (unitTypes.includes('rv_spot') || unitTypes.includes('campsite')) return 'rv_sites'
  if (unitTypes.length === 1 && unitTypes[0] === 'storage') return 'storage'
  return 'all_rentals'
}

/** Where a landlord operates: state → the unit types they run there. */
export async function operatingFootprint(q: Exec, landlordIds: string[]) {
  const rows = await q.query(
    `SELECT p.state, array_agg(DISTINCT u.unit_type) FILTER (WHERE u.unit_type IS NOT NULL) AS unit_types
       FROM properties p
       LEFT JOIN units u ON u.property_id = p.id AND u.retired_at IS NULL
      WHERE p.landlord_id = ANY($1::uuid[]) AND p.state IS NOT NULL
      GROUP BY p.state ORDER BY p.state`, [landlordIds]).then(r => r.rows)
  return new Map<string, string[]>(rows.map((r: any) => [r.state, r.unit_types ?? []]))
}

/**
 * Which sleeve a template belongs in, from what it already says about itself.
 * Its state is its own tag, else its property's, else the landlord's only
 * state. No confident answer returns null: the template stays under "Other
 * documents" rather than being filed somewhere a landlord did not put it.
 */
export async function sleeveForTemplate(q: Exec, templateId: string): Promise<string | null> {
  const t = await q.query(
    `SELECT t.*, p.state AS property_state FROM lease_templates t
       LEFT JOIN properties p ON p.id = t.property_id WHERE t.id = $1`, [templateId]).then(r => r.rows[0])
  if (!t || t.library_document_id) return null
  let state: string | null = t.state_code || t.property_state || null
  if (!state) {
    const states = await q.query(
      `SELECT DISTINCT state FROM properties WHERE landlord_id = $1 AND state IS NOT NULL`, [t.landlord_id])
      .then(r => r.rows.map((x: any) => x.state))
    if (states.length === 1) state = states[0]
  }
  if (!state) return null

  let key: string | null = null
  if (t.purpose === 'lease' && t.unit_type) key = `lease:${state}:${t.unit_type}`
  else if (t.purpose === 'installment_sale') key = `sale:${state}:mobile_home`
  if (key) {
    const s = await q.query(`SELECT id FROM document_sleeves WHERE sleeve_key=$1 AND retired_at IS NULL`, [key]).then(r => r.rows[0])
    return s?.id ?? null
  }
  if (t.disclosure_type) {
    const s = await q.query(
      `SELECT id FROM document_sleeves
        WHERE state_code=$1 AND disclosure_type=$2 AND retired_at IS NULL
          AND ($3::text IS NULL OR $3 = ANY(unit_types))
        ORDER BY sort_order LIMIT 1`, [state, t.disclosure_type, t.unit_type]).then(r => r.rows[0])
    return s?.id ?? null
  }
  return null
}

/** File a template into its sleeve if it has none yet. Returns the sleeve id. */
export async function placeTemplate(q: Exec, templateId: string): Promise<string | null> {
  const sleeveId = await sleeveForTemplate(q, templateId)
  if (sleeveId) {
    await q.query(`UPDATE lease_templates SET sleeve_id=$2 WHERE id=$1 AND sleeve_id IS NULL`, [templateId, sleeveId])
  }
  return sleeveId
}

/**
 * The fields a template takes from the sleeve it is uploaded into. Uploading
 * "into" Arizona: RV Spot Lease means it IS an RV spot lease for Arizona —
 * the landlord does not also have to say so.
 */
export async function sleeveDefaults(q: Exec, sleeveId: string) {
  const s = await q.query(`SELECT * FROM document_sleeves WHERE id=$1 AND retired_at IS NULL`, [sleeveId]).then(r => r.rows[0])
  if (!s) throw new AppError(404, 'That document slot does not exist')
  return {
    sleeveId: s.id as string,
    purpose: s.purpose as string,
    unitType: s.unit_types.length === 1 ? s.unit_types[0] as string : null,
    stateCode: s.state_code as string,
    disclosureType: s.disclosure_type as string | null,
    appliesTo: s.applies_to as string,
  }
}

/**
 * Everything the Templates page shows, grouped by state, in catalog order.
 * Each state lists its sleeves — filled or not — for the unit types the
 * landlord runs there, with the government forms for that state (and Federal)
 * as sleeves that come filled. Templates that fit no sleeve come back as
 * `other`, so nothing a landlord uploaded ever disappears.
 */
export async function sleevesForLandlord(q: Exec, landlordIds: string[]) {
  const footprint = await operatingFootprint(q, landlordIds)
  const states = [...footprint.keys()]
  const allUnits = [...new Set([...footprint.values()].flat())]

  const sleeves = await q.query(
    `SELECT * FROM document_sleeves
      WHERE state_code = ANY($1::text[]) AND retired_at IS NULL
      ORDER BY state_code, sort_order, title`, [states]).then(r => r.rows)

  const cards = await q.query(
    `SELECT t.id, t.name, t.sleeve_id, t.purpose, t.unit_type, t.is_unit_type_default,
            t.page_count, p.name AS property_name,
            (SELECT count(*) FROM lease_template_fields f WHERE f.template_id = t.id)::int AS field_count
       FROM lease_templates t LEFT JOIN properties p ON p.id = t.property_id
      WHERE t.landlord_id = ANY($1::uuid[]) AND t.is_active AND t.library_document_id IS NULL
      ORDER BY lower(t.name)`, [landlordIds]).then(r => r.rows)

  const coverings = await q.query(
    `SELECT c.sleeve_id, t.id AS template_id, t.name, c.source, c.evidence
       FROM sleeve_coverings c JOIN lease_templates t ON t.id = c.template_id AND t.is_active
      WHERE c.landlord_id = ANY($1::uuid[])`, [landlordIds]).then(r => r.rows)
  // Several documents can cover one sleeve — Nic's two properties each have a
  // lease, and the owner disclosure is inside both.
  const coveredBy = new Map<string, Array<{ templateId: string; name: string; source: string; evidence: string | null }>>()
  for (const c of coverings as any[]) {
    const list = coveredBy.get(c.sleeve_id) ?? []
    list.push({ templateId: c.template_id, name: c.name, source: c.source, evidence: c.evidence })
    coveredBy.set(c.sleeve_id, list)
  }

  const library = await q.query(
    `SELECT d.*, t.id AS adopted_template_id,
            (SELECT count(*) FROM lease_template_fields f WHERE f.template_id = t.id)::int AS adopted_field_count
       FROM disclosure_library_documents d
       LEFT JOIN LATERAL (
         -- S652: ONE copy per form per viewer. An account can reach several
         -- companies (Blu is an owner-member of Oak Park as well as his own), and
         -- each company may hold its own copy; joining every copy listed the same
         -- federal form twice. Prefer the copy of a company that operates in the
         -- form's state, then the oldest.
         SELECT t.id, t.landlord_id FROM lease_templates t
          WHERE t.library_document_id = d.id AND t.landlord_id = ANY($1::uuid[]) AND t.is_active
          ORDER BY EXISTS (SELECT 1 FROM properties p WHERE p.landlord_id = t.landlord_id AND p.state = d.jurisdiction) DESC,
                   t.created_at
          LIMIT 1) t ON true
      WHERE d.retired_at IS NULL AND d.superseded_by_id IS NULL
        AND (d.jurisdiction = 'US' OR d.jurisdiction = ANY($2::text[]))
        AND (d.unit_types IS NULL OR d.unit_types && $3::text[])
      ORDER BY lower(d.name)`, [landlordIds, states, allUnits]).then(r => r.rows)

  const govSleeve = (d: any) => ({
    id: `library:${d.id}`, kind: 'government', group: 'government', title: d.name, appliesTo: d.applies_to,
    unitTypes: d.unit_types, libraryDocumentId: d.id, publishedBy: d.source_name, pdfUrl: d.base_pdf_url,
    cards: d.adopted_template_id
      ? [{ templateId: d.adopted_template_id, name: d.name, fieldCount: d.adopted_field_count, pageCount: d.page_count }]
      : [],
    filled: true,
  })

  const placed = new Set<string>()
  const byState = states.map(st => {
    const units = footprint.get(st) ?? []
    const mine = sleeves.filter((s: any) => s.state_code === st && s.unit_types.some((u: string) => units.includes(u)))
    // S652 — a state's own version of this document. Nic: "say a state
    // specifically provided a generic lease for an apartment — that would be in
    // the apartment lease [sleeve]." Same state, same kind of document, a space
    // it was written for; a lease sleeve matches the state's model lease.
    const freeFor = (s: any) => library.find((d: any) =>
      d.jurisdiction === st
      && (s.kind === 'lease' ? d.purpose === 'lease' : (d.purpose !== 'lease' && d.disclosure_type === s.disclosure_type))
      && (!d.unit_types || d.unit_types.some((u: string) => s.unit_types.includes(u)))
      && (s.applies_to === 'any' || d.applies_to === 'any' || d.applies_to === s.applies_to))
    const rows = mine.map((s: any) => {
      const c = cards.filter((x: any) => x.sleeve_id === s.id)
      const free = freeFor(s)
      c.forEach((x: any) => placed.add(x.id))
      return {
        id: s.id, kind: s.kind, title: s.title, unitTypes: s.unit_types, appliesTo: s.applies_to,
        cards: c.map((x: any) => ({
          templateId: x.id, name: x.name, propertyName: x.property_name,
          fieldCount: x.field_count, pageCount: x.page_count, isUnitTypeDefault: x.is_unit_type_default,
          purpose: x.purpose, unitType: x.unit_type,
        })),
        coveredBy: c.length ? [] : (coveredBy.get(s.id) ?? []),
        // A government version fills the sleeve until the landlord puts their
        // own in it — Nic: "automatically have the government drafted ones."
        freeVersion: free ? {
          libraryDocumentId: free.id, title: free.name, publishedBy: free.source_name, pdfUrl: free.base_pdf_url,
          templateId: free.adopted_template_id ?? null,
        } : null,
        filled: c.length > 0 || coveredBy.has(s.id) || !!free,
        group: groupOf(s.kind, s.unit_types, s.disclosure_type),
      }
    })
    // Leases first, then a sale contract, then the government's forms, then
    // the documents a landlord writes — the numbering follows this order.
    const leases = rows.filter((r: any) => r.kind === 'lease')
    const sales = rows.filter((r: any) => r.kind === 'sale_contract')
    const docs = rows.filter((r: any) => r.kind === 'disclosure')
    const gov = library.filter((d: any) => d.jurisdiction === st).map(govSleeve)
    const groupRank = (g: string) => SLEEVE_GROUPS.indexOf(g as any)
    const docsByGroup = [...docs].sort((a: any, b: any) => groupRank(a.group) - groupRank(b.group))
    const ordered = [...leases, ...sales, ...docsByGroup, ...gov].map((r, i) => ({ ...r, number: i + 1 }))
    return { state: st, unitTypes: units, sleeves: ordered,
             filled: ordered.filter(r => r.filled).length, total: ordered.length }
  })

  const federal = library.filter((d: any) => d.jurisdiction === 'US').map(govSleeve)
    .map((r: any, i: number) => ({ ...r, number: i + 1 }))
  const other = cards.filter((x: any) => !placed.has(x.id)).map((x: any) => ({
    templateId: x.id, name: x.name, propertyName: x.property_name, fieldCount: x.field_count,
    pageCount: x.page_count, isUnitTypeDefault: x.is_unit_type_default, purpose: x.purpose, unitType: x.unit_type,
  }))
  return { states: byState, federal, other }
}

/**
 * Say which of the landlord's own documents already contain this sleeve's
 * document — Blu's park rules are Exhibit B of his lease; Nic's owner disclosure
 * is inside both of his mobile home leases. Replaces the whole set; an empty set
 * uncovers it. Only a DOCUMENT sleeve can be covered: a lease or a sale contract
 * is its own document and nothing else stands in for it. Refuses documents that
 * are not theirs and sleeves outside the states they operate in.
 */
export async function setSleeveCoverings(q: Exec, landlordIds: string[], sleeveId: string, templateIds: string[]) {
  const s = await q.query(
    `SELECT s.id, s.kind, s.disclosure_type FROM document_sleeves s
      WHERE s.id=$1 AND s.retired_at IS NULL
        AND s.state_code IN (SELECT state FROM properties WHERE landlord_id = ANY($2::uuid[]) AND state IS NOT NULL)`,
    [sleeveId, landlordIds]).then(r => r.rows[0])
  if (!s) throw new AppError(404, 'That document slot is not one of yours')
  if (s.kind !== 'disclosure') throw new AppError(400, 'A lease or sale contract is its own document — upload it into its slot')
  if ((NOTICES_WHEN_IT_HAPPENS as readonly string[]).includes(s.disclosure_type)) {
    throw new AppError(400, 'A notice sent when something happens cannot already be inside another document')
  }
  const ids = [...new Set(templateIds)]
  const owned = ids.length ? await q.query(
    `SELECT id, landlord_id FROM lease_templates WHERE id = ANY($1::uuid[]) AND landlord_id = ANY($2::uuid[]) AND is_active`,
    [ids, landlordIds]).then(r => r.rows) : []
  if (owned.length !== ids.length) throw new AppError(404, 'One of those documents is not one of yours')
  // Keep the ones already there as they were (an automatic one stays automatic,
  // so next year's re-read can still un-tick it); drop what was un-ticked; add
  // new ticks as the landlord's own.
  await q.query(
    `DELETE FROM sleeve_coverings WHERE sleeve_id=$1 AND landlord_id = ANY($2::uuid[])
        AND NOT (template_id = ANY($3::uuid[]))`, [sleeveId, landlordIds, owned.map((t: any) => t.id)])
  for (const t of owned) {
    await q.query(
      `INSERT INTO sleeve_coverings (landlord_id, sleeve_id, template_id, source) VALUES ($1,$2,$3,'manual')
       ON CONFLICT (landlord_id, sleeve_id, template_id) DO NOTHING`, [t.landlord_id, sleeveId, t.id])
  }
}
