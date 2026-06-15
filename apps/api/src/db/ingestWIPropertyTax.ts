/**
 * Wisconsin property-tax statute full-text ingester (sanctioned legal-corpus
 * retrieve+cite+date carve-out: verbatim codified text only, never advice).
 *
 * Source: the official Wisconsin Legislature docs site (docs.legis.wisconsin.gov)
 * — no Justia/Lexis/Wayback. The property-tax corpus spans three chapters:
 *   Ch. 70  General Property Taxes      (levy, definitions, exemptions,
 *                                        valuation/assessment, board of review)
 *   Ch. 74  Property Tax Collection     (tax bills, payment dates, installments,
 *                                        delinquency interest/penalty, settlement)
 *   Ch. 75  Land Sold for Taxes         (redemption, tax deeds, in-rem tax-lien
 *                                        foreclosure)
 * Together these chapters fully contain the five triage topic groups
 * (exemptions, assessment, assessment_review, levy_collection_payment,
 * delinquency_tax_sale), so we ingest every codified section in all three.
 *
 * TWO-SOURCE RECIPE (both official, cross-checked):
 *  1) SECTION LIST — the authoritative, complete set of section numbers per
 *     chapter is harvested from the chapter's verbatim PDF body
 *     (/statutes/statutes/{chapter}.pdf). Every codified section appears as a
 *     left-margin heading "NN.NNN  Title."; we collect the distinct
 *     "^{chapter}\.\d+" tokens. The HTML chapter TOC (/statutes/statutes/
 *     {chapter}/_4) is window-paginated and returns only ~60 entries, so the
 *     PDF body is the reliable full index. The PDF also carries the
 *     "Updated 2023-24 Wis. Stats." currency banner, logged for the date stamp.
 *  2) VERBATIM TEXT — fetched per section from the clean HTML document page
 *     /document/statutes/{number} (static server-rendered HTML, no JS). The
 *     page renders a band of surrounding sections, each paragraph <div> tagged
 *     with data-section="{number}"; we select only the target section's
 *     qsatxt_* paragraph divs. Verbatim prose lives in <span class="qstr">
 *     string runs — concatenated in document order. We strip:
 *       - the qsnum_sect / qstitle_sect heading spans (number + catchline, kept
 *         separately as section_number / section_title)
 *       - <a class="reference"> cross-reference links
 *       - qsnote_history (legislative history) and qsnote_annot (annotation)
 *         divs — these are NOT codified text (they also carry data-section, so
 *         they must be excluded by class, which the qsatxt_-only div filter does
 *         automatically since notes use qsnote_* div classes).
 *     Repealed / reserved / empty (<20 char) bodies are dropped.
 *
 * INSERT is idempotent (ON CONFLICT DO NOTHING on the
 * (state_code, act_key, section_number, effective_year) unique key).
 *
 * Run: cd apps/api && node -r ts-node/register src/db/ingestWIPropertyTax.ts
 */

import { execFileSync } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { query } from './index'

const STATE = 'WI'
const ACT_KEY = 'property_tax'
const LAW_CATEGORY = 'property_tax'
const SOURCE_DATE = '2026-06-14'
const EFFECTIVE_YEAR = 2026
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) GAM-statute-ingest/1.0'
const BASE = 'https://docs.legis.wisconsin.gov'

const CHAPTERS = ['70', '74', '75'] as const

const docUrl = (num: string) => `${BASE}/document/statutes/${num}`
const pdfUrl = (ch: string) => `${BASE}/statutes/statutes/${ch}.pdf`

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

function curlBinary(url: string, outPath: string): void {
  execFileSync('curl', ['-sL', '--max-time', '120', '-A', UA, url, '-o', outPath], {
    maxBuffer: 8 * 1024,
  })
}

/** HTML-entity decode + tag strip for a string run. */
function clean(s: string): string {
  s = s.replace(/<[^>]+>/g, '')
  s = s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#8203;/g, '')
    .replace(/&#8201;/g, ' ')
    .replace(/&#8203;/g, '')
    .replace(/&#8212;/g, '—')
    .replace(/&#8211;/g, '–')
    .replace(/&#8217;/g, '’')
    .replace(/&#8220;/g, '“')
    .replace(/&#8221;/g, '”')
    .replace(/&#8195;/g, ' ')
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  return s
}

/**
 * Harvest the complete, distinct, ordered list of section numbers for a chapter
 * from its verbatim PDF body. Section headings sit at the left margin as
 * "^{chapter}.NNN  ". Requires pdftotext (poppler) on PATH.
 */
function harvestSectionNumbers(ch: string): { numbers: string[]; banner: string | null } {
  const tmp = path.join(os.tmpdir(), `wi_ch_${ch}_${Date.now()}.pdf`)
  curlBinary(pdfUrl(ch), tmp)
  let pdfText = ''
  try {
    pdfText = execFileSync('pdftotext', ['-layout', tmp, '-'], {
      maxBuffer: 64 * 1024 * 1024,
    }).toString('utf-8')
  } finally {
    try {
      fs.unlinkSync(tmp)
    } catch {
      /* ignore */
    }
  }

  const bannerMatch = pdfText.match(/Updated\s+\d{2,4}-\d{2}\s+Wis\.?\s*Stats?\.?/)
  const banner = bannerMatch ? bannerMatch[0] : null

  // Left-margin section heading: a line that begins with the chapter number,
  // a dot, digits, then whitespace (the catchline follows). Collect distinct.
  const re = new RegExp(`^${ch}\\.(\\d+)(?=\\s)`, 'gm')
  const seen = new Set<string>()
  const out: string[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(pdfText)) !== null) {
    const num = `${ch}.${m[1]}`
    if (seen.has(num)) continue
    seen.add(num)
    out.push(num)
  }
  // Sort by the numeric subsection part so output is deterministic.
  out.sort((a, b) => {
    const an = parseInt(a.split('.')[1], 10)
    const bn = parseInt(b.split('.')[1], 10)
    if (an !== bn) return an - bn
    return a.length - b.length
  })
  return { numbers: out, banner }
}

/**
 * Extract one section's verbatim codified text from its HTML document page.
 * Selects the codified-text paragraph divs whose data-section matches `target` —
 * the qsatxt_* paragraph classes plus qsanomaly (boxed/irregular codified inserts,
 * e.g. the statutory "PROPERTY OWNER RIGHTS" notice embedded in s. 70.05) — and
 * concatenates their qstr string runs after stripping the heading spans and
 * cross-reference links. qsnote_history / qsnote_annot (legislative history /
 * annotations) use qsnote_* div classes and are deliberately NOT selected, so
 * only codified text is kept.
 */
function parseSection(html: string, target: string): Parsed | null {
  const divRe = /<div class="(qsatxt_[^"]*|qsanomaly)"([^>]*)>([\s\S]*?)<\/div>/g
  const parts: string[] = []
  let title: string | null = null
  let m: RegExpExecArray | null
  while ((m = divRe.exec(html)) !== null) {
    const attrs = m[2]
    const ds = attrs.match(/data-section="([^"]*)"/)
    if (!ds || ds[1] !== target) continue
    let inner = m[3]

    // Pull the catchline (title) from the heading paragraph if present.
    if (title === null) {
      const mt = inner.match(/qstitle_sect"><span class="qstr"[^>]*>([^<]*)<\/span>/)
      if (mt) {
        const t = clean(mt[1]).trim()
        if (t) title = t
      }
    }

    // Drop the heading's number + catchline spans (kept as separate columns).
    inner = inner.replace(/<span class="qsnum_sect">[\s\S]*?<\/span><\/span>/g, '')
    inner = inner.replace(/<span class="qstitle_sect">[\s\S]*?<\/span><\/span>/g, '')
    // Drop cross-reference link labels.
    inner = inner.replace(/<a class="reference"[^>]*>[\s\S]*?<\/a>/g, '')

    // Concatenate verbatim string runs in document order.
    const runs = [...inner.matchAll(/<span class="qstr"[^>]*>([\s\S]*?)<\/span>/g)].map((r) =>
      clean(r[1])
    )
    const para = runs.join('').trim()
    if (para) parts.push(para)
  }

  let text = parts.join('\n')
  text = text.replace(/[ \t]+/g, ' ').replace(/\n[ \t]+/g, '\n').trim()

  if (title && /^repealed\b/i.test(title)) return null
  if (title && /^\[?reserved\.?\]?$/i.test(title)) return null
  if (!text || text.length < 20) return null
  if (/^\[?reserved\.?\]?$/i.test(text)) return null
  if (/^repealed\b/i.test(text)) return null

  return { number: target, title, text }
}

async function ingestChapter(ch: string): Promise<{ inserted: number; skipped: number; total: number }> {
  const { numbers, banner } = harvestSectionNumbers(ch)
  console.log(`\n[ch ${ch}] ${numbers.length} sections; currency: ${banner ?? 'n/a'}`)

  let inserted = 0
  let skipped = 0
  for (let i = 0; i < numbers.length; i++) {
    const num = numbers[i]
    let parsed: Parsed | null = null
    try {
      parsed = parseSection(curl(docUrl(num)), num)
    } catch (e: any) {
      console.warn(`  ! ${num}: ${e?.message || e}`)
    }
    if (!parsed) {
      skipped++
    } else {
      await query(
        `INSERT INTO state_law_section_texts
           (state_code, act_key, section_number, section_title, full_text, source_url, source_date, effective_year, law_category)
         VALUES ('WI','property_tax',$1,$2,$3,$4,'2026-06-14',2026,'property_tax')
         ON CONFLICT (state_code, act_key, section_number, effective_year) DO NOTHING`,
        [parsed.number, parsed.title, parsed.text, docUrl(num)]
      )
      inserted++
    }
    if ((i + 1) % 10 === 0 || i === numbers.length - 1) {
      process.stdout.write(`\r  [ch ${ch}] ${i + 1}/${numbers.length} (inserted ${inserted}, skipped ${skipped})`)
    }
    await new Promise((r) => setTimeout(r, 150)) // politeness
  }
  console.log(`\n  [ch ${ch}] inserted ${inserted}, skipped ${skipped} of ${numbers.length}`)
  return { inserted, skipped, total: numbers.length }
}

async function main() {
  console.log(`\n=== WI — ingesting property-tax full-text corpus (as of ${SOURCE_DATE}) ===`)
  console.log(`chapters: ${CHAPTERS.join(', ')} | act_key=${ACT_KEY} law_category=${LAW_CATEGORY}`)

  let totalInserted = 0
  const per: Record<string, { inserted: number; skipped: number; total: number }> = {}
  for (const ch of CHAPTERS) {
    per[ch] = await ingestChapter(ch)
    totalInserted += per[ch].inserted
  }

  console.log(`\nWI done. inserted=${totalInserted}`, per)
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
