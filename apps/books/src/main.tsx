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
const get=<T,>(url:string)=>api.get<{success:boolean;data:T}>(url).then(r=>r.data.data)
const post=<T,>(url:string,body?:any)=>api.post<{success:boolean;data:T;message?:string}>(url,body).then(r=>r.data)
const patch=<T,>(url:string,body?:any)=>api.patch<{success:boolean;data:T}>(url,body).then(r=>r.data)
const del=(url:string)=>api.delete(url).then(r=>r.data)

const ALLOWED_ROLES=['admin','super_admin','landlord']
interface AuthUser{id:string;email:string;role:string;firstName:string;lastName:string;landlordId?:string}
interface AuthCtx{user:AuthUser|null;loading:boolean;login:(e:string,p:string)=>Promise<void>;logout:()=>void}
const Ctx=createContext<AuthCtx>(null!)
const useAuth=()=>useContext(Ctx)

function AuthProvider({children}:{children:React.ReactNode}){
  const[user,setUser]=useState<AuthUser|null>(null)
  const[loading,setLoading]=useState(true)
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
      setUser({id:u.id,email:u.email,role:u.role,firstName:u.first_name||u.firstName||'',lastName:u.last_name||u.lastName||'',landlordId:u.landlord_id||u.landlordId})
    }).catch(logout).finally(()=>setLoading(false))
  },[logout])
  const login=async(email:string,password:string)=>{
    const res=await axios.post(`${API}/api/auth/login`,{email,password})
    const{token:tk,user:u}=res.data.data
    if(!u||!ALLOWED_ROLES.includes(u.role))throw new Error('GAM Books requires Admin or Landlord access')
    localStorage.setItem('gam_books_token',tk)
    api.defaults.headers.common['Authorization']='Bearer '+tk
    setUser({id:u.id,email:u.email,role:u.role,firstName:u.firstName||u.first_name||'',lastName:u.lastName||u.last_name||'',landlordId:u.landlord_id||u.landlordId})
  }
  return<Ctx.Provider value={{user,loading,login,logout}}>{children}</Ctx.Provider>
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
          <div style={{marginLeft:'auto',display:'flex',gap:8}}>
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
          <div className="dr"><span className="dk">Employee gross pay</span><span className="dv mono">{formatCurrency((employees as any[]).reduce((s:number,e:any)=>s+(+e.ytd_gross||0),0))}</span></div>
          <div className="dr"><span className="dk">Contractor payments</span><span className="dv mono">{formatCurrency((contractors as any[]).reduce((s:number,c:any)=>s+(+c.ytd_paid||0),0))}</span></div>
          <div className="dr"><span className="dk">Vendor payments</span><span className="dv mono">{formatCurrency((vendors as any[]).reduce((s:number,v:any)=>s+(+v.ytd_paid||0),0))}</span></div>
          <div className="dr" style={{borderTop:'1px solid var(--b1)',paddingTop:8,marginTop:4}}><span className="dk" style={{fontWeight:700}}>Total YTD disbursed</span><span className="dv mono" style={{color:'var(--gold)',fontWeight:700}}>{formatCurrency((employees as any[]).reduce((s:number,e:any)=>s+(+e.ytd_gross||0),0)+(contractors as any[]).reduce((s:number,c:any)=>s+(+c.ytd_paid||0),0)+(vendors as any[]).reduce((s:number,v:any)=>s+(+v.ytd_paid||0),0))}</span></div>
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
                  <td>{a.is_system?<span className="badge bmu">System</span>:<span style={{color:'var(--t3)'}}>—</span>}</td>
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
  const ytdGross=(employees as any[]).reduce((s:number,e:any)=>s+(+e.ytd_gross||0),0)

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
        <div className="kpi"><div className="kl">YTD Federal W/H</div><div className="kv a">{formatCurrency((employees as any[]).reduce((s:number,e:any)=>s+(+e.ytd_federal_tax||0),0))}</div><div className="ks">Withheld YTD</div></div>
        <div className="kpi"><div className="kl">YTD AZ State W/H</div><div className="kv t">{formatCurrency((employees as any[]).reduce((s:number,e:any)=>s+(+e.ytd_state_tax||0),0))}</div><div className="ks">AZ flat 2.5%</div></div>
      </div>

      <div className="card" style={{padding:0}}>
        {isLoading?<div style={{padding:32,color:'var(--t3)',textAlign:'center'}}><span className="spinner" style={{display:'inline-block'}}/></div>:(
          <table className="tbl">
            <thead><tr><th>Employee</th><th>Title</th><th>Pay Type</th><th>Rate</th><th>Frequency</th><th>Per Check</th><th>YTD Gross</th><th>Status</th><th></th></tr></thead>
            <tbody>
              {(employees as any[]).length?(employees as any[]).map((emp:any)=>(
                <tr key={emp.id}>
                  <td><div style={{fontWeight:600,color:'var(--t0)'}}>{emp.first_name} {emp.last_name}</div><div style={{fontSize:'.68rem',color:'var(--t3)'}}>{emp.email||'—'}</div></td>
                  <td style={{fontSize:'.75rem'}}>{emp.title||'—'}{emp.department&&<div style={{fontSize:'.68rem',color:'var(--t3)'}}>{emp.department}</div>}</td>
                  <td><span className={`badge ${emp.pay_type==='salary'?'bb':'ba'}`}>{emp.pay_type}</span></td>
                  <td className="mono">{emp.pay_type==='salary'?formatCurrency(emp.pay_rate)+'/yr':formatCurrency(emp.pay_rate)+'/hr'}</td>
                  <td style={{fontSize:'.75rem',color:'var(--t2)'}}>{emp.pay_frequency}</td>
                  <td className="mono" style={{color:'var(--green)'}}>{formatCurrency(calcPaycheck(+emp.pay_rate,emp.pay_frequency,emp.pay_type))}</td>
                  <td className="mono">{formatCurrency(emp.ytd_gross)}</td>
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
  const w9Missing=(contractors as any[]).filter((c:any)=>!c.w9_on_file&&+c.ytd_paid>=600)

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
        <div className="kpi"><div className="kl">YTD Contractor Pay</div><div className="kv t">{formatCurrency((contractors as any[]).reduce((s:number,c:any)=>s+(+c.ytd_paid||0),0))}</div><div className="ks">Total disbursed</div></div>
        <div className="kpi"><div className="kl">W-9 on File</div><div className={`kv ${w9Missing.length>0?'r':'g'}`}>{(contractors as any[]).filter((c:any)=>c.w9_on_file).length}/{(contractors as any[]).length}</div><div className="ks">Required for 1099</div></div>
        <div className="kpi"><div className="kl">1099-NEC Needed</div><div className={`kv ${w9Missing.length>0?'a':'g'}`}>{(contractors as any[]).filter((c:any)=>+c.ytd_paid>=600).length}</div><div className="ks">Paid $600+ YTD</div></div>
      </div>

      <div className="card" style={{padding:0}}>
        {isLoading?<div style={{padding:32,color:'var(--t3)',textAlign:'center'}}><span className="spinner" style={{display:'inline-block'}}/></div>:(
          <table className="tbl">
            <thead><tr><th>Name / Business</th><th>Trade</th><th>Entity</th><th>Rate</th><th>YTD Paid</th><th>W-9</th><th>1099</th><th>Status</th></tr></thead>
            <tbody>
              {(contractors as any[]).length?(contractors as any[]).map((c:any)=>(
                <tr key={c.id}>
                  <td>
                    <div style={{fontWeight:600,color:'var(--t0)'}}>{c.business_name||[c.first_name,c.last_name].filter(Boolean).join(' ')||'—'}</div>
                    {c.business_name&&<div style={{fontSize:'.68rem',color:'var(--t3)'}}>{[c.first_name,c.last_name].filter(Boolean).join(' ')}</div>}
                    <div style={{fontSize:'.65rem',color:'var(--t3)'}}>{c.email||''}</div>
                  </td>
                  <td style={{fontSize:'.75rem'}}>{c.trade||'—'}</td>
                  <td><span className="badge bmu">{c.entity_type?.replace('_',' ')||'—'}</span></td>
                  <td className="mono">{c.pay_rate?formatCurrency(c.pay_rate)+'/'+c.pay_unit:'—'}</td>
                  <td className="mono" style={{color:+c.ytd_paid>=600?'var(--amber)':'var(--t1)'}}>{formatCurrency(c.ytd_paid)}</td>
                  <td>
                    <button className={`badge ${c.w9_on_file?'bg2':'br'}`} style={{cursor:'pointer',border:'none'}} onClick={()=>toggleW9(c.id,c.w9_on_file)}>
                      {c.w9_on_file?'✓ On File':'Missing'}
                    </button>
                  </td>
                  <td>{+c.ytd_paid>=600?<span className="badge ba">Required</span>:<span style={{color:'var(--t3)'}}>—</span>}</td>
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

  const overdue=(vendors as any[]).filter((v:any)=>+v.ap_balance>0)

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
        <div className="kpi"><div className="kl">Total AP Balance</div><div className={`kv ${overdue.length>0?'r':'g'}`}>{formatCurrency((vendors as any[]).reduce((s:number,v:any)=>s+(+v.ap_balance||0),0))}</div><div className="ks">Outstanding bills</div></div>
        <div className="kpi"><div className="kl">YTD Vendor Payments</div><div className="kv gold">{formatCurrency((vendors as any[]).reduce((s:number,v:any)=>s+(+v.ytd_paid||0),0))}</div><div className="ks">Total paid YTD</div></div>
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
                  <td><div style={{fontSize:'.75rem'}}>{v.contact_name||'—'}</div><div style={{fontSize:'.65rem',color:'var(--t3)'}}>{v.email||''}</div></td>
                  <td>{v.category?<span className="badge bmu">{v.category}</span>:<span style={{color:'var(--t3)'}}>—</span>}</td>
                  <td style={{fontSize:'.75rem',color:'var(--t2)'}}>{v.payment_terms?.replace('_',' ')||'—'}</td>
                  <td className="mono" style={{color:+v.ap_balance>0?'var(--red)':'var(--t3)'}}>{+v.ap_balance>0?formatCurrency(v.ap_balance):'—'}</td>
                  <td className="mono">{formatCurrency(v.ytd_paid)}</td>
                  <td className="mono" style={{fontSize:'.72rem',color:'var(--t3)'}}>{v.account_number||'—'}</td>
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
        <Route path="payroll/employees"  element={<Employees/>}/>
        <Route path="payroll/contractors" element={<Contractors/>}/>
        <Route path="payroll/vendors"    element={<Vendors/>}/>
        <Route path="payroll/runs"       element={<ComingSoon title="Run Payroll" icon="▶" description="Process payroll runs for W-2 and 1099"/>}/>
        <Route path="payroll/history"    element={<ComingSoon title="Pay History" icon="🕐" description="Full payroll run history and pay stubs"/>}/>
        <Route path="payroll/tax-forms"  element={<ComingSoon title="Tax Forms" icon="📋" description="W-2s, 1099-NECs, 940, 941, AZ state forms"/>}/>
        <Route path="books/accounts"     element={<ChartOfAccounts/>}/>
        <Route path="books/journal"      element={<ComingSoon title="Journal Entries" icon="📓" description="Manual double-entry journal entries"/>}/>
        <Route path="books/transactions" element={<ComingSoon title="Transactions" icon="💳" description="Income and expense transaction feed"/>}/>
        <Route path="books/reconcile"    element={<ComingSoon title="Bank Reconciliation" icon="🏦" description="Reconcile bank statements to book balance"/>}/>
        <Route path="rent-roll"          element={<ComingSoon title="Rent Roll" icon="🏘" description="Live rent roll synced from GAM"/>}/>
        <Route path="disbursements"      element={<ComingSoon title="Owner Disbursements" icon="💸" description="Disbursement history synced from GAM"/>}/>
        <Route path="bills"              element={<ComingSoon title="Bills & AP" icon="📄" description="Vendor bills and accounts payable"/>}/>
        <Route path="reports/pl"              element={<ComingSoon title="Profit & Loss" icon="📈" description="Income statement by period"/>}/>
        <Route path="reports/balance-sheet"   element={<ComingSoon title="Balance Sheet" icon="⚖" description="Assets, liabilities, and equity"/>}/>
        <Route path="reports/cash-flow"       element={<ComingSoon title="Cash Flow" icon="💧" description="Operating, investing, financing activities"/>}/>
        <Route path="reports/owner-statements" element={<ComingSoon title="Owner Statements" icon="🏠" description="Per-property income and expense statements"/>}/>
        <Route path="tax"                element={<ComingSoon title="Tax Center" icon="🏛" description="Payroll tax tracking — Federal, AZ, SS, Medicare"/>}/>
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
