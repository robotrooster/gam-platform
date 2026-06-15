/**
 * South Carolina property-tax statute full-text ingester (sanctioned
 * retrieve+cite+date carve-out — verbatim statutory prose, never advice).
 *
 * Official source: SC Legislature, scstatehouse.gov. Title 12 (Taxation).
 * Each chapter is ONE static, server-rendered HTML page at
 *   https://www.scstatehouse.gov/code/t12c0NN.php   (NN = zero-padded chapter).
 * Plain curl with a UA header returns the full HTML; no JS needed.
 *
 * NB on the triage TOC trap: title12.php is only a chapter directory (links,
 * no statutory prose). The actual SECTION TEXT lives on the per-chapter
 * t12c0NN.php pages — that is what this ingester fetches. Each section is
 * marked by a bold span:
 *     <span style="font-weight: bold;"> SECTION 12-NN-XXX.</span> Catchline.<br/>
 * followed by the codified body, then a trailing "HISTORY:" amendment note.
 *
 * PARSE: we split each chapter on the *bold-span* SECTION marker rather than a
 * bare textual "SECTION 12-..." match — the HISTORY blocks themselves contain
 * "SECTION 65-1501" style legacy-code cross-refs, and bodies cite other
 * sections inline; only the bold-span occurrences are true section headers.
 * (Verified: ch.37 raw-grep finds 148 "SECTION 12-37-*" but only 145 are real
 * headers; the 3 extras are an in-body cross-ref to 12-37-220 and 12-37-2723.)
 *
 *   - section_number = the 12-NN-XXX(.dd)(A) citation from the span
 *   - section_title  = the catchline (text up to the first <br/>)
 *   - full_text      = the codified body VERBATIM, including the trailing
 *                      HISTORY: amendment note (kept as a source trailer, as
 *                      the LA ingester does; it is part of the published text)
 *   - repealed / reserved / empty (<20 char) bodies are dropped
 *   - the catchline is echoed as the first line of the raw body by the site;
 *     we drop that leading duplicate so the title is not repeated in full_text
 *
 * FEATURE-CHAPTER GROUPS (act_key is always 'property_tax'; chapters map to
 * the five requested topics):
 *   exemptions             → Ch.37 (Assessment of Property Taxes; incl. Art.3
 *                            exemptions §12-37-210/-220, homestead §12-37-250+)
 *   assessment             → Ch.43 (County Equalization & Reassessment) + Ch.39
 *                            (County Auditors)
 *   assessment_review      → Ch.60 (SC Revenue Procedures Act)
 *   levy_collection_payment→ Ch.45 (County Treasurers & Collection of Taxes)
 *   delinquency_tax_sale   → Ch.51 (Alternate Procedure for Collection of
 *                            Property Taxes)
 *
 * Run: cd apps/api && node -r ts-node/register src/db/ingestSCPropertyTax.ts
 * Idempotent (ON CONFLICT DO NOTHING).
 */

import { execFileSync } from 'child_process'
import { query } from './index'

const STATE = 'SC'
const ACT_KEY = 'property_tax'
const LAW_CATEGORY = 'property_tax'
const SOURCE_DATE = '2026-06-14'
const EFFECTIVE_YEAR = 2026
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) GAM-statute-ingest/1.0'
const codeUrl = (ch: string) => `https://www.scstatehouse.gov/code/t12c${ch}.php`

// Chapters to fetch (zero-padded to 3 digits) grouped by feature topic.
const TOPIC_CHAPTERS: { topic: string; chapters: string[] }[] = [
  { topic: 'exemptions', chapters: ['037'] },
  { topic: 'assessment', chapters: ['043', '039'] },
  { topic: 'assessment_review', chapters: ['060'] },
  { topic: 'levy_collection_payment', chapters: ['045'] },
  { topic: 'delinquency_tax_sale', chapters: ['051'] },
]

interface Parsed {
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

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/gi, ' ')
    .replace(/&#167;/g, '§')
    .replace(/&sect;/gi, '§')
    .replace(/&quot;/gi, '"')
    .replace(/&#34;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&rsquo;/gi, '’')
    .replace(/&lsquo;/gi, '‘')
    .replace(/&rdquo;/gi, '”')
    .replace(/&ldquo;/gi, '“')
    .replace(/&mdash;/gi, '—')
    .replace(/&ndash;/gi, '–')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
}

/** HTML -> plain text. <br> becomes newline; tags stripped; entities decoded. */
function htmlToText(s: string): string {
  let t = s.replace(/<br\s*\/?>/gi, '\n')
  t = t.replace(/<\/(p|div|li|tr)>/gi, '\n')
  t = t.replace(/<[^>]+>/g, '')
  t = decodeEntities(t)
  return t
}

/** Collapse runs of spaces/tabs but preserve newlines / paragraph breaks. */
function collapse(s: string): string {
  return s
    .replace(/\r/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * Parse a Title-12 chapter page into sections. Splits on the bold-span SECTION
 * marker so HISTORY/in-body cross-refs are not mistaken for headers.
 */
function parseChapter(html: string, chapterNo: string): Parsed[] {
  // Capture the section number from the bold span; everything between two
  // span markers (or to EOF) is that section's raw body.
  const splitRe =
    /<span[^>]*font-weight:\s*bold[^>]*>\s*SECTION\s+(12-\d+-\d+(?:\.\d+)?[A-Z]?)\.\s*<\/span>/gi
  const parts = html.split(splitRe)
  // parts = [preamble, num1, body1, num2, body2, ...]
  const out: Parsed[] = []
  for (let k = 1; k < parts.length; k += 2) {
    const number = parts[k]
    const rawBody = parts[k + 1] ?? ''

    const text = collapse(htmlToText(rawBody))
    const lines = text.split('\n')
    // catchline = first non-empty line
    let ci = -1
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].trim()) {
        ci = i
        break
      }
    }
    if (ci === -1) continue
    const catchline = lines[ci].trim()

    // Title = the catchline. Drop repealed / reserved sections outright.
    let title: string | null = catchline.replace(/\.\s*$/, '').trim() || null
    if (title && /^\[?\s*repealed/i.test(title)) continue
    if (title && /^\[?\s*reserved\.?\]?$/i.test(title)) continue

    // Body = everything after the catchline line. The site echoes the
    // catchline as the body's first line, so dropping that line removes the
    // duplicate. Keep the trailing HISTORY: note as a source trailer.
    const body = lines
      .slice(ci + 1)
      .join('\n')
      .trim()

    if (!body || body.length < 20) continue
    if (/^\[?\s*repealed/i.test(body)) continue
    if (/^\[?\s*reserved\.?\]?$/i.test(body)) continue

    out.push({ number, title, text: body })
  }
  return out
}

async function main() {
  console.log(`\n=== SC — ingesting Title 12 property-tax full text (as of ${SOURCE_DATE}) ===`)

  const issues: string[] = []
  // De-dupe across chapters/topics on section_number (multiple topics never
  // share a chapter here, but guard anyway).
  const seen = new Set<string>()
  let inserted = 0
  let parsedTotal = 0

  for (const { topic, chapters } of TOPIC_CHAPTERS) {
    let topicCount = 0
    for (const ch of chapters) {
      const url = codeUrl(ch)
      let html = ''
      try {
        html = curl(url)
      } catch (e: any) {
        issues.push(`topic ${topic} ch ${ch}: fetch failed — ${e?.message || e}`)
        continue
      }
      if (html.length < 5000 || !/SECTION\s+12-/.test(html)) {
        issues.push(`topic ${topic} ch ${ch}: page too small or no SECTION markers (${html.length} bytes)`)
        continue
      }
      const secs = parseChapter(html, ch)
      if (secs.length === 0) {
        issues.push(`topic ${topic} ch ${ch}: 0 sections parsed`)
        continue
      }
      parsedTotal += secs.length
      for (const s of secs) {
        if (seen.has(s.number)) continue
        seen.add(s.number)
        const rows = await query<{ id: string }>(
          `INSERT INTO state_law_section_texts
             (state_code, act_key, section_number, section_title, full_text, source_url, source_date, effective_year, law_category)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           ON CONFLICT (state_code, act_key, section_number, effective_year) DO NOTHING
           RETURNING id`,
          [STATE, ACT_KEY, s.number, s.title, s.text, url, SOURCE_DATE, EFFECTIVE_YEAR, LAW_CATEGORY]
        )
        inserted += rows.length
        topicCount++
      }
      console.log(`  [${topic}] ch ${ch}: parsed ${secs.length} sections`)
    }
    console.log(`  topic ${topic}: ${topicCount} distinct sections processed`)
  }

  console.log(`\nSC done. parsed=${parsedTotal} inserted=${inserted}`)
  if (issues.length) {
    console.log('ISSUES:')
    for (const i of issues) console.log('  - ' + i)
  } else {
    console.log('ISSUES: none')
  }
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
