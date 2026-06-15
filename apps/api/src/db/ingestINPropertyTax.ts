/**
 * Indiana PROPERTY-TAX statute full-text ingester.
 *
 * Sanctioned retrieve+cite+date carve-out: GAM stores the VERBATIM statutory
 * text of each section, source-dated, for the agent's search_state_law tool.
 * GAM retrieves + cites + dates + disclaims — never advises. (Same posture as
 * the landlord/tenant corpus; this is the property_tax law_category slice.)
 *
 * SOURCE (official only — iga.in.gov, the Indiana General Assembly):
 *   Indiana Code, Title 6 (Taxation), Article 1.1 (Property Taxes).
 *   The site is a React SPA, but the codified text is served as static keyless
 *   per-chapter PDFs whose URL template was reverse-engineered from the site JS:
 *     https://iga.in.gov/ic/{year}/Title_6/Article_1.1/Chapter_{C}.pdf
 *   A bare curl is bounced to a 691-byte SPA shell by the CDN, so each request
 *   sends a full Safari browser fingerprint (real UA + Accept/Accept-Language/
 *   Sec-Fetch headers + --compressed). The PDFs are PDF 1.4, text-extractable
 *   via `pdftotext -layout`.
 *
 * FEATURE CHAPTERS (5 topics → 11 chapters; companion chapters named in the
 * triage citations are ingested alongside the lead chapter):
 *   exemptions            = IC 6-1.1-10 (Exemptions) + IC 6-1.1-11 (Procedures)
 *   assessment            = IC 6-1.1-4 (Real Property Assessment) + IC 6-1.1-5
 *                           (Records) + IC 6-1.1-9 (Omitted/Undervalued)
 *   assessment_review     = IC 6-1.1-15 (Review/Appeal/Correction) + IC 6-1.1-13
 *                           (county PTABOA review) + IC 6-1.1-14 (DLGF review)
 *   levy_collection_payment = IC 6-1.1-22 (General Collection; due dates at -22-9)
 *   delinquency_tax_sale  = IC 6-1.1-24 (Tax Sale) + IC 6-1.1-25 (Redemption /
 *                           Tax Deeds)
 *
 * PARSE: `pdftotext -layout` per chapter. Each PDF opens with a TOC index
 * (entries indented as "   6-1.1-C-N  <catchline>", NO "IC " prefix), then the
 * section bodies. A BODY header is the only line matching /^IC 6-1\.1-C-N/ at
 * column 0 (TOC entries are indented, so the ^IC anchor excludes them). Catchline
 * = text on/after the header line up to the "Sec. N." marker (may wrap several
 * lines). Body = "Sec. N. ..." through the next ^IC header / EOF, with the
 * injected page-chrome line "Indiana Code 2025" and bare page numbers stripped.
 * The trailing Pre-1975 Recodification Citation + "Formerly:/As added by" history
 * note is kept (source-note trailer, allowed). Sections whose catchline is
 * "Repealed"/"Reserved" (no Sec. body) or whose body is <20 chars are dropped.
 *
 * Run: cd apps/api && node -r ts-node/register src/db/ingestINPropertyTax.ts
 * Idempotent (ON CONFLICT DO NOTHING).
 */

import { execFileSync } from 'child_process'
import { query } from './index'

const STATE = 'IN'
const ACT_KEY = 'property_tax'
const LAW_CATEGORY = 'property_tax'
const SOURCE_DATE = '2026-06-14'
const EFFECTIVE_YEAR = 2026
const YEAR = 2025 // path/effective year of the codified text
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15'

// topic -> ordered list of chapter numbers (lead chapter first, then companions)
const TOPICS: { topic: string; chapters: string[] }[] = [
  { topic: 'exemptions', chapters: ['10', '11'] },
  { topic: 'assessment', chapters: ['4', '5', '9'] },
  { topic: 'assessment_review', chapters: ['15', '13', '14'] },
  { topic: 'levy_collection_payment', chapters: ['22'] },
  { topic: 'delinquency_tax_sale', chapters: ['24', '25'] },
]

const chapterUrl = (c: string) =>
  `https://iga.in.gov/ic/${YEAR}/Title_6/Article_1.1/Chapter_${c}.pdf`

interface Parsed {
  number: string
  title: string | null
  text: string
}

/** Fetch a chapter PDF with a full browser fingerprint; return text via pdftotext -layout. */
function fetchChapterText(chapter: string): string {
  const url = chapterUrl(chapter)
  const tmpPdf = `/tmp/in_pt_chapter_${chapter}.pdf`
  execFileSync(
    'curl',
    [
      '-sL',
      '--compressed',
      '--fail',
      '--max-time',
      '120',
      '-H',
      `User-Agent: ${UA}`,
      '-H',
      'Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      '-H',
      'Accept-Language: en-US,en;q=0.9',
      '-H',
      'Sec-Fetch-Dest: document',
      '-H',
      'Sec-Fetch-Mode: navigate',
      '-H',
      'Sec-Fetch-Site: none',
      '-o',
      tmpPdf,
      url,
    ],
    { maxBuffer: 256 * 1024 * 1024 }
  )
  const out = execFileSync('pdftotext', ['-layout', tmpPdf, '-'], {
    maxBuffer: 256 * 1024 * 1024,
  })
  return out.toString('utf-8')
}

/** Strip injected page chrome: the "Indiana Code 2025" running header + bare page numbers. */
function isChrome(line: string): boolean {
  const t = line.trim()
  if (t === '') return false // keep blank lines for now; collapsed later
  if (/^Indiana Code \d{4}$/.test(t)) return true
  if (/^\d{1,4}$/.test(t)) return true // bare page-number line
  return false
}

/**
 * Parse one chapter's text into VERBATIM sections. Body headers are the only
 * lines matching /^IC 6-1\.1-<chapter>-<sec>/ at column 0 (TOC entries are
 * indented). Catchline runs from the header through the line before "Sec.";
 * body runs from "Sec. N." through the line before the next header / EOF.
 */
function parseChapter(text: string, chapter: string): Parsed[] {
  // pdftotext emits a form-feed (\f) at each page break, prefixed onto the FIRST
  // line of the new page. When a section's "IC 6-1.1-C-N" header lands at the top
  // of a page it arrives as "\fIC 6-1.1-...", which the ^IC anchor would miss
  // (silently dropping that section AND folding its body into the prior one).
  // Strip a leading form-feed from every line before matching.
  const lines = text.split('\n').map((l) => l.replace(/^\f+/, ''))
  const headerRe = new RegExp(
    `^IC 6-1\\.1-${chapter.replace('.', '\\.')}-([0-9]+(?:\\.[0-9]+)?)\\b(.*)$`
  )

  // Locate every body-header line index.
  const heads: { idx: number; number: string; rest: string }[] = []
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(headerRe)
    if (m) heads.push({ idx: i, number: m[1], rest: m[2] })
  }

  const out: Parsed[] = []
  for (let h = 0; h < heads.length; h++) {
    const start = heads[h].idx
    const end = h + 1 < heads.length ? heads[h + 1].idx : lines.length
    const block = lines.slice(start, end)

    // Block line 0 is the header line; the citation prefix is already consumed,
    // so block[0]'s remainder (heads[h].rest) begins the catchline.
    // Find the "Sec. N." marker that opens the body.
    let secIdx = -1
    for (let i = 0; i < block.length; i++) {
      if (/^\s*Sec\.\s/.test(block[i])) {
        secIdx = i
        break
      }
    }

    // Catchline = header remainder + any wrapped catchline lines before Sec.
    const catchParts: string[] = []
    const headRest = heads[h].rest.trim()
    if (headRest) catchParts.push(headRest)
    const catchEnd = secIdx === -1 ? block.length : secIdx
    for (let i = 1; i < catchEnd; i++) {
      if (isChrome(block[i])) continue
      const t = block[i].trim()
      if (t) catchParts.push(t)
    }
    let title: string | null = catchParts.join(' ').replace(/\s+/g, ' ').trim() || null

    // Drop repealed / reserved (these have a catchline but no Sec. body).
    if (title && /^repealed\b/i.test(title)) continue
    if (title && /^\[?reserved\.?\]?$/i.test(title)) continue
    if (secIdx === -1) continue // no body at all

    // Body = from Sec. line to end of block, page-chrome stripped, whitespace
    // normalized but paragraph breaks preserved.
    const bodyLines: string[] = []
    for (let i = secIdx; i < block.length; i++) {
      if (isChrome(block[i])) continue
      bodyLines.push(block[i].replace(/\s+$/g, ''))
    }
    // Collapse runs of blank lines to a single newline; left-trim indentation
    // (the -layout indent is purely visual) while keeping structural newlines.
    const body = bodyLines
      .map((l) => l.replace(/^\s+/, ''))
      .join('\n')
      .replace(/\n{2,}/g, '\n')
      .trim()

    if (!body || body.length < 20) continue
    if (/^\[?reserved\.?\]?$/i.test(body)) continue

    out.push({ number: `6-1.1-${chapter}-${heads[h].number}`, title, text: body })
  }
  return out
}

async function main() {
  console.log(`\n=== IN — ingesting property-tax full-text corpus (as of ${SOURCE_DATE}) ===`)

  let inserted = 0
  const perTopic: Record<string, number> = {}
  const failures: string[] = []

  for (const { topic, chapters } of TOPICS) {
    let topicOk = 0
    for (const chapter of chapters) {
      let sections: Parsed[]
      try {
        const text = fetchChapterText(chapter)
        sections = parseChapter(text, chapter)
      } catch (e: any) {
        const msg = `chapter ${chapter} (${topic}) FAILED: ${e?.message || e}`
        console.warn(`  ! ${msg}`)
        failures.push(msg)
        continue
      }
      if (sections.length === 0) {
        const msg = `chapter ${chapter} (${topic}) parsed 0 sections`
        console.warn(`  ! ${msg}`)
        failures.push(msg)
        continue
      }
      for (const s of sections) {
        await query(
          `INSERT INTO state_law_section_texts
             (state_code, act_key, section_number, section_title, full_text,
              source_url, source_date, effective_year, law_category)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
           ON CONFLICT (state_code, act_key, section_number, effective_year) DO NOTHING`,
          [
            STATE,
            ACT_KEY,
            s.number,
            s.title,
            s.text,
            chapterUrl(chapter),
            SOURCE_DATE,
            EFFECTIVE_YEAR,
            LAW_CATEGORY,
          ]
        )
        topicOk++
        inserted++
      }
      console.log(`  [${topic}] chapter ${chapter}: ${sections.length} sections`)
    }
    perTopic[topic] = topicOk
  }

  console.log(`\nIN property_tax done. attempted-insert=${inserted}`, perTopic)
  if (failures.length) console.log('FAILURES:', failures)
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
