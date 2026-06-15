/**
 * Colorado real-estate statute full-text ingester (S472 corpus tranche).
 *
 * Sanctioned retrieve+cite+date carve-out: GAM stores the VERBATIM official
 * statute text, cites it, dates it, and disclaims — it never advises. Same
 * posture as the AZ/NV/LA corpus and services/stateLaw.ts.
 *
 * SOURCE — Colorado Revised Statutes 2025 official compilation, served by the
 * Office of Legislative Legal Services via olls.info per-title HTM mirrors that
 * 301-resolve to static leg.colorado.gov assets (raw HTTP 200, text/html, no
 * JS / no auth). Two titles:
 *   - Title 38 (Property - Real and Personal): crs2025-title-38.htm
 *   - Title 12 (Professions and Occupations): crs2025-title-12.htm  (broker /
 *     appraiser licensing lives here, NOT in Title 38).
 *
 * ENCODING — the docs are WordPerfect-exported HTML with NO charset meta and
 * Windows-1252 bytes (0xA7 = §, 0x97 = em dash, 0x96 = en dash, smart quotes).
 * We decode the raw bytes as windows-1252.
 *
 * SECTION MARKUP — every section begins:
 *   <P><SPAN STYLE="font-family: Public Sans"><STRONG>NN-NN-NNN.  Heading. </STRONG>body…
 * Anchor regex captures the section number + catchline; the body is the run of
 * text from the heading's </STRONG> until the NEXT section heading of the same
 * title. The per-section "Source:" history line (also wrapped in <STRONG>, so we
 * key the boundary on <STRONG>NN-… number patterns, never bare <STRONG>) is kept
 * as the citation trailer the spec allows. WordPerfect hard line-wraps (raw
 * CRLF inside a <P>) are collapsed to spaces; <P> closes become paragraph
 * breaks, so stored full_text reads as natural verbatim prose.
 *
 * CATEGORY → ARTICLE mapping (law_category === act_key per category):
 *   conveyancing_title        Title 38 Art. 30 (Titles & Interests) + Art. 35
 *                             (Conveyancing & Recording)
 *   condo_coop                Title 38 Art. 33 (Condominium Ownership Act),
 *                             Art. 33.3 (CCIOA), Art. 33.5 (Cooperative Housing)
 *   broker_licensing          Title 12 Art. 10 (Real Estate — brokers Parts 1-2,
 *                             appraisers Part 6, subdivision/timeshare parts)
 *   mortgage_lien_foreclosure Title 38 Art. 22 (Mechanics' Lien), Art. 37
 *                             (Public Trustee), Art. 38 (Foreclosure Sales),
 *                             Art. 39 (Mortgages, Deeds of Trust & Other Liens)
 *   general_real_property     Title 38 Art. 30.5 (Conservation Easements),
 *                             Art. 31 (Co-ownership), Art. 32 (Estates Above
 *                             Surface), Art. 36 (Torrens Title Registration),
 *                             Art. 41 (Limitations — Homestead Exemptions /
 *                             adverse possession)
 *
 * DEDUP — Art. 30 is listed in the recipe under both conveyancing_title and
 * general_real_property. It is assigned ONCE, to conveyancing_title (its primary
 * home alongside Art. 35), so no section is double-stored. general_real_property
 * keeps only its non-overlapping articles. The unique key is
 * (state_code, act_key, section_number, effective_year); act_key === category,
 * so cross-category section-number collisions are impossible by construction.
 *
 * Run: cd apps/api && node -r ts-node/register src/db/ingestCORealEstate.ts
 * Idempotent (ON CONFLICT DO NOTHING). Repealed/reserved/short(<20 char)/empty
 * bodies are dropped (this source already omits repealed headings; the guards
 * are defensive).
 */

import { execFileSync } from 'child_process'
import { query } from './index'

const STATE = 'CO'
const SOURCE_DATE = '2026-06-14'
const EFFECTIVE_YEAR = 2026
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) GAM-statute-ingest/1.0'

const TITLE_URL: Record<string, string> = {
  '38': 'https://olls.info/crs/crs2025-title-38.htm',
  '12': 'https://olls.info/crs/crs2025-title-12.htm',
}

interface Section {
  number: string // e.g. "38-35-101"
  article: string // e.g. "38-35", "38-33.3"
  title: string | null
  text: string
}

// ---------------------------------------------------------------------------
// Fetch + decode (raw HTTP, windows-1252)
// ---------------------------------------------------------------------------

function curlWin1252(url: string): string {
  const buf = execFileSync('curl', ['-sL', '--max-time', '120', '-A', UA, url], {
    maxBuffer: 256 * 1024 * 1024,
  })
  return new TextDecoder('windows-1252').decode(buf)
}

/** Strip tags → readable verbatim prose. Collapses WordPerfect hard line-wraps
 *  (raw CRLF inside a <P>) to spaces; <P>/<br> closes become paragraph breaks. */
function stripTags(html: string): string {
  let x = html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
  x = x.replace(/\r?\n/g, ' ') // collapse source hard-wraps
  x = x.replace(/<\/(p|div|li|tr|h[1-6]|section)>/gi, '\n').replace(/<br\s*\/?>/gi, '\n')
  x = x.replace(/<[^>]+>/g, ' ')
  x = x
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
  // unicode spaces (incl. NBSP / em-space / ideographic space) → ASCII space
  x = x.replace(/[  -   　]/g, ' ')
  x = x.replace(/[ \t]+/g, ' ').replace(/ ?\n ?/g, '\n').replace(/\n{3,}/g, '\n\n')
  return x.trim()
}

// ---------------------------------------------------------------------------
// Parse a whole title into a positional list of sections
// ---------------------------------------------------------------------------

/**
 * Parse every <STRONG>NN-…-NNN. Heading.</STRONG> section in `html` (optionally
 * restricted to byte window [lo, hi)). Body = text from the heading's </STRONG>
 * to the next section heading (or window end). `titlePrefix` is the leading
 * citation-title digits ("38" or "12") used to anchor the boundary regex so the
 * <STRONG>-wrapped "Source:" trailer never terminates a body.
 */
function parseTitle(html: string, titlePrefix: string, lo = 0, hi = html.length): Section[] {
  const headRe = new RegExp(
    `<STRONG>\\s*(${titlePrefix}-[0-9]+(?:\\.[0-9]+)?-[0-9.]+)\\.\\s+([^<]+?)\\.\\s*</STRONG>`,
    'g'
  )
  const heads: { number: string; article: string; titleRaw: string; start: number; hdrEnd: number }[] =
    []
  let m: RegExpExecArray | null
  while ((m = headRe.exec(html)) !== null) {
    if (m.index < lo || m.index >= hi) continue
    heads.push({
      number: m[1],
      article: m[1].replace(/-[0-9.]+$/, ''), // "38-35-101" -> "38-35"
      titleRaw: m[2].replace(/\s+/g, ' ').trim(),
      start: m.index,
      hdrEnd: headRe.lastIndex,
    })
  }

  const out: Section[] = []
  for (let i = 0; i < heads.length; i++) {
    const h = heads[i]
    const end = i + 1 < heads.length ? heads[i + 1].start : hi
    const text = stripTags(html.slice(h.hdrEnd, end))
    let title: string | null = h.titleRaw || null
    if (title && /^\(?repealed\b/i.test(title)) continue
    if (title && /^\(?reserved\.?\)?$/i.test(title)) continue
    const firstLine = (text.split('\n')[0] || '').trim()
    if (/^\(?repealed\b/i.test(firstLine)) continue
    if (/^\(?reserved\.?\)?$/i.test(firstLine)) continue
    if (!text || text.length < 20) continue
    out.push({ number: h.number, article: h.article, title, text })
  }
  return out
}

/** Restrict a Title-12 parse to the Article 10 byte window (brokers/appraisers).
 *  CO Title 12 jumps Article 10 → Article 15 (no Article 11), so we end at the
 *  next ARTICLE marker that is not 10. */
function article10Window(html: string): [number, number] {
  const startM = html.search(/<STRONG>\s*ARTICLE\s+10\b/i)
  if (startM < 0) throw new Error('Title 12: ARTICLE 10 marker not found')
  const after = html.slice(startM + 20)
  const nextRel = after.search(/<STRONG>\s*ARTICLE\s+(?!10\b)[0-9]/i)
  const end = nextRel < 0 ? html.length : startM + 20 + nextRel
  return [startM, end]
}

// ---------------------------------------------------------------------------
// Insert
// ---------------------------------------------------------------------------

async function insertSections(category: string, url: string, secs: Section[]): Promise<number> {
  let ok = 0
  for (const s of secs) {
    // RETURNING id makes a real insert yield one row and a conflict yield zero,
    // so we count true inserts (query() returns rows only, never a rowCount).
    const rows = await query<{ id: string }>(
      `INSERT INTO state_law_section_texts
         (state_code, act_key, section_number, section_title, full_text, source_url, source_date, effective_year, law_category)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (state_code, act_key, section_number, effective_year) DO NOTHING
       RETURNING id`,
      [STATE, category, s.number, s.title, s.text, url, SOURCE_DATE, EFFECTIVE_YEAR, category]
    )
    ok += rows.length
  }
  console.log(`  [${category}] parsed ${secs.length}, inserted ${ok}`)
  return ok
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log(`\n=== CO — ingesting real-estate statute corpus (as of ${SOURCE_DATE}) ===`)

  // Fetch each title ONCE.
  console.log('Fetching Title 38 (Property)…')
  const t38 = curlWin1252(TITLE_URL['38'])
  console.log(`  ${t38.length} chars`)
  console.log('Fetching Title 12 (Professions)…')
  const t12 = curlWin1252(TITLE_URL['12'])
  console.log(`  ${t12.length} chars`)

  // Parse Title 38 once, then bucket by article. Parse Title 12 Article-10 window.
  const t38Secs = parseTitle(t38, '38')
  const [a10lo, a10hi] = article10Window(t12)
  const t12Secs = parseTitle(t12, '12', a10lo, a10hi)

  const inArticles = (secs: Section[], arts: string[]) =>
    secs.filter((s) => arts.includes(s.article))

  // Category → article buckets (Title 38).
  const CONVEYANCING = ['38-30', '38-35']
  const CONDO = ['38-33', '38-33.3', '38-33.5']
  const FORECLOSURE = ['38-22', '38-37', '38-38', '38-39']
  const GENERAL = ['38-30.5', '38-31', '38-32', '38-36', '38-41']

  const counts: Record<string, number> = {}
  counts['conveyancing_title'] = await insertSections(
    'conveyancing_title',
    TITLE_URL['38'],
    inArticles(t38Secs, CONVEYANCING)
  )
  counts['condo_coop'] = await insertSections(
    'condo_coop',
    TITLE_URL['38'],
    inArticles(t38Secs, CONDO)
  )
  counts['broker_licensing'] = await insertSections(
    'broker_licensing',
    TITLE_URL['12'],
    t12Secs
  )
  counts['mortgage_lien_foreclosure'] = await insertSections(
    'mortgage_lien_foreclosure',
    TITLE_URL['38'],
    inArticles(t38Secs, FORECLOSURE)
  )
  counts['general_real_property'] = await insertSections(
    'general_real_property',
    TITLE_URL['38'],
    inArticles(t38Secs, GENERAL)
  )

  const total = Object.values(counts).reduce((a, b) => a + b, 0)
  console.log(`\nCO done. inserted=${total}`, counts)
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
