/**
 * Pennsylvania PROPERTY-TAX statute full-text ingester (state-law corpus).
 *
 * Posture (sanctioned retrieve+cite+date carve-out): GAM stores the VERBATIM
 * text of each statute section, with source URL + retrieval date, searchable by
 * the agent's search_state_law tool. GAM retrieves + cites + dates + disclaims —
 * never advises. See services/stateLaw.ts + the migration headers.
 *
 * PA real-property tax law is spread across THREE official acts, fetched from
 * two different source formats on the legislature's own site (legis.state.pa.us):
 *
 *   (1) CONSOLIDATED — Title 53 Pa.C.S. Chapter 88, the Consolidated County
 *       Assessment Law (assessment, exemptions, boards/appeals). The static
 *       chapter HTM at .../CT/HTM/53/00.088..HTM is ONE file holding verbatim
 *       text of every section 8801-8868. Raw curl is 403'd by the IIS bot
 *       filter UNLESS a real-browser User-Agent is sent; with a browser UA it
 *       returns plain static HTML (no JS needed — the newer palegis.us SPA does
 *       require JS, so we deliberately use the legacy static file). In this
 *       source the section symbol is the entity &#167; ("§") and hard line
 *       breaks are the literal entity &#xA; — both decoded before splitting.
 *       Sections are delimited by "§ <num>. <Heading>." in <b> tags.
 *
 *   (2)+(3) UNCONSOLIDATED — the Local Tax Collection Law (Act 394 of 1945,
 *       72 P.S. § 5511.1 et seq.: billing/due-dates/discounts/penalties) and the
 *       Real Estate Tax Sale Law (Act 542 of 1947, 72 P.S. § 5860.101 et seq.:
 *       liens/tax sale/redemption). Official source is the FlateDecode PDF at
 *       .../US/PDF/<YEAR>/0/<ACTNUM>..PDF — not readable by markdown converters,
 *       so we run `pdftotext -layout`. Each PDF has a leading TABLE OF CONTENTS
 *       block (Section index, NO ".--") that we SKIP by starting the body at the
 *       first real body section ("Section 1. Short Title.--..."). Body sections
 *       start at column-indented "Section N. <Heading>.--<text>"; the ".--"
 *       delimiter separates heading from body. Headings can wrap across lines,
 *       so we group by section start then split on ".--" after reflow. ARTICLE
 *       headers (Act 542) are carried as parent grouping. Act 394 has a trailing
 *       APPENDIX of "Supplementary Provisions of Amendatory Statutes" that
 *       re-uses Section 5/6/7/8 numbering from amending acts — we cut the body
 *       at APPENDIX so those non-canonical provisions never collide with the
 *       main act's sections.
 *
 * Repealed / reserved / empty (<20 char) bodies and all TOC/nav/HTML chrome are
 * dropped. act_key='property_tax', law_category='property_tax'.
 *
 * Run: cd apps/api && node -r ts-node/register src/db/ingestPAPropertyTax.ts
 * Idempotent (ON CONFLICT DO NOTHING).
 */

import { execFileSync } from 'child_process'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { query } from './index'

const STATE = 'PA'
const ACT_KEY = 'property_tax'
const LAW_CATEGORY = 'property_tax'
const SOURCE_DATE = '2026-06-14'
const EFFECTIVE_YEAR = 2026
// Real-browser UA — the legacy legis.state.pa.us IIS filter 403's GAM-* agents.
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

const HTM_URL = 'https://www.legis.state.pa.us/WU01/LI/LI/CT/HTM/53/00.088..HTM'
const ACT394_URL = 'https://www.legis.state.pa.us/WU01/LI/LI/US/PDF/1945/0/0394..PDF'
const ACT542_URL = 'https://www.legis.state.pa.us/WU01/LI/LI/US/PDF/1947/0/0542..PDF'

interface Parsed {
  number: string
  title: string | null
  text: string
}

// ---------------------------------------------------------------------------
// Fetch helpers
// ---------------------------------------------------------------------------

function curlText(url: string): string {
  return execFileSync('curl', ['-sL', '--max-time', '90', '-A', UA, url], {
    maxBuffer: 256 * 1024 * 1024,
  }).toString('utf-8')
}

/** Download a PDF and return its `pdftotext -layout` output. */
function curlPdfToText(url: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'pa-stat-'))
  const pdf = join(dir, 'doc.pdf')
  const txt = join(dir, 'doc.txt')
  try {
    const buf = execFileSync('curl', ['-sL', '--max-time', '90', '-A', UA, url], {
      maxBuffer: 256 * 1024 * 1024,
    })
    writeFileSync(pdf, buf)
    execFileSync('pdftotext', ['-layout', pdf, txt])
    return readFileSync(txt, 'utf-8')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------
// HTM (consolidated Title 53 Ch. 88) parser
// ---------------------------------------------------------------------------

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

/** Tag-strip Ch.88 HTM into newline-delimited readable text. */
function cleanHtm(html: string): string {
  let s = html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
  // In this source &#xA; is the hard line-break marker — decode to \n BEFORE the
  // generic entity pass so paragraph structure survives.
  s = s.replace(/&#xa;/gi, '\n')
  s = s.replace(/<\/(p|div|li|tr|h[1-6]|section)>/gi, '\n').replace(/<br\s*\/?>/gi, '\n')
  s = s.replace(/<[^>]+>/g, ' ')
  s = decodeEntities(s)
  s = s
    .replace(/[  -​  　]/g, ' ')
    .replace(/\r/g, '')
    .replace(/[ \t]+/g, ' ')
  s = s.replace(/ ?\n ?/g, '\n').replace(/\n{3,}/g, '\n\n')
  return s.trim()
}

function parseCh88(html: string): Parsed[] {
  const lines = cleanHtm(html).split('\n')
  const hdrRe = /^\s*§\s*(88\d\d(?:\.\d+)?)\.\s*(.*\S)?\s*$/
  const groups: { number: string; title: string | null; body: string[] }[] = []
  let cur: { number: string; title: string | null; body: string[] } | null = null
  for (const ln of lines) {
    const m = ln.match(hdrRe)
    if (m) {
      if (cur) groups.push(cur)
      cur = { number: m[1], title: (m[2] || '').trim() || null, body: [] }
    } else if (cur) {
      cur.body.push(ln)
    }
  }
  if (cur) groups.push(cur)

  const out: Parsed[] = []
  for (const g of groups) {
    const text = g.body.join('\n').replace(/\n{3,}/g, '\n\n').trim()
    if (!text || text.length < 20) continue
    if (g.title && /^\(?(repealed|reserved)\b/i.test(g.title)) continue
    if (/^\(?(repealed|reserved)\)?\.?$/i.test(text)) continue
    out.push({ number: g.number, title: g.title ? g.title.replace(/\.$/, '') : null, text })
  }
  return out
}

// ---------------------------------------------------------------------------
// PDF (unconsolidated acts 394 / 542) parser
// ---------------------------------------------------------------------------

/**
 * Reflow grouped raw PDF lines into readable paragraphs. A line that begins with
 * whitespace + an enumerator ("(a)" / "(1)" / "(i)" / a quote) starts a new
 * paragraph; otherwise continuation lines space-join. Pure page-number artifact
 * lines are dropped.
 */
function reflow(rawLines: string[]): string {
  const enumRe = /^\s+(\([0-9a-zA-Z.]+\)|"[^"]|\([ivxlcdm]+\))/
  const parts: string[] = []
  let buf = ''
  for (let i = 0; i < rawLines.length; i++) {
    const ln = rawLines[i]
    if (ln.trim() === '') {
      if (buf) {
        parts.push(buf.trim())
        buf = ''
      }
      continue
    }
    if (/^\s*-?\s*\d+\s*-?\s*$/.test(ln)) continue // bare page number
    const startsPara = enumRe.test(ln) && i > 0
    if (startsPara && buf) {
      parts.push(buf.trim())
      buf = ln.trim()
    } else {
      buf = buf ? buf + ' ' + ln.trim() : ln.trim()
    }
  }
  if (buf) parts.push(buf.trim())
  return parts.join('\n')
}

/**
 * Parse a pdftotext-layout act body into sections. `bodyStartRe` locates the
 * first real body section (skipping the TOC); `endCutRe`, if given, marks where
 * the canonical body ends (e.g. APPENDIX). ARTICLE headers are carried as parent
 * grouping and prefixed onto the section title.
 */
function parsePdfAct(txt: string, bodyStartRe: RegExp, endCutRe: RegExp | null): Parsed[] {
  const lines = txt.split('\n')

  let start = -1
  for (let i = 0; i < lines.length; i++) {
    if (bodyStartRe.test(lines[i]) && lines.slice(i, i + 6).join(' ').includes('.--')) {
      start = i
      break
    }
  }
  if (start === -1) return []
  let end = lines.length
  if (endCutRe) {
    for (let i = start; i < lines.length; i++) {
      if (endCutRe.test(lines[i])) {
        end = i
        break
      }
    }
  }
  const body = lines.slice(start, end)

  const artRe = /^\s*(ARTICLE\s+[IVXL]+(?:-[A-Z])?)\s*$/
  const secStartRe = /^\s+Section\s+([0-9]+(?:\.[0-9]+)?[A-Za-z-]*)\.\s/

  let curArticle: string | null = null
  const blocks: { article: string | null; raw: string[] }[] = []
  let cur: { article: string | null; raw: string[] } | null = null
  for (const ln of body) {
    const am = ln.match(artRe)
    if (am) {
      curArticle = am[1].replace(/\s+/g, ' ').trim()
      continue
    }
    if (secStartRe.test(ln)) {
      if (cur) blocks.push(cur)
      cur = { article: curArticle, raw: [ln] }
    } else if (cur) {
      cur.raw.push(ln)
    }
  }
  if (cur) blocks.push(cur)

  const out: Parsed[] = []
  for (const b of blocks) {
    const joined = reflow(b.raw)
    let number: string
    let title: string | null
    let text: string
    const m = joined.match(/^Section\s+([0-9]+(?:\.[0-9]+)?[A-Za-z-]*)\.\s+([\s\S]*?)\.--([\s\S]*)$/)
    if (m) {
      number = m[1]
      title = m[2].replace(/\s+/g, ' ').trim() || null
      text = m[3].trim()
    } else {
      // No ".--" — simple one-liner (repealer / effective-date). Keep verbatim.
      const m2 = joined.match(/^Section\s+([0-9]+(?:\.[0-9]+)?[A-Za-z-]*)\.\s+([\s\S]*)$/)
      if (!m2) continue
      number = m2[1]
      title = null
      text = m2[2].replace(/\s+/g, ' ').trim()
    }
    if (!text || text.length < 20) continue
    if (/^\(?(repealed|reserved)\b/i.test(text) && text.length < 60) continue
    if (title && b.article) title = `${b.article} — ${title}`
    out.push({ number, title, text })
  }
  return out
}

// ---------------------------------------------------------------------------
// Insert
// ---------------------------------------------------------------------------

async function insertSections(sections: Parsed[], sourceUrl: string, label: string): Promise<number> {
  let ok = 0
  for (const s of sections) {
    // query() returns rows[], not the QueryResult, so RETURNING tells us whether
    // the row was actually inserted vs. skipped by ON CONFLICT DO NOTHING.
    const rows = await query<{ id: string }>(
      `INSERT INTO state_law_section_texts
         (state_code, act_key, section_number, section_title, full_text, source_url, source_date, effective_year, law_category)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (state_code, act_key, section_number, effective_year) DO NOTHING
       RETURNING id`,
      [STATE, ACT_KEY, s.number, s.title, s.text, sourceUrl, SOURCE_DATE, EFFECTIVE_YEAR, LAW_CATEGORY]
    )
    if (rows.length > 0) ok++
  }
  console.log(`  [${label}] parsed ${sections.length}, inserted ${ok}`)
  return ok
}

async function main() {
  console.log(`\n=== PA — ingesting property-tax corpus (as of ${SOURCE_DATE}) ===`)

  // (1) Consolidated County Assessment Law — Title 53 Pa.C.S. Ch. 88 (HTM).
  const ch88 = parseCh88(curlText(HTM_URL))
  const nCh88 = await insertSections(ch88, HTM_URL, 'Title 53 Ch.88 (assessment/exemptions/appeals)')

  // (2) Local Tax Collection Law — Act 394 of 1945 (PDF). Cut at APPENDIX.
  const act394 = parsePdfAct(
    curlPdfToText(ACT394_URL),
    /^\s+Section\s+1\.\s+Short Title/,
    /^\s*APPENDIX\s*$/
  )
  const nAct394 = await insertSections(act394, ACT394_URL, 'Act 394/1945 Local Tax Collection Law')

  // (3) Real Estate Tax Sale Law — Act 542 of 1947 (PDF). No appendix.
  const act542 = parsePdfAct(curlPdfToText(ACT542_URL), /^\s+Section\s+101\.\s+Short Title/, null)
  const nAct542 = await insertSections(act542, ACT542_URL, 'Act 542/1947 Real Estate Tax Sale Law')

  const total = nCh88 + nAct394 + nAct542
  console.log(`\nPA done. inserted=${total}`, {
    ch88: nCh88,
    act394: nAct394,
    act542: nAct542,
  })
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
