/**
 * Montana real-estate statute full-text ingester (sanctioned retrieve+cite+date
 * carve-out — verbatim statute text only, never advice).
 *
 * Montana's official code (Montana Code Annotated) is published by the
 * Legislature at https://mca.legmt.gov as ONE STATIC HTML FILE PER SECTION.
 * The platform is a pure static-HTML tree:
 *
 *   title_TTTT/chapters_index.html
 *   title_TTTT/chapter_CCCC/parts_index.html
 *   title_TTTT/chapter_CCCC/part_PPPP/sections_index.html
 *   title_TTTT/chapter_CCCC/part_PPPP/section_SSSS/TTTT-CCCC-PPPP-SSSS.html
 *
 * (TTTT/CCCC/PPPP/SSSS are 4-digit zero-padded.) A raw_http GET with a normal
 * browser User-Agent returns HTTP 200 with the full statute text in-body. The
 * APM_DO_NOT_TOUCH obfuscated <head> JS block is anti-bot/analytics noise and
 * does NOT gate the static content — we never execute it; we just parse the
 * static markup that ships in the same response.
 *
 * ENUMERATION (fully data-driven, no hardcoded part/section lists):
 *   1. fetch chapter_CCCC/parts_index.html      -> discover part_PPPP dirs
 *   2. fetch part_PPPP/sections_index.html       -> per-section anchors carrying
 *                                                   the relative section-file URL,
 *                                                   the citation number, and the
 *                                                   catchline title
 *   3. fetch the section file                     -> verbatim body text
 *
 * SELECTORS (confirmed against live markup 2026-06-14):
 *   sections_index anchor:  <li class="line"><a href="./section_SSSS/FILE.html">
 *                             <span class="citation">70-21-301</span>&nbsp;Title</a>
 *   section number:         first  <span class="catchline"><span class="citation">N</span>
 *   section title:          breadcrumb  <li class="active"><span title="N Title">
 *                           (falls back to the sections_index catchline)
 *   body:                   div.section-content  ->  p.line-indent  (1+ paragraphs)
 *   history:                div.history-content p  (NOT ingested into full_text;
 *                           kept out so the verbatim body is statute text only)
 *
 * DROP rules: repealed / reserved / renumbered / terminated stub sections
 * (detected from the catchline title), and any body shorter than 20 chars or
 * that fails to parse (TOC fragments, empty shells).
 *
 * CATEGORY -> TITLE/CHAPTER MAP (act_key == law_category == the category key):
 *   conveyancing_title         Title 70 Ch. 20 (Transfer of Real Property),
 *                              Ch. 21 (Recording Transfers)
 *   condo_coop                 Title 70 Ch. 23 (Unit Ownership Act / condos)
 *   broker_licensing           Title 37 Ch. 51 (Real Estate Brokers/Salespersons)
 *   mortgage_lien_foreclosure  Title 71 Ch. 1 (Mortgages, incl. Small Tract
 *                              Financing non-judicial trust-indenture sale),
 *                              Ch. 3 (construction/mechanic's & other liens)
 *   general_real_property      Title 70 Chs. 15-19 (Estates; Rights & Obligations
 *                              Incidental to Ownership; Servitudes/Easements;
 *                              Accession/Fixtures/Watercourses; RP Actions,
 *                              Limitations & Adverse Possession)
 *
 * Montana did NOT adopt UCIOA — condos live under the 1965 Unit Ownership Act
 * (Ch. 23); there is no separate residential cooperative CIC statute, so
 * condo_coop maps cleanly to Ch. 23 only. Landlord-tenant (Ch. 24/25/26/33) is
 * a separate category already ingested and is intentionally excluded here.
 *
 * Run: cd apps/api && node -r ts-node/register src/db/ingestMTRealEstate.ts
 * Idempotent (ON CONFLICT DO NOTHING).
 */

import { query } from './index'

const STATE = 'MT'
const SOURCE_DATE = '2026-06-14'
const EFFECTIVE_YEAR = 2026
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'
const ROOT = 'https://mca.legmt.gov/bills/mca'

interface Chapter {
  title: string // 4-digit, e.g. '0700'
  chapter: string // 4-digit, e.g. '0210'
  category: string // act_key == law_category
  label: string // human label for logs
}

const CHAPTERS: Chapter[] = [
  // conveyancing_title
  { title: '0700', chapter: '0200', category: 'conveyancing_title', label: 'T70 Ch20 Transfer of Real Property' },
  { title: '0700', chapter: '0210', category: 'conveyancing_title', label: 'T70 Ch21 Recording Transfers' },
  // condo_coop
  { title: '0700', chapter: '0230', category: 'condo_coop', label: 'T70 Ch23 Unit Ownership Act (Condos)' },
  // broker_licensing
  { title: '0370', chapter: '0510', category: 'broker_licensing', label: 'T37 Ch51 Real Estate Brokers/Salespersons' },
  // mortgage_lien_foreclosure
  { title: '0710', chapter: '0010', category: 'mortgage_lien_foreclosure', label: 'T71 Ch1 Mortgages (incl. Small Tract Financing)' },
  { title: '0710', chapter: '0030', category: 'mortgage_lien_foreclosure', label: 'T71 Ch3 Liens (mechanic/construction)' },
  // general_real_property — Title 70 Chs 15-19
  { title: '0700', chapter: '0150', category: 'general_real_property', label: 'T70 Ch15 Estates in Real Property' },
  { title: '0700', chapter: '0160', category: 'general_real_property', label: 'T70 Ch16 Rights & Obligations Incidental to Ownership' },
  { title: '0700', chapter: '0170', category: 'general_real_property', label: 'T70 Ch17 Servitudes/Easements/Covenants' },
  { title: '0700', chapter: '0180', category: 'general_real_property', label: 'T70 Ch18 Accession/Fixtures/Watercourses' },
  { title: '0700', chapter: '0190', category: 'general_real_property', label: 'T70 Ch19 RP Actions, Limitations & Adverse Possession' },
]

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html' } })
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`)
  return res.text()
}

// Decode the handful of HTML entities the MCA platform actually emits, then
// collapse runs of whitespace. Entities seen: &#8195; (em-space), &nbsp;,
// &amp; &lt; &gt; &quot; &#39; &mdash; etc.
function decodeEntities(s: string): string {
  return s
    .replace(/&#8195;/g, ' ')
    .replace(/&#8194;/g, ' ')
    .replace(/&#8211;/g, '–')
    .replace(/&#8212;/g, '—')
    .replace(/&#8217;/g, '’')
    .replace(/&#8216;/g, '‘')
    .replace(/&#8220;/g, '“')
    .replace(/&#8221;/g, '”')
    .replace(/&nbsp;/g, ' ')
    .replace(/&mdash;/g, '—')
    .replace(/&ndash;/g, '–')
    .replace(/&rsquo;/g, '’')
    .replace(/&lsquo;/g, '‘')
    .replace(/&ldquo;/g, '“')
    .replace(/&rdquo;/g, '”')
    .replace(/&sect;/g, '§')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
}

function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, '')
}

function clean(html: string): string {
  return decodeEntities(stripTags(html)).replace(/\s+/g, ' ').trim()
}

const REPEALED_RE = /\b(repealed|reserved|renumbered|terminated|expired|omitted)\b/i

interface IndexEntry {
  url: string // absolute section-file URL
  number: string // e.g. '70-21-301'
  title: string // catchline title from the index anchor (may be empty)
}

// Pull part_PPPP dir names from a chapter's parts_index.html
function parsePartDirs(html: string): string[] {
  const dirs = new Set<string>()
  const re = /href="\.\/(part_\d+)\/sections_index\.html"/g
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) dirs.add(m[1])
  return [...dirs]
}

// Pull per-section anchors from a part's sections_index.html.
// Anchor shape: <a href="./section_SSSS/FILE.html"><span class="citation">N</span>&nbsp;Title</a>
function parseSectionIndex(html: string, partUrlBase: string): IndexEntry[] {
  const out: IndexEntry[] = []
  const re =
    /<a\s+href="(\.\/section_\d+\/[^"]+\.html)"\s*>\s*<span class="citation">([^<]+)<\/span>([\s\S]*?)<\/a>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) {
    const rel = m[1].replace(/^\.\//, '')
    const number = decodeEntities(m[2]).trim()
    const title = clean(m[3])
    out.push({ url: `${partUrlBase}/${rel}`, number, title })
  }
  return out
}

interface ParsedSection {
  number: string
  title: string
  text: string
}

// Extract verbatim body + number + title from a single section file.
function parseSectionFile(html: string, fallbackNumber: string, fallbackTitle: string): ParsedSection | null {
  // Number: first citation inside a catchline.
  const numM = html.match(/<span class="catchline">\s*<span class="citation">([^<]+)<\/span>/)
  const number = numM ? decodeEntities(numM[1]).trim() : fallbackNumber

  // Title: prefer the breadcrumb active span's title attr ("70-21-301 Conveyance defined"),
  // strip the leading citation number; else fall back to the index catchline title.
  let title = fallbackTitle
  const crumbM = html.match(/<li class="active">\s*<span title="([^"]+)"/)
  if (crumbM) {
    let t = decodeEntities(crumbM[1]).trim()
    // drop a leading "70-21-301 " citation prefix if present
    const pref = number ? new RegExp('^' + number.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s+') : null
    if (pref) t = t.replace(pref, '')
    if (t) title = t
  }

  // Body: all p.line-indent inside the FIRST div.section-content block.
  const scM = html.match(/<div class="section-content">([\s\S]*?)<\/div>\s*<\/div>/)
  const scope = scM ? scM[1] : html
  const paras: string[] = []
  const pRe = /<p class="line-indent">([\s\S]*?)<\/p>/g
  let pm: RegExpExecArray | null
  while ((pm = pRe.exec(scope)) !== null) {
    // Within the first paragraph the catchline span ("70-21-301. Conveyance
    // defined.") prefixes the body. Keep it verbatim — it is part of the
    // statute line as published. Just strip tags + decode.
    const txt = clean(pm[1])
    if (txt) paras.push(txt)
  }
  const text = paras.join('\n\n').trim()
  if (!number || !text || text.length < 20) return null
  return { number, title, text }
}

async function ingestChapter(ch: Chapter): Promise<{ ins: number; skip: number; parsed: number }> {
  const chapterUrl = `${ROOT}/title_${ch.title}/chapter_${ch.chapter}`
  let partsHtml: string
  try {
    partsHtml = await fetchText(`${chapterUrl}/parts_index.html`)
  } catch (e) {
    console.warn(`  [${ch.category}] ${ch.label}: parts_index FAILED — ${(e as Error).message}`)
    return { ins: 0, skip: 0, parsed: 0 }
  }
  const partDirs = parsePartDirs(partsHtml)

  // Collect every section index entry across all parts.
  const entries: IndexEntry[] = []
  for (const partDir of partDirs) {
    const partBase = `${chapterUrl}/${partDir}`
    let secHtml: string
    try {
      secHtml = await fetchText(`${partBase}/sections_index.html`)
    } catch (e) {
      console.warn(`    ${ch.label} ${partDir}: sections_index FAILED — ${(e as Error).message}`)
      continue
    }
    entries.push(...parseSectionIndex(secHtml, partBase))
  }

  let ins = 0
  let skip = 0
  let parsed = 0
  for (const e of entries) {
    // Drop repealed / reserved / renumbered / terminated by the index title.
    if (REPEALED_RE.test(e.title)) {
      skip++
      continue
    }
    let secHtml: string
    try {
      secHtml = await fetchText(e.url)
    } catch (err) {
      console.warn(`    fetch FAILED ${e.number} — ${(err as Error).message}`)
      skip++
      continue
    }
    const ps = parseSectionFile(secHtml, e.number, e.title)
    if (!ps) {
      skip++
      continue
    }
    // Second-pass repealed guard against the parsed title (some index titles are
    // terse; the body/title in the file is authoritative).
    if (REPEALED_RE.test(ps.title) && ps.text.length < 60) {
      skip++
      continue
    }
    parsed++
    const r = await query<{ id: string }>(
      `INSERT INTO state_law_section_texts
         (state_code, act_key, section_number, section_title, full_text, source_url, source_date, effective_year, law_category)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (state_code, act_key, section_number, effective_year) DO NOTHING
       RETURNING id`,
      [STATE, ch.category, ps.number, ps.title, ps.text, e.url, SOURCE_DATE, EFFECTIVE_YEAR, ch.category]
    )
    if (r.length > 0) ins++
    else skip++
  }
  console.log(`  [${ch.category}] ${ch.label}: parts ${partDirs.length}, index ${entries.length}, parsed ${parsed}, inserted ${ins}, skipped ${skip}`)
  return { ins, skip, parsed }
}

async function main() {
  console.log(`\n=== MT — ingesting real-estate statute corpus (as of ${SOURCE_DATE}) ===`)
  const counts: Record<string, number> = {}
  for (const ch of CHAPTERS) {
    const { ins } = await ingestChapter(ch)
    counts[ch.category] = (counts[ch.category] || 0) + ins
  }
  const total = Object.values(counts).reduce((a, b) => a + b, 0)
  console.log(`\nMT done. inserted=${total}`, counts)
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
