/**
 * New York real-estate statute full-text ingester (OpenLegislation JSON API).
 *
 * Two layers, distinguished by `law_category` (see packages/shared
 * LAW_CATEGORY_VALUES):
 *   - landlord_tenant — the live CS-agent retrieval domain (RPP Art 6-A Good
 *     Cause + Art 7 Landlord&Tenant + Art 7-A kerosene + Art 12-D short-term
 *     rentals; RPAPL Art 7 summary proceedings + Art 7-A/B/C/D tenant
 *     proceedings; GOB Art 7 Title 1 deposits; the Emergency Tenant Protection
 *     Act). act_key keeps the existing sub-type vocabulary
 *     (residential/eviction/mobile_home_park).
 *   - property_tax — the entire Real Property Tax Law (RPT), ingested in full
 *     for a near-term GAM property-tax feature (assessment, exemptions, judicial
 *     review/grievance, delinquent-tax enforcement, levy & collection).
 *   - broader real estate (conveyancing_title, condo_coop, broker_licensing,
 *     mortgage_lien_foreclosure, land_use_zoning, environmental_disclosure,
 *     general_real_property) — the REST of Real Property Law + RPAPL, kept now
 *     for future investor/agent surfaces but filtered OUT of the landlord/tenant
 *     agent. For these rows act_key is the source-law id ('rpl'/'rpapl'/'rpt')
 *     so section numbers stay unique per (state, act_key, section, year).
 *
 * The laws API returns a nested doc tree (result.documents = CHAPTER → ARTICLE →
 * SECTION leaves with verbatim `text`); location-scoped fetches do NOT expand
 * children, so we pull each law's FULL tree (?detail=true&full=true) and walk
 * it, mapping each section by its nearest ARTICLE. Repealed/empty dropped.
 * Upsert (ON CONFLICT DO UPDATE) so re-runs refresh.
 *
 * Read key from env (NY_OPENLEG_KEY); never hardcode.
 * Run: cd apps/api && NY_OPENLEG_KEY=… node -r ts-node/register src/db/ingestNyStateLaw.ts
 */

import { query } from './index'
import { LAW_CATEGORY_VALUES, type LawCategory } from '@gam/shared'

const STATE = 'NY'
const SOURCE_DATE = '2026-06-14'
const EFFECTIVE_YEAR = 2026
const API = 'https://legislation.nysenate.gov/api/3/laws'
const WEB = 'https://www.nysenate.gov/legislation/laws'

const KEY = process.env.NY_OPENLEG_KEY || ''
if (!KEY) {
  console.error('NY_OPENLEG_KEY is required (free key from legislation.nysenate.gov). Aborting.')
  process.exit(1)
}

// The §233 manufactured-home-park / campground cluster within RPP Article 7.
const MH_LOCS = new Set(['233', '233-A', '233-B', '233-B*2'])

type Mapping = { category: LawCategory; actKey: string }

// Per-ARTICLE classification. Landlord/tenant articles carry the sub-type
// act_key + law_category 'landlord_tenant' (the live agent domain); everything
// else is broader real estate with act_key = source-law id. RPP Art 7 is a
// special case (handled in classify): §233 cluster → mobile_home_park.
const RPP_ARTICLES: Record<string, Mapping> = {
  'A6-A': { category: 'landlord_tenant', actKey: 'residential' }, // Good Cause Eviction Law
  A7: { category: 'landlord_tenant', actKey: 'residential' }, // Landlord and Tenant
  A7A: { category: 'landlord_tenant', actKey: 'residential' }, // Portable Kerosene Heaters (dwelling safety)
  'A12-D': { category: 'landlord_tenant', actKey: 'residential' }, // Short-term Rental Units
  A8: { category: 'conveyancing_title', actKey: 'rpl' }, // Conveyances and Mortgages
  A9: { category: 'conveyancing_title', actKey: 'rpl' }, // Recording Instruments
  'A9-A': { category: 'land_use_zoning', actKey: 'rpl' }, // Subdivided Lands
  'A9-B': { category: 'condo_coop', actKey: 'rpl' }, // Condominium Act
  'A9-E': { category: 'conveyancing_title', actKey: 'rpl' }, // Conveyance of Manufactured Homes as Real Property
  A10: { category: 'mortgage_lien_foreclosure', actKey: 'rpl' }, // Discharge of Ancient Mortgages
  A12: { category: 'conveyancing_title', actKey: 'rpl' }, // Registering Title (Torrens)
  'A12-A': { category: 'broker_licensing', actKey: 'rpl' }, // Real Estate Brokers & Salespersons
  'A12-B': { category: 'broker_licensing', actKey: 'rpl' }, // Home Inspection Licensing
  'A12-C': { category: 'broker_licensing', actKey: 'rpl' }, // Apartment Information Vendors
  A14: { category: 'environmental_disclosure', actKey: 'rpl' }, // Property Condition Disclosure
  A15: { category: 'conveyancing_title', actKey: 'rpl' }, // Private Transfer Fee Disclosure
  A16: { category: 'mortgage_lien_foreclosure', actKey: 'rpl' }, // 90-day pre-foreclosure waiting period
  'A4-A': { category: 'mortgage_lien_foreclosure', actKey: 'rpl' }, // Trust Indentures
}
const RPAPL_ARTICLES: Record<string, Mapping> = {
  A7: { category: 'landlord_tenant', actKey: 'eviction' }, // Summary Proceeding to Recover Possession
  'A7-A': { category: 'landlord_tenant', actKey: 'eviction' }, // Tenant proceedings (NYC 7A)
  'A7-B': { category: 'landlord_tenant', actKey: 'mobile_home_park' }, // Removal of Abandoned Manufactured Homes
  'A7-C': { category: 'landlord_tenant', actKey: 'eviction' }, // Tenant proceedings
  'A7-D': { category: 'landlord_tenant', actKey: 'eviction' }, // Tenant proceedings for repairs
  A5: { category: 'conveyancing_title', actKey: 'rpapl' }, // Adverse Possession
  A13: { category: 'mortgage_lien_foreclosure', actKey: 'rpapl' }, // Action to Foreclose a Mortgage
  A15: { category: 'conveyancing_title', actKey: 'rpapl' }, // Compel Determination of Claim (quiet title)
  A19: { category: 'mortgage_lien_foreclosure', actKey: 'rpapl' }, // Discharge of Encumbrances
  'A19-A': { category: 'conveyancing_title', actKey: 'rpapl' }, // Convey Title to Abandoned Dwelling
  'A19-B': { category: 'conveyancing_title', actKey: 'rpapl' }, // Convey Title to Abandoned Commercial
  'A20-A': { category: 'condo_coop', actKey: 'rpapl' }, // Enforcement of HOA Liens
}

interface LawDoc {
  docType?: string
  locationId?: string
  title?: string | null
  text?: string | null
  repealed?: boolean
  repealedDate?: string | null
  documents?: { items?: LawDoc[] } | null
}
interface Section {
  number: string
  title: string | null
  text: string
  actKey: string
  category: LawCategory
  url: string
}

async function fetchLawTree(lawId: string): Promise<LawDoc> {
  const url = `${API}/${lawId}?detail=true&full=true&key=${encodeURIComponent(KEY)}`
  const res = await fetch(url, { headers: { Accept: 'application/json' } })
  if (!res.ok) throw new Error(`${lawId}: HTTP ${res.status}`)
  const json: any = await res.json()
  if (!json?.success) throw new Error(`${lawId}: ${json?.message || 'API error'}`)
  const root = json?.result?.documents
  if (!root) throw new Error(`${lawId}: no document tree`)
  return root as LawDoc
}

/**
 * Walk a law tree, classifying each live SECTION by its nearest ARTICLE via the
 * given map. defLawId is the source-law act_key for any article not in the map
 * (those land in general_real_property). RPP Art 7's §233 cluster overrides to
 * mobile_home_park.
 */
function collectLaw(root: LawDoc, lawId: string, map: Record<string, Mapping>, defActKey: string): Section[] {
  const out: Section[] = []
  const walk = (node: LawDoc, article: string | null) => {
    const cur = node.docType === 'ARTICLE' ? node.locationId || article : article
    if (node.docType === 'SECTION') {
      const repealed = node.repealed === true || !!node.repealedDate
      const text = (node.text || '').trim()
      const loc = node.locationId || ''
      if (!repealed && text.length >= 20 && loc) {
        const m: Mapping = (cur && map[cur]) || { category: 'general_real_property', actKey: defActKey }
        // RPP Art 7 manufactured-home cluster → mobile_home_park (still L/T).
        const actKey = cur === 'A7' && MH_LOCS.has(loc) ? 'mobile_home_park' : m.actKey
        out.push({
          number: loc,
          title: (node.title || '').trim() || null,
          text,
          actKey,
          category: m.category,
          url: `${WEB}/${lawId}/${loc}`,
        })
      }
    }
    for (const child of node.documents?.items || []) walk(child, cur)
  }
  walk(root, null)
  return out
}

function collectScoped(
  root: LawDoc,
  lawId: string,
  scopeLoc: string | null,
  category: LawCategory,
  actKey: string
): Section[] {
  const out: Section[] = []
  const walk = (node: LawDoc, inScope: boolean) => {
    const loc = node.locationId || ''
    const scope = inScope || scopeLoc === null || loc === scopeLoc
    if (node.docType === 'SECTION' && scope) {
      const repealed = node.repealed === true || !!node.repealedDate
      const text = (node.text || '').trim()
      if (!repealed && text.length >= 20) {
        out.push({ number: loc, title: (node.title || '').trim() || null, text, actKey, category, url: `${WEB}/${lawId}/${loc}` })
      }
    }
    for (const child of node.documents?.items || []) walk(child, scope)
  }
  walk(root, scopeLoc === null)
  return out
}

async function upsert(sections: Section[]): Promise<number> {
  let n = 0
  for (const s of sections) {
    if (!LAW_CATEGORY_VALUES.includes(s.category)) throw new Error(`bad category ${s.category}`)
    await query(
      `INSERT INTO state_law_section_texts
         (state_code, act_key, section_number, section_title, full_text, source_url, source_date, effective_year, law_category)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (state_code, act_key, section_number, effective_year)
       DO UPDATE SET section_title = EXCLUDED.section_title,
                     full_text     = EXCLUDED.full_text,
                     source_url    = EXCLUDED.source_url,
                     source_date   = EXCLUDED.source_date,
                     law_category  = EXCLUDED.law_category`,
      [STATE, s.actKey, s.number, s.title, s.text, s.url, SOURCE_DATE, EFFECTIVE_YEAR, s.category]
    )
    n++
  }
  return n
}

async function main() {
  console.log(`\n=== NY — ingesting real-estate corpus via OpenLegislation API (as of ${SOURCE_DATE}) ===`)

  const [rpp, rpa, gob, etp, rpt] = await Promise.all([
    fetchLawTree('RPP'),
    fetchLawTree('RPA'),
    fetchLawTree('GOB'),
    fetchLawTree('ETP'),
    fetchLawTree('RPT'),
  ])

  const sections: Section[] = [
    // Real Property Law (whole) — L/T articles + broader real estate by article.
    ...collectLaw(rpp, 'RPP', RPP_ARTICLES, 'rpl'),
    // RPAPL (whole) — eviction/tenant proceedings + foreclosure/title/etc.
    ...collectLaw(rpa, 'RPA', RPAPL_ARTICLES, 'rpapl'),
    // GOB Article 7 Title 1 — security deposits → landlord_tenant/residential.
    ...collectScoped(gob, 'GOB', 'A7T1', 'landlord_tenant', 'residential'),
    // Emergency Tenant Protection Act → landlord_tenant/residential.
    ...collectScoped(etp, 'ETP', null, 'landlord_tenant', 'residential'),
    // Real Property Tax Law (whole) → property_tax (near-term GAM feature).
    ...collectScoped(rpt, 'RPT', null, 'property_tax', 'rpt'),
  ]

  const byCat = sections.reduce<Record<string, number>>((a, s) => ((a[s.category] = (a[s.category] || 0) + 1), a), {})
  console.log('collected by law_category:', byCat, '— total', sections.length)

  const inserted = await upsert(sections)
  console.log(`NY done. upserted=${inserted}`)
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
