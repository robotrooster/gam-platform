/**
 * Renewing the tenant's sign-in while the app is in use (S654), as one routine
 * the app calls and a test can drive.
 *
 * S654 (Nic): a session was a fixed 7-day pass from the last password sign-in,
 * never renewed, so people were thrown out on the seventh day mid-task. The app
 * renews a pass older than a day on load and whenever it comes back into view
 * (the phone's return from the mail app), so a session ends only after seven
 * idle days. See sessionRenewalDue in @gam/shared.
 *
 * Final sweep (10/3): A LOCK IS NOT A SIGN-OUT. Five wrong passwords (perhaps
 * someone else's) lock the account for fifteen minutes. The renewal used to be
 * answered 401 during a lock, which reads as "this pass is dead", so a tenant
 * signed in on their phone was signed out without a word and then could not
 * sign back in until the lock ran out. The server now answers a lock with 423,
 * and this keeps the pass the app already holds: it is still good until its own
 * expiry, and the next renewal after the lock goes through.
 */
import { isAuthRejection, sessionRenewalDue } from '@gam/shared'

/** What /auth/refresh answers while the account is locked (RENEWAL_LOCKED_STATUS in the API).
 *  The API's auth.test.ts reads this line and fails if the two numbers differ. */
export const RENEWAL_LOCKED_STATUS = 423

export type RenewalOutcome =
  /** Nothing to do: no pass, or not old enough to renew. */
  | 'not_due'
  /** A new pass was stored. */
  | 'renewed'
  /** A sign-out or another sign-in happened while this was in flight; it wins. */
  | 'superseded'
  /** The account is locked for now: the current pass stays. */
  | 'kept_locked'
  /** A blip (network, API restarting): the current pass stays. */
  | 'kept'
  /** The server refused the pass itself: signed out. */
  | 'signed_out'

export function renewalAnswerIsLock(e: any): boolean {
  return e?.response?.status === RENEWAL_LOCKED_STATUS
}

export async function renewTenantSession(deps: {
  /** The pass the app holds right now (localStorage). */
  readToken: () => string | null
  /** POST /auth/refresh; resolves to the new pass. */
  requestRenewal: () => Promise<string>
  /** Store the new pass. */
  storeToken: (token: string) => void
  /** End the session. */
  signOut: () => void
}): Promise<RenewalOutcome> {
  const current = deps.readToken()
  if (!sessionRenewalDue(current)) return 'not_due'
  try {
    const next = await deps.requestRenewal()
    // S654 (review): a sign-out (or another sign-in) while this was in flight wins.
    if (deps.readToken() !== current) return 'superseded'
    deps.storeToken(next)
    return 'renewed'
  } catch (e) {
    // A lock keeps the pass. (423 is not a 401/403, so the check below would let
    // it go anyway; this says so out loud, and the test pins it.)
    if (renewalAnswerIsLock(e)) return 'kept_locked'
    // S540: only a real 401/403 ends a session; transient failures keep the pass.
    if (isAuthRejection(e)) { deps.signOut(); return 'signed_out' }
    return 'kept'
  }
}
