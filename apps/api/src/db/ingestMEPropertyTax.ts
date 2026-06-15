/**
 * Maine property-tax statute full-text ingester (sanctioned retrieve+cite+date
 * carve-out — verbatim statutory prose, never advice).
 *
 * SOURCE: Maine Revised Statutes, Title 36 (Taxation), Part 2 — Property Taxes,
 * served as per-section static HTML at the official legislature site:
 *   https://legislature.maine.gov/statutes/36/title36sec{NNN}.html
 * Sub-lettered sections hyphenate, e.g. title36sec946-B.html. Chapter TOCs at
 * title36ch{NN}sec0.html list per-section anchors. raw_http (curl, HTTP 200,
 * text/html, no JS, no auth, no rate-limit observed).
 *
 * The triage URL (title36ch0sec0.html) is the master Title-36 TOC — a list of
 * links, NOT statute text. This ingester drills PAST every TOC: it scrapes the
 * relevant CHAPTER TOCs for section anchors, then fetches each SECTION page and
 * parses the statutory body. Each section page carries:
 *   - <h3 class="heading_section">§NNN. Catchline</h3>   (number + title)
 *   - a run of <div class="mrs-text ..."> body paragraphs (the statutory prose)
 * Amendment/History annotations appear inline in square brackets, e.g.
 * '[PL 1995, c. 57, §4 (AMD).]' — kept inline as source-note metadata (the
 * carve-out allows a verbatim history trailer).
 *
 * ACT/CATEGORY MAPPING — all rows act_key='property_tax', law_category=
 * 'property_tax'; the five feature groups are tracked only for fetch/logging.
 * Section→group is by section-number range within the named chapters:
 *   exemptions             ch105 §§651-661, 681-689, 691-700-B  (subch 4/4-B/4-C)
 *   assessment             ch101 §§201-298, ch102 §§301-331, ch103 §§341-458
 *   assessment_review      ch101 §271 + ch105 §§841-844-N        (subch 8 + Board)
 *   levy_collection_payment ch105 §505 + §§751-766               (subch 6 + payment)
 *   delinquency_tax_sale   ch105 §§941-947 (incl. 942/943/943-C/946-B; subch 9)
 *
 * Repealed / reserved / empty (<20 char) / TOC / nav bodies are dropped.
 *
 * Run: cd apps/api && node -r ts-node/register src/db/ingestMEPropertyTax.ts
 * Idempotent (ON CONFLICT DO NOTHING).
 */

import { execFileSync } from 'child_process'
import { query } from './index'

const STATE = 'ME'
const ACT_KEY = 'property_tax'
const LAW_CATEGORY = 'property_tax'
const SOURCE_DATE = '2026-06-14'
const EFFECTIVE_YEAR = 2026
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) GAM-statute-ingest/1.0'
const BASE = 'https://legislature.maine.gov/statutes/36'
const tocUrl = (ch: number) => `${BASE}/title36ch${ch}sec0.html`
const secUrl = (num: string) => `${BASE}/title36sec${num}.html`

interface Parsed {
  number: string
  title: string | null
  text: string
}

function curl(url: string): string {
  const buf = execFileSync('curl', ['-sL', '--max-time', '60', '-A', UA, url], {
    maxBuffer: 128 * 1024 * 1024,
  })
  return buf.toString('utf-8')
}

/** Decode the handful of HTML entities the ME pages emit, then collapse ws. */
function clean(s: string): string {
  return s
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&rsquo;|&lsquo;/g, "'")
    .replace(/&ldquo;|&rdquo;/g, '"')
    .replace(/&sect;/g, '§')
    .replace(/&mdash;/g, '—')
    .replace(/&ndash;/g, '–')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(parseInt(n, 10)))
    .replace(/[ \t ]+/g, ' ')
    .trim()
}

/**
 * Parse one section page. Heading: <h3 class="heading_section">§NNN. Title</h3>.
 * Body: every <div class="mrs-text ...">…</div> joined by newline. Returns null
 * for repealed / reserved / missing / short bodies.
 */
function parseSectionPage(html: string, expectedNumber: string): Parsed | null {
  const hMatch = html.match(/<h3 class="heading_section">([\s\S]*?)<\/h3>/i)
  if (!hMatch) return null
  const heading = clean(hMatch[1])
  // Strip leading "§NNN." citation to derive the title.
  let title: string | null = heading.replace(/^§\s*[0-9A-Za-z.:-]+\.?\s*/, '').trim()
  if (!title) title = null
  if (title && /^repealed\b/i.test(title)) return null
  if (title && /^\[?reserved\.?\]?$/i.test(title)) return null

  const paras = [...html.matchAll(/<div class="mrs-text[^"]*">([\s\S]*?)<\/div>/gi)]
    .map((m) => clean(m[1]))
    .filter(Boolean)
  const text = paras.join('\n').trim()
  if (!text || text.length < 20) return null
  if (/^\[?reserved\.?\]?$/i.test(text)) return null

  return { number: expectedNumber, title, text }
}

/** Scrape per-section anchors (number strings) from a chapter TOC page. */
function harvestChapter(ch: number): string[] {
  const html = curl(tocUrl(ch))
  const re = /href="\.?\/?title36sec([0-9A-Za-z-]+)\.html"/gi
  const seen = new Set<string>()
  const out: string[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) {
    if (!seen.has(m[1])) {
      seen.add(m[1])
      out.push(m[1])
    }
  }
  return out
}

/** Numeric base of a section string ("946-B" -> 946) for range filtering. */
function baseNum(num: string): number {
  const n = parseInt(num.split('-')[0], 10)
  return Number.isFinite(n) ? n : -1
}

/** Keep section strings whose numeric base is in any [lo,hi] range. */
function inRanges(num: string, ranges: [number, number][]): boolean {
  const b = baseNum(num)
  return ranges.some(([lo, hi]) => b >= lo && b <= hi)
}

interface Group {
  name: string
  sections: string[]
}

async function ingestGroup(g: Group): Promise<{ inserted: number; skipped: number; failed: number }> {
  let inserted = 0
  let skipped = 0
  let failed = 0
  const CONC = 4
  for (let i = 0; i < g.sections.length; i += CONC) {
    if (i > 0) await new Promise((r) => setTimeout(r, 250)) // politeness
    const batch = g.sections.slice(i, i + CONC)
    const parsed = batch.map((num) => {
      try {
        return { p: parseSectionPage(curl(secUrl(num)), num), num }
      } catch (e: any) {
        console.warn(`  ! [${g.name}] §${num}: ${e?.message || e}`)
        failed++
        return { p: null, num }
      }
    })
    for (const { p } of parsed) {
      if (!p) {
        skipped++
        continue
      }
      await query(
        `INSERT INTO state_law_section_texts
           (state_code, act_key, section_number, section_title, full_text, source_url, source_date, effective_year, law_category)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (state_code, act_key, section_number, effective_year) DO NOTHING`,
        [STATE, ACT_KEY, p.number, p.title, p.text, secUrl(p.number), SOURCE_DATE, EFFECTIVE_YEAR, LAW_CATEGORY]
      )
      inserted++
    }
    process.stdout.write(`\r  [${g.name}] ${Math.min(i + CONC, g.sections.length)}/${g.sections.length}`)
  }
  console.log(`\n  [${g.name}] inserted ${inserted}, skipped ${skipped}, failed ${failed} of ${g.sections.length}`)
  return { inserted, skipped, failed }
}

async function main() {
  console.log(`\n=== ME — ingesting Title 36 Part 2 property-tax corpus (as of ${SOURCE_DATE}) ===`)

  // Harvest chapter TOCs once.
  const ch101 = harvestChapter(101)
  const ch102 = harvestChapter(102)
  const ch103 = harvestChapter(103)
  const ch105 = harvestChapter(105)
  console.log(
    `Harvested TOC sections: ch101=${ch101.length} ch102=${ch102.length} ch103=${ch103.length} ch105=${ch105.length}`
  )

  // De-dupe across groups: a section ingested once must not be re-fetched in another
  // group (ON CONFLICT would no-op the insert but we'd still double-count). Track globally.
  const claimed = new Set<string>()
  const claim = (chSections: string[], ranges: [number, number][]): string[] => {
    const out: string[] = []
    for (const s of chSections) {
      if (inRanges(s, ranges) && !claimed.has(s)) {
        claimed.add(s)
        out.push(s)
      }
    }
    return out
  }

  const groups: Group[] = [
    {
      name: 'exemptions',
      // subch 4 (651-661), 4-B (681-689), 4-C (691-700-B)
      sections: claim(ch105, [[651, 661], [681, 689], [691, 700]]),
    },
    {
      name: 'assessment',
      sections: [
        ...claim(ch101, [[201, 298]]),
        ...claim(ch102, [[301, 331]]),
        ...claim(ch103, [[341, 458]]),
      ],
    },
    {
      name: 'assessment_review',
      // ch101 §271 (State Board) + ch105 subch 8 (841-844-N)
      sections: [...claim(ch101, [[271, 271]]), ...claim(ch105, [[841, 844]])],
    },
    {
      name: 'levy_collection_payment',
      // ch105 §505 (payment/due dates/interest) + subch 6 (751-766)
      sections: claim(ch105, [[505, 505], [751, 766]]),
    },
    {
      name: 'delinquency_tax_sale',
      // ch105 subch 9 enforcement of lien on real estate (941-947 incl. 943-C, 946-B)
      sections: claim(ch105, [[941, 947]]),
    },
  ]

  const totals: Record<string, { inserted: number; skipped: number; failed: number }> = {}
  for (const g of groups) {
    console.log(`\n${g.name}: ${g.sections.length} candidate sections`)
    totals[g.name] = await ingestGroup(g)
  }

  const grand = Object.values(totals).reduce((a, b) => a + b.inserted, 0)
  console.log(`\nME done. inserted=${grand}`)
  console.table(totals)
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
