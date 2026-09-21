/**
 * S652 — STOCK THE SHELF: the first five government forms.
 *
 * NAMING RULE: "<Federal|State name>: <what the form is> (<edition or form no.>)".
 * Nic: "Is that a federal document? Is that statewide? Is that Illinois only?...
 * if there's like some states that require a certain disclosure and they all
 * have their own similar form... it needs to have that in the title." Fifteen
 * states' bed-bug forms must read as fifteen different documents at a glance,
 * in every list a title appears in — not only on a page that groups them.
 *
 * Nic: "download those five forms first, maybe put it on our to-do list for the
 * actual all of the library." And: "we also need to label them correctly in the
 * system, not just have them be the file name that happens to be on the download
 * link, and it needs to be title case organized in the library of forms."
 *
 * Every PDF here is the agency's own file, byte for byte, from the agency's own
 * site. GAM wrote none of the words. What GAM supplies is the BOXES, and those
 * matter as much as the paper — Nic: "just including it with the signature in
 * the packet with no actual initial on the page itself is going to be argued
 * that it was never received from somebody down the line."
 *
 * So each form ships with a default field map:
 *   - The two EPA disclosure forms have their own blanks. The boxes sit ON
 *     those blanks, located by the words printed beside them, so the tenant's
 *     "(d) received the pamphlet" initial lands exactly where EPA put the line.
 *   - The three pamphlets have no blanks at all. Each gets the recipient's
 *     initials on the FIRST page and initials + date on the LAST page, in clear
 *     space — receipt evidenced on the document itself, front and back.
 * These are defaults. The landlord can add, move or remove boxes in the template
 * editor; only the government's text is fixed.
 *
 *     PREVIEW=<dir> npx ts-node src/scripts/disclosures/stockLibrary.ts   # draw boxes onto copies, write nothing
 *     npx ts-node src/scripts/disclosures/stockLibrary.ts                 # stock the shelf
 */
import fs from 'fs'
import path from 'path'
import { PDFDocument, rgb } from 'pdf-lib'
import { query } from '../../db'

const DIR = path.resolve(__dirname, '../../../uploads/leases')

type Field = {
  type: 'initials' | 'signature' | 'date' | 'text'
  role: string | null
  label: string
  column?: string | null
  page: number
  x: number; y: number; w: number; h: number
  required: boolean
}

type Doc = {
  file: string
  name: string
  description: string
  disclosureType: string
  jurisdiction: string
  appliesTo: 'any' | 'rental' | 'sale'
  unitTypes: string[] | null
  sourceName: string
  sourceUrl: string
  publicationRef: string
  effectiveFrom: string
  fields: Field[]
}

// A box on one of EPA's printed blanks. `top` is the blank's word-box top as
// pdftotext reports it; the line itself sits just under that.
const onBlank = (role: string, label: string, page: number, x: number, top: number, w: number, required: boolean): Field =>
  ({ type: 'initials', role, label, column: role === 'landlord' ? 'landlord_initial' : 'tenant_initial',
     page, x: x - 2, y: top - 1, w: Math.max(w + 4, 30), h: 14, required })

// EPA's signature table: the label row ("Lessor ... Date") prints UNDER the
// line, so the writing space is the band just above each label.
const sigRow = (role: string, who: string, page: number, sigX: number, dateX: number, labelTop: number): Field[] => [
  { type: 'signature', role, label: `${who} signature`, column: role === 'landlord' ? 'landlord_signature' : 'tenant_signature',
    page, x: sigX, y: labelTop - 17, w: 150, h: 16, required: true },
  { type: 'date', role, label: `${who} date`, column: 'date_signed',
    page, x: dateX, y: labelTop - 17, w: 64, h: 16, required: true },
]

// Receipt on a pamphlet with no blanks: initials on the cover, initials and
// date on the last page.
const receipt = (lastPage: number, first: { x: number; y: number }, last: { x: number; y: number }): Field[] => [
  { type: 'initials', role: 'primary', label: 'Received this — initials, first page', column: 'tenant_initial',
    page: 1, x: first.x, y: first.y, w: 56, h: 18, required: true },
  { type: 'initials', role: 'primary', label: 'Received this — initials, last page', column: 'tenant_initial',
    page: lastPage, x: last.x, y: last.y, w: 56, h: 18, required: true },
  { type: 'date', role: 'primary', label: 'Date received', column: 'date_signed',
    page: lastPage, x: last.x + 70, y: last.y, w: 90, h: 18, required: true },
]

// The federal lead rule covers HOUSING built before 1978 — a place someone lives,
// not an RV site, a storage unit or a shop. Scoped here so an RV park's shelf and
// its packages never carry lead paperwork that does not apply to it.
const DWELLINGS = ['apartment', 'single_family', 'mobile_home', 'hotel_room']

const DOCS: Doc[] = [
  {
    file: 'library-us-epa-lessor-lead-disclosure.pdf',
    name: 'Federal: Lead-Based Paint Disclosure — Rentals (EPA Form 9600-041)',
    description: "EPA's disclosure form for leasing housing built before 1978: the lead warning statement, the landlord's disclosure of known lead-based paint and records, and the tenant's acknowledgement of receiving them and the lead pamphlet.",
    disclosureType: 'lead_based_paint', jurisdiction: 'US', appliesTo: 'rental', unitTypes: DWELLINGS,
    sourceName: 'U.S. Environmental Protection Agency',
    sourceUrl: 'https://www.epa.gov/sites/default/files/documents/lesr_eng.pdf',
    publicationRef: 'EPA Form 9600-041; 40 CFR 745.113(b)',
    effectiveFrom: '2026-09-21',
    fields: [
      // (a) presence — landlord initials (i) OR (ii)
      onBlank('landlord', '(a)(i) Known lead-based paint present', 1, 122.8, 284.6, 26.8, false),
      // On the ruled line UNDER EPA's printed "Describe what is known:" — never over its words.
      { type: 'text', role: 'landlord', label: 'Describe what is known', column: null, page: 1, x: 72, y: 316, w: 466, h: 11, required: false },
      onBlank('landlord', '(a)(ii) No knowledge of lead-based paint', 1, 125.0, 354.6, 26.0, false),
      // (b) records — landlord initials (i) OR (ii)
      onBlank('landlord', '(b)(i) Records provided', 1, 124.9, 396.9, 26.2, false),
      { type: 'text', role: 'landlord', label: 'List documents provided', column: null, page: 1, x: 72, y: 441, w: 466, h: 11, required: false },
      onBlank('landlord', '(b)(ii) No records or reports', 1, 127.0, 482.8, 23.0, false),
      // (c) tenant — (i) received the records OR (ii) did not
      onBlank('primary', '(c)(i) Received the records', 1, 125.3, 549.4, 26.6, false),
      onBlank('primary', '(c)(ii) Did not receive records', 1, 126.0, 577.9, 27.0, false),
      // (d) THE receipt initial — the one Nic is talking about
      onBlank('primary', '(d) Received the pamphlet Protect Your Family From Lead in Your Home', 1, 90.7, 607.2, 39.9, true),
      ...sigRow('landlord', 'Lessor', 2, 72, 222, 142.4),
      ...sigRow('primary', 'Lessee', 2, 307, 460, 142.4),
      ...sigRow('co_tenant_1', 'Second lessee', 2, 307, 460, 170.5),
    ],
  },
  {
    file: 'library-us-epa-seller-lead-disclosure.pdf',
    name: 'Federal: Lead-Based Paint Disclosure — Sales (EPA Form 9600-040)',
    description: "EPA's disclosure form for selling housing built before 1978: the lead warning statement, the seller's disclosure of known lead-based paint and records, and the purchaser's acknowledgement of receiving them, the lead pamphlet, and the 10-day inspection opportunity.",
    disclosureType: 'lead_based_paint', jurisdiction: 'US', appliesTo: 'sale', unitTypes: DWELLINGS,
    sourceName: 'U.S. Environmental Protection Agency',
    sourceUrl: 'https://www.epa.gov/sites/default/files/documents/selr_eng.pdf',
    publicationRef: 'EPA Form 9600-040; 40 CFR 745.113(a)',
    effectiveFrom: '2026-09-21',
    fields: [
      onBlank('landlord', '(a)(i) Known lead-based paint present', 1, 123.1, 304.5, 26.7, false),
      { type: 'text', role: 'landlord', label: 'Describe what is known', column: null, page: 1, x: 74, y: 333, w: 464, h: 11, required: false },
      onBlank('landlord', '(a)(ii) No knowledge of lead-based paint', 1, 125.8, 359.9, 26.7, false),
      onBlank('landlord', '(b)(i) Records provided', 1, 123.1, 402.1, 31.1, false),
      { type: 'text', role: 'landlord', label: 'List documents provided', column: null, page: 1, x: 74, y: 444, w: 464, h: 11, required: false },
      onBlank('landlord', '(b)(ii) No records or reports', 1, 125.8, 470.9, 26.7, false),
      onBlank('primary', '(c)(i) Received the records', 1, 123.1, 541.3, 26.7, false),
      onBlank('primary', '(c)(ii) Did not receive records', 1, 126.5, 569.4, 26.7, false),
      onBlank('primary', '(d) Received the pamphlet Protect Your Family From Lead in Your Home', 1, 90.4, 597.5, 35.6, true),
      onBlank('primary', '(e)(i) Received a 10-day inspection opportunity', 1, 125.1, 639.8, 26.7, false),
      onBlank('primary', '(e)(ii) Waived the inspection opportunity', 2, 126.5, 72.0, 31.1, false),
      ...sigRow('landlord', 'Seller', 2, 72, 222, 269.3),
      ...sigRow('primary', 'Purchaser', 2, 307, 460, 269.3),
      ...sigRow('co_tenant_1', 'Second purchaser', 2, 307, 460, 297.5),
    ],
  },
  {
    file: 'library-us-epa-protect-your-family-2026.pdf',
    name: 'Federal: Protect Your Family From Lead in Your Home (January 2026)',
    description: 'The lead poisoning prevention pamphlet from EPA, the Consumer Product Safety Commission and HUD. The January 2026 edition reflects the dust-lead action levels effective January 12, 2026.',
    disclosureType: 'lead_based_paint', jurisdiction: 'US', appliesTo: 'any', unitTypes: DWELLINGS,
    sourceName: 'U.S. Environmental Protection Agency, Consumer Product Safety Commission, and Department of Housing and Urban Development',
    sourceUrl: 'https://www.epa.gov/system/files/documents/2026-02/protectyourfamily_pamphlet_2026_3.pdf',
    publicationRef: 'Protect Your Family From Lead in Your Home, January 2026 (English)',
    effectiveFrom: '2026-01-12',
    fields: receipt(20, { x: 300, y: 567 }, { x: 40, y: 540 }),
  },
  {
    file: 'library-il-idph-living-in-mh-community.pdf',
    name: 'Illinois: Living in a Manufactured Home Community (2018)',
    description: "The Illinois Department of Public Health's guide for residents of manufactured home communities, including the full text of the Mobile Home Landlord and Tenant Rights Act.",
    disclosureType: 'tenant_rights_guide', jurisdiction: 'IL', appliesTo: 'any', unitTypes: ['mobile_home'],
    sourceName: 'Illinois Department of Public Health',
    sourceUrl: 'https://dph.illinois.gov/content/dam/soi/en/web/idph/files/publications/publicationsohp2018-living-manufacturedhome-community.pdf',
    publicationRef: 'IDPH, Living in a Manufactured Home Community, 2018',
    effectiveFrom: '2018-01-01',
    fields: receipt(27, { x: 440, y: 735 }, { x: 72, y: 300 }),
  },
  {
    file: 'library-il-idph-mh-landlord-tenant-act.pdf',
    name: 'Illinois: Mobile Home Landlord and Tenant Rights Act (765 ILCS 745)',
    description: 'The text of the Illinois Mobile Home Landlord and Tenant Rights Act, as printed by the Illinois Department of Public Health.',
    disclosureType: 'tenant_rights_guide', jurisdiction: 'IL', appliesTo: 'any', unitTypes: ['mobile_home'],
    sourceName: 'Illinois Department of Public Health',
    sourceUrl: 'https://dph.illinois.gov/content/dam/soi/en/web/idph/files/publications/mobile-home-landlord-and-tenant-rights-act-printable-5-31-18.pdf',
    publicationRef: '765 ILCS 745, IDPH printing of May 31, 2018',
    effectiveFrom: '2018-05-31',
    fields: receipt(20, { x: 450, y: 742 }, { x: 72, y: 722 }),
  },
]

async function preview(outDir: string) {
  fs.mkdirSync(outDir, { recursive: true })
  for (const d of DOCS) {
    const pdf = await PDFDocument.load(fs.readFileSync(path.join(DIR, d.file)))
    for (const f of d.fields) {
      const page = pdf.getPage(f.page - 1)
      const H = page.getHeight()
      const color = f.role === 'landlord' ? rgb(0.1, 0.35, 0.9) : rgb(0.9, 0.2, 0.1)
      page.drawRectangle({ x: f.x, y: H - f.y - f.h, width: f.w, height: f.h,
        borderColor: color, borderWidth: 1.2, color, opacity: 0.12, borderOpacity: 0.9 })
    }
    const out = path.join(outDir, d.file.replace('.pdf', '.preview.pdf'))
    fs.writeFileSync(out, await pdf.save())
    console.log('preview', out, `(${d.fields.length} boxes)`)
  }
}

async function stock() {
  for (const d of DOCS) {
    const src = path.join(DIR, d.file)
    if (!fs.existsSync(src)) throw new Error(`missing ${src}`)
    const url = `/api/esign/files/${d.file}`
    const pages = (await PDFDocument.load(fs.readFileSync(src))).getPageCount()

    const held = await query<{ id: string }>(
      `SELECT id FROM disclosure_library_documents WHERE base_pdf_url=$1`, [url])
    if (held.length) {
      // This script is the one source for a library form's title. A rename here
      // reaches the shelf AND every landlord's copy — their copy's name is not
      // theirs to change, so it is ours to keep right.
      const renamed = await query<{ id: string }>(
        `UPDATE disclosure_library_documents SET name=$2, description=$3, unit_types=$4, updated_at=now()
          WHERE id=$1 AND (name IS DISTINCT FROM $2 OR description IS DISTINCT FROM $3 OR unit_types IS DISTINCT FROM $4) RETURNING id`,
        [held[0].id, d.name, d.description, d.unitTypes])
      const copies = await query<{ id: string }>(
        `UPDATE lease_templates SET name=$2, description=$3, updated_at=now()
          WHERE library_document_id=$1 AND (name IS DISTINCT FROM $2 OR description IS DISTINCT FROM $3) RETURNING id`,
        [held[0].id, d.name, d.description])
      console.log(renamed.length || copies.length
        ? `renamed: ${d.name} (and ${copies.length} landlord cop${copies.length === 1 ? 'y' : 'ies'})`
        : `already shelved: ${d.name}`)
      continue
    }

    const row = await query<{ id: string }>(
      `INSERT INTO disclosure_library_documents
         (disclosure_type, jurisdiction, applies_to, unit_types, name, description,
          source_name, source_url, publication_ref, base_pdf_url, page_count, effective_from)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
      [d.disclosureType, d.jurisdiction, d.appliesTo, d.unitTypes, d.name, d.description,
       d.sourceName, d.sourceUrl, d.publicationRef, url, pages, d.effectiveFrom])
    let sort = 0
    for (const f of d.fields) {
      await query(
        `INSERT INTO disclosure_library_fields
           (document_id, field_type, signer_role, label, lease_column, page, x, y, width, height, required, sort_order)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [row[0].id, f.type, f.role, f.label, f.column ?? null, f.page, f.x, f.y, f.w, f.h, f.required, ++sort])
    }
    console.log('shelved:', d.name, `— ${pages} pages, ${d.fields.length} boxes`)
  }
}

;(process.env.PREVIEW ? preview(process.env.PREVIEW) : stock())
  .then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1) })
