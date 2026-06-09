import { SentryErrorBoundary } from './lib/sentry'
import React, { useContext, useState } from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter, Routes, Route, Navigate, NavLink, Outlet, useNavigate } from 'react-router-dom'
import { QueryClient, QueryClientProvider, useQuery, useMutation, useQueryClient } from 'react-query'
import axios from 'axios'
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts'
import { formatCurrency, getReservePhase, RESERVE_CONFIG, applyCamelizeInterceptor } from '@gam/shared'

const API = (import.meta as any).env?.VITE_API_URL || 'http://localhost:4000'
const BOOKS_URL = (import.meta as any).env?.VITE_BOOKS_APP_URL || 'http://localhost:3006'
const api = axios.create({ baseURL: `${API}/api` })
api.interceptors.request.use(c => { const t=localStorage.getItem('gam_admin_token'); if(t)c.headers.Authorization=`Bearer ${t}`; return c })
api.interceptors.response.use(r=>r, e=>{if(e.response?.status===401&&!e.config.url.includes('/auth/me')&&!e.config.url.includes('/auth/login')){localStorage.removeItem('gam_admin_token');window.location.href='/login'}return Promise.reject(e)})
// S312: snake_case → camelCase response transform (see packages/shared/src/camelize.ts).
applyCamelizeInterceptor(api)
const get=<T,>(url:string)=>{const t=localStorage.getItem('gam_admin_token');if(t)api.defaults.headers.common['Authorization']='Bearer '+t;return api.get<{success:boolean;data:T}>(url).then(r=>r.data.data)}
const post=<T,>(url:string,body?:any)=>api.post<{success:boolean;data:T;message?:string}>(url,body).then(r=>r.data)

interface AuthUser{id:string;email:string;role:string;firstName:string;lastName:string;profileId:string;totpEnabled?:boolean;mustEnrollTotp?:boolean}
// S289: login() returns a discriminated result so LoginPage can branch
// into the TOTP second step when the backend gates on 2FA.
type LoginResult={kind:'success'}|{kind:'totp_required';totpSession:string}
interface AuthCtx{
  user:AuthUser|null
  token:string|null
  loading:boolean
  login:(e:string,p:string)=>Promise<LoginResult>
  loginWithTotp:(totpSession:string,code:string)=>Promise<void>
  refresh:()=>Promise<void>
  logout:()=>void
}
const Ctx=React.createContext<AuthCtx>(null!)
const useAuth=()=>useContext(Ctx)

function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null)
  const [token, setToken] = useState<string | null>(() => localStorage.getItem('gam_admin_token'))
  const [loading, setLoading] = useState(true)

  const logout = React.useCallback(() => {
    localStorage.removeItem('gam_admin_token')
    delete api.defaults.headers.common['Authorization']
    setToken(null)
    setUser(null)
  }, [])

  const refresh = React.useCallback(async () => {
    const t = localStorage.getItem('gam_admin_token')
    if (!t) { setLoading(false); return }
    api.defaults.headers.common['Authorization'] = 'Bearer ' + t
    try {
      const res = await api.get('/auth/me')
      const u = res.data.data
      if (!u || (u.role !== 'admin' && u.role !== 'super_admin')) { logout(); return }
      setUser({
        id: u.id, email: u.email, role: u.role,
        firstName: u.firstName || '', lastName: u.lastName || '',
        profileId: u.profileId || '',
        totpEnabled: !!u.totpEnabled,
        mustEnrollTotp: !!u.mustEnrollTotp,
      })
    } catch { logout() }
    finally { setLoading(false) }
  }, [logout])

  React.useEffect(() => { refresh() }, [refresh])

  // S289: post-credentials login. Returns a discriminated result so
  // LoginPage can pivot into the TOTP second step when 2FA is enabled
  // on the account. Doesn't set user state until the full JWT lands —
  // a totp_session JWT is not a valid auth token.
  const login = async (email: string, password: string): Promise<LoginResult> => {
    const res = await axios.post(API + '/api/auth/login', { email, password })
    const data = res.data.data
    if (data.requiresTotp) {
      return { kind: 'totp_required', totpSession: data.totpSession as string }
    }
    const { token: tk, user: u } = data
    if (!u || (u.role !== 'admin' && u.role !== 'super_admin')) throw new Error('Admin access required')
    localStorage.setItem('gam_admin_token', tk)
    api.defaults.headers.common['Authorization'] = 'Bearer ' + tk
    setUser({
      id: u.id, email: u.email, role: u.role,
      firstName: u.firstName || '', lastName: u.lastName || '',
      profileId: u.profileId || '',
      totpEnabled: !!u.totpEnabled,
      // The login response sets mustEnrollTotp directly. Survives
      // page refresh via /auth/me below.
      mustEnrollTotp: !!u.mustEnrollTotp,
    })
    setToken(tk)
    return { kind: 'success' }
  }

  // S289: TOTP second-step exchange. Trades the short-lived totp_session
  // JWT (from /login) plus a 6-digit token or recovery code for the full
  // session JWT.
  const loginWithTotp = async (totpSession: string, code: string): Promise<void> => {
    const res = await axios.post(API + '/api/auth/totp/verify', { totpSession, code })
    const { token: tk, user: u } = res.data.data
    if (!u || (u.role !== 'admin' && u.role !== 'super_admin')) throw new Error('Admin access required')
    localStorage.setItem('gam_admin_token', tk)
    api.defaults.headers.common['Authorization'] = 'Bearer ' + tk
    // /verify doesn't currently return totpEnabled / mustEnrollTotp on
    // the user payload — fetch them from /me so the layout gate has
    // accurate state. (We just enrolled-and-verified, so the values
    // are TRUE / FALSE respectively; /me confirms.)
    setUser({
      id: u.id, email: u.email, role: u.role,
      firstName: '', lastName: '', profileId: u.profileId || '',
    })
    setToken(tk)
    await refresh()
  }

  return <Ctx.Provider value={{ user, token, loading, login, loginWithTotp, refresh, logout }}>{children}</Ctx.Provider>
}

const qc=new QueryClient({defaultOptions:{queries:{retry:1,staleTime:30000,refetchOnWindowFocus:false}}})

// ── STYLES ────────────────────────────────────────────────────
const css=`
@import url('https://fonts.googleapis.com/css2?family=Syne:wght@600;700;800&family=DM+Sans:wght@300;400;500;600&family=DM+Mono:wght@400;500&display=swap');
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{--bg0:#080a0c;--bg1:#0d1014;--bg2:#121519;--bg3:#181c22;--bg4:#1e2330;
  --b0:#1a1f28;--b1:#222a38;--b2:#2a3547;
  --t0:#eef0f6;--t1:#b8c4d8;--t2:#7a8aaa;--t3:#475060;
  --gold:#c9a227;--green:#22c55e;--red:#ef4444;--amber:#f59e0b;--blue:#3b82f6;--purple:#a855f7;
  --font-d:'Syne',sans-serif;--font-b:'DM Sans',sans-serif;--font-m:'DM Mono',monospace}
html{-webkit-font-smoothing:antialiased}
body{font-family:var(--font-b);background:var(--bg0);color:var(--t1);line-height:1.6;min-height:100vh}
h1,h2,h3,h4{font-family:var(--font-d);color:var(--t0);line-height:1.2}
h1{font-size:1.8rem;font-weight:800}h2{font-size:1.3rem;font-weight:700}h3{font-size:1rem;font-weight:700}
button{cursor:pointer;font-family:var(--font-b)}input,select{font-family:var(--font-b)}
a{color:var(--gold);text-decoration:none}
.shell{display:flex;min-height:100vh}
.sidebar{width:220px;flex-shrink:0;background:var(--bg1);border-right:1px solid var(--b0);position:fixed;top:0;left:0;bottom:0;z-index:50;display:flex;flex-direction:column;overflow-y:auto}
.main{flex:1;margin-left:220px;min-height:100vh;display:flex;flex-direction:column}
.topbar{height:52px;background:var(--bg1);border-bottom:1px solid var(--b0);display:flex;align-items:center;padding:0 24px;position:sticky;top:0;z-index:40;gap:12px}
.page{flex:1;padding:28px;max-width:1600px;width:100%}
.logo{padding:18px;border-bottom:1px solid var(--b0)}
.logo-n{font-family:var(--font-d);font-size:1rem;font-weight:800;color:var(--red)}
.logo-s{font-size:.65rem;color:var(--t3);margin-top:2px;text-transform:uppercase;letter-spacing:.1em}
.nav{padding:10px;flex:1}
.nl{font-size:.62rem;color:var(--t3);text-transform:uppercase;letter-spacing:.12em;padding:10px 8px 4px;font-weight:600}
.ni{display:flex;align-items:center;gap:9px;padding:7px 10px;border-radius:7px;color:var(--t2);font-size:.82rem;font-weight:500;transition:all .12s;width:100%;background:none;border:none;cursor:pointer;text-decoration:none}
.ni:hover{background:var(--bg3);color:var(--t0)}
.ni.active{background:rgba(239,68,68,.08);color:var(--red);border:1px solid rgba(239,68,68,.15)}
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
.kpi::after{content:'';position:absolute;bottom:0;left:0;right:0;height:2px;background:linear-gradient(90deg,var(--gold),transparent);opacity:0.4}
.kl{font-size:.65rem;color:var(--t3);text-transform:uppercase;letter-spacing:.09em;font-weight:600;margin-bottom:6px}
.kv{font-family:var(--font-d);font-size:1.6rem;font-weight:800;color:var(--t0);line-height:1;margin-bottom:4px}
.ks{font-size:.7rem;color:var(--t3)}
.kv.g{color:var(--green)}.kv.r{color:var(--red)}.kv.a{color:var(--amber)}.kv.gold{color:var(--gold)}.kv.b{color:var(--blue)}
.btn{display:inline-flex;align-items:center;gap:6px;padding:7px 14px;border-radius:7px;font-size:.78rem;font-weight:600;border:none;cursor:pointer;transition:all .12s;font-family:var(--font-b);text-decoration:none}
.bp{background:var(--gold);color:#080a0c}.bp:hover{background:#d9af3a}
.bg{background:var(--bg4);color:var(--t1);border:1px solid var(--b2)}.bg:hover{background:var(--bg3)}
.bd{background:rgba(239,68,68,.08);color:var(--red);border:1px solid rgba(239,68,68,.2)}.bd:hover{background:rgba(239,68,68,.14)}
.bsm{padding:4px 9px;font-size:.72rem}
.badge{display:inline-flex;align-items:center;gap:4px;padding:3px 9px;border-radius:20px;font-size:.65rem;font-weight:600;text-transform:uppercase;letter-spacing:.04em}
.bg2{background:rgba(34,197,94,.08);color:var(--green);border:1px solid rgba(34,197,94,.18)}
.ba{background:rgba(245,158,11,.08);color:var(--amber);border:1px solid rgba(245,158,11,.18)}
.br{background:rgba(239,68,68,.08);color:var(--red);border:1px solid rgba(239,68,68,.18)}
.bgold{background:rgba(201,162,39,.08);color:var(--gold);border:1px solid rgba(201,162,39,.18)}
.bmu{background:var(--bg4);color:var(--t3);border:1px solid var(--b1)}
.bb{background:rgba(59,130,246,.08);color:var(--blue);border:1px solid rgba(59,130,246,.18)}
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
.tab:hover{color:var(--t1)}
.tab.on{color:var(--gold);border-bottom-color:var(--gold)}
.nacha-flag{background:rgba(239,68,68,.05);border:1px solid rgba(239,68,68,.2);border-radius:8px;padding:14px;margin-bottom:14px}
@keyframes spin{to{transform:rotate(360deg)}}
`

// ── LAYOUT ────────────────────────────────────────────────────
function Layout(){
  const{user,logout,loading}=useAuth();const navigate=useNavigate()
  const isSuperAdmin=user?.role==='super_admin'
  if(loading||!user)return<div className="loading">Loading…</div>
  return(
    <div className="shell">
      <aside className="sidebar">
        <div className="logo">
          <div className="logo-n">⚠ GAM ADMIN</div>
          <div className="logo-s">Internal Operations</div>
        </div>
        <nav className="nav">
          <div className="nl">Platform</div>
          <NavLink to="/overview" className={({isActive})=>`ni${isActive?' active':''}`}>📊 Overview</NavLink>
          <NavLink to="/onboarding" className={({isActive})=>`ni${isActive?' active':''}`}>🚀 Onboarding</NavLink>
          <NavLink to="/landlords" className={({isActive})=>`ni${isActive?' active':''}`}>🏢 Landlords</NavLink>
          <NavLink to="/tenants" className={({isActive})=>`ni${isActive?' active':''}`}>👤 Tenants</NavLink>
          <NavLink to="/property-reviews" className={({isActive})=>`ni${isActive?' active':''}`}>📋 Property Reviews</NavLink>
          <NavLink to="/units" className={({isActive})=>`ni${isActive?' active':''}`}>🚪 Units</NavLink>
          <div className="nl" style={{marginTop:8}}>Finance</div>
          <NavLink to="/payments" className={({isActive})=>`ni${isActive?' active':''}`}>💳 Payments</NavLink>
          <NavLink to="/disbursements" className={({isActive})=>`ni${isActive?' active':''}`}>💸 Disbursements</NavLink>
          <NavLink to="/connect-accounts" className={({isActive})=>`ni${isActive?' active':''}`}>🔌 Connect Accounts</NavLink>
          {isSuperAdmin&&<NavLink to="/reserve" className={({isActive})=>`ni${isActive?' active':''}`}>🏦 Reserve & Float</NavLink>}
          <div className="nl" style={{marginTop:8}}>Compliance</div>
          {isSuperAdmin&&<NavLink to="/nacha" className={({isActive})=>`ni${isActive?' active':''}`}>⚡ NACHA Monitor</NavLink>}
          {isSuperAdmin&&<NavLink to="/audit-log" className={({isActive})=>`ni${isActive?' active':''}`}>🧾 Admin Audit</NavLink>}
          <NavLink to="/csv-imports" className={({isActive})=>`ni${isActive?' active':''}`}>📥 CSV Imports</NavLink>
          <NavLink to="/disputes" className={({isActive})=>`ni${isActive?' active':''}`}>⚖️ Credit Disputes</NavLink>
          <NavLink to="/subleases" className={({isActive})=>`ni${isActive?' active':''}`}>🔁 Subleases</NavLink>
          <NavLink to="/deposit-portability" className={({isActive})=>`ni${isActive?' active':''}`}>💰 Deposit Portability</NavLink>
          {isSuperAdmin&&<NavLink to="/system-features" className={({isActive})=>`ni${isActive?' active':''}`}>🚦 System Features</NavLink>}
          <div className="nl" style={{marginTop:8}}>Community</div>
          {isSuperAdmin&&<NavLink to="/bulletin" className={({isActive})=>`ni${isActive?' active':''}`}>📋 Bulletin Board</NavLink>}
          <div className="nl" style={{marginTop:8}}>Tools</div>
          {isSuperAdmin&&<button className="ni" onClick={()=>{const t=localStorage.getItem('gam_admin_token');window.open(BOOKS_URL+(t?'?token='+t:''),'_blank')}}>📒 GAM Books</button>}

          <div className="nl" style={{marginTop:8}}>Account</div>
          <NavLink to="/security" className={({isActive})=>`ni${isActive?' active':''}`}>🔐 Security</NavLink>
        </nav>
        <div className="sfooter">
          <div style={{padding:'6px 10px',marginBottom:4}}>
            <div style={{fontWeight:600,color:'var(--t0)',fontSize:'.78rem'}}>{user?.firstName} {user?.lastName}</div>
            <div style={{fontSize:'.65rem',color:'var(--t3)'}}>Admin</div>
          </div>
          <button className="ni" onClick={()=>{logout();navigate('/login')}} style={{color:'var(--red)'}}>🚪 Sign out</button>
        </div>
      </aside>
      <div className="main">
        <header className="topbar">
          <span style={{fontSize:'.72rem',color:'var(--t3)',fontFamily:'var(--font-m)'}}>Gold Asset Management — Admin Console</span>
        </header>
        <div className="page"><Outlet /></div>
      </div>
    </div>
  )
}

// ── OVERVIEW ──────────────────────────────────────────────────
function AdminOnboardingOverview(){
  const{user}=useAuth()
  const{data:stats}=useQuery('onboarding-overview',()=>get<any>('/admin/onboarding/overview'),{enabled:!!user,staleTime:30000,refetchOnWindowFocus:false})
  const{data:tenants=[],isLoading:tLoading}=useQuery<any[]>('admin-tenants',()=>get('/admin/tenants'),{enabled:!!user,staleTime:30000,refetchOnWindowFocus:false})
  const{data:landlords=[],isLoading:lLoading}=useQuery<any[]>('onboarding-landlords',()=>get('/landlords'),{enabled:!!user,staleTime:30000,refetchOnWindowFocus:false})
  const[selectedLandlord,setSelectedLandlord]=React.useState<any>(null)
  const[selectedTenant,setSelectedTenant]=React.useState<any>(null)
  const{data:landlordDetail}=useQuery(['landlord-detail',selectedLandlord?.id],()=>get<any>('/admin/onboarding/landlord/'+selectedLandlord.id),{enabled:!!selectedLandlord?.id,staleTime:15000})
  const{data:tenantDetail}=useQuery(['tenant-detail',selectedTenant?.id],()=>get<any>('/admin/onboarding/tenant/'+selectedTenant.id),{enabled:!!selectedTenant?.id,staleTime:15000})
  const[resending,setResending]=React.useState<string|null>(null)
  const[resendMsg,setResendMsg]=React.useState('')
  const[tab,setTab]=React.useState<'landlords'|'tenants'>('landlords')

  const resend=async(type:string,targetId:string)=>{
    setResending(type+targetId)
    try{
      await post('/admin/onboarding/resend',{type,targetId})
      setResendMsg('Notification queued successfully')
      setTimeout(()=>setResendMsg(''),3000)
    }catch(e:any){setResendMsg('Failed: '+e.message)}
    finally{setResending(null)}
  }

  return(
    <div>
      <div className="ph">
        <div><h1 className="pt">Onboarding Console</h1><p className="ps">Help landlords and tenants complete setup</p></div>
      </div>

      {resendMsg&&<div className={`alert ${resendMsg.startsWith('Failed')?'ae':'ag'}`} style={{marginBottom:12}}>{resendMsg}</div>}

      <div className="grid4" style={{marginBottom:20}}>
        <div className="kpi" style={{cursor:'pointer',borderColor:tab==='landlords'?'var(--gold)':'var(--b1)'}} onClick={()=>setTab('landlords')}>
          <div className="kl">Landlords — No Bank</div>
          <div className={`kv ${(stats?.landlordsNoBank||0)>0?'r':'g'}`}>{stats?.landlordsNoBank||0}</div>
          <div className="ks">Bank account not verified</div>
        </div>
        <div className="kpi" style={{cursor:'pointer',borderColor:tab==='tenants'?'var(--gold)':'var(--b1)'}} onClick={()=>setTab('tenants')}>
          <div className="kl">Tenants — No ACH</div>
          <div className={`kv ${(stats?.tenantsNoAch||0)>0?'a':'g'}`}>{stats?.tenantsNoAch||0}</div>
          <div className="ks">ACH not verified</div>
        </div>
        <div className="kpi">
          <div className="kl">Tenants — No Flex</div>
          <div className={`kv ${(stats?.tenantsNoFlex||0)>0?'a':'g'}`}>{stats?.tenantsNoFlex||0}</div>
          <div className="ks">No flex products enrolled</div>
        </div>
        <div className="kpi">
          <div className="kl">Vacant Units</div>
          <div className="kv b">{stats?.vacantUnits||0}</div>
          <div className="ks">{stats?.unitsNoTenant||0} without tenant assigned</div>
        </div>
      </div>

      <div className="tabs" style={{marginBottom:16}}>
        <button className={`tab ${tab==='landlords'?'on':''}`} onClick={()=>setTab('landlords')}>🏢 Landlords ({(landlords as any[]).length})</button>
        <button className={`tab ${tab==='tenants'?'on':''}`} onClick={()=>setTab('tenants')}>👤 Tenants ({(tenants as any[]).length})</button>
      </div>

      <div className="grid2" style={{gap:16}}>
        {/* LEFT — list */}
        <div className="card" style={{padding:0,overflowX:'auto'}}>
          {tab==='landlords'&&(lLoading?<div style={{padding:32,color:'var(--t3)',textAlign:'center'}}>Loading…</div>:(
              <table className="tbl" style={{minWidth:540}}>
                <thead><tr><th>Landlord</th><th>Properties</th><th>Units</th><th>Bank</th><th>Onboarded</th></tr></thead>
                <tbody>
                  {(landlords as any[]).map((l:any)=>(
                    <tr key={l.id} style={{cursor:'pointer',background:selectedLandlord?.id===l.id?'rgba(201,162,39,.05)':''}} onClick={()=>{setSelectedLandlord(l);setSelectedTenant(null)}}>
                      <td><div style={{fontWeight:600,color:'var(--t0)',fontSize:'.78rem'}}>{l.firstName} {l.lastName}</div><div style={{fontSize:'.65rem',color:'var(--t3)'}}>{l.email}</div></td>
                      <td className="mono">{l.propertyCount}</td>
                      <td className="mono">{l.unitCount}</td>
                      <td><span className={`badge ${l.bankAccountReady?'bg2':'br'}`}>{l.bankAccountReady?'✓':'Missing'}</span></td>
                      <td><span className={`badge ${l.onboardingComplete?'bg2':'ba'}`}>{l.onboardingComplete?'Done':'Pending'}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ))}
          {tab==='tenants'&&(tLoading?<div style={{padding:32,color:'var(--t3)',textAlign:'center'}}>Loading…</div>:(
              <table className="tbl">
                <thead><tr><th>Tenant</th><th>Unit</th><th>ACH</th><th>OTP</th><th>Flex</th></tr></thead>
                <tbody>
                  {(tenants as any[]).map((t:any)=>(
                    <tr key={t.id} style={{cursor:'pointer',background:selectedTenant?.id===t.id?'rgba(201,162,39,.05)':''}} onClick={()=>{setSelectedTenant(t);setSelectedLandlord(null)}}>
                      <td><div style={{fontWeight:600,color:'var(--t0)',fontSize:'.78rem'}}>{t.firstName} {t.lastName}</div><div style={{fontSize:'.65rem',color:'var(--t3)'}}>{t.email}</div></td>
                      <td style={{fontSize:'.72rem'}}>{t.propertyName?`${t.propertyName} · ${t.unitNumber}`:<span style={{color:'var(--t3)'}}>—</span>}</td>
                      <td><span className={`badge ${t.achVerified?'bg2':'br'}`}>{t.achVerified?'✓':'No'}</span></td>
                      <td><span className={`badge ${t.onTimePayEnrolled?'bgold':'bmu'}`}>{t.onTimePayEnrolled?'✓':'—'}</span></td>
                      <td><span className={`badge ${(t.creditReportingEnrolled||t.flexDepositEnrolled||t.floatFeeActive)?'bg2':'bmu'}`}>{(t.creditReportingEnrolled||t.flexDepositEnrolled||t.floatFeeActive)?'Active':'None'}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ))}
        </div>

        {/* RIGHT — detail panel */}
        <div>
          {!selectedLandlord&&!selectedTenant&&(
            <div className="card" style={{textAlign:'center',padding:'48px 20px',color:'var(--t3)'}}>
              <div style={{fontSize:'2rem',marginBottom:12}}>👆</div>
              Select a landlord or tenant to view their onboarding status
            </div>
          )}

          {selectedLandlord&&landlordDetail&&(
            <div className="card">
              <div style={{marginBottom:16,paddingBottom:12,borderBottom:'1px solid var(--b0)'}}>
                <div style={{fontFamily:'var(--font-d)',fontWeight:800,fontSize:'1.1rem',color:'var(--t0)'}}>{landlordDetail.landlord.firstName} {landlordDetail.landlord.lastName}</div>
                <div style={{fontSize:'.72rem',color:'var(--t3)',marginTop:2}}>{landlordDetail.landlord.email} · {landlordDetail.landlord.businessName||'No business name'}</div>
              </div>

              <div className="ct">Onboarding Checklist</div>
              {landlordDetail.checklist.map((item:any)=>(
                <div key={item.key} style={{display:'flex',alignItems:'center',gap:10,padding:'7px 0',borderBottom:'1px solid var(--b0)'}}>
                  <span style={{fontSize:'1rem'}}>{item.done?'✅':'⬜'}</span>
                  <span style={{fontSize:'.82rem',color:item.done?'var(--t0)':'var(--t2)',flex:1}}>{item.label}</span>
                  {!item.done&&<span className="badge br">Incomplete</span>}
                </div>
              ))}

              <div style={{marginTop:16}}>
                <div className="ct">Quick Actions</div>
                <div style={{display:'flex',flexDirection:'column',gap:8}}>
                  <button className="btn bg-btn" disabled={!!resending} onClick={()=>resend('landlord_setup',selectedLandlord.id)}>
                    {resending==='landlord_setup'+selectedLandlord.id?'Sending…':'📧 Resend Setup Email'}
                  </button>
                  {!landlordDetail.landlord.bankAccountReady&&(
                    <button className="btn bg-btn" disabled={!!resending} onClick={()=>resend('bank_verification',selectedLandlord.id)}>
                      {resending==='bank_verification'+selectedLandlord.id?'Sending…':'🏦 Resend Bank Verification'}
                    </button>
                  )}
                  {landlordDetail.counts.unitCount>0&&landlordDetail.counts.unitsWithTenants===0&&(
                    <button className="btn bg-btn" disabled={!!resending} onClick={()=>resend('tenant_invite_reminder',selectedLandlord.id)}>
                      {resending==='tenant_invite_reminder'+selectedLandlord.id?'Sending…':'👤 Resend Tenant Invite Reminder'}
                    </button>
                  )}
                </div>
              </div>

              <div style={{marginTop:12,display:'grid',gridTemplateColumns:'1fr 1fr 1fr',gap:8}}>
                <div style={{textAlign:'center',padding:'10px',background:'var(--bg3)',borderRadius:8}}>
                  <div style={{fontFamily:'var(--font-d)',fontSize:'1.2rem',fontWeight:700,color:'var(--t0)'}}>{landlordDetail.counts.propertyCount}</div>
                  <div style={{fontSize:'.65rem',color:'var(--t3)'}}>Properties</div>
                </div>
                <div style={{textAlign:'center',padding:'10px',background:'var(--bg3)',borderRadius:8}}>
                  <div style={{fontFamily:'var(--font-d)',fontSize:'1.2rem',fontWeight:700,color:'var(--t0)'}}>{landlordDetail.counts.unitCount}</div>
                  <div style={{fontSize:'.65rem',color:'var(--t3)'}}>Units</div>
                </div>
                <div style={{textAlign:'center',padding:'10px',background:'var(--bg3)',borderRadius:8}}>
                  <div style={{fontFamily:'var(--font-d)',fontSize:'1.2rem',fontWeight:700,color:'var(--t0)'}}>{landlordDetail.counts.activeLeases}</div>
                  <div style={{fontSize:'.65rem',color:'var(--t3)'}}>Leases</div>
                </div>
              </div>
            </div>
          )}

          {selectedTenant&&tenantDetail&&(
            <div className="card">
              <div style={{marginBottom:16,paddingBottom:12,borderBottom:'1px solid var(--b0)'}}>
                <div style={{fontFamily:'var(--font-d)',fontWeight:800,fontSize:'1.1rem',color:'var(--t0)'}}>{tenantDetail.tenant.firstName} {tenantDetail.tenant.lastName}</div>
                <div style={{fontSize:'.72rem',color:'var(--t3)',marginTop:2}}>{tenantDetail.tenant.email}</div>
                {tenantDetail.tenant.unitNumber&&<div style={{fontSize:'.72rem',color:'var(--t3)',marginTop:2}}>{tenantDetail.tenant.propertyName} · Unit {tenantDetail.tenant.unitNumber}</div>}
              </div>

              <div className="ct">Onboarding Checklist</div>
              {tenantDetail.checklist.map((item:any)=>(
                <div key={item.key} style={{display:'flex',alignItems:'center',gap:10,padding:'7px 0',borderBottom:'1px solid var(--b0)'}}>
                  <span style={{fontSize:'1rem'}}>{item.done?'✅':'⬜'}</span>
                  <span style={{fontSize:'.82rem',color:item.done?'var(--t0)':'var(--t2)',flex:1}}>{item.label}</span>
                  {!item.done&&<span className="badge br">Incomplete</span>}
                </div>
              ))}

              <div style={{marginTop:16}}>
                <div className="ct">Quick Actions</div>
                <div style={{display:'flex',flexDirection:'column',gap:8}}>
                  <button className="btn bg-btn" disabled={!!resending} onClick={()=>resend('tenant_invite',selectedTenant.id)}>
                    {resending==='tenant_invite'+selectedTenant.id?'Sending…':'📧 Resend Invite Email'}
                  </button>
                  {!tenantDetail.tenant.achVerified&&(
                    <button className="btn bg-btn" disabled={!!resending} onClick={()=>resend('ach_enrollment',selectedTenant.id)}>
                      {resending==='ach_enrollment'+selectedTenant.id?'Sending…':'🏦 Resend ACH Enrollment'}
                    </button>
                  )}
                  {tenantDetail.tenant.achVerified&&!tenantDetail.tenant.onTimePayEnrolled&&(
                    <button className="btn bg-btn" disabled={!!resending} onClick={()=>resend('otp_enrollment',selectedTenant.id)}>
                      {resending==='otp_enrollment'+selectedTenant.id?'Sending…':'⚡ Send OTP Enrollment Nudge'}
                    </button>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function Overview(){
  const{user}=useAuth()
  const navigate=useNavigate()
  const isSuperAdmin=user?.role==='super_admin'
  const{data:income}=useQuery('income-projection',()=>get<any>('/admin/income/projection'),{enabled:!!user,staleTime:60000,refetchOnWindowFocus:false})
  const{data:stats,isLoading}=useQuery(['admin-overview',user?.id],()=>get<any>('/admin/overview'),{refetchInterval:30000,enabled:!!user,staleTime:30000,keepPreviousData:true})
  const{data:openDisputes=[]}=useQuery<any[]>('overview-open-disputes',()=>get<any[]>('/credit/disputes?status=open'),{enabled:!!user,staleTime:60000,refetchInterval:60000})
  const{phase,rate}=getReservePhase(stats?.activeUnits||0)
  const reserveTarget=RESERVE_CONFIG.DEFAULT_RATE*RESERVE_CONFIG.TARGET_MONTHS*(stats?.activeUnits||0)*(600)
  const reservePct=stats?.reserveBalance?Math.min((stats.reserveBalance/Math.max(reserveTarget,1))*100,100):0

  const trendData=[{m:'Oct',r:1800},{m:'Nov',r:2100},{m:'Dec',r:2400},{m:'Jan',r:2700},{m:'Feb',r:3000},{m:'Mar',r:stats?.monthlyRentVolume||0}]

  if(isLoading&&!stats)return<div style={{padding:32,color:'var(--t3)'}}>Loading platform data…</div>

  return(
    <div>
      <div className="ph">
        <div><h1 className="pt">Platform Overview</h1><p className="ps">Real-time operations snapshot · Auto-refreshes every 30s</p></div>
        <div style={{display:'flex',gap:8}}>
        </div>
      </div>

      {(stats?.evictionModeUnits||0)>0&&<div className="alert ae">🚫 <strong>{stats.evictionModeUnits} unit(s) in Eviction Mode</strong> — All tenant ACH hard-blocked. No disbursement until cleared.</div>}
      {(stats?.zeroToleranceEvents||0)>0&&<div className="alert ae">⚠️ <strong>NACHA Zero-Tolerance Event</strong> — Manual review required. Check NACHA Monitor.</div>}
      {(openDisputes as any[]).length>0&&(
        <div className="alert agold" style={{cursor:'pointer'}} onClick={()=>navigate('/disputes')}>
          ⚖️ <strong>{(openDisputes as any[]).length} open credit dispute{(openDisputes as any[]).length===1?'':'s'}</strong> — Click to review.
        </div>
      )}
      {/* S316: CSV imports pending review tile. Surfaced as an
          actionable banner alongside disputes — only when the count
          is non-zero, matches the pattern of the other ops alerts. */}
      {isSuperAdmin&&(stats?.csvImportsPendingReview||0)>0&&(
        <div className="alert agold" style={{cursor:'pointer'}} onClick={()=>navigate('/csv-imports')}>
          📥 <strong>{stats.csvImportsPendingReview} CSV import{stats.csvImportsPendingReview===1?'':'s'} awaiting review</strong> — Unverified platforms; click to review column mappings.
        </div>
      )}

      {/* ── Row 1: Landlords + Tenants ── */}
      <div className="grid2" style={{marginBottom:12}}>
        <div className="kpi"><div className="kl">Landlords</div><div className="kv gold">{(stats?.totalLandlords||0).toLocaleString()}</div><div className="ks">on platform</div></div>
        <div className="kpi"><div className="kl">Total Tenants</div><div className="kv b">{(stats?.totalTenants||0).toLocaleString()}</div><div className="ks">across all properties</div></div>
      </div>

      {/* ── Row 2: Units + Flex + Rent Volume ── */}
      <div className="grid3" style={{marginBottom:12}}>
        <div className="kpi"><div className="kl">Active Units</div><div className="kv g">{(stats?.activeUnits||0).toLocaleString()}</div><div className="ks">{stats?.vacantUnits||0} vacant</div></div>
        <div className="kpi">
          <div className="kl">Flex Products</div>
          <div className="kv gold">{(stats?.flexOtp||0)+(stats?.flexCredit||0)+(stats?.flexDeposit||0)+(stats?.flexPay||0)}</div>
          <div className="ks" style={{marginTop:6,display:'grid',gridTemplateColumns:'1fr 1fr',gap:'2px 12px'}}>
            <span>⚡ OTP: <strong style={{color:'var(--t0)'}}>{stats?.flexOtp||0}</strong></span>
            <span>💳 Rent reporting: <strong style={{color:'var(--t0)'}}>{stats?.flexCredit||0}</strong></span>
            <span>🏦 Deposit: <strong style={{color:'var(--t0)'}}>{stats?.flexDeposit||0}</strong></span>
            <span>💸 Pay: <strong style={{color:'var(--t0)'}}>{stats?.flexPay||0}</strong></span>
          </div>
        </div>
        {isSuperAdmin&&<div className="kpi"><div className="kl">Monthly Rent Volume</div><div className="kv gold">{formatCurrency(stats?.monthlyRentVolume||0)}</div><div className="ks">across {stats?.activeUnits||0} units</div></div>}
        {!isSuperAdmin&&<div className="kpi"><div className="kl">Vacant Units</div><div className="kv b">{stats?.vacantUnits||0}</div><div className="ks">available to fill</div></div>}
      </div>

      {/* ── Row 3: Super admin financial ── */}
      {isSuperAdmin&&<div className="grid4" style={{marginBottom:12}}>
        <div className="kpi"><div className="kl">Reserve Balance</div><div className={`kv ${reservePct>=100?'g':reservePct>=50?'a':'r'}`}>{formatCurrency(stats?.reserveBalance||0)}</div><div className="ks">{reservePct.toFixed(0)}% of target</div></div>
        <div className="kpi"><div className="kl">Float Balance</div><div className="kv b">{formatCurrency(stats?.floatBalance||0)}</div><div className="ks">4.5% APY</div></div>
        <div className="kpi"><div className="kl">Pending Payments</div><div className={`kv ${(stats?.pendingPayments||0)>20?'r':'a'}`}>{stats?.pendingPayments||0}</div><div className="ks">awaiting ACH settlement</div></div>
        <div className="kpi"><div className="kl">Pending Disbursements</div><div className={`kv ${(stats?.pendingDisbursements||0)>0?'a':'g'}`}>{stats?.pendingDisbursements||0}</div><div className="ks">landlord payouts queued</div></div>
      </div>}



      {isSuperAdmin&&<div className="grid2">
        <div className="card">
          <div className="ct">Monthly Rent Volume Trend</div>
          <ResponsiveContainer width="100%" height={180}>
            <AreaChart data={trendData} margin={{top:0,right:0,left:-20,bottom:0}}>
              <defs><linearGradient id="grad" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#c9a227" stopOpacity={.3}/><stop offset="95%" stopColor="#c9a227" stopOpacity={0}/></linearGradient></defs>
              <XAxis dataKey="m" tick={{fill:'var(--t3)',fontSize:10}} axisLine={false} tickLine={false}/>
              <YAxis tick={{fill:'var(--t3)',fontSize:10}} axisLine={false} tickLine={false} tickFormatter={v=>`$${(v/1000).toFixed(0)}k`}/>
              <Tooltip contentStyle={{background:'var(--bg3)',border:'1px solid var(--b2)',borderRadius:8,color:'var(--t0)'}} formatter={(v:any)=>[formatCurrency(v),'Volume']}/>
              <Area type="monotone" dataKey="r" stroke="#c9a227" strokeWidth={2} fill="url(#grad)"/>
            </AreaChart>
          </ResponsiveContainer>
        </div>
        <div className="card">
          <div className="ct">Reserve Fund Health</div>
          <div className="dr"><span className="dk">Balance</span><span className="dv mono">{formatCurrency(stats?.reserveBalance||0)}</span></div>
          <div className="dr"><span className="dk">Target (3-mo defaults)</span><span className="dv mono">{formatCurrency(reserveTarget)}</span></div>
          <div className="dr"><span className="dk">Coverage</span><span className={`badge ${reservePct>=100?'bg2':reservePct>=50?'ba':'br'}`}>{reservePct.toFixed(0)}%</span></div>
          <div className="dr"><span className="dk">Phase</span><span className={`badge ${phase===1?'ba':phase===2?'bb':'bg2'}`}>Phase {phase} — {(rate*100).toFixed(0)}% rate</span></div>
          <div className="dr"><span className="dk">Float balance</span><span className="dv mono">{formatCurrency(stats?.floatBalance||0)}</span></div>
          <div className="dr"><span className="dk">Float APY income</span><span className="dv mono" style={{color:'var(--green)'}}>+{formatCurrency((stats?.floatBalance||0)*.045/12)}/mo</span></div>
        </div>
      </div>}
      {isSuperAdmin&&<>
      {/* ── Projected Platform Income ── */}
      {(()=>{
        const streams=[
          {label:'OTP Unit Fees',     value:income?.monthly?.otpUnitFees||0,    detail:`${income?.counts?.otpUnits||0} units × $15`,    color:'#c9a227'},
          {label:'Direct Pay Fees',   value:income?.monthly?.directUnitFees||0, detail:`${income?.counts?.directUnits||0} units × $5`,   color:'#3b82f6'},
          {label:'FlexPay Fees',      value:income?.monthly?.flexPayFees||0,    detail:`${income?.counts?.flexPay||0} tenants × $20`,    color:'#22c55e'},
          {label:'Background Checks', value:income?.monthly?.bgCheckFees||0,    detail:`${income?.counts?.bgChecks||0} checks × $15`,    color:'#a855f7'},
        ]
        const total=income?.monthly?.total||0
        return(
          <div className="card" style={{marginTop:4,background:'linear-gradient(135deg,rgba(201,162,39,.06) 0%,rgba(8,10,12,0) 60%)',border:'1px solid rgba(201,162,39,.2)'}}>
            <div style={{display:'flex',alignItems:'flex-start',justifyContent:'space-between',marginBottom:24}}>
              <div>
                <div style={{fontSize:'.65rem',color:'var(--t3)',textTransform:'uppercase',letterSpacing:'.12em',marginBottom:6}}>Projected Platform Revenue</div>
                <div style={{fontFamily:'var(--font-d)',fontSize:'2.8rem',fontWeight:800,color:'var(--gold)',lineHeight:1}}>{formatCurrency(total)}</div>
                <div style={{fontSize:'.78rem',color:'var(--t3)',marginTop:6}}>per month · based on current enrollment</div>
              </div>
              <div style={{textAlign:'right'}}>
                <div style={{fontSize:'.65rem',color:'var(--t3)',textTransform:'uppercase',letterSpacing:'.12em',marginBottom:6}}>Annual Run Rate</div>
                <div style={{fontFamily:'var(--font-d)',fontSize:'1.8rem',fontWeight:800,color:'var(--green)',lineHeight:1}}>{formatCurrency(income?.annual||0)}</div>
                <div style={{fontSize:'.72rem',color:'var(--t3)',marginTop:6}}>projected ARR</div>
              </div>
            </div>
            <div style={{display:'flex',flexDirection:'column',gap:12}}>
              {streams.map((s:any)=>{
                const pct=total>0?Math.max((s.value/total)*100,0):0
                return(
                  <div key={s.label}>
                    <div style={{display:'flex',justifyContent:'space-between',alignItems:'baseline',marginBottom:5}}>
                      <div style={{display:'flex',alignItems:'center',gap:8}}>
                        <div style={{width:8,height:8,borderRadius:'50%',background:s.color,flexShrink:0}}/>
                        <span style={{fontSize:'.78rem',color:'var(--t1)',fontWeight:500}}>{s.label}</span>
                        <span style={{fontSize:'.68rem',color:'var(--t3)'}}>{s.detail}</span>
                      </div>
                      <span style={{fontFamily:'var(--font-m)',fontSize:'.82rem',color:'var(--t0)',fontWeight:600}}>{formatCurrency(s.value)}</span>
                    </div>
                    <div style={{height:6,background:'var(--bg3)',borderRadius:3,overflow:'hidden'}}>
                      <div style={{height:'100%',width:`${pct}%`,background:s.color,borderRadius:3,transition:'width .4s ease',opacity:.85}}/>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        )
      })()}
      </> }
    </div>
  )
}

// ── LANDLORDS ─────────────────────────────────────────────────
function Landlords(){
  const{user}=useAuth()
  const{data:landlords=[],isLoading}=useQuery<any[]>('landlords',()=>get('/landlords'),{enabled:!!user,refetchOnWindowFocus:false})
  const[lSearch,setLSearch]=React.useState('')
  const sortedLandlords=React.useMemo(()=>[...(landlords as any[])].sort((a,b)=>{
    const aInc=(!a.bankAccountReady||!a.onboardingComplete)?0:1
    const bInc=(!b.bankAccountReady||!b.onboardingComplete)?0:1
    return aInc-bInc
  }),[landlords])
  const filteredLandlords=React.useMemo(()=>lSearch?sortedLandlords.filter((l:any)=>`${l.firstName} ${l.lastName} ${l.email} ${l.businessName||""}`.toLowerCase().includes(lSearch.toLowerCase())):sortedLandlords,[sortedLandlords,lSearch])
  const[selected,setSelected]=React.useState<any>(null)
  const{data:detail}=useQuery(['landlord-detail',selected?.id],()=>get<any>('/admin/onboarding/landlord/'+selected.id),{enabled:!!selected?.id,staleTime:15000})
  const[resending,setResending]=React.useState<string|null>(null)
  const[msg,setMsg]=React.useState('')
  const[otpToggling,setOtpToggling]=React.useState(false)
  const qcLL=useQueryClient()

  const resend=async(type:string,id:string)=>{
    setResending(type)
    try{ await post('/admin/onboarding/resend',{type,targetId:id}); setMsg('Notification queued'); setTimeout(()=>setMsg(''),3000) }
    catch(e:any){ setMsg('Failed: '+e.message) }
    finally{ setResending(null) }
  }

  const toggleOtpBeta=async(enabled:boolean)=>{
    if(!selected?.id) return
    setOtpToggling(true)
    try{
      await api.patch(`/admin/landlords/${selected.id}/otp-rollout`,{enabled})
      await qcLL.invalidateQueries(['landlord-detail',selected.id])
      setMsg(enabled?'OTP beta enabled':'OTP beta disabled'); setTimeout(()=>setMsg(''),3000)
    } catch(e:any){ setMsg('Failed: '+(e?.response?.data?.message||e.message)) }
    finally{ setOtpToggling(false) }
  }

  return(
    <div>
      <div className="ph"><div><h1 className="pt">Landlords</h1><p className="ps">{(landlords as any[]).length} registered</p></div></div>
      {msg&&<div className={`alert ${msg.startsWith('F')?'ae':'ag'}`} style={{marginBottom:12}}>{msg}</div>}
      <div className="grid2" style={{gap:16,alignItems:'start'}}>
        <div className="card" style={{padding:0}}>
          <div style={{padding:'10px 12px',borderBottom:'1px solid var(--b0)'}}><input type="text" placeholder="Search landlords…" value={lSearch} onChange={e=>setLSearch(e.target.value)} style={{width:'100%',background:'var(--bg3)',border:'1px solid var(--b1)',borderRadius:7,color:'var(--t0)',padding:'7px 10px',fontSize:'.78rem',outline:'none'}}/></div>
          {isLoading?<div style={{padding:32,color:'var(--t3)',textAlign:'center'}}>Loading…</div>:(
            <table className="tbl">
              <thead><tr><th>Landlord</th><th>Business</th><th>Units</th><th>Bank</th><th>Onboarded</th></tr></thead>
              <tbody>
                {filteredLandlords.length?filteredLandlords.map((l:any)=>(
                  <tr key={l.id} style={{cursor:'pointer',background:selected?.id===l.id?'rgba(201,162,39,.05)':''}} onClick={()=>setSelected(l)}>
                    <td><div style={{fontWeight:600,color:'var(--t0)'}}>{l.firstName} {l.lastName}</div><div style={{fontSize:'.68rem',color:'var(--t3)'}}>{l.email}</div></td>
                    <td style={{fontSize:'.78rem'}}>{l.businessName||'—'}</td>
                    <td className="mono">{l.unitCount} <span style={{color:'var(--t3)'}}>({l.occupiedCount} occ)</span></td>
                    <td><span className={`badge ${l.bankAccountReady?'bg2':'br'}`}>{l.bankAccountReady?'✓':'Missing'}</span></td>
                    <td><span className={`badge ${l.onboardingComplete?'bg2':'ba'}`}>{l.onboardingComplete?'Done':'Pending'}</span></td>
                  </tr>
                )):<tr><td colSpan={5} style={{textAlign:'center',color:'var(--t3)',padding:32}}>No landlords yet.</td></tr>}
              </tbody>
            </table>
          )}
        </div>
        <div>
          {!selected&&<div className="card" style={{textAlign:'center',padding:'48px 20px',color:'var(--t3)'}}>Select a landlord to view details</div>}
          {selected&&detail&&(
            <div className="card">
              <div style={{marginBottom:16,paddingBottom:12,borderBottom:'1px solid var(--b0)'}}>
                <div style={{fontFamily:'var(--font-d)',fontWeight:800,fontSize:'1.1rem',color:'var(--t0)'}}>{detail.landlord.firstName} {detail.landlord.lastName}</div>
                <div style={{fontSize:'.72rem',color:'var(--t3)',marginTop:2}}>{detail.landlord.email}</div>
                {detail.landlord.businessName&&<div style={{fontSize:'.72rem',color:'var(--t2)',marginTop:2}}>{detail.landlord.businessName}</div>}
                {detail.landlord.phone&&<div style={{fontSize:'.72rem',color:'var(--t3)',marginTop:2}}>{detail.landlord.phone}</div>}
              </div>
              <div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr',gap:8,marginBottom:16}}>
                <div style={{textAlign:'center',padding:'10px',background:'var(--bg3)',borderRadius:8}}>
                  <div style={{fontFamily:'var(--font-d)',fontSize:'1.3rem',fontWeight:700,color:'var(--t0)'}}>{detail.counts.propertyCount}</div>
                  <div style={{fontSize:'.65rem',color:'var(--t3)'}}>Properties</div>
                </div>
                <div style={{textAlign:'center',padding:'10px',background:'var(--bg3)',borderRadius:8}}>
                  <div style={{fontFamily:'var(--font-d)',fontSize:'1.3rem',fontWeight:700,color:'var(--t0)'}}>{detail.counts.unitCount}</div>
                  <div style={{fontSize:'.65rem',color:'var(--t3)'}}>Units</div>
                </div>
                <div style={{textAlign:'center',padding:'10px',background:'var(--bg3)',borderRadius:8}}>
                  <div style={{fontFamily:'var(--font-d)',fontSize:'1.3rem',fontWeight:700,color:'var(--t0)'}}>{detail.counts.unitsWithTenants}</div>
                  <div style={{fontSize:'.65rem',color:'var(--t3)'}}>With Tenants</div>
                </div>
              </div>
              <div className="ct">Onboarding Checklist</div>
              {detail.checklist.map((item:any)=>(
                <div key={item.key} style={{display:'flex',alignItems:'center',gap:10,padding:'7px 0',borderBottom:'1px solid var(--b0)'}}>
                  <span>{item.done?'✅':'⬜'}</span>
                  <span style={{fontSize:'.82rem',color:item.done?'var(--t0)':'var(--t2)',flex:1}}>{item.label}</span>
                  {!item.done&&<span className="badge br">Incomplete</span>}
                </div>
              ))}
              <div style={{marginTop:16,display:'flex',flexDirection:'column',gap:8}}>
                <button className="btn bg-btn" disabled={!!resending} onClick={()=>resend('landlord_setup',selected.id)}>
                  {resending==='landlord_setup'?'Sending…':'📧 Resend Setup Email'}
                </button>
                {!detail.landlord.bankAccountReady&&(
                  <button className="btn bg-btn" disabled={!!resending} onClick={()=>resend('bank_verification',selected.id)}>
                    {resending==='bank_verification'?'Sending…':'🏦 Resend Bank Verification'}
                  </button>
                )}
              </div>
              <div style={{marginTop:20,paddingTop:14,borderTop:'1px solid var(--b0)'}}>
                <div className="ct" style={{marginBottom:8}}>Beta Features</div>
                <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',gap:12,padding:'10px 12px',background:'var(--bg3)',borderRadius:8}}>
                  <div>
                    <div style={{fontSize:'.85rem',fontWeight:600,color:'var(--t0)'}}>On-Time Pay (OTP)</div>
                    <div style={{fontSize:'.7rem',color:'var(--t3)',marginTop:2}}>Rent-advance product. Requires global feature flag + this toggle.</div>
                  </div>
                  <button
                    className={`btn ${detail.landlord.otpRolloutEnabled?'bg2-btn':'bg-btn'}`}
                    disabled={otpToggling}
                    onClick={()=>toggleOtpBeta(!detail.landlord.otpRolloutEnabled)}
                  >
                    {otpToggling?'…':(detail.landlord.otpRolloutEnabled?'✓ Enabled':'Enable')}
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ── UNITS ─────────────────────────────────────────────────────
function Units(){
  const{user}=useAuth()
  const{data:units=[],isLoading}=useQuery<any[]>('units',()=>get('/units'),{enabled:!!user,refetchOnWindowFocus:false})
  const[selected,setSelected]=React.useState<any>(null)
  const[uSearch,setUSearch]=React.useState('')
  const filteredUnits=React.useMemo(()=>{
    const u=units as any[]
    if(!uSearch)return u
    const q=uSearch.toLowerCase()
    return u.filter((u:any)=>`${u.unitNumber} ${u.propertyName} ${u.tenantFirst||''} ${u.tenantLast||''} ${u.tenantEmail||''}`.toLowerCase().includes(q))
  },[units,uSearch])
  const eviction=(units as any[]).filter((u:any)=>u.paymentBlock)
  const delinquent=(units as any[]).filter((u:any)=>u.status==='delinquent')
  return(
    <div>
      <div className="ph"><div><h1 className="pt">Units</h1><p className="ps">{(units as any[]).length} total · {(units as any[]).filter((u:any)=>u.status==='active').length} active</p></div></div>
      {eviction.length>0&&<div className="alert ae">🚫 {eviction.length} unit(s) in Eviction Mode — ACH blocked</div>}
      {delinquent.length>0&&<div className="alert aw">⚡ {delinquent.length} delinquent unit(s) in cure window</div>}
      <div className="grid2" style={{gap:16,alignItems:'start'}}>
        <div className="card" style={{padding:0}}>
          <div style={{padding:'10px 12px',borderBottom:'1px solid var(--b0)'}}><input type="text" placeholder="Search units, properties, tenants…" value={uSearch} onChange={e=>setUSearch(e.target.value)} style={{width:'100%',background:'var(--bg3)',border:'1px solid var(--b1)',borderRadius:7,color:'var(--t0)',padding:'7px 10px',fontSize:'.78rem',outline:'none'}}/></div>
          {isLoading?<div style={{padding:32,color:'var(--t3)',textAlign:'center'}}>Loading…</div>:(
            <table className="tbl">
              <thead><tr><th>Unit</th><th>Property</th><th>Tenant</th><th>Rent</th><th>Status</th><th>ACH</th></tr></thead>
              <tbody>
                {filteredUnits.map((u:any)=>(
                  <tr key={u.id} style={{cursor:'pointer',background:selected?.id===u.id?'rgba(201,162,39,.05)':u.paymentBlock?'rgba(239,68,68,.03)':''}} onClick={()=>setSelected(u)}>
                    <td className="mono" style={{color:'var(--t0)',fontWeight:600}}>{u.unitNumber}</td>
                    <td style={{fontSize:'.75rem'}}>{u.propertyName}</td>
                    <td style={{fontSize:'.75rem'}}>{u.tenantFirst?`${u.tenantFirst} ${u.tenantLast}`:<span style={{color:'var(--t3)'}}>Vacant</span>}</td>
                    <td className="mono">{formatCurrency(u.rentAmount)}</td>
                    <td><span className={`badge ${u.status==='active'?'bg2':u.status==='delinquent'?'ba':u.status==='suspended'?'br':'bmu'}`}>{u.status.replace('_',' ')}</span></td>
                    <td>{u.achVerified?<span className="badge bg2">✓</span>:<span className="badge ba">Pending</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <div>
          {!selected&&<div className="card" style={{textAlign:'center',padding:'48px 20px',color:'var(--t3)'}}>Select a unit to view details</div>}
          {selected&&(
            <div className="card">
              <div style={{marginBottom:16,paddingBottom:12,borderBottom:'1px solid var(--b0)'}}>
                <div style={{fontFamily:'var(--font-d)',fontWeight:800,fontSize:'1.1rem',color:'var(--t0)'}}>Unit {selected.unitNumber}</div>
                <div style={{fontSize:'.72rem',color:'var(--t3)',marginTop:2}}>{selected.propertyName}</div>
                {selected.street1&&<div style={{fontSize:'.72rem',color:'var(--t3)',marginTop:2}}>{selected.street1}, {selected.city}</div>}
              </div>
              <div className="ct">Unit Info</div>
              <div className="dr"><span className="dk">Status</span><span className={`badge ${selected.status==='active'?'bg2':selected.status==='delinquent'?'ba':selected.status==='suspended'?'br':'bmu'}`}>{selected.status.replace('_',' ')}</span></div>
              <div className="dr"><span className="dk">Rent</span><span className="dv mono">{formatCurrency(selected.rentAmount)}/mo</span></div>
              <div className="dr"><span className="dk">Deposit</span><span className="dv mono">{formatCurrency(selected.securityDeposit||0)}</span></div>
              <div className="dr"><span className="dk">Bedrooms</span><span className="dv">{selected.bedrooms||'—'}</span></div>
              <div className="dr"><span className="dk">Bathrooms</span><span className="dv">{selected.bathrooms||'—'}</span></div>
              <div className="dr"><span className="dk">Sq Ft</span><span className="dv">{selected.sqft?.toLocaleString()||'—'}</span></div>
              <div className="dr"><span className="dk">Listed</span><span className={`badge ${selected.listedVacant?'bg2':'bmu'}`}>{selected.listedVacant?'Yes':'No'}</span></div>
              {selected.onTimePayActive&&<div className="dr"><span className="dk">On-Time Pay</span><span className="badge bgold">Active</span></div>}
              {selected.paymentBlock&&<div className="dr"><span className="dk">Eviction Mode</span><span className="badge br">🚫 BLOCKED</span></div>}
              {selected.tenantFirst&&<>
                <div className="ct" style={{marginTop:16}}>Tenant</div>
                <div className="dr"><span className="dk">Name</span><span className="dv">{selected.tenantFirst} {selected.tenantLast}</span></div>
                <div className="dr"><span className="dk">Email</span><span className="dv" style={{fontSize:'.75rem'}}>{selected.tenantEmail||'—'}</span></div>
                <div className="dr"><span className="dk">ACH</span><span className={`badge ${selected.achVerified?'bg2':'ba'}`}>{selected.achVerified?'Verified':'Pending'}</span></div>
                {selected.ssiSsdi&&<div className="dr"><span className="dk">SSI/SSDI</span><span className="badge bgold">Yes</span></div>}
                {selected.latePaymentCount>0&&<div className="dr"><span className="dk">Late Payments</span><span className="dv mono" style={{color:'var(--amber)'}}>{selected.latePaymentCount}</span></div>}
              </>}
              {!selected.tenantFirst&&(
                <div style={{marginTop:12,padding:'12px',background:'var(--bg3)',borderRadius:8,fontSize:'.78rem',color:'var(--t3)',textAlign:'center'}}>Vacant — no tenant assigned</div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ── NACHA MONITOR ─────────────────────────────────────────────
function NachaMonitor(){
  const{user}=useAuth()
  const{data,isLoading}=useQuery('nacha',()=>get<any>('/admin/nacha/monitoring'),{refetchInterval:60000,enabled:!!user})
  const logs=data?.logs||[]
  const stats=data?.stats||{}
  const JUNE_22=new Date('2026-06-22')
  const today=new Date()
  const daysLeft=Math.ceil((JUNE_22.getTime()-today.getTime())/(1000*60*60*24))

  return(
    <div>
      <div className="ph"><div><h1 className="pt">NACHA Compliance Monitor</h1><p className="ps">Phase 2 — Fraud monitoring · Effective June 22, 2026</p></div></div>
      <div className="nacha-flag">
        <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:8}}>
          <strong style={{color:'var(--red)',fontFamily:'var(--font-d)'}}>⚡ NACHA Phase 2 Deadline</strong>
          <span className={`badge ${daysLeft<30?'br':daysLeft<60?'ba':'bb'}`}>{daysLeft} days remaining</span>
        </div>
        <div style={{fontSize:'.8rem',color:'var(--t2)',lineHeight:1.6}}>June 22, 2026: All non-consumer Originators must implement risk-based fraud monitoring regardless of volume. Return code zero-tolerance: R05, R07, R10, R29 require immediate suspension.</div>
      </div>

      <div className="grid4" style={{marginBottom:16}}>
        <div className="kpi"><div className="kl">Total Returns (30d)</div><div className={`kv ${(stats.totalReturns||0)>5?'r':'g'}`}>{stats.totalReturns||0}</div><div className="ks">ACH return events</div></div>
        <div className="kpi"><div className="kl">Zero Tolerance (30d)</div><div className={`kv ${(stats.zeroToleranceEvents||0)>0?'r':'g'}`}>{stats.zeroToleranceEvents||0}</div><div className="ks">R05/R07/R10/R29</div></div>
        <div className="kpi"><div className="kl">First Senders (30d)</div><div className="kv b">{stats.firstSenders30d||0}</div><div className="ks">New bank accounts</div></div>
        <div className="kpi"><div className="kl">Velocity Flags</div><div className={`kv ${(stats.velocityFlags30d||0)>0?'a':'g'}`}>{stats.velocityFlags30d||0}</div><div className="ks">Unusual ACH frequency</div></div>
      </div>

      {(stats.zeroToleranceEvents||0)>0&&<div className="alert ae">🚨 Zero-tolerance return event detected. Tenant ACH suspended per NACHA policy. Review below.</div>}

      <div className="card" style={{padding:0}}>
        <div style={{padding:'12px 14px',borderBottom:'1px solid var(--b1)'}}><div className="ct" style={{marginBottom:0}}>ACH Monitoring Log</div></div>
        {isLoading?<div style={{padding:32,color:'var(--t3)',textAlign:'center'}}>Loading…</div>:(
          <table className="tbl">
            <thead><tr><th>Time</th><th>Event</th><th>Tenant</th><th>Amount</th><th>Return Code</th><th>Zero-Tolerance</th><th>Resolved</th></tr></thead>
            <tbody>
              {logs.length?logs.map((l:any)=>(
                <tr key={l.id} style={{background:l.zeroToleranceFlag?'rgba(239,68,68,.04)':''}}>
                  <td className="mono" style={{fontSize:'.7rem',color:'var(--t3)'}}>{new Date(l.createdAt).toLocaleString()}</td>
                  <td><span className={`badge ${l.eventType==='zero_tolerance_block'?'br':l.eventType==='velocity_flag'?'ba':'bmu'}`}>{l.eventType.replace(/_/g,' ')}</span></td>
                  <td style={{fontSize:'.75rem'}}>{l.firstName?`${l.firstName} ${l.lastName}`:'—'}</td>
                  <td className="mono">{l.amount?formatCurrency(l.amount):'—'}</td>
                  <td>{l.returnCode?<span className={`badge ${['R05','R07','R10','R29'].includes(l.returnCode)?'br':'ba'}`}>{l.returnCode}</span>:<span style={{color:'var(--t3)'}}>—</span>}</td>
                  <td>{l.zeroToleranceFlag?<span className="badge br">🚫 YES</span>:<span style={{color:'var(--t3)'}}>—</span>}</td>
                  <td><span className={`badge ${l.resolved?'bg2':'ba'}`}>{l.resolved?'Yes':'Pending'}</span></td>
                </tr>
              )):<tr><td colSpan={7} style={{textAlign:'center',color:'var(--t3)',padding:32}}>No events logged yet. Monitoring is active.</td></tr>}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}

// ── PAYMENTS ─────────────────────────────────────────────────────────────
function Payments(){
  const{user}=useAuth()
  const{data:payments=[],isLoading}=useQuery<any[]>('payments',()=>get('/payments'),{enabled:!!user})
  const[selected,setSelected]=React.useState<any>(null)
  const[pSearch,setPSearch]=React.useState('')
  const filteredPayments=React.useMemo(()=>pSearch?((payments as any[]).filter((p:any)=>`${p.propertyName||''} ${p.unitNumber||''} ${p.tenantFirst||''} ${p.tenantLast||''} ${p.type} ${p.status}`.toLowerCase().includes(pSearch.toLowerCase()))):(payments as any[]),[payments,pSearch])
  const ST:Record<string,string>={settled:'bg2',pending:'ba',failed:'br',returned:'br',processing:'bb'}
  return(
    <div>
      <div className="ph"><div><h1 className="pt">Payments</h1><p className="ps">All ACH collections platform-wide</p></div></div>
      <div className="card" style={{padding:0}}>
          <div style={{padding:'10px 12px',borderBottom:'1px solid var(--b0)'}}><input type="text" placeholder="Search payments…" value={pSearch} onChange={e=>setPSearch(e.target.value)} style={{width:'100%',background:'var(--bg3)',border:'1px solid var(--b1)',borderRadius:7,color:'var(--t0)',padding:'7px 10px',fontSize:'.78rem',outline:'none'}}/></div>
        {isLoading?<div style={{padding:32,color:'var(--t3)',textAlign:'center'}}>Loading…</div>:(
          <table className="tbl">
            <thead><tr><th>Due</th><th>Property · Unit</th><th>Tenant</th><th>Type</th><th>Amount</th><th>Status</th><th>Return</th></tr></thead>
            <tbody>
              {filteredPayments.length?filteredPayments.map((p:any)=>(
                <tr key={p.id} style={{cursor:'pointer',background:p.zeroToleranceFlag?'rgba(239,68,68,.03)':selected?.id===p.id?'rgba(201,162,39,.04)':''}} onClick={()=>setSelected(p)}>
                  <td className="mono" style={{fontSize:'.72rem'}}>{new Date(p.dueDate).toLocaleDateString()}</td>
                  <td style={{fontSize:'.75rem'}}><span style={{color:'var(--t3)'}}>{p.propertyName||'—'}</span>{p.propertyName&&' · '}<span className="mono">{p.unitNumber||'—'}</span></td>
                  <td style={{fontSize:'.75rem'}}>{p.tenantFirst?`${p.tenantFirst} ${p.tenantLast}`:<span style={{color:'var(--t3)'}}>—</span>}</td>
                  <td><span className="badge bmu">{p.type}</span></td>
                  <td className="mono" style={{color:'var(--t0)',fontWeight:600}}>{formatCurrency(p.amount)}</td>
                  <td><span className={`badge ${ST[p.status]||'bmu'}`}>{p.status}</span></td>
                  <td>{p.returnCode?<span className={`badge ${p.zeroToleranceFlag?'br':'ba'}`}>{p.returnCode}</span>:<span style={{color:'var(--t3)'}}>—</span>}</td>
                </tr>
              )):<tr><td colSpan={7} style={{textAlign:'center',color:'var(--t3)',padding:32}}>{pSearch?'No payments match your search.':'No payments yet.'}</td></tr>}
            </tbody>
          </table>
        )}
      </div>
      {selected&&(
        <div style={{position:'fixed',inset:0,background:'rgba(0,0,0,.7)',zIndex:200,display:'flex',alignItems:'center',justifyContent:'center',padding:20}} onClick={e=>{if(e.target===e.currentTarget)setSelected(null)}}>
          <div style={{background:'var(--bg2)',border:'1px solid var(--b1)',borderRadius:12,padding:24,width:'100%',maxWidth:480}}>
            <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:20,paddingBottom:14,borderBottom:'1px solid var(--b0)'}}>
              <span style={{fontFamily:'var(--font-d)',fontWeight:700,color:'var(--t0)',fontSize:'1.1rem'}}>Payment Detail</span>
              <button onClick={()=>setSelected(null)} style={{background:'none',border:'none',color:'var(--t3)',fontSize:'1.2rem',cursor:'pointer'}}>✕</button>
            </div>
            <div className="dr"><span className="dk">Property</span><span className="dv">{selected.propertyName||'—'}</span></div>
            <div className="dr"><span className="dk">Unit</span><span className="dv mono">{selected.unitNumber||'—'}</span></div>
            <div className="dr"><span className="dk">Tenant</span><span className="dv">{selected.tenantFirst?`${selected.tenantFirst} ${selected.tenantLast}`:'—'}</span></div>
            {selected.tenantEmail&&<div className="dr"><span className="dk">Email</span><span className="dv" style={{fontSize:'.75rem'}}>{selected.tenantEmail}</span></div>}
            <div className="dr"><span className="dk">Type</span><span className="dv">{selected.type}</span></div>
            <div className="dr"><span className="dk">Amount</span><span className="dv mono" style={{color:'var(--gold)',fontWeight:700}}>{formatCurrency(selected.amount)}</span></div>
            <div className="dr"><span className="dk">Due Date</span><span className="dv mono">{new Date(selected.dueDate).toLocaleDateString()}</span></div>
            <div className="dr"><span className="dk">Status</span><span className={`badge ${ST[selected.status]||'bmu'}`}>{selected.status}</span></div>
            {selected.entryDescription&&<div className="dr"><span className="dk">Entry</span><span className="dv mono" style={{fontSize:'.72rem'}}>{selected.entryDescription}</span></div>}
            {selected.returnCode&&<div className="dr"><span className="dk">Return Code</span><span className={`badge ${selected.zeroToleranceFlag?'br':'ba'}`}>{selected.returnCode}</span></div>}
            {selected.zeroToleranceFlag&&<div className="alert ae" style={{marginTop:12}}>🚫 Zero-tolerance return — ACH suspended</div>}
          </div>
        </div>
      )}
    </div>
  )
}

function Disbursements(){
  const{user}=useAuth()
  const{data:disbs=[],isLoading}=useQuery<any[]>('disbs',()=>get('/disbursements'),{enabled:!!user})
  const[dSearch,setDSearch]=React.useState('')
  const filteredDisbs=React.useMemo(()=>dSearch?((disbs as any[]).filter((d:any)=>`${d.firstName||''} ${d.lastName||''} ${d.status}`.toLowerCase().includes(dSearch.toLowerCase()))):(disbs as any[]),[disbs,dSearch])
  return(
    <div>
      <div className="ph"><div><h1 className="pt">Disbursements</h1><p className="ps">On-Time Pay SLA — initiated on or before 1st business day</p></div></div>
      <div className="alert agold">⚡ <strong>On-Time Pay SLA:</strong> Platform initiates disbursements on the last business day before the 1st. Reserve funds the gap if tenant ACH hasn't settled.</div>
      <div className="card" style={{padding:0}}>
        <div style={{padding:'10px 12px',borderBottom:'1px solid var(--b0)'}}><input type="text" placeholder="Search disbursements…" value={dSearch} onChange={e=>setDSearch(e.target.value)} style={{width:'100%',background:'var(--bg3)',border:'1px solid var(--b1)',borderRadius:7,color:'var(--t0)',padding:'7px 10px',fontSize:'.78rem',outline:'none'}}/></div>
        {isLoading?<div style={{padding:32,color:'var(--t3)',textAlign:'center'}}>Loading…</div>:(
          <table className="tbl">
            <thead><tr><th>Landlord</th><th>Target Date</th><th>Amount</th><th>Units</th><th>Status</th><th>From Reserve</th><th>Settled</th></tr></thead>
            <tbody>
              {filteredDisbs.length?filteredDisbs.map((d:any)=>(
                <tr key={d.id}>
                  <td style={{fontSize:'.75rem'}}>{d.firstName} {d.lastName}</td>
                  <td className="mono" style={{fontSize:'.75rem'}}>{new Date(d.targetDate).toLocaleDateString()}</td>
                  <td className="mono" style={{color:'var(--green)',fontWeight:700}}>{formatCurrency(d.amount)}</td>
                  <td className="mono">{d.unitCount}</td>
                  <td><span className={`badge ${d.status==='settled'?'bg2':d.status==='pending'?'ba':'br'}`}>{d.status}</span></td>
                  <td>{d.fromReserve?<span className="badge bgold">Reserve {formatCurrency(d.reserveAmount)}</span>:<span style={{color:'var(--t3)'}}>—</span>}</td>
                  <td className="mono" style={{fontSize:'.72rem',color:'var(--t3)'}}>{d.settledAt?new Date(d.settledAt).toLocaleDateString():'—'}</td>
                </tr>
              )):<tr><td colSpan={7} style={{textAlign:'center',color:'var(--t3)',padding:32}}>No disbursements yet.</td></tr>}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}

// S164: Connect-readiness dashboard. Cross-account view of every Connect-
// bearing user / pm_company with cached readiness flags. Admin uses this
// for support — when a landlord calls saying "tenants can't pay," admin
// can verify if it's a Connect issue at a glance.
function ConnectAccounts() {
  const { user } = useAuth()
  const qc = useQueryClient()
  const [filter, setFilter] = React.useState<'all' | 'ready' | 'not_ready'>('all')
  const [search, setSearch] = React.useState('')
  const [busy, setBusy] = React.useState<Record<string, boolean>>({})
  const [errMsg, setErrMsg] = React.useState<string | null>(null)
  const [okMsg, setOkMsg] = React.useState<string | null>(null)

  type Acct = {
    entityType: 'user' | 'pm_company'
    entityId: string
    displayName: string
    email: string | null
    role: string | null
    stripeConnectAccountId: string
    connectChargesEnabled: boolean
    connectPayoutsEnabled: boolean
    connectDetailsSubmitted: boolean
    stripeConnectStatusSyncedAt: string | null
  }

  const { data: accounts = [], isLoading } = useQuery<Acct[]>(
    'admin-connect-accounts',
    () => get<Acct[]>('/admin/connect-readiness/accounts'),
    { enabled: !!user },
  )

  const filtered = (accounts as Acct[]).filter(a => {
    const ready = a.connectPayoutsEnabled && a.connectDetailsSubmitted
    if (filter === 'ready' && !ready) return false
    if (filter === 'not_ready' && ready) return false
    if (search && !`${a.displayName} ${a.email ?? ''} ${a.stripeConnectAccountId}`.toLowerCase().includes(search.toLowerCase())) return false
    return true
  })

  const refreshOne = async (a: Acct) => {
    const k = `${a.entityType}:${a.entityId}`
    setBusy(prev => ({ ...prev, [k]: true }))
    setErrMsg(null); setOkMsg(null)
    try {
      await api.post(`/admin/connect-readiness/refresh/${a.entityType}/${a.entityId}`)
      qc.invalidateQueries('admin-connect-accounts')
      setOkMsg(`Refreshed ${a.displayName}`)
    } catch (e: any) {
      setErrMsg(e?.response?.data?.error?.message || 'Refresh failed')
    } finally {
      setBusy(prev => ({ ...prev, [k]: false }))
    }
  }

  const runBackfill = async () => {
    if (!window.confirm('Run live Stripe lookup for every Connect account that isn’t already flagged ready? This may take a few seconds per account.')) return
    setErrMsg(null); setOkMsg(null)
    try {
      const r = await api.post<{ success: boolean; data: any }>('/admin/connect-readiness/backfill')
      qc.invalidateQueries('admin-connect-accounts')
      const d = r.data.data
      setOkMsg(`Backfill done: ${d.users.updated}/${d.users.scanned} users + ${d.pmCompanies.updated}/${d.pmCompanies.scanned} PM companies updated.`)
    } catch (e: any) {
      setErrMsg(e?.response?.data?.error?.message || 'Backfill failed')
    }
  }

  return (
    <div>
      <div className="ph">
        <div>
          <h1 className="pt">Connect Accounts</h1>
          <p className="ps">Stripe Connect Express readiness across landlords and PM companies.</p>
        </div>
        <button className="btn btn-primary" onClick={runBackfill}>Run Backfill</button>
      </div>

      {okMsg && <div className="alert agreen" style={{ marginBottom: 12 }}>{okMsg}</div>}
      {errMsg && <div className="alert ared" style={{ marginBottom: 12 }}>{errMsg}</div>}

      <div className="card" style={{ padding: 0 }}>
        <div style={{ padding: '10px 12px', borderBottom: '1px solid var(--b0)', display: 'flex', gap: 8, alignItems: 'center' }}>
          <input type="text" placeholder="Search name / email / account id…"
                 value={search} onChange={e => setSearch(e.target.value)}
                 style={{ flex: 1, background: 'var(--bg3)', border: '1px solid var(--b1)', borderRadius: 7, color: 'var(--t0)', padding: '7px 10px', fontSize: '.78rem', outline: 'none' }}/>
          <select value={filter} onChange={e => setFilter(e.target.value as any)}
                  style={{ background: 'var(--bg3)', border: '1px solid var(--b1)', borderRadius: 7, color: 'var(--t0)', padding: '7px 10px', fontSize: '.78rem' }}>
            <option value="all">All ({accounts.length})</option>
            <option value="ready">Ready</option>
            <option value="not_ready">Not ready</option>
          </select>
        </div>
        {isLoading ? (
          <div style={{ padding: 32, color: 'var(--t3)', textAlign: 'center' }}>Loading…</div>
        ) : (
          <table className="tbl">
            <thead>
              <tr>
                <th>Type</th><th>Name</th><th>Email</th>
                <th>Stripe Account</th>
                <th>Charges</th><th>Payouts</th><th>Details</th>
                <th>Last Synced</th><th>{' '}</th>
              </tr>
            </thead>
            <tbody>
              {filtered.length ? filtered.map(a => {
                const k = `${a.entityType}:${a.entityId}`
                return (
                  <tr key={k}>
                    <td style={{ fontSize: '.72rem', textTransform: 'uppercase', letterSpacing: '.04em', color: 'var(--t3)' }}>
                      {a.entityType}
                    </td>
                    <td style={{ fontSize: '.78rem', fontWeight: 600 }}>{a.displayName}</td>
                    <td style={{ fontSize: '.74rem', color: 'var(--t2)' }}>{a.email || '—'}</td>
                    <td className="mono" style={{ fontSize: '.7rem', color: 'var(--t3)' }}>
                      {a.stripeConnectAccountId.slice(0, 12)}…
                    </td>
                    <td><Bool v={a.connectChargesEnabled} /></td>
                    <td><Bool v={a.connectPayoutsEnabled} /></td>
                    <td><Bool v={a.connectDetailsSubmitted} /></td>
                    <td className="mono" style={{ fontSize: '.7rem', color: 'var(--t3)' }}>
                      {a.stripeConnectStatusSyncedAt ? new Date(a.stripeConnectStatusSyncedAt).toLocaleString() : '—'}
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <button className="btn btn-ghost btn-sm" disabled={!!busy[k]} onClick={() => refreshOne(a)}>
                        {busy[k] ? '…' : 'Refresh'}
                      </button>
                    </td>
                  </tr>
                )
              }) : (
                <tr><td colSpan={9} style={{ textAlign: 'center', color: 'var(--t3)', padding: 32 }}>
                  {accounts.length === 0 ? 'No Connect accounts yet.' : 'No matches.'}
                </td></tr>
              )}
            </tbody>
          </table>
        )}
      </div>

      <LandlordBankingNudgesSection />
    </div>
  )
}

// S165: tenant→landlord banking nudges (S163 feature). Surface here under
// Connect Accounts since that's where admin already lives when triaging
// onboarding-related support. Self-hides if no nudges have been sent.
function LandlordBankingNudgesSection() {
  const { user } = useAuth()
  const { data: nudges = [] } = useQuery<any[]>(
    'admin-landlord-banking-nudges',
    () => get<any[]>('/admin/landlord-banking-nudges'),
    { enabled: !!user },
  )
  if ((nudges as any[]).length === 0) return null

  return (
    <div className="card" style={{ padding: 0, marginTop: 16 }}>
      <div style={{ padding: '12px 14px', borderBottom: '1px solid var(--b0)' }}>
        <div style={{ fontWeight: 600 }}>Landlord Banking Nudges</div>
        <div style={{ fontSize: '.72rem', color: 'var(--t3)', marginTop: 2 }}>
          Tenants pinging landlords to finish Connect onboarding. Last 200.
        </div>
      </div>
      <table className="tbl">
        <thead>
          <tr>
            <th>Date</th><th>Tenant</th><th>Landlord</th>
            <th>Email Status</th><th>Landlord Now Ready</th>
          </tr>
        </thead>
        <tbody>
          {(nudges as any[]).map(n => {
            const ready = n.landlordPayoutsEnabled && n.landlordDetailsSubmitted
            return (
              <tr key={n.id}>
                <td className="mono" style={{ fontSize: '.72rem' }}>
                  {new Date(n.createdAt).toLocaleString()}
                </td>
                <td style={{ fontSize: '.78rem' }}>{n.tenantName ?? '— deleted —'}</td>
                <td style={{ fontSize: '.78rem' }}>
                  <div>{n.landlordName ?? '—'}</div>
                  <div style={{ fontSize: '.7rem', color: 'var(--t3)' }}>{n.landlordEmail}</div>
                </td>
                <td>
                  <span className={`badge ${n.status === 'sent' ? 'bg2' : 'br'}`}>{n.status}</span>
                  {n.errorMessage && (
                    <div style={{ fontSize: '.68rem', color: 'var(--red)', marginTop: 2 }}>{n.errorMessage}</div>
                  )}
                </td>
                <td><Bool v={!!ready} /></td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function Bool({ v }: { v: boolean }) {
  return (
    <span style={{
      padding: '2px 8px', borderRadius: 12, fontSize: '.66rem', fontWeight: 600,
      background: v ? 'rgba(38,167,90,.16)' : 'rgba(160,160,160,.16)',
      color: v ? 'var(--green, #2ea35a)' : 'var(--t3)',
    }}>{v ? 'YES' : 'NO'}</span>
  )
}

function Reserve(){
  const{user}=useAuth()
  const{data:stats}=useQuery('admin-overview',()=>get<any>('/admin/overview'),{enabled:!!user})
  const{phase,rate}=getReservePhase(stats?.activeUnits||0)
  const target=(stats?.activeUnits||0)*600*RESERVE_CONFIG.DEFAULT_RATE*RESERVE_CONFIG.TARGET_MONTHS
  const pct=target>0?Math.min(((stats?.reserveBalance||0)/target)*100,100):0
  return(
    <div>
      <div className="ph"><div><h1 className="pt">Reserve &amp; Float</h1><p className="ps">On-Time Pay operational capital</p></div></div>
      <div className="grid2" style={{marginBottom:16}}>
        <div className="card">
          <div className="ct">Default Reserve Fund</div>
          <div className="dr"><span className="dk">Balance</span><span className="dv mono" style={{color:pct>=100?'var(--green)':pct>=50?'var(--amber)':'var(--red)'}}>{formatCurrency(stats?.reserveBalance||0)}</span></div>
          <div className="dr"><span className="dk">Target (3-mo defaults)</span><span className="dv mono">{formatCurrency(target)}</span></div>
          <div className="dr"><span className="dk">Coverage</span><span className={`badge ${pct>=100?'bg2':pct>=50?'ba':'br'}`}>{pct.toFixed(0)}%</span></div>
          <div className="dr"><span className="dk">Phase</span><span className={`badge ${phase===1?'ba':phase===2?'bb':'bg2'}`}>Phase {phase} — {(rate*100).toFixed(0)}% contribution rate</span></div>
          <div style={{marginTop:14,fontSize:'.78rem',color:'var(--t3)',lineHeight:1.5}}>
            Reserve is operational working capital — NOT insurance reserves. Platform fulfills Disbursement SLA as service obligation per agent-of-payee structure.<br/><strong style={{color:'var(--amber)'}}>Attorney review required before launch.</strong>
          </div>
        </div>
        <div className="card">
          <div className="ct">Float Account</div>
          <div className="dr"><span className="dk">Balance</span><span className="dv mono" style={{color:'var(--blue)'}}>{formatCurrency(stats?.floatBalance||0)}</span></div>
          <div className="dr"><span className="dk">Seed capital</span><span className="dv mono">$25,000</span></div>
          <div className="dr"><span className="dk">APY</span><span className="dv mono">4.5%</span></div>
          <div className="dr"><span className="dk">Monthly interest</span><span className="dv mono" style={{color:'var(--green)'}}>+{formatCurrency((stats?.floatBalance||0)*.045/12)}</span></div>
          <div className="dr"><span className="dk">Float covers</span><span className="dv mono">{stats?.floatBalance&&stats?.monthlyRentVolume?((stats.floatBalance/stats.monthlyRentVolume)*100).toFixed(0)+'%':'—'} of monthly disbursements</span></div>
          <div style={{marginTop:14,fontSize:'.78rem',color:'var(--t3)'}}>Platform fronts full month rent from float before tenant ACH settles. Standard tenants: 3-day float. SSI/SSDI: 19-day float.</div>
        </div>
      </div>
    </div>
  )
}

function Tenants(){
  const{user}=useAuth()
  const{data:tenants=[],isLoading}=useQuery<any[]>('admin-tenants-page',()=>get('/admin/tenants'),{enabled:!!user,refetchOnWindowFocus:false})
  const sortedTenants=React.useMemo(()=>[...(tenants as any[])].sort((a,b)=>{
    const aInc=(!a.achVerified||(!a.onTimePayEnrolled&&!a.creditReportingEnrolled&&!a.flexDepositEnrolled&&!a.floatFeeActive))?0:1
    const bInc=(!b.achVerified||(!b.onTimePayEnrolled&&!b.creditReportingEnrolled&&!b.flexDepositEnrolled&&!b.floatFeeActive))?0:1
    return aInc-bInc
  }),[tenants])
  const[tSearch,setTSearch]=React.useState('')
  const filteredTenants=React.useMemo(()=>tSearch?sortedTenants.filter((t:any)=>`${t.firstName} ${t.lastName} ${t.email} ${t.unitNumber||''} ${t.propertyName||""}`.toLowerCase().includes(tSearch.toLowerCase())):sortedTenants,[sortedTenants,tSearch])
  const[selected,setSelected]=React.useState<any>(null)
  const{data:detail}=useQuery(['tenant-detail',selected?.id],()=>get<any>('/admin/onboarding/tenant/'+selected.id),{enabled:!!selected?.id,staleTime:15000})
  // S315: FlexSuite enrollment-acceptance audit rows for this tenant.
  // Read-only forensic surface — used to verify what populated terms a
  // tenant click-accepted at FlexPay / FlexDeposit enrollment.
  const{data:acceptances=[]}=useQuery<any[]>(['tenant-acceptances',selected?.id],()=>get('/admin/tenants/'+selected.id+'/flexsuite-acceptances'),{enabled:!!selected?.id,staleTime:30000})
  const[viewing,setViewing]=React.useState<any>(null)
  const[resending,setResending]=React.useState<string|null>(null)
  const[msg,setMsg]=React.useState('')

  const resend=async(type:string,id:string)=>{
    setResending(type)
    try{ await post('/admin/onboarding/resend',{type,targetId:id}); setMsg('Notification queued'); setTimeout(()=>setMsg(''),3000) }
    catch(e:any){ setMsg('Failed: '+e.message) }
    finally{ setResending(null) }
  }

  return(
    <div>
      <div className="ph"><div><h1 className="pt">Tenants</h1><p className="ps">{(tenants as any[]).length} registered</p></div></div>
      {msg&&<div className={`alert ${msg.startsWith('F')?'ae':'ag'}`} style={{marginBottom:12}}>{msg}</div>}
      <div className="grid2" style={{gap:16,alignItems:'start'}}>
        <div className="card" style={{padding:0}}>
          <div style={{padding:'10px 12px',borderBottom:'1px solid var(--b0)'}}><input type="text" placeholder="Search tenants…" value={tSearch} onChange={e=>setTSearch(e.target.value)} style={{width:'100%',background:'var(--bg3)',border:'1px solid var(--b1)',borderRadius:7,color:'var(--t0)',padding:'7px 10px',fontSize:'.78rem',outline:'none'}}/></div>
          {isLoading?<div style={{padding:32,color:'var(--t3)',textAlign:'center'}}>Loading…</div>:(
            <table className="tbl">
              <thead><tr><th>Tenant</th><th>Unit</th><th>ACH</th><th>Flex</th><th>Late</th></tr></thead>
              <tbody>
                {filteredTenants.map((t:any)=>(
                  <tr key={t.id} style={{cursor:'pointer',background:selected?.id===t.id?'rgba(201,162,39,.05)':''}} onClick={()=>setSelected(t)}>
                    <td><div style={{fontWeight:600,color:'var(--t0)',fontSize:'.78rem'}}>{t.firstName} {t.lastName}</div><div style={{fontSize:'.65rem',color:'var(--t3)'}}>{t.email}</div></td>
                    <td style={{fontSize:'.72rem'}}>{t.unitNumber?<span><span style={{color:'var(--t3)'}}>{t.propertyName}</span> · {t.unitNumber}</span>:<span style={{color:'var(--t3)'}}>—</span>}</td>
                    <td><span className={`badge ${t.achVerified?'bg2':'br'}`}>{t.achVerified?'✓':'No'}</span></td>
                    <td><span className={`badge ${(t.onTimePayEnrolled||t.creditReportingEnrolled||t.flexDepositEnrolled||t.floatFeeActive)?'bg2':'bmu'}`}>{(t.onTimePayEnrolled||t.creditReportingEnrolled||t.flexDepositEnrolled||t.floatFeeActive)?'Active':'None'}</span></td>
                    <td className="mono" style={{color:(t.latePaymentCount||0)>1?'var(--amber)':'var(--t3)'}}>{t.latePaymentCount||0}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <div>
          {!selected&&<div className="card" style={{textAlign:'center',padding:'48px 20px',color:'var(--t3)'}}>Select a tenant to view details</div>}
          {selected&&detail&&(
            <div className="card">
              <div style={{marginBottom:16,paddingBottom:12,borderBottom:'1px solid var(--b0)'}}>
                <div style={{fontFamily:'var(--font-d)',fontWeight:800,fontSize:'1.1rem',color:'var(--t0)'}}>{detail.tenant.firstName} {detail.tenant.lastName}</div>
                <div style={{fontSize:'.72rem',color:'var(--t3)',marginTop:2}}>{detail.tenant.email}</div>
                {detail.tenant.phone&&<div style={{fontSize:'.72rem',color:'var(--t3)',marginTop:2}}>{detail.tenant.phone}</div>}
                {detail.tenant.unitNumber&&<div style={{fontSize:'.72rem',color:'var(--t2)',marginTop:4}}>{detail.tenant.propertyName} · Unit {detail.tenant.unitNumber}</div>}
                {detail.tenant.landlordFirst&&<div style={{fontSize:'.72rem',color:'var(--t3)',marginTop:2}}>Landlord: {detail.tenant.landlordFirst} {detail.tenant.landlordLast}</div>}
              </div>
              <div className="ct">Onboarding Checklist</div>
              {detail.checklist.map((item:any)=>(
                <div key={item.key} style={{display:'flex',alignItems:'center',gap:10,padding:'7px 0',borderBottom:'1px solid var(--b0)'}}>
                  <span>{item.done?'✅':'⬜'}</span>
                  <span style={{fontSize:'.82rem',color:item.done?'var(--t0)':'var(--t2)',flex:1}}>{item.label}</span>
                  {!item.done&&<span className="badge br">Incomplete</span>}
                </div>
              ))}
              <div style={{marginTop:16,display:'flex',flexDirection:'column',gap:8}}>
                <button className="btn bg-btn" disabled={!!resending} onClick={()=>resend('tenant_invite',selected.id)}>
                  {resending==='tenant_invite'?'Sending…':'📧 Resend Invite'}
                </button>
                {!detail.tenant.achVerified&&(
                  <button className="btn bg-btn" disabled={!!resending} onClick={()=>resend('ach_enrollment',selected.id)}>
                    {resending==='ach_enrollment'?'Sending…':'🏦 Resend ACH Enrollment'}
                  </button>
                )}
              </div>

              {/* S315: FlexSuite enrollment-acceptance records */}
              <div style={{marginTop:20,paddingTop:16,borderTop:'1px solid var(--b0)'}}>
                <div className="ct">FlexSuite Acceptances</div>
                {(acceptances as any[]).length===0?(
                  <div style={{fontSize:'.72rem',color:'var(--t3)',padding:'8px 0'}}>No FlexPay or FlexDeposit enrollments recorded.</div>
                ):(
                  <div style={{display:'flex',flexDirection:'column',gap:6}}>
                    {(acceptances as any[]).map((a:any)=>(
                      <div key={a.id} style={{display:'flex',alignItems:'center',gap:10,padding:'8px 10px',background:'var(--bg3)',border:'1px solid var(--b1)',borderRadius:6}}>
                        <span className={`badge ${a.productType==='flexpay'?'bb':'bg2'}`} style={{minWidth:84,textAlign:'center'}}>{a.productType==='flexpay'?'FlexPay':'FlexDeposit'}</span>
                        <div style={{flex:1,fontSize:'.7rem',color:'var(--t2)'}}>
                          <div style={{color:'var(--t1)',fontWeight:600}}>{new Date(a.acceptedAt).toLocaleString()}</div>
                          <div style={{color:'var(--t3)',fontSize:'.65rem',marginTop:2}}>v{a.templateVersion} · sha {a.contentHash.slice(0,10)}{a.acceptedIp?' · '+a.acceptedIp:''}</div>
                        </div>
                        <button
                          type="button"
                          className="btn bg-btn"
                          style={{padding:'4px 10px',fontSize:'.7rem'}}
                          onClick={()=>setViewing(a)}>
                          View
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {viewing && (
        <div className="modal-ov" onClick={()=>setViewing(null)}>
          <div className="modal" onClick={e=>e.stopPropagation()} style={{maxWidth:780,maxHeight:'85vh',display:'flex',flexDirection:'column'}}>
            <div className="modal-t">
              {viewing.productType==='flexpay'?'FlexPay Subscription Terms':'FlexDeposit Service Agreement'}
              <span style={{fontSize:'.7rem',color:'var(--t3)',fontWeight:400,marginLeft:10}}>
                v{viewing.templateVersion} · accepted {new Date(viewing.acceptedAt).toLocaleString()}
              </span>
            </div>
            <div style={{fontSize:'.68rem',color:'var(--t3)',marginBottom:10,fontFamily:'var(--font-m)'}}>
              SHA-256: {viewing.contentHash}
              {viewing.acceptedIp && <> · IP: {viewing.acceptedIp}</>}
              {viewing.accepterEmail && <> · Accepter: {viewing.accepterEmail}</>}
            </div>
            <div style={{
              flex:1,overflowY:'auto',background:'var(--bg3)',border:'1px solid var(--b1)',
              borderRadius:8,padding:18,marginBottom:14,
              fontFamily:'var(--font-m)',fontSize:'.7rem',lineHeight:1.55,color:'var(--t1)',
              whiteSpace:'pre-wrap',
            }}>{viewing.renderedText}</div>
            <div className="modal-f">
              <button className="btn btn-p" onClick={()=>setViewing(null)}>Close</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}



function Maintenance(){
  const{user}=useAuth()
  const{data:reqs=[],isLoading}=useQuery<any[]>('maint',()=>get('/maintenance'),{enabled:!!user})
  const PRI:Record<string,string>={emergency:'br',high:'ba',normal:'bb',low:'bmu'}
  const ST:Record<string,string>={open:'ba',assigned:'bb',in_progress:'bb',completed:'bg2',cancelled:'bmu'}
  return(
    <div>
      <div className="ph"><div><h1 className="pt">Maintenance</h1><p className="ps">8% platform fee on all completed jobs</p></div></div>
      <div className="card" style={{padding:0,overflowX:'auto'}}>
        {isLoading?<div style={{padding:32,color:'var(--t3)',textAlign:'center'}}>Loading…</div>:(
          <table className="tbl" style={{minWidth:920}}>
            <thead><tr><th>Date</th><th>Unit</th><th>Title</th><th>Priority</th><th>Status</th><th>Contractor</th><th>Cost</th><th>Fee (8%)</th></tr></thead>
            <tbody>
              {reqs.length?reqs.map((r:any)=>(
                <tr key={r.id}>
                  <td className="mono" style={{fontSize:'.7rem'}}>{new Date(r.createdAt).toLocaleDateString()}</td>
                  <td className="mono">{r.unitNumber}</td>
                  <td style={{color:'var(--t0)',fontSize:'.78rem'}}>{r.title}</td>
                  <td><span className={`badge ${PRI[r.priority]}`}>{r.priority}</span></td>
                  <td><span className={`badge ${ST[r.status]}`}>{r.status.replace('_',' ')}</span></td>
                  <td style={{fontSize:'.75rem'}}>{r.contractorName||<span style={{color:'var(--t3)'}}>Unassigned</span>}</td>
                  <td className="mono">{r.actualCost?formatCurrency(r.actualCost):'—'}</td>
                  <td className="mono" style={{color:'var(--gold)'}}>{r.platformFee?formatCurrency(r.platformFee):'—'}</td>
                </tr>
              )):<tr><td colSpan={8} style={{textAlign:'center',color:'var(--t3)',padding:32}}>No maintenance requests.</td></tr>}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}


// ── BULLETIN BOARD (super_admin) ──────────────────────────────
function BulletinBoard(){
  const{user}=useAuth()
  const isSuperAdmin=user?.role==='super_admin'
  const[revealedIds,setRevealedIds]=React.useState<Record<string,any>>({})
  const[revealLoading,setRevealLoading]=React.useState<string|null>(null)
  const[filterTab,setFilterTab]=React.useState<'all'|'flagged'|'pinned'>('all')
  const[bSearch,setBSearch]=React.useState('')
  const[bDate,setBDate]=React.useState(new Date().toISOString().split('T')[0])

  const{data:posts=[],isLoading,refetch}=useQuery<any[]>(['bulletin-admin',bDate],()=>get('/admin/bulletin?date='+bDate),{enabled:!!user,staleTime:15000})

  const searched = bSearch?(posts as any[]).filter((p:any)=>`${p.content} ${p.alias}`.toLowerCase().includes(bSearch.toLowerCase())):(posts as any[])
  const filtered = filterTab==='flagged'
    ? searched.filter((p:any)=>p.flagCount>0)
    : filterTab==='pinned'
      ? searched.filter((p:any)=>p.pinned)
      : searched

  const revealIdentity=async(postId:string)=>{
    if(!isSuperAdmin)return
    setRevealLoading(postId)
    try{
      const res=await get<any>('/admin/bulletin/'+postId+'/reveal')
      setRevealedIds(r=>({...r,[postId]:res}))
    }catch(e:any){alert('Could not reveal: '+e.message)}
    finally{setRevealLoading(null)}
  }

  const pinPost=async(postId:string,pin:boolean)=>{
    await post('/admin/bulletin/'+postId+'/pin',{pin})
    refetch()
  }

  const removePost=async(postId:string)=>{
    if(!confirm('Remove this post from the bulletin board?'))return
    await post('/admin/bulletin/'+postId+'/remove',{})
    refetch()
  }

  return(
    <div>
      <div className="ph">
        <div><h1 className="pt">Community Bulletin Board</h1><p className="ps">Anonymous posts across all properties{isSuperAdmin?' · Identity reveal enabled':''}</p></div>
        {!isSuperAdmin&&<span className="badge ba">Read-only — super_admin required for reveals</span>}
        {isSuperAdmin&&<span className="badge bgold">super_admin · Identity reveal active</span>}
      </div>

      {isSuperAdmin&&<div className="alert agold" style={{marginBottom:16}}>⚠ Identity reveals are logged and auditable. Only reveal for legitimate moderation purposes.</div>}
      <div style={{display:'flex',gap:10,marginBottom:16,alignItems:'center'}}>
        <input type="date" value={bDate} onChange={e=>setBDate(e.target.value)} style={{background:'var(--bg2)',border:'1px solid var(--b1)',borderRadius:7,color:'var(--t0)',padding:'7px 10px',fontSize:'.78rem',outline:'none'}}/>
        <input type="text" placeholder="Search posts…" value={bSearch} onChange={e=>setBSearch(e.target.value)} style={{flex:1,background:'var(--bg2)',border:'1px solid var(--b1)',borderRadius:7,color:'var(--t0)',padding:'7px 10px',fontSize:'.78rem',outline:'none'}}/>
        <button className="btn bg bsm" onClick={()=>setBDate(new Date().toISOString().split('T')[0])}>Today</button>
      </div>

      <div className="tabs" style={{marginBottom:20}}>
        <button className={"tab "+(filterTab==='all'?'on':'')} onClick={()=>setFilterTab('all')}>All Posts ({searched.length})</button>
        <button className={"tab "+(filterTab==='flagged'?'on':'')} onClick={()=>setFilterTab('flagged')} style={{color:(posts as any[]).filter((p:any)=>p.flagCount>0).length>0?'var(--red)':undefined}}>
          Flagged ({(posts as any[]).filter((p:any)=>p.flagCount>0).length})
        </button>
        <button className={"tab "+(filterTab==='pinned'?'on':'')} onClick={()=>setFilterTab('pinned')}>Pinned ({(posts as any[]).filter((p:any)=>p.pinned).length})</button>
      </div>

      {isLoading?<div style={{padding:32,color:'var(--t3)',textAlign:'center'}}>Loading...</div>:(
        <div style={{display:'grid',gap:12}}>
          {filtered.length?(filtered as any[]).map((post:any)=>(
            <div key={post.id} className="card" style={{borderColor:post.flagCount>=3?'rgba(239,68,68,.4)':post.pinned?'rgba(201,162,39,.3)':'var(--b1)'}}>
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',gap:16}}>
                <div style={{flex:1}}>
                  <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:8,flexWrap:'wrap'}}>
                    <span style={{fontFamily:'var(--font-m)',fontSize:'.72rem',color:'var(--gold)',fontWeight:600}}>{post.alias}</span>
                    {post.pinned&&<span className="badge bgold">📌 Pinned</span>}
                    {post.flagCount>=3&&<span className="badge br">🚩 {post.flagCount} flags</span>}
                    {post.flagCount>0&&post.flagCount<3&&<span className="badge ba">🚩 {post.flagCount} flag{post.flagCount>1?'s':''}</span>}
                    <span className="badge bmu">{post.scope}</span>
                    <span style={{fontSize:'.68rem',color:'var(--t3)',marginLeft:'auto'}}>{new Date(post.createdAt).toLocaleDateString()}</span>
                  </div>
                  <div style={{fontSize:'.85rem',color:'var(--t1)',lineHeight:1.6,marginBottom:10}}>{post.content}</div>
                  <div style={{display:'flex',gap:12,fontSize:'.72rem',color:'var(--t3)'}}>
                    <span>👍 {post.voteCount||0} votes</span>
                    <span>💬 {post.replyCount||0} replies</span>
                    <span>🏠 {post.propertyName||'Platform-wide'}</span>
                  </div>

                  {revealedIds[post.id]&&(
                    <div style={{marginTop:12,background:'rgba(239,68,68,.06)',border:'1px solid rgba(239,68,68,.2)',borderRadius:8,padding:'10px 14px'}}>
                      <div style={{fontSize:'.68rem',color:'var(--red)',fontWeight:700,textTransform:'uppercase',letterSpacing:'.06em',marginBottom:6}}>Identity Revealed — Confidential</div>
                      <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:6,fontSize:'.78rem'}}>
                        <div><span style={{color:'var(--t3)'}}>Name: </span><strong style={{color:'var(--t0)'}}>{revealedIds[post.id].firstName} {revealedIds[post.id].lastName}</strong></div>
                        <div><span style={{color:'var(--t3)'}}>Email: </span><span style={{color:'var(--t0)'}}>{revealedIds[post.id].email}</span></div>
                        <div><span style={{color:'var(--t3)'}}>Unit: </span><span style={{color:'var(--t0)'}}>{revealedIds[post.id].unitNumber||'—'}</span></div>
                        <div><span style={{color:'var(--t3)'}}>Alias was: </span><span style={{fontFamily:'var(--font-m)',color:'var(--gold)'}}>{post.alias}</span></div>
                      </div>
                    </div>
                  )}
                </div>

                <div style={{display:'flex',flexDirection:'column',gap:6,flexShrink:0}}>
                  {isSuperAdmin&&!revealedIds[post.id]&&(
                    <button className="btn bd bsm" onClick={()=>revealIdentity(post.id)} disabled={revealLoading===post.id} style={{whiteSpace:'nowrap'}}>
                      {revealLoading===post.id?'Revealing...':'🔍 Reveal'}
                    </button>
                  )}
                  {isSuperAdmin&&(
                    <button className="btn bg bsm" onClick={()=>pinPost(post.id,!post.pinned)}>
                      {post.pinned?'Unpin':'📌 Pin'}
                    </button>
                  )}
                  {isSuperAdmin&&(
                    <button className="btn bd bsm" style={{color:'var(--red)'}} onClick={()=>removePost(post.id)}>Remove</button>
                  )}
                </div>
              </div>
            </div>
          )):<div className="empty">No posts{filterTab!=='all'?' matching this filter':''}.</div>}
        </div>
      )}
    </div>
  )
}

// ── AUDIT LOG (super_admin) ───────────────────────────────────
function AuditLog(){
  const[actionType,setActionType]=React.useState('')
  const[adminUserId,setAdminUserId]=React.useState('')
  const[targetId,setTargetId]=React.useState('')
  const[from,setFrom]=React.useState('')
  const[to,setTo]=React.useState('')
  const[page,setPage]=React.useState(0)
  const[expanded,setExpanded]=React.useState<Record<string,boolean>>({})
  const limit=100
  const qs=React.useMemo(()=>{
    const p=new URLSearchParams()
    if(actionType)p.set('action_type',actionType)
    if(adminUserId)p.set('admin_user_id',adminUserId)
    if(targetId)p.set('target_id',targetId)
    if(from)p.set('from',from)
    if(to)p.set('to',to)
    p.set('limit',String(limit))
    p.set('offset',String(page*limit))
    return p.toString()
  },[actionType,adminUserId,targetId,from,to,page])
  const{data,isLoading}=useQuery(['audit-log',qs],()=>get<{rows:any[];total:number;actionTypes:string[];admins:any[]}>('/admin/audit-log?'+qs),{keepPreviousData:true})
  const rows=data?.rows||[]
  const total=data?.total||0
  const actionTypes=data?.actionTypes||[]
  const admins=data?.admins||[]
  const totalPages=Math.max(1,Math.ceil(total/limit))
  const resetFilters=()=>{setActionType('');setAdminUserId('');setTargetId('');setFrom('');setTo('');setPage(0)}
  const onFilter=<T,>(setter:(v:T)=>void)=>(v:T)=>{setter(v);setPage(0)}
  const fmtTs=(d:string)=>new Date(d).toLocaleString()
  const adminLabel=(r:any)=>{
    const name=[r.adminFirstName,r.adminLastName].filter(Boolean).join(' ')
    return name?`${name} (${r.adminEmail||'—'})`:(r.adminEmail||r.adminUserId)
  }
  return(
    <div>
      <div className="ph">
        <div><h1 className="pt">Admin Audit Log</h1><p className="ps">Every admin-driven action against another user's data. Read-only.</p></div>
        <span className="badge bgold">super_admin only</span>
      </div>
      <div className="card" style={{marginBottom:16}}>
        <div style={{display:'grid',gridTemplateColumns:'repeat(5,1fr) auto',gap:10,alignItems:'end'}}>
          <div>
            <label style={{display:'block',fontSize:'.68rem',color:'var(--t3)',marginBottom:4,textTransform:'uppercase',letterSpacing:'.06em'}}>Action</label>
            <select value={actionType} onChange={e=>onFilter(setActionType)(e.target.value)} style={{width:'100%',background:'var(--bg2)',border:'1px solid var(--b1)',borderRadius:7,color:'var(--t0)',padding:'7px 10px',fontSize:'.78rem',outline:'none'}}>
              <option value="">All actions</option>
              {actionTypes.map(a=><option key={a} value={a}>{a}</option>)}
            </select>
          </div>
          <div>
            <label style={{display:'block',fontSize:'.68rem',color:'var(--t3)',marginBottom:4,textTransform:'uppercase',letterSpacing:'.06em'}}>Admin</label>
            <select value={adminUserId} onChange={e=>onFilter(setAdminUserId)(e.target.value)} style={{width:'100%',background:'var(--bg2)',border:'1px solid var(--b1)',borderRadius:7,color:'var(--t0)',padding:'7px 10px',fontSize:'.78rem',outline:'none'}}>
              <option value="">All admins</option>
              {admins.map((a:any)=><option key={a.id} value={a.id}>{[a.firstName,a.lastName].filter(Boolean).join(' ')||a.email}{a.role==='super_admin'?' ★':''}</option>)}
            </select>
          </div>
          <div>
            <label style={{display:'block',fontSize:'.68rem',color:'var(--t3)',marginBottom:4,textTransform:'uppercase',letterSpacing:'.06em'}}>Target ID</label>
            <input value={targetId} onChange={e=>onFilter(setTargetId)(e.target.value)} placeholder="UUID" style={{width:'100%',background:'var(--bg2)',border:'1px solid var(--b1)',borderRadius:7,color:'var(--t0)',padding:'7px 10px',fontSize:'.78rem',outline:'none',fontFamily:'var(--font-m)'}}/>
          </div>
          <div>
            <label style={{display:'block',fontSize:'.68rem',color:'var(--t3)',marginBottom:4,textTransform:'uppercase',letterSpacing:'.06em'}}>From</label>
            <input type="date" value={from} onChange={e=>onFilter(setFrom)(e.target.value)} style={{width:'100%',background:'var(--bg2)',border:'1px solid var(--b1)',borderRadius:7,color:'var(--t0)',padding:'7px 10px',fontSize:'.78rem',outline:'none'}}/>
          </div>
          <div>
            <label style={{display:'block',fontSize:'.68rem',color:'var(--t3)',marginBottom:4,textTransform:'uppercase',letterSpacing:'.06em'}}>To</label>
            <input type="date" value={to} onChange={e=>onFilter(setTo)(e.target.value)} style={{width:'100%',background:'var(--bg2)',border:'1px solid var(--b1)',borderRadius:7,color:'var(--t0)',padding:'7px 10px',fontSize:'.78rem',outline:'none'}}/>
          </div>
          <button className="btn bd bsm" onClick={resetFilters}>Reset</button>
        </div>
      </div>

      <div className="card" style={{padding:0,overflow:'hidden'}}>
        {isLoading?<div style={{padding:32,color:'var(--t3)',textAlign:'center'}}>Loading…</div>:
         rows.length===0?<div className="empty">No audit rows match these filters.</div>:
         <table className="tbl">
          <thead>
            <tr>
              <th style={{width:160}}>When</th>
              <th>Admin</th>
              <th>Action</th>
              <th>Target</th>
              <th>Notes</th>
              <th style={{width:90}}></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r:any)=>(
              <React.Fragment key={r.id}>
                <tr>
                  <td style={{whiteSpace:'nowrap',fontSize:'.72rem',color:'var(--t2)'}}>{fmtTs(r.createdAt)}</td>
                  <td style={{fontSize:'.74rem'}}>{adminLabel(r)}{r.adminRole==='super_admin'&&<span className="badge bgold" style={{marginLeft:6}}>super</span>}</td>
                  <td><span className="badge bmu" style={{fontFamily:'var(--font-m)'}}>{r.actionType}</span></td>
                  <td style={{fontSize:'.72rem',color:'var(--t2)'}}>
                    {r.targetType?<span style={{color:'var(--t3)'}}>{r.targetType}: </span>:null}
                    {r.targetId?<span style={{fontFamily:'var(--font-m)'}}>{r.targetId}</span>:<span style={{color:'var(--t3)'}}>—</span>}
                  </td>
                  <td style={{fontSize:'.74rem',color:'var(--t1)',maxWidth:320,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}} title={r.notes||''}>{r.notes||<span style={{color:'var(--t3)'}}>—</span>}</td>
                  <td style={{textAlign:'right'}}>
                    {(r.metadata||r.ipAddress)&&<button className="btn bd bsm" onClick={()=>setExpanded(x=>({...x,[r.id]:!x[r.id]}))}>{expanded[r.id]?'Hide':'Details'}</button>}
                  </td>
                </tr>
                {expanded[r.id]&&(
                  <tr>
                    <td colSpan={6} style={{background:'var(--bg2)',padding:12}}>
                      {r.ipAddress&&<div style={{fontSize:'.72rem',color:'var(--t2)',marginBottom:6}}><span style={{color:'var(--t3)'}}>IP: </span><span style={{fontFamily:'var(--font-m)'}}>{r.ipAddress}</span></div>}
                      {r.metadata&&<pre style={{margin:0,fontFamily:'var(--font-m)',fontSize:'.7rem',color:'var(--t1)',background:'var(--bg1)',border:'1px solid var(--b1)',borderRadius:6,padding:10,overflow:'auto',maxHeight:300}}>{JSON.stringify(r.metadata,null,2)}</pre>}
                    </td>
                  </tr>
                )}
              </React.Fragment>
            ))}
          </tbody>
         </table>}
      </div>

      <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginTop:12,fontSize:'.74rem',color:'var(--t3)'}}>
        <div>{total.toLocaleString()} row{total===1?'':'s'} · page {page+1} of {totalPages}</div>
        <div style={{display:'flex',gap:8}}>
          <button className="btn bd bsm" disabled={page===0} onClick={()=>setPage(p=>Math.max(0,p-1))}>← Prev</button>
          <button className="btn bd bsm" disabled={page>=totalPages-1} onClick={()=>setPage(p=>p+1)}>Next →</button>
        </div>
      </div>
    </div>
  )
}

// ── CSV IMPORT REVIEW QUEUE (S295) ────────────────────────────
// Super-admin-only review surface for the CSV-import attempts
// captured by services/csvImportAttempts.ts on the backend.
// Lists every validate + commit captured from a landlord's
// onboarding flow, with column-headers + first-5 sample rows
// visible to verify mapping accuracy against real source-platform
// exports. Mark-reviewed flips status from 'validated'/'committed'
// to 'reviewed' so the pending queue thins as we work it.
type CsvImportAttemptRow={
  id:string;landlordId:string;landlordFirstName:string;landlordLastName:string;landlordEmail:string;
  importType:'tenant'|'property'|'payment';platformKey:string;claimedPlatformName:string|null;
  rowCount:number;blockers:number;warnings:number;columnCount:number;
  status:'validated'|'committed'|'reviewed';
  reviewedAt:string|null;createdAt:string;
}
type CsvImportAttemptDetail=CsvImportAttemptRow&{
  columnHeaders:string[];sampleRows:Record<string,any>[];
  reviewerFirstName:string|null;reviewerLastName:string|null;
  /** S298: id of the most-recent preceding validate row for the
   *  same landlord+platform+type. Lets the modal cross-link from
   *  commit rows (which carry empty column_headers / sample_rows)
   *  to the validate row that captured the actual shape. */
  relatedValidateAttemptId?:string|null
}
type PlatformReviewStatus={
  platformKey:string;importType:string;
  mappingStatus:'unverified'|'verified';
  verifiedAt:string|null;verifiedBy:string|null;
  verifierFirstName:string|null;verifierLastName:string|null;
  notes:string|null;
  committedCount:number;distinctLandlords:number;
  mostRecentCommit:string|null;
}
type PlatformClaimCandidate={
  normalizedName:string;
  distinctLandlords:number;totalMentions:number;
  mostRecentMention:string;
  rawNameVariants:string[];
  importTypes:string[];
}

// S316: extracted from CsvImports so each card can hold its own notes
// edit state without lifting a per-slot map into the parent. Receives
// verify/unverify mutations from the parent (they live next to the
// shared query-invalidation set).
function PlatformStatusCard({
  s, isSuperAdmin, platformLabel, verifyMut, unverifyMut,
}: {
  s: PlatformReviewStatus
  isSuperAdmin: boolean
  platformLabel: (k: string) => string
  verifyMut: any
  unverifyMut: any
}) {
  const verified = s.mappingStatus === 'verified'
  const busy = verifyMut.isLoading || unverifyMut.isLoading
  const qc = useQueryClient()
  const [editingNotes, setEditingNotes] = React.useState(false)
  const [notesDraft, setNotesDraft] = React.useState(s.notes ?? '')
  // Re-sync the draft when the underlying row changes (e.g., another
  // admin saved a note and the query refetched).
  React.useEffect(() => { if (!editingNotes) setNotesDraft(s.notes ?? '') }, [s.notes, editingNotes])
  const saveNotes = useMutation(
    (body: { notes: string }) => post(`/admin/platform-review-statuses/${s.platformKey}/${s.importType}/notes`, body),
    {
      onSuccess: () => {
        qc.invalidateQueries(['platform-review-statuses'])
        setEditingNotes(false)
      },
    },
  )
  return (
    <div style={{padding:10,background:'var(--bg2)',border:`1px solid ${verified?'rgba(34,197,94,.3)':'var(--b1)'}`,borderRadius:7,fontSize:'.78rem'}}>
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'center'}}>
        <div style={{fontWeight:600,color:'var(--t0)'}}>{platformLabel(s.platformKey)} <span style={{color:'var(--t3)',fontWeight:400}}>· {s.importType}</span></div>
        {verified?<span className="badge" style={{background:'rgba(34,197,94,.12)',color:'#22c55e'}}>verified</span>:<span className="badge bmu">unverified</span>}
      </div>
      <div style={{color:'var(--t2)',marginTop:4,fontSize:'.72rem'}}>
        {s.distinctLandlords} customer{s.distinctLandlords===1?'':'s'} · {s.committedCount} commit{s.committedCount===1?'':'s'}
      </div>
      {verified&&s.verifiedAt&&(
        <div style={{color:'var(--t3)',marginTop:2,fontSize:'.7rem'}}>
          ✓ {new Date(s.verifiedAt).toLocaleDateString()} by {[s.verifierFirstName,s.verifierLastName].filter(Boolean).join(' ')||'admin'}
        </div>
      )}

      {/* S316: per-platform notes — operational context. Read-only for
          regular admin (no PII risk; admin-authored text). Super_admin
          can edit; save fires a dedicated route that doesn't restamp
          verified_at. */}
      {!editingNotes && s.notes && (
        <div style={{marginTop:8,padding:'6px 8px',background:'var(--bg3)',border:'1px solid var(--b1)',borderRadius:5,fontSize:'.7rem',color:'var(--t2)',whiteSpace:'pre-wrap',lineHeight:1.4}}>
          {s.notes}
        </div>
      )}
      {isSuperAdmin && editingNotes && (
        <div style={{marginTop:8}}>
          <textarea
            value={notesDraft}
            onChange={e => setNotesDraft(e.target.value)}
            placeholder="Operational context — known column gotchas, customer-specific quirks, why this is/isn't verified yet…"
            style={{
              width:'100%',minHeight:60,
              background:'var(--bg3)',border:'1px solid var(--b1)',borderRadius:5,
              color:'var(--t0)',padding:'6px 8px',fontSize:'.72rem',outline:'none',
              fontFamily:'inherit',resize:'vertical',
            }}
          />
          <div style={{marginTop:6,display:'flex',gap:6}}>
            <button
              className="btn bgold bsm"
              disabled={saveNotes.isLoading}
              onClick={()=>saveNotes.mutate({notes:notesDraft})}>
              {saveNotes.isLoading?'Saving…':'Save'}
            </button>
            <button
              className="btn bd bsm"
              disabled={saveNotes.isLoading}
              onClick={()=>{setEditingNotes(false);setNotesDraft(s.notes ?? '')}}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {isSuperAdmin&&!editingNotes&&(
        <div style={{marginTop:8,display:'flex',gap:6,flexWrap:'wrap'}}>
          {!verified?
            <button className="btn bgold bsm" disabled={busy} onClick={()=>verifyMut.mutate({platform_key:s.platformKey,import_type:s.importType})}>Mark verified</button>
          : <button className="btn bd bsm" disabled={busy} onClick={()=>{if(confirm(`Revert ${s.platformKey}/${s.importType} to unverified? Future uploads will resume escalating to review.`)){unverifyMut.mutate({platform_key:s.platformKey,import_type:s.importType})}}}>Unverify</button>}
          <button
            className="btn bd bsm"
            onClick={()=>setEditingNotes(true)}>
            {s.notes ? 'Edit notes' : 'Add notes'}
          </button>
        </div>
      )}
    </div>
  )
}

function CsvImports(){
  const{user}=useAuth()
  const isSuperAdmin=user?.role==='super_admin'
  const qc=useQueryClient()
  const[statusFilter,setStatusFilter]=useState<'pending'|'reviewed'|'all'>('pending')
  const[platformFilter,setPlatformFilter]=useState('')
  const[typeFilter,setTypeFilter]=useState('')
  const[detailId,setDetailId]=useState<string|null>(null)
  const qs=React.useMemo(()=>{
    const p=new URLSearchParams()
    p.set('status',statusFilter)
    if(platformFilter)p.set('platform',platformFilter)
    if(typeFilter)p.set('import_type',typeFilter)
    return p.toString()
  },[statusFilter,platformFilter,typeFilter])
  const{data,isLoading}=useQuery(['csv-imports',qs],()=>get<{rows:CsvImportAttemptRow[]}>('/admin/csv-import-attempts?'+qs))
  const{data:statuses}=useQuery(['platform-review-statuses'],()=>get<{rows:PlatformReviewStatus[]}>('/admin/platform-review-statuses'))
  const{data:candidates}=useQuery(['platform-claim-candidates'],()=>get<{rows:PlatformClaimCandidate[]}>('/admin/platform-claims/candidates'))
  const rows=data?.rows||[]
  const fmtTs=(d:string)=>new Date(d).toLocaleString()
  const markReviewed=useMutation(
    (id:string)=>post(`/admin/csv-import-attempts/${id}/mark-reviewed`),
    {onSuccess:()=>{qc.invalidateQueries(['csv-imports']);qc.invalidateQueries(['platform-review-statuses'])}},
  )
  const verifyPlatform=useMutation(
    ({platform_key,import_type}:{platform_key:string;import_type:string})=>
      post(`/admin/platform-review-statuses/${platform_key}/${import_type}/verify`),
    {onSuccess:()=>{qc.invalidateQueries(['platform-review-statuses']);qc.invalidateQueries(['csv-imports'])}},
  )
  const unverifyPlatform=useMutation(
    ({platform_key,import_type}:{platform_key:string;import_type:string})=>
      post(`/admin/platform-review-statuses/${platform_key}/${import_type}/unverify`),
    {onSuccess:()=>{qc.invalidateQueries(['platform-review-statuses']);qc.invalidateQueries(['csv-imports'])}},
  )
  const promoteClaim=useMutation(
    (normalized:string)=>post(`/admin/platform-claims/${encodeURIComponent(normalized)}/promote`),
    {onSuccess:()=>{qc.invalidateQueries(['platform-claim-candidates'])}},
  )
  const platformLabel=(k:string)=>k.charAt(0).toUpperCase()+k.slice(1)
  const statusBadge=(s:string)=>{
    if(s==='reviewed')return<span className="badge" style={{background:'rgba(34,197,94,.12)',color:'#22c55e'}}>reviewed</span>
    if(s==='committed')return<span className="badge bgold">committed</span>
    return<span className="badge bmu">validated</span>
  }
  return(
    <div>
      <div className="ph">
        <div><h1 className="pt">CSV Import Review</h1><p className="ps">Landlord CSV migrations awaiting mapping-accuracy review. Imports from unverified platforms surface here until super admin marks the mapping verified.</p></div>
        <span className="badge bgold">{isSuperAdmin?'super_admin':'admin'}</span>
      </div>

      {statuses&&statuses.rows.length>0&&(
        <div className="card" style={{marginBottom:16}}>
          <div style={{fontSize:'.72rem',color:'var(--t3)',textTransform:'uppercase',letterSpacing:'.06em',marginBottom:8}}>Platform verification status</div>
          <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fill,minmax(220px,1fr))',gap:8}}>
            {statuses.rows.map(s=>(
              <PlatformStatusCard
                key={s.platformKey+'_'+s.importType}
                s={s}
                isSuperAdmin={isSuperAdmin}
                platformLabel={platformLabel}
                verifyMut={verifyPlatform}
                unverifyMut={unverifyPlatform}
              />
            ))}
          </div>
        </div>
      )}

      {candidates&&candidates.rows.length>0&&(
        <div className="card" style={{marginBottom:16}}>
          <div style={{fontSize:'.72rem',color:'var(--t3)',textTransform:'uppercase',letterSpacing:'.06em',marginBottom:8}}>Claim candidates · generic uploads asking for platforms we don't yet support</div>
          <table className="tbl" style={{marginBottom:0}}>
            <thead>
              <tr>
                <th>Normalized name</th>
                <th>Spellings seen</th>
                <th>Customers</th>
                <th>Types</th>
                <th>Last seen</th>
                <th style={{width:140}}></th>
              </tr>
            </thead>
            <tbody>
              {candidates.rows.map(c=>{
                const variants=Array.isArray(c.rawNameVariants)?c.rawNameVariants:[]
                const types=Array.isArray(c.importTypes)?c.importTypes:[]
                const meetsThreshold=c.distinctLandlords>=5
                return(
                  <tr key={c.normalizedName}>
                    <td style={{fontSize:'.78rem',fontWeight:600,color:meetsThreshold?'var(--gold)':'var(--t0)',fontFamily:'var(--font-m)'}}>{c.normalizedName}</td>
                    <td style={{fontSize:'.74rem',color:'var(--t1)'}}>{variants.slice(0,3).join(' · ')}{variants.length>3?` · +${variants.length-3} more`:''}</td>
                    <td style={{fontSize:'.78rem'}}>{c.distinctLandlords} <span style={{color:'var(--t3)',fontSize:'.7rem'}}>· {c.totalMentions} mention{c.totalMentions===1?'':'s'}</span></td>
                    <td style={{fontSize:'.74rem',color:'var(--t2)'}}>{types.join(' · ')}</td>
                    <td style={{fontSize:'.72rem',color:'var(--t2)',whiteSpace:'nowrap'}}>{fmtTs(c.mostRecentMention)}</td>
                    <td style={{textAlign:'right'}}>
                      {isSuperAdmin?
                        <button
                          className="btn bgold bsm"
                          disabled={promoteClaim.isLoading}
                          onClick={()=>{if(confirm(`Promote "${c.normalizedName}"? This drops it from the candidates list. Building the actual mapping happens in a code session.`)){promoteClaim.mutate(c.normalizedName)}}}
                        >Promote</button>
                      : <span style={{fontSize:'.7rem',color:'var(--t3)'}}>super_admin only</span>}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          <div style={{marginTop:8,fontSize:'.7rem',color:'var(--t3)'}}>Customers ≥ 5 highlighted gold — meets the promotion threshold. Promoting just acknowledges the claim; the actual mapping work is a separate code change.</div>
        </div>
      )}

      <div className="card" style={{marginBottom:16}}>
        <div style={{display:'flex',gap:10,alignItems:'end',flexWrap:'wrap'}}>
          <div>
            <label style={{display:'block',fontSize:'.68rem',color:'var(--t3)',marginBottom:4,textTransform:'uppercase',letterSpacing:'.06em'}}>Status</label>
            <select value={statusFilter} onChange={e=>setStatusFilter(e.target.value as any)} style={{background:'var(--bg2)',border:'1px solid var(--b1)',borderRadius:7,color:'var(--t0)',padding:'7px 10px',fontSize:'.78rem',outline:'none'}}>
              <option value="pending">Pending review</option>
              <option value="reviewed">Reviewed</option>
              <option value="all">All</option>
            </select>
          </div>
          <div>
            <label style={{display:'block',fontSize:'.68rem',color:'var(--t3)',marginBottom:4,textTransform:'uppercase',letterSpacing:'.06em'}}>Platform</label>
            <input value={platformFilter} onChange={e=>setPlatformFilter(e.target.value)} placeholder="e.g. doorloop" style={{background:'var(--bg2)',border:'1px solid var(--b1)',borderRadius:7,color:'var(--t0)',padding:'7px 10px',fontSize:'.78rem',outline:'none'}}/>
          </div>
          <div>
            <label style={{display:'block',fontSize:'.68rem',color:'var(--t3)',marginBottom:4,textTransform:'uppercase',letterSpacing:'.06em'}}>Type</label>
            <select value={typeFilter} onChange={e=>setTypeFilter(e.target.value)} style={{background:'var(--bg2)',border:'1px solid var(--b1)',borderRadius:7,color:'var(--t0)',padding:'7px 10px',fontSize:'.78rem',outline:'none'}}>
              <option value="">Any</option>
              <option value="tenant">Tenant</option>
              <option value="property">Property</option>
              <option value="payment">Payment</option>
            </select>
          </div>
        </div>
      </div>

      <div className="card" style={{padding:0,overflow:'hidden'}}>
        {isLoading?<div style={{padding:32,color:'var(--t3)',textAlign:'center'}}>Loading…</div>:
         rows.length===0?<div className="empty">No CSV imports match these filters.</div>:
         <table className="tbl">
          <thead>
            <tr>
              <th style={{width:160}}>When</th>
              <th>Landlord</th>
              <th>Platform</th>
              <th>Type</th>
              <th>Rows</th>
              <th>Columns</th>
              <th>Status</th>
              <th style={{width:130}}></th>
            </tr>
          </thead>
          <tbody>
            {rows.map(r=>{
              // S316: PII redaction for non-super_admin. The landlord
              // name + email are PII the regular admin tier shouldn't
              // see at the list level. Super_admin keeps full display
              // (and is the only role that can open the detail modal
              // where sample-row PII lives — already gated below).
              const llName=[r.landlordFirstName,r.landlordLastName].filter(Boolean).join(' ')
              const llDisplay=isSuperAdmin?(llName||r.landlordEmail):'Landlord #'+r.landlordId.slice(0,8)
              const llEmailDisplay=isSuperAdmin?r.landlordEmail:maskEmail(r.landlordEmail)
              return(
              <tr key={r.id}>
                <td style={{whiteSpace:'nowrap',fontSize:'.72rem',color:'var(--t2)'}}>{fmtTs(r.createdAt)}</td>
                <td style={{fontSize:'.74rem'}}>{llDisplay}<div style={{fontSize:'.7rem',color:'var(--t3)'}}>{llEmailDisplay}</div></td>
                <td style={{fontSize:'.74rem'}}>{platformLabel(r.platformKey)}{r.claimedPlatformName&&<span style={{color:'var(--t3)',marginLeft:4}}>({r.claimedPlatformName})</span>}</td>
                <td><span className="badge bmu">{r.importType}</span></td>
                <td style={{fontSize:'.74rem'}}>{r.rowCount.toLocaleString()}{r.blockers>0&&<span style={{color:'#ef4444',marginLeft:6,fontSize:'.7rem'}}>{r.blockers}b</span>}{r.warnings>0&&<span style={{color:'#f59e0b',marginLeft:6,fontSize:'.7rem'}}>{r.warnings}w</span>}</td>
                <td style={{fontSize:'.74rem'}}>{r.columnCount}</td>
                <td>{statusBadge(r.status)}</td>
                <td style={{textAlign:'right'}}>
                  {isSuperAdmin?<>
                    <button className="btn bd bsm" onClick={()=>setDetailId(r.id)}>View</button>
                    {r.status!=='reviewed'&&<button className="btn bgold bsm" style={{marginLeft:6}} disabled={markReviewed.isLoading} onClick={()=>markReviewed.mutate(r.id)}>Mark reviewed</button>}
                  </>:<span style={{fontSize:'.7rem',color:'var(--t3)'}}>super_admin only</span>}
                </td>
              </tr>
            )})}
          </tbody>
         </table>}
      </div>

      {detailId&&<CsvImportDetail id={detailId} onClose={()=>setDetailId(null)} onNavigate={setDetailId} onMarkReviewed={()=>{markReviewed.mutate(detailId);setDetailId(null)}}/>}
    </div>
  )
}

// S316: mask email for non-super_admin display in CSV imports list.
// Preserves first char + domain TLD so admin can still distinguish
// landlords by rough identity without exposing the full address.
//   nic@example.com  →  n***@e***.com
//   a@b.io          →  a***@b***.io
function maskEmail(email: string): string {
  if (!email || typeof email !== 'string') return '—'
  const at = email.indexOf('@')
  if (at < 1) return '—'
  const local = email.slice(0, at)
  const domain = email.slice(at + 1)
  const dot = domain.lastIndexOf('.')
  const tld = dot >= 0 ? domain.slice(dot) : ''
  const domainHead = dot >= 0 ? domain.slice(0, dot) : domain
  return `${local[0]}***@${domainHead[0] || '?'}***${tld}`
}

function CsvImportDetail({id,onClose,onNavigate,onMarkReviewed}:{id:string;onClose:()=>void;onNavigate:(id:string)=>void;onMarkReviewed:()=>void}){
  const{data,isLoading}=useQuery(['csv-import',id],()=>get<CsvImportAttemptDetail>('/admin/csv-import-attempts/'+id))
  const headers=data?.columnHeaders||[]
  const samples=data?.sampleRows||[]
  return(
    <div style={{position:'fixed',inset:0,background:'rgba(0,0,0,.6)',zIndex:50,display:'flex',alignItems:'flex-start',justifyContent:'center',padding:32,overflow:'auto'}}>
      <div className="card" style={{maxWidth:1100,width:'100%',padding:20}}>
        <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',marginBottom:14}}>
          <div>
            <h2 style={{margin:0,fontSize:'1.05rem',color:'var(--t0)'}}>CSV import attempt</h2>
            {data&&<div style={{fontSize:'.78rem',color:'var(--t2)',marginTop:4}}>{data.importType} · {data.platformKey} · {data.landlordEmail} · {new Date(data.createdAt).toLocaleString()}</div>}
          </div>
          <button className="btn bd bsm" onClick={onClose}>Close</button>
        </div>
        {isLoading?<div style={{padding:32,color:'var(--t3)',textAlign:'center'}}>Loading…</div>:!data?<div className="empty">Not found.</div>:(
          <div>
            <div style={{display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:10,marginBottom:14,fontSize:'.76rem'}}>
              <div className="card" style={{padding:10}}><div style={{color:'var(--t3)',fontSize:'.7rem',textTransform:'uppercase',letterSpacing:'.06em'}}>Rows</div><div style={{fontSize:'1.05rem',color:'var(--t0)',fontWeight:600}}>{data.rowCount.toLocaleString()}</div></div>
              <div className="card" style={{padding:10}}><div style={{color:'var(--t3)',fontSize:'.7rem',textTransform:'uppercase',letterSpacing:'.06em'}}>Columns</div><div style={{fontSize:'1.05rem',color:'var(--t0)',fontWeight:600}}>{headers.length}</div></div>
              <div className="card" style={{padding:10}}><div style={{color:'var(--t3)',fontSize:'.7rem',textTransform:'uppercase',letterSpacing:'.06em'}}>Blockers</div><div style={{fontSize:'1.05rem',color:data.blockers>0?'#ef4444':'var(--t0)',fontWeight:600}}>{data.blockers}</div></div>
              <div className="card" style={{padding:10}}><div style={{color:'var(--t3)',fontSize:'.7rem',textTransform:'uppercase',letterSpacing:'.06em'}}>Warnings</div><div style={{fontSize:'1.05rem',color:data.warnings>0?'#f59e0b':'var(--t0)',fontWeight:600}}>{data.warnings}</div></div>
            </div>

            <div style={{fontSize:'.72rem',color:'var(--t3)',textTransform:'uppercase',letterSpacing:'.06em',marginBottom:6}}>Column headers ({headers.length})</div>
            <div style={{marginBottom:14,padding:10,background:'var(--bg2)',border:'1px solid var(--b1)',borderRadius:7,fontFamily:'var(--font-m)',fontSize:'.72rem',color:'var(--t1)',display:'flex',flexWrap:'wrap',gap:6}}>
              {headers.length===0?<span style={{color:'var(--t3)'}}>(no headers captured — commit row)</span>:headers.map((h:string,i:number)=>(
                <span key={i} style={{padding:'3px 7px',background:'var(--bg1)',border:'1px solid var(--b1)',borderRadius:5}}>{h}</span>
              ))}
            </div>

            <div style={{fontSize:'.72rem',color:'var(--t3)',textTransform:'uppercase',letterSpacing:'.06em',marginBottom:6}}>Sample rows (first 5)</div>
            <div style={{marginBottom:14,padding:0,background:'var(--bg2)',border:'1px solid var(--b1)',borderRadius:7,overflow:'auto',maxHeight:340}}>
              {samples.length===0?
                <div style={{padding:14,color:'var(--t3)',fontSize:'.74rem'}}>
                  (no sample rows captured — commit row)
                  {data.relatedValidateAttemptId&&(
                    <button
                      className="btn bd bsm"
                      style={{marginLeft:10}}
                      onClick={()=>onNavigate(data.relatedValidateAttemptId!)}
                    >Open validate row →</button>
                  )}
                </div>
              :
                <table className="tbl" style={{marginBottom:0}}>
                  <thead><tr>{headers.map((h:string,i:number)=>(<th key={i} style={{whiteSpace:'nowrap',fontSize:'.7rem'}}>{h}</th>))}</tr></thead>
                  <tbody>{samples.map((row:Record<string,any>,i:number)=>(<tr key={i}>{headers.map((h:string,j:number)=>(<td key={j} style={{fontSize:'.72rem',whiteSpace:'nowrap',maxWidth:200,overflow:'hidden',textOverflow:'ellipsis'}} title={String(row[h]??'')}>{String(row[h]??'')}</td>))}</tr>))}</tbody>
                </table>
              }
            </div>

            <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginTop:14}}>
              <div style={{fontSize:'.72rem',color:'var(--t3)'}}>
                {data.status==='reviewed'&&data.reviewedAt?`Reviewed ${new Date(data.reviewedAt).toLocaleString()} by ${[data.reviewerFirstName,data.reviewerLastName].filter(Boolean).join(' ')||'admin'}`:''}
              </div>
              {data.status!=='reviewed'&&<button className="btn bgold" onClick={onMarkReviewed}>Mark reviewed</button>}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// ── LOGIN ─────────────────────────────────────────────────────
// S289: multi-step. Step 1 collects credentials. If the backend
// answers with `requiresTotp`, step 2 prompts for the 6-digit code
// (or a recovery code). The totp_session token only lives in local
// component state — never persisted — so a refresh between steps
// drops the user back to step 1, which is the desired safety
// posture.
function LoginPage(){
  const{login,loginWithTotp}=useAuth()
  React.useEffect(()=>{
    localStorage.removeItem('gam_admin_token')
    delete api.defaults.headers.common['Authorization']
  },[])
  const[email,setEmail]=useState('');const[pw,setPw]=useState('');const[err,setErr]=useState('');const[loading,setLoading]=useState(false)
  const[totpSession,setTotpSession]=useState<string|null>(null)
  const[code,setCode]=useState('')

  const onCredentialsSubmit=async(e:React.FormEvent)=>{
    e.preventDefault();setLoading(true);setErr('')
    try{
      const r=await login(email,pw)
      if(r.kind==='totp_required'){setTotpSession(r.totpSession);setCode('')}
    }
    catch(ex:any){
      // Surface the backend's error message when available — covers
      // "Account temporarily locked", "Please verify your email",
      // generic "Invalid credentials", and "Admin access required".
      setErr(ex.response?.data?.error||ex.message||'Login failed')
    }
    finally{setLoading(false)}
  }

  const onTotpSubmit=async(e:React.FormEvent)=>{
    e.preventDefault();setLoading(true);setErr('')
    try{await loginWithTotp(totpSession!,code.trim())}
    catch(ex:any){
      // Most-common path: 401 from /totp/verify on a wrong code.
      // The backend tells us if it was an expired session vs a wrong
      // code — surface that text so the user knows whether to start
      // over.
      const msg=ex.response?.data?.error||'Invalid code.'
      setErr(msg)
      if(/session/i.test(msg)){
        // Session expired — drop back to credentials step.
        setTotpSession(null);setCode('');setPw('')
      }
    }
    finally{setLoading(false)}
  }

  const onBackToCredentials=()=>{
    setTotpSession(null);setCode('');setErr('');setPw('')
  }

  // ── Step 2: TOTP code ─────────────────────────────────────────
  if(totpSession){
    return(
      <div style={{minHeight:'100vh',display:'flex',alignItems:'center',justifyContent:'center',background:'var(--bg0)',padding:20}}>
        <div style={{width:'100%',maxWidth:380}}>
          <div style={{textAlign:'center',marginBottom:40}}>
            <div style={{fontFamily:'var(--font-d)',fontSize:'1.8rem',fontWeight:800,color:'var(--red)',marginBottom:8}}>⚠ ADMIN CONSOLE</div>
            <div style={{color:'var(--t3)',fontSize:'.82rem'}}>Two-factor authentication</div>
          </div>
          <div className="card" style={{padding:24}}>
            <div style={{fontSize:'.85rem',color:'var(--t1)',marginBottom:14,lineHeight:1.6}}>
              Enter the 6-digit code from your authenticator app, or one of your recovery codes.
            </div>
            {err&&<div className="alert ae" style={{marginBottom:14}}>{err}</div>}
            <form onSubmit={onTotpSubmit}>
              <div style={{marginBottom:16}}>
                <label style={{display:'block',fontSize:'.72rem',fontWeight:600,color:'var(--t3)',marginBottom:5,textTransform:'uppercase',letterSpacing:'.06em'}}>Code</label>
                <input
                  style={{width:'100%',background:'var(--bg3)',border:'1px solid var(--b1)',borderRadius:7,color:'var(--t0)',padding:'8px 11px',fontSize:'1rem',fontFamily:'var(--font-m)',letterSpacing:'.2em',textAlign:'center',outline:'none'}}
                  type="text"
                  value={code}
                  onChange={e=>setCode(e.target.value)}
                  autoFocus
                  required
                  autoComplete="one-time-code"
                  inputMode="text"
                  placeholder="123 456 or xxxxx-xxxxx"
                />
              </div>
              <button className="bp btn" type="submit" disabled={loading||!code.trim()} style={{width:'100%',justifyContent:'center'}}>
                {loading?<span className="spinner"/>:'Verify'}
              </button>
            </form>
            <div style={{marginTop:14,textAlign:'center'}}>
              <button onClick={onBackToCredentials} style={{background:'none',border:'none',color:'var(--t2)',fontSize:'.82rem',cursor:'pointer',textDecoration:'underline'}}>
                ← Back to sign in
              </button>
            </div>
          </div>
        </div>
      </div>
    )
  }

  // ── Step 1: credentials ───────────────────────────────────────
  return(
    <div style={{minHeight:'100vh',display:'flex',alignItems:'center',justifyContent:'center',background:'var(--bg0)',padding:20}}>
      <div style={{width:'100%',maxWidth:380}}>
        <div style={{textAlign:'center',marginBottom:40}}>
          <div style={{fontFamily:'var(--font-d)',fontSize:'1.8rem',fontWeight:800,color:'var(--red)',marginBottom:8}}>⚠ ADMIN CONSOLE</div>
          <div style={{color:'var(--t3)',fontSize:'.82rem'}}>Gold Asset Management · Internal Access Only</div>
        </div>
        <div className="card" style={{padding:24}}>
          {err&&<div className="alert ae" style={{marginBottom:14}}>{err}</div>}
          <form onSubmit={onCredentialsSubmit}>
            <div style={{marginBottom:14}}><label style={{display:'block',fontSize:'.72rem',fontWeight:600,color:'var(--t3)',marginBottom:5,textTransform:'uppercase',letterSpacing:'.06em'}}>Email</label><input style={{width:'100%',background:'var(--bg3)',border:'1px solid var(--b1)',borderRadius:7,color:'var(--t0)',padding:'8px 11px',fontSize:'.875rem',fontFamily:'var(--font-b)',outline:'none'}} type="email" value={email} onChange={e=>setEmail(e.target.value)} autoFocus required/></div>
            <div style={{marginBottom:16}}><label style={{display:'block',fontSize:'.72rem',fontWeight:600,color:'var(--t3)',marginBottom:5,textTransform:'uppercase',letterSpacing:'.06em'}}>Password</label><input style={{width:'100%',background:'var(--bg3)',border:'1px solid var(--b1)',borderRadius:7,color:'var(--t0)',padding:'8px 11px',fontSize:'.875rem',fontFamily:'var(--font-b)',outline:'none'}} type="password" value={pw} onChange={e=>setPw(e.target.value)} required/></div>
            <button className="bp btn" type="submit" disabled={loading} style={{width:'100%',justifyContent:'center'}}>
              {loading?<span className="spinner"/>:'Sign in'}
            </button>
          </form>
        </div>
      </div>
    </div>
  )
}


// ── SUPER ADMIN GUARD ─────────────────────────────────────────────────
function SuperAdminGuard({children}:{children:React.ReactNode}){
  const{user}=useAuth()
  if(user?.role!=='super_admin')return(
    <div style={{padding:48,textAlign:'center'}}>
      <div style={{fontSize:'2rem',marginBottom:12}}>🔒</div>
      <h2 style={{color:'var(--t0)',marginBottom:8}}>Super Admin Only</h2>
      <p style={{color:'var(--t3)',fontSize:'.85rem'}}>This section requires super_admin access.</p>
    </div>
  )
  return<>{children}</>
}

// ── TOTP ENROLLMENT ───────────────────────────────────────────────────
// S289: post-login enrollment flow for users in MANDATORY_TOTP_ROLES
// (admin / super_admin / admin_ops at launch). Three states:
//   loading     — fetching the secret + QR + recovery codes
//   showCodes   — backend returned, user is scanning the QR /
//                 saving recovery codes / entering the first 6-digit
//                 token to confirm enrollment
//   done        — confirm succeeded; refresh() pulled the new
//                 totp_enabled state; redirect to /overview
function TotpEnrollPage(){
  const{refresh,logout}=useAuth()
  const navigate=useNavigate()
  const[state,setState]=useState<'loading'|'showCodes'|'done'|'error'>('loading')
  const[err,setErr]=useState('')
  const[qrDataUri,setQrDataUri]=useState('')
  const[otpauthUrl,setOtpauthUrl]=useState('')
  const[recoveryCodes,setRecoveryCodes]=useState<string[]>([])
  const[code,setCode]=useState('')
  const[submitting,setSubmitting]=useState(false)
  const[savedAck,setSavedAck]=useState(false)

  React.useEffect(()=>{
    let cancelled=false
    api.post('/auth/totp/enroll-start')
      .then(r=>{
        if(cancelled)return
        const d=r.data.data
        setQrDataUri(d.qrDataUri);setOtpauthUrl(d.otpauthUrl)
        setRecoveryCodes(d.recoveryCodes||[])
        setState('showCodes')
      })
      .catch((e:any)=>{
        if(cancelled)return
        // 409 if already enrolled — redirect to overview, nothing to do.
        if(e.response?.status===409){navigate('/overview',{replace:true});return}
        setErr(e.response?.data?.error||'Could not start enrollment.')
        setState('error')
      })
    return()=>{cancelled=true}
  },[navigate])

  const onConfirm=async(e:React.FormEvent)=>{
    e.preventDefault();setSubmitting(true);setErr('')
    try{
      await api.post('/auth/totp/enroll-confirm',{token:code.trim()})
      await refresh()
      setState('done')
      // Small delay so the user sees the success state before nav.
      setTimeout(()=>navigate('/overview',{replace:true}),700)
    }catch(ex:any){
      setErr(ex.response?.data?.error||'Verification failed. Try the current code from your app.')
      setSubmitting(false)
    }
  }

  // Loading / error shells
  if(state==='loading'){
    return(
      <div style={{minHeight:'100vh',display:'flex',alignItems:'center',justifyContent:'center',background:'var(--bg0)'}}>
        <div className="spinner"/>
      </div>
    )
  }
  if(state==='error'){
    return(
      <div style={{minHeight:'100vh',display:'flex',alignItems:'center',justifyContent:'center',background:'var(--bg0)',padding:20}}>
        <div className="card" style={{padding:24,maxWidth:420,textAlign:'center'}}>
          <div style={{fontSize:36,marginBottom:12}}>⚠️</div>
          <h2 style={{marginBottom:12}}>Couldn't start enrollment</h2>
          <p style={{color:'var(--t2)',fontSize:'.85rem',lineHeight:1.6,marginBottom:16}}>{err}</p>
          <button onClick={logout} className="bp btn" style={{width:'100%',justifyContent:'center'}}>Sign out</button>
        </div>
      </div>
    )
  }
  if(state==='done'){
    return(
      <div style={{minHeight:'100vh',display:'flex',alignItems:'center',justifyContent:'center',background:'var(--bg0)',padding:20}}>
        <div className="card" style={{padding:24,maxWidth:420,textAlign:'center'}}>
          <div style={{fontSize:36,marginBottom:12}}>✅</div>
          <h2 style={{marginBottom:12}}>Two-factor authentication enabled</h2>
          <p style={{color:'var(--t2)',fontSize:'.85rem',lineHeight:1.6}}>Redirecting to admin…</p>
        </div>
      </div>
    )
  }

  // Main enrollment screen
  return(
    <div style={{minHeight:'100vh',display:'flex',alignItems:'center',justifyContent:'center',background:'var(--bg0)',padding:20}}>
      <div style={{width:'100%',maxWidth:560}}>
        <div style={{textAlign:'center',marginBottom:24}}>
          <div style={{fontFamily:'var(--font-d)',fontSize:'1.6rem',fontWeight:800,color:'var(--red)',marginBottom:6}}>⚠ ADMIN CONSOLE</div>
          <div style={{color:'var(--t3)',fontSize:'.82rem'}}>Set up two-factor authentication</div>
        </div>
        <div className="card" style={{padding:24}}>
          <div style={{fontSize:'.82rem',color:'var(--t1)',marginBottom:14,lineHeight:1.6}}>
            Admin accounts on GAM require a second factor. This is a one-time setup that adds an authenticator-app code to every sign-in. Without it your account is signed out.
          </div>

          <div style={{display:'grid',gridTemplateColumns:'auto 1fr',gap:16,alignItems:'start',marginBottom:18}}>
            <div style={{padding:10,background:'#fff',borderRadius:8,lineHeight:0}}>
              <img src={qrDataUri} alt="Scan this QR code with your authenticator app" style={{display:'block',width:180,height:180}}/>
            </div>
            <div style={{fontSize:'.82rem',color:'var(--t1)',lineHeight:1.6}}>
              <div style={{fontWeight:700,color:'var(--t0)',marginBottom:6}}>1. Scan with your authenticator app</div>
              <div style={{color:'var(--t2)',fontSize:'.78rem',marginBottom:10}}>Google Authenticator, Authy, 1Password, Bitwarden — any TOTP app works. Open the app, tap "Add account" or the + icon, then scan the QR code on the left.</div>
              <div style={{fontSize:'.72rem',color:'var(--t3)'}}>Can't scan? <a href={otpauthUrl} style={{color:'var(--gold)',wordBreak:'break-all'}}>Tap to add manually →</a></div>
            </div>
          </div>

          <div style={{marginBottom:18,padding:14,background:'rgba(245,158,11,.05)',border:'1px solid rgba(245,158,11,.2)',borderRadius:7}}>
            <div style={{fontWeight:700,color:'var(--amber)',marginBottom:8,fontSize:'.85rem'}}>2. Save these recovery codes</div>
            <div style={{fontSize:'.78rem',color:'var(--t2)',marginBottom:10,lineHeight:1.5}}>
              If you ever lose access to your authenticator app, these one-time codes are the only way to get back in. Store them somewhere safe — a password manager works well.
            </div>
            <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:6,marginBottom:10}}>
              {recoveryCodes.map(rc=>(
                <div key={rc} style={{fontFamily:'var(--font-m)',fontSize:'.85rem',color:'var(--t0)',background:'var(--bg3)',padding:'5px 9px',borderRadius:5,letterSpacing:'.05em'}}>{rc}</div>
              ))}
            </div>
            <label style={{display:'flex',alignItems:'center',gap:8,fontSize:'.78rem',color:'var(--t1)',cursor:'pointer'}}>
              <input type="checkbox" checked={savedAck} onChange={e=>setSavedAck(e.target.checked)}/>
              I've saved my recovery codes somewhere safe.
            </label>
          </div>

          <form onSubmit={onConfirm}>
            <div style={{marginBottom:12}}>
              <label style={{display:'block',fontSize:'.72rem',fontWeight:600,color:'var(--t3)',marginBottom:5,textTransform:'uppercase',letterSpacing:'.06em'}}>3. Enter the 6-digit code from your app to confirm</label>
              <input
                style={{width:'100%',background:'var(--bg3)',border:'1px solid var(--b1)',borderRadius:7,color:'var(--t0)',padding:'10px 11px',fontSize:'1rem',fontFamily:'var(--font-m)',letterSpacing:'.2em',textAlign:'center',outline:'none'}}
                type="text"
                value={code}
                onChange={e=>setCode(e.target.value)}
                required
                inputMode="numeric"
                pattern="[0-9 ]*"
                autoComplete="one-time-code"
                placeholder="000000"
                maxLength={7}
              />
            </div>
            {err&&<div className="alert ae" style={{marginBottom:12}}>{err}</div>}
            <button className="bp btn" type="submit" disabled={submitting||!savedAck||code.trim().length<6} style={{width:'100%',justifyContent:'center'}}>
              {submitting?<span className="spinner"/>:'Enable two-factor'}
            </button>
            <div style={{marginTop:10,fontSize:'.72rem',color:'var(--t3)',textAlign:'center'}}>
              Confirm the codes are saved before continuing — they're shown only once.
            </div>
          </form>

          <div style={{marginTop:16,paddingTop:16,borderTop:'1px solid var(--b1)',textAlign:'center'}}>
            <button onClick={logout} style={{background:'none',border:'none',color:'var(--t2)',fontSize:'.78rem',cursor:'pointer',textDecoration:'underline'}}>
              Sign out instead
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

// S289: gate that intercepts mustEnrollTotp users before they can
// reach any other authenticated route. Layout-level guard.
function MustEnrollTotpGate({children}:{children:React.ReactNode}){
  const{user}=useAuth()
  if(user?.mustEnrollTotp)return<Navigate to="/totp/enroll" replace/>
  return<>{children}</>
}

// ── SECURITY PAGE ─────────────────────────────────────────────────────
// S290 follow-up: surfaces the user's 2FA state + a disable control.
// Mandatory-role users who disable get immediately bounced back to
// /totp/enroll by the MustEnrollTotpGate — exactly the behavior we
// want for testing the re-enrollment loop without going through psql.
function SecurityPage(){
  const{user,refresh}=useAuth()
  const[showConfirm,setShowConfirm]=useState(false)
  const[password,setPassword]=useState('')
  const[submitting,setSubmitting]=useState(false)
  const[err,setErr]=useState('')
  const[success,setSuccess]=useState('')

  const onDisable=async(e:React.FormEvent)=>{
    e.preventDefault();setSubmitting(true);setErr('')
    try{
      await api.post('/auth/totp/disable',{password})
      await refresh()
      setShowConfirm(false);setPassword('')
      setSuccess('Two-factor disabled. Sign out and sign back in to re-enroll.')
    }catch(ex:any){
      setErr(ex.response?.data?.error||'Could not disable 2FA. Check your password.')
    }finally{
      setSubmitting(false)
    }
  }

  return(
    <div>
      <h1 style={{marginBottom:18}}>Security</h1>
      <div className="card" style={{padding:20,maxWidth:560,marginBottom:16}}>
        <div className="ct">Two-factor authentication</div>
        <div style={{display:'flex',alignItems:'center',gap:12,marginBottom:14}}>
          <div style={{width:36,height:36,borderRadius:8,background:user?.totpEnabled?'rgba(34,197,94,.1)':'rgba(245,158,11,.1)',display:'flex',alignItems:'center',justifyContent:'center',fontSize:'1.2rem'}}>
            {user?.totpEnabled?'✅':'⚠️'}
          </div>
          <div>
            <div style={{fontWeight:700,color:'var(--t0)',fontSize:'.95rem'}}>
              {user?.totpEnabled?'Enabled':'Not enrolled'}
            </div>
            <div style={{fontSize:'.78rem',color:'var(--t2)'}}>
              {user?.totpEnabled
                ?'You will be prompted for a 6-digit code on every sign-in.'
                :'Admin accounts are required to enroll. Sign out and sign back in to start.'}
            </div>
          </div>
        </div>

        {success&&<div className="alert" style={{background:'rgba(34,197,94,.08)',border:'1px solid rgba(34,197,94,.3)',color:'var(--green)',padding:'8px 12px',borderRadius:7,fontSize:'.82rem',marginBottom:12}}>{success}</div>}

        {user?.totpEnabled&&!showConfirm&&(
          <button
            onClick={()=>{setShowConfirm(true);setSuccess('')}}
            style={{background:'var(--bg3)',border:'1px solid var(--b2)',color:'var(--red)',padding:'7px 14px',borderRadius:7,fontSize:'.82rem',fontWeight:600,cursor:'pointer'}}
          >
            Disable two-factor
          </button>
        )}

        {user?.totpEnabled&&showConfirm&&(
          <form onSubmit={onDisable} style={{marginTop:8,padding:14,background:'var(--bg1)',border:'1px solid var(--b1)',borderRadius:8}}>
            <div style={{fontSize:'.82rem',color:'var(--t1)',marginBottom:10,lineHeight:1.5}}>
              Confirm your password to disable 2FA. After disable, any saved recovery codes are invalidated.
            </div>
            <div style={{marginBottom:10}}>
              <label style={{display:'block',fontSize:'.7rem',fontWeight:600,color:'var(--t3)',marginBottom:4,textTransform:'uppercase',letterSpacing:'.06em'}}>Password</label>
              <input
                type="password"
                value={password}
                onChange={e=>setPassword(e.target.value)}
                autoFocus
                required
                style={{width:'100%',background:'var(--bg3)',border:'1px solid var(--b1)',borderRadius:7,color:'var(--t0)',padding:'8px 11px',fontSize:'.875rem',outline:'none'}}
              />
            </div>
            {err&&<div className="alert ae" style={{marginBottom:10,fontSize:'.8rem'}}>{err}</div>}
            <div style={{display:'flex',gap:8}}>
              <button
                type="submit"
                disabled={submitting||!password}
                style={{flex:1,background:'var(--red)',border:'none',color:'#fff',padding:'8px 12px',borderRadius:7,fontSize:'.82rem',fontWeight:600,cursor:submitting||!password?'not-allowed':'pointer',opacity:submitting||!password?0.6:1}}
              >
                {submitting?'Disabling…':'Disable two-factor'}
              </button>
              <button
                type="button"
                onClick={()=>{setShowConfirm(false);setPassword('');setErr('')}}
                disabled={submitting}
                style={{background:'var(--bg3)',border:'1px solid var(--b2)',color:'var(--t1)',padding:'8px 12px',borderRadius:7,fontSize:'.82rem',cursor:'pointer'}}
              >
                Cancel
              </button>
            </div>
          </form>
        )}
      </div>

      <div style={{fontSize:'.72rem',color:'var(--t3)',maxWidth:560,lineHeight:1.5}}>
        Disable is here mainly so admins testing the system can re-walk the enrollment flow without an SQL reset. In real ops, the only reason to disable would be losing your authenticator app + all recovery codes — in which case use this from a still-signed-in session, then re-enroll with the new app.
      </div>
    </div>
  )
}

// ── APP ───────────────────────────────────────────────────────
function App(){
  const{user,loading}=useAuth()
  if(loading)return<div className="loading">Loading…</div>
  return(
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={user?<Navigate to="/overview" replace/>:<LoginPage/>}/>
        {/* S289: TOTP enrollment lives outside the Layout — it's the only
            route a mustEnrollTotp user can reach until they complete it. */}
        <Route path="/totp/enroll" element={
          (user&&(user.role==='admin'||user.role==='super_admin'))
            ? <TotpEnrollPage/>
            : <Navigate to="/login" replace/>
        }/>
        <Route path="/" element={
          (user&&(user.role==='admin'||user.role==='super_admin'))
            ? <MustEnrollTotpGate><Layout/></MustEnrollTotpGate>
            : <Navigate to="/login" replace/>
        }>
          <Route index element={<Navigate to="/overview" replace/>}/>
          <Route path="overview"      element={user?.role==='super_admin'?<Overview/>:<AdminOnboardingOverview/>}/>
          <Route path="onboarding"    element={<AdminOnboardingOverview/>}/>
          <Route path="landlords"     element={<Landlords/>}/>
          <Route path="tenants"       element={<Tenants/>}/>
          <Route path="property-reviews" element={<PropertyReviews/>}/>
          <Route path="units"         element={<Units/>}/>
          <Route path="payments"      element={<Payments/>}/>
          <Route path="disbursements" element={<Disbursements/>}/>
          <Route path="connect-accounts" element={<ConnectAccounts/>}/>
          <Route path="reserve"       element={<SuperAdminGuard><Reserve/></SuperAdminGuard>}/>
          <Route path="nacha"         element={<SuperAdminGuard><NachaMonitor/></SuperAdminGuard>}/>
          <Route path="maintenance"   element={<Maintenance/>}/>
          <Route path="disputes"      element={<Disputes/>}/>
          <Route path="subleases"     element={<Subleases/>}/>
          <Route path="deposit-portability" element={<DepositPortability/>}/>
          <Route path="system-features" element={<SuperAdminGuard><SystemFeatures/></SuperAdminGuard>}/>
          <Route path="bulletin"      element={<SuperAdminGuard><BulletinBoard/></SuperAdminGuard>}/>
          <Route path="audit-log"     element={<SuperAdminGuard><AuditLog/></SuperAdminGuard>}/>
          <Route path="csv-imports"   element={<CsvImports/>}/>
          <Route path="security"      element={<SecurityPage/>}/>
        </Route>
      </Routes>
    </BrowserRouter>
  )
}

// ── SYSTEM FEATURES (S155) ───────────────────────────────────
function SystemFeatures(){
  const{user}=useAuth()
  const isSuperAdmin = user?.role === 'super_admin'
  const qc = useQueryClient()
  const [error, setError] = React.useState<string | null>(null)
  const [success, setSuccess] = React.useState<string | null>(null)

  const { data: features = [], isLoading } = useQuery<any[]>(
    'admin-system-features',
    () => get<any[]>('/admin/system-features'),
    { enabled: !!user },
  )

  const toggleMut = useMutation(
    ({ key, enabled }: { key: string; enabled: boolean }) =>
      api.patch(`/admin/system-features/${key}`, { enabled }).then(r => r.data),
    {
      onSuccess: (_, vars) => {
        setSuccess(`${vars.key} → ${vars.enabled ? 'enabled' : 'disabled'}`)
        setTimeout(() => setSuccess(null), 3000)
        qc.invalidateQueries('admin-system-features')
      },
      onError: (e: any) => setError(e?.response?.data?.error || 'Failed'),
    },
  )

  return (
    <div>
      <div className="ph">
        <div>
          <h1 className="pt">System Features</h1>
          <p className="ps">Platform-level feature flags. Super-admin only for changes.</p>
        </div>
      </div>
      {error && <div className="alert ae" style={{marginBottom:12}}>{error}</div>}
      {success && <div className="alert ag" style={{marginBottom:12}}>{success}</div>}

      <div className="card" style={{padding:0}}>
        {isLoading ? (
          <div style={{padding:32,color:'var(--t3)',textAlign:'center'}}>Loading…</div>
        ) : (features as any[]).length === 0 ? (
          <div style={{padding:32,color:'var(--t3)',textAlign:'center'}}>No features registered.</div>
        ) : (features as any[]).map((f: any) => (
          <div key={f.key} style={{padding:'14px 16px',borderBottom:'1px solid var(--b0)',display:'flex',justifyContent:'space-between',alignItems:'flex-start',gap:14}}>
            <div style={{flex:1, minWidth: 0}}>
              <div style={{fontFamily:'var(--font-d)',fontWeight:700,fontSize:'.92rem',color:'var(--t0)',marginBottom:4}}>
                {f.key}
                <span className={`badge ${f.enabled ? 'bg2' : 'bmu'}`} style={{marginLeft:10}}>
                  {f.enabled ? 'ENABLED' : 'disabled'}
                </span>
              </div>
              <div style={{fontSize:'.78rem',color:'var(--t2)',lineHeight:1.5}}>{f.description}</div>
              <div style={{fontSize:'.65rem',color:'var(--t3)',marginTop:6}}>
                Last updated: {f.updatedAt ? new Date(f.updatedAt).toLocaleString() : '—'}
              </div>
            </div>
            <div>
              {isSuperAdmin ? (
                <button
                  className={`btn ${f.enabled ? 'bd' : 'bp'} bsm`}
                  onClick={() => toggleMut.mutate({ key: f.key, enabled: !f.enabled })}
                  disabled={toggleMut.isLoading}
                >
                  {f.enabled ? 'Disable' : 'Enable'}
                </button>
              ) : (
                <span style={{fontSize:'.7rem',color:'var(--t3)'}}>super-admin only</span>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

// ── DISPUTES (credit ledger) ─────────────────────────────────
const DISPUTE_EVENT_LABEL: Record<string,string> = {
  payment_received_on_time:           'Rent paid on time',
  payment_received_late_grace:        'Paid within grace period',
  payment_received_late_minor:        'Paid late (minor)',
  payment_received_late_major:        'Paid late (major)',
  payment_received_late_severe:       'Paid late (severe)',
  payment_partial:                    'Partial payment',
  payment_failed_nsf:                 'Payment failed (NSF)',
  payment_skipped:                    'Payment skipped',
  lease_signed:                       'Lease signed',
  lease_renewed:                      'Lease renewed',
  lease_terminated_natural:           'Lease completed',
  lease_abandoned:                    'Lease abandoned',
  move_in_inspection_completed:       'Move-in inspection completed',
  move_out_inspection_completed:      'Move-out inspection completed',
  move_out_condition_damage_documented:'Move-out damage documented',
  noise_complaint_logged:             'Noise complaint',
  lease_violation_notice_issued:      'Lease violation notice',
  property_damage_event_documented:   'Property damage documented',
  entry_compliance_breach:            'Entry compliance breach',
  eviction_notice_filed:              'Eviction notice filed',
  eviction_hearing_judgment_issued:   'Eviction judgment',
  tenancy_ended_with_balance:         'Tenancy ended with balance',
  balance_sent_to_collections:        'Balance sent to collections',
}

function disputeStatusBadge(s: string) {
  if (s === 'open') return 'ba'
  if (s === 'evidence_pending') return 'ba'
  if (s === 'resolved_corrected') return 'bg2'
  if (s === 'resolved_upheld' || s === 'resolved_no_change') return 'bmu'
  return 'bmu'
}

const inputStyle: React.CSSProperties = {
  width: '100%', background: 'var(--bg3)', border: '1px solid var(--b1)',
  borderRadius: 7, color: 'var(--t0)', padding: '7px 10px', fontSize: '.78rem',
  outline: 'none', fontFamily: 'var(--font-b)',
}
const labelStyle: React.CSSProperties = {
  display: 'block', fontSize: '.7rem', fontWeight: 600, color: 'var(--t2)',
  textTransform: 'uppercase', letterSpacing: '.05em', marginBottom: 5,
}
const fieldStyle: React.CSSProperties = { marginBottom: 12 }

function Disputes(){
  const qc = useQueryClient()
  const [status,setStatus] = React.useState<'open'|'evidence_pending'|'resolved'|'all'>('open')
  const [selected,setSelected] = React.useState<any|null>(null)
  const [outcome,setOutcome] = React.useState<'upheld'|'corrected'|'no_change'>('upheld')
  const [notes,setNotes] = React.useState('')
  const [error,setError] = React.useState<string|null>(null)
  const [success,setSuccess] = React.useState<string|null>(null)

  // Corrected-path form state
  const [cReplaceWithSame, setCReplaceWithSame] = React.useState(true)
  const [cEventType, setCEventType] = React.useState('payment_received_on_time')
  const [cVisibility, setCVisibility] = React.useState<'private_to_subject'|'visible_to_current_landlord'|'visible_to_gam_network'>('visible_to_current_landlord')
  const [cAttestationSource, setCAttestationSource] = React.useState('system_derived')

  const apiPath = status === 'all' ? '/credit/disputes' : `/credit/disputes?status=${status === 'resolved' ? 'resolved_upheld' : status}`
  const { data: disputes = [], isLoading } = useQuery<any[]>(
    ['admin-disputes', status],
    () => get<any[]>(apiPath),
  )

  // Per-selected detail (with evidence events). Falls back to the list row
  // until detail loads so the panel doesn't flash empty.
  const { data: selectedDetail } = useQuery<any>(
    ['admin-dispute-detail', selected?.id],
    () => get<any>(`/credit/disputes/${selected.id}`),
    { enabled: !!selected?.id, staleTime: 0 },
  )
  const detail = selectedDetail || selected
  const evidence: any[] = (selectedDetail?.evidence as any[]) || []

  // Map "resolved" tab to a 3-status union by re-fetching when needed.
  // For simplicity v1 only supports a single status filter; "resolved"
  // shows resolved_upheld which is the most common close-out.

  const resolveMut = useMutation(
    (body: any) => post(`/credit/dispute/${selected.id}/resolve`, body),
    {
      onSuccess: () => {
        qc.invalidateQueries('admin-disputes')
        setSuccess(`Dispute resolved as ${outcome}.`)
        setSelected(null)
        setNotes('')
        setError(null)
        setTimeout(()=>setSuccess(null), 4000)
      },
      onError: (e: any) => setError(e?.response?.data?.error || 'Failed'),
    },
  )

  const onResolve = () => {
    if (!selected) return
    setError(null)
    const body: any = {
      outcome,
      resolverNotes: notes || undefined,
    }
    if (outcome === 'corrected') {
      // Build a corrected event payload that supersedes the disputed one.
      // S325: top-level keys + nested object keys all camelCase.
      // event_data + attestation_evidence JSONB content keys stay
      // snake_case (passthrough — the credit ledger stats engine
      // reads dispute_corrected / dispute_id as DB-style keys).
      body.correctedEvent = {
        subjectType: detail.disputingSubjectType,
        subjectRefId: detail.disputingSubjectRefId,
        eventType: cReplaceWithSame ? detail.disputedEventType : cEventType,
        eventData: {
          ...detail.disputedEventData,
          dispute_corrected: true,
          dispute_id: detail.id,
        },
        occurredAt: detail.disputedEventOccurredAt,
        attestationSource: cAttestationSource,
        attestationEvidence: { dispute_id: detail.id },
        dimensionTags: detail.disputedEventDimensionTags || [],
        networkVisibility: cVisibility,
      }
      body.supersedeReason = 'correction_after_dispute'
    }
    resolveMut.mutate(body)
  }

  const list = (disputes as any[])

  return (
    <div>
      <div className="ph">
        <div>
          <h1 className="pt">Credit Disputes</h1>
          <p className="ps">{list.length} dispute{list.length === 1 ? '' : 's'} in the {status} bucket</p>
        </div>
      </div>

      {success && <div className="alert ag" style={{marginBottom:12}}>{success}</div>}
      {error && <div className="alert ae" style={{marginBottom:12}}>{error}</div>}

      <div className="card" style={{padding:12,marginBottom:16,display:'flex',gap:8}}>
        {(['open','evidence_pending','resolved','all'] as const).map(s => (
          <button
            key={s}
            className={`btn ${status === s ? 'bp' : 'bg'} bsm`}
            onClick={()=>{ setStatus(s); setSelected(null) }}
          >
            {s.replace('_',' ')}
          </button>
        ))}
      </div>

      <div className="grid2" style={{gap:16,alignItems:'start'}}>
        <div className="card" style={{padding:0,overflowX:'auto'}}>
          {isLoading ? (
            <div style={{padding:32,color:'var(--t3)',textAlign:'center'}}>Loading…</div>
          ) : list.length === 0 ? (
            <div style={{padding:32,color:'var(--t3)',textAlign:'center'}}>No disputes in this bucket.</div>
          ) : (
            <table className="tbl" style={{minWidth:760}}>
              <thead><tr><th>Status</th><th>Subject</th><th>Disputed event</th><th>Reason</th><th>Evidence</th><th>Filed</th></tr></thead>
              <tbody>
                {list.map((d: any) => (
                  <tr
                    key={d.id}
                    style={{cursor:'pointer', background: selected?.id===d.id?'rgba(201,162,39,.05)':''}}
                    onClick={()=>setSelected(d)}
                  >
                    <td><span className={`badge ${disputeStatusBadge(d.status)}`}>{d.status.replace('_',' ')}</span></td>
                    <td style={{fontSize:'.78rem'}}>
                      <div style={{color:'var(--t0)',fontWeight:600}}>{d.disputingSubjectType}</div>
                      <div className="mono" style={{fontSize:'.65rem',color:'var(--t3)'}}>{d.disputingSubjectRefId?.slice(0,8)}…</div>
                    </td>
                    <td style={{fontSize:'.78rem',color:'var(--t0)'}}>{DISPUTE_EVENT_LABEL[d.disputedEventType] || d.disputedEventType}</td>
                    <td style={{fontSize:'.78rem'}}>{d.reason.replace('_',' ')}</td>
                    <td>
                      {d.evidenceCount > 0
                        ? <span className="badge bb">{d.evidenceCount}</span>
                        : <span style={{color:'var(--t3)',fontSize:'.7rem'}}>—</span>}
                    </td>
                    <td className="mono" style={{fontSize:'.7rem',color:'var(--t3)'}}>{new Date(d.createdAt).toLocaleDateString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div>
          {!selected && (
            <div className="card" style={{textAlign:'center',padding:'48px 20px',color:'var(--t3)'}}>
              Select a dispute to review and resolve
            </div>
          )}
          {selected && (
            <div className="card">
              <div style={{marginBottom:14,paddingBottom:12,borderBottom:'1px solid var(--b0)'}}>
                <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:6}}>
                  <span className={`badge ${disputeStatusBadge(detail.status)}`}>{detail.status.replace('_',' ')}</span>
                  <span style={{fontSize:'.7rem',color:'var(--t3)'}}>filed {new Date(detail.createdAt).toLocaleString()}</span>
                </div>
                <div style={{fontFamily:'var(--font-d)',fontWeight:800,fontSize:'1.05rem',color:'var(--t0)'}}>
                  {DISPUTE_EVENT_LABEL[detail.disputedEventType] || detail.disputedEventType}
                </div>
                <div style={{fontSize:'.72rem',color:'var(--t3)',marginTop:2}}>
                  Disputing party: {detail.disputingSubjectType} <span className="mono">{detail.disputingSubjectRefId}</span>
                </div>
              </div>

              <div className="ct">Disputed event details</div>
              <div style={{display:'grid',gridTemplateColumns:'140px 1fr',gap:6,fontSize:'.78rem',marginBottom:12}}>
                <div style={{color:'var(--t3)'}}>Type</div>
                <div className="mono" style={{color:'var(--t1)'}}>{detail.disputedEventType}</div>
                <div style={{color:'var(--t3)'}}>Occurred</div>
                <div className="mono" style={{color:'var(--t1)'}}>{new Date(detail.disputedEventOccurredAt).toLocaleString()}</div>
                <div style={{color:'var(--t3)'}}>Attestation</div>
                <div style={{color:'var(--t1)'}}>{detail.disputedEventAttestationSource}</div>
                <div style={{color:'var(--t3)'}}>Visibility</div>
                <div style={{color:'var(--t1)'}}>{detail.disputedEventNetworkVisibility}</div>
                <div style={{color:'var(--t3)'}}>Dimensions</div>
                <div style={{color:'var(--t1)'}}>{(detail.disputedEventDimensionTags||[]).join(', ') || '—'}</div>
                <div style={{color:'var(--t3)'}}>Superseded</div>
                <div style={{color: detail.disputedEventSupersededBy ? 'var(--amber)' : 'var(--t1)'}}>
                  {detail.disputedEventSupersededBy ? `Yes — ${detail.disputedEventSupersededBy.slice(0,8)}…` : 'No'}
                </div>
              </div>

              {detail.disputedEventData && Object.keys(detail.disputedEventData).length > 0 && (
                <>
                  <div className="ct">event_data</div>
                  <pre style={{fontSize:'.72rem',color:'var(--t2)',background:'var(--bg3)',padding:10,borderRadius:6,overflow:'auto',maxHeight:160}}>
                    {JSON.stringify(detail.disputedEventData, null, 2)}
                  </pre>
                </>
              )}

              <div className="ct" style={{marginTop:12}}>Tenant's stated reason</div>
              <div style={{fontSize:'.82rem',color:'var(--t1)'}}>{detail.reason.replace('_',' ')}</div>
              {detail.notes && (
                <div style={{fontSize:'.78rem',color:'var(--t2)',marginTop:6,fontStyle:'italic'}}>
                  "{detail.notes}"
                </div>
              )}

              {evidence.length > 0 && (
                <>
                  <div className="ct" style={{marginTop:14}}>Evidence ({evidence.length})</div>
                  <div style={{display:'flex',flexDirection:'column',gap:6}}>
                    {evidence.map(e => (
                      <div key={e.id} style={{padding:10,background:'var(--bg3)',borderRadius:6,fontSize:'.78rem'}}>
                        <div style={{display:'flex',justifyContent:'space-between',color:'var(--t0)',fontWeight:600}}>
                          <span>{e.eventType === 'dispute_opened' ? 'Opened' : 'Evidence submitted'}</span>
                          <span style={{color:'var(--t3)',fontWeight:400,fontSize:'.7rem'}}>{new Date(e.occurredAt).toLocaleString()}</span>
                        </div>
                        {e.eventData && Object.keys(e.eventData).length > 0 && (
                          <pre style={{marginTop:6,fontSize:'.7rem',color:'var(--t2)',whiteSpace:'pre-wrap',wordBreak:'break-word'}}>
                            {JSON.stringify(e.eventData, null, 2)}
                          </pre>
                        )}
                      </div>
                    ))}
                  </div>
                </>
              )}

              {/* Resolution panel — only visible while not yet resolved */}
              {(detail.status === 'open' || detail.status === 'evidence_pending') && (
                <div style={{marginTop:18,paddingTop:14,borderTop:'1px solid var(--b0)'}}>
                  <div className="ct">Resolve dispute</div>

                  <div style={fieldStyle}>
                    <label style={labelStyle}>Outcome</label>
                    <div style={{display:'flex',gap:6,flexWrap:'wrap'}}>
                      {(['upheld','corrected','no_change'] as const).map(o => (
                        <button
                          key={o}
                          className={`btn ${outcome === o ? 'bp' : 'bg'} bsm`}
                          onClick={()=>setOutcome(o)}
                          type="button"
                        >
                          {o === 'corrected' ? 'Corrected (replace event)' : o.replace('_',' ')}
                        </button>
                      ))}
                    </div>
                    <div style={{fontSize:'.7rem',color:'var(--t3)',marginTop:6}}>
                      {outcome === 'upheld' && 'Original event stays. Tenant gets a notification that the dispute was acknowledged.'}
                      {outcome === 'corrected' && 'A corrected event is appended and the original is marked superseded. Score recomputes immediately for the disputing subject.'}
                      {outcome === 'no_change' && 'Dispute closed without changes. Tenant gets a notification.'}
                    </div>
                  </div>

                  {outcome === 'corrected' && (
                    <div style={{padding:12,background:'rgba(201,162,39,.04)',border:'1px solid rgba(201,162,39,.2)',borderRadius:8,marginBottom:12}}>
                      <div style={fieldStyle}>
                        <label style={labelStyle}>Replacement event</label>
                        <div style={{display:'flex',gap:6,marginBottom:8,flexWrap:'wrap'}}>
                          <button
                            className={`btn ${cReplaceWithSame ? 'bp' : 'bg'} bsm`}
                            onClick={()=>setCReplaceWithSame(true)}
                            type="button"
                          >
                            Same type (invalidate via dispute_corrected flag)
                          </button>
                          <button
                            className={`btn ${!cReplaceWithSame ? 'bp' : 'bg'} bsm`}
                            onClick={()=>setCReplaceWithSame(false)}
                            type="button"
                          >
                            Different type
                          </button>
                        </div>
                        {!cReplaceWithSame && (
                          <input
                            style={inputStyle}
                            value={cEventType}
                            onChange={e=>setCEventType(e.target.value)}
                            placeholder="event_type (e.g. payment_received_on_time)"
                          />
                        )}
                        {cReplaceWithSame && (
                          <div style={{fontSize:'.72rem',color:'var(--t3)'}}>
                            Re-emits as <span className="mono">{detail.disputedEventType}</span> with <code>dispute_corrected: true</code> in event_data. Use this when the original happened but the data was wrong.
                          </div>
                        )}
                      </div>
                      <div className="grid2" style={{gap:8}}>
                        <div style={{...fieldStyle, marginBottom: 0}}>
                          <label style={labelStyle}>Visibility</label>
                          <select style={inputStyle} value={cVisibility} onChange={e=>setCVisibility(e.target.value as any)}>
                            <option value="private_to_subject">Private to subject</option>
                            <option value="visible_to_current_landlord">Current landlord</option>
                            <option value="visible_to_gam_network">GAM network</option>
                          </select>
                        </div>
                        <div style={{...fieldStyle, marginBottom: 0}}>
                          <label style={labelStyle}>Attestation source</label>
                          <select style={inputStyle} value={cAttestationSource} onChange={e=>setCAttestationSource(e.target.value)}>
                            <option value="system_derived">system_derived</option>
                            <option value="gam_workflow_auto">gam_workflow_auto</option>
                            <option value="stripe_attested">stripe_attested</option>
                            <option value="landlord_self_reported_with_evidence">landlord_self_reported_with_evidence</option>
                            <option value="tenant_self_reported_with_doc_verified">tenant_self_reported_with_doc_verified</option>
                          </select>
                        </div>
                      </div>
                    </div>
                  )}

                  <div style={fieldStyle}>
                    <label style={labelStyle}>Resolver notes (optional)</label>
                    <textarea style={{...inputStyle, minHeight: 70, resize: 'vertical'}} rows={3} value={notes} onChange={e=>setNotes(e.target.value)} placeholder="Internal notes — included in the resolution event payload"/>
                  </div>

                  <div style={{display:'flex',gap:8,justifyContent:'flex-end'}}>
                    <button className="btn bg" onClick={()=>setSelected(null)} type="button">Cancel</button>
                    <button className="btn bp" onClick={onResolve} disabled={resolveMut.isLoading} type="button">
                      {resolveMut.isLoading ? 'Resolving…' : `Resolve as ${outcome.replace('_',' ')}`}
                    </button>
                  </div>
                </div>
              )}

              {detail.status?.startsWith('resolved_') && (
                <div style={{marginTop:18,paddingTop:14,borderTop:'1px solid var(--b0)',fontSize:'.78rem',color:'var(--t2)'}}>
                  Resolved on {detail.resolvedAt ? new Date(detail.resolvedAt).toLocaleString() : '—'} as <strong>{detail.status.replace('resolved_','')}</strong>.
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function PropertyReviews(){
  const[status,setStatus]=React.useState<'pending'|'resolved'>('pending')
  const[selected,setSelected]=React.useState<any>(null)
  const[resolution,setResolution]=React.useState<'approved_separate'|'merged'|'rejected'>('approved_separate')
  const[notes,setNotes]=React.useState('')
  const qcLocal=useQueryClient()
  const{data:flags=[],isLoading}=useQuery(['property-flags',status],()=>get<any[]>(`/admin/property-flags?status=${status}`))
  const resolveMut=useMutation(
    (body:{id:string;resolution:string;notes:string})=>api.post(`/admin/property-flags/${body.id}/resolve`,{resolution:body.resolution,notes:body.notes}),
    {onSuccess:()=>{qcLocal.invalidateQueries('property-flags');setSelected(null);setNotes('')}}
  )
  const fmtDate=(d:string)=>new Date(d).toLocaleString()
  const fmtAddr=(p:any,pre:string)=>`${p[pre+'street1']}${p[pre+'street2']?' '+p[pre+'street2']:''}, ${p[pre+'city']}, ${p[pre+'state']} ${p[pre+'zip']}`
  const fmtLL=(p:any,pre:string)=>`${p[pre+'landlord_first']} ${p[pre+'landlord_last']}${p[pre+'landlord_business']?' — '+p[pre+'landlord_business']:''}`
  return(
    <div>
      <div className="ph"><div><h1 className="pt">Property Reviews</h1><p className="ps">Flagged duplicate addresses awaiting review</p></div></div>
      <div className="tabs">
        <button className={`tab ${status==='pending'?'on':''}`} onClick={()=>{setStatus('pending');setSelected(null)}}>🕒 Pending ({status==='pending'?(flags as any[]).length:'…'})</button>
        <button className={`tab ${status==='resolved'?'on':''}`} onClick={()=>{setStatus('resolved');setSelected(null)}}>✅ Resolved</button>
      </div>
      <div style={{display:'grid',gridTemplateColumns:selected?'1fr 1.4fr':'1fr',gap:16}}>
        <div className="card">
          {isLoading?<div style={{padding:32,color:'var(--t3)',textAlign:'center'}}>Loading…</div>:
            (flags as any[]).length===0?<div style={{padding:32,color:'var(--t3)',textAlign:'center'}}>No {status} flags.</div>:
            <table className="tbl">
              <thead><tr><th>Detected</th><th>New Property</th><th>Conflicts With</th><th>Status</th></tr></thead>
              <tbody>
                {(flags as any[]).map((f:any)=>(
                  <tr key={f.id} onClick={()=>setSelected(f)} style={{cursor:'pointer',background:selected?.id===f.id?'var(--b1)':undefined}}>
                    <td style={{fontSize:'.72rem',color:'var(--t3)'}}>{fmtDate(f.detectedAt)}</td>
                    <td><div style={{fontWeight:600}}>{f.newName}</div><div style={{fontSize:'.7rem',color:'var(--t3)'}}>{f.newStreet1}, {f.newCity}</div></td>
                    <td><div style={{fontWeight:600}}>{f.origName}</div><div style={{fontSize:'.7rem',color:'var(--t3)'}}>{f.origLandlordFirst} {f.origLandlordLast}</div></td>
                    <td><span style={{fontSize:'.7rem',padding:'2px 8px',borderRadius:4,background:f.resolvedAt?'var(--b1)':'var(--gold)',color:f.resolvedAt?'var(--t3)':'#000'}}>{f.resolvedAt?f.resolution:'pending'}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>}
        </div>
        {selected&&(
          <div className="card" style={{padding:20}}>
            <h3 style={{margin:'0 0 16px 0',fontSize:'.95rem'}}>Side-by-side comparison</h3>
            <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:16,marginBottom:20}}>
              <div style={{border:'1px solid var(--gold)',borderRadius:8,padding:14}}>
                <div style={{fontSize:'.7rem',color:'var(--gold)',fontWeight:700,marginBottom:8}}>NEW SUBMISSION</div>
                <div style={{fontWeight:600,marginBottom:4}}>{selected.newName}</div>
                <div style={{fontSize:'.75rem',marginBottom:8}}>{fmtAddr(selected,'new_')}</div>
                <div style={{fontSize:'.7rem',color:'var(--t3)',marginBottom:4}}>Landlord</div>
                <div style={{fontSize:'.78rem',marginBottom:4}}>{fmtLL(selected,'new_')}</div>
                <div style={{fontSize:'.7rem',color:'var(--t3)'}}>{selected.newLandlordEmail}</div>
                <div style={{fontSize:'.7rem',color:'var(--t3)',marginTop:8}}>Created {fmtDate(selected.newCreatedAt)}</div>
              </div>
              <div style={{border:'1px solid var(--b1)',borderRadius:8,padding:14}}>
                <div style={{fontSize:'.7rem',color:'var(--t3)',fontWeight:700,marginBottom:8}}>EXISTING PROPERTY</div>
                <div style={{fontWeight:600,marginBottom:4}}>{selected.origName}</div>
                <div style={{fontSize:'.75rem',marginBottom:8}}>{fmtAddr(selected,'orig_')}</div>
                <div style={{fontSize:'.7rem',color:'var(--t3)',marginBottom:4}}>Landlord</div>
                <div style={{fontSize:'.78rem',marginBottom:4}}>{fmtLL(selected,'orig_')}</div>
                <div style={{fontSize:'.7rem',color:'var(--t3)'}}>{selected.origLandlordEmail}</div>
                <div style={{fontSize:'.7rem',color:'var(--t3)',marginTop:8}}>Created {fmtDate(selected.origCreatedAt)}</div>
              </div>
            </div>
            {!selected.resolvedAt?<>
              <div style={{marginBottom:12}}>
                <label style={{fontSize:'.72rem',fontWeight:600,color:'var(--t3)',display:'block',marginBottom:6}}>RESOLUTION</label>
                <select value={resolution} onChange={e=>setResolution(e.target.value as any)} className="input" style={{width:'100%'}}>
                  <option value="approved_separate">Approved — legitimate separate listings (both active)</option>
                  <option value="merged">Merged — handled manually, close flag (both active)</option>
                  <option value="rejected">Rejected — block new submission</option>
                </select>
              </div>
              <div style={{marginBottom:12}}>
                <label style={{fontSize:'.72rem',fontWeight:600,color:'var(--t3)',display:'block',marginBottom:6}}>NOTES (OPTIONAL)</label>
                <textarea value={notes} onChange={e=>setNotes(e.target.value)} className="input" style={{width:'100%',minHeight:80,resize:'vertical'}} placeholder="Context for audit trail…"/>
              </div>
              <button className="btn b-gold" style={{width:'100%'}} disabled={resolveMut.isLoading} onClick={()=>resolveMut.mutate({id:selected.id,resolution,notes})}>
                {resolveMut.isLoading?'Saving…':'Submit Resolution'}
              </button>
            </>:<>
              <div style={{padding:14,background:'var(--b1)',borderRadius:8}}>
                <div style={{fontSize:'.7rem',color:'var(--t3)',marginBottom:4}}>Resolved {fmtDate(selected.resolvedAt)}</div>
                <div style={{fontSize:'.85rem',fontWeight:600,marginBottom:6}}>{selected.resolution}</div>
                {selected.notes&&<div style={{fontSize:'.78rem',color:'var(--t1)'}}>{selected.notes}</div>}
              </div>
            </>}
          </div>
        )}
      </div>
    </div>
  )
}

// ── Subleases (S250) — admin/super_admin view of all subleases across the
// platform. Read-only — admin observes, doesn't decide. Decisions happen
// landlord-side via the landlord SubleasesPage; this surface is for ops
// visibility, dispute investigation, and forward planning.

interface AdminSubleaseRow {
  id: string
  masterLeaseId: string
  status: 'pending_invite' | 'pending' | 'active' | 'terminated'
  startDate: string
  endDate: string | null
  subMonthlyAmount: string
  masterShareAmount: string
  unitNumber: string
  propertyName: string
  landlordId: string
  sublessorName: string
  sublesseeName: string | null
  createdAt: string
  terminatedReason: string | null
}

function Subleases(){
  const [statusFilter, setStatusFilter] = React.useState<'all'|'pending_invite'|'pending'|'active'|'terminated'>('all')
  const { data: rows = [], isLoading } = useQuery<AdminSubleaseRow[]>(
    'admin-subleases',
    () => get<AdminSubleaseRow[]>('/subleases'),
  )

  const filtered = statusFilter === 'all' ? rows : rows.filter(r => r.status === statusFilter)
  const counts = {
    all: rows.length,
    pending_invite: rows.filter(r => r.status === 'pending_invite').length,
    pending: rows.filter(r => r.status === 'pending').length,
    active: rows.filter(r => r.status === 'active').length,
    terminated: rows.filter(r => r.status === 'terminated').length,
  }

  const fmtMoney = (n: string | number) => '$' + Number(n).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})
  const fmtDate = (s: string | null) => s ? new Date(s).toLocaleDateString() : '—'

  return (
    <div>
      <div className="ph">
        <div>
          <h1 className="pt">Subleases</h1>
          <p className="ps">{rows.length} sublease{rows.length === 1 ? '' : 's'} across all properties</p>
        </div>
      </div>

      <div style={{display:'flex',gap:6,marginBottom:14,flexWrap:'wrap'}}>
        {(['all','pending_invite','pending','active','terminated'] as const).map(s => (
          <button
            key={s}
            onClick={() => setStatusFilter(s)}
            style={{
              padding:'6px 12px',
              borderRadius:14,
              border: statusFilter === s ? '1px solid var(--gold)' : '1px solid var(--b1)',
              background: statusFilter === s ? 'rgba(201,162,39,.08)' : 'var(--bg3)',
              color: statusFilter === s ? 'var(--gold)' : 'var(--t2)',
              fontSize:'.78rem',
              fontWeight:600,
              cursor:'pointer',
              textTransform:'capitalize',
            }}>
            {s.replace('_',' ')} ({counts[s]})
          </button>
        ))}
      </div>

      <div className="card" style={{padding:0,overflow:'hidden'}}>
        {isLoading ? (
          <div style={{padding:32,textAlign:'center',color:'var(--t3)'}}>Loading…</div>
        ) : filtered.length === 0 ? (
          <div style={{padding:32,textAlign:'center',color:'var(--t3)'}}>No subleases in this bucket.</div>
        ) : (
          <table className="data-table" style={{width:'100%'}}>
            <thead>
              <tr>
                <th>Property · Unit</th>
                <th>Sublessor → Sublessee</th>
                <th>Term</th>
                <th>Sub rent</th>
                <th>Master share</th>
                <th>Markup</th>
                <th>Status</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(r => {
                const markup = Math.max(0, Number(r.subMonthlyAmount) - Number(r.masterShareAmount))
                return (
                  <tr key={r.id}>
                    <td>
                      <div style={{fontWeight:600,color:'var(--t0)',fontSize:'.85rem'}}>{r.propertyName}</div>
                      <div style={{fontSize:'.7rem',color:'var(--t3)'}}>Unit {r.unitNumber}</div>
                    </td>
                    <td style={{fontSize:'.82rem'}}>
                      <div>{r.sublessorName}</div>
                      <div style={{color:'var(--t3)',fontSize:'.72rem'}}>→ {r.sublesseeName ?? '(invitation pending)'}</div>
                    </td>
                    <td className="mono" style={{fontSize:'.78rem'}}>
                      {fmtDate(r.startDate)}<br/>
                      <span style={{color:'var(--t3)'}}>→ {fmtDate(r.endDate)}</span>
                    </td>
                    <td className="mono" style={{fontWeight:600}}>{fmtMoney(r.subMonthlyAmount)}</td>
                    <td className="mono" style={{color:'var(--t3)'}}>{fmtMoney(r.masterShareAmount)}</td>
                    <td className="mono" style={{color: markup > 0 ? 'var(--gold)' : 'var(--t3)', fontWeight: markup > 0 ? 600 : 400}}>{fmtMoney(markup)}</td>
                    <td>
                      <span style={{
                        padding:'2px 8px',
                        borderRadius:999,
                        fontSize:'.68rem',
                        fontWeight:600,
                        background:
                          r.status === 'active' ? 'rgba(34,197,94,.12)' :
                          r.status === 'pending' ? 'rgba(245,158,11,.12)' :
                          r.status === 'pending_invite' ? 'rgba(59,130,246,.12)' :
                          'rgba(150,150,150,.12)',
                        color:
                          r.status === 'active' ? 'var(--green)' :
                          r.status === 'pending' ? 'var(--amber)' :
                          r.status === 'pending_invite' ? '#60a5fa' :
                          'var(--t3)',
                      }}>
                        {r.status === 'pending_invite' ? 'awaiting accept' : r.status}
                      </span>
                      {r.terminatedReason && (
                        <div style={{fontSize:'.65rem',color:'var(--red)',marginTop:2}}>
                          {r.terminatedReason.slice(0, 40)}{r.terminatedReason.length > 40 ? '…' : ''}
                        </div>
                      )}
                    </td>
                    <td className="mono" style={{fontSize:'.72rem',color:'var(--t3)'}}>{fmtDate(r.createdAt)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>

      <div style={{fontSize:'.7rem',color:'var(--t3)',marginTop:14}}>
        Read-only view. Approve/deny + terminate actions happen landlord-side; admins observe.
      </div>
    </div>
  )
}

// ── Deposit Portability (S257) — admin ops surface for FlexDeposit
// carry-forwards where the deposit is held by the previous landlord
// (legacy `held_by='landlord'` deposits — most new deposits go straight
// to `gam_escrow` per the S255 architecture). The security_deposits row
// has already been re-pointed to the new lease + flipped to gam_escrow,
// but the physical funds are still in the old landlord's Connect
// balance. Admin moves the funds out-of-band (Stripe Dashboard
// reverse-Transfer or ACH) and confirms here.

interface PendingTransferRow {
  id: string
  tenantName: string
  tenantEmail: string
  totalAmount: string
  portabilityAuthorizedAt: string
  newPropertyName: string
  newUnitNumber: string
  newLandlordName: string
  newLandlordEmail: string
  prevLandlordName: string | null
  prevLandlordEmail: string | null
  prevLandlordConnectId: string | null
  notes: string | null
}

function DepositPortability() {
  const qc = useQueryClient()
  const [confirmModal, setConfirmModal] = React.useState<{ deposit: PendingTransferRow | null; notes: string }>({ deposit: null, notes: '' })
  const { data: rows = [], isLoading } = useQuery<PendingTransferRow[]>(
    'deposit-portability-pending',
    () => get<PendingTransferRow[]>('/admin/deposit-portability/pending'),
  )
  const fmt = (n: any) => '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  const fmtDate = (s: string) => s ? new Date(s).toLocaleDateString() : '—'

  const markMut = useMutation(
    ({ id, notes }: { id: string; notes: string }) =>
      post(`/admin/deposit-portability/${id}/mark-transferred`, { notes }),
    {
      onSuccess: () => {
        qc.invalidateQueries('deposit-portability-pending')
        setConfirmModal({ deposit: null, notes: '' })
      },
    },
  )

  return (
    <div>
      <div className="ph">
        <div>
          <h1 className="pt">Deposit Portability</h1>
          <p className="ps">
            {rows.length} pending transfer{rows.length === 1 ? '' : 's'} — funds still in previous landlord's Connect balance
          </p>
        </div>
      </div>

      <div className="card" style={{ padding: 16, marginBottom: 16, background: 'rgba(245,158,11,.06)', border: '1px solid rgba(245,158,11,.25)' }}>
        <div style={{ fontSize: '.82rem', color: 'var(--t1)', lineHeight: 1.5 }}>
          <strong style={{ color: 'var(--amber)' }}>Workflow:</strong> the security_deposits row has already
          been re-pointed to the new lease and flipped to <code>held_by='gam_escrow'</code>. Move the
          physical funds from the previous landlord's Connect account to GAM platform balance via
          Stripe Dashboard (reverse-Transfer on the original deposit Transfer) or out-of-band ACH.
          Once funds are confirmed in platform balance, hit "Mark transferred" to close the row.
        </div>
      </div>

      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        {isLoading ? (
          <div style={{ padding: 32, textAlign: 'center', color: 'var(--t3)' }}>Loading…</div>
        ) : rows.length === 0 ? (
          <div style={{ padding: 32, textAlign: 'center', color: 'var(--t3)' }}>No pending transfers.</div>
        ) : (
          <table className="data-table" style={{ width: '100%' }}>
            <thead>
              <tr>
                <th>Tenant</th>
                <th>Amount</th>
                <th>From landlord</th>
                <th>To lease</th>
                <th>Authorized</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.id}>
                  <td>
                    <div style={{ fontWeight: 600 }}>{r.tenantName}</div>
                    <div style={{ fontSize: '.72rem', color: 'var(--t3)' }}>{r.tenantEmail}</div>
                  </td>
                  <td className="mono" style={{ fontWeight: 700, color: 'var(--gold)' }}>{fmt(r.totalAmount)}</td>
                  <td style={{ fontSize: '.82rem' }}>
                    <div>{r.prevLandlordName ?? '(unknown — no carried_from chain)'}</div>
                    <div style={{ fontSize: '.7rem', color: 'var(--t3)' }}>{r.prevLandlordEmail ?? '—'}</div>
                    {r.prevLandlordConnectId && (
                      <div style={{ fontSize: '.65rem', color: 'var(--t3)', fontFamily: 'monospace' }}>
                        {r.prevLandlordConnectId}
                      </div>
                    )}
                  </td>
                  <td style={{ fontSize: '.82rem' }}>
                    <div>{r.newPropertyName}</div>
                    <div style={{ fontSize: '.7rem', color: 'var(--t3)' }}>Unit {r.newUnitNumber} · {r.newLandlordName}</div>
                  </td>
                  <td className="mono" style={{ fontSize: '.72rem', color: 'var(--t3)' }}>{fmtDate(r.portabilityAuthorizedAt)}</td>
                  <td>
                    <button className="btn btn-p btn-sm"
                      onClick={() => setConfirmModal({ deposit: r, notes: '' })}>
                      Mark transferred
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {confirmModal.deposit && (
        <div className="modal-ov" onClick={() => !markMut.isLoading && setConfirmModal({ deposit: null, notes: '' })}>
          <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 460 }}>
            <div className="modal-t">Confirm transfer of {fmt(confirmModal.deposit.totalAmount)}</div>
            <div style={{ fontSize: '.82rem', color: 'var(--t2)', lineHeight: 1.5, marginBottom: 12 }}>
              Confirm that the {fmt(confirmModal.deposit.totalAmount)} deposit for{' '}
              <strong>{confirmModal.deposit.tenantName}</strong> has been moved from{' '}
              <strong>{confirmModal.deposit.prevLandlordName ?? 'the previous landlord'}</strong>'s
              Connect account to GAM's platform balance.
            </div>
            <div style={{ marginBottom: 14 }}>
              <label style={{ fontSize: '.7rem', color: 'var(--t3)', display: 'block', marginBottom: 4 }}>Notes (optional — e.g., Stripe transfer reversal id)</label>
              <input
                type="text"
                value={confirmModal.notes}
                onChange={e => setConfirmModal(s => ({ ...s, notes: e.target.value }))}
                placeholder="trr_xxx or ACH ref"
                className="input"
                style={{ width: '100%' }}
              />
            </div>
            <div className="modal-f">
              <button className="btn btn-g" onClick={() => setConfirmModal({ deposit: null, notes: '' })} disabled={markMut.isLoading}>
                Cancel
              </button>
              <button className="btn btn-p"
                onClick={() => markMut.mutate({ id: confirmModal.deposit!.id, notes: confirmModal.notes })}
                disabled={markMut.isLoading}>
                {markMut.isLoading ? 'Confirming…' : 'Confirm transferred'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function Root(){
  return(
    <QueryClientProvider client={qc}>
      <AuthProvider>
        <style dangerouslySetInnerHTML={{__html:css}}/>
        <App/>
      </AuthProvider>
    </QueryClientProvider>
  )
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <SentryErrorBoundary fallback={<div style={{ padding: 40, textAlign: 'center', color: 'var(--text-0)' }}>
      <div style={{ fontSize: '1.1rem', fontWeight: 600, marginBottom: 8 }}>Something went wrong</div>
      <div style={{ fontSize: '.82rem', color: 'var(--text-3)', marginBottom: 16 }}>The error has been reported. Reload the page to try again.</div>
      <button className="btn btn-primary" onClick={() => window.location.reload()}>Reload</button>
    </div>}>
      <Root />
    </SentryErrorBoundary>
  </React.StrictMode>
)
