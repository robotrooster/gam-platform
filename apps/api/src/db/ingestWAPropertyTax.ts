/**
 * Washington property-tax statute full-text ingester (state-law corpus,
 * property_tax carve-out).
 *
 * Sanctioned retrieve+cite+date carve-out: GAM stores the VERBATIM statutory
 * text and surfaces it with citation + source date + disclaimer — it never
 * advises. (Same posture as services/stateLaw.ts and the LA/AZ/NV ingesters.)
 *
 * SOURCE (official only): Revised Code of Washington (RCW), Title 84 — Property
 * Taxes, on the Washington State Legislature site app.leg.wa.gov. The site is
 * ASP.NET WebForms, fully server-rendered: the statute body is in the static
 * HTML, so plain curl works (no JS / Playwright needed). NO Justia / Lexis /
 * Wayback — official source only.
 *
 * Five feature-chapter groups, all written under act_key='property_tax',
 * law_category='property_tax':
 *   exemptions            — Ch 84.36 (+ 84.37, 84.38, 84.39)
 *   assessment            — Ch 84.40 (+ 84.41, 84.44)
 *   assessment_review     — Ch 84.48 (+ 84.08)
 *   levy_collection_payment — Ch 84.52, 84.56
 *   delinquency_tax_sale  — Ch 84.64, 84.60
 * Topics are provenance only; every row's act_key is 'property_tax'.
 *
 * RECIPE per chapter:
 *   (1) Fetch the chapter index (cite=84.XX); scrape the section-link anchors
 *       (cite=84.XX.YYY, excluding the &pdf=true variants) → ordered unique
 *       section list.
 *   (2) Fetch each section page (cite=84.XX.YYY) and extract:
 *         - citation from the <h1> inside div#ContentPlaceHolder1_pnlTitleBlock
 *           (text after '<!-- field: Citations -->', e.g. 'RCW 84.36.005') →
 *           section_number = '84.36.005' (RCW prefix stripped)
 *         - title (catchline) from the following <h2> (after
 *           '<!-- field: CaptionsTitles -->'); the WA catchlines use <span>—</span>
 *           em-dash separators which we normalize to ' — '
 *         - body from div#contentWrapper.section-page inner text, with two
 *           trims: (a) drop the leading '*** CHANGE IN YYYY *** (SEE …) ***'
 *           site banner if present; (b) cut at the first '[ YYYY c … ]'
 *           session-law history bracket — everything from there on is the
 *           history/source note + annotation trailer (effective-date / findings
 *           / severability / cross-reference notes), which the recipe excludes
 *           from the verbatim body.
 *   (3) Drop repealed / reserved / empty (<20 char) sections.
 *
 * INSERT (idempotent, ON CONFLICT DO NOTHING):
 *   state_code='WA', act_key='property_tax', law_category='property_tax',
 *   source_date='2026-06-14', effective_year=2026.
 *
 * Run: cd apps/api && node -r ts-node/register src/db/ingestWAPropertyTax.ts
 */

import { execFileSync } from 'child_process'
import { query } from './index'

const STATE = 'WA'
const ACT_KEY = 'property_tax'
const LAW_CATEGORY = 'property_tax'
const SOURCE_DATE = '2026-06-14'
const EFFECTIVE_YEAR = 2026
const UA = 'GAM-statute-ingest/1.0 (compliance research)'
const BASE = 'https://app.leg.wa.gov/RCW/default.aspx'

// Chapters to ingest, grouped by feature topic (provenance only — act_key is
// always 'property_tax'). One index fetch per chapter, then per-section fetches.
const CHAPTERS: { topic: string; chapter: string }[] = [
  // exemptions
  { topic: 'exemptions', chapter: '84.36' },
  { topic: 'exemptions', chapter: '84.37' },
  { topic: 'exemptions', chapter: '84.38' },
  { topic: 'exemptions', chapter: '84.39' },
  // assessment
  { topic: 'assessment', chapter: '84.40' },
  { topic: 'assessment', chapter: '84.41' },
  { topic: 'assessment', chapter: '84.44' },
  // assessment_review
  { topic: 'assessment_review', chapter: '84.48' },
  { topic: 'assessment_review', chapter: '84.08' },
  // levy / collection / payment
  { topic: 'levy_collection_payment', chapter: '84.52' },
  { topic: 'levy_collection_payment', chapter: '84.56' },
  // delinquency / tax sale
  { topic: 'delinquency_tax_sale', chapter: '84.64' },
  { topic: 'delinquency_tax_sale', chapter: '84.60' },
]

const indexUrl = (chapter: string) => `${BASE}?cite=${chapter}`
const sectionUrl = (chapter: string, sec: string) => `${BASE}?cite=${chapter}.${sec}`

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

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
}

function stripTags(html: string, keepBreaks = true): string {
  let s = html
  s = s.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
  if (keepBreaks) {
    s = s.replace(/<\/(p|div|li|tr|h[1-6]|section)>/gi, '\n').replace(/<br\s*\/?>/gi, '\n')
  }
  s = s.replace(/<[^>]+>/g, ' ')
  s = decodeEntities(s)
  s = s
    .replace(/[\xa0\u2000-\u200b\u2028\u2029\u202f\u205f\u3000]/g, ' ')
    .replace(/\r/g, '')
    .replace(/[ \t]+/g, ' ')
  s = keepBreaks ? s.replace(/ ?\n ?/g, '\n').replace(/\n{3,}/g, '\n\n') : s.replace(/\s+/g, ' ')
  return s.trim()
}

/**
 * Enumerate the section numbers (the 'YYY' in 84.XX.YYY) from a chapter index
 * page, in document order, de-duped. Excludes the '&pdf=true' anchor variants.
 */
function enumerateSections(indexHtml: string, chapter: string): string[] {
  const esc = chapter.replace('.', '\\.')
  const re = new RegExp(`cite=${esc}\\.(\\d+)(?:&amp;pdf=true)?"`, 'gi')
  const seen = new Set<string>()
  const out: string[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(indexHtml)) !== null) {
    const sec = m[1]
    if (seen.has(sec)) continue
    seen.add(sec)
    out.push(sec)
  }
  // numeric sort to ingest in citation order
  out.sort((a, b) => parseInt(a, 10) - parseInt(b, 10))
  return out
}

/**
 * Parse a single RCW section page. Returns null for repealed / reserved /
 * empty (<20 char) pages.
 */
function parseSectionPage(html: string, chapter: string, sec: string): Parsed | null {
  const number = `${chapter}.${sec}`

  // Title (catchline) from the <h2> after the CaptionsTitles field marker.
  const h2 = html.match(/<h2>\s*<!-- field: CaptionsTitles -->([\s\S]*?)<!-- field/i)
  let title: string | null = null
  if (h2) {
    // WA catchlines use <span>—</span> em-dash separators; normalize to ' — '.
    let t = h2[1].replace(/<span[^>]*>\s*—\s*<\/span>/gi, ' — ')
    t = stripTags(t, false)
      .replace(/\s*—\s*/g, ' — ')
      .replace(/\.\s*$/, '')
      .trim()
    title = t || null
  }
  if (title && /^repealed\b/i.test(title)) return null
  if (title && /^\[?\s*reserved\.?\s*\]?$/i.test(title)) return null

  // Body from div#contentWrapper (single-quoted id on this site).
  const startTag = html.search(/id=['"]contentWrapper['"]/i)
  if (startTag === -1) return null
  const afterOpen = html.indexOf('>', startTag) + 1
  // Body region ends at the related-rules sidebar panel.
  let end = html.indexOf('ContentPlaceHolder1_pnlExpanded', afterOpen)
  if (end === -1) end = html.length
  // Back up to the start of that panel's opening div.
  const panelDivStart = html.lastIndexOf('<div', end)
  const region = html.slice(afterOpen, panelDivStart > afterOpen ? panelDivStart : end)

  let body = stripTags(region, true)

  // (a) Drop leading site banner(s): '*** CHANGE IN YYYY *** (SEE …) ***'. The
  //     banner has TWO '***' fences (one after "CHANGE IN YYYY", one after the
  //     "(SEE …)" bill link) and a section may carry more than one stacked
  //     banner, so strip the whole '*** … (SEE …) ***' unit and loop.
  for (;;) {
    const stripped = body.replace(/^\*\*\*\s*CHANGE IN\b[\s\S]*?\(\s*SEE[\s\S]*?\)\s*\*\*\*\s*/i, '')
    if (stripped === body) break
    body = stripped.trim()
  }

  // (b) Cut at the first session-law history bracket '[ YYYY c … ]'. Everything
  //     from there on is the history/source-note + annotation trailer.
  const hist = body.search(/\[\s*\d{4}\b/)
  if (hist !== -1) body = body.slice(0, hist).trim()

  // Repealed bodies sometimes render as just "Repealed." or "[Repealed.]".
  if (/^\[?\s*repealed\b/i.test(body)) return null
  if (/^\[?\s*reserved\.?\s*\]?$/i.test(body)) return null
  if (!body || body.length < 20) return null

  return { number, title, text: body }
}

async function ingestChapter(chapter: string, topic: string): Promise<{ ok: number; skipped: number; total: number }> {
  let indexHtml: string
  try {
    indexHtml = curl(indexUrl(chapter))
  } catch (e: any) {
    console.warn(`  ! [${topic}] index ${chapter}: ${e?.message || e}`)
    return { ok: 0, skipped: 0, total: 0 }
  }
  const secs = enumerateSections(indexHtml, chapter)
  if (secs.length === 0) {
    console.warn(`  ! [${topic}] ${chapter}: 0 section links found on index page`)
    return { ok: 0, skipped: 0, total: 0 }
  }

  let ok = 0
  let skipped = 0
  const CONC = 4
  for (let i = 0; i < secs.length; i += CONC) {
    if (i > 0) await new Promise((r) => setTimeout(r, 250)) // politeness
    const batch = secs.slice(i, i + CONC)
    const parsed = await Promise.all(
      batch.map(async (sec) => {
        try {
          return { p: parseSectionPage(curl(sectionUrl(chapter, sec)), chapter, sec), sec }
        } catch (e: any) {
          console.warn(`  ! ${chapter}.${sec}: ${e?.message || e}`)
          return { p: null, sec }
        }
      })
    )
    for (const { p } of parsed) {
      if (!p) {
        skipped++
        continue
      }
      await query(
        `INSERT INTO state_law_section_texts
           (state_code, act_key, section_number, section_title, full_text, source_url, source_date, effective_year, law_category)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (state_code, act_key, section_number, effective_year) DO NOTHING`,
        [STATE, ACT_KEY, p.number, p.title, p.text, sectionUrl(chapter, p.number.split('.').pop()!), SOURCE_DATE, EFFECTIVE_YEAR, LAW_CATEGORY]
      )
      ok++
    }
    process.stdout.write(`\r  [${topic}] ${chapter}: ${Math.min(i + CONC, secs.length)}/${secs.length}`)
  }
  console.log(`\n  [${topic}] ${chapter}: inserted ${ok}, skipped ${skipped} of ${secs.length}`)
  return { ok, skipped, total: secs.length }
}

async function main() {
  console.log(`\n=== WA — ingesting property-tax full-text corpus (as of ${SOURCE_DATE}) ===`)
  const byTopic: Record<string, number> = {}
  let total = 0
  for (const { topic, chapter } of CHAPTERS) {
    const r = await ingestChapter(chapter, topic)
    byTopic[topic] = (byTopic[topic] || 0) + r.ok
    total += r.ok
  }
  console.log(`\nWA property_tax done. inserted=${total}`, byTopic)
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
