import { useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { apiPost } from '../lib/api'

/**
 * ResetPasswordPage (S605) — landlord portal.
 *
 * Mirrors the tenant page (S289), which was the ONLY portal that could consume
 * a reset token. The API's reset link now points back at whichever portal the
 * request came from, so a landlord lands here instead of on the tenant app.
 *
 * Password rules match the backend: minimum 12 characters, no composition
 * rules (NIST SP 800-63B — length over complexity). The backend re-validates;
 * this is a UX guard so nobody submits a too-short password.
 *
 * On success the backend clears the token (single-use) and does NOT issue a
 * JWT — the landlord signs in fresh, which also means they walk back through
 * the mandatory email 2FA.
 */
/**
 * S630 (Nic): "every single character that I type, it will type one character on
 * that line, and then the cursor gets moved up to the previous line."
 *
 * Shell was declared INSIDE ResetPasswordPage, so every keystroke re-rendered the
 * page, produced a NEW component type, and React unmounted the whole subtree and
 * mounted a fresh one. The inputs were destroyed and recreated on every letter —
 * hence one character landing and the caret jumping back to the first field.
 * Nobody could set a password through this.
 *
 * Declared at module scope it is one stable type for the life of the module, so
 * the inputs are the same DOM nodes across renders and keep their focus.
 */
function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="auth-center">
      <div style={{width:'100%',maxWidth:420}}>
        <div style={{textAlign:'center',marginBottom:40}}>
          <div style={{fontFamily:'var(--font-display)',fontSize:'2rem',fontWeight:800,color:'var(--gold)',marginBottom:8}}>⚡ GAM</div>
          <div style={{color:'var(--text-2)',fontSize:'.875rem'}}>Landlord Portal — Gold Asset Management</div>
        </div>
        <div className="card" style={{padding:28}}>{children}</div>
      </div>
    </div>
  )
}

export function ResetPasswordPage() {
  const [params] = useSearchParams()
  const token = params.get('token') ?? ''

  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [err, setErr] = useState('')
  const [done, setDone] = useState(false)

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setErr('')
    if (password.length < 12) { setErr('Password must be at least 12 characters.'); return }
    if (password !== confirm) { setErr('Passwords do not match.'); return }
    setSubmitting(true)
    try {
      await apiPost('/auth/reset-password', { token, newPassword: password })
      setDone(true)
    } catch (e: any) {
      // 400 here means the token is invalid, expired or already used —
      // distinct from a network failure, so pass the server's wording through.
      const msg = e?.response?.data?.error
      setErr(typeof msg === 'string' ? msg : 'Something went wrong. Please request a new reset link.')
      setSubmitting(false)
    }
  }

  if (!token) {
    return (
      <Shell>
        <h2 style={{marginBottom:12,fontSize:'1.2rem'}}>Invalid reset link</h2>
        <div style={{fontSize:'.85rem',color:'var(--text-2)',lineHeight:1.6,marginBottom:20}}>
          This link is missing its token. Request a new password reset to try again.
        </div>
        <Link to="/forgot-password" className="btn btn-primary w-full" style={{justifyContent:'center',textDecoration:'none'}}>
          Request a new reset link
        </Link>
        <p style={{textAlign:'center',marginTop:20,fontSize:'.82rem',color:'var(--text-3)'}}>
          <Link to="/login">← Back to sign in</Link>
        </p>
      </Shell>
    )
  }

  return (
    <Shell>
      {!done ? (
        <>
          <h2 style={{marginBottom:12,fontSize:'1.2rem'}}>Choose a new password</h2>
          <div style={{fontSize:'.85rem',color:'var(--text-2)',marginBottom:20,lineHeight:1.6}}>
            Pick something you'll remember. Minimum 12 characters — longer is better. You don't need symbols or numbers.
          </div>
          {err && <div className="alert alert-danger" style={{marginBottom:16}}>{err}</div>}
          <form onSubmit={onSubmit}>
            <div className="form-group">
              <label className="form-label">New password</label>
              <input className="form-input" type="password" value={password}
                onChange={e => setPassword(e.target.value)} minLength={12} required autoFocus autoComplete="new-password" />
            </div>
            <div className="form-group">
              <label className="form-label">Confirm new password</label>
              <input className="form-input" type="password" value={confirm}
                onChange={e => setConfirm(e.target.value)} minLength={12} required autoComplete="new-password" />
            </div>
            <button className="btn btn-primary w-full" type="submit" disabled={submitting}
              style={{justifyContent:'center',marginTop:8}}>
              {submitting ? <span className="spinner" /> : 'Set new password'}
            </button>
          </form>
          <p style={{textAlign:'center',marginTop:20,fontSize:'.82rem',color:'var(--text-3)'}}>
            <Link to="/login">← Back to sign in</Link>
          </p>
        </>
      ) : (
        <>
          <h2 style={{marginBottom:12,fontSize:'1.2rem'}}>Password updated</h2>
          <div style={{fontSize:'.85rem',color:'var(--text-2)',lineHeight:1.6,marginBottom:24}}>
            Your password has been changed. Sign in with the new one — you'll get an emailed code to finish.
          </div>
          <Link to="/login" className="btn btn-primary w-full" style={{justifyContent:'center',textDecoration:'none'}}>
            Sign in
          </Link>
        </>
      )}
    </Shell>
  )
}
