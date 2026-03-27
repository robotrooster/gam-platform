import { NotificationBell } from '../NotificationBell'
import { Outlet, NavLink, useNavigate } from 'react-router-dom'
import { useQuery } from 'react-query'
import { useAuth } from '../../context/AuthContext'
import {
  LayoutDashboard, Building2, DoorOpen, Users, CreditCard,
  ArrowDownToLine, Wrench, FileText, LogOut, Settings, Bell,
  ShoppingCart, Shield, UserCog, Package
} from 'lucide-react'

// Role-based nav config
const NAV_ITEMS = [
  // Overview
  { to: '/dashboard',     icon: LayoutDashboard, label: 'Dashboard',     section: 'Overview',    roles: ['landlord','property_manager'] },
  // Portfolio
  { to: '/properties',   icon: Building2,        label: 'Properties',    section: 'Portfolio',   roles: ['landlord','property_manager'] },
  { to: '/units',        icon: DoorOpen,          label: 'Unit Overview',         section: null,          roles: ['landlord','property_manager','onsite_manager'] },
  { to: '/tenants',      icon: Users,             label: 'Tenants',       section: null,          roles: ['landlord','property_manager'] },
  // Financials
  { to: '/disbursements',icon: ArrowDownToLine,   label: 'Disbursements', section: 'Financials',  roles: ['landlord'] },
  { to: '/payments',     icon: CreditCard,        label: 'Payments',      section: null,          roles: ['landlord','property_manager'] },
  // Operations
  { to: '/maint-portal', icon: Wrench, label: 'Maint. Portal', section: null, roles: ['landlord','maintenance','onsite_manager'] },
  { to: '/maintenance',  icon: Wrench,            label: 'Maintenance',   section: 'Operations',  roles: ['landlord','property_manager','onsite_manager','maintenance'] },
  { to: '/documents',    icon: FileText,          label: 'Documents',     section: null,          roles: ['landlord','property_manager'] },
  { to: '/reports', icon: FileText, label: 'Reports', section: 'Financial', roles: ['landlord','property_manager'] },
  { to: '/pool', icon: Users, label: 'Applicant Pool', section: null, roles: ['landlord'] },
  { to: '/background', icon: Shield, label: 'Background Checks', section: null, roles: ['landlord'] },
  { to: '/esign', icon: FileText, label: 'E-Signatures', section: null, roles: ['landlord'] },
  { to: '/leases',       icon: FileText,          label: 'Leases',        section: null,          roles: ['landlord','property_manager'] },
  { to: '/inventory', icon: Package, label: 'Inventory', section: null, roles: ['landlord','property_manager'] },
  { to: '/pos',          icon: ShoppingCart,      label: 'Point of Sale', section: null,          roles: ['landlord','property_manager','onsite_manager'] },
  // Team
  { to: '/settings', icon: Settings, label: 'Settings', section: null, roles: ['landlord'] },
  { to: '/team',         icon: Shield,            label: 'Team',          section: 'Team',        roles: ['landlord'] },
  { to: '/pm', icon: Building2, label: 'PM Portal', section: null, roles: ['landlord'] },
  { to: '/work-trade',   icon: Wrench,         label: 'Work Trade',    section: null,          roles: ['landlord','property_manager'] },
]

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
    }).then(r=>r.json()).then(r=>r.data||[]),
    { refetchInterval: 30000 }
  )
  if (!(pending as any[]).length) return null
  return (
    <div onClick={()=>navigate('/sign/'+(pending as any[])[0].token)}
      style={{ background:'rgba(201,162,39,.1)', border:'1px solid rgba(201,162,39,.3)', borderRadius:10, padding:'12px 16px', marginBottom:16, cursor:'pointer', display:'flex', alignItems:'center', justifyContent:'space-between' }}>
      <div>
        <div style={{ fontWeight:700, color:'var(--gold)', fontSize:'.88rem' }}>📋 Document Awaiting Your Signature</div>
        <div style={{ fontSize:'.75rem', color:'var(--text-2)', marginTop:2 }}>{(pending as any[])[0].title} · Tenant has signed</div>
      </div>
      <div style={{ fontSize:'.78rem', fontWeight:700, color:'var(--gold)', flexShrink:0 }}>Sign Now →</div>
    </div>
  )
}

export function Layout() {
  const { user, logout } = useAuth()
  const navigate = useNavigate()
  const role = user?.role || 'landlord'

  const handleLogout = () => { logout(); navigate('/login') }

  // Filter nav items by role
  const visibleItems = NAV_ITEMS.filter(item => item.roles.includes(role))

  // Group by section
  let lastSection = ''

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="sidebar-logo">
          <div className="sidebar-logo-mark">⚡ GAM</div>
          <div className="sidebar-logo-sub">Gold Asset Management</div>
        </div>

        <nav className="sidebar-nav">
          {visibleItems.map(item => {
            const Icon = item.icon
            const showSection = item.section && item.section !== lastSection
            if (showSection) lastSection = item.section!
            return (
              <div key={item.to}>
                {showSection && (
                  <div className="nav-section-label" style={{ marginTop: lastSection !== 'Overview' ? 8 : 0 }}>
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
          <div className="nav-item" style={{ marginBottom: 4, fontSize: '.8rem', flexDirection: 'column', alignItems: 'flex-start', cursor: 'default', gap: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, width: '100%' }}>
              <span style={{ color: 'var(--text-0)', fontWeight: 600 }}>{user?.firstName} {user?.lastName}</span>
              {ROLE_BADGE[role] && (
                <span style={{ fontSize: '.6rem', padding: '1px 6px', borderRadius: 10, background: 'rgba(201,162,39,.1)', border: '1px solid rgba(201,162,39,.25)', color: 'var(--gold)', fontWeight: 700 }}>
                  {ROLE_BADGE[role]}
                </span>
              )}
            </div>
            <span style={{ color: 'var(--text-3)', fontSize: '.7rem' }}>{user?.email}</span>
          </div>
          <button className="nav-item" onClick={handleLogout} style={{ color: 'var(--red)' }}>
            <LogOut size={16} /> Sign out
          </button>
        </div>
      </aside>

      <div className="main-content"><PendingSignBanner/>
        <header className="topbar">
          <div style={{ flex: 1 }} />
          <NotificationBell />
          <button className="btn btn-ghost btn-sm" style={{ padding: '6px' }}>
            <Settings size={16} style={{ cursor:'pointer' }} onClick={()=>window.location.href='/settings'}/>
          </button>
        </header>
        <div className="page-content">
          <Outlet />
        </div>
      </div>
    </div>
  )
}
