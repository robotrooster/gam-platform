/**
 * Louisiana PROPERTY-TAX statute full-text ingester (sanctioned retrieve+cite+
 * date carve-out — verbatim statutory text, never advice).
 *
 * Source: legis.la.gov (the State of Louisiana's OFFICIAL site), an ASP.NET
 * WebForms app. Each statute lives at Law.aspx?d=<ID>; the d= IDs are OPAQUE
 * and non-derivable from the citation, and the Title-47 Subtitle-III docIDs are
 * split across two distant, non-contiguous clusters (assessment ~101331-101596;
 * Chapter-5 collection/sale/redemption ~631505-631663, plus a handful of stray
 * recodified IDs in the 1.3M-1.4M range). So docIDs are NOT walked by range —
 * each section number is resolved at run time through the site's "View a
 * Specific Law" form (LawSearch.aspx → btnViewLaw), which 302-redirects to
 * Law.aspx?d=ID. Driven headless via Playwright (WebForms VIEWSTATE round-trip),
 * exactly like ingestLaStateLaw.ts's harvestRsViaForm. Non-existent / repealed
 * section numbers come back without a d= and are skipped — so each chapter group
 * is enumerated as a candidate range and the form filters to what actually
 * exists.
 *
 * Statute page layout (UTF-8): a run of <P class=A000x align=...> paragraphs.
 *   A0001 = PART/CHAPTER header(s)               (skipped — not statute text)
 *   A0002 = the catchline — "§NNNN. <title>"     (&#167; decodes to §)
 *   A0003 = body paragraphs; the LAST is a history note ("Acts ...; eff. ...").
 * The page footer ("If you experience any technical difficulties ... webmaster
 * ... P.O. Box 94062 ...") lives OUTSIDE the A000x paragraphs, so selecting only
 * the structured paragraphs keeps masthead/nav/footer chrome out of full_text.
 *
 * CHAPTER MAPPING (Title 47, Subtitle III — Ad Valorem Taxes). Each section
 * number lands in exactly ONE chapter group (no overlap; assessment-review
 * pulls 1989/1992/1998 out of the 1951-1999 assessment block):
 *   exemptions             = R.S. 47:1701-1711 (ad valorem / homestead exemption provisions)
 *   assessment             = R.S. 47:1951-1999 (assessment procedure) + 2321-2331 (valuation criteria)
 *   assessment_review      = R.S. 47:1989, 1992, 1998 (tax-commission / board-of-review / judicial review)
 *   levy_collection_payment= R.S. 47:2127-2140 (time for payment; delinquency interest — Chapter 5)
 *   delinquency_tax_sale   = R.S. 47:2121-2126 (purpose/principles) + 2151-2165 (tax-sale procedure) + 2241-2247 (redemption)
 *
 * Run: cd apps/api && node -r ts-node/register src/db/ingestLAPropertyTax.ts
 * Idempotent (ON CONFLICT DO NOTHING). Reuses stripTags from the corpus
 * framework. Repealed/reserved/short (<20 char) bodies are dropped.
 */

import { execFileSync } from 'child_process'
import { query } from './index'
import { stripTags } from './ingestStateLawCorpus'

const STATE = 'LA'
const ACT_KEY = 'property_tax'
const LAW_CATEGORY = 'property_tax'
const SOURCE_DATE = '2026-06-14'
const EFFECTIVE_YEAR = 2026
const TITLE = '47'
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) GAM-statute-ingest/1.0'
const BASE = 'https://www.legis.la.gov/legis'
const lawUrl = (d: string) => `${BASE}/Law.aspx?d=${d}`

interface Parsed { number: string; title: string | null; text: string }

function curl(url: string): string {
  const buf = execFileSync('curl', ['-sL', '--max-time', '60', '-A', UA, url], {
    maxBuffer: 256 * 1024 * 1024,
  })
  return buf.toString('utf-8')
}

/**
 * Expand a list of inclusive [lo, hi] integer ranges (plus explicit extras) into
 * candidate section-number strings. The form filters non-existent numbers, so
 * over-enumerating is harmless — it just produces NONE responses we skip.
 */
function expand(ranges: Array<[number, number]>): string[] {
  const out: string[] = []
  for (const [lo, hi] of ranges) for (let n = lo; n <= hi; n++) out.push(String(n))
  return out
}

// Each chapter group's candidate section numbers (47:<n>). Non-overlapping.
const CHAPTERS: Record<string, string[]> = {
  // Ad valorem / homestead exemption provisions
  exemptions: expand([[1701, 1711]]),
  // Assessment procedure (1951-1999) + valuation criteria (2321-2331),
  // MINUS the three sections routed to assessment_review.
  assessment: expand([[1951, 1999], [2321, 2331]]).filter(
    (n) => !['1989', '1992', '1998'].includes(n)
  ),
  // Review of appeals (tax commission) / board of review / judicial review.
  assessment_review: ['1989', '1992', '1998'],
  // Time for payment; delinquency interest (Chapter 5, payment).
  levy_collection_payment: expand([[2127, 2140]]),
  // Purpose/principles + tax-sale procedure + redemption (Chapter 5).
  delinquency_tax_sale: expand([[2121, 2126], [2151, 2165], [2241, 2247]]),
}

/**
 * Build a Parsed result from an ordered list of already-stripped paragraphs.
 * catchline = first paragraph starting with § ; body = every paragraph after it
 * (incl. the trailing "Acts ...; eff. ..." history note, kept as the source-note
 * trailer the carve-out allows). Returns null for an unfound / repealed /
 * reserved / too-short section.
 */
function fromParas(paras: string[], expectedNumber: string): Parsed | null {
  let catchIdx = -1
  for (let i = 0; i < paras.length; i++) {
    if (/^§/.test(paras[i].trim())) {
      catchIdx = i
      break
    }
  }
  if (catchIdx === -1) return null
  const catchline = paras[catchIdx].trim()

  let title: string | null = catchline.replace(/^§\s*[0-9A-Za-z.:-]+\.?\s*/, '').trim()
  if (!title) title = null
  if (title && /^repealed\b/i.test(title)) return null
  if (title && /^\[?reserved\.?\]?$/i.test(title)) return null

  const body = paras
    .slice(catchIdx + 1)
    .map((p) => p.trim())
    .filter(Boolean)
    .join('\n')
    .trim()

  if (!body || body.length < 20) return null
  if (/^\[?reserved\.?\]?$/i.test(body)) return null
  if (/^(this section has been )?repealed\b/i.test(body)) return null
  return { number: expectedNumber, title, text: body }
}

/**
 * Parse a Law.aspx statute page. legis.la.gov serves Title-47 sections in TWO
 * page templates depending on docID vintage:
 *
 *  (1) LEGACY (assessment block, ~d=101331-101596): a run of
 *      <P class=A000x> paragraphs. A0001 = headers, A0002 = "§NNNN. title",
 *      A0003 = body + history note.
 *  (2) MODERN (exemptions, Chapter-5 collection/sale/redemption, recodified
 *      sections): the body lives in <span id="...LabelDocument"><div
 *      id="WPMainDoc"> ... </div></span> as <p style=...><span...> paragraphs,
 *      catchline rendered with the &sect; entity ("&sect;NNNN.  title").
 *
 * Try legacy first; if it yields no §-catchline, fall back to WPMainDoc. In both
 * cases only the structured statute container is selected, so masthead / nav /
 * prev-next buttons / footer chrome stay out of full_text.
 */
function parseLawPage(html: string, expectedNumber: string): Parsed | null {
  // (1) Legacy A000x template.
  const legacyParas = [
    ...html.matchAll(/<P\s+class=A000[0-9][^>]*>([\s\S]*?)<\/P>/gi),
  ].map((m) => stripTags(m[1], true))
  const legacy = fromParas(legacyParas, expectedNumber)
  if (legacy) return legacy

  // (2) Modern WPMainDoc template. &sect; is not handled by the shared
  // decodeEntities, so normalize it to § before stripTags runs.
  const docM = html.match(/<div\s+id="WPMainDoc">([\s\S]*?)<\/div>\s*<\/span>/i)
  if (!docM) return null
  const modernParas = [...docM[1].matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)].map((m) =>
    stripTags(m[1].replace(/&sect;/gi, '§'), true)
  )
  return fromParas(modernParas, expectedNumber)
}

/**
 * Resolve a list of Title-47 section numbers to (number, d=ID) pairs via the
 * headless "View a Specific Law" form. We only read the redirect URL here — the
 * form's post-click DOM snapshot does NOT contain the rendered statute body
 * (only the A000x CSS rules), so the body is fetched separately via curl of
 * Law.aspx?d=ID (which returns the full structured page reliably). Numbers that
 * don't resolve to a Law.aspx d= (non-existent / repealed-out-of-index) are
 * dropped silently.
 */
async function resolveDocIds(secs: string[]): Promise<Array<{ number: string; d: string }>> {
  const { chromium } = require('playwright')
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ userAgent: UA })
  const out: Array<{ number: string; d: string }> = []
  try {
    for (const sec of secs) {
      try {
        await page.goto(`${BASE}/LawSearch.aspx`, { waitUntil: 'networkidle', timeout: 60000 })
        await page.fill('#ctl00_ctl00_PageBody_PageContent_tbFirstNumber', TITLE)
        await page.fill('#ctl00_ctl00_PageBody_PageContent_tbSecondNumber', sec)
        await Promise.all([
          page.waitForLoadState('networkidle'),
          page.click('#ctl00_ctl00_PageBody_PageContent_btnViewLaw'),
        ])
        const m = page.url().match(/Law\.aspx\?d=(\d+)/i)
        if (!m) continue // non-existent section number — skip silently
        out.push({ number: sec, d: m[1] })
      } catch (e: any) {
        console.warn(`  ! resolve 47:${sec}: ${e?.message || e}`)
      }
    }
  } finally {
    await page.close()
    await browser.close()
  }
  return out
}

async function ingestChapter(
  chapter: string,
  resolved: Array<{ number: string; d: string }>
): Promise<number> {
  let ok = 0
  let skipped = 0
  for (const { number, d } of resolved) {
    let html: string
    try {
      html = curl(lawUrl(d))
    } catch (e: any) {
      console.warn(`  ! fetch 47:${number} (d=${d}): ${e?.message || e}`)
      skipped++
      continue
    }
    const p = parseLawPage(html, number)
    if (!p || !p.text || p.text.length < 20) {
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
        `47:${p.number}`,
        p.title,
        p.text,
        lawUrl(d),
        SOURCE_DATE,
        EFFECTIVE_YEAR,
        LAW_CATEGORY,
      ]
    )
    ok++
  }
  console.log(`  [${chapter}] inserted ${ok}, skipped ${skipped} of ${resolved.length} resolved`)
  return ok
}

async function main() {
  console.log(`\n=== LA — ingesting property-tax full-text corpus (as of ${SOURCE_DATE}) ===`)

  const counts: Record<string, number> = {}
  for (const [chapter, secs] of Object.entries(CHAPTERS)) {
    process.stdout.write(`${chapter}: resolving ${secs.length} candidate sections via form ...\n`)
    const resolved = await resolveDocIds(secs)
    console.log(`  ${chapter}: ${resolved.length} sections exist on the official site`)
    counts[chapter] = await ingestChapter(chapter, resolved)
  }

  const total = Object.values(counts).reduce((a, b) => a + b, 0)
  console.log(`\nLA property_tax done. inserted=${total}`, counts)
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
