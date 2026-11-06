import { useState } from 'react'
import { useMutation } from 'react-query'
import { useNavigate } from 'react-router-dom'
import { KeyRound } from 'lucide-react'
import { PASSWORD_MIN_LEN } from '@gam/shared'
import { apiPatch } from '../lib/api'
import { useAuth } from '../context/AuthContext'

// 10/30 (Nic): "on the, where I click my name right above sign out… there's no
// way in the portal to change my password that I can find."
//
// There wasn't. The endpoint has been there and tested the whole time — it
// already branches for a landlord or a staff member — and nothing in the
// landlord portal ever called it, so the only route to a new password was the
// forgot-password email from the sign-in page.
//
// Ungated on purpose. Everything else on this page sits behind a settings
// permission, but a front-desk or maintenance login needs to change its own
// password as much as the owner does, and nobody should need permission to do
// that to their own account.
//
// SIGNING OUT IS NOT A BUG HERE. The change stamps users.sessions_valid_from,
// and middleware/auth.ts refuses any pass minted before that stamp on EVERY
// route — so the pass in this browser dies the moment the password changes.
// That is the deliberate posture (a changed password ends the old sessions),
// and staff deliberately get no replacement pass from this endpoint. So rather
// than let the next click bounce off a 401 and dump them at the sign-in screen
// with no explanation, this says so up front and then signs them out itself.

export function ChangePassword() {
  const { logout } = useAuth()
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [done, setDone] = useState(false)

  const reset = () => { setCurrent(''); setNext(''); setConfirm(''); setErr(null) }

  const save = useMutation(
    () => apiPatch('/tenants/password', { currentPassword: current, newPassword: next }),
    {
      onSuccess: () => {
        // Show what happened before the screen changes under them, then end
        // the session deliberately. The pass is already dead server-side.
        setDone(true); reset()
        setTimeout(() => { logout(); navigate('/login') }, 2200)
      },
      onError: (e: any) => setErr(
        e?.response?.data?.error || 'Could not change the password. Try again.'),
    },
  )

  // Checked here as well as on the server so a typo in the confirmation is
  // caught before the old password is spent — getting this wrong signs them
  // out with a password they did not mean to set.
  const tooShort = next.length > 0 && next.length < PASSWORD_MIN_LEN
  const mismatch = confirm.length > 0 && next !== confirm
  const ready = !!current && next.length >= PASSWORD_MIN_LEN && next === confirm

  return (
    <div className="card">
      <div className="card-header"><span className="card-title">Password</span></div>

      {done ? (
        <div style={{ marginTop: 12, fontSize: '.85rem', color: 'var(--text-1)', lineHeight: 1.55 }}>
          <strong style={{ color: 'var(--green)' }}>Password changed.</strong> Signing you out now —
          sign back in with the new one. Any other browser or phone still signed in to this
          account is signed out too.
        </div>
      ) : (
        <div style={{ marginTop: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
            <KeyRound size={14} />
            <strong style={{ fontSize: '.82rem' }}>Change your password</strong>
          </div>
          <p style={{ fontSize: '.78rem', color: 'var(--text-3)', margin: '0 0 10px', maxWidth: 560, lineHeight: 1.55 }}>
            At least {PASSWORD_MIN_LEN} characters. Changing it signs you out here and on every
            other device, so have the new one saved before you finish.
          </p>

          {!open ? (
            <button className="btn btn-ghost btn-sm" onClick={() => { setOpen(true); reset() }}>
              Change password
            </button>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxWidth: 360 }}>
              {/* autoComplete matters on a phone: without these the password
                  manager neither fills the current one nor offers to save the
                  new one, which is how Nic ended up locked out of Chrome on
                  iOS with a password only Safari's keychain had. */}
              <input type="password" placeholder="Current password" value={current}
                autoComplete="current-password" name="current-password"
                onChange={e => setCurrent(e.target.value)} />
              <input type="password" placeholder={`New password (${PASSWORD_MIN_LEN}+ characters)`}
                value={next} autoComplete="new-password" name="new-password"
                onChange={e => setNext(e.target.value)} />
              <input type="password" placeholder="New password again" value={confirm}
                autoComplete="new-password" name="confirm-password"
                onChange={e => setConfirm(e.target.value)} />

              {tooShort && (
                <span style={{ color: 'var(--text-3)', fontSize: '.76rem' }}>
                  {PASSWORD_MIN_LEN - next.length} more character{PASSWORD_MIN_LEN - next.length === 1 ? '' : 's'} to go.
                </span>
              )}
              {mismatch && (
                <span style={{ color: 'var(--red)', fontSize: '.76rem' }}>
                  The two new passwords don't match yet.
                </span>
              )}
              {err && <span style={{ color: 'var(--red)', fontSize: '.76rem' }}>{err}</span>}

              <div style={{ display: 'flex', gap: 8 }}>
                <button className="btn btn-primary btn-sm" disabled={!ready || save.isLoading}
                  onClick={() => { setErr(null); save.mutate() }}>
                  {save.isLoading ? 'Changing…' : 'Change password'}
                </button>
                <button className="btn btn-ghost btn-sm"
                  onClick={() => { setOpen(false); reset() }}>Cancel</button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
