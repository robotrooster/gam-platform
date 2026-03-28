import { AcceptInvitePage } from './pages/AcceptInvitePage'
import { BackgroundCheckPage } from './pages/BackgroundCheckPage'
import { TenantNotificationsPage } from './pages/TenantNotificationsPage'

function DefaultPage() {
  const { data: status } = useQuery('bg-status', () =>
    fetch((import.meta as any).env?.VITE_API_URL + '/api/background/status', {
      headers: { Authorization: 'Bearer ' + localStorage.getItem('gam_tenant_token') }
    }).then(r=>r.json()).then(r=>r.data)
  )
  if (!status) return null
  if (status.status === 'denied') return <BackgroundCheckPage />
  if (status.status === 'not_started' || status.status === 'submitted') return <BackgroundCheckPage />
  return <Navigate to="/home" replace />
}
import { SignPage } from './pages/SignPage'
import { LeasePage } from './pages/LeasePage'
import { ProfilePage } from './pages/ProfilePage'
import React, { createContext, useContext, useState, useEffect, useCallback } from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter, Routes, Route, Navigate, NavLink, Outlet, useNavigate } from 'react-router-dom'
import { QueryClient, QueryClientProvider, useQuery, useMutation } from 'react-query'
import { useForm } from 'react-hook-form'
import axios from 'axios'
import { formatCurrency, PLATFORM_FEES, getFlexDepositTier } from '@gam/shared'

// ── API ──────────────────────────────────────────────────────
const API_URL = (import.meta as any).env?.VITE_API_URL || 'http://localhost:4000'
const api = axios.create({ baseURL: `${API_URL}/api` })
api.interceptors.request.use(c => { const t = localStorage.getItem('gam_tenant_token'); if(t) c.headers.Authorization=`Bearer ${t}`; return c })
api.interceptors.response.use(r=>r, e => { if(e.response?.status===401){localStorage.removeItem('gam_tenant_token');window.location.href='/login'} return Promise.reject(e) })
const get = <T,>(url: string) => api.get<{success:boolean;data:T}>(url).then(r=>r.data.data)
const post = <T,>(url: string, body?: any) => api.post<{success:boolean;data:T;message?:string}>(url,body).then(r=>r.data)

// ── AUTH ──────────────────────────────────────────────────────
interface AuthUser { id:string;email:string;role:string;firstName:string;lastName:string;profileId:string }
interface AuthCtx { user:AuthUser|null;token:string|null;loading:boolean;login:(e:string,p:string)=>Promise<void>;logout:()=>void }
const Ctx = React.createContext<AuthCtx>(null!)
const useAuth = () => useContext(Ctx)

function AuthProvider({children}:{children:React.ReactNode}) {
  const [user,setUser]=useState<AuthUser|null>(null)
  const [token,setToken]=useState<string|null>(()=>localStorage.getItem('gam_tenant_token'))
  const [loading,setLoading]=useState(true)
  const logout = useCallback(()=>{localStorage.removeItem('gam_tenant_token');setToken(null);setUser(null)},[])
  useEffect(()=>{
    if(!token){setLoading(false);return}
    get<AuthUser>('/auth/me').then(u=>setUser(u)).catch(logout).finally(()=>setLoading(false))
  },[token,logout])
  const login = async(email:string,password:string)=>{
    const res=await post<{token:string;user:AuthUser}>('/auth/login',{email,password})
    localStorage.setItem('gam_tenant_token',res.data!.token);setToken(res.data!.token);setUser(res.data!.user)
  }
  return <Ctx.Provider value={{user,token,loading,login,logout}}>{children}</Ctx.Provider>
}

// ── STYLES ────────────────────────────────────────────────────
const css = `
@import url('https://fonts.googleapis.com/css2?family=Syne:wght@600;700;800&family=DM+Sans:wght@300;400;500;600&family=DM+Mono:wght@400;500&display=swap');
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{--bg0:#0a0b0e;--bg1:#0f1116;--bg2:#141720;--bg3:#1a1f2e;--bg4:#212636;
  --b0:#1e2435;--b1:#252d42;--b2:#2f3a55;
  --t0:#f0f2f7;--t1:#c4ccde;--t2:#8a96b0;--t3:#555f7a;
  --gold:#c9a227;--green:#22c55e;--red:#ef4444;--amber:#f59e0b;--blue:#3b82f6;
  --font-d:'Syne',sans-serif;--font-b:'DM Sans',sans-serif;--font-m:'DM Mono',monospace}
html{-webkit-font-smoothing:antialiased}
body{font-family:var(--font-b);background:var(--bg0);color:var(--t1);line-height:1.6;min-height:100vh}
h1,h2,h3{font-family:var(--font-d);color:var(--t0);line-height:1.2}
h1{font-size:1.8rem;font-weight:800}h2{font-size:1.3rem;font-weight:700}h3{font-size:1.1rem;font-weight:700}
a{color:var(--gold);text-decoration:none}
button{cursor:pointer;font-family:var(--font-b)}
input,select,textarea{font-family:var(--font-b)}
.shell{display:flex;min-height:100vh}
.sidebar{width:220px;flex-shrink:0;background:var(--bg1);border-right:1px solid var(--b0);display:flex;flex-direction:column;position:fixed;top:0;left:0;bottom:0;z-index:50}
.main{flex:1;margin-left:220px;min-height:100vh;display:flex;flex-direction:column}
.topbar{height:52px;background:var(--bg1);border-bottom:1px solid var(--b0);display:flex;align-items:center;padding:0 24px;position:sticky;top:0;z-index:40}
.page{flex:1;padding:28px;max-width:1200px;width:100%}
.logo{padding:20px;border-bottom:1px solid var(--b0)}
.logo-name{font-family:var(--font-d);font-size:1.1rem;font-weight:800;color:var(--gold)}
.logo-sub{font-size:.7rem;color:var(--t3);margin-top:2px;text-transform:uppercase;letter-spacing:.08em}
.nav{padding:12px;flex:1}
.nav-lbl{font-size:.65rem;color:var(--t3);text-transform:uppercase;letter-spacing:.1em;padding:10px 8px 4px;font-weight:600}
.ni{display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:8px;color:var(--t2);font-size:.875rem;font-weight:500;transition:all .15s;width:100%;background:none;border:none;cursor:pointer;text-decoration:none}
.ni:hover{background:var(--bg3);color:var(--t0)}
.ni.active{background:rgba(201,162,39,.08);color:var(--gold);border:1px solid rgba(201,162,39,.2)}
.footer{padding:12px;border-top:1px solid var(--b0)}
.card{background:var(--bg2);border:1px solid var(--b1);border-radius:12px;padding:20px}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:20px}
.grid3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:20px}
@media(max-width:900px){.grid2,.grid3{grid-template-columns:1fr}}
.ph{display:flex;align-items:center;justify-content:space-between;margin-bottom:24px;padding-bottom:16px;border-bottom:1px solid var(--b0)}
.pt{font-family:var(--font-d);font-size:1.5rem;font-weight:800;color:var(--t0)}
.ps{font-size:.82rem;color:var(--t3);margin-top:2px}
.kpi{background:var(--bg2);border:1px solid var(--b1);border-radius:12px;padding:20px}
.kpi-l{font-size:.7rem;color:var(--t3);text-transform:uppercase;letter-spacing:.08em;font-weight:600;margin-bottom:8px}
.kpi-v{font-family:var(--font-d);font-size:1.6rem;font-weight:800;color:var(--t0);line-height:1;margin-bottom:4px}
.kpi-s{font-size:.72rem;color:var(--t3)}
.btn{display:inline-flex;align-items:center;gap:7px;padding:8px 16px;border-radius:8px;font-size:.82rem;font-weight:600;border:none;cursor:pointer;transition:all .15s;font-family:var(--font-b);text-decoration:none}
.btn-p{background:var(--gold);color:#0a0b0e}.btn-p:hover{background:#d9af3a}
.btn-g{background:var(--bg4);color:var(--t1);border:1px solid var(--b2)}.btn-g:hover{background:var(--bg3);color:var(--t0)}
.btn-d{background:rgba(239,68,68,.08);color:var(--red);border:1px solid rgba(239,68,68,.25)}
.btn-sm{padding:5px 10px;font-size:.75rem}
.btn:disabled{opacity:.4;cursor:not-allowed}
.badge{display:inline-flex;align-items:center;gap:5px;padding:3px 10px;border-radius:20px;font-size:.68rem;font-weight:600;text-transform:uppercase;letter-spacing:.04em}
.b-green{background:rgba(34,197,94,.08);color:var(--green);border:1px solid rgba(34,197,94,.2)}
.b-amber{background:rgba(245,158,11,.08);color:var(--amber);border:1px solid rgba(245,158,11,.2)}
.b-red{background:rgba(239,68,68,.08);color:var(--red);border:1px solid rgba(239,68,68,.2)}
.b-gold{background:rgba(201,162,39,.08);color:var(--gold);border:1px solid rgba(201,162,39,.2)}
.b-muted{background:var(--bg4);color:var(--t3);border:1px solid var(--b1)}
.alert{display:flex;align-items:flex-start;gap:12px;padding:12px 16px;border-radius:8px;font-size:.82rem;margin-bottom:16px}
.a-gold{background:rgba(201,162,39,.08);border:1px solid rgba(201,162,39,.2);color:var(--gold)}
.a-green{background:rgba(34,197,94,.08);border:1px solid rgba(34,197,94,.2);color:#86efac}
.a-warn{background:rgba(245,158,11,.08);border:1px solid rgba(245,158,11,.2);color:#fcd34d}
.a-blue{background:rgba(59,130,246,.08);border:1px solid rgba(59,130,246,.2);color:#93c5fd}
.modal-ov{position:fixed;inset:0;background:rgba(0,0,0,.75);display:flex;align-items:center;justify-content:center;z-index:100;padding:20px;backdrop-filter:blur(4px)}
.modal{background:var(--bg2);border:1px solid var(--b2);border-radius:16px;padding:24px;width:100%;max-width:500px;max-height:90vh;overflow-y:auto;box-shadow:0 8px 32px rgba(0,0,0,.5)}
.modal-t{font-family:var(--font-d);font-size:1.1rem;font-weight:800;color:var(--t0);margin-bottom:20px}
.modal-f{display:flex;justify-content:flex-end;gap:10px;margin-top:20px;padding-top:16px;border-top:1px solid var(--b0)}
.fg{margin-bottom:16px}
.fl{display:block;font-size:.75rem;font-weight:600;color:var(--t2);margin-bottom:6px;text-transform:uppercase;letter-spacing:.05em}
.fi,.fs,.fta{width:100%;background:var(--bg3);border:1px solid var(--b1);border-radius:8px;color:var(--t0);padding:9px 12px;font-size:.875rem;font-family:var(--font-b);outline:none;transition:border-color .15s}
.fi:focus,.fs:focus,.fta:focus{border-color:var(--gold)}
.fi::placeholder{color:var(--t3)}
.fta{resize:vertical;min-height:80px}
.fg2{display:grid;grid-template-columns:1fr 1fr;gap:16px}
.dr{display:flex;justify-content:space-between;align-items:center;padding:7px 0;border-bottom:1px solid var(--b0);font-size:.82rem}
.dr:last-child{border-bottom:none}
.dk{color:var(--t3)}.dv{color:var(--t0);font-weight:500}
.mono{font-family:var(--font-m);font-size:.875rem}
.tbl{width:100%;border-collapse:collapse;font-size:.82rem}
.tbl th{background:var(--bg3);color:var(--t3);font-size:.68rem;font-weight:600;text-transform:uppercase;letter-spacing:.07em;padding:10px 14px;text-align:left;border-bottom:1px solid var(--b1)}
.tbl td{padding:11px 14px;border-bottom:1px solid var(--b0);color:var(--t1)}
.tbl tr:last-child td{border-bottom:none}
.empty{text-align:center;padding:48px 20px;color:var(--t3)}
.loading{display:flex;align-items:center;justify-content:center;height:100vh;font-family:var(--font-d);font-size:1.2rem;color:var(--t3)}
.spinner{width:18px;height:18px;border:2px solid var(--b2);border-top-color:var(--gold);border-radius:50%;animation:spin .6s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
.service-card{background:var(--bg3);border:1px solid var(--b1);border-radius:12px;padding:20px;display:flex;flex-direction:column;gap:12px;transition:border-color .2s}
.service-card:hover{border-color:var(--b2)}
.service-card.enrolled{border-color:rgba(34,197,94,.3);background:rgba(34,197,94,.03)}
.price-tag{font-family:var(--font-d);font-size:1.4rem;font-weight:800;color:var(--t0)}
.price-sub{font-size:.75rem;color:var(--t3)}
`

const qc = new QueryClient({ defaultOptions: { queries: { retry: 1, staleTime: 30000 } } })

// ── LAYOUT ────────────────────────────────────────────────────
function LeaseNavLink() {
  const { data: pendingDocs = [] } = useQuery('pending-docs', () =>
    fetch((import.meta as any).env?.VITE_API_URL + '/api/esign/pending', {
      headers: { Authorization: 'Bearer ' + localStorage.getItem('gam_tenant_token') }
    }).then(r=>r.json()).then(r=>r.data||[])
  )
  const token = (pendingDocs as any[])[0]?.token
  return token
    ? <NavLink to={'/sign/'+token} className={({isActive})=>`ni${isActive?' active':''}`}>📋 Lease</NavLink>
    : <NavLink to="/lease" className={({isActive})=>`ni${isActive?' active':''}`}>📋 Lease</NavLink>
}

const FONTS: Record<string, string> = {
  default: "'DM Sans',sans-serif",
  terminator: "'Terminator',sans-serif",
  matrix: "'Matrix',monospace",
  bladerunner: "'BladeRunner',sans-serif",
  teamfury: "'TeamFury',sans-serif",
}

const FONT_IMPORTS: Record<string, string> = {
  terminator: "@font-face{font-family:'Terminator';src:url('/fonts/terminator.ttf') format('truetype');}",
  matrix: "@font-face{font-family:'Matrix';src:url('/fonts/matrix.ttf') format('truetype');}",
  bladerunner: "@font-face{font-family:'BladeRunner';src:url('/fonts/bladerunner.ttf') format('truetype');}",
  teamfury: "@font-face{font-family:'TeamFury';src:url('/fonts/teamfury.ttf') format('truetype');}",
}

function Layout() {
  const { data: bgStatus } = useQuery('bg-status-nav', () =>
    fetch((import.meta as any).env?.VITE_API_URL + '/api/background/status', {
      headers: { Authorization: 'Bearer ' + localStorage.getItem('gam_tenant_token') }
    }).then(r=>r.json()).then(r=>r.data)
  )
  const { data: tenantMe } = useQuery('tenant-me-theme', () =>
    fetch((import.meta as any).env?.VITE_API_URL + '/api/tenants/me', {
      headers: { Authorization: 'Bearer ' + localStorage.getItem('gam_tenant_token') }
    }).then(r=>r.json()).then(r=>r.data),
    { staleTime: 60000 }
  )
  const accent = tenantMe?.theme_accent || '#c9a227'
  const fontKey = tenantMe?.font_style || 'default'
  const fontFamily = FONTS[fontKey] || FONTS.default
  const fontImport = FONT_IMPORTS[fontKey] || ''
  const themeCss = fontImport + `:root {
    --gold: ${accent};
    --font-b: ${fontFamily};
    --font-d: ${fontFamily};
  }
  body, button, input, select, textarea { font-family: ${fontFamily} !important; }
  h1, h2, h3, .pt, .kpi-v, .logo-name, .modal-t, .price-tag, .loading { font-family: ${fontFamily} !important; }
  .ni.active { background: ${accent}14; color: ${accent}; border-color: ${accent}33; }
  .btn-p { background: ${accent}; }
  .btn-p:hover { background: ${accent}cc; }
  a { color: ${accent}; }
  .logo-name { color: ${accent}; }
  `
  const bgApproved = bgStatus?.status === 'approved'
  const { user, logout } = useAuth()
  const navigate = useNavigate()
  return (
    <div className="shell">
      <style dangerouslySetInnerHTML={{__html: themeCss}} />
      <aside className="sidebar">
        <div className="logo">
          <div className="logo-name">⚡ GAM Tenant</div>
          <div className="logo-sub">Gold Asset Management</div>
        </div>
        <nav className="nav">
          <NavLink to="/background-check" className={({isActive})=>`ni${isActive?' active':''}`}>🛡 Application</NavLink>
          <NavLink to="/notifications" className={({isActive})=>`ni${isActive?' active':''}`}>🔔 Notifications</NavLink>
          {bgApproved && <>
            <NavLink to="/home" className={({isActive})=>`ni${isActive?' active':''}`}>🏠 Home</NavLink>
            <NavLink to="/payments" className={({isActive})=>`ni${isActive?' active':''}`}>💳 Payments</NavLink>
            <NavLink to="/maintenance" className={({isActive})=>`ni${isActive?' active':''}`}>🔧 Maintenance</NavLink>
            <LeaseNavLink/>
            <NavLink to="/services" className={({isActive})=>`ni${isActive?' active':''}`}>⭐ Services</NavLink>
            <NavLink to="/profile" className={({isActive})=>`ni${isActive?' active':''}`}>👤 Profile</NavLink>
          </>}
        </nav>
        <div className="footer">
          <div style={{padding:'8px 10px',marginBottom:4}}>
            <div style={{fontWeight:600,color:'var(--t0)',fontSize:'.82rem'}}>{user?.firstName} {user?.lastName}</div>
            <div style={{fontSize:'.7rem',color:'var(--t3)'}}>{user?.email}</div>
          </div>
          <button className="ni" onClick={()=>{logout();navigate('/login')}} style={{color:'var(--red)'}}>🚪 Sign out</button>
        </div>
      </aside>
      <div className="main">
        <header className="topbar" />
        <div className="page"><Outlet /></div>
      </div>
    </div>
  )
}

// ── HOME PAGE ─────────────────────────────────────────────────
function HomePage() {
  const { user } = useAuth()
  const { data: me } = useQuery('tenant-me', () => get<any>('/tenants/me'))

  return (
    <div>
      <div className="ph">
        <div>
          <h1 className="pt">Hi, {user?.firstName} 👋</h1>
          <p className="ps">{me?.property_name} · Unit {me?.unit_number}</p>
        </div>
        {me?.on_time_pay_enrolled && <span className="badge b-gold">⚡ On-Time Pay Active</span>}
      </div>

      {me?.on_time_pay_enrolled && (
        <div className="alert a-gold" style={{marginBottom:24}}>
          ⚡ <div><strong>On-Time Pay is active.</strong> Your rent of {formatCurrency(me.rent_amount)} is guaranteed to your landlord on the 1st. Your payment is scheduled for the {me.income_arrival_day}th. $20/month service fee applies.</div>
        </div>
      )}

      <div className="grid3" style={{marginBottom:24}}>
        <div className="kpi">
          <div className="kpi-l">Monthly Rent</div>
          <div className="kpi-v" style={{color:'var(--gold)'}}>{me?.rent_amount ? formatCurrency(me.rent_amount) : '—'}</div>
          <div className="kpi-s">Due 1st of month</div>
        </div>
        <div className="kpi">
          <div className="kpi-l">Unit Status</div>
          <div className="kpi-v" style={{fontSize:'1.1rem',marginTop:4}}>
            <span className={`badge ${me?.unit_status==='active'?'b-green':me?.unit_status==='delinquent'?'b-amber':'b-muted'}`}>{me?.unit_status||'—'}</span>
          </div>
          <div className="kpi-s">{me?.property_name}</div>
        </div>
        <div className="kpi">
          <div className="kpi-l">Security Deposit</div>
          <div className="kpi-v">{me?.security_deposit ? formatCurrency(me.security_deposit) : '—'}</div>
          <div className="kpi-s">{me?.flex_deposit_enrolled ? 'FlexDeposit installments' : 'Paid in full'}</div>
        </div>
      </div>

      <div className="grid2">
        <div className="card">
          <h3 style={{marginBottom:16}}>Lease Details</h3>
          <div className="dr"><span className="dk">Address</span><span className="dv">{me?.street1}</span></div>
          <div className="dr"><span className="dk">City</span><span className="dv">{me?.city}, {me?.state}</span></div>
          <div className="dr"><span className="dk">Unit</span><span className="dv mono">{me?.unit_number}</span></div>
          <div className="dr"><span className="dk">Rent</span><span className="dv mono">{me?.rent_amount ? formatCurrency(me.rent_amount) : '—'}/mo</span></div>
          <div className="dr"><span className="dk">ACH</span><span className={`badge ${me?.ach_verified?'b-green':'b-amber'}`}>{me?.ach_verified?'Verified':'Pending'}</span></div>
        </div>
        <div className="card">
          <h3 style={{marginBottom:16}}>Your Subscriptions</h3>
          <div className="dr"><span className="dk">Credit Reporting</span><span className={`badge ${me?.credit_reporting_enrolled?'b-green':'b-muted'}`}>{me?.credit_reporting_enrolled?'Active — $5/mo':'Not enrolled'}</span></div>
          <div className="dr"><span className="dk">FlexDeposit</span><span className={`badge ${me?.flex_deposit_enrolled?'b-green':'b-muted'}`}>{me?.flex_deposit_enrolled?'Active — $3/mo':'Not enrolled'}</span></div>
          <div className="dr"><span className="dk">On-Time Pay</span><span className={`badge ${me?.on_time_pay_enrolled?'b-gold':'b-muted'}`}>{me?.on_time_pay_enrolled?'Active — $20/mo':'Not enrolled'}</span></div>
          <div style={{marginTop:16}}>
            <a href="/services" className="btn btn-g btn-sm" style={{textDecoration:'none'}}>Manage services →</a>
          </div>
        </div>
      </div>
    </div>
  )
}

// ── PAYMENTS PAGE ─────────────────────────────────────────────
function PaymentsPage() {
  const { data: payments = [], isLoading } = useQuery<any[]>('payments', () => get('/tenants/payments'))
  const ST: Record<string,string> = { settled:'b-green', pending:'b-amber', failed:'b-red', processing:'b-gold' }

  return (
    <div>
      <div className="ph"><div><h1 className="pt">Payments</h1><p className="ps">Your rent and fee history</p></div></div>
      <div className="card" style={{padding:0}}>
        {isLoading ? <div style={{padding:32,color:'var(--t3)',textAlign:'center'}}>Loading…</div> : (
          <table className="tbl">
            <thead><tr><th>Due</th><th>Type</th><th>Amount</th><th>Status</th><th>Method</th></tr></thead>
            <tbody>
              {payments.length ? payments.map((p:any) => (
                <tr key={p.id}>
                  <td className="mono" style={{fontSize:'.75rem'}}>{new Date(p.due_date).toLocaleDateString()}</td>
                  <td><span className="badge b-muted">{p.type.replace('_',' ')}</span></td>
                  <td className="mono" style={{color:'var(--t0)',fontWeight:600}}>{formatCurrency(p.amount)}</td>
                  <td><span className={`badge ${ST[p.status]||'b-muted'}`}>{p.status}</span></td>
                  <td style={{fontSize:'.75rem',color:'var(--t3)'}}>{p.entry_description}</td>
                </tr>
              )) : <tr><td colSpan={5} style={{textAlign:'center',color:'var(--t3)',padding:32}}>No payment history yet.</td></tr>}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}


// ── ACH VERIFY FORM ───────────────────────────────────────────────────────
function AchVerifyForm({ onSuccess }: { onSuccess: () => void }) {
  const [bankName, setBankName] = useState('')
  const [last4, setLast4] = useState('')
  const [error, setError] = useState('')

  const mut = useMutation(
    () => fetch((import.meta as any).env?.VITE_API_URL + '/api/tenants/verify-ach', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + localStorage.getItem('gam_tenant_token') },
      body: JSON.stringify({ bankName, last4 })
    }).then(r => r.json()),
    {
      onSuccess: (data) => {
        if (!data.success) { setError(data.error || 'Verification failed'); return }
        onSuccess()
      },
      onError: () => setError('Verification failed. Please try again.')
    }
  )

  return (
    <div style={{display:'flex',flexDirection:'column',gap:12,maxWidth:400}}>
      {error && <div className="alert a-warn">{error}</div>}
      <div className="fg">
        <label className="fl">Bank Name</label>
        <input className="fi" value={bankName} onChange={e=>setBankName(e.target.value)} placeholder="e.g. Chase, Bank of America" />
      </div>
      <div className="fg">
        <label className="fl">Last 4 digits of account number</label>
        <input className="fi" value={last4} onChange={e=>setLast4(e.target.value.replace(/D/g,'').slice(0,4))} placeholder="1234" maxLength={4} style={{maxWidth:120,fontFamily:'var(--font-m)'}} />
      </div>
      <button className="btn btn-p" disabled={mut.isLoading || last4.length !== 4} onClick={()=>mut.mutate()}>
        {mut.isLoading ? <span className="spinner"/> : '✓ Verify Bank Account'}
      </button>
      <p style={{fontSize:'.72rem',color:'var(--t3)'}}>This connects your bank account for automated rent collection via ACH.</p>
    </div>
  )
}


// ── FLEXPAY ENROLL MODAL ──────────────────────────────────────────────────
const FLEXPAY_TIERS = [
  { tier:'early',    days:'1st – 5th',   fee:3,  label:'Early',    desc:'Best rate — income arrives early in month' },
  { tier:'standard', days:'6th – 15th',  fee:7,  label:'Standard', desc:'Most common — mid-month income' },
  { tier:'extended', days:'16th – 25th', fee:12, label:'Extended', desc:'Late month — highest float period' },
  { tier:'variable', days:'Variable',    fee:10, label:'SSI/SSDI', desc:'3rd Wednesday etc — fixed pattern income' },
]

const WEEK_PATTERNS = [
  { value:'1st-monday',    label:'1st Monday' },
  { value:'1st-wednesday', label:'1st Wednesday' },
  { value:'2nd-wednesday', label:'2nd Wednesday' },
  { value:'3rd-wednesday', label:'3rd Wednesday (SSI)' },
  { value:'4th-wednesday', label:'4th Wednesday' },
  { value:'1st-friday',    label:'1st Friday' },
  { value:'2nd-friday',    label:'2nd Friday' },
  { value:'3rd-friday',    label:'3rd Friday' },
  { value:'4th-friday',    label:'4th Friday' },
]

function FlexPayModal({ onClose, onSuccess }: { onClose: () => void; onSuccess: () => void }) {
  const [pullType, setPullType] = useState<'specific'|'variable'>('specific')
  const [pullDay, setPullDay] = useState(15)
  const [pullPattern, setPullPattern] = useState('3rd-wednesday')
  const [error, setError] = useState('')

  const selectedTier = pullType === 'variable'
    ? FLEXPAY_TIERS.find(t => t.tier === 'variable')!
    : pullDay <= 5 ? FLEXPAY_TIERS[0]
    : pullDay <= 15 ? FLEXPAY_TIERS[1]
    : FLEXPAY_TIERS[2]

  const mut = useMutation(
    () => fetch((import.meta as any).env?.VITE_API_URL + '/api/tenants/flexpay/enroll', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + localStorage.getItem('gam_tenant_token') },
      body: JSON.stringify(pullType === 'variable' ? { pullPattern } : { pullDay })
    }).then(r => r.json()),
    {
      onSuccess: (data) => {
        if (!data.success) { setError(data.error || 'Enrollment failed'); return }
        onSuccess()
      },
      onError: () => setError('Enrollment failed. Please try again.')
    }
  )

  return (
    <div className="modal-ov" onClick={onClose}>
      <div className="modal" onClick={e=>e.stopPropagation()} style={{maxWidth:520}}>
        <div className="modal-t">⚡ Enroll in FlexPay</div>
        <p style={{fontSize:'.82rem',color:'var(--t2)',marginBottom:20}}>Choose when your rent is pulled each month. Your landlord always receives payment on the 1st.</p>

        <div style={{display:'flex',gap:8,marginBottom:20}}>
          <button onClick={()=>setPullType('specific')}
            style={{flex:1,padding:'10px',borderRadius:8,border:pullType==='specific'?'2px solid var(--gold)':'1px solid var(--b1)',background:pullType==='specific'?'rgba(201,162,39,.08)':'var(--bg3)',cursor:'pointer',color:pullType==='specific'?'var(--gold)':'var(--t2)',fontWeight:600,fontSize:'.82rem'}}>
            📅 Specific Date
          </button>
          <button onClick={()=>setPullType('variable')}
            style={{flex:1,padding:'10px',borderRadius:8,border:pullType==='variable'?'2px solid var(--gold)':'1px solid var(--b1)',background:pullType==='variable'?'rgba(201,162,39,.08)':'var(--bg3)',cursor:'pointer',color:pullType==='variable'?'var(--gold)':'var(--t2)',fontWeight:600,fontSize:'.82rem'}}>
            🔄 Variable Date (SSI/SSDI)
          </button>
        </div>

        {pullType === 'specific' ? (
          <div className="fg">
            <label className="fl">Pull day of month</label>
            <div style={{display:'flex',alignItems:'center',gap:12}}>
              <input type="range" min={1} max={25} value={pullDay} onChange={e=>setPullDay(parseInt(e.target.value))}
                style={{flex:1,accentColor:'var(--gold)'}} />
              <span style={{fontFamily:'var(--font-m)',fontSize:'1.2rem',fontWeight:800,color:'var(--t0)',minWidth:32,textAlign:'center'}}>{pullDay}</span>
            </div>
            <div style={{fontSize:'.72rem',color:'var(--t3)',marginTop:4}}>Day {pullDay} of each month</div>
          </div>
        ) : (
          <div className="fg">
            <label className="fl">Income pattern</label>
            <select className="fs" value={pullPattern} onChange={e=>setPullPattern(e.target.value)}>
              {WEEK_PATTERNS.map(p => <option key={p.value} value={p.value}>{p.label}</option>)}
            </select>
          </div>
        )}

        <div style={{background:'var(--bg3)',borderRadius:10,padding:16,marginBottom:16}}>
          <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:8}}>
            <span style={{fontWeight:700,color:'var(--t0)',fontSize:'.875rem'}}>{selectedTier?.label} Tier</span>
            <span style={{fontFamily:'var(--font-m)',fontSize:'1.2rem',fontWeight:800,color:'var(--gold)'}}>${selectedTier?.fee}/mo</span>
          </div>
          <div style={{fontSize:'.75rem',color:'var(--t3)'}}>{selectedTier?.desc}</div>
          <div style={{marginTop:10,display:'flex',gap:6}}>
            {FLEXPAY_TIERS.filter(t=>t.tier!=='variable').map(t=>(
              <div key={t.tier} style={{flex:1,padding:'6px 4px',borderRadius:6,background:selectedTier?.tier===t.tier?'rgba(201,162,39,.12)':'var(--bg4)',border:selectedTier?.tier===t.tier?'1px solid rgba(201,162,39,.3)':'1px solid var(--b1)',textAlign:'center'}}>
                <div style={{fontSize:'.65rem',color:selectedTier?.tier===t.tier?'var(--gold)':'var(--t3)',fontWeight:600}}>{t.label}</div>
                <div style={{fontSize:'.72rem',color:'var(--t0)',fontWeight:700}}>${t.fee}/mo</div>
              </div>
            ))}
          </div>
        </div>

        {error && <div className="alert a-warn" style={{marginBottom:12}}>{error}</div>}

        <div style={{fontSize:'.72rem',color:'var(--t3)',marginBottom:16}}>
          ⓘ FlexPay is a payment scheduling service. Your ACH will be pulled on your chosen date. If the pull fails, one retry occurs 2 business days later. Second failure suspends FlexPay for 60 days.
        </div>

        <div className="modal-f">
          <button className="btn btn-g" onClick={onClose}>Cancel</button>
          <button className="btn btn-p" disabled={mut.isLoading} onClick={()=>mut.mutate()}>
            {mut.isLoading ? <span className="spinner"/> : `Enroll — ${selectedTier?.fee}/month`}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── SERVICES PAGE ─────────────────────────────────────────────
function ServicesPage() {
  const qc2 = useQuery('tenant-me', () => get<any>('/tenants/me'))
  const me = qc2.data
  const [otpModal, setOtpModal] = useState(false)
  const [flexPayModal, setFlexPayModal] = useState(false)
  const [incomeDay, setIncomeDay] = useState(15)
  const [enrolling, setEnrolling] = useState<string|null>(null)

  const creditMut = useMutation(() => post('/tenants/enroll-credit-reporting'), { onSuccess: () => qc2.refetch() })
  const otpMut = useMutation(() => post('/tenants/enroll-on-time-pay', { incomeArrivalDay: incomeDay }), {
    onSuccess: () => { qc2.refetch(); setOtpModal(false) }
  })

  const services = [
    {
      id: 'credit',
      name: 'FlexCredit',
      desc: 'Report your on-time rent payments to all 3 bureaus — Experian, TransUnion & Equifax. Build credit just by paying rent.',
      price: '$5/month',
      enrolled: me?.credit_reporting_enrolled,
      action: () => creditMut.mutate(),
      loading: creditMut.isLoading,
      highlight: '30% of tenants build 40+ credit score points in year 1',
    },
    {
      id: 'otp',
      name: 'FlexPay Float',
      desc: 'Your landlord gets paid on the 1st regardless of when your income arrives. No late fees, ever.',
      price: 'Covered by landlord',
      enrolled: me?.on_time_pay_enrolled,
      action: () => me?.deposit_fully_funded && me?.ach_verified ? setOtpModal(true) : null,
      loading: otpMut.isLoading,
      highlight: me?.on_time_pay_enrolled ? undefined
        : !me?.deposit_fully_funded ? '⚠ Deposit must be fully funded to qualify'
        : !me?.ach_verified ? '⚠ Bank account must be verified to qualify'
        : 'You qualify for On-Time Pay!',
      locked: !me?.deposit_fully_funded || !me?.ach_verified,
    },
    {
      id: 'flexpay',
      name: 'FlexPay',
      desc: 'Choose your own rent payment date. Your landlord gets paid on the 1st — you pay when your income arrives.',
      price: '$3–$12/month',
      enrolled: me?.flexpay_enrolled,
      action: () => setFlexPayModal(true),
      loading: false,
      highlight: me?.flexpay_enrolled
        ? `${me.flexpay_pull_pattern || 'Day '+me.flexpay_pull_day} · ${me.flexpay_fee}/mo`
        : !me?.deposit_fully_funded ? '⚠ Deposit must be funded first'
        : !me?.ach_verified ? '⚠ Bank account must be verified first'
        : 'Choose your pull date — tiered pricing',
      locked: !me?.deposit_fully_funded || !me?.ach_verified,
    },
    {
      id: 'flexdeposit',
      name: 'FlexDeposit',
      desc: 'Split your security deposit into 2–6 monthly installments. No credit check. Everyone approved.',
      price: '$3/month custody fee',
      enrolled: me?.flex_deposit_enrolled,
      action: () => {},
      loading: false,
      highlight: me?.security_deposit ? `Your deposit: ${formatCurrency(me.security_deposit)} · ${getFlexDepositTier(me.security_deposit)?.installments} payments of ${formatCurrency(me.security_deposit / (getFlexDepositTier(me.security_deposit)?.installments||1))}` : undefined,
    },
  ]

  return (
    <div>
      <div className="ph">
        <div><h1 className="pt">Services</h1><p className="ps">All services are voluntary. No mandatory fees.</p></div>
      </div>
      <div className="alert a-blue" style={{marginBottom:24}}>
        ℹ️ None of these services are required as a condition of your tenancy. Subscribe only if they benefit you.
      </div>
      <div className="grid3">
        {services.map(s => (
          <div key={s.id} className={`service-card${s.enrolled?' enrolled':''}`}>
            <div>
              <div style={{fontFamily:'var(--font-d)',fontWeight:700,fontSize:'1rem',color:'var(--t0)',marginBottom:6}}>{s.name}</div>
              <div style={{fontSize:'.82rem',color:'var(--t2)',lineHeight:1.5}}>{s.desc}</div>
            </div>
            {s.highlight && <div style={{fontSize:'.75rem',color:'var(--t3)',background:'var(--bg4)',padding:'6px 10px',borderRadius:6}}>{s.highlight}</div>}
            <div className="dr" style={{border:'none',padding:0}}>
              <span className="price-tag">{s.price}</span>
              {s.enrolled
                ? <span className="badge b-green">✓ Active</span>
                : (s as any).locked
                ? <span className="badge b-muted">🔒 Locked</span>
                : <button className="btn btn-p btn-sm" onClick={s.action} disabled={s.loading}>{s.loading?<span className="spinner"/>:'Enroll'}</button>}
            </div>
          </div>
        ))}
      </div>


      {/* ── ACH Verification ─────────────────────────────────────── */}
      {!me?.ach_verified && (
        <div className="card" style={{marginTop:24}}>
          <h3 style={{marginBottom:4}}>🏦 Bank Account Verification</h3>
          <p style={{fontSize:'.82rem',color:'var(--t3)',marginBottom:16}}>
            {me?.deposit_fully_funded
              ? 'Verify your bank account to unlock On-Time Pay.'
              : 'Your security deposit must be fully funded before you can verify your bank account.'}
          </p>
          {!me?.deposit_fully_funded ? (
            <div className="alert a-warn">⚠ Complete your security deposit payment first.</div>
          ) : (
            <AchVerifyForm onSuccess={()=>qc2.refetch()} />
          )}
        </div>
      )}

      {/* ── OTP Qualification Status ──────────────────────────────── */}
      {me?.ach_verified && (
        <div className="card" style={{marginTop:24}}>
          <h3 style={{marginBottom:12}}>⚡ On-Time Pay Status</h3>
          <div style={{display:'flex',flexDirection:'column',gap:10}}>
            <div style={{display:'flex',alignItems:'center',gap:10,fontSize:'.82rem'}}>
              <span style={{width:20,height:20,borderRadius:'50%',background:me?.deposit_fully_funded?'var(--green)':'var(--bg4)',display:'flex',alignItems:'center',justifyContent:'center',fontSize:'.65rem',flexShrink:0}}>{me?.deposit_fully_funded?'✓':'1'}</span>
              <span style={{color:me?.deposit_fully_funded?'var(--t0)':'var(--t3)'}}>Security deposit fully funded</span>
            </div>
            <div style={{display:'flex',alignItems:'center',gap:10,fontSize:'.82rem'}}>
              <span style={{width:20,height:20,borderRadius:'50%',background:me?.ach_verified?'var(--green)':'var(--bg4)',display:'flex',alignItems:'center',justifyContent:'center',fontSize:'.65rem',flexShrink:0}}>{me?.ach_verified?'✓':'2'}</span>
              <span style={{color:me?.ach_verified?'var(--t0)':'var(--t3)'}}>Bank account verified {me?.bank_last4?'(••••'+me.bank_last4+')':''}</span>
            </div>
            <div style={{display:'flex',alignItems:'center',gap:10,fontSize:'.82rem'}}>
              <span style={{width:20,height:20,borderRadius:'50%',background:me?.on_time_pay_enrolled?'var(--gold)':'var(--bg4)',display:'flex',alignItems:'center',justifyContent:'center',fontSize:'.65rem',flexShrink:0}}>{me?.on_time_pay_enrolled?'✓':'3'}</span>
              <span style={{color:me?.on_time_pay_enrolled?'var(--gold)':'var(--t3)'}}>On-Time Pay enrolled</span>
            </div>
          </div>
          {me?.otp_qualified_at && (
            <div className="alert a-green" style={{marginTop:16}}>
              ✓ OTP qualified since {new Date(me.otp_qualified_at).toLocaleDateString()}. You'll be included in the next disbursement cycle.
            </div>
          )}
        </div>
      )}

      {otpModal && (
        <div className="modal-ov" onClick={() => setOtpModal(false)}>
          <div className="modal" onClick={e=>e.stopPropagation()}>
            <div className="modal-t">⚡ Enroll in On-Time Pay</div>
            <p style={{fontSize:'.875rem',color:'var(--t2)',marginBottom:20}}>Tell us what day of the month your income arrives. Your rent will be automatically collected on that day — your landlord gets paid on the 1st. $20/month service fee applies.</p>
            <div className="fg">
              <label className="fl">Income arrives on the</label>
              <input className="fi" type="number" min={1} max={28} value={incomeDay}
                onChange={e=>setIncomeDay(parseInt(e.target.value))} style={{maxWidth:120}} />
              <span style={{marginLeft:8,fontSize:'.875rem',color:'var(--t3)'}}>th of each month</span>
            </div>
            <div style={{background:'var(--bg3)',borderRadius:8,padding:12,fontSize:'.82rem',color:'var(--t2)',marginBottom:16}}>
              <strong style={{color:'var(--t0)'}}>Not a loan.</strong> This is a payment timing service. You still owe rent to your landlord — we just collect it on your income date instead of the 1st. The $20 service fee replaces late fees ($30–55/month) for most tenants.
            </div>
            <div className="modal-f">
              <button className="btn btn-g" onClick={()=>setOtpModal(false)}>Cancel</button>
              <button className="btn btn-p" onClick={()=>otpMut.mutate()} disabled={otpMut.isLoading}>{otpMut.isLoading?<span className="spinner"/>:'Enroll — $20/month'}</button>
            </div>
          </div>
        </div>
      )}
    {flexPayModal && (
        <FlexPayModal
          onClose={() => setFlexPayModal(false)}
          onSuccess={() => { qc2.refetch(); setFlexPayModal(false) }}
        />
      )}
    </div>
  )
}

// ── MAINTENANCE PAGE ──────────────────────────────────────────
function MaintenancePage() {
  const { data: me } = useQuery('tenant-me', () => get<any>('/tenants/me'))
  const { data: reqs = [], isLoading } = useQuery<any[]>('maint', () => get('/maintenance'))
  const [showAdd, setShowAdd] = useState(false)
  const { register, handleSubmit, reset } = useForm<any>()
  const addMut = useMutation(
    (d:any) => post('/maintenance', { ...d, unitId: me?.unit_id }),
    { onSuccess: () => { useQuery('maint'); setShowAdd(false); reset() } }
  )
  const PRI: Record<string,string> = { emergency:'b-red',high:'b-amber',normal:'b-gold',low:'b-muted' }
  const ST: Record<string,string> = { open:'b-amber',assigned:'b-gold',in_progress:'b-gold',completed:'b-green',cancelled:'b-muted' }

  return (
    <div>
      <div className="ph">
        <div><h1 className="pt">Maintenance</h1><p className="ps">Submit and track repair requests</p></div>
        <button className="btn btn-p" onClick={()=>setShowAdd(true)}>+ New request</button>
      </div>
      <div className="card" style={{padding:0}}>
        {isLoading ? <div style={{padding:32,color:'var(--t3)',textAlign:'center'}}>Loading…</div> : (
          <table className="tbl">
            <thead><tr><th>Date</th><th>Title</th><th>Priority</th><th>Status</th><th>Contractor</th></tr></thead>
            <tbody>
              {reqs.length ? reqs.map((r:any)=>(
                <tr key={r.id}>
                  <td className="mono" style={{fontSize:'.75rem'}}>{new Date(r.created_at).toLocaleDateString()}</td>
                  <td style={{color:'var(--t0)'}}>{r.title}</td>
                  <td><span className={`badge ${PRI[r.priority]}`}>{r.priority}</span></td>
                  <td><span className={`badge ${ST[r.status]}`}>{r.status.replace('_',' ')}</span></td>
                  <td style={{fontSize:'.82rem',color:'var(--t3)'}}>{r.contractor_name||'Unassigned'}</td>
                </tr>
              )) : <tr><td colSpan={5} style={{textAlign:'center',color:'var(--t3)',padding:32}}>No maintenance requests yet.</td></tr>}
            </tbody>
          </table>
        )}
      </div>
      {showAdd && (
        <div className="modal-ov" onClick={()=>setShowAdd(false)}>
          <div className="modal" onClick={e=>e.stopPropagation()}>
            <div className="modal-t">Submit Maintenance Request</div>
            <form onSubmit={handleSubmit(d=>addMut.mutate(d))}>
              <div className="fg"><label className="fl">What's the issue?</label><input className="fi" {...register('title',{required:true})} placeholder="e.g. Faucet leaking in kitchen" /></div>
              <div className="fg"><label className="fl">Description</label><textarea className="fta" {...register('description',{required:true})} placeholder="Describe the issue in detail…" /></div>
              <div className="fg"><label className="fl">Priority</label>
                <select className="fs" {...register('priority')}>
                  <option value="normal">Normal</option><option value="high">High</option>
                  <option value="emergency">Emergency</option><option value="low">Low</option>
                </select>
              </div>
              <div className="modal-f">
                <button type="button" className="btn btn-g" onClick={()=>setShowAdd(false)}>Cancel</button>
                <button type="submit" className="btn btn-p" disabled={addMut.isLoading}>{addMut.isLoading?<span className="spinner"/>:'Submit'}</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}

// ── DOCUMENTS + UTILITIES (stubs) ─────────────────────────────
function DocumentsPage() {
  const { data: docs = [], isLoading } = useQuery<any[]>('docs', () => get('/documents'))
  return (
    <div>
      <div className="ph"><div><h1 className="pt">Documents</h1><p className="ps">Your lease and agreements</p></div></div>
      <div className="card" style={{padding:0}}>
        {isLoading ? <div style={{padding:32,color:'var(--t3)',textAlign:'center'}}>Loading…</div> : (
          <table className="tbl">
            <thead><tr><th>Document</th><th>Type</th><th>Signed</th><th>Date</th><th></th></tr></thead>
            <tbody>
              {docs.length ? docs.map((d:any)=>(
                <tr key={d.id}>
                  <td style={{color:'var(--t0)'}}>{d.name}</td>
                  <td><span className="badge b-muted">{d.type.replace('_',' ')}</span></td>
                  <td><span className={`badge ${d.signed_at?'b-green':'b-amber'}`}>{d.signed_at?'Signed':'Pending signature'}</span></td>
                  <td className="mono" style={{fontSize:'.75rem',color:'var(--t3)'}}>{new Date(d.created_at).toLocaleDateString()}</td>
                  <td><a href={d.url} target="_blank" rel="noreferrer" className="btn btn-g btn-sm">Download</a></td>
                </tr>
              )) : <tr><td colSpan={5} style={{textAlign:'center',color:'var(--t3)',padding:32}}>No documents yet.</td></tr>}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}

function UtilitiesPage() {
  const { data: bills = [], isLoading } = useQuery<any[]>('util', () => get('/utility/bills'))
  return (
    <div>
      <div className="ph"><div><h1 className="pt">Utilities</h1><p className="ps">Sub-metered utility bills</p></div></div>
      <div className="alert a-blue">ℹ️ Bills include actual utility cost + admin fee only. Separate ACH pull on the 15th. Not covered by On-Time Pay SLA.</div>
      <div className="card" style={{padding:0}}>
        {isLoading ? <div style={{padding:32,color:'var(--t3)',textAlign:'center'}}>Loading…</div> : (
          <table className="tbl">
            <thead><tr><th>Billed</th><th>Utility</th><th>Usage</th><th>Utility Cost</th><th>Admin Fee</th><th>Total</th><th>Status</th></tr></thead>
            <tbody>
              {bills.length ? bills.map((b:any)=>(
                <tr key={b.id}>
                  <td className="mono" style={{fontSize:'.75rem'}}>{new Date(b.billed_at).toLocaleDateString()}</td>
                  <td>{b.utility_type}</td>
                  <td className="mono">{b.usage_amount} units</td>
                  <td className="mono">{formatCurrency(b.utility_cost)}</td>
                  <td className="mono" style={{color:'var(--t3)'}}>{formatCurrency(b.admin_fee)}</td>
                  <td className="mono" style={{color:'var(--t0)',fontWeight:600}}>{formatCurrency(b.total_amount)}</td>
                  <td><span className={`badge ${b.status==='settled'?'b-green':'b-amber'}`}>{b.status}</span></td>
                </tr>
              )) : <tr><td colSpan={7} style={{textAlign:'center',color:'var(--t3)',padding:32}}>No utility bills yet.</td></tr>}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}

// ── LOGIN ─────────────────────────────────────────────────────
function LoginPage() {
  const { login } = useAuth(); const navigate = useNavigate()
  const [err, setErr] = useState(''); const [loading, setLoading] = useState(false)
  const { register, handleSubmit } = useForm<{email:string;password:string}>()
  const onSubmit = async(d:{email:string;password:string})=>{
    setLoading(true);setErr('')
    try{await login(d.email,d.password);navigate('/home')}
    catch(e:any){setErr(e.response?.data?.error||'Login failed')}
    finally{setLoading(false)}
  }
  return (
    <div style={{minHeight:'100vh',display:'flex',alignItems:'center',justifyContent:'center',background:'var(--bg0)',padding:20}}>
      <div style={{width:'100%',maxWidth:400}}>
        <div style={{textAlign:'center',marginBottom:40}}>
          <div style={{fontFamily:'var(--font-d)',fontSize:'2rem',fontWeight:800,color:'var(--gold)',marginBottom:8}}>⚡ GAM</div>
          <div style={{color:'var(--t2)',fontSize:'.875rem'}}>Tenant Portal</div>
        </div>
        <div className="card" style={{padding:28}}>
          <h2 style={{marginBottom:20}}>Sign in</h2>
          {err && <div className="alert a-warn" style={{marginBottom:16}}>{err}</div>}
          <form onSubmit={handleSubmit(onSubmit)}>
            <div className="fg"><label className="fl">Email</label><input className="fi" type="email" {...register('email',{required:true})} autoFocus /></div>
            <div className="fg"><label className="fl">Password</label><input className="fi" type="password" {...register('password',{required:true})} /></div>
            <button className="btn btn-p" type="submit" disabled={loading} style={{width:'100%',justifyContent:'center',marginTop:8}}>
              {loading?<span className="spinner"/>:'Sign in'}
            </button>
          </form>
        </div>
      </div>
    </div>
  )
}

// ── APP ───────────────────────────────────────────────────────
function App() {
  const { token, loading } = useAuth()
  if (loading) return <div className="loading">Loading…</div>
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/accept-invite" element={<AcceptInvitePage />} />
        <Route path="/background-check" element={<BackgroundCheckPage />} />
        <Route path="/notifications" element={<TenantNotificationsPage />} />
        <Route path="/" element={token ? <Layout /> : <Navigate to="/login" replace />}>
          <Route index element={<DefaultPage />} />
          <Route path="home"        element={<HomePage />} />
          <Route path="payments"    element={<PaymentsPage />} />
          <Route path="maintenance" element={<MaintenancePage />} />
          <Route path="lease"       element={<LeasePage />} />
          <Route path="sign/:token"  element={<SignPage />} />
          <Route path="services"    element={<ServicesPage />} />
          <Route path="profile"     element={<ProfilePage />} />
        </Route>
      </Routes>
    </BrowserRouter>
  )
}

function Root() {
  return (
    <QueryClientProvider client={qc}>
      <AuthProvider>
        <style dangerouslySetInnerHTML={{__html: css}} />
        <App />
      </AuthProvider>
    </QueryClientProvider>
  )
}

ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><Root /></React.StrictMode>)
