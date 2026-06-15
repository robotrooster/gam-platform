/**
 * Delaware property-tax statute full-text ingester (state-law corpus,
 * sanctioned retrieve+cite+date carve-out — verbatim text, never advice).
 *
 * SOURCE: Delaware Code Online — https://delcode.delaware.gov/title9/ (Title 9,
 * Counties). The codified text is SERVER-RENDERED into the raw HTML body despite
 * a Kendo/jQuery JS shell in the <head>, so a plain curl (200, no login /
 * disclaimer redirect) returns the full verbatim statute. Authenticated PDF of
 * the title is linked on every page as a verification fallback.
 *
 * PAGE LAYOUT (confirmed by inspection):
 *   - A CHAPTER index page (e.g. /title9/c086/index.html) EITHER renders its
 *     sections directly as <div class="SectionHead" id="NNNN"> blocks (c080,
 *     c086) OR is only a stub that links to subchapter dirs
 *     /title9/cNNN/scNN/index.html (c081, c083, c087). The ingester handles
 *     both: parse the chapter page if it has SectionHeads, else recurse into
 *     each discovered subchapter page.
 *   - Each section is:
 *        <div class="SectionHead" id="NNNN">§ NNNN. <Catchline>.</div>
 *        <p class="subsection|indent-2|...">body…</p> …
 *        <a href="…SessionLaws…">DD Del. Laws, c. N, § N</a>; Code 1935, §§ …;
 *        9 Del. C. 1953, § NNNN; …   ← trailing Del. Laws / Code history note
 *     The section body runs until the next <div class="SectionHead"> (or the
 *     <br><div class="Section"> wrapper that precedes it). The history note is
 *     kept as the trailing source-note line of full_text (same posture as the
 *     LA ingester — the spec allows the history trailer in body text).
 *   - A top-of-page <ul class="chaptersections"> TOC of "#NNNN" anchor links is
 *     pure nav chrome; it is NOT a SectionHead div, so the split below ignores
 *     it automatically.
 *
 * SCOPE — five property-tax feature groups map onto the DEDICATED Title 9
 * property-tax chapters:
 *   exemptions             → c081 (Limitations Upon Taxing Power: sc01 §§8101-8113,
 *                            sc02 Citizens Over 65 §§8131-8141, sc03 Nonprofit
 *                            Housing for the Elderly) — also carries the
 *                            assessment_review cross-ref at § 8140.
 *   assessment             → c083 (Valuation and Assessment of Property:
 *                            sc01 §§8301+, sc02) — incl. § 8302 revision/correction
 *                            (the assessment_review revision provision).
 *   levy_collection_payment→ c080 (County Tax Levy) + c086 (Collection of Taxes
 *                            §§8601-8619).
 *   delinquency_tax_sale   → c087 (Collection of Delinquent Taxes: sc01-sc04,
 *                            incl. Subch. II Monition Method §§8721-8733).
 *
 * NOTE on per-county chapters (NCC Ch.13, Kent Ch.41, Sussex Ch.70): the triage
 * cited these for "per-county assessment procedure", but inspection shows c013 /
 * c041 / c070 are general COUNTY-GOVERNMENT charters (Department of Land Use,
 * Police Department, Parks & Recreation, Personnel, Pension, County Administrator,
 * etc.) — NOT property-tax assessment statutes. Ingesting them wholesale would
 * pollute the property_tax corpus with hundreds of off-topic county-org sections.
 * They are therefore EXCLUDED. The substantive assessment-review / appeal rules
 * that the triage pointed at (§ 8140 exemption-denial appeal, § 8302 revision)
 * live inside c081 / c083 above and ARE captured.
 *
 * All sections insert under act_key='property_tax', law_category='property_tax'.
 * The unique key (state, act_key, section_number, year) de-dupes any section that
 * appears in more than one feature group, so each distinct § is stored once.
 *
 * Run: cd apps/api && node -r ts-node/register src/db/ingestDEPropertyTax.ts
 * Idempotent (ON CONFLICT DO NOTHING). Repealed/reserved/short (<20 char) bodies
 * are dropped.
 */

import { execFileSync } from 'child_process'
import { query } from './index'
import { stripTags } from './ingestStateLawCorpus'

const STATE = 'DE'
const ACT_KEY = 'property_tax'
const LAW_CATEGORY = 'property_tax'
const SOURCE_DATE = '2026-06-14'
const EFFECTIVE_YEAR = 2026
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) GAM-statute-ingest/1.0 (compliance research)'
const BASE = 'https://delcode.delaware.gov/title9'

// Dedicated Title 9 property-tax chapters (see SCOPE note above).
const CHAPTERS: { chapter: string; topic: string }[] = [
  { chapter: 'c080', topic: 'levy_collection_payment' }, // County Tax Levy
  { chapter: 'c081', topic: 'exemptions' }, // Limitations Upon Taxing Power / exemptions
  { chapter: 'c083', topic: 'assessment' }, // Valuation and Assessment of Property
  { chapter: 'c086', topic: 'levy_collection_payment' }, // Collection of Taxes
  { chapter: 'c087', topic: 'delinquency_tax_sale' }, // Collection of Delinquent Taxes
]

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

/** True if the page renders section text directly (has SectionHead divs). */
function hasSections(html: string): boolean {
  return /<div\s+class="SectionHead"\s+id="\d+"/i.test(html)
}

/** Discover subchapter index URLs (/title9/cNNN/scNN/index.html) from a stub. */
function discoverSubchapters(html: string, chapter: string): string[] {
  const re = new RegExp(`${chapter}/(sc\\d+)/index\\.html`, 'gi')
  const seen = new Set<string>()
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) seen.add(m[1])
  return [...seen].sort().map((sc) => `${BASE}/${chapter}/${sc}/index.html`)
}

/**
 * Parse every section on a page. Split the raw HTML on the SectionHead boundary;
 * each chunk after the first is one section (the first chunk is the page header /
 * breadcrumb / chaptersections TOC, discarded). Within a chunk:
 *   - the leading SectionHead div is "§ NNNN. <catchline>" → number + title
 *   - everything after the </div> up to the next SectionHead is the body +
 *     trailing Del. Laws history note → full_text (verbatim, tag-stripped)
 */
function parseSections(html: string): Parsed[] {
  // Normalize the SectionHead opener so split keeps the id captured per chunk.
  const chunks = html.split(/(?=<div\s+class="SectionHead"\s+id="\d+")/i)
  const out: Parsed[] = []
  for (const chunk of chunks) {
    const head = chunk.match(/<div\s+class="SectionHead"\s+id="(\d+)"[^>]*>([\s\S]*?)<\/div>/i)
    if (!head) continue
    const number = head[1]
    const catchline = stripTags(head[2], false).trim()

    // Title = catchline with the leading "§ NNNN." citation stripped. The DE
    // header renders as "§ 8601. Due date for real estate and capitation taxes."
    let title: string | null = catchline
      .replace(/^§\s*[0-9A-Za-z.\-]+\.?\s*/, '')
      .trim()
    if (!title) title = null
    if (title && /^repealed\b/i.test(title)) continue
    if (title && /^\[?reserved\.?\]?$/i.test(title)) continue

    // Body = the chunk after the SectionHead div's closing </div>.
    const afterHead = chunk.slice(chunk.indexOf(head[0]) + head[0].length)
    // Trim a trailing "<br><div class=\"Section\">" wrapper that precedes the
    // next section (it carries no statute text).
    const bodyHtml = afterHead
      .replace(/<br\s*\/?>\s*<div\s+class="Section">\s*$/i, '')
      .replace(/<div\s+class="Section">\s*$/i, '')
    const body = stripTags(bodyHtml, true).trim()

    if (!body || body.length < 20) continue
    if (/^\[?reserved\.?\]?$/i.test(body)) continue
    if (/^repealed\b/i.test(body)) continue

    out.push({ number, title, text: body })
  }
  return out
}

async function ingestChapter(chapter: string): Promise<{ inserted: number; parsed: number; pages: string[] }> {
  const chapterUrl = `${BASE}/${chapter}/index.html`
  const chapterHtml = curl(chapterUrl)

  // Determine which page(s) actually carry the section text.
  const pages: { url: string; html: string }[] = []
  if (hasSections(chapterHtml)) {
    pages.push({ url: chapterUrl, html: chapterHtml })
  } else {
    const subs = discoverSubchapters(chapterHtml, chapter)
    for (const subUrl of subs) {
      await new Promise((r) => setTimeout(r, 300)) // politeness
      const subHtml = curl(subUrl)
      pages.push({ url: subUrl, html: subHtml })
    }
  }

  let inserted = 0
  let parsedCount = 0
  const usedPages: string[] = []
  for (const { url, html } of pages) {
    const sections = parseSections(html)
    if (sections.length) usedPages.push(url)
    parsedCount += sections.length
    for (const s of sections) {
      const res = await query<{ id: string }>(
        `INSERT INTO state_law_section_texts
           (state_code, act_key, section_number, section_title, full_text,
            source_url, source_date, effective_year, law_category)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (state_code, act_key, section_number, effective_year) DO NOTHING
         RETURNING id`,
        [STATE, ACT_KEY, s.number, s.title, s.text, url, SOURCE_DATE, EFFECTIVE_YEAR, LAW_CATEGORY]
      )
      inserted += res.length
    }
  }
  return { inserted, parsed: parsedCount, pages: usedPages }
}

async function main() {
  console.log(`\n=== DE — ingesting property-tax full-text corpus (as of ${SOURCE_DATE}) ===`)
  let totalInserted = 0
  let totalParsed = 0
  for (const { chapter, topic } of CHAPTERS) {
    try {
      const { inserted, parsed, pages } = await ingestChapter(chapter)
      totalInserted += inserted
      totalParsed += parsed
      console.log(
        `  [${chapter} / ${topic}] parsed ${parsed} sections, inserted ${inserted} from ${pages.length} page(s)`
      )
    } catch (e: any) {
      console.error(`  ! ${chapter} (${topic}) FAILED: ${e?.message || e}`)
    }
    await new Promise((r) => setTimeout(r, 300))
  }
  console.log(`\nDE done. parsed=${totalParsed} inserted=${totalInserted}`)
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
