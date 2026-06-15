/**
 * Massachusetts statute full-text ingester (S453 corpus batch).
 *
 * MA is the one batch-1 state that is per-section, not whole-chapter: each
 * malegislature.gov chapter page is a table-of-contents of links to individual
 * /Chapter186/SectionNN pages; the section bodies live only on those pages.
 * Each section page has <h2 id="skipTo" ...>Section NUM: <small>TITLE</small></h2>
 * followed by the body <p> blocks, ending at </main>.
 *
 * Run: cd apps/api && node -r ts-node/register src/db/ingestMaStateLaw.ts
 * Idempotent (ON CONFLICT DO NOTHING). Reuses stripTags from the corpus framework.
 */

import { query } from './index'
import { stripTags } from './ingestStateLawCorpus'

const SOURCE_DATE = '2026-06-13'
const EFFECTIVE_YEAR = 2026
const BASE = 'https://malegislature.gov'
const CHAPTERS = [
  { actKey: 'residential', toc: `${BASE}/Laws/GeneralLaws/PartII/TitleI/Chapter186` },
  { actKey: 'eviction', toc: `${BASE}/Laws/GeneralLaws/PartIII/TitleIII/Chapter239` },
  { actKey: 'self_storage', toc: `${BASE}/Laws/GeneralLaws/PartI/TitleXV/Chapter105A` },
  { actKey: 'general_landlord_tenant', toc: `${BASE}/Laws/GeneralLaws/PartI/TitleXV/Chapter93A` },
]

async function fetchHtml(url: string): Promise<string> {
  const res = await fetch(url, { headers: { 'User-Agent': 'GAM-statute-ingest/1.0 (compliance research)' } })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.text()
}

interface Parsed { number: string; title: string | null; text: string }

function parseSectionPage(html: string): Parsed | null {
  const h2 = html.match(/<h2[^>]*id="skipTo"[^>]*>\s*Section\s+([0-9A-Za-z]+)\s*:\s*<small>([\s\S]*?)<\/small>/i)
  if (!h2) return null
  const number = h2[1].trim()
  const title = stripTags(h2[2], false) || null
  const after = html.slice(h2.index! + h2[0].length)
  const end = after.indexOf('</main>')
  const region = end >= 0 ? after.slice(0, end) : after
  const text = stripTags(region, true)
  if (/^repealed/i.test(title || '') || /^\s*Repealed/i.test(text)) return null
  return { number, title, text }
}

async function main() {
  let ok = 0
  let skipped = 0
  const counts: Record<string, number> = {}
  for (const { actKey, toc } of CHAPTERS) {
    const tocHtml = await fetchHtml(toc)
    // section links on the chapter TOC page
    const hrefs = [...new Set(
      [...tocHtml.matchAll(/href="(\/Laws\/GeneralLaws\/[^"]+\/Section[0-9A-Za-z]+)"/gi)].map((m) => m[1])
    )]
    console.log(`${actKey}: ${hrefs.length} section links`)
    const CONC = 4
    for (let i = 0; i < hrefs.length; i += CONC) {
      const batch = hrefs.slice(i, i + CONC)
      const parsed = await Promise.all(
        batch.map(async (h) => {
          try {
            return parseSectionPage(await fetchHtml(BASE + h))
          } catch (e: any) {
            console.warn(`  ! ${h}: ${e?.message || e}`)
            return null
          }
        })
      )
      for (let j = 0; j < parsed.length; j++) {
        const p = parsed[j]
        if (!p || !p.number || !p.text || p.text.length < 20) { skipped++; continue }
        await query(
          `INSERT INTO state_law_section_texts
             (state_code, act_key, section_number, section_title, full_text, source_url, source_date, effective_year)
           VALUES ('MA', $1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (state_code, act_key, section_number, effective_year) DO NOTHING`,
          [actKey, p.number, p.title, p.text, BASE + batch[j], SOURCE_DATE, EFFECTIVE_YEAR]
        )
        ok++
        counts[actKey] = (counts[actKey] || 0) + 1
      }
      process.stdout.write(`\r  ${actKey} ${Math.min(i + CONC, hrefs.length)}/${hrefs.length}`)
    }
    console.log()
  }
  console.log(`MA done. inserted=${ok} skipped=${skipped}`, counts)
  process.exit(0)
}

main().catch((e) => { console.error(e); process.exit(1) })
