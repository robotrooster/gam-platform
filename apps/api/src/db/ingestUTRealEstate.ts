/**
 * Utah non-tax real-estate statute full-text ingester (5-category corpus).
 *
 * Sanctioned retrieve+cite+date carve-out: GAM stores the VERBATIM text of each
 * statute section so the agent can quote + cite + date it — never advise. Source
 * is the OFFICIAL Utah Code at le.utah.gov/xcode ONLY.
 *
 * SITE SHAPE (le.utah.gov/xcode — static, raw_http):
 *   Each chapter has a landing page  Title{T}/Chapter{Dir}/{T}-{Ch}.html  whose
 *   <head> inline script declares  var versionArr = [['C{T}-{Ch}_{stamp}.html',
 *   'Current Version', ...]];  — regex-extract {stamp}. The same directory then
 *   serves a CHAPTER-LEVEL XML download  C{T}-{Ch}_{stamp}.xml  containing the
 *   whole chapter as a clean structured tree:
 *       <chapter number="57-1"><catchline>..</catchline>
 *         [<part number="57-1-1"><catchline>..</catchline>]
 *           <section number="57-1-1">
 *             <effdate>../histories>/<catchline>Title.</catchline>
 *             <tab/>body...<subsection number="..">body</subsection>...
 *           </section> ...
 *   This ONE artifact per chapter is the cleanest path — no per-section fetch,
 *   no section enumeration. Part-based chapters keep a FLAT <section> set nested
 *   under <part>, so part scoping = split the XML on <part ...> boundaries and
 *   keep only the target parts (used for the big Title78B chapters where only a
 *   couple of parts are real-property law).
 *
 * DIRECTORY-CASE QUIRKS (encoded in CHAPTERS below):
 *   - Trailing letter chapters: directory uppercases it (Chapter8A, Chapter2F,
 *     Chapter1A) while filenames keep it lowercase (57-8a, 61-2f, 38-1a).
 *   - Most chapters share stamp 1800010118000101, but newer/older chapters carry
 *     their own stamp — so the stamp is ALWAYS resolved live from the landing
 *     page, never hardcoded.
 *
 * CATEGORY MAP (act_key == law_category for every block; NO chapter is ingested
 * under two categories — single source of truth):
 *   conveyancing_title        Title57 Ch1 (Conveyances), Ch3 (Recording)
 *   condo_coop                Title57 Ch8 (Condominium Ownership Act),
 *                             Ch8a (Community Association Act / common-interest;
 *                             UT has no separate stock-cooperative act)
 *   broker_licensing          Title61 Ch2f (Real Estate Licensing & Practices),
 *                             Ch2g (Appraiser Licensing & Certification)
 *   mortgage_lien_foreclosure Title38 Ch1a (Preconstruction & Construction Liens),
 *                             Title78B Ch6 Part 9 (Mortgage Foreclosure).
 *                             NOTE: trust-deed / nonjudicial-foreclosure sections
 *                             physically live in Title57 Ch1 (57-1-19..) which is
 *                             ingested whole under conveyancing_title; not
 *                             duplicated here to honor the unique key.
 *   general_real_property     Residual Title57 real-property chapters NOT claimed
 *                             above and NOT landlord/tenant (which belongs to the
 *                             separate landlord_tenant category): Ch2/2a/4a/6/9/
 *                             10/11/12/13/13a/13b/13c/14/18/19/20/21/23/24/25/26/
 *                             27/28/29/30/31; PLUS Title78B Ch2 Part 2 (Real
 *                             Property statutes of limitation / adverse possession)
 *                             and Title78B Ch6 Part 8 + 8a (Forcible Entry &
 *                             Detainer + Expungement of Eviction Records).
 *
 * Repealed/reserved/empty(<20 char)/metadata-only sections are dropped.
 *
 * Run:  cd apps/api && node -r ts-node/register src/db/ingestUTRealEstate.ts
 * Idempotent (ON CONFLICT DO NOTHING).
 */

import { execFileSync } from 'child_process'
import { query } from './index'
import { decodeEntities } from './ingestStateLawCorpus'

const STATE = 'UT'
const SOURCE_DATE = '2026-06-14'
const EFFECTIVE_YEAR = 2026
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) GAM-statute-ingest/1.0'
const BASE = 'https://le.utah.gov/xcode'

interface ChapterSpec {
  category: string
  title: number // 57, 61, 38, 78 (for 78B titleDir below)
  titleDir: string // 'Title57', 'Title61', 'Title38', 'Title78B'
  chapterDir: string // 'Chapter1', 'Chapter8A', 'Chapter2F', 'Chapter1A'
  chapter: string // '57-1', '57-8a', '61-2f', '38-1a', '78B-2', '78B-6'
  parts?: string[] // if set, keep ONLY sections under these <part number=> values
  label: string // human note (for logs)
}

// ---------------------------------------------------------------------------
// Category → chapter source map. act_key == category for the INSERT.
// ---------------------------------------------------------------------------
const CHAPTERS: ChapterSpec[] = [
  // conveyancing_title
  { category: 'conveyancing_title', title: 57, titleDir: 'Title57', chapterDir: 'Chapter1', chapter: '57-1', label: 'Conveyances' },
  { category: 'conveyancing_title', title: 57, titleDir: 'Title57', chapterDir: 'Chapter3', chapter: '57-3', label: 'Recording of Documents' },

  // condo_coop
  { category: 'condo_coop', title: 57, titleDir: 'Title57', chapterDir: 'Chapter8', chapter: '57-8', label: 'Condominium Ownership Act' },
  { category: 'condo_coop', title: 57, titleDir: 'Title57', chapterDir: 'Chapter8A', chapter: '57-8a', label: 'Community Association Act' },

  // broker_licensing
  { category: 'broker_licensing', title: 61, titleDir: 'Title61', chapterDir: 'Chapter2F', chapter: '61-2f', label: 'Real Estate Licensing and Practices Act' },
  { category: 'broker_licensing', title: 61, titleDir: 'Title61', chapterDir: 'Chapter2G', chapter: '61-2g', label: 'Real Estate Appraiser Licensing and Certification Act' },

  // mortgage_lien_foreclosure
  { category: 'mortgage_lien_foreclosure', title: 38, titleDir: 'Title38', chapterDir: 'Chapter1A', chapter: '38-1a', label: 'Preconstruction and Construction Liens' },
  { category: 'mortgage_lien_foreclosure', title: 78, titleDir: 'Title78B', chapterDir: 'Chapter6', chapter: '78B-6', parts: ['78B-6-9'], label: 'Mortgage Foreclosure (Title78B Ch6 Pt9)' },

  // general_real_property — residual Title57 real-property chapters
  { category: 'general_real_property', title: 57, titleDir: 'Title57', chapterDir: 'Chapter2', chapter: '57-2', label: 'Acknowledgments' },
  { category: 'general_real_property', title: 57, titleDir: 'Title57', chapterDir: 'Chapter2A', chapter: '57-2a', label: 'Recognition of Acknowledgments Act' },
  { category: 'general_real_property', title: 57, titleDir: 'Title57', chapterDir: 'Chapter4A', chapter: '57-4a', label: 'Effects of Recording' },
  { category: 'general_real_property', title: 57, titleDir: 'Title57', chapterDir: 'Chapter6', chapter: '57-6', label: 'Occupying Claimants' },
  { category: 'general_real_property', title: 57, titleDir: 'Title57', chapterDir: 'Chapter9', chapter: '57-9', label: 'Marketable Record Title' },
  { category: 'general_real_property', title: 57, titleDir: 'Title57', chapterDir: 'Chapter10', chapter: '57-10', label: 'Utah Coordinate System' },
  { category: 'general_real_property', title: 57, titleDir: 'Title57', chapterDir: 'Chapter11', chapter: '57-11', label: 'Utah Uniform Land Sales Practices Act' },
  { category: 'general_real_property', title: 57, titleDir: 'Title57', chapterDir: 'Chapter12', chapter: '57-12', label: 'Utah Relocation Assistance Act' },
  { category: 'general_real_property', title: 57, titleDir: 'Title57', chapterDir: 'Chapter13', chapter: '57-13', label: 'Solar Easements' },
  { category: 'general_real_property', title: 57, titleDir: 'Title57', chapterDir: 'Chapter13A', chapter: '57-13a', label: 'Easement for Water Conveyance' },
  { category: 'general_real_property', title: 57, titleDir: 'Title57', chapterDir: 'Chapter13B', chapter: '57-13b', label: 'Easement for Historical Livestock Trail Act' },
  { category: 'general_real_property', title: 57, titleDir: 'Title57', chapterDir: 'Chapter13C', chapter: '57-13c', label: 'Uniform Easement Relocation Act' },
  { category: 'general_real_property', title: 57, titleDir: 'Title57', chapterDir: 'Chapter14', chapter: '57-14', label: 'Limitations on Landowner Liability' },
  { category: 'general_real_property', title: 57, titleDir: 'Title57', chapterDir: 'Chapter18', chapter: '57-18', label: 'Land Conservation Easement Act' },
  { category: 'general_real_property', title: 57, titleDir: 'Title57', chapterDir: 'Chapter19', chapter: '57-19', label: 'Timeshare and Camp Resort Act' },
  { category: 'general_real_property', title: 57, titleDir: 'Title57', chapterDir: 'Chapter20', chapter: '57-20', label: 'Local Rent Control Prohibition' },
  { category: 'general_real_property', title: 57, titleDir: 'Title57', chapterDir: 'Chapter21', chapter: '57-21', label: 'Utah Fair Housing Act' },
  { category: 'general_real_property', title: 57, titleDir: 'Title57', chapterDir: 'Chapter23', chapter: '57-23', label: 'Real Estate Cooperative Marketing Act' },
  { category: 'general_real_property', title: 57, titleDir: 'Title57', chapterDir: 'Chapter24', chapter: '57-24', label: 'Display of Flag' },
  { category: 'general_real_property', title: 57, titleDir: 'Title57', chapterDir: 'Chapter25', chapter: '57-25', label: 'Uniform Environmental Covenants Act' },
  { category: 'general_real_property', title: 57, titleDir: 'Title57', chapterDir: 'Chapter26', chapter: '57-26', label: 'Utah Uniform Assignment of Rents Act' },
  { category: 'general_real_property', title: 57, titleDir: 'Title57', chapterDir: 'Chapter27', chapter: '57-27', label: 'Disclosure of Methamphetamine Contaminated Property Act' },
  { category: 'general_real_property', title: 57, titleDir: 'Title57', chapterDir: 'Chapter28', chapter: '57-28', label: 'Utah Reverse Mortgage Act' },
  { category: 'general_real_property', title: 57, titleDir: 'Title57', chapterDir: 'Chapter29', chapter: '57-29', label: 'Undivided Fractionalized Long-term Estate Sales Practices Act' },
  { category: 'general_real_property', title: 57, titleDir: 'Title57', chapterDir: 'Chapter30', chapter: '57-30', label: 'Residential Property Service Agreements' },
  { category: 'general_real_property', title: 57, titleDir: 'Title57', chapterDir: 'Chapter31', chapter: '57-31', label: 'Fraudulent Deeds Act' },
  // general_real_property — Title78B real-property procedure
  { category: 'general_real_property', title: 78, titleDir: 'Title78B', chapterDir: 'Chapter2', chapter: '78B-2', parts: ['78B-2-2'], label: 'Statutes of Limitations — Real Property (Pt2)' },
  { category: 'general_real_property', title: 78, titleDir: 'Title78B', chapterDir: 'Chapter6', chapter: '78B-6', parts: ['78B-6-8', '78B-6-8a'], label: 'Forcible Entry & Detainer + Eviction Expungement (Pt8/8a)' },
]

interface ParsedSection {
  number: string
  title: string | null
  text: string
}

function curl(url: string): string {
  const buf = execFileSync('curl', ['-sL', '--max-time', '90', '-A', UA, url], {
    maxBuffer: 256 * 1024 * 1024,
  })
  return buf.toString('utf-8')
}

/** Landing page → current-version chapter stamp from the versionArr inline script. */
function resolveStamp(spec: ChapterSpec): string | null {
  const landing = `${BASE}/${spec.titleDir}/${spec.chapterDir}/${spec.chapter}.html`
  const html = curl(landing)
  // var versionArr = [['C57-1_1800010118000101.html','Current Version',...]]
  const re = new RegExp(`C${spec.chapter}_([0-9]+)\\.html`, 'i')
  const m = html.match(re)
  return m ? m[1] : null
}

/**
 * Turn the XML body of ONE <section>…</section> (with the leading metadata
 * already removed) into clean verbatim prose:
 *   - <xref ...>text</xref>  → text (keep the cited reference's display text)
 *   - <tab/>                 → space
 *   - <subsection number=>   → newline-delimited block (preserve list structure)
 *   - </subsection>          → newline
 *   - any residual tag       → space
 * then decode entities + normalize whitespace.
 */
function xmlBodyToText(inner: string): string {
  let s = inner
  s = s.replace(/<tab\s*\/>/gi, ' ')
  // unwrap xref keeping its display text
  s = s.replace(/<xref\b[^>]*>([\s\S]*?)<\/xref>/gi, '$1')
  // subsection boundaries → newlines so enumerated lists stay readable
  s = s.replace(/<subsection\b[^>]*>/gi, '\n')
  s = s.replace(/<\/subsection>/gi, '\n')
  // strip any remaining tags
  s = s.replace(/<[^>]+>/g, ' ')
  s = decodeEntities(s)
  s = s
    .replace(/[  -   　]/g, ' ')
    .replace(/\r/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
  return s.trim()
}

/**
 * Parse every <section> in a chapter XML. If parts[] is set, keep only the
 * sections nested under those <part number=> blocks (split on <part boundaries).
 */
function parseChapterXml(xml: string, spec: ChapterSpec): ParsedSection[] {
  // Restrict to target parts if scoped.
  let scope = xml
  if (spec.parts && spec.parts.length) {
    const blocks = xml.split(/(?=<part\b[^>]*>)/i)
    const kept: string[] = []
    for (const blk of blocks) {
      const pm = blk.match(/^<part\s+number="([^"]+)"/i)
      if (pm && spec.parts.includes(pm[1])) kept.push(blk)
    }
    scope = kept.join('')
  }

  const out: ParsedSection[] = []
  const secRe = /<section\s+number="([^"]+)">([\s\S]*?)<\/section>/gi
  let m: RegExpExecArray | null
  while ((m = secRe.exec(scope)) !== null) {
    const number = m[1].trim()
    let inner = m[2]

    // Pull the catchline (section title), then drop the metadata blocks
    // (<effdate>, <histories>, the first <catchline>) so only body remains.
    const clMatch = inner.match(/<catchline>([\s\S]*?)<\/catchline>/i)
    let title: string | null = clMatch ? decodeEntities(clMatch[1].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim() : null
    if (title === '') title = null

    inner = inner.replace(/<effdate>[\s\S]*?<\/effdate>/gi, '')
    inner = inner.replace(/<histories>[\s\S]*?<\/histories>/gi, '')
    // remove ONLY the first (section-level) catchline; sub-catchlines are rare
    // but if present belong to the body — however Utah uses catchline only at
    // section level, so removing all <catchline> here is safe and clean.
    inner = inner.replace(/<catchline>[\s\S]*?<\/catchline>/gi, '')

    const text = xmlBodyToText(inner)

    // Drop repealed / reserved / empty / metadata-only.
    if (!text || text.length < 20) continue
    if (/^\(?(repealed|reserved)\b/i.test(text)) continue
    if (title && /^repealed\b/i.test(title)) continue
    if (title && /^\[?reserved\.?\]?$/i.test(title)) continue

    out.push({ number, title, text })
  }
  return out
}

async function ingestChapter(spec: ChapterSpec): Promise<{ ok: number; found: number }> {
  const stamp = resolveStamp(spec)
  if (!stamp) {
    console.warn(`  ! ${spec.chapter} (${spec.label}): NO STAMP — skipped`)
    return { ok: 0, found: 0 }
  }
  const xmlUrl = `${BASE}/${spec.titleDir}/${spec.chapterDir}/C${spec.chapter}_${stamp}.xml`
  let xml: string
  try {
    xml = curl(xmlUrl)
  } catch (e: any) {
    console.warn(`  ! ${spec.chapter} fetch failed: ${e?.message || e}`)
    return { ok: 0, found: 0 }
  }
  if (!/<chapter\b/i.test(xml)) {
    console.warn(`  ! ${spec.chapter}: XML missing <chapter> root (${xmlUrl})`)
    return { ok: 0, found: 0 }
  }

  const sections = parseChapterXml(xml, spec)
  // Public web URL per section (citation target the agent surfaces to users).
  const srcBase = `https://le.utah.gov/xcode/${spec.titleDir}/${spec.chapterDir}`
  let ok = 0
  for (const sec of sections) {
    const sourceUrl = `${srcBase}/${sec.number.replace(/^(\d+[A-Za-z]?-\d+[A-Za-z]?)-/, '$1-S')}.html`
    await query(
      `INSERT INTO state_law_section_texts
         (state_code, act_key, section_number, section_title, full_text, source_url, source_date, effective_year, law_category)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (state_code, act_key, section_number, effective_year) DO NOTHING`,
      [STATE, spec.category, sec.number, sec.title, sec.text, sourceUrl, SOURCE_DATE, EFFECTIVE_YEAR, spec.category]
    )
    ok++
  }
  console.log(`  [${spec.category}] ${spec.chapter} (${spec.label}): ${ok}/${sections.length} sections`)
  return { ok, found: sections.length }
}

async function main() {
  console.log(`\n=== UT — ingesting non-tax real-estate corpus (official le.utah.gov, as of ${SOURCE_DATE}) ===`)
  const byCat: Record<string, number> = {}
  for (const spec of CHAPTERS) {
    const { ok } = await ingestChapter(spec)
    byCat[spec.category] = (byCat[spec.category] || 0) + ok
    await new Promise((r) => setTimeout(r, 250)) // politeness
  }
  const total = Object.values(byCat).reduce((a, b) => a + b, 0)
  console.log(`\nUT done. inserted (attempted, pre-conflict)=${total}`, byCat)
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
