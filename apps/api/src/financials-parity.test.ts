// 10/11 (Nic): "a bookkeeper in the bookkeeper portal scoped to certain
// properties should see those properties in the bookkeeper portal as well.
// We're treating them as two different things and it's not. It's kind of like
// the point of sale where it's byte identical to the financials of that
// situation, of that property."
//
// The financial pages ship in TWO apps — the landlord portal (apps/landlord)
// and GAM Books, the bookkeeper portal (apps/books) — exactly the way the POS
// register does (pos-parity.test.ts). Same rule: the guard FOLLOWS THE IMPORTS.
// Every file a financial page reaches, directly or through another file (CSS
// included), must be byte-identical in both apps, and must live in
// src/financials — so a page cannot quietly lean on something one app has and
// the other does not.
//
// The ONE exception is src/financials/adapter.ts: how each app talks to the
// API, shows a toast and knows who is looking. It is checked differently —
// every name a shared file imports from it must be exported by BOTH copies.
//
// If it fails: you edited a financial page in one app and not the other — make
// the same change in both (copy the file across).
import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'fs'
import { resolve, dirname, join, normalize } from 'path'

const root = resolve(__dirname, '../../..')  // apps/api/src → repo root
const ENTRY_POINTS = [
  'financials/IncomePage.tsx',
  'financials/ExpensesPage.tsx',
  'financials/MaintenanceCostsPage.tsx',
  'financials/ReportsPage.tsx',
  // 10/17 (Nic): what was sold item by item, and each tax collected per agency.
  'financials/SalesTaxPage.tsx',
  'financials/BankActivityPage.tsx',
  'financials/PayoutsPage.tsx',
]
const ADAPTER = 'financials/adapter.ts'

function closure(app: string): Set<string> {
  const base = join(root, 'apps', app, 'src')
  const seen = new Set<string>()
  const stack = [...ENTRY_POINTS]
  while (stack.length) {
    const f = stack.pop()!
    if (seen.has(f)) continue
    seen.add(f)
    if (!/\.(tsx?|mts)$/.test(f)) continue          // a stylesheet imports nothing we follow
    if (f === ADAPTER) continue                       // each app's own: its imports are its business
    const src = readFileSync(join(base, f), 'utf8')
    const re = /(?:import|export)\s[^'"]*?from\s+['"](\.[^'"]+)['"]|import\s+['"](\.[^'"]+)['"]|import\(\s*['"](\.[^'"]+)['"]\s*\)/g
    let m: RegExpExecArray | null
    while ((m = re.exec(src))) {
      const rel = m[1] ?? m[2] ?? m[3]
      const d = normalize(join(dirname(f), rel))
      const hit = [d, `${d}.tsx`, `${d}.ts`, `${d}/index.tsx`, `${d}/index.ts`].find(c => existsSync(join(base, c)))
      if (hit) stack.push(hit)
    }
  }
  return seen
}

/** Names a file imports from './adapter'. */
function adapterImports(src: string): string[] {
  const out: string[] = []
  const re = /import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+['"]\.\/adapter['"]/g
  let m: RegExpExecArray | null
  while ((m = re.exec(src))) {
    for (const part of m[1].split(',')) {
      const name = part.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0].trim()
      if (name) out.push(name)
    }
  }
  return out
}

/** Names an adapter exports. */
function exportsOf(src: string): Set<string> {
  const names = new Set<string>()
  const re = /export\s+(?:async\s+)?(?:function|const|interface|type|class)\s+([A-Za-z0-9_]+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(src))) names.add(m[1])
  return names
}

describe('financial pages parity (landlord portal === GAM Books)', () => {
  const landlord = closure('landlord')
  const books = closure('books')

  it('both apps reach the same files', () => {
    expect([...books].sort()).toEqual([...landlord].sort())
  })

  it('every file a financial page reaches lives in src/financials', () => {
    const outside = [...landlord, ...books].filter(f => !f.startsWith('financials/'))
    expect(outside, 'a financial page imports a file outside src/financials — move it in (both apps) or go through adapter.ts').toEqual([])
  })

  for (const f of [...closure('landlord')].filter(f => f !== ADAPTER).sort()) {
    it(`${f} is byte-identical in apps/landlord and apps/books`, () => {
      const a = readFileSync(join(root, 'apps/landlord/src', f), 'utf8')
      const b = readFileSync(join(root, 'apps/books/src', f), 'utf8')
      expect(b, `${f} differs — copy the change to both apps`).toBe(a)
    })
  }

  it('both adapters export every name the shared files take from them', () => {
    const needed = new Set<string>()
    for (const f of landlord) {
      if (f === ADAPTER || !/\.tsx?$/.test(f)) continue
      for (const n of adapterImports(readFileSync(join(root, 'apps/landlord/src', f), 'utf8'))) needed.add(n)
    }
    expect(needed.size).toBeGreaterThan(0)
    for (const app of ['landlord', 'books']) {
      const exported = exportsOf(readFileSync(join(root, 'apps', app, 'src', ADAPTER), 'utf8'))
      const missing = [...needed].filter(n => !exported.has(n))
      expect(missing, `apps/${app}/src/${ADAPTER} is missing exports`).toEqual([])
    }
  })

  it('the shared pages use no icon set (GAM Books has none)', () => {
    for (const f of landlord) {
      if (!/\.tsx?$/.test(f)) continue
      const src = readFileSync(join(root, 'apps/landlord/src', f), 'utf8')
      expect(src.includes("from 'lucide-react'"), `${f} imports lucide-react`).toBe(false)
    }
  })
})
