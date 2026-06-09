import { useState } from 'react'
import { Link } from 'react-router-dom'
import { apiPost } from '../lib/api'

/**
 * ForgotPasswordPage (S289).
 *
 * Step one of the password-reset flow. User enters their email; we
 * call POST /api/auth/forgot-password which (by design — S279) always
 * returns 200 to avoid account enumeration. The page shows the same
 * "check your inbox" confirmation regardless of whether the email
 * matches a real account.
 *
 * If the email IS a known unverified user, the backend mints a
 * single-use 32-byte hex token (1h TTL) and emails the reset URL.
 * The recipient lands on /reset-password with the token in the query.
 */
export function ForgotPasswordPage() {
  const [email, setEmail] = useState('')
  const [submitted, setSubmitted] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    if (!email.trim()) { setError('Enter your email address.'); return }
    setSubmitting(true)
    try {
      await apiPost('/auth/forgot-password', { email: email.trim().toLowerCase() })
      setSubmitted(true)
    } catch {
      // The backend returns 200 unconditionally for this endpoint,
      // so reaching the catch arm means a real outage (network /
      // server 5xx). Surface a soft error and let the user retry.
      setError('Something went wrong. Please try again in a moment.')
      setSubmitting(false)
    }
  }

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg0)', padding: 20 }}>
      <div style={{ width: '100%', maxWidth: 420 }}>
        <div style={{ textAlign: 'center', marginBottom: 32 }}>
          <div style={{ fontFamily: 'var(--font-d)', fontSize: '2rem', fontWeight: 800, color: 'var(--gold)', marginBottom: 8 }}>⚡ GAM</div>
          <div style={{ color: 'var(--t2)', fontSize: '.875rem' }}>Password reset</div>
        </div>

        <div className="card" style={{ padding: 28 }}>
          {!submitted ? (
            <>
              <h2 style={{ marginBottom: 8 }}>Reset your password</h2>
              <p style={{ color: 'var(--t2)', fontSize: '.85rem', marginBottom: 20, lineHeight: 1.5 }}>
                Enter the email address on your GAM account. We'll send you a link to set a new password. The link is valid for one hour.
              </p>
              {error && <div className="alert a-warn" style={{ marginBottom: 16 }}>{error}</div>}
              <form onSubmit={onSubmit}>
                <div className="fg">
                  <label className="fl">Email</label>
                  <input
                    className="fi"
                    type="email"
                    value={email}
                    onChange={e => setEmail(e.target.value)}
                    required
                    autoFocus
                    autoComplete="email"
                  />
                </div>
                <button
                  className="btn btn-p"
                  type="submit"
                  disabled={submitting}
                  style={{ width: '100%', justifyContent: 'center', marginTop: 8 }}
                >
                  {submitting ? <span className="spinner" /> : 'Send reset link'}
                </button>
              </form>
            </>
          ) : (
            <>
              <h2 style={{ marginBottom: 12 }}>Check your inbox</h2>
              <p style={{ color: 'var(--t2)', fontSize: '.85rem', lineHeight: 1.6, marginBottom: 8 }}>
                If an account exists for <strong style={{ color: 'var(--t0)' }}>{email}</strong>, we've sent a reset link to it. The link expires in one hour.
              </p>
              <p style={{ color: 'var(--t2)', fontSize: '.8rem', lineHeight: 1.6 }}>
                Didn't receive an email? Check your spam folder, or wait a minute and try again.
              </p>
            </>
          )}

          <div style={{ marginTop: 24, paddingTop: 16, borderTop: '1px solid var(--bg2)', textAlign: 'center' }}>
            <Link to="/login" style={{ color: 'var(--gold)', fontSize: '.85rem', textDecoration: 'none' }}>
              ← Back to sign in
            </Link>
          </div>
        </div>
      </div>
    </div>
  )
}
