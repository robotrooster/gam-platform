/**
 * S652 — READ A LANDLORD'S OWN DOCUMENT AND SAY WHICH SLEEVES IT ALREADY FILLS.
 *
 * Nic: "I want it to auto-confirm based on uploaded leases. And that way it's
 * not sending people duplicate stuff accidentally... If somebody uploads a new
 * lease, have it reread on the upload... if I change my draft next year, and I
 * leave out some of the stuff that was auto selected on the first lease, it needs
 * to reread that and deselect the options that are no longer applicable, that way
 * I can upload my own separate form for that category."
 *
 * HOW IT READS. By SECTION HEADINGS first, because a heading is where a lease
 * says what it contains. Reading two real leases made the difference plain: Nic's
 * Oak Park lease MENTIONS its park rules ("acknowledges receipt of... Oak Park
 * Rules and Regulations") but the rules are a separate document; Blu's lease
 * CONTAINS them ("EXHIBIT B — PARK RULES"). A mention would have marked Nic's
 * rules as covered and they are not. A few documents are statements rather than
 * sections, and those have body signals: the "LANDLORD: ... P.O. Box 1206,
 * Yarnell" block at the top of a lease IS the owner name-and-address disclosure;
 * "Utilities ... will be charged separately" IS a utility-billing disclosure.
 *
 * WHAT IT NEVER READS FOR: notices sent when something happens (rent increase,
 * change of use, foreclosure...). A lease cannot contain a notice that has not
 * happened yet — NOTICES_WHEN_IT_HAPPENS.
 *
 * WHAT IT WRITES. Coverings with source 'auto' and the passage it found as
 * evidence. Every re-read REPLACES that document's auto coverings, so a section
 * taken out of next year's lease un-ticks itself. A covering the landlord ticked
 * ('manual') is never touched by a re-read.
 */
import fs from 'fs'
import path from 'path'
import { NOTICES_WHEN_IT_HAPPENS } from '@gam/shared'
import { resolveUploadPath } from '../lib/uploadPaths'
import { extractPositionedText } from '../lib/pdfText'

type Exec = { query: (sql: string, params: any[]) => Promise<{ rows: any[] }> }

const HEADING: Partial<Record<string, RegExp>> = {
  owner_agent_identity:     /owner.{0,25}disclosure|disclosure of (?:the )?(?:owner|agent|management)|owner(?:ship)? and (?:manager|management|agent)|(?:owner|manager|agent)s?['’]? (?:names?|information|identity)/i,
  security_deposit_terms:   /security deposit|^\s*deposits?\s*$/i,
  park_rules:               /park rules|community rules|rules and regulations/i,
  late_fee_policy:          /late (?:fee|charge|payment)/i,
  utility_billing_method:   /utilit(?:y|ies)/i,
  move_in_condition:        /move[- ]in|condition (?:report|checklist|statement)|inspection checklist/i,
  smoke_co_detector:        /smoke|carbon monoxide/i,
  bed_bugs:                 /bed ?bugs?/i,
  flood_zone:               /flood/i,
  mold:                     /\bmold\b|\bmould\b/i,
  radon:                    /radon/i,
  asbestos:                 /asbestos/i,
  meth_contamination:       /methamphetamine|meth lab/i,
  defective_drywall:        /drywall/i,
  military_ordnance:        /ordnance|munitions/i,
  domestic_violence_rights: /domestic violence/i,
  sex_offender_registry:    /sex offender|megan/i,
  screening_criteria:       /screening|selection criteria|rental criteria|qualifying criteria/i,
  smoking_policy:           /smok/i,
  insurance_requirement:    /insurance/i,
  assistance_animal:        /assistance animal|service animal|support animal/i,
  recycling_garbage:        /recycl/i,
  home_sale_on_lot:         /sale of (?:the |a )?(?:mobile |manufactured )?home|assignment and sale/i,
  park_statement_of_policy: /statement of policy|prospectus/i,
  statutory_acknowledgement:/acknowledg/i,
  zoning_designation:       /zoning/i,
  septic_system:            /septic/i,
  well_water:               /well water|private well/i,
  energy_efficiency:        /energy (?:efficiency|cost|usage)/i,
  certificate_of_occupancy: /certificate of occupancy/i,
  fire_damage:              /fire damage/i,
  death_on_premises:        /death on (?:the )?premises/i,
  property_condition:       /property condition|condition of (?:the )?(?:premises|property|dwelling)/i,
  rent_control:             /rent control|rent stabili/i,
  pest_control:             /pest control|pests?$/i,
  shared_utilities:         /master[- ]meter|shared utilit/i,
}

const BODY: Partial<Record<string, RegExp>> = {
  // "LANDLORD: <names/company> <P.O. Box or street address>"
  owner_agent_identity: /\b(?:landlord|owner|lessor|manager|management|agent)\s*(?:\(s\))?\s*:\s*[^:]{3,160}?\b(?:p\.?\s?o\.?\s+box|\d{2,6}\s+[A-Za-z0-9 .]{2,40}\b(?:street|st\.?|road|rd\.?|avenue|ave\.?|highway|hwy\.?|drive|dr\.?|lane|ln\.?|blvd\.?|way|u\.s\.))/i,
  utility_billing_method: /(?:charged|billed)\s+(?:to\s+(?:the\s+)?tenant\s+)?separately|submeter|sub-meter|ratio utility billing/i,
  shared_utilities: /master[- ]meter|not separately metered/i,
  statutory_acknowledgement: /acknowledg\w*\s+(?:the\s+)?receipt\s+of/i,
}

// A hazard the document keeps coming back to IS a section on it, even when the
// section is not laid out under a heading. Nic's Oak Park apartment lease has a
// bed-bug clause in its body and EPA's bed-bug flyer stapled to the back — the
// flyer's titles are Title Case, so no heading matched and the sleeve sat empty.
// Three mentions: a one-line "tenant shall report pests, mold..." never reaches it.
const REPEATED: Partial<Record<string, RegExp>> = {
  bed_bugs: /bed ?bugs?/gi,
  mold:     /\bmou?ld\b/gi,
  radon:    /\bradon\b/gi,
  asbestos: /\basbestos\b/gi,
}
const REPEATED_MIN = 3

type Line = { text: string; page: number }

/** A line reads as a heading: mostly capitals, or "N. Title:" / "EXHIBIT A — Title". */
function headingOf(text: string): string | null {
  const t = text.trim()
  if (t.length < 4 || t.length > 120) return null
  const numbered = t.match(/^(?:\d{1,2}|[A-Z])\.\s+([A-Z][A-Za-z ,'’&/\-]{2,70}?)(?::|\.\s|$)/)
  if (numbered) return numbered[1]
  const exhibit = t.match(/^(?:exhibit|attachment|schedule|addendum)\s+[A-Z0-9]+\s*[—–:\-]\s*(.{3,80})$/i)
  if (exhibit) return exhibit[1]
  const letters = t.replace(/[^A-Za-z]/g, '')
  if (letters.length >= 6 && letters === letters.toUpperCase() && /\s/.test(t)) return t
  return null
}

async function linesOf(pdfPath: string): Promise<Line[]> {
  const doc = await extractPositionedText(fs.readFileSync(pdfPath))
  const out: Line[] = []
  for (const p of doc.pages) {
    const rows = new Map<number, { x: number; text: string }[]>()
    for (const it of p.items) {
      if (!it.text.trim()) continue
      const y = Math.round(it.y / 2) * 2           // same baseline, give or take a point
      const row = rows.get(y) ?? []; row.push({ x: it.x, text: it.text }); rows.set(y, row)
    }
    ;[...rows.entries()].sort((a, b) => b[0] - a[0]).forEach(([, r]) =>
      out.push({ page: p.pageNumber, text: r.sort((a, b) => a.x - b.x).map(x => x.text).join(' ').replace(/\s+/g, ' ') }))
  }
  return out
}

export type Found = { disclosureType: string; evidence: string }

/** What a PDF contains, by the categories above. Notices-sent-later never. */
export async function readDocument(pdfPath: string): Promise<Found[]> {
  const lines = await linesOf(pdfPath)
  const body = lines.map(l => l.text).join(' ')
  const found = new Map<string, string>()
  for (const l of lines) {
    const h = headingOf(l.text)
    if (!h) continue
    for (const [cat, re] of Object.entries(HEADING)) {
      if (found.has(cat) || !re) continue
      if (re.test(h)) found.set(cat, `p.${l.page}: ${l.text.slice(0, 140)}`)
    }
  }
  for (const [cat, re] of Object.entries(BODY)) {
    if (found.has(cat) || !re) continue
    const m = body.match(re)
    if (m) found.set(cat, m[0].slice(0, 160))
  }
  for (const [cat, re] of Object.entries(REPEATED)) {
    if (found.has(cat) || !re) continue
    const hits = [...body.matchAll(re)]
    if (hits.length < REPEATED_MIN) continue
    const at = hits[0].index ?? 0
    found.set(cat, `mentioned ${hits.length} times: …${body.slice(Math.max(0, at - 50), at + 90).trim()}…`)
  }
  for (const n of NOTICES_WHEN_IT_HAPPENS) found.delete(n)
  return [...found.entries()].map(([disclosureType, evidence]) => ({ disclosureType, evidence }))
}

const uploadDir = () => path.join(process.cwd(), 'uploads', 'leases')

/**
 * Re-read one template and replace its automatic coverings. Safe to call on
 * every upload; never throws into its caller (a PDF that will not parse leaves
 * the coverings as they were and logs why).
 */
export async function detectCoverings(q: Exec, templateId: string): Promise<{ covered: string[]; error?: string }> {
  try {
    const t = await q.query(
      `SELECT t.*, p.state AS property_state, s.state_code AS sleeve_state
         FROM lease_templates t
         LEFT JOIN properties p ON p.id = t.property_id
         LEFT JOIN document_sleeves s ON s.id = t.sleeve_id
        WHERE t.id = $1`, [templateId]).then(r => r.rows[0])
    if (!t || t.library_document_id) return { covered: [] }

    // Take this document's automatic coverings away first — it is being re-read.
    await q.query(`DELETE FROM sleeve_coverings WHERE template_id=$1 AND source='auto'`, [templateId])
    if (!t.is_active || !t.base_pdf_url) return { covered: [] }

    const file = resolveUploadPath(uploadDir(), t.base_pdf_url)
    if (!file || !fs.existsSync(file)) return { covered: [], error: 'PDF not found on disk' }

    const state = t.sleeve_state || t.state_code || t.property_state || await q.query(
      `SELECT min(state) AS s FROM properties WHERE landlord_id=$1 AND state IS NOT NULL
        HAVING count(DISTINCT state) = 1`, [t.landlord_id]).then(r => r.rows[0]?.s ?? null)
    if (!state) return { covered: [] }

    const found = await readDocument(file)
    const covered: string[] = []
    for (const f of found) {
      const sleeves = await q.query(
        `SELECT id FROM document_sleeves
          WHERE state_code=$1 AND disclosure_type=$2 AND kind='disclosure' AND retired_at IS NULL
            AND ($3::text IS NULL OR $3 = ANY(unit_types))`,
        [state, f.disclosureType, t.unit_type]).then(r => r.rows)
      for (const s of sleeves) {
        await q.query(
          `INSERT INTO sleeve_coverings (landlord_id, sleeve_id, template_id, source, evidence)
           VALUES ($1,$2,$3,'auto',$4)
           ON CONFLICT (landlord_id, sleeve_id, template_id) DO NOTHING`,
          [t.landlord_id, s.id, templateId, f.evidence])
        covered.push(f.disclosureType)
      }
    }
    return { covered: [...new Set(covered)] }
  } catch (e: any) {
    console.error('[sleeveDetection] could not read template', templateId, e?.message)
    return { covered: [], error: e?.message }
  }
}
