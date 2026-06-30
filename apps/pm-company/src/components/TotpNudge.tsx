import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ShieldAlert, X } from 'lucide-react'
import { useAuth } from '../context/AuthContext'

const DISMISS_KEY = 'gam_pm_totp_nudge_dismissed'

/**
 * Soft, dismissible nudge encouraging 2FA enrollment. PM-company users
 * are not in MANDATORY_TOTP_ROLES, so this NEVER blocks — it's a banner
 * the user can act on or dismiss. Dismissal persists in localStorage so
 * it doesn't re-appear every render; it returns once the flag is cleared
 * (or on a new device / cleared storage).
 */
export function TotpNudge() {
  const { user } = useAuth()
  const navigate = useNavigate()
  const [dismissed, setDismissed] = useState(() => localStorage.getItem(DISMISS_KEY) === '1')

  // Only nudge users who haven't enrolled yet. Once totpEnabled flips
  // true the banner disappears regardless of the dismiss flag.
  if (!user || user.totpEnabled || dismissed) return null

  const dismiss = () => {
    localStorage.setItem(DISMISS_KEY, '1')
    setDismissed(true)
  }

  return (
    <div className="alert alert-gold" style={{ alignItems: 'center' }}>
      <ShieldAlert size={16} />
      <div style={{ flex: 1 }}>
        <strong>Protect your account with two-factor authentication.</strong>{' '}
        Add an authenticator-app code to every sign-in.
      </div>
      <button
        className="btn btn-primary btn-sm"
        onClick={() => navigate('/totp/enroll')}
        style={{ marginRight: 4 }}
      >
        Enable
      </button>
      <button
        onClick={dismiss}
        aria-label="Dismiss"
        style={{ background: 'none', border: 'none', color: 'var(--text-3)', cursor: 'pointer', display: 'flex', alignItems: 'center' }}
      >
        <X size={15} />
      </button>
    </div>
  )
}
