/**
 * Virginia property-tax statute full-text ingester (sanctioned retrieve+cite+date
 * carve-out — verbatim statutory text, never advice).
 *
 * SOURCE (official ONLY): law.lis.virginia.gov — the Virginia Legislative
 * Information System's official Code of Virginia. Static, server-rendered HTML
 * over plain HTTPS (HTTP 200, no JS/SPA), so a polite curl per page is enough.
 *
 * SCOPE — Code of Virginia, Title 58.1 (Taxation), Subtitle III (Local Taxes):
 *   - Chapter 32 (Real Property Tax) — assessment, exemptions, boards of
 *     equalization / administrative+judicial review, levy, lien, special
 *     use-value assessment, public disclosure. §§ 58.1-3200 .. 58.1-3389.
 *   - Chapter 39 (Enforcement, Collection, Refunds, Remedies and Review of
 *     Local Taxes) — collection by treasurers, billing/payment timing,
 *     penalties/interest, distress/suit/lien, sale of delinquent tax lands +
 *     redemption, correction of erroneous assessments. §§ 58.1-3900 .. 58.1-3995.
 *
 * The five recipe "feature groups" (exemptions, assessment, assessment_review,
 * levy_collection_payment, delinquency_tax_sale) all live inside these two
 * chapters; rather than slice by article range (fragile against repeals), we
 * crawl every section the official chapter TOC lists. Every row lands with
 * act_key='property_tax', law_category='property_tax'.
 *
 * PARSE (per recipe, verified against raw output):
 *   - Section list: scrape the chapter TOC anchors
 *     `<a href='/vacode/title58.1/chapterNN/section58.1-NNNN/'>§ 58.1-NNNN</a>`.
 *   - Number + title: the content heading is
 *     `<h2> <span id='vN'>§ 58.1-NNNN</span>. {Title}.</h2>`. The number is the
 *     span text; the title is the run after the closing </span> up to </h2>.
 *   - Body (VERBATIM): the statute prose + trailing history note live inside
 *     `<section class='body editable' ...> ... </section>` as <p> nodes. All
 *     nav chrome (HistoryNote sidenote, hidden inputs, sign-in, menus) sits
 *     OUTSIDE that section, so selecting only its inner HTML keeps chrome out.
 *   - DROP repealed/reserved/expired/empty (<20 chars) and any non-prose.
 *
 * Run: cd apps/api && node -r ts-node/register src/db/ingestVAPropertyTax.ts
 * Idempotent (ON CONFLICT DO NOTHING). Polite crawl-delay between requests.
 */

import { execFileSync } from 'child_process'
import { query } from './index'
import { stripTags } from './ingestStateLawCorpus'

const STATE = 'VA'
const ACT_KEY = 'property_tax'
const LAW_CATEGORY = 'property_tax'
const SOURCE_DATE = '2026-06-14'
const EFFECTIVE_YEAR = 2026
const UA = 'GAM-statute-ingest/1.0 (compliance research)'
const BASE = 'https://law.lis.virginia.gov'

const CHAPTERS = ['32', '39'] as const
const tocUrl = (ch: string) => `${BASE}/vacode/title58.1/chapter${ch}/`
const sectionUrl = (ch: string, slug: string) => `${BASE}/vacode/title58.1/chapter${ch}/${slug}/`

interface Parsed {
  number: string // e.g. "58.1-3201"
  title: string | null
  text: string
  url: string
}

function curl(url: string): string {
  const buf = execFileSync('curl', ['-sL', '--max-time', '60', '-A', UA, url], {
    maxBuffer: 256 * 1024 * 1024,
  })
  return buf.toString('utf-8')
}

/** Scrape the chapter TOC for its ordered, de-duped list of section slugs. */
function harvestToc(html: string, ch: string): string[] {
  const re = new RegExp(
    `href='/vacode/title58\\.1/chapter${ch}/(section58\\.1-[0-9]+)/'`,
    'gi'
  )
  const seen = new Set<string>()
  const out: string[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) {
    const slug = m[1]
    if (seen.has(slug)) continue
    seen.add(slug)
    out.push(slug)
  }
  // numeric sort by the 58.1-NNNN suffix
  out.sort(
    (a, b) =>
      Number(a.replace(/^section58\.1-/, '')) - Number(b.replace(/^section58\.1-/, ''))
  )
  return out
}

/**
 * Parse a section page. Heading: <h2> <span id='vN'>§ 58.1-NNNN</span>. Title.</h2>.
 * Body: inner HTML of <section class='body editable' ...>. Returns null for a
 * repealed/reserved/empty section.
 */
function parseSection(html: string, expectedSlug: string, url: string): Parsed | null {
  // --- heading: number + title ---
  const head = html.match(
    /<h2>\s*<span id='v\d+'>\s*§\s*([0-9.\-A-Za-z:]+)\s*<\/span>\.?\s*([\s\S]*?)<\/h2>/i
  )
  let number = expectedSlug.replace(/^section/, '') // fallback: "58.1-NNNN"
  let title: string | null = null
  if (head) {
    number = head[1].trim()
    title = stripTags(head[2], false).replace(/\.\s*$/, '').trim() || null
  }

  // --- body region ---
  const bodyMatch = html.match(/<section class='body editable'[^>]*>([\s\S]*?)<\/section>/i)
  if (!bodyMatch) return null

  // Keep only paragraph content; this strips the trailing hidden <input> chrome
  // that lives inside the section after the last </p>.
  const paras = [...bodyMatch[1].matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)]
    .map((m) => stripTags(m[1], true).trim())
    .filter(Boolean)
  const text = paras.join('\n').trim()

  // Drop repealed / reserved / expired / empty.
  if (!text || text.length < 20) return null
  if (/^(repealed|reserved|expired)\b/i.test(text)) return null
  if (title && /^\(?(repealed|reserved|expired)\b/i.test(title)) return null
  if (/^repealed\.?$/i.test(text)) return null

  return { number, title, text, url }
}

async function ingestChapter(ch: string): Promise<{ ok: number; skipped: number; total: number }> {
  const slugs = harvestToc(curl(tocUrl(ch)), ch)
  console.log(`chapter ${ch}: harvested ${slugs.length} section slugs`)
  let ok = 0
  let skipped = 0
  for (let i = 0; i < slugs.length; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, 250)) // polite crawl-delay
    const slug = slugs[i]
    const url = sectionUrl(ch, slug)
    let parsed: Parsed | null = null
    try {
      parsed = parseSection(curl(url), slug, url)
    } catch (e: any) {
      console.warn(`\n  ! ch${ch} ${slug}: ${e?.message || e}`)
    }
    if (!parsed) {
      skipped++
    } else {
      await query(
        `INSERT INTO state_law_section_texts
           (state_code, act_key, section_number, section_title, full_text, source_url, source_date, effective_year, law_category)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (state_code, act_key, section_number, effective_year) DO NOTHING`,
        [STATE, ACT_KEY, parsed.number, parsed.title, parsed.text, parsed.url, SOURCE_DATE, EFFECTIVE_YEAR, LAW_CATEGORY]
      )
      ok++
    }
    process.stdout.write(`\r  [ch${ch}] ${i + 1}/${slugs.length} (ok=${ok} skip=${skipped})`)
  }
  console.log(`\n  [ch${ch}] inserted ${ok}, skipped ${skipped} of ${slugs.length}`)
  return { ok, skipped, total: slugs.length }
}

async function main() {
  console.log(`\n=== VA — ingesting property-tax full-text corpus (as of ${SOURCE_DATE}) ===`)
  let totalOk = 0
  for (const ch of CHAPTERS) {
    const r = await ingestChapter(ch)
    totalOk += r.ok
  }
  console.log(`\nVA property_tax done. attempted-insert rows=${totalOk}`)
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
