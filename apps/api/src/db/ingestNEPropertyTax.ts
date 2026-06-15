/**
 * Nebraska property-tax statute full-text ingester (S-corpus property_tax tranche).
 *
 * SANCTIONED carve-out: GAM is a national platform with a strict no-state-
 * specific-legal-logic rule, EXCEPT for the retrieve+cite+date legal corpus
 * (verbatim statutory TEXT, never advice). This file ingests the OFFICIAL text
 * of Nebraska Revised Statutes Chapter 77 (Revenue and Taxation), property-tax
 * articles, from the Nebraska Legislature's own site.
 *
 * SOURCE (official only — no Justia/Lexis/Wayback):
 *   https://nebraskalegislature.gov/laws/statutes.php?statute=77-NNN
 *   Chapter index (enumerates every 77-* section id):
 *   https://nebraskalegislature.gov/laws/browse-chapters.php?chapter=77
 *
 * Fetchability: raw_http. Plain server-rendered HTML, no JS, no login, no
 * cookies, no rate-limit. curl is sufficient (no Playwright needed).
 *
 * PAGE LAYOUT (UTF-8): the statute body lives inside
 *   <div class="statute"> ... </div>
 *     <h2>77-NNN.</h2>            -> section number (also have it from the crawl)
 *     <h3>Catchline.</h3>         -> section_title
 *     <p class="text-justify">…</p> (one per subsection) -> statutory body, VERBATIM
 *   <div> <h2>Source</h2> <ul>…Laws YYYY, LB …</ul> </div>   -> amendment history
 *   <div class="statute_source"> <h2>Annotations</h2> …case law… </div>
 *
 * We capture ONLY the catchline + the text-justify paragraphs (the statutory
 * prose). The Source history and the Annotations (case-law digest) are NOT
 * statute text and are excluded from full_text. The last "Laws YYYY" in the
 * Source block is captured as a last-amended date signal (logged only; the DB
 * source_date / effective_year are fixed at the read date per the corpus rules).
 *
 * SECTION MAP — five feature groups (act_key='property_tax' for all):
 *   exemptions         §§ 77-202 .. 77-202.47   (art 2 exemptions enumerated)
 *   assessment         §§ 77-201, 77-201.01; art 13 §§ 77-1301..77-1394
 *                      (real/ag assessment, special & historic valuation);
 *                      Property Tax Administrator art 7 §§ 77-701..77-709;
 *                      public-service-entity assessment §§ 77-801..77-804
 *   assessment_review  art 15 §§ 77-1501..77-1510 (county board of equalization;
 *                      protests; appeal to TERC)
 *   levy_collection_   §§ 77-203, 77-204, 77-1214 (taxes due/delinquent/install-
 *     payment         ment dates); levy art 16 §§ 77-1601..; collection by county
 *                      treasurer art 17 §§ 77-1701..
 *   delinquency_tax_   art 18 §§ 77-1801..77-1863 (collection by sale; tax sale
 *     sale             certificates; redemption; tax deeds)
 *
 * The candidate section ids are harvested live from the chapter index and
 * filtered to the numeric ranges above, so repealed/non-existent ids never get
 * requested for nothing and decimal subsections (77-202.01 etc.) are included.
 * Repealed / transferred / reserved / empty (<20 char) bodies are dropped.
 *
 * Run: cd apps/api && node -r ts-node/register src/db/ingestNEPropertyTax.ts
 * Idempotent (ON CONFLICT DO NOTHING on
 *   (state_code, act_key, section_number, effective_year)).
 */

import { execFileSync } from 'child_process'
import { query } from './index'
import { stripTags } from './ingestStateLawCorpus'

const STATE = 'NE'
const ACT_KEY = 'property_tax'
const LAW_CATEGORY = 'property_tax'
const SOURCE_DATE = '2026-06-14'
const EFFECTIVE_YEAR = 2026
const UA = 'GAM-statute-ingest/1.0 (compliance research)'
const BASE = 'https://nebraskalegislature.gov/laws'
const CHAPTER_INDEX = `${BASE}/browse-chapters.php?chapter=77`
const sectionUrl = (sec: string) => `${BASE}/statutes.php?statute=77-${sec}`

interface Parsed {
  number: string // bare numeric tail, e.g. "202.01"
  title: string | null
  text: string
  lastLawsYear: string | null
}

/**
 * Fetch a statute page, retrying transient misses. The gov server occasionally
 * returns a truncated/non-statute body under concurrent load; a real page ALWAYS
 * contains the <div class="statute"> container (repealed pages included). So we
 * retry up to 3x with backoff until that marker appears, and only then trust the
 * response. Without this, transient misses were silently counted as "repealed/
 * empty" skips and live sections went missing.
 */
function curl(url: string): string {
  let last = ''
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const buf = execFileSync('curl', ['-sL', '--max-time', '60', '--retry', '2', '-A', UA, url], {
        maxBuffer: 256 * 1024 * 1024,
      })
      last = buf.toString('utf-8')
      if (last.includes('<div class="statute">')) return last
    } catch {
      /* fall through to retry */
    }
    if (attempt < 3) {
      execFileSync('sleep', [String(0.5 * attempt)]) // synchronous backoff
    }
  }
  return last // best effort; parse layer will null-out a still-bad page
}

/**
 * Enumerate every "77-<tail>" statute id appearing on the chapter index, return
 * the distinct numeric tails (e.g. "201", "202.01", "1394").
 */
function harvestChapterIds(html: string): string[] {
  const re = /statutes\.php\?statute=77-([0-9]+(?:\.[0-9]+)?)/g
  const seen = new Set<string>()
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) seen.add(m[1])
  return [...seen]
}

/** Numeric base of a tail ("202.01" -> 202). */
function baseOf(tail: string): number {
  return parseInt(tail.split('.')[0], 10)
}

/** Sort tails numerically by base then by subsection. */
function sortTails(a: string, b: string): number {
  const [ab, as_] = a.split('.')
  const [bb, bs] = b.split('.')
  const d = parseInt(ab, 10) - parseInt(bb, 10)
  if (d !== 0) return d
  return (parseInt(as_ || '0', 10) || 0) - (parseInt(bs || '0', 10) || 0)
}

/**
 * Parse a Nebraska statute page. Isolate the <div class="statute"> block, take
 * the <h3> catchline as title and every <p class="text-justify"> inside that
 * block (before the Source/Annotations sections) as the verbatim body.
 * Returns null for a repealed/reserved/transferred/empty section.
 */
function parseStatutePage(html: string, tail: string): Parsed | null {
  // Slice from the statute container to the Source heading (history) or the
  // Annotations container (case law) — whichever comes first — so neither the
  // amendment history nor the case-law digest can leak into full_text.
  const open = html.indexOf('<div class="statute">')
  if (open === -1) return null
  let rest = html.slice(open + '<div class="statute">'.length)

  // Capture the amendment-history block (between <h2>Source</h2> and </ul>) for
  // the last-amended-year date signal, then cut the body at that boundary.
  let lastLawsYear: string | null = null
  const srcIdx = rest.search(/<h2>\s*Source\s*<\/h2>/i)
  let bodyHtml: string
  if (srcIdx !== -1) {
    bodyHtml = rest.slice(0, srcIdx)
    const years = [...rest.slice(srcIdx).matchAll(/Laws\s+(\d{4})/g)].map((m) => m[1])
    if (years.length) lastLawsYear = years[years.length - 1]
  } else {
    // No Source block — cut at Annotations or the statute_source container.
    const annIdx = rest.search(/<div class="statute_source">|<h2>\s*Annotations\s*<\/h2>/i)
    bodyHtml = annIdx !== -1 ? rest.slice(0, annIdx) : rest
  }

  // Title = first <h3> catchline.
  const h3 = bodyHtml.match(/<h3[^>]*>([\s\S]*?)<\/h3>/i)
  let title: string | null = h3 ? stripTags(h3[1], false).trim() : null
  if (title === '') title = null

  // Drop repealed / transferred / reserved sections (catchline is the marker).
  if (title && /^(repealed|transferred|reserved)\b/i.test(title)) return null
  if (title && /^\[?reserved\.?\]?$/i.test(title)) return null

  // Body = every <p class="text-justify"> paragraph, verbatim (inner links
  // become their text), joined newline-separated to preserve subsection layout.
  const paras = [...bodyHtml.matchAll(/<p[^>]*class="[^"]*text-justify[^"]*"[^>]*>([\s\S]*?)<\/p>/gi)]
    .map((m) => stripTags(m[1], true).trim())
    .filter(Boolean)
  const text = paras.join('\n').trim()

  if (!text || text.length < 20) return null
  if (/^\[?reserved\.?\]?$/i.test(text)) return null
  return { number: tail, title, text, lastLawsYear }
}

interface Group {
  label: string
  inRange: (tail: string) => boolean
}

const GROUPS: Group[] = [
  {
    label: 'exemptions',
    // §§ 77-202 .. 77-202.47
    inRange: (t) => baseOf(t) === 202,
  },
  {
    label: 'assessment',
    // 77-201/201.01; art13 1301-1394; PTA art7 701-709; public-service 801-804
    inRange: (t) => {
      const b = baseOf(t)
      return b === 201 || (b >= 1301 && b <= 1394) || (b >= 701 && b <= 709) || (b >= 801 && b <= 804)
    },
  },
  {
    label: 'assessment_review',
    // art15 1501-1510
    inRange: (t) => baseOf(t) >= 1501 && baseOf(t) <= 1510,
  },
  {
    label: 'levy_collection_payment',
    // 203, 204, 1214; levy art16 1601-1699; collection art17 1701-1799
    inRange: (t) => {
      const b = baseOf(t)
      return b === 203 || b === 204 || b === 1214 || (b >= 1601 && b <= 1699) || (b >= 1701 && b <= 1799)
    },
  },
  {
    label: 'delinquency_tax_sale',
    // art18 1801-1863
    inRange: (t) => baseOf(t) >= 1801 && baseOf(t) <= 1863,
  },
]

async function ingestGroup(group: Group, tails: string[]): Promise<{ ok: number; skipped: number; failed: number }> {
  let ok = 0
  let skipped = 0
  let failed = 0
  const CONC = 3
  for (let i = 0; i < tails.length; i += CONC) {
    if (i > 0) await new Promise((r) => setTimeout(r, 250)) // politeness
    const batch = tails.slice(i, i + CONC)
    const results = await Promise.all(
      batch.map((tail) => {
        try {
          return { tail, p: parseStatutePage(curl(sectionUrl(tail)), tail), err: null as any }
        } catch (e: any) {
          return { tail, p: null, err: e?.message || String(e) }
        }
      })
    )
    for (const r of results) {
      if (r.err) {
        failed++
        console.warn(`  ! [${group.label}] 77-${r.tail}: ${r.err}`)
        continue
      }
      if (!r.p) {
        skipped++
        continue
      }
      await query(
        `INSERT INTO state_law_section_texts
           (state_code, act_key, section_number, section_title, full_text, source_url, source_date, effective_year, law_category)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (state_code, act_key, section_number, effective_year) DO NOTHING`,
        [
          STATE,
          ACT_KEY,
          `77-${r.p.number}`,
          r.p.title,
          r.p.text,
          sectionUrl(r.p.number),
          SOURCE_DATE,
          EFFECTIVE_YEAR,
          LAW_CATEGORY,
        ]
      )
      ok++
    }
    process.stdout.write(`\r  [${group.label}] ${Math.min(i + CONC, tails.length)}/${tails.length}`)
  }
  console.log(`\n  [${group.label}] inserted ${ok}, skipped ${skipped} (repealed/empty), failed ${failed} of ${tails.length}`)
  return { ok, skipped, failed }
}

async function main() {
  console.log(`\n=== NE — ingesting property-tax full-text corpus (as of ${SOURCE_DATE}) ===`)

  // 1) Enumerate every 77-* section id from the official chapter index.
  const allTails = harvestChapterIds(curl(CHAPTER_INDEX))
  console.log(`chapter index: harvested ${allTails.length} distinct 77-* section ids`)
  if (allTails.length < 1000) {
    throw new Error(`chapter index harvest looks short (${allTails.length}); aborting before crawl`)
  }

  // 2) Filter to the five feature groups (no id lands in two groups — verified).
  const assigned = new Set<string>()
  const groupTails: { group: Group; tails: string[] }[] = GROUPS.map((group) => {
    const tails = allTails.filter((t) => group.inRange(t)).sort(sortTails)
    for (const t of tails) assigned.add(t)
    console.log(`  ${group.label}: ${tails.length} candidate sections`)
    return { group, tails }
  })
  const totalCandidates = groupTails.reduce((a, g) => a + g.tails.length, 0)
  console.log(`total candidate sections: ${totalCandidates} (distinct assigned: ${assigned.size})`)

  // 3) Crawl + parse + insert per group.
  const counts: Record<string, number> = {}
  let grandOk = 0
  for (const { group, tails } of groupTails) {
    const { ok } = await ingestGroup(group, tails)
    counts[group.label] = ok
    grandOk += ok
  }

  console.log(`\nNE done. inserted=${grandOk}`, counts)
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
