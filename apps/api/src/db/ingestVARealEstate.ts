/**
 * Virginia non-tax real-estate statute full-text ingester (sanctioned
 * retrieve+cite+date carve-out — verbatim official text, never advice).
 *
 * Source: Code of Virginia at law.lis.virginia.gov (the official LIS site).
 * The site is plain server-rendered HTML — raw_http via curl with a browser
 * User-Agent. Two-step crawl, uniform across every category:
 *
 *   1) TOC harvest. Each chapter index page
 *        /vacode/title{T}/chapter{N}/
 *      lists its sections as anchors of the form
 *        <a href='/vacode/title{T}/chapter{N}/section{NUM}/'>§ NUM  Catchline</a>
 *      We pull the {NUM} out of every /section{NUM}/ href, de-dupe in order.
 *
 *   2) Section fetch. Each section's canonical page is the short form
 *        /vacode/{NUM}/          (e.g. /vacode/55.1-300/)
 *      Layout:
 *        catchline  -> the SECOND <h2>: "<span id='v0'>§ NUM</span>. Catchline."
 *                      (the first <h2> on every page is just "Code of Virginia")
 *        body       -> one or more <section class='body editable' ...> blocks,
 *                      each containing <p> paragraphs. We concatenate all of
 *                      them and strip tags (decode &#167;->§, &nbsp;->space).
 *
 * DROP rules: a missing/invalid section page has no v0 span and no body block
 * (it renders only the title banner) -> skipped. Repealed sections have a
 * catchline ending "Repealed." and a "Repealed by Acts ..." body -> skipped.
 * Reserved / empty / <20-char bodies / pure-TOC pages -> skipped.
 *
 * CATEGORY -> chapter mapping (law_category AND act_key are BOTH the key):
 *   conveyancing_title        Title 55.1 Subtitle I (ch 1-5.1) + Subtitle II
 *                             (ch 6-11): deeds, estates, covenants, liens,
 *                             recordation, disclosure act, settlements,
 *                             settlement agents, broker lien.
 *   condo_coop                Title 55.1 ch 18 (POA Act), 19 (Condominium Act),
 *                             20 (Horizontal Property Act), 21 (Cooperative
 *                             Act), 22 (Time-Share Act), 23.1 (Resale
 *                             Disclosure Act).
 *   broker_licensing          Title 54.1 ch 21 (Real Estate Brokers/Sales
 *                             Persons/Rental Location Agents), ch 20.1
 *                             (Real Estate Appraisers), ch 20.2 (Appraisal
 *                             Management Companies).
 *   mortgage_lien_foreclosure Title 55.1 ch 3 (deeds of trust; trustee/
 *                             foreclosure sales + satisfaction) + Title 43
 *                             (Mechanics' and Certain Other Liens — all ch).
 *   general_real_property     Title 55.1 ch 1 (Creation and Limitation of
 *                             Estates) + Subtitle V ch 24-32 (escheats,
 *                             unclaimed property, drift property, trespasses,
 *                             self-service storage lien act, executory
 *                             contracts, judgment liens).
 *
 * NOTE on intentional overlap: ch 1 appears in both conveyancing_title and
 * general_real_property; ch 3 appears in both conveyancing_title and
 * mortgage_lien_foreclosure. Because act_key == category, the same section is
 * stored once per category it belongs to (unique key includes act_key). This
 * matches the recipe, which lists those chapters under each category.
 *
 * Run: cd apps/api && node -r ts-node/register src/db/ingestVARealEstate.ts
 * Idempotent (ON CONFLICT DO NOTHING). Reuses stripTags from the corpus
 * framework.
 */

import { execFileSync } from 'child_process'
import { query } from './index'
import { stripTags } from './ingestStateLawCorpus'

const STATE = 'VA'
const SOURCE_DATE = '2026-06-14'
const EFFECTIVE_YEAR = 2026
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) GAM-statute-ingest/1.0 (compliance research)'
const BASE = 'https://law.lis.virginia.gov'

const sectionUrl = (num: string) => `${BASE}/vacode/${num}/`
const chapterTocUrl = (title: string, ch: string) => `${BASE}/vacode/title${title}/chapter${ch}/`

interface Parsed {
  number: string
  title: string | null
  text: string
}

function curl(url: string): string {
  const buf = execFileSync('curl', ['-sL', '--max-time', '60', '-A', UA, url], {
    maxBuffer: 256 * 1024 * 1024,
  })
  return buf.toString('utf-8')
}

/**
 * Harvest section numbers from a chapter TOC page, in document order, de-duped.
 * Anchors are /vacode/title{T}/chapter{N}/section{NUM}/.
 */
function harvestChapter(title: string, ch: string): string[] {
  const html = curl(chapterTocUrl(title, ch))
  const re = /\/section([0-9]+\.?[0-9]*-[0-9A-Za-z.:]+)\//g
  const seen = new Set<string>()
  const out: string[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) {
    const num = m[1].replace(/\.$/, '')
    if (seen.has(num)) continue
    seen.add(num)
    out.push(num)
  }
  return out
}

/**
 * Parse a /vacode/{NUM}/ section page.
 * catchline = the <h2> that contains <span id='v0'>§ ...</span>.
 * body = concatenation of every <section class='body editable' ...> block.
 * Returns null for missing (no v0 span / no body) or repealed/reserved pages.
 */
function parseSectionPage(html: string, expectedNumber: string): Parsed | null {
  // Catchline: the <h2> wrapping the v0 span.
  const h2match = html.match(/<h2[^>]*>([\s\S]*?<span id=['"]v0['"]>[\s\S]*?)<\/h2>/i)
  if (!h2match) return null // missing / invalid section page
  const catchline = stripTags(h2match[1], false).trim()
  if (!catchline) return null

  // Title = catchline minus the leading "§ NUM." / "§§ NUM through NUM." citation.
  let title: string | null = catchline
    .replace(/^§+\s*[0-9A-Za-z.:-]+(?:\s+through\s+[0-9A-Za-z.:-]+)?\.?\s*/i, '')
    .trim()
  if (!title) title = null
  if (title && /^repealed\b/i.test(title)) return null
  if (title && /^\[?reserved\.?\]?$/i.test(title)) return null
  if (title && /^(transferred|expired|not set out)\b/i.test(title)) return null

  // Body: every "body editable" section block on the page.
  const bodyBlocks = [...html.matchAll(/<section\s+class=['"]body editable['"][^>]*>([\s\S]*?)<\/section>/gi)].map(
    (mm) => stripTags(mm[1], true)
  )
  if (bodyBlocks.length === 0) return null
  const body = bodyBlocks.join('\n').replace(/\n{3,}/g, '\n\n').trim()

  if (!body || body.length < 20) return null
  if (/^repealed\b/i.test(body)) return null
  if (/^\[?reserved\.?\]?$/i.test(body)) return null

  return { number: expectedNumber, title, text: body }
}

async function ingestCategory(category: string, numbers: string[]): Promise<number> {
  let ok = 0
  let skipped = 0
  const CONC = 4
  for (let i = 0; i < numbers.length; i += CONC) {
    if (i > 0) await new Promise((r) => setTimeout(r, 250)) // politeness
    const batch = numbers.slice(i, i + CONC)
    const parsed = await Promise.all(
      batch.map(async (num) => {
        try {
          return { p: parseSectionPage(curl(sectionUrl(num)), num), num }
        } catch (e: any) {
          console.warn(`  ! ${category} ${num}: ${e?.message || e}`)
          return { p: null, num }
        }
      })
    )
    for (const { p, num } of parsed) {
      if (!p || !p.text || p.text.length < 20) {
        skipped++
        continue
      }
      await query(
        `INSERT INTO state_law_section_texts
           (state_code, act_key, section_number, section_title, full_text, source_url, source_date, effective_year, law_category)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (state_code, act_key, section_number, effective_year) DO NOTHING`,
        [STATE, category, p.number, p.title, p.text, sectionUrl(num), SOURCE_DATE, EFFECTIVE_YEAR, category]
      )
      ok++
    }
    process.stdout.write(`\r  [${category}] ${Math.min(i + CONC, numbers.length)}/${numbers.length}`)
  }
  console.log(`\n  [${category}] inserted ${ok}, skipped ${skipped} of ${numbers.length}`)
  return ok
}

/** Build the ordered, de-duped section list for a category from its chapters. */
function sectionsForChapters(specs: Array<{ title: string; ch: string }>): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const { title, ch } of specs) {
    const nums = harvestChapter(title, ch)
    for (const n of nums) {
      if (seen.has(n)) continue
      seen.add(n)
      out.push(n)
    }
  }
  return out
}

// Category -> {title, chapter} list.
const CATEGORY_CHAPTERS: Record<string, Array<{ title: string; ch: string }>> = {
  // Title 55.1 Subtitle I (1-5.1) + Subtitle II (6-11)
  conveyancing_title: [
    '1', '2', '3', '4', '5', '5.1', '6', '7', '8', '9', '10', '11',
  ].map((ch) => ({ title: '55.1', ch })),

  // Title 55.1 Subtitle IV — common interest communities
  condo_coop: ['18', '19', '20', '21', '22', '23.1'].map((ch) => ({ title: '55.1', ch })),

  // Title 54.1 broker/appraiser/AMC licensing
  broker_licensing: [
    { title: '54.1', ch: '21' },
    { title: '54.1', ch: '20.1' },
    { title: '54.1', ch: '20.2' },
  ],

  // Title 55.1 ch 3 (deeds of trust / foreclosure) + Title 43 (mechanics' liens)
  mortgage_lien_foreclosure: [
    { title: '55.1', ch: '3' },
    ...['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((ch) => ({ title: '43', ch })),
  ],

  // Title 55.1 ch 1 (estates) + Subtitle V ch 24-32 (misc real property)
  general_real_property: [
    '1', '24', '25', '26', '27', '28', '29', '30', '31', '32',
  ].map((ch) => ({ title: '55.1', ch })),
}

async function main() {
  console.log(`\n=== VA — ingesting non-tax real-estate full-text corpus (as of ${SOURCE_DATE}) ===`)
  const counts: Record<string, number> = {}

  for (const [category, chapters] of Object.entries(CATEGORY_CHAPTERS)) {
    const numbers = sectionsForChapters(chapters)
    console.log(`${category}: harvested ${numbers.length} section refs across ${chapters.length} chapter(s)`)
    counts[category] = await ingestCategory(category, numbers)
  }

  const total = Object.values(counts).reduce((a, b) => a + b, 0)
  console.log(`\nVA done. inserted=${total}`, counts)
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
