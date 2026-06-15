/**
 * Oregon property-tax statute full-text ingester (S472 corpus, property_tax
 * carve-out).
 *
 * Sanctioned retrieve+cite+date posture: we store the VERBATIM text of every
 * Oregon Revised Statutes (ORS) property-tax section so the agent can quote +
 * cite + date the actual law. GAM never advises — see services/stateLaw.ts +
 * the migration headers.
 *
 * SOURCE (official only): the Oregon State Legislature publishes the ORS as
 * per-chapter HTML at
 *     https://www.oregonlegislature.gov/bills_laws/ors/orsNNN.html
 * (NNN = chapter; 308A is the lone letter-suffixed chapter). Each page is one
 * full chapter, 2025 Edition. fetchability = raw_http → plain curl, no JS.
 *
 * PAGE LAYOUT (Word-exported HTML, windows-1252 encoded):
 *   - A leading TABLE OF CONTENTS: a run of <p class=MsoNormal> paragraphs whose
 *     span holds "NNN.NNN  catchline" as PLAIN text (no <b>). These have NO
 *     statutory body — skip them.
 *   - Then the BODY: each section starts with a <p class=MsoNormal> whose first
 *     child is a BOLD heading <b><span>NNN.NNN Catchline.</span></b>, immediately
 *     followed (same <p>) by the statutory prose in a plain <span>. Subsequent
 *     subsections — (1)/(a)/(A) hierarchy — live in following <p class=MsoNormal>
 *     paragraphs (NOT bold) until the next bold heading.
 *   - The trailing [Amended by 1973 c.305 §5; ...] history note is the section
 *     source note; kept as the trailer (the carve-out allows source notes).
 *
 * The section number appears TWICE (TOC link text + bold body heading). We key
 * ONLY on the BOLD occurrence — the TOC entries are never bold — so the TOC is
 * dropped automatically. Repealed sections get no body heading in the ORS HTML
 * (TOC-only), so they self-drop; a defensive repealed/reserved guard remains.
 *
 * Section numbers: \d{3}[A-Z]?\.\d{3}  (308A.050 etc. carry the letter suffix).
 *
 * ACT/CATEGORY: act_key='property_tax', law_category='property_tax',
 * source_date='2026-06-14', effective_year=2026. One act_key spanning all eight
 * property-tax chapters; section_number is globally unique within the chapter
 * series so no collisions.
 *
 * CHAPTERS (the five feature groups from triage + their named cross-refs):
 *   exemptions             → 307
 *   assessment             → 308, 306 (general), 308A (special/farm/forest)
 *   assessment_review      → 309
 *   levy_collection_payment→ 311, 310 (levy/extension)
 *   delinquency_tax_sale   → 312
 *
 * Run: cd apps/api && node -r ts-node/register src/db/ingestORPropertyTax.ts
 * Idempotent (ON CONFLICT DO NOTHING). Repealed/reserved/short (<20 char)
 * bodies are dropped.
 */

import { execFileSync } from 'child_process'
import iconv from 'iconv-lite'
import { query } from './index'
import { stripTags } from './ingestStateLawCorpus'

const STATE = 'OR'
const ACT_KEY = 'property_tax'
const LAW_CATEGORY = 'property_tax'
const SOURCE_DATE = '2026-06-14'
const EFFECTIVE_YEAR = 2026
const UA = 'GAM-statute-ingest/1.0 (compliance research)'

const CHAPTERS = ['306', '307', '308', '308A', '309', '310', '311', '312']
const chapterUrl = (ch: string) =>
  `https://www.oregonlegislature.gov/bills_laws/ors/ors${ch.toLowerCase()}.html`

interface Parsed {
  number: string
  title: string | null
  text: string
}

/** Fetch raw bytes + decode windows-1252 → UTF-8 (ORS pages are cp1252). */
function fetchChapter(ch: string): string {
  const buf = execFileSync('curl', ['-sL', '--max-time', '120', '-A', UA, chapterUrl(ch)], {
    maxBuffer: 256 * 1024 * 1024,
  })
  return iconv.decode(buf, 'windows-1252')
}

const SECNUM = /\d{3}[A-Z]?\.\d{3}/

/**
 * Parse one decoded chapter page into its body sections.
 *
 * Walk every <p class=MsoNormal>...</p> in document order. A paragraph that
 * contains a <b>...</b> whose stripped text begins with a section number STARTS
 * a new section (number + catchline from the bold run; remaining post-</b> text
 * is the first body chunk). Every following non-bold paragraph appends to the
 * current section's body until the next bold heading. Paragraphs before the
 * first bold heading (the TOC) are ignored.
 */
function parseChapter(html: string): Parsed[] {
  const out: Parsed[] = []
  let cur: { number: string; title: string | null; chunks: string[] } | null = null

  const flush = () => {
    if (!cur) return
    const body = cur.chunks.map((c) => c.trim()).filter(Boolean).join('\n').trim()
    const dropTitle = cur.title && /^\s*\(?\s*(repealed|reserved)\b/i.test(cur.title)
    const dropBody = /^\(?\s*(repealed|reserved)\.?\)?$/i.test(body)
    // Tombstone sections (repealed / renumbered / transferred) carry a bold
    // heading but no statutory text — the ORS HTML body is just a single
    // [Amended by ... ; repealed by ...] / [... renumbered NNN.NNN] history
    // note in brackets. They have no catchline (title is null). Drop them: a
    // verbatim-statute corpus holds live law, not pointers to where text moved.
    const dropTombstone = /^\[[\s\S]*\]$/.test(body)
    if (!dropTitle && !dropBody && !dropTombstone && body.length >= 20) {
      out.push({ number: cur.number, title: cur.title, text: body })
    }
    cur = null
  }

  const pRe = /<p\s+class=MsoNormal[^>]*>([\s\S]*?)<\/p>/gi
  let m: RegExpExecArray | null
  while ((m = pRe.exec(html)) !== null) {
    const inner = m[1]
    const boldMatch = inner.match(/<b>([\s\S]*?)<\/b>/i)

    if (boldMatch) {
      const boldText = stripTags(boldMatch[1], false) // catchline, single-spaced
      const num = boldText.match(SECNUM)
      if (num && boldText.trimStart().startsWith(num[0])) {
        // New section begins.
        flush()
        const number = num[0]
        // Catchline = bold text after the number, trailing period trimmed.
        let title: string | null = boldText
          .slice(boldText.indexOf(number) + number.length)
          .replace(/^[\s.]+/, '')
          .replace(/\.\s*$/, '')
          .trim()
        if (!title) title = null
        // First body chunk = the prose after </b> in the same paragraph.
        const afterBold = inner.slice(inner.toLowerCase().indexOf('</b>') + 4)
        const firstChunk = stripTags(afterBold, true)
        cur = { number, title, chunks: firstChunk ? [firstChunk] : [] }
        continue
      }
      // A bold run that's not a section heading (rare emphasis) — treat as body.
    }

    if (cur) {
      const chunk = stripTags(inner, true)
      if (chunk) cur.chunks.push(chunk)
    }
    // else: pre-first-heading TOC / chrome — ignored.
  }
  flush()
  return out
}

async function main() {
  console.log(`\n=== OR — ingesting property-tax full-text corpus (as of ${SOURCE_DATE}) ===`)

  let inserted = 0
  let parsedTotal = 0
  const perChapter: Record<string, { parsed: number; inserted: number }> = {}

  for (const ch of CHAPTERS) {
    let sections: Parsed[] = []
    try {
      const html = fetchChapter(ch)
      sections = parseChapter(html)
    } catch (e: any) {
      console.warn(`  ! chapter ${ch} FAILED: ${e?.message || e}`)
      perChapter[ch] = { parsed: 0, inserted: 0 }
      continue
    }
    parsedTotal += sections.length

    let ok = 0
    for (const s of sections) {
      const rows = await query<{ id: string }>(
        `INSERT INTO state_law_section_texts
           (state_code, act_key, section_number, section_title, full_text,
            source_url, source_date, effective_year, law_category)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (state_code, act_key, section_number, effective_year) DO NOTHING
         RETURNING id`,
        [
          STATE,
          ACT_KEY,
          s.number,
          s.title,
          s.text,
          chapterUrl(ch),
          SOURCE_DATE,
          EFFECTIVE_YEAR,
          LAW_CATEGORY,
        ]
      )
      ok += rows.length
    }
    inserted += ok
    perChapter[ch] = { parsed: sections.length, inserted: ok }
    console.log(`  [ch ${ch}] parsed ${sections.length}, inserted ${ok}`)
  }

  console.log(`\nOR done. parsed=${parsedTotal} inserted=${inserted}`)
  console.table(perChapter)
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
