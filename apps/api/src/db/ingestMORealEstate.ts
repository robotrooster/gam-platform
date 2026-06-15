/**
 * Missouri non-tax real-estate statute full-text ingester (sanctioned
 * retrieve+cite+date carve-out — verbatim official text, never advice).
 *
 * Source: Missouri Revised Statutes (RSMo), official Revisor of Statutes site
 * revisor.mo.gov. Plain HTTP, NOT JS-rendered — a browser-UA GET of
 *   OneSection.aspx?section=NNN.NNN  returns full HTML (HTTP 200, ~28-39KB).
 *
 * Page layout (single section page):
 *   <div class="norm" ...> wraps the live statute. Inside it, the statute body
 *     is one OR MORE sibling <p class="norm"> blocks (multi-subsection statutes
 *     put each numbered subsection / enumerated item in its own <p class="norm">
 *     — e.g. 516.110 "Within ten years:" + (1)..(N), or 429.010's subsections).
 *     The body run ends at the nested <div class="foot"> block, which holds
 *     RSMo source notes / cross-references / annotations in ITS OWN
 *     <p class="norm"> blocks. We therefore take EVERY <p class="norm"> BEFORE
 *     the <div class="foot"> boundary (and never after), so notes stay out of
 *     full_text while complete multi-paragraph bodies are preserved verbatim.
 *     The FIRST body paragraph's leading <span class="bold"> holds
 *     "NNN.NNN.<inner spacer span>Catch-line. — ", i.e. section number +
 *     catch-line; the body text immediately follows that bold span.
 *     Effective date lives in <span id="effdt">.
 *
 * Parse: remove the inner classless spacer <span> first (so the bold span has
 * no nesting), capture the bold span (number + catch-line) vs. the body after
 * it. Strip tags, normalize \xa0 /   / whitespace. A leading "*" on the
 * number (pending-revision marker) is stripped. Repealed / reserved / empty
 * (<20 char) bodies are dropped.
 *
 * Chapter enumeration: OneChapter.aspx?chapter=NNN (raw HTML) — extract every
 *   /section=([0-9]+\.[0-9A-Za-z-]+)/ whose chapter prefix == NNN (drops the
 *   stray "3.090" cross-reference link present on every chapter page).
 *
 * CATEGORY -> CHAPTER mapping (law_category == act_key per category):
 *   conveyancing_title        = Ch. 442 Titles and Conveyance of Real Estate
 *   condo_coop                = Ch. 448 Condominium Property (Unif. Condo Act)
 *   broker_licensing          = Ch. 339 Real Estate Agents/Brokers + Appraisers
 *   mortgage_lien_foreclosure = Ch. 443 Mortgages/Deeds of Trust + Ch. 429
 *                               Statutory Liens Against Real Estate (mechanic's)
 *   general_real_property     = Ch. 516 Statutes of Limitation (real actions /
 *                               adverse possession) + the two estates-in-land
 *                               sections 442.025 & 442.450 (recipe-sanctioned
 *                               DUAL-CATEGORY tag; they also land under
 *                               conveyancing_title). MO has no single "general
 *                               real property" chapter; the landlord/tenant
 *                               chapters 441 & 535 the recipe mentions are
 *                               ALREADY ingested under law_category
 *                               'landlord_tenant' (act_keys residential /
 *                               general_landlord_tenant) by a prior session, so
 *                               they are NOT re-ingested here to avoid duplicate
 *                               content across categories.
 *
 * MO has NO stand-alone cooperative / common-interest-community act — coop
 * governance lives inside Ch. 448 (condo) + general nonprofit/association law
 * (Ch. 355); see condo_coop note above.
 *
 * Run: cd apps/api && node -r ts-node/register src/db/ingestMORealEstate.ts
 * Idempotent (ON CONFLICT DO NOTHING on (state_code,act_key,section_number,
 * effective_year)).
 */

import { execFileSync } from 'child_process'
import { query } from './index'

const STATE = 'MO'
const SOURCE_DATE = '2026-06-14'
const EFFECTIVE_YEAR = 2026
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'
const BASE = 'https://revisor.mo.gov/main'
const sectionUrl = (s: string) => `${BASE}/OneSection.aspx?section=${s}`
const chapterUrl = (c: string) => `${BASE}/OneChapter.aspx?chapter=${c}`

interface Parsed {
  number: string
  title: string | null
  text: string
}

function curl(url: string): string {
  const buf = execFileSync('curl', ['-sL', '--max-time', '60', '-A', UA, url], {
    maxBuffer: 256 * 1024 * 1024,
  })
  return buf.toString('utf-8')
}

/** Strip HTML tags + decode the handful of entities the MO pages emit. */
function clean(html: string): string {
  let t = html.replace(/<[^>]+>/g, '')
  t = t
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&shy;|&#173;/g, '')
    .replace(/\u00ad/g, '') // raw soft hyphen (footnote-separator bleed)
    .replace(/ /g, ' ')
    .replace(/ /g, ' ')
  return t.replace(/\s+/g, ' ').trim()
}

/**
 * Enumerate the live section numbers of an RSMo chapter from its OneChapter
 * page. Keep only hrefs whose chapter prefix matches `chapter` (drops the
 * cross-reference "3.090" link present on every page). Sorted numerically.
 */
function harvestChapter(chapter: string): string[] {
  const html = curl(chapterUrl(chapter))
  const re = /section=([0-9]+\.[0-9A-Za-z-]+)/g
  const seen = new Set<string>()
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) {
    const s = m[1]
    if (s.split('.')[0] !== chapter) continue
    seen.add(s)
  }
  const out = [...seen]
  out.sort((a, b) => {
    const pa = a.split(/[.-]/).map((x) => (/^\d+$/.test(x) ? parseInt(x, 10) : 1e9))
    const pb = b.split(/[.-]/).map((x) => (/^\d+$/.test(x) ? parseInt(x, 10) : 1e9))
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const d = (pa[i] ?? -1) - (pb[i] ?? -1)
      if (d) return d
    }
    return a.localeCompare(b)
  })
  return out
}

/**
 * Parse a single OneSection page. Returns null for repealed / reserved /
 * empty / un-found pages.
 */
function parseSection(html: string, expected: string): Parsed | null {
  // Main statute container (NOT the nested <div class="foot"> note block).
  const dm = html.match(/<div class="norm"[^>]*>/i)
  if (!dm) return null
  let region = html.slice(dm.index! + dm[0].length)
  // The statute body run ends at the footnote block; truncate there so source
  // notes / cross-references / annotations never enter full_text.
  const footIdx = region.search(/<div class="foot"/i)
  if (footIdx >= 0) region = region.slice(0, footIdx)

  // Every <p class="norm"> in the body region (1 for simple sections, many for
  // multi-subsection statutes — each numbered subsection / enumerated item is
  // its own <p class="norm">).
  const paras = [...region.matchAll(/<p class="norm">([\s\S]*?)<\/p>/gi)].map((m) => m[1])
  if (!paras.length) return null

  // First paragraph carries the bold heading (number + catch-line). Drop the
  // inner classless spacer span so the bold span has no nesting.
  const para0 = paras[0].replace(/<span>\s*(?:&nbsp;| |\s)*\s*<\/span>/gi, '')
  const bm = para0.match(/<span class="bold">([\s\S]*?)<\/span>([\s\S]*)/i)
  if (!bm) return null

  const head = clean(bm[1])
  const firstBody = clean(bm[2])
  const restBody = paras.slice(1).map((p) => clean(p)).filter(Boolean)
  const body = [firstBody, ...restBody].filter(Boolean).join('\n').trim()

  // head = "*?NNN.NNN. Catch-line[. — | —]" — split number from catch-line.
  const hm = head.match(/^\*?\s*([0-9]+\.[0-9A-Za-z-]+)\.\s*([\s\S]*)$/)
  if (!hm) return null
  const number = hm[1]
  let title: string | null = hm[2]
    .replace(/\s*[—–-]\s*$/, '') // trailing dash that introduced the body
    .replace(/\.\s*$/, '')
    .trim()
  if (!title) title = null

  if (title && /^repealed\b/i.test(title)) return null
  if (title && /^\(?(transferred|renumbered)\b/i.test(title)) return null
  if (title && /^\[?reserved\.?\]?$/i.test(title)) return null

  if (!body || body.length < 20) return null
  if (/^\[?reserved\.?\]?$/i.test(body)) return null
  if (/^repealed\b/i.test(body)) return null

  return { number, title, text: body }
}

async function ingest(
  category: string,
  sections: string[]
): Promise<number> {
  let ok = 0
  let skipped = 0
  const CONC = 3
  for (let i = 0; i < sections.length; i += CONC) {
    if (i > 0) await new Promise((r) => setTimeout(r, 300)) // politeness
    const batch = sections.slice(i, i + CONC)
    const parsed = await Promise.all(
      batch.map(async (s) => {
        try {
          return { p: parseSection(curl(sectionUrl(s)), s), s }
        } catch (e: any) {
          console.warn(`  ! ${category} ${s}: ${e?.message || e}`)
          return { p: null, s }
        }
      })
    )
    for (const { p, s } of parsed) {
      if (!p || !p.text || p.text.length < 20) {
        skipped++
        continue
      }
      await query(
        `INSERT INTO state_law_section_texts
           (state_code, act_key, section_number, section_title, full_text,
            source_url, source_date, effective_year, law_category)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (state_code, act_key, section_number, effective_year) DO NOTHING`,
        [
          STATE,
          category,
          p.number,
          p.title,
          p.text,
          sectionUrl(s),
          SOURCE_DATE,
          EFFECTIVE_YEAR,
          category,
        ]
      )
      ok++
    }
    process.stdout.write(
      `\r  [${category}] ${Math.min(i + CONC, sections.length)}/${sections.length}`
    )
  }
  console.log(
    `\n  [${category}] inserted ${ok}, skipped ${skipped} of ${sections.length}`
  )
  return ok
}

async function main() {
  console.log(`\n=== MO — ingesting non-tax real-estate corpus (as of ${SOURCE_DATE}) ===`)

  // Enumerate each chapter's live sections.
  const ch442 = harvestChapter('442') // conveyancing_title
  const ch448 = harvestChapter('448') // condo_coop
  const ch339 = harvestChapter('339') // broker_licensing
  const ch443 = harvestChapter('443') // mortgage_lien_foreclosure (security/foreclosure)
  const ch429 = harvestChapter('429') // mortgage_lien_foreclosure (mechanic's liens)
  const ch516 = harvestChapter('516') // general_real_property (statutes of limitation)
  console.log(
    `harvested: 442=${ch442.length} 448=${ch448.length} 339=${ch339.length} ` +
      `443=${ch443.length} 429=${ch429.length} 516=${ch516.length}`
  )

  const counts: Record<string, number> = {}
  counts['conveyancing_title'] = await ingest('conveyancing_title', ch442)
  counts['condo_coop'] = await ingest('condo_coop', ch448)
  counts['broker_licensing'] = await ingest('broker_licensing', ch339)
  counts['mortgage_lien_foreclosure'] = await ingest(
    'mortgage_lien_foreclosure',
    [...ch443, ...ch429]
  )
  // general_real_property: Ch. 516 + the two dual-category estate sections.
  counts['general_real_property'] = await ingest('general_real_property', [
    ...ch516,
    '442.025',
    '442.450',
  ])

  const total = Object.values(counts).reduce((a, b) => a + b, 0)
  console.log(`\nMO done. inserted=${total}`, counts)
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
