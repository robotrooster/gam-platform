/**
 * Minnesota non-tax real-estate statute full-text ingester.
 *
 * Sanctioned retrieve+cite+date carve-out (verbatim statute text, never advice).
 * Source: Office of the Revisor of Statutes — https://www.revisor.mn.gov
 * Official 2025 Minnesota Statutes, server-rendered static HTML (no JS).
 *
 * One reusable ingester covering five law_category blocks. For each category,
 * act_key === law_category (the category key). Each block enumerates one or more
 * statute chapters; their per-section pages are fetched and parsed verbatim.
 *
 * CATEGORY → CHAPTERS:
 *   conveyancing_title          → 507 (recording/filing conveyances)
 *   condo_coop                  → 515B (Minnesota Common Interest Ownership Act)
 *   broker_licensing            → 82  (real estate brokers/salespersons)
 *   mortgage_lien_foreclosure   → 580, 581, 582 (foreclosure) + 514 (liens)
 *   general_real_property       → 500 (estates in real property) + 559 (adverse claims)
 *
 * CITE FORMS:
 *   Dotted form    {chapter}.{section}        e.g. 507.06, 82.55, 580.02
 *   Uniform-act    {chapter}.{article}-{sec}  e.g. 515B.1-102, 515B.3-113
 *   Both are enumerated from the chapter TOC at /statutes/cite/{chapter} by
 *   collecting anchor hrefs of the form /statutes/cite/{chapter}.{...}.
 *
 * SECTION-PAGE DOM (verified live):
 *   <div class="section" id="stat.{cite}">
 *     <h1 class="shn">{number} {TITLE}.</h1>     ← split on first space
 *     <h2 class="subd">Subdivision 1. Name.</h2>  ← multi-subdivision sections only
 *     <p ...>body paragraph</p> ...
 *   </div>
 *   <div class="history" id="stat.{cite}.history">History: (...)</div>  ← sibling
 *
 *   Body = all <p> and <h2 class="subd"> inside div.section, in document order
 *   (this captures "Subdivision 1." / "Subd. 1a." subdivision headers inline with
 *   their paragraphs for sections like 82.55). The history note is appended as a
 *   verbatim source-note trailer (same posture as the LA ingester).
 *
 * DROPS: repealed/reserved sections render as a stub page with NO div.section /
 *   h1.shn (e.g. 500.13) → parseSection returns null. Also drop empty / <20-char
 *   bodies and any title beginning "Repealed"/"Reserved".
 *
 * Run: cd apps/api && node -r ts-node/register src/db/ingestMNRealEstate.ts
 * Idempotent (ON CONFLICT DO NOTHING).
 */

import { execFileSync } from 'child_process'
import { query } from './index'
import { stripTags } from './ingestStateLawCorpus'

const STATE = 'MN'
const SOURCE_DATE = '2026-06-14'
const EFFECTIVE_YEAR = 2026
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) GAM-statute-ingest/1.0'
const BASE = 'https://www.revisor.mn.gov/statutes/cite'
const citeUrl = (cite: string) => `${BASE}/${cite}`

interface Parsed { number: string; title: string | null; text: string }

// category key → ordered list of chapters to enumerate.
const CATEGORIES: Record<string, string[]> = {
  conveyancing_title: ['507'],
  condo_coop: ['515B'],
  broker_licensing: ['82'],
  mortgage_lien_foreclosure: ['580', '581', '582', '514'],
  general_real_property: ['500', '559'],
}

function curl(url: string): string {
  const buf = execFileSync('curl', ['-sL', '--max-time', '60', '-A', UA, url], {
    maxBuffer: 256 * 1024 * 1024,
  })
  return buf.toString('utf-8')
}

/**
 * Harvest the ordered, de-duped list of section cites for one chapter from its
 * TOC page. Matches anchor hrefs /statutes/cite/{chapter}.{rest} where {rest}
 * is the dotted section number OR uniform-act {article}-{section}. Excludes the
 * bare chapter link and any cross-chapter anchors.
 */
function harvestChapter(html: string, chapter: string): string[] {
  // Escape the chapter for regex (515B has a letter; numeric chapters are safe).
  const ch = chapter.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`href="/statutes/cite/(${ch}\\.[0-9A-Za-z-]+)"`, 'gi')
  const seen = new Set<string>()
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) {
    const cite = m[1]
    // Guard: keep only cites for THIS chapter (e.g. "507.06", "515B.1-102"),
    // not an accidental "5070" style false-positive — the literal "." after the
    // chapter in the regex already enforces this.
    seen.add(cite)
  }
  const out = [...seen]
  out.sort(sortCite)
  return out
}

/** Sort cites numerically by section, handling dotted + uniform-act forms. */
function sortCite(a: string, b: string): number {
  const key = (c: string): number[] => {
    const rest = c.includes('.') ? c.slice(c.indexOf('.') + 1) : c
    // "1-102" → [1, 102]; "0941" → [941]; "06" → [6]
    if (rest.includes('-')) return rest.split('-').map((x) => parseInt(x, 10) || 0)
    return [parseFloat(rest) || 0]
  }
  const ka = key(a)
  const kb = key(b)
  for (let i = 0; i < Math.max(ka.length, kb.length); i++) {
    const d = (ka[i] ?? 0) - (kb[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

/**
 * Parse a section page. Locates div.section#stat.{cite}; h1.shn = "{number}
 * {TITLE}." split on first whitespace. Body = all <p> + <h2 class="subd"> inside
 * div.section in document order, plus the sibling history note as a trailer.
 * Returns null for repealed/reserved/empty/stub pages.
 */
function parseSection(html: string, cite: string): Parsed | null {
  // Isolate the section div. id attribute may contain trailing whitespace chars
  // inside the value (seen on history ids), so match the opening tag loosely.
  const secStart = html.search(
    new RegExp(`<div\\s+class="section"\\s+id="stat\\.${cite.replace(/[.]/g, '\\.')}["\\s]`, 'i')
  )
  if (secStart === -1) return null

  // The section div ends where the sibling history div begins, or (no history)
  // at the closing </div> for the section. Use the history div start as the
  // primary boundary; fall back to a bounded slice.
  const histStart = html.indexOf('<div class="history"', secStart)
  const secEnd = histStart > secStart ? histStart : secStart + 200000
  const seg = html.slice(secStart, secEnd)

  // h1.shn → number + title
  const h1m = seg.match(/<h1[^>]*class="shn"[^>]*>([\s\S]*?)<\/h1>/i)
  if (!h1m) return null
  const shn = stripTags(h1m[1], false).trim()
  if (!shn) return null
  const sp = shn.search(/\s/)
  const number = sp === -1 ? shn : shn.slice(0, sp)
  let title: string | null = sp === -1 ? null : shn.slice(sp + 1).replace(/\.$/, '').trim()
  if (title === '') title = null
  if (title && /^repealed\b/i.test(title)) return null
  if (title && /^\[?reserved\.?\]?$/i.test(title)) return null

  // Body = <p> and <h2 class="subd"> in document order, AFTER the h1.
  const afterH1 = seg.slice((h1m.index ?? 0) + h1m[0].length)
  const parts: string[] = []
  const blockRe = /<(p|h2)\b[^>]*>([\s\S]*?)<\/\1>/gi
  let bm: RegExpExecArray | null
  while ((bm = blockRe.exec(afterH1)) !== null) {
    const t = stripTags(bm[2], true).trim()
    if (t) parts.push(t)
  }
  let body = parts.join('\n').trim()

  // Append the verbatim history source-note as a trailer (same as LA ingester).
  if (histStart > secStart) {
    const histEnd = html.indexOf('</div>', histStart)
    if (histEnd > histStart) {
      const hist = stripTags(html.slice(histStart, histEnd + 6), false).trim()
      if (hist && hist.length > 9) body = body ? `${body}\n${hist}` : hist
    }
  }

  body = body.trim()
  if (!body || body.length < 20) return null
  if (/^\[?reserved\.?\]?$/i.test(body)) return null
  if (/^repealed\b/i.test(body)) return null
  return { number, title, text: body }
}

async function ingestCategory(catKey: string, chapters: string[]): Promise<number> {
  let ok = 0
  let skipped = 0
  // Enumerate every section across the category's chapters.
  const cites: string[] = []
  for (const ch of chapters) {
    const toc = curl(citeUrl(ch))
    const found = harvestChapter(toc, ch)
    console.log(`  [${catKey}] chapter ${ch}: ${found.length} section anchors`)
    cites.push(...found)
  }

  const CONC = 3
  for (let i = 0; i < cites.length; i += CONC) {
    if (i > 0) await new Promise((r) => setTimeout(r, 250)) // politeness
    const batch = cites.slice(i, i + CONC)
    const parsed = await Promise.all(
      batch.map(async (cite) => {
        try {
          return { p: parseSection(curl(citeUrl(cite)), cite), cite }
        } catch (e: any) {
          console.warn(`  ! ${catKey} ${cite}: ${e?.message || e}`)
          return { p: null, cite }
        }
      })
    )
    for (const { p, cite } of parsed) {
      if (!p || !p.text || p.text.length < 20) {
        skipped++
        continue
      }
      await query(
        `INSERT INTO state_law_section_texts
           (state_code, act_key, section_number, section_title, full_text, source_url, source_date, effective_year, law_category)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (state_code, act_key, section_number, effective_year) DO NOTHING`,
        [STATE, catKey, p.number, p.title, p.text, citeUrl(cite), SOURCE_DATE, EFFECTIVE_YEAR, catKey]
      )
      ok++
    }
    process.stdout.write(`\r  [${catKey}] ${Math.min(i + CONC, cites.length)}/${cites.length}`)
  }
  console.log(`\n  [${catKey}] inserted ${ok}, skipped ${skipped} of ${cites.length}`)
  return ok
}

async function main() {
  console.log(`\n=== MN — ingesting non-tax real-estate corpus (as of ${SOURCE_DATE}) ===`)
  const counts: Record<string, number> = {}
  for (const [catKey, chapters] of Object.entries(CATEGORIES)) {
    counts[catKey] = await ingestCategory(catKey, chapters)
  }
  const total = Object.values(counts).reduce((a, b) => a + b, 0)
  console.log(`\nMN done. inserted=${total}`, counts)
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
