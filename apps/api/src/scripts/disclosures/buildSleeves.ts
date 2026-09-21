/**
 * S652 — BUILD THE SLEEVE CATALOG FROM THE STATUTE CORPUS.
 *
 * Nic: "we need to have the card for every thing that could possibly be
 * required across all 50 states... every single document or thing that a
 * landlord would need to draft on their own." The corpus already holds every
 * state's landlord-tenant acts (state_law_section_texts, ~50k sections); this
 * reads it and writes document_sleeves.
 *
 * TWO KINDS OF SLEEVE
 *
 *   Leases — one per state per unit type, always. Every kind of space GAM rents
 *   needs a lease, and Nic's own example is three: "the lease for the mobile
 *   homes, the lease for RVs, the lease for apartments... three separate cards."
 *   Plus a home-sale contract for mobile homes, since GAM sells those.
 *
 *   Documents — one per state per topic, only where that state's acts have the
 *   LANDLORD tell or hand the tenant something about it. A topic is found in a
 *   section when its words and a telling/handing verb ("disclose", "notify",
 *   "furnish ... copy", "in writing", "post") sit close together — a section
 *   that says "the landlord shall remove garbage" is a duty, not a document, and
 *   does not make a sleeve. The section that DID is kept on the sleeve as its
 *   basis, never shown.
 *
 * WHICH SPACES a document sleeve is for comes from WHICH ACT the section is in:
 * a mobile-home-park act speaks to mobile home lots, an RV-park act to RV and
 * camp sites, the general residential act to apartments, houses and rented
 * homes. The same topic in two acts is two sleeves.
 *
 * NOT MADE INTO SLEEVES: topics a government agency supplies the document for
 * (lead paint, tenant-rights guides — those are the library, already filled),
 * and "copy of the lease", which is an act of handing over, not a document.
 *
 *     REPORT=IL,AZ npx ts-node src/scripts/disclosures/buildSleeves.ts   # print evidence, write nothing
 *     npx ts-node src/scripts/disclosures/buildSleeves.ts                # write the catalog
 */
import { query } from '../../db'
import { UNIT_TYPES, UNIT_TYPE_LABEL, US_STATE_NAME, DISCLOSURE_TYPES, DISCLOSURE_TYPE_LABEL } from '@gam/shared'

// ── which spaces each act governs ─────────────────────────────────────────
const ACT_UNITS: Record<string, string[]> = {
  residential:             ['apartment', 'single_family', 'mobile_home', 'hotel_room', 'land_lot'],
  general_landlord_tenant: ['apartment', 'single_family', 'mobile_home', 'hotel_room', 'land_lot'],
  general:                 ['apartment', 'single_family', 'mobile_home', 'hotel_room', 'land_lot'],
  mobile_home_park:        ['mobile_home'],
  manufactured_home_park:  ['mobile_home'],
  rv_park:                 ['rv_spot', 'campsite'],
  rv_long_term:            ['rv_spot', 'campsite'],
  self_storage:            ['storage'],
  // commercial: NOT mined. Commercial units get a lease sleeve; a business
  // tenancy has almost none of the hand-over duties a home does, and Illinois'
  // "commercial" act in the corpus is really eviction + residential sections
  // under another name, which put flood and sex-offender topics on shops.
}

// ── what turns a topic into a DOCUMENT ────────────────────────────────────
// The landlord having to TELL, HAND or SHOW the tenant something, in the same
// sentence as the topic. Two earlier passes taught the rules below:
//   - words merely near each other found "late fee" in a condo-demand section;
//   - "provide" alone matched "as provided in section 9"; "deliver" matched
//     "deliver to the buyer"; "shall not terminate utilities" is a prohibition.
// So the verb must reach a TENANT (or attach to the lease, or be posted), a
// negated duty does not count, and definitions sections are skipped.
const TENANT = String.raw`(?:(?:all|each|any|every)\s+of\s+the\s+|the\s+|each\s+|all\s+|any\s+|every\s+|its\s+|a\s+|his\s+|her\s+)?(?:(?:prospective|new|existing|current)\s+(?:and\s+(?:prospective|new|existing|current)\s+)?)?(?:tenant|resident|lessee|occupant|homeowner|applicant|renter)s?\b`
const HANDS: RegExp[] = [
  // "disclose ..." — disclosure is to the tenant unless it says otherwise
  /\bdisclos(?:e|es|ed|ure|ing)\b(?![^.;]{0,50}\bto\s+(?:the\s+)?(?:buyer|purchaser|director|department|court|commission|board|agency|lender))/i,
  // "notify / inform / advise the tenant"
  new RegExp(String.raw`\b(?:notify|notifies|notified|inform|informs|advise|advises)\b[^.;]{0,50}?${TENANT}`, 'i'),
  // "deliver / provide / furnish / give ... to the tenant"
  new RegExp(String.raw`\b(?:deliver|provide|furnish|give|supply|offer|distribute|mail|send|make\s+available)\w*\b[^.;]{0,140}?\bto\s+${TENANT}`, 'i'),
  // "provide the tenant with / a copy / written notice"
  new RegExp(String.raw`\b(?:provide|furnish|give|supply|offer)\w*\s+${TENANT}\s+(?:with|a\s+copy|a\s+written|written|notice|at\s+least)`, 'i'),
  // "attach ... to the rental agreement / lease"
  /\battach\w*\b[^.;]{0,90}\bto\s+(?:the\s+|each\s+)?(?:rental\s+agreement|lease|written\s+lease)/i,
  // "post ... in a conspicuous place / the office / common area"
  /\bpost\w*\b[^.;]{0,90}\b(?:conspicuous|common\s+area|office|clubhouse|bulletin)/i,
  // "the park owner shall give 90 days' notice of ..." - notice has one audience here
  new RegExp(String.raw`\b(?:landlord|lessor|owner|operator|management|manager|licensee)\b[^.;]{0,120}\b(?:shall|must)\b[^.;]{0,40}\b(?:give|provide|serve|send|mail|deliver)\w*\b[^.;]{0,40}\b(?:written\s+)?notice\b`, 'i'),
  // passive: "a copy ... was delivered by the park owner to the tenant"
  new RegExp(String.raw`\b(?:was|be|been|is|are)\s+(?:delivered|provided|furnished|given|disclosed|offered|mailed|sent|distributed)\b[^.;]{0,60}?\bto\s+${TENANT}`, 'i'),
]
const DUTY = /\b(?:shall|must|required|is\s+to|only\s+if|unless|prior\s+to|before)\b/i
const NEGATED = /\b(?:shall|must|may)\s+not\b|\bshall\s+refuse\b|\bno\s+landlord\s+shall\b/i
// The TENANT's duty ("the tenant must notify the park owner") is not a
// document the landlord hands over - unless the landlord is obliged too.
const TENANT_DUTY = /\b(?:tenant|resident|lessee|occupant|homeowner)s?\s+(?:shall|must)\b/i
const LANDLORD_DUTY = /\b(?:landlord|lessor|owner|operator|management|manager|licensee)\b[^.;]{0,120}\b(?:shall|must)\b/i
// "The park owner shall:" — a list whose items carry the duty down to them.
const LIST_DUTY = /\b(?:shall|must)\b[^.;:]{0,220}:\s*$/i

// ── the topics — words that mean it, per category ─────────────────────────
const TOPIC: Partial<Record<string, string>> = {
  owner_agent_identity:     String.raw`names?\s+and\s+(?:the\s+)?(?:street\s+|mailing\s+|business\s+)?address(?:es)?\s+of\s+(?:the\s+|all\s+|each\s+|any\s+)?(?:owner|landlord|lessor|manager|person|individual|agent|of\s+the\s+following)`,
  security_deposit_terms:   String.raw`security\s+deposit|damage\s+deposit`,
  park_rules:               String.raw`(?:park|community)\s+rules|rules\s+and\s+regulations`,
  late_fee_policy:          String.raw`late\s+(?:fee|charge|payment\s+(?:fee|charge))`,
  rent_increase_notice:     String.raw`increase\s+(?:in\s+)?(?:the\s+)?rent|rent\s+increase|increases?\s+in\s+rent`,
  entry_notice_policy:      String.raw`(?:right\s+(?:of|to)\s+)?(?:enter|entry|access\s+to)\s+(?:the\s+)?(?:dwelling|unit|premises|home|mobile\s+home)`,
  utility_billing_method:   String.raw`(?:submeter|sub-meter|allocat\w+\s+(?:of\s+)?(?:utility|water|sewer|electric)|utility\s+(?:bill|charge|cost)s?\s+(?:are|is|will\s+be)\s+(?:billed|allocated|calculated)|ratio\s+utility)`,
  shared_utilities:         String.raw`(?:master\s+meter|single\s+meter|common\s+meter|shared\s+meter|not\s+separately\s+metered)`,
  move_in_condition:        String.raw`(?:move-?in|inventory|condition)\s+(?:checklist|statement|report|form|inspection\s+(?:form|report))|checklist`,
  smoke_co_detector:        String.raw`smoke\s+(?:detector|alarm)|carbon\s+monoxide`,
  domestic_violence_rights: String.raw`domestic\s+violence|sexual\s+assault|stalking|dating\s+violence`,
  sex_offender_registry:    String.raw`sex\s+offender|sexual\s+offender`,
  flood_zone:               String.raw`flood(?:plain|\s+zone|\s+hazard|ing|ed)?`,
  mold:                     String.raw`\bmold\b|\bmould\b`,
  radon:                    String.raw`radon`,
  bed_bugs:                 String.raw`bed\s*bugs?`,
  asbestos:                 String.raw`asbestos`,
  meth_contamination:       String.raw`methamphetamine|clandestine\s+(?:drug\s+)?lab`,
  death_on_premises:        String.raw`(?:death|died|homicide|suicide)\s+(?:of\s+an?\s+occupant\s+)?(?:on|in|at)\s+the\s+(?:premises|property|dwelling|unit)`,
  foreclosure_status:       String.raw`foreclos`,
  utility_shutoff_rights:   String.raw`(?:shut\s*off|shutoff|terminat\w+|disconnect\w*|interrupt\w*)\s+(?:of\s+)?(?:the\s+)?(?:utility|utilities|water|electric\w*|gas|heat)`,
  home_sale_on_lot:         String.raw`(?:sell|sale\s+of)\s+(?:his\s+|her\s+|the\s+|a\s+|their\s+|its\s+)?(?:mobile|manufactured)\s+home(?!\s+(?:community|park))`,
  park_change_of_use:       String.raw`change\s+(?:in|of)\s+(?:the\s+)?use|park\s+closure|clos(?:e|ing|ure)\s+of\s+the\s+(?:park|community)`,
  park_statement_of_policy: String.raw`statement\s+of\s+policy|prospectus|disclosure\s+statement`,
  rent_control:             String.raw`rent\s+(?:control|stabiliz)`,
  insurance_requirement:    String.raw`(?:renter'?s|tenant'?s|liability)\s+insurance`,
  assistance_animal:        String.raw`assistance\s+animal|service\s+animal|emotional\s+support\s+animal`,
  screening_criteria:       String.raw`(?:screening|selection|admission|application)\s+criteria`,
  smoking_policy:           String.raw`smoking\s+(?:policy|prohibit|is\s+prohibited|area)|smoke-?free|no-?smoking`,
  recycling_garbage:        String.raw`recycl`,
  energy_efficiency:        String.raw`energy\s+(?:efficien\w+|cost|consumption|usage|audit)`,
  septic_system:            String.raw`septic`,
  well_water:               String.raw`private\s+well|well\s+water`,
  zoning_designation:       String.raw`zoning`,
  certificate_of_occupancy: String.raw`certificate\s+of\s+occupancy`,
  condemnation_orders:      String.raw`condemn`,
  fire_damage:              String.raw`fire\s+damage|damaged\s+by\s+fire`,
  defective_drywall:        String.raw`drywall`,
  military_ordnance:        String.raw`ordnance|munitions`,
  property_condition:       String.raw`(?:condition|defect)s?\s+of\s+the\s+(?:premises|dwelling|property|unit)`,
  statutory_acknowledgement:String.raw`acknowledg\w+\s+(?:receipt|that\s+the\s+(?:tenant|resident))`,
}
// What the DOCUMENT in each sleeve is called. The category labels describe a
// topic ("Owner / agent identity and address"); a sleeve holds a document, and
// is named like one, in title case (Nic's naming rule).
const DOC_TITLE: Record<string, string> = {
  owner_agent_identity: 'Owner & Manager Disclosure', foreclosure_status: 'Foreclosure Notice',
  death_on_premises: 'Death on Premises Disclosure', security_deposit_terms: 'Security Deposit Terms',
  park_rules: 'Park Rules', property_condition: 'Property Condition Disclosure',
  septic_system: 'Septic System Disclosure', rent_control: 'Rent Control Notice',
  late_fee_policy: 'Late Fee Policy', well_water: 'Well Water Disclosure',
  rent_increase_notice: 'Rent Increase Notice', entry_notice_policy: 'Notice of Entry',
  utility_shutoff_rights: 'Utility Interruption Notice', domestic_violence_rights: 'Domestic Violence Rights Notice',
  flood_zone: 'Flood Disclosure', radon: 'Radon Disclosure', mold: 'Mold Disclosure',
  pest_control: 'Pest Control Notice', home_sale_on_lot: 'Home Sale Rules',
  recycling_garbage: 'Recycling Notice', sex_offender_registry: 'Sex Offender Registry Notice',
  energy_efficiency: 'Energy Cost Disclosure', asbestos: 'Asbestos Disclosure',
  meth_contamination: 'Meth Contamination Disclosure', park_change_of_use: 'Change of Use Notice',
  park_statement_of_policy: 'Park Prospectus / Statement of Policy', smoke_co_detector: 'Smoke & CO Detector Notice',
  zoning_designation: 'Zoning Disclosure', insurance_requirement: 'Renters Insurance Requirement',
  assistance_animal: 'Assistance Animal Policy', bed_bugs: 'Bed Bug Information',
  certificate_of_occupancy: 'Certificate of Occupancy', screening_criteria: 'Tenant Screening Criteria',
  defective_drywall: 'Drywall Disclosure', utility_billing_method: 'Utility Billing Disclosure',
  smoking_policy: 'Smoking Policy', move_in_condition: 'Move-In Condition Checklist',
  military_ordnance: 'Military Ordnance Disclosure', condemnation_orders: 'Condemnation Notice',
  shared_utilities: 'Shared Utility Disclosure', fire_damage: 'Fire Damage Disclosure',
  statutory_acknowledgement: 'Acknowledgement of Receipt',
}

// Library topics (government supplies the document) and non-documents.
const NOT_A_SLEEVE = new Set(['lead_based_paint', 'tenant_rights_guide', 'lease_copy_delivery', 'other'])

type Hit = { sectionId: string; citation: string; act: string; snippet: string }

/** The first sentence that names the topic AND obliges the landlord to hand it over. */
function findHit(text: string, title: string | null, topic: string): string | null {
  // Skip sections that ARE definitions, not ones that merely end with a few.
  if (title && /^\s*(?:\d+\.\s*)?definitions?\b/i.test(title)) return null
  const re = new RegExp(topic, 'i')
  // A section TITLED "Disclosure of X" / "Notice of X" counts on the title.
  if (title && re.test(title) && /^\s*(?:disclosure|notice)s?\s+(?:of|to|regarding|required)/i.test(title)) {
    return `[title] ${title}`
  }
  // Split into sentences AND list items; a list item inherits the "shall:" of
  // the line that introduced it.
  const parts = text.split(/(?<=[.;:])\s+(?=[A-Z(0-9])/)
  let inherited = false
  // An intro like "shall attach ... a statement acknowledging receipt of:" or
  // "shall disclose ... the name and address of each of the following:" has
  // already handed the list over — its items only need to name the topic.
  let handedOver = false
  for (const raw of parts) {
    const sentence = raw.replace(/\s+/g, ' ').trim()
    if (LIST_DUTY.test(sentence)) {
      inherited = true
      handedOver = !NEGATED.test(sentence) && HANDS.some(h => h.test(sentence))
      if (re.test(sentence) && handedOver) return sentence
      continue
    }
    if (/\.\s*$/.test(sentence) && !/^\(?[a-z0-9]{1,3}\)/i.test(sentence)) {
      // a full sentence that is not itself a list item ends any list
      const hasOwn = DUTY.test(sentence)
      if (!hasOwn) { inherited = false; handedOver = false }
    }
    if (sentence.length > 1200) continue
    if (!re.test(sentence)) continue
    if (NEGATED.test(sentence)) continue
    if (TENANT_DUTY.test(sentence) && !LANDLORD_DUTY.test(sentence)) continue
    if (!(DUTY.test(sentence) || inherited)) continue
    if (handedOver || HANDS.some(h => h.test(sentence))) return sentence
  }
  return null
}

async function mine(states: string[]) {
  const rows = await query<any>(
    `SELECT id, state_code, act_key, section_number, section_title, full_text
       FROM state_law_section_texts
      WHERE law_category = 'landlord_tenant' AND state_code = ANY($1::text[])
        AND act_key = ANY($2::text[])
      ORDER BY state_code, act_key, section_number`,
    [states, Object.keys(ACT_UNITS)])
  // An RV act that is a copy of the state's mobile-home act is mislabelled in
  // the corpus (Illinois: 45 of 45 sections identical, text says "mobile home"
  // throughout). Mining it would put mobile-home duties on RV sites.
  const copies = await query<{ state_code: string; act_key: string }>(
    `WITH t AS (SELECT state_code, act_key, md5(full_text) h FROM state_law_section_texts WHERE law_category='landlord_tenant')
     SELECT r.state_code, r.act_key
       FROM (SELECT state_code, act_key, count(*) n FROM t WHERE act_key IN ('rv_park','rv_long_term') GROUP BY 1,2) r
      WHERE (SELECT count(*) FROM t a JOIN t b ON b.state_code=a.state_code AND b.h=a.h
              WHERE a.state_code=r.state_code AND a.act_key=r.act_key
                AND b.act_key IN ('mobile_home_park','manufactured_home_park')) >= 0.8 * r.n`)
  const skip = new Set(copies.map(c => `${c.state_code}|${c.act_key}`))
  if (skip.size) console.error(`skipping mislabelled RV acts (copies of the mobile home act): ${[...skip].join(', ')}`)

  // state -> act -> category -> first hit
  const found = new Map<string, Map<string, Map<string, Hit>>>()
  for (const r of rows) {
    if (skip.has(`${r.state_code}|${r.act_key}`)) continue
    const text = String(r.full_text || '')
    for (const [cat, topic] of Object.entries(TOPIC)) {
      if (!topic || NOT_A_SLEEVE.has(cat)) continue
      const byAct = found.get(r.state_code) ?? new Map(); found.set(r.state_code, byAct)
      const byCat = byAct.get(r.act_key) ?? new Map(); byAct.set(r.act_key, byCat)
      if (byCat.has(cat)) continue
      const snip = findHit(text, r.section_title, topic)
      if (snip) byCat.set(cat, { sectionId: r.id, citation: r.section_number, act: r.act_key, snippet: snip })
    }
  }
  return found
}

const actLabel: Record<string, string> = {
  residential: 'residential', general_landlord_tenant: 'residential', general: 'residential',
  mobile_home_park: 'mobile home park', manufactured_home_park: 'mobile home park',
  rv_park: 'RV park', rv_long_term: 'RV park', self_storage: 'self storage', commercial: 'commercial',
}

async function report(states: string[]) {
  const found = await mine(states)
  for (const st of states) {
    console.log(`\n================ ${US_STATE_NAME[st]} ================`)
    const byAct = found.get(st)
    if (!byAct) { console.log('  (no landlord-tenant sections)'); continue }
    for (const [act, byCat] of byAct) {
      console.log(`\n  ── ${act} (${[...byCat.keys()].length} topics) ──`)
      for (const [cat, h] of byCat) {
        console.log(`   · ${DISCLOSURE_TYPE_LABEL[cat as keyof typeof DISCLOSURE_TYPE_LABEL] ?? cat}  [${h.citation}]`)
        console.log(`       "${h.snippet.slice(0, 230)}"`)
      }
    }
  }
}

async function build() {
  const states = Object.keys(US_STATE_NAME)
  const found = await mine(states)
  const catOrder = new Map(DISCLOSURE_TYPES.map((c, i) => [c as string, i]))
  const unitOrder = new Map(UNIT_TYPES.map((u, i) => [u as string, i]))
  let written = 0

  const upsert = async (s: {
    key: string; state: string; kind: string; purpose: string; disclosureType: string | null
    units: string[]; appliesTo: string; title: string; sort: number; citation: string | null; sectionIds: string[] | null
  }) => {
    await query(
      `INSERT INTO document_sleeves
         (sleeve_key, state_code, kind, purpose, disclosure_type, unit_types, applies_to, title, sort_order, basis_citation, basis_section_ids)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (sleeve_key) DO UPDATE SET
         title=EXCLUDED.title, unit_types=EXCLUDED.unit_types, sort_order=EXCLUDED.sort_order,
         basis_citation=EXCLUDED.basis_citation, basis_section_ids=EXCLUDED.basis_section_ids,
         retired_at=NULL, updated_at=now()`,
      [s.key, s.state, s.kind, s.purpose, s.disclosureType, s.units, s.appliesTo, s.title, s.sort, s.citation, s.sectionIds])
    written++
  }

  for (const st of states) {
    const name = US_STATE_NAME[st]
    // Leases: every unit type, every state.
    for (const u of UNIT_TYPES) {
      await upsert({ key: `lease:${st}:${u}`, state: st, kind: 'lease', purpose: 'lease', disclosureType: null,
        units: [u], appliesTo: 'rental', title: `${name}: ${UNIT_TYPE_LABEL[u]} Lease`,
        sort: unitOrder.get(u)!, citation: null, sectionIds: null })
    }
    // A mobile home can be sold as well as rented.
    await upsert({ key: `sale:${st}:mobile_home`, state: st, kind: 'sale_contract', purpose: 'installment_sale',
      disclosureType: null, units: ['mobile_home'], appliesTo: 'sale',
      title: `${name}: Mobile Home Sale Contract`, sort: 50, citation: null, sectionIds: null })

    // Documents: one per topic per kind of space its act governs.
    const byAct = found.get(st)
    if (!byAct) continue
    // Merge acts that govern the same spaces (a state's "mobile_home_park" and
    // "manufactured_home_park" are one set of spaces).
    const merged = new Map<string, { units: string[]; hits: Hit[] }>()  // `${cat}|${unitsKey}`
    for (const [act, byCat] of byAct) {
      const units = ACT_UNITS[act]
      if (!units) continue
      for (const [cat, h] of byCat) {
        const k = `${cat}|${units.join(',')}`
        const e = merged.get(k) ?? { units, hits: [] }
        e.hits.push(h); merged.set(k, e)
      }
    }
    for (const [k, e] of merged) {
      const cat = k.split('|')[0]
      const scope = actLabel[e.hits[0].act]
      const label = DOC_TITLE[cat] ?? DISCLOSURE_TYPE_LABEL[cat as keyof typeof DISCLOSURE_TYPE_LABEL] ?? cat
      const scopeTag = scope === 'residential' ? '' : ` (${scope === 'mobile home park' ? 'Mobile Home Lots' : scope === 'RV park' ? 'RV & Camp Sites' : scope === 'self storage' ? 'Storage' : 'Commercial'})`
      await upsert({
        key: `doc:${st}:${e.units.join('+')}:${cat}`, state: st, kind: 'disclosure', purpose: 'state_disclosure',
        disclosureType: cat, units: e.units, appliesTo: 'any',
        title: `${name}: ${label}${scopeTag}`,
        sort: 100 + (catOrder.get(cat) ?? 99),
        citation: [...new Set(e.hits.map(h => h.citation))].join('; '),
        sectionIds: e.hits.map(h => h.sectionId),
      })
    }
  }
  console.log(`catalog: ${written} sleeves written`)

  // Every landlord template not yet in a sleeve goes into the one it plainly
  // belongs in. Nic: "all of my templates are just sitting there in a pool
  // instead of in a designated card slot." Anything without a confident answer
  // stays unfiled and shows under Other documents — never guessed.
  const { placeTemplate } = await import('../../services/documentSleeves')
  const exec = { query: (sql: string, params: any[]) => query<any>(sql, params).then(r => ({ rows: r })) }
  const loose = await query<{ id: string; name: string }>(
    `SELECT id, name FROM lease_templates WHERE is_active AND sleeve_id IS NULL AND library_document_id IS NULL`)
  for (const t of loose) {
    const sleeveId = await placeTemplate(exec, t.id)
    console.log(sleeveId ? `  filed:   ${t.name}` : `  unfiled: ${t.name}`)
  }
}

;(process.env.REPORT ? report(process.env.REPORT.split(',')) : build())
  .then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1) })
