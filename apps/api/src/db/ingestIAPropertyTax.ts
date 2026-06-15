/**
 * Iowa property-tax statute full-text ingester (sanctioned retrieve+cite+date
 * carve-out — verbatim statutory text only, never advice).
 *
 * SOURCE (official ONLY): legis.iowa.gov. Two stable layers:
 *   - Per-chapter SECTION INDEX (HTML):
 *       https://www.legis.iowa.gov/law/iowaCode/sections?codeChapter={N}&year=2026
 *     Each row links the per-section PDF as href="/docs/code/2026/{sec}.pdf"
 *     (e.g. 441.21.pdf). We harvest every {sec} from these anchors.
 *   - Per-section PDF:
 *       https://www.legis.iowa.gov/docs/code/2026/{sec}.pdf
 *     version-1.7 zip-deflate PDFs that `pdftotext -layout` decodes cleanly.
 *
 * PDF LAYOUT (per section), top to bottom:
 *   - Running page header on each page: "{CHAPTER TITLE}, §{sec}"  (droppable)
 *   - Catchline line: "{sec} {Heading}."  (e.g. "441.21 Actual, assessed, and
 *     taxable value.") — heading captured as section_title.
 *   - Body paragraphs (the verbatim statutory prose we keep).
 *   - Trailing metadata to STRIP:
 *       * bracketed codification history  [C51, §505; ...]
 *       * session-law amendment lines     "2013 Acts, ch 123, §54, ..."
 *       * "Referred to in §..." cross-refs
 *       * applicability notes referencing "Acts, ch"
 *       * page footer "{weekday date} ... Iowa Code 2026, Section {sec} (...)"
 *         — the "Iowa Code 2026" string is the edition/effective-year stamp.
 *
 * Chapters ingested (the five feature-chapter groups; assessment +
 * assessment_review both live in ch.441, so 441 is fetched once):
 *   exemptions               -> ch.427
 *   assessment / review      -> ch.441
 *   levy_collection_payment  -> ch.444 + ch.445
 *   delinquency_tax_sale     -> ch.446 + ch.447
 *
 * All rows: act_key='property_tax', law_category='property_tax',
 * source_date='2026-06-14', effective_year=2026. Idempotent
 * (ON CONFLICT DO NOTHING). Repealed/reserved/empty (<20 char) bodies dropped.
 *
 * Run: cd apps/api && node -r ts-node/register src/db/ingestIAPropertyTax.ts
 */

import { execFileSync } from 'child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { query } from './index'

const STATE = 'IA'
const ACT_KEY = 'property_tax'
const LAW_CATEGORY = 'property_tax'
const SOURCE_DATE = '2026-06-14'
const EFFECTIVE_YEAR = 2026
const YEAR = 2026
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) GAM-statute-ingest/1.0'
const BASE = 'https://www.legis.iowa.gov'

// Feature-chapter groups -> chapters. 441 covers both assessment +
// assessment_review (the review sections 441.30-441.44 live in ch.441).
const CHAPTERS = [427, 441, 444, 445, 446, 447]

const indexUrl = (ch: number) => `${BASE}/law/iowaCode/sections?codeChapter=${ch}&year=${YEAR}`
const sectionPdfUrl = (sec: string) => `${BASE}/docs/code/${YEAR}/${sec}.pdf`

interface Parsed {
  number: string
  title: string | null
  text: string
}

function curlText(url: string): string {
  const buf = execFileSync('curl', ['-sL', '--max-time', '90', '-A', UA, url], {
    maxBuffer: 256 * 1024 * 1024,
  })
  return buf.toString('utf-8')
}

function curlBuffer(url: string): Buffer {
  return execFileSync('curl', ['-sL', '--max-time', '90', '-A', UA, url], {
    maxBuffer: 256 * 1024 * 1024,
  })
}

/** pdftotext -layout on an in-memory PDF buffer via a scratch tmp file. */
function pdfToText(pdf: Buffer): string {
  const dir = mkdtempSync(join(tmpdir(), 'ia-stat-'))
  const path = join(dir, 'sec.pdf')
  try {
    writeFileSync(path, pdf)
    const out = execFileSync('pdftotext', ['-layout', path, '-'], {
      maxBuffer: 64 * 1024 * 1024,
    })
    return out.toString('utf-8')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/**
 * Harvest every section number for a chapter from its HTML section index.
 * Anchors are href="/docs/code/2026/{ch}.{sec}.pdf". De-dupe, drop the
 * whole-chapter href ("/docs/code/2026/{ch}.pdf" has no sub-section), and
 * sort numerically (handles letter suffixes like 441.21A).
 */
function harvestSections(html: string, ch: number): string[] {
  const re = new RegExp(`href="/docs/code/${YEAR}/(${ch}\\.[0-9]+[A-Za-z]?)\\.pdf"`, 'gi')
  const seen = new Set<string>()
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) seen.add(m[1])
  const list = [...seen]
  list.sort((a, b) => {
    const pa = a.split('.')[1]
    const pb = b.split('.')[1]
    const na = parseInt(pa, 10)
    const nb = parseInt(pb, 10)
    if (na !== nb) return na - nb
    return pa.localeCompare(pb)
  })
  return list
}

/** True for the trailing-metadata lines that must be stripped from the body. */
function isMetadataLine(line: string): boolean {
  const t = line.trim()
  if (!t) return false
  // Page footer: "...Iowa Code 2026, Section 441.21 (84, 0)"
  if (/Iowa Code \d{4},\s*Section\b/i.test(t)) return true
  // Bracketed codification history: "[C51, §505; ...]" (whole-line or leading)
  if (/^\[/.test(t)) return true
  // Session-law amendment / applicability lines: "2013 Acts, ch 123, §54, ..."
  if (/^\d{2,4}\s+Acts?,\s+ch\b/i.test(t)) return true
  // "Referred to in §..." cross-references
  if (/^Referred to in\b/i.test(t)) return true
  return false
}

/**
 * Parse one section's pdftotext output.
 *  - Drop running page headers ("{TITLE}, §{sec}") and leading numeric page
 *    markers ("1", "2"...) that pdftotext emits at page tops.
 *  - First line that begins with the section number is the catchline; its
 *    trailing heading becomes section_title.
 *  - Body = lines after the catchline, truncated at the first metadata line.
 */
function parseSection(raw: string, sec: string): Parsed | null {
  const lines = raw.split('\n')
  const secEsc = sec.replace('.', '\\.')
  const headerRe = new RegExp(`,\\s*§${secEsc}\\b`) // running header tail
  const catchRe = new RegExp(`^\\s*${secEsc}\\s+(.+)$`)

  // Find catchline.
  let catchIdx = -1
  let heading: string | null = null
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim()
    if (!t) continue
    if (headerRe.test(t)) continue // running page header
    const m = t.match(catchRe)
    if (m) {
      catchIdx = i
      heading = m[1].trim().replace(/\.$/, '').trim() || null
      break
    }
  }
  if (catchIdx === -1) return null
  if (heading && /^repealed\b/i.test(heading)) return null
  if (heading && /^(reserved|reserved\.)$/i.test(heading)) return null

  // Body: collect from after the catchline until the first metadata line.
  // Drop running headers, lone page-number lines, and the page footer.
  const bodyLines: string[] = []
  for (let i = catchIdx + 1; i < lines.length; i++) {
    const t = lines[i].trim()
    if (!t) {
      // keep a single blank as paragraph spacer only between real content
      if (bodyLines.length && bodyLines[bodyLines.length - 1] !== '') bodyLines.push('')
      continue
    }
    if (headerRe.test(t)) continue // running page header on continuation pages
    if (/^\d{1,3}$/.test(t) && t.length <= 3) continue // lone page-number marker
    if (isMetadataLine(t)) break // hit trailing metadata — stop
    bodyLines.push(t)
  }

  // Trim trailing blanks.
  while (bodyLines.length && bodyLines[bodyLines.length - 1] === '') bodyLines.pop()
  const text = bodyLines.join('\n').trim()

  if (!text || text.length < 20) return null
  if (/^\[?reserved\.?\]?$/i.test(text)) return null
  if (/^repealed\b/i.test(text)) return null
  return { number: sec, title: heading, text }
}

async function ingestChapter(ch: number): Promise<{ ok: number; skipped: number; total: number }> {
  const html = curlText(indexUrl(ch))
  const secs = harvestSections(html, ch)
  console.log(`\nchapter ${ch}: harvested ${secs.length} sections`)

  let ok = 0
  let skipped = 0
  const CONC = 3
  for (let i = 0; i < secs.length; i += CONC) {
    if (i > 0) await new Promise((r) => setTimeout(r, 250)) // politeness
    const batch = secs.slice(i, i + CONC)
    const parsed = await Promise.all(
      batch.map(async (sec) => {
        try {
          const txt = pdfToText(curlBuffer(sectionPdfUrl(sec)))
          return { p: parseSection(txt, sec), sec }
        } catch (e: any) {
          console.warn(`  ! ${sec}: ${e?.message || e}`)
          return { p: null, sec }
        }
      })
    )
    for (const { p, sec } of parsed) {
      if (!p) {
        skipped++
        continue
      }
      await query(
        `INSERT INTO state_law_section_texts
           (state_code, act_key, section_number, section_title, full_text,
            source_url, source_date, effective_year, law_category)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (state_code, act_key, section_number, effective_year) DO NOTHING`,
        [
          STATE,
          ACT_KEY,
          p.number,
          p.title,
          p.text,
          sectionPdfUrl(sec),
          SOURCE_DATE,
          EFFECTIVE_YEAR,
          LAW_CATEGORY,
        ]
      )
      ok++
    }
    process.stdout.write(`\r  [ch ${ch}] ${Math.min(i + CONC, secs.length)}/${secs.length}`)
  }
  console.log(`\n  [ch ${ch}] inserted ${ok}, skipped ${skipped} of ${secs.length}`)
  return { ok, skipped, total: secs.length }
}

async function main() {
  console.log(`\n=== IA property-tax — ingesting full-text corpus (as of ${SOURCE_DATE}) ===`)
  let totalOk = 0
  let totalSkipped = 0
  const per: Record<number, number> = {}
  for (const ch of CHAPTERS) {
    const r = await ingestChapter(ch)
    totalOk += r.ok
    totalSkipped += r.skipped
    per[ch] = r.ok
  }
  console.log(`\nIA property-tax done. inserted=${totalOk} skipped=${totalSkipped}`, per)
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
