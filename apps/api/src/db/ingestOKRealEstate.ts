/**
 * Oklahoma non-tax real-estate statute full-text ingester.
 *
 * Sanctioned retrieve+cite+date carve-out: official statute TEXT, verbatim,
 * stored for hedged both-party compliance display. Never advice.
 *
 * SOURCE: the Oklahoma Legislature's canonical "complete title" PDFs at
 *   https://www.oklegislature.gov/OK_Statutes/CompleteTitles/os{N}.pdf
 * These are plain raw-HTTP PDFs (no JS / auth). We curl each, run
 * `pdftotext -layout`, and parse the laid-out text.
 *
 * PDF LAYOUT (consistent across titles 16 / 59 / 60):
 *   - A dotted-leader TABLE OF CONTENTS first: each line is
 *       §{T}-{N}. <catchline> ........................ <pageno>
 *     (the title may wrap to a 2nd indented line, also dotted). We DROP all
 *     TOC lines — they are detected by the dotted leader ("...." run) plus a
 *     trailing page number.
 *   - Then the BODY: each section starts with a heading line
 *       §{T}-{N}. <catchline>
 *     with NO dotted leader. The catchline may wrap across up to ~3 lines
 *     before the body text begins (body lines are indented or start a new
 *     lettered/numbered subdivision). Each section's body runs until the next
 *     §-heading. A trailing source-history line ("R.L.", "Laws", "Added by
 *     Laws") is the last line of the body and is KEPT as the source note.
 *   - Running page headers/footers ("Oklahoma Statutes - Title N. ...  Page M")
 *     appear mid-body and are STRIPPED.
 *
 * CATEGORIES (act_key == law_category == category key):
 *   conveyancing_title    = Title 16 (os16.pdf), all body sections.
 *   general_real_property = Title 60 (os60.pdf), EXCLUDING the §60-501..530
 *                           Unit Ownership Estate Act block.
 *   condo_coop            = Title 60 (os60.pdf), ONLY §60-501..530 (the Unit
 *                           Ownership Estate Act — OK's single condo/co-op act).
 *   broker_licensing      = Title 59 (os59.pdf), ONLY the §59-858-* series
 *                           (The Oklahoma Real Estate License Code + the
 *                           Certified Real Estate Appraisers Act, both the
 *                           858-series real-estate licensing code).
 *   mortgage_lien_foreclosure (Round 2) = THREE titles, same PDF pipeline:
 *       - Title 46 (os46.pdf), ALL body sections — Mortgages incl. the
 *         Oklahoma Power of Sale Mortgage Foreclosure Act (§46-40 et seq.,
 *         referenced from §46-1). Section numbers kept as "46-N".
 *       - Title 42 (os42.pdf), ONLY the contiguous mechanic's/materialmen's
 *         lien block §42-141 through §42-154. Numbers kept as "42-N".
 *       - Title 12 (os12.pdf, Civil Procedure), ONLY the real-estate
 *         judicial-foreclosure procedure cluster: §12-686 / §12-687
 *         (foreclosure judgment + conveyance) and the execution/sheriff's-
 *         sale procedure §12-751..776 that foreclosure sales run under
 *         (levy, appraisement, waiver, notice of sale of realty,
 *         confirmation of sale, sheriff's deed, redemption/overplus,
 *         online auction). Numbers kept as "12-N". Title 12 is broad Civil
 *         Procedure, so we deliberately scope to this cluster only — not the
 *         whole 555-page title.
 *
 * Cites: tit. 16/60 -> "Okla. Stat. tit. N, § M"; tit. 59 -> "§ 858-M";
 *        mortgage_lien_foreclosure -> "Okla. Stat. tit. 46/42/12, § N" (the
 *        title is encoded in the "T-N" section_number prefix).
 *
 * Run: cd apps/api && node -r ts-node/register src/db/ingestOKRealEstate.ts
 * Idempotent (ON CONFLICT DO NOTHING). Repealed/reserved/short(<20)/empty
 * bodies are dropped.
 */

import { execFileSync } from 'child_process'
import { mkdtempSync } from 'fs'
import { readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { query } from './index'

const STATE = 'OK'
const SOURCE_DATE = '2026-06-14'
const EFFECTIVE_YEAR = 2026
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) GAM-statute-ingest/1.0'
const PDF_BASE = 'https://www.oklegislature.gov/OK_Statutes/CompleteTitles'

interface Parsed {
  number: string // e.g. "16-1", "60-501", "858-101"
  title: string | null
  text: string
}

const WORK = mkdtempSync(join(tmpdir(), 'ok-statutes-'))

/** Fetch os{title}.pdf and return the laid-out text. */
function fetchTitleText(title: number): string {
  const url = `${PDF_BASE}/os${title}.pdf`
  const pdf = join(WORK, `os${title}.pdf`)
  const txt = join(WORK, `os${title}.txt`)
  // The OK leg server is occasionally slow on the larger titles (os59 ~6MB).
  // Retry the curl a few times with a generous timeout before giving up.
  let lastErr: unknown
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      execFileSync(
        'curl',
        ['-sL', '--retry', '2', '--max-time', '600', '--connect-timeout', '30', '-A', UA, url, '-o', pdf],
        { maxBuffer: 256 * 1024 * 1024 }
      )
      break
    } catch (e) {
      lastErr = e
      console.warn(`  ! curl os${title}.pdf attempt ${attempt} failed; retrying...`)
    }
    if (attempt === 4) throw lastErr
  }
  execFileSync('pdftotext', ['-layout', pdf, txt], { maxBuffer: 256 * 1024 * 1024 })
  return readFileSync(txt, 'utf-8')
}

// A TOC line has a dotted leader (run of dots) AND a trailing page number.
const TOC_LINE = /\.{4,}\s*\d+\s*$/
// A running page header/footer.
const PAGE_HEADER = /^\s*Oklahoma Statutes\s*-\s*Title\s+\d+\..*Page\s+\d+\s*$/i
// Section heading for title T: "§T-NUM." at line start (optional leading ws,
// optional leading form-feed). NUM forms seen in the OK titles:
//   16-1, 16-11A, 16-27a, 60-175.6a, 60-175.11a, 60-658.1A, 60-175.302,
//   858-101, 858-2.1. The number token = digits, then any run of trailing
//   digit / letter / dot / hyphen segments, then a terminating period. We
//   capture the WHOLE token (greedy through embedded dots) so suffixed
//   decimals like "175.6a" don't collapse to "175".
function headingRe(title: number): RegExp {
  // Token = a leading digit, then zero-or-more of {alnum, dot, hyphen}, but it
  // must END on an alphanumeric (so the heading's terminating "." is not eaten).
  return new RegExp(`^\\s*\\f?\\s*§${title}-([0-9](?:[0-9A-Za-z.-]*[0-9A-Za-z])?)\\.`)
}

const HISTORY = /^\s*(R\.\s?L\.|Laws|Added by Laws|Renumbered|Repealed)/i

/**
 * Parse the body of a complete-title PDF text into sections.
 *
 * Strategy: locate body start = the SECOND occurrence of the "§T-" heading for
 * the title's first listed section (first occurrence is in the TOC). Then walk
 * line by line. On a non-TOC §-heading line, flush the prior section and start a
 * new one (capturing the catchline, which may wrap). Otherwise append to the
 * current section's accumulator. Strip running page headers.
 */
function parseTitle(text: string, title: number): Parsed[] {
  const lines = text.split('\n')
  const head = headingRe(title)

  // Body start: the first §-heading line AFTER the TOC ends. The TOC is one
  // contiguous block of dotted-leader lines at the top of the file; statute body
  // prose never ends in "....<pageno>". So the TOC ends at the LAST dotted-leader
  // line in the file, and the body begins at the next §-heading after it. (Using
  // "first non-TOC heading" is wrong: TOC catchlines that wrap to a 2nd physical
  // line have no leader on that line and would be mistaken for body sections.)
  let lastToc = -1
  for (let i = 0; i < lines.length; i++) {
    if (TOC_LINE.test(lines[i])) lastToc = i
  }
  let start = lastToc + 1
  for (let i = lastToc + 1; i < lines.length; i++) {
    if (head.test(lines[i])) {
      start = i
      break
    }
  }

  interface Raw {
    number: string
    headingLine: string
    bodyLines: string[]
  }
  const raws: Raw[] = []
  let cur: Raw | null = null

  for (let i = start; i < lines.length; i++) {
    const line = lines[i]
    if (PAGE_HEADER.test(line)) continue
    const m = head.exec(line)
    if (m && !TOC_LINE.test(line)) {
      // New section heading.
      if (cur) raws.push(cur)
      cur = { number: `${title}-${m[1]}`, headingLine: line, bodyLines: [] }
      // The catchline may continue past the §-heading on the same line; the
      // rest of the heading line after "§T-N." is the start of the catchline.
      const after = line.slice((m.index ?? 0) + m[0].length)
      cur.headingLine = after
      continue
    }
    if (cur) cur.bodyLines.push(line)
  }
  if (cur) raws.push(cur)

  const out: Parsed[] = []
  for (const r of raws) {
    // The catchline may wrap onto following body lines until the actual section
    // text begins. Heuristic: the catchline ends at the first period-terminated
    // segment OR when a body paragraph clearly begins (indented subdivision like
    // "    A.", "    1.", or an indented sentence). In practice the OK catchline
    // is a single logical line ending in ".", but wrapped headings (no trailing
    // period on the heading line) continue until a line ending in a period that
    // is itself short / header-like. We use the simple, robust rule the source
    // structure supports: accumulate heading-continuation lines (those that do
    // NOT start an indented body subdivision and that the heading-so-far has not
    // yet terminated with a period) into the title.
    let titleParts = [r.headingLine.trim()]
    let bodyStart = 0
    if (!/\.\s*$/.test(r.headingLine.trim())) {
      // Heading wrapped: pull subsequent lines until one ends in a period AND
      // the next non-empty line looks like body (indented) — i.e. the catchline
      // is complete. Cap at 3 continuation lines to avoid swallowing body.
      for (let j = 0; j < r.bodyLines.length && j < 3; j++) {
        const bl = r.bodyLines[j]
        const t = bl.trim()
        if (!t) {
          bodyStart = j + 1
          if (/\.\s*$/.test(titleParts[titleParts.length - 1])) break
          continue
        }
        titleParts.push(t)
        bodyStart = j + 1
        if (/\.\s*$/.test(t)) break
      }
    }

    let title2: string | null = titleParts.join(' ').replace(/\s+/g, ' ').trim()
    title2 = title2.replace(/\.\s*$/, '').trim() || null

    // Drop repealed / reserved at the title level.
    if (title2 && /^repealed\b/i.test(title2)) continue
    if (title2 && /^\[?reserved\.?\]?$/i.test(title2)) continue
    if (title2 && /^renumbered\b/i.test(title2)) continue

    const body = r.bodyLines
      .slice(bodyStart)
      .map((l) => l.replace(/\s+$/, ''))
      .join('\n')
      // Collapse the blank-line runs left by stripped page headers.
      .replace(/\n{3,}/g, '\n\n')
      .trim()

    if (!body || body.length < 20) continue
    if (/^\[?reserved\.?\]?$/i.test(body)) continue
    if (/^repealed\b/i.test(body)) continue

    out.push({ number: r.number, title: title2, text: body })
  }
  return out
}

/** Parse a "T-N" / "T-NA" / "T-N.M" section number's numeric part for range tests. */
function secNum(number: string, title: number): number {
  const raw = number.replace(new RegExp(`^${title}-`), '')
  const m = raw.match(/^([0-9]+)/)
  return m ? parseInt(m[1], 10) : NaN
}

async function insertAll(category: string, sections: Parsed[], sourceUrl: string): Promise<number> {
  let ok = 0
  for (const s of sections) {
    const res = await query<{ id: string }>(
      `INSERT INTO state_law_section_texts
         (state_code, act_key, section_number, section_title, full_text, source_url, source_date, effective_year, law_category)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (state_code, act_key, section_number, effective_year) DO NOTHING
       RETURNING id`,
      [STATE, category, s.number, s.title, s.text, sourceUrl, SOURCE_DATE, EFFECTIVE_YEAR, category]
    )
    ok += res.length
  }
  return ok
}

async function main() {
  console.log(`\n=== OK — ingesting non-tax real-estate corpus (as of ${SOURCE_DATE}) ===`)
  const counts: Record<string, number> = {}

  // ONLY=cat1,cat2 restricts the run to the named categories. Used for the
  // round-2 lien/foreclosure backfill so we don't re-fetch the large round-1
  // title PDFs (16/59/60). Empty => run everything (full reproducible build).
  const onlyEnv = (process.env.ONLY || '').trim()
  const only = onlyEnv ? new Set(onlyEnv.split(',').map((s) => s.trim()).filter(Boolean)) : null
  const want = (cat: string) => !only || only.has(cat)

  // --- conveyancing_title : Title 16 (all body sections) ---
  if (want('conveyancing_title')) {
    const url = `${PDF_BASE}/os16.pdf`
    const secs = parseTitle(fetchTitleText(16), 16)
    console.log(`conveyancing_title: parsed ${secs.length} body sections from Title 16`)
    counts['conveyancing_title'] = await insertAll('conveyancing_title', secs, url)
  }

  // --- Title 60 split into general_real_property + condo_coop ---
  if (want('general_real_property') || want('condo_coop')) {
    const url = `${PDF_BASE}/os60.pdf`
    const all = parseTitle(fetchTitleText(60), 60)
    const condo = all.filter((s) => {
      const n = secNum(s.number, 60)
      return n >= 501 && n <= 530
    })
    const general = all.filter((s) => {
      const n = secNum(s.number, 60)
      return !(n >= 501 && n <= 530)
    })
    console.log(
      `general_real_property: ${general.length} sections; condo_coop: ${condo.length} sections (Title 60)`
    )
    counts['general_real_property'] = await insertAll('general_real_property', general, url)
    counts['condo_coop'] = await insertAll('condo_coop', condo, url)
  }

  // --- broker_licensing : Title 59, §59-858-* only ---
  if (want('broker_licensing')) {
    const url = `${PDF_BASE}/os59.pdf`
    const all = parseTitle(fetchTitleText(59), 59)
    const broker = all.filter((s) => /^59-858-/.test(s.number))
    // Re-key the section number to the canonical "858-N" cite form.
    const rekeyed = broker.map((s) => ({ ...s, number: s.number.replace(/^59-/, '') }))
    console.log(`broker_licensing: ${rekeyed.length} sections (Title 59, 858-series)`)
    counts['broker_licensing'] = await insertAll('broker_licensing', rekeyed, url)
  }

  // --- mortgage_lien_foreclosure : Title 46 (all) + Title 42 (§141..154 lien
  //     block) + Title 12 (§686/687 + §751..776 execution-sale cluster) ---
  if (want('mortgage_lien_foreclosure')) {
    let lien = 0

    // (1) Title 46 — Mortgages + Power of Sale Mortgage Foreclosure Act (all).
    const url46 = `${PDF_BASE}/os46.pdf`
    const t46 = parseTitle(fetchTitleText(46), 46)
    console.log(`mortgage_lien_foreclosure: parsed ${t46.length} body sections from Title 46`)
    lien += await insertAll('mortgage_lien_foreclosure', t46, url46)

    // (2) Title 42 — mechanic's/materialmen's lien block §42-141..154 only.
    //     Range test is on the integer part so decimal suffixes (142.6, 143.1,
    //     147.1) inside the band are included; 152/153/154 are the upper bound.
    const url42 = `${PDF_BASE}/os42.pdf`
    const t42all = parseTitle(fetchTitleText(42), 42)
    const t42 = t42all.filter((s) => {
      const n = secNum(s.number, 42)
      return n >= 141 && n <= 154
    })
    console.log(`mortgage_lien_foreclosure: ${t42.length} lien sections (Title 42, §141-154)`)
    lien += await insertAll('mortgage_lien_foreclosure', t42, url42)

    // (3) Title 12 — judicial-foreclosure procedure cluster only. Title 12 is
    //     the full 555-page Civil Procedure code, so we scope tightly to the
    //     real-estate foreclosure-judgment + execution/sheriff's-sale sections
    //     a mortgage foreclosure actually runs under.
    const url12 = `${PDF_BASE}/os12.pdf`
    const t12all = parseTitle(fetchTitleText(12), 12)
    const t12 = t12all.filter((s) => {
      const n = secNum(s.number, 12)
      // §686 / §687: foreclosure judgment + conveyance.
      if (n === 686 || n === 687) return true
      // §751..776: levy + appraisement + waiver + notice of sale of realty +
      // confirmation + sheriff's deed + redemption/overplus + online auction.
      if (n >= 751 && n <= 776) return true
      return false
    })
    console.log(
      `mortgage_lien_foreclosure: ${t12.length} foreclosure-procedure sections (Title 12, §686/687 + §751-776)`
    )
    lien += await insertAll('mortgage_lien_foreclosure', t12, url12)

    counts['mortgage_lien_foreclosure'] = lien
  }

  const total = Object.values(counts).reduce((a, b) => a + b, 0)
  console.log(`\nOK done. inserted=${total}`, counts)
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
