/**
 * Rhode Island PROPERTY-TAX statute full-text ingester (sanctioned
 * retrieve+cite+date carve-out — verbatim statutory text, never advice;
 * see services/stateLaw.ts + the migration headers + CLAUDE.md S177).
 *
 * RI's official site is webserver.rilegislature.gov. The General Laws are
 * served as static, LexisNexis-"mastered" HTML — no JS, no auth, plain curl.
 * URL pattern is deterministic:
 *
 *   Title index : /Statutes/TITLE44/INDEX.HTM
 *   Chapter idx : /Statutes/TITLE44/{CHAP}/INDEX.htm   (e.g. 44-9/INDEX.htm)
 *   Section page: /Statutes/TITLE44/{CHAP}/{SECTION}.htm (e.g. 44-9/44-9-1.htm)
 *
 * Chapter INDEX.htm lists each section as
 *   <a href="44-9-1.htm">§&nbsp;44-9-1.&nbsp;Tax titles on real estate.</a>
 * (hrefs are RELATIVE to the chapter dir). Repealed sections appear in the
 * index with a "Repealed."/"Reserved." catchline; some are omitted entirely
 * (gaps in the numbering — we only crawl what the index links, so gaps are
 * naturally skipped).
 *
 * Section page layout (UTF-8, predictable):
 *   <h1>Title 44 / Taxation</h1>         (chrome — skip)
 *   <h2>Chapter 9 / Tax Sales</h2>       (chrome — skip)
 *   <h3>R.I. Gen. Laws § 44-9-1</h3>     (citation header — skip)
 *   <p><b>§ 44-9-1. Tax titles on real estate.</b></p>   <- catchline
 *   <p><b>(a)</b> Taxes assessed ...</p>                 <- body paras
 *   <p><b>(b)</b> The lien shall ...</p>
 *   <div><p>History of Section.<br>G.L. 1896 ...</p></div> <- editorial note
 *
 * Parse: catchline = first <b>§...</b> paragraph → split "§ NNNN." from title.
 * Body = the statutory paragraphs after the catchline, with the trailing
 * "History of Section." editorial block DROPPED (it is publisher annotation,
 * not statutory prose). Drop Repealed/Reserved and any body < 20 chars.
 *
 * CHAPTER MAPPING (all under one act_key='property_tax'; section numbers are
 * globally distinct across chapters, e.g. 44-3-x vs 44-5-x, so the
 * (state,act_key,section_number,year) unique key never collides):
 *   exemptions             -> Ch. 44-3, Ch. 44-33, Ch. 44-5.3
 *   assessment + review    -> Ch. 44-5 (full; §§ 44-5-26..31 are the appeal
 *                             ladder and are a subset of this chapter)
 *   levy_collection_payment-> Ch. 44-7, Ch. 44-8
 *   delinquency_tax_sale   -> Ch. 44-9
 *
 * Run: cd apps/api && node -r ts-node/register src/db/ingestRIPropertyTax.ts
 * Idempotent (ON CONFLICT DO NOTHING). Reuses stripTags from the corpus framework.
 */

import { execFileSync } from 'child_process'
import { query } from './index'
import { stripTags } from './ingestStateLawCorpus'

const STATE = 'RI'
const ACT_KEY = 'property_tax'
const LAW_CATEGORY = 'property_tax'
const SOURCE_DATE = '2026-06-14'
const EFFECTIVE_YEAR = 2026
const UA = 'GAM-statute-ingest/1.0 (compliance research)'
const BASE = 'https://webserver.rilegislature.gov/Statutes/TITLE44'

// Chapters to crawl, grouped by feature topic (topic is for logging only —
// every row is stored under act_key/law_category 'property_tax').
const CHAPTER_GROUPS: { topic: string; chapters: string[] }[] = [
  { topic: 'exemptions', chapters: ['44-3', '44-33', '44-5.3'] },
  { topic: 'assessment+assessment_review', chapters: ['44-5'] },
  { topic: 'levy_collection_payment', chapters: ['44-7', '44-8'] },
  { topic: 'delinquency_tax_sale', chapters: ['44-9'] },
]

interface SectionRef { number: string; href: string }
interface Parsed { number: string; title: string | null; text: string }

/**
 * Fetch a URL via curl. Retries the alternate casing on a 404 / empty body
 * (the RI site uses both .htm/.HTM and Statutes/statutes inconsistently).
 */
function curl(url: string): string {
  const tryGet = (u: string): string => {
    const buf = execFileSync('curl', ['-sL', '--max-time', '60', '-A', UA, u], {
      maxBuffer: 64 * 1024 * 1024,
    })
    return buf.toString('utf-8')
  }
  let html = tryGet(url)
  if (!html || html.length < 200 || /404 - File or directory not found/i.test(html)) {
    // flip .htm<->.HTM and Statutes<->statutes and retry once
    const alt = url
      .replace(/\.htm$/i, (m) => (m === '.htm' ? '.HTM' : '.htm'))
      .replace('/Statutes/', '/statutes/')
    if (alt !== url) {
      const retry = tryGet(alt)
      if (retry && retry.length >= 200) return retry
    }
  }
  return html
}

/**
 * Scrape a chapter INDEX.htm for its section links. Anchors look like
 *   <a href="44-9-1.htm">§&nbsp;44-9-1.&nbsp;Tax titles on real estate.</a>
 * href is relative to the chapter dir. De-dupe by href; preserve index order.
 */
function scrapeSectionRefs(indexHtml: string, chapter: string): SectionRef[] {
  const re = new RegExp(`href="(${chapter.replace('.', '\\.')}-[0-9A-Za-z.]+\\.htm)"`, 'gi')
  const seen = new Set<string>()
  const out: SectionRef[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(indexHtml)) !== null) {
    const href = m[1]
    if (seen.has(href.toLowerCase())) continue
    seen.add(href.toLowerCase())
    const number = href.replace(/\.htm$/i, '')
    out.push({ number, href })
  }
  return out
}

/**
 * Parse a section page. catchline = first bold paragraph beginning with "§".
 * Title = catchline minus the leading "§ NNNN." citation. Body = the
 * statutory paragraphs after the catchline, dropping the trailing
 * "History of Section." editorial block. Returns null for repealed/reserved
 * or sub-threshold bodies.
 */
function parseSection(html: string, expectedNumber: string): Parsed | null {
  // Restrict to <body> to skip the giant xmlns <html> attribute soup + <head>.
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i)
  const scope = bodyMatch ? bodyMatch[1] : html

  // Pull each <p>...</p> as readable text.
  const paras = [...scope.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)]
    .map((m) => stripTags(m[1], false).trim())
    .filter(Boolean)

  // Locate the catchline: first paragraph starting with the § marker.
  let catchIdx = -1
  for (let i = 0; i < paras.length; i++) {
    if (/^§+\s/.test(paras[i]) || /^§+ ?/.test(paras[i])) {
      catchIdx = i
      break
    }
  }
  if (catchIdx === -1) return null
  const catchline = paras[catchIdx]

  // Title = catchline with the leading citation removed. Strip the EXACT
  // section number first (handles dotted chapters like 44-5.3-3 where a greedy
  // character class would over-consume and leave "3-3." in the title), then
  // fall back to a generic "§§ A, B." range strip for multi-section catchlines.
  const escNum = expectedNumber.replace(/[.]/g, '\\.')
  let title: string | null = catchline
    .replace(new RegExp(`^§+\\s*${escNum}\\.?\\s*`), '')
    .replace(/^§+\s*[0-9A-Za-z.,\s—-]*?\.\s*/, '')
    .trim()
  if (!title) title = null
  if (title && /^\[?\s*repealed/i.test(title)) return null
  if (title && /^\[?\s*reserved\.?\s*\]?$/i.test(title)) return null

  // Body = paragraphs after the catchline, excluding the "History of Section."
  // editorial trailer (everything from that line onward is publisher note).
  const bodyParas: string[] = []
  for (let i = catchIdx + 1; i < paras.length; i++) {
    if (/^History of Section\.?/i.test(paras[i])) break
    bodyParas.push(paras[i])
  }
  const body = bodyParas.join('\n').trim()

  if (!body || body.length < 20) return null
  if (/^\[?\s*reserved\.?\s*\]?$/i.test(body)) return null
  if (/^\[?\s*repealed/i.test(body)) return null

  return { number: expectedNumber, title, text: body }
}

async function ingestChapter(chapter: string): Promise<{ ok: number; skipped: number; total: number }> {
  const indexUrl = `${BASE}/${chapter}/INDEX.htm`
  const indexHtml = curl(indexUrl)
  const refs = scrapeSectionRefs(indexHtml, chapter)
  if (refs.length === 0) {
    console.warn(`  ! ${chapter}: 0 section links found at ${indexUrl}`)
    return { ok: 0, skipped: 0, total: 0 }
  }
  let ok = 0
  let skipped = 0
  const CONC = 4
  for (let i = 0; i < refs.length; i += CONC) {
    if (i > 0) await new Promise((r) => setTimeout(r, 250)) // politeness
    const batch = refs.slice(i, i + CONC)
    const results = batch.map((ref) => {
      const url = `${BASE}/${chapter}/${ref.href}`
      try {
        return { url, ref, p: parseSection(curl(url), ref.number) }
      } catch (e: any) {
        console.warn(`  ! ${ref.number}: ${e?.message || e}`)
        return { url, ref, p: null }
      }
    })
    for (const { url, p } of results) {
      if (!p || !p.text || p.text.length < 20) {
        skipped++
        continue
      }
      await query(
        `INSERT INTO state_law_section_texts
           (state_code, act_key, section_number, section_title, full_text, source_url, source_date, effective_year, law_category)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (state_code, act_key, section_number, effective_year) DO NOTHING`,
        [STATE, ACT_KEY, p.number, p.title, p.text, url, SOURCE_DATE, EFFECTIVE_YEAR, LAW_CATEGORY]
      )
      ok++
    }
    process.stdout.write(`\r  [${chapter}] ${Math.min(i + CONC, refs.length)}/${refs.length}`)
  }
  console.log(`\n  [${chapter}] inserted ${ok}, skipped ${skipped} of ${refs.length}`)
  return { ok, skipped, total: refs.length }
}

async function main() {
  console.log(`\n=== RI property-tax — ingesting Title 44 chapters (as of ${SOURCE_DATE}) ===`)
  let grandOk = 0
  for (const group of CHAPTER_GROUPS) {
    console.log(`\n[topic: ${group.topic}] chapters: ${group.chapters.join(', ')}`)
    for (const chapter of group.chapters) {
      const { ok } = await ingestChapter(chapter)
      grandOk += ok
    }
  }
  console.log(`\nRI done. attempted-insert rows=${grandOk}`)

  const rows = await query<{ count: string }>(
    `SELECT count(*)::text AS count FROM state_law_section_texts
     WHERE state_code = $1 AND law_category = $2`,
    [STATE, LAW_CATEGORY]
  )
  console.log(`DB now holds ${rows[0].count} RI property_tax rows.`)
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
