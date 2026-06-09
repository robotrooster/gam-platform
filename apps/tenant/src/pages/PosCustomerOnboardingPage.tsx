/**
 * S258: Public pos_customer ACH onboarding page.
 *
 * No auth — token from URL is the only credential. Flow:
 *   1. GET preview from /api/pos-customer-onboarding/:token
 *   2. User reviews details, clicks "Verify my bank"
 *   3. POST /:token/start → server returns SetupIntent client_secret
 *   4. Stripe FC modal opens (collectBankAccountForSetup +
 *      confirmUsBankAccountSetup)
 *   5. POST /:token/complete → server stamps pos_customers.ach_verified
 *   6. Success state
 */

import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { loadStripe, Stripe as StripeJs } from '@stripe/stripe-js'

const API_URL = (import.meta as any).env?.VITE_API_URL || 'http://localhost:4000'
const STRIPE_PK = (import.meta as any).env?.VITE_STRIPE_PUBLISHABLE_KEY
const stripePromise: Promise<StripeJs | null> | null = STRIPE_PK ? loadStripe(STRIPE_PK) : null

interface Preview {
  customerFirstName: string
  customerLastName:  string
  customerEmail:      string
  merchantName:       string
  expiresAt:          string
  status:              string
}

export function PosCustomerOnboardingPage() {
  const { token } = useParams<{ token: string }>()
  const [preview, setPreview] = useState<Preview | null>(null)
  const [loadErr, setLoadErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<{ bank_last4: string | null } | null>(null)

  useEffect(() => {
    if (!token) return
    fetch(`${API_URL}/api/pos-customer-onboarding/${token}`)
      .then(r => r.json())
      .then(r => {
        if (r.success) setPreview(r.data)
        else setLoadErr(r.error?.message || r.error || 'Invitation could not be loaded')
      })
      .catch(() => setLoadErr('Network error loading invitation'))
  }, [token])

  const startVerification = async () => {
    if (!token || !preview) return
    setBusy(true); setError(null)
    try {
      const stripe = await stripePromise
      if (!stripe) throw new Error('Stripe publishable key not configured')

      const startRes = await fetch(`${API_URL}/api/pos-customer-onboarding/${token}/start`, { method: 'POST' })
        .then(r => r.json())
      if (!startRes.success) throw new Error(startRes.error?.message || startRes.error || 'Failed to start verification')
      const { client_secret } = startRes.data
      if (!client_secret) throw new Error('No client_secret returned')

      // Collect bank via Stripe Financial Connections (FC modal).
      const collectResult = await (stripe as any).collectBankAccountForSetup({
        clientSecret: client_secret,
        params: {
          payment_method_type: 'us_bank_account',
          payment_method_data: {
            billing_details: {
              name:  preview.customerFirstName + ' ' + preview.customerLastName,
              email: preview.customerEmail,
            },
          },
        },
      })
      if (collectResult.error) throw new Error(collectResult.error.message)

      // Confirm the SetupIntent now that the payment method is attached.
      const confirmResult = await (stripe as any).confirmUsBankAccountSetup(client_secret)
      if (confirmResult.error) throw new Error(confirmResult.error.message)

      // Tell the server to mark verified.
      const completeRes = await fetch(`${API_URL}/api/pos-customer-onboarding/${token}/complete`, { method: 'POST' })
        .then(r => r.json())
      if (!completeRes.success) throw new Error(completeRes.error?.message || completeRes.error || 'Completion failed')
      setSuccess({ bank_last4: completeRes.data.bank_last4 })
    } catch (e: any) {
      setError(e?.message || 'Verification failed')
    } finally {
      setBusy(false)
    }
  }

  if (loadErr) {
    return (
      <CenteredCard>
        <h2 style={{ margin: '0 0 8px' }}>This link can't be used</h2>
        <p style={{ color: 'var(--t2)' }}>{loadErr}</p>
      </CenteredCard>
    )
  }
  if (!preview) {
    return <CenteredCard><p>Loading…</p></CenteredCard>
  }

  if (success) {
    return (
      <CenteredCard>
        <div style={{ fontSize: '2.5rem', textAlign: 'center', marginBottom: 12 }}>✅</div>
        <h2 style={{ margin: '0 0 8px', textAlign: 'center' }}>Bank verified</h2>
        {success.bank_last4 && (
          <p style={{ color: 'var(--t2)', textAlign: 'center' }}>
            Linked: <strong>•••• {success.bank_last4}</strong>
          </p>
        )}
        <p style={{ color: 'var(--t2)', textAlign: 'center', marginTop: 14, fontSize: '.85rem', lineHeight: 1.5 }}>
          You're all set. {preview.merchantName} can now charge purchases to your FlexCharge tab.
          You'll get a monthly statement via email and the balance will auto-pull from your verified bank.
        </p>
      </CenteredCard>
    )
  }

  return (
    <CenteredCard>
      <h2 style={{ margin: '0 0 8px' }}>Verify your bank for FlexCharge</h2>
      <p style={{ color: 'var(--t2)', marginBottom: 18, fontSize: '.88rem', lineHeight: 1.5 }}>
        <strong>{preview.merchantName}</strong> invited you, <strong>{preview.customerFirstName} {preview.customerLastName}</strong>,
        to open a FlexCharge tab. Verify your bank to enable monthly statement billing.
      </p>

      <div style={{ background: 'var(--bg3)', borderRadius: 8, padding: 14, marginBottom: 18 }}>
        <div style={{ fontSize: '.78rem', color: 'var(--t2)', lineHeight: 1.6 }}>
          <div style={{ fontWeight: 600, marginBottom: 6, color: 'var(--t0)' }}>What happens next</div>
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            <li>You'll sign in to your bank through Stripe's secure connector</li>
            <li>GAM and {preview.merchantName} only see the last 4 digits of your account</li>
            <li>Once verified, {preview.merchantName} can charge purchases to your tab</li>
            <li>Statements pull automatically — 1.5% service fee + your purchases each month</li>
          </ul>
        </div>
      </div>

      {error && <div className="alert a-warn" style={{ marginBottom: 12 }}>{error}</div>}

      <button className="btn btn-p" style={{ width: '100%' }} disabled={busy} onClick={startVerification}>
        {busy ? 'Verifying…' : 'Verify my bank'}
      </button>

      <p style={{ fontSize: '.7rem', color: 'var(--t3)', marginTop: 14, textAlign: 'center' }}>
        Link expires {new Date(preview.expiresAt).toLocaleDateString()}.
        Powered by Stripe. GAM never stores your full bank credentials.
      </p>
    </CenteredCard>
  )
}

function CenteredCard({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20, background: 'var(--bg1)' }}>
      <div style={{ background: 'var(--bg2)', padding: 32, borderRadius: 12, maxWidth: 460, width: '100%', border: '1px solid var(--b1)' }}>
        {children}
      </div>
    </div>
  )
}
