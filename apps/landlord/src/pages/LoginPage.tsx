import { useState } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { useForm } from 'react-hook-form'
import { useAuth } from '../context/AuthContext'

export function LoginPage() {
  const { login, loginWithTotp } = useAuth()
  const navigate = useNavigate()
  const [err, setErr] = useState('')
  const [loading, setLoading] = useState(false)
  const [totpSession, setTotpSession] = useState<string | null>(null)
  const [code, setCode] = useState('')
  const { register, handleSubmit } = useForm<{email:string;password:string}>()

  const onSubmit = async (d: {email:string;password:string}) => {
    setLoading(true); setErr('')
    try {
      const r = await login(d.email, d.password)
      if (r.kind === 'totp_required') { setTotpSession(r.totpSession); setCode('') }
      else navigate('/')
    }
    catch (e: any) { setErr(e.response?.data?.error || 'Login failed') }
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
            <h2 style={{marginBottom:16,fontSize:'1.2rem'}}>Enter your code</h2>
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
          <h2 style={{marginBottom:24,fontSize:'1.2rem'}}>Sign in</h2>
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
          <p style={{textAlign:'center',marginTop:20,fontSize:'.82rem',color:'var(--text-3)'}}>
            No account? <Link to="/register">Register as landlord</Link>
          </p>
        </div>
      </div>
    </div>
  )
}
