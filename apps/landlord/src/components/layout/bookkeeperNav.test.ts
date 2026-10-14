// 10/11 (Nic): a bookkeeper signed into the landlord portal sees the shared
// financial pages and nothing else — "money coming in, money going out...
// the maintenance costs" — and the owner keeps every tab they had.
// 10/12 (Nic): "Bookkeeping" brings the GAM Books pages inside the portal, as
// sub-tabs like Financials; the bank account, payouts and the company's books
// are the company-wide box's; staff with "View all payments" reach the Rent
// Roll. 10/13 (Nic): "payments first" — Payments leads Financials.
// 10/13 (Nic), the afternoon answers: "Bookkeepers SEE the Payments and Rent
// Roll pages, read-only" (with any property money), and "REMOVE the
// Outstanding Balances tab".
import { describe, it, expect } from 'vitest'
import { visibleNavItemsFor, sidebarNavItemsFor, staffLandingPath, bookkeeperRedirect } from './Layout'
import { BOOKS_PATHS } from '../../bookkeeping/adapter'

const PROPERTY_MONEY = ['/payments', '/rent-roll', '/income', '/reports', '/expenses', '/maintenance-costs']
// 10/12 (Nic): Categories is every bookkeeper's, whatever is ticked for them —
// the server lets each keep the company's categories (routes/expenses).
const EVERY_BOOKKEEPER = [BOOKS_PATHS.categories]
const COMPANY_WIDE_FINANCIALS = ['/bank-activity', '/payouts']
// 10/12 (Nic): the old Contractors address is a page (it opens Vendors on its
// Contractors tab) but never a menu entry — contractors are vendors now.
// 10/12 (Nic, L5): Transactions and Bills & AP retired for a landlord (money
// out is one record, on Expenses) — their old addresses say where it went, but
// neither is a menu entry.
const NOT_IN_MENU: string[] = [BOOKS_PATHS.contractors, BOOKS_PATHS.transactions, BOOKS_PATHS.bills]
const BOOKKEEPING = Object.values(BOOKS_PATHS).filter(p => !NOT_IN_MENU.includes(p))
const sorted = (a: string[]) => [...a].sort()
const paths = (u: Parameters<typeof visibleNavItemsFor>[0]) => visibleNavItemsFor(u).map(i => i.to)

describe('landlord portal navigation for a bookkeeper', () => {
  it('shows only the shared financial pages, and Categories', () => {
    expect(sorted(paths({ role: 'bookkeeper', permissions: { access_level: 'read_only' } }))).toEqual(sorted([...PROPERTY_MONEY, ...EVERY_BOOKKEEPER]))
  })

  it('hides tenants, leases, documents, messages, schedule, screening, team and settings', () => {
    const shown = new Set(paths({ role: 'bookkeeper', companyWide: true }))
    for (const path of ['/tenants', '/leases', '/documents', '/esign', '/schedule', '/background', '/pool',
      '/screening', '/team', '/settings', '/balances', '/maintenance', '/pos',
      '/dashboard', '/properties', '/units', '/disbursements', '/bank', '/banking', '/front-desk']) {
      expect(shown.has(path), `${path} should be hidden from a bookkeeper`).toBe(false)
    }
  })

  it('folds into Financials, and Bookkeeping landing on Categories (10/12: every bookkeeper keeps them)', () => {
    const side = sidebarNavItemsFor({ role: 'bookkeeper' })
    expect(side.map(s => s.label)).toEqual(['Financials', 'Bookkeeping'])
    expect(side[1].to).toBe(BOOKS_PATHS.categories)
  })

  it('the company-wide box, and only it, opens Bank Activity, Payouts and Bookkeeping', () => {
    // The server's rule (lib/financialsScope refuseWithoutCompanyWide,
    // routes/books.ts) — never "every property ticked".
    expect(sorted(paths({ role: 'bookkeeper', companyWide: false }))).toEqual(sorted([...PROPERTY_MONEY, ...EVERY_BOOKKEEPER]))
    expect(sorted(paths({ role: 'bookkeeper', companyWide: true })))
      .toEqual(sorted([...PROPERTY_MONEY, ...COMPANY_WIDE_FINANCIALS, ...BOOKKEEPING]))
    // Every property ticked but no box: still not offered.
    expect(paths({ role: 'bookkeeper', allProperties: true } as any)).not.toContain('/bank-activity')
  })

  it('with the box, the sidebar carries Financials and Bookkeeping, Bookkeeping landing on its dashboard', () => {
    const side = sidebarNavItemsFor({ role: 'bookkeeper', companyWide: true })
    expect(side.map(s => s.label)).toEqual(['Financials', 'Bookkeeping'])
    expect(side[1].to).toBe(BOOKS_PATHS.dashboard)
  })

  it('10/12 (Nic, BK1): the ledger box opens the Books ledger pages — never Bank Activity, Payouts, Cash Flow or Owner Statements', () => {
    // The server's own split (routes/books BOOKS_LEDGER): the cash flow and
    // owner statements carry the payouts, the company-wide box's.
    // 10/12 (Nic, ledger P9): closing a month is the company-wide box's too.
    const LEDGER = BOOKKEEPING.filter(p => p !== BOOKS_PATHS.cashFlow && p !== BOOKS_PATHS.ownerStatements && p !== BOOKS_PATHS.closeMonth)
    expect(sorted(paths({ role: 'bookkeeper', companyWide: false, ledger: true })))
      .toEqual(sorted([...PROPERTY_MONEY, ...LEDGER]))
    const side = sidebarNavItemsFor({ role: 'bookkeeper', ledger: true })
    expect(side.map(s => s.label)).toEqual(['Financials', 'Bookkeeping'])
    expect(side[1].to).toBe(BOOKS_PATHS.dashboard)
    // Company-wide holds the ledger too.
    expect(sorted(paths({ role: 'bookkeeper', companyWide: true, ledger: false })))
      .toEqual(sorted([...PROPERTY_MONEY, ...COMPANY_WIDE_FINANCIALS, ...BOOKKEEPING]))
  })

  it('10/12 (Nic): Categories shows for every bookkeeper — no box ticked at all, property money only, or the ledger', () => {
    expect(paths({ role: 'bookkeeper', companyWide: false, ledger: false, propertyMoney: false })).toEqual([BOOKS_PATHS.categories])
    for (const u of [{ companyWide: false }, { ledger: true }, { companyWide: true, propertyMoney: false }]) {
      expect(paths({ role: 'bookkeeper', ...u }), JSON.stringify(u)).toContain(BOOKS_PATHS.categories)
    }
  })

  it('a bookkeeper with no property ticked keeps the company-wide pages and no property money', () => {
    expect(sorted(paths({ role: 'bookkeeper', companyWide: true, propertyMoney: false })))
      .toEqual(sorted([...COMPANY_WIDE_FINANCIALS, ...BOOKKEEPING]))
  })

  // 10/11: a bookkeeper lands on Money in. 10/13 review: Payments and the Rent
  // Roll joining their menu above it must not move where they land.
  it('lands on Money in after signing in, and Financials opens there — Payments and the Rent Roll are in the menu', () => {
    for (const u of [{ role: 'bookkeeper' }, { role: 'bookkeeper', companyWide: true }, { role: 'bookkeeper', ledger: true }]) {
      expect(staffLandingPath(u), JSON.stringify(u)).toBe('/income')
      expect(sidebarNavItemsFor(u).find(s => s.label === 'Financials')?.to, JSON.stringify(u)).toBe('/income')
      expect(paths(u), JSON.stringify(u)).toEqual(expect.arrayContaining(['/payments', '/rent-roll']))
    }
    // No property money: no Money in — the first page they have, as for staff.
    expect(staffLandingPath({ role: 'bookkeeper', companyWide: true, propertyMoney: false }))
      .toBe(visibleNavItemsFor({ role: 'bookkeeper', companyWide: true, propertyMoney: false })[0].to)
    expect(staffLandingPath({ role: 'bookkeeper', propertyMoney: false })).toBe(BOOKS_PATHS.categories)
  })

  it('a staff permission map never widens it', () => {
    const items = paths({ role: 'bookkeeper', permissions: { 'tenants.view': true, 'leases.view': true, 'payments.view_all': true } as any })
    expect(sorted(items)).toEqual(sorted([...PROPERTY_MONEY, ...EVERY_BOOKKEEPER]))
  })
})

describe('landlord portal navigation for the owner', () => {
  it('keeps the owner-only financial tabs and gains Money In and Maintenance Costs', () => {
    const shown = new Set(paths({ role: 'landlord' }))
    for (const path of ['/payments', '/rent-roll', '/disbursements', '/reports', '/expenses',
      '/income', '/maintenance-costs', '/bank', '/banking']) {
      expect(shown.has(path), `${path} should show for the owner`).toBe(true)
    }
  })

  // 10/13 (Nic): "REMOVE the Outstanding Balances tab."
  it('has no Outstanding Balances tab — for anyone', () => {
    for (const u of [{ role: 'landlord' }, { role: 'admin' }, { role: 'onsite_manager', permissions: { 'balances.view': true } },
      { role: 'property_manager', permissions: { 'payments.view_all': true, 'balances.view': true } }, { role: 'bookkeeper', companyWide: true }]) {
      expect(paths(u), JSON.stringify(u)).not.toContain('/balances')
      expect(visibleNavItemsFor(u).some(i => i.label === 'Outstanding Balances'), JSON.stringify(u)).toBe(false)
    }
  })

  it("does not repeat Bank and Disbursements as the bookkeeper's read-only copies", () => {
    const shown = new Set(paths({ role: 'landlord' }))
    expect(shown.has('/bank-activity')).toBe(false)
    expect(shown.has('/payouts')).toBe(false)
  })

  // 10/13 (Nic): "payments first. with a way to log the payments."
  it('Payments leads the Financials hub, the Rent Roll right after it', () => {
    const fin = visibleNavItemsFor({ role: 'landlord' }).filter(i => i.hub === 'financials')
    expect(fin.slice(0, 2).map(i => i.to)).toEqual(['/payments', '/rent-roll'])
    const side = sidebarNavItemsFor({ role: 'landlord' })
    expect(side.find(s => s.label === 'Financials')?.to).toBe('/payments')
  })

  it('gains Bookkeeping: every GAM Books page as a sub-tab, in Books\' order', () => {
    const bk = visibleNavItemsFor({ role: 'landlord' }).filter(i => i.hub === 'bookkeeping')
    expect(bk.map(i => i.to)).toEqual([
      // 10/12 (Nic): contractors are vendors — one list (the old address opens it).
      BOOKS_PATHS.dashboard, BOOKS_PATHS.employees, BOOKS_PATHS.vendors,
      BOOKS_PATHS.runPayroll, BOOKS_PATHS.payHistory, BOOKS_PATHS.taxForms,
      // 10/12 (Nic, L5): no Transactions or Bills & AP — money out is on Expenses.
      BOOKS_PATHS.accounts, BOOKS_PATHS.journal, BOOKS_PATHS.reconcile,
      // 10/12 (Nic, L3, ledger P9): close a month, after reconciling the banks.
      BOOKS_PATHS.closeMonth,
      // 10/12 (Nic): loans and fixed assets.
      BOOKS_PATHS.loans, BOOKS_PATHS.fixedAssets,
      BOOKS_PATHS.profitLoss, BOOKS_PATHS.balanceSheet,
      // 10/12 (Nic, ledger P8): the trial balance and the general ledger.
      BOOKS_PATHS.trialBalance, BOOKS_PATHS.generalLedger,
      BOOKS_PATHS.cashFlow, BOOKS_PATHS.ownerStatements, BOOKS_PATHS.taxCenter,
      // 10/12 (Nic): the company's books settings and what its books start with.
      BOOKS_PATHS.booksSettings, BOOKS_PATHS.openingBalances,
      // 10/12 (Nic, L5): the company's own categories.
      BOOKS_PATHS.categories,
    ])
    const side = sidebarNavItemsFor({ role: 'landlord' })
    const entry = side.find(s => s.label === 'Bookkeeping')
    expect(entry?.hub).toBe('bookkeeping')
    expect(entry?.to).toBe(BOOKS_PATHS.dashboard)
    // One sidebar entry, right after Financials.
    expect(side.filter(s => s.hub === 'bookkeeping')).toHaveLength(1)
    expect(side.findIndex(s => s.label === 'Bookkeeping')).toBe(side.findIndex(s => s.label === 'Financials') + 1)
  })

  it('an admin is not offered Bookkeeping (GAM Books keeps admins out, S568)', () => {
    for (const role of ['admin', 'super_admin']) {
      expect(paths({ role }).some(p => BOOKKEEPING.includes(p)), role).toBe(false)
    }
  })
})

describe('landlord portal navigation for staff', () => {
  it('staff never see the new financial pages or Bookkeeping', () => {
    const shown = new Set(paths({ role: 'onsite_manager', permissions: { 'payments.view_all': true, 'books.view': true } as any }))
    for (const path of ['/income', '/maintenance-costs', '/bank-activity', '/payouts', '/expenses', ...BOOKKEEPING]) {
      expect(shown.has(path), path).toBe(false)
    }
  })

  it('staff land on the first page their switches grant; none at all: the welcome page', () => {
    expect(staffLandingPath({ role: 'onsite_manager', permissions: { 'payments.view_all': true } })).toBe('/payments')
    expect(staffLandingPath({ role: 'onsite_manager', permissions: {} })).toBe('/welcome')
  })

  // 10/13 (Nic): who owes and Record payment are under Payments now.
  it('"View who owes" alone shows the Payments tab (where that list is now) — never the Rent Roll', () => {
    const desk = paths({ role: 'onsite_manager', permissions: { 'balances.view': true } })
    expect(desk).toContain('/payments')
    expect(desk).not.toContain('/rent-roll')
    expect(paths({ role: 'onsite_manager', permissions: {} })).not.toContain('/payments')
  })

  it('"View all payments" reaches the Rent Roll; "View payments" alone does not', () => {
    for (const role of ['onsite_manager', 'property_manager']) {
      expect(paths({ role, permissions: { 'payments.view_all': true } }), role).toContain('/rent-roll')
      const viewOnly = paths({ role, permissions: { 'payments.view': true } })
      expect(viewOnly, role).not.toContain('/rent-roll')
      expect(viewOnly, role).toContain('/payments')
    }
    expect(paths({ role: 'onsite_manager', permissions: {} })).not.toContain('/rent-roll')
  })
})

// 10/13 (Nic): "there was some kind of issue on the signing up flow through the
// bookkeeper invite link." After her code she arrived at the portal's own
// address ('/'), which is not one of her pages, so Layout's guard sent her to
// the first page of her menu — Payments, since 10/13 put it first — and
// RoleRedirect's landing (Money in, pinned above) never ran for a bookkeeper.
describe("where Layout sends a bookkeeper who is not on one of their pages", () => {
  const BK = { role: 'bookkeeper' }
  const BK_WIDE = { role: 'bookkeeper', companyWide: true }

  it("signing in ('/') lands on Money in — the decided landing, not the first menu item", () => {
    for (const [u, loading] of [[BK, true], [BK, false], [BK_WIDE, true], [BK_WIDE, false], [{ role: 'bookkeeper', ledger: true }, false]] as const) {
      expect(bookkeeperRedirect('/', u, loading), JSON.stringify({ u, loading })).toBe('/income')
      expect(bookkeeperRedirect('/', u, loading)).toBe(staffLandingPath(loading ? { ...u, companyWide: true } : u))
    }
  })

  it('a page that is not theirs goes to the same landing; their own pages stay put', () => {
    for (const p of ['/dashboard', '/tenants', '/settings', '/team', '/balances']) {
      expect(bookkeeperRedirect(p, BK_WIDE, false), p).toBe('/income')
    }
    for (const p of ['/payments', '/rent-roll', '/income', '/reports', BOOKS_PATHS.categories]) {
      expect(bookkeeperRedirect(p, BK, false), p).toBeNull()
    }
    expect(bookkeeperRedirect('/bank-activity', BK_WIDE, false)).toBeNull()
  })

  it('while the scope is loading, the company-wide pages are let through; once it answers, a page that is not theirs leaves', () => {
    expect(bookkeeperRedirect('/bank-activity', { role: 'bookkeeper' }, true)).toBeNull()
    expect(bookkeeperRedirect('/bank-activity', { role: 'bookkeeper', companyWide: false }, false)).toBe('/income')
  })

  it('no property ticked: no Money in, so the first page they have (never a loop)', () => {
    const noProps = { role: 'bookkeeper', companyWide: true, propertyMoney: false }
    const to = bookkeeperRedirect('/', noProps, false)
    expect(to).toBe(staffLandingPath(noProps))
    expect(bookkeeperRedirect(to!, noProps, false)).toBeNull()
    const onlyCategories = { role: 'bookkeeper', propertyMoney: false }
    expect(bookkeeperRedirect('/', onlyCategories, false)).toBe(BOOKS_PATHS.categories)
    expect(bookkeeperRedirect(BOOKS_PATHS.categories, onlyCategories, false)).toBeNull()
  })

  it('the bare /bookkeeping address opens the Books dashboard when it is theirs (10/12 review)', () => {
    expect(bookkeeperRedirect('/bookkeeping', BK_WIDE, false)).toBe(BOOKS_PATHS.dashboard)
    expect(bookkeeperRedirect('/bookkeeping', BK, false)).toBe('/income')
  })
})
