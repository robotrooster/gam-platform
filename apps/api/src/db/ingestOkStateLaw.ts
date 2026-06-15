/**
 * Oklahoma Title 41 (Landlord and Tenant) full-text ingester (S453 corpus).
 *
 * SOURCE PIVOT (gotcha): the spec pointed at OSCN (oscn.net) Title 41, but as of
 * 2026-06 OSCN gates every page behind a Cloudflare Turnstile challenge — plain
 * curl AND headless Chromium both get the challenge HTML, not statute text. So
 * we pull the SAME statute from the other official Oklahoma source: the Oklahoma
 * Legislature publishes the complete Title 41 as a single verbatim PDF at
 * oklegislature.gov/OK_Statutes/CompleteTitles/os41.pdf (linked from the official
 * statutes browser iframe osStatuesTitle.html). Ungated; pdftotext -layout reads
 * it cleanly. Same statutory text, official, dated.
 *
 * PDF shape:
 *   - Cover + table of contents (page 1), then the body starting page 2.
 *   - Each section body header is a column-0 line `§41-NNN. Catchline`. The
 *     catchline may wrap onto following column-0 lines; the operative body then
 *     begins with indented paragraphs (`    `). Sections split across page
 *     footers (`Oklahoma Statutes - Title 41. Landlord and Tenant   Page N`),
 *     which we strip.
 *   - Each section ends with a non-indented source-note trailer
 *     (`R.L. 1910, ...` / `Added by Laws ...` / `Amended by Laws ...`) — trimmed
 *     to keep just the operative text.
 *   - section_number = bare number as cited (e.g. 1, 52, 113.1, 113a, 201).
 *
 * ACT MAPPING (Title 41 section ranges):
 *   general_landlord_tenant = §§ 1-40   (common-law landlord/tenant)
 *   commercial              = §§ 51, 52, 61  (nonresidential abandonment + time)
 *   residential             = §§ 101-136, 201  (Residential L/T Act + felony-screen)
 *   Farm L/T Act §§ 71-77 are ALL repealed — dropped automatically.
 *   No eviction / mobile-home / RV / self-storage act exists in Title 41.
 *
 * Run: cd apps/api && node -r ts-node/register src/db/ingestOkStateLaw.ts
 * Idempotent (ON CONFLICT DO NOTHING). Reuses stripTags is unnecessary here
 * (PDF text, not HTML); we normalize whitespace inline.
 */

import { execFileSync } from 'child_process'
import { writeFileSync, unlinkSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { query } from './index'

const STATE = 'OK'
const SOURCE_DATE = '2026-06-13'
const EFFECTIVE_YEAR = 2026
const PDF_URL = 'https://www.oklegislature.gov/OK_Statutes/CompleteTitles/os41.pdf'
const SOURCE_URL = (num: string) =>
  // canonical citation back to the official OSCN section view (human-readable
  // cite), with the complete-title PDF as the actual fetched artifact noted.
  `https://www.oklegislature.gov/OK_Statutes/CompleteTitles/os41.pdf#41-${num}`

interface Parsed {
  number: string
  title: string | null
  text: string
}

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'

/** Fetch the PDF to a temp file and return the -layout text extraction. */
function fetchPdfText(url: string): string {
  const tmp = join(tmpdir(), `ok_title41_${Date.now()}.pdf`)
  const buf = execFileSync('curl', ['-sL', '--max-time', '90', '-A', UA, url], {
    maxBuffer: 64 * 1024 * 1024,
  })
  if (buf.length < 10000 || buf.slice(0, 4).toString('latin1') !== '%PDF') {
    throw new Error(`fetch did not return a PDF (${buf.length} bytes)`)
  }
  writeFileSync(tmp, buf)
  try {
    return execFileSync('pdftotext', ['-layout', tmp, '-'], {
      maxBuffer: 64 * 1024 * 1024,
    }).toString('utf-8')
  } finally {
    try {
      unlinkSync(tmp)
    } catch {
      /* ignore */
    }
  }
}

const HEADER_RE = /^§41-(\d+(?:\.\d+|[a-z])?)\.[ \t]*(.*)$/
const FOOTER_RE = /^Oklahoma Statutes - Title 41\. Landlord and Tenant\b/
// Source-note history trailer that closes each section (drop, keep operative
// text). NB: no trailing \b — "R.L." ends in a period, and period→space is not
// a word boundary, so \b would never fire for the R.L. prefix.
const TRAILER_RE = /^(R\.L\.|Added by Laws|Amended by Laws|Laws \d|Renumbered|Repealed by Laws|R\.L\. \d)/

/** Bare section number → act_key, or null to drop (out of range / unknown). */
function actKeyFor(num: string): string | null {
  // numeric base (strip a trailing letter; keep decimal for range test)
  const base = parseFloat(num)
  if (!Number.isFinite(base)) return null
  if (base >= 1 && base <= 40) return 'general_landlord_tenant'
  if (num === '51' || num === '52' || num === '61') return 'commercial'
  if ((base >= 101 && base <= 136) || num === '201') return 'residential'
  return null
}

/**
 * Split the PDF text body into sections. Strips the TOC (everything before the
 * first page footer / first column-0 body header that is followed by indented
 * body text), strips page footers + form feeds, separates catchline from body,
 * and trims the trailing source-note history.
 */
function parseSections(raw: string): Parsed[] {
  const rawLines = raw.replace(/\f/g, '\n').split('\n')

  // The cover + table of contents is page 1; the statute body begins on page 2.
  // The first page footer ("...Landlord and Tenant   Page 2") therefore marks
  // the TOC/body boundary cleanly — far more robust than dot-leader heuristics,
  // since several TOC entries wrap onto a second line whose FIRST line carries
  // no dotted leader (e.g. §41-52, §41-117) and would otherwise be misread as a
  // body header.
  const firstFooter = rawLines.findIndex((l) => FOOTER_RE.test(l.trim()))
  if (firstFooter < 0) throw new Error('could not locate first page footer (TOC/body boundary)')

  // Body region = from the first footer to EOF, with all footers stripped.
  const lines = rawLines.slice(firstFooter).filter((l) => !FOOTER_RE.test(l.trim()))

  // Collect (header-line-index, number) for every genuine body section header.
  const heads: { idx: number; number: string }[] = []
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(HEADER_RE)
    if (m) {
      heads.push({ idx: i, number: m[1] })
    }
  }
  if (heads.length === 0) throw new Error('no body section headers found')

  const out: Parsed[] = []
  for (let h = 0; h < heads.length; h++) {
    const startIdx = heads[h].idx
    const endIdx = h + 1 < heads.length ? heads[h + 1].idx : lines.length
    const block = lines.slice(startIdx, endIdx)
    const number = heads[h].number

    // First line: "§41-N. <catchline-part>". Catchline may wrap onto following
    // column-0 (non-indented, non-blank) lines until the first indented body
    // line (leading spaces) appears.
    const firstMatch = block[0].match(HEADER_RE)!
    const catchParts: string[] = []
    if (firstMatch[2].trim()) catchParts.push(firstMatch[2].trim())

    let bodyFrom = 1
    for (let i = 1; i < block.length; i++) {
      const line = block[i]
      if (line.trim() === '') {
        // a blank line right after the header before any body = still header gap
        if (catchParts.length === 0) continue
        // blank after we already have catchline parts and no body yet → keep scanning
        // but a blank typically separates header from body only when body is next.
        continue
      }
      // Indented (4+ spaces) → body begins here.
      if (/^\s{2,}\S/.test(line)) {
        bodyFrom = i
        break
      }
      // Non-indented, non-blank, not a header → catchline continuation.
      catchParts.push(line.trim())
      bodyFrom = i + 1
    }

    let title: string | null = catchParts.join(' ').replace(/\s+/g, ' ').trim()
    // Strip a trailing period from the catchline for storage consistency.
    title = title.replace(/\.\s*$/, '')
    if (!title) title = null

    // Drop repealed / reserved stubs by catchline.
    if (title && /^repealed\b/i.test(title)) continue
    if (title && /^\[?reserved\]?\.?$/i.test(title)) continue

    // Body = remaining lines, trimmed at the source-note trailer.
    const bodyLines: string[] = []
    for (let i = bodyFrom; i < block.length; i++) {
      const t = block[i].trim()
      if (TRAILER_RE.test(t)) break // history trailer begins → stop
      bodyLines.push(block[i])
    }

    // Reflow: join wrapped lines into paragraphs. The PDF hard-wraps every line;
    // a paragraph break is a blank line. Within a paragraph, join with spaces.
    const text = reflow(bodyLines)
    if (!text || text.length < 25) continue

    out.push({ number, title, text })
  }
  return out
}

/**
 * Reflow PDF hard-wrapped lines into clean paragraphs. Blank lines = paragraph
 * boundary. Subsection markers (A. / 1. / a.) that begin a line start a new
 * paragraph for readability; otherwise wrapped lines join with a single space.
 */
function reflow(lines: string[]): string {
  const paras: string[] = []
  let cur: string[] = []
  const flush = () => {
    if (cur.length) {
      paras.push(cur.join(' ').replace(/\s+/g, ' ').trim())
      cur = []
    }
  }
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '')
    if (line.trim() === '') {
      flush()
      continue
    }
    const trimmed = line.trim()
    // New enumerated subsection at line start → start a fresh paragraph.
    if (/^([A-Z]\.|\d+\.|[a-z]\.)\s/.test(trimmed) && cur.length) {
      flush()
    }
    cur.push(trimmed)
  }
  flush()
  return paras.filter(Boolean).join('\n').trim()
}

async function main() {
  console.log(`\n=== OK — ingesting Title 41 full-text corpus (as of ${SOURCE_DATE}) ===`)
  console.log(`  fetching ${PDF_URL}`)
  const text = fetchPdfText(PDF_URL)
  const sections = parseSections(text)
  console.log(`  parsed ${sections.length} live (non-repealed) sections`)

  let ok = 0
  let skipped = 0
  const counts: Record<string, number> = {}
  for (const s of sections) {
    const actKey = actKeyFor(s.number)
    if (!actKey) {
      skipped++
      continue
    }
    await query(
      `INSERT INTO state_law_section_texts
         (state_code, act_key, section_number, section_title, full_text, source_url, source_date, effective_year)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (state_code, act_key, section_number, effective_year) DO NOTHING`,
      [STATE, actKey, s.number, s.title, s.text, SOURCE_URL(s.number), SOURCE_DATE, EFFECTIVE_YEAR]
    )
    ok++
    counts[actKey] = (counts[actKey] || 0) + 1
  }
  console.log(`\nOK done. inserted=${ok} skipped(out-of-range)=${skipped}`, counts)
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
