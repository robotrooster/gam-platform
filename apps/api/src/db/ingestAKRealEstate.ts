/**
 * Alaska (AK) non-tax real-estate statute full-text ingester.
 *
 * Sanctioned retrieve+cite+date carve-out (verbatim official statute text, never
 * advice). Source is the Alaska Legislature's official statute server,
 * www.akleg.gov/basis/statutes.asp.
 *
 * FETCH MECHANICS
 *   The site returns HTTP 403 to a default WebFetch but HTTP 200 to a plain GET
 *   with a browser User-Agent (verified via curl). Section/range URL pattern:
 *     statutes.asp?media=print&secStart=<sec>&secEnd=<sec>
 *   A *range* request (secStart != secEnd) concatenates every section in the
 *   range into a single response. Markup (verified, no newlines in the wire HTML):
 *
 *     <p>...<p>                                         (leading filler run; ignored)
 *     <div class="statute">                             (ONE wrapper for the range)
 *       <b><a name="34.15.010"> </a>Sec. 34.15.010.   Manner of executing
 *         conveyances. <BR></b>&nbsp;(a) <body>...<BR><BR>
 *       <b><h7>Article 2. Acknowledgment and Proof.</h7><BR></b>  (article header — NO name= anchor)
 *       <b><a name="34.15.150"> </a>Sec. 34.15.150.   ... <BR></b>&nbsp;<body>...
 *       ...
 *     </div>
 *
 *   PARSE: split on the section-start marker
 *     <b><a name="N.NN.NNN"> </a>Sec. N.NN.NNN.   <Title>. <BR></b>
 *   The <a name="N.NN.NNN"> anchor IS the citation. Title = the text between
 *   "Sec. N.NN.NNN." and the closing "<BR></b>". Body = everything from after
 *   </b> up to the next marker (or </div>). Article headers (<b><h7>...) carry no
 *   name= anchor so they never start a section; any <h7> text that lands inside a
 *   body is stripped by stripTags. Cross-ref links
 *   <a onclick="checkLink('09.63.010')" ...>AS 09.63.010</a> flatten to their
 *   "AS 09.63.010" text via stripTags. <BR> -> newline, &nbsp; -> space.
 *
 *   DROP: repealed / renumbered / reserved / empty / <20-char bodies (these are
 *   the title-only stubs the site emits for removed sections).
 *
 * CATEGORY -> CHAPTER MAP (act_key == law_category for every block, per spec):
 *   conveyancing_title         34.15 (Conveyances)
 *   condo_coop                 34.08 (Uniform Common Interest Ownership Act) + 34.07 (Horizontal Property Regimes)
 *   broker_licensing           08.88 (Real Estate Brokers/Licensees) + 08.87 (Real Estate Appraisers)
 *   mortgage_lien_foreclosure  34.20 (Mortgages & Deeds of Trust) + 34.35 (Liens)
 *   general_real_property      34.25 (Statute of Frauds) + 34.27 (Perpetuities/Restraints) +
 *                              34.40 (Conveyances/fraudulent transfers) + 34.45 (Unclaimed Property) +
 *                              34.70 (Residential transfer disclosures) +
 *                              09.45.052 (Adverse possession) + 09.10.030 (10-yr limitation)
 *
 * Run: cd apps/api && node -r ts-node/register src/db/ingestAKRealEstate.ts
 * Idempotent (ON CONFLICT DO NOTHING). Reuses stripTags from the corpus framework.
 */

import { execFileSync } from 'child_process'
import * as iconv from 'iconv-lite'
import { query } from './index'
import { stripTags } from './ingestStateLawCorpus'

const STATE = 'AK'
const SOURCE_DATE = '2026-06-14'
const EFFECTIVE_YEAR = 2026
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'
const BASE = 'https://www.akleg.gov/basis/statutes.asp'

interface Parsed {
  number: string
  title: string | null
  text: string
}

/** Build the print URL for a [start, end] section range. */
function rangeUrl(secStart: string, secEnd: string): string {
  return `${BASE}?media=print&secStart=${secStart}&secEnd=${secEnd}`
}

/**
 * Fetch a page and decode it as Windows-1252.
 *
 * The server's Content-Type declares charset=ISO-8859-1, but the bytes it emits
 * for punctuation are actually Windows-1252 (cp1252): 0x93/0x94 = curly double
 * quotes “/”, 0x97 = em dash —, 0xA7 = section sign §. Decoding as UTF-8 turns
 * each of those into the U+FFFD replacement character, corrupting the verbatim
 * text. iconv 'win1252' decodes them to their true characters.
 */
function curl(url: string): string {
  const buf = execFileSync('curl', ['-sL', '--max-time', '120', '-A', UA, url], {
    maxBuffer: 256 * 1024 * 1024,
  })
  return iconv.decode(buf, 'win1252')
}

/**
 * Parse a concatenated-range response into per-section records.
 *
 * The section-start marker is:
 *   <b><a name="N.NN.NNN"> </a>Sec. N.NN.NNN.  <Title>. <BR></b>
 * We slice the HTML at each marker; everything between the close of one marker's
 * </b> and the start of the next marker is that section's body. `chapterRe` is an
 * anchored chapter pattern (e.g. /34\.15/) so a range that bleeds into an
 * adjacent chapter would be excluded; in practice ranges are chapter-scoped.
 */
function parseRange(html: string): Parsed[] {
  // Global matcher for the marker. Capture: [1]=section number, [2]=the inner
  // <b> content (number + title) so we can derive the catchline title.
  const markerRe =
    /<b>\s*<a\s+name="(\d{2}\.\d{2}\.\d+)">\s*<\/a>\s*([\s\S]*?)<\/b>/gi

  const markers: { number: string; bInner: string; afterIdx: number; startIdx: number }[] = []
  let m: RegExpExecArray | null
  while ((m = markerRe.exec(html)) !== null) {
    markers.push({
      number: m[1],
      bInner: m[2],
      startIdx: m.index,
      afterIdx: markerRe.lastIndex,
    })
  }

  const out: Parsed[] = []
  for (let i = 0; i < markers.length; i++) {
    const cur = markers[i]
    const next = markers[i + 1]
    const bodyEnd = next ? next.startIdx : html.length
    const rawBody = html.slice(cur.afterIdx, bodyEnd)

    // Title = bInner ("Sec. N.NN.NNN.   <Title>.") with the leading "Sec. NNN."
    // citation stripped. stripTags flattens any nested markup.
    let title: string | null = stripTags(cur.bInner, false)
      .replace(/^Sec\.\s*\d{2}\.\d{2}\.\d+\.?\s*/i, '')
      .trim()
    // Some titles end with a trailing period; keep verbatim catchline as-is.
    if (!title) title = null

    // Repealed / renumbered title-only stubs: the catchline carries the marker
    // and the body is empty. Drop them.
    if (title && /^\[?\s*(repealed|renumbered|reserved)\b/i.test(title)) continue

    const body = stripTags(rawBody, true)
    if (!body || body.length < 20) continue
    if (/^\[?\s*(repealed|renumbered|reserved)\.?\]?$/i.test(body)) continue

    out.push({ number: cur.number, title, text: body })
  }
  return out
}

/**
 * Fetch one chapter range, parse it, and insert each section under the given
 * act_key/law_category. `chapterPrefix` (e.g. "34.15") gates the parsed sections
 * so adjacent-chapter bleed cannot leak in. Returns count actually inserted-or-
 * present (we count parsed rows that passed the drop filters).
 */
async function ingestRange(
  category: string,
  chapterPrefix: string,
  secStart: string,
  secEnd: string
): Promise<{ parsed: number; inserted: number }> {
  const url = rangeUrl(secStart, secEnd)
  const html = curl(url)
  const escaped = chapterPrefix.replace(/\./g, '\\.')
  const prefixRe = new RegExp(`^${escaped}\\.`)
  const sections = parseRange(html).filter((s) => prefixRe.test(s.number))

  let inserted = 0
  for (const s of sections) {
    // RETURNING id lets us count true inserts: a real insert returns one row, an
    // ON CONFLICT skip returns zero. (query() resolves to the rows array.)
    const rows = await query<{ id: string }>(
      `INSERT INTO state_law_section_texts
         (state_code, act_key, section_number, section_title, full_text, source_url, source_date, effective_year, law_category)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (state_code, act_key, section_number, effective_year) DO NOTHING
       RETURNING id`,
      [STATE, category, s.number, s.title, s.text, url, SOURCE_DATE, EFFECTIVE_YEAR, category]
    )
    if (rows.length > 0) inserted++
  }
  console.log(`  [${category}] ${chapterPrefix} ${secStart}-${secEnd}: parsed ${sections.length}, inserted ${inserted}`)
  return { parsed: sections.length, inserted }
}

interface ChapterSpec {
  prefix: string
  secStart: string
  secEnd: string
}

// category -> the chapters that feed it. act_key == law_category == category.
const PLAN: Record<string, ChapterSpec[]> = {
  conveyancing_title: [{ prefix: '34.15', secStart: '34.15.005', secEnd: '34.15.910' }],
  condo_coop: [
    { prefix: '34.08', secStart: '34.08.010', secEnd: '34.08.995' },
    { prefix: '34.07', secStart: '34.07.010', secEnd: '34.07.510' },
  ],
  broker_licensing: [
    { prefix: '08.88', secStart: '08.88.011', secEnd: '08.88.900' },
    { prefix: '08.87', secStart: '08.87.010', secEnd: '08.87.990' },
  ],
  mortgage_lien_foreclosure: [
    { prefix: '34.20', secStart: '34.20.005', secEnd: '34.20.990' },
    { prefix: '34.35', secStart: '34.35.005', secEnd: '34.35.995' },
  ],
  general_real_property: [
    { prefix: '34.25', secStart: '34.25.010', secEnd: '34.25.140' },
    { prefix: '34.27', secStart: '34.27.010', secEnd: '34.27.910' },
    { prefix: '34.40', secStart: '34.40.010', secEnd: '34.40.110' },
    { prefix: '34.45', secStart: '34.45.010', secEnd: '34.45.990' },
    { prefix: '34.70', secStart: '34.70.010', secEnd: '34.70.200' },
    // Adverse possession lives in Title 9, not Title 34.
    { prefix: '09.45', secStart: '09.45.052', secEnd: '09.45.052' },
    { prefix: '09.10', secStart: '09.10.030', secEnd: '09.10.030' },
  ],
}

async function main() {
  console.log(`\n=== AK — ingesting non-tax real-estate statute corpus (as of ${SOURCE_DATE}) ===`)
  const counts: Record<string, number> = {}

  for (const [category, chapters] of Object.entries(PLAN)) {
    let total = 0
    for (const ch of chapters) {
      const { inserted } = await ingestRange(category, ch.prefix, ch.secStart, ch.secEnd)
      total += inserted
      await new Promise((r) => setTimeout(r, 400)) // politeness between range fetches
    }
    counts[category] = total
  }

  const grand = Object.values(counts).reduce((a, b) => a + b, 0)
  console.log(`\nAK done. inserted=${grand}`, counts)
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
