import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { LoginPage } from './pages/LoginPage'
import { AccountPage } from './pages/AccountPage'
import { BookingPage } from './pages/BookingPage'
import { PropertyBookingPage } from './pages/PropertyBookingPage'
import { ClaimPage } from './pages/ClaimPage'
import { InvoicePaidPage } from './pages/InvoicePaidPage'
import { resolveBookingSlug } from './lib/slug'
import './styles.css'

// In production each property's booking site is a GAM subdomain; when the
// host carries a property slug, the apex path IS the booking page.
const subdomainSlug = resolveBookingSlug()

function Booked() {
  return (
    <div style={{ maxWidth: 460, margin: '64px auto', padding: 24, textAlign: 'center', color: '#e8edf7', fontFamily: 'system-ui' }}>
      <div style={{ fontSize: 40, marginBottom: 12 }}>✓</div>
      <h1 style={{ fontSize: 22 }}>Deposit received — you're booked!</h1>
      <div style={{ color: '#8b97b3' }}>A confirmation is on its way to your email. See you soon.</div>
    </div>
  )
}

function Landing() {
  if (subdomainSlug) return <PropertyBookingPage />
  return (
    <div style={{ maxWidth: 440, margin: '64px auto', padding: 24, textAlign: 'center' }}>
      <div style={{ fontFamily: 'var(--font-display)', fontSize: 24, color: 'var(--text-0)', marginBottom: 12 }}>
        Customer Portal
      </div>
      <div style={{ color: 'var(--text-2)', fontSize: 15 }}>
        Use the link your service provider gave you to sign in and view your
        service status and invoices.
      </div>
    </div>
  )
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Landing />} />
        <Route path="/login/:slug" element={<LoginPage />} />
        <Route path="/book/:slug" element={<BookingPage />} />
        <Route path="/property/:slug" element={<PropertyBookingPage />} />
        <Route path="/property/:slug/booked" element={<Booked />} />
        <Route path="/property/:slug/claim/:token" element={<ClaimPage />} />
        <Route path="/account/:token" element={<AccountPage />} />
        <Route path="/invoice-paid" element={<InvoicePaidPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  </React.StrictMode>,
)
