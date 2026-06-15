/* TEMP PROBE 3 — recursively expand a chapter subtree and dump section leaves. */
import { chromium, Page } from 'playwright'

const PORTALS: Record<string, string> = {
  GA: 'https://www.lexisnexis.com/hottopics/gacode/',
  MS: 'https://www.lexisnexis.com/hottopics/mscode/',
  TN: 'https://www.lexisnexis.com/hottopics/tncode/',
}
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
      await page.waitForTimeout(1200)
    }
  }
  await page.addStyleTag({ content: '.dialog-overlay{pointer-events:none !important;}' }).catch(() => {})
}

/** Click the toggle for the node with this exact nodeid. Returns true if clicked. */
async function expandNode(page: Page, nodeid: string): Promise<boolean> {
  const ok = await page.evaluate((id: string) => {
    const li = (globalThis as any).document.querySelector('li[data-nodeid="' + id + '"]')
    if (!li) return false
    const btn = li.querySelector('button.toc-tree__toggle-expansion, button[class*="toggle"]')
    const expanded = li.getAttribute('aria-expanded') === 'true' || li.classList.contains('expanded')
    if (btn && !expanded) { btn.click(); return true }
    return false
  }, nodeid)
  if (ok) await page.waitForTimeout(1800)
  return ok
}

/** Get direct child nodeids of a node (children render as nested li under it). */
async function childNodeIds(page: Page, nodeid: string): Promise<{ id: string; title: string; doc: string; hasToggle: boolean }[]> {
  return page.evaluate((id: string) => {
    const li = (globalThis as any).document.querySelector('li[data-nodeid="' + id + '"]')
    if (!li) return []
    // direct descendant lis whose nodeid starts with id but is longer; pick the immediate level
    const all = Array.from(li.querySelectorAll('li[data-nodeid]')) as any[]
    return all.map((c) => ({
      id: c.getAttribute('data-nodeid'),
      title: c.getAttribute('data-title') || '',
      doc: c.getAttribute('data-docfullpath') || '',
      hasToggle: !!c.querySelector('button.toc-tree__toggle-expansion, button[class*="toggle"]'),
    }))
  }, nodeid)
}

async function findNodeByTitle(page: Page, re: RegExp): Promise<string | null> {
  return page.evaluate((src: string) => {
    const rx = new RegExp(src, 'i')
    const lis = Array.from((globalThis as any).document.querySelectorAll('li[data-nodeid]')) as any[]
    const li = lis.find((l) => rx.test(l.getAttribute('data-title') || ''))
    return li ? li.getAttribute('data-nodeid') : null
  }, re.source)
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

  const titleNode = await findNodeByTitle(page, plan.title)
  console.log(`${st}: title nodeid=`, titleNode)
  if (!titleNode) { await browser.close(); return }
  await expandNode(page, titleNode)

  for (const chRe of plan.chapters) {
    const chNode = await findNodeByTitle(page, chRe)
    console.log(`  chapter ${chRe.source} nodeid=`, chNode)
    if (!chNode) continue
    await expandNode(page, chNode)

    // BFS expand all descendants until no new toggles open
    const sections: { id: string; title: string; doc: string }[] = []
    const visited = new Set<string>()
    let changed = true
    let rounds = 0
    while (changed && rounds < 12) {
      changed = false
      rounds++
      const kids = await childNodeIds(page, chNode)
      for (const k of kids) {
        if (k.doc) {
          if (!visited.has(k.id)) { sections.push(k); visited.add(k.id) }
        } else if (k.hasToggle && !visited.has('exp:' + k.id)) {
          const did = await expandNode(page, k.id)
          visited.add('exp:' + k.id)
          if (did) changed = true
        }
      }
    }
    const secLeaves = sections.filter((s) => /\d+-\d+-\d+/.test(s.title))
    console.log(`    section leaves: ${secLeaves.length} (rounds=${rounds})`)
    for (const s of secLeaves.slice(0, 8)) console.log('      ', s.title, '=>', s.doc.slice(-50))
    if (secLeaves.length > 8) console.log('       ...', secLeaves[secLeaves.length - 1].title)
  }

  await browser.close()
}
main().catch((e) => { console.error('PROBE ERR', e); process.exit(1) })
