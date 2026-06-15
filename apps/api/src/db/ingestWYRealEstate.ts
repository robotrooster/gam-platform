/**
 * Wyoming real-estate statute full-text ingester (sanctioned retrieve+cite+date
 * carve-out — verbatim statute text, never advice).
 *
 * WY publishes the official code as ONE PDF per title at
 *   https://www.wyoleg.gov/statutes/compress/title{NN}.pdf
 * (raw HTTP, no JS/auth). We fetch with curl + a browser UA, convert with
 * `pdftotext -layout`, and slice by chapter/section. The layout is uniform
 * across titles:
 *
 *   CHAPTER N - NAME        (chapter header)
 *     ARTICLE N - NAME      (article header, skipped)
 *     NN-N-NNN.  Catchline.   <- section number + catchline (may wrap a 2nd line)
 *                             <- blank line
 *   Body paragraph(s)...      <- runs until the next section-number line
 *
 * Section anchor: /^\s*(\d+-\d+-\d+)\.\s+/. The catchline is the run from the
 * number line through the first blank line (catchlines wrap onto a second line
 * but always end before the body's blank-line gap). The body runs from there
 * to the next section anchor. Form-feed chars (page breaks) are stripped; the
 * WY PDFs carry no repeating running header/footer, so no other chrome leaks in.
 *
 * Repealed ("Repealed by Laws ...") and reserved sections have the disposition
 * as their catchline and no body — dropped (title starts with repealed/reserved
 * OR body < 20 chars).
 *
 * CATEGORY → SOURCE (act_key == law_category == the category key):
 *   conveyancing_title         title34 ch 1,2,5,8,10,11,12,26
 *   condo_coop                 title34 ch 20 (WY has condo only; no co-op/CIOA)
 *   broker_licensing           title33 ch 28 (Real Estate License Act)
 *   mortgage_lien_foreclosure  title34 ch 2,3,4 + title29 (all chapters = liens)
 *   general_real_property      title34 ch 6,7,9,10,13,14,19,22,27
 * Recipe overlaps are intentional (ch2 in conveyancing + mortgage; ch10 in
 * conveyancing + general). act_key differs per category so the unique key
 * (state, act_key, section, year) lets a section live under more than one.
 *
 * Run: cd apps/api && node -r ts-node/register src/db/ingestWYRealEstate.ts
 * Idempotent (ON CONFLICT DO NOTHING).
 */

import { execFileSync } from 'child_process'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { readFileSync } from 'fs'
import { query } from './index'

const STATE = 'WY'
const SOURCE_DATE = '2026-06-14'
const EFFECTIVE_YEAR = 2026
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) GAM-statute-ingest/1.0'
const pdfUrl = (n: number) => `https://www.wyoleg.gov/statutes/compress/title${n}.pdf`

interface Section {
  number: string // e.g. "34-1-101"
  title: string | null
  text: string
}

const tmp = mkdtempSync(join(tmpdir(), 'wy-statutes-'))

/** Fetch the per-title PDF and return its `pdftotext -layout` plain text. */
function fetchTitleText(titleNum: number): string {
  const pdfPath = join(tmp, `title${titleNum}.pdf`)
  const txtPath = join(tmp, `title${titleNum}.txt`)
  execFileSync('curl', ['-sL', '--max-time', '180', '-A', UA, '-o', pdfPath, pdfUrl(titleNum)], {
    maxBuffer: 256 * 1024 * 1024,
  })
  execFileSync('pdftotext', ['-layout', pdfPath, txtPath], { maxBuffer: 256 * 1024 * 1024 })
  // Strip page-break form feeds; keep everything else verbatim.
  return readFileSync(txtPath, 'utf-8').replace(/\f/g, '')
}

const CHAPTER_RE = /^\s*CHAPTER\s+(\d+)\s+-\s+/
const ARTICLE_RE = /^\s*ARTICLE\s+\d+\s+-\s+/
// A real section catchline is ALWAYS indented in these PDFs. A flush-left (no
// leading whitespace) "NN-N-NNN." token is a wrapped body line / cross-reference
// that the layout happened to start a line with (e.g. title29 lines 232, 1050).
// Requiring leading whitespace excludes those false anchors so we never split a
// body on a citation and never overwrite a true section with body prose.
const SECTION_RE = /^[ \t]+(\d+-\d+-\d+)\.\s+(.*)$/

/**
 * Slice a title's text down to only the requested chapter numbers, in document
 * order. A chapter runs from its `CHAPTER N - ` header line to the next
 * `CHAPTER` header (or EOF).
 */
function sliceChapters(text: string, wantChapters: Set<number>): string[] {
  const lines = text.split('\n')
  const blocks: string[] = []
  let current: string[] | null = null
  for (const line of lines) {
    const m = CHAPTER_RE.exec(line)
    if (m) {
      if (current) blocks.push(current.join('\n'))
      const chNum = parseInt(m[1], 10)
      current = wantChapters.has(chNum) ? [] : null
      continue
    }
    if (current) current.push(line)
  }
  if (current) blocks.push(current.join('\n'))
  return blocks
}

/**
 * Parse all real sections out of a chapter-text block. The catchline = the
 * section-number line plus any wrapped continuation lines up to the first blank
 * line. Body = everything after that blank line up to the next section anchor.
 */
function parseSections(block: string): Section[] {
  const lines = block.split('\n')
  const out: Section[] = []

  // First, find indices of every section anchor line.
  const anchors: { idx: number; number: string }[] = []
  for (let i = 0; i < lines.length; i++) {
    const m = SECTION_RE.exec(lines[i])
    if (m) anchors.push({ idx: i, number: m[1] })
  }

  for (let a = 0; a < anchors.length; a++) {
    const startIdx = anchors[a].idx
    const endIdx = a + 1 < anchors.length ? anchors[a + 1].idx : lines.length
    const number = anchors[a].number

    // Catchline: number line's tail + wrapped lines until the first blank line.
    const firstM = SECTION_RE.exec(lines[startIdx])!
    const catchParts: string[] = [firstM[2].trim()]
    let bodyStart = startIdx + 1
    for (let i = startIdx + 1; i < endIdx; i++) {
      if (lines[i].trim() === '') {
        bodyStart = i + 1
        break
      }
      // Defensive: if an ARTICLE header sneaks in before a blank line, stop.
      if (ARTICLE_RE.test(lines[i])) {
        bodyStart = i
        break
      }
      catchParts.push(lines[i].trim())
      bodyStart = i + 1
    }
    let title: string | null = catchParts.join(' ').replace(/\s+/g, ' ').trim()
    if (!title) title = null

    // Drop repealed / reserved sections (disposition is the catchline, no body).
    if (title && /^repealed\b/i.test(title)) continue
    if (title && /^\[?reserved\.?\]?\.?$/i.test(title)) continue

    // Body: remaining lines, dropping ARTICLE headers, trimming edge blanks,
    // preserving internal paragraph structure verbatim.
    const bodyLines = lines.slice(bodyStart, endIdx).filter((l) => !ARTICLE_RE.test(l))
    const body = bodyLines.join('\n').replace(/\n{3,}/g, '\n\n').trim()

    if (!body || body.length < 20) continue
    if (/^\[?reserved\.?\]?$/i.test(body)) continue
    if (/^repealed\b/i.test(body)) continue

    out.push({ number, title, text: body })
  }
  return out
}

async function insertSections(category: string, sections: Section[]): Promise<number> {
  let ok = 0
  for (const s of sections) {
    const rows = await query<{ id: string }>(
      `INSERT INTO state_law_section_texts
         (state_code, act_key, section_number, section_title, full_text,
          source_url, source_date, effective_year, law_category)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (state_code, act_key, section_number, effective_year) DO NOTHING
       RETURNING id`,
      [
        STATE,
        category,
        s.number,
        s.title,
        s.text,
        sourceUrlFor(s.number),
        SOURCE_DATE,
        EFFECTIVE_YEAR,
        category,
      ]
    )
    if (rows.length > 0) ok++
  }
  return ok
}

/** Source URL = the per-title PDF the section came from (34/33/29). */
function sourceUrlFor(sectionNumber: string): string {
  const titleNum = parseInt(sectionNumber.split('-')[0], 10)
  return pdfUrl(titleNum)
}

async function main() {
  console.log(`\n=== WY — ingesting real-estate statute corpus (as of ${SOURCE_DATE}) ===`)

  const t34 = fetchTitleText(34)
  const t33 = fetchTitleText(33)
  const t29 = fetchTitleText(29)
  console.log(
    `fetched: title34=${t34.length} chars, title33=${t33.length} chars, title29=${t29.length} chars`
  )

  // Build the per-category section lists.
  const conveyancing = sliceChapters(t34, new Set([1, 2, 5, 8, 10, 11, 12, 26])).flatMap(
    parseSections
  )
  const condo = sliceChapters(t34, new Set([20])).flatMap(parseSections)
  const broker = sliceChapters(t33, new Set([28])).flatMap(parseSections)
  // Liens = every chapter of Title 29; mortgage/foreclosure procedure = t34 ch 2,3,4.
  // Enumerate Title 29's chapters from its own headers (1..10) and take them all.
  const t29Chapters = new Set<number>()
  for (const line of t29.split('\n')) {
    const m = CHAPTER_RE.exec(line)
    if (m) t29Chapters.add(parseInt(m[1], 10))
  }
  const mortgageLien = [
    ...sliceChapters(t34, new Set([2, 3, 4])).flatMap(parseSections),
    ...sliceChapters(t29, t29Chapters).flatMap(parseSections),
  ]
  const general = sliceChapters(t34, new Set([6, 7, 9, 10, 13, 14, 19, 22, 27])).flatMap(
    parseSections
  )

  console.log(
    `parsed: conveyancing=${conveyancing.length}, condo=${condo.length}, broker=${broker.length}, mortgage_lien=${mortgageLien.length}, general=${general.length}`
  )

  const counts: Record<string, number> = {}
  counts['conveyancing_title'] = await insertSections('conveyancing_title', conveyancing)
  counts['condo_coop'] = await insertSections('condo_coop', condo)
  counts['broker_licensing'] = await insertSections('broker_licensing', broker)
  counts['mortgage_lien_foreclosure'] = await insertSections(
    'mortgage_lien_foreclosure',
    mortgageLien
  )
  counts['general_real_property'] = await insertSections('general_real_property', general)

  const total = Object.values(counts).reduce((a, b) => a + b, 0)
  console.log(`\nWY done. inserted=${total}`, counts)
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
