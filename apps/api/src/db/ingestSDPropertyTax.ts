/**
 * South Dakota property-tax statute full-text ingester (sanctioned
 * retrieve+cite+date carve-out — verbatim codified law, never advice).
 *
 * SOURCE: South Dakota Legislature official site, sdlegislature.gov.
 * The human-facing /Statutes/{chapter} routes are a Vue SPA that serves only
 * a "browser not supported" shell to non-JS clients (a TOC/index, never the
 * prose). The site is, however, backed by a clean static HTML API that needs
 * no JS and no auth — that is what we ingest:
 *
 *   (1) Chapter table-of-contents:
 *       GET https://sdlegislature.gov/api/Statutes/{chapter}.html
 *       e.g. /api/Statutes/10-13.html  → the chapter's section list. Each
 *       section is an anchor href=".../Statutes?Statute={section}" plus an
 *       inline catchline. Repealed ranges appear inline ("10-13-1 to 10-13-10.
 *       Repealed by ...") and their own section pages return an EMPTY body.
 *
 *   (2) Single-section verbatim text (the actual statutory prose — this is
 *       what we drill to, NOT the TOC):
 *       GET https://sdlegislature.gov/api/Statutes/{section}.html
 *       e.g. /api/Statutes/10-13-39.html. Layout:
 *         <span class="...SENU">10-13-39</span>   the section number
 *         <span class="...CL">{catchline title}.</span>
 *         <p>...verbatim body paragraphs, sub-markers (1)(2) inline...</p>
 *         <span class="...SCL">Source:</span><span>  SL 1995, ch 57 ...</span>
 *       The trailing Source: history note is kept as the source-note trailer
 *       (same posture as the LA ingester).
 *
 * RECIPE: for each property-tax chapter, GET the chapter .html, harvest the
 * distinct {section} numbers from the Statute= hrefs, then GET each
 * /api/Statutes/{section}.html and parse number+title+verbatim body. Drop
 * repealed/empty(<20 char)/reserved. Stamp retrieval date + source URL.
 *
 * All rows land under act_key='property_tax', law_category='property_tax'.
 * Plain raw_http GETs against /api/ succeed (no headless browser needed).
 * Skip the repealed Ch. 10-19 (Lien of Property Tax, repealed 1992).
 *
 * Run: cd apps/api && node -r ts-node/register src/db/ingestSDPropertyTax.ts
 * Idempotent (ON CONFLICT DO NOTHING).
 */

import { execFileSync } from 'child_process'
import { query } from './index'
import { stripTags } from './ingestStateLawCorpus'

const STATE = 'SD'
const ACT_KEY = 'property_tax'
const LAW_CATEGORY = 'property_tax'
const SOURCE_DATE = '2026-06-14'
const EFFECTIVE_YEAR = 2026
const UA = 'GAM-statute-ingest/1.0 (compliance research)'
const API = 'https://sdlegislature.gov/api/Statutes'
const sectionUrl = (sec: string) => `https://sdlegislature.gov/Statutes/${sec}`

// Five feature-chapter groups → the SDCL Title 10 chapters that back them.
// Every row is act_key='property_tax'; the grouping is for the run report only.
const FEATURE_GROUPS: { feature: string; chapters: string[] }[] = [
  { feature: 'exemptions',            chapters: ['10-4', '10-6A', '10-6B', '10-6C', '10-13'] },
  { feature: 'assessment',            chapters: ['10-6', '10-10', '10-3', '10-17'] },
  { feature: 'assessment_review',     chapters: ['10-11'] },
  { feature: 'levy_collection_payment', chapters: ['10-12', '10-21'] },
  { feature: 'delinquency_tax_sale',  chapters: ['10-22', '10-23', '10-24', '10-25', '10-18'] },
]

interface Parsed { number: string; title: string | null; text: string }

function curlOnce(url: string): string {
  const buf = execFileSync('curl', ['-sL', '--max-time', '60', '-A', UA, url], {
    maxBuffer: 256 * 1024 * 1024,
  })
  return buf.toString('utf-8')
}

/**
 * The API rate-limits bursts with a tiny HTML body ("Too many requests.
 * Please try again after N second(s)."). Detect it and retry with backoff so
 * the throttle response never gets stored as if it were statute text.
 */
function isRateLimited(html: string): boolean {
  return /Too many requests\.\s*Please try again/i.test(html) && html.length < 400
}

function sleepBlocking(ms: number): void {
  execFileSync('sleep', [String(ms / 1000)])
}

function curl(url: string): string {
  let html = curlOnce(url)
  for (let attempt = 0; attempt < 5 && isRateLimited(html); attempt++) {
    sleepBlocking(2000 * (attempt + 1)) // 2s, 4s, 6s, 8s, 10s
    html = curlOnce(url)
  }
  if (isRateLimited(html)) throw new Error('rate-limited after retries')
  return html
}

/**
 * Harvest the distinct section numbers for a chapter from its TOC HTML.
 * Sections appear as href="...?Statute={chapter}-{n}" (n may be dotted,
 * e.g. 10-13-35.1). De-dupe, keep document order, sort naturally.
 */
function harvestChapterSections(html: string, chapter: string): string[] {
  const re = new RegExp(`Statute=(${chapter}-[0-9]+(?:\\.[0-9]+)?)\\b`, 'g')
  const seen = new Set<string>()
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) seen.add(m[1])
  const out = [...seen]
  out.sort((a, b) => {
    const pa = a.split('-').slice(2).join('-')
    const pb = b.split('-').slice(2).join('-')
    const na = parseFloat(pa)
    const nb = parseFloat(pb)
    return na - nb || a.localeCompare(b)
  })
  return out
}

/**
 * Parse a single-section page. The first SENU span is the number; the first
 * CL-class span whose suffix is exactly "CL" (NOT "SCL", which is the Source:
 * label) is the catchline title. Body = the whole stripped body text with the
 * leading "{number}. {title}" removed, preserving the verbatim prose and the
 * trailing Source: note. Returns null for empty/repealed/reserved sections.
 */
function parseSection(html: string, expectedNumber: string): Parsed | null {
  // Number — first SENU span.
  const senu = html.match(/class="[^"]*SENU"[^>]*>([^<]*)<\/span>/i)
  const number = (senu ? stripTags(senu[1], false) : expectedNumber).trim() || expectedNumber

  // Title — first span whose class ENDS in "CL" but is not "SCL" (Source label)
  // and is not the chapter-header "HG" classes. Skip a literal "Source:".
  let title: string | null = null
  const clRe = /class="([^"]*?)"[^>]*>([^<]*)<\/span>/gi
  let cm: RegExpExecArray | null
  while ((cm = clRe.exec(html)) !== null) {
    const cls = cm[1]
    if (!/(?:^|[^S])CL$/.test(cls)) continue // ends in CL, not SCL
    const t = stripTags(cm[2], false).trim()
    if (!t || /^source:?$/i.test(t)) continue
    title = t.replace(/\.$/, '').trim() || null
    break
  }
  // Placeholder sections carry no statutory prose — their catchline title is
  // the disposition itself ("Repealed.", "Reserved.", "Transferred to § ...",
  // "Omitted."). Drop on the title; the body is just a back-reference + Source.
  if (title && /^(repealed|reserved|transferred|omitted)\b/i.test(title)) return null

  // Body — strip the whole body, then peel off the leading "number . title"
  // header so full_text begins with the statutory prose.
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i)
  let text = stripTags(bodyMatch ? bodyMatch[1] : html, false)
  // Remove leading "<number> ." (with possible nbsp) then the title sentence.
  const numEsc = number.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  text = text.replace(new RegExp(`^\\s*${numEsc}\\s*\\.?\\s*`), '')
  if (title) {
    const titleEsc = title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    text = text.replace(new RegExp(`^\\s*${titleEsc}\\.?\\s*`), '')
  }
  text = text.trim()

  if (!text || text.length < 20) return null
  // "Reserved" / "Reserved . Source: ..." placeholder sections carry no prose
  // (the disposition word may be followed by spaces/period/bracket before the
  // Source note or end-of-text).
  if (/^\[?\s*reserved\b[\s.\]]*?(source:|$)/i.test(text)) return null
  if (/^repealed\b/i.test(text)) return null
  // Sections enacted but voided at the ballot ("Rejected by referendum.")
  // never took effect — no operative statutory prose.
  if (/^rejected by referendum\b/i.test(text)) return null
  // Repealed/transferred RANGE stubs have no title and a body like
  // "to 10-13-10. Repealed by SL 1992, ch 84, § 11." or
  // "Transferred to § ...". Drop them — they carry no statutory prose.
  if (!title && /\b(repealed|transferred|omitted)\b/i.test(text)) return null
  if (!title && /^to\s+\d+-\d+/i.test(text)) return null
  return { number, title, text }
}

async function ingestChapter(chapter: string): Promise<{ ok: number; skipped: number; secs: number }> {
  let toc: string
  try {
    toc = curl(`${API}/${chapter}.html`)
  } catch (e: any) {
    console.warn(`  ! chapter ${chapter} TOC fetch failed: ${e?.message || e}`)
    return { ok: 0, skipped: 0, secs: 0 }
  }
  const sections = harvestChapterSections(toc, chapter)
  let ok = 0
  let skipped = 0
  const CONC = 4
  for (let i = 0; i < sections.length; i += CONC) {
    if (i > 0) await new Promise((r) => setTimeout(r, 250)) // politeness
    const batch = sections.slice(i, i + CONC)
    const parsed = await Promise.all(
      batch.map(async (sec) => {
        try {
          return { p: parseSection(curl(`${API}/${sec}.html`), sec), sec }
        } catch (e: any) {
          console.warn(`  ! ${sec}: ${e?.message || e}`)
          return { p: null, sec }
        }
      })
    )
    for (const { p, sec } of parsed) {
      if (!p || !p.text || p.text.length < 20) {
        skipped++
        continue
      }
      await query(
        `INSERT INTO state_law_section_texts
           (state_code, act_key, section_number, section_title, full_text, source_url, source_date, effective_year, law_category)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (state_code, act_key, section_number, effective_year) DO NOTHING`,
        [STATE, ACT_KEY, p.number, p.title, p.text, sectionUrl(sec), SOURCE_DATE, EFFECTIVE_YEAR, LAW_CATEGORY]
      )
      ok++
    }
    process.stdout.write(`\r  [${chapter}] ${Math.min(i + CONC, sections.length)}/${sections.length}`)
  }
  console.log(`\n  [${chapter}] inserted ${ok}, skipped ${skipped} of ${sections.length} sections`)
  return { ok, skipped, secs: sections.length }
}

async function main() {
  console.log(`\n=== SD — ingesting property-tax full-text corpus (as of ${SOURCE_DATE}) ===`)
  const featureTotals: Record<string, number> = {}
  let grand = 0
  for (const { feature, chapters } of FEATURE_GROUPS) {
    console.log(`\n--- feature: ${feature}  (chapters ${chapters.join(', ')}) ---`)
    let fOk = 0
    for (const ch of chapters) {
      const { ok } = await ingestChapter(ch)
      fOk += ok
    }
    featureTotals[feature] = fOk
    grand += fOk
  }
  console.log(`\nSD property_tax done. inserted=${grand}`, featureTotals)
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
