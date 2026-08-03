import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'

/**
 * S574 — register lock screen. Shown when this device is bound to a business
 * (terminal token present) but no cashier is signed in. A cashier taps their
 * 4–6 digit passcode to start ringing; the resulting session is register-only.
 */
export function LockScreen() {
  const { unlockWithPasscode, deactivateTerminal } = useAuth()
  const navigate = useNavigate()
  const [code, setCode] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  const press = (d: string) => { setErr(''); setCode(c => (c.length >= 6 ? c : c + d)) }
  const back = () => { setErr(''); setCode(c => c.slice(0, -1)) }

  const submit = async () => {
    if (code.length < 4) { setErr('Enter your 4–6 digit passcode.'); return }
    setBusy(true); setErr('')
    try { await unlockWithPasscode(code); navigate('/pos') }
    catch (e: any) { setErr(e?.response?.data?.error || 'Incorrect passcode.'); setCode('') }
    finally { setBusy(false) }
  }

  const ownerSignIn = () => {
    // Owner/manager needs full access — un-bind so /login is a clean full sign-in.
    deactivateTerminal()
    navigate('/login')
  }

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg-1)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
      <div style={{ width: '100%', maxWidth: 340 }}>
        <div style={{ textAlign: 'center', marginBottom: 28 }}>
          <div style={{ fontSize: '2.2rem', marginBottom: 6 }}>🔒</div>
          <div style={{ fontSize: '1.4rem', fontWeight: 700, color: 'var(--gold)' }}>Register locked</div>
          <div style={{ fontSize: '.82rem', color: 'var(--text-3)', marginTop: 4 }}>Enter your passcode to start</div>
        </div>

        {/* code dots */}
        <div style={{ display: 'flex', justifyContent: 'center', gap: 12, marginBottom: 18, height: 16 }}>
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} style={{
              width: 12, height: 12, borderRadius: '50%',
              background: i < code.length ? 'var(--gold)' : 'var(--bg-3)',
              border: '1px solid ' + (i < code.length ? 'var(--gold)' : 'var(--border-1)'),
            }} />
          ))}
        </div>

        {err && <div style={{ textAlign: 'center', color: 'var(--red)', fontSize: '.82rem', marginBottom: 12 }}>{err}</div>}

        {/* keypad */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
          {['1','2','3','4','5','6','7','8','9'].map(d => (
            <button key={d} onClick={() => press(d)} disabled={busy} style={keyBtn}>{d}</button>
          ))}
          <button onClick={back} disabled={busy} style={{ ...keyBtn, fontSize: '1rem' }}>⌫</button>
          <button onClick={() => press('0')} disabled={busy} style={keyBtn}>0</button>
          <button onClick={submit} disabled={busy || code.length < 4} style={{ ...keyBtn, background: 'var(--gold)', color: '#1a1400', borderColor: 'var(--gold)' }}>
            {busy ? '…' : '→'}
          </button>
        </div>

        <div style={{ textAlign: 'center', marginTop: 22 }}>
          <button onClick={ownerSignIn} style={{ background: 'none', border: 'none', color: 'var(--text-3)', fontSize: '.8rem', cursor: 'pointer', textDecoration: 'underline' }}>
            Owner / manager sign in
          </button>
        </div>
      </div>
    </div>
  )
}

const keyBtn: React.CSSProperties = {
  height: 60, fontSize: '1.4rem', fontWeight: 600,
  background: 'var(--bg-2)', color: 'var(--text-0)',
  border: '1px solid var(--border-1)', borderRadius: 12, cursor: 'pointer',
}
