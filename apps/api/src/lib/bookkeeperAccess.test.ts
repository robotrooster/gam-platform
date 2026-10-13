/**
 * 10/11 (Nic) — EVERY API ROUTE, ENUMERATED: WHICH ONES A BOOKKEEPER REACHES.
 *
 * Reads the real mount table (index.ts) and every route the routers declare,
 * then asks the bookkeeper gate (lib/bookkeeperAccess) about each one. The
 * routes a bookkeeper may reach are exactly: their own sign-in, the GAM Books
 * ledger (its rent roll included — tenant names are allowed where the books
 * need them), the shared financial pages, expenses (10/12, Nic: removing one too
 * — full bookkeeping at one level), the P&L
 * reports, and the theme and announcements. Anything a new route adds under
 * those, or anything that slips onto the list, fails here until somebody
 * decides it on purpose.
 *
 * And the scrub every other response passes: contact and identity details out
 * (email, phone, address, date of birth, SSN, license, vehicle, tenant user
 * id), names and ids in.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, existsSync } from 'fs'
import { join } from 'path'
import { isBookkeeperRequestAllowed, scrubPersonFields, bookkeeperResponseIsScrubbed, bookkeeperHasPerm } from './bookkeeperAccess'

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
  // 10/12 (Nic, ledger decision 2): full bookkeeping — removing an expense too (design §11).
  'POST /api/expenses/:id/void',
  'POST /api/expenses/:id/receipt',
  'GET /api/expenses/receipt-files/:filename',
  // 10/12 (Nic, L5/L6/L19): the company's categories, the Expenses form's
  // choices, paying a bill, and a repair's bill — money going out.
  'GET /api/expenses/options',
  'GET /api/expenses/categories',
  'POST /api/expenses/categories',
  'PATCH /api/expenses/categories/:id',
  'POST /api/expenses/:id/payments',
  'POST /api/expenses/:id/payments/:paymentId/void',
  'POST /api/expenses/repairs/:requestId/bill',
  // 10/12 (Nic, L19; design §11): bank lines, with the company-wide box (the
  // routes check it, and money coming in against the owner's choice).
  'GET /api/bank-feed/connections',
  'GET /api/bank-feed/transactions',
  'GET /api/bank-feed/transactions/:id/matches',
  'POST /api/bank-feed/transactions/:id/categorize',
  'POST /api/bank-feed/transactions/:id/split',
  'POST /api/bank-feed/transactions/:id/split/undo',
  'POST /api/bank-feed/transactions/:id/undo-filing',
  'POST /api/bank-feed/transactions/:id/ignore',
  'POST /api/bank-feed/transactions/:id/match-expenses',
  'POST /api/bank-feed/transactions/:id/match-record',
  // 10/13 (Nic): "Bank deposit 'Not rent': owner + bookkeeper (not front-desk staff)".
  'POST /api/bank-feed/deposits/:id/not-rent',
  'POST /api/bank-feed/deposits/:id/not-rent/undo',
  'GET /api/reports/summary',
  'GET /api/reports/monthly-pl',
  'GET /api/reports/property-pl',
  'GET /api/reports/site-downtime',
  'GET /api/reports/property-detail',
  // 10/12 (Nic): reachable; opened only with the owner's box (bookkeeperHasPerm, below).
  'GET /api/reports/monthly-report',
  'GET /api/reports/monthly-report/pdf',
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

  it('allows exactly: sign-in, the Books ledger (rent roll included), the financial pages, expenses and the P&L', () => {
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
      // 10/12 (Nic, L19): the bank lines' filing routes are opened on purpose (above).
      .filter(k => !EXPECTED_ALLOWED.has(k))
    expect(leaks).toEqual([])
    // Never a tenant's payment: confirming a deposit, a recorded deposit. (10/13,
    // Nic: "Not rent" is the owner's and the bookkeeper's — EXPECTED_ALLOWED.)
    for (const k of ['POST /api/bank-feed/deposits/:id/confirm', 'POST /api/bank-feed/deposits/:id/recorded-deposit',
                     'GET /api/bank-feed/deposits/unmatched', 'POST /api/bank-feed/link-session']) {
      const [m, t] = k.split(' ')
      expect(isBookkeeperRequestAllowed(m, t.replace(':id', UUID)), k).toBe(false)
    }
    // and there were plenty to check
    expect(routes.filter(r => refusedPrefixes.some(p => r.template.startsWith(p))).length).toBeGreaterThan(300)
  })

  it('10/12 (Nic): a bookkeeper removes an expense (full bookkeeping), never a tenant\'s payment; the Books rent roll is theirs again (10/11, names allowed)', () => {
    expect(isBookkeeperRequestAllowed('POST', `/api/expenses/${UUID}/void`)).toBe(true)
    // A tenant's account stays refused: recording or voiding a tenant's payment, a credit.
    expect(isBookkeeperRequestAllowed('POST', `/api/payments/${UUID}/record-manual`)).toBe(false)
    expect(isBookkeeperRequestAllowed('POST', `/api/payments/${UUID}/void`)).toBe(false)
    expect(isBookkeeperRequestAllowed('POST', '/api/tenant-credits')).toBe(false)
    expect(isBookkeeperRequestAllowed('GET', '/api/books/rent-roll')).toBe(true)
    expect(isBookkeeperRequestAllowed('GET', '/api/books/rent-roll?basis=billed')).toBe(true)
    expect(isBookkeeperRequestAllowed('GET', '/api/books/accounts')).toBe(true)
    expect(isBookkeeperRequestAllowed('POST', '/api/financials/income')).toBe(false)
  })
})

describe('10/12 (Nic): the monthly property report is the owner\'s box per bookkeeper', () => {
  it('the route is reachable, its recipient list never is', () => {
    expect(isBookkeeperRequestAllowed('GET', '/api/reports/monthly-report?month=2026-09')).toBe(true)
    expect(isBookkeeperRequestAllowed('GET', '/api/reports/monthly-report/pdf?month=2026-09')).toBe(true)
    expect(isBookkeeperRequestAllowed('GET', '/api/reports/monthly-report/recipients')).toBe(false)
    expect(isBookkeeperRequestAllowed('POST', '/api/reports/monthly-report/recipients')).toBe(false)
    expect(isBookkeeperRequestAllowed('POST', '/api/reports/monthly-report')).toBe(false)
  })

  it('SECURITY: its permission is held only with the box — never by a bare pass', () => {
    expect(bookkeeperHasPerm({ seesMonthlyReport: true }, 'reports.tab.monthly')).toBe(true)
    expect(bookkeeperHasPerm({ seesMonthlyReport: false }, 'reports.tab.monthly')).toBe(false)
    expect(bookkeeperHasPerm(undefined, 'reports.tab.monthly')).toBe(false)
    expect(bookkeeperHasPerm(null, 'reports.tab.monthly')).toBe(false)
    // The fixed keys stay theirs; the box opens no other key.
    expect(bookkeeperHasPerm(undefined, 'payments.view_all')).toBe(true)
    expect(bookkeeperHasPerm({ seesMonthlyReport: true }, 'reports.tab.statement')).toBe(false)
    expect(bookkeeperHasPerm({ seesMonthlyReport: true }, 'reports.tab.custom')).toBe(false)
  })
})

describe('scrubPersonFields — contact details out, names in (10/11, Nic)', () => {
  it('takes out every contact and identity key, in either spelling, at any depth', () => {
    const out = scrubPersonFields({
      total: 5, propertyName: 'Mountain View', name: 'Electric',
      rows: [{
        tenant_first: 'Z', tenantLast: 'Q', tenantName: 'Z Q', tenant_id: 't', lease_id: 'x', guestName: 'G', payerName: 'P',
        email: 'z@q', tenant_phone: '480', primaryPhoneNumber: '1', tenant_user_id: 'u', unit_number: '4',
        mailing_address: '1 Main St', date_of_birth: '1990-01-01', DOB: '1990', ssn_last4: '1234',
        drivers_license: 'D1', license_plate: 'ABC', vehicle_make: 'Ford', plate_state: 'AZ',
      }],
      tenants: [{ firstName: 'Z', lastName: 'Q', primaryEmail: 'z@q', phone: '1', vehicles: [{ plate: 'X' }] }],
      nested: { landlord: { firstName: 'Nic', lastName: 'R', business_name: 'MV LLC', office_email: 'o@x', officePhone: '2' } },
    })
    expect(out).toEqual({
      total: 5, propertyName: 'Mountain View', name: 'Electric',
      rows: [{ tenant_first: 'Z', tenantLast: 'Q', tenantName: 'Z Q', tenant_id: 't', lease_id: 'x', guestName: 'G', payerName: 'P', unit_number: '4' }],
      tenants: [{ firstName: 'Z', lastName: 'Q' }],
      nested: { landlord: { firstName: 'Nic', lastName: 'R', business_name: 'MV LLC' } },
    })
  })

  it('never mistakes a money or business key for a contact one', () => {
    const keep = {
      businessName: 'MV LLC', business_name: 'MV LLC', platformFee: 2, platform_fee: 2, emailSent: true,
      depositsHeld: 1, categoryLabel: 'Electric', method: 'ACH', entryDescription: 'RENT', propertyId: 'p',
    }
    expect(scrubPersonFields(keep)).toEqual(keep)
  })

  it('catches the address, vehicle, birth-date and email-token shapes a direct run let through (10/11)', () => {
    const out = scrubPersonFields({
      amount: 10,
      tenant_ssn_last4: '1234', street1: '1 Main', street2: 'Apt 2', zip: '85001', business_zip: '85002',
      vin: '1HG', guest_vehicle: 'Ford', rv_plate: 'ABC', tenant_dob: '1990-01-01', phone_e164: '+1480',
      email_verify_token: 'x', pending_email_token: 'y', mailing_city: 'Mesa', address_line1: '1 Main',
    })
    expect(out).toEqual({ amount: 10 })
    const keep = { businessName: 'MV LLC', emailSent: true, platformFee: 2, emailTemplate: 'welcome', leaseTemplateId: 't' }
    expect(scrubPersonFields(keep)).toEqual(keep)
  })

  it('leaves their own sign-in and the Books ledger alone', () => {
    expect(bookkeeperResponseIsScrubbed('/api/auth/me')).toBe(false)
    expect(bookkeeperResponseIsScrubbed('/api/books/employees')).toBe(false)
    expect(bookkeeperResponseIsScrubbed('/api/reports/monthly-pl?year=2026')).toBe(true)
    expect(bookkeeperResponseIsScrubbed('/api/financials/income')).toBe(true)
  })
})
