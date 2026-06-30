import { useState } from 'react'
import { NotificationBell } from '../NotificationBell'
import { ChatWidget } from '../ChatWidget'
import { apiGet } from '../../lib/api'
import { Outlet, NavLink, useNavigate, useLocation } from 'react-router-dom'
import { useQuery } from 'react-query'
import { useAuth } from '../../context/AuthContext'
import {
  LayoutDashboard, Building2, DoorOpen, Users, CreditCard,
  ArrowDownToLine, Wrench, FileText, LogOut, Settings,
  ShoppingCart, Shield, Package, BarChart2, ScrollText,
  UserSearch, ClipboardList, HeartHandshake, PenTool, UserPlus,
  Landmark, ClipboardCheck, CalendarClock
} from 'lucide-react'

// S82: each nav item has a `roles` admission list (which roles MAY see
// it) and an optional `perm` list (sub-permission keys; worker roles
// only see the item if they hold ANY of these). Owner roles
// (admin/super_admin/landlord) bypass `perm` entirely. Items with no
// `perm` are role-only — used for landlord-self pages where no perm
// in the catalog applies. Reports + Work Trade are landlord-only at
// the backend (S81); PMs can't reach those endpoints, so they're
// dropped from `roles` here to match.
const NAV_ITEMS: Array<{
  to: string
  icon: any
  label: string
  section: string | null
  roles: string[]
  perm?: string[]
}> = [
  // Overview
  { to: '/dashboard',     icon: LayoutDashboard, label: 'Dashboard',        section: 'Overview',    roles: ['landlord','property_manager'] },
  { to: '/pos',           icon: ShoppingCart,     label: 'Point of Sale',    section: null,          roles: ['landlord','property_manager','onsite_manager'], perm: ['pos.ring_sale','pos.refund','pos.void','pos.discount','pos.end_of_day','pos.manage_inventory'] },
  // Portfolio
  { to: '/properties',    icon: Building2,        label: 'Properties',       section: 'Portfolio',   roles: ['landlord','property_manager'], perm: ['properties.create','properties.edit'] },
  { to: '/units',         icon: DoorOpen,         label: 'Unit Overview',    section: null,          roles: ['landlord','property_manager','onsite_manager'], perm: ['units.create','units.edit','units.view_status'] },
  { to: '/schedule',      icon: DoorOpen,         label: 'Master Schedule',  section: null,          roles: ['landlord','property_manager','onsite_manager'], perm: ['units.view_status','units.edit','guests.check_in','guests.check_out'] },
  { to: '/bookings',      icon: DoorOpen,         label: 'Bookings',         section: null,          roles: ['landlord','property_manager','onsite_manager'], perm: ['units.view_status','units.edit','guests.check_in','guests.check_out'] },
  { to: '/booking-sites', icon: Building2,        label: 'Booking Sites',    section: null,          roles: ['landlord','property_manager'], perm: ['properties.edit'] },
  { to: '/tenants',       icon: Users,            label: 'Tenants',          section: null,          roles: ['landlord','property_manager'], perm: ['tenants.create','tenants.archive','tenants.run_background_check'] },
  { to: '/tenant-onboarding', icon: UserPlus,    label: 'Tenant Onboarding',section: null,          roles: ['landlord','property_manager'], perm: ['tenants.create'] },
  { to: '/leases',        icon: ScrollText,       label: 'Leases',           section: null,          roles: ['landlord','property_manager'], perm: ['leases.create','leases.sign','leases.terminate'] },
  { to: '/subleases',     icon: ScrollText,       label: 'Subleases',        section: null,          roles: ['landlord','property_manager'], perm: ['leases.create','leases.terminate'] },
  { to: '/esign',         icon: PenTool,          label: 'E-Sign',           section: null,          roles: ['landlord','property_manager'], perm: ['leases.create','leases.sign','leases.terminate'] },
  // Financials
  { to: '/disbursements', icon: ArrowDownToLine,  label: 'Disbursements',    section: 'Financials',  roles: ['landlord'] },
  // S168: managers see /banking only when their landlord has flipped
  // their per-scope direct_deposit_enabled toggle on. The visibility
  // filter below special-cases this item; the role list intentionally
  // includes property_manager so the visibility check has a chance to run.
  { to: '/banking',       icon: Landmark,         label: 'Banking',          section: null,          roles: ['landlord','property_manager'] },
  { to: '/payments',      icon: CreditCard,       label: 'Payments',         section: null,          roles: ['landlord','property_manager'], perm: ['payments.view_all'] },
  { to: '/reports',       icon: BarChart2,        label: 'Reports',          section: null,          roles: ['landlord'] },
  // Operations
  { to: '/maintenance',   icon: Wrench,           label: 'Maintenance',      section: 'Operations',  roles: ['landlord','property_manager','onsite_manager','maintenance'], perm: ['work_orders.create','work_orders.complete','work_orders.reassign','maintenance.approve_above_threshold'] },
  { to: '/inspections',   icon: ClipboardCheck,   label: 'Inspections',      section: null,          roles: ['landlord','property_manager','onsite_manager'] },
  { to: '/amenities',     icon: CalendarClock,    label: 'Amenities',        section: null,          roles: ['landlord','property_manager','onsite_manager'] },
  { to: '/documents',     icon: FileText,         label: 'Documents',        section: null,          roles: ['landlord','property_manager'], perm: ['leases.create','leases.sign','leases.terminate'] },
  { to: '/inventory',     icon: Package,          label: 'Inventory',        section: null,          roles: ['landlord','property_manager','onsite_manager'], perm: ['pos.manage_inventory'] },
  { to: '/work-trade',    icon: HeartHandshake,   label: 'Work Trade',       section: null,          roles: ['landlord'] },
  // Screening
  { to: '/pool',          icon: UserSearch,       label: 'Applicant Pool',   section: 'Screening',   roles: ['landlord','property_manager'], perm: ['tenants.run_background_check'] },
  { to: '/background',    icon: ClipboardList,    label: 'Background Checks',section: null,          roles: ['landlord','property_manager'], perm: ['tenants.run_background_check'] },
  { to: '/screening',     icon: ScrollText,       label: 'Rental History',   section: null,          roles: ['landlord','property_manager'], perm: ['tenants.run_background_check'] },
  // Admin
  { to: '/team',          icon: Shield,           label: 'Team',             section: 'Admin',       roles: ['landlord','property_manager'], perm: ['team.invite','team.manage_permissions'] },
  { to: '/pm-invitations', icon: HeartHandshake,  label: 'PM Invitations',   section: null,          roles: ['landlord'] },
  { to: '/settings',      icon: Settings,         label: 'Settings',         section: null,          roles: ['landlord'] },
  { to: '/notification-prefs', icon: Settings,    label: 'Notification Prefs', section: null,        roles: ['landlord','property_manager','onsite_manager','maintenance'] },
]

const OWNER_ROLES = new Set(['admin','super_admin','landlord'])

// S512 LAUNCH: features hidden from the UI for the initial launch. Nav
// entries are filtered out and their routes redirect (see main.tsx). The
// pages + backend stay intact — unhide post-launch by emptying this set.
//   /flex-charge    — Flex Suite hidden at launch (LAUNCH_DECISIONS #7)
//   /subleases      — unfinished (#16), no seed data
//   /work-trade     — auto-billing unbuilt (#29)
//   /pm-invitations — PM-company portal not launching with the trio
// Fitness (external SSO link, no route) is hidden via LAUNCH_HIDE_FITNESS.
export const LAUNCH_HIDDEN = new Set<string>([
  '/flex-charge',
  '/subleases',
  '/work-trade',
  '/pm-invitations',
])
export const LAUNCH_HIDE_FITNESS = true

const LL_FONTS: Record<string, { imp: string; family: string; display: string }> = {
  default:     { imp: '', family: "'DM Sans',sans-serif", display: "'Syne',sans-serif" },
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
  return (
    <div onClick={() => navigate('/sign/' + (pending as any[])[0].token)}
      style={{ background:'rgba(201,162,39,.1)', border:'1px solid rgba(201,162,39,.3)', borderRadius:10, padding:'12px 16px', marginBottom:16, cursor:'pointer', display:'flex', alignItems:'center', justifyContent:'space-between' }}>
      <div>
        <div style={{ fontWeight:700, color:'var(--gold)', fontSize:'.88rem' }}>📋 Document Awaiting Your Signature</div>
        <div style={{ fontSize:'.75rem', color:'var(--text-2)', marginTop:2 }}>{(pending as any[])[0].title} · Tenant has signed</div>
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

// Soft, dismissible nudge to enable 2FA. The landlord role is not in
// MANDATORY_TOTP_ROLES, so this never blocks — it just reminds. Dismissal
// persists per-account in localStorage; enabling 2FA clears it implicitly
// (the banner stops rendering once totpEnabled is true).
function TotpNudge() {
  const { user } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const dismissKey = user ? `gam_ll_totp_nudge_dismissed_${user.id}` : ''
  const [dismissed, setDismissed] = useState(() => {
    try { return !!dismissKey && localStorage.getItem(dismissKey) === '1' } catch { return false }
  })

  if (!user) return null
  if ((user as any).totpEnabled) return null
  if (dismissed) return null
  // Don't nag while they're already on the enroll/settings flow.
  if (location.pathname === '/totp/enroll' || location.pathname === '/settings') return null

  const dismiss = () => {
    try { localStorage.setItem(dismissKey, '1') } catch {}
    setDismissed(true)
  }

  return (
    <div style={{ background:'var(--gold-bg)', border:'1px solid rgba(201,162,39,.3)', borderRadius:10, padding:'12px 16px', marginBottom:16, display:'flex', alignItems:'center', justifyContent:'space-between', gap:12 }}>
      <div>
        <div style={{ fontWeight:700, color:'var(--gold)', fontSize:'.88rem' }}>🔐 Secure your account with two-factor authentication</div>
        <div style={{ fontSize:'.75rem', color:'var(--text-2)', marginTop:2 }}>Add an authenticator-app code at sign-in so a stolen password isn't enough.</div>
      </div>
      <div style={{ display:'flex', alignItems:'center', gap:8, flexShrink:0 }}>
        <button className="btn btn-primary btn-sm" onClick={() => navigate('/totp/enroll')}>Enable</button>
        <button className="btn btn-ghost btn-sm" onClick={dismiss}>Dismiss</button>
      </div>
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

  const handleLogout = () => { logout(); navigate('/login') }

  // Visibility: role admission first; then for worker roles, gate by perm.
  // Owner roles bypass perm. Item with no perm = role-only (used for
  // landlord-self pages like /reports, /banking, /settings).
  const perms = (user?.permissions || {}) as Record<string, boolean | string>
  const isOwner = OWNER_ROLES.has(role)
  const directDepositEnabled = (user as any)?.directDepositEnabled === true
  const visibleItems = NAV_ITEMS.filter(item => {
    if (LAUNCH_HIDDEN.has(item.to)) return false  // S512 launch hide
    if (!item.roles.includes(role)) return false
    // S168: /banking for property_manager — only visible when their
    // landlord has flipped the direct-deposit toggle on. Without this
    // gate, the link would render for every PM regardless of opt-in.
    if (item.to === '/banking' && role === 'property_manager') {
      return directDepositEnabled
    }
    if (isOwner) return true
    if (!item.perm) return false  // worker hitting a no-perm item — not visible
    return item.perm.some(k => perms[k] === true)
  })

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
            return (
              <div key={item.to}>
                {showSection && (
                  <div className="nav-section-label" style={{ marginTop: item.section === 'Overview' ? 0 : 8 }}>
                    {item.section}
                  </div>
                )}
                <NavLink to={item.to} className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
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
            <LogOut size={16} /> Sign out
          </button>
        </div>
      </aside>

      <div className="main-content">
        <PendingSignBanner />
        <header className="topbar" style={{ position:'sticky', top:0, zIndex:100 }}>
          <AnnouncementBar />
          <div style={{ flex:1 }} />
          <NotificationBell />
          <button className="btn btn-ghost btn-sm" style={{ padding:'6px' }}>
            <Settings size={16} style={{ cursor:'pointer' }} onClick={() => window.location.href='/settings'} />
          </button>
        </header>
        <div className={"page-content" + (fullBleed ? " page-content-wide" : "")}>
          <TotpNudge />
          <Outlet />
        </div>
      </div>
      <ChatWidget />
    </div>
  )
}
