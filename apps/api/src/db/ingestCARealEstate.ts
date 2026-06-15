/**
 * California NON-TAX real-estate statute full-text ingester (CA legal corpus —
 * the sanctioned retrieve+cite+date carve-out: verbatim statutory text, never
 * advice). Companion to ingestCAPropertyTax.ts (property_tax category lives
 * there; this file covers the five non-tax real-estate categories).
 *
 * SOURCE (official only — leginfo.legislature.ca.gov, no Justia/Lexis/Wayback):
 *   California Codes (CIV / BPC / CCP). Plain curl with a browser User-Agent
 *   returns full HTML; no JS/cookies needed for the displayText leaf pages.
 *
 * STRATEGY — fetch whole CHAPTERS at once, not section-by-section.
 *   codes_displayText.xhtml?lawCode=<C>&division=<D>&title=<T>&part=<P>
 *     &chapter=<CH>&article=
 *   With chapter set (article left blank) the page renders EVERY section in that
 *   chapter inline — including sections nested in the chapter's articles — as a
 *   run of submitCodesValues anchors. (A partial path that stops above chapter
 *   level returns only the ~128KB empty JSF shell, because the TOC tree is
 *   lazy-rendered in the browser. So we iterate explicit chapter numbers per
 *   root and skip the empties; chapter numbering has gaps, e.g. BPC Part 1 has
 *   ch.1,2,3,6,7 — so we scan a fixed chapter window, not stop-at-first-empty.)
 *
 * Each section begins at a submitCodesValues anchor and runs to the next
 * section's <h6> row (so the trailing enactment parenthetical — "(Amended by
 * Stats. 2023, Ch. ...)" — stays with the section it belongs to: that IS the
 * verbatim citation+date stamp the carve-out preserves). The last section in a
 * chapter ends at the first </body> after it (past the statute run, before the
 * JSF nav chrome). Tags stripped, entities decoded, whitespace normalized.
 * Repealed / reserved / empty (<20 char) sections dropped.
 *
 * CATEGORY -> ROOT MAP (act_key == law_category for every block, per spec).
 * Roots are DISJOINT by Code/Title/Part path so no section is ingested twice
 * across categories (general_real_property deliberately excludes the
 * recording/transfer, CID, and mortgage blocks that also sit in the Civil Code):
 *
 *   conveyancing_title       CIV Div2 Part4 Title4 (Transfer) — incl. Ch2
 *                            Transfer of Real Property (1091 et seq.) + Ch4
 *                            Recording Transfers (1213 et seq.).
 *   condo_coop               CIV Div4 Part5 (Davis-Stirling CID Act, 4000 et
 *                            seq.) + Part5.3 (Commercial & Industrial CID Act,
 *                            6500 et seq.); stock-coop defs woven in.
 *   broker_licensing         BPC Div4 Part1 (Real Estate Law, 10000 et seq.;
 *                            brokers/salespersons Ch3) + Part3 (Real Estate
 *                            Appraisers' Licensing & Certification, 11300+).
 *   mortgage_lien_foreclosure CIV Div3 Title14 Part4 Ch2 (Mortgage of Real
 *                            Property, 2920-2944.x incl. nonjudicial-sale
 *                            2924-series) + CIV Div4 Part6 Title2 Ch4 (Mechanics
 *                            Lien, 8400 et seq.) + CCP Part2 Title10 Ch1
 *                            (Judicial Foreclosure of Mortgages, 725a-730.5) +
 *                            CCP Part2 Title8 Ch1 §§580a-580d (deficiency).
 *   general_real_property    CIV Div2 Part1 Title2 (Estates in Real Property,
 *                            761-815) + Part1 ownership/co-tenancy block
 *                            (678-703, Title1) + Part4 Title2/Title3 acquisition
 *                            by occupancy/accession (1000-1014) + CCP Part2
 *                            Title2 Ch2 §§318-328 (adverse-possession SOL).
 *
 * Run: cd apps/api && node -r ts-node/register src/db/ingestCARealEstate.ts
 * Idempotent (ON CONFLICT DO NOTHING).
 */

import { execFileSync } from 'child_process'
import { query } from './index'
import { stripTags } from './ingestStateLawCorpus'

const STATE = 'CA'
const SOURCE_DATE = '2026-06-14'
const EFFECTIVE_YEAR = 2026
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) GAM-statute-ingest/1.0'
const BASE = 'https://leginfo.legislature.ca.gov/faces'

/** Per-section permalink (the canonical citable URL on the official site). */
const sectionUrl = (lawCode: string, num: string) =>
  `${BASE}/codes_displaySection.xhtml?lawCode=${lawCode}&sectionNum=${num}.`

/** Whole-chapter display page (renders every section in the chapter inline). */
const chapterUrl = (lawCode: string, division: string, title: string, part: string, chapter: string) =>
  `${BASE}/codes_displayText.xhtml?lawCode=${lawCode}&division=${division}&title=${title}&part=${part}&chapter=${chapter}&article=`

interface Section {
  number: string
  title: string | null
  text: string
}

/**
 * A leaf root to harvest. We iterate chapters 1..maxChapter (with decimal
 * variants where present) and pull each chapter's sections. `minSec`/`maxSec`
 * optionally clamp to a section-number range (used where a chapter is broader
 * than the spec's target range, e.g. CCP §§318-328 inside §315-330).
 */
interface Root {
  lawCode: string
  division: string
  title: string
  part: string
  /** Chapter numbers to fetch (as they appear in URLs, trailing dot added). */
  chapters: string[]
  minSec?: number
  maxSec?: number
}

interface CategorySpec {
  category: string
  roots: Root[]
}

// ---------------------------------------------------------------------------
// Category -> roots. Chapter lists were verified live against leginfo (each
// listed chapter returned >0 sections; empties/gaps omitted).
// ---------------------------------------------------------------------------
const CATEGORIES: CategorySpec[] = [
  {
    category: 'conveyancing_title',
    roots: [
      // CIV Div2 Part4 Title4 "Transfer": ch1 (transfer in general 1039-1059),
      // ch2 (transfer of real property 1091-1134), ch3 (recordation of powers
      // of attorney), ch4 (recording transfers 1169-1217), ch5 (interpretation
      // of grants 1066-1070 — small).
      { lawCode: 'CIV', division: '2.', title: '4.', part: '4.', chapters: ['1.', '2.', '3.', '4.', '5.'] },
    ],
  },
  {
    category: 'condo_coop',
    roots: [
      // Davis-Stirling CID Act — CIV Div4 Part5, chapters 1-11.
      { lawCode: 'CIV', division: '4.', title: '', part: '5.', chapters: ['1.', '2.', '3.', '4.', '5.', '6.', '7.', '8.', '9.', '10.', '11.'] },
      // Commercial & Industrial CID Act — CIV Div4 Part5.3, chapters 1-10.
      { lawCode: 'CIV', division: '4.', title: '', part: '5.3.', chapters: ['1.', '2.', '3.', '4.', '5.', '6.', '7.', '8.', '9.', '10.'] },
    ],
  },
  {
    category: 'broker_licensing',
    roots: [
      // Real Estate Law — BPC Div4 Part1: ch1 (Commissioner/Dept + subdivided
      // lands art), ch2 (records/funds), ch3 (Real Estate Brokers &
      // Salespersons — 10130-10242, the licensing core), ch6, ch7.
      { lawCode: 'BPC', division: '4.', title: '', part: '1.', chapters: ['1.', '2.', '3.', '6.', '7.'] },
      // Real Estate Appraisers' Licensing & Certification Law — BPC Div4 Part3.
      { lawCode: 'BPC', division: '4.', title: '', part: '3.', chapters: ['1.', '2.', '3.', '4.', '5.', '6.', '7.', '8.'] },
    ],
  },
  {
    category: 'mortgage_lien_foreclosure',
    roots: [
      // Mortgage of Real Property — CIV Div3 Title14 Part4 Ch2 (2920-2944.x,
      // incl. the dense 2924-series nonjudicial trustee-sale provisions).
      { lawCode: 'CIV', division: '3.', title: '14.', part: '4.', chapters: ['2.'] },
      // Mechanics Lien — CIV Div4 Part6 Title2 Ch4 (8400 et seq.).
      { lawCode: 'CIV', division: '4.', title: '2.', part: '6.', chapters: ['4.'] },
      // Judicial Foreclosure of Mortgages — CCP Part2 Title10 Ch1 (725a-730.5).
      { lawCode: 'CCP', division: '', title: '10.', part: '2.', chapters: ['1.'] },
      // Deficiency procedure §§580a-580d — CCP Part2 Title8 Ch1 (clamp to 580-580.7).
      { lawCode: 'CCP', division: '', title: '8.', part: '2.', chapters: ['1.'], minSec: 580, maxSec: 580.7 },
    ],
  },
  {
    category: 'general_real_property',
    roots: [
      // Estates in Real Property — CIV Div2 PART 2 (Real or Immovable Property)
      // Title2 (761-817.4), ch1-5: estates in general, estates for years (incl.
      // CIV 789-793), easements/servitudes, conservation easements, etc.
      { lawCode: 'CIV', division: '2.', title: '2.', part: '2.', chapters: ['1.', '2.', '3.', '4.', '5.'] },
      // Nature of Property — CIV Div2 Part1 Title1 (654-663, chapter-less).
      { lawCode: 'CIV', division: '2.', title: '1.', part: '1.', chapters: [''] },
      // Ownership / co-tenancy — CIV Div2 Part1 Title2 (669-742), ch1-4. Ch2
      // (678-726, "Modifications of Ownership") holds joint tenancy & tenancy
      // in common (CIV 682-683.x).
      { lawCode: 'CIV', division: '2.', title: '2.', part: '1.', chapters: ['1.', '2.', '3.', '4.'] },
      // Acquisition — CIV Div2 Part4: Title1 modes (1000-1002), Title2 occupancy
      // (1006-1009), Title3 accession ch1 (1013-1018, accession to real
      // property). EXCLUDES Title4 transfer (-> conveyancing_title).
      { lawCode: 'CIV', division: '2.', title: '1.', part: '4.', chapters: [''] },
      { lawCode: 'CIV', division: '2.', title: '2.', part: '4.', chapters: [''] },
      { lawCode: 'CIV', division: '2.', title: '3.', part: '4.', chapters: ['1.'] },
      // Adverse-possession SOL — CCP Part2 Title2 Ch2 (§315-330; clamp 318-328).
      { lawCode: 'CCP', division: '', title: '2.', part: '2.', chapters: ['2.'], minSec: 318, maxSec: 328 },
    ],
  },
]

function curl(url: string): string {
  const buf = execFileSync('curl', ['-sL', '--max-time', '90', '-A', UA, url], {
    maxBuffer: 512 * 1024 * 1024,
  })
  return buf.toString('utf-8')
}

/** Walk backwards from an anchor's inner-text start to the opening <h6> of its row. */
function findAnchorOpen(html: string, anchorInnerStart: number): number {
  const h6 = html.lastIndexOf('<h6', anchorInnerStart)
  return h6 === -1 ? anchorInnerStart : h6
}

/**
 * Parse one displayText chapter page into its constituent sections. Each section
 * begins at a submitCodesValues anchor and runs to the next section's <h6> row
 * (so the trailing enactment note stays attached). The last section ends at the
 * first </body> following it (strips trailing JSF chrome). full_text keeps the
 * enactment parenthetical as the verbatim source-note trailer.
 *
 * NOTE: do NOT pre-truncate on </body>. The displayText page emits the static
 * shell's </body> EARLY (~29KB), THEN injects the statute run, THEN a second
 * </body>, THEN nav chrome. So anchors live AFTER the first </body>; we parse
 * anchors on the full HTML and bound only the LAST section at the </body> that
 * follows it.
 */
function parseChapter(html: string): Section[] {
  // Anchor first-arg forms, ALL of which carry a real section and must be
  // captured (a digit-only regex silently drops the latter two):
  //   - bare number      submitCodesValues('1213.', ...)
  //   - letter suffix    submitCodesValues('2924b.', ...)   (the entire core
  //                      nonjudicial-foreclosure run 2924a-2924p lives here)
  //   - bracketed        submitCodesValues('[1053.]', ...)  (renumbered sections)
  // Strip surrounding brackets + the trailing dot to store the clean number;
  // lowercase the letter suffix for stable keying.
  const anchorRe = /<a href="javascript:submitCodesValues\('(\[?[0-9]+(?:\.[0-9]+)*[a-zA-Z]*\.?\]?)'[^"]*"[^>]*>[^<]*<\/a>/g
  const marks: { num: string; start: number; end: number }[] = []
  let m: RegExpExecArray | null
  while ((m = anchorRe.exec(html)) !== null) {
    const num = m[1]
      .replace(/[[\]]/g, '')
      .replace(/\.$/, '')
      .replace(/([0-9])([A-Z]+)$/, (_s, d, l) => d + l.toLowerCase())
    marks.push({ num, start: anchorRe.lastIndex, end: 0 })
  }
  if (marks.length === 0) return []
  for (let i = 0; i < marks.length; i++) {
    if (i + 1 < marks.length) {
      marks[i].end = findAnchorOpen(html, marks[i + 1].start)
    } else {
      const close = html.toLowerCase().indexOf('</body>', marks[i].start)
      marks[i].end = close === -1 ? html.length : close
    }
  }

  const out: Section[] = []
  const seen = new Set<string>()
  for (const mk of marks) {
    if (seen.has(mk.num)) continue // anchor can repeat (h6 + inline); first wins
    const raw = html.slice(mk.start, mk.end)
    const text = stripTags(raw, true).trim()
    if (!text || text.length < 20) continue
    if (/^repealed\b/i.test(text)) continue
    if (/^\[?\s*reserved\.?\s*\]?$/i.test(text)) continue
    seen.add(mk.num)
    // CA section bodies carry no separate catchline in the rendered run; title null.
    out.push({ number: mk.num, title: null, text })
  }
  return out
}

/** True if a section number falls inside an optional [minSec,maxSec] clamp. */
function inRange(num: string, min?: number, max?: number): boolean {
  if (min === undefined && max === undefined) return true
  const n = parseFloat(num)
  if (!Number.isFinite(n)) return false
  if (min !== undefined && n < min) return false
  if (max !== undefined && n > max) return false
  return true
}

async function ingestCategory(spec: CategorySpec): Promise<number> {
  console.log(`\n--- ${spec.category}: ${spec.roots.length} root(s) ---`)
  let inserted = 0
  let parsed = 0
  const seenSections = new Set<string>() // dedupe within category across roots

  for (const root of spec.roots) {
    for (const ch of root.chapters) {
      const url = chapterUrl(root.lawCode, root.division, root.title, root.part, ch)
      let sections: Section[] = []
      try {
        sections = parseChapter(curl(url))
      } catch (e: any) {
        console.warn(`  ! ${root.lawCode} d${root.division}t${root.title}p${root.part}c${ch}: ${e?.message || e}`)
        continue
      }
      if (sections.length === 0) {
        process.stdout.write(`\r  ${root.lawCode} ${root.part}-${ch}: 0 (empty/gap)        `)
        await new Promise((r) => setTimeout(r, 200))
        continue
      }
      for (const s of sections) {
        if (!inRange(s.number, root.minSec, root.maxSec)) continue
        parsed++
        const key = `${root.lawCode}:${s.number}`
        if (seenSections.has(key)) continue // first occurrence wins
        seenSections.add(key)
        const res = await query<{ id: string }>(
          `INSERT INTO state_law_section_texts
             (state_code, act_key, section_number, section_title, full_text, source_url, source_date, effective_year, law_category)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
           ON CONFLICT (state_code, act_key, section_number, effective_year) DO NOTHING
           RETURNING id`,
          [
            STATE,
            spec.category, // act_key == category, per spec
            s.number,
            s.title,
            s.text,
            sectionUrl(root.lawCode, s.number),
            SOURCE_DATE,
            EFFECTIVE_YEAR,
            spec.category,
          ]
        )
        if (res.length > 0) inserted++
      }
      process.stdout.write(`\r  ${root.lawCode} ${root.part}-${ch}: parsed=${parsed} inserted=${inserted}      `)
      await new Promise((r) => setTimeout(r, 250)) // politeness
    }
  }
  console.log(`\n  [${spec.category}] parsedSections=${parsed} distinctInserted=${inserted}`)
  return inserted
}

async function main() {
  console.log(`\n=== CA — ingesting non-tax real-estate full-text corpus (as of ${SOURCE_DATE}) ===`)

  const counts: Record<string, number> = {}
  for (const spec of CATEGORIES) {
    counts[spec.category] = await ingestCategory(spec)
  }

  const total = Object.values(counts).reduce((a, b) => a + b, 0)
  console.log(`\nCA done. inserted=${total}`, counts)
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
