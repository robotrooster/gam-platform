/**
 * North Dakota real-estate statute full-text ingester (sanctioned retrieve+
 * cite+date carve-out — verbatim statute text only, never advice).
 *
 * ND's official code (North Dakota Century Code) is published by the Legislative
 * Council at https://ndlegis.gov/cencode/ as PER-CHAPTER PDFs. The matching
 * .html URL is only a table-of-contents shell that links to the PDF; the
 * substantive statute text lives ONLY in the PDF. So for every chapter we:
 *   1. curl the PDF with a browser UA (no JS / no auth needed)
 *   2. extract layout-preserving text with `pdftotext -layout`
 *   3. split into sections on the section-header line
 *   4. keep {number, catchline title, verbatim full_text}
 *   5. DROP repealed / reserved / empty (<20 char body) / superseded stubs
 *
 * SECTION HEADER SHAPE (per chapter prefix):
 *   ^\s*<CH>-<SEC>(.<SUB>)?.  <Heading ...>.        (heading may wrap one line)
 * e.g.  "47-10-02.1. Property disclosure - Requirements - Exceptions."
 *       "47-04.1-11. Liens against units ... - Effect of\n part payment."
 * The number must be IMMEDIATELY followed by a period and then heading text on
 * the same line. A bare in-body cross-reference like "...section\n 43-23-13.1."
 * (number alone, nothing after the trailing period) is NOT a header and is
 * correctly ignored. A wrapped body line such as
 * "32-19-19 and agricultural land. Agricultural land may be redeemed..."
 * has a SPACE (not a period) after the number, so it is also ignored.
 *
 * Page chrome stripped: the centered "Page No. N" footers and the leading
 * "CHAPTER NN-NN" / chapter-title banner. No per-page running headers exist.
 *
 * CATEGORY -> CHAPTER MAP (act_key == law_category == the category key):
 *   conveyancing_title         47-09, 47-10, 47-10.2, 47-19, 47-34
 *   condo_coop                 47-04.1
 *   broker_licensing           43-23
 *   mortgage_lien_foreclosure  32-19, 35-03, 35-22, 35-27
 *   general_real_property      47-01, 47-04, 47-05, 47-06, 47-17, 47-18
 * (47-04 general estates vs 47-04.1 condo are kept distinct by the chapter
 * prefix regex: 47-04-NN vs 47-04.1-NN.)
 *
 * Run: cd apps/api && node -r ts-node/register src/db/ingestNDRealEstate.ts
 * Idempotent (ON CONFLICT DO NOTHING).
 */

import { execFileSync } from 'child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { query } from './index'

const STATE = 'ND'
const SOURCE_DATE = '2026-06-14'
const EFFECTIVE_YEAR = 2026
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) GAM-statute-ingest/1.0'
const BASE = 'https://ndlegis.gov/cencode'

// Each chapter: the PDF basename (no .pdf), the citation chapter prefix used to
// build the per-section header regex (e.g. "47-10", "47-04.1", "47-10.2"), and
// the category (act_key + law_category) it belongs to.
interface Chapter {
  file: string
  prefix: string
  category: string
}

const CHAPTERS: Chapter[] = [
  // conveyancing_title
  { file: 't47c09', prefix: '47-09', category: 'conveyancing_title' },
  { file: 't47c10', prefix: '47-10', category: 'conveyancing_title' },
  { file: 't47c10-2', prefix: '47-10.2', category: 'conveyancing_title' },
  { file: 't47c19', prefix: '47-19', category: 'conveyancing_title' },
  { file: 't47c34', prefix: '47-34', category: 'conveyancing_title' },
  // condo_coop
  { file: 't47c04-1', prefix: '47-04.1', category: 'condo_coop' },
  // broker_licensing
  { file: 't43c23', prefix: '43-23', category: 'broker_licensing' },
  // mortgage_lien_foreclosure
  { file: 't32c19', prefix: '32-19', category: 'mortgage_lien_foreclosure' },
  { file: 't35c03', prefix: '35-03', category: 'mortgage_lien_foreclosure' },
  { file: 't35c22', prefix: '35-22', category: 'mortgage_lien_foreclosure' },
  { file: 't35c27', prefix: '35-27', category: 'mortgage_lien_foreclosure' },
  // general_real_property
  { file: 't47c01', prefix: '47-01', category: 'general_real_property' },
  { file: 't47c04', prefix: '47-04', category: 'general_real_property' },
  { file: 't47c05', prefix: '47-05', category: 'general_real_property' },
  { file: 't47c06', prefix: '47-06', category: 'general_real_property' },
  { file: 't47c17', prefix: '47-17', category: 'general_real_property' },
  { file: 't47c18', prefix: '47-18', category: 'general_real_property' },
]

interface Parsed { number: string; title: string | null; text: string }

const pdfUrl = (file: string) => `${BASE}/${file}.pdf`

/** Download a chapter PDF and return its layout-preserving text. */
function fetchChapterText(file: string, scratch: string): string {
  const pdfPath = join(scratch, `${file}.pdf`)
  const buf = execFileSync('curl', ['-sL', '--max-time', '90', '-A', UA, pdfUrl(file)], {
    maxBuffer: 256 * 1024 * 1024,
  })
  if (buf.length < 1000 || buf.slice(0, 4).toString('latin1') !== '%PDF') {
    throw new Error(`not a PDF (${buf.length} bytes) for ${file}`)
  }
  writeFileSync(pdfPath, buf)
  const txt = execFileSync('pdftotext', ['-layout', pdfPath, '-'], {
    maxBuffer: 256 * 1024 * 1024,
  }).toString('utf-8')
  // pdftotext emits a form-feed (\f) at every page break, frequently prepended
  // to the FIRST line of the new page. When a section header lands at the top of
  // a page that \f sits in front of "47-10-23. ..." and would defeat the
  // start-of-line header anchor, silently dropping the section. Strip all \f.
  return txt.replace(/\f/g, '')
}

/**
 * Escape a chapter prefix for use inside a RegExp. Citation prefixes contain
 * dots (47-04.1, 47-10.2) that must be literal.
 */
function escapePrefix(prefix: string): string {
  return prefix.replace(/[.]/g, '\\.')
}

/**
 * Build the section-header matcher for a chapter prefix. A header is:
 *   start-of-line, small indent, the full section number "<prefix>-<sec>(.<sub>)?",
 *   then a period, then whitespace, then at least one non-space char (heading text)
 *   on the same line.
 * Capture group 1 = the section number (e.g. "47-10-02.1").
 */
function headerRegex(prefix: string): RegExp {
  const p = escapePrefix(prefix)
  // section: <prefix>-<digits>(.<digits>)?   then ". " then heading text.
  return new RegExp(`^[ \\t]*(${p}-\\d+(?:\\.\\d+)?)\\.[ \\t]+\\S`)
}

/** Test whether a line is a real section header for this prefix. */
function isHeader(line: string, re: RegExp): RegExpExecArray | null {
  return re.exec(line)
}

const PAGE_FOOTER = /^\s*Page No\.\s*\d+\s*$/i
const CHAPTER_BANNER = /^\s*CHAPTER\s+\d/i

/**
 * Split a chapter's pdftotext output into sections. Returns verbatim-bodied
 * sections; repealed / reserved / empty stubs and page chrome are dropped.
 */
function parseChapter(text: string, prefix: string): Parsed[] {
  const re = headerRegex(prefix)
  const rawLines = text.split('\n')

  // First pass: locate header line indices.
  const headerIdx: { idx: number; number: string }[] = []
  for (let i = 0; i < rawLines.length; i++) {
    const m = isHeader(rawLines[i], re)
    if (m) headerIdx.push({ idx: i, number: m[1] })
  }
  if (headerIdx.length === 0) return []

  const out: Parsed[] = []
  for (let h = 0; h < headerIdx.length; h++) {
    const start = headerIdx[h].idx
    const end = h + 1 < headerIdx.length ? headerIdx[h + 1].idx : rawLines.length
    const number = headerIdx[h].number

    // Block lines (excluding page chrome).
    const block = rawLines
      .slice(start, end)
      .filter((l) => !PAGE_FOOTER.test(l) && !CHAPTER_BANNER.test(l))

    if (block.length === 0) continue

    // The header line begins with "<number>. ". Strip the number+period to get
    // the start of the catchline.
    const numEsc = number.replace(/[.]/g, '\\.')
    let firstLine = block[0].replace(new RegExp(`^[ \\t]*${numEsc}\\.[ \\t]+`), '')

    // The catchline (title) is the heading text, which may wrap across lines and
    // terminates at the first period. Accumulate lines until one ends in a period
    // (that closes the heading); the remainder of the block is the body.
    const titleParts: string[] = []
    let bodyStartLine = 1 // index into `block`; default: body starts after line 0
    let remainderOnTitleLine = '' // any body text trailing on the heading's last line

    // Helper: given a chunk that contains "<heading>. <maybe body...>", split at
    // the FIRST period that ends a heading. Headings end in "." then whitespace
    // (or end-of-line). We find the first ". " boundary; everything before incl.
    // the period is heading, the rest is body that started on the same physical line.
    function splitHeadingFromBody(chunk: string): { heading: string; rest: string } | null {
      // Match up to and including the first period followed by space or EOL.
      const m = chunk.match(/^([\s\S]*?\.)(?:\s+([\s\S]*))?$/)
      if (!m) return null
      // Guard: a heading-ending period must not be a decimal inside a number
      // (e.g. "47-10-02.1" never appears at the head of a title; titles are words).
      return { heading: m[1].trim(), rest: (m[2] || '').trim() }
    }

    // Try to terminate the heading on the first line.
    let acc = firstLine
    let consumed = 0 // how many additional block lines we pulled into the heading
    let done = false
    // First, see if the first line itself contains the heading-terminating period.
    {
      const sp = splitHeadingFromBody(acc)
      if (sp && /\.$/.test(sp.heading)) {
        titleParts.push(sp.heading)
        remainderOnTitleLine = sp.rest
        done = true
      }
    }
    // If not terminated, pull subsequent lines (heading wraps) until one ends a heading.
    if (!done) {
      titleParts.push(firstLine.trim())
      for (let j = 1; j < block.length; j++) {
        consumed = j
        const ln = block[j]
        const sp = splitHeadingFromBody(ln.trim())
        if (sp && /\.$/.test(sp.heading)) {
          titleParts.push(sp.heading)
          remainderOnTitleLine = sp.rest
          done = true
          break
        } else {
          titleParts.push(ln.trim())
        }
        // Safety: a heading should never span more than ~4 lines.
        if (j >= 4) {
          done = true
          break
        }
      }
      bodyStartLine = consumed + 1
    } else {
      bodyStartLine = 1
    }

    // Build the title from the accumulated heading parts, normalizing whitespace,
    // then strip the trailing period for storage consistency with other states.
    let title: string | null = titleParts
      .join(' ')
      .replace(/\s+/g, ' ')
      .replace(/\.\s*$/, '')
      .trim()
    if (!title) title = null

    // Build the body: any remainder that trailed on the heading line, plus all
    // block lines from bodyStartLine onward, joined verbatim (internal layout
    // preserved as newlines).
    const bodyLines: string[] = []
    if (remainderOnTitleLine) bodyLines.push(remainderOnTitleLine)
    for (let j = bodyStartLine; j < block.length; j++) {
      bodyLines.push(block[j])
    }
    const body = bodyLines
      .map((l) => l.replace(/\s+$/, ''))
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()

    // Drop repealed / reserved / superseded / empty, plus relocation stubs that
    // carry only a pointer to where the text moved (e.g. ND 47-05-14
    // "Redesignated as section 17-04-02 under S.L. ...") — no substantive text.
    if (!body || body.length < 20) continue
    if (/^repealed\b/i.test(body)) continue
    if (/^superseded\b/i.test(body)) continue
    if (/^(redesignated|renumbered|transferred|omitted|moved)\b/i.test(body)) continue
    if (/^(\[?reserved\.?\]?)$/i.test(body)) continue
    if (title && /^repealed\b/i.test(title)) continue
    if (title && /^(\[?reserved\.?\]?)$/i.test(title)) continue

    out.push({ number, title, text: body })
  }
  return out
}

async function ingestChapter(ch: Chapter, scratch: string): Promise<{ ins: number; skip: number; parsed: number }> {
  const text = fetchChapterText(ch.file, scratch)
  const sections = parseChapter(text, ch.prefix)
  let ins = 0
  let skip = 0
  for (const s of sections) {
    // RETURNING id yields a row only on a real insert; an ON CONFLICT no-op
    // returns zero rows, so the array length distinguishes insert from skip.
    const r = await query<{ id: string }>(
      `INSERT INTO state_law_section_texts
         (state_code, act_key, section_number, section_title, full_text, source_url, source_date, effective_year, law_category)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (state_code, act_key, section_number, effective_year) DO NOTHING
       RETURNING id`,
      [STATE, ch.category, s.number, s.title, s.text, pdfUrl(ch.file), SOURCE_DATE, EFFECTIVE_YEAR, ch.category]
    )
    if (r.length > 0) ins++
    else skip++
  }
  console.log(
    `  [${ch.category}] ${ch.prefix} (${ch.file}.pdf): parsed ${sections.length}, inserted ${ins}, skipped ${skip}`
  )
  return { ins, skip, parsed: sections.length }
}

async function main() {
  console.log(`\n=== ND — ingesting real-estate statute corpus (as of ${SOURCE_DATE}) ===`)
  const scratch = mkdtempSync(join(tmpdir(), 'nd-statute-'))
  const counts: Record<string, number> = {}
  try {
    for (const ch of CHAPTERS) {
      const { ins } = await ingestChapter(ch, scratch)
      counts[ch.category] = (counts[ch.category] || 0) + ins
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
  const total = Object.values(counts).reduce((a, b) => a + b, 0)
  console.log(`\nND done. inserted=${total}`, counts)
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
