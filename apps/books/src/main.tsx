import React, { createContext, useContext, useState } from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter, Routes, Route, Navigate, NavLink, Outlet, useNavigate, useLocation } from 'react-router-dom'
import { QueryClient, QueryClientProvider, useQuery } from 'react-query'
import axios from 'axios'
import { formatCurrency } from '@gam/shared'

const API = (import.meta as any).env?.VITE_API_URL || 'http://localhost:4000'
const api = axios.create({ baseURL: `${API}/api` })

// Token key — accepts admin token OR books-specific token
const TOKEN_KEYS = ['gam_admin_token', 'gam_books_token']
const getToken = () => TOKEN_KEYS.map(k => localStorage.getItem(k)).find(Boolean) || null

api.interceptors.request.use(c => {
  const t = getToken()
  if (t) c.headers.Authorization = `Bearer ${t}`
  return c
})
api.interceptors.response.use(r => r, e => {
  if (e.response?.status === 401 && !e.config.url.includes('/auth/')) {
    TOKEN_KEYS.forEach(k => localStorage.removeItem(k))
    window.location.href = '/login'
  }
  return Promise.reject(e)
})

const get = <T,>(url: string) => api.get<{ success: boolean; data: T }>(url).then(r => r.data.data)
const post = <T,>(url: string, body?: any) => api.post<{ success: boolean; data: T; message?: string }>(url, body).then(r => r.data)

const ALLOWED_ROLES = ['admin', 'super_admin', 'landlord']

interface AuthUser { id: string; email: string; role: string; firstName: string; lastName: string; landlordId?: string }
interface AuthCtx { user: AuthUser | null; loading: boolean; login: (e: string, p: string) => Promise<void>; logout: () => void }
const Ctx = createContext<AuthCtx>(null!)
const useAuth = () => useContext(Ctx)

function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null)
  const [loading, setLoading] = useState(true)

  const logout = React.useCallback(() => {
    TOKEN_KEYS.forEach(k => localStorage.removeItem(k))
    delete api.defaults.headers.common['Authorization']
    setUser(null)
  }, [])

  React.useEffect(() => {
    // Check for token passed from admin portal via URL (?token=xxx)
    const params = new URLSearchParams(window.location.search)
    const urlToken = params.get('token')
    if (urlToken) {
      localStorage.setItem('gam_books_token', urlToken)
      // Clean token from URL without reload
      window.history.replaceState({}, '', window.location.pathname)
    }

    const t = getToken()
    if (!t) { setLoading(false); return }
    api.defaults.headers.common['Authorization'] = 'Bearer ' + t
    api.get('/auth/me').then(res => {
      const u = res.data.data
      if (!u || !ALLOWED_ROLES.includes(u.role)) { logout(); return }
      setUser({ id: u.id, email: u.email, role: u.role, firstName: u.first_name || u.firstName || '', lastName: u.last_name || u.lastName || '', landlordId: u.landlordId || u.landlord_id })
    }).catch(logout).finally(() => setLoading(false))
  }, [logout])

  const login = async (email: string, password: string) => {
    const res = await axios.post(`${API}/api/auth/login`, { email, password })
    const { token: tk, user: u } = res.data.data
    if (!u || !ALLOWED_ROLES.includes(u.role)) throw new Error('GAM Books requires Admin or Landlord access')
    localStorage.setItem('gam_books_token', tk)
    api.defaults.headers.common['Authorization'] = 'Bearer ' + tk
    setUser({ id: u.id, email: u.email, role: u.role, firstName: u.firstName || u.first_name || '', lastName: u.lastName || u.last_name || '', landlordId: u.landlordId || u.landlord_id })
  }

  return <Ctx.Provider value={{ user, loading, login, logout }}>{children}</Ctx.Provider>
}

const qc = new QueryClient({ defaultOptions: { queries: { retry: 1, staleTime: 15000 } } })

// ── STYLES ──────────────────────────────────────────────────────────
const css = `
@import url('https://fonts.googleapis.com/css2?family=Syne:wght@600;700;800&family=DM+Sans:wght@300;400;500;600&family=DM+Mono:wght@400;500&display=swap');
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg0:#080a0c;--bg1:#0d1014;--bg2:#121519;--bg3:#181c22;--bg4:#1e2330;
  --b0:#1a1f28;--b1:#222a38;--b2:#2a3547;
  --t0:#eef0f6;--t1:#b8c4d8;--t2:#7a8aaa;--t3:#475060;
  --gold:#c9a227;--green:#22c55e;--red:#ef4444;--amber:#f59e0b;--blue:#3b82f6;--purple:#a855f7;--teal:#14b8a6;
  --font-d:'Syne',sans-serif;--font-b:'DM Sans',sans-serif;--font-m:'DM Mono',monospace
}
html{-webkit-font-smoothing:antialiased}
body{font-family:var(--font-b);background:var(--bg0);color:var(--t1);line-height:1.6;min-height:100vh}
h1,h2,h3,h4{font-family:var(--font-d);color:var(--t0);line-height:1.2}
button{cursor:pointer;font-family:var(--font-b)}input,select,textarea{font-family:var(--font-b)}
a{color:var(--gold);text-decoration:none}
.shell{display:flex;min-height:100vh}
.sidebar{width:230px;flex-shrink:0;background:var(--bg1);border-right:1px solid var(--b0);position:fixed;top:0;left:0;bottom:0;z-index:50;display:flex;flex-direction:column;overflow-y:auto}
.main{flex:1;margin-left:230px;min-height:100vh;display:flex;flex-direction:column}
.topbar{height:52px;background:var(--bg1);border-bottom:1px solid var(--b0);display:flex;align-items:center;padding:0 24px;position:sticky;top:0;z-index:40;gap:12px}
.page{flex:1;padding:28px;max-width:1600px;width:100%}
.logo{padding:18px;border-bottom:1px solid var(--b0)}
.logo-n{font-family:var(--font-d);font-size:1.05rem;font-weight:800;color:var(--gold)}
.logo-s{font-size:.65rem;color:var(--t3);margin-top:2px;text-transform:uppercase;letter-spacing:.1em}
.nav{padding:10px;flex:1}
.nl{font-size:.62rem;color:var(--t3);text-transform:uppercase;letter-spacing:.12em;padding:10px 8px 4px;font-weight:600}
.ni{display:flex;align-items:center;gap:9px;padding:7px 10px;border-radius:7px;color:var(--t2);font-size:.82rem;font-weight:500;transition:all .12s;width:100%;background:none;border:none;cursor:pointer;text-decoration:none}
.ni:hover{background:var(--bg3);color:var(--t0)}
.ni.active{background:rgba(201,162,39,.1);color:var(--gold);border:1px solid rgba(201,162,39,.2)}
.sfooter{padding:10px;border-top:1px solid var(--b0)}
.card{background:var(--bg2);border:1px solid var(--b1);border-radius:10px;padding:18px}
.ct{font-size:.72rem;font-weight:700;color:var(--t3);text-transform:uppercase;letter-spacing:.07em;margin-bottom:14px}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:16px}
.grid3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:16px}
.grid4{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}
@media(max-width:1200px){.grid4{grid-template-columns:repeat(2,1fr)}}
@media(max-width:900px){.grid2,.grid3,.grid4{grid-template-columns:1fr}}
.ph{display:flex;align-items:center;justify-content:space-between;margin-bottom:20px;padding-bottom:14px;border-bottom:1px solid var(--b0)}
.pt{font-family:var(--font-d);font-size:1.4rem;font-weight:800;color:var(--t0)}
.ps{font-size:.78rem;color:var(--t3);margin-top:2px}
.kpi{background:var(--bg2);border:1px solid var(--b1);border-radius:10px;padding:16px;position:relative;overflow:hidden}
.kpi::after{content:'';position:absolute;bottom:0;left:0;right:0;height:2px;background:linear-gradient(90deg,var(--gold),transparent);opacity:.4}
.kl{font-size:.65rem;color:var(--t3);text-transform:uppercase;letter-spacing:.09em;font-weight:600;margin-bottom:6px}
.kv{font-family:var(--font-d);font-size:1.6rem;font-weight:800;color:var(--t0);line-height:1;margin-bottom:4px}
.ks{font-size:.7rem;color:var(--t3)}
.kv.g{color:var(--green)}.kv.r{color:var(--red)}.kv.a{color:var(--amber)}.kv.gold{color:var(--gold)}.kv.b{color:var(--blue)}.kv.t{color:var(--teal)}
.btn{display:inline-flex;align-items:center;gap:6px;padding:7px 14px;border-radius:7px;font-size:.78rem;font-weight:600;border:none;cursor:pointer;transition:all .12s;font-family:var(--font-b);text-decoration:none}
.bp{background:var(--gold);color:#080a0c}.bp:hover{background:#d9af3a}
.bg-btn{background:var(--bg4);color:var(--t1);border:1px solid var(--b2)}.bg-btn:hover{background:var(--bg3)}
.bd{background:rgba(239,68,68,.08);color:var(--red);border:1px solid rgba(239,68,68,.2)}.bd:hover{background:rgba(239,68,68,.14)}
.bt{background:rgba(20,184,166,.08);color:var(--teal);border:1px solid rgba(20,184,166,.2)}.bt:hover{background:rgba(20,184,166,.14)}
.bsm{padding:4px 9px;font-size:.72rem}
.badge{display:inline-flex;align-items:center;gap:4px;padding:3px 9px;border-radius:20px;font-size:.65rem;font-weight:600;text-transform:uppercase;letter-spacing:.04em}
.bg2{background:rgba(34,197,94,.08);color:var(--green);border:1px solid rgba(34,197,94,.18)}
.ba{background:rgba(245,158,11,.08);color:var(--amber);border:1px solid rgba(245,158,11,.18)}
.br{background:rgba(239,68,68,.08);color:var(--red);border:1px solid rgba(239,68,68,.18)}
.bgold{background:rgba(201,162,39,.08);color:var(--gold);border:1px solid rgba(201,162,39,.18)}
.bmu{background:var(--bg4);color:var(--t3);border:1px solid var(--b1)}
.bb{background:rgba(59,130,246,.08);color:var(--blue);border:1px solid rgba(59,130,246,.18)}
.bteal{background:rgba(20,184,166,.08);color:var(--teal);border:1px solid rgba(20,184,166,.18)}
.tbl{width:100%;border-collapse:collapse;font-size:.78rem}
.tbl th{background:var(--bg3);color:var(--t3);font-size:.64rem;font-weight:600;text-transform:uppercase;letter-spacing:.08em;padding:9px 12px;text-align:left;border-bottom:1px solid var(--b1)}
.tbl td{padding:9px 12px;border-bottom:1px solid var(--b0);color:var(--t1)}
.tbl tr:last-child td{border-bottom:none}
.tbl tr:hover td{background:rgba(255,255,255,.012)}
.mono{font-family:var(--font-m);font-size:.8rem}
.alert{display:flex;align-items:flex-start;gap:10px;padding:10px 14px;border-radius:8px;font-size:.78rem;margin-bottom:14px}
.ae{background:rgba(239,68,68,.08);border:1px solid rgba(239,68,68,.18);color:#fca5a5}
.aw{background:rgba(245,158,11,.08);border:1px solid rgba(245,158,11,.18);color:#fcd34d}
.ag{background:rgba(34,197,94,.08);border:1px solid rgba(34,197,94,.18);color:#86efac}
.agold{background:rgba(201,162,39,.08);border:1px solid rgba(201,162,39,.18);color:var(--gold)}
.empty{text-align:center;padding:48px 20px;color:var(--t3)}
.loading{display:flex;align-items:center;justify-content:center;height:100vh;font-family:var(--font-d);font-size:1.1rem;color:var(--t3)}
.spinner{width:16px;height:16px;border:2px solid var(--b2);border-top-color:var(--gold);border-radius:50%;animation:spin .6s linear infinite}
.dr{display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid var(--b0);font-size:.78rem}
.dr:last-child{border-bottom:none}
.dk{color:var(--t3)}.dv{color:var(--t0);font-weight:500}
.tabs{display:flex;gap:2px;border-bottom:1px solid var(--b0);margin-bottom:20px}
.tab{padding:9px 14px;background:none;border:none;color:var(--t3);font-size:.78rem;font-weight:600;cursor:pointer;border-bottom:2px solid transparent;margin-bottom:-1px;transition:all .12s;font-family:var(--font-b)}
.tab:hover{color:var(--t1)}.tab.on{color:var(--gold);border-bottom-color:var(--gold)}
input[type=text],input[type=email],input[type=number],input[type=date],input[type=password],select,textarea{width:100%;background:var(--bg3);border:1px solid var(--b1);border-radius:7px;color:var(--t0);padding:8px 11px;font-size:.875rem;outline:none;transition:border .12s}
input:focus,select:focus,textarea:focus{border-color:var(--gold)}
label{display:block;font-size:.72rem;font-weight:600;color:var(--t3);margin-bottom:5px;text-transform:uppercase;letter-spacing:.06em}
.frow{margin-bottom:14px}
@keyframes spin{to{transform:rotate(360deg)}}
`

// ── LAYOUT ──────────────────────────────────────────────────────────
function Layout() {
  const { user, logout } = useAuth()
  const navigate = useNavigate()
  const isAdmin = user?.role === 'admin' || user?.role === 'super_admin'

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="logo">
          <div className="logo-n">📒 GAM Books</div>
          <div className="logo-s">Payroll & Bookkeeping</div>
        </div>
        <nav className="nav">
          <div className="nl">Overview</div>
          <NavLink to="/dashboard" className={({ isActive }) => `ni${isActive ? ' active' : ''}`}>📊 Dashboard</NavLink>

          <div className="nl" style={{ marginTop: 8 }}>Payroll</div>
          <NavLink to="/payroll/employees" className={({ isActive }) => `ni${isActive ? ' active' : ''}`}>👥 Employees (W-2)</NavLink>
          <NavLink to="/payroll/contractors" className={({ isActive }) => `ni${isActive ? ' active' : ''}`}>🔧 Contractors (1099)</NavLink>
          <NavLink to="/payroll/vendors" className={({ isActive }) => `ni${isActive ? ' active' : ''}`}>🏪 Vendors</NavLink>
          <NavLink to="/payroll/runs" className={({ isActive }) => `ni${isActive ? ' active' : ''}`}>▶ Run Payroll</NavLink>
          <NavLink to="/payroll/history" className={({ isActive }) => `ni${isActive ? ' active' : ''}`}>🕐 Pay History</NavLink>
          <NavLink to="/payroll/tax-forms" className={({ isActive }) => `ni${isActive ? ' active' : ''}`}>📋 Tax Forms</NavLink>

          <div className="nl" style={{ marginTop: 8 }}>Bookkeeping</div>
          <NavLink to="/books/accounts" className={({ isActive }) => `ni${isActive ? ' active' : ''}`}>📂 Chart of Accounts</NavLink>
          <NavLink to="/books/journal" className={({ isActive }) => `ni${isActive ? ' active' : ''}`}>📓 Journal Entries</NavLink>
          <NavLink to="/books/transactions" className={({ isActive }) => `ni${isActive ? ' active' : ''}`}>💳 Transactions</NavLink>
          <NavLink to="/books/reconcile" className={({ isActive }) => `ni${isActive ? ' active' : ''}`}>🏦 Bank Reconciliation</NavLink>

          <div className="nl" style={{ marginTop: 8 }}>Property Finance</div>
          <NavLink to="/rent-roll" className={({ isActive }) => `ni${isActive ? ' active' : ''}`}>🏘 Rent Roll</NavLink>
          <NavLink to="/disbursements" className={({ isActive }) => `ni${isActive ? ' active' : ''}`}>💸 Owner Disbursements</NavLink>
          <NavLink to="/bills" className={({ isActive }) => `ni${isActive ? ' active' : ''}`}>📄 Bills & AP</NavLink>

          <div className="nl" style={{ marginTop: 8 }}>Reports</div>
          <NavLink to="/reports/pl" className={({ isActive }) => `ni${isActive ? ' active' : ''}`}>📈 P&amp;L</NavLink>
          <NavLink to="/reports/balance-sheet" className={({ isActive }) => `ni${isActive ? ' active' : ''}`}>⚖ Balance Sheet</NavLink>
          <NavLink to="/reports/cash-flow" className={({ isActive }) => `ni${isActive ? ' active' : ''}`}>💧 Cash Flow</NavLink>
          <NavLink to="/reports/owner-statements" className={({ isActive }) => `ni${isActive ? ' active' : ''}`}>🏠 Owner Statements</NavLink>

          <div className="nl" style={{ marginTop: 8 }}>Tax</div>
          <NavLink to="/tax" className={({ isActive }) => `ni${isActive ? ' active' : ''}`}>🏛 Tax Center</NavLink>

          {isAdmin && (
            <>
              <div className="nl" style={{ marginTop: 8 }}>Admin</div>
              <NavLink to="/admin/companies" className={({ isActive }) => `ni${isActive ? ' active' : ''}`}>🏢 All Companies</NavLink>
              <NavLink to="/admin/audit" className={({ isActive }) => `ni${isActive ? ' active' : ''}`}>🔍 Audit Log</NavLink>
            </>
          )}
        </nav>
        <div className="sfooter">
          <div style={{ padding: '6px 10px', marginBottom: 4 }}>
            <div style={{ fontWeight: 600, color: 'var(--t0)', fontSize: '.78rem' }}>{user?.firstName} {user?.lastName}</div>
            <div style={{ fontSize: '.65rem', color: 'var(--t3)', display: 'flex', gap: 6, alignItems: 'center' }}>
              <span className={`badge ${isAdmin ? 'br' : 'bgold'}`} style={{ fontSize: '.6rem', padding: '1px 6px' }}>
                {isAdmin ? 'Admin' : 'Landlord'}
              </span>
            </div>
          </div>
          {isAdmin && (
            <a href="http://localhost:3003" className="ni" style={{ color: 'var(--t3)', fontSize: '.75rem' }}>← Admin Console</a>
          )}
          <button className="ni" onClick={() => { logout(); navigate('/login') }} style={{ color: 'var(--red)' }}>🚪 Sign out</button>
        </div>
      </aside>
      <div className="main">
        <header className="topbar">
          <span style={{ fontSize: '.72rem', color: 'var(--t3)', fontFamily: 'var(--font-m)' }}>
            GAM Books · {user?.firstName} {user?.lastName}
          </span>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
            <span className="badge bgold">Beta</span>
          </div>
        </header>
        <div className="page"><Outlet /></div>
      </div>
    </div>
  )
}

// ── DASHBOARD ──────────────────────────────────────────────────────
function Dashboard() {
  const { user } = useAuth()
  const isAdmin = user?.role === 'admin' || user?.role === 'super_admin'
  const now = new Date()
  const monthName = now.toLocaleString('default', { month: 'long', year: 'numeric' })

  return (
    <div>
      <div className="ph">
        <div>
          <h1 className="pt">Books Dashboard</h1>
          <p className="ps">{monthName} · {isAdmin ? 'Platform-wide view' : 'Your properties'}</p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <span className="badge bgold">📒 GAM Books</span>
          <span className="badge bteal">Beta</span>
        </div>
      </div>

      <div className="alert agold" style={{ marginBottom: 20 }}>
        📒 <strong>GAM Books is being set up.</strong> Connect your bank account and chart of accounts in Settings to get started.
      </div>

      <div className="grid4" style={{ marginBottom: 16 }}>
        <div className="kpi"><div className="kl">Total Revenue (MTD)</div><div className="kv gold">—</div><div className="ks">Connect bank to track</div></div>
        <div className="kpi"><div className="kl">Total Expenses (MTD)</div><div className="kv r">—</div><div className="ks">Add expense accounts</div></div>
        <div className="kpi"><div className="kl">Net Income (MTD)</div><div className="kv g">—</div><div className="ks">P&amp;L will show here</div></div>
        <div className="kpi"><div className="kl">Next Payroll</div><div className="kv a">—</div><div className="ks">No payroll scheduled</div></div>
      </div>

      <div className="grid2" style={{ marginBottom: 16 }}>
        <div className="card">
          <div className="ct">Quick Actions</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <a href="/payroll/runs" className="btn bp" style={{ justifyContent: 'center' }}>▶ Run Payroll</a>
            <a href="/books/journal" className="btn bg-btn" style={{ justifyContent: 'center' }}>📓 New Journal Entry</a>
            <a href="/bills" className="btn bg-btn" style={{ justifyContent: 'center' }}>📄 Add a Bill</a>
            <a href="/reports/pl" className="btn bt" style={{ justifyContent: 'center' }}>📈 View P&amp;L Report</a>
          </div>
        </div>
        <div className="card">
          <div className="ct">Payroll Summary</div>
          <div className="dr"><span className="dk">Employees (W-2)</span><span className="dv mono">0</span></div>
          <div className="dr"><span className="dk">Contractors (1099)</span><span className="dv mono">0</span></div>
          <div className="dr"><span className="dk">Vendors</span><span className="dv mono">0</span></div>
          <div className="dr"><span className="dk">Last payroll run</span><span className="dv mono">—</span></div>
          <div className="dr"><span className="dk">Next scheduled run</span><span className="dv">Not scheduled</span></div>
          <div className="dr"><span className="dk">YTD payroll total</span><span className="dv mono">—</span></div>
        </div>
      </div>

      <div className="grid3">
        <div className="card">
          <div className="ct">Tax Liabilities</div>
          <div className="dr"><span className="dk">Federal Income (W/H)</span><span className="dv mono">—</span></div>
          <div className="dr"><span className="dk">Social Security (6.2%)</span><span className="dv mono">—</span></div>
          <div className="dr"><span className="dk">Medicare (1.45%)</span><span className="dv mono">—</span></div>
          <div className="dr"><span className="dk">AZ State (2.5% flat)</span><span className="dv mono">—</span></div>
          <div className="dr"><span className="dk">FUTA / SUTA</span><span className="dv mono">—</span></div>
          <div style={{ marginTop: 10 }}><a href="/tax" className="btn bg-btn bsm">View Tax Center →</a></div>
        </div>
        <div className="card">
          <div className="ct">Accounts Payable</div>
          <div className="dr"><span className="dk">Open bills</span><span className="dv mono">0</span></div>
          <div className="dr"><span className="dk">Due this week</span><span className="dv mono">—</span></div>
          <div className="dr"><span className="dk">Overdue</span><span className="dv r">0</span></div>
          <div style={{ marginTop: 10 }}><a href="/bills" className="btn bg-btn bsm">Manage Bills →</a></div>
        </div>
        <div className="card">
          <div className="ct">Rent Roll Sync</div>
          <div className="dr"><span className="dk">GAM units synced</span><span className="dv mono">—</span></div>
          <div className="dr"><span className="dk">Expected rent (MTD)</span><span className="dv mono">—</span></div>
          <div className="dr"><span className="dk">Collected (MTD)</span><span className="dv mono">—</span></div>
          <div className="dr"><span className="dk">Variance</span><span className="dv mono">—</span></div>
          <div style={{ marginTop: 10 }}><a href="/rent-roll" className="btn bg-btn bsm">View Rent Roll →</a></div>
        </div>
      </div>
    </div>
  )
}

// ── STUB PAGES ──────────────────────────────────────────────────────
function ComingSoon({ title, icon, description }: { title: string; icon: string; description: string }) {
  return (
    <div>
      <div className="ph">
        <div><h1 className="pt">{icon} {title}</h1><p className="ps">{description}</p></div>
      </div>
      <div className="card" style={{ textAlign: 'center', padding: '60px 20px' }}>
        <div style={{ fontSize: '3rem', marginBottom: 16 }}>{icon}</div>
        <h2 style={{ color: 'var(--t0)', marginBottom: 8 }}>{title}</h2>
        <p style={{ color: 'var(--t3)', fontSize: '.85rem', maxWidth: 420, margin: '0 auto 20px' }}>
          This module is being built. Full functionality coming in the next session.
        </p>
        <span className="badge bteal">In Development</span>
      </div>
    </div>
  )
}

// ── LOGIN ──────────────────────────────────────────────────────────
function LoginPage() {
  React.useEffect(() => {
    TOKEN_KEYS.forEach(k => localStorage.removeItem(k))
    delete api.defaults.headers.common['Authorization']
  }, [])
  const { login } = useAuth()
  const navigate = useNavigate()
  const [email, setEmail] = useState('')
  const [pw, setPw] = useState('')
  const [err, setErr] = useState('')
  const [loading, setLoading] = useState(false)

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault(); setLoading(true); setErr('')
    try { await login(email, pw); navigate('/dashboard') }
    catch (ex: any) { setErr(ex.response?.data?.error || ex.message || 'Login failed') }
    finally { setLoading(false) }
  }

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg0)', padding: 20 }}>
      <div style={{ width: '100%', maxWidth: 400 }}>
        <div style={{ textAlign: 'center', marginBottom: 40 }}>
          <div style={{ fontFamily: 'var(--font-d)', fontSize: '2rem', fontWeight: 800, color: 'var(--gold)', marginBottom: 8 }}>📒 GAM Books</div>
          <div style={{ color: 'var(--t3)', fontSize: '.82rem' }}>Payroll & Bookkeeping · Gold Asset Management</div>
        </div>
        <div className="card" style={{ padding: 24 }}>
          {err && <div className="alert ae" style={{ marginBottom: 14 }}>{err}</div>}
          <div className="alert agold" style={{ marginBottom: 20, fontSize: '.75rem' }}>
            Sign in with your GAM Admin or Landlord credentials.
          </div>
          <form onSubmit={onSubmit}>
            <div className="frow">
              <label>Email</label>
              <input type="email" value={email} onChange={e => setEmail(e.target.value)} autoFocus required />
            </div>
            <div className="frow">
              <label>Password</label>
              <input type="password" value={pw} onChange={e => setPw(e.target.value)} required />
            </div>
            <button className="bp btn" type="submit" disabled={loading} style={{ width: '100%', justifyContent: 'center', marginTop: 4 }}>
              {loading ? <span className="spinner" /> : 'Sign in to GAM Books'}
            </button>
          </form>
        </div>
        <div style={{ textAlign: 'center', marginTop: 20 }}>
          <a href="http://localhost:3003" style={{ color: 'var(--t3)', fontSize: '.75rem' }}>← Back to Admin Console</a>
        </div>
      </div>
    </div>
  )
}

// ── APP ────────────────────────────────────────────────────────────
function App() {
  const { user, loading } = useAuth()
  const loc = useLocation()
  if (loading) return <div className="loading"><span className="spinner" style={{ marginRight: 10 }} />Loading GAM Books…</div>
  const authed = !!user && ALLOWED_ROLES.includes(user.role)
  return (
    <Routes>
      <Route path="/login" element={authed ? <Navigate to="/dashboard" replace /> : <LoginPage />} />
      <Route path="/" element={authed ? <Layout /> : <Navigate to={`/login`} replace />}>
        <Route index element={<Navigate to="/dashboard" replace />} />
        <Route path="dashboard" element={<Dashboard />} />

        {/* Payroll */}
        <Route path="payroll/employees"   element={<ComingSoon title="Employees (W-2)" icon="👥" description="Manage W-2 employees, salaries, withholdings, and benefits" />} />
        <Route path="payroll/contractors" element={<ComingSoon title="Contractors (1099)" icon="🔧" description="1099 contractors — NEC forms, payments, and year-end reporting" />} />
        <Route path="payroll/vendors"     element={<ComingSoon title="Vendors" icon="🏪" description="Vendor management, payment terms, and AP integration" />} />
        <Route path="payroll/runs"        element={<ComingSoon title="Run Payroll" icon="▶" description="Process payroll runs for employees and contractors" />} />
        <Route path="payroll/history"     element={<ComingSoon title="Pay History" icon="🕐" description="Full payroll run history, pay stubs, and audit trail" />} />
        <Route path="payroll/tax-forms"   element={<ComingSoon title="Tax Forms" icon="📋" description="W-2s, 1099-NECs, 940, 941, and AZ state forms" />} />

        {/* Bookkeeping */}
        <Route path="books/accounts"     element={<ComingSoon title="Chart of Accounts" icon="📂" description="Full double-entry chart of accounts with account types and sub-accounts" />} />
        <Route path="books/journal"      element={<ComingSoon title="Journal Entries" icon="📓" description="Manual journal entries with debit/credit validation" />} />
        <Route path="books/transactions" element={<ComingSoon title="Transactions" icon="💳" description="All income and expense transactions with categorization" />} />
        <Route path="books/reconcile"    element={<ComingSoon title="Bank Reconciliation" icon="🏦" description="Reconcile bank statements against your book balance" />} />

        {/* Property Finance */}
        <Route path="rent-roll"     element={<ComingSoon title="Rent Roll" icon="🏘" description="Live rent roll synced from GAM — expected vs collected reconciliation" />} />
        <Route path="disbursements" element={<ComingSoon title="Owner Disbursements" icon="💸" description="Owner disbursement history and statements synced from GAM" />} />
        <Route path="bills"         element={<ComingSoon title="Bills & AP" icon="📄" description="Vendor bills, purchase orders, and accounts payable queue" />} />

        {/* Reports */}
        <Route path="reports/pl"               element={<ComingSoon title="Profit & Loss" icon="📈" description="Income statement by period — property, portfolio, or company" />} />
        <Route path="reports/balance-sheet"    element={<ComingSoon title="Balance Sheet" icon="⚖" description="Assets, liabilities, and equity snapshot" />} />
        <Route path="reports/cash-flow"        element={<ComingSoon title="Cash Flow Statement" icon="💧" description="Operating, investing, and financing activities" />} />
        <Route path="reports/owner-statements" element={<ComingSoon title="Owner Statements" icon="🏠" description="Per-property income and expense statements for owners" />} />

        {/* Tax */}
        <Route path="tax" element={<ComingSoon title="Tax Center" icon="🏛" description="Payroll tax tracking — Federal, AZ (2.5%), SS, Medicare, FUTA/SUTA" />} />

        {/* Admin only */}
        <Route path="admin/companies" element={<ComingSoon title="All Companies" icon="🏢" description="Platform-wide books view across all landlord companies" />} />
        <Route path="admin/audit"     element={<ComingSoon title="Audit Log" icon="🔍" description="Full audit trail for all books entries and payroll actions" />} />
      </Route>
      <Route path="*" element={<Navigate to={authed ? '/dashboard' : '/login'} replace />} />
    </Routes>
  )
}

function Root() {
  return (
    <QueryClientProvider client={qc}>
      <AuthProvider>
        <style dangerouslySetInnerHTML={{ __html: css }} />
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </AuthProvider>
    </QueryClientProvider>
  )
}

ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><Root /></React.StrictMode>)
