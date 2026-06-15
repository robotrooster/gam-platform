/**
 * Nebraska non-tax real-estate statute full-text ingester (sanctioned
 * retrieve+cite+date carve-out — verbatim statutory prose only, never advice).
 *
 * Source: Nebraska Legislature (official) — https://nebraskalegislature.gov.
 * Each section is a static, server-rendered HTML page (raw_http, no JS):
 *   https://nebraskalegislature.gov/laws/statutes.php?statute={CHAP}-{SEC}
 * Section numbers carry two NE-specific quirks: dotted sub-sections
 * (76-238.01) and comma overflow forms (76-2,126). Rather than derive the
 * (irregular) section list from arithmetic, we HARVEST the exact section list
 * from each chapter's browse index:
 *   https://nebraskalegislature.gov/laws/browse-chapters.php?chapter={CHAP}
 * The index lists every live + repealed section as a statutes.php?statute=
 * anchor, so the harvest is authoritative and self-correcting. We then filter
 * the harvested numbers to each category's section range and fetch each page.
 *
 * STATUTE PAGE LAYOUT (verified against live pages):
 *   <div class="statute">
 *     <h2>76-238.</h2>                          <-- section number
 *     <h3>Deeds and other instruments; ...</h3> <-- catchline (may span lines)
 *     <p class="text-justify">(1) ...</p>        <-- body chunk 1
 *     <p class="text-justify">(2) ...</p>        <-- body chunk 2
 *     <div>
 *       <h2>Source</h2> <ul>...history...</ul>   <-- legislative history
 *     </div>
 *     <div class="statute_source">
 *       <h2>Annotations</h2> <ul>...case law...</ul>  <-- EDITORIAL, not statute
 *     </div>
 *   </div>
 * The body is ONLY the p.text-justify paragraphs that precede the inner
 * "<h2>Source</h2>" marker. Legislative history (Source) and case annotations
 * (Annotations) are dropped — case annotations are editorial, not statutory.
 * Repealed sections render as <h3>Repealed. Laws ...</h3> with no body
 * paragraph -> dropped by the repealed-title check + the <20-char body check.
 *
 * CATEGORY -> SECTION-RANGE MAPPING (act_key == law_category == category key):
 *   conveyancing_title         Ch 76 Art 2 Conveyances: 76-201..76-298
 *                              (definitions, formalities of execution,
 *                              acknowledgment/proof, recording, curative acts,
 *                              special conveyances, marketable title) + the
 *                              76-2,126 conveyance overflow (death-certificate
 *                              filing on certain conveyances).
 *   condo_coop                 Nebraska Condominium Act 76-825..76-894 +
 *                              older Condominium Property Act / apartment-
 *                              ownership cooperative provisions 76-801..76-824.
 *   broker_licensing           Nebraska Real Estate License Act
 *                              81-885..81-885.56 (dotted sub-section run).
 *   mortgage_lien_foreclosure  Construction Lien Act 52-125..52-159 +
 *                              Nebraska Trust Deeds Act 76-1001..76-1018
 *                              (non-judicial power-of-sale) + judicial
 *                              mortgage-foreclosure procedure Ch 25
 *                              25-2137..25-2155 (decree, sale, deed, proceeds,
 *                              satisfaction).
 *   general_real_property      Ch 76 catch-all OUTSIDE the sub-acts above:
 *                              estates/definitions 76-101..76-130, future
 *                              interests / reverter 76-299 + 76-2,100..76-2,125
 *                              & 76-2,127..76-2,142 (uniform real-property act
 *                              overflow) + adverse-possession limitation period
 *                              25-202 (10-year action to recover real estate,
 *                              which lives in Ch 25, not Ch 76).
 *
 * No category overlap: conveyancing_title owns 76-201..76-298 + 76-2,126;
 * general_real_property owns 76-101..76-130 + 76-299 + the rest of the 76-2,1xx
 * overflow + 25-202. Condo (76-801..76-894) and trust deeds (76-1001..76-1018)
 * are disjoint section bands. (76-825..76-894 are the Condominium Act; 76-801..
 * 76-824 the older apartment-ownership/cooperative provisions — both condo_coop.)
 *
 * Run: cd apps/api && node -r ts-node/register src/db/ingestNERealEstate.ts
 * Idempotent (ON CONFLICT DO NOTHING). Official source only. Verbatim.
 */

import { execFileSync } from 'child_process'
import { query } from './index'
import { stripTags } from './ingestStateLawCorpus'

const STATE = 'NE'
const SOURCE_DATE = '2026-06-14'
const EFFECTIVE_YEAR = 2026
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) GAM-statute-ingest/1.0'
const ORIGIN = 'https://nebraskalegislature.gov'

const statuteUrl = (sec: string) => `${ORIGIN}/laws/statutes.php?statute=${encodeURIComponent(sec)}`
const browseUrl = (chap: string) => `${ORIGIN}/laws/browse-chapters.php?chapter=${chap}`

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
 * Harvest every section citation (e.g. "76-238", "76-238.01", "76-2,126") for a
 * chapter from its browse-index page. De-dupes (each section appears as both a
 * view link and a print link) and excludes the &print=true variants.
 */
function harvestChapterSections(indexHtml: string, chap: string): string[] {
  const re = new RegExp(`statutes\\.php\\?statute=(${chap}-[0-9][0-9A-Za-z.,-]*?)(?:&|")`, 'g')
  const seen = new Set<string>()
  const out: string[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(indexHtml)) !== null) {
    if (seen.has(m[1])) continue
    seen.add(m[1])
    out.push(m[1])
  }
  return out
}

/**
 * Parse a NE section citation into structured parts for range filtering.
 *   "76-238"     -> { chap:76, comma:0,   main:238, dot:0   }
 *   "76-238.01"  -> { chap:76, comma:0,   main:238, dot:1   }
 *   "76-2,126"   -> { chap:76, comma:2,   main:126, dot:0   }
 * `comma` is the article-overflow prefix (the "2" in "76-2,126"); 0 when absent.
 * `main` is the principal section ordinal; `dot` is the dotted sub-section.
 */
function parseCite(sec: string): { chap: number; comma: number; main: number; dot: number } | null {
  const m = sec.match(/^(\d+)-(?:(\d+),)?(\d+)(?:\.(\d+))?$/)
  if (!m) return null
  return {
    chap: parseInt(m[1], 10),
    comma: m[2] ? parseInt(m[2], 10) : 0,
    main: parseInt(m[3], 10),
    dot: m[4] ? parseInt(m[4], 10) : 0,
  }
}

/** Stable sort key for NE citations: comma band, then main ordinal, then dotted sub. */
function sortKey(sec: string): number {
  const p = parseCite(sec)
  if (!p) return Number.MAX_SAFE_INTEGER
  // comma band dominates ordering (76-2,1xx sorts as its own band after the
  // plain 76-xxx run), then main ordinal, then dotted sub-section.
  return p.comma * 1e9 + p.main * 1000 + p.dot
}

/**
 * Parse a NE statute page. Restrict to <div class="statute">, cut at the inner
 * "<h2>Source</h2>" so legislative history + case annotations never enter the
 * body. number = first <h2>; title = <h3> catchline; body = all p.text-justify
 * before the Source cut. Returns null for repealed/reserved/empty/404 pages.
 */
function parseLawPage(html: string): Parsed | null {
  const startIdx = html.indexOf('class="statute"')
  if (startIdx === -1) return null
  let region = html.slice(startIdx)
  // Cut everything from the legislative-history block onward (Source + the
  // following Annotations div are both after this marker).
  const srcCut = region.search(/<h2>\s*Source\s*<\/h2>/i)
  if (srcCut !== -1) region = region.slice(0, srcCut)

  // Section number = the first <h2> (e.g. "76-238."). Strip trailing period.
  const numM = region.match(/<h2>([\s\S]*?)<\/h2>/i)
  if (!numM) return null
  const number = stripTags(numM[1], false).replace(/\.+$/, '').trim()
  if (!number) return null

  // Catchline = the <h3> (may span multiple lines -> DOTALL).
  const capM = region.match(/<h3>([\s\S]*?)<\/h3>/i)
  let title: string | null = capM ? stripTags(capM[1], false).replace(/\s+/g, ' ').trim() : null
  if (title) title = title.replace(/\.$/, '').trim()
  if (!title) title = null
  if (title && /^repealed\b/i.test(title)) return null
  if (title && /^transferred\b/i.test(title)) return null
  if (title && /^\[?reserved\.?\]?$/i.test(title)) return null

  // Body = every p.text-justify paragraph before the Source cut.
  const paras = [...region.matchAll(/<p class="text-justify">([\s\S]*?)<\/p>/gi)]
    .map((m) => stripTags(m[1], true).trim())
    .filter(Boolean)
  const body = paras.join('\n').replace(/\n{3,}/g, '\n\n').trim()

  if (!body || body.length < 20) return null
  if (/^\[?reserved\.?\]?$/i.test(body)) return null
  if (/^repealed\b/i.test(body)) return null

  return { number, title, text: body }
}

async function ingestCategory(cat: string, sections: string[]): Promise<number> {
  let ok = 0
  let skipped = 0
  let notFound = 0
  const CONC = 4
  for (let i = 0; i < sections.length; i += CONC) {
    if (i > 0) await new Promise((r) => setTimeout(r, 250)) // politeness
    const batch = sections.slice(i, i + CONC)
    const results = batch.map((sec) => {
      try {
        const { status, body } = fetchUrl(statuteUrl(sec))
        if (status === 404) {
          notFound++
          return { p: null as Parsed | null, sec }
        }
        return { p: parseLawPage(body), sec }
      } catch (e: any) {
        console.warn(`  ! ${cat} ${sec}: ${e?.message || e}`)
        return { p: null as Parsed | null, sec }
      }
    })
    for (const { p, sec } of results) {
      if (!p || !p.text || p.text.length < 20) {
        skipped++
        continue
      }
      await query(
        `INSERT INTO state_law_section_texts
           (state_code, act_key, section_number, section_title, full_text, source_url, source_date, effective_year, law_category)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (state_code, act_key, section_number, effective_year) DO NOTHING`,
        [STATE, cat, p.number, p.title, p.text, statuteUrl(sec), SOURCE_DATE, EFFECTIVE_YEAR, cat]
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
  console.log(`\n=== NE — ingesting non-tax real-estate full-text corpus (as of ${SOURCE_DATE}) ===`)

  // Fetch the four chapter indexes once; harvest section lists from them.
  const idx76 = fetchUrl(browseUrl('76'))
  const idx81 = fetchUrl(browseUrl('81'))
  const idx52 = fetchUrl(browseUrl('52'))
  const idx25 = fetchUrl(browseUrl('25'))
  for (const [c, r] of [['76', idx76], ['81', idx81], ['52', idx52], ['25', idx25]] as const) {
    if (r.status !== 200) throw new Error(`chapter ${c} index fetch failed: status ${r.status}`)
  }
  const all76 = harvestChapterSections(idx76.body, '76')
  const all81 = harvestChapterSections(idx81.body, '81')
  const all52 = harvestChapterSections(idx52.body, '52')
  const all25 = harvestChapterSections(idx25.body, '25')
  console.log(
    `harvested chapter section lists: ch76=${all76.length}, ch81=${all81.length}, ch52=${all52.length}, ch25=${all25.length}`
  )

  const sortAsc = (arr: string[]) => [...arr].sort((a, b) => sortKey(a) - sortKey(b))

  // conveyancing_title: Ch 76 Art 2 conveyances 76-201..76-298 + 76-2,126.
  const conveyancing = sortAsc(
    all76.filter((s) => {
      const p = parseCite(s)
      if (!p) return false
      if (p.comma === 0 && p.main >= 201 && p.main <= 298) return true
      if (p.comma === 2 && p.main === 126) return true // 76-2,126 conveyance overflow
      return false
    })
  )
  console.log(`conveyancing_title: ${conveyancing.length} sections (76-201..76-298 + 76-2,126)`)

  // condo_coop: Condominium Act 76-825..76-894 + apartment-ownership 76-801..76-824.
  const condo = sortAsc(
    all76.filter((s) => {
      const p = parseCite(s)
      return !!p && p.comma === 0 && p.main >= 801 && p.main <= 894
    })
  )
  console.log(`condo_coop: ${condo.length} sections (76-801..76-894)`)

  // broker_licensing: Real Estate License Act 81-885..81-885.56.
  const broker = sortAsc(
    all81.filter((s) => {
      const p = parseCite(s)
      return !!p && p.comma === 0 && p.main === 885 && p.dot <= 56
    })
  )
  console.log(`broker_licensing: ${broker.length} sections (81-885..81-885.56)`)

  // mortgage_lien_foreclosure: Construction Lien Act 52-125..52-159 +
  // Trust Deeds Act 76-1001..76-1018 + judicial foreclosure Ch 25 25-2137..25-2155.
  const mortgage = [
    ...sortAsc(
      all52.filter((s) => {
        const p = parseCite(s)
        return !!p && p.comma === 0 && p.main >= 125 && p.main <= 159
      })
    ),
    ...sortAsc(
      all76.filter((s) => {
        const p = parseCite(s)
        return !!p && p.comma === 0 && p.main >= 1001 && p.main <= 1018
      })
    ),
    ...sortAsc(
      all25.filter((s) => {
        const p = parseCite(s)
        return !!p && p.comma === 0 && p.main >= 2137 && p.main <= 2155
      })
    ),
  ]
  console.log(
    `mortgage_lien_foreclosure: ${mortgage.length} sections (52-125..52-159 + 76-1001..76-1018 + 25-2137..25-2155)`
  )

  // general_real_property: Ch 76 catch-all (estates/definitions 76-101..76-130,
  // future interests 76-299, 76-2,1xx overflow excl. the 76-2,126 conveyance
  // section) + adverse-possession limitation 25-202.
  const general = [
    ...sortAsc(
      all76.filter((s) => {
        const p = parseCite(s)
        if (!p) return false
        if (p.comma === 0 && p.main >= 101 && p.main <= 130) return true
        if (p.comma === 0 && p.main === 299) return true
        if (p.comma === 2 && p.main !== 126) return true // 76-2,1xx overflow (not the conveyance one)
        return false
      })
    ),
    ...all25.filter((s) => s === '25-202'),
  ]
  console.log(
    `general_real_property: ${general.length} sections (76-101..76-130 + 76-299 + 76-2,1xx + 25-202)`
  )

  const counts: Record<string, number> = {}
  counts['conveyancing_title'] = await ingestCategory('conveyancing_title', conveyancing)
  counts['condo_coop'] = await ingestCategory('condo_coop', condo)
  counts['broker_licensing'] = await ingestCategory('broker_licensing', broker)
  counts['mortgage_lien_foreclosure'] = await ingestCategory('mortgage_lien_foreclosure', mortgage)
  counts['general_real_property'] = await ingestCategory('general_real_property', general)

  const total = Object.values(counts).reduce((a, b) => a + b, 0)
  console.log(`\nNE done. inserted=${total}`, counts)
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
