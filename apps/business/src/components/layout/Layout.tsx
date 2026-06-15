import { Outlet, NavLink, useNavigate } from 'react-router-dom'
import { useAuth } from '../../context/AuthContext'
import { GlobalSearch } from '../GlobalSearch'
import {
  LayoutDashboard, Users, UserCog, Settings, LogOut,
  Building2, Truck, Trash2, CalendarClock, Route as RouteIcon,
  Receipt, CalendarDays, Package, ShoppingCart, Wrench, Car, FileText,
  BarChart3, Repeat,
} from 'lucide-react'

// S466 + S492: section-grouped nav with feature-gating.
//   - `roles` admits which user roles see the item
//   - `feature` (optional) gates by business enabled_features — when
//     present, the item only renders if the active business has the
//     feature toggled on. Items without a `feature` are universal
//     (Dashboard, Customers, Staff, Settings).
const NAV_ITEMS: Array<{
  to: string; icon: any; label: string;
  section?: string; roles: string[];
  feature?: string;
}> = [
  // Overview
  { to: '/dashboard',     icon: LayoutDashboard, label: 'Dashboard',
    section: 'Overview',
    roles: ['business_owner', 'business_staff'] },
  // Operations
  { to: '/customers',     icon: Users,           label: 'Customers',
    section: 'Operations',
    roles: ['business_owner', 'business_staff'] },
  { to: '/quotes',        icon: FileText,        label: 'Quotes',
    roles: ['business_owner'],
    feature: 'quotes' },
  { to: '/invoices',      icon: Receipt,         label: 'Invoices',
    roles: ['business_owner'],
    feature: 'invoicing' },
  { to: '/recurring-invoices', icon: Repeat,    label: 'Recurring',
    roles: ['business_owner'],
    feature: 'invoicing' },
  { to: '/appointments',  icon: CalendarDays,    label: 'Appointments',
    roles: ['business_owner', 'business_staff'],
    feature: 'appointments' },
  { to: '/bookable-services', icon: CalendarDays, label: 'Bookable services',
    roles: ['business_owner'],
    feature: 'appointments' },
  { to: '/inventory',     icon: Package,         label: 'Inventory',
    roles: ['business_owner'],
    feature: 'inventory' },
  { to: '/pos',           icon: ShoppingCart,    label: 'POS',
    roles: ['business_owner', 'business_staff'],
    feature: 'pos' },
  { to: '/work-orders',   icon: Wrench,          label: 'Work orders',
    roles: ['business_owner', 'business_staff'],
    feature: 'work_orders' },
  { to: '/customer-vehicles', icon: Car,         label: 'Customer vehicles',
    roles: ['business_owner', 'business_staff'],
    feature: 'customer_vehicles' },
  { to: '/schedules',     icon: CalendarClock,   label: 'Schedules',
    roles: ['business_owner', 'business_staff'],
    feature: 'recurring_schedules' },
  { to: '/routes',        icon: RouteIcon,       label: 'Routes',
    roles: ['business_owner', 'business_staff'],
    feature: 'routing' },
  // Fleet — owner-only operator config; gated by 'routing'
  { to: '/depots',        icon: Building2,       label: 'Depots',
    section: 'Fleet',
    roles: ['business_owner'],
    feature: 'routing' },
  { to: '/vehicles',      icon: Truck,           label: 'Vehicles',
    roles: ['business_owner'],
    feature: 'routing' },
  { to: '/dump-locations',icon: Trash2,          label: 'Dump Locations',
    roles: ['business_owner'],
    feature: 'routing' },
  // Team
  { to: '/staff',         icon: UserCog,         label: 'Staff',
    section: 'Team',
    roles: ['business_owner'] },
  // Insights
  // S502: nav-level role admit covers owner + staff. The per-staff
  // 'reports.view' permission is enforced at the API; UI link still
  // renders for staff and the page itself surfaces the 403 if a staff
  // member without the grant hits it directly. No 'feature' gate —
  // reports works whatever features are enabled (just shows fewer
  // tabs).
  { to: '/reports',       icon: BarChart3,       label: 'Reports',
    section: 'Insights',
    roles: ['business_owner', 'business_staff'] },
  // Settings
  { to: '/settings',      icon: Settings,        label: 'Settings',
    section: 'Settings',
    roles: ['business_owner'] },
]

export function Layout() {
  const { user, business, logout } = useAuth()
  const navigate = useNavigate()
  const enabled = new Set(business?.enabledFeatures ?? [])
  // Until the business summary loads, render every role-admitted item
  // (avoids a nav flicker where features briefly disappear). After
  // load, the feature gate applies.
  const businessLoaded = business !== null
  const items = NAV_ITEMS.filter(i => {
    if (!i.roles.includes(user?.role ?? '')) return false
    if (i.feature && businessLoaded && !enabled.has(i.feature)) return false
    return true
  })

  const handleLogout = () => {
    logout()
    navigate('/login')
  }

  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: '240px 1fr',
      minHeight: '100vh',
      background: 'var(--bg-0)',
      color: 'var(--text-0)',
    }}>
      <aside style={{
        background: 'var(--bg-1)',
        borderRight: '1px solid var(--border-0)',
        padding: '24px 0',
        display: 'flex',
        flexDirection: 'column',
      }}>
        <div style={{
          padding: '0 24px 24px',
          borderBottom: '1px solid var(--border-0)',
          marginBottom: 16,
        }}>
          <div style={{
            fontFamily: 'var(--font-display)',
            fontWeight: 700,
            fontSize: 18,
            color: 'var(--gold)',
          }}>GAM</div>
          <div style={{
            fontFamily: 'var(--font-body)',
            fontSize: 12,
            color: 'var(--text-2)',
            marginTop: 2,
          }}>for Businesses</div>
        </div>

        <nav style={{ flex: 1, padding: '0 12px' }}>
          {items.map(it => (
            <div key={it.to}>
              {it.section && (
                <div style={{
                  fontSize: 10,
                  textTransform: 'uppercase',
                  letterSpacing: 1.5,
                  color: 'var(--text-3)',
                  padding: '14px 12px 6px',
                  fontFamily: 'var(--font-body)',
                }}>{it.section}</div>
              )}
              <NavLink
                to={it.to}
                style={({ isActive }) => ({
                  display: 'flex',
                  alignItems: 'center',
                  gap: 12,
                  padding: '10px 12px',
                  borderRadius: 8,
                  color: isActive ? 'var(--gold)' : 'var(--text-1)',
                  background: isActive ? 'var(--gold-bg)' : 'transparent',
                  textDecoration: 'none',
                  fontSize: 14,
                  fontFamily: 'var(--font-body)',
                  marginBottom: 2,
                })}
              >
                <it.icon size={16} />
                {it.label}
              </NavLink>
            </div>
          ))}
        </nav>

        <div style={{ padding: '0 12px', borderTop: '1px solid var(--border-0)', paddingTop: 16 }}>
          <div style={{ padding: '0 12px', marginBottom: 8 }}>
            <div style={{ fontSize: 13, color: 'var(--text-1)' }}>
              {user?.firstName} {user?.lastName}
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-3)', textTransform: 'capitalize' }}>
              {user?.role?.replace('_', ' ')}
              {user?.staffRole ? ` · ${user.staffRole}` : ''}
            </div>
          </div>
          <button
            onClick={handleLogout}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              padding: '10px 12px',
              borderRadius: 8,
              color: 'var(--text-2)',
              background: 'transparent',
              border: 'none',
              cursor: 'pointer',
              width: '100%',
              fontSize: 14,
              fontFamily: 'var(--font-body)',
            }}
          >
            <LogOut size={16} />
            Log out
          </button>
        </div>
      </aside>

      <main style={{ padding: 0, overflow: 'auto' }}>
        <header style={{
          padding: '16px 32px',
          borderBottom: '1px solid var(--border-0)',
          background: 'var(--bg-0)',
          position: 'sticky' as const, top: 0, zIndex: 50,
          display: 'flex' as const, justifyContent: 'flex-end',
        }}>
          <GlobalSearch />
        </header>
        <div style={{ padding: 32 }}>
          <Outlet />
        </div>
      </main>
    </div>
  )
}
