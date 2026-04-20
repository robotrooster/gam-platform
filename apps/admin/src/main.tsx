import React, { createContext, useContext, useState, useEffect, useCallback } from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter, Routes, Route, Navigate, NavLink, Outlet, useNavigate } from 'react-router-dom'
import { QueryClient, QueryClientProvider, useQuery, useMutation, useQueryClient } from 'react-query'
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
      if (!u || (u.role !== 'admin' && u.role !== 'super_admin')) { logout(); return }
      setUser({ id: u.id, email: u.email, role: u.role, firstName: u.firstName || '', lastName: u.lastName || '', profileId: u.profileId || '' })
    } catch { logout() }
    finally { setLoading(false) }
  }, [logout])

  React.useEffect(() => { refresh() }, [refresh])

  const login = async (email: string, password: string) => {
    const res = await axios.post(API + '/api/auth/login', { email, password })
    const { token: tk, user: u } = res.data.data
    if (!u || (u.role !== 'admin' && u.role !== 'super_admin')) throw new Error('Admin access required')
    localStorage.setItem('gam_admin_token', tk)
    api.defaults.headers.common['Authorization'] = 'Bearer ' + tk
    setUser({ id: u.id, email: u.email, role: u.role, firstName: u.firstName || '', lastName: u.lastName || '', profileId: u.profileId || '' })
    setToken(tk)
  }

  return <Ctx.Provider value={{ user, token, loading, login, logout }}>{children}</Ctx.Provider>
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
          {isSuperAdmin&&<NavLink to="/reserve" className={({isActive})=>`ni${isActive?' active':''}`}>🏦 Reserve & Float</NavLink>}
          <div className="nl" style={{marginTop:8}}>Compliance</div>
          {isSuperAdmin&&<NavLink to="/nacha" className={({isActive})=>`ni${isActive?' active':''}`}>⚡ NACHA Monitor</NavLink>}
          <div className="nl" style={{marginTop:8}}>Community</div>
          {isSuperAdmin&&<NavLink to="/bulletin" className={({isActive})=>`ni${isActive?' active':''}`}>📋 Bulletin Board</NavLink>}
          <div className="nl" style={{marginTop:8}}>Tools</div>
          {isSuperAdmin&&<button className="ni" onClick={()=>{const t=localStorage.getItem('gam_admin_token');window.open('http://localhost:3006'+(t?'?token='+t:''),'_blank')}}>📒 GAM Books</button>}

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
  const{data:stats,isLoading}=useQuery('onboarding-overview',()=>get<any>('/admin/onboarding/overview'),{enabled:!!user,staleTime:30000,refetchOnWindowFocus:false})
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
        <div className="card" style={{padding:0}}>
          {tab==='landlords'&&(lLoading?<div style={{padding:32,color:'var(--t3)',textAlign:'center'}}>Loading…</div>:(
              <table className="tbl">
                <thead><tr><th>Landlord</th><th>Properties</th><th>Units</th><th>Bank</th><th>Onboarded</th></tr></thead>
                <tbody>
                  {(landlords as any[]).map((l:any)=>(
                    <tr key={l.id} style={{cursor:'pointer',background:selectedLandlord?.id===l.id?'rgba(201,162,39,.05)':''}} onClick={()=>{setSelectedLandlord(l);setSelectedTenant(null)}}>
                      <td><div style={{fontWeight:600,color:'var(--t0)',fontSize:'.78rem'}}>{l.firstName} {l.lastName}</div><div style={{fontSize:'.65rem',color:'var(--t3)'}}>{l.email}</div></td>
                      <td className="mono">{l.propertyCount}</td>
                      <td className="mono">{l.unitCount}</td>
                      <td><span className={`badge ${l.stripeBankVerified?'bg2':'br'}`}>{l.stripeBankVerified?'✓':'Missing'}</span></td>
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
                  {!landlordDetail.landlord.stripeBankVerified&&(
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
  const isSuperAdmin=user?.role==='super_admin'
  const{data:income}=useQuery('income-projection',()=>get<any>('/admin/income/projection'),{enabled:!!user,staleTime:60000,refetchOnWindowFocus:false})
  const{data:stats,isLoading}=useQuery(['admin-overview',user?.id],()=>get<any>('/admin/overview'),{refetchInterval:30000,enabled:!!user,staleTime:30000,keepPreviousData:true})
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
            <span>💳 Credit: <strong style={{color:'var(--t0)'}}>{stats?.flexCredit||0}</strong></span>
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
    const aInc=(!a.stripeBankVerified||!a.onboardingComplete)?0:1
    const bInc=(!b.stripeBankVerified||!b.onboardingComplete)?0:1
    return aInc-bInc
  }),[landlords])
  const filteredLandlords=React.useMemo(()=>lSearch?sortedLandlords.filter((l:any)=>`${l.firstName} ${l.lastName} ${l.email} ${l.businessName||""}`.toLowerCase().includes(lSearch.toLowerCase())):sortedLandlords,[sortedLandlords,lSearch])
  const[selected,setSelected]=React.useState<any>(null)
  const{data:detail}=useQuery(['landlord-detail',selected?.id],()=>get<any>('/admin/onboarding/landlord/'+selected.id),{enabled:!!selected?.id,staleTime:15000})
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
                    <td><span className={`badge ${l.stripeBankVerified?'bg2':'br'}`}>{l.stripeBankVerified?'✓':'Missing'}</span></td>
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
                {!detail.landlord.stripeBankVerified&&(
                  <button className="btn bg-btn" disabled={!!resending} onClick={()=>resend('bank_verification',selected.id)}>
                    {resending==='bank_verification'?'Sending…':'🏦 Resend Bank Verification'}
                  </button>
                )}
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
            </div>
          )}
        </div>
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

// ── LOGIN ─────────────────────────────────────────────────────
function LoginPage(){
  const{login}=useAuth();const navigate=useNavigate()
  React.useEffect(()=>{
    localStorage.removeItem('gam_admin_token')
    delete api.defaults.headers.common['Authorization']
  },[])
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

// ── APP ───────────────────────────────────────────────────────
function App(){
  const{token,user,loading}=useAuth()
  if(loading)return<div className="loading">Loading…</div>
  return(
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={user?<Navigate to="/overview" replace/>:<LoginPage/>}/>
        <Route path="/" element={(user&&(user.role==='admin'||user.role==='super_admin'))?<Layout/>:<Navigate to="/login" replace/>}>
          <Route index element={<Navigate to="/overview" replace/>}/>
          <Route path="overview"      element={user?.role==='super_admin'?<Overview/>:<AdminOnboardingOverview/>}/>
          <Route path="onboarding"    element={<AdminOnboardingOverview/>}/>
          <Route path="landlords"     element={<Landlords/>}/>
          <Route path="tenants"       element={<Tenants/>}/>
          <Route path="property-reviews" element={<PropertyReviews/>}/>
          <Route path="units"         element={<Units/>}/>
          <Route path="payments"      element={<Payments/>}/>
          <Route path="disbursements" element={<Disbursements/>}/>
          <Route path="reserve"       element={<SuperAdminGuard><Reserve/></SuperAdminGuard>}/>
          <Route path="nacha"         element={<SuperAdminGuard><NachaMonitor/></SuperAdminGuard>}/>
          <Route path="maintenance"   element={<Maintenance/>}/>
          <Route path="bulletin"      element={<SuperAdminGuard><BulletinBoard/></SuperAdminGuard>}/>
        </Route>
      </Routes>
    </BrowserRouter>
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
