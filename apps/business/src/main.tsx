import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { AuthProvider, useAuth } from './context/AuthContext'
import { Layout } from './components/layout/Layout'
import { LoginPage } from './pages/LoginPage'
import { SignupPage } from './pages/SignupPage'
import { DashboardPage } from './pages/DashboardPage'
import { CustomersPage } from './pages/CustomersPage'
import { StaffPage } from './pages/StaffPage'
import { SettingsPage } from './pages/SettingsPage'
import { DepotsPage } from './pages/DepotsPage'
import { VehiclesPage } from './pages/VehiclesPage'
import { DumpLocationsPage } from './pages/DumpLocationsPage'
import { SchedulesPage } from './pages/SchedulesPage'
import { RoutesPage } from './pages/RoutesPage'
import { DriverPage } from './pages/DriverPage'
import { InvoicesPage } from './pages/InvoicesPage'
import { AppointmentsPage } from './pages/AppointmentsPage'
import { InventoryPage } from './pages/InventoryPage'
import { POSPage } from './pages/POSPage'
import { WorkOrdersPage } from './pages/WorkOrdersPage'
import { CustomerVehiclesPage } from './pages/CustomerVehiclesPage'
import { QuotesPage } from './pages/QuotesPage'
import { ReportsPage } from './pages/ReportsPage'
import { RecurringInvoicesPage } from './pages/RecurringInvoicesPage'
import { BookableServicesPage } from './pages/BookableServicesPage'
import './styles/globals.css'

function Protected({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth()
  if (loading) return <div style={{ padding: 40, color: 'var(--text-2)' }}>Loading…</div>
  if (!user) return <Navigate to="/login" replace />
  return <>{children}</>
}

function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          <Route path="/login"  element={<LoginPage />} />
          <Route path="/signup" element={<SignupPage />} />
          {/* Driver UI: full-screen, no Layout sidebar — phone-first. */}
          <Route path="/drive/:routeId" element={<Protected><DriverPage /></Protected>} />
          <Route element={<Protected><Layout /></Protected>}>
            <Route path="/dashboard" element={<DashboardPage />} />
            <Route path="/customers" element={<CustomersPage />} />
            <Route path="/invoices"     element={<InvoicesPage />} />
            <Route path="/appointments" element={<AppointmentsPage />} />
            <Route path="/inventory"    element={<InventoryPage />} />
            <Route path="/pos"          element={<POSPage />} />
            <Route path="/work-orders"  element={<WorkOrdersPage />} />
            <Route path="/customer-vehicles" element={<CustomerVehiclesPage />} />
            <Route path="/quotes"       element={<QuotesPage />} />
            <Route path="/reports"      element={<ReportsPage />} />
            <Route path="/recurring-invoices" element={<RecurringInvoicesPage />} />
            <Route path="/bookable-services"  element={<BookableServicesPage />} />
            <Route path="/schedules" element={<SchedulesPage />} />
            <Route path="/routes"    element={<RoutesPage />} />
            <Route path="/depots"    element={<DepotsPage />} />
            <Route path="/vehicles"  element={<VehiclesPage />} />
            <Route path="/dump-locations" element={<DumpLocationsPage />} />
            <Route path="/staff"     element={<StaffPage />} />
            <Route path="/settings"  element={<SettingsPage />} />
          </Route>
          <Route path="/" element={<Navigate to="/dashboard" replace />} />
          <Route path="*" element={<Navigate to="/dashboard" replace />} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  )
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
