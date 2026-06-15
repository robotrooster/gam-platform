/**
 * Nebraska statute full-text ingester (S453 corpus, tranche-3 follow-up).
 *
 * NE's whole-chapter page is all of Chapter 76 (Real Property, ~2000 non-LL/T
 * sections), so we enumerate ONLY the landlord/tenant range (76-14xx) from the
 * chapter browse page and fetch each per-section page. 76-1401..76-1449 =
 * Uniform Residential Landlord and Tenant Act (residential); 76-1450+ = Mobile
 * Home Landlord and Tenant Act (mobile_home_park).
 *
 * Section page: <h1>Nebraska Revised Statute 76-1410</h1>, <h3>catchline</h3>,
 * body in <p class="text-justify"> blocks, trailed by Source:/Cross
 * Reference/Annotations (excluded).
 *
 * Run: cd apps/api && node -r ts-node/register src/db/ingestNeStateLaw.ts
 * Idempotent (ON CONFLICT DO NOTHING). Reuses stripTags from the corpus framework.
 */

import { query } from './index'
import { stripTags } from './ingestStateLawCorpus'

const SOURCE_DATE = '2026-06-13'
const EFFECTIVE_YEAR = 2026
const BROWSE = 'https://nebraskalegislature.gov/laws/browse-chapters.php?chapter=76'
const SECTION_URL = (n: string) => `https://nebraskalegislature.gov/laws/statutes.php?statute=${n}`

async function fetchHtml(url: string): Promise<string> {
  const res = await fetch(url, { headers: { 'User-Agent': 'GAM-statute-ingest/1.0 (compliance research)' } })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.text()
}

interface Parsed { number: string; title: string | null; text: string }

function parseSectionPage(html: string, number: string): Parsed | null {
  // Catchline: first <h3> after the "Nebraska Revised Statute" h1.
  const anchor = html.indexOf('Nebraska Revised Statute')
  const region = anchor >= 0 ? html.slice(anchor) : html
  const h3 = region.match(/<h3[^>]*>([\s\S]*?)<\/h3>/i)
  let title = h3 ? stripTags(h3[1], false).replace(new RegExp('^' + number.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\.?\\s*'), '').trim() : null
  if (title === '') title = null

  // Body = text-justify paragraphs before the Source/Cross Reference/Annotation trailer.
  let body = h3 ? region.slice((h3.index ?? 0) + h3[0].length) : region
  const cut = body.search(/Source:|Cross Reference|Annotation/i)
  if (cut >= 0) body = body.slice(0, cut)
  const paras = [...body.matchAll(/<p[^>]*class="text-justify"[^>]*>([\s\S]*?)<\/p>/gi)].map((m) => stripTags(m[1], true)).filter(Boolean)
  const text = paras.join('\n').trim()
  return { number, title, text }
}

function actKeyFor(num: string): string {
  // 76-1401..76-1449 = URLTA (residential); 76-1450+ = Mobile Home L/T Act.
  const m = num.match(/^76-(\d+)/)
  const n = m ? parseInt(m[1], 10) : 0
  return n >= 1450 ? 'mobile_home_park' : 'residential'
}

async function main() {
  const browse = await fetchHtml(BROWSE)
  const nums = [...new Set([...browse.matchAll(/statute=76-14[0-9]{2}\b/gi)].map((m) => m[0].replace('statute=', '')))]
  console.log(`NE: ${nums.length} landlord/tenant sections (76-14xx)`)
  let ok = 0
  let skipped = 0
  const counts: Record<string, number> = {}
  const CONC = 2
  for (let i = 0; i < nums.length; i += CONC) {
    if (i > 0) await new Promise((r) => setTimeout(r, 500)) // politeness: NE 429s on bursts
    const batch = nums.slice(i, i + CONC)
    const parsed = await Promise.all(
      batch.map(async (n) => {
        try {
          return parseSectionPage(await fetchHtml(SECTION_URL(n)), n)
        } catch (e: any) {
          console.warn(`  ! ${n}: ${e?.message || e}`)
          return null
        }
      })
    )
    for (const p of parsed) {
      if (!p || !p.text || p.text.length < 20) { skipped++; continue }
      const actKey = actKeyFor(p.number)
      await query(
        `INSERT INTO state_law_section_texts
           (state_code, act_key, section_number, section_title, full_text, source_url, source_date, effective_year)
         VALUES ('NE', $1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (state_code, act_key, section_number, effective_year) DO NOTHING`,
        [actKey, p.number, p.title, p.text, SECTION_URL(p.number), SOURCE_DATE, EFFECTIVE_YEAR]
      )
      ok++
      counts[actKey] = (counts[actKey] || 0) + 1
    }
    process.stdout.write(`\r  ${Math.min(i + CONC, nums.length)}/${nums.length}`)
  }
  console.log(`\nNE done. inserted=${ok} skipped=${skipped}`, counts)
  process.exit(0)
}

main().catch((e) => { console.error(e); process.exit(1) })
