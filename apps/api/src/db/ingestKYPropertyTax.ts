/**
 * Kentucky property-tax statute full-text ingester (sanctioned retrieve+cite+
 * date carve-out — verbatim statutory prose, never advice).
 *
 * SOURCE (official only): Kentucky Revised Statutes, Title XI (Revenue and
 * Taxation), apps.legislature.ky.gov. Three chapters cover the GAM property-tax
 * feature groups:
 *   Ch.132 Levy and Assessment of Property Taxes   (id=37635)
 *           -> exemptions + assessment feature groups
 *   Ch.133 Supervision, Equalization, and Review of Assessments (id=37637)
 *           -> assessment_review feature group
 *   Ch.134 Payment, Collection, and Refund of Taxes (id=37639)
 *           -> levy_collection_payment + delinquency_tax_sale feature groups
 *
 * TWO-STAGE INGEST (confirmed against the live site 2026-06-14):
 *
 *   STAGE 1 — section index. GET each chapter.aspx?id=N page over plain HTTP.
 *   These are raw server-rendered HTML (no JS). Each section is an anchor:
 *       <a href="statute.aspx?id=56334">.010  Definitions for chapter. </a>
 *   We parse {opaque numeric statute id -> section suffix + title}. The chapter
 *   number is supplied by context (the suffix ".010" under Ch.132 is "132.010").
 *
 *   STAGE 2 — section text. statute.aspx?id=N does NOT return HTML; it returns a
 *   per-section PDF (Content-Type application/pdf, FileName="KRS132_010(K).pdf").
 *   We fetch the PDF and run `pdftotext -layout`. The text layer is clean and
 *   selectable (no OCR). Per-section PDFs carry no running page-number footer in
 *   the text layer, so no header/footer stripping is needed. Layout:
 *       line 1            = "132.010 Definitions for chapter."   (number + catchline)
 *       body              = numbered/lettered hierarchy (1)(a)1.a.
 *       "Effective: ..."  / "History: ..." trailer = amendment-date source note
 *   We keep the Effective/History trailer in full_text as the verbatim source
 *   note (it carries the amendment dates that justify the date stamp).
 *
 * DROP RULES: repealed sections (catchline "NNN.NNN Repealed, YYYY."),
 * reserved/renumbered stubs, and any body < 20 chars. The index marks repealed
 * sections in the link text, and the PDF first line repeats it, so we catch both.
 *
 * Every row: act_key='property_tax', law_category='property_tax',
 * source_date='2026-06-14', effective_year=2026.
 *
 * Run: cd apps/api && node -r ts-node/register src/db/ingestKYPropertyTax.ts
 * Idempotent (ON CONFLICT DO NOTHING). Reusable: re-run after an annual-refresh
 * bump of SOURCE_DATE / EFFECTIVE_YEAR to capture amended text.
 */

import { execFileSync } from 'child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { query } from './index'

const STATE = 'KY'
const ACT_KEY = 'property_tax'
const LAW_CATEGORY = 'property_tax'
const SOURCE_DATE = '2026-06-14'
const EFFECTIVE_YEAR = 2026
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) GAM-statute-ingest/1.0'
const BASE = 'https://apps.legislature.ky.gov/law/statutes'

const chapterUrl = (id: string) => `${BASE}/chapter.aspx?id=${id}`
const sectionUrl = (id: string) => `${BASE}/statute.aspx?id=${id}`

// Chapter number -> chapter-index page id.
const CHAPTERS: { chapter: string; indexId: string }[] = [
  { chapter: '132', indexId: '37635' }, // Levy and Assessment (exemptions + assessment)
  { chapter: '133', indexId: '37637' }, // Supervision/Equalization/Review (assessment_review)
  { chapter: '134', indexId: '37639' }, // Payment/Collection/Refund (levy + delinquency)
]

interface Cite {
  chapter: string
  suffix: string // e.g. ".010"
  number: string // full citation, e.g. "132.010"
  indexTitle: string // catchline text from the index anchor
  id: string // opaque numeric statute id
}
interface Parsed {
  number: string
  title: string | null
  text: string
}

const TMP = mkdtempSync(join(tmpdir(), 'ky-prop-tax-'))

function curlText(url: string): string {
  return execFileSync('curl', ['-sL', '--max-time', '60', '-A', UA, url], {
    maxBuffer: 256 * 1024 * 1024,
  }).toString('utf-8')
}

/** Fetch a per-section PDF and return its `pdftotext -layout` extraction. */
function curlPdfToText(url: string): string {
  const buf = execFileSync('curl', ['-sL', '--max-time', '60', '-A', UA, url], {
    maxBuffer: 256 * 1024 * 1024,
  })
  const pdfPath = join(TMP, 'section.pdf')
  writeFileSync(pdfPath, buf)
  return execFileSync('pdftotext', ['-layout', pdfPath, '-'], {
    maxBuffer: 256 * 1024 * 1024,
  }).toString('utf-8')
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
}

/**
 * Harvest {id, suffix, title} from a chapter index page. Anchors look like
 *   <a href="statute.aspx?id=56334">.010  Definitions for chapter. </a>
 * Restrict to anchors whose link text starts with a section suffix (".NNN").
 */
function harvestIndex(html: string, chapter: string): Cite[] {
  const re = /<a[^>]*href="statute\.aspx\?id=(\d+)"[^>]*>\s*(\.[0-9]+[A-Za-z]?)\s+([^<]*?)\s*<\/a>/gi
  const seen = new Set<string>()
  const out: Cite[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) {
    const id = m[1]
    const suffix = m[2]
    const indexTitle = decodeEntities(m[3].trim())
    const number = `${chapter}${suffix}`
    if (seen.has(number)) continue
    seen.add(number)
    out.push({ chapter, suffix, number, indexTitle, id })
  }
  return out
}

/**
 * Parse a per-section PDF text extraction.
 *   line 1 = "132.010 Definitions for chapter."  (number + catchline title)
 *   rest   = verbatim body incl. the Effective/History source-note trailer.
 * Returns null for repealed / reserved / empty sections.
 */
function parseSection(text: string, c: Cite): Parsed | null {
  // Normalize line endings; trim trailing whitespace per line but preserve the
  // statute's leading-indent hierarchy.
  const rawLines = text.replace(/\r\n?/g, '\n').split('\n').map((l) => l.replace(/\s+$/g, ''))

  // Drop leading blank lines.
  let start = 0
  while (start < rawLines.length && rawLines[start].trim() === '') start++
  if (start >= rawLines.length) return null

  // Locate the heading line: the first line beginning with this section's number.
  // Build the regex from the citation so a stray cross-reference can't be mistaken
  // for the heading.
  const numEsc = c.number.replace(/\./g, '\\.')
  const headRe = new RegExp(`^\\s*${numEsc}\\b`)
  let headIdx = -1
  for (let i = start; i < rawLines.length; i++) {
    if (headRe.test(rawLines[i])) {
      headIdx = i
      break
    }
  }
  if (headIdx === -1) return null

  const headLine = rawLines[headIdx].trim()

  // Repealed / renumbered / reserved → drop.
  if (/^\S+\s+repealed\b/i.test(headLine)) return null
  if (/^\S+\s+(renumbered|reserved|transferred)\b/i.test(headLine)) return null

  // Assemble the catchline title, which can wrap across several PDF lines. The
  // heading line starts at column 0 (with the section number); its continuation
  // lines are INDENTED (leading whitespace) and carry no body enumerator. The
  // first body line starts at column 0 — either a "(1)" enumerator or unindented
  // prose ("As used in this chapter ..."). So: consume the heading line plus any
  // immediately-following indented, non-enumerator lines.
  const titleParts = [headLine]
  for (let i = headIdx + 1; i < rawLines.length; i++) {
    const ln = rawLines[i]
    if (ln.trim() === '') break
    // Body begins at the first column-0 line.
    if (!/^\s/.test(ln)) break
    // An indented enumerator (e.g. "(1)") is body, not title.
    if (/^\s*\(?[0-9a-z]+\)/i.test(ln)) break
    titleParts.push(ln.trim())
  }

  // Title = assembled catchline with the leading citation token stripped.
  let title: string | null = titleParts
    .join(' ')
    .replace(new RegExp(`^${numEsc}\\s*`), '')
    .replace(/\s+/g, ' ')
    .trim()
  // Strip a single trailing period off the catchline title for cleanliness.
  if (title.endsWith('.')) title = title.slice(0, -1).trim()
  if (!title) title = null
  if (title && /^repealed\b/i.test(title)) return null

  // full_text = the entire verbatim section, heading line included, with internal
  // blank lines collapsed but the indentation hierarchy preserved.
  const bodyLines = rawLines.slice(headIdx)
  // Collapse runs of >1 blank line to a single blank line.
  const collapsed: string[] = []
  let prevBlank = false
  for (const l of bodyLines) {
    const blank = l.trim() === ''
    if (blank && prevBlank) continue
    collapsed.push(l)
    prevBlank = blank
  }
  const fullText = collapsed.join('\n').trim()

  if (!fullText || fullText.length < 20) return null
  // A pure "Repealed" body (catchline at repeal only) → drop.
  if (/^\S+\s+repealed\b/i.test(fullText) && !/\n/.test(fullText)) return null

  return { number: c.number, title, text: fullText }
}

async function insertSection(p: Parsed, c: Cite): Promise<boolean> {
  const rows = await query<{ id: string }>(
    `INSERT INTO state_law_section_texts
       (state_code, act_key, section_number, section_title, full_text,
        source_url, source_date, effective_year, law_category)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (state_code, act_key, section_number, effective_year) DO NOTHING
     RETURNING id`,
    [
      STATE,
      ACT_KEY,
      p.number,
      p.title,
      p.text,
      sectionUrl(c.id),
      SOURCE_DATE,
      EFFECTIVE_YEAR,
      LAW_CATEGORY,
    ]
  )
  return rows.length > 0
}

async function ingestChapter(chapter: string, indexId: string) {
  console.log(`\n--- Chapter ${chapter} (index id=${indexId}) ---`)
  let indexHtml: string
  try {
    indexHtml = curlText(chapterUrl(indexId))
  } catch (e: any) {
    console.error(`  ! FAILED to fetch Ch.${chapter} index: ${e?.message || e}`)
    return { chapter, harvested: 0, inserted: 0, droppedRepealedEtc: 0, fetchErrors: 1, ok: false }
  }
  const cites = harvestIndex(indexHtml, chapter)
  console.log(`  harvested ${cites.length} section anchors from index`)
  if (cites.length === 0) {
    console.error(`  ! Ch.${chapter} index yielded 0 anchors — likely a TOC/parse failure`)
    return { chapter, harvested: 0, inserted: 0, droppedRepealedEtc: 0, fetchErrors: 1, ok: false }
  }

  let inserted = 0
  let droppedRepealedEtc = 0
  let fetchErrors = 0
  const CONC = 3
  for (let i = 0; i < cites.length; i += CONC) {
    if (i > 0) await new Promise((r) => setTimeout(r, 250)) // politeness
    const batch = cites.slice(i, i + CONC)
    const results = batch.map((c) => {
      // Index pre-filter: repealed links are flagged in the catchline text.
      if (/^repealed\b/i.test(c.indexTitle)) return { p: null, c, fetchError: false }
      try {
        const text = curlPdfToText(sectionUrl(c.id))
        return { p: parseSection(text, c), c, fetchError: false }
      } catch (e: any) {
        console.warn(`  ! ${c.number} (id=${c.id}): ${e?.message || e}`)
        return { p: null, c, fetchError: true }
      }
    })
    for (const { p, c, fetchError } of results) {
      if (fetchError) {
        fetchErrors++
        continue
      }
      if (!p) {
        droppedRepealedEtc++
        continue
      }
      const wrote = await insertSection(p, c)
      if (wrote) inserted++
    }
    process.stdout.write(`\r  [Ch.${chapter}] processed ${Math.min(i + CONC, cites.length)}/${cites.length}, inserted ${inserted}`)
  }
  console.log(
    `\n  [Ch.${chapter}] harvested=${cites.length} inserted=${inserted} dropped(repealed/reserved/empty)=${droppedRepealedEtc} fetchErrors=${fetchErrors}`
  )
  return { chapter, harvested: cites.length, inserted, droppedRepealedEtc, fetchErrors, ok: fetchErrors === 0 }
}

async function main() {
  console.log(`\n=== KY property-tax statute ingest (verbatim; source ${SOURCE_DATE}) ===`)
  const summary: Awaited<ReturnType<typeof ingestChapter>>[] = []
  try {
    for (const { chapter, indexId } of CHAPTERS) {
      summary.push(await ingestChapter(chapter, indexId))
    }
  } finally {
    rmSync(TMP, { recursive: true, force: true })
  }

  const total = summary.reduce((a, s) => a + s.inserted, 0)
  console.log(`\n=== KY done. total inserted=${total} ===`)
  for (const s of summary) {
    console.log(
      `  Ch.${s.chapter}: inserted=${s.inserted} dropped=${s.droppedRepealedEtc} fetchErrors=${s.fetchErrors} ${s.ok ? 'OK' : 'PARTIAL/FAILED'}`
    )
  }
  process.exit(0)
}

main().catch((e) => {
  rmSync(TMP, { recursive: true, force: true })
  console.error(e)
  process.exit(1)
})
