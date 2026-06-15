/**
 * Michigan property-tax statute full-text ingester (sanctioned retrieve+cite+
 * date carve-out — verbatim statute text only, never advice).
 *
 * SOURCE: Michigan Compiled Laws, Chapter 211 — The General Property Tax Act
 * (Act 206 of 1893), official Michigan Legislature site. Per-section pages at
 *   https://www.legislature.mi.gov/Laws/MCL?objectName=mcl-211-<sec>
 * are server-rendered plain HTML (raw_http; curl returns the full body, no JS).
 *
 * PAGE LAYOUT (verified S472 against mcl-211-7u and peers):
 *   <div class="sectionWrapper">
 *     <div class="excerpt"> ...act name header... </div>   (skipped)
 *     <h1 class="h4">211.7u <catchline / title text></h1>   (number + title)
 *     <p class="margin8Px">Sec. 7u.</p>                     (Sec. marker, dropped)
 *     <p>...subsection (1)...</p> <p>(2)...</p> ...          (verbatim body)
 *     <div class="editorials"><p>History: Add. 1980...</p>  (source note, kept)
 *   </div>
 * Repealed sections render as `<h1 class="h4">211.20 Repealed. ...</h1>` with an
 * empty body — dropped by the Repealed-title check + the <20-char body floor.
 *
 * ENUMERATION: each page carries a `Next Section` anchor
 *   <a href="/Laws/MCL?objectName=mcl-211-7v">Next Section ...</a>
 * The act-TOC page only renders the first row + a subdivision tree (no flat
 * section list), so we walk the Next-Section chain instead — starting at each
 * chapter's first section and stopping when the BASE integer of the section
 * number passes the chapter's upper bound. Section numbers carry letter suffixes
 * (211.7, 211.7a ... 211.7zz), so boundaries are keyed on the leading integer.
 *
 * FIVE FEATURE CHAPTERS (per triage recipe), each → law_category/act_key
 * 'property_tax', covering Chapter 211 §§ 211.7-211.79a:
 *   exemptions            211.7  - 211.9p   (real + personal property exemptions)
 *   assessment            211.10 - 211.27e  (assessment procedures / true cash value)
 *   assessment_review     211.28 - 211.34d  (boards of review / equalization)
 *   levy_collection_payment 211.44 - 211.59 (collection, due dates, penalty/fees)
 *   delinquency_tax_sale  211.60 - 211.79a  (forfeiture, foreclosure, redemption)
 * Gaps between chapter ranges (e.g. 211.35-211.43) are skipped by the walker.
 *
 * Run: cd apps/api && node -r ts-node/register src/db/ingestMIPropertyTax.ts
 * Idempotent (ON CONFLICT DO NOTHING). Official source ONLY.
 */

import { execFileSync } from 'child_process'
import { query } from './index'
import { stripTags } from './ingestStateLawCorpus'

const STATE = 'MI'
const ACT_KEY = 'property_tax'
const LAW_CATEGORY = 'property_tax'
const SOURCE_DATE = '2026-06-14'
const EFFECTIVE_YEAR = 2026
const UA = 'GAM-statute-ingest/1.0 (compliance research)'
const BASE = 'https://www.legislature.mi.gov/Laws/MCL?objectName='

const sectionUrl = (obj: string) => `${BASE}${obj}`

interface Parsed {
  number: string // e.g. "211.7u"
  baseInt: number // e.g. 7
  title: string | null
  text: string
  next: string | null // next objectName, e.g. "mcl-211-7v"
}

// Feature chapters: [topic, firstObjectName, baseLo, baseHi]. We walk Next from
// `start` and keep sections whose base integer is within [lo, hi].
interface Chapter {
  topic: string
  start: string
  lo: number
  hi: number
}
const CHAPTERS: Chapter[] = [
  { topic: 'exemptions', start: 'mcl-211-7', lo: 7, hi: 9 },
  { topic: 'assessment', start: 'mcl-211-10', lo: 10, hi: 27 },
  { topic: 'assessment_review', start: 'mcl-211-28', lo: 28, hi: 34 },
  { topic: 'levy_collection_payment', start: 'mcl-211-44', lo: 44, hi: 59 },
  { topic: 'delinquency_tax_sale', start: 'mcl-211-60', lo: 60, hi: 79 },
]

function curl(url: string): string {
  const buf = execFileSync('curl', ['-sL', '--max-time', '60', '-A', UA, url], {
    maxBuffer: 128 * 1024 * 1024,
  })
  return buf.toString('utf-8')
}

/** Leading integer of a "211.<n><suffix>" section number (211.7u -> 7). */
function baseIntOf(number: string): number {
  const m = number.match(/^211\.(\d+)/)
  return m ? parseInt(m[1], 10) : NaN
}

/**
 * Parse one MCL section page. Returns the catchline-derived number/title, the
 * verbatim body (subsection lettering preserved) with the trailing History note
 * appended as a source trailer, plus the Next-Section objectName for the walker.
 * Returns text='' for repealed/reserved/empty pages (caller drops them) but
 * still returns `next` so the chain isn't broken.
 */
function parseSection(html: string): Parsed | null {
  // Next-Section objectName (used to walk the chain even when this page is dropped).
  const nm = html.match(/<a href\s*=\s*"\/Laws\/MCL\?objectName=(mcl-211-[0-9A-Za-z]+)">\s*Next Section/i)
  const next = nm ? nm[1] : null

  // Catchline: <h1 class="h4">211.<num> <title text></h1>
  const h = html.match(/<h1 class="h4"[^>]*>([\s\S]*?)<\/h1>/i)
  if (!h) return null
  const catch_ = stripTags(h[1], false).trim()
  const cm = catch_.match(/^(211\.[0-9A-Za-z]+)\s*(.*)$/s)
  if (!cm) return null
  const number = cm[1]
  let title: string | null = cm[2].trim() || null
  const baseInt = baseIntOf(number)

  // Repealed / reserved → emit empty text; walker keeps following `next`.
  if (title && /^repealed\b/i.test(title)) return { number, baseInt, title, text: '', next }
  if (title && /^\[?reserved\.?\]?$/i.test(title)) return { number, baseInt, title, text: '', next }

  // Body = <p> paragraphs after the catchline, up to the editorials/history div.
  const after = html.slice(h.index! + h[0].length)
  const bodyPart = after.split(/<div class="editorials/i)[0]
  const paras = [...bodyPart.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)]
    .map((m) => stripTags(m[1], false).trim())
    .filter(Boolean)
    .filter((t) => !/^Sec\.\s*[0-9A-Za-z]*\.?$/i.test(t)) // drop the "Sec. 7u." marker line

  // History note (kept as source-note trailer, per carve-out — it's the
  // statutory provenance, not advice).
  let history = ''
  const ed = after.match(/<div class="editorials[^"]*"[^>]*>([\s\S]*?)<\/div>/i)
  if (ed) {
    const h2 = stripTags(ed[1], false).replace(/\s+/g, ' ').trim()
    if (/^History:/i.test(h2)) history = h2
  }

  let text = paras.join('\n').trim()
  if (history) text = (text ? text + '\n\n' : '') + history
  return { number, baseInt, title, text, next }
}

async function ingestChapter(ch: Chapter): Promise<{ ok: number; visited: number; dropped: number }> {
  let obj: string | null = ch.start
  let ok = 0
  let visited = 0
  let dropped = 0
  const seen = new Set<string>()
  while (obj && !seen.has(obj)) {
    seen.add(obj)
    let p: Parsed | null
    try {
      p = parseSection(curl(sectionUrl(obj)))
    } catch (e: any) {
      console.warn(`  ! ${ch.topic} ${obj}: ${e?.message || e}`)
      break
    }
    if (!p) break
    visited++

    // Stop once we pass the chapter's upper base bound.
    if (Number.isFinite(p.baseInt) && p.baseInt > ch.hi) break

    // Insert only within the chapter range with non-trivial body.
    if (Number.isFinite(p.baseInt) && p.baseInt >= ch.lo && p.baseInt <= ch.hi) {
      if (!p.text || p.text.length < 20) {
        dropped++
      } else {
        await query(
          `INSERT INTO state_law_section_texts
             (state_code, act_key, section_number, section_title, full_text, source_url, source_date, effective_year, law_category)
           VALUES ('MI','property_tax',$1,$2,$3,$4,'2026-06-14',2026,'property_tax')
           ON CONFLICT (state_code, act_key, section_number, effective_year) DO NOTHING`,
          [p.number, p.title, p.text, sectionUrl(obj)]
        )
        ok++
      }
    }
    obj = p.next
    if (visited % 5 === 0) process.stdout.write(`\r  [${ch.topic}] visited ${visited}, inserted ${ok}`)
    await new Promise((r) => setTimeout(r, 150)) // politeness
  }
  console.log(`\n  [${ch.topic}] visited ${visited}, inserted ${ok}, dropped ${dropped}`)
  return { ok, visited, dropped }
}

async function main() {
  console.log(`\n=== MI — ingesting Chapter 211 property-tax corpus (as of ${SOURCE_DATE}) ===`)
  const counts: Record<string, number> = {}
  for (const ch of CHAPTERS) {
    const r = await ingestChapter(ch)
    counts[ch.topic] = r.ok
  }
  const total = Object.values(counts).reduce((a, b) => a + b, 0)
  console.log(`\nMI done. inserted=${total}`, counts)
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
