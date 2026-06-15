/**
 * Idaho NON-TAX real-estate statute full-text ingester (round-2 — fills the five
 * categories the first triage pass missed). Sanctioned retrieve+cite+date
 * carve-out: verbatim official statutory text, never advice.
 *
 * SOURCE: legislature.idaho.gov, official Idaho Statutes. Raw HTTP, no JS —
 * verified S-current via curl. The first-pass triage hints pointed at a
 * lowercase section path template (/idstat/title55/t55ch6/sect55-NNN/) that does
 * NOT exist on the live site; the real, server-rendered pattern (confirmed by the
 * shipping ingestIDPropertyTax.ts and re-verified here) is:
 *
 *   - Chapter index:  /statutesrules/idstat/title{T}/t{T}ch{N}/  (also resolves
 *     case-insensitively). Lists every section as an anchor
 *       href="/statutesrules/idstat/Title{T}/T{T}CH{N}/SECT{T}-NNN[A-Z]"
 *   - Section page:   /statutesrules/idstat/Title{T}/T{T}CH{N}/SECT{T}-NNN
 *     Body is server-rendered as a run of
 *       <div style="...text-align: justify...">
 *         <span class="f11s" ...>...text...</span>
 *       </div>
 *     blocks. The FIRST justify-div leads with the section number + an
 *     uppercase-styled catchline span:
 *       55-601.&nbsp;&nbsp;<span style="text-transform: uppercase">Conveyance
 *       &#8212; How made.&nbsp;</span>A conveyance of ...
 *     Trailing "History:" label + bracketed source note ("[55-601, added ...]")
 *     are retained (amendment provenance — the carve-out wants the date stamp).
 *     Site chrome lives outside the justify-divs and is naturally excluded.
 *
 * Parser is the proven ingestIDPropertyTax.ts logic, generalized over the title
 * prefix (55 / 54 / 45 / 6 / 5) and with an optional per-chapter section-number
 * allow-filter (used so Title 5 Ch.2 contributes only the adverse-possession
 * sections 5-202..5-210, not the entire limitation-of-actions chapter).
 *
 * CATEGORY MAP (act_key == law_category == the category key, per task spec):
 *   conveyancing_title         T55 Ch6 (conveyances), Ch8 (recording), Ch9 (construction of conveyances)
 *   condo_coop                 T55 Ch15 (Condominium Property Act) + Ch32 (HOA Act). Idaho has NO
 *                              standalone cooperative / common-interest-ownership act; condo + HOA
 *                              are the closest coverage.
 *   broker_licensing           T54 Ch20 (Real Estate License Law) + Ch41 (Real Estate Appraisers Act)
 *   mortgage_lien_foreclosure  T45 Ch5 (mechanic's/materialmen liens), Ch9 (real-property mortgages),
 *                              Ch15 (trust deeds / nonjudicial foreclosure) + T6 Ch1 (judicial
 *                              foreclosure, one-action rule)
 *   general_real_property      T55 Ch1-Ch5 (property & ownership general provisions, estates, common
 *                              ownership, owners' rights & obligations) + T5 Ch2 sects 5-202..5-210
 *                              (adverse-possession limitation periods)
 *
 * Repealed / reserved / TOC / empty (<20 char) bodies are dropped.
 *
 * Run: cd apps/api && node -r ts-node/register src/db/ingestIDRealEstate.ts
 * Idempotent (ON CONFLICT DO NOTHING).
 */

import { execFileSync } from 'child_process'
import { query } from './index'
import { stripTags } from './ingestStateLawCorpus'

const STATE = 'ID'
const SOURCE_DATE = '2026-06-14'
const EFFECTIVE_YEAR = 2026
const UA = 'GAM-statute-ingest/1.0 (compliance research)'
const ORIGIN = 'https://legislature.idaho.gov'

interface ChapterSpec {
  category: string
  title: number // statute title number (55, 54, 45, 6, 5)
  ch: number
  /** Optional allow-list of integer section numbers; if set, only those pass. */
  only?: number[]
}

// One row per (category, title, chapter). act_key === law_category === category.
const CHAPTERS: ChapterSpec[] = [
  // conveyancing_title
  { category: 'conveyancing_title', title: 55, ch: 6 },
  { category: 'conveyancing_title', title: 55, ch: 8 },
  { category: 'conveyancing_title', title: 55, ch: 9 },
  // condo_coop
  { category: 'condo_coop', title: 55, ch: 15 },
  { category: 'condo_coop', title: 55, ch: 32 },
  // broker_licensing
  { category: 'broker_licensing', title: 54, ch: 20 },
  { category: 'broker_licensing', title: 54, ch: 41 },
  // mortgage_lien_foreclosure
  { category: 'mortgage_lien_foreclosure', title: 45, ch: 5 },
  { category: 'mortgage_lien_foreclosure', title: 45, ch: 9 },
  { category: 'mortgage_lien_foreclosure', title: 45, ch: 15 },
  { category: 'mortgage_lien_foreclosure', title: 6, ch: 1 },
  // general_real_property
  { category: 'general_real_property', title: 55, ch: 1 },
  { category: 'general_real_property', title: 55, ch: 2 },
  { category: 'general_real_property', title: 55, ch: 3 },
  { category: 'general_real_property', title: 55, ch: 4 },
  { category: 'general_real_property', title: 55, ch: 5 },
  // adverse-possession limitation periods only (not the whole limitation chapter)
  { category: 'general_real_property', title: 5, ch: 2, only: [202, 203, 204, 205, 206, 207, 208, 209, 210] },
]

interface Parsed { number: string; title: string | null; text: string }

function curl(url: string): string {
  const buf = execFileSync('curl', ['-sL', '--max-time', '60', '-A', UA, url], {
    maxBuffer: 256 * 1024 * 1024,
  })
  return buf.toString('utf-8')
}

/** Harvest unique section paths from a chapter index page, in numeric order. */
function harvestChapter(html: string, title: number, ch: number): { path: string; num: string }[] {
  const re = new RegExp(
    `href="(/statutesrules/idstat/Title${title}/T${title}CH${ch}/SECT${title}-([0-9]+[A-Z]*))"`,
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
  out.sort((a, b) => {
    const na = parseInt(a.num, 10)
    const nb = parseInt(b.num, 10)
    if (na !== nb) return na - nb
    return a.num.localeCompare(b.num)
  })
  return out
}

/** Parse a section page. Returns null for not-found / repealed / reserved / empty. */
function parseSection(html: string, title: number, expectedNumber: string): Parsed | null {
  const divRe = /<div style="[^"]*text-align:\s*justify[^"]*">([\s\S]*?)<\/div>/gi
  const rawDivs: string[] = []
  let dm: RegExpExecArray | null
  while ((dm = divRe.exec(html)) !== null) rawDivs.push(dm[1])
  if (rawDivs.length === 0) return null

  // Title = the uppercase-styled catchline span inside the first div.
  const upMatch = rawDivs[0].match(/text-transform:\s*uppercase[^>]*>([\s\S]*?)<\/span>/i)
  let secTitle: string | null = null
  if (upMatch) {
    secTitle = stripTags(upMatch[1], false).replace(/\.\s*$/, '').trim() || null
  }
  if (secTitle && /^repealed\b/i.test(secTitle)) return null
  if (secTitle && /^\[?reserved\.?\]?$/i.test(secTitle)) return null

  const numTok = new RegExp(`^${title}-[0-9]+[A-Za-z]*\\.\\s*`)
  const lines: string[] = []
  for (let i = 0; i < rawDivs.length; i++) {
    let txt = stripTags(rawDivs[i], false).trim()
    if (!txt) continue
    if (i === 0) {
      txt = txt.replace(numTok, '')
      if (secTitle) {
        const esc = secTitle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        txt = txt.replace(new RegExp('^' + esc + '\\.?\\s*'), '')
      }
      txt = txt.trim()
      if (!txt) continue
    }
    if (/^history:?$/i.test(txt)) continue
    lines.push(txt)
  }
  const text = lines.join('\n').trim()
  if (!text || text.length < 20) return null
  if (/^\[?reserved\.?\]?$/i.test(text)) return null
  if (/^repealed\b/i.test(text)) return null
  return { number: expectedNumber, title: secTitle, text }
}

async function ingestChapter(spec: ChapterSpec): Promise<{ ok: number; skipped: number; total: number }> {
  const { category, title, ch, only } = spec
  const idxUrl = `${ORIGIN}/statutesrules/idstat/title${title}/t${title}ch${ch}/`
  let entries = harvestChapter(curl(idxUrl), title, ch)
  if (only && only.length) {
    const allow = new Set(only)
    entries = entries.filter((e) => allow.has(parseInt(e.num, 10)))
  }
  console.log(`\n[${category}] T${title}CH${ch}: ${entries.length} section links${only ? ' (filtered)' : ''}`)
  let ok = 0
  let skipped = 0
  const CONC = 3
  for (let i = 0; i < entries.length; i += CONC) {
    if (i > 0) await new Promise((r) => setTimeout(r, 250)) // politeness
    const batch = entries.slice(i, i + CONC)
    const results = await Promise.all(
      batch.map((e) => {
        const number = `${title}-${e.num}`
        const url = `${ORIGIN}${e.path}`
        try {
          return { p: parseSection(curl(url), title, number), url }
        } catch (err: any) {
          console.warn(`  ! ${number}: ${err?.message || err}`)
          return { p: null, url }
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
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $2)
         ON CONFLICT (state_code, act_key, section_number, effective_year) DO NOTHING`,
        [STATE, category, p.number, p.title, p.text, url, SOURCE_DATE, EFFECTIVE_YEAR]
      )
      ok++
    }
    process.stdout.write(`\r  [${category} T${title}CH${ch}] ${Math.min(i + CONC, entries.length)}/${entries.length}`)
  }
  console.log(`\n  [${category} T${title}CH${ch}] parsed-ok ${ok}, skipped ${skipped} of ${entries.length}`)
  return { ok, skipped, total: entries.length }
}

async function main() {
  console.log(`\n=== ID — ingesting NON-TAX real-estate full-text corpus (round 2, as of ${SOURCE_DATE}) ===`)
  const byCategory: Record<string, number> = {}
  let totalOk = 0
  for (const spec of CHAPTERS) {
    const r = await ingestChapter(spec)
    byCategory[spec.category] = (byCategory[spec.category] || 0) + r.ok
    totalOk += r.ok
  }
  console.log(`\nID done. parsed-ok total=${totalOk}`, byCategory)
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
