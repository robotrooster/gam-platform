/**
 * Arizona property-tax statute full-text ingester (sanctioned hard-compliance
 * retrieve+cite+date carve-out — verbatim statutory prose, never advice).
 *
 * Official source: Arizona Revised Statutes, Title 42 (Taxation), online at
 * azleg.gov. Each statute section is served as a standalone static HTML page at
 * the deterministic URL pattern
 *
 *     https://www.azleg.gov/ars/{title}/{section}.htm
 *
 * where {section} is the 5-digit zero-padded number after the title prefix
 * (e.g. 42-18052 -> /ars/42/18052.htm, 42-1001 -> /ars/42/01001.htm). Plain
 * HTTPS, no JS needed (raw_http).
 *
 * IMPORTANT — the arsDetail/?title=42 page is a TABLE-OF-CONTENTS / navigation
 * index, NOT statute text. It is used ONLY to enumerate which section numbers
 * exist (so we never fetch a non-existent section, which returns a WordPress
 * 404 page). The actual verbatim prose comes from the per-section .htm pages.
 *
 * Per-section page layout (UTF-8):
 *   <p><font color=GREEN>42-18052</font>. <font color=PURPLE><u>Due dates and
 *       times; delinquency</u></font></p>          <- number + bold heading
 *   <p>A. Except as provided in subsection C ...</p> <- body, subsection markers
 *   <p>1. ... </p> <p>2. ...</p>                     <- numbered clauses
 *   ...
 * Page chrome (HTML head, &nbsp; spacers) is stripped; the GREEN span = number,
 * the PURPLE/underline span = title, every following <p> = verbatim body.
 *
 * The .htm pages carry no effective-date stamp, so we stamp the retrieval date
 * (source_date) and effective_year only. Cite = the section number.
 *
 * TOPIC -> act_key mapping (the five GAM property-tax feature groups). act_key
 * is 'property_tax' for ALL rows (per the task INSERT contract); the five
 * feature topics are encoded by chapter so the corpus is one coherent
 * property_tax act. Chapter coverage:
 *   exemptions             = Ch. 11           (42-11001 .. 42-11155)
 *   assessment             = Ch. 12,13,14,15  (classification, locally/centrally
 *                                              assessed valuation, assessment)
 *   assessment_review      = Ch. 16           (appeals & reviews)
 *   levy_collection_payment= Ch. 17 + Ch.18 Art.3 (levy/rates + due dates/payment)
 *   delinquency_tax_sale   = rest of Ch. 18   (tax liens, sale, redemption, foreclose)
 *
 * Run: cd apps/api && node -r ts-node/register src/db/ingestAZPropertyTax.ts
 * Idempotent (ON CONFLICT DO NOTHING). Repealed/reserved/short (<20 char) /
 * 404 / TOC bodies are dropped.
 */

import { execFileSync } from 'child_process'
import { query } from './index'

const STATE = 'AZ'
const ACT_KEY = 'property_tax'
const LAW_CATEGORY = 'property_tax'
const TITLE = '42'
const SOURCE_DATE = '2026-06-14'
const EFFECTIVE_YEAR = 2026
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) GAM-statute-ingest/1.0'
const TOC_URL = `https://www.azleg.gov/arsDetail/?title=${TITLE}`
const sectionUrl = (code5: string) => `https://www.azleg.gov/ars/${TITLE}/${code5}.htm`

interface Parsed {
  number: string // canonical citation, e.g. "42-18052"
  title: string | null
  text: string
}

function curl(url: string): string {
  const buf = execFileSync('curl', ['-sL', '--max-time', '60', '-A', UA, url], {
    maxBuffer: 256 * 1024 * 1024,
  })
  return buf.toString('utf-8')
}

/** Minimal HTML tag-strip + entity decode for the simple azleg.gov <p> prose. */
function clean(html: string): string {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;|&rsquo;|&lsquo;/gi, "'")
    .replace(/&ldquo;|&rdquo;/gi, '"')
    .replace(/&mdash;/gi, '—')
    .replace(/&ndash;/gi, '–')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&sect;/gi, '§')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Enumerate every 5-digit section code present on the Title 42 TOC page whose
 * chapter prefix (first 2 digits) is in [lo, hi]. The TOC links sections as
 * /ars/42/NNNNN.htm. De-duped + sorted.
 */
function tocSections(tocHtml: string): string[] {
  const set = new Set<string>()
  const re = new RegExp(`ars/${TITLE}/([0-9]{5})\\.htm`, 'gi')
  let m: RegExpExecArray | null
  while ((m = re.exec(tocHtml)) !== null) set.add(m[1])
  return [...set].sort()
}

/**
 * Parse a per-section .htm page. Returns null for a 404 / TOC / repealed /
 * reserved / empty page.
 *   number  = GREEN font span content (e.g. "42-18052")
 *   title   = PURPLE/underline span content (heading)
 *   text    = all <p> paragraphs AFTER the heading paragraph, verbatim,
 *             newline-joined (preserves subsection structure).
 */
function parseSectionPage(html: string, code5: string): Parsed | null {
  // 404 guard: the azleg WordPress "Page not found" page is full HTML5; real
  // statute pages are bare <HTML> with a GREEN font span.
  if (/Page not found/i.test(html) && !/color=GREEN/i.test(html)) return null

  // Number from the GREEN span.
  const greenM = html.match(/<font[^>]*color=GREEN[^>]*>([\s\S]*?)<\/font>/i)
  if (!greenM) return null
  const number = clean(greenM[1]).replace(/\.$/, '').trim()
  if (!number) return null

  // Title from the PURPLE span (underline heading).
  const purpleM = html.match(/<font[^>]*color=PURPLE[^>]*>([\s\S]*?)<\/font>/i)
  let title: string | null = purpleM ? clean(purpleM[1]) : null
  if (title === '') title = null

  // Drop repealed / reserved sections by heading.
  if (title && /^repealed\b/i.test(title)) return null
  if (title && /^\[?reserved\.?\]?$/i.test(title)) return null

  // Body = every <p> after the heading paragraph. The heading paragraph is the
  // one carrying the GREEN span; collect all <p>...</p>, find that index, take
  // the rest.
  const paras = [...html.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)].map((mm) => mm[1])
  let headIdx = -1
  for (let i = 0; i < paras.length; i++) {
    if (/color=GREEN/i.test(paras[i])) {
      headIdx = i
      break
    }
  }
  const bodyParas =
    headIdx === -1 ? paras.map(clean) : paras.slice(headIdx + 1).map(clean)
  const body = bodyParas.filter((p) => p.length > 0).join('\n').trim()

  if (!body || body.length < 20) return null
  if (/^\[?reserved\.?\]?$/i.test(body)) return null
  if (/^repealed\b/i.test(body)) return null
  return { number, title, text: body }
}

interface TopicGroup {
  topic: string
  codes: string[]
}

/**
 * Partition the enumerated Title-42 section codes into the five feature topics.
 * Returns codes only for chapters 11-18 (property-tax chapters); everything
 * else in Title 42 (income tax, TPT, etc.) is ignored.
 */
function partition(allCodes: string[]): TopicGroup[] {
  const ch = (c: string) => c.slice(0, 2)
  const n = (c: string) => parseInt(c, 10)
  const exemptions: string[] = []
  const assessment: string[] = []
  const review: string[] = []
  const levy: string[] = []
  const delinquency: string[] = []
  for (const c of allCodes) {
    const cc = ch(c)
    if (cc === '11') exemptions.push(c)
    else if (cc === '12' || cc === '13' || cc === '14' || cc === '15') assessment.push(c)
    else if (cc === '16') review.push(c)
    else if (cc === '17') levy.push(c)
    else if (cc === '18') {
      // Ch. 18 Article 3 (due dates / payment) -> levy_collection_payment;
      // everything else in Ch. 18 (liens, sale, redemption, foreclosure)
      // -> delinquency_tax_sale.
      const num = n(c) // e.g. 18052
      if (num >= 18051 && num <= 18061) levy.push(c)
      else delinquency.push(c)
    }
  }
  return [
    { topic: 'exemptions', codes: exemptions },
    { topic: 'assessment', codes: assessment },
    { topic: 'assessment_review', codes: review },
    { topic: 'levy_collection_payment', codes: levy },
    { topic: 'delinquency_tax_sale', codes: delinquency },
  ]
}

async function ingestGroup(g: TopicGroup): Promise<{ ok: number; skipped: number; failed: number }> {
  let ok = 0
  let skipped = 0
  let failed = 0
  const CONC = 4
  for (let i = 0; i < g.codes.length; i += CONC) {
    if (i > 0) await new Promise((r) => setTimeout(r, 250)) // politeness
    const batch = g.codes.slice(i, i + CONC)
    const results = await Promise.all(
      batch.map((code5) => {
        try {
          const p = parseSectionPage(curl(sectionUrl(code5)), code5)
          return { code5, p, err: null as string | null }
        } catch (e: any) {
          return { code5, p: null as Parsed | null, err: e?.message || String(e) }
        }
      })
    )
    for (const r of results) {
      if (r.err) {
        failed++
        console.warn(`  ! [${g.topic}] ${TITLE}-${r.code5}: ${r.err}`)
        continue
      }
      if (!r.p || !r.p.text || r.p.text.length < 20) {
        skipped++
        continue
      }
      await query(
        `INSERT INTO state_law_section_texts
           (state_code, act_key, section_number, section_title, full_text, source_url, source_date, effective_year, law_category)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (state_code, act_key, section_number, effective_year) DO NOTHING`,
        [STATE, ACT_KEY, r.p.number, r.p.title, r.p.text, sectionUrl(r.code5), SOURCE_DATE, EFFECTIVE_YEAR, LAW_CATEGORY]
      )
      ok++
    }
    process.stdout.write(`\r  [${g.topic}] ${Math.min(i + CONC, g.codes.length)}/${g.codes.length}`)
  }
  console.log(`\n  [${g.topic}] inserted ${ok}, skipped ${skipped}, failed ${failed} of ${g.codes.length}`)
  return { ok, skipped, failed }
}

async function main() {
  console.log(`\n=== AZ Title 42 property-tax — ingesting verbatim corpus (as of ${SOURCE_DATE}) ===`)

  // 1) Enumerate section numbers from the TOC index (NOT used as text source).
  const tocHtml = curl(TOC_URL)
  const allCodes = tocSections(tocHtml)
  console.log(`Title 42 TOC: enumerated ${allCodes.length} total sections`)

  // 2) Partition into the five property-tax feature topics (chapters 11-18).
  const groups = partition(allCodes)
  for (const g of groups) console.log(`  ${g.topic}: ${g.codes.length} sections`)

  // 3) Fetch + parse + insert per group.
  const summary: Record<string, { ok: number; skipped: number; failed: number }> = {}
  for (const g of groups) {
    summary[g.topic] = await ingestGroup(g)
  }

  const total = Object.values(summary).reduce((a, b) => a + b.ok, 0)
  console.log(`\nAZ property_tax done. inserted=${total}`)
  console.table(summary)
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
