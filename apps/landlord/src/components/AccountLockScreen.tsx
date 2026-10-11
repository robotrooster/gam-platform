/**
 * S652 — what a landlord sees when GAM has suspended their account.
 *
 * Nic: "we can just lock down all the data and say, please, when they log in,
 * maybe the only thing they can see is 'please contact GAM support to restore
 * your account access.' I don't think that'll hardly ever happen, but it's good
 * to have a safety precaution."
 *
 * TWO THINGS THIS SCREEN MUST NOT DO.
 *
 * It must not read as a bug. A portal that simply fails to load looks broken,
 * and a landlord who thinks GAM is broken rings about the wrong problem. So it
 * says plainly what happened and what fixes it.
 *
 * And it must not be a dead end. The remedy for "GAM cannot collect what it is
 * owed" is connecting a bank — which lives behind the very portal being locked.
 * A lock whose only exit is a phone call turns a collections problem into a
 * support ticket, so the one door left open is the one that solves it. The
 * escape list in middleware/auth keeps that route reachable.
 */
import { useEffect, useState } from 'react'
import { ACCOUNT_LOCKED_EVENT } from '../lib/api'

export function AccountLockScreen() {
  const [locked, setLocked] = useState(false)
  const [reason, setReason] = useState<string | null>(null)

  useEffect(() => {
    const onLocked = (e: Event) => {
      setLocked(true)
      setReason((e as CustomEvent).detail?.reason ?? null)
    }
    window.addEventListener(ACCOUNT_LOCKED_EVENT, onLocked)
    return () => window.removeEventListener(ACCOUNT_LOCKED_EVENT, onLocked)
  }, [])

  if (!locked) return null

  return (
    <div className="lock-overlay">
      <div className="lock-card">
        <div className="lock-title">Your account is on hold</div>
        <p className="lock-body">
          Gold Asset Management has suspended access to this account while there is an
          outstanding balance we have not been able to collect.
        </p>
        {reason && <p className="lock-reason">{reason}</p>}
        <p className="lock-body">
          Connecting a bank account is usually all it takes — that is the one thing you can
          still do from here.
        </p>
        <div className="lock-actions">
          <a className="btn btn-primary" href="/banking">Connect a bank account</a>
          <a className="btn btn-ghost" href="mailto:support@goldassetmanagement.com">
            Contact GAM support
          </a>
        </div>
        <p className="lock-foot">
          Your tenants are not affected. Rent is still being collected and they can still
          reach you through the portal.
        </p>
      </div>
    </div>
  )
}
