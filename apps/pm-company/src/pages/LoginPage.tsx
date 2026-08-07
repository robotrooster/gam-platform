import { useState } from 'react'
import { Navigate, useNavigate, Link } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'

export function LoginPage() {
  const { login, loginWithTotp, loginWithEmailOtp, resendEmailOtp, user, loading } = useAuth()
  const navigate = useNavigate()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // TOTP second step. When /login returns requiresTotp, we stash the
  // short-lived session token and flip to the code-entry view.
  const [totpSession, setTotpSession] = useState<string | null>(null)
  // S578: universal email-2FA second step.
  const [emailOtpSession, setEmailOtpSession] = useState<string | null>(null)
  const [resent, setResent] = useState(false)
  const [code, setCode] = useState('')

  if (loading) return <div style={{ padding: 32, color: 'var(--text-3)' }}>Loading…</div>
  if (user) return <Navigate to="/" replace />

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setErr(null); setBusy(true)
    try {
      const res = await login(email, password)
      if (res.kind === 'totp_required') {
        setTotpSession(res.totpSession)
        setBusy(false)
        return
      }
      if (res.kind === 'email_otp_required') {
        setEmailOtpSession(res.emailOtpSession)
        setBusy(false)
        return
      }
      navigate('/')
    }
    catch (ex: any) { setErr(ex?.response?.data?.error || 'Login failed.'); setBusy(false) }
  }

  const submitCode = async (e: React.FormEvent) => {
    e.preventDefault()
    setErr(null); setBusy(true)
    try {
      if (emailOtpSession) await loginWithEmailOtp(emailOtpSession, code.trim())
      else await loginWithTotp(totpSession!, code.trim())
      navigate('/')
    }
    catch (ex: any) {
      setErr(ex?.response?.data?.error || 'Verification failed.')
      setBusy(false)
    }
  }

  const resend = async () => {
    setErr(null); setResent(false)
    try { await resendEmailOtp(emailOtpSession!); setResent(true) }
    catch (ex: any) { setErr(ex?.response?.data?.error || 'Could not resend the code.') }
  }

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg-0)' }}>
      <div className="card" style={{ width: 400, padding: 32 }}>
        <div style={{ textAlign: 'center', marginBottom: 24 }}>
          <div style={{ fontSize: '1.4rem', fontWeight: 700, color: 'var(--gold)' }}>⚡ GAM PM</div>
          <div style={{ fontSize: '.78rem', color: 'var(--text-3)', marginTop: 4 }}>
            Property management portal
          </div>
        </div>

        {(!totpSession && !emailOtpSession) ? (
          <>
            <form onSubmit={submit}>
              <div style={{ marginBottom: 12 }}>
                <label style={{ fontSize: '.72rem', fontWeight: 600, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.06em', display: 'block', marginBottom: 5 }}>Email</label>
                <input type="email" required className="input" value={email}
                       onChange={e => setEmail(e.target.value)} style={{ width: '100%' }} />
              </div>
              <div style={{ marginBottom: 16 }}>
                <label style={{ fontSize: '.72rem', fontWeight: 600, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.06em', display: 'block', marginBottom: 5 }}>Password</label>
                <input type="password" required className="input" value={password}
                       onChange={e => setPassword(e.target.value)} style={{ width: '100%' }} />
              </div>

              {err && (
                <div style={{ padding: 8, background: 'rgba(220,76,76,.1)', borderRadius: 6, fontSize: '.74rem', color: 'var(--red, #dc4c4c)', marginBottom: 12 }}>
                  {err}
                </div>
              )}

              <button type="submit" className="btn btn-primary" disabled={busy} style={{ width: '100%' }}>
                {busy ? 'Signing in…' : 'Sign in'}
              </button>
            </form>

            <div style={{ marginTop: 16, textAlign: 'center', fontSize: '.78rem', color: 'var(--text-3)' }}>
              No account? <Link to="/register" style={{ color: 'var(--gold)' }}>Register a PM company</Link>
            </div>
          </>
        ) : (
          <form onSubmit={submitCode}>
            <div style={{ marginBottom: 16, fontSize: '.78rem', color: 'var(--text-2)', textAlign: 'center' }}>
              {emailOtpSession
                ? 'Enter the 6-digit code we emailed you.'
                : 'Enter the 6-digit code from your authenticator app.'}
              {!emailOtpSession && (
                <div style={{ fontSize: '.72rem', color: 'var(--text-3)', marginTop: 4 }}>
                  Lost your device? Enter a recovery code instead.
                </div>
              )}
              {emailOtpSession && resent && (
                <div style={{ fontSize: '.72rem', color: 'var(--green, #46a758)', marginTop: 4 }}>A new code is on its way.</div>
              )}
            </div>

            <div style={{ marginBottom: 16 }}>
              <label style={{ fontSize: '.72rem', fontWeight: 600, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.06em', display: 'block', marginBottom: 5 }}>Authentication code</label>
              <input
                type="text"
                inputMode="text"
                autoComplete="one-time-code"
                autoFocus
                required
                className="input"
                value={code}
                onChange={e => setCode(e.target.value)}
                placeholder="123456"
                style={{ width: '100%', textAlign: 'center', letterSpacing: '.2em', fontFamily: 'var(--font-mono)' }}
              />
            </div>

            {err && (
              <div style={{ padding: 8, background: 'rgba(220,76,76,.1)', borderRadius: 6, fontSize: '.74rem', color: 'var(--red, #dc4c4c)', marginBottom: 12 }}>
                {err}
              </div>
            )}

            <button type="submit" className="btn btn-primary" disabled={busy || !code.trim()} style={{ width: '100%' }}>
              {busy ? 'Verifying…' : 'Verify & sign in'}
            </button>

            {emailOtpSession && (
              <button type="button" className="btn btn-ghost" disabled={busy} onClick={resend} style={{ width: '100%', marginTop: 8 }}>
                Resend code
              </button>
            )}

            <button
              type="button"
              className="btn btn-ghost"
              disabled={busy}
              onClick={() => { setTotpSession(null); setEmailOtpSession(null); setResent(false); setCode(''); setErr(null) }}
              style={{ width: '100%', marginTop: 8 }}
            >
              Back
            </button>
          </form>
        )}
      </div>
    </div>
  )
}
