/**
 * Kentucky non-tax real-estate statute full-text ingester (sanctioned
 * retrieve+cite+date carve-out — verbatim statutory prose only, never advice).
 *
 * Source: Kentucky Legislative Research Commission — the OFFICIAL KRS site at
 * https://apps.legislature.ky.gov/law/statutes/  (.gov). No Justia/Lexis/Wayback.
 *
 * TWO-TIER OFFICIAL-SITE PATTERN (verified live 2026-06-14):
 *   TIER 1 (raw_http HTML TOC): GET chapter.aspx?id=NNNNN returns a static HTML
 *     table-of-contents. Each section is an anchor:
 *       <a class="statute" href="statute.aspx?id=NNNNN">.010  Catchline. </a>
 *     The anchor text leads with the section SUFFIX (".010") then the catchline.
 *     The chapter PREFIX (382, 381, 324, 324A, 376, 426) is implicit per TOC page.
 *     Repealed/renumbered/reserved rows carry "Repealed,"/"Renumbered,"/"Reserved"
 *     in the catchline -> filtered out at the TOC tier.
 *   TIER 2 (per-section PDF): each statute.aspx?id=NNNNN returns a generated
 *     application/pdf (NOT HTML) holding the single section. pdftotext -layout
 *     extracts it cleanly. Layout (verified):
 *       382.010 Estate -- Owner may convey -- When deed or will necessary.   <- line 1: number + catchline
 *       The owner may convey any interest in real property ...               <- body
 *               Effective: October 1, 1942                                   <- footer (kept as source-note)
 *               History: Recodified 1942 Ky. Acts ch. 208, sec. 1, ...
 *     A REPEALED PDF has catchline "Repealed, YYYY." and a body of only
 *     "Catchline at repeal: ..." + History -> dropped by the repealed-title check
 *     AND the statutory-body (<20 char) check as a belt-and-suspenders backstop.
 *
 * The PDF's own first-line number is the CANONICAL verbatim citation (full
 * "382.010" / "324A.010" form). full_text = the entire pdftotext output verbatim,
 * including the Effective/History footer (source-note trailer; consistent with
 * the KS/LA ingesters and the spec's history-allowed posture). Section number +
 * Effective line give the citation+date metadata GAM needs.
 *
 * CATEGORY -> CHAPTER/SUB-RANGE MAPPING (act_key == law_category == category key):
 *   conveyancing_title        ch382 (Conveyances and Encumbrances) — recording,
 *                             deeds, acknowledgments, release of lien.
 *   condo_coop                ch381 SUB-RANGES ONLY:
 *                               Kentucky Condominium Act  381.9101–381.9207
 *                               Horizontal Property Law    381.805–381.910
 *                               Planned Communities        381.785–381.803
 *                             (KY has no separate co-op real-estate act; co-op
 *                              ownership lives in this common-interest framework.)
 *   broker_licensing          ch324 (Real Estate Brokers & Sales Associates) +
 *                             ch324A (Real Property Appraisers) — separate chapter.
 *   mortgage_lien_foreclosure ch376 (Statutory Liens — mechanic's/materialman's) +
 *                             ch382 (mortgages/recording/lien release) +
 *                             ch426 (Enforcement of Judgments — judicial
 *                              foreclosure/execution sale; KY is judicial-only).
 *   general_real_property     ch381 EXCLUDING the three condo_coop sub-ranges
 *                             (estates in land, allodial title/escheat, future
 *                              estates, tenancy by entirety/survivorship, etc.).
 *
 * De-dup note: ch382 is harvested by BOTH conveyancing_title and
 * mortgage_lien_foreclosure (recording/lien-release sections are relevant to
 * both). They land as distinct act_key rows (different law_category), which the
 * unique constraint (state_code, act_key, section_number, effective_year) permits
 * — intentional cross-listing. Same for any overlap inside 381.
 *
 * Run: cd apps/api && node -r ts-node/register src/db/ingestKYRealEstate.ts
 * Idempotent (ON CONFLICT DO NOTHING). Official source only. Verbatim.
 */

import { execFileSync } from 'child_process'
import { writeFileSync, unlinkSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { query } from './index'

const STATE = 'KY'
const SOURCE_DATE = '2026-06-14'
const EFFECTIVE_YEAR = 2026
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) GAM-statute-ingest/1.0'
const ORIGIN = 'https://apps.legislature.ky.gov/law/statutes'

interface TocEntry {
  id: string // statute.aspx id
  suffix: string // section suffix from anchor text, e.g. ".010" or ".9105"
  catchline: string // anchor catchline (used only for repealed filtering)
}
interface Parsed {
  number: string
  title: string | null
  text: string
}

/** Fetch a URL as text (HTML). Returns { status, body }. Never throws on HTTP codes. */
function fetchText(url: string): { status: number; body: string } {
  const out = execFileSync(
    'curl',
    ['-sL', '--max-time', '60', '-A', UA, '-w', '\n__HTTP_STATUS__%{http_code}', url],
    { maxBuffer: 256 * 1024 * 1024 }
  ).toString('utf-8')
  const m = out.match(/\n__HTTP_STATUS__(\d+)$/)
  const status = m ? parseInt(m[1], 10) : 0
  const body = m ? out.slice(0, out.length - m[0].length) : out
  return { status, body }
}

/** Fetch a per-section PDF and return its pdftotext -layout output, or null. */
function fetchSectionText(id: string): string | null {
  const url = `${ORIGIN}/statute.aspx?id=${id}`
  let buf: Buffer
  try {
    buf = execFileSync('curl', ['-sL', '--max-time', '60', '-A', UA, url], {
      maxBuffer: 64 * 1024 * 1024,
    }) as Buffer
  } catch (e: any) {
    console.warn(`  ! fetch id=${id}: ${e?.message || e}`)
    return null
  }
  // Must be a PDF (starts with %PDF). HTML/empty means no section -> null.
  if (buf.length < 5 || buf.slice(0, 5).toString('latin1') !== '%PDF-') return null
  const tmp = join(tmpdir(), `ky_stat_${id}_${process.pid}.pdf`)
  try {
    writeFileSync(tmp, buf)
    const txt = execFileSync('pdftotext', ['-layout', tmp, '-'], {
      maxBuffer: 64 * 1024 * 1024,
    }).toString('utf-8')
    return txt
  } catch (e: any) {
    console.warn(`  ! pdftotext id=${id}: ${e?.message || e}`)
    return null
  } finally {
    try {
      unlinkSync(tmp)
    } catch {
      /* ignore */
    }
  }
}

/** Decode the handful of HTML entities that appear in KY catchlines. */
function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Enumerate a chapter TOC into TocEntry[]. Anchor form:
 *   <a class="statute" href="statute.aspx?id=NNNNN">.010  Catchline. </a>
 */
function enumerateToc(html: string): TocEntry[] {
  const re = /<a[^>]*href="statute\.aspx\?id=(\d+)"[^>]*>([\s\S]*?)<\/a>/gi
  const out: TocEntry[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) {
    const id = m[1]
    const txt = decodeEntities(m[2])
    // Leading token is the section suffix (".010", ".9105", ".115" etc.).
    const sm = txt.match(/^(\.\d+[A-Za-z]?)\s+([\s\S]*)$/)
    if (!sm) continue
    out.push({ id, suffix: sm[1], catchline: sm[2].trim() })
  }
  return out
}

/** TOC-level repealed/renumbered/reserved filter (cheap, before fetching PDF). */
function isDeadCatchline(catchline: string): boolean {
  return /^(repealed|renumbered|reserved|transferred)\b/i.test(catchline)
}

/**
 * Parse a section's pdftotext output. Line 1 = "<number>  <catchline>".
 * full_text = the entire verbatim PDF text (body + Effective/History footer).
 * Returns null for repealed/empty/non-statutory pages.
 */
function parseSection(txt: string): Parsed | null {
  const norm = txt.replace(/\r\n/g, '\n').replace(/\f/g, '\n').trim()
  if (!norm) return null
  const lines = norm.split('\n')
  // First non-empty line carries the number + catchline.
  let firstIdx = 0
  while (firstIdx < lines.length && !lines[firstIdx].trim()) firstIdx++
  if (firstIdx >= lines.length) return null
  const firstLine = lines[firstIdx].trim()

  // Number: "382.010", "324A.010", "381.9105". Letter chapter (324A) supported.
  const nm = firstLine.match(/^(\d{1,3}[A-Za-z]?\.\d+[A-Za-z]?)\s+(.*)$/)
  if (!nm) return null
  const number = nm[1].trim()
  let title: string | null = nm[2].trim() || null
  if (title) title = title.replace(/\.\s*$/, '').trim()
  if (!title) title = null

  // Repealed/renumbered/reserved title -> drop.
  if (title && /^(repealed|renumbered|reserved|transferred)\b/i.test(title)) return null

  // Statutory-body backstop: strip the leading number+catchline line, the
  // Effective/History footer, and any "Catchline at repeal:" stub. What remains
  // must be real statutory prose (>= 20 chars), else this is a repealed/empty stub.
  const afterFirst = lines.slice(firstIdx + 1).join('\n')
  const footerIdx = afterFirst.search(/^\s*(Effective:|History:)/m)
  const bodyOnly = (footerIdx === -1 ? afterFirst : afterFirst.slice(0, footerIdx))
    .replace(/^\s*Catchline at repeal:.*$/gim, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (bodyOnly.length < 20) return null

  // full_text = the entire verbatim PDF text (preserve layout/newlines).
  const fullText = norm
  return { number, title, text: fullText }
}

async function ingestCategory(cat: string, entries: TocEntry[]): Promise<number> {
  let ok = 0
  let dead = 0
  let skipped = 0
  // Pre-filter dead rows at the TOC tier to avoid pointless PDF fetches.
  const live = entries.filter((e) => {
    if (isDeadCatchline(e.catchline)) {
      dead++
      return false
    }
    return true
  })
  for (let i = 0; i < live.length; i++) {
    if (i > 0 && i % 5 === 0) await new Promise((r) => setTimeout(r, 200)) // politeness
    const e = live[i]
    const txt = fetchSectionText(e.id)
    if (!txt) {
      skipped++
      continue
    }
    const p = parseSection(txt)
    if (!p || p.text.length < 20) {
      skipped++
      continue
    }
    await query(
      `INSERT INTO state_law_section_texts
         (state_code, act_key, section_number, section_title, full_text, source_url, source_date, effective_year, law_category)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (state_code, act_key, section_number, effective_year) DO NOTHING`,
      [STATE, cat, p.number, p.title, p.text, `${ORIGIN}/statute.aspx?id=${e.id}`, SOURCE_DATE, EFFECTIVE_YEAR, cat]
    )
    ok++
    process.stdout.write(`\r  [${cat}] ${i + 1}/${live.length}`)
  }
  console.log(
    `\n  [${cat}] inserted ${ok}, dead(TOC) ${dead}, skipped ${skipped} of ${entries.length} TOC rows`
  )
  return ok
}

/** Parse a section suffix (".9105") to a comparable numeric key for range filtering. */
function suffixToNum(suffix: string): number {
  // ".9105" -> 9105 ; ".805" -> 805 ; ".115a" -> 115 (letter ignored for range).
  const m = suffix.match(/^\.(\d+)/)
  return m ? parseInt(m[1], 10) : NaN
}

/** Is a 381 section in one of the three condo/common-interest sub-ranges? */
function is381CondoRange(suffix: string): boolean {
  const n = suffixToNum(suffix)
  if (Number.isNaN(n)) return false
  // Planned Communities 381.785–381.803, Horizontal Property 381.805–381.910,
  // KY Condominium Act 381.9101–381.9207.
  return (n >= 785 && n <= 803) || (n >= 805 && n <= 910) || (n >= 9101 && n <= 9207)
}

async function main() {
  console.log(`\n=== KY — ingesting non-tax real-estate full-text corpus (as of ${SOURCE_DATE}) ===`)

  // Fetch the chapter TOCs once.
  const TOC = {
    ch382: '39156', // Conveyances and Encumbrances
    ch381: '39147', // Title to Property and Restrictions on Use, Ownership, and Alienation
    ch324: '38853', // Real Estate Brokers and Sales Associates
    ch324A: '38859', // Real Property Appraisers
    ch376: '39141', // Statutory Liens (mechanic's/materialman's)
    ch426: '39296', // Enforcement of Judgments (judicial foreclosure/execution sale)
  }
  const fetched: Record<string, TocEntry[]> = {}
  for (const [name, id] of Object.entries(TOC)) {
    const { status, body } = fetchText(`${ORIGIN}/chapter.aspx?id=${id}`)
    if (status !== 200) throw new Error(`TOC fetch failed: ${name} (id=${id}) HTTP ${status}`)
    fetched[name] = enumerateToc(body)
    console.log(`  TOC ${name} (id=${id}): ${fetched[name].length} section rows`)
  }

  // conveyancing_title: all of ch382.
  const conveyancing = fetched.ch382

  // condo_coop: only the three 381 sub-ranges.
  const condo = fetched.ch381.filter((e) => is381CondoRange(e.suffix))
  console.log(`  condo_coop: ${condo.length} of ${fetched.ch381.length} ch381 rows in sub-ranges`)

  // broker_licensing: ch324 + ch324A.
  const broker = [...fetched.ch324, ...fetched.ch324A]

  // mortgage_lien_foreclosure: ch376 + ch382 + ch426.
  const mortgage = [...fetched.ch376, ...fetched.ch382, ...fetched.ch426]

  // general_real_property: ch381 EXCLUDING the condo_coop sub-ranges.
  const general = fetched.ch381.filter((e) => !is381CondoRange(e.suffix))
  console.log(`  general_real_property: ${general.length} of ${fetched.ch381.length} ch381 rows (non-condo)`)

  const counts: Record<string, number> = {}
  counts['conveyancing_title'] = await ingestCategory('conveyancing_title', conveyancing)
  counts['condo_coop'] = await ingestCategory('condo_coop', condo)
  counts['broker_licensing'] = await ingestCategory('broker_licensing', broker)
  counts['mortgage_lien_foreclosure'] = await ingestCategory('mortgage_lien_foreclosure', mortgage)
  counts['general_real_property'] = await ingestCategory('general_real_property', general)

  const total = Object.values(counts).reduce((a, b) => a + b, 0)
  console.log(`\nKY done. inserted=${total}`, counts)
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
