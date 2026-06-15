/**
 * Hawaii non-tax real-estate statute full-text ingester (verbatim retrieve +
 * cite + date carve-out; never advice).
 *
 * SOURCE — official HI legislature data subdomain:
 *   https://data.capitol.hawaii.gov/hrscurrent/<VolFolder>/<ChapterFolder>/
 * Each statute section is one Microsoft-Word-filtered .htm file. The www.
 * host of the identical path is Cloudflare-managed-challenge walled (403 to
 * raw HTTP); the data. subdomain is the same content and NOT walled (raw_http
 * 200), so we curl the data. host directly with a browser User-Agent.
 *
 * ENUMERATION: each chapter folder is directory-listable (HTTP 200) and the
 * listing names every section file as HRS_<CH>-NNNN(.htm) / -NNNN_DDDD.htm.
 * We scrape the file list straight from the folder index — no probe-to-404
 * needed, no separate chapter-index page (those 404). De-duped + sorted.
 *
 *   File -> section number:
 *     HRS_0502-0034.htm        -> 502-34
 *     HRS_0502-0031_0005.htm   -> 502-31.5   (the _DDDD suffix is the decimal
 *                                  part, 4-digit zero-padded: _0005 = .5,
 *                                  _0015 = .15). Trailing zeros are trimmed.
 *
 * PAGE LAYOUT (per section .htm):
 *   <div class="WordSection1">   = the statute body container
 *     <p class="RegularParagraphs"> <b>§502-34  Catchline.</b> body... </p>
 *     <p class="RegularParagraphs"> / <p class="oneParagraph"> = more body
 *     ...trailing source note in brackets: [L 1951, c 38, §1; ...]
 *     <p class="XNotesHeading">Case Notes</p>  = START OF ANNOTATIONS (cut here)
 *     <p class="XNotes"> ... case/cross-ref annotations ... </p>
 *   </div>
 *   <div id='pageLinks'> Previous / Next nav </div>  = OUTSIDE WordSection1
 *
 * Heading is the bolded <b>§CH-N  Title.</b> inside the first body paragraph.
 * Newly added sections are bracketed in the source as <b>[§514B-1] Title.</b>
 * — we strip a single leading '[' and the matching ']' around the citation.
 *
 * PARSE: isolate WordSection1, walk its <p> blocks IN ORDER, stop at the first
 * XNotesHeading/XNotes paragraph (drops case notes, cross refs, AG opinions —
 * those are annotations, not enacted statute text). Concatenate the kept body
 * paragraphs verbatim (incl. the catchline line and the bracketed source note,
 * which is part of the statute trailer). Repealed / reserved / TOC / empty
 * (<20 char) bodies are dropped.
 *
 * CATEGORIES (law_category == act_key for every block):
 *   conveyancing_title         = HRS 502 (Bureau of Conveyances; Recording)
 *   condo_coop                 = HRS 514B (Condominiums) + 514A + 421I + 421J
 *   broker_licensing           = HRS 467 (Real Estate Brokers/Salespersons)
 *                                + 466K (Real Estate Appraisers)
 *   mortgage_lien_foreclosure  = HRS 667 (Foreclosures) + 506 (Mortgages)
 *                                + 507 (Liens, incl. mechanic's/materialman's)
 *   general_real_property      = HRS 509 (Estates in Land; Tenancies) + 501
 *                                (Land Court/Torrens) + 508/508A/508D + 669
 *                                (quiet title)
 *
 * Run: cd apps/api && node -r ts-node/register src/db/ingestHIRealEstate.ts
 * Idempotent (ON CONFLICT DO NOTHING).
 */

import { execFileSync } from 'child_process'
import { query } from './index'
import { stripTags } from './ingestStateLawCorpus'

const STATE = 'HI'
const SOURCE_DATE = '2026-06-14'
const EFFECTIVE_YEAR = 2026
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) GAM-statute-ingest/1.0'
const HOST = 'https://data.capitol.hawaii.gov/hrscurrent'

interface ChapterSpec {
  /** chapter token as it appears in folder + file names, e.g. '0502', '0514B' */
  ch: string
  /** volume folder, e.g. 'Vol12_Ch0501-0588' */
  vol: string
}

// Each category maps to one or more HRS chapters. law_category == act_key.
const CATEGORIES: Record<string, ChapterSpec[]> = {
  conveyancing_title: [{ ch: '0502', vol: 'Vol12_Ch0501-0588' }],
  condo_coop: [
    { ch: '0514B', vol: 'Vol12_Ch0501-0588' },
    // 514A (older Condominium Property Regimes) is a single repealed/superseded
    // stub file with no sectioned content (HRS_0514A-.htm) — it yields 0 real
    // sections and is intentionally not listed.
    { ch: '0421I', vol: 'Vol08_Ch0401-0429' }, // cooperative housing corporations
    { ch: '0421J', vol: 'Vol08_Ch0401-0429' }, // planned community associations
  ],
  broker_licensing: [
    { ch: '0467', vol: 'Vol10_Ch0436-0474' },
    { ch: '0466K', vol: 'Vol10_Ch0436-0474' },
  ],
  mortgage_lien_foreclosure: [
    { ch: '0667', vol: 'Vol13_Ch0601-0676' },
    { ch: '0506', vol: 'Vol12_Ch0501-0588' },
    { ch: '0507', vol: 'Vol12_Ch0501-0588' },
  ],
  general_real_property: [
    { ch: '0509', vol: 'Vol12_Ch0501-0588' }, // Estates in Land; Tenancies
    { ch: '0501', vol: 'Vol12_Ch0501-0588' }, // Land Court / Torrens registration
    { ch: '0508', vol: 'Vol12_Ch0501-0588' }, // Partition (single live section)
    // 508A does not exist on the data subdomain (only 508, 508C, 508D); 508C
    // is uniform-real-property-electronic-recording, out of scope here.
    { ch: '0508D', vol: 'Vol12_Ch0501-0588' }, // Mandatory Seller Disclosures
    { ch: '0669', vol: 'Vol13_Ch0601-0676' }, // Quiet Title
  ],
}

interface SectionFile {
  file: string // e.g. HRS_0502-0031_0005.htm
  number: string // e.g. 502-31.5
}
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

/** Strip the leading 'HRS' chapter token to its citation form: '0502'->'502', '0514B'->'514B'. */
function chToCitation(ch: string): string {
  const m = ch.match(/^0*([0-9].*)$/)
  return m ? m[1] : ch
}

/**
 * Decode a section filename to its citation number.
 *   HRS_0502-0034.htm       -> 502-34
 *   HRS_0502-0031_0005.htm  -> 502-31.5  (the _DDDD suffix is the decimal part,
 *                              4-digit LEADING-zero-padded: _0005 = .5,
 *                              _0001 = .1, _0007 = .7; strip the leading zeros.
 *                              Verified against the bolded headings, e.g.
 *                              HRS_0508D-0003_0005.htm reads "§508D-3.5".)
 *   HRS_0514B-0146.htm      -> 514B-146
 */
function fileToNumber(file: string): string | null {
  const m = file.match(/^HRS_([0-9A-Z]+)-(\d+)(?:_(\d+))?\.htm$/i)
  if (!m) return null
  const chCite = chToCitation(m[1])
  const main = String(parseInt(m[2], 10))
  let num = `${chCite}-${main}`
  if (m[3]) {
    const dec = m[3].replace(/^0+/, '') // strip leading zeros: 0005 -> 5, 0001 -> 1
    if (dec) num += `.${dec}`
  }
  return num
}

/** Scrape the directory listing for the chapter folder to enumerate section files. */
function listSections(spec: ChapterSpec): SectionFile[] {
  const dir = `${HOST}/${spec.vol}/HRS${spec.ch}/`
  let html: string
  try {
    html = curl(dir)
  } catch (e: any) {
    console.warn(`  ! folder ${spec.ch}: ${e?.message || e}`)
    return []
  }
  const re = new RegExp(`HRS_${spec.ch}-[0-9_]+\\.htm`, 'gi')
  const seen = new Set<string>()
  const out: SectionFile[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) {
    const file = m[0]
    if (seen.has(file)) continue
    seen.add(file)
    const number = fileToNumber(file)
    if (number) out.push({ file, number })
  }
  out.sort((a, b) => {
    const pa = parseFloat(a.number.split('-')[1])
    const pb = parseFloat(b.number.split('-')[1])
    return pa - pb
  })
  return out
}

/**
 * Parse one section .htm into { number, title, text }. Isolates the
 * WordSection1 body container, walks <p> blocks in order, and STOPS at the
 * first XNotes/XNotesHeading paragraph (annotations begin there). Returns null
 * for repealed / reserved / empty / short bodies.
 */
function parseSection(html: string, expectedNumber: string): Parsed | null {
  // Isolate the statute body container; falls back to whole doc if not found.
  const wsMatch = html.match(/<div\s+class="WordSection1"[^>]*>([\s\S]*?)<\/div>/i)
  const body = wsMatch ? wsMatch[1] : html

  // Collect paragraphs in document order. For each, keep its class, readable
  // text, and the concatenation of ALL its <b>…</b> runs (the catchline can be
  // split across two bold tags, e.g. "<b>§507-46</b> <b>Priority…</b>").
  const paraRe = /<p\s+class="([^"]*)"[^>]*>([\s\S]*?)<\/p>/gi
  interface Para { cls: string; txt: string; bold: string }
  const paras: Para[] = []
  let m: RegExpExecArray | null
  while ((m = paraRe.exec(body)) !== null) {
    const cls = m[1].toLowerCase()
    const txt = stripTags(m[2], true).trim()
    if (!txt && !cls.includes('xnotes')) continue
    // The bolded catchline is frequently fragmented across several <b> runs,
    // sometimes mid-citation: <b>[</b><b>§667-</b><b>20]</b><b>  Title.</b> or
    // <b>§667-</b><b>59</b><b>  Actions…</b> or <b>§507-46</b><b>  Priority…</b>.
    // Join with a single space then collapse whitespace; the citation may end up
    // space-fragmented ("§667- 20]", "§667- 5 .5") but the title stays separated
    // from the citation digits. The exact section number is recovered from the
    // filename, not from this string.
    const bold = [...m[2].matchAll(/<b[^>]*>([\s\S]*?)<\/b>/gi)]
      .map((b) => stripTags(b[1], false))
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim()
    paras.push({ cls, txt, bold })
  }

  if (!paras.length) return null

  // The catchline is the first paragraph whose BOLD text contains the section
  // citation ("§514B-1  Short title." / "[§514B-1]  Short title." / fragmented
  // "[ §667- 20] …"). Centered PART / CHAPTER / SUBPART headers (also bold, but
  // no §) and early XNotes renumbering "Note" blocks that precede the real
  // catchline are skipped. Tolerate an optional leading "[" before the §.
  let catchIdx = paras.findIndex((p) => /^\[?\s*§/.test(p.bold.trim()))
  if (catchIdx === -1) {
    // No bolded § citation (rare). Fall back to the first body paragraph that is
    // not a PART/CHAPTER header and not an annotation.
    catchIdx = paras.findIndex(
      (p) => !p.cls.includes('xnotes') && !/^(part|chapter|subpart|article)\b/i.test(p.txt)
    )
    if (catchIdx === -1) catchIdx = 0
  }
  const headingRaw = paras[catchIdx].bold

  // Body = catchline paragraph onward, stopping at the FIRST XNotes-family
  // paragraph that appears AFTER the catchline (Case Notes / Cross References /
  // AG Opinions / Note — annotations, not enacted text).
  const kept: string[] = []
  for (let i = catchIdx; i < paras.length; i++) {
    if (paras[i].cls.includes('xnotes')) break
    if (paras[i].txt) kept.push(paras[i].txt)
  }
  const fullText = kept.join('\n').trim()

  // The section_number is the FILENAME-derived citation (`expectedNumber`),
  // which is unambiguous (e.g. "667-5.5", "667-20"). Source headings fragment
  // the citation across <b> runs with spurious internal spaces ("§667- 20]",
  // "§667- 5 .5"), so the heading is NOT trusted for the number. It IS used for
  // the TITLE: strip the leading "[ § <citation> ]" prefix. We build a tolerant
  // matcher from the KNOWN expected number so we never eat the first title word.
  const citeRe = new RegExp(
    '^\\[?\\s*§\\s*' +
      expectedNumber.split('').map((c) => (/[0-9A-Za-z]/.test(c) ? c : '\\' + c)).join('\\s*') +
      '\\s*\\]?\\s*',
    'i'
  )
  let title: string | null = null
  if (headingRaw) {
    const h = headingRaw.trim().replace(citeRe, '')
    title = h.replace(/\s+/g, ' ').replace(/\.$/, '').trim() || null
  }

  // Drop repealed / reserved (title- or body-level markers).
  if (title && /^repealed\b/i.test(title)) return null
  if (title && /^\[?\s*reserved\.?\s*\]?$/i.test(title)) return null
  // Catchline whose ONLY content after the citation is REPEALED/RESERVED, e.g.
  // a heading "§667- REPEALED." with no statute body.
  const flat = fullText.replace(/\s+/g, ' ').trim()
  const bodyAfterCite = flat.replace(citeRe, '').trim()
  if (/^(repealed|reserved)\b/i.test(bodyAfterCite)) return null
  if (/^\s*\[?\s*(repealed|reserved)\.?\s*\]?\s*$/i.test(flat)) return null
  // Repealed/reserved RANGE markers — the catchline is a section RANGE, not a
  // single section, so `citeRe` (the one expected number) won't fully strip it.
  // Pattern: a leading run of §, section-number range tokens (digits / hyphens /
  // dots / commas / "to" / "and"), then REPEALED or RESERVED. These are repeal
  // stubs with no enacted text — drop them.
  if (/^\s*§(?:[\s§\d.,–-]|\bto\b|\band\b|\bthrough\b)*(?:repealed|reserved)\b/i.test(flat)) {
    return null
  }

  if (fullText.length < 20) return null

  return { number: expectedNumber, title, text: fullText }
}

async function ingestCategory(category: string): Promise<number> {
  console.log(`\n--- ${category} ---`)
  const specs = CATEGORIES[category]
  let ok = 0
  let skipped = 0

  for (const spec of specs) {
    const cite = chToCitation(spec.ch)
    const sections = listSections(spec)
    console.log(`  chapter ${cite}: ${sections.length} section files`)
    if (!sections.length) continue

    const CONC = 4
    for (let i = 0; i < sections.length; i += CONC) {
      if (i > 0) await new Promise((r) => setTimeout(r, 250)) // politeness
      const batch = sections.slice(i, i + CONC)
      const parsed = await Promise.all(
        batch.map(async (s) => {
          const url = `${HOST}/${spec.vol}/HRS${spec.ch}/${s.file}`
          try {
            return { p: parseSection(curl(url), s.number), url, s }
          } catch (e: any) {
            console.warn(`  ! ${cite} ${s.number}: ${e?.message || e}`)
            return { p: null, url, s }
          }
        })
      )
      for (const { p, url } of parsed) {
        if (!p || !p.text || p.text.length < 20) {
          skipped++
          continue
        }
        await query(
          `INSERT INTO state_law_section_texts
             (state_code, act_key, section_number, section_title, full_text, source_url, source_date, effective_year, law_category)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           ON CONFLICT (state_code, act_key, section_number, effective_year) DO NOTHING`,
          [STATE, category, p.number, p.title, p.text, url, SOURCE_DATE, EFFECTIVE_YEAR, category]
        )
        ok++
      }
      process.stdout.write(`\r  [${cite}] ${Math.min(i + CONC, sections.length)}/${sections.length}`)
    }
    process.stdout.write('\n')
  }
  console.log(`  ${category}: inserted ${ok}, skipped ${skipped}`)
  return ok
}

async function main() {
  console.log(`\n=== HI — ingesting non-tax real-estate full-text corpus (as of ${SOURCE_DATE}) ===`)
  const counts: Record<string, number> = {}
  for (const category of Object.keys(CATEGORIES)) {
    counts[category] = await ingestCategory(category)
  }
  const total = Object.values(counts).reduce((a, b) => a + b, 0)
  console.log(`\nHI done. inserted=${total}`, counts)
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
