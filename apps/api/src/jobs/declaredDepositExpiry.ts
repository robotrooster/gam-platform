// S624 — claims that never arrived.
//
// A tenant reports a bank deposit; the feed never produces a matching row. That
// is not automatically a lie — a money order goes astray, a deposit slip is
// filled out wrong, someone pays the wrong landlord's account. But it cannot sit
// pending forever either: an open claim is a promise to keep looking, and after
// a point the honest thing is to say we did not find it.
//
// This is the SECOND half of the anti-fraud design and much the weaker half. The
// first half is that a declaration never credits anything, so lying wins nothing
// (see the migration header). This just cleans up and records a pattern the
// landlord may want to know about.
//
// It never accuses. The note the tenant sees says the deposit was not found, not
// that they did not make it, because we genuinely cannot tell those apart.

import { DateTime } from 'luxon'
import { query } from '../db'
import { createNotification } from '../services/notifications'
import { logger } from '../lib/logger'
import {
  DECLARATION_EXPIRY_DAYS, UNCONFIRMED_STRIKE_LIMIT,
} from '../routes/declaredDeposits'

export interface ExpirySweepResult {
  expired: number
  tenantsFlagged: number
  errors: string[]
}

export async function sweepExpiredDeclarations(
  asOf?: string,
): Promise<ExpirySweepResult> {
  const result: ExpirySweepResult = { expired: 0, tenantsFlagged: 0, errors: [] }
  const today = asOf ?? DateTime.now().setZone('America/Phoenix').toISODate()!

  try {
    // Expire on the DECLARED date, not on created_at: a tenant reporting a
    // deposit they made a week ago should not get a fresh week of waiting.
    const rows = await query<any>(
      `UPDATE tenant_declared_deposits d
          SET status = 'unconfirmed',
              resolution_note = 'We could not find a matching deposit in the bank feed.',
              updated_at = NOW()
        WHERE d.status = 'pending'
          AND d.declared_date < ($1::date - $2::int)
        RETURNING d.id, d.tenant_id, d.amount::float AS amount,
                  to_char(d.declared_date,'YYYY-MM-DD') AS declared_date,
                  d.landlord_id`,
      [today, DECLARATION_EXPIRY_DAYS])
    result.expired = rows.length

    for (const r of rows) {
      try {
        const t = await query<{ user_id: string }>(
          `SELECT user_id FROM tenants WHERE id = $1`, [r.tenant_id])
        if (t[0]?.user_id) {
          await createNotification({
            userId: t[0].user_id,
            type: 'deposit_report_unconfirmed',
            title: 'We could not find your deposit',
            // Deliberately not an accusation — we cannot distinguish a lie from
            // a deposit made into the wrong account, and the tenant is far more
            // likely to be the second.
            body: `We looked for the $${Number(r.amount).toFixed(2)} deposit you reported on ${r.declared_date} and it has not appeared in your landlord's bank feed. Your balance is unchanged. If you did pay, check the deposit slip and talk to your landlord — they can look it up directly.`,
            actionUrl: '/payments',
          })
        }

        // Count strikes AFTER this one lands, so the threshold means what it says.
        const strikes = await query<{ n: string }>(
          `SELECT COUNT(*) AS n FROM tenant_declared_deposits
            WHERE tenant_id = $1 AND status = 'unconfirmed'`, [r.tenant_id])
        if (parseInt(strikes[0]?.n ?? '0', 10) >= UNCONFIRMED_STRIKE_LIMIT) {
          result.tenantsFlagged++
          const l = await query<{ user_id: string }>(
            `SELECT user_id FROM landlords WHERE id = $1`, [r.landlord_id])
          if (l[0]?.user_id) {
            await createNotification({
              userId: l[0].user_id,
              landlordId: r.landlord_id,
              type: 'deposit_reports_unconfirmed',
              title: 'Repeated deposit reports have not matched',
              body: `A tenant has now reported ${strikes[0].n} bank deposits that never appeared in your feed. Their balance was never credited for any of them. Worth a conversation — it may be a wrong account number rather than anything else.`,
              actionUrl: '/bank-feed',
            })
          }
        }
      } catch (e) {
        result.errors.push(e instanceof Error ? e.message : String(e))
      }
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    result.errors.push(msg)
    logger.error({ err: e }, '[declared-deposit-expiry] sweep failed')
  }
  return result
}
