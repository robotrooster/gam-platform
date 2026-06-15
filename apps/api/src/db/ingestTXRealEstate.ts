/**
 * Texas NON-TAX real-estate statute full-text ingester (round 2).
 *
 * Sanctioned retrieve+cite+date carve-out — verbatim statutory TEXT only,
 * never advice. Companion to ingestTXPropertyTax.ts; covers the five non-tax
 * categories a first-pass triage missed (it landed on the Angular SPA shell at
 * statutes.capitol.texas.gov / TOC pages and found no section text).
 *
 * SOURCE: the legislature's official TCASCore flat file server, same host the
 * property-tax ingester uses. The real per-chapter statute text lives at:
 *
 *     GET https://tcss.legis.texas.gov/resources/{CODE}/htm/{CODE}.{CH}.htm
 *
 * e.g. Property Code Ch 5 -> resources/PR/htm/PR.5.htm (273 KB, HTTP 200,
 * plain HTTP, no JS/auth). DO NOT hit statutes.capitol.texas.gov/Docs/PR/...
 * or /StatutesByDate/?link=PR — those return a ~250 KB Angular SPA shell with
 * zero statute text. (The SPA's own JSON backend at /api/StatutesByDate/...
 * also serves the text, but the flat file server is one GET per chapter and
 * uses the exact same <pre> parse as the property-tax ingester, so we use it.)
 *
 * PAGE LAYOUT: one big <pre xml:space="preserve"> block of Courier-formatted
 * text wrapped in per-line <p>/<div>. After stripping tags + unescaping
 * entities + collapsing whitespace, the body is plain statutory prose. Sections
 * are delimited by "Sec. N.NN.  CATCHLINE.  body...". We split on that
 * delimiter (group1 = section number like 1101.001 or 5.001, group2 = the
 * ALLCAPS catchline = section_title). Each section body runs to the next "Sec."
 * match. The trailing "Acts ..."/"Added by"/"Amended by" source-note run is
 * trimmed off the body. Repealed / reserved / empty (<20 char) / TOC drops.
 *
 * CATEGORY → code/chapter mapping (act_key == law_category per row):
 *   conveyancing_title        PR 5, 11, 12, 13, 15  (conveyances + recording)
 *   condo_coop                PR 82 (Uniform Condo Act) + PR 81 (pre-1994)
 *   broker_licensing          OC 1101 (TRELA) + 1102/1103/1104 (inspectors,
 *                             appraisers, AMCs)
 *   mortgage_lien_foreclosure PR 51 (deed-of-trust/non-judicial foreclosure)
 *                             + 52 (judgment lien) + 53 (mechanic's lien)
 *   general_real_property     PR 22 (trespass to try title) + PR 21 (eminent
 *                             domain) + CP 16 adverse-possession limitations
 *                             periods only (Secs. 16.024-16.030)
 *
 * Run: cd apps/api && node -r ts-node/register src/db/ingestTXRealEstate.ts
 * Idempotent (ON CONFLICT DO NOTHING).
 */

import { execFileSync } from 'child_process'
import { query } from './index'

const STATE = 'TX'
const SOURCE_DATE = '2026-06-14'
const EFFECTIVE_YEAR = 2026
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'

const chapterUrl = (code: string, ch: string) =>
  `https://tcss.legis.texas.gov/resources/${code}/htm/${code}.${ch}.htm`

interface ChapterSpec {
  code: string // PR / OC / CP
  ch: string
  /** Optional section-number filter; when present, only matching sections are kept. */
  keep?: (sectionNumber: string) => boolean
}

// Category → list of {code, chapter, optional section filter}.
const CATEGORIES: Record<string, ChapterSpec[]> = {
  conveyancing_title: [
    { code: 'PR', ch: '5' },
    { code: 'PR', ch: '11' },
    { code: 'PR', ch: '12' },
    { code: 'PR', ch: '13' },
    { code: 'PR', ch: '15' },
  ],
  condo_coop: [
    { code: 'PR', ch: '82' },
    { code: 'PR', ch: '81' },
  ],
  broker_licensing: [
    { code: 'OC', ch: '1101' },
    { code: 'OC', ch: '1102' },
    { code: 'OC', ch: '1103' },
    { code: 'OC', ch: '1104' },
  ],
  mortgage_lien_foreclosure: [
    { code: 'PR', ch: '51' },
    { code: 'PR', ch: '52' },
    { code: 'PR', ch: '53' },
  ],
  general_real_property: [
    { code: 'PR', ch: '22' },
    { code: 'PR', ch: '21' },
    // CP Ch 16 is the general limitations chapter; scope to the adverse-
    // possession periods only (Secs. 16.024-16.030), per the category brief.
    {
      code: 'CP',
      ch: '16',
      keep: (n) => {
        const m = /^16\.0(\d\d)$/.exec(n)
        if (!m) return false
        const sub = Number(m[1])
        return sub >= 24 && sub <= 30
      },
    },
  ],
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
  t = t.replace(/[\t\r\n]+/g, ' ')
  t = t.replace(/ {2,}/g, ' ')
  return t
}

// Section delimiter: "Sec. 1101.001.  CATCHLINE.  " — group1 number, group2 title.
// \d+ on the chapter part handles 4-digit Occupations Code chapters (1101).
const SEC_RE =
  /Sec\.\s*(\d+[A-Z]?\.\d+[A-Z]?)\.\s+([A-Z][A-Z0-9 ,;:&'()./-]+?)\.\s/g

// Trailing source-note run: the first provenance marker at the end of a section
// body. The bare "Acts NNNN," branch must NOT carry a trailing \b — it ends in a
// comma, so \b would silently fail that branch.
const SOURCE_NOTE_RE =
  /\s+(?:Added by Acts\b|Amended by Acts\b|Acts\s+\d{4},|Renumbered from\b|Repealed by Acts\b)/

function parseChapter(html: string, keep?: (n: string) => boolean): Section[] {
  const txt = htmlToText(html)
  const out: Section[] = []
  const matches = [...txt.matchAll(SEC_RE)]
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i]
    const number = m[1]
    if (keep && !keep(number)) continue
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

async function ingestChapter(
  category: string,
  spec: ChapterSpec
): Promise<{ parsed: number; inserted: number }> {
  const url = chapterUrl(spec.code, spec.ch)
  let sections: Section[]
  try {
    sections = parseChapter(curl(url), spec.keep)
  } catch (e: any) {
    console.warn(`  ! ${spec.code}.${spec.ch} FAILED: ${e?.message || e}`)
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
        category, // act_key == category
        s.number,
        s.title,
        s.text,
        url,
        SOURCE_DATE,
        EFFECTIVE_YEAR,
        category, // law_category == category
      ]
    )
    inserted += r.length
  }
  console.log(`  ${spec.code}.${spec.ch}: parsed ${sections.length}, inserted ${inserted}`)
  return { parsed: sections.length, inserted }
}

async function main() {
  console.log(`\n=== TX non-tax real-estate corpus ingest (as of ${SOURCE_DATE}) ===`)
  let totalParsed = 0
  let totalInserted = 0
  for (const [category, specs] of Object.entries(CATEGORIES)) {
    console.log(`[${category}] ${specs.map((s) => `${s.code}.${s.ch}`).join(', ')}`)
    for (const spec of specs) {
      const { parsed, inserted } = await ingestChapter(category, spec)
      totalParsed += parsed
      totalInserted += inserted
      await new Promise((r) => setTimeout(r, 300)) // politeness
    }
  }
  console.log(`\nTX non-tax done. parsed=${totalParsed} inserted=${totalInserted}`)
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
