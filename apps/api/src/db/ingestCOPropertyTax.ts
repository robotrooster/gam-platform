/**
 * Colorado property-tax statute full-text ingester (sanctioned retrieve+cite+date
 * carve-out — verbatim statutory text, never advice).
 *
 * SOURCE: the official OLLS-published per-title PDF for Title 39 (Taxation):
 *   https://content.leg.colorado.gov/sites/default/files/images/olls/crs2024-title-39.pdf
 * (~9.5 MB, machine-readable FlateDecode text layer — NOT scanned.) Official
 * source ONLY: no Justia / Lexis / Wayback. Version-stamped to the PDF's 2024
 * edition.
 *
 * Title 39 also contains income/sales/use tax in Articles 20-32; this ingester
 * restricts to ARTICLE 1 through ARTICLE 14 (real-property tax), cutting the
 * scan at "ARTICLE 20".
 *
 * PARSE RECIPE (verified against crs2024-title-39.pdf):
 *   (1) curl the PDF, then `pdftotext -layout` (produces ~54,639 clean lines).
 *   (2) Restrict to the property-tax range: drop everything from "ARTICLE 20" on.
 *   (3) Strip running headers/footers — every page repeats
 *       "Colorado Revised Statutes 2024", "Page N of 1163", "Uncertified
 *       Printout"; drop lines matching those.
 *   (4) Split sections on the indented catch-line pattern
 *         /^ {4,}(39-\d+(?:\.\d+)?-\d+(?:\.\d+)?)\.\s+\S/
 *       The >=4-space indent requirement is LOAD-BEARING: section numbers also
 *       appear at column 0 when a cross-reference citation wraps to the start of
 *       a body line (e.g. "...provisions of section\n39-10-104.5. Delinquent
 *       interest..."). Without the indent guard those false catch-lines create
 *       phantom/duplicate sections. Genuine catch-lines indent >= 7 spaces;
 *       wrapped citations sit at column 0.
 *   (5) Body runs from the catch-line to the next catch-line. Peel off the
 *       trailing annotation blocks ("Source:", "Editor's note:",
 *       "Cross references:", "Law reviews:", "ANNOTATION", "Annotator's note")
 *       — keep only the operative statutory text as the citable body. Note: the
 *       section number 39-X-Y encodes the (possibly decimal) article X, so the
 *       SEC regex allows a decimal in BOTH the article and section components
 *       (e.g. 39-3.5-101, 39-1-104.5).
 *   (6) Title = catch-line heading up to its terminal period (headings join
 *       segments with " - ", so the first standalone period reliably ends the
 *       heading).
 *   (7) Drop repealed/reserved/empty (<20 char) sections. Range-repealed
 *       articles (3.9, 4.1 — "39-3.9-101 to 39-3.9-106. (Repealed)") never match
 *       the single-section catch-line and are naturally excluded.
 *
 * Topic coverage (article -> recipe chapter), all five chapters present:
 *   exemptions            = arts 3, 3.5, 3.7
 *   assessment            = arts 1, 1.5, 2, 4, 5, 6, 7
 *   assessment_review     = arts 8, 9
 *   levy_collection_payment = art 10
 *   delinquency_tax_sale  = arts 11, 11.5, 12, 13, 14
 *
 * DB: act_key='property_tax', law_category='property_tax',
 *     source_date='2026-06-14', effective_year=2026.
 * Idempotent (ON CONFLICT (state_code, act_key, section_number, effective_year)
 * DO NOTHING).
 *
 * Run: cd apps/api && node -r ts-node/register src/db/ingestCOPropertyTax.ts
 */

import { execFileSync } from 'child_process'
import { mkdtempSync } from 'fs'
import { readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { query } from './index'

// Per-recipe these are hardcoded into the INSERT VALUES; kept as named docs.
// state_code='CO', act_key='property_tax', law_category='property_tax',
// source_date='2026-06-14', effective_year=2026.
const SOURCE_DATE = '2026-06-14'
const SOURCE_URL =
  'https://content.leg.colorado.gov/sites/default/files/images/olls/crs2024-title-39.pdf'
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) GAM-statute-ingest/1.0'

// Running header/footer lines repeated on every PDF page.
const HEADER_FOOTER =
  /Colorado Revised Statutes \d{4}|Page \d+ of \d+|Uncertified Printout/

// Indented catch-line: >=4 leading spaces, then "39-<art>-<sec>." then a heading.
const SECTION =
  /^ {4,}(39-\d+(?:\.\d+)?-\d+(?:\.\d+)?)\.\s+(\S.*)$/

// Trailing annotation blocks to peel off the operative body.
const META =
  /^\s*(Source:|Editor's note:|Cross references:|Law reviews:|Annotator's note|ANNOTATION|Annotations:)/

interface Parsed {
  number: string
  title: string | null
  text: string
  topic: string
}

function articleOf(number: string): string {
  const m = number.match(/^39-(\d+(?:\.\d+)?)-/)
  return m ? m[1] : '?'
}

function topicOf(number: string): string {
  const a = articleOf(number)
  if (['3', '3.5', '3.7'].includes(a)) return 'exemptions'
  if (['1', '1.5', '2', '4', '5', '6', '7'].includes(a)) return 'assessment'
  if (['8', '9'].includes(a)) return 'assessment_review'
  if (a === '10') return 'levy_collection_payment'
  if (['11', '11.5', '12', '13', '14'].includes(a)) return 'delinquency_tax_sale'
  return 'other'
}

/** Collapse multi-space runs (a -layout artifact) within a single line. */
function collapseSpaces(s: string): string {
  return s.replace(/[ \t]{2,}/g, ' ').trim()
}

function download(): string {
  const dir = mkdtempSync(join(tmpdir(), 'co-prop-tax-'))
  const pdf = join(dir, 'co_title39.pdf')
  const txt = join(dir, 'co_title39.txt')
  console.log('Downloading Title 39 PDF from official OLLS source...')
  execFileSync('curl', ['-sL', '--max-time', '300', '-A', UA, '-o', pdf, SOURCE_URL], {
    stdio: ['ignore', 'ignore', 'inherit'],
  })
  console.log('Extracting text (pdftotext -layout)...')
  execFileSync('pdftotext', ['-layout', pdf, txt])
  return readFileSync(txt, 'utf-8')
}

/**
 * Parse the extracted text into property-tax sections. Cuts the scan at
 * "ARTICLE 20" (start of non-property tax), strips headers/footers, splits on
 * indented catch-lines, peels annotation trailers, drops repealed/reserved/short.
 */
function parse(text: string): Parsed[] {
  const all = text.split('\n')

  // (2) restrict to the property-tax range (ARTICLE 1..14, before ARTICLE 20).
  let cut = all.length
  for (let i = 0; i < all.length; i++) {
    if (/^\s+ARTICLE 20\s*$/.test(all[i])) {
      cut = i
      break
    }
  }
  // (3) strip running headers/footers.
  const lines = all.slice(0, cut).filter((l) => !HEADER_FOOTER.test(l))

  // (4) split on catch-lines.
  interface Raw {
    number: string
    firstLine: string
    body: string[]
  }
  const raws: Raw[] = []
  let cur: Raw | null = null
  for (const line of lines) {
    const m = line.match(SECTION)
    if (m) {
      if (cur) raws.push(cur)
      cur = { number: m[1], firstLine: m[2], body: [] }
    } else if (cur) {
      cur.body.push(line)
    }
  }
  if (cur) raws.push(cur)

  const out: Parsed[] = []
  for (const r of raws) {
    // (5) build operative body: catch-line + body up to the first annotation block.
    const arr = [r.firstLine, ...r.body]
    let metaIdx = arr.length
    for (let i = 0; i < arr.length; i++) {
      if (META.test(arr[i])) {
        metaIdx = i
        break
      }
    }
    const fullText = arr
      .slice(0, metaIdx)
      .map(collapseSpaces)
      .filter((l) => l.length > 0)
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()

    // (6) title = heading up to its terminal period.
    const head = r.firstLine.trim()
    const tm = head.match(/^(.*?)\.(\s|$)/)
    let title: string | null = (tm ? tm[1] : head.replace(/\.$/, '')).trim()
    if (!title) title = null

    // (7) drop repealed / reserved / empty.
    if (/\(Repealed\)/i.test(head) && fullText.replace(/\s/g, '').length < 80) continue
    if (/^\(Reserved\)/i.test(head)) continue
    if (title && /^repealed\b/i.test(title)) continue
    if (fullText.length < 20) continue

    out.push({ number: r.number, title, text: fullText, topic: topicOf(r.number) })
  }
  return out
}

async function main() {
  console.log(`\n=== CO — ingesting property-tax full-text corpus (as of ${SOURCE_DATE}) ===`)
  const raw = download()
  const sections = parse(raw)

  const byTopic: Record<string, number> = {}
  for (const s of sections) byTopic[s.topic] = (byTopic[s.topic] || 0) + 1
  console.log(`Parsed ${sections.length} sections. By topic:`, JSON.stringify(byTopic))

  let inserted = 0
  for (const s of sections) {
    // RETURNING id => rows is non-empty only when a row was actually inserted
    // (empty array on ON CONFLICT DO NOTHING). query() returns rows, not a
    // result object, so rowCount is unavailable.
    const rows = await query<{ id: string }>(
      `INSERT INTO state_law_section_texts
         (state_code, act_key, section_number, section_title, full_text,
          source_url, source_date, effective_year, law_category)
       VALUES ('CO', 'property_tax', $1, $2, $3, $4, '2026-06-14', 2026, 'property_tax')
       ON CONFLICT (state_code, act_key, section_number, effective_year) DO NOTHING
       RETURNING id`,
      [s.number, s.title, s.text, SOURCE_URL]
    )
    inserted += rows.length
  }
  console.log(`\nCO property-tax done. parsed=${sections.length} inserted=${inserted}`)
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
