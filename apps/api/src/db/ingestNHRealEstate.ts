/**
 * New Hampshire non-tax real-estate statute full-text ingester.
 *
 * Sanctioned retrieve+cite+date carve-out: verbatim official statute text,
 * never advice. Source is the General Court of New Hampshire static-HTML RSA
 * site (gc.nh.gov, IIS, no JS, no auth). Plain curl with a browser UA.
 *
 * SITE LAYOUT
 * -----------
 * Each chapter has a Table of Contents at:
 *   https://gc.nh.gov/rsa/html/NHTOC/NHTOC-<TITLE_ROMAN>-<CHAPTER>.htm
 * whose <li> anchors look like:
 *   <a href="../XLVIII/477/477-3-a.htm"> Section: 477:3-a Recording. </a>
 * The href is a RELATIVE path from /rsa/html/NHTOC/, so we resolve it against
 * that base rather than reconstructing section URLs from roman numerals — the
 * roman-numeral path segment is decorative and the published recipe had it
 * WRONG for chapter 447 (it lives under Title XLI "Liens", not XXXVIII). Using
 * the TOC's own href sidesteps that entirely.
 *
 * Each section page:
 *   <center><h3>Section 477:3-a</h3></center>
 *   &nbsp;&nbsp;&nbsp;<b> 477:3-a Recording. &#150;</b>   <- catchline heading
 *   <codesect> ...verbatim statute body... </codesect>     <- the text we keep
 *   <sourcenote><p><b>Source.</b> 1975, 428:3, ...</p></sourcenote>  <- history
 * Repealed/reserved sections have an empty <codesect></codesect> (and the
 * heading reads "Repealed by ..."), so the <20-char body filter drops them.
 * Multi-paragraph bodies use <br> separators and &nbsp;/&#150; entities, all
 * handled by the corpus framework's stripTags/decodeEntities.
 *
 * CATEGORY -> CHAPTER MAPPING (act_key == law_category for every block)
 *   conveyancing_title         477 (XLVIII) + 478 (XLVIII) + 478-A (XLVIII)
 *   condo_coop                 356-B (XXXI) + 479-A (XLVIII)
 *   broker_licensing           331-A (XXX)
 *   mortgage_lien_foreclosure  479 (XLVIII) + 479-B (XLVIII) + 447 (XLI)
 *   general_real_property      480 (XLIX) + 539 (LV)
 * NH has no separate cooperative / common-interest act; 356-B + 479-A are the
 * condominium statutes. NH has no single "general real property" title; 480
 * (Homestead Right) + 539 (adverse-possession/trespass) are the cleanest
 * distinct estate-in-land provisions outside the conveyancing bucket.
 *
 * Run: cd apps/api && node -r ts-node/register src/db/ingestNHRealEstate.ts
 * Idempotent (ON CONFLICT DO NOTHING). source_date 2026-06-14, effective_year 2026.
 */

import { execFileSync } from 'child_process'
import { query } from './index'
import { stripTags } from './ingestStateLawCorpus'

const STATE = 'NH'
const SOURCE_DATE = '2026-06-14'
const EFFECTIVE_YEAR = 2026
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) GAM-statute-ingest/1.0'
const NHTOC_BASE = 'https://gc.nh.gov/rsa/html/NHTOC/'

// chapter TOC filenames (NHTOC-<title roman>-<chapter>), grouped by category.
const CATEGORY_TOCS: Record<string, string[]> = {
  conveyancing_title: ['NHTOC-XLVIII-477', 'NHTOC-XLVIII-478', 'NHTOC-XLVIII-478-A'],
  condo_coop: ['NHTOC-XXXI-356-B', 'NHTOC-XLVIII-479-A'],
  broker_licensing: ['NHTOC-XXX-331-A'],
  mortgage_lien_foreclosure: ['NHTOC-XLVIII-479', 'NHTOC-XLVIII-479-B', 'NHTOC-XLI-447'],
  general_real_property: ['NHTOC-XLIX-480', 'NHTOC-LV-539'],
}

interface Cite { number: string; url: string }
interface Parsed { number: string; title: string | null; text: string }

function curl(url: string): string {
  const buf = execFileSync('curl', ['-sL', '--max-time', '60', '-A', UA, url], {
    maxBuffer: 256 * 1024 * 1024,
  })
  return buf.toString('utf-8')
}

/** Resolve a TOC-relative href (e.g. "../XLVIII/477/477-3-a.htm") to an absolute URL. */
function resolveHref(href: string): string {
  return new URL(href, NHTOC_BASE).toString()
}

/**
 * Harvest (section number, absolute URL) pairs from a chapter TOC page. Each
 * real section is a <li><a href="../.../NNN-sec.htm"> Section: NNN:sec Title.</a>.
 * We take the number from the anchor text and the URL from the href. De-dupe by
 * number; skip the chapter "-mrg" merged-view link.
 */
function harvestToc(html: string): Cite[] {
  const re = /<a[^>]*href="([^"]*?\/[0-9A-Za-z-]+-[0-9A-Za-z-]+\.htm)"[^>]*>\s*Section:\s*([0-9A-Za-z-]+:[0-9A-Za-z-]+)\b/gi
  const seen = new Set<string>()
  const out: Cite[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) {
    const href = m[1]
    const number = m[2]
    if (/-mrg\.htm$/i.test(href)) continue
    if (seen.has(number)) continue
    seen.add(number)
    out.push({ number, url: resolveHref(href) })
  }
  return out
}

/**
 * Parse an NH section page.
 *   title  = the <b> NNN:sec Title. &#150;</b> heading, citation + trailing dash stripped
 *   body   = the <codesect>...</codesect> content (verbatim statute text)
 * Returns null for repealed/reserved/empty pages (no codesect, or body <20 chars).
 */
function parseSectionPage(html: string, expectedNumber: string): Parsed | null {
  // Body: the <codesect> block.
  const codeM = html.match(/<codesect>([\s\S]*?)<\/codesect>/i)
  if (!codeM) return null
  const text = stripTags(codeM[1], true).trim()
  if (!text || text.length < 20) return null
  if (/^\[?reserved\.?\]?$/i.test(text)) return null
  if (/^repealed\b/i.test(text)) return null

  // Title: the bold catchline heading. Take the LAST <b>...</b> before <codesect>
  // (there can be header <b>s in <h1>/<h2>); it carries "NNN:sec Title. –".
  const head = html.slice(0, codeM.index)
  const boldMatches = [...head.matchAll(/<b>([\s\S]*?)<\/b>/gi)]
  let title: string | null = null
  if (boldMatches.length) {
    let raw = stripTags(boldMatches[boldMatches.length - 1][1], false).trim()
    // Strip leading "NNN:sec" citation and the trailing dash separator. The
    // heading separator is &#150; which decodeEntities maps to U+0096 (the
    // Windows-1252 en-dash control byte), so match that explicitly alongside
    // the proper Unicode en/em-dashes and ASCII hyphen.
    raw = raw.replace(/^[0-9A-Za-z-]+:[0-9A-Za-z-]+\.?\s*/, '')
    raw = raw.replace(/[\s\u0096\u2012\u2013\u2014\u2015\u2010-]+$/, '').trim()
    raw = raw.replace(/\.\s*$/, '').trim()
    title = raw || null
  }
  if (title && /^repealed\b/i.test(title)) {
    // Repealed catchline but somehow non-empty codesect — keep only if real prose.
    if (text.length < 20) return null
  }

  return { number: expectedNumber, title, text }
}

async function ingestCategory(category: string, tocs: string[]): Promise<number> {
  // Gather all section cites across the category's chapters.
  const cites: Cite[] = []
  const seen = new Set<string>()
  for (const toc of tocs) {
    const html = curl(`${NHTOC_BASE}${toc}.htm`)
    const found = harvestToc(html)
    for (const c of found) {
      if (seen.has(c.number)) continue
      seen.add(c.number)
      cites.push(c)
    }
    console.log(`  [${category}] ${toc}: ${found.length} sections`)
  }

  let ok = 0
  let skipped = 0
  const CONC = 4
  for (let i = 0; i < cites.length; i += CONC) {
    if (i > 0) await new Promise((r) => setTimeout(r, 250)) // politeness
    const batch = cites.slice(i, i + CONC)
    const parsed = batch.map((c) => {
      try {
        return { p: parseSectionPage(curl(c.url), c.number), c }
      } catch (e: any) {
        console.warn(`  ! ${category} ${c.number}: ${e?.message || e}`)
        return { p: null as Parsed | null, c }
      }
    })
    for (const { p, c } of parsed) {
      if (!p || !p.text || p.text.length < 20) {
        skipped++
        continue
      }
      await query(
        `INSERT INTO state_law_section_texts
           (state_code, act_key, section_number, section_title, full_text, source_url, source_date, effective_year, law_category)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (state_code, act_key, section_number, effective_year) DO NOTHING`,
        [STATE, category, p.number, p.title, p.text, c.url, SOURCE_DATE, EFFECTIVE_YEAR, category]
      )
      ok++
    }
    process.stdout.write(`\r  [${category}] ${Math.min(i + CONC, cites.length)}/${cites.length}`)
  }
  console.log(`\n  [${category}] inserted ${ok}, skipped ${skipped} of ${cites.length}`)
  return ok
}

async function main() {
  console.log(`\n=== NH — ingesting non-tax real-estate corpus (as of ${SOURCE_DATE}) ===`)
  const counts: Record<string, number> = {}
  for (const [category, tocs] of Object.entries(CATEGORY_TOCS)) {
    counts[category] = await ingestCategory(category, tocs)
  }
  const total = Object.values(counts).reduce((a, b) => a + b, 0)
  console.log(`\nNH done. inserted=${total}`, counts)
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
