/**
 * Nevada property-tax statute full-text ingester (sanctioned retrieve+cite+date
 * carve-out — verbatim statutory text only, never advice).
 *
 * SOURCE: NRS Chapter 361 — Property Tax, official Nevada Legislature site
 *   https://www.leg.state.nv.us/NRS/NRS-361.html
 * Single static HTML page over plain HTTPS (no JS, no auth) → raw curl.
 *
 * ENCODING: the page is served as windows-1252 (Microsoft-Word-filtered HTML)
 * and contains stray high bytes (en-space 0x96/&#8194;, em-dash 0x97/&#8212;).
 * We curl raw and iconv WINDOWS-1252 → UTF-8 before parsing, otherwise the
 * bytes corrupt tag matching.
 *
 * PAGE LAYOUT (per section):
 *   <p class="SectBody">... <a name=NRS361SecNNN></a>NRS&#8194;
 *     <span class="Section">361.NNN</span>
 *     <span class="Empty">&#8194;&#8194;</span>
 *     <span class="Leadline">Catchline.</span>
 *     <span class="Empty">&#8194;&#8194;</span> ...body prose...</p>
 *   <p class="SourceNote">  [Part 3:344:1953]—(NRS A 1973, 1114; ...)</p>
 * The <span ...> tags wrap mid-attribute across CRLF, so we collapse ALL
 * whitespace to single spaces before regex segmentation. Sections are
 * delimited by the <a name=NRS361SecNNN></a> body anchors; the trailing
 * SourceNote (bracketed amendment trail) is the closest thing NRS carries to a
 * per-section date, so it is kept inside full_text as the verbatim source note.
 * Retrieval date is stamped at source_date (2026-06-14) per the recipe.
 *
 * SCOPE: the five triage feature-chapter groups all live within Chapter 361 and
 * span sections 361.045 (taxable/exempt property) through 361.730 (delinquency/
 * lien/sale/redemption). We ingest every real section whose number falls in that
 * decimal-fraction range [0.045, 0.730] — this is the union of:
 *   exemptions            361.045 – 361.159
 *   assessment            361.221 – 361.345
 *   assessment_review     361.334 – 361.420
 *   levy_collection_pay   361.445 – 361.560
 *   delinquency_tax_sale  361.5648 – 361.730
 * Lettered sub-sections (361.0687, 361.5648, 361.47285) are compared as the
 * decimal fraction 0.<suffix>, not as integers, so they sort correctly in range.
 *
 * act_key = law_category = 'property_tax'. Repealed/reserved/short (<20 char)
 * bodies are dropped. Idempotent (ON CONFLICT DO NOTHING).
 *
 * Run: cd apps/api && node -r ts-node/register src/db/ingestNVPropertyTax.ts
 */

import { execFileSync } from 'child_process'
import { query } from './index'
import { stripTags } from './ingestStateLawCorpus'

const STATE = 'NV'
const ACT_KEY = 'property_tax'
const LAW_CATEGORY = 'property_tax'
const SOURCE_DATE = '2026-06-14'
const EFFECTIVE_YEAR = 2026
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) GAM-statute-ingest/1.0'
const SOURCE_URL = 'https://www.leg.state.nv.us/NRS/NRS-361.html'

// Union range of the five triage feature-chapter groups, expressed as the
// NRS decimal fraction after "361." (0.045 .. 0.730 inclusive).
const FRAC_LO = 0.045
const FRAC_HI = 0.73

interface Parsed {
  number: string
  title: string | null
  text: string
}

/** Raw fetch then transcode windows-1252 → UTF-8 (NRS pages are Word-filtered). */
function fetchUtf8(url: string): string {
  const raw = execFileSync('curl', ['-sL', '--max-time', '90', '-A', UA, url], {
    maxBuffer: 256 * 1024 * 1024,
  })
  // iconv from the declared windows-1252 charset to UTF-8.
  const utf8 = execFileSync('iconv', ['-f', 'WINDOWS-1252', '-t', 'UTF-8'], {
    input: raw,
    maxBuffer: 256 * 1024 * 1024,
  })
  return utf8.toString('utf-8')
}

/** Section number "361.NNN[suffix]" → its NRS decimal fraction (0.NNNsuffix). */
function frac(number: string): number {
  const after = number.split('.')[1] || ''
  const f = parseFloat('0.' + after)
  return Number.isFinite(f) ? f : NaN
}

/**
 * Segment the (whitespace-collapsed) document on body anchors and parse each
 * section. Returns only in-range, non-repealed sections with real bodies.
 */
function parseSections(html: string): Parsed[] {
  const flat = html.replace(/\s+/g, ' ')
  const re = /<a name=(NRS361Sec[0-9A-Za-z]+)><\/a>([\s\S]*?)(?=<a name=NRS361Sec[0-9A-Za-z]+><\/a>|<\/body>|$)/gi
  const out: Parsed[] = []
  const seen = new Set<string>()
  let m: RegExpExecArray | null
  while ((m = re.exec(flat)) !== null) {
    const block = m[2]
    const numM = block.match(/<span class="Section">([0-9A-Za-z.]+)<\/span>/i)
    if (!numM) continue
    const number = `NRS ${numM[1]}`
    const bareNum = numM[1]

    const f = frac(bareNum)
    if (!(f >= FRAC_LO && f <= FRAC_HI)) continue
    if (seen.has(bareNum)) continue

    const titleM = block.match(/<span class="Leadline">([\s\S]*?)<\/span>/i)
    let title: string | null = titleM ? stripTags(titleM[1], false) : null
    if (title === '') title = null
    if (title && /^repealed\b/i.test(title)) continue
    if (title && /^\[?reserved\.?\]?$/i.test(title)) continue

    // full_text = verbatim "NRS 361.NNN  Catchline.  <body> <source note>".
    const text = stripTags(block).trim()
    if (!text || text.length < 20) continue
    if (/^\[?reserved\.?\]?$/i.test(text)) continue
    // Repealed sections sometimes only carry "Repealed." as the body.
    if (/^NRS\s+[0-9A-Za-z.]+\s+Repealed\.\s*$/i.test(text)) continue

    seen.add(bareNum)
    out.push({ number, title, text })
  }
  out.sort((a, b) => frac(a.number.replace(/^NRS\s+/, '')) - frac(b.number.replace(/^NRS\s+/, '')))
  return out
}

async function main() {
  console.log(`\n=== NV — ingesting property-tax full-text corpus (as of ${SOURCE_DATE}) ===`)
  console.log(`Fetching ${SOURCE_URL} ...`)

  const html = fetchUtf8(SOURCE_URL)
  console.log(`Fetched ${html.length} bytes (UTF-8).`)

  const sections = parseSections(html)
  console.log(`Parsed ${sections.length} in-range sections (361.045–361.730).`)
  if (sections.length === 0) {
    console.error('FATAL: zero sections parsed — aborting before any DB write.')
    process.exit(1)
  }

  let ok = 0
  let conflict = 0
  for (const s of sections) {
    const res = await query<{ id: string }>(
      `INSERT INTO state_law_section_texts
         (state_code, act_key, section_number, section_title, full_text,
          source_url, source_date, effective_year, law_category)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (state_code, act_key, section_number, effective_year) DO NOTHING
       RETURNING id`,
      [
        STATE,
        ACT_KEY,
        s.number,
        s.title,
        s.text,
        SOURCE_URL,
        SOURCE_DATE,
        EFFECTIVE_YEAR,
        LAW_CATEGORY,
      ]
    )
    if (res.length === 1) ok++
    else conflict++
  }

  console.log(`\nNV done. inserted=${ok}, already-present=${conflict}, parsed=${sections.length}`)
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
