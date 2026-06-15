/**
 * Massachusetts property-tax statute full-text ingester (state-law KB,
 * sanctioned retrieve+cite+date carve-out — verbatim statutory prose, never
 * advice). Source is the OFFICIAL Massachusetts General Laws site,
 * malegislature.gov.
 *
 * SOURCE / FETCHABILITY: raw HTTP GET (curl) — server-rendered HTML, returns
 * 200, no JS needed. Two page types:
 *
 *   - Chapter TOC (https://.../TitleIX/Chapter{N}) lists every section as
 *     <li><a href="/Laws/GeneralLaws/PartI/TitleIX/Chapter{N}/Section{S}">
 *       <span class="section">Section {S}</span>
 *       <span class="sectionTitle">{Title}</span></a></li>
 *     We harvest these anchors to enumerate (number, title) and skip any whose
 *     title begins "Repealed". (Range-grouped repealed entries like "Section 6
 *     to 7A" have no per-section anchor, so they fall out naturally.)
 *
 *   - Section page (.../Section{S}) carries the codified text:
 *       * <h1>Section {S}</h1>                  — section number
 *       * <span class="section">/<span class="sectionTitle"> in breadcrumb, and
 *         <h2 id="skipTo">Section {S}: <small>{Title}</small></h2>            — title
 *       * the BODY is the run of <p> elements after that <h2 id="skipTo">, up to
 *         the content-column close. Effective-date editorial notes appear as
 *         <p><i>[...]</i></p> blocks bracketed with '[...]' and are stripped.
 *     We slice the substring between <h2 id="skipTo"> and the closing of the
 *     inner content column, drop bracketed editorial notes, then stripTags.
 *
 * SECTION-NUMBER NAMESPACING: act_key is the single value 'property_tax' across
 * all five chapters (58, 58A, 59, 60). Chapters 59 and 60 both have low section
 * numbers (5, 16, 57, 62…), so a bare section_number collides under the
 * (state_code, act_key, section_number, effective_year) unique constraint. We
 * namespace section_number as 'c{N}-{S}' (e.g. 'c59-57', 'c60-16'). The
 * human-readable citation ("M.G.L. c. 59, § 57 — {title}") goes in
 * section_title.
 *
 * TOPIC COVERAGE (from triage hints — five feature-chapter groups):
 *   exemptions            c59 §§ 5, 5A, 5B, 5C, 5K
 *   assessment            c59 §§ 2-2D, 11-25, 21C, 38-43
 *   assessment_review     c59 §§ 59-65 ; c58A §§ 1-14
 *   levy_collection_pay   c59 §§ 57, 57C ; c60 §§ 1-42
 *   delinquency_tax_sale  c60 §§ 16-17, 37-50, 53-56, 62-77
 *
 * Run: cd apps/api && node -r ts-node/register src/db/ingestMAPropertyTax.ts
 * Idempotent (ON CONFLICT DO NOTHING). Repealed / reserved / empty / short
 * (<20 char) / TOC bodies are dropped.
 */

import { execFileSync } from 'child_process'
import { query } from './index'
import { stripTags } from './ingestStateLawCorpus'

const STATE = 'MA'
const ACT_KEY = 'property_tax'
const LAW_CATEGORY = 'property_tax'
const SOURCE_DATE = '2026-06-14'
const EFFECTIVE_YEAR = 2026
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) GAM-statute-ingest/1.0 (compliance research)'
const BASE = 'https://malegislature.gov/Laws/GeneralLaws/PartI/TitleIX'

const chapterUrl = (n: string) => `${BASE}/Chapter${n}`
// URL form: fractional sections use a tilde for the slash (e.g. 5C1/2 → 5C1~2);
// the section number as stored keeps the human "1/2" rendering from the page.
const sectionUrl = (n: string, secUrlPart: string) => `${BASE}/Chapter${n}/Section${secUrlPart}`

interface SecRef {
  chapter: string
  numberLabel: string // human label as shown, e.g. "57", "5C", "21A1/2"
  urlPart: string // URL fragment, e.g. "57", "5C", "21A1~2"
  title: string | null
}

function curl(url: string): string {
  const buf = execFileSync('curl', ['-sL', '--max-time', '60', '-A', UA, url], {
    maxBuffer: 256 * 1024 * 1024,
  })
  return buf.toString('utf-8')
}

/**
 * Enumerate section anchors from a chapter TOC page. Each anchor is
 *   <a href="/Laws/.../Chapter{N}/Section{URLPART}">
 *     <span class="section">Section {LABEL}</span>
 *     <span class="sectionTitle">{TITLE}</span></a>
 * We capture URLPART (for fetching), LABEL (human number) and TITLE. Skip
 * entries whose title begins "Repealed". De-dupe by URLPART.
 */
function enumerateSections(html: string, chapter: string): SecRef[] {
  const re = new RegExp(
    `<a[^>]*href="/Laws/GeneralLaws/PartI/TitleIX/Chapter${chapter}/Section([0-9A-Za-z~]+)"[^>]*>\\s*` +
      `<span class="section">\\s*Section\\s*([^<]*?)\\s*</span>\\s*` +
      `<span class="sectionTitle">\\s*([\\s\\S]*?)\\s*</span>`,
    'gi'
  )
  const seen = new Set<string>()
  const out: SecRef[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) {
    const urlPart = m[1]
    if (seen.has(urlPart)) continue
    seen.add(urlPart)
    const numberLabel = stripTags(m[2], false).trim()
    let title: string | null = stripTags(m[3], false).trim()
    if (!title) title = null
    if (title && /^repealed\b/i.test(title)) continue
    out.push({ chapter, numberLabel, urlPart, title })
  }
  return out
}

/**
 * Parse the codified body out of a section page. Isolate the region from after
 * <h2 id="skipTo">...</h2> to the inner content-column close, drop the
 * editorial-note <i>[...]</i> blocks, then stripTags. Returns null for an
 * empty / repealed / too-short body.
 */
function parseSectionBody(html: string): string | null {
  // Confirm this is a section page, not a TOC: it must carry the skipTo header.
  const skip = html.search(/<h2[^>]*id="skipTo"[^>]*>/i)
  if (skip === -1) return null

  // Body starts after the closing </h2> of the skipTo header.
  const afterH2 = html.indexOf('</h2>', skip)
  if (afterH2 === -1) return null
  let region = html.slice(afterH2 + 5)

  // Cut at the trailing initJsTree script / content-column close. The body <p>
  // run is always followed by the closing </div>s and then the <script> with
  // initJsTree(...). Truncate at the first <script that contains initJsTree,
  // else at the footer, else leave (stripTags drops scripts anyway).
  const jsTree = region.search(/<script[\s\S]*?initJsTree/i)
  if (jsTree !== -1) region = region.slice(0, jsTree)
  const footer = region.search(/<footer\b/i)
  if (footer !== -1) region = region.slice(0, footer)

  // Strip effective-date editorial notes: <i>[ ... ]</i> blocks (may be wrapped
  // in stray <p> tags). These are NOT statutory text. Remove the bracketed
  // italic note content wholesale.
  region = region.replace(/<i>\s*(?:<p>)?\s*\[[\s\S]*?\]\s*(?:<\/p>)?\s*<\/i>/gi, ' ')
  // Belt-and-suspenders: drop any remaining standalone bracketed editorial line.
  region = region.replace(/<p>\s*\[[^\]]*\]\s*<\/p>/gi, ' ')

  const text = stripTags(region, true)
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .join('\n')
    .trim()

  if (!text || text.length < 20) return null
  if (/^\[?reserved\.?\]?$/i.test(text)) return null
  if (/^repealed\b/i.test(text)) return null
  return text
}

/** Range membership for numeric portions of MA section labels. A label like
 *  "5C", "21A", "2D" has a numeric stem (5, 21, 2) plus an alpha/fraction tail.
 *  We include a label if its numeric stem is in [lo, hi]. Explicit-number sets
 *  (exact labels) are handled separately by the caller. */
function numericStem(label: string): number {
  const m = label.match(/^([0-9]+)/)
  return m ? parseInt(m[1], 10) : NaN
}

interface Topic {
  topic: string
  chapter: string
  // Either a range [lo, hi] (inclusive, by numeric stem) or an explicit label set.
  ranges?: Array<[number, number]>
  explicit?: string[] // exact numberLabel values (e.g. "5", "5A", "57C")
}

// Topic → chapter → section selection. A SecRef is included for a chapter if its
// numberLabel matches any range (by numeric stem) OR any explicit label for that
// chapter+topic. We keep the full set of anchors per chapter and filter.
const TOPICS: Topic[] = [
  // exemptions — c59 §§ 5, 5A, 5B, 5C, 5K  (plus the many 5-suffixed clauses
  // share stem 5; we keep stem==5 to capture 5, 5A, 5B, 5C, 5K and siblings)
  { topic: 'exemptions', chapter: '59', ranges: [[5, 5]] },
  // assessment — c59 §§ 2-2D, 11-25, 21C, 38-43
  { topic: 'assessment', chapter: '59', ranges: [[2, 2], [11, 25], [38, 43]] },
  // assessment_review — c59 §§ 59-65 ; c58A §§ 1-14
  { topic: 'assessment_review', chapter: '59', ranges: [[59, 65]] },
  { topic: 'assessment_review', chapter: '58A', ranges: [[1, 14]] },
  // levy_collection_payment — c59 §§ 57, 57C ; c60 §§ 1-42
  { topic: 'levy_collection_payment', chapter: '59', explicit: ['57', '57A', '57B', '57C'] },
  { topic: 'levy_collection_payment', chapter: '60', ranges: [[1, 42]] },
  // delinquency_tax_sale — c60 §§ 16-17, 37-50, 53-56, 62-77
  { topic: 'delinquency_tax_sale', chapter: '60', ranges: [[16, 17], [37, 50], [53, 56], [62, 77]] },
]

function matchesTopic(ref: SecRef, t: Topic): boolean {
  if (t.explicit && t.explicit.includes(ref.numberLabel)) return true
  if (t.ranges) {
    const stem = numericStem(ref.numberLabel)
    if (Number.isFinite(stem)) {
      for (const [lo, hi] of t.ranges) if (stem >= lo && stem <= hi) return true
    }
  }
  return false
}

async function main() {
  console.log(`\n=== MA — ingesting property-tax full-text corpus (as of ${SOURCE_DATE}) ===`)

  // 1) Fetch + enumerate each chapter TOC once.
  const chapters = ['58', '58A', '59', '60']
  const byChapter: Record<string, SecRef[]> = {}
  for (const c of chapters) {
    const refs = enumerateSections(curl(chapterUrl(c)), c)
    byChapter[c] = refs
    console.log(`  Chapter ${c}: enumerated ${refs.length} live (non-repealed) sections`)
  }

  // 2) Build the de-duplicated set of (chapter, section) refs to fetch, tagging
  //    each with the topic(s) it serves. A ref may serve multiple topics; we
  //    fetch ONCE per (chapter, numberLabel) and report topic coverage.
  const selected = new Map<string, SecRef>() // key = `${chapter}|${urlPart}`
  const topicCounts: Record<string, number> = {}
  for (const t of TOPICS) {
    const refs = byChapter[t.chapter] || []
    for (const ref of refs) {
      if (!matchesTopic(ref, t)) continue
      topicCounts[t.topic] = (topicCounts[t.topic] || 0) + 1
      selected.set(`${ref.chapter}|${ref.urlPart}`, ref)
    }
  }
  console.log('  Selected per topic (pre-fetch, anchor counts):', topicCounts)
  const refs = [...selected.values()]
  console.log(`  Total distinct sections to fetch: ${refs.length}`)

  // 3) Fetch + parse + insert.
  let ok = 0
  let skipped = 0
  const failures: string[] = []
  const CONC = 4
  for (let i = 0; i < refs.length; i += CONC) {
    if (i > 0) await new Promise((r) => setTimeout(r, 250)) // politeness
    const batch = refs.slice(i, i + CONC)
    const parsed = await Promise.all(
      batch.map(async (ref) => {
        const url = sectionUrl(ref.chapter, ref.urlPart)
        try {
          const body = parseSectionBody(curl(url))
          return { ref, url, body }
        } catch (e: any) {
          failures.push(`c${ref.chapter} §${ref.numberLabel}: ${e?.message || e}`)
          return { ref, url, body: null as string | null }
        }
      })
    )
    for (const { ref, url, body } of parsed) {
      if (!body) {
        skipped++
        continue
      }
      const sectionNumber = `c${ref.chapter}-${ref.numberLabel}`
      const citation = `M.G.L. c. ${ref.chapter}, § ${ref.numberLabel}`
      const title = ref.title ? `${citation} — ${ref.title}` : citation
      await query(
        `INSERT INTO state_law_section_texts
           (state_code, act_key, section_number, section_title, full_text, source_url, source_date, effective_year, law_category)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (state_code, act_key, section_number, effective_year) DO NOTHING`,
        [STATE, ACT_KEY, sectionNumber, title, body, url, SOURCE_DATE, EFFECTIVE_YEAR, LAW_CATEGORY]
      )
      ok++
    }
    process.stdout.write(`\r  fetched ${Math.min(i + CONC, refs.length)}/${refs.length}`)
  }
  console.log(`\n  inserted ${ok}, skipped ${skipped} of ${refs.length}`)
  if (failures.length) {
    console.log(`  FAILURES (${failures.length}):`)
    for (const f of failures) console.log(`    ! ${f}`)
  }

  console.log(`\nMA done. inserted(attempted)=${ok}`)
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
