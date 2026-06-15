/**
 * Kansas non-tax real-estate statute full-text ingester (sanctioned
 * retrieve+cite+date carve-out — verbatim statutory prose only, never advice).
 *
 * Source: Kansas Office of Revisor of Statutes — https://ksrevisor.gov.
 * The official site serves each statute as a static HTML page; no JS render
 * needed (raw_http). URL pattern per section:
 *   https://ksrevisor.gov/statutes/chapters/chNN/0NN_0AA_SSSS[x].html
 * where NN = chapter, AA = article, SSSS = zero-padded section ordinal, and an
 * optional trailing letter for lettered sections (e.g. 58-3115a -> 0015a).
 * Comma-form citations (58-30,102) render at ordinal 0102. Rather than derive
 * URLs from citations (the ordinal<->citation map is irregular: gaps, lettered
 * subsections, comma forms), we HARVEST the exact section-page links straight
 * from the chapter index pages (ksa_chNN.html), filtered to the target article
 * ordinals. The index lists every live + repealed section URL, so the harvest
 * is authoritative and self-correcting.
 *
 * STATUTE PAGE LAYOUT (verified against live pages):
 *   <div id="print">
 *     <p class="ksa_stat">
 *       <span class="stat_number"> 58-2211. </span>
 *       <span class="stat_caption"> Acknowledgment of instrument ... </span>
 *       All conveyances, and other instruments ...        <-- body chunk 1
 *     </p>
 *     <p class="ksa_stat"> (b) ... </p>                    <-- continuation body
 *     <p class="ksa_stat"> (c) ... </p>
 *     <p class="ksa_stat_hist"><span class="history">History:</span> ...</p>
 *   </div>
 *   ...then p.ksa_8pt_title / p.ksa_8pt_body / p.ksa_8pt_ca blocks holding LAW
 *   REVIEW refs, ATTORNEY GENERAL opinions, and CASE ANNOTATIONS — these are
 *   editorial, NOT statutory, and live OUTSIDE div#print, so restricting to
 *   div#print drops them cleanly.
 *
 * So per page: number+caption from the FIRST p.ksa_stat (its two leading
 * spans), body = every p.ksa_stat (spans stripped) joined, plus the trailing
 * p.ksa_stat_hist note (kept as a source-note trailer, consistent with the
 * LA ingester and the spec's "history allowed" posture).
 *
 * Repealed sections render with caption "Repealed." and a stub body -> dropped
 * (repealed-title check + <20-char body check). 404s have no div#print -> null.
 *
 * CATEGORY -> ARTICLE MAPPING (act_key == law_category == the category key):
 *   conveyancing_title        ch58 art 21 (acknowledgments) + art 22
 *                             (conveyances of land) + art 34 (marketable
 *                             record title act)
 *   condo_coop                ch58 art 31 (apartment ownership act) + art 37
 *                             (townhouse ownership act)
 *   broker_licensing          ch58 art 30 (real estate brokers' & salespersons'
 *                             license act, incl. appraiser provisions)
 *   mortgage_lien_foreclosure ch58 art 23 (mortgages of real property) +
 *                             ch60 art 11 (mechanic's/material liens) +
 *                             ch60 art 24 (executions & orders of sale,
 *                             incl. 60-2414 redemption)
 *   general_real_property     ch58 art 5 (the property act of 1939) +
 *                             targeted art-22 estate catch-alls (58-2202,
 *                             58-2208) + ch60 art 5 60-503 (adverse-possession
 *                             limitation period)
 *
 * De-dup note: art-22 sections 58-2202 / 58-2208 are claimed by
 * general_real_property AND would also fall in conveyancing_title's full art-22
 * harvest. They are distinct act_key rows (different law_category), which the
 * unique constraint (state_code, act_key, section_number, effective_year)
 * permits — intentional cross-listing of the two estate catch-alls.
 *
 * Run: cd apps/api && node -r ts-node/register src/db/ingestKSRealEstate.ts
 * Idempotent (ON CONFLICT DO NOTHING). Official source only. Verbatim.
 */

import { execFileSync } from 'child_process'
import { query } from './index'
import { stripTags } from './ingestStateLawCorpus'

const STATE = 'KS'
const SOURCE_DATE = '2026-06-14'
const EFFECTIVE_YEAR = 2026
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) GAM-statute-ingest/1.0'
const ORIGIN = 'https://ksrevisor.gov'

interface Section {
  number: string // statutory citation, e.g. "58-2211" or "58-30,102"
  url: string
}
interface Parsed {
  number: string
  title: string | null
  text: string
}

/** Fetch a URL. Returns { status, body }. Never throws on HTTP error codes. */
function fetchUrl(url: string): { status: number; body: string } {
  const out = execFileSync(
    'curl',
    ['-sL', '--max-time', '60', '-A', UA, '-w', '\n__HTTP_STATUS__%{http_code}', url],
    { maxBuffer: 256 * 1024 * 1024 }
  ).toString('utf-8')
  const m = out.match(/\n__HTTP_STATUS__(\d+)$/)
  const status = m ? parseInt(m[1], 10) : 0
  const body = m ? out.slice(0, out.length - m[0].length) : out
  return { status, body }
}

/**
 * Harvest the exact section-page URLs for a chapter+article from the chapter
 * index page. articleOrdinal is the 3-digit article segment (e.g. "022").
 * Returns absolute URLs; the displayed citation is resolved later from the page
 * itself (the index also carries citations but the page's own stat_number is
 * the canonical verbatim form, incl. comma-forms).
 */
function harvestArticleUrls(indexHtml: string, chapter: string, articleOrdinal: string): string[] {
  const re = new RegExp(
    `href="(/statutes/chapters/ch${chapter}/0${chapter}_${articleOrdinal}_[0-9]+[a-z]?\\.html)"`,
    'gi'
  )
  const seen = new Set<string>()
  const out: string[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(indexHtml)) !== null) {
    if (seen.has(m[1])) continue
    seen.add(m[1])
    out.push(ORIGIN + m[1])
  }
  // Stable sort by the numeric+letter ordinal in the URL.
  out.sort((a, b) => {
    const oa = a.match(/_(\d+)([a-z]?)\.html$/)!
    const ob = b.match(/_(\d+)([a-z]?)\.html$/)!
    const na = parseInt(oa[1], 10)
    const nb = parseInt(ob[1], 10)
    return na !== nb ? na - nb : oa[2].localeCompare(ob[2])
  })
  return out
}

/** Pick out only the named section URLs (for the narrow general_real_property catch-alls). */
function pickUrls(indexHtml: string, chapter: string, refs: string[]): string[] {
  return refs.map((r) => `${ORIGIN}/statutes/chapters/ch${chapter}/${r}`)
}

/**
 * Parse a KS statute page. Restrict to div#print, take number+caption from the
 * first p.ksa_stat's two leading spans, body = all p.ksa_stat bodies joined +
 * trailing p.ksa_stat_hist. Returns null for repealed/reserved/empty/404 pages.
 */
function parseLawPage(html: string): Parsed | null {
  // Isolate the statutory print region. Anchor on the closing wrapper:
  // <div id="print"><div> ... </div></div>. Grab from id="print" to the first
  // p.ksa_8pt / end-of-region marker so editorial blocks never enter the body.
  const printIdx = html.indexOf('<div id="print">')
  if (printIdx === -1) return null
  let region = html.slice(printIdx)
  // Cut off at the first editorial paragraph (law review / AG / case annotations).
  const cut = region.search(/<p class="ksa_8pt_(title|body|ca)"/i)
  if (cut !== -1) region = region.slice(0, cut)

  // First stat_number span = citation.
  const numM = region.match(/<span class="stat_number">([\s\S]*?)<\/span>/i)
  if (!numM) return null
  let number = stripTags(numM[1], false).replace(/\.+$/, '').trim()
  if (!number) return null
  // Citation forms: "58-2211", "58-30,102", "58-3020, 58-3021" (repealed pair).
  // For a multi-citation repealed stub we keep the first; it gets dropped anyway.
  if (number.includes(',') && /,\s*\d+-/.test(number)) {
    number = number.split(/,\s*(?=\d+-)/)[0].trim()
  }

  // Caption span = catchline / title.
  const capM = region.match(/<span class="stat_caption">([\s\S]*?)<\/span>/i)
  let title: string | null = capM ? stripTags(capM[1], false).trim() : null
  if (title) title = title.replace(/\.$/, '').trim()
  if (!title) title = null
  if (title && /^repealed\b/i.test(title)) return null
  if (title && /^\[?reserved\.?\]?$/i.test(title)) return null

  // Body: every p.ksa_stat paragraph (strip the two leading spans from the
  // first), then the history note. Preserve subsection structure via newlines.
  const statParas = [...region.matchAll(/<p class="ksa_stat">([\s\S]*?)<\/p>/gi)].map((m, i) => {
    let inner = m[1]
    if (i === 0) {
      // Remove the number + caption spans from the first paragraph's body.
      inner = inner
        .replace(/<span class="stat_number">[\s\S]*?<\/span>/i, '')
        .replace(/<span class="stat_caption">[\s\S]*?<\/span>/i, '')
    }
    return stripTags(inner, true)
  })
  const histM = region.match(/<p class="ksa_stat_hist">([\s\S]*?)<\/p>/i)
  const hist = histM ? stripTags(histM[1], true) : ''

  // STATUTORY body only (the p.ksa_stat paragraphs, excluding the history note).
  // Repealed/reserved sections render with NO caption span and NO statutory
  // paragraph — only a stat_number and a "History: ... Repealed ..." note. We
  // must require real statutory prose here so those stubs are dropped; the
  // history note alone (>20 chars) must never qualify a row.
  const statBody = statParas
    .map((p) => p.trim())
    .filter(Boolean)
    .join('\n')
    .trim()
  if (!statBody || statBody.length < 20) return null
  if (/^\[?reserved\.?\]?$/i.test(statBody)) return null
  if (/^repealed\b/i.test(statBody)) return null

  // full_text = statutory prose + trailing history note (source-note trailer).
  let body = statBody
  if (hist) body = `${body}\n${hist.trim()}`
  body = body.replace(/\n{3,}/g, '\n\n').trim()

  return { number, title, text: body }
}

async function ingestCategory(cat: string, urls: string[]): Promise<number> {
  let ok = 0
  let skipped = 0
  let notFound = 0
  const CONC = 4
  const sections: Section[] = urls.map((u) => ({ number: '', url: u }))
  for (let i = 0; i < sections.length; i += CONC) {
    if (i > 0) await new Promise((r) => setTimeout(r, 250)) // politeness
    const batch = sections.slice(i, i + CONC)
    const results = batch.map((s) => {
      try {
        const { status, body } = fetchUrl(s.url)
        if (status === 404) {
          notFound++
          return { p: null as Parsed | null, url: s.url }
        }
        return { p: parseLawPage(body), url: s.url }
      } catch (e: any) {
        console.warn(`  ! ${cat} ${s.url}: ${e?.message || e}`)
        return { p: null as Parsed | null, url: s.url }
      }
    })
    for (const { p, url } of results) {
      if (!p || !p.text || p.text.length < 20) {
        skipped++
        continue
      }
      await query(
        `INSERT INTO state_law_section_texts
           (state_code, act_key, section_number, section_title, full_text, source_url, source_date, effective_year, law_category)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (state_code, act_key, section_number, effective_year) DO NOTHING`,
        [STATE, cat, p.number, p.title, p.text, url, SOURCE_DATE, EFFECTIVE_YEAR, cat]
      )
      ok++
    }
    process.stdout.write(`\r  [${cat}] ${Math.min(i + CONC, sections.length)}/${sections.length}`)
  }
  console.log(
    `\n  [${cat}] inserted ${ok}, skipped ${skipped} (incl. ${notFound} 404) of ${sections.length}`
  )
  return ok
}

async function main() {
  console.log(`\n=== KS — ingesting non-tax real-estate full-text corpus (as of ${SOURCE_DATE}) ===`)

  // Fetch both chapter index pages once; harvest article URLs from them.
  const ch58 = fetchUrl(`${ORIGIN}/statutes/ksa_ch58.html`)
  const ch60 = fetchUrl(`${ORIGIN}/statutes/ksa_ch60.html`)
  if (ch58.status !== 200 || ch60.status !== 200) {
    throw new Error(`index fetch failed: ch58=${ch58.status} ch60=${ch60.status}`)
  }
  console.log(`harvested chapter indexes (ch58=${ch58.body.length}b, ch60=${ch60.body.length}b)`)

  // conveyancing_title: ch58 art 21 + 22 + 34
  const conveyancing = [
    ...harvestArticleUrls(ch58.body, '58', '021'),
    ...harvestArticleUrls(ch58.body, '58', '022'),
    ...harvestArticleUrls(ch58.body, '58', '034'),
  ]
  console.log(`conveyancing_title: harvested ${conveyancing.length} section URLs (art 21/22/34)`)

  // condo_coop: ch58 art 31 + 37
  const condo = [
    ...harvestArticleUrls(ch58.body, '58', '031'),
    ...harvestArticleUrls(ch58.body, '58', '037'),
  ]
  console.log(`condo_coop: harvested ${condo.length} section URLs (art 31/37)`)

  // broker_licensing: ch58 art 30
  const broker = harvestArticleUrls(ch58.body, '58', '030')
  console.log(`broker_licensing: harvested ${broker.length} section URLs (art 30)`)

  // mortgage_lien_foreclosure: ch58 art 23 + ch60 art 11 + ch60 art 24
  const mortgage = [
    ...harvestArticleUrls(ch58.body, '58', '023'),
    ...harvestArticleUrls(ch60.body, '60', '011'),
    ...harvestArticleUrls(ch60.body, '60', '024'),
  ]
  console.log(`mortgage_lien_foreclosure: harvested ${mortgage.length} section URLs (58a23/60a11/60a24)`)

  // general_real_property: ch58 art 5 + art-22 estate catch-alls + ch60 60-503
  const general = [
    ...harvestArticleUrls(ch58.body, '58', '005'),
    ...pickUrls(ch58.body, '58', ['058_022_0002.html', '058_022_0008.html']),
    ...pickUrls(ch60.body, '60', ['060_005_0003.html']),
  ]
  console.log(`general_real_property: ${general.length} section URLs (art 5 + 58-2202/2208 + 60-503)`)

  const counts: Record<string, number> = {}
  counts['conveyancing_title'] = await ingestCategory('conveyancing_title', conveyancing)
  counts['condo_coop'] = await ingestCategory('condo_coop', condo)
  counts['broker_licensing'] = await ingestCategory('broker_licensing', broker)
  counts['mortgage_lien_foreclosure'] = await ingestCategory('mortgage_lien_foreclosure', mortgage)
  counts['general_real_property'] = await ingestCategory('general_real_property', general)

  const total = Object.values(counts).reduce((a, b) => a + b, 0)
  console.log(`\nKS done. inserted=${total}`, counts)
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
