/**
 * Michigan non-tax real-estate statute full-text ingester.
 *
 * Sanctioned retrieve+cite+date carve-out (verbatim statute text, never advice;
 * see project_state_law_kb.md). Official source ONLY: the Michigan Legislature
 * site, legislature.mi.gov. Each MCL section lives at a stable URL:
 *
 *     https://www.legislature.mi.gov/Laws/MCL?objectName=mcl-CHAP-NNN
 *
 * (CHAP = chapter, NNN = section, alpha-suffix sections like 565-24a / 339-2512b
 * exist). Pages are STATIC HTML (no JS) and return in full with a browser UA.
 *
 * ENUMERATION — three tiers, all driven off the official index pages so we never
 * guess a section number:
 *
 *   1. Chapter index  (/Laws/MCL?objectName=mcl-chapNNN) — a table of every ACT
 *      in the chapter. Each row: <a objectName=mcl-Act-...|mcl-R-S-...>act</a>,
 *      a type cell, and a description cell. Rows whose description starts
 *      "Repealed-" are skipped wholesale.
 *   2. Act-index page (the act objectName from tier 1). SMALL acts list their
 *      sections directly as <a objectName=mcl-CHAP-NNN>. LARGE codified acts
 *      (Occupational Code 299-1980, RJA 236-1961) instead list per-chapter/
 *      article SUB-INDEX links of the form mcl-ACT-YEAR-NN; we recurse one level
 *      into those sub-indexes to reach the mcl-CHAP-NNN section links.
 *   3. Section page. Layout (inside <div class="sectionWrapper">):
 *        <h1 class="h3">…chapter header…</h1>           (context, skipped)
 *        <h1 class="h4">565.29 Unrecorded conveyance; …</h1>   = CATCHLINE
 *        <p class="margin8Px">Sec. 29.</p>             (marker, skipped)
 *        <p>…body paragraph…</p> …                     = BODY (multi-(1)(a) kept)
 *        <div class="editorials">History: …</div>      (source note, DROPPED)
 *      Catchline = the h4 text; title = catchline with the leading "NNN." dotted
 *      citation stripped; body = the <p> paragraphs after "Sec. N." up to (and
 *      excluding) the editorials/History div. Repealed/reserved/empty(<20 char)
 *      bodies are dropped.
 *
 * CATEGORY → SOURCE MAPPING (act_key == law_category for every block):
 *   conveyancing_title       = MCL Chapter 565, every non-repealed act (R.S.1846
 *                              Ch.65 conveyances + Recording Requirements Act 103
 *                              of 1937 + all current recording acts).
 *   condo_coop               = Condominium Act, Act 59 of 1978 (559.101–559.276).
 *                              MI has no separate co-op/CIC act; this is the condo
 *                              half (per recipe).
 *   broker_licensing         = Occupational Code Act 299 of 1980, Article 25 Real
 *                              Estate Brokers/Salespersons (339.2501–) + Article
 *                              26 Real Estate Appraisers (339.2601–).
 *   mortgage_lien_foreclosure= RJA Act 236 of 1961 Ch.31 (judicial foreclosure,
 *                              600.3101–) + Ch.32 (foreclosure by advertisement,
 *                              600.3201–) + MCL Chapter 570 every non-repealed
 *                              lien act (Construction Lien Act 497 of 1980,
 *                              Commercial Real Estate Broker's Lien Act 201 of
 *                              2010, and the other current statutory liens).
 *   general_real_property    = MCL Chapter 554, every non-repealed act (R.S.1846
 *                              estates in land + perpetuities + landlord/tenant
 *                              relationships + uniform acts) + RJA adverse-
 *                              possession limitation 600.5801 & 600.5821.
 *
 * Run: cd apps/api && node -r ts-node/register src/db/ingestMIRealEstate.ts
 * Idempotent (ON CONFLICT DO NOTHING). Reuses stripTags from the corpus framework.
 */

import { execFileSync } from 'child_process'
import { query } from './index'
import { stripTags } from './ingestStateLawCorpus'

const STATE = 'MI'
const SOURCE_DATE = '2026-06-14'
const EFFECTIVE_YEAR = 2026
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) GAM-statute-ingest/1.0'
const BASE = 'https://www.legislature.mi.gov'
const objUrl = (objectName: string) => `${BASE}/Laws/MCL?objectName=${objectName}`
const sectionObj = (chap: string, sec: string) => `mcl-${chap}-${sec}`

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
 * From a chapter index page, return the act-index objectNames whose description
 * cell is NOT marked "Repealed-". Each table row is:
 *   <tr><td><a href="…objectName=OBJ">label</a></td><td>type</td><td>desc</td></tr>
 */
function harvestActs(indexHtml: string): string[] {
  const re =
    /<tr>\s*<td><a href="\/Laws\/MCL\?objectName=(mcl-[A-Za-z0-9-]+)">[^<]*<\/a><\/td>\s*<td>[^<]*<\/td>\s*<td>([\s\S]*?)<\/td>\s*<\/tr>/gi
  const out: string[] = []
  const seen = new Set<string>()
  let m: RegExpExecArray | null
  while ((m = re.exec(indexHtml)) !== null) {
    const obj = m[1]
    const desc = m[2]
    if (/Repealed/i.test(desc)) continue
    if (seen.has(obj)) continue
    seen.add(obj)
    out.push(obj)
  }
  return out
}

/** Pull every distinct mcl-<chap>-<sec> section objectName out of any page. */
function sectionLinks(html: string, chap: string): string[] {
  const re = new RegExp(`objectName=(mcl-${chap}-[0-9A-Za-z]+)`, 'gi')
  const seen = new Set<string>()
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) seen.add(m[1].toLowerCase())
  return [...seen]
}

/** Pull act sub-index links of the form mcl-<actyear>-<NN> (codified big acts). */
function subIndexLinks(html: string, actPrefix: string): string[] {
  // actPrefix e.g. "299-1980" or "236-1961"; sub-index objectName = mcl-299-1980-25
  const re = new RegExp(`objectName=(mcl-${actPrefix}-[0-9A-Za-z]+)`, 'gi')
  const seen = new Set<string>()
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) seen.add(m[1].toLowerCase())
  return [...seen]
}

const secNum = (obj: string, chap: string) =>
  obj.replace(new RegExp(`^mcl-${chap}-`, 'i'), '')

/** Numeric leading portion of a section number, for range filtering ("3205a"→3205). */
const secInt = (n: string) => parseInt(n.replace(/[^0-9].*$/, ''), 10)

const sortSecs = (a: string, b: string) => {
  const ai = secInt(a)
  const bi = secInt(b)
  if (ai !== bi) return ai - bi
  return a.localeCompare(b)
}

/**
 * Parse a single section page. Returns null for repealed / reserved / empty
 * (body < 20 chars) / unparseable pages.
 */
function parseSection(html: string, expectedNumber: string): Parsed | null {
  const wrapMatch = html.match(/<div class="sectionWrapper">([\s\S]*?)<\/main>/i)
  const scope = wrapMatch ? wrapMatch[1] : html

  // Catchline = the h4 ("NNN. Title.").
  const h4 = scope.match(/<h1 class="h4"[^>]*>([\s\S]*?)<\/h1>/i)
  if (!h4) return null
  const catchline = stripTags(h4[1], false).trim()
  if (!catchline) return null
  if (/repealed/i.test(catchline) && catchline.length < 60) return null

  // Title = catchline minus the leading dotted citation (e.g. "565.29 ").
  let title: string | null = catchline
    .replace(/^[0-9]+[0-9A-Za-z.]*\.?\s+/, '')
    .trim()
  if (!title) title = null
  if (title && /^repealed\b/i.test(title)) return null
  if (title && /^\(?reserved\.?\)?$/i.test(title)) return null

  // Body = paragraphs between the "Sec. N." marker and the editorials/History
  // block. Cut the page at the editorials div so the History note is dropped.
  const cutEditorial = scope.split(/<div class="editorials/i)[0]
  // Everything after the h4 catchline.
  const afterH4 = cutEditorial.slice(cutEditorial.indexOf(h4[0]) + h4[0].length)
  // Collect <p>…</p> paragraphs; drop the "Sec. N." marker paragraph.
  const paras = [...afterH4.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)]
    .map((m) => stripTags(m[1], false).trim())
    .filter(Boolean)
    .filter((p) => !/^Sec\.\s*[0-9A-Za-z]+\.?$/.test(p))

  const body = paras.join('\n').trim()
  if (!body || body.length < 20) return null
  if (/^\(?reserved\.?\)?$/i.test(body)) return null
  if (/^This section was repealed/i.test(body) && body.length < 80) return null
  return { number: expectedNumber, title, text: body }
}

/** Fetch + parse + insert a list of section objectNames for one chapter/act_key. */
async function ingestSections(
  actKey: string,
  chap: string,
  sectionObjs: string[]
): Promise<number> {
  let ok = 0
  let skipped = 0
  const CONC = 4
  // de-dupe + stable order
  const uniq = [...new Set(sectionObjs.map((o) => o.toLowerCase()))]
  uniq.sort((a, b) => sortSecs(secNum(a, chap), secNum(b, chap)))

  for (let i = 0; i < uniq.length; i += CONC) {
    if (i > 0) await new Promise((r) => setTimeout(r, 250)) // politeness
    const batch = uniq.slice(i, i + CONC)
    const parsed = await Promise.all(
      batch.map(async (obj) => {
        const num = secNum(obj, chap)
        try {
          return { p: parseSection(curl(objUrl(obj)), num), obj, num }
        } catch (e: any) {
          console.warn(`  ! ${actKey} ${num} (${obj}): ${e?.message || e}`)
          return { p: null, obj, num }
        }
      })
    )
    for (const { p, obj } of parsed) {
      if (!p || !p.text || p.text.length < 20) {
        skipped++
        continue
      }
      await query(
        `INSERT INTO state_law_section_texts
           (state_code, act_key, section_number, section_title, full_text, source_url, source_date, effective_year, law_category)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (state_code, act_key, section_number, effective_year) DO NOTHING`,
        [STATE, actKey, p.number, p.title, p.text, objUrl(obj), SOURCE_DATE, EFFECTIVE_YEAR, actKey]
      )
      ok++
    }
    process.stdout.write(`\r  [${actKey}] ${Math.min(i + CONC, uniq.length)}/${uniq.length}`)
  }
  console.log(`\n  [${actKey}] inserted ${ok}, skipped ${skipped} of ${uniq.length}`)
  return ok
}

/**
 * Enumerate every section objectName in an entire MCL chapter: walk the chapter
 * index → non-repealed acts → (direct section links | recurse one sub-index
 * level) → mcl-<chap>-<sec> links.
 */
function enumerateChapter(chap: string): string[] {
  const indexHtml = curl(objUrl(`mcl-chap${chap}`))
  const acts = harvestActs(indexHtml)
  const secs = new Set<string>()
  for (const act of acts) {
    let actHtml: string
    try {
      actHtml = curl(objUrl(act))
    } catch (e: any) {
      console.warn(`  ! chap${chap} act ${act}: ${e?.message || e}`)
      continue
    }
    const direct = sectionLinks(actHtml, chap)
    if (direct.length > 0) {
      direct.forEach((s) => secs.add(s))
      continue
    }
    // Big codified act: recurse into sub-index pages (mcl-<year-act>-NN).
    // Derive the act-number prefix from any sub-index link present.
    const subMatch = actHtml.match(/objectName=mcl-([0-9]+-[0-9]{4})-[0-9A-Za-z]+/i)
    if (!subMatch) continue
    const prefix = subMatch[1]
    const subs = subIndexLinks(actHtml, prefix)
    for (const sub of subs) {
      try {
        sectionLinks(curl(objUrl(sub)), chap).forEach((s) => secs.add(s))
      } catch (e: any) {
        console.warn(`  ! chap${chap} sub ${sub}: ${e?.message || e}`)
      }
    }
  }
  return [...secs]
}

/** Resolve a codified-act sub-index objectName to its section links. */
function subIndexSections(subObj: string, chap: string): string[] {
  return sectionLinks(curl(objUrl(subObj)), chap)
}

async function main() {
  console.log(`\n=== MI — ingesting non-tax real-estate corpus (as of ${SOURCE_DATE}) ===`)
  const counts: Record<string, number> = {}

  // 1) conveyancing_title = whole MCL Chapter 565 (non-repealed acts).
  console.log('conveyancing_title: enumerating MCL Chapter 565 …')
  const ch565 = enumerateChapter('565')
  console.log(`  harvested ${ch565.length} section links`)
  counts['conveyancing_title'] = await ingestSections('conveyancing_title', '565', ch565)

  // 2) condo_coop = Condominium Act, Act 59 of 1978 (chapter 559).
  console.log('condo_coop: enumerating Condominium Act 59 of 1978 …')
  const condoHtml = curl(objUrl('mcl-Act-59-of-1978'))
  const condoSecs = sectionLinks(condoHtml, '559')
  console.log(`  harvested ${condoSecs.length} section links`)
  counts['condo_coop'] = await ingestSections('condo_coop', '559', condoSecs)

  // 3) broker_licensing = Occupational Code Art.25 (brokers) + Art.26 (appraisers).
  console.log('broker_licensing: enumerating Occupational Code Articles 25 + 26 …')
  const brokerSecs = [
    ...subIndexSections('mcl-299-1980-25', '339'),
    ...subIndexSections('mcl-299-1980-26', '339'),
  ]
  console.log(`  harvested ${brokerSecs.length} section links`)
  counts['broker_licensing'] = await ingestSections('broker_licensing', '339', brokerSecs)

  // 4) mortgage_lien_foreclosure = RJA Ch.31 + Ch.32 foreclosure + MCL Ch.570 liens.
  console.log('mortgage_lien_foreclosure: enumerating RJA foreclosure Ch.31/32 + MCL Ch.570 liens …')
  const foreclosureSecs = [
    ...subIndexSections('mcl-236-1961-31', '600'), // judicial foreclosure 600.3101–
    ...subIndexSections('mcl-236-1961-32', '600'), // foreclosure by advertisement 600.3201–
  ]
  const lienSecs = enumerateChapter('570') // every non-repealed lien act in Ch.570
  console.log(
    `  harvested ${foreclosureSecs.length} foreclosure + ${lienSecs.length} lien section links`
  )
  counts['mortgage_lien_foreclosure'] = await ingestSections(
    'mortgage_lien_foreclosure',
    // Two source chapters share this act_key; insert each under its own chapter
    // number for section parsing, but the same law_category/act_key.
    '600',
    foreclosureSecs
  )
  counts['mortgage_lien_foreclosure'] += await ingestSections(
    'mortgage_lien_foreclosure',
    '570',
    lienSecs
  )

  // 5) general_real_property = whole MCL Ch.554 + RJA adverse-possession 5801/5821.
  console.log('general_real_property: enumerating MCL Chapter 554 + adverse-possession limitation …')
  const ch554 = enumerateChapter('554')
  const adverse = [sectionObj('600', '5801'), sectionObj('600', '5821')]
  console.log(`  harvested ${ch554.length} Ch.554 + ${adverse.length} RJA limitation section links`)
  counts['general_real_property'] = await ingestSections('general_real_property', '554', ch554)
  counts['general_real_property'] += await ingestSections('general_real_property', '600', adverse)

  const total = Object.values(counts).reduce((a, b) => a + b, 0)
  console.log(`\nMI done. inserted=${total}`, counts)
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
