import { Outlet, NavLink, useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { TotpNudge } from './TotpNudge'
import {
  LayoutDashboard, Building2, Users, Banknote,
  HeartHandshake, Receipt, LogOut, Settings,
} from 'lucide-react'

const NAV: Array<{ to: string; icon: any; label: string; section: string | null }> = [
  { to: '/dashboard',      icon: LayoutDashboard, label: 'Dashboard',         section: 'Overview' },
  { to: '/properties',     icon: Building2,        label: 'Properties',         section: 'Portfolio' },
  { to: '/invitations',    icon: HeartHandshake,   label: 'Property Invites',   section: null },
  { to: '/fee-plans',      icon: Receipt,          label: 'Fee Plans',          section: 'Company' },
  { to: '/staff',          icon: Users,            label: 'Staff',              section: null },
  { to: '/banking',        icon: Banknote,         label: 'Banking & Payouts',  section: null },
  { to: '/settings',       icon: Settings,         label: 'Settings',           section: 'Admin' },
]

export function Layout() {
  const { user, activePmCompany, pmCompanies, setActivePmCompany, logout } = useAuth()
  const navigate = useNavigate()

  const handleLogout = () => { logout(); navigate('/login') }

  const renderedSections = new Set<string>()

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="sidebar-logo">
          <div className="sidebar-logo-mark">⚡ GAM PM</div>
          <div className="sidebar-logo-sub">{activePmCompany?.name ?? 'Property Management'}</div>
        </div>

        {pmCompanies.length > 1 && (
          <div style={{ padding: '8px 16px', borderBottom: '1px solid var(--border-0)' }}>
            <label style={{ fontSize: '.66rem', color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.08em' }}>
              Active Company
            </label>
            <select
              className="input"
              value={activePmCompany?.id ?? ''}
              onChange={e => {
                const next = pmCompanies.find(c => c.id === e.target.value)
                if (next) setActivePmCompany(next)
              }}
              style={{ width: '100%', marginTop: 4, fontSize: '.82rem' }}
            >
              {pmCompanies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
        )}

        <nav className="sidebar-nav">
          {NAV.map(item => {
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

        <div style={{ marginTop: 'auto', padding: 16, borderTop: '1px solid var(--border-0)' }}>
          <div style={{ fontSize: '.78rem', color: 'var(--text-2)' }}>{user?.firstName} {user?.lastName}</div>
          <div style={{ fontSize: '.68rem', color: 'var(--text-3)', marginBottom: 8 }}>
            {activePmCompany?.myRole ?? '—'} · {user?.email}
          </div>
          <button className="btn btn-ghost btn-sm" onClick={handleLogout} style={{ width: '100%' }}>
            <LogOut size={12} style={{ marginRight: 6 }} /> Sign out
          </button>
        </div>
      </aside>

      <main className="app-main">
        <TotpNudge />
        <Outlet />
      </main>
    </div>
  )
}
