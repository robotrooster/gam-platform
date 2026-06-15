/**
 * Minnesota property-tax statute full-text ingester (sanctioned retrieve+cite+
 * date carve-out — verbatim statutory TEXT only, never advice).
 *
 * SOURCE (official only): the Minnesota Office of the Revisor of Statutes,
 * https://www.revisor.mn.gov. The "PROPERTY TAXES" part covers chapters 272-289;
 * the real-property assessment & taxation core lives in 272-282. No Justia /
 * Lexis / Wayback — official source exclusively.
 *
 * The site is server-side-rendered static HTML over plain HTTPS (no JS needed).
 * Two fetch tiers per page:
 *   - chapter TOC:  GET /statutes/cite/{NNN}      → enumerate section cites
 *   - section body: GET /statutes/cite/{NNN.NN}   → parse the statute text
 *
 * SECTION PAGE LAYOUT (verified S472 recon):
 *   <div class="section" id="stat.NNN.NN">
 *     <h1 class="shn">NNN.NN CATCHLINE TITLE.</h1>      ← number + ALL-CAPS title
 *     <div class="subd" id="...">
 *       <h2 class="subd_no">Subd. N.<span class="headnote">Name.</span></h2>
 *       <p>(a) body paragraph ...</p>  <p>(1) ...</p>   ← verbatim body
 *     </div> ...
 *   </div>
 *   <div class="history"> ... </div>                    ← session-law trailer
 * A single <div class="section"> per page; the sibling <div class="history">
 * immediately follows and is captured separately (stored appended as a labeled
 * source-note trailer, which the carve-out allows — it records authority/date).
 *
 * Repealed / reserved sections render a <p>...[Repealed, ...]</p> with no real
 * body; those (and any body < 20 chars) are dropped.
 *
 * EDITION STAMP: each page shows "2025 Minnesota Statutes" and a banner that the
 * chapter "has been affected by law enacted during the 2026 Regular Session".
 * Both the edition and that 2026-affected warning are prepended to full_text as a
 * one-line provenance header so retrieval-date AND statutory edition are recorded.
 *
 * ACT MAPPING: a single act_key='property_tax' / law_category='property_tax'.
 * Chapters ingested (union of the five feature-chapter groups from triage):
 *   exemptions               → 272
 *   assessment               → 273
 *   assessment_review        → 274
 *   levy_collection_payment  → 275, 276, 277, 279
 *   delinquency_tax_sale     → 279, 280, 281, 282
 * 279 is shared between the last two groups; it is fetched once (section_number
 * is globally unique across chapters, so no duplication).
 *
 * Run: cd apps/api && node -r ts-node/register src/db/ingestMNPropertyTax.ts
 * Idempotent (ON CONFLICT DO NOTHING).
 */

import { execFileSync } from 'child_process'
import { query } from './index'
import { stripTags } from './ingestStateLawCorpus'

const STATE = 'MN'
const ACT_KEY = 'property_tax'
const LAW_CATEGORY = 'property_tax'
const SOURCE_DATE = '2026-06-14'
const EFFECTIVE_YEAR = 2026
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) GAM-statute-ingest/1.0 (compliance research)'
const BASE = 'https://www.revisor.mn.gov'
const EDITION = '2025 Minnesota Statutes'

const citeUrl = (cite: string) => `${BASE}/statutes/cite/${cite}`

// Union of the five feature-chapter groups (272-282 real-property core).
const CHAPTERS = [272, 273, 274, 275, 276, 277, 279, 280, 281, 282]

interface Parsed {
  number: string
  title: string | null
  text: string
  affected2026: boolean
}

function curl(url: string): string {
  const buf = execFileSync('curl', ['-sL', '--max-time', '60', '-A', UA, url], {
    maxBuffer: 256 * 1024 * 1024,
  })
  return buf.toString('utf-8')
}

/**
 * Enumerate section cites for a chapter from its TOC. Links render as
 * href="/statutes/cite/{CH}.{NN}". Restrict to the chapter prefix (drops stray
 * cross-reference links to other chapters), de-dupe, numeric-sort.
 */
function harvestChapter(html: string, chapter: number): string[] {
  const re = new RegExp(`href="/statutes/cite/(${chapter}\\.[0-9]+)"`, 'g')
  const seen = new Set<string>()
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) seen.add(m[1])
  return [...seen].sort((a, b) => {
    const da = parseInt(a.split('.')[1], 10)
    const db = parseInt(b.split('.')[1], 10)
    // pad to compare lexical sub-numbering (272.02 vs 272.025) consistently
    return a.split('.')[1].length - b.split('.')[1].length || da - db
  })
}

/**
 * Parse a section page. Slices the single <div class="section"> body (up to the
 * sibling <div class="history">), pulls number+title from <h1 class="shn">, and
 * keeps every subd heading + body paragraph as verbatim text. The history trailer
 * is appended as a labeled source note. Returns null for repealed/reserved/empty.
 */
function parseSectionPage(html: string, expectedCite: string): Parsed | null {
  const secStart = html.indexOf('<div class="section"')
  if (secStart === -1) return null
  let secEnd = html.indexOf('<div class="history"', secStart)
  if (secEnd === -1) {
    // no history sibling — bound at the xtend container close as a fallback
    const xt = html.indexOf('id="xtend"', secStart)
    secEnd = xt === -1 ? html.length : xt
  }
  // Drop the per-subdivision permalink anchors (<a class="permalink">§</a>) so the
  // bare "§" glyph doesn't leak into body text.
  const secHtml = html.slice(secStart, secEnd).replace(/<a[^>]*class="permalink"[^>]*>[\s\S]*?<\/a>/gi, ' ')

  // Catchline: <h1 class="shn">NNN.NN TITLE.</h1>
  const h1 = secHtml.match(/<h1 class="shn">([\s\S]*?)<\/h1>/)
  if (!h1) return null
  const catchline = stripTags(h1[1], false).trim() // e.g. "272.02 EXEMPT PROPERTY."
  // number = leading cite; title = remainder
  const cm = catchline.match(/^([0-9]+\.[0-9]+)\s+([\s\S]*)$/)
  const number = cm ? cm[1] : expectedCite
  let title: string | null = cm ? cm[2].replace(/\.\s*$/, '').trim() : null
  if (!title) title = null
  if (title && /^repealed\b/i.test(title)) return null
  if (title && /^\[?reserved\.?\]?$/i.test(title)) return null
  if (title && /^renumbered\b/i.test(title)) return null

  // Body = everything in the section div after the </h1>, tag-stripped with
  // paragraph breaks preserved. This keeps subd headings + (a)/(b)/(1) markers.
  const afterH1 = secHtml.slice(secHtml.indexOf('</h1>') + 5)
  let body = stripTags(afterH1, true).trim()

  // Drop pure repealed/reserved bodies.
  if (!body || body.length < 20) return null
  const compact = body.replace(/\s+/g, ' ').trim()
  if (/^MS\s+\d+\s*\[Repealed/i.test(compact) && compact.length < 120) return null
  if (/^\[Repealed,/i.test(compact)) return null
  if (/^\[?reserved\.?\]?$/i.test(compact)) return null

  // Detect the 2026-affected banner anywhere on the page (chapter-level notice).
  const affected2026 = /affected by law enacted during the 2026/i.test(html)

  // History trailer (authority/date) — labeled source note, verbatim. The
  // <div class="history"> block sits right after the section div; bound it at the
  // next top-level container (id="xtend") or the next <div class="..."> sibling.
  // The history div contains only an <h2> + a single <p> (no nested divs), so the
  // first </div> after its open closes it — bound there to keep the page footer out.
  const histStart = html.indexOf('<div class="history"', secStart)
  if (histStart !== -1) {
    const histEnd = html.indexOf('</div>', histStart)
    const histText = stripTags(html.slice(histStart, histEnd === -1 ? histStart : histEnd), true)
      .replace(/\s+/g, ' ')
      .trim()
    if (/^History:/i.test(histText)) {
      body = `${body}\n\n${histText}`
    }
  }

  // Provenance header: edition + retrieval edition warning.
  const provenance = `[Source: ${EDITION}${
    affected2026 ? '; chapter affected by law enacted during the 2026 Regular Session' : ''
  }]`
  const text = `${provenance}\n${body}`

  return { number, title, text, affected2026 }
}

async function insertOne(p: Parsed): Promise<boolean> {
  if (!p.text || p.text.length < 20) return false
  await query(
    `INSERT INTO state_law_section_texts
       (state_code, act_key, section_number, section_title, full_text, source_url, source_date, effective_year, law_category)
     VALUES ('MN','property_tax',$1,$2,$3,$4,'2026-06-14',2026,'property_tax')
     ON CONFLICT (state_code, act_key, section_number, effective_year) DO NOTHING`,
    [p.number, p.title, p.text, citeUrl(p.number)]
  )
  return true
}

async function main() {
  console.log(`\n=== MN — ingesting property-tax full-text corpus (as of ${SOURCE_DATE}) ===`)
  const perChapter: Record<number, { harvested: number; ok: number; skipped: number; failed: number }> = {}
  let grandOk = 0

  for (const ch of CHAPTERS) {
    let cites: string[] = []
    try {
      cites = harvestChapter(curl(citeUrl(String(ch))), ch)
    } catch (e: any) {
      console.warn(`  ! chapter ${ch} TOC failed: ${e?.message || e}`)
      perChapter[ch] = { harvested: 0, ok: 0, skipped: 0, failed: 1 }
      continue
    }
    let ok = 0
    let skipped = 0
    let failed = 0
    const CONC = 4
    for (let i = 0; i < cites.length; i += CONC) {
      if (i > 0) await new Promise((r) => setTimeout(r, 250)) // politeness
      const batch = cites.slice(i, i + CONC)
      const parsed = await Promise.all(
        batch.map(async (cite) => {
          try {
            return parseSectionPage(curl(citeUrl(cite)), cite)
          } catch (e: any) {
            console.warn(`\n  ! ch${ch} ${cite}: ${e?.message || e}`)
            failed++
            return null
          }
        })
      )
      for (const p of parsed) {
        if (!p) {
          skipped++
          continue
        }
        const inserted = await insertOne(p)
        if (inserted) ok++
        else skipped++
      }
      process.stdout.write(`\r  [ch ${ch}] ${Math.min(i + CONC, cites.length)}/${cites.length}`)
    }
    perChapter[ch] = { harvested: cites.length, ok, skipped, failed }
    grandOk += ok
    console.log(`\n  [ch ${ch}] inserted ${ok}, skipped ${skipped}, failed ${failed} of ${cites.length}`)
  }

  console.log(`\nMN property_tax done. inserted=${grandOk}`)
  console.table(perChapter)
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
