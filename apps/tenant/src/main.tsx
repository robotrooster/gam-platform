import { SentryErrorBoundary } from './lib/sentry'
import { AcceptInvitePage } from './pages/AcceptInvitePage'
import { BackgroundCheckPage } from './pages/BackgroundCheckPage'
import { TenantNotificationsPage } from './pages/TenantNotificationsPage'
import { ForgotPasswordPage } from './pages/ForgotPasswordPage'
import { ResetPasswordPage } from './pages/ResetPasswordPage'
import { VerifyEmailPage } from './pages/VerifyEmailPage'

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
import { PayoutsPage } from './pages/PayoutsPage'
import { PosCustomerOnboardingPage } from './pages/PosCustomerOnboardingPage'
import React, { useContext, useState, useEffect, useCallback } from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter, Routes, Route, Navigate, NavLink, Outlet, useNavigate, useParams, Link, useLocation } from 'react-router-dom'
import { QueryClient, QueryClientProvider, useQuery, useMutation, useQueryClient } from 'react-query'
import { useForm } from 'react-hook-form'
import axios from 'axios'
import { formatCurrency, applyCamelizeInterceptor } from '@gam/shared'
import { AgentChatWidget, SupportPage } from './components/AgentChatWidget'
import { CameraCapture } from './components/CameraCapture'

// ── API ──────────────────────────────────────────────────────
const API_URL = (import.meta as any).env?.VITE_API_URL || 'http://localhost:4000'
const api = axios.create({ baseURL: `${API_URL}/api` })

// ── Auth-gated media (S513) ───────────────────────────────────
// Inspection photo/video file routes sit behind requireAuth, which
// only honors an `Authorization: Bearer` header — a plain
// <img src>/<video src> can't send it, so it 401s. Fetch the file
// as a blob with the tenant token and render via an object URL,
// revoking on unmount. Mirrors the landlord AuthedMedia helper.
// Blob trade-off: video loses HTTP range/seek; fine for short
// walkthrough clips.
function useAuthedBlob(path: string): { src: string | null; failed: boolean } {
  const [src, setSrc] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let url: string | null = null
    let cancelled = false
    setSrc(null)
    setFailed(false)
    const token = localStorage.getItem('gam_tenant_token') || ''
    fetch(`${API_URL}${path}`, { headers: { Authorization: 'Bearer ' + token } })
      .then(r => (r.ok ? r.blob() : Promise.reject(new Error('status ' + r.status))))
      .then(blob => { if (!cancelled) { url = URL.createObjectURL(blob); setSrc(url) } })
      .catch(() => { if (!cancelled) setFailed(true) })
    return () => { cancelled = true; if (url) URL.revokeObjectURL(url) }
  }, [path])
  return { src, failed }
}

function AuthedImg({ path, alt, style }: { path: string; alt: string; style?: React.CSSProperties }) {
  const { src, failed } = useAuthedBlob(path)
  if (failed) return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg1)', color: 'var(--t3)', fontSize: '.62rem', width: '100%', height: '100%', ...style }}>unavailable</div>
  if (!src) return <div style={{ background: 'var(--bg3)', width: '100%', height: '100%', ...style }} />
  return <img src={src} alt={alt} style={style} />
}

function AuthedVideo({ path, style }: { path: string; style?: React.CSSProperties }) {
  const { src, failed } = useAuthedBlob(path)
  if (failed) return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#000', color: 'var(--t3)', fontSize: '.7rem', aspectRatio: '16/9', ...style }}>video unavailable</div>
  if (!src) return <div style={{ background: '#000', aspectRatio: '16/9', ...style }} />
  return <video controls preload="metadata" src={src} style={style} />
}

// S512 LAUNCH: tenant features hidden for the initial launch — the Flex
// Suite hub (/services) and the credit-ledger surfaces (/credit, /my-disputes,
// which are the FlexCredit/internal-scoring tenant view). Nav links are
// filtered and routes redirect to /home; the pages + backend stay intact.
// Unhide post-launch by emptying this set.
const LAUNCH_HIDDEN = new Set<string>(['/services', '/credit', '/my-disputes'])
const LAUNCH_HIDE_FITNESS = true
api.interceptors.request.use(c => { const t = localStorage.getItem('gam_tenant_token'); if(t) c.headers.Authorization=`Bearer ${t}`; return c })
api.interceptors.response.use(r=>r, e => { if(e.response?.status===401){localStorage.removeItem('gam_tenant_token');window.location.href='/login'} return Promise.reject(e) })
// S312: snake_case → camelCase response transform (see lib/api.ts comment + packages/shared/src/camelize.ts).
applyCamelizeInterceptor(api)
const get = <T,>(url: string) => api.get<{success:boolean;data:T}>(url).then(r=>r.data.data)
const post = <T,>(url: string, body?: any) => api.post<{success:boolean;data:T;message?:string}>(url,body).then(r=>r.data)

// ── AUTH ──────────────────────────────────────────────────────
// S289: optional 2FA. Tenant is NOT in MANDATORY_TOTP_ROLES, so
// mustEnrollTotp is always false here — no enrollment gate, no nag.
// totpEnabled reflects whether the tenant opted in via the Security
// page; when true, login gates on the TOTP second step.
interface AuthUser { id:string;email:string;role:string;firstName:string;lastName:string;profileId:string;totpEnabled?:boolean;mustEnrollTotp?:boolean }
// S289: login() returns a discriminated result so LoginPage can branch
// into the TOTP second step when the backend gates on 2FA.
type LoginResult = { kind:'success' } | { kind:'totp_required'; totpSession:string }
interface AuthCtx { user:AuthUser|null;token:string|null;loading:boolean;login:(e:string,p:string)=>Promise<LoginResult>;loginWithTotp:(totpSession:string,code:string)=>Promise<void>;refresh:()=>Promise<void>;logout:()=>void }
const Ctx = React.createContext<AuthCtx>(null!)
const useAuth = () => useContext(Ctx)

function AuthProvider({children}:{children:React.ReactNode}) {
  const [user,setUser]=useState<AuthUser|null>(null)
  const [token,setToken]=useState<string|null>(()=>localStorage.getItem('gam_tenant_token'))
  const [loading,setLoading]=useState(true)
  const logout = useCallback(()=>{localStorage.removeItem('gam_tenant_token');setToken(null);setUser(null)},[])
  const refresh = useCallback(async()=>{
    const t = localStorage.getItem('gam_tenant_token')
    if(!t){setLoading(false);return}
    try{ const u = await get<AuthUser>('/auth/me'); setUser(u) }
    catch{ logout() }
    finally{ setLoading(false) }
  },[logout])
  useEffect(()=>{
    if(!token){setLoading(false);return}
    get<AuthUser>('/auth/me').then(u=>setUser(u)).catch(logout).finally(()=>setLoading(false))
  },[token,logout])
  // S289: post-credentials login. Returns a discriminated result so
  // LoginPage can pivot into the TOTP second step when 2FA is enabled
  // on the account. Doesn't set user state until the full JWT lands —
  // a totp_session JWT is not a valid auth token.
  const login = async(email:string,password:string):Promise<LoginResult>=>{
    const res=await post<any>('/auth/login',{email,password})
    const data=res.data!
    if(data.requiresTotp){ return { kind:'totp_required', totpSession:data.totpSession as string } }
    const { token:tk, user:u } = data as { token:string; user:AuthUser }
    localStorage.setItem('gam_tenant_token',tk);setToken(tk);setUser(u)
    return { kind:'success' }
  }
  // S289: TOTP second-step exchange. Trades the short-lived totp_session
  // JWT (from /login) plus a 6-digit token or recovery code for the full
  // session JWT, then loads the user from /auth/me.
  const loginWithTotp = async(totpSession:string,code:string):Promise<void>=>{
    const res=await post<{token:string}>('/auth/totp/verify',{totpSession,code})
    const tk=res.data!.token
    localStorage.setItem('gam_tenant_token',tk)
    api.defaults.headers.common['Authorization']='Bearer '+tk
    const u=await get<AuthUser>('/auth/me')
    setUser(u);setToken(tk)
  }
  return <Ctx.Provider value={{user,token,loading,login,loginWithTotp,refresh,logout}}>{children}</Ctx.Provider>
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
  const pendingDocId = (pendingDocs as any[])[0]?.documentId
  return pendingDocId
    ? <NavLink to={'/sign/'+pendingDocId} className={({isActive})=>`ni${isActive?' active':''}`}>📋 Lease</NavLink>
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

// Tenant #6: full-page lockout when the 48h move-in inspection deadline lapsed.
// The ONLY action is to go complete the inspection (the /inspections route stays
// reachable so this isn't a dead end).
function MoveInLockout({ gate }: { gate: any }) {
  const navigate = useNavigate()
  const due = gate?.deadline ? new Date(gate.deadline).toLocaleString('en-US',
    { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : null
  return (
    <div style={{ maxWidth: 560, margin: '40px auto' }}>
      <div className="card" style={{ padding: 28, borderLeft: '4px solid var(--red,#e25555)' }}>
        <h1 className="pt" style={{ fontSize: '1.4rem', marginBottom: 8 }}>⚠️ Move-in inspection overdue</h1>
        <p className="ps" style={{ marginBottom: 14, lineHeight: 1.6 }}>
          Your move-in inspection had to be completed within <b>48 hours of your lease start</b>
          {due ? <> (the deadline was <b>{due}</b>)</> : null}. Because it wasn’t finished in time, the rest
          of your portal is locked, and <b>you’ve assumed liability for any condition issues left
          undocumented</b> in the unit.
        </p>
        <p className="ps" style={{ marginBottom: 20, lineHeight: 1.6 }}>
          You can still complete the inspection now to document the unit’s condition and restore full
          access. Finish every area, then sign it.
        </p>
        <button className="btn btn-g" onClick={() => navigate(
          gate?.inspectionId ? `/inspections/${gate.inspectionId}` : '/inspections')}>
          Complete my move-in inspection →
        </button>
      </div>
    </div>
  )
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
  const accent = tenantMe?.themeAccent || '#c9a227'
  const fontKey = tenantMe?.fontStyle || 'default'
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
  // S508 (#2): an existing tenant (has an active lease → unitId) is past the
  // application stage — show them the full portal and never the Application tab,
  // regardless of whether a GAM background check was ever run/approved.
  const isExistingTenant = !!(tenantMe as any)?.unitId
  const showFullNav = bgApproved || isExistingTenant
  const { user, logout } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  // Tenant #6: 48h move-in-inspection deadline. Once overdue + still incomplete,
  // the tenant is locked out of everything EXCEPT completing the inspection.
  const { data: moveInGate } = useQuery('move-in-gate', () =>
    fetch((import.meta as any).env?.VITE_API_URL + '/api/tenants/me/move-in-gate', {
      headers: { Authorization: 'Bearer ' + localStorage.getItem('gam_tenant_token') }
    }).then(r=>r.json()).then(r=>r.data),
    { refetchInterval: 300000 }
  )
  const onInspectionRoute = location.pathname.startsWith('/inspections')
  const moveInLocked = moveInGate?.gated === true && !onInspectionRoute
  return (
    <div className="shell">
      <style dangerouslySetInnerHTML={{__html: themeCss}} />
      <aside className="sidebar">
        <div className="logo">
          <div className="logo-name">⚡ GAM Tenant</div>
          <div className="logo-sub">Gold Asset Management</div>
        </div>
        <nav className="nav">
          {!showFullNav && (
            <NavLink to="/background-check" className={({isActive})=>`ni${isActive?' active':''}`}>🛡 Application</NavLink>
          )}
          {showFullNav && <>
            <NavLink to="/home" className={({isActive})=>`ni${isActive?' active':''}`}>🏠 Home</NavLink>
            {!LAUNCH_HIDDEN.has('/services') && <NavLink to="/services" className={({isActive})=>`ni${isActive?' active':''}`}>⭐ Flex Advantage</NavLink>}
            <NavLink to="/payments" className={({isActive})=>`ni${isActive?' active':''}`}>💳 Payments</NavLink>
            <NavLink to="/maintenance" className={({isActive})=>`ni${isActive?' active':''}`}>🔧 Maintenance</NavLink>
            <NavLink to="/support" className={({isActive})=>`ni${isActive?' active':''}`}>💬 Support</NavLink>
            <NavLink to="/inspections" className={({isActive})=>`ni${isActive?' active':''}`}>📋 Inspections</NavLink>
            <NavLink to="/walkthroughs" className={({isActive})=>`ni${isActive?' active':''}`}>🎥 My walkthroughs</NavLink>
            <NavLink to="/entry-requests" className={({isActive})=>`ni${isActive?' active':''}`}>🚪 Entry Requests</NavLink>
            <NavLink to="/amenities" className={({isActive})=>`ni${isActive?' active':''}`}>🎉 Amenities</NavLink>
            {!LAUNCH_HIDDEN.has('/credit') && <NavLink to="/credit" className={({isActive})=>`ni${isActive?' active':''}`}>📊 My Record</NavLink>}
            {!LAUNCH_HIDDEN.has('/my-disputes') && <NavLink to="/my-disputes" className={({isActive})=>`ni${isActive?' active':''}`}>⚖️ My Disputes</NavLink>}
            <LeaseNavLink/>
          </>}
          <NavLink to="/notifications" className={({isActive})=>`ni${isActive?' active':''}`}>🔔 Notifications</NavLink>
          <NavLink to="/notification-prefs" className={({isActive})=>`ni${isActive?' active':''}`} style={{paddingLeft:24,fontSize:'.78rem'}}>· Preferences</NavLink>
          {showFullNav && tenantMe?.stripeConnectAccountId && (
            <NavLink to="/payouts" className={({isActive})=>`ni${isActive?' active':''}`}>🏦 Payouts</NavLink>
          )}
          {showFullNav && <NavLink to="/profile" className={({isActive})=>`ni${isActive?' active':''}`}>👤 Profile</NavLink>}
          <NavLink to="/security" className={({isActive})=>`ni${isActive?' active':''}`}>🔐 Security</NavLink>
          {/* GAM Fitness — standalone app (:3013). Hand off the portal's JWT
              via ?sso= so the tenant lands signed-in without re-auth. */}
          {!LAUNCH_HIDE_FITNESS && (
          <a className="ni" href="#" onClick={e=>{e.preventDefault();const t=localStorage.getItem('gam_tenant_token')||'';const base=(import.meta as any).env?.VITE_FITNESS_URL||'http://localhost:3013';window.open(`${base}/?sso=${encodeURIComponent(t)}`,'_blank')}}>🏋️ Fitness</a>
          )}
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
        <div className="page">{moveInLocked ? <MoveInLockout gate={moveInGate} /> : <Outlet />}</div>
      </div>
      {showFullNav && <FlexsuiteReAcceptanceGate />}
      <AgentChatWidget />
    </div>
  )
}

// ── HOME PAGE ─────────────────────────────────────────────────
// Live utility-outage notices affecting this resident (water/power/etc. down,
// with expected-back time). Fed by GET /service-interruptions/mine.
function ServiceOutageBanner() {
  const { data: notices = [] } = useQuery<any[]>('service-interruptions-mine',
    () => get<any[]>('/service-interruptions/mine'), { refetchInterval: 120000 })
  if (!notices.length) return null
  const utilLbl: Record<string, string> = {
    water: 'Water', power: 'Power', gas: 'Gas', heat_ac: 'Heat / AC',
    elevator: 'Elevator', internet: 'Internet', parking: 'Parking', other: 'Service',
  }
  const fmtW = (s: string | null) => s ? new Date(s).toLocaleString('en-US',
    { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : null
  return (
    <div style={{ display: 'grid', gap: 8, marginBottom: 16 }}>
      {notices.map(n => (
        <div key={n.id} className="card" style={{
          padding: 14, borderLeft: `4px solid ${n.isEmergency ? 'var(--red,#e25555)' : 'var(--amber,#e0a93b)'}`,
        }}>
          <div style={{ fontWeight: 700, color: 'var(--t0)' }}>
            {n.isEmergency ? '🚨 ' : '🔧 '}{utilLbl[n.utilityType] ?? 'Service'} {n.isEmergency ? 'outage' : 'interruption'}
            {n.title ? ` — ${n.title}` : ''}
          </div>
          {n.message && <div className="ps" style={{ marginTop: 3 }}>{n.message}</div>}
          <div style={{ fontSize: '.78rem', color: 'var(--t2)', marginTop: 5 }}>
            {fmtW(n.startsAt)}{n.expectedRestoreAt ? ` · expected back ${fmtW(n.expectedRestoreAt)}` : ' · until further notice'}
          </div>
        </div>
      ))}
    </div>
  )
}

function HomePage() {
  const { user } = useAuth()
  const { data: me } = useQuery('tenant-me', () => get<any>('/tenants/me'))
  const { data: health } = useQuery<any>('tenant-payment-health', () => get<any>('/tenants/me/payment-health'))
  const [bulletinScope, setBulletinScope] = useState<'property'|'city'|'state'>('property')
  const [bulletinSort, setBulletinSort] = useState<'new'|'old'>('new')
  const [bulletinSearch, setBulletinSearch] = useState('')
  const [bulletinDraft, setBulletinDraft] = useState('')
  const [bulletinPosting, setBulletinPosting] = useState(false)
  const [bulletinPosts, setBulletinPosts] = useState<any[]>([])
  const [bulletinLoading, setBulletinLoading] = useState(false)
  const [bulletinRefreshing, setBulletinRefreshing] = useState(false)

  const bulletinFirstLoad = React.useRef(true)
  useEffect(() => {
    const isFirst = bulletinFirstLoad.current
    bulletinFirstLoad.current = false
    const delay = bulletinSearch ? 400 : 0
    const timer = setTimeout(() => {
      if (isFirst) setBulletinLoading(true)
      else setBulletinRefreshing(true)
      const params = new URLSearchParams({ scope: bulletinScope, sort: bulletinSort })
      if (bulletinSearch) params.set('search', bulletinSearch)
      get<any[]>('/bulletin?'+params.toString())
        .then(d => setBulletinPosts(d || []))
        .catch(()=>{})
        .finally(()=>{ setBulletinLoading(false); setBulletinRefreshing(false) })
    }, delay)
    return () => clearTimeout(timer)
  }, [bulletinScope, bulletinSort, bulletinSearch])

  return (
    <div>
      <div className="ph">
        <div>
          <h1 className="pt">Hi, {user?.firstName} 👋</h1>
          <p className="ps">{me?.propertyName} · Unit {me?.unitNumber}</p>
        </div>
      </div>

      <ServiceOutageBanner />
      <LandlordBankingBanner />

      {/* S311: removed the dashboard "On-Time Pay Qualification"
          progression strip + "On-Time Pay is active" alert + header
          OTP-Active badge. OTP is a landlord-only product as of S155;
          the tenant portal must not surface OTP framing per the
          project_flexsuite_otp_hidden.md memory ("OTP inverse:
          landlord-only, never tenant"). The deposit-funded and
          ACH-verified signals these surfaces visualized are still
          available through the dedicated cards: the security-deposit
          KPI tile below, the Lease Details ACH row, and the
          AchVerifyForm on /services. */}

      <div className="grid3" style={{marginBottom:24}}>
        <a href="/payments" style={{textDecoration:'none'}} className="kpi"
          onMouseEnter={e=>(e.currentTarget as any).style.borderColor='var(--gold)'}
          onMouseLeave={e=>(e.currentTarget as any).style.borderColor=''}>
          <div className="kpi-l">Monthly Rent</div>
          <div className="kpi-v" style={{color:'var(--gold)'}}>{me?.rentAmount ? formatCurrency(me.rentAmount) : '—'}</div>
          <div className="kpi-s">Due 1st · tap to view history →</div>
        </a>
        <div className="kpi">
          <div className="kpi-l">Unit Status</div>
          <div className="kpi-v" style={{fontSize:'1.1rem',marginTop:4}}>
            <span className={`badge ${me?.unitStatus==='active'?'b-green':me?.unitStatus==='delinquent'?'b-amber':'b-muted'}`}>{me?.unitStatus||'—'}</span>
          </div>
          <div className="kpi-s">{me?.propertyName}</div>
        </div>
        {LAUNCH_HIDDEN.has('/services') ? (
          // S512 launch: Flex Suite hidden — deposit KPI is informational
          // only (no /services link, no FlexDeposit framing).
          <div className="kpi">
            <div className="kpi-l">Security Deposit</div>
            <div className="kpi-v">{me?.depositTotal ? formatCurrency(me.depositTotal) : '—'}</div>
            <div className="kpi-s">Held in custody</div>
          </div>
        ) : (
          <a href="/services" style={{textDecoration:'none'}} className="kpi"
            onMouseEnter={e=>(e.currentTarget as any).style.borderColor='var(--gold)'}
            onMouseLeave={e=>(e.currentTarget as any).style.borderColor=''}>
            <div className="kpi-l">Security Deposit</div>
            <div className="kpi-v">{me?.depositTotal ? formatCurrency(me.depositTotal) : '—'}</div>
            <div className="kpi-s">{me?.flexDepositEnrolled ? 'FlexDeposit installments' : 'Paid in full'} →</div>
          </a>
        )}
      </div>

      {/* #12: Payment Health — the tenant's own view of the on-time-rate card
          the landlord sees on TenantDetailPage. Only shown once there's a
          payment history to summarize. */}
      {health && health.totalPayments > 0 && (() => {
        const rate = health.onTimeRate as number
        const color = rate >= 90 ? 'var(--green,#2fbf71)' : rate >= 75 ? 'var(--amber,#e0a93b)' : 'var(--red,#e25555)'
        const label = rate >= 90 ? 'Excellent' : rate >= 75 ? 'Good' : 'Needs attention'
        return (
          <a href="/payments" className="card" style={{ display: 'block', textDecoration: 'none', padding: 18, marginBottom: 24 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
              <div>
                <div style={{ fontWeight: 700, color: 'var(--t0)' }}>Payment Health</div>
                <div className="ps" style={{ marginTop: 2 }}>
                  {health.settledCount} of {health.totalPayments} payments settled
                  {health.tenantMonths > 0 ? ` · ${health.tenantMonths} mo on platform` : ''}
                </div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <div style={{ fontFamily: 'var(--font-mono,monospace)', fontSize: '1.6rem', fontWeight: 800, color }}>{rate}%</div>
                <div style={{ fontSize: '.72rem', color }}>{label}</div>
              </div>
            </div>
            <div style={{ marginTop: 12, height: 7, borderRadius: 4, background: 'var(--b1,#1e2530)', overflow: 'hidden' }}>
              <div style={{ width: `${rate}%`, height: '100%', background: color }} />
            </div>
          </a>
        )
      })()}

      <div className="grid2">
        <a href="/lease" style={{textDecoration:'none'}} className="card"
          onMouseEnter={e=>(e.currentTarget as any).style.borderColor='var(--gold)'}
          onMouseLeave={e=>(e.currentTarget as any).style.borderColor=''}>
          <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:16}}>
            <h3>Lease Details</h3>
            <span style={{fontSize:'.72rem',color:'var(--t3)'}}>View lease →</span>
          </div>
          <div className="dr"><span className="dk">Address</span><span className="dv">{me?.street1}</span></div>
          <div className="dr"><span className="dk">City</span><span className="dv">{me?.city}, {me?.state}</span></div>
          <div className="dr"><span className="dk">Unit</span><span className="dv mono">{me?.unitNumber}</span></div>
          <div className="dr"><span className="dk">Rent</span><span className="dv mono">{me?.rentAmount ? formatCurrency(me.rentAmount) : '—'}/mo</span></div>
          <div className="dr"><span className="dk">ACH</span><span className={`badge ${me?.achVerified?'b-green':'b-amber'}`}>{me?.achVerified?'Verified':'Pending'}</span></div>
        </a>
        {/* S512 launch: "Your Subscriptions" is the Flex Suite card — hidden
            with the rest of the suite. */}
        {!LAUNCH_HIDDEN.has('/services') && (
        <a href="/services" style={{textDecoration:'none'}} className="card"
          onMouseEnter={e=>(e.currentTarget as any).style.borderColor='var(--gold)'}
          onMouseLeave={e=>(e.currentTarget as any).style.borderColor=''}>
          <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:16}}>
            <h3>Your Subscriptions</h3>
            <span style={{fontSize:'.72rem',color:'var(--t3)'}}>Manage →</span>
          </div>
          <div className="dr"><span className="dk">Credit Reporting</span><span className={`badge ${me?.creditReportingEnrolled?'b-green':'b-muted'}`}>{me?.creditReportingEnrolled?'Active — $5/mo':'Not enrolled'}</span></div>
          <div className="dr"><span className="dk">FlexDeposit</span><span className={`badge ${me?.flexDepositEnrolled?'b-green':'b-muted'}`}>{me?.flexDepositEnrolled?'Active — $3/mo':'Not enrolled'}</span></div>
          <div style={{marginTop:16}}>
            <span className="btn btn-g btn-sm">Manage services →</span>
          </div>
        </a>
        )}
      </div>

      {/* ── Community Bulletin Board ─────────────────────────── */}
      <div style={{marginTop:24,background:'var(--bg2)',border:'1px solid var(--b1)',borderRadius:12,overflow:'hidden'}}>

        {/* Header */}
        <div style={{padding:'16px 20px',borderBottom:'1px solid var(--b0)',display:'flex',alignItems:'center',justifyContent:'space-between',flexWrap:'wrap',gap:12}}>
          <div>
            <div style={{fontFamily:'var(--font-d)',fontSize:'1rem',fontWeight:800,color:'var(--t0)'}}>📢 Community Bulletin</div>
            <div style={{fontSize:'.72rem',color:'var(--t3)',marginTop:2}}>Anonymous · your identity is never revealed</div>
          </div>
          <div style={{display:'flex',gap:6,flexWrap:'wrap'}}>
            {(['property','city','state'] as const).map(s => (
              <button key={s} onClick={()=>setBulletinScope(s)}
                style={{padding:'5px 12px',borderRadius:20,border:`1px solid ${bulletinScope===s?'var(--gold)':'var(--b1)'}`,background:bulletinScope===s?'rgba(201,162,39,.1)':'var(--bg3)',color:bulletinScope===s?'var(--gold)':'var(--t3)',cursor:'pointer',fontSize:'.72rem',fontWeight:600}}>
                {s==='property'?'🏘 Property':s==='city'?'🏙 City':'🗺 State'}
              </button>
            ))}
          </div>
        </div>

        {/* Controls: search + sort */}
        <div style={{padding:'10px 20px',borderBottom:'1px solid var(--b0)',background:'var(--bg3)',display:'flex',gap:10,alignItems:'center',flexWrap:'wrap'}}>
          <input
            value={bulletinSearch}
            onChange={e=>setBulletinSearch(e.target.value)}
            placeholder="Search posts…"
            style={{flex:1,minWidth:160,background:'var(--bg4)',border:'1px solid var(--b1)',borderRadius:8,color:'var(--t0)',padding:'6px 10px',fontSize:'.78rem',fontFamily:'inherit'}}
          />
          <div style={{display:'flex',gap:6,alignItems:'center'}}>
            {bulletinRefreshing && <span className="spinner" style={{width:12,height:12,borderWidth:1.5,flexShrink:0}}/>}
            {(['new','old'] as const).map(s => (
              <button key={s} onClick={()=>setBulletinSort(s)}
                style={{padding:'5px 10px',borderRadius:6,border:`1px solid ${bulletinSort===s?'var(--gold)':'var(--b1)'}`,background:bulletinSort===s?'rgba(201,162,39,.1)':'var(--bg4)',color:bulletinSort===s?'var(--gold)':'var(--t3)',cursor:'pointer',fontSize:'.72rem',fontWeight:600}}>
                {s==='new'?'Newest':'Oldest'}
              </button>
            ))}
          </div>
        </div>

        {/* Composer */}
        <div style={{padding:'12px 20px',borderBottom:'1px solid var(--b0)'}}>
          <div style={{display:'flex',gap:10,alignItems:'flex-end'}}>
            <div style={{flex:1}}>
              <textarea
                value={bulletinDraft}
                onChange={e=>setBulletinDraft(e.target.value.slice(0,500))}
                placeholder="Share anonymously with your community…"
                rows={2}
                style={{width:'100%',background:'var(--bg3)',border:'1px solid var(--b1)',borderRadius:8,color:'var(--t0)',padding:'8px 12px',fontSize:'.82rem',resize:'none',fontFamily:'inherit',boxSizing:'border-box'}}
              />
              <div style={{fontSize:'.65rem',color:'var(--t3)',textAlign:'right',marginTop:2}}>{bulletinDraft.length}/500</div>
            </div>
            <button className="btn btn-p btn-sm"
              disabled={bulletinDraft.trim().length < 3 || bulletinPosting}
              onClick={async()=>{
                setBulletinPosting(true)
                try {
                  const r = await post('/bulletin',{scope:bulletinScope,content:bulletinDraft.trim()})
                  if((r as any).success){
                    setBulletinDraft('')
                    setBulletinPosts((prev:any[])=>[{...(r as any).data,isNew:true},...prev])
                  }
                } catch(e){} finally{setBulletinPosting(false)}
              }}
              style={{marginBottom:20,whiteSpace:'nowrap'}}
            >
              {bulletinPosting?<span className="spinner"/>:'Post'}
            </button>
          </div>
          <div style={{fontSize:'.65rem',color:'var(--t3)'}}>⓪ Each post gets a random name. You look different every time you post.</div>
        </div>

        {/* Feed */}
        <div style={{maxHeight:520,overflowY:'auto'}}>
          {bulletinLoading ? (
            <div style={{padding:32,textAlign:'center',color:'var(--t3)',fontSize:'.82rem'}}>Loading…</div>
          ) : bulletinPosts.length===0 ? (
            <div style={{padding:32,textAlign:'center',color:'var(--t3)',fontSize:'.82rem'}}>No posts yet. Be the first to share something.</div>
          ) : (() => {
            const grouped: Record<string,any[]> = {}
            const pinned = bulletinPosts.filter((p:any)=>p.pinned)
            const regular = bulletinPosts.filter((p:any)=>!p.pinned)

            // Group by day — API already sorted correctly
            regular.forEach((p:any)=>{
              const day = new Date(p.createdAt).toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric',year:'numeric'})
              if(!grouped[day]) grouped[day]=[]
              grouped[day].push(p)
            })

            const renderPost = (p:any) => (
              <div key={p.id} style={{padding:'12px 20px',borderBottom:'1px solid var(--b0)',display:'flex',gap:12,alignItems:'flex-start',background:p.isNew?'rgba(201,162,39,.04)':p.pinned?'rgba(201,162,39,.02)':''}}>
                {/* Avatar */}
                <div style={{width:34,height:34,borderRadius:'50%',background:'var(--bg4)',border:'1px solid var(--b1)',display:'flex',alignItems:'center',justifyContent:'center',fontSize:'.65rem',fontWeight:800,color:'var(--t3)',flexShrink:0}}>
                  {p.alias?.slice(0,2).toUpperCase()}
                </div>
                {/* Content */}
                <div style={{flex:1,minWidth:0}}>
                  <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:4,flexWrap:'wrap'}}>
                    <span style={{fontSize:'.75rem',fontWeight:700,color:'var(--t2)'}}>{p.alias}</span>
                    {p.pinned&&<span style={{fontSize:'.6rem',background:'rgba(201,162,39,.12)',color:'var(--gold)',border:'1px solid rgba(201,162,39,.3)',borderRadius:4,padding:'1px 6px',fontWeight:700}}>📌 PINNED</span>}
                    <span style={{fontSize:'.65rem',color:'var(--t3)'}}>{new Date(p.createdAt).toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit'})}</span>
                    {p.isPast&&<span style={{fontSize:'.6rem',color:'var(--t3)',background:'var(--bg4)',borderRadius:4,padding:'1px 6px'}}>archived</span>}
                  </div>
                  <div style={{fontSize:'.82rem',color:'var(--t1)',lineHeight:1.6,wordBreak:'break-word'}}>{p.content}</div>
                </div>
                {/* Vote buttons */}
                <div style={{display:'flex',flexDirection:'column',alignItems:'center',gap:6,flexShrink:0}}>
                  <button
                    disabled={!p.canVote||p.myVote==='up'}
                    onClick={async()=>{
                      if(!p.canVote||p.myVote) return
                      try {
                        const r = await post(`/bulletin/${p.id}/vote`,{voteType:'up'})
                        if((r as any).success) setBulletinPosts((prev:any[])=>prev.map((x:any)=>x.id===p.id?{...x,...(r as any).data,my_vote:'up',can_vote:false,can_flag:false}:x))
                      } catch(e){}
                    }}
                    title="Upvote — boost this post"
                    style={{background:'none',border:'none',cursor:p.canVote&&p.myVote!=='up'?'pointer':'default',color:p.myVote==='up'?'var(--green)':'var(--t3)',fontSize:'.85rem',padding:'2px 4px',lineHeight:1,opacity:p.isPast?0.4:1}}
                  >▲</button>
                  <span style={{fontSize:'.65rem',color:'var(--t3)',fontFamily:'var(--font-m)',minWidth:16,textAlign:'center'}}>{p.upvoteCount||0}</span>
                  <button
                    disabled={!p.canFlag||p.myVote==='flag'}
                    onClick={async()=>{
                      if(!p.canFlag||p.myVote) return
                      try {
                        const r = await post(`/bulletin/${p.id}/vote`,{voteType:'flag'})
                        if((r as any).success) setBulletinPosts((prev:any[])=>prev.map((x:any)=>x.id===p.id?{...x,...(r as any).data,my_vote:'flag',can_vote:false,can_flag:false}:x))
                      } catch(e){}
                    }}
                    title="Flag — report inappropriate content"
                    style={{background:'none',border:'none',cursor:p.canFlag&&p.myVote!=='flag'?'pointer':'default',color:p.myVote==='flag'?'var(--amber)':'var(--t3)',fontSize:'.78rem',padding:'2px 4px',lineHeight:1,opacity:p.isPast?0.4:1}}
                  >🚩</button>
                  <span style={{fontSize:'.65rem',color:'var(--t3)',fontFamily:'var(--font-m)',minWidth:16,textAlign:'center'}}>{p.flagCount||0}</span>
                </div>
              </div>
            )

            return (
              <>
                {/* Pinned posts */}
                {pinned.length>0&&(
                  <>
                    <div style={{padding:'6px 20px',background:'rgba(201,162,39,.06)',borderBottom:'1px solid rgba(201,162,39,.15)',fontSize:'.65rem',fontWeight:700,color:'var(--gold)',textTransform:'uppercase',letterSpacing:'.08em'}}>📌 Pinned</div>
                    {[...pinned].sort((a:any,b:any)=>b.totalVotes-a.totalVotes).map(renderPost)}
                  </>
                )}
                {/* Day-grouped posts */}
                {Object.entries(grouped).map(([day,dayPosts])=>(
                  <React.Fragment key={day}>
                    <div style={{padding:'6px 20px',background:'var(--bg3)',borderBottom:'1px solid var(--b0)',borderTop:'1px solid var(--b0)',fontSize:'.65rem',fontWeight:700,color:'var(--t3)',textTransform:'uppercase',letterSpacing:'.08em',position:'sticky',top:0,zIndex:1}}>{day}</div>
                    {(dayPosts as any[]).map(renderPost)}
                  </React.Fragment>
                ))}
              </>
            )
          })()}
        </div>
      </div>
    </div>
  )
}

// S162: surface a banner on the dashboard + Payments page when the
// landlord hasn't completed Stripe Connect onboarding. Online rent
// payment would fail at Stripe; better to tell the tenant up front
// than to bounce them at submit. Boolean-only response from the API.
function LandlordBankingBanner() {
  const { data } = useQuery<{ ready: boolean }>(
    'landlord-banking-status',
    () => get<{ ready: boolean }>('/tenants/me/landlord-banking-status'),
  )
  const [nudgeStatus, setNudgeStatus] = useState<'idle' | 'sending' | 'sent' | 'too_soon' | 'error'>('idle')
  const [nudgeMsg, setNudgeMsg] = useState<string | null>(null)

  if (!data || data.ready) return null

  const sendNudge = async () => {
    setNudgeStatus('sending')
    setNudgeMsg(null)
    try {
      await api.post('/tenants/me/nudge-landlord-banking')
      setNudgeStatus('sent')
    } catch (e: any) {
      const status = e?.response?.status
      const msg = e?.response?.data?.error?.message ?? 'Send failed.'
      if (status === 429) { setNudgeStatus('too_soon'); setNudgeMsg(msg) }
      else { setNudgeStatus('error'); setNudgeMsg(msg) }
    }
  }

  return (
    <div style={{
      background: 'rgba(220,165,40,.08)',
      border: '1px solid rgba(220,165,40,.3)',
      borderRadius: 10,
      padding: '12px 16px',
      marginBottom: 16,
      fontSize: '.82rem',
      color: 'var(--t1)',
    }}>
      <div style={{ fontWeight: 600, color: 'var(--gold)', marginBottom: 4 }}>
        Online rent payment temporarily unavailable
      </div>
      <div style={{ fontSize: '.78rem', color: 'var(--t2)', lineHeight: 1.5, marginBottom: 10 }}>
        Your landlord hasn&apos;t finished setting up online banking with GAM yet.
        Reach out and ask them to complete the Stripe banking setup so you can
        start paying rent through GAM. You can still see your lease and
        balance — just no online payment until they finish.
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <button className="btn btn-primary"
                style={{ fontSize: '.74rem', padding: '4px 12px' }}
                disabled={nudgeStatus === 'sending' || nudgeStatus === 'sent' || nudgeStatus === 'too_soon'}
                onClick={sendNudge}>
          {nudgeStatus === 'sending' ? 'Sending…'
            : nudgeStatus === 'sent' ? '✓ Notified your landlord'
            : nudgeStatus === 'too_soon' ? '✓ Already sent'
            : 'Notify my landlord'}
        </button>
        {nudgeMsg && nudgeStatus !== 'sent' && (
          <span style={{ fontSize: '.72rem', color: 'var(--t3)' }}>{nudgeMsg}</span>
        )}
      </div>
    </div>
  )
}

// PaymentsPage moved to ./pages/PaymentsPage.tsx in S169 — now hosts the
// real Pay Now flow + Stripe Financial Connections bank add via the
// /api/payments/:id/pay destination charge backend.
import { PaymentsPage as PaymentsPageImpl } from './pages/PaymentsPage'
function PaymentsPage() {
  return <PaymentsPageImpl Banner={LandlordBankingBanner} />
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


// ── TERMS VIEWER MODAL (S314) ─────────────────────────────────────────────
// Shared full-text viewer used by FlexPay + FlexDeposit enrollment to
// surface the server-rendered, populated Subscription Terms / Service
// Agreement on demand. The text shown here is the same text the
// server stores in flexsuite_enrollment_acceptances on acceptance.

// ── FLEXSUITE RE-ACCEPTANCE GATE (S323) ───────────────────────────────────
// Fires on tenant-portal mount when any enrolled FlexSuite product has a
// pending template-version update. Modal informs the tenant and offers
// "Accept new terms" / "Review later". Not blocking — old acceptance
// stays valid against old enrollment if tenant defers. Re-prompts at
// next mount until accepted.

type PendingReAccept = {
  product:               'flexpay' | 'flexdeposit'
  currentVersion:        string
  latestVersion:         string
  flexpayPullDay?:       number
  flexpayMonthlyFee?:    number
  flexdepositInstallmentCount?: number
}

function FlexsuiteReAcceptanceGate() {
  const qc = useQueryClient()
  const { data } = useQuery<{ pending: PendingReAccept[] }>(
    'flexsuite-re-acceptance-status',
    () => fetch((import.meta as any).env?.VITE_API_URL + '/api/tenants/flexsuite/re-acceptance-status', {
      headers: { Authorization: 'Bearer ' + localStorage.getItem('gam_tenant_token') },
    }).then(r => r.json()).then(r => r.data),
    { staleTime: 60000 },
  )
  const [dismissed, setDismissed] = useState<Record<string, true>>({})
  const queue = (data?.pending ?? []).filter(p => !dismissed[p.product])
  const current = queue[0] ?? null

  const [tosAck, setTosAck] = useState(false)
  const [showFull, setShowFull] = useState(false)
  const [fullText, setFullText] = useState<string | null>(null)
  const [loadingFull, setLoadingFull] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    setTosAck(false); setShowFull(false); setFullText(null); setError('')
  }, [current?.product])

  async function openFullTerms() {
    if (!current) return
    setLoadingFull(true)
    try {
      const r = await fetch(
        (import.meta as any).env?.VITE_API_URL +
          `/api/tenants/flexsuite/re-acceptance-preview?product=${current.product}`,
        { headers: { Authorization: 'Bearer ' + localStorage.getItem('gam_tenant_token') } },
      ).then(x => x.json())
      if (r?.success) { setFullText(r.data.renderedText); setShowFull(true) }
      else setError(r?.error || 'Failed to load updated terms')
    } catch { setError('Failed to load updated terms') }
    finally { setLoadingFull(false) }
  }

  const mut = useMutation(
    () => fetch((import.meta as any).env?.VITE_API_URL + '/api/tenants/flexsuite/re-accept', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + localStorage.getItem('gam_tenant_token') },
      body: JSON.stringify({ product: current?.product, acceptedTerms: tosAck }),
    }).then(r => r.json()),
    {
      onSuccess: (r: any) => {
        if (!r?.success) { setError(r?.error || 'Failed to accept'); return }
        qc.invalidateQueries('flexsuite-re-acceptance-status')
        setDismissed(s => ({ ...s, [current!.product]: true }))
      },
      onError: () => setError('Failed to accept. Try again.'),
    },
  )

  if (!current) return null
  const label = current.product === 'flexpay' ? 'FlexPay Subscription Terms' : 'FlexDeposit Custody Agreement'
  const productNoun = current.product === 'flexpay' ? 'FlexPay' : 'FlexDeposit'

  return (
    <div className="modal-ov" onClick={() => setDismissed(s => ({ ...s, [current.product]: true }))}>
      <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 560 }}>
        <div className="modal-t">📄 Updated {label}</div>
        <p style={{ fontSize: '.82rem', color: 'var(--t2)', marginBottom: 14 }}>
          GAM has updated the {label} you accepted at {productNoun} enrollment.
          Please review the updated version and accept to keep your records current.
          Your existing acceptance (v{current.currentVersion}) stays valid against your
          current enrollment if you decline — but accepting the latest version (v{current.latestVersion})
          puts the most current terms on file.
        </p>

        <div style={{ background: 'var(--bg3)', border: '1px solid var(--b1)', borderRadius: 8, padding: 12, marginBottom: 12, fontSize: '.72rem', color: 'var(--t2)' }}>
          <div><strong style={{ color: 'var(--t1)' }}>Your current acceptance:</strong> v{current.currentVersion}</div>
          <div style={{ marginTop: 4 }}><strong style={{ color: 'var(--t1)' }}>Latest version:</strong> v{current.latestVersion}</div>
          <div style={{ marginTop: 8 }}>
            <button
              type="button"
              onClick={openFullTerms}
              disabled={loadingFull}
              style={{
                background: 'transparent', border: 'none', padding: 0,
                color: 'var(--gold)', textDecoration: 'underline', cursor: 'pointer',
                fontSize: '.72rem', fontWeight: 600,
              }}>
              {loadingFull ? 'Loading…' : 'Read the updated terms →'}
            </button>
          </div>
        </div>

        {error && <div className="alert a-warn" style={{ marginBottom: 12 }}>{error}</div>}

        <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginTop: 12, marginBottom: 14, cursor: 'pointer' }}>
          <input type="checkbox" checked={tosAck} onChange={e => setTosAck(e.target.checked)} style={{ marginTop: 2 }} />
          <span style={{ color: 'var(--t1)', fontWeight: 600, fontSize: '.78rem' }}>
            I have read and accept the updated {label}.
          </span>
        </label>

        <div className="modal-f">
          <button className="btn btn-g" onClick={() => setDismissed(s => ({ ...s, [current.product]: true }))}>
            Review later
          </button>
          <button className="btn btn-p" disabled={!tosAck || mut.isLoading} onClick={() => mut.mutate()}>
            {mut.isLoading ? <span className="spinner"/> : 'Accept new terms'}
          </button>
        </div>

        {showFull && fullText && (
          <TermsViewerModal title={`Updated ${label} (v${current.latestVersion})`} body={fullText} onClose={() => setShowFull(false)} />
        )}
      </div>
    </div>
  )
}

function TermsViewerModal({ title, body, onClose }: { title: string; body: string; onClose: () => void }) {
  return (
    <div className="modal-ov" onClick={onClose}>
      <div className="modal" onClick={e=>e.stopPropagation()} style={{maxWidth:760,maxHeight:'85vh',display:'flex',flexDirection:'column'}}>
        <div className="modal-t">{title}</div>
        <div style={{
          flex:1,overflowY:'auto',background:'var(--bg3)',border:'1px solid var(--b1)',
          borderRadius:8,padding:18,marginBottom:14,
          fontFamily:'var(--font-m)',fontSize:'.74rem',lineHeight:1.55,color:'var(--t1)',
          whiteSpace:'pre-wrap',
        }}>{body}</div>
        <div className="modal-f">
          <button className="btn btn-p" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  )
}

// ── FLEXPAY ENROLL MODAL (S245, terms capture S314) ───────────────────────
// FlexPay is a payment-scheduling subscription. Tenant picks a pull day
// (1-28); fee is $5 + day-of-month ($6 to $33). Day 28 cap covers all
// U.S. social security payout windows (SSDI 4th-Wed-of-month). S314:
// click-accept of the Subscription Terms is required + persisted.

function FlexPayModal({ onClose, onSuccess }: { onClose: () => void; onSuccess: () => void }) {
  const [pullDay, setPullDay] = useState(15)
  const [tosAck, setTosAck] = useState(false)
  const [showFullTerms, setShowFullTerms] = useState(false)
  const [fullTermsText, setFullTermsText] = useState<string | null>(null)
  const [loadingTerms, setLoadingTerms] = useState(false)
  const [error, setError] = useState('')
  const fee = 5 + pullDay

  async function openFullTerms() {
    setLoadingTerms(true)
    try {
      const r = await fetch(
        (import.meta as any).env?.VITE_API_URL + `/api/tenants/flexpay/terms?pullDay=${pullDay}`,
        { headers: { Authorization: 'Bearer ' + localStorage.getItem('gam_tenant_token') } },
      ).then(x => x.json())
      if (r?.success) {
        setFullTermsText(r.data.renderedText)
        setShowFullTerms(true)
      } else {
        setError(r?.error || 'Failed to load full terms')
      }
    } catch {
      setError('Failed to load full terms')
    } finally {
      setLoadingTerms(false)
    }
  }

  const mut = useMutation(
    () => fetch((import.meta as any).env?.VITE_API_URL + '/api/tenants/flexpay/enroll', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + localStorage.getItem('gam_tenant_token') },
      body: JSON.stringify({ pullDay, acceptedTerms: tosAck }),
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
        <p style={{fontSize:'.82rem',color:'var(--t2)',marginBottom:20}}>
          Pick the day of the month your rent gets pulled from your bank. Your fee is $5 plus the day number — pull on the 1st = $6, pull on the 11th = $16, pull on the 28th = $33.
        </p>

        <div className="fg">
          <label className="fl">Pull day of month</label>
          <div style={{display:'flex',alignItems:'center',gap:12}}>
            <input type="range" min={1} max={28} value={pullDay} onChange={e=>setPullDay(parseInt(e.target.value))}
              style={{flex:1,accentColor:'var(--gold)'}} />
            <span style={{fontFamily:'var(--font-m)',fontSize:'1.2rem',fontWeight:800,color:'var(--t0)',minWidth:32,textAlign:'center'}}>{pullDay}</span>
          </div>
          <div style={{fontSize:'.72rem',color:'var(--t3)',marginTop:4}}>Rent will be pulled on day {pullDay} of every month.</div>
        </div>

        <div style={{background:'var(--bg3)',borderRadius:10,padding:16,marginBottom:16,marginTop:16}}>
          <div style={{display:'flex',justifyContent:'space-between',alignItems:'center'}}>
            <span style={{fontWeight:700,color:'var(--t0)',fontSize:'.875rem'}}>Monthly FlexPay fee</span>
            <span style={{fontFamily:'var(--font-m)',fontSize:'1.4rem',fontWeight:800,color:'var(--gold)'}}>${fee}</span>
          </div>
          <div style={{fontSize:'.7rem',color:'var(--t3)',marginTop:6}}>$5 base + ${pullDay} (day number)</div>
        </div>

        {error && <div className="alert a-warn" style={{marginBottom:12}}>{error}</div>}

        {/* S314: FlexPay Subscription Terms — summary + full-text link + checkbox */}
        <div style={{background:'var(--bg3)',border:'1px solid var(--b1)',borderRadius:8,padding:14,marginBottom:14,fontSize:'.72rem',color:'var(--t2)',lineHeight:1.5}}>
          <div style={{fontWeight:700,color:'var(--t0)',marginBottom:8,fontSize:'.78rem'}}>FlexPay Subscription Terms — please review</div>
          <p style={{marginBottom:8}}>
            <strong style={{color:'var(--t1)'}}>Subscription, not a loan.</strong> FlexPay is a payment-date coordination subscription. GAM does not advance funds on your behalf. You authorize a recurring ACH pull from your verified bank account on the pull day you choose; your monthly fee is the date-based amount shown above.
          </p>
          <p style={{marginBottom:8}}>
            <strong style={{color:'var(--t1)'}}>Failed pulls retry + re-price.</strong> ACH is all-or-nothing (banks reject the whole pull on insufficient funds). If your scheduled pull fails, GAM retries on a later day. The retry recalculates your monthly fee under the same formula at the retry day. Stripe's actual ACH-return fee is passed through to you at cost, with no GAM markup.
          </p>
          <p style={{marginBottom:0}}>
            <strong style={{color:'var(--t1)'}}>Doesn't change your lease.</strong> FlexPay schedules when your ACH pull runs; it does not change the rent amount you owe or any landlord remedy (late fees, default notices) under your lease. A later pull day does not waive late-fee accrual against your rent due date.
          </p>
          <div style={{marginTop:10}}>
            <button
              type="button"
              onClick={openFullTerms}
              disabled={loadingTerms}
              style={{
                background:'transparent',border:'none',padding:0,
                color:'var(--gold)',textDecoration:'underline',cursor:'pointer',
                fontSize:'.72rem',fontWeight:600,
              }}>
              {loadingTerms ? 'Loading full terms…' : 'Read full FlexPay Subscription Terms →'}
            </button>
          </div>
          <label style={{display:'flex',alignItems:'flex-start',gap:8,marginTop:12,cursor:'pointer'}}>
            <input
              type="checkbox"
              checked={tosAck}
              onChange={e => setTosAck(e.target.checked)}
              style={{marginTop:2}}
            />
            <span style={{color:'var(--t1)',fontWeight:600}}>I have read and agree to the FlexPay Subscription Terms.</span>
          </label>
        </div>

        <div className="modal-f">
          <button className="btn btn-g" onClick={onClose}>Cancel</button>
          <button className="btn btn-p" disabled={mut.isLoading || !tosAck} onClick={()=>mut.mutate()}>
            {mut.isLoading ? <span className="spinner"/> : `Enroll — $${fee}/month`}
          </button>
        </div>
        {showFullTerms && fullTermsText && (
          <TermsViewerModal
            title="FlexPay Subscription Terms"
            body={fullTermsText}
            onClose={() => setShowFullTerms(false)}
          />
        )}
      </div>
    </div>
  )
}

// ── FLEXPAY CHANGE-PULL-DAY MODAL ─────────────────────────────────────────
// Enrolled tenants can move their pull day; the change takes effect NEXT
// cycle (the current cycle's pull is already scheduled). Fee recomputes to
// $5 + the new day for future cycles.
function FlexPayChangeDayModal({
  currentDay, onClose, onSuccess,
}: { currentDay: number; onClose: () => void; onSuccess: () => void }) {
  const [pullDay, setPullDay] = useState(currentDay || 15)
  const [error, setError] = useState('')
  const fee = 5 + pullDay

  const mut = useMutation(
    () => fetch((import.meta as any).env?.VITE_API_URL + '/api/tenants/flexpay/pull-day', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + localStorage.getItem('gam_tenant_token') },
      body: JSON.stringify({ pullDay }),
    }).then(r => r.json()),
    {
      onSuccess: (data) => {
        if (!data.success) { setError(data.error || 'Could not change your pull day'); return }
        onSuccess()
      },
      onError: () => setError('Could not change your pull day. Please try again.'),
    }
  )

  return (
    <div className="modal-ov" onClick={onClose}>
      <div className="modal" onClick={e=>e.stopPropagation()} style={{maxWidth:480}}>
        <div className="modal-t">⚡ Change FlexPay pull day</div>
        <p style={{fontSize:'.82rem',color:'var(--t2)',marginBottom:20}}>
          Pick a new day of the month. This takes effect <strong>next billing cycle</strong> — your current cycle's pull is already scheduled. Your fee is $5 plus the day number.
        </p>
        <div className="fg">
          <label className="fl">Pull day of month</label>
          <div style={{display:'flex',alignItems:'center',gap:12}}>
            <input type="range" min={1} max={28} value={pullDay} onChange={e=>setPullDay(parseInt(e.target.value))}
              style={{flex:1,accentColor:'var(--gold)'}} />
            <span style={{fontFamily:'var(--font-m)',fontSize:'1.2rem',fontWeight:800,color:'var(--t0)',minWidth:32,textAlign:'center'}}>{pullDay}</span>
          </div>
        </div>
        <div style={{background:'var(--bg3)',borderRadius:10,padding:16,margin:'16px 0'}}>
          <div style={{display:'flex',justifyContent:'space-between',alignItems:'center'}}>
            <span style={{fontWeight:700,color:'var(--t0)',fontSize:'.875rem'}}>New monthly fee (next cycle)</span>
            <span style={{fontFamily:'var(--font-m)',fontSize:'1.4rem',fontWeight:800,color:'var(--gold)'}}>${fee}</span>
          </div>
          <div style={{fontSize:'.7rem',color:'var(--t3)',marginTop:6}}>$5 base + ${pullDay} (day number)</div>
        </div>
        {error && <div className="alert a-red" style={{marginBottom:12}}>{error}</div>}
        <div style={{display:'flex',gap:8,justifyContent:'flex-end'}}>
          <button className="btn btn-g btn-sm" onClick={onClose}>Cancel</button>
          <button className="btn btn-p btn-sm" disabled={mut.isLoading || pullDay===currentDay} onClick={()=>{ setError(''); mut.mutate() }}>
            {mut.isLoading ? <span className="spinner"/> : 'Save (next cycle)'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── FLEXDEPOSIT ENROLL MODAL (S246) ───────────────────────────────────────
// Pre-move-in flow. Tenant picks 2..maxInstallments (max comes from
// the eligibility payload — deposit amount × BG risk_level). The
// move-in invoice generator reads security_deposits.flexDepositEnabled
// after enrollment and excludes the deposit line from the landlord-
// facing invoice. GAM fronts the gap on move-in via Connect Transfer.

function FlexDepositModal({
  eligibility, onClose, onSuccess,
}: { eligibility: any; onClose: () => void; onSuccess: () => void }) {
  const [count, setCount] = useState<number>(eligibility?.maxInstallments ?? 2)
  const [tosAck, setTosAck] = useState(false)
  const [showFullTerms, setShowFullTerms] = useState(false)
  const [fullTermsText, setFullTermsText] = useState<string | null>(null)
  const [loadingTerms, setLoadingTerms] = useState(false)
  const [error, setError] = useState('')

  const deposit = Number(eligibility?.depositAmount ?? 0)
  const max = eligibility?.maxInstallments ?? null
  const eligible = !!eligibility?.eligible
  const installmentAmt = max ? Math.round((deposit / count) * 100) / 100 : 0

  async function openFullTerms() {
    setLoadingTerms(true)
    try {
      const r = await fetch(
        (import.meta as any).env?.VITE_API_URL + `/api/tenants/flexdeposit/terms?installmentCount=${count}`,
        { headers: { Authorization: 'Bearer ' + localStorage.getItem('gam_tenant_token') } },
      ).then(x => x.json())
      if (r?.success) {
        setFullTermsText(r.data.renderedText)
        setShowFullTerms(true)
      } else {
        setError(r?.error || 'Failed to load full agreement')
      }
    } catch {
      setError('Failed to load full agreement')
    } finally {
      setLoadingTerms(false)
    }
  }

  const mut = useMutation(
    () => fetch((import.meta as any).env?.VITE_API_URL + '/api/tenants/flexdeposit/enroll', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + localStorage.getItem('gam_tenant_token') },
      body: JSON.stringify({ installmentCount: count, acceptedTerms: tosAck }),
    }).then(r => r.json()),
    {
      onSuccess: (data) => {
        if (!data.success) { setError(data.error || 'Enrollment failed'); return }
        onSuccess()
      },
      onError: () => setError('Enrollment failed. Please try again.'),
    },
  )

  if (!eligible) {
    return (
      <div className="modal-ov" onClick={onClose}>
        <div className="modal" onClick={e => e.stopPropagation()} style={{maxWidth:480}}>
          <div className="modal-t">🏦 FlexDeposit</div>
          <div className="alert a-warn" style={{marginBottom:16}}>
            {eligibility?.blockers?.includes('no_bg_result')      && 'Your background check must complete before you can enroll in FlexDeposit.'}
            {eligibility?.blockers?.includes('bg_not_approved')   && 'Your background check must be approved before you can enroll in FlexDeposit.'}
            {eligibility?.blockers?.includes('risk_level_missing') && 'Your background check is missing a risk level. Contact GAM support.'}
            {eligibility?.blockers?.includes('ach_unverified')    && 'You must verify your bank account before enrolling in FlexDeposit.'}
            {eligibility?.blockers?.includes('no_deposit_row')    && 'No upcoming deposit found. FlexDeposit must be enrolled before move-in.'}
            {eligibility?.blockers?.includes('already_funded')    && 'Your deposit is already fully funded. FlexDeposit can only be enrolled before paying the deposit.'}
            {eligibility?.blockers?.includes('not_ssi_ssdi')      && 'FlexDeposit is currently available only to SSDI/SSI recipients with verified income.'}
            {eligibility?.blockers?.includes('insufficient_platform_tenure') && `FlexDeposit requires at least 30 days on the GAM platform. Check back closer to your move-in date.`}
            {eligibility?.blockers?.includes('insufficient_on_time_payment_history') && `FlexDeposit requires at least one on-time rent payment on a prior lease in the last 90 days.`}
          </div>
          <div className="modal-f"><button className="btn btn-g" onClick={onClose}>Close</button></div>
        </div>
      </div>
    )
  }

  return (
    <div className="modal-ov" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()} style={{maxWidth:560}}>
        <div className="modal-t">🏦 Enroll in FlexDeposit</div>
        <p style={{fontSize:'.82rem',color:'var(--t2)',marginBottom:16}}>
          Split your ${deposit.toFixed(2)} deposit into 2–{max} installments. Pay the first one at move-in; the rest pull automatically over the following months.
        </p>

        <div className="fg">
          <label className="fl">Number of installments</label>
          <div style={{display:'flex',gap:8,marginTop:8}}>
            {Array.from({length: (max ?? 2) - 1}, (_, i) => i + 2).map(n => (
              <button
                key={n}
                onClick={() => setCount(n)}
                style={{
                  flex:1, padding:'10px', borderRadius:8,
                  border: count === n ? '2px solid var(--gold)' : '1px solid var(--b1)',
                  background: count === n ? 'rgba(201,162,39,.08)' : 'var(--bg3)',
                  cursor:'pointer', fontWeight:600,
                  color: count === n ? 'var(--gold)' : 'var(--t2)',
                  fontSize:'.85rem',
                }}>
                {n} payments
              </button>
            ))}
          </div>
        </div>

        <div style={{background:'var(--bg3)',borderRadius:10,padding:16,marginBottom:16,marginTop:16}}>
          <div style={{display:'flex',justifyContent:'space-between',alignItems:'center'}}>
            <span style={{fontWeight:700,color:'var(--t0)',fontSize:'.875rem'}}>Each payment</span>
            <span style={{fontFamily:'var(--font-m)',fontSize:'1.4rem',fontWeight:800,color:'var(--gold)'}}>${installmentAmt.toFixed(2)}</span>
          </div>
          <div style={{fontSize:'.7rem',color:'var(--t3)',marginTop:6}}>
            ${deposit.toFixed(2)} ÷ {count} installments. First due at move-in.
          </div>
        </div>

        {error && <div className="alert a-warn" style={{marginBottom:12}}>{error}</div>}

        <div style={{fontSize:'.72rem',color:'var(--t3)',marginBottom:16}}>
          ⓘ A $3/month custody fee applies as long as your deposit is on the GAM platform.
        </div>

        {/* S260: FlexDeposit Terms summary. S314: full populated SLA link + persisted acceptance. */}
        <div style={{background:'var(--bg3)',border:'1px solid var(--b1)',borderRadius:8,padding:14,marginBottom:14,fontSize:'.72rem',color:'var(--t2)',lineHeight:1.5}}>
          <div style={{fontWeight:700,color:'var(--t0)',marginBottom:8,fontSize:'.78rem'}}>FlexDeposit Custody Agreement — please review</div>
          <p style={{marginBottom:8}}>
            <strong style={{color:'var(--t1)'}}>Custody, not a loan.</strong> GAM does not advance or lend you any money and does not float any part of your deposit. Your landlord's books reflect your deposit at move-in, but GAM holds the funds in custody as you pay them in — released to your landlord if you default on your lease, or returned to you at move-out (subject to your lease), limited to the amount you have actually funded. Your installments fund your own deposit, not loan repayment. GAM is not your creditor; no debt is created and GAM will not report to credit bureaus or pursue collections on this balance.
          </p>
          <p style={{marginBottom:8}}>
            <strong style={{color:'var(--t1)'}}>ACH pull priority.</strong> Installments are pulled from your bank account on a schedule set at enrollment. These pulls may occur before any rent payment scheduled to the same bank account in the same cycle. You authorize GAM to attempt installment pulls regardless of your rent obligations to your landlord.
          </p>
          <p style={{marginBottom:8}}>
            <strong style={{color:'var(--t1)'}}>If an installment is missed.</strong> Each installment has two pull attempts — a primary pull 5 days before your lease's rent due date and a retry 1 day before. If both attempts fail, that installment simply doesn't fund your deposit that month: <em>nothing is accelerated, no balance becomes due in full, and GAM has no recourse against you.</em> Your deposit stays under-funded by that amount until a later installment, the GAM-first routing of any payment you make, or a voluntary catch-up funds it. If you never finish funding, your move-out refund and your landlord's deductions are simply calculated against what you actually paid into custody.
          </p>
          <p style={{marginBottom:0}}>
            <strong style={{color:'var(--t1)'}}>Separate parties.</strong> GAM and your landlord are separate parties. Missed installments do not relieve your rent obligations under your lease. Insufficient funds caused by GAM's installment pull may result in failed rent payments, which are governed by your lease, not by this agreement.
          </p>
          <div style={{marginTop:10}}>
            <button
              type="button"
              onClick={openFullTerms}
              disabled={loadingTerms}
              style={{
                background:'transparent',border:'none',padding:0,
                color:'var(--gold)',textDecoration:'underline',cursor:'pointer',
                fontSize:'.72rem',fontWeight:600,
              }}>
              {loadingTerms ? 'Loading full agreement…' : 'Read full FlexDeposit Custody Agreement →'}
            </button>
          </div>
          <label style={{display:'flex',alignItems:'flex-start',gap:8,marginTop:12,cursor:'pointer'}}>
            <input
              type="checkbox"
              checked={tosAck}
              onChange={e => setTosAck(e.target.checked)}
              style={{marginTop:2}}
            />
            <span style={{color:'var(--t1)',fontWeight:600}}>I have read and agree to the FlexDeposit Custody Agreement.</span>
          </label>
        </div>

        <div className="modal-f">
          <button className="btn btn-g" onClick={onClose}>Cancel</button>
          <button className="btn btn-p" disabled={mut.isLoading || !tosAck} onClick={() => mut.mutate()}>
            {mut.isLoading ? <span className="spinner"/> : `Enroll — ${count} payments of $${installmentAmt.toFixed(2)}`}
          </button>
        </div>
        {showFullTerms && fullTermsText && (
          <TermsViewerModal
            title="FlexDeposit Custody Agreement"
            body={fullTermsText}
            onClose={() => setShowFullTerms(false)}
          />
        )}
      </div>
    </div>
  )
}

// ── FLEXCHARGE ACCOUNTS CARD (S254) ──────────────────────────
// Tenant-side view of their FlexCharge accounts (one per property
// they have a tab at). Lists balance + recent transactions per
// account; per-tx dispute button. Auto-hides when tenant has no
// accounts (most tenants).

function FlexChargeAccountsCard() {
  const qc = useQueryClient()
  const fc = useQuery<any>('tenant-flexcharge', () =>
    fetch((import.meta as any).env?.VITE_API_URL + '/api/tenants/flexcharge', {
      headers: { Authorization: 'Bearer ' + localStorage.getItem('gam_tenant_token') }
    }).then(r => r.json()).then(r => r.data)
  )
  const [disputeTx, setDisputeTx] = useState<{ id: string; amount: string; property: string } | null>(null)
  const visible = fc.data?.visible !== false
  const accounts = (fc.data?.accounts || []) as any[]
  if (!visible || accounts.length === 0) return null

  return (
    <div className="card" style={{ marginTop: 24 }}>
      <h3 style={{ marginBottom: 4 }}>💳 FlexCharge accounts</h3>
      <p style={{ fontSize: '.78rem', color: 'var(--t3)', marginBottom: 16 }}>
        Tabs you have at GAM-platform merchants. Charges accumulate over the month; the balance + 1.5% service fee auto-pulls from your bank on the 15th of the following month.
      </p>
      <div style={{ display: 'grid', gap: 10 }}>
        {accounts.map(a => (
          <div key={a.id} style={{ padding: 12, background: 'var(--bg3)', borderRadius: 8 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
              <div>
                <div style={{ fontWeight: 600, color: 'var(--t0)', fontSize: '.9rem' }}>{a.propertyName}</div>
                <div style={{ fontSize: '.7rem', color: 'var(--t3)' }}>Credit limit ${Number(a.creditLimit).toFixed(2)}</div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <div style={{ fontFamily: 'var(--font-m)', fontSize: '1.2rem', fontWeight: 800, color: 'var(--gold)' }}>${Number(a.balance).toFixed(2)}</div>
                <div style={{ fontSize: '.65rem', color: 'var(--t3)' }}>Current balance</div>
              </div>
            </div>
            <span className={`badge ${a.status === 'active' ? 'b-green' : a.status === 'suspended' ? 'b-amber' : 'b-red'}`}>
              {a.status}
            </span>
            {a.disqualifiedReason && (
              <div style={{ fontSize: '.7rem', color: 'var(--red)', marginTop: 4 }}>{a.disqualifiedReason}</div>
            )}
            {Array.isArray(a.transactions) && a.transactions.length > 0 && (
              <div style={{ marginTop: 10, borderTop: '1px solid var(--bd1)', paddingTop: 8 }}>
                <div style={{ fontSize: '.7rem', color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '.05em', marginBottom: 6 }}>
                  Recent charges
                </div>
                <div style={{ display: 'grid', gap: 4 }}>
                  {a.transactions.slice(0, 8).map((tx: any) => (
                    <div key={tx.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '.78rem' }}>
                      <div>
                        <span style={{ fontFamily: 'var(--font-m)' }}>${Number(tx.amount).toFixed(2)}</span>
                        <span style={{ color: 'var(--t3)', marginLeft: 8 }}>{new Date(tx.createdAt).toLocaleDateString()}</span>
                        {tx.status === 'disputed' && (
                          <span className="badge b-red" style={{ marginLeft: 8, fontSize: '.65rem' }}>disputed</span>
                        )}
                        {tx.status === 'billed' && (
                          <span className="badge b-amber" style={{ marginLeft: 8, fontSize: '.65rem' }}>on statement</span>
                        )}
                      </div>
                      {tx.status !== 'disputed' && a.status === 'active' && (
                        <button
                          onClick={() => setDisputeTx({ id: tx.id, amount: tx.amount, property: a.propertyName })}
                          style={{ background: 'none', border: 'none', color: 'var(--red)', fontSize: '.7rem', cursor: 'pointer', textDecoration: 'underline' }}
                        >
                          Dispute
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
      <div style={{ fontSize: '.7rem', color: 'var(--t3)', marginTop: 12 }}>
        ⓘ Disputing a charge permanently closes your tab at that merchant. Use this only for charges you didn't authorize or that the merchant won't resolve directly.
      </div>
      {disputeTx && (
        <FlexChargeDisputeModal
          tx={disputeTx}
          onClose={() => setDisputeTx(null)}
          onSuccess={() => { setDisputeTx(null); qc.invalidateQueries('tenant-flexcharge') }}
        />
      )}
    </div>
  )
}

function FlexChargeDisputeModal({ tx, onClose, onSuccess }: {
  tx: { id: string; amount: string; property: string }
  onClose: () => void
  onSuccess: () => void
}) {
  const [reason, setReason] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const submitMut = useMutation(
    () => post(`/tenants/flexcharge/dispute/${tx.id}`, { reason }),
    {
      onSuccess,
      onError: (e: any) => setErr(e?.response?.data?.error?.message || 'Dispute failed'),
    },
  )
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" style={{ maxWidth: 480 }} onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <span className="modal-title">Dispute charge</span>
          <button className="btn btn-ghost btn-sm" onClick={onClose}>x</button>
        </div>
        <div style={{ padding: '0 24px 24px' }}>
          <div style={{ background: 'var(--bg3)', padding: 12, borderRadius: 6, marginBottom: 12 }}>
            <div style={{ fontSize: '.78rem', color: 'var(--t2)' }}>{tx.property}</div>
            <div style={{ fontSize: '1.1rem', fontWeight: 700, fontFamily: 'var(--font-m)', color: 'var(--gold)' }}>
              ${Number(tx.amount).toFixed(2)}
            </div>
          </div>
          <div style={{ background: 'rgba(220,60,50,.08)', border: '1px solid rgba(220,60,50,.3)', padding: 12, borderRadius: 6, marginBottom: 12 }}>
            <div style={{ fontSize: '.78rem', color: 'var(--red)', fontWeight: 600, marginBottom: 4 }}>This permanently closes your FlexCharge tab at this merchant.</div>
            <div style={{ fontSize: '.72rem', color: 'var(--t2)' }}>
              You'll still owe any other unpaid charges on this account. The merchant will review your dispute and respond directly. GAM does not arbitrate the underlying charge.
            </div>
          </div>
          <div style={{ marginBottom: 12 }}>
            <div style={{ fontSize: '.72rem', color: 'var(--t3)', marginBottom: 4 }}>Reason for dispute</div>
            <textarea
              className="form-input"
              value={reason}
              onChange={e => setReason(e.target.value)}
              rows={4}
              style={{ width: '100%', resize: 'vertical' }}
              placeholder="Briefly describe why you're disputing this charge..."
              maxLength={500}
            />
            <div style={{ fontSize: '.65rem', color: 'var(--t3)', textAlign: 'right' }}>{reason.length}/500</div>
          </div>
          {err && <div style={{ color: 'var(--red)', fontSize: '.78rem', marginBottom: 8 }}>{err}</div>}
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
            <button
              className="btn"
              disabled={reason.trim().length < 3 || submitMut.isLoading}
              onClick={() => submitMut.mutate()}
              style={{ background: 'var(--red)', color: '#fff' }}
            >
              {submitMut.isLoading ? 'Submitting...' : 'Submit dispute'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ── SERVICES PAGE ─────────────────────────────────────────────
function ServicesPage() {
  const qc2 = useQuery('tenant-me', () => get<any>('/tenants/me'))
  const me = qc2.data
  const [flexPayModal, setFlexPayModal] = useState(false)
  const [flexPayChangeModal, setFlexPayChangeModal] = useState(false)
  const [flexDepositModal, setFlexDepositModal] = useState(false)
  const fd = useQuery('tenant-flexdeposit', () => get<any>('/tenants/flexdeposit'))

  // S310: OTP became landlord-only at S155; the tenant /enroll-on-time-pay
  // route returns 410 Gone. The tenant portal must not surface OTP
  // enrollment, status, or qualification copy per the FlexSuite/OTP
  // portal-separation principle (memory: project_flexsuite_otp_hidden.md
  // — "OTP inverse: landlord-only, never tenant"). The enrollment modal,
  // mutation, and qualification-status card were removed here.

  const creditMut = useMutation(() => post('/tenants/enroll-credit-reporting'), { onSuccess: () => qc2.refetch() })

  const services = [
    {
      id: 'credit',
      name: 'FlexCredit',
      desc: 'Report your on-time rent payments to all 3 bureaus — Experian, TransUnion & Equifax. Build credit just by paying rent.',
      price: '$5/month',
      enrolled: me?.creditReportingEnrolled,
      action: () => creditMut.mutate(),
      loading: creditMut.isLoading,
      highlight: '30% of tenants build 40+ credit score points in year 1',
    },

    {
      id: 'flexpay',
      name: 'FlexPay',
      desc: 'Pick the day of the month your rent gets pulled from your bank. Your landlord gets paid on the lease grace-period day no matter what; you pay later.',
      price: '$6–$33/month',
      enrolled: me?.flexpayEnrolled,
      action: () => setFlexPayModal(true),
      loading: false,
      highlight: me?.flexpayEnrolled
        ? `Day ${me.flexpayPullDay} · $${me.flexpayMonthlyFee}/mo`
        : !me?.achVerified ? '⚠ Bank account must be verified first'
        : 'Pick your pull date 1–28',
      locked: !me?.achVerified,
    },
    {
      id: 'flexdeposit',
      name: 'FlexDeposit',
      desc: 'Split your security deposit into 2–4 monthly installments. Pay the first one at move-in; the rest spread over the next months.',
      price: '$3/month custody fee',
      enrolled: me?.flexDepositEnrolled,
      action: () => setFlexDepositModal(true),
      loading: false,
      highlight: me?.flexDepositEnrolled
        ? `Installment plan active — see plan below`
        : !me?.achVerified ? '⚠ Bank account must be verified first'
        : 'Tap to choose your installment plan',
      locked: !me?.achVerified,
    },
  ]

  return (
    <div>
      <div className="ph">
        <div><h1 className="pt">Flex Advantage</h1><p className="ps">All services are voluntary. No mandatory fees.</p></div>
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
                ? <span style={{display:'flex',gap:8,alignItems:'center'}}>
                    <span className="badge b-green">✓ Active</span>
                    {s.id==='flexpay' && <button className="btn btn-g btn-sm" onClick={()=>setFlexPayChangeModal(true)}>Change day</button>}
                  </span>
                : (s as any).locked
                ? <span className="badge b-muted">🔒 Locked</span>
                : <button className="btn btn-p btn-sm" onClick={s.action} disabled={s.loading}>{s.loading?<span className="spinner"/>:'Enroll'}</button>}
            </div>
          </div>
        ))}
      </div>


      {/* ── ACH Verification ─────────────────────────────────────── */}
      {!me?.achVerified && (
        <div className="card" style={{marginTop:24}}>
          <h3 style={{marginBottom:4}}>🏦 Bank Account Verification</h3>
          <p style={{fontSize:'.82rem',color:'var(--t3)',marginBottom:16}}>
            {me?.depositFullyFunded
              ? 'Verify your bank account to enable FlexPay / FlexDeposit.'
              : 'Your security deposit must be fully funded before you can verify your bank account.'}
          </p>
          {!me?.depositFullyFunded ? (
            <div className="alert a-warn">⚠ Complete your security deposit payment first.</div>
          ) : (
            <AchVerifyForm onSuccess={()=>qc2.refetch()} />
          )}
        </div>
      )}

      {/* S310: OTP Qualification Status card removed — OTP is a
          landlord-only product (S155) and the tenant portal must not
          surface it. The deposit-funding and ACH-verification steps
          shown here pulled double duty as OTP-qualification rungs;
          those are now handled in their own dedicated surfaces
          (FlexDeposit installment progress, the ACH verification
          card above when !ach_verified). */}

    {flexPayModal && (
        <FlexPayModal
          onClose={() => setFlexPayModal(false)}
          onSuccess={() => { qc2.refetch(); setFlexPayModal(false) }}
        />
      )}
      {flexPayChangeModal && (
        <FlexPayChangeDayModal
          currentDay={me?.flexpayPullDay ?? 15}
          onClose={() => setFlexPayChangeModal(false)}
          onSuccess={() => { qc2.refetch(); setFlexPayChangeModal(false) }}
        />
      )}
      {flexDepositModal && (
        <FlexDepositModal
          eligibility={fd.data?.eligibility}
          onClose={() => setFlexDepositModal(false)}
          onSuccess={() => { qc2.refetch(); fd.refetch(); setFlexDepositModal(false) }}
        />
      )}

      {/* ── FlexDeposit active plan view ─────────────────────────── */}
      {me?.flexDepositEnrolled && fd.data?.plan?.length > 0 && (
        <div className="card" style={{marginTop:24}}>
          <h3 style={{marginBottom:4}}>🏦 FlexDeposit installment plan</h3>
          <p style={{fontSize:'.78rem',color:'var(--t3)',marginBottom:16}}>
            Your deposit installment schedule. The first one was paid at move-in; the rest pull automatically on each due date.
          </p>
          <div style={{display:'grid',gap:8}}>
            {fd.data.plan.map((i: any) => (
              <div key={i.installmentNumber} style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'8px 12px',borderRadius:8,background:'var(--bg3)'}}>
                <div>
                  <div style={{fontWeight:600,color:'var(--t0)',fontSize:'.85rem'}}>Installment {i.installmentNumber} of {i.installmentCount}</div>
                  <div style={{fontSize:'.72rem',color:'var(--t3)'}}>Due {new Date(i.dueDate).toLocaleDateString()}</div>
                </div>
                <div style={{display:'flex',alignItems:'center',gap:10}}>
                  <span style={{fontFamily:'var(--font-m)',fontWeight:700,color:'var(--t0)'}}>${i.amount}</span>
                  <span className={`badge ${i.status==='settled'?'b-green':i.status==='defaulted'?'b-red':'b-muted'}`}>{i.status}</span>
                </div>
              </div>
            ))}
          </div>
          <div style={{fontSize:'.7rem',color:'var(--t3)',marginTop:12}}>
            ⓘ $3/month custody fee billed separately as long as your deposit is on the GAM platform.
          </div>
        </div>
      )}

      <FlexChargeAccountsCard />

      {/* ── Feature Request ───────────────────────────────────── */}
      <div className="card" style={{marginTop:24,background:'rgba(59,130,246,.04)',border:'1px solid rgba(59,130,246,.2)'}}>
        <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',flexWrap:'wrap',gap:12}}>
          <div>
            <div style={{fontWeight:700,color:'var(--t0)',marginBottom:4}}>💡 Have a feature idea?</div>
            <div style={{fontSize:'.78rem',color:'var(--t3)',lineHeight:1.5}}>Suggest a new service or improvement. Requests go directly to the GAM team.</div>
          </div>
          <a href={`${(import.meta as any).env?.VITE_ADMIN_APP_URL || 'http://localhost:3003'}/feature-requests`} target="_blank" rel="noreferrer"
            style={{display:'inline-flex',alignItems:'center',gap:7,padding:'8px 16px',borderRadius:8,background:'rgba(59,130,246,.12)',border:'1px solid rgba(59,130,246,.3)',color:'#93c5fd',fontWeight:600,fontSize:'.78rem',textDecoration:'none',whiteSpace:'nowrap'}}>
            Submit Request →
          </a>
        </div>
      </div>
    </div>
  )
}

// ── MAINTENANCE PAGE ──────────────────────────────────────────
function MaintenancePage() {
  const { data: me } = useQuery('tenant-me', () => get<any>('/tenants/me'))
  const { data: reqs = [], isLoading } = useQuery<any[]>('maint', () => get<any[]>('/maintenance'))
  const [showAdd, setShowAdd] = useState(false)
  const [selected, setSelected] = useState<any>(null)
  const { register, handleSubmit, reset } = useForm<any>()
  const qc2 = useQueryClient()
  const addMut = useMutation(
    (d:any) => post('/maintenance', { ...d, unitId: me?.unitId }),
    { onSuccess: () => { qc2.invalidateQueries('maint'); setShowAdd(false); reset() } }
  )
  const PRI: Record<string,string> = { emergency:'b-red',high:'b-amber',normal:'b-gold',low:'b-muted' }
  const ST: Record<string,string> = { open:'b-amber',assigned:'b-gold',in_progress:'b-gold',completed:'b-green',cancelled:'b-muted' }
  const ST_LABEL: Record<string,string> = { open:'Open',assigned:'Assigned',in_progress:'In Progress',completed:'Completed',cancelled:'Cancelled' }

  return (
    <div>
      <div className="ph">
        <div><h1 className="pt">Maintenance</h1><p className="ps">Submit and track repair requests</p></div>
        <button className="btn btn-p" onClick={()=>setShowAdd(true)}>+ New request</button>
      </div>
      <div className="card" style={{padding:0,overflowX:'auto'}}>
        {isLoading ? <div style={{padding:32,color:'var(--t3)',textAlign:'center'}}>Loading…</div> : (
          <table className="tbl" style={{minWidth:780}}>
            <thead><tr><th>Date</th><th>Title</th><th>Priority</th><th>Status</th><th>Assigned To</th><th></th></tr></thead>
            <tbody>
              {reqs.length ? reqs.map((r:any)=>(
                <tr key={r.id} onClick={()=>setSelected(r)} style={{cursor:'pointer'}}
                  onMouseEnter={e=>(e.currentTarget as any).style.background='var(--bg3)'}
                  onMouseLeave={e=>(e.currentTarget as any).style.background=''}>
                  <td className="mono" style={{fontSize:'.75rem'}}>{new Date(r.createdAt).toLocaleDateString()}</td>
                  <td style={{color:'var(--t0)',fontWeight:500}}>{r.title}</td>
                  <td><span className={`badge ${PRI[r.priority]}`}>{r.priority}</span></td>
                  <td><span className={`badge ${ST[r.status]}`}>{ST_LABEL[r.status]||r.status}</span></td>
                  <td style={{fontSize:'.82rem',color:r.contractorName?'var(--t1)':'var(--t3)'}}>{r.contractorName||'Unassigned'}</td>
                  <td style={{color:'var(--t3)',fontSize:'.75rem'}}>View →</td>
                </tr>
              )) : <tr><td colSpan={6} style={{textAlign:'center',color:'var(--t3)',padding:32}}>No maintenance requests yet.</td></tr>}
            </tbody>
          </table>
        )}
      </div>

      {selected && (
        <div className="modal-ov" onClick={()=>setSelected(null)}>
          <div className="modal" onClick={e=>e.stopPropagation()} style={{maxWidth:560}}>
            <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',marginBottom:16}}>
              <div>
                <div className="modal-t" style={{marginBottom:4}}>{selected.title}</div>
                <div style={{display:'flex',gap:8}}>
                  <span className={`badge ${PRI[selected.priority]}`}>{selected.priority}</span>
                  <span className={`badge ${ST[selected.status]}`}>{ST_LABEL[selected.status]||selected.status}</span>
                </div>
              </div>
              <button onClick={()=>setSelected(null)} style={{background:'none',border:'none',cursor:'pointer',color:'var(--t3)',fontSize:'1.2rem',lineHeight:1}}>×</button>
            </div>
            {selected.description && (
              <div style={{marginBottom:16}}>
                <div style={{fontSize:'.65rem',color:'var(--t3)',textTransform:'uppercase',letterSpacing:'.08em',fontWeight:600,marginBottom:6}}>Description</div>
                <div style={{fontSize:'.82rem',color:'var(--t1)',lineHeight:1.6,background:'var(--bg3)',padding:'10px 12px',borderRadius:8}}>{selected.description}</div>
              </div>
            )}
            <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:12,marginBottom:16}}>
              <div style={{background:'var(--bg3)',borderRadius:8,padding:'10px 12px'}}>
                <div style={{fontSize:'.62rem',color:'var(--t3)',textTransform:'uppercase',letterSpacing:'.08em',marginBottom:4}}>Assigned To</div>
                <div style={{fontSize:'.85rem',fontWeight:600,color:selected.contractorName?'var(--t0)':'var(--t3)'}}>{selected.contractorName||'Unassigned'}</div>
                {selected.contractorPhone && <div style={{fontSize:'.72rem',color:'var(--t3)',marginTop:2}}>📞 {selected.contractorPhone}</div>}
              </div>
              <div style={{background:'var(--bg3)',borderRadius:8,padding:'10px 12px'}}>
                <div style={{fontSize:'.62rem',color:'var(--t3)',textTransform:'uppercase',letterSpacing:'.08em',marginBottom:4}}>Submitted</div>
                <div style={{fontSize:'.82rem',color:'var(--t0)'}}>{new Date(selected.createdAt).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'})}</div>
                {selected.completedAt && <div style={{fontSize:'.72rem',color:'var(--green)',marginTop:2}}>✓ Completed {new Date(selected.completedAt).toLocaleDateString()}</div>}
              </div>
            </div>
            {selected.notes && (
              <div style={{marginBottom:16}}>
                <div style={{fontSize:'.65rem',color:'var(--t3)',textTransform:'uppercase',letterSpacing:'.08em',fontWeight:600,marginBottom:6}}>Contractor Notes</div>
                <div style={{fontSize:'.82rem',color:'var(--t1)',lineHeight:1.6,background:'var(--bg3)',padding:'10px 12px',borderRadius:8,borderLeft:'3px solid var(--gold)'}}>{selected.notes}</div>
              </div>
            )}
            {selected.proofUrls?.length > 0 && (
              <div style={{marginBottom:16}}>
                <div style={{fontSize:'.65rem',color:'var(--t3)',textTransform:'uppercase',letterSpacing:'.08em',fontWeight:600,marginBottom:8}}>Completion Photos</div>
                <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fill,minmax(120px,1fr))',gap:8}}>
                  {selected.proofUrls.map((url:string,i:number)=>(
                    <a key={i} href={url} target="_blank" rel="noreferrer">
                      <img src={url} alt={'proof-'+i} style={{width:'100%',height:90,objectFit:'cover',borderRadius:8,border:'1px solid var(--b1)'}} />
                    </a>
                  ))}
                </div>
              </div>
            )}
            <div className="modal-f">
              <button className="btn btn-g" onClick={()=>setSelected(null)}>Close</button>
            </div>
          </div>
        </div>
      )}

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
// ── INSPECTIONS ──────────────────────────────────────────────
function TenantInspectionsPage() {
  const navigate = useNavigate()
  const { data = [], isLoading } = useQuery<any[]>('tenant-inspections', () =>
    get<any[]>('/inspections'),
  )
  const list = data as any[]
  return (
    <div>
      <div className="ph">
        <div>
          <h1 className="pt">Inspections</h1>
          <p className="ps">Move-in / move-out walkthroughs</p>
        </div>
      </div>
      <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
        {isLoading ? (
          <div style={{ padding: 32, color: 'var(--t3)', textAlign: 'center' }}>Loading…</div>
        ) : list.length === 0 ? (
          <div style={{ padding: 32, color: 'var(--t3)', textAlign: 'center' }}>
            No inspections yet. You'll see them here when your landlord starts one.
          </div>
        ) : (
          <table className="tbl" style={{ minWidth: 640 }}>
            <thead>
              <tr><th>Type</th><th>Status</th><th>Created</th><th>Finalized</th><th></th></tr>
            </thead>
            <tbody>
              {list.map(r => (
                <tr key={r.id}>
                  <td style={{ color: 'var(--t0)' }}>{labelType(r.inspectionType)}</td>
                  <td><span className={`badge ${statusBadge(r.status)}`}>{r.status.replace('_', ' ')}</span></td>
                  <td className="mono" style={{ fontSize: '.75rem', color: 'var(--t3)' }}>{new Date(r.createdAt).toLocaleDateString()}</td>
                  <td className="mono" style={{ fontSize: '.75rem', color: 'var(--t3)' }}>{r.finalizedAt ? new Date(r.finalizedAt).toLocaleDateString() : '—'}</td>
                  <td><button className="btn btn-g btn-sm" onClick={() => navigate(`/inspections/${r.id}`)}>Open →</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}

function labelType(t: string) {
  return t === 'move_in' ? 'Move-in' : t === 'move_out' ? 'Move-out' : 'Periodic'
}
function statusBadge(s: string) {
  if (s === 'finalized') return 'b-green'
  if (s === 'tenant_signed' || s === 'landlord_signed') return 'b-amber'
  if (s === 'disputed') return 'b-red'
  return 'b-muted'
}

function TenantInspectionDetailPage() {
  const params = useParams()
  const id = params.id!
  const qc = useQueryClient()
  const { user } = useAuth()
  const navigate = useNavigate()
  const [error, setError] = useState<string | null>(null)
  const { data, isLoading } = useQuery<any>(
    ['tenant-inspection', id],
    () => get<any>(`/inspections/${id}`),
  )
  const signMut = useMutation(
    () => post(`/inspections/${id}/sign`),
    {
      onSuccess: () => qc.invalidateQueries(['tenant-inspection', id]),
      onError: (e: any) => setError(e?.response?.data?.error || 'Sign failed'),
    },
  )
  const [camera, setCamera] = useState<null | 'photo' | 'video'>(null)
  const [videoSaved, setVideoSaved] = useState(false)
  const photoMut = useMutation(
    ({ file, live }: { file: File; live?: boolean }) => {
      const fd = new FormData(); fd.append('file', file); if (live) fd.append('capturedLive', 'true')
      return api.post(`/inspections/${id}/photos`, fd, { headers: { 'Content-Type': 'multipart/form-data' } }).then(r => r.data)
    },
    { onSuccess: () => qc.invalidateQueries(['tenant-inspection', id]), onError: (e: any) => setError(e?.response?.data?.error || 'Upload failed') },
  )
  const videoMut = useMutation(
    ({ file, live }: { file: File; live?: boolean }) => {
      const fd = new FormData(); fd.append('file', file); if (live) fd.append('capturedLive', 'true')
      return api.post(`/inspections/${id}/videos`, fd, { headers: { 'Content-Type': 'multipart/form-data' } }).then(r => r.data)
    },
    { onSuccess: () => setVideoSaved(true), onError: (e: any) => setError(e?.response?.data?.error || 'Video upload failed') },
  )

  if (isLoading || !data) return <div style={{ padding: 32, color: 'var(--t3)' }}>Loading…</div>
  const insp = data as any
  const items = (insp.items || []) as any[]
  const photos = (insp.photos || []) as any[]
  const signatures = (insp.signatures || []) as any[]
  const tenantSigned = signatures.some(s => s.signerRole === 'tenant')
  const editable = insp.status !== 'finalized' && insp.status !== 'cancelled'

  return (
    <div>
      <div className="ph">
        <div>
          <button className="btn btn-g btn-sm" onClick={() => navigate('/inspections')} style={{ marginBottom: 8 }}>← Inspections</button>
          <h1 className="pt">{labelType(insp.inspectionType)} Inspection</h1>
          <p className="ps">
            <span className={`badge ${statusBadge(insp.status)}`}>{insp.status.replace('_', ' ')}</span>
          </p>
        </div>
      </div>

      {error && <div className="alert a-warn" style={{ background: 'rgba(239,68,68,.08)', color: 'var(--red)' }}>{error}</div>}

      <div className="card" style={{ padding: 0, marginBottom: 16, overflowX: 'auto' }}>
        <div style={{ padding: 14, borderBottom: '1px solid var(--b0)' }}>
          <strong style={{ color: 'var(--t0)' }}>Checklist ({items.length})</strong>
        </div>
        {items.length === 0 ? (
          <div style={{ padding: 24, color: 'var(--t3)', textAlign: 'center' }}>No items recorded yet.</div>
        ) : (
          <table className="tbl" style={{ minWidth: 600 }}>
            <thead><tr><th>Area</th><th>Item</th><th>Condition</th><th>Notes</th></tr></thead>
            <tbody>
              {items.map(it => (
                <tr key={it.id}>
                  <td>{it.area}</td>
                  <td style={{ color: 'var(--t0)' }}>{it.itemLabel}</td>
                  <td><span className={`badge ${
                    it.condition === 'good' ? 'b-green' :
                    it.condition === 'fair' ? 'b-amber' :
                    it.condition === 'damaged' || it.condition === 'missing' ? 'b-red' : 'b-muted'
                  }`}>{it.condition}</span></td>
                  <td style={{ fontSize: '.8rem', color: 'var(--t2)' }}>{it.notes || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {(editable || photos.length > 0) && (
        <div className="card" style={{ padding: 16, marginBottom: 16 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <strong style={{ color: 'var(--t0)' }}>Photos ({photos.length})</strong>
            {editable && (
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="btn btn-p btn-sm" onClick={() => setCamera('photo')} disabled={photoMut.isLoading}>📷 Take photo</button>
                <button className="btn btn-p btn-sm" onClick={() => setCamera('video')} disabled={videoMut.isLoading}>🎥 Record video</button>
              </div>
            )}
          </div>
          {videoSaved && (
            <div className="alert" style={{ background: 'rgba(34,197,94,.08)', color: 'var(--green)', marginBottom: 12, fontSize: '.82rem', padding: 10, borderRadius: 8 }}>
              Video saved. Review your walkthroughs anytime under <a href="/walkthroughs" style={{ color: 'var(--gold)' }}>My walkthroughs</a>.
            </div>
          )}
          {photos.length === 0 ? (
            <div style={{ color: 'var(--t3)', fontSize: '.85rem' }}>
              No photos yet.{editable ? ' Use “Take photo” to capture each area fresh from your camera.' : ''}
            </div>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))', gap: 8 }}>
              {photos.map(p => (
                <div key={p.id} style={{ position: 'relative' }}>
                  <div style={{ aspectRatio: '1/1', borderRadius: 8, overflow: 'hidden', background: 'var(--bg3)' }}>
                    <AuthedImg path={p.photoUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                  </div>
                  {p.capturedLive && <span className="badge b-green" style={{ position: 'absolute', top: 6, left: 6 }}>live</span>}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {insp.status !== 'finalized' && insp.status !== 'cancelled' && !tenantSigned && (
        <div className="card" style={{ padding: 16, background: 'rgba(201,162,39,.05)', border: '1px solid rgba(201,162,39,.25)' }}>
          <strong style={{ color: 'var(--gold)', display: 'block', marginBottom: 6 }}>Sign-off required</strong>
          <div style={{ fontSize: '.82rem', color: 'var(--t2)', marginBottom: 12 }}>
            By signing, you attest the checklist above accurately reflects the unit's
            condition. If anything looks wrong, contact your landlord before signing.
          </div>
          <button className="btn btn-p" onClick={() => signMut.mutate()} disabled={signMut.isLoading}>
            {signMut.isLoading ? 'Signing…' : '✍ Sign as tenant'}
          </button>
        </div>
      )}

      {tenantSigned && (
        <div className="card" style={{ padding: 16, background: 'rgba(34,197,94,.05)', border: '1px solid rgba(34,197,94,.25)' }}>
          <strong style={{ color: 'var(--green)' }}>✓ You've signed this inspection.</strong>
          <div style={{ fontSize: '.82rem', color: 'var(--t2)', marginTop: 4 }}>
            Waiting on landlord finalization.
          </div>
        </div>
      )}

      {camera && (
        <CameraCapture
          mode={camera}
          onClose={() => setCamera(null)}
          onCapture={(file) => (camera === 'photo' ? photoMut : videoMut).mutate({ file, live: true })}
        />
      )}

      {!user && null}
    </div>
  )
}

// ── MY WALKTHROUGHS ──────────────────────────────────────────
// Every walkthrough video the tenant has recorded, across all their units
// over the years (self-scoped via GET /inspections/videos/mine).
function TenantMyWalkthroughsPage() {
  const { data = [], isLoading } = useQuery<any[]>('tenant-my-walkthroughs', () =>
    get<any[]>('/inspections/videos/mine'),
  )
  if (isLoading) return <div style={{ padding: 32, color: 'var(--t3)' }}>Loading…</div>
  return (
    <div>
      <div className="ph">
        <div>
          <h1 className="pt">My walkthroughs</h1>
          <p className="ps">Every walkthrough video you’ve recorded, across your units.</p>
        </div>
      </div>
      {data.length === 0 ? (
        <div className="card" style={{ padding: 24, textAlign: 'center', color: 'var(--t3)' }}>
          No walkthrough videos yet. When you record one during an inspection, it shows up here.
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 16 }}>
          {data.map(v => (
            <div key={v.id} className="card" style={{ padding: 12 }}>
              <AuthedVideo path={v.videoUrl}
                     style={{ width: '100%', borderRadius: 8, background: '#000', aspectRatio: '16/9' }} />
              <div style={{ marginTop: 8, fontSize: '.82rem', color: 'var(--t0)' }}>
                {labelType(v.inspectionType)} · Unit {v.unitNumber || '—'}
              </div>
              <div style={{ fontSize: '.75rem', color: 'var(--t3)' }}>
                {v.propertyName} · {new Date(v.uploadedAt).toLocaleDateString()}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ── CREDIT LEDGER ────────────────────────────────────────────
// Tenant view of own GAM behavioral record. Shows event timeline,
// payment / property / cooperation roll-ups, and lets tenant open
// disputes on events they believe are inaccurate. Score itself is
// internal-only; tenant sees event count + on-time % + streaks.

const EVENT_LABEL: Record<string, string> = {
  payment_received_on_time:           'Rent paid on time',
  payment_received_late_grace:        'Paid within grace period',
  payment_received_late_minor:        'Paid late (minor)',
  payment_received_late_major:        'Paid late (major)',
  payment_received_late_severe:       'Paid late (severe)',
  payment_partial:                    'Partial payment',
  payment_failed_nsf:                 'Payment failed (NSF)',
  payment_skipped:                    'Payment skipped',
  payment_refunded:                   'Payment refunded',
  lease_signed:                       'Lease signed',
  lease_renewed:                      'Lease renewed',
  lease_anniversary:                  'Lease anniversary',
  lease_terminated_natural:           'Lease completed',
  lease_terminated_early_by_tenant:   'Lease ended early (by tenant)',
  lease_terminated_early_by_landlord: 'Lease ended early (by landlord)',
  lease_abandoned:                    'Lease abandoned',
  proper_notice_given_for_move_out:   'Proper move-out notice',
  move_in_inspection_completed:       'Move-in inspection completed',
  move_out_inspection_completed:      'Move-out inspection completed',
  move_out_condition_matches_move_in: 'Move-out condition matches',
  move_out_condition_damage_documented:'Move-out damage documented',
  move_in_photos_submitted:           'Move-in photos submitted',
  move_out_photos_submitted:          'Move-out photos submitted',
  deposit_returned_full:              'Deposit returned in full',
  deposit_returned_partial:           'Deposit partially withheld',
  deposit_returned_zero:              'Deposit fully withheld',
  deposit_interest_paid:              'Statutory deposit interest settled',
  sublease_requested:                 'Sublease requested',
  sublease_approved:                  'Sublease approved',
  sublease_denied:                    'Sublease denied',
  sublease_completed_natural:         'Sublease completed (end of term)',
  sublease_terminated_early:          'Sublease terminated early',
  lease_addendum_recorded:            'Lease amended (addendum)',
  renters_insurance_verified:         'Renters insurance verified',
  utilities_transferred_at_move_in:   'Utilities transferred',
  maintenance_resolution_confirmed:   'Maintenance fix confirmed',
  entry_request_granted_within_window:'Entry granted within window',
  entry_request_denied:               'Entry request denied',
  lease_violation_notice_issued:      'Lease violation notice',
  lease_violation_cured:              'Lease violation cured',
  noise_complaint_logged:             'Noise complaint',
  property_damage_event_documented:   'Property damage documented',
  nuisance_event_documented:          'Nuisance event documented',
  eviction_notice_filed:              'Eviction notice filed',
  eviction_settled:                   'Eviction settled',
  eviction_hearing_dismissed:         'Eviction dismissed',
  eviction_hearing_judgment_issued:   'Eviction judgment',
  tenancy_ended_with_balance:         'Tenancy ended with balance',
  balance_paid_post_move:             'Balance paid post-move',
  balance_sent_to_collections:        'Balance sent to collections',
  hardship_context_added:             'Hardship context added',
  dispute_opened:                     'Dispute opened',
  dispute_evidence_submitted:         'Dispute evidence submitted',
  dispute_resolved_upheld:            'Dispute resolved (upheld)',
  dispute_resolved_corrected:         'Dispute resolved (corrected)',
  dispute_resolved_no_change:         'Dispute resolved (no change)',
  multi_landlord_history_clean:       'Clean history across landlords',
}

const POSITIVE_EVENT_TYPES = new Set([
  'payment_received_on_time','payment_received_late_grace','payment_received_late_minor',
  'lease_signed','lease_renewed','lease_terminated_natural','lease_anniversary',
  'proper_notice_given_for_move_out','move_in_inspection_completed','move_out_inspection_completed',
  'move_out_condition_matches_move_in','move_in_photos_submitted','move_out_photos_submitted',
  'deposit_returned_full','renters_insurance_verified','utilities_transferred_at_move_in',
  'maintenance_resolution_confirmed','entry_request_granted_within_window','lease_violation_cured',
  'balance_paid_post_move','multi_landlord_history_clean',
])

function eventTone(eventType: string): 'positive' | 'negative' | 'neutral' {
  if (POSITIVE_EVENT_TYPES.has(eventType)) return 'positive'
  if (eventType.startsWith('dispute_')) return 'neutral'
  if (eventType === 'hardship_context_added' || eventType === 'subject_added_event_context') return 'neutral'
  return 'negative'
}

function CreditPage() {
  const [disputeFor, setDisputeFor] = useState<any | null>(null)
  const [showHardship, setShowHardship] = useState(false)

  const { data: own, isLoading } = useQuery<any>('credit-own', () => get<any>('/credit/subject/own'))
  const subjectId = (own as any)?.subjectId as string | null
  const { data: stats } = useQuery<any>(
    ['credit-stats', subjectId],
    () => get<any>(`/credit/stats/${subjectId}`),
    { enabled: !!subjectId },
  )

  if (isLoading) return <div style={{ padding: 32, color: 'var(--t3)' }}>Loading…</div>

  const events = (((own as any)?.events) || []) as any[]
  const activeEvents = events.filter(e => !e.superseded)

  // Group events by month for the timeline
  const grouped: { label: string; rows: any[] }[] = []
  for (const ev of activeEvents) {
    const d = new Date(ev.occurredAt)
    const key = d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
    let bucket = grouped.find(g => g.label === key)
    if (!bucket) { bucket = { label: key, rows: [] }; grouped.push(bucket) }
    bucket.rows.push(ev)
  }
  // Most recent month first
  grouped.reverse()

  const payment = (stats as any)?.paymentStats?.lifetime || {}
  const onTimePct = payment.onTimePct
  const totalPayments = payment.totalEvents ?? 0
  const longestStreak = (stats as any)?.paymentStats?.longestOnTimeStreakCount ?? 0
  const currentStreak = (stats as any)?.paymentStats?.currentOnTimeStreakCount ?? 0

  return (
    <div>
      <div className="ph">
        <div>
          <h1 className="pt">My GAM Record</h1>
          <p className="ps">Your tenancy track record on the GAM network</p>
        </div>
        <button className="btn btn-g btn-sm" onClick={() => setShowHardship(true)}>+ Add hardship context</button>
      </div>

      <div className="alert a-blue" style={{ marginBottom: 16 }}>
        ℹ️ This is the same record GAM uses internally for FlexPay /
        FlexCharge underwriting. Landlords on the network see specific
        events, not the underlying score.
      </div>

      <div className="grid3" style={{ marginBottom: 16 }}>
        <div className="kpi">
          <div className="kpi-l">Total events</div>
          <div className="kpi-v">{activeEvents.length}</div>
          <div className="kpi-s">attested behavior on file</div>
        </div>
        <div className="kpi">
          <div className="kpi-l">On-time payments</div>
          <div className="kpi-v">{totalPayments > 0 ? `${onTimePct}%` : '—'}</div>
          <div className="kpi-s">{totalPayments} payments tracked</div>
        </div>
        <div className="kpi">
          <div className="kpi-l">On-time streak</div>
          <div className="kpi-v">{currentStreak}</div>
          <div className="kpi-s">longest: {longestStreak}</div>
        </div>
      </div>

      <div className="card" style={{ padding: 0 }}>
        <div style={{ padding: 14, borderBottom: '1px solid var(--b0)' }}>
          <strong style={{ color: 'var(--t0)' }}>Event timeline</strong>
        </div>
        {grouped.length === 0 ? (
          <div style={{ padding: 32, color: 'var(--t3)', textAlign: 'center' }}>
            No events yet. As you make payments and complete tenancy
            milestones, they'll show up here.
          </div>
        ) : grouped.map(bucket => (
          <div key={bucket.label}>
            <div style={{ padding: '8px 14px', background: 'var(--bg1)', fontSize: '.7rem', color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '.08em', fontWeight: 600 }}>
              {bucket.label}
            </div>
            {bucket.rows.map(ev => (
              <CreditEventRow key={ev.id} ev={ev} onDispute={() => setDisputeFor(ev)} />
            ))}
          </div>
        ))}
      </div>

      {disputeFor && (
        <CreditDisputeModal
          ev={disputeFor}
          onClose={() => setDisputeFor(null)}
        />
      )}
      {showHardship && (
        <HardshipModal onClose={() => setShowHardship(false)} />
      )}
    </div>
  )
}

function CreditEventRow({ ev, onDispute }: { ev: any; onDispute: () => void }) {
  const tone = eventTone(ev.eventType)
  const dotColor = tone === 'positive' ? 'var(--green)' : tone === 'negative' ? 'var(--red)' : 'var(--t3)'
  const label = EVENT_LABEL[ev.eventType] || ev.eventType
  const canDispute = tone === 'negative' && !ev.eventType.startsWith('dispute_')

  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, padding: '12px 14px', borderBottom: '1px solid var(--b0)' }}>
      <div style={{ width: 8, height: 8, borderRadius: '50%', background: dotColor, marginTop: 6, flexShrink: 0 }} />
      <div style={{ flex: 1 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
          <strong style={{ color: 'var(--t0)' }}>{label}</strong>
          <span style={{ fontSize: '.7rem', color: 'var(--t3)' }}>{new Date(ev.occurredAt).toLocaleDateString()}</span>
          {ev.superseded && <span className="badge b-muted">superseded</span>}
        </div>
        <div style={{ fontSize: '.75rem', color: 'var(--t3)', marginTop: 2 }}>
          attested by {attestationLabel(ev.attestationSource)}
          {ev.dimensionTags?.length ? <> · tags: {ev.dimensionTags.join(', ')}</> : null}
        </div>
      </div>
      {canDispute && (
        <button className="btn btn-g btn-sm" onClick={onDispute} style={{ flexShrink: 0 }}>Dispute</button>
      )}
    </div>
  )
}

function attestationLabel(src: string): string {
  switch (src) {
    case 'stripe_attested':       return 'Stripe (payment processor)'
    case 'gam_workflow_auto':     return 'GAM workflow'
    case 'gam_bill_pay_attested': return 'GAM bill-pay'
    case 'plaid_attested':        return 'Plaid'
    case 'system_derived':        return 'system'
    case 'tenant_self_reported':  return 'self-reported'
    default:                      return src.replace(/_/g, ' ')
  }
}

function CreditDisputeModal({ ev, onClose }: { ev: any; onClose: () => void }) {
  const qc = useQueryClient()
  const [reason, setReason] = useState<'factual_inaccuracy'|'attestation_invalid'|'identity_mismatch'|'other'>('factual_inaccuracy')
  const [notes, setNotes] = useState('')
  const [error, setError] = useState<string | null>(null)
  const mut = useMutation(
    () => post('/credit/dispute', {
      disputedEventId: ev.id,
      reason,
      notes: notes || undefined,
    }),
    {
      onSuccess: () => {
        qc.invalidateQueries('credit-own')
        onClose()
      },
      onError: (e: any) => setError(e?.response?.data?.error || 'Failed'),
    },
  )

  return (
    <div className="modal-ov" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="modal-t">Dispute event</div>
        <div style={{ background: 'var(--bg3)', padding: 12, borderRadius: 8, marginBottom: 16, fontSize: '.85rem' }}>
          <strong style={{ color: 'var(--t0)' }}>{EVENT_LABEL[ev.eventType] || ev.eventType}</strong>
          <div style={{ color: 'var(--t3)', fontSize: '.75rem', marginTop: 2 }}>
            {new Date(ev.occurredAt).toLocaleDateString()} · {attestationLabel(ev.attestationSource)}
          </div>
        </div>
        {error && <div className="alert" style={{ background: 'rgba(239,68,68,.08)', border: '1px solid rgba(239,68,68,.3)', color: 'var(--red)', marginBottom: 12 }}>{error}</div>}
        <div className="fg">
          <label className="fl">Reason</label>
          <select className="fi" value={reason} onChange={e => setReason(e.target.value as any)}>
            <option value="factual_inaccuracy">Factual inaccuracy</option>
            <option value="attestation_invalid">Attestation invalid</option>
            <option value="identity_mismatch">Identity mismatch</option>
            <option value="other">Other</option>
          </select>
        </div>
        <div className="fg">
          <label className="fl">Notes</label>
          <textarea
            className="fi"
            rows={4}
            value={notes}
            onChange={e => setNotes(e.target.value)}
            placeholder="Explain what's wrong (optional but helpful)"
          />
        </div>
        <div className="modal-f">
          <button className="btn btn-g" onClick={onClose}>Cancel</button>
          <button className="btn btn-p" onClick={() => mut.mutate()} disabled={mut.isLoading}>
            {mut.isLoading ? 'Submitting…' : 'Open dispute'}
          </button>
        </div>
      </div>
    </div>
  )
}

function HardshipModal({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient()
  const [category, setCategory] = useState<'medical'|'job_loss'|'family_death'|'natural_disaster'|'military_deployment'|'other'>('medical')
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')
  const [note, setNote] = useState('')
  const [error, setError] = useState<string | null>(null)

  const mut = useMutation(
    () => post('/credit/hardship-context', {
      category,
      startDate,
      endDate: endDate || undefined,
      note: note || undefined,
    }),
    {
      onSuccess: () => {
        qc.invalidateQueries('credit-own')
        onClose()
      },
      onError: (e: any) => setError(e?.response?.data?.error || 'Failed'),
    },
  )

  return (
    <div className="modal-ov" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="modal-t">Add hardship context</div>
        <div className="alert a-blue" style={{ marginBottom: 16 }}>
          Hardship context doesn't erase events — it adds explanation
          alongside them. It's visible to you and during dispute
          review, never used to automatically reweight your record.
        </div>
        {error && <div className="alert" style={{ background: 'rgba(239,68,68,.08)', border: '1px solid rgba(239,68,68,.3)', color: 'var(--red)', marginBottom: 12 }}>{error}</div>}
        <div className="fg">
          <label className="fl">Category</label>
          <select className="fi" value={category} onChange={e => setCategory(e.target.value as any)}>
            <option value="medical">Medical</option>
            <option value="job_loss">Job loss</option>
            <option value="family_death">Family death</option>
            <option value="natural_disaster">Natural disaster</option>
            <option value="military_deployment">Military deployment</option>
            <option value="other">Other</option>
          </select>
        </div>
        <div className="grid2">
          <div className="fg">
            <label className="fl">Start date</label>
            <input className="fi" type="date" value={startDate} onChange={e => setStartDate(e.target.value)} required />
          </div>
          <div className="fg">
            <label className="fl">End date (optional)</label>
            <input className="fi" type="date" value={endDate} onChange={e => setEndDate(e.target.value)} />
          </div>
        </div>
        <div className="fg">
          <label className="fl">Note (optional)</label>
          <textarea
            className="fi"
            rows={3}
            value={note}
            onChange={e => setNote(e.target.value)}
            placeholder="Brief context about what happened"
          />
        </div>
        <div className="modal-f">
          <button className="btn btn-g" onClick={onClose}>Cancel</button>
          <button className="btn btn-p" onClick={() => {
            if (!startDate) { setError('Start date required'); return }
            mut.mutate()
          }} disabled={mut.isLoading}>
            {mut.isLoading ? 'Submitting…' : 'Add context'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── NOTIFICATION PREFERENCES ─────────────────────────────────
const TENANT_NOTIFICATION_TYPES: { type: string; label: string }[] = [
  { type: 'rent_collected',                  label: 'Rent collected' },
  { type: 'rent_failed',                     label: 'Rent failed' },
  { type: 'ach_retry_scheduled',             label: 'ACH retry scheduled' },
  { type: 'ach_retries_exhausted',           label: 'ACH retries exhausted' },
  { type: 'maintenance_updated',             label: 'Maintenance status update' },
  { type: 'inspection_ready',                label: 'Inspection ready to sign' },
  { type: 'inspection_finalized',            label: 'Inspection finalized' },
  { type: 'inspection_scheduled_reminder',   label: 'Inspection scheduled reminder' },
  { type: 'entry_request_new',               label: 'New entry request' },
  { type: 'entry_recorded',                  label: 'Entry recorded by landlord' },
  { type: 'dispute_resolved',                label: 'Dispute resolved' },
  { type: 'work_trade_reminder',             label: 'Work trade reminder' },
  { type: 'amenity_unavailable',             label: 'Amenity unavailable / reserved' },
  { type: 'reservation_decision',            label: 'Reservation approved / declined' },
  { type: 'service_interruption',            label: 'Utility outage / service interruption' },
]

function NotificationPrefsPage() {
  const qc = useQueryClient()
  const { data: prefs = [], isLoading } = useQuery<any[]>('notification-prefs', () =>
    get<any[]>('/notifications/preferences'),
  )
  const prefMap = new Map<string, any>()
  for (const p of (prefs as any[])) prefMap.set(p.type, p)

  const update = useMutation(
    (body: { type: string; emailEnabled: boolean; smsEnabled: boolean; inAppEnabled: boolean }) =>
      api.patch('/notifications/preferences', body).then(r => r.data),
    {
      onSuccess: () => qc.invalidateQueries('notification-prefs'),
    },
  )

  const toggle = (type: string, channel: 'email' | 'sms', currentVal: boolean) => {
    const current = prefMap.get(type) || { email_enabled: true, sms_enabled: false, in_app_enabled: true }
    const next = {
      type,
      emailEnabled: channel === 'email' ? !currentVal : current.emailEnabled,
      smsEnabled:   channel === 'sms'   ? !currentVal : current.smsEnabled,
      inAppEnabled: current.inAppEnabled,
    }
    update.mutate(next)
  }

  return (
    <div>
      <div className="ph">
        <div>
          <h1 className="pt">Notifications</h1>
          <p className="ps">Choose how GAM contacts you</p>
        </div>
      </div>
      <div className="alert a-blue" style={{ marginBottom: 16 }}>
        ℹ️ In-app notifications always show in your dashboard. Email and SMS
        are optional channels per notification type.
      </div>
      <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
        {isLoading ? (
          <div style={{ padding: 32, color: 'var(--t3)', textAlign: 'center' }}>Loading…</div>
        ) : (
          <table className="tbl" style={{ minWidth: 480 }}>
            <thead>
              <tr>
                <th>Notification</th>
                <th style={{ textAlign: 'center' }}>Email</th>
                <th style={{ textAlign: 'center' }}>SMS</th>
              </tr>
            </thead>
            <tbody>
              {TENANT_NOTIFICATION_TYPES.map(({ type, label }) => {
                const p = prefMap.get(type) || { email_enabled: true, sms_enabled: false }
                return (
                  <tr key={type}>
                    <td style={{ color: 'var(--t0)' }}>{label}</td>
                    <td style={{ textAlign: 'center' }}>
                      <input type="checkbox" checked={p.emailEnabled} onChange={() => toggle(type, 'email', p.emailEnabled)} />
                    </td>
                    <td style={{ textAlign: 'center' }}>
                      <input type="checkbox" checked={p.smsEnabled} onChange={() => toggle(type, 'sms', p.smsEnabled)} />
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

// ── MY DISPUTES ─────────────────────────────────────────────
function MyDisputesPage() {
  const [evidenceFor, setEvidenceFor] = useState<any | null>(null)
  const { data = [], isLoading } = useQuery<any[]>('my-disputes', () => get<any[]>('/credit/disputes/mine'))
  const list = data as any[]
  return (
    <div>
      <div className="ph">
        <div>
          <h1 className="pt">My Disputes</h1>
          <p className="ps">Disputes you've opened on your record</p>
        </div>
      </div>
      <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
        {isLoading ? (
          <div style={{ padding: 32, color: 'var(--t3)', textAlign: 'center' }}>Loading…</div>
        ) : list.length === 0 ? (
          <div style={{ padding: 32, color: 'var(--t3)', textAlign: 'center' }}>
            You haven't opened any disputes yet.
          </div>
        ) : (
          <table className="tbl" style={{ minWidth: 720 }}>
            <thead>
              <tr><th>Status</th><th>Disputed event</th><th>Reason</th><th>Filed</th><th>Resolved</th><th></th></tr>
            </thead>
            <tbody>
              {list.map(d => {
                const open = d.status === 'open' || d.status === 'evidence_pending'
                return (
                  <tr key={d.id}>
                    <td><span className={`badge ${disputeStatusBadgeTenant(d.status)}`}>{d.status.replace('_',' ')}</span></td>
                    <td style={{ color: 'var(--t0)' }}>
                      {EVENT_LABEL[d.disputedEventType] || d.disputedEventType}
                      <div style={{ fontSize: '.7rem', color: 'var(--t3)' }}>{new Date(d.disputedEventOccurredAt).toLocaleDateString()}</div>
                    </td>
                    <td style={{ fontSize: '.78rem' }}>{d.reason.replace('_',' ')}</td>
                    <td className="mono" style={{ fontSize: '.72rem', color: 'var(--t3)' }}>{new Date(d.createdAt).toLocaleDateString()}</td>
                    <td className="mono" style={{ fontSize: '.72rem', color: 'var(--t3)' }}>{d.resolvedAt ? new Date(d.resolvedAt).toLocaleDateString() : '—'}</td>
                    <td>
                      {open && (
                        <button className="btn btn-g btn-sm" onClick={() => setEvidenceFor(d)}>+ Evidence</button>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>
      {evidenceFor && (
        <SubmitEvidenceModal dispute={evidenceFor} onClose={() => setEvidenceFor(null)} />
      )}
    </div>
  )
}

function SubmitEvidenceModal({ dispute, onClose }: { dispute: any; onClose: () => void }) {
  const qc = useQueryClient()
  const [evidenceUrl, setEvidenceUrl] = useState('')
  const [description, setDescription] = useState('')
  const [error, setError] = useState<string | null>(null)
  const mut = useMutation(
    () => post(`/credit/dispute/${dispute.id}/evidence`, {
      evidence: {
        evidence_url: evidenceUrl || null,
        description: description || null,
        submitted_at: new Date().toISOString(),
      },
    }),
    {
      onSuccess: () => {
        qc.invalidateQueries('my-disputes')
        onClose()
      },
      onError: (e: any) => setError(e?.response?.data?.error || 'Failed'),
    },
  )
  return (
    <div className="modal-ov" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="modal-t">Submit evidence</div>
        <div style={{ background: 'var(--bg3)', padding: 12, borderRadius: 8, marginBottom: 16, fontSize: '.85rem' }}>
          <strong style={{ color: 'var(--t0)' }}>{EVENT_LABEL[dispute.disputedEventType] || dispute.disputedEventType}</strong>
          <div style={{ color: 'var(--t3)', fontSize: '.75rem', marginTop: 2 }}>
            Filed {new Date(dispute.createdAt).toLocaleDateString()}
          </div>
        </div>
        {error && <div className="alert" style={{ background: 'rgba(239,68,68,.08)', border: '1px solid rgba(239,68,68,.3)', color: 'var(--red)', marginBottom: 12 }}>{error}</div>}
        <div className="fg">
          <label className="fl">Evidence URL (optional)</label>
          <input className="fi" value={evidenceUrl} onChange={e => setEvidenceUrl(e.target.value)} placeholder="https://… link to bank letter, receipt, etc." />
        </div>
        <div className="fg">
          <label className="fl">Description</label>
          <textarea
            className="fi"
            rows={4}
            value={description}
            onChange={e => setDescription(e.target.value)}
            placeholder="Briefly describe what this evidence shows"
          />
        </div>
        <div className="modal-f">
          <button className="btn btn-g" onClick={onClose}>Cancel</button>
          <button
            className="btn btn-p"
            onClick={() => {
              if (!evidenceUrl && !description) { setError('Provide a URL or description'); return }
              mut.mutate()
            }}
            disabled={mut.isLoading}
          >
            {mut.isLoading ? 'Submitting…' : 'Submit evidence'}
          </button>
        </div>
      </div>
    </div>
  )
}

function disputeStatusBadgeTenant(s: string) {
  if (s === 'resolved_corrected') return 'b-green'
  if (s === 'open' || s === 'evidence_pending') return 'b-amber'
  if (s === 'resolved_upheld' || s === 'resolved_no_change') return 'b-muted'
  return 'b-muted'
}

// ── ENTRY REQUESTS ───────────────────────────────────────────
function TenantEntryRequestsPage() {
  const navigate = useNavigate()
  const { data = [], isLoading } = useQuery<any[]>('tenant-entry-requests', () =>
    get<any[]>('/entry-requests'),
  )
  const list = data as any[]
  return (
    <div>
      <div className="ph">
        <div>
          <h1 className="pt">Entry Requests</h1>
          <p className="ps">When your landlord needs access to the unit</p>
        </div>
      </div>
      <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
        {isLoading ? (
          <div style={{ padding: 32, color: 'var(--t3)', textAlign: 'center' }}>Loading…</div>
        ) : list.length === 0 ? (
          <div style={{ padding: 32, color: 'var(--t3)', textAlign: 'center' }}>
            No entry requests yet.
          </div>
        ) : (
          <table className="tbl" style={{ minWidth: 680 }}>
            <thead>
              <tr><th>Status</th><th>Reason</th><th>When</th><th>Notice</th><th></th></tr>
            </thead>
            <tbody>
              {list.map(r => (
                <tr key={r.id}>
                  <td><span className={`badge ${entryStatusBadge(r.status)}`}>{r.status}</span></td>
                  <td style={{ color: 'var(--t0)', maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.reason}</td>
                  <td className="mono" style={{ fontSize: '.78rem' }}>{fmtEntryDateTime(r.proposedEntryWindowStart)}</td>
                  <td style={{ color: r.noticeWindowHours < 24 ? 'var(--amber)' : 'var(--t2)', fontSize: '.78rem' }}>{r.noticeWindowHours}h</td>
                  <td><button className="btn btn-g btn-sm" onClick={() => navigate(`/entry-requests/${r.id}`)}>Open →</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}

function entryStatusBadge(s: string) {
  if (s === 'completed' || s === 'granted') return 'b-green'
  if (s === 'pending') return 'b-amber'
  if (s === 'breached') return 'b-red'
  return 'b-muted'
}

// ── Amenities / common-area reservations (resident side) ──────────────
// Responses arrive camelCased (applyCamelizeInterceptor).
type AmenityArea = {
  id: string; name: string; description: string | null
  requiresApproval: boolean; capacity: number | null; reservationFee: string
  openTime: string | null; closeTime: string | null
  maxReservationHours: number | null; advanceBookingDays: number | null
  upcoming: { title: string | null; kind: string; startsAt: string; endsAt: string }[]
}
type MyReservation = {
  id: string; areaName: string; kind: string; title: string | null
  status: 'pending' | 'approved' | 'rejected' | 'cancelled'
  startsAt: string; endsAt: string; guestCount: number | null
}
function resvBadge(s: string) {
  if (s === 'approved') return 'b-green'
  if (s === 'pending') return 'b-amber'
  return 'b-muted'
}
const fmtResv = (s: string) => new Date(s).toLocaleString('en-US',
  { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })

function TenantAmenitiesPage() {
  const qc = useQueryClient()
  const { data: areas = [] } = useQuery<AmenityArea[]>('amenity-areas', () => get<AmenityArea[]>('/common-areas/mine'))
  const { data: mine = [] } = useQuery<MyReservation[]>('my-reservations', () => get<MyReservation[]>('/common-areas/my-reservations'))
  const [reqFor, setReqFor] = useState<AmenityArea | null>(null)
  const cancel = useMutation((id: string) => post(`/common-areas/reservations/${id}/cancel`), {
    onSuccess: () => { qc.invalidateQueries('my-reservations'); qc.invalidateQueries('amenity-areas') },
  })

  return (
    <div>
      <div className="ph">
        <div>
          <h1 className="pt">Amenities</h1>
          <p className="ps">Reserve shared spaces — clubhouse, pool, pavilion — for private use.</p>
        </div>
      </div>

      {areas.length === 0 && (
        <div className="card" style={{ padding: 32, textAlign: 'center', color: 'var(--t3)' }}>
          No reservable amenities at your property.
        </div>
      )}

      <div style={{ display: 'grid', gap: 12 }}>
        {areas.map(a => (
          <div key={a.id} className="card" style={{ padding: 16 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
              <div>
                <div style={{ fontWeight: 700, fontSize: '1.05rem', color: 'var(--t0)' }}>{a.name}</div>
                {a.description && <div className="ps" style={{ marginTop: 2 }}>{a.description}</div>}
                <div style={{ fontSize: '.75rem', color: 'var(--t3)', marginTop: 6, display: 'flex', gap: 14, flexWrap: 'wrap' }}>
                  {a.capacity != null && <span>Capacity {a.capacity}</span>}
                  {Number(a.reservationFee) > 0 && <span>Fee ${Number(a.reservationFee).toFixed(2)}</span>}
                  {a.openTime && a.closeTime && <span>Open {a.openTime.slice(0, 5)}–{a.closeTime.slice(0, 5)}</span>}
                  {a.maxReservationHours && <span>Max {a.maxReservationHours}h</span>}
                  <span>{a.requiresApproval ? 'Approval required' : 'Instant'}</span>
                </div>
                {a.upcoming.length > 0 && (
                  <div style={{ fontSize: '.72rem', color: 'var(--amber)', marginTop: 8 }}>
                    Unavailable: {a.upcoming.slice(0, 3).map(h => `${fmtResv(h.startsAt)}–${new Date(h.endsAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`).join(' · ')}
                    {a.upcoming.length > 3 && ` +${a.upcoming.length - 3} more`}
                  </div>
                )}
              </div>
              <button className="btn btn-g btn-sm" style={{ flexShrink: 0 }} onClick={() => setReqFor(a)}>Reserve</button>
            </div>
          </div>
        ))}
      </div>

      <h2 className="pt" style={{ fontSize: '1.05rem', margin: '22px 0 10px' }}>My reservations</h2>
      <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
        {mine.length === 0 ? (
          <div style={{ padding: 24, color: 'var(--t3)', textAlign: 'center' }}>No reservations yet.</div>
        ) : (
          <table className="tbl" style={{ minWidth: 600 }}>
            <thead><tr><th>Area</th><th>When</th><th>Status</th><th></th></tr></thead>
            <tbody>
              {mine.map(r => (
                <tr key={r.id}>
                  <td style={{ color: 'var(--t0)' }}>{r.areaName}{r.title ? ` · ${r.title}` : ''}</td>
                  <td className="mono" style={{ fontSize: '.78rem' }}>{fmtResv(r.startsAt)} → {fmtResv(r.endsAt)}</td>
                  <td><span className={`badge ${resvBadge(r.status)}`}>{r.status}</span></td>
                  <td>{(r.status === 'pending' || r.status === 'approved') &&
                    <button className="btn btn-sm" disabled={cancel.isLoading} onClick={() => cancel.mutate(r.id)}>Cancel</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {reqFor && <ReserveModal area={reqFor} onClose={() => setReqFor(null)}
        onDone={() => { setReqFor(null); qc.invalidateQueries('my-reservations'); qc.invalidateQueries('amenity-areas') }} />}
    </div>
  )
}

function ReserveModal({ area, onClose, onDone }: { area: AmenityArea; onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState({ title: '', startsAt: '', endsAt: '', guestCount: '', notes: '' })
  const m = useMutation(
    () => post(`/common-areas/${area.id}/request`, {
      title: f.title || undefined,
      startsAt: new Date(f.startsAt).toISOString(), endsAt: new Date(f.endsAt).toISOString(),
      guestCount: f.guestCount ? Number(f.guestCount) : null, notes: f.notes || undefined,
    }),
    { onSuccess: onDone })
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.6)', display: 'grid', placeItems: 'center', zIndex: 60 }} onClick={onClose}>
      <div className="card" style={{ width: 440, maxWidth: '92vw', padding: 20 }} onClick={e => e.stopPropagation()}>
        <h2 className="pt" style={{ fontSize: '1.1rem', marginBottom: 4 }}>Reserve {area.name}</h2>
        <p className="ps" style={{ marginBottom: 12 }}>
          {area.requiresApproval ? 'Your request goes to management for approval.' : 'This area reserves instantly.'}
        </p>
        <label className="ps">What for? (optional)</label>
        <input className="inp" value={f.title} onChange={e => setF({ ...f, title: e.target.value })} placeholder="Birthday party" style={{ marginBottom: 8 }} />
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
          <div><label className="ps">Starts</label><input className="inp" type="datetime-local" value={f.startsAt} onChange={e => setF({ ...f, startsAt: e.target.value })} /></div>
          <div><label className="ps">Ends</label><input className="inp" type="datetime-local" value={f.endsAt} onChange={e => setF({ ...f, endsAt: e.target.value })} /></div>
        </div>
        <label className="ps" style={{ marginTop: 8, display: 'block' }}>Guests (optional)</label>
        <input className="inp" type="number" value={f.guestCount} onChange={e => setF({ ...f, guestCount: e.target.value })} />
        {m.isError && <div style={{ color: 'var(--red,#e25)', fontSize: '.8rem', marginTop: 8 }}>
          {(m.error as any)?.response?.data?.error || 'Could not reserve (time taken or out of bounds).'}</div>}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
          <button className="btn btn-sm" onClick={onClose}>Cancel</button>
          <button className="btn btn-g btn-sm" disabled={!f.startsAt || !f.endsAt || m.isLoading} onClick={() => m.mutate()}>
            {area.requiresApproval ? 'Request' : 'Reserve'}
          </button>
        </div>
      </div>
    </div>
  )
}
function fmtEntryDateTime(ts: string | null | undefined) {
  if (!ts) return '—'
  return new Date(ts).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

function TenantEntryRequestDetailPage() {
  const params = useParams()
  const id = params.id!
  const navigate = useNavigate()
  const qc = useQueryClient()
  const [reasonText, setReasonText] = useState('')
  const [error, setError] = useState<string | null>(null)
  const { data, isLoading } = useQuery<any>(
    ['tenant-entry-request', id],
    () => get<any>(`/entry-requests/${id}`),
  )

  const respondMut = useMutation(
    (body: { decision: 'granted' | 'denied'; reason?: string }) =>
      post(`/entry-requests/${id}/respond`, body),
    {
      onSuccess: () => qc.invalidateQueries(['tenant-entry-request', id]),
      onError: (e: any) => setError(e?.response?.data?.error || 'Failed'),
    },
  )

  if (isLoading || !data) return <div style={{ padding: 32, color: 'var(--t3)' }}>Loading…</div>
  const r = data as any

  return (
    <div>
      <div className="ph">
        <div>
          <button className="btn btn-g btn-sm" onClick={() => navigate('/entry-requests')} style={{ marginBottom: 8 }}>← Entry Requests</button>
          <h1 className="pt">Entry Request</h1>
          <p className="ps"><span className={`badge ${entryStatusBadge(r.status)}`}>{r.status}</span></p>
        </div>
      </div>

      {error && <div className="alert" style={{ background: 'rgba(239,68,68,.08)', border: '1px solid rgba(239,68,68,.3)', color: 'var(--red)' }}>{error}</div>}

      <div className="card" style={{ padding: 16, marginBottom: 16 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '140px 1fr', gap: 8, fontSize: '.85rem' }}>
          <div style={{ color: 'var(--t3)' }}>Reason</div>
          <div style={{ color: 'var(--t0)', fontWeight: 600 }}>{r.reason}</div>
          <div style={{ color: 'var(--t3)' }}>Category</div>
          <div>{r.reasonCategory}</div>
          <div style={{ color: 'var(--t3)' }}>Window</div>
          <div className="mono" style={{ fontSize: '.78rem' }}>
            {fmtEntryDateTime(r.proposedEntryWindowStart)} → {fmtEntryDateTime(r.proposedEntryWindowEnd)}
          </div>
          <div style={{ color: 'var(--t3)' }}>Notice</div>
          <div style={{ color: r.noticeWindowHours < 24 ? 'var(--amber)' : 'var(--t1)' }}>
            {r.noticeWindowHours}h {r.noticeWindowHours < 24 && '(less than standard 24h)'}
          </div>
          {r.entryActualAt && <>
            <div style={{ color: 'var(--t3)' }}>Entered at</div>
            <div className="mono" style={{ fontSize: '.78rem' }}>{fmtEntryDateTime(r.entryActualAt)}</div>
          </>}
        </div>
      </div>

      {/* S478: hedged factual warnings (outside-hours + state-law)
          recomputed server-side on every GET. Tenant-protective; the
          landlord saw the same on submit, this closes the both-party
          transparency loop. */}
      {r.outsideTypicalHours && r.typicalHoursWarning && (
        <div className="card" style={{
          padding: 14, marginBottom: 12,
          background: 'rgba(245,158,11,.08)',
          border: '1px solid rgba(245,158,11,.4)',
          display: 'flex', gap: 10, alignItems: 'flex-start',
        }}>
          <div style={{ fontSize: 18, lineHeight: 1, color: 'var(--amber)' }}>⚠</div>
          <div style={{ fontSize: '.85rem', lineHeight: 1.5, color: 'var(--t0)' }}>
            <div style={{
              fontSize: '.7rem', fontWeight: 700,
              color: 'var(--amber)', textTransform: 'uppercase',
              letterSpacing: '.05em', marginBottom: 6,
            }}>Outside typical hours</div>
            {r.typicalHoursWarning}
          </div>
        </div>
      )}

      {Array.isArray(r.stateLawWarnings) && r.stateLawWarnings.length > 0 && (
        <div className="card" style={{
          padding: 14, marginBottom: 12,
          background: 'rgba(245,158,11,.08)',
          border: '1px solid rgba(245,158,11,.4)',
        }}>
          <div style={{
            fontSize: '.7rem', fontWeight: 700,
            color: 'var(--amber)', textTransform: 'uppercase',
            letterSpacing: '.05em', marginBottom: 8,
          }}>Heads up — state-law check</div>
          {r.stateLawWarnings.map((w: any, i: number) => (
            <div key={i} style={{ marginBottom: i < r.stateLawWarnings.length - 1 ? 12 : 0 }}>
              <div style={{ fontSize: '.85rem', color: 'var(--t0)', lineHeight: 1.5, marginBottom: 4 }}>
                {w.message}
              </div>
              <div style={{
                fontSize: '.7rem', color: 'var(--t3)',
                display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 4,
              }}>
                {w.citation && <span>{w.citation}</span>}
                {w.sourceUrl && (
                  <a href={w.sourceUrl} target="_blank" rel="noreferrer"
                    style={{ color: 'var(--amber)', textDecoration: 'none' }}>source ↗</a>
                )}
                {w.sourceDate && <span>as of {String(w.sourceDate).slice(0, 10)}</span>}
              </div>
              {w.disclaimer && (
                <div style={{
                  fontSize: '.65rem', color: 'var(--t3)',
                  fontStyle: 'italic', marginTop: 4, lineHeight: 1.4,
                }}>{w.disclaimer}</div>
              )}
            </div>
          ))}
        </div>
      )}

      {r.status === 'pending' && (
        <div className="card" style={{ padding: 16, background: 'rgba(201,162,39,.05)', border: '1px solid rgba(201,162,39,.25)' }}>
          <strong style={{ color: 'var(--gold)', display: 'block', marginBottom: 8 }}>Your response</strong>
          <div style={{ fontSize: '.82rem', color: 'var(--t2)', marginBottom: 12 }}>
            Granting access promptly (before the window starts) credits your record.
            Denying does not penalize you — denial is a tenant right.
          </div>
          <div style={{ marginBottom: 12 }}>
            <label className="fl">Reason / message (optional)</label>
            <input
              className="fi"
              value={reasonText}
              onChange={e => setReasonText(e.target.value)}
              placeholder="Optional note for landlord"
            />
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              className="btn btn-p"
              onClick={() => respondMut.mutate({ decision: 'granted', reason: reasonText || undefined })}
              disabled={respondMut.isLoading}
            >
              ✓ Grant access
            </button>
            <button
              className="btn btn-d"
              onClick={() => respondMut.mutate({ decision: 'denied', reason: reasonText || undefined })}
              disabled={respondMut.isLoading}
            >
              ✗ Deny
            </button>
          </div>
        </div>
      )}

      {r.response && (
        <div className="card" style={{
          padding: 12,
          background: r.response.decision === 'granted' ? 'rgba(34,197,94,.05)' : 'rgba(255,255,255,.02)',
          border: `1px solid ${r.response.decision === 'granted' ? 'rgba(34,197,94,.25)' : 'var(--b1)'}`,
        }}>
          <strong style={{ color: r.response.decision === 'granted' ? 'var(--green)' : 'var(--t1)' }}>
            You {r.response.decision} access on {fmtEntryDateTime(r.response.respondedAt)}
          </strong>
          {r.response.reason && <div style={{ fontSize: '.82rem', color: 'var(--t2)', marginTop: 4 }}>"{r.response.reason}"</div>}
        </div>
      )}
    </div>
  )
}

function DocumentsPage() {
  const { data: docs = [], isLoading } = useQuery<any[]>('docs', () => get<any[]>('/documents'))
  return (
    <div>
      <div className="ph"><div><h1 className="pt">Documents</h1><p className="ps">Your lease and agreements</p></div></div>
      <div className="card" style={{padding:0,overflowX:'auto'}}>
        {isLoading ? <div style={{padding:32,color:'var(--t3)',textAlign:'center'}}>Loading…</div> : (
          <table className="tbl" style={{minWidth:640}}>
            <thead><tr><th>Document</th><th>Type</th><th>Signed</th><th>Date</th><th></th></tr></thead>
            <tbody>
              {docs.length ? docs.map((d:any)=>(
                <tr key={d.id}>
                  <td style={{color:'var(--t0)'}}>{d.name}</td>
                  <td><span className="badge b-muted">{d.type.replace('_',' ')}</span></td>
                  <td><span className={`badge ${d.signedAt?'b-green':'b-amber'}`}>{d.signedAt?'Signed':'Pending signature'}</span></td>
                  <td className="mono" style={{fontSize:'.75rem',color:'var(--t3)'}}>{new Date(d.createdAt).toLocaleDateString()}</td>
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

// UtilitiesPage moved to ./pages/UtilitiesPage.tsx in S171 — column shape
// fixed against the real GET /utility/bills wire response and the missing
// Pay button wired against /api/utility/bills/:id/pay (S122 destination
// charge route). Reuses the shared payShared.tsx Pay flow.
import { UtilitiesPage as UtilitiesPageImpl } from './pages/UtilitiesPage'
function UtilitiesPage() {
  return <UtilitiesPageImpl />
}

// ── LOGIN ─────────────────────────────────────────────────────
function LoginPage() {
  const { login, loginWithTotp } = useAuth(); const navigate = useNavigate()
  const [err, setErr] = useState(''); const [loading, setLoading] = useState(false)
  const [totpSession, setTotpSession] = useState<string|null>(null)
  const [code, setCode] = useState('')
  const { register, handleSubmit } = useForm<{email:string;password:string}>()
  const onSubmit = async(d:{email:string;password:string})=>{
    setLoading(true);setErr('')
    try{
      const r = await login(d.email,d.password)
      if(r.kind==='totp_required'){setTotpSession(r.totpSession);setCode('')}
      else navigate('/home')
    }
    catch(e:any){setErr(e.response?.data?.error||'Login failed')}
    finally{setLoading(false)}
  }
  const onTotpSubmit = async(e:React.FormEvent)=>{
    e.preventDefault();setLoading(true);setErr('')
    try{ await loginWithTotp(totpSession!,code.trim()); navigate('/home') }
    catch(ex:any){
      const msg=ex.response?.data?.error||'Invalid code.'
      setErr(msg)
      // Session expired — drop back to the credentials step.
      if(/session/i.test(msg)){setTotpSession(null);setCode('')}
    }
    finally{setLoading(false)}
  }

  // ── Step 2: TOTP code ─────────────────────────────────────────
  if(totpSession){
    return (
      <div style={{minHeight:'100vh',display:'flex',alignItems:'center',justifyContent:'center',background:'var(--bg0)',padding:20}}>
        <div style={{width:'100%',maxWidth:400}}>
          <div style={{textAlign:'center',marginBottom:40}}>
            <div style={{fontFamily:'var(--font-d)',fontSize:'2rem',fontWeight:800,color:'var(--gold)',marginBottom:8}}>⚡ GAM</div>
            <div style={{color:'var(--t2)',fontSize:'.875rem'}}>Two-factor authentication</div>
          </div>
          <div className="card" style={{padding:28}}>
            <h2 style={{marginBottom:14}}>Enter your code</h2>
            <div style={{fontSize:'.85rem',color:'var(--t1)',marginBottom:16,lineHeight:1.6}}>
              Enter the 6-digit code from your authenticator app, or one of your recovery codes.
            </div>
            {err && <div className="alert a-warn" style={{marginBottom:16}}>{err}</div>}
            <form onSubmit={onTotpSubmit}>
              <div className="fg">
                <label className="fl">Code</label>
                <input
                  className="fi"
                  type="text"
                  value={code}
                  onChange={e=>setCode(e.target.value)}
                  autoFocus
                  required
                  autoComplete="one-time-code"
                  inputMode="text"
                  placeholder="123 456 or xxxxx-xxxxx"
                  style={{fontFamily:'var(--font-m)',letterSpacing:'.2em',textAlign:'center'}}
                />
              </div>
              <button className="btn btn-p" type="submit" disabled={loading||!code.trim()} style={{width:'100%',justifyContent:'center',marginTop:8}}>
                {loading?<span className="spinner"/>:'Verify'}
              </button>
            </form>
            <div style={{marginTop:16,textAlign:'center'}}>
              <button onClick={()=>{setTotpSession(null);setCode('');setErr('')}} style={{background:'none',border:'none',color:'var(--t2)',fontSize:'.85rem',cursor:'pointer',textDecoration:'underline'}}>
                ← Back to sign in
              </button>
            </div>
          </div>
        </div>
      </div>
    )
  }

  // ── Step 1: credentials ───────────────────────────────────────
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
          <div style={{ marginTop: 16, textAlign: 'center' }}>
            <Link to="/forgot-password" style={{ color: 'var(--gold)', fontSize: '.85rem', textDecoration: 'none' }}>
              Forgot password?
            </Link>
          </div>
        </div>
      </div>
    </div>
  )
}

// ── TOTP ENROLLMENT ───────────────────────────────────────────
// S289: opt-in 2FA enrollment for tenants. Reached from the Security
// page only — tenants are NOT in MANDATORY_TOTP_ROLES, so there's no
// gate forcing this. Three states:
//   loading   — fetching the secret + QR + recovery codes
//   showCodes — user scans the QR / saves recovery codes / enters the
//               first 6-digit token to confirm enrollment
//   done      — confirm succeeded; refresh() pulled totpEnabled; back
//               to Security
function TotpEnrollPage() {
  const { refresh } = useAuth()
  const navigate = useNavigate()
  const [state, setState] = useState<'loading'|'showCodes'|'done'|'error'>('loading')
  const [err, setErr] = useState('')
  const [qrDataUri, setQrDataUri] = useState('')
  const [otpauthUrl, setOtpauthUrl] = useState('')
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([])
  const [code, setCode] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [savedAck, setSavedAck] = useState(false)

  useEffect(()=>{
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
        // 409 if already enrolled — nothing to do, back to Security.
        if(e.response?.status===409){navigate('/security',{replace:true});return}
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
      setTimeout(()=>navigate('/security',{replace:true}),700)
    }catch(ex:any){
      setErr(ex.response?.data?.error||'Verification failed. Try the current code from your app.')
      setSubmitting(false)
    }
  }

  if(state==='loading'){
    return <div className="loading"><span className="spinner"/></div>
  }
  if(state==='error'){
    return (
      <div>
        <div className="ph"><div><div className="pt">Set up two-factor</div></div></div>
        <div className="card" style={{maxWidth:480}}>
          <div style={{fontSize:32,marginBottom:12}}>⚠️</div>
          <h3 style={{marginBottom:10}}>Couldn't start enrollment</h3>
          <p style={{color:'var(--t2)',fontSize:'.85rem',lineHeight:1.6,marginBottom:16}}>{err}</p>
          <button onClick={()=>navigate('/security')} className="btn btn-g">Back to Security</button>
        </div>
      </div>
    )
  }
  if(state==='done'){
    return (
      <div>
        <div className="card" style={{maxWidth:480,textAlign:'center',padding:28}}>
          <div style={{fontSize:36,marginBottom:12}}>✅</div>
          <h3 style={{marginBottom:10}}>Two-factor authentication enabled</h3>
          <p style={{color:'var(--t2)',fontSize:'.85rem',lineHeight:1.6}}>Returning to Security…</p>
        </div>
      </div>
    )
  }

  // Main enrollment screen
  return (
    <div>
      <div className="ph">
        <div><div className="pt">Set up two-factor authentication</div><div className="ps">Add an authenticator-app code to every sign-in</div></div>
      </div>
      <div className="card" style={{maxWidth:600}}>
        <div style={{fontSize:'.85rem',color:'var(--t1)',marginBottom:16,lineHeight:1.6}}>
          Two-factor authentication adds a one-time code to your sign-in, so a stolen password isn't enough to get into your account. This is optional.
        </div>

        <div style={{display:'grid',gridTemplateColumns:'auto 1fr',gap:16,alignItems:'start',marginBottom:18}}>
          <div style={{padding:10,background:'#fff',borderRadius:8,lineHeight:0}}>
            <img src={qrDataUri} alt="Scan this QR code with your authenticator app" style={{display:'block',width:180,height:180}}/>
          </div>
          <div style={{fontSize:'.85rem',color:'var(--t1)',lineHeight:1.6}}>
            <div style={{fontWeight:700,color:'var(--t0)',marginBottom:6}}>1. Scan with your authenticator app</div>
            <div style={{color:'var(--t2)',fontSize:'.8rem',marginBottom:10}}>Google Authenticator, Authy, 1Password, Bitwarden — any TOTP app works. Open the app, tap "Add account" or the + icon, then scan the QR code on the left.</div>
            <div style={{fontSize:'.75rem',color:'var(--t3)'}}>Can't scan? <a href={otpauthUrl} style={{color:'var(--gold)',wordBreak:'break-all'}}>Tap to add manually →</a></div>
          </div>
        </div>

        <div style={{marginBottom:18,padding:14,background:'rgba(245,158,11,.05)',border:'1px solid rgba(245,158,11,.2)',borderRadius:8}}>
          <div style={{fontWeight:700,color:'var(--amber)',marginBottom:8,fontSize:'.88rem'}}>2. Save these recovery codes</div>
          <div style={{fontSize:'.8rem',color:'var(--t2)',marginBottom:10,lineHeight:1.5}}>
            If you ever lose access to your authenticator app, these one-time codes are the only way to get back in. Store them somewhere safe — a password manager works well.
          </div>
          <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:6,marginBottom:10}}>
            {recoveryCodes.map(rc=>(
              <div key={rc} style={{fontFamily:'var(--font-m)',fontSize:'.85rem',color:'var(--t0)',background:'var(--bg3)',padding:'5px 9px',borderRadius:5,letterSpacing:'.05em'}}>{rc}</div>
            ))}
          </div>
          <label style={{display:'flex',alignItems:'center',gap:8,fontSize:'.8rem',color:'var(--t1)',cursor:'pointer'}}>
            <input type="checkbox" checked={savedAck} onChange={e=>setSavedAck(e.target.checked)}/>
            I've saved my recovery codes somewhere safe.
          </label>
        </div>

        <form onSubmit={onConfirm}>
          <div className="fg">
            <label className="fl">3. Enter the 6-digit code from your app to confirm</label>
            <input
              className="fi"
              type="text"
              value={code}
              onChange={e=>setCode(e.target.value)}
              required
              inputMode="numeric"
              pattern="[0-9 ]*"
              autoComplete="one-time-code"
              placeholder="000000"
              maxLength={7}
              style={{fontFamily:'var(--font-m)',letterSpacing:'.2em',textAlign:'center'}}
            />
          </div>
          {err && <div className="alert a-warn" style={{marginBottom:12}}>{err}</div>}
          <div style={{display:'flex',gap:10}}>
            <button className="btn btn-p" type="submit" disabled={submitting||!savedAck||code.trim().length<6} style={{justifyContent:'center'}}>
              {submitting?<span className="spinner"/>:'Enable two-factor'}
            </button>
            <button type="button" className="btn btn-g" onClick={()=>navigate('/security')} disabled={submitting}>Cancel</button>
          </div>
          <div style={{marginTop:10,fontSize:'.75rem',color:'var(--t3)'}}>
            Confirm the codes are saved before continuing — they're shown only once.
          </div>
        </form>
      </div>
    </div>
  )
}

// ── SECURITY PAGE ─────────────────────────────────────────────
// S289: tenant 2FA management. Opt-in enable (routes to /security/enroll)
// and password-confirmed disable. Fully optional — no enrollment gate.
function SecurityPage() {
  const { user, refresh } = useAuth()
  const navigate = useNavigate()
  const [showConfirm, setShowConfirm] = useState(false)
  const [password, setPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [err, setErr] = useState('')
  const [success, setSuccess] = useState('')

  const onDisable=async(e:React.FormEvent)=>{
    e.preventDefault();setSubmitting(true);setErr('')
    try{
      await api.post('/auth/totp/disable',{password})
      await refresh()
      setShowConfirm(false);setPassword('')
      setSuccess('Two-factor authentication disabled.')
    }catch(ex:any){
      setErr(ex.response?.data?.error||'Could not disable 2FA. Check your password.')
    }finally{
      setSubmitting(false)
    }
  }

  return (
    <div>
      <div className="ph">
        <div><div className="pt">Security</div><div className="ps">Manage two-factor authentication</div></div>
      </div>
      <div className="card" style={{maxWidth:600,marginBottom:16}}>
        <div className="kpi-l" style={{marginBottom:14}}>Two-factor authentication</div>
        <div style={{display:'flex',alignItems:'center',gap:12,marginBottom:14}}>
          <div style={{width:36,height:36,borderRadius:8,background:user?.totpEnabled?'rgba(34,197,94,.1)':'rgba(138,150,176,.1)',display:'flex',alignItems:'center',justifyContent:'center',fontSize:'1.2rem'}}>
            {user?.totpEnabled?'✅':'🔓'}
          </div>
          <div>
            <div style={{fontWeight:700,color:'var(--t0)',fontSize:'.95rem'}}>
              {user?.totpEnabled?'Enabled':'Not enabled'}
            </div>
            <div style={{fontSize:'.8rem',color:'var(--t2)'}}>
              {user?.totpEnabled
                ?'You will be prompted for a 6-digit code on every sign-in.'
                :'Add an authenticator-app code to your sign-in for extra protection. Optional.'}
            </div>
          </div>
        </div>

        {success && <div className="alert a-green" style={{marginBottom:12}}>{success}</div>}

        {!user?.totpEnabled && (
          <button className="btn btn-p" onClick={()=>{setSuccess('');navigate('/security/enroll')}}>
            Enable two-factor
          </button>
        )}

        {user?.totpEnabled && !showConfirm && (
          <button className="btn btn-d" onClick={()=>{setShowConfirm(true);setSuccess('')}}>
            Disable two-factor
          </button>
        )}

        {user?.totpEnabled && showConfirm && (
          <form onSubmit={onDisable} style={{marginTop:8,padding:14,background:'var(--bg1)',border:'1px solid var(--b1)',borderRadius:8}}>
            <div style={{fontSize:'.82rem',color:'var(--t1)',marginBottom:10,lineHeight:1.5}}>
              Confirm your password to disable 2FA. After disable, any saved recovery codes are invalidated.
            </div>
            <div className="fg">
              <label className="fl">Password</label>
              <input className="fi" type="password" value={password} onChange={e=>setPassword(e.target.value)} autoFocus required />
            </div>
            {err && <div className="alert a-warn" style={{marginBottom:10}}>{err}</div>}
            <div style={{display:'flex',gap:8}}>
              <button type="submit" className="btn btn-d" disabled={submitting||!password} style={{justifyContent:'center'}}>
                {submitting?<span className="spinner"/>:'Disable two-factor'}
              </button>
              <button type="button" className="btn btn-g" onClick={()=>{setShowConfirm(false);setPassword('');setErr('')}} disabled={submitting}>
                Cancel
              </button>
            </div>
          </form>
        )}
      </div>

      <div style={{fontSize:'.75rem',color:'var(--t3)',maxWidth:600,lineHeight:1.5}}>
        If you lose your authenticator app, use one of your saved recovery codes to sign in, then disable and re-enable 2FA with the new app.
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
        <Route path="/forgot-password" element={<ForgotPasswordPage />} />
        <Route path="/reset-password" element={<ResetPasswordPage />} />
        <Route path="/verify-email" element={<VerifyEmailPage />} />
        <Route path="/accept-invite" element={<AcceptInvitePage />} />
        <Route path="/background-check" element={<BackgroundCheckPage />} />
        <Route path="/pos-customer-onboard/:token" element={<PosCustomerOnboardingPage />} />
        <Route path="/" element={token ? <Layout /> : <Navigate to="/login" replace />}>
          <Route index element={<DefaultPage />} />
          <Route path="notifications"    element={<TenantNotificationsPage />} />
          <Route path="home"             element={<HomePage />} />
          <Route path="payments"         element={<PaymentsPage />} />
          <Route path="maintenance"      element={<MaintenancePage />} />
          <Route path="lease"            element={<LeasePage />} />
          <Route path="sign/:documentId" element={<SignPage />} />
          <Route path="services"         element={LAUNCH_HIDDEN.has('/services') ? <Navigate to="/home" replace /> : <ServicesPage />} />
          <Route path="documents"        element={<DocumentsPage />} />
          <Route path="support"          element={<SupportPage />} />
          <Route path="utilities"        element={<UtilitiesPage />} />
          <Route path="inspections"      element={<TenantInspectionsPage />} />
          <Route path="inspections/:id"  element={<TenantInspectionDetailPage />} />
          <Route path="walkthroughs"     element={<TenantMyWalkthroughsPage />} />
          <Route path="entry-requests"      element={<TenantEntryRequestsPage />} />
          <Route path="amenities"           element={<TenantAmenitiesPage />} />
          <Route path="entry-requests/:id"  element={<TenantEntryRequestDetailPage />} />
          <Route path="credit"              element={LAUNCH_HIDDEN.has('/credit') ? <Navigate to="/home" replace /> : <CreditPage />} />
          <Route path="my-disputes"         element={LAUNCH_HIDDEN.has('/my-disputes') ? <Navigate to="/home" replace /> : <MyDisputesPage />} />
          <Route path="notification-prefs"  element={<NotificationPrefsPage />} />
          <Route path="profile"          element={<ProfilePage />} />
          <Route path="security"         element={<SecurityPage />} />
          <Route path="security/enroll"  element={<TotpEnrollPage />} />
          <Route path="payouts"          element={<PayoutsPage />} />
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
