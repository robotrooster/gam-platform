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
  const [success, setSuccess] = useState<{ bankLast4: string | null } | null>(null)
  const [pending, setPending] = useState<string | null>(null)
  // S570: microdeposit verification (no Financial Connections instant — that
  // bills $1.50). Collect routing/account manually, Stripe sends two small
  // deposits, the customer confirms them in 1–3 days.
  const [routing, setRouting] = useState('')
  const [account, setAccount] = useState('')
  const [holderType, setHolderType] = useState<'individual' | 'company'>('individual')

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
    if (!/^\d{9}$/.test(routing.trim())) { setError('Enter a valid 9-digit routing number.'); return }
    if (account.trim().length < 4) { setError('Enter your account number.'); return }
    setBusy(true); setError(null)
    try {
      const stripe = await stripePromise
      if (!stripe) throw new Error('Stripe publishable key not configured')

      const startRes = await fetch(`${API_URL}/api/pos-customer-onboarding/${token}/start`, { method: 'POST' })
        .then(r => r.json())
      if (!startRes.success) throw new Error(startRes.error?.message || startRes.error || 'Failed to start verification')
      // S554 (response-camelize sweep): the API camelizes responses, so the
      // route's snake_case client_secret arrives as clientSecret on the wire.
      const { clientSecret: client_secret } = startRes.data
      if (!client_secret) throw new Error('No client_secret returned')

      // S570: confirm with manually-entered bank details (microdeposits, no FC).
      // Stripe attaches the PM and initiates two small deposits; the SetupIntent
      // sits in requires_action until the customer confirms them 1–3 days later.
      const confirmResult = await (stripe as any).confirmUsBankAccountSetup(client_secret, {
        payment_method: {
          us_bank_account: {
            routing_number:      routing.trim(),
            account_number:      account.trim(),
            account_holder_type: holderType,
          },
          billing_details: {
            name:  preview.customerFirstName + ' ' + preview.customerLastName,
            email: preview.customerEmail,
          },
        },
      })
      if (confirmResult.error) throw new Error(confirmResult.error.message)
      const si = confirmResult.setupIntent

      const completeRes = await fetch(`${API_URL}/api/pos-customer-onboarding/${token}/complete`, { method: 'POST' })
        .then(r => r.json())
      if (!completeRes.success) throw new Error(completeRes.error?.message || completeRes.error || 'Completion failed')
      // Verified immediately only if the SetupIntent already succeeded; otherwise
      // microdeposits are pending (the webhook stamps verified when they clear).
      if (completeRes.data?.verified === false || si?.status !== 'succeeded') {
        setPending(completeRes.data?.message
          ?? 'We sent two small deposits to your bank. They arrive in 1–3 business days — check the email from Stripe and confirm the amounts to finish.')
      } else {
        setSuccess({ bankLast4: completeRes.data.bankLast4 })  // S554: camelized on the wire
      }
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

  if (pending) {
    return (
      <CenteredCard>
        <div style={{ fontSize: '2.2rem', textAlign: 'center', marginBottom: 12 }}>📨</div>
        <h2 style={{ margin: '0 0 8px', textAlign: 'center' }}>Two small deposits are on the way</h2>
        <p style={{ color: 'var(--t2)', textAlign: 'center', marginTop: 8, fontSize: '.88rem', lineHeight: 1.55 }}>
          {pending}
        </p>
        <p style={{ color: 'var(--t3)', textAlign: 'center', marginTop: 14, fontSize: '.78rem', lineHeight: 1.5 }}>
          Once you confirm the amounts, {preview.merchantName} can charge purchases to your FlexCharge tab. No fees for verifying.
        </p>
      </CenteredCard>
    )
  }

  if (success) {
    return (
      <CenteredCard>
        <div style={{ fontSize: '2.5rem', textAlign: 'center', marginBottom: 12 }}>✅</div>
        <h2 style={{ margin: '0 0 8px', textAlign: 'center' }}>Bank verified</h2>
        {success.bankLast4 && (
          <p style={{ color: 'var(--t2)', textAlign: 'center' }}>
            Linked: <strong>•••• {success.bankLast4}</strong>
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
            <li>Enter your bank's routing and account numbers below</li>
            <li>Stripe sends two small deposits to your account (1–3 business days) — no fees</li>
            <li>Confirm the amounts (Stripe emails you a link) to finish verifying</li>
            <li>Then {preview.merchantName} can charge purchases to your tab. Each month you get a statement; the <strong>minimum payment</strong> auto-pulls from your bank. Pay your full balance by the due date and you owe <strong>no interest</strong> — carry a balance and {preview.merchantName}'s interest rate (APR) applies. GAM never adds a fee to your bill.</li>
          </ul>
        </div>
      </div>

      <div style={{ display: 'grid', gap: 10, marginBottom: 16 }}>
        <label style={{ fontSize: '.72rem', color: 'var(--t2)' }}>Routing number
          <input className="input" inputMode="numeric" maxLength={9} value={routing}
            onChange={e => setRouting(e.target.value.replace(/\D/g, ''))}
            placeholder="9 digits" style={{ width: '100%', marginTop: 4 }} />
        </label>
        <label style={{ fontSize: '.72rem', color: 'var(--t2)' }}>Account number
          <input className="input" inputMode="numeric" value={account}
            onChange={e => setAccount(e.target.value.replace(/\D/g, ''))}
            placeholder="Your account number" style={{ width: '100%', marginTop: 4 }} />
        </label>
        <label style={{ fontSize: '.72rem', color: 'var(--t2)' }}>Account type
          <select className="input" value={holderType} onChange={e => setHolderType(e.target.value as any)}
            style={{ width: '100%', marginTop: 4 }}>
            <option value="individual">Personal</option>
            <option value="company">Business</option>
          </select>
        </label>
      </div>

      {error && <div className="alert a-warn" style={{ marginBottom: 12 }}>{error}</div>}

      <button className="btn btn-p" style={{ width: '100%' }} disabled={busy} onClick={startVerification}>
        {busy ? 'Linking…' : 'Link my bank'}
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
