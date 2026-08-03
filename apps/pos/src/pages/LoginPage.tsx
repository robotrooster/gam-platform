import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'

export function LoginPage() {
  const { login, loginWithTotp, loginWithEmailOtp, resendEmailOtp } = useAuth()
  const navigate = useNavigate()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [totpSession, setTotpSession] = useState<string | null>(null)
  const [emailOtpSession, setEmailOtpSession] = useState<string | null>(null)
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
          <div style={{marginBottom:14}}>
            <div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:5}}>Email</div>
            <input className="form-input" type="email" placeholder="staff@example.com" value={email}
              onChange={e=>setEmail(e.target.value)} onKeyDown={e=>e.key==='Enter'&&submit()} style={{width:'100%'}} />
          </div>
          <div style={{marginBottom:20}}>
            <div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:5}}>Password</div>
            <input className="form-input" type="password" placeholder="••••••••" value={password}
              onChange={e=>setPassword(e.target.value)} onKeyDown={e=>e.key==='Enter'&&submit()} style={{width:'100%'}} />
          </div>
          <button className="btn btn-primary" style={{width:'100%',padding:'12px 0',fontSize:'1rem'}}
            onClick={submit} disabled={loading||!email||!password}>
            {loading ? 'Signing in…' : 'Sign In'}
          </button>
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
