import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../lib/api'
import { useAuth } from '../context/AuthContext'

// Optional-with-prompts 2FA enrollment for the landlord portal. Unlike
// the admin portal this is NOT a mandatory gate — the landlord reaches
// this from Settings → Security and is returned there on success.
//
// Backend contract (all responses {success, data}):
//   POST /auth/totp/enroll-start   → {otpauthUrl, qrDataUri, recoveryCodes[]}
//   POST /auth/totp/enroll-confirm {token:"<6-digit>"} → {message}
export function TotpEnrollPage() {
  const { refresh } = useAuth()
  const navigate = useNavigate()
  const [state, setState] = useState<'loading'|'showCodes'|'done'|'error'>('loading')
  const [err, setErr] = useState('')
  const [qrDataUri, setQrDataUri] = useState('')
  const [otpauthUrl, setOtpauthUrl] = useState('')
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([])
  const [code, setCode] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [savedAck, setSavedAck] = useState(false)

  useEffect(() => {
    let cancelled = false
    api.post('/auth/totp/enroll-start')
      .then(r => {
        if (cancelled) return
        const d = r.data.data
        setQrDataUri(d.qrDataUri); setOtpauthUrl(d.otpauthUrl)
        setRecoveryCodes(d.recoveryCodes || [])
        setState('showCodes')
      })
      .catch((e: any) => {
        if (cancelled) return
        // 409 if already enrolled — nothing to do, bounce to settings.
        if (e.response?.status === 409) { navigate('/settings', { replace: true }); return }
        setErr(e.response?.data?.error || 'Could not start enrollment.')
        setState('error')
      })
    return () => { cancelled = true }
  }, [navigate])

  const onConfirm = async (e: React.FormEvent) => {
    e.preventDefault(); setSubmitting(true); setErr('')
    try {
      await api.post('/auth/totp/enroll-confirm', { token: code.trim() })
      await refresh()
      setState('done')
      setTimeout(() => navigate('/settings', { replace: true }), 800)
    } catch (ex: any) {
      setErr(ex.response?.data?.error || 'Verification failed. Try the current code from your app.')
      setSubmitting(false)
    }
  }

  if (state === 'loading') {
    return (
      <div style={{minHeight:'60vh',display:'flex',alignItems:'center',justifyContent:'center'}}>
        <span className="spinner" />
      </div>
    )
  }

  if (state === 'error') {
    return (
      <div style={{display:'flex',justifyContent:'center',padding:'40px 20px'}}>
        <div className="card" style={{padding:28,maxWidth:440,textAlign:'center'}}>
          <div style={{fontSize:36,marginBottom:12}}>⚠️</div>
          <h2 style={{marginBottom:12}}>Couldn't start enrollment</h2>
          <p style={{color:'var(--text-2)',fontSize:'.85rem',lineHeight:1.6,marginBottom:16}}>{err}</p>
          <button onClick={() => navigate('/settings')} className="btn btn-primary w-full" style={{justifyContent:'center'}}>Back to Settings</button>
        </div>
      </div>
    )
  }

  if (state === 'done') {
    return (
      <div style={{display:'flex',justifyContent:'center',padding:'40px 20px'}}>
        <div className="card" style={{padding:28,maxWidth:440,textAlign:'center'}}>
          <div style={{fontSize:36,marginBottom:12}}>✅</div>
          <h2 style={{marginBottom:12}}>Two-factor authentication enabled</h2>
          <p style={{color:'var(--text-2)',fontSize:'.85rem',lineHeight:1.6}}>Returning to Settings…</p>
        </div>
      </div>
    )
  }

  // Main enrollment screen
  return (
    <div style={{display:'flex',justifyContent:'center',padding:'8px 0 40px'}}>
      <div style={{width:'100%',maxWidth:580}}>
        <div className="page-header">
          <div>
            <h1 className="page-title">Set up two-factor authentication</h1>
            <p className="page-subtitle">Add an authenticator-app code to every sign-in</p>
          </div>
        </div>

        <div className="card" style={{padding:24}}>
          <div style={{fontSize:'.85rem',color:'var(--text-1)',marginBottom:18,lineHeight:1.6}}>
            Two-factor authentication adds a second step to sign-in — a 6-digit code from an
            authenticator app — so a stolen password isn't enough to access your account.
          </div>

          <div style={{display:'grid',gridTemplateColumns:'auto 1fr',gap:16,alignItems:'start',marginBottom:18}}>
            <div style={{padding:10,background:'#fff',borderRadius:8,lineHeight:0}}>
              <img src={qrDataUri} alt="Scan this QR code with your authenticator app" style={{display:'block',width:180,height:180}} />
            </div>
            <div style={{fontSize:'.85rem',color:'var(--text-1)',lineHeight:1.6}}>
              <div style={{fontWeight:700,color:'var(--text-0)',marginBottom:6}}>1. Scan with your authenticator app</div>
              <div style={{color:'var(--text-2)',fontSize:'.8rem',marginBottom:10}}>Google Authenticator, Authy, 1Password, Bitwarden — any TOTP app works. Open the app, tap "Add account" or the + icon, then scan the QR code on the left.</div>
              <div style={{fontSize:'.74rem',color:'var(--text-3)'}}>Can't scan? <a href={otpauthUrl} style={{color:'var(--gold)',wordBreak:'break-all'}}>Tap to add manually →</a></div>
            </div>
          </div>

          <div style={{marginBottom:18,padding:14,background:'var(--amber-bg)',border:'1px solid rgba(245,158,11,.2)',borderRadius:8}}>
            <div style={{fontWeight:700,color:'var(--amber)',marginBottom:8,fontSize:'.88rem'}}>2. Save these recovery codes</div>
            <div style={{fontSize:'.8rem',color:'var(--text-2)',marginBottom:10,lineHeight:1.5}}>
              If you ever lose access to your authenticator app, these one-time codes are the only way to get back in. Store them somewhere safe — a password manager works well.
            </div>
            <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:6,marginBottom:10}}>
              {recoveryCodes.map(rc => (
                <div key={rc} className="mono" style={{fontSize:'.85rem',color:'var(--text-0)',background:'var(--bg-3)',padding:'5px 9px',borderRadius:5,letterSpacing:'.05em'}}>{rc}</div>
              ))}
            </div>
            <label style={{display:'flex',alignItems:'center',gap:8,fontSize:'.8rem',color:'var(--text-1)',cursor:'pointer'}}>
              <input type="checkbox" checked={savedAck} onChange={e => setSavedAck(e.target.checked)} />
              I've saved my recovery codes somewhere safe.
            </label>
          </div>

          <form onSubmit={onConfirm}>
            <div className="form-group">
              <label className="form-label">3. Enter the 6-digit code from your app to confirm</label>
              <input
                className="form-input"
                type="text"
                value={code}
                onChange={e => setCode(e.target.value)}
                required
                inputMode="numeric"
                pattern="[0-9 ]*"
                autoComplete="one-time-code"
                placeholder="000000"
                maxLength={7}
                style={{textAlign:'center',letterSpacing:'.2em',fontFamily:'var(--font-mono)',fontSize:'1rem'}}
              />
            </div>
            {err && <div className="alert alert-danger" style={{marginBottom:12}}>{err}</div>}
            <div style={{display:'flex',gap:8}}>
              <button className="btn btn-primary" type="submit" disabled={submitting || !savedAck || code.trim().length < 6} style={{flex:1,justifyContent:'center'}}>
                {submitting ? <span className="spinner" /> : 'Enable two-factor'}
              </button>
              <button type="button" className="btn btn-secondary" onClick={() => navigate('/settings')} disabled={submitting}>
                Cancel
              </button>
            </div>
            <div style={{marginTop:10,fontSize:'.74rem',color:'var(--text-3)',textAlign:'center'}}>
              Confirm the codes are saved before continuing — they're shown only once.
            </div>
          </form>
        </div>
      </div>
    </div>
  )
}
