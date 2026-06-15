/**
 * Nevada statute full-text ingester for the S442 state-law corpus.
 *
 * Unlike Arizona (one HTML page per section), Nevada serves each NRS chapter
 * as ONE large Word-generated page. Body sections are delimited by
 * `<a name=NRS118ASec330>` anchors (the table-of-contents uses href links, the
 * body uses name anchors), with the number in <span class="Section"> and the
 * title in <span class="Leadline">. The page is windows-1252 encoded.
 *
 * Run: cd apps/api && node -r ts-node/register src/db/ingestNvStateLaw.ts
 * Idempotent (ON CONFLICT DO NOTHING). Reusable shape for other NV-format
 * states' chapters.
 */

import { query } from './index'

const SOURCE_DATE = '2026-06-11'
const EFFECTIVE_YEAR = 2026
const CHAPTERS = [
  { url: 'https://www.leg.state.nv.us/nrs/nrs-118a.html', actKey: 'residential', chap: '118A' },
  { url: 'https://www.leg.state.nv.us/nrs/nrs-118b.html', actKey: 'manufactured_home_park', chap: '118B' },
  { url: 'https://www.leg.state.nv.us/nrs/nrs-118c.html', actKey: 'commercial', chap: '118C' },
]

function decode(s: string): string {
  return s
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"').replace(/&#39;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/[\u00a0\u2002\u2003\u2007\u2008\u2009\u200a]/g, ' ') // normalize unicode spaces
    .replace(/\r/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .trim()
}

async function fetchCp1252(url: string): Promise<string> {
  const res = await fetch(url, { headers: { 'User-Agent': 'GAM-statute-ingest/1.0' } })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return new TextDecoder('windows-1252').decode(await res.arrayBuffer())
}

interface Sec { number: string; title: string | null; text: string }

function parseChapter(html: string, chap: string): Sec[] {
  // Split on the body anchors; parts[0] is everything before the first body
  // section (chapter title + table of contents) and is dropped.
  const parts = html.split(new RegExp(`<a name=NRS${chap}Sec[^>]*>`, 'i'))
  const out: Sec[] = []
  for (let i = 1; i < parts.length; i++) {
    const chunk = parts[i]
    const numM = chunk.match(/<span\s+class="?Section"?[^>]*>([^<]+)<\/span>/i)
    if (!numM) continue
    const number = decode(numM[1]).replace(/\s+/g, '')
    if (!new RegExp(`^${chap}\\.`).test(number)) continue
    const titleM = chunk.match(/<span\s+class="?Leadline"?[^>]*>([\s\S]*?)<\/span>/i)
    const title = titleM ? decode(titleM[1]).replace(/\s+/g, ' ').replace(/\.\s*$/, '') : null
    // Body = everything after the header paragraph (Section + Leadline spans).
    const rest = titleM ? chunk.slice((titleM.index ?? 0) + titleM[0].length) : chunk
    const text = decode(rest)
    out.push({ number, title, text })
  }
  return out
}

async function main() {
  let ok = 0, skipped = 0
  const counts: Record<string, number> = {}
  for (const { url, actKey, chap } of CHAPTERS) {
    console.log(`Fetching NRS ${chap}…`)
    const html = await fetchCp1252(url)
    const secs = parseChapter(html, chap)
    console.log(`  parsed ${secs.length} sections`)
    for (const s of secs) {
      if (!s.text || s.text.length < 20) { skipped++; continue }
      await query(
        `INSERT INTO state_law_section_texts
           (state_code, act_key, section_number, section_title, full_text, source_url, source_date, effective_year)
         VALUES ('NV', $1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (state_code, act_key, section_number, effective_year) DO NOTHING`,
        [actKey, s.number, s.title, s.text, url, SOURCE_DATE, EFFECTIVE_YEAR]
      )
      ok++; counts[actKey] = (counts[actKey] || 0) + 1
    }
  }
  console.log(`Done. inserted=${ok} skipped=${skipped}`, counts)
  process.exit(0)
}

main().catch((e) => { console.error(e); process.exit(1) })
