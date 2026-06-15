/**
 * Utah property-tax statute full-text ingester (state-law KB carve-out).
 *
 * Source: Utah Code, Title 59 (Revenue and Taxation), Chapter 2 — Property
 * Tax Act. OFFICIAL site le.utah.gov. The /xcode .html pages are JS-rendered
 * shells (no body text in the raw response); the statutory prose lives in the
 * STRUCTURED XML endpoint served by the same path with a .xml extension:
 *
 *   https://le.utah.gov/xcode/Title59/Chapter2/C59-2-P{N}_{versionstamp}.xml
 *
 * Plain HTTP GET, no JS. The static "current" stamp 1800010118000101 resolves
 * to the in-force version for most parts. Exception captured below: Part 11
 * (Exemptions) was renumbered 5/3/2023, so its in-force stamp is
 * 2023050320230503 (the 1800010118000101 stamp returns only an empty
 * <part> stub with a 5/3/2023 enddate). Each part is fetched at its working
 * stamp; the map is explicit so the failure mode is loud, not silent.
 *
 * XML shape (per le.utah.gov/xcode DTD):
 *   <part number="59-2-N"><catchline>Part title</catchline>
 *     <section number="59-2-NNNN">
 *       [<effdate>m/d/y</effdate>] [<enddate type="SC">m/d/y</enddate>]
 *       <histories><history>Amended by Chapter NNN, YYYY ...</history>
 *                  <modyear>YYYY</modyear></histories>
 *       <catchline>Section title.</catchline>
 *       <subsection number="59-2-NNNN(1)">body...
 *          <subsection number="59-2-NNNN(1)(a)">nested body...</subsection>
 *       </subsection>
 *       <xref ...>cross-ref display text</xref>  (inner text kept inline)
 *       <tab/> <eol/>  (layout — collapsed to space / newline)
 *     </section>
 *   </part>
 *
 * VERSION SELECTION (in-force as of SOURCE_DATE):
 *   A handful of sections are served in TWO versions in the same file — the
 *   version currently in force (carries a FUTURE <enddate>, e.g. 7/1/2026) and
 *   the not-yet-effective amendment (carries a FUTURE <effdate>). We keep the
 *   version in force TODAY: drop a block whose <enddate> is already past, and
 *   drop a block whose <effdate> is still in the future. Dedupe by section
 *   number keeping the first in-force block. (As of 2026-06-14 nothing in these
 *   six parts is repealed / past-enddate; all enddates are future amendments.)
 *
 * ACT MAPPING — single act_key 'property_tax' across all five feature groups,
 * matching the ingest contract. The five groups map to parts:
 *   exemptions             = Part 11
 *   assessment             = Parts 1 (defs/general) + 2 (commission) + 3 (county)
 *   assessment_review      = Part 10 (equalization / appeals)
 *   levy_collection_payment + delinquency_tax_sale = Part 13 (collection)
 *
 * Verbatim only (retrieve + cite + date carve-out — never advice). Repealed /
 * reserved / empty (<20 char) / TOC / nav bodies are dropped.
 *
 * Run: cd apps/api && node -r ts-node/register src/db/ingestUTPropertyTax.ts
 * Idempotent (ON CONFLICT DO NOTHING).
 */

import { execFileSync } from 'child_process'
import { query } from './index'

const STATE = 'UT'
const ACT_KEY = 'property_tax'
const LAW_CATEGORY = 'property_tax'
const SOURCE_DATE = '2026-06-14'
const EFFECTIVE_YEAR = 2026
const TODAY = new Date('2026-06-14T00:00:00Z')
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) GAM-statute-ingest/1.0'
const BASE = 'https://le.utah.gov/xcode/Title59/Chapter2'

// Part -> working version stamp. 1800010118000101 = "current" for most; Part 11
// renumbered 5/3/2023 so its in-force stamp is 2023050320230503.
const PARTS: { part: string; stamp: string; group: string }[] = [
  { part: 'P1', stamp: '1800010118000101', group: 'assessment (general provisions / defs)' },
  { part: 'P2', stamp: '1800010118000101', group: 'assessment (commission)' },
  { part: 'P3', stamp: '1800010118000101', group: 'assessment (county)' },
  { part: 'P10', stamp: '1800010118000101', group: 'assessment_review (equalization)' },
  { part: 'P11', stamp: '2023050320230503', group: 'exemptions' },
  { part: 'P13', stamp: '1800010118000101', group: 'levy_collection_payment + delinquency_tax_sale' },
]

const partUrl = (part: string, stamp: string) => `${BASE}/C59-2-${part}_${stamp}.xml`

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

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&sect;/g, '§')
    .replace(/&nbsp;/g, ' ')
}

function stripTags(s: string): string {
  return decodeEntities(s.replace(/<[^>]+>/g, ' '))
}

/** Parse a m/d/y date string into a Date (UTC midnight). */
function parseDate(s: string): Date | null {
  const m = s.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/)
  if (!m) return null
  return new Date(Date.UTC(+m[3], +m[1] - 1, +m[2]))
}

/** Split a <part> XML body into [number, sectionBlock] pairs by section start. */
function splitSections(xml: string): { number: string; block: string }[] {
  const starts: { idx: number; number: string }[] = []
  const re = /<section number="([^"]+)">/g
  let m: RegExpExecArray | null
  while ((m = re.exec(xml)) !== null) starts.push({ idx: m.index, number: m[1] })
  const out: { number: string; block: string }[] = []
  for (let i = 0; i < starts.length; i++) {
    const end = i + 1 < starts.length ? starts[i + 1].idx : xml.length
    out.push({ number: starts[i].number, block: xml.slice(starts[i].idx, end) })
  }
  return out
}

/**
 * Is this section block in force as of TODAY? The effdate/enddate that belong
 * to the SECTION (not a nested subsection) appear in the block head, before the
 * <catchline>. Drop if enddate already passed, or if effdate is still future.
 */
function inForce(block: string): boolean {
  const head = block.slice(0, 400)
  const ed = head.match(/<enddate[^>]*>([^<]+)<\/enddate>/)
  const efd = head.match(/<effdate[^>]*>([^<]+)<\/effdate>/)
  if (ed) {
    const d = parseDate(ed[1])
    if (d && d.getTime() <= TODAY.getTime()) return false
  }
  if (efd) {
    const d = parseDate(efd[1])
    if (d && d.getTime() > TODAY.getTime()) return false
  }
  return true
}

/**
 * Extract verbatim section text from a <section> block. Keeps subsection number
 * labels inline (e.g. "(1)(a)"), inlines <xref> display text, collapses <tab/>
 * to space and <eol/> to newline. Appends the history note as a provenance
 * trailer (the carve-out captures amendment provenance for the date stamp).
 */
function parseSection(number: string, block: string): Parsed | null {
  const catM = block.match(/<catchline>([\s\S]*?)<\/catchline>/)
  let title: string | null = catM ? stripTags(catM[1]).replace(/\s+/g, ' ').trim() : null
  if (!title) title = null
  if (title && /^repealed\b/i.test(title)) return null
  if (title && /^\[?reserved\.?\]?\.?$/i.test(title)) return null

  // Body = everything after the section's own catchline.
  let after = catM ? block.slice((catM.index ?? 0) + catM[0].length) : block

  // Drop the histories block from the body (kept separately as a trailer).
  after = after.replace(/<histories>[\s\S]*?<\/histories>/g, ' ')

  // Subsection number -> inline label "(1)(a)(i)" (the paren tail of the number).
  after = after.replace(/<subsection number="([^"]+)">/g, (_m, full: string) => {
    const tail = full.replace(/^59-2-[0-9A-Za-z.]+/, '')
    return tail ? ` ${tail} ` : ' '
  })
  after = after.replace(/<\/subsection>/g, ' ')

  // xref / similar inline elements: keep inner text.
  after = after.replace(/<xref[^>]*>([\s\S]*?)<\/xref>/g, '$1')

  // layout tags
  after = after.replace(/<tab\/>/g, ' ').replace(/<eol\/>/g, '\n')

  // remaining tags -> space, decode entities
  after = decodeEntities(after.replace(/<[^>]+>/g, ' '))

  // whitespace normalize (preserve newlines as paragraph breaks)
  after = after
    .replace(/[ \t\f\r]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim()

  if (!after || after.length < 20) return null
  if (/^\[?reserved\.?\]?\.?$/i.test(after)) return null
  if (/^repealed\b/i.test(after)) return null

  // Provenance trailer: amendment history (date-stamp requirement).
  const hists = [...block.matchAll(/<history>([\s\S]*?)<\/history>/g)].map((h) =>
    stripTags(h[1]).replace(/\s+/g, ' ').trim()
  )
  const histLine = hists.filter(Boolean).join('; ')
  const fullText = histLine ? `${after}\n\n${histLine}` : after

  return { number, title, text: fullText }
}

async function main() {
  console.log(`\n=== UT property_tax — ingesting Title 59 Chapter 2 (as of ${SOURCE_DATE}) ===`)
  let inserted = 0
  let skipped = 0
  const perPart: Record<string, number> = {}

  for (const { part, stamp, group } of PARTS) {
    const url = partUrl(part, stamp)
    let xml: string
    try {
      xml = curl(url)
    } catch (e: any) {
      console.warn(`  ! ${part} fetch failed: ${e?.message || e}`)
      perPart[part] = 0
      continue
    }
    if (!/<section number=/.test(xml)) {
      console.warn(`  ! ${part} returned no <section> elements (stub/404?) — bytes=${xml.length}`)
      perPart[part] = 0
      continue
    }

    const blocks = splitSections(xml)
    const seen = new Set<string>()
    let partOk = 0
    for (const { number, block } of blocks) {
      if (!inForce(block)) continue
      if (seen.has(number)) continue // dedupe duplicate (current vs future) versions
      seen.add(number)
      const p = parseSection(number, block)
      if (!p) {
        skipped++
        continue
      }
      const res = await query<{ id: string }>(
        `INSERT INTO state_law_section_texts
           (state_code, act_key, section_number, section_title, full_text,
            source_url, source_date, effective_year, law_category)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (state_code, act_key, section_number, effective_year) DO NOTHING
         RETURNING id`,
        [STATE, ACT_KEY, p.number, p.title, p.text, url, SOURCE_DATE, EFFECTIVE_YEAR, LAW_CATEGORY]
      )
      inserted += res.length
      partOk += res.length
    }
    perPart[part] = partOk
    console.log(`  [${part}] ${group}: inserted ${partOk}`)
  }

  console.log(`\nUT done. inserted=${inserted}, skipped=${skipped}`, perPart)
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
