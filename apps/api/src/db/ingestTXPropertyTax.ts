/**
 * Texas property-tax statute full-text ingester (sanctioned retrieve+cite+date
 * carve-out — verbatim statutory TEXT only, never advice).
 *
 * SOURCE: Texas Tax Code, Title 1 — Property Tax Code. The official statute
 * text is served as flat per-chapter HTML by the legislature's TCASCore file
 * server:
 *
 *     GET https://tcss.legis.texas.gov/resources/TX/htm/TX.{CHAPTER}.htm
 *
 * Plain HTTP, HTTP 200, ~37-475 KB each, no JS/auth. DO NOT hit
 * statutes.capitol.texas.gov/Docs/... or GetStatute.aspx — those return a
 * 250 KB Angular SPA shell with zero statute text. The real docs live behind
 * the SPA's configured FileServerPath (the tcss host above).
 *
 * PAGE LAYOUT: one big <pre xml:space="preserve"> block of Courier-formatted
 * text wrapped in per-line <p>/<div>. After stripping tags + unescaping
 * entities + collapsing whitespace, the body is plain statutory prose. Sections
 * are delimited by "Sec. N.NN.  CATCHLINE.  body...". We split on that
 * delimiter (group1 = section number like 31.032, group2 = the ALLCAPS
 * catchline = section_title). Each section body runs to the next "Sec." match.
 * The trailing "Acts ..."/"Added by"/"Amended by" source-note run is trimmed
 * off the body (we keep the prose; the source notes are the effective-date
 * provenance, not statute text). Repealed / reserved / empty (<20 char) and any
 * TOC/heading lines are dropped.
 *
 * CHAPTER → law-feature mapping (act_key is uniformly 'property_tax'; the
 * feature topic is informational only — all rows share act_key+law_category):
 *   exemptions             ch 11
 *   assessment             ch 23, 25, 26
 *   assessment_review      ch 41, 41A, 42
 *   levy_collection_payment ch 31
 *   delinquency_tax_sale   ch 32, 33, 34
 *
 * Run: cd apps/api && node -r ts-node/register src/db/ingestTXPropertyTax.ts
 * Idempotent (ON CONFLICT DO NOTHING).
 */

import { execFileSync } from 'child_process'
import { query } from './index'

const STATE = 'TX'
const ACT_KEY = 'property_tax'
const LAW_CATEGORY = 'property_tax'
const SOURCE_DATE = '2026-06-14'
const EFFECTIVE_YEAR = 2026
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'

const chapterUrl = (ch: string) =>
  `https://tcss.legis.texas.gov/resources/TX/htm/TX.${ch}.htm`

// Feature-topic → chapter list (per the triage parse recipe).
const TOPICS: Record<string, string[]> = {
  exemptions: ['11'],
  assessment: ['23', '25', '26'],
  assessment_review: ['41', '41A', '42'],
  levy_collection_payment: ['31'],
  delinquency_tax_sale: ['32', '33', '34'],
}

interface Section {
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

const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
  '&nbsp;': ' ',
}

function decodeEntities(s: string): string {
  let out = s.replace(/&(amp|lt|gt|quot|apos|nbsp|#39);/g, (m) => ENTITIES[m] ?? m)
  out = out.replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
  out = out.replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  return out
}

/** HTML → plain text: strip script/style + all tags, unescape, normalize ws. */
function htmlToText(html: string): string {
  let t = html.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, '')
  t = t.replace(/<[^>]+>/g, '')
  t = decodeEntities(t)
  t = t.replace(/ /g, ' ')
  // Normalize CR/LF + tabs to single spaces but keep it as one flowed string;
  // statutory prose doesn't depend on the Courier line wrapping.
  t = t.replace(/[\t\r\n]+/g, ' ')
  t = t.replace(/ {2,}/g, ' ')
  return t
}

// Section delimiter: "Sec. 31.032.  CATCHLINE.  " — group1 number, group2 title.
const SEC_RE =
  /Sec\.\s*(\d+[A-Z]?\.\d+[A-Z]?)\.\s+([A-Z][A-Z0-9 ,;:&'()./-]+?)\.\s/g

// Trailing source-note run: the first "Added by"/"Amended by"/"Acts NNNN," that
// begins the provenance block at the end of a section body. The bare "Acts NNNN,"
// branch must NOT carry a trailing \b — it ends in a comma, between which and the
// following space there is no word boundary, so \b would silently fail that branch
// and let the leading source note leak through (only the later "Amended by" note
// would be caught). Each branch is whitespace-prefixed and word-boundary-led.
const SOURCE_NOTE_RE =
  /\s+(?:Added by Acts\b|Amended by Acts\b|Acts\s+\d{4},|Renumbered from\b|Repealed by Acts\b)/

function parseChapter(html: string): Section[] {
  const txt = htmlToText(html)
  const out: Section[] = []
  const matches = [...txt.matchAll(SEC_RE)]
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i]
    const number = m[1]
    let title: string | null = m[2].trim()
    const bodyStart = m.index! + m[0].length
    const bodyEnd = i + 1 < matches.length ? matches[i + 1].index! : txt.length
    let body = txt.slice(bodyStart, bodyEnd).trim()

    // Drop the trailing source-note provenance run from the verbatim body.
    const sn = body.search(SOURCE_NOTE_RE)
    if (sn > 0) body = body.slice(0, sn).trim()

    // Repealed / reserved / empty drops.
    if (title && /^repealed\b/i.test(title)) continue
    if (title && /^\(?reserved\)?$/i.test(title)) continue
    if (!title) title = null
    if (!body || body.length < 20) continue
    if (/^\(?repealed/i.test(body)) continue
    if (/^\(?reserved\)?\.?$/i.test(body)) continue

    out.push({ number, title, text: body })
  }
  return out
}

async function ingestChapter(ch: string): Promise<{ parsed: number; inserted: number }> {
  let sections: Section[]
  try {
    sections = parseChapter(curl(chapterUrl(ch)))
  } catch (e: any) {
    console.warn(`  ! chapter ${ch} FAILED: ${e?.message || e}`)
    return { parsed: 0, inserted: 0 }
  }
  let inserted = 0
  for (const s of sections) {
    const r = await query<{ id: string }>(
      `INSERT INTO state_law_section_texts
         (state_code, act_key, section_number, section_title, full_text,
          source_url, source_date, effective_year, law_category)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (state_code, act_key, section_number, effective_year)
       DO NOTHING
       RETURNING id`,
      [
        STATE,
        ACT_KEY,
        s.number,
        s.title,
        s.text,
        chapterUrl(ch),
        SOURCE_DATE,
        EFFECTIVE_YEAR,
        LAW_CATEGORY,
      ]
    )
    inserted += r.length
  }
  console.log(`  ch ${ch}: parsed ${sections.length}, inserted ${inserted}`)
  return { parsed: sections.length, inserted }
}

async function main() {
  console.log(`\n=== TX property-tax corpus ingest (as of ${SOURCE_DATE}) ===`)
  let totalParsed = 0
  let totalInserted = 0
  for (const [topic, chapters] of Object.entries(TOPICS)) {
    console.log(`[${topic}] chapters ${chapters.join(', ')}`)
    for (const ch of chapters) {
      const { parsed, inserted } = await ingestChapter(ch)
      totalParsed += parsed
      totalInserted += inserted
      await new Promise((r) => setTimeout(r, 300)) // politeness
    }
  }
  console.log(`\nTX done. parsed=${totalParsed} inserted=${totalInserted}`)
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
