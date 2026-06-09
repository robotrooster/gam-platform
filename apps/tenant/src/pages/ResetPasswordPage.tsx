import { useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { apiPost } from '../lib/api'

/**
 * ResetPasswordPage (S289).
 *
 * Consumes the single-use token from /forgot-password and lets the
 * user set a new password. Token comes in via `?token=...` query
 * param (set by the link emailed in step one).
 *
 * Password requirements match S282 backend: minimum 12 characters,
 * no composition rules (NIST SP 800-63B — length over complexity).
 * Backend re-validates; this is just a UX guard so the user doesn't
 * submit a too-short password.
 *
 * On success the backend clears the token (single-use) and does NOT
 * issue a JWT — user must sign in fresh with the new password. CTA
 * routes them to /login.
 */
export function ResetPasswordPage() {
  const [params] = useSearchParams()
  const token = params.get('token') ?? ''

  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [done, setDone] = useState(false)

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    if (password.length < 12) {
      setError('Password must be at least 12 characters.')
      return
    }
    if (password !== confirm) {
      setError('Passwords do not match.')
      return
    }
    setSubmitting(true)
    try {
      await apiPost('/auth/reset-password', { token, newPassword: password })
      setDone(true)
    } catch (e: any) {
      // 400 from the backend means the token is invalid or already
      // used; surface that distinctly from a generic network error.
      const msg = e?.response?.data?.error
      setError(typeof msg === 'string'
        ? msg
        : 'Something went wrong. Please request a new reset link.')
      setSubmitting(false)
    }
  }

  // Empty / malformed token: don't bother showing the form, the
  // backend will reject it anyway.
  if (!token) {
    return (
      <ErrorShell
        title="Invalid reset link"
        body="This link is missing its token. Request a new password reset to try again."
      />
    )
  }

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg0)', padding: 20 }}>
      <div style={{ width: '100%', maxWidth: 420 }}>
        <div style={{ textAlign: 'center', marginBottom: 32 }}>
          <div style={{ fontFamily: 'var(--font-d)', fontSize: '2rem', fontWeight: 800, color: 'var(--gold)', marginBottom: 8 }}>⚡ GAM</div>
          <div style={{ color: 'var(--t2)', fontSize: '.875rem' }}>Set a new password</div>
        </div>

        <div className="card" style={{ padding: 28 }}>
          {!done ? (
            <>
              <h2 style={{ marginBottom: 8 }}>Choose a new password</h2>
              <p style={{ color: 'var(--t2)', fontSize: '.85rem', marginBottom: 20, lineHeight: 1.5 }}>
                Pick something you'll remember. Minimum 12 characters — longer is better. You don't need symbols or numbers.
              </p>
              {error && <div className="alert a-warn" style={{ marginBottom: 16 }}>{error}</div>}
              <form onSubmit={onSubmit}>
                <div className="fg">
                  <label className="fl">New password</label>
                  <input
                    className="fi"
                    type="password"
                    value={password}
                    onChange={e => setPassword(e.target.value)}
                    minLength={12}
                    required
                    autoFocus
                    autoComplete="new-password"
                  />
                </div>
                <div className="fg">
                  <label className="fl">Confirm new password</label>
                  <input
                    className="fi"
                    type="password"
                    value={confirm}
                    onChange={e => setConfirm(e.target.value)}
                    minLength={12}
                    required
                    autoComplete="new-password"
                  />
                </div>
                <button
                  className="btn btn-p"
                  type="submit"
                  disabled={submitting}
                  style={{ width: '100%', justifyContent: 'center', marginTop: 8 }}
                >
                  {submitting ? <span className="spinner" /> : 'Set new password'}
                </button>
              </form>
            </>
          ) : (
            <>
              <h2 style={{ marginBottom: 12 }}>Password updated</h2>
              <p style={{ color: 'var(--t2)', fontSize: '.85rem', lineHeight: 1.6, marginBottom: 24 }}>
                Your password has been changed. Sign in with your new password to continue.
              </p>
              <Link
                to="/login"
                className="btn btn-p"
                style={{ width: '100%', justifyContent: 'center', textDecoration: 'none' }}
              >
                Sign in
              </Link>
            </>
          )}

          {!done && (
            <div style={{ marginTop: 24, paddingTop: 16, borderTop: '1px solid var(--bg2)', textAlign: 'center' }}>
              <Link to="/login" style={{ color: 'var(--gold)', fontSize: '.85rem', textDecoration: 'none' }}>
                ← Back to sign in
              </Link>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function ErrorShell({ title, body }: { title: string; body: string }) {
  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg0)', padding: 20 }}>
      <div style={{ width: '100%', maxWidth: 420 }}>
        <div style={{ textAlign: 'center', marginBottom: 32 }}>
          <div style={{ fontFamily: 'var(--font-d)', fontSize: '2rem', fontWeight: 800, color: 'var(--gold)', marginBottom: 8 }}>⚡ GAM</div>
        </div>
        <div className="card" style={{ padding: 28, textAlign: 'center' }}>
          <div style={{ fontSize: 36, marginBottom: 12 }}>⚠️</div>
          <h2 style={{ marginBottom: 12 }}>{title}</h2>
          <p style={{ color: 'var(--t2)', fontSize: '.85rem', lineHeight: 1.6, marginBottom: 24 }}>{body}</p>
          <Link to="/forgot-password" className="btn btn-p" style={{ width: '100%', justifyContent: 'center', textDecoration: 'none' }}>
            Request a new reset link
          </Link>
          <div style={{ marginTop: 16 }}>
            <Link to="/login" style={{ color: 'var(--gold)', fontSize: '.85rem', textDecoration: 'none' }}>
              ← Back to sign in
            </Link>
          </div>
        </div>
      </div>
    </div>
  )
}
