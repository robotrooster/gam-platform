/**
 * LexisNexis Advance FREE PUBLIC ACCESS harvester — GA / MS / TN landlord-tenant
 * statutes (Bucket-B states whose codes are LexisNexis-published). The hottopics
 * public portals (lexisnexis.com/hottopics/{ga,ms,tn}code/) land ANONYMOUSLY on
 * the advance.lexis.com SPA — the Table of Contents is fully enumerable with no
 * login and no CAPTCHA. Only the section BODY fetch is gated by a once-per-session
 * Google reCAPTCHA v2 (flow=PawFirstDocAccess). We do NOT defeat it: a human
 * solves it once via `--warm`, we persist the storageState, and `--harvest`
 * reuses that authorized session to pull each section the human may read.
 *
 * Modes:
 *   --toc <ST>              enumerate the target chapters' sections (no captcha). TEST FREELY.
 *   --harvest <ST> [--dry] HEADED browser: opens one doc, YOU solve the single
 *                          reCAPTCHA, then it harvests every section body in that
 *                          same unlocked session and (without --dry) upserts into
 *                          state_law_section_texts.
 *
 * Run: cd apps/api && node -r ts-node/register src/db/ingestLexisAdvance.ts --toc MS
 * AR is intentionally NOT included (copyright-asserted — needs permission first).
 */
import { query } from './index'

// `document`/`location` are referenced only inside page.evaluate callbacks
// (browser context); the API tsconfig has no DOM lib, so declare them as any.
declare const document: any
declare const location: any

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'
const EFFECTIVE_YEAR = 2026
const TODAY = '2026-06-14'

interface StateCfg {
  portal: string
  titlePrefix: string // lowercased data-title starts-with, e.g. "title 44"
  chapters: number[] // chapter numbers under that title to harvest
  numRe: RegExp // captures (number)(catchline) from a section's data-title
  actKey: string
}

const CONFIG: Record<string, StateCfg> = {
  GA: {
    portal: 'https://www.lexisnexis.com/hottopics/gacode/',
    titlePrefix: 'title 44',
    chapters: [7],
    numRe: /^(?:§\s*)?(44-7-[0-9A-Za-z.\-]+)\.\s*(.*)$/,
    actKey: 'residential',
  },
  MS: {
    portal: 'https://www.lexisnexis.com/hottopics/mscode/',
    titlePrefix: 'title 89',
    chapters: [7, 8],
    numRe: /^(?:§\s*)?(89-[78]-[0-9A-Za-z.\-]+)\.\s*(.*)$/,
    actKey: 'residential',
  },
  TN: {
    portal: 'https://www.lexisnexis.com/hottopics/tncode/',
    titlePrefix: 'title 66',
    chapters: [7, 28],
    numRe: /^(?:§\s*)?(66-(?:7|28)-[0-9A-Za-z.\-]+)\.\s*(.*)$/,
    actKey: 'residential',
  },
  // AR nests a Subtitle level (Title 18 → Subtitle 2 → Ch 16 Landlord & Tenant /
  // Ch 17 Residential Landlord-Tenant Act of 2007). expandTargetTree opens
  // intermediate "Subtitle …" nodes so the chapters surface.
  AR: {
    portal: 'https://www.lexisnexis.com/hottopics/arcode/',
    titlePrefix: 'title 18',
    chapters: [16, 17],
    numRe: /^(?:§\s*)?(18-1[67]-[0-9A-Za-z.\-]+)\.\s*(.*)$/,
    actKey: 'residential',
  },
}

// ----------------------------------------------------------------------------
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
  const noScript = html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
  return decodeEntities(noScript.replace(/<[^>]+>/g, ' '))
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

async function dismissModal(page: any) {
  for (const sel of ['input.primary', 'button.primary', 'button:has-text("I Agree")', 'button:has-text("Ok - Close")']) {
    try {
      const el = page.locator(sel).first()
      if (await el.count()) { await el.click({ timeout: 3000 }).catch(() => {}); await page.waitForTimeout(1500); break }
    } catch {}
  }
  await page.addStyleTag({ content: '.dialog-overlay{pointer-events:none !important;}' }).catch(() => {})
}

interface TocSec { number: string; title: string; docfullpath: string; nodeid: string }

/** advance.lexis.com documentpage nodepath = cumulative 3-char prefixes of nodeid. */
function nodePath(nodeid: string): string {
  const segs: string[] = []
  for (let i = 3; i <= nodeid.length; i += 3) segs.push(nodeid.slice(0, i))
  return '/ROOT/' + segs.join('/')
}

/** The frame holding the TOC tree (li[data-nodeid]) — main frame on the TOC page,
 *  an iframe on the document page. */
async function treeFrame(page: any): Promise<any> {
  for (const f of page.frames()) {
    try { if (await f.$('li[data-nodeid]')) return f } catch {}
  }
  return page.mainFrame()
}

/** Expand the target Title + chapters in the TOC tree (used on both the TOC page
 *  and the document page's sidebar). DOM ops run on `frame`; waits on `page`.
 *  Returns the chapter nodeid prefixes. */
async function expandTargetTree(frame: any, page: any, cfg: StateCfg): Promise<string[]> {
  await frame.waitForSelector('li[data-nodeid]', { timeout: 30000 })
  // 1. Expand the Title node.
  await frame.evaluate((prefix: string) => {
    for (const li of Array.from(document.querySelectorAll('li[data-nodeid]')) as any[]) {
      const t = (li.getAttribute('data-title') || '').toLowerCase()
      if (!t.startsWith(prefix)) continue
      const tog = li.querySelector('button.toc-tree__toggle-expansion, button[class*="toggle"]') as any
      if (tog && tog.getAttribute('aria-expanded') === 'false') tog.click()
    }
  }, cfg.titlePrefix)
  await page.waitForTimeout(2500)
  // 1b. Expand any intermediate "Subtitle …" containers so chapters surface
  //     (AR nests Title→Subtitle→Chapter; no-op for states without subtitles).
  for (let p = 0; p < 3; p++) {
    const did = await frame.evaluate(() => {
      let n = 0
      for (const li of Array.from(document.querySelectorAll('li[data-nodeid]')) as any[]) {
        if (!/^subtitle\b/i.test((li.getAttribute('data-title') || '').trim())) continue
        const tog = li.querySelector('button.toc-tree__toggle-expansion, button[class*="toggle"]') as any
        if (tog && tog.getAttribute('aria-expanded') === 'false') { tog.click(); n++ }
      }
      return n
    })
    await page.waitForTimeout(2000)
    if (!did) break
  }
  // 2. Find the target chapter nodeids (descendants share the prefix).
  const chapPrefixes: string[] = await frame.evaluate((chapters: number[]) => {
    const want = chapters.map((c) => `chapter ${c}`)
    const out: string[] = []
    for (const li of Array.from(document.querySelectorAll('li[data-nodeid]')) as any[]) {
      const t = (li.getAttribute('data-title') || '').toLowerCase()
      if (want.some((w) => new RegExp('^' + w + '(\\D|$)').test(t))) out.push(li.getAttribute('data-nodeid'))
    }
    return out
  }, cfg.chapters)
  if (process.env.DBG) console.error(`[dbg] chapPrefixes=${JSON.stringify(chapPrefixes)}`)
  // 3. Expand under those chapters (Parts/Articles → sections) until the leaf
  //    count holds steady (async lazy-loads; TN Ch 28 nests a Part level).
  const countLeaves = () =>
    frame.evaluate((prefixes: string[]) => {
      let n = 0
      for (const li of Array.from(document.querySelectorAll('li[data-docfullpath]')) as any[]) {
        const id = li.getAttribute('data-nodeid') || ''
        if (prefixes.some((p) => id.startsWith(p))) n++
      }
      return n
    }, chapPrefixes)
  let lastLeaves = -1
  let stable = 0
  for (let pass = 0; pass < 24 && stable < 3; pass++) {
    const clicked = await frame.evaluate((prefixes: string[]) => {
      let n = 0
      for (const li of Array.from(document.querySelectorAll('li[data-nodeid]')) as any[]) {
        const id = li.getAttribute('data-nodeid') || ''
        if (!prefixes.some((p) => id.startsWith(p))) continue
        const tog = li.querySelector('button.toc-tree__toggle-expansion, button[class*="toggle"]') as any
        if (tog && tog.getAttribute('aria-expanded') === 'false') { tog.click(); n++ }
      }
      return n
    }, chapPrefixes)
    await page.waitForTimeout(3500)
    const leaves = await countLeaves()
    if (clicked === 0 && leaves === lastLeaves) stable++
    else stable = 0
    lastLeaves = leaves
    if (process.env.DBG) console.error(`[dbg] pass ${pass}: clicked=${clicked} leaves=${leaves} stable=${stable}`)
  }
  return chapPrefixes
}

/** Expand the target Title + chapters, then collect their section leaves. No captcha. */
async function enumerateToc(page: any, cfg: StateCfg): Promise<TocSec[]> {
  const tframe = await treeFrame(page)
  const chapPrefixes = await expandTargetTree(tframe, page, cfg)
  // 4. Collect section leaves (docfullpath + matching number) under the chapters.
  const raw: { title: string; doc: string; nodeid: string }[] = await tframe.evaluate((prefixes: string[]) => {
    const out: { title: string; doc: string; nodeid: string }[] = []
    for (const li of Array.from(document.querySelectorAll('li[data-docfullpath]')) as any[]) {
      const id = li.getAttribute('data-nodeid') || ''
      if (prefixes.length && !prefixes.some((p) => id.startsWith(p))) continue
      out.push({ title: li.getAttribute('data-title') || '', doc: li.getAttribute('data-docfullpath') || '', nodeid: id })
    }
    return out
  }, chapPrefixes)
  if (process.env.DBG) console.error(`[dbg] leaf li[data-docfullpath] under chapters=${raw.length}; sample titles=${JSON.stringify(raw.slice(0, 3).map((r) => r.title))}`)
  const secs: TocSec[] = []
  const seen = new Set<string>()
  for (const r of raw) {
    const m = cfg.numRe.exec(r.title)
    if (!m || !r.doc || seen.has(m[1])) continue
    seen.add(m[1])
    secs.push({ number: m[1], title: (m[2] || '').replace(/\.\s*$/, '').trim(), docfullpath: r.doc, nodeid: r.nodeid })
  }
  return secs
}

async function openPortal(cfg: StateCfg, opts: { headed?: boolean; storage?: string }) {
  const { chromium } = require('playwright')
  console.log(`launching ${opts.headed ? 'a visible' : 'a headless'} browser…`)
  const browser = await chromium.launch({ headless: !opts.headed })
  const ctx = await browser.newContext({
    userAgent: UA,
    viewport: { width: 1400, height: 1000 },
    ...(opts.storage ? { storageState: opts.storage } : {}),
  })
  const page = await ctx.newPage()
  console.log(`opening ${cfg.portal} …`)
  await page.goto(cfg.portal, { waitUntil: 'domcontentloaded', timeout: 60000 })
  await page.waitForTimeout(7000)
  await dismissModal(page)
  console.log('portal loaded; reading the table of contents (this takes ~1–2 min)…')
  return { browser, ctx, page }
}

async function modeToc(st: string, cfg: StateCfg) {
  const { browser, page } = await openPortal(cfg, {})
  const secs = await enumerateToc(page, cfg)
  console.log(`\n${st}: ${secs.length} sections in chapter(s) ${cfg.chapters.join(', ')}`)
  for (const s of secs.slice(0, 8)) console.log(`  [${s.number}] ${s.title}  ::  ${s.docfullpath.slice(0, 55)}`)
  if (secs.length > 8) console.log(`  …(${secs.length} total)`)
  await browser.close()
  process.exit(0)
}

/** The frame holding the document body (h1.query citation + SS_* paragraphs). */
async function contentFrame(page: any): Promise<any> {
  for (const f of page.frames()) {
    try { if (await f.$('h1.query, [class*="SS_"]')) return f } catch {}
  }
  return page.mainFrame()
}

/** Current document's citation heading, e.g. "Miss. Code Ann. § 89-7-3". */
async function currentDocLabel(cframe: any): Promise<string> {
  try {
    return await cframe.evaluate(() => {
      const h = document.querySelector('h1.query') as any
      return h ? (h.innerText || '').trim() : ''
    })
  } catch { return '' }
}

/** Statute body = top-level SS_* paragraphs (minus copyright), in document order.
 *  MS/GA/TN free portals serve the UNANNOTATED code, so SS_* is pure statute. */
async function extractStatute(cframe: any, number: string): Promise<string> {
  try {
    const raw: string = await cframe.evaluate(() => {
      const parts: string[] = []
      for (const el of Array.from(document.querySelectorAll('[class*="SS_"]')) as any[]) {
        const c = (el.className || '').toString()
        if (/Copyright|Currency|Notes|History|Annotation/i.test(c)) continue
        if (el.querySelector('[class*="SS_"]')) continue // skip wrappers — keep only LEAF paragraphs
        const t = (el.innerText || '').trim()
        if (t) parts.push(t)
      }
      return parts.join('\n')
    })
    let txt = raw.replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim()
    // Drop leading chrome (currency note + breadcrumb): start at the section
    // heading "§ <number>." (single §, with the period — the chapter-range
    // breadcrumb uses "§§ … — …" with no period, so it won't false-match).
    // Slice from the section heading to drop the currency note + breadcrumb chrome.
    // MS renders "§ <num>."; TN renders "<num>." with no §.
    let i = txt.indexOf('§ ' + number + '.')
    if (i < 0) i = txt.indexOf(number + '.')
    if (i > 0) txt = txt.slice(i)
    return txt.trim()
  } catch { return '' }
}

/** Exact heading match (so "89-7-5" never matches "89-7-53"). */
function headingMatches(label: string, number: string): boolean {
  return (label || '').replace(/\s+$/, '').endsWith('§ ' + number)
}

/** Click a section's sidebar link (in-app nav, no reload, no re-CAPTCHA) and wait
 *  for h1.query to reflect the target number. Re-clicks if the SPA dropped the
 *  click (a race right after the previous section rendered). */
async function gotoSection(page: any, cframe: any, nodeid: string, number: string): Promise<any> {
  for (let attempt = 0; attempt < 4; attempt++) {
    await page.waitForTimeout(500) // let the previous render settle before clicking
    try {
      await cframe.evaluate((id: string) => {
        const a = (document.querySelector(`a[data-pdtocnodeidentifier="${id}"][data-action="linkdoc"]`) ||
          document.querySelector(`a[data-pdtocnodeidentifier="${id}"]`)) as any
        if (a) { a.scrollIntoView(); a.click() }
      }, nodeid)
    } catch {}
    for (let i = 0; i < 12; i++) {
      await page.waitForTimeout(700)
      let cf = cframe
      try { cf = await contentFrame(page) } catch {}
      if (headingMatches(await currentDocLabel(cf), number)) return cf
    }
  }
  return await contentFrame(page)
}

async function modeHarvest(st: string, cfg: StateCfg, dry: boolean) {
  // HEADED session. The document-page sidebar only exposes the CURRENT chapter's
  // links, so cross-chapter clicking fails. Instead, process ONE CHAPTER AT A TIME:
  // open that chapter's first section from the TOC (full-page nav; only the very
  // first ever hits the once-per-session reCAPTCHA), then sidebar-walk that chapter
  // (in-app clicks, which work within a chapter), reading the SS_* statute body.
  const { browser, page } = await openPortal(cfg, { headed: true })
  const secs = await enumerateToc(page, cfg)
  if (!secs.length) { console.error('no sections found in TOC — aborting'); await browser.close(); process.exit(1) }
  // The document sidebar only exposes ONE navigable unit's links at a time — a
  // flat chapter (MS) or, when a chapter nests articles/parts (GA Ch 7, TN Ch 28),
  // a single article/part. The Lexis nodeid is hierarchical in 3-char segments, so
  // the section's PARENT (nodeid minus its last segment) is exactly that unit.
  // Group by parent, open each group's first section from the TOC, then sidebar-walk.
  const groups = new Map<string, TocSec[]>() // insertion order = document order
  for (const s of secs) {
    const key = s.nodeid.length > 3 ? s.nodeid.slice(0, -3) : s.nodeid
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(s)
  }
  console.log(`enumerated ${secs.length} in ${groups.size} navigable groups`)

  const out: { number: string; title: string; text: string }[] = []
  let miss = 0
  let firstEver = true
  for (const [, gSecs] of groups) {
    if (!gSecs.length) continue
    if (!firstEver) {
      console.log(`\n— reopening portal for ${gSecs[0].number} —`)
      await page.goto(cfg.portal, { waitUntil: 'domcontentloaded', timeout: 60000 })
      await page.waitForTimeout(7000)
      await dismissModal(page)
      try { const tf = await treeFrame(page); await expandTargetTree(tf, page, cfg) } catch {}
    }
    console.log(`\ngroup ${gSecs[0].number}–${gSecs[gSecs.length - 1].number} (${gSecs.length}): opening ${gSecs[0].number}…`)
    const landed = await solveAndLand(page, gSecs[0].docfullpath)
    firstEver = false
    if (!landed) { console.error(`  ! group ${gSecs[0].number}: no documentpage — skipping`); miss += gSecs.length; continue }
    let cframe = await contentFrame(page)
    for (let i = 0; i < gSecs.length; i++) {
      const s = gSecs[i]
      let text = ''
      if (i === 0) {
        text = await extractStatute(cframe, s.number)
      } else {
        cframe = await gotoSection(page, cframe, s.nodeid, s.number)
        if (!headingMatches(await currentDocLabel(cframe), s.number)) {
          console.error(`  ! ${s.number}: nav landed on "${await currentDocLabel(cframe)}" — skip`); miss++; continue
        }
        text = await extractStatute(cframe, s.number)
      }
      if (text.length >= 25) out.push({ number: s.number, title: s.title, text })
      else { console.error(`  ! ${s.number}: empty body`); miss++ }
      if (out.length && out.length % 15 === 0) console.log(`  …${out.length}/${secs.length}`)
    }
  }

  console.log(`\nparsed ${out.length}/${secs.length} bodies (misses ${miss}).`)
  const show = [out[0], out[1], out[Math.floor(out.length / 2)], out[out.length - 1]].filter(Boolean)
  for (const s of show) {
    console.log(`\n[${s!.number}] ${s!.title}\n${s!.text.slice(0, 240).replace(/\n/g, ' ')}…`)
  }
  if (dry) { console.log('\nDRY — nothing written. Confirm the samples are different per section + clean.'); await browser.close(); process.exit(0) }
  let n = 0
  for (const s of out) {
    await query(
      `INSERT INTO state_law_section_texts
         (state_code, act_key, section_number, section_title, full_text, source_url, source_date, effective_year, law_category)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'landlord_tenant')
       ON CONFLICT (state_code, act_key, section_number, effective_year)
       DO UPDATE SET section_title=EXCLUDED.section_title, full_text=EXCLUDED.full_text,
                     source_url=EXCLUDED.source_url, source_date=EXCLUDED.source_date, law_category=EXCLUDED.law_category`,
      [st, cfg.actKey, s.number, s.title, s.text, cfg.portal, TODAY, EFFECTIVE_YEAR]
    )
    n++
  }
  console.log(`${st} done. upserted=${n}`)
  await browser.close()
  process.exit(0)
}

/** Click a section's TOC link and wait for its document page. Robust to BOTH
 *  possibilities after a portal reopen: (a) a fresh reCAPTCHA appears — prompt and
 *  wait for the human; (b) the click is dropped — re-click. Returns landed URL. */
async function solveAndLand(page: any, docfullpath: string): Promise<string> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const tf = await treeFrame(page)
    await tf.evaluate((doc: string) => {
      const li = document.querySelector(`li[data-docfullpath="${doc}"]`) as any
      const a = li && (li.querySelector('a[data-action="toclink"]') as any)
      if (a) { a.scrollIntoView(); a.click() }
    }, docfullpath)
    let prompted = false
    for (let i = 0; i < 110; i++) {
      await page.waitForTimeout(3000)
      let url = ''
      try { url = page.url() } catch {}
      if (url.includes('/documentpage') && !url.includes('RobotValidation')) {
        await page.waitForLoadState('domcontentloaded').catch(() => {})
        await page.waitForTimeout(2500)
        return url
      }
      if (url.includes('RobotValidation')) {
        if (!prompted) { console.log('\n>>> Solve the reCAPTCHA in the browser window… (waiting up to 5 min)'); prompted = true }
        continue // keep waiting for the human
      }
      if (i >= 8 && !prompted) break // ~24s, no nav and no captcha → click was dropped; re-click
    }
  }
  return ''
}

/** List content-bearing elements (class + text length + preview) so we can find
 *  the statute-body container. Skips the TOC sidebar (many links) and chrome. */
async function dumpContentElements(page: any, label: string) {
  for (const f of page.frames()) {
    let items: any[] = []
    try {
      items = await f.evaluate(() => {
        const out: any[] = []
        for (const el of Array.from(document.querySelectorAll('div,section,article,p,td')) as any[]) {
          const txt = (el.innerText || '').trim()
          if (txt.length < 60 || txt.length > 6000) continue
          if (el.querySelectorAll('a').length > 4) continue // skip TOC/nav
          out.push({ tag: el.tagName, cls: (el.className || '').toString().slice(0, 55), len: txt.length, preview: txt.slice(0, 110).replace(/\s+/g, ' ') })
        }
        return out.slice(0, 35)
      })
    } catch { continue }
    if (items.length) {
      console.log(`\n===== ${label}: content-ish elements (frame has them) =====`)
      for (const it of items) console.log(JSON.stringify(it))
      return
    }
  }
  console.log(`${label}: no content elements found in any frame`)
}

async function modeProbe(st: string, cfg: StateCfg) {
  const { browser, page } = await openPortal(cfg, { headed: true })
  const secs = await enumerateToc(page, cfg)
  if (secs.length < 2) { console.error('need >=2 sections'); await browser.close(); process.exit(1) }
  console.log(`enumerated ${secs.length}; opening first (${secs[0].number}) to trigger CAPTCHA…`)
  const landed = await solveAndLand(page, secs[0].docfullpath)
  if (!landed) { console.error('timed out'); await browser.close(); process.exit(1) }
  console.log('landed:', landed.slice(0, 160))
  await dumpContentElements(page, `DOC1 ${secs[0].number}`)
  // navigate to the 2nd section to confirm content actually changes
  const s2 = secs[1]
  const u = new URL(landed)
  u.searchParams.set('nodeid', s2.nodeid)
  u.searchParams.set('nodepath', nodePath(s2.nodeid))
  u.searchParams.set('level', String(Math.max(1, Math.floor(s2.nodeid.length / 3))))
  await page.goto(u.toString(), { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {})
  await page.waitForTimeout(3000)
  await dumpContentElements(page, `DOC2 ${s2.number} (nav check — should show 89-7-3 text)`)
  await browser.close()
  process.exit(0)
}

async function main() {
  const args = process.argv.slice(2)
  const mode = args.find((a) => a.startsWith('--') && a !== '--dry')?.replace('--', '') || 'toc'
  const st = (args.find((a) => /^[A-Za-z]{2}$/.test(a)) || '').toUpperCase()
  const cfg = CONFIG[st]
  if (!cfg) { console.error(`usage: --toc|--harvest <GA|MS|TN> [--dry]; unknown state "${st}"`); process.exit(1) }
  if (mode === 'toc') return modeToc(st, cfg)
  if (mode === 'probe') return modeProbe(st, cfg)
  if (mode === 'harvest') return modeHarvest(st, cfg, args.includes('--dry'))
  console.error(`unknown mode "${mode}"`); process.exit(1)
}

main().catch((e) => { console.error(e); process.exit(1) })
