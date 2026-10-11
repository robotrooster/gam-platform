/**
 * 10/11 (Nic) — EVERY API ROUTE, ENUMERATED: WHICH ONES A BOOKKEEPER REACHES.
 *
 * Reads the real mount table (index.ts) and every route the routers declare,
 * then asks the bookkeeper gate (lib/bookkeeperAccess) about each one. The
 * routes a bookkeeper may reach are exactly: their own sign-in, the GAM Books
 * ledger (not its rent roll), the shared financial pages, expenses (no
 * removing), the P&L reports, and the theme and announcements. Anything a new
 * route adds under those, or anything that slips onto the list, fails here
 * until somebody decides it on purpose.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, existsSync } from 'fs'
import { join } from 'path'
import { isBookkeeperRequestAllowed, scrubPersonFields, bookkeeperResponseIsScrubbed } from './bookkeeperAccess'

const SRC = join(__dirname, '..')
const UUID = '5f0e8a8e-1a2b-4c3d-9e8f-0123456789ab'

interface Route { method: string; template: string; path: string }

function enumerateRoutes(): Route[] {
  const index = readFileSync(join(SRC, 'index.ts'), 'utf8')
  // router variable → the file that defines it
  const fileOf = new Map<string, string>()
  const importRe = /import\s*\{([^}]*)\}\s*from\s*'\.\/(routes\/[^']+)'/g
  let m: RegExpExecArray | null
  while ((m = importRe.exec(index))) {
    for (const name of m[1].split(',').map(x => x.trim().split(/\s+as\s+/).pop()!.trim()).filter(Boolean)) {
      fileOf.set(name, m[2])
    }
  }
  // mounts: app.use('/api/x', ...mw, fooRouter)
  const mounts: Array<{ prefix: string; router: string }> = []
  const useRe = /app\.use\(\s*'(\/api[^']*)'\s*,([^)]*)\)/g
  while ((m = useRe.exec(index))) {
    const ids = m[2].split(',').map(x => x.trim()).filter(x => /Router$/.test(x))
    if (ids.length) mounts.push({ prefix: m[1].replace(/\/$/, ''), router: ids[ids.length - 1] })
  }
  const out: Route[] = []
  for (const { prefix, router } of mounts) {
    const rel = fileOf.get(router)
    if (!rel) continue
    const file = [join(SRC, `${rel}.ts`), join(SRC, rel, 'index.ts')].find(f => existsSync(f))
    if (!file) continue
    const src = readFileSync(file, 'utf8')
    const routeRe = new RegExp(`${router}\\.(get|post|put|patch|delete)\\(\\s*['\`"]([^'\`"]+)['\`"]`, 'g')
    let r: RegExpExecArray | null
    while ((r = routeRe.exec(src))) {
      const template = `${prefix}${r[2] === '/' ? '' : r[2]}` || '/'
      const path = template.replace(/:[A-Za-z_]+(\([^)]*\))?/g, seg => seg.startsWith(':filename') ? 'receipt.png' : UUID)
      out.push({ method: r[1].toUpperCase(), template, path })
    }
  }
  return out
}

const EXPECTED_ALLOWED = new Set([
  'GET /api/financials/scope',
  'GET /api/financials/units',
  'GET /api/financials/income',
  'GET /api/financials/maintenance-costs',
  'GET /api/financials/bank-activity',
  'GET /api/financials/payouts',
  'GET /api/expenses',
  'POST /api/expenses',
  'PATCH /api/expenses/:id',
  'POST /api/expenses/:id/receipt',
  'GET /api/expenses/receipt-files/:filename',
  'GET /api/reports/summary',
  'GET /api/reports/monthly-pl',
  'GET /api/reports/property-pl',
  'GET /api/reports/site-downtime',
  'GET /api/reports/property-detail',
  'GET /api/landlords/theme',
  'GET /api/announcements',
])

describe('the bookkeeper gate, against every route the API declares', () => {
  const routes = enumerateRoutes()

  it('found the whole API (sanity)', () => {
    expect(routes.length).toBeGreaterThan(500)
    const has = (m: string, t: string) => routes.some(r => r.method === m && r.template === t)
    expect(has('GET', '/api/tenants')).toBe(true)
    expect(has('GET', '/api/financials/income')).toBe(true)
  })

  it('allows exactly: sign-in, the Books ledger (not its rent roll), the financial pages, expenses and the P&L', () => {
    const allowed = routes.filter(r => isBookkeeperRequestAllowed(r.method, r.path))
    const unexpected = allowed
      .filter(r => !r.template.startsWith('/api/auth') && !r.template.startsWith('/api/books'))
      .map(r => `${r.method} ${r.template}`)
      .filter(k => !EXPECTED_ALLOWED.has(k))
    expect(unexpected).toEqual([])
    const reached = new Set(allowed.map(r => `${r.method} ${r.template}`))
    expect([...EXPECTED_ALLOWED].filter(k => !reached.has(k))).toEqual([])
  })

  it('refuses tenants, leases, documents, e-sign, messages, bookings, background checks, team, settings, banking, payouts actions, the register, payments, credits and maintenance requests', () => {
    const refusedPrefixes = [
      '/api/tenants', '/api/leases', '/api/documents', '/api/esign', '/api/signing-packages',
      '/api/notifications', '/api/agent', '/api/announcements/',
      '/api/bookings', '/api/units', '/api/background', '/api/renter-pool',
      '/api/scopes', '/api/landlords/me', '/api/bank-feed', '/api/bank-accounts', '/api/bank-reconciliations',
      '/api/stripe', '/api/disbursements', '/api/pos', '/api/payments', '/api/balances', '/api/tenant-credits',
      '/api/maintenance', '/api/maint-portal', '/api/properties', '/api/utility', '/api/work-trade',
      '/api/inspections', '/api/entry-requests', '/api/home-sales', '/api/lot-rent', '/api/admin',
    ]
    const leaks = routes
      .filter(r => refusedPrefixes.some(p => r.template === p || r.template.startsWith(p.endsWith('/') ? p : p + '/') || r.template === p))
      .filter(r => isBookkeeperRequestAllowed(r.method, r.path))
      .map(r => `${r.method} ${r.template}`)
    expect(leaks).toEqual([])
    // and there were plenty to check
    expect(routes.filter(r => refusedPrefixes.some(p => r.template.startsWith(p))).length).toBeGreaterThan(300)
  })

  it('never lets a bookkeeper remove an expense or read the Books rent roll', () => {
    expect(isBookkeeperRequestAllowed('POST', `/api/expenses/${UUID}/void`)).toBe(false)
    expect(isBookkeeperRequestAllowed('GET', '/api/books/rent-roll')).toBe(false)
    expect(isBookkeeperRequestAllowed('GET', '/api/books/rent-roll?basis=billed')).toBe(false)
    expect(isBookkeeperRequestAllowed('GET', '/api/books/accounts')).toBe(true)
    expect(isBookkeeperRequestAllowed('POST', '/api/financials/income')).toBe(false)
  })
})

describe('scrubPersonFields', () => {
  it('takes out every person-naming key, in either spelling, at any depth', () => {
    const out = scrubPersonFields({
      total: 5, propertyName: 'Mountain View', name: 'Electric',
      rows: [{ tenant_first: 'Z', tenantLast: 'Q', email: 'z@q', unit_number: '4', guestName: 'G', lease_id: 'x' }],
      nested: { landlord: { firstName: 'Nic', lastName: 'R', business_name: 'MV LLC' } },
    })
    expect(out).toEqual({
      total: 5, propertyName: 'Mountain View', name: 'Electric',
      rows: [{ unit_number: '4' }],
      nested: { landlord: { business_name: 'MV LLC' } },
    })
  })

  it('leaves their own sign-in and the Books ledger alone', () => {
    expect(bookkeeperResponseIsScrubbed('/api/auth/me')).toBe(false)
    expect(bookkeeperResponseIsScrubbed('/api/books/employees')).toBe(false)
    expect(bookkeeperResponseIsScrubbed('/api/reports/monthly-pl?year=2026')).toBe(true)
    expect(bookkeeperResponseIsScrubbed('/api/financials/income')).toBe(true)
  })
})
