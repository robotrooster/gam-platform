/**
 * Illinois Property Tax Code full-text ingester (sanctioned retrieve+cite+date
 * carve-out — verbatim statute text, never advice).
 *
 * SOURCE (official only): Illinois General Assembly, ilga.gov.
 *   Act = 35 ILCS 200/ (Chapter 35 Revenue, Act 200 — Property Tax Code),
 *   ActID=596, ChapterID=8.
 *
 * FETCH PATH: the per-Act print/range view renders the full Act as HTML —
 *   GET .../legislation/ILCS/details?ActID=596&ChapterID=8
 *       &SeqStart=<n>&SeqEnd=<n>&Print=True
 *   Each SeqStart/SeqEnd window returns a contiguous block of sections. We
 *   request the five feature-chapter windows from the triage recipe. The legacy
 *   direct-section URLs (fulltext.asp?DocName=..., documents/*.htm) now 404 — we
 *   do NOT depend on them.
 *
 * PAGE LAYOUT: each section renders as a run of <code><font face="Courier New">
 *   fragments. A section opens with a citation marker "(35 ILCS 200/NN-NN)" then
 *   a catchline "Sec. NN-NN. <heading>" then body paragraphs, and closes with a
 *   provenance trailer "(Source: P.A. ... eff. ...)" — captured verbatim as the
 *   amendment/effective-date note the carve-out allows.
 *
 * PARSE: stripTags → readable text, then split on the anchor
 *   /\(35 ILCS 200\/(NUM)\)\s*\n+\s*Sec\.\s*\1\.\s*(heading)/ — the citation
 *   marker immediately followed by the matching "Sec. NUM." catchline. group 1 =
 *   section number (stored bare, e.g. "15-5"; the act_key 'property_tax' + state
 *   'IL' disambiguate). group 2 = heading. Body runs to the next anchor.
 *   Repealed / reserved / <20-char bodies dropped, as is TOC/nav/HTML chrome
 *   (which never matches the marker+catchline anchor).
 *
 * Idempotent: ON CONFLICT (state_code, act_key, section_number, effective_year)
 *   DO NOTHING. De-duped by section number across overlapping windows.
 *
 * Run: cd apps/api && node -r ts-node/register src/db/ingestILPropertyTax.ts
 */

import { execFileSync } from 'child_process'
import { query } from './index'
import { stripTags } from './ingestStateLawCorpus'

const STATE = 'IL'
const ACT_KEY = 'property_tax'
const LAW_CATEGORY = 'property_tax'
const SOURCE_DATE = '2026-06-14'
const EFFECTIVE_YEAR = 2026
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) GAM-statute-ingest/1.0 (compliance research)'

const winUrl = (start: number, end: number) =>
  `https://www.ilga.gov/legislation/ILCS/details?ActID=596&ChapterID=8&SeqStart=${start}&SeqEnd=${end}&Print=True`

// Five feature-chapter windows from the verified triage recipe.
interface Win {
  topic: string
  start: number
  end: number
}
const WINDOWS: Win[] = [
  { topic: 'exemptions', start: 38200000, end: 43500000 },
  { topic: 'assessment', start: 15200000, end: 17700000 },
  { topic: 'assessment_review', start: 44000000, end: 49100000 },
  { topic: 'levy_collection_payment', start: 60000000, end: 70000000 },
  { topic: 'delinquency_tax_sale', start: 70000000, end: 76000000 },
]

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
 * Tidy a verbatim section body: the ilga.gov source hard-wraps statutory prose
 * at a fixed Courier width, leaving single \n mid-sentence. Collapse single
 * newlines (and the marginal &nbsp; indents) to spaces so the prose reads as
 * written, but preserve blank-line paragraph breaks and force the (Source: ...)
 * provenance trailer onto its own line.
 */
function tidyBody(s: string): string {
  let out = s
    .replace(/\n{2,}/g, '\u0000') // protect paragraph breaks
    .replace(/\n/g, ' ') // join hard-wrapped lines
    .replace(/\u0000/g, '\n\n') // restore paragraph breaks
    .replace(/[ \t]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .trim()
  // (Source: ...) provenance trailer on its own line.
  out = out.replace(/\s*(\(Source:)/g, '\n\n$1')
  return out.replace(/\n{3,}/g, '\n\n').trim()
}

/**
 * Parse one fetched window into sections. Anchor = citation marker
 * "(35 ILCS 200/NUM)" directly followed by the matching "Sec. NUM." catchline.
 */
function parseWindow(html: string): Parsed[] {
  const text = stripTags(html, true)
  const anchor = /\(35 ILCS 200\/([0-9]+-[0-9]+[A-Za-z.]*?)\)\s*\n+\s*Sec\.\s*\1\.\s*([^\n]*)/g
  const matches: { num: string; heading: string; bodyStart: number }[] = []
  let m: RegExpExecArray | null
  while ((m = anchor.exec(text)) !== null) {
    matches.push({ num: m[1], heading: (m[2] || '').trim(), bodyStart: anchor.lastIndex })
  }
  const out: Parsed[] = []
  for (let i = 0; i < matches.length; i++) {
    const cur = matches[i]
    const end = i + 1 < matches.length ? matches[i + 1].bodyStart : text.length
    // Body excludes the next section's "(35 ILCS 200/...)" marker line if present;
    // bodyStart of the next match already begins after its Sec. catchline, so we
    // must trim back to just before its citation marker.
    let rest = text.slice(cur.bodyStart, end)
    const nextMarker = rest.search(/\(35 ILCS 200\/[0-9]+-[0-9]+[A-Za-z.]*\)\s*\n+\s*Sec\./)
    if (nextMarker !== -1) rest = rest.slice(0, nextMarker)

    // The "Sec. NUM." catchline line (cur.heading) sometimes carries the
    // heading AND the opening body sentence when the source omitted a <br>
    // after the heading. To never drop or mid-sentence-truncate statutory
    // prose, the VERBATIM full_text re-prepends the FULL catchline — including
    // the "Sec. NUM." citation lead — to the body, and section_title is derived
    // (not load-bearing) by truncating the catchline at its first sentence period.
    const headingLine = cur.heading.replace(/\s+$/, '')
    const body = tidyBody(`Sec. ${cur.num}. ${headingLine}` + '\n' + rest)

    // Repealed / reserved sections: catchline reads "Sec. NUM. (Repealed)."
    if (/^\(?repealed/i.test(headingLine)) continue
    if (/^\[?reserved\.?\]?$/i.test(headingLine)) continue

    // Derived title: first sentence of the catchline (statutory catchlines end
    // in a period). Fall back to the whole catchline if no period.
    let title: string | null = null
    if (headingLine) {
      const dot = headingLine.indexOf('. ')
      title = (dot !== -1 ? headingLine.slice(0, dot + 1) : headingLine).trim() || null
    }

    if (!body || body.length < 20) continue
    if (/^\(?repealed/i.test(body)) continue
    if (/^\[?reserved\.?\]?$/i.test(body)) continue

    out.push({ number: cur.num, title, text: body })
  }
  return out
}

async function main() {
  console.log(`\n=== IL — ingesting Property Tax Code (35 ILCS 200/) full text (as of ${SOURCE_DATE}) ===`)

  // Collect across all windows, de-dupe by section number (windows can overlap;
  // first occurrence wins).
  const seen = new Map<string, { p: Parsed; url: string }>()
  const perTopic: Record<string, number> = {}

  for (const w of WINDOWS) {
    const url = winUrl(w.start, w.end)
    let html = ''
    try {
      html = curl(url)
    } catch (e: any) {
      console.warn(`  ! [${w.topic}] fetch failed: ${e?.message || e}`)
      perTopic[w.topic] = 0
      continue
    }
    const parsed = parseWindow(html)
    let added = 0
    for (const p of parsed) {
      if (seen.has(p.number)) continue
      seen.set(p.number, { p, url })
      added++
    }
    perTopic[w.topic] = parsed.length
    console.log(`  [${w.topic}] parsed ${parsed.length} sections (${added} new) from ${url}`)
  }

  // Insert.
  let inserted = 0
  for (const { p, url } of seen.values()) {
    const res = await query<{ id: string }>(
      `INSERT INTO state_law_section_texts
         (state_code, act_key, section_number, section_title, full_text, source_url, source_date, effective_year, law_category)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (state_code, act_key, section_number, effective_year) DO NOTHING
       RETURNING id`,
      [STATE, ACT_KEY, p.number, p.title, p.text, url, SOURCE_DATE, EFFECTIVE_YEAR, LAW_CATEGORY]
    )
    if (res.length > 0) inserted++
  }

  console.log(`\nIL done. distinct sections parsed=${seen.size}, inserted=${inserted}`)
  console.log('  per-topic parsed counts:', perTopic)
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
