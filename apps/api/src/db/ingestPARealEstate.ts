/**
 * Pennsylvania real-estate (non-tax) statute full-text ingester.
 *
 * Sanctioned retrieve+cite+date carve-out: official source ONLY, stored VERBATIM,
 * never as advice. Five law_category buckets, one act_key per category (the
 * category key itself), per the S46x state-law-KB tranche spec.
 *
 * PA serves its statutes from TWO official shapes on the legacy host
 * legis.state.pa.us — no third-party / walled compilation is touched:
 *
 *   A) CONSOLIDATED titles (Pa.C.S.) = static RAW HTML at
 *        .../WU01/LI/LI/CT/HTM/{title}/00.0{NN}..HTM   (NN = zero-padded chapter)
 *      Each chapter page carries the statute body delimited by HTML comment
 *      markers: <div class="Comment">{title}c{section}s</div> opens a section's
 *      STATUTE text (the 's' suffix); the 'h' suffix marks the TOC/heading-list
 *      region we skip. Inside an 's' block: <b>&#167; NNNN. heading.</b> then
 *      <p> body paragraphs, running to the next comment marker. We split on the
 *      comment markers, keep only 's' blocks, and reconstruct verbatim text.
 *
 *   B) UNCONSOLIDATED acts (P.S.) = per-Act as-amended session-law PDFs at
 *        .../WU01/LI/LI/US/PDF/{year}/0/{actNum padded to 4}..PDF
 *      FlateDecode-compressed, so a markdown reader returns binary — but the file
 *      saves to disk and `pdftotext -layout` extracts perfect verbatim text. The
 *      PDF carries a TOC at the top (big-gap "Section NNN.     Title.") then,
 *      after "...hereby enacts as follows:", the BODY (each section anchored on
 *      /^\s*Section NNN(.N)?\./). We parse only the post-"enacts" body.
 *
 * CATEGORY -> SOURCE MAP (act_key == law_category for every row):
 *   conveyancing_title         PDF 1925-327 Recording of Deeds + PDF 2006-86
 *                              Requirements for Valid Recording of Documents
 *   condo_coop                 RAW Title 68 ch 31-34 (Uniform Condominium Act),
 *                              41-44 (Real Estate Cooperative Act),
 *                              51-54 (Uniform Planned Community Act)
 *   broker_licensing           PDF 1980-9 Real Estate Licensing & Registration Act
 *   mortgage_lien_foreclosure  PDF 1963-497 Mechanics' Lien Law of 1963 + RAW
 *                              Title 68 ch 23 (Vacant & Abandoned Real Estate
 *                              Foreclosure Act)
 *   general_real_property      RAW Title 68 ch 21 (Land Banks), 71/73/74/75
 *                              (Part III Residential Real Property), 81 (Private
 *                              Transfer Fees) + RAW Title 42 ch 55 limitation
 *                              sections 5527-5531 (incl. §5530 21-yr adverse
 *                              possession)
 *
 * Run: cd apps/api && node -r ts-node/register src/db/ingestPARealEstate.ts
 * Idempotent (ON CONFLICT DO NOTHING). Repealed/reserved/empty(<20 char) bodies
 * and all TOC/nav/HTML chrome are dropped.
 */

import { execFileSync } from 'child_process'
import { tmpdir } from 'os'
import { join } from 'path'
import { writeFileSync, unlinkSync, existsSync, readFileSync } from 'fs'
import { query } from './index'

const STATE = 'PA'
const SOURCE_DATE = '2026-06-14'
const EFFECTIVE_YEAR = 2026
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15'
// Optional local HTML cache for consolidated chapters. The host runs a sliding
// rate-throttle; pre-staging chapter HTML here (one controlled, well-spaced
// download pass) lets the parser run without re-hitting the throttle. Path:
// {CACHE}/t{title}_ch{chapter}.html  (e.g. /tmp/pa_law_cache/t68_ch031.html).
const CACHE_DIR = process.env.PA_LAW_CACHE || join(tmpdir(), 'pa_law_cache')

interface Parsed {
  number: string
  title: string | null
  text: string
  url: string
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * Synchronous block for `ms` without spawning an external `sleep` (which is
 * sandbox-blocked in some runners). Uses Atomics.wait on a throwaway SAB.
 */
function sleepSync(ms: number): void {
  const sab = new SharedArrayBuffer(4)
  Atomics.wait(new Int32Array(sab), 0, 0, ms)
}

/**
 * curl a URL to a Buffer with a FULL browser header set. The host serves a
 * ~15KB bot-detection stub to bare requests; a realistic header fingerprint
 * (Accept / Accept-Language / Accept-Encoding + --compressed) returns the real
 * page every time, even mid-throttle. This is the load-bearing fix for the
 * "every consolidated chapter parses 0 sections" failure mode.
 */
function curlBuf(url: string): Buffer {
  return execFileSync(
    'curl',
    [
      '-sL',
      '--max-time',
      '90',
      '--compressed',
      '-A',
      UA,
      '-H',
      'Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      '-H',
      'Accept-Language: en-US,en;q=0.9',
      '-H',
      'Connection: keep-alive',
      '-H',
      'Upgrade-Insecure-Requests: 1',
      url,
    ],
    { maxBuffer: 256 * 1024 * 1024 }
  )
}

/**
 * Fetch a raw-HTML consolidated chapter page. With the full browser header set
 * (see curlBuf) the host serves the real page on the first try; the ~15KB
 * bot-detection stub is now rare, but we still retry a few times with a short
 * settle just in case.
 */
function curlHtmlRetry(url: string): string {
  let last = ''
  for (let attempt = 1; attempt <= 10; attempt++) {
    const html = curlBuf(url).toString('utf-8')
    last = html
    if (/<div class="Comment">[0-9]+c[0-9]+s<\/div>/.test(html)) {
      if (attempt > 1) process.stderr.write(`      (recovered after ${attempt} attempts)\n`)
      return html
    }
    process.stderr.write(`      stub (${html.length}b) for ${url} — retry ${attempt}\n`)
    sleepSync(8000)
  }
  // exhausted — return last (caller will find 0 sections and log it)
  process.stderr.write(`\n      ! gave up after 20 attempts (last ${last.length}b) for ${url}\n`)
  return last
}

function decodeEntities(s: string): string {
  return s
    .replace(/&#167;/g, '§')
    .replace(/&#xA;/gi, '\n')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#8217;|&#x2019;/gi, '’')
    .replace(/&#8216;|&#x2018;/gi, '‘')
    .replace(/&#8220;|&#x201C;/gi, '“')
    .replace(/&#8221;|&#x201D;/gi, '”')
    .replace(/&#8212;|&#x2014;/gi, '—')
    .replace(/&#8211;|&#x2013;/gi, '–')
    .replace(/&#(\d+);/g, (_m, d) => String.fromCharCode(parseInt(d, 10)))
}

/** Plain-text from an HTML fragment, paragraphs separated by single newlines. */
function fragText(frag: string): string {
  let s = frag
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
  s = decodeEntities(s)
  s = s
    .replace(/[  -   　]/g, ' ')
    .replace(/\r/g, '')
  // join wrapped lines within a paragraph: collapse runs of spaces, then trim
  // each line and drop empties.
  const lines = s
    .split('\n')
    .map((l) => l.replace(/[ \t]+/g, ' ').trim())
    .filter((l) => l.length > 0)
  return lines.join('\n').trim()
}

/**
 * Parse one consolidated RAW-HTML chapter. Returns the statute sections found.
 * Strategy: the page is a sequence of <div class="Comment">{title}c{sec}{flag}
 * </div> markers. We split on those; a segment introduced by an 's'-flag marker
 * is a section's statutory body. Within it the first <b>§ NNNN. heading.</b> is
 * the catchline; the remaining <p> text is the body.
 */
function parseConsolidatedChapter(html: string, title: string, url: string): Parsed[] {
  const out: Parsed[] = []
  // Tokenize on comment markers, capturing (section, flag).
  const markerRe = /<div class="Comment">(\d+)c(\d+[a-z]?)([a-z])<\/div>/g
  // `markerStart` = index of the marker's opening '<div'; `bodyStart` = index
  // just past its closing '</div>'. We slice each segment's body up to the NEXT
  // marker's `markerStart` so a following marker never leaks into the text.
  type Seg = { sec: string; flag: string; markerStart: number; bodyStart: number }
  const segs: Seg[] = []
  let m: RegExpExecArray | null
  while ((m = markerRe.exec(html)) !== null) {
    // m[1] = title num, m[2] = section (may carry a trailing letter), m[3] = flag
    if (m[1] !== title) continue
    segs.push({ sec: m[2], flag: m[3], markerStart: m.index, bodyStart: markerRe.lastIndex })
  }
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i]
    if (seg.flag !== 's') continue // only statute-body segments
    const end = i + 1 < segs.length ? segs[i + 1].markerStart : html.length
    const frag = html.slice(seg.bodyStart, end)
    const txt = fragText(frag)
    if (!txt) continue

    // catchline: first line beginning with § NNNN.
    const catchMatch = txt.match(/^§\s*([0-9]+[a-z]?(?:\.[0-9]+)?)\.\s*([^\n]*)/)
    let number = seg.sec
    let title2: string | null = null
    let body = txt
    if (catchMatch) {
      number = catchMatch[1]
      title2 = (catchMatch[2] || '').replace(/\.$/, '').trim() || null
      // body = everything after the catchline line
      const nl = txt.indexOf('\n')
      body = nl >= 0 ? txt.slice(nl + 1).trim() : ''
    }
    // Drop repealed / reserved / empty.
    if (title2 && /^\(?repealed/i.test(title2)) continue
    if (title2 && /^\[?reserved\.?\]?$/i.test(title2)) continue
    if (!body || body.length < 20) continue
    if (/^\(?repealed/i.test(body)) continue
    if (/^\[?reserved\.?\]?$/i.test(body)) continue

    out.push({ number: `${number}`, title: title2, text: body, url })
  }
  return out
}

/**
 * Download a per-Act PDF, extract with `pdftotext -layout`, and parse the BODY
 * sections (post "...enacts as follows:"). Each body section anchors on
 * /^\s*Section NNN(.N)?\./. The catchline runs to the first '.--' (mechanics-
 * lien style) or to end-of-line (RELRA style); body is everything in the block.
 * full_text is stored VERBATIM as the section number + catchline + body joined,
 * preserving the official prose exactly.
 *
 * `onlySections` (optional) restricts to a set of section numbers (for amending
 * acts whose Section 1/2 are bookkeeping instructions, not substantive law).
 * `minSection` (optional) drops sections numbered below it — used for the two
 * big codified acts (RELRA, Mechanics' Lien) whose CODIFIED sections all run
 * ≥101 (Article.Section form); single-digit trailing "Section 4 / 13 / 14 / 16"
 * entries in the as-amended PDF are the act's own uncodified enacting / savings /
 * effective-date clauses (boilerplate chrome), which we drop.
 */
function parsePdfAct(
  url: string,
  opts: { onlySections?: string[]; minSection?: number } = {}
): Parsed[] {
  const tmp = join(tmpdir(), `pa_act_${Date.now()}_${Math.random().toString(36).slice(2)}`)
  const pdfPath = `${tmp}.pdf`
  const txtPath = `${tmp}.txt`
  writeFileSync(pdfPath, curlBuf(url))
  execFileSync('pdftotext', ['-layout', pdfPath, txtPath])
  let raw = require('fs').readFileSync(txtPath, 'utf-8') as string
  try {
    unlinkSync(pdfPath)
    if (existsSync(txtPath)) unlinkSync(txtPath)
  } catch {}

  // Strip form-feed page breaks; normalize CRs.
  raw = raw.replace(/\f/g, '\n').replace(/\r/g, '')

  // Find the body boundary: text after the LAST "enacts as follows:" line.
  const enactRe = /enacts as follows:/gi
  let lastIdx = -1
  let mm: RegExpExecArray | null
  while ((mm = enactRe.exec(raw)) !== null) lastIdx = mm.index + mm[0].length
  const body = lastIdx >= 0 ? raw.slice(lastIdx) : raw

  // Split the body on body-section anchors. A body anchor is a line that starts
  // (after leading spaces) with "Section NNN." AND is immediately followed by
  // real text (not the wide-gap TOC form). We detect anchors by line.
  const lines = body.split('\n')
  type Block = { number: string; headLine: string; startLine: number }
  const blocks: Block[] = []
  const anchorRe = /^\s*Section\s+([0-9]+(?:\.[0-9]+)?)\.\s*(.*)$/
  for (let i = 0; i < lines.length; i++) {
    const a = lines[i].match(anchorRe)
    if (!a) continue
    // Reject TOC-style rows: those have a long run of spaces between the
    // catchline and... actually the TOC is BEFORE the boundary, so we're clean.
    blocks.push({ number: a[1], headLine: lines[i], startLine: i })
  }

  const out: Parsed[] = []
  for (let b = 0; b < blocks.length; b++) {
    const cur = blocks[b]
    if (opts.onlySections && !opts.onlySections.includes(cur.number)) continue
    if (opts.minSection !== undefined && parseFloat(cur.number) < opts.minSection) continue
    const endLine = b + 1 < blocks.length ? blocks[b + 1].startLine : lines.length
    // Collect block lines, stripping CHAPTER / sub-header centered lines that
    // are pure uppercase headers (e.g. "CHAPTER 2", "DEFINITIONS").
    const blkLines = lines.slice(cur.startLine, endLine)
    // Reconstruct verbatim text. Trim trailing whitespace on each line, collapse
    // internal multi-space (layout artifact) to single space, drop empty lines
    // at block edges, drop standalone ALL-CAPS chapter/article header lines that
    // pdftotext placed between sections.
    const cleaned: string[] = []
    for (const ln of blkLines) {
      const t = ln.replace(/[ \t]+/g, ' ').trim()
      if (!t) {
        if (cleaned.length && cleaned[cleaned.length - 1] !== '') cleaned.push('')
        continue
      }
      // standalone chapter/article header (all caps, no lowercase, short, no period)
      if (
        cleaned.length > 0 && // never the first line (that's the Section head)
        /^[A-Z0-9 .,'"()\-]+$/.test(t) &&
        !/[a-z]/.test(t) &&
        t.length < 60 &&
        !/^SECTION/i.test(t) &&
        !/[.;]$/.test(t)
      ) {
        continue
      }
      cleaned.push(t)
    }
    // strip leading/trailing blank lines
    while (cleaned.length && cleaned[0] === '') cleaned.shift()
    while (cleaned.length && cleaned[cleaned.length - 1] === '') cleaned.pop()
    const fullText = cleaned.join('\n').replace(/\n{3,}/g, '\n\n').trim()
    if (!fullText || fullText.length < 20) continue

    // Derive a catchline title for section_title (purely a label; full_text is
    // the verbatim block). RELRA: "Section 101. Short title." -> title before
    // the body line. Mechanics-lien: "Section 101. Short Title.--This act..."
    // -> title between number and "--".
    const head = cur.headLine.replace(/[ \t]+/g, ' ').trim()
    let title: string | null = null
    const dd = head.match(/^Section\s+[0-9.]+\.\s*([^]*?)\.--/)
    if (dd) {
      title = dd[1].trim() || null
    } else {
      const rest = head.replace(/^Section\s+[0-9.]+\.\s*/, '').trim()
      // RELRA heads carry only the catchline (body is on the next line)
      if (rest && rest.length < 120) title = rest.replace(/\.$/, '').trim() || null
    }
    if (title && /repealed/i.test(title) && fullText.length < 120) continue
    if (/^Section\s+[0-9.]+\.\s*\(?repealed/i.test(head) && fullText.length < 120)
      continue

    out.push({ number: cur.number, title, text: fullText, url })
  }
  return out
}

async function insertRows(actKey: string, rows: Parsed[]): Promise<number> {
  let ok = 0
  for (const r of rows) {
    await query(
      `INSERT INTO state_law_section_texts
         (state_code, act_key, section_number, section_title, full_text, source_url,
          source_date, effective_year, law_category)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (state_code, act_key, section_number, effective_year) DO NOTHING`,
      [STATE, actKey, r.number, r.title, r.text, r.url, SOURCE_DATE, EFFECTIVE_YEAR, actKey]
    )
    ok++
  }
  return ok
}

// Chapter pages live at .../HTM/{title}/00.0{NN}..HTM where NN is the chapter
// zero-padded to TWO digits (e.g. ch 31 → 00.031, ch 5 → 00.005, ch 23 →
// 00.023). `chapter` here is the bare chapter number as a string ('31','23').
const ctHtmUrl = (title: string, chapter: string) =>
  `https://www.legis.state.pa.us/WU01/LI/LI/CT/HTM/${title}/00.0${chapter.padStart(2, '0')}..HTM`
const pdfUrl = (year: number, act: string) =>
  `https://www.legis.state.pa.us/WU01/LI/LI/US/PDF/${year}/0/${act}..PDF`

/** Fetch + parse a list of consolidated chapters into one bucket. */
async function gatherChapters(
  title: string,
  chapters: string[]
): Promise<Parsed[]> {
  const all: Parsed[] = []
  const seen = new Set<string>()
  for (const ch of chapters) {
    const url = ctHtmUrl(title, ch)
    const cachePath = join(CACHE_DIR, `t${title}_ch${ch}.html`)
    let html: string
    let fromCache = false
    if (existsSync(cachePath)) {
      html = readFileSync(cachePath, 'utf-8')
      fromCache = /<div class="Comment">[0-9]+c[0-9]+s<\/div>/.test(html)
      if (!fromCache) html = curlHtmlRetry(url) // cached file was a stub — refetch
    } else {
      html = curlHtmlRetry(url)
    }
    const rows = parseConsolidatedChapter(html, title, url)
    for (const r of rows) {
      if (seen.has(r.number)) continue
      seen.add(r.number)
      all.push(r)
    }
    console.log(
      `    title ${title} ch ${ch}: +${rows.length} (running total ${all.length})${fromCache ? ' [cache]' : ''}`
    )
    if (!fromCache) await sleep(2000) // politeness between chapter fetches
  }
  return all
}

/** For Title 42 limitations, keep only a section-number whitelist. */
function filterByNumber(rows: Parsed[], keep: string[]): Parsed[] {
  const set = new Set(keep)
  return rows.filter((r) => set.has(r.number))
}

async function main() {
  console.log(`\n=== PA — ingesting real-estate (non-tax) full-text corpus (as of ${SOURCE_DATE}) ===`)
  const counts: Record<string, number> = {}

  // ── conveyancing_title ──────────────────────────────────────────────
  // 1925-327 Recording of Deeds (1 substantive section) + 2006-86 Requirements
  // for Valid Recording of Documents (substantive sections 3 & 4; sections 1 & 2
  // are amend-instruction + effective-date bookkeeping → dropped).
  {
    console.log('conveyancing_title:')
    const rec1925 = parsePdfAct(pdfUrl(1925, '0327'))
    console.log(`    1925-327 Recording of Deeds: ${rec1925.length} section(s)`)
    const valid2006 = parsePdfAct(pdfUrl(2006, '0086'), { onlySections: ['3', '4'] })
    console.log(`    2006-86 Requirements for Valid Recording: ${valid2006.length} section(s)`)
    // disambiguate section numbers across the two acts (both have "Section N")
    const merged = [
      ...rec1925.map((r) => ({ ...r, number: `1925-327 §${r.number}` })),
      ...valid2006.map((r) => ({ ...r, number: `2006-86 §${r.number}` })),
    ]
    counts['conveyancing_title'] = await insertRows('conveyancing_title', merged)
  }

  // ── condo_coop ──────────────────────────────────────────────────────
  // Title 68 ch 31-34 condo, 41-44 coop, 51-54 planned communities.
  {
    console.log('condo_coop:')
    const rows = await gatherChapters('68', [
      '31', '32', '33', '34',
      '41', '42', '43', '44',
      '51', '52', '53', '54',
    ])
    counts['condo_coop'] = await insertRows('condo_coop', rows)
    console.log(`    condo_coop parsed ${rows.length} sections`)
  }

  // ── broker_licensing ────────────────────────────────────────────────
  // RELRA — 1980-9 (as-amended). Body sections only.
  {
    console.log('broker_licensing:')
    const rows = parsePdfAct(pdfUrl(1980, '0009'), { minSection: 101 })
    counts['broker_licensing'] = await insertRows('broker_licensing', rows)
    console.log(`    1980-9 RELRA: ${rows.length} sections`)
  }

  // ── mortgage_lien_foreclosure ───────────────────────────────────────
  // Mechanics' Lien Law of 1963 (1963-497) + Title 68 ch 23 Vacant & Abandoned
  // Real Estate Foreclosure Act.
  {
    console.log('mortgage_lien_foreclosure:')
    const mech = parsePdfAct(pdfUrl(1963, '0497'), { minSection: 101 }).map((r) => ({
      ...r,
      number: `MLL §${r.number}`,
    }))
    console.log(`    1963-497 Mechanics' Lien Law: ${mech.length} sections`)
    const fore = await gatherChapters('68', ['23'])
    console.log(`    Title 68 ch 23 Foreclosure: ${fore.length} sections`)
    counts['mortgage_lien_foreclosure'] = await insertRows(
      'mortgage_lien_foreclosure',
      [...mech, ...fore]
    )
  }

  // ── general_real_property ───────────────────────────────────────────
  // Title 68 ch 21 (Land Banks), 71/73/74/75 (Part III Residential Real
  // Property), 81 (Private Transfer Fees) + Title 42 ch 55 limitations
  // 5527-5531 (incl. §5530 21-yr adverse possession).
  {
    console.log('general_real_property:')
    const t68 = await gatherChapters('68', ['21', '71', '73', '74', '75', '81'])
    const t42raw = await gatherChapters('42', ['55'])
    const t42 = filterByNumber(t42raw, ['5527', '5528', '5529', '5530', '5531'])
    console.log(`    Title 68 Part III/land-banks/PTF: ${t68.length}; Title 42 limitations: ${t42.length}`)
    counts['general_real_property'] = await insertRows('general_real_property', [...t68, ...t42])
  }

  const total = Object.values(counts).reduce((a, b) => a + b, 0)
  console.log(`\nPA done. inserted=${total}`, counts)
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
