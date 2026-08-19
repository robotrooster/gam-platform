import { isAuthRejection, fetchAuthMeWithRetry } from '@gam/shared'
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
import '@fontsource/inter/400.css'
import '@fontsource/inter/500.css'
import '@fontsource/inter/600.css'
import '@fontsource/inter/700.css'
import '@fontsource/jetbrains-mono/400.css'
import '@fontsource/jetbrains-mono/500.css'
import { SentryErrorBoundary } from './lib/sentry'
import React, { useContext, useState, useEffect } from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter, Routes, Route, Navigate, NavLink, Outlet, useNavigate } from 'react-router-dom'
import { QueryClient, QueryClientProvider, useQuery, useMutation, useQueryClient } from 'react-query'
import {
  LayoutDashboard, Rocket, Building2, Users, Zap, ClipboardList, DoorOpen,
  CreditCard, ArrowDownToLine, Plug, Activity, Map as MapIcon, FileText,
  Scale, SlidersHorizontal, BookOpen, Lightbulb, Landmark, Mail,
  Target, TrendingUp, Bot, Lock, LogOut, DollarSign, Sun, Moon,
} from 'lucide-react'
import axios from 'axios'
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts'
import { formatCurrency, applyCamelizeInterceptor, installDatePickerAutoClose, humanize, startVersionWatch } from '@gam/shared'
import { toast, appConfirm, DialogHost } from './components/dialogs'

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
type LoginResult={kind:'success'}|{kind:'totp_required';totpSession:string}|{kind:'email_otp_required';emailOtpSession:string}
interface AuthCtx{
  user:AuthUser|null
  token:string|null
  loading:boolean
  login:(e:string,p:string)=>Promise<LoginResult>
  loginWithTotp:(totpSession:string,code:string)=>Promise<void>
  loginWithEmailOtp:(emailOtpSession:string,code:string)=>Promise<void>
  resendEmailOtp:(emailOtpSession:string)=>Promise<void>
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
      const res = await fetchAuthMeWithRetry(() => api.get('/auth/me'))
      const u = res.data.data
      if (!u || (u.role !== 'admin' && u.role !== 'super_admin')) { logout(); return }
      setUser({
        id: u.id, email: u.email, role: u.role,
        firstName: u.firstName || '', lastName: u.lastName || '',
        profileId: u.profileId || '',
        totpEnabled: !!u.totpEnabled,
        mustEnrollTotp: !!u.mustEnrollTotp,
      })
    } catch (e) { if (isAuthRejection(e)) logout() }  // S540: transient failures keep the token
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
    if (data.requiresEmailOtp) {
      return { kind: 'email_otp_required', emailOtpSession: data.emailOtpSession as string }
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

  // S565: email-code 2FA second step. Trades the pending emailOtpSession +
  // the 6-digit code emailed to the user for the full session JWT.
  const loginWithEmailOtp = async (emailOtpSession: string, code: string): Promise<void> => {
    const res = await axios.post(API + '/api/auth/email-otp/verify', { emailOtpSession, code })
    const { token: tk, user: u } = res.data.data
    if (!u || (u.role !== 'admin' && u.role !== 'super_admin')) throw new Error('Admin access required')
    localStorage.setItem('gam_admin_token', tk)
    api.defaults.headers.common['Authorization'] = 'Bearer ' + tk
    setUser({
      id: u.id, email: u.email, role: u.role,
      firstName: '', lastName: '', profileId: u.profileId || '',
    })
    setToken(tk)
    await refresh()
  }

  const resendEmailOtp = async (emailOtpSession: string): Promise<void> => {
    await axios.post(API + '/api/auth/email-otp/resend', { emailOtpSession })
  }

  return <Ctx.Provider value={{ user, token, loading, login, loginWithTotp, loginWithEmailOtp, resendEmailOtp, refresh, logout }}>{children}</Ctx.Provider>
}

const qc=new QueryClient({defaultOptions:{queries:{retry:1,staleTime:30000,refetchOnWindowFocus:false}}})

// ── STYLES ────────────────────────────────────────────────────
const css=`
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{--bg0:#080a0c;--bg1:#0d1014;--bg2:#121519;--bg3:#181c22;--bg4:#1e2330;
  --b0:#1a1f28;--b1:#222a38;--b2:#2a3547;
  --t0:#eef0f6;--t1:#b8c4d8;--t2:#7a8aaa;--t3:#475060;
  --gold:#c9a227;--green:#22c55e;--red:#ef4444;--amber:#f59e0b;--blue:#3b82f6;--purple:#a855f7;
  --font-d:'Syne',sans-serif;--font-b:'DM Sans',sans-serif;--font-m:'DM Mono',monospace}
html{-webkit-font-smoothing:antialiased;height:100%}
body{font-family:var(--font-b);background:var(--bg0);color:var(--t1);line-height:1.6;height:100%;margin:0;overflow:hidden;overscroll-behavior:none}
h1,h2,h3,h4{font-family:var(--font-d);color:var(--t0);line-height:1.2}
h1{font-size:1.8rem;font-weight:800}h2{font-size:1.3rem;font-weight:700}h3{font-size:1rem;font-weight:700}
button{cursor:pointer;font-family:var(--font-b)}input,select{font-family:var(--font-b)}
a{color:var(--gold);text-decoration:none}
.shell{display:flex;height:100vh;overflow:hidden}
.sidebar{width:220px;flex-shrink:0;background:var(--bg1);border-right:1px solid var(--b0);position:fixed;top:0;left:0;bottom:0;z-index:50;display:flex;flex-direction:column;overflow-y:auto}
.main{flex:1;margin-left:220px;height:100vh;display:flex;flex-direction:column;min-width:0;overflow:hidden}
.topbar{height:52px;background:var(--bg1);border-bottom:1px solid var(--b0);display:flex;align-items:center;padding:0 24px;position:sticky;top:0;z-index:40;gap:12px;flex-shrink:0}
.page{flex:1;min-height:0;padding:28px;max-width:1600px;width:100%;overflow-y:auto;overflow-x:hidden;overscroll-behavior:none}
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
.kl,.kpi-l{font-size:.65rem;color:var(--t3);text-transform:uppercase;letter-spacing:.09em;font-weight:600;margin-bottom:6px}
.kv,.kpi-v{font-family:var(--font-d);font-size:1.6rem;font-weight:800;color:var(--t0);line-height:1;margin-bottom:4px}
.ks,.kpi-s{font-size:.7rem;color:var(--t3)}
.kv.g{color:var(--green)}.kv.r{color:var(--red)}.kv.a{color:var(--amber)}.kv.gold{color:var(--gold)}.kv.b{color:var(--blue)}
.btn{display:inline-flex;align-items:center;gap:6px;padding:7px 14px;border-radius:7px;font-size:.78rem;font-weight:600;border:none;cursor:pointer;transition:all .12s;font-family:var(--font-b);text-decoration:none}
.bp,.btn-p,.btn-primary{background:var(--gold);color:#080a0c}
.bg-btn{background:var(--red);color:#fff}
.bg-btn:hover{filter:brightness(1.08)}.bp:hover,.btn-p:hover,.btn-primary:hover{background:#d9af3a}
.bg,.btn-g,.btn-ghost{background:var(--bg4);color:var(--t1);border:1px solid var(--b2)}.bg:hover,.btn-g:hover,.btn-ghost:hover{background:var(--bg3)}
.bd{background:rgba(239,68,68,.08);color:var(--red);border:1px solid rgba(239,68,68,.2)}.bd:hover{background:rgba(239,68,68,.14)}
.bsm{padding:4px 9px;font-size:.72rem}
.badge{display:inline-flex;align-items:center;gap:4px;padding:3px 9px;border-radius:20px;font-size:.65rem;font-weight:600;text-transform:uppercase;letter-spacing:.04em}
.bg2,.b-green{background:rgba(34,197,94,.08);color:var(--green);border:1px solid rgba(34,197,94,.18)}
.ba,.b-amber{background:rgba(245,158,11,.08);color:var(--amber);border:1px solid rgba(245,158,11,.18)}
.br,.b-red{background:rgba(239,68,68,.08);color:var(--red);border:1px solid rgba(239,68,68,.18)}
.bgold,.b-gold{background:rgba(201,162,39,.08);color:var(--gold);border:1px solid rgba(201,162,39,.18)}
.bmu,.b-muted{background:var(--bg4);color:var(--t3);border:1px solid var(--b1)}
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
/* S562: classes referenced by newer admin surfaces (FlexPay review modal,
   shared dialogs, form fields) that were never defined in this block — they
   rendered unstyled (the FlexPay modal had no overlay). Small-button + modal +
   input + form-group defs, matching the tenant vocabulary. */
.btn-sm{padding:5px 10px;font-size:.72rem}
.modal-ov,.modal-overlay{position:fixed;inset:0;background:rgba(0,0,0,.75);display:flex;align-items:center;justify-content:center;z-index:100;padding:20px;backdrop-filter:blur(4px)}
.modal{background:var(--bg2);border:1px solid var(--b2);border-radius:14px;padding:24px;width:100%;max-width:520px;max-height:90vh;overflow-y:auto;box-shadow:0 8px 32px rgba(0,0,0,.5)}
.modal-t,.modal-title{font-family:var(--font-d);font-size:1.1rem;font-weight:800;color:var(--t0);margin-bottom:18px}
.modal-f{display:flex;justify-content:flex-end;gap:10px;margin-top:20px;padding-top:16px;border-top:1px solid var(--b0)}
.fg{margin-bottom:16px}
.fl{display:block;font-size:.72rem;font-weight:600;color:var(--t2);margin-bottom:6px;text-transform:uppercase;letter-spacing:.05em}
.inp,.input,.form-input{width:100%;background:var(--bg3);border:1px solid var(--b1);border-radius:8px;color:var(--t0);padding:10px 12px;font-size:.88rem;color-scheme:dark}
.inp:focus,.input:focus,.form-input:focus{outline:none;border-color:var(--gold)}
textarea.inp{resize:vertical}
/* S595: className="input" fields were never aliased (same drift .inp had) —
   they fell back to white browser boxes. Alias + uniform +6% type lift +
   readable disabled state. */
html{font-size:17px}
.inp:disabled,.input:disabled,.form-input:disabled,input:disabled,select:disabled,textarea:disabled,input[readonly],textarea[readonly]{background:var(--bg2);border-color:var(--b0);color:var(--t1);-webkit-text-fill-color:var(--t1);opacity:1;cursor:not-allowed}
/* S595 LIGHT THEME (short token names). Admin's accent is red — darkened for light. */
:root[data-theme="light"]{color-scheme:light;--bg0:#f4f5f7;--bg1:#ffffff;--bg2:#ffffff;--bg3:#eef0f4;--bg4:#e5e8ee;--b0:#e7e9ef;--b1:#dde0e8;--b2:#ccd2de;--t0:#12151c;--t1:#333b49;--t2:#5b6474;--t3:#8a93a5;--gold-ink:#7a5f0f;--red:#c0201f}
:root[data-theme="light"] .inp,:root[data-theme="light"] .input,:root[data-theme="light"] .form-input{color-scheme:light}
:root[data-theme="light"] a{color:var(--gold-ink)}
:root[data-theme="light"] .ni.active{background:rgba(239,68,68,.10);border-color:rgba(239,68,68,.28)}
`

// ── LAYOUT ────────────────────────────────────────────────────
function Layout(){
  const{user,logout,loading}=useAuth();const navigate=useNavigate()
  const isSuperAdmin=user?.role==='super_admin'
  // S595: per-device light/dark toggle (initial value applied pre-paint by index.html).
  const [theme, setTheme] = useState<'dark' | 'light'>(() => document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark')
  const toggleTheme = () => { const n = theme === 'dark' ? 'light' : 'dark'; document.documentElement.setAttribute('data-theme', n); try { localStorage.setItem('gam_theme', n) } catch {}; setTheme(n) }
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
          {isSuperAdmin&&<NavLink to="/overview" className={({isActive})=>`ni${isActive?' active':''}`}><LayoutDashboard size={15}/> Overview</NavLink>}
          {!isSuperAdmin&&<NavLink to="/onboarding" className={({isActive})=>`ni${isActive?' active':''}`}><Rocket size={15}/> Onboarding</NavLink>}
          <NavLink to="/landlords" className={({isActive})=>`ni${isActive?' active':''}`}><Building2 size={15}/> Landlords</NavLink>
          <NavLink to="/tenants" className={({isActive})=>`ni${isActive?' active':''}`}><Users size={15}/> Tenants</NavLink>
          <NavLink to="/commissions" className={({isActive})=>`ni${isActive?' active':''}`}><DollarSign size={15}/> Commissions</NavLink>
          {isSuperAdmin&&<NavLink to="/flexpay-requests" className={({isActive})=>`ni${isActive?' active':''}`}><Zap size={15}/> FlexPay Requests</NavLink>}
          {isSuperAdmin&&<NavLink to="/property-reviews" className={({isActive})=>`ni${isActive?' active':''}`}><ClipboardList size={15}/> Property Reviews</NavLink>}
          {isSuperAdmin&&<NavLink to="/feature-requests" className={({isActive})=>`ni${isActive?' active':''}`}><Lightbulb size={15}/> Feature Requests</NavLink>}
          <NavLink to="/units" className={({isActive})=>`ni${isActive?' active':''}`}><DoorOpen size={15}/> Units</NavLink>
          <div className="nl" style={{marginTop:8}}>Finance</div>
          <NavLink to="/payments" className={({isActive})=>`ni${isActive?' active':''}`}><CreditCard size={15}/> Payments</NavLink>
          <NavLink to="/disbursements" className={({isActive})=>`ni${isActive?' active':''}`}><ArrowDownToLine size={15}/> Disbursements</NavLink>
          <NavLink to="/connect-accounts" className={({isActive})=>`ni${isActive?' active':''}`}><Plug size={15}/> Connect Accounts</NavLink>
          {isSuperAdmin&&<NavLink to="/deposit-interest" className={({isActive})=>`ni${isActive?' active':''}`}><Landmark size={15}/> Deposit Interest</NavLink>}
          <NavLink to="/outreach" className={({isActive})=>`ni${isActive?' active':''}`}><Mail size={15}/> Signup Outreach</NavLink>
          {isSuperAdmin&&<div className="nl" style={{marginTop:8}}>Compliance</div>}
          {isSuperAdmin&&<NavLink to="/nacha" className={({isActive})=>`ni${isActive?' active':''}`}><Activity size={15}/> NACHA Monitor</NavLink>}
          {isSuperAdmin&&<NavLink to="/nexus" className={({isActive})=>`ni${isActive?' active':''}`}><MapIcon size={15}/> Sales-Tax Nexus</NavLink>}
          {isSuperAdmin&&<NavLink to="/audit-log" className={({isActive})=>`ni${isActive?' active':''}`}><FileText size={15}/> Admin Audit</NavLink>}
          {isSuperAdmin&&<NavLink to="/disputes" className={({isActive})=>`ni${isActive?' active':''}`}><Scale size={15}/> Reporting Disputes</NavLink>}
          {user?.email===OWNER_EMAIL&&<NavLink to="/system-features" className={({isActive})=>`ni${isActive?' active':''}`}><SlidersHorizontal size={15}/> System Features</NavLink>}
          {/* S508 (#6): these sections only hold super-admin items — don't
              render the section label for regular admins (was an empty "dead"
              header). */}
          {isSuperAdmin&&<div className="nl" style={{marginTop:8}}>Tools</div>}
          {isSuperAdmin&&<button className="ni" onClick={()=>{const t=localStorage.getItem('gam_admin_token');window.open(BOOKS_URL+(t?'?token='+t:''),'_blank')}}><BookOpen size={15}/> GAM Books</button>}

          {isSuperAdmin&&<div className="nl" style={{marginTop:8}}>Sales</div>}
          {isSuperAdmin&&<NavLink to="/leads" className={({isActive})=>`ni${isActive?' active':''}`}><Target size={15}/> Leads</NavLink>}

          {isSuperAdmin&&<div className="nl" style={{marginTop:8}}>Platform</div>}
          {isSuperAdmin&&<NavLink to="/scaling" className={({isActive})=>`ni${isActive?' active':''}`}><TrendingUp size={15}/> Scaling Readiness</NavLink>}
          {isSuperAdmin&&<NavLink to="/agent-analytics" className={({isActive})=>`ni${isActive?' active':''}`}><Bot size={15}/> Agent Analytics</NavLink>}

          <div className="nl" style={{marginTop:8}}>Account</div>
          <NavLink to="/security" className={({isActive})=>`ni${isActive?' active':''}`}><Lock size={15}/> Security</NavLink>
        </nav>
        <div className="sfooter">
          <div style={{padding:'6px 10px',marginBottom:4}}>
            <div style={{fontWeight:600,color:'var(--t0)',fontSize:'.78rem'}}>{user?.firstName} {user?.lastName}</div>
            <div style={{fontSize:'.65rem',color:'var(--t3)'}}>Admin</div>
          </div>
          <button className="ni" onClick={()=>{logout();navigate('/login')}} style={{color:'var(--red)'}}><LogOut size={15}/> Sign out</button>
        </div>
      </aside>
      <div className="main">
        <header className="topbar">
          <span style={{fontSize:'.72rem',color:'var(--t3)',fontFamily:'var(--font-m)'}}>Gold Asset Management — Admin Console</span>
          <button onClick={toggleTheme} title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'} aria-label="Toggle light/dark theme" style={{ marginLeft: 'auto', background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--t2)', padding: 6, display: 'inline-flex', alignItems: 'center', borderRadius: 6 }}>
            {theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
          </button>
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
  const{data:allLandlords=[],isLoading:lLoading}=useQuery<any[]>('onboarding-landlords',()=>get('/landlords'),{enabled:!!user,staleTime:30000,refetchOnWindowFocus:false})
  // S579: onboarding-speed telemetry — property creation → complete, by lease
  // source, attributed to the closer. Target is DAYS not weeks.
  const{data:speed}=useQuery<any>('onboarding-metrics',()=>get<any>('/admin/onboarding-metrics'),{enabled:!!user,staleTime:60000,refetchOnWindowFocus:false})
  // Onboarding = the PM's OWN deals to onboard (closer or CS = them), NOT the
  // self-closed claim pool that /landlords also returns; super sees everyone.
  const landlords=React.useMemo(()=>user?.role==='super_admin'?(allLandlords as any[]):(allLandlords as any[]).filter((l:any)=>l.portfolioManagerId===user?.id||l.serviceManagerId===user?.id),[allLandlords,user])
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
      const r=await post<{message?:string}>('/admin/onboarding/resend',{type,targetId})
      setResendMsg(r?.data?.message||'Sent')
      setTimeout(()=>setResendMsg(''),4000)
    }catch(e:any){setResendMsg('Failed: '+(e?.response?.data?.error||e.message))}
    finally{setResending(null)}
  }

  return(
    <div>
      <div className="ph">
        <div><h1 className="pt">Onboarding Console</h1><p className="ps">Help your landlords and tenants complete setup</p></div>
      </div>

      {resendMsg&&<div className={`alert ${resendMsg.startsWith('Failed')?'ae':'ag'}`} style={{marginBottom:12}}>{resendMsg}</div>}

      {/* S579: onboarding-speed telemetry. Standard is DAYS — slow onboards
          (dual-software overlap) surface here. */}
      {speed?.properties?.length>0&&(
        <div className="kpi" style={{marginBottom:20,cursor:'default'}}>
          <div style={{display:'flex',alignItems:'baseline',justifyContent:'space-between',marginBottom:10,flexWrap:'wrap',gap:8}}>
            <div className="kl">Onboarding Speed</div>
            <div style={{display:'flex',gap:16,fontSize:'.78rem',color:'var(--t2)'}}>
              <span>Avg <strong style={{color:(speed.summary?.avgDurationDays!=null&&speed.summary.avgDurationDays<=7)?'var(--green)':'var(--gold)'}}>{speed.summary?.avgDurationDays!=null?`${speed.summary.avgDurationDays}d`:'—'}</strong></span>
              <span>Done <strong style={{color:'var(--t0)'}}>{speed.summary?.completed||0}</strong></span>
              <span>Ongoing <strong style={{color:'var(--t0)'}}>{speed.summary?.ongoing||0}</strong></span>
            </div>
          </div>
          <div style={{overflowX:'auto'}}>
            <table style={{width:'100%',borderCollapse:'collapse',fontSize:'.78rem'}}>
              <thead>
                <tr style={{textAlign:'left',color:'var(--t2)',borderBottom:'1px solid var(--b1)'}}>
                  <th style={{padding:'6px 8px'}}>Property</th><th style={{padding:'6px 8px'}}>Landlord</th><th style={{padding:'6px 8px'}}>Closer</th>
                  <th style={{padding:'6px 8px',textAlign:'right'}}>Units</th><th style={{padding:'6px 8px',textAlign:'right'}}>e-Sign</th><th style={{padding:'6px 8px',textAlign:'right'}}>PDF</th><th style={{padding:'6px 8px',textAlign:'right'}}>Days</th>
                </tr>
              </thead>
              <tbody>
                {(speed.properties as any[]).map((p:any)=>{
                  const days=p.durationDays
                  const ongoing=days==null
                  const slow=!ongoing&&Number(days)>7
                  return(
                    <tr key={p.propertyId} style={{borderBottom:'1px solid var(--b1)'}}>
                      <td style={{padding:'6px 8px',color:'var(--t0)'}}>{p.propertyName}</td>
                      <td style={{padding:'6px 8px',color:'var(--t1)'}}>{p.landlordName}</td>
                      <td style={{padding:'6px 8px',color:'var(--t2)'}}>{p.closerName||'—'}</td>
                      <td style={{padding:'6px 8px',textAlign:'right',color:'var(--t1)'}}>{p.unitCount}</td>
                      <td style={{padding:'6px 8px',textAlign:'right',color:'var(--t1)'}}>{p.esignLeaseCount}</td>
                      <td style={{padding:'6px 8px',textAlign:'right',color:'var(--t1)'}}>{p.importedPdfCount}</td>
                      <td style={{padding:'6px 8px',textAlign:'right',fontWeight:700,color:ongoing?'var(--gold)':slow?'var(--red)':'var(--green)'}}>{ongoing?'open':`${days}d`}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

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
                <thead><tr><th>Tenant</th><th>Unit</th><th>ACH</th><th>Flex</th></tr></thead>
                <tbody>
                  {(tenants as any[]).map((t:any)=>(
                    <tr key={t.id} style={{cursor:'pointer',background:selectedTenant?.id===t.id?'rgba(201,162,39,.05)':''}} onClick={()=>{setSelectedTenant(t);setSelectedLandlord(null)}}>
                      <td><div style={{fontWeight:600,color:'var(--t0)',fontSize:'.78rem'}}>{t.firstName} {t.lastName}</div><div style={{fontSize:'.65rem',color:'var(--t3)'}}>{t.email}</div></td>
                      <td style={{fontSize:'.72rem'}}>{t.propertyName?`${t.propertyName} · ${t.unitNumber}`:<span style={{color:'var(--t3)'}}>—</span>}</td>
                      <td><span className={`badge ${t.achVerified?'bg2':'br'}`}>{t.achVerified?'✓':'No'}</span></td>
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
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// S605 (Nic): vendor + service health lives HERE, in the same layout as the
// scaling trackers, rather than on a page of its own — "I'd like to not have to
// go on those dashboards to know if there's a problem." Same audience, same
// question ("how are we doing, is anything broken"), so same page.
const HEALTH_HEX:Record<string,string>={ok:'#22c55e',warn:'#f59e0b',down:'#ef4444',unknown:'#6b7280'}
const HEALTH_LBL:Record<string,string>={ok:'OK',warn:'Watch',down:'Down',unknown:'Unknown'}

function ScalingReadiness(){
  const{data,isLoading}=useQuery('infra-readiness',()=>get<any>('/admin/infra-readiness'),{refetchInterval:20000,refetchOnWindowFocus:true})
  // Slower cadence than the 20s scaling poll: each refresh fans out to four
  // vendor APIs, and hammering them is a good way to get rate-limited by the
  // very services we are trying to watch. The server also caches for 60s.
  const{data:health}=useQuery<any>('platform-health',()=>get<any>('/admin/platform-health'),{refetchInterval:120000,refetchOnWindowFocus:true})
  const HEX:Record<string,string>={ok:'#22c55e',watch:'#f59e0b',move:'#ef4444'}
  const LBL:Record<string,string>={ok:'OK',watch:'Watch',move:'Move'}
  const VERD:Record<string,{t:string;s:string}>={
    ok:{t:'Healthy — the Mac is handling current load',s:'No action needed. Keep Vercel (frontends) + Mac (API · Postgres · LLM) on a Cloudflare Tunnel.'},
    watch:{t:'Watch — approaching a migration threshold',s:'A tracker is nearing the move line. Plan the Postgres → managed-host move soon.'},
    move:{t:'Time to move — migrate Postgres to a managed host',s:'A tracker has crossed the move line. Move the database to Render/Neon first; keep the LLM on the Mac.'},
  }
  const fmtT=(m:any,n:number)=> m.key==='monthlyVolume'?('$'+(n>=1000?Math.round(n/1000)+'k':n)) : m.key==='cpuLoad'?(n.toFixed(2)+'×') : m.key==='apiLatency'?(n+' ms') : n.toLocaleString()
  if(isLoading&&!data)return<div style={{padding:32,color:'var(--t3)'}}>Loading scaling metrics…</div>
  const overall=data?.overall||'ok'; const c=HEX[overall]; const v=VERD[overall]
  const metrics:any[]=data?.metrics||[]; const host=data?.host
  return(
    <div>
      <div className="ph">
        <div><h1 className="pt">Scaling Readiness</h1><p className="ps">Vendor health and when it's time to move off the Mac · auto-refreshes every 20s{host?` · ${host.hostname} · ${host.cores} cores`:''}</p></div>
      </div>

      <div className="card" style={{borderColor:c,marginBottom:16,display:'flex',gap:14,alignItems:'center'}}>
        <div style={{width:12,height:12,borderRadius:'50%',background:c,boxShadow:`0 0 12px ${c}`,flexShrink:0}}/>
        <div>
          <div style={{fontWeight:700,color:c,fontSize:'.95rem'}}>{v.t}</div>
          <div style={{fontSize:'.78rem',color:'var(--t2)',marginTop:2}}>{v.s}</div>
        </div>
      </div>

      <div className="grid3" style={{marginBottom:16}}>
        {metrics.map(m=>{
          const mc=HEX[m.status]||HEX.ok
          const pct=m.moveAt>0?Math.min((m.value/m.moveAt)*100,100):0
          return(
            <div className="kpi" key={m.key}>
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:4}}>
                <div className="kl" style={{margin:0}}>{m.label}</div>
                <span className="badge" style={{background:mc+'22',color:mc}}>{LBL[m.status]}</span>
              </div>
              <div className="kv" style={{color:mc}}>{m.display}</div>
              <div style={{height:5,borderRadius:3,background:'var(--b1)',overflow:'hidden',margin:'8px 0 5px'}}>
                <div style={{height:'100%',width:`${pct}%`,background:mc,transition:'width .4s'}}/>
              </div>
              <div style={{fontSize:'.62rem',color:'var(--t3)',display:'flex',justifyContent:'space-between'}}>
                <span>Watch {fmtT(m,m.watchAt)}</span><span>Move {fmtT(m,m.moveAt)}</span>
              </div>
              <div style={{fontSize:'.68rem',color:'var(--t2)',marginTop:8,lineHeight:1.4}}>{m.note}</div>
            </div>
          )
        })}
      </div>

      {health&&(
        <>
          <div style={{display:'flex',alignItems:'center',gap:10,margin:'22px 0 10px'}}>
            <h2 style={{fontSize:'.95rem',fontWeight:700,color:'var(--t0)',margin:0}}>Vendors &amp; services</h2>
            <span style={{fontSize:'.68rem',color:'var(--t3)'}}>
              everything we depend on · checked {new Date(health.checkedAt).toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'})}
            </span>
          </div>
          <div className="card" style={{borderColor:HEALTH_HEX[health.overall],marginBottom:16,display:'flex',gap:14,alignItems:'center'}}>
            <div style={{width:12,height:12,borderRadius:'50%',background:HEALTH_HEX[health.overall],boxShadow:`0 0 12px ${HEALTH_HEX[health.overall]}`,flexShrink:0}}/>
            <div>
              <div style={{fontWeight:700,color:HEALTH_HEX[health.overall],fontSize:'.95rem'}}>
                {health.overall==='ok'?'All services healthy'
                 :health.overall==='warn'?'Something needs a look'
                 :health.overall==='down'?'A service is DOWN'
                 :'Some checks could not run'}
              </div>
              <div style={{fontSize:'.78rem',color:'var(--t2)',marginTop:2}}>
                {health.overall==='ok'
                  ? 'Nothing to do. You will also get an admin notification the moment any of these breaks.'
                  : 'Details below. Each row links to the console where it gets fixed.'}
              </div>
            </div>
          </div>
          <div className="grid3" style={{marginBottom:16}}>
            {(health.components||[]).map((c:any)=>{
              const hc=HEALTH_HEX[c.state]||HEALTH_HEX.unknown
              return(
                <div className="kpi" key={c.key}>
                  <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:4}}>
                    <div className="kl" style={{margin:0}}>{c.label}</div>
                    <span className="badge" style={{background:hc+'22',color:hc}}>{HEALTH_LBL[c.state]}</span>
                  </div>
                  <div style={{fontSize:'.78rem',color:'var(--t1)',lineHeight:1.5,marginTop:6,minHeight:34}}>{c.detail}</div>
                  {c.console&&(
                    <a href={c.console} target="_blank" rel="noopener noreferrer"
                       style={{fontSize:'.68rem',color:'var(--gold)',textDecoration:'none',display:'inline-block',marginTop:8}}>
                      Open console ↗
                    </a>
                  )}
                </div>
              )
            })}
          </div>
        </>
      )}

      <div className="card">
        <div style={{fontWeight:700,color:'var(--t0)',marginBottom:10}}>Migration game plan</div>
        <ol style={{margin:0,paddingLeft:18,fontSize:'.8rem',color:'var(--t1)',lineHeight:1.7}}>
          <li><strong>Now:</strong> Vercel hosts the frontends; the Mac runs the API, Postgres, and the LLM, exposed via a Cloudflare Tunnel (stable HTTPS, no open ports).</li>
          <li><strong>The LLM stays on the Mac — permanently.</strong> Self-hosting Hermes is the cost + data-sovereignty win; it never moves to the cloud.</li>
          <li><strong>When a tracker turns red ("Move"):</strong> migrate <strong>Postgres first</strong> to a managed host (Render / Neon) — that's the uptime + backup risk. The API can follow.</li>
          <li><strong>Hard rule:</strong> the day an unplanned outage would cost a real payment, payout, or dispute window — move the database, regardless of the numbers.</li>
        </ol>
      </div>
    </div>
  )
}

// S553: the Specialist's weekly availability windows (business time,
// America/Phoenix). Replace-all save — the server regenerates offered slots
// from these on every request.
const WEEKDAYS=['Sun','Mon','Tue','Wed','Thu','Fri','Sat']
function AvailabilityEditor(){
  const qc=useQueryClient()
  const{data:windows=[],isLoading}=useQuery('call-availability',()=>get<any[]>('/admin/call-availability'))
  const[draft,setDraft]=useState<any[]|null>(null)
  const rows=draft??windows.map((w:any)=>({weekday:w.weekday,startTime:String(w.startTime).slice(0,5),endTime:String(w.endTime).slice(0,5)}))
  const saveMut=useMutation((ws:any[])=>api.put('/admin/call-availability',{windows:ws}).then(r=>r.data),{
    onSuccess:()=>{qc.invalidateQueries('call-availability');setDraft(null);toast('Availability saved')},
    onError:()=>toast('Could not save availability — check the windows.'),
  })
  const upd=(i:number,k:string,v:any)=>{const n=[...rows];n[i]={...n[i],[k]:v};setDraft(n)}
  if(isLoading)return<div style={{color:'var(--t3)',fontSize:'.75rem',marginBottom:10}}>Loading availability…</div>
  return(
    <div style={{background:'var(--s1)',borderRadius:8,padding:12,marginBottom:12}}>
      <div style={{fontSize:'.72rem',color:'var(--t3)',marginBottom:8}}>Weekly call windows (Phoenix time). Slots are offered in 30-minute increments inside these windows for the next 14 days.</div>
      {rows.map((w,i)=>(
        <div key={i} style={{display:'flex',gap:8,alignItems:'center',marginBottom:6}}>
          <select value={w.weekday} onChange={e=>upd(i,'weekday',Number(e.target.value))} style={{background:'var(--s2,var(--s1))',color:'var(--t0)',border:'1px solid var(--b1)',borderRadius:6,padding:'3px 6px',fontSize:'.75rem'}}>
            {WEEKDAYS.map((d,di)=><option key={di} value={di}>{d}</option>)}
          </select>
          <input type="time" value={w.startTime} onChange={e=>upd(i,'startTime',e.target.value)} style={{background:'var(--s2,var(--s1))',color:'var(--t0)',border:'1px solid var(--b1)',borderRadius:6,padding:'3px 6px',fontSize:'.75rem'}}/>
          <span style={{color:'var(--t3)'}}>–</span>
          <input type="time" value={w.endTime} onChange={e=>upd(i,'endTime',e.target.value)} style={{background:'var(--s2,var(--s1))',color:'var(--t0)',border:'1px solid var(--b1)',borderRadius:6,padding:'3px 6px',fontSize:'.75rem'}}/>
          <button className="btn bd bsm" onClick={()=>setDraft(rows.filter((_,x)=>x!==i))}>Remove</button>
        </div>
      ))}
      <div style={{display:'flex',gap:8,marginTop:8}}>
        <button className="btn bd bsm" onClick={()=>setDraft([...rows,{weekday:1,startTime:'09:00',endTime:'16:00'}])}>Add window</button>
        <button className="btn bgold bsm" disabled={saveMut.isLoading||!draft} onClick={()=>saveMut.mutate(rows)}>Save</button>
      </div>
    </div>
  )
}

// S553: the lead queue Portfolio Specialists work from — Lucy's captured
// leads with status flow + the chat transcript that produced each one.
const LEAD_STATUSES=['new','contacted','qualified','converted','closed'] as const
const LEAD_STATUS_LABEL:Record<string,string>={new:'New',contacted:'Contacted',qualified:'Qualified',converted:'Converted',closed:'Closed'}
const LEAD_STATUS_HEX:Record<string,string>={new:'#c9a227',contacted:'#3b82f6',qualified:'#a855f7',converted:'#22c55e',closed:'#6b7280'}
function SalesLeads(){
  const qc=useQueryClient()
  const[statusFilter,setStatusFilter]=useState<string>('')
  const[openId,setOpenId]=useState<string|null>(null)
  const{data:leads=[],isLoading}=useQuery(['sales-leads',statusFilter],()=>get<any[]>(`/admin/leads${statusFilter?`?status=${statusFilter}`:''}`),{refetchInterval:60000,keepPreviousData:true})
  const{data:transcript=[],isFetching:tLoading}=useQuery(['lead-transcript',openId],()=>get<any[]>(`/admin/leads/${openId}/transcript`),{enabled:!!openId})
  const statusMut=useMutation(({id,status}:{id:string;status:string})=>api.patch(`/admin/leads/${id}/status`,{status}).then(r=>r.data),{
    onSuccess:()=>{qc.invalidateQueries('sales-leads');toast('Lead updated')},
    onError:()=>toast('Could not update the lead — try again.'),
  })
  const{data:calls=[]}=useQuery('sales-calls',()=>get<any[]>('/admin/call-slots'),{refetchInterval:60000})
  const callMut=useMutation(({id,status}:{id:string;status:string})=>api.patch(`/admin/call-slots/${id}/status`,{status}).then(r=>r.data),{
    onSuccess:()=>{qc.invalidateQueries('sales-calls');toast('Call updated')},
  })
  const{data:feed}=useQuery('demo-feed',()=>get<any>('/admin/demo-feed'),{staleTime:300000})
  const rotateMut=useMutation(()=>api.post('/admin/demo-feed/rotate').then(r=>r.data),{
    onSuccess:()=>{qc.invalidateQueries('demo-feed');toast('Feed link rotated — re-subscribe with the new link')},
    onError:()=>toast('Could not rotate the feed link — try again.'),
  })
  const[showAvail,setShowAvail]=useState(false)
  if(isLoading&&leads.length===0)return<div style={{padding:32,color:'var(--t3)'}}>Loading leads…</div>
  const CALL_HEX:Record<string,string>={booked:'#c9a227',completed:'#22c55e',cancelled:'#6b7280',no_show:'#ef4444'}
  return(
    <div>
      <div className="ph">
        <div><h1 className="pt">Sales Leads</h1><p className="ps">Captured by Lucy on the marketing site · work the queue, read the chat, make the call</p></div>
        <div style={{display:'flex',gap:6}}>
          <button className={`btn bsm${statusFilter===''?' bgold':' bd'}`} onClick={()=>setStatusFilter('')}>All</button>
          {LEAD_STATUSES.map(st=>(
            <button key={st} className={`btn bsm${statusFilter===st?' bgold':' bd'}`} onClick={()=>setStatusFilter(st)}>{LEAD_STATUS_LABEL[st]}</button>
          ))}
        </div>
      </div>

      <div className="card" style={{marginBottom:16}}>
        <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:10}}>
          <div style={{fontWeight:700,color:'var(--t0)'}}>Upcoming demos <span style={{fontWeight:400,color:'var(--t3)',fontSize:'.72rem'}}>(video link auto-created + emailed to the prospect; also on your subscribed calendar)</span></div>
          <button className="btn bd bsm" onClick={()=>setShowAvail(s=>!s)}>{showAvail?'Hide availability':'Edit availability'}</button>
        </div>
        {feed&&<div style={{display:'flex',alignItems:'center',gap:10,flexWrap:'wrap',background:'var(--s1)',border:'1px solid var(--b1)',borderRadius:8,padding:'10px 12px',marginBottom:12}}>
          <span style={{fontSize:'.78rem',color:'var(--t1)'}}>📅 Subscribe once — every booking auto-appears on your calendar:</span>
          <a className="btn bgold bsm" href={feed.webcalUrl}>Add to calendar</a>
          <code style={{fontSize:'.68rem',color:'var(--t2)',background:'var(--s2)',padding:'3px 7px',borderRadius:5,wordBreak:'break-all'}}>{feed.url}</code>
          <button className="btn bd bsm" onClick={()=>{navigator.clipboard?.writeText(feed.url).then(()=>toast('Feed link copied'))}}>Copy</button>
          <button className="btn bd bsm" onClick={()=>{appConfirm('Rotate the feed link? Your current calendar subscription will stop updating until you re-subscribe with the new link.',{confirmLabel:'Rotate link'}).then(ok=>{if(ok)rotateMut.mutate()})}}>Rotate</button>
        </div>}
        {showAvail&&<AvailabilityEditor/>}
        <table className="tbl"><thead><tr><th>When</th><th>Type</th><th>Prospect</th><th>Contact</th><th>Mode</th><th>Portfolio</th><th>Status</th><th></th></tr></thead>
          <tbody>{calls.map((c:any)=>(
            <tr key={c.id}>
              <td style={{fontWeight:600}}>{new Date(c.startsAt).toLocaleString([],{weekday:'short',month:'short',day:'numeric',hour:'numeric',minute:'2-digit'})}</td>
              <td><span className="badge" style={{background:'var(--gold)22',color:'var(--gold)'}}>{humanize(c.kind||'demo')}</span></td>
              <td>{c.prospectName||'—'}</td>
              <td style={{fontSize:'.75rem'}}>{[c.prospectEmail,c.prospectPhone].filter(Boolean).join(' · ')||'—'}</td>
              <td>{c.mode==='video'?'📹 Video':'📞 Phone'}</td>
              <td style={{fontSize:'.72rem',color:'var(--t2)'}}>{[c.states,c.portfolioSize,c.propertyType].filter(Boolean).join(' · ')||'—'}</td>
              <td><span className="badge" style={{background:(CALL_HEX[c.status]||'#6b7280')+'22',color:CALL_HEX[c.status]||'#6b7280'}}>{humanize(c.status)}</span></td>
              <td>{c.status==='booked'&&<span style={{display:'flex',gap:4}}>
                <button className="btn bd bsm" onClick={()=>callMut.mutate({id:c.id,status:'completed'})}>Done</button>
                <button className="btn bd bsm" onClick={()=>callMut.mutate({id:c.id,status:'no_show'})}>No-show</button>
                <button className="btn bd bsm" onClick={()=>{appConfirm('Cancel this call? The prospect is NOT notified automatically — reply to their confirmation email.',{confirmLabel:'Cancel call'}).then(ok=>{if(ok)callMut.mutate({id:c.id,status:'cancelled'})})}}>Cancel</button>
              </span>}</td>
            </tr>
          ))}{calls.length===0&&<tr><td colSpan={8} style={{color:'var(--t3)'}}>No upcoming demos.</td></tr>}</tbody>
        </table>
      </div>

      <div className="card">
        <table className="tbl"><thead><tr><th>Lead</th><th>Contact</th><th>States</th><th>Portfolio</th><th>Looking for</th><th>Status</th><th>Captured</th><th></th></tr></thead>
          <tbody>{leads.map(l=>(
            <React.Fragment key={l.id}>
              <tr>
                <td style={{fontWeight:600}}>{l.name||<span style={{color:'var(--t3)'}}>—</span>}</td>
                <td style={{fontSize:'.75rem'}}>{[l.email,l.phone].filter(Boolean).join(' · ')||'—'}</td>
                <td>{l.states||'—'}</td>
                <td style={{fontSize:'.75rem'}}>{[l.portfolioSize,l.propertyType].filter(Boolean).join(' · ')||'—'}</td>
                <td style={{fontSize:'.72rem',color:'var(--t2)',maxWidth:220,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}} title={l.notes||''}>{l.notes||'—'}</td>
                <td>
                  <select value={l.status} onChange={e=>statusMut.mutate({id:l.id,status:e.target.value})}
                    style={{background:'var(--s1)',color:LEAD_STATUS_HEX[l.status]||'var(--t0)',border:'1px solid var(--b1)',borderRadius:6,padding:'3px 6px',fontSize:'.72rem',fontWeight:600}}>
                    {LEAD_STATUSES.map(st=><option key={st} value={st}>{LEAD_STATUS_LABEL[st]}</option>)}
                  </select>
                </td>
                <td style={{color:'var(--t3)',fontSize:'.72rem'}}>{l.createdAt?new Date(l.createdAt).toLocaleString():'—'}</td>
                <td><button className="btn bd bsm" onClick={()=>setOpenId(openId===l.id?null:l.id)}>{openId===l.id?'Hide chat':'Read chat'}</button></td>
              </tr>
              {openId===l.id&&(
                <tr><td colSpan={8} style={{background:'var(--s1)',padding:'12px 16px'}}>
                  {tLoading?<div style={{color:'var(--t3)',fontSize:'.75rem'}}>Loading transcript…</div>
                  :transcript.length===0?<div style={{color:'var(--t3)',fontSize:'.75rem'}}>No transcript recorded for this lead.</div>
                  :<div style={{display:'flex',flexDirection:'column',gap:8,maxHeight:320,overflowY:'auto'}}>
                    {transcript.map((t:any)=>(
                      <div key={t.turnIndex}>
                        <div style={{fontSize:'.75rem',color:'var(--t1)',marginBottom:2}}><strong style={{color:'var(--t0)'}}>Prospect:</strong> {t.userMessage}</div>
                        <div style={{fontSize:'.75rem',color:'var(--t2)'}}><strong style={{color:'var(--gold)'}}>{t.agentName||'Lucy'}:</strong> {t.agentReply}</div>
                      </div>
                    ))}
                  </div>}
                </td></tr>
              )}
            </React.Fragment>
          ))}{leads.length===0&&<tr><td colSpan={8} style={{color:'var(--t3)'}}>No leads{statusFilter?` with status ${LEAD_STATUS_LABEL[statusFilter]}`:''} yet.</td></tr>}</tbody>
        </table>
      </div>
    </div>
  )
}

// S553: usage / quality / capacity dashboard over agent_interaction_logs.
// Shed turns (the concurrency gate rejecting under overload) are the
// "buy bigger hardware" alarm — anything > 0 goes red.
function AgentAnalytics(){
  const[days,setDays]=useState(30)
  const{data,isLoading}=useQuery(['agent-analytics',days],()=>get<any>(`/admin/agent-analytics?days=${days}`),{refetchInterval:60000,keepPreviousData:true})
  if(isLoading&&!data)return<div style={{padding:32,color:'var(--t3)'}}>Loading agent analytics…</div>
  const s=data?.summary||{}
  const daily:any[]=data?.daily||[]
  const hourly:any[]=data?.hourly||[]
  const byAudience:any[]=data?.byAudience||[]
  const byAgent:any[]=data?.byAgent||[]
  const topTools:any[]=data?.topTools||[]
  const heaviestUsers:any[]=data?.heaviestUsers||[]
  const shed=Number(s.shed||0)
  const escRate=s.turns>0?Math.round((s.humanEscalations/s.turns)*100):0
  const tokens=Number(s.promptTokens||0)+Number(s.completionTokens||0)
  const fmtK=(n:number)=>n>=1_000_000?(n/1_000_000).toFixed(1)+'M':n>=1000?(n/1000).toFixed(1)+'k':String(n)
  const maxHour=Math.max(1,...hourly.map(h=>h.turns))
  const hourMap=new Map(hourly.map(h=>[h.hour,h.turns]))
  return(
    <div>
      <div className="ph">
        <div><h1 className="pt">Agent Analytics</h1><p className="ps">In-house AI agent usage, quality, and capacity · auto-refreshes every 60s</p></div>
        <div style={{display:'flex',gap:6}}>
          {[7,30,90].map(d=>(
            <button key={d} className={`btn bsm${days===d?' bgold':' bd'}`} onClick={()=>setDays(d)}>{d}d</button>
          ))}
        </div>
      </div>

      {shed>0&&(
        <div className="card" style={{borderColor:'#ef4444',marginBottom:16,display:'flex',gap:14,alignItems:'center'}}>
          <div style={{width:12,height:12,borderRadius:'50%',background:'#ef4444',boxShadow:'0 0 12px #ef4444',flexShrink:0}}/>
          <div>
            <div style={{fontWeight:700,color:'#ef4444',fontSize:'.95rem'}}>{shed} turn{shed===1?'':'s'} shed under overload in the last {days} days</div>
            <div style={{fontSize:'.78rem',color:'var(--t2)',marginTop:2}}>The concurrency gate rejected real customer turns — the model fleet is too small for demand. Time to buy bigger hardware (or raise AGENT_MAX_CONCURRENCY if the fleet has headroom).</div>
          </div>
        </div>
      )}

      <div className="grid3" style={{marginBottom:16}}>
        <div className="kpi"><div className="kl">Turns</div><div className="kv">{fmtK(Number(s.turns||0))}</div><div style={{fontSize:'.68rem',color:'var(--t3)'}}>{fmtK(Number(s.conversations||0))} conversations · {fmtK(Number(s.uniqueUsers||0))} users</div></div>
        <div className="kpi"><div className="kl">Latency</div><div className="kv">{s.avgLatencyMs!=null?`${(s.avgLatencyMs/1000).toFixed(1)}s`:'—'}</div><div style={{fontSize:'.68rem',color:'var(--t3)'}}>p95 {s.p95LatencyMs!=null?`${(s.p95LatencyMs/1000).toFixed(1)}s`:'—'}</div></div>
        <div className="kpi"><div className="kl">Tokens</div><div className="kv">{fmtK(tokens)}</div><div style={{fontSize:'.68rem',color:'var(--t3)'}}>{fmtK(Number(s.promptTokens||0))} prompt · {fmtK(Number(s.completionTokens||0))} completion</div></div>
        <div className="kpi"><div className="kl">Human escalations</div><div className="kv">{Number(s.humanEscalations||0)}</div><div style={{fontSize:'.68rem',color:'var(--t3)'}}>{escRate}% of turns</div></div>
        <div className="kpi"><div className="kl">Tool turns</div><div className="kv">{Number(s.toolTurns||0)}</div><div style={{fontSize:'.68rem',color:'var(--t3)'}}>turns where the agent used account data or took an action</div></div>
        <div className="kpi"><div className="kl">Errors · Shed</div><div className="kv" style={{color:(Number(s.errors||0)+shed)>0?'#ef4444':undefined}}>{Number(s.errors||0)} · {shed}</div><div style={{fontSize:'.68rem',color:'var(--t3)'}}>errored turns · capacity-shed turns</div></div>
      </div>

      <div className="card" style={{marginBottom:16}}>
        <div style={{fontWeight:700,color:'var(--t0)',marginBottom:10}}>Daily turns</div>
        <div style={{height:180}}>
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={daily} margin={{top:0,right:0,left:-20,bottom:0}}>
              <XAxis dataKey="day" tick={{fontSize:10,fill:'var(--t3)'}} tickLine={false} axisLine={false}/>
              <YAxis tick={{fontSize:10,fill:'var(--t3)'}} tickLine={false} axisLine={false} allowDecimals={false}/>
              <Tooltip contentStyle={{background:'var(--s1)',border:'1px solid var(--b1)',borderRadius:8,fontSize:'.75rem'}}/>
              <Area type="monotone" dataKey="turns" stroke="var(--gold)" fill="var(--gold)" fillOpacity={0.15} strokeWidth={2}/>
              <Area type="monotone" dataKey="escalations" stroke="#ef4444" fill="#ef4444" fillOpacity={0.1} strokeWidth={1.5}/>
            </AreaChart>
          </ResponsiveContainer>
        </div>
        <div style={{fontSize:'.68rem',color:'var(--t3)',marginTop:4}}>Gold = turns · red = human escalations</div>
      </div>

      <div className="card" style={{marginBottom:16}}>
        <div style={{fontWeight:700,color:'var(--t0)',marginBottom:10}}>Turns by hour of day <span style={{fontWeight:400,color:'var(--t3)',fontSize:'.72rem'}}>(peak-load shape — size the fleet for the tallest bars)</span></div>
        <div style={{display:'flex',alignItems:'flex-end',gap:3,height:90}}>
          {Array.from({length:24},(_,h)=>{
            const n=Number(hourMap.get(h)||0)
            return(
              <div key={h} style={{flex:1,display:'flex',flexDirection:'column',alignItems:'center',gap:3}} title={`${h}:00 — ${n} turn${n===1?'':'s'}`}>
                <div style={{width:'100%',borderRadius:2,background:n>0?'var(--gold)':'var(--b1)',opacity:n>0?0.35+0.65*(n/maxHour):1,height:`${Math.max(3,(n/maxHour)*70)}px`}}/>
                {h%4===0&&<div style={{fontSize:'.58rem',color:'var(--t3)'}}>{h}</div>}
              </div>
            )
          })}
        </div>
      </div>

      <div className="grid2" style={{marginBottom:16}}>
        <div className="card">
          <div style={{fontWeight:700,color:'var(--t0)',marginBottom:10}}>By audience</div>
          <table className="tbl"><thead><tr><th>Audience</th><th>Turns</th><th>Escalations</th><th>Avg latency</th></tr></thead>
            <tbody>{byAudience.map(a=>(
              <tr key={a.audience}><td style={{textTransform:'capitalize'}}>{a.audience}</td><td>{a.turns}</td><td>{a.escalations}</td><td>{a.avgLatencyMs!=null?`${(a.avgLatencyMs/1000).toFixed(1)}s`:'—'}</td></tr>
            ))}{byAudience.length===0&&<tr><td colSpan={4} style={{color:'var(--t3)'}}>No agent traffic in this window.</td></tr>}</tbody>
          </table>
        </div>
        <div className="card">
          <div style={{fontWeight:700,color:'var(--t0)',marginBottom:10}}>Top tools</div>
          <table className="tbl"><thead><tr><th>Tool</th><th>Calls</th></tr></thead>
            <tbody>{topTools.map(t=>(
              <tr key={t.name}><td style={{fontFamily:'var(--mono, monospace)',fontSize:'.72rem'}}>{t.name}</td><td>{t.calls}</td></tr>
            ))}{topTools.length===0&&<tr><td colSpan={2} style={{color:'var(--t3)'}}>No tool calls in this window.</td></tr>}</tbody>
          </table>
        </div>
      </div>

      <div className="card" style={{marginBottom:16}}>
        <div style={{fontWeight:700,color:'var(--t0)',marginBottom:10}}>By agent</div>
        <table className="tbl"><thead><tr><th>Agent</th><th>Profile</th><th>Turns</th><th>Tool turns</th><th>Human escalations</th></tr></thead>
          <tbody>{byAgent.map(a=>(
            <tr key={a.profileId}><td>{a.agentName}</td><td style={{color:'var(--t3)',fontSize:'.72rem'}}>{a.profileId}</td><td>{a.turns}</td><td>{a.toolTurns}</td><td>{a.escalations}</td></tr>
          ))}{byAgent.length===0&&<tr><td colSpan={5} style={{color:'var(--t3)'}}>No agent traffic in this window.</td></tr>}</tbody>
        </table>
      </div>

      <div className="card">
        <div style={{fontWeight:700,color:'var(--t0)',marginBottom:10}}>Heaviest users <span style={{fontWeight:400,color:'var(--t3)',fontSize:'.72rem'}}>(unproductive = off-topic turns that count toward the daily budget; capped = turns refused by it)</span></div>
        <table className="tbl"><thead><tr><th>User</th><th>Role</th><th>Turns</th><th>Unproductive</th><th>Capped</th><th>Last seen</th></tr></thead>
          <tbody>{heaviestUsers.map(h=>(
            <tr key={h.actorUserId}>
              <td>{h.email}</td><td style={{textTransform:'capitalize'}}>{h.role}</td><td>{h.turns}</td>
              <td style={{color:Number(h.unproductive)>0?'#f59e0b':undefined}}>{h.unproductive}</td>
              <td style={{color:Number(h.cappedTurns)>0?'#ef4444':undefined}}>{h.cappedTurns}</td>
              <td style={{color:'var(--t3)',fontSize:'.72rem'}}>{h.lastSeen?new Date(h.lastSeen).toLocaleString():'—'}</td>
            </tr>
          ))}{heaviestUsers.length===0&&<tr><td colSpan={6} style={{color:'var(--t3)'}}>No agent traffic in this window.</td></tr>}</tbody>
        </table>
      </div>
    </div>
  )
}

const INCOME_COLORS:Record<string,string>={platform_unit:'#c9a227',processing:'#3b82f6',flexpay:'#22c55e',flex_deposit:'#ec4899',flex_credit:'#eab308',business_pos:'#06b6d4',placement:'#f97316',instant_withdrawal:'#14b8a6',background_checks:'#e10600'}
const incomeColorOf=(k:string)=>INCOME_COLORS[k]||'#94a3b8'

function Overview(){
  const{user}=useAuth()
  const navigate=useNavigate()
  const isSuperAdmin=user?.role==='super_admin'
  const{data:income}=useQuery('income-projection',()=>get<any>('/admin/income/projection'),{enabled:!!user,staleTime:60000,refetchOnWindowFocus:false})
  const{data:compositionAll}=useQuery('income-composition-all',()=>get<any>('/admin/income/composition/all'),{enabled:!!user,staleTime:60000,refetchOnWindowFocus:false})
  const[breakdownWindow,setBreakdownWindow]=React.useState<string|null>(null)
  const{data:breakdown,isLoading:breakdownLoading}=useQuery(['income-breakdown',breakdownWindow],()=>get<any>(`/admin/income/breakdown?window=${breakdownWindow}`),{enabled:!!user&&!!breakdownWindow,staleTime:30000})
  const{data:stats,isLoading}=useQuery(['admin-overview',user?.id],()=>get<any>('/admin/overview'),{refetchInterval:30000,enabled:!!user,staleTime:30000,keepPreviousData:true})
  const{data:openDisputes=[]}=useQuery<any[]>('overview-open-disputes',()=>get<any[]>('/credit/disputes?status=open'),{enabled:!!user,staleTime:60000,refetchInterval:60000})
  // FlexPay float bankroll = rent of INCOME-VERIFIED FlexPay tenants (approved
  // inquiries) — the money GAM would actually front. No phases; scales with
  // enrollment.
  const floatBankroll=stats?.flexpayBankroll||0
  // Default reserve target = flat 3% default rate applied to the FlexPay FLOAT
  // (the money at risk), NOT total platform rent. Covers FlexPay defaults.
  const DEFAULT_RESERVE_RATE=0.03
  const reserveTarget=floatBankroll*DEFAULT_RESERVE_RATE
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
          <div className="kv gold">{(stats?.flexCredit||0)+(stats?.flexDeposit||0)+(stats?.flexPay||0)}</div>
          <div className="ks" style={{marginTop:6,display:'grid',gridTemplateColumns:'1fr 1fr',gap:'2px 12px'}}>
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
        <div className="kpi"><div className="kl">Default Reserve</div><div className={`kv ${reservePct>=100?'g':reservePct>=50?'a':'r'}`}>{formatCurrency(stats?.reserveBalance||0)}</div><div className="ks">{reservePct.toFixed(0)}% of {formatCurrency(reserveTarget)} target (3% of FlexPay float)</div></div>
        <div className="kpi"><div className="kl">FlexPay Float Bankroll</div><div className="kv b">{formatCurrency(floatBankroll)}</div><div className="ks">rent of income-verified tenants who requested FlexPay</div></div>
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
          <div className="ct">FlexPay Reserve &amp; Float</div>
          <div className="dr"><span className="dk">Default reserve balance</span><span className="dv mono">{formatCurrency(stats?.reserveBalance||0)}</span></div>
          <div className="dr"><span className="dk">Target (3% of FlexPay float)</span><span className="dv mono">{formatCurrency(reserveTarget)}</span></div>
          <div className="dr"><span className="dk">Coverage</span><span className={`badge ${reservePct>=100?'bg2':reservePct>=50?'ba':'br'}`}>{reservePct.toFixed(0)}%</span></div>
          <div className="dr"><span className="dk">Float bankroll needed</span><span className="dv mono">{formatCurrency(floatBankroll)}</span></div>
          <div style={{fontSize:'.68rem',color:'var(--t3)',marginTop:8,lineHeight:1.5}}>Reserve absorbs FlexPay defaults — 3% of the FlexPay float (money at risk), not total rent. Bankroll = rent of income-verified tenants who requested FlexPay (survey inquiry approved) — the capital to front if they enroll. Verified SSI/SSDI income without a FlexPay request does NOT count. Float yield income begins at ODFI partnership.</div>
        </div>
      </div>}
      {isSuperAdmin&&<>
      {/* ── Platform Revenue: recurring ARR + full income composition ── */}
      {(()=>{
        const colorOf=incomeColorOf
        const SRC=[
          {key:'platform_unit',label:'Platform Fees',recurring:true},
          {key:'processing',label:'Processing / ACH',recurring:true},
          {key:'flexpay',label:'FlexPay',recurring:true},
          {key:'flex_deposit',label:'FlexDeposit Custody',recurring:true},
          {key:'flex_credit',label:'FlexCredit',recurring:true},
          {key:'business_pos',label:'Business Fees',recurring:true},
          {key:'placement',label:'Placement Fees',recurring:false},
          {key:'instant_withdrawal',label:'Instant Withdrawals',recurring:false},
          {key:'background_checks',label:'Background Checks',recurring:false},
        ]
        const recurringMonthly=income?.monthly?.total||0
        const periods:any[]=compositionAll?.periods||[]
        // Small-donut geometry (stroke-dasharray technique).
        const R=40,SW=12,C=2*Math.PI*R
        return(
          <div className="card" style={{marginTop:4,background:'linear-gradient(135deg,rgba(201,162,39,.06) 0%,rgba(8,10,12,0) 60%)',border:'1px solid rgba(201,162,39,.2)'}}>
            {/* Recurring ARR — one-time revenue is NEVER in these two numbers */}
            <div style={{display:'flex',alignItems:'flex-start',justifyContent:'space-between',marginBottom:20,paddingBottom:20,borderBottom:'1px solid var(--b0)'}}>
              <div>
                <div style={{fontSize:'.65rem',color:'var(--t3)',textTransform:'uppercase',letterSpacing:'.12em',marginBottom:6}}>Recurring Revenue</div>
                <div style={{fontFamily:'var(--font-d)',fontSize:'2.8rem',fontWeight:800,color:'var(--gold)',lineHeight:1}}>{formatCurrency(recurringMonthly)}</div>
                <div style={{fontSize:'.78rem',color:'var(--t3)',marginTop:6}}>per month · recurring only</div>
              </div>
              <div style={{textAlign:'right'}}>
                <div style={{fontSize:'.65rem',color:'var(--t3)',textTransform:'uppercase',letterSpacing:'.12em',marginBottom:6}}>Annual Run Rate</div>
                <div style={{fontFamily:'var(--font-d)',fontSize:'1.8rem',fontWeight:800,color:'var(--green)',lineHeight:1}}>{formatCurrency(income?.annual||0)}</div>
                <div style={{fontSize:'.72rem',color:'var(--t3)',marginTop:6}}>ARR · recurring × 12</div>
              </div>
            </div>
            {/* Income composition — a wall of pies, one per time window */}
            <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',gap:12,flexWrap:'wrap',marginBottom:16}}>
              <div style={{fontSize:'.65rem',color:'var(--t3)',textTransform:'uppercase',letterSpacing:'.12em'}}>Income composition by period <span style={{color:'var(--t3)',opacity:.7,textTransform:'none',letterSpacing:0}}>(incl. one-time)</span></div>
              <div style={{display:'flex',gap:14,flexWrap:'wrap'}}>
                {SRC.map(s=>(
                  <div key={s.key} style={{display:'flex',alignItems:'center',gap:6}}>
                    <div style={{width:9,height:9,borderRadius:'50%',background:colorOf(s.key),flexShrink:0}}/>
                    <span style={{fontSize:'.7rem',color:'var(--t2)'}}>{s.label}</span>
                  </div>
                ))}
              </div>
            </div>
            <div style={{display:'flex',gap:16,flexWrap:'wrap',justifyContent:'space-between'}}>
              {periods.length===0&&<div style={{color:'var(--t3)',fontSize:'.8rem',padding:'24px 0',width:'100%',textAlign:'center'}}>Loading…</div>}
              {periods.map((p:any)=>{
                const g=p.gross||0
                let acc=0
                const segs=(p.sources||[]).filter((s:any)=>s.amount>0).map((s:any)=>{const len=g>0?(s.amount/g)*C:0;const o=acc;acc+=len;return{key:s.key,len,off:o}})
                return(
                  <div key={p.window} onClick={()=>setBreakdownWindow(p.window)} title={`View ${p.label} breakdown`}
                    style={{flex:'1 1 130px',minWidth:120,maxWidth:180,textAlign:'center',cursor:'pointer',borderRadius:10,padding:'6px 4px',transition:'background .15s'}}
                    onMouseEnter={e=>{(e.currentTarget as HTMLDivElement).style.background='rgba(201,162,39,.07)'}}
                    onMouseLeave={e=>{(e.currentTarget as HTMLDivElement).style.background='transparent'}}>
                    <div style={{fontSize:'.72rem',color:'var(--t1)',fontWeight:600,marginBottom:8}}>{p.label}</div>
                    <svg width={112} height={112} viewBox="0 0 104 104" style={{maxWidth:'100%'}}>
                      <circle cx={52} cy={52} r={R} fill="none" stroke="var(--bg3)" strokeWidth={SW}/>
                      {segs.map((s:any)=>(
                        <circle key={s.key} cx={52} cy={52} r={R} fill="none" stroke={colorOf(s.key)} strokeWidth={SW}
                          strokeDasharray={`${s.len} ${C-s.len}`} strokeDashoffset={-s.off} transform="rotate(-90 52 52)"/>
                      ))}
                      <text x={52} y={56} textAnchor="middle" style={{fill:'var(--t0)',fontSize:13,fontWeight:800,fontFamily:'var(--font-d)'}}>{formatCurrency(g)}</text>
                    </svg>
                  </div>
                )
              })}
            </div>
          </div>
        )
      })()}
      {breakdownWindow&&(
        <div style={{position:'fixed',inset:0,background:'rgba(0,0,0,.72)',zIndex:200,display:'flex',alignItems:'center',justifyContent:'center',padding:20}} onClick={e=>{if(e.target===e.currentTarget)setBreakdownWindow(null)}}>
          <div style={{background:'var(--bg2)',border:'1px solid var(--b1)',borderRadius:14,width:'100%',maxWidth:640,maxHeight:'85vh',overflowY:'auto',padding:24}}>
            <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',marginBottom:18,paddingBottom:16,borderBottom:'1px solid var(--b0)'}}>
              <div>
                <div style={{fontSize:'.65rem',color:'var(--t3)',textTransform:'uppercase',letterSpacing:'.12em',marginBottom:4}}>Income breakdown</div>
                <div style={{fontFamily:'var(--font-d)',fontSize:'1.3rem',fontWeight:800,color:'var(--t0)'}}>{breakdown?.label||''}</div>
                <div style={{fontSize:'.8rem',color:'var(--gold)',fontWeight:700,marginTop:2,fontFamily:'var(--font-m)'}}>{formatCurrency(breakdown?.gross||0)} total</div>
              </div>
              <button onClick={()=>setBreakdownWindow(null)} style={{background:'none',border:'none',color:'var(--t3)',fontSize:'1.4rem',cursor:'pointer',lineHeight:1}}>×</button>
            </div>
            {breakdownLoading?<div style={{padding:32,textAlign:'center',color:'var(--t3)'}}>Loading…</div>:(
              <div style={{display:'flex',flexDirection:'column',gap:16}}>
                {(breakdown?.sources||[]).map((s:any)=>{
                  const pct=breakdown?.gross>0?(s.amount/breakdown.gross)*100:0
                  const zero=s.amount===0&&s.count===0
                  return(
                    <div key={s.key} style={{display:'flex',alignItems:'center',justifyContent:'space-between',gap:10,opacity:zero?.5:1}}>
                      <div style={{display:'flex',alignItems:'center',gap:8}}>
                        <div style={{width:11,height:11,borderRadius:'50%',background:incomeColorOf(s.key),flexShrink:0}}/>
                        <span style={{fontSize:'.85rem',color:'var(--t0)',fontWeight:600}}>{s.label}</span>
                        {s.count>0&&<span style={{fontSize:'.68rem',color:'var(--t3)'}}>{s.count} item{s.count===1?'':'s'}</span>}
                      </div>
                      <div style={{display:'flex',alignItems:'baseline',gap:8}}>
                        <span style={{fontFamily:'var(--font-m)',fontSize:'.85rem',color:'var(--t0)',fontWeight:700}}>{formatCurrency(s.amount)}</span>
                        <span style={{fontFamily:'var(--font-m)',fontSize:'.7rem',color:'var(--t3)',width:40,textAlign:'right'}}>{pct.toFixed(0)}%</span>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        </div>
      )}
      </> }
      <DepositTrust/>
    </div>
  )
}

// ── DEPOSITS HELD IN TRUST (S602) ──────────────────────────────
// What SHOULD be sitting in the segregated deposit trust account right now:
// every tenant deposit GAM holds in escrow (principal), + interest owed on top.
function DepositTrust(){
  const{user}=useAuth()
  const{data,isLoading}=useQuery<any>('deposit-trust-summary',()=>get<any>('/admin/deposit-trust/summary'),{enabled:!!user,staleTime:60000,refetchOnWindowFocus:false})
  if(!user)return null
  const d=data||{heldCount:0,totalPrincipal:0,totalInterestAccrued:0,totalLiability:0,byState:[]}
  const R=40,SW=12,C=2*Math.PI*R
  const palette=['#c9a227','#4f9d69','#5b8def','#c9635b','#8d6fd6','#3fb6b6','#d08a3f','#9d9d9d']
  const states=(d.byState||[]).filter((s:any)=>s.principal>0)
  const g=states.reduce((sum:number,s:any)=>sum+s.principal,0)
  let acc=0
  const segs=states.map((s:any,i:number)=>{const len=g>0?(s.principal/g)*C:0;const o=acc;acc+=len;return{state:s.state,principal:s.principal,len,off:o,color:palette[i%palette.length]}})
  return(
    <div className="card" style={{marginTop:20,padding:24}}>
      <div style={{display:'flex',alignItems:'flex-start',justifyContent:'space-between',flexWrap:'wrap',gap:16,marginBottom:16}}>
        <div>
          <div style={{fontSize:'.65rem',color:'var(--t3)',textTransform:'uppercase',letterSpacing:'.12em',marginBottom:6}}>Deposits held in trust</div>
          <div style={{fontFamily:'var(--font-d)',fontSize:'2.4rem',fontWeight:800,color:'var(--gold)',lineHeight:1}}>{formatCurrency(d.totalPrincipal)}</div>
          <div style={{fontSize:'.78rem',color:'var(--t3)',marginTop:6}}>{d.heldCount} deposit{d.heldCount===1?'':'s'} · should be in the trust account now</div>
          {d.totalInterestAccrued>0&&<div style={{fontSize:'.74rem',color:'var(--t2)',marginTop:8}}>+ {formatCurrency(d.totalInterestAccrued)} interest owed → {formatCurrency(d.totalLiability)} total liability</div>}
        </div>
        {g>0&&(
          <svg width={112} height={112} viewBox="0 0 104 104" style={{maxWidth:'100%'}}>
            <circle cx={52} cy={52} r={R} fill="none" stroke="var(--bg3)" strokeWidth={SW}/>
            {segs.map((s:any)=>(
              <circle key={s.state} cx={52} cy={52} r={R} fill="none" stroke={s.color} strokeWidth={SW}
                strokeDasharray={`${s.len} ${C-s.len}`} strokeDashoffset={-s.off} transform="rotate(-90 52 52)"/>
            ))}
            <text x={52} y={56} textAnchor="middle" style={{fill:'var(--t0)',fontSize:12,fontWeight:800,fontFamily:'var(--font-d)'}}>{states.length} state{states.length===1?'':'s'}</text>
          </svg>
        )}
      </div>
      {isLoading?<div style={{color:'var(--t3)',fontSize:'.8rem'}}>Loading…</div>:g>0?(
        <div style={{display:'flex',gap:14,flexWrap:'wrap'}}>
          {segs.map((s:any)=>{const pct=g>0?(s.principal/g)*100:0;return(
            <div key={s.state} style={{display:'flex',alignItems:'center',gap:6}}>
              <div style={{width:9,height:9,borderRadius:'50%',background:s.color,flexShrink:0}}/>
              <span style={{fontSize:'.72rem',color:'var(--t2)'}}>{s.state} · {formatCurrency(s.principal)} ({pct.toFixed(0)}%)</span>
            </div>
          )})}
        </div>
      ):<div style={{color:'var(--t3)',fontSize:'.82rem'}}>No deposits are being held in trust yet.</div>}
    </div>
  )
}

// ── LANDLORDS ─────────────────────────────────────────────────
function Landlords(){
  const{user}=useAuth()
  const qc=useQueryClient()
  const isSuper=user?.role==='super_admin'
  const{data:landlords=[],isLoading}=useQuery<any[]>('landlords',()=>get('/landlords'),{enabled:!!user,refetchOnWindowFocus:false})
  const{data:referral}=useQuery<any>('my-referral',()=>get('/admin/my-referral'),{enabled:!!user,staleTime:300000})
  const{data:pmRoster=[]}=useQuery<any[]>('portfolio-managers',()=>get('/admin/portfolio-managers'),{enabled:!!user&&isSuper,staleTime:300000})
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
  const[copied,setCopied]=React.useState(false)

  const resend=async(type:string,id:string)=>{
    setResending(type)
    try{ const r=await post<{message?:string}>('/admin/onboarding/resend',{type,targetId:id}); setMsg(r?.message||'Sent'); setTimeout(()=>setMsg(''),4000) }
    catch(e:any){ setMsg('Failed: '+(e?.response?.data?.error||e.message)) }
    finally{ setResending(null) }
  }
  const refreshLL=()=>{ qc.invalidateQueries('landlords'); qc.invalidateQueries(['landlord-detail',selected?.id]) }
  const assign=async(id:string,role:'closing'|'service',managerId:string|null)=>{
    try{ await post('/admin/landlords/'+id+'/assign',{role,managerId}); refreshLL(); setMsg('Updated'); setTimeout(()=>setMsg(''),3000) }
    catch(e:any){ setMsg('Failed: '+(e?.response?.data?.error||e.message)) }
  }
  const copyRef=()=>{ if(referral?.referralLink){ navigator.clipboard?.writeText(referral.referralLink); setCopied(true); setTimeout(()=>setCopied(false),2000) } }
  const pmName=(l:any,role:'closing'|'service')=>{
    if(role==='closing') return l.portfolioManagerId?`${l.pmFirstName||''} ${l.pmLastName||''}`.trim():null
    return l.serviceManagerId?`${l.smFirstName||''} ${l.smLastName||''}`.trim():null
  }

  return(
    <div>
      <div className="ph"><div><h1 className="pt">Landlords</h1><p className="ps">{(landlords as any[]).length} in your portfolio{isSuper?' (all)':''}</p></div></div>
      {referral&&<div className="card" style={{marginBottom:12,padding:'10px 14px',display:'flex',alignItems:'center',gap:12,flexWrap:'wrap'}}>
        <div><div style={{fontSize:'.65rem',color:'var(--t3)',textTransform:'uppercase',letterSpacing:.4}}>Your referral link</div>
          <div className="mono" style={{fontSize:'.78rem',color:'var(--t0)'}}>{referral.referralLink||'—'}</div></div>
        <div style={{marginLeft:'auto',display:'flex',alignItems:'center',gap:8}}>
          <span className="badge bg2">Code {referral.referralCode||'—'}</span>
          <button className="btn bg-btn" style={{padding:'5px 12px'}} onClick={copyRef}>{copied?'Copied ✓':'Copy link'}</button>
        </div>
        <div style={{flexBasis:'100%',fontSize:'.66rem',color:'var(--t3)'}}>A landlord who signs up through your link is credited to you as the closing manager.</div>
      </div>}
      {msg&&<div className={`alert ${msg.startsWith('F')?'ae':'ag'}`} style={{marginBottom:12}}>{msg}</div>}
      <div className="grid2" style={{gap:16,alignItems:'start'}}>
        <div className="card" style={{padding:0}}>
          <div style={{padding:'10px 12px',borderBottom:'1px solid var(--b0)'}}><input type="text" placeholder="Search landlords…" value={lSearch} onChange={e=>setLSearch(e.target.value)} style={{width:'100%',background:'var(--bg3)',border:'1px solid var(--b1)',borderRadius:7,color:'var(--t0)',padding:'7px 10px',fontSize:'.78rem',outline:'none'}}/></div>
          {isLoading?<div style={{padding:32,color:'var(--t3)',textAlign:'center'}}>Loading…</div>:(
            <table className="tbl">
              <thead><tr><th>Landlord</th><th>Units</th><th>Portfolio</th><th>Bank</th><th>Onboarded</th></tr></thead>
              <tbody>
                {filteredLandlords.length?filteredLandlords.map((l:any)=>{
                  const closer=pmName(l,'closing'), cs=pmName(l,'service')
                  const referrer=l.referredByUserId?`${l.referrerFirstName||''} ${l.referrerLastName||''}`.trim():null
                  const selfClosed=!l.portfolioManagerId&&!referrer
                  return(
                  <tr key={l.id} style={{cursor:'pointer',background:selected?.id===l.id?'rgba(201,162,39,.05)':''}} onClick={()=>setSelected(l)}>
                    <td><div style={{fontWeight:600,color:'var(--t0)'}}>{l.firstName} {l.lastName}</div><div style={{fontSize:'.68rem',color:'var(--t3)'}}>{l.businessName||l.email}</div></td>
                    <td className="mono">{l.unitCount} <span style={{color:'var(--t3)'}}>({l.occupiedCount} occ)</span></td>
                    <td style={{fontSize:'.68rem'}}>
                      {referrer?<div style={{color:'var(--t2)'}}>Referral: {referrer}</div>:selfClosed?<span className="badge ba">Self-closed</span>:<div style={{color:'var(--t2)'}}>Close: {closer||'—'}</div>}
                      <div style={{color:cs?'var(--t2)':'var(--red)'}}>CS: {closer&&!referrer&&!l.serviceManagerId?closer:(cs||'unstaffed')}</div>
                    </td>
                    <td><span className={`badge ${l.bankAccountReady?'bg2':'br'}`}>{l.bankAccountReady?'✓':'Missing'}</span></td>
                    <td><span className={`badge ${l.onboardingComplete?'bg2':'ba'}`}>{l.onboardingComplete?'Done':'Pending'}</span></td>
                  </tr>
                )}):<tr><td colSpan={5} style={{textAlign:'center',color:'var(--t3)',padding:32}}>No landlords yet.</td></tr>}
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
              <div className="ct">Portfolio Management</div>
              {(()=>{ const l=selected; const closer=pmName(l,'closing'); const cs=pmName(l,'service'); const meId=user?.id
                const referrer=l.referredByUserId?`${l.referrerFirstName||''} ${l.referrerLastName||''}`.trim():null
                const pmCloserDoesCs=!!l.portfolioManagerId&&!referrer
                return(<div style={{marginBottom:16,fontSize:'.78rem'}}>
                  <div style={{display:'flex',justifyContent:'space-between',padding:'6px 0',borderBottom:'1px solid var(--b0)'}}>
                    <span style={{color:'var(--t3)'}}>Closing (25¢/occ · residual)</span>
                    <span style={{color:'var(--t0)'}}>{referrer?<span>{referrer} <span className="badge bg2">landlord referral</span></span>:(closer||<span className="badge ba">Self-closed → pot</span>)}</span>
                  </div>
                  <div style={{display:'flex',justifyContent:'space-between',padding:'6px 0'}}>
                    <span style={{color:'var(--t3)'}}>Customer service (25¢/occ)</span>
                    <span style={{color:'var(--t0)'}}>{pmCloserDoesCs?(closer+' (closer)'):(cs||<span className="badge br">Unstaffed</span>)}</span>
                  </div>
                  {isSuper?(
                    <div style={{marginTop:10,display:'grid',gap:8}}>
                      {referrer
                        ? <div style={{fontSize:'.66rem',color:'var(--t3)'}}>Closing earned by the referring landlord — not reassignable.</div>
                        : <label style={{fontSize:'.66rem',color:'var(--t3)'}}>Closing manager
                        <select value={l.portfolioManagerId||''} onChange={e=>assign(l.id,'closing',e.target.value||null)} style={{width:'100%',marginTop:3,background:'var(--bg3)',border:'1px solid var(--b1)',borderRadius:6,color:'var(--t0)',padding:'6px 8px',fontSize:'.76rem'}}>
                          <option value="">— Self-closed (pot) —</option>
                          {(pmRoster as any[]).map(p=><option key={p.id} value={p.id}>{p.firstName} {p.lastName}</option>)}
                        </select></label>}
                      <label style={{fontSize:'.66rem',color:'var(--t3)'}}>Customer-service manager {pmCloserDoesCs&&<span style={{color:'var(--amber)'}}>(closer handles CS unless overridden)</span>}
                        <select value={l.serviceManagerId||''} onChange={e=>assign(l.id,'service',e.target.value||null)} style={{width:'100%',marginTop:3,background:'var(--bg3)',border:'1px solid var(--b1)',borderRadius:6,color:'var(--t0)',padding:'6px 8px',fontSize:'.76rem'}}>
                          <option value="">— {pmCloserDoesCs?'Closer handles CS':'Unstaffed'} —</option>
                          {(pmRoster as any[]).map(p=><option key={p.id} value={p.id}>{p.firstName} {p.lastName}</option>)}
                        </select></label>
                    </div>
                  ):(
                    l.serviceManagerId===meId&&<div style={{marginTop:10}}><span className="badge bg2">You handle customer service</span></div>
                  )}
                </div>)})()}
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
                    <td><span className={`badge ${u.status==='active'?'bg2':u.status==='delinquent'?'ba':u.status==='suspended'?'br':'bmu'}`}>{humanize(u.status)}</span></td>
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
              <div className="dr"><span className="dk">Status</span><span className={`badge ${selected.status==='active'?'bg2':selected.status==='delinquent'?'ba':selected.status==='suspended'?'br':'bmu'}`}>{humanize(selected.status)}</span></div>
              <div className="dr"><span className="dk">Rent</span><span className="dv mono">{formatCurrency(selected.rentAmount)}/mo</span></div>
              <div className="dr"><span className="dk">Deposit</span><span className="dv mono">{formatCurrency(selected.securityDeposit||0)}</span></div>
              <div className="dr"><span className="dk">Bedrooms</span><span className="dv">{selected.bedrooms||'—'}</span></div>
              <div className="dr"><span className="dk">Bathrooms</span><span className="dv">{selected.bathrooms||'—'}</span></div>
              <div className="dr"><span className="dk">Sq Ft</span><span className="dv">{selected.sqft?.toLocaleString()||'—'}</span></div>
              <div className="dr"><span className="dk">Listed</span><span className={`badge ${selected.listedVacant?'bg2':'bmu'}`}>{selected.listedVacant?'Yes':'No'}</span></div>
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
                  <td><span className={`badge ${l.eventType==='zero_tolerance_block'?'br':l.eventType==='velocity_flag'?'ba':'bmu'}`}>{humanize(l.eventType)}</span></td>
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

// ── SALES-TAX NEXUS MONITOR (S565) ───────────────────────────────────────
// GAM own-revenue by customer state vs each state's economic-nexus registration
// threshold. MONITORING ONLY — the dashboard never collects tax; the register
// action flips collection (gated separately in the screening-fee path).
const NEXUS_STATUS_BADGE:Record<string,string>={crossed:'br',approaching:'ba',registered:'bg2',under:'bmu',no_threshold:'bmu'}
const NEXUS_STATUS_LABEL:Record<string,string>={crossed:'Threshold crossed',approaching:'Approaching',registered:'Registered',under:'Under',no_threshold:'No sales tax'}
function NexusMonitor(){
  const{user}=useAuth()
  const qc=useQueryClient()
  const{data,isLoading}=useQuery('nexus',()=>get<any>('/admin/nexus/dashboard'),{enabled:!!user})
  const[confirm,setConfirm]=React.useState<any>(null) // {state, register, date, notes}
  const states:any[]=data?.states||[]
  const summary=data?.summary||{crossed:0,approaching:0,registered:0,under:0}
  const warnPct=Math.round((data?.warnFraction??0.8)*100)

  const recomputeMut=useMutation(()=>post('/admin/nexus/recompute'),{
    onSuccess:()=>{qc.invalidateQueries('nexus');toast('Nexus tally recomputed')},
  })
  const registerMut=useMutation((b:any)=>post('/admin/nexus/register',b),{
    onSuccess:()=>{qc.invalidateQueries('nexus');setConfirm(null);toast('Registration updated')},
  })

  // Show states that matter first: crossed, approaching, registered, then the
  // rest — but only ones with a threshold + some signal by default.
  const ORDER:Record<string,number>={crossed:0,approaching:1,registered:2,under:3,no_threshold:4}
  const sorted=[...states].sort((a,b)=>(ORDER[a.status]-ORDER[b.status])||(b.pctOfThreshold||0)-(a.pctOfThreshold||0)||a.stateCode.localeCompare(b.stateCode))
  const crossed=sorted.filter(s=>s.status==='crossed')

  return(
    <div>
      <div className="ph">
        <div><h1 className="pt">Sales-Tax Nexus Monitor</h1><p className="ps">GAM own-revenue by customer state vs economic-nexus thresholds</p></div>
        <button className="btn bgold bsm" onClick={()=>recomputeMut.mutate()} disabled={recomputeMut.isLoading}>{recomputeMut.isLoading?'Recomputing…':'↻ Recompute tally'}</button>
      </div>

      <div className="nacha-flag" style={{borderColor:'var(--b1)'}}>
        <div style={{fontSize:'.8rem',color:'var(--t2)',lineHeight:1.6}}>
          <strong style={{color:'var(--gold)',fontFamily:'var(--font-d)'}}>Monitoring only — this page collects no tax.</strong> Revenue counted conservatively (platform fee + screening + Flex fees, by customer state) to register <em>early</em>. A crossing means it's time to register; collection turns on only when you register a state <em>and</em> a screening service is taxable there. Thresholds + tax rates are research-grade — confirm with a tax pro before registering.
          {data?.computedAt&&<div style={{marginTop:6,color:'var(--t3)',fontSize:'.72rem'}}>Tally last computed {new Date(data.computedAt).toLocaleString()}</div>}
        </div>
      </div>

      <div className="grid4" style={{marginBottom:16}}>
        <div className="kpi"><div className="kl">Crossed</div><div className={`kv ${summary.crossed>0?'r':'g'}`}>{summary.crossed}</div><div className="ks">Register now</div></div>
        <div className="kpi"><div className="kl">Approaching</div><div className={`kv ${summary.approaching>0?'a':'g'}`}>{summary.approaching}</div><div className="ks">≥{warnPct}% of threshold</div></div>
        <div className="kpi"><div className="kl">Registered</div><div className="kv b">{summary.registered}</div><div className="ks">Collection live</div></div>
        <div className="kpi"><div className="kl">Under</div><div className="kv g">{summary.under}</div><div className="ks">Below warn line</div></div>
      </div>

      {crossed.length>0&&<div className="alert ae">🚨 {crossed.length} state{crossed.length>1?'s have':' has'} crossed the economic-nexus threshold: {crossed.map(s=>s.stateCode).join(', ')}. Register to begin collecting where taxable.</div>}

      <div className="card" style={{padding:0}}>
        <div style={{padding:'12px 14px',borderBottom:'1px solid var(--b1)'}}><div className="ct" style={{marginBottom:0}}>All states</div></div>
        {isLoading?<div style={{padding:32,color:'var(--t3)',textAlign:'center'}}>Loading…</div>:(
          <table className="tbl">
            <thead><tr><th>State</th><th>Measured revenue</th><th>Threshold</th><th style={{width:'26%'}}>Progress</th><th>Taxable</th><th>Status</th><th></th></tr></thead>
            <tbody>
              {sorted.map((s:any)=>{
                const pct=s.pctOfThreshold!=null?Math.min(s.pctOfThreshold,1.5):null
                const barColor=s.status==='crossed'?'var(--red)':s.status==='approaching'?'var(--amber,#d99e2b)':s.status==='registered'?'var(--gold)':'var(--green,#3fb950)'
                return(
                  <tr key={s.stateCode} style={{background:s.status==='crossed'?'rgba(239,68,68,.04)':''}}>
                    <td className="mono" style={{fontWeight:600,color:'var(--t0)'}}>{s.stateCode}</td>
                    <td className="mono">{formatCurrency(s.measureUsd)}</td>
                    <td className="mono" style={{color:'var(--t3)'}}>{s.thresholdUsd!=null?formatCurrency(s.thresholdUsd):'—'}</td>
                    <td>
                      {pct!=null?(
                        <div style={{display:'flex',alignItems:'center',gap:8}}>
                          <div style={{flex:1,height:7,background:'var(--bg3)',borderRadius:4,overflow:'hidden'}}><div style={{width:`${Math.min(pct*100,100)}%`,height:'100%',background:barColor,transition:'width .3s'}}/></div>
                          <span className="mono" style={{fontSize:'.68rem',color:'var(--t3)',minWidth:34,textAlign:'right'}}>{Math.round(s.pctOfThreshold*100)}%</span>
                        </div>
                      ):<span style={{color:'var(--t3)',fontSize:'.72rem'}}>no threshold</span>}
                    </td>
                    <td>{s.thresholdUsd==null?<span style={{color:'var(--t3)'}}>—</span>:<span className={`badge ${s.taxable?'ba':'bmu'}`}>{s.taxable?'Taxable':'$0'}</span>}</td>
                    <td><span className={`badge ${NEXUS_STATUS_BADGE[s.status]||'bmu'}`}>{NEXUS_STATUS_LABEL[s.status]||s.status}</span></td>
                    <td style={{textAlign:'right'}}>
                      {s.status!=='no_threshold'&&(
                        s.registered
                          ?<button className="btn bd bsm" style={{fontSize:'.7rem',padding:'3px 8px'}} onClick={()=>setConfirm({stateCode:s.stateCode,register:false})}>Unregister</button>
                          :<button className="btn bgold bsm" style={{fontSize:'.7rem',padding:'3px 8px'}} onClick={()=>setConfirm({stateCode:s.stateCode,register:true,date:new Date().toISOString().slice(0,10),notes:''})}>Register</button>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>

      {confirm&&(
        <div style={{position:'fixed',inset:0,background:'rgba(0,0,0,.7)',zIndex:200,display:'flex',alignItems:'center',justifyContent:'center',padding:20}} onClick={e=>{if(e.target===e.currentTarget)setConfirm(null)}}>
          <div style={{background:'var(--bg2)',border:'1px solid var(--b1)',borderRadius:12,padding:24,width:'100%',maxWidth:440}}>
            <div className="ct" style={{marginBottom:12}}>{confirm.register?'Register':'Unregister'} {confirm.stateCode}</div>
            <p style={{fontSize:'.8rem',color:'var(--t2)',lineHeight:1.6,marginBottom:16}}>
              {confirm.register
                ?<>Registering <strong>{confirm.stateCode}</strong> turns ON sales-tax collection there for any taxable screening service. Only do this once you've actually registered with the state.</>
                :<>Unregistering <strong>{confirm.stateCode}</strong> stops all sales-tax collection there.</>}
            </p>
            {confirm.register&&(
              <div style={{display:'flex',flexDirection:'column',gap:10,marginBottom:16}}>
                <label style={{fontSize:'.72rem',color:'var(--t3)'}}>Registration date
                  <input type="date" value={confirm.date} onChange={e=>setConfirm({...confirm,date:e.target.value})} style={{width:'100%',marginTop:4,background:'var(--bg3)',border:'1px solid var(--b1)',borderRadius:7,color:'var(--t0)',padding:'7px 10px',fontSize:'.78rem'}}/>
                </label>
                <label style={{fontSize:'.72rem',color:'var(--t3)'}}>Notes (optional)
                  <input type="text" value={confirm.notes} placeholder="permit #, filing cadence…" onChange={e=>setConfirm({...confirm,notes:e.target.value})} style={{width:'100%',marginTop:4,background:'var(--bg3)',border:'1px solid var(--b1)',borderRadius:7,color:'var(--t0)',padding:'7px 10px',fontSize:'.78rem'}}/>
                </label>
              </div>
            )}
            <div style={{display:'flex',gap:8,justifyContent:'flex-end'}}>
              <button className="btn bd" onClick={()=>setConfirm(null)}>Cancel</button>
              <button className="btn bgold" disabled={registerMut.isLoading} onClick={()=>registerMut.mutate({stateCode:confirm.stateCode,registered:confirm.register,registeredDate:confirm.date||null,notes:confirm.notes||null})}>{registerMut.isLoading?'Saving…':confirm.register?'Confirm register':'Confirm unregister'}</button>
            </div>
          </div>
        </div>
      )}
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
                  <td><span className="badge bmu">{humanize(p.type)}</span></td>
                  <td className="mono" style={{color:'var(--t0)',fontWeight:600}}>{formatCurrency(p.amount)}</td>
                  <td><span className={`badge ${ST[p.status]||'bmu'}`}>{humanize(p.status)}</span></td>
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
            <div className="dr"><span className="dk">Type</span><span className="dv">{humanize(selected.type)}</span></div>
            <div className="dr"><span className="dk">Amount</span><span className="dv mono" style={{color:'var(--gold)',fontWeight:700}}>{formatCurrency(selected.amount)}</span></div>
            <div className="dr"><span className="dk">Due Date</span><span className="dv mono">{new Date(selected.dueDate).toLocaleDateString()}</span></div>
            <div className="dr"><span className="dk">Status</span><span className={`badge ${ST[selected.status]||'bmu'}`}>{humanize(selected.status)}</span></div>
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
      <div className="ph"><div><h1 className="pt">Disbursements</h1><p className="ps">Landlord payouts from collected balances</p></div></div>
      <div className="alert agold">⚡ <strong>Auto-Friday payouts:</strong> Collected balances pay out to landlords every Friday. GAM does not advance rent — only settled funds are disbursed.</div>
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
                  <td><span className={`badge ${d.status==='settled'?'bg2':d.status==='pending'?'ba':'br'}`}>{humanize(d.status)}</span></td>
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
    if (!(await appConfirm('Run live Stripe lookup for every Connect account that isn’t already flagged ready? This may take a few seconds per account.', { confirmLabel: 'Run backfill' }))) return
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
                      {humanize(a.entityType)}
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
                  <span className={`badge ${n.status === 'sent' ? 'bg2' : 'br'}`}>{humanize(n.status)}</span>
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

function Commissions(){
  const{user}=useAuth()
  const qc=useQueryClient()
  const isSuper=user?.role==='super_admin'
  const{data,isLoading}=useQuery<any>('commissions-summary',()=>get('/admin/commissions/summary'),{enabled:!!user})
  const[running,setRunning]=React.useState(false)
  const[msg,setMsg]=React.useState('')
  const runAccrual=async()=>{ setRunning(true)
    try{ const r=await post<any>('/admin/commissions/accrue'); setMsg(`Accrued ${r?.data?.landlordsAccrued??0} landlords for ${r?.data?.monthScanned}`); qc.invalidateQueries('commissions-summary') }
    catch(e:any){ setMsg('Failed: '+(e?.response?.data?.error||e.message)) }
    finally{ setRunning(false); setTimeout(()=>setMsg(''),5000) }
  }
  return(
    <div>
      <div className="ph"><div><h1 className="pt">Commissions</h1><p className="ps">{isSuper?'Portfolio-manager earnings + platform pot':'Your portfolio-manager earnings'}</p></div></div>
      {msg&&<div className={`alert ${msg.startsWith('F')?'ae':'ag'}`} style={{marginBottom:12}}>{msg}</div>}
      {isLoading?<div className="card" style={{padding:32,textAlign:'center',color:'var(--t3)'}}>Loading…</div>:(
      <>
        <div className="grid4" style={{marginBottom:14}}>
          <div className="kpi"><div className="kl">Your earnings — this month</div><div className="kv gold">{formatCurrency(data?.myEarnings?.thisMonth||0)}</div><div className="ks">closing + customer service</div></div>
          <div className="kpi"><div className="kl">Your earnings — all time</div><div className="kv">{formatCurrency(data?.myEarnings?.allTime||0)}</div><div className="ks">residual while landlords stay</div></div>
          {isSuper&&<div className="kpi"><div className="kl">Pot — this month</div><div className="kv b">{formatCurrency(data?.pot?.thisMonth||0)}</div><div className="ks">10¢/occ always + orphaned closing</div></div>}
          {isSuper&&<div className="kpi"><div className="kl">Pot — all time</div><div className="kv b">{formatCurrency(data?.pot?.allTime||0)}</div><div className="ks">held for later use</div></div>}
        </div>
        <div className="card" style={{padding:0,marginBottom:14}}>
          <div className="ct" style={{padding:'10px 14px',margin:0,borderBottom:'1px solid var(--b0)'}}>Your commissions by landlord</div>
          <table className="tbl">
            <thead><tr><th>Landlord</th><th>Occupied units</th><th>This month</th><th>All time</th></tr></thead>
            <tbody>
              {(data?.myByLandlord||[]).length?(data.myByLandlord as any[]).map((m:any)=>(
                <tr key={m.landlordId}><td style={{color:'var(--t0)'}}>{m.businessName||`${m.firstName} ${m.lastName}`}</td><td className="mono">{m.occupiedUnits||0}</td><td className="mono">{formatCurrency(+m.thisMonth||0)}</td><td className="mono">{formatCurrency(+m.allTime||0)}</td></tr>
              )):<tr><td colSpan={4} style={{textAlign:'center',color:'var(--t3)',padding:24}}>No commissions yet — you earn once you close or service a landlord with occupied units.</td></tr>}
            </tbody>
          </table>
        </div>
        {isSuper&&(
        <div className="card" style={{padding:0,marginBottom:14}}>
          <div style={{display:'flex',alignItems:'center',padding:'10px 14px',borderBottom:'1px solid var(--b0)'}}>
            <div className="ct" style={{margin:0}}>Earnings by portfolio strategist</div>
            <button className="btn bg-btn" style={{marginLeft:'auto',padding:'5px 12px'}} disabled={running} onClick={runAccrual}>{running?'Running…':'Run accrual now'}</button>
          </div>
          <table className="tbl">
            <thead><tr><th>Portfolio strategist</th><th>This month</th><th>All time</th></tr></thead>
            <tbody>
              {(data?.byManager||[]).length?(data.byManager as any[]).map((m:any)=>(
                <tr key={m.managerId}><td style={{color:'var(--t0)'}}>{m.firstName} {m.lastName}</td><td className="mono">{formatCurrency(+m.thisMonth||0)}</td><td className="mono">{formatCurrency(+m.allTime||0)}</td></tr>
              )):<tr><td colSpan={3} style={{textAlign:'center',color:'var(--t3)',padding:24}}>No commissions accrued yet.</td></tr>}
            </tbody>
          </table>
        </div>)}
      </>
      )}
    </div>
  )
}

function Reserve(){
  const{user}=useAuth()
  const{data:stats}=useQuery('admin-overview',()=>get<any>('/admin/overview'),{enabled:!!user})
  // Matches the Overview reserve/float model (S566): reserve target = 3% of the
  // FlexPay FLOAT (money at risk), NOT total platform rent; bankroll = rent of
  // income-verified FlexPay tenants; no phases; float yield waits for ODFI.
  const floatBankroll=stats?.flexpayBankroll||0
  const DEFAULT_RESERVE_RATE=0.03
  const target=floatBankroll*DEFAULT_RESERVE_RATE
  const pct=stats?.reserveBalance?Math.min((stats.reserveBalance/Math.max(target,1))*100,100):0
  return(
    <div>
      <div className="ph"><div><h1 className="pt">Reserve &amp; Float</h1><p className="ps">Scales with FlexPay enrollment — $0 until the first income-verified enrollment</p></div></div>
      <div className="grid2" style={{marginBottom:16}}>
        <div className="card">
          <div className="ct">Default Reserve Fund</div>
          <div className="dr"><span className="dk">Balance</span><span className="dv mono" style={{color:pct>=100?'var(--green)':pct>=50?'var(--amber)':'var(--red)'}}>{formatCurrency(stats?.reserveBalance||0)}</span></div>
          <div className="dr"><span className="dk">Target (3% of FlexPay float)</span><span className="dv mono">{formatCurrency(target)}</span></div>
          <div className="dr"><span className="dk">Coverage</span><span className={`badge ${pct>=100?'bg2':pct>=50?'ba':'br'}`}>{pct.toFixed(0)}%</span></div>
          <div style={{marginTop:14,fontSize:'.78rem',color:'var(--t3)',lineHeight:1.5}}>
            Reserve absorbs FlexPay defaults — sized at 3% of the FlexPay float (money at risk), not total rent. It only grows as income-verified tenants enroll, so it stays $0 during the demand-test phase.
          </div>
        </div>
        <div className="card">
          <div className="ct">FlexPay Float Bankroll</div>
          <div className="dr"><span className="dk">Bankroll</span><span className="dv mono" style={{color:'var(--blue)'}}>{formatCurrency(floatBankroll)}</span></div>
          <div className="dr"><span className="dk">Basis</span><span className="dv mono">rent of income-verified tenants who requested FlexPay</span></div>
          <div className="dr"><span className="dk">Reserve needed (3%)</span><span className="dv mono">{formatCurrency(target)}</span></div>
          <div style={{marginTop:14,fontSize:'.78rem',color:'var(--t3)',lineHeight:1.5}}>Bankroll = the rent GAM would front each cycle if these tenants enroll. Float yield income begins at ODFI partnership; no interest is booked before then.</div>
        </div>
      </div>
    </div>
  )
}

function Tenants(){
  const{user}=useAuth()
  const{data:tenants=[],isLoading}=useQuery<any[]>('admin-tenants-page',()=>get('/admin/tenants'),{enabled:!!user,refetchOnWindowFocus:false})
  const sortedTenants=React.useMemo(()=>[...(tenants as any[])].sort((a,b)=>{
    const aInc=(!a.achVerified||(!!a.creditReportingEnrolled&&!a.flexDepositEnrolled&&!a.floatFeeActive))?0:1
    const bInc=(!b.achVerified||(!!b.creditReportingEnrolled&&!b.flexDepositEnrolled&&!b.floatFeeActive))?0:1
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
    try{ const r=await post<{message?:string}>('/admin/onboarding/resend',{type,targetId:id}); setMsg(r?.data?.message||'Sent'); setTimeout(()=>setMsg(''),4000) }
    catch(e:any){ setMsg('Failed: '+(e?.response?.data?.error||e.message)) }
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
                    <td><span className={`badge ${(t.creditReportingEnrolled||t.flexDepositEnrolled||t.floatFeeActive)?'bg2':'bmu'}`}>{(t.creditReportingEnrolled||t.flexDepositEnrolled||t.floatFeeActive)?'Active':'None'}</span></td>
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
      <div className="ph"><div><h1 className="pt">Maintenance</h1><p className="ps">Completed jobs across the platform</p></div></div>
      <div className="card" style={{padding:0,overflowX:'auto'}}>
        {isLoading?<div style={{padding:32,color:'var(--t3)',textAlign:'center'}}>Loading…</div>:(
          <table className="tbl" style={{minWidth:920}}>
            <thead><tr><th>Date</th><th>Unit</th><th>Title</th><th>Priority</th><th>Status</th><th>Contractor</th><th>Cost</th></tr></thead>
            <tbody>
              {reqs.length?reqs.map((r:any)=>(
                <tr key={r.id}>
                  <td className="mono" style={{fontSize:'.7rem'}}>{new Date(r.createdAt).toLocaleDateString()}</td>
                  <td className="mono">{r.unitNumber}</td>
                  <td style={{color:'var(--t0)',fontSize:'.78rem'}}>{r.title}</td>
                  <td><span className={`badge ${PRI[r.priority]}`}>{r.priority}</span></td>
                  <td><span className={`badge ${ST[r.status]}`}>{humanize(r.status)}</span></td>
                  <td style={{fontSize:'.75rem'}}>{r.contractorName||<span style={{color:'var(--t3)'}}>Unassigned</span>}</td>
                  <td className="mono">{r.actualCost?formatCurrency(r.actualCost):'—'}</td>
                </tr>
              )):<tr><td colSpan={7} style={{textAlign:'center',color:'var(--t3)',padding:32}}>No maintenance requests.</td></tr>}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}


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
          : <button className="btn bd bsm" disabled={busy} onClick={()=>{appConfirm(`Revert ${s.platformKey}/${s.importType} to unverified? Future uploads will resume escalating to review.`, { confirmLabel: 'Unverify' }).then(ok=>{if(ok)unverifyMut.mutate({platform_key:s.platformKey,import_type:s.importType})})}}>Unverify</button>}
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
                          onClick={()=>{appConfirm(`Promote "${c.normalizedName}"? This drops it from the candidates list. Building the actual mapping happens in a code session.`, { confirmLabel: 'Promote' }).then(ok=>{if(ok)promoteClaim.mutate(c.normalizedName)})}}
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
  const{login,loginWithTotp,loginWithEmailOtp,resendEmailOtp}=useAuth()
  React.useEffect(()=>{
    localStorage.removeItem('gam_admin_token')
    delete api.defaults.headers.common['Authorization']
  },[])
  const[email,setEmail]=useState('');const[pw,setPw]=useState('');const[err,setErr]=useState('');const[loading,setLoading]=useState(false)
  const[totpSession,setTotpSession]=useState<string|null>(null)
  const[emailOtpSession,setEmailOtpSession]=useState<string|null>(null)
  const[resentMsg,setResentMsg]=useState('')
  const[code,setCode]=useState('')

  const onCredentialsSubmit=async(e:React.FormEvent)=>{
    e.preventDefault();setLoading(true);setErr('')
    try{
      const r=await login(email,pw)
      if(r.kind==='totp_required'){setTotpSession(r.totpSession);setCode('')}
      else if(r.kind==='email_otp_required'){setEmailOtpSession(r.emailOtpSession);setCode('');setResentMsg('')}
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

  const onEmailOtpSubmit=async(e:React.FormEvent)=>{
    e.preventDefault();setLoading(true);setErr('')
    try{await loginWithEmailOtp(emailOtpSession!,code.trim())}
    catch(ex:any){
      const msg=ex.response?.data?.error||'Invalid code.'
      setErr(msg)
      if(/session/i.test(msg)){setEmailOtpSession(null);setCode('');setPw('')}
    }
    finally{setLoading(false)}
  }

  const onResendEmailOtp=async()=>{
    setErr('');setResentMsg('')
    try{await resendEmailOtp(emailOtpSession!);setResentMsg('A new code is on its way.')}
    catch(ex:any){setErr(ex.response?.data?.error||'Could not resend. Start over.')}
  }

  const onBackToCredentials=()=>{
    setTotpSession(null);setEmailOtpSession(null);setCode('');setErr('');setPw('');setResentMsg('')
  }

  // ── Step 2b: email code ───────────────────────────────────────
  if(emailOtpSession){
    return(
      <div style={{minHeight:'100vh',display:'flex',alignItems:'center',justifyContent:'center',background:'var(--bg0)',padding:20}}>
        <div style={{width:'100%',maxWidth:380}}>
          <div style={{textAlign:'center',marginBottom:40}}>
            <div style={{fontFamily:'var(--font-d)',fontSize:'1.8rem',fontWeight:800,color:'var(--red)',marginBottom:8}}>⚠ ADMIN CONSOLE</div>
            <div style={{color:'var(--t3)',fontSize:'.82rem'}}>Two-factor authentication</div>
          </div>
          <div className="card" style={{padding:24}}>
            <div style={{fontSize:'.85rem',color:'var(--t1)',marginBottom:14,lineHeight:1.6}}>
              We emailed a 6-digit code to <strong style={{color:'var(--t0)'}}>{email}</strong>. Enter it below to finish signing in.
            </div>
            {err&&<div className="alert ae" style={{marginBottom:14}}>{err}</div>}
            {resentMsg&&<div className="alert" style={{marginBottom:14,background:'rgba(201,162,39,.08)',border:'1px solid var(--b1)',color:'var(--t1)'}}>{resentMsg}</div>}
            <form onSubmit={onEmailOtpSubmit}>
              <div style={{marginBottom:16}}>
                <label style={{display:'block',fontSize:'.72rem',fontWeight:600,color:'var(--t3)',marginBottom:5,textTransform:'uppercase',letterSpacing:'.06em'}}>Code</label>
                <input
                  style={{width:'100%',background:'var(--bg3)',border:'1px solid var(--b1)',borderRadius:7,color:'var(--t0)',padding:'8px 11px',fontSize:'1rem',fontFamily:'var(--font-m)',letterSpacing:'.3em',textAlign:'center',outline:'none'}}
                  type="text" value={code} onChange={e=>setCode(e.target.value)}
                  autoFocus required autoComplete="one-time-code" inputMode="numeric" placeholder="123456"
                />
              </div>
              <button className="bp btn" type="submit" disabled={loading||!code.trim()} style={{width:'100%',justifyContent:'center'}}>
                {loading?<span className="spinner"/>:'Verify'}
              </button>
            </form>
            <div style={{marginTop:14,display:'flex',justifyContent:'space-between',alignItems:'center'}}>
              <button onClick={onBackToCredentials} style={{background:'none',border:'none',color:'var(--t2)',fontSize:'.82rem',cursor:'pointer',textDecoration:'underline'}}>← Back to sign in</button>
              <button onClick={onResendEmailOtp} style={{background:'none',border:'none',color:'var(--gold)',fontSize:'.82rem',cursor:'pointer',textDecoration:'underline'}}>Resend code</button>
            </div>
          </div>
        </div>
      </div>
    )
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

// S567: System Features is locked to the platform OWNER's account only, so no
// other admin can flip a feature flag by accident.
const OWNER_EMAIL='nic@golddoor.io'
function OwnerGuard({children}:{children:React.ReactNode}){
  const{user}=useAuth()
  if(user?.email!==OWNER_EMAIL)return(
    <div style={{padding:48,textAlign:'center'}}>
      <div style={{fontSize:'2rem',marginBottom:12}}>🔒</div>
      <h2 style={{color:'var(--t0)',marginBottom:8}}>Owner Only</h2>
      <p style={{color:'var(--t3)',fontSize:'.85rem'}}>System Features can only be changed from the owner account.</p>
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
      // S560: login now issues an enrollment-only pass to un-enrolled admins;
      // enroll-confirm returns the real full session once 2FA is set up. Store
      // it (the api interceptor reads gam_admin_token) before refreshing.
      const cr=await api.post('/auth/totp/enroll-confirm',{token:code.trim()})
      const fullTok=cr.data?.data?.token
      if(fullTok)localStorage.setItem('gam_admin_token',fullTok)
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

// ── FEATURE REQUESTS (S571) ───────────────────────────────────
// Tenants and landlords submit ideas via their portals (POST /feature-requests);
// the GAM team reviews + triages them here.
const FEATURE_STATUSES = ['new','reviewing','planned','declined','shipped'] as const
const FR_BADGE:Record<string,string>={new:'b-blue',reviewing:'b-amber',planned:'b-green',declined:'b-muted',shipped:'b-green'}
function FeatureRequests(){
  const qc=useQueryClient()
  const{data=[],isLoading}=useQuery<any[]>('feature-requests',()=>get<any[]>('/feature-requests'))
  const patchMut=useMutation(({id,status}:{id:string;status:string})=>api.patch(`/feature-requests/${id}`,{status}).then(r=>r.data),{
    onSuccess:()=>qc.invalidateQueries('feature-requests'),
  })
  return(
    <div>
      <div className="ph"><div><h1 className="pt">Feature Requests</h1><div className="ps">Ideas submitted by tenants and landlords.</div></div></div>
      {isLoading?<div style={{padding:32,color:'var(--t3)'}}>Loading…</div>:
       !data.length?<div className="card" style={{padding:24,textAlign:'center',color:'var(--t3)'}}>No feature requests yet.</div>:
       <div style={{display:'flex',flexDirection:'column',gap:10}}>
        {data.map((r:any)=>(
          <div key={r.id} className="card" style={{padding:16}}>
            <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',gap:12,marginBottom:6}}>
              <div style={{fontWeight:700,color:'var(--t0)'}}>{r.title}</div>
              <span className={`badge ${FR_BADGE[r.status]||'b-muted'}`}>{r.status}</span>
            </div>
            <div style={{fontSize:'.85rem',color:'var(--t1)',lineHeight:1.5,marginBottom:8,whiteSpace:'pre-wrap'}}>{r.description}</div>
            <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',gap:12,flexWrap:'wrap'}}>
              <div style={{fontSize:'.72rem',color:'var(--t3)'}}>
                {r.firstName} {r.lastName} · <span style={{textTransform:'capitalize'}}>{r.submitterRole}</span> · {r.email} · {new Date(r.createdAt).toLocaleDateString()}
              </div>
              <select className="inp" style={{width:'auto',fontSize:'.8rem'}} value={r.status} onChange={e=>patchMut.mutate({id:r.id,status:e.target.value})}>
                {FEATURE_STATUSES.map(s=><option key={s} value={s}>{s}</option>)}
              </select>
            </div>
          </div>
        ))}
       </div>}
    </div>
  )
}

// ── APP ───────────────────────────────────────────────────────

// S605 (Nic): "we should be doing that automatically... that way we're not
// working on old visuals." A bfcache-restored tab on an outdated build reloads
// itself; a newer deploy found on refocus or the 5-min poll only OFFERS a
// reload, so nobody gets a page yanked mid-task. See packages/shared/versionWatch.
function VersionWatch() {
  const [ready, setReady] = useState(false)
  useEffect(() => startVersionWatch({ onUpdateAvailable: () => setReady(true) }), [])
  if (!ready) return null
  return (
    <div style={{
      position:'fixed', bottom:18, left:'50%', transform:'translateX(-50%)', zIndex:99999,
      display:'flex', alignItems:'center', gap:12, padding:'10px 16px',
      background:'#111820', border:'1px solid #c9a227', borderRadius:10,
      boxShadow:'0 6px 24px rgba(0,0,0,.45)', fontSize:'.82rem', color:'#eef1f8',
    }}>
      A newer version of GAM is available.
      <button onClick={() => window.location.reload()} style={{
        background:'#c9a227', color:'#060809', border:'none', borderRadius:6,
        padding:'5px 12px', fontWeight:700, fontSize:'.78rem', cursor:'pointer',
      }}>Reload</button>
    </div>
  )
}

function App(){
  const{user,loading}=useAuth()
  if(loading)return<div className="loading">Loading…</div>
  return(
    <BrowserRouter>
      <VersionWatch/>
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
          <Route index element={<Navigate to={user?.role==='super_admin'?'/overview':'/onboarding'} replace/>}/>
          <Route path="overview"      element={user?.role==='super_admin'?<Overview/>:<Navigate to="/onboarding" replace/>}/>
          <Route path="onboarding"    element={<AdminOnboardingOverview/>}/>
          <Route path="landlords"     element={<Landlords/>}/>
          <Route path="tenants"       element={<Tenants/>}/>
          <Route path="commissions"   element={<Commissions/>}/>
          <Route path="flexpay-requests" element={<SuperAdminGuard><FlexPayRequests/></SuperAdminGuard>}/>
          <Route path="property-reviews" element={<SuperAdminGuard><PropertyReviews/></SuperAdminGuard>}/>
          <Route path="feature-requests" element={<SuperAdminGuard><FeatureRequests/></SuperAdminGuard>}/>
          <Route path="units"         element={<Units/>}/>
          <Route path="payments"      element={<Payments/>}/>
          <Route path="disbursements" element={<Disbursements/>}/>
          <Route path="connect-accounts" element={<ConnectAccounts/>}/>
          <Route path="reserve"       element={<SuperAdminGuard><Reserve/></SuperAdminGuard>}/>
          <Route path="nacha"         element={<SuperAdminGuard><NachaMonitor/></SuperAdminGuard>}/>
          <Route path="nexus"         element={<SuperAdminGuard><NexusMonitor/></SuperAdminGuard>}/>
          <Route path="maintenance"   element={<Maintenance/>}/>
          <Route path="disputes"      element={<SuperAdminGuard><Disputes/></SuperAdminGuard>}/>
          <Route path="subleases"     element={<SuperAdminGuard><Subleases/></SuperAdminGuard>}/>
          <Route path="deposit-portability" element={<SuperAdminGuard><DepositPortability/></SuperAdminGuard>}/>
          <Route path="deposit-interest" element={<SuperAdminGuard><DepositInterest/></SuperAdminGuard>}/>
          <Route path="outreach" element={<OutreachStatus/>}/>
          <Route path="system-features" element={<OwnerGuard><SystemFeatures/></OwnerGuard>}/>
          <Route path="audit-log"     element={<SuperAdminGuard><AuditLog/></SuperAdminGuard>}/>
          <Route path="csv-imports"   element={<SuperAdminGuard><CsvImports/></SuperAdminGuard>}/>
          <Route path="scaling"       element={<SuperAdminGuard><ScalingReadiness/></SuperAdminGuard>}/>
          <Route path="agent-analytics" element={<SuperAdminGuard><AgentAnalytics/></SuperAdminGuard>}/>
          <Route path="leads"         element={<SuperAdminGuard><SalesLeads/></SuperAdminGuard>}/>
          <Route path="security"      element={<SecurityPage/>}/>
        </Route>
      </Routes>
      <DialogHost />
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
          <h1 className="pt">Reporting Disputes</h1>
          <p className="ps">Disputes of GAM's payment/credit-reporting record (rent reporting via FlexCredit). GAM does not lend. {list.length} in the {status} bucket.</p>
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
            {humanize(s)}
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
                    <td><span className={`badge ${disputeStatusBadge(d.status)}`}>{humanize(d.status)}</span></td>
                    <td style={{fontSize:'.78rem'}}>
                      <div style={{color:'var(--t0)',fontWeight:600}}>{d.disputingSubjectType}</div>
                      <div className="mono" style={{fontSize:'.65rem',color:'var(--t3)'}}>{d.disputingSubjectRefId?.slice(0,8)}…</div>
                    </td>
                    <td style={{fontSize:'.78rem',color:'var(--t0)'}}>{DISPUTE_EVENT_LABEL[d.disputedEventType] || d.disputedEventType}</td>
                    <td style={{fontSize:'.78rem'}}>{humanize(d.reason)}</td>
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
                  <span className={`badge ${disputeStatusBadge(detail.status)}`}>{humanize(detail.status)}</span>
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
              <div style={{fontSize:'.82rem',color:'var(--t1)'}}>{humanize(detail.reason)}</div>
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
                          {o === 'corrected' ? 'Corrected (replace event)' : humanize(o)}
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
                      {resolveMut.isLoading ? 'Resolving…' : `Resolve as ${humanize(outcome)}`}
                    </button>
                  </div>
                </div>
              )}

              {detail.status?.startsWith('resolved_') && (
                <div style={{marginTop:18,paddingTop:14,borderTop:'1px solid var(--b0)',fontSize:'.78rem',color:'var(--t2)'}}>
                  Resolved on {detail.resolvedAt ? new Date(detail.resolvedAt).toLocaleString() : '—'} as <strong>{humanize(detail.status.replace('resolved_',''))}</strong>.
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
  // S554 (button-sweep bug #9): the admin response is camelized, so the
  // SQL aliases new_street1 / orig_landlord_first arrive as newStreet1 /
  // origLandlordFirst. The old snake-case key lookups returned undefined
  // ("undefined undefined"). Prefix is now 'new' / 'orig' + PascalCase field.
  const fmtAddr=(p:any,pre:string)=>`${p[pre+'Street1']}${p[pre+'Street2']?' '+p[pre+'Street2']:''}, ${p[pre+'City']}, ${p[pre+'State']} ${p[pre+'Zip']}`
  const fmtLL=(p:any,pre:string)=>`${p[pre+'LandlordFirst']} ${p[pre+'LandlordLast']}${p[pre+'LandlordBusiness']?' — '+p[pre+'LandlordBusiness']:''}`
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
                    <td><span style={{fontSize:'.7rem',padding:'2px 8px',borderRadius:4,background:f.resolvedAt?'var(--b1)':'var(--gold)',color:f.resolvedAt?'var(--t3)':'#000'}}>{f.resolvedAt?humanize(f.resolution):'Pending'}</span></td>
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
                <div style={{fontSize:'.75rem',marginBottom:8}}>{fmtAddr(selected,'new')}</div>
                <div style={{fontSize:'.7rem',color:'var(--t3)',marginBottom:4}}>Landlord</div>
                <div style={{fontSize:'.78rem',marginBottom:4}}>{fmtLL(selected,'new')}</div>
                <div style={{fontSize:'.7rem',color:'var(--t3)'}}>{selected.newLandlordEmail}</div>
                <div style={{fontSize:'.7rem',color:'var(--t3)',marginTop:8}}>Created {fmtDate(selected.newCreatedAt)}</div>
              </div>
              <div style={{border:'1px solid var(--b1)',borderRadius:8,padding:14}}>
                <div style={{fontSize:'.7rem',color:'var(--t3)',fontWeight:700,marginBottom:8}}>EXISTING PROPERTY</div>
                <div style={{fontWeight:600,marginBottom:4}}>{selected.origName}</div>
                <div style={{fontSize:'.75rem',marginBottom:8}}>{fmtAddr(selected,'orig')}</div>
                <div style={{fontSize:'.7rem',color:'var(--t3)',marginBottom:4}}>Landlord</div>
                <div style={{fontSize:'.78rem',marginBottom:4}}>{fmtLL(selected,'orig')}</div>
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
                <div style={{fontSize:'.85rem',fontWeight:600,marginBottom:6}}>{humanize(selected.resolution)}</div>
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
            {humanize(s)} ({counts[s]})
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
                        {r.status === 'pending_invite' ? 'Awaiting accept' : humanize(r.status)}
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

// ── S541: FlexPay demand-test review queue ──────────────────────────
// FlexPay fronts rent each cycle, so every enrollment is GAM float.
// Tenants raise a hand from the tenant portal; an admin reviews the
// lease + verifies SSI/SSDI income here. Approve marks the income
// verified (tenants.ssi_ssdi) and unlocks enrollment server-side.
// Inquiry volume doubles as the demand signal for a capital raise.
interface FlexPayInquiryRow {
  id: string; status: 'pending'|'approved'|'declined'
  claimedIncomeSource: 'ssi'|'ssdi'|'other_fixed'|'none'; tenantNote: string|null; adminNotes: string|null
  createdAt: string; reviewedAt: string|null; reviewedByEmail: string|null
  tenantId: string; ssiSsdi: boolean; achVerified: boolean; flexpayEnrolled: boolean
  firstName: string; lastName: string; email: string; phone: string|null
  leaseId: string|null; leaseRent: string|null; startDate: string|null; endDate: string|null
  unitNumber: string|null; propertyName: string|null
  // S542b: FCFS queue + state holds + platform-side income proof.
  propertyState: string|null; stateHold: boolean; queuePosition: number|null
  proofOriginalName: string|null; proofUploadedAt: string|null
  // S542c: float-need ordering — benefit-arrival day + est float days
  // (front at grace-end → their day). Shortest float first.
  desiredPullDay: number|null; estFloatDays: number|null
  // S545: the lease terms the float rides on.
  rentDueDay: number|null; leaseStatus: string|null; leaseMonthsLeft: number|null
  // S545: tier-2 (non-SSI/SSDI) income hold until expansion opens.
  incomeHold: boolean
  // S545b: the pay pattern behind the derived day.
  benefitSchedule: string|null
  // S545c: silent verification hold + lease-holder names for the
  // document-name check.
  heldAt: string|null; holdReason: string|null; leaseHolderNames: string|null
  // S546: automated document verification + backend-only prequal.
  autoVerification: { nameMatch?: string; matchedName?: string; benefitKeywords?: boolean; checkedAt?: string } | null
  prequalStatus: string|null
}

const INCOME_LABEL: Record<string, string> = {
  ssi: 'SSI', ssdi: 'SSDI', other_fixed: 'Other fixed day', none: 'No fixed day',
}
const SCHEDULE_LABEL: Record<string, string> = {
  ssi_day_1: '1st of month', ssdi_day_3: '3rd of month',
  ssdi_wed_2: '2nd Wednesday', ssdi_wed_3: '3rd Wednesday',
  ssdi_wed_4: '4th Wednesday', fixed_day: 'Fixed day',
}

function FlexPayRequests() {
  const qc = useQueryClient()
  const [review, setReview] = React.useState<{ row: FlexPayInquiryRow; action: 'approve'|'decline'; incomeVerified: boolean; nameMatchConfirmed: boolean; notes: string } | null>(null)
  const { data: rows = [], isLoading } = useQuery<FlexPayInquiryRow[]>(
    'flexpay-inquiries', () => get<FlexPayInquiryRow[]>('/admin/flexpay/inquiries'))
  const fmt = (n: any) => n == null ? '—' : '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  const fmtDate = (s: string|null) => s ? new Date(s).toLocaleDateString() : '—'

  const [reviewError, setReviewError] = React.useState<string | null>(null)
  const reviewMut = useMutation(
    (p: { id: string; action: 'approve'|'decline'; incomeVerified: boolean; nameMatchConfirmed?: boolean; notes: string }) =>
      post(`/admin/flexpay/inquiries/${p.id}/review`, { action: p.action, incomeVerified: p.incomeVerified, nameMatchConfirmed: p.nameMatchConfirmed, notes: p.notes || undefined }),
    { onSuccess: () => { qc.invalidateQueries('flexpay-inquiries'); setReview(null); setReviewError(null) },
      onError: (e: any) => setReviewError(e?.response?.data?.error || 'Review failed — try again') },
  )

  // S542b: open the tenant-uploaded proof (authed blob — no static URL).
  const viewProof = async (id: string) => {
    const res = await api.get(`/admin/flexpay/inquiries/${id}/proof-file`, { responseType: 'blob' })
    window.open(URL.createObjectURL(res.data as Blob), '_blank')
  }

  // S545c: verification hold + release (silent — no tenant signal).
  const holdMut = useMutation(
    (p: { id: string; reason: string }) => post(`/admin/flexpay/inquiries/${p.id}/hold`, { reason: p.reason }),
    { onSuccess: () => { qc.invalidateQueries('flexpay-inquiries'); qc.invalidateQueries('flexpay-funnel'); setReview(null); setReviewError(null) },
      onError: (e: any) => setReviewError(e?.response?.data?.error || 'Hold failed') },
  )
  const releaseMut = useMutation(
    (id: string) => post(`/admin/flexpay/inquiries/${id}/release-hold`, {}),
    { onSuccess: () => { qc.invalidateQueries('flexpay-inquiries'); qc.invalidateQueries('flexpay-funnel') } },
  )

  // S543: capture the benefit-arrival day during phone reach-out —
  // fills the "?" float slots so the queue can order them.
  const [editDay, setEditDay] = React.useState<{ id: string; value: number } | null>(null)
  const dayMut = useMutation(
    (p: { id: string; benefitDay: number }) =>
      post(`/admin/flexpay/inquiries/${p.id}/benefit-day`, { benefitDay: p.benefitDay }),
    { onSuccess: () => { qc.invalidateQueries('flexpay-inquiries'); setEditDay(null) } },
  )

  // S545c: held rows leave the working queue (silently — the tenant
  // sees nothing) and live in their own section until released.
  const pending = rows.filter(r => r.status === 'pending' && !r.heldAt)
  const held    = rows.filter(r => r.status === 'pending' && r.heldAt)
  const decided = rows.filter(r => r.status !== 'pending')
  const BADGE: Record<string, string> = { pending: 'b-amber', approved: 'b-green', declined: 'b-muted' }

  // S543: demand funnel — asked → interested → approved → enrolled,
  // plus the monthly front commitment (the bankroll number).
  const { data: funnel } = useQuery<any>('flexpay-funnel', () => get<any>('/admin/flexpay/funnel'))
  const fq = funnel?.questionnaires ?? {}
  const fi = funnel?.inquiries ?? {}
  const qSent = (fq.pending ?? 0) + (fq.answered ?? 0) + (fq.dismissed ?? 0)

  const Table = ({ list, title }: { list: FlexPayInquiryRow[]; title: string }) => (
    <div className="card" style={{ padding: 0, overflowX: 'auto', marginBottom: 16 }}>
      <div style={{ padding: '12px 16px', fontWeight: 700, color: 'var(--t0)', fontSize: '.85rem' }}>{title} ({list.length})</div>
      <table className="tbl" style={{ minWidth: 1020 }}>
        <thead><tr>
          <th>#</th><th>Requested</th><th>Tenant</th><th>Property / Unit</th><th>Rent</th>
          <th>Float</th><th>Claims</th><th>Proof</th><th>Income verified</th><th>ACH</th><th>Status</th><th></th>
        </tr></thead>
        <tbody>
          {list.length ? list.map(r => (
            <tr key={r.id}>
              <td className="mono" style={{ fontSize: '.78rem', fontWeight: 700 }}>{r.queuePosition ?? '—'}</td>
              <td className="mono" style={{ fontSize: '.75rem' }}>{fmtDate(r.createdAt)}</td>
              <td>
                <div style={{ fontWeight: 600, color: 'var(--t0)' }}>{r.firstName} {r.lastName}</div>
                <div style={{ fontSize: '.72rem', color: 'var(--t3)' }}>{r.email}{r.phone ? ` · ${r.phone}` : ''}</div>
                {r.tenantNote && <div style={{ fontSize: '.72rem', color: 'var(--t2)', marginTop: 2 }}>“{r.tenantNote}”</div>}
                {r.prequalStatus === 'prequalified' && <span className="badge b-gold" title="Backend pre-qualification (never shown to the tenant)">PRE-QUALIFIED</span>}
              </td>
              <td style={{ fontSize: '.78rem' }}>
                {r.propertyName ?? '— no active lease —'}{r.unitNumber ? ` · ${r.unitNumber}` : ''}
                {r.propertyState && <span style={{ color: 'var(--t3)' }}> · {r.propertyState}</span>}
                {r.stateHold && <div><span className="badge b-red">STATE HOLD</span></div>}
              </td>
              <td className="mono">
                {fmt(r.leaseRent)}
                {/* S545: the lease terms the float rides on. */}
                {r.rentDueDay != null && <div style={{ fontSize: '.68rem', color: 'var(--t3)' }}>due day {r.rentDueDay}</div>}
                <div style={{ fontSize: '.68rem', color: r.leaseMonthsLeft != null && r.leaseMonthsLeft <= 2 ? 'var(--amber)' : 'var(--t3)' }}>
                  {r.endDate
                    ? `ends ${fmtDate(r.endDate)}${r.leaseMonthsLeft != null ? ` (~${r.leaseMonthsLeft} mo)` : ''}`
                    : r.leaseStatus ? 'month-to-month' : ''}
                </div>
              </td>
              <td>
                {editDay?.id === r.id ? (
                  <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
                    <input type="number" min={1} max={28} value={editDay.value} autoFocus
                      onChange={e => setEditDay({ id: r.id, value: Number(e.target.value) })}
                      onKeyDown={e => { if (e.key === 'Enter' && editDay.value >= 1 && editDay.value <= 28) dayMut.mutate({ id: r.id, benefitDay: editDay.value }); if (e.key === 'Escape') setEditDay(null) }}
                      style={{ width: 52 }} className="inp" />
                    <button className="btn btn-p btn-sm" disabled={dayMut.isLoading || editDay.value < 1 || editDay.value > 28}
                      onClick={() => dayMut.mutate({ id: r.id, benefitDay: editDay.value })}>✓</button>
                    <button className="btn btn-g btn-sm" onClick={() => setEditDay(null)}>✕</button>
                  </span>
                ) : (
                  <>
                    {r.estFloatDays != null
                      ? <span className="mono" style={{ fontWeight: 700, color: r.estFloatDays <= 5 ? 'var(--green)' : r.estFloatDays <= 12 ? 'var(--amber)' : 'var(--red)' }}>~{r.estFloatDays}d</span>
                      : <span className="badge b-muted" title="Benefit day unknown — sorts last until captured">?</span>}
                    {r.desiredPullDay != null && (
                      <div style={{ fontSize: '.68rem', color: 'var(--t3)' }}>
                        {r.benefitSchedule ? (SCHEDULE_LABEL[r.benefitSchedule] ?? `day ${r.desiredPullDay}`) : `day ${r.desiredPullDay}`}
                        {r.benefitSchedule && r.benefitSchedule !== 'fixed_day' ? ` (≤ day ${r.desiredPullDay})` : ''}
                      </div>
                    )}
                    {r.status === 'pending' && (
                      <div>
                        <button className="btn btn-g btn-sm" style={{ marginTop: 2 }}
                          onClick={() => setEditDay({ id: r.id, value: r.desiredPullDay ?? 3 })}>
                          {r.desiredPullDay != null ? 'Edit day' : 'Set day'}
                        </button>
                      </div>
                    )}
                  </>
                )}
              </td>
              <td>
                <span className="badge b-muted">{INCOME_LABEL[r.claimedIncomeSource] ?? r.claimedIncomeSource}</span>
                {r.incomeHold && <div><span className="badge b-amber" title="Non-SSI/SSDI — waits behind tier 1 until flexpay_other_income_open flips">TIER 2 · HELD</span></div>}
              </td>
              <td>
                {r.proofUploadedAt
                  ? <>
                      <button className="btn btn-g btn-sm" onClick={() => viewProof(r.id)} title={r.proofOriginalName ?? ''}>View</button>
                      {r.autoVerification?.nameMatch === 'matched' && <div><span className="badge b-green" title={`Matched: ${r.autoVerification.matchedName}`}>✓ auto</span></div>}
                      {r.autoVerification?.nameMatch === 'manual_ok' && <div><span className="badge b-green">✓ manual</span></div>}
                      {(r.autoVerification?.nameMatch === 'no_match' || r.autoVerification?.nameMatch === 'unreadable') && <div><span className="badge b-amber">check</span></div>}
                    </>
                  : <span className="badge b-muted">None</span>}
              </td>
              <td>
                {/* S545b (Nic): "verified" ONLY when this review process
                    proved it (approved = proof doc + attestation). The
                    import/onboarding ssi_ssdi flag alone is a LEAD, not
                    verification. */}
                {r.status === 'approved'
                  ? <span className="badge b-green">Verified</span>
                  : r.ssiSsdi
                  ? <span className="badge b-amber" title="Flagged SSI/SSDI at import/onboarding — no proof reviewed yet">Flagged · unproven</span>
                  : <span className="badge b-muted">Unverified</span>}
              </td>
              <td><span className={`badge ${r.achVerified ? 'b-green' : 'b-muted'}`}>{r.achVerified ? 'Verified' : 'No'}</span></td>
              <td>
                <span className={`badge ${BADGE[r.status]}`}>{r.status}</span>
                {r.flexpayEnrolled && <span className="badge b-green" style={{ marginLeft: 6 }}>Enrolled</span>}
                {r.reviewedAt && <div style={{ fontSize: '.68rem', color: 'var(--t3)', marginTop: 2 }}>{fmtDate(r.reviewedAt)}{r.reviewedByEmail ? ` · ${r.reviewedByEmail}` : ''}</div>}
              </td>
              <td style={{ whiteSpace: 'nowrap' }}>
                {r.status === 'pending' && <>
                  <button className="btn btn-p btn-sm" onClick={() => setReview({ row: r, action: 'approve', incomeVerified: false, nameMatchConfirmed: false, notes: '' })}>Approve</button>{' '}
                  <button className="btn btn-g btn-sm" onClick={() => setReview({ row: r, action: 'decline', incomeVerified: false, nameMatchConfirmed: false, notes: '' })}>Decline</button>
                </>}
                {r.status === 'declined' && (
                  <button className="btn btn-g btn-sm" onClick={() => setReview({ row: r, action: 'approve', incomeVerified: false, nameMatchConfirmed: false, notes: '' })}>Re-review</button>
                )}
              </td>
            </tr>
          )) : (
            <tr><td colSpan={12} style={{ textAlign: 'center', color: 'var(--t3)', padding: 24 }}>None</td></tr>
          )}
        </tbody>
      </table>
    </div>
  )

  return (
    <div>
      <div className="ph">
        <div>
          <h1 className="pt">FlexPay Requests</h1>
          <p className="ps">{pending.length} awaiting review — every approval adds monthly rent-front float</p>
        </div>
      </div>
      {funnel && (
        <div className="grid3" style={{ marginBottom: 16 }}>
          <div className="kpi">
            <div className="kpi-l">Demand funnel</div>
            <div className="kpi-v" style={{ fontSize: '1.05rem', marginTop: 4 }}>
              {qSent} asked → {(fi.pending ?? 0) + (fi.approved ?? 0) + (fi.declined ?? 0)} interested
            </div>
            <div className="kpi-s">
              {fq.answered ?? 0} answered · {fq.dismissed ?? 0} passed
              {(funnel.otherIncomeInterest ?? 0) > 0 && <> · <span style={{ color: 'var(--amber)' }}>{funnel.otherIncomeInterest} tier-2 waiting on expansion</span></>}
            </div>
          </div>
          <div className="kpi">
            <div className="kpi-l">Queue</div>
            <div className="kpi-v" style={{ fontSize: '1.05rem', marginTop: 4 }}>
              {fi.pending ?? 0} waiting · {fi.approved ?? 0} approved · {funnel.enrolled} enrolled
            </div>
            <div className="kpi-s">{fi.declined ?? 0} declined</div>
          </div>
          <div className="kpi">
            <div className="kpi-l">Monthly front commitment</div>
            <div className="kpi-v" style={{ color: 'var(--gold)' }}>{fmt(funnel.monthlyFloat)}</div>
            <div className="kpi-s">Sum of enrolled tenants' rent — bankroll out each cycle</div>
          </div>
        </div>
      )}

      <div className="card" style={{ padding: 14, marginBottom: 16, background: 'rgba(245,158,11,.06)', border: '1px solid rgba(245,158,11,.25)', fontSize: '.8rem', color: 'var(--t1)', lineHeight: 1.5 }}>
        <strong style={{ color: 'var(--amber)' }}>Review checklist:</strong> open the tenant's lease
        (rent amount = the float you're approving), verify SSI/SSDI income (award letter or bank
        deposit history), then Approve. Approval marks income verified and lets the tenant enroll
        from their portal; total approved float is the bankroll commitment.
      </div>
      {isLoading ? <div style={{ padding: 32, color: 'var(--t3)' }}>Loading…</div> : <>
        <Table list={pending} title="Pending" />

        {/* S545c: verification holds — out of the queue, tenant sees
            NOTHING. Release restores their original spot (ordering is
            float+created_at, which never changed). */}
        {held.length > 0 && (
          <div className="card" style={{ padding: 0, overflowX: 'auto', marginBottom: 16, border: '1px solid rgba(239,68,68,.35)' }}>
            <div style={{ padding: '12px 16px', fontWeight: 700, color: 'var(--t0)', fontSize: '.85rem' }}>
              🔒 Held — verification ({held.length})
              <span style={{ fontWeight: 400, color: 'var(--t3)', marginLeft: 8, fontSize: '.75rem' }}>
                Silent: the tenant portal shows normal pending copy. Resolve, then release — they resume their spot in line.
              </span>
            </div>
            <table className="tbl" style={{ minWidth: 800 }}>
              <thead><tr>
                <th>Held</th><th>Tenant</th><th>Property / Unit</th><th>Claims</th><th>Reason</th><th></th>
              </tr></thead>
              <tbody>
                {held.map(r => (
                  <tr key={r.id}>
                    <td className="mono" style={{ fontSize: '.75rem' }}>{fmtDate(r.heldAt)}</td>
                    <td>
                      <div style={{ fontWeight: 600, color: 'var(--t0)' }}>{r.firstName} {r.lastName}</div>
                      <div style={{ fontSize: '.72rem', color: 'var(--t3)' }}>{r.email}</div>
                    </td>
                    <td style={{ fontSize: '.78rem' }}>{r.propertyName ?? '—'}{r.unitNumber ? ` · ${r.unitNumber}` : ''}</td>
                    <td><span className="badge b-muted">{INCOME_LABEL[r.claimedIncomeSource] ?? r.claimedIncomeSource}</span></td>
                    <td style={{ fontSize: '.76rem', color: 'var(--amber)', maxWidth: 340 }}>{r.holdReason}</td>
                    <td>
                      <button className="btn btn-p btn-sm" disabled={releaseMut.isLoading}
                        onClick={() => releaseMut.mutate(r.id)}>Release hold</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <Table list={decided} title="Decided" />
      </>}

      {review && (
        <div className="modal-ov" onClick={() => setReview(null)}>
          <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 480 }}>
            <div className="modal-t">{review.action === 'approve' ? 'Approve' : 'Decline'} FlexPay — {review.row.firstName} {review.row.lastName}</div>
            <div style={{ fontSize: '.8rem', color: 'var(--t2)', marginBottom: 12 }}>
              Claims {review.row.claimedIncomeSource.toUpperCase()} · rent {fmt(review.row.leaseRent)} at {review.row.propertyName ?? '—'}
            </div>
            {review.action === 'approve' && (() => {
              // S546: automated checks — the machine read the document.
              const av = review.row.autoVerification
              const nameOk = av?.nameMatch === 'matched' || av?.nameMatch === 'manual_ok'
              const Row = ({ ok, warn, label }: { ok?: boolean; warn?: boolean; label: string }) => (
                <div style={{ fontSize: '.8rem', color: ok ? 'var(--green)' : warn ? 'var(--amber)' : 'var(--t3)', marginBottom: 4 }}>
                  {ok ? '✓' : warn ? '⚠' : '·'} {label}
                </div>
              )
              return (
                <div style={{ background: 'var(--bg3, rgba(255,255,255,.03))', border: '1px solid var(--b1, #1e2530)', borderRadius: 8, padding: 12, marginBottom: 12 }}>
                  <div style={{ fontSize: '.72rem', fontWeight: 700, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 8 }}>
                    Automated checks
                  </div>
                  <Row ok={!!review.row.proofUploadedAt} warn={!review.row.proofUploadedAt}
                    label={review.row.proofUploadedAt ? 'Proof document on file' : 'No proof document — approval will be refused'} />
                  <Row ok={nameOk} warn={!!av && !nameOk}
                    label={av?.nameMatch === 'matched' ? `Name matched lease holder: ${av.matchedName}`
                      : av?.nameMatch === 'manual_ok' ? 'Name verified manually (hold released)'
                      : av?.nameMatch === 'no_match' ? `No lease-holder name found in document (lease holders: ${review.row.leaseHolderNames ?? '—'})`
                      : av?.nameMatch === 'unreadable' ? 'Document not machine-readable (photo) — resolve via hold/release'
                      : 'Not checked yet — runs automatically on upload'} />
                  <Row ok={av?.benefitKeywords === true} warn={av ? av.benefitKeywords === false : false}
                    label={av?.benefitKeywords ? 'SSA/SSI/SSDI benefit language detected'
                      : av ? 'No benefit language detected — eyeball the document' : 'Benefit-language scan pending'} />
                  <Row ok={!review.row.heldAt} warn={!!review.row.heldAt}
                    label={review.row.heldAt ? 'On verification hold' : 'No verification holds (birthdate consistent or N/A)'} />
                  <div style={{ fontSize: '.72rem', color: 'var(--t3)', marginTop: 8 }}>
                    Discrepancy?{' '}
                    <button className="btn btn-g btn-sm" disabled={holdMut.isLoading || !review.notes.trim()}
                      title="Uses your Notes text as the hold reason"
                      onClick={() => holdMut.mutate({ id: review.row.id, reason: review.notes.trim() })}>
                      Place verification hold
                    </button>
                    {' '}— silent, spot preserved. Needs a reason in Notes.
                  </div>
                </div>
              )
            })()}
            <div className="fg">
              <label className="fl">Notes {review.action === 'decline' ? '(reason)' : '(optional)'}</label>
              <textarea className="inp" rows={3} maxLength={2000} value={review.notes}
                onChange={e => setReview({ ...review, notes: e.target.value })} />
            </div>
            {review.action === 'approve' && !review.row.proofUploadedAt && (
              <div style={{ fontSize: '.78rem', color: 'var(--amber)', margin: '10px 0', padding: 10, background: 'rgba(245,158,11,.08)', borderRadius: 6 }}>
                ⚠ No proof of benefits on file — approval will be refused until the tenant uploads their award letter.
              </div>
            )}
            {reviewError && (
              <div style={{ fontSize: '.78rem', color: 'var(--red, #ef4444)', margin: '10px 0', padding: 10, background: 'rgba(239,68,68,.08)', borderRadius: 6 }}>
                {reviewError}
              </div>
            )}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 16 }}>
              <button className="btn btn-g" onClick={() => { setReview(null); setReviewError(null) }}>Cancel</button>
              <button className={`btn ${review.action === 'approve' ? 'btn-p' : 'btn-g'}`}
                disabled={reviewMut.isLoading}
                onClick={() => reviewMut.mutate({ id: review.row.id, action: review.action, incomeVerified: review.incomeVerified, nameMatchConfirmed: review.nameMatchConfirmed, notes: review.notes } as any)}>
                {reviewMut.isLoading ? 'Saving…' : review.action === 'approve' ? 'Approve request' : 'Decline request'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ── S605: Signup outreach — did it land, and did they act? ────────────────
//
// Nic asked "can we tell if Charlie ever opened the email". Opens are
// deliberately NOT here: they need a 1x1 pixel, Apple Mail Privacy Protection
// pre-fetches remote images for every message (false positives for a large
// share of recipients), and anyone blocking images reads it without registering
// (false negatives). The outreach email is also deliberately image-free so it
// reads as a person, not a campaign.
//
// What IS here is trustworthy: the recipient server accepted it (or bounced),
// and whether they clicked the booking link — which is first-party, server-side
// and proves intent rather than proving an image loaded.
const STAGE_STYLE: Record<string, { label: string; color: string }> = {
  booked:        { label: 'Booked a call', color: '#4f9d69' },
  clicked:       { label: 'Clicked link',  color: '#c9a227' },
  delivered:     { label: 'Delivered',     color: 'var(--t1)' },
  sent:          { label: 'Sent',          color: 'var(--t3)' },
  undeliverable: { label: 'Undeliverable', color: '#c9635b' },
  failed:        { label: 'Send failed',   color: '#c9635b' },
}

function OutreachStatus() {
  const { user } = useAuth()
  const { data = [], isLoading } = useQuery<any[]>(
    'outreach-status', () => get<any[]>('/admin/outreach-status'),
    { enabled: !!user, staleTime: 60000, refetchOnWindowFocus: false })
  if (!user) return null

  const fmt = (d: any) => d ? new Date(d).toLocaleString('en-US',
    { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—'

  return (
    <div>
      <h1 className="pt">Signup Outreach</h1>
      <p className="ps">
        Whether the post-signup onboarding email reached self-signed-up landlords, and what they did next.
      </p>

      <div className="card" style={{ marginTop: 16, padding: 14, fontSize: '.78rem', color: 'var(--t2)', lineHeight: 1.6 }}>
        <strong style={{ color: 'var(--t0)' }}>No open tracking, on purpose.</strong>{' '}
        Opens need a tracking pixel, and Apple Mail pre-fetches images for every message — so "opened"
        would read as true for people who never looked, and false for anyone blocking images.
        <strong style={{ color: 'var(--t0)' }}> Clicked link</strong> is the honest signal: it means they
        opened the email and came to book.
      </div>

      <div className="card" style={{ marginTop: 16, padding: 0 }}>
        {isLoading ? (
          <div style={{ padding: 20, color: 'var(--t3)', fontSize: '.82rem' }}>Loading…</div>
        ) : data.length === 0 ? (
          <div style={{ padding: 20, color: 'var(--t3)', fontSize: '.82rem' }}>
            No outreach sent yet. It fires ~90 minutes after an organic landlord signs up.
          </div>
        ) : (
          <table className="tbl">
            <thead><tr>
              <th>Landlord</th><th>Stage</th><th>Emailed</th><th>Delivery</th>
              <th>Clicked</th><th>Call</th><th>Properties</th>
            </tr></thead>
            <tbody>
              {data.map((r) => {
                const st = STAGE_STYLE[r.stage] || STAGE_STYLE.sent
                return (
                  <tr key={r.landlordId}>
                    <td>
                      <div style={{ color: 'var(--t0)', fontWeight: 600 }}>{r.name}</div>
                      <div style={{ fontSize: '.72rem', color: 'var(--t3)' }}>{r.email}</div>
                    </td>
                    <td><span style={{ color: st.color, fontWeight: 700, fontSize: '.78rem' }}>{st.label}</span></td>
                    <td className="mono" style={{ fontSize: '.74rem' }}>{fmt(r.emailSentAt)}</td>
                    <td style={{ fontSize: '.74rem' }}>
                      {r.deliveryEvent
                        ? <span style={{ color: r.deliveryEvent === 'delivered' ? '#4f9d69' : '#c9635b' }}>{r.deliveryEvent}</span>
                        : <span style={{ color: 'var(--t3)' }} title="No delivery webhook received — is the Resend webhook configured?">unknown</span>}
                    </td>
                    <td className="mono" style={{ fontSize: '.74rem' }}>
                      {r.clickedAt ? fmt(r.clickedAt) + (r.clickCount > 1 ? ` (${r.clickCount}×)` : '') : '—'}
                    </td>
                    <td className="mono" style={{ fontSize: '.74rem' }}>{fmt(r.bookedCallAt)}</td>
                    <td className="mono" style={{ fontSize: '.74rem', color: r.propertyCount ? 'var(--t1)' : 'var(--t3)' }}>
                      {r.propertyCount}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}

// ── S605: Deposit interest — pool spread + the 50-state catalog ───────────
//
// S604 built the whole engine and catalog and left them readable only in psql.
// SUPER-ADMIN ONLY: `earned`, `spread` and the market rate are GAM's margin.
// The same boundary was drawn twice already (calcNetPerUnit must not reach
// landlords; getAccrualHistory strips these before the tenant portal sees it).
//
// Nic's core model, which the copy here has to reflect honestly: GAM earns on
// EVERY held deposit and pays only where a state + unit type requires it. So a
// state with no obligation is the BEST case — "no obligation, full spread to
// GAM" — never "negative". Spread is signed: AZ mobile home (5% statutory vs
// ~3.5% market) genuinely runs negative and GAM funds it.
function DepositInterest() {
  const { user } = useAuth()
  const { data: spread, isLoading: loadingSpread } = useQuery<any>(
    'deposit-interest-spread', () => get<any>('/admin/deposit-interest/spread'),
    { enabled: !!user, staleTime: 60000, refetchOnWindowFocus: false })
  const { data: catalog, isLoading: loadingCatalog } = useQuery<any>(
    'deposit-interest-catalog', () => get<any>('/admin/deposit-interest/catalog'),
    { enabled: !!user, staleTime: 300000, refetchOnWindowFocus: false })
  const [tab, setTab] = useState<'spread' | 'catalog'>('spread')
  const [onlyObligations, setOnlyObligations] = useState(false)

  if (!user) return null
  const months: any[] = spread?.months || []
  const totals = spread?.totals || { principal: 0, owed: 0, earned: 0, spread: 0 }
  const states: any[] = catalog?.states || []
  const summary = catalog?.summary || {}
  const shown = onlyObligations
    ? states.filter((s) => s.rateBasis && s.rateBasis !== 'none')
    : states

  return (
    <div>
      <h1 className="pt">Deposit Interest</h1>
      <p className="ps">
        What GAM earns on held deposits versus what each state actually requires us to pay.
      </p>

      {/* The index gap is a live correctness issue, not a to-do: an
          index_linked state with no published value computes $0 owed, which is
          WRONG rather than merely unknown. Surface it loudly. */}
      {summary.needsIndexValue?.length > 0 && (
        <div className="card" style={{ marginTop: 16, padding: 16, borderLeft: '3px solid #e0a23a' }}>
          <div style={{ fontWeight: 700, color: 'var(--t0)', fontSize: '.86rem' }}>
            {summary.needsIndexValue.join(', ')} need a published index value
          </div>
          <div style={{ fontSize: '.78rem', color: 'var(--t2)', marginTop: 4 }}>
            These states owe interest at a published index rate. Until the real value is loaded the
            engine computes <strong>$0 owed</strong>, which would under-pay tenants there. Harmless
            while no landlord operates in these states — load the rate before one does.
          </div>
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, marginTop: 18, marginBottom: 14 }}>
        <button className={`btn bsm${tab === 'spread' ? ' bgold' : ' bd'}`} onClick={() => setTab('spread')}>Pool spread</button>
        <button className={`btn bsm${tab === 'catalog' ? ' bgold' : ' bd'}`} onClick={() => setTab('catalog')}>State catalog</button>
      </div>

      {tab === 'spread' && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(170px,1fr))', gap: 12 }}>
            {[
              { label: 'Principal held', v: totals.principal, c: 'var(--t0)' },
              { label: 'Earned', v: totals.earned, c: '#4f9d69' },
              { label: 'Owed to tenants', v: totals.owed, c: '#c9635b' },
              { label: 'Spread to GAM', v: totals.spread, c: 'var(--gold)' },
            ].map((k) => (
              <div key={k.label} className="card" style={{ padding: 16 }}>
                <div style={{ fontSize: '.62rem', color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '.12em' }}>{k.label}</div>
                <div style={{ fontFamily: 'var(--font-d)', fontSize: '1.5rem', fontWeight: 800, color: k.c, marginTop: 6 }}>
                  {formatCurrency(k.v)}
                </div>
              </div>
            ))}
          </div>
          <div className="card" style={{ marginTop: 16, padding: 0 }}>
            {loadingSpread ? (
              <div style={{ padding: 20, color: 'var(--t3)', fontSize: '.82rem' }}>Loading…</div>
            ) : months.length === 0 ? (
              <div style={{ padding: 20, color: 'var(--t3)', fontSize: '.82rem' }}>
                No accruals yet — the monthly job writes a row for every held deposit, including the
                ones with no statutory obligation.
              </div>
            ) : (
              <table className="tbl">
                <thead><tr>
                  <th>Month</th><th>Deposits</th><th>Principal</th><th>Earned</th><th>Owed</th><th>Spread</th><th>Market</th>
                </tr></thead>
                <tbody>
                  {months.map((m) => (
                    <tr key={m.accrualMonth}>
                      <td className="mono">{String(m.accrualMonth).slice(0, 7)}</td>
                      <td>{m.deposits}</td>
                      <td className="mono">{formatCurrency(m.principal)}</td>
                      <td className="mono" style={{ color: '#4f9d69' }}>{formatCurrency(m.earned)}</td>
                      <td className="mono" style={{ color: '#c9635b' }}>{formatCurrency(m.owed)}</td>
                      <td className="mono" style={{ color: m.spread < 0 ? '#c9635b' : 'var(--gold)', fontWeight: 700 }}>
                        {formatCurrency(m.spread)}
                      </td>
                      <td className="mono" style={{ color: 'var(--t3)' }}>{m.marketRatePct == null ? '—' : m.marketRatePct + '%'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}

      {tab === 'catalog' && (
        <>
          <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'center', marginBottom: 12 }}>
            <span style={{ fontSize: '.76rem', color: 'var(--t2)' }}>
              <strong style={{ color: 'var(--t0)' }}>{summary.obligations}</strong> obligations ·{' '}
              <strong style={{ color: 'var(--t0)' }}>{summary.noObligation}</strong> no obligation (full spread) ·{' '}
              <strong style={{ color: '#4f9d69' }}>{summary.custodySupported}</strong> custody-supported ·{' '}
              <strong style={{ color: '#c9635b' }}>{summary.custodyBlocked}</strong> blocked
            </span>
            <button className={`btn bsm${onlyObligations ? ' bgold' : ' bd'}`} onClick={() => setOnlyObligations((v) => !v)}>
              Only states that owe
            </button>
          </div>
          <div className="card" style={{ padding: 0 }}>
            {loadingCatalog ? (
              <div style={{ padding: 20, color: 'var(--t3)', fontSize: '.82rem' }}>Loading…</div>
            ) : (
              <table className="tbl">
                <thead><tr>
                  <th>State</th><th>Basis</th><th>Rate</th><th>Unit types</th><th>Gates</th><th>Custody</th><th>Statute</th>
                </tr></thead>
                <tbody>
                  {shown.map((s, i) => {
                    const gates = [
                      s.minTenureMonths ? `${s.minTenureMonths}mo tenure` : null,
                      s.minPropertyUnits ? `${s.minPropertyUnits}+ units` : null,
                      s.thresholdRule === 'excess_only' ? 'excess only' : null,
                      s.thresholdRule === 'trigger' ? 'whole deposit above threshold' : null,
                    ].filter(Boolean).join(' · ')
                    const noObligation = !s.rateBasis || s.rateBasis === 'none'
                    return (
                      <tr key={s.stateCode + i}>
                        <td className="mono" style={{ fontWeight: 700 }}>{s.stateCode}</td>
                        <td style={{ fontSize: '.76rem', color: noObligation ? '#4f9d69' : 'var(--t1)' }}>
                          {noObligation ? 'no obligation' : humanizeBasis(s.rateBasis)}
                        </td>
                        <td className="mono" style={{ fontSize: '.76rem' }}>
                          {s.needsIndexValue
                            ? <span style={{ color: '#e0a23a' }}>index needed</span>
                            : rateCell(s)}
                        </td>
                        <td style={{ fontSize: '.72rem', color: 'var(--t3)' }}>
                          {(s.unitTypes || []).length ? s.unitTypes.join(', ') : 'all'}
                        </td>
                        <td style={{ fontSize: '.72rem', color: 'var(--t3)' }}>{gates || '—'}</td>
                        <td style={{ fontSize: '.74rem' }}>
                          <span style={{ color: s.custodyStatus === 'supported' ? '#4f9d69' : s.custodyStatus === 'blocked' ? '#c9635b' : '#e0a23a' }}>
                            {s.custodyStatus}
                          </span>
                          {s.qualifiesWithSegregatedAccount && s.custodyStatus !== 'supported' &&
                            <span style={{ color: 'var(--t3)', fontSize: '.68rem' }}> · pocket a/c would fix</span>}
                        </td>
                        <td style={{ fontSize: '.68rem', color: 'var(--t3)', maxWidth: 220 }}>{s.statuteCitation || s.custodyCitation || '—'}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}
    </div>
  )
}

// The meaningful number depends on the BASIS, and several states carry more
// than one. Florida § 83.49 is the clearest case: it stores annual_rate_pct 5
// AND actual_share_pct 75, because the landlord may pay either 5% simple
// interest OR 75% of what was actually earned — showing only the 5% would
// misstate the rule. NY/PA store their 1% admin retention separately, and
// reading annual_rate_pct alone (0) would render "actual earned" and silently
// drop the retention.
function rateCell(s: any): string {
  const pct = (n: any) => `${Number(n)}%`
  switch (s.rateBasis) {
    case 'fixed':            return pct(s.annualRatePct)
    case 'lesser_of_actual': return `${pct(s.annualRatePct)} or actual, whichever is less`
    case 'share_of_actual':  return s.annualRatePct > 0
      ? `${pct(s.annualRatePct)} flat, or ${pct(s.actualSharePct)} of actual`
      : `${pct(s.actualSharePct)} of actual`
    case 'actual_minus_admin': return `actual − ${pct(s.adminRetentionPct)} admin`
    case 'actual_earned':      return 'actual earned'
    case 'index_linked':       return s.annualRatePct > 0 ? pct(s.annualRatePct) : 'index needed'
    default:                   return '—'
  }
}

function humanizeBasis(b: string): string {
  const M: Record<string, string> = {
    fixed: 'fixed rate',
    lesser_of_actual: 'lesser of rate/actual',
    share_of_actual: 'share of actual',
    actual_earned: 'actual earned',
    actual_minus_admin: 'actual minus admin',
    index_linked: 'index-linked',
    none: 'no obligation',
  }
  return M[b] || b
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

installDatePickerAutoClose()

// HMR guard: when Vite re-executes this entry module, calling createRoot on
// the same container again STACKS a second mounted app under the first
// (duplicate dashboards/login screens, dead nav). Reuse the one root and
// just re-render into it — idempotent across hot updates.
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
