import { useState } from 'react'
import { NotificationBell } from '../NotificationBell'
import { ChatWidget } from '../ChatWidget'
import { apiGet } from '../../lib/api'
import { Outlet, NavLink, Navigate, useNavigate, useLocation } from 'react-router-dom'
import { DialogHost } from '../dialogs'
import { useQuery } from 'react-query'
import { useAuth } from '../../context/AuthContext'
import { PERMISSION_CATALOG } from '@gam/shared'
import {
  LayoutDashboard, Building2, DoorOpen, Users, CreditCard,
  ArrowDownToLine, Wrench, FileText, LogOut, Settings,
  ShoppingCart, Shield, Package, BarChart2, ScrollText,
  UserSearch, ClipboardList, HeartHandshake, PenTool, UserPlus,
  Landmark, ClipboardCheck, MessageSquare,
  Sun, Moon, Globe, Headphones, Camera, Gauge, BookOpen } from 'lucide-react'
import { BOOKS_PATHS } from '../../bookkeeping/adapter'

// S82: each nav item has a `roles` admission list (which roles MAY see
// it) and an optional `perm` list (sub-permission keys; worker roles
// only see the item if they hold ANY of these). Owner roles
// (admin/super_admin/landlord) bypass `perm` entirely. Items with no
// `perm` are role-only — used for landlord-self pages where no perm
// in the catalog applies. Reports + Work Trade are landlord-only at
// the backend (S81); PMs can't reach those endpoints, so they're
// dropped from `roles` here to match.
// Nav is driven by the permission CATALOG, not roles. A staff user sees an item
// iff they hold ANY permission key in that item's `category` (owners see all).
// Items with no `category` are owner-only (Team = permission management itself;
// Work Trade). `guest_access` lives under the schedule category in the catalog.
// S575: `hub` folds a cluster of items into ONE sidebar entry whose page
// (HubTabLayout) renders the cluster's members as sub-tabs. Order within a hub
// IS the tab order, and the first ACCESSIBLE member is that hub's landing page.
type Hub = 'financials' | 'screening' | 'bookkeeping'
const NAV_ITEMS: Array<{
  to: string
  icon: any
  label: string
  section: string | null
  category?: string
  hub?: Hub
  // 10/11 (Nic): the shared financial pages a bookkeeper sees — and the only
  // ones. 'only' = the bookkeeper's read-only view of something the owner
  // already has a fuller page for (Bank, Disbursements), so the owner's hub
  // does not carry it twice.
  bookkeeper?: true | 'only'
  // 10/12 (Nic): the company-wide box's — the bank account, payouts, payroll
  // and the company's own books. A bookkeeper sees it only with that box
  // ticked (the server refuses it otherwise).
  companyWide?: true
  // 10/12 (Nic, BK1): the whole-company Books ledger's — a bookkeeper sees it
  // with the company-wide box OR "May use the whole-company ledger"
  // (routes/books BOOKS_LEDGER, the server's own list).
  ledger?: true
  // 10/12 (Nic): every bookkeeper, whatever is ticked for them (Categories).
  everyBookkeeper?: true
}> = [
  // Overview
  { to: '/dashboard',     icon: LayoutDashboard, label: 'Dashboard',        section: 'Overview',    category: 'dashboard' },
  { to: '/pos',           icon: ShoppingCart,     label: 'Point of Sale',    section: null,          category: 'pos' },
  // Portfolio
  // S605 (Nic, DIRECTIVE): Utilities and Amenities were removed from top-level
  // nav — they are PROPERTY-scoped and now live as sub-tabs inside a property
  // (PropertyDetailPage). "A sub tab in the actual property... that way we see,
  // like, the amenities tab." Their routes remain registered so existing links
  // and bookmarks still resolve.
  { to: '/properties',    icon: Building2,        label: 'Properties',       section: 'Portfolio',   category: 'properties' },
  { to: '/units',         icon: DoorOpen,         label: 'Unit Overview',    section: null,          category: 'units' },
  // S652 (Nic): "build the meter readings top level nav entry for front
  // counter staff." Straight to the reading walk for the properties they are
  // assigned to; anyone holding "Enter meter readings" sees it. (S605 folded
  // Utilities SETUP into the property page; this is the walk, not the setup.)
  { to: '/utilities',     icon: Gauge,            label: 'Meter Readings',   section: null,          category: 'utilities' },
  { to: '/schedule',      icon: DoorOpen,         label: 'Master Schedule',  section: null,          category: 'schedule' },
  { to: '/booking-sites', icon: Globe,            label: 'Booking Site',     section: null,          category: 'booking_sites' },
  { to: '/tenants',       icon: Users,            label: 'Tenants',          section: null,          category: 'tenants' },
  { to: '/tenant-onboarding', icon: UserPlus,    label: 'Tenant Onboarding',section: null,          category: 'tenant_onboarding' },
  // S639 (Nic): "I need my front desk person to go to one page, see all the
  // people that need to be contacted, and what phase they're in." Sits with
  // onboarding because that is the process it reports on, and under the same
  // permission — it shows the same people, without the destructive buttons.
  // S640 (Nic): its own category, so a front-desk person can be given the call
  // list without the import flows, the pending pool and the Tenants tab that
  // came with it. Anyone who already holds tenant_onboarding.view keeps seeing
  // it — the filter below accepts either category for this one item.
  { to: '/front-desk',    icon: Headphones,       label: 'Front Desk',       section: null,          category: 'front_desk' },
  { to: '/leases',        icon: ScrollText,       label: 'Leases',           section: null,          category: 'leases' },
  { to: '/subleases',     icon: ScrollText,       label: 'Subleases',        section: null,          category: 'subleases' },
  { to: '/esign',         icon: PenTool,          label: 'GoldSign',           section: null,          category: 'esign' },
  // Financials — S575: one "Financials" sidebar item, these render as sub-tabs.
  // Items without a `category` stay owner-only (staff can't see them). Tab order
  // is display order; the first the user can access is the landing tab.
  // 10/13 (Nic): "payments first. with a way to log the payments" — Payments
  // (the rent roll for the open month) leads the Financials hub, and the Rent
  // Roll (the history) follows it.
  // 10/12 (Nic): kept — "we still need the place to see payments mid month."
  // 10/13 (Nic): "Bookkeepers SEE the Payments and Rent Roll pages,
  // read-only" — both are in a bookkeeper's menu (for their properties; the
  // pages leave every action out for them).
  { to: '/payments',      icon: CreditCard,       label: 'Payments',         section: null, hub: 'financials', category: 'payments', bookkeeper: true },
  // 10/12 (Nic): staff with "View all payments" reach the Rent Roll — the page
  // reads what that key opens (GET /balances/rent-roll/*, payments.view_all),
  // so that key, not any key in the Payments category, shows it (see
  // visibleNavItemsFor).
  { to: '/rent-roll',     icon: ScrollText,       label: 'Rent Roll',        section: null, hub: 'financials', category: 'payments', bookkeeper: true },
  // 10/13 (Nic): "REMOVE the Outstanding Balances tab." Its address opens
  // Payments (main.tsx); front-desk staff who see who owes find that list and
  // Record payment under Payments (PaymentsPage), so "View who owes" alone
  // shows the Payments tab (visibleNavItemsFor).
  { to: '/disbursements', icon: ArrowDownToLine,  label: 'Disbursements',    section: null, hub: 'financials', category: 'disbursements' },
  // 10/11 (Nic): money in by type — by month and by day, no names.
  { to: '/income',        icon: BarChart2,        label: 'Money In',         section: null, hub: 'financials', bookkeeper: true },
  { to: '/reports',       icon: BarChart2,        label: 'Reports',          section: null, hub: 'financials', category: 'reports', bookkeeper: true },
  // S568: landlord expense entry (feeds the P&L). Owner-level.
  { to: '/expenses',      icon: ArrowDownToLine,  label: 'Expenses',         section: null, hub: 'financials', bookkeeper: true },
  // 10/11 (Nic): "maintenance... the maintenance costs." Cost lines only.
  { to: '/maintenance-costs', icon: Wrench,       label: 'Maintenance Costs', section: null, hub: 'financials', bookkeeper: true },
  { to: '/bank-activity', icon: Landmark,         label: 'Bank Activity',    section: null, hub: 'financials', bookkeeper: 'only', companyWide: true },
  { to: '/payouts',       icon: ArrowDownToLine,  label: 'Payouts',          section: null, hub: 'financials', bookkeeper: 'only', companyWide: true },
  // S645 (Nic): an owner whose book is split between managers reads it here,
  // in one place, with the managers side by side. Owner-level like the rest of
  // the financials hub — it is a judgment about the people they hired.
  { to: '/my-managers',   icon: BarChart2,        label: 'My Managers',      section: null, hub: 'financials' },
  // S605 (Nic): ONE Bank tab. Feed (S570) + reconciliation (S568) were two nav
  // items answering one question — "is my bank money right?" — because
  // reconciliation was built as the manual stand-in before the feed existed and
  // nobody merged them afterwards. Both routes still resolve, via redirects.
  { to: '/bank',          icon: Landmark,         label: 'Bank',             section: null, hub: 'financials' },
  // S168: managers see /banking only when their landlord has flipped their
  // per-scope direct_deposit_enabled toggle on — special-cased in the filter.
  // S605 (Nic): was "Banking", which sat confusingly beside the new "Bank" tab.
  // He asked for "Disbursements" to match the dashboard's wording — but that
  // name is already the payout LIST two tabs over, so this is the ACCOUNT those
  // disbursements are sent to. Same vocabulary, no duplicate tab. (Merging it
  // into /disbursements outright would leak payout setup to property managers,
  // who only see this tab when direct deposit is switched on — see the filter
  // special-case below.)
  { to: '/banking',       icon: Landmark,         label: 'Disbursement Account', section: null, hub: 'financials', category: 'banking' },
  // S568/S575: investor-operator net + lot rent (homes-only parks). Owner-level;
  // the sub-tab is further gated on the landlord actually having a mobile-home unit.
  { to: '/lot-rent',      icon: Landmark,         label: 'Lot Rent & Net',   section: null, hub: 'financials' },
  // 10/12 (Nic): "Bookkeeping" is the GAM Books pages INSIDE the portal, not a
  // link out — the same files as GAM Books (src/bookkeeping,
  // bookkeeping-parity.test.ts), as sub-tabs like Financials, in Books' own
  // order. The company's own books: the owner, and a bookkeeper with the
  // company-wide box (the server's rule — routes/books.ts). Never staff.
  { to: BOOKS_PATHS.dashboard,       icon: BookOpen, label: 'Dashboard',           section: null, hub: 'bookkeeping', bookkeeper: true, ledger: true },
  { to: BOOKS_PATHS.employees,       icon: BookOpen, label: 'Employees (W-2)',     section: null, hub: 'bookkeeping', bookkeeper: true, ledger: true },
  // 10/12 (Nic): one list of everyone the company pays — contractors are
  // vendors (the old Contractors address opens Vendors on its Contractors tab).
  { to: BOOKS_PATHS.vendors,         icon: BookOpen, label: 'Vendors & Contractors', section: null, hub: 'bookkeeping', bookkeeper: true, ledger: true },
  { to: BOOKS_PATHS.runPayroll,      icon: BookOpen, label: 'Run Payroll',         section: null, hub: 'bookkeeping', bookkeeper: true, ledger: true },
  { to: BOOKS_PATHS.payHistory,      icon: BookOpen, label: 'Pay History',         section: null, hub: 'bookkeeping', bookkeeper: true, ledger: true },
  { to: BOOKS_PATHS.taxForms,        icon: BookOpen, label: 'Tax Forms',           section: null, hub: 'bookkeeping', bookkeeper: true, ledger: true },
  { to: BOOKS_PATHS.accounts,        icon: BookOpen, label: 'Chart of Accounts',   section: null, hub: 'bookkeeping', bookkeeper: true, ledger: true },
  { to: BOOKS_PATHS.journal,         icon: BookOpen, label: 'Journal Entries',     section: null, hub: 'bookkeeping', bookkeeper: true, ledger: true },
  // 10/12 (Nic, L5): Transactions and Bills & AP retired for a landlord
  // company — money out is one record (Expenses) and bank lines are filed on
  // the Bank page; their routes stay (each page points to Expenses).
  { to: BOOKS_PATHS.reconcile,       icon: BookOpen, label: 'Bank Reconciliation', section: null, hub: 'bookkeeping', bookkeeper: true, ledger: true },
  // 10/12 (Nic, L3, ledger P9): close a month — the company-wide box's; who may
  // close and reopen is the owner's Books Settings choice (the server decides).
  { to: BOOKS_PATHS.closeMonth,      icon: BookOpen, label: 'Close Month',         section: null, hub: 'bookkeeping', bookkeeper: true, companyWide: true },
  // 10/12 (Nic): loans (principal / interest / escrow) and fixed assets.
  { to: BOOKS_PATHS.loans,           icon: BookOpen, label: 'Loans',               section: null, hub: 'bookkeeping', bookkeeper: true, ledger: true },
  { to: BOOKS_PATHS.fixedAssets,     icon: BookOpen, label: 'Fixed Assets',        section: null, hub: 'bookkeeping', bookkeeper: true, ledger: true },
  { to: BOOKS_PATHS.profitLoss,      icon: BookOpen, label: 'P&L',                 section: null, hub: 'bookkeeping', bookkeeper: true, ledger: true },
  { to: BOOKS_PATHS.balanceSheet,    icon: BookOpen, label: 'Balance Sheet',       section: null, hub: 'bookkeeping', bookkeeper: true, ledger: true },
  // 10/12 (Nic, ledger P8): the trial balance and the general ledger — the whole-company ledger's.
  { to: BOOKS_PATHS.trialBalance,    icon: BookOpen, label: 'Trial Balance',       section: null, hub: 'bookkeeping', bookkeeper: true, ledger: true },
  { to: BOOKS_PATHS.generalLedger,   icon: BookOpen, label: 'General Ledger',      section: null, hub: 'bookkeeping', bookkeeper: true, ledger: true },
  { to: BOOKS_PATHS.cashFlow,        icon: BookOpen, label: 'Cash Flow',           section: null, hub: 'bookkeeping', bookkeeper: true, companyWide: true },
  { to: BOOKS_PATHS.ownerStatements, icon: BookOpen, label: 'Owner Statements',    section: null, hub: 'bookkeeping', bookkeeper: true, companyWide: true },
  { to: BOOKS_PATHS.taxCenter,       icon: BookOpen, label: 'Tax Center',          section: null, hub: 'bookkeeping', bookkeeper: true, ledger: true },
  // 10/12 (Nic): the company's own choices for how its books count money, and
  // what its books start with — GAM Books' pages, shown in the Bookkeeping
  // menu (BooksSettingsPage.tsx / OpeningBalancesPage.tsx). The owner changes
  // them; a bookkeeper with the ledger box (or company-wide) reads them; the
  // server decides what each may do (routes/booksSettings.ts).
  { to: BOOKS_PATHS.booksSettings,   icon: BookOpen, label: 'Books Settings',      section: null, hub: 'bookkeeping', bookkeeper: true, ledger: true },
  { to: BOOKS_PATHS.openingBalances, icon: BookOpen, label: 'Opening Balances',    section: null, hub: 'bookkeeping', bookkeeper: true, ledger: true },
  // 10/12 (Nic, L5): the company's own categories (a bookkeeper adds them too).
  // 10/12 (Nic): shown to EVERY bookkeeper, not only one with the ledger — the
  // server lets each keep the categories (routes/expenses); pointing one at an
  // account is what needs the ledger, and the page says so.
  { to: BOOKS_PATHS.categories,      icon: BookOpen, label: 'Categories',          section: null, hub: 'bookkeeping', bookkeeper: true, everyBookkeeper: true },
  // Operations
  { to: '/maintenance',   icon: Wrench,           label: 'Maintenance',      section: 'Operations',  category: 'maintenance' },
  { to: '/inspections',   icon: ClipboardCheck,   label: 'Inspections',      section: null,          category: 'inspections' },
  { to: '/documents',     icon: FileText,         label: 'Documents',        section: null,          category: 'documents' },
  // S652 (Nic): a maintenance worker's way to put a posted notice or a record
  // photo onto a resident's file, from the phone. Same category as Documents:
  // holding "Add photos & posted notices" is enough to see it.
  { to: '/tenant-photos', icon: Camera,           label: 'Photos & Notices', section: null,          category: 'documents' },
  { to: '/inventory',     icon: Package,          label: 'Inventory',        section: null,          category: 'inventory' },
  // W-36 (S531): sub-meter management — meters CRUD is gated on
  // properties.edit / units.* server-side; 'units' is the closest catalog
  // category for staff visibility.
  { to: '/work-trade',    icon: HeartHandshake,   label: 'Work Trade',       section: null },
  { to: '/surveys',       icon: MessageSquare,    label: 'Surveys',          section: null },
  // Screening — S575: one "Screening" sidebar item, these render as sub-tabs.
  // S576 (Nic, B-9b): Background Checks leads — it's the day-to-day screening
  // action, so clicking the Screening nav icon lands there. Applicant Pool
  // (vacancy-fill backup) and Rental History follow.
  { to: '/background',    icon: ClipboardList,    label: 'Background Checks',section: null, hub: 'screening', category: 'background_checks' },
  { to: '/pool',          icon: UserSearch,       label: 'Applicant Pool',   section: null, hub: 'screening', category: 'applicant_pool' },
  { to: '/screening',     icon: ScrollText,       label: 'Rental History',   section: null, hub: 'screening', category: 'screening' },
  // Admin
  { to: '/team',          icon: Shield,           label: 'Team',             section: 'Admin' },
  { to: '/pm-invitations', icon: HeartHandshake,  label: 'PM Invitations',   section: null,          category: 'pm_invitations' },
  { to: '/settings',      icon: Settings,         label: 'Settings',         section: null,          category: 'settings' },
]

// S575: hub display metadata + the set of child paths (for sidebar active-state).
const HUB_META: Record<Hub, { label: string; icon: any }> = {
  financials:  { label: 'Financials',  icon: Landmark },
  screening:   { label: 'Screening',   icon: UserSearch },
  bookkeeping: { label: 'Bookkeeping', icon: BookOpen },
}
const HUB_CHILD_PATHS: Record<Hub, Set<string>> = {
  financials:  new Set(NAV_ITEMS.filter(i => i.hub === 'financials').map(i => i.to)),
  screening:   new Set(NAV_ITEMS.filter(i => i.hub === 'screening').map(i => i.to)),
  bookkeeping: new Set(NAV_ITEMS.filter(i => i.hub === 'bookkeeping').map(i => i.to)),
}

// category → its catalog permission keys (built once from the shared catalog).
const CATALOG_KEYS_BY_CATEGORY: Record<string, string[]> = Object.fromEntries(
  PERMISSION_CATALOG.map(g => [g.category, g.sections.flatMap(s => s.items.map(i => i.key))])
)

const OWNER_ROLES = new Set(['admin','super_admin','landlord'])

// The single nav-visibility rule, shared by the sidebar and RoleRedirect
// (main.tsx) so staff always LAND on a page they can actually see. Owners see
// everything; staff see an item iff they hold ANY catalog key in its category
// (plus the S168 banking special case). Items with no category are owner-only.
export type NavUser = {
  role?: string; permissions?: Record<string, any> | null; directDepositEnabled?: boolean; hasMobileHomeUnits?: boolean
  /** 10/12: a bookkeeper's company-wide box (GET /financials/scope); unknown = not shown. */
  companyWide?: boolean
  /** 10/12 (Nic, BK1): the whole-company Books ledger (company-wide or the ledger box); unknown = not shown. */
  ledger?: boolean
  /** 10/12: false when a bookkeeper keeps no property's money (no property ticked); unknown = shown. */
  propertyMoney?: boolean
} | null | undefined

export function visibleNavItemsFor(user: NavUser) {
  const role = user?.role || 'landlord'
  const perms = (user?.permissions || {}) as Record<string, boolean | string>
  const isOwner = OWNER_ROLES.has(role)
  const directDepositEnabled = (user as any)?.directDepositEnabled === true
  const hasMobileHomeUnits = (user as any)?.hasMobileHomeUnits === true
  return NAV_ITEMS.filter(item => {
    if (LAUNCH_HIDDEN.has(item.to)) return false  // S512 launch hide
    // 10/11 (Nic): a bookkeeper sees the shared financial pages and nothing
    // else — "money coming in, money going out... the maintenance costs".
    // The API refuses them everything else too (lib/bookkeeperAccess).
    // 10/12 (Nic): the bank account, payouts and (Bookkeeping) the company's
    // own books follow the company-wide box alone — the server's rule
    // (lib/financialsScope refuseWithoutCompanyWide, routes/books.ts), never
    // the property boxes; it used to read "every property ticked" here, so a
    // bookkeeper with the box but some properties lost Bank Activity and one
    // with every property but no box was offered pages that refused them. A
    // bookkeeper with no property ticked keeps no property's money, so those
    // pages go, as in GAM Books.
    if (role === 'bookkeeper') {
      if (!item.bookkeeper) return false
      // 10/12 (Nic): Categories, for every bookkeeper.
      if (item.everyBookkeeper) return true
      if (item.companyWide) return user?.companyWide === true
      // 10/12 (Nic, BK1): the ledger pages, with either box.
      if (item.ledger) return user?.companyWide === true || user?.ledger === true
      return user?.propertyMoney !== false
    }
    if (item.bookkeeper === 'only') return false
    // 10/12 (Nic): the company's own books are the owner's (and a company-wide
    // bookkeeper's, above) — never staff's. Not an admin's either: GAM Books
    // keeps admins out (S568), and its API would hand an admin every
    // company's books at once.
    if (item.hub === 'bookkeeping') return role === 'landlord'
    // S575: Lot Rent & Net is a mobile-home concept (lot rent + investor-operator
    // net for homes-only parks). Landlords see it only once they have a
    // mobile-home unit; admin/super_admin (platform oversight) always see it;
    // staff never (owner-only item, no category).
    // S605 (Nic): Lot Rent & Net is folded into the shelved sublease workflow —
    // same business case (own homes in someone else's park, pay ground rent,
    // rent to tenants), and unusable while that park isn't on GAM because every
    // figure would be hand-entered. Hidden for everyone, including admins.
    if (item.to === '/lot-rent') {
      if (SUBLEASING_SHELVED) return false
      if (role === 'landlord') return hasMobileHomeUnits
      return isOwner
    }
    if (isOwner) return true                       // owners see everything
    // --- staff: driven purely by catalog permissions ---
    // S168: /banking for property_manager — only when direct-deposit is on.
    if (item.to === '/banking' && role === 'property_manager') return directDepositEnabled
    // 10/12 (Nic): the Rent Roll is for staff with "View all payments" — the
    // key its pages read (GET /balances/rent-roll/*); "View payments" alone shows
    // only unpaid bills, and the rent roll would refuse it.
    if (item.to === '/rent-roll') return perms['payments.view_all'] === true
    // 10/13 (Nic): the Outstanding Balances tab is gone; who owes and Record
    // payment are under Payments, so the balances switches show Payments too.
    if (item.to === '/payments' && ['payments', 'balances'].some(c => (CATALOG_KEYS_BY_CATEGORY[c] || []).some(k => perms[k] === true))) return true
    if (!item.category) return false               // owner-only items (Team, Work Trade)
    // S640: Front Desk moved to its own category; onboarding staff who already
    // had it keep it rather than silently losing a page they use daily.
    const cats = item.to === '/front-desk' ? ['front_desk', 'tenant_onboarding'] : [item.category]
    // decisions.md #48.2: whoever takes payments makes the bank deposit for the
    // cash they took, on the Front Desk page — so take_payment alone shows it.
    // The API camelizes the dotless key to takePayment (see lib/permissions.ts);
    // both spellings count.
    if (item.to === '/front-desk' && (perms['take_payment'] === true || perms.takePayment === true)) return true
    return cats.some(c => (CATALOG_KEYS_BY_CATEGORY[c] || []).some(k => perms[k] === true))
  })
}

// S575: the sidebar list — same visibility as visibleNavItemsFor, but each hub's
// members collapse into ONE entry (icon/label from HUB_META, landing = the first
// accessible member). RoleRedirect keeps using the flat visibleNavItemsFor so
// staff still land on a concrete page.
export function sidebarNavItemsFor(user: NavUser) {
  const out: Array<{ to: string; icon: any; label: string; section: string | null; hub?: Hub }> = []
  const seen = new Set<string>()
  const items = visibleNavItemsFor(user)
  const bookkeeperFinancials = bookkeeperLanding(user, items)
  for (const item of items) {
    const hub = item.hub
    if (hub) {
      if (seen.has(hub)) continue
      seen.add(hub)
      const to = hub === 'financials' && bookkeeperFinancials ? bookkeeperFinancials : item.to
      out.push({ to, icon: HUB_META[hub].icon, label: HUB_META[hub].label, section: item.section, hub })
    } else {
      out.push(item)
    }
  }
  return out
}

/**
 * 10/11: a bookkeeper lands on the financial pages, Money in first — where
 * they land after signing in and where Financials opens for them. 10/13 (Nic):
 * Payments and the Rent Roll (read-only) joined their menu above Money in;
 * where they land did not change (10/13 review: it moved as a side effect of
 * the menu order). null: not a bookkeeper, or Money in is not theirs.
 */
function bookkeeperLanding(user: NavUser, items: ReturnType<typeof visibleNavItemsFor>): string | null {
  if (user?.role !== 'bookkeeper') return null
  return items.some(i => i.to === '/income') ? '/income' : null
}

/**
 * Where staff and a bookkeeper land after signing in (RoleRedirect, main.tsx):
 * the first page their permission set grants — the sidebar's own rule — and a
 * bookkeeper Money in (bookkeeperLanding). Nothing granted: /welcome says why.
 */
export function staffLandingPath(user: NavUser): string {
  const items = visibleNavItemsFor(user)
  return bookkeeperLanding(user, items) ?? items[0]?.to ?? '/welcome'
}

/**
 * Where Layout sends a bookkeeper who is on a page that is not theirs (null:
 * stay). 10/11: one who follows an old link or types a path lands back on their
 * pages rather than on a screen the API will refuse piece by piece. 10/12:
 * until their scope has answered, the company-wide pages (Bank Activity,
 * Payouts, Bookkeeping) are let through — a link to one is not bounced before
 * it is known whether it is theirs; the server still refuses it if not, and
 * this runs again once the scope is in.
 *
 * 10/13: the portal's own address ('/', where every sign-in arrives) is not one
 * of their pages either, so this — not RoleRedirect — decided where a
 * bookkeeper landed, and it picked the first page of the menu: Payments since
 * 10/13 put it first. The decided landing is Money in (staffLandingPath; "where
 * they land did not change"). It goes there now, and so does any other page
 * that is not theirs.
 */
export function bookkeeperRedirect(pathname: string, navUser: NavUser, scopeLoading: boolean): string | null {
  const effective = scopeLoading ? { ...navUser, companyWide: true } : navUser
  const theirs = visibleNavItemsFor(effective).map(i => i.to)
  // 10/12 review: the bare /bookkeeping address opens the Books dashboard
  // (main.tsx's own redirect), never their first page, when it is theirs.
  if (pathname === '/bookkeeping' && theirs.includes(BOOKS_PATHS.dashboard)) return BOOKS_PATHS.dashboard
  if (theirs.includes(pathname)) return null
  return staffLandingPath(effective)
}

/**
 * 10/12 (Nic): the signed-in user as the menu reads them. A bookkeeper's
 * company-wide box and whether they keep any property's money are not on the
 * sign-in; they are on GET /financials/scope (the shared financial pages read
 * the same query). `scopeLoading` is true until it answers.
 */
export function useNavUser(): { navUser: NavUser; scopeLoading: boolean } {
  const { user } = useAuth()
  const isBookkeeper = user?.role === 'bookkeeper'
  const { data: scope, isLoading } = useQuery<{ companyWide?: boolean; ledger?: boolean; properties?: unknown[] }>(
    'financials-scope', () => apiGet('/financials/scope'), { enabled: isBookkeeper, staleTime: 60_000 })
  if (!isBookkeeper || !user) return { navUser: user, scopeLoading: false }
  return {
    navUser: {
      ...user,
      companyWide: scope?.companyWide === true,
      ledger: scope?.ledger === true,
      propertyMoney: scope ? (scope.properties?.length ?? 0) > 0 : undefined,
    },
    scopeLoading: isLoading,
  }
}

// S575: the page rendered for a hub route (/payments, /pool, …). Renders the
// cluster's accessible members as a sub-tab bar over the active child page.
export function HubTabLayout({ hub }: { hub: Hub }) {
  const { navUser } = useNavUser()
  const tabs = visibleNavItemsFor(navUser).filter(i => i.hub === hub)
  return (
    <div>
      {tabs.length > 1 && (
        // 10/12 review: on a phone the bar is one row that scrolls sideways
        // (globals.css .hub-tabs) — Bookkeeping's 17 tabs wrapped into about
        // five rows and pushed the page below the fold.
        <div className="hub-tabs">
          {tabs.map(t => (
            <NavLink key={t.to} to={t.to} end
              style={({ isActive }) => ({
                padding: '8px 16px', fontSize: '.82rem', fontWeight: 600, textDecoration: 'none',
                color: isActive ? 'var(--gold)' : 'var(--text-3)',
                borderBottom: isActive ? '2px solid var(--gold)' : '2px solid transparent', marginBottom: -1,
              })}>
              {t.label}
            </NavLink>
          ))}
        </div>
      )}
      <Outlet />
    </div>
  )
}

// S512 LAUNCH: features hidden from the UI for the initial launch. Nav
// entries are filtered out and their routes redirect (see main.tsx). The
// pages + backend stay intact — unhide post-launch by emptying this set.
//   /flex-charge    — Flex Suite hidden at launch (LAUNCH_DECISIONS #7)
//   /subleases      — unfinished (#16), no seed data
//   /pm-invitations — PM-company portal not launching with the trio
// /work-trade PROMOTED for launch (W-54, Nic S531) — its auto-billing was
// completed in the S517 rebuild; gets its own walkthrough pass (W-56).
// Fitness (external SSO link, no route) is hidden via LAUNCH_HIDE_FITNESS.
export const LAUNCH_HIDDEN = new Set<string>([
  '/flex-charge',
  '/subleases',
  '/pm-invitations',
])
export const LAUNCH_HIDE_FITNESS = true
// S605 (Nic): subleasing is SHELVED — the workflow requires the sublessee to
// already be a GAM tenant, so it can't work until both sides are on the
// platform. "I know people that sublease in a variety of parks, they will never
// be able to use this until all the landlords are on the same software."
// Server-side the `subleasing_enabled` feature flag refuses creation; this hides
// the data-capture UI so nobody sets a policy for a feature that won't run.
export const SUBLEASING_SHELVED = true

const LL_FONTS: Record<string, { imp: string; family: string; display: string }> = {
  default:     { imp: '', family: "'Inter',sans-serif", display: "'Space Grotesk',sans-serif" },
  terminator:  { imp: "@font-face{font-family:'Terminator';src:url('/fonts/terminator.ttf') format('truetype');}", family: "'Terminator',sans-serif", display: "'Terminator',sans-serif" },
  matrix:      { imp: "@font-face{font-family:'Matrix';src:url('/fonts/matrix.ttf') format('truetype');}", family: "'Matrix',monospace", display: "'Matrix',monospace" },
  bladerunner: { imp: "@font-face{font-family:'BladeRunner';src:url('/fonts/bladerunner.ttf') format('truetype');}", family: "'BladeRunner',sans-serif", display: "'BladeRunner',sans-serif" },
  teamfury:    { imp: "@font-face{font-family:'TeamFury';src:url('/fonts/teamfury.ttf') format('truetype');}", family: "'TeamFury',sans-serif", display: "'TeamFury',sans-serif" },
}

const ROLE_BADGE: Record<string, string> = {
  landlord:         '',
  bookkeeper:       'Bookkeeper',
  property_manager: 'PM',
  onsite_manager:   'On-Site',
  maintenance:      'Maintenance',
}

function PendingSignBanner() {
  const navigate = useNavigate()
  const { data: pending = [] } = useQuery('landlord-pending', () =>
    fetch((import.meta as any).env?.VITE_API_URL + '/api/esign/landlord-pending', {
      headers: { Authorization: 'Bearer ' + localStorage.getItem('gam_token') }
    }).then(r => r.json()).then(r => r.data || []),
    // S636: also on return-to-tab and on navigation, not only every 30s — the
    // banner is a work queue and a stale one sends you to a lease you just signed.
    { refetchInterval: 30000, staleTime: 0, refetchOnMount: 'always', refetchOnWindowFocus: true }
  )
  if (!(pending as any[]).length) return null
  // S535 (Nic): landlord signs FIRST — the old copy hardcoded "Tenant has
  // signed", which is backwards for every landlord-first document, and the
  // click navigated to pending[0].token (a field the endpoint never
  // returned → /sign/undefined). Copy now reflects the actual signer
  // state; renewals get their own phrasing.
  // S535 (Nic): a tenant NEVER signs first — enforced server-side at the
  // send route AND the sign route, so there is no "tenant already signed"
  // state to phrase. The landlord's pending signature is always the
  // document's first.
  const doc = (pending as any[])[0]
  // S655: a new lease for a household already living here is told apart by its
  // link to the lease it follows, never by the title's wording.
  const isRenewal = !!doc.renewsLeaseId
  const others = (pending as any[]).length - 1
  const subtitle = (isRenewal
    ? `${doc.title} · New lease for a household already living here — sign it and it goes to them`
    : `${doc.title} · You sign first — then it goes to the tenant`)
    + (others > 0 ? ` · ${others} more waiting on you` : '')
  return (
    <div onClick={() => navigate('/sign/' + doc.documentId)}
      style={{ background:'rgba(201,162,39,.1)', border:'1px solid rgba(201,162,39,.3)', borderRadius:10, padding:'12px 16px', marginBottom:16, cursor:'pointer', display:'flex', alignItems:'center', justifyContent:'space-between' }}>
      <div>
        <div style={{ fontWeight:700, color:'var(--gold)', fontSize:'.88rem' }}>📋 Document Awaiting Your Signature</div>
        <div style={{ fontSize:'.75rem', color:'var(--text-2)', marginTop:2 }}>{subtitle}</div>
      </div>
      <div style={{ fontSize:'.78rem', fontWeight:700, color:'var(--gold)', flexShrink:0 }}>Sign Now →</div>
    </div>
  )
}


function AnnouncementBar() {
  const { data: items = [] } = useQuery<any[]>(
    'platform-announcements',
    () => apiGet('/announcements'),
    { staleTime: 300000, refetchOnWindowFocus: false }
  )
  const [idx, setIdx] = useState(0)
  const ann = (items as any[])[idx]
  if (!(items as any[]).length) return (
    <div style={{ display:'flex', flexDirection:'column', justifyContent:'center' }}>
      <span style={{ fontWeight:600, fontSize:'.95rem', color:'var(--text-0)', lineHeight:1.2 }}>Gold Asset Management</span>
      <span style={{ fontSize:'.75rem', color:'var(--text-3)', lineHeight:1.2 }}>Property Management Platform</span>
    </div>
  )
  const color = ann.priority === 'critical' ? 'var(--red)' : ann.priority === 'warning' ? 'var(--amber)' : 'var(--gold)'
  return (
    <div style={{ display:'flex', alignItems:'center', gap:10, maxWidth:500 }}>
      <div style={{ width:6, height:6, borderRadius:'50%', background:color, flexShrink:0 }} />
      <div style={{ overflow:'hidden' }}>
        <span style={{ fontWeight:600, fontSize:'.82rem', color, marginRight:6 }}>{ann.title}</span>
        {ann.body && <span style={{ fontSize:'.78rem', color:'var(--text-2)', whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }}>{ann.body}</span>}
      </div>
      {(items as any[]).length > 1 && (
        <button onClick={() => setIdx((idx+1) % (items as any[]).length)}
          style={{ background:'none', border:'none', color:'var(--text-3)', cursor:'pointer', fontSize:'.72rem', flexShrink:0 }}>
          {idx+1}/{(items as any[]).length} →
        </button>
      )}
    </div>
  )
}

export function Layout() {
  const { user, logout } = useAuth()
  const navigate = useNavigate()
  const layoutLocation = useLocation()
  const role = user?.role || 'landlord'
  // The Master Schedule timeline wants the full monitor width; other pages keep
  // the readable 1400px cap.
  const fullBleed = layoutLocation.pathname === '/schedule'

  const cachedTheme = (() => { try { return JSON.parse(localStorage.getItem('gam_landlord_theme') || '{}') } catch { return {} } })()
  const { data: themeData } = useQuery(
    'landlord-theme',
    () => apiGet('/landlords/theme').then((d: any) => {
      try { localStorage.setItem('gam_landlord_theme', JSON.stringify({ accent: d?.themeAccent, fontKey: d?.fontStyle })) } catch {}
      return d
    }),
    { staleTime: 60000 }
  )
  const accent  = (themeData as any)?.themeAccent || cachedTheme.accent || '#c9a227'
  const fontKey = (themeData as any)?.fontStyle   || cachedTheme.fontKey || 'default'
  const font    = LL_FONTS[fontKey] || LL_FONTS.default
  const themeCss = `${font.imp}
:root{--gold:${accent};--gold-dim:${accent}99;--gold-glow:${accent}26;--gold-bg:${accent}14;--font-display:${font.display};--font-body:${font.family};}
.nav-item.active{background:${accent}14;color:${accent};border:1px solid ${accent}33;}
.btn-primary{background:${accent};}.btn-primary:hover{background:${accent}cc;box-shadow:0 0 24px ${accent}33;}
.tab-btn.active{color:${accent};border-bottom-color:${accent};}
.form-input:focus,.form-select:focus,.form-textarea:focus{border-color:${accent};box-shadow:0 0 0 2px ${accent}26;}
.sidebar-logo-mark{color:${accent};}a{color:${accent};}.kpi-card::before{background:${accent};}
`

  // S595: light/dark toggle in the topbar (next to notifications/settings).
  // Per-device — the initial value is applied before paint by the inline script
  // in index.html; this state just reflects it and re-renders the sun/moon icon.
  const [theme, setTheme] = useState<'dark' | 'light'>(
    () => (document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark')
  )
  const toggleTheme = () => {
    const next = theme === 'dark' ? 'light' : 'dark'
    document.documentElement.setAttribute('data-theme', next)
    try { localStorage.setItem('gam_theme', next) } catch {}
    setTheme(next)
  }

  const handleLogout = () => { logout(); navigate('/login') }
  // 10/11: a bookkeeper's portal is the financial pages alone — no signing
  // queue, notifications, assistant or settings (each would only be refused).
  const isBookkeeper = role === 'bookkeeper'

  // Visibility rule lives in visibleNavItemsFor (shared with RoleRedirect); the
  // sidebar collapses the Financials/Screening/Bookkeeping clusters into one
  // item each (S575).
  const { navUser, scopeLoading } = useNavUser()
  const visibleItems = sidebarNavItemsFor(navUser)

  // A bookkeeper on a page that is not theirs — including the portal's own
  // address after signing in — goes to their landing (bookkeeperRedirect).
  if (isBookkeeper) {
    const to = bookkeeperRedirect(layoutLocation.pathname, navUser, scopeLoading)
    if (to) return <Navigate to={to} replace />
  }

  // Track section headers without side effects
  const renderedSections = new Set<string>()

  return (
    <div className="app-shell">
      <style dangerouslySetInnerHTML={{__html: themeCss}} />
      <aside className="sidebar">
        <div className="sidebar-logo">
          <div className="sidebar-logo-mark">⚡ GAM</div>
          <div className="sidebar-logo-sub">Gold Asset Management</div>
        </div>

        <nav className="sidebar-nav">
          {visibleItems.map(item => {
            const Icon = item.icon
            const showSection = !!item.section && !renderedSections.has(item.section)
            if (showSection) renderedSections.add(item.section!)
            // Hub items (Financials/Screening/Bookkeeping) are active for any of
            // their child routes, not just the landing path a plain NavLink would match.
            const hubActive = !!item.hub && HUB_CHILD_PATHS[item.hub].has(layoutLocation.pathname)
            return (
              <div key={item.to}>
                {showSection && (
                  <div className="nav-section-label" style={{ marginTop: item.section === 'Overview' ? 0 : 8 }}>
                    {item.section}
                  </div>
                )}
                <NavLink to={item.to}
                  className={({ isActive }) => `nav-item ${(item.hub ? hubActive : isActive) ? 'active' : ''}`}>
                  <Icon size={16} /> {item.label}
                </NavLink>
              </div>
            )
          })}
          {!LAUNCH_HIDDEN.has('/flex-charge') && (
            <NavLink to="/flex-charge" className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
              💳 FlexCharge
            </NavLink>
          )}
          {/* GAM Fitness — standalone app (:3013). Hand off the portal's JWT
              via ?sso= so the landlord lands signed-in without re-auth. */}
          {!LAUNCH_HIDE_FITNESS && (
            <a
              className="nav-item"
              href="#"
              onClick={e => {
                e.preventDefault()
                const t = localStorage.getItem('gam_token') || ''
                const base = (import.meta as any).env?.VITE_FITNESS_URL || 'http://localhost:3013'
                window.open(`${base}/?sso=${encodeURIComponent(t)}`, '_blank')
              }}
            >
              🏋️ Fitness
            </a>
          )}
        </nav>

        <div className="sidebar-footer">
          <div className="nav-item" style={{ marginBottom:4, fontSize:'.8rem', flexDirection:'column', alignItems:'flex-start', cursor:'default', gap:0 }}>
            <div style={{ display:'flex', alignItems:'center', gap:6, width:'100%' }}>
              <span style={{ color:'var(--text-0)', fontWeight:600 }}>{user?.firstName} {user?.lastName}</span>
              {ROLE_BADGE[role] && (
                <span style={{ fontSize:'.6rem', padding:'1px 6px', borderRadius:10, background:'rgba(201,162,39,.1)', border:'1px solid rgba(201,162,39,.25)', color:'var(--gold)', fontWeight:700 }}>
                  {ROLE_BADGE[role]}
                </span>
              )}
            </div>
            <span style={{ color:'var(--text-3)', fontSize:'.7rem' }}>{user?.email}</span>
          </div>
          <button className="nav-item" onClick={handleLogout} style={{ color:'var(--red)' }}>
            <LogOut size={16} /> Sign Out
          </button>
        </div>
      </aside>

      <div className="main-content">
        {!isBookkeeper && <PendingSignBanner />}
        <header className="topbar" style={{ position:'sticky', top:0, zIndex:100 }}>
          <AnnouncementBar />
          <div style={{ flex:1 }} />
          {!isBookkeeper && <NotificationBell />}
          <button
            className="btn btn-ghost btn-sm"
            style={{ padding:'6px' }}
            onClick={toggleTheme}
            title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
            aria-label="Toggle light/dark theme"
          >
            {theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
          </button>
          {!isBookkeeper && (
            <button className="btn btn-ghost btn-sm" style={{ padding:'6px' }}>
              <Settings size={16} style={{ cursor:'pointer' }} onClick={() => window.location.href='/settings'} />
            </button>
          )}
        </header>
        <div className={"page-content" + (fullBleed ? " page-content-wide" : "")}>
          <Outlet />
          <DialogHost />
        </div>
      </div>
      {!isBookkeeper && <ChatWidget />}
    </div>
  )
}
