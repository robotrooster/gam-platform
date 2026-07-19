/**
 * S545c: silent FlexPay verification checks (Nic).
 *
 * BIRTHDATE gate: SSA pays SSDI by the recipient's birth date —
 *   1st–10th → 2nd Wednesday, 11th–20th → 3rd Wednesday,
 *   21st–31st → 4th Wednesday.
 * When a request claims an SSDI Wednesday schedule and NO lease
 * holder's date_of_birth is consistent with it, the request is
 * SILENTLY held: held_at/hold_reason set, removed from the working
 * queue (position preserved via created_at — releasing the hold
 * restores their spot automatically). ZERO tenant-facing signal —
 * the tenant portal never exposes hold state.
 *
 * Not held: missing DOBs (can't verify ≠ mismatch), ssdi_day_3
 * (pre-May-1997 claims — DOB says nothing), SSI, fixed-day claims.
 *
 * The NAME gate (document name must match a lease holder) is a human
 * judgment — enforced at approval via a required confirmation in the
 * review route; this service only covers what can be checked
 * automatically.
 */
import { query, queryOne } from '../db'
import { logger } from '../lib/logger'

const WED_BY_DOB_RANGE = (dobDay: number): 'ssdi_wed_2' | 'ssdi_wed_3' | 'ssdi_wed_4' =>
  dobDay <= 10 ? 'ssdi_wed_2' : dobDay <= 20 ? 'ssdi_wed_3' : 'ssdi_wed_4'

const WED_LABEL: Record<string, string> = {
  ssdi_wed_2: '2nd Wednesday', ssdi_wed_3: '3rd Wednesday', ssdi_wed_4: '4th Wednesday',
}

/**
 * Run the birthdate consistency check for one inquiry. Never throws
 * (caller paths are tenant-facing inserts that must not break).
 * Returns true when a hold was placed.
 */
export async function runBirthdateCheck(inquiryId: string): Promise<boolean> {
  try {
    const inq = await queryOne<{ id: string; tenant_id: string; benefit_schedule: string | null; held_at: string | null }>(
      `SELECT id, tenant_id, benefit_schedule, held_at FROM flexpay_inquiries WHERE id = $1`,
      [inquiryId])
    if (!inq || inq.held_at) return false
    if (!inq.benefit_schedule || !inq.benefit_schedule.startsWith('ssdi_wed_')) return false

    // All lease holders on the requesting tenant's active lease.
    const holders = await query<{ dob_day: number | null }>(
      `SELECT EXTRACT(DAY FROM t2.date_of_birth)::int AS dob_day
         FROM lease_tenants lt
         JOIN leases l ON l.id = lt.lease_id
         JOIN lease_tenants lt2 ON lt2.lease_id = l.id AND lt2.status = 'active'
         JOIN tenants t2 ON t2.id = lt2.tenant_id
        WHERE lt.tenant_id = $1 AND lt.status = 'active'
          AND l.status IN ('active', 'pending')`,
      [inq.tenant_id])

    const knownDays = holders.map(h => h.dob_day).filter((d): d is number => d != null)
    if (knownDays.length === 0) return false   // can't verify ≠ mismatch

    const consistent = knownDays.some(d => WED_BY_DOB_RANGE(d) === inq.benefit_schedule)
    if (consistent) return false

    const expected = [...new Set(knownDays.map(d => WED_LABEL[WED_BY_DOB_RANGE(d)]))].join(' or ')
    await query(
      `UPDATE flexpay_inquiries
          SET held_at = NOW(),
              hold_reason = $2,
              updated_at = NOW()
        WHERE id = $1 AND held_at IS NULL`,
      [inq.id,
       `Birthdate mismatch: claims ${WED_LABEL[inq.benefit_schedule]}, but lease-holder birthdates indicate ${expected}. Verify identity/benefit letter before releasing.`])
    logger.info({ inquiryId: inq.id }, '[flexpay-verification] silent birthdate hold placed')
    return true
  } catch (e) {
    logger.error({ err: e, inquiryId }, '[flexpay-verification] check failed (non-fatal)')
    return false
  }
}
