import React, { createContext, useContext, useState, useEffect, useCallback } from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter, Routes, Route, Navigate, NavLink, Outlet, useNavigate } from 'react-router-dom'
import { QueryClient, QueryClientProvider, useQuery, useMutation } from 'react-query'
import axios from 'axios'
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, BarChart, Bar } from 'recharts'
import { formatCurrency, getReservePhase, PLATFORM_FEES, RESERVE_CONFIG } from '@gam/shared'

const API = (import.meta as any).env?.VITE_API_URL || 'http://localhost:4000'
const api = axios.create({ baseURL: `${API}/api` })
api.interceptors.request.use(c => { const t=localStorage.getItem('gam_admin_token',{enabled:!!localStorage.getItem("gam_admin_token")}); if(t)c.headers.Authorization=`Bearer ${t}`; return c })
api.interceptors.response.use(r=>r, e=>{if(e.response?.status===401&&!e.config.url.includes('/auth/me')&&!e.config.url.includes('/auth/login')){localStorage.removeItem('gam_admin_token');window.location.href='/login'}return Promise.reject(e)})
const get=<T,>(url:string)=>{const t=localStorage.getItem('gam_admin_token');if(t)api.defaults.headers.common['Authorization']='Bearer '+t;return api.get<{success:boolean;data:T}>(url).then(r=>r.data.data)}
const post=<T,>(url:string,body?:any)=>api.post<{success:boolean;data:T;message?:string}>(url,body).then(r=>r.data)

interface AuthUser{id:string;email:string;role:string;firstName:string;lastName:string;profileId:string}
interface AuthCtx{user:AuthUser|null;token:string|null;loading:boolean;login:(e:string,p:string)=>Promise<void>;logout:()=>void}
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
      if (!u || u.role !== 'admin') { logout(); return }
      setUser({ id: u.id, email: u.email, role: u.role, firstName: u.first_name || u.firstName || '', lastName: u.last_name || u.lastName || '' })
    } catch { logout() }
    finally { setLoading(false) }
  }, [logout])

  React.useEffect(() => { refresh() }, [refresh])

  const login = async (email: string, password: string) => {
    const res = await axios.post(API + '/api/auth/login', { email, password })
    const { token: tk, user: u } = res.data.data
    if (!u || u.role !== 'admin') throw new Error('Admin access required')
    localStorage.setItem('gam_admin_token', tk)
    api.defaults.headers.common['Authorization'] = 'Bearer ' + tk
    setUser({ id: u.id, email: u.email, role: u.role, firstName: u.firstName || u.first_name || '', lastName: u.lastName || u.last_name || '' })
    setToken(tk)
  }

  return <Ctx.Provider value={{ user, token, loading, login, logout }}>{children}</Ctx.Provider>
}

const qc=new QueryClient({defaultOptions:{queries:{retry:1,staleTime:15000}}})

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
          <NavLink to="/landlords" className={({isActive})=>`ni${isActive?' active':''}`}>🏢 Landlords</NavLink>
          <NavLink to="/tenants" className={({isActive})=>`ni${isActive?' active':''}`}>👤 Tenants</NavLink>
          <NavLink to="/units" className={({isActive})=>`ni${isActive?' active':''}`}>🚪 Units</NavLink>
          <div className="nl" style={{marginTop:8}}>Finance</div>
          <NavLink to="/payments" className={({isActive})=>`ni${isActive?' active':''}`}>💳 Payments</NavLink>
          <NavLink to="/disbursements" className={({isActive})=>`ni${isActive?' active':''}`}>💸 Disbursements</NavLink>
          <NavLink to="/reserve" className={({isActive})=>`ni${isActive?' active':''}`}>🏦 Reserve & Float</NavLink>
          <div className="nl" style={{marginTop:8}}>Compliance</div>
          <NavLink to="/nacha" className={({isActive})=>`ni${isActive?' active':''}`}>⚡ NACHA Monitor</NavLink>
          <NavLink to="/maintenance" className={({isActive})=>`ni${isActive?' active':''}`}>🔧 Maintenance</NavLink>
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
function Overview(){
  const{user}=useAuth()
  const{data:stats,isLoading}=useQuery(['admin-overview',user?.id],()=>get<any>('/admin/overview'),{refetchInterval:30000,enabled:!!user,staleTime:10000})
  const{phase,rate}=getReservePhase(stats?.active_units||0)
  const reserveTarget=RESERVE_CONFIG.DEFAULT_RATE*RESERVE_CONFIG.TARGET_MONTHS*(stats?.active_units||0)*(600)
  const reservePct=stats?.reserve_balance?Math.min((stats.reserve_balance/Math.max(reserveTarget,1))*100,100):0

  const trendData=[{m:'Oct',r:1800},{m:'Nov',r:2100},{m:'Dec',r:2400},{m:'Jan',r:2700},{m:'Feb',r:3000},{m:'Mar',r:stats?.monthly_rent_volume||0}]

  if(isLoading)return<div style={{padding:32,color:'var(--t3)'}}>Loading platform data…</div>

  return(
    <div>
      <div className="ph">
        <div><h1 className="pt">Platform Overview</h1><p className="ps">Real-time operations snapshot · Auto-refreshes every 30s</p></div>
        <div style={{display:'flex',gap:8}}>
          <span className={`badge ${phase===1?'ba':phase===2?'bb':'bg2'}`}>Reserve Phase {phase} — {(rate*100).toFixed(0)}%</span>
          <span className="badge bgold">⚡ On-Time Pay Active</span>
        </div>
      </div>

      {(stats?.eviction_mode_units||0)>0&&<div className="alert ae">🚫 <strong>{stats.eviction_mode_units} unit(s) in Eviction Mode</strong> — All tenant ACH hard-blocked per A.R.S. § 33-1371. No disbursement until cleared.</div>}
      {(stats?.zero_tolerance_events||0)>0&&<div className="alert ae">⚠️ <strong>NACHA Zero-Tolerance Event</strong> — Manual review required. Check NACHA Monitor.</div>}

      <div className="grid4" style={{marginBottom:16}}>
        <div className="kpi"><div className="kl">Active Units</div><div className="kv g">{(stats?.active_units||0).toLocaleString()}</div><div className="ks">{stats?.vacant_units||0} vacant · {stats?.total_landlords||0} landlords</div></div>
        <div className="kpi"><div className="kl">Monthly Rent Volume</div><div className="kv gold">{formatCurrency(stats?.monthly_rent_volume||0)}</div><div className="ks">across {stats?.active_units||0} units</div></div>
        <div className="kpi"><div className="kl">Reserve Balance</div><div className={`kv ${reservePct>=100?'g':reservePct>=50?'a':'r'}`}>{formatCurrency(stats?.reserve_balance||0)}</div><div className="ks">{reservePct.toFixed(0)}% of target · Phase {phase}</div></div>
        <div className="kpi"><div className="kl">Float Balance</div><div className="kv b">{formatCurrency(stats?.float_balance||0)}</div><div className="ks">4.5% APY · covers disbursements</div></div>
        <div className="kpi"><div className="kl">Pending Payments</div><div className={`kv ${(stats?.pending_payments||0)>20?'r':'a'}`}>{stats?.pending_payments||0}</div><div className="ks">awaiting ACH settlement</div></div>
        <div className="kpi"><div className="kl">Pending Disbursements</div><div className={`kv ${(stats?.pending_disbursements||0)>0?'a':'g'}`}>{stats?.pending_disbursements||0}</div><div className="ks">landlord payouts queued</div></div>
        <div className="kpi"><div className="kl">Open Maintenance</div><div className="kv">{stats?.open_maintenance||0}</div><div className="ks">unresolved requests</div></div>
        <div className="kpi"><div className="kl">Total Tenants</div><div className="kv b">{(stats?.total_tenants||0).toLocaleString()}</div><div className="ks">{stats?.total_landlords||0} landlords registered</div></div>
      </div>

      <div className="grid2">
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
          <div className="dr"><span className="dk">Balance</span><span className="dv mono">{formatCurrency(stats?.reserve_balance||0)}</span></div>
          <div className="dr"><span className="dk">Target (3-mo defaults)</span><span className="dv mono">{formatCurrency(reserveTarget)}</span></div>
          <div className="dr"><span className="dk">Coverage</span><span className={`badge ${reservePct>=100?'bg2':reservePct>=50?'ba':'br'}`}>{reservePct.toFixed(0)}%</span></div>
          <div className="dr"><span className="dk">Phase</span><span className={`badge ${phase===1?'ba':phase===2?'bb':'bg2'}`}>Phase {phase} — {(rate*100).toFixed(0)}% rate</span></div>
          <div className="dr"><span className="dk">Float balance</span><span className="dv mono">{formatCurrency(stats?.float_balance||0)}</span></div>
          <div className="dr"><span className="dk">Float APY income</span><span className="dv mono" style={{color:'var(--green)'}}>+{formatCurrency((stats?.float_balance||0)*.045/12)}/mo</span></div>
        </div>
      </div>
    </div>
  )
}

// ── LANDLORDS ─────────────────────────────────────────────────
function Landlords(){
  const{user}=useAuth()
  const{data:landlords=[],isLoading}=useQuery<any[]>('landlords',()=>get('/landlords'),{enabled:!!user})
  return(
    <div>
      <div className="ph"><div><h1 className="pt">Landlords</h1><p className="ps">{landlords.length} registered</p></div></div>
      <div className="card" style={{padding:0}}>
        {isLoading?<div style={{padding:32,color:'var(--t3)',textAlign:'center'}}>Loading…</div>:(
          <table className="tbl">
            <thead><tr><th>Landlord</th><th>Business</th><th>Tier</th><th>Properties</th><th>Units</th><th>Occupied</th><th>Bank</th><th>Onboarded</th></tr></thead>
            <tbody>
              {landlords.length?landlords.map((l:any)=>(
                <tr key={l.id}>
                  <td><div style={{fontWeight:600,color:'var(--t0)'}}>{l.first_name} {l.last_name}</div><div style={{fontSize:'.68rem',color:'var(--t3)'}}>{l.email}</div></td>
                  <td style={{fontSize:'.78rem'}}>{l.business_name||'—'}</td>
                  <td><span className="badge bgold">{l.volume_tier}</span></td>
                  <td className="mono">{l.property_count}</td>
                  <td className="mono">{l.unit_count}</td>
                  <td className="mono" style={{color:'var(--green)'}}>{l.occupied_count}</td>
                  <td><span className={`badge ${l.stripe_bank_verified?'bg2':'ba'}`}>{l.stripe_bank_verified?'Verified':'Pending'}</span></td>
                  <td><span className={`badge ${l.onboarding_complete?'bg2':'ba'}`}>{l.onboarding_complete?'Complete':'Pending'}</span></td>
                </tr>
              )):<tr><td colSpan={8} style={{textAlign:'center',color:'var(--t3)',padding:32}}>No landlords yet.</td></tr>}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}

// ── UNITS ─────────────────────────────────────────────────────
function Units(){
  const{user}=useAuth()
  const{data:units=[],isLoading}=useQuery<any[]>('units',()=>get('/units'),{enabled:!!user})
  const eviction=units.filter((u:any)=>u.payment_block)
  const delinquent=units.filter((u:any)=>u.status==='delinquent')
  return(
    <div>
      <div className="ph"><div><h1 className="pt">Units</h1><p className="ps">{units.length} total · {units.filter((u:any)=>u.status==='active').length} active</p></div></div>
      {eviction.length>0&&<div className="alert ae">🚫 {eviction.length} unit(s) in Eviction Mode — ACH blocked</div>}
      {delinquent.length>0&&<div className="alert aw">⚡ {delinquent.length} delinquent unit(s) in cure window</div>}
      <div className="card" style={{padding:0}}>
        {isLoading?<div style={{padding:32,color:'var(--t3)',textAlign:'center'}}>Loading…</div>:(
          <table className="tbl">
            <thead><tr><th>Unit</th><th>Property</th><th>Tenant</th><th>Rent</th><th>Status</th><th>OTP</th><th>Eviction</th><th>ACH</th></tr></thead>
            <tbody>
              {units.map((u:any)=>(
                <tr key={u.id} style={{background:u.payment_block?'rgba(239,68,68,.03)':''}}>
                  <td className="mono" style={{color:'var(--t0)',fontWeight:600}}>{u.unit_number}</td>
                  <td style={{fontSize:'.75rem'}}>{u.property_name}</td>
                  <td style={{fontSize:'.75rem'}}>{u.tenant_first?`${u.tenant_first} ${u.tenant_last}`:<span style={{color:'var(--t3)'}}>Vacant</span>}</td>
                  <td className="mono">{formatCurrency(u.rent_amount)}</td>
                  <td><span className={`badge ${u.status==='active'?'bg2':u.status==='delinquent'?'ba':u.status==='suspended'?'br':'bmu'}`}>{u.status.replace('_',' ')}</span></td>
                  <td>{u.on_time_pay_active?<span className="badge bg2">Active</span>:<span style={{color:'var(--t3)'}}>—</span>}</td>
                  <td>{u.payment_block?<span className="badge br">🚫 BLOCKED</span>:<span style={{color:'var(--t3)'}}>—</span>}</td>
                  <td>{u.ach_verified?<span className="badge bg2">✓</span>:<span className="badge ba">Pending</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
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
        <div className="kpi"><div className="kl">Total Returns (30d)</div><div className={`kv ${(stats.total_returns||0)>5?'r':'g'}`}>{stats.total_returns||0}</div><div className="ks">ACH return events</div></div>
        <div className="kpi"><div className="kl">Zero Tolerance (30d)</div><div className={`kv ${(stats.zero_tolerance_events||0)>0?'r':'g'}`}>{stats.zero_tolerance_events||0}</div><div className="ks">R05/R07/R10/R29</div></div>
        <div className="kpi"><div className="kl">First Senders (30d)</div><div className="kv b">{stats.first_senders_30d||0}</div><div className="ks">New bank accounts</div></div>
        <div className="kpi"><div className="kl">Velocity Flags</div><div className={`kv ${(stats.velocity_flags_30d||0)>0?'a':'g'}`}>{stats.velocity_flags_30d||0}</div><div className="ks">Unusual ACH frequency</div></div>
      </div>

      {(stats.zero_tolerance_events||0)>0&&<div className="alert ae">🚨 Zero-tolerance return event detected. Tenant ACH suspended per NACHA policy. Review below.</div>}

      <div className="card" style={{padding:0}}>
        <div style={{padding:'12px 14px',borderBottom:'1px solid var(--b1)'}}><div className="ct" style={{marginBottom:0}}>ACH Monitoring Log</div></div>
        {isLoading?<div style={{padding:32,color:'var(--t3)',textAlign:'center'}}>Loading…</div>:(
          <table className="tbl">
            <thead><tr><th>Time</th><th>Event</th><th>Tenant</th><th>Amount</th><th>Return Code</th><th>Zero-Tolerance</th><th>Resolved</th></tr></thead>
            <tbody>
              {logs.length?logs.map((l:any)=>(
                <tr key={l.id} style={{background:l.zero_tolerance_flag?'rgba(239,68,68,.04)':''}}>
                  <td className="mono" style={{fontSize:'.7rem',color:'var(--t3)'}}>{new Date(l.created_at).toLocaleString()}</td>
                  <td><span className={`badge ${l.event_type==='zero_tolerance_block'?'br':l.event_type==='velocity_flag'?'ba':'bmu'}`}>{l.event_type.replace(/_/g,' ')}</span></td>
                  <td style={{fontSize:'.75rem'}}>{l.first_name?`${l.first_name} ${l.last_name}`:'—'}</td>
                  <td className="mono">{l.amount?formatCurrency(l.amount):'—'}</td>
                  <td>{l.return_code?<span className={`badge ${['R05','R07','R10','R29'].includes(l.return_code)?'br':'ba'}`}>{l.return_code}</span>:<span style={{color:'var(--t3)'}}>—</span>}</td>
                  <td>{l.zero_tolerance_flag?<span className="badge br">🚫 YES</span>:<span style={{color:'var(--t3)'}}>—</span>}</td>
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

// ── PAYMENTS + DISBURSEMENTS + RESERVE (stubs) ────────────────
function Payments(){
  const{user}=useAuth()
  const{data:payments=[],isLoading}=useQuery<any[]>('payments',()=>get('/payments'),{enabled:!!user})
  const ST:Record<string,string>={settled:'bg2',pending:'ba',failed:'br',returned:'br',processing:'bb'}
  return(
    <div>
      <div className="ph"><div><h1 className="pt">Payments</h1><p className="ps">All ACH collections platform-wide</p></div></div>
      <div className="card" style={{padding:0}}>
        {isLoading?<div style={{padding:32,color:'var(--t3)',textAlign:'center'}}>Loading…</div>:(
          <table className="tbl">
            <thead><tr><th>Due</th><th>Unit</th><th>Type</th><th>Amount</th><th>Status</th><th>Entry</th><th>Return</th><th>Zero-Tol</th></tr></thead>
            <tbody>
              {payments.length?payments.map((p:any)=>(
                <tr key={p.id} style={{background:p.zero_tolerance_flag?'rgba(239,68,68,.03)':''}}>
                  <td className="mono" style={{fontSize:'.72rem'}}>{new Date(p.due_date).toLocaleDateString()}</td>
                  <td className="mono">{p.unit_number||'—'}</td>
                  <td><span className="badge bmu">{p.type}</span></td>
                  <td className="mono" style={{color:'var(--t0)',fontWeight:600}}>{formatCurrency(p.amount)}</td>
                  <td><span className={`badge ${ST[p.status]||'bmu'}`}>{p.status}</span></td>
                  <td className="mono" style={{fontSize:'.7rem',color:'var(--t3)'}}>{p.entry_description}</td>
                  <td>{p.return_code?<span className={`badge ${p.zero_tolerance_flag?'br':'ba'}`}>{p.return_code}</span>:<span style={{color:'var(--t3)'}}>—</span>}</td>
                  <td>{p.zero_tolerance_flag?<span className="badge br">🚫</span>:<span style={{color:'var(--t3)'}}>—</span>}</td>
                </tr>
              )):<tr><td colSpan={8} style={{textAlign:'center',color:'var(--t3)',padding:32}}>No payments yet.</td></tr>}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}

function Disbursements(){
  const{user}=useAuth()
  const{data:disbs=[],isLoading}=useQuery<any[]>('disbs',()=>get('/disbursements'),{enabled:!!user})
  return(
    <div>
      <div className="ph"><div><h1 className="pt">Disbursements</h1><p className="ps">On-Time Pay SLA — initiated on or before 1st business day</p></div></div>
      <div className="alert agold">⚡ <strong>On-Time Pay SLA:</strong> Platform initiates disbursements on the last business day before the 1st. Reserve funds the gap if tenant ACH hasn't settled.</div>
      <div className="card" style={{padding:0}}>
        {isLoading?<div style={{padding:32,color:'var(--t3)',textAlign:'center'}}>Loading…</div>:(
          <table className="tbl">
            <thead><tr><th>Landlord</th><th>Target Date</th><th>Amount</th><th>Units</th><th>Status</th><th>From Reserve</th><th>Settled</th></tr></thead>
            <tbody>
              {disbs.length?disbs.map((d:any)=>(
                <tr key={d.id}>
                  <td style={{fontSize:'.75rem'}}>{d.first_name} {d.last_name}</td>
                  <td className="mono" style={{fontSize:'.75rem'}}>{new Date(d.target_date).toLocaleDateString()}</td>
                  <td className="mono" style={{color:'var(--green)',fontWeight:700}}>{formatCurrency(d.amount)}</td>
                  <td className="mono">{d.unit_count}</td>
                  <td><span className={`badge ${d.status==='settled'?'bg2':d.status==='pending'?'ba':'br'}`}>{d.status}</span></td>
                  <td>{d.from_reserve?<span className="badge bgold">Reserve {formatCurrency(d.reserve_amount)}</span>:<span style={{color:'var(--t3)'}}>—</span>}</td>
                  <td className="mono" style={{fontSize:'.72rem',color:'var(--t3)'}}>{d.settled_at?new Date(d.settled_at).toLocaleDateString():'—'}</td>
                </tr>
              )):<tr><td colSpan={7} style={{textAlign:'center',color:'var(--t3)',padding:32}}>No disbursements yet.</td></tr>}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}

function Reserve(){
  const{user}=useAuth()
  const{data:stats}=useQuery('admin-overview',()=>get<any>('/admin/overview'),{enabled:!!user})
  const{phase,rate}=getReservePhase(stats?.active_units||0)
  const target=(stats?.active_units||0)*600*RESERVE_CONFIG.DEFAULT_RATE*RESERVE_CONFIG.TARGET_MONTHS
  const pct=target>0?Math.min(((stats?.reserve_balance||0)/target)*100,100):0
  return(
    <div>
      <div className="ph"><div><h1 className="pt">Reserve &amp; Float</h1><p className="ps">On-Time Pay operational capital</p></div></div>
      <div className="grid2" style={{marginBottom:16}}>
        <div className="card">
          <div className="ct">Default Reserve Fund</div>
          <div className="dr"><span className="dk">Balance</span><span className="dv mono" style={{color:pct>=100?'var(--green)':pct>=50?'var(--amber)':'var(--red)'}}>{formatCurrency(stats?.reserve_balance||0)}</span></div>
          <div className="dr"><span className="dk">Target (3-mo defaults)</span><span className="dv mono">{formatCurrency(target)}</span></div>
          <div className="dr"><span className="dk">Coverage</span><span className={`badge ${pct>=100?'bg2':pct>=50?'ba':'br'}`}>{pct.toFixed(0)}%</span></div>
          <div className="dr"><span className="dk">Phase</span><span className={`badge ${phase===1?'ba':phase===2?'bb':'bg2'}`}>Phase {phase} — {(rate*100).toFixed(0)}% contribution rate</span></div>
          <div style={{marginTop:14,fontSize:'.78rem',color:'var(--t3)',lineHeight:1.5}}>
            Reserve is operational working capital — NOT insurance reserves. Platform fulfills Disbursement SLA as service obligation per agent-of-payee structure (A.R.S. § 33-1314).<br/><strong style={{color:'var(--amber)'}}>Attorney review required before launch.</strong>
          </div>
        </div>
        <div className="card">
          <div className="ct">Float Account</div>
          <div className="dr"><span className="dk">Balance</span><span className="dv mono" style={{color:'var(--blue)'}}>{formatCurrency(stats?.float_balance||0)}</span></div>
          <div className="dr"><span className="dk">Seed capital</span><span className="dv mono">$25,000</span></div>
          <div className="dr"><span className="dk">APY</span><span className="dv mono">4.5%</span></div>
          <div className="dr"><span className="dk">Monthly interest</span><span className="dv mono" style={{color:'var(--green)'}}>+{formatCurrency((stats?.float_balance||0)*.045/12)}</span></div>
          <div className="dr"><span className="dk">Float covers</span><span className="dv mono">{stats?.float_balance&&stats?.monthly_rent_volume?((stats.float_balance/stats.monthly_rent_volume)*100).toFixed(0)+'%':'—'} of monthly disbursements</span></div>
          <div style={{marginTop:14,fontSize:'.78rem',color:'var(--t3)'}}>Platform fronts full month rent from float before tenant ACH settles. Standard tenants: 3-day float. SSI/SSDI: 19-day float.</div>
        </div>
      </div>
    </div>
  )
}

function Tenants(){
  const{user}=useAuth()
  const{data:units=[],isLoading}=useQuery<any[]>('units',()=>get('/units'),{enabled:!!user})
  const tenants=units.filter((u:any)=>u.tenant_first)
  return(
    <div>
      <div className="ph"><div><h1 className="pt">Tenants</h1><p className="ps">{tenants.length} active</p></div></div>
      <div className="card" style={{padding:0}}>
        {isLoading?<div style={{padding:32,color:'var(--t3)',textAlign:'center'}}>Loading…</div>:(
          <table className="tbl">
            <thead><tr><th>Tenant</th><th>Unit</th><th>ACH</th><th>OTP</th><th>SSI</th><th>Credit</th><th>Late Count</th></tr></thead>
            <tbody>
              {tenants.map((u:any)=>(
                <tr key={u.id}>
                  <td><div style={{fontWeight:600,color:'var(--t0)',fontSize:'.78rem'}}>{u.tenant_first} {u.tenant_last}</div><div style={{fontSize:'.65rem',color:'var(--t3)'}}>{u.tenant_email}</div></td>
                  <td className="mono">{u.unit_number}</td>
                  <td><span className={`badge ${u.ach_verified?'bg2':'ba'}`}>{u.ach_verified?'✓':'Pending'}</span></td>
                  <td><span className={`badge ${u.on_time_pay_enrolled?'bgold':'bmu'}`}>{u.on_time_pay_enrolled?'Active':'—'}</span></td>
                  <td>{u.ssi_ssdi?<span className="badge bgold">SSI/SSDI</span>:<span style={{color:'var(--t3)'}}>—</span>}</td>
                  <td><span className={`badge ${u.credit_reporting_enrolled?'bg2':'bmu'}`}>{u.credit_reporting_enrolled?'Active':'—'}</span></td>
                  <td className="mono" style={{color:u.late_payment_count>1?'var(--amber)':'var(--t3)'}}>{u.late_payment_count||0}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
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
      <div className="card" style={{padding:0}}>
        {isLoading?<div style={{padding:32,color:'var(--t3)',textAlign:'center'}}>Loading…</div>:(
          <table className="tbl">
            <thead><tr><th>Date</th><th>Unit</th><th>Title</th><th>Priority</th><th>Status</th><th>Contractor</th><th>Cost</th><th>Fee (8%)</th></tr></thead>
            <tbody>
              {reqs.length?reqs.map((r:any)=>(
                <tr key={r.id}>
                  <td className="mono" style={{fontSize:'.7rem'}}>{new Date(r.created_at).toLocaleDateString()}</td>
                  <td className="mono">{r.unit_number}</td>
                  <td style={{color:'var(--t0)',fontSize:'.78rem'}}>{r.title}</td>
                  <td><span className={`badge ${PRI[r.priority]}`}>{r.priority}</span></td>
                  <td><span className={`badge ${ST[r.status]}`}>{r.status.replace('_',' ')}</span></td>
                  <td style={{fontSize:'.75rem'}}>{r.contractor_name||<span style={{color:'var(--t3)'}}>Unassigned</span>}</td>
                  <td className="mono">{r.actual_cost?formatCurrency(r.actual_cost):'—'}</td>
                  <td className="mono" style={{color:'var(--gold)'}}>{r.platform_fee?formatCurrency(r.platform_fee):'—'}</td>
                </tr>
              )):<tr><td colSpan={8} style={{textAlign:'center',color:'var(--t3)',padding:32}}>No maintenance requests.</td></tr>}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}

// ── LOGIN ─────────────────────────────────────────────────────
function LoginPage(){
  React.useEffect(()=>{
    localStorage.removeItem('gam_admin_token')
    delete api.defaults.headers.common['Authorization']
  },[])
  const{login}=useAuth();const navigate=useNavigate()
  const[email,setEmail]=useState('');const[pw,setPw]=useState('');const[err,setErr]=useState('');const[loading,setLoading]=useState(false)
  const onSubmit=async(e:React.FormEvent)=>{
    e.preventDefault();setLoading(true);setErr('')
    try{await login(email,pw)}
    catch(ex:any){setErr(ex.message||'Login failed')}
    finally{setLoading(false)}
  }
  return(
    <div style={{minHeight:'100vh',display:'flex',alignItems:'center',justifyContent:'center',background:'var(--bg0)',padding:20}}>
      <div style={{width:'100%',maxWidth:380}}>
        <div style={{textAlign:'center',marginBottom:40}}>
          <div style={{fontFamily:'var(--font-d)',fontSize:'1.8rem',fontWeight:800,color:'var(--red)',marginBottom:8}}>⚠ ADMIN CONSOLE</div>
          <div style={{color:'var(--t3)',fontSize:'.82rem'}}>Gold Asset Management · Internal Access Only</div>
        </div>
        <div className="card" style={{padding:24}}>
          {err&&<div className="alert ae" style={{marginBottom:14}}>{err}</div>}
          <form onSubmit={onSubmit}>
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

// ── APP ───────────────────────────────────────────────────────
function App(){
  const{token,user,loading}=useAuth()
  if(loading)return<div className="loading">Loading…</div>
  return(
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={user?<Navigate to="/overview" replace/>:<LoginPage/>}/>
        <Route path="/" element={user&&user.role==='admin'?<Layout/>:<Navigate to="/login" replace/>}>
          <Route index element={<Navigate to="/overview" replace/>}/>
          <Route path="overview"      element={<Overview/>}/>
          <Route path="landlords"     element={<Landlords/>}/>
          <Route path="tenants"       element={<Tenants/>}/>
          <Route path="units"         element={<Units/>}/>
          <Route path="payments"      element={<Payments/>}/>
          <Route path="disbursements" element={<Disbursements/>}/>
          <Route path="reserve"       element={<Reserve/>}/>
          <Route path="nacha"         element={<NachaMonitor/>}/>
          <Route path="maintenance"   element={<Maintenance/>}/>
        </Route>
      </Routes>
    </BrowserRouter>
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

ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><Root/></React.StrictMode>)
