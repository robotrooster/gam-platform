import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { apiPost } from '../lib/api'

/**
 * Post-login 2FA enrollment. PM-company 2FA is optional-with-prompts —
 * this page is reached from the Settings → Security "Enable" action, not
 * a hard gate. On success it refreshes /auth/me (flipping totpEnabled
 * true) and returns the user to Settings.
 *
 * enroll-start → { otpauthUrl, qrDataUri, recoveryCodes[] }
 * enroll-confirm { token } → flips totp_enabled.
 */
export function TotpEnrollPage() {
  const { refresh } = useAuth()
  const navigate = useNavigate()
  const [state, setState] = useState<'loading' | 'showCodes' | 'done' | 'error'>('loading')
  const [err, setErr] = useState('')
  const [qrDataUri, setQrDataUri] = useState('')
  const [otpauthUrl, setOtpauthUrl] = useState('')
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([])
  const [code, setCode] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [savedAck, setSavedAck] = useState(false)

  useEffect(() => {
    let cancelled = false
    apiPost<{ otpauthUrl: string; qrDataUri: string; recoveryCodes: string[] }>('/auth/totp/enroll-start')
      .then(r => {
        if (cancelled) return
        const d = r.data!
        setQrDataUri(d.qrDataUri); setOtpauthUrl(d.otpauthUrl)
        setRecoveryCodes(d.recoveryCodes || [])
        setState('showCodes')
      })
      .catch((e: any) => {
        if (cancelled) return
        // 409 if already enrolled — nothing to do, return to settings.
        if (e.response?.status === 409) { navigate('/settings', { replace: true }); return }
        setErr(e.response?.data?.error || 'Could not start enrollment.')
        setState('error')
      })
    return () => { cancelled = true }
  }, [navigate])

  const onConfirm = async (e: React.FormEvent) => {
    e.preventDefault(); setSubmitting(true); setErr('')
    try {
      await apiPost('/auth/totp/enroll-confirm', { token: code.trim() })
      await refresh()
      setState('done')
      setTimeout(() => navigate('/settings', { replace: true }), 700)
    } catch (ex: any) {
      setErr(ex.response?.data?.error || 'Verification failed. Try the current code from your app.')
      setSubmitting(false)
    }
  }

  if (state === 'loading') {
    return <div style={{ padding: 48, display: 'flex', justifyContent: 'center' }}><div className="spinner" /></div>
  }

  if (state === 'error') {
    return (
      <div style={{ padding: 24 }}>
        <div className="card" style={{ padding: 24, maxWidth: 480, textAlign: 'center' }}>
          <div style={{ fontSize: 36, marginBottom: 12 }}>⚠️</div>
          <h2 style={{ marginBottom: 12 }}>Couldn&apos;t start enrollment</h2>
          <p style={{ color: 'var(--text-2)', fontSize: '.85rem', lineHeight: 1.6, marginBottom: 16 }}>{err}</p>
          <button className="btn btn-ghost" onClick={() => navigate('/settings')} style={{ width: '100%', justifyContent: 'center' }}>
            Back to Settings
          </button>
        </div>
      </div>
    )
  }

  if (state === 'done') {
    return (
      <div style={{ padding: 24 }}>
        <div className="card" style={{ padding: 24, maxWidth: 480, textAlign: 'center' }}>
          <div style={{ fontSize: 36, marginBottom: 12 }}>✅</div>
          <h2 style={{ marginBottom: 12 }}>Two-factor authentication enabled</h2>
          <p style={{ color: 'var(--text-2)', fontSize: '.85rem', lineHeight: 1.6 }}>Returning to Settings…</p>
        </div>
      </div>
    )
  }

  return (
    <div style={{ padding: 24 }}>
      <div style={{ marginBottom: 20 }}>
        <h1 style={{ margin: 0, fontSize: '1.4rem', color: 'var(--text-0)' }}>Set up two-factor authentication</h1>
        <div style={{ fontSize: '.78rem', color: 'var(--text-3)', marginTop: 4 }}>
          Add an authenticator-app code to every sign-in.
        </div>
      </div>

      <div className="card" style={{ padding: 24, maxWidth: 620 }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: 16, alignItems: 'start', marginBottom: 18 }}>
          <div style={{ padding: 10, background: '#fff', borderRadius: 8, lineHeight: 0 }}>
            <img src={qrDataUri} alt="Scan this QR code with your authenticator app" style={{ display: 'block', width: 180, height: 180 }} />
          </div>
          <div style={{ fontSize: '.82rem', color: 'var(--text-1)', lineHeight: 1.6 }}>
            <div style={{ fontWeight: 700, color: 'var(--text-0)', marginBottom: 6 }}>1. Scan with your authenticator app</div>
            <div style={{ color: 'var(--text-2)', fontSize: '.78rem', marginBottom: 10 }}>
              Google Authenticator, Authy, 1Password, Bitwarden — any TOTP app works. Open the app, tap &quot;Add account&quot; or the + icon, then scan the QR code on the left.
            </div>
            <div style={{ fontSize: '.72rem', color: 'var(--text-3)' }}>
              Can&apos;t scan? <a href={otpauthUrl} style={{ color: 'var(--gold)', wordBreak: 'break-all' }}>Tap to add manually →</a>
            </div>
          </div>
        </div>

        <div style={{ marginBottom: 18, padding: 14, background: 'var(--amber-bg)', border: '1px solid rgba(245,158,11,.2)', borderRadius: 8 }}>
          <div style={{ fontWeight: 700, color: 'var(--amber)', marginBottom: 8, fontSize: '.85rem' }}>2. Save these recovery codes</div>
          <div style={{ fontSize: '.78rem', color: 'var(--text-2)', marginBottom: 10, lineHeight: 1.5 }}>
            If you ever lose access to your authenticator app, these one-time codes are the only way to get back in. Store them somewhere safe — a password manager works well.
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, marginBottom: 10 }}>
            {recoveryCodes.map(rc => (
              <div key={rc} style={{ fontFamily: 'var(--font-mono)', fontSize: '.85rem', color: 'var(--text-0)', background: 'var(--bg-3)', padding: '5px 9px', borderRadius: 5, letterSpacing: '.05em' }}>{rc}</div>
            ))}
          </div>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '.78rem', color: 'var(--text-1)', cursor: 'pointer' }}>
            <input type="checkbox" checked={savedAck} onChange={e => setSavedAck(e.target.checked)} />
            I&apos;ve saved my recovery codes somewhere safe.
          </label>
        </div>

        <form onSubmit={onConfirm}>
          <div style={{ marginBottom: 12 }}>
            <label style={{ display: 'block', fontSize: '.72rem', fontWeight: 600, color: 'var(--text-3)', marginBottom: 5, textTransform: 'uppercase', letterSpacing: '.06em' }}>
              3. Enter the 6-digit code from your app to confirm
            </label>
            <input
              className="input"
              style={{ width: '100%', textAlign: 'center', letterSpacing: '.2em', fontFamily: 'var(--font-mono)' }}
              type="text"
              value={code}
              onChange={e => setCode(e.target.value)}
              required
              inputMode="numeric"
              pattern="[0-9 ]*"
              autoComplete="one-time-code"
              placeholder="000000"
              maxLength={7}
            />
          </div>
          {err && (
            <div style={{ padding: 8, background: 'rgba(220,76,76,.1)', borderRadius: 6, fontSize: '.74rem', color: 'var(--red, #dc4c4c)', marginBottom: 12 }}>
              {err}
            </div>
          )}
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-primary" type="submit" disabled={submitting || !savedAck || code.trim().length < 6} style={{ justifyContent: 'center' }}>
              {submitting ? 'Enabling…' : 'Enable two-factor'}
            </button>
            <button className="btn btn-ghost" type="button" disabled={submitting} onClick={() => navigate('/settings')}>
              Cancel
            </button>
          </div>
          <div style={{ marginTop: 10, fontSize: '.72rem', color: 'var(--text-3)' }}>
            Confirm the codes are saved before continuing — they&apos;re shown only once.
          </div>
        </form>
      </div>
    </div>
  )
}
