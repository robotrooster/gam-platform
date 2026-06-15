/**
 * Kentucky statute full-text ingester (S453 corpus — KRS Chapter 383).
 *
 * KY's official source (apps.legislature.ky.gov / LRC) serves each section as a
 * TEXT-BASED PDF behind a .aspx extension. The chapter index page lists every
 * section as <a href="statute.aspx?id=N">.NNN  Catchline.</a> — the leading-dot
 * number + catchline live in the link text, and that's the CLEANEST source for
 * section_number / section_title (the PDF catchline wraps across lines).
 *
 * Flow:
 *   1. Fetch the chapter index once; regex out (id, dotted-number, catchline)
 *      tuples. Skip "Repealed, YYYY." stubs without ever fetching their PDF.
 *   2. For each live section fetch statute.aspx?id=N (body begins %PDF), save to
 *      a tmp file, run `pdftotext -layout`. The body is everything after the
 *      "383.NNN Catchline." header line(s) and before the "Effective:"/"History:"
 *      trailer. We keep the (1)/(a) outline line breaks (statute readability) but
 *      normalize stray layout indentation.
 *
 * ACT MAPPING by number (only the 3 act_keys KRS 383 actually has — no separate
 * mobile-home/RV/self-storage/commercial L/T act in this chapter):
 *   general_landlord_tenant  = 383.010 – 383.199  (liens/distress/holdover/ordinance limits)
 *   eviction                 = 383.200 – 383.302  (forcible entry & detainer)
 *   residential              = 383.500 – 383.715  (URLTA — local-option; text stored regardless)
 *
 * Run: cd apps/api && node -r ts-node/register src/db/ingestKyStateLaw.ts
 * Idempotent (ON CONFLICT DO NOTHING). Re-run freely while iterating.
 */

import { execFileSync } from 'child_process'
import { writeFileSync, unlinkSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { query } from './index'
import { decodeEntities } from './ingestStateLawCorpus'

const STATE = 'KY'
const SOURCE_DATE = '2026-06-13'
const EFFECTIVE_YEAR = 2026
const INDEX_URL = 'https://apps.legislature.ky.gov/law/statutes/chapter.aspx?id=39159'
const SECTION_URL = (id: string) => `https://apps.legislature.ky.gov/law/statutes/statute.aspx?id=${id}`
const UA = 'GAM-statute-ingest/1.0 (compliance research)'

interface IndexEntry {
  id: string
  number: string // bare "383.NNN" (or "383.NNNX")
  title: string
}

/** Map a bare KRS 383 section number to its act_key, or null if out of range. */
function actKeyFor(number: string): string | null {
  const m = number.match(/^383\.(\d+)/)
  if (!m) return null
  const n = parseInt(m[1], 10) // 010 -> 10, 199 -> 199, 715 -> 715
  if (n >= 10 && n <= 199) return 'general_landlord_tenant'
  if (n >= 200 && n <= 302) return 'eviction'
  if (n >= 500 && n <= 715) return 'residential'
  return null
}

/** Parse the chapter index: one entry per <a href="statute.aspx?id=N">.NNN Catchline.</a>. */
function parseIndex(html: string): IndexEntry[] {
  const out: IndexEntry[] = []
  const re = /statute\.aspx\?id=(\d+)">\s*\.(\d+[A-Z]?)\s+([\s\S]*?)<\/a>/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) {
    const id = m[1]
    const number = `383.${m[2]}`
    const title = decodeEntities(m[3]).replace(/\s+/g, ' ').trim().replace(/\s*\.\s*$/, '')
    // Skip repealed / reserved stubs without fetching the PDF.
    if (/^repealed\b/i.test(title) || /^\[?reserved\.?\]?$/i.test(title) || title === '') continue
    out.push({ id, number, title })
  }
  return out
}

async function fetchBytes(url: string): Promise<Buffer> {
  // curl: the framework's TLS chain on these .gov sites is incomplete for
  // node fetch; curl handles it and gives us the raw PDF bytes.
  return execFileSync('curl', ['-sL', '--max-time', '45', '-A', UA, url], {
    maxBuffer: 64 * 1024 * 1024,
  })
}

async function fetchIndex(): Promise<string> {
  return (await fetchBytes(INDEX_URL)).toString('utf-8')
}

/**
 * Extract the operative statute body from the layout-preserved PDF text.
 * - Drop the "Effective:" / "History:" trailer (and any LRC page boilerplate).
 * - Drop the header: the "383.NNN <catchline>" line(s), which may wrap. We know
 *   the catchline from the index, so we consume leading lines until the
 *   accumulated header text has swallowed the full "383.NNN <catchline>".
 */
function extractBody(pdfText: string, entry: IndexEntry): string {
  const lines = pdfText.replace(/\r/g, '').split('\n')

  // 1. Cut the trailer: first line that is the Effective:/History: source note,
  //    or a "Page N of M" / "Legislative Research Commission" footer.
  let end = lines.length
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*(Effective:|History:|Legislative Research Commission|Page \d+ of \d+)/.test(lines[i])) {
      end = i
      break
    }
  }
  const bodyLines = lines.slice(0, end)

  // 2. Strip the header. The header is "383.NNN <catchline>." possibly wrapped
  //    across the first few lines. Consume lines until the normalized prefix
  //    contains the full normalized "<number> <catchline>".
  const wantPrefix = `${entry.number} ${entry.title}`.replace(/\s+/g, ' ').trim().toLowerCase()
  let acc = ''
  let startLine = 0
  for (let i = 0; i < bodyLines.length && i < 8; i++) {
    acc = (acc + ' ' + bodyLines[i]).replace(/\s+/g, ' ').trim()
    const accNorm = acc.toLowerCase()
    // accept once we've consumed at least up to the end of the catchline
    if (accNorm.startsWith(wantPrefix.slice(0, Math.min(wantPrefix.length, 60)))) {
      // Did this line carry the FULL catchline (or beyond)?
      if (accNorm.length >= wantPrefix.length || accNorm.includes(wantPrefix)) {
        startLine = i + 1
        // If the body proper started on the same line (header + text share a
        // line — rare with -layout), keep the remainder.
        const idx = accNorm.indexOf(wantPrefix)
        if (idx >= 0) {
          const consumed = wantPrefix.length
          const tail = acc.slice(idx + consumed).replace(/^[\s.]+/, '')
          if (tail.length > 0) {
            // overwrite this line with just the post-catchline remainder
            bodyLines[i] = tail
            startLine = i
          }
        }
        break
      }
    }
  }

  // Fallback: if we somehow didn't find the catchline (e.g. punctuation
  // mismatch), at least drop the first line carrying the bare section number.
  if (startLine === 0) {
    const numRe = new RegExp('^\\s*' + entry.number.replace('.', '\\.') + '\\b')
    if (bodyLines.length && numRe.test(bodyLines[0])) startLine = 1
  }

  const body = bodyLines.slice(startLine).join('\n')
  // Normalize: collapse the layout's run-of-spaces inside lines, trim trailing
  // spaces, drop empty leading/trailing lines and 3+ blank runs.
  return body
    .split('\n')
    .map((l) => l.replace(/[ \t]+/g, ' ').replace(/\s+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

async function main() {
  console.log(`\n=== ${STATE} — ingesting KRS Chapter 383 full-text (as of ${SOURCE_DATE}) ===`)
  const indexHtml = await fetchIndex()
  const entries = parseIndex(indexHtml)
  // keep only sections that map to one of our 3 act_keys
  const live = entries.filter((e) => actKeyFor(e.number) !== null)
  console.log(`Index: ${entries.length} non-repealed sections; ${live.length} in our act ranges.`)

  const counts: Record<string, number> = {}
  let ok = 0
  let skipped = 0
  const CONC = 3
  const tmpBase = join(tmpdir(), 'ky_statute_')

  for (let i = 0; i < live.length; i += CONC) {
    const batch = live.slice(i, i + CONC)
    const parsed = await Promise.all(
      batch.map(async (entry, j) => {
        const tmp = `${tmpBase}${i + j}.pdf`
        try {
          const bytes = await fetchBytes(SECTION_URL(entry.id))
          if (bytes.slice(0, 4).toString('latin1') !== '%PDF') {
            console.warn(`  ! ${entry.number} (id=${entry.id}): not a PDF (got ${bytes.slice(0, 16).toString('latin1')})`)
            return null
          }
          writeFileSync(tmp, bytes)
          const text = execFileSync('pdftotext', ['-layout', tmp, '-'], { maxBuffer: 32 * 1024 * 1024 }).toString('utf-8')
          const body = extractBody(text, entry)
          return { entry, body }
        } catch (e: any) {
          console.warn(`  ! ${entry.number} (id=${entry.id}): ${e?.message || e}`)
          return null
        } finally {
          try { unlinkSync(tmp) } catch {}
        }
      })
    )

    for (const p of parsed) {
      if (!p) { skipped++; continue }
      const { entry, body } = p
      if (!body || body.length < 25) {
        console.warn(`  ! ${entry.number}: body too short (${body?.length ?? 0} chars) — skipped`)
        skipped++
        continue
      }
      const actKey = actKeyFor(entry.number)!
      await query(
        `INSERT INTO state_law_section_texts
           (state_code, act_key, section_number, section_title, full_text, source_url, source_date, effective_year)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (state_code, act_key, section_number, effective_year) DO NOTHING`,
        [STATE, actKey, entry.number, entry.title, body, SECTION_URL(entry.id), SOURCE_DATE, EFFECTIVE_YEAR]
      )
      ok++
      counts[actKey] = (counts[actKey] || 0) + 1
    }
    process.stdout.write(`\r  ${Math.min(i + CONC, live.length)}/${live.length}`)
  }

  console.log(`\n${STATE} done. inserted/processed=${ok} skipped=${skipped}`, counts)
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
