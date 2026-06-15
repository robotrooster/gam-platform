/**
 * South Carolina non-tax real-estate statute full-text ingester (SC corpus).
 *
 * Sanctioned retrieve+cite+date carve-out: VERBATIM statute text from the
 * OFFICIAL SC Legislature site only (scstatehouse.gov). Never advice.
 *
 * SOURCE SHAPE — much simpler than LA. The official SC Code lives at
 *   https://www.scstatehouse.gov/code/t<TT>c<CCC>.php
 * where TT = title number, CCC = zero-padded 3-digit chapter (e.g. t27c007.php
 * = Title 27, Chapter 7). Each chapter page is ONE static HTML doc (HTTP/2 200,
 * Cloudflare, no JS) containing EVERY section of that chapter inline. Raw curl
 * with a browser UA gets the whole thing.
 *
 * Section markup (the load-bearing delimiter):
 *   <span style="font-weight: bold;"> SECTION 27-7-10.</span> Catchline.<br /><br />
 *   \tBody paragraph one.<br /><br />
 *   \tBody paragraph two ...<br /><br />
 *   HISTORY: 1962 Code SECTION ...; ... <br /><br />
 *   <span style="font-weight: bold;"> SECTION 27-7-20.</span> ...
 *
 * So sections are delimited by the BOLD-span "SECTION TT-CC-NN." anchor — NOT by
 * the literal text "SECTION TT-CC-NN." which also appears inside HISTORY notes
 * ("1962 Code SECTION 57-251") and cross-references. Splitting on the bold span
 * is what keeps the count honest (e.g. Ch 40-57 has 47 real sections though the
 * naive literal-text grep counts 57).
 *
 * For each section chunk:
 *   - title (catchline) = text from the span end up to the first <br>
 *   - full_text = the rest, tag-stripped, with the duplicate leading catchline
 *     line removed; the trailing "HISTORY:" codification note is KEPT as the
 *     source-note trailer (the carve-out allows the official history line).
 *   - DROP repealed / reserved (catchline or body) / empty / <20-char bodies.
 *   The static page header (Title/Chapter centered divs) sits BEFORE the first
 *   bold-span anchor, and the site footer (Legislative Services Agency, links)
 *   sits AFTER the last HISTORY note but is naturally excluded because the last
 *   chunk's body is trimmed at... actually the footer falls in the last chunk,
 *   so we additionally cut each chunk at the closing structural markers and the
 *   footer sentinel. See sliceFooter().
 *
 * CATEGORY → CHAPTER MAP (law_category == act_key per category, per spec).
 * Each category aggregates its primary chapter + companions; sections are
 * globally unique by (state, act_key, section_number) because SC section
 * numbers embed their title-chapter (27-7-10 vs 27-11-10), so no collisions.
 *
 *   conveyancing_title        Title 27 Ch 7 (Form/Execution of Conveyances)
 *                             + Ch 11 (Confirmation of Titles) + Ch 23 (Void Gifts/Conveyances)
 *   condo_coop                Title 27 Ch 31 (Horizontal Property Act / condos)
 *                             + Ch 30 (HOA Act) + Ch 32 (Vacation Time Sharing)
 *                             [SC has NOT adopted UCIOA; no single CIOC statute]
 *   broker_licensing          Title 40 Ch 57 (Real Estate Brokers/PMs)
 *   mortgage_lien_foreclosure Title 29 Ch 3 (Mortgages & Deeds of Trust / foreclosure)
 *                             + Ch 5 (Mechanics' Liens) + Ch 7 (Laborers' Liens)
 *                             + Ch 15 (Statutory Liens)
 *   general_real_property     Title 27 Ch 5 (Estates & Construction of Documents)
 *                             + Ch 1 (General Provisions) + Ch 6 (USRAP)
 *                             + Ch 27 (Betterments) + Title 15 Ch 67 (Adverse Possession)
 *
 * Run: cd apps/api && node -r ts-node/register src/db/ingestSCRealEstate.ts
 * Idempotent (ON CONFLICT DO NOTHING). Re-runnable.
 */

import { execFileSync } from 'child_process'
import { query } from './index'
import { stripTags } from './ingestStateLawCorpus'

const STATE = 'SC'
const SOURCE_DATE = '2026-06-14'
const EFFECTIVE_YEAR = 2026
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) GAM-statute-ingest/1.0'
const BASE = 'https://www.scstatehouse.gov/code'

// chapterUrl(27, 7) -> https://www.scstatehouse.gov/code/t27c007.php
const chapterUrl = (title: number, chapter: number) =>
  `${BASE}/t${title}c${String(chapter).padStart(3, '0')}.php`

interface ChapterRef {
  title: number
  chapter: number
}

// law_category === act_key for every block (per spec).
const CATEGORIES: { category: string; chapters: ChapterRef[] }[] = [
  {
    category: 'conveyancing_title',
    chapters: [
      { title: 27, chapter: 7 }, // Form and Execution of Conveyances
      { title: 27, chapter: 11 }, // Confirmation of Titles
      { title: 27, chapter: 23 }, // Parol, Fraudulent, and Other Void Gifts or Conveyances
    ],
  },
  {
    category: 'condo_coop',
    chapters: [
      { title: 27, chapter: 31 }, // Horizontal Property Act (condominium)
      { title: 27, chapter: 30 }, // Homeowners Associations
      { title: 27, chapter: 32 }, // Vacation Time Sharing Plans
    ],
  },
  {
    category: 'broker_licensing',
    chapters: [
      { title: 40, chapter: 57 }, // Real Estate Brokers, BICs, Associates, Property Managers
    ],
  },
  {
    category: 'mortgage_lien_foreclosure',
    chapters: [
      { title: 29, chapter: 3 }, // Mortgages and Deeds of Trust Generally (incl. foreclosure)
      { title: 29, chapter: 5 }, // Mechanics' Liens
      { title: 29, chapter: 7 }, // Laborers' Liens
      { title: 29, chapter: 15 }, // Statutory Liens
    ],
  },
  {
    category: 'general_real_property',
    chapters: [
      { title: 27, chapter: 5 }, // Estates and Construction of Documents Creating Estates
      { title: 27, chapter: 1 }, // General Provisions
      { title: 27, chapter: 6 }, // Uniform Statutory Rule Against Perpetuities
      { title: 27, chapter: 27 }, // Betterments
      { title: 15, chapter: 67 }, // Adverse Possession (Title 15, Civil Remedies)
    ],
  },
]

interface Parsed {
  number: string
  title: string | null
  text: string
}

function curl(url: string): string {
  const buf = execFileSync('curl', ['-sL', '--max-time', '60', '-A', UA, url], {
    maxBuffer: 256 * 1024 * 1024,
  })
  return buf.toString('utf-8')
}

/**
 * Cut a section chunk before the page footer if it leaked in (only the LAST
 * section of a chapter is at risk — the footer follows its HISTORY note). The
 * footer is the printfooter div / "Legislative Services Agency" sentinel sitting
 * outside any bold-SECTION anchor.
 */
function sliceFooter(chunk: string): string {
  const sentinels = [
    /<div id="printfooter"/i,
    /Legislative Services Agency\s*\*/i,
    /<a href="\/disclaimer\.php"/i,
    /<\/body>/i,
  ]
  let cut = chunk.length
  for (const re of sentinels) {
    const m = chunk.match(re)
    if (m && m.index !== undefined && m.index < cut) cut = m.index
  }
  return chunk.slice(0, cut)
}

/**
 * Parse all sections of one chapter page. Delimiter = the bold-span
 * "SECTION TT-CC-NN." anchor. Returns kept sections only.
 */
function parseChapter(html: string, title: number, chapter: number): Parsed[] {
  const prefix = `${title}-${chapter}`
  // Bold-span anchor. Tolerate "font-weight: bold;" / "font-weight:bold;" and
  // alphanumeric section suffixes (none known in scope, but cheap to allow).
  const anchor = new RegExp(
    `<span\\s+style="font-weight:\\s*bold;">\\s*SECTION\\s+(${prefix.replace(
      /-/g,
      '\\-'
    )}-[0-9A-Za-z]+)\\.\\s*</span>`,
    'gi'
  )
  const matches: { num: string; start: number; end: number }[] = []
  let m: RegExpExecArray | null
  while ((m = anchor.exec(html)) !== null) {
    matches.push({ num: m[1], start: m.index, end: anchor.lastIndex })
  }

  const out: Parsed[] = []
  for (let i = 0; i < matches.length; i++) {
    const cur = matches[i]
    const next = matches[i + 1]
    const bodyStart = cur.end
    const bodyEnd = next ? next.start : html.length
    let chunk = html.slice(bodyStart, bodyEnd)
    chunk = sliceFooter(chunk)

    // Title (catchline) = HTML up to the first <br>, tag-stripped.
    const titleHtmlMatch = chunk.split(/<br\s*\/?>/i)
    const titleHtml = titleHtmlMatch.length ? titleHtmlMatch[0] : ''
    let secTitle: string | null = stripTags(titleHtml, false).replace(/\.\s*$/, '').trim()
    if (!secTitle) secTitle = null

    // Body = full chunk tag-stripped, with the leading catchline line removed.
    const full = stripTags(chunk, true)
    let body = full
    if (secTitle) {
      const lines = full.split('\n')
      // first non-empty line equals the catchline -> drop it
      if (
        lines.length &&
        lines[0].trim().replace(/\.\s*$/, '').trim().toLowerCase() === secTitle.toLowerCase()
      ) {
        body = lines.slice(1).join('\n').trim()
      }
    }
    body = body.trim()

    // DROP rules: repealed / reserved (by catchline or body) / empty / <20 chars.
    const tLow = (secTitle || '').toLowerCase()
    const firstBodyLine = (body.split('\n')[0] || '').trim().toLowerCase()
    if (/^reserved\b/.test(tLow) || /^repealed\b/.test(tLow)) continue
    if (/^reserved\.?$/.test(firstBodyLine) || /^repealed\.?$/.test(firstBodyLine)) continue
    if (!body || body.length < 20) continue

    out.push({ number: cur.num, title: secTitle, text: body })
  }
  return out
}

async function ingestCategory(
  category: string,
  chapters: ChapterRef[]
): Promise<number> {
  let ok = 0
  let dropped = 0
  for (const ref of chapters) {
    const url = chapterUrl(ref.title, ref.chapter)
    let html: string
    try {
      html = curl(url)
    } catch (e: any) {
      console.warn(`  ! fetch failed ${url}: ${e?.message || e}`)
      continue
    }
    const parsed = parseChapter(html, ref.title, ref.chapter)
    for (const p of parsed) {
      await query(
        `INSERT INTO state_law_section_texts
           (state_code, act_key, section_number, section_title, full_text,
            source_url, source_date, effective_year, law_category)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (state_code, act_key, section_number, effective_year) DO NOTHING`,
        [STATE, category, p.number, p.title, p.text, url, SOURCE_DATE, EFFECTIVE_YEAR, category]
      )
      ok++
    }
    console.log(
      `  [${category}] t${ref.title}c${String(ref.chapter).padStart(3, '0')}: ${parsed.length} kept`
    )
  }
  console.log(`  [${category}] total kept/inserted attempts: ${ok}`)
  return ok
}

async function main() {
  console.log(`\n=== SC — ingesting non-tax real-estate corpus (as of ${SOURCE_DATE}) ===`)
  const counts: Record<string, number> = {}
  for (const { category, chapters } of CATEGORIES) {
    counts[category] = await ingestCategory(category, chapters)
  }
  const total = Object.values(counts).reduce((a, b) => a + b, 0)
  console.log(`\nSC done. insert-attempts=${total}`, counts)
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
