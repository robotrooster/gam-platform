import { useState } from 'react'
import { Navigate, useNavigate, Link } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'

export function LoginPage() {
  const { login, loginWithTotp, user, loading } = useAuth()
  const navigate = useNavigate()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // TOTP second step. When /login returns requiresTotp, we stash the
  // short-lived session token and flip to the code-entry view.
  const [totpSession, setTotpSession] = useState<string | null>(null)
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
      navigate('/')
    }
    catch (ex: any) { setErr(ex?.response?.data?.error || 'Login failed.'); setBusy(false) }
  }

  const submitTotp = async (e: React.FormEvent) => {
    e.preventDefault()
    setErr(null); setBusy(true)
    try {
      await loginWithTotp(totpSession!, code.trim())
      navigate('/')
    }
    catch (ex: any) {
      setErr(ex?.response?.data?.error || 'Verification failed.')
      setBusy(false)
    }
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

        {!totpSession ? (
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
          <form onSubmit={submitTotp}>
            <div style={{ marginBottom: 16, fontSize: '.78rem', color: 'var(--text-2)', textAlign: 'center' }}>
              Enter the 6-digit code from your authenticator app.
              <div style={{ fontSize: '.72rem', color: 'var(--text-3)', marginTop: 4 }}>
                Lost your device? Enter a recovery code instead.
              </div>
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

            <button
              type="button"
              className="btn btn-ghost"
              disabled={busy}
              onClick={() => { setTotpSession(null); setCode(''); setErr(null) }}
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
