/**
 * How long a sign-in lasts, and whether it renews while in use.
 *
 * S654 (Nic): "your most recent deploy signed me out." A session was a fixed
 * 7-day pass from the last password sign-in, never renewed, so every account
 * was thrown out on the seventh day mid-task. The landlord, tenant, register,
 * business and PM-company portals now renew a pass that is more than a day old
 * on load and whenever they come back into view, so for those a session ends
 * only after seven IDLE days.
 *
 * S655 (Nic): the admin console, Support (admin-ops) and GAM Books are the
 * opposite. Those sign-ins end a set time after they started, even while in
 * use, unless the person ticked "Keep me signed in on this device" when they
 * signed in. The choice rides inside the pass itself as the `sp` claim:
 *
 *   'rolling' — renewed while in use; ends after seven idle days.
 *   'fixed'   — never renewed; ends seven days after sign-in. The server
 *               refuses to extend it too (renewSessionToken in the API), so
 *               this is not just the browser being polite.
 *
 * A pass minted before `sp` existed has none. Staff roles were never renewed
 * by any portal that signs them in, so such a pass reads as fixed for them and
 * as rolling for everyone else — exactly what it already was.
 */

export const SESSION_POLICY_VALUES = ['fixed', 'rolling'] as const
export type SessionPolicy = typeof SESSION_POLICY_VALUES[number]

/** Roles whose sign-in is fixed-length unless they chose to stay signed in. */
export const FIXED_SESSION_ROLES = ['admin', 'super_admin', 'portfolio_manager'] as const

/**
 * The sign-in pages that name themselves to /api/auth/login. Each one only
 * admits certain roles (see /login in the API), and every one of them signs
 * in for a fixed length unless "Keep me signed in on this device" is ticked.
 */
export const SIGN_IN_PORTAL_VALUES = ['admin', 'admin_ops', 'books'] as const
export type SignInPortal = typeof SIGN_IN_PORTAL_VALUES[number]
export const FIXED_SESSION_PORTALS: readonly SignInPortal[] = SIGN_IN_PORTAL_VALUES

/** The policy a pass's claims carry, reading an older pass with no `sp` the way it already behaved. */
export function sessionPolicyOfClaims(claims: { sp?: unknown; role?: unknown } | null | undefined): SessionPolicy {
  const sp = claims?.sp
  if (sp === 'fixed' || sp === 'rolling') return sp
  return (FIXED_SESSION_ROLES as readonly string[]).includes(String(claims?.role ?? '')) ? 'fixed' : 'rolling'
}

/**
 * Reads the pass's own issue time (the JWT `iat`; no secret needed) and says
 * whether a portal should renew it now. A dead pass, a pending/enrolment pass
 * (it carries a `purpose`), or a fixed-length pass is never renewed — the
 * first two take the sign-in path, the last simply runs out.
 */
export function sessionRenewalDue(token: string | null | undefined, minAgeMs = 24 * 60 * 60 * 1000): boolean {
  if (!token || typeof atob !== 'function') return false
  try {
    const part = token.split('.')[1]
    if (!part) return false
    const p = JSON.parse(atob(part.replace(/-/g, '+').replace(/_/g, '/')))
    if (!p || typeof p.iat !== 'number' || p.purpose) return false
    if (sessionPolicyOfClaims(p) === 'fixed') return false
    const now = Date.now()
    if (typeof p.exp === 'number' && p.exp * 1000 <= now) return false
    return now - p.iat * 1000 > minAgeMs
  } catch { return false }
}

/**
 * The remembered answer to "Keep me signed in on this device" on a staff or
 * Books sign-in page. Per browser, never shared, and only a default for the
 * checkbox — the choice that counts is the one inside the pass. Storage can be
 * missing or blocked (private windows), so every access is guarded and the
 * checkbox simply starts unticked.
 */
export function readKeepSignedInChoice(key: string): boolean {
  try { return typeof localStorage !== 'undefined' && localStorage.getItem(key) === '1' } catch { return false }
}
export function rememberKeepSignedInChoice(key: string, keep: boolean): void {
  try {
    if (typeof localStorage === 'undefined') return
    if (keep) localStorage.setItem(key, '1')
    else localStorage.removeItem(key)
  } catch { /* storage blocked: the checkbox just starts unticked next time */ }
}
