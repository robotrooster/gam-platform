/**
 * North Dakota property-tax statute full-text ingester (NDCC Title 57).
 *
 * Sanctioned retrieve+cite+date carve-out: we store VERBATIM codified statute
 * text (never advice) so the agent platform can quote the law back with a
 * citation + as-of date. property_tax is a hard-compliance category.
 *
 * SOURCE (official only): the ND Legislative Branch Century Code site,
 * https://ndlegis.gov/cencode/t57.html . Each chapter links to a text-bearing
 * PDF at t57cNN.pdf (decimal chapters use a dash: 57-02.2 -> t57c02-2.pdf).
 * The per-chapter .html pages are TOC/catchline-only — the codified bodies live
 * ONLY in the PDFs. So we curl the PDF and run `pdftotext -layout` (poppler).
 *
 * PARSE: in the -layout text dump a section begins at a line matching
 *   ^\s*<chap>-\d+(\.\d+)?\.\s+<catchline...>
 * where <chap> is e.g. "57-02" or the decimal "57-02.2" (so section numbers
 * read "57-02-08" / "57-02.2-01"). The catchline runs from the section number's
 * trailing period up to the FIRST line that ends in a period (catchlines wrap to
 * a second physical line in -layout output); everything after is the verbatim
 * body, which runs until the next section header. Per-page chrome is stripped:
 *   - footer:  a line that is exactly "Page No. N"
 *   - header:  a line that is exactly "CHAPTER 57-NN"
 * Repealed / Expired / Omitted / Superseded / Reserved sections collapse to a
 * one-line tombstone body and are DROPPED (we keep only live codified text).
 * Bodies under 20 chars are dropped. Bracketed metric conversions e.g.
 * "[4.05 hectares]" are part of the verbatim text and preserved.
 *
 * CHAPTER SET (five GAM feature topics; 57-02 is shared by exemptions +
 * assessment but ingested once — section numbers are unique per chapter):
 *   exemptions             57-02, 57-02.2, 57-02.3
 *   assessment             57-02, 57-05, 57-06
 *   assessment_review      57-12, 57-13, 57-14, 57-09, 57-11, 57-23
 *   levy_collection_payment 57-15, 57-20
 *   delinquency_tax_sale   57-28, 57-29, 57-30, 57-25
 * (Repealed private tax-sale chs. 57-24/57-26/57-27 are intentionally omitted —
 *  ND now uses county tax-lien foreclosure.)
 *
 * All rows land under act_key='property_tax', law_category='property_tax'.
 * Run: cd apps/api && node -r ts-node/register src/db/ingestNDPropertyTax.ts
 * Idempotent (ON CONFLICT DO NOTHING on (state_code, act_key, section_number,
 * effective_year)).
 */

import { execFileSync } from 'child_process'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { query } from './index'

const STATE = 'ND'
const ACT_KEY = 'property_tax'
const LAW_CATEGORY = 'property_tax'
const SOURCE_DATE = '2026-06-14'
const EFFECTIVE_YEAR = 2026
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) GAM-statute-ingest/1.0'
const BASE = 'https://ndlegis.gov/cencode'

// chapter -> pdf filename stem. 57-02.2 -> t57c02-2 (decimal dash form).
const CHAPTERS: { chap: string; pdf: string }[] = [
  { chap: '57-02', pdf: 't57c02' },
  { chap: '57-02.2', pdf: 't57c02-2' },
  { chap: '57-02.3', pdf: 't57c02-3' },
  { chap: '57-05', pdf: 't57c05' },
  { chap: '57-06', pdf: 't57c06' },
  { chap: '57-12', pdf: 't57c12' },
  { chap: '57-13', pdf: 't57c13' },
  { chap: '57-14', pdf: 't57c14' },
  { chap: '57-09', pdf: 't57c09' },
  { chap: '57-11', pdf: 't57c11' },
  { chap: '57-23', pdf: 't57c23' },
  { chap: '57-15', pdf: 't57c15' },
  { chap: '57-20', pdf: 't57c20' },
  { chap: '57-28', pdf: 't57c28' },
  { chap: '57-29', pdf: 't57c29' },
  { chap: '57-30', pdf: 't57c30' },
  { chap: '57-25', pdf: 't57c25' },
]

interface Parsed {
  number: string
  title: string | null
  text: string
}

const TOMBSTONE = /^(Repealed|Expired|Omitted|Superseded|Renumbered|Transferred)\b/i
const RESERVED = /^\[?Reserved\.?\]?$/i

/** Download a chapter PDF to disk and return the -layout text. */
function fetchChapterText(pdf: string): { url: string; text: string } {
  const url = `${BASE}/${pdf}.pdf`
  const buf = execFileSync('curl', ['-sL', '--max-time', '120', '-A', UA, url], {
    maxBuffer: 256 * 1024 * 1024,
  })
  if (buf.length < 1000 || buf.slice(0, 4).toString('latin1') !== '%PDF') {
    throw new Error(`not a PDF (${buf.length} bytes) from ${url}`)
  }
  const dir = mkdtempSync(join(tmpdir(), 'ndtax-'))
  try {
    const pdfPath = join(dir, `${pdf}.pdf`)
    const txtPath = join(dir, `${pdf}.txt`)
    writeFileSync(pdfPath, buf)
    execFileSync('pdftotext', ['-layout', pdfPath, txtPath], { maxBuffer: 256 * 1024 * 1024 })
    return { url, text: readFileSync(txtPath, 'utf-8') }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/**
 * Parse one chapter's -layout text into verbatim sections. `chap` is the chapter
 * citation prefix, e.g. "57-02" or "57-02.2"; section numbers read "<chap>-NN".
 */
function parseChapter(text: string, chap: string): Parsed[] {
  const lines = text.split('\n')
  const numEsc = chap.replace(/\./g, '\\.')
  const hdrRe = new RegExp(`^\\s*(${numEsc}-\\d+(?:\\.\\d+)?)\\.\\s+(\\S.*)$`)
  const chapterHdrRe = new RegExp(`^\\s*CHAPTER\\s+${numEsc}\\s*$`)
  const pageFooterRe = /^\s*Page No\.\s*\d+\s*$/

  // A genuine section header is preceded by a blank line OR sits at the top of a
  // PDF page (preceding non-blank line is a "Page No. N" footer). This rejects
  // the case where a cross-reference like "...pursuant to section\n57-15-17. Upon
  // ..." wraps so a body line starts with what looks like a header — that line is
  // preceded directly by body prose, never a blank line or a page footer.
  const heads: { i: number; number: string; rest: string }[] = []
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(hdrRe)
    if (!m) continue
    let j = i - 1
    let sawBlank = false
    while (j >= 0 && /^\s*$/.test(lines[j])) {
      sawBlank = true
      j--
    }
    const prevNonBlank = j >= 0 ? lines[j] : ''
    const atPageTop = pageFooterRe.test(prevNonBlank)
    if (i === 0 || sawBlank || atPageTop) {
      heads.push({ i, number: m[1], rest: m[2] })
    }
  }

  const out: Parsed[] = []
  for (let h = 0; h < heads.length; h++) {
    const start = heads[h].i
    const end = h + 1 < heads.length ? heads[h + 1].i : lines.length
    const block = lines.slice(start, end)

    // Catchline: first physical fragment; if it doesn't already end in '.',
    // keep consuming following lines until one ends in '.'.
    const titleParts: string[] = [heads[h].rest.trim()]
    let bodyStartRel = 1
    if (!/\.\s*$/.test(heads[h].rest.trim())) {
      for (let k = 1; k < block.length; k++) {
        const ln = block[k].trim()
        titleParts.push(ln)
        bodyStartRel = k + 1
        if (/\.\s*$/.test(ln)) break
      }
    }
    let title: string | null = titleParts
      .join(' ')
      .replace(/\s+/g, ' ')
      .replace(/\.\s*$/, '')
      .trim()
    if (!title) title = null

    // Body: everything after the catchline, minus per-page chrome.
    const body = block
      .slice(bodyStartRel)
      .filter((l) => !pageFooterRe.test(l) && !chapterHdrRe.test(l))
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()

    // Drop tombstones (repealed/expired/etc.), reserved, and stubs.
    if (!body || body.length < 20) continue
    if (TOMBSTONE.test(body) || RESERVED.test(body)) continue

    out.push({ number: heads[h].number, title, text: body })
  }
  return out
}

async function main() {
  console.log(`\n=== ND — ingesting property-tax full-text corpus (as of ${SOURCE_DATE}) ===`)
  let total = 0
  let failed = 0
  const perChapter: Record<string, number> = {}

  for (const { chap, pdf } of CHAPTERS) {
    let url = `${BASE}/${pdf}.pdf`
    try {
      const fetched = fetchChapterText(pdf)
      url = fetched.url
      const secs = parseChapter(fetched.text, chap)
      if (secs.length === 0) {
        console.warn(`  ! ${chap}: parsed 0 sections — check the source`)
        failed++
        continue
      }
      let ins = 0
      for (const s of secs) {
        await query(
          `INSERT INTO state_law_section_texts
             (state_code, act_key, section_number, section_title, full_text,
              source_url, source_date, effective_year, law_category)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
           ON CONFLICT (state_code, act_key, section_number, effective_year)
           DO NOTHING`,
          [STATE, ACT_KEY, s.number, s.title, s.text, url, SOURCE_DATE, EFFECTIVE_YEAR, LAW_CATEGORY]
        )
        ins++
      }
      perChapter[chap] = secs.length
      total += secs.length
      console.log(`  ${chap}: ${secs.length} live sections (from ${url})`)
    } catch (e: any) {
      console.error(`  ! ${chap} FAILED: ${e?.message || e}`)
      failed++
    }
  }

  console.log(`\nND done. parsed/attempted-insert=${total}, chapters_failed=${failed}`)
  console.log('per-chapter:', perChapter)
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
