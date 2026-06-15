/**
 * Florida property-tax statute full-text ingester (sanctioned retrieve+cite+date
 * carve-out — verbatim statutory prose, never advice).
 *
 * Official source: Online Sunshine (www.leg.state.fl.us), the Florida
 * Legislature's site. Each chapter is one server-rendered HTML page served via a
 * CFM query-string endpoint (no JS required — plain curl works):
 *
 *   GET http://www.leg.state.fl.us/Statutes/index.cfm?App_mode=Display_Statute
 *       &URL=0100-0199/0NNN/0NNN.html
 *
 * where 0NNN is the zero-padded chapter (0192-0197) and 0100-0199 is the
 * chapter-range folder. Page <TITLE> is "The Florida Statutes"; the header
 * elsewhere labels the "2025 Florida Statutes" edition.
 *
 * PAGE LAYOUT (confirmed by recon, not handoff):
 *   Each chapter page opens with a <div class="CatchlineIndex"> table-of-contents
 *   block (one <div class="IndexItem"> per section — section number + catchline,
 *   NO body). THAT TOC IS SKIPPED. The actual statutory prose lives further down
 *   in a run of flat sibling <div class="Section"> blocks, each shaped:
 *
 *     <div class="Section">
 *       <span class="SectionNumber">196.001&#x2003;</span>
 *       <span class="Catchline">
 *         <span class="CatchlineText">Property subject to taxation.</span>
 *         <span class="EmDash">&#x2014;</span>
 *       </span>
 *       <span class="SectionBody"> ...verbatim prose, nested Subsection/Paragraph
 *         divs with (1)/(a)/1. Number spans... </span>
 *       <div class="History"><span class="HistoryTitle">History.</span>...
 *         <span class="HistoryText">s. 16, ch. 71-133.</span></div>
 *     </div>
 *
 *   The TOC IndexItems also carry SectionNumber spans, which is why a chapter
 *   shows ~2x SectionNumber spans vs. Section divs — splitting on
 *   `<div class="Section">` keeps us strictly in the prose, never the index.
 *
 * INGESTER RECIPE:
 *   (1) fetch each chapter page;
 *   (2) split into <div class="Section"> blocks (flat siblings);
 *   (3) per block: SectionNumber = leading SectionNumber span; title =
 *       CatchlineText; body = SectionBody prose with subsection structure
 *       preserved, then the History note appended as the dated-provenance
 *       trailer (last-amendment chapter laws);
 *   (4) drop repealed / reserved / empty (<20 char) / any block missing a
 *       SectionBody;
 *   (5) stamp retrieval date 2026-06-14 + effective_year 2026, law_category
 *       property_tax.
 *
 * ACT MAPPING — all five chapters share act_key 'property_tax' (the prompt's
 * contract); the five feature groups map onto the chapters:
 *   exemptions             = ch. 196 (Exemption)
 *   assessment             = ch. 192 (general provisions) + ch. 193 (Assessments)
 *   assessment_review      = ch. 194 (Administrative and Judicial Review)
 *   levy/collection/payment + delinquency/tax-sale = ch. 197 (Tax Collections,
 *                            Sales, and Liens)
 *
 * Run: cd apps/api && node -r ts-node/register src/db/ingestFLPropertyTax.ts
 * Idempotent (ON CONFLICT DO NOTHING).
 */

import { execFileSync } from 'child_process'
import { query } from './index'

const STATE = 'FL'
const ACT_KEY = 'property_tax'
const LAW_CATEGORY = 'property_tax'
const SOURCE_DATE = '2026-06-14'
const EFFECTIVE_YEAR = 2026
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) GAM-statute-ingest/1.0'

const chapterUrl = (ch: string) =>
  `http://www.leg.state.fl.us/Statutes/index.cfm?App_mode=Display_Statute&URL=0100-0199/${ch}/${ch}.html`

// Zero-padded chapters covering the five feature groups (192-197; 195 is
// assessment administration and is included for completeness of the ad-valorem
// set if present).
const CHAPTERS = ['0192', '0193', '0194', '0195', '0196', '0197']

interface Parsed {
  number: string
  title: string | null
  text: string
}

function curl(url: string): string {
  const buf = execFileSync('curl', ['-sL', '--max-time', '90', '-A', UA, url], {
    maxBuffer: 256 * 1024 * 1024,
  })
  return buf.toString('utf-8')
}

/** Decode the small set of numeric/named entities the source uses. */
function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&sect;/g, '§')
}

/**
 * Convert an inner-HTML run to plain text, preserving statutory structure:
 * block-level <div>/<p> boundaries become newlines so subsection numbering
 * ((1), (a), 1.) stays readable. Em-spaces ( ) after Number labels are
 * normalized to a single space. Verbatim word-for-word otherwise.
 */
function htmlToText(html: string): string {
  let s = html
  // Block-level containers -> newline so nested subsections separate cleanly.
  s = s.replace(/<\/(div|p)>/gi, '\n')
  s = s.replace(/<div\b[^>]*>/gi, '\n')
  // Drop every remaining tag (spans carry no semantic structure we need).
  s = s.replace(/<[^>]+>/g, '')
  s = decodeEntities(s)
  // Normalize the em-space label separators + collapse intra-line runs.
  s = s.replace(/ /g, ' ')
  s = s
    .split('\n')
    .map((line) => line.replace(/[ \t\f\v]+/g, ' ').trim())
    .filter((line) => line.length > 0)
    .join('\n')
  return s.trim()
}

/** Extract the inner HTML of the FIRST element of `cls` (greedy across nested
 *  same-class? no — we capture to the structural close used by the source). We
 *  rely on the source's flat span layout: SectionBody and History are single
 *  spans/divs that do not nest another element of their own class. */
function firstClassInner(html: string, tag: string, cls: string): string | null {
  // Match <tag class="cls" ...> ... </tag> with balanced-enough capture by
  // taking from the open to the matching close at the same depth. The source's
  // SectionBody/History do not contain a nested element of the same tag+class,
  // so a depth scan on `tag` suffices.
  const open = new RegExp(`<${tag}\\b[^>]*class="${cls}"[^>]*>`, 'i')
  const m = open.exec(html)
  if (!m) return null
  const start = m.index + m[0].length
  const reTag = new RegExp(`<${tag}\\b[^>]*>|</${tag}>`, 'gi')
  reTag.lastIndex = start
  let depth = 1
  let mm: RegExpExecArray | null
  while ((mm = reTag.exec(html)) !== null) {
    if (mm[0].toLowerCase().startsWith('</')) {
      depth--
      if (depth === 0) return html.slice(start, mm.index)
    } else {
      depth++
    }
  }
  return null
}

/** Parse one <div class="Section"> block. */
function parseSection(block: string): Parsed | null {
  const numM = /<span class="SectionNumber">([^<]+)<\/span>/i.exec(block)
  if (!numM) return null
  const number = decodeEntities(numM[1]).replace(/ /g, '').trim()
  if (!number) return null

  const catchM = /<span[^>]*class="CatchlineText"[^>]*>([\s\S]*?)<\/span>/i.exec(block)
  let title: string | null = catchM ? htmlToText(catchM[1]).replace(/\s+/g, ' ').trim() : null
  if (title) title = title.replace(/[.—\s]+$/, '').trim() || null

  // Drop repealed / reserved sections (catchline tells us).
  if (title && /^repealed\b/i.test(title)) return null
  if (title && /^\[?reserved\.?\]?$/i.test(title)) return null

  const bodyHtml = firstClassInner(block, 'span', 'SectionBody')
  if (!bodyHtml) return null
  let body = htmlToText(bodyHtml)

  // Append the History note as the dated-provenance trailer (last-amendment
  // chapter laws), matching the corpus convention.
  const histHtml = firstClassInner(block, 'div', 'History')
  if (histHtml) {
    const hist = htmlToText(histHtml).replace(/\s+/g, ' ').trim()
    if (hist) body = `${body}\n${hist}`
  }

  body = body.trim()
  if (!body || body.length < 20) return null
  if (/^\[?reserved\.?\]?$/i.test(body)) return null
  if (/^repealed\b/i.test(body)) return null

  return { number, title, text: body }
}

function parseChapter(html: string): Parsed[] {
  // Section divs are flat siblings. Split on the open tag, then for each piece
  // re-prepend the open tag and trim at the next sibling boundary (already done
  // by the split). The leading piece before the first Section div is the
  // CatchlineIndex TOC — discarded by the split.
  const parts = html.split(/<div class="Section">/i).slice(1)
  const out: Parsed[] = []
  const seen = new Set<string>()
  for (const raw of parts) {
    // Each `raw` runs until end-of-document; bound it at the next Section div
    // (already split) — but the History close + chapter wrapper may trail. We
    // only read the first SectionNumber/Catchline/SectionBody/History, all of
    // which precede any sibling content, so depth-scoped extractors are safe.
    const block = `<div class="Section">${raw}`
    const p = parseSection(block)
    if (!p) continue
    if (seen.has(p.number)) continue
    seen.add(p.number)
    out.push(p)
  }
  return out
}

async function main() {
  console.log(`\n=== FL — ingesting property-tax full-text corpus (as of ${SOURCE_DATE}) ===`)
  let total = 0
  const perChapter: Record<string, number> = {}
  const failures: string[] = []

  for (const ch of CHAPTERS) {
    const url = chapterUrl(ch)
    let html = ''
    try {
      html = curl(url)
    } catch (e: any) {
      failures.push(`ch ${ch}: fetch failed — ${e?.message || e}`)
      console.warn(`  ! ch ${ch} fetch failed: ${e?.message || e}`)
      continue
    }
    if (!/The Florida Statutes/i.test(html) && !/class="Section"/i.test(html)) {
      failures.push(`ch ${ch}: unexpected page (no Section divs / not Florida Statutes)`)
      console.warn(`  ! ch ${ch}: unexpected page content`)
      continue
    }
    const sections = parseChapter(html)
    if (sections.length === 0) {
      failures.push(`ch ${ch}: 0 sections parsed (page may be a TOC-only or chapter is repealed)`)
      console.warn(`  ! ch ${ch}: parsed 0 sections`)
      continue
    }
    let ok = 0
    for (const s of sections) {
      await query(
        `INSERT INTO state_law_section_texts
           (state_code, act_key, section_number, section_title, full_text, source_url, source_date, effective_year, law_category)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (state_code, act_key, section_number, effective_year) DO NOTHING`,
        [STATE, ACT_KEY, s.number, s.title, s.text, url, SOURCE_DATE, EFFECTIVE_YEAR, LAW_CATEGORY]
      )
      ok++
    }
    perChapter[ch] = ok
    total += ok
    console.log(`  [ch ${ch}] parsed+inserted ${ok} sections`)
  }

  console.log(`\nFL done. parsed=${total}`, perChapter)
  if (failures.length) {
    console.log('FAILURES:')
    failures.forEach((f) => console.log('  - ' + f))
  }
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
