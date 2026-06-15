/**
 * Montana property-tax statute full-text ingester (sanctioned retrieve+cite+date
 * carve-out — verbatim statutory text only, never advice).
 *
 * SOURCE (official only): mca.legmt.gov — the Montana Legislature's official MCA
 * host. Title 15 (Taxation). Plain static HTML; a single GET per page returns the
 * full DOM (the page ships an anti-bot JS shim in <head> but the statute markup is
 * present in the raw HTML — no JS/auth/cookies needed). We curl, never headless.
 *
 * CRAWL RECIPE (verified against the live site):
 *   1. parts_index.html        -> ./part_NNNN/sections_index.html
 *   2. sections_index.html     -> each row is
 *         <a href="./section_SSSS/0150-CCCC-PPPP-SSSS.html">
 *            <span class="citation">NN-NN-NNN</span>&nbsp;<catchline-or-status></a>
 *      The link text ALSO carries the status word ("Repealed" / "reserved" /
 *      "Renumbered" / "through 15-7-120 reserved"), so we filter dead sections at
 *      the index level and never fetch them.
 *   3. section page layout:
 *         <span class="catchline"><span class="citation">15-6-201</span>.
 *            &#8195;<catchline>.</span> (1) ...body...
 *         within <div class="section-content"> as a run of <p class="line-indent">.
 *         <h1 class="section-section-title"> = the catchline (Title-Cased).
 *         <div class="history-content"> ... <span class="header">History:</span>
 *            En./amd. Sec. X, Ch. Y, L. YYYY ...   = authoritative version stamp.
 *
 * full_text = the section-content paragraphs (verbatim, catchline citation prefix
 * normalized off the first line so the body reads as prose) + a trailing
 * "History: ..." line (the MCA's own source/version note — allowed under the
 * cite+date carve-out, and the canonical enactment/amendment chain).
 *
 * CHAPTER -> TOPIC MAP (Title 15, real-property assessment & taxation):
 *   ch  6  exemptions / classification / property-tax assistance
 *   ch  7  appraisal
 *   ch  8  assessment procedure
 *   ch 10  property tax levies
 *   ch 15  property tax appeals (county tax appeal board)
 *   ch  2  Montana Tax Appeal Board (assessment review)
 *   ch 16  collection of property taxes (notice/payment, delinquency reporting, liens)
 *   ch 17  tax liens (attachment, procedure after attachment incl. redemption)
 *   ch 18  ownership interests in land sold for taxes / tax deed
 * All rows land under act_key='property_tax', law_category='property_tax'. Section
 * numbers (e.g. "15-16-101") are globally unique, so chapter 16 — which the triage
 * splits across levy_collection_payment and delinquency_tax_sale — is crawled once.
 *
 * Run: cd apps/api && node -r ts-node/register src/db/ingestMTPropertyTax.ts
 * Idempotent (ON CONFLICT DO NOTHING). Repealed/reserved/renumbered/short(<20)
 * bodies are dropped.
 */

import { execFileSync } from 'child_process'
import { query } from './index'
import { stripTags, decodeEntities } from './ingestStateLawCorpus'

const STATE = 'MT'
const ACT_KEY = 'property_tax'
const LAW_CATEGORY = 'property_tax'
const SOURCE_DATE = '2026-06-14'
const EFFECTIVE_YEAR = 2026
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) GAM-statute-ingest/1.0 (compliance research)'
const BASE = 'https://mca.legmt.gov/bills/mca/title_0150'

// Chapters to crawl (zero-padded), grouped by triage topic for logging only.
const CHAPTERS: { ch: string; topic: string }[] = [
  { ch: '0060', topic: 'exemptions' },
  { ch: '0070', topic: 'assessment' },
  { ch: '0080', topic: 'assessment' },
  { ch: '0150', topic: 'assessment_review' },
  { ch: '0020', topic: 'assessment_review' },
  { ch: '0160', topic: 'levy_collection_payment + delinquency_tax_sale' },
  { ch: '0100', topic: 'levy_collection_payment' },
  { ch: '0170', topic: 'delinquency_tax_sale' },
  { ch: '0180', topic: 'delinquency_tax_sale' },
]

interface SectionRef {
  number: string // e.g. "15-6-201"
  file: string // absolute URL to the section page
}
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

const STATUS_RE = /\b(repealed|reserved|renumbered|terminated)\b/i

/** Parse a parts_index.html for its part dir names (e.g. "0010"). */
function parsePartDirs(html: string): string[] {
  const seen = new Set<string>()
  for (const m of html.matchAll(/part_(\d{4})\/sections_index\.html/gi)) seen.add(m[1])
  return [...seen].sort()
}

/**
 * Parse a sections_index.html into live SectionRefs. Each anchor:
 *   <a href="./section_SSSS/0150-CCCC-PPPP-SSSS.html">
 *      <span class="citation">NN-NN-NNN</span>&nbsp;<catchline-or-status></a>
 * We read the section number from the citation span and the status word from the
 * remaining link text; drop repealed/reserved/renumbered/terminated rows here so
 * we never fetch them.
 */
function parseSectionsIndex(html: string, partUrl: string): SectionRef[] {
  const out: SectionRef[] = []
  const seen = new Set<string>()
  const re = /<a[^>]*href="([^"]*section_\d{4}\/0150-[0-9-]+\.html)"[^>]*>([\s\S]*?)<\/a>/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) {
    const relHref = m[1]
    const inner = m[2]
    const citeMatch = inner.match(/<span class="citation">([^<]+)<\/span>/i)
    if (!citeMatch) continue
    const number = decodeEntities(citeMatch[1]).trim()
    if (!/^\d+-\d+-\d+/.test(number)) continue
    // Status text = link text after the citation span.
    const rest = stripTags(inner.replace(/<span class="citation">[^<]+<\/span>/i, ''), false).trim()
    if (STATUS_RE.test(rest)) continue
    if (seen.has(number)) continue
    seen.add(number)
    // Resolve "./section_SSSS/...html" against the PART base URL (the href in
    // sections_index.html is relative to the part dir, not the chapter dir).
    const file = `${partUrl}/${relHref.replace(/^\.\//, '')}`
    out.push({ number, file })
  }
  return out
}

/**
 * Parse a single section page. Returns null for repealed/reserved/empty.
 */
function parseSectionPage(html: string, expectedNumber: string): Parsed | null {
  // Title = the section-section-title heading.
  let title: string | null = null
  const h1 = html.match(/<h1 class="section-section-title">([\s\S]*?)<\/h1>/i)
  if (h1) {
    title = stripTags(h1[1], false).trim() || null
  }
  if (title && STATUS_RE.test(title)) return null

  // Body = the section-content block (run of <p class="line-indent">).
  const contentMatch = html.match(/<div class="section-content">([\s\S]*?)<\/div>\s*(?:<div class="history|<\/div>)/i)
  if (!contentMatch) return null

  // Drop the catchline wrapper so body prose starts at "(1) ...". The catchline
  // span NESTS a citation span:
  //   <span class="catchline"><span class="citation">15-6-201</span>.&#8195;<catchline>.</span>
  // so a non-greedy /...<\/span>/ would stop at the INNER close and leak the
  // catchline text. Strip the inner citation span first, then the (now flat)
  // catchline span. The catchline text is already captured in section_title.
  let contentHtml = contentMatch[1]
    .replace(/<span class="catchline">\s*<span class="citation">[^<]*<\/span>/i, '<span class="catchline">')
    .replace(/<span class="catchline">[\s\S]*?<\/span>/i, '')

  const body = stripTags(contentHtml, true)
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .join('\n')
    .trim()

  if (!body || body.length < 20) return null
  if (STATUS_RE.test(body) && body.length < 60) return null

  // History note (source/version stamp) — append as the trailing source line.
  let history = ''
  const histMatch = html.match(/<div class="history-content">([\s\S]*?)<\/div>/i)
  if (histMatch) {
    const h = stripTags(histMatch[1], false).trim()
    if (h) history = h.replace(/^History:\s*/i, 'History: ')
  }

  const full = history ? `${body}\n\n${history}` : body
  return { number: expectedNumber, title, text: full }
}

async function ingestChapter(ch: string, topic: string): Promise<number> {
  const chapterUrl = `${BASE}/chapter_${ch}`
  let partsHtml: string
  try {
    partsHtml = curl(`${chapterUrl}/parts_index.html`)
  } catch (e: any) {
    console.warn(`  ! chapter ${ch} parts_index failed: ${e?.message || e}`)
    return 0
  }
  const parts = parsePartDirs(partsHtml)
  if (parts.length === 0) {
    console.warn(`  ! chapter ${ch}: no parts found`)
    return 0
  }

  // Collect all live section refs across parts.
  const refs: SectionRef[] = []
  for (const p of parts) {
    const partUrl = `${chapterUrl}/part_${p}`
    try {
      const idx = curl(`${partUrl}/sections_index.html`)
      refs.push(...parseSectionsIndex(idx, partUrl))
    } catch (e: any) {
      console.warn(`  ! chapter ${ch} part ${p} sections_index failed: ${e?.message || e}`)
    }
  }

  let ok = 0
  let skipped = 0
  const CONC = 4
  for (let i = 0; i < refs.length; i += CONC) {
    if (i > 0) await new Promise((r) => setTimeout(r, 250)) // politeness
    const batch = refs.slice(i, i + CONC)
    const parsed = await Promise.all(
      batch.map(async (r) => {
        try {
          return { p: parseSectionPage(curl(r.file), r.number), r }
        } catch (e: any) {
          console.warn(`  ! ${r.number} (${r.file}): ${e?.message || e}`)
          return { p: null, r }
        }
      })
    )
    for (const { p, r } of parsed) {
      if (!p || !p.text || p.text.length < 20) {
        skipped++
        continue
      }
      await query(
        `INSERT INTO state_law_section_texts
           (state_code, act_key, section_number, section_title, full_text, source_url, source_date, effective_year, law_category)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (state_code, act_key, section_number, effective_year) DO NOTHING`,
        [STATE, ACT_KEY, p.number, p.title, p.text, r.file, SOURCE_DATE, EFFECTIVE_YEAR, LAW_CATEGORY]
      )
      ok++
    }
    process.stdout.write(`\r  [ch ${ch} / ${topic}] ${Math.min(i + CONC, refs.length)}/${refs.length}`)
  }
  console.log(`\n  [ch ${ch} / ${topic}] inserted ${ok}, skipped ${skipped} of ${refs.length} live refs`)
  return ok
}

async function main() {
  console.log(`\n=== MT — ingesting Title 15 property-tax full-text corpus (as of ${SOURCE_DATE}) ===`)
  let total = 0
  for (const { ch, topic } of CHAPTERS) {
    total += await ingestChapter(ch, topic)
  }
  console.log(`\nMT done. inserted (pre-dedupe) =${total}`)
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
