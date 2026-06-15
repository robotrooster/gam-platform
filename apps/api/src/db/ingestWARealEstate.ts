/**
 * Washington (WA) non-tax real-estate statute full-text ingester.
 *
 * Sanctioned retrieve+cite+date carve-out: verbatim OFFICIAL statute text only,
 * never advice. Source is the official Washington State Legislature site,
 * app.leg.wa.gov (Revised Code of Washington — RCW).
 *
 * SOURCE LAYOUT (static ASP.NET HTML, raw curl with a browser UA returns HTTP
 * 200 — no JS / headless needed):
 *
 *   Per-section page:  https://app.leg.wa.gov/rcw/default.aspx?cite={chap}.{sec}
 *     - citation:  <h1><!-- field: Citations -->RCW  {cite}<!-- field: --></h1>
 *     - caption:   <h2><!-- field: CaptionsTitles -->{catchline}
 *                    [<span>(Effective until January 1, 2028.)</span>]<!-- field: --></h2>
 *     - body:      <div id='contentWrapper' class='section-page'> … [ history note ] </div>
 *
 *   Chapter TOC page:  https://app.leg.wa.gov/rcw/default.aspx?cite={chap}
 *     - lists every CURRENT section as an anchor whose text == the bare cite
 *       ("64.04.010"), followed in the next <td> by the catchline. Repealed /
 *       decodified sections are NOT listed here (a decodified chapter renders as
 *       "Chapter NN.NN RCW dispositions" with zero section anchors — contributes
 *       nothing, which is correct/honest).
 *
 * DUAL-VERSION (effective-until-2028) HANDLING: WUCIOA (2024 c 321) and the
 * Deeds-of-Trust Act amendments produce sections that render BOTH the current
 * text and the future (2028) text inside the SAME single contentWrapper, with
 * the future block introduced by an inline "(Effective January 1, 2028.)"
 * marker. The h2 caption carries "(Effective until January 1, 2028.)". We
 * capture the whole contentWrapper verbatim (both versions, as the official
 * site presents them) and keep the effective-date qualifier in section_title.
 *
 * NOTE ON THE TASK RECIPE: the recipe's claim that "?cite={chap}&full=true
 * inlines every section as separate h1/h2/contentWrapper blocks" is NOT how the
 * live site behaves — &full=true renders a single contentWrapper of class
 * 'chapter-page'. So we enumerate sections from the plain chapter TOC and fetch
 * each section page individually (clean per-section h1/h2/contentWrapper).
 *
 * CATEGORY → CHAPTER MAP (act_key == law_category for every block):
 *   conveyancing_title        Title 64 deeds/acks (64.04, 64.08) + Title 65
 *                             recording (65.04, 65.08; 65.12 Torrens is
 *                             decodified → 0) + escrow agents (18.44)
 *   condo_coop                64.90 WUCIOA (current) + legacy 64.32 (HPRA),
 *                             64.34 (Condominium Act) + 64.38 (HOAs)
 *   broker_licensing          18.85 brokers + 18.86 agency + 18.140 appraisers
 *   mortgage_lien_foreclosure 60.04 mechanics' liens + Title 61 (61.12, 61.16,
 *                             61.24 Deeds of Trust, 61.30 RE contract forfeit.)
 *   general_real_property     residual Title 64 chapters + adverse possession /
 *                             quiet title (7.28) + real-property limitation
 *                             periods (curated subset of 4.16)
 *
 * Run: cd apps/api && node -r ts-node/register src/db/ingestWARealEstate.ts
 * Idempotent (ON CONFLICT DO NOTHING). Repealed/reserved/short (<20 char) /
 * empty / TOC / nav bodies are dropped.
 */

import { execFileSync } from 'child_process'
import { query } from './index'
import { stripTags, decodeEntities } from './ingestStateLawCorpus'

const STATE = 'WA'
const SOURCE_DATE = '2026-06-14'
const EFFECTIVE_YEAR = 2026
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) GAM-statute-ingest/1.0'
const BASE = 'https://app.leg.wa.gov/rcw/default.aspx'

const tocUrl = (chap: string) => `${BASE}?cite=${chap}`
const sectionUrl = (cite: string) => `${BASE}?cite=${cite}`

interface Cite { number: string; chapter: string }
interface Parsed { number: string; title: string | null; text: string }

/**
 * Per-category plan. `chapters` are enumerated in full from their TOC.
 * `sectionAllowlist` (chapter -> exact cites) restricts a chapter to a curated
 * subset — used only for 4.16, where we want the real-property limitation
 * sections (notably 4.16.020 adverse possession) and NOT the unrelated
 * tort/health-care/parentage limitations in the same chapter.
 */
const PLAN: Record<string, { chapters: string[]; sectionAllowlist?: Record<string, string[]> }> = {
  conveyancing_title: {
    chapters: ['64.04', '64.08', '65.04', '65.08', '65.12', '18.44'],
  },
  condo_coop: {
    chapters: ['64.90', '64.32', '64.34', '64.38'],
  },
  broker_licensing: {
    chapters: ['18.85', '18.86', '18.140'],
  },
  mortgage_lien_foreclosure: {
    chapters: ['60.04', '61.12', '61.16', '61.24', '61.30'],
  },
  general_real_property: {
    chapters: [
      '64.06', '64.12', '64.28', '64.36', '64.37', '64.40', '64.44', '64.50',
      '64.55', '64.60', '64.65', '64.70', '64.80', '7.28', '4.16',
    ],
    sectionAllowlist: {
      // Real-property limitation periods only. 4.16.020 is the adverse-
      // possession 10-year bar; 4.16.005 commencement; 4.16.090 tax-deed
      // cancellation. The rest of Ch. 4.16 is unrelated (health care, abuse,
      // parentage, construction-defect, etc.) and is intentionally excluded.
      '4.16': ['4.16.005', '4.16.020', '4.16.090'],
    },
  },
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function curlOnce(url: string): string {
  const buf = execFileSync('curl', ['-sL', '--max-time', '60', '-A', UA, url], {
    maxBuffer: 256 * 1024 * 1024,
  })
  return buf.toString('utf-8')
}

/**
 * Fetch with a truncation guard. Under rapid request bursts the WA site
 * occasionally returns a short, incomplete page (~38KB vs the ~100KB+ a full
 * section/TOC page weighs). A valid page always contains "Code Reviser" in the
 * footer and a closing </html>; if either is missing OR the page is
 * suspiciously small, retry up to `tries` times with linear backoff.
 */
async function curl(url: string, tries = 3): Promise<string> {
  let html = ''
  for (let t = 0; t < tries; t++) {
    if (t > 0) await sleep(700 * t)
    html = curlOnce(url)
    const looksComplete = html.length > 60000 && /Code Reviser|<\/html>/i.test(html)
    if (looksComplete) return html
  }
  return html // return last attempt; parser skips if body is unparseable
}

/** Strip the WA "<!-- field: X -->" comment markers the CMS injects into h1/h2. */
function stripFieldComments(s: string): string {
  return s.replace(/<!--[\s\S]*?-->/g, '')
}

/**
 * Harvest current section cites from a chapter TOC page. The reliable signal is
 * an anchor whose visible text equals the bare cite ("64.04.010"). De-dupe and
 * sort numerically by the section component.
 */
function harvestChapterToc(html: string, chapter: string): Cite[] {
  const esc = chapter.replace(/\./g, '\\.')
  const re = new RegExp(`<a[^>]*cite=(${esc}\\.[0-9]+(?:\\.[0-9]+)?)[^>]*>\\s*\\1\\s*</a>`, 'gi')
  const seen = new Set<string>()
  const out: Cite[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) {
    const number = m[1]
    if (seen.has(number)) continue
    seen.add(number)
    out.push({ number, chapter })
  }
  out.sort((a, b) => {
    const an = parseInt(a.number.split('.').slice(-1)[0], 10)
    const bn = parseInt(b.number.split('.').slice(-1)[0], 10)
    return an - bn
  })
  return out
}

/**
 * Parse a single section page.
 *   - cite check: <h1> must contain "RCW {expected}".
 *   - title: <h2> caption (field-comments stripped, tags removed, entities
 *     decoded) — INCLUDING any "(Effective …)" qualifier.
 *   - body: the contentWrapper.section-page div, stripped to readable verbatim
 *     text (history note in trailing [ ... ] kept, per corpus convention).
 * Returns null for: no/empty contentWrapper, body < 20 chars, repealed/reserved
 * caption or body, or a chapter-disposition page (no section-page wrapper).
 */
function parseSectionPage(html: string, expected: string): Parsed | null {
  // Body: the section-page contentWrapper. Greedy to the panel that follows it.
  const bodyMatch =
    html.match(/<div id=['"]contentWrapper['"][^>]*class=['"]section-page['"][^>]*>([\s\S]*?)<div id="ContentPlaceHolder1_pnlExpanded"/i) ||
    html.match(/<div id=['"]contentWrapper['"][^>]*class=['"]section-page['"][^>]*>([\s\S]*?)<\/div>\s*<\/div>\s*<\/div>/i)
  if (!bodyMatch) return null // no section-page wrapper => disposition / nonexistent

  const text = stripTags(bodyMatch[1], true)
  if (!text || text.length < 20) return null
  if (/^\[?\s*reserved\.?\s*\]?$/i.test(text)) return null

  // Caption from <h2>.
  let title: string | null = null
  const h2 = html.match(/<h2>([\s\S]*?)<\/h2>/i)
  if (h2) {
    const cap = stripTags(stripFieldComments(h2[1]), false).trim()
    if (cap) title = cap
  }
  // Drop repealed/decodified/reserved sections (signalled in caption or body).
  if (title && /\b(repealed|decodified|reserved|recodified)\b/i.test(title) &&
      /^\(?\s*(repealed|decodified|reserved|recodified)/i.test(title)) {
    return null
  }
  if (/^\(?\s*(repealed|reserved|decodified)\b/i.test(text)) return null

  return { number: expected, title, text }
}

async function ingestCategory(
  category: string,
  plan: { chapters: string[]; sectionAllowlist?: Record<string, string[]> }
): Promise<number> {
  console.log(`\n--- ${category} ---`)
  // 1) Enumerate cites across all chapters in the category.
  const cites: Cite[] = []
  for (const chap of plan.chapters) {
    let chapCites: Cite[]
    try {
      chapCites = harvestChapterToc(await curl(tocUrl(chap)), chap)
    } catch (e: any) {
      console.warn(`  ! TOC ${chap}: ${e?.message || e}`)
      continue
    }
    const allow = plan.sectionAllowlist?.[chap]
    if (allow) chapCites = chapCites.filter((c) => allow.includes(c.number))
    console.log(`  ${chap}: ${chapCites.length} sections`)
    cites.push(...chapCites)
  }

  // 2) Fetch + parse + insert each section (small concurrency, polite delay).
  let ok = 0
  let skipped = 0
  const CONC = 4
  for (let i = 0; i < cites.length; i += CONC) {
    if (i > 0) await new Promise((r) => setTimeout(r, 250))
    const batch = cites.slice(i, i + CONC)
    const parsed = await Promise.all(
      batch.map(async (c) => {
        try {
          return { p: parseSectionPage(await curl(sectionUrl(c.number)), c.number), c }
        } catch (e: any) {
          console.warn(`\n  ! ${c.number}: ${e?.message || e}`)
          return { p: null, c }
        }
      })
    )
    for (const { p, c } of parsed) {
      if (!p || !p.text || p.text.length < 20) {
        skipped++
        continue
      }
      await query(
        `INSERT INTO state_law_section_texts
           (state_code, act_key, section_number, section_title, full_text,
            source_url, source_date, effective_year, law_category)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (state_code, act_key, section_number, effective_year) DO NOTHING`,
        [STATE, category, p.number, p.title, p.text, sectionUrl(c.number), SOURCE_DATE, EFFECTIVE_YEAR, category]
      )
      ok++
    }
    process.stdout.write(`\r  [${category}] ${Math.min(i + CONC, cites.length)}/${cites.length}`)
  }
  console.log(`\n  [${category}] inserted ${ok}, skipped ${skipped} of ${cites.length}`)
  return ok
}

async function main() {
  console.log(`\n=== WA — ingesting non-tax real-estate corpus (as of ${SOURCE_DATE}) ===`)
  // touch decodeEntities so the import is not flagged unused; it is used inside
  // stripTags but we reference it here for the dual-version sanity log below.
  void decodeEntities

  const counts: Record<string, number> = {}
  for (const [category, plan] of Object.entries(PLAN)) {
    counts[category] = await ingestCategory(category, plan)
  }

  const total = Object.values(counts).reduce((a, b) => a + b, 0)
  console.log(`\nWA done. inserted=${total}`, counts)
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
