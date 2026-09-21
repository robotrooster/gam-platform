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
  // false: the agency's PDF is locked against editing, so it can be read and
  // handed over but never stamped with a signature (see the migration).
  signable?: boolean
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

// S652 (Nic): "by default, it's primary tenants or up to four tenants' initials
// that they received each separate document that doesn't need a signature."
// One box per tenant slot. Co-tenant boxes on a lease with fewer tenants are
// dropped when the document is drafted (a role nobody holds never reaches the
// page), so a one-tenant lease shows one box.
const TENANT_ROLES = ['primary', 'co_tenant_1', 'co_tenant_2', 'co_tenant_3']
const INIT_W = 38, INIT_H = 16, INIT_GAP = 4
const initialsRow = (page: number, x: number, y: number, label: string, cols = 4): Field[] =>
  TENANT_ROLES.map((role, i) => ({
    type: 'initials' as const, role, label: `${label} — ${role === 'primary' ? 'tenant' : `co-tenant ${i}`}`,
    column: 'tenant_initial', page,
    x: x + (i % cols) * (INIT_W + INIT_GAP), y: y + Math.floor(i / cols) * (INIT_H + INIT_GAP),
    w: INIT_W, h: INIT_H, required: role === 'primary',
  }))
const rowWidth = (cols = 4) => cols * INIT_W + (cols - 1) * INIT_GAP

// Receipt on a pamphlet with no blanks: every tenant initials the first page
// and the last page; the tenant dates the last page, after the initials.
const receipt = (lastPage: number, first: { x: number; y: number }, last: { x: number; y: number }): Field[] => [
  ...initialsRow(1, first.x, first.y, 'Received this, first page'),
  ...initialsRow(lastPage, last.x, last.y, 'Received this, last page'),
  { type: 'date', role: 'primary', label: 'Date received', column: 'date_signed',
    page: lastPage, x: last.x + rowWidth() + 8, y: last.y, w: 80, h: INIT_H, required: true },
]

// The same, where the clear space is not side by side: each row placed by hand
// after looking at the rendered page, `cols` wide (2 = a 2×2 block).
const receiptAt = (lastPage: number, first: { x: number; y: number; cols?: number },
                   lastInitials: { x: number; y: number; cols?: number }, lastDate: { x: number; y: number }): Field[] => [
  ...initialsRow(1, first.x, first.y, 'Received this, first page', first.cols),
  ...initialsRow(lastPage, lastInitials.x, lastInitials.y, 'Received this, last page', lastInitials.cols),
  { type: 'date', role: 'primary', label: 'Date received', column: 'date_signed',
    page: lastPage, x: lastDate.x, y: lastDate.y, w: 80, h: INIT_H, required: true },
]

// The federal lead rule covers HOUSING built before 1978 — a place someone lives,
// not an RV site, a storage unit or a shop. Scoped here so an RV park's shelf and
// its packages never carry lead paperwork that does not apply to it.
const DWELLINGS = ['apartment', 'single_family', 'mobile_home', 'hotel_room']

// A form's own "Printed Name / Signature / Date" row, one per tenant.
const signRow = (page: number, top: number, role: string, nameColumn: string): Field[] => [
  { type: 'text', role, label: 'Printed name', column: nameColumn, page, x: 120, y: top - 1, w: 150, h: 15, required: false },
  { type: 'signature', role, label: 'Signature', column: 'tenant_signature', page, x: 333, y: top - 3, w: 122, h: 17, required: true },
  { type: 'date', role, label: 'Date', column: 'date_signed', page, x: 490, y: top - 1, w: 76, h: 15, required: true },
]

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
    fields: receipt(20, { x: 40, y: 566 }, { x: 40, y: 540 }),
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
    fields: receipt(27, { x: 400, y: 735 }, { x: 72, y: 300 }),
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
    fields: receipt(20, { x: 400, y: 742 }, { x: 72, y: 722 }),
  },
  // ── Arizona ───────────────────────────────────────────────────────────
  // ARS 33-1319 has landlords give "bedbug educational materials" and names
  // state agencies and universities as sources. This is the one written for
  // exactly that statute. The Department of Housing's own booklets (the
  // residential act, the mobile home act and its annual summary) could not be
  // fetched — its site blocks automated downloads — and are added by hand.
  {
    file: 'library-az-ua-bed-bug-landlords-tenants.pdf',
    name: 'Arizona: Bed Bug Control — What Landlords and Tenants Need to Know (2012)',
    description: 'University of Arizona Cooperative Extension guide to bed bugs in multi-family housing, written for the landlord and tenant duties in ARS 33-1319.',
    disclosureType: 'bed_bugs', jurisdiction: 'AZ', appliesTo: 'any',
    // The statute leaves out single-family homes.
    unitTypes: ['apartment', 'mobile_home', 'hotel_room'],
    sourceName: 'University of Arizona Cooperative Extension',
    sourceUrl: 'https://acis.cals.arizona.edu/docs/default-source/community-ipm-documents/public-health-ipm/bed-bugs/az1563.pdf',
    publicationRef: 'AZ1563, May 2012', effectiveFrom: '2012-05-01',
    fields: receiptAt(6, { x: 420, y: 4 }, { x: 300, y: 4 }, { x: 476, y: 4 }),
  },
  // ── Illinois ──────────────────────────────────────────────────────────
  {
    file: 'library-il-idhr-safe-homes-summary-2025.pdf',
    name: 'Illinois: Summary of Rights for Safer Homes (Safe Homes Act, October 2025)',
    description: "The Illinois Department of Human Rights' summary of tenants' rights under the Safe Homes Act for survivors of domestic violence, dating violence, sexual assault and stalking. Each page carries its own tenant acknowledgement.",
    disclosureType: 'domestic_violence_rights', jurisdiction: 'IL', appliesTo: 'rental', unitTypes: DWELLINGS,
    sourceName: 'Illinois Department of Human Rights',
    sourceUrl: 'https://dhr.illinois.gov/content/dam/soi/en/web/dhr/publications/documents/sfa/Summary%20of%20Rights%20for%20Safer%20Homes%20-%20Safe%20Homes%20Act%20Lease%20Document%20-%2010-2025.rev2.pdf',
    publicationRef: 'IDHR, V.2025-1.2', effectiveFrom: '2025-10-01',
    fields: [
      ...signRow(1, 670.6, 'primary', 'tenant_name'), ...signRow(1, 699.9, 'co_tenant_1', 'tenant_2_name'),
      ...signRow(2, 661.7, 'primary', 'tenant_name'), ...signRow(2, 691.0, 'co_tenant_1', 'tenant_2_name'),
      ...signRow(3, 660.9, 'primary', 'tenant_name'), ...signRow(3, 690.2, 'co_tenant_1', 'tenant_2_name'),
      ...signRow(4, 676.2, 'primary', 'tenant_name'), ...signRow(4, 705.5, 'co_tenant_1', 'tenant_2_name'),
    ],
  },
  {
    file: 'library-il-iema-radon-disclosure-lease.pdf',
    name: 'Illinois: Disclosure of Information on Radon Hazards — Tenants',
    description: "IEMA's radon disclosure for current and prospective tenants: the radon warning statement, the landlord's disclosure of known radon levels and records, and the tenant's acknowledgement of receiving them and the Radon Guide for Tenants.",
    disclosureType: 'radon', jurisdiction: 'IL', appliesTo: 'rental', unitTypes: DWELLINGS,
    sourceName: 'Illinois Emergency Management Agency and Office of Homeland Security',
    sourceUrl: 'https://iemaohs.illinois.gov/content/dam/soi/en/web/iemaohs/nrs/radon/documents/disclosureradonhazards.pdf',
    publicationRef: 'Illinois Radon Awareness Act, 420 ILCS 46', effectiveFrom: '2026-09-21',
    fields: [
      { type: 'text', role: null, label: 'Dwelling unit address', column: 'property_address', page: 1, x: 195, y: 280, w: 320, h: 14, required: false },
      onBlank('landlord', '(a) No knowledge of elevated radon', 1, 88.3, 320.9, 33, false),
      onBlank('landlord', '(b) Elevated radon known to be present', 1, 88.3, 352.2, 33, false),
      onBlank('landlord', '(c) Records and reports provided', 1, 88.3, 383.5, 33, false),
      onBlank('primary', '(d) Received the information listed above', 1, 88.3, 433.6, 33, true),
      onBlank('primary', '(e) Received the pamphlet Radon Guide for Tenants', 1, 88.3, 452.2, 33, true),
      { type: 'text', role: 'landlord', label: 'Lessor printed name', column: 'landlord_name', page: 1, x: 124, y: 561, w: 140, h: 13, required: false },
      { type: 'signature', role: 'landlord', label: 'Lessor signature', column: 'landlord_signature', page: 1, x: 124, y: 591, w: 140, h: 15, required: true },
      { type: 'date', role: 'landlord', label: 'Lessor date', column: 'date_signed', page: 1, x: 340, y: 592, w: 92, h: 13, required: true },
      { type: 'text', role: 'primary', label: 'Tenant printed name', column: 'tenant_name', page: 1, x: 124, y: 624, w: 140, h: 13, required: false },
      { type: 'signature', role: 'primary', label: 'Tenant signature', column: 'tenant_signature', page: 1, x: 124, y: 654, w: 140, h: 15, required: true },
      { type: 'date', role: 'primary', label: 'Tenant date', column: 'date_signed', page: 1, x: 340, y: 655, w: 92, h: 13, required: true },
    ],
  },
  {
    file: 'library-il-iema-radon-guide-for-tenants.pdf',
    name: 'Illinois: Radon Guide for Tenants',
    description: "IEMA's pamphlet for renters: what radon is, how to find out whether a home has a radon problem, and what a tenant can do about it. Line (e) of the Illinois radon disclosure is the tenant's receipt of this guide.",
    disclosureType: 'radon', jurisdiction: 'IL', appliesTo: 'rental', unitTypes: DWELLINGS,
    sourceName: 'Illinois Emergency Management Agency and Office of Homeland Security',
    sourceUrl: 'https://iemaohs.illinois.gov/content/dam/soi/en/web/iemaohs/nrs/radon/documents/radonguidefortenants.pdf',
    publicationRef: 'Radon Guide for Tenants', effectiveFrom: '2026-09-21',
    fields: receiptAt(8, { x: 170, y: 548 }, { x: 40, y: 300, cols: 2 }, { x: 40, y: 345 }),
  },
  // Nic: "If the government provides a document, we are adding it to the
  // library. That's it." IEMA's PDF is encrypted against editing, so it is on
  // the shelf to READ — no boxes, never adopted or packaged.
  {
    file: 'library-il-iema-radon-guidelines-sales.pdf',
    name: 'Illinois: Radon Testing Guidelines for Real Estate Transactions (read only)',
    description: "IEMA's pamphlet on radon testing during the sale of a home, approved under the Illinois Radon Awareness Act. The agency's file is locked against editing, so it can be viewed and handed over but not signed through GAM.",
    disclosureType: 'radon', jurisdiction: 'IL', appliesTo: 'sale', unitTypes: ['single_family'],
    sourceName: 'Illinois Emergency Management Agency and Office of Homeland Security',
    sourceUrl: 'https://iemaohs.illinois.gov/content/dam/soi/en/web/iemaohs/nrs/radon/documents/radontestguidelineforrealestatepamphlet.pdf',
    publicationRef: 'IEMA, 2007', effectiveFrom: '2007-01-01',
    signable: false, fields: [],
  },
  {
    file: 'library-az-adhs-bed-bug-toolkit.pdf',
    name: 'Arizona: Bed Bugs Toolkit (Department of Health Services, 2019)',
    description: "The Arizona Department of Health Services' toolkit on bed bugs: general information, prevention and control, and resources. Written with workplaces in mind.",
    disclosureType: 'bed_bugs', jurisdiction: 'AZ', appliesTo: 'any', unitTypes: ['apartment', 'mobile_home', 'hotel_room'],
    sourceName: 'Arizona Department of Health Services',
    sourceUrl: 'https://www.azdhs.gov/documents/preparedness/epidemiology-disease-control/food-safety-environmental-services/resources/bed-bug-toolkit.pdf',
    publicationRef: 'ADHS, October 2019', effectiveFrom: '2019-10-08',
    // Pages 18 and 19 are full to the edges; the cover is mostly white. Receipt
    // is one set of initials per document (Nic), so it all goes on the cover.
    fields: [
      ...initialsRow(1, 60, 120, 'Received this'),
      { type: 'date', role: 'primary', label: 'Date received', column: 'date_signed', page: 1, x: 60 + rowWidth() + 8, y: 120, w: 80, h: INIT_H, required: true },
    ],
  },
  {
    file: 'library-az-phoenix-guide-to-landlord-tenant-act-2014.pdf',
    name: 'Arizona: Guide to the Arizona Residential Landlord and Tenant Act (City of Phoenix, January 2014)',
    description: "The City of Phoenix Neighborhood Services Department's plain-language guide to the Arizona Residential Landlord and Tenant Act, January 2014 edition, as published on the Arizona Department of Health Services site.",
    disclosureType: 'tenant_rights_guide', jurisdiction: 'AZ', appliesTo: 'rental', unitTypes: ['apartment', 'single_family', 'mobile_home', 'hotel_room'],
    sourceName: 'City of Phoenix Neighborhood Services Department',
    sourceUrl: 'https://www.azdhs.gov/documents/preparedness/epidemiology-disease-control/childrens-environmental-health/landlord-tenant-act.pdf',
    publicationRef: 'Revised January 2014', effectiveFrom: '2014-01-01',
    fields: receiptAt(12, { x: 110, y: 575 }, { x: 40, y: 540 }, { x: 212, y: 540 }),
  },
  {
    file: 'library-il-ag-landlord-tenant-rights.pdf',
    name: 'Illinois: Landlord and Tenant Rights and Laws (Attorney General, 2024)',
    description: "The Illinois Attorney General's fact sheet on the rights and responsibilities of landlords and tenants: security deposits, repairs, evictions and where to get help.",
    disclosureType: 'tenant_rights_guide', jurisdiction: 'IL', appliesTo: 'rental', unitTypes: DWELLINGS,
    sourceName: 'Illinois Attorney General',
    sourceUrl: 'https://illinoisattorneygeneral.gov/Page-Attachments/LandlordAndTenantRightsLaws.pdf',
    publicationRef: 'Fact sheet, 01/24', effectiveFrom: '2024-01-01',
    fields: receiptAt(3, { x: 420, y: 24 }, { x: 72, y: 752 }, { x: 248, y: 752 }),
  },
]

async function preview(outDir: string) {
  fs.mkdirSync(outDir, { recursive: true })
  for (const d of DOCS) {
    if (d.signable === false) continue          // no boxes to draw on a locked file
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
    // a locked PDF can still be COUNTED (ignoreEncryption reads, never writes)
    const pages = (await PDFDocument.load(fs.readFileSync(src), { ignoreEncryption: true })).getPageCount()

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

      // The default BOXES are this script's too. When they change, the shelf
      // gets the new ones — and so does every landlord copy whose boxes are
      // still exactly the old defaults. A copy the landlord has moved or added
      // boxes on is theirs (Nic: boxes "able to be altered if necessary") and
      // is left alone, and said so.
      const sig = (rows: any[]) => rows.map(r =>
        [r.field_type, r.signer_role, r.page, Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)].join('|')).sort().join(';')
      const libFields = await query<any>(`SELECT * FROM disclosure_library_fields WHERE document_id=$1`, [held[0].id])
      const wanted = sig(d.fields.map(f => ({ field_type: f.type, signer_role: f.role, page: f.page, x: f.x, y: f.y, width: f.w, height: f.h })))
      const oldSig = sig(libFields)
      if (oldSig !== wanted) {
        await query(`DELETE FROM disclosure_library_fields WHERE document_id=$1`, [held[0].id])
        let n = 0
        for (const f of d.fields) {
          await query(
            `INSERT INTO disclosure_library_fields
               (document_id, field_type, signer_role, label, lease_column, page, x, y, width, height, required, sort_order)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
            [held[0].id, f.type, f.role, f.label, f.column ?? null, f.page, f.x, f.y, f.w, f.h, f.required, ++n])
        }
        const adopted = await query<{ id: string; name: string }>(
          `SELECT t.id, u.email AS name FROM lease_templates t JOIN landlords l ON l.id=t.landlord_id
             JOIN users u ON u.id=l.user_id WHERE t.library_document_id=$1 AND t.is_active`, [held[0].id])
        for (const t of adopted) {
          const own = await query<any>(`SELECT * FROM lease_template_fields WHERE template_id=$1`, [t.id])
          if (sig(own) !== oldSig) { console.log(`    left alone (boxes customised): ${t.name}`); continue }
          await query(`DELETE FROM lease_template_fields WHERE template_id=$1`, [t.id])
          await query(
            `INSERT INTO lease_template_fields
               (template_id, field_type, signer_role, label, lease_column, page, x, y, width, height, required, sort_order, options, default_value, checkbox_mark)
             SELECT $2, field_type, signer_role, label, lease_column, page, x, y, width, height, required, sort_order, options, default_value, checkbox_mark
               FROM disclosure_library_fields WHERE document_id=$1`, [held[0].id, t.id])
          console.log(`    new default boxes → ${t.name}`)
        }
        console.log(`  boxes updated: ${d.name} (${d.fields.length})`)
      }
      continue
    }

    const row = await query<{ id: string }>(
      `INSERT INTO disclosure_library_documents
         (disclosure_type, jurisdiction, applies_to, unit_types, name, description,
          source_name, source_url, publication_ref, base_pdf_url, page_count, effective_from, signable)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
      [d.disclosureType, d.jurisdiction, d.appliesTo, d.unitTypes, d.name, d.description,
       d.sourceName, d.sourceUrl, d.publicationRef, url, pages, d.effectiveFrom, d.signable !== false])
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
