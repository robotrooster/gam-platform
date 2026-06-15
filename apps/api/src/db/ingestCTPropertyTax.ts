/**
 * Connecticut property-tax statute full-text ingester (sanctioned retrieve+cite+
 * date carve-out — verbatim official statutory text, never advice).
 *
 * SOURCE: Connecticut General Assembly official publication of the General
 * Statutes, Title 12 (Taxation). Three chapters cover the property-tax lifecycle:
 *   - Chapter 203 (chap_203.htm) — Property Tax Assessment  (incl. exemptions
 *     Sec. 12-81 et seq., valuation/revaluation 12-62/12-63, board of assessment
 *     appeals 12-110 to 12-119, appeal to superior court 12-117a)
 *   - Chapter 204 (chap_204.htm) — Local Levy and Collection of Taxes (incl.
 *     12-145 notice/due, 12-146 delinquent interest, 12-157 tax sale of realty)
 *   - Chapter 205 (chap_205.htm) — Municipal Tax Liens (12-172 lien priority,
 *     12-181 foreclosure, 12-195h lien assignment)
 *
 * All sections land under a single act_key='property_tax' /
 * law_category='property_tax'. The five triage "topics" (exemptions, assessment,
 * assessment_review, levy_collection_payment, delinquency_tax_sale) are just
 * descriptive groupings of section ranges within these three chapters — they do
 * not map to distinct act_keys.
 *
 * FETCH: raw_http GET (curl). Each chapter is a single static UTF-8 HTML doc
 * (~1MB for ch.203); no JS rendering needed.
 *
 * PAGE LAYOUT (verified at ingest time): a Table-of-Contents block at top, then
 * the statute body. The two are separated by <hr class="chaps_pg_bar">. Every
 * body section is delimited by:
 *     <p><span class="catchln" id="sec_12-NN">Sec. 12-NN. Catchline.</span> body…</p>
 * followed by zero or more plain <p> body-continuation paragraphs, then metadata
 * trailers carrying their own classes: source-first / history-first /
 * annotation[-first] / cross-ref[-first] / editor*. The TOC entries use class
 * "toc_catchln" and are skipped because we only read from the body region
 * (everything after the first chaps_pg_bar).
 *
 * EXTRACTION:
 *   1. Slice to the body region (from the first chaps_pg_bar onward).
 *   2. Walk <p> blocks. A block whose first child is <span class="catchln"
 *      id="sec_…"> opens a new section; its number + catchline come from the span,
 *      its first body fragment is the post-span text in the same <p>.
 *   3. Subsequent plain <p> (no class attr) extend the body. STOP collecting at
 *      the first metadata-class <p> (source/history/annotation/cross-ref/editor).
 *      Stopping at the first metadata para also excludes the appended
 *      future-effective "*Note: On and after <date>, this section … is to read as
 *      follows:" amended-version blocks — we keep only the currently in-force text.
 *   4. DROP repealed/reserved/transferred sections — both those flagged in the
 *      catchline AND those whose whole body is "Section 12-NN is repealed."
 *   5. DROP empties / bodies < 20 chars.
 *
 * full_text is stored as "Sec. 12-NN. Catchline\n<body>" — verbatim, entities
 * decoded, U+00A0 normalized, tags stripped. No advice, no editorializing.
 *
 * Run: cd apps/api && node -r ts-node/register src/db/ingestCTPropertyTax.ts
 * Idempotent (ON CONFLICT DO NOTHING).
 */

import { execFileSync } from 'child_process'
import { query } from './index'
import { stripTags } from './ingestStateLawCorpus'

const STATE = 'CT'
const ACT_KEY = 'property_tax'
const LAW_CATEGORY = 'property_tax'
const SOURCE_DATE = '2026-06-14'
const EFFECTIVE_YEAR = 2026
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) GAM-statute-ingest/1.0'

const CHAPTERS = [
  { ch: '203', label: 'assessment + exemptions + assessment_review' },
  { ch: '204', label: 'levy_collection_payment + tax sale' },
  { ch: '205', label: 'delinquency_tax_sale (municipal liens)' },
]
const chapUrl = (ch: string) => `https://www.cga.ct.gov/current/pub/chap_${ch}.htm`

interface Parsed {
  number: string
  title: string | null
  fullText: string
}

function curl(url: string): string {
  const buf = execFileSync('curl', ['-sL', '--max-time', '90', '-A', UA, url], {
    maxBuffer: 256 * 1024 * 1024,
  })
  return buf.toString('utf-8')
}

// Metadata-class paragraphs that mark the END of a section's statutory body.
const META_CLASS = /class="(source|history|annotation|cross-ref|editor)/i
// Whole-body repeal note (catchline title lacks "repealed" for these).
const REPEAL_BODY = /^Sections?\s+12-[0-9a-z, and]+\s+(?:is|are)\s+repealed/i
const RESERVED_BODY = /^\[?reserved\b/i
const REPEALED_TITLE = /\b(?:Repealed|Reserved|Transferred)\b/

/**
 * Parse one chapter page into its current-in-force sections. Reads only the body
 * region (after the first chaps_pg_bar) so TOC catchlines never leak in.
 */
function parseChapter(html: string): Parsed[] {
  const barIdx = html.indexOf('chaps_pg_bar')
  const body = barIdx >= 0 ? html.slice(barIdx) : html
  const paras = body.match(/<p\b[^>]*>[\s\S]*?<\/p>/gi) || []

  interface Acc {
    number: string
    title: string
    parts: string[]
  }
  const sections: Acc[] = []
  let cur: Acc | null = null
  let stopped = false

  const catchOpen =
    /^<p\b[^>]*>\s*<span class="catchln" id="sec_[0-9a-z-]+">\s*Sec\.\s*(12-[0-9a-z]+)\.\s*([\s\S]*?)<\/span>([\s\S]*)$/i

  for (const p of paras) {
    const m = p.match(catchOpen)
    if (m) {
      if (cur) sections.push(cur)
      const after = stripTags(m[3], false).trim()
      cur = {
        number: m[1],
        title: stripTags(m[2], false).trim(),
        parts: after ? [after] : [],
      }
      stopped = false
      continue
    }
    if (!cur || stopped) continue
    if (META_CLASS.test(p)) {
      stopped = true // first metadata para ends the statutory body
      continue
    }
    const t = stripTags(p, false).trim()
    if (t) cur.parts.push(t)
  }
  if (cur) sections.push(cur)

  const out: Parsed[] = []
  for (const s of sections) {
    const bodyText = s.parts.join('\n').trim()
    if (REPEALED_TITLE.test(s.title)) continue
    if (REPEAL_BODY.test(bodyText) || RESERVED_BODY.test(bodyText)) continue
    if (!bodyText || bodyText.length < 20) continue
    const title = s.title || null
    const fullText = `Sec. ${s.number}. ${s.title}\n${bodyText}`.trim()
    out.push({ number: s.number, title, fullText })
  }
  return out
}

async function ingestChapter(ch: string): Promise<{ parsed: number; inserted: number }> {
  const html = curl(chapUrl(ch))
  const sections = parseChapter(html)
  let inserted = 0
  for (const s of sections) {
    const res = await query<{ id: string }>(
      `INSERT INTO state_law_section_texts
         (state_code, act_key, section_number, section_title, full_text, source_url, source_date, effective_year, law_category)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (state_code, act_key, section_number, effective_year) DO NOTHING
       RETURNING id`,
      [
        STATE,
        ACT_KEY,
        s.number,
        s.title,
        s.fullText,
        chapUrl(ch),
        SOURCE_DATE,
        EFFECTIVE_YEAR,
        LAW_CATEGORY,
      ]
    )
    if (res.length > 0) inserted++
  }
  return { parsed: sections.length, inserted }
}

async function main() {
  console.log(`\n=== CT — ingesting property-tax full-text corpus (as of ${SOURCE_DATE}) ===`)
  let totalParsed = 0
  let totalInserted = 0
  for (const { ch, label } of CHAPTERS) {
    const { parsed, inserted } = await ingestChapter(ch)
    totalParsed += parsed
    totalInserted += inserted
    console.log(`  chap_${ch} (${label}): parsed ${parsed}, inserted ${inserted}`)
  }
  console.log(`\nCT done. parsed=${totalParsed} inserted=${totalInserted}`)
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
