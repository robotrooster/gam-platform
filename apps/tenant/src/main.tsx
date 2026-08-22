import { isAuthRejection, fetchAuthMeWithRetry, startVersionWatch } from '@gam/shared'
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
import { MaintenancePage } from './pages/MaintenancePage'
import { ProfilePage } from './pages/ProfilePage'
import { PayoutsPage } from './pages/PayoutsPage'
import { WorkTradePage } from './pages/WorkTradePage'
import { TenantSurveysPage } from './pages/TenantSurveysPage'
import { PosCustomerOnboardingPage } from './pages/PosCustomerOnboardingPage'
import React, { useContext, useState, useEffect, useCallback, useRef } from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter, Routes, Route, Navigate, NavLink, Outlet, useNavigate, useParams, Link, useLocation } from 'react-router-dom'
// S562: tenant nav icons — monochrome lucide (inherit currentColor via .ni:
// grayscale --t2 idle, accent/gold when active), matching the landlord portal's
// professional look. Replaces the off-brand multicolor emoji.
import {
  ShieldCheck, Home, Star, CreditCard, Wrench, ClipboardCheck,
  Video, DoorOpen, CalendarClock, HeartHandshake, BarChart3, Scale, ScrollText,
  Bell, Landmark, User, Dumbbell, MessagesSquare, FileText, ClipboardList, Sun, Moon,
} from 'lucide-react'

// S550: first-party product telemetry — one page_view per route change.
// Fire-and-forget; failures are silently ignored (never affects UX).
function TelemetryPing() {
  const location = useLocation()
  useEffect(() => {
    post('/telemetry/events', {
      events: [{ portal: 'tenant', event: 'page_view', path: location.pathname }],
    }).catch(() => {})
  }, [location.pathname])
  return null
}
import { DialogHost, toast } from './components/dialogs'
import { QueryClient, QueryClientProvider, useQuery, useMutation, useQueryClient } from 'react-query'
import { useForm } from 'react-hook-form'
import axios from 'axios'
import { formatCurrency, applyCamelizeInterceptor, installDatePickerAutoClose, humanize, INSPECTION_ITEM_CONDITION_LABEL } from '@gam/shared'
import { AgentChatWidget } from './components/AgentChatWidget'
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

// S512 LAUNCH: tenant features hidden for the initial launch — the
// credit-ledger surfaces (/credit, /my-disputes, the FlexCredit/internal-
// scoring tenant view). Nav links are filtered and routes redirect to
// /home; the pages + backend stay intact. Unhide post-launch by
// emptying this set.
// S541: /services LEFT this set — the Flex hub is now driven by the
// per-product rollout flags (GET /tenants/flex-visibility), so flipping
// e.g. flexpay_rollout_visible surfaces exactly that product.
const LAUNCH_HIDDEN = new Set<string>(['/credit', '/my-disputes'])
const LAUNCH_HIDE_FITNESS = true
api.interceptors.request.use(c => { const t = localStorage.getItem('gam_tenant_token'); if(t) c.headers.Authorization=`Bearer ${t}`; return c })
api.interceptors.response.use(r=>r, e => { if(e.response?.status===401){localStorage.removeItem('gam_tenant_token');window.location.href='/login'} return Promise.reject(e) })
// S312: snake_case → camelCase response transform (see lib/api.ts comment + packages/shared/src/camelize.ts).
applyCamelizeInterceptor(api)
const get = <T,>(url: string) => api.get<{success:boolean;data:T}>(url).then(r=>r.data.data)
const post = <T,>(url: string, body?: any) => api.post<{success:boolean;data:T;message?:string}>(url,body).then(r=>r.data)

// S541: per-product Flex rollout visibility. FlexPay's initial rollout
// is demand-test gated — the card offers "I'm interested" (inquiry)
// until GAM reviews the lease + verifies SSI/SSDI income and approves;
// only approved tenants can enroll (server-enforced).
function useFlexVisibility() {
  const { data } = useQuery('flex-visibility',
    () => get<{ flexpay: boolean; flexdeposit: boolean; flexcredit: boolean }>('/tenants/flex-visibility'),
    { staleTime: 5 * 60 * 1000, retry: false })
  const v = data ?? { flexpay: false, flexdeposit: false, flexcredit: false }
  return { ...v, any: v.flexpay || v.flexdeposit || v.flexcredit }
}

// ── AUTH ──────────────────────────────────────────────────────
// S289: optional 2FA. Tenant is NOT in MANDATORY_TOTP_ROLES, so
// mustEnrollTotp is always false here — no enrollment gate, no nag.
// totpEnabled reflects whether the tenant opted in via the Security
// page; when true, login gates on the TOTP second step.
interface AuthUser { id:string;email:string;role:string;firstName:string;lastName:string;profileId:string;totpEnabled?:boolean;mustEnrollTotp?:boolean }
// S289: login() returns a discriminated result so LoginPage can branch
// into the TOTP second step when the backend gates on 2FA.
type LoginResult = { kind:'success' } | { kind:'totp_required'; totpSession:string } | { kind:'email_otp_required'; emailOtpSession:string }
type SignupInput = { firstName:string;lastName:string;email:string;password:string;acceptedTerms:boolean;landlordId?:string|null;unitId?:string|null }
interface AuthCtx { user:AuthUser|null;token:string|null;loading:boolean;login:(e:string,p:string)=>Promise<LoginResult>;signup:(input:SignupInput)=>Promise<{emailOtpSession:string}>;loginWithTotp:(totpSession:string,code:string)=>Promise<void>;loginWithEmailOtp:(emailOtpSession:string,code:string)=>Promise<void>;resendEmailOtp:(emailOtpSession:string)=>Promise<void>;refresh:()=>Promise<void>;logout:()=>void }
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
    try{ const u = await fetchAuthMeWithRetry(() => get<AuthUser>('/auth/me')); setUser(u) }
    catch(e){ if (isAuthRejection(e)) logout() }  // S540: transient failures keep the token
    finally{ setLoading(false) }
  },[logout])
  useEffect(()=>{
    if(!token){setLoading(false);return}
    fetchAuthMeWithRetry(() => get<AuthUser>('/auth/me')).then(u=>setUser(u)).catch(e=>{ if (isAuthRejection(e)) logout() }).finally(()=>setLoading(false))
  },[token,logout])
  // S289: post-credentials login. Returns a discriminated result so
  // LoginPage can pivot into the TOTP second step when 2FA is enabled
  // on the account. Doesn't set user state until the full JWT lands —
  // a totp_session JWT is not a valid auth token.
  const login = async(email:string,password:string):Promise<LoginResult>=>{
    const res=await post<any>('/auth/login',{email,password})
    const data=res.data!
    if(data.requiresTotp){ return { kind:'totp_required', totpSession:data.totpSession as string } }
    // S571: tenants with ACH set up get email-code 2FA (like admin).
    if(data.requiresEmailOtp){ return { kind:'email_otp_required', emailOtpSession:data.emailOtpSession as string } }
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
  // S571: email-code 2FA exchange — trade the pending session + emailed code
  // for the full session JWT. Mirrors loginWithTotp.
  const loginWithEmailOtp = async(emailOtpSession:string,code:string):Promise<void>=>{
    const res=await post<{token:string}>('/auth/email-otp/verify',{emailOtpSession,code})
    const tk=res.data!.token
    localStorage.setItem('gam_tenant_token',tk)
    api.defaults.headers.common['Authorization']='Bearer '+tk
    const u=await get<AuthUser>('/auth/me')
    setUser(u);setToken(tk)
  }
  const resendEmailOtp = async(emailOtpSession:string):Promise<void>=>{
    await post('/auth/email-otp/resend',{emailOtpSession})
  }
  // S578: prospect self-signup. Account is created FIRST (its own page), with
  // mandatory email-2FA — register-prospect returns a PENDING session, never a
  // full token. The SignupPage completes verification via loginWithEmailOtp,
  // exactly like the login 2FA step, then lands in the gated portal.
  const signup = async(input:SignupInput):Promise<{emailOtpSession:string}>=>{
    const res=await post<any>('/auth/register-prospect',input)
    return { emailOtpSession: res.data!.emailOtpSession as string }
  }
  return <Ctx.Provider value={{user,token,loading,login,signup,loginWithTotp,loginWithEmailOtp,resendEmailOtp,refresh,logout}}>{children}</Ctx.Provider>
}

// ── STYLES ────────────────────────────────────────────────────
const css = `
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{--bg0:#0a0b0e;--bg1:#0f1116;--bg2:#141720;--bg3:#1a1f2e;--bg4:#212636;
  --b0:#1e2435;--b1:#252d42;--b2:#2f3a55;
  --t0:#f0f2f7;--t1:#c4ccde;--t2:#8a96b0;--t3:#555f7a;
  --gold:#c9a227;--green:#22c55e;--red:#ef4444;--amber:#f59e0b;--blue:#3b82f6;
  /* S562: long-form token aliases — newer feature pages (LeasePage, SignPage,
     dialogs) reference the text / border / bg tokens by their long names, which
     were never defined, so those surfaces rendered with browser-default
     (invisible) colors. Map them to the canonical short tokens. Same fix class
     as .inp (S544). */
  --text-0:var(--t0);--text-1:var(--t1);--text-2:var(--t2);--text-3:var(--t3);
  --border-0:var(--b0);--border-1:var(--b1);
  --bg-0:var(--bg0);--bg-1:var(--bg1);--bg-2:var(--bg2);--bg-3:var(--bg3);
  --font-d:'Syne',sans-serif;--font-b:'DM Sans',sans-serif;--font-m:'DM Mono',monospace}
html{-webkit-font-smoothing:antialiased;height:100%}
body{font-family:var(--font-b);background:var(--bg0);color:var(--t1);line-height:1.6;height:100%;margin:0;overflow:hidden;overscroll-behavior:none}
h1,h2,h3{font-family:var(--font-d);color:var(--t0);line-height:1.2}
h1{font-size:1.8rem;font-weight:800}h2{font-size:1.3rem;font-weight:700}h3{font-size:1.1rem;font-weight:700}
a{color:var(--gold);text-decoration:none}
button{cursor:pointer;font-family:var(--font-b)}
input,select,textarea{font-family:var(--font-b)}
.shell{display:flex;height:100vh;overflow:hidden}
.sidebar{width:220px;flex-shrink:0;background:var(--bg1);border-right:1px solid var(--b0);display:flex;flex-direction:column;position:fixed;top:0;left:0;bottom:0;z-index:50}
.main{flex:1;margin-left:220px;height:100vh;display:flex;flex-direction:column;min-width:0;overflow:hidden}
.topbar{height:52px;background:var(--bg1);border-bottom:1px solid var(--b0);display:flex;align-items:center;padding:0 24px;position:sticky;top:0;z-index:40;flex-shrink:0}
.page{flex:1;min-height:0;padding:28px;max-width:1200px;width:100%;overflow-y:auto;overflow-x:hidden;overscroll-behavior:none}
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
.grid4{display:grid;grid-template-columns:repeat(4,1fr);gap:16px}
@media(max-width:1100px){.grid4{grid-template-columns:1fr 1fr}}
@media(max-width:600px){.grid4{grid-template-columns:1fr}}
@media(max-width:900px){.grid2,.grid3{grid-template-columns:1fr}}
.ph{display:flex;align-items:center;justify-content:space-between;margin-bottom:24px;padding-bottom:16px;border-bottom:1px solid var(--b0)}
.pt{font-family:var(--font-d);font-size:1.5rem;font-weight:800;color:var(--t0)}
.ps{font-size:.82rem;color:var(--t3);margin-top:2px}
.kpi{background:var(--bg2);border:1px solid var(--b1);border-radius:12px;padding:20px}
.kpi-l{font-size:.7rem;color:var(--t3);text-transform:uppercase;letter-spacing:.08em;font-weight:600;margin-bottom:8px}
.kpi-v{font-family:var(--font-d);font-size:1.6rem;font-weight:800;color:var(--t0);line-height:1;margin-bottom:4px}
.kpi-s{font-size:.72rem;color:var(--t3)}
.btn{display:inline-flex;align-items:center;gap:7px;padding:8px 16px;border-radius:8px;font-size:.82rem;font-weight:600;border:none;cursor:pointer;transition:all .15s;font-family:var(--font-b);text-decoration:none}
.btn-p,.btn-primary{background:var(--gold);color:#0a0b0e}.btn-p:hover,.btn-primary:hover{background:#d9af3a}
.btn-g,.btn-ghost{background:var(--bg4);color:var(--t1);border:1px solid var(--b2)}.btn-g:hover,.btn-ghost:hover{background:var(--bg3);color:var(--t0)}
.btn-link{background:none;border:none;color:var(--gold);padding:0;font-weight:600;text-decoration:underline;font-size:.82rem}
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
.a-red{background:rgba(239,68,68,.08);border:1px solid rgba(239,68,68,.2);color:#fca5a5}
.a-warn{background:rgba(245,158,11,.08);border:1px solid rgba(245,158,11,.2);color:#fcd34d}
.a-blue{background:rgba(59,130,246,.08);border:1px solid rgba(59,130,246,.2);color:#93c5fd}
.modal-ov,.modal-overlay{position:fixed;inset:0;background:rgba(0,0,0,.75);display:flex;align-items:center;justify-content:center;z-index:100;padding:20px;backdrop-filter:blur(4px)}
.modal{background:var(--bg2);border:1px solid var(--b2);border-radius:16px;padding:24px;width:100%;max-width:500px;max-height:90vh;overflow-y:auto;box-shadow:0 8px 32px rgba(0,0,0,.5)}
.modal-t,.modal-title{font-family:var(--font-d);font-size:1.1rem;font-weight:800;color:var(--t0);margin-bottom:20px}
.modal-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:20px}
.modal-f{display:flex;justify-content:flex-end;gap:10px;margin-top:20px;padding-top:16px;border-top:1px solid var(--b0)}
.fg{margin-bottom:16px}
.fl{display:block;font-size:.75rem;font-weight:600;color:var(--t2);margin-bottom:6px;text-transform:uppercase;letter-spacing:.05em}
/* S544: .inp was used in 5 places but never defined — fields rendered
   browser-default white on the dark theme. */
.inp,.input,.form-input{width:100%;background:var(--bg3);border:1px solid var(--b1);border-radius:8px;color:var(--t0);padding:10px 12px;font-size:.9rem;color-scheme:dark}
.inp:focus,.input:focus,.form-input:focus{outline:none;border-color:var(--gold)}
textarea.inp{resize:vertical}
/* S595: same drift as .inp (S544) — className="input" fields were never aliased,
   so they fell back to white browser boxes. Alias + uniform +6% type lift +
   readable disabled (overrides the blanket :disabled{opacity:.4} so disabled
   field VALUES stay legible instead of washing out). */
html{font-size:17px}
.inp:disabled,.input:disabled,.form-input:disabled,.fi:disabled,.fs:disabled,.fta:disabled,input:disabled,select:disabled,textarea:disabled,input[readonly],textarea[readonly]{background:var(--bg2);border-color:var(--b0);color:var(--t1);-webkit-text-fill-color:var(--t1);opacity:1;cursor:not-allowed}
/* S595 LIGHT THEME (short token names; hyphenated aliases map to these so both flip). */
:root[data-theme="light"]{color-scheme:light;--bg0:#f4f5f7;--bg1:#ffffff;--bg2:#ffffff;--bg3:#eef0f4;--bg4:#e5e8ee;--b0:#e7e9ef;--b1:#dde0e8;--b2:#ccd2de;--t0:#12151c;--t1:#333b49;--t2:#5b6474;--t3:#8a93a5;--gold-ink:#7a5f0f}
:root[data-theme="light"] .inp,:root[data-theme="light"] .input,:root[data-theme="light"] .form-input,:root[data-theme="light"] .fi,:root[data-theme="light"] .fs,:root[data-theme="light"] .fta{color-scheme:light}
:root[data-theme="light"] a,:root[data-theme="light"] .logo-name{color:var(--gold-ink)}
:root[data-theme="light"] .ni.active{color:var(--gold-ink);background:rgba(201,162,39,.12);border-color:rgba(201,162,39,.32)}
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
    ? <NavLink to={'/sign/'+pendingDocId} className={({isActive})=>`ni${isActive?' active':''}`}><ScrollText size={16}/>Lease</NavLink>
    : <NavLink to="/lease" className={({isActive})=>`ni${isActive?' active':''}`}><ScrollText size={16}/>Lease</NavLink>
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

// S571 (Nic): Maintenance, Inspections, Entry Requests, and My Walkthroughs all
// deal with communicating with the landlord, so they live inside ONE
// "Communication" dashboard as sub-tabs — the same pattern as the Profile page,
// NOT a sidebar dropdown. The standalone routes still exist for deep links.
const COMMUNICATION_TABS = [
  { id: 'maintenance',  label: 'Maintenance',    icon: Wrench },
  { id: 'inspections',  label: 'Inspections',    icon: ClipboardCheck },
  { id: 'entry',        label: 'Entry Requests', icon: DoorOpen },
  { id: 'surveys',      label: 'Surveys',        icon: ClipboardList },
  { id: 'documents',    label: 'Documents',      icon: FileText },
  { id: 'walkthroughs', label: 'My Walkthroughs', icon: Video },
] as const
type CommTab = typeof COMMUNICATION_TABS[number]['id']

function CommunicationPage() {
  const location = useLocation()
  const initial = new URLSearchParams(location.search).get('tab') as CommTab | null
  const [tab, setTab] = useState<CommTab>(
    initial && COMMUNICATION_TABS.some(t => t.id === initial) ? initial : 'maintenance'
  )
  return (
    <div>
      <div style={{ marginBottom: 20 }}>
        <h1 style={{ fontFamily: 'var(--font-d)', fontSize: '1.4rem', fontWeight: 800, color: 'var(--t0)', marginBottom: 4 }}>Communication</h1>
        <p style={{ fontSize: '.82rem', color: 'var(--t3)' }}>Everything between you and your landlord — requests, inspections, and entry notices.</p>
      </div>
      <div style={{ display: 'flex', gap: 6, marginBottom: 20, borderBottom: '1px solid var(--b0)', paddingBottom: 12, flexWrap: 'wrap' }}>
        {COMMUNICATION_TABS.map(t => {
          const Icon = t.icon
          const on = tab === t.id
          return (
            <button key={t.id} onClick={() => setTab(t.id)}
              style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '8px 14px', borderRadius: 8, cursor: 'pointer', fontSize: '.82rem', fontWeight: 600,
                background: on ? 'var(--gold)' : 'var(--bg2)', color: on ? 'var(--bg0)' : 'var(--t2)', border: 'none' }}>
              <Icon size={15} />{t.label}
            </button>
          )
        })}
      </div>
      {tab === 'maintenance'  && <MaintenancePage />}
      {tab === 'inspections'  && <TenantInspectionsPage />}
      {tab === 'entry'        && <TenantEntryRequestsPage />}
      {tab === 'surveys'      && <TenantSurveysPage />}
      {tab === 'documents'    && <DocumentsPage />}
      {tab === 'walkthroughs' && <TenantMyWalkthroughsPage />}
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
  // S595: per-device light/dark toggle (initial value applied pre-paint by index.html).
  const [theme, setTheme] = useState<'dark' | 'light'>(() => document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark')
  const toggleTheme = () => { const n = theme === 'dark' ? 'light' : 'dark'; document.documentElement.setAttribute('data-theme', n); try { localStorage.setItem('gam_theme', n) } catch {}; setTheme(n) }
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
  // S615 (Nic): a UTILITY-SERVICE payer — the space next door on this
  // landlord's trash or power. They have no lease, so unitId is null and
  // bgApproved is false, which meant the ONLY thing they could see after
  // logging in was the Application tab: a background check they have no reason
  // to take, for a tenancy that does not exist. They are here to look at a
  // utility bill and pay it.
  const isUtilityServicePayer = !!(tenantMe as any)?.utilityServiceAgreementId
  const showFullNav = bgApproved || isExistingTenant || isUtilityServicePayer
  // …and only what applies to them. Someone who buys electricity from this
  // landlord has no lease to read, no maintenance to request, no amenities to
  // reserve and no deposit — a nav full of doors that open onto nothing is its
  // own kind of broken. Home + Payments + Profile is the whole surface.
  const serviceOnly = isUtilityServicePayer && !isExistingTenant
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
  const flexVis = useFlexVisibility()
  // Conditional nav (Nic): Work Trade only appears once the tenant is actually
  // in a work-trade agreement; Amenities only when their property has something
  // reservable. Otherwise these are dead/empty tabs.
  const { data: workTradeNav } = useQuery('work-trade-nav', () =>
    fetch((import.meta as any).env?.VITE_API_URL + '/api/tenants/work-trade', {
      headers: { Authorization: 'Bearer ' + localStorage.getItem('gam_tenant_token') }
    }).then(r=>r.json()).then(r=>r.data), { staleTime: 60000 })
  const hasWorkTrade = Array.isArray(workTradeNav) ? workTradeNav.length > 0 : !!workTradeNav
  const { data: amenityNav } = useQuery('amenity-nav', () =>
    fetch((import.meta as any).env?.VITE_API_URL + '/api/common-areas/mine', {
      headers: { Authorization: 'Bearer ' + localStorage.getItem('gam_tenant_token') }
    }).then(r=>r.json()).then(r=>r.data), { staleTime: 60000 })
  const hasAmenities = Array.isArray(amenityNav) && amenityNav.length > 0
  // S571: My Walkthroughs is now a permanent tab inside the Communication
  // dashboard (its own empty state covers the no-videos case), so the old
  // conditional top-level nav link + its probe query were removed.
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
            <NavLink to="/background-check" className={({isActive})=>`ni${isActive?' active':''}`}><ShieldCheck size={16}/>Application</NavLink>
          )}
          {serviceOnly && <>
            <NavLink to="/home" className={({isActive})=>`ni${isActive?' active':''}`}><Home size={16}/>Home</NavLink>
            <NavLink to="/payments" className={({isActive})=>`ni${isActive?' active':''}`}><CreditCard size={16}/>Billing</NavLink>
            <NavLink to="/profile" className={({isActive})=>`ni${isActive?' active':''}`}><User size={16}/>Profile</NavLink>
          </>}
          {showFullNav && !serviceOnly && <>
            <NavLink to="/home" className={({isActive})=>`ni${isActive?' active':''}`}><Home size={16}/>Home</NavLink>
            {flexVis.any && <NavLink to="/services" className={({isActive})=>`ni${isActive?' active':''}`}><Star size={16}/>Flex Advantage</NavLink>}
            <NavLink to="/payments" className={({isActive})=>`ni${isActive?' active':''}`}><CreditCard size={16}/>Payments</NavLink>
            {/* Support tab removed (Nic) — the chatbot floats on every screen via
                AgentChatWidget, so a dedicated Support page/tab is redundant. */}
            {/* S571 (Nic): Maintenance + Inspections + Entry Requests + My
                Walkthroughs live inside the Communication dashboard (tabbed page,
                same pattern as Profile) — all landlord-communication surfaces. */}
            <NavLink to="/communication" className={({isActive})=>`ni${isActive?' active':''}`}><MessagesSquare size={16}/>Communication</NavLink>
            {hasAmenities && <NavLink to="/amenities" className={({isActive})=>`ni${isActive?' active':''}`}><CalendarClock size={16}/>Amenities</NavLink>}
            {hasWorkTrade && <NavLink to="/work-trade" className={({isActive})=>`ni${isActive?' active':''}`}><HeartHandshake size={16}/>Work Trade</NavLink>}
            {!LAUNCH_HIDDEN.has('/credit') && <NavLink to="/credit" className={({isActive})=>`ni${isActive?' active':''}`}><BarChart3 size={16}/>My Record</NavLink>}
            {!LAUNCH_HIDDEN.has('/my-disputes') && <NavLink to="/my-disputes" className={({isActive})=>`ni${isActive?' active':''}`}><Scale size={16}/>My Disputes</NavLink>}
            <LeaseNavLink/>
          </>}
          {/* S570 (Nic): Preferences + Security folded into Profile (which already
              has Notification-prefs + Security tabs). Notifications feed → Home. */}
          {showFullNav && !serviceOnly && tenantMe?.stripeConnectAccountId && (
            <NavLink to="/payouts" className={({isActive})=>`ni${isActive?' active':''}`}><Landmark size={16}/>Payouts</NavLink>
          )}
          {showFullNav && !serviceOnly && <NavLink to="/profile" className={({isActive})=>`ni${isActive?' active':''}`}><User size={16}/>Profile</NavLink>}
          {/* GAM Fitness — standalone app (:3013). Hand off the portal's JWT
              via ?sso= so the tenant lands signed-in without re-auth. */}
          {!LAUNCH_HIDE_FITNESS && !serviceOnly && (
          <a className="ni" href="#" onClick={e=>{e.preventDefault();const t=localStorage.getItem('gam_tenant_token')||'';const base=(import.meta as any).env?.VITE_FITNESS_URL||'http://localhost:3013';window.open(`${base}/?sso=${encodeURIComponent(t)}`,'_blank')}}><Dumbbell size={16}/>Fitness</a>
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
        <header className="topbar">
          <button onClick={toggleTheme} title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'} aria-label="Toggle light/dark theme" style={{ marginLeft: 'auto', background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--t2)', padding: 6, display: 'inline-flex', alignItems: 'center', borderRadius: 6 }}>
            {theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
          </button>
        </header>
        <div className="page">{moveInLocked ? <MoveInLockout gate={moveInGate} /> : <Outlet />}</div>
        <DialogHost />
      </div>
      {showFullNav && !serviceOnly && <FlexsuiteReAcceptanceGate />}
      {showFullNav && !serviceOnly && <LeaseNoticeGate />}
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

// ── S542: platform-originated questionnaire (LANDLORD-INVISIBLE) ────
// Private product-fit ask from GAM. Copy per trigger; a positive
// answer (SSI/SSDI + interested) auto-files a FlexPay request into
// the S541 admin review queue.
const QUESTIONNAIRE_COPY: Record<string, { title: string; intro: string; q1: string; q2: string }> = {
  late_fee_fixed_income: {
    title: 'A private question about your recent late fee',
    intro: 'This comes from GAM, not your landlord — your landlord can’t see this or your answers. You were recently charged a late fee. If your money arrives on a fixed day each month, we may be able to keep that from happening again.',
    q1: 'Does your income arrive on a fixed day each month?',
    q2: 'Would you like rent to come out AFTER your money arrives, so late fees stop?',
  },
  ssi_ssdi_signal: {
    title: 'A private question about your rent timing',
    intro: 'This comes from GAM, not your landlord — they can’t see this or your answers. If your income comes from SSI or SSDI, our FlexPay service can pull rent on the day your deposit lands instead of the 1st.',
    q1: 'Which applies to you?',
    q2: 'Want us to review your account for FlexPay?',
  },
}
const Q_INCOME_OPTIONS: { v: 'ssi'|'ssdi'|'other_fixed'|'none'; label: string }[] = [
  { v: 'ssi', label: 'SSI' }, { v: 'ssdi', label: 'SSDI' },
  { v: 'other_fixed', label: 'Other fixed day' }, { v: 'none', label: 'No / Neither' },
]

/**
 * S613 (Nic): the tenant's propane detail — "the price per gallon they're
 * charged, the delivery date, the amount total of the fill, and how it was split
 * into two or four payments... and then also have in that window the settings
 * that the landlord has set for the property about the split, so they know what
 * to be expecting if they get another fill."
 *
 * The split rules are the part a tenant could never work out on their own. Why
 * 190 gallons became four payments and 60 became two is a property setting they
 * have no other window onto, and not showing it is how a fill feels arbitrary.
 */
function PropaneLedgerModal({ data, onClose }: { data: any; onClose: () => void }) {
  const r = data.splitRules
  return (
    <div className="modal-ov" onClick={onClose}>
      <div className="modal" style={{ maxWidth: 620, maxHeight: '85vh', overflowY: 'auto' }} onClick={e => e.stopPropagation()}>
        <div className="modal-t">Your propane</div>
        <div style={{ fontSize: '.85rem', color: 'var(--t2)', marginBottom: 16, lineHeight: 1.6 }}>
          {data.balance > 0
            ? <>You still owe <strong style={{ color: 'var(--gold)' }}>{formatCurrency(data.balance)}</strong> across
                {' '}{data.totalCount - data.paidCount} remaining payment{data.totalCount - data.paidCount === 1 ? '' : 's'}.
                They ride your monthly invoice — nothing is charged at the time of a delivery.</>
            : <>Nothing outstanding. Propane is billed on your monthly invoice after a delivery, never at the time of the fill.</>}
        </div>

        {data.fills.map((f: any) => (
          <div key={f.id} style={{ border: '1px solid var(--b1)', borderRadius: 10, padding: 12, marginBottom: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', flexWrap: 'wrap', gap: 8 }}>
              <strong style={{ fontSize: '.92rem' }}>{Number(f.gallons)} gallons</strong>
              <span style={{ fontSize: '.78rem', color: 'var(--t3)' }}>
                delivered {String(f.fillDate).slice(0, 10)}
              </span>
            </div>
            <div style={{ fontSize: '.78rem', color: 'var(--t3)', marginTop: 4, lineHeight: 1.7 }}>
              {Number(f.gallons)} gal × {formatCurrency(f.pricePerGallon)}/gal
              {Number(f.taxAmount) > 0 && <> · tax {formatCurrency(f.taxAmount)}</>}
              {Number(f.deliveryFeeShare) > 0 && <> · delivery charge {formatCurrency(f.deliveryFeeShare)}</>}
              {' '}= <strong style={{ color: 'var(--t1)' }}>{formatCurrency(f.totalAmount)}</strong>
              {f.installmentCount > 1 && <>, split into {f.installmentCount} payments</>}
            </div>
            <div style={{ marginTop: 8 }}>
              {f.installments.map((i: any) => (
                <div key={i.installmentNumber} style={{ display: 'flex', justifyContent: 'space-between',
                                                          fontSize: '.78rem', padding: '3px 0' }}>
                  <span style={{ color: 'var(--t3)' }}>
                    {i.paid ? '✓' : '○'} Payment {i.installmentNumber} of {f.installmentCount}
                    {i.gallons != null && <> · {Number(i.gallons)} gal</>}
                    {' '}· {String(i.billingCycleMonth).slice(0, 7)}
                  </span>
                  <span className="mono" style={{ color: i.paid ? 'var(--t3)' : 'var(--t0)' }}>
                    {formatCurrency(i.amount)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        ))}

        {r && (
          <div style={{ fontSize: '.78rem', color: 'var(--t3)', lineHeight: 1.7, borderTop: '1px solid var(--b1)', paddingTop: 12 }}>
            <strong style={{ color: 'var(--t2)' }}>How your park splits a fill</strong><br />
            {r.allowInstallments ? (
              <>A fill of at least {r.twoPaymentMinGallons} gallons can be split into 2 payments, and
                {' '}{r.fourPaymentMinGallons} gallons or more into 4. Smaller fills are billed on one invoice.
                {' '}Each payment is a share of the GALLONS, so you can check it against your own tank.</>
            ) : (
              <>Your park bills a fill on the next invoice in one payment.</>
            )}
            {r.propertyPricePerGallon != null && (
              <><br />Current price per gallon here: {formatCurrency(r.propertyPricePerGallon)} — a delivery is
                priced at what the supplier charged that day, so it can differ.</>
            )}
          </div>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}>
          <button className="btn" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  )
}

function QuestionnairePrompt() {
  const qc = useQueryClient()
  const { data: pending = [] } = useQuery<any[]>('tenant-questionnaires',
    () => get<any[]>('/tenants/questionnaires'))
  const [open, setOpen] = useState(false)
  const [income, setIncome] = useState<'ssi'|'ssdi'|'other_fixed'|'none'|null>(null)
  const [interested, setInterested] = useState<boolean|null>(null)
  const [schedule, setSchedule] = useState<string|null>(null)
  const [benefitDay, setBenefitDay] = useState<number>(3)
  const [done, setDone] = useState<null | { inquiryFiled: boolean }>(null)
  const [error, setError] = useState<string|null>(null)
  const q = pending[0]
  const refetch = () => qc.invalidateQueries('tenant-questionnaires')

  const answerMut = useMutation(
    () => post(`/tenants/questionnaires/${q.id}/answer`,
      // S545b: pattern-based schedule fields per income type.
      { incomeSource: income, interested, ...scheduleSubmission(income ?? 'none', schedule, benefitDay) }),
    { onSuccess: (r: any) => setDone({ inquiryFiled: !!r?.data?.inquiryFiled }),
      onError: (e: any) => setError(e?.response?.data?.error || 'Something went wrong.') })
  const dismissMut = useMutation(
    () => post(`/tenants/questionnaires/${q.id}/dismiss`),
    { onSuccess: refetch })

  if (!q) return null
  const copy = QUESTIONNAIRE_COPY[q.triggerType] ?? QUESTIONNAIRE_COPY.ssi_ssdi_signal // wire-ok: local copy map keyed by trigger id, not an API response
  return (
    <>
      <div className="card" style={{marginBottom:24, border:'1px solid var(--gold)', background:'rgba(201,162,39,.05)'}}>
        <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',gap:12,flexWrap:'wrap'}}>
          <div>
            <div style={{fontWeight:700,color:'var(--t0)'}}>🔒 {copy.title}</div>
            <div style={{fontSize:'.78rem',color:'var(--t2)',marginTop:4}}>Two quick questions from GAM. Private — your landlord never sees this.</div>
          </div>
          <div style={{display:'flex',gap:8}}>
            <button className="btn btn-g btn-sm" onClick={()=>dismissMut.mutate()}>No thanks</button>
            <button className="btn btn-p btn-sm" onClick={()=>setOpen(true)}>Answer</button>
          </div>
        </div>
      </div>
      {open && (
        <div className="modal-ov" onClick={()=>{ if(done) refetch(); setOpen(false) }}>
          <div className="modal" onClick={e=>e.stopPropagation()} style={{maxWidth:500}}>
            {done ? (
              <>
                <div className="modal-t">✓ Thanks — that helps</div>
                <p style={{fontSize:'.82rem',color:'var(--t2)',marginBottom:16}}>
                  {done.inquiryFiled
                    // S544: no-promise phrasing — valid in survey mode and
                    // after launch alike. No signup implied, no timeline.
                    ? 'Thanks — we’ve recorded your interest in FlexPay. When it’s available for your account, we’ll let you know. We may ask for proof of income source (like an award letter) at that point, only where permitted.'
                    : 'Your answers are saved. Nothing else is needed from you.'}
                </p>
                <div style={{display:'flex',justifyContent:'flex-end'}}>
                  <button className="btn btn-p" onClick={()=>{ refetch(); setOpen(false) }}>Done</button>
                </div>
              </>
            ) : (
              <>
                <div className="modal-t">🔒 {copy.title}</div>
                <p style={{fontSize:'.8rem',color:'var(--t2)',marginBottom:16}}>{copy.intro}</p>
                <div className="fg">
                  <label className="fl">{copy.q1}</label>
                  <div style={{display:'flex',gap:8,flexWrap:'wrap'}}>
                    {Q_INCOME_OPTIONS.map(o => (
                      <button key={o.v} type="button" className={`btn btn-sm ${income===o.v?'btn-p':'btn-g'}`}
                        onClick={()=>setIncome(o.v)}>{o.label}</button>
                    ))}
                  </div>
                </div>
                {income && (
                  <BenefitScheduleFields income={income} schedule={schedule} setSchedule={setSchedule} day={benefitDay} setDay={setBenefitDay} />
                )}
                <div className="fg" style={{marginTop:14}}>
                  <label className="fl">{copy.q2}</label>
                  <div style={{display:'flex',gap:8}}>
                    <button type="button" className={`btn btn-sm ${interested===true?'btn-p':'btn-g'}`} onClick={()=>setInterested(true)}>Yes, I’m interested</button>
                    <button type="button" className={`btn btn-sm ${interested===false?'btn-p':'btn-g'}`} onClick={()=>setInterested(false)}>No thanks</button>
                  </div>
                </div>
                {error && <div className="alert a-warn" style={{marginTop:12}}>{error}</div>}
                <div style={{display:'flex',justifyContent:'flex-end',gap:10,marginTop:18}}>
                  <button className="btn btn-g" onClick={()=>setOpen(false)}>Later</button>
                  <button className="btn btn-p" disabled={income===null||interested===null||!scheduleReady(income ?? 'none', schedule)||answerMut.isLoading}
                    onClick={()=>answerMut.mutate()}>
                    {answerMut.isLoading ? <span className="spinner"/> : 'Submit'}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </>
  )
}

// S570 (Nic): the Notifications tab was removed — surface unread notifications
// (vacancy/pool matches, with their respond actions) at the TOP of Home instead.
// Renders nothing when there's nothing to act on.
function HomeAlerts() {
  const qc = useQueryClient()
  const { data: notifs = [] } = useQuery<any[]>('tenant-notifs-home', () =>
    get<any[]>('/background/notifications').then((r: any) => Array.isArray(r) ? r : []))
  const readMut = useMutation((id: string) => api.patch('/background/notifications/' + id + '/read'),
    { onSuccess: () => qc.invalidateQueries('tenant-notifs-home') })
  const respondMut = useMutation(
    ({ matchId, interested }: { matchId: string; interested: boolean }) =>
      api.patch('/background/pool/match/' + matchId + '/respond', { interested }),
    { onSuccess: () => qc.invalidateQueries('tenant-notifs-home') })
  const unread = (notifs as any[]).filter(n => !n.read)
  if (!unread.length) return null
  return (
    <div className="card" style={{ marginBottom: 16, borderColor: 'rgba(201,162,39,.3)' }}>
      <div style={{ fontWeight: 700, color: 'var(--gold)', fontSize: '.8rem', marginBottom: 10, display: 'flex', alignItems: 'center', gap: 8 }}>
        <Bell size={15} /> Needs your attention
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {unread.map((n: any) => {
          let data: any = {}
          try { data = typeof n.data === 'string' ? JSON.parse(n.data || '{}') : n.data || {} } catch { data = {} }
          const isMatch = n.type === 'match_interest'
          return (
            <div key={n.id} onClick={() => readMut.mutate(n.id)}
              style={{ padding: '10px 12px', borderRadius: 8, background: 'rgba(201,162,39,.05)', border: '1px solid rgba(201,162,39,.18)', cursor: 'pointer' }}>
              <div style={{ fontWeight: 700, fontSize: '.82rem', color: 'var(--t0)', marginBottom: 3 }}>{n.title}</div>
              <div style={{ fontSize: '.76rem', color: 'var(--t2)', lineHeight: 1.5 }}>{n.body}</div>
              {isMatch && !data.responded && data.matchRequestId && (
                <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                  <button className="btn btn-p btn-sm" onClick={e => { e.stopPropagation(); respondMut.mutate({ matchId: data.matchRequestId, interested: true }) }}>Interested</button>
                  <button className="btn btn-g btn-sm" onClick={e => { e.stopPropagation(); respondMut.mutate({ matchId: data.matchRequestId, interested: false }) }}>Not interested</button>
                </div>
              )}
              {data.responded && <div style={{ fontSize: '.72rem', color: 'var(--green)', marginTop: 4 }}>✓ Response sent</div>}
            </div>
          )
        })}
      </div>
    </div>
  )
}

/**
 * S615 — the home page for someone who buys utilities from this landlord and
 * does not rent from them.
 *
 * Nic: "That person should really have access to the tenant portal to get on
 * and pay their bill. Otherwise the landlord has to bother to take cash from
 * the other property."
 *
 * Everything the normal home page shows — rent, deposit, unit status, lease
 * notices, Flex — resolves through an active lease and is NULL here. Rather
 * than render that page full of dashes, this shows the balance and the bills
 * behind it, and says plainly what the arrangement is.
 */
/**
 * S616 (Nic) — the neighbour tells us they are leaving.
 *
 *   "Maybe that tenant portal profile that only has the utilities gets a big
 *    button that says 'hey, I need my final bill because I'm moving out', and
 *    then it's gonna look for more utilities to go onto a new person after that
 *    final billing period."
 *
 * Nobody is watching the neighbour's front door. This person is the only one
 * who reliably knows, so it is their button. It gives NOTICE — the landlord
 * still takes the closing read and sets up whoever moves in. Letting a payer
 * close their own account would let somebody walk away from a balance.
 */
function MoveOutNotice({ me }: { me: any }) {
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const [expectedOn, setExpectedOn] = useState('')
  const [note, setNote] = useState('')
  const [error, setError] = useState('')

  const give = useMutation(
    () => post('/utility/service-agreements/mine/moveout-notice', { expectedOn, note: note.trim() || undefined }),
    {
      onSuccess: () => { setOpen(false); qc.invalidateQueries('tenant-me') },
      onError: (e: any) => setError(e?.response?.data?.error || 'Could not send that'),
    },
  )

  if (me.moveoutNoticeAt) {
    return (
      <div className="card" style={{marginBottom:16, borderLeft:'3px solid var(--gold)'}}>
        <div style={{fontWeight:700, color:'var(--t0)', marginBottom:4}}>Final bill requested</div>
        <div style={{fontSize:'.84rem', color:'var(--t2)', lineHeight:1.6}}>
          We&apos;ve told {me.utilityServicePropertyName || 'your provider'} you expect to be out by{' '}
          <strong>{me.moveoutExpectedOn}</strong>. They&apos;ll take a final meter reading around then and
          send your last bill. Keep paying as normal until it arrives.
        </div>
      </div>
    )
  }

  return (
    <div className="card" style={{marginBottom:16}}>
      {!open ? (
        <div style={{display:'flex', alignItems:'center', justifyContent:'space-between', gap:12, flexWrap:'wrap'}}>
          <div style={{fontSize:'.84rem', color:'var(--t2)', lineHeight:1.6}}>
            Moving out? Ask for your final bill so the meter stops billing you after you go.
          </div>
          <button className="btn btn-p" onClick={() => setOpen(true)}>
            I&apos;m moving out
          </button>
        </div>
      ) : (
        <div>
          <div style={{fontWeight:700, color:'var(--t0)', marginBottom:6}}>Request your final bill</div>
          <div style={{fontSize:'.82rem', color:'var(--t3)', marginBottom:12, lineHeight:1.6}}>
            Tell us when you expect to be out. Your provider takes a final reading around that date and
            sends your last bill — you&apos;re billed for what you used, nothing after.
          </div>
          <label style={{fontSize:'.75rem', color:'var(--t3)', display:'block', marginBottom:4}}>
            When do you expect to be out?
          </label>
          <input className="inp" type="date" value={expectedOn}
            onChange={e => setExpectedOn(e.target.value)} />
          <label style={{fontSize:'.75rem', color:'var(--t3)', display:'block', margin:'10px 0 4px'}}>
            Anything they should know? <span style={{color:'var(--t3)'}}>(optional)</span>
          </label>
          <textarea className="inp" rows={2} value={note} maxLength={500}
            placeholder="Who's taking over, where to reach you…"
            onChange={e => setNote(e.target.value)} />
          {error && <div style={{marginTop:10, fontSize:'.8rem', color:'var(--red)'}}>{error}</div>}
          <div style={{display:'flex', gap:8, marginTop:14}}>
            <button className="btn btn-p" disabled={!expectedOn || give.isLoading}
              onClick={() => { setError(''); give.mutate() }}>
              {give.isLoading ? 'Sending…' : 'Send request'}
            </button>
            <button className="btn btn-sm" onClick={() => setOpen(false)}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  )
}

function UtilityServiceHome({ me, firstName }: { me: any; firstName?: string }) {
  const { data: balanceCtx } = useQuery<any>('balance-context',
    () => get<any>('/payments/balance-context'))
  const charges: any[] = (balanceCtx?.serviceAgreements ?? []).flatMap((a: any) => a.rows ?? [])
  const owed = charges.reduce((s: number, c: any) => s + Number(c.amount || 0), 0)
  const where = me.utilityServiceAddress || me.utilityServiceSpace || 'your address'

  return (
    <div>
      <div className="ph">
        <div>
          <h1 className="pt">Hi, {firstName} 👋</h1>
          <p className="ps">Utility service at {where}</p>
        </div>
      </div>

      <div className="grid3" style={{marginBottom:24}}>
        <a href="/payments" style={{textDecoration:'none'}} className="kpi"
          onMouseEnter={e=>(e.currentTarget as any).style.borderColor='var(--gold)'}
          onMouseLeave={e=>(e.currentTarget as any).style.borderColor=''}>
          <div className="kpi-l">Balance Due</div>
          <div className="kpi-v" style={{color: owed > 0 ? 'var(--gold)' : undefined}}>
            {formatCurrency(owed)}
          </div>
          <div className="kpi-s">
            {owed > 0 ? 'tap to pay →' : "you're all paid up"}
          </div>
        </a>
        <div className="kpi">
          <div className="kpi-l">Billed By</div>
          <div className="kpi-v" style={{fontSize:'1.05rem',marginTop:4}}>
            {me.utilityServicePropertyName || '—'}
          </div>
          <div className="kpi-s">{me.utilityServiceSpace || ''}</div>
        </div>
        <div className="kpi">
          <div className="kpi-l">Bills Due</div>
          <div className="kpi-v" style={{fontSize:'1.05rem',marginTop:4}}>
            {me.utilityServiceDueDay === 1 ? '1st of the month'
              : me.utilityServiceDueDay ? `Day ${me.utilityServiceDueDay}` : '—'}
          </div>
          <div className="kpi-s">each month</div>
        </div>
      </div>

      <MoveOutNotice me={me} />

      <div className="card" style={{padding:16}}>
        <div style={{fontWeight:700,marginBottom:6}}>What you&apos;re billed for</div>
        {charges.length === 0 ? (
          <div style={{fontSize:'.82rem',color:'var(--t3)',lineHeight:1.6}}>
            Nothing outstanding right now. When a meter is read or a monthly charge comes
            due, the bill shows up here with the readings behind it.
          </div>
        ) : (
          <table style={{width:'100%',fontSize:'.82rem',borderCollapse:'collapse'}}>
            <tbody>
              {charges.map((c: any) => (
                <tr key={c.id} style={{borderTop:'1px solid var(--b0)'}}>
                  <td style={{padding:'8px 0'}}>
                    <div style={{fontWeight:600}}>
                      {c.type === 'late_fee' ? 'Late fee' : 'Utilities'}
                    </div>
                    {c.notes && (
                      <div style={{fontSize:'.72rem',color:'var(--t3)'}}>{c.notes}</div>
                    )}
                  </td>
                  <td style={{textAlign:'right',whiteSpace:'nowrap'}}>
                    <div style={{fontWeight:600}}>{formatCurrency(c.amount)}</div>
                    <div style={{fontSize:'.72rem',color:'var(--t3)'}}>due {c.dueDate}</div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div style={{fontSize:'.72rem',color:'var(--t3)',marginTop:12,lineHeight:1.6}}>
          You don&apos;t rent from {me.utilityServicePropertyName || 'this property'} — this account
          is only for the utilities they supply to {where}. Each bill shows the meter readings and
          the dates they were taken.
        </div>
      </div>
    </div>
  )
}

function HomePage() {
  const { user } = useAuth()
  const { data: me } = useQuery('tenant-me', () => get<any>('/tenants/me'))
  const { data: health } = useQuery<any>('tenant-payment-health', () => get<any>('/tenants/me/payment-health'))
  // S613: this tenant's own propane — empty for almost everyone, which is why
  // the card only appears when there is something to show.
  const { data: propane } = useQuery<any>('tenant-propane', () => get<any>('/propane/mine'))
  const [propaneOpen, setPropaneOpen] = useState(false)
  const flexVis = useFlexVisibility()

  // S615: a utility-service payer has no lease, so every field this page reads
  // is NULL for them — the header said "undefined · Unit undefined" over a rent
  // card that can never have a number in it. They get their own home page,
  // showing the one thing that is true: what they owe for what they used.
  if (me && me.utilityServiceAgreementId && !me.unitId) {
    return <UtilityServiceHome me={me} firstName={user?.firstName} />
  }

  return (
    <div>
      <div className="ph">
        <div>
          <h1 className="pt">Hi, {user?.firstName} 👋</h1>
          <p className="ps">{me?.propertyName} · Unit {me?.unitNumber}</p>
        </div>
      </div>

      <ServiceOutageBanner />
      <HomeAlerts />

      {/* S542: private platform questionnaire — landlord never sees it. */}
      <QuestionnairePrompt />

      {/* S613 (Nic): "I'd like it on the home page, but only visible if a unit
          has the utility." A tenant with no propane sees the same three cards
          they always saw; a tenant with a tank gets a fourth and the row tightens
          to fit, rather than the page growing a section that is empty for most
          people. */}
      <div className={propane && propane.totalCount > 0 ? 'grid4' : 'grid3'} style={{marginBottom:24}}>
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
        {!flexVis.flexdeposit ? (
          // S541: FlexDeposit not rolled out — deposit KPI is informational
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
        {propane && propane.totalCount > 0 && (
          <div className="kpi" style={{cursor:'pointer'}} onClick={()=>setPropaneOpen(true)}
            onMouseEnter={e=>(e.currentTarget as any).style.borderColor='var(--gold)'}
            onMouseLeave={e=>(e.currentTarget as any).style.borderColor=''}>
            <div className="kpi-l">Propane</div>
            <div className="kpi-v" style={{color: propane.balance > 0 ? 'var(--gold)' : undefined}}>
              {formatCurrency(propane.balance)}
            </div>
            <div className="kpi-s">
              {propane.paidCount} of {propane.totalCount} payments paid · tap for details →
            </div>
          </div>
        )}
      </div>
      {propaneOpen && propane && (
        <PropaneLedgerModal data={propane} onClose={()=>setPropaneOpen(false)} />
      )}

      {/* S595 (Nic): Payment Health heartbeat — the tenant's ON-TIME payment
          health as an animated ECG (mirrors the landlord dashboard monitor).
          Health = % of billed obligations paid on time over the last 6 months
          (NOT total paid): 100% gold, 80%+ green, below that red. */}
      {health && health.totalPayments > 0 && (() => {
        const oh = health.onTime
        const monthsAbbr = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
        const now = new Date()
        const months6 = Array.from({ length: 6 }, (_, i) => {
          const d = new Date(now.getFullYear(), now.getMonth() - 5 + i, 1)
          const ym = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
          const found = (oh?.months || []).find((r: any) => r.ym === ym)
          return { label: monthsAbbr[d.getMonth()], rate: found ? found.rate : null, total: found?.total || 0, onTime: found?.onTime || 0 }
        })
        return <PaymentHealthMonitor months={months6} pct={oh?.pct ?? null} />
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
        {/* S541: "Your Subscriptions" surfaces only rolled-out Flex
            products (per-product flags), one row per visible product. */}
        {flexVis.any && (
        <a href="/services" style={{textDecoration:'none'}} className="card"
          onMouseEnter={e=>(e.currentTarget as any).style.borderColor='var(--gold)'}
          onMouseLeave={e=>(e.currentTarget as any).style.borderColor=''}>
          <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:16}}>
            <h3>Your Subscriptions</h3>
            <span style={{fontSize:'.72rem',color:'var(--t3)'}}>Manage →</span>
          </div>
          {flexVis.flexcredit && <div className="dr"><span className="dk">Credit Reporting</span><span className={`badge ${me?.creditReportingEnrolled?'b-green':'b-muted'}`}>{me?.creditReportingEnrolled?'Active — $5/mo':'Not enrolled'}</span></div>}
          {flexVis.flexpay && <div className="dr"><span className="dk">FlexPay</span><span className={`badge ${me?.flexpayPausedMultiLease?'b-amber':me?.flexpayEnrolled?'b-green':'b-muted'}`}>{me?.flexpayPausedMultiLease?'⏸ Paused — 2+ leases':me?.flexpayEnrolled?`Active — day ${me.flexpayPullDay}`:'Not enrolled'}</span></div>}
          {flexVis.flexdeposit && <div className="dr"><span className="dk">FlexDeposit</span><span className={`badge ${me?.flexDepositEnrolled?'b-green':'b-muted'}`}>{me?.flexDepositEnrolled?'Active — $3/mo':'Not enrolled'}</span></div>}
          <div style={{marginTop:16}}>
            <span className="btn btn-g btn-sm">Manage services →</span>
          </div>
        </a>
        )}
      </div>

    </div>
  )
}


// S595 (Nic): Payment Health — an animated ECG "heartbeat monitor" of the
// tenant's ON-TIME payment health (mirrors the landlord dashboard monitor).
// Each of the last 6 months is one beat whose height is that month's on-time
// rate (a fully-on-time month = full beat; a no-bills-due month flatlines).
// Color = the 6-month on-time rate: 100% gold, 80%+ green, below that red —
// NOT total-paid (that metric is the landlord's collective view).
function PaymentHealthMonitor({ months, pct }: { months: { label: string; rate: number | null; total: number; onTime: number }[]; pct: number | null }) {
  const W = 640, H = 190
  const data = months.length ? months : Array.from({ length: 6 }, () => ({ label: '', rate: null as number | null, total: 0, onTime: 0 }))
  const baseY = H * 0.62
  const spk = H * 0.40
  const bw = W / data.length

  // Beat amplitude = that month's on-time rate (absolute — full beat = 100% on
  // time; a month with no bills due flatlines).
  const amp = data.map(m => (m.rate == null ? 0 : Math.max(0, Math.min(1, m.rate))))
  const pts: [number, number][] = [[0, baseY]]
  data.forEach((_, i) => {
    const x0 = i * bw
    const a = amp[i]
    const at = (f: number) => x0 + f * bw
    const y = (up: number) => baseY - up * spk * a
    pts.push(
      [at(0.30), baseY],
      [at(0.36), y(0.08)], [at(0.42), baseY],
      [at(0.48), y(-0.10)],
      [at(0.53), y(1.0)],
      [at(0.58), y(-0.22)],
      [at(0.63), baseY],
      [at(0.76), y(0.20)], [at(0.86), baseY],
      [at(1.0), baseY],
    )
  })
  const dPath = 'M ' + pts.map(p => `${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' L ')

  // Color from the 6-month on-time rate: 100% gold, 80%+ green, else red.
  const status = pct == null
    ? { label: 'Awaiting data',           color: 'var(--t3,#8a93a5)' }
    : pct >= 100 ? { label: 'Perfect — all on time', color: 'var(--gold,#c9a227)' }
    : pct >= 80  ? { label: 'On track',              color: 'var(--green,#2fbf71)' }
    :              { label: 'Needs attention',       color: 'var(--red,#e25555)' }

  const peaks = data.map((_, i) => ({ x: (i + 0.53) * bw, y: baseY - spk * amp[i] }))
  const [hoverIdx, setHoverIdx] = useState<number | null>(null)
  const screenRef = useRef<HTMLDivElement>(null)
  const onMove = (e: React.MouseEvent) => {
    const el = screenRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    setHoverIdx(Math.max(0, Math.min(data.length - 1, Math.floor(((e.clientX - r.left) / r.width) * data.length))))
  }

  return (
    <div className="card" style={{ marginBottom: 24 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <div style={{ fontWeight: 700, color: 'var(--t0)' }}>Payment Health — last 6 months</div>
        <span style={{ fontSize: '.72rem', fontWeight: 700, color: status.color }}>◆ {status.label}</span>
      </div>
      <div className="tphm-screen" ref={screenRef} onMouseMove={onMove} onMouseLeave={() => setHoverIdx(null)}>
        {hoverIdx == null ? (
          <div className="tphm-readout">
            <span className="tphm-readout-label">on-time · last 6 mo</span>
            <span className="tphm-readout-value" style={{ color: status.color }}>{pct == null ? '—' : `${pct}%`}</span>
          </div>
        ) : (
          <div className="tphm-tip" style={{ left: `clamp(64px, ${((hoverIdx + 0.53) / data.length) * 100}%, calc(100% - 64px))` }}>
            <div className="tphm-tip-month">{data[hoverIdx].label || '—'}</div>
            <div className="tphm-tip-val" style={{ color: status.color }}>
              {data[hoverIdx].rate == null ? 'no bills due' : `${Math.round((data[hoverIdx].rate as number) * 100)}% on time`}
            </div>
            {data[hoverIdx].total > 0 && (
              <div className="tphm-tip-sub">{data[hoverIdx].onTime} of {data[hoverIdx].total} paid on time</div>
            )}
          </div>
        )}
        <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={190} preserveAspectRatio="none"
             role="img" aria-label={`On-time payment health, last 6 months: ${status.label}`}>
          <defs>
            <linearGradient id="tphm-sweep-grad" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%"   stopColor={status.color} stopOpacity="0" />
              <stop offset="72%"  stopColor={status.color} stopOpacity="0.08" />
              <stop offset="100%" stopColor={status.color} stopOpacity="0.30" />
            </linearGradient>
          </defs>
          <g className="tphm-grid">
            {Array.from({ length: data.length + 1 }, (_, i) => <line key={'v' + i} x1={i * bw} y1={0} x2={i * bw} y2={H} />)}
            {Array.from({ length: 5 }, (_, i) => <line key={'h' + i} x1={0} y1={i * H / 4} x2={W} y2={i * H / 4} />)}
          </g>
          <line x1={0} y1={baseY} x2={W} y2={baseY} className="tphm-base" />
          <path d={dPath} className="tphm-trace" style={{ stroke: status.color }} fill="none" />
          <g className="tphm-sweepwrap">
            <rect x={0} y={0} width={100} height={H} fill="url(#tphm-sweep-grad)" />
          </g>
          {hoverIdx != null && (
            <g style={{ color: status.color }}>
              <line className="tphm-hoverline" x1={(hoverIdx + 0.53) * bw} y1={0} x2={(hoverIdx + 0.53) * bw} y2={H} />
              <circle className="tphm-hoverdot" cx={peaks[hoverIdx].x} cy={peaks[hoverIdx].y} r={4.5} />
            </g>
          )}
        </svg>
        <div className="tphm-months">
          {data.map((m, i) => <span key={i}>{m.label}</span>)}
        </div>
      </div>
      <style>{`
        .tphm-screen { position: relative; background: radial-gradient(120% 90% at 50% 30%, rgba(20,26,22,.55), rgba(11,15,20,.92)); border: 1px solid var(--b1,#1e2530); border-radius: 10px; padding: 8px; overflow: hidden; cursor: crosshair; }
        .tphm-grid line { stroke: var(--b1,#1e2530); stroke-width: 1; opacity: .55; }
        .tphm-base { stroke: var(--b1,#1e2530); stroke-width: 1; opacity: .8; }
        .tphm-trace { stroke-width: 2.25; stroke-linejoin: round; stroke-linecap: round; filter: drop-shadow(0 0 4px currentColor); }
        .tphm-sweepwrap { opacity: 0; }
        .tphm-hoverline { stroke: currentColor; stroke-width: 1; opacity: .55; stroke-dasharray: 3 3; }
        .tphm-hoverdot { fill: currentColor; filter: drop-shadow(0 0 5px currentColor); }
        .tphm-readout { position: absolute; top: 8px; right: 12px; z-index: 1; display: flex; flex-direction: column; align-items: flex-end; line-height: 1.1; pointer-events: none; }
        .tphm-readout-label { font-size: .58rem; text-transform: uppercase; letter-spacing: .08em; color: var(--t3,#8a93a5); }
        .tphm-readout-value { font-family: var(--font-mono,monospace); font-size: 1.05rem; font-weight: 700; }
        .tphm-tip { position: absolute; top: 8px; z-index: 2; transform: translateX(-50%); background: var(--b2,#141b24); border: 1px solid var(--b1,#1e2530); border-radius: 8px; padding: 5px 10px; text-align: center; white-space: nowrap; pointer-events: none; box-shadow: 0 6px 18px rgba(0,0,0,.5); }
        .tphm-tip-month { font-size: .58rem; text-transform: uppercase; letter-spacing: .07em; color: var(--t3,#8a93a5); }
        .tphm-tip-val { font-family: var(--font-mono,monospace); font-size: .9rem; font-weight: 700; }
        .tphm-tip-sub { font-size: .58rem; color: var(--t3,#8a93a5); margin-top: 1px; }
        .tphm-months { display: flex; justify-content: space-around; margin-top: 4px; font-size: .66rem; color: var(--t3,#8a93a5); font-family: var(--font-mono,monospace); }
        @media (prefers-reduced-motion: no-preference) {
          .tphm-sweepwrap { opacity: 1; animation: tphm-sweep 3.4s linear infinite; }
          .tphm-trace { animation: tphm-glow 2.2s ease-in-out infinite; }
          @keyframes tphm-sweep { from { transform: translateX(-100px); } to { transform: translateX(${W}px); } }
          @keyframes tphm-glow { 0%, 100% { opacity: .82; } 50% { opacity: 1; } }
        }
      `}</style>
    </div>
  )
}

// PaymentsPage moved to ./pages/PaymentsPage.tsx in S169 — now hosts the
// real Pay Now flow + Stripe Financial Connections bank add via the
// /api/payments/:id/pay destination charge backend.
import { PaymentsPage as PaymentsPageImpl } from './pages/PaymentsPage'
function PaymentsPage() {
  // S570 (Nic): removed the "landlord banking not ready" banner — tenant money
  // sweeps to GAM's platform balance and is held until the landlord onboards,
  // so payment is never actually blocked and the banner was misleading.
  return <PaymentsPageImpl />
}


// ── ACH VERIFY FORM ───────────────────────────────────────────────────────
function AchVerifyForm({ onSuccess }: { onSuccess: () => void }) {
  const [last4, setLast4] = useState('')
  const [error, setError] = useState('')

  // S554 (button-sweep bug #13): the "Bank Name" input was dropped — the
  // verify-ach route never read bankName (no bank_name column; Stripe feeds
  // the real display name). Only last4 is used.
  const mut = useMutation(
    () => fetch((import.meta as any).env?.VITE_API_URL + '/api/tenants/verify-ach', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + localStorage.getItem('gam_tenant_token') },
      body: JSON.stringify({ last4 })
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
        <label className="fl">Last 4 digits of account number</label>
        <input className="fi" value={last4} onChange={e=>setLast4(e.target.value.replace(/\D/g,'').slice(0,4))} placeholder="1234" maxLength={4} style={{maxWidth:120,fontFamily:'var(--font-m)'}} />
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

// S581 (Nic): blocking pop-up for a landlord NOTICE (e.g. a rent-increase the
// tenant can't refuse). Shows on login, is NOT dismissible by clicking away —
// only "Acknowledge" closes it (which records that the tenant saw it). Multiple
// notices queue one at a time.
interface LeaseNotice {
  id: string; title: string; body: string
  // S583: the API camelCases every response key on the way out (index.ts global
  // middleware), so the wire fields are camelCase — reading property_name /
  // unit_number here left the notice's "Property · Unit N" subheader blank.
  effectiveDate: string | null; propertyName: string; unitNumber: string
}
function LeaseNoticeGate() {
  const qc = useQueryClient()
  const { data } = useQuery<LeaseNotice[]>(
    'lease-notices',
    () => fetch((import.meta as any).env?.VITE_API_URL + '/api/tenants/lease-notices', {
      headers: { Authorization: 'Bearer ' + localStorage.getItem('gam_tenant_token') },
    }).then(r => r.json()).then(r => r.data),
    { staleTime: 30000 },
  )
  const [error, setError] = useState('')
  const current = (data ?? [])[0] ?? null
  const ack = useMutation(
    (id: string) => fetch((import.meta as any).env?.VITE_API_URL + `/api/tenants/lease-notices/${id}/acknowledge`, {
      method: 'POST', headers: { Authorization: 'Bearer ' + localStorage.getItem('gam_tenant_token') },
    }).then(r => r.json()),
    {
      onSuccess: (r: any) => {
        if (!r?.success) { setError(r?.error || 'Could not save. Try again.'); return }
        qc.invalidateQueries('lease-notices')
      },
      onError: () => setError('Could not save. Try again.'),
    },
  )
  if (!current) return null
  return (
    // Blocking overlay: no onClick-to-dismiss — the tenant must Acknowledge.
    <div className="modal-ov">
      <div className="modal" style={{ maxWidth: 560 }} onClick={e => e.stopPropagation()}>
        <div className="modal-t">📢 {current.title}</div>
        <div style={{ fontSize: '.7rem', color: 'var(--t3)', marginBottom: 12 }}>
          {current.propertyName}{current.unitNumber ? ` · Unit ${current.unitNumber}` : ''}
        </div>
        <p style={{ fontSize: '.92rem', color: 'var(--t1)', lineHeight: 1.6, marginBottom: 16 }}>{current.body}</p>
        <div style={{ fontSize: '.74rem', color: 'var(--t3)', marginBottom: 16 }}>
          This is a formal notice from your landlord. Acknowledging confirms you have seen it.
        </div>
        {error && <div className="alert a-warn" style={{ marginBottom: 12 }}>{error}</div>}
        <button className="btn btn-p" style={{ width: '100%' }} disabled={ack.isLoading}
          onClick={() => ack.mutate(current.id)}>
          {ack.isLoading ? 'Saving…' : 'Acknowledge'}
        </button>
      </div>
    </div>
  )
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
// S545b: per-income benefit-schedule fields — the ask matches how
// each program actually pays (SSI 1st; SSDI 3rd or Nth Wednesday by
// birth date; other fixed incomes a plain day). Used by the FlexPay
// survey modal AND the private questionnaire.
const SSDI_SCHEDULES: [string, string][] = [
  ['ssdi_wed_2', '2nd Wednesday'], ['ssdi_wed_3', '3rd Wednesday'],
  ['ssdi_wed_4', '4th Wednesday'], ['ssdi_day_3', '3rd of the month'],
]
function BenefitScheduleFields({ income, schedule, setSchedule, day, setDay }: {
  income: 'ssi'|'ssdi'|'other_fixed'|'none'
  schedule: string | null; setSchedule: (s: string) => void
  day: number; setDay: (n: number) => void
}) {
  if (income === 'none') return null
  if (income === 'ssi') return (
    <div className="fg" style={{marginTop:12}}>
      <label className="fl">When it arrives</label>
      <div style={{fontSize:'.82rem',color:'var(--t1)'}}>
        SSI arrives on the <strong>1st of the month</strong> (or the business day before). We’ll plan around that.
      </div>
    </div>
  )
  if (income === 'ssdi') return (
    <div className="fg" style={{marginTop:12}}>
      <label className="fl">When does your SSDI arrive?</label>
      <div style={{display:'flex',gap:8,flexWrap:'wrap'}}>
        {SSDI_SCHEDULES.map(([v, l]) => (
          <button key={v} type="button" className={`btn btn-sm ${schedule===v?'btn-p':'btn-g'}`}
            onClick={()=>setSchedule(v)}>{l}</button>
        ))}
      </div>
      <div style={{fontSize:'.7rem',color:'var(--t3)',marginTop:6,lineHeight:1.5}}>
        SSDI pays by birthday — 1st–10th: 2nd Wednesday · 11th–20th: 3rd Wednesday · 21st–31st: 4th Wednesday. Started before May 1997? It pays on the 3rd.
      </div>
    </div>
  )
  return (
    <div className="fg" style={{marginTop:12}}>
      <label className="fl">What day of the month does your money arrive?</label>
      <div style={{display:'flex',alignItems:'center',gap:12}}>
        <input type="range" min={1} max={28} value={day}
          onChange={e=>setDay(parseInt(e.target.value))}
          style={{flex:1,accentColor:'var(--gold)'}} />
        <span style={{fontFamily:'var(--font-m)',fontSize:'1.2rem',fontWeight:800,color:'var(--t0)',minWidth:32,textAlign:'center'}}>{day}</span>
      </div>
      <div style={{fontSize:'.72rem',color:'var(--t3)',marginTop:4}}>If it varies, pick the latest day it can land.</div>
    </div>
  )
}
// Submission payload bits for the chosen income/schedule/day.
function scheduleSubmission(income: string, schedule: string | null, day: number) {
  if (income === 'none') return {}
  if (income === 'ssi') return { benefitSchedule: 'ssi_day_1' }
  if (income === 'ssdi') return schedule ? { benefitSchedule: schedule } : {}
  return { benefitSchedule: 'fixed_day', benefitDay: day }
}
const scheduleReady = (income: string, schedule: string | null) =>
  income !== 'ssdi' || !!schedule

// S542b: proof-of-income upload card (pending FlexPay request only).
function FlexPayProofCard({ proofName, onUploaded }: { proofName: string | null; onUploaded: () => void }) {
  const fileRef = React.useRef<HTMLInputElement>(null)
  const [error, setError] = useState<string | null>(null)
  const upMut = useMutation(
    (file: File) => {
      const fd = new FormData(); fd.append('file', file)
      return api.post('/tenants/flexpay/inquiry/proof', fd, { headers: { 'Content-Type': 'multipart/form-data' } }).then(r => r.data)
    },
    { onSuccess: () => { setError(null); onUploaded() },
      onError: (e: any) => setError(e?.response?.data?.error || 'Upload failed — PDF, JPEG, PNG or WEBP up to 10MB.') },
  )
  return (
    <div className="card" style={{ marginTop: 24 }}>
      <h3 style={{ marginBottom: 4 }}>🪪 Proof of income {proofName ? <span className="badge b-green" style={{ marginLeft: 8 }}>✓ On file</span> : <span className="badge b-amber" style={{ marginLeft: 8 }}>Needed</span>}</h3>
      <p style={{ fontSize: '.82rem', color: 'var(--t3)', marginBottom: 12 }}>
        FlexPay is for SSI/SSDI recipients, and your request can’t be approved
        until we can verify that. Upload your SSA award letter or benefit
        verification letter (PDF or photo). Only GAM sees this — never your
        landlord.
      </p>
      {proofName && (
        <div style={{ fontSize: '.78rem', color: 'var(--t1)', marginBottom: 10 }}>
          Uploaded: <span className="mono">{proofName}</span>
        </div>
      )}
      {error && <div className="alert a-warn" style={{ marginBottom: 10 }}>{error}</div>}
      <input ref={fileRef} type="file" accept=".pdf,image/jpeg,image/png,image/webp" style={{ display: 'none' }}
        onChange={e => { const f = e.target.files?.[0]; if (f) upMut.mutate(f); e.target.value = '' }} />
      <button className="btn btn-p btn-sm" disabled={upMut.isLoading} onClick={() => fileRef.current?.click()}>
        {upMut.isLoading ? <span className="spinner" /> : proofName ? 'Replace document' : 'Upload document'}
      </button>
    </div>
  )
}

// S541: FlexPay demand-test inquiry ("I'm interested"). Low friction by
// design — the tenant claims SSI or SSDI and optionally adds a note;
// GAM reviews the lease + verifies income, then approves from the admin
// portal. No ACH/eligibility gate here; that all guards ENROLLMENT.
function FlexPayInquireModal({ survey, onClose, onSuccess }: { survey?: boolean; onClose: () => void; onSuccess: () => void }) {
  // S545: all income types accepted — non-SSI/SSDI files a tier-2
  // request (waits behind SSI/SSDI; nothing promised either way).
  const [incomeSource, setIncomeSource] = useState<'ssi' | 'ssdi' | 'other_fixed' | 'none'>('ssi')
  // S545b: pay pattern per program + raw day for fixed-day incomes.
  const [schedule, setSchedule] = useState<string | null>(null)
  const [benefitDay, setBenefitDay] = useState<number>(3)
  const [note, setNote] = useState('')
  const [error, setError] = useState<string | null>(null)
  const mut = useMutation(
    () => post('/tenants/flexpay/inquiry', {
      incomeSource,
      ...scheduleSubmission(incomeSource, schedule, benefitDay),
      note: note.trim() || undefined,
    }),
    {
      onSuccess,
      onError: (e: any) => setError(e?.response?.data?.error || 'Something went wrong. Please try again.'),
    },
  )
  return (
    <div className="modal-ov" onClick={onClose}>
      <div className="modal" onClick={e=>e.stopPropagation()} style={{maxWidth:480}}>
        <div className="modal-t">⚡ {survey ? 'FlexPay is coming soon' : 'FlexPay — request access'}</div>
        <p style={{fontSize:'.82rem',color:'var(--t2)',marginBottom:16}}>
          {survey ? (
            <>FlexPay will let you move your rent pull to the day your benefits
            arrive, for SSI and SSDI recipients. It hasn’t launched yet — this
            30-second survey just gauges interest. It isn’t a signup and doesn’t
            guarantee availability, but it helps us bring it to the right people
            first.</>
          ) : (
            <>FlexPay lets you move your rent pull to the day your benefits arrive.
            It’s available to SSI and SSDI recipients. Tell us which applies to
            you and we’ll review your request — usually within a few business
            days — and reach out with next steps.</>
          )}
        </p>
        <div className="fg">
          <label className="fl">My monthly income is</label>
          <div style={{display:'flex',gap:10,flexWrap:'wrap'}}>
            {([['ssi','SSI'],['ssdi','SSDI'],['other_fixed','Other fixed day'],['none','No fixed day']] as const).map(([src,label]) => (
              <button key={src} type="button"
                className={`btn btn-sm ${incomeSource===src?'btn-p':'btn-g'}`}
                onClick={()=>setIncomeSource(src)}>
                {label}
              </button>
            ))}
          </div>
        </div>
        <BenefitScheduleFields income={incomeSource} schedule={schedule} setSchedule={setSchedule} day={benefitDay} setDay={setBenefitDay} />
        <div className="fg" style={{marginTop:12}}>
          <label className="fl">Anything we should know? (optional)</label>
          <textarea className="inp" rows={3} maxLength={1000} value={note}
            onChange={e=>setNote(e.target.value)}
            placeholder="e.g. my deposit day is the 3rd Wednesday" />
        </div>
        {error && <div className="alert a-warn" style={{marginTop:12}}>{error}</div>}
        <div style={{display:'flex',justifyContent:'flex-end',gap:10,marginTop:18}}>
          <button className="btn btn-g" onClick={onClose}>Cancel</button>
          <button className="btn btn-p" onClick={()=>mut.mutate()} disabled={mut.isLoading || !scheduleReady(incomeSource, schedule)}>
            {mut.isLoading ? <span className="spinner"/> : survey ? 'Submit survey' : 'Request access'}
          </button>
        </div>
      </div>
    </div>
  )
}

// FlexPay is a payment-scheduling subscription. Tenant picks a pull day
// (1-28); fee is a FLAT $25/month (S562) — pull day is scheduling only. Day 28 cap covers all
// U.S. social security payout windows (SSDI 4th-Wed-of-month). S314:
// click-accept of the Subscription Terms is required + persisted.

function FlexPayModal({ onClose, onSuccess }: { onClose: () => void; onSuccess: () => void }) {
  const [pullDay, setPullDay] = useState(15)
  const [tosAck, setTosAck] = useState(false)
  const [showFullTerms, setShowFullTerms] = useState(false)
  const [fullTermsText, setFullTermsText] = useState<string | null>(null)
  const [loadingTerms, setLoadingTerms] = useState(false)
  const [error, setError] = useState('')
  const fee = 25  // S562: FlexPay is a flat $25/month (pull day is scheduling only)

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
          Pick the day of the month your rent gets pulled from your bank — match it to when your income lands. Your FlexPay fee is a flat <strong>$25/month</strong> no matter which day you choose.
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
          <div style={{fontSize:'.7rem',color:'var(--t3)',marginTop:6}}>Flat $25/month · day {pullDay} is just your pull schedule</div>
        </div>

        {error && <div className="alert a-warn" style={{marginBottom:12}}>{error}</div>}

        {/* S314: FlexPay Subscription Terms — summary + full-text link + checkbox */}
        <div style={{background:'var(--bg3)',border:'1px solid var(--b1)',borderRadius:8,padding:14,marginBottom:14,fontSize:'.72rem',color:'var(--t2)',lineHeight:1.5}}>
          <div style={{fontWeight:700,color:'var(--t0)',marginBottom:8,fontSize:'.78rem'}}>FlexPay Subscription Terms — please review</div>
          <p style={{marginBottom:8}}>
            <strong style={{color:'var(--t1)'}}>Subscription, not a loan.</strong> FlexPay is a payment-date coordination subscription. GAM does not advance funds on your behalf. You authorize a recurring ACH pull from your verified bank account on the pull day you choose; your monthly fee is a flat $25 regardless of that day.
          </p>
          <p style={{marginBottom:8}}>
            <strong style={{color:'var(--t1)'}}>Failed pulls retry.</strong> ACH is all-or-nothing (banks reject the whole pull on insufficient funds). If your scheduled pull fails, GAM retries on a later day. Your FlexPay fee stays a flat $25 — it does not change on a retry. Stripe's actual ACH-return fee (about $4) is passed through to you at cost, with no GAM markup.
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
// flat $25/month; the new day is scheduling only.
function FlexPayChangeDayModal({
  currentDay, onClose, onSuccess,
}: { currentDay: number; onClose: () => void; onSuccess: () => void }) {
  const [pullDay, setPullDay] = useState(currentDay || 15)
  const [error, setError] = useState('')
  const fee = 25  // S562: FlexPay is a flat $25/month (pull day is scheduling only)

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
          Pick a new day of the month. This takes effect <strong>next billing cycle</strong> — your current cycle's pull is already scheduled. Your FlexPay fee stays a flat $25/month.
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
          <div style={{fontSize:'.7rem',color:'var(--t3)',marginTop:6}}>Flat $25/month · day {pullDay} is just your pull schedule</div>
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

// ── FEATURE REQUEST MODAL (S571) ──────────────────────────────────────────
// Real capture — replaces the old dead deep-link to a non-existent admin page.
function FeatureRequestModal({ onClose, onSuccess }: { onClose: () => void; onSuccess: () => void }) {
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [error, setError] = useState('')
  const [done, setDone] = useState(false)

  const mut = useMutation(
    () => fetch((import.meta as any).env?.VITE_API_URL + '/api/feature-requests', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + localStorage.getItem('gam_tenant_token') },
      body: JSON.stringify({ title, description }),
    }).then(r => r.json()),
    {
      onSuccess: (data) => {
        if (!data.success) { setError(data.error || 'Could not submit your request'); return }
        setDone(true)
      },
      onError: () => setError('Could not submit your request. Please try again.'),
    }
  )

  return (
    <div className="modal-ov" onClick={onClose}>
      <div className="modal" onClick={e=>e.stopPropagation()} style={{maxWidth:480}}>
        <div className="modal-t">💡 Suggest a feature</div>
        {done ? (
          <>
            <p style={{fontSize:'.85rem',color:'var(--t2)',margin:'8px 0 20px'}}>
              Thanks — your idea went to the GAM team. We read every one.
            </p>
            <div style={{display:'flex',justifyContent:'flex-end'}}>
              <button className="btn btn-p btn-sm" onClick={onSuccess}>Done</button>
            </div>
          </>
        ) : (
          <>
            <p style={{fontSize:'.82rem',color:'var(--t2)',marginBottom:16}}>
              Suggest a new service or an improvement. Requests go directly to the GAM team.
            </p>
            <div className="fg">
              <label className="fl">Title</label>
              <input className="input" placeholder="e.g. Pay rent in installments" value={title} onChange={e=>setTitle(e.target.value)} maxLength={140} autoFocus />
            </div>
            <div className="fg">
              <label className="fl">Details</label>
              <textarea className="input" rows={4} placeholder="Describe what you'd like and why it would help…" value={description} onChange={e=>setDescription(e.target.value)} maxLength={4000} style={{resize:'vertical'}} />
            </div>
            {error && <div className="alert a-red" style={{marginBottom:12}}>{error}</div>}
            <div style={{display:'flex',gap:8,justifyContent:'flex-end'}}>
              <button className="btn btn-g btn-sm" onClick={onClose}>Cancel</button>
              <button className="btn btn-p btn-sm" disabled={mut.isLoading || title.trim().length<3 || description.trim().length<5} onClick={()=>{ setError(''); mut.mutate() }}>
                {mut.isLoading ? <span className="spinner"/> : 'Submit request'}
              </button>
            </div>
          </>
        )}
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
  const [payAcct, setPayAcct] = useState<any | null>(null)
  const visible = fc.data?.visible !== false
  const accounts = (fc.data?.accounts || []) as any[]
  if (!visible || accounts.length === 0) return null

  return (
    <div className="card" style={{ marginTop: 24 }}>
      <h3 style={{ marginBottom: 4 }}>💳 FlexCharge accounts</h3>
      <p style={{ fontSize: '.78rem', color: 'var(--t3)', marginBottom: 16 }}>
        Tabs you have at GAM-platform merchants. Each month a statement is issued and the <strong>minimum payment</strong> auto-pulls from your bank on the due date. You can carry a balance — pay it down or in full anytime below. <strong>Pay your full balance by the due date and you owe no interest.</strong>
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
            {/* S583 revolving: minimum due + pay-down. */}
            {Number(a.balance) > 0 && a.status === 'active' && (
              <div style={{ marginTop: 8, display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
                <div style={{ fontSize: '.72rem', color: 'var(--t2)' }}>
                  {a.minimumDue != null && Number(a.minimumDue) > 0
                    ? <>Minimum due <strong style={{ color: 'var(--t0)' }}>${Number(a.minimumDue).toFixed(2)}</strong>{a.dueDate ? <> by {new Date(a.dueDate + 'T00:00:00').toLocaleDateString()}</> : null}
                        {a.apr ? <> · {(Number(a.apr) * 100).toFixed(2)}% APR on carried balance</> : null}</>
                    : <>{a.apr ? <>{(Number(a.apr) * 100).toFixed(2)}% APR on any carried balance</> : 'No interest if paid in full'}</>}
                </div>
                <button className="btn btn-p btn-sm" onClick={() => setPayAcct(a)}>Pay toward balance</button>
              </div>
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
      {/* S583: TILA-style truth-in-lending disclosure. The merchant is the
          lender and sets the APR; GAM provides the software. */}
      <div style={{ fontSize: '.68rem', color: 'var(--t3)', marginTop: 12, lineHeight: 1.6, borderTop: '1px solid var(--b0)', paddingTop: 10 }}>
        <div style={{ fontWeight: 700, color: 'var(--t2)', marginBottom: 3 }}>How your FlexCharge account works</div>
        Your merchant extends this credit and sets the interest rate (APR). Interest applies only to a balance
        you <strong>carry past the due date</strong> — pay your full statement balance by the due date and you
        owe <strong>no interest</strong>. Each month the minimum payment (the greater of $25 or 3% of your
        balance) auto-pulls from your bank. Paying less than the minimum adds a $10 late fee. GAM charges the
        merchant a service fee; it is never added to your bill.
      </div>
      <div style={{ fontSize: '.7rem', color: 'var(--t3)', marginTop: 10 }}>
        ⓘ Disputing a charge permanently closes your tab at that merchant. Use this only for charges you didn't authorize or that the merchant won't resolve directly.
      </div>
      {disputeTx && (
        <FlexChargeDisputeModal
          tx={disputeTx}
          onClose={() => setDisputeTx(null)}
          onSuccess={() => { setDisputeTx(null); qc.invalidateQueries('tenant-flexcharge') }}
        />
      )}
      {payAcct && (
        <FlexChargePayDownModal
          account={payAcct}
          onClose={() => setPayAcct(null)}
          onSuccess={() => { setPayAcct(null); qc.invalidateQueries('tenant-flexcharge') }}
        />
      )}
    </div>
  )
}

// S583 revolving: pay down (or pay off) a FlexCharge balance. Minimum, full, or
// a custom amount; pay the full balance by the due date to avoid interest.
function FlexChargePayDownModal({ account, onClose, onSuccess }: {
  account: any
  onClose: () => void
  onSuccess: () => void
}) {
  const balance = Number(account.balance) || 0
  const minimum = Math.min(balance, Number(account.minimumDue) || 0)
  const [amount, setAmount] = useState<string>(minimum > 0 ? minimum.toFixed(2) : balance.toFixed(2))
  const [err, setErr] = useState<string | null>(null)
  const [done, setDone] = useState(false)
  const num = parseFloat(amount)
  const invalid = isNaN(num) || num <= 0 || num > balance + 0.005
  const payMut = useMutation(
    () => post(`/tenants/flexcharge/${account.id}/pay`, { amount: Math.round(num * 100) / 100 }),
    { onSuccess: () => setDone(true),
      onError: (e: any) => setErr(e?.response?.data?.error?.message || e?.response?.data?.error || 'Payment could not be started') },
  )
  return (
    <div className="modal-ov" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 420 }}>
        <div className="modal-t">Pay toward your balance</div>
        {done ? (
          <>
            <div className="alert a-green" style={{ marginBottom: 14 }}>
              Payment started. It settles in 1–3 business days and will reduce your balance.
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <button className="btn btn-p" onClick={onSuccess}>Done</button>
            </div>
          </>
        ) : (
          <>
            <div style={{ fontSize: '.8rem', color: 'var(--t2)', marginBottom: 12 }}>
              {account.propertyName} · balance <strong style={{ color: 'var(--t0)' }}>${balance.toFixed(2)}</strong>
              {minimum > 0 ? <> · minimum ${minimum.toFixed(2)}</> : null}
            </div>
            <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
              {minimum > 0 && <button type="button" className="btn btn-g btn-sm" onClick={() => setAmount(minimum.toFixed(2))}>Minimum ${minimum.toFixed(2)}</button>}
              <button type="button" className="btn btn-g btn-sm" onClick={() => setAmount(balance.toFixed(2))}>Pay in full ${balance.toFixed(2)}</button>
            </div>
            <div className="fg">
              <label className="fl">Amount</label>
              <input className="fi" type="number" step="0.01" min="0" max={balance} value={amount}
                onChange={e => { setAmount(e.target.value); setErr(null) }} />
            </div>
            {err && <div className="alert a-warn" style={{ marginTop: 10 }}>{err}</div>}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 16 }}>
              <button className="btn btn-g" onClick={onClose}>Cancel</button>
              <button className="btn btn-p" disabled={invalid || payMut.isLoading} onClick={() => payMut.mutate()}>
                {payMut.isLoading ? <span className="spinner" /> : `Pay $${isNaN(num) ? '0.00' : num.toFixed(2)}`}
              </button>
            </div>
          </>
        )}
      </div>
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
  const flexVis = useFlexVisibility()
  const [flexPayModal, setFlexPayModal] = useState(false)
  const [flexPayInquireModal, setFlexPayInquireModal] = useState(false)
  const [flexPayChangeModal, setFlexPayChangeModal] = useState(false)
  const [flexDepositModal, setFlexDepositModal] = useState(false)
  const [featureModal, setFeatureModal] = useState(false)
  const fd = useQuery('tenant-flexdeposit', () => get<any>('/tenants/flexdeposit'), { enabled: flexVis.flexdeposit })
  // S541: FlexPay demand-test — the inquiry disposition drives the card.
  const fp = useQuery('tenant-flexpay', () => get<any>('/tenants/flexpay'), { enabled: flexVis.flexpay })
  const fpInquiry = fp.data?.inquiry ?? null
  const fpApproved = fpInquiry?.status === 'approved'
  // S544: survey mode — visible but not launched. "Coming soon" +
  // interest survey; NO enrollment promises, no queue language.
  const fpLaunched = fp.data?.enrollmentOpen === true
  // S581: FlexPay is single-lease only. An already-enrolled tenant who picks up
  // a SECOND lease (an overlap move, a parking spot) has their front paused
  // server-side (the advance cron skips multi-lease tenants); surface that here
  // so they aren't left wondering. Reads the ONE server-computed signal on
  // /tenants/me (same flag the home dashboard row uses). Resumes at one lease.
  const fpMultiLeasePaused = !!me?.flexpayPausedMultiLease

  // S565: FlexCredit is DEMAND-CAPTURE only (product not built/billed yet — no
  // Esusu, no $5 charge; gated on the ~$500/mo provider breakeven). The card
  // files an INTEREST inquiry, not an enrollment — same survey mode as FlexPay.
  const fc = useQuery('tenant-flexcredit', () => get<any>('/tenants/flexcredit/inquiry'), { enabled: flexVis.flexcredit })
  const fcInterested = !!fc.data?.interested
  const flexCreditInquireMut = useMutation(() => post('/tenants/flexcredit/inquiry'), { onSuccess: () => fc.refetch() })

  const services = [
    {
      id: 'credit',
      name: 'FlexCredit',
      desc: 'Report your on-time rent payments to all 3 bureaus — Experian, TransUnion & Equifax. Build credit just by paying rent.',
      price: '$5/month',
      // Survey mode: no enrollment yet — capture interest only.
      enrolled: false,
      action: () => flexCreditInquireMut.mutate(),
      loading: flexCreditInquireMut.isLoading,
      highlight: fcInterested
        ? '✓ Interest recorded — we’ll announce availability'
        : 'Coming soon — tap if you’d use it to build credit',
      ctaLabel: 'I’m interested',
      statusBadge: fcInterested ? { text: 'Interest recorded', tone: 'b-green' } : null,
    },

    {
      id: 'flexpay',
      name: 'FlexPay',
      desc: 'Pick the day of the month your rent gets pulled from your bank — match it to when your income lands. Your landlord gets paid on the lease grace-period day no matter what; you pay later.',
      price: '$25/month',
      enrolled: me?.flexpayEnrolled,
      // S581: paused because the tenant now holds more than one lease.
      warning: fpMultiLeasePaused
        ? 'FlexPay is paused because you currently have more than one lease. FlexPay covers a single lease — your rent won’t be pulled on your chosen day while this is the case. It turns back on automatically once you’re down to one lease.'
        : null,
      // S544 survey mode (pre-launch): "coming soon" + interest
      // survey — no enrollment promises, no queue language, no
      // reach-out commitments. Any recorded inquiry (whatever its
      // admin status) reads as "interest recorded".
      // S541 launched states: no inquiry → "I'm interested";
      // pending/declined → badge; approved → Enroll (ACH-gated).
      // Server enforces both gates.
      action: () => (fpLaunched && fpApproved) ? setFlexPayModal(true) : setFlexPayInquireModal(true),
      loading: false,
      highlight: me?.flexpayEnrolled
        ? `Day ${me.flexpayPullDay} · $${me.flexpayMonthlyFee}/mo`
        : !fpLaunched
          ? (fpInquiry
              ? '✓ Interest recorded — we’ll announce availability'
              : 'Coming soon — take the 30-second interest survey')
        // S542c: NO queue numbers tenant-side — no promises. Ordering
        // (float-need first) is admin-only.
        : fpInquiry?.status === 'pending'
          ? (fp.data?.stateHold
              ? 'In line — not yet available in your state; you keep your place'
              : 'You’re in line — we’ll reach out when it’s your turn')
        : fpInquiry?.status === 'declined' ? null
        : fpApproved
          ? (!me?.achVerified ? '⚠ Approved — verify your bank account to enroll' : '✓ Approved — pick your pull date 1–28')
          : 'For SSI/SSDI recipients — tap to request access',
      locked: fpLaunched && fpApproved && !me?.achVerified,
      ctaLabel: !fpLaunched ? 'Take the survey' : fpApproved ? 'Enroll' : 'I’m interested',
      // statusBadge REPLACES the CTA button — so in survey mode only
      // the already-surveyed state gets one (nothing more to do);
      // the not-yet-surveyed state keeps the "Take the survey" CTA.
      statusBadge: !fpLaunched
        ? (fpInquiry ? { text: 'Interest recorded', tone: 'b-green' } : null)
        : fpInquiry?.status === 'pending' ? { text: 'Request received', tone: 'b-amber' }
        : fpInquiry?.status === 'declined' ? { text: 'Not available right now', tone: 'b-muted' }
        : null,
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

  // S541: only rolled-out products render; none rolled out → no page.
  const visibleServices = services.filter(s =>
    s.id === 'credit' ? flexVis.flexcredit :
    s.id === 'flexpay' ? flexVis.flexpay :
    flexVis.flexdeposit)
  if (!flexVis.any) return <Navigate to="/home" replace />

  return (
    <div>
      <div className="ph">
        <div><h1 className="pt">Flex Advantage</h1><p className="ps">All services are voluntary. No mandatory fees.</p></div>
      </div>
      <div className="alert a-blue" style={{marginBottom:24}}>
        ℹ️ None of these services are required as a condition of your tenancy. Subscribe only if they benefit you.
      </div>
      <div className="grid3">
        {visibleServices.map(s => (
          <div key={s.id} className={`service-card${s.enrolled?' enrolled':''}`}>
            <div>
              <div style={{fontFamily:'var(--font-d)',fontWeight:700,fontSize:'1rem',color:'var(--t0)',marginBottom:6}}>{s.name}</div>
              <div style={{fontSize:'.82rem',color:'var(--t2)',lineHeight:1.5}}>{s.desc}</div>
            </div>
            {s.highlight && <div style={{fontSize:'.75rem',color:'var(--t3)',background:'var(--bg4)',padding:'6px 10px',borderRadius:6}}>{s.highlight}</div>}
            {(s as any).warning && <div className="alert a-warn" style={{fontSize:'.75rem',margin:0,lineHeight:1.45}}>⏸ {(s as any).warning}</div>}
            <div className="dr" style={{border:'none',padding:0}}>
              <span className="price-tag">{s.price}</span>
              {s.enrolled
                ? <span style={{display:'flex',gap:8,alignItems:'center'}}>
                    <span className={`badge ${(s as any).warning ? 'b-amber' : 'b-green'}`}>{(s as any).warning ? '⏸ Paused' : '✓ Active'}</span>
                    {s.id==='flexpay' && !(s as any).warning && <button className="btn btn-g btn-sm" onClick={()=>setFlexPayChangeModal(true)}>Change day</button>}
                  </span>
                : (s as any).statusBadge
                ? <span className={`badge ${(s as any).statusBadge.tone}`}>{(s as any).statusBadge.text}</span>
                : (s as any).locked
                ? <span className="badge b-muted">🔒 Locked</span>
                : <button className="btn btn-p btn-sm" onClick={s.action} disabled={s.loading}>{s.loading?<span className="spinner"/>:((s as any).ctaLabel || 'Enroll')}</button>}
            </div>
          </div>
        ))}
      </div>


      {/* S542b: proof-of-income upload — the tenant shows proof TO THE
          PLATFORM (never the landlord). FlexPay is hard-gated to proven
          SSI/SSDI; imported tenants have no income on file, so this is
          how anyone gets verified. */}
      {/* S545 (Nic): proof of benefits is part of the INTEREST flow —
          no approval happens without a document on file, so the ask
          starts as soon as a request exists (survey mode included). */}
      {flexVis.flexpay && fpInquiry?.status === 'pending' && (
        <FlexPayProofCard
          proofName={fpInquiry?.proofOriginalName ?? null}
          onUploaded={() => fp.refetch()}
        />
      )}

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

    {flexPayModal && (
        <FlexPayModal
          onClose={() => setFlexPayModal(false)}
          onSuccess={() => { qc2.refetch(); fp.refetch(); setFlexPayModal(false) }}
        />
      )}
      {flexPayInquireModal && (
        <FlexPayInquireModal
          survey={!fpLaunched}
          onClose={() => setFlexPayInquireModal(false)}
          onSuccess={() => { fp.refetch(); setFlexPayInquireModal(false) }}
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
      {featureModal && (
        <FeatureRequestModal
          onClose={() => setFeatureModal(false)}
          onSuccess={() => setFeatureModal(false)}
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
          <button onClick={()=>setFeatureModal(true)}
            style={{display:'inline-flex',alignItems:'center',gap:7,padding:'8px 16px',borderRadius:8,background:'rgba(59,130,246,.12)',border:'1px solid rgba(59,130,246,.3)',color:'#93c5fd',fontWeight:600,fontSize:'.78rem',cursor:'pointer',whiteSpace:'nowrap'}}>
            Submit Request →
          </button>
        </div>
      </div>
    </div>
  )
}

// ── MAINTENANCE PAGE ──────────────────────────────────────────
// S554 (button-sweep bug #11): the inline MaintenancePage (no comment
// surface) was removed. The real page with the tenant comment thread
// lives in ./pages/MaintenancePage, imported at the top of this file.

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
                  <td><span className={`badge ${statusBadge(r.status)}`}>{statusLabel(r.inspectionType, r.status)}</span></td>
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
// S550: on a periodic, 'tenant_signed' means the tenant SUBMITTED their
// walkthrough (no signature exists — signing is move-in only).
function statusLabel(type: string, status: string) {
  if (type === 'periodic' && status === 'tenant_signed') return 'Submitted'
  return humanize(status)
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
  // S573: which areas still need a photo before this walkthrough can be submitted.
  const { data: completeness } = useQuery<any>(
    ['tenant-inspection-completeness', id],
    () => get<any>(`/inspections/${id}/completeness`),
  )
  const signMut = useMutation(
    () => post(`/inspections/${id}/sign`),
    {
      onSuccess: () => qc.invalidateQueries(['tenant-inspection', id]),
      onError: (e: any) => setError(e?.response?.data?.error || 'Sign failed'),
    },
  )
  const submitMut = useMutation(
    () => post(`/inspections/${id}/submit`),
    {
      onSuccess: () => qc.invalidateQueries(['tenant-inspection', id]),
      onError: (e: any) => setError(e?.response?.data?.error || 'Submit failed'),
    },
  )
  const [camera, setCamera] = useState<null | 'photo' | 'video'>(null)
  const [areaCaptureItemId, setAreaCaptureItemId] = useState<string | null>(null)
  const [videoSaved, setVideoSaved] = useState(false)
  const photoMut = useMutation(
    ({ file, live, itemId }: { file: File; live?: boolean; itemId?: string }) => {
      const fd = new FormData(); fd.append('file', file); if (live) fd.append('capturedLive', 'true')
      if (itemId) fd.append('itemId', itemId)
      return api.post(`/inspections/${id}/photos`, fd, { headers: { 'Content-Type': 'multipart/form-data' } }).then(r => r.data)
    },
    { onSuccess: () => { setAreaCaptureItemId(null); qc.invalidateQueries(['tenant-inspection', id]); qc.invalidateQueries(['tenant-inspection-completeness', id]) }, onError: (e: any) => setError(e?.response?.data?.error || 'Upload failed') },
  )
  // S550 (Nic): on-the-go issue reporting — "bedroom window is broken" +
  // an immediate photo, recorded as its own checklist finding.
  const [issueText, setIssueText] = useState('')
  const [issueItemId, setIssueItemId] = useState<string | null>(null)
  const addIssueMut = useMutation(
    (label: string) => post<{ id: string }>(`/inspections/${id}/items`, {
      area: 'Reported issues', itemLabel: label, condition: 'damaged_missing', notes: label,
    }),
    {
      onSuccess: (r: any) => {
        setIssueText('')
        qc.invalidateQueries(['tenant-inspection', id])
        const newId = r?.id ?? r?.data?.id ?? null
        setIssueItemId(newId)
        setCamera('photo')
      },
      onError: (e: any) => setError(e?.response?.data?.error || 'Could not add the issue'),
    },
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

  // S573: group by area + which areas already have a photo (photo → item → area).
  const itemAreaById = new Map(items.map((i: any) => [i.id, i.area]))
  const photographedAreas = new Set<string>()
  for (const p of photos) if (p.itemId && itemAreaById.has(p.itemId)) photographedAreas.add(itemAreaById.get(p.itemId) as string)
  const areaOrder: string[] = []
  const areaItems = new Map<string, any[]>()
  for (const it of items) {
    if (!areaItems.has(it.area)) { areaItems.set(it.area, []); areaOrder.push(it.area) }
    areaItems.get(it.area)!.push(it)
  }
  const areasNeedingPhoto: string[] = completeness?.areasMissingPhoto ?? []

  return (
    <div>
      <div className="ph">
        <div>
          <button className="btn btn-g btn-sm" onClick={() => navigate('/inspections')} style={{ marginBottom: 8 }}>← Inspections</button>
          <h1 className="pt">{labelType(insp.inspectionType)} Inspection</h1>
          <p className="ps">
            <span className={`badge ${statusBadge(insp.status)}`}>{statusLabel(insp.inspectionType, insp.status)}</span>
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
              {areaOrder.map(area => (
                <React.Fragment key={area}>
                  <tr style={{ background: 'var(--bg3)' }}>
                    <td colSpan={4} style={{ padding: '8px 12px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                        <strong style={{ color: 'var(--t0)', fontSize: '.85rem' }}>{area}</strong>
                        {photographedAreas.has(area)
                          ? <span className="badge b-green" style={{ fontSize: '.62rem' }}>✓ photo</span>
                          : <span className="badge b-amber" style={{ fontSize: '.62rem' }}>photo needed</span>}
                        {editable && (
                          <button className="btn btn-g btn-sm" style={{ padding: '1px 10px' }}
                            onClick={() => { setAreaCaptureItemId(areaItems.get(area)![0].id); setCamera('photo') }}>
                            📷 {photographedAreas.has(area) ? 'Add photo' : 'Take photo'}
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                  {areaItems.get(area)!.map(it => (
                    <tr key={it.id}>
                      <td />
                      <td style={{ color: 'var(--t0)' }}>{it.itemLabel}</td>
                      <td>{it.condition ? <span className={`badge ${
                        it.condition === 'excellent' || it.condition === 'good' ? 'b-green' :
                        it.condition === 'fair' ? 'b-amber' :
                        it.condition === 'damaged_missing' ? 'b-red' : 'b-muted'
                      }`}>{INSPECTION_ITEM_CONDITION_LABEL[it.condition as keyof typeof INSPECTION_ITEM_CONDITION_LABEL] ?? it.condition}</span> : <span className="badge b-muted">Not inspected</span>}</td>
                      <td style={{ fontSize: '.8rem', color: 'var(--t2)' }}>{it.notes || '—'}</td>
                    </tr>
                  ))}
                </React.Fragment>
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

      {insp.status === 'draft' && (
        <div className="card" style={{ padding: 16, marginBottom: 16 }}>
          <strong style={{ color: 'var(--t0)', display: 'block', marginBottom: 6 }}>Spot something wrong?</strong>
          <div style={{ fontSize: '.8rem', color: 'var(--t2)', marginBottom: 10 }}>
            Add it here as you go — e.g. "bedroom window is broken" — then snap a photo of it.
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              className="input"
              placeholder="What's wrong, and where?"
              value={issueText}
              onChange={e => setIssueText(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && issueText.trim().length >= 3) addIssueMut.mutate(issueText.trim()) }}
              style={{ flex: 1 }}
            />
            <button
              className="btn btn-p"
              onClick={() => addIssueMut.mutate(issueText.trim())}
              disabled={addIssueMut.isLoading || issueText.trim().length < 3}
            >
              {addIssueMut.isLoading ? 'Adding…' : '📷 Add & photograph'}
            </button>
          </div>
        </div>
      )}

      {/* S550: signing is MOVE-IN ONLY. A periodic is SUBMITTED (the photos
          taken while logged into this portal are the attestation); a move-out
          is staff-conducted in person — no tenant action at all. */}
      {insp.inspectionType === 'move_in' && insp.status !== 'finalized' && insp.status !== 'cancelled' && !tenantSigned && (
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

      {insp.inspectionType === 'periodic' && insp.status === 'draft' && (
        <div className="card" style={{ padding: 16, background: 'rgba(201,162,39,.05)', border: '1px solid rgba(201,162,39,.25)' }}>
          <strong style={{ color: 'var(--gold)', display: 'block', marginBottom: 6 }}>Done with your walkthrough?</strong>
          <div style={{ fontSize: '.82rem', color: 'var(--t2)', marginBottom: 12 }}>
            Submit your photos for review. No signature needed — you took these photos
            signed into your own portal, and that's your attestation.
          </div>
          <button
            className="btn btn-p"
            onClick={() => submitMut.mutate()}
            disabled={submitMut.isLoading || areasNeedingPhoto.length > 0}
          >
            {submitMut.isLoading ? 'Submitting…' : 'Submit walkthrough'}
          </button>
          {areasNeedingPhoto.length > 0 && (
            <div style={{ fontSize: '.75rem', color: 'var(--amber)', marginTop: 6 }}>
              Photo still needed for: {areasNeedingPhoto.slice(0, 6).join(', ')}{areasNeedingPhoto.length > 6 ? '…' : ''}
            </div>
          )}
        </div>
      )}

      {insp.inspectionType === 'periodic' && insp.status === 'tenant_signed' && (
        <div className="card" style={{ padding: 16, background: 'rgba(34,197,94,.05)', border: '1px solid rgba(34,197,94,.25)' }}>
          <strong style={{ color: 'var(--green)' }}>✓ Walkthrough submitted.</strong>
          <div style={{ fontSize: '.82rem', color: 'var(--t2)', marginTop: 4 }}>
            The front desk will review your photos.
          </div>
        </div>
      )}

      {insp.inspectionType === 'move_in' && tenantSigned && (
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
          onClose={() => { setCamera(null); setIssueItemId(null); setAreaCaptureItemId(null) }}
          onCapture={(file) => {
            if (camera === 'photo') photoMut.mutate({ file, live: true, itemId: issueItemId ?? areaCaptureItemId ?? undefined })
            else videoMut.mutate({ file, live: true })
            setIssueItemId(null)
          }}
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
  const qc = useQueryClient()
  // S571: the tenant's OWN manually-captured walkthroughs (photos/video).
  const { data: mine = [] } = useQuery<any[]>('tenant-walkthrough-mine', () =>
    get<any[]>('/tenant-walkthroughs/mine'))
  // Walkthrough videos recorded DURING inspections (existing, read-only).
  const { data: fromInspections = [] } = useQuery<any[]>('tenant-my-walkthroughs', () =>
    get<any[]>('/inspections/videos/mine'))

  const [cameraMode, setCameraMode] = useState<null | 'photo' | 'video'>(null)
  const [caption, setCaption] = useState('')
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState('')

  const uploadOne = async (file: File) => {
    setUploading(true); setError('')
    try {
      const fd = new FormData()
      fd.append('file', file)
      fd.append('capturedLive', 'true')
      if (caption.trim()) fd.append('caption', caption.trim())
      await api.post('/tenant-walkthroughs/media', fd)
      setCaption('')
      qc.invalidateQueries('tenant-walkthrough-mine')
    } catch (e: any) {
      setError(e?.response?.data?.error || 'Upload failed. Please try again.')
    }
    setUploading(false)
  }

  return (
    <div>
      <div className="ph">
        <div>
          <h1 className="pt">My walkthroughs</h1>
          <p className="ps">Document your unit whenever you want — your own photos and video, kept as your record.</p>
        </div>
      </div>

      {/* Start a new walkthrough */}
      <div className="card" style={{ padding: 16, marginBottom: 16 }}>
        <div style={{ fontSize: '.85rem', fontWeight: 700, color: 'var(--t0)', marginBottom: 4 }}>Start a new walkthrough</div>
        <div style={{ fontSize: '.75rem', color: 'var(--t3)', marginBottom: 12, lineHeight: 1.5 }}>
          Take photos or a video of your unit — move-in condition, a repair, anything you want on record. Captured live through your camera (not uploaded from your library). Your landlord can view it but can’t delete it.
        </div>
        <input className="inp" placeholder="Optional note (e.g. 'kitchen — move-in condition')" value={caption} onChange={e => setCaption(e.target.value)} style={{ marginBottom: 10, maxWidth: 460 }} />
        {error && <div className="alert a-warn" style={{ marginBottom: 10 }}>{error}</div>}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button className="btn btn-p" disabled={uploading} onClick={() => setCameraMode('photo')}>
            {uploading ? <span className="spinner" /> : '📷 Take photo'}
          </button>
          <button className="btn btn-g" disabled={uploading} onClick={() => setCameraMode('video')}>
            🎥 Record video
          </button>
        </div>
      </div>

      {cameraMode && (
        <CameraCapture mode={cameraMode} onCapture={(file) => uploadOne(file)} onClose={() => setCameraMode(null)} />
      )}

      {/* The tenant's own uploads */}
      {mine.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 12, marginBottom: 20 }}>
          {mine.map((m: any) => (
            <div key={m.id} className="card" style={{ padding: 10 }}>
              {m.mediaType === 'video'
                ? <AuthedVideo path={m.fileUrl} style={{ width: '100%', borderRadius: 8, background: '#000', aspectRatio: '16/9' }} />
                : <AuthedImg path={m.fileUrl} alt={m.caption || 'walkthrough'} style={{ width: '100%', borderRadius: 8, aspectRatio: '16/9', objectFit: 'cover' }} />}
              <div style={{ marginTop: 6, fontSize: '.75rem', color: 'var(--t2)' }}>
                {m.caption || (m.mediaType === 'video' ? 'Video' : 'Photo')}
              </div>
              <div style={{ fontSize: '.7rem', color: 'var(--t3)' }}>
                {m.unitNumber ? `Unit ${m.unitNumber} · ` : ''}{new Date(m.createdAt).toLocaleDateString()}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Recorded during inspections */}
      {fromInspections.length > 0 && (
        <>
          <div className="nav-lbl" style={{ padding: '4px 0 8px' }}>From inspections</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 16 }}>
            {fromInspections.map(v => (
              <div key={v.id} className="card" style={{ padding: 12 }}>
                <AuthedVideo path={v.videoUrl} style={{ width: '100%', borderRadius: 8, background: '#000', aspectRatio: '16/9' }} />
                <div style={{ marginTop: 8, fontSize: '.82rem', color: 'var(--t0)' }}>
                  {labelType(v.inspectionType)} · Unit {v.unitNumber || '—'}
                </div>
                <div style={{ fontSize: '.75rem', color: 'var(--t3)' }}>
                  {v.propertyName} · {new Date(v.uploadedAt).toLocaleDateString()}
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {mine.length === 0 && fromInspections.length === 0 && (
        <div className="card" style={{ padding: 24, textAlign: 'center', color: 'var(--t3)' }}>
          No walkthroughs yet. Use “Add photos or video” above to start your first one.
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
  const label = EVENT_LABEL[ev.eventType] || humanize(ev.eventType)
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
    default:                      return humanize(src)
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
          <strong style={{ color: 'var(--t0)' }}>{EVENT_LABEL[ev.eventType] || humanize(ev.eventType)}</strong>
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
    (body: { type: string; emailEnabled: boolean; inAppEnabled: boolean }) =>
      api.patch('/notifications/preferences', body).then(r => r.data),
    {
      onSuccess: () => qc.invalidateQueries('notification-prefs'),
    },
  )

  const toggle = (type: string, currentVal: boolean) => {
    // S554 (button-sweep bug #4): responses are camelized, so an existing
    // pref lands as emailEnabled/inAppEnabled. The default MUST use the
    // same camelCase keys — a snake-case default left inAppEnabled
    // undefined on the (common) no-existing-row path, and the API's
    // zod .boolean() then 400'd the PATCH, so no pref ever saved.
    const current = prefMap.get(type) || { emailEnabled: true, inAppEnabled: true }
    update.mutate({ type, emailEnabled: !currentVal, inAppEnabled: current.inAppEnabled ?? true })
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
        ℹ️ In-app notifications always show in your dashboard. Email is an
        optional channel per notification type.
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
              </tr>
            </thead>
            <tbody>
              {TENANT_NOTIFICATION_TYPES.map(({ type, label }) => {
                const p = prefMap.get(type) || { emailEnabled: true, inAppEnabled: true }
                return (
                  <tr key={type}>
                    <td style={{ color: 'var(--t0)' }}>{label}</td>
                    <td style={{ textAlign: 'center' }}>
                      <input type="checkbox" checked={p.emailEnabled} onChange={() => toggle(type, p.emailEnabled)} />
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
                    <td><span className={`badge ${disputeStatusBadgeTenant(d.status)}`}>{humanize(d.status)}</span></td>
                    <td style={{ color: 'var(--t0)' }}>
                      {EVENT_LABEL[d.disputedEventType] || humanize(d.disputedEventType)}
                      <div style={{ fontSize: '.7rem', color: 'var(--t3)' }}>{new Date(d.disputedEventOccurredAt).toLocaleDateString()}</div>
                    </td>
                    <td style={{ fontSize: '.78rem' }}>{humanize(d.reason)}</td>
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
          <strong style={{ color: 'var(--t0)' }}>{EVENT_LABEL[dispute.disputedEventType] || humanize(dispute.disputedEventType)}</strong>
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
  // W-44 (S531): areas the landlord opted in can host PRIVATE EVENTS — a
  // non-refundable deposit (if set) locks it in; everyone at the property
  // is notified once it's paid.
  const eventsEnabled = (area as any).eventsEnabled === true
  const eventDeposit = Number((area as any).eventDepositAmount || 0)
  const [kind, setKind] = useState<'tenant_reservation' | 'event'>('tenant_reservation')
  const m = useMutation(
    () => post(`/common-areas/${area.id}/request`, {
      title: f.title || undefined, kind,
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
        {eventsEnabled && (
          <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
            {([['tenant_reservation', 'Regular reservation'], ['event', 'Private event']] as const).map(([k, label]) => (
              <button key={k} className={'btn btn-sm' + (kind === k ? ' btn-g' : '')} onClick={() => setKind(k)}>{label}</button>
            ))}
          </div>
        )}
        {kind === 'event' && (
          <div style={{ fontSize: '.78rem', color: 'var(--t2,#b8c4d8)', background: 'rgba(201,162,39,.08)', border: '1px solid rgba(201,162,39,.3)', borderRadius: 8, padding: '8px 12px', marginBottom: 10 }}>
            {eventDeposit > 0
              ? <>Books the space privately for your event. A <b>non-refundable ${eventDeposit.toFixed(2)}</b> deposit locks it in — everyone at the property is notified once it's paid. Unpaid by the start time, the space opens back up.</>
              : <>Books the space privately for your event — everyone at the property is notified when it's approved.</>}
          </div>
        )}
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
          <div>{humanize(r.reasonCategory)}</div>
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

// S535: documents live behind the authed /api/documents/:id/file stream
// (the static /uploads mount no longer serves them). Browser <a> can't
// carry the Bearer token, so the click handler fetches with auth and
// opens a blob URL in a new tab — same S213 pattern as addendum PDFs.
async function openAuthedUrl(fullOrRelUrl: string) {
  const token = localStorage.getItem('gam_tenant_token') || ''
  const url = fullOrRelUrl.startsWith('http') ? fullOrRelUrl : `${API_URL}${fullOrRelUrl}`
  const res = await fetch(url, { headers: { Authorization: 'Bearer ' + token } })
  if (!res.ok) { toast.error('Could not load document (status ' + res.status + ')'); return }
  window.open(URL.createObjectURL(await res.blob()), '_blank')
}
const openDocumentFile = (docId: string) => openAuthedUrl(`/api/documents/${docId}/file`)

function DocumentsPage() {
  const { data: docs = [], isLoading } = useQuery<any[]>('docs', () => get<any[]>('/documents'))
  // S571: the signed lease PDF lives in e-sign (rendered in-browser on the Lease
  // page); surface it here too as an easy download/print option, alongside the
  // landlord's uploaded agreements, notices, receipts, etc.
  const { data: leases = [] } = useQuery<any[]>('doc-leases', () => get<any[]>('/tenants/leases'))
  // Tenants only reach the portal after signing, so a lease shown here is
  // executed — never "pending signature." Exclude any not-yet-signed lease
  // (awaiting-signature states); keep active AND expired/ended leases for the
  // tenant's full history.
  const AWAITING = new Set(['pending', 'draft', 'needs_review', 'awaiting_signature'])
  const leaseDocs = (leases as any[]).filter(l => l.documentUrl && !AWAITING.has(l.status))
  const isEmpty = !docs.length && !leaseDocs.length
  const fmtD = (d: any) => d ? new Date(d).toLocaleDateString() : '—'
  return (
    <div>
      <div className="ph"><div><h1 className="pt">Documents</h1><p className="ps">Your lease, agreements, and notices — download or print</p></div></div>
      <div className="card" style={{padding:0,overflowX:'auto'}}>
        {isLoading ? <div style={{padding:32,color:'var(--t3)',textAlign:'center'}}>Loading…</div> : (
          <table className="tbl" style={{minWidth:640}}>
            <thead><tr><th>Document</th><th>Type</th><th>Status</th><th>Date</th><th></th></tr></thead>
            <tbody>
              {leaseDocs.map((l:any)=>{
                const active = l.status === 'active'
                return (
                <tr key={l.id}>
                  <td style={{color:'var(--t0)'}}>
                    Lease — {l.propertyName}{l.unitNumber?` · Unit ${l.unitNumber}`:''}
                    <div style={{fontSize:'.72rem',color:'var(--t3)',marginTop:2}}>Term: {fmtD(l.startDate)} – {l.endDate?fmtD(l.endDate):'ongoing'}</div>
                  </td>
                  <td><span className="badge b-muted">Lease</span></td>
                  <td><span className={`badge ${active?'b-green':'b-muted'}`}>{active?'Active':'Expired'}</span></td>
                  <td className="mono" style={{fontSize:'.75rem',color:'var(--t3)'}}>{fmtD(l.signedAt || l.startDate)}</td>
                  <td><button onClick={()=>openAuthedUrl(l.documentUrl)} className="btn btn-g btn-sm">Download</button></td>
                </tr>
              )})}
              {docs.map((d:any)=>(
                <tr key={d.id}>
                  <td style={{color:'var(--t0)'}}>{d.name}</td>
                  <td><span className="badge b-muted">{humanize(d.type)}</span></td>
                  <td><span className={`badge ${d.signedAt?'b-green':'b-amber'}`}>{d.signedAt?'Signed':'Pending signature'}</span></td>
                  <td className="mono" style={{fontSize:'.75rem',color:'var(--t3)'}}>{new Date(d.createdAt).toLocaleDateString()}</td>
                  <td><button onClick={()=>openDocumentFile(d.id)} className="btn btn-g btn-sm">Download</button></td>
                </tr>
              ))}
              {isEmpty && <tr><td colSpan={5} style={{textAlign:'center',color:'var(--t3)',padding:32}}>No documents yet.</td></tr>}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}

// ── LOGIN ─────────────────────────────────────────────────────
function LoginPage() {
  const { login, loginWithTotp, loginWithEmailOtp, resendEmailOtp } = useAuth(); const navigate = useNavigate()
  const [err, setErr] = useState(''); const [loading, setLoading] = useState(false)
  const [totpSession, setTotpSession] = useState<string|null>(null)
  const [emailOtpSession, setEmailOtpSession] = useState<string|null>(null)
  const [resent, setResent] = useState(false)
  const [code, setCode] = useState('')
  const { register, handleSubmit } = useForm<{email:string;password:string}>()
  const onSubmit = async(d:{email:string;password:string})=>{
    setLoading(true);setErr('')
    try{
      const r = await login(d.email,d.password)
      if(r.kind==='totp_required'){setTotpSession(r.totpSession);setCode('')}
      else if(r.kind==='email_otp_required'){setEmailOtpSession(r.emailOtpSession);setCode('');setResent(false)}
      else navigate('/home')
    }
    catch(e:any){setErr(e.response?.data?.error||'Login failed')}
    finally{setLoading(false)}
  }
  const onEmailOtpSubmit = async(e:React.FormEvent)=>{
    e.preventDefault();setLoading(true);setErr('')
    try{ await loginWithEmailOtp(emailOtpSession!,code.trim()); navigate('/home') }
    catch(ex:any){
      const msg=ex.response?.data?.error||'Invalid code.'
      setErr(msg)
      if(/session/i.test(msg)){setEmailOtpSession(null);setCode('')}
    }
    finally{setLoading(false)}
  }
  const onResend = async()=>{
    setErr('')
    try{ await resendEmailOtp(emailOtpSession!); setResent(true) }
    catch{ setErr('Could not resend the code. Please try again.') }
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

  // ── Step 2 (email 2FA): emailed code ──────────────────────────
  if(emailOtpSession){
    return (
      <div style={{minHeight:'100vh',display:'flex',alignItems:'center',justifyContent:'center',background:'var(--bg0)',padding:20}}>
        <div style={{width:'100%',maxWidth:400}}>
          <div style={{textAlign:'center',marginBottom:40}}>
            <div style={{fontFamily:'var(--font-d)',fontSize:'2rem',fontWeight:800,color:'var(--gold)',marginBottom:8}}>⚡ GAM</div>
            <div style={{color:'var(--t2)',fontSize:'.875rem'}}>Two-factor authentication</div>
          </div>
          <div className="card" style={{padding:28}}>
            <h2 style={{marginBottom:14}}>Check your email</h2>
            <div style={{fontSize:'.85rem',color:'var(--t1)',marginBottom:16,lineHeight:1.6}}>
              We sent a 6-digit code to your email. Enter it below to finish signing in.
            </div>
            {err && <div className="alert a-warn" style={{marginBottom:16}}>{err}</div>}
            {resent && !err && <div className="alert a-green" style={{marginBottom:16}}>A new code is on its way.</div>}
            <form onSubmit={onEmailOtpSubmit}>
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
                  inputMode="numeric"
                  placeholder="123 456"
                  style={{fontFamily:'var(--font-m)',letterSpacing:'.2em',textAlign:'center'}}
                />
              </div>
              <button className="btn btn-p" type="submit" disabled={loading||!code.trim()} style={{width:'100%',justifyContent:'center',marginTop:8}}>
                {loading?<span className="spinner"/>:'Verify'}
              </button>
            </form>
            <div style={{marginTop:16,display:'flex',justifyContent:'space-between',alignItems:'center'}}>
              <button onClick={()=>{setEmailOtpSession(null);setCode('');setErr('');setResent(false)}} style={{background:'none',border:'none',color:'var(--t2)',fontSize:'.85rem',cursor:'pointer',textDecoration:'underline'}}>
                ← Back to sign in
              </button>
              <button onClick={onResend} style={{background:'none',border:'none',color:'var(--gold)',fontSize:'.85rem',cursor:'pointer',textDecoration:'underline'}}>
                Resend code
              </button>
            </div>
          </div>
        </div>
      </div>
    )
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
          <div style={{ marginTop: 16, display:'flex', justifyContent:'space-between', alignItems:'center' }}>
            <Link to="/forgot-password" style={{ color: 'var(--gold)', fontSize: '.85rem', textDecoration: 'none' }}>
              Forgot password?
            </Link>
            <Link to="/signup" style={{ color: 'var(--gold)', fontSize: '.85rem', textDecoration: 'none' }}>
              Create account
            </Link>
          </div>
        </div>
        {/* S578: renter-pool entry is now account-first — create an account
            (with 2FA), then get screened from inside the gated portal. */}
        <div className="card" style={{ padding: 20, marginTop: 16, textAlign: 'center' }}>
          <div style={{ fontSize: '.9rem', fontWeight: 700, color: 'var(--gold)', marginBottom: 6 }}>Looking for a place to live?</div>
          <div style={{ fontSize: '.8rem', color: 'var(--t1)', lineHeight: 1.6, marginBottom: 14 }}>
            Create your account, get background-checked once, and join the renter pool — landlords with open units find you. No chosen property needed to start.
          </div>
          <Link to="/signup" className="btn btn-p" style={{ width: '100%', justifyContent: 'center', textDecoration: 'none' }}>
            Get started
          </Link>
        </div>
      </div>
    </div>
  )
}

// S578: prospect self-signup — account created FIRST, with mandatory email-2FA,
// as its own step (NOT inline in the background check). name/email/password →
// emailed 6-digit code → verify → land in the gated portal, which shows only
// "complete your background check" until it's done. A landlordId/unitId in the
// URL (from a landlord invite / listing) rides along for property attribution.
function SignupPage() {
  const { signup, loginWithEmailOtp, resendEmailOtp } = useAuth(); const navigate = useNavigate()
  const params = new URLSearchParams(window.location.search)
  const landlordId = params.get('landlordId'); const unitId = params.get('unitId')
  const [err, setErr] = useState(''); const [loading, setLoading] = useState(false)
  const [emailOtpSession, setEmailOtpSession] = useState<string|null>(null)
  const [resent, setResent] = useState(false); const [code, setCode] = useState('')
  const { register, handleSubmit, watch } = useForm<{firstName:string;lastName:string;email:string;password:string;confirmPassword:string;acceptedTerms:boolean}>()
  const pw = watch('password')
  const onSubmit = async(d:{firstName:string;lastName:string;email:string;password:string;confirmPassword:string;acceptedTerms:boolean})=>{
    setErr('')
    if(d.password!==d.confirmPassword){setErr('Passwords do not match');return}
    if(d.password.length<12){setErr('Password must be at least 12 characters');return}
    if(!d.acceptedTerms){setErr('You must accept the Terms of Service and Privacy Policy');return}
    setLoading(true)
    try{
      const r = await signup({ firstName:d.firstName, lastName:d.lastName, email:d.email, password:d.password, acceptedTerms:true, landlordId, unitId })
      setEmailOtpSession(r.emailOtpSession); setCode(''); setResent(false)
    }
    catch(e:any){setErr(e.response?.data?.error||'Could not create your account')}
    finally{setLoading(false)}
  }
  const onEmailOtpSubmit = async(e:React.FormEvent)=>{
    e.preventDefault();setLoading(true);setErr('')
    try{ await loginWithEmailOtp(emailOtpSession!,code.trim()); navigate('/') }
    catch(ex:any){
      const msg=ex.response?.data?.error||'Invalid code.'
      setErr(msg)
      if(/session/i.test(msg)){setEmailOtpSession(null);setCode('')}
    }
    finally{setLoading(false)}
  }
  const onResend = async()=>{
    setErr('')
    try{ await resendEmailOtp(emailOtpSession!); setResent(true) }
    catch{ setErr('Could not resend the code. Please try again.') }
  }

  // ── Step 2: emailed 2FA code ──────────────────────────────────
  if(emailOtpSession){
    return (
      <div style={{minHeight:'100vh',display:'flex',alignItems:'center',justifyContent:'center',background:'var(--bg0)',padding:20}}>
        <div style={{width:'100%',maxWidth:400}}>
          <div style={{textAlign:'center',marginBottom:40}}>
            <div style={{fontFamily:'var(--font-d)',fontSize:'2rem',fontWeight:800,color:'var(--gold)',marginBottom:8}}>⚡ GAM</div>
            <div style={{color:'var(--t2)',fontSize:'.875rem'}}>Verify your email</div>
          </div>
          <div className="card" style={{padding:28}}>
            <h2 style={{marginBottom:14}}>Check your email</h2>
            <div style={{fontSize:'.85rem',color:'var(--t1)',marginBottom:16,lineHeight:1.6}}>
              We sent a 6-digit code to your email. Enter it to finish creating your account.
            </div>
            {err && <div className="alert a-warn" style={{marginBottom:16}}>{err}</div>}
            {resent && !err && <div className="alert a-green" style={{marginBottom:16}}>A new code is on its way.</div>}
            <form onSubmit={onEmailOtpSubmit}>
              <div className="fg">
                <label className="fl">Code</label>
                <input className="fi" type="text" value={code} onChange={e=>setCode(e.target.value)} autoFocus required autoComplete="one-time-code" inputMode="numeric" placeholder="123 456" style={{fontFamily:'var(--font-m)',letterSpacing:'.2em',textAlign:'center'}} />
              </div>
              <button className="btn btn-p" type="submit" disabled={loading||!code.trim()} style={{width:'100%',justifyContent:'center',marginTop:8}}>
                {loading?<span className="spinner"/>:'Verify'}
              </button>
            </form>
            <div style={{marginTop:16,display:'flex',justifyContent:'space-between',alignItems:'center'}}>
              <button onClick={()=>{setEmailOtpSession(null);setCode('');setErr('');setResent(false)}} style={{background:'none',border:'none',color:'var(--t2)',fontSize:'.85rem',cursor:'pointer',textDecoration:'underline'}}>← Back</button>
              <button onClick={onResend} style={{background:'none',border:'none',color:'var(--gold)',fontSize:'.85rem',cursor:'pointer',textDecoration:'underline'}}>Resend code</button>
            </div>
          </div>
        </div>
      </div>
    )
  }

  // ── Step 1: account details ───────────────────────────────────
  return (
    <div style={{minHeight:'100vh',display:'flex',alignItems:'center',justifyContent:'center',background:'var(--bg0)',padding:20}}>
      <div style={{width:'100%',maxWidth:400}}>
        <div style={{textAlign:'center',marginBottom:40}}>
          <div style={{fontFamily:'var(--font-d)',fontSize:'2rem',fontWeight:800,color:'var(--gold)',marginBottom:8}}>⚡ GAM</div>
          <div style={{color:'var(--t2)',fontSize:'.875rem'}}>Create your account</div>
        </div>
        <div className="card" style={{padding:28}}>
          <h2 style={{marginBottom:20}}>Sign up</h2>
          {err && <div className="alert a-warn" style={{marginBottom:16}}>{err}</div>}
          <form onSubmit={handleSubmit(onSubmit)}>
            <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10}}>
              <div className="fg"><label className="fl">First name</label><input className="fi" {...register('firstName',{required:true})} autoFocus /></div>
              <div className="fg"><label className="fl">Last name</label><input className="fi" {...register('lastName',{required:true})} /></div>
            </div>
            <div className="fg"><label className="fl">Email</label><input className="fi" type="email" {...register('email',{required:true})} /></div>
            <div className="fg"><label className="fl">Password</label><input className="fi" type="password" {...register('password',{required:true})} placeholder="At least 12 characters" /></div>
            <div className="fg"><label className="fl">Confirm password</label><input className="fi" type="password" {...register('confirmPassword',{required:true})} /></div>
            {pw && pw.length>0 && pw.length<12 && <div style={{fontSize:'.72rem',color:'var(--warn,#f59e0b)',marginTop:-6,marginBottom:10}}>{12-pw.length} more character{12-pw.length===1?'':'s'} required</div>}
            <label style={{display:'flex',alignItems:'flex-start',gap:10,cursor:'pointer',fontSize:'.8rem',color:'var(--t1)',lineHeight:1.5,margin:'4px 0 12px'}}>
              <input type="checkbox" {...register('acceptedTerms',{required:true})} style={{marginTop:2,flexShrink:0}} />
              <span>I agree to the{' '}
                <a href={`${(import.meta as any).env?.VITE_MARKETING_URL || 'http://localhost:3004'}/consumer/terms`} target="_blank" rel="noopener noreferrer" style={{color:'var(--gold)'}}>Terms of Service</a>
                {' '}and{' '}
                <a href={`${(import.meta as any).env?.VITE_MARKETING_URL || 'http://localhost:3004'}/consumer/privacy`} target="_blank" rel="noopener noreferrer" style={{color:'var(--gold)'}}>Privacy Policy</a>.
              </span>
            </label>
            <button className="btn btn-p" type="submit" disabled={loading} style={{width:'100%',justifyContent:'center',marginTop:8}}>
              {loading?<span className="spinner"/>:'Create account'}
            </button>
          </form>
          <div style={{marginTop:16,textAlign:'center'}}>
            <Link to="/login" style={{color:'var(--gold)',fontSize:'.85rem',textDecoration:'none'}}>Already have an account? Sign in</Link>
          </div>
        </div>
      </div>
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

function App() {
  const { token, loading } = useAuth()
  if (loading) return <div className="loading">Loading…</div>
  return (
    <BrowserRouter>
      <VersionWatch/>
      <TelemetryPing />
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/signup" element={<SignupPage />} />
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
          <Route path="communication"   element={<CommunicationPage />} />
          <Route path="maintenance"      element={<MaintenancePage />} />
          <Route path="lease"            element={<LeasePage />} />
          <Route path="sign/:documentId" element={<SignPage />} />
          <Route path="services"         element={<ServicesPage />} />
          {/* S571: Documents folded into the Communication dashboard (it's
              landlord→tenant paperwork). Old deep-links redirect to the tab. */}
          <Route path="documents"        element={<Navigate to="/communication?tab=documents" replace />} />
          <Route path="inspections"      element={<TenantInspectionsPage />} />
          <Route path="inspections/:id"  element={<TenantInspectionDetailPage />} />
          <Route path="walkthroughs"     element={<TenantMyWalkthroughsPage />} />
          <Route path="entry-requests"      element={<TenantEntryRequestsPage />} />
          <Route path="amenities"           element={<TenantAmenitiesPage />} />
          <Route path="work-trade"          element={<WorkTradePage />} />
          <Route path="entry-requests/:id"  element={<TenantEntryRequestDetailPage />} />
          <Route path="credit"              element={LAUNCH_HIDDEN.has('/credit') ? <Navigate to="/home" replace /> : <CreditPage />} />
          <Route path="my-disputes"         element={LAUNCH_HIDDEN.has('/my-disputes') ? <Navigate to="/home" replace /> : <MyDisputesPage />} />
          <Route path="notification-prefs"  element={<NotificationPrefsPage />} />
          <Route path="profile"          element={<ProfilePage />} />
          {/* S571: tenant 2FA moved into Profile → Security (email codes, no
              authenticator). The old standalone pages are retired — redirect. */}
          <Route path="security"         element={<Navigate to="/profile" replace />} />
          <Route path="security/enroll"  element={<Navigate to="/profile" replace />} />
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
