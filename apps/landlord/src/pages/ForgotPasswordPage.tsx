import { useState } from 'react'
import { Link } from 'react-router-dom'
import { apiPost } from '../lib/api'

/**
 * ForgotPasswordPage (S605).
 *
 * The landlord portal had NO password recovery at all — no link, no page, no
 * route — while the API endpoint had existed since S289. A landlord who forgot
 * the password they set at signup was permanently locked out, and the only way
 * back in was a manual DB edit. That is how Nic lost access to the real Oak
 * Park account, and plausibly how our first organic signup was lost too.
 *
 * The response is deliberately identical whether or not the email exists —
 * the backend already refuses to enumerate accounts, and saying "no account
 * found" here would hand that back.
 */
export function ForgotPasswordPage() {
  const [email, setEmail] = useState('')
  const [sent, setSent] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [err, setErr] = useState('')

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setSubmitting(true); setErr('')
    try {
      await apiPost('/auth/forgot-password', { email: email.trim() })
      setSent(true)
    } catch {
      // Network/5xx only — the endpoint returns 200 for unknown emails.
      setErr('Could not send the reset email right now. Please try again in a moment.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div style={{minHeight:'100vh',display:'flex',alignItems:'center',justifyContent:'center',background:'var(--bg-0)',padding:20}}>
      <div style={{width:'100%',maxWidth:420}}>
        <div style={{textAlign:'center',marginBottom:40}}>
          <div style={{fontFamily:'var(--font-display)',fontSize:'2rem',fontWeight:800,color:'var(--gold)',marginBottom:8}}>⚡ GAM</div>
          <div style={{color:'var(--text-2)',fontSize:'.875rem'}}>Landlord Portal — Gold Asset Management</div>
        </div>
        <div className="card" style={{padding:28}}>
          {!sent ? (
            <>
              <h2 style={{marginBottom:12,fontSize:'1.2rem'}}>Reset your password</h2>
              <div style={{fontSize:'.85rem',color:'var(--text-2)',marginBottom:20,lineHeight:1.6}}>
                Enter the email you signed up with and we'll send you a link to set a new password.
              </div>
              {err && <div className="alert alert-danger" style={{marginBottom:16}}>{err}</div>}
              <form onSubmit={onSubmit}>
                <div className="form-group">
                  <label className="form-label">Email</label>
                  <input className="form-input" type="email" value={email}
                    onChange={e => setEmail(e.target.value)}
                    placeholder="you@example.com" autoFocus required autoComplete="email" />
                </div>
                <button className="btn btn-primary w-full" type="submit"
                  disabled={submitting || !email.trim()} style={{justifyContent:'center',marginTop:8}}>
                  {submitting ? <span className="spinner" /> : 'Send reset link'}
                </button>
              </form>
            </>
          ) : (
            <>
              <h2 style={{marginBottom:12,fontSize:'1.2rem'}}>Check your email</h2>
              <div style={{fontSize:'.85rem',color:'var(--text-2)',lineHeight:1.6}}>
                If an account exists for <strong style={{color:'var(--text-0)'}}>{email.trim()}</strong>,
                a reset link is on its way. The link is single-use and expires shortly, so use it soon.
              </div>
            </>
          )}
          <p style={{textAlign:'center',marginTop:20,fontSize:'.82rem',color:'var(--text-3)'}}>
            <Link to="/login">← Back to sign in</Link>
          </p>
        </div>
      </div>
    </div>
  )
}
