import React, { createContext, useContext, useState, useCallback } from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter, Routes, Route, Navigate, NavLink, Link, Outlet, useNavigate, useSearchParams } from 'react-router-dom'
import { QueryClient, QueryClientProvider, useQuery } from 'react-query'
import axios from 'axios'

const PROP_API = 'http://localhost:4001'
const GAM_API  = 'http://localhost:4000'
const TOKEN_KEYS = ['gam_admin_token', 'gam_prop_token']
const getToken = () => TOKEN_KEYS.map(k => localStorage.getItem(k)).find(Boolean) || null

const api = axios.create({ baseURL: PROP_API })
api.interceptors.request.use(c => { const t=getToken(); if(t) c.headers.Authorization=`Bearer ${t}`; return c })
api.interceptors.response.use(r=>r, e=>{ if(e.response?.status===401){ TOKEN_KEYS.forEach(k=>localStorage.removeItem(k)); window.location.href='/login' } return Promise.reject(e) })

const get = <T,>(url: string, params?: any) => api.get<T>(url, { params }).then(r => r.data)

const ALLOWED = ['admin','super_admin','landlord','bookkeeper']
interface AuthUser { id:string; email:string; role:string; firstName:string; lastName:string }
interface AuthCtx { user:AuthUser|null; loading:boolean; login:(e:string,p:string)=>Promise<void>; logout:()=>void }
const Ctx = createContext<AuthCtx>(null!)
const useAuth = () => useContext(Ctx)

function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AuthUser|null>(null)
  const [loading, setLoading] = useState(true)
  const logout = useCallback(() => { TOKEN_KEYS.forEach(k=>localStorage.removeItem(k)); delete api.defaults.headers.common['Authorization']; setUser(null) }, [])

  React.useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const urlToken = params.get('token')
    if (urlToken) { localStorage.setItem('gam_prop_token', urlToken); window.history.replaceState({}, '', window.location.pathname) }
    const t = getToken()
    if (!t) { setLoading(false); return }
    api.defaults.headers.common['Authorization'] = 'Bearer ' + t
    axios.get(GAM_API + '/api/auth/me', { headers: { Authorization: 'Bearer ' + t } })
      .then(res => {
        const u = res.data.data
        if (!u || !ALLOWED.includes(u.role)) { logout(); return }
        setUser({ id:u.id, email:u.email, role:u.role, firstName:u.first_name||u.firstName||'', lastName:u.last_name||u.lastName||'' })
      }).catch(logout).finally(() => setLoading(false))
  }, [logout])

  const login = async (email: string, password: string) => {
    const res = await axios.post(GAM_API + '/api/auth/login', { email, password })
    const { token: tk, user: u } = res.data.data
    if (!u || !ALLOWED.includes(u.role)) throw new Error('Admin or Landlord access required')
    localStorage.setItem('gam_prop_token', tk)
    api.defaults.headers.common['Authorization'] = 'Bearer ' + tk
    setUser({ id:u.id, email:u.email, role:u.role, firstName:u.firstName||u.first_name||'', lastName:u.last_name||u.lastName||'' })
  }

  return <Ctx.Provider value={{ user, loading, login, logout }}>{children}</Ctx.Provider>
}

const qc = new QueryClient({ defaultOptions: { queries: { retry: 1, staleTime: 30000 } } })

const css = `
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg0:#06080a;--bg1:#0a0d10;--bg2:#0f1318;--bg3:#141920;--bg4:#1a2030;
  --b0:#181e28;--b1:#1e2838;--b2:#263045;
  --t0:#eef2f8;--t1:#b0c0d8;--t2:#6a7d9a;--t3:#3a4a60;
  --gold:#c9a227;--green:#22c55e;--red:#ef4444;--amber:#f59e0b;--blue:#3b82f6;--teal:#14b8a6;--purple:#a855f7;
  --font-d:'Syne',sans-serif;--font-b:'DM Sans',sans-serif;--font-m:'DM Mono',monospace
}
html{-webkit-font-smoothing:antialiased}
body{font-family:var(--font-b);background:var(--bg0);color:var(--t1);line-height:1.6;min-height:100vh}
h1,h2,h3{font-family:var(--font-d);color:var(--t0);line-height:1.2}
button{cursor:pointer;font-family:var(--font-b)}input,select{font-family:var(--font-b)}
.shell{display:flex;min-height:100vh}
.sidebar{width:220px;flex-shrink:0;background:var(--bg1);border-right:1px solid var(--b0);position:fixed;top:0;left:0;bottom:0;z-index:50;display:flex;flex-direction:column;overflow-y:auto}
.main{flex:1;margin-left:220px;min-height:100vh;display:flex;flex-direction:column}
.topbar{height:52px;background:var(--bg1);border-bottom:1px solid var(--b0);display:flex;align-items:center;padding:0 24px;position:sticky;top:0;z-index:40;gap:12px}
.page{flex:1;padding:28px}
.logo{padding:18px;border-bottom:1px solid var(--b0)}
.logo-n{font-family:var(--font-d);font-size:1rem;font-weight:800;color:var(--teal)}
.logo-s{font-size:.62rem;color:var(--t3);margin-top:2px;text-transform:uppercase;letter-spacing:.1em}
.nav{padding:10px;flex:1}
.nl{font-size:.62rem;color:var(--t3);text-transform:uppercase;letter-spacing:.12em;padding:10px 8px 4px;font-weight:600}
.ni{display:flex;align-items:center;gap:9px;padding:7px 10px;border-radius:7px;color:var(--t2);font-size:.82rem;font-weight:500;transition:all .12s;width:100%;background:none;border:none;cursor:pointer;text-decoration:none}
.ni:hover{background:var(--bg3);color:var(--t0)}
.ni.active{background:rgba(20,184,166,.1);color:var(--teal);border:1px solid rgba(20,184,166,.2)}
.sfooter{padding:10px;border-top:1px solid var(--b0)}
.card{background:var(--bg2);border:1px solid var(--b1);border-radius:10px;padding:18px}
.ct{font-size:.72rem;font-weight:700;color:var(--t3);text-transform:uppercase;letter-spacing:.07em;margin-bottom:14px}
.grid4{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:16px}
@media(max-width:1100px){.grid4{grid-template-columns:repeat(2,1fr)}}
.ph{display:flex;align-items:center;justify-content:space-between;margin-bottom:20px;padding-bottom:14px;border-bottom:1px solid var(--b0);flex-wrap:wrap;gap:10px}
.pt{font-family:var(--font-d);font-size:1.4rem;font-weight:800;color:var(--t0)}
.ps{font-size:.78rem;color:var(--t3);margin-top:2px}
.kpi{background:var(--bg2);border:1px solid var(--b1);border-radius:10px;padding:16px;position:relative;overflow:hidden}
.kpi::after{content:'';position:absolute;bottom:0;left:0;right:0;height:2px;background:linear-gradient(90deg,var(--teal),transparent);opacity:.4}
.kl{font-size:.65rem;color:var(--t3);text-transform:uppercase;letter-spacing:.09em;font-weight:600;margin-bottom:6px}
.kv{font-family:var(--font-d);font-size:1.6rem;font-weight:800;color:var(--t0);line-height:1;margin-bottom:4px}
.ks{font-size:.7rem;color:var(--t3)}
.kv.g{color:var(--green)}.kv.r{color:var(--red)}.kv.a{color:var(--amber)}.kv.gold{color:var(--gold)}.kv.b{color:var(--blue)}.kv.t{color:var(--teal)}
.btn{display:inline-flex;align-items:center;gap:6px;padding:7px 14px;border-radius:7px;font-size:.78rem;font-weight:600;border:none;cursor:pointer;transition:all .12s;font-family:var(--font-b)}
.bp{background:var(--teal);color:#06080a}.bp:hover{filter:brightness(1.1)}
.bg-btn{background:var(--bg4);color:var(--t1);border:1px solid var(--b2)}.bg-btn:hover{background:var(--bg3)}
.bsm{padding:4px 9px;font-size:.72rem}
.badge{display:inline-flex;align-items:center;gap:4px;padding:3px 9px;border-radius:20px;font-size:.65rem;font-weight:600;text-transform:uppercase;letter-spacing:.04em}
.bg2{background:rgba(34,197,94,.08);color:var(--green);border:1px solid rgba(34,197,94,.18)}
.ba{background:rgba(245,158,11,.08);color:var(--amber);border:1px solid rgba(245,158,11,.18)}
.br{background:rgba(239,68,68,.08);color:var(--red);border:1px solid rgba(239,68,68,.18)}
.bgold{background:rgba(201,162,39,.08);color:var(--gold);border:1px solid rgba(201,162,39,.18)}
.bmu{background:var(--bg4);color:var(--t3);border:1px solid var(--b1)}
.bb{background:rgba(59,130,246,.08);color:var(--blue);border:1px solid rgba(59,130,246,.18)}
.bteal{background:rgba(20,184,166,.08);color:var(--teal);border:1px solid rgba(20,184,166,.18)}
.bpurple{background:rgba(168,85,247,.08);color:var(--purple);border:1px solid rgba(168,85,247,.18)}
.tbl{width:100%;border-collapse:collapse;font-size:.78rem}
.tbl th{background:var(--bg3);color:var(--t3);font-size:.64rem;font-weight:600;text-transform:uppercase;letter-spacing:.08em;padding:9px 12px;text-align:left;border-bottom:1px solid var(--b1)}
.tbl td{padding:9px 12px;border-bottom:1px solid var(--b0);color:var(--t1)}
.tbl tr:last-child td{border-bottom:none}
.tbl tr:hover td{background:rgba(255,255,255,.012)}
.tbl tr.click{cursor:pointer}
.mono{font-family:var(--font-m);font-size:.8rem}
.empty{text-align:center;padding:48px 20px;color:var(--t3)}
.loading-pg{display:flex;align-items:center;justify-content:center;height:100vh;font-family:var(--font-d);font-size:1.1rem;color:var(--t3)}
.spinner{width:16px;height:16px;border:2px solid var(--b2);border-top-color:var(--teal);border-radius:50%;animation:spin .6s linear infinite;flex-shrink:0}
.dr{display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid var(--b0);font-size:.78rem}
.dr:last-child{border-bottom:none}
.dk{color:var(--t3)}.dv{color:var(--t0);font-weight:500}
.search-bar{display:flex;gap:10px;margin-bottom:16px;align-items:center}
.search-input{flex:1;background:var(--bg2);border:1px solid var(--b1);border-radius:8px;color:var(--t0);padding:10px 14px;font-size:.875rem;outline:none;transition:border .12s}
.search-input:focus{border-color:var(--teal)}
.filters{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px}
.chip{padding:5px 12px;border-radius:20px;border:1px solid var(--b1);background:var(--bg3);color:var(--t2);font-size:.72rem;font-weight:600;cursor:pointer;transition:all .12s}
.chip.on{background:rgba(20,184,166,.1);border-color:rgba(20,184,166,.3);color:var(--teal)}
.drawer-overlay{position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:100;display:flex;justify-content:flex-end}
.drawer{width:520px;background:var(--bg1);border-left:1px solid var(--b1);height:100%;overflow-y:auto;padding:24px;display:flex;flex-direction:column;gap:16px}
.drawer-h{display:flex;justify-content:space-between;align-items:flex-start;padding-bottom:14px;border-bottom:1px solid var(--b0)}
input[type=text],input[type=email],input[type=password],select{background:var(--bg3);border:1px solid var(--b1);border-radius:7px;color:var(--t0);padding:8px 11px;font-size:.875rem;outline:none}
input:focus,select:focus{border-color:var(--teal)}
.pagination{display:flex;gap:8px;justify-content:center;margin-top:16px;align-items:center}
@keyframes spin{to{transform:rotate(360deg)}}
`

const fmt = (n: any) => n == null ? '—' : Number(n).toLocaleString()
const fmtCurrency = (n: any) => n == null ? '—' : '$' + Number(n).toLocaleString()
const fmtDate = (d: any) => d ? new Date(d).toLocaleDateString() : '—'
const fmtSqft = (n: any) => n == null ? '—' : Number(n).toLocaleString() + ' sqft'

function Layout() {
  const { user, logout } = useAuth()
  const navigate = useNavigate()
  const isAdmin = user?.role === 'admin' || user?.role === 'super_admin'
  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="logo">
          <div className="logo-n">🏘 GAM Intel</div>
          <div className="logo-s">Property Intelligence</div>
        </div>
        <nav className="nav">
          <div className="nl">Search</div>
          <NavLink to="/search"      className={({isActive})=>`ni${isActive?' active':''}`}>🔍 Parcel Search</NavLink>
          <NavLink to="/rv-parks"    className={({isActive})=>`ni${isActive?' active':''}`}>🚐 RV & Mobile Parks</NavLink>
          <NavLink to="/portfolios"  className={({isActive})=>`ni${isActive?' active':''}`}>📦 Portfolio Sales</NavLink>
          <div className="nl" style={{marginTop:8}}>Analysis</div>
          <NavLink to="/owners"      className={({isActive})=>`ni${isActive?' active':''}`}>👤 Owner Lookup</NavLink>
          <NavLink to="/multifamily" className={({isActive})=>`ni${isActive?' active':''}`}>🏢 Multifamily</NavLink>
          {isAdmin && <>
            <div className="nl" style={{marginTop:8}}>Admin</div>
            <NavLink to="/coverage" className={({isActive})=>`ni${isActive?' active':''}`}>🗺 County Coverage</NavLink>
          </>}
        </nav>
        <div className="sfooter">
          <div style={{padding:'6px 10px',marginBottom:4}}>
            <div style={{fontWeight:600,color:'var(--t0)',fontSize:'.78rem'}}>{user?.firstName} {user?.lastName}</div>
            <div style={{marginTop:3}}><span className="badge bteal" style={{fontSize:'.6rem'}}>{user?.role}</span></div>
          </div>
          {isAdmin && <a href="http://localhost:3003" className="ni" style={{color:'var(--t3)',fontSize:'.75rem'}}>← Admin Console</a>}
          <button className="ni" onClick={()=>{logout();navigate('/login')}} style={{color:'var(--red)'}}>🚪 Sign out</button>
        </div>
      </aside>
      <div className="main">
        <header className="topbar">
          <span style={{fontSize:'.72rem',color:'var(--t3)',fontFamily:'var(--font-m)'}}>GAM Property Intelligence · Arizona Statewide · 3.48M parcels</span>
          <div style={{marginLeft:'auto',display:'flex',gap:8}}>
            <span className="badge bteal">15 Counties ✓</span>
            <span className="badge bg2">3.48M Parcels</span>
          </div>
        </header>
        <div className="page"><Outlet/></div>
      </div>
    </div>
  )
}

function countyGisUrl(parcel: any): string {
  const apn = (parcel.apn || '').replace(/[A-Za-z]+$/, '');
  const county = (parcel.county || '').toLowerCase();
  const map: Record<string, string> = {
    maricopa: `https://maps.mcassessor.maricopa.gov/?esearch=${apn}&slayer=0&exprnum=0`,
    navajo: `https://apps.navajocountyaz.gov/navajowebpayments/propertyinformation?p=1&apn=${parcel.apn}`,
    mohave: `https://mcgis.mohave.gov/`,
    cochise: `https://gis-cochise.opendata.arcgis.com/app/37d793d478664634b4de3ad8042f248a`,
    pima: `https://www.asr.pima.gov/advanced-search`,
    yuma: `https://arcgis.yumacountyaz.gov/webgis/rest/services/YC_Parcels/MapServer`,
    yavapai: `https://gis.yavapaiaz.gov/v4/`,
    coconino: `https://datahub-coconinocounty.opendata.arcgis.com`,
  };
  return map[county] || `https://maps.mcassessor.maricopa.gov/?esearch=${apn}&slayer=0&exprnum=0`;
}

function ParcelDrawer({ apn, onClose }: { apn: string; onClose: () => void }) {
  const { data: parcel, isLoading } = useQuery(['parcel', apn], () => get<any>(`/api/properties/${apn}`))
  const { data: bizData } = useQuery(['biz', apn], () => get<any>(`/api/properties/${apn}/businesses`))
  return (
    <div className="drawer-overlay" onClick={e=>{ if(e.target===e.currentTarget) onClose() }}>
      <div className="drawer">
        <div className="drawer-h">
          <div>
            <div style={{fontFamily:'var(--font-d)',fontWeight:800,fontSize:'1.1rem',color:'var(--t0)',marginBottom:4}}>
              {isLoading ? 'Loading…' : parcel?.situs_address || apn}
            </div>
            <div style={{fontSize:'.72rem',color:'var(--t3)'}}>APN: {apn}</div>
          </div>
          <button onClick={onClose} style={{background:'none',border:'none',color:'var(--t3)',fontSize:'1.3rem',cursor:'pointer'}}>✕</button>
        </div>
        {isLoading
          ? <div style={{textAlign:'center',padding:32,color:'var(--t3)'}}><span className="spinner" style={{display:'inline-block'}}/></div>
          : parcel && <>
            <div className="card">
              <div className="ct">Property Details</div>
              <div className="dr"><span className="dk">Address</span><span className="dv" style={{textAlign:'right',maxWidth:260}}>{parcel.situs_address}, {parcel.situs_city} {parcel.situs_zip}</span></div>
              <div className="dr"><span className="dk">Property Type</span><span className="dv">{parcel.property_type_std||parcel.property_type_raw||'—'}</span></div>
              <div className="dr"><span className="dk">Year Built</span><span className="dv mono">{parcel.year_built||'—'}</span></div>
              <div className="dr"><span className="dk">Lot Size</span><span className="dv mono">{fmtSqft(parcel.lot_size_sqft)}</span></div>
              <div className="dr"><span className="dk">Units</span><span className="dv mono">{parcel.unit_count||'—'}</span></div>
            </div>
            <div className="card">
              <div className="ct">Valuation & Sale</div>
              <div className="dr"><span className="dk">Assessed Value</span><span className="dv mono" style={{color:'var(--teal)'}}>{fmtCurrency(parcel.assessed_value)}</span></div>
              <div className="dr"><span className="dk">Full Cash Value</span><span className="dv mono">{fmtCurrency(parcel.full_cash_value)}</span></div>
              <div className="dr"><span className="dk">Last Sale Price</span><span className="dv mono" style={{color:'var(--gold)'}}>{fmtCurrency(parcel.last_sale_price)}</span></div>
              <div className="dr"><span className="dk">Last Sale Date</span><span className="dv mono">{fmtDate(parcel.last_sale_date)}</span></div>
              {parcel.portfolio_sale_flag && <div className="dr"><span className="dk">Portfolio Sale</span><span className="badge bpurple">Portfolio</span></div>}
            </div>
            <div className="card">
              <div className="ct">Owner</div>
              <div className="dr"><span className="dk">Owner</span><span className="dv" style={{textAlign:'right',maxWidth:260}}>{parcel.owner_name_parsed||parcel.owner_name_raw||'—'}</span></div>
              <div className="dr"><span className="dk">Type</span><span className="dv"><span className={`badge ${parcel.owner_type==='corporate'?'bb':'bg2'}`}>{parcel.owner_type||'—'}</span></span></div>
              <div className="dr"><span className="dk">Mailing</span><span className="dv" style={{textAlign:'right',fontSize:'.72rem',maxWidth:260}}>{parcel.owner_mailing_address?`${parcel.owner_mailing_address}, ${parcel.owner_mailing_city} ${parcel.owner_mailing_state}`:'—'}</span></div>
              <div className="dr"><span className="dk">Portfolio Size</span>{parcel.parcel_count > 1 ? <Link to={`/owners?q=${encodeURIComponent(parcel.owner_name_parsed||parcel.owner_name_raw||'')}`} className="dv mono" style={{color:'var(--gold)',textDecoration:'underline',cursor:'pointer'}} onClick={()=>onClose()}>{fmt(parcel.parcel_count)} parcels →</Link> : <span className="dv mono">{parcel.parcel_count ? fmt(parcel.parcel_count)+' parcels' : '—'}</span>}</div>
            </div>
            {parcel.lat && parcel.lon && (
              <div className="card">
                <div className="ct">Location</div>
                <div className="dr"><span className="dk">Coordinates</span><span className="dv mono">{Number(parcel.lat).toFixed(6)}, {Number(parcel.lon).toFixed(6)}</span></div>
                <a href={countyGisUrl(parcel)} target="_blank" rel="noreferrer" className="btn bg-btn bsm" style={{marginTop:8}}>View Parcel on County GIS →</a>
              </div>
            )}
            {(bizData?.count > 0) && (
              <div className="card">
                <div className="ct">Businesses ({bizData.count})</div>
                {bizData.results.slice(0,5).map((b: any) => (
                  <div key={b.account_number} style={{padding:'8px 0',borderBottom:'1px solid var(--b0)'}}>
                    <div style={{fontWeight:600,color:'var(--t0)',fontSize:'.82rem'}}>{b.business_name}</div>
                    <div style={{fontSize:'.72rem',color:'var(--t2)',marginTop:2}}>Value: {fmtCurrency(b.full_cash_value)}</div>
                  </div>
                ))}
              </div>
            )}
          </>
        }
      </div>
    </div>
  )
}

function Pagination({ offset, total, limit, onPage }: { offset:number; total:number; limit:number; onPage:(o:number)=>void }) {
  if (total <= limit) return null
  return (
    <div className="pagination">
      <button className="btn bg-btn" disabled={offset===0} onClick={()=>onPage(Math.max(0,offset-limit))}>← Prev</button>
      <span style={{color:'var(--t3)',fontSize:'.78rem'}}>{offset+1}–{Math.min(offset+limit,total)} of {fmt(total)}</span>
      <button className="btn bg-btn" disabled={offset+limit>=total} onClick={()=>onPage(offset+limit)}>Next →</button>
    </div>
  )
}

function EmptyPrompt({ icon, title, body }: { icon:string; title:string; body:string }) {
  return (
    <div className="card" style={{textAlign:'center',padding:'60px 20px'}}>
      <div style={{fontSize:'3rem',marginBottom:16}}>{icon}</div>
      <h2 style={{color:'var(--t0)',marginBottom:8}}>{title}</h2>
      <p style={{color:'var(--t3)',fontSize:'.85rem',maxWidth:420,margin:'0 auto'}}>{body}</p>
    </div>
  )
}

function ParcelSearch() {
  const [q, setQ] = useState('')
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState('val_desc')
  const [ownerType, setOwnerType] = useState('')
  const [portfolio, setPortfolio] = useState(false)
  const [isRental, setIsRental] = useState(false)
  const [offset, setOffset] = useState(0)
  const [selectedApn, setSelectedApn] = useState<string|null>(null)
  const LIMIT = 50

  const { data, isLoading, isFetching } = useQuery(
    ['search', query, sort, ownerType, portfolio, isRental, offset],
    () => get<any>('/api/properties/search', { q:query||undefined, sort, owner_type:ownerType||undefined, portfolio:portfolio?'true':undefined, is_rental:isRental?'true':undefined, limit:LIMIT, offset }),
    { enabled: query.length > 0, keepPreviousData: true }
  )

  const results = data?.results || []
  const total = data?.total || 0
  const search = (e: React.FormEvent) => { e.preventDefault(); setOffset(0); setQuery(q) }

  return (
    <div>
      <div className="ph">
        <div><h1 className="pt">🔍 Parcel Search</h1><p className="ps">{query && total > 0 ? `${fmt(total)} results for "${query}"` : 'Search 3.48M Arizona parcels across 15 counties'}</p></div>
      </div>
      <form onSubmit={search} className="search-bar">
        <input className="search-input" value={q} onChange={e=>setQ(e.target.value)} placeholder="Address, owner name, APN, or city…" autoFocus/>
        <select value={sort} onChange={e=>setSort(e.target.value)} style={{width:'auto'}}>
          <option value="val_desc">Highest Value</option>
          <option value="val_asc">Lowest Value</option>
          <option value="units_desc">Most Units</option>
          <option value="sale_desc">Recent Sales</option>
          <option value="addr">Address A-Z</option>
        </select>
        <button type="submit" className="btn bp">{isFetching?<span className="spinner"/>:'🔍 Search'}</button>
      </form>
      <div className="filters">
        {[['All',''],['Corporate','corporate'],['Individual','individual'],['Trust','trust'],['Government','government']].map(([label,val])=>(
          <button key={val} className={`chip ${ownerType===val?'on':''}`} onClick={()=>{setOwnerType(val as string);setOffset(0)}}>{label}</button>
        ))}
        <button className={`chip ${portfolio?'on':''}`} onClick={()=>{setPortfolio(p=>!p);setOffset(0)}}>📦 Portfolio Only</button>
        <button className={`chip ${isRental?'on':''}`} onClick={()=>{setIsRental(r=>!r);setOffset(0)}}>🏠 Rentals Only</button>
      </div>
      {!query
        ? <EmptyPrompt icon="🔍" title="Search Parcels" body="Enter an address, owner name, APN, or city above to search 3.48 million Arizona parcels across all 15 counties."/>
        : <div className="card" style={{padding:0}}>
            {isLoading
              ? <div style={{padding:32,textAlign:'center',color:'var(--t3)'}}><span className="spinner" style={{display:'inline-block'}}/></div>
              : <table className="tbl">
                  <thead><tr><th>Address</th><th>Owner</th><th>Type</th><th>Units</th><th>Assessed</th><th>Last Sale</th><th>Sale Date</th><th>Flags</th></tr></thead>
                  <tbody>
                    {results.length ? results.map((r: any) => (
                      <tr key={r.apn} className="click" onClick={()=>setSelectedApn(r.apn)}>
                        <td><div style={{fontWeight:600,color:'var(--t0)',fontSize:'.78rem'}}>{r.situs_address}</div><div style={{fontSize:'.65rem',color:'var(--t3)'}}>{r.situs_city} · {r.apn}</div></td>
                        <td><div style={{fontSize:'.75rem',maxWidth:160,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{r.owner_name_parsed||r.owner_name_raw||'—'}</div><span className={`badge ${r.owner_type==='corporate'?'bb':'bg2'}`} style={{fontSize:'.58rem'}}>{r.owner_type||'—'}</span></td>
                        <td style={{fontSize:'.72rem',color:'var(--t2)'}}>{r.property_type_std||'—'}</td>
                        <td className="mono">{r.unit_count||'—'}</td>
                        <td className="mono" style={{color:'var(--teal)'}}>{fmtCurrency(r.assessed_value)}</td>
                        <td className="mono" style={{color:'var(--gold)'}}>{fmtCurrency(r.last_sale_price)}</td>
                        <td className="mono" style={{fontSize:'.7rem',color:'var(--t3)'}}>{fmtDate(r.last_sale_date)}</td>
                        <td>{r.portfolio_sale_flag&&<span className="badge bpurple" style={{fontSize:'.58rem'}}>Portfolio</span>}</td>
                      </tr>
                    )) : <tr><td colSpan={8}><div className="empty">No results found.</div></td></tr>}
                  </tbody>
                </table>
            }
          </div>
      }
      {query && <Pagination offset={offset} total={total} limit={LIMIT} onPage={setOffset}/>}
      {selectedApn && <ParcelDrawer apn={selectedApn} onClose={()=>setSelectedApn(null)}/>}
    </div>
  )
}

function RVParks() {
  const [q, setQ] = useState('')
  const [query, setQuery] = useState('')
  const [offset, setOffset] = useState(0)
  const [selectedApn, setSelectedApn] = useState<string|null>(null)
  const LIMIT = 50

  const { data, isLoading, isFetching } = useQuery(
    ['rv', query, offset],
    () => get<any>('/api/properties/mobile-homes/search', { q:query||undefined, limit:LIMIT, offset }),
    { enabled: query.length > 0, keepPreviousData: true }
  )

  const results = data?.results || []
  const total = data?.total || 0
  const search = (e: React.FormEvent) => { e.preventDefault(); setOffset(0); setQuery(q) }

  return (
    <div>
      <div className="ph">
        <div><h1 className="pt">🚐 RV & Mobile Home Parks</h1><p className="ps">{query && total > 0 ? `${fmt(total)} parks found` : 'Search Arizona RV and mobile home parks'}</p></div>
        <div style={{display:'flex',gap:8}}><span className="badge bteal">Business Registry</span><span className="badge bgold">Your Market</span></div>
      </div>
      <form onSubmit={search} className="search-bar">
        <input className="search-input" value={q} onChange={e=>setQ(e.target.value)} placeholder="Park name or address… (try 'rv park' or 'mobile home')"/>
        <button type="submit" className="btn bp">{isFetching?<span className="spinner"/>:'🔍 Search'}</button>
      </form>
      {!query
        ? <EmptyPrompt icon="🚐" title="Find RV & Mobile Home Parks" body="Search Arizona business registry for RV parks, mobile home parks, and manufactured housing communities. Try searching 'rv park', 'mobile home', or 'trailer'."/>
        : <div className="card" style={{padding:0}}>
            {isLoading
              ? <div style={{padding:32,textAlign:'center',color:'var(--t3)'}}><span className="spinner" style={{display:'inline-block'}}/></div>
              : <table className="tbl">
                  <thead><tr><th>Park Name</th><th>Address</th><th>Owner</th><th>Assessed</th><th>Lot Size</th><th>Last Sale</th><th>Owner Mail</th></tr></thead>
                  <tbody>
                    {results.length ? results.map((r: any, i: number) => (
                      <tr key={i} className="click" onClick={()=>r.apn&&setSelectedApn(r.apn)}>
                        <td><div style={{fontWeight:600,color:'var(--teal)',fontSize:'.82rem'}}>{r.business_name}</div>{r.dba_name&&<div style={{fontSize:'.65rem',color:'var(--t3)'}}>DBA: {r.dba_name}</div>}</td>
                        <td style={{fontSize:'.75rem'}}>{r.situs_address}<div style={{fontSize:'.65rem',color:'var(--t3)'}}>{r.situs_zip}</div></td>
                        <td style={{fontSize:'.75rem',maxWidth:140}}><div style={{overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{r.owner_name_parsed||'—'}</div>{r.owner_type&&<span className={`badge ${r.owner_type==='corporate'?'bb':'bg2'}`} style={{fontSize:'.58rem'}}>{r.owner_type}</span>}</td>
                        <td className="mono" style={{color:'var(--teal)'}}>{fmtCurrency(r.full_cash_value||r.parcel_fcv)}</td>
                        <td className="mono">{fmtSqft(r.lot_size_sqft)}</td>
                        <td><div className="mono" style={{fontSize:'.72rem',color:'var(--gold)'}}>{fmtCurrency(r.last_sale_price)}</div><div style={{fontSize:'.65rem',color:'var(--t3)'}}>{fmtDate(r.last_sale_date)}</div></td>
                        <td style={{fontSize:'.7rem',color:'var(--t3)'}}>{r.owner_mailing_address?`${r.owner_mailing_address}, ${r.owner_mailing_city} ${r.owner_mailing_state}`:'—'}</td>
                      </tr>
                    )) : <tr><td colSpan={7}><div className="empty">No parks found.</div></td></tr>}
                  </tbody>
                </table>
            }
          </div>
      }
      {query && <Pagination offset={offset} total={total} limit={LIMIT} onPage={setOffset}/>}
      {selectedApn && <ParcelDrawer apn={selectedApn} onClose={()=>setSelectedApn(null)}/>}
    </div>
  )
}

function PortfolioSales() {
  const [loaded, setLoaded] = useState(false)
  const [offset, setOffset] = useState(0)
  const [selectedApn, setSelectedApn] = useState<string|null>(null)
  const LIMIT = 50

  const { data, isLoading } = useQuery(
    ['portfolio', offset],
    () => get<any>('/api/properties/search', { portfolio:'true', sort:'sale_desc', limit:LIMIT, offset }),
    { enabled: loaded, keepPreviousData: true }
  )

  const results = data?.results || []
  const total = data?.total || 0

  return (
    <div>
      <div className="ph">
        <div><h1 className="pt">📦 Portfolio Sales</h1><p className="ps">{loaded && total > 0 ? `${fmt(total)} multi-parcel transactions detected` : 'Institutional acquisitions and large portfolio transfers'}</p></div>
        <span className="badge bpurple">Multi-signal Detection</span>
      </div>
      <div className="card" style={{marginBottom:16,padding:'14px 16px',display:'flex',justifyContent:'space-between',alignItems:'center',gap:16}}>
        <div style={{fontSize:'.78rem',color:'var(--t2)',lineHeight:1.7,flex:1}}>
          Portfolio sales are flagged using multi-signal detection: same-day sales, same grantor/grantee, same deed book, or matching sale prices across multiple parcels.
        </div>
        {!loaded && <button className="btn bp" onClick={()=>setLoaded(true)} style={{flexShrink:0}}>Load Data</button>}
      </div>
      {!loaded
        ? <EmptyPrompt icon="📦" title="Portfolio Sale Detection" body="Click Load Data to search for multi-parcel institutional transactions across Arizona."/>
        : <div className="card" style={{padding:0}}>
            {isLoading
              ? <div style={{padding:32,textAlign:'center',color:'var(--t3)'}}><span className="spinner" style={{display:'inline-block'}}/></div>
              : <table className="tbl">
                  <thead><tr><th>Address</th><th>Owner</th><th>Type</th><th>Sale Price</th><th>Sale Date</th><th>Assessed</th><th>Portfolio ID</th></tr></thead>
                  <tbody>
                    {results.length ? results.map((r: any) => (
                      <tr key={r.apn} className="click" onClick={()=>setSelectedApn(r.apn)}>
                        <td><div style={{fontWeight:600,color:'var(--t0)',fontSize:'.78rem'}}>{r.situs_address}</div><div style={{fontSize:'.65rem',color:'var(--t3)'}}>{r.situs_city} · {r.apn}</div></td>
                        <td style={{fontSize:'.75rem',maxWidth:160,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{r.owner_name_parsed||r.owner_name_raw||'—'}</td>
                        <td style={{fontSize:'.72rem',color:'var(--t2)'}}>{r.property_type_std||'—'}</td>
                        <td className="mono" style={{color:'var(--gold)',fontWeight:600}}>{fmtCurrency(r.last_sale_price)}</td>
                        <td className="mono" style={{fontSize:'.72rem'}}>{fmtDate(r.last_sale_date)}</td>
                        <td className="mono" style={{color:'var(--teal)'}}>{fmtCurrency(r.assessed_value)}</td>
                        <td><span className="badge bpurple" style={{fontSize:'.6rem',fontFamily:'var(--font-m)'}}>{r.portfolio_sale_id?.slice(0,8)||'—'}</span></td>
                      </tr>
                    )) : <tr><td colSpan={7}><div className="empty">No portfolio sales found.</div></td></tr>}
                  </tbody>
                </table>
            }
          </div>
      }
      {loaded && <Pagination offset={offset} total={total} limit={LIMIT} onPage={setOffset}/>}
      {selectedApn && <ParcelDrawer apn={selectedApn} onClose={()=>setSelectedApn(null)}/>}
    </div>
  )
}

function Multifamily() {
  const [loaded, setLoaded] = useState(false)
  const [minUnits, setMinUnits] = useState('4')
  const [offset, setOffset] = useState(0)
  const [selectedApn, setSelectedApn] = useState<string|null>(null)
  const LIMIT = 50

  const { data, isLoading } = useQuery(
    ['mfr', minUnits, offset],
    () => get<any>('/api/properties/search', { min_units:minUnits, sort:'units_desc', limit:LIMIT, offset }),
    { enabled: loaded, keepPreviousData: true }
  )

  const results = data?.results || []
  const total = data?.total || 0

  return (
    <div>
      <div className="ph">
        <div><h1 className="pt">🏢 Multifamily</h1><p className="ps">{loaded && total > 0 ? `${fmt(total)} properties with ${minUnits}+ units` : 'Find apartment buildings and multi-unit properties'}</p></div>
        <div style={{display:'flex',gap:6,alignItems:'center'}}>
          <span style={{color:'var(--t3)',fontSize:'.78rem'}}>Min units:</span>
          {['2','4','10','20','50','100'].map(n=>(
            <button key={n} className={`chip ${minUnits===n?'on':''}`} onClick={()=>{setMinUnits(n);setOffset(0);setLoaded(true)}}>{n}+</button>
          ))}
        </div>
      </div>
      {!loaded
        ? <EmptyPrompt icon="🏢" title="Multifamily Property Search" body="Select a minimum unit count above or click a filter to search for multifamily properties across Arizona."/>
        : <div className="card" style={{padding:0}}>
            {isLoading
              ? <div style={{padding:32,textAlign:'center',color:'var(--t3)'}}><span className="spinner" style={{display:'inline-block'}}/></div>
              : <table className="tbl">
                  <thead><tr><th>Address</th><th>Owner</th><th>Units</th><th>Type</th><th>Assessed</th><th>Last Sale</th><th>Year Built</th></tr></thead>
                  <tbody>
                    {results.length ? results.map((r: any) => (
                      <tr key={r.apn} className="click" onClick={()=>setSelectedApn(r.apn)}>
                        <td><div style={{fontWeight:600,color:'var(--t0)',fontSize:'.78rem'}}>{r.situs_address}</div><div style={{fontSize:'.65rem',color:'var(--t3)'}}>{r.situs_city} · {r.apn}</div></td>
                        <td style={{fontSize:'.75rem',maxWidth:140,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{r.owner_name_parsed||r.owner_name_raw||'—'}</td>
                        <td><span className="badge bteal" style={{fontFamily:'var(--font-m)'}}>{fmt(r.unit_count)}</span></td>
                        <td style={{fontSize:'.72rem',color:'var(--t2)'}}>{r.property_type_std||'—'}</td>
                        <td className="mono" style={{color:'var(--teal)'}}>{fmtCurrency(r.assessed_value)}</td>
                        <td className="mono" style={{color:'var(--gold)'}}>{fmtCurrency(r.last_sale_price)}</td>
                        <td className="mono" style={{color:'var(--t3)'}}>{r.year_built||'—'}</td>
                      </tr>
                    )) : <tr><td colSpan={7}><div className="empty">No results.</div></td></tr>}
                  </tbody>
                </table>
            }
          </div>
      }
      {loaded && <Pagination offset={offset} total={total} limit={LIMIT} onPage={setOffset}/>}
      {selectedApn && <ParcelDrawer apn={selectedApn} onClose={()=>setSelectedApn(null)}/>}
    </div>
  )
}

function OwnerLookup() {
  const [searchParams] = useSearchParams()
  const initQ = searchParams.get('q') || ''
  const [q, setQ] = useState(initQ)
  const [query, setQuery] = useState(initQ)
  const [selectedApn, setSelectedApn] = useState<string|null>(null)

  const { data, isLoading } = useQuery(
    ['owner', query],
    () => get<any>('/api/properties/search', { q:query, sort:'val_desc', limit:100 }),
    { enabled: !!query }
  )

  const results = data?.results || []
  const total = data?.total || 0
  const search = (e: React.FormEvent) => { e.preventDefault(); setQuery(q) }

  return (
    <div>
      <div className="ph">
        <div><h1 className="pt">👤 Owner Lookup</h1><p className="ps">Search by owner name to see full portfolio</p></div>
      </div>
      <form onSubmit={search} className="search-bar">
        <input className="search-input" value={q} onChange={e=>setQ(e.target.value)} placeholder="Owner or company name…" autoFocus/>
        <button type="submit" className="btn bp">{isLoading?<span className="spinner"/>:'🔍 Search'}</button>
      </form>
      {!query
        ? <EmptyPrompt icon="👤" title="Owner Portfolio Search" body="Search any owner or company name to see all parcels they own across Arizona. Useful for identifying large landlords, corporate owners, and acquisition targets."/>
        : <>
            {results.length > 0 && (
              <div className="grid4" style={{marginBottom:16}}>
                <div className="kpi"><div className="kl">Parcels Found</div><div className="kv t">{fmt(total)}</div></div>
                <div className="kpi"><div className="kl">Total Assessed</div><div className="kv gold">{fmtCurrency(results.reduce((s:number,r:any)=>s+(+r.assessed_value||0),0))}</div></div>
                <div className="kpi"><div className="kl">Total Sale Value</div><div className="kv g">{fmtCurrency(results.reduce((s:number,r:any)=>s+(+r.last_sale_price||0),0))}</div></div>
                <div className="kpi"><div className="kl">Total Units</div><div className="kv b">{fmt(results.reduce((s:number,r:any)=>s+(+r.unit_count||0),0))}</div></div>
              </div>
            )}
            <div className="card" style={{padding:0}}>
              {isLoading
                ? <div style={{padding:32,textAlign:'center',color:'var(--t3)'}}><span className="spinner" style={{display:'inline-block'}}/></div>
                : <table className="tbl">
                    <thead><tr><th>Address</th><th>Owner</th><th>Type</th><th>Units</th><th>Assessed</th><th>Last Sale</th></tr></thead>
                    <tbody>
                      {results.length ? results.map((r:any)=>(
                        <tr key={r.apn} className="click" onClick={()=>setSelectedApn(r.apn)}>
                          <td><div style={{fontWeight:600,color:'var(--t0)',fontSize:'.78rem'}}>{r.situs_address}</div><div style={{fontSize:'.65rem',color:'var(--t3)'}}>{r.situs_city} · {r.apn}</div></td>
                          <td style={{fontSize:'.72rem',maxWidth:160,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{r.owner_name_parsed||r.owner_name_raw||'—'}</td>
                          <td style={{fontSize:'.72rem',color:'var(--t2)'}}>{r.property_type_std||'—'}</td>
                          <td className="mono">{r.unit_count||'—'}</td>
                          <td className="mono" style={{color:'var(--teal)'}}>{fmtCurrency(r.assessed_value)}</td>
                          <td className="mono" style={{color:'var(--gold)'}}>{fmtCurrency(r.last_sale_price)}</td>
                        </tr>
                      )) : <tr><td colSpan={6}><div className="empty">No results for "{query}"</div></td></tr>}
                    </tbody>
                  </table>
              }
            </div>
          </>
      }
      {selectedApn && <ParcelDrawer apn={selectedApn} onClose={()=>setSelectedApn(null)}/>}
    </div>
  )
}

function CountyCoverage() {
  const counties = [
    {name:'Maricopa',status:'live',parcels:'1,750,000+',loaded:'Apr 2026'},
    {name:'Pima',status:'live',parcels:'446,703',loaded:'Apr 2026'},
    {name:'Pinal',status:'planned',parcels:'~180,000',loaded:'—'},
    {name:'Yavapai',status:'live',parcels:'187,416',loaded:'Apr 2026'},
    {name:'Coconino',status:'live',parcels:'69,889',loaded:'Apr 2026'},
    {name:'Mohave',status:'live',parcels:'266,713',loaded:'Apr 2026'},
    {name:'Navajo',status:'live',parcels:'104,606',loaded:'Apr 2026'},
    {name:'Apache',status:'live',parcels:'58,067',loaded:'Apr 2026'},
    {name:'Graham',status:'live',parcels:'18,821',loaded:'Apr 2026'},
    {name:'Greenlee',status:'live',parcels:'4,706',loaded:'Apr 2026'},
    {name:'La Paz',status:'live',parcels:'16,151',loaded:'Apr 2026'},
    {name:'Santa Cruz',status:'live',parcels:'15,681',loaded:'Apr 2026'},
    {name:'Gila',status:'live',parcels:'39,472',loaded:'Apr 2026'},
    {name:'Cochise',status:'live',parcels:'122,990',loaded:'Apr 2026'},
    {name:'Yuma',status:'live',parcels:'96,810',loaded:'Apr 2026'},
  ]
  const STATUS: Record<string,string> = {live:'bg2',next:'ba',planned:'bmu'}
  return (
    <div>
      <div className="ph">
        <div><h1 className="pt">🗺 County Coverage</h1><p className="ps">Arizona statewide rollout — 15 counties</p></div>
        <span className="badge bteal">1 of 15 Live</span>
      </div>
      <div className="grid4" style={{marginBottom:16}}>
        <div className="kpi"><div className="kl">Live</div><div className="kv g">1</div><div className="ks">Maricopa</div></div>
        <div className="kpi"><div className="kl">Live Counties</div><div className="kv g">15</div><div className="ks">All AZ counties</div></div>
        <div className="kpi"><div className="kl">Parcels Loaded</div><div className="kv t">3.48M</div><div className="ks">Statewide</div></div>
        <div className="kpi"><div className="kl">Next State</div><div className="kv a">NV</div><div className="ks">Coming soon</div></div>
        <div className="kpi"><div className="kl">Coverage</div><div className="kv">100%</div><div className="ks">Arizona complete</div></div>
      <div className="card" style={{padding:0}}>
        <table className="tbl">
          <thead><tr><th>County</th><th>Status</th><th>Est. Parcels</th><th>Date Loaded</th></tr></thead>
          <tbody>
            {counties.map(c=>(
              <tr key={c.name} style={{background:c.status==='live'?'rgba(34,197,94,.02)':c.status==='next'?'rgba(245,158,11,.02)':''}}>
                <td style={{fontWeight:600,color:c.status==='live'?'var(--green)':c.status==='next'?'var(--amber)':'var(--t2)'}}>{c.name} County</td>
                <td><span className={`badge ${STATUS[c.status]}`}>{c.status==='live'?'✓ Live':c.status==='next'?'Next Up':'Planned'}</span></td>
                <td className="mono" style={{color:'var(--t2)'}}>{c.parcels}</td>
                <td style={{fontSize:'.75rem',color:'var(--t3)'}}>{c.loaded}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function LoginPage() {
  React.useEffect(()=>{ TOKEN_KEYS.forEach(k=>localStorage.removeItem(k)); delete api.defaults.headers.common['Authorization'] },[])
  const { login } = useAuth()
  const navigate = useNavigate()
  const [email, setEmail] = useState('')
  const [pw, setPw] = useState('')
  const [err, setErr] = useState('')
  const [loading, setLoading] = useState(false)

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault(); setLoading(true); setErr('')
    try { await login(email, pw); navigate('/search') }
    catch (ex: any) { setErr(ex.response?.data?.error||ex.message||'Login failed') }
    finally { setLoading(false) }
  }

  return (
    <div style={{minHeight:'100vh',display:'flex',alignItems:'center',justifyContent:'center',background:'var(--bg0)',padding:20}}>
      <div style={{width:'100%',maxWidth:400}}>
        <div style={{textAlign:'center',marginBottom:40}}>
          <div style={{fontFamily:'var(--font-d)',fontSize:'2rem',fontWeight:800,color:'var(--teal)',marginBottom:8}}>🏘 GAM Intel</div>
          <div style={{color:'var(--t3)',fontSize:'.82rem'}}>Property Intelligence · Arizona Statewide · 3.48M Parcels</div>
        </div>
        <div className="card" style={{padding:24}}>
          {err&&<div style={{background:'rgba(239,68,68,.08)',border:'1px solid rgba(239,68,68,.18)',color:'#fca5a5',padding:'10px 14px',borderRadius:8,fontSize:'.78rem',marginBottom:14}}>{err}</div>}
          <div style={{background:'rgba(20,184,166,.08)',border:'1px solid rgba(20,184,166,.18)',color:'var(--teal)',padding:'10px 14px',borderRadius:8,fontSize:'.75rem',marginBottom:20}}>
            Sign in with your GAM Admin or Landlord credentials.
          </div>
          <form onSubmit={onSubmit}>
            <div style={{marginBottom:14}}>
              <label style={{display:'block',fontSize:'.72rem',fontWeight:600,color:'var(--t3)',marginBottom:5,textTransform:'uppercase',letterSpacing:'.06em'}}>Email</label>
              <input type="email" value={email} onChange={e=>setEmail(e.target.value)} autoFocus required style={{width:'100%'}}/>
            </div>
            <div style={{marginBottom:16}}>
              <label style={{display:'block',fontSize:'.72rem',fontWeight:600,color:'var(--t3)',marginBottom:5,textTransform:'uppercase',letterSpacing:'.06em'}}>Password</label>
              <input type="password" value={pw} onChange={e=>setPw(e.target.value)} required style={{width:'100%'}}/>
            </div>
            <button className="btn bp" type="submit" disabled={loading} style={{width:'100%',justifyContent:'center',padding:'10px 14px'}}>
              {loading?<span className="spinner"/>:'Sign in to GAM Intel'}
            </button>
          </form>
        </div>
        <div style={{textAlign:'center',marginTop:20}}>
          <a href="http://localhost:3003" style={{color:'var(--t3)',fontSize:'.75rem'}}>← Back to Admin Console</a>
        </div>
      </div>
    </div>
  )
}

function App() {
  const { user, loading } = useAuth()
  if (loading) return <div className="loading-pg"><span className="spinner" style={{marginRight:10}}/>Loading GAM Intel…</div>
  const authed = !!user && ALLOWED.includes(user.role)
  return (
    <Routes>
      <Route path="/login" element={authed?<Navigate to="/search" replace/>:<LoginPage/>}/>
      <Route path="/" element={authed?<Layout/>:<Navigate to="/login" replace/>}>
        <Route index element={<Navigate to="/search" replace/>}/>
        <Route path="search"      element={<ParcelSearch/>}/>
        <Route path="rv-parks"    element={<RVParks/>}/>
        <Route path="portfolios"  element={<PortfolioSales/>}/>
        <Route path="owners"      element={<OwnerLookup/>}/>
        <Route path="multifamily" element={<Multifamily/>}/>
        <Route path="coverage"    element={<CountyCoverage/>}/>
      </Route>
      <Route path="*" element={<Navigate to={authed?'/search':'/login'} replace/>}/>
    </Routes>
  )
}

function Root() {
  return (
    <QueryClientProvider client={qc}>
      <AuthProvider>
        <style dangerouslySetInnerHTML={{__html:css}}/>
        <BrowserRouter><App/></BrowserRouter>
      </AuthProvider>
    </QueryClientProvider>
  )
}

ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><Root/></React.StrictMode>)
