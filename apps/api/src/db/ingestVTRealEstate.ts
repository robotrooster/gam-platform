/**
 * Vermont non-tax real-estate statute full-text ingester (S472 corpus).
 *
 * Sanctioned retrieve+cite+date carve-out: official statute TEXT only, stored
 * VERBATIM with source URL + source date. Never advice. Powers the both-party
 * hedged compliance-warning KB (see project_state_law_kb).
 *
 * SOURCE: legislature.vermont.gov — static server-rendered HTML (raw HTTP, no
 * JS render needed; verified by curl across all titles touched here). Each
 * statute section lives at /statutes/section/{title}/{chapter}/{section} where
 * chapter is 3-digit zero-padded and section is 5-digit zero-padded.
 *
 * PAGE LAYOUT (verified S472):
 *   <h2 class="statute-title">   Title NN: Name        (title context)
 *   <h3 class="statute-chapter"> Chapter NNN: Name     (chapter context)
 *   <h4 class="statute-section"> Subchapter ...         (MISLEADING name — this
 *                                                        is the subchapter header,
 *                                                        NOT the section body)
 *   <b>(Cite as: NN V.S.A. § NNN)</b>
 *   <ul class="item-list statutes-detail">              (THE section body)
 *      <li> <p><b>§ NNN. Catchline</b></p>
 *           <p>(a) ... body paragraphs ... (history note)</p> ... </li>
 *   </ul>
 * The catchline is the first <b>§ ...</b> paragraph inside the detail ul. Body =
 * every <p> in the ul (incl. the trailing "(Amended ...)" history note, which the
 * carve-out permits as the source-note trailer). We collapse intra-paragraph
 * whitespace (the site hard-wraps prose with source newlines) and keep one
 * newline between paragraphs.
 *
 * ENUMERATION: each chapter index /statutes/chapter/{title}/{chapter} lists every
 * /statutes/section/... link directly — we harvest those. Title 27A (UCIOA) has
 * NO per-section links and uses article-section numbering (§ 2-101); we enumerate
 * its section numbers from the fullchapter pages and build the URL by hand
 * (article→3-digit path segment, post-dash number→5-digit section segment;
 * lowercase '27a' in the path — the canonical-cased path returns a nav shell).
 *
 * RECIPE CORRECTIONS made at run time (code wins over the handoff recipe):
 *   - Title 27 has NO Ch.7 "Mortgages" and NO standalone recording chapter.
 *     VT's substantive real-property chapters are Ch.1 Estates, Ch.3 Homestead,
 *     Ch.5 Conveyance, Ch.15 Condominium Act, Ch.17 Land Plats. The recipe's
 *     "Ch.3 recording / Ch.7 mortgages overlaps" claim does not hold; those
 *     chapters do not exist in Title 27. Mortgage-substantive law is folded into
 *     the foreclosure chapter (Title 12 Ch.172) for the corpus.
 *   - Adverse-possession §501 (Recovery of lands; 15-yr limitation) is in
 *     Title 12 Chapter 023 (Limitation of Actions), NOT Ch.003 as the recipe URL
 *     stated. /12/003/00501 returns an empty cite; /12/023/00501 is correct.
 *   - Title 9 Ch.51 is "Miscellaneous Liens" (mixed lien types). Only the
 *     Contractors' Liens subchapter (§§1921-1928) is real-estate mechanic's-lien
 *     law; the rest (artisan, wage, log, stallion, animal liens) is out of scope.
 *
 * CATEGORY MAP (act_key == law_category for every block, per spec):
 *   conveyancing_title        = Title 27 Ch.5 (Conveyance of Real Estate)
 *   condo_coop                = Title 27A Arts 1-4 (UCIOA) + Title 27 Ch.15 (legacy
 *                               Condominium Ownership Act, pre-1999 projects)
 *   broker_licensing          = Title 26 Ch.41 (Brokers) + Ch.69 (Appraisers)
 *   mortgage_lien_foreclosure = Title 12 Ch.172 (Foreclosure) + Title 9 Ch.51
 *                               §§1921-1928 (Contractors' Liens subchapter)
 *   general_real_property     = Title 27 Ch.1 (Estates) + Ch.3 (Homestead) +
 *                               Ch.17 (Land Plats) + 12 V.S.A. §501 (adverse poss.)
 *
 * Run: cd apps/api && node -r ts-node/register src/db/ingestVTRealEstate.ts
 * Idempotent (ON CONFLICT DO NOTHING). Repealed/reserved/empty(<20)/TOC/nav drop.
 */

import { execFileSync } from 'child_process'
import { query } from './index'

const STATE = 'VT'
const SOURCE_DATE = '2026-06-14'
const EFFECTIVE_YEAR = 2026
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) GAM-statute-ingest/1.0'
const BASE = 'https://legislature.vermont.gov'

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

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
}

/** A single statute paragraph → clean prose (collapse intra-para source wrap). */
function cleanPara(html: string): string {
  let s = html.replace(/<[^>]+>/g, ' ')
  s = decodeEntities(s)
  // Collapse ALL whitespace (incl. the site's hard-wrap newlines) within a
  // paragraph; unicode spaces too.
  s = s.replace(/[\u00a0\u2000-\u200b\u202f\u205f\u3000]/g, ' ').replace(/\s+/g, ' ')
  return s.trim()
}

/**
 * Parse a VT statute section page. catchline = first <b>§ ...</b> inside the
 * detail ul; body = the catchline + every following paragraph in the ul, joined
 * with single newlines. Returns null for repealed / reserved / empty pages.
 */
function parseSection(html: string, expectedNumber: string): Parsed | null {
  const ulMatch = html.match(/<ul class="item-list statutes-detail">([\s\S]*?)<\/ul>/i)
  if (!ulMatch) return null
  const ul = ulMatch[1]

  const paras = [...ul.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)]
    .map((m) => cleanPara(m[1]))
    .filter(Boolean)
  if (paras.length === 0) return null

  // Locate the catchline (first paragraph starting with §).
  let catchIdx = paras.findIndex((p) => /^§/.test(p))
  if (catchIdx === -1) {
    // Some single-paragraph sections embed the § run-in; fall back to para 0.
    catchIdx = 0
  }
  const catchline = paras[catchIdx]

  // Title = catchline minus the leading "§ NNN." citation. VT marks dead
  // sections as "[Repealed.]" / "[Reserved for future use.]" — both are bracketed
  // stubs with no substantive body; drop them.
  let title: string | null = catchline.replace(/^§\s*[0-9A-Za-z.:-]+\.?\s*/, '').trim()
  if (!title) title = null
  if (title && /^\[?\s*repealed\b/i.test(title)) return null
  if (title && /^\[?\s*reserved\b/i.test(title)) return null

  // Body = catchline paragraph onward, verbatim, one newline per paragraph. A
  // reserved/repealed stub's only paragraph IS the catchline, so guard the body
  // too in case the catchline carried a different leading token.
  const body = paras.slice(catchIdx).join('\n').trim()
  if (!body || body.length < 20) return null
  if (/^§\s*[0-9A-Za-z.:-]+\.?\s*\[?\s*(reserved|repealed)\b/i.test(body)) return null

  return { number: expectedNumber, title, text: body }
}

/** Harvest every section URL listed on a chapter-index page. */
function harvestChapter(title: string, chapter: string): string[] {
  const html = curl(`${BASE}/statutes/chapter/${title}/${chapter}`)
  const re = new RegExp(`/statutes/section/${title}/${chapter}/(\\d+)`, 'g')
  const seen = new Set<string>()
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) seen.add(m[1])
  return [...seen].sort()
}

interface Target {
  url: string
  number: string // human citation, e.g. "341" or "2-101"
}

/** Build section targets for a normal numeric chapter (optionally range-scoped). */
function chapterTargets(
  title: string,
  chapter: string,
  filter?: (secNum: number) => boolean
): Target[] {
  return harvestChapter(title, chapter)
    .map((sec) => ({
      url: `${BASE}/statutes/section/${title}/${chapter}/${sec}`,
      number: String(parseInt(sec, 10)), // strip zero-pad for human citation
    }))
    .filter((t) => (filter ? filter(parseInt(t.number, 10)) : true))
}

/**
 * Build targets for a Title 27A article. Section numbers are "A-NNN"; the URL is
 * /statutes/section/27a/{article:3-digit}/{NNN:5-digit}. Enumerated from the
 * fullchapter page's § catchlines.
 */
function uciowaArticleTargets(article: number): Target[] {
  const path3 = String(article).padStart(3, '0')
  const html = curl(`${BASE}/statutes/fullchapter/27A/${path3}`)
  const seen = new Set<string>()
  const re = /§\s*(\d+)-(\d+(?:\.\d+)?)\b/g
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) {
    if (parseInt(m[1], 10) !== article) continue
    seen.add(m[2])
  }
  return [...seen]
    .sort((a, b) => parseFloat(a) - parseFloat(b))
    .map((post) => {
      const sec5 = String(Math.round(parseFloat(post))).padStart(5, '0')
      return {
        url: `${BASE}/statutes/section/27a/${path3}/${sec5}`,
        number: `${article}-${post}`,
      }
    })
}

async function ingestCategory(cat: string, targets: Target[]): Promise<number> {
  let ok = 0
  let skipped = 0
  const CONC = 4
  for (let i = 0; i < targets.length; i += CONC) {
    if (i > 0) await new Promise((r) => setTimeout(r, 250)) // politeness
    const batch = targets.slice(i, i + CONC)
    const parsed = await Promise.all(
      batch.map(async (t) => {
        try {
          return { p: parseSection(curl(t.url), t.number), t }
        } catch (e: any) {
          console.warn(`  ! ${cat} ${t.number}: ${e?.message || e}`)
          return { p: null, t }
        }
      })
    )
    for (const { p, t } of parsed) {
      if (!p || !p.text || p.text.length < 20) {
        skipped++
        continue
      }
      await query(
        `INSERT INTO state_law_section_texts
           (state_code, act_key, section_number, section_title, full_text, source_url, source_date, effective_year, law_category)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (state_code, act_key, section_number, effective_year) DO NOTHING`,
        [STATE, cat, p.number, p.title, p.text, t.url, SOURCE_DATE, EFFECTIVE_YEAR, cat]
      )
      ok++
    }
    process.stdout.write(`\r  [${cat}] ${Math.min(i + CONC, targets.length)}/${targets.length}`)
  }
  console.log(`\n  [${cat}] inserted ${ok}, skipped ${skipped} of ${targets.length}`)
  return ok
}

async function main() {
  console.log(`\n=== VT — ingesting real-estate statute corpus (as of ${SOURCE_DATE}) ===`)

  // 1) conveyancing_title — Title 27 Ch.5 (Conveyance of Real Estate)
  const conveyancing = chapterTargets('27', '005')
  console.log(`conveyancing_title: ${conveyancing.length} sections (27 V.S.A. Ch.5)`)

  // 2) condo_coop — Title 27A UCIOA Arts 1-4 + Title 27 Ch.15 legacy Condo Act
  const condo: Target[] = [
    ...uciowaArticleTargets(1),
    ...uciowaArticleTargets(2),
    ...uciowaArticleTargets(3),
    ...uciowaArticleTargets(4),
    ...chapterTargets('27', '015'),
  ]
  console.log(`condo_coop: ${condo.length} sections (27A Arts 1-4 + 27 V.S.A. Ch.15)`)

  // 3) broker_licensing — Title 26 Ch.41 Brokers + Ch.69 Appraisers
  const broker: Target[] = [...chapterTargets('26', '041'), ...chapterTargets('26', '069')]
  console.log(`broker_licensing: ${broker.length} sections (26 V.S.A. Ch.41 + Ch.69)`)

  // 4) mortgage_lien_foreclosure — Title 12 Ch.172 Foreclosure + Title 9 Ch.51
  //    Contractors' Liens subchapter (§§1921-1928 only).
  const foreclosure: Target[] = [
    ...chapterTargets('12', '172'),
    ...chapterTargets('09', '051', (n) => n >= 1921 && n <= 1928),
  ]
  console.log(
    `mortgage_lien_foreclosure: ${foreclosure.length} sections (12 V.S.A. Ch.172 + 9 V.S.A. §§1921-1928)`
  )

  // 5) general_real_property — Title 27 Ch.1 Estates + Ch.3 Homestead + Ch.17
  //    Land Plats + 12 V.S.A. §501 adverse-possession limitation.
  const general: Target[] = [
    ...chapterTargets('27', '001'),
    ...chapterTargets('27', '003'),
    ...chapterTargets('27', '017'),
    { url: `${BASE}/statutes/section/12/023/00501`, number: '501' },
  ]
  console.log(`general_real_property: ${general.length} sections (27 V.S.A. Ch.1/3/17 + 12 V.S.A. §501)`)

  const counts: Record<string, number> = {}
  counts['conveyancing_title'] = await ingestCategory('conveyancing_title', conveyancing)
  counts['condo_coop'] = await ingestCategory('condo_coop', condo)
  counts['broker_licensing'] = await ingestCategory('broker_licensing', broker)
  counts['mortgage_lien_foreclosure'] = await ingestCategory('mortgage_lien_foreclosure', foreclosure)
  counts['general_real_property'] = await ingestCategory('general_real_property', general)

  const total = Object.values(counts).reduce((a, b) => a + b, 0)
  console.log(`\nVT done. inserted=${total}`, counts)
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
