/**
 * North Carolina property-tax statute full-text ingester (state-law KB —
 * sanctioned retrieve+cite+date carve-out; verbatim statutory text only,
 * never advice).
 *
 * SOURCE: official ncleg.gov. NC General Statutes Chapter 105, Subchapter II
 * (the "Machinery Act", §§ 105-271 through 105-395). We ingest the property-tax
 * articles that map to GAM's five feature chapters. NO Justia/Lexis/Wayback.
 *
 * FETCH METHOD (raw_http -> curl): the per-ARTICLE HTML endpoint
 *   https://www.ncleg.gov/EnactedLegislation/Statutes/HTML/ByArticle/Chapter_105/Article_N.html
 * renders EVERY section in that article inline as server-side HTML (no JS).
 * One curl per article yields the whole article's statutory text. This is more
 * reliable than per-section round-trips and is how the section list is
 * authoritatively discovered (the triage recipe's article->section map had two
 * drift errors — §§105-285/286/287 are in Article 14 not 13, and the review
 * sections §§105-322/325 are in Article 21 not 26 — so we trust the live
 * article indexes, not the recipe).
 *
 * HTML LAYOUT (per section, within the article page):
 *   - Section catchline: a <span class="cs72F7C9C5"> (BOLD) paragraph whose text
 *     is "§ 105-XXX.  Catchline title." (sections may carry decimal/letter
 *     suffixes, e.g. 105-277.1F, 105-330.2, 105-365.1).
 *   - Body: the run of following non-bold <span> paragraphs up to the next
 *     bold catchline. Subsections are lettered "(a) Heading. -" / numbered "(1)"
 *     / lettered "a." — all inline in the body paragraphs.
 *   - History/credit parenthetical: an <a name="HistoryNote"> span trailing the
 *     last body paragraph (e.g. "(1971, c. 806, s. 1; ...)"). The schema has no
 *     separate amendment-history column, so — matching the LA ingester — the
 *     verbatim history note is retained as the source-note trailer of full_text.
 *     This keeps the stored text exactly as the official source renders it.
 *
 * TOPIC -> ARTICLE MAP (each section ingested exactly once; ON CONFLICT dedups):
 *   exemptions             = Art 12  (Property Subject to Taxation — exemptions/exclusions)
 *   assessment             = Arts 13,14,15,16,17,22,23  (appraisal/assessment standards,
 *                            reappraisal timing, Dept/PTC duties incl. §105-290 appeals,
 *                            county officials, listing administration, city/town assessing,
 *                            public service company property)
 *   assessment_review      = Arts 21,22A  (Review and Appeals of Listings & Valuations —
 *                            §105-322 Board of Equalization & Review, §105-325 special
 *                            meetings; Motor Vehicles incl. §105-330.2 classified MV appeals)
 *   levy_collection_payment / delinquency_tax_sale
 *                          = Art 26  (Collection and Foreclosure of Taxes — levy, lien
 *                            attachment/priority §§105-355/356, due date & interest §105-360,
 *                            advertisement §105-369, mortgage-style & in rem foreclosure
 *                            §§105-374/375, redemption/limitations §§105-376/378). The two
 *                            feature chapters share Article 26; ingested together, once.
 *
 * Run: cd apps/api && node -r ts-node/register src/db/ingestNCPropertyTax.ts
 * Idempotent (ON CONFLICT DO NOTHING). Repealed/reserved/short (<20 char)
 * bodies are dropped.
 */

import { execFileSync } from 'child_process'
import { query } from './index'

const STATE = 'NC'
const ACT_KEY = 'property_tax'
const LAW_CATEGORY = 'property_tax'
const SOURCE_DATE = '2026-06-14'
const EFFECTIVE_YEAR = 2026
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) GAM-statute-ingest/1.0'
const articleUrl = (art: string) =>
  `https://www.ncleg.gov/EnactedLegislation/Statutes/HTML/ByArticle/Chapter_105/Article_${art}.html`

// Feature chapter -> NC article numbers (see header for the verified mapping).
const TOPIC_ARTICLES: Record<string, string[]> = {
  exemptions: ['12'],
  assessment: ['13', '14', '15', '16', '17', '22', '23'],
  assessment_review: ['21', '22A'],
  levy_collection_payment: ['26'],
}

interface Section {
  number: string // e.g. "105-322" or "105-277.1F"
  title: string | null
  text: string // verbatim body incl. trailing history note
}

function curl(url: string): string {
  const buf = execFileSync('curl', ['-sL', '--max-time', '60', '-A', UA, url], {
    maxBuffer: 256 * 1024 * 1024,
  })
  return buf.toString('utf-8')
}

/** Decode the limited HTML entity set ncleg.gov emits. */
function decodeEntities(s: string): string {
  return s
    .replace(/&sect;/g, '§')
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&frac12;/g, '½')
    .replace(/&frac14;/g, '¼')
    .replace(/&frac34;/g, '¾')
    .replace(/&[a-zA-Z]+;/g, ' ')
}

/** Strip every tag, decode entities, collapse internal whitespace. */
function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim()
}

/**
 * Parse one article's HTML into its constituent sections. Walk the <p> blocks in
 * document order; a paragraph containing a bold (cs72F7C9C5) span that opens with
 * "§ 105-..." starts a new section (its bold span = catchline). All following
 * non-catchline paragraphs accumulate as that section's body until the next
 * catchline. The leading centered article-title paragraphs (before the first
 * catchline) are ignored.
 */
function parseArticle(html: string): Section[] {
  const body = html.slice(html.indexOf('<body>'))
  const paras = [...body.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)].map((m) => m[1])

  const sections: Section[] = []
  let cur: { number: string; title: string | null; parts: string[] } | null = null

  const catchRe = /^§\s*(105-[0-9]+(?:\.[0-9A-Za-z]+)*)\.\s*([\s\S]*)$/

  for (const p of paras) {
    const isBoldCatch = /class="cs72F7C9C5"/.test(p) && /&sect;\s*105-/.test(p)
    const plain = stripTags(p)
    if (isBoldCatch) {
      const m = plain.match(catchRe)
      if (m) {
        if (cur) sections.push(finalize(cur))
        let title: string | null = m[2].trim()
        if (!title) title = null
        cur = { number: m[1], title, parts: [] }
        continue
      }
    }
    if (cur && plain) cur.parts.push(plain)
  }
  if (cur) sections.push(finalize(cur))
  return sections
}

function finalize(cur: { number: string; title: string | null; parts: string[] }): Section {
  const text = cur.parts.join('\n').trim()
  return { number: cur.number, title: cur.title, text }
}

/** Drop repealed / reserved / empty / chrome-only sections. */
function keepSection(s: Section): boolean {
  if (!s.text || s.text.length < 20) return false
  const t = s.text.toLowerCase()
  const titleL = (s.title || '').toLowerCase()
  // Whole-section repeals/reserved: title says so AND body is just the repeal note.
  if (/^repealed\b/.test(titleL) || /^reserved\b/.test(titleL) || /^\[reserved/.test(titleL)) {
    if (s.text.length < 200) return false
  }
  if (/^repealed by /.test(t) && s.text.length < 200) return false
  if (/^\[reserved/.test(t) || /^reserved\.?$/.test(t)) return false
  return true
}

/**
 * NC publishes effective-date VARIANTS of a section under the same number, e.g.
 * §105-277.13 ships as both "(Effective for taxes ... before July 1, 2025) ..."
 * and "(Effective ... on or after July 1, 2025) ...". The unique constraint
 * stores one per (state, act, number, year), so when an article yields multiple
 * rows for the same number we keep the variant IN FORCE as of SOURCE_DATE:
 * prefer the latest "on or after DATE" whose DATE <= source date; otherwise the
 * variant with the latest parsed effective date; otherwise the first seen.
 */
function effectiveOnOrAfter(title: string | null): Date | null {
  if (!title) return null
  const m = title.match(/Effective[^)]*?on or after ([A-Za-z]+ \d{1,2},? \d{4})/i)
  if (!m) return null
  const d = new Date(m[1].replace(',', ''))
  return isNaN(d.getTime()) ? null : d
}

function dedupeVariants(sections: Section[]): Section[] {
  const byNumber = new Map<string, Section[]>()
  for (const s of sections) {
    const arr = byNumber.get(s.number) || []
    arr.push(s)
    byNumber.set(s.number, arr)
  }
  const cutoff = new Date(SOURCE_DATE)
  const out: Section[] = []
  // Preserve original order by walking the unique numbers in first-seen order.
  const seen = new Set<string>()
  for (const s of sections) {
    if (seen.has(s.number)) continue
    seen.add(s.number)
    const variants = byNumber.get(s.number)!
    if (variants.length === 1) {
      out.push(variants[0])
      continue
    }
    // Multiple variants: choose the one in force as of SOURCE_DATE.
    let best = variants[0]
    let bestDate = effectiveOnOrAfter(best.title)
    for (const v of variants.slice(1)) {
      const vd = effectiveOnOrAfter(v.title)
      // Prefer a variant whose "on or after" date is <= cutoff and latest such.
      const vInForce = vd != null && vd.getTime() <= cutoff.getTime()
      const bInForce = bestDate != null && bestDate.getTime() <= cutoff.getTime()
      if (vInForce && (!bInForce || (bestDate && vd!.getTime() > bestDate.getTime()))) {
        best = v
        bestDate = vd
      } else if (!vInForce && !bInForce && vd != null && (bestDate == null || vd.getTime() > bestDate.getTime())) {
        // Neither yet in force (future-dated); keep the soonest/latest dated.
        best = v
        bestDate = vd
      }
    }
    console.log(`  ~ ${best.number}: ${variants.length} effective-date variants; kept "${(best.title || '').slice(0, 70)}"`)
    out.push(best)
  }
  return out
}

async function main() {
  console.log(`\n=== NC — ingesting property-tax full-text corpus (as of ${SOURCE_DATE}) ===`)

  // Discover + parse every article once, then ingest. Track per-topic counts and
  // guard against a section appearing in two topic buckets (it should not, given
  // the disjoint article map, but the unique constraint enforces it regardless).
  const ingestedNumbers = new Set<string>()
  const counts: Record<string, number> = {}
  let totalInserted = 0
  let totalSkipped = 0
  const failures: string[] = []

  for (const [topic, articles] of Object.entries(TOPIC_ARTICLES)) {
    let topicInserted = 0
    for (const art of articles) {
      let html = ''
      try {
        html = curl(articleUrl(art))
      } catch (e: any) {
        const msg = `Article ${art} (${topic}): FETCH FAILED — ${e?.message || e}`
        console.warn('  ! ' + msg)
        failures.push(msg)
        continue
      }
      const sections = dedupeVariants(parseArticle(html))
      if (sections.length === 0) {
        const msg = `Article ${art} (${topic}): PARSED 0 SECTIONS`
        console.warn('  ! ' + msg)
        failures.push(msg)
        continue
      }
      let artOk = 0
      let artSkip = 0
      for (const s of sections) {
        if (!keepSection(s)) {
          artSkip++
          totalSkipped++
          continue
        }
        if (ingestedNumbers.has(s.number)) continue // never write a section twice
        ingestedNumbers.add(s.number)
        await query(
          `INSERT INTO state_law_section_texts
             (state_code, act_key, section_number, section_title, full_text,
              source_url, source_date, effective_year, law_category)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
           ON CONFLICT (state_code, act_key, section_number, effective_year) DO NOTHING`,
          [
            STATE,
            ACT_KEY,
            s.number,
            s.title,
            s.text,
            articleUrl(art),
            SOURCE_DATE,
            EFFECTIVE_YEAR,
            LAW_CATEGORY,
          ]
        )
        artOk++
        topicInserted++
        totalInserted++
      }
      console.log(`  [${topic}] Art ${art}: parsed ${sections.length}, inserted ${artOk}, skipped ${artSkip}`)
    }
    counts[topic] = topicInserted
  }

  console.log(`\nNC done. inserted=${totalInserted}, skipped=${totalSkipped}`, counts)
  if (failures.length) console.log('FAILURES:', failures)
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
