import { useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { apiPost } from '../lib/api'

/**
 * S605 — password recovery for the PM-company portal.
 *
 * Same gap the landlord portal had: no link, no page, no route, while the API
 * endpoint had existed since S289 — so a forgotten password meant permanent
 * lockout with no self-serve way back. Nic hit exactly that on the real Oak
 * Park account; closing it here before it reaches a PM-company customer.
 *
 * The API returns the reset link pointed at whichever portal ORIGINATED the
 * request (allow-listed against the portal URLs), so a PM lands here rather
 * than on the tenant app.
 */

const LABEL: React.CSSProperties = {
  fontSize: '.72rem', fontWeight: 600, color: 'var(--text-3)',
  textTransform: 'uppercase', letterSpacing: '.06em', display: 'block', marginBottom: 5,
}
const ERR: React.CSSProperties = {
  padding: 8, background: 'rgba(220,76,76,.1)', borderRadius: 6,
  fontSize: '.74rem', color: 'var(--red, #dc4c4c)', marginBottom: 12,
}
const NOTE: React.CSSProperties = {
  fontSize: '.78rem', color: 'var(--text-2)', lineHeight: 1.6, marginBottom: 16,
}
const BACK: React.CSSProperties = {
  marginTop: 16, textAlign: 'center', fontSize: '.78rem', color: 'var(--text-3)',
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg-0)' }}>
      <div className="card" style={{ width: 400, padding: 32 }}>
        <div style={{ textAlign: 'center', marginBottom: 24 }}>
          <div style={{ fontSize: '1.4rem', fontWeight: 700, color: 'var(--gold)' }}>⚡ GAM PM</div>
          <div style={{ fontSize: '.78rem', color: 'var(--text-3)', marginTop: 4 }}>
            Property management portal
          </div>
        </div>
        {children}
      </div>
    </div>
  )
}

export function PmForgotPasswordPage() {
  const [email, setEmail] = useState('')
  const [sent, setSent] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setErr(null); setBusy(true)
    try {
      await apiPost('/auth/forgot-password', { email: email.trim() })
      setSent(true)
    } catch {
      // 200 is returned even for unknown emails (no account enumeration), so a
      // throw here is a network/5xx failure, not "no such account".
      setErr('Could not send the reset email right now. Please try again in a moment.')
    } finally { setBusy(false) }
  }

  return (
    <Shell>
      {!sent ? (
        <form onSubmit={submit}>
          <div style={NOTE}>
            Enter the email you signed up with and we'll send a link to set a new password.
          </div>
          <div style={{ marginBottom: 16 }}>
            <label style={LABEL}>Email</label>
            <input type="email" required autoFocus className="input" value={email}
                   autoComplete="email" onChange={(e) => setEmail(e.target.value)} style={{ width: '100%' }} />
          </div>
          {err && <div style={ERR}>{err}</div>}
          <button type="submit" className="btn btn-primary" disabled={busy || !email.trim()} style={{ width: '100%' }}>
            {busy ? 'Sending…' : 'Send reset link'}
          </button>
        </form>
      ) : (
        <div style={NOTE}>
          If an account exists for <strong style={{ color: 'var(--text-0)' }}>{email.trim()}</strong>,
          a reset link is on its way. It is single-use and expires shortly, so use it soon.
        </div>
      )}
      <div style={BACK}>
        <Link to="/login" style={{ color: 'var(--gold)' }}>← Back to sign in</Link>
      </div>
    </Shell>
  )
}

export function PmResetPasswordPage() {
  const [params] = useSearchParams()
  const token = params.get('token') ?? ''
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [done, setDone] = useState(false)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setErr(null)
    // Mirrors the backend: length over composition (NIST SP 800-63B).
    if (password.length < 12) { setErr('Password must be at least 12 characters.'); return }
    if (password !== confirm) { setErr('Passwords do not match.'); return }
    setBusy(true)
    try {
      await apiPost('/auth/reset-password', { token, newPassword: password })
      setDone(true)
    } catch (e: any) {
      const msg = e?.response?.data?.error
      setErr(typeof msg === 'string' ? msg : 'Something went wrong. Please request a new reset link.')
      setBusy(false)
    }
  }

  if (!token) {
    return (
      <Shell>
        <div style={NOTE}>This link is missing its token. Request a new password reset to try again.</div>
        <div style={BACK}>
          <Link to="/forgot-password" style={{ color: 'var(--gold)' }}>Request a new reset link</Link>
        </div>
      </Shell>
    )
  }

  return (
    <Shell>
      {!done ? (
        <form onSubmit={submit}>
          <div style={NOTE}>
            Pick something you'll remember. Minimum 12 characters — longer is better.
            You don't need symbols or numbers.
          </div>
          <div style={{ marginBottom: 12 }}>
            <label style={LABEL}>New password</label>
            <input type="password" required autoFocus minLength={12} className="input" value={password}
                   autoComplete="new-password" onChange={(e) => setPassword(e.target.value)} style={{ width: '100%' }} />
          </div>
          <div style={{ marginBottom: 16 }}>
            <label style={LABEL}>Confirm new password</label>
            <input type="password" required minLength={12} className="input" value={confirm}
                   autoComplete="new-password" onChange={(e) => setConfirm(e.target.value)} style={{ width: '100%' }} />
          </div>
          {err && <div style={ERR}>{err}</div>}
          <button type="submit" className="btn btn-primary" disabled={busy} style={{ width: '100%' }}>
            {busy ? 'Saving…' : 'Set new password'}
          </button>
        </form>
      ) : (
        <div style={NOTE}>
          Your password has been changed. Sign in with the new one — you'll get an emailed code to finish.
        </div>
      )}
      <div style={BACK}>
        <Link to="/login" style={{ color: 'var(--gold)' }}>← Back to sign in</Link>
      </div>
    </Shell>
  )
}
