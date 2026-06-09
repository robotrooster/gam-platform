/**
 * One-off ingester for the S442 state-law full-text corpus — downloads every
 * section of Arizona's four landlord/tenant acts directly from azleg.gov and
 * stores the verbatim text in state_law_section_texts, so the agent's
 * search_state_law tool can answer obscure questions from the real statute.
 *
 * Reusable shape for other states later: enumerate sections from the official
 * index → fetch each → parse <TITLE> (number + title) and <p> body → insert.
 * Idempotent (ON CONFLICT DO NOTHING). Run:
 *   cd apps/api && node -r ts-node/register src/db/ingestAzStateLaw.ts
 */

import { query } from './index'

const TITLE_INDEX = 'https://www.azleg.gov/arsDetail/?title=33'
const SECTION_URL = (id: string) => `https://www.azleg.gov/ars/33/${id}.htm`
const SOURCE_DATE = '2026-06-09'
const EFFECTIVE_YEAR = 2026

// A.R.S. Title 33 chapter → our act_key, by section-number range.
function actKeyForSection(num: string): string | null {
  const base = parseInt(num.replace(/^33-/, '').split('.')[0], 10)
  if (base >= 301 && base <= 381) return 'general'
  if (base >= 1301 && base <= 1381) return 'residential'
  if (base >= 1401 && base <= 1501) return 'mobile_home_park'
  if (base >= 2101 && base <= 2151) return 'rv_long_term'
  return null
}

function decode(s: string): string {
  return s
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/[ \t]+/g, ' ')
    .trim()
}

interface Parsed { sectionNumber: string; sectionTitle: string | null; fullText: string }

function parseSection(html: string): Parsed | null {
  const titleM = html.match(/<TITLE>([\s\S]*?)<\/TITLE>/i)
  const titleRaw = titleM ? decode(titleM[1]) : ''
  if (!titleRaw) return null
  const dash = titleRaw.indexOf(' - ')
  const sectionNumber = (dash >= 0 ? titleRaw.slice(0, dash) : titleRaw).trim()
  const sectionTitle = dash >= 0 ? titleRaw.slice(dash + 3).trim() : null
  if (!/^33-\d+/.test(sectionNumber)) return null

  const bodyM = html.match(/<BODY>([\s\S]*?)<\/BODY>/i)
  const body = bodyM ? bodyM[1] : html
  const paras = [...body.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)].map((m) => decode(m[1])).filter(Boolean)
  // Drop the repeated header paragraph ("33-1343. Access").
  const noHeader = paras.filter((t, i) => !(i === 0 && t.replace(/\s/g, '').startsWith(sectionNumber.replace(/\s/g, ''))))
  const fullText = noHeader.join('\n\n').trim()
  return { sectionNumber, sectionTitle, fullText }
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, { headers: { 'User-Agent': 'GAM-statute-ingest/1.0' } })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.text()
}

async function main() {
  console.log('Fetching Title 33 section index…')
  const index = await fetchText(TITLE_INDEX)
  const ids = [...new Set([...index.matchAll(/ars\/33\/(\d{5}(?:-\d{2})?)\.htm/gi)].map((m) => m[1]))]
  // Keep only sections in our four chapters.
  const targets = ids.filter((id) => {
    const base = parseInt(id.slice(0, 5), 10)
    return (base >= 301 && base <= 381) || (base >= 1301 && base <= 1381) ||
           (base >= 1401 && base <= 1501) || (base >= 2101 && base <= 2151)
  })
  console.log(`Found ${targets.length} sections across the 4 acts. Downloading…`)

  let ok = 0, skipped = 0, failed = 0
  const counts: Record<string, number> = {}
  const CONCURRENCY = 8
  for (let i = 0; i < targets.length; i += CONCURRENCY) {
    const batch = targets.slice(i, i + CONCURRENCY)
    await Promise.all(batch.map(async (id) => {
      const url = SECTION_URL(id)
      try {
        const html = await fetchText(url)
        const p = parseSection(html)
        if (!p || !p.fullText) { skipped++; return }
        const actKey = actKeyForSection(p.sectionNumber)
        if (!actKey) { skipped++; return }
        await query(
          `INSERT INTO state_law_section_texts
             (state_code, act_key, section_number, section_title, full_text, source_url, source_date, effective_year)
           VALUES ('AZ', $1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (state_code, act_key, section_number, effective_year) DO NOTHING`,
          [actKey, p.sectionNumber, p.sectionTitle, p.fullText, url, SOURCE_DATE, EFFECTIVE_YEAR]
        )
        ok++
        counts[actKey] = (counts[actKey] || 0) + 1
      } catch (e: any) {
        failed++
        console.warn(`  ! ${id}: ${e?.message || e}`)
      }
    }))
    process.stdout.write(`\r  ${Math.min(i + CONCURRENCY, targets.length)}/${targets.length}`)
  }
  console.log(`\nDone. inserted=${ok} skipped=${skipped} failed=${failed}`)
  console.log('Per act:', counts)
  process.exit(0)
}

main().catch((e) => { console.error(e); process.exit(1) })
