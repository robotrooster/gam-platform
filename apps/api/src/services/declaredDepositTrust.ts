// 10/5 (Nic) — what counts against a tenant's "I paid at the bank" button.
//
// S624: a report whose deposit never came (status 'unconfirmed'). 10/5: also a
// report the bank DID confirm but on a later day than the tenant gave — later
// than the next business day after it (services/depositBackdate
// declaredDateIsFalse). Nic: "if they say they paid on time and it was
// actually late we need to make sure that they get the late fee and then they
// get flagged for false information."
//
// One definition, read by the report button (routes/declaredDeposits), the
// landlord's list of reports, the expiry job and the bank match.

import { query } from '../db'
import { createNotification } from './notifications'

/**
 * How many strikes before the button stops trusting a tenant. Two is
 * deliberate: one is a mistake, two is a pattern worth naming.
 */
export const UNCONFIRMED_STRIKE_LIMIT = 2

/** SQL: report `d` is a strike — never found at the bank, or found on a later day than the tenant gave. */
export const DECLARATION_STRIKE_SQL = (d: string) =>
  `(${d}.status = 'unconfirmed' OR ${d}.false_date_flagged_at IS NOT NULL)`

/**
 * A tenant's strikes. Without `landlordId`, across every landlord — the report
 * button's trust is the tenant's own. With it, only the reports made to that
 * landlord: what THAT landlord is told or shown. A landlord never learns of
 * reports a tenant made to another company (audience data isolation).
 */
export async function declarationStrikes(tenantId: string, landlordId?: string): Promise<number> {
  const r = await query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM tenant_declared_deposits d
      WHERE d.tenant_id = $1 AND ($2::uuid IS NULL OR d.landlord_id = $2::uuid)
        AND ${DECLARATION_STRIKE_SQL('d')}`, [tenantId, landlordId ?? null])
  return parseInt(r[0]?.n ?? '0', 10)
}

/**
 * Tell the landlord once a tenant's strikes reach the limit (after the strike
 * that was just added). Returns whether they were told. Never accuses: a
 * money order can go astray, and a deposit can be dated wrong by mistake.
 */
export async function tellLandlordAtStrikeLimit(tenantId: string, landlordId: string): Promise<boolean> {
  // 10/5: counted on this landlord's reports only, and the tenant is named —
  // the landlord cannot have the conversation without knowing with whom.
  const n = await declarationStrikes(tenantId, landlordId)
  if (n < UNCONFIRMED_STRIKE_LIMIT) return false
  const l = await query<{ user_id: string }>(`SELECT user_id FROM landlords WHERE id = $1`, [landlordId])
  if (!l[0]?.user_id) return false
  const who = (await query<{ tenant_name: string; unit_number: string | null }>(
    `SELECT TRIM(COALESCE(usr.first_name,'') || ' ' || COALESCE(usr.last_name,'')) AS tenant_name,
            (SELECT u.unit_number FROM tenant_declared_deposits d
               JOIN leases le ON le.id = d.lease_id JOIN units u ON u.id = le.unit_id
              WHERE d.tenant_id = t.id AND d.landlord_id = $2
              ORDER BY d.declared_date DESC, d.created_at DESC LIMIT 1) AS unit_number
       FROM tenants t JOIN users usr ON usr.id = t.user_id
      WHERE t.id = $1`, [tenantId, landlordId]))[0]
  const name = who?.tenant_name ? who.tenant_name : 'A tenant'
  const tenantWords = who?.unit_number ? `${name} (${who.unit_number})` : name
  await createNotification({
    userId: l[0].user_id,
    landlordId,
    type: 'deposit_reports_unconfirmed',
    title: 'Repeated deposit reports have not held up',
    body: `${tenantWords} has now made ${n} bank deposit reports that did not hold up — the deposit never appeared in your feed, ` +
      'or the bank showed it on a later day than they said. Their balance was never credited for a deposit that did not come, ' +
      'and a late date never took a late fee off. Worth a conversation — it may be a wrong account number or a mistaken date rather than anything else.',
    actionUrl: '/bank-feed',
  })
  return true
}
