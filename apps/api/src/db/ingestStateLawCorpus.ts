/**
 * Reusable, config-driven full-text statute ingester for the state-law corpus
 * (S453 — the nationwide scale-up of the AZ/NV one-offs).
 *
 * Mandate (Nic): the agent should know ALL landlord/tenant law for EVERY state,
 * deep enough to converse at expert level — so we store the VERBATIM text of
 * every section of every landlord/tenant act per state in
 * state_law_section_texts, searchable via the agent's search_state_law tool.
 * (Posture unchanged: GAM retrieves + cites + dates + disclaims — never advises.
 *  See services/stateLaw.ts + the migration headers.)
 *
 * Every state's official legislature site has its own HTML, so this file holds
 * a per-state CONFIG (the only thing that changes per state) on top of shared
 * fetch/decode/insert/concurrency/idempotency plumbing + two format-family
 * paths:
 *   - kind:'whole'    — one page per chapter holding every section (NV/TX/FL
 *                       style); a parse() splits it into sections. PREFERRED —
 *                       no section enumeration needed.
 *   - kind:'sections' — one page per section (AZ style); parseOne() per page.
 *
 * Run:  cd apps/api && node -r ts-node/register src/db/ingestStateLawCorpus.ts <STATE>
 * Idempotent (ON CONFLICT DO NOTHING). AZ + NV keep their standalone scripts
 * (already ingested); new states land here.
 */

import { execFileSync } from 'child_process'
import { query } from './index'

const EFFECTIVE_YEAR = 2026

export interface ParsedSection {
  number: string
  title: string | null
  text: string
}

type ActSpec =
  | {
      actKey: string
      kind: 'whole'
      urls: string[]
      encoding?: 'utf-8' | 'windows-1252'
      render?: boolean // fetch via headless Chromium (JS-SPA / Cloudflare sites)
      parse: (html: string, url: string) => ParsedSection[]
    }
  | {
      actKey: string
      kind: 'sections'
      sectionUrls: string[]
      encoding?: 'utf-8' | 'windows-1252'
      concurrency?: number
      render?: boolean
      parseOne: (html: string, url: string) => ParsedSection | null
    }

interface StateSpec {
  state: string
  sourceDate: string // ISO; the date we read the official site
  acts: ActSpec[]
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Decode HTML entities only (no tag handling). */
export function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    // Common NAMED entities that appear in official statute HTML (esp. the AL
    // Legislature feed, which uses &sect; heavily in history/source-act cites and
    // §-references inside section bodies). Strictly additive — these were
    // previously left raw in stored full_text. Decode BEFORE collapsing &amp;
    // so double-encoded "&amp;sect;" resolves correctly.
    .replace(/&sect;/gi, '§') // §
    .replace(/&para;/gi, '¶') // ¶
    .replace(/&deg;/gi, '°') // °
    .replace(/&mdash;/gi, '—') // —
    .replace(/&ndash;/gi, '–') // –
    .replace(/&rsquo;/gi, '’') // ’
    .replace(/&lsquo;/gi, '‘') // ‘
    .replace(/&ldquo;/gi, '“') // “
    .replace(/&rdquo;/gi, '”') // ”
    .replace(/&hellip;/gi, '…') // …
    .replace(/&frac12;/gi, '½') // ½
    .replace(/&frac14;/gi, '¼') // ¼
    .replace(/&frac34;/gi, '¾') // ¾
    .replace(/&times;/gi, '×') // ×
    .replace(/&plusmn;/gi, '±') // ±
    .replace(/&middot;/gi, '·') // ·
    .replace(/&dollar;/gi, '$')
    .replace(/&apos;/gi, "'")
    .replace(/&amp;/gi, '&')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
}

/**
 * Strip tags → readable text. Converts block-closing tags to newlines so
 * paragraph structure survives, decodes entities, normalizes whitespace +
 * unicode spaces. `keepBreaks=false` collapses everything to single spaces.
 */
export function stripTags(html: string, keepBreaks = true): string {
  let s = html
  // Drop script/style blocks entirely — their CONTENT is not statute text and
  // would otherwise survive tag-stripping (e.g. trailing $(document).ready(...)).
  s = s.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
  if (keepBreaks) {
    s = s.replace(/<\/(p|div|li|tr|h[1-6]|section)>/gi, '\n').replace(/<br\s*\/?>/gi, '\n')
  }
  s = s.replace(/<[^>]+>/g, ' ')
  s = decodeEntities(s)
  s = s
    .replace(/[        ]/g, ' ') // unicode spaces incl em-space
    .replace(/\r/g, '')
    .replace(/[ \t]+/g, ' ')
  s = keepBreaks ? s.replace(/ ?\n ?/g, '\n').replace(/\n{3,}/g, '\n\n') : s.replace(/\s+/g, ' ')
  return s.trim()
}

const FETCH_UA = 'GAM-statute-ingest/1.0 (compliance research)'

// Lazy singleton headless browser, reused across render() calls for speed.
let _browser: any = null
async function getBrowser(): Promise<any> {
  if (_browser) return _browser
  const { chromium } = require('playwright')
  _browser = await chromium.launch({ headless: true })
  return _browser
}
async function closeBrowser(): Promise<void> {
  if (_browser) {
    try { await _browser.close() } catch {}
    _browser = null
  }
}

/** Render a JS-heavy / Cloudflare-protected page to its post-JS DOM HTML. */
async function renderDoc(url: string): Promise<string> {
  const browser = await getBrowser()
  const page = await browser.newPage({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36' })
  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 })
    await page.waitForTimeout(2500) // settle late content / CF challenge
    return await page.content()
  } finally {
    await page.close()
  }
}

async function fetchDoc(url: string, encoding: string = 'utf-8', render = false): Promise<string> {
  if (render) return renderDoc(url)
  try {
    const res = await fetch(url, { headers: { 'User-Agent': FETCH_UA } })
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`)
    if (encoding && encoding !== 'utf-8') return new TextDecoder(encoding).decode(await res.arrayBuffer())
    return res.text()
  } catch (e) {
    // Fallback: several official .gov sites serve an incomplete TLS chain that
    // node's fetch rejects (UNABLE_TO_VERIFY_LEAF_SIGNATURE) though curl accepts
    // it. Shell out to curl and decode at the requested encoding.
    const buf = execFileSync('curl', ['-sL', '--max-time', '45', '-A', FETCH_UA, url], {
      maxBuffer: 128 * 1024 * 1024,
    })
    return new TextDecoder(encoding || 'utf-8').decode(buf)
  }
}

async function insertSections(
  state: string,
  actKey: string,
  secs: ParsedSection[],
  sourceUrl: string,
  sourceDate: string
): Promise<{ ok: number; skipped: number }> {
  let ok = 0
  let skipped = 0
  for (const s of secs) {
    if (!s.number || !s.text || s.text.length < 20) {
      skipped++
      continue
    }
    await query(
      `INSERT INTO state_law_section_texts
         (state_code, act_key, section_number, section_title, full_text, source_url, source_date, effective_year)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (state_code, act_key, section_number, effective_year) DO NOTHING`,
      [state, actKey, s.number, s.title, s.text, sourceUrl, sourceDate, EFFECTIVE_YEAR]
    )
    ok++
  }
  return { ok, skipped }
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

export async function runState(spec: StateSpec): Promise<void> {
  console.log(`\n=== ${spec.state} — ingesting full-text corpus (as of ${spec.sourceDate}) ===`)
  const counts: Record<string, number> = {}
  let total = 0

  for (const act of spec.acts) {
    if (act.kind === 'whole') {
      for (const url of act.urls) {
        try {
          const html = await fetchDoc(url, act.encoding, act.render)
          const secs = act.parse(html, url)
          const { ok, skipped } = await insertSections(spec.state, act.actKey, secs, url, spec.sourceDate)
          counts[act.actKey] = (counts[act.actKey] || 0) + ok
          total += ok
          console.log(`  [${act.actKey}] ${url.split('/').slice(-2).join('/')} → parsed ${secs.length}, inserted ${ok}, skipped ${skipped}`)
        } catch (e: any) {
          console.warn(`  ! ${act.actKey} ${url}: ${e?.message || e}`)
        }
      }
    } else {
      const concurrency = act.concurrency ?? 6
      let ok = 0
      for (let i = 0; i < act.sectionUrls.length; i += concurrency) {
        const batch = act.sectionUrls.slice(i, i + concurrency)
        const parsed = await Promise.all(
          batch.map(async (u) => {
            try {
              const html = await fetchDoc(u, act.encoding, act.render)
              return { sec: act.parseOne(html, u), url: u }
            } catch (e: any) {
              console.warn(`  ! ${act.actKey} ${u}: ${e?.message || e}`)
              return { sec: null, url: u }
            }
          })
        )
        for (const { sec, url } of parsed) {
          if (!sec) continue
          const r = await insertSections(spec.state, act.actKey, [sec], url, spec.sourceDate)
          ok += r.ok
        }
        process.stdout.write(`\r  [${act.actKey}] ${Math.min(i + concurrency, act.sectionUrls.length)}/${act.sectionUrls.length}`)
      }
      counts[act.actKey] = (counts[act.actKey] || 0) + ok
      total += ok
      console.log(`\n  [${act.actKey}] inserted ${ok} of ${act.sectionUrls.length} section pages`)
    }
  }

  await closeBrowser()
  console.log(`\n${spec.state} done. inserted=${total}`, counts)
}

// ---------------------------------------------------------------------------
// Per-state parsers
// ---------------------------------------------------------------------------

/**
 * Florida (flsenate.gov ".../ChapterNN/All"): clean semantic markup —
 * <div class="Section"><span class="SectionNumber">83.49&#x2003;</span>
 *   <span class="Catchline">…<span class="CatchlineText">Title.</span>…</span>
 *   <span class="SectionBody">… body …</span> …</div>
 * `actKeyForNumber` routes each section to the right act_key by section-number
 * range (Ch 83 mixes commercial / residential / self-storage parts in one page).
 */
function parseFlAll(actKeyForNumber: (num: string) => string | null) {
  return (html: string): ParsedSection[] => {
    const out: ParsedSection[] = []
    const blocks = html.split(/<div class="Section">/).slice(1)
    for (const b of blocks) {
      const chunk = b.slice(0, b.indexOf('</div></div>') >= 0 ? b.indexOf('</div></div>') + 6 : b.length)
      const numM = chunk.match(/<span class="SectionNumber">([\s\S]*?)<\/span>/i)
      if (!numM) continue
      const number = stripTags(numM[1], false).replace(/\s+/g, '')
      if (!/^\d/.test(number)) continue
      const titleM = chunk.match(/<span[^>]*class="CatchlineText"[^>]*>([\s\S]*?)<\/span>/i)
      const title = titleM ? stripTags(titleM[1], false).replace(/\.\s*$/, '') || null : null
      const bodyM = chunk.match(/<span class="SectionBody">([\s\S]*?)<\/span><div class="History"/i)
      const bodyRaw = bodyM ? bodyM[1] : (chunk.match(/<span class="SectionBody">([\s\S]*?)$/i)?.[1] ?? '')
      const text = stripTags(bodyRaw, true)
      out.push({ number, title, text })
    }
    // route by act range — caller maps ranges to act_keys, returns null to drop
    return out.filter((s) => actKeyForNumber(s.number) !== null)
  }
}

/**
 * California (leginfo.legislature.ca.gov "codes_displayText.xhtml"): the whole
 * chapter renders on one page inside <div id="manylawsections">. Each section
 * is <h6 ...><a onclick="...">1950.5.</a></h6> followed by the body <p>s until
 * the next <h6>. CA statutes carry no catchline titles, so section_title=null.
 */
function parseCaDisplayText(html: string): ParsedSection[] {
  const start = html.indexOf('manylawsections')
  const region = start >= 0 ? html.slice(start) : html
  const headerRe = /<h6[^>]*>\s*<a[^>]*>\s*([0-9][0-9.]*?)\.?\s*<\/a>\s*<\/h6>/gi
  const heads: { num: string; end: number; start: number }[] = []
  let m: RegExpExecArray | null
  while ((m = headerRe.exec(region)) !== null) {
    heads.push({ num: m[1], start: m.index, end: m.index + m[0].length })
  }
  const out: ParsedSection[] = []
  for (let i = 0; i < heads.length; i++) {
    const bodyRaw = region.slice(heads[i].end, i + 1 < heads.length ? heads[i + 1].start : undefined)
    const text = stripTags(bodyRaw, true)
    out.push({ number: heads[i].num, title: null, text })
  }
  return out
}

// ---------------------------------------------------------------------------
// Config registry
// ---------------------------------------------------------------------------

const FL_DATE = '2026-06-12'
// Florida Statutes 2024 — landlord/tenant chapters.
// Ch 83: Part I Nonresidential 83.001–83.251 (commercial); Part II Residential
// 83.40–83.682; Part III Self-service storage 83.801–83.809.
// Ch 723: Mobile Home Park Lot Tenancies. Ch 513: Mobile Home & RV Parks.
function flCh83Act(num: string): string | null {
  const n = parseFloat(num)
  if (!Number.isFinite(n)) return null
  if (n >= 83.001 && n <= 83.251) return 'commercial'
  if (n >= 83.4 && n <= 83.682) return 'residential'
  if (n >= 83.8 && n <= 83.809) return 'self_storage'
  return null
}

const CA_DATE = '2026-06-12'
const caUrl = (q: string) => `https://leginfo.legislature.ca.gov/faces/codes_displayText.xhtml?lawCode=CIV&${q}`

const CONFIGS: Record<string, StateSpec> = {
  CA: {
    state: 'CA',
    sourceDate: CA_DATE,
    // Civil Code landlord/tenant chapters (verbatim whole-chapter render).
    acts: [
      {
        // Hiring of Real Property — §§1940–1954.071 (deposits 1950.5, entry
        // 1954, habitability 1941.x, retaliation 1942.5, just-cause/rent-cap
        // 1946.2 / 1947.12). Division 3, Part 4, Title 5, Chapter 2.
        actKey: 'residential',
        kind: 'whole',
        urls: [caUrl('division=3.&title=5.&part=4.&chapter=2.&article=')],
        parse: parseCaDisplayText,
      },
      {
        // Mobilehome Residency Law — §§798–799.13. Div 2, Part 2, Title 2, Ch 2.5.
        actKey: 'mobile_home_park',
        kind: 'whole',
        urls: [caUrl('division=2.&title=2.&part=2.&chapter=2.5.&article=')],
        parse: parseCaDisplayText,
      },
      {
        // Recreational Vehicle Park Occupancy Law — §§799.20–799.79. Ch 2.6.
        actKey: 'rv_park',
        kind: 'whole',
        urls: [caUrl('division=2.&title=2.&part=2.&chapter=2.6.&article=')],
        parse: parseCaDisplayText,
      },
    ],
  },
  FL: {
    state: 'FL',
    sourceDate: FL_DATE,
    acts: [
      // Ch 83 carries 3 act_keys; we fetch the whole chapter once per act and
      // keep only that act's section range, so each row lands under its real key.
      {
        actKey: 'commercial',
        kind: 'whole',
        urls: ['https://www.flsenate.gov/Laws/Statutes/2024/Chapter83/All'],
        parse: parseFlAll((n) => (flCh83Act(n) === 'commercial' ? 'commercial' : null)),
      },
      {
        actKey: 'residential',
        kind: 'whole',
        urls: ['https://www.flsenate.gov/Laws/Statutes/2024/Chapter83/All'],
        parse: parseFlAll((n) => (flCh83Act(n) === 'residential' ? 'residential' : null)),
      },
      {
        actKey: 'self_storage',
        kind: 'whole',
        urls: ['https://www.flsenate.gov/Laws/Statutes/2024/Chapter83/All'],
        parse: parseFlAll((n) => (flCh83Act(n) === 'self_storage' ? 'self_storage' : null)),
      },
      {
        actKey: 'mobile_home_park',
        kind: 'whole',
        urls: ['https://www.flsenate.gov/Laws/Statutes/2024/Chapter723/All'],
        parse: parseFlAll(() => 'mobile_home_park'),
      },
    ],
  },
}

async function main() {
  const state = (process.argv[2] || '').trim().toUpperCase()
  if (!state || !CONFIGS[state]) {
    console.error(`Usage: node -r ts-node/register src/db/ingestStateLawCorpus.ts <STATE>`)
    console.error(`Configured: ${Object.keys(CONFIGS).join(', ')}`)
    process.exit(1)
  }
  await runState(CONFIGS[state])
  process.exit(0)
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e)
    process.exit(1)
  })
}
