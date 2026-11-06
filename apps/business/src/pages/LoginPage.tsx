import { useState } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { PasskeySignIn } from '../../../../packages/shared-ui/Passkeys'
import { apiGet, apiPost, apiDelete } from '../lib/api'

// ── THE CODE STEP MUST SURVIVE LEAVING THE PAGE (S639/S654, ported 10/30) ────
//
// Nic: "they go back out to get the two-factor authentication code, [and] it
// boots them out." Nothing was ever signed in — the pending OTP session lived
// in React state, so switching to the mail app let the phone browser discard
// and reload the page, and it came back as the email/password form with the
// code they are now holding useless. Every login hits this, because email 2FA
// is on for every account.
//
// localStorage, not sessionStorage: sessionStorage is PER TAB, and somebody who
// reads the code in their mail app and returns through a link lands in a NEW
// tab with no pending session. The stored token is PRE-auth, useless without
// the emailed code, and expires in 15 minutes — the same trust level as the
// page holding it in memory. Cleared the moment the code is accepted.
//
// The tenant portal has the canonical copy of this (usePendingOtpSession in
// apps/tenant/src/main.tsx); POS, business, admin and admin-ops never got it.
function usePendingOtpSession(key: string): [string | null, (v: string | null) => void] {
  const [v, setV] = useState<string | null>(() => {
    try { return localStorage.getItem(key) ?? sessionStorage.getItem(key) } catch { return null }
  })
  const set = (next: string | null) => {
    setV(next)
    try {
      if (next) localStorage.setItem(key, next)
      else { localStorage.removeItem(key); sessionStorage.removeItem(key) }
    } catch { /* private mode — behaves exactly as before */ }
  }
  return [v, set]
}

// 10/30 (Nic): "a passkey replaces the emailed code." The shared component
// speaks this portal's own client — apiPost hands back the whole envelope and
// the component wants the payload.
const passkeyApi = {
  get:  (url: string) => apiGet(url),
  post: (url: string, body?: any) => apiPost(url, body).then((r: any) => r.data),
  del:  (url: string) => apiDelete(url),
}

export function LoginPage() {
  const { login, loginWithEmailOtp, resendEmailOtp, loginWithPasskey } = useAuth()
  const navigate = useNavigate()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  // S578: mandatory email-2FA (business_owner) — the emailed-code second step.
  const [emailOtpSession, setEmailOtpSession] = usePendingOtpSession('gam.otp.business.login')
  const [code, setCode] = useState('')
  const [resent, setResent] = useState(false)

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setErr(null); setPending(true)
    try {
      const r = await login(email, password)
      if (r.kind === 'email_otp_required') { setEmailOtpSession(r.emailOtpSession); setCode(''); setResent(false) }
      else navigate('/dashboard')
    } catch (e: any) {
      setErr(e?.response?.data?.error || e?.message || 'Login failed')
    } finally { setPending(false) }
  }

  const onOtpSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setErr(null); setPending(true)
    try {
      await loginWithEmailOtp(emailOtpSession!, code.trim())
      navigate('/dashboard')
    } catch (e: any) {
      const msg = e?.response?.data?.error || e?.message || 'Invalid code.'
      setErr(msg)
      if (/session/i.test(msg)) { setEmailOtpSession(null); setCode('') }
    } finally { setPending(false) }
  }

  const onResend = async () => {
    setErr(null); setResent(false)
    try { await resendEmailOtp(emailOtpSession!); setResent(true) }
    catch (e: any) { setErr(e?.response?.data?.error || 'Could not resend the code.') }
  }

  // S578: step 2 — emailed 2FA code.
  if (emailOtpSession) {
    return (
      <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', background: 'var(--bg-0)', color: 'var(--text-0)' }}>
        <form onSubmit={onOtpSubmit} style={{ width: 360, padding: 32, background: 'var(--bg-1)', border: '1px solid var(--border-0)', borderRadius: 12 }}>
          <div style={{ fontFamily: 'var(--font-display)', fontSize: 24, color: 'var(--gold)' }}>GAM</div>
          <div style={{ fontFamily: 'var(--font-body)', fontSize: 14, color: 'var(--text-2)', marginTop: 2, marginBottom: 20 }}>Two-factor authentication</div>
          <div style={{ fontSize: 13, color: 'var(--text-2)', marginBottom: 16, lineHeight: 1.6 }}>We emailed a 6-digit code. Enter it to finish signing in.</div>
          <label style={labelStyle}>Code</label>
          <input value={code} onChange={e => setCode(e.target.value)} inputMode="numeric" autoComplete="one-time-code" autoFocus required placeholder="123 456" style={{ ...inputStyle, textAlign: 'center', letterSpacing: '.2em' }} />
          {resent && !err && <div style={{ marginTop: 12, fontSize: 13, color: 'var(--green)' }}>A new code is on its way.</div>}
          {err && <div style={errStyle}>{err}</div>}
          <button type="submit" disabled={pending || !code.trim()} style={{ ...btnStyle, opacity: (pending || !code.trim()) ? 0.6 : 1 }}>{pending ? 'Verifying…' : 'Verify'}</button>
          <div style={{ marginTop: 16, display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
            <button type="button" onClick={() => { setEmailOtpSession(null); setCode(''); setErr(null); setResent(false) }} style={{ background: 'none', border: 'none', color: 'var(--text-2)', cursor: 'pointer', textDecoration: 'underline' }}>← Back</button>
            <button type="button" onClick={onResend} style={{ background: 'none', border: 'none', color: 'var(--gold)', cursor: 'pointer', textDecoration: 'underline' }}>Resend code</button>
          </div>
        </form>
      </div>
    )
  }

  return (
    <div style={{
      minHeight: '100vh',
      display: 'grid', placeItems: 'center',
      background: 'var(--bg-0)', color: 'var(--text-0)',
    }}>
      <form onSubmit={onSubmit} style={{
        width: 360, padding: 32,
        background: 'var(--bg-1)',
        border: '1px solid var(--border-0)',
        borderRadius: 12,
      }}>
        <div style={{
          fontFamily: 'var(--font-display)', fontSize: 24, color: 'var(--gold)',
        }}>GAM</div>
        <div style={{
          fontFamily: 'var(--font-body)', fontSize: 14, color: 'var(--text-2)',
          marginTop: 2, marginBottom: 24,
        }}>for Businesses</div>

        {/* 10/30 (Nic): Face ID alone signs you in. Renders nothing on a device
            with no sensor, so the password form below is exactly what it has
            always been for everybody else. */}
        <PasskeySignIn api={passkeyApi} onSignedIn={async s => { await loginWithPasskey(s); navigate('/dashboard') }} />

        <label style={labelStyle}>Email</label>
        <input
          value={email} onChange={e => setEmail(e.target.value)}
          type="email" required
          autoComplete="username webauthn" name="email"
          style={inputStyle}
        />

        <label style={labelStyle}>Password</label>
        <input
          value={password} onChange={e => setPassword(e.target.value)}
          type="password" required
          style={inputStyle}
        />

        {err && <div style={errStyle}>{err}</div>}

        <button
          type="submit" disabled={pending}
          style={{ ...btnStyle, opacity: pending ? 0.6 : 1 }}
        >
          {pending ? 'Signing in…' : 'Sign in'}
        </button>

        {/* S605: no way to recover a forgotten password existed here, so a
            mistyped password meant permanent lockout. */}
        <div style={{ marginTop: 14, textAlign: 'center', fontSize: 13 }}>
          <Link to="/forgot-password" style={{ color: 'var(--text-2)' }}>Forgot your password?</Link>
        </div>

        <div style={{
          marginTop: 12, textAlign: 'center', fontSize: 13,
          color: 'var(--text-2)',
        }}>
          New business owner? <Link to="/signup" style={{ color: 'var(--gold)' }}>Sign up</Link>
        </div>
      </form>
    </div>
  )
}

const labelStyle: React.CSSProperties = {
  display: 'block', fontSize: 12, color: 'var(--text-2)',
  marginBottom: 6, marginTop: 12, fontFamily: 'var(--font-body)',
}
const inputStyle: React.CSSProperties = {
  width: '100%', padding: '10px 12px',
  background: 'var(--bg-2)', color: 'var(--text-0)',
  border: '1px solid var(--border-1)', borderRadius: 8,
  fontSize: 14, fontFamily: 'var(--font-body)',
}
const btnStyle: React.CSSProperties = {
  width: '100%', padding: '12px',
  background: 'var(--gold)', color: 'var(--bg-0)',
  border: 'none', borderRadius: 8,
  fontSize: 14, fontWeight: 600,
  marginTop: 20, cursor: 'pointer',
  fontFamily: 'var(--font-body)',
}
const errStyle: React.CSSProperties = {
  marginTop: 12, padding: '10px 12px',
  background: 'var(--red-bg)', color: 'var(--red)',
  border: '1px solid var(--red-dim)', borderRadius: 8,
  fontSize: 13, fontFamily: 'var(--font-body)',
}
