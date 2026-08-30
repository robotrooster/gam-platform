import { useState } from 'react'
import { useMutation } from 'react-query'
import { AtSign } from 'lucide-react'
import { apiPost, apiDelete } from '../lib/api'

// S630 (Nic): "We're gonna be selling Oak Park and potentially giving up
// control of that email address to the new buyer, and I need my sign in to be
// something that stays with me."
//
// The account keeps working on the current email throughout — the swap happens
// only when the link sent to the new address is opened.

export function ChangeSignInEmail(
  { currentEmail, pendingEmail, onChanged }:
  { currentEmail: string; pendingEmail?: string | null; onChanged: () => void },
) {
  const [open, setOpen] = useState(false)
  const [newEmail, setNewEmail] = useState('')
  const [password, setPassword] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [sentTo, setSentTo] = useState<string | null>(null)

  const start = useMutation(
    () => apiPost('/auth/change-email', { newEmail: newEmail.trim(), password }),
    {
      onSuccess: (r: any) => {
        setErr(null); setSentTo(r?.data?.pendingEmail || newEmail.trim())
        setPassword(''); setNewEmail(''); setOpen(false); onChanged()
      },
      onError: (e: any) => setErr(e?.response?.data?.error || 'Could not start the change'),
    },
  )
  const cancel = useMutation(() => apiDelete('/auth/change-email'), {
    onSuccess: () => { setSentTo(null); onChanged() },
  })

  const waiting = sentTo || pendingEmail

  return (
    <div style={{ marginTop: 14, paddingTop: 14, borderTop: '1px solid var(--border-0)' }}>
      <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:4 }}>
        <AtSign size={14} />
        <strong style={{ fontSize:'.82rem' }}>Sign-in email</strong>
      </div>
      <p style={{ fontSize:'.78rem', color:'var(--text-3)', margin:'0 0 10px', maxWidth:560 }}>
        You sign in with <strong>{currentEmail}</strong>. This is also the address that can reset
        your password, so keep it one you'll always control — not an address tied to a property
        you might sell.
      </p>

      {waiting ? (
        <div style={{ fontSize:'.78rem', color:'var(--text-3)' }}>
          Waiting on confirmation from <strong>{waiting}</strong>. You keep signing in
          with {currentEmail} until that link is opened.
          <div style={{ marginTop:8 }}>
            <button className="btn btn-ghost btn-sm" onClick={() => cancel.mutate()}
              disabled={cancel.isLoading}>Cancel the change</button>
          </div>
        </div>
      ) : !open ? (
        <button className="btn btn-ghost btn-sm" onClick={() => { setOpen(true); setErr(null) }}>
          Change sign-in email
        </button>
      ) : (
        <div style={{ display:'flex', flexDirection:'column', gap:8, maxWidth:360 }}>
          <input type="email" placeholder="New sign-in email" value={newEmail}
            onChange={e => setNewEmail(e.target.value)} />
          <input type="password" placeholder="Your current password" value={password}
            onChange={e => setPassword(e.target.value)} autoComplete="current-password" />
          {err && <span style={{ color:'var(--red)', fontSize:'.76rem' }}>{err}</span>}
          <div style={{ display:'flex', gap:8 }}>
            <button className="btn btn-primary btn-sm"
              disabled={!newEmail.trim() || !password || start.isLoading}
              onClick={() => start.mutate()}>
              {start.isLoading ? 'Sending…' : 'Send confirmation'}
            </button>
            <button className="btn btn-ghost btn-sm"
              onClick={() => { setOpen(false); setErr(null); setPassword('') }}>Cancel</button>
          </div>
          <span style={{ fontSize:'.72rem', color:'var(--text-3)' }}>
            We'll email the new address to confirm it, and let {currentEmail} know a change was asked for.
          </span>
        </div>
      )}
    </div>
  )
}
