import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
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
// speaks the portal's own API client — apiPost hands back the whole envelope,
// and the component wants the payload.
const passkeyApi = {
  get:  (url: string) => apiGet(url),
  post: (url: string, body?: any) => apiPost(url, body).then((r: any) => r.data),
  del:  (url: string) => apiDelete(url),
}

export function LoginPage() {
  const { login, loginWithTotp, loginWithEmailOtp, resendEmailOtp, loginWithPasskey } = useAuth()
  const navigate = useNavigate()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [totpSession, setTotpSession] = useState<string | null>(null)
  const [emailOtpSession, setEmailOtpSession] = usePendingOtpSession('gam.otp.pos.login')
  const [resent, setResent] = useState(false)
  const [code, setCode] = useState('')

  const submit = async () => {
    setError('')
    setLoading(true)
    try {
      const r = await login(email, password)
      if (r.kind === 'totp_required') { setTotpSession(r.totpSession); setCode('') }
      else if (r.kind === 'email_otp_required') { setEmailOtpSession(r.emailOtpSession); setCode(''); setResent(false) }
      else navigate('/pos')
    } catch {
      setError('Invalid email or password')
    } finally {
      setLoading(false)
    }
  }

  // S574: mandatory email-code 2FA — verify the emailed code.
  const submitEmailOtp = async () => {
    setError(''); setLoading(true)
    try { await loginWithEmailOtp(emailOtpSession!, code.trim()); navigate('/pos') }
    catch (ex: any) {
      const msg = ex.response?.data?.error || 'Invalid code'
      setError(msg)
      if (/session/i.test(msg)) { setEmailOtpSession(null); setCode('') }
    } finally { setLoading(false) }
  }

  const submitTotp = async () => {
    setError(''); setLoading(true)
    try { await loginWithTotp(totpSession!, code.trim()); navigate('/pos') }
    catch (ex: any) {
      const msg = ex.response?.data?.error || 'Invalid code'
      setError(msg)
      if (/session/i.test(msg)) { setTotpSession(null); setCode('') }
    } finally { setLoading(false) }
  }

  const onResend = async () => {
    setError('')
    try { await resendEmailOtp(emailOtpSession!); setResent(true) }
    catch { setError('Could not resend the code. Please try again.') }
  }

  // ── Step 2 (email 2FA): emailed code ──────────────────────────────
  if (emailOtpSession) {
    return (
      <div style={{minHeight:'100vh',background:'var(--bg-1)',display:'flex',alignItems:'center',justifyContent:'center'}}>
        <div style={{width:'100%',maxWidth:380,padding:24}}>
          <div style={{textAlign:'center',marginBottom:40}}>
            <div style={{fontSize:'2.5rem',marginBottom:8}}>⚡</div>
            <div style={{fontSize:'1.6rem',fontWeight:700,color:'var(--gold)',letterSpacing:'-0.5px'}}>GAM POS</div>
            <div style={{fontSize:'.82rem',color:'var(--text-3)',marginTop:4}}>Two-factor authentication</div>
          </div>
          <div className="card" style={{padding:28}}>
            <div style={{fontWeight:700,fontSize:'1.05rem',marginBottom:8}}>Check your email</div>
            <div style={{fontSize:'.82rem',color:'var(--text-3)',marginBottom:16,lineHeight:1.6}}>
              We sent a 6-digit code to your email. Enter it below to finish signing in.
            </div>
            {error && <div style={{background:'rgba(220,53,69,.08)',border:'1px solid rgba(220,53,69,.2)',borderRadius:8,padding:'10px 14px',fontSize:'.82rem',color:'var(--red)',marginBottom:16}}>{error}</div>}
            {resent && !error && <div style={{background:'rgba(40,167,69,.08)',border:'1px solid rgba(40,167,69,.2)',borderRadius:8,padding:'10px 14px',fontSize:'.82rem',color:'var(--green)',marginBottom:16}}>A new code is on its way.</div>}
            <input className="form-input" type="text" inputMode="numeric" autoComplete="one-time-code" autoFocus
              placeholder="123 456" value={code}
              onChange={e=>setCode(e.target.value)} onKeyDown={e=>e.key==='Enter'&&code.trim()&&submitEmailOtp()}
              style={{width:'100%',textAlign:'center',letterSpacing:'.2em',marginBottom:16}} />
            <button className="btn btn-primary" style={{width:'100%',padding:'12px 0',fontSize:'1rem'}}
              onClick={submitEmailOtp} disabled={loading||!code.trim()}>
              {loading ? 'Verifying…' : 'Verify'}
            </button>
            <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginTop:16,fontSize:'.8rem'}}>
              <button onClick={()=>{setEmailOtpSession(null);setCode('');setError('');setResent(false)}}
                style={{background:'none',border:'none',color:'var(--text-3)',cursor:'pointer',textDecoration:'underline'}}>← Back to sign in</button>
              <button onClick={onResend}
                style={{background:'none',border:'none',color:'var(--gold)',cursor:'pointer',textDecoration:'underline'}}>Resend code</button>
            </div>
          </div>
        </div>
      </div>
    )
  }

  // ── Step 2 (legacy authenticator): TOTP code ──────────────────────
  if (totpSession) {
    return (
      <div style={{minHeight:'100vh',background:'var(--bg-1)',display:'flex',alignItems:'center',justifyContent:'center'}}>
        <div style={{width:'100%',maxWidth:380,padding:24}}>
          <div style={{textAlign:'center',marginBottom:40}}>
            <div style={{fontSize:'2.5rem',marginBottom:8}}>⚡</div>
            <div style={{fontSize:'1.6rem',fontWeight:700,color:'var(--gold)',letterSpacing:'-0.5px'}}>GAM POS</div>
            <div style={{fontSize:'.82rem',color:'var(--text-3)',marginTop:4}}>Two-factor authentication</div>
          </div>
          <div className="card" style={{padding:28}}>
            <div style={{fontWeight:700,fontSize:'1.05rem',marginBottom:8}}>Enter your code</div>
            <div style={{fontSize:'.82rem',color:'var(--text-3)',marginBottom:16,lineHeight:1.6}}>
              Enter the 6-digit code from your authenticator app, or one of your recovery codes.
            </div>
            {error && <div style={{background:'rgba(220,53,69,.08)',border:'1px solid rgba(220,53,69,.2)',borderRadius:8,padding:'10px 14px',fontSize:'.82rem',color:'var(--red)',marginBottom:16}}>{error}</div>}
            <input className="form-input" type="text" autoComplete="one-time-code" autoFocus
              placeholder="123 456 or xxxxx-xxxxx" value={code}
              onChange={e=>setCode(e.target.value)} onKeyDown={e=>e.key==='Enter'&&code.trim()&&submitTotp()}
              style={{width:'100%',textAlign:'center',letterSpacing:'.2em',marginBottom:16}} />
            <button className="btn btn-primary" style={{width:'100%',padding:'12px 0',fontSize:'1rem'}}
              onClick={submitTotp} disabled={loading||!code.trim()}>
              {loading ? 'Verifying…' : 'Verify'}
            </button>
            <div style={{textAlign:'center',marginTop:16,fontSize:'.8rem'}}>
              <button onClick={()=>{setTotpSession(null);setCode('');setError('')}}
                style={{background:'none',border:'none',color:'var(--text-3)',cursor:'pointer',textDecoration:'underline'}}>← Back to sign in</button>
            </div>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div style={{minHeight:'100vh',background:'var(--bg-1)',display:'flex',alignItems:'center',justifyContent:'center'}}>
      <div style={{width:'100%',maxWidth:380,padding:24}}>
        {/* Header */}
        <div style={{textAlign:'center',marginBottom:40}}>
          <div style={{fontSize:'2.5rem',marginBottom:8}}>⚡</div>
          <div style={{fontSize:'1.6rem',fontWeight:700,color:'var(--gold)',letterSpacing:'-0.5px'}}>GAM POS</div>
          <div style={{fontSize:'.82rem',color:'var(--text-3)',marginTop:4}}>Point of Sale Terminal</div>
        </div>

        {/* Form */}
        <div className="card" style={{padding:28}}>
          {error && <div style={{background:'rgba(220,53,69,.08)',border:'1px solid rgba(220,53,69,.2)',borderRadius:8,padding:'10px 14px',fontSize:'.82rem',color:'var(--red)',marginBottom:16}}>{error}</div>}
          {/* 10/30 (Nic): Face ID alone signs you in. Renders nothing on a
              device with no sensor, so the password form below is unchanged for
              everybody else. */}
          <PasskeySignIn api={passkeyApi} onSignedIn={async s => { await loginWithPasskey(s); navigate('/pos') }} />
          {/* 10/31: A REAL <form>, not two inputs and an Enter handler.
              The autofill attributes went on on 10/30, and typing and Enter
              both worked — but iOS and macOS password managers look for a form
              before they will reliably offer to save or fill a password, which
              is the whole reason the attributes went on. Enter is the form's
              own submit now, so the per-input key handlers are gone.
              The code step above is deliberately untouched: its pending
              session has to survive leaving the page (see the file header). */}
          <form onSubmit={e=>{e.preventDefault(); if(!loading&&email&&password) submit()}}>
            <div style={{marginBottom:14}}>
              <div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:5}}>Email</div>
              <input className="form-input" type="email" placeholder="staff@example.com" value={email}
                autoComplete="username webauthn" name="email"
                onChange={e=>setEmail(e.target.value)} style={{width:'100%'}} />
            </div>
            <div style={{marginBottom:20}}>
              <div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:5}}>Password</div>
              <input className="form-input" type="password" placeholder="••••••••" value={password}
                autoComplete="current-password" name="password"
                onChange={e=>setPassword(e.target.value)} style={{width:'100%'}} />
            </div>
            <button className="btn btn-primary" type="submit" style={{width:'100%',padding:'12px 0',fontSize:'1rem'}}
              disabled={loading||!email||!password}>
              {loading ? 'Signing in…' : 'Sign In'}
            </button>
          </form>
          <div style={{textAlign:'center',marginTop:16,fontSize:'.8rem',color:'var(--text-3)'}}>
            New here? <Link to="/signup" style={{color:'var(--gold)'}}>Create an account</Link>
          </div>
        </div>

        <div style={{textAlign:'center',marginTop:20,fontSize:'.75rem',color:'var(--text-3)'}}>
          Gold Asset Management · POS Terminal v1.0
        </div>
      </div>
    </div>
  )
}
