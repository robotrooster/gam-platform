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
import '@fontsource/dm-sans/400-italic.css'
import '@fontsource/inter/400.css'
import '@fontsource/inter/500.css'
import '@fontsource/inter/600.css'
import '@fontsource/inter/700.css'
import '@fontsource/jetbrains-mono/400.css'
import '@fontsource/jetbrains-mono/500.css'
import { SentryErrorBoundary } from './lib/sentry'
import { installDatePickerAutoClose, humanize } from '@gam/shared'
import React from 'react'
import ReactDOM from 'react-dom/client'
import { useState } from 'react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from 'react-query'
import { AuthProvider, useAuth } from './context/AuthContext'
import { LoginPage } from './pages/LoginPage'
import { SignupPage } from './pages/SignupPage'
import { POSPage } from './pages/POSPage'
import { BusinessRegisterPage } from './pages/BusinessRegisterPage'
import { TeamPage } from './pages/TeamPage'
import { LockScreen } from './pages/LockScreen'
import { ShelfLabelPage } from './pages/ShelfLabelPage'
import { DialogHost } from './components/dialogs'
import './styles/globals.css'

const qc = new QueryClient({ defaultOptions: { queries: { retry: 1, staleTime: 300000, refetchOnWindowFocus: false, refetchOnMount: false } } })

// S536 (Nic): the POS portal is the front-counter product for BOTH
// landlord teams (property mode) and businesses (business mode). Access
// is ONE-WAY / downhill: landlord-side and business logins work here,
// but consumer roles (tenant, fitness) never do — and nothing here
// grants anyone a path up into the landlord portal (its own role gate).
const BUSINESS_ROLES = ['business_owner', 'business_staff']
const DENIED_ROLES   = ['tenant', 'fitness_user']

function PrivateRoute({ children }: { children: React.ReactNode }) {
  const { user, token, terminalToken, loading, logout } = useAuth()
  if (loading) return <div className="loading-screen">Loading…</div>
  // S574: a device bound to a register (terminal token) but with no active
  // session shows the passcode lock screen, not the login page.
  if (!token && terminalToken) return <LockScreen />
  if (!token) return <Navigate to="/login" replace />
  if (user && DENIED_ROLES.includes(user.role)) {
    return (
      <div style={{minHeight:'100vh',display:'flex',alignItems:'center',justifyContent:'center',background:'var(--bg-1)'}}>
        <div style={{textAlign:'center',maxWidth:380}}>
          <div style={{fontWeight:700,fontSize:'1.05rem',marginBottom:8,color:'var(--text-0)'}}>This login doesn't have POS access</div>
          <div style={{fontSize:'.85rem',color:'var(--text-3)',marginBottom:16}}>Sign in with a POS-enabled account to use the register.</div>
          <button className="btn btn-primary" onClick={logout}>Sign in with a different account</button>
        </div>
      </div>
    )
  }
  return <>{children}</>
}

// S536 (Nic): the account name is the clickable control and Sign out
// lives INSIDE its menu — a bare Sign out button next to the name
// invited accidental sign-outs mid-shift.
function AccountMenu({ name, role, onSignOut }: { name: string; role?: string; onSignOut: () => void }) {
  const [open, setOpen] = useState(false)
  return (
    <div style={{ position: 'relative' }}>
      <button onClick={() => setOpen(o => !o)}
        onBlur={() => setTimeout(() => setOpen(false), 180)}
        style={{ background: open ? 'var(--bg-3)' : 'none', border: '1px solid ' + (open ? 'var(--border-1)' : 'transparent'), borderRadius: 8, color: 'var(--text-1)', cursor: 'pointer', fontSize: '.82rem', padding: '6px 10px', display: 'flex', alignItems: 'center', gap: 6 }}>
        {name || 'Account'} <span style={{ fontSize: '.6rem', color: 'var(--text-3)' }}>▼</span>
      </button>
      {open && (
        <div style={{ position: 'absolute', right: 0, top: '110%', zIndex: 200, background: 'var(--bg-1)', border: '1px solid var(--border-0)', borderRadius: 10, minWidth: 180, overflow: 'hidden', boxShadow: '0 8px 24px rgba(0,0,0,.4)' }}>
          {role && <div style={{ padding: '8px 12px', fontSize: '.68rem', color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.05em', borderBottom: '1px solid var(--border-1)' }}>{humanize(role)}</div>}
          <button onMouseDown={onSignOut}
            style={{ display: 'block', width: '100%', textAlign: 'left', padding: '10px 12px', background: 'none', border: 'none', color: 'var(--text-1)', cursor: 'pointer', fontSize: '.82rem' }}>
            Sign out
          </button>
        </div>
      )}
    </div>
  )
}

function POSLayout() {
  const { user, logout, posLimited, terminalToken, lockRegister } = useAuth()
  // Business logins get the business-mode register (business-pos
  // backend, business-scoped inventory). Landlord teams get the
  // property-mode register. Same door, right room.
  const isBusiness = !!user && BUSINESS_ROLES.includes(user.role)
  // S538: team management is owner-only (the API's gate; staff get 403).
  // S574: a posLimited cashier session never sees Team/Inventory — register only.
  const isOwner = user?.role === 'business_owner' && !posLimited
  const onLock = () => { void lockRegister() }
  return (
    <div style={{minHeight:'100vh',background:'var(--bg-1)'}}>
      <header style={{background:'var(--bg-2)',borderBottom:'1px solid var(--border-1)',padding:'0 20px',height:56,display:'flex',alignItems:'center',justifyContent:'space-between',position:'sticky',top:0,zIndex:100}}>
        <div style={{fontWeight:700,fontSize:'1.1rem',color:'var(--gold)'}}>⚡ GAM POS</div>
        <div style={{display:'flex',gap:16,alignItems:'center'}}>
          <a href="/pos" style={{fontSize:'.88rem',fontWeight:500}}>Register</a>
          {!isBusiness && !posLimited && <a href="/pos?tab=inventory" style={{fontSize:'.88rem',fontWeight:500}}>Inventory</a>}
          {isOwner && <a href="/team" style={{fontSize:'.88rem',fontWeight:500}}>Team</a>}
          {posLimited ? (
            // Cashier session: name is read-only; "Lock" hands the register back.
            <>
              <span style={{fontSize:'.82rem',color:'var(--text-2)'}}>{`${user?.firstName ?? ''} ${user?.lastName ?? ''}`.trim()}</span>
              <button className="btn btn-ghost btn-sm" onClick={onLock}>🔒 Lock</button>
            </>
          ) : (
            <>
              {isBusiness && (
                <button className="btn btn-ghost btn-sm" onClick={onLock}
                  title={terminalToken ? 'Lock the register for cashier passcode sign-in' : 'Activate this register and lock it for cashier passcode sign-in'}>
                  🔒 {terminalToken ? 'Lock register' : 'Hand off to cashiers'}
                </button>
              )}
              <AccountMenu name={`${user?.firstName ?? ''} ${user?.lastName ?? ''}`.trim()} role={user?.role} onSignOut={logout} />
            </>
          )}
        </div>
      </header>
      <div style={{padding:20}}>
        <Routes>
          <Route path="/pos" element={isBusiness ? <BusinessRegisterPage /> : <POSPage />} />
          {/* S538: owner-only team management for standalone operators. */}
          <Route path="/team" element={isOwner ? <TeamPage /> : <Navigate to="/pos" replace />} />
          {/* S536: /inventory used to render the GENERAL property-supplies
              list — wrong system for a front counter. POS stock is the
              register's Inventory tab. */}
          <Route path="/inventory" element={<Navigate to="/pos?tab=inventory" replace />} />
          <Route path="*" element={<Navigate to="/pos" replace />} />
        </Routes>
      </div>
    </div>
  )
}

export default function App() {
  return (
    <QueryClientProvider client={qc}>
      <AuthProvider>
        <BrowserRouter>
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route path="/signup" element={<SignupPage />} />
            <Route path="/shelf/:id" element={<ShelfLabelPage />} />
            <Route path="*" element={<PrivateRoute><POSLayout /></PrivateRoute>} />
          </Routes>
          <DialogHost />
        </BrowserRouter>
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
      <App />
    </SentryErrorBoundary>
  </React.StrictMode>
)
