/**
 * Idaho property-tax statute full-text ingester (sanctioned retrieve+cite+date
 * carve-out: verbatim official statutory text, never advice).
 *
 * SOURCE: legislature.idaho.gov, Idaho Statutes Title 63 (Revenue and Taxation).
 * Official site, raw HTTP (no JS needed) — verified via curl.
 *
 * SITE LAYOUT (verified S-current):
 *   - Chapter index: /statutesrules/idstat/title63/t63chN/ lists every section
 *     as an anchor href="/statutesrules/idstat/Title63/T63CHN/SECT63-NNN[A-Z]".
 *   - Section page: /statutesrules/idstat/Title63/T63CHN/SECT63-NNN.
 *     The body is server-rendered as a run of
 *       <div style="...text-align: justify...">
 *         <span class="f11s" ...>...text...</span>
 *       </div>
 *     blocks. The FIRST justify-div leads with the section number + an
 *     uppercase-styled catchline:
 *       63-903.&nbsp;&nbsp;<span style="text-transform: uppercase">When
 *       payable.&nbsp;</span>(1) All property taxes ...
 *     Subsequent justify-divs are subsections ((2), (3), ...). Near the end a
 *     justify-div containing only "History:" precedes the bracketed source note
 *     ("[63-903 added 1996, ch. 98 ... am. 2025 ...]"), which we keep as the
 *     trailing source-note line (amendment provenance — the carve-out wants the
 *     date stamp). Site chrome (.lso-* header, nav, .footer-text) lives outside
 *     the justify-divs and is naturally excluded.
 *
 * TITLE EXTRACTION: the catchline is the <span style="text-transform:
 * uppercase">...</span> inside the first justify-div. Strip its trailing period.
 *
 * BODY: all justify-div text concatenated, with the leading "63-NNN." token and
 * the catchline span removed from the head. The "History:" label line is
 * normalized but the bracketed note is retained as the last line.
 *
 * CHAPTER → act/category: every chapter here is property-tax (act_key and
 * law_category both 'property_tax'). The five triage topics map to chapters:
 *   exemptions               = ch6
 *   assessment               = ch3
 *   assessment_review        = ch5  (county equalization) + ch38 (Board of Tax Appeals)
 *   levy_collection_payment  = ch8  (levy/apportionment) + ch9 (payment/collection)
 *   delinquency_tax_sale     = ch10 (delinquency/tax deed/redemption) + ch11 (seizure & sale)
 *
 * Repealed/reserved/short (<20 char) bodies are dropped.
 *
 * Run: cd apps/api && node -r ts-node/register src/db/ingestIDPropertyTax.ts
 * Idempotent (ON CONFLICT DO NOTHING).
 */

import { execFileSync } from 'child_process'
import { query } from './index'
import { stripTags } from './ingestStateLawCorpus'

const STATE = 'ID'
const ACT_KEY = 'property_tax'
const LAW_CATEGORY = 'property_tax'
const SOURCE_DATE = '2026-06-14'
const EFFECTIVE_YEAR = 2026
const UA = 'GAM-statute-ingest/1.0 (compliance research)'
const ORIGIN = 'https://legislature.idaho.gov'

// Topic → chapters (verbatim from triage recipe).
const CHAPTERS: { topic: string; ch: number }[] = [
  { topic: 'exemptions', ch: 6 },
  { topic: 'assessment', ch: 3 },
  { topic: 'assessment_review', ch: 5 },
  { topic: 'assessment_review', ch: 38 },
  { topic: 'levy_collection_payment', ch: 8 },
  { topic: 'levy_collection_payment', ch: 9 },
  { topic: 'delinquency_tax_sale', ch: 10 },
  { topic: 'delinquency_tax_sale', ch: 11 },
]

interface Parsed { number: string; title: string | null; text: string }

function curl(url: string): string {
  const buf = execFileSync('curl', ['-sL', '--max-time', '60', '-A', UA, url], {
    maxBuffer: 256 * 1024 * 1024,
  })
  return buf.toString('utf-8')
}

/** Harvest unique section paths from a chapter index page, in numeric order. */
function harvestChapter(html: string, ch: number): string[] {
  const re = new RegExp(
    `href="(/statutesrules/idstat/Title63/T63CH${ch}/SECT63-([0-9]+[A-Z]*))"`,
    'gi'
  )
  const seen = new Set<string>()
  const out: { path: string; num: string }[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) {
    const path = m[1]
    if (seen.has(path)) continue
    seen.add(path)
    out.push({ path, num: m[2] })
  }
  // numeric-then-alpha sort: 501, 501A, 502 ...
  out.sort((a, b) => {
    const na = parseInt(a.num, 10)
    const nb = parseInt(b.num, 10)
    if (na !== nb) return na - nb
    return a.num.localeCompare(b.num)
  })
  return out.map((o) => o.path)
}

/**
 * Parse a section page. Returns null for a not-found / repealed / empty section.
 */
function parseSection(html: string, expectedNumber: string): Parsed | null {
  // Pull every justify-styled div block (the statutory body lives only here).
  const divRe = /<div style="[^"]*text-align:\s*justify[^"]*">([\s\S]*?)<\/div>/gi
  const rawDivs: string[] = []
  let dm: RegExpExecArray | null
  while ((dm = divRe.exec(html)) !== null) rawDivs.push(dm[1])
  if (rawDivs.length === 0) return null

  // Title = the uppercase-styled catchline span inside the first div.
  const upMatch = rawDivs[0].match(/text-transform:\s*uppercase[^>]*>([\s\S]*?)<\/span>/i)
  let title: string | null = null
  if (upMatch) {
    title = stripTags(upMatch[1], false).replace(/\.\s*$/, '').trim() || null
  }
  if (title && /^repealed\b/i.test(title)) return null
  if (title && /^\[?reserved\.?\]?$/i.test(title)) return null

  // Body: strip-tags each div, drop a div that is solely the "History:" label,
  // and from the FIRST div remove the leading "63-NNN." citation token and the
  // catchline (the uppercase span text), since they are captured as number/title.
  const lines: string[] = []
  for (let i = 0; i < rawDivs.length; i++) {
    let txt = stripTags(rawDivs[i], false).trim()
    if (!txt) continue
    if (i === 0) {
      // remove leading section-number token "63-903." (and any stray dup)
      txt = txt.replace(/^63-[0-9]+[A-Za-z]*\.\s*/, '')
      // remove the catchline (title text + its trailing period) if present at head
      if (title) {
        const esc = title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        txt = txt.replace(new RegExp('^' + esc + '\\.?\\s*'), '')
      }
      txt = txt.trim()
      if (!txt) continue
    }
    // Skip a lone "History:" label line (the note line that follows is kept).
    if (/^history:?$/i.test(txt)) continue
    lines.push(txt)
  }
  const text = lines.join('\n').trim()
  if (!text || text.length < 20) return null
  if (/^\[?reserved\.?\]?$/i.test(text)) return null
  if (/^repealed\b/i.test(text)) return null
  return { number: expectedNumber, title, text }
}

async function ingestChapter(topic: string, ch: number): Promise<{ ok: number; skipped: number; total: number }> {
  const idxUrl = `${ORIGIN}/statutesrules/idstat/title63/t63ch${ch}/`
  const paths = harvestChapter(curl(idxUrl), ch)
  console.log(`\n[${topic}] ch${ch}: harvested ${paths.length} section links`)
  let ok = 0
  let skipped = 0
  const CONC = 3
  for (let i = 0; i < paths.length; i += CONC) {
    if (i > 0) await new Promise((r) => setTimeout(r, 250)) // politeness
    const batch = paths.slice(i, i + CONC)
    const results = await Promise.all(
      batch.map((path) => {
        const num = (path.match(/SECT63-([0-9A-Za-z]+)$/) || [])[1] || ''
        const number = '63-' + num
        try {
          return { p: parseSection(curl(`${ORIGIN}${path}`), number), url: `${ORIGIN}${path}`, number }
        } catch (e: any) {
          console.warn(`  ! ${number}: ${e?.message || e}`)
          return { p: null, url: `${ORIGIN}${path}`, number }
        }
      })
    )
    for (const { p, url } of results) {
      if (!p) {
        skipped++
        continue
      }
      await query(
        `INSERT INTO state_law_section_texts
           (state_code, act_key, section_number, section_title, full_text, source_url, source_date, effective_year, law_category)
         VALUES ('ID', 'property_tax', $1, $2, $3, $4, '2026-06-14', 2026, 'property_tax')
         ON CONFLICT (state_code, act_key, section_number, effective_year) DO NOTHING`,
        [p.number, p.title, p.text, url]
      )
      ok++
    }
    process.stdout.write(`\r  [${topic} ch${ch}] ${Math.min(i + CONC, paths.length)}/${paths.length}`)
  }
  console.log(`\n  [${topic} ch${ch}] parsed-ok ${ok}, skipped ${skipped} of ${paths.length}`)
  return { ok, skipped, total: paths.length }
}

async function main() {
  console.log(`\n=== ID — ingesting property-tax full-text corpus (as of ${SOURCE_DATE}) ===`)
  const byTopic: Record<string, number> = {}
  let totalOk = 0
  for (const { topic, ch } of CHAPTERS) {
    const r = await ingestChapter(topic, ch)
    byTopic[topic] = (byTopic[topic] || 0) + r.ok
    totalOk += r.ok
  }
  console.log(`\nID done. parsed-ok total=${totalOk}`, byTopic)
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
