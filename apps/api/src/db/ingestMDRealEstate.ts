/**
 * Maryland (MD) non-tax real-estate statute full-text ingester.
 *
 * Sanctioned retrieve+cite+date carve-out: we store the VERBATIM official
 * statutory text so the agent can quote + cite + date it for both-party
 * compliance hedging. GAM never advises; posture is identical to the AZ/NV/LA
 * corpora (see services/stateLaw.ts + the migration headers).
 *
 * SOURCE — Maryland General Assembly official site (mgaleg.maryland.gov).
 * Every section has a server-rendered raw-HTML page:
 *   https://mgaleg.maryland.gov/mgawebsite/Laws/StatuteText?article=<ART>&section=<SEC>
 *   article codes used here:
 *     grp = Real Property
 *     gbo = Business Occupations and Professions
 *     gca = Corporations and Associations   (NOTE: the recipe's "gco" is wrong;
 *           the live article code for Corps & Assns is "gca" — verified at run
 *           design time against §5-6B-01 cooperative-housing-corporation text)
 * Inside the page, div#StatuteText holds an inner <html>…</html> fragment:
 *   <div style="text-align:center"><span style="font-weight:bold">Article - …</span></div>
 *   <div class="row">…Previous / Next nav buttons…</div>
 *   &sect;2&ndash;101.<br><br>          <- the section number (en-dash, not hyphen)
 *   <body paragraphs, &nbsp;-indented, (a)(1)(i) substructure>
 *   <div class="row">…Previous / Next nav…</div>   <- trailing nav, dropped
 * These MD Real Property / B.O.&P. sections carry NO inline catchline/title in
 * this rendering — the page opens straight into the body after the §-number — so
 * section_title is null for essentially all rows (honest: not a parse miss).
 *
 * ENUMERATION — crawl by following the page's own "Next" link, which the site
 * resolves through a JSON endpoint:
 *   https://mgaleg.maryland.gov/mgawebsite/api/Laws/GetNext?articleCode=<ART>&sectionCode=<SEC>&enactments=False
 *   -> returns the next section id as a quoted string (e.g. "2-102"), or "" at a
 *      title gap. GetNext chains across titles (1-104 -> 2-101, 11-143 -> 11A-101),
 *      so we BOUND each crawl by title key: stop as soon as Next leaves the
 *      title(s) assigned to the category (or returns empty). Dotted ids (7-105.1)
 *      and lettered titles (11B-104) are valid section params and chain natively.
 *
 * CATEGORY -> (article, title-set) MAP — law_category == act_key for every block:
 *   conveyancing_title        grp Titles 1,2,3,4,5
 *   condo_coop                grp Title 11 (Condominium Act) + Title 11B (HOA Act)
 *                             + gca Subtitle 5-6B (Cooperative Housing Corporations)
 *   broker_licensing          gbo Title 17 (Real Estate Brokers) + Title 16
 *                             (Appraisers / AMCs / Home Inspectors)
 *   mortgage_lien_foreclosure grp Title 7 (Mortgages/Deeds of Trust/Foreclosure)
 *                             + Title 9 (Statutory Liens — mechanics'/construction)
 *   general_real_property     grp Title 6 (Estates) + Title 8 (Landlord & Tenant)
 *                             + Title 14 (Miscellaneous Rules)
 *
 * Repealed / reserved / empty (<20 char) / nav-only pages are dropped.
 * Run:  cd apps/api && node -r ts-node/register src/db/ingestMDRealEstate.ts
 * Idempotent (ON CONFLICT DO NOTHING).
 */

import { execFileSync } from 'child_process'
import { query } from './index'

const STATE = 'MD'
const SOURCE_DATE = '2026-06-14'
const EFFECTIVE_YEAR = 2026
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'
const BASE = 'https://mgaleg.maryland.gov/mgawebsite'

const textUrl = (article: string, section: string) =>
  `${BASE}/Laws/StatuteText?article=${article}&section=${section}`
const nextUrl = (article: string, section: string) =>
  `${BASE}/api/Laws/GetNext?articleCode=${article}&sectionCode=${encodeURIComponent(
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

/**
 * Decode the entity set MD uses, preserving verbatim glyphs:
 *   &sect;=§  &ndash;=–  &ldquo;/&rdquo;=“/”  &lsquo;/&rsquo;=‘/’  &mdash;=—
 *   &nbsp; -> regular space  + numeric refs + the common named refs.
 */
function decode(s: string): string {
  return s
    .replace(/&sect;/gi, '§')
    .replace(/&ndash;/gi, '–')
    .replace(/&mdash;/gi, '—')
    .replace(/&ldquo;/gi, '“')
    .replace(/&rdquo;/gi, '”')
    .replace(/&lsquo;/gi, '‘')
    .replace(/&rsquo;/gi, '’')
    .replace(/&hellip;/gi, '…')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
}

/** <br> -> newline; drop all other tags; decode entities; tidy whitespace. */
function htmlToText(html: string): string {
  let s = html
  s = s.replace(/<br\s*\/?>/gi, '\n')
  s = s.replace(/<\/(p|div|li)>/gi, '\n')
  s = s.replace(/<[^>]+>/g, '')
  s = decode(s)
  s = s
    .replace(/[      ]/g, ' ')
    .replace(/\r/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
  return s.trim()
}

/**
 * Parse one StatuteText page. Isolate div#StatuteText's inner <html> fragment,
 * cut the leading/trailing nav (Previous/Next button rows) and the centered
 * "Article - …" header, then read the §-number line and the body that follows.
 */
function parsePage(html: string, expected: string): Parsed | null {
  const open = html.indexOf('<div id="StatuteText">')
  if (open === -1) return null
  // The content lives in an inner <html>…</html>; "File Not Found" pages have no <html>.
  const innerStart = html.indexOf('<html>', open)
  if (innerStart === -1) return null
  const innerEnd = html.indexOf('</html>', innerStart)
  if (innerEnd === -1) return null
  let frag = html.slice(innerStart + '<html>'.length, innerEnd)

  // Drop the centered article header and BOTH nav button rows (they bracket body).
  frag = frag.replace(/<div style="text-align:\s*center;?">[\s\S]*?<\/div>/i, '')
  frag = frag.replace(/<div class="row">[\s\S]*?<\/div>\s*<\/div>\s*<\/div>/gi, '')
  // Defensive: any residual "Previous"/"Next" button row.
  frag = frag.replace(/<div class="row">[\s\S]*?<\/div>/gi, (m) =>
    /sub-navbar-button/i.test(m) ? '' : m
  )

  const text = htmlToText(frag).trim()
  if (!text) return null

  // First line should be the §-number ("§2–101."). Split it off from the body.
  const lines = text.split('\n').map((l) => l.trim())
  let numIdx = lines.findIndex((l) => /^§/.test(l))
  if (numIdx === -1) {
    // No §-number present (some pages render number on same line as nothing else).
    return null
  }
  // The §-line; strip the leading § and trailing period to derive section number
  // for display, but we use the crawl id for storage (canonical hyphen form).
  const body = lines
    .slice(numIdx + 1)
    .join('\n')
    .trim()

  if (!body || body.length < 20) return null
  if (/^repealed\b/i.test(body)) return null
  if (/^\[?\s*reserved\.?\s*\]?$/i.test(body)) return null

  return { number: expected, title: null, text: body }
}

/** Next section id via GetNext, or null at a gap / boundary / error. */
function getNext(article: string, section: string): string | null {
  try {
    const raw = curl(nextUrl(article, section)).trim()
    const m = raw.match(/^"?([^"]*)"?$/)
    const next = (m ? m[1] : raw).trim()
    return next || null
  } catch {
    return null
  }
}

/** Title key for a section id: the segment before the first hyphen. 7-105.1 -> "7", 11B-104 -> "11B". */
function titleKey(section: string): string {
  const i = section.indexOf('-')
  return i === -1 ? section : section.slice(0, i)
}

/**
 * Crawl an article through one title (e.g. grp "7"): start at "<title>-101",
 * insert each parsed section, follow GetNext while it stays in the title, stop
 * at a foreign-title id or empty. `subtitlePrefix` (e.g. "5-6B") overrides the
 * title-key bound for the gca cooperative subtitle, which is keyed by prefix.
 */
async function crawlTitle(
  article: string,
  startSection: string,
  bound: (sec: string) => boolean,
  actKey: string,
  acc: { ok: number; skipped: number },
  visited: Set<string>
): Promise<void> {
  let sec: string | null = startSection
  let guard = 0
  while (sec && guard < 2000) {
    guard++
    // Bound check FIRST: GetNext chains across title boundaries (e.g. 4-110 ->
    // 5-101), so we must stop — WITHOUT recording the foreign id in `visited` —
    // before a sibling title's anchor gets poisoned and its own crawl no-ops.
    if (!bound(sec)) break
    if (visited.has(`${article}|${sec}`)) break
    visited.add(`${article}|${sec}`)

    let parsed: Parsed | null = null
    try {
      parsed = parsePage(curl(textUrl(article, sec)), sec)
    } catch (e: any) {
      console.warn(`  ! ${actKey} ${article}/${sec}: ${e?.message || e}`)
    }
    if (parsed && parsed.text.length >= 20) {
      await query(
        `INSERT INTO state_law_section_texts
           (state_code, act_key, section_number, section_title, full_text,
            source_url, source_date, effective_year, law_category)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (state_code, act_key, section_number, effective_year) DO NOTHING`,
        [
          STATE,
          actKey,
          parsed.number,
          parsed.title,
          parsed.text,
          textUrl(article, sec),
          SOURCE_DATE,
          EFFECTIVE_YEAR,
          actKey,
        ]
      )
      acc.ok++
    } else {
      acc.skipped++
    }

    const next: string | null = getNext(article, sec)
    if (!next) break
    // Politeness pause.
    await new Promise((r) => setTimeout(r, 120))
    sec = next
  }
}

interface CrawlSpec {
  article: string
  start: string
  bound: (sec: string) => boolean
  label: string
}

/** One category may span several (article, title) crawl specs. */
async function ingestCategory(actKey: string, specs: CrawlSpec[]): Promise<number> {
  const acc = { ok: 0, skipped: 0 }
  const visited = new Set<string>()
  for (const spec of specs) {
    process.stdout.write(`  [${actKey}] crawling ${spec.label} from ${spec.start} …\n`)
    await crawlTitle(spec.article, spec.start, spec.bound, actKey, acc, visited)
    process.stdout.write(`  [${actKey}] ${spec.label}: ok=${acc.ok} skipped=${acc.skipped}\n`)
  }
  console.log(`  [${actKey}] DONE inserted=${acc.ok} skipped=${acc.skipped}`)
  return acc.ok
}

/** title-key bound factory: keep crawling while titleKey(sec) === key. */
const titleBound = (key: string) => (sec: string) => titleKey(sec) === key
/** prefix bound: keep crawling while sec starts with "<prefix>-". */
const prefixBound = (prefix: string) => (sec: string) => sec.startsWith(`${prefix}-`)

async function main() {
  console.log(`\n=== MD — ingesting non-tax real-estate statute corpus (as of ${SOURCE_DATE}) ===`)
  const counts: Record<string, number> = {}

  // conveyancing_title — grp Titles 1-5
  counts['conveyancing_title'] = await ingestCategory('conveyancing_title', [
    { article: 'grp', start: '1-101', bound: titleBound('1'), label: 'RP Title 1' },
    { article: 'grp', start: '2-101', bound: titleBound('2'), label: 'RP Title 2' },
    { article: 'grp', start: '3-101', bound: titleBound('3'), label: 'RP Title 3' },
    { article: 'grp', start: '4-101', bound: titleBound('4'), label: 'RP Title 4' },
    { article: 'grp', start: '5-101', bound: titleBound('5'), label: 'RP Title 5' },
  ])

  // condo_coop — grp Title 11 + 11B, gca Subtitle 5-6B
  counts['condo_coop'] = await ingestCategory('condo_coop', [
    { article: 'grp', start: '11-101', bound: titleBound('11'), label: 'RP Title 11 (Condominium Act)' },
    { article: 'grp', start: '11B-101', bound: titleBound('11B'), label: 'RP Title 11B (HOA Act)' },
    { article: 'gca', start: '5-6B-01', bound: prefixBound('5-6B'), label: 'Corps&Assns 5-6B (Coop Housing)' },
  ])

  // broker_licensing — gbo Title 17 + 16
  counts['broker_licensing'] = await ingestCategory('broker_licensing', [
    { article: 'gbo', start: '17-101', bound: titleBound('17'), label: 'B.O.&P. Title 17 (Real Estate Brokers)' },
    { article: 'gbo', start: '16-101', bound: titleBound('16'), label: 'B.O.&P. Title 16 (Appraisers/AMC/Home Inspectors)' },
  ])

  // mortgage_lien_foreclosure — grp Title 7 + 9
  counts['mortgage_lien_foreclosure'] = await ingestCategory('mortgage_lien_foreclosure', [
    { article: 'grp', start: '7-101', bound: titleBound('7'), label: 'RP Title 7 (Mortgages/DoT/Foreclosure)' },
    { article: 'grp', start: '9-101', bound: titleBound('9'), label: 'RP Title 9 (Statutory Liens)' },
  ])

  // general_real_property — grp Title 6 + 8 + 14
  counts['general_real_property'] = await ingestCategory('general_real_property', [
    { article: 'grp', start: '6-101', bound: titleBound('6'), label: 'RP Title 6 (Estates)' },
    { article: 'grp', start: '8-101', bound: titleBound('8'), label: 'RP Title 8 (Landlord & Tenant)' },
    { article: 'grp', start: '14-101', bound: titleBound('14'), label: 'RP Title 14 (Miscellaneous Rules)' },
  ])

  const total = Object.values(counts).reduce((a, b) => a + b, 0)
  console.log(`\nMD done. inserted=${total}`, counts)
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
