/**
 * Kansas property-tax statute full-text ingester (S472 corpus, sanctioned
 * retrieve+cite+date carve-out — verbatim statutory text only, never advice).
 *
 * SOURCE: Kansas Office of Revisor of Statutes (ksrevisor.gov), the canonical
 * Revisor site. Chapter 79 — Taxation. Plain raw_http, no JS, no auth, curl-able.
 *
 * HARVEST:
 *   (1) Chapter-79 TOC at https://ksrevisor.gov/statutes/ksa_ch79.html enumerates
 *       every section as a stable static link of form
 *       /statutes/chapters/ch79/079_AAA_NNNN[suffix].html
 *       AAA = zero-padded article (002 = Art. 2), NNNN = zero-padded
 *       section-within-article, optional letter suffix for lettered sections
 *       (079_002_0001w.html = 79-201w; 079_014_0039b.html = 79-1439b).
 *   (2) We restrict to the five feature-chapter article groups below.
 *
 * PER-PAGE PARSE (static HTML, layout confirmed against 79-101 / 79-201 / 79-2004):
 *   The statutory content lives in <div id="print">:
 *     <span class="stat_number">  = section number (e.g. "79-2004.")
 *     <span class="stat_caption">  = catchline / title (absent on repealed)
 *     <p class="ksa_stat">         = body paragraphs. The FIRST one also wraps
 *                                    the number/caption spans — we strip those
 *                                    spans, the remainder is the lead body para.
 *     <p class="ksa_stat_hist">    = the trailing "History:" line (kept as the
 *                                    statutory source-note trailer, as the spec
 *                                    allows).
 *   Everything AFTER the print div uses ksa_8pt_* classes (Source or prior law,
 *   Revisor's Note, Cross References, Law Review references, Attorney General's
 *   Opinions, CASE ANNOTATIONS) — these are editorial annotations, NOT statute,
 *   and are excluded. We select only by the statute-only class names
 *   (ksa_stat / ksa_stat_hist), which never appear outside the print div.
 *
 * DROP: repealed (no caption + body says/Repealed) / reserved / empty (<20 char).
 *
 * ACT MAPPING: every section lands under act_key='property_tax' /
 * law_category='property_tax'. The five topic groups below only determine which
 * URLs we fetch; the DB unique key (state_code, act_key, section_number,
 * effective_year) dedups any cross-topic overlap (e.g. Art. 14 appears in both
 * the assessment and assessment_review citations) via ON CONFLICT DO NOTHING.
 *
 * Run: cd apps/api && node -r ts-node/register src/db/ingestKSPropertyTax.ts
 * Idempotent. Repealed/reserved/short (<20 char) bodies are dropped.
 */

import { execFileSync } from 'child_process'
import { query } from './index'
import { stripTags } from './ingestStateLawCorpus'

const STATE = 'KS'
const ACT_KEY = 'property_tax'
const LAW_CATEGORY = 'property_tax'
const SOURCE_DATE = '2026-06-14'
const EFFECTIVE_YEAR = 2026
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) GAM-statute-ingest/1.0'
const BASE = 'https://ksrevisor.gov'
const TOC_URL = `${BASE}/statutes/ksa_ch79.html`
const secUrl = (path: string) => `${BASE}${path}`

// The five feature-chapter groups → the zero-padded article codes whose section
// URLs we fetch. Triage-verified ranges:
//   exemptions             Art. 2  (79-201..79-267)
//   assessment             Arts. 3,4,5,14 (listing/valuation/rules + Art.14)
//   assessment_review      Art. 14 (appeal/equalization) + Art. 20 (79-2005 PUP)
//   levy_collection_payment Art. 18 (levy) + Art. 20 (collection, 79-2004 due)
//   delinquency_tax_sale   Art. 23 (tax sale) + Art. 24 (redemption) + Art. 26 (liens)
// Articles map to URL prefix 079_<AAA>_. Overlaps dedup at INSERT.
const TOPIC_ARTICLES: Record<string, string[]> = {
  exemptions: ['002'],
  assessment: ['003', '004', '005', '014'],
  assessment_review: ['014', '020'],
  levy_collection_payment: ['018', '020'],
  delinquency_tax_sale: ['023', '024', '026'],
}

interface Parsed { number: string; title: string | null; text: string }

function curl(url: string): string {
  const buf = execFileSync('curl', ['-sL', '--max-time', '60', '-A', UA, url], {
    maxBuffer: 256 * 1024 * 1024,
  })
  return buf.toString('utf-8')
}

/**
 * Enumerate all Chapter-79 section URLs from the TOC, grouped by article code.
 * Returns a map article-code -> sorted unique list of section paths.
 */
function harvestToc(html: string): Map<string, string[]> {
  const re = /href="(\/statutes\/chapters\/ch79\/079_([0-9]{3})_[0-9]{4}[a-z]?\.html)"/gi
  const byArt = new Map<string, Set<string>>()
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) {
    const path = m[1]
    const art = m[2]
    if (!byArt.has(art)) byArt.set(art, new Set())
    byArt.get(art)!.add(path)
  }
  const out = new Map<string, string[]>()
  for (const [art, set] of byArt) out.set(art, [...set].sort())
  return out
}

/**
 * Parse a Kansas statute page. Returns null for repealed / reserved / empty.
 * - number  = <span class="stat_number"> text, trailing period trimmed.
 * - title   = <span class="stat_caption"> text (null if absent).
 * - text    = each <p class="ksa_stat"> body (first one has its number/caption
 *             spans removed) joined by newline, then the <p class="ksa_stat_hist">
 *             History line appended as the statutory source-note trailer.
 */
function parseSectionPage(html: string): Parsed | null {
  const numM = html.match(/class="stat_number">([\s\S]*?)<\/span>/i)
  if (!numM) return null
  let number = stripTags(numM[1], false).replace(/\.\s*$/, '').trim()
  if (!number) return null

  const capM = html.match(/class="stat_caption">([\s\S]*?)<\/span>/i)
  let title: string | null = capM ? stripTags(capM[1], false).trim() : null
  if (title === '') title = null

  // Body paragraphs: every <p class="ksa_stat"> ... </p> (NOT ksa_stat_hist,
  // NOT ksa_8pt_*). The class match is anchored to the exact attribute so
  // "ksa_stat_hist" is excluded.
  const bodyParts: string[] = []
  const pRe = /<p class="ksa_stat">([\s\S]*?)<\/p>/gi
  let pm: RegExpExecArray | null
  while ((pm = pRe.exec(html)) !== null) {
    // Drop the number/caption spans from whichever paragraph carries them
    // (always the first), leaving only the lead body prose.
    const cleaned = pm[1]
      .replace(/<span class="stat_number">[\s\S]*?<\/span>/i, ' ')
      .replace(/<span class="stat_caption">[\s\S]*?<\/span>/i, ' ')
    const t = stripTags(cleaned, false).trim()
    if (t) bodyParts.push(t)
  }

  // History trailer (source note).
  const histM = html.match(/<p class="ksa_stat_hist">([\s\S]*?)<\/p>/i)
  const history = histM ? stripTags(histM[1], false).trim() : ''

  // Dead sections have no caption and no statutory body — only a History line
  // saying the section was repealed or expired. Drop them.
  const dead = bodyParts.length === 0 && /\b(Repealed|Expired)\b/i.test(history)
  if (dead) return null
  if (title && /^\[?reserved\.?\]?$/i.test(title)) return null

  const bodyJoined = bodyParts.join('\n').trim()
  // If there is no real body (only a number, e.g. repealed/expired/reserved
  // stubs whose only text is the History line), drop.
  if (!bodyJoined || bodyJoined.length < 20) return null

  const full = history ? `${bodyJoined}\n${history}`.trim() : bodyJoined
  if (!full || full.length < 20) return null
  if (/^\[?reserved\.?\]?$/i.test(full)) return null

  return { number, title, text: full }
}

async function ingestArticles(label: string, paths: string[]): Promise<number> {
  let ok = 0
  let skipped = 0
  const CONC = 4
  for (let i = 0; i < paths.length; i += CONC) {
    if (i > 0) await new Promise((r) => setTimeout(r, 250)) // politeness
    const batch = paths.slice(i, i + CONC)
    const parsed = await Promise.all(
      batch.map(async (path) => {
        try {
          return { p: parseSectionPage(curl(secUrl(path))), path }
        } catch (e: any) {
          console.warn(`  ! ${path}: ${e?.message || e}`)
          return { p: null, path }
        }
      })
    )
    for (const { p, path } of parsed) {
      if (!p) {
        skipped++
        continue
      }
      const res = await query<{ id: string }>(
        `INSERT INTO state_law_section_texts
           (state_code, act_key, section_number, section_title, full_text, source_url, source_date, effective_year, law_category)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (state_code, act_key, section_number, effective_year) DO NOTHING
         RETURNING id`,
        [STATE, ACT_KEY, p.number, p.title, p.text, secUrl(path), SOURCE_DATE, EFFECTIVE_YEAR, LAW_CATEGORY]
      )
      if (res.length > 0) ok++
      else skipped++ // already present (cross-topic overlap)
    }
    process.stdout.write(`\r  [${label}] ${Math.min(i + CONC, paths.length)}/${paths.length}`)
  }
  console.log(`\n  [${label}] inserted ${ok}, skipped ${skipped} of ${paths.length}`)
  return ok
}

async function main() {
  console.log(`\n=== KS — ingesting property-tax full-text corpus (as of ${SOURCE_DATE}) ===`)

  const toc = harvestToc(curl(TOC_URL))
  console.log(`TOC: enumerated ${[...toc.values()].reduce((a, s) => a + s.length, 0)} Chapter-79 section links across ${toc.size} articles`)

  const counts: Record<string, number> = {}
  for (const [topic, arts] of Object.entries(TOPIC_ARTICLES)) {
    const paths: string[] = []
    for (const art of arts) {
      const list = toc.get(art) || []
      if (list.length === 0) console.warn(`  ! topic ${topic}: article ${art} had 0 section links`)
      paths.push(...list)
    }
    console.log(`\n${topic}: articles [${arts.join(', ')}] -> ${paths.length} section URLs`)
    counts[topic] = await ingestArticles(topic, paths)
  }

  const total = Object.values(counts).reduce((a, b) => a + b, 0)
  console.log(`\nKS done. newly-inserted=${total}`, counts)
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
