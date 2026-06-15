/**
 * Broad real-estate-law headless configs (S-state-law-broaden).
 *
 * The landlord/tenant corpus (stateHeadlessConfigs.generated.ts) is the live
 * agent retrieval domain. This file adds the REST of each state's real-estate
 * law — conveyancing/title, condo/co-op, mortgage/lien/foreclosure, broker
 * licensing, property tax, land-use/zoning, environmental disclosure, general
 * real property — tagged with `law_category` (single source of truth:
 * @gam/shared LAW_CATEGORY_VALUES) so the L/T agent stays filtered to
 * 'landlord_tenant' while investor/commercial surfaces can read the rest.
 * Same sanctioned retrieve+cite+date carve-out; never advice.
 *
 * Mirrors NY's per-article classification (ingestNyStateLaw.ts) but over the
 * headless-rendered IGA/ILGA sources. Merged into the headless ingester by
 * appending acts to each state (so a state's L/T acts + broad acts both run on
 * `ingest <STATE>`). Coverage targets NY parity: core property law in full;
 * land-use/zoning and disclosure are selective (matching NY's thin coverage);
 * exhaustive property-tax administration is intentionally out (NY has none).
 */
import type { ActSpec, StateSpec } from './ingestHeadlessStateLaw'
import type { LawCategory } from '@gam/shared'

// ---------------------------------------------------------------------------
// Indiana — Indiana Code, served as one big rendered page per Title. Article-
// scoped regexes filter each Title page to the target article. Section id =
// "IC <art>-<chapter>-<section>" with the catchline on the header line after
// the first TAB (regex group 2). History footers trimmed via stopRe.
// ---------------------------------------------------------------------------
const IN_T32 = 'https://iga.in.gov/ic/2024/Title_32.html'
const IN_T25 = 'https://iga.in.gov/ic/2024/Title_25.html'
const IN_T6 = 'https://iga.in.gov/ic/2024/Title_6.html'
const IN_STOP =
  /(?:\n\s*)?(?:\[Pre-\d{4} Recodification Citation|As added by P\.L\.|As amended by P\.L\.|Amended by P\.L\.|Formerly:)/

const esc = (s: string) => s.replace(/\./g, '\\.')

/**
 * Build an article-scoped IN act. `prefix` e.g. '32-21' or '25-34.1'.
 *  - onlyCh: keep only that chapter (e.g. '5' → 32-21-5-*)
 *  - exclCh: keep all chapters EXCEPT that one (e.g. '5' → everything but ch 5)
 * Numeric components allow a decimal (17.5, 8.5, 1.5).
 */
function inAct(
  prefix: string,
  url: string,
  actKey: string,
  lawCategory: LawCategory,
  opts: { onlyCh?: string; exclCh?: string } = {}
): ActSpec {
  const num = '\\d+(?:\\.\\d+)?'
  let chapterPart: string
  if (opts.onlyCh) chapterPart = `${esc(opts.onlyCh)}-${num}`
  else if (opts.exclCh) chapterPart = `(?!${esc(opts.exclCh)}-)${num}-${num}`
  else chapterPart = `${num}-${num}`
  return {
    actKey,
    urls: [url],
    sectionRe: new RegExp(`^IC (${esc(prefix)}-${chapterPart})\\t([^\\t\\n]*)`, 'gm'),
    stopRe: IN_STOP,
    lawCategory,
  }
}

// Indiana Code Title 32 (PROPERTY) — every real-property article. Art 31
// (Landlord-Tenant) is the live L/T corpus and stays in the generated config.
// Arts 33-37, 39 (personal-property liens, lost property, publicity, copyright,
// digital assets) are not real estate and are excluded.
const IN_TITLE32_ACTS: ActSpec[] = [
  inAct('32-16', IN_T32, 'recodification_effect', 'general_real_property'), // Effect of Recodification
  inAct('32-17', IN_T32, 'interests_in_property', 'general_real_property'), // Interests in Property
  inAct('32-17.5', IN_T32, 'disclaimer_property_interests', 'conveyancing_title'), // Uniform Disclaimer
  inAct('32-18', IN_T32, 'creditors_interests', 'mortgage_lien_foreclosure'), // Interests of Creditors
  inAct('32-19', IN_T32, 'property_descriptions', 'conveyancing_title'), // Describing Real Property
  inAct('32-20', IN_T32, 'marketable_title', 'conveyancing_title'), // Marketable Title
  inAct('32-21', IN_T32, 'conveyance_procedures', 'conveyancing_title', { exclCh: '5' }), // Conveyance Procedures (minus disclosures)
  inAct('32-21', IN_T32, 'seller_disclosures', 'environmental_disclosure', { onlyCh: '5' }), // Sale Disclosures (32-21-5)
  inAct('32-22', IN_T32, 'conveyance_limitations', 'conveyancing_title'), // Conveyance Limitations
  inAct('32-23', IN_T32, 'lesser_interests', 'general_real_property'), // Interests Less Than Fee Simple (easements, etc.)
  inAct('32-24', IN_T32, 'eminent_domain', 'land_use_zoning'), // Eminent Domain
  inAct('32-25', IN_T32, 'condominiums', 'condo_coop'), // Condominiums
  inAct('32-25.5', IN_T32, 'homeowners_associations', 'condo_coop'), // Homeowners Associations
  inAct('32-26', IN_T32, 'fences', 'general_real_property'), // Fences
  inAct('32-27', IN_T32, 'construction_warranties', 'general_real_property'), // Construction Warranties
  inAct('32-28', IN_T32, 'liens_real_property', 'mortgage_lien_foreclosure'), // Liens on Real Property
  inAct('32-29', IN_T32, 'mortgages', 'mortgage_lien_foreclosure'), // Mortgages
  inAct('32-30', IN_T32, 'real_property_actions', 'general_real_property'), // Causes of Action re Real Property
  inAct('32-32', IN_T32, 'timeshares_camping_clubs', 'general_real_property'), // Time Shares and Camping Clubs
  inAct('32-32.5', IN_T32, 'campgrounds', 'general_real_property'), // Campgrounds
  inAct('32-38', IN_T32, 'title_insurance', 'conveyancing_title'), // Title Insurance + transfers to trusts
]

// IC 25-34.1 — Real Estate Brokers, Salespersons, Appraisers (Title 25).
const IN_BROKER_ACTS: ActSpec[] = [
  inAct('25-34.1', IN_T25, 'broker_licensing', 'broker_licensing'),
]

// IC 6-1.1 — Property Taxes (Title 6). The whole property-tax code: assessment,
// exemptions, levy, collection, appeals, mobile-home tax (6-1.1-7), tax sales.
const IN_TAX_ACTS: ActSpec[] = [
  inAct('6-1.1', IN_T6, 'property_tax', 'property_tax'),
]

// ---------------------------------------------------------------------------
// Illinois — ILCS, served as one rendered page per Act (ActID). Every act page
// renders sections as "(<ch> ILCS <act>/<sec>) (from …) Sec. <sec>. <catchline>.
// <body> (Source: …)". The shared ILCS regex (same as the landlord_tenant config)
// captures the section number from the citation and consumes the "Sec. N."
// marker so the body opens with the catchline; "(Source:" trims the footer.
// State-level keepRe '^[0-9]' (from the L/T config) is inherited on merge.
// ---------------------------------------------------------------------------
// Tolerate ANY intervening parentheticals between the citation and "Sec." —
// "(from Ch. …)", "(Section scheduled to be repealed on …)", "(text omitted)" —
// otherwise sections with a sunset clause (common in licensing acts) are skipped.
const IL_SECTION_RE = /\(\d+ ILCS \d+\/([0-9]+(?:-[0-9]+)?(?:\.[0-9]+)?)\)(?:\s*\([^)]*\))*\s*Sec\.\s*(?:[0-9][0-9.\-]*\.\s*)?/g
const IL_STOP = /\(Source:/
// ChapAct=FullText renders the entire act on one page — works for multi-article
// acts (Articles?ActID shows only a TOC for those) and is more complete even for
// single-article acts. Universal choice.
const ilUrl = (actId: number, chapterId: number) =>
  `https://www.ilga.gov/Legislation/ILCS/details?ActID=${actId}&ChapterID=${chapterId}&ChapAct=FullText`

function ilAct(actId: number, chapterId: number, actKey: string, lawCategory: LawCategory): ActSpec {
  return { actKey, urls: [ilUrl(actId, chapterId)], sectionRe: new RegExp(IL_SECTION_RE.source, 'g'), stopRe: IL_STOP, lawCategory }
}

// Chapter 765 PROPERTY (ChapterID=62) — every live real-estate act. Landlord/
// tenant acts (765 ILCS 705-755) stay in the L/T config; repealed acts and
// non-real-estate acts (trademark, estrays, unclaimed/lost property, cemeteries,
// abolished common-law doctrines that are repealed) are omitted. [actId, key, cat]
const IL_C765: [number, string, LawCategory][] = [
  [2137, 'conveyances', 'conveyancing_title'],
  [2138, 'seals_re_contracts', 'conveyancing_title'],
  [2139, 'land_patent', 'conveyancing_title'],
  [2140, 'covenants_of_warranty', 'conveyancing_title'],
  [2141, 'acknowledgment_validation', 'conveyancing_title'],
  [2142, 'uniform_acknowledgments', 'conveyancing_title'],
  [2933, 'electronic_recording', 'conveyancing_title'],
  [2144, 'torrens_repeal', 'conveyancing_title'],
  [2145, 'destroyed_public_records', 'conveyancing_title'],
  [2146, 'ag_foreign_investment_disclosure', 'general_real_property'],
  [2148, 'property_owned_by_noncitizens', 'general_real_property'],
  [2149, 'vendor_purchaser_risk', 'conveyancing_title'],
  [3813, 'installment_sales_contract', 'conveyancing_title'],
  [2150, 'dwelling_structure_contract', 'general_real_property'],
  [2151, 'dwelling_unit_installment_contract', 'conveyancing_title'],
  [2152, 'residential_property_disclosure', 'environmental_disclosure'],
  [2153, 'real_estate_sale_validation', 'conveyancing_title'],
  [2157, 'mine_subsidence_disclosure', 'environmental_disclosure'],
  [2160, 'building_loan_mortgage_release', 'mortgage_lien_foreclosure'],
  [2161, 'building_loan_deed_validation', 'conveyancing_title'],
  [2162, 'property_unincorporated_assns', 'general_real_property'],
  [2163, 'conservation_rights', 'general_real_property'],
  [2995, 'environmental_covenants', 'environmental_disclosure'],
  [2164, 'entry_adjoining_land_repairs', 'general_real_property'],
  [2165, 'fence', 'general_real_property'],
  [2166, 'water_dam_use', 'general_real_property'],
  [2167, 'excavation_protection', 'general_real_property'],
  [2168, 'transmission_line_prescriptive', 'general_real_property'],
  [3151, 'industrialized_structure_deed_restriction', 'general_real_property'],
  [3266, 'transfer_fee_covenant', 'conveyancing_title'],
  [3273, 'common_interest_community_assn', 'condo_coop'],
  [3278, 'homeowners_energy_policy', 'condo_coop'],
  [4523, 'homeowners_native_landscaping', 'condo_coop'],
  [3562, 'manufactured_homes_as_real_property', 'conveyancing_title'],
  [4550, 'unfair_service_agreements', 'general_real_property'],
  [2169, 'plat', 'land_use_zoning'],
  [2170, 'judicial_plat', 'land_use_zoning'],
  [2171, 'permanent_survey', 'conveyancing_title'],
  [2172, 'land_survey_monuments', 'conveyancing_title'],
  [4534, 'coordinate_system', 'conveyancing_title'],
  [2174, 'geodetic_survey', 'conveyancing_title'],
  [2180, 'rights_of_entry_reentry', 'general_real_property'],
  [2181, 'surrender_merger_reversion', 'general_real_property'],
  [2182, 'contingent_remainder', 'general_real_property'],
  [2183, 'shelleys_case_abolish', 'general_real_property'],
  [2184, 'worthier_title_abolish', 'general_real_property'],
  [2185, 'land_trust_beneficial_interest_disclosure', 'general_real_property'],
  [3715, 'land_trust_beneficiary_rights', 'general_real_property'],
  [2186, 'land_trust_successor_trustee', 'general_real_property'],
  [2187, 'land_trustee_as_creditor', 'general_real_property'],
  [2188, 'land_trust_recordation', 'general_real_property'],
  [2189, 'building_law_violation_disclosure', 'environmental_disclosure'],
  [2190, 'sale_residential_land_trust', 'conveyancing_title'],
  [2191, 'land_trust_fiduciary_duties', 'general_real_property'],
  [2192, 'mining_1874', 'general_real_property'],
  [2193, 'mineral_lease_release', 'general_real_property'],
  [2194, 'severed_mineral_interest', 'general_real_property'],
  [2195, 'oil_gas_rights', 'general_real_property'],
  [2196, 'oil_gas_recovery', 'general_real_property'],
  [2197, 'drilling_operations', 'general_real_property'],
  [2199, 'coal_rights', 'general_real_property'],
  [2200, 'condominium_property', 'condo_coop'],
  [2907, 'condominium_advisory_council', 'condo_coop'],
  [3587, 'condominium_ombudsperson', 'condo_coop'],
  [2217, 'mortgage', 'mortgage_lien_foreclosure'],
  [2218, 'mortgage_escrow_account', 'mortgage_lien_foreclosure'],
  [2219, 'mortgage_tax_escrow', 'mortgage_lien_foreclosure'],
  [2220, 'mortgage_payment_statement', 'mortgage_lien_foreclosure'],
  [2221, 'mortgage_prepayment_notice', 'mortgage_lien_foreclosure'],
  [2222, 'mortgage_insurance_limitation', 'mortgage_lien_foreclosure'],
  [2223, 'mortgage_certificate_release', 'mortgage_lien_foreclosure'],
  [2795, 'mortgage_rescue_fraud', 'mortgage_lien_foreclosure'],
  [3656, 'reverse_mortgage', 'mortgage_lien_foreclosure'],
  [2224, 'joint_tenancy', 'general_real_property'],
  [2225, 'electricity_gas_joint_ownership', 'general_real_property'],
]

// Chapter 770 LIENS (ChapterID=63) — real-estate-relevant liens only.
const IL_C770: [number, string, LawCategory][] = [
  [2244, 'commercial_re_broker_lien', 'mortgage_lien_foreclosure'],
  [2254, 'mechanics_lien', 'mortgage_lien_foreclosure'],
  [2256, 'oil_gas_lien', 'mortgage_lien_foreclosure'],
  [2262, 'self_service_storage_facility', 'general_real_property'],
  [3903, 'timeshare_lien', 'mortgage_lien_foreclosure'],
]

// Chapter 225 PROFESSIONS (ChapterID=24) — real-estate licensing.
const IL_C225: [number, string, LawCategory][] = [
  [1359, 'home_inspector_license', 'broker_licensing'],
  [1364, 'real_estate_license', 'broker_licensing'],
  [1368, 'real_estate_appraiser_license', 'broker_licensing'],
  [3386, 'appraisal_management_company', 'broker_licensing'],
]

// Chapter 35 REVENUE (ChapterID=8) — property-tax acts only (income/sales/etc.
// excluded). 35 ILCS 200 is the full Property Tax Code; 515/516 are the
// mobile-home services tax (relevant to MH/RV operators).
const IL_C35: [number, string, LawCategory][] = [
  [596, 'property_tax_code', 'property_tax'],
  [607, 'longtime_owner_occupant_tax_relief', 'property_tax'],
  [612, 'mobile_home_local_services_tax', 'property_tax'],
  [613, 'mobile_home_tax_enforcement', 'property_tax'],
]

const IL_BROAD_ACTS: ActSpec[] = [
  ...IL_C765.map(([id, k, c]) => ilAct(id, 62, k, c)),
  ...IL_C770.map(([id, k, c]) => ilAct(id, 63, k, c)),
  ...IL_C225.map(([id, k, c]) => ilAct(id, 24, k, c)),
  ...IL_C35.map(([id, k, c]) => ilAct(id, 8, k, c)),
]

// ---------------------------------------------------------------------------
// Merged export. Append acts per state (the headless ingester concats these
// onto the state's landlord_tenant acts).
// ---------------------------------------------------------------------------
export const BROAD_CONFIGS: Record<string, StateSpec> = {
  IN: { state: 'IN', acts: [...IN_TITLE32_ACTS, ...IN_BROKER_ACTS, ...IN_TAX_ACTS] },
  IL: { state: 'IL', acts: IL_BROAD_ACTS },
}
