// 10/12 (Nic): "Bookkeeping" in the landlord menu brings the GAM Books pages
// INSIDE the landlord portal — chart of accounts, journal entries, bills,
// vendors, contractors, employees, payroll, tax, bank reconciliation, the
// Books reports and the dashboard — ONE set of pages shared by both apps, like
// the Financials pages (financials-parity.test.ts).
//
// The Books pages ship in TWO apps — GAM Books (apps/books) and the landlord
// portal (apps/landlord). Same rule as the financial pages: the guard FOLLOWS
// THE IMPORTS. Every file a Books page reaches, directly or through another
// file (CSS included), must be byte-identical in both apps, and must live in
// src/bookkeeping — so a page cannot quietly lean on something one app has
// and the other does not.
//
// The ONE exception is src/bookkeeping/adapter.ts: how each app talks to the
// API, shows a toast, knows who is looking and where each Books page lives.
// It is checked differently — every name a shared file imports from it must
// be exported by BOTH copies.
//
// If it fails: you edited a Books page in one app and not the other — make the
// same change in both (copy the file across).
import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'fs'
import { resolve, dirname, join, normalize } from 'path'

const root = resolve(__dirname, '../../..')  // apps/api/src → repo root
const ENTRY_POINTS = [
  'bookkeeping/BooksDashboardPage.tsx',
  'bookkeeping/ChartOfAccountsPage.tsx',
  'bookkeeping/JournalEntriesPage.tsx',
  'bookkeeping/TransactionsPage.tsx',
  'bookkeeping/BankReconcilePage.tsx',
  'bookkeeping/BillsPage.tsx',
  'bookkeeping/VendorsPage.tsx',
  'bookkeeping/ContractorsPage.tsx',
  'bookkeeping/EmployeesPage.tsx',
  'bookkeeping/RunPayrollPage.tsx',
  'bookkeeping/PayHistoryPage.tsx',
  'bookkeeping/TaxFormsPage.tsx',
  'bookkeeping/TaxCenterPage.tsx',
  'bookkeeping/ProfitLossPage.tsx',
  'bookkeeping/BalanceSheetPage.tsx',
  'bookkeeping/CashFlowPage.tsx',
  'bookkeeping/OwnerStatementsPage.tsx',
  // 10/12 (Nic): the company's books settings and what its books start with.
  'bookkeeping/BooksSettingsPage.tsx',
  'bookkeeping/OpeningBalancesPage.tsx',
  // 10/12 (Nic): loans and fixed assets.
  'bookkeeping/LoansPage.tsx',
  'bookkeeping/FixedAssetsPage.tsx',
  // 10/12 (Nic, ledger P9): closing a month.
  'bookkeeping/CloseMonthPage.tsx',
]
const ADAPTER = 'bookkeeping/adapter.ts'

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

/** The page names an adapter's BOOKS_PATHS files, and their addresses. */
function booksPaths(app: string): Record<string, string> {
  const src = readFileSync(join(root, 'apps', app, 'src', ADAPTER), 'utf8')
  const block = src.match(/export const BOOKS_PATHS[^{]*\{([\s\S]*?)\n\}/)
  expect(block, `apps/${app}/src/${ADAPTER} has no BOOKS_PATHS`).toBeTruthy()
  const out: Record<string, string> = {}
  for (const m of block![1].matchAll(/^\s*([A-Za-z]+):\s*'([^']+)'/gm)) out[m[1]] = m[2]
  return out
}

describe('Books pages parity (GAM Books === landlord portal Bookkeeping)', () => {
  const landlord = closure('landlord')
  const books = closure('books')

  it('both apps reach the same files', () => {
    expect([...books].sort()).toEqual([...landlord].sort())
  })

  it('every file a Books page reaches lives in src/bookkeeping', () => {
    const outside = [...landlord, ...books].filter(f => !f.startsWith('bookkeeping/'))
    expect(outside, 'a Books page imports a file outside src/bookkeeping — move it in (both apps) or go through adapter.ts').toEqual([])
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

  it('both adapters file every Books page, each at its own address', () => {
    const l = booksPaths('landlord'), b = booksPaths('books')
    expect(Object.keys(l).sort()).toEqual(Object.keys(b).sort())
    expect(Object.keys(l).length).toBeGreaterThanOrEqual(ENTRY_POINTS.length)
    // The portal's own pages (/reports, /bank, /expenses...) stay its own.
    for (const [page, path] of Object.entries(l)) expect(path, page).toMatch(/^\/bookkeeping\//)
  })

  it('a shared page links to another Books page through the adapter, never a fixed address', () => {
    // An address is one app's: "/payroll/employees" is a Books page and a dead
    // end in the portal. booksPath() gives each app its own.
    for (const f of landlord) {
      if (!/\.tsx?$/.test(f) || f === ADAPTER) continue
      const src = readFileSync(join(root, 'apps/landlord/src', f), 'utf8')
      expect(/\bhref=["']\/|\bto=["']\/|navigate\(\s*['"`]\//.test(src), `${f} links to a fixed address`).toBe(false)
    }
  })

  it('every Books page has a route in each app', () => {
    // Books names them through BOOKS_PATHS in its own routes; the portal too.
    for (const app of ['books', 'landlord']) {
      const main = readFileSync(join(root, 'apps', app, 'src', 'main.tsx'), 'utf8')
      for (const page of Object.keys(booksPaths(app))) {
        expect(main.includes(`path={BOOKS_PATHS.${page}}`), `apps/${app}/src/main.tsx has no route for ${page}`).toBe(true)
      }
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
