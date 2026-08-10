import { useState } from 'react'
import { NotificationBell } from '../NotificationBell'
import { ChatWidget } from '../ChatWidget'
import { apiGet } from '../../lib/api'
import { Outlet, NavLink, useNavigate, useLocation } from 'react-router-dom'
import { DialogHost } from '../dialogs'
import { useQuery } from 'react-query'
import { useAuth } from '../../context/AuthContext'
import { PERMISSION_CATALOG } from '@gam/shared'
import {
  LayoutDashboard, Building2, DoorOpen, Users, CreditCard,
  ArrowDownToLine, Wrench, FileText, LogOut, Settings,
  ShoppingCart, Shield, Package, BarChart2, ScrollText,
  UserSearch, ClipboardList, HeartHandshake, PenTool, UserPlus,
  Landmark, ClipboardCheck, CalendarClock, RefreshCw, MessageSquare,
  Sun, Moon, Globe
} from 'lucide-react'

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
const NAV_ITEMS: Array<{
  to: string
  icon: any
  label: string
  section: string | null
  category?: string
  hub?: 'financials' | 'screening'
}> = [
  // Overview
  { to: '/dashboard',     icon: LayoutDashboard, label: 'Dashboard',        section: 'Overview',    category: 'dashboard' },
  { to: '/refer',         icon: HeartHandshake,   label: 'Refer & Earn',     section: null },
  { to: '/pos',           icon: ShoppingCart,     label: 'Point of Sale',    section: null,          category: 'pos' },
  // Portfolio
  { to: '/properties',    icon: Building2,        label: 'Properties',       section: 'Portfolio',   category: 'properties' },
  { to: '/units',         icon: DoorOpen,         label: 'Unit Overview',    section: null,          category: 'units' },
  { to: '/schedule',      icon: DoorOpen,         label: 'Master Schedule',  section: null,          category: 'schedule' },
  { to: '/booking-sites', icon: Globe,            label: 'Booking Site',     section: null,          category: 'booking_sites' },
  { to: '/tenants',       icon: Users,            label: 'Tenants',          section: null,          category: 'tenants' },
  { to: '/tenant-onboarding', icon: UserPlus,    label: 'Tenant Onboarding',section: null,          category: 'tenant_onboarding' },
  { to: '/leases',        icon: ScrollText,       label: 'Leases',           section: null,          category: 'leases' },
  { to: '/subleases',     icon: ScrollText,       label: 'Subleases',        section: null,          category: 'subleases' },
  { to: '/esign',         icon: PenTool,          label: 'E-Sign',           section: null,          category: 'esign' },
  // Financials — S575: one "Financials" sidebar item, these render as sub-tabs.
  // Items without a `category` stay owner-only (staff can't see them). Tab order
  // is display order; the first the user can access is the landing tab.
  { to: '/payments',      icon: CreditCard,       label: 'Payments',         section: null, hub: 'financials', category: 'payments' },
  { to: '/balances',      icon: CreditCard,       label: 'Outstanding Balances', section: null, hub: 'financials', category: 'balances' },
  // W-2 (S531): owner-only — matches the API canViewLandlordFinances gate.
  { to: '/rent-roll',     icon: ScrollText,       label: 'Rent Roll',        section: null, hub: 'financials' },
  { to: '/disbursements', icon: ArrowDownToLine,  label: 'Disbursements',    section: null, hub: 'financials', category: 'disbursements' },
  { to: '/reports',       icon: BarChart2,        label: 'Reports',          section: null, hub: 'financials', category: 'reports' },
  // S568: landlord expense entry (feeds the P&L). Owner-level.
  { to: '/expenses',      icon: ArrowDownToLine,  label: 'Expenses',         section: null, hub: 'financials' },
  // S570: bank feed — link operating bank, categorize spending into the P&L. Owner-level.
  { to: '/bank-feed',     icon: RefreshCw,        label: 'Bank Feed',        section: null, hub: 'financials' },
  // S568: bank reconciliation (categorize bank charges). Owner-level.
  { to: '/bank-reconciliation', icon: Landmark,   label: 'Bank Reconciliation', section: null, hub: 'financials' },
  // S168: managers see /banking only when their landlord has flipped their
  // per-scope direct_deposit_enabled toggle on — special-cased in the filter.
  { to: '/banking',       icon: Landmark,         label: 'Banking',          section: null, hub: 'financials', category: 'banking' },
  // S568/S575: investor-operator net + lot rent (homes-only parks). Owner-level;
  // the sub-tab is further gated on the landlord actually having a mobile-home unit.
  { to: '/lot-rent',      icon: Landmark,         label: 'Lot Rent & Net',   section: null, hub: 'financials' },
  // Operations
  { to: '/maintenance',   icon: Wrench,           label: 'Maintenance',      section: 'Operations',  category: 'maintenance' },
  { to: '/inspections',   icon: ClipboardCheck,   label: 'Inspections',      section: null,          category: 'inspections' },
  { to: '/amenities',     icon: CalendarClock,    label: 'Amenities',        section: null,          category: 'amenities' },
  { to: '/documents',     icon: FileText,         label: 'Documents',        section: null,          category: 'documents' },
  { to: '/inventory',     icon: Package,          label: 'Inventory',        section: null,          category: 'inventory' },
  // W-36 (S531): sub-meter management — meters CRUD is gated on
  // properties.edit / units.* server-side; 'units' is the closest catalog
  // category for staff visibility.
  { to: '/utilities',     icon: Package,          label: 'Utilities',        section: null,          category: 'units' },
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
const HUB_META: Record<'financials' | 'screening', { label: string; icon: any }> = {
  financials: { label: 'Financials', icon: Landmark },
  screening:  { label: 'Screening',  icon: UserSearch },
}
const HUB_CHILD_PATHS: Record<string, Set<string>> = {
  financials: new Set(NAV_ITEMS.filter(i => i.hub === 'financials').map(i => i.to)),
  screening:  new Set(NAV_ITEMS.filter(i => i.hub === 'screening').map(i => i.to)),
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
export function visibleNavItemsFor(user: { role?: string; permissions?: Record<string, any> | null; directDepositEnabled?: boolean; hasMobileHomeUnits?: boolean } | null | undefined) {
  const role = user?.role || 'landlord'
  const perms = (user?.permissions || {}) as Record<string, boolean | string>
  const isOwner = OWNER_ROLES.has(role)
  const directDepositEnabled = (user as any)?.directDepositEnabled === true
  const hasMobileHomeUnits = (user as any)?.hasMobileHomeUnits === true
  return NAV_ITEMS.filter(item => {
    if (LAUNCH_HIDDEN.has(item.to)) return false  // S512 launch hide
    // S575: Lot Rent & Net is a mobile-home concept (lot rent + investor-operator
    // net for homes-only parks). Landlords see it only once they have a
    // mobile-home unit; admin/super_admin (platform oversight) always see it;
    // staff never (owner-only item, no category).
    if (item.to === '/lot-rent') {
      if (role === 'landlord') return hasMobileHomeUnits
      return isOwner
    }
    if (isOwner) return true                       // owners see everything
    // --- staff: driven purely by catalog permissions ---
    // S168: /banking for property_manager — only when direct-deposit is on.
    if (item.to === '/banking' && role === 'property_manager') return directDepositEnabled
    if (!item.category) return false               // owner-only items (Team, Work Trade)
    const keys = CATALOG_KEYS_BY_CATEGORY[item.category]
    return !!keys && keys.some(k => perms[k] === true)
  })
}

// S575: the sidebar list — same visibility as visibleNavItemsFor, but each hub's
// members collapse into ONE entry (icon/label from HUB_META, landing = the first
// accessible member). RoleRedirect keeps using the flat visibleNavItemsFor so
// staff still land on a concrete page.
export function sidebarNavItemsFor(user: Parameters<typeof visibleNavItemsFor>[0]) {
  const out: Array<{ to: string; icon: any; label: string; section: string | null; hub?: 'financials' | 'screening' }> = []
  const seen = new Set<string>()
  for (const item of visibleNavItemsFor(user)) {
    const hub = item.hub
    if (hub) {
      if (seen.has(hub)) continue
      seen.add(hub)
      out.push({ to: item.to, icon: HUB_META[hub].icon, label: HUB_META[hub].label, section: item.section, hub })
    } else {
      out.push(item)
    }
  }
  return out
}

// S575: the page rendered for a hub route (/payments, /pool, …). Renders the
// cluster's accessible members as a sub-tab bar over the active child page.
export function HubTabLayout({ hub }: { hub: 'financials' | 'screening' }) {
  const { user } = useAuth()
  const tabs = visibleNavItemsFor(user).filter(i => i.hub === hub)
  return (
    <div>
      {tabs.length > 1 && (
        <div style={{ display: 'flex', gap: 4, borderBottom: '1px solid var(--border-0)', marginBottom: 20, flexWrap: 'wrap' }}>
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

const LL_FONTS: Record<string, { imp: string; family: string; display: string }> = {
  default:     { imp: '', family: "'Inter',sans-serif", display: "'Space Grotesk',sans-serif" },
  terminator:  { imp: "@font-face{font-family:'Terminator';src:url('/fonts/terminator.ttf') format('truetype');}", family: "'Terminator',sans-serif", display: "'Terminator',sans-serif" },
  matrix:      { imp: "@font-face{font-family:'Matrix';src:url('/fonts/matrix.ttf') format('truetype');}", family: "'Matrix',monospace", display: "'Matrix',monospace" },
  bladerunner: { imp: "@font-face{font-family:'BladeRunner';src:url('/fonts/bladerunner.ttf') format('truetype');}", family: "'BladeRunner',sans-serif", display: "'BladeRunner',sans-serif" },
  teamfury:    { imp: "@font-face{font-family:'TeamFury';src:url('/fonts/teamfury.ttf') format('truetype');}", family: "'TeamFury',sans-serif", display: "'TeamFury',sans-serif" },
}

const ROLE_BADGE: Record<string, string> = {
  landlord:         '',
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
    { refetchInterval: 30000 }
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
  const isRenewal = (doc.title || '').startsWith('Lease Renewal')
  const subtitle = isRenewal
    ? `${doc.title} · Upcoming lease for your renewal — sign now and send to the tenant`
    : `${doc.title} · You sign first — then it goes to the tenant`
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

  // Visibility rule lives in visibleNavItemsFor (shared with RoleRedirect); the
  // sidebar collapses the Financials/Screening clusters into one item each (S575).
  const visibleItems = sidebarNavItemsFor(user)

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
            // Hub items (Financials/Screening) are active for any of their child
            // routes, not just the landing path a plain NavLink would match.
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
        <PendingSignBanner />
        <header className="topbar" style={{ position:'sticky', top:0, zIndex:100 }}>
          <AnnouncementBar />
          <div style={{ flex:1 }} />
          <NotificationBell />
          <button
            className="btn btn-ghost btn-sm"
            style={{ padding:'6px' }}
            onClick={toggleTheme}
            title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
            aria-label="Toggle light/dark theme"
          >
            {theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
          </button>
          <button className="btn btn-ghost btn-sm" style={{ padding:'6px' }}>
            <Settings size={16} style={{ cursor:'pointer' }} onClick={() => window.location.href='/settings'} />
          </button>
        </header>
        <div className={"page-content" + (fullBleed ? " page-content-wide" : "")}>
          <Outlet />
          <DialogHost />
        </div>
      </div>
      <ChatWidget />
    </div>
  )
}
