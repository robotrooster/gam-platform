/**
 * Connecticut non-tax real-estate statute full-text ingester (state-law corpus).
 *
 * Sanctioned retrieve+cite+date carve-out: GAM stores the VERBATIM text of each
 * statute section so the agent can quote + cite + date it, never advise. Same
 * posture as the AZ/NV/LA one-offs and services/stateLaw.ts.
 *
 * SOURCE — Connecticut General Assembly official publication:
 *   https://www.cga.ct.gov/current/pub/chap_<NNN>.htm
 * Static IIS-rendered HTML, no JS. Raw HTTP GET returns 200. Each chapter page
 * is a TOC list followed by every section's full body. A section body opens with:
 *   <p><span class="catchln" id="sec_<TT>-<N>">Sec. <TT>-<N>. Catchline.</span>
 *      <first body paragraph...></p>
 * followed by zero+ plain <p> body paragraphs (subsections (a),(b),...), then a
 * <p class="source-first"> source/history note, then editorial paragraphs
 * (history-first / annotation-first / annotation = case-law digests, NOT statute
 * text) and a <table class="nav_tbl"> nav block.
 *
 * PARSE: slice the page on each catchln anchor (anchor-to-next-anchor). Within a
 * slice keep the catchline <p>'s trailing body + every plain <p> (no class) body
 * paragraph + the source-first note. DROP history/annotation paragraphs, nav
 * tables, repealed ("Section N is repealed."), transferred ("Transferred to
 * Chapter ..."), reserved, and short (<20 char) bodies.
 *
 * CATEGORY → CHAPTER mapping (act_key == law_category for every block):
 *   conveyancing_title        = Title 47 chaps 821, 821a, 821b (Land Titles;
 *                               Forms of Deeds & Mortgages; Validation of
 *                               Conveyance Defects)
 *   condo_coop                = Title 47 chap 828 (Common Interest Ownership Act)
 *                               + chap 825 (predecessor Condominium Act)
 *   broker_licensing          = Title 20 chap 392 (Real Estate Licensees)
 *   mortgage_lien_foreclosure = Title 49 chap 846 (Mortgages, incl. foreclosure)
 *                               + chap 847 (Liens / mechanic's lien)
 *   general_real_property     = Title 47 chaps 821c, 822, 823, 826, 827, 828a
 *                               (the remaining Title 47 real-property chapters not
 *                               mapped above; chap 824 "Indians" is excluded)
 *
 * Run:  cd apps/api && node -r ts-node/register src/db/ingestCTRealEstate.ts
 * Idempotent (ON CONFLICT DO NOTHING). Reuses stripTags from the corpus framework.
 */

import { execFileSync } from 'child_process'
import { query } from './index'
import { stripTags } from './ingestStateLawCorpus'

const STATE = 'CT'
const SOURCE_DATE = '2026-06-14'
const EFFECTIVE_YEAR = 2026
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) GAM-statute-ingest/1.0'
const chapUrl = (chap: string) => `https://www.cga.ct.gov/current/pub/chap_${chap}.htm`

// category key -> the chapter codes that feed it (act_key == category)
const CATEGORIES: { category: string; chapters: string[] }[] = [
  { category: 'conveyancing_title', chapters: ['821', '821a', '821b'] },
  { category: 'condo_coop', chapters: ['828', '825'] },
  { category: 'broker_licensing', chapters: ['392'] },
  { category: 'mortgage_lien_foreclosure', chapters: ['846', '847'] },
  { category: 'general_real_property', chapters: ['821c', '822', '823', '826', '827', '828a'] },
]

interface Parsed {
  number: string
  title: string | null
  text: string
}

function curl(url: string): string {
  const buf = execFileSync('curl', ['-sL', '--max-time', '90', '-A', UA, url], {
    maxBuffer: 256 * 1024 * 1024,
  })
  return buf.toString('utf-8')
}

/**
 * Parse every <p> block in a section slice into {classAttr, innerHtml}. We keep
 * paragraph granularity so we can keep statute body paragraphs and drop the
 * editorial / nav trailer.
 */
function paragraphs(slice: string): { cls: string; html: string }[] {
  const out: { cls: string; html: string }[] = []
  const re = /<p\b([^>]*)>([\s\S]*?)<\/p>/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(slice)) !== null) {
    const attrs = m[1] || ''
    const clsM = attrs.match(/class\s*=\s*"([^"]*)"/i)
    out.push({ cls: clsM ? clsM[1].trim() : '', html: m[2] })
  }
  return out
}

/**
 * Parse one section slice (catchln anchor → next catchln anchor). Returns null
 * for repealed / transferred / reserved / empty sections.
 */
function parseSection(slice: string, expectedNumber: string): Parsed | null {
  const paras = paragraphs(slice)
  if (paras.length === 0) return null

  // The first <p> in the slice holds the catchln span + the section's first body
  // paragraph. Split the catchline text out of it.
  const firstHtml = paras[0].html
  const catchM = firstHtml.match(/<span class="catchln"[^>]*>([\s\S]*?)<\/span>([\s\S]*)/i)
  if (!catchM) return null
  const catchline = stripTags(catchM[1], false).trim() // "Sec. 47-37. When acquired by adverse use."
  const firstBody = stripTags(catchM[2], true).trim()

  // Title = catchline with the leading "Sec. <num>." citation stripped.
  let title: string | null = catchline.replace(/^Sec\.\s*[0-9A-Za-z.-]+\.?\s*/i, '').trim()
  if (!title) title = null

  // Body = first-paragraph body + every subsequent KEPT paragraph. Keep plain
  // <p> (no class) body paragraphs and the source-first source/history note;
  // drop history/annotation digests (editorial, not statute) and nav.
  const bodyParts: string[] = []
  if (firstBody) bodyParts.push(firstBody)
  for (let i = 1; i < paras.length; i++) {
    const { cls, html } = paras[i]
    const keep =
      cls === '' || // plain body paragraph (subsection)
      cls === 'source-first' || // the (history; P.A. ...) source note trailer
      cls === 'source'
    if (!keep) continue
    const t = stripTags(html, true).trim()
    if (t) bodyParts.push(t)
  }
  const text = bodyParts.join('\n').trim()

  // Drop repealed / transferred / reserved / empty / short.
  if (!text || text.length < 20) return null
  if (/^Section\s+[0-9A-Za-z.-]+\s+is\s+repealed/i.test(text)) return null
  if (/^Transferred\s+to\b/i.test(text)) return null
  if (/^\[?reserved\.?\]?$/i.test(text)) return null
  if (title && /^repealed\b/i.test(title)) return null

  return { number: expectedNumber, title, text }
}

/**
 * Split a chapter page into section slices keyed by the catchln anchor id, then
 * parse each. id="sec_<TT>-<N>" where TT is the title prefix (47, 20, 49) and N
 * is the section number incl. alpha suffixes (e.g. 47-42a, 20-329cc).
 */
function parseChapter(html: string): Parsed[] {
  const anchorRe = /<span class="catchln" id="sec_([0-9]+-[0-9a-z]+)">/gi
  const matches: { number: string; index: number }[] = []
  let m: RegExpExecArray | null
  while ((m = anchorRe.exec(html)) !== null) {
    matches.push({ number: m[1], index: m.index })
  }
  const out: Parsed[] = []
  const seen = new Set<string>()
  for (let i = 0; i < matches.length; i++) {
    const start = matches[i].index
    const end = i + 1 < matches.length ? matches[i + 1].index : html.length
    // Back up to the opening <p ...> that wraps this catchln span so the first
    // body paragraph is captured intact.
    const pOpen = html.lastIndexOf('<p', start)
    const sliceStart = pOpen >= 0 && pOpen < start ? pOpen : start
    const slice = html.slice(sliceStart, end)
    const parsed = parseSection(slice, matches[i].number)
    if (!parsed) continue
    if (seen.has(parsed.number)) continue // first occurrence wins
    seen.add(parsed.number)
    out.push(parsed)
  }
  return out
}

async function ingestCategory(category: string, chapters: string[]): Promise<number> {
  let ok = 0
  let skipped = 0
  const seenNumbers = new Set<string>() // dedupe across chapters within a category
  for (const chap of chapters) {
    let html: string
    try {
      html = curl(chapUrl(chap))
    } catch (e: any) {
      console.warn(`  ! ${category} chap_${chap}: fetch failed: ${e?.message || e}`)
      continue
    }
    const sections = parseChapter(html)
    for (const s of sections) {
      if (seenNumbers.has(s.number)) {
        skipped++
        continue
      }
      seenNumbers.add(s.number)
      await query(
        `INSERT INTO state_law_section_texts
           (state_code, act_key, section_number, section_title, full_text, source_url, source_date, effective_year, law_category)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (state_code, act_key, section_number, effective_year) DO NOTHING`,
        [STATE, category, s.number, s.title, s.text, chapUrl(chap), SOURCE_DATE, EFFECTIVE_YEAR, category]
      )
      ok++
    }
    console.log(`  [${category}] chap_${chap}: parsed ${sections.length} sections`)
  }
  console.log(`  [${category}] inserted ${ok} (skipped ${skipped} cross-chapter dups)`)
  return ok
}

async function main() {
  console.log(`\n=== CT — ingesting non-tax real-estate corpus (as of ${SOURCE_DATE}) ===`)
  const counts: Record<string, number> = {}
  for (const { category, chapters } of CATEGORIES) {
    counts[category] = await ingestCategory(category, chapters)
  }
  const total = Object.values(counts).reduce((a, b) => a + b, 0)
  console.log(`\nCT done. inserted=${total}`, counts)
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
