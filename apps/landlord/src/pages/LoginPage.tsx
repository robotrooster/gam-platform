import { useState } from 'react'
import { useNavigate, useLocation, useSearchParams, Link, type NavigateFunction } from 'react-router-dom'
import { useForm } from 'react-hook-form'
import { useAuth } from '../context/AuthContext'

// ── 10/13 (Nic): A NEW TEAM MEMBER'S CODE STEP, AND THE WAY BACK ─────────────
//
// "It told her to sign in and then something about it not going anywhere."
// A bookkeeper who had just created her account from the owner's invitation was
// told to go sign in elsewhere with the password she had typed seconds before.
// The invitation page now hands her straight to the code step here (the
// account's pending pass, from the accept) and the code takes her to her
// pages. An existing account asked to sign in to accept comes back to the
// invitation (?next=), not to a dashboard with the invitation dropped.
const PENDING_CODE_KEY = 'gam.otp.landlord.login'

/** What the invitation page hands over (router state): who just set up an account, and its pending pass. */
export interface JoinedHandoff {
  joined: { email: string; otpSent?: boolean }
  emailOtpSession?: string
}

/**
 * 10/13: from the invitation page to this page's code step. The pending pass is
 * kept in sessionStorage (S639: a phone reloads the page while its owner reads
 * the code in the mail app) and in the router state for a browser that refuses
 * storage. Replaces the invitation in history, so Back does not reopen a used
 * form. With no pass (the code step could not start), the sign-in form shows
 * with the same "your account is set up" line.
 */
export function continueToSignIn(navigate: NavigateFunction, handoff: JoinedHandoff): void {
  try {
    if (handoff.emailOtpSession) sessionStorage.setItem(PENDING_CODE_KEY, handoff.emailOtpSession)
  } catch { /* private mode — the router state below carries it */ }
  navigate('/login', { replace: true, state: handoff })
}

/**
 * 10/13: where to go after signing in, when the page that sent someone here
 * asked (?next=). Only a path inside this portal — never another site, never
 * back to this page.
 */
export function safeNextPath(raw: string | null | undefined): string | null {
  if (!raw || !raw.startsWith('/') || raw.startsWith('//') || raw.includes('\\')) return null
  if (raw === '/login' || raw.startsWith('/login?')) return null
  return raw
}

// ── S639: THE CODE STEP MUST SURVIVE LEAVING THE PAGE ────────────────────────
//
// Nic: "on mobile browser, as soon as they leave the page to check the email to
// get the two factor authentication code, it signs them out or it takes them
// back to the sign in page."
//
// Right, and it is not a sign-out — nothing was ever signed in. The pending OTP
// session lived in React state only. Switching to the mail app to read the code
// lets a phone browser discard and reload the page, and the component came back
// with a fresh empty state: the email/password form again, with the code they
// are now holding useless. Every tenant hits this, because email 2FA is on for
// every login.
//
// sessionStorage survives that reload, so they return to the code box they left.
// It holds the short-lived PRE-auth OTP session, never a real session token —
// and that is worthless without the code from their inbox, the same trust level
// as the page holding it in memory. Cleared as soon as the code is accepted or
// the step is abandoned.
function usePendingOtpSession(key: string, handedOver?: string | null): [string | null, (v: string | null) => void] {
  const [v, setV] = useState<string | null>(() => {
    try { return sessionStorage.getItem(key) ?? handedOver ?? null } catch { return handedOver ?? null }
  })
  const set = (next: string | null) => {
    setV(next)
    try {
      if (next) sessionStorage.setItem(key, next)
      else sessionStorage.removeItem(key)
    } catch { /* private mode — behaves exactly as before */ }
  }
  return [v, set]
}


export function LoginPage() {
  const { login, loginWithTotp, loginWithEmailOtp, resendEmailOtp } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const [searchParams] = useSearchParams()
  // 10/13: an invitation page that sent someone here to sign in gets them back.
  const next = safeNextPath(searchParams.get('next'))
  const signedInGoTo = () => navigate(next ?? '/', { replace: true })
  // 10/13: a team member who just set up their account (the invitation page).
  const handoff = (location.state ?? null) as JoinedHandoff | null
  const joined = handoff?.joined ?? null
  const [err, setErr] = useState('')
  const [loading, setLoading] = useState(false)
  const [totpSession, setTotpSession] = useState<string | null>(null)
  const [emailOtpSession, setPendingCode] = usePendingOtpSession(PENDING_CODE_KEY, handoff?.emailOtpSession)
  // 10/13: a handed-over pass that is spent or abandoned must not come back
  // from the router state on a reload.
  const setEmailOtpSession = (v: string | null) => {
    setPendingCode(v)
    if (!v && handoff?.emailOtpSession) {
      navigate(`${location.pathname}${location.search}`, { replace: true, state: joined ? { joined } : null })
    }
  }
  const codeFromInvite = !!joined && !!handoff?.emailOtpSession && emailOtpSession === handoff.emailOtpSession
  const [resent, setResent] = useState(false)
  // 10/13: the account was set up but no code could be issued (otpSent: false
  // — nothing stored, nothing mailed), until Resend issues one. Not "we sent".
  const codeNotIssued = codeFromInvite && joined!.otpSent === false && !resent
  const [code, setCode] = useState('')
  const { register, handleSubmit } = useForm<{email:string;password:string}>({ defaultValues: { email: joined?.email ?? '' } })

  const onSubmit = async (d: {email:string;password:string}) => {
    setLoading(true); setErr('')
    try {
      const r = await login(d.email, d.password)
      if (r.kind === 'totp_required') { setTotpSession(r.totpSession); setCode('') }
      else if (r.kind === 'email_otp_required') { setEmailOtpSession(r.emailOtpSession); setCode(''); setResent(false) }
      else signedInGoTo()
    }
    catch (e: any) {
      // S605: distinguish "the server said no" from "we never reached the
      // server". Both used to read 'Login failed', which told the user nothing
      // and — combined with the old 401 interceptor reloading the page — made a
      // wrong password look identical to a broken app.
      setErr(
        e.response?.data?.error
        || (e.response
              ? 'Login failed. Please try again.'
              : "Couldn't reach the server. Check your connection, then reload this page and try again.")
      )
    }
    finally { setLoading(false) }
  }

  const onTotpSubmit = async (e: React.FormEvent) => {
    e.preventDefault(); setLoading(true); setErr('')
    try { await loginWithTotp(totpSession!, code.trim()); signedInGoTo() }
    catch (ex: any) {
      const msg = ex.response?.data?.error || 'Invalid code.'
      setErr(msg)
      // Expired session — drop back to the credentials step.
      if (/session/i.test(msg)) { setTotpSession(null); setCode('') }
    }
    finally { setLoading(false) }
  }

  // S574: email-code 2FA (mandatory for landlords). Verify the emailed code.
  const onEmailOtpSubmit = async (e: React.FormEvent) => {
    e.preventDefault(); setLoading(true); setErr('')
    try { await loginWithEmailOtp(emailOtpSession!, code.trim()); setPendingCode(null); signedInGoTo() }
    catch (ex: any) {
      const msg = ex.response?.data?.error || 'Invalid code.'
      setErr(msg)
      if (/session/i.test(msg)) { setEmailOtpSession(null); setCode('') }
    }
    finally { setLoading(false) }
  }

  const onResend = async () => {
    setErr('')
    try { await resendEmailOtp(emailOtpSession!); setResent(true) }
    catch { setErr('Could not resend the code. Please try again.') }
  }

  // ── Step 2 (email 2FA): emailed code ─────────────────────────────
  if (emailOtpSession) {
    return (
      <div className="auth-center">
        <div style={{width:'100%',maxWidth:420}}>
          <div style={{textAlign:'center',marginBottom:40}}>
            <div style={{fontFamily:'var(--font-display)',fontSize:'2rem',fontWeight:800,color:'var(--gold)',marginBottom:8}}>⚡ GAM</div>
            <div style={{color:'var(--text-2)',fontSize:'.875rem'}}>Two-factor authentication</div>
          </div>
          <div className="card" style={{padding:28}}>
            <h2 style={{marginBottom:16,fontSize:'1.2rem'}}>Check Your Email</h2>
            {/* 10/13: straight from setting up an account on an invitation (its own pass, not a later sign-in). */}
            {codeFromInvite && (codeNotIssued
              ? <div className="alert alert-danger" style={{marginBottom:16}}>Your account is set up, but we couldn't send your sign-in code. Tap Resend code below.</div>
              : <div className="alert alert-success" style={{marginBottom:16}}>Your account is set up. One last step to sign in.</div>)}
            <div style={{fontSize:'.85rem',color:'var(--text-2)',marginBottom:16,lineHeight:1.6}}>
              {codeNotIssued
                ? <>Tap Resend code to get a 6-digit code at <strong style={{color:'var(--text-1)'}}>{joined!.email}</strong>, then enter it below.</>
                : <>We sent a 6-digit code to {codeFromInvite ? <strong style={{color:'var(--text-1)'}}>{joined!.email}</strong> : 'your email'}. Enter it below to finish signing in.</>}
            </div>
            {err && <div className="alert alert-danger" style={{marginBottom:16}}>{err}</div>}
            {resent && !err && <div className="alert alert-success" style={{marginBottom:16}}>A new code is on its way.</div>}
            <form onSubmit={onEmailOtpSubmit}>
              <div className="form-group">
                <label className="form-label">Code</label>
                <input
                  className="form-input"
                  type="text"
                  value={code}
                  onChange={e => setCode(e.target.value)}
                  autoFocus
                  required
                  autoComplete="one-time-code"
                  inputMode="numeric"
                  placeholder="123 456"
                  style={{textAlign:'center',letterSpacing:'.2em',fontFamily:'var(--font-mono)'}}
                />
              </div>
              <button className="btn btn-primary w-full" type="submit" disabled={loading || !code.trim()} style={{justifyContent:'center',marginTop:8}}>
                {loading ? <span className="spinner" /> : 'Verify'}
              </button>
            </form>
            <div style={{marginTop:20,display:'flex',justifyContent:'space-between',alignItems:'center'}}>
              <button
                onClick={() => { setEmailOtpSession(null); setCode(''); setErr(''); setResent(false) }}
                style={{background:'none',border:'none',color:'var(--text-2)',fontSize:'.82rem',cursor:'pointer',textDecoration:'underline'}}
              >
                ← Back to sign in
              </button>
              <button
                onClick={onResend}
                style={{background:'none',border:'none',color:'var(--gold)',fontSize:'.82rem',cursor:'pointer',textDecoration:'underline'}}
              >
                Resend code
              </button>
            </div>
          </div>
        </div>
      </div>
    )
  }

  // ── Step 2: TOTP code ────────────────────────────────────────────
  if (totpSession) {
    return (
      <div className="auth-center">
        <div style={{width:'100%',maxWidth:420}}>
          <div style={{textAlign:'center',marginBottom:40}}>
            <div style={{fontFamily:'var(--font-display)',fontSize:'2rem',fontWeight:800,color:'var(--gold)',marginBottom:8}}>⚡ GAM</div>
            <div style={{color:'var(--text-2)',fontSize:'.875rem'}}>Two-factor authentication</div>
          </div>
          <div className="card" style={{padding:28}}>
            <h2 style={{marginBottom:16,fontSize:'1.2rem'}}>Enter Your Code</h2>
            <div style={{fontSize:'.85rem',color:'var(--text-2)',marginBottom:16,lineHeight:1.6}}>
              Enter the 6-digit code from your authenticator app, or one of your recovery codes.
            </div>
            {err && <div className="alert alert-danger" style={{marginBottom:16}}>{err}</div>}
            <form onSubmit={onTotpSubmit}>
              <div className="form-group">
                <label className="form-label">Code</label>
                <input
                  className="form-input"
                  type="text"
                  value={code}
                  onChange={e => setCode(e.target.value)}
                  autoFocus
                  required
                  autoComplete="one-time-code"
                  inputMode="text"
                  placeholder="123 456 or xxxxx-xxxxx"
                  style={{textAlign:'center',letterSpacing:'.2em',fontFamily:'var(--font-mono)'}}
                />
              </div>
              <button className="btn btn-primary w-full" type="submit" disabled={loading || !code.trim()} style={{justifyContent:'center',marginTop:8}}>
                {loading ? <span className="spinner" /> : 'Verify'}
              </button>
            </form>
            <p style={{textAlign:'center',marginTop:20,fontSize:'.82rem'}}>
              <button
                onClick={() => { setTotpSession(null); setCode(''); setErr('') }}
                style={{background:'none',border:'none',color:'var(--text-2)',fontSize:'.82rem',cursor:'pointer',textDecoration:'underline'}}
              >
                ← Back to sign in
              </button>
            </p>
          </div>
        </div>
      </div>
    )
  }

  // ── Step 1: credentials ──────────────────────────────────────────
  return (
    <div className="auth-center">
      <div style={{width:'100%',maxWidth:420}}>
        <div style={{textAlign:'center',marginBottom:40}}>
          <div style={{fontFamily:'var(--font-display)',fontSize:'2rem',fontWeight:800,color:'var(--gold)',marginBottom:8}}>⚡ GAM</div>
          <div style={{color:'var(--text-2)',fontSize:'.875rem'}}>Landlord Portal — Gold Asset Management</div>
        </div>
        <div className="card" style={{padding:28}}>
          <h2 style={{marginBottom:24,fontSize:'1.2rem'}}>Sign In</h2>
          {/* 10/13: an account set up on an invitation whose code step could not start. */}
          {joined && !err && <div className="alert alert-success" style={{marginBottom:16}}>Your account is set up. Sign in with {joined.email} and the password you just chose.</div>}
          {err && <div className="alert alert-danger" style={{marginBottom:16}}>{err}</div>}
          <form onSubmit={handleSubmit(onSubmit)}>
            <div className="form-group">
              <label className="form-label">Email</label>
              <input className="form-input" type="email" {...register('email',{required:true})} placeholder="you@example.com" autoFocus />
            </div>
            <div className="form-group">
              <label className="form-label">Password</label>
              <input className="form-input" type="password" {...register('password',{required:true})} placeholder="••••••••" />
            </div>
            <button className="btn btn-primary w-full" type="submit" disabled={loading} style={{justifyContent:'center',marginTop:8}}>
              {loading ? <span className="spinner" /> : 'Sign in'}
            </button>
          </form>
          {/* S605: there was no way to recover a forgotten password from this
              page, so a landlord who mistyped the password they set at signup
              was locked out for good. */}
          <p style={{textAlign:'center',marginTop:16,fontSize:'.82rem'}}>
            <Link to="/forgot-password" style={{color:'var(--text-2)'}}>Forgot your password?</Link>
          </p>
          <p style={{textAlign:'center',marginTop:12,fontSize:'.82rem',color:'var(--text-3)'}}>
            No account? <Link to="/register">Register as landlord</Link>
          </p>
        </div>
      </div>
    </div>
  )
}
