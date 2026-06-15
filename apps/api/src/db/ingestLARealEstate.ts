/**
 * Louisiana NON-TAX real-estate statute full-text ingester (sanctioned
 * retrieve+cite+date carve-out — verbatim official text, never advice).
 *
 * Covers five real-estate law categories, all sourced ONLY from the official
 * Louisiana State Legislature site legis.la.gov:
 *
 *   conveyancing_title       Civil Code Sale of immovables (Arts. 2438-2659)
 *                            + Public Records / recordation R.S. 9:2721 et seq.
 *   condo_coop               Louisiana Condominium Act R.S. 9:1121.101 et seq.
 *                            + Homeowners Association Act R.S. 9:1141.1 et seq.
 *   broker_licensing         Real Estate License Law R.S. 37:1430 et seq.
 *                            + Real Estate Appraisers R.S. 37:3391 et seq.
 *   mortgage_lien_foreclosure Civil Code Mortgages (Arts. 3278-3337)
 *                            + Private Works Act (privileges) R.S. 9:4801 et seq.
 *                            + Code of Civil Procedure executory/ordinary
 *                              process & seizure-and-sale (Arts. 2631-2772)
 *   general_real_property    Civil Code Book II "Things & Ownership"
 *                            (Arts. 448-818) + Prescription incl. acquisitive
 *                            prescription/adverse possession (Arts. 3445-3505)
 *
 * SITE MECHANICS (legis.la.gov is an ASP.NET WebForms app):
 *
 *   Each statute lives at Law.aspx?d=<ID>. The d= IDs are OPAQUE — there is no
 *   arithmetic map from a CC/RS citation to its d=. Two harvest paths:
 *
 *   - Civil Code (folder=67) + Code of Civil Procedure (folder=68): one curl of
 *     the folder page returns a fully-expanded FLAT table of every article as
 *     <td><a href="Law.aspx?d=ID">CC 2440</a></td>. We parse the first-cell
 *     anchors ("CC NNNN" / "CCP NNNN") and keep only each act's article range.
 *   - Revised Statutes (Title 9 / Title 37): the RS browse tree is JS-only and
 *     exposes no static d= links, AND some RS sections were re-enacted to
 *     non-contiguous high d= IDs (e.g. 9:4856 = d=1147487), so a sequential-d=
 *     walk is NOT reliable. Instead we resolve EACH candidate (title, section)
 *     citation through the site's "View a Specific Law" form
 *     (LawSearch.aspx -> btnViewLaw), which redirects straight to its Law.aspx?d=
 *     page. Non-existent candidates simply stay on LawSearch.aspx (no redirect)
 *     and are dropped. This is the authoritative RS enumerator.
 *
 * PAGE LAYOUT (two variants, both handled by parseLawPage from raw curl HTML):
 *   - Citation: <span id="...LabelName" class="title">CC 2440 / RS 9:4806</span>
 *   - Classic layout: a run of <P class=A000x> paragraphs (Civil Code, most CCP,
 *     condo, broker). A0001 = PART/CHAPTER header(s); the catchline starts with
 *     "Art." or "§"; the rest is body; the last is the "Acts ..." history note.
 *   - Inline-style layout: content lives in <div id="WPMainDoc"> as <p style=...>
 *     paragraphs with NO A000x class (Private Works Act, some CCP, some recording
 *     sections). Same logical structure inside.
 *   Both are fetched by curl; broken-on-the-site pages (e.g. 9:4801 = d=108050)
 *   return an ASP.NET error body with no content paragraphs and are dropped.
 *
 * DROP RULES: repealed / reserved / blank / TOC-or-header-only / body < 20 chars.
 * The page footer ("If you experience any technical difficulties ... webmaster")
 * sits OUTSIDE the content paragraphs, so it never enters full_text.
 *
 * Run: cd apps/api && node -r ts-node/register src/db/ingestLARealEstate.ts
 * Idempotent (ON CONFLICT DO NOTHING).
 */

import { execFileSync } from 'child_process'
import { query } from './index'

const STATE = 'LA'
const SOURCE_DATE = '2026-06-14'
const EFFECTIVE_YEAR = 2026
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) GAM-statute-ingest/1.0'
const BASE = 'https://www.legis.la.gov/legis'
const lawUrl = (d: string) => `${BASE}/Law.aspx?d=${d}`

const TOC = {
  cc: `${BASE}/Laws_Toc.aspx?folder=67&level=Parent`,
  ccp: `${BASE}/Laws_Toc.aspx?folder=68&level=Parent`,
}

interface Cite {
  number: string // citation number, e.g. "2440", "1121.101"
  d: string // legis.la.gov document ID
}
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Decode the entity set legis.la.gov emits, normalizing § and spaces. */
function decode(s: string): string {
  return s
    .replace(/&#167;|&sect;/gi, '§')
    .replace(/&#160;|&nbsp;/gi, ' ')
    .replace(/&#8212;|&mdash;/gi, '—')
    .replace(/&#8211;|&ndash;/gi, '–')
    .replace(/&#8217;|&rsquo;/gi, '’')
    .replace(/&#8216;|&lsquo;/gi, '‘')
    .replace(/&#8220;|&ldquo;/gi, '“')
    .replace(/&#8221;|&rdquo;/gi, '”')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
}

/** Strip tags from one inline HTML fragment → single-line text. */
function frag(html: string): string {
  return decode(html.replace(/<[^>]+>/g, ' '))
    .replace(/[  -   　]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Harvest (number, d=ID) pairs from a flat Civil-Code / CCP TOC page. The
 * citation is the FIRST cell's anchor as "<PREFIX> NNNN(.NN)". Restrict to
 * [lo, hi] and de-dupe by number (each TOC row repeats the d= in both cells).
 */
function harvestToc(html: string, prefix: 'CC' | 'CCP', lo: number, hi: number): Cite[] {
  const re = new RegExp(
    `<a[^>]*href="(Law\\.aspx\\?d=(\\d+))"[^>]*>\\s*${prefix}\\s+([0-9]+(?:\\.[0-9]+)?)\\s*</a>`,
    'gi'
  )
  const seen = new Set<string>()
  const out: Cite[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) {
    const number = m[3]
    const n = parseFloat(number)
    if (!Number.isFinite(n) || n < lo || n > hi) continue
    if (seen.has(number)) continue
    seen.add(number)
    out.push({ number, d: m[2] })
  }
  out.sort((a, b) => parseFloat(a.number) - parseFloat(b.number))
  return out
}

/**
 * Resolve a list of RS (title, section) candidates to their d= IDs via the
 * headless "View a Specific Law" form. Non-existent sections stay on
 * LawSearch.aspx (no Law.aspx?d= redirect) and are dropped. One reused browser
 * context; domcontentloaded (not networkidle) keeps it fast.
 */
async function resolveRs(title: string, sections: string[]): Promise<Cite[]> {
  const { chromium } = require('playwright')
  const browser = await chromium.launch({ headless: true })
  const page = await (await browser.newContext({ userAgent: UA })).newPage()
  const out: Cite[] = []
  try {
    for (let i = 0; i < sections.length; i++) {
      const sec = sections[i]
      try {
        await page.goto(`${BASE}/LawSearch.aspx`, { waitUntil: 'domcontentloaded', timeout: 60000 })
        await page.fill('#ctl00_ctl00_PageBody_PageContent_tbFirstNumber', title)
        await page.fill('#ctl00_ctl00_PageBody_PageContent_tbSecondNumber', sec)
        await Promise.all([
          page.waitForLoadState('domcontentloaded'),
          page.click('#ctl00_ctl00_PageBody_PageContent_btnViewLaw'),
        ])
        const m = page.url().match(/Law\.aspx\?d=(\d+)/i)
        if (m) out.push({ number: sec, d: m[1] })
      } catch (e: any) {
        console.warn(`  ! resolve RS ${title}:${sec}: ${e?.message || e}`)
      }
      if (i % 25 === 24) process.stdout.write(`\r    resolving ${title}: ${i + 1}/${sections.length}`)
    }
  } finally {
    await browser.close()
  }
  // de-dupe by number (some candidates redirect to the same parent section)
  const seen = new Set<string>()
  return out.filter((c) => (seen.has(c.number) ? false : (seen.add(c.number), true)))
}

/**
 * Parse a Law.aspx statute page (raw curl HTML). Citation comes from the
 * LabelName span. Content paragraphs come from either the classic A000x <P>
 * run or, failing that, the <p> tags inside the WPMainDoc div. The catchline is
 * the first paragraph beginning with § or "Art."; body = every paragraph after
 * it (incl. the trailing Acts history note). Returns null for empty / repealed /
 * reserved / header-only / error pages.
 */
function parseLawPage(html: string, expectedNumber: string): Parsed | null {
  // Classic layout: <P class=A000x>...</P>
  let paras = [...html.matchAll(/<P\s+class=A000[0-9][^>]*>([\s\S]*?)<\/P>/gi)].map((m) =>
    frag(m[1])
  )

  // Inline layout fallback: <p ...>...</p> inside the WPMainDoc div.
  if (paras.length === 0) {
    const start = html.indexOf('id="WPMainDoc"')
    if (start !== -1) {
      // Bound the region at the closing of the LabelDocument span's wrapper.
      const region = html.slice(start, start + 200000)
      paras = [...region.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)].map((m) => frag(m[1]))
    }
  }

  paras = paras.map((p) => p.trim()).filter(Boolean)
  if (paras.length === 0) return null

  // Locate the catchline: first paragraph starting with § or "Art.".
  let catchIdx = -1
  for (let i = 0; i < paras.length; i++) {
    if (/^(§|Art\.)/.test(paras[i])) {
      catchIdx = i
      break
    }
  }
  if (catchIdx === -1) return null
  const catchline = paras[catchIdx]

  // Title = catchline minus the leading "§NNNN." / "Art. NNNN." citation.
  let title: string | null = catchline
    .replace(/^§\s*[0-9A-Za-z.:-]+\.?\s*/, '')
    .replace(/^Art\.\s*[0-9A-Za-z.:-]+\.?\s*/, '')
    .trim()
  if (!title) title = null
  if (title && /^repealed\b/i.test(title)) return null
  if (title && /^\[?reserved\.?\]?$/i.test(title)) return null

  // Body = paragraphs after the catchline (history note kept as source-note
  // trailer, which the carve-out allows).
  const body = paras
    .slice(catchIdx + 1)
    .join('\n')
    .trim()

  if (!body || body.length < 20) return null
  if (/^\[?reserved\.?\]?$/i.test(body)) return null
  if (/^repealed\b/i.test(body)) return null
  return { number: expectedNumber, title, text: body }
}

async function ingestCategory(cat: string, cites: Cite[]): Promise<number> {
  let ok = 0
  let skipped = 0
  const CONC = 3
  for (let i = 0; i < cites.length; i += CONC) {
    if (i > 0) await sleep(250) // politeness
    const batch = cites.slice(i, i + CONC)
    const parsed = await Promise.all(
      batch.map(async (c) => {
        try {
          return { p: parseLawPage(curl(lawUrl(c.d)), c.number), c }
        } catch (e: any) {
          console.warn(`  ! ${cat} ${c.number} (d=${c.d}): ${e?.message || e}`)
          return { p: null, c }
        }
      })
    )
    for (const { p, c } of parsed) {
      if (!p || !p.text || p.text.length < 20) {
        skipped++
        continue
      }
      await query(
        `INSERT INTO state_law_section_texts
           (state_code, act_key, section_number, section_title, full_text,
            source_url, source_date, effective_year, law_category)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (state_code, act_key, section_number, effective_year) DO NOTHING`,
        [STATE, cat, p.number, p.title, p.text, lawUrl(c.d), SOURCE_DATE, EFFECTIVE_YEAR, cat]
      )
      ok++
    }
    process.stdout.write(`\r  [${cat}] ${Math.min(i + CONC, cites.length)}/${cites.length}`)
  }
  console.log(`\n  [${cat}] inserted ${ok}, skipped ${skipped} of ${cites.length}`)
  return ok
}

// --- candidate section-number generators for the RS form enumerator ----------

/** Integers lo..hi plus ".1".."dec" subsections on each (e.g. 1431, 1431.1). */
function intRange(lo: number, hi: number, decMax = 9): string[] {
  const out: string[] = []
  for (let n = lo; n <= hi; n++) {
    out.push(String(n))
    for (let d = 1; d <= decMax; d++) out.push(`${n}.${d}`)
  }
  return out
}

/** Dotted-decimal scheme: each part in parts, NN from 100..hi (subpart-coded). */
function dottedRange(parts: number[], hi: number): string[] {
  const out: string[] = []
  for (const part of parts) for (let n = 100; n <= hi; n++) out.push(`${part}.${n}`)
  return out
}

async function main() {
  console.log(`\n=== LA real-estate corpus — ingesting (as of ${SOURCE_DATE}) ===`)
  const counts: Record<string, number> = {}

  // Flat-TOC harvests (Civil Code folder=67, Code of Civil Procedure folder=68).
  console.log('Fetching Civil Code + CCP flat TOCs ...')
  const ccHtml = curl(TOC.cc)
  const ccpHtml = curl(TOC.ccp)

  // 1) conveyancing_title: CC Sale of immovables 2438-2659 + recording R.S. 9:2721 et seq.
  const conveyCc = harvestToc(ccHtml, 'CC', 2438, 2659)
  console.log(`conveyancing_title: ${conveyCc.length} CC Sale articles (2438-2659)`)
  const recordingCites = await resolveRs('9', intRange(2721, 2776))
  console.log(`\nconveyancing_title: ${recordingCites.length} R.S. 9 recording sections (2721 et seq.)`)
  counts['conveyancing_title'] =
    (await ingestCategory('conveyancing_title', conveyCc)) +
    (await ingestCategory('conveyancing_title', recordingCites))

  // 2) condo_coop: Condominium Act 9:1121.101-1124.x + HOA Act 9:1141.x
  const condoCites = await resolveRs('9', [
    ...dottedRange([1121, 1122, 1123, 1124], 199),
    ...intRange(1141, 1141, 9),
    '1141.1', '1141.2', '1141.3', '1141.4', '1141.5', '1141.6', '1141.7', '1141.8', '1141.9',
  ])
  console.log(`\ncondo_coop: ${condoCites.length} R.S. 9 condo + HOA sections`)
  counts['condo_coop'] = await ingestCategory('condo_coop', condoCites)

  // 3) broker_licensing: Real Estate License Law 37:1430 et seq. + Appraisers 37:3391 et seq.
  const brokerCites = await resolveRs('37', [
    ...intRange(1430, 1499),
    ...intRange(3391, 3420),
  ])
  console.log(`\nbroker_licensing: ${brokerCites.length} R.S. 37 license + appraiser sections`)
  counts['broker_licensing'] = await ingestCategory('broker_licensing', brokerCites)

  // 4) mortgage_lien_foreclosure: CC Mortgages 3278-3337 + Private Works 9:4801 et seq.
  //    + CCP executory/ordinary process 2631-2772.
  const mortgageCc = harvestToc(ccHtml, 'CC', 3278, 3337)
  const foreclosureCcp = harvestToc(ccpHtml, 'CCP', 2631, 2772)
  console.log(
    `mortgage_lien_foreclosure: ${mortgageCc.length} CC mortgage arts + ${foreclosureCcp.length} CCP foreclosure arts`
  )
  const privateWorksCites = await resolveRs('9', intRange(4801, 4860))
  console.log(`\nmortgage_lien_foreclosure: ${privateWorksCites.length} R.S. 9 Private Works sections`)
  counts['mortgage_lien_foreclosure'] =
    (await ingestCategory('mortgage_lien_foreclosure', mortgageCc)) +
    (await ingestCategory('mortgage_lien_foreclosure', foreclosureCcp)) +
    (await ingestCategory('mortgage_lien_foreclosure', privateWorksCites))

  // 5) general_real_property: CC Book II Things & Ownership 448-818 + Prescription 3445-3505.
  const bookIi = harvestToc(ccHtml, 'CC', 448, 818)
  const prescription = harvestToc(ccHtml, 'CC', 3445, 3505)
  console.log(
    `general_real_property: ${bookIi.length} CC Book II arts + ${prescription.length} CC prescription arts`
  )
  counts['general_real_property'] =
    (await ingestCategory('general_real_property', bookIi)) +
    (await ingestCategory('general_real_property', prescription))

  const total = Object.values(counts).reduce((a, b) => a + b, 0)
  console.log(`\nLA real-estate corpus done. inserted=${total}`, counts)
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
