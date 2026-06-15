/* TEMP PROBE 2 — walk to a chapter and dump section leaves. */
import { chromium, Page } from 'playwright'

const PORTALS: Record<string, string> = {
  GA: 'https://www.lexisnexis.com/hottopics/gacode/',
  MS: 'https://www.lexisnexis.com/hottopics/mscode/',
  TN: 'https://www.lexisnexis.com/hottopics/tncode/',
}

// per-state: title text fragment, then chapter text fragment(s)
const PLAN: Record<string, { title: RegExp; chapters: RegExp[] }> = {
  GA: { title: /TITLE 44\b/i, chapters: [/CHAPTER 7\b/i] },
  MS: { title: /TITLE 89\b/i, chapters: [/CHAPTER 8\b/i, /CHAPTER 7\b/i] },
  TN: { title: /TITLE 66\b/i, chapters: [/CHAPTER 28\b/i, /CHAPTER 7\b/i] },
}

async function dismiss(page: Page) {
  for (const sel of ['input.primary', 'button.primary', 'button:has-text("I Agree")', 'button:has-text("Ok - Close")']) {
    const el = page.locator(sel).first()
    if (await el.count().catch(() => 0)) {
      await el.click({ timeout: 4000 }).catch(() => {})
      await page.waitForTimeout(1500)
    }
  }
  await page.addStyleTag({ content: '.dialog-overlay{pointer-events:none !important;}' }).catch(() => {})
}

async function expandByTitle(page: Page, re: RegExp): Promise<string | null> {
  // find li[data-nodeid] whose data-title matches; click its toggle; return nodeid
  const nodeid = await page.evaluate((src: string) => {
    const rx = new RegExp(src, 'i')
    const lis = Array.from((globalThis as any).document.querySelectorAll('li[data-nodeid]')) as any[]
    const li = lis.find((l) => rx.test(l.getAttribute('data-title') || ''))
    if (!li) return null
    const btn = li.querySelector('button.toc-tree__toggle-expansion, button[class*="toggle"]')
    if (btn) btn.click()
    return li.getAttribute('data-nodeid')
  }, re.source)
  await page.waitForTimeout(2500)
  return nodeid
}

async function main() {
  const st = (process.argv[2] || 'GA').toUpperCase()
  const plan = PLAN[st]
  const browser = await chromium.launch({ headless: true })
  const ctx = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
    viewport: { width: 1400, height: 1000 },
  })
  const page = await ctx.newPage()
  await page.goto(PORTALS[st], { waitUntil: 'domcontentloaded', timeout: 60000 })
  await page.waitForTimeout(6000)
  await dismiss(page)

  const titleNode = await expandByTitle(page, plan.title)
  console.log(`${st}: title nodeid=`, titleNode)
  if (!titleNode) { await browser.close(); return }

  for (const chRe of plan.chapters) {
    const chNode = await expandByTitle(page, chRe)
    console.log(`  chapter ${chRe} nodeid=`, chNode)
    if (!chNode) continue
    // some chapters have Articles/Parts; try expanding any child non-leaf with a toggle under this chapter
    // dump current leaves visible under this chapter subtree
  }

  // Now dump ALL leaf section nodes currently in DOM (data-docfullpath present)
  const leaves = await page.evaluate(() => {
    const lis = Array.from((globalThis as any).document.querySelectorAll('li[data-nodeid]')) as any[]
    return lis
      .filter((l) => (l.getAttribute('data-docfullpath') || '').length > 0)
      .map((l) => ({
        nodeid: l.getAttribute('data-nodeid'),
        title: l.getAttribute('data-title'),
        docfullpath: l.getAttribute('data-docfullpath'),
      }))
  })
  console.log(`  leaves with docfullpath: ${leaves.length}`)
  for (const lf of leaves.slice(0, 12)) console.log('   ', lf.title, '=>', (lf.docfullpath || '').slice(-60))

  // Also dump intermediate (article/part) nodes that appeared with toggles but no docfullpath
  const branches = await page.evaluate(() => {
    const lis = Array.from((globalThis as any).document.querySelectorAll('li[data-nodeid]')) as any[]
    return lis
      .filter((l) => !(l.getAttribute('data-docfullpath') || '').length && l.querySelector('button[class*="toggle"]'))
      .map((l) => ({ nodeid: l.getAttribute('data-nodeid'), title: l.getAttribute('data-title') }))
      .filter((b) => /article|part|chapter/i.test(b.title || ''))
  })
  console.log(`  branch nodes (article/part/chapter): ${branches.length}`)
  for (const b of branches.slice(0, 40)) console.log('   B', b.nodeid, b.title)

  await browser.close()
}
main().catch((e) => { console.error('PROBE ERR', e); process.exit(1) })
