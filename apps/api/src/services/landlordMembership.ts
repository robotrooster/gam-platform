// S554 Connect re-anchor — LIVE landlord-entity membership check.
//
// The JWT carries landlordIds[] resolved AT LOGIN (scope.ts landlordOwns).
// That's fine for ordinary reads, but on MONEY-CRITICAL routes (Connect
// onboarding/status, disbursements/payouts) it is a hole: a co-owner removed
// from the entity keeps their memberships in a still-valid JWT for up to the
// token lifetime (≤7d). During that window their stale token must NOT be able
// to onboard, re-point, or disburse the entity's funds. These helpers re-check
// membership against landlord_members at REQUEST time so a removal takes effect
// immediately on the money surface.

import { query } from '../db'
import { AppError } from '../middleware/errorHandler'

export async function isLiveLandlordMember(userId: string, landlordId: string): Promise<boolean> {
  const rows = await query<{ ok: number }>(
    `SELECT 1 AS ok FROM landlord_members WHERE landlord_id = $1 AND user_id = $2 LIMIT 1`,
    [landlordId, userId],
  )
  return rows.length > 0
}

/** Throws 403 unless the user is CURRENTLY a member of the landlord entity. */
export async function assertLiveLandlordMember(userId: string, landlordId: string): Promise<void> {
  if (!(await isLiveLandlordMember(userId, landlordId))) {
    throw new AppError(403, 'You are not a current owner of this landlord entity.')
  }
}
