/**
 * Rhode Island real-estate statute full-text ingester (sanctioned
 * retrieve+cite+date carve-out — verbatim statute text, never advice).
 *
 * SOURCE: the official RI General Assembly statute server,
 * https://webserver.rilegislature.gov/Statutes/ . Free .gov host serving
 * LexisNexis-namespaced XHTML. No JS, no cookies — plain curl GET with a
 * browser User-Agent is sufficient (fetchability=raw_http for every chapter).
 *
 * SITE LAYOUT
 *   Chapter index:  /Statutes/TITLE<T>/<chap>/INDEX.HTM
 *     - flat chapters list section anchors directly:
 *         <p><a href="34-11-1.htm">§&nbsp;34-11-1.&nbsp;Title.</a></p>
 *     - the Condominium Act (34-36.1) is two levels deep: its INDEX lists
 *       ARTICLE subfolders <a href="34-I/INDEX.htm">Article I ...</a>; each
 *       article folder INDEX then lists flat section anchors
 *       <a href="34-36.1-1.01.htm">...</a> (decimal section format).
 *   Section page:   /Statutes/TITLE<T>/<chap>/[<artfolder>/]<sec>.htm
 *         <div>
 *           <p style="margin-left:0px"><b>§&nbsp;34-11-1.&nbsp;Catchline.</b></p>
 *           <p style="margin-left:0px">operative text ...</p>     (1..N paras)
 *           <p style="margin-left:30px"><b>(1)</b>&nbsp;sub ...</p>  (enumerated)
 *           <div><p>History of Section.<br>...</p></div>            (trailer)
 *         </div>
 *     The operative body is exactly the run of <p style="margin-left:..."> tags
 *     AFTER the title <b> paragraph. The "History of Section." trailer sits in a
 *     <p> WITHOUT a margin-left style, so selecting margin-left paragraphs
 *     naturally cuts it (per spec: stop capturing at the History block). Inner
 *     <b>(1)</b>/<b>(i)</b>/<b>(A)</b> enumeration markers are kept as text.
 *     Title-banner divs (<h1>Title 34</h1>, <h2>Chapter ...</h2>,
 *     <h3>R.I. Gen. Laws § ...</h3>) carry no margin-left <p> and are skipped.
 *
 * CATEGORY → ACT_KEY: per the task recipe, law_category AND act_key are BOTH the
 * category key for every row (conveyancing_title, condo_coop, broker_licensing,
 * mortgage_lien_foreclosure, general_real_property). Each category maps to a set
 * of RI chapters; no chapter appears in two categories (no duplication).
 *
 * DROP RULES: repealed / reserved / TOC / nav / HTML chrome / empty or <20-char
 * bodies are dropped. Repealed sections render with a "Repealed." catchline and
 * no operative paragraph, so both the title-match and empty-body guards catch
 * them.
 *
 * Run: cd apps/api && node -r ts-node/register src/db/ingestRIRealEstate.ts
 * Idempotent (ON CONFLICT (state_code, act_key, section_number, effective_year)
 * DO NOTHING). source_date '2026-06-14', effective_year 2026.
 */

import { execFileSync } from 'child_process'
import { query } from './index'
import { stripTags, decodeEntities } from './ingestStateLawCorpus'

const STATE = 'RI'
const SOURCE_DATE = '2026-06-14'
const EFFECTIVE_YEAR = 2026
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) GAM-statute-ingest/1.0'
const HOST = 'https://webserver.rilegislature.gov'

/** chapter → its TITLE folder (Title 5 = professions; everything else Title 34). */
function titleFolder(chap: string): string {
  return chap.startsWith('5-') ? 'TITLE5' : 'TITLE34'
}
function chapterIndexUrl(chap: string): string {
  return `${HOST}/Statutes/${titleFolder(chap)}/${chap}/INDEX.HTM`
}

// Category → list of RI chapters. act_key === law_category === the key here.
const CATEGORIES: Record<string, string[]> = {
  conveyancing_title: ['34-11', '34-12', '34-13', '34-13.1', '34-13.2'],
  condo_coop: ['34-36.1', '34-36'],
  broker_licensing: ['5-20.5', '5-20.6', '5-20.7'],
  mortgage_lien_foreclosure: [
    '34-23', '34-25', '34-25.1', '34-25.2', '34-26',
    '34-27', '34-27.1', '34-27.2', '34-28', '34-49',
  ],
  general_real_property: [
    '34-2', '34-3', '34-4', '34-5', '34-7', '34-9', '34-10',
    '34-14', '34-15', '34-16', '34-17', '34-19', '34-20',
  ],
}

interface SecRef { number: string; url: string }
interface Parsed { number: string; title: string | null; text: string }

function curl(url: string): string {
  const buf = execFileSync('curl', ['-sL', '--max-time', '60', '-A', UA, url], {
    maxBuffer: 256 * 1024 * 1024,
  })
  return buf.toString('utf-8')
}

/** Join a relative href against a base directory URL (handles ../ etc.). */
function resolveHref(baseUrl: string, href: string): string {
  // baseUrl is the .../INDEX.HTM page; its directory is everything up to the last '/'.
  const dir = baseUrl.slice(0, baseUrl.lastIndexOf('/') + 1)
  return new URL(href, dir).toString()
}

/**
 * Enumerate every section page URL for a chapter. Flat chapters: the INDEX lists
 * section .htm anchors. Condominium Act (34-36.1): the INDEX lists ARTICLE
 * subfolder INDEX pages, each of which lists section .htm anchors — recurse one
 * level. De-dupe by section number; preserve index order.
 */
function enumerateSections(chap: string): SecRef[] {
  const indexUrl = chapterIndexUrl(chap)
  const html = curl(indexUrl)

  // Article-subfolder anchors (only the condo act top index has these):
  //   href="34-I/INDEX.htm" / href="34-II/INDEX.htm" ...
  const artFolders = [...html.matchAll(/href="(34-[IVXLC]+\/INDEX\.htm)"/gi)].map((m) => m[1])

  const seen = new Set<string>()
  const out: SecRef[] = []

  const collectFrom = (pageUrl: string, pageHtml: string) => {
    // Section anchors: href="<chap>-<sec>.htm". <sec> may be decimal (1.01) or
    // dotted (13.1-2). Anchor for the chapter file pattern only.
    const re = new RegExp(`href="(${escapeRe(chap)}-([0-9][0-9A-Za-z.\\-]*)\\.htm)"`, 'gi')
    let m: RegExpExecArray | null
    while ((m = re.exec(pageHtml)) !== null) {
      const number = `${chap}-${m[2]}`
      if (seen.has(number)) continue
      seen.add(number)
      out.push({ number, url: resolveHref(pageUrl, m[1]) })
    }
  }

  if (artFolders.length > 0) {
    for (const folderHref of artFolders) {
      const folderUrl = resolveHref(indexUrl, folderHref)
      const folderHtml = curl(folderUrl)
      collectFrom(folderUrl, folderHtml)
    }
  } else {
    collectFrom(indexUrl, html)
  }
  return out
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Parse one section page. Title = the leading <b>§ NN. Catchline.</b>. Body = the
 * run of <p style="margin-left:..."> paragraphs after the title paragraph (this
 * excludes the no-margin-left "History of Section." trailer). Inner <b> markers
 * are kept as text. Returns null for repealed/reserved/empty/short bodies.
 */
function parseSection(html: string, expectedNumber: string): Parsed | null {
  // All margin-left paragraphs, in document order. First one carries the <b>title.
  const paras = [...html.matchAll(/<p\s+style="margin-left:[^"]*"[^>]*>([\s\S]*?)<\/p>/gi)].map(
    (m) => m[1]
  )
  if (paras.length === 0) return null

  // Title from the first margin-left paragraph (the <b>§ NN. Catchline.</b> node).
  const titleRaw = stripTags(paras[0], false) // collapse to one line
  let title: string | null = titleRaw
    .replace(/^§\s*[0-9A-Za-z.:\-]+\.?\s*/, '') // strip leading "§ 34-11-1."
    .trim()
  if (!title) title = null
  if (title && /^repealed\b/i.test(title)) return null
  if (title && /^\[?reserved\b\.?\]?$/i.test(title)) return null
  // A section whose first margin-left paragraph is NOT a § catchline is chrome.
  if (!/^§/.test(titleRaw.trim())) return null

  // Body = every margin-left paragraph after the title paragraph, each tag-
  // stripped (keeps enumeration markers + entity decoding), joined by newline.
  const body = paras
    .slice(1)
    .map((p) => stripTags(p, true))
    .map((p) => p.trim())
    .filter(Boolean)
    .join('\n')
    .trim()

  if (!body || body.length < 20) return null
  if (/^\[?reserved\b\.?\]?$/i.test(body)) return null
  if (/^repealed\b/i.test(body)) return null

  return { number: expectedNumber, title: title ? decodeEntities(title) : null, text: body }
}

async function ingestCategory(category: string, chapters: string[]): Promise<number> {
  // 1) enumerate all section URLs across the category's chapters.
  const refs: SecRef[] = []
  for (const chap of chapters) {
    try {
      const secs = enumerateSections(chap)
      console.log(`  [${category}] ${chap}: ${secs.length} section anchors`)
      refs.push(...secs)
    } catch (e: any) {
      console.warn(`  ! [${category}] index ${chap}: ${e?.message || e}`)
    }
  }

  // 2) fetch + parse + insert, small concurrency for politeness.
  let ok = 0
  let skipped = 0
  const CONC = 4
  for (let i = 0; i < refs.length; i += CONC) {
    if (i > 0) await new Promise((r) => setTimeout(r, 250))
    const batch = refs.slice(i, i + CONC)
    const parsed = await Promise.all(
      batch.map(async (r) => {
        try {
          return { p: parseSection(curl(r.url), r.number), r }
        } catch (e: any) {
          console.warn(`\n  ! [${category}] ${r.number}: ${e?.message || e}`)
          return { p: null, r }
        }
      })
    )
    for (const { p, r } of parsed) {
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
        [STATE, category, p.number, p.title, p.text, r.url, SOURCE_DATE, EFFECTIVE_YEAR, category]
      )
      ok++
    }
    process.stdout.write(`\r  [${category}] ${Math.min(i + CONC, refs.length)}/${refs.length}`)
  }
  console.log(`\n  [${category}] inserted ${ok}, skipped ${skipped} of ${refs.length}`)
  return ok
}

async function main() {
  console.log(`\n=== RI — ingesting real-estate statute corpus (as of ${SOURCE_DATE}) ===`)
  const counts: Record<string, number> = {}
  for (const [category, chapters] of Object.entries(CATEGORIES)) {
    console.log(`\n--- ${category} (${chapters.join(', ')}) ---`)
    counts[category] = await ingestCategory(category, chapters)
  }
  const total = Object.values(counts).reduce((a, b) => a + b, 0)
  console.log(`\nRI done. inserted=${total}`, counts)
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
