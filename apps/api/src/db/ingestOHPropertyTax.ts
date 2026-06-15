/**
 * Ohio property-tax statute full-text ingester (sanctioned retrieve+cite+date
 * carve-out — verbatim statutory text, never advice).
 *
 * Official source ONLY: codes.ohio.gov (Ohio Laws, published by the Ohio
 * Legislative Service Commission). Plain server-rendered HTML — fetchable by
 * raw HTTP/curl, no JS rendering or login. No Justia/Lexis/Wayback.
 *
 * URL pattern:
 *   - chapter index:  https://codes.ohio.gov/ohio-revised-code/chapter-NNNN
 *       (lists every section as "section-NNNN.NN" identifiers in anchors +
 *        authenticated-PDF hrefs)
 *   - per section:    https://codes.ohio.gov/ohio-revised-code/section-NNNN.NN
 *
 * Section-page layout:
 *   - <h1>Section NNNN.NN <span class='codes-separator'>|</span> CATCHLINE</h1>
 *   - <section class="laws-body"> … verbatim statutory prose … </section>
 *       (a trailing <div class="laws-notice">Last updated …</div> is sliced off)
 *   - metadata block: <div class="label">Effective:</div>
 *                     <div class="value">October 3, 2023</div>
 *     captured as the date stamp for the date-of-citation requirement.
 *   - repealed / reserved / empty sections have NO laws-body section → dropped.
 *
 * Real-property-tax coverage spans Title 57 chapters (5709, 5713, 5715, 5717,
 * 5721, 5723) AND Title 3 county-officer chapters (319 auditor tax list, 323
 * treasurer collection & delinquency penalties). Both titles are crawled.
 *
 * One ingest row per section. act_key='property_tax', law_category='property_tax',
 * source_date='2026-06-14', effective_year=2026. The statute's own displayed
 * Effective date is prepended to full_text as a "[Effective: …]" stamp so the
 * point-in-time version travels with the verbatim text.
 *
 * Run: cd apps/api && node -r ts-node/register src/db/ingestOHPropertyTax.ts
 * Idempotent (ON CONFLICT DO NOTHING). Repealed/reserved/short (<20 char) bodies
 * are dropped.
 */

import { execFileSync } from 'child_process'
import { query } from './index'
import { stripTags, decodeEntities } from './ingestStateLawCorpus'

const STATE = 'OH'
const ACT_KEY = 'property_tax'
const LAW_CATEGORY = 'property_tax'
const SOURCE_DATE = '2026-06-14'
const EFFECTIVE_YEAR = 2026
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) GAM-statute-ingest/1.0 (compliance research)'
const BASE = 'https://codes.ohio.gov/ohio-revised-code'
const sectionUrl = (n: string) => `${BASE}/section-${n}`
const chapterUrl = (ch: string) => `${BASE}/chapter-${ch}`

// Five feature groups → the chapters that supply each topic's text. We crawl all
// chapters once and load every section under act_key='property_tax'; the topic
// grouping is documentation of which citations each chapter backs.
const TOPIC_CHAPTERS: Record<string, string[]> = {
  exemptions: ['5709'], // + exempt-list / homestead sections covered in 5713 & 323 below
  assessment: ['5713'],
  assessment_review: ['5715', '5717'],
  levy_collection_payment: ['323', '319'],
  delinquency_tax_sale: ['5721', '5723'],
}
// De-duplicated crawl set (chapters can appear under more than one topic only by
// citation overlap; here each chapter is listed once).
const CHAPTERS = ['5709', '5713', '5715', '5717', '5721', '5723', '319', '323']

interface Parsed {
  number: string
  title: string | null
  text: string
  effectiveDate: string | null
}

function curlOnce(url: string): string {
  const buf = execFileSync('curl', ['-sL', '--max-time', '60', '-A', UA, url], {
    maxBuffer: 256 * 1024 * 1024,
  })
  return buf.toString('utf-8')
}

function sleep(ms: number): void {
  // synchronous spin-free wait via Atomics — keeps curl() callable from the
  // non-async parse paths while still backing off on transient throttling.
  const sab = new Int32Array(new SharedArrayBuffer(4))
  Atomics.wait(sab, 0, 0, ms)
}

/**
 * curl with bounded retry. codes.ohio.gov occasionally returns a truncated /
 * throttled body when hammered (observed: chapter index returning 0 sections
 * mid-run). Retry up to 3x with backoff; the caller's own emptiness check is the
 * final guard.
 */
function curl(url: string): string {
  let last = ''
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      last = curlOnce(url)
      if (last && last.length > 500) return last
    } catch (e) {
      if (attempt === 3) throw e
    }
    sleep(attempt * 1000)
  }
  return last
}

/**
 * Harvest the distinct "NNNN.NN" section numbers from a chapter index page.
 * Both the in-page section anchors and the authenticated-PDF hrefs carry the
 * "section-NNNN.NN" / "/NNNN/NNNN.NN/" tokens; we match the canonical
 * "section-NNNN.NN" identifier and de-dupe.
 */
function harvestChapter(html: string, chapter: string): string[] {
  const re = new RegExp(`section-(${chapter}\\.[0-9A-Za-z]+)`, 'g')
  const seen = new Set<string>()
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) seen.add(m[1])
  const out = [...seen]
  // numeric-aware sort: 5713.01 < 5713.011 < 5713.02 …
  out.sort((a, b) => {
    const [, sa = ''] = a.split('.')
    const [, sb = ''] = b.split('.')
    return sa.localeCompare(sb, undefined, { numeric: true })
  })
  return out
}

/**
 * Parse a section page: H1 → number + catchline; <section class="laws-body"> →
 * verbatim body (trailing "laws-notice" Last-updated div sliced off); the
 * Effective metadata value → date stamp. Returns null for repealed/reserved/
 * empty pages (no laws-body or <20-char body).
 */
function parseSection(html: string, expectedNumber: string): Parsed | null {
  // H1: "Section NNNN.NN <span ...>|</span> CATCHLINE"
  const h1m = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)
  let title: string | null = null
  if (h1m) {
    const h1txt = stripTags(h1m[1], false)
    // strip leading "Section NNNN.NN |" → catchline
    const after = h1txt.replace(/^Section\s+[0-9A-Za-z.]+\s*\|?\s*/i, '').trim()
    title = after || null
  }
  if (title && /^repealed\b/i.test(title)) return null
  if (title && /^\[?\s*reserved\.?\s*\]?$/i.test(title)) return null

  // Body: <section class="laws-body"> … </section>
  const bodym = html.match(/<section[^>]*class="[^"]*laws-body[^"]*"[^>]*>([\s\S]*?)<\/section>/i)
  if (!bodym) return null
  let bodyHtml = bodym[1]
  // slice off the trailing "Last updated …" notice div (not statute text)
  bodyHtml = bodyHtml.replace(/<div[^>]*class="[^"]*laws-notice[^"]*"[^>]*>[\s\S]*$/i, '')
  const body = stripTags(bodyHtml, true).trim()
  if (!body || body.length < 20) return null
  if (/^\[?\s*reserved\.?\s*\]?$/i.test(body)) return null
  if (/^this section (was|has been) repealed/i.test(body)) return null

  // Effective date metadata: <div class="label">Effective:</div><div class="value">DATE</div>
  let effectiveDate: string | null = null
  const effm = html.match(/Effective:\s*<\/div>\s*<div class="value">([\s\S]*?)<\/div>/i)
  if (effm) effectiveDate = decodeEntities(effm[1]).trim() || null

  return { number: expectedNumber, title, text: body, effectiveDate }
}

/**
 * A genuinely loaded section page always carries the H1 "Section NNNN.NN" title
 * AND the "Effective:" metadata label. If a fetch lacks both, the page didn't
 * fully load (throttle / truncation) — distinct from a real repealed/reserved
 * section, which loads fully but has no laws-body. Retry only the former so we
 * never silently skip a live section that was merely rate-limited.
 */
function fetchSectionRetry(num: string): Parsed | null {
  for (let attempt = 1; attempt <= 4; attempt++) {
    const html = curl(sectionUrl(num))
    const looksLoaded =
      new RegExp(`<h1[^>]*>\\s*Section\\s+${num.replace('.', '\\.')}\\b`, 'i').test(html) &&
      /Effective:\s*<\/div>/i.test(html)
    if (looksLoaded) return parseSection(html, num)
    sleep(attempt * 1200) // throttled — back off and retry
  }
  // Page never loaded fully; treat as a genuine miss (logged by caller via null).
  return parseSection(curl(sectionUrl(num)), num)
}

async function ingestChapter(chapter: string, topic: string): Promise<{ ok: number; skipped: number }> {
  // Retry the index fetch until we actually get section ids — a throttled /
  // truncated index page silently harvests 0 otherwise.
  let sections: string[] = []
  for (let attempt = 1; attempt <= 4 && sections.length === 0; attempt++) {
    if (attempt > 1) await new Promise((r) => setTimeout(r, attempt * 1500))
    sections = harvestChapter(curl(chapterUrl(chapter)), chapter)
  }
  console.log(`\n[ch ${chapter} / ${topic}] harvested ${sections.length} section ids`)

  let ok = 0
  let skipped = 0
  const CONC = 4
  for (let i = 0; i < sections.length; i += CONC) {
    if (i > 0) await new Promise((r) => setTimeout(r, 250)) // politeness
    const batch = sections.slice(i, i + CONC)
    const parsed = await Promise.all(
      batch.map(async (num) => {
        try {
          return { p: fetchSectionRetry(num), num }
        } catch (e: any) {
          console.warn(`  ! ${num}: ${e?.message || e}`)
          return { p: null, num }
        }
      })
    )
    for (const { p } of parsed) {
      if (!p || !p.text || p.text.length < 20) {
        skipped++
        continue
      }
      // Prepend the statute's own displayed Effective date so the point-in-time
      // version stamp travels verbatim with the text (date-of-citation req).
      const stamped = p.effectiveDate
        ? `[Effective: ${p.effectiveDate}]\n${p.text}`
        : p.text
      await query(
        `INSERT INTO state_law_section_texts
           (state_code, act_key, section_number, section_title, full_text, source_url, source_date, effective_year, law_category)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (state_code, act_key, section_number, effective_year) DO NOTHING`,
        [STATE, ACT_KEY, p.number, p.title, stamped, sectionUrl(p.number), SOURCE_DATE, EFFECTIVE_YEAR, LAW_CATEGORY]
      )
      ok++
    }
    process.stdout.write(`\r  [ch ${chapter}] ${Math.min(i + CONC, sections.length)}/${sections.length}`)
  }
  console.log(`\n  [ch ${chapter}] inserted ${ok}, skipped ${skipped} of ${sections.length}`)
  return { ok, skipped }
}

async function main() {
  console.log(`\n=== OH — ingesting property-tax full-text corpus (as of ${SOURCE_DATE}) ===`)

  // chapter -> topic label for logging
  const chapterTopic: Record<string, string> = {}
  for (const [topic, chs] of Object.entries(TOPIC_CHAPTERS)) {
    for (const ch of chs) chapterTopic[ch] = topic
  }

  let totalOk = 0
  let totalSkip = 0
  const byChapter: Record<string, number> = {}
  for (const ch of CHAPTERS) {
    const { ok, skipped } = await ingestChapter(ch, chapterTopic[ch] || '?')
    byChapter[ch] = ok
    totalOk += ok
    totalSkip += skipped
    await new Promise((r) => setTimeout(r, 1000)) // politeness between chapters
  }

  console.log(`\nOH property_tax done. inserted=${totalOk} skipped=${totalSkip}`, byChapter)
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
