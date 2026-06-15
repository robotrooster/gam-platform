/**
 * Wyoming property-tax statute full-text ingester (sanctioned retrieve+cite+date
 * carve-out — verbatim statutory text only, never advice).
 *
 * SOURCE (official ONLY): the Wyoming Legislature's per-title compressed PDF at
 *   https://wyoleg.gov/statutes/compress/title39.pdf
 * (plain curl -> HTTP 200, application/pdf, ~514 pp, ~1.5 MB). The HTML viewer
 * at /statutes/statutes.aspx is an Angular SPA that returns an empty shell to
 * raw HTTP, so the PDF is the only fetchable official rendering. We run
 * `pdftotext -layout` and split on section anchors.
 *
 * SCOPE — Title 39, ad-valorem property taxation. We ingest the FULL property-
 * tax chapters, not a hand-picked allowlist (the prior run under-extracted at 15
 * rows by capturing only 2 of Chapter 11's sections). The two property-tax
 * chapters are:
 *   - CHAPTER 13 - AD VALOREM TAXATION (39-13-101 .. 39-13-113): the operative
 *     ad-valorem chapter. Imposition / fair-market valuation / classes (103-104),
 *     exemptions (105), collection + payment due dates + residence deferral (107),
 *     enforcement: delinquent lists / tax sales / tax deeds / redemption (108),
 *     taxpayer remedies + county & state board appeals (109), statute of
 *     limitations (110), distribution (111).
 *   - CHAPTER 11 - ADMINISTRATION (39-11-101 .. 39-11-111, incl. 102.1): the
 *     cross-cutting administrative chapter. Definitions (101), department of
 *     revenue administration + confidentiality (102), the State Board of
 *     Equalization (102.1), general exemptions (105), the board-appeal track
 *     (109), statute of limitations (110), distribution (111). Sections 104/106/
 *     107/108 are deliberate "There are no specific applicable provisions for X
 *     for this chapter" pointer stubs — that IS the published statutory text, so
 *     they are ingested verbatim (short but real code, not nav/TOC chrome).
 *
 * NOTE on the triage hint: it pointed at "Ch 15-17" for collection / tax sale /
 * redemption. In Wyoming's Title 39 those chapters are SALES TAX (15), USE TAX
 * (16) and FUEL TAX (17) — NOT property tax. All ad-valorem collection / tax-sale
 * / redemption law lives in Chapter 13 (esp. 39-13-107 and 39-13-108). So scope
 * is Chapters 11 + 13 only. Every row is act_key/law_category 'property_tax'.
 *
 * The TOPIC_GROUPS map below is reporting-only (which feature each section feeds);
 * any in-chapter section not listed there is still captured and inserted.
 *
 * PARSE RECIPE (verified against the converted text):
 *   - Section anchor: a line matching  ^\s*39-1[13]-NNN(.N)?\.\s+<catchline>.
 *     The section number is the canonical anchor; the catchline follows on the
 *     same line and may wrap to the next line(s) before the first subsection.
 *   - Chapter/Article boundaries are ALL-CAPS lines ("CHAPTER 13 - ...",
 *     "ARTICLE N - ..."); they're not anchors and never become rows.
 *   - Body = everything from one anchor up to the next anchor OR the next
 *     CHAPTER/ARTICLE header. Subsection hierarchy ((a)/(i)/(A)/(I)) is
 *     whitespace-indented; we preserve relative indentation and only collapse
 *     3+ blank lines and trailing per-line whitespace.
 *   - Page breaks are bare form-feed (\f) chars with NO accompanying header/
 *     footer/page-number chrome (verified) — we strip the \f and keep the line.
 *   - Drop repealed/reserved and bodies < 20 chars (repealed one-liners from
 *     other chapters never enter scope anyway).
 *
 * DATE STAMP: the PDF reflects the current published session law and embeds no
 * edition date in-text, so we record the fetch date (2026-06-14) as source_date.
 *
 * Run: cd apps/api && node -r ts-node/register src/db/ingestWYPropertyTax.ts
 * Idempotent (ON CONFLICT DO NOTHING).
 */

import { execFileSync } from 'child_process'
import { existsSync, mkdtempSync } from 'fs'
import { readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { query } from './index'

const STATE = 'WY'
const ACT_KEY = 'property_tax'
const LAW_CATEGORY = 'property_tax'
const SOURCE_DATE = '2026-06-14'
const EFFECTIVE_YEAR = 2026
const SOURCE_URL = 'https://wyoleg.gov/statutes/compress/title39.pdf'

// Reporting-only map of which feature each section feeds. Sections NOT listed
// here are still captured and inserted (see parse(): full-chapter capture). The
// only gate is "is this anchor in a property-tax chapter (39-11-* / 39-13-*)".
const TOPIC_GROUPS: Record<string, string[]> = {
  exemptions: ['39-13-105', '39-11-105'],
  assessment: ['39-13-102', '39-13-103', '39-13-104', '39-11-102.1', '39-11-102', '39-11-103', '39-11-104'],
  assessment_review: ['39-13-109', '39-11-109'],
  levy_collection_payment: ['39-13-107', '39-13-111', '39-13-113', '39-11-107', '39-11-111'],
  delinquency_tax_sale: ['39-13-108', '39-13-110', '39-11-108', '39-11-110'],
  // definitions / licensing / misc in-chapter sections captured alongside
  general: ['39-13-101', '39-13-106', '39-13-112', '39-11-101', '39-11-106'],
}
// Property-tax chapter prefixes — every anchor under these chapters is captured.
const CHAPTER_PREFIXES = ['39-11-', '39-13-']
const inScope = (num: string) => CHAPTER_PREFIXES.some((p) => num.startsWith(p))

interface Section {
  number: string
  title: string | null
  text: string
}

/** Fetch the official PDF and convert it with `pdftotext -layout`. */
function fetchAndConvert(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wy-title39-'))
  const pdf = join(dir, 'title39.pdf')
  const txt = join(dir, 'title39.txt')
  execFileSync('curl', ['-sSL', '--max-time', '120', '-o', pdf, SOURCE_URL], {
    stdio: ['ignore', 'inherit', 'inherit'],
  })
  if (!existsSync(pdf)) throw new Error('PDF download failed')
  execFileSync('pdftotext', ['-layout', pdf, txt], { stdio: 'inherit' })
  if (!existsSync(txt)) throw new Error('pdftotext failed')
  return readFileSync(txt, 'utf-8')
}

const ANCHOR_RE = /^\s*(39-1[13]-\d{3}(?:\.\d+)?)\.\s+(.*\S)\s*$/
const HEADER_RE = /^\s*(CHAPTER|ARTICLE)\s+\d/i

/**
 * Walk the converted text line-by-line. When we hit a section anchor that's in
 * scope, accumulate every following line until the next anchor or CHAPTER/
 * ARTICLE header. The catchline may wrap, so the title is the anchor's trailing
 * text plus any pre-subsection continuation lines.
 */
function parse(text: string): Section[] {
  const lines = text.replace(/\f/g, '').split('\n')
  const out: Section[] = []

  let cur: { number: string; titleParts: string[]; body: string[]; sawBody: boolean } | null = null

  const flush = () => {
    if (!cur) return
    const title = cur.titleParts.join(' ').replace(/\s+/g, ' ').trim() || null
    // Body: collapse 3+ blank lines to 1, trim trailing ws, drop leading/trailing blanks.
    let body = cur.body
      .map((l) => l.replace(/\s+$/, ''))
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/^\n+/, '')
      .replace(/\n+$/, '')
    if (title && /^repealed\b/i.test(title)) {
      cur = null
      return
    }
    if (title && /^\[?reserved\.?\]?$/i.test(title)) {
      cur = null
      return
    }
    if (body && body.length >= 20 && !/^\[?reserved\.?\]?$/i.test(body)) {
      out.push({ number: cur.number, title, text: body })
    }
    cur = null
  }

  for (const raw of lines) {
    const am = raw.match(ANCHOR_RE)
    if (am) {
      // Starting a new section closes the previous one.
      flush()
      const number = am[1]
      if (inScope(number)) {
        cur = { number, titleParts: [am[2]], body: [], sawBody: false }
      }
      continue
    }
    if (!cur) continue
    if (HEADER_RE.test(raw)) {
      // A chapter/article header terminates the current section.
      flush()
      continue
    }
    const trimmed = raw.trim()
    if (!cur.sawBody) {
      // Catchline-continuation phase: blank line OR first subsection ends it.
      if (trimmed === '') {
        cur.sawBody = true
        continue
      }
      // A subsection marker like "(a)" begins the body even with no blank line.
      if (/^\(/.test(trimmed)) {
        cur.sawBody = true
        cur.body.push(raw)
        continue
      }
      // Otherwise it's a wrapped catchline line.
      cur.titleParts.push(trimmed)
      continue
    }
    cur.body.push(raw)
  }
  flush()
  return out
}

async function main() {
  console.log(`\n=== WY — ingesting property-tax full-text corpus (as of ${SOURCE_DATE}) ===`)
  const text = fetchAndConvert()
  const sections = parse(text)

  const found = sections.map((s) => s.number)
  const foundSet = new Set(found)
  // Duplicate-anchor guard: a stray cross-reference line shouldn't have opened a
  // second section with a number we already captured.
  const dupes = found.filter((n, i) => found.indexOf(n) !== i)
  if (dupes.length) console.warn(`  ! duplicate anchors parsed: ${[...new Set(dupes)].join(', ')}`)
  console.log(`parsed ${sections.length} property-tax sections: ${found.join(', ')}`)

  // Per-topic coverage for transparency (reporting only; non-listed sections
  // are still ingested).
  for (const [topic, nums] of Object.entries(TOPIC_GROUPS)) {
    const got = nums.filter((n) => foundSet.has(n))
    const miss = nums.filter((n) => !foundSet.has(n))
    console.log(`  [${topic}] ${got.length}/${nums.length} got=${got.join(',') || '(none)'}${miss.length ? ` MISSING=${miss.join(',')}` : ''}`)
  }

  let inserted = 0
  for (const s of sections) {
    // RETURNING lets us count true inserts vs. ON CONFLICT skips (query() only
    // hands back rows, not a rowCount).
    const res = await query<{ section_number: string }>(
      `INSERT INTO state_law_section_texts
         (state_code, act_key, section_number, section_title, full_text, source_url, source_date, effective_year, law_category)
       VALUES ('WY','property_tax',$1,$2,$3,$4,'2026-06-14',2026,'property_tax')
       ON CONFLICT (state_code, act_key, section_number, effective_year) DO NOTHING
       RETURNING section_number`,
      [s.number, s.title, s.text, SOURCE_URL]
    )
    inserted += res.length
  }

  // Authoritative measured count of the WY property-tax corpus in the DB.
  const [{ count }] = await query<{ count: string }>(
    `SELECT count(*)::int AS count FROM state_law_section_texts
       WHERE state_code='WY' AND law_category='property_tax'`
  )
  console.log(`\nWY done. attempted=${sections.length} newly_inserted=${inserted} total_in_db=${count}`)
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
