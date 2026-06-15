/**
 * Arizona non-tax real-estate statute full-text ingester (sanctioned
 * retrieve+cite+date carve-out — verbatim statute text, never advice).
 *
 * Source: azleg.gov, the Arizona State Legislature's OFFICIAL Arizona Revised
 * Statutes (ARS) site. Two layers:
 *
 *   1) Chapter Table of Contents per Title at
 *      https://www.azleg.gov/arsDetail/?title={T}
 *      Each section is an anchor:
 *        href="/viewdocument/?docName=https://www.azleg.gov/ars/{T}/{NNNNN}.htm"
 *      The TOC lists "Chapter N <NAME>" headings inline; sections appear in
 *      document order AFTER their chapter heading, so we attribute each section
 *      docName to the most-recently-seen chapter. (This is more robust than
 *      hardcoded numeric ranges — e.g. Title 33 Chapter 5 GIFTS lives at 33-601,
 *      not 33-501; and AZ's display chapter numbers do NOT line up with the
 *      5-digit section prefixes.)
 *
 *   2) Per-section static HTML at https://www.azleg.gov/ars/{T}/{NNNNN}.htm
 *      where NNNNN is the zero-padded 5-digit section number after the title
 *      prefix, with sub-letter sections using a hyphen (33-401.01 -> 00401-01).
 *      Page layout (UTF-8):
 *        <TITLE>NUM - Heading</TITLE>
 *        <font color=GREEN>NUM</font>. <font color=PURPLE><u>Heading</u></font>
 *        one <p> per subsection (A., B., 1., 2., ...).
 *      Invalid/empty sections return a ~78KB 404 chrome page with HTTP 404, so
 *      we validate the HTTP status code, not body presence.
 *
 * CATEGORY -> chapter mapping (verified against each Title's live TOC on
 * 2026-06-14; chapter NAMES confirmed, not assumed):
 *   conveyancing_title        T33 Ch4  CONVEYANCES AND DEEDS
 *   condo_coop                T33 Ch9  CONDOMINIUMS + Ch16 PLANNED COMMUNITIES
 *                             (AZ has no separate stock-cooperative statute)
 *   broker_licensing          T32 Ch20 REAL ESTATE  + Ch36 REAL ESTATE APPRAISAL
 *                             (NB: the brief's "Ch 39" label is wrong — Ch 39 is
 *                              ACUPUNCTURE; appraisers are Ch 36 / 32-3601+, which
 *                              matches the brief's own URL 32/03601.htm.)
 *   mortgage_lien_foreclosure T33 Ch6 MORTGAGES + Ch6.1 DEEDS OF TRUST
 *                             + Ch7 LIENS
 *   general_real_property     T33 Ch1 LANDMARKS AND SURVEYS + Ch2 ESTATES
 *                             + Ch5 GIFTS, plus T12 Ch5 LIMITATIONS OF ACTIONS
 *                             restricted to the adverse-possession article
 *                             (12-521..12-530) — the rest of Ch5 is unrelated
 *                             tort/contract limitations.
 *
 * Per-section drops: HTTP != 200, no catchline, repealed, reserved, empty, or
 * body < 20 chars.
 *
 * Run: cd apps/api && node -r ts-node/register src/db/ingestAZRealEstate.ts
 * Idempotent (ON CONFLICT DO NOTHING). law_category == act_key for every block.
 */

import { execFileSync } from 'child_process'
import { query } from './index'
import { decodeEntities } from './ingestStateLawCorpus'

const STATE = 'AZ'
const SOURCE_DATE = '2026-06-14'
const EFFECTIVE_YEAR = 2026
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'

const tocUrl = (title: string) => `https://www.azleg.gov/arsDetail/?title=${title}`
const secUrl = (title: string, code: string) => `https://www.azleg.gov/ars/${title}/${code}.htm`

interface Cite {
  /** human citation, e.g. "33-401" or "33-401.01" */
  number: string
  /** title number, e.g. "33" */
  title: string
  /** 5-digit (+ optional -NN) page code, e.g. "00401" or "00401-01" */
  code: string
}
interface Parsed {
  number: string
  title: string | null
  text: string
}

/** Curl returning { status, body }; we MUST gate on status (404 returns a page). */
function curlStatus(url: string): { status: number; body: string } {
  // Append HTTP status as a trailing sentinel so we can read it from one buffer.
  const out = execFileSync(
    'curl',
    ['-sL', '--max-time', '60', '-A', UA, '-w', '\n__HTTP_STATUS__%{http_code}', url],
    { maxBuffer: 256 * 1024 * 1024 }
  ).toString('utf-8')
  const m = out.match(/\n__HTTP_STATUS__(\d{3})\s*$/)
  const status = m ? Number(m[1]) : 0
  const body = m ? out.slice(0, m.index) : out
  return { status, body }
}

/** code "00401" -> "33-401"; "00401-01" -> "33-401.01". */
function codeToNumber(title: string, code: string): string {
  const m = code.match(/^(\d{5})(?:-(\d+))?$/)
  if (!m) return `${title}-${code}`
  const base = String(parseInt(m[1], 10))
  return m[2] ? `${title}-${base}.${m[2]}` : `${title}-${base}`
}

/**
 * Harvest section cites from a Title TOC, grouped by chapter heading. Returns a
 * map keyed by the chapter LABEL as printed ("4", "6.1", "20", "36", ...). Each
 * section docName is attributed to the most-recent "Chapter N" heading seen
 * before it in document order. De-dupes within a chapter.
 */
function harvestTocByChapter(html: string, title: string): Map<string, Cite[]> {
  interface Ev {
    pos: number
    kind: 'ch' | 'sec'
    val: string
  }
  const evs: Ev[] = []
  for (const m of html.matchAll(/Chapter\s+(\d+(?:\.\d+)?)\b/gi)) {
    evs.push({ pos: m.index!, kind: 'ch', val: m[1] })
  }
  const secRe = new RegExp(`ars/${title}/(\\d{5}(?:-\\d+)?)\\.htm`, 'gi')
  for (const m of html.matchAll(secRe)) {
    evs.push({ pos: m.index!, kind: 'sec', val: m[1] })
  }
  evs.sort((a, b) => a.pos - b.pos)

  const byChapter = new Map<string, Cite[]>()
  const seen = new Map<string, Set<string>>()
  let cur: string | null = null
  for (const e of evs) {
    if (e.kind === 'ch') {
      cur = e.val
      if (!byChapter.has(cur)) {
        byChapter.set(cur, [])
        seen.set(cur, new Set())
      }
    } else if (cur) {
      const s = seen.get(cur)!
      if (s.has(e.val)) continue
      s.add(e.val)
      byChapter.get(cur)!.push({ number: codeToNumber(title, e.val), title, code: e.val })
    }
  }
  return byChapter
}

/**
 * Parse a per-section ARS HTML page. catchline heading = the <PURPLE><u>...</u>
 * text; body = every <p> AFTER the heading paragraph, joined by newlines. The
 * heading <p> (the one carrying the GREEN section number) is excluded from the
 * body. Returns null for repealed/reserved/empty.
 */
function parseSectionPage(body: string, expectedNumber: string): Parsed | null {
  // Heading: <font color=GREEN>NUM</font>. <font color=PURPLE><u>Heading</u></font>
  const headM = body.match(
    /<font\s+color=GREEN>([^<]+)<\/font>[^<]*(?:<font\s+color=PURPLE>\s*<u>([\s\S]*?)<\/u>\s*<\/font>)?/i
  )
  if (!headM) return null

  let heading: string | null = headM[2]
    ? decodeEntities(headM[2].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim()
    : null
  if (heading && /^repealed\b/i.test(heading)) return null
  if (heading && /^\[?\s*reserved\.?\s*\]?$/i.test(heading)) return null

  // Body paragraphs: every <p>...</p>. The first <p> is the heading line (carries
  // the GREEN font); drop it and any leading <p> that has no real prose.
  const paras = [...body.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)].map((m) => m[1])
  const cleaned: string[] = []
  for (let i = 0; i < paras.length; i++) {
    const raw = paras[i]
    // Skip the heading paragraph (contains the GREEN/PURPLE font markup).
    if (/<font\s+color=(GREEN|PURPLE)/i.test(raw)) continue
    const txt = decodeEntities(raw.replace(/<[^>]+>/g, ' '))
      .replace(/[      ]/g, ' ')
      .replace(/[ \t]+/g, ' ')
      .trim()
    if (txt) cleaned.push(txt)
  }
  const text = cleaned.join('\n').trim()
  if (!text || text.length < 20) return null
  if (/^\[?\s*reserved\.?\s*\]?$/i.test(text)) return null
  if (/^repealed\b/i.test(text) && text.length < 60) return null

  return { number: expectedNumber, title: heading, text }
}

async function ingestCategory(category: string, cites: Cite[]): Promise<number> {
  let ok = 0
  let dropped = 0
  let http404 = 0
  const CONC = 4
  for (let i = 0; i < cites.length; i += CONC) {
    if (i > 0) await new Promise((r) => setTimeout(r, 200)) // politeness
    const batch = cites.slice(i, i + CONC)
    const results = batch.map((c) => {
      try {
        const { status, body } = curlStatus(secUrl(c.title, c.code))
        if (status !== 200) return { c, status, p: null as Parsed | null }
        return { c, status, p: parseSectionPage(body, c.number) }
      } catch (e: any) {
        console.warn(`  ! ${category} ${c.number}: ${e?.message || e}`)
        return { c, status: 0, p: null as Parsed | null }
      }
    })
    for (const { c, status, p } of results) {
      if (status !== 200) {
        http404++
        dropped++
        continue
      }
      if (!p || !p.text || p.text.length < 20) {
        dropped++
        continue
      }
      await query(
        `INSERT INTO state_law_section_texts
           (state_code, act_key, section_number, section_title, full_text,
            source_url, source_date, effective_year, law_category)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (state_code, act_key, section_number, effective_year) DO NOTHING`,
        [STATE, category, p.number, p.title, p.text, secUrl(c.title, c.code), SOURCE_DATE, EFFECTIVE_YEAR, category]
      )
      ok++
    }
    process.stdout.write(`\r  [${category}] ${Math.min(i + CONC, cites.length)}/${cites.length}`)
  }
  console.log(`\n  [${category}] inserted ${ok}, dropped ${dropped} (of which ${http404} non-200) of ${cites.length}`)
  return ok
}

/** Restrict a chapter's cites to an inclusive base-number range (used for T12). */
function inRange(cites: Cite[], lo: number, hi: number): Cite[] {
  return cites.filter((c) => {
    const m = c.number.match(/-(\d+)/)
    if (!m) return false
    const base = parseInt(m[1], 10)
    return base >= lo && base <= hi
  })
}

async function main() {
  console.log(`\n=== AZ — ingesting non-tax real-estate statute corpus (as of ${SOURCE_DATE}) ===`)

  // Fetch the three Title TOCs once.
  const toc33 = harvestTocByChapter(curlStatus(tocUrl('33')).body, '33')
  const toc32 = harvestTocByChapter(curlStatus(tocUrl('32')).body, '32')
  const toc12 = harvestTocByChapter(curlStatus(tocUrl('12')).body, '12')

  const ch33 = (n: string) => toc33.get(n) ?? []
  const ch32 = (n: string) => toc32.get(n) ?? []
  const ch12 = (n: string) => toc12.get(n) ?? []

  // Build category -> cite-list per the verified chapter map.
  const plan: Record<string, Cite[]> = {
    conveyancing_title: ch33('4'),
    condo_coop: [...ch33('9'), ...ch33('16')],
    broker_licensing: [...ch32('20'), ...ch32('36')],
    mortgage_lien_foreclosure: [...ch33('6'), ...ch33('6.1'), ...ch33('7')],
    general_real_property: [
      ...ch33('1'),
      ...ch33('2'),
      ...ch33('5'),
      ...inRange(ch12('5'), 521, 530), // adverse possession only
    ],
  }

  for (const [cat, cites] of Object.entries(plan)) {
    console.log(`${cat}: enumerated ${cites.length} candidate sections from TOC`)
  }

  const counts: Record<string, number> = {}
  for (const [cat, cites] of Object.entries(plan)) {
    counts[cat] = await ingestCategory(cat, cites)
  }

  const total = Object.values(counts).reduce((a, b) => a + b, 0)
  console.log(`\nAZ done. inserted=${total}`, counts)
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
