/**
 * Georgia O.C.G.A. Title 44, Chapter 7 (Landlord and Tenant) ingester.
 *
 * GA is a Bucket-B state: the current O.C.G.A. is LexisNexis-walled (CAPTCHA +
 * per-article SPA hell). Fallback (Nic-approved S-state-law): the SCOTUS-freed
 * O.C.G.A. text on public.resource.org — the genuine codified text adjudicated
 * non-copyrightable in *Georgia v. Public.Resource.Org* (2020). It's the 2019
 * codification (source_date reflects that; refresh when a current free/official
 * source opens up). Fully automated — no browser, no CAPTCHA.
 *
 * Source: law.resource.org/pub/us/code/ga/gov.ga.ocga.2019.08.21.release.73.zip
 * Pre-step (done in shell): unzip the title.44 RTF, `textutil -convert txt` → /tmp/ga44.txt.
 * Each section body renders as:  "<num>. <heading>" / "Statute text" / <body> / "History" / annotations…
 * We keep only the block between "Statute text" and "History" (statute, no annotations).
 *
 * Run: cd apps/api && node -r ts-node/register src/db/ingestGaResourceOrg.ts [/tmp/ga44.txt] [--dry]
 */
import * as fs from 'fs'
import { query } from './index'

const STATE = 'GA'
const ACT_KEY = 'residential' // O.C.G.A. Title 44 Ch 7 covers the landlord-tenant relationship
const LAW_CATEGORY = 'landlord_tenant'
const SOURCE_URL = 'https://law.resource.org/pub/us/code/ga/gov.ga.ocga.2019.08.21.release.73.zip'
const SOURCE_DATE = '2019-08-21' // the codification vintage — honest, surfaced as the dated disclaimer
const EFFECTIVE_YEAR = 2026 // corpus catalog year (CHECK requires >=2020); vintage lives in source_date

const HEAD = /^\s*(44-7-\d+(?:\.\d+)?)\.\s+(.+?)\s*$/
const STOP = /^(History|Annotations|JUDICIAL DECISIONS|OPINIONS OF THE ATTORNEY GENERAL|RESEARCH REFERENCES|ALR|Editor's notes|Code Commission)/

interface Sec { number: string; title: string; text: string }

function parse(txt: string): Sec[] {
  const lines = txt.split('\n')
  const byNum = new Map<string, Sec>()
  for (let i = 0; i < lines.length; i++) {
    const m = HEAD.exec(lines[i])
    if (!m) continue
    // A real section body has a "Statute text" marker within the next couple lines
    // (TOC entries do not) — that disambiguates body from the table of contents.
    let j = i + 1
    while (j < lines.length && lines[j].trim() === '' && j < i + 3) j++
    if (!lines[j] || lines[j].trim() !== 'Statute text') continue
    const number = m[1]
    const title = m[2].replace(/\s+/g, ' ').trim()
    const body: string[] = []
    let k = j + 1
    for (; k < lines.length; k++) {
      if (STOP.test(lines[k].trim())) break
      body.push(lines[k])
    }
    const text = body.join('\n').replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{2,}/g, '\n').trim()
    if (text.length < 20) continue
    const prev = byNum.get(number)
    if (!prev || text.length > prev.text.length) byNum.set(number, { number, title, text })
    i = k - 1
  }
  return [...byNum.values()].sort((a, b) => {
    const pa = a.number.split('-').map(Number), pb = b.number.split('-').map(Number)
    return (pa[2] - pb[2]) || ((a.number.split('.')[1] ? +a.number.split('.')[1] : 0) - (b.number.split('.')[1] ? +b.number.split('.')[1] : 0))
  })
}

async function main() {
  const args = process.argv.slice(2)
  const dry = args.includes('--dry')
  const file = args.find((a) => !a.startsWith('--')) || '/tmp/ga44.txt'
  const txt = fs.readFileSync(file, 'utf8')
  const secs = parse(txt)
  console.log(`GA Title 44 Ch 7: parsed ${secs.length} sections from ${file}`)
  for (const s of secs.slice(0, 3)) console.log(`  [${s.number}] ${s.title.slice(0, 50)} :: ${s.text.slice(0, 70).replace(/\n/g, ' ')}…`)
  console.log(`  …last: [${secs[secs.length - 1]?.number}] ${secs[secs.length - 1]?.title.slice(0, 50)}`)
  if (dry) { console.log('DRY — nothing written'); process.exit(0) }
  let n = 0
  for (const s of secs) {
    await query(
      `INSERT INTO state_law_section_texts
         (state_code, act_key, section_number, section_title, full_text, source_url, source_date, effective_year, law_category)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (state_code, act_key, section_number, effective_year)
       DO UPDATE SET section_title=EXCLUDED.section_title, full_text=EXCLUDED.full_text,
                     source_url=EXCLUDED.source_url, source_date=EXCLUDED.source_date, law_category=EXCLUDED.law_category`,
      [STATE, ACT_KEY, s.number, s.title, s.text, SOURCE_URL, SOURCE_DATE, EFFECTIVE_YEAR, LAW_CATEGORY]
    )
    n++
  }
  console.log(`GA done. upserted=${n}`)
  process.exit(0)
}

main().catch((e) => { console.error(e); process.exit(1) })
