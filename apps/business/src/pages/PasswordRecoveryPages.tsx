import { useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { apiPost } from '../lib/api'

/**
 * S605 — password recovery for the business portal.
 *
 * The landlord portal had no recovery at all: no link, no page, no route, while
 * the API endpoint had existed since S289. A business owner who forgot the
 * password they set at signup was permanently locked out with no self-serve way
 * back. Nic hit exactly that on the real Oak Park landlord account, so the same
 * gap is closed here and on the PM-company portal before it bites a customer.
 *
 * The API sends the reset link back to whichever portal ORIGINATED the request
 * (allow-listed against the portal URLs), so a business owner lands here rather
 * than on the tenant app.
 *
 * Styling is inline to match this app's LoginPage, which uses inline style
 * objects rather than the landlord portal's CSS classes.
 */

const wrap: React.CSSProperties = {
  minHeight: '100vh', display: 'grid', placeItems: 'center',
  background: 'var(--bg-0)', color: 'var(--text-0)',
}
const card: React.CSSProperties = {
  width: 360, padding: 32, background: 'var(--bg-1)',
  border: '1px solid var(--border-0)', borderRadius: 12,
}
const brand: React.CSSProperties = {
  fontFamily: 'var(--font-display)', fontSize: 24, color: 'var(--gold)',
}
const labelStyle: React.CSSProperties = {
  display: 'block', fontSize: 12, color: 'var(--text-2)',
  marginBottom: 6, marginTop: 12, fontFamily: 'var(--font-body)',
}
const inputStyle: React.CSSProperties = {
  width: '100%', padding: '10px 12px', background: 'var(--bg-2)', color: 'var(--text-0)',
  border: '1px solid var(--border-1)', borderRadius: 8, fontSize: 14, fontFamily: 'var(--font-body)',
}
const btnStyle: React.CSSProperties = {
  width: '100%', padding: '12px', background: 'var(--gold)', color: 'var(--bg-0)',
  border: 'none', borderRadius: 8, fontSize: 14, fontWeight: 600,
  marginTop: 20, cursor: 'pointer', fontFamily: 'var(--font-body)',
}
const errStyle: React.CSSProperties = {
  marginTop: 12, padding: '10px 12px', background: 'var(--red-bg)', color: 'var(--red)',
  border: '1px solid var(--red-dim)', borderRadius: 8, fontSize: 13, fontFamily: 'var(--font-body)',
}
const noteStyle: React.CSSProperties = {
  marginTop: 12, fontSize: 13, color: 'var(--text-2)', lineHeight: 1.6, fontFamily: 'var(--font-body)',
}
const backStyle: React.CSSProperties = {
  marginTop: 16, textAlign: 'center', fontSize: 13, color: 'var(--text-2)',
}

export function BusinessForgotPasswordPage() {
  const [email, setEmail] = useState('')
  const [sent, setSent] = useState(false)
  const [pending, setPending] = useState(false)
  const [err, setErr] = useState('')

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setPending(true); setErr('')
    try {
      await apiPost('/auth/forgot-password', { email: email.trim() })
      setSent(true)
    } catch {
      // The endpoint returns 200 even for unknown emails (no account
      // enumeration), so anything thrown here is a network/5xx problem.
      setErr('Could not send the reset email right now. Please try again in a moment.')
    } finally { setPending(false) }
  }

  return (
    <div style={wrap}>
      <form onSubmit={onSubmit} style={card}>
        <div style={brand}>GAM</div>
        {!sent ? (
          <>
            <div style={noteStyle}>
              Enter the email you signed up with and we'll send a link to set a new password.
            </div>
            <label style={labelStyle}>Email</label>
            <input style={inputStyle} type="email" value={email} required autoFocus
              autoComplete="email" placeholder="you@example.com"
              onChange={(e) => setEmail(e.target.value)} />
            {err && <div style={errStyle}>{err}</div>}
            <button type="submit" disabled={pending || !email.trim()}
              style={{ ...btnStyle, opacity: pending ? 0.6 : 1 }}>
              {pending ? 'Sending…' : 'Send reset link'}
            </button>
          </>
        ) : (
          <div style={noteStyle}>
            If an account exists for <strong style={{ color: 'var(--text-0)' }}>{email.trim()}</strong>,
            a reset link is on its way. It is single-use and expires shortly, so use it soon.
          </div>
        )}
        <div style={backStyle}>
          <Link to="/login" style={{ color: 'var(--gold)' }}>← Back to sign in</Link>
        </div>
      </form>
    </div>
  )
}

export function BusinessResetPasswordPage() {
  const [params] = useSearchParams()
  const token = params.get('token') ?? ''
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [pending, setPending] = useState(false)
  const [err, setErr] = useState('')
  const [done, setDone] = useState(false)

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setErr('')
    // Matches the backend rule: length over composition (NIST SP 800-63B).
    if (password.length < 12) { setErr('Password must be at least 12 characters.'); return }
    if (password !== confirm) { setErr('Passwords do not match.'); return }
    setPending(true)
    try {
      await apiPost('/auth/reset-password', { token, newPassword: password })
      setDone(true)
    } catch (e: any) {
      const msg = e?.response?.data?.error
      setErr(typeof msg === 'string' ? msg : 'Something went wrong. Please request a new reset link.')
      setPending(false)
    }
  }

  if (!token) {
    return (
      <div style={wrap}>
        <div style={card}>
          <div style={brand}>GAM</div>
          <div style={noteStyle}>This link is missing its token. Request a new password reset to try again.</div>
          <div style={backStyle}>
            <Link to="/forgot-password" style={{ color: 'var(--gold)' }}>Request a new reset link</Link>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div style={wrap}>
      <form onSubmit={onSubmit} style={card}>
        <div style={brand}>GAM</div>
        {!done ? (
          <>
            <div style={noteStyle}>
              Pick something you'll remember. Minimum 12 characters — longer is better.
              You don't need symbols or numbers.
            </div>
            <label style={labelStyle}>New password</label>
            <input style={inputStyle} type="password" value={password} minLength={12} required autoFocus
              autoComplete="new-password" onChange={(e) => setPassword(e.target.value)} />
            <label style={labelStyle}>Confirm new password</label>
            <input style={inputStyle} type="password" value={confirm} minLength={12} required
              autoComplete="new-password" onChange={(e) => setConfirm(e.target.value)} />
            {err && <div style={errStyle}>{err}</div>}
            <button type="submit" disabled={pending} style={{ ...btnStyle, opacity: pending ? 0.6 : 1 }}>
              {pending ? 'Saving…' : 'Set new password'}
            </button>
          </>
        ) : (
          <div style={noteStyle}>
            Your password has been changed. Sign in with the new one — you'll get an emailed code to finish.
          </div>
        )}
        <div style={backStyle}>
          <Link to="/login" style={{ color: 'var(--gold)' }}>← Back to sign in</Link>
        </div>
      </form>
    </div>
  )
}
