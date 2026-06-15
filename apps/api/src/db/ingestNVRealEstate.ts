/**
 * Nevada (NV) non-tax real-estate statute full-text ingester (S473 corpus).
 *
 * Sanctioned retrieve+cite+date carve-out: verbatim official statute text only,
 * never advice. Source is the Nevada Legislature's official NRS reader at
 * https://www.leg.state.nv.us/NRS/NRS-{chap}.html.
 *
 * SITE SHAPE (verified at build time):
 *   - Each chapter is ONE Microsoft-Word-filtered HTML document, served
 *     windows-1252 (cp1252) encoded — bytes MUST be decoded as cp1252, not
 *     utf-8 (decoding as utf-8 corrupts the &#8194; en-spaces / smart quotes
 *     the page is built from).
 *   - The page opens with a TOC of <p class="COLeadline"> entries (skipped),
 *     then the section bodies. Each section body BEGINS with a header paragraph:
 *         <p class="SectBody"><span class="Empty"> <a name=NRS{chap}Sec{id}></a>
 *           NRS </span><span class="Section">111.010</span>
 *           <span class="Empty"> </span><span class="Leadline">Definitions.</span>
 *           <span class="Empty"> </span>...statutory text...</p>
 *     followed by additional <p class="SectBody"> body paragraphs and a final
 *     <p class="SourceNote"> history note (kept as the trailing source note,
 *     which the carve-out allows — it is part of the official section block).
 *   - We split the document at each SectBody paragraph that contains a
 *     <span class="Section"> (the section-header paragraph) and take the slice
 *     up to the next such header. This is more robust than splitting on the
 *     <a name=...> anchors, which a handful of sections omit.
 *   - section_number  = text of <span class="Section">  (e.g. "111.010", and
 *     decimal-subdivided forms like "116.11045", "645.0005").
 *   - section_title   = text of <span class="Leadline">  (the catchline).
 *   - full_text       = the whole section block, tags stripped, entities
 *     unescaped, en-space/nbsp fillers collapsed to spaces. Em-dashes and
 *     smart quotes are PRESERVED for verbatim fidelity.
 *
 * Filenames are zero-padded to 3 digits (NRS-040.html), and the body anchor
 * token follows the filename padding (<a name=NRS040Sec001>), but we never
 * depend on the anchor token — the real citation comes from the Section span,
 * so cross-chapter padding differences are irrelevant.
 *
 * CATEGORY → CHAPTER MAPPING (law_category == act_key == category key):
 *   conveyancing_title         = NRS 111 (Estates in Property; Conveyancing & Recording)
 *   condo_coop                 = NRS 116 (Common-Interest Ownership / Uniform Act) +
 *                                116A (community managers) + 116B (Condominium Hotel
 *                                Act) + 117 (legacy Condominiums). NV folds condo +
 *                                HOA + co-op into the Ch 116 common-interest scheme.
 *   broker_licensing           = NRS 645 (Real Estate Brokers and Salespersons)
 *   mortgage_lien_foreclosure  = NRS 106 (Real Mortgages) + 107 (Deeds of Trust —
 *                                NV's primary nonjudicial foreclosure mechanism) +
 *                                108 construction-lien range 108.221-108.246
 *                                (Ch 108 also carries many non-RE statutory liens,
 *                                so we restrict to the mechanic's/construction-lien
 *                                sections for real-property scope, per recipe).
 *   general_real_property      = NRS 40 (Actions & Proceedings Concerning Property:
 *                                quiet title, adverse possession, partition,
 *                                ejectment, unlawful detainer, judicial foreclosure).
 *
 * Run: cd apps/api && node -r ts-node/register src/db/ingestNVRealEstate.ts
 * Idempotent (ON CONFLICT DO NOTHING). Repealed/reserved/short (<20 char)
 * bodies are dropped.
 */

import { execFileSync } from 'child_process'
import { query } from './index'

const STATE = 'NV'
const SOURCE_DATE = '2026-06-14'
const EFFECTIVE_YEAR = 2026
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) GAM-statute-ingest/1.0'
const chapUrl = (file: string) => `https://www.leg.state.nv.us/NRS/NRS-${file}.html`

interface Parsed {
  number: string
  title: string | null
  text: string
  /** The "[Effective ...]" / "[Expires ...]" tag from the catchline, if any.
   *  NV publishes BOTH the current and the future-effective version of a section
   *  under the same number; this tag distinguishes the temporal variants so both
   *  verbatim texts can be retained (the unique constraint is per section_number). */
  effectiveTag: string | null
}

/** Space-like code points (en/em/nbsp/thin/etc.) collapsed to a single ASCII space. */
const SPACELIKE = new Set<number>([
  0x00a0, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007,
  0x2008, 0x2009, 0x200a, 0x200b, 0x202f, 0x205f, 0x3000, 0xfeff,
])

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
}

/**
 * Tags → readable text. Strips all markup, unescapes entities, collapses only
 * space-like fillers (en-space / nbsp / thin space) to ASCII spaces while
 * PRESERVING em-dashes and smart quotes (verbatim fidelity), then normalizes
 * runs of ASCII whitespace.
 */
function strip(html: string): string {
  let s = html.replace(/<[^>]+>/g, ' ')
  s = decodeEntities(s)
  s = Array.from(s)
    .map((ch) => (SPACELIKE.has(ch.codePointAt(0) as number) ? ' ' : ch))
    .join('')
  s = s.replace(/[ \t\r\n]+/g, ' ').trim()
  return s
}

const CP1252 = new TextDecoder('windows-1252')

/**
 * Fetch a chapter page and decode as true cp1252. The NRS reader emits raw
 * cp1252 bytes in the 0x80-0x9F range (0x91/0x93/0x94 = smart quotes/apostrophe)
 * which latin1 would corrupt into control characters — TextDecoder('windows-1252')
 * maps them to the correct Unicode for verbatim fidelity. Other special glyphs
 * (en-space &#8194;, em-dash) arrive as numeric entities handled in decodeEntities.
 */
function fetchChapter(file: string): string {
  const buf = execFileSync('curl', ['-sL', '--max-time', '90', '-A', UA, chapUrl(file)], {
    maxBuffer: 256 * 1024 * 1024,
  })
  return CP1252.decode(buf)
}

const SECTION_HEADER_RE =
  /<p class="SectBody">(?:(?!<\/p>)[\s\S])*?<span\s+class="Section">/gi
const SECTION_NUM_RE = /<span\s+class="Section">([^<]+)<\/span>/i
const LEADLINE_RE = /<span\s+class="Leadline">([^<]*)<\/span>/i

/**
 * Parse a chapter document into verbatim sections. Splits at each section-header
 * paragraph (a SectBody <p> carrying a Section span) and slices to the next.
 */
function parseChapter(html: string): Parsed[] {
  const heads: number[] = []
  let m: RegExpExecArray | null
  SECTION_HEADER_RE.lastIndex = 0
  while ((m = SECTION_HEADER_RE.exec(html)) !== null) heads.push(m.index)

  const out: Parsed[] = []
  for (let i = 0; i < heads.length; i++) {
    const block = html.slice(heads[i], i + 1 < heads.length ? heads[i + 1] : html.length)

    const numMatch = block.match(SECTION_NUM_RE)
    if (!numMatch) continue
    const number = strip(numMatch[1])
    if (!number) continue

    const leadMatch = block.match(LEADLINE_RE)
    let title: string | null = leadMatch ? strip(leadMatch[1]) : null
    if (title === '') title = null

    // Drop repealed / reserved sections (catchline-signalled).
    if (title && /^(repealed|reserved)\b/i.test(title)) continue
    if (title && /^\[?reserved\.?\]?$/i.test(title)) continue

    const text = strip(block)
    if (!text || text.length < 20) continue
    if (/^\[?reserved\.?\]?$/i.test(text)) continue

    // Extract a temporal-variant tag from the catchline (e.g. "[Effective July 1,
    // 2026.]", "[Effective until ...]") so duplicate section numbers stay distinct.
    let effectiveTag: string | null = null
    if (title) {
      const t = title.match(/\[(Effective|Expires|Repealed)\b[^\]]*\]/i)
      if (t) effectiveTag = t[0]
    }

    out.push({ number, title, text, effectiveTag })
  }
  return out
}

async function ingestCategory(
  category: string,
  parts: { file: string; restrict?: { lo: number; hi: number } }[]
): Promise<number> {
  let inserted = 0
  // Section numbers already used in THIS category. NV publishes current +
  // future-effective versions under the same number; we keep both by suffixing
  // the later occurrence's section_number with its effective tag.
  const usedNumbers = new Set<string>()
  for (const part of parts) {
    const html = fetchChapter(part.file)
    let secs = parseChapter(html)
    if (part.restrict) {
      // NRS 108: restrict to the construction-lien decimal range (108.221-108.246).
      secs = secs.filter((s) => {
        const ps = s.number.split('.')
        if (ps.length < 2) return false
        const dec = parseInt(ps[1].slice(0, 3).padEnd(3, '0'), 10)
        return dec >= part.restrict!.lo && dec <= part.restrict!.hi
      })
    }
    const url = chapUrl(part.file)
    let okThisPart = 0
    for (const s of secs) {
      let sectionNumber = s.number
      if (usedNumbers.has(sectionNumber)) {
        // Disambiguate a temporal-variant duplicate so both verbatim texts land.
        const suffix = s.effectiveTag ? ` ${s.effectiveTag}` : ` (variant ${okThisPart})`
        sectionNumber = `${s.number}${suffix}`
        // Extremely defensive: if even the suffixed form collides, append index.
        let n = 2
        while (usedNumbers.has(sectionNumber)) sectionNumber = `${s.number}${suffix} #${n++}`
      }
      usedNumbers.add(sectionNumber)
      const res = await query<{ id: string }>(
        `INSERT INTO state_law_section_texts
           (state_code, act_key, section_number, section_title, full_text,
            source_url, source_date, effective_year, law_category)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (state_code, act_key, section_number, effective_year) DO NOTHING
         RETURNING id`,
        [STATE, category, sectionNumber, s.title, s.text, url, SOURCE_DATE, EFFECTIVE_YEAR, category]
      )
      if (res.length > 0) okThisPart++
    }
    inserted += okThisPart
    console.log(`  [${category}] NRS-${part.file}: ${okThisPart} sections`)
    await new Promise((r) => setTimeout(r, 300)) // politeness between chapter fetches
  }
  return inserted
}

async function main() {
  console.log(`\n=== NV — ingesting real-estate statute corpus (as of ${SOURCE_DATE}) ===`)

  const counts: Record<string, number> = {}

  counts['conveyancing_title'] = await ingestCategory('conveyancing_title', [{ file: '111' }])

  counts['condo_coop'] = await ingestCategory('condo_coop', [
    { file: '116' },
    { file: '116A' },
    { file: '116B' },
    { file: '117' },
  ])

  counts['broker_licensing'] = await ingestCategory('broker_licensing', [{ file: '645' }])

  counts['mortgage_lien_foreclosure'] = await ingestCategory('mortgage_lien_foreclosure', [
    { file: '106' },
    { file: '107' },
    { file: '108', restrict: { lo: 221, hi: 246 } },
  ])

  counts['general_real_property'] = await ingestCategory('general_real_property', [{ file: '040' }])

  const total = Object.values(counts).reduce((a, b) => a + b, 0)
  console.log(`\nNV done. attempted-insert=${total}`, counts)
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
