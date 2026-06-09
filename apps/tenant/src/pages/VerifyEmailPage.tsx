import { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { apiPost } from '../lib/api'

/**
 * VerifyEmailPage (S289).
 *
 * Lands here from the verification link mailed at registration. Token
 * comes via `?token=...` (set by sendEmailVerification). On mount we
 * POST it to /api/auth/verify-email; backend marks email_verified=TRUE,
 * stamps email_verified_at, clears the token (single-use).
 *
 * Three states:
 *   - verifying  — initial submission in flight
 *   - success    — token consumed, account verified
 *   - error      — invalid / already-used / expired token
 *
 * Resend recovery lives at /login (refusing to log in an unverified
 * account auto-fires a fresh verification email — S281).
 */
type Status = 'verifying' | 'success' | 'error'

export function VerifyEmailPage() {
  const [params] = useSearchParams()
  const token = params.get('token') ?? ''
  const [status, setStatus] = useState<Status>('verifying')
  const [errMsg, setErrMsg] = useState('')

  useEffect(() => {
    if (!token) {
      setStatus('error')
      setErrMsg('This verification link is missing its token.')
      return
    }
    let cancelled = false
    apiPost('/auth/verify-email', { token })
      .then(() => { if (!cancelled) setStatus('success') })
      .catch((e: any) => {
        if (cancelled) return
        setStatus('error')
        const msg = e?.response?.data?.error
        setErrMsg(typeof msg === 'string'
          ? msg
          : 'Verification failed. The link may have expired or already been used.')
      })
    return () => { cancelled = true }
  }, [token])

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg0)', padding: 20 }}>
      <div style={{ width: '100%', maxWidth: 420 }}>
        <div style={{ textAlign: 'center', marginBottom: 32 }}>
          <div style={{ fontFamily: 'var(--font-d)', fontSize: '2rem', fontWeight: 800, color: 'var(--gold)', marginBottom: 8 }}>⚡ GAM</div>
          <div style={{ color: 'var(--t2)', fontSize: '.875rem' }}>Email verification</div>
        </div>

        <div className="card" style={{ padding: 28, textAlign: 'center' }}>
          {status === 'verifying' && (
            <>
              <div style={{ display: 'inline-block', width: 32, height: 32, border: '3px solid var(--bg2)', borderTopColor: 'var(--gold)', borderRadius: '50%', animation: 'spin 1s linear infinite', marginBottom: 16 }} />
              <h2 style={{ marginBottom: 8 }}>Verifying your email…</h2>
              <p style={{ color: 'var(--t2)', fontSize: '.85rem' }}>One moment.</p>
            </>
          )}

          {status === 'success' && (
            <>
              <div style={{ fontSize: 36, marginBottom: 12 }}>✅</div>
              <h2 style={{ marginBottom: 12 }}>Email verified</h2>
              <p style={{ color: 'var(--t2)', fontSize: '.85rem', lineHeight: 1.6, marginBottom: 24 }}>
                Your email is confirmed. You can now sign in to your GAM account.
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

          {status === 'error' && (
            <>
              <div style={{ fontSize: 36, marginBottom: 12 }}>⚠️</div>
              <h2 style={{ marginBottom: 12 }}>Verification link invalid</h2>
              <p style={{ color: 'var(--t2)', fontSize: '.85rem', lineHeight: 1.6, marginBottom: 16 }}>
                {errMsg}
              </p>
              <p style={{ color: 'var(--t2)', fontSize: '.8rem', lineHeight: 1.6, marginBottom: 24 }}>
                Try signing in — if your email still needs verification, we'll send a fresh link automatically.
              </p>
              <Link
                to="/login"
                className="btn btn-p"
                style={{ width: '100%', justifyContent: 'center', textDecoration: 'none' }}
              >
                Go to sign in
              </Link>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
