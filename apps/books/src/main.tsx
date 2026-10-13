import { isAuthRejection, fetchAuthMeWithRetry, sessionRenewalDue, readKeepSignedInChoice, rememberKeepSignedInChoice } from '@gam/shared'
// S540: self-hosted fonts — no render-blocking external stylesheet
import '@fontsource/syne/600.css'
import '@fontsource/syne/700.css'
import '@fontsource/syne/800.css'
import '@fontsource/dm-sans/300.css'
import '@fontsource/dm-sans/400.css'
import '@fontsource/dm-sans/500.css'
import '@fontsource/dm-sans/600.css'
import '@fontsource/dm-mono/400.css'
import '@fontsource/dm-mono/500.css'
import { SentryErrorBoundary } from './lib/sentry'
// 10/11 (Nic): "a bookkeeper in the bookkeeper portal scoped to certain
// properties should see those properties in the bookkeeper portal as well...
// It's kind of like the point of sale where it's byte identical." The landlord
// portal's financial pages, the same files (src/financials,
// financials-parity.test.ts), shown here for the company that is open.
import { IncomePage } from './financials/IncomePage'
import { ExpensesPage } from './financials/ExpensesPage'
import { MaintenanceCostsPage } from './financials/MaintenanceCostsPage'
import { ReportsPage } from './financials/ReportsPage'
import { BankActivityPage } from './financials/BankActivityPage'
import { PayoutsPage } from './financials/PayoutsPage'
import { FinancialsViewerContext } from './financials/adapter'
import './financialsHost.css'
// 10/12 (Nic): "Bookkeeping" in the landlord menu brings these pages inside the
// landlord portal — so each Books page is its own file in src/bookkeeping, the
// same bytes there and in apps/landlord (bookkeeping-parity.test.ts).
import { BooksDashboardPage } from './bookkeeping/BooksDashboardPage'
import { ChartOfAccountsPage } from './bookkeeping/ChartOfAccountsPage'
import { EmployeesPage } from './bookkeeping/EmployeesPage'
import { ContractorsPage } from './bookkeeping/ContractorsPage'
import { VendorsPage } from './bookkeeping/VendorsPage'
// 10/12 (Nic): loans and fixed assets (the same bytes in apps/landlord).
import { LoansPage } from './bookkeeping/LoansPage'
import { FixedAssetsPage } from './bookkeeping/FixedAssetsPage'
import { RunPayrollPage } from './bookkeeping/RunPayrollPage'
import { PayHistoryPage } from './bookkeeping/PayHistoryPage'
import { TaxFormsPage } from './bookkeeping/TaxFormsPage'
import { JournalEntriesPage } from './bookkeeping/JournalEntriesPage'
import { TransactionsPage } from './bookkeeping/TransactionsPage'
import { BankReconcilePage } from './bookkeeping/BankReconcilePage'
// 10/12 (Nic, ledger P9): close a month (the same page in the landlord portal's Bookkeeping menu).
import { CloseMonthPage } from './bookkeeping/CloseMonthPage'
import { BillsPage } from './bookkeeping/BillsPage'
import { CashFlowPage } from './bookkeeping/CashFlowPage'
import { OwnerStatementsPage } from './bookkeeping/OwnerStatementsPage'
import { TaxCenterPage } from './bookkeeping/TaxCenterPage'
import { ProfitLossPage } from './bookkeeping/ProfitLossPage'
import { BalanceSheetPage } from './bookkeeping/BalanceSheetPage'
// 10/12 (Nic, ledger P8): the trial balance and the general ledger.
import { TrialBalancePage } from './bookkeeping/TrialBalancePage'
import { GeneralLedgerPage } from './bookkeeping/GeneralLedgerPage'
// 10/12 (Nic): the company's books settings and what its books start with —
// the same pages the landlord portal's Bookkeeping menu shows.
import { BooksSettingsPage } from './bookkeeping/BooksSettingsPage'
import { OpeningBalancesPage } from './bookkeeping/OpeningBalancesPage'
// 10/12 (Nic, L5): the company's own categories for money out and in.
import { CategoriesPage } from './bookkeeping/CategoriesPage'
import { BooksViewerContext, BOOKS_PATHS } from './bookkeeping/adapter'
import { ComingSoon } from './bookkeeping/common'
import React, { createContext, useContext, useState } from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter, Routes, Route, Navigate, NavLink, Outlet, useNavigate, useLocation } from 'react-router-dom'
import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from 'react-query'
import axios from 'axios'
import { formatCurrency, applyCamelizeInterceptor, humanize, UNIT_STATUS_LABEL, MONEY_COLUMN_LABEL } from '@gam/shared'
import { DialogHost } from './components/dialogs'
import {
  rentRollVariance, rentPayers, loadErrorText,
  companyChoiceState, companyName, type CompanyChoice,
} from './bookkeeping/booksMoney'

const ENV = (import.meta as any).env || {}
const API = ENV.VITE_API_URL || 'http://localhost:4000'
const ADMIN_URL = ENV.VITE_ADMIN_APP_URL || 'http://localhost:3003'
// S655: Books people are on the landlord side, so password recovery is there.
const LANDLORD_URL = ENV.VITE_LANDLORD_APP_URL || (ENV.PROD ? 'https://landlord.goldassetmanagement.com' : 'http://localhost:3001')
const api = axios.create({ baseURL: `${API}/api` })
// S655: Books keeps ONE pass, its own. It used to also read 'gam_admin_token'
// and take a pass from the web address (?token=), which is how the admin
// console's "GAM Books" button handed over a super_admin pass in a URL — only
// for Books to refuse it, since admins are kept out (S568).
const TOKEN = 'gam_books_token'
const getToken = () => localStorage.getItem(TOKEN)
api.interceptors.request.use(c => { const t=getToken(); if(t) c.headers.Authorization=`Bearer ${t}`; return c })
api.interceptors.response.use(r=>r, e=>{ if(e.response?.status===401&&!e.config.url.includes('/auth/')){ localStorage.removeItem(TOKEN); window.location.href='/login' } noteClientGone(e); return Promise.reject(e) })
// Inject active client header for bookkeepers
api.interceptors.request.use(c=>{ let cid:string|null=null; try{ cid=localStorage.getItem('gam_books_client') }catch{ /* blocked storage */ } if(cid) c.headers['X-Client-Id']=cid; return c })
// S312: snake_case → camelCase response transform (see packages/shared/src/camelize.ts).
applyCamelizeInterceptor(api)
const get=<T,>(url:string)=>api.get<{success:boolean;data:T}>(url).then(r=>r.data.data)

// S568 (Nic): NO admins in the customer Books portal — GAM's own platform
// bookkeeping lives on the super-admin side. Books is for landlords + their
// bookkeepers + business/POS operators.
const ALLOWED_ROLES=['landlord','bookkeeper','business_owner','business_staff']
interface AuthUser{id:string;email:string;role:string;firstName:string;lastName:string;landlordId?:string;activeClientId?:string;activeClientName?:string}
const BOOKS_ONLY='GAM Books is for landlords, their bookkeepers, and business owners and staff.'
// S655: every sign-in has a second step since S578 — the emailed code, or an
// authenticator app. Books never had one, so nobody could sign in at all.
type LoginResult={kind:'success'}|{kind:'totp_required';totpSession:string}|{kind:'email_otp_required';emailOtpSession:string}
interface AuthCtx{user:AuthUser|null;loading:boolean;activeClientId:string|null;activeClientName:string|null;setActiveClient:(id:string,name:string)=>void;clearActiveClient:()=>void
  login:(e:string,p:string,keepSignedIn:boolean)=>Promise<LoginResult>
  loginWithTotp:(totpSession:string,code:string)=>Promise<void>
  loginWithEmailOtp:(emailOtpSession:string,code:string)=>Promise<void>
  resendEmailOtp:(emailOtpSession:string)=>Promise<void>
  logout:()=>void}
const toAuthUser=(u:any):AuthUser=>({id:u.id,email:u.email,role:u.role,firstName:u.firstName||'',lastName:u.lastName||'',landlordId:u.landlordId||undefined})
const Ctx=createContext<AuthCtx>(null!)
const useAuth=()=>useContext(Ctx)

// S655: the company (a bookkeeper's client, or one of a landlord account's
// companies) whose books are open is remembered per person: a choice made by
// someone else on this computer is forgotten before any request carries it.
const CLIENT_KEY='gam_books_client', CLIENT_NAME_KEY='gam_books_client_name', CLIENT_OWNER_KEY='gam_books_client_user'
const readStore=(k:string)=>{ try{ return localStorage.getItem(k) }catch{ return null } }
const forgetClient=()=>{ try{ localStorage.removeItem(CLIENT_KEY); localStorage.removeItem(CLIENT_NAME_KEY); localStorage.removeItem(CLIENT_OWNER_KEY) }catch{ /* blocked storage */ } }
// 10/11: a bookkeeper whose access to the open client was removed is answered
// "You are not assigned to …". The remembered client is forgotten and the app
// told, so the client picker comes back instead of every page erroring.
// (The shared financial pages' adapter sends the same event.)
const CLIENT_GONE='gam-books-client-gone'
function noteClientGone(e:any){
  const said=String(e?.response?.data?.error||'')
  if(e?.response?.status===403&&/^You are not assigned to (that company's books|this client)/.test(said)){ forgetClient(); window.dispatchEvent(new Event(CLIENT_GONE)) }
}
// A choice saved before choices were remembered per person has no owner: it is
// taken as this person's (the server still checks it, and a landlord's company
// picker forgets one that is not theirs), so nobody has to pick again.
const keepClientOnlyFor=(userId:string)=>{
  const owner=readStore(CLIENT_OWNER_KEY)
  if(owner===null){ if(readStore(CLIENT_KEY)){ try{ localStorage.setItem(CLIENT_OWNER_KEY,userId) }catch{ /* blocked storage */ } } return }
  if(owner!==userId) forgetClient()
}

function AuthProvider({children}:{children:React.ReactNode}){
  const[user,setUser]=useState<AuthUser|null>(null)
  const[loading,setLoading]=useState(true)
  const[activeClientId,setActiveClientId]=useState<string|null>(()=>readStore(CLIENT_KEY))
  // S639 SECURITY: a change of identity empties the client cache, so one
  // person's cached books never show under the next person's sign-in.
  const _qc=useQueryClient()
  const wipeCache=()=>{ try{ _qc.clear() }catch{ /* no cache yet */ } }
  const logout=React.useCallback(()=>{ wipeCache(); localStorage.removeItem(TOKEN); delete api.defaults.headers.common['Authorization']; setUser(null) },[])

  // S655: a Books sign-in ends 7 days after it started, even mid-task, unless
  // "Keep me signed in on this device" was ticked. sessionRenewalDue() says no
  // for a fixed pass, so this only ever renews a kept sign-in (the server
  // refuses to extend a fixed one regardless) — on load and whenever Books
  // comes back into view, once the pass is more than a day old.
  const renewSession=React.useCallback(async()=>{
    const current=getToken()
    if(!sessionRenewalDue(current))return
    try{
      const r=await api.post('/auth/refresh',{})
      // A sign-out (or another sign-in) while this was in flight wins.
      if(getToken()!==current)return
      const tk=r.data?.data?.token
      if(!tk)return
      localStorage.setItem(TOKEN,tk)
      api.defaults.headers.common['Authorization']='Bearer '+tk
    }catch(e){ if(isAuthRejection(e)) logout() }
  },[logout])

  React.useEffect(()=>{
    const t=getToken()
    if(!t){setLoading(false);return}
    api.defaults.headers.common['Authorization']='Bearer '+t
    fetchAuthMeWithRetry(() => api.get('/auth/me')).then(async res=>{
      const u=res.data.data
      if(!u||!ALLOWED_ROLES.includes(u.role)){logout();return}
      keepClientOnlyFor(u.id); setActiveClientId(readStore(CLIENT_KEY))
      setUser(toAuthUser(u))
      await renewSession()
    }).catch((e:any)=>{ if (isAuthRejection(e)) logout() }).finally(()=>setLoading(false))
  },[logout,renewSession])
  React.useEffect(()=>{
    const onVisible=()=>{ if(document.visibilityState==='visible') renewSession() }
    document.addEventListener('visibilitychange',onVisible)
    return()=>document.removeEventListener('visibilitychange',onVisible)
  },[renewSession])

  // The full pass from whichever step finished the sign-in.
  const acceptPass=async(tk:string)=>{
    wipeCache(); localStorage.setItem(TOKEN,tk)
    api.defaults.headers.common['Authorization']='Bearer '+tk
    try{
      const res=await fetchAuthMeWithRetry(() => api.get('/auth/me'))
      const u=res.data.data
      if(!u||!ALLOWED_ROLES.includes(u.role))throw new Error(BOOKS_ONLY)
      keepClientOnlyFor(u.id); setActiveClientId(readStore(CLIENT_KEY))
      setUser(toAuthUser(u))
    }catch(e){ logout(); throw e }
  }
  // S655: portal 'books' — the server refuses anyone Books does not serve
  // before any code is emailed, and signs in for a fixed length unless kept.
  const login=async(email:string,password:string,keepSignedIn:boolean):Promise<LoginResult>=>{
    const res=await axios.post(`${API}/api/auth/login`,{email,password,portal:'books',keepSignedIn})
    const data=res.data.data
    if(data.requiresTotp)return{kind:'totp_required',totpSession:data.totpSession as string}
    if(data.requiresEmailOtp)return{kind:'email_otp_required',emailOtpSession:data.emailOtpSession as string}
    await acceptPass(data.token)
    return{kind:'success'}
  }
  const loginWithTotp=async(totpSession:string,code:string)=>{
    const res=await axios.post(`${API}/api/auth/totp/verify`,{totpSession,code})
    await acceptPass(res.data.data.token)
  }
  const loginWithEmailOtp=async(emailOtpSession:string,code:string)=>{
    const res=await axios.post(`${API}/api/auth/email-otp/verify`,{emailOtpSession,code})
    await acceptPass(res.data.data.token)
  }
  const resendEmailOtp=async(emailOtpSession:string)=>{
    await axios.post(`${API}/api/auth/email-otp/resend`,{emailOtpSession})
  }
  const setActiveClient=(id:string,name:string)=>{
    try{
      localStorage.setItem(CLIENT_KEY,id)
      localStorage.setItem(CLIENT_NAME_KEY,name)
      if(user?.id) localStorage.setItem(CLIENT_OWNER_KEY,user.id)
    }catch{ /* blocked storage: the choice holds for this visit only */ }
    // S655: one company's figures never show under another's name — the
    // cached screens are dropped and re-read for the company just opened.
    if(id!==activeClientId) wipeCache()
    setActiveClientId(id)
    setUser(u=>u?{...u,activeClientId:id,activeClientName:name}:u)
  }
  const clearActiveClient=React.useCallback(()=>{ forgetClient(); setActiveClientId(null); wipeCache() },[])
  React.useEffect(()=>{
    const gone=()=>{ setActiveClientId(null); wipeCache() }
    window.addEventListener(CLIENT_GONE,gone)
    return()=>window.removeEventListener(CLIENT_GONE,gone)
  },[])
  const activeClientName=readStore(CLIENT_NAME_KEY)
  return<Ctx.Provider value={{user,loading,activeClientId,activeClientName,setActiveClient,clearActiveClient,login,loginWithTotp,loginWithEmailOtp,resendEmailOtp,logout}}>{children}</Ctx.Provider>
}

const qc=new QueryClient({defaultOptions:{queries:{retry:1,staleTime:15000}}})

// ── STYLES ────────────────────────────────────────────────────────────
const css=`
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg0:#080a0c;--bg1:#0d1014;--bg2:#121519;--bg3:#181c22;--bg4:#1e2330;
  --b0:#1a1f28;--b1:#222a38;--b2:#2a3547;
  --t0:#eef0f6;--t1:#b8c4d8;--t2:#7a8aaa;--t3:#475060;
  --gold:#c9a227;--green:#22c55e;--red:#ef4444;--amber:#f59e0b;--blue:#3b82f6;--purple:#a855f7;--teal:#14b8a6;
  --font-d:'Syne',sans-serif;--font-b:'DM Sans',sans-serif;--font-m:'DM Mono',monospace
}
html{-webkit-font-smoothing:antialiased;height:100%}
body{font-family:var(--font-b);background:var(--bg0);color:var(--t1);line-height:1.6;height:100%;margin:0;overflow:hidden;overscroll-behavior:none}
h1,h2,h3{font-family:var(--font-d);color:var(--t0);line-height:1.2}
button{cursor:pointer;font-family:var(--font-b)}input,select,textarea{font-family:var(--font-b)}
.shell{display:flex;height:100vh;overflow:hidden}
.sidebar{width:230px;flex-shrink:0;background:var(--bg1);border-right:1px solid var(--b0);position:fixed;top:0;left:0;bottom:0;z-index:50;display:flex;flex-direction:column;overflow-y:auto}
.main{flex:1;margin-left:230px;height:100vh;display:flex;flex-direction:column;min-width:0;overflow:hidden}
.topbar{height:52px;background:var(--bg1);border-bottom:1px solid var(--b0);display:flex;align-items:center;padding:0 24px;position:sticky;top:0;z-index:40;gap:12px;flex-shrink:0}
.page{flex:1;min-height:0;padding:28px;max-width:1600px;width:100%;overflow-y:auto;overflow-x:hidden;overscroll-behavior:none}
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
/* 10/12: tel too — the Employees, Contractors and Vendors phone boxes were drawn unstyled. */
input[type=text],input[type=email],input[type=tel],input[type=number],input[type=date],input[type=password],select,textarea{width:100%;background:var(--bg3);border:1px solid var(--b1);border-radius:7px;color:var(--t0);padding:8px 11px;font-size:.875rem;outline:none;transition:border .12s}
input:focus,select:focus,textarea:focus{border-color:var(--gold)}
.factions{display:flex;gap:8px;justify-content:flex-end;margin-top:20px;padding-top:14px;border-top:1px solid var(--b0)}
@keyframes spin{to{transform:rotate(360deg)}}
/* S655: the "Money received" / "Money billed" switch */
.dr-sub .dk{padding-left:14px}
.bnote{margin-top:10px;font-size:.72rem;color:var(--t3);line-height:1.5}
/* S655: which company's books (a landlord account with several) */
.company-pick{max-width:560px}
.company-pick-list{display:grid;gap:8px;margin-top:16px}
.company-pick-list .btn{justify-content:space-between;padding:11px 14px;font-size:.84rem;text-align:left;flex-wrap:wrap}
.company-pick-sub{font-weight:500;font-size:.72rem;opacity:.75}
`

// ── LAYOUT ─────────────────────────────────────────────────────────────
function Layout(){
  const{user,logout}=useAuth()
  const navigate=useNavigate()
  const isAdmin=user?.role==='admin'||user?.role==='super_admin'
  // 10/11: the shared financial pages are about a landlord company's money —
  // its owner and its bookkeeper; business accounts keep their own Books.
  const isBookkeeper=user?.role==='bookkeeper'
  const showFinancials=user?.role==='landlord'||isBookkeeper
  // 10/12 (Nic): a business account's books have no landlord settings or
  // opening balances (routes/booksSettings answers landlord companies only).
  const isBusiness=user?.role==='business_owner'||user?.role==='business_staff'
  // 10/12 (Nic): the bank account, payouts and payroll — and with them the
  // company's own books (its ledger, bills, bank reconciliation and company
  // reports) — are the company-wide box's, the owner's choice per bookkeeper;
  // the server refuses them without it, so the tabs are not shown. A
  // bookkeeper with no property ticked (company-wide only) has no property
  // money, so those tabs go instead. Hidden until the scope is known.
  const location=useLocation()
  const{data:finScope}=useQuery<{companyWide:boolean;ledger?:boolean;properties:any[]}>('financials-scope',()=>get<{companyWide:boolean;ledger?:boolean;properties:any[]}>('/financials/scope'),{enabled:isBookkeeper,staleTime:60_000})
  const showCompanyWide=!isBookkeeper||finScope?.companyWide===true
  // 10/12 (Nic, BK1): the company's Books ledger (payroll, chart, journal,
  // transactions, bank reconciliation, bills, P&L, balance sheet, tax) is the
  // company-wide box's OR "May use the whole-company ledger" — the server's own
  // list (routes/books BOOKS_LEDGER). Bank Activity, Payouts, Cash Flow and
  // Owner Statements carry the payouts and stay the company-wide box's.
  const showLedger=showCompanyWide||finScope?.ledger===true
  const showPropertyMoney=!isBookkeeper||(finScope?.properties?.length??0)>0
  React.useEffect(()=>{
    if(isBookkeeper&&finScope&&!showPropertyMoney&&location.pathname==='/financials/income')navigate('/financials/bank-activity',{replace:true})
  },[isBookkeeper,finScope,showPropertyMoney,location.pathname,navigate])
  return(
    <div className="shell">
      <aside className="sidebar">
        <div className="logo">
          <div className="logo-n">📒 GAM Books</div>
          <div className="logo-s">Payroll & Bookkeeping</div>
        </div>
        <nav className="nav">
          <div className="nl">Overview</div>
          {showLedger&&<NavLink to={BOOKS_PATHS.dashboard} className={({isActive})=>`ni${isActive?' active':''}`}>📊 Dashboard</NavLink>}
          {(user?.role==='bookkeeper'||isAdmin)&&<NavLink to="/clients" className={({isActive})=>`ni${isActive?' active':''}`}>🏢 My Clients</NavLink>}
          {showFinancials&&<>
            <div className="nl" style={{marginTop:8}}>Financials</div>
            {showPropertyMoney&&<>
              <NavLink to="/financials/income"            className={({isActive})=>`ni${isActive?' active':''}`}>💵 Money In</NavLink>
              <NavLink to="/financials/expenses"          className={({isActive})=>`ni${isActive?' active':''}`}>🧾 Expenses</NavLink>
              <NavLink to="/financials/maintenance-costs" className={({isActive})=>`ni${isActive?' active':''}`}>🛠 Maintenance Costs</NavLink>
              <NavLink to="/financials/reports"           className={({isActive})=>`ni${isActive?' active':''}`}>📊 Reports</NavLink>
            </>}
            {/* 10/12 (Nic): the company's own categories, for the owner and EVERY bookkeeper — not only one with the
                ledger (the server lets each keep them; pointing one at an account needs the ledger, and the page says so). */}
            {!isBusiness&&<NavLink to={BOOKS_PATHS.categories} className={({isActive})=>`ni${isActive?' active':''}`}>🏷 Categories</NavLink>}
            {showCompanyWide&&<NavLink to="/financials/bank-activity" className={({isActive})=>`ni${isActive?' active':''}`}>🏦 Bank Activity</NavLink>}
            {showCompanyWide&&<NavLink to="/financials/payouts"       className={({isActive})=>`ni${isActive?' active':''}`}>💸 Payouts</NavLink>}
          </>}
          {showLedger&&<>
          <div className="nl" style={{marginTop:8}}>Payroll</div>
          <NavLink to={BOOKS_PATHS.employees} className={({isActive})=>`ni${isActive?' active':''}`}>👥 Employees (W-2)</NavLink>
          {/* 10/12 (Nic): one list of everyone the company pays — contractors are vendors (the old Contractors address opens it). */}
          <NavLink to={BOOKS_PATHS.vendors} className={({isActive})=>`ni${isActive?' active':''}`}>🏪 Vendors & Contractors</NavLink>
          <NavLink to={BOOKS_PATHS.runPayroll} className={({isActive})=>`ni${isActive?' active':''}`}>▶ Run Payroll</NavLink>
          <NavLink to={BOOKS_PATHS.payHistory} className={({isActive})=>`ni${isActive?' active':''}`}>🕐 Pay History</NavLink>
          <NavLink to={BOOKS_PATHS.taxForms} className={({isActive})=>`ni${isActive?' active':''}`}>📋 Tax Forms</NavLink>
          <div className="nl" style={{marginTop:8}}>Bookkeeping</div>
          <NavLink to={BOOKS_PATHS.accounts} className={({isActive})=>`ni${isActive?' active':''}`}>📂 Chart of Accounts</NavLink>
          <NavLink to={BOOKS_PATHS.journal} className={({isActive})=>`ni${isActive?' active':''}`}>📓 Journal Entries</NavLink>
          {/* 10/12 (Nic, L5): a landlord company's Transactions and Bills moved onto Expenses; a business keeps them. */}
          {isBusiness&&<NavLink to={BOOKS_PATHS.transactions} className={({isActive})=>`ni${isActive?' active':''}`}>💳 Transactions</NavLink>}
          <NavLink to={BOOKS_PATHS.reconcile} className={({isActive})=>`ni${isActive?' active':''}`}>🏦 Bank Reconciliation</NavLink>
          {/* 10/12 (Nic, L3): closing a month is the company-wide box's (who may close is the owner's Books Settings choice). */}
          {!isBusiness&&showCompanyWide&&<NavLink to={BOOKS_PATHS.closeMonth} className={({isActive})=>`ni${isActive?' active':''}`}>🔒 Close Month</NavLink>}
          <NavLink to={BOOKS_PATHS.loans} className={({isActive})=>`ni${isActive?' active':''}`}>🏦 Loans</NavLink>
          <NavLink to={BOOKS_PATHS.fixedAssets} className={({isActive})=>`ni${isActive?' active':''}`}>🏗 Fixed Assets</NavLink>
          {/* 10/12 (Nic): how the company's books count money, and what they start with. */}
          {!isBusiness&&<NavLink to={BOOKS_PATHS.booksSettings} className={({isActive})=>`ni${isActive?' active':''}`}>⚙ Books Settings</NavLink>}
          {!isBusiness&&<NavLink to={BOOKS_PATHS.openingBalances} className={({isActive})=>`ni${isActive?' active':''}`}>🧮 Opening Balances</NavLink>}
          </>}
          {(showPropertyMoney||showLedger)&&<div className="nl" style={{marginTop:8}}>Property Finance</div>}
          {/* 10/11 (Nic): tenant names are allowed wherever bookkeeping needs them,
              so the rent roll is a bookkeeper's too — without the tenants'
              contact or account details (the server leaves them out). */}
          {showPropertyMoney&&<NavLink to="/rent-roll"     className={({isActive})=>`ni${isActive?' active':''}`}>🏘 Rent Roll</NavLink>}
          {/* 10/12 (Nic): the company's books below are the company-wide box's;
              BK1: the ledger's (bills, P&L, balance sheet, tax) with the ledger box too. */}
          {showLedger&&<>
          {isBusiness&&<NavLink to={BOOKS_PATHS.bills} className={({isActive})=>`ni${isActive?' active':''}`}>📄 Bills & AP</NavLink>}
          <div className="nl" style={{marginTop:8}}>Reports</div>
          <NavLink to={BOOKS_PATHS.profitLoss} className={({isActive})=>`ni${isActive?' active':''}`}>📈 P&amp;L</NavLink>
          <NavLink to={BOOKS_PATHS.balanceSheet} className={({isActive})=>`ni${isActive?' active':''}`}>⚖ Balance Sheet</NavLink>
          {/* 10/12 (Nic, ledger P8): the trial balance and the general ledger (a landlord company's books). */}
          {!isBusiness&&<NavLink to={BOOKS_PATHS.trialBalance} className={({isActive})=>`ni${isActive?' active':''}`}>🧾 Trial Balance</NavLink>}
          {!isBusiness&&<NavLink to={BOOKS_PATHS.generalLedger} className={({isActive})=>`ni${isActive?' active':''}`}>📒 General Ledger</NavLink>}
          {showCompanyWide&&<NavLink to={BOOKS_PATHS.cashFlow} className={({isActive})=>`ni${isActive?' active':''}`}>💧 Cash Flow</NavLink>}
          {showCompanyWide&&<NavLink to={BOOKS_PATHS.ownerStatements} className={({isActive})=>`ni${isActive?' active':''}`}>🏠 Owner Statements</NavLink>}
          <div className="nl" style={{marginTop:8}}>Tax</div>
          <NavLink to={BOOKS_PATHS.taxCenter} className={({isActive})=>`ni${isActive?' active':''}`}>🏛 Tax Center</NavLink>
          </>}
          {isAdmin&&<><div className="nl" style={{marginTop:8}}>Admin</div>
          <NavLink to="/admin/companies" className={({isActive})=>`ni${isActive?' active':''}`}>🏢 All Companies</NavLink>
          <NavLink to="/admin/audit"     className={({isActive})=>`ni${isActive?' active':''}`}>🔍 Audit Log</NavLink></>}
        </nav>
        <div className="sfooter">
          <div style={{padding:'6px 10px',marginBottom:4}}>
            <div style={{fontWeight:600,color:'var(--t0)',fontSize:'.78rem'}}>{user?.firstName} {user?.lastName}</div>
            <div style={{marginTop:3}}><span className={`badge ${isAdmin?'br':'bgold'}`} style={{fontSize:'.6rem'}}>{isAdmin?'Admin':isBookkeeper?'Bookkeeper':'Landlord'}</span></div>
          </div>
          {isAdmin&&<a href={ADMIN_URL} className="ni" style={{color:'var(--t3)',fontSize:'.75rem'}}>← Admin Console</a>}
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
        <div className="page"><CompanyGate><BooksViewerContext.Provider value={{role:user?.role??''}}><Outlet/></BooksViewerContext.Provider></CompanyGate></div>
      </div>
    </div>
  )
}

// ── RENT ROLL ─────────────────────────────────────────────────────────
function RentRoll(){
  // 10/11: a bookkeeper's rent roll carries no tenant contact or bank details
  // (the server leaves them out), so it has no ACH column.
  const{user}=useAuth()
  const showAch=user?.role!=='bookkeeper'
  const{data,isLoading,error}=useQuery(['rent-roll'],()=>get<any>('/books/rent-roll'))
  const units=(data as any)?.units||[]
  // 10/12 (Nic): lease start and end dates — a bookkeeper's only when the owner
  // ticked "Show lease start and end dates" for them (the server says which).
  const showLease=(data as any)?.showLeaseDates===true
  const leaseDay=(d:string|null|undefined)=>d?new Date(String(d).slice(0,10)+'T12:00:00').toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'}):'—'
  const occupied=units.filter((u:any)=>u.status!=='vacant')
  // S604/S616: an owner-use space is occupied but pays no rent, and a utility
  // service point is a neighbor's building — neither is expected rent. The
  // API's expected-rent total leaves both out; each row's variance does too,
  // so the rows add up to the total instead of showing a gap nobody owes
  // (lib/booksMoney: earnsRent, rentRollVariance).
  const payers=rentPayers(units)
  // S655: THIS month's bills only. 10/12 (Nic): no Money received / Money
  // billed switch — side by side, Received leading: what arrived this month
  // toward bills due this month or earlier, what this month's bills charged,
  // and what is still owed of them. Variance stays Received less expected rent.
  const colLabel=`${MONEY_COLUMN_LABEL.received} this month`
  return(
    <div>
      <div className="ph">
        <div><h1 className="pt">🏘 Rent Roll</h1><p className="ps">Live sync from GAM · {units.length} units</p></div>
        <div style={{display:'flex',gap:8,alignItems:'center',flexWrap:'wrap'}}>
          <span className="badge bteal">Live Data</span>
        </div>
      </div>
      {!!error&&<div className="alert aw">{loadErrorText(error,'Could not load the rent roll.')}</div>}

      <div className="grid4" style={{marginBottom:16}}>
        <div className="kpi"><div className="kl">Expected Rent (MTD)</div><div className="kv gold">{formatCurrency((data as any)?.totalExpected||0)}</div><div className="ks">payable across {payers.length} of {occupied.length} occupied units</div></div>
        <div className="kpi"><div className="kl">{colLabel}</div><div className="kv g">{formatCurrency((data as any)?.totalCollected||0)}</div><div className="ks">Toward this month's bills and older · {MONEY_COLUMN_LABEL.charged} {formatCurrency((data as any)?.totalCharged||0)} · {MONEY_COLUMN_LABEL.owed} {formatCurrency((data as any)?.totalOwed||0)}</div></div>
        <div className="kpi"><div className="kl">Variance</div><div className={`kv ${((data as any)?.variance||0)>=0?'g':'r'}`}>{formatCurrency((data as any)?.variance||0)}</div><div className="ks">{colLabel} minus expected rent</div></div>
        <div className="kpi"><div className="kl">Occupancy Rate</div><div className="kv b">{(((data as any)?.occupancyRate||0)*100).toFixed(0)}%</div><div className="ks">{occupied.length}/{units.length} units</div></div>
      </div>

      <div className="card" style={{padding:0}}>
        {isLoading?<div style={{padding:32,color:'var(--t3)',textAlign:'center'}}><span className="spinner" style={{display:'inline-block'}}/></div>:(
          <table className="tbl">
            <thead><tr><th>Unit</th><th>Property</th><th>Tenant</th>{showLease&&<th>Lease</th>}<th>Rent</th><th>{colLabel}</th><th>{MONEY_COLUMN_LABEL.charged}</th><th>{MONEY_COLUMN_LABEL.owed}</th><th>Variance</th><th>Status</th>{showAch&&<th>ACH</th>}</tr></thead>
            <tbody>
              {units.length?units.map((u:any)=>{
                const variance=rentRollVariance(u)
                return(
                  <tr key={u.unitNumber+u.propertyName}>
                    <td className="mono" style={{fontWeight:600,color:'var(--t0)'}}>{u.unitNumber}</td>
                    <td style={{fontSize:'.75rem'}}>{u.propertyName}</td>
                    <td style={{fontSize:'.75rem'}}>{u.tenantFirst?u.tenantFirst+' '+u.tenantLast:<span style={{color:'var(--t3)'}}>Vacant</span>}</td>
                    {showLease&&<td style={{fontSize:'.72rem',whiteSpace:'nowrap'}}>{u.leaseStartDate?`${leaseDay(u.leaseStartDate)} – ${u.leaseEndDate?leaseDay(u.leaseEndDate):'month to month'}`:'—'}</td>}
                    <td className="mono">{formatCurrency(u.rentAmount)}</td>
                    <td className="mono" style={{color:'var(--green)'}}>{+u.collectedMtd>0?formatCurrency(u.collectedMtd):'—'}</td>
                    <td className="mono">{+u.chargedMtd?formatCurrency(u.chargedMtd):'—'}</td>
                    <td className="mono" style={{color:+u.owedMtd?'var(--amber)':'var(--t3)'}}>{+u.owedMtd?formatCurrency(u.owedMtd):'—'}</td>
                    <td className="mono" style={{color:variance==null?'var(--t3)':variance>=0?'var(--green)':'var(--red)'}}>{variance==null?'—':formatCurrency(variance)}</td>
                    <td><span className={`badge ${u.status==='active'?'bg2':u.status==='delinquent'?'ba':u.status==='vacant'?'bmu':'br'}`}>{(UNIT_STATUS_LABEL as Record<string,string>)[u.status]??humanize(u.status)}</span></td>
                    {showAch&&<td>{u.achVerified?<span className="badge bg2">✓</span>:<span style={{color:'var(--t3)'}}>—</span>}</td>}
                  </tr>
                )
              }):<tr><td colSpan={9+(showAch?1:0)+(showLease?1:0)}><div className="empty">No units found.</div></td></tr>}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}

// ── CLIENT SWITCHER ───────────────────────────────────────────────────
// A bookkeeper switches between client companies; S655: a landlord account
// with more than one company switches between its own (Books opens one
// company's books at a time — the companies are never merged).
function ClientSwitcher(){
  const{user,activeClientId,activeClientName,setActiveClient}=useAuth()
  const[open,setOpen]=useState(false)
  const isLandlord=user?.role==='landlord'
  const{data:clients=[]}=useQuery('bk-clients',()=>get<any[]>('/books/bookkeeper/clients'),{enabled:user?.role==='bookkeeper'||user?.role==='admin'||user?.role==='super_admin'})
  const{data:companies=[]}=useLandlordCompanies()
  const options:Array<{id:string;name:string;sub:string|null}>=isLandlord
    ?(companies as CompanyChoice[]).map((c,i)=>({id:c.landlordId,name:companyName(c,i),sub:c.businessName&&c.propertyNames?c.propertyNames:null}))
    :(clients as any[]).map((cl:any)=>({id:cl.landlordId,name:cl.businessName||cl.firstName+' '+cl.lastName,sub:`${cl.employeeCount} emp · ${cl.contractorCount} contractors`}))
  if(isLandlord&&!companyChoiceState(companies as CompanyChoice[],activeClientId).showSwitcher)return null
  if(options.length===0)return null
  const current=options.find(o=>o.id===activeClientId)?.name||activeClientName
  return(
    <div style={{position:'relative'}}>
      <button className="btn bg-btn bsm" onClick={()=>setOpen(o=>!o)} style={{display:'flex',alignItems:'center',gap:6,maxWidth:220}} aria-haspopup="listbox" aria-expanded={open}>
        <span style={{fontSize:'.7rem',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>
          {current||(isLandlord?'Choose a company':'Select Client')}
        </span>
        <span style={{color:'var(--t3)'}}>▾</span>
      </button>
      {open&&(
        <div style={{position:'absolute',right:0,top:'calc(100% + 6px)',background:'var(--bg2)',border:'1px solid var(--b1)',borderRadius:10,minWidth:220,zIndex:100,boxShadow:'0 8px 32px rgba(0,0,0,.4)',overflow:'hidden'}}>
          <div style={{padding:'8px 12px',borderBottom:'1px solid var(--b0)',fontSize:'.65rem',color:'var(--t3)',textTransform:'uppercase',letterSpacing:'.08em'}}>{isLandlord?'Switch company':'Switch Client'}</div>
          {options.map(o=>(
            <button key={o.id} onClick={()=>{setActiveClient(o.id,o.name);setOpen(false)}}
              style={{width:'100%',padding:'10px 14px',background:activeClientId===o.id?'rgba(201,162,39,.08)':'none',border:'none',textAlign:'left',cursor:'pointer',display:'flex',justifyContent:'space-between',alignItems:'center'}}>
              <div>
                <div style={{fontWeight:600,color:'var(--t0)',fontSize:'.82rem'}}>{o.name}</div>
                {o.sub&&<div style={{fontSize:'.65rem',color:'var(--t3)'}}>{o.sub}</div>}
              </div>
              {activeClientId===o.id&&<span style={{color:'var(--gold)'}}>✓</span>}
            </button>
          ))}
          {!isLandlord&&(
            <div style={{padding:'8px 12px',borderTop:'1px solid var(--b0)'}}>
              <a href="/clients" style={{fontSize:'.72rem',color:'var(--t3)'}} onClick={()=>setOpen(false)}>Manage clients →</a>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ── S655: WHICH COMPANY'S BOOKS (landlord accounts) ──────────────────
// The server never picks a company for an account that owns several (S654:
// "None is the default"); it answers 400 until one is named. So Books asks
// first, in place of the page, and every request then names the chosen one.
function useLandlordCompanies(){
  const{user}=useAuth()
  return useQuery<CompanyChoice[]>(['books-companies',user?.id],()=>get<CompanyChoice[]>('/books/companies'),{enabled:user?.role==='landlord',staleTime:60_000})
}

function CompanyGate({children}:{children:React.ReactNode}){
  const{user,activeClientId,setActiveClient,clearActiveClient}=useAuth()
  const{data:companies,isLoading,error,refetch,isFetching}=useLandlordCompanies()
  const isLandlord=user?.role==='landlord'
  const state=companyChoiceState(companies,activeClientId)
  // A remembered company that is no longer this account's is forgotten.
  React.useEffect(()=>{ if(isLandlord&&companies&&state.staleChoice) clearActiveClient() },[isLandlord,companies,state.staleChoice,clearActiveClient])
  // 10/11: a bookkeeper, the same way. With no client named, the server falls
  // back to their oldest assignment, so with several clients the pages would
  // show one client's money under "Select Client". One client opens by itself;
  // several are asked which; a remembered client they no longer keep is forgotten.
  const isBookkeeper=user?.role==='bookkeeper'
  const{data:bkClients,isLoading:bkLoading,error:bkError,refetch:bkRefetch,isFetching:bkFetching}=useQuery<any[]>('bk-clients',()=>get<any[]>('/books/bookkeeper/clients'),{enabled:isBookkeeper})
  const bkChoices:CompanyChoice[]|undefined=bkClients?.map((c:any)=>({landlordId:c.landlordId,businessName:c.businessName||[c.firstName,c.lastName].filter(Boolean).join(' ')||null,propertyNames:null}))
  const bkState=companyChoiceState(bkChoices,activeClientId)
  const bkOnly=bkChoices&&bkChoices.length===1?bkChoices[0]:null
  React.useEffect(()=>{ if(isBookkeeper&&bkChoices&&bkState.staleChoice) clearActiveClient() },[isBookkeeper,bkChoices,bkState.staleChoice,clearActiveClient])
  React.useEffect(()=>{ if(isBookkeeper&&bkOnly&&!activeClientId) setActiveClient(bkOnly.landlordId,companyName(bkOnly,0)) },[isBookkeeper,bkOnly,activeClientId,setActiveClient])
  if(isBookkeeper){
    if(bkLoading||(bkChoices&&(bkState.staleChoice||(bkOnly&&!activeClientId))))return<div style={{padding:32,color:'var(--t3)',textAlign:'center'}}><span className="spinner" style={{display:'inline-block'}}/></div>
    if(bkError)return(
      <div className="alert ae" style={{alignItems:'center'}}>
        <span style={{flex:1}}>{loadErrorText(bkError,'Could not load your clients.')}</span>
        <button className="btn bp bsm" disabled={bkFetching} onClick={()=>bkRefetch()}>{bkFetching?'Loading…':'Load again'}</button>
      </div>
    )
    if(bkState.mustChoose&&bkChoices)return(
      <div className="card company-pick">
        <h2 className="pt" style={{fontSize:'1.15rem'}}>Which client's books?</h2>
        <p className="ps" style={{marginTop:6,lineHeight:1.5}}>You keep the books for more than one client. Choose one to open — you can switch at the top of the page any time.</p>
        <div className="company-pick-list">
          {bkChoices.map((c,i)=>(
            <button key={c.landlordId} type="button" className="btn bp" onClick={()=>setActiveClient(c.landlordId,companyName(c,i))}>
              <span>{companyName(c,i)}</span>
            </button>
          ))}
        </div>
      </div>
    )
    return<>{children}</>
  }
  if(!isLandlord)return<>{children}</>
  if(isLoading||(companies&&state.staleChoice))return<div style={{padding:32,color:'var(--t3)',textAlign:'center'}}><span className="spinner" style={{display:'inline-block'}}/></div>
  if(error)return(
    <div className="alert ae" style={{alignItems:'center'}}>
      <span style={{flex:1}}>{loadErrorText(error,'Could not load your companies.')}</span>
      <button className="btn bp bsm" disabled={isFetching} onClick={()=>refetch()}>{isFetching?'Loading…':'Load again'}</button>
    </div>
  )
  if(state.mustChoose&&companies)return(
    <div className="card company-pick">
      <h2 className="pt" style={{fontSize:'1.15rem'}}>Which company's books?</h2>
      <p className="ps" style={{marginTop:6,lineHeight:1.5}}>You own more than one company, and each keeps its own books. Choose one to open — you can switch at the top of the page any time.</p>
      <div className="company-pick-list">
        {companies.map((c,i)=>(
          <button key={c.landlordId} type="button" className="btn bp" onClick={()=>setActiveClient(c.landlordId,companyName(c,i))}>
            <span>{companyName(c,i)}</span>
            {c.businessName&&c.propertyNames&&<span className="company-pick-sub">{c.propertyNames}</span>}
          </button>
        ))}
      </div>
    </div>
  )
  return<>{children}</>
}

// ── MY CLIENTS ────────────────────────────────────────────────────────
function MyClients(){
  const{user,activeClientId,setActiveClient}=useAuth()
  const isAdmin=user?.role==='admin'||user?.role==='super_admin'
  const{data:clients=[],isLoading}=useQuery('bk-clients',()=>get<any[]>('/books/bookkeeper/clients'))
  const{data:allBookkeepers=[]}=useQuery('all-bk',()=>get<any[]>('/books/bookkeeper/all'),{enabled:isAdmin})
  // 10/11: the admin "Revoke" button is gone. It sent DELETE twice (once with
  // no body) and could never be reached: admins are refused at Books sign-in
  // (ALLOWED_ROLES, S568). Owners remove a bookkeeper on their Team page.

  return(
    <div>
      <div className="ph">
        <div>
          <h1 className="pt">🏢 {isAdmin?'All Bookkeeper Clients':'My Clients'}</h1>
          <p className="ps">{(clients as any[]).length} client{(clients as any[]).length!==1?'s':''} assigned</p>
        </div>
      </div>

      {(clients as any[]).length===0&&!isLoading&&(
        <div className="card" style={{textAlign:'center',padding:'60px 20px'}}>
          <div style={{fontSize:'3rem',marginBottom:16}}>🏢</div>
          <h2 style={{color:'var(--t0)',marginBottom:8}}>No clients assigned yet</h2>
          <p style={{color:'var(--t3)',fontSize:'.85rem',maxWidth:380,margin:'0 auto'}}>
            {isAdmin?'Bookkeepers are invited by landlords from their own Team page. Assigned clients will appear here.':"Your account hasn't been assigned to any clients yet. Contact your administrator."}
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
                  <span className={cl.status==='active'?'badge bg2':'badge br'}>{humanize(cl.status)}</span>
                </div>
                <div style={{display:'flex',gap:20,fontSize:'.75rem',color:'var(--t3)',flexWrap:'wrap'}}>
                  <span>👤 {cl.firstName} {cl.lastName} ({cl.email})</span>
                  {/* 10/12 (Nic): payroll is in the company-wide box (BK1: or the ledger box); the server sends its counts only with one. */}
                  {cl.employeeCount!=null?<>
                    <span>👥 {cl.employeeCount} employees</span>
                    <span>🔧 {cl.contractorCount} contractors</span>
                    <span>▶ {cl.payrollRunCount} payroll runs</span>
                  </>:<span>Property books only</span>}
                  <span>📅 Since {new Date(cl.accessSince).toLocaleDateString()}</span>
                </div>
              </div>
              <div style={{display:'flex',gap:8,flexShrink:0}}>
                <button className="btn bp bsm" onClick={()=>setActiveClient(cl.landlordId,cl.businessName||cl.firstName+' '+cl.lastName)}>
                  {activeClientId===cl.landlordId?'✓ Active':'Switch To'}
                </button>
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

    </div>
  )
}

// ── LOGIN ────────────────────────────────────────────────────────────
// S655: remembered per browser so the box starts the way it was last left.
const KEEP_SIGNED_IN_KEY='gam_books_keep_signed_in'

// S639: the code step must survive leaving the page — a phone browser can
// discard and reload the tab while someone reads the code in their mail app.
// sessionStorage holds only the short-lived pre-sign-in pass, which is
// worthless without the code.
function usePendingOtpSession(key:string):[string|null,(v:string|null)=>void]{
  const[v,setV]=useState<string|null>(()=>{ try{ return sessionStorage.getItem(key) }catch{ return null } })
  const set=(next:string|null)=>{
    setV(next)
    try{ if(next) sessionStorage.setItem(key,next); else sessionStorage.removeItem(key) }catch{ /* private mode */ }
  }
  return[v,set]
}

function LoginPage(){
  React.useEffect(()=>{ localStorage.removeItem(TOKEN); delete api.defaults.headers.common['Authorization'] },[])
  const{login,loginWithTotp,loginWithEmailOtp,resendEmailOtp}=useAuth();const navigate=useNavigate()
  const[email,setEmail]=useState('');const[pw,setPw]=useState('');const[err,setErr]=useState('');const[loading,setLoading]=useState(false)
  const[keepSignedIn,setKeepSignedIn]=useState(()=>readKeepSignedInChoice(KEEP_SIGNED_IN_KEY))
  const[totpSession,setTotpSession]=useState<string|null>(null)
  const[emailOtpSession,setEmailOtpSession]=usePendingOtpSession('gam.otp.books.login')
  const[code,setCode]=useState('');const[resent,setResent]=useState(false)

  const onSubmit=async(e:React.FormEvent)=>{
    e.preventDefault();setLoading(true);setErr('')
    try{
      rememberKeepSignedInChoice(KEEP_SIGNED_IN_KEY,keepSignedIn)
      const r=await login(email,pw,keepSignedIn)
      if(r.kind==='totp_required'){setTotpSession(r.totpSession);setCode('')}
      else if(r.kind==='email_otp_required'){setEmailOtpSession(r.emailOtpSession);setCode('');setResent(false)}
      else navigate('/dashboard')
    }
    catch(ex:any){setErr(ex.response?.data?.error||ex.message||'Sign-in failed')}
    finally{setLoading(false)}
  }

  const backToCredentials=()=>{setTotpSession(null);setEmailOtpSession(null);setCode('');setPw('');setResent(false)}

  const onCodeSubmit=async(e:React.FormEvent)=>{
    e.preventDefault();setLoading(true);setErr('')
    try{
      if(emailOtpSession){await loginWithEmailOtp(emailOtpSession,code.trim());setEmailOtpSession(null)}
      else await loginWithTotp(totpSession!,code.trim())
      navigate('/dashboard')
    }
    catch(ex:any){
      const msg=ex.response?.data?.error||ex.message||'Invalid code.'
      setErr(msg)
      // An expired sign-in, or a failure after the code was accepted, starts over.
      if(/session/i.test(msg)||!ex.response)backToCredentials()
    }
    finally{setLoading(false)}
  }

  const onResend=async()=>{
    setErr('');setResent(false)
    try{await resendEmailOtp(emailOtpSession!);setResent(true)}
    catch(ex:any){setErr(ex.response?.data?.error||'Could not resend the code.')}
  }

  const header=(
    <div style={{textAlign:'center',marginBottom:40}}>
      <div style={{fontFamily:'var(--font-d)',fontSize:'2rem',fontWeight:800,color:'var(--gold)',marginBottom:8}}>📒 GAM Books</div>
      <div style={{color:'var(--t3)',fontSize:'.82rem'}}>Payroll & Bookkeeping · Gold Asset Management</div>
    </div>
  )

  // ── Step 2: the emailed code, or the authenticator app ──────────────
  if(totpSession||emailOtpSession){
    return(
      <div style={{minHeight:'100vh',display:'flex',alignItems:'center',justifyContent:'center',background:'var(--bg0)',padding:20}}>
        <div style={{width:'100%',maxWidth:400}}>
          {header}
          <div className="card" style={{padding:24}}>
            <div style={{fontSize:'.85rem',color:'var(--t1)',marginBottom:14,lineHeight:1.6}}>
              {emailOtpSession
                ?'Enter the 6-digit code we emailed you.'
                :'Enter the 6-digit code from your authenticator app, or one of your recovery codes.'}
            </div>
            {resent&&!err&&<div style={{marginBottom:14,fontSize:'.8rem',color:'var(--green)'}}>A new code is on its way.</div>}
            {err&&<div className="alert ae" style={{marginBottom:14}}>{err}</div>}
            <form onSubmit={onCodeSubmit}>
              <div className="frow"><label>Code</label>
                <input type="text" value={code} onChange={e=>setCode(e.target.value)} autoFocus required
                  autoComplete="one-time-code" inputMode="text" placeholder="123456"
                  style={{textAlign:'center',letterSpacing:'.2em',fontFamily:'var(--font-m)'}}/>
              </div>
              <button className="bp btn" type="submit" disabled={loading||!code.trim()} style={{width:'100%',justifyContent:'center',marginTop:4}}>
                {loading?<span className="spinner"/>:'Verify and sign in'}
              </button>
            </form>
            <div style={{marginTop:14,display:'flex',justifyContent:'space-between',alignItems:'center'}}>
              <button onClick={()=>{backToCredentials();setErr('')}} style={{background:'none',border:'none',color:'var(--t2)',fontSize:'.82rem',cursor:'pointer',textDecoration:'underline'}}>← Back to sign in</button>
              {emailOtpSession&&<button onClick={onResend} style={{background:'none',border:'none',color:'var(--gold)',fontSize:'.82rem',cursor:'pointer',textDecoration:'underline'}}>Resend code</button>}
            </div>
          </div>
        </div>
      </div>
    )
  }

  // ── Step 1: email and password ──────────────────────────────────────
  return(
    <div style={{minHeight:'100vh',display:'flex',alignItems:'center',justifyContent:'center',background:'var(--bg0)',padding:20}}>
      <div style={{width:'100%',maxWidth:400}}>
        {header}
        <div className="card" style={{padding:24}}>
          {err&&<div className="alert ae" style={{marginBottom:14}}>{err}</div>}
          <div className="alert agold" style={{marginBottom:20,fontSize:'.75rem'}}>Sign in with your GAM Landlord or Business credentials.</div>
          <form onSubmit={onSubmit}>
            <div className="frow"><label>Email</label><input type="email" value={email} onChange={e=>setEmail(e.target.value)} autoFocus required/></div>
            <div className="frow"><label>Password</label><input type="password" value={pw} onChange={e=>setPw(e.target.value)} required/></div>
            {/* S655: off by default. Off, this sign-in ends 7 days after it
                starts, even mid-task; on, it stays signed in while in use. */}
            <label style={{display:'flex',alignItems:'flex-start',gap:8,marginBottom:16,cursor:'pointer',fontSize:'.82rem',color:'var(--t1)',lineHeight:1.45,textTransform:'none',letterSpacing:'normal',fontWeight:400}}>
              <input type="checkbox" checked={keepSignedIn} onChange={e=>setKeepSignedIn(e.target.checked)} style={{width:'auto',marginTop:3,accentColor:'var(--gold)'}}/>
              <span>Keep me signed in on this device
                <span style={{display:'block',color:'var(--t3)',fontSize:'.74rem'}}>Leave this off on a shared computer. Off, you are signed out 7 days after you sign in.</span>
              </span>
            </label>
            <button className="bp btn" type="submit" disabled={loading} style={{width:'100%',justifyContent:'center',marginTop:4}}>
              {loading?<span className="spinner"/>:'Sign in to GAM Books'}
            </button>
          </form>
        </div>
        {/* S655: was "Back to Admin Console" — admins cannot use Books (S568),
            and the people who can had no way back from a forgotten password. */}
        <div style={{textAlign:'center',marginTop:20}}><a href={`${LANDLORD_URL}/forgot-password`} style={{color:'var(--t3)',fontSize:'.8rem'}}>Forgot your password?</a></div>
      </div>
    </div>
  )
}

// ── SHARED FINANCIAL PAGES ────────────────────────────────────────────
// 10/11: the landlord portal's financial pages, inside Books' shell. They read
// who is looking from here, and draw in the landlord portal's look
// (financialsHost.css, scoped to .fin-host).
function FinancialsHost(){
  const{user}=useAuth()
  if(user?.role!=='landlord'&&user?.role!=='bookkeeper')return<Navigate to="/dashboard" replace/>
  return(
    <FinancialsViewerContext.Provider value={{role:user.role}}>
      <div className="fin-host"><Outlet/></div>
    </FinancialsViewerContext.Provider>
  )
}

// ── APP ───────────────────────────────────────────────────────────────
function App(){
  const{user,loading}=useAuth()
  if(loading)return<div className="loading-pg"><span className="spinner" style={{marginRight:10}}/>Loading GAM Books…</div>
  const authed=!!user&&ALLOWED_ROLES.includes(user.role)
  // 10/11: a bookkeeper opens on money in; everyone else on the dashboard.
  const home=user?.role==='bookkeeper'?'/financials/income':BOOKS_PATHS.dashboard
  return(
    <Routes>
      <Route path="/login" element={authed?<Navigate to={home} replace/>:<LoginPage/>}/>
      <Route path="/" element={authed?<Layout/>:<Navigate to="/login" replace/>}>
        <Route index element={<Navigate to={home} replace/>}/>
        <Route path={BOOKS_PATHS.dashboard}       element={<BooksDashboardPage/>}/>
        <Route path="clients"            element={<MyClients/>}/>
        <Route path={BOOKS_PATHS.employees}       element={<EmployeesPage/>}/>
        <Route path={BOOKS_PATHS.contractors}     element={<ContractorsPage/>}/>
        <Route path={BOOKS_PATHS.vendors}         element={<VendorsPage/>}/>
        <Route path={BOOKS_PATHS.loans}           element={<LoansPage/>}/>
        <Route path={BOOKS_PATHS.fixedAssets}     element={<FixedAssetsPage/>}/>
        <Route path={BOOKS_PATHS.runPayroll}      element={<RunPayrollPage/>}/>
        <Route path={BOOKS_PATHS.payHistory}      element={<PayHistoryPage/>}/>
        <Route path={BOOKS_PATHS.taxForms}        element={<TaxFormsPage/>}/>
        <Route path={BOOKS_PATHS.accounts}        element={<ChartOfAccountsPage/>}/>
        <Route path={BOOKS_PATHS.journal}         element={<JournalEntriesPage/>}/>
        <Route path={BOOKS_PATHS.transactions}    element={<TransactionsPage/>}/>
        <Route path={BOOKS_PATHS.reconcile}       element={<BankReconcilePage/>}/>
        <Route path={BOOKS_PATHS.closeMonth}      element={<CloseMonthPage/>}/>
        {/* 10/11 (Nic): open to a bookkeeper again (names in, contact details out). */}
        <Route path="rent-roll"          element={<RentRoll/>}/>
        {/* 10/11: was a "coming soon" placeholder; the payouts are real now. */}
        <Route path="disbursements"      element={<Navigate to="/financials/payouts" replace/>}/>
        <Route path="financials" element={<FinancialsHost/>}>
          <Route index element={<Navigate to="/financials/income" replace/>}/>
          <Route path="income"            element={<IncomePage/>}/>
          <Route path="expenses"          element={<ExpensesPage/>}/>
          <Route path="maintenance-costs" element={<MaintenanceCostsPage/>}/>
          <Route path="reports"           element={<ReportsPage/>}/>
          <Route path="bank-activity"     element={<BankActivityPage/>}/>
          <Route path="payouts"           element={<PayoutsPage/>}/>
        </Route>
        <Route path={BOOKS_PATHS.bills}           element={<BillsPage/>}/>
        <Route path={BOOKS_PATHS.profitLoss}      element={<ProfitLossPage/>}/>
        <Route path={BOOKS_PATHS.balanceSheet}    element={<BalanceSheetPage/>}/>
        <Route path={BOOKS_PATHS.trialBalance}    element={<TrialBalancePage/>}/>
        <Route path={BOOKS_PATHS.generalLedger}   element={<GeneralLedgerPage/>}/>
        <Route path={BOOKS_PATHS.cashFlow}        element={<CashFlowPage/>}/>
        <Route path={BOOKS_PATHS.ownerStatements} element={<OwnerStatementsPage/>}/>
        <Route path={BOOKS_PATHS.taxCenter}       element={<TaxCenterPage/>}/>
        <Route path={BOOKS_PATHS.booksSettings}   element={<BooksSettingsPage/>}/>
        <Route path={BOOKS_PATHS.openingBalances} element={<OpeningBalancesPage/>}/>
        <Route path={BOOKS_PATHS.categories}      element={<CategoriesPage/>}/>
        <Route path="admin/companies"    element={<ComingSoon title="All Companies" icon="🏢" description="Platform-wide books view"/>}/>
        <Route path="admin/audit"        element={<ComingSoon title="Audit Log" icon="🔍" description="Full audit trail for all entries"/>}/>
      </Route>
      {/* 10/11: an unknown address goes to the person's own home — a bookkeeper's is money in. */}
      <Route path="*" element={<Navigate to={authed?home:'/login'} replace/>}/>
    </Routes>
  )
}

function Root(){
  return(
    <QueryClientProvider client={qc}>
      <AuthProvider>
        <style dangerouslySetInnerHTML={{__html:css}}/>
        <BrowserRouter><App/><DialogHost/></BrowserRouter>
      </AuthProvider>
    </QueryClientProvider>
  )
}

// HMR guard: when Vite re-executes this entry module, calling createRoot on
// the same container again STACKS a second mounted app under the first
// (duplicate screens, dead nav). Reuse the one root and just re-render into
// it — idempotent across hot updates.
const rootEl = document.getElementById('root')!
const appRoot: ReturnType<typeof ReactDOM.createRoot> =
  (window as any).__gam_app_root ?? ((window as any).__gam_app_root = ReactDOM.createRoot(rootEl))
appRoot.render(
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
