// S540: self-hosted fonts — no render-blocking external stylesheet
import '@fontsource/space-grotesk/500.css'
import '@fontsource/space-grotesk/600.css'
import '@fontsource/space-grotesk/700.css'
import '@fontsource/inter/300.css'
import '@fontsource/inter/400-italic.css'
import '@fontsource/dm-mono/400.css'
import '@fontsource/dm-mono/500.css'
import '@fontsource/inter/400.css'
import '@fontsource/inter/500.css'
import '@fontsource/inter/600.css'
import '@fontsource/inter/700.css'
import '@fontsource/jetbrains-mono/400.css'
import '@fontsource/jetbrains-mono/500.css'
import { SentryErrorBoundary } from './lib/sentry'
import { installDatePickerAutoClose, startVersionWatch } from '@gam/shared'
import React, { useEffect, useState } from 'react'
import { apiPost } from './lib/api'
import ReactDOM from 'react-dom/client'
import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom'

// S550: first-party product telemetry — one page_view per route change.
// Fire-and-forget; failures are silently ignored (never affects UX).
function TelemetryPing() {
  const location = useLocation()
  useEffect(() => {
    apiPost('/telemetry/events', {
      events: [{ portal: 'landlord', event: 'page_view', path: location.pathname }],
    }).catch(() => {})
  }, [location.pathname])
  return null
}
// S605 — stale-shell self-heal. A landlord was locked out by a page that had
// stopped talking to the server and could only be cured by a manual hard
// refresh, which no real customer would ever think to do. A bfcache restore on
// an outdated build reloads itself silently; a newer deploy found on refocus or
// on the 5-minute poll only OFFERS a reload, because someone may be mid-way
// through entering a batch of units and must never have the page yanked.
function VersionWatch() {
  const [updateReady, setUpdateReady] = useState(false)
  useEffect(() => startVersionWatch({
    intervalMs: 5 * 60_000,
    onUpdateAvailable: () => setUpdateReady(true),
  }), [])
  if (!updateReady) return null
  return (
    <div style={{
      position:'fixed', bottom:18, left:'50%', transform:'translateX(-50%)', zIndex:9999,
      display:'flex', alignItems:'center', gap:12, padding:'10px 16px',
      background:'var(--bg-2)', border:'1px solid var(--gold)', borderRadius:10,
      boxShadow:'0 6px 24px rgba(0,0,0,.45)', fontSize:'.82rem', color:'var(--text-1)',
    }}>
      A newer version of GAM is available.
      <button className="btn btn-primary btn-sm" onClick={() => window.location.reload()}>Reload</button>
    </div>
  )
}

import { QueryClient, QueryClientProvider } from 'react-query'
import { AuthProvider, useAuth } from './context/AuthContext'
import { Layout, LAUNCH_HIDDEN, visibleNavItemsFor, HubTabLayout } from './components/layout/Layout'
import { LoginPage }       from './pages/LoginPage'
import { RegisterPage }    from './pages/RegisterPage'
import { ForgotPasswordPage } from './pages/ForgotPasswordPage'
import { ResetPasswordPage }  from './pages/ResetPasswordPage'
import { AcceptInvitePage } from './pages/AcceptInvitePage'
import { AcceptOwnerInvitePage } from './pages/AcceptOwnerInvitePage'
import { DashboardPage }   from './pages/DashboardPage'
import { ReferLandlordPage } from './pages/ReferLandlordPage'
import { PropertiesPage }  from './pages/PropertiesPage'
import { PropertyDetailPage } from './pages/PropertyDetailPage'
import { PmInvitationsPage } from './pages/PmInvitationsPage'
import { UnitsPage }       from './pages/UnitsPage'
import { UnitDetailPage }  from './pages/UnitDetailPage'
import { TenantsPage }     from './pages/TenantsPage'
import { TenantDetailPage } from './pages/TenantDetailPage'
import { PendingTenantsPage } from './pages/PendingTenantsPage'
import { PaymentsPage }    from './pages/PaymentsPage'
import { BalancesPage }    from './pages/BalancesPage'
import { RentRollPage }    from './pages/RentRollPage'
import { UtilityMetersPage } from './pages/UtilityMetersPage'
import { DisbursementsPage } from './pages/DisbursementsPage'
import { LotRentPage } from './pages/LotRentPage'
import { ExpensesPage } from './pages/ExpensesPage'
import { BankPage } from './pages/BankPage'
import { BankingPage }      from './pages/BankingPage'
import { MaintenancePage } from './pages/MaintenancePage'
import { DocumentsPage }   from './pages/DocumentsPage'
import { OnboardingPage }  from './pages/OnboardingPage'
import { TenantOnboardingPage } from './pages/TenantOnboardingPage'
import { PropertyOnboardingPage } from './pages/PropertyOnboardingPage'
import { PaymentHistoryOnboardingPage } from './pages/PaymentHistoryOnboardingPage'
import { ReportsPage } from './pages/ReportsPage'
import { ESignPage } from './pages/ESignPage'
import { BackgroundChecksPage } from './pages/BackgroundChecksPage'
import { SignPage } from './pages/SignPage'
import { MaintenancePortalPage } from './pages/MaintenancePortalPage'
import { SettingsPage } from './pages/SettingsPage'
import { ApplicantPoolPage } from './pages/ApplicantPoolPage'
import { LeasesPage } from "./pages/LeasesPage"
import { PdfViewerPage } from "./pages/PdfViewerPage"
import { SubleasesPage } from "./pages/SubleasesPage"
import { TeamPage } from './pages/TeamPage'
import { StaffPermissionsPage } from './pages/StaffPermissionsPage'
import { WorkTradePage } from './pages/WorkTradePage'
import { SurveysPage } from './pages/SurveysPage'
import { POSPage } from './pages/POSPage'
import { InventoryPage } from './pages/InventoryPage'
import { SchedulePage } from './pages/SchedulePage'
import { BookingSitePage } from './pages/BookingSitePage'
import { ShelfLabelPage } from './pages/ShelfLabelPage'
import { InspectionsPage } from './pages/InspectionsPage'
import { AmenitiesPage } from './pages/AmenitiesPage'
import { NewInspectionPage } from './pages/NewInspectionPage'
import { InspectionDetailPage } from './pages/InspectionDetailPage'
import { UnitLifecyclePage } from './pages/UnitLifecyclePage'
import { EntryRequestsPage } from './pages/EntryRequestsPage'
import { NewEntryRequestPage } from './pages/NewEntryRequestPage'
import { EntryRequestDetailPage } from './pages/EntryRequestDetailPage'
import { TenantScreeningPage } from './pages/TenantScreeningPage'
import { ApplicationsPage } from './pages/ApplicationsPage'
import { NotificationsPage } from './pages/NotificationsPage'
import { DepositReturnPage } from './pages/DepositReturnPage'
import { LeaseTerminationPage } from './pages/LeaseTerminationPage'
import { FlexChargePage } from './pages/FlexChargePage'
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
  // S605: a co-owner invite that sent the visitor off to sign in or register
  // must still be applied when they come back — otherwise they authenticate,
  // land on a dashboard with none of the property they were invited to, and
  // have no idea the invite was dropped. Survives both the login and the
  // registration detour.
  const pendingInvite = sessionStorage.getItem('gam_pending_owner_invite')
  if (pendingInvite) return <Navigate to={`/accept-owner-invite/${pendingInvite}`} replace />
  // Staff land on the FIRST page their permission set actually grants — the
  // same visibility rule as the sidebar (was: hardcoded /pos, which dumped a
  // front-desk user with no POS access on an empty register). Zero grants →
  // /welcome explains what's missing.
  if (user.role === 'onsite_manager' || user.role === 'maintenance' || user.role === 'property_manager') {
    const first = visibleNavItemsFor(user)[0]
    return <Navigate to={first ? first.to : '/welcome'} replace />
  }
  if (user.onboardingComplete === false) return <Navigate to="/onboarding" replace />
  return <Navigate to="/dashboard" replace />
}

// Landing for a staff account with no permissions granted yet. Zero perms =
// zero nav items, so every other page would be blank or 403 — this one says why.
function NoAccessPage() {
  const { user } = useAuth()
  return (
    <div className="card" style={{ padding: 40, textAlign: 'center', maxWidth: 560, margin: '60px auto' }}>
      <div style={{ fontSize: '1.05rem', fontWeight: 600, marginBottom: 8 }}>
        Welcome{user?.firstName ? `, ${user.firstName}` : ''} — your account is active
      </div>
      <div style={{ fontSize: '.85rem', color: 'var(--text-3)', lineHeight: 1.6 }}>
        No pages have been enabled for you yet. Ask the property owner to grant
        your permissions, then sign out and back in to pick them up.
      </div>
    </div>
  )
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
          <TelemetryPing />
          <VersionWatch />
          <Routes>
            <Route path="/login"    element={<LoginPage />} />
            <Route path="/register" element={<RegisterPage />} />
            {/* S605: the landlord portal had no password recovery at all — no
                link, no page, no route — while the API endpoint had existed
                since S289. A forgotten password meant permanent lockout. */}
            <Route path="/forgot-password" element={<ForgotPasswordPage />} />
            <Route path="/reset-password"  element={<ResetPasswordPage />} />
            <Route path="/invite/:token" element={<AcceptInvitePage />} />
            {/* S605: co-owner invite. PUBLIC — the invitee may have no account
                yet, which is the entire point of the flow. */}
            <Route path="/accept-owner-invite/:token" element={<AcceptOwnerInvitePage />} />
            <Route path="/shelf/:id" element={<ShelfLabelPage />} />
            {/* S629 (Nic): "the signing should almost be outside of logging in.
                When I click the link in the email it needs to take me right to
                select my font, my initials, and sign it."
                PUBLIC. The emailed link carries the signer's own 64-hex token,
                which IS their identity for that one document — the same way
                every e-sign product works. It was nested under PrivateRoute, so
                an emailed link landed on a login screen. The authenticated
                route below stays for signing from inside the portal. */}
            <Route path="/sign/:token" element={<SignPage />} />
            <Route path="/" element={<PrivateRoute><ErrorBoundary><Layout /></ErrorBoundary></PrivateRoute>}>
              <Route index element={<RoleRedirect />} />
              <Route path="welcome"        element={<NoAccessPage />} />
              <Route path="dashboard"      element={<DashboardPage />} />
              <Route path="refer"          element={<ReferLandlordPage />} />
              <Route path="onboarding"     element={<OnboardingPage />} />
              <Route path="properties"     element={<PropertiesPage />} />
              <Route path="properties/:id"  element={<PropertyDetailPage />} />
              <Route path="property-onboarding" element={<PropertyOnboardingPage />} />
              <Route path="payment-history-onboarding" element={<PaymentHistoryOnboardingPage />} />
              <Route path="pm-invitations"  element={LAUNCH_HIDDEN.has('/pm-invitations') ? <Navigate to="/dashboard" replace /> : <PmInvitationsPage />} />
              <Route path="units"          element={<UnitsPage />} />
              <Route path="units/:id"      element={<UnitDetailPage />} />
              <Route path="tenants"        element={<TenantsPage />} />
              <Route path="tenants/:id"      element={<TenantDetailPage />} />
              <Route path="tenant-onboarding" element={<TenantOnboardingPage />} />
              <Route path="tenant-onboarding/pending" element={<PendingTenantsPage />} />
              <Route path="documents"      element={<DocumentsPage />} />
              <Route path="leases"         element={<LeasesPage />} />
              <Route path="view"           element={<PdfViewerPage />} />
              <Route path="subleases"       element={LAUNCH_HIDDEN.has('/subleases') ? <Navigate to="/dashboard" replace /> : <SubleasesPage />} />
              <Route path="esign"          element={<ESignPage />} />
              <Route path="settings"         element={<SettingsPage />} />
              <Route path="maint-portal"    element={<MaintenancePortalPage />} />
              <Route path="sign/:token"    element={<SignPage />} />
              <Route path="utilities"      element={<UtilityMetersPage />} />
              <Route path="maintenance"    element={<MaintenancePage />} />
              {/* S575: Financials hub. Flat child paths are UNCHANGED so every
                  existing deep link/redirect keeps working — the pathless layout
                  route only wraps them in the shared sub-tab bar (HubTabLayout). */}
              <Route element={<HubTabLayout hub="financials" />}>
                <Route path="payments"       element={<PaymentsPage />} />
                <Route path="balances"       element={<BalancesPage />} />
                <Route path="rent-roll"      element={<RentRollPage />} />
                <Route path="disbursements"  element={<DisbursementsPage />} />
                <Route path="reports"        element={<ReportsPage />} />
                <Route path="expenses"       element={<ExpensesPage />} />
                {/* S605: one Bank tab. The old paths redirect so existing
                    links and bookmarks don't 404. */}
                <Route path="bank"           element={<BankPage />} />
                <Route path="bank-feed"      element={<Navigate to="/bank" replace />} />
                <Route path="bank-reconciliation" element={<Navigate to="/bank" replace />} />
                <Route path="banking"        element={<BankingPage />} />
                <Route path="lot-rent"       element={<LotRentPage />} />
              </Route>
              {/* S575: Screening hub — Applicant Pool / Background Checks / Rental History. */}
              <Route element={<HubTabLayout hub="screening" />}>
                <Route path="pool"            element={<ApplicantPoolPage />} />
                <Route path="background"     element={<BackgroundChecksPage />} />
                <Route path="screening"          element={<TenantScreeningPage />} />
                <Route path="applications"       element={<ApplicationsPage />} />
              </Route>
              <Route path="team"           element={<TeamPage />} />
              <Route path="team/:userId/permissions" element={<StaffPermissionsPage />} />
              <Route path="work-trade"     element={LAUNCH_HIDDEN.has('/work-trade') ? <Navigate to="/dashboard" replace /> : <WorkTradePage />} />
              <Route path="surveys"        element={<SurveysPage />} />
              <Route path="pos"            element={<POSPage />} />
              <Route path="inventory"       element={<InventoryPage />} />
              <Route path="schedule"       element={<SchedulePage />} />
              <Route path="inspections"      element={<InspectionsPage />} />
              <Route path="amenities"        element={<AmenitiesPage />} />
              <Route path="inspections/new"  element={<NewInspectionPage />} />
              <Route path="inspections/unit/:unitId/lifecycle" element={<UnitLifecyclePage />} />
              <Route path="inspections/:id"  element={<InspectionDetailPage />} />
              <Route path="entry-requests"     element={<EntryRequestsPage />} />
              <Route path="entry-requests/new" element={<NewEntryRequestPage />} />
              <Route path="entry-requests/:id" element={<EntryRequestDetailPage />} />
              {/* W-53 (S531): prefs merged into Settings; deep links redirect */}
              <Route path="notification-prefs" element={<Navigate to="/settings" replace />} />
              <Route path="bookings"           element={<Navigate to="/schedule" replace />} />
              <Route path="booking-sites"      element={<BookingSitePage />} />
              <Route path="notifications"     element={<NotificationsPage />} />
              <Route path="leases/:id/deposit-return" element={<DepositReturnPage />} />
              <Route path="leases/:id/termination"   element={<LeaseTerminationPage />} />
              <Route path="flex-charge"               element={LAUNCH_HIDDEN.has('/flex-charge') ? <Navigate to="/dashboard" replace /> : <FlexChargePage />} />
            </Route>
          </Routes>
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
  <SentryErrorBoundary fallback={<div style={{ padding: 40, textAlign: 'center', color: 'var(--text-0)' }}>
    <div style={{ fontSize: '1.1rem', fontWeight: 600, marginBottom: 8 }}>Something went wrong</div>
    <div style={{ fontSize: '.82rem', color: 'var(--text-3)', marginBottom: 16 }}>The error has been reported. Reload the page to try again.</div>
    <button className="btn btn-primary" onClick={() => window.location.reload()}>Reload</button>
  </div>}>
    <App />
  </SentryErrorBoundary>
)
