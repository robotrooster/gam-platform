/**
 * Headless-render statute ingester for the JS-SPA / Cloudflare states (S453).
 *
 * The remaining ~20 states serve statutes only through JavaScript apps (TX/NY/
 * IL/GA/…) or Cloudflare-gated pages — curl gets an empty shell. This renders
 * each chapter page with headless Chromium (Playwright), takes the post-JS
 * innerText, and splits it into sections by the state's section-number pattern.
 *
 * One uniform engine; each state contributes only: chapter URLs + a section
 * regex (capturing the number) + act_key. Body completeness + correct number +
 * full-text search are what matter for the corpus; the catchline title is
 * best-effort (text up to the first period after the number).
 *
 * Run: cd apps/api && node -r ts-node/register src/db/ingestHeadlessStateLaw.ts <STATE|ALL>
 * Idempotent (ON CONFLICT DO NOTHING).
 */

import { query } from './index'
import { GEN_CONFIGS } from './stateHeadlessConfigs.generated'
import { BROAD_CONFIGS } from './stateBroadLawConfigs'
import { LAW_CATEGORY_VALUES, type LawCategory } from '@gam/shared'

const SOURCE_DATE = '2026-06-14'
const EFFECTIVE_YEAR = 2026

export interface ActSpec {
  actKey: string
  urls: string[]
  /** Global regex; group 1 = the bare section number. Matches a section start in innerText. */
  sectionRe: RegExp
  /** Optional: trim everything in a section body at/after this marker (history/annotation footer). */
  stopRe?: RegExp
  /** Broad real-estate law area for these sections (single source of truth:
   *  @gam/shared LAW_CATEGORY_VALUES). Defaults to 'landlord_tenant' — the live
   *  agent retrieval domain — so existing L/T configs need no change. Broader
   *  acts (conveyancing, condo, mortgage/lien, tax, zoning, …) set it explicitly
   *  and are filtered OUT of the landlord/tenant agent surface. */
  lawCategory?: LawCategory
}
export interface StateSpec {
  state: string
  acts: ActSpec[]
  /** Optional: only keep section numbers matching this (drop cross-refs / out-of-range). */
  keepRe?: RegExp
  /** Optional: drop a section whose number matches (e.g. repealed ranges). */
  waitSelector?: string
  /** Optional page.goto wait strategy (default 'networkidle'). Sites with
   *  perpetual analytics polling (nysenate.gov) never reach networkidle and
   *  time out — set 'domcontentloaded' for those. */
  waitUntil?: 'load' | 'domcontentloaded' | 'networkidle' | 'commit'
}

function clean(s: string): string {
  return s
    .replace(/ /g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

interface Sec { number: string; title: string | null; text: string }

/** Split rendered innerText into sections at each sectionRe match. */
export function splitBySection(text: string, act: ActSpec, keepRe?: RegExp): Sec[] {
  const re = new RegExp(act.sectionRe.source, act.sectionRe.flags.includes('g') ? act.sectionRe.flags : act.sectionRe.flags + 'g')
  const hits: { num: string; titleCap: string | null; start: number; end: number }[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    // Normalize unicode dashes (en/em/figure-dash, U+2010–2015) in the captured
    // section number to an ASCII hyphen. Several .gov sites render "§8–203."
    // with an en-dash; without this, keepRe (written with ASCII hyphens) drops
    // every section and the stored number drifts from citationFor's format. (MD.)
    const num = m[1].trim().replace(/[‐-―]/g, '-')
    // Optional group 2 = explicit catchline captured by the regex. Used when the
    // catchline lives in text the match consumes (so it can't be recovered from
    // the body) — e.g. IN, whose header line is "IC 32-31-x-y<TAB>Catchline<TAB>"
    // followed by an unlabelled "Sec. N. ..." body. Empty captures fall back to
    // the body-derived heuristic below.
    const titleCap = m[2] && m[2].trim() ? m[2].replace(/\s+/g, ' ').trim() : null
    hits.push({ num, titleCap, start: m.index, end: m.index + m[0].length })
    if (m.index === re.lastIndex) re.lastIndex++ // guard zero-width
  }
  const out: Sec[] = []
  for (let i = 0; i < hits.length; i++) {
    if (keepRe && !keepRe.test(hits[i].num)) continue
    let body = text.slice(hits[i].end, i + 1 < hits.length ? hits[i + 1].start : undefined)
    if (act.stopRe) {
      const cut = body.search(act.stopRe)
      if (cut >= 0) body = body.slice(0, cut)
    }
    body = clean(body)
    // Prefer the explicit catchline (regex group 2) when present; else derive a
    // best-effort catchline from the body's first sentence (up to first period
    // if short). Body-derived works when the regex consumes the "Sec. N."/marker
    // and the body opens with the catchline (TX, AK, IL, …).
    let title: string | null = hits[i].titleCap
    if (!title) {
      const dot = body.indexOf('.')
      if (dot > 0 && dot <= 120) {
        title = body.slice(0, dot).replace(/\n/g, ' ').trim()
        if (!title || /\d{2,}/.test(title) === false && title.split(' ').length > 18) title = null
      }
    }
    out.push({ number: hits[i].num, title, text: body })
  }
  return out
}

async function main() {
  const want = (process.argv[2] || 'ALL').toUpperCase()
  const { chromium } = require('playwright')
  const browser = await chromium.launch({ headless: true })
  const ALL: Record<string, StateSpec> = { ...CONFIGS, ...(GEN_CONFIGS as any) }
  // Append broad real-estate-law acts onto each state's landlord_tenant acts so
  // a single `ingest <STATE>` run covers both layers.
  for (const [st, spec] of Object.entries(BROAD_CONFIGS)) {
    ALL[st] = ALL[st] ? { ...ALL[st], acts: [...ALL[st].acts, ...spec.acts] } : spec
  }
  const targets = want === 'ALL' ? Object.keys(ALL) : [want]
  const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'
  const RENDER_CONC = 4

  for (const st of targets) {
    const spec = ALL[st]
    if (!spec) { console.error('no headless config for', st); continue }
    console.log(`\n=== ${spec.state} (headless render) ===`)
    const counts: Record<string, number> = {}
    let total = 0
    const jobs: { act: ActSpec; url: string }[] = []
    for (const act of spec.acts) for (const url of act.urls) jobs.push({ act, url })

    let idx = 0
    async function worker() {
      const page = await browser.newPage({ userAgent: UA })
      while (idx < jobs.length) {
        const { act, url } = jobs[idx++]
        try {
          await page.goto(url, { waitUntil: spec.waitUntil || 'networkidle', timeout: spec.waitUntil === 'domcontentloaded' ? 30000 : 60000 })
          if (spec.waitSelector) { try { await page.waitForSelector(spec.waitSelector, { timeout: 15000 }) } catch {} }
          await page.waitForTimeout(2000)
          const innerText: string = await page.evaluate('document.body.innerText')
          const secs = splitBySection(innerText, act, spec.keepRe)
          const cat: LawCategory = act.lawCategory || 'landlord_tenant'
          if (!LAW_CATEGORY_VALUES.includes(cat)) throw new Error(`bad law_category "${cat}" for ${spec.state}/${act.actKey}`)
          let ok = 0
          for (const s of secs) {
            if (!s.text || s.text.length < 25) continue
            // Upsert (DO UPDATE) so re-runs refresh title/text/category in place —
            // a corpus correction no longer needs a manual DELETE first.
            await query(
              `INSERT INTO state_law_section_texts
                 (state_code, act_key, section_number, section_title, full_text, source_url, source_date, effective_year, law_category)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
               ON CONFLICT (state_code, act_key, section_number, effective_year)
               DO UPDATE SET section_title = EXCLUDED.section_title,
                             full_text     = EXCLUDED.full_text,
                             source_url    = EXCLUDED.source_url,
                             source_date   = EXCLUDED.source_date,
                             law_category  = EXCLUDED.law_category`,
              [spec.state, act.actKey, s.number, s.title, s.text, url, SOURCE_DATE, EFFECTIVE_YEAR, cat]
            )
            ok++
          }
          counts[act.actKey] = (counts[act.actKey] || 0) + ok
          total += ok
        } catch (e: any) {
          console.warn(`  ! ${act.actKey} ${url.slice(-50)}: ${e?.message || e}`)
        }
      }
      await page.close()
    }
    await Promise.all(Array.from({ length: RENDER_CONC }, () => worker()))
    console.log(`${spec.state} done. inserted=${total}`, counts)
  }
  await browser.close()
  process.exit(0)
}

// ---------------------------------------------------------------------------
// Per-state headless configs (chapter URLs + section-number regex)
// ---------------------------------------------------------------------------

const CONFIGS: Record<string, StateSpec> = {
  // Texas Property Code — "Sec. 92.001." style. Ch 91 general, 92 residential,
  // 93 commercial, 94 manufactured-home communities; Property Code Ch 59 self-storage.
  TX: {
    state: 'TX',
    keepRe: /^\d+\.\d+$/,
    acts: [
      { actKey: 'general_landlord_tenant', urls: ['https://statutes.capitol.texas.gov/Docs/PR/htm/PR.91.htm'], sectionRe: /Sec\.\s*(\d+\.\d+)\.\s/, stopRe: /\n(Added by|Acts \d{4}|Amended by)/ },
      { actKey: 'residential', urls: ['https://statutes.capitol.texas.gov/Docs/PR/htm/PR.92.htm'], sectionRe: /Sec\.\s*(\d+\.\d+)\.\s/, stopRe: /\n(Added by|Acts \d{4}|Amended by)/ },
      { actKey: 'commercial', urls: ['https://statutes.capitol.texas.gov/Docs/PR/htm/PR.93.htm'], sectionRe: /Sec\.\s*(\d+\.\d+)\.\s/, stopRe: /\n(Added by|Acts \d{4}|Amended by)/ },
      { actKey: 'manufactured_home_park', urls: ['https://statutes.capitol.texas.gov/Docs/PR/htm/PR.94.htm'], sectionRe: /Sec\.\s*(\d+\.\d+)\.\s/, stopRe: /\n(Added by|Acts \d{4}|Amended by)/ },
      { actKey: 'self_storage', urls: ['https://statutes.capitol.texas.gov/Docs/PR/htm/PR.59.htm'], sectionRe: /Sec\.\s*(\d+\.\d+)\.\s/, stopRe: /\n(Added by|Acts \d{4}|Amended by)/ },
    ],
  },
}

// Only run when executed directly (not when imported for dry-runs/tests —
// importing must have no side effects).
if (require.main === module) {
  main().catch((e) => { console.error(e); process.exit(1) })
}
