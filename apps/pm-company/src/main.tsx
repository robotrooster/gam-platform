import { SentryErrorBoundary } from './lib/sentry'
import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from 'react-query'
import { AuthProvider, useAuth } from './context/AuthContext'
import { Layout } from './components/Layout'
import { LoginPage } from './pages/LoginPage'
import { RegisterPage } from './pages/RegisterPage'
import { DashboardPage } from './pages/DashboardPage'
import { InvitationsPage } from './pages/InvitationsPage'
import { PropertiesPage } from './pages/PropertiesPage'
import { PropertyDetailPage } from './pages/PropertyDetailPage'
import { FeePlansPage } from './pages/FeePlansPage'
import { StaffPage } from './pages/StaffPage'
import { BankingPage } from './pages/BankingPage'
import { SettingsPage } from './pages/SettingsPage'
import { TotpEnrollPage } from './pages/TotpEnrollPage'
import './styles/globals.css'

const qc = new QueryClient({
  defaultOptions: { queries: { refetchOnWindowFocus: false, retry: 1 } }
})

function PrivateRoute({ children }: { children: React.ReactNode }) {
  const { user, loading, pmCompanies } = useAuth()
  if (loading) return <div style={{ padding: 32, color: 'var(--text-3)' }}>Loading…</div>
  if (!user) return <Navigate to="/login" replace />
  // User is signed in but isn't a member of any pm_company → send them to register
  if (pmCompanies.length === 0) return <Navigate to="/register" replace />
  return <>{children}</>
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <SentryErrorBoundary fallback={<div style={{ padding: 40, textAlign: 'center', color: 'var(--text-0)' }}>
      <div style={{ fontSize: '1.1rem', fontWeight: 600, marginBottom: 8 }}>Something went wrong</div>
      <div style={{ fontSize: '.82rem', color: 'var(--text-3)', marginBottom: 16 }}>The error has been reported. Reload the page to try again.</div>
      <button className="btn btn-primary" onClick={() => window.location.reload()}>Reload</button>
    </div>}>
    <QueryClientProvider client={qc}>
      <AuthProvider>
        <BrowserRouter>
          <Routes>
            <Route path="/login"    element={<LoginPage />} />
            <Route path="/register" element={<RegisterPage />} />
            <Route path="/" element={<PrivateRoute><Layout /></PrivateRoute>}>
              <Route index             element={<Navigate to="/dashboard" replace />} />
              <Route path="dashboard"      element={<DashboardPage />} />
              <Route path="properties"      element={<PropertiesPage />} />
              <Route path="properties/:id"  element={<PropertyDetailPage />} />
              <Route path="invitations" element={<InvitationsPage />} />
              <Route path="fee-plans"  element={<FeePlansPage />} />
              <Route path="staff"      element={<StaffPage />} />
              <Route path="banking"    element={<BankingPage />} />
              <Route path="settings"   element={<SettingsPage />} />
              <Route path="totp/enroll" element={<TotpEnrollPage />} />
            </Route>
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </BrowserRouter>
      </AuthProvider>
    </QueryClientProvider>
    </SentryErrorBoundary>
  </React.StrictMode>
)
