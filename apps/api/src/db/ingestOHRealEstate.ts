/**
 * Ohio non-tax real-estate statute full-text ingester.
 *
 * Sanctioned retrieve+cite+date carve-out: verbatim official statute text,
 * never advice. Source = the State of Ohio's official codes portal
 * (codes.ohio.gov / "Ohio Laws"), which serves server-rendered static HTML —
 * plain raw_http with a browser UA, no JS render required.
 *
 * SOURCE LAYOUT (per section page, e.g. /ohio-revised-code/section-5301.01):
 *   - <h1>Section NNNN.NN <span class='codes-separator'>|</span> Catchline.</h1>
 *       → the number (after "Section ") and the catchline (after the separator).
 *   - <section class="laws-body"> … statute prose … </section>
 *       → the verbatim body. Statute text only; the surrounding "laws-section-
 *         info" modules (Effective Date, Latest Legislation, Download PDF links)
 *         live OUTSIDE this <section>, so selecting only laws-body keeps chrome,
 *         nav, and metadata out of full_text.
 *
 * ENUMERATION: each chapter has an index page /ohio-revised-code/chapter-CHHH
 * that links every section as href=".../section-CHHH.NN". We regex
 * 'section-CHHH\.[0-9]+' on the index (de-duped), then GET each section page.
 * Sub-numbered sections (4735.021, 1311.011, 5301.255) are captured by the
 * digit class after the dot.
 *
 * CATEGORY → CHAPTER MAPPING (law_category === act_key for every block):
 *   conveyancing_title        = Ch. 5301 (conveyances/encumbrances), 5302
 *                               (statutory land-conveyance forms), 5309 + 5310
 *                               (registration of land titles).
 *   condo_coop                = Ch. 5311 (Ohio Condominium Act) + 5312 (Ohio
 *                               Planned Community Law / HOA analog). No OH
 *                               cooperative-apartment act exists.
 *   broker_licensing          = Ch. 4735 (real estate brokers). Appraisers
 *                               (4763) / auctioneers (4707) are distinct and not
 *                               pulled.
 *   mortgage_lien_foreclosure = Ch. 1311 (mechanic's/construction & other liens)
 *                               + 2329 (execution against property / judicial
 *                               foreclosure sale). Mortgage form/recording
 *                               substance lives in 5301 (counted under
 *                               conveyancing_title) — not double-pulled here.
 *   general_real_property     = remaining Title 53 chapters: 5303 (actions re
 *                               realty / quiet title / adverse possession), 5305
 *                               (dower), 5307 (partition), 5313 (land installment
 *                               contracts), 5321 (landlords and tenants), 5322
 *                               (storage facilities), 5323 (residential rental
 *                               property registration).
 *
 * No chapter is assigned to two categories, so there is no cross-category
 * duplication. (Within a run, the per-section ON CONFLICT DO NOTHING also makes
 * re-runs idempotent.)
 *
 * DROP RULES: repealed / reserved / empty / <20-char bodies, and any page that
 * has no laws-body / no catchline.
 *
 * Run: cd apps/api && node -r ts-node/register src/db/ingestOHRealEstate.ts
 */

import { execFileSync } from 'child_process'
import { query } from './index'
import { stripTags } from './ingestStateLawCorpus'

const STATE = 'OH'
const SOURCE_DATE = '2026-06-14'
const EFFECTIVE_YEAR = 2026
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) GAM-statute-ingest/1.0'
const BASE = 'https://codes.ohio.gov/ohio-revised-code'

/** category key (== act_key) → list of ORC chapters to enumerate. */
const CATEGORIES: Record<string, string[]> = {
  conveyancing_title: ['5301', '5302', '5309', '5310'],
  condo_coop: ['5311', '5312'],
  broker_licensing: ['4735'],
  mortgage_lien_foreclosure: ['1311', '2329'],
  general_real_property: ['5303', '5305', '5307', '5313', '5321', '5322', '5323'],
}

interface Parsed { number: string; title: string | null; text: string }

function curlOnce(url: string): string {
  const buf = execFileSync('curl', ['-sL', '--max-time', '90', '-A', UA, url], {
    maxBuffer: 256 * 1024 * 1024,
  })
  return buf.toString('utf-8')
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * Fetch with retry + backoff. codes.ohio.gov intermittently throttles rapid
 * sequential requests and returns a body that lacks the section <h1> /
 * laws-body markers entirely (an error/blocked page, NOT a real repealed
 * statute). We treat "looks like a section page" as the success signal: a page
 * that contains both an <h1> and a laws-body OR a chapter index that contains
 * any section anchor. Retry up to `tries` with exponential backoff otherwise.
 */
async function curl(url: string, looksValid: (html: string) => boolean, tries = 5): Promise<string> {
  let last = ''
  for (let t = 0; t < tries; t++) {
    if (t > 0) await sleep(800 * t) // 0.8s, 1.6s, 2.4s, 3.2s backoff
    try {
      last = curlOnce(url)
      if (looksValid(last)) return last
    } catch {
      // network/timeout — fall through to retry
    }
  }
  return last
}

/** A real section page always carries both an <h1> and a laws-body section. */
const isSectionPage = (html: string) =>
  /<h1>[\s\S]*?<\/h1>/i.test(html) && /class="[^"]*laws-body[^"]*"/i.test(html)
/** A chapter index is valid once it carries at least one section anchor. */
const isChapterIndex = (ch: string) => (html: string) =>
  new RegExp(`section-${ch}\\.[0-9]+`).test(html)

const chapterUrl = (ch: string) => `${BASE}/chapter-${ch}`
const sectionUrl = (num: string) => `${BASE}/section-${num}`

/**
 * Enumerate section numbers (e.g. "5301.255") from a chapter index page.
 * De-duped, numeric-sorted. The index repeats each section anchor (title link +
 * icon link), so the Set collapses them.
 */
function harvestSections(html: string, ch: string): string[] {
  const re = new RegExp(`section-${ch}\\.([0-9]+)`, 'g')
  const seen = new Set<string>()
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) seen.add(`${ch}.${m[1]}`)
  return [...seen].sort((a, b) => {
    const [, an] = a.split('.')
    const [, bn] = b.split('.')
    // sort by the dotted numeric suffix, treating sub-numbers as decimals
    return Number(an) - Number(bn) || an.localeCompare(bn)
  })
}

/**
 * Parse a section page. Returns null for repealed / reserved / empty / chrome-
 * only pages.
 */
function parseSectionPage(html: string, expectedNumber: string): Parsed | null {
  // --- number + catchline from the <h1> ---
  const h1m = html.match(/<h1>([\s\S]*?)<\/h1>/i)
  if (!h1m) return null
  // h1 form: "Section NNNN.NN <span ...>|</span> Catchline."
  // Split on the separator span; fall back to a bare "|" if classes change.
  const h1raw = h1m[1]
  const parts = h1raw.split(/<span[^>]*codes-separator[^>]*>[\s\S]*?<\/span>/i)
  const lhs = stripTags(parts[0] || '', false) // "Section NNNN.NN"
  const rhs = parts.length > 1 ? stripTags(parts.slice(1).join(' '), false) : ''
  let title: string | null = (rhs || '').trim()
  // Strip a trailing period the catchline carries, normalize.
  if (title) title = title.replace(/\s+/g, ' ').trim()
  if (!title) title = null

  // Repealed / reserved guard on the catchline.
  if (title && /^repealed\b/i.test(title)) return null
  if (title && /^\[?reserved\.?\]?$/i.test(title)) return null
  // Some repealed pages render the catchline as just "Repealed" inside lhs.
  if (/\brepealed\b/i.test(lhs) && !title) return null

  // --- verbatim body from <section class="laws-body"> ---
  const bm = html.match(/<section[^>]*class="[^"]*laws-body[^"]*"[^>]*>([\s\S]*?)<\/section>/i)
  if (!bm) return null
  const body = stripTags(bm[1], true)
  if (!body || body.length < 20) return null
  if (/^\[?reserved\.?\]?$/i.test(body)) return null
  if (/^this section (was|has been) repealed\b/i.test(body)) return null

  return { number: expectedNumber, title, text: body }
}

async function ingestCategory(cat: string, chapters: string[]): Promise<number> {
  // 1) Enumerate all section numbers across the category's chapters (retry-aware:
  //    a throttled index returns no section anchors, so curl() retries it).
  const numbers: string[] = []
  for (const ch of chapters) {
    const idxHtml = await curl(chapterUrl(ch), isChapterIndex(ch))
    const idx = harvestSections(idxHtml, ch)
    console.log(`  [${cat}] ch ${ch}: ${idx.length} sections`)
    numbers.push(...idx)
  }
  console.log(`  [${cat}] total ${numbers.length} sections to fetch`)

  // 2) Fetch + parse + insert. Low concurrency + per-section retry to ride out
  //    codes.ohio.gov throttling (the cause of false skips on the first pass).
  let ok = 0
  let skipped = 0
  const skippedNums: string[] = []
  const CONC = 2
  for (let i = 0; i < numbers.length; i += CONC) {
    if (i > 0) await new Promise((r) => setTimeout(r, 400))
    const batch = numbers.slice(i, i + CONC)
    const parsed = await Promise.all(
      batch.map(async (num) => {
        try {
          const html = await curl(sectionUrl(num), isSectionPage)
          return { p: parseSectionPage(html, num), num }
        } catch (e: any) {
          console.warn(`\n  ! ${cat} ${num}: ${e?.message || e}`)
          return { p: null, num }
        }
      })
    )
    for (const { p, num } of parsed) {
      if (!p || !p.text || p.text.length < 20) {
        skipped++
        skippedNums.push(num)
        continue
      }
      await query(
        `INSERT INTO state_law_section_texts
           (state_code, act_key, section_number, section_title, full_text, source_url, source_date, effective_year, law_category)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (state_code, act_key, section_number, effective_year) DO NOTHING`,
        [STATE, cat, p.number, p.title, p.text, sectionUrl(p.number), SOURCE_DATE, EFFECTIVE_YEAR, cat]
      )
      ok++
    }
    process.stdout.write(`\r  [${cat}] ${Math.min(i + CONC, numbers.length)}/${numbers.length}`)
  }
  console.log(`\n  [${cat}] inserted ${ok}, skipped ${skipped} of ${numbers.length}`)
  if (skippedNums.length) console.log(`  [${cat}] skipped sections: ${skippedNums.join(', ')}`)
  return ok
}

async function main() {
  console.log(`\n=== OH — ingesting non-tax real-estate corpus (as of ${SOURCE_DATE}) ===`)
  const counts: Record<string, number> = {}
  for (const [cat, chapters] of Object.entries(CATEGORIES)) {
    console.log(`\n--- ${cat} (${chapters.join(', ')}) ---`)
    counts[cat] = await ingestCategory(cat, chapters)
  }
  const total = Object.values(counts).reduce((a, b) => a + b, 0)
  console.log(`\nOH done. inserted=${total}`, counts)
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
