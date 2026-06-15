/**
 * North Carolina non-tax real-estate statute full-text ingester (sanctioned
 * retrieve+cite+date carve-out — verbatim statutory prose only, never advice).
 *
 * Source: NC General Assembly — https://www.ncleg.gov. The official site serves
 * each General Statutes Chapter as a static, server-rendered HTML page that holds
 * EVERY section of the chapter in order (no JS render needed — raw_http). We pull
 * the whole-chapter HTML once per chapter:
 *   https://www.ncleg.gov/EnactedLegislation/Statutes/HTML/ByChapter/Chapter_{C}.html
 * and split it into sections, rather than enumerating per-section URLs. The
 * per-section endpoint (BySection/.../GS_{C}-{n}.html) carries identical prose,
 * but the whole-chapter page needs N fewer round-trips and self-enumerates.
 *
 * STATUTE PAGE LAYOUT (verified against live pages):
 *   The page is generated HTML with an inline <style> block of obfuscated CSS
 *   classes (.csXXXXXXXX). Structure is clean <p>-per-paragraph:
 *     <p class="csA"><span>Article 2. </span></p>            <- article header
 *     <p class="csA"><span>Registration. </span></p>         <- article header
 *     <p class="csB"><span>&sect; 47-17. &nbsp;{catchline}.</span></p>  <- CATCHLINE
 *     <p class="csC"><span>{body paragraph 1} ...</span></p> <- body
 *     <p class="csC"><span>(b) {body paragraph 2} ...</span></p>
 *     ...last body paragraph ends with the legislative-history parenthetical
 *        e.g. "(1715, c. 7; ...; C.S., s. 3308.)"
 *   Crucially the CATCHLINE always sits ALONE in its own <p> (number + title,
 *   nothing else), and body paragraphs are separate <p>s. So we parse by
 *   paragraph: a paragraph whose stripped text starts with "§ {C}-{n}." is a
 *   catchline; the body is every following paragraph up to the next catchline.
 *   Article/Chapter/Part headers are <p>s that DON'T start with "§" -> skipped.
 *
 * Three numbering families, all matched by one regex:
 *   flat          47-17, 47-20.4, 93A-4.1, 44A-8, 41-2, 1-40, 1-42.9
 *   Article-Part  47C-1-103, 47F-3-102, 93E-1-2.1  (Article-Part-Section)
 *
 * Repealed / reserved / transferred / recodified / expired sections render with
 * a catchline like "§ 45-12. Repealed by ..." and a stub (often history-only)
 * body -> dropped via the catchline-keyword check + the <20-char body check.
 *
 * CATEGORY -> CHAPTER MAPPING (act_key == law_category == the category key):
 *   conveyancing_title        Ch 47  (Probate and Registration) +
 *                             Ch 39  (Conveyances) +
 *                             Ch 47B (Real Property Marketable Title Act)
 *   condo_coop                Ch 47C (NC Condominium Act, 1986+) +
 *                             Ch 47A (Unit Ownership Act, pre-1986 condos) +
 *                             Ch 47F (Planned Community Act / HOA)
 *                             [NC has no standalone Cooperative Act — co-ops
 *                              fall under general corporate/property law]
 *   broker_licensing          Ch 93A (Real Estate License Law) +
 *                             Ch 93E (NC Appraisers Act)
 *   mortgage_lien_foreclosure Ch 45  (Mortgages and Deeds of Trust, incl.
 *                             Art 2A Sales Under Power of Sale = foreclosure) +
 *                             Ch 44A (Statutory Liens — mechanics'/materialmen's)
 *   general_real_property     Ch 41  (Estates) +
 *                             Ch 42  (Landlord and Tenant) +
 *                             Ch 1 Article 4 only (GS 1-35..1-42.x — adverse
 *                             possession / limitation of real actions)
 *
 * Run: cd apps/api && node -r ts-node/register src/db/ingestNCRealEstate.ts
 * Idempotent (ON CONFLICT DO NOTHING). Official source only. Verbatim.
 */

import { execFileSync } from 'child_process'
import { query } from './index'
import { stripTags } from './ingestStateLawCorpus'

const STATE = 'NC'
const SOURCE_DATE = '2026-06-14'
const EFFECTIVE_YEAR = 2026
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) GAM-statute-ingest/1.0'
const ORIGIN = 'https://www.ncleg.gov'
const chapterUrl = (c: string) =>
  `${ORIGIN}/EnactedLegislation/Statutes/HTML/ByChapter/Chapter_${c}.html`
// Per-section URL is the canonical citation for source_url stamping.
const sectionUrl = (c: string, num: string) =>
  `${ORIGIN}/EnactedLegislation/Statutes/HTML/BySection/Chapter_${c}/GS_${num}.html`

interface Parsed {
  number: string // citation, e.g. "47-17" or "47C-1-103"
  title: string | null
  text: string
}

/** Fetch a URL. Returns { status, body }. Never throws on HTTP error codes. */
function fetchUrl(url: string): { status: number; body: string } {
  const out = execFileSync(
    'curl',
    ['-sL', '--max-time', '90', '-A', UA, '-w', '\n__HTTP_STATUS__%{http_code}', url],
    { maxBuffer: 256 * 1024 * 1024 }
  ).toString('utf-8')
  const m = out.match(/\n__HTTP_STATUS__(\d+)$/)
  const status = m ? parseInt(m[1], 10) : 0
  const body = m ? out.slice(0, out.length - m[0].length) : out
  return { status, body }
}

/** A catchline starts with the section marker for this chapter: "§ {C}-{n}." */
function catchlineRe(chapter: string): RegExp {
  // Section numbers: digits with optional .N infill, and (for 47C/47F/93E)
  // an Article-Part-Section dotted/dashed form like 1-103 or 1-2.1.
  return new RegExp(`^§\\s*(${escapeRe(chapter)}-[0-9][0-9A-Za-z.\\-]*?)\\.\\s`)
}
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// A catchline / body is "dead" (non-statutory stub) if it leads with one of
// these status words — bare ("Repealed by ...") or parenthesized ("(Repealed)
// Execution of bond ...", which is how NC marks a repealed-but-titled section).
const DEAD_RE = /^\(?\s*(repealed|reserved|transferred|recodified|expired|omitted)\b/i
// A body that is itself just another section's status line (e.g. a repealed
// section whose only following paragraph is the next section's "§ 93A-37:
// Repealed by ..." line) is not statutory prose either.
const STUB_BODY_RE = /^§\s*[0-9A-Za-z.\-]+:?\s*(repealed|reserved|transferred|recodified|expired)\b/i
// An adjacent-section status paragraph: "§ 47-7: Repealed by ...", or a paired
// "§§ 39-24, 39-25: Repealed by ...". These belong to a DIFFERENT (repealed/
// reserved/etc.) section that the page renders inline; they must not pollute
// the current section's body.
const ADJ_STATUS_RE = /^§§?\s*[0-9A-Za-z.,\s\-]+:\s*(repealed|reserved|transferred|recodified|expired)\b/i

/**
 * Parse one whole-chapter HTML page into sections by paragraph. A <p> whose
 * stripped text starts with "§ {C}-{n}." is a catchline; the body is every
 * subsequent <p> until the next catchline (or end of page). Article/Part/Chapter
 * header <p>s (no "§") are skipped. `keep(num)` filters to the target range
 * (used to take only Ch 1 Article 4). Returns parsed sections, repealed/
 * reserved/short dropped.
 */
function parseChapter(html: string, chapter: string, keep?: (num: string) => boolean): Parsed[] {
  // Drop the inline <style>/<script> blocks first; their content is generated
  // CSS, not statute text. Normalize the section-sign entity (&sect; / &#167;)
  // to "§" — the shared decodeEntities() does not map &sect;, and the catchline
  // marker depends on it.
  let s = html.replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<script[\s\S]*?<\/script>/gi, ' ')
  s = s.replace(/&sect;/gi, '§').replace(/&#167;/g, '§').replace(/&#xa7;/gi, '§')
  const paras = [...s.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)].map((m) => stripTags(m[1], false))

  const cre = catchlineRe(chapter)
  // Index every catchline paragraph.
  const heads: { idx: number; number: string; title: string | null }[] = []
  for (let i = 0; i < paras.length; i++) {
    const p = paras[i].trim()
    const m = cre.exec(p)
    if (!m) continue
    const number = m[1]
    // Title = catchline minus the "§ {number}." prefix.
    let title: string | null = p
      .slice(m[0].length)
      .replace(/^\s+/, '')
      .trim()
    if (!title) title = null
    heads.push({ idx: i, number, title })
  }

  const out: Parsed[] = []
  for (let h = 0; h < heads.length; h++) {
    const { idx, number, title } = heads[h]
    if (keep && !keep(number)) continue
    if (title && DEAD_RE.test(title)) continue
    const end = h + 1 < heads.length ? heads[h + 1].idx : paras.length
    // A fully-repealed/reserved/recodified section renders as a single
    // "§ N: Repealed by ..." line with a COLON (not the "§ N. Title." period
    // form), so it never registers as its own catchline head and would glue
    // onto the PRIOR section's body. Drop any such adjacent-section status
    // paragraphs from the tail (and head, defensively) of this body.
    const bodyParas = paras
      .slice(idx + 1, end)
      .map((p) => p.trim())
      .filter((p) => p && !ADJ_STATUS_RE.test(p))
    const body = bodyParas.join('\n').trim()
    if (!body || body.length < 20) continue
    if (DEAD_RE.test(body)) continue
    if (STUB_BODY_RE.test(body)) continue
    out.push({ number, title, text: body })
  }
  return out
}

async function insert(cat: string, chapter: string, secs: Parsed[]): Promise<number> {
  let ok = 0
  for (const p of secs) {
    if (!p.number || !p.text || p.text.length < 20) continue
    await query(
      `INSERT INTO state_law_section_texts
         (state_code, act_key, section_number, section_title, full_text, source_url, source_date, effective_year, law_category)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (state_code, act_key, section_number, effective_year) DO NOTHING`,
      [STATE, cat, p.number, p.title, p.text, sectionUrl(chapter, p.number), SOURCE_DATE, EFFECTIVE_YEAR, cat]
    )
    ok++
  }
  return ok
}

/** Fetch + parse + insert one chapter under a category. */
async function ingestChapter(
  cat: string,
  chapter: string,
  keep?: (num: string) => boolean
): Promise<number> {
  const { status, body } = fetchUrl(chapterUrl(chapter))
  if (status !== 200) {
    console.warn(`  ! ${cat} Ch ${chapter}: HTTP ${status}`)
    return 0
  }
  const secs = parseChapter(body, chapter, keep)
  const ok = await insert(cat, chapter, secs)
  console.log(`  [${cat}] Ch ${chapter}: parsed ${secs.length}, inserted ${ok}`)
  return ok
}

// Ch 1 Article 4 (Limitations — Real Property / adverse possession): GS 1-35..1-42.x
function isCh1Article4(num: string): boolean {
  const m = num.match(/^1-(\d+)(?:\.\d+)?$/)
  if (!m) return false
  const n = parseInt(m[1], 10)
  return n >= 35 && n <= 42
}

async function main() {
  console.log(`\n=== NC — ingesting non-tax real-estate full-text corpus (as of ${SOURCE_DATE}) ===`)

  const counts: Record<string, number> = {}

  // conveyancing_title: Ch 47 + Ch 39 + Ch 47B
  console.log('conveyancing_title:')
  counts['conveyancing_title'] =
    (await ingestChapter('conveyancing_title', '47')) +
    (await ingestChapter('conveyancing_title', '39')) +
    (await ingestChapter('conveyancing_title', '47B'))

  // condo_coop: Ch 47C + Ch 47A + Ch 47F
  console.log('condo_coop:')
  counts['condo_coop'] =
    (await ingestChapter('condo_coop', '47C')) +
    (await ingestChapter('condo_coop', '47A')) +
    (await ingestChapter('condo_coop', '47F'))

  // broker_licensing: Ch 93A + Ch 93E
  console.log('broker_licensing:')
  counts['broker_licensing'] =
    (await ingestChapter('broker_licensing', '93A')) +
    (await ingestChapter('broker_licensing', '93E'))

  // mortgage_lien_foreclosure: Ch 45 + Ch 44A
  console.log('mortgage_lien_foreclosure:')
  counts['mortgage_lien_foreclosure'] =
    (await ingestChapter('mortgage_lien_foreclosure', '45')) +
    (await ingestChapter('mortgage_lien_foreclosure', '44A'))

  // general_real_property: Ch 41 + Ch 42 + Ch 1 Article 4 (adverse possession)
  console.log('general_real_property:')
  counts['general_real_property'] =
    (await ingestChapter('general_real_property', '41')) +
    (await ingestChapter('general_real_property', '42')) +
    (await ingestChapter('general_real_property', '1', isCh1Article4))

  const total = Object.values(counts).reduce((a, b) => a + b, 0)
  console.log(`\nNC done. inserted=${total}`, counts)
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
