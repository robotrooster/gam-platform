import React, { useEffect, useState, useCallback } from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter, Routes, Route, Navigate, NavLink, Outlet, useNavigate } from 'react-router-dom'
import './theme.css'
import { apiGet, getToken, setToken, clearToken } from './api'
import { AuthCtx, ToastCtx, useAuth, Me } from './context'
import { AuthPage } from './pages/Auth'
import { OnboardingPage } from './pages/Onboarding'
import { DashboardPage } from './pages/Dashboard'
import { RoutinesPage } from './pages/Routines'
import { WorkoutPage } from './pages/Workout'
import { StatsPage } from './pages/Stats'
import { LeaderboardPage } from './pages/Leaderboard'

// ── Portal SSO hand-off ───────────────────────────────────────
// Tenant/landlord portals link here with ?sso=<their JWT>. Capture it as our
// own token and strip it from the URL so it never lingers in history/share.
;(function captureSso() {
  const u = new URL(window.location.href)
  const sso = u.searchParams.get('sso')
  if (sso) {
    setToken(sso)
    u.searchParams.delete('sso')
    window.history.replaceState({}, '', u.pathname + u.search + u.hash)
  }
})()

function Toast({ msg, onDone }: { msg: string; onDone: () => void }) {
  useEffect(() => { const t = setTimeout(onDone, 2600); return () => clearTimeout(t) }, [msg])
  return <div className="toast">{msg}</div>
}

function Shell() {
  const { me, logout } = useAuth()
  const nav = useNavigate()
  const link = (to: string, ico: string, label: string) => (
    <NavLink to={to} className={({ isActive }) => 'navlink' + (isActive ? ' active' : '')} end={to === '/'}>
      <span className="ico">{ico}</span>{label}
    </NavLink>
  )
  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand"><div className="logo">G</div><b>GAM <span>Fitness</span></b></div>
        {link('/', '▦', 'Dashboard')}
        {link('/routines', '☰', 'Routines')}
        {link('/stats', '📈', 'Progress')}
        {link('/leaderboard', '🏆', 'Leaderboard')}
        <div className="spacer" />
        <div className="navlink" style={{ cursor: 'default', color: 'var(--text-2)' }}>
          <span className="ico">●</span>{me?.firstName} {me?.lastName}
        </div>
        <div className="navlink" onClick={() => { logout(); nav('/auth') }}><span className="ico">⏻</span>Sign out</div>
      </aside>
      <main className="main"><Outlet /></main>
    </div>
  )
}

function Gate() {
  const [state, setState] = useState<'loading' | 'no-auth' | 'onboard' | 'ready'>('loading')
  const [me, setMe] = useState<Me | null>(null)

  const load = useCallback(async () => {
    if (!getToken()) { setState('no-auth'); return }
    try {
      const meRes = await apiGet<Me>('/auth/me')
      setMe(meRes)
      const profile = await apiGet<any>('/fitness/profile')
      setState(profile?.onboardingComplete ? 'ready' : 'onboard')
    } catch {
      clearToken(); setState('no-auth')
    }
  }, [])

  useEffect(() => { load() }, [load])

  if (state === 'loading') return <div className="center muted">Loading…</div>
  if (state === 'no-auth') return <Navigate to="/auth" replace />

  return (
    <AuthCtx.Provider value={{ me, refresh: load, logout: () => { clearToken(); setMe(null) } }}>
      {state === 'onboard'
        ? <OnboardingPage onDone={load} />
        : (
          <Routes>
            <Route element={<Shell />}>
              <Route path="/" element={<DashboardPage />} />
              <Route path="/routines" element={<RoutinesPage />} />
              <Route path="/workout/:logId" element={<WorkoutPage />} />
              <Route path="/stats" element={<StatsPage />} />
              <Route path="/leaderboard" element={<LeaderboardPage />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Route>
          </Routes>
        )}
    </AuthCtx.Provider>
  )
}

function App() {
  const [toast, setToast] = useState<string | null>(null)
  return (
    <ToastCtx.Provider value={setToast}>
      <BrowserRouter>
        <Routes>
          <Route path="/auth" element={<AuthPage />} />
          <Route path="/*" element={<Gate />} />
        </Routes>
      </BrowserRouter>
      {toast && <Toast msg={toast} onDone={() => setToast(null)} />}
    </ToastCtx.Provider>
  )
}

ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>)
