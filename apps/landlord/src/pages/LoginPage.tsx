import { useState } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { useForm } from 'react-hook-form'
import { useAuth } from '../context/AuthContext'

export function LoginPage() {
  const { login, loginWithTotp, loginWithEmailOtp, resendEmailOtp } = useAuth()
  const navigate = useNavigate()
  const [err, setErr] = useState('')
  const [loading, setLoading] = useState(false)
  const [totpSession, setTotpSession] = useState<string | null>(null)
  const [emailOtpSession, setEmailOtpSession] = useState<string | null>(null)
  const [resent, setResent] = useState(false)
  const [code, setCode] = useState('')
  const { register, handleSubmit } = useForm<{email:string;password:string}>()

  const onSubmit = async (d: {email:string;password:string}) => {
    setLoading(true); setErr('')
    try {
      const r = await login(d.email, d.password)
      if (r.kind === 'totp_required') { setTotpSession(r.totpSession); setCode('') }
      else if (r.kind === 'email_otp_required') { setEmailOtpSession(r.emailOtpSession); setCode(''); setResent(false) }
      else navigate('/')
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
    try { await loginWithTotp(totpSession!, code.trim()); navigate('/') }
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
    try { await loginWithEmailOtp(emailOtpSession!, code.trim()); navigate('/') }
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
      <div style={{minHeight:'100vh',display:'flex',alignItems:'center',justifyContent:'center',background:'var(--bg-0)',padding:20}}>
        <div style={{width:'100%',maxWidth:420}}>
          <div style={{textAlign:'center',marginBottom:40}}>
            <div style={{fontFamily:'var(--font-display)',fontSize:'2rem',fontWeight:800,color:'var(--gold)',marginBottom:8}}>⚡ GAM</div>
            <div style={{color:'var(--text-2)',fontSize:'.875rem'}}>Two-factor authentication</div>
          </div>
          <div className="card" style={{padding:28}}>
            <h2 style={{marginBottom:16,fontSize:'1.2rem'}}>Check Your Email</h2>
            <div style={{fontSize:'.85rem',color:'var(--text-2)',marginBottom:16,lineHeight:1.6}}>
              We sent a 6-digit code to your email. Enter it below to finish signing in.
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
      <div style={{minHeight:'100vh',display:'flex',alignItems:'center',justifyContent:'center',background:'var(--bg-0)',padding:20}}>
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
    <div style={{minHeight:'100vh',display:'flex',alignItems:'center',justifyContent:'center',background:'var(--bg-0)',padding:20}}>
      <div style={{width:'100%',maxWidth:420}}>
        <div style={{textAlign:'center',marginBottom:40}}>
          <div style={{fontFamily:'var(--font-display)',fontSize:'2rem',fontWeight:800,color:'var(--gold)',marginBottom:8}}>⚡ GAM</div>
          <div style={{color:'var(--text-2)',fontSize:'.875rem'}}>Landlord Portal — Gold Asset Management</div>
        </div>
        <div className="card" style={{padding:28}}>
          <h2 style={{marginBottom:24,fontSize:'1.2rem'}}>Sign In</h2>
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
