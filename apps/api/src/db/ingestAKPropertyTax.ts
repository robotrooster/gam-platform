/**
 * Alaska property-tax statute full-text ingester (sanctioned retrieve+cite+date
 * carve-out — verbatim statutory prose, never advice).
 *
 * Alaska has NO statewide general property tax. Real-property assessment &
 * taxation is MUNICIPAL, codified in AS Title 29 (Municipal Government),
 * Chapter 45 (Municipal Taxation): Article 1 (Municipal Property Tax,
 * AS 29.45.010-.250) and Article 2 (Enforcement of Tax Liens,
 * AS 29.45.290-.500).
 *
 * OFFICIAL SOURCE = akleg.gov (Alaska Legislature / Legislative Council
 * version). The /basis/statutes.asp viewer is a jQuery/AJAX SPA, but section
 * text is served by a stable GET print endpoint:
 *
 *   GET https://www.akleg.gov/basis/statutes.asp?media=print&secStart=<AS#>&secEnd=<AS#>
 *
 * Returns an HTML fragment (charset ISO-8859-1) with every section in the
 * inclusive range. A browser User-Agent header is REQUIRED — the default
 * library UA is blocked with HTTP 403. A Referer of statutes.asp is polite.
 *
 * Fragment structure (per section):
 *   <div class="statute"><b><a name="29.45.NNN"> </a>Sec. 29.45.NNN.   <heading>. <BR></b>
 *   &nbsp;(a) ...body...<BR><BR>&nbsp;(b) ...<BR>... </div>
 * Article headers appear as <b><h7>Article N. Title.</h7><BR></b> — stripped.
 * The print fragment omits per-section history citations (e.g.
 * "(§ 12 ch 74 SLA 1985)"); the verbatim body text is unaffected.
 *
 * Parse: split on the <a name="29.45.NNN"> anchors (clean section delimiter);
 * catchline = "Sec. NNN. Heading." → number + title; body = everything after
 * the catchline up to the next anchor / end of div. ISO-8859-1 → UTF-8 decode
 * (bullet/dash 0x95/0x96), &nbsp; → space, <BR> → newline, strip residual tags.
 * Drop repealed/reserved/empty(<20)/header bodies.
 *
 * FEATURE-AREA RANGES (all act_key='property_tax', single source_url per range;
 * the unique constraint (state_code,act_key,section_number,effective_year)
 * dedupes the .030-.062 overlap between levy_authority and exemptions):
 *   levy_authority+exemptions  = AS 29.45.010-.090 (levy, notice, exemptions,
 *                                credits, deferrals, special assessments)
 *   assessment                 = AS 29.45.110-.180 (full/true value, returns,
 *                                investigation, reeval, roll, notice, corrections)
 *   assessment_review          = AS 29.45.190-.230 (appeal, board of
 *                                equalization, hearing, supplementary rolls)
 *   levy_collection_payment    = AS 29.45.240-.250 (levy/rate, penalty/interest)
 *   delinquency_tax_sale       = AS 29.45.290-.500 (Article 2 enforcement of
 *                                tax liens: lien, foreclosure, redemption, deed)
 *
 * Run: cd apps/api && node -r ts-node/register src/db/ingestAKPropertyTax.ts
 * Idempotent (ON CONFLICT DO NOTHING).
 */

import { execFileSync } from 'child_process'
import { query } from './index'

const STATE = 'AK'
const ACT_KEY = 'property_tax'
const LAW_CATEGORY = 'property_tax'
const SOURCE_DATE = '2026-06-14'
const EFFECTIVE_YEAR = 2026
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
const REFERER = 'https://www.akleg.gov/basis/statutes.asp'

const printUrl = (start: string, end: string) =>
  `https://www.akleg.gov/basis/statutes.asp?media=print&secStart=${start}&secEnd=${end}`

// Inclusive [secStart, secEnd] ranges, one curl each. secStart/secEnd are the
// outer bounds; the server returns the whole inclusive span of real sections.
const RANGES: Array<{ feature: string; start: string; end: string }> = [
  { feature: 'levy_authority+exemptions', start: '29.45.010', end: '29.45.090' },
  { feature: 'assessment', start: '29.45.110', end: '29.45.180' },
  { feature: 'assessment_review', start: '29.45.190', end: '29.45.230' },
  { feature: 'levy_collection_payment', start: '29.45.240', end: '29.45.250' },
  { feature: 'delinquency_tax_sale', start: '29.45.290', end: '29.45.500' },
]

interface Parsed {
  number: string
  title: string | null
  text: string
}

/** Fetch a range as decoded UTF-8 (source is ISO-8859-1). Browser UA required. */
function fetchRange(start: string, end: string): string {
  const buf = execFileSync(
    'curl',
    ['-sL', '--max-time', '90', '-A', UA, '-e', REFERER, printUrl(start, end)],
    { maxBuffer: 256 * 1024 * 1024 }
  )
  // akleg print fragments are ISO-8859-1.
  return buf.toString('latin1')
}

const ENTITIES: Record<string, string> = {
  '&nbsp;': ' ',
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&apos;': "'",
  '&#167;': '§',
  '&sect;': '§',
}

function decodeEntities(s: string): string {
  let out = s
  for (const [k, v] of Object.entries(ENTITIES)) out = out.split(k).join(v)
  out = out.replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
  out = out.replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  // Windows-1252 / control-range bytes that slip through a latin1 decode of
  // the ISO-8859-1 source: 0x95 bullet, 0x96 en-dash, 0x97 em-dash,
  // 0x92 right-single-quote, 0x93/0x94 curly double-quotes.
  out = out
    .replace(/\u0095/g, '\u2022')
    .replace(/\u0096/g, '\u2013')
    .replace(/\u0097/g, '\u2014')
    .replace(/\u0092/g, '\u2019')
    .replace(/\u0093/g, '\u201C')
    .replace(/\u0094/g, '\u201D')
  return out
}

/** <BR> → newline, drop residual tags, decode entities, normalize whitespace. */
function htmlToText(s: string): string {
  let t = s.replace(/<br\s*\/?>/gi, '\n')
  t = t.replace(/<\/?(?:p|div|h\d|h7)[^>]*>/gi, '\n')
  t = t.replace(/<[^>]+>/g, '')
  t = decodeEntities(t)
  t = t.replace(/\r\n?/g, '\n')
  t = t
    .split('\n')
    .map((line) => line.replace(/[^\S\n]+/g, ' ').trim())
    .join('\n')
  t = t.replace(/\n{3,}/g, '\n\n').trim()
  return t
}

/**
 * Parse a print-fragment range into sections. Sections are delimited by
 * <a name="29.45.NNN"> anchors. For each, the immediately-following
 * "Sec. NNN. Heading." catchline yields number + title; the remainder up to
 * the next anchor (or end) is the verbatim body.
 */
function parseRange(raw: string): Parsed[] {
  const out: Parsed[] = []
  // Split on the section anchor; each piece (after [0]) begins at an anchor.
  const ANCHOR = /<a name="(29\.45\.\d+)">\s*<\/a>/gi
  const matches = [...raw.matchAll(ANCHOR)]
  for (let i = 0; i < matches.length; i++) {
    const number = matches[i][1]
    const startIdx = matches[i].index! + matches[i][0].length
    const endIdx = i + 1 < matches.length ? matches[i + 1].index! : raw.length
    let chunk = raw.slice(startIdx, endIdx)

    // The catchline is "Sec. 29.45.NNN.   Heading. " then <BR></b>. Pull the
    // heading, then strip the whole "Sec. NNN." prefix from the body.
    const headRe = new RegExp(
      `Sec\\.\\s*${number.replace(/\./g, '\\.')}\\.\\s*([\\s\\S]*?)(?:<br\\s*\\/?>|</b>)`,
      'i'
    )
    const hm = chunk.match(headRe)
    let title: string | null = null
    if (hm) {
      title = htmlToText(hm[1]).replace(/\s+/g, ' ').replace(/\.\s*$/, '').trim() || null
      // Remove the catchline ("Sec. NNN. Heading.") from the body region.
      chunk = chunk.slice((hm.index ?? 0) + hm[0].length)
    } else {
      // Fallback: drop a leading "Sec. NNN." token if present.
      chunk = chunk.replace(new RegExp(`Sec\\.\\s*${number.replace(/\./g, '\\.')}\\.`, 'i'), '')
    }

    // Drop trailing Article header that may belong to the next article.
    chunk = chunk.replace(/<b>\s*<h7>[\s\S]*$/i, '')

    const body = htmlToText(chunk)

    // Drop repealed / reserved / empty / too-short.
    if (title && /^repealed\b/i.test(title)) continue
    if (title && /^\[?\s*repealed/i.test(title)) continue
    if (title && /^\[?\s*reserved\.?\]?$/i.test(title)) continue
    if (/^\[?\s*(repealed|reserved)/i.test(body)) continue
    if (!body || body.length < 20) continue

    out.push({ number, title, text: body })
  }
  return out
}

async function main() {
  console.log(`\n=== AK property_tax — ingesting full-text corpus (as of ${SOURCE_DATE}) ===`)
  let total = 0
  let skipped = 0
  const perFeature: Record<string, number> = {}

  for (const { feature, start, end } of RANGES) {
    let raw: string
    try {
      raw = fetchRange(start, end)
    } catch (e: any) {
      console.warn(`  ! ${feature} (${start}-${end}) FETCH FAILED: ${e?.message || e}`)
      perFeature[feature] = 0
      continue
    }
    const sections = parseRange(raw)
    let ok = 0
    for (const s of sections) {
      const url = printUrl(start, end)
      const res = await query(
        `INSERT INTO state_law_section_texts
           (state_code, act_key, section_number, section_title, full_text, source_url, source_date, effective_year, law_category)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (state_code, act_key, section_number, effective_year) DO NOTHING`,
        [STATE, ACT_KEY, s.number, s.title, s.text, url, SOURCE_DATE, EFFECTIVE_YEAR, LAW_CATEGORY]
      )
      if ((res as any).rowCount > 0) ok++
      else skipped++
    }
    perFeature[feature] = ok
    total += ok
    console.log(`  [${feature}] parsed ${sections.length}, inserted ${ok} (${start}-${end})`)
    await new Promise((r) => setTimeout(r, 300)) // politeness between range fetches
  }

  console.log(`\nAK done. inserted=${total}, conflict-skipped=${skipped}`, perFeature)
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
