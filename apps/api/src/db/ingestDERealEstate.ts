/**
 * Delaware real-estate statute full-text ingester (non-tax carve-out corpus).
 *
 * Source: delcode.delaware.gov — the official Delaware Code Online. Static,
 * server-rendered HTML; no JS needed (plain curl with a browser UA). The
 * legacy .shtml paths 301-redirect to the canonical .html, so we use .html
 * directly.
 *
 * Posture unchanged from the rest of the corpus: GAM retrieves + cites + dates
 * + disclaims — never advises. Verbatim section text only. Repealed / reserved /
 * empty (<20 char) / TOC / nav / HTML chrome are dropped.
 *
 * PAGE STRUCTURE (uniform across the whole code):
 *   A chapter index lives at  title{T}/c{NNN:03d}/index.html.
 *   - Chapters WITHOUT subchapters render every section inline inside
 *       <div id="CodeBody"> … <div class="Section">
 *            <div class="SectionHead" id="NNN">§ NNN. Catchline.</div>
 *            <p class="subsection"> … body … </p> … history-note trailer
 *         </div> …
 *   - Chapters WITH subchapters render only nav links (c{NNN}/scNN/index.html)
 *       and have NO CodeBody; each subchapter page then carries the same
 *       <div class="Section"> blocks as above.
 *   - DUCIOA (Ch. 81) sections are dotted ("§ 81-101") — the dotted number is
 *       the SectionHead's id= attribute, so it is captured verbatim.
 *
 * We AUTO-DISCOVER structure: fetch each chapter index; if it has section
 * blocks, parse inline; else enumerate its scNN subchapter links and parse each.
 * (Verified at build time: Ch. 1 and Ch. 7 are subchapter-based despite the
 * recipe's inline guess — auto-discovery handles both without per-chapter
 * hardcoding.)
 *
 * CATEGORY → CHAPTER MAP (law_category == act_key for every block):
 *   conveyancing_title        = T25 Ch. 1 (Deeds), Ch. 2 (Real Property TOD),
 *                               Ch. 3 (Titles and Conveyances)
 *   condo_coop                = T25 Ch. 22 (Unit Property Act) + Ch. 81 (DUCIOA)
 *   broker_licensing          = T24 Ch. 29 (Real Estate brokers/salespersons)
 *                               + Ch. 40 (Real Estate Appraisers)
 *   mortgage_lien_foreclosure = T25 Ch. 21 (Mortgages), Ch. 26 (Commercial RE
 *                               Broker's Lien), Ch. 27 (Mechanics' Liens)
 *   general_real_property     = T25 Ch. 5 (Rule Against Perpetuities), Ch. 7
 *                               (Joint Estates & Partition), Ch. 9 (Waste),
 *                               Ch. 11 (Boundaries), Ch. 13 (Fences), Ch. 15
 *                               (Tort Liability of Owners), Ch. 16 (Lis Pendens)
 *
 * Cross-title items the recipe flagged but did NOT scope into these categories
 * (and are therefore NOT pulled here): foreclosure procedure (scire facias) in
 * T10 Ch. 49, and adverse-possession limitations in T10 §§7901-7902. Honest
 * note in the run summary.
 *
 * Run:  cd apps/api && node -r ts-node/register src/db/ingestDERealEstate.ts
 * Idempotent (ON CONFLICT DO NOTHING).
 */

import { execFileSync } from 'child_process'
import { query } from './index'
import { stripTags } from './ingestStateLawCorpus'

const STATE = 'DE'
const SOURCE_DATE = '2026-06-14'
const EFFECTIVE_YEAR = 2026
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 GAM-statute-ingest/1.0'

interface Parsed {
  number: string
  title: string | null
  text: string
}

/** title (24 or 25) → chapter numbers (3-digit) for one law_category. */
const CATEGORY_CHAPTERS: Record<string, { title: number; chapters: number[] }[]> = {
  conveyancing_title: [{ title: 25, chapters: [1, 2, 3] }],
  condo_coop: [{ title: 25, chapters: [22, 81] }],
  broker_licensing: [{ title: 24, chapters: [29, 40] }],
  mortgage_lien_foreclosure: [{ title: 25, chapters: [21, 26, 27] }],
  general_real_property: [{ title: 25, chapters: [5, 7, 9, 11, 13, 15, 16] }],
}

const pad3 = (n: number) => String(n).padStart(3, '0')
const chapterIndexUrl = (title: number, ch: number) =>
  `https://delcode.delaware.gov/title${title}/c${pad3(ch)}/index.html`
const subchapterUrl = (title: number, ch: number, sc: string) =>
  `https://delcode.delaware.gov/title${title}/c${pad3(ch)}/${sc}/index.html`

function curl(url: string): string {
  const buf = execFileSync('curl', ['-sL', '--max-time', '60', '-A', UA, url], {
    maxBuffer: 256 * 1024 * 1024,
  })
  return buf.toString('utf-8')
}

/**
 * Split a page's <div id="CodeBody"> region into per-section blocks and parse
 * each. A section block opens at <div class="Section"> and runs until the next
 * <div class="Section"> (or the end of CodeBody). The SectionHead div gives the
 * number (id= attribute, verbatim incl. dotted "81-101" / "317A" forms) and the
 * catchline; everything after the SectionHead within the block — body
 * paragraphs + the trailing history note — is the verbatim full_text.
 */
function parseSectionsPage(html: string, sourceUrl: string): Parsed[] {
  // Confine to the CodeBody so chapter-notes / nav / footer never leak in.
  const cbStart = html.indexOf('id="CodeBody"')
  if (cbStart === -1) return []
  // CodeBody ends at the ChapterNotes block if present, else end of the
  // content container. We just cut at ChapterNotes; trailing chrome after the
  // last section is harmless because each block is bounded by the next opener.
  let region = html.slice(cbStart)
  const notesIdx = region.indexOf('id="ChapterNotes"')
  if (notesIdx !== -1) region = region.slice(0, notesIdx)

  // Index every section opener, then slice block = [opener_i, opener_{i+1}).
  const openers: number[] = []
  const openRe = /<div class="Section">/gi
  let m: RegExpExecArray | null
  while ((m = openRe.exec(region)) !== null) openers.push(m.index)
  if (openers.length === 0) return []

  const out: Parsed[] = []
  for (let i = 0; i < openers.length; i++) {
    const block = region.slice(openers[i], i + 1 < openers.length ? openers[i + 1] : undefined)

    const headM = block.match(/<div class="SectionHead"[^>]*\bid="([^"]+)"[^>]*>([\s\S]*?)<\/div>/i)
    if (!headM) continue
    const number = headM[1].trim()
    if (!number) continue

    const headText = stripTags(headM[2], false).trim() // e.g. "§ 301. Fines and common recoveries."
    // Catchline = head text with the leading "§ NNN." citation stripped.
    let title: string | null = headText
      .replace(/^§\s*[0-9A-Za-z.\-]+\.?\s*/, '')
      .trim()
    if (!title) title = null

    // Drop repealed / reserved / transferred sections by their catchline.
    if (title && /^repealed\b/i.test(title)) continue
    if (title && /^\[?reserved\.?\]?$/i.test(title)) continue
    if (title && /^\[?transferred\b/i.test(title)) continue

    // Body = block content AFTER the SectionHead div.
    const afterHead = block.slice((headM.index ?? 0) + headM[0].length)
    const text = stripTags(afterHead, true).trim()

    if (!text || text.length < 20) continue
    if (/^\[?reserved\.?\]?$/i.test(text)) continue
    if (/^repealed\b/i.test(text)) continue

    out.push({ number, title, text })
  }
  return out
}

/** Discover scNN subchapter codes referenced from a chapter index page. */
function discoverSubchapters(html: string, title: number, ch: number): string[] {
  const re = new RegExp(`c${pad3(ch)}/(sc\\d+)/index\\.html`, 'gi')
  const seen = new Set<string>()
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) seen.add(m[1].toLowerCase())
  return [...seen].sort()
}

interface Page {
  url: string
  secs: Parsed[]
}

/** Fetch + parse one chapter, auto-recursing into subchapters when present. */
function fetchChapter(title: number, ch: number): Page[] {
  const idxUrl = chapterIndexUrl(title, ch)
  const idxHtml = curl(idxUrl)
  const inline = parseSectionsPage(idxHtml, idxUrl)
  if (inline.length > 0) {
    return [{ url: idxUrl, secs: inline }]
  }
  const subs = discoverSubchapters(idxHtml, title, ch)
  const pages: Page[] = []
  for (const sc of subs) {
    const scUrl = subchapterUrl(title, ch, sc)
    try {
      const secs = parseSectionsPage(curl(scUrl), scUrl)
      pages.push({ url: scUrl, secs })
    } catch (e: any) {
      console.warn(`  ! ${STATE} T${title} c${pad3(ch)}/${sc}: ${e?.message || e}`)
    }
  }
  return pages
}

async function insert(category: string, p: Parsed, sourceUrl: string): Promise<boolean> {
  // RETURNING id yields a row only on a real insert; ON CONFLICT DO NOTHING
  // returns zero rows — so rows.length distinguishes insert from dup.
  const rows = await query<{ id: string }>(
    `INSERT INTO state_law_section_texts
       (state_code, act_key, section_number, section_title, full_text, source_url, source_date, effective_year, law_category)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (state_code, act_key, section_number, effective_year) DO NOTHING
     RETURNING id`,
    [STATE, category, p.number, p.title, p.text, sourceUrl, SOURCE_DATE, EFFECTIVE_YEAR, category]
  )
  return rows.length > 0
}

async function ingestCategory(category: string): Promise<number> {
  const groups = CATEGORY_CHAPTERS[category]
  let inserted = 0
  let parsed = 0
  let skippedDup = 0
  for (const g of groups) {
    for (const ch of g.chapters) {
      let pages: Page[]
      try {
        pages = fetchChapter(g.title, ch)
      } catch (e: any) {
        console.warn(`  ! ${category} T${g.title} c${pad3(ch)}: ${e?.message || e}`)
        continue
      }
      for (const page of pages) {
        for (const sec of page.secs) {
          parsed++
          const ok = await insert(category, sec, page.url)
          if (ok) inserted++
          else skippedDup++
        }
      }
      const pageSecTotal = pages.reduce((a, p) => a + p.secs.length, 0)
      console.log(
        `  [${category}] T${g.title} c${pad3(ch)} → ${pages.length} page(s), ${pageSecTotal} section(s) kept`
      )
    }
  }
  console.log(`[${category}] parsed ${parsed}, inserted ${inserted}, conflict/dup ${skippedDup}`)
  return inserted
}

async function main() {
  console.log(`\n=== ${STATE} — ingesting real-estate statute corpus (as of ${SOURCE_DATE}) ===`)
  const counts: Record<string, number> = {}
  for (const category of Object.keys(CATEGORY_CHAPTERS)) {
    counts[category] = await ingestCategory(category)
  }
  const total = Object.values(counts).reduce((a, b) => a + b, 0)
  console.log(`\n${STATE} done. inserted=${total}`, counts)
  console.log(
    `Note: foreclosure procedure (scire facias, T10 Ch.49) and adverse possession (T10 §§7901-7902) are cross-title and NOT included in these Title 24/25 categories.`
  )
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
