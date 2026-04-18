import React, { useState, useCallback, useContext } from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter, Routes, Route, Navigate, NavLink, Outlet, useNavigate } from 'react-router-dom'
import { QueryClient, QueryClientProvider, useQuery, useMutation, useQueryClient } from 'react-query'
import axios from 'axios'

const API = 'http://localhost:4000'
const api = axios.create({ baseURL: `${API}/api` })
const TOKEN = 'gam_admin_ops_token'
api.interceptors.request.use(c => { const t=localStorage.getItem(TOKEN); if(t) c.headers.Authorization=`Bearer ${t}`; return c })
api.interceptors.response.use(r=>r, e=>{ if(e.response?.status===401&&!e.config.url.includes('/auth/')){ localStorage.removeItem(TOKEN); window.location.href='/login' } return Promise.reject(e) })
const get = <T,>(url: string) => api.get<{success:boolean;data:T}>(url).then(r=>r.data.data)
const post = <T,>(url: string, body?: any) => api.post<{success:boolean;data:T;message?:string}>(url,body).then(r=>r.data)

interface AuthUser { id:string; email:string; role:string; firstName:string; lastName:string }
interface AuthCtx { user:AuthUser|null; loading:boolean; login:(e:string,p:string)=>Promise<void>; logout:()=>void }
const Ctx = React.createContext<AuthCtx>(null!)
const useAuth = () => useContext(Ctx)

function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AuthUser|null>(null)
  const [loading, setLoading] = useState(true)
  const logout = useCallback(() => { localStorage.removeItem(TOKEN); delete api.defaults.headers.common['Authorization']; setUser(null) }, [])
  React.useEffect(() => {
    const t = localStorage.getItem(TOKEN)
    if (!t) { setLoading(false); return }
    api.defaults.headers.common['Authorization'] = 'Bearer ' + t
    api.get('/auth/me').then(res => {
      const u = res.data.data
      if (!u || (u.role !== 'admin' && u.role !== 'super_admin')) { logout(); return }
      setUser({ id:u.id, email:u.email, role:u.role, firstName:u.first_name||u.firstName||'', lastName:u.last_name||u.lastName||'' })
    }).catch(logout).finally(() => setLoading(false))
  }, [logout])
  const login = async (email: string, password: string) => {
    const res = await axios.post(`${API}/api/auth/login`, { email, password })
    const { token: tk, user: u } = res.data.data
    if (!u || (u.role !== 'admin' && u.role !== 'super_admin')) throw new Error('Admin access required')
    localStorage.setItem(TOKEN, tk)
    api.defaults.headers.common['Authorization'] = 'Bearer ' + tk
    setUser({ id:u.id, email:u.email, role:u.role, firstName:u.firstName||u.first_name||'', lastName:u.lastName||u.last_name||'' })
  }
  return <Ctx.Provider value={{ user, loading, login, logout }}>{children}</Ctx.Provider>
}

const qc = new QueryClient({ defaultOptions: { queries: { retry:1, staleTime:30000, refetchOnWindowFocus:false } } })

const fmt = (n: any) => n!=null ? new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(+n) : '—'

const css = `
@import url('https://fonts.googleapis.com/css2?family=Syne:wght@600;700;800&family=DM+Sans:wght@300;400;500;600&family=DM+Mono:wght@400;500&display=swap');
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg0:#080a0c;--bg1:#0d1014;--bg2:#121519;--bg3:#181c22;--bg4:#1e2330;
  --b0:#1a1f28;--b1:#222a38;--b2:#2a3547;
  --t0:#eef0f6;--t1:#b8c4d8;--t2:#7a8aaa;--t3:#475060;
  --gold:#c9a227;--green:#22c55e;--red:#ef4444;--amber:#f59e0b;--blue:#3b82f6;
  --font-d:'Syne',sans-serif;--font-b:'DM Sans',sans-serif;--font-m:'DM Mono',monospace
}
html{-webkit-font-smoothing:antialiased}
body{font-family:var(--font-b);background:var(--bg0);color:var(--t1);line-height:1.6;min-height:100vh}
h1,h2,h3{font-family:var(--font-d);color:var(--t0)}
button{cursor:pointer;font-family:var(--font-b)}
input,select,textarea{font-family:var(--font-b)}
.shell{display:flex;min-height:100vh}
.sidebar{width:220px;flex-shrink:0;background:var(--bg1);border-right:1px solid var(--b0);position:fixed;top:0;left:0;bottom:0;z-index:50;display:flex;flex-direction:column;overflow-y:auto}
.main{flex:1;margin-left:220px;min-height:100vh;display:flex;flex-direction:column}
.topbar{height:52px;background:var(--bg1);border-bottom:1px solid var(--b0);display:flex;align-items:center;padding:0 24px;position:sticky;top:0;z-index:40}
.page{flex:1;padding:28px;max-width:1600px;width:100%}
.logo{padding:18px;border-bottom:1px solid var(--b0)}
.logo-n{font-family:var(--font-d);font-size:1rem;font-weight:800;color:var(--gold)}
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
.ph{display:flex;align-items:center;justify-content:space-between;margin-bottom:20px;padding-bottom:14px;border-bottom:1px solid var(--b0);flex-wrap:wrap;gap:10px}
.pt{font-family:var(--font-d);font-size:1.4rem;font-weight:800;color:var(--t0)}
.ps{font-size:.78rem;color:var(--t3);margin-top:2px}
.kpi{background:var(--bg2);border:1px solid var(--b1);border-radius:10px;padding:16px;position:relative;overflow:hidden}
.kpi::after{content:'';position:absolute;bottom:0;left:0;right:0;height:2px;background:linear-gradient(90deg,var(--gold),transparent);opacity:.4}
.kl{font-size:.65rem;color:var(--t3);text-transform:uppercase;letter-spacing:.09em;font-weight:600;margin-bottom:6px}
.kv{font-family:var(--font-d);font-size:1.6rem;font-weight:800;color:var(--t0);line-height:1;margin-bottom:4px}
.ks{font-size:.7rem;color:var(--t3)}
.kv.g{color:var(--green)}.kv.r{color:var(--red)}.kv.a{color:var(--amber)}.kv.gold{color:var(--gold)}.kv.b{color:var(--blue)}
.btn{display:inline-flex;align-items:center;gap:6px;padding:7px 14px;border-radius:7px;font-size:.78rem;font-weight:600;border:none;cursor:pointer;transition:all .12s;font-family:var(--font-b)}
.bp{background:var(--gold);color:#080a0c}.bp:hover{background:#d9af3a}
.bg{background:var(--bg4);color:var(--t1);border:1px solid var(--b2)}.bg:hover{background:var(--bg3)}
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
.tab:hover{color:var(--t1)}.tab.on{color:var(--gold);border-bottom-color:var(--gold)}
.search-input{width:100%;background:var(--bg3);border:1px solid var(--b1);border-radius:7px;color:var(--t0);padding:7px 10px;font-size:.78rem;outline:none}
.search-input:focus{border-color:var(--gold)}
@keyframes spin{to{transform:rotate(360deg)}}
@media(max-width:900px){.grid2,.grid3,.grid4{grid-template-columns:1fr}}
`

function Layout() {
  const { user, logout } = useAuth()
  const navigate = useNavigate()
  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="logo">
          <div className="logo-n">GAM Operations</div>
          <div className="logo-s">Admin Console</div>
        </div>
        <nav className="nav">
          <div className="nl">Onboarding</div>
          <NavLink to="/onboarding" className={({isActive})=>`ni${isActive?' active':''}`}>🚀 Onboarding</NavLink>
          <div className="nl" style={{marginTop:8}}>Platform</div>
          <NavLink to="/landlords" className={({isActive})=>`ni${isActive?' active':''}`}>🏢 Landlords</NavLink>
          <NavLink to="/tenants"   className={({isActive})=>`ni${isActive?' active':''}`}>👤 Tenants</NavLink>
          <NavLink to="/property-reviews" className={({isActive})=>`ni${isActive?' active':''}`}>📋 Property Reviews</NavLink>
          <NavLink to="/units"     className={({isActive})=>`ni${isActive?' active':''}`}>🚪 Units</NavLink>
          <NavLink to="/payments"  className={({isActive})=>`ni${isActive?' active':''}`}>💳 Payments</NavLink>
        </nav>
        <div className="sfooter">
          <div style={{padding:'6px 10px',marginBottom:4}}>
            <div style={{fontWeight:600,color:'var(--t0)',fontSize:'.78rem'}}>{user?.firstName} {user?.lastName}</div>
            <div style={{fontSize:'.65rem',color:'var(--t3)'}}>Operations Admin</div>
          </div>
          <button className="ni" onClick={()=>{logout();navigate('/login')}} style={{color:'var(--red)'}}>🚪 Sign out</button>
        </div>
      </aside>
      <div className="main">
        <header className="topbar">
          <span style={{fontSize:'.72rem',color:'var(--t3)',fontFamily:'var(--font-m)'}}>GAM Platform — Operations Console</span>
        </header>
        <div className="page"><Outlet /></div>
      </div>
    </div>
  )
}

function SearchInput({ value, onChange, placeholder }: { value:string; onChange:(v:string)=>void; placeholder:string }) {
  return (
    <div style={{padding:'10px 12px',borderBottom:'1px solid var(--b0)'}}>
      <input className="search-input" type="text" placeholder={placeholder} value={value} onChange={e=>onChange(e.target.value)} />
    </div>
  )
}

function DetailEmpty() {
  return <div className="card" style={{textAlign:'center',padding:'48px 20px',color:'var(--t3)'}}>Select a row to view details</div>
}

// ── ONBOARDING ────────────────────────────────────────────────
function Onboarding() {
  const { user } = useAuth()
  const { data: stats } = useQuery('ops-overview', () => get<any>('/admin/onboarding/overview'), { enabled: !!user })
  const { data: landlords = [] } = useQuery('ops-landlords', () => get<any[]>('/landlords'), { enabled: !!user })
  const { data: tenants = [] } = useQuery('ops-tenants', () => get<any[]>('/admin/tenants'), { enabled: !!user })
  const [tab, setTab] = useState<'landlords'|'tenants'>('landlords')
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<any>(null)
  const { data: detail } = useQuery(['ops-detail', selected?.id, tab], () =>
    tab === 'landlords'
      ? get<any>('/admin/onboarding/landlord/' + selected.id)
      : get<any>('/admin/onboarding/tenant/' + selected.id),
    { enabled: !!selected?.id, staleTime: 15000 }
  )
  const [resending, setResending] = useState<string|null>(null)
  const [msg, setMsg] = useState('')

  const resend = async (type: string, id: string) => {
    setResending(type)
    try { await post('/admin/onboarding/resend', { type, targetId: id }); setMsg('Notification queued'); setTimeout(()=>setMsg(''),3000) }
    catch (e: any) { setMsg('Failed: ' + e.message) }
    finally { setResending(null) }
  }

  const sortedLandlords = React.useMemo(() => [...(landlords as any[])].sort((a,b) => {
    const aI = (!a.stripe_bank_verified||!a.onboarding_complete)?0:1
    const bI = (!b.stripe_bank_verified||!b.onboarding_complete)?0:1
    return aI - bI
  }), [landlords])

  const sortedTenants = React.useMemo(() => [...(tenants as any[])].sort((a,b) => {
    const aI = (!a.ach_verified)?0:1
    const bI = (!b.ach_verified)?0:1
    return aI - bI
  }), [tenants])

  const filteredL = React.useMemo(() => search ? sortedLandlords.filter((l:any) => `${l.first_name} ${l.last_name} ${l.email} ${l.business_name||''}`.toLowerCase().includes(search.toLowerCase())) : sortedLandlords, [sortedLandlords, search])
  const filteredT = React.useMemo(() => search ? sortedTenants.filter((t:any) => `${t.first_name} ${t.last_name} ${t.email} ${t.unit_number||''} ${t.property_name||''}`.toLowerCase().includes(search.toLowerCase())) : sortedTenants, [sortedTenants, search])

  return (
    <div>
      <div className="ph"><div><h1 className="pt">Onboarding Console</h1><p className="ps">Help landlords and tenants complete setup</p></div></div>
      {msg && <div className={`alert ${msg.startsWith('F')?'ae':'ag'}`}>{msg}</div>}
      <div className="grid4" style={{marginBottom:20}}>
        <div className="kpi" style={{cursor:'pointer',borderColor:tab==='landlords'?'var(--gold)':'var(--b1)'}} onClick={()=>{setTab('landlords');setSelected(null)}}>
          <div className="kl">Landlords — No Bank</div>
          <div className={`kv ${(stats?.landlords_no_bank||0)>0?'r':'g'}`}>{stats?.landlords_no_bank||0}</div>
          <div className="ks">Bank not verified</div>
        </div>
        <div className="kpi" style={{cursor:'pointer',borderColor:tab==='tenants'?'var(--gold)':'var(--b1)'}} onClick={()=>{setTab('tenants');setSelected(null)}}>
          <div className="kl">Tenants — No ACH</div>
          <div className={`kv ${(stats?.tenants_no_ach||0)>0?'a':'g'}`}>{stats?.tenants_no_ach||0}</div>
          <div className="ks">ACH not verified</div>
        </div>
        <div className="kpi">
          <div className="kl">Tenants — No Flex</div>
          <div className={`kv ${(stats?.tenants_no_flex||0)>0?'a':'g'}`}>{stats?.tenants_no_flex||0}</div>
          <div className="ks">No flex products</div>
        </div>
        <div className="kpi">
          <div className="kl">Vacant Units</div>
          <div className="kv b">{stats?.vacant_units||0}</div>
          <div className="ks">{stats?.units_no_tenant||0} without tenant</div>
        </div>
      </div>
      <div className="tabs">
        <button className={`tab ${tab==='landlords'?'on':''}`} onClick={()=>{setTab('landlords');setSelected(null);setSearch('')}}>🏢 Landlords ({(landlords as any[]).length})</button>
        <button className={`tab ${tab==='tenants'?'on':''}`} onClick={()=>{setTab('tenants');setSelected(null);setSearch('')}}>👤 Tenants ({(tenants as any[]).length})</button>
      </div>
      <div className="grid2" style={{gap:16,alignItems:'start'}}>
        <div className="card" style={{padding:0}}>
          <SearchInput value={search} onChange={setSearch} placeholder={tab==='landlords'?'Search landlords…':'Search tenants…'} />
          {tab==='landlords' ? (
            <table className="tbl">
              <thead><tr><th>Landlord</th><th>Units</th><th>Bank</th><th>Onboarded</th></tr></thead>
              <tbody>
                {filteredL.map((l:any) => (
                  <tr key={l.id} style={{cursor:'pointer',background:selected?.id===l.id?'rgba(201,162,39,.05)':''}} onClick={()=>setSelected(l)}>
                    <td><div style={{fontWeight:600,color:'var(--t0)'}}>{l.first_name} {l.last_name}</div><div style={{fontSize:'.68rem',color:'var(--t3)'}}>{l.email}</div></td>
                    <td className="mono">{l.unit_count}</td>
                    <td><span className={`badge ${l.stripe_bank_verified?'bg2':'br'}`}>{l.stripe_bank_verified?'✓':'Missing'}</span></td>
                    <td><span className={`badge ${l.onboarding_complete?'bg2':'ba'}`}>{l.onboarding_complete?'Done':'Pending'}</span></td>
                  </tr>
                ))}
                {filteredL.length===0&&<tr><td colSpan={4}><div className="empty">No landlords found</div></td></tr>}
              </tbody>
            </table>
          ) : (
            <table className="tbl">
              <thead><tr><th>Tenant</th><th>Unit</th><th>ACH</th><th>Flex</th></tr></thead>
              <tbody>
                {filteredT.map((t:any) => (
                  <tr key={t.id} style={{cursor:'pointer',background:selected?.id===t.id?'rgba(201,162,39,.05)':''}} onClick={()=>setSelected(t)}>
                    <td><div style={{fontWeight:600,color:'var(--t0)'}}>{t.first_name} {t.last_name}</div><div style={{fontSize:'.68rem',color:'var(--t3)'}}>{t.email}</div></td>
                    <td style={{fontSize:'.72rem'}}>{t.unit_number||<span style={{color:'var(--t3)'}}>—</span>}</td>
                    <td><span className={`badge ${t.ach_verified?'bg2':'br'}`}>{t.ach_verified?'✓':'No'}</span></td>
                    <td><span className={`badge ${(t.on_time_pay_enrolled||t.credit_reporting_enrolled||t.flex_deposit_enrolled||t.float_fee_active)?'bg2':'bmu'}`}>{(t.on_time_pay_enrolled||t.credit_reporting_enrolled||t.flex_deposit_enrolled||t.float_fee_active)?'Active':'None'}</span></td>
                  </tr>
                ))}
                {filteredT.length===0&&<tr><td colSpan={4}><div className="empty">No tenants found</div></td></tr>}
              </tbody>
            </table>
          )}
        </div>
        <div>
          {!selected ? <DetailEmpty /> : detail && (
            <div className="card">
              {tab==='landlords' && detail.landlord && <>
                <div style={{marginBottom:16,paddingBottom:12,borderBottom:'1px solid var(--b0)'}}>
                  <div style={{fontFamily:'var(--font-d)',fontWeight:800,fontSize:'1.1rem',color:'var(--t0)'}}>{detail.landlord.first_name} {detail.landlord.last_name}</div>
                  <div style={{fontSize:'.72rem',color:'var(--t3)',marginTop:2}}>{detail.landlord.email}</div>
                  {detail.landlord.business_name&&<div style={{fontSize:'.72rem',color:'var(--t2)',marginTop:2}}>{detail.landlord.business_name}</div>}
                </div>
                <div className="ct">Onboarding Checklist</div>
                {detail.checklist.map((item:any) => (
                  <div key={item.key} style={{display:'flex',alignItems:'center',gap:10,padding:'7px 0',borderBottom:'1px solid var(--b0)'}}>
                    <span>{item.done?'✅':'⬜'}</span>
                    <span style={{fontSize:'.82rem',color:item.done?'var(--t0)':'var(--t2)',flex:1}}>{item.label}</span>
                    {!item.done&&<span className="badge br">Incomplete</span>}
                  </div>
                ))}
                <div style={{marginTop:16,display:'flex',flexDirection:'column',gap:8}}>
                  <button className="btn bg" disabled={!!resending} onClick={()=>resend('landlord_setup',selected.id)}>{resending==='landlord_setup'?'Sending…':'📧 Resend Setup Email'}</button>
                  {!detail.landlord.stripe_bank_verified&&<button className="btn bg" disabled={!!resending} onClick={()=>resend('bank_verification',selected.id)}>{resending==='bank_verification'?'Sending…':'🏦 Resend Bank Verification'}</button>}
                </div>
              </>}
              {tab==='tenants' && detail.tenant && <>
                <div style={{marginBottom:16,paddingBottom:12,borderBottom:'1px solid var(--b0)'}}>
                  <div style={{fontFamily:'var(--font-d)',fontWeight:800,fontSize:'1.1rem',color:'var(--t0)'}}>{detail.tenant.first_name} {detail.tenant.last_name}</div>
                  <div style={{fontSize:'.72rem',color:'var(--t3)',marginTop:2}}>{detail.tenant.email}</div>
                  {detail.tenant.unit_number&&<div style={{fontSize:'.72rem',color:'var(--t2)',marginTop:4}}>{detail.tenant.property_name} · Unit {detail.tenant.unit_number}</div>}
                </div>
                <div className="ct">Onboarding Checklist</div>
                {detail.checklist.map((item:any) => (
                  <div key={item.key} style={{display:'flex',alignItems:'center',gap:10,padding:'7px 0',borderBottom:'1px solid var(--b0)'}}>
                    <span>{item.done?'✅':'⬜'}</span>
                    <span style={{fontSize:'.82rem',color:item.done?'var(--t0)':'var(--t2)',flex:1}}>{item.label}</span>
                    {!item.done&&<span className="badge br">Incomplete</span>}
                  </div>
                ))}
                <div style={{marginTop:16,display:'flex',flexDirection:'column',gap:8}}>
                  <button className="btn bg" disabled={!!resending} onClick={()=>resend('tenant_invite',selected.id)}>{resending==='tenant_invite'?'Sending…':'📧 Resend Invite'}</button>
                  {!detail.tenant.ach_verified&&<button className="btn bg" disabled={!!resending} onClick={()=>resend('ach_enrollment',selected.id)}>{resending==='ach_enrollment'?'Sending…':'🏦 Resend ACH Enrollment'}</button>}
                </div>
              </>}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ── LANDLORDS ─────────────────────────────────────────────────
function Landlords() {
  const { user } = useAuth()
  const { data: landlords = [], isLoading } = useQuery<any[]>('ops-ll', () => get('/landlords'), { enabled: !!user })
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<any>(null)
  const { data: detail } = useQuery(['ops-ll-detail', selected?.id], () => get<any>('/admin/onboarding/landlord/' + selected.id), { enabled: !!selected?.id })
  const sorted = React.useMemo(() => [...(landlords as any[])].sort((a,b)=>(!a.stripe_bank_verified?0:1)-(!b.stripe_bank_verified?0:1)), [landlords])
  const filtered = React.useMemo(() => search ? sorted.filter((l:any)=>`${l.first_name} ${l.last_name} ${l.email} ${l.business_name||''}`.toLowerCase().includes(search.toLowerCase())) : sorted, [sorted,search])
  return (
    <div>
      <div className="ph"><div><h1 className="pt">Landlords</h1><p className="ps">{(landlords as any[]).length} registered</p></div></div>
      <div className="grid2" style={{gap:16,alignItems:'start'}}>
        <div className="card" style={{padding:0}}>
          <SearchInput value={search} onChange={setSearch} placeholder="Search landlords…" />
          {isLoading?<div style={{padding:32,textAlign:'center',color:'var(--t3)'}}>Loading…</div>:(
            <table className="tbl">
              <thead><tr><th>Landlord</th><th>Properties</th><th>Units</th><th>Bank</th><th>Onboarded</th></tr></thead>
              <tbody>
                {filtered.map((l:any)=>(
                  <tr key={l.id} style={{cursor:'pointer',background:selected?.id===l.id?'rgba(201,162,39,.05)':''}} onClick={()=>setSelected(l)}>
                    <td><div style={{fontWeight:600,color:'var(--t0)'}}>{l.first_name} {l.last_name}</div><div style={{fontSize:'.68rem',color:'var(--t3)'}}>{l.email}</div></td>
                    <td className="mono">{l.property_count}</td>
                    <td className="mono">{l.unit_count} <span style={{color:'var(--t3)'}}>({l.occupied_count} occ)</span></td>
                    <td><span className={`badge ${l.stripe_bank_verified?'bg2':'br'}`}>{l.stripe_bank_verified?'✓':'Missing'}</span></td>
                    <td><span className={`badge ${l.onboarding_complete?'bg2':'ba'}`}>{l.onboarding_complete?'Done':'Pending'}</span></td>
                  </tr>
                ))}
                {filtered.length===0&&<tr><td colSpan={5}><div className="empty">No landlords found</div></td></tr>}
              </tbody>
            </table>
          )}
        </div>
        <div>
          {!selected?<DetailEmpty/>:detail&&(
            <div className="card">
              <div style={{marginBottom:16,paddingBottom:12,borderBottom:'1px solid var(--b0)'}}>
                <div style={{fontFamily:'var(--font-d)',fontWeight:800,fontSize:'1.1rem',color:'var(--t0)'}}>{detail.landlord.first_name} {detail.landlord.last_name}</div>
                <div style={{fontSize:'.72rem',color:'var(--t3)',marginTop:2}}>{detail.landlord.email}</div>
                {detail.landlord.business_name&&<div style={{fontSize:'.72rem',color:'var(--t2)',marginTop:2}}>{detail.landlord.business_name}</div>}
              </div>
              <div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr',gap:8,marginBottom:16}}>
                {[['Properties',detail.counts.property_count],['Units',detail.counts.unit_count],['With Tenants',detail.counts.units_with_tenants]].map(([l,v]:any)=>(
                  <div key={l} style={{textAlign:'center',padding:'10px',background:'var(--bg3)',borderRadius:8}}>
                    <div style={{fontFamily:'var(--font-d)',fontSize:'1.3rem',fontWeight:700,color:'var(--t0)'}}>{v}</div>
                    <div style={{fontSize:'.65rem',color:'var(--t3)'}}>{l}</div>
                  </div>
                ))}
              </div>
              <div className="ct">Onboarding Checklist</div>
              {detail.checklist.map((item:any)=>(
                <div key={item.key} style={{display:'flex',alignItems:'center',gap:10,padding:'7px 0',borderBottom:'1px solid var(--b0)'}}>
                  <span>{item.done?'✅':'⬜'}</span>
                  <span style={{fontSize:'.82rem',color:item.done?'var(--t0)':'var(--t2)',flex:1}}>{item.label}</span>
                  {!item.done&&<span className="badge br">Incomplete</span>}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ── TENANTS ───────────────────────────────────────────────────
function Tenants() {
  const { user } = useAuth()
  const { data: tenants = [], isLoading } = useQuery<any[]>('ops-tenants', () => get('/admin/tenants'), { enabled: !!user })
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<any>(null)
  const { data: detail } = useQuery(['ops-t-detail', selected?.id], () => get<any>('/admin/onboarding/tenant/' + selected.id), { enabled: !!selected?.id })
  const sorted = React.useMemo(() => [...(tenants as any[])].sort((a,b)=>(!a.ach_verified?0:1)-(!b.ach_verified?0:1)), [tenants])
  const filtered = React.useMemo(() => search ? sorted.filter((t:any)=>`${t.first_name} ${t.last_name} ${t.email} ${t.unit_number||''} ${t.property_name||''}`.toLowerCase().includes(search.toLowerCase())) : sorted, [sorted,search])
  return (
    <div>
      <div className="ph"><div><h1 className="pt">Tenants</h1><p className="ps">{(tenants as any[]).length} registered</p></div></div>
      <div className="grid2" style={{gap:16,alignItems:'start'}}>
        <div className="card" style={{padding:0}}>
          <SearchInput value={search} onChange={setSearch} placeholder="Search tenants…" />
          {isLoading?<div style={{padding:32,textAlign:'center',color:'var(--t3)'}}>Loading…</div>:(
            <table className="tbl">
              <thead><tr><th>Tenant</th><th>Unit</th><th>ACH</th><th>Flex</th><th>Late</th></tr></thead>
              <tbody>
                {filtered.map((t:any)=>(
                  <tr key={t.id} style={{cursor:'pointer',background:selected?.id===t.id?'rgba(201,162,39,.05)':''}} onClick={()=>setSelected(t)}>
                    <td><div style={{fontWeight:600,color:'var(--t0)'}}>{t.first_name} {t.last_name}</div><div style={{fontSize:'.68rem',color:'var(--t3)'}}>{t.email}</div></td>
                    <td style={{fontSize:'.72rem'}}>{t.unit_number?`${t.property_name} · ${t.unit_number}`:<span style={{color:'var(--t3)'}}>—</span>}</td>
                    <td><span className={`badge ${t.ach_verified?'bg2':'br'}`}>{t.ach_verified?'✓':'No'}</span></td>
                    <td><span className={`badge ${(t.on_time_pay_enrolled||t.credit_reporting_enrolled||t.flex_deposit_enrolled||t.float_fee_active)?'bg2':'bmu'}`}>{(t.on_time_pay_enrolled||t.credit_reporting_enrolled||t.flex_deposit_enrolled||t.float_fee_active)?'Active':'None'}</span></td>
                    <td className="mono" style={{color:(t.late_payment_count||0)>1?'var(--amber)':'var(--t3)'}}>{t.late_payment_count||0}</td>
                  </tr>
                ))}
                {filtered.length===0&&<tr><td colSpan={5}><div className="empty">No tenants found</div></td></tr>}
              </tbody>
            </table>
          )}
        </div>
        <div>
          {!selected?<DetailEmpty/>:detail&&(
            <div className="card">
              <div style={{marginBottom:16,paddingBottom:12,borderBottom:'1px solid var(--b0)'}}>
                <div style={{fontFamily:'var(--font-d)',fontWeight:800,fontSize:'1.1rem',color:'var(--t0)'}}>{detail.tenant.first_name} {detail.tenant.last_name}</div>
                <div style={{fontSize:'.72rem',color:'var(--t3)',marginTop:2}}>{detail.tenant.email}</div>
                {detail.tenant.unit_number&&<div style={{fontSize:'.72rem',color:'var(--t2)',marginTop:4}}>{detail.tenant.property_name} · Unit {detail.tenant.unit_number}</div>}
                {detail.tenant.landlord_first&&<div style={{fontSize:'.72rem',color:'var(--t3)',marginTop:2}}>Landlord: {detail.tenant.landlord_first} {detail.tenant.landlord_last}</div>}
              </div>
              <div className="ct">Onboarding Checklist</div>
              {detail.checklist.map((item:any)=>(
                <div key={item.key} style={{display:'flex',alignItems:'center',gap:10,padding:'7px 0',borderBottom:'1px solid var(--b0)'}}>
                  <span>{item.done?'✅':'⬜'}</span>
                  <span style={{fontSize:'.82rem',color:item.done?'var(--t0)':'var(--t2)',flex:1}}>{item.label}</span>
                  {!item.done&&<span className="badge br">Incomplete</span>}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ── UNITS ─────────────────────────────────────────────────────
function Units() {
  const { user } = useAuth()
  const { data: units = [], isLoading } = useQuery<any[]>('ops-units', () => get('/units'), { enabled: !!user })
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<any>(null)
  const filtered = React.useMemo(() => {
    const u = units as any[]
    if (!search) return u
    const q = search.toLowerCase()
    return u.filter((u:any) => `${u.unit_number} ${u.property_name} ${u.tenant_first||''} ${u.tenant_last||''} ${u.tenant_email||''}`.toLowerCase().includes(q))
  }, [units, search])
  return (
    <div>
      <div className="ph"><div><h1 className="pt">Units</h1><p className="ps">{(units as any[]).length} total · {(units as any[]).filter((u:any)=>u.status==='active').length} active</p></div></div>
      <div className="grid2" style={{gap:16,alignItems:'start'}}>
        <div className="card" style={{padding:0}}>
          <SearchInput value={search} onChange={setSearch} placeholder="Search units, properties, tenants…" />
          {isLoading?<div style={{padding:32,textAlign:'center',color:'var(--t3)'}}>Loading…</div>:(
            <table className="tbl">
              <thead><tr><th>Unit</th><th>Property</th><th>Tenant</th><th>Rent</th><th>Status</th></tr></thead>
              <tbody>
                {filtered.map((u:any)=>(
                  <tr key={u.id} style={{cursor:'pointer',background:selected?.id===u.id?'rgba(201,162,39,.05)':''}} onClick={()=>setSelected(u)}>
                    <td className="mono" style={{fontWeight:600,color:'var(--t0)'}}>{u.unit_number}</td>
                    <td style={{fontSize:'.75rem'}}>{u.property_name}</td>
                    <td style={{fontSize:'.75rem'}}>{u.tenant_first?`${u.tenant_first} ${u.tenant_last}`:<span style={{color:'var(--t3)'}}>Vacant</span>}</td>
                    <td className="mono">{fmt(u.rent_amount)}</td>
                    <td><span className={`badge ${u.status==='active'?'bg2':u.status==='delinquent'?'ba':'bmu'}`}>{u.status}</span></td>
                  </tr>
                ))}
                {filtered.length===0&&<tr><td colSpan={5}><div className="empty">No units found</div></td></tr>}
              </tbody>
            </table>
          )}
        </div>
        <div>
          {!selected?<DetailEmpty/>:(
            <div className="card">
              <div style={{marginBottom:16,paddingBottom:12,borderBottom:'1px solid var(--b0)'}}>
                <div style={{fontFamily:'var(--font-d)',fontWeight:800,fontSize:'1.1rem',color:'var(--t0)'}}>Unit {selected.unit_number}</div>
                <div style={{fontSize:'.72rem',color:'var(--t3)',marginTop:2}}>{selected.property_name}</div>
                {selected.street1&&<div style={{fontSize:'.72rem',color:'var(--t3)',marginTop:2}}>{selected.street1}, {selected.city}</div>}
              </div>
              <div className="dr"><span className="dk">Status</span><span className={`badge ${selected.status==='active'?'bg2':selected.status==='delinquent'?'ba':'bmu'}`}>{selected.status}</span></div>
              <div className="dr"><span className="dk">Rent</span><span className="dv mono">{fmt(selected.rent_amount)}/mo</span></div>
              <div className="dr"><span className="dk">Deposit</span><span className="dv mono">{fmt(selected.security_deposit||0)}</span></div>
              <div className="dr"><span className="dk">Bedrooms</span><span className="dv">{selected.bedrooms||'—'}</span></div>
              <div className="dr"><span className="dk">Bathrooms</span><span className="dv">{selected.bathrooms||'—'}</span></div>
              <div className="dr"><span className="dk">Sq Ft</span><span className="dv">{selected.sqft?.toLocaleString()||'—'}</span></div>
              <div className="dr"><span className="dk">Listed</span><span className={`badge ${selected.listed_vacant?'bg2':'bmu'}`}>{selected.listed_vacant?'Yes':'No'}</span></div>
              {selected.tenant_first&&<>
                <div className="ct" style={{marginTop:16}}>Tenant</div>
                <div className="dr"><span className="dk">Name</span><span className="dv">{selected.tenant_first} {selected.tenant_last}</span></div>
                <div className="dr"><span className="dk">Email</span><span className="dv" style={{fontSize:'.75rem'}}>{selected.tenant_email||'—'}</span></div>
                <div className="dr"><span className="dk">ACH</span><span className={`badge ${selected.ach_verified?'bg2':'ba'}`}>{selected.ach_verified?'Verified':'Pending'}</span></div>
              </>}
              {!selected.tenant_first&&<div style={{marginTop:12,padding:'12px',background:'var(--bg3)',borderRadius:8,fontSize:'.78rem',color:'var(--t3)',textAlign:'center'}}>Vacant — no tenant assigned</div>}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ── PAYMENTS ──────────────────────────────────────────────────
function Payments() {
  const { user } = useAuth()
  const { data: payments = [], isLoading } = useQuery<any[]>('ops-payments', () => get('/payments'), { enabled: !!user })
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<any>(null)
  const ST: Record<string,string> = { settled:'bg2', pending:'ba', failed:'br', returned:'br', processing:'bb' }
  const filtered = React.useMemo(() => search ? (payments as any[]).filter((p:any)=>`${p.property_name||''} ${p.unit_number||''} ${p.tenant_first||''} ${p.tenant_last||''} ${p.type} ${p.status}`.toLowerCase().includes(search.toLowerCase())) : (payments as any[]), [payments, search])
  return (
    <div>
      <div className="ph"><div><h1 className="pt">Payments</h1><p className="ps">All ACH collections platform-wide</p></div></div>
      <div className="card" style={{padding:0}}>
        <SearchInput value={search} onChange={setSearch} placeholder="Search by property, unit, tenant, type, status…" />
        {isLoading?<div style={{padding:32,textAlign:'center',color:'var(--t3)'}}>Loading…</div>:(
          <table className="tbl">
            <thead><tr><th>Due</th><th>Property · Unit</th><th>Tenant</th><th>Type</th><th>Amount</th><th>Status</th></tr></thead>
            <tbody>
              {filtered.length?filtered.map((p:any)=>(
                <tr key={p.id} style={{cursor:'pointer',background:selected?.id===p.id?'rgba(201,162,39,.04)':''}} onClick={()=>setSelected(p)}>
                  <td className="mono" style={{fontSize:'.72rem'}}>{new Date(p.due_date).toLocaleDateString()}</td>
                  <td style={{fontSize:'.75rem'}}><span style={{color:'var(--t3)'}}>{p.property_name||'—'}</span>{p.property_name&&' · '}<span className="mono">{p.unit_number||'—'}</span></td>
                  <td style={{fontSize:'.75rem'}}>{p.tenant_first?`${p.tenant_first} ${p.tenant_last}`:<span style={{color:'var(--t3)'}}>—</span>}</td>
                  <td><span className="badge bmu">{p.type}</span></td>
                  <td className="mono" style={{fontWeight:600,color:'var(--t0)'}}>{fmt(p.amount)}</td>
                  <td><span className={`badge ${ST[p.status]||'bmu'}`}>{p.status}</span></td>
                </tr>
              )):<tr><td colSpan={6}><div className="empty">{search?'No payments match your search.':'No payments yet.'}</div></td></tr>}
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
            <div className="dr"><span className="dk">Property</span><span className="dv">{selected.property_name||'—'}</span></div>
            <div className="dr"><span className="dk">Unit</span><span className="dv mono">{selected.unit_number||'—'}</span></div>
            <div className="dr"><span className="dk">Tenant</span><span className="dv">{selected.tenant_first?`${selected.tenant_first} ${selected.tenant_last}`:'—'}</span></div>
            <div className="dr"><span className="dk">Type</span><span className="dv">{selected.type}</span></div>
            <div className="dr"><span className="dk">Amount</span><span className="dv mono" style={{color:'var(--gold)',fontWeight:700}}>{fmt(selected.amount)}</span></div>
            <div className="dr"><span className="dk">Due Date</span><span className="dv mono">{new Date(selected.due_date).toLocaleDateString()}</span></div>
            <div className="dr"><span className="dk">Status</span><span className={`badge ${ST[selected.status]||'bmu'}`}>{selected.status}</span></div>
            {selected.return_code&&<div className="dr"><span className="dk">Return Code</span><span className="badge ba">{selected.return_code}</span></div>}
          </div>
        </div>
      )}
    </div>
  )
}

// ── LOGIN ─────────────────────────────────────────────────────
function LoginPage() {
  const { login } = useAuth()
  const navigate = useNavigate()
  const [email, setEmail] = useState('')
  const [pw, setPw] = useState('')
  const [err, setErr] = useState('')
  const [loading, setLoading] = useState(false)
  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault(); setLoading(true); setErr('')
    try { await login(email, pw); navigate('/onboarding') }
    catch (ex: any) { setErr(ex.message || 'Login failed') }
    finally { setLoading(false) }
  }
  return (
    <div style={{minHeight:'100vh',display:'flex',alignItems:'center',justifyContent:'center',background:'var(--bg0)',padding:20}}>
      <div style={{width:'100%',maxWidth:380}}>
        <div style={{textAlign:'center',marginBottom:40}}>
          <div style={{fontFamily:'var(--font-d)',fontSize:'1.8rem',fontWeight:800,color:'var(--gold)',marginBottom:8}}>GAM Operations</div>
          <div style={{color:'var(--t3)',fontSize:'.82rem'}}>Admin Operations Console</div>
        </div>
        <div className="card" style={{padding:24}}>
          {err&&<div className="alert ae" style={{marginBottom:14}}>{err}</div>}
          <form onSubmit={onSubmit}>
            <div style={{marginBottom:14}}>
              <label style={{display:'block',fontSize:'.72rem',fontWeight:600,color:'var(--t3)',marginBottom:5,textTransform:'uppercase',letterSpacing:'.06em'}}>Email</label>
              <input style={{width:'100%',background:'var(--bg3)',border:'1px solid var(--b1)',borderRadius:7,color:'var(--t0)',padding:'8px 11px',fontSize:'.875rem',outline:'none'}} type="email" value={email} onChange={e=>setEmail(e.target.value)} autoFocus required/>
            </div>
            <div style={{marginBottom:16}}>
              <label style={{display:'block',fontSize:'.72rem',fontWeight:600,color:'var(--t3)',marginBottom:5,textTransform:'uppercase',letterSpacing:'.06em'}}>Password</label>
              <input style={{width:'100%',background:'var(--bg3)',border:'1px solid var(--b1)',borderRadius:7,color:'var(--t0)',padding:'8px 11px',fontSize:'.875rem',outline:'none'}} type="password" value={pw} onChange={e=>setPw(e.target.value)} required/>
            </div>
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
function App() {
  const { user, loading } = useAuth()
  if (loading) return <div className="loading">Loading…</div>
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={user ? <Navigate to="/onboarding" replace/> : <LoginPage/>}/>
        <Route path="/" element={user ? <Layout/> : <Navigate to="/login" replace/>}>
          <Route index element={<Navigate to="/onboarding" replace/>}/>
          <Route path="onboarding" element={<Onboarding/>}/>
          <Route path="landlords"  element={<Landlords/>}/>
          <Route path="tenants"    element={<Tenants/>}/>
          <Route path="property-reviews" element={<PropertyReviews/>}/>
          <Route path="units"      element={<Units/>}/>
          <Route path="payments"   element={<Payments/>}/>
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
                    <td style={{fontSize:'.72rem',color:'var(--t3)'}}>{fmtDate(f.detected_at)}</td>
                    <td><div style={{fontWeight:600}}>{f.new_name}</div><div style={{fontSize:'.7rem',color:'var(--t3)'}}>{f.new_street1}, {f.new_city}</div></td>
                    <td><div style={{fontWeight:600}}>{f.orig_name}</div><div style={{fontSize:'.7rem',color:'var(--t3)'}}>{f.orig_landlord_first} {f.orig_landlord_last}</div></td>
                    <td><span style={{fontSize:'.7rem',padding:'2px 8px',borderRadius:4,background:f.resolved_at?'var(--b1)':'var(--gold)',color:f.resolved_at?'var(--t3)':'#000'}}>{f.resolved_at?f.resolution:'pending'}</span></td>
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
                <div style={{fontWeight:600,marginBottom:4}}>{selected.new_name}</div>
                <div style={{fontSize:'.75rem',marginBottom:8}}>{fmtAddr(selected,'new_')}</div>
                <div style={{fontSize:'.7rem',color:'var(--t3)',marginBottom:4}}>Landlord</div>
                <div style={{fontSize:'.78rem',marginBottom:4}}>{fmtLL(selected,'new_')}</div>
                <div style={{fontSize:'.7rem',color:'var(--t3)'}}>{selected.new_landlord_email}</div>
                <div style={{fontSize:'.7rem',color:'var(--t3)',marginTop:8}}>Created {fmtDate(selected.new_created_at)}</div>
              </div>
              <div style={{border:'1px solid var(--b1)',borderRadius:8,padding:14}}>
                <div style={{fontSize:'.7rem',color:'var(--t3)',fontWeight:700,marginBottom:8}}>EXISTING PROPERTY</div>
                <div style={{fontWeight:600,marginBottom:4}}>{selected.orig_name}</div>
                <div style={{fontSize:'.75rem',marginBottom:8}}>{fmtAddr(selected,'orig_')}</div>
                <div style={{fontSize:'.7rem',color:'var(--t3)',marginBottom:4}}>Landlord</div>
                <div style={{fontSize:'.78rem',marginBottom:4}}>{fmtLL(selected,'orig_')}</div>
                <div style={{fontSize:'.7rem',color:'var(--t3)'}}>{selected.orig_landlord_email}</div>
                <div style={{fontSize:'.7rem',color:'var(--t3)',marginTop:8}}>Created {fmtDate(selected.orig_created_at)}</div>
              </div>
            </div>
            {!selected.resolved_at?<>
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
                <div style={{fontSize:'.7rem',color:'var(--t3)',marginBottom:4}}>Resolved {fmtDate(selected.resolved_at)}</div>
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

function Root() {
  return (
    <QueryClientProvider client={qc}>
      <AuthProvider>
        <style dangerouslySetInnerHTML={{__html:css}}/>
        <App/>
      </AuthProvider>
    </QueryClientProvider>
  )
}

ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><Root/></React.StrictMode>)
