/**
 * Maryland property-tax statute full-text ingester (sanctioned retrieve+cite+date
 * carve-out: verbatim codified text only, never advice).
 *
 * SOURCE (official only): mgaleg.maryland.gov — the Maryland General Assembly's
 * codified-statute viewer for the Annotated Code of Maryland, Tax - Property
 * Article (article code "gtp"). Served as server-rendered HTML over raw HTTP
 * (no JS shell), so a plain curl + parse is sufficient. No Justia / Lexis /
 * Wayback.
 *
 * PAGE LAYOUT (per section):
 *   GET .../laws/StatuteText?article=gtp&section=<N>   (N = hyphen form, e.g. 7-202)
 *   The section body lives inside  <div id="StatuteText"> ... </div>, wrapped in
 *   an inner <html> ... </html>. Inside that:
 *     "Article - Tax - Property"   header line                     (chrome, dropped)
 *     "Previous Next"              nav button text (lead + trail)   (chrome, dropped)
 *     "§7–202."                    the catchline / section header   (parsed for #)
 *     (a) ... (1) ... (i) ...      nested verbatim subsection prose (KEPT verbatim)
 *   Section numbers internally use an en-dash (U+2013) e.g. "§7–202."; the URL
 *   and our stored section_number use the ASCII hyphen "7-202".
 *
 * SECTION ENUMERATION: the site exposes an ordered-walk API,
 *   GET .../api/Laws/GetNext?articleCode=gtp&sectionCode=<N>&enactments=False
 *   → returns the next section number (JSON string) or "" at the article end.
 * We walk forward from each topic's start anchor, keeping sections whose number
 * matches the topic predicate, and stop the first time the walk leaves the topic
 * (GetNext is strictly increasing through the article, so first-miss == done).
 * This naturally handles letter/decimal-suffixed sections (7-204.1, 8-103.1) and
 * gaps without us having to hardcode every section number.
 *
 * TITLE -> TOPIC MAP (recipe-confirmed):
 *   exemptions             = Title 7  (Property Tax Exemptions)
 *   assessment             = Title 2  (SDAT duties) + Title 8 (Valuation & Assessment)
 *   assessment_review      = Title 3  (Assessment Appeal Boards) + Title 14 Subtitle 5
 *                            (Property Tax Appeals: Dept -> PTAAB -> Md Tax Court)
 *   levy_collection_payment= Title 10 (Payment of Property Tax) + Title 14 Subtitle 6
 *                            (interest/overdue) + Subtitle 7 (collection)
 *   delinquency_tax_sale   = Title 14 Subtitle 8 (Tax Sales — lien, redemption, foreclosure)
 *
 * All rows: act_key='property_tax', law_category='property_tax',
 * source_date='2026-06-14', effective_year=2026. Idempotent (ON CONFLICT DO NOTHING).
 * Repealed/reserved/empty (<20 char) bodies are dropped.
 *
 * Run: cd apps/api && node -r ts-node/register src/db/ingestMDPropertyTax.ts
 */

import { execFileSync } from 'child_process'
import { query } from './index'

const STATE = 'MD'
const ACT_KEY = 'property_tax'
const LAW_CATEGORY = 'property_tax'
const SOURCE_DATE = '2026-06-14'
const EFFECTIVE_YEAR = 2026
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) GAM-statute-ingest/1.0'
const BASE = 'https://mgaleg.maryland.gov/mgawebsite'
const ARTICLE = 'gtp'

const pageUrl = (section: string) =>
  `${BASE}/laws/StatuteText?article=${ARTICLE}&section=${section}`
const nextApi = (section: string) =>
  `${BASE}/api/Laws/GetNext?articleCode=${ARTICLE}&sectionCode=${encodeURIComponent(
    section
  )}&enactments=False`

interface Parsed {
  number: string
  title: string | null
  text: string
}

function curl(url: string): string {
  const buf = execFileSync('curl', ['-sL', '--max-time', '60', '-A', UA, url], {
    maxBuffer: 64 * 1024 * 1024,
  })
  return buf.toString('utf-8')
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  sect: '§',
  para: '¶',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  hellip: '…',
  deg: '°',
  frac12: '½',
  frac14: '¼',
  frac34: '¾',
}

function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&([a-zA-Z][a-zA-Z0-9]*);/g, (m, name) =>
      name in ENTITIES ? ENTITIES[name] : m
    )
}

/**
 * Pull the verbatim statute body out of one StatuteText page. Bounds the body
 * to the inner <html>...</html> wrapper inside <div id="StatuteText">, converts
 * <br> to newlines, strips remaining tags, decodes entities, then removes the
 * page chrome ("Article - Tax - Property" header + "Previous"/"Next" nav). The
 * catchline (e.g. "§7–202.") becomes the section header we parse the number/
 * title from; everything after it is the verbatim subsection prose.
 */
function parsePage(html: string, expectedNumber: string): Parsed | null {
  const i = html.indexOf('id="StatuteText"')
  if (i === -1) return null
  // Bound to the script-free region of the container, then the inner <html> wrapper.
  const scriptAt = html.indexOf('<script', i)
  const region = html.slice(i, scriptAt === -1 ? undefined : scriptAt)
  const h0 = region.indexOf('<html>')
  const h1 = region.indexOf('</html>')
  if (h0 === -1 || h1 === -1 || h1 <= h0) return null
  let inner = region.slice(h0 + '<html>'.length, h1)

  // <br> -> newline; close-block tags -> newline; drop remaining tags.
  inner = inner
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
  let text = decodeEntities(inner)
  text = text
    .replace(/ /g, ' ')
    .replace(/\r/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

  // Split into lines, drop chrome lines.
  const lines = text.split('\n')
  const cleaned: string[] = []
  for (const raw of lines) {
    const ln = raw.trim()
    if (!ln) {
      cleaned.push('')
      continue
    }
    if (/^Article\s*-\s*Tax\s*-\s*Property$/i.test(ln)) continue
    if (/^Previous\s*Next$/i.test(ln)) continue
    if (/^(Previous|Next)$/i.test(ln)) continue
    cleaned.push(ln)
  }

  // Find the catchline: a line beginning with § (the section header).
  let catchIdx = -1
  for (let j = 0; j < cleaned.length; j++) {
    if (/^§/.test(cleaned[j])) {
      catchIdx = j
      break
    }
  }
  if (catchIdx === -1) return null

  const catchline = cleaned[catchIdx].trim()
  // Title = catchline minus the "§N–NNN." citation. MD catchlines for these
  // titles are usually just the citation (the descriptive heading lives in the
  // subtitle index, not the section body), so title is frequently null — fine.
  let title: string | null = catchline
    .replace(/^§\s*[0-9A-Za-z.–-]+\.?\s*/, '')
    .trim()
  if (!title) title = null
  if (title && /^repealed\b/i.test(title)) return null
  if (title && /^\[?reserved\.?\]?$/i.test(title)) return null

  // Body = everything after the catchline, re-joined, collapsing blank runs.
  const body = cleaned
    .slice(catchIdx + 1)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

  if (!body || body.length < 20) return null
  if (/^\[?reserved\.?\]?$/i.test(body)) return null
  if (/^repealed\b/i.test(body)) return null

  return { number: expectedNumber, title, text: body }
}

/** GetNext — returns the next section number, or null at article end / error. */
function getNext(section: string): string | null {
  try {
    const raw = curl(nextApi(section)).trim()
    const val = raw.replace(/^"|"$/g, '').trim()
    return val || null
  } catch {
    return null
  }
}

interface Topic {
  actKeyTopic: string // used for logging only; DB act_key is always 'property_tax'
  starts: string[] // start anchors (one per title/subtitle block)
  /** predicate: is this section in the topic? */
  match: (sec: string) => boolean
}

/** parse "14-602" -> { title: 14, sub: 6 (hundreds digit of the section number) } */
function parts(sec: string): { title: number; secNum: number; hundreds: number } {
  const [t, rest] = sec.split('-')
  const title = parseInt(t, 10)
  const secNum = parseFloat(rest) // tolerant of "602", "602.1", "204.1"
  const hundreds = Math.floor(secNum / 100)
  return { title, secNum, hundreds }
}

const TOPICS: Topic[] = [
  {
    actKeyTopic: 'exemptions',
    starts: ['7-101'],
    match: (s) => parts(s).title === 7,
  },
  {
    actKeyTopic: 'assessment',
    starts: ['2-101', '8-101'],
    match: (s) => {
      const t = parts(s).title
      return t === 2 || t === 8
    },
  },
  {
    actKeyTopic: 'assessment_review',
    starts: ['3-101', '14-501'],
    match: (s) => {
      const { title, hundreds } = parts(s)
      return title === 3 || (title === 14 && hundreds === 5)
    },
  },
  {
    actKeyTopic: 'levy_collection_payment',
    starts: ['10-101', '14-601'],
    match: (s) => {
      const { title, hundreds } = parts(s)
      return title === 10 || (title === 14 && (hundreds === 6 || hundreds === 7))
    },
  },
  {
    actKeyTopic: 'delinquency_tax_sale',
    starts: ['14-801'],
    match: (s) => {
      const { title, hundreds } = parts(s)
      return title === 14 && hundreds === 8
    },
  },
]

/**
 * Walk GetNext from each start anchor, collecting section numbers that satisfy
 * the topic predicate. Stop a given walk the first time it leaves the topic
 * (GetNext is strictly increasing within the article). De-dupe across anchors.
 */
function enumerateTopic(topic: Topic): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const start of topic.starts) {
    let cur: string | null = start
    let guard = 0
    while (cur && guard++ < 2000) {
      if (topic.match(cur)) {
        if (!seen.has(cur)) {
          seen.add(cur)
          out.push(cur)
        }
      } else {
        // left the topic block — but only stop if we've already entered it,
        // so a start anchor that itself doesn't match can't happen here (all
        // our anchors match). Safe to stop on first miss.
        break
      }
      cur = getNext(cur)
    }
  }
  out.sort((a, b) => {
    const pa = parts(a)
    const pb = parts(b)
    return pa.title - pb.title || pa.secNum - pb.secNum
  })
  return out
}

async function ingestTopic(topic: Topic): Promise<{ inserted: number; fetched: number }> {
  const secs = enumerateTopic(topic)
  console.log(`\n[${topic.actKeyTopic}] enumerated ${secs.length} sections`)
  let inserted = 0
  let skipped = 0
  for (let idx = 0; idx < secs.length; idx++) {
    const sec = secs[idx]
    let parsed: Parsed | null = null
    try {
      parsed = parsePage(curl(pageUrl(sec)), sec)
    } catch (e: any) {
      console.warn(`\n  ! ${topic.actKeyTopic} ${sec}: ${e?.message || e}`)
    }
    if (!parsed || !parsed.text || parsed.text.length < 20) {
      skipped++
    } else {
      await query(
        `INSERT INTO state_law_section_texts
           (state_code, act_key, section_number, section_title, full_text,
            source_url, source_date, effective_year, law_category)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (state_code, act_key, section_number, effective_year) DO NOTHING`,
        [
          STATE,
          ACT_KEY,
          parsed.number,
          parsed.title,
          parsed.text,
          pageUrl(sec),
          SOURCE_DATE,
          EFFECTIVE_YEAR,
          LAW_CATEGORY,
        ]
      )
      inserted++
    }
    if ((idx + 1) % 10 === 0 || idx === secs.length - 1) {
      process.stdout.write(`\r  [${topic.actKeyTopic}] ${idx + 1}/${secs.length}`)
    }
    await new Promise((r) => setTimeout(r, 120)) // politeness
  }
  console.log(
    `\n  [${topic.actKeyTopic}] inserted ${inserted}, skipped ${skipped} of ${secs.length}`
  )
  return { inserted, fetched: secs.length }
}

async function main() {
  console.log(`\n=== MD — ingesting property-tax full-text corpus (as of ${SOURCE_DATE}) ===`)
  const summary: Record<string, { inserted: number; fetched: number }> = {}
  for (const topic of TOPICS) {
    summary[topic.actKeyTopic] = await ingestTopic(topic)
  }
  const total = Object.values(summary).reduce((a, b) => a + b.inserted, 0)
  console.log('\nMD property_tax done. inserted (this run) =', total)
  console.table(summary)
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
