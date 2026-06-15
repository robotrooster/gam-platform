/**
 * New Hampshire PROPERTY-TAX statute full-text ingester.
 *
 * Sanctioned retrieve+cite+date carve-out: GAM stores the VERBATIM statutory
 * text + citation + retrieval/effective date, and never advises. (Posture
 * unchanged — see services/stateLaw.ts + the migration headers.)
 *
 * SOURCE — official NH legislature site, gc.nh.gov (www.gencourt.state.nh.us
 * 301-redirects here; curl -L follows). Title V "Taxation" still serves the
 * LEGACY static-HTML pages; each section page is plain text/html, no JS.
 *
 * HARVEST: drill PAST the table-of-contents. The chapter TOC at
 *   https://gc.nh.gov/rsa/html/NHTOC/NHTOC-V-<CH>.htm
 * lists per-section anchors as href="../V/<CH>/<file>.htm". We harvest those
 * filenames and fetch each SECTION page directly at
 *   https://gc.nh.gov/rsa/html/V/<CH>/<file>.htm
 *
 * SECTION-PAGE LAYOUT (verified S476):
 *   <head> hidden HTML-comment metadata block:
 *     <titlename>TITLE V TAXATION</titlename>
 *     <chapter>CHAPTER 72 PERSONS AND PROPERTY LIABLE TO TAXATION</chapter>
 *     <sectiontitle>Section 72:23 Real Estate and Personal Property Tax Exemption.</sectiontitle>
 *   Body: bold lead-in '<b> 72:23 Title. &#150;</b>' (number + title), then the
 *   verbatim prose inside <codesect>...</codesect>, then a trailing
 *   <sourcenote><b>Source.</b> ...eff. <date>.</sourcenote> amendment history.
 *
 * We take section_number + section_title from <sectiontitle> (cleanest), the
 * verbatim body from <codesect> (stripTags keeps <br> paragraph breaks and
 * decodes &nbsp;/&#150;), and append the Source. note as the dated trailer.
 *
 * DROP: TOC/nav, chapter-merge index pages (<file> = '<CH>-mrg'), repealed
 * sections (title contains 'Repealed by') and repealed-range placeholder pages
 * (e.g. 72-24to72-27.htm — empty <codesect>), and any body < 20 chars.
 *
 * ACT MAPPING — per the ingest spec ALL property-tax sections land under one
 * act_key='property_tax'/law_category='property_tax'. The five required
 * feature-chapter groups, by chapter:
 *   exemptions               -> Ch. 72 (72:23 et seq. public/charitable/
 *                               religious/educational, veterans, renewables)
 *   assessment               -> Ch. 75 (appraisal/value) + Ch. 74 (annual
 *                               inventory of taxable property)
 *   assessment_review        -> Ch. 76 (76:16 abatement, 76:16-a/76:17 appeal
 *                               to the Board of Tax and Land Appeals / Superior
 *                               Court). NOTE on 71-B below.
 *   levy_collection_payment  -> Ch. 80 (collection) + Ch. 76 (tax bills,
 *                               interest, semi-annual collection)
 *   delinquency_tax_sale     -> Ch. 80 (tax lien, redemption, deed)
 * Chapters 74/75/76 cover assessment + review + levy together; 72 = exemptions;
 * 80 = collection + delinquency. We ingest all five chapters in full so the
 * statutory prose for every group is present.
 *
 * 71-B CAVEAT (honest): RSA Ch. 71-B (Board of Tax and Land Appeals enabling
 * statute) lives in Title VI, which the state MIGRATED off the legacy static
 * pages — NHTOC-VI-71-B.htm and every VI/71-B/71-B-*.htm now return the new
 * site's soft-404 (HTTP 200, body "Page Not Found", no <codesect>). No official
 * static section text is reachable, so 71-B is NOT ingested. The appeal-
 * procedure prose the carve-out needs (abatement + appeal to the Board) IS
 * captured: it lives in RSA 76:16 / 76:16-a / 76:17 (Title V, Ch. 76), which
 * we ingest in full. No non-official fallback was used.
 *
 * Run: cd apps/api && node -r ts-node/register src/db/ingestNHPropertyTax.ts
 * Idempotent (ON CONFLICT DO NOTHING).
 */

import { execFileSync } from 'child_process'
import { query } from './index'
import { stripTags } from './ingestStateLawCorpus'

const STATE = 'NH'
const ACT_KEY = 'property_tax'
const LAW_CATEGORY = 'property_tax'
const SOURCE_DATE = '2026-06-14'
const EFFECTIVE_YEAR = 2026
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) GAM-statute-ingest/1.0'
const BASE = 'https://gc.nh.gov/rsa/html'

// Title V property-tax chapters (the five feature groups all live here).
const CHAPTERS = ['72', '74', '75', '76', '80']

interface Parsed {
  number: string
  title: string | null
  text: string
}

function curl(url: string): string {
  const buf = execFileSync('curl', ['-sL', '--max-time', '60', '-A', UA, url], {
    maxBuffer: 64 * 1024 * 1024,
  })
  return buf.toString('utf-8')
}

/**
 * Harvest section-page filenames from a chapter TOC. Anchors look like
 * href="../V/72/72-23.htm". Keep only ../V/<CH>/ links, drop the '<CH>-mrg'
 * chapter-merge index page, de-dupe, preserve TOC order.
 */
function harvestSectionFiles(tocHtml: string, ch: string): string[] {
  const re = new RegExp(`href="\\.\\./V/${ch}/([^"]+?\\.htm)"`, 'gi')
  const seen = new Set<string>()
  const out: string[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(tocHtml)) !== null) {
    const file = m[1]
    if (/^.*-mrg\.htm$/i.test(file)) continue // chapter index page, not a section
    if (seen.has(file)) continue
    seen.add(file)
    out.push(file)
  }
  return out
}

/**
 * Parse one NH section page. Pulls the clean citation + title from the
 * <sectiontitle> comment, the verbatim body from <codesect>, and appends the
 * <sourcenote> "Source." amendment history as a dated trailer. Returns null for
 * repealed / empty / placeholder pages.
 */
function parseSectionPage(html: string): Parsed | null {
  const stMatch = html.match(/<sectiontitle>([\s\S]*?)<\/sectiontitle>/i)
  if (!stMatch) return null
  // e.g. "Section 72:23 Real Estate and Personal Property Tax Exemption."
  const rawSt = stripTags(stMatch[1], false).trim()
  const sec = rawSt.replace(/^Section\s+/i, '')
  // number = leading citation token(s). Single ("72:23", "72:23-b") or a
  // range ("72:24 to 72:27", "74:3-a, 74:3-b") on repealed placeholder pages.
  const numMatch = sec.match(/^([0-9]+:[0-9A-Za-z-]+(?:\s*(?:to|,)\s*[0-9]+:[0-9A-Za-z-]+)*)/)
  if (!numMatch) return null
  const number = numMatch[1].replace(/\s+/g, ' ').trim()
  let title: string | null = sec.slice(numMatch[0].length).trim() || null

  // Drop repealed sections / repealed-range placeholders.
  if (title && /^repealed\b/i.test(title)) return null
  if (/repealed by/i.test(rawSt)) return null

  // Verbatim body from <codesect> (keep <br> breaks, decode entities).
  const bodyMatch = html.match(/<codesect>([\s\S]*?)<\/codesect>/i)
  if (!bodyMatch) return null
  let body = stripTags(bodyMatch[1], true).trim()
  if (!body || body.length < 20) return null
  if (/^\[?reserved\.?\]?$/i.test(body)) return null

  // Append the dated Source. amendment-history note (carries effective date).
  const srcMatch = html.match(/<sourcenote>([\s\S]*?)<\/sourcenote>/i)
  if (srcMatch) {
    const src = stripTags(srcMatch[1], false).trim()
    if (src && /source\b/i.test(src)) body = `${body}\n\n${src}`
  }

  return { number, title, text: body }
}

async function ingestChapter(ch: string): Promise<{ ok: number; skipped: number; total: number }> {
  const toc = curl(`${BASE}/NHTOC/NHTOC-V-${ch}.htm`)
  const files = harvestSectionFiles(toc, ch)
  console.log(`  CH ${ch}: harvested ${files.length} section files from TOC`)

  let ok = 0
  let skipped = 0
  const CONC = 4
  for (let i = 0; i < files.length; i += CONC) {
    if (i > 0) await new Promise((r) => setTimeout(r, 250)) // politeness
    const batch = files.slice(i, i + CONC)
    const parsed = await Promise.all(
      batch.map(async (file) => {
        try {
          const html = curl(`${BASE}/V/${ch}/${file}`)
          // soft-404 guard (shouldn't hit Title V, but be safe)
          if (/Page Not Found|404/i.test(html) && !/<codesect>/i.test(html)) return null
          return { p: parseSectionPage(html), file }
        } catch (e: any) {
          console.warn(`    ! CH ${ch} ${file}: ${e?.message || e}`)
          return { p: null, file }
        }
      })
    )
    for (const r of parsed) {
      if (!r || !r.p) {
        skipped++
        continue
      }
      const { p, file } = r
      await query(
        `INSERT INTO state_law_section_texts
           (state_code, act_key, section_number, section_title, full_text, source_url, source_date, effective_year, law_category)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (state_code, act_key, section_number, effective_year) DO NOTHING`,
        [
          STATE,
          ACT_KEY,
          p.number,
          p.title,
          p.text,
          `${BASE}/V/${ch}/${file}`,
          SOURCE_DATE,
          EFFECTIVE_YEAR,
          LAW_CATEGORY,
        ]
      )
      ok++
    }
    process.stdout.write(`\r    [CH ${ch}] ${Math.min(i + CONC, files.length)}/${files.length}`)
  }
  console.log(`\n  CH ${ch}: inserted ${ok}, skipped ${skipped} of ${files.length}`)
  return { ok, skipped, total: files.length }
}

async function main() {
  console.log(`\n=== NH property-tax — ingesting full-text corpus (as of ${SOURCE_DATE}) ===`)
  const counts: Record<string, number> = {}
  let total = 0
  for (const ch of CHAPTERS) {
    const r = await ingestChapter(ch)
    counts[`ch_${ch}`] = r.ok
    total += r.ok
  }
  console.log(`\nNH property-tax done. inserted=${total}`, counts)
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
