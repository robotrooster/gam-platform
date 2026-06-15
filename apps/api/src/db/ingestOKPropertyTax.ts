/**
 * Oklahoma property-tax (ad valorem) full-text ingester.
 *
 * Sanctioned retrieve+cite+date carve-out: verbatim statutory text only, never
 * advice. Source is the OFFICIAL Oklahoma Legislature complete-title PDF for
 * Title 68 (Revenue and Taxation):
 *   https://www.oklegislature.gov/OK_Statutes/CompleteTitles/os68.pdf
 *
 * The Ad Valorem Tax Code is Articles 28-31, §§ 2801-3152 (68 O.S. § 2801 et
 * seq.). Everything at/after § 3201 is a different code (Documentary Stamp Tax,
 * Article 32) and is excluded. We capture the contiguous numeric range
 * 2801 <= N < 3201 from the BODY of the document only.
 *
 * PARSE RECIPE (verified against os68.pdf, PDF v1.7, 1566 pages):
 *   - Extract with `pdftotext -layout` (plain HTML/markdown converters fail on
 *     the FlateDecode streams; a layout-aware extractor is required).
 *   - Section body headers match /^§68-(\d+(?:\.\d+)?(?:v\d+)?)\.\s*(.*)$/ at
 *     column 0. The optional "vN" suffix is Oklahoma's multi-version marker:
 *     when two conflicting amendments pass in one session and aren't yet
 *     reconciled, the publisher prints a stub "§68-NNNN. See the following
 *     versions:" plus the full text of each version as §68-NNNNv1 / §68-NNNNv2.
 *     In the ad valorem range this affects only §68-2902 (SB 577 / SB 688, Laws
 *     2025). Both versions are real full-text exemption statutes; we keep both
 *     (section_number = "2902v1" / "2902v2") and the bare §68-2902 pointer stub
 *     drops out naturally (empty body).
 *     The catchline/title may WRAP onto following non-indented line(s) until the
 *     body starts (body lines are indented ~4 spaces, or are list items, or are
 *     the running-header / credit line).
 *   - Every section appears TWICE: once in the front Table of Contents and once
 *     in the body. TOC lines have leading whitespace + dotted leaders ending in
 *     ". . . <page-number>". We only match headers at column 0 (no leading
 *     whitespace) AND additionally drop any header line whose tail is dotted
 *     leaders, so TOC lines are excluded.
 *   - Strip the repeating running header
 *     "Oklahoma Statutes - Title 68. Revenue and Taxation   Page NNNN".
 *   - The trailing "Added by Laws .../Amended by Laws .../Laws ...Renumbered..."
 *     credit line is kept as part of full_text (the date/version stamp the
 *     corpus wants).
 *   - Skip stub sections whose title begins "Repealed by ...", "Renumbered as
 *     ...", or "Reserved" (no statutory body).
 *
 * CHAPTER GROUPING (for the issues report; all rows land under act_key
 * 'property_tax', law_category 'property_tax'):
 *   exemptions             §§ 2887-2912.x
 *   assessment             §§ 2817-2860.x
 *   assessment_review      §§ 2861-2886.x
 *   levy_collection_payment §§ 2913-2945.x + 3011-3024.x
 *   delinquency_tax_sale   §§ 3101-3152
 *   (plus the short-title / definitions / general front matter §§ 2801-2816)
 *
 * Run: cd apps/api && node -r ts-node/register src/db/ingestOKPropertyTax.ts
 * Idempotent (ON CONFLICT DO NOTHING). Short (<20 char) bodies are dropped.
 */

import { execFileSync } from 'child_process'
import { mkdtempSync } from 'fs'
import { readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { query } from './index'

const STATE = 'OK'
const ACT_KEY = 'property_tax'
const LAW_CATEGORY = 'property_tax'
const SOURCE_DATE = '2026-06-14'
const EFFECTIVE_YEAR = 2026
const SOURCE_URL =
  'https://www.oklegislature.gov/OK_Statutes/CompleteTitles/os68.pdf'
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) GAM-statute-ingest/1.0'

// Ad Valorem Tax Code numeric range: 2801 <= N < 3201.
const RANGE_LO = 2801
const RANGE_HI = 3201 // exclusive

const SECTION_RE = /^§68-(\d+(?:\.\d+)?(?:v\d+)?)\.\s*(.*)$/
const RUNNING_HEADER_RE =
  /^Oklahoma Statutes - Title 68\. Revenue and Taxation\s+Page\s+\d+\s*$/
// A trailing dotted-leader + page number marks a Table-of-Contents line.
const TOC_TAIL_RE = /\.{3,}\s*\d+\s*$/

interface Parsed {
  number: string
  title: string | null
  text: string
}

function fetchPdfText(): string {
  const dir = mkdtempSync(join(tmpdir(), 'okpt-'))
  const pdf = join(dir, 'os68.pdf')
  const txt = join(dir, 'os68.txt')
  console.log(`Downloading ${SOURCE_URL} ...`)
  execFileSync('curl', ['-sL', '--max-time', '300', '-A', UA, '-o', pdf, SOURCE_URL], {
    maxBuffer: 64 * 1024 * 1024,
  })
  console.log('Extracting text with pdftotext -layout ...')
  execFileSync('pdftotext', ['-layout', pdf, txt])
  return readFileSync(txt, 'utf-8')
}

/**
 * A line counts as part of the section title (catchline) wrap — rather than the
 * body — when it has no leading whitespace, is non-empty, is not a running
 * header, is not itself a new section header, and is not a credit/list/body
 * line. In practice the catchline wraps onto column-0 continuation lines; the
 * body begins at the first indented (~4-space) line. So: a continuation title
 * line is a column-0 line that does NOT start a new section and is NOT the
 * running header. We stop title accumulation at the first indented line, the
 * first credit line, or the first list-item / blank line.
 */
function looksLikeTitleWrap(line: string): boolean {
  if (line.length === 0) return false
  if (/^\s/.test(line)) return false // indented -> body
  if (RUNNING_HEADER_RE.test(line)) return false
  if (SECTION_RE.test(line)) return false
  if (/^(Added by Laws|Amended by Laws|Laws )/.test(line)) return false
  return true
}

function parse(raw: string): { sections: Parsed[]; chapters: Record<string, number> } {
  const lines = raw.split('\n')
  const sections: Parsed[] = []

  // Collect (startLine, number, firstHeaderTail) for every BODY section header
  // in range, in document order.
  interface Hdr {
    idx: number
    number: string
    n: number
    headTail: string
  }
  const headers: Hdr[] = []
  for (let i = 0; i < lines.length; i++) {
    const m = SECTION_RE.exec(lines[i])
    if (!m) continue
    if (TOC_TAIL_RE.test(lines[i])) continue // TOC dotted-leader line
    const n = parseFloat(m[1])
    if (!Number.isFinite(n) || n < RANGE_LO || n >= RANGE_HI) continue
    headers.push({ idx: i, number: m[1], n, headTail: m[2] })
  }

  for (let h = 0; h < headers.length; h++) {
    const cur = headers[h]
    const next = headers[h + 1]
    const end = next ? next.idx : lines.length

    // Title = header tail + any column-0 wrap lines that immediately follow.
    const titleParts: string[] = []
    if (cur.headTail.trim()) titleParts.push(cur.headTail.trim())
    let bodyStart = cur.idx + 1
    for (let i = cur.idx + 1; i < end; i++) {
      if (looksLikeTitleWrap(lines[i])) {
        titleParts.push(lines[i].trim())
        bodyStart = i + 1
      } else {
        break
      }
    }
    let title: string | null = titleParts.join(' ').replace(/\s+/g, ' ').trim() || null

    // Skip repealed / renumbered-as / reserved stubs (no statutory body).
    if (title && /^(repealed\b|renumbered\b|reserved\b)/i.test(title)) continue

    // Body = remaining lines until next header, with running headers and the
    // page-break blank padding around them removed. Credit line(s) retained.
    const bodyLines: string[] = []
    for (let i = bodyStart; i < end; i++) {
      const line = lines[i]
      if (RUNNING_HEADER_RE.test(line)) continue
      bodyLines.push(line)
    }
    const text = bodyLines
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()

    if (!text || text.length < 20) continue
    if (/^\[?reserved\.?\]?$/i.test(text)) continue

    sections.push({ number: cur.number, title, text })
  }

  // Chapter tally for the report (numeric buckets).
  const chapters: Record<string, number> = {
    front_matter: 0,
    assessment: 0,
    assessment_review: 0,
    exemptions: 0,
    levy_collection_payment: 0,
    delinquency_tax_sale: 0,
  }
  for (const s of sections) {
    const n = parseFloat(s.number)
    if (n >= 3101) chapters.delinquency_tax_sale++
    else if (n >= 3011 && n < 3101) chapters.levy_collection_payment++
    else if (n >= 2913 && n < 3011) chapters.levy_collection_payment++
    else if (n >= 2887 && n < 2913) chapters.exemptions++
    else if (n >= 2861 && n < 2887) chapters.assessment_review++
    else if (n >= 2817 && n < 2861) chapters.assessment++
    else chapters.front_matter++
  }
  return { sections, chapters }
}

async function main() {
  console.log(`\n=== OK — ingesting property-tax (ad valorem) corpus (as of ${SOURCE_DATE}) ===`)
  const raw = fetchPdfText()
  const { sections, chapters } = parse(raw)
  console.log(`Parsed ${sections.length} in-range non-stub sections.`)
  console.log('Chapter tally:', chapters)

  let ok = 0
  for (const s of sections) {
    const res = await query<{ id: string }>(
      `INSERT INTO state_law_section_texts
         (state_code, act_key, section_number, section_title, full_text, source_url, source_date, effective_year, law_category)
       VALUES ('OK','property_tax',$1,$2,$3,$4,'2026-06-14',2026,'property_tax')
       ON CONFLICT (state_code, act_key, section_number, effective_year) DO NOTHING
       RETURNING id`,
      [s.number, s.title, s.text, SOURCE_URL]
    )
    ok += res.length
  }
  console.log(`\nOK done. inserted=${ok} (of ${sections.length} parsed)`)
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
