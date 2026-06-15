/**
 * Wisconsin non-tax real-estate statute full-text ingester (S472 corpus).
 *
 * Sanctioned retrieve+cite+date carve-out: GAM stores the VERBATIM official
 * statute text in state_law_section_texts, searchable by the agent's
 * search_state_law tool. Posture unchanged — GAM retrieves + cites + dates +
 * disclaims, never advises. (See services/stateLaw.ts + migration headers.)
 *
 * SOURCE: docs.legis.wisconsin.gov — the official Wisconsin Legislature
 * statutes site. Plain raw-HTTP (no JS). Two URL shapes exist:
 *   - chapter TOC at /statutes/statutes/<CH> — lists every top-level section as
 *     <a href="/document/statutes/<CH>.<NN>">. Used here ONLY to enumerate the
 *     section numbers per chapter (the universal section index).
 *   - section text at /document/statutes/<CH>.<NN> — returns a WINDOW page of
 *     ~5-11 contiguous sections (the requested one roughly centered). This is
 *     the universal, subchapter-agnostic fetch URL (works for Ch.779's
 *     subchaptered sections where /statutes/statutes/779/01 404s). Windows
 *     overlap; we extract every section block on each page and dedupe via
 *     ON CONFLICT, fetching only enough windows to cover all enumerated sections.
 *
 * PAGE LAYOUT (root <div id="document" class="statutes">): every section is a
 * run of sibling block <div>s sharing one data-section="<CH>.<NN>" attribute:
 *   <div class="qsatxt_1sect ...">   number (qsnum_sect span) + title
 *                                    (qstitle_sect span) + any single-paragraph
 *                                    body text — all inside <span class="qstr">.
 *   <div class="qsatxt_2subsect">    (1) subsection body
 *   <div class="qsatxt_3para">       (a) paragraph body
 *   <div class="qsatxt_4subdiv">     1. subdivision body
 *   <div class="qsnote_history">     "History: <act cites>" source note.
 * ALL verbatim statute text lives in <span class="qstr"> spans; page chrome
 * (per-section "Details" modal, navigation arrows, footer, scripts) carries NO
 * qstr spans, so extracting qstr-only text is bulletproof against chrome. The
 * leading <a class="reference"> in each block (a duplicate of the line number)
 * is NOT a qstr span and is naturally excluded. The History note is retained as
 * a trailing source-note trailer (spec allows the source note).
 *
 * CATEGORY -> CHAPTER MAPPING (act_key == law_category for each):
 *   conveyancing_title        = Ch.706 (Conveyances; Recording; Titles)
 *   condo_coop                = Ch.703 (Condominiums) + Ch.185 (Cooperatives)
 *                               + Ch.193 (Unincorporated Cooperative Assns)
 *   broker_licensing          = Ch.452 (Real Estate Practice)
 *   mortgage_lien_foreclosure = Ch.846 (Real Estate Foreclosure) + Ch.779
 *                               (Liens) + s.706.11 (mortgage priority)
 *   general_real_property     = Ch.700 (Interests in Property) + Ch.704
 *                               (Landlord & Tenant) + Ch.710 (Misc. Property)
 *                               + s.893.25-893.27 (adverse-possession limits)
 *
 * Run:  cd apps/api && node -r ts-node/register src/db/ingestWIRealEstate.ts
 * Idempotent (ON CONFLICT DO NOTHING). Repealed/reserved/empty(<20 char) bodies
 * and pure TOC/nav/chrome are dropped.
 */

import { execFileSync } from 'child_process'
import { query } from './index'

const STATE = 'WI'
const SOURCE_DATE = '2026-06-14'
const EFFECTIVE_YEAR = 2026
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) GAM-statute-ingest/1.0'
const BASE = 'https://docs.legis.wisconsin.gov'
const tocUrl = (ch: string) => `${BASE}/statutes/statutes/${ch}`
const secUrl = (num: string) => `${BASE}/document/statutes/${num}`

interface Parsed {
  number: string
  title: string | null
  text: string
  url: string
}

function curl(url: string): string {
  const buf = execFileSync('curl', ['-sL', '--max-time', '90', '-A', UA, url], {
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

/** Concatenate the text of every <span class="qstr"> in `html`, in order. */
function qstrText(html: string): string {
  const parts = [...html.matchAll(/<span class="qstr"[^>]*>([\s\S]*?)<\/span>/gi)].map((m) =>
    m[1].replace(/<[^>]+>/g, '')
  )
  let s = decodeEntities(parts.join(' '))
  s = s
    .replace(/[  -   　]/g, ' ')
    .replace(/\r/g, '')
    .replace(/[ \t]+/g, ' ')
  return s.trim()
}

/** Numeric sort key for a "CH.NN" / "CH.NNN" citation (sorts 706.05 < 706.055 < 706.057 < 706.06). */
function sortKey(num: string): number {
  const dot = num.indexOf('.')
  if (dot < 0) return parseFloat(num)
  const whole = parseInt(num.slice(0, dot), 10)
  // decimal part compared lexically-as-fraction so 055 < 06 < 065 sort correctly
  const frac = num.slice(dot + 1)
  return whole + parseFloat('0.' + frac)
}

/**
 * Enumerate every top-level section number for a chapter from its TOC page.
 * Top-level anchors are /document/statutes/<CH>.<NN> with NO subsection paren.
 */
function enumerateSections(ch: string): string[] {
  const html = curl(tocUrl(ch))
  const re = new RegExp(`href="/document/statutes/(${ch}\\.[0-9]+)"`, 'g')
  const seen = new Set<string>()
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) seen.add(m[1])
  return [...seen].sort((a, b) => sortKey(a) - sortKey(b))
}

/**
 * Parse a /document/statutes/<CH>.<NN> window page into ALL section blocks it
 * contains. Groups consecutive sibling block divs by their data-section, then
 * for each: number from qsnum_sect, title from qstitle_sect, body = qstr text
 * of every block with the leading "<number> <title>" prefix stripped (history
 * note retained as trailing source-note). Returns one Parsed per real section;
 * skips repealed/reserved/empty(<20 char).
 */
function parseWindow(html: string): Parsed[] {
  const docSplit = html.split('<div id="document"')
  if (docSplit.length < 2) return []
  const doc = docSplit[1]

  // Locate every block-opening div (qsatxt_* or qsnote_history) with data-section.
  // Match EVERY qsatxt_* / qsnote_* block as a delimiter so each is sliced
  // cleanly at its own boundary. We later keep only qsatxt_* (statute body) +
  // qsnote_history (source note); qsnote_annot / qsnote_cross / qsnote_note etc.
  // are editorial case-law annotations & cross-references — NOT statute text —
  // and are dropped (their qstr spans hold only "<num> Annotation" labels).
  const opens: { pos: number; cls: string; sec: string }[] = []
  const re = /<div class="(qsatxt_[^"]*|qsnote_[^"]*)"[^>]*data-section="([^"]+)"/g
  let m: RegExpExecArray | null
  while ((m = re.exec(doc)) !== null) {
    opens.push({ pos: m.index, cls: m[1].split(/\s+/)[0], sec: m[2] })
  }

  // Slice each block from its open to the next block-open (or doc end).
  const blocks = opens.map((o, i) => ({
    cls: o.cls,
    sec: o.sec,
    html: doc.slice(o.pos, i + 1 < opens.length ? opens[i + 1].pos : doc.length),
  }))

  // Group consecutive blocks by section, keeping only statute body + history.
  const groups = new Map<string, { cls: string; html: string }[]>()
  for (const b of blocks) {
    if (!(b.cls.startsWith('qsatxt_') || b.cls === 'qsnote_history')) continue
    if (!groups.has(b.sec)) groups.set(b.sec, [])
    groups.get(b.sec)!.push({ cls: b.cls, html: b.html })
  }

  const out: Parsed[] = []
  for (const [sec, blks] of groups) {
    const sectBlk = blks.find((b) => b.cls === 'qsatxt_1sect')
    if (!sectBlk) continue // a stray history-only fragment from window overlap

    // number (qsnum_sect) + title (qstitle_sect)
    const numM = sectBlk.html.match(/<span class="qsnum_sect">[\s\S]*?<\/span><\/span>/)
    const number = numM ? qstrText(numM[0]) || sec : sec
    const titleM = sectBlk.html.match(/<span class="qstitle_sect">[\s\S]*?<\/span><\/span>/)
    let title: string | null = titleM ? qstrText(titleM[0]).trim() : null
    if (title === '') title = null

    // Drop repealed / reserved sections (signalled in the title).
    if (title && /^repealed\b/i.test(title)) continue
    if (title && /^\[?reserved\.?\]?$/i.test(title)) continue

    // Full text = qstr of every block joined; strip the leading "<num> <title>".
    let full = blks.map((b) => qstrText(b.html)).join(' ').replace(/\s+/g, ' ').trim()
    // Remove a leading exact "<number> <title>" prefix (the section heading line).
    const heading = (number + (title ? ' ' + title : '')).trim()
    if (heading && full.startsWith(heading)) {
      full = full.slice(heading.length).trim()
    } else if (full.startsWith(number)) {
      full = full.slice(number.length).trim()
    }

    if (!full || full.length < 20) continue
    if (/^\[?reserved\.?\]?$/i.test(full)) continue

    out.push({ number, title, text: full, url: secUrl(sec) })
  }
  return out
}

/**
 * Ingest one category (act_key) by walking its chapters. For each chapter we
 * enumerate its sections, then fetch overlapping window pages, marking sections
 * covered so we fetch the minimum number of windows. `sectionFilter` restricts
 * to a numeric range (used for s.706.11 and s.893.25-893.27 carve-ins).
 */
async function ingestCategory(
  cat: string,
  chapters: { ch: string; filter?: (num: string) => boolean }[]
): Promise<number> {
  let inserted = 0
  for (const { ch, filter } of chapters) {
    let secs = enumerateSections(ch)
    if (filter) secs = secs.filter(filter)
    if (secs.length === 0) {
      console.warn(`  ! [${cat}] Ch.${ch}: enumerated 0 sections`)
      continue
    }
    console.log(`  [${cat}] Ch.${ch}: ${secs.length} sections enumerated`)

    const remaining = new Set(secs)
    const wanted = new Set(secs)
    let fetches = 0
    for (const sec of secs) {
      if (!remaining.has(sec)) continue // already covered by an earlier window
      fetches++
      let parsed: Parsed[]
      try {
        parsed = parseWindow(curl(secUrl(sec)))
      } catch (e: any) {
        console.warn(`  ! [${cat}] ${sec}: fetch/parse failed: ${e?.message || e}`)
        remaining.delete(sec)
        continue
      }
      for (const p of parsed) {
        if (!wanted.has(p.number)) continue // window overflow outside our target set
        remaining.delete(p.number)
        await query(
          `INSERT INTO state_law_section_texts
             (state_code, act_key, section_number, section_title, full_text,
              source_url, source_date, effective_year, law_category)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
           ON CONFLICT (state_code, act_key, section_number, effective_year) DO NOTHING`,
          [STATE, cat, p.number, p.title, p.text, p.url, SOURCE_DATE, EFFECTIVE_YEAR, cat]
        )
        inserted++
      }
      await new Promise((r) => setTimeout(r, 250)) // politeness
    }
    if (remaining.size > 0) {
      console.warn(`  ! [${cat}] Ch.${ch}: ${remaining.size} sections never resolved: ${[...remaining].join(', ')}`)
    }
    console.log(`  [${cat}] Ch.${ch}: ${fetches} window fetches`)
  }
  console.log(`[${cat}] inserted ${inserted}`)
  return inserted
}

async function main() {
  console.log(`\n=== WI — ingesting non-tax real-estate statute corpus (as of ${SOURCE_DATE}) ===`)

  const counts: Record<string, number> = {}

  counts['conveyancing_title'] = await ingestCategory('conveyancing_title', [{ ch: '706' }])

  counts['condo_coop'] = await ingestCategory('condo_coop', [
    { ch: '703' },
    { ch: '185' },
    { ch: '193' },
  ])

  counts['broker_licensing'] = await ingestCategory('broker_licensing', [{ ch: '452' }])

  counts['mortgage_lien_foreclosure'] = await ingestCategory('mortgage_lien_foreclosure', [
    { ch: '846' },
    { ch: '779' },
    // mortgage formation/priority carve-in: s.706.11 only
    { ch: '706', filter: (n) => n === '706.11' },
  ])

  counts['general_real_property'] = await ingestCategory('general_real_property', [
    { ch: '700' },
    { ch: '704' },
    { ch: '710' },
    // adverse-possession limitation periods: s.893.25-893.27 only
    { ch: '893', filter: (n) => sortKeyInRange(n, 893.25, 893.27) },
  ])

  const total = Object.values(counts).reduce((a, b) => a + b, 0)
  console.log(`\nWI done. inserted=${total}`, counts)
  process.exit(0)
}

/** True if "CH.NN" numerically falls within [lo, hi] inclusive (893.25..893.27). */
function sortKeyInRange(num: string, lo: number, hi: number): boolean {
  const v = parseFloat(num)
  return Number.isFinite(v) && v >= lo && v <= hi
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
