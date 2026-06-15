/**
 * Iowa NON-TAX real-estate statute full-text ingester (sanctioned
 * retrieve+cite+date carve-out — verbatim statutory text only, never advice).
 *
 * SOURCE (official ONLY): legis.iowa.gov. Same two stable layers the IA
 * property-tax ingester uses (ingestIAPropertyTax.ts), so this file mirrors
 * that pipeline shape:
 *   - Per-chapter SECTION INDEX (HTML):
 *       https://www.legis.iowa.gov/law/iowaCode/sections?codeChapter={CH}&year=2026
 *     Each section links its per-section PDF as
 *       href="/docs/code/2026/{CH}.{sec}.pdf"
 *     (note: the bare /docs/code/{CH}.{sec}.pdf path in the task recipe
 *     redirects to this year-stamped path; we harvest the canonical anchors
 *     directly so lettered sub-sections like 558.1A / 654.1A are never missed.)
 *   - Per-section PDF:
 *       https://www.legis.iowa.gov/docs/code/2026/{CH}.{sec}.pdf
 *     born-digital PDFs that `pdftotext -layout` decodes cleanly.
 *
 * PDF LAYOUT (per section), top to bottom:
 *   - Running page header on each page: "{CHAPTER TITLE}, §{sec}"  (droppable)
 *   - Catchline line: "{sec} {Heading}."  (heading captured as section_title)
 *   - Body paragraphs (the verbatim statutory prose we keep)
 *   - Trailing metadata to STRIP:
 *       * bracketed codification history  [C51, §1211; ...]
 *       * session-law amendment lines     "93 Acts, ch 33, §1; ..."
 *       * "Referred to in §..." cross-refs
 *       * page footer "{weekday date} ... Iowa Code 2026, Section {sec} (...)"
 *
 * CATEGORY -> CHAPTER MAPPING (act_key == law_category == the category key):
 *   conveyancing_title        -> ch.558  (Conveyances) + ch.558A (RE disclosures)
 *   condo_coop                -> ch.499B (Horizontal Property / Condominiums)
 *   broker_licensing          -> ch.543B (Brokers & Salespersons) + ch.543D (Appraisers)
 *   mortgage_lien_foreclosure -> ch.654 (Mtg foreclosure) + ch.655 (release/satisfaction)
 *                                + ch.572 (Mechanic's lien)
 *   general_real_property     -> ch.557 (Real Property in General) + ch.557A (URPERA)
 *                                + ch.562A + ch.562B (landlord-tenant) + ch.564 (easements)
 *
 * Sibling chapters per category follow the task recipe's explicit
 * parse_method enumerations. Repealed/reserved/empty (<20 char) bodies are
 * dropped. Idempotent (ON CONFLICT DO NOTHING).
 *
 * Run: cd apps/api && node -r ts-node/register src/db/ingestIARealEstate.ts
 */

import { execFileSync } from 'child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { query } from './index'

const STATE = 'IA'
const SOURCE_DATE = '2026-06-14'
const EFFECTIVE_YEAR = 2026
const YEAR = 2026
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) GAM-statute-ingest/1.0'
const BASE = 'https://www.legis.iowa.gov'

// Each category key maps to one-or-more Iowa Code chapters. The category key
// is used for BOTH act_key and law_category on every row in that group.
const CATEGORIES: Record<string, string[]> = {
  conveyancing_title: ['558', '558A'],
  condo_coop: ['499B'],
  broker_licensing: ['543B', '543D'],
  mortgage_lien_foreclosure: ['654', '655', '572'],
  general_real_property: ['557', '557A', '562A', '562B', '564'],
}

const indexUrl = (ch: string) =>
  `${BASE}/law/iowaCode/sections?codeChapter=${ch}&year=${YEAR}`
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
  const dir = mkdtempSync(join(tmpdir(), 'ia-re-'))
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
 * sort numerically with letter-suffix tiebreak (handles 558.1A, 654.2B...).
 */
function harvestSections(html: string, ch: string): string[] {
  const chEsc = ch.replace(/[A-Za-z]/g, (c) => c) // chapter may itself be lettered (558A); literal is fine
  const re = new RegExp(
    `href="/docs/code/${YEAR}/(${chEsc}\\.[0-9]+[A-Za-z]?)\\.pdf"`,
    'gi'
  )
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
  // Page footer: "...Iowa Code 2026, Section 558.41 (19, 0)"
  if (/Iowa Code \d{4},\s*Section\b/i.test(t)) return true
  // Bracketed codification history: "[C51, §1211; ...]"
  if (/^\[/.test(t)) return true
  // Session-law amendment / applicability lines: "93 Acts, ch 33, §1; ..."
  if (/^\d{2,4}\s+Acts?,\s+ch\b/i.test(t)) return true
  // "Referred to in §..." cross-references
  if (/^Referred to in\b/i.test(t)) return true
  return false
}

/**
 * Parse one section's pdftotext output.
 *  - Drop running page headers ("{TITLE}, §{sec}") and lone page-number markers.
 *  - First line that begins with the section number is the catchline; its
 *    trailing heading becomes section_title.
 *  - Body = lines after the catchline, truncated at the first metadata line.
 *  - Repealed/reserved sections (empty body after stripping, or "Repealed"/
 *    "Reserved" heading) return null.
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
  // Heading-level repealed/reserved (e.g. "Definition. Repealed by 2003 Acts...").
  if (heading && /\brepealed\b/i.test(heading) && /\bRepealed\b/.test(heading))
    return null
  if (heading && /^(reserved|reserved\.)$/i.test(heading)) return null

  // Body: collect from after the catchline until the first metadata line.
  const bodyLines: string[] = []
  for (let i = catchIdx + 1; i < lines.length; i++) {
    const t = lines[i].trim()
    if (!t) {
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

async function ingestChapter(
  category: string,
  ch: string
): Promise<{ ok: number; skipped: number; total: number }> {
  const html = curlText(indexUrl(ch))
  const secs = harvestSections(html, ch)
  console.log(`\n  [${category}] chapter ${ch}: harvested ${secs.length} sections`)

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
          console.warn(`    ! ${sec}: ${e?.message || e}`)
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
          category, // act_key == category key
          p.number,
          p.title,
          p.text,
          sectionPdfUrl(sec),
          SOURCE_DATE,
          EFFECTIVE_YEAR,
          category, // law_category == category key
        ]
      )
      ok++
    }
    process.stdout.write(
      `\r    [${category} ${ch}] ${Math.min(i + CONC, secs.length)}/${secs.length}`
    )
  }
  console.log(
    `\n    [${category} ${ch}] inserted ${ok}, skipped ${skipped} of ${secs.length}`
  )
  return { ok, skipped, total: secs.length }
}

async function main() {
  console.log(
    `\n=== IA non-tax real-estate — ingesting full-text corpus (as of ${SOURCE_DATE}) ===`
  )
  const counts: Record<string, number> = {}
  let totalSkipped = 0
  for (const [category, chapters] of Object.entries(CATEGORIES)) {
    let catOk = 0
    for (const ch of chapters) {
      const r = await ingestChapter(category, ch)
      catOk += r.ok
      totalSkipped += r.skipped
    }
    counts[category] = catOk
    console.log(`  >> ${category}: inserted ${catOk}`)
  }
  const total = Object.values(counts).reduce((a, b) => a + b, 0)
  console.log(`\nIA real-estate done. inserted=${total} skipped=${totalSkipped}`, counts)
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
