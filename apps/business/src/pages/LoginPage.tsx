import { useState } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'

export function LoginPage() {
  const { login, loginWithEmailOtp, resendEmailOtp } = useAuth()
  const navigate = useNavigate()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  // S578: mandatory email-2FA (business_owner) — the emailed-code second step.
  const [emailOtpSession, setEmailOtpSession] = useState<string | null>(null)
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

        <label style={labelStyle}>Email</label>
        <input
          value={email} onChange={e => setEmail(e.target.value)}
          type="email" required
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
