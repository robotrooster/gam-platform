import React, { createContext, useContext, useState } from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter, Routes, Route, Navigate, NavLink, Outlet, useNavigate } from 'react-router-dom'
import { QueryClient, QueryClientProvider, useQuery, useMutation, useQueryClient } from 'react-query'
import axios from 'axios'
import { formatCurrency } from '@gam/shared'

const API = (import.meta as any).env?.VITE_API_URL || 'http://localhost:4000'
const api = axios.create({ baseURL: `${API}/api` })
const TOKEN_KEYS = ['gam_admin_token', 'gam_books_token']
const getToken = () => TOKEN_KEYS.map(k => localStorage.getItem(k)).find(Boolean) || null
api.interceptors.request.use(c => { const t=getToken(); if(t) c.headers.Authorization=`Bearer ${t}`; return c })
api.interceptors.response.use(r=>r, e=>{ if(e.response?.status===401&&!e.config.url.includes('/auth/')){ TOKEN_KEYS.forEach(k=>localStorage.removeItem(k)); window.location.href='/login' } return Promise.reject(e) })
// Inject active client header for bookkeepers
api.interceptors.request.use(c=>{ const cid=localStorage.getItem('gam_books_client'); if(cid) c.headers['X-Client-Id']=cid; return c })
const get=<T,>(url:string)=>api.get<{success:boolean;data:T}>(url).then(r=>r.data.data)
const post=<T,>(url:string,body?:any)=>api.post<{success:boolean;data:T;message?:string}>(url,body).then(r=>r.data)
const patch=<T,>(url:string,body?:any)=>api.patch<{success:boolean;data:T}>(url,body).then(r=>r.data)
const del=(url:string)=>api.delete(url).then(r=>r.data)

const ALLOWED_ROLES=['admin','super_admin','landlord','bookkeeper']
interface AuthUser{id:string;email:string;role:string;firstName:string;lastName:string;landlordId?:string;activeClientId?:string;activeClientName?:string}
interface AuthCtx{user:AuthUser|null;loading:boolean;activeClientId:string|null;activeClientName:string|null;setActiveClient:(id:string,name:string)=>void;login:(e:string,p:string)=>Promise<void>;logout:()=>void}
const Ctx=createContext<AuthCtx>(null!)
const useAuth=()=>useContext(Ctx)

function AuthProvider({children}:{children:React.ReactNode}){
  const[user,setUser]=useState<AuthUser|null>(null)
  const[loading,setLoading]=useState(true)
  const[activeClientId,setActiveClientId]=useState<string|null>(()=>localStorage.getItem('gam_books_client'))
  const logout=React.useCallback(()=>{ TOKEN_KEYS.forEach(k=>localStorage.removeItem(k)); delete api.defaults.headers.common['Authorization']; setUser(null) },[])
  React.useEffect(()=>{
    const params=new URLSearchParams(window.location.search)
    const urlToken=params.get('token')
    if(urlToken){ localStorage.setItem('gam_books_token',urlToken); window.history.replaceState({},'',window.location.pathname) }
    const t=getToken()
    if(!t){setLoading(false);return}
    api.defaults.headers.common['Authorization']='Bearer '+t
    api.get('/auth/me').then(res=>{
      const u=res.data.data
      if(!u||!ALLOWED_ROLES.includes(u.role)){logout();return}
      setUser({id:u.id,email:u.email,role:u.role,firstName:u.firstName||u.firstName||'',lastName:u.lastName||u.lastName||'',landlordId:u.landlordId||u.landlordId})
    }).catch(logout).finally(()=>setLoading(false))
  },[logout])
  const login=async(email:string,password:string)=>{
    const res=await axios.post(`${API}/api/auth/login`,{email,password})
    const{token:tk,user:u}=res.data.data
    if(!u||!ALLOWED_ROLES.includes(u.role))throw new Error('GAM Books requires Admin or Landlord access')
    localStorage.setItem('gam_books_token',tk)
    api.defaults.headers.common['Authorization']='Bearer '+tk
    setUser({id:u.id,email:u.email,role:u.role,firstName:u.firstName||u.firstName||'',lastName:u.lastName||u.lastName||'',landlordId:u.landlordId||u.landlordId})
  }
  const setActiveClient=(id:string,name:string)=>{
    localStorage.setItem('gam_books_client',id)
    localStorage.setItem('gam_books_client_name',name)
    setActiveClientId(id)
    setUser(u=>u?{...u,activeClientId:id,activeClientName:name}:u)
  }
  const activeClientName=localStorage.getItem('gam_books_client_name')
  return<Ctx.Provider value={{user,loading,activeClientId,activeClientName,setActiveClient,login,logout}}>{children}</Ctx.Provider>
}

const qc=new QueryClient({defaultOptions:{queries:{retry:1,staleTime:15000}}})

// ── STYLES ────────────────────────────────────────────────────────────
const css=`
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
h1,h2,h3{font-family:var(--font-d);color:var(--t0);line-height:1.2}
button{cursor:pointer;font-family:var(--font-b)}input,select,textarea{font-family:var(--font-b)}
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
@media(max-width:1100px){.grid4{grid-template-columns:repeat(2,1fr)}}
@media(max-width:800px){.grid2,.grid3,.grid4{grid-template-columns:1fr}}
.ph{display:flex;align-items:center;justify-content:space-between;margin-bottom:20px;padding-bottom:14px;border-bottom:1px solid var(--b0);flex-wrap:wrap;gap:10px}
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
.bt{background:rgba(20,184,166,.08);color:var(--teal);border:1px solid rgba(20,184,166,.2)}
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
.loading-pg{display:flex;align-items:center;justify-content:center;height:100vh;font-family:var(--font-d);font-size:1.1rem;color:var(--t3)}
.spinner{width:16px;height:16px;border:2px solid var(--b2);border-top-color:var(--gold);border-radius:50%;animation:spin .6s linear infinite;flex-shrink:0}
.dr{display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid var(--b0);font-size:.78rem}
.dr:last-child{border-bottom:none}
.dk{color:var(--t3)}.dv{color:var(--t0);font-weight:500}
.tabs{display:flex;gap:2px;border-bottom:1px solid var(--b0);margin-bottom:20px}
.tab{padding:9px 14px;background:none;border:none;color:var(--t3);font-size:.78rem;font-weight:600;cursor:pointer;border-bottom:2px solid transparent;margin-bottom:-1px;transition:all .12s;font-family:var(--font-b)}
.tab:hover{color:var(--t1)}.tab.on{color:var(--gold);border-bottom-color:var(--gold)}
/* Modal */
.overlay{position:fixed;inset:0;background:rgba(0,0,0,.7);z-index:200;display:flex;align-items:center;justify-content:center;padding:20px}
.modal{background:var(--bg2);border:1px solid var(--b1);border-radius:12px;padding:24px;width:100%;max-width:520px;max-height:90vh;overflow-y:auto}
.modal-h{display:flex;justify-content:space-between;align-items:center;margin-bottom:20px;padding-bottom:14px;border-bottom:1px solid var(--b0)}
.modal-t{font-family:var(--font-d);font-size:1.1rem;font-weight:700;color:var(--t0)}
.frow{margin-bottom:14px}
.frow2{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:14px}
label{display:block;font-size:.72rem;font-weight:600;color:var(--t3);margin-bottom:5px;text-transform:uppercase;letter-spacing:.06em}
input[type=text],input[type=email],input[type=number],input[type=date],input[type=password],select,textarea{width:100%;background:var(--bg3);border:1px solid var(--b1);border-radius:7px;color:var(--t0);padding:8px 11px;font-size:.875rem;outline:none;transition:border .12s}
input:focus,select:focus,textarea:focus{border-color:var(--gold)}
.factions{display:flex;gap:8px;justify-content:flex-end;margin-top:20px;padding-top:14px;border-top:1px solid var(--b0)}
@keyframes spin{to{transform:rotate(360deg)}}
`

// ── MODAL ─────────────────────────────────────────────────────────────
function Modal({title,onClose,children}:{title:string;onClose:()=>void;children:React.ReactNode}){
  return(
    <div className="overlay" onClick={e=>{if(e.target===e.currentTarget)onClose()}}>
      <div className="modal">
        <div className="modal-h">
          <span className="modal-t">{title}</span>
          <button onClick={onClose} style={{background:'none',border:'none',color:'var(--t3)',fontSize:'1.2rem',cursor:'pointer'}}>✕</button>
        </div>
        {children}
      </div>
    </div>
  )
}

// ── LAYOUT ─────────────────────────────────────────────────────────────
function Layout(){
  const{user,logout}=useAuth()
  const navigate=useNavigate()
  const isAdmin=user?.role==='admin'||user?.role==='super_admin'
  return(
    <div className="shell">
      <aside className="sidebar">
        <div className="logo">
          <div className="logo-n">📒 GAM Books</div>
          <div className="logo-s">Payroll & Bookkeeping</div>
        </div>
        <nav className="nav">
          <div className="nl">Overview</div>
          <NavLink to="/dashboard" className={({isActive})=>`ni${isActive?' active':''}`}>📊 Dashboard</NavLink>
          {(user?.role==='bookkeeper'||isAdmin)&&<NavLink to="/clients" className={({isActive})=>`ni${isActive?' active':''}`}>🏢 My Clients</NavLink>}
          <div className="nl" style={{marginTop:8}}>Payroll</div>
          <NavLink to="/payroll/employees"   className={({isActive})=>`ni${isActive?' active':''}`}>👥 Employees (W-2)</NavLink>
          <NavLink to="/payroll/contractors" className={({isActive})=>`ni${isActive?' active':''}`}>🔧 Contractors (1099)</NavLink>
          <NavLink to="/payroll/vendors"     className={({isActive})=>`ni${isActive?' active':''}`}>🏪 Vendors</NavLink>
          <NavLink to="/payroll/runs"        className={({isActive})=>`ni${isActive?' active':''}`}>▶ Run Payroll</NavLink>
          <NavLink to="/payroll/history"     className={({isActive})=>`ni${isActive?' active':''}`}>🕐 Pay History</NavLink>
          <NavLink to="/payroll/tax-forms"   className={({isActive})=>`ni${isActive?' active':''}`}>📋 Tax Forms</NavLink>
          <div className="nl" style={{marginTop:8}}>Bookkeeping</div>
          <NavLink to="/books/accounts"     className={({isActive})=>`ni${isActive?' active':''}`}>📂 Chart of Accounts</NavLink>
          <NavLink to="/books/journal"      className={({isActive})=>`ni${isActive?' active':''}`}>📓 Journal Entries</NavLink>
          <NavLink to="/books/transactions" className={({isActive})=>`ni${isActive?' active':''}`}>💳 Transactions</NavLink>
          <NavLink to="/books/reconcile"    className={({isActive})=>`ni${isActive?' active':''}`}>🏦 Bank Reconciliation</NavLink>
          <div className="nl" style={{marginTop:8}}>Property Finance</div>
          <NavLink to="/rent-roll"     className={({isActive})=>`ni${isActive?' active':''}`}>🏘 Rent Roll</NavLink>
          <NavLink to="/disbursements" className={({isActive})=>`ni${isActive?' active':''}`}>💸 Owner Disbursements</NavLink>
          <NavLink to="/bills"         className={({isActive})=>`ni${isActive?' active':''}`}>📄 Bills & AP</NavLink>
          <div className="nl" style={{marginTop:8}}>Reports</div>
          <NavLink to="/reports/pl"               className={({isActive})=>`ni${isActive?' active':''}`}>📈 P&amp;L</NavLink>
          <NavLink to="/reports/balance-sheet"    className={({isActive})=>`ni${isActive?' active':''}`}>⚖ Balance Sheet</NavLink>
          <NavLink to="/reports/cash-flow"        className={({isActive})=>`ni${isActive?' active':''}`}>💧 Cash Flow</NavLink>
          <NavLink to="/reports/owner-statements" className={({isActive})=>`ni${isActive?' active':''}`}>🏠 Owner Statements</NavLink>
          <div className="nl" style={{marginTop:8}}>Tax</div>
          <NavLink to="/tax" className={({isActive})=>`ni${isActive?' active':''}`}>🏛 Tax Center</NavLink>
          {isAdmin&&<><div className="nl" style={{marginTop:8}}>Admin</div>
          <NavLink to="/admin/companies" className={({isActive})=>`ni${isActive?' active':''}`}>🏢 All Companies</NavLink>
          <NavLink to="/admin/audit"     className={({isActive})=>`ni${isActive?' active':''}`}>🔍 Audit Log</NavLink></>}
        </nav>
        <div className="sfooter">
          <div style={{padding:'6px 10px',marginBottom:4}}>
            <div style={{fontWeight:600,color:'var(--t0)',fontSize:'.78rem'}}>{user?.firstName} {user?.lastName}</div>
            <div style={{marginTop:3}}><span className={`badge ${isAdmin?'br':'bgold'}`} style={{fontSize:'.6rem'}}>{isAdmin?'Admin':'Landlord'}</span></div>
          </div>
          {isAdmin&&<a href="http://localhost:3003" className="ni" style={{color:'var(--t3)',fontSize:'.75rem'}}>← Admin Console</a>}
          <button className="ni" onClick={()=>{logout();navigate('/login')}} style={{color:'var(--red)'}}>🚪 Sign out</button>
        </div>
      </aside>
      <div className="main">
        <header className="topbar">
          <span style={{fontSize:'.72rem',color:'var(--t3)',fontFamily:'var(--font-m)'}}>GAM Books · Professional Accounting</span>
          <div style={{marginLeft:'auto',display:'flex',gap:8,alignItems:'center'}}>
            <ClientSwitcher/>
            <span className="badge bgold">Beta</span>
          </div>
        </header>
        <div className="page"><Outlet/></div>
      </div>
    </div>
  )
}

// ── DASHBOARD ──────────────────────────────────────────────────────────
function Dashboard(){
  const{data:employees=[]}=useQuery('emp',()=>get<any[]>('/books/employees'))
  const{data:contractors=[]}=useQuery('con',()=>get<any[]>('/books/contractors'))
  const{data:vendors=[]}=useQuery('ven',()=>get<any[]>('/books/vendors'))
  const{data:accounts=[]}=useQuery('acct',()=>get<any[]>('/books/accounts'))
  const now=new Date()
  return(
    <div>
      <div className="ph">
        <div><h1 className="pt">Books Dashboard</h1><p className="ps">{now.toLocaleString('default',{month:'long',year:'numeric'})}</p></div>
        <span className="badge bgold">📒 GAM Books</span>
      </div>
      <div className="grid4" style={{marginBottom:16}}>
        <div className="kpi"><div className="kl">Employees (W-2)</div><div className="kv b">{(employees as any[]).filter((e:any)=>e.status==='active').length}</div><div className="ks">{(employees as any[]).length} total</div></div>
        <div className="kpi"><div className="kl">Contractors (1099)</div><div className="kv gold">{(contractors as any[]).filter((c:any)=>c.status==='active').length}</div><div className="ks">{(contractors as any[]).length} total</div></div>
        <div className="kpi"><div className="kl">Vendors</div><div className="kv t">{(vendors as any[]).length}</div><div className="ks">Active vendors</div></div>
        <div className="kpi"><div className="kl">Chart of Accounts</div><div className="kv">{(accounts as any[]).length}</div><div className="ks">Active accounts</div></div>
      </div>
      <div className="grid2">
        <div className="card">
          <div className="ct">Quick Actions</div>
          <div style={{display:'flex',flexDirection:'column',gap:8}}>
            <a href="/payroll/employees"   className="btn bg-btn">👥 Add Employee</a>
            <a href="/payroll/contractors" className="btn bg-btn">🔧 Add Contractor</a>
            <a href="/payroll/vendors"     className="btn bg-btn">🏪 Add Vendor</a>
            <a href="/books/accounts"      className="btn bp">📂 Manage Chart of Accounts</a>
          </div>
        </div>
        <div className="card">
          <div className="ct">YTD Payroll Summary</div>
          <div className="dr"><span className="dk">Employee gross pay</span><span className="dv mono">{formatCurrency((employees as any[]).reduce((s:number,e:any)=>s+(+e.ytdGross||0),0))}</span></div>
          <div className="dr"><span className="dk">Contractor payments</span><span className="dv mono">{formatCurrency((contractors as any[]).reduce((s:number,c:any)=>s+(+c.ytdPaid||0),0))}</span></div>
          <div className="dr"><span className="dk">Vendor payments</span><span className="dv mono">{formatCurrency((vendors as any[]).reduce((s:number,v:any)=>s+(+v.ytdPaid||0),0))}</span></div>
          <div className="dr" style={{borderTop:'1px solid var(--b1)',paddingTop:8,marginTop:4}}><span className="dk" style={{fontWeight:700}}>Total YTD disbursed</span><span className="dv mono" style={{color:'var(--gold)',fontWeight:700}}>{formatCurrency((employees as any[]).reduce((s:number,e:any)=>s+(+e.ytdGross||0),0)+(contractors as any[]).reduce((s:number,c:any)=>s+(+c.ytdPaid||0),0)+(vendors as any[]).reduce((s:number,v:any)=>s+(+v.ytdPaid||0),0))}</span></div>
        </div>
      </div>
    </div>
  )
}

// ── CHART OF ACCOUNTS ─────────────────────────────────────────────────
const ACCOUNT_TYPES=['asset','liability','equity','income','expense']
const TYPE_COLORS:Record<string,string>={asset:'bb',liability:'br',equity:'ba',income:'bg2',expense:'bgold'}
const TYPE_LABELS:Record<string,string>={asset:'Asset',liability:'Liability',equity:'Equity',income:'Income',expense:'Expense'}

function ChartOfAccounts(){
  const qc=useQueryClient()
  const{data:accounts=[],isLoading}=useQuery('acct',()=>get<any[]>('/books/accounts'))
  const[tab,setTab]=useState('all')
  const[showAdd,setShowAdd]=useState(false)
  const[seeding,setSeeding]=useState(false)
  const[form,setForm]=useState({code:'',name:'',type:'asset',subtype:'',description:''})
  const[saving,setSaving]=useState(false)
  const[err,setErr]=useState('')

  const filtered=tab==='all'?(accounts as any[]):(accounts as any[]).filter((a:any)=>a.type===tab)
  const grouped=ACCOUNT_TYPES.reduce((acc:any,t)=>({...acc,[t]:(accounts as any[]).filter((a:any)=>a.type===t).length}),{})

  const seedAccounts=async()=>{
    setSeeding(true)
    try{
      const r=await post('/books/accounts/seed')
      qc.invalidateQueries('acct')
      alert((r.data as any).message)
    }catch(e:any){alert(e.response?.data?.error||'Seed failed')}
    finally{setSeeding(false)}
  }

  const addAccount=async(e:React.FormEvent)=>{
    e.preventDefault();setSaving(true);setErr('')
    try{
      await post('/books/accounts',form)
      qc.invalidateQueries('acct')
      setShowAdd(false)
      setForm({code:'',name:'',type:'asset',subtype:'',description:''})
    }catch(ex:any){setErr(ex.response?.data?.error||'Failed to save')}
    finally{setSaving(false)}
  }

  const deactivate=async(id:string)=>{
    if(!confirm('Deactivate this account?'))return
    await patch(`/books/accounts/${id}`,{active:false})
    qc.invalidateQueries('acct')
  }

  return(
    <div>
      <div className="ph">
        <div><h1 className="pt">📂 Chart of Accounts</h1><p className="ps">{(accounts as any[]).length} accounts · double-entry bookkeeping foundation</p></div>
        <div style={{display:'flex',gap:8}}>
          {(accounts as any[]).length===0&&<button className="btn bt" onClick={seedAccounts} disabled={seeding}>{seeding?<><span className="spinner"/>Seeding…</>:'⚡ Seed Standard COA'}</button>}
          <button className="btn bp" onClick={()=>setShowAdd(true)}>+ Add Account</button>
        </div>
      </div>

      {(accounts as any[]).length===0&&!isLoading&&(
        <div className="alert agold">No accounts yet. Click <strong>⚡ Seed Standard COA</strong> to load 38 standard property management accounts instantly.</div>
      )}

      <div className="grid4" style={{marginBottom:16}}>
        {ACCOUNT_TYPES.map(t=>(
          <div key={t} className="kpi" style={{cursor:'pointer',border:tab===t?'1px solid var(--gold)':'1px solid var(--b1)'}} onClick={()=>setTab(tab===t?'all':t)}>
            <div className="kl">{TYPE_LABELS[t]}s</div>
            <div className="kv">{grouped[t]||0}</div>
          </div>
        ))}
      </div>

      <div className="tabs">
        <button className={`tab ${tab==='all'?'on':''}`} onClick={()=>setTab('all')}>All ({(accounts as any[]).length})</button>
        {ACCOUNT_TYPES.map(t=><button key={t} className={`tab ${tab===t?'on':''}`} onClick={()=>setTab(t)}>{TYPE_LABELS[t]} ({grouped[t]||0})</button>)}
      </div>

      <div className="card" style={{padding:0}}>
        {isLoading?<div style={{padding:32,color:'var(--t3)',textAlign:'center'}}><span className="spinner" style={{display:'inline-block'}}/></div>:(
          <table className="tbl">
            <thead><tr><th>Code</th><th>Account Name</th><th>Type</th><th>Subtype</th><th>Balance</th><th>System</th><th></th></tr></thead>
            <tbody>
              {(filtered as any[]).length?(filtered as any[]).map((a:any)=>(
                <tr key={a.id}>
                  <td className="mono" style={{color:'var(--t0)',fontWeight:600}}>{a.code}</td>
                  <td style={{color:'var(--t0)',fontWeight:500}}>{a.name}</td>
                  <td><span className={`badge ${TYPE_COLORS[a.type]||'bmu'}`}>{TYPE_LABELS[a.type]||a.type}</span></td>
                  <td style={{fontSize:'.72rem',color:'var(--t3)'}}>{a.subtype||'—'}</td>
                  <td className="mono">{formatCurrency(a.balance)}</td>
                  <td>{a.isSystem?<span className="badge bmu">System</span>:<span style={{color:'var(--t3)'}}>—</span>}</td>
                  <td><button className="btn bd bsm" onClick={()=>deactivate(a.id)}>Deactivate</button></td>
                </tr>
              )):<tr><td colSpan={7}><div className="empty">No {tab==='all'?'':TYPE_LABELS[tab].toLowerCase()} accounts.</div></td></tr>}
            </tbody>
          </table>
        )}
      </div>

      {showAdd&&(
        <Modal title="Add Account" onClose={()=>setShowAdd(false)}>
          {err&&<div className="alert ae">{err}</div>}
          <form onSubmit={addAccount}>
            <div className="frow2">
              <div><label>Account Code</label><input type="text" value={form.code} onChange={e=>setForm(f=>({...f,code:e.target.value}))} placeholder="e.g. 4010" required/></div>
              <div><label>Type</label>
                <select value={form.type} onChange={e=>setForm(f=>({...f,type:e.target.value}))}>
                  {ACCOUNT_TYPES.map(t=><option key={t} value={t}>{TYPE_LABELS[t]}</option>)}
                </select>
              </div>
            </div>
            <div className="frow"><label>Account Name</label><input type="text" value={form.name} onChange={e=>setForm(f=>({...f,name:e.target.value}))} placeholder="e.g. Rental Income" required/></div>
            <div className="frow"><label>Subtype (optional)</label><input type="text" value={form.subtype} onChange={e=>setForm(f=>({...f,subtype:e.target.value}))} placeholder="e.g. operating, bank, current…"/></div>
            <div className="frow"><label>Description (optional)</label><textarea rows={2} value={form.description} onChange={e=>setForm(f=>({...f,description:e.target.value}))}/></div>
            <div className="factions">
              <button type="button" className="btn bg-btn" onClick={()=>setShowAdd(false)}>Cancel</button>
              <button type="submit" className="btn bp" disabled={saving}>{saving?<><span className="spinner"/>Saving…</>:'Add Account'}</button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  )
}

// ── EMPLOYEES ─────────────────────────────────────────────────────────
const PAY_FREQS=['weekly','biweekly','semimonthly','monthly']
const FILE_STATUS=['single','married','married_higher','head_of_household']

function Employees(){
  const qc=useQueryClient()
  const{data:employees=[],isLoading}=useQuery('emp',()=>get<any[]>('/books/employees'))
  const[showAdd,setShowAdd]=useState(false)
  const[err,setErr]=useState('')
  const[saving,setSaving]=useState(false)
  const initForm={firstName:'',lastName:'',email:'',phone:'',title:'',department:'',payType:'salary',payRate:'',payFrequency:'biweekly',filingStatus:'single',federalAllowances:'0',azWithholdingPct:'2.5',startDate:'',ssnLast4:''}
  const[form,setForm]=useState(initForm)
  const f=(k:string)=>(e:React.ChangeEvent<HTMLInputElement|HTMLSelectElement>)=>setForm(p=>({...p,[k]:e.target.value}))

  const activeEmp=(employees as any[]).filter((e:any)=>e.status==='active')
  const ytdGross=(employees as any[]).reduce((s:number,e:any)=>s+(+e.ytdGross||0),0)

  const calcPaycheck=(rate:number,freq:string,type:string)=>{
    const periods:Record<string,number>={weekly:52,biweekly:26,semimonthly:24,monthly:12}
    const annual=type==='salary'?rate:rate*2080
    return annual/(periods[freq]||26)
  }

  const addEmp=async(e:React.FormEvent)=>{
    e.preventDefault();setSaving(true);setErr('')
    try{
      await post('/books/employees',{...form,payRate:+form.payRate,federalAllowances:+form.federalAllowances,azWithholdingPct:+form.azWithholdingPct})
      qc.invalidateQueries('emp')
      setShowAdd(false);setForm(initForm)
    }catch(ex:any){setErr(ex.response?.data?.error||'Failed to save')}
    finally{setSaving(false)}
  }

  const toggleStatus=async(id:string,current:string)=>{
    await patch(`/books/employees/${id}`,{status:current==='active'?'inactive':'active'})
    qc.invalidateQueries('emp')
  }

  return(
    <div>
      <div className="ph">
        <div><h1 className="pt">👥 Employees (W-2)</h1><p className="ps">{activeEmp.length} active · {(employees as any[]).length} total</p></div>
        <button className="btn bp" onClick={()=>setShowAdd(true)}>+ Add Employee</button>
      </div>

      <div className="grid4" style={{marginBottom:16}}>
        <div className="kpi"><div className="kl">Active W-2</div><div className="kv b">{activeEmp.length}</div><div className="ks">Receiving payroll</div></div>
        <div className="kpi"><div className="kl">YTD Gross Pay</div><div className="kv gold">{formatCurrency(ytdGross)}</div><div className="ks">All employees</div></div>
        <div className="kpi"><div className="kl">YTD Federal W/H</div><div className="kv a">{formatCurrency((employees as any[]).reduce((s:number,e:any)=>s+(+e.ytdFederalTax||0),0))}</div><div className="ks">Withheld YTD</div></div>
        <div className="kpi"><div className="kl">YTD AZ State W/H</div><div className="kv t">{formatCurrency((employees as any[]).reduce((s:number,e:any)=>s+(+e.ytdStateTax||0),0))}</div><div className="ks">AZ flat 2.5%</div></div>
      </div>

      <div className="card" style={{padding:0}}>
        {isLoading?<div style={{padding:32,color:'var(--t3)',textAlign:'center'}}><span className="spinner" style={{display:'inline-block'}}/></div>:(
          <table className="tbl">
            <thead><tr><th>Employee</th><th>Title</th><th>Pay Type</th><th>Rate</th><th>Frequency</th><th>Per Check</th><th>YTD Gross</th><th>Status</th><th></th></tr></thead>
            <tbody>
              {(employees as any[]).length?(employees as any[]).map((emp:any)=>(
                <tr key={emp.id}>
                  <td><div style={{fontWeight:600,color:'var(--t0)'}}>{emp.firstName} {emp.lastName}</div><div style={{fontSize:'.68rem',color:'var(--t3)'}}>{emp.email||'—'}</div></td>
                  <td style={{fontSize:'.75rem'}}>{emp.title||'—'}{emp.department&&<div style={{fontSize:'.68rem',color:'var(--t3)'}}>{emp.department}</div>}</td>
                  <td><span className={`badge ${emp.payType==='salary'?'bb':'ba'}`}>{emp.payType}</span></td>
                  <td className="mono">{emp.payType==='salary'?formatCurrency(emp.payRate)+'/yr':formatCurrency(emp.payRate)+'/hr'}</td>
                  <td style={{fontSize:'.75rem',color:'var(--t2)'}}>{emp.payFrequency}</td>
                  <td className="mono" style={{color:'var(--green)'}}>{formatCurrency(calcPaycheck(+emp.payRate,emp.payFrequency,emp.payType))}</td>
                  <td className="mono">{formatCurrency(emp.ytdGross)}</td>
                  <td><span className={`badge ${emp.status==='active'?'bg2':'bmu'}`}>{emp.status}</span></td>
                  <td><button className="btn bg-btn bsm" onClick={()=>toggleStatus(emp.id,emp.status)}>{emp.status==='active'?'Deactivate':'Activate'}</button></td>
                </tr>
              )):<tr><td colSpan={9}><div className="empty">No employees yet. Add your first W-2 employee.</div></td></tr>}
            </tbody>
          </table>
        )}
      </div>

      {showAdd&&(
        <Modal title="Add Employee (W-2)" onClose={()=>setShowAdd(false)}>
          {err&&<div className="alert ae">{err}</div>}
          <form onSubmit={addEmp}>
            <div className="frow2">
              <div><label>First Name</label><input type="text" value={form.firstName} onChange={f('firstName')} required/></div>
              <div><label>Last Name</label><input type="text" value={form.lastName} onChange={f('lastName')} required/></div>
            </div>
            <div className="frow2">
              <div><label>Email</label><input type="email" value={form.email} onChange={f('email')}/></div>
              <div><label>Phone</label><input type="text" value={form.phone} onChange={f('phone')}/></div>
            </div>
            <div className="frow2">
              <div><label>Title</label><input type="text" value={form.title} onChange={f('title')} placeholder="Property Manager"/></div>
              <div><label>Department</label><input type="text" value={form.department} onChange={f('department')}/></div>
            </div>
            <div className="frow2">
              <div><label>Pay Type</label>
                <select value={form.payType} onChange={f('payType')}>
                  <option value="salary">Salary (annual)</option>
                  <option value="hourly">Hourly</option>
                </select>
              </div>
              <div><label>{form.payType==='salary'?'Annual Salary':'Hourly Rate'}</label>
                <input type="number" min="0" step="0.01" value={form.payRate} onChange={f('payRate')} required placeholder={form.payType==='salary'?'50000':'18.00'}/>
              </div>
            </div>
            <div className="frow2">
              <div><label>Pay Frequency</label>
                <select value={form.payFrequency} onChange={f('payFrequency')}>
                  {PAY_FREQS.map(p=><option key={p} value={p}>{p.charAt(0).toUpperCase()+p.slice(1)}</option>)}
                </select>
              </div>
              <div><label>Filing Status</label>
                <select value={form.filingStatus} onChange={f('filingStatus')}>
                  {FILE_STATUS.map(s=><option key={s} value={s}>{s.replace(/_/g,' ')}</option>)}
                </select>
              </div>
            </div>
            <div className="frow2">
              <div><label>AZ Withholding %</label><input type="number" min="0" max="10" step="0.1" value={form.azWithholdingPct} onChange={f('azWithholdingPct')}/></div>
              <div><label>Start Date</label><input type="date" value={form.startDate} onChange={f('startDate')}/></div>
            </div>
            <div className="frow"><label>SSN Last 4 (optional)</label><input type="text" maxLength={4} value={form.ssnLast4} onChange={f('ssnLast4')} placeholder="For tax forms"/></div>
            <div className="factions">
              <button type="button" className="btn bg-btn" onClick={()=>setShowAdd(false)}>Cancel</button>
              <button type="submit" className="btn bp" disabled={saving}>{saving?<><span className="spinner"/>Saving…</>:'Add Employee'}</button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  )
}

// ── CONTRACTORS ───────────────────────────────────────────────────────
const ENTITY_TYPES=['individual','llc','s_corp','c_corp','partnership']
const TRADES=['General Contractor','Electrician','Plumber','HVAC','Roofer','Painter','Landscaper','Handyman','Cleaner','Pest Control','Other']

function Contractors(){
  const qc=useQueryClient()
  const{data:contractors=[],isLoading}=useQuery('con',()=>get<any[]>('/books/contractors'))
  const[showAdd,setShowAdd]=useState(false)
  const[err,setErr]=useState('')
  const[saving,setSaving]=useState(false)
  const init={firstName:'',lastName:'',businessName:'',email:'',phone:'',ein:'',ssnLast4:'',entityType:'individual',trade:'',payRate:'',payUnit:'project',w9OnFile:false}
  const[form,setForm]=useState(init)
  const f=(k:string)=>(e:React.ChangeEvent<HTMLInputElement|HTMLSelectElement>)=>setForm(p=>({...p,[k]:e.target.value}))

  const active=(contractors as any[]).filter((c:any)=>c.status==='active')
  const w9Missing=(contractors as any[]).filter((c:any)=>!c.w9OnFile&&+c.ytdPaid>=600)

  const add=async(e:React.FormEvent)=>{
    e.preventDefault();setSaving(true);setErr('')
    try{
      await post('/books/contractors',{...form,payRate:form.payRate?+form.payRate:null})
      qc.invalidateQueries('con');setShowAdd(false);setForm(init)
    }catch(ex:any){setErr(ex.response?.data?.error||'Failed')}
    finally{setSaving(false)}
  }

  const toggleW9=async(id:string,current:boolean)=>{
    await patch(`/books/contractors/${id}`,{w9OnFile:!current})
    qc.invalidateQueries('con')
  }

  return(
    <div>
      <div className="ph">
        <div><h1 className="pt">🔧 Contractors (1099)</h1><p className="ps">{active.length} active · {(contractors as any[]).length} total</p></div>
        <button className="btn bp" onClick={()=>setShowAdd(true)}>+ Add Contractor</button>
      </div>

      {w9Missing.length>0&&<div className="alert aw">⚠ {w9Missing.length} contractor(s) paid $600+ without W-9 on file — 1099-NEC required at year end.</div>}

      <div className="grid4" style={{marginBottom:16}}>
        <div className="kpi"><div className="kl">Active Contractors</div><div className="kv gold">{active.length}</div><div className="ks">{(contractors as any[]).length} total</div></div>
        <div className="kpi"><div className="kl">YTD Contractor Pay</div><div className="kv t">{formatCurrency((contractors as any[]).reduce((s:number,c:any)=>s+(+c.ytdPaid||0),0))}</div><div className="ks">Total disbursed</div></div>
        <div className="kpi"><div className="kl">W-9 on File</div><div className={`kv ${w9Missing.length>0?'r':'g'}`}>{(contractors as any[]).filter((c:any)=>c.w9OnFile).length}/{(contractors as any[]).length}</div><div className="ks">Required for 1099</div></div>
        <div className="kpi"><div className="kl">1099-NEC Needed</div><div className={`kv ${w9Missing.length>0?'a':'g'}`}>{(contractors as any[]).filter((c:any)=>+c.ytdPaid>=600).length}</div><div className="ks">Paid $600+ YTD</div></div>
      </div>

      <div className="card" style={{padding:0}}>
        {isLoading?<div style={{padding:32,color:'var(--t3)',textAlign:'center'}}><span className="spinner" style={{display:'inline-block'}}/></div>:(
          <table className="tbl">
            <thead><tr><th>Name / Business</th><th>Trade</th><th>Entity</th><th>Rate</th><th>YTD Paid</th><th>W-9</th><th>1099</th><th>Status</th></tr></thead>
            <tbody>
              {(contractors as any[]).length?(contractors as any[]).map((c:any)=>(
                <tr key={c.id}>
                  <td>
                    <div style={{fontWeight:600,color:'var(--t0)'}}>{c.businessName||[c.firstName,c.lastName].filter(Boolean).join(' ')||'—'}</div>
                    {c.businessName&&<div style={{fontSize:'.68rem',color:'var(--t3)'}}>{[c.firstName,c.lastName].filter(Boolean).join(' ')}</div>}
                    <div style={{fontSize:'.65rem',color:'var(--t3)'}}>{c.email||''}</div>
                  </td>
                  <td style={{fontSize:'.75rem'}}>{c.trade||'—'}</td>
                  <td><span className="badge bmu">{c.entityType?.replace('_',' ')||'—'}</span></td>
                  <td className="mono">{c.payRate?formatCurrency(c.payRate)+'/'+c.payUnit:'—'}</td>
                  <td className="mono" style={{color:+c.ytdPaid>=600?'var(--amber)':'var(--t1)'}}>{formatCurrency(c.ytdPaid)}</td>
                  <td>
                    <button className={`badge ${c.w9OnFile?'bg2':'br'}`} style={{cursor:'pointer',border:'none'}} onClick={()=>toggleW9(c.id,c.w9OnFile)}>
                      {c.w9OnFile?'✓ On File':'Missing'}
                    </button>
                  </td>
                  <td>{+c.ytdPaid>=600?<span className="badge ba">Required</span>:<span style={{color:'var(--t3)'}}>—</span>}</td>
                  <td><span className={`badge ${c.status==='active'?'bg2':'bmu'}`}>{c.status}</span></td>
                </tr>
              )):<tr><td colSpan={8}><div className="empty">No contractors yet.</div></td></tr>}
            </tbody>
          </table>
        )}
      </div>

      {showAdd&&(
        <Modal title="Add Contractor (1099)" onClose={()=>setShowAdd(false)}>
          {err&&<div className="alert ae">{err}</div>}
          <form onSubmit={add}>
            <div className="frow"><label>Entity Type</label>
              <select value={form.entityType} onChange={f('entityType')}>
                {ENTITY_TYPES.map(t=><option key={t} value={t}>{t.replace('_',' ').toUpperCase()}</option>)}
              </select>
            </div>
            {form.entityType==='individual'&&<div className="frow2">
              <div><label>First Name</label><input type="text" value={form.firstName} onChange={f('firstName')}/></div>
              <div><label>Last Name</label><input type="text" value={form.lastName} onChange={f('lastName')}/></div>
            </div>}
            {form.entityType!=='individual'&&<div className="frow"><label>Business Name</label><input type="text" value={form.businessName} onChange={f('businessName')} required/></div>}
            <div className="frow2">
              <div><label>Email</label><input type="email" value={form.email} onChange={f('email')}/></div>
              <div><label>Phone</label><input type="text" value={form.phone} onChange={f('phone')}/></div>
            </div>
            <div className="frow2">
              <div><label>Trade / Specialty</label>
                <select value={form.trade} onChange={f('trade')}>
                  <option value="">Select trade…</option>
                  {TRADES.map(t=><option key={t} value={t}>{t}</option>)}
                </select>
              </div>
              <div><label>EIN (or SSN last 4)</label><input type="text" value={form.ein} onChange={f('ein')} placeholder="XX-XXXXXXX"/></div>
            </div>
            <div className="frow2">
              <div><label>Default Rate</label><input type="number" min="0" step="0.01" value={form.payRate} onChange={f('payRate')} placeholder="0.00"/></div>
              <div><label>Per</label>
                <select value={form.payUnit} onChange={f('payUnit')}>
                  <option value="project">Project</option>
                  <option value="hour">Hour</option>
                  <option value="day">Day</option>
                </select>
              </div>
            </div>
            <div className="frow" style={{display:'flex',alignItems:'center',gap:10}}>
              <input type="checkbox" id="w9" checked={form.w9OnFile} onChange={e=>setForm(p=>({...p,w9OnFile:e.target.checked}))} style={{width:'auto'}}/>
              <label htmlFor="w9" style={{textTransform:'none',letterSpacing:0,fontSize:'.82rem',marginBottom:0}}>W-9 on file</label>
            </div>
            <div className="factions">
              <button type="button" className="btn bg-btn" onClick={()=>setShowAdd(false)}>Cancel</button>
              <button type="submit" className="btn bp" disabled={saving}>{saving?<><span className="spinner"/>Saving…</>:'Add Contractor'}</button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  )
}

// ── VENDORS ───────────────────────────────────────────────────────────
const VENDOR_CATS=['Utilities','Insurance','Property Tax','Mortgage / Loan','Landscaping','Pest Control','Cleaning','Repairs','Software','Professional Services','Supplies','Other']
const PAY_TERMS=['net15','net30','net45','net60','due_on_receipt','prepaid']

function Vendors(){
  const qc=useQueryClient()
  const{data:vendors=[],isLoading}=useQuery('ven',()=>get<any[]>('/books/vendors'))
  const[showAdd,setShowAdd]=useState(false)
  const[err,setErr]=useState('')
  const[saving,setSaving]=useState(false)
  const init={name:'',contactName:'',email:'',phone:'',address:'',category:'',paymentTerms:'net30',accountNumber:'',taxId:'',notes:''}
  const[form,setForm]=useState(init)
  const f=(k:string)=>(e:React.ChangeEvent<HTMLInputElement|HTMLSelectElement|HTMLTextAreaElement>)=>setForm(p=>({...p,[k]:e.target.value}))

  const overdue=(vendors as any[]).filter((v:any)=>+v.apBalance>0)

  const add=async(e:React.FormEvent)=>{
    e.preventDefault();setSaving(true);setErr('')
    try{
      await post('/books/vendors',form)
      qc.invalidateQueries('ven');setShowAdd(false);setForm(init)
    }catch(ex:any){setErr(ex.response?.data?.error||'Failed')}
    finally{setSaving(false)}
  }

  return(
    <div>
      <div className="ph">
        <div><h1 className="pt">🏪 Vendors</h1><p className="ps">{(vendors as any[]).length} active vendors</p></div>
        <button className="btn bp" onClick={()=>setShowAdd(true)}>+ Add Vendor</button>
      </div>

      <div className="grid4" style={{marginBottom:16}}>
        <div className="kpi"><div className="kl">Active Vendors</div><div className="kv t">{(vendors as any[]).length}</div><div className="ks">In your vendor list</div></div>
        <div className="kpi"><div className="kl">Total AP Balance</div><div className={`kv ${overdue.length>0?'r':'g'}`}>{formatCurrency((vendors as any[]).reduce((s:number,v:any)=>s+(+v.apBalance||0),0))}</div><div className="ks">Outstanding bills</div></div>
        <div className="kpi"><div className="kl">YTD Vendor Payments</div><div className="kv gold">{formatCurrency((vendors as any[]).reduce((s:number,v:any)=>s+(+v.ytdPaid||0),0))}</div><div className="ks">Total paid YTD</div></div>
        <div className="kpi"><div className="kl">Vendors with Balance</div><div className={`kv ${overdue.length>0?'a':'g'}`}>{overdue.length}</div><div className="ks">Open AP</div></div>
      </div>

      {overdue.length>0&&<div className="alert aw">📄 {overdue.length} vendor(s) have open balances. Go to Bills &amp; AP to process payments.</div>}

      <div className="card" style={{padding:0}}>
        {isLoading?<div style={{padding:32,color:'var(--t3)',textAlign:'center'}}><span className="spinner" style={{display:'inline-block'}}/></div>:(
          <table className="tbl">
            <thead><tr><th>Vendor</th><th>Contact</th><th>Category</th><th>Payment Terms</th><th>AP Balance</th><th>YTD Paid</th><th>Account #</th></tr></thead>
            <tbody>
              {(vendors as any[]).length?(vendors as any[]).map((v:any)=>(
                <tr key={v.id}>
                  <td><div style={{fontWeight:600,color:'var(--t0)'}}>{v.name}</div></td>
                  <td><div style={{fontSize:'.75rem'}}>{v.contactName||'—'}</div><div style={{fontSize:'.65rem',color:'var(--t3)'}}>{v.email||''}</div></td>
                  <td>{v.category?<span className="badge bmu">{v.category}</span>:<span style={{color:'var(--t3)'}}>—</span>}</td>
                  <td style={{fontSize:'.75rem',color:'var(--t2)'}}>{v.paymentTerms?.replace('_',' ')||'—'}</td>
                  <td className="mono" style={{color:+v.apBalance>0?'var(--red)':'var(--t3)'}}>{+v.apBalance>0?formatCurrency(v.apBalance):'—'}</td>
                  <td className="mono">{formatCurrency(v.ytdPaid)}</td>
                  <td className="mono" style={{fontSize:'.72rem',color:'var(--t3)'}}>{v.accountNumber||'—'}</td>
                </tr>
              )):<tr><td colSpan={7}><div className="empty">No vendors yet. Add vendors to track bills and AP.</div></td></tr>}
            </tbody>
          </table>
        )}
      </div>

      {showAdd&&(
        <Modal title="Add Vendor" onClose={()=>setShowAdd(false)}>
          {err&&<div className="alert ae">{err}</div>}
          <form onSubmit={add}>
            <div className="frow"><label>Vendor Name</label><input type="text" value={form.name} onChange={f('name')} required placeholder="e.g. APS Electric, City of Phoenix Water"/></div>
            <div className="frow2">
              <div><label>Contact Name</label><input type="text" value={form.contactName} onChange={f('contactName')}/></div>
              <div><label>Phone</label><input type="text" value={form.phone} onChange={f('phone')}/></div>
            </div>
            <div className="frow"><label>Email</label><input type="email" value={form.email} onChange={f('email')}/></div>
            <div className="frow2">
              <div><label>Category</label>
                <select value={form.category} onChange={f('category')}>
                  <option value="">Select…</option>
                  {VENDOR_CATS.map(c=><option key={c} value={c}>{c}</option>)}
                </select>
              </div>
              <div><label>Payment Terms</label>
                <select value={form.paymentTerms} onChange={f('paymentTerms')}>
                  {PAY_TERMS.map(t=><option key={t} value={t}>{t.replace('_',' ')}</option>)}
                </select>
              </div>
            </div>
            <div className="frow2">
              <div><label>Account # (optional)</label><input type="text" value={form.accountNumber} onChange={f('accountNumber')}/></div>
              <div><label>Tax ID / EIN (optional)</label><input type="text" value={form.taxId} onChange={f('taxId')}/></div>
            </div>
            <div className="frow"><label>Notes</label><textarea rows={2} value={form.notes} onChange={f('notes')}/></div>
            <div className="factions">
              <button type="button" className="btn bg-btn" onClick={()=>setShowAdd(false)}>Cancel</button>
              <button type="submit" className="btn bp" disabled={saving}>{saving?<><span className="spinner"/>Saving…</>:'Add Vendor'}</button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  )
}


// ── RUN PAYROLL ───────────────────────────────────────────────────────
const FREQ_OPTIONS=[
  {value:'weekly',    label:'Weekly'},
  {value:'biweekly',  label:'Bi-Weekly'},
  {value:'semimonthly',label:'Semi-Monthly'},
  {value:'monthly',   label:'Monthly'},
]

function RunPayroll(){
  const qc=useQueryClient()
  const{data:employees=[]}=useQuery('emp',()=>get<any[]>('/books/employees'))
  const active=(employees as any[]).filter((e:any)=>e.status==='active')
  const[step,setStep]=useState<'setup'|'review'|'done'>('setup')
  const[selectedIds,setSelectedIds]=useState<string[]>([])
  const[hoursMap,setHoursMap]=useState<Record<string,string>>({})
  const[freq,setFreq]=useState('biweekly')
  const[periodStart,setPeriodStart]=useState('')
  const[periodEnd,setPeriodEnd]=useState('')
  const[payDate,setPayDate]=useState('')
  const[draftRun,setDraftRun]=useState<any>(null)
  const[calculating,setCalculating]=useState(false)
  const[approving,setApproving]=useState(false)
  const[err,setErr]=useState('')

  const toggleEmp=(id:string)=>setSelectedIds(s=>s.includes(id)?s.filter(x=>x!==id):[...s,id])
  const toggleAll=()=>setSelectedIds(s=>s.length===active.length?[]:active.map((e:any)=>e.id))

  const calcRun=async(e:React.FormEvent)=>{
    e.preventDefault();setCalculating(true);setErr('')
    try{
      const r=await post<any>('/books/payroll/runs',{
        periodStart,periodEnd,payDate,payFrequency:freq,
        employeeIds:selectedIds,
        hoursMap:Object.fromEntries(Object.entries(hoursMap).map(([k,v])=>[k,+v]))
      })
      setDraftRun(r.data)
      setStep('review')
    }catch(ex:any){setErr(ex.response?.data?.error||'Calculation failed')}
    finally{setCalculating(false)}
  }

  const approve=async()=>{
    if(!confirm('Approve this payroll run? YTD totals will be updated for all employees.'))return
    setApproving(true);setErr('')
    try{
      await post(`/books/payroll/runs/${draftRun.id}/approve`)
      qc.invalidateQueries('emp')
      qc.invalidateQueries('payroll-runs')
      setStep('done')
    }catch(ex:any){setErr(ex.response?.data?.error||'Approval failed')}
    finally{setApproving(false)}
  }

  const voidRun=async()=>{
    if(!confirm('Void this draft run?'))return
    await post(`/books/payroll/runs/${draftRun.id}/void`)
    setDraftRun(null);setStep('setup')
    qc.invalidateQueries('payroll-runs')
  }

  const fmtFreq=(f:string)=>FREQ_OPTIONS.find(o=>o.value===f)?.label||f

  return(
    <div>
      <div className="ph">
        <div><h1 className="pt">▶ Run Payroll</h1><p className="ps">Calculate, review, and approve payroll for your employees</p></div>
        {step!=='setup'&&<button className="btn bg-btn" onClick={()=>{setStep('setup');setDraftRun(null)}}>← Start Over</button>}
      </div>

      {err&&<div className="alert ae">{err}</div>}

      {/* STEP 1 — SETUP */}
      {step==='setup'&&(
        <form onSubmit={calcRun}>
          <div className="grid2" style={{marginBottom:16}}>
            <div className="card">
              <div className="ct">Pay Period</div>
              <div className="frow"><label>Pay Frequency</label>
                <select value={freq} onChange={e=>setFreq(e.target.value)}>
                  {FREQ_OPTIONS.map(o=><option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              </div>
              <div className="frow2">
                <div><label>Period Start</label><input type="date" value={periodStart} onChange={e=>setPeriodStart(e.target.value)} required/></div>
                <div><label>Period End</label><input type="date" value={periodEnd} onChange={e=>setPeriodEnd(e.target.value)} required/></div>
              </div>
              <div className="frow"><label>Pay Date</label><input type="date" value={payDate} onChange={e=>setPayDate(e.target.value)} required/></div>
            </div>

            <div className="card">
              <div className="ct">Deduction Summary (per paycheck)</div>
              <div className="dr"><span className="dk">Social Security</span><span className="dv mono">6.2% (up to $168,600/yr)</span></div>
              <div className="dr"><span className="dk">Medicare</span><span className="dv mono">1.45% (+0.9% over $200k)</span></div>
              <div className="dr"><span className="dk">AZ State (flat)</span><span className="dv mono">2.5% per employee setting</span></div>
              <div className="dr"><span className="dk">Federal W/H</span><span className="dv mono">Per filing status</span></div>
              <div style={{marginTop:10,fontSize:'.72rem',color:'var(--t3)'}}>Federal withholding uses simplified rate tables. Production should use IRS Publication 15-T bracket tables.</div>
            </div>
          </div>

          <div className="card" style={{marginBottom:16}}>
            <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:14}}>
              <div className="ct" style={{marginBottom:0}}>Select Employees ({selectedIds.length}/{active.length})</div>
              <button type="button" className="btn bg-btn bsm" onClick={toggleAll}>{selectedIds.length===active.length?'Deselect All':'Select All'}</button>
            </div>
            {active.length===0?<div className="empty">No active employees. Add employees first.</div>:(
              <table className="tbl">
                <thead><tr><th style={{width:40}}></th><th>Employee</th><th>Type</th><th>Rate</th><th>Hours (if hourly)</th><th>Est. Gross</th></tr></thead>
                <tbody>
                  {active.map((emp:any)=>{
                    const periods:Record<string,number>={weekly:52,biweekly:26,semimonthly:24,monthly:12}
                    const ppy=periods[freq]||26
                    const h=+(hoursMap[emp.id]||'80')
                    const gross=emp.payType==='salary'?(+emp.payRate/ppy):(+emp.payRate*h)
                    return(
                      <tr key={emp.id} style={{background:selectedIds.includes(emp.id)?'rgba(201,162,39,.04)':''}}>
                        <td><input type="checkbox" checked={selectedIds.includes(emp.id)} onChange={()=>toggleEmp(emp.id)} style={{width:'auto',cursor:'pointer'}}/></td>
                        <td><div style={{fontWeight:600,color:'var(--t0)'}}>{emp.firstName} {emp.lastName}</div><div style={{fontSize:'.68rem',color:'var(--t3)'}}>{emp.title||''}</div></td>
                        <td><span className={`badge ${emp.payType==='salary'?'bb':'ba'}`}>{emp.payType}</span></td>
                        <td className="mono">{emp.payType==='salary'?formatCurrency(emp.payRate)+'/yr':formatCurrency(emp.payRate)+'/hr'}</td>
                        <td>{emp.payType==='hourly'?(
                          <input type="number" min="0" step="0.5" style={{width:80}} value={hoursMap[emp.id]||'80'} onChange={e=>setHoursMap(m=>({...m,[emp.id]:e.target.value}))} disabled={!selectedIds.includes(emp.id)}/>
                        ):<span style={{color:'var(--t3)'}}>—</span>}</td>
                        <td className="mono" style={{color:'var(--green)'}}>{formatCurrency(gross)}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            )}
          </div>

          <div style={{display:'flex',justifyContent:'flex-end'}}>
            <button type="submit" className="btn bp" disabled={calculating||selectedIds.length===0} style={{padding:'10px 24px',fontSize:'.9rem'}}>
              {calculating?<><span className="spinner"/>Calculating…</>:`Calculate Payroll for ${selectedIds.length} Employee${selectedIds.length!==1?'s':''} →`}
            </button>
          </div>
        </form>
      )}

      {/* STEP 2 — REVIEW */}
      {step==='review'&&draftRun&&(
        <div>
          <div className="grid4" style={{marginBottom:16}}>
            <div className="kpi"><div className="kl">Total Gross Pay</div><div className="kv gold">{formatCurrency(draftRun.totalGross)}</div><div className="ks">{draftRun.employeeCount} employees · {fmtFreq(draftRun.payFrequency)}</div></div>
            <div className="kpi"><div className="kl">Total Taxes</div><div className="kv r">{formatCurrency((+draftRun.totalFederalTax)+(+draftRun.totalStateTax)+(+draftRun.totalSs)+(+draftRun.totalMedicare))}</div><div className="ks">Fed + AZ + SS + Medicare</div></div>
            <div className="kpi"><div className="kl">Total Net Pay</div><div className="kv g">{formatCurrency(draftRun.totalNet)}</div><div className="ks">Employee take-home</div></div>
            <div className="kpi"><div className="kl">Pay Date</div><div className="kv b" style={{fontSize:'1.1rem'}}>{new Date(draftRun.payDate+'T12:00:00').toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'})}</div><div className="ks">Period: {new Date(draftRun.periodStart+'T12:00:00').toLocaleDateString()} – {new Date(draftRun.periodEnd+'T12:00:00').toLocaleDateString()}</div></div>
          </div>

          <div className="card" style={{marginBottom:16,padding:0}}>
            <div style={{padding:'12px 16px',borderBottom:'1px solid var(--b1)'}}><div className="ct" style={{marginBottom:0}}>Pay Run Breakdown</div></div>
            <table className="tbl">
              <thead><tr><th>Employee</th><th>Pay Type</th><th>Gross</th><th>Federal W/H</th><th>SS (6.2%)</th><th>Medicare</th><th>AZ State</th><th>Net Pay</th></tr></thead>
              <tbody>
                {draftRun.lines?.map((line:any)=>(
                  <tr key={line.id}>
                    <td><div style={{fontWeight:600,color:'var(--t0)'}}>{line.firstName} {line.lastName}</div><div style={{fontSize:'.68rem',color:'var(--t3)'}}>{line.title||''}{line.hoursWorked?' · '+line.hoursWorked+' hrs':''}</div></td>
                    <td><span className={`badge ${line.payType==='salary'?'bb':'ba'}`}>{line.payType}</span></td>
                    <td className="mono" style={{color:'var(--t0)',fontWeight:600}}>{formatCurrency(line.grossPay)}</td>
                    <td className="mono" style={{color:'var(--red)'}}>{formatCurrency(line.federalTax)}</td>
                    <td className="mono" style={{color:'var(--amber)'}}>{formatCurrency(line.ssTax)}</td>
                    <td className="mono" style={{color:'var(--amber)'}}>{formatCurrency(line.medicareTax)}</td>
                    <td className="mono" style={{color:'var(--amber)'}}>{formatCurrency(line.stateTax)}</td>
                    <td className="mono" style={{color:'var(--green)',fontWeight:700}}>{formatCurrency(line.netPay)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr style={{background:'var(--bg3)'}}>
                  <td colSpan={2} style={{padding:'10px 12px',fontWeight:700,color:'var(--t0)',fontFamily:'var(--font-d)'}}>TOTALS</td>
                  <td className="mono" style={{fontWeight:700,color:'var(--gold)',padding:'10px 12px'}}>{formatCurrency(draftRun.totalGross)}</td>
                  <td className="mono" style={{color:'var(--red)',padding:'10px 12px'}}>{formatCurrency(draftRun.totalFederalTax)}</td>
                  <td className="mono" style={{color:'var(--amber)',padding:'10px 12px'}}>{formatCurrency(draftRun.totalSs)}</td>
                  <td className="mono" style={{color:'var(--amber)',padding:'10px 12px'}}>{formatCurrency(draftRun.totalMedicare)}</td>
                  <td className="mono" style={{color:'var(--amber)',padding:'10px 12px'}}>{formatCurrency(draftRun.totalStateTax)}</td>
                  <td className="mono" style={{fontWeight:700,color:'var(--green)',padding:'10px 12px'}}>{formatCurrency(draftRun.totalNet)}</td>
                </tr>
              </tfoot>
            </table>
          </div>

          <div className="card" style={{marginBottom:16}}>
            <div className="ct">Employer Tax Liability (this run)</div>
            <div className="dr"><span className="dk">Employer SS match (6.2%)</span><span className="dv mono" style={{color:'var(--amber)'}}>{formatCurrency(draftRun.totalSs)}</span></div>
            <div className="dr"><span className="dk">Employer Medicare match (1.45%)</span><span className="dv mono" style={{color:'var(--amber)'}}>{formatCurrency(draftRun.totalMedicare)}</span></div>
            <div className="dr"><span className="dk">Total employer tax cost</span><span className="dv mono" style={{color:'var(--red)',fontWeight:700}}>{formatCurrency((+draftRun.totalSs)+(+draftRun.totalMedicare))}</span></div>
            <div className="dr"><span className="dk">Total cost to employer (gross + employer taxes)</span><span className="dv mono" style={{color:'var(--gold)',fontWeight:700}}>{formatCurrency((+draftRun.totalGross)+(+draftRun.totalSs)+(+draftRun.totalMedicare))}</span></div>
          </div>

          <div style={{display:'flex',gap:12,justifyContent:'flex-end'}}>
            <button className="btn bd" onClick={voidRun}>Void Draft</button>
            <button className="btn bp" onClick={approve} disabled={approving} style={{padding:'10px 28px',fontSize:'.9rem'}}>
              {approving?<><span className="spinner"/>Approving…</>:'✓ Approve & Post Payroll'}
            </button>
          </div>
        </div>
      )}

      {/* STEP 3 — DONE */}
      {step==='done'&&(
        <div className="card" style={{textAlign:'center',padding:'60px 20px'}}>
          <div style={{fontSize:'3rem',marginBottom:16}}>✅</div>
          <h2 style={{color:'var(--green)',marginBottom:8}}>Payroll Approved!</h2>
          <p style={{color:'var(--t2)',marginBottom:4}}>Total gross: <strong style={{color:'var(--t0)'}}>{formatCurrency(draftRun?.totalGross)}</strong></p>
          <p style={{color:'var(--t2)',marginBottom:24}}>Net pay: <strong style={{color:'var(--green)'}}>{formatCurrency(draftRun?.totalNet)}</strong> for {draftRun?.employeeCount} employee{draftRun?.employeeCount!==1?'s':''}</p>
          <p style={{color:'var(--t3)',fontSize:'.8rem',marginBottom:24}}>YTD totals have been updated. View the run in Pay History.</p>
          <div style={{display:'flex',gap:12,justifyContent:'center'}}>
            <button className="btn bg-btn" onClick={()=>{setStep('setup');setDraftRun(null);setSelectedIds([]);setHoursMap({})}}>Run Another Payroll</button>
            <a href="/payroll/history" className="btn bp">View Pay History →</a>
          </div>
        </div>
      )}
    </div>
  )
}

// ── PAY HISTORY ───────────────────────────────────────────────────────
function PayHistory(){
  const{data:runs=[],isLoading}=useQuery('payroll-runs',()=>get<any[]>('/books/payroll/runs'))
  const[selected,setSelected]=useState<any>(null)
  const{data:runDetail}=useQuery(['payroll-run',selected?.id],()=>get<any>(`/books/payroll/runs/${selected.id}`),{enabled:!!selected?.id})
  const qc=useQueryClient()

  const voidRun=async(id:string)=>{
    if(!confirm('Void this approved run? YTD totals will be reversed.'))return
    await post(`/books/payroll/runs/${id}/void`)
    qc.invalidateQueries('payroll-runs')
    qc.invalidateQueries('emp')
    setSelected(null)
  }

  const STATUS:Record<string,string>={draft:'ba',approved:'bg2',voided:'bmu'}

  return(
    <div>
      <div className="ph">
        <div><h1 className="pt">🕐 Pay History</h1><p className="ps">{(runs as any[]).length} payroll runs</p></div>
        <a href="/payroll/runs" className="btn bp">▶ New Run</a>
      </div>

      <div className="grid2" style={{gap:16}}>
        <div className="card" style={{padding:0}}>
          {isLoading?<div style={{padding:32,color:'var(--t3)',textAlign:'center'}}><span className="spinner" style={{display:'inline-block'}}/></div>:(
            <table className="tbl">
              <thead><tr><th>Pay Date</th><th>Period</th><th>Freq</th><th>Employees</th><th>Gross</th><th>Net</th><th>Status</th></tr></thead>
              <tbody>
                {(runs as any[]).length?(runs as any[]).map((r:any)=>(
                  <tr key={r.id} style={{cursor:'pointer',background:selected?.id===r.id?'rgba(201,162,39,.05)':''}} onClick={()=>setSelected(r)}>
                    <td className="mono" style={{color:'var(--t0)',fontWeight:600}}>{new Date(r.payDate+'T12:00:00').toLocaleDateString()}</td>
                    <td style={{fontSize:'.68rem',color:'var(--t3)'}}>{new Date(r.periodStart+'T12:00:00').toLocaleDateString()} – {new Date(r.periodEnd+'T12:00:00').toLocaleDateString()}</td>
                    <td><span className="badge bmu" style={{fontSize:'.6rem'}}>{r.payFrequency}</span></td>
                    <td className="mono">{r.employeeCount}</td>
                    <td className="mono" style={{color:'var(--gold)'}}>{formatCurrency(r.totalGross)}</td>
                    <td className="mono" style={{color:'var(--green)'}}>{formatCurrency(r.totalNet)}</td>
                    <td><span className={`badge ${STATUS[r.status]||'bmu'}`}>{r.status}</span></td>
                  </tr>
                )):<tr><td colSpan={7}><div className="empty">No payroll runs yet.</div></td></tr>}
              </tbody>
            </table>
          )}
        </div>

        <div>
          {!selected&&<div className="card" style={{textAlign:'center',padding:'48px 20px',color:'var(--t3)'}}>Select a run to view details</div>}
          {selected&&runDetail&&(
            <div className="card">
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:16}}>
                <div>
                  <div style={{fontFamily:'var(--font-d)',fontWeight:700,color:'var(--t0)'}}>Pay Date: {new Date(runDetail.payDate+'T12:00:00').toLocaleDateString()}</div>
                  <div style={{fontSize:'.72rem',color:'var(--t3)',marginTop:2}}>{new Date(runDetail.periodStart+'T12:00:00').toLocaleDateString()} – {new Date(runDetail.periodEnd+'T12:00:00').toLocaleDateString()} · {runDetail.payFrequency}</div>
                </div>
                <span className={`badge ${STATUS[runDetail.status]||'bmu'}`}>{runDetail.status}</span>
              </div>
              <div className="dr"><span className="dk">Gross Pay</span><span className="dv mono" style={{color:'var(--gold)'}}>{formatCurrency(runDetail.totalGross)}</span></div>
              <div className="dr"><span className="dk">Federal W/H</span><span className="dv mono" style={{color:'var(--red)'}}>{formatCurrency(runDetail.totalFederalTax)}</span></div>
              <div className="dr"><span className="dk">SS + Medicare</span><span className="dv mono" style={{color:'var(--amber)'}}>{formatCurrency((+runDetail.totalSs)+(+runDetail.totalMedicare))}</span></div>
              <div className="dr"><span className="dk">AZ State Tax</span><span className="dv mono" style={{color:'var(--amber)'}}>{formatCurrency(runDetail.totalStateTax)}</span></div>
              <div className="dr" style={{borderTop:'1px solid var(--b1)',paddingTop:8,marginTop:4}}><span className="dk" style={{fontWeight:700}}>Net Pay</span><span className="dv mono" style={{color:'var(--green)',fontWeight:700}}>{formatCurrency(runDetail.totalNet)}</span></div>

              <div style={{marginTop:16}}>
                <div className="ct">Employee Lines</div>
                {runDetail.lines?.map((l:any)=>(
                  <div key={l.id} style={{padding:'8px 0',borderBottom:'1px solid var(--b0)',display:'flex',justifyContent:'space-between',alignItems:'center'}}>
                    <div>
                      <div style={{fontSize:'.82rem',fontWeight:600,color:'var(--t0)'}}>{l.firstName} {l.lastName}</div>
                      <div style={{fontSize:'.68rem',color:'var(--t3)'}}>Gross {formatCurrency(l.grossPay)} · Net {formatCurrency(l.netPay)}</div>
                    </div>
                    <span className="mono" style={{color:'var(--green)',fontWeight:600}}>{formatCurrency(l.netPay)}</span>
                  </div>
                ))}
              </div>

              {runDetail.status==='approved'&&(
                <div style={{marginTop:16}}>
                  <button className="btn bd bsm" onClick={()=>voidRun(runDetail.id)}>Void This Run</button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}



// ── JOURNAL ENTRIES ───────────────────────────────────────────────────
function JournalEntries(){
  const qc=useQueryClient()
  const{data:entries=[],isLoading}=useQuery('journal',()=>get<any[]>('/books/journal'))
  const{data:accounts=[]}=useQuery('acct',()=>get<any[]>('/books/accounts'))
  const[showAdd,setShowAdd]=useState(false)
  const[selectedEntry,setSelectedEntry]=useState<any>(null)
  const{data:entryDetail}=useQuery(['je',selectedEntry?.id],()=>get<any>('/books/journal/'+selectedEntry.id),{enabled:!!selectedEntry?.id})
  const[err,setErr]=useState('')
  const[saving,setSaving]=useState(false)
  const initForm={date:new Date().toISOString().split('T')[0],description:'',reference:'',lines:[{accountId:'',description:'',debit:'',credit:''},{accountId:'',description:'',debit:'',credit:''}]}
  const[form,setForm]=useState(initForm)

  const totalDebits=form.lines.reduce((s,l)=>s+(+l.debit||0),0)
  const totalCredits=form.lines.reduce((s,l)=>s+(+l.credit||0),0)
  const balanced=Math.abs(totalDebits-totalCredits)<0.01&&totalDebits>0

  const addLine=()=>setForm(f=>({...f,lines:[...f.lines,{accountId:'',description:'',debit:'',credit:''}]}))
  const removeLine=(i:number)=>setForm(f=>({...f,lines:f.lines.filter((_,idx)=>idx!==i)}))
  const updateLine=(i:number,k:string,v:string)=>setForm(f=>({...f,lines:f.lines.map((l,idx)=>idx===i?{...l,[k]:v}:l)}))

  const submit=async(e:React.FormEvent)=>{
    e.preventDefault();setSaving(true);setErr('')
    try{
      await post('/books/journal',{...form,lines:form.lines.filter(l=>l.accountId).map(l=>({...l,debit:+l.debit||0,credit:+l.credit||0}))})
      qc.invalidateQueries('journal');qc.invalidateQueries('acct')
      setShowAdd(false);setForm(initForm)
    }catch(ex:any){setErr(ex.response?.data?.error||'Failed')}
    finally{setSaving(false)}
  }

  const voidEntry=async(id:string)=>{
    if(!confirm('Void this journal entry? Account balances will be reversed.'))return
    await post('/books/journal/'+id+'/void')
    qc.invalidateQueries('journal');qc.invalidateQueries('acct')
    setSelectedEntry(null)
  }

  const STATUS:Record<string,string>={posted:'bg2',voided:'bmu',draft:'ba'}
  const incomeAccts=(accounts as any[]).filter((a:any)=>a.type==='income')
  const expenseAccts=(accounts as any[]).filter((a:any)=>a.type==='expense')
  const assetAccts=(accounts as any[]).filter((a:any)=>a.type==='asset')
  const liabAccts=(accounts as any[]).filter((a:any)=>a.type==='liability')
  const equityAccts=(accounts as any[]).filter((a:any)=>a.type==='equity')

  return(
    <div>
      <div className="ph">
        <div><h1 className="pt">📓 Journal Entries</h1><p className="ps">{(entries as any[]).length} entries · double-entry bookkeeping</p></div>
        <button className="btn bp" onClick={()=>setShowAdd(true)}>+ New Entry</button>
      </div>

      {(accounts as any[]).length===0&&<div className="alert aw">⚠ No chart of accounts found. <a href="/books/accounts">Set up your accounts</a> before creating journal entries.</div>}

      <div className="grid2" style={{gap:16}}>
        <div className="card" style={{padding:0}}>
          {isLoading?<div style={{padding:32,color:'var(--t3)',textAlign:'center'}}><span className="spinner" style={{display:'inline-block'}}/></div>:(
            <table className="tbl">
              <thead><tr><th>#</th><th>Date</th><th>Description</th><th>Debits</th><th>Status</th></tr></thead>
              <tbody>
                {(entries as any[]).length?(entries as any[]).map((e:any)=>(
                  <tr key={e.id} style={{cursor:'pointer',background:selectedEntry?.id===e.id?'rgba(201,162,39,.05)':''}} onClick={()=>setSelectedEntry(e)}>
                    <td className="mono" style={{color:'var(--t3)',fontSize:'.7rem'}}>{e.entryNumber}</td>
                    <td className="mono" style={{fontSize:'.75rem'}}>{new Date(e.date+'T12:00:00').toLocaleDateString()}</td>
                    <td style={{color:'var(--t0)',fontSize:'.78rem'}}>{e.description}</td>
                    <td className="mono">{formatCurrency(e.totalDebits)}</td>
                    <td><span className={`badge ${STATUS[e.status]||'bmu'}`}>{e.status}</span></td>
                  </tr>
                )):<tr><td colSpan={5}><div className="empty">No journal entries yet.</div></td></tr>}
              </tbody>
            </table>
          )}
        </div>

        <div>
          {!selectedEntry&&<div className="card" style={{textAlign:'center',padding:'48px 20px',color:'var(--t3)'}}>Select an entry to view detail</div>}
          {selectedEntry&&entryDetail&&(
            <div className="card">
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',marginBottom:16}}>
                <div>
                  <div style={{fontFamily:'var(--font-d)',fontWeight:700,color:'var(--t0)',marginBottom:4}}>Entry #{entryDetail.entryNumber}</div>
                  <div style={{fontSize:'.72rem',color:'var(--t3)'}}>{new Date(entryDetail.date+'T12:00:00').toLocaleDateString()} · {entryDetail.type}</div>
                  <div style={{fontSize:'.82rem',color:'var(--t1)',marginTop:4}}>{entryDetail.description}</div>
                  {entryDetail.reference&&<div style={{fontSize:'.7rem',color:'var(--t3)',marginTop:2}}>Ref: {entryDetail.reference}</div>}
                </div>
                <span className={`badge ${STATUS[entryDetail.status]||'bmu'}`}>{entryDetail.status}</span>
              </div>
              <table className="tbl" style={{marginBottom:12}}>
                <thead><tr><th>Account</th><th>Description</th><th style={{textAlign:'right'}}>Debit</th><th style={{textAlign:'right'}}>Credit</th></tr></thead>
                <tbody>
                  {entryDetail.lines?.map((l:any)=>(
                    <tr key={l.id}>
                      <td><div style={{fontWeight:600,color:'var(--t0)',fontSize:'.75rem'}}>{l.code} · {l.accountName}</div></td>
                      <td style={{fontSize:'.72rem',color:'var(--t3)'}}>{l.description||'—'}</td>
                      <td className="mono" style={{textAlign:'right',color:+l.debit>0?'var(--t0)':'var(--t3)'}}>{+l.debit>0?formatCurrency(l.debit):'—'}</td>
                      <td className="mono" style={{textAlign:'right',color:+l.credit>0?'var(--t0)':'var(--t3)'}}>{+l.credit>0?formatCurrency(l.credit):'—'}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr style={{background:'var(--bg3)'}}>
                    <td colSpan={2} style={{padding:'8px 12px',fontWeight:700,color:'var(--t0)',fontSize:'.72rem'}}>TOTALS</td>
                    <td className="mono" style={{textAlign:'right',fontWeight:700,padding:'8px 12px'}}>{formatCurrency(entryDetail.totalDebits)}</td>
                    <td className="mono" style={{textAlign:'right',fontWeight:700,padding:'8px 12px'}}>{formatCurrency(entryDetail.totalCredits)}</td>
                  </tr>
                </tfoot>
              </table>
              {entryDetail.status==='posted'&&<button className="btn bd bsm" onClick={()=>voidEntry(entryDetail.id)}>Void Entry</button>}
            </div>
          )}
        </div>
      </div>

      {showAdd&&(
        <Modal title="New Journal Entry" onClose={()=>setShowAdd(false)}>
          {err&&<div className="alert ae">{err}</div>}
          <form onSubmit={submit}>
            <div className="frow2">
              <div><label>Date</label><input type="date" value={form.date} onChange={e=>setForm(f=>({...f,date:e.target.value}))} required/></div>
              <div><label>Reference (optional)</label><input type="text" value={form.reference} onChange={e=>setForm(f=>({...f,reference:e.target.value}))} placeholder="Invoice #, check #…"/></div>
            </div>
            <div className="frow"><label>Description</label><input type="text" value={form.description} onChange={e=>setForm(f=>({...f,description:e.target.value}))} required placeholder="e.g. Record rent income for April"/></div>

            <div style={{marginBottom:10}}>
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:8}}>
                <label style={{marginBottom:0}}>Lines</label>
                <button type="button" className="btn bg-btn bsm" onClick={addLine}>+ Add Line</button>
              </div>
              <table style={{width:'100%',borderCollapse:'collapse',fontSize:'.75rem'}}>
                <thead><tr>
                  <th style={{textAlign:'left',padding:'4px 6px',color:'var(--t3)',fontWeight:600,fontSize:'.65rem',textTransform:'uppercase'}}>Account</th>
                  <th style={{textAlign:'left',padding:'4px 6px',color:'var(--t3)',fontWeight:600,fontSize:'.65rem',textTransform:'uppercase'}}>Note</th>
                  <th style={{textAlign:'right',padding:'4px 6px',color:'var(--t3)',fontWeight:600,fontSize:'.65rem',textTransform:'uppercase'}}>Debit</th>
                  <th style={{textAlign:'right',padding:'4px 6px',color:'var(--t3)',fontWeight:600,fontSize:'.65rem',textTransform:'uppercase'}}>Credit</th>
                  <th></th>
                </tr></thead>
                <tbody>
                  {form.lines.map((line,i)=>(
                    <tr key={i}>
                      <td style={{padding:'3px 4px'}}>
                        <select value={line.accountId} onChange={e=>updateLine(i,'accountId',e.target.value)} style={{width:'100%',fontSize:'.72rem',padding:'5px 6px'}}>
                          <option value="">Select…</option>
                          {[['Assets',assetAccts],['Liabilities',liabAccts],['Equity',equityAccts],['Income',incomeAccts],['Expenses',expenseAccts]].map(([label,grp]:any)=>
                            (grp as any[]).length>0&&<optgroup key={label} label={label}>{(grp as any[]).map((a:any)=><option key={a.id} value={a.id}>{a.code} · {a.name}</option>)}</optgroup>
                          )}
                        </select>
                      </td>
                      <td style={{padding:'3px 4px'}}><input type="text" value={line.description} onChange={e=>updateLine(i,'description',e.target.value)} placeholder="optional" style={{fontSize:'.72rem',padding:'5px 6px'}}/></td>
                      <td style={{padding:'3px 4px'}}><input type="number" min="0" step="0.01" value={line.debit} onChange={e=>updateLine(i,'debit',e.target.value)} style={{textAlign:'right',fontSize:'.72rem',padding:'5px 6px',width:90}}/></td>
                      <td style={{padding:'3px 4px'}}><input type="number" min="0" step="0.01" value={line.credit} onChange={e=>updateLine(i,'credit',e.target.value)} style={{textAlign:'right',fontSize:'.72rem',padding:'5px 6px',width:90}}/></td>
                      <td style={{padding:'3px 4px'}}>{form.lines.length>2&&<button type="button" onClick={()=>removeLine(i)} style={{background:'none',border:'none',color:'var(--red)',cursor:'pointer',fontSize:'.9rem'}}>✕</button>}</td>
                    </tr>
                  ))}
                  <tr style={{background:'var(--bg3)'}}>
                    <td colSpan={2} style={{padding:'6px 8px',fontSize:'.72rem',color:'var(--t3)',fontWeight:600}}>TOTALS</td>
                    <td style={{padding:'6px 8px',textAlign:'right',fontFamily:'var(--font-m)',fontSize:'.78rem',color:balanced?'var(--green)':'var(--amber)'}}>{formatCurrency(totalDebits)}</td>
                    <td style={{padding:'6px 8px',textAlign:'right',fontFamily:'var(--font-m)',fontSize:'.78rem',color:balanced?'var(--green)':'var(--amber)'}}>{formatCurrency(totalCredits)}</td>
                    <td/>
                  </tr>
                </tbody>
              </table>
              {!balanced&&totalDebits>0&&<div style={{fontSize:'.72rem',color:'var(--amber)',marginTop:6}}>⚠ Entry out of balance by {formatCurrency(Math.abs(totalDebits-totalCredits))}</div>}
              {balanced&&<div style={{fontSize:'.72rem',color:'var(--green)',marginTop:6}}>✓ Entry is balanced</div>}
            </div>

            <div className="factions">
              <button type="button" className="btn bg-btn" onClick={()=>setShowAdd(false)}>Cancel</button>
              <button type="submit" className="btn bp" disabled={saving||!balanced}>{saving?<><span className="spinner"/>Posting…</>:'Post Entry'}</button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  )
}

// ── TRANSACTIONS ──────────────────────────────────────────────────────
function Transactions(){
  const qc=useQueryClient()
  const{data:txs=[],isLoading}=useQuery('txs',()=>get<any[]>('/books/transactions'))
  const{data:accounts=[]}=useQuery('acct',()=>get<any[]>('/books/accounts'))
  const[tab,setTab]=useState<'all'|'income'|'expense'>('all')
  const[showAdd,setShowAdd]=useState(false)
  const[err,setErr]=useState('')
  const[saving,setSaving]=useState(false)
  const init={date:new Date().toISOString().split('T')[0],description:'',amount:'',type:'expense',category:'',accountId:'',reference:''}
  const[form,setForm]=useState(init)
  const f=(k:string)=>(e:React.ChangeEvent<HTMLInputElement|HTMLSelectElement>)=>setForm(p=>({...p,[k]:e.target.value}))

  const filtered=tab==='all'?(txs as any[]):(txs as any[]).filter((t:any)=>t.type===tab)
  const totalIncome=(txs as any[]).filter((t:any)=>t.type==='income').reduce((s:number,t:any)=>s+(+t.amount),0)
  const totalExpense=(txs as any[]).filter((t:any)=>t.type==='expense').reduce((s:number,t:any)=>s+(+t.amount),0)
  const unreconciled=(txs as any[]).filter((t:any)=>!t.reconciled).length

  const add=async(e:React.FormEvent)=>{
    e.preventDefault();setSaving(true);setErr('')
    try{
      await post('/books/transactions',{...form,amount:+form.amount})
      qc.invalidateQueries('txs');setShowAdd(false);setForm(init)
    }catch(ex:any){setErr(ex.response?.data?.error||'Failed')}
    finally{setSaving(false)}
  }

  const reconcile=async(id:string)=>{
    await patch('/books/transactions/'+id+'/reconcile')
    qc.invalidateQueries('txs')
  }

  return(
    <div>
      <div className="ph">
        <div><h1 className="pt">💳 Transactions</h1><p className="ps">{(txs as any[]).length} transactions · {unreconciled} unreconciled</p></div>
        <button className="btn bp" onClick={()=>setShowAdd(true)}>+ Add Transaction</button>
      </div>

      <div className="grid4" style={{marginBottom:16}}>
        <div className="kpi"><div className="kl">Total Income</div><div className="kv g">{formatCurrency(totalIncome)}</div><div className="ks">{(txs as any[]).filter((t:any)=>t.type==='income').length} transactions</div></div>
        <div className="kpi"><div className="kl">Total Expenses</div><div className="kv r">{formatCurrency(totalExpense)}</div><div className="ks">{(txs as any[]).filter((t:any)=>t.type==='expense').length} transactions</div></div>
        <div className="kpi"><div className="kl">Net</div><div className={`kv ${totalIncome-totalExpense>=0?'g':'r'}`}>{formatCurrency(totalIncome-totalExpense)}</div><div className="ks">Income minus expenses</div></div>
        <div className="kpi"><div className="kl">Unreconciled</div><div className={`kv ${unreconciled>0?'a':'g'}`}>{unreconciled}</div><div className="ks">Pending reconciliation</div></div>
      </div>

      <div className="tabs">
        <button className={`tab ${tab==='all'?'on':''}`} onClick={()=>setTab('all')}>All ({(txs as any[]).length})</button>
        <button className={`tab ${tab==='income'?'on':''}`} onClick={()=>setTab('income')}>Income ({(txs as any[]).filter((t:any)=>t.type==='income').length})</button>
        <button className={`tab ${tab==='expense'?'on':''}`} onClick={()=>setTab('expense')}>Expenses ({(txs as any[]).filter((t:any)=>t.type==='expense').length})</button>
      </div>

      <div className="card" style={{padding:0}}>
        {isLoading?<div style={{padding:32,color:'var(--t3)',textAlign:'center'}}><span className="spinner" style={{display:'inline-block'}}/></div>:(
          <table className="tbl">
            <thead><tr><th>Date</th><th>Description</th><th>Category</th><th>Account</th><th>Amount</th><th>Type</th><th>Reconciled</th></tr></thead>
            <tbody>
              {(filtered as any[]).length?(filtered as any[]).map((t:any)=>(
                <tr key={t.id}>
                  <td className="mono" style={{fontSize:'.72rem'}}>{new Date(t.date+'T12:00:00').toLocaleDateString()}</td>
                  <td style={{color:'var(--t0)',fontSize:'.78rem'}}>{t.description}</td>
                  <td style={{fontSize:'.72rem',color:'var(--t2)'}}>{t.category||'—'}</td>
                  <td style={{fontSize:'.72rem',color:'var(--t3)'}}>{t.accountName?t.code+' · '+t.accountName:'—'}</td>
                  <td className="mono" style={{color:t.type==='income'?'var(--green)':'var(--red)',fontWeight:600}}>{t.type==='income'?'+':'-'}{formatCurrency(t.amount)}</td>
                  <td><span className={t.type==='income'?'badge bg2':'badge br'}>{t.type}</span></td>
                  <td>{t.reconciled?<span className="badge bg2">✓</span>:<button className="btn bg-btn bsm" onClick={()=>reconcile(t.id)}>Mark</button>}</td>
                </tr>
              )):<tr><td colSpan={7}><div className="empty">No transactions yet.</div></td></tr>}
            </tbody>
          </table>
        )}
      </div>

      {showAdd&&(
        <Modal title="Add Transaction" onClose={()=>setShowAdd(false)}>
          {err&&<div className="alert ae">{err}</div>}
          <form onSubmit={add}>
            <div className="frow2">
              <div><label>Date</label><input type="date" value={form.date} onChange={f('date')} required/></div>
              <div><label>Type</label>
                <select value={form.type} onChange={f('type')}>
                  <option value="income">Income</option>
                  <option value="expense">Expense</option>
                </select>
              </div>
            </div>
            <div className="frow"><label>Description</label><input type="text" value={form.description} onChange={f('description')} required/></div>
            <div className="frow2">
              <div><label>Amount</label><input type="number" min="0" step="0.01" value={form.amount} onChange={f('amount')} required/></div>
              <div><label>Category</label><input type="text" value={form.category} onChange={f('category')} placeholder="e.g. Repairs, Rent"/></div>
            </div>
            <div className="frow"><label>Account</label>
              <select value={form.accountId} onChange={f('accountId')}>
                <option value="">— Uncategorized —</option>
                {(accounts as any[]).map((a:any)=><option key={a.id} value={a.id}>{a.code} · {a.name}</option>)}
              </select>
            </div>
            <div className="frow"><label>Reference (optional)</label><input type="text" value={form.reference} onChange={f('reference')} placeholder="Check #, invoice #…"/></div>
            <div className="factions">
              <button type="button" className="btn bg-btn" onClick={()=>setShowAdd(false)}>Cancel</button>
              <button type="submit" className="btn bp" disabled={saving}>{saving?<><span className="spinner"/>Saving…</>:'Add Transaction'}</button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  )
}

// ── BANK RECONCILE ────────────────────────────────────────────────────
function BankReconcile(){
  const{data:txs=[],isLoading}=useQuery('txs-unrec',()=>get<any[]>('/books/transactions?reconciled=false'))
  const{data:accounts=[]}=useQuery('acct',()=>get<any[]>('/books/accounts'))
  const[statementBal,setStatementBal]=useState('')
  const[selectedAcct,setSelectedAcct]=useState('')
  const qc=useQueryClient()
  const bankAccts=(accounts as any[]).filter((a:any)=>a.subtype==='bank')
  const unrecTxs=txs as any[]
  const bookBal=unrecTxs.reduce((s:number,t:any)=>s+(t.type==='income'?+t.amount:-+t.amount),0)
  const diff=(+statementBal||0)-bookBal

  const reconcile=async(id:string)=>{
    await patch('/books/transactions/'+id+'/reconcile')
    qc.invalidateQueries('txs-unrec')
  }

  return(
    <div>
      <div className="ph"><div><h1 className="pt">🏦 Bank Reconciliation</h1><p className="ps">{unrecTxs.length} unreconciled transactions</p></div></div>

      <div className="grid2" style={{marginBottom:16}}>
        <div className="card">
          <div className="ct">Reconciliation Setup</div>
          <div className="frow"><label>Bank Account</label>
            <select value={selectedAcct} onChange={e=>setSelectedAcct(e.target.value)}>
              <option value="">Select bank account…</option>
              {bankAccts.map((a:any)=><option key={a.id} value={a.id}>{a.code} · {a.name}</option>)}
            </select>
          </div>
          <div className="frow"><label>Statement Ending Balance</label><input type="number" step="0.01" value={statementBal} onChange={e=>setStatementBal(e.target.value)} placeholder="0.00"/></div>
        </div>
        <div className="card">
          <div className="ct">Balance Summary</div>
          <div className="dr"><span className="dk">Statement balance</span><span className="dv mono">{formatCurrency(+statementBal||0)}</span></div>
          <div className="dr"><span className="dk">Book balance (unreconciled)</span><span className="dv mono">{formatCurrency(bookBal)}</span></div>
          <div className="dr" style={{borderTop:'1px solid var(--b1)',marginTop:4,paddingTop:8}}>
            <span className="dk" style={{fontWeight:700}}>Difference</span>
            <span style={{color:Math.abs(diff)<0.01?'var(--green)':'var(--red)',fontWeight:700,fontFamily:'var(--font-m)'}}>{formatCurrency(diff)}</span>
          </div>
          {Math.abs(diff)<0.01&&statementBal&&<div style={{marginTop:10}}><span className="badge bg2">✓ Reconciled</span></div>}
        </div>
      </div>

      <div className="card" style={{padding:0}}>
        <div style={{padding:'12px 16px',borderBottom:'1px solid var(--b1)',display:'flex',justifyContent:'space-between',alignItems:'center'}}>
          <div className="ct" style={{marginBottom:0}}>Unreconciled Transactions</div>
          <span style={{fontSize:'.72rem',color:'var(--t3)'}}>Click to mark reconciled</span>
        </div>
        {isLoading?<div style={{padding:32,color:'var(--t3)',textAlign:'center'}}><span className="spinner" style={{display:'inline-block'}}/></div>:(
          <table className="tbl">
            <thead><tr><th>Date</th><th>Description</th><th>Type</th><th>Amount</th><th></th></tr></thead>
            <tbody>
              {unrecTxs.length?unrecTxs.map((t:any)=>(
                <tr key={t.id}>
                  <td className="mono" style={{fontSize:'.72rem'}}>{new Date(t.date+'T12:00:00').toLocaleDateString()}</td>
                  <td style={{fontSize:'.78rem',color:'var(--t0)'}}>{t.description}</td>
                  <td><span className={`badge ${t.type==='income'?'bg2':'br'}`}>{t.type}</span></td>
                  <td className="mono" style={{color:t.type==='income'?'var(--green)':'var(--red)'}}>{t.type==='income'?'+':'-'}{formatCurrency(t.amount)}</td>
                  <td><button className="btn bg-btn bsm" onClick={()=>reconcile(t.id)}>✓ Reconcile</button></td>
                </tr>
              )):<tr><td colSpan={5}><div className="empty">All transactions reconciled! 🎉</div></td></tr>}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}


// ── BILLS & AP ────────────────────────────────────────────────────────
function BillsAP(){
  const qc=useQueryClient()
  const{data:bills=[],isLoading}=useQuery('bills',()=>get<any[]>('/books/bills'))
  const{data:vendors=[]}=useQuery('ven',()=>get<any[]>('/books/vendors'))
  const{data:accounts=[]}=useQuery('acct',()=>get<any[]>('/books/accounts'))
  const[tab,setTab]=useState<'open'|'paid'|'all'>('open')
  const[showAdd,setShowAdd]=useState(false)
  const[err,setErr]=useState('')
  const[saving,setSaving]=useState(false)
  const init={vendorId:'',billNumber:'',date:new Date().toISOString().split('T')[0],dueDate:'',description:'',amount:'',category:'',accountId:'',notes:''}
  const[form,setForm]=useState(init)
  const f=(k:string)=>(e:React.ChangeEvent<HTMLInputElement|HTMLSelectElement|HTMLTextAreaElement>)=>setForm(p=>({...p,[k]:e.target.value}))

  const filtered=tab==='all'?(bills as any[]):(bills as any[]).filter((b:any)=>tab==='open'?b.status==='open'||b.status==='partial':b.status==='paid')
  const totalOpen=(bills as any[]).filter((b:any)=>b.status==='open'||b.status==='partial').reduce((s:number,b:any)=>s+(+b.amount-+b.amountPaid),0)
  const overdue=(bills as any[]).filter((b:any)=>b.dueDate&&new Date(b.dueDate)<new Date()&&b.status!=='paid')

  const add=async(e:React.FormEvent)=>{
    e.preventDefault();setSaving(true);setErr('')
    try{
      await post('/books/bills',{...form,amount:+form.amount})
      qc.invalidateQueries('bills');qc.invalidateQueries('ven')
      setShowAdd(false);setForm(init)
    }catch(ex:any){setErr(ex.response?.data?.error||'Failed')}
    finally{setSaving(false)}
  }

  const payBill=async(id:string,amount:number)=>{
    await post('/books/bills/'+id+'/pay',{amount})
    qc.invalidateQueries('bills');qc.invalidateQueries('ven')
  }

  const STATUS:Record<string,string>={open:'ba',partial:'bb',paid:'bg2',void:'bmu'}
  const expenseAccts=(accounts as any[]).filter((a:any)=>a.type==='expense')

  return(
    <div>
      <div className="ph">
        <div><h1 className="pt">📄 Bills & AP</h1><p className="ps">{(bills as any[]).length} bills · {formatCurrency(totalOpen)} outstanding</p></div>
        <button className="btn bp" onClick={()=>setShowAdd(true)}>+ Add Bill</button>
      </div>

      {overdue.length>0&&<div className="alert ae">⚠ {overdue.length} bill{overdue.length!==1?'s':''} overdue. Review and pay to avoid late fees.</div>}

      <div className="grid4" style={{marginBottom:16}}>
        <div className="kpi"><div className="kl">Open Bills</div><div className="kv a">{(bills as any[]).filter((b:any)=>b.status==='open').length}</div><div className="ks">Awaiting payment</div></div>
        <div className="kpi"><div className="kl">Total Outstanding</div><div className="kv r">{formatCurrency(totalOpen)}</div><div className="ks">AP balance</div></div>
        <div className="kpi"><div className="kl">Overdue</div><div className={`kv ${overdue.length>0?'r':'g'}`}>{overdue.length}</div><div className="ks">Past due date</div></div>
        <div className="kpi"><div className="kl">Paid This Month</div><div className="kv g">{formatCurrency((bills as any[]).filter((b:any)=>b.status==='paid'&&b.paidAt&&new Date(b.paidAt)>=new Date(new Date().getFullYear(),new Date().getMonth(),1)).reduce((s:number,b:any)=>s+(+b.amountPaid),0))}</div><div className="ks">Cleared bills</div></div>
      </div>

      <div className="tabs">
        <button className={`tab ${tab==='open'?'on':''}`} onClick={()=>setTab('open')}>Open ({(bills as any[]).filter((b:any)=>b.status==='open'||b.status==='partial').length})</button>
        <button className={`tab ${tab==='paid'?'on':''}`} onClick={()=>setTab('paid')}>Paid ({(bills as any[]).filter((b:any)=>b.status==='paid').length})</button>
        <button className={`tab ${tab==='all'?'on':''}`} onClick={()=>setTab('all')}>All ({(bills as any[]).length})</button>
      </div>

      <div className="card" style={{padding:0}}>
        {isLoading?<div style={{padding:32,color:'var(--t3)',textAlign:'center'}}><span className="spinner" style={{display:'inline-block'}}/></div>:(
          <table className="tbl">
            <thead><tr><th>Date</th><th>Vendor</th><th>Description</th><th>Due</th><th>Amount</th><th>Paid</th><th>Balance</th><th>Status</th><th></th></tr></thead>
            <tbody>
              {(filtered as any[]).length?(filtered as any[]).map((b:any)=>{
                const isOverdue=b.dueDate&&new Date(b.dueDate)<new Date()&&b.status!=='paid'
                return(
                  <tr key={b.id} style={{background:isOverdue?'rgba(239,68,68,.03)':''}}>
                    <td className="mono" style={{fontSize:'.72rem'}}>{new Date(b.date+'T12:00:00').toLocaleDateString()}</td>
                    <td style={{fontSize:'.75rem',color:'var(--t0)'}}>{b.vendorName||'—'}</td>
                    <td style={{fontSize:'.78rem'}}>{b.description}</td>
                    <td className="mono" style={{fontSize:'.72rem',color:isOverdue?'var(--red)':'var(--t3)'}}>{b.dueDate?new Date(b.dueDate+'T12:00:00').toLocaleDateString():'—'}{isOverdue&&' ⚠'}</td>
                    <td className="mono">{formatCurrency(b.amount)}</td>
                    <td className="mono" style={{color:'var(--green)'}}>{+b.amountPaid>0?formatCurrency(b.amountPaid):'—'}</td>
                    <td className="mono" style={{color:'var(--red)',fontWeight:600}}>{formatCurrency(+b.amount-+b.amountPaid)}</td>
                    <td><span className={`badge ${STATUS[b.status]||'bmu'}`}>{b.status}</span></td>
                    <td>{b.status!=='paid'&&<button className="btn bp bsm" onClick={()=>payBill(b.id,+b.amount-+b.amountPaid)}>Pay Full</button>}</td>
                  </tr>
                )
              }):<tr><td colSpan={9}><div className="empty">No {tab==='open'?'open ':''}bills.</div></td></tr>}
            </tbody>
          </table>
        )}
      </div>

      {showAdd&&(
        <Modal title="Add Bill" onClose={()=>setShowAdd(false)}>
          {err&&<div className="alert ae">{err}</div>}
          <form onSubmit={add}>
            <div className="frow"><label>Vendor</label>
              <select value={form.vendorId} onChange={f('vendorId')}>
                <option value="">— No vendor —</option>
                {(vendors as any[]).map((v:any)=><option key={v.id} value={v.id}>{v.name}</option>)}
              </select>
            </div>
            <div className="frow2">
              <div><label>Bill Date</label><input type="date" value={form.date} onChange={f('date')} required/></div>
              <div><label>Due Date</label><input type="date" value={form.dueDate} onChange={f('dueDate')}/></div>
            </div>
            <div className="frow"><label>Description</label><input type="text" value={form.description} onChange={f('description')} required placeholder="e.g. APS Electric — March"/></div>
            <div className="frow2">
              <div><label>Amount</label><input type="number" min="0" step="0.01" value={form.amount} onChange={f('amount')} required/></div>
              <div><label>Bill # (optional)</label><input type="text" value={form.billNumber} onChange={f('billNumber')}/></div>
            </div>
            <div className="frow"><label>Expense Account</label>
              <select value={form.accountId} onChange={f('accountId')}>
                <option value="">— Uncategorized —</option>
                {expenseAccts.map((a:any)=><option key={a.id} value={a.id}>{a.code} · {a.name}</option>)}
              </select>
            </div>
            <div className="frow"><label>Notes</label><textarea rows={2} value={form.notes} onChange={f('notes')}/></div>
            <div className="factions">
              <button type="button" className="btn bg-btn" onClick={()=>setShowAdd(false)}>Cancel</button>
              <button type="submit" className="btn bp" disabled={saving}>{saving?<><span className="spinner"/>Saving…</>:'Add Bill'}</button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  )
}

// ── CASH FLOW ────────────────────────────────────────────────────────
function CashFlow(){
  const now=new Date()
  const[startDate,setStartDate]=useState(`${now.getFullYear()}-01-01`)
  const[endDate,setEndDate]=useState(now.toISOString().split('T')[0])
  const{data,isLoading}=useQuery(['cf',startDate,endDate],()=>get<any>(`/books/reports/cash-flow?startDate=${startDate}&endDate=${endDate}`))

  const op=(data as any)?.operating
  const fin=(data as any)?.financing
  const net=(data as any)?.netCashFlow||0

  return(
    <div>
      <div className="ph">
        <div><h1 className="pt">💧 Cash Flow Statement</h1><p className="ps">{new Date(startDate+'T12:00:00').toLocaleDateString()} – {new Date(endDate+'T12:00:00').toLocaleDateString()}</p></div>
        <div style={{display:'flex',gap:8,alignItems:'center'}}>
          <input type="date" value={startDate} onChange={e=>setStartDate(e.target.value)} style={{width:'auto',padding:'5px 8px',fontSize:'.75rem'}}/>
          <span style={{color:'var(--t3)'}}>to</span>
          <input type="date" value={endDate} onChange={e=>setEndDate(e.target.value)} style={{width:'auto',padding:'5px 8px',fontSize:'.75rem'}}/>
        </div>
      </div>

      <div className="grid4" style={{marginBottom:16}}>
        <div className="kpi"><div className="kl">Operating Inflows</div><div className="kv g">{formatCurrency(op?.inflows?.total||0)}</div><div className="ks">Rent + other income</div></div>
        <div className="kpi"><div className="kl">Operating Outflows</div><div className="kv r">{formatCurrency(op?.outflows?.total||0)}</div><div className="ks">Expenses + payroll + bills</div></div>
        <div className="kpi"><div className="kl">Financing Outflows</div><div className="kv a">{formatCurrency(fin?.total||0)}</div><div className="ks">Owner disbursements</div></div>
        <div className="kpi"><div className="kl">Net Cash Flow</div><div className={`kv ${net>=0?'g':'r'}`}>{formatCurrency(net)}</div><div className="ks">{net>=0?'Positive cash flow':'Negative cash flow'}</div></div>
      </div>

      {isLoading?<div style={{padding:32,color:'var(--t3)',textAlign:'center'}}><span className="spinner" style={{display:'inline-block'}}/></div>:(
        <div className="grid2">
          <div>
            <div className="card" style={{marginBottom:12}}>
              <div className="ct">Operating Activities</div>
              <div style={{marginBottom:10}}>
                <div style={{fontSize:'.72rem',fontWeight:700,color:'var(--t2)',marginBottom:6,textTransform:'uppercase',letterSpacing:'.06em'}}>Inflows</div>
                <div className="dr"><span className="dk">🏘 GAM Rent Collected</span><span className="dv mono" style={{color:'var(--green)'}}>{formatCurrency(op?.inflows?.rentCollected||0)}</span></div>
                <div className="dr"><span className="dk">Other Income</span><span className="dv mono" style={{color:'var(--green)'}}>{formatCurrency(op?.inflows?.otherIncome||0)}</span></div>
                <div className="dr" style={{borderTop:'1px solid var(--b1)',paddingTop:6,marginTop:4}}><span className="dk" style={{fontWeight:700}}>Total Inflows</span><span className="dv mono" style={{color:'var(--green)',fontWeight:700}}>{formatCurrency(op?.inflows?.total||0)}</span></div>
              </div>
              <div>
                <div style={{fontSize:'.72rem',fontWeight:700,color:'var(--t2)',marginBottom:6,textTransform:'uppercase',letterSpacing:'.06em'}}>Outflows</div>
                <div className="dr"><span className="dk">Expenses</span><span className="dv mono" style={{color:'var(--red)'}}>({formatCurrency(op?.outflows?.expenses||0)})</span></div>
                <div className="dr"><span className="dk">Payroll (net)</span><span className="dv mono" style={{color:'var(--red)'}}>({formatCurrency(op?.outflows?.payroll||0)})</span></div>
                <div className="dr"><span className="dk">Bills Paid</span><span className="dv mono" style={{color:'var(--red)'}}>({formatCurrency(op?.outflows?.bills||0)})</span></div>
                <div className="dr" style={{borderTop:'1px solid var(--b1)',paddingTop:6,marginTop:4}}><span className="dk" style={{fontWeight:700}}>Total Outflows</span><span className="dv mono" style={{color:'var(--red)',fontWeight:700}}>({formatCurrency(op?.outflows?.total||0)})</span></div>
              </div>
              <div className="dr" style={{borderTop:'2px solid var(--b1)',paddingTop:8,marginTop:8}}>
                <span style={{fontWeight:700,color:'var(--t0)',fontFamily:'var(--font-d)'}}>Net Operating Cash Flow</span>
                <span style={{fontFamily:'var(--font-m)',fontWeight:700,color:(op?.net||0)>=0?'var(--green)':'var(--red)',fontSize:'1rem'}}>{formatCurrency(op?.net||0)}</span>
              </div>
            </div>

            <div className="card">
              <div className="ct">Financing Activities</div>
              <div className="dr"><span className="dk">Owner Disbursements</span><span className="dv mono" style={{color:'var(--amber)'}}>({formatCurrency(fin?.disbursements||0)})</span></div>
              <div className="dr" style={{borderTop:'2px solid var(--b1)',paddingTop:8,marginTop:8}}>
                <span style={{fontWeight:700,color:'var(--t0)',fontFamily:'var(--font-d)'}}>Net Financing</span>
                <span style={{fontFamily:'var(--font-m)',fontWeight:700,color:'var(--amber)',fontSize:'1rem'}}>({formatCurrency(fin?.total||0)})</span>
              </div>
            </div>
          </div>

          <div className="card" style={{alignSelf:'start'}}>
            <div className="ct">Cash Flow Summary</div>
            <div className="dr"><span className="dk">Net Operating</span><span className="dv mono" style={{color:(op?.net||0)>=0?'var(--green)':'var(--red)'}}>{formatCurrency(op?.net||0)}</span></div>
            <div className="dr"><span className="dk">Net Financing</span><span className="dv mono" style={{color:'var(--amber)'}}>({formatCurrency(fin?.total||0)})</span></div>
            <div style={{borderTop:'2px solid var(--b1)',marginTop:12,paddingTop:12,display:'flex',justifyContent:'space-between',alignItems:'center'}}>
              <span style={{fontFamily:'var(--font-d)',fontWeight:800,fontSize:'1rem',color:'var(--t0)'}}>NET CASH FLOW</span>
              <span style={{fontFamily:'var(--font-d)',fontWeight:800,fontSize:'1.4rem',color:net>=0?'var(--green)':'var(--red)'}}>{formatCurrency(net)}</span>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ── OWNER STATEMENTS ─────────────────────────────────────────────────
function OwnerStatements(){
  const now=new Date()
  const[startDate,setStartDate]=useState(`${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-01`)
  const[endDate,setEndDate]=useState(now.toISOString().split('T')[0])
  const[selected,setSelected]=useState<any>(null)
  const{data:statements=[],isLoading}=useQuery(['owner-statements',startDate,endDate],()=>get<any[]>(`/books/reports/owner-statements?startDate=${startDate}&endDate=${endDate}`))

  return(
    <div>
      <div className="ph">
        <div><h1 className="pt">🏠 Owner Statements</h1><p className="ps">Per-property income statements</p></div>
        <div style={{display:'flex',gap:8,alignItems:'center'}}>
          <input type="date" value={startDate} onChange={e=>setStartDate(e.target.value)} style={{width:'auto',padding:'5px 8px',fontSize:'.75rem'}}/>
          <span style={{color:'var(--t3)'}}>to</span>
          <input type="date" value={endDate} onChange={e=>setEndDate(e.target.value)} style={{width:'auto',padding:'5px 8px',fontSize:'.75rem'}}/>
        </div>
      </div>

      {isLoading?<div style={{padding:32,color:'var(--t3)',textAlign:'center'}}><span className="spinner" style={{display:'inline-block'}}/></div>:(
        <div className="grid2" style={{gap:16}}>
          <div style={{display:'flex',flexDirection:'column',gap:12}}>
            {(statements as any[]).length?(statements as any[]).map((s:any)=>(
              <div key={s.landlord.id} className="card" style={{cursor:'pointer',borderColor:selected?.landlord?.id===s.landlord.id?'rgba(201,162,39,.4)':'var(--b1)'}} onClick={()=>setSelected(s)}>
                <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start'}}>
                  <div>
                    <div style={{fontWeight:700,color:'var(--t0)',fontFamily:'var(--font-d)'}}>{s.landlord.businessName||s.landlord.firstName+' '+s.landlord.lastName}</div>
                    <div style={{fontSize:'.72rem',color:'var(--t3)',marginTop:2}}>{s.landlord.email}</div>
                  </div>
                  <span className={s.variance>=0?'badge bg2':'badge br'}>{s.variance>=0?'✓ Collected':'⚠ Short'}</span>
                </div>
                <div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr',gap:12,marginTop:12}}>
                  <div><div style={{fontSize:'.65rem',color:'var(--t3)',textTransform:'uppercase',letterSpacing:'.06em'}}>Expected</div><div style={{fontFamily:'var(--font-m)',color:'var(--t0)',fontWeight:600}}>{formatCurrency(s.totalExpected)}</div></div>
                  <div><div style={{fontSize:'.65rem',color:'var(--t3)',textTransform:'uppercase',letterSpacing:'.06em'}}>Collected</div><div style={{fontFamily:'var(--font-m)',color:'var(--green)',fontWeight:600}}>{formatCurrency(s.totalCollected)}</div></div>
                  <div><div style={{fontSize:'.65rem',color:'var(--t3)',textTransform:'uppercase',letterSpacing:'.06em'}}>Disbursed</div><div style={{fontFamily:'var(--font-m)',color:'var(--gold)',fontWeight:600}}>{formatCurrency(s.totalDisbursed)}</div></div>
                </div>
              </div>
            )):<div className="card" style={{textAlign:'center',padding:'48px 20px',color:'var(--t3)'}}>No owner data for this period.</div>}
          </div>

          <div>
            {!selected&&<div className="card" style={{textAlign:'center',padding:'48px 20px',color:'var(--t3)'}}>Select an owner to view statement</div>}
            {selected&&(
              <div className="card">
                <div style={{marginBottom:16,paddingBottom:14,borderBottom:'1px solid var(--b0)'}}>
                  <div style={{fontFamily:'var(--font-d)',fontWeight:800,fontSize:'1.1rem',color:'var(--t0)'}}>{selected.landlord.businessName||selected.landlord.firstName+' '+selected.landlord.lastName}</div>
                  <div style={{fontSize:'.72rem',color:'var(--t3)',marginTop:2}}>{new Date(startDate+'T12:00:00').toLocaleDateString()} – {new Date(endDate+'T12:00:00').toLocaleDateString()}</div>
                </div>

                {selected.properties.map((p:any)=>(
                  <div key={p.id} style={{marginBottom:16,paddingBottom:14,borderBottom:'1px solid var(--b0)'}}>
                    <div style={{fontWeight:600,color:'var(--t0)',marginBottom:8}}>{p.name}</div>
                    <div className="dr"><span className="dk">Units</span><span className="dv mono">{p.occupied}/{p.unitCount} occupied</span></div>
                    <div className="dr"><span className="dk">Expected Rent</span><span className="dv mono">{formatCurrency(p.expectedRent)}</span></div>
                    <div className="dr"><span className="dk">Collected</span><span className="dv mono" style={{color:'var(--green)'}}>{formatCurrency(p.collected)}</span></div>
                    <div className="dr"><span className="dk">Variance</span><span className="dv mono" style={{color:(+p.collected-+p.expectedRent)>=0?'var(--green)':'var(--red)'}}>{formatCurrency(+p.collected-+p.expectedRent)}</span></div>
                  </div>
                ))}

                <div className="dr"><span className="dk" style={{fontWeight:700}}>Total Expected</span><span className="dv mono">{formatCurrency(selected.totalExpected)}</span></div>
                <div className="dr"><span className="dk" style={{fontWeight:700}}>Total Collected</span><span className="dv mono" style={{color:'var(--green)',fontWeight:700}}>{formatCurrency(selected.totalCollected)}</span></div>
                <div className="dr"><span className="dk" style={{fontWeight:700}}>Total Disbursed</span><span className="dv mono" style={{color:'var(--gold)',fontWeight:700}}>{formatCurrency(selected.totalDisbursed)}</span></div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

// ── TAX CENTER ────────────────────────────────────────────────────────
function TaxCenter(){
  const now=new Date()
  const[year,setYear]=useState(now.getFullYear())
  const{data,isLoading}=useQuery(['tax',year],()=>get<any>(`/books/tax/summary?year=${year}`))

  const payroll=(data as any)?.payroll||{}
  const contractors=(data as any)?.contractors1099||[]
  const employees=(data as any)?.employees||[]
  const deadlines=(data as any)?.filingDeadlines||[]

  return(
    <div>
      <div className="ph">
        <div><h1 className="pt">🏛 Tax Center</h1><p className="ps">Payroll tax liabilities and filing deadlines</p></div>
        <div style={{display:'flex',gap:8,alignItems:'center'}}>
          <label style={{marginBottom:0,textTransform:'none',letterSpacing:0,fontSize:'.82rem',color:'var(--t2)'}}>Tax Year</label>
          <select value={year} onChange={e=>setYear(+e.target.value)} style={{width:'auto',padding:'5px 10px',fontSize:'.82rem'}}>
            {[now.getFullYear(),now.getFullYear()-1,now.getFullYear()-2].map(y=><option key={y} value={y}>{y}</option>)}
          </select>
        </div>
      </div>

      <div className="grid4" style={{marginBottom:16}}>
        <div className="kpi"><div className="kl">YTD Gross Payroll</div><div className="kv gold">{formatCurrency(payroll.ytdGross||0)}</div><div className="ks">{payroll.runCount||0} approved runs</div></div>
        <div className="kpi"><div className="kl">Employee Tax W/H</div><div className="kv r">{formatCurrency((+payroll.ytdFederal||0)+(+payroll.ytdState||0)+(+payroll.ytdSs||0)+(+payroll.ytdMedicare||0))}</div><div className="ks">Fed + AZ + SS + Medicare</div></div>
        <div className="kpi"><div className="kl">Employer Tax Match</div><div className="kv a">{formatCurrency((+payroll.employerSs||0)+(+payroll.employerMedicare||0))}</div><div className="ks">SS + Medicare match</div></div>
        <div className="kpi"><div className="kl">Total Tax Liability</div><div className="kv r">{formatCurrency(payroll.totalTaxLiability||0)}</div><div className="ks">Employee + employer</div></div>
      </div>

      {isLoading?<div style={{padding:32,color:'var(--t3)',textAlign:'center'}}><span className="spinner" style={{display:'inline-block'}}/></div>:(
        <div className="grid2" style={{gap:16,marginBottom:16}}>
          <div className="card">
            <div className="ct">Payroll Tax Breakdown ({year})</div>
            <div className="dr"><span className="dk">Federal Income W/H (employee)</span><span className="dv mono" style={{color:'var(--red)'}}>{formatCurrency(payroll.ytdFederal||0)}</span></div>
            <div className="dr"><span className="dk">Social Security (employee 6.2%)</span><span className="dv mono" style={{color:'var(--amber)'}}>{formatCurrency(payroll.ytdSs||0)}</span></div>
            <div className="dr"><span className="dk">Medicare (employee 1.45%)</span><span className="dv mono" style={{color:'var(--amber)'}}>{formatCurrency(payroll.ytdMedicare||0)}</span></div>
            <div className="dr"><span className="dk">AZ State W/H (employee 2.5%)</span><span className="dv mono" style={{color:'var(--amber)'}}>{formatCurrency(payroll.ytdState||0)}</span></div>
            <div className="dr" style={{borderTop:'1px solid var(--b1)',paddingTop:6,marginTop:4}}><span className="dk">Employer SS match (6.2%)</span><span className="dv mono" style={{color:'var(--red)'}}>{formatCurrency(payroll.employerSs||0)}</span></div>
            <div className="dr"><span className="dk">Employer Medicare match (1.45%)</span><span className="dv mono" style={{color:'var(--red)'}}>{formatCurrency(payroll.employerMedicare||0)}</span></div>
            <div className="dr" style={{borderTop:'2px solid var(--b1)',paddingTop:8,marginTop:8}}>
              <span style={{fontWeight:700,color:'var(--t0)',fontFamily:'var(--font-d)'}}>Total Liability</span>
              <span style={{fontFamily:'var(--font-m)',fontWeight:700,color:'var(--red)',fontSize:'1rem'}}>{formatCurrency(payroll.totalTaxLiability||0)}</span>
            </div>
          </div>

          <div className="card">
            <div className="ct">Filing Deadlines</div>
            {deadlines.map((d:any)=>(
              <div key={d.form} style={{padding:'10px 0',borderBottom:'1px solid var(--b0)'}}>
                <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:4}}>
                  <span style={{fontFamily:'var(--font-m)',fontWeight:600,color:'var(--gold)',fontSize:'.82rem'}}>{d.form}</span>
                  {d.due&&<span className="badge ba">{d.due}</span>}
                </div>
                <div style={{fontSize:'.75rem',color:'var(--t2)',marginBottom:d.q1?6:0}}>{d.description}</div>
                {d.q1&&<div style={{display:'flex',gap:8,flexWrap:'wrap'}}>
                  {['Q1','Q2','Q3','Q4'].map((q,i)=><span key={q} className="badge bmu" style={{fontSize:'.62rem'}}>{q}: {[d.q1,d.q2,d.q3,d.q4][i]}</span>)}
                </div>}
              </div>
            ))}
          </div>
        </div>
      )}

      {(contractors as any[]).length>0&&(
        <div className="card" style={{marginBottom:16}}>
          <div className="ct">1099-NEC Required ({year}) — Contractors Paid $600+</div>
          {(contractors as any[]).filter((c:any)=>!c.w9OnFile).length>0&&(
            <div className="alert aw" style={{marginBottom:12}}>⚠ {(contractors as any[]).filter((c:any)=>!c.w9OnFile).length} contractor(s) missing W-9. Collect before Jan 31.</div>
          )}
          <table className="tbl">
            <thead><tr><th>Contractor</th><th>Entity</th><th>YTD Paid</th><th>W-9</th><th>1099 Status</th></tr></thead>
            <tbody>
              {(contractors as any[]).map((c:any)=>(
                <tr key={c.id}>
                  <td style={{fontWeight:600,color:'var(--t0)'}}>{c.businessName||[c.firstName,c.lastName].filter(Boolean).join(' ')}</td>
                  <td><span className="badge bmu">{c.entityType}</span></td>
                  <td className="mono" style={{color:'var(--amber)',fontWeight:600}}>{formatCurrency(c.ytdPaid)}</td>
                  <td>{c.w9OnFile?<span className="badge bg2">✓ On File</span>:<span className="badge br">Missing</span>}</td>
                  <td><span className={c.w9OnFile?'badge bg2':'badge ba'}>{c.w9OnFile?'Ready to File':'Needs W-9'}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {employees.length>0&&(
        <div className="card">
          <div className="ct">W-2 Employee YTD Summary ({year})</div>
          <table className="tbl">
            <thead><tr><th>Employee</th><th>YTD Gross</th><th>Federal W/H</th><th>AZ State</th><th>SS</th><th>Medicare</th><th>Net Pay</th></tr></thead>
            <tbody>
              {employees.map((e:any,i:number)=>(
                <tr key={i}>
                  <td style={{fontWeight:600,color:'var(--t0)'}}>{e.firstName} {e.lastName}</td>
                  <td className="mono" style={{color:'var(--gold)'}}>{formatCurrency(e.ytdGross)}</td>
                  <td className="mono" style={{color:'var(--red)'}}>{formatCurrency(e.ytdFederalTax)}</td>
                  <td className="mono" style={{color:'var(--amber)'}}>{formatCurrency(e.ytdStateTax)}</td>
                  <td className="mono" style={{color:'var(--amber)'}}>{formatCurrency(e.ytdSs)}</td>
                  <td className="mono" style={{color:'var(--amber)'}}>{formatCurrency(e.ytdMedicare)}</td>
                  <td className="mono" style={{color:'var(--green)',fontWeight:700}}>{formatCurrency(e.ytdNet)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

// ── RENT ROLL ─────────────────────────────────────────────────────────
function RentRoll(){
  const{data,isLoading}=useQuery('rent-roll',()=>get<any>('/books/rent-roll'))
  const units=(data as any)?.units||[]
  const occupied=units.filter((u:any)=>u.status!=='vacant')

  return(
    <div>
      <div className="ph">
        <div><h1 className="pt">🏘 Rent Roll</h1><p className="ps">Live sync from GAM · {units.length} units</p></div>
        <span className="badge bteal">Live Data</span>
      </div>

      <div className="grid4" style={{marginBottom:16}}>
        <div className="kpi"><div className="kl">Expected Rent (MTD)</div><div className="kv gold">{formatCurrency((data as any)?.totalExpected||0)}</div><div className="ks">{occupied.length} occupied units</div></div>
        <div className="kpi"><div className="kl">Collected (MTD)</div><div className="kv g">{formatCurrency((data as any)?.totalCollected||0)}</div><div className="ks">Settled payments</div></div>
        <div className="kpi"><div className="kl">Variance</div><div className={`kv ${((data as any)?.variance||0)>=0?'g':'r'}`}>{formatCurrency((data as any)?.variance||0)}</div><div className="ks">Collected minus expected</div></div>
        <div className="kpi"><div className="kl">Occupancy Rate</div><div className="kv b">{(((data as any)?.occupancyRate||0)*100).toFixed(0)}%</div><div className="ks">{occupied.length}/{units.length} units</div></div>
      </div>

      <div className="card" style={{padding:0}}>
        {isLoading?<div style={{padding:32,color:'var(--t3)',textAlign:'center'}}><span className="spinner" style={{display:'inline-block'}}/></div>:(
          <table className="tbl">
            <thead><tr><th>Unit</th><th>Property</th><th>Tenant</th><th>Rent</th><th>Collected MTD</th><th>Variance</th><th>Status</th><th>ACH</th><th>OTP</th></tr></thead>
            <tbody>
              {units.length?units.map((u:any)=>{
                const variance=(+u.collectedMtd||0)-(u.status!=='vacant'?+u.rentAmount:0)
                return(
                  <tr key={u.unitNumber+u.propertyName}>
                    <td className="mono" style={{fontWeight:600,color:'var(--t0)'}}>{u.unitNumber}</td>
                    <td style={{fontSize:'.75rem'}}>{u.propertyName}</td>
                    <td style={{fontSize:'.75rem'}}>{u.tenantFirst?u.tenantFirst+' '+u.tenantLast:<span style={{color:'var(--t3)'}}>Vacant</span>}</td>
                    <td className="mono">{formatCurrency(u.rentAmount)}</td>
                    <td className="mono" style={{color:'var(--green)'}}>{+u.collectedMtd>0?formatCurrency(u.collectedMtd):'—'}</td>
                    <td className="mono" style={{color:variance>=0?'var(--green)':'var(--red)'}}>{u.status!=='vacant'?formatCurrency(variance):'—'}</td>
                    <td><span className={`badge ${u.status==='active'?'bg2':u.status==='delinquent'?'ba':u.status==='vacant'?'bmu':'br'}`}>{u.status}</span></td>
                    <td>{u.achVerified?<span className="badge bg2">✓</span>:<span style={{color:'var(--t3)'}}>—</span>}</td>
                    <td>{u.onTimePayEnrolled?<span className="badge bgold">OTP</span>:<span style={{color:'var(--t3)'}}>—</span>}</td>
                  </tr>
                )
              }):<tr><td colSpan={9}><div className="empty">No units found.</div></td></tr>}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}

// ── P&L REPORT ────────────────────────────────────────────────────────
function ProfitLoss(){
  const now=new Date()
  const[startDate,setStartDate]=useState(`${now.getFullYear()}-01-01`)
  const[endDate,setEndDate]=useState(now.toISOString().split('T')[0])
  const{data,isLoading,refetch}=useQuery(['pl',startDate,endDate],()=>get<any>(`/books/reports/pl?startDate=${startDate}&endDate=${endDate}`))

  const income=(data as any)?.income||[]
  const expenses=(data as any)?.expenses||[]
  const totalIncome=(data as any)?.totalIncome||0
  const totalExpenses=(data as any)?.totalExpenses||0
  const netIncome=(data as any)?.netIncome||0
  const gamRent=(data as any)?.gamRentIncome||0

  return(
    <div>
      <div className="ph">
        <div><h1 className="pt">📈 Profit & Loss</h1><p className="ps">Income statement · {new Date(startDate+'T12:00:00').toLocaleDateString()} – {new Date(endDate+'T12:00:00').toLocaleDateString()}</p></div>
        <div style={{display:'flex',gap:8,alignItems:'center'}}>
          <input type="date" value={startDate} onChange={e=>setStartDate(e.target.value)} style={{width:'auto',padding:'5px 8px',fontSize:'.75rem'}}/>
          <span style={{color:'var(--t3)'}}>to</span>
          <input type="date" value={endDate} onChange={e=>setEndDate(e.target.value)} style={{width:'auto',padding:'5px 8px',fontSize:'.75rem'}}/>
        </div>
      </div>

      <div className="grid4" style={{marginBottom:16}}>
        <div className="kpi"><div className="kl">Total Income</div><div className="kv g">{formatCurrency(totalIncome)}</div><div className="ks">{income.length} income accounts</div></div>
        <div className="kpi"><div className="kl">GAM Rent (synced)</div><div className="kv gold">{formatCurrency(gamRent)}</div><div className="ks">Settled payments from GAM</div></div>
        <div className="kpi"><div className="kl">Total Expenses</div><div className="kv r">{formatCurrency(totalExpenses)}</div><div className="ks">{expenses.length} expense accounts</div></div>
        <div className="kpi"><div className="kl">Net Income</div><div className={`kv ${netIncome>=0?'g':'r'}`}>{formatCurrency(netIncome)}</div><div className="ks">{netIncome>=0?'Profitable':'Loss'}</div></div>
      </div>

      {isLoading?<div style={{padding:32,color:'var(--t3)',textAlign:'center'}}><span className="spinner" style={{display:'inline-block'}}/></div>:(
        <div className="grid2">
          <div>
            <div className="card" style={{marginBottom:12}}>
              <div className="ct">Income</div>
              {gamRent>0&&<div className="dr"><span className="dk" style={{color:'var(--teal)'}}>🏘 GAM Rent Income (synced)</span><span className="dv mono" style={{color:'var(--teal)'}}>{formatCurrency(gamRent)}</span></div>}
              {income.map((a:any)=>(
                <div key={a.code} className="dr">
                  <span className="dk">{a.code} · {a.name}</span>
                  <span className="dv mono" style={{color:'var(--green)'}}>{formatCurrency(a.periodAmount)}</span>
                </div>
              ))}
              {income.length===0&&!gamRent&&<div style={{color:'var(--t3)',fontSize:'.78rem',padding:'8px 0'}}>No income recorded. Post journal entries or transactions.</div>}
              <div className="dr" style={{borderTop:'2px solid var(--b1)',marginTop:8,paddingTop:8}}>
                <span style={{fontWeight:700,color:'var(--t0)',fontFamily:'var(--font-d)'}}>Total Income</span>
                <span style={{fontFamily:'var(--font-m)',fontWeight:700,color:'var(--green)',fontSize:'1rem'}}>{formatCurrency(totalIncome)}</span>
              </div>
            </div>

            <div className="card">
              <div className="ct">Expenses</div>
              {expenses.map((a:any)=>(
                <div key={a.code} className="dr">
                  <span className="dk">{a.code} · {a.name}</span>
                  <span className="dv mono" style={{color:'var(--red)'}}>{formatCurrency(a.periodAmount)}</span>
                </div>
              ))}
              {expenses.length===0&&<div style={{color:'var(--t3)',fontSize:'.78rem',padding:'8px 0'}}>No expenses recorded.</div>}
              <div className="dr" style={{borderTop:'2px solid var(--b1)',marginTop:8,paddingTop:8}}>
                <span style={{fontWeight:700,color:'var(--t0)',fontFamily:'var(--font-d)'}}>Total Expenses</span>
                <span style={{fontFamily:'var(--font-m)',fontWeight:700,color:'var(--red)',fontSize:'1rem'}}>{formatCurrency(totalExpenses)}</span>
              </div>
            </div>
          </div>

          <div className="card" style={{alignSelf:'start'}}>
            <div className="ct">Net Income Summary</div>
            <div className="dr"><span className="dk">Total Income</span><span className="dv mono" style={{color:'var(--green)'}}>{formatCurrency(totalIncome)}</span></div>
            <div className="dr"><span className="dk">Total Expenses</span><span className="dv mono" style={{color:'var(--red)'}}>({formatCurrency(totalExpenses)})</span></div>
            <div style={{borderTop:'2px solid var(--b1)',marginTop:12,paddingTop:12,display:'flex',justifyContent:'space-between',alignItems:'center'}}>
              <span style={{fontFamily:'var(--font-d)',fontWeight:800,fontSize:'1rem',color:'var(--t0)'}}>NET INCOME</span>
              <span style={{fontFamily:'var(--font-d)',fontWeight:800,fontSize:'1.4rem',color:netIncome>=0?'var(--green)':'var(--red)'}}>{formatCurrency(netIncome)}</span>
            </div>
            <div style={{marginTop:16,padding:'12px',background:'var(--bg3)',borderRadius:8,fontSize:'.72rem',color:'var(--t3)',lineHeight:1.6}}>
              <strong style={{color:'var(--t2)'}}>Note:</strong> This P&L reflects journal entries posted to income/expense accounts plus GAM rent payments. Add transactions and journal entries to build a complete picture.
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ── BALANCE SHEET ─────────────────────────────────────────────────────
function BalanceSheet(){
  const{data,isLoading}=useQuery('balance-sheet',()=>get<any>('/books/reports/balance-sheet'))
  const assets=(data as any)?.assets||[]
  const liabilities=(data as any)?.liabilities||[]
  const equity=(data as any)?.equity||[]
  const totalAssets=(data as any)?.totalAssets||0
  const totalLiabilities=(data as any)?.totalLiabilities||0
  const totalEquity=(data as any)?.totalEquity||0
  const balanced=(data as any)?.balances

  return(
    <div>
      <div className="ph">
        <div><h1 className="pt">⚖ Balance Sheet</h1><p className="ps">As of {new Date().toLocaleDateString()}</p></div>
        {balanced!==undefined&&<span className={`badge ${balanced?'bg2':'br'}`}>{balanced?'✓ Balanced':'⚠ Out of Balance'}</span>}
      </div>

      {isLoading?<div style={{padding:32,color:'var(--t3)',textAlign:'center'}}><span className="spinner" style={{display:'inline-block'}}/></div>:(
        <div className="grid2">
          <div>
            <div className="card" style={{marginBottom:12}}>
              <div className="ct">Assets</div>
              {assets.map((a:any)=><div key={a.code} className="dr"><span className="dk">{a.code} · {a.name}</span><span className="dv mono">{formatCurrency(a.balance)}</span></div>)}
              {assets.length===0&&<div style={{color:'var(--t3)',fontSize:'.78rem'}}>No asset accounts with balances.</div>}
              <div className="dr" style={{borderTop:'2px solid var(--b1)',marginTop:8,paddingTop:8}}>
                <span style={{fontWeight:700,color:'var(--t0)',fontFamily:'var(--font-d)'}}>Total Assets</span>
                <span style={{fontFamily:'var(--font-m)',fontWeight:700,color:'var(--blue)',fontSize:'1rem'}}>{formatCurrency(totalAssets)}</span>
              </div>
            </div>
          </div>
          <div>
            <div className="card" style={{marginBottom:12}}>
              <div className="ct">Liabilities</div>
              {liabilities.map((a:any)=><div key={a.code} className="dr"><span className="dk">{a.code} · {a.name}</span><span className="dv mono">{formatCurrency(a.balance)}</span></div>)}
              {liabilities.length===0&&<div style={{color:'var(--t3)',fontSize:'.78rem'}}>No liability accounts with balances.</div>}
              <div className="dr" style={{borderTop:'2px solid var(--b1)',marginTop:8,paddingTop:8}}>
                <span style={{fontWeight:700,color:'var(--t0)',fontFamily:'var(--font-d)'}}>Total Liabilities</span>
                <span style={{fontFamily:'var(--font-m)',fontWeight:700,color:'var(--red)',fontSize:'1rem'}}>{formatCurrency(totalLiabilities)}</span>
              </div>
            </div>
            <div className="card">
              <div className="ct">Equity</div>
              {equity.map((a:any)=><div key={a.code} className="dr"><span className="dk">{a.code} · {a.name}</span><span className="dv mono">{formatCurrency(a.balance)}</span></div>)}
              {equity.length===0&&<div style={{color:'var(--t3)',fontSize:'.78rem'}}>No equity accounts with balances.</div>}
              <div className="dr" style={{borderTop:'2px solid var(--b1)',marginTop:8,paddingTop:8}}>
                <span style={{fontWeight:700,color:'var(--t0)',fontFamily:'var(--font-d)'}}>Total Equity</span>
                <span style={{fontFamily:'var(--font-m)',fontWeight:700,color:'var(--gold)',fontSize:'1rem'}}>{formatCurrency(totalEquity)}</span>
              </div>
              <div className="dr" style={{borderTop:'2px solid var(--b1)',marginTop:8,paddingTop:8}}>
                <span style={{fontWeight:700,color:'var(--t0)',fontFamily:'var(--font-d)'}}>Total Liabilities + Equity</span>
                <span style={{fontFamily:'var(--font-m)',fontWeight:700,color:balanced?'var(--green)':'var(--red)',fontSize:'1rem'}}>{formatCurrency(totalLiabilities+totalEquity)}</span>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ── CLIENT SWITCHER ───────────────────────────────────────────────────
function ClientSwitcher(){
  const{user,activeClientId,activeClientName,setActiveClient}=useAuth()
  const[open,setOpen]=useState(false)
  const{data:clients=[]}=useQuery('bk-clients',()=>get<any[]>('/books/bookkeeper/clients'),{enabled:user?.role==='bookkeeper'||user?.role==='admin'||user?.role==='super_admin'})
  if(user?.role==='landlord')return null
  if((clients as any[]).length===0)return null
  return(
    <div style={{position:'relative'}}>
      <button className="btn bg-btn bsm" onClick={()=>setOpen(o=>!o)} style={{display:'flex',alignItems:'center',gap:6,maxWidth:200}}>
        <span style={{fontSize:'.7rem',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>
          {activeClientName||'Select Client'}
        </span>
        <span style={{color:'var(--t3)'}}>▾</span>
      </button>
      {open&&(
        <div style={{position:'absolute',right:0,top:'calc(100% + 6px)',background:'var(--bg2)',border:'1px solid var(--b1)',borderRadius:10,minWidth:220,zIndex:100,boxShadow:'0 8px 32px rgba(0,0,0,.4)',overflow:'hidden'}}>
          <div style={{padding:'8px 12px',borderBottom:'1px solid var(--b0)',fontSize:'.65rem',color:'var(--t3)',textTransform:'uppercase',letterSpacing:'.08em'}}>Switch Client</div>
          {(clients as any[]).map((cl:any)=>(
            <button key={cl.landlordId} onClick={()=>{setActiveClient(cl.landlordId,cl.businessName||cl.firstName+' '+cl.lastName);setOpen(false)}}
              style={{width:'100%',padding:'10px 14px',background:activeClientId===cl.landlordId?'rgba(201,162,39,.08)':'none',border:'none',textAlign:'left',cursor:'pointer',display:'flex',justifyContent:'space-between',alignItems:'center'}}>
              <div>
                <div style={{fontWeight:600,color:'var(--t0)',fontSize:'.82rem'}}>{cl.businessName||cl.firstName+' '+cl.lastName}</div>
                <div style={{fontSize:'.65rem',color:'var(--t3)'}}>{cl.employeeCount} emp · {cl.contractorCount} contractors</div>
              </div>
              {activeClientId===cl.landlordId&&<span style={{color:'var(--gold)'}}>✓</span>}
            </button>
          ))}
          <div style={{padding:'8px 12px',borderTop:'1px solid var(--b0)'}}>
            <a href="/clients" style={{fontSize:'.72rem',color:'var(--t3)'}} onClick={()=>setOpen(false)}>Manage clients →</a>
          </div>
        </div>
      )}
    </div>
  )
}

// ── MY CLIENTS ────────────────────────────────────────────────────────
function MyClients(){
  const{user,activeClientId,setActiveClient}=useAuth()
  const isAdmin=user?.role==='admin'||user?.role==='super_admin'
  const{data:clients=[],isLoading,refetch}=useQuery('bk-clients',()=>get<any[]>('/books/bookkeeper/clients'))
  const{data:allBookkeepers=[]}=useQuery('all-bk',()=>get<any[]>('/books/bookkeeper/all'),{enabled:isAdmin})
  const[showInvite,setShowInvite]=useState(false)
  const[inviteForm,setInviteForm]=useState({email:'',firstName:'',lastName:'',password:'',landlordIds:[] as string[]})
  const[saving,setSaving]=useState(false)
  const[err,setErr]=useState('')
  const qc=useQueryClient()

  const invite=async(e:React.FormEvent)=>{
    e.preventDefault();setSaving(true);setErr('')
    try{
      await post('/books/bookkeeper/invite',inviteForm)
      qc.invalidateQueries('bk-clients')
      qc.invalidateQueries('all-bk')
      setShowInvite(false)
      setInviteForm({email:'',firstName:'',lastName:'',password:'',landlordIds:[]})
    }catch(ex:any){setErr(ex.response?.data?.error||'Failed')}
    finally{setSaving(false)}
  }

  const revoke=async(bookkeeperUserId:string,landlordId:string)=>{
    if(!confirm('Revoke this bookkeeper access?'))return
    await del('/books/bookkeeper/revoke')
    // Note: delete with body — use post pattern
    await api.delete('/books/bookkeeper/revoke',{data:{bookkeeperUserId,landlordId}})
    qc.invalidateQueries('bk-clients')
    refetch()
  }

  return(
    <div>
      <div className="ph">
        <div>
          <h1 className="pt">🏢 {isAdmin?'All Bookkeeper Clients':'My Clients'}</h1>
          <p className="ps">{(clients as any[]).length} client{(clients as any[]).length!==1?'s':''} assigned</p>
        </div>
        {isAdmin&&<button className="btn bp" onClick={()=>setShowInvite(true)}>+ Invite Bookkeeper</button>}
      </div>

      {(clients as any[]).length===0&&!isLoading&&(
        <div className="card" style={{textAlign:'center',padding:'60px 20px'}}>
          <div style={{fontSize:'3rem',marginBottom:16}}>🏢</div>
          <h2 style={{color:'var(--t0)',marginBottom:8}}>No clients assigned yet</h2>
          <p style={{color:'var(--t3)',fontSize:'.85rem',maxWidth:380,margin:'0 auto'}}>
            {isAdmin?'Invite a bookkeeper and assign them to landlord accounts.':"Your account hasn't been assigned to any clients yet. Contact your administrator."}
          </p>
        </div>
      )}

      <div style={{display:'grid',gap:12}}>
        {(clients as any[]).map((cl:any)=>(
          <div key={cl.landlordId} className="card" style={{borderColor:activeClientId===cl.landlordId?'rgba(201,162,39,.4)':'var(--b1)'}}>
            <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',gap:16}}>
              <div style={{flex:1}}>
                <div style={{display:'flex',alignItems:'center',gap:10,marginBottom:8}}>
                  <h3 style={{color:'var(--t0)',fontSize:'1rem'}}>{cl.businessName||cl.firstName+' '+cl.lastName}</h3>
                  {activeClientId===cl.landlordId&&<span className="badge bgold">Active</span>}
                  <span className={cl.status==='active'?'badge bg2':'badge br'}>{cl.status}</span>
                </div>
                <div style={{display:'flex',gap:20,fontSize:'.75rem',color:'var(--t3)',flexWrap:'wrap'}}>
                  <span>👤 {cl.firstName} {cl.lastName} ({cl.email})</span>
                  <span>👥 {cl.employeeCount} employees</span>
                  <span>🔧 {cl.contractorCount} contractors</span>
                  <span>▶ {cl.payrollRunCount} payroll runs</span>
                  <span>📅 Since {new Date(cl.accessSince).toLocaleDateString()}</span>
                </div>
              </div>
              <div style={{display:'flex',gap:8,flexShrink:0}}>
                <button className="btn bp bsm" onClick={()=>setActiveClient(cl.landlordId,cl.businessName||cl.firstName+' '+cl.lastName)}>
                  {activeClientId===cl.landlordId?'✓ Active':'Switch To'}
                </button>
                {isAdmin&&<button className="btn bd bsm" onClick={()=>revoke('',cl.landlordId)}>Revoke</button>}
              </div>
            </div>
          </div>
        ))}
      </div>

      {isAdmin&&(allBookkeepers as any[]).length>0&&(
        <div style={{marginTop:24}}>
          <div className="ct">All Bookkeepers on Platform</div>
          <div className="card" style={{padding:0}}>
            <table className="tbl">
              <thead><tr><th>Bookkeeper</th><th>Email</th><th>Clients</th><th>Joined</th></tr></thead>
              <tbody>
                {(allBookkeepers as any[]).map((bk:any)=>(
                  <tr key={bk.id}>
                    <td style={{fontWeight:600,color:'var(--t0)'}}>{bk.firstName} {bk.lastName}</td>
                    <td style={{fontSize:'.75rem'}}>{bk.email}</td>
                    <td className="mono">{bk.clientCount}</td>
                    <td style={{fontSize:'.72rem',color:'var(--t3)'}}>{new Date(bk.createdAt).toLocaleDateString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {showInvite&&(
        <Modal title="Invite Bookkeeper" onClose={()=>setShowInvite(false)}>
          {err&&<div className="alert ae">{err}</div>}
          <form onSubmit={invite}>
            <div className="frow2">
              <div><label>First Name</label><input type="text" value={inviteForm.firstName} onChange={e=>setInviteForm(f=>({...f,firstName:e.target.value}))} required/></div>
              <div><label>Last Name</label><input type="text" value={inviteForm.lastName} onChange={e=>setInviteForm(f=>({...f,lastName:e.target.value}))} required/></div>
            </div>
            <div className="frow"><label>Email</label><input type="email" value={inviteForm.email} onChange={e=>setInviteForm(f=>({...f,email:e.target.value}))} required/></div>
            <div className="frow"><label>Temporary Password</label><input type="text" value={inviteForm.password} onChange={e=>setInviteForm(f=>({...f,password:e.target.value}))} required placeholder="They should change this on first login"/></div>
            <div className="alert agold" style={{fontSize:'.75rem'}}>After creating the account, use the Assign button on each client to link them.</div>
            <div className="factions">
              <button type="button" className="btn bg-btn" onClick={()=>setShowInvite(false)}>Cancel</button>
              <button type="submit" className="btn bp" disabled={saving}>{saving?<><span className="spinner"/>Creating…</>:'Create Bookkeeper Account'}</button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  )
}

// ── STUB ──────────────────────────────────────────────────────────────
function ComingSoon({title,icon,description}:{title:string;icon:string;description:string}){
  return(
    <div>
      <div className="ph"><div><h1 className="pt">{icon} {title}</h1><p className="ps">{description}</p></div></div>
      <div className="card" style={{textAlign:'center',padding:'60px 20px'}}>
        <div style={{fontSize:'3rem',marginBottom:16}}>{icon}</div>
        <h2 style={{color:'var(--t0)',marginBottom:8}}>{title}</h2>
        <p style={{color:'var(--t3)',fontSize:'.85rem',maxWidth:420,margin:'0 auto 20px'}}>Coming in the next session.</p>
        <span className="badge bteal">In Development</span>
      </div>
    </div>
  )
}

// ── LOGIN ────────────────────────────────────────────────────────────
function LoginPage(){
  React.useEffect(()=>{ TOKEN_KEYS.forEach(k=>localStorage.removeItem(k)); delete api.defaults.headers.common['Authorization'] },[])
  const{login}=useAuth();const navigate=useNavigate()
  const[email,setEmail]=useState('');const[pw,setPw]=useState('');const[err,setErr]=useState('');const[loading,setLoading]=useState(false)
  const onSubmit=async(e:React.FormEvent)=>{
    e.preventDefault();setLoading(true);setErr('')
    try{await login(email,pw);navigate('/dashboard')}
    catch(ex:any){setErr(ex.response?.data?.error||ex.message||'Login failed')}
    finally{setLoading(false)}
  }
  return(
    <div style={{minHeight:'100vh',display:'flex',alignItems:'center',justifyContent:'center',background:'var(--bg0)',padding:20}}>
      <div style={{width:'100%',maxWidth:400}}>
        <div style={{textAlign:'center',marginBottom:40}}>
          <div style={{fontFamily:'var(--font-d)',fontSize:'2rem',fontWeight:800,color:'var(--gold)',marginBottom:8}}>📒 GAM Books</div>
          <div style={{color:'var(--t3)',fontSize:'.82rem'}}>Payroll & Bookkeeping · Gold Asset Management</div>
        </div>
        <div className="card" style={{padding:24}}>
          {err&&<div className="alert ae" style={{marginBottom:14}}>{err}</div>}
          <div className="alert agold" style={{marginBottom:20,fontSize:'.75rem'}}>Sign in with your GAM Admin or Landlord credentials.</div>
          <form onSubmit={onSubmit}>
            <div className="frow"><label>Email</label><input type="email" value={email} onChange={e=>setEmail(e.target.value)} autoFocus required/></div>
            <div className="frow"><label>Password</label><input type="password" value={pw} onChange={e=>setPw(e.target.value)} required/></div>
            <button className="bp btn" type="submit" disabled={loading} style={{width:'100%',justifyContent:'center',marginTop:4}}>
              {loading?<span className="spinner"/>:'Sign in to GAM Books'}
            </button>
          </form>
        </div>
        <div style={{textAlign:'center',marginTop:20}}><a href="http://localhost:3003" style={{color:'var(--t3)',fontSize:'.75rem'}}>← Back to Admin Console</a></div>
      </div>
    </div>
  )
}

// ── APP ───────────────────────────────────────────────────────────────
function App(){
  const{user,loading}=useAuth()
  if(loading)return<div className="loading-pg"><span className="spinner" style={{marginRight:10}}/>Loading GAM Books…</div>
  const authed=!!user&&ALLOWED_ROLES.includes(user.role)
  return(
    <Routes>
      <Route path="/login" element={authed?<Navigate to="/dashboard" replace/>:<LoginPage/>}/>
      <Route path="/" element={authed?<Layout/>:<Navigate to="/login" replace/>}>
        <Route index element={<Navigate to="/dashboard" replace/>}/>
        <Route path="dashboard"          element={<Dashboard/>}/>
        <Route path="clients"            element={<MyClients/>}/>
        <Route path="payroll/employees"  element={<Employees/>}/>
        <Route path="payroll/contractors" element={<Contractors/>}/>
        <Route path="payroll/vendors"    element={<Vendors/>}/>
        <Route path="payroll/runs"       element={<RunPayroll/>}/>
        <Route path="payroll/history"    element={<PayHistory/>}/>
        <Route path="payroll/tax-forms"  element={<ComingSoon title="Tax Forms" icon="📋" description="W-2s, 1099-NECs, 940, 941, AZ state forms"/>}/>
        <Route path="books/accounts"     element={<ChartOfAccounts/>}/>
        <Route path="books/journal"      element={<JournalEntries/>}/>
        <Route path="books/transactions" element={<Transactions/>}/>
        <Route path="books/reconcile"    element={<BankReconcile/>}/>
        <Route path="rent-roll"          element={<RentRoll/>}/>
        <Route path="disbursements"      element={<ComingSoon title="Owner Disbursements" icon="💸" description="Disbursement history synced from GAM"/>}/>
        <Route path="bills"              element={<BillsAP/>}/>
        <Route path="reports/pl"              element={<ProfitLoss/>}/>
        <Route path="reports/balance-sheet"   element={<BalanceSheet/>}/>
        <Route path="reports/cash-flow"       element={<CashFlow/>}/>
        <Route path="reports/owner-statements" element={<OwnerStatements/>}/>
        <Route path="tax"                element={<TaxCenter/>}/>
        <Route path="admin/companies"    element={<ComingSoon title="All Companies" icon="🏢" description="Platform-wide books view"/>}/>
        <Route path="admin/audit"        element={<ComingSoon title="Audit Log" icon="🔍" description="Full audit trail for all entries"/>}/>
      </Route>
      <Route path="*" element={<Navigate to={authed?'/dashboard':'/login'} replace/>}/>
    </Routes>
  )
}

function Root(){
  return(
    <QueryClientProvider client={qc}>
      <AuthProvider>
        <style dangerouslySetInnerHTML={{__html:css}}/>
        <BrowserRouter><App/></BrowserRouter>
      </AuthProvider>
    </QueryClientProvider>
  )
}

ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><Root/></React.StrictMode>)
