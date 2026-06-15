/**
 * South Dakota real-estate statute full-text ingester (sanctioned retrieve +
 * cite + date carve-out — verbatim statutory text only, never advice).
 *
 * SOURCE: sdlegislature.gov official API. SD exposes a clean per-section JSON
 * endpoint that beats the full-chapter HTML dump (the *.html?all=true dump is
 * served as UTF-16, painful to parse; the JSON is UTF-8 and structured):
 *
 *   GET https://sdlegislature.gov/api/Statutes/Statute/{id}
 *     -> { Statute, Type, CatchLine, Source, Html, Previous, Next, Repealed, ... }
 *
 * ENUMERATION: start from a chapter root (Type="Chapter", e.g. "43-25"); its
 * `Next` is the first section. Chain `Next` section-to-section. SD's `Next`
 * walks straight into the following chapter's root when the current chapter
 * ends, so we stop as soon as `Next` lands on a non-Section OR a Section whose
 * chapter prefix differs from the target. Chapter prefix = everything before
 * the final "-N" (rsplit on '-', 1): "43-25-18.1" -> "43-25",
 * "43-15A-3" -> "43-15A". Decimal-suffixed sections (43-25-18.1..18.6) are
 * real sections and are kept.
 *
 * PER-SECTION PARSE: the JSON `Html` field carries the same per-section markup
 * the chapter dump uses, wrapped in a <style>…</style> head plus a <body>:
 *   <span class="…SENU">43-25-1</span>  -> section number (also = d.Statute)
 *   <span class="…CL">Catchline.</span>  -> section title (also = d.CatchLine)
 *   <span class="…DefaultParagraphFont"> -> body prose
 *   <span class="…SCL">Source:</span> …  -> the official Source/history line
 * We strip the <style> block, strip the SENU number span and the CL catchline
 * span out of the body region, then stripTags the remainder. The Source line is
 * retained as the verbatim source-note trailer (the spec permits the history
 * note; it is part of the official codified text).
 *
 * DROP: repealed / reserved / transferred / omitted sections (CatchLine starts
 * "Repealed"/"Transferred"/"Omitted"/"Reserved", or empty body), TOC/chapter
 * roots, and any body < 20 chars after cleaning.
 *
 * CATEGORY -> CHAPTER MAP (act_key == law_category == the category key):
 *   conveyancing_title        43-25, 43-26, 43-28, 43-29, 43-30, 43-30A
 *   condo_coop                43-15A, 43-15B
 *   broker_licensing          36-21A, 36-21B
 *   mortgage_lien_foreclosure 44-8, 44-9, 21-47, 21-48, 21-49
 *   general_real_property     43-1, 43-2, 43-2A, 43-3, 43-4, 43-5, 43-6, 43-7,
 *                             43-8, 43-9, 43-11, 43-12, 43-13, 43-13A, 43-14,
 *                             43-16, 43-17, 43-23, 43-27, 43-31, 43-32, 43-33,
 *                             15-3 (adverse possession / limitation of actions)
 *
 * Run: cd apps/api && node -r ts-node/register src/db/ingestSDRealEstate.ts
 * Idempotent (ON CONFLICT DO NOTHING).
 */

import { execFileSync } from 'child_process'
import { query } from './index'
import { stripTags, decodeEntities } from './ingestStateLawCorpus'

const STATE = 'SD'
const SOURCE_DATE = '2026-06-14'
const EFFECTIVE_YEAR = 2026
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) GAM-statute-ingest/1.0'
const API = 'https://sdlegislature.gov/api/Statutes/Statute'
const publicUrl = (section: string) =>
  `https://sdlegislature.gov/Statutes/${section}`

// category key -> ordered chapter roots to walk
const CATEGORIES: Record<string, string[]> = {
  conveyancing_title: ['43-25', '43-26', '43-28', '43-29', '43-30', '43-30A'],
  condo_coop: ['43-15A', '43-15B'],
  broker_licensing: ['36-21A', '36-21B'],
  mortgage_lien_foreclosure: ['44-8', '44-9', '21-47', '21-48', '21-49'],
  general_real_property: [
    '43-1', '43-2', '43-2A', '43-3', '43-4', '43-5', '43-6', '43-7', '43-8',
    '43-9', '43-11', '43-12', '43-13', '43-13A', '43-14', '43-16', '43-17',
    '43-23', '43-27', '43-31', '43-32', '43-33', '15-3',
  ],
}

interface StatuteJson {
  Statute?: string
  Type?: string
  CatchLine?: string | null
  Source?: string | null
  Html?: string | null
  Next?: string | null
  Repealed?: boolean
}
interface Parsed {
  number: string
  title: string | null
  text: string
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Fetch one statute JSON with a small retry (the API rate-limits bursts). */
function fetchStatuteOnce(id: string): StatuteJson | null {
  const buf = execFileSync('curl', ['-sL', '--max-time', '45', '-A', UA, `${API}/${id}`], {
    maxBuffer: 256 * 1024 * 1024,
  })
  const raw = buf.toString('utf-8').trim()
  if (!raw || raw[0] !== '{') return null
  try {
    return JSON.parse(raw) as StatuteJson
  } catch {
    return null
  }
}

async function fetchStatute(id: string): Promise<StatuteJson | null> {
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt > 0) await sleep(800 * attempt)
    try {
      const d = fetchStatuteOnce(id)
      if (d) return d
    } catch {
      /* retry */
    }
  }
  return null
}

/** Chapter prefix for a section id: "43-25-18.1" -> "43-25", "43-15A-3" -> "43-15A". */
function chapterPrefix(section: string): string {
  return section.replace(/-[^-]+$/, '')
}

/**
 * True when the text marks a non-substantive (repealed/transferred/reserved/…)
 * section. SD uses two shapes:
 *   "Repealed by SL 1980, ch 294, § 20."                 (leading keyword)
 *   "21-49-1 to 21-49-10. Repealed by SL 1977, ch 187…"  (range marker — the
 *      dead keyword follows a citation range, so check ANYWHERE, not just start)
 * The "by"/"to" qualifier keeps this from false-positiving on a substantive
 * section whose prose merely mentions "repealed" (e.g. "...a repealed statute").
 */
function isDeadCatchline(text: string): boolean {
  const t = text.trim()
  if (/^(repealed|transferred|reserved|omitted|renumbered|deleted)\b/i.test(t)) return true
  if (/\b(repealed\s+by|transferred\s+to|renumbered\s+(?:as|to)|omitted)\b/i.test(t)) return true
  return false
}

/**
 * Parse a section JSON into {number, title, text}. The body is taken from the
 * Html field: drop the <style> head, drop the SENU number span and the CL
 * catchline span (they duplicate Statute/CatchLine), then stripTags the rest.
 * The Source: line inside Html is retained verbatim. Returns null for dead /
 * empty / too-short sections.
 */
function parseSection(d: StatuteJson): Parsed | null {
  const number = (d.Statute || '').trim()
  if (!number) return null

  // Catchline -> title. SD's CatchLine sometimes prefixes the section number
  // (e.g. "43-15A-27. Repealed by …"); strip a leading "NN-…-NN." citation.
  let cl = decodeEntities(d.CatchLine || '').replace(/ /g, ' ').trim()
  cl = cl.replace(/^[0-9]+-[0-9A-Za-z]+-[0-9.]+\.\s*/, '').trim()
  if (cl && isDeadCatchline(cl)) return null
  const title = cl || null

  let html = d.Html || ''
  if (!html.trim()) return null

  // Restrict to the rendered body; drop the style head if present.
  const bodyStart = html.indexOf('</style>')
  if (bodyStart !== -1) html = html.slice(bodyStart + '</style>'.length)

  // Remove the SENU section-number span(s) and the catchline span(s) (plus the
  // anchor that wraps the number) so they don't double up in full_text. SD class
  // names are per-section ids: the id is either all-digits ("s2065376…") OR a
  // hex blob ("s3f01ae27…"), so the id pattern is [0-9a-f]+. Span roles:
  //   "s<id>SENU"      section number   -> removed
  //   "s<id>CL"        catchline        -> removed (may be split across several
  //                    "…CL" / "…CL-000000" spans on a single section)
  //   "s<id>SCL"       Source line      -> KEPT (verbatim history note)
  // The catchline match uses (?<!S)CL so it never eats the Source span "SCL"
  // (whose class is "…SCL"); a catchline id always ends in a hex digit, never S.
  html = html
    .replace(/<a\b[^>]*>\s*<span[^>]*class="s[0-9a-f]+SENU"[^>]*>[\s\S]*?<\/span>\s*<\/a>/gi, ' ')
    .replace(/<span[^>]*class="s[0-9a-f]+SENU"[^>]*>[\s\S]*?<\/span>/gi, ' ')
    .replace(/<span[^>]*class="s[0-9a-f]+(?<!S)CL(?:-\d+)?"[^>]*>[\s\S]*?<\/span>/gi, ' ')

  const text = stripTags(html, true)
    .replace(/ /g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

  if (!text || text.length < 20) return null
  // Body-level dead check is intentionally CONSERVATIVE (start-anchored only):
  // a substantive section may legitimately contain "transferred to" / "repealed
  // by" in its prose (e.g. 43-4-2 "Property … may be transferred to a person";
  // 43-25-29 "… estate is transferred to the soil of the highway"). The reliable
  // discriminator for dead range-markers is the catchline gate above; here we
  // only catch a body that BEGINS with the dead keyword.
  if (/^(repealed|transferred|reserved|omitted|renumbered|deleted)\b/i.test(text)) return null
  return { number, title, text }
}

/**
 * Walk a chapter from its root via the `Next` chain, yielding parsed sections.
 * Stops when `Next` leaves the chapter (non-Section type, or different prefix)
 * or after a hard cap to avoid runaway chains.
 */
async function walkChapter(chapterRoot: string): Promise<Parsed[]> {
  const out: Parsed[] = []
  const root = await fetchStatute(chapterRoot)
  if (!root) {
    console.warn(`  ! chapter ${chapterRoot}: root fetch failed`)
    return out
  }
  let next = root.Next || null
  let count = 0
  let kept = 0
  let dropped = 0
  const seen = new Set<string>() // guard against any cyclic Next chain
  while (next && count < 2000) {
    if (seen.has(next)) break
    seen.add(next)
    count++
    const d = await fetchStatute(next)
    await sleep(120) // politeness
    if (!d) {
      console.warn(`  ! ${chapterRoot}: fetch failed at ${next}, stopping chain`)
      break
    }
    const stat = (d.Statute || '').trim()

    // Non-section nodes inside the chapter (e.g. the State Bar Title Standards
    // APPENDIX hung off 43-30, Type="Appendix") are NOT codified statute text.
    // Skip them but keep walking — the appendix's `Next` points at the first
    // real section, so we must not break here or we'd miss the whole chapter.
    if (d.Type !== 'Section') {
      if (chapterPrefix(stat) === chapterRoot) {
        dropped++
        next = d.Next || null
        continue
      }
      break // ran off the end into the next chapter
    }
    // Section in a different chapter -> we've left this chapter.
    if (chapterPrefix(stat) !== chapterRoot) break

    const parsed = parseSection(d)
    if (parsed) {
      out.push(parsed)
      kept++
    } else {
      dropped++
    }
    next = d.Next || null
  }
  console.log(`  [${chapterRoot}] kept ${kept}, dropped ${dropped} (walked ${count})`)
  return out
}

async function ingestCategory(category: string, chapters: string[]): Promise<number> {
  console.log(`\n--- ${category} (${chapters.length} chapters) ---`)
  let inserted = 0
  for (const ch of chapters) {
    const sections = await walkChapter(ch)
    for (const s of sections) {
      const rows = await query<{ id: string }>(
        `INSERT INTO state_law_section_texts
           (state_code, act_key, section_number, section_title, full_text,
            source_url, source_date, effective_year, law_category)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (state_code, act_key, section_number, effective_year) DO NOTHING
         RETURNING id`,
        [
          STATE,
          category,
          s.number,
          s.title,
          s.text,
          publicUrl(s.number),
          SOURCE_DATE,
          EFFECTIVE_YEAR,
          category,
        ]
      )
      inserted += rows.length
    }
  }
  console.log(`  => ${category}: inserted ${inserted}`)
  return inserted
}

async function main() {
  console.log(`\n=== SD — ingesting real-estate statute corpus (as of ${SOURCE_DATE}) ===`)
  const counts: Record<string, number> = {}
  for (const [category, chapters] of Object.entries(CATEGORIES)) {
    counts[category] = await ingestCategory(category, chapters)
  }
  const total = Object.values(counts).reduce((a, b) => a + b, 0)
  console.log(`\nSD done. inserted=${total}`, counts)
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
