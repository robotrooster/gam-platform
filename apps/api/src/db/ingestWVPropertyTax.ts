/**
 * West Virginia PROPERTY-TAX statute full-text ingester (sanctioned
 * retrieve+cite+date carve-out — verbatim statute text only, never advice).
 *
 * Official source: code.wvlegislature.gov (WordPress-rendered, plain
 * server-rendered HTML, no JS required → raw curl). The URL scheme is
 * deterministic:
 *   - Article index:  https://code.wvlegislature.gov/{ART}/          e.g. /11-3/, /11A-1/
 *   - Section page:    https://code.wvlegislature.gov/{ART}-{SEC}/    e.g. /11-3-1/, /11A-3-2/
 *     (letter suffixes are UPPERCASED in the path: /11-3-2A/, /11-3-24A/)
 *
 * INDEX PARSE: each index page lists only its own article's sections as
 *   <div class='sec-head' ...><a href='/{ART}-{SEC}/'>§{art}-{sec}. {Title}</a></div>
 * (single-quoted hrefs, letter suffix uppercased in the path). We regex the
 * hrefs to enumerate every section in the article.
 *
 * SECTION PARSE: the codified text lives inside a single
 *   <div class='sectiontext hid'> ... </div>
 * container whose first child is <h4>§{art}-{sec}. {catchline}</h4> followed by
 * the body <p>/<table> run. That div contains NO nav / bill-history / search
 * chrome, so we extract its balanced inner HTML, take the <h4> as
 * number+catchline, and concatenate the remaining block text as verbatim body.
 * Section number is stored in canonical lowercase form (e.g. "11-3-1a"), the
 * "§" prefix stripped, matching the existing WV corpus convention (55-3-1, ...).
 *
 * ACT/CATEGORY MAPPING (all five chapters → one act_key + one law_category):
 *   act_key      = 'property_tax'
 *   law_category = 'property_tax'
 * Five feature-chapter groups all live under the same act_key; the citation
 * topics (exemptions / assessment / assessment_review / levy_collection_payment
 * / delinquency_tax_sale) span four code articles:
 *   exemptions + assessment + assessment_review → Ch.11 Art.3 (11-3)
 *   levy_collection_payment                     → Ch.11A Art.1 (11A-1)
 *   delinquency_tax_sale                        → Ch.11A Art.2 (11A-2) + Art.3 (11A-3)
 *
 * Run: cd apps/api && node -r ts-node/register src/db/ingestWVPropertyTax.ts
 * Idempotent (ON CONFLICT DO NOTHING). Repealed/reserved/short (<20 char)
 * bodies are dropped.
 */

import { execFileSync } from 'child_process'
import { query } from './index'

const STATE = 'WV'
const ACT_KEY = 'property_tax'
const LAW_CATEGORY = 'property_tax'
const SOURCE_DATE = '2026-06-14'
const EFFECTIVE_YEAR = 2026
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) GAM-statute-ingest/1.0'
const BASE = 'https://code.wvlegislature.gov'

// Four code articles spanning the five property-tax feature-chapter groups.
const ARTICLES = ['11-3', '11A-1', '11A-2', '11A-3']

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
    .replace(/&sect;/gi, '§')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&#8217;/g, '’')
    .replace(/&#8216;/g, '‘')
    .replace(/&#8220;/g, '“')
    .replace(/&#8221;/g, '”')
    .replace(/&#8211;/g, '–')
    .replace(/&#8212;/g, '—')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&#160;/g, ' ')
    .replace(/&rsquo;/gi, '’')
    .replace(/&lsquo;/gi, '‘')
    .replace(/&ldquo;/gi, '“')
    .replace(/&rdquo;/gi, '”')
    .replace(/&mdash;/gi, '—')
    .replace(/&ndash;/gi, '–')
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
}

/** Strip tags → plain text. Block-level tags become paragraph breaks. */
function blockText(htmlFrag: string): string {
  const withBreaks = htmlFrag
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/td>/gi, ' ')
    .replace(/<[^>]+>/g, '')
  return decodeEntities(withBreaks)
    .split('\n')
    .map((l) => l.replace(/[ \t]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
    .trim()
}

/**
 * Enumerate every section href for one article index page, restricted to that
 * article. Returns the UPPERCASED path suffix (as the site serves it) so the
 * section URL resolves; the canonical lowercase number is derived at parse time
 * from the <h4>.
 */
function enumerateSections(art: string, indexHtml: string): string[] {
  const re = new RegExp(`href='/(${escapeRe(art)}-[0-9A-Za-z]+)/'`, 'gi')
  const seen = new Set<string>()
  const out: string[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(indexHtml)) !== null) {
    const path = m[1] // e.g. 11-3-1A
    const key = path.toUpperCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(path)
  }
  return out
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Extract the balanced inner HTML of the first <div class='sectiontext ...'>
 * container on a section page. Returns null if not present.
 */
function sectionTextInner(html: string): string | null {
  const open = /<div\s+class='sectiontext[^']*'>/i.exec(html)
  if (!open) return null
  const start = open.index + open[0].length
  const seg = html.slice(start)
  let depth = 1
  const tagRe = /<div\b[^>]*>|<\/div>/gi
  let m: RegExpExecArray | null
  while ((m = tagRe.exec(seg)) !== null) {
    if (m[0].toLowerCase().startsWith('</div')) {
      depth--
      if (depth === 0) return seg.slice(0, m.index)
    } else {
      depth++
    }
  }
  return null
}

/**
 * Parse a section page. h4 = "§{art}-{sec}. {catchline}"; body = the block text
 * of everything after the </h4> inside the sectiontext div. Drops
 * repealed/reserved/short bodies.
 */
function parseSection(html: string): Parsed | null {
  const inner = sectionTextInner(html)
  if (!inner) return null

  const h4 = /<h4[^>]*>([\s\S]*?)<\/h4>/i.exec(inner)
  if (!h4) return null
  const heading = decodeEntities(h4[1].replace(/<[^>]+>/g, '')).trim()

  // heading: "§11-3-1. Time and basis of assessments; ..."
  const hm = /^§?\s*([0-9]+[A-Za-z]?-[0-9]+-[0-9A-Za-z]+)\.?\s*([\s\S]*)$/.exec(
    heading
  )
  if (!hm) return null
  const number = hm[1].toLowerCase()
  let title: string | null = hm[2].trim().replace(/\.\s*$/, '')
  if (!title) title = null
  if (title && /^repealed\b/i.test(title)) return null
  if (title && /^\[?reserved\.?\]?$/i.test(title)) return null

  const bodyHtml = inner.slice(h4.index + h4[0].length)
  const body = blockText(bodyHtml)
  if (!body || body.length < 20) return null
  // Repealed/reserved sections render as a "Repealed." catchline-or-body line
  // followed only by a short "Acts, YYYY ... Ch. NN." history-note citation —
  // no codified text. Drop when the body LEADS with repealed/reserved (the
  // <20-char guard alone misses these because the acts note pads the length).
  if (/^\[?\s*(repealed|reserved)\b/i.test(body)) return null
  if (title && /^\[?\s*(repealed|reserved)\b/i.test(title)) return null

  return { number, title, text: body }
}

async function ingestArticle(art: string): Promise<{
  inserted: number
  skipped: number
  total: number
}> {
  const indexHtml = curl(`${BASE}/${art}/`)
  const sections = enumerateSections(art, indexHtml)
  console.log(`[${art}] enumerated ${sections.length} sections`)

  let inserted = 0
  let skipped = 0
  const CONC = 4
  for (let i = 0; i < sections.length; i += CONC) {
    if (i > 0) await new Promise((r) => setTimeout(r, 250)) // politeness
    const batch = sections.slice(i, i + CONC)
    const parsed = await Promise.all(
      batch.map(async (path) => {
        try {
          return { p: parseSection(curl(`${BASE}/${path}/`)), path }
        } catch (e: any) {
          console.warn(`  ! ${path}: ${e?.message || e}`)
          return { p: null, path }
        }
      })
    )
    for (const { p, path } of parsed) {
      if (!p) {
        skipped++
        continue
      }
      await query(
        `INSERT INTO state_law_section_texts
           (state_code, act_key, section_number, section_title, full_text, source_url, source_date, effective_year, law_category)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (state_code, act_key, section_number, effective_year) DO NOTHING`,
        [
          STATE,
          ACT_KEY,
          p.number,
          p.title,
          p.text,
          `${BASE}/${path}/`,
          SOURCE_DATE,
          EFFECTIVE_YEAR,
          LAW_CATEGORY,
        ]
      )
      inserted++
    }
    process.stdout.write(
      `\r  [${art}] ${Math.min(i + CONC, sections.length)}/${sections.length}`
    )
  }
  console.log(
    `\n  [${art}] processed=${inserted}, dropped=${skipped} of ${sections.length}`
  )
  return { inserted, skipped, total: sections.length }
}

async function main() {
  console.log(
    `\n=== WV — ingesting property-tax full-text corpus (as of ${SOURCE_DATE}) ===`
  )
  let grandInserted = 0
  for (const art of ARTICLES) {
    const r = await ingestArticle(art)
    grandInserted += r.inserted
  }

  const rows = await query<{ count: string }>(
    `SELECT count(*)::text AS count FROM state_law_section_texts
       WHERE state_code=$1 AND law_category=$2 AND act_key=$3`,
    [STATE, LAW_CATEGORY, ACT_KEY]
  )
  console.log(
    `\nWV property_tax done. attempted-inserts=${grandInserted}; distinct DB rows now=${rows[0].count}`
  )
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
