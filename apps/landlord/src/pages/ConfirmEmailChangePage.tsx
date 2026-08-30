import { useEffect, useRef, useState } from 'react'
import { useSearchParams, Link } from 'react-router-dom'
import { apiPost } from '../lib/api'

// S630: opened from the link sent to the NEW address. Public by design — the
// person proving they hold that mailbox may have no session there, which is the
// whole point of mailing it to them.
export default function ConfirmEmailChangePage() {
  const [params] = useSearchParams()
  const token = params.get('token') || ''
  const [state, setState] = useState<'working' | 'done' | 'error'>('working')
  const [msg, setMsg] = useState('')
  const [email, setEmail] = useState('')
  const fired = useRef(false)

  useEffect(() => {
    if (fired.current) return          // StrictMode double-invoke would burn the one-time token
    fired.current = true
    if (!token) { setState('error'); setMsg('This link is missing its token.'); return }
    apiPost('/auth/change-email/confirm', { token })
      .then((r: any) => { setEmail(r?.data?.email || ''); setState('done') })
      .catch((e: any) => {
        setState('error')
        setMsg(e?.response?.data?.error || 'That link has expired or has already been used.')
      })
  }, [token])

  return (
    <div style={{ minHeight:'100vh', display:'flex', alignItems:'center', justifyContent:'center', padding:24 }}>
      <div className="card" style={{ maxWidth:460, width:'100%', textAlign:'center' }}>
        {state === 'working' && <p style={{ color:'var(--text-3)' }}>Confirming your new sign-in email…</p>}
        {state === 'done' && (<>
          <h2 style={{ marginTop:0 }}>Sign-in email updated</h2>
          <p style={{ color:'var(--text-3)', fontSize:'.85rem' }}>
            From now on, sign in with <strong>{email}</strong>. Your password has not changed.
          </p>
          <Link to="/login" className="btn btn-primary btn-sm" style={{ marginTop:12, display:'inline-block' }}>
            Go to sign in
          </Link>
        </>)}
        {state === 'error' && (<>
          <h2 style={{ marginTop:0 }}>That link didn't work</h2>
          <p style={{ color:'var(--text-3)', fontSize:'.85rem' }}>{msg}</p>
          <p style={{ color:'var(--text-3)', fontSize:'.78rem' }}>
            Your sign-in email is unchanged. Request the change again from Settings.
          </p>
        </>)}
      </div>
    </div>
  )
}
