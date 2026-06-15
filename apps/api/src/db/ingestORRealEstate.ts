/**
 * Oregon non-tax real-estate statute full-text ingester (sanctioned
 * retrieve+cite+date carve-out — verbatim statute text, never advice).
 *
 * SOURCE: the Oregon Legislature's official ORS publication, one plain
 * server-rendered HTML page per chapter at the stable pattern
 *   https://www.oregonlegislature.gov/bills_laws/ors/ors{NNN}.html
 * (zero-padded 3-digit chapter, e.g. ors093.html). No JS — a single curl
 * with a browser UA returns the whole chapter.
 *
 * PAGE LAYOUT (Word "Save as Web Page" export, windows-1252 encoded):
 *   The page opens with a Table of Contents — section numbers + catchlines
 *   in PLAIN (non-bold) <p class=MsoNormal> spans. The statute BODY follows,
 *   where each section is a <p class=MsoNormal> whose <b>…</b> run holds
 *   "NN.NNN  Catchline." and the statutory text follows the </b> in the same
 *   paragraph. Multi-subsection sections continue in following non-bold
 *   MsoNormal paragraphs ((2),(3)… and (a),(b)…) until the next bold header.
 *   Each section ends with a bracketed source/history note kept verbatim as
 *   the statutory source-note trailer (e.g. "[Amended by 1965 c.502 §4]").
 *
 * The bold-header discriminator is what separates real statute bodies from
 * the leading TOC: TOC lines are never bold, so a paragraph whose <b> text
 * starts with NN.NNN is unambiguously a section body. Repealed / renumbered /
 * reserved stubs (a bold number followed only by "[Repealed by …]") and any
 * body shorter than 20 chars are dropped.
 *
 * Encoding: the pages are windows-1252 (§, §§, ’ “ ” all live in the 0x80–
 * 0x9F / 0xA0 range). We fetch raw bytes via curl and decode latin1→cp1252
 * by mapping with Buffer 'latin1' then a small cp1252 fix-up, so § and curly
 * quotes survive into full_text exactly as published.
 *
 * CATEGORY → ORS CHAPTER MAPPING (law_category == act_key for every block):
 *   conveyancing_title         = Ch.93  (Conveyancing and Recording)
 *   condo_coop                 = Ch.100 (Condominiums) + Ch.94 (Planned
 *                                Communities / common-interest developments)
 *   broker_licensing           = Ch.696 (Real Estate & Escrow Activities) +
 *                                Ch.674 (Appraiser licensing)
 *   mortgage_lien_foreclosure  = Ch.86  (Mortgages; Trust Deeds) + Ch.87
 *                                (Statutory/Construction Liens) + Ch.88
 *                                (Foreclosure of Mortgages & Other Liens)
 *   general_real_property      = Ch.105 (Property Rights) + Ch.91 (Tenancy;
 *                                Reversions & Escheats) + Ch.92 (Subdivisions
 *                                & Partitions)
 *
 * Run: cd apps/api && node -r ts-node/register src/db/ingestORRealEstate.ts
 * Idempotent (ON CONFLICT DO NOTHING on
 *   (state_code, act_key, section_number, effective_year)).
 */

import { execFileSync } from 'child_process'
import { query } from './index'

const STATE = 'OR'
const SOURCE_DATE = '2026-06-14'
const EFFECTIVE_YEAR = 2026
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) GAM-statute-ingest/1.0'
const orsUrl = (ch: string) => `https://www.oregonlegislature.gov/bills_laws/ors/ors${ch}.html`

// category key (== act_key == law_category) -> zero-padded 3-digit chapters
const CATEGORIES: Record<string, string[]> = {
  conveyancing_title: ['093'],
  condo_coop: ['100', '094'],
  broker_licensing: ['696', '674'],
  mortgage_lien_foreclosure: ['086', '087', '088'],
  general_real_property: ['105', '091', '092'],
}

interface Section {
  number: string
  title: string | null
  text: string
}

/** Fetch raw bytes and decode as windows-1252 so §, §§, and curly quotes survive. */
function curlCp1252(url: string): string {
  const buf = execFileSync(
    'curl',
    ['-sL', '--max-time', '120', '-A', UA, url],
    { maxBuffer: 256 * 1024 * 1024 }
  ) as Buffer
  // Map every byte through the cp1252 code page (windows-1252). Buffer's
  // 'latin1' is byte-identical for 0x00-0xFF; we then fix the 0x80-0x9F band
  // where cp1252 differs from latin1 (curly quotes, §§ ligature region, etc.).
  let s = buf.toString('latin1')
  const CP1252: Record<number, string> = {
    0x80: '€', 0x82: '‚', 0x83: 'ƒ', 0x84: '„',
    0x85: '…', 0x86: '†', 0x87: '‡', 0x88: 'ˆ',
    0x89: '‰', 0x8a: 'Š', 0x8b: '‹', 0x8c: 'Œ',
    0x8e: 'Ž', 0x91: '‘', 0x92: '’', 0x93: '“',
    0x94: '”', 0x95: '•', 0x96: '–', 0x97: '—',
    0x98: '˜', 0x99: '™', 0x9a: 'š', 0x9b: '›',
    0x9c: 'œ', 0x9e: 'ž', 0x9f: 'Ÿ',
  }
  s = s.replace(/[\x80-\x9f]/g, (c) => CP1252[c.charCodeAt(0)] ?? c)
  return s
}

/** Strip tags → readable verbatim text; decode entities; normalize whitespace. */
function stripTags(html: string): string {
  let s = html
  s = s.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
  s = s.replace(/<[^>]+>/g, ' ')
  s = s
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&rsquo;/gi, '’')
    .replace(/&lsquo;/gi, '‘')
    .replace(/&ldquo;/gi, '“')
    .replace(/&rdquo;/gi, '”')
    .replace(/&sect;/gi, '§')
    .replace(/&mdash;/gi, '—')
    .replace(/&ndash;/gi, '–')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
  s = s.replace(/ /g, ' ').replace(/[ \t\r\n]+/g, ' ')
  return s.trim()
}

const SEC_RE = /^(\d{2,3}\.\d{3})\b/
// A body that BEGINS with a repeal/reserve verb is a placeholder, not statute.
const DROP_BODY_RE = /^\[?(Repealed|Renumbered|Reserved)\b/i
// A body that is WHOLLY a single bracketed source/history note (e.g.
// "[1963 c.440 §12; renumbered 696.579]") is a repealed/renumbered stub with
// no statutory prose — these must be dropped too. Legitimate sections carry
// statutory text BEFORE any trailing bracketed history note, so this only
// fires when the bracket note is the entire content.
const BRACKET_ONLY_RE = /^\[[^\]]*\]$/

/**
 * True for a topical banner / group header (document chrome the recipe flags,
 * e.g. "REAL ESTATE LICENSEES", "ESCROWS AND ESCROW AGENTS", "ATTRIBUTES AND
 * DUTIES OF OWNERSHIP", "PENALTIES") and the parenthetical sub-group labels
 * that sit under them ("(Generally)", "(Client Trust Fund Accounts)",
 * "(Filing Requirements)"). These sit as their own non-bold paragraphs
 * between sections and must NOT be glued onto the preceding section's verbatim
 * text. Also strips the "_______________" rule-divider lines.
 *
 * Two discriminators (a line is chrome if EITHER fires):
 *   1) ALL-CAPS banner: at least two uppercase letters and NO lowercase
 *      letters at all (statute prose always has lowercase, so this is safe).
 *   2) Parenthetical sub-banner: the whole line is wrapped in (...) and is a
 *      short Title-Case label, not a sentence (no terminal period, <= 70 chars).
 */
function isBannerOrChrome(line: string): boolean {
  const t = line.trim()
  if (!t) return true
  if (/^_+$/.test(t)) return true // section-end rule divider
  // 1) ALL-CAPS banner (no lowercase anywhere).
  if (!/[a-z]/.test(t)) {
    const upper = (t.match(/[A-Z]/g) || []).length
    if (upper >= 2) return true
  }
  // 2) Parenthetical sub-group label: "(Generally)", "(Filing Requirements)".
  if (/^\([A-Z][^)]*\)$/.test(t) && t.length <= 70 && !/[.;:]/.test(t)) return true
  return false
}

/**
 * Parse one ORS chapter HTML page into verbatim sections. A paragraph is a
 * section header iff its <b>…</b> text starts with NN.NNN (TOC lines are not
 * bold, so they are excluded). Body = the rest of the header paragraph plus
 * every following non-bold MsoNormal paragraph until the next header. Drops
 * repealed/renumbered/reserved stubs and bodies under 20 chars.
 */
function parseChapter(html: string): Section[] {
  const paras = [...html.matchAll(/<p class=MsoNormal[^>]*>[\s\S]*?<\/p>/gi)].map((m) => m[0])
  const sections: { number: string; title: string | null; body: string[] }[] = []
  let cur: { number: string; title: string | null; body: string[] } | null = null

  for (const p of paras) {
    const boldRuns = [...p.matchAll(/<b>([\s\S]*?)<\/b>/gi)].map((m) => m[1])
    const boldTxt = stripTags(boldRuns.join(' '))
    const fullTxt = stripTags(p)
    const m = boldTxt ? SEC_RE.exec(boldTxt) : null
    if (m) {
      if (cur) sections.push(cur)
      const number = m[1]
      let catchline = boldTxt.slice(number.length).trim()
      let body = fullTxt.slice(number.length).trim()
      if (catchline && body.startsWith(catchline)) body = body.slice(catchline.length).trim()
      const title = catchline.replace(/\.$/, '').trim() || null
      cur = { number, title, body: body ? [body] : [] }
    } else if (cur && fullTxt && !isBannerOrChrome(fullTxt)) {
      cur.body.push(fullTxt)
    }
  }
  if (cur) sections.push(cur)

  const out: Section[] = []
  for (const s of sections) {
    // Filter out any banner/chrome lines that slipped into the body.
    const lines = s.body
      .join('\n')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !isBannerOrChrome(l))
    const text = lines.join('\n').trim()
    if (!text || text.length < 20) continue
    // A section whose FIRST content line is a bracketed history note has no
    // statutory prose — it is a repealed/renumbered/reserved stub. Drop it.
    if (BRACKET_ONLY_RE.test(lines[0])) continue
    if (DROP_BODY_RE.test(text)) continue
    if (BRACKET_ONLY_RE.test(text)) continue
    out.push({ number: s.number, title: s.title, text })
  }
  return out
}

async function ingestCategory(category: string, chapters: string[]): Promise<number> {
  let inserted = 0
  for (const ch of chapters) {
    const url = orsUrl(ch)
    let html: string
    try {
      html = curlCp1252(url)
    } catch (e: any) {
      console.warn(`  ! ${category} ch.${ch}: fetch failed: ${e?.message || e}`)
      continue
    }
    const secs = parseChapter(html)
    let chOk = 0
    for (const sec of secs) {
      await query(
        `INSERT INTO state_law_section_texts
           (state_code, act_key, section_number, section_title, full_text, source_url, source_date, effective_year, law_category)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (state_code, act_key, section_number, effective_year) DO NOTHING`,
        [STATE, category, sec.number, sec.title, sec.text, url, SOURCE_DATE, EFFECTIVE_YEAR, category]
      )
      chOk++
      inserted++
    }
    console.log(`  [${category}] ch.${ch} ${secs.length} sections (${chOk} upserted)`)
  }
  return inserted
}

async function main() {
  console.log(`\n=== OR — ingesting non-tax real-estate statute corpus (as of ${SOURCE_DATE}) ===`)
  const counts: Record<string, number> = {}
  for (const [category, chapters] of Object.entries(CATEGORIES)) {
    counts[category] = await ingestCategory(category, chapters)
  }
  const total = Object.values(counts).reduce((a, b) => a + b, 0)
  console.log(`\nOR done. upserted=${total}`, counts)
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
