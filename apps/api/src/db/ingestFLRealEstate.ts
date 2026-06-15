/**
 * Florida NON-tax real-estate statute full-text ingester (S-corpus follow-up).
 *
 * Sanctioned retrieve+cite+date carve-out: GAM stores the VERBATIM text of each
 * statute section so the agent can quote + cite + date it — never advise. Same
 * posture as the landlord/tenant corpus already in state_law_section_texts (see
 * services/stateLaw.ts + the migration headers).
 *
 * SOURCE — official only: the Florida Senate's server-rendered full-chapter
 * pages at flsenate.gov/Laws/Statutes/<year>/Chapter<NN>/All. Each page holds
 * every active section of the chapter in clean semantic markup:
 *   <div class="Section">
 *     <span class="SectionNumber">695.01&#x2003;</span>
 *     <span class="Catchline"><span class="CatchlineText">Title.</span>…</span>
 *     <span class="SectionBody">… body …</span>
 *     <div class="History">…</div>
 *   </div>
 * Repealed/reserved sections appear ONLY in the chapter TOC, never as a body
 * <div class="Section">, so the parser naturally drops them. (m.flsenate.gov is
 * a JS SPA with no static text — never used here; the /All pages are static.)
 *
 * This shares the parseFlAll markup parser shape already proven on Ch83/723 in
 * ingestStateLawCorpus.ts, and reuses its stripTags helper + the same
 * query/idempotency plumbing (ON CONFLICT DO NOTHING).
 *
 * FIVE non-tax real-estate categories, one act_key == law_category each, mapped
 * to Title XL (Real and Personal Property) + cross-title adverse possession.
 * Chapters are assigned to exactly ONE category — no chapter is double-counted:
 *
 *   conveyancing_title        Ch 695 (Record of Conveyances), 689 (Conveyances
 *                             of Land & Declarations of Trust), 692 (effect of
 *                             conveyances by/to certain entities), 694
 *                             (validating-act conveyances), 696 (recording fees /
 *                             contracts for deed). Ch 693 is wholly repealed —
 *                             flsenate returns the TOC index, 0 sections.
 *   condo_coop                Ch 718 (Condominium Act), 719 (Cooperatives),
 *                             720 (Homeowners' Associations / common-interest).
 *   broker_licensing          Ch 475 (Real Estate Brokers, Sales Associates,
 *                             Schools, and Appraisers — appraisers are Part II of
 *                             this SAME chapter; commercial lien is Part III).
 *   mortgage_lien_foreclosure Ch 697 (Instruments Deemed Mortgages / Nature of a
 *                             Mortgage), 713 (Construction Lien Law + other
 *                             liens), 702 (Foreclosure of Mortgages).
 *   general_real_property     Title XL residual NOT claimed above: Ch 712
 *                             (Marketable Record Titles to Real Property /
 *                             MRTA), 704 (easements & ways of necessity), 705
 *                             (lost/abandoned property), plus cross-title adverse
 *                             possession s. 95.16 + 95.18 (Title VI limitations).
 *                             Ch 689 is claimed by conveyancing_title (the recipe
 *                             dedup rule), so it is NOT re-ingested here.
 *
 * Run: cd apps/api && node -r ts-node/register src/db/ingestFLRealEstate.ts
 * Idempotent. Repealed/reserved/short (<20 char) bodies are dropped.
 */

import { execFileSync } from 'child_process'
import { query } from './index'
import { stripTags } from './ingestStateLawCorpus'

const STATE = 'FL'
const SOURCE_DATE = '2026-06-14'
const EFFECTIVE_YEAR = 2026
const YEAR = 2025 // statutes edition on flsenate.gov
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'

const chapUrl = (ch: number | string) =>
  `https://www.flsenate.gov/Laws/Statutes/${YEAR}/Chapter${ch}/All`

interface Parsed {
  number: string
  title: string | null
  text: string
}

function curl(url: string): string {
  const buf = execFileSync('curl', ['-sL', '--max-time', '90', '-A', UA, url], {
    maxBuffer: 256 * 1024 * 1024,
  })
  return buf.toString('utf-8')
}

/**
 * Parse a flsenate.gov "/All" full-chapter page into its active sections.
 * `keepNumber` decides which sections to retain (used for the 95.16/95.18
 * adverse-possession carve-out inside the limitations chapter); default keeps
 * every parsed section. Repealed/reserved sections never appear as body
 * <div class="Section"> blocks, so they fall out for free; the <20-char and
 * leading-"Repealed"/"Reserved" guards are belt-and-suspenders.
 */
function parseChapter(html: string, keepNumber: (n: string) => boolean = () => true): Parsed[] {
  const out: Parsed[] = []
  const blocks = html.split(/<div class="Section">/).slice(1)
  for (const b of blocks) {
    const chunk = b.slice(0, b.indexOf('</div></div>') >= 0 ? b.indexOf('</div></div>') + 6 : b.length)
    const numM = chunk.match(/<span class="SectionNumber">([\s\S]*?)<\/span>/i)
    if (!numM) continue
    const number = stripTags(numM[1], false).replace(/\s+/g, '')
    if (!/^\d/.test(number)) continue
    if (!keepNumber(number)) continue

    const titleM = chunk.match(/<span[^>]*class="CatchlineText"[^>]*>([\s\S]*?)<\/span>/i)
    const title = titleM ? stripTags(titleM[1], false).replace(/\.\s*$/, '') || null : null

    const bodyM = chunk.match(/<span class="SectionBody">([\s\S]*?)<\/span><div class="History"/i)
    const bodyRaw = bodyM ? bodyM[1] : chunk.match(/<span class="SectionBody">([\s\S]*?)$/i)?.[1] ?? ''
    const text = stripTags(bodyRaw, true)

    if (!text || text.length < 20) continue
    if (/^\s*repealed\b/i.test(text) || /^\s*repealed\b/i.test(title || '')) continue
    if (/^\s*\[?reserved\.?\]?\s*$/i.test(text) || /^\s*\[?reserved\.?\]?\s*$/i.test(title || '')) continue

    out.push({ number, title, text })
  }
  return out
}

interface ChapterSpec {
  ch: number | string
  keep?: (n: string) => boolean
}
interface CategorySpec {
  category: string
  statute: string
  chapters: ChapterSpec[]
}

const CATEGORIES: CategorySpec[] = [
  {
    category: 'conveyancing_title',
    statute:
      "Florida Statutes Title XL — Ch. 695 Record of Conveyances + Ch. 689 Conveyances of Land & Declarations of Trust + Ch. 692/694 effect of conveyances + Ch. 696 recording",
    chapters: [{ ch: 695 }, { ch: 689 }, { ch: 692 }, { ch: 693 }, { ch: 694 }, { ch: 696 }],
  },
  {
    category: 'condo_coop',
    statute:
      "Florida Statutes Ch. 718 Condominium Act + Ch. 719 Cooperatives + Ch. 720 Homeowners' Associations",
    chapters: [{ ch: 718 }, { ch: 719 }, { ch: 720 }],
  },
  {
    category: 'broker_licensing',
    statute:
      'Florida Statutes Ch. 475 Real Estate Brokers, Sales Associates, Schools, and Appraisers',
    chapters: [{ ch: 475 }],
  },
  {
    category: 'mortgage_lien_foreclosure',
    statute:
      'Florida Statutes Ch. 697 Instruments Deemed Mortgages + Ch. 713 Construction Lien Law + Ch. 702 Foreclosure of Mortgages',
    chapters: [{ ch: 697 }, { ch: 713 }, { ch: 702 }],
  },
  {
    category: 'general_real_property',
    statute:
      'Florida Statutes Title XL residual — Ch. 712 MRTA + Ch. 704 easements + Ch. 705 lost/abandoned property + s. 95.16/95.18 adverse possession',
    chapters: [
      { ch: 712 },
      { ch: 704 },
      { ch: 705 },
      // adverse possession lives in the Title VI limitations chapter; keep only
      // the two real-property AP sections, not the whole limitations chapter.
      { ch: 95, keep: (n) => n === '95.16' || n === '95.18' },
    ],
  },
]

async function ingestCategory(spec: CategorySpec): Promise<number> {
  let ok = 0
  let skipped = 0
  let parsedTotal = 0
  for (const c of spec.chapters) {
    const url = chapUrl(c.ch)
    let secs: Parsed[] = []
    try {
      secs = parseChapter(curl(url), c.keep)
    } catch (e: any) {
      console.warn(`  ! ${spec.category} Ch${c.ch}: ${e?.message || e}`)
      continue
    }
    parsedTotal += secs.length
    for (const s of secs) {
      // query() returns the rows array; RETURNING id yields one row on a real
      // insert, zero on an ON CONFLICT skip — distinguishes new vs. conflict.
      const res = await query<{ id: string }>(
        `INSERT INTO state_law_section_texts
           (state_code, act_key, section_number, section_title, full_text, source_url, source_date, effective_year, law_category)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (state_code, act_key, section_number, effective_year) DO NOTHING
         RETURNING id`,
        [STATE, spec.category, s.number, s.title, s.text, url, SOURCE_DATE, EFFECTIVE_YEAR, spec.category]
      )
      if (res.length > 0) ok++
      else skipped++
    }
    console.log(`  [${spec.category}] Ch${c.ch} → parsed ${secs.length}`)
  }
  console.log(`  [${spec.category}] parsed ${parsedTotal}, inserted ${ok}, skipped/conflict ${skipped}`)
  return ok
}

async function main() {
  console.log(`\n=== FL — ingesting non-tax real-estate corpus (as of ${SOURCE_DATE}) ===`)
  const counts: Record<string, number> = {}
  for (const spec of CATEGORIES) {
    counts[spec.category] = await ingestCategory(spec)
  }
  const total = Object.values(counts).reduce((a, b) => a + b, 0)
  console.log(`\nFL real-estate done. inserted=${total}`, counts)
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
