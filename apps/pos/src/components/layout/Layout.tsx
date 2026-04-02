import React, { useState } from 'react'
import { NotificationBell } from '../NotificationBell'
import { apiGet } from '../../lib/api'
import { Outlet, NavLink, useNavigate } from 'react-router-dom'
import { useQuery } from 'react-query'
import { useAuth } from '../../context/AuthContext'
import {
  LayoutDashboard, Building2, DoorOpen, Users, CreditCard,
  ArrowDownToLine, Wrench, FileText, LogOut, Settings,
  ShoppingCart, Shield, Package, BarChart2, ScrollText,
  UserSearch, ClipboardList, HeartHandshake
} from 'lucide-react'

const NAV_ITEMS = [
  // Overview
  { to: '/dashboard',     icon: LayoutDashboard, label: 'Dashboard',        section: 'Overview',    roles: ['landlord','property_manager'] },
  // Portfolio
  { to: '/properties',    icon: Building2,        label: 'Properties',       section: 'Portfolio',   roles: ['landlord','property_manager'] },
  { to: '/units',         icon: DoorOpen,         label: 'Unit Overview',    section: null,          roles: ['landlord','property_manager','onsite_manager'] },
  { to: '/tenants',       icon: Users,            label: 'Tenants',          section: null,          roles: ['landlord','property_manager'] },
  { to: '/leases',        icon: ScrollText,       label: 'Leases',           section: null,          roles: ['landlord','property_manager'] },
  // Financials
  { to: '/disbursements', icon: ArrowDownToLine,  label: 'Disbursements',    section: 'Financials',  roles: ['landlord'] },
  { to: '/payments',      icon: CreditCard,       label: 'Payments',         section: null,          roles: ['landlord','property_manager'] },
  { to: '/reports',       icon: BarChart2,        label: 'Reports',          section: null,          roles: ['landlord','property_manager'] },
  // Operations
  { to: '/maintenance',   icon: Wrench,           label: 'Maintenance',      section: 'Operations',  roles: ['landlord','property_manager','onsite_manager','maintenance'] },
  { to: '/documents',     icon: FileText,         label: 'Documents',        section: null,          roles: ['landlord','property_manager'] },
  { to: '/pos',           icon: ShoppingCart,     label: 'Point of Sale',    section: null,          roles: ['landlord','property_manager','onsite_manager'] },
  { to: '/inventory',     icon: Package,          label: 'Inventory',        section: null,          roles: ['landlord','property_manager'] },
  { to: '/work-trade',    icon: HeartHandshake,        label: 'Work Trade',       section: null,          roles: ['landlord','property_manager'] },
  // Screening
  { to: '/pool',          icon: UserSearch,       label: 'Applicant Pool',   section: 'Screening',   roles: ['landlord'] },
  { to: '/background',    icon: ClipboardList,    label: 'Background Checks',section: null,          roles: ['landlord'] },
  // Admin
  { to: '/team',          icon: Shield,           label: 'Team',             section: 'Admin',       roles: ['landlord'] },
  { to: '/settings',      icon: Settings,         label: 'Settings',         section: null,          roles: ['landlord'] },
]

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

export function Layout() {
  const { user, logout } = useAuth()
  const navigate = useNavigate()
  const role = user?.role || 'landlord'

  const cachedTheme = (() => { try { return JSON.parse(localStorage.getItem('gam_landlord_theme') || '{}') } catch { return {} } })()
  const { data: themeData } = useQuery(
    'landlord-theme',
    () => apiGet('/landlords/theme').then((d: any) => {
      try { localStorage.setItem('gam_landlord_theme', JSON.stringify({ accent: d?.theme_accent, fontKey: d?.font_style })) } catch {}
      return d
    }),
    { staleTime: 60000 }
  )
  const accent  = (themeData as any)?.theme_accent || cachedTheme.accent || '#c9a227'
  const fontKey = (themeData as any)?.font_style   || cachedTheme.fontKey || 'default'
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
  const visibleItems = NAV_ITEMS.filter(item => item.roles.includes(role))

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
        <div className="page-content">
          <Outlet />
        </div>
      </div>
    </div>
  )
}
