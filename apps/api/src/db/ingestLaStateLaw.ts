/**
 * Louisiana statute full-text ingester (S453 corpus, tranche follow-up).
 *
 * LA's official site is legis.la.gov — an ASP.NET WebForms app. Each statute
 * lives at Law.aspx?d=<ID>; the d= IDs are OPAQUE and non-derivable from the
 * citation, so they MUST be harvested at run time. Two harvest paths, because
 * the TOC folders differ:
 *
 *   - Civil Code (folder=67) + Code of Civil Procedure (folder=68): a single
 *     curl of the folder page returns a fully-expanded FLAT table of every
 *     article as <tr><td><a href="Law.aspx?d=ID">CC 2668</a></td>
 *     <td><a ...>catchline</a></td></tr>. We parse the first-cell anchors
 *     ("CC NNNN" / "CCP NNNN") and keep only each act's article range.
 *   - Revised Statutes (folder=75) is only the top-level Titles index (no d=
 *     links), so for the lone RS L/T act — 9:3251-3261 security deposits — we
 *     resolve each two-part citation through the site's "View a Specific Law"
 *     form (LawSearch.aspx → btnViewLaw), which redirects straight to
 *     Law.aspx?d=ID. Driven headless (WebForms VIEWSTATE round-trip).
 *
 * Statute page layout (UTF-8): a run of <P class=A000x align=...> paragraphs.
 *   A0001 = PART/TITLE/CHAPTER header(s)   (skipped)
 *   A0002 = the catchline — RS starts "§3251.", CC/CCP start "Art. 2668."
 *   A0003 = body paragraphs; the LAST is a history note ("Acts 1972, No. 696…").
 * The page footer ("If you experience any technical difficulties … webmaster …
 * P.O. Box 94062 …") lives OUTSIDE the A000x paragraphs, so selecting only the
 * structured paragraphs keeps it out of full_text.
 *
 * ACT MAPPING (3 acts, no duplication):
 *   residential              = R.S. 9:3251-3261 (security deposits — only RS L/T act)
 *   general_landlord_tenant  = Civil Code "Lease" title, arts 2668-2729
 *   eviction                 = CCP arts 4701-4735 (Eviction of Tenants and Occupants)
 *
 * Run: cd apps/api && node -r ts-node/register src/db/ingestLaStateLaw.ts
 * Idempotent (ON CONFLICT DO NOTHING). Reuses stripTags/decodeEntities from the
 * corpus framework. Repealed/reserved/short (<20 char) bodies are dropped.
 */

import { execFileSync } from 'child_process'
import { query } from './index'
import { stripTags } from './ingestStateLawCorpus'

const STATE = 'LA'
const SOURCE_DATE = '2026-06-13'
const EFFECTIVE_YEAR = 2026
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) GAM-statute-ingest/1.0'
const BASE = 'https://www.legis.la.gov/legis'
const lawUrl = (d: string) => `${BASE}/Law.aspx?d=${d}`

// folder=67 Civil Code, folder=68 Code of Civil Procedure (flat-TOC harvest)
const TOC = {
  cc: `${BASE}/Laws_Toc.aspx?folder=67&level=Parent`,
  ccp: `${BASE}/Laws_Toc.aspx?folder=68&level=Parent`,
}

interface Cite { number: string; d: string }
interface Parsed { number: string; title: string | null; text: string }

function curl(url: string): string {
  const buf = execFileSync('curl', ['-sL', '--max-time', '60', '-A', UA, url], {
    maxBuffer: 256 * 1024 * 1024,
  })
  return buf.toString('utf-8')
}

/**
 * Harvest (number, d=ID) pairs from a flat Civil-Code / CCP TOC page. The
 * citation lives in the FIRST cell's anchor as "<PREFIX> NNNN(.NN)". Restrict
 * to [lo, hi] so we keep only the target act's article range. De-dupe by number
 * (each TOC row repeats the d= in both cells).
 */
function harvestToc(html: string, prefix: 'CC' | 'CCP', lo: number, hi: number): Cite[] {
  const re = new RegExp(`<a[^>]*href="(Law\\.aspx\\?d=(\\d+))"[^>]*>\\s*${prefix}\\s+([0-9]+(?:\\.[0-9]+)?)\\s*</a>`, 'gi')
  const seen = new Set<string>()
  const out: Cite[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) {
    const number = m[3]
    const n = parseFloat(number)
    if (!Number.isFinite(n) || n < lo || n > hi) continue
    if (seen.has(number)) continue
    seen.add(number)
    out.push({ number, d: m[2] })
  }
  out.sort((a, b) => parseFloat(a.number) - parseFloat(b.number))
  return out
}

/**
 * Parse a Law.aspx statute page. catchline = first A000[12] paragraph that
 * starts with § or Art.; body = every A000x paragraph after it (this is the
 * A0003 run incl. the trailing history note). Returns null for an unfound /
 * repealed page (no catchline or empty body).
 */
function parseLawPage(html: string, expectedNumber: string): Parsed | null {
  const paras = [...html.matchAll(/<P\s+class=A000[0-9][^>]*>([\s\S]*?)<\/P>/gi)].map((m) =>
    stripTags(m[1], true)
  )
  // Locate the catchline.
  let catchIdx = -1
  for (let i = 0; i < paras.length; i++) {
    if (/^(§|Art\.)/.test(paras[i].trim())) {
      catchIdx = i
      break
    }
  }
  if (catchIdx === -1) return null
  const catchline = paras[catchIdx].trim()

  // Title = catchline with the leading "§NNNN." / "Art. NNNN." citation stripped.
  let title: string | null = catchline
    .replace(/^§\s*[0-9A-Za-z.:-]+\.?\s*/, '')
    .replace(/^Art\.\s*[0-9A-Za-z.:-]+\.?\s*/, '')
    .trim()
  if (!title) title = null
  if (title && /^repealed\b/i.test(title)) return null
  if (title && /^\[?reserved\.?\]?$/i.test(title)) return null

  // Body = paragraphs after the catchline (history note kept as the source-note
  // trailer, which the spec allows). Drop any stray header lines that slipped in.
  const body = paras
    .slice(catchIdx + 1)
    .map((p) => p.trim())
    .filter(Boolean)
    .join('\n')
    .trim()

  if (!body || body.length < 20) return null
  if (/^\[?reserved\.?\]?$/i.test(body)) return null
  return { number: expectedNumber, title, text: body }
}

/** Resolve RS 9:<sec> to its d= ID via the headless "View a Specific Law" form. */
async function harvestRsViaForm(secs: number[]): Promise<Cite[]> {
  const { chromium } = require('playwright')
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ userAgent: UA })
  const out: Cite[] = []
  try {
    for (const sec of secs) {
      await page.goto(`${BASE}/LawSearch.aspx`, { waitUntil: 'networkidle', timeout: 60000 })
      await page.fill('#ctl00_ctl00_PageBody_PageContent_tbFirstNumber', '9')
      await page.fill('#ctl00_ctl00_PageBody_PageContent_tbSecondNumber', String(sec))
      await Promise.all([
        page.waitForLoadState('networkidle'),
        page.click('#ctl00_ctl00_PageBody_PageContent_btnViewLaw'),
      ])
      const m = page.url().match(/Law\.aspx\?d=(\d+)/i)
      if (m) out.push({ number: String(sec), d: m[1] })
    }
  } finally {
    await page.close()
    await browser.close()
  }
  return out
}

async function ingestAct(actKey: string, cites: Cite[]): Promise<number> {
  let ok = 0
  let skipped = 0
  const CONC = 3
  for (let i = 0; i < cites.length; i += CONC) {
    if (i > 0) await new Promise((r) => setTimeout(r, 300)) // politeness
    const batch = cites.slice(i, i + CONC)
    const parsed = await Promise.all(
      batch.map(async (c) => {
        try {
          return { p: parseLawPage(curl(lawUrl(c.d)), c.number), c }
        } catch (e: any) {
          console.warn(`  ! ${actKey} ${c.number} (d=${c.d}): ${e?.message || e}`)
          return { p: null, c }
        }
      })
    )
    for (const { p, c } of parsed) {
      if (!p || !p.text || p.text.length < 20) {
        skipped++
        continue
      }
      await query(
        `INSERT INTO state_law_section_texts
           (state_code, act_key, section_number, section_title, full_text, source_url, source_date, effective_year)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (state_code, act_key, section_number, effective_year) DO NOTHING`,
        [STATE, actKey, p.number, p.title, p.text, lawUrl(c.d), SOURCE_DATE, EFFECTIVE_YEAR]
      )
      ok++
    }
    process.stdout.write(`\r  [${actKey}] ${Math.min(i + CONC, cites.length)}/${cites.length}`)
  }
  console.log(`\n  [${actKey}] inserted ${ok}, skipped ${skipped} of ${cites.length}`)
  return ok
}

async function main() {
  console.log(`\n=== LA — ingesting full-text corpus (as of ${SOURCE_DATE}) ===`)

  // 1) Civil Code "Lease" title, arts 2668-2729 → general_landlord_tenant
  const ccCites = harvestToc(curl(TOC.cc), 'CC', 2668, 2729)
  console.log(`general_landlord_tenant: harvested ${ccCites.length} CC articles (2668-2729)`)

  // 2) CCP "Eviction of Tenants and Occupants", arts 4701-4735 → eviction
  const ccpCites = harvestToc(curl(TOC.ccp), 'CCP', 4701, 4735)
  console.log(`eviction: harvested ${ccpCites.length} CCP articles (4701-4735)`)

  // 3) RS 9:3251-3261 security deposits → residential (View-Law form harvest)
  const rsSecs = Array.from({ length: 3261 - 3251 + 1 }, (_, i) => 3251 + i)
  const rsCites = await harvestRsViaForm(rsSecs)
  console.log(`residential: resolved ${rsCites.length} RS sections (9:3251-3261)`)

  const counts: Record<string, number> = {}
  counts['general_landlord_tenant'] = await ingestAct('general_landlord_tenant', ccCites)
  counts['eviction'] = await ingestAct('eviction', ccpCites)
  counts['residential'] = await ingestAct('residential', rsCites)

  const total = Object.values(counts).reduce((a, b) => a + b, 0)
  console.log(`\nLA done. inserted=${total}`, counts)
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
