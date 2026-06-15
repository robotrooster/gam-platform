/**
 * Maine NON-TAX real-estate statute full-text ingester (sanctioned
 * retrieve+cite+date carve-out — verbatim statutory prose, never advice).
 *
 * Round-2 companion to ingestMEPropertyTax.ts. The first pass MISSED five
 * non-tax categories because triage landed on table-of-contents pages. This
 * ingester DRILLS PAST every TOC: it scrapes each relevant CHAPTER TOC for the
 * per-section anchors, then fetches each SECTION page and parses the body.
 *
 * SOURCE: Maine Revised Statutes, served as per-section static HTML at the
 * official legislature site (raw_http, curl, HTTP 200, text/html, no JS, no
 * auth). The section URL pattern is uniform across titles:
 *   https://legislature.maine.gov/statutes/{TITLE}/title{TITLE}sec{NUM}.html
 * Lettered suffixes hyphenate (sec851-A.html); the Condominium Act uses an
 * article-prefixed numbering scheme (sec1601-103.html). Chapter TOCs live at
 * title{TITLE}ch{CH}sec0.html and list the per-section anchors.
 *
 * Each section page carries:
 *   - <h3 class="heading_section">§NNN. Catchline</h3>   (number + title)
 *   - a run of <div class="mrs-text ..."> body paragraphs (the statutory prose)
 *   - amendment/history annotations inline in square brackets, e.g.
 *     '[PL 2011, c. 4, §1 (AMD).]' — kept inline as source-note metadata.
 * Repealed sections carry <div class="headnote_blip">(REPEALED)</div> and an
 * empty body; those are dropped along with reserved / empty (<20 char) bodies.
 *
 * CATEGORY MAPPING — each row's act_key AND law_category = the category key.
 * The five categories and their official chapter sources:
 *
 *   conveyancing_title        T33 ch7  (Conveyance of Real Estate)
 *                             T33 ch11 (Register of Deeds — recording)
 *                             T33 ch12 (Short Form Deeds Act)
 *   condo_coop                T33 ch31 (Maine Condominium Act, article-prefixed)
 *                             T33 ch10 (Unit Ownership — pre-1983 horizontal-property)
 *   broker_licensing          T32 ch114 (Real Estate Brokerage License Act)
 *                             T32 ch124 (Real Estate Appraisal Licensing & Cert. Act)
 *   mortgage_lien_foreclosure T33 ch9   (Mortgages of Real Property)
 *                             T10 ch603 (mechanic's / construction liens)
 *                             T14 ch713 (foreclosure of real-property mortgages)
 *   general_real_property     T33 ch1,3,5,5-A,17,20,28,28-A (catch-all property)
 *                             T14 ch205 §810-§816 (adverse possession / disseizin)
 *
 * Run: cd apps/api && node -r ts-node/register src/db/ingestMERealEstate.ts
 * Idempotent (ON CONFLICT DO NOTHING).
 */

import { execFileSync } from 'child_process'
import { query } from './index'

const STATE = 'ME'
const SOURCE_DATE = '2026-06-14'
const EFFECTIVE_YEAR = 2026
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) GAM-statute-ingest/1.0'

const tocUrl = (title: number | string, ch: string) =>
  `https://legislature.maine.gov/statutes/${title}/title${title}ch${ch}sec0.html`
const secUrl = (title: number | string, num: string) =>
  `https://legislature.maine.gov/statutes/${title}/title${title}sec${num}.html`

interface Parsed {
  number: string
  title: string | null
  text: string
}

function curl(url: string): string {
  const buf = execFileSync('curl', ['-sL', '--max-time', '60', '-A', UA, url], {
    maxBuffer: 128 * 1024 * 1024,
  })
  return buf.toString('utf-8')
}

/** Decode the handful of HTML entities the ME pages emit, then collapse ws. */
function clean(s: string): string {
  return s
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&rsquo;|&lsquo;/g, "'")
    .replace(/&ldquo;|&rdquo;/g, '"')
    .replace(/&sect;/g, '§')
    .replace(/&mdash;/g, '—')
    .replace(/&ndash;/g, '–')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(parseInt(n, 10)))
    .replace(/[ \t ]+/g, ' ')
    .trim()
}

/**
 * Parse one section page. Heading: <h3 class="heading_section">§NNN. Title</h3>.
 * Body: every <div class="mrs-text ...">…</div> joined by newline. Returns null
 * for repealed / reserved / missing / short bodies.
 */
function parseSectionPage(html: string, expectedNumber: string): Parsed | null {
  // Explicit repealed flag — empty body, (REPEALED) blip.
  if (/<div class="headnote_blip">\s*\(REPEALED\)/i.test(html)) return null

  const hMatch = html.match(/<h3 class="heading_section">([\s\S]*?)<\/h3>/i)
  if (!hMatch) return null
  const heading = clean(hMatch[1])
  // Strip leading "§NNN." citation to derive the title.
  let title: string | null = heading.replace(/^§\s*[0-9A-Za-z.:-]+\.?\s*/, '').trim()
  if (!title) title = null
  if (title && /^repealed\b/i.test(title)) return null
  if (title && /^\[?reserved\.?\]?$/i.test(title)) return null

  const paras = [...html.matchAll(/<div class="mrs-text[^"]*">([\s\S]*?)<\/div>/gi)]
    .map((m) => clean(m[1]))
    .filter(Boolean)
  const text = paras.join('\n').trim()
  if (!text || text.length < 20) return null
  if (/^\[?reserved\.?\]?$/i.test(text)) return null
  if (/^repealed\b/i.test(text)) return null

  return { number: expectedNumber, title, text }
}

/** Scrape per-section anchors (number strings) from a chapter TOC page. */
function harvestChapter(title: number | string, ch: string): string[] {
  const html = curl(tocUrl(title, ch))
  const re = new RegExp(`href="\\.?/?title${title}sec([0-9A-Za-z-]+)\\.html"`, 'gi')
  const seen = new Set<string>()
  const out: string[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) {
    if (!seen.has(m[1])) {
      seen.add(m[1])
      out.push(m[1])
    }
  }
  return out
}

/** Numeric base of a section string for range filtering. Handles article-prefixed
 * condo numbers (e.g. "1601-103" -> 1601) and lettered suffixes ("851-A" -> 851). */
function baseNum(num: string): number {
  const n = parseInt(num.split('-')[0], 10)
  return Number.isFinite(n) ? n : -1
}

interface ChapterSrc {
  title: number | string
  ch: string
  /** Optional [lo,hi] range filter on baseNum — used to slice a partial chapter
   * (e.g. T14 ch205 §810-816 adverse possession out of the larger limitations ch). */
  ranges?: [number, number][]
}

interface Category {
  key: string // act_key === law_category
  label: string
  sources: ChapterSrc[]
}

const CATEGORIES: Category[] = [
  {
    key: 'conveyancing_title',
    label: 'Conveyancing / recording / short-form deeds',
    sources: [
      { title: 33, ch: '7' }, // Conveyance of Real Estate
      { title: 33, ch: '11' }, // Register of Deeds (recording)
      { title: 33, ch: '12' }, // Short Form Deeds Act
    ],
  },
  {
    key: 'condo_coop',
    label: 'Condominium Act + Unit Ownership',
    sources: [
      { title: 33, ch: '31' }, // Maine Condominium Act (article-prefixed numbering)
      { title: 33, ch: '10' }, // Unit Ownership (pre-1983 horizontal-property)
    ],
  },
  {
    key: 'broker_licensing',
    label: 'Brokerage + Appraiser licensing',
    sources: [
      { title: 32, ch: '114' }, // Real Estate Brokerage License Act
      { title: 32, ch: '124' }, // Real Estate Appraisal Licensing & Certification Act
    ],
  },
  {
    key: 'mortgage_lien_foreclosure',
    label: 'Mortgages + mechanic\'s liens + foreclosure procedure',
    sources: [
      { title: 33, ch: '9' }, // Mortgages of Real Property
      { title: 10, ch: '603' }, // mechanic's / construction liens
      { title: 14, ch: '713' }, // foreclosure of real-property mortgages
    ],
  },
  {
    key: 'general_real_property',
    label: 'Catch-all property estates/title + adverse possession',
    sources: [
      { title: 33, ch: '1' }, // Contracts for Sale of Real Estate
      { title: 33, ch: '3' }, // Statute of Frauds
      { title: 33, ch: '5' }, // Rule Against Perpetuities
      { title: 33, ch: '5-A' }, // Uniform Statutory Rule Against Perpetuities
      { title: 33, ch: '17' }, // Joint Tenancies
      { title: 33, ch: '20' }, // Improvident Transfers of Title
      { title: 33, ch: '28' }, // Solar Easements
      { title: 33, ch: '28-A' }, // Solar Rights
      { title: 14, ch: '205', ranges: [[810, 816]] }, // adverse possession / disseizin
    ],
  },
]

interface SecRef {
  title: number | string
  num: string
}

async function ingestCategory(cat: Category): Promise<{ inserted: number; skipped: number; failed: number; harvested: number }> {
  // Harvest all source chapters, applying any range filter, de-duping within the category.
  const seen = new Set<string>() // key = `${title}:${num}`
  const refs: SecRef[] = []
  for (const src of cat.sources) {
    let nums: string[]
    try {
      nums = harvestChapter(src.title, src.ch)
    } catch (e: any) {
      console.warn(`  ! [${cat.key}] TOC harvest failed for T${src.title} ch${src.ch}: ${e?.message || e}`)
      continue
    }
    for (const num of nums) {
      if (src.ranges) {
        const b = baseNum(num)
        if (!src.ranges.some(([lo, hi]) => b >= lo && b <= hi)) continue
      }
      const k = `${src.title}:${num}`
      if (seen.has(k)) continue
      seen.add(k)
      refs.push({ title: src.title, num })
    }
  }

  console.log(`  [${cat.key}] harvested ${refs.length} candidate sections from ${cat.sources.length} chapter(s)`)

  let inserted = 0
  let skipped = 0
  let failed = 0
  const CONC = 4
  for (let i = 0; i < refs.length; i += CONC) {
    if (i > 0) await new Promise((r) => setTimeout(r, 250)) // politeness
    const batch = refs.slice(i, i + CONC)
    const parsed = batch.map((ref) => {
      try {
        return { p: parseSectionPage(curl(secUrl(ref.title, ref.num)), ref.num), ref }
      } catch (e: any) {
        console.warn(`  ! [${cat.key}] T${ref.title} §${ref.num}: ${e?.message || e}`)
        failed++
        return { p: null, ref }
      }
    })
    for (const { p, ref } of parsed) {
      if (!p) {
        skipped++
        continue
      }
      await query(
        `INSERT INTO state_law_section_texts
           (state_code, act_key, section_number, section_title, full_text, source_url, source_date, effective_year, law_category)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (state_code, act_key, section_number, effective_year) DO NOTHING`,
        [STATE, cat.key, p.number, p.title, p.text, secUrl(ref.title, p.number), SOURCE_DATE, EFFECTIVE_YEAR, cat.key]
      )
      inserted++
    }
    process.stdout.write(`\r  [${cat.key}] ${Math.min(i + CONC, refs.length)}/${refs.length}`)
  }
  console.log(`\n  [${cat.key}] inserted ${inserted}, skipped ${skipped}, failed ${failed} of ${refs.length}`)
  return { inserted, skipped, failed, harvested: refs.length }
}

async function main() {
  console.log(`\n=== ME — round-2 ingest of non-tax real-estate statutes (as of ${SOURCE_DATE}) ===`)
  const totals: Record<string, { inserted: number; skipped: number; failed: number; harvested: number }> = {}
  for (const cat of CATEGORIES) {
    console.log(`\n${cat.key} — ${cat.label}`)
    totals[cat.key] = await ingestCategory(cat)
  }
  const grand = Object.values(totals).reduce((a, b) => a + b.inserted, 0)
  console.log(`\nME real-estate done. inserted=${grand}`)
  console.table(totals)
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
