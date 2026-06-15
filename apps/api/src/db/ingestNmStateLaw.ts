/**
 * New Mexico landlord-tenant statute ingester (NMSA Ch. 47 Art. 8 — Uniform
 * Owner-Resident Relations Act). Bucket-B "walled" state cracked S-state-law:
 * nmonesource.com (the official NM Compilation Commission source) is a Lexum/
 * Qweri SPA, but its content chunk API is anonymously curlable and returns the
 * verbatim statute as JSON `htmlContent`. No login, no CAPTCHA.
 *
 *   Chapter 47 = Qweri docId 1534337. Section headers render as
 *   <a name="47-8-N">47-8-N. Catchline.</a>; statutory body = <p class="statutes">
 *   paragraphs up to <p class="history"> / <p class="annotations"> (annotations
 *   dropped — corpus stores statute text only). source_date = the doc's
 *   documentFragmentsUploadDate.
 *
 * Run: cd apps/api && node -r ts-node/register src/db/ingestNmStateLaw.ts [--dry]
 * Upsert (ON CONFLICT DO UPDATE) so re-runs refresh.
 */
import { query } from './index'

const STATE = 'NM'
const DOC = '1534337'
const ACT_KEY = 'residential' // NMSA Ch 47 Art 8 = Uniform Owner-Resident Relations Act
const LAW_CATEGORY = 'landlord_tenant'
const EFFECTIVE_YEAR = 2026
const BASE = `https://nmonesource.com/w/nmos/${DOC}`
const REFERER = 'https://nmonesource.com/nmos/nmsa/en/item/4408/index.do'
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
  'X-Requested-With': 'XMLHttpRequest',
  Referer: REFERER,
}

interface Chunk {
  htmlContent: string
  nextChunkFirstAnchorText: string | null
  documentFragmentsUploadDate: string
}

async function fetchChunk(anchor: string): Promise<Chunk> {
  const url = `${BASE}/document/chunk/getContentByDocumentFragmentAnchorText?anchorText=${encodeURIComponent(anchor)}&textToSearch=`
  const res = await fetch(url, { headers: HEADERS })
  if (!res.ok) throw new Error(`chunk ${anchor}: HTTP ${res.status}`)
  return (await res.json()) as Chunk
}

/** Anchor for "47-8-1. Short title." from the doc's TOC (includes.js). */
async function articleStartAnchor(): Promise<string> {
  const res = await fetch(`${BASE}/includes.js`, { headers: HEADERS })
  if (!res.ok) throw new Error(`includes.js: HTTP ${res.status}`)
  const js = await res.text()
  // Objects pair "anchorText":"…" then "title":"47-8-N. …".
  const re = /"anchorText"\s*:\s*"([^"]+)"[^}]*?"title"\s*:\s*"(47-8-1\.\s)/
  const m = re.exec(js)
  if (!m) throw new Error('could not find 47-8-1 anchor in includes.js')
  return m[1]
}

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;|&#160;/g, ' ')
    .replace(/&#167;|&sect;/g, '§')
    .replace(/&#8212;|&mdash;/g, '—')
    .replace(/&#8211;|&ndash;/g, '–')
    .replace(/&#8217;|&rsquo;/g, '’')
    .replace(/&#8216;|&lsquo;/g, '‘')
    .replace(/&#8220;|&ldquo;/g, '“')
    .replace(/&#8221;|&rdquo;/g, '”')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
}

function stripToText(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, ' '))
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

interface Sec { number: string; title: string | null; text: string }

/** Split combined chunk HTML into Article-8 sections; statutory body only. */
function parseSections(html: string): Sec[] {
  // Section header anchor carries the bare number + "N. Catchline." visible text.
  const headRe = /<a name="(47-8-\d+(?:\.\d+)?)">\s*47-8-[\d.]+\.\s*([^<]*?)<\/a>/g
  const heads: { num: string; title: string; idx: number; end: number }[] = []
  let m: RegExpExecArray | null
  while ((m = headRe.exec(html)) !== null) {
    heads.push({ num: m[1], title: m[2].replace(/\.\s*$/, '').trim(), idx: m.index, end: m.index + m[0].length })
  }
  const byNum = new Map<string, Sec>()
  for (let i = 0; i < heads.length; i++) {
    let body = html.slice(heads[i].end, i + 1 < heads.length ? heads[i + 1].idx : undefined)
    // Statute text only: cut at history / annotations blocks.
    const cut = body.search(/<p class="history"|<p class="annotations"|>ANNOTATIONS</)
    if (cut >= 0) body = body.slice(0, cut)
    const text = stripToText(body)
    if (text.length < 20) continue
    const prev = byNum.get(heads[i].num)
    if (!prev || text.length > prev.text.length) {
      byNum.set(heads[i].num, { number: heads[i].num, title: heads[i].title || null, text })
    }
  }
  return [...byNum.values()]
}

async function main() {
  const dry = process.argv.includes('--dry')
  console.log(`\n=== NM — NMSA Ch 47 Art 8 via nmonesource Qweri API${dry ? ' (DRY RUN)' : ''} ===`)
  const start = await articleStartAnchor()
  let anchor: string | null = start
  let html = ''
  let sourceDate = ''
  const seen = new Set<string>()
  for (let i = 0; i < 30 && anchor && !seen.has(anchor); i++) {
    seen.add(anchor)
    const chunk: Chunk = await fetchChunk(anchor)
    if (!sourceDate) sourceDate = (chunk.documentFragmentsUploadDate || '').slice(0, 10)
    html += chunk.htmlContent
    // Stop once this chunk has moved past Article 8 (no 47-8-N header present
    // and we've already collected some) — the next article (47-8A / 47-9) follows.
    const has478 = /<a name="47-8-\d/.test(chunk.htmlContent)
    if (!has478 && html.length > chunk.htmlContent.length) break
    anchor = chunk.nextChunkFirstAnchorText
  }
  const secs = parseSections(html).filter((s) => /^47-8-\d+(?:\.\d+)?$/.test(s.number))
  secs.sort((a, b) => {
    const pa = a.number.split('-').map(Number), pb = b.number.split('-').map(Number)
    return pa[2] - pb[2]
  })
  const url = `${REFERER}`
  console.log(`collected ${secs.length} sections; source_date=${sourceDate}`)
  if (dry) {
    for (const s of secs.slice(0, 6)) console.log(`  [${s.number}] ${s.title}\n     ${s.text.slice(0, 90).replace(/\n/g, ' ')}…`)
    console.log(`  …(${secs.length} total). nulls=${secs.filter((s) => !s.title).length}`)
    process.exit(0)
  }
  let n = 0
  for (const s of secs) {
    await query(
      `INSERT INTO state_law_section_texts
         (state_code, act_key, section_number, section_title, full_text, source_url, source_date, effective_year, law_category)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (state_code, act_key, section_number, effective_year)
       DO UPDATE SET section_title = EXCLUDED.section_title, full_text = EXCLUDED.full_text,
                     source_url = EXCLUDED.source_url, source_date = EXCLUDED.source_date,
                     law_category = EXCLUDED.law_category`,
      [STATE, ACT_KEY, s.number, s.title, s.text, url, sourceDate, EFFECTIVE_YEAR, LAW_CATEGORY]
    )
    n++
  }
  console.log(`NM done. upserted=${n}`)
  process.exit(0)
}

main().catch((e) => { console.error(e); process.exit(1) })
