/**
 * Vermont property-tax statute full-text ingester (sanctioned retrieve+cite+date
 * carve-out — verbatim statutory TEXT only, never advice).
 *
 * Official source: Vermont Statutes Online at legislature.vermont.gov. Plain
 * server-rendered HTML, no JS required, curl-friendly. URL scheme:
 *   - Chapter index: /statutes/chapter/32/{CH}      (lists section links)
 *   - Section page:  /statutes/section/32/{CH}/{SECNUM}  (SECNUM zero-padded
 *     to 5 digits, optional trailing letter, e.g. 03802, 03802a, 04041)
 *
 * Title 32 (Taxation & Finance) property-tax chapters ingested:
 *   Ch. 125 — Exemptions (§ 3802 Property tax exemptions, etc.)
 *   Ch. 129 — Grand Tax Lists (appraisals; § 4041 examination/appraisal)
 *   Ch. 131 — Appeals (grievance / BCA / state appraiser / PVR)
 *   Ch. 133 — Assessment and Collection of Taxes (assessment, collector,
 *             town-tax payment incl. § 4773; tax liens §§ 5061+;
 *             delinquent taxes / tax sale §§ 5131-5295, incl. interest,
 *             notice/levy of sale, redemption, collector's deed)
 *
 * Section-page parse recipe:
 *   1. Canonical citation: <b>(Cite as: 32 V.S.A. § NNNN)</b>
 *      → /Cite as:\s*32 V\.S\.A\.\s*§\s*([0-9A-Za-z]+)/
 *   2. Body block: <ul class="item-list statutes-detail"> ... </ul>
 *   3. Heading paragraph: <p><b>§ NNNN. {Title}</b></p>; statutory body is the
 *      run of <p> tags that follow. Split number/title with
 *      /§\s*([0-9A-Za-z]+)\.\s*(.+)/; concatenate following <p> text as the
 *      verbatim body (decode entities, normalize whitespace).
 *   4. Section enumeration: scrape <a href="/statutes/section/32/{CH}/{SECNUM}">
 *      from the chapter index page.
 *
 * Repealed / reserved / empty (<20 char) bodies are dropped (a repealed section
 * has heading "§ NNNN. Repealed. ..." with no body paragraphs — caught by both
 * the title-prefix check and the empty-body check).
 *
 * Run: cd apps/api && node -r ts-node/register src/db/ingestVTPropertyTax.ts
 * Idempotent (ON CONFLICT DO NOTHING). Uses stripTags from the corpus framework.
 */

import { execFileSync } from 'child_process'
import { query } from './index'
import { stripTags } from './ingestStateLawCorpus'

const STATE = 'VT'
const ACT_KEY = 'property_tax'
const LAW_CATEGORY = 'property_tax'
const SOURCE_DATE = '2026-06-14'
const EFFECTIVE_YEAR = 2026
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) GAM-statute-ingest/1.0'
const BASE = 'https://legislature.vermont.gov'

const chapterIndexUrl = (ch: number) => `${BASE}/statutes/chapter/32/${ch}`
const sectionUrl = (ch: number, secnum: string) => `${BASE}/statutes/section/32/${ch}/${secnum}`

// Title 32 property-tax chapters. Topical group label kept for log clarity only;
// every row lands under act_key/law_category = 'property_tax'.
const CHAPTERS: { ch: number; topic: string }[] = [
  { ch: 125, topic: 'exemptions' },
  { ch: 129, topic: 'assessment' },
  { ch: 131, topic: 'assessment_review' },
  { ch: 133, topic: 'levy_collection_payment + delinquency_tax_sale' },
]

interface SecRef { ch: number; secnum: string }
interface Parsed { number: string; title: string | null; text: string; url: string }

function curl(url: string): string {
  const buf = execFileSync('curl', ['-sL', '--max-time', '60', '-A', UA, url], {
    maxBuffer: 256 * 1024 * 1024,
  })
  return buf.toString('utf-8')
}

/** Scrape unique section SECNUMs from a chapter index page (in document order). */
function harvestChapter(ch: number, html: string): SecRef[] {
  const re = new RegExp(`href="/statutes/section/32/${ch}/([0-9A-Za-z]+)"`, 'gi')
  const seen = new Set<string>()
  const out: SecRef[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) {
    const secnum = m[1]
    if (seen.has(secnum)) continue
    seen.add(secnum)
    out.push({ ch, secnum })
  }
  return out
}

/**
 * Parse a section page. catchline = heading "<b>§ NNNN. Title</b>" inside the
 * statutes-detail block; body = the <p> run after it. Returns null for
 * repealed / reserved / empty pages.
 */
function parseSectionPage(html: string, url: string): Parsed | null {
  const blockMatch = html.match(/<ul class="item-list statutes-detail">([\s\S]*?)<\/ul>/i)
  if (!blockMatch) return null
  const block = blockMatch[1]

  // Each <p>...</p> in the block, tag-stripped to readable text, empties dropped.
  const paras = [...block.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)]
    .map((m) => stripTags(m[1], false))
    .map((p) => p.trim())
    .filter(Boolean)
  if (paras.length === 0) return null

  // Locate the heading paragraph: "§ NNNN. Title".
  let headIdx = -1
  let number = ''
  let title: string | null = null
  for (let i = 0; i < paras.length; i++) {
    const hm = paras[i].match(/^§\s*([0-9A-Za-z]+)\.\s*(.+)$/)
    if (hm) {
      headIdx = i
      number = hm[1]
      title = hm[2].trim()
      break
    }
  }
  if (headIdx === -1 || !number) return null

  // Drop repealed / reserved sections (heading title carries the marker).
  if (title && /^repealed\b/i.test(title)) return null
  if (title && /^\[?\s*repealed/i.test(title)) return null
  if (title && /^\[?\s*reserved/i.test(title)) return null
  if (title === '') title = null

  const body = paras
    .slice(headIdx + 1)
    .join('\n')
    .trim()

  if (!body || body.length < 20) return null
  if (/^\[?\s*repealed/i.test(body)) return null
  if (/^\[?\s*reserved/i.test(body)) return null

  return { number, title, text: body, url }
}

async function ingestChapter(ch: number, topic: string, refs: SecRef[]): Promise<number> {
  let ok = 0
  let skipped = 0
  const CONC = 3
  for (let i = 0; i < refs.length; i += CONC) {
    if (i > 0) await new Promise((r) => setTimeout(r, 250)) // politeness
    const batch = refs.slice(i, i + CONC)
    const parsed = await Promise.all(
      batch.map(async (r) => {
        const url = sectionUrl(r.ch, r.secnum)
        try {
          return parseSectionPage(curl(url), url)
        } catch (e: any) {
          console.warn(`  ! ch${ch} ${r.secnum}: ${e?.message || e}`)
          return null
        }
      })
    )
    for (const p of parsed) {
      if (!p) {
        skipped++
        continue
      }
      await query(
        `INSERT INTO state_law_section_texts
           (state_code, act_key, section_number, section_title, full_text, source_url, source_date, effective_year, law_category)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (state_code, act_key, section_number, effective_year) DO NOTHING`,
        [STATE, ACT_KEY, p.number, p.title, p.text, p.url, SOURCE_DATE, EFFECTIVE_YEAR, LAW_CATEGORY]
      )
      ok++
    }
    process.stdout.write(`\r  [ch${ch} ${topic}] ${Math.min(i + CONC, refs.length)}/${refs.length}`)
  }
  console.log(`\n  [ch${ch} ${topic}] inserted ${ok}, dropped ${skipped} of ${refs.length}`)
  return ok
}

async function main() {
  console.log(`\n=== VT property-tax — ingesting Title 32 full text (as of ${SOURCE_DATE}) ===`)

  const counts: Record<string, number> = {}
  for (const { ch, topic } of CHAPTERS) {
    const refs = harvestChapter(ch, curl(chapterIndexUrl(ch)))
    console.log(`ch${ch} (${topic}): harvested ${refs.length} section links`)
    counts[`ch${ch}`] = await ingestChapter(ch, topic, refs)
  }

  const total = Object.values(counts).reduce((a, b) => a + b, 0)
  console.log(`\nVT done. inserted=${total}`, counts)
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
