/**
 * West Virginia real-estate statute full-text ingester (sanctioned
 * retrieve+cite+date carve-out — verbatim statute TEXT only, never advice).
 *
 * Source: the official WV Legislature code site, code.wvlegislature.gov. It is a
 * WordPress/"Decree" theme app but every statute section is fully present in the
 * STATIC server-rendered HTML (no JS render needed — raw_http curl with a
 * browser UA is enough). The URL scheme is clean and predictable:
 *
 *   chapter index   /<CH>/                   e.g. /36/    (lists ARTICLE anchors)
 *   article index   /<CH>-<ART>/             e.g. /36-3/  (lists SECTION anchors)
 *   section page     /<CH>-<ART>-<SEC>/       e.g. /36-3-2/ (the statute text)
 *
 * The chapter index renders article links as
 *   <div class='art-head'><a href='/36-3/'>ARTICLE 3. ...</a></div>
 * (single-quoted hrefs). Each article page renders its section links as
 *   <a href='/36-3-2/'>...</a>
 * On a section page the statute body is the single container
 *   <div class='sectiontext ...'><h4>§36-3-2. Catchline. </h4><p>body…</p></div>
 * The <h4> is the catchline; the <p> runs after it are the statute paragraphs
 * (UCIOA sections keep (a)/(b)/(1) inline). Everything outside that div — the
 * chapter/article <select> dropdowns, prev/next nav (div.secdiv), the
 * email/PDF/docx action icons, the page footer — is chrome and is excluded by
 * scoping extraction to div.sectiontext only.
 *
 * Repealed/reserved sections render as <p>[Repealed.]</p> or <p>Repealed.</p>
 * (sometimes followed by an Acts cite); they are detected on the first body
 * paragraph and dropped, along with empty / <20-char bodies.
 *
 * CATEGORY MAPPING (law_category == act_key == the category key). Each category
 * is one or more (chapter, [article-allowlist]) scopes. An undefined article
 * allowlist means "every article in the chapter".
 *
 *   conveyancing_title        Ch 36 (Estates and Property) + Ch 39 Art 1
 *                             (Recordation) + Ch 40 (Fraudulent/Preferred Conv.)
 *   condo_coop                Ch 36B (UCIOA) + Ch 36A (legacy Unit Property Act)
 *   broker_licensing          Ch 30 Art 40 (Real Estate License Act) + Ch 37
 *                             Art 14 (Appraiser Licensing & Certification Act)
 *   mortgage_lien_foreclosure Ch 38 (Liens — deeds of trust / trustee sales /
 *                             mechanics' / other liens)
 *   general_real_property     Ch 37 (Real Property — minus Art 14, which is
 *                             broker/appraiser) + Ch 55 Art 2 (Limitation of
 *                             Actions — adverse-possession SoL)
 *
 * Run: cd apps/api && node -r ts-node/register src/db/ingestWVRealEstate.ts
 * Idempotent (ON CONFLICT DO NOTHING). Reuses stripTags from the corpus
 * framework. Official source only; verbatim; honest counts.
 */

import { execFileSync } from 'child_process'
import { query } from './index'
import { stripTags } from './ingestStateLawCorpus'

const STATE = 'WV'
const SOURCE_DATE = '2026-06-14'
const EFFECTIVE_YEAR = 2026
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) GAM-statute-ingest/1.0'
const BASE = 'https://code.wvlegislature.gov'

interface Parsed { number: string; title: string | null; text: string }

/** One (chapter, optional article-allowlist) scope to enumerate. */
interface Scope { chapter: string; articles?: string[] }

/** A category maps to a list of scopes. law_category == act_key == key. */
const CATEGORIES: Record<string, Scope[]> = {
  conveyancing_title: [
    { chapter: '36' }, // Estates and Property (Art 1, 3, 4, 12, ... all articles)
    { chapter: '39', articles: ['1'] }, // Recordation and Registration of Documents
    { chapter: '40' }, // Fraudulent and Preferred Conveyances
  ],
  condo_coop: [
    { chapter: '36B' }, // Uniform Common Interest Ownership Act
    { chapter: '36A' }, // legacy Unit Property Act (pre-UCIOA condominiums)
  ],
  broker_licensing: [
    { chapter: '30', articles: ['40'] }, // Real Estate License Act
    { chapter: '37', articles: ['14'] }, // Real Estate Appraiser Licensing & Certification Act
  ],
  mortgage_lien_foreclosure: [
    { chapter: '38' }, // Liens — deeds of trust, trustee sales, mechanics' liens, etc.
  ],
  general_real_property: [
    // Ch 37 Real Property, every article EXCEPT 14 (appraisers → broker_licensing).
    { chapter: '37' },
    { chapter: '55', articles: ['2'] }, // Limitation of Actions (adverse-possession SoL)
  ],
}

// Articles excluded from a chapter when it is otherwise enumerated whole, to
// avoid cross-category duplication (Ch 37 Art 14 belongs to broker_licensing).
const ARTICLE_EXCLUDE: Record<string, Set<string>> = {
  general_real_property: new Set(['37-14']),
}

function curl(url: string): string {
  const buf = execFileSync('curl', ['-sL', '--max-time', '60', '-A', UA, url], {
    maxBuffer: 256 * 1024 * 1024,
  })
  return buf.toString('utf-8')
}

/**
 * Scrape article keys (e.g. '3', '6A', '12') from a chapter index page. Article
 * links live in <div class='art-head'><a href='/<CH>-<ART>/'>. Hrefs are
 * single-quoted. De-dupe, preserve discovery order.
 */
function scrapeArticles(html: string, chapter: string): string[] {
  const re = new RegExp(`href=['"]/${chapter}-([0-9]+[A-Z]?)/['"]`, 'g')
  const seen = new Set<string>()
  const out: string[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) {
    if (!seen.has(m[1])) {
      seen.add(m[1])
      out.push(m[1])
    }
  }
  return out
}

/**
 * Scrape section keys for a given chapter+article from the article index page.
 * Section links are /<CH>-<ART>-<SEC>/ where SEC may carry a letter suffix
 * (e.g. 5A). Only match anchors for THIS article (exact CH-ART prefix) so a
 * stray cross-reference to another article isn't pulled in.
 */
function scrapeSections(html: string, chapter: string, article: string): string[] {
  const re = new RegExp(`href=['"]/${chapter}-${article}-([0-9]+[A-Z]?)/['"]`, 'g')
  const seen = new Set<string>()
  const out: string[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) {
    if (!seen.has(m[1])) {
      seen.add(m[1])
      out.push(m[1])
    }
  }
  return out
}

/**
 * Parse a section page. Scope to the single <div class='sectiontext ...'>
 * container (excludes the chapter/article selectors, prev/next nav, action
 * icons, footer). catchline = the <h4>; body = the <p> paragraphs after it.
 * Returns null for repealed / reserved / empty / <20-char bodies.
 */
function parseSectionPage(html: string, sectionNumber: string): Parsed | null {
  const block = html.match(/<div class=['"]sectiontext[^'"]*['"]>([\s\S]*?)<\/div>/i)
  if (!block) return null
  const inner = block[1]

  const h4 = inner.match(/<h4[^>]*>([\s\S]*?)<\/h4>/i)
  const rawCatch = h4 ? stripTags(h4[1], false).trim() : ''

  // Title = catchline minus the leading "§<num>." citation.
  let title: string | null = rawCatch
    .replace(/^§\s*[0-9A-Za-z.\-]+\.?\s*/, '')
    .trim()
  if (!title) title = null

  // Body = everything in the container after the </h4>.
  const afterH4 = h4 ? inner.slice((h4.index ?? 0) + h4[0].length) : inner
  // Pull the <p> paragraphs verbatim (preserve order); fall back to the whole
  // remainder if the section uses no <p> wrapping.
  const ps = [...afterH4.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)].map((m) =>
    stripTags(m[1], true).trim()
  )
  const paras = ps.length ? ps : [stripTags(afterH4, true).trim()]
  const body = paras.filter(Boolean).join('\n').trim()

  // Repealed / reserved detection on the first body paragraph + the catchline.
  const first = (paras[0] || '').trim()
  if (/^\[?\s*repealed\b/i.test(first)) return null
  if (/^\[?\s*reserved\b/i.test(first)) return null
  if (title && /^repealed\b/i.test(title)) return null
  if (title && /^\[?reserved\.?\]?$/i.test(title)) return null

  if (!body || body.length < 20) return null
  return { number: sectionNumber, title, text: body }
}

async function ingestCategory(cat: string, scopes: Scope[]): Promise<number> {
  let ok = 0
  let skipped = 0
  let attempted = 0
  const exclude = ARTICLE_EXCLUDE[cat] || new Set<string>()

  for (const scope of scopes) {
    const ch = scope.chapter
    // Resolve the article list: explicit allowlist, else scrape the chapter index.
    let articles: string[]
    if (scope.articles) {
      articles = scope.articles
    } else {
      const idx = curl(`${BASE}/${ch}/`)
      articles = scrapeArticles(idx, ch)
    }
    for (const art of articles) {
      const artKey = `${ch}-${art}`
      if (exclude.has(artKey)) continue
      const artHtml = curl(`${BASE}/${artKey}/`)
      const secs = scrapeSections(artHtml, ch, art)
      for (let i = 0; i < secs.length; i += 4) {
        const batch = secs.slice(i, i + 4)
        const results = await Promise.all(
          batch.map(async (sec) => {
            const number = `${ch}-${art}-${sec}` // e.g. 36-3-2 (full citation tail)
            const url = `${BASE}/${number}/`
            try {
              return { p: parseSectionPage(curl(url), number), url, number }
            } catch (e: any) {
              console.warn(`  ! ${cat} §${number}: ${e?.message || e}`)
              return { p: null, url, number }
            }
          })
        )
        for (const { p, url } of results) {
          attempted++
          if (!p) {
            skipped++
            continue
          }
          await query(
            `INSERT INTO state_law_section_texts
               (state_code, act_key, section_number, section_title, full_text,
                source_url, source_date, effective_year, law_category)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
             ON CONFLICT (state_code, act_key, section_number, effective_year) DO NOTHING`,
            [STATE, cat, p.number, p.title, p.text, url, SOURCE_DATE, EFFECTIVE_YEAR, cat]
          )
          ok++
        }
        await new Promise((r) => setTimeout(r, 150)) // politeness
      }
      process.stdout.write(`\r  [${cat}] ${artKey}: ${secs.length} secs (running ok=${ok})        `)
    }
  }
  console.log(`\n  [${cat}] inserted ${ok}, skipped ${skipped} of ${attempted} attempted`)
  return ok
}

async function main() {
  console.log(`\n=== WV — ingesting real-estate statute corpus (as of ${SOURCE_DATE}) ===`)
  const counts: Record<string, number> = {}
  for (const [cat, scopes] of Object.entries(CATEGORIES)) {
    counts[cat] = await ingestCategory(cat, scopes)
  }
  const total = Object.values(counts).reduce((a, b) => a + b, 0)
  console.log(`\nWV done. inserted=${total}`, counts)
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
