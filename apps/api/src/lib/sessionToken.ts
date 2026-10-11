/**
 * The one place a full session pass is minted.
 *
 * S655 (Nic): sign-ins on the admin console, Support (admin-ops) and GAM Books
 * end a set time after they started, even while in use, unless the person
 * ticked "Keep me signed in on this device". Every other portal keeps renewing
 * while in use (S654).
 *
 * The lifetime used to be written out three times ('7d' in auth.ts, emailOtp.ts
 * and totp.ts). It is one constant now, and every full pass carries its policy
 * in the `sp` claim ('fixed' | 'rolling', see @gam/shared sessionRenewal.ts).
 *
 * The browser decides when to ASK for a renewal; the server decides whether a
 * renewal may extend anything. A fixed pass handed to /auth/refresh is rebuilt
 * from the database (a pulled scope still drops out, a new company still shows
 * up) but keeps its original expiry — so an admin pass cannot be rolled
 * forever by some other portal that renews automatically.
 */
import jwt from 'jsonwebtoken'
import {
  FIXED_SESSION_PORTALS, FIXED_SESSION_ROLES, sessionPolicyOfClaims,
  type SessionPolicy,
} from '@gam/shared'

/** Seven days: from sign-in for a fixed pass, from the last renewal for a rolling one. */
export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60

const isFixedRole = (role: unknown) => (FIXED_SESSION_ROLES as readonly string[]).includes(String(role ?? ''))

/**
 * The policy for a sign-in that is happening now. Staff roles, and anyone
 * signing in at the admin console, Support or GAM Books, get a fixed-length
 * pass unless they asked to stay signed in on that device.
 */
export function sessionPolicyFor(
  role: string,
  portal: string | null | undefined,
  keepSignedIn: boolean | null | undefined,
): SessionPolicy {
  if (keepSignedIn === true) return 'rolling'
  if (isFixedRole(role)) return 'fixed'
  if (portal && (FIXED_SESSION_PORTALS as readonly string[]).includes(portal)) return 'fixed'
  return 'rolling'
}

/** The policy an existing pass (full or pending) carries; an older pass with none reads as it always behaved. */
export function policyOfPass(pass: { sp?: unknown; role?: unknown } | null | undefined): SessionPolicy {
  return sessionPolicyOfClaims(pass)
}

/** JWT bookkeeping and pending-only markers never ride into a new full pass. */
function sessionClaimsOnly(claims: Record<string, unknown>): Record<string, unknown> {
  const { iat: _iat, exp: _exp, nbf: _nbf, purpose: _purpose, sp: _sp, ...rest } = claims
  return rest
}

/** A fresh full session pass: SESSION_TTL_SECONDS from now. */
export function signSessionToken(claims: object, sp: SessionPolicy): string {
  return jwt.sign(
    { ...sessionClaimsOnly(claims as Record<string, unknown>), sp },
    process.env.JWT_SECRET!,
    { expiresIn: SESSION_TTL_SECONDS },
  )
}

/**
 * A renewal of `oldPass`, carrying `claims` rebuilt from the database.
 * Rolling: a fresh SESSION_TTL_SECONDS. Fixed: the original expiry, never later.
 *
 * A pass whose role has since become a staff role is treated as fixed: the
 * rolling choice on it was made for a different kind of account.
 */
export function renewSessionToken(
  claims: { role?: unknown } & object,
  oldPass: { sp?: unknown; role?: unknown; exp?: unknown },
): string {
  let sp = policyOfPass(oldPass)
  if (sp === 'rolling' && isFixedRole(claims.role) && !isFixedRole(oldPass.role)) sp = 'fixed'
  if (sp === 'fixed' && typeof oldPass.exp === 'number') {
    return jwt.sign(
      { ...sessionClaimsOnly(claims as Record<string, unknown>), sp, exp: oldPass.exp },
      process.env.JWT_SECRET!,
    )
  }
  return signSessionToken(claims, sp)
}
