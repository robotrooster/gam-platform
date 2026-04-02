import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from 'react-query'
import { AuthProvider, useAuth } from './context/AuthContext'
import { Layout } from './components/layout/Layout'
import { LoginPage }       from './pages/LoginPage'
import { RegisterPage }    from './pages/RegisterPage'
import { DashboardPage }   from './pages/DashboardPage'
import { PropertiesPage }  from './pages/PropertiesPage'
import { PropertyDetailPage } from './pages/PropertyDetailPage'
import { PMDashboardPage } from './pages/PMDashboardPage'
import { UnitsPage }       from './pages/UnitsPage'
import { UnitDetailPage }  from './pages/UnitDetailPage'
import { TenantsPage }     from './pages/TenantsPage'
import { TenantDetailPage } from './pages/TenantDetailPage'
import { PaymentsPage }    from './pages/PaymentsPage'
import { DisbursementsPage } from './pages/DisbursementsPage'
import { MaintenancePage } from './pages/MaintenancePage'
import { DocumentsPage }   from './pages/DocumentsPage'
import { OnboardingPage }  from './pages/OnboardingPage'
import { ReportsPage } from './pages/ReportsPage'
import { ESignPage } from './pages/ESignPage'
import { BackgroundChecksPage } from './pages/BackgroundChecksPage'
import { SignPage } from './pages/SignPage'
import { MaintenancePortalPage } from './pages/MaintenancePortalPage'
import { SettingsPage } from './pages/SettingsPage'
import { ApplicantPoolPage } from './pages/ApplicantPoolPage'
import { LeasesPage } from "./pages/LeasesPage"
import { TeamPage } from './pages/TeamPage'
import { WorkTradePage } from './pages/WorkTradePage'
import { POSPage } from './pages/POSPage'
import { InventoryPage } from './pages/InventoryPage'
import { ShelfLabelPage } from './pages/ShelfLabelPage'
import './styles/globals.css'

class ErrorBoundary extends React.Component<{children: React.ReactNode}, {error: Error | null}> {
  constructor(props: any) { super(props); this.state = { error: null } }
  static getDerivedStateFromError(error: Error) { return { error } }
  render() {
    if (this.state.error) return (
      <div style={{padding:40,textAlign:'center'}}>
        <div style={{fontSize:'1.1rem',fontWeight:600,color:'var(--red)',marginBottom:8}}>Something went wrong</div>
        <div style={{fontSize:'.82rem',color:'var(--text-3)',marginBottom:16,fontFamily:'monospace'}}>{this.state.error.message}</div>
        <button className="btn btn-primary" onClick={()=>this.setState({error:null})}>Try again</button>
      </div>
    )
    return this.props.children
  }
}

function RoleRedirect() {
  const { user } = useAuth()
  if (!user) return <Navigate to="/login" replace />
  if (user.role === 'onsite_manager' || user.role === 'maintenance') return <Navigate to="/pos" replace />
  if (user.onboardingComplete === false) return <Navigate to="/onboarding" replace />
  return <Navigate to="/dashboard" replace />
}

const qc = new QueryClient({ defaultOptions: { queries: { retry: 1, staleTime: 300000, refetchOnWindowFocus: false, refetchOnMount: false } } })

function PrivateRoute({ children }: { children: React.ReactNode }) {
  const { token, loading } = useAuth()
  if (loading) return <div className="loading-screen">Loading…</div>
  return token ? <>{children}</> : <Navigate to="/login" replace />
}

export default function App() {
  return (
    <QueryClientProvider client={qc}>
      <AuthProvider>
        <BrowserRouter>
          <Routes>
            <Route path="/login"    element={<LoginPage />} />
            <Route path="/register" element={<RegisterPage />} />
            <Route path="/shelf/:id" element={<ShelfLabelPage />} />
            <Route path="/" element={<PrivateRoute><ErrorBoundary><Layout /></ErrorBoundary></PrivateRoute>}>
              <Route index element={<RoleRedirect />} />
              <Route path="dashboard"      element={<DashboardPage />} />
              <Route path="onboarding"     element={<OnboardingPage />} />
              <Route path="properties"     element={<PropertiesPage />} />
              <Route path="properties/:id"  element={<PropertyDetailPage />} />
              <Route path="pm"               element={<PMDashboardPage />} />
              <Route path="units"          element={<UnitsPage />} />
              <Route path="units/:id"      element={<UnitDetailPage />} />
              <Route path="tenants"        element={<TenantsPage />} />
              <Route path="tenants/:id"      element={<TenantDetailPage />} />
              <Route path="documents"      element={<DocumentsPage />} />
              <Route path="leases"         element={<LeasesPage />} />
              <Route path="esign"          element={<ESignPage />} />
              <Route path="background"     element={<BackgroundChecksPage />} />
              <Route path="pool"            element={<ApplicantPoolPage />} />
              <Route path="settings"         element={<SettingsPage />} />
              <Route path="maint-portal"    element={<MaintenancePortalPage />} />
              <Route path="sign/:token"    element={<SignPage />} />
              <Route path="payments"       element={<PaymentsPage />} />
              <Route path="disbursements"  element={<DisbursementsPage />} />
              <Route path="maintenance"    element={<MaintenancePage />} />
              <Route path="reports"        element={<ReportsPage />} />
              <Route path="team"           element={<TeamPage />} />
              <Route path="work-trade"     element={<WorkTradePage />} />
              <Route path="pos"            element={<POSPage />} />
              <Route path="inventory"       element={<InventoryPage />} />
            </Route>
          </Routes>
        </BrowserRouter>
      </AuthProvider>
    </QueryClientProvider>
  )
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode><App /></React.StrictMode>
)
