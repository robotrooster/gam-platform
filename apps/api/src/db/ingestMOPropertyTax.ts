/**
 * Missouri property-tax statute full-text ingester (S472 corpus, sanctioned
 * retrieve+cite+date carve-out — verbatim codified text, never advice).
 *
 * Official source: the Missouri Revisor of Statutes (revisor.mo.gov), the .gov
 * legislature site serving verbatim codified RSMo over plain HTML (ASP.NET
 * WebForms, .aspx). raw_http — no JS/auth needed; a Mozilla UA is enough.
 *
 * Scope: Revised Statutes of Missouri (RSMo), Title X — Taxation and Revenue,
 * Chapters 137-141 (property assessment & taxation), grouped into five feature
 * topics that all land under a single act_key='property_tax':
 *   137  exemptions + assessment/levy of property taxes
 *   138  equalization & review of tax assessments (boards + State Tax Commission)
 *   139  payment & collection of current taxes (due dates, delinquency, penalties)
 *   140  collection of delinquent taxes generally (tax-lien sale, redemption, deed)
 *   141  delinquent taxes — certain subdivisions (land tax sale / land trust)
 * MO section numbers are globally unique across chapters (137.x vs 138.x …), so
 * one act_key with section_number as the natural key has no collision risk.
 *
 * Two-step crawl per chapter:
 *   (1) GET OneChapter.aspx?chapter=N — the chapter's full section index. Active
 *       sections are linked as PageSelect.aspx?section=N.NNN&bid=… ; repealed /
 *       transferred sections are NOT listed here, so the index already excludes
 *       them. We harvest the distinct N.NNN numbers.
 *   (2) GET OneSection.aspx?section=N.NNN — a standalone HTML page for the
 *       current version of that section.
 *
 * Section page layout (UTF-8): the operative text is a run of <p class="norm">
 * paragraphs inside a <div class="norm">.
 *   p[0]            = <span class="bold">NNN.NNN.  <Catchline>. — </span><body…>
 *                     The ENTIRE catchline (which may itself contain em-dashes
 *                     between clauses) is wrapped in the leading bold span; the
 *                     body begins immediately AFTER that span closes. We split on
 *                     the bold-span boundary, NOT on em-dashes, so multi-clause
 *                     catchlines stay intact.
 *   p[1..k]         = remaining body paragraphs (numbered/lettered subdivisions).
 *   first trailing  = the legislative-history / source note, which starts with
 *   "(" paragraph     "(RSMo …" / "(L. …" / "(A.L. …". Everything from there on
 *                     (Prior revisions, Effective date, "(YYYY) Case v. Case"
 *                     court annotations) is metadata, NOT statute.
 * We keep the verbatim body and append ONLY the history-note line + the
 * "Effective …" line as a dated source trailer (retrieve+cite+date requirement);
 * court annotations are dropped. The page header/nav, the histories table, and
 * the page footer live OUTSIDE <p class="norm">, so they never enter full_text.
 *
 * Run:  cd apps/api && node -r ts-node/register src/db/ingestMOPropertyTax.ts
 * Idempotent (ON CONFLICT DO NOTHING). Repealed/reserved/short(<20 char) bodies
 * are dropped.
 */

import { execFileSync } from 'child_process'
import { query } from './index'
import { stripTags } from './ingestStateLawCorpus'

const STATE = 'MO'
const ACT_KEY = 'property_tax'
const LAW_CATEGORY = 'property_tax'
const SOURCE_DATE = '2026-06-14'
const EFFECTIVE_YEAR = 2026
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) GAM-statute-ingest/1.0'
const BASE = 'https://revisor.mo.gov/main'
const CHAPTERS = [137, 138, 139, 140, 141]

const chapterUrl = (n: number) => `${BASE}/OneChapter.aspx?chapter=${n}`
const sectionUrl = (s: string) => `${BASE}/OneSection.aspx?section=${s}`

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

/**
 * Harvest the distinct section numbers (N.NNN) for a chapter from its
 * OneChapter index. Only active sections are linked (PageSelect.aspx?section=…),
 * so repealed/transferred sections are excluded at the source.
 */
function harvestSections(chapterHtml: string, chapter: number): string[] {
  const re = new RegExp(`PageSelect\\.aspx\\?section=(${chapter}\\.[0-9]+)`, 'g')
  const seen = new Set<string>()
  let m: RegExpExecArray | null
  while ((m = re.exec(chapterHtml)) !== null) seen.add(m[1])
  return [...seen].sort((a, b) => {
    const [, ax] = a.split('.')
    const [, bx] = b.split('.')
    return Number(ax) - Number(bx)
  })
}

/** A trailing paragraph that begins the legislative-history / metadata tail. */
function isHistoryNote(p: string): boolean {
  return /^\((?:RSMo|L\.|A\.L\.)\b/.test(p.trim())
}

/**
 * Parse a OneSection page. catchline+body live in <p class="norm"> paragraphs.
 * Returns null for a repealed / reserved / empty page.
 */
function parseSection(html: string, expectedNumber: string): Parsed | null {
  const rawParas = [...html.matchAll(/<p class="norm">([\s\S]*?)<\/p>/gi)].map((m) => m[1])
  if (rawParas.length === 0) return null

  // p[0]: the whole catchline is the leading <span class="bold">…</span>; the
  // body is everything after that span. Split on the bold-span boundary so a
  // multi-clause catchline (clauses joined by em-dashes) is not truncated.
  // The bold span nests an empty <span>  </span> between the section number and
  // the catchline ("137.115.<span>  </span>Real and personal…"); drop those
  // whitespace-only inner spans first so a non-greedy match of the outer span
  // does not stop at the nested </span>.
  const head = rawParas[0].replace(/<span>\s*<\/span>/gi, ' ')
  const numEsc = expectedNumber.replace('.', '\\.')
  let title: string | null = null
  let firstBody = ''
  const boldM = head.match(/<span class="bold">([\s\S]*?)<\/span>\s*([\s\S]*)$/i)
  if (boldM) {
    // Catchline = bold-span text minus the leading "NNN.NNN." citation and the
    // trailing " — " separator that introduces the body.
    let catch_ = stripTags(boldM[1], false).trim()
    catch_ = catch_.replace(new RegExp(`^${numEsc}\\.?\\s*`), '').trim()
    catch_ = catch_.replace(/\s*[—-]\s*$/, '').replace(/\.\s*$/, '').trim()
    title = catch_ || null
    firstBody = stripTags(boldM[2], false).trim()
  } else {
    // No bold span — fall back to em-dash split on the plain paragraph text.
    let first = stripTags(rawParas[0], false).replace(new RegExp(`^${numEsc}\\.?\\s*`), '').trim()
    const dashIdx = first.indexOf('—')
    if (dashIdx !== -1) {
      title = first.slice(0, dashIdx).replace(/\.\s*$/, '').trim() || null
      firstBody = first.slice(dashIdx + 1).trim()
    } else {
      firstBody = first
    }
  }

  // Remaining paragraphs (subdivisions + trailing history/metadata).
  const paras = rawParas.slice(1).map((p) => stripTags(p, false).trim()).filter(Boolean)

  if (title && /^repealed\b/i.test(title)) return null
  if (title && /^transferred\b/i.test(title)) return null
  if (title && /^\[?reserved\.?\]?$/i.test(title)) return null

  // Body = first-paragraph body + subsequent paragraphs, stopping at the first
  // legislative-history note. Append that history note (+ any "Effective …"
  // line) as a dated source trailer; drop court annotations and everything else.
  const bodyParts: string[] = []
  if (firstBody) bodyParts.push(firstBody)
  let historyNote: string | null = null
  let effectiveLine: string | null = null
  for (let i = 0; i < paras.length; i++) {
    const p = paras[i]
    if (historyNote === null) {
      if (isHistoryNote(p)) {
        historyNote = p
        continue
      }
      bodyParts.push(p)
    } else {
      // After the history note: capture the Effective line, ignore the rest.
      if (effectiveLine === null && /^Effective\b/i.test(p)) effectiveLine = p
    }
  }

  let text = bodyParts.join('\n').trim()
  if (!text || text.length < 20) return null
  if (/^\[?reserved\.?\]?$/i.test(text)) return null
  if (/^\(repealed/i.test(text)) return null

  const trailer: string[] = []
  if (historyNote) trailer.push(historyNote)
  if (effectiveLine) trailer.push(effectiveLine)
  if (trailer.length) text = `${text}\n\n${trailer.join('\n')}`

  return { number: expectedNumber, title, text }
}

async function ingestChapter(chapter: number): Promise<{ ok: number; skipped: number; total: number }> {
  const idx = curl(chapterUrl(chapter))
  const sections = harvestSections(idx, chapter)
  console.log(`\nch${chapter}: harvested ${sections.length} active sections`)
  let ok = 0
  let skipped = 0
  const CONC = 3
  for (let i = 0; i < sections.length; i += CONC) {
    if (i > 0) await new Promise((r) => setTimeout(r, 250)) // politeness
    const batch = sections.slice(i, i + CONC)
    const parsed = await Promise.all(
      batch.map(async (num) => {
        try {
          return { p: parseSection(curl(sectionUrl(num)), num), num }
        } catch (e: any) {
          console.warn(`  ! ${num}: ${e?.message || e}`)
          return { p: null, num }
        }
      })
    )
    for (const { p, num } of parsed) {
      if (!p || !p.text || p.text.length < 20) {
        skipped++
        continue
      }
      await query(
        `INSERT INTO state_law_section_texts
           (state_code, act_key, section_number, section_title, full_text, source_url, source_date, effective_year, law_category)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (state_code, act_key, section_number, effective_year) DO NOTHING`,
        [STATE, ACT_KEY, p.number, p.title, p.text, sectionUrl(num), SOURCE_DATE, EFFECTIVE_YEAR, LAW_CATEGORY]
      )
      ok++
    }
    process.stdout.write(`\r  ch${chapter} ${Math.min(i + CONC, sections.length)}/${sections.length}`)
  }
  console.log(`\n  ch${chapter}: inserted ${ok}, skipped ${skipped} of ${sections.length}`)
  return { ok, skipped, total: sections.length }
}

async function main() {
  console.log(`\n=== MO property-tax corpus (RSMo Ch.137-141) — as of ${SOURCE_DATE} ===`)
  const summary: Record<string, { ok: number; skipped: number; total: number }> = {}
  let grand = 0
  for (const ch of CHAPTERS) {
    try {
      const r = await ingestChapter(ch)
      summary[`ch${ch}`] = r
      grand += r.ok
    } catch (e: any) {
      console.error(`CHAPTER ${ch} FAILED: ${e?.message || e}`)
      summary[`ch${ch}`] = { ok: 0, skipped: 0, total: -1 }
    }
  }
  console.log(`\nMO done. inserted=${grand}`)
  console.table(summary)
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
