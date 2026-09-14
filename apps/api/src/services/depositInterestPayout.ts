/**
 * S642 (Nic): "Calculate interest, have it be paid out as credit where
 * applicable… Realistically, either way, it ends up in the landlord's pocket.
 * Because they just use it to pay rent."
 *
 * Interest has accrued monthly since S604 and was only ever PAID at move-out.
 * Eight states require it paid annually while the tenancy continues — AZ, IL,
 * MA, NJ, NM, OH, PA, RI — so a tenant three years into a lease in any of them
 * is owed money the platform calculated and never handed over.
 *
 * ONE RULE. Every state requires payment at termination; eight additionally
 * require it annually. Paying annually in a termination-only state is not a
 * violation — the tenant gets their money sooner and GAM holds the principal
 * either way. So this pays annually wherever anything is owed, rather than
 * modelling thirteen cadences and getting one wrong.
 *
 * AS A CREDIT, not cash: it lands on the tenant's balance and comes off their
 * next bill automatically. Cash would mean opening a payout rail to a tenant
 * GAM may have no account for, to hand them money they are about to hand back
 * as rent.
 */
import { getClient, query } from '../db'
import { logger } from '../lib/logger'

export interface PayoutResult {
  scanned: number
  paid: number
  skipped: number
  totalCredited: number
  errors: number
}

/** Below this the credit costs more to explain than it is worth. */
const MIN_CREDIT = 0.01

/**
 * Pay every deposit whose oldest unpaid accrual is at least a year old.
 *
 * Anniversary-driven rather than calendar-driven: the statutes that name a
 * cadence say "after each 12 month rental period" (IL) or "on the lease
 * anniversary" (PA), not January. Running on the tenancy's own clock also
 * spreads the work across the year instead of piling every tenant onto one day.
 *
 * @param asOf test seam; defaults to now
 */
export async function payAnnualDepositInterest(asOf?: Date): Promise<PayoutResult> {
  const out: PayoutResult = { scanned: 0, paid: 0, skipped: 0, totalCredited: 0, errors: 0 }
  const now = asOf ?? new Date()

  // One row per deposit that has a full year of unpaid accruals behind it.
  // Deposits already returned are excluded: their interest went out with the
  // deposit through depositReturn, and paying again would double-pay.
  const due = await query<{
    security_deposit_id: string
    lease_id: string
    tenant_id: string
    landlord_id: string
    owed: string
    months: string
    oldest: string
  }>(
    `SELECT a.security_deposit_id,
            a.lease_id,
            sd.tenant_id,
            l.landlord_id,
            SUM(a.interest_amount)::text AS owed,
            COUNT(*)::text               AS months,
            MIN(a.accrual_month)::text   AS oldest
       FROM security_deposit_interest_accruals a
       JOIN security_deposits sd ON sd.id = a.security_deposit_id
       JOIN leases l             ON l.id = a.lease_id
      WHERE a.paid_at IS NULL
        AND a.interest_amount > 0
        AND sd.disbursed_at IS NULL
      GROUP BY a.security_deposit_id, a.lease_id, sd.tenant_id, l.landlord_id
     HAVING MIN(a.accrual_month) <= ($1::date - INTERVAL '12 months')
        AND SUM(a.interest_amount) >= $2`,
    [now.toISOString().slice(0, 10), MIN_CREDIT])

  out.scanned = due.length

  for (const d of due) {
    const client = await getClient()
    try {
      await client.query('BEGIN')

      // Re-read the accrual ids INSIDE the transaction and lock them. Without
      // this, two overlapping runs would each see the same unpaid months and
      // each issue a credit for them — the one failure that costs real money
      // and leaves a ledger that looks correct.
      const rows = await client.query<{ id: string; interest_amount: string }>(
        `SELECT id, interest_amount::text
           FROM security_deposit_interest_accruals
          WHERE security_deposit_id = $1 AND paid_at IS NULL AND interest_amount > 0
          FOR UPDATE`,
        [d.security_deposit_id])

      const amount = Math.round(
        rows.rows.reduce((s, r) => s + parseFloat(r.interest_amount), 0) * 100) / 100

      if (amount < MIN_CREDIT) {
        await client.query('ROLLBACK')
        out.skipped++
        continue
      }

      const credit = await client.query<{ id: string }>(
        `INSERT INTO tenant_credits
           (landlord_id, tenant_id, lease_id, amount_original, amount_remaining,
            category, reason, status)
         VALUES ($1,$2,$3,$4,$4,'deposit_interest',$5,'active')
         RETURNING id`,
        [d.landlord_id, d.tenant_id, d.lease_id, amount,
         `Statutory interest on your security deposit — ${rows.rows.length} month(s) through ${d.oldest}`])

      await client.query(
        `UPDATE security_deposit_interest_accruals
            SET paid_at = NOW(), paid_credit_id = $2
          WHERE id = ANY($1::uuid[])`,
        [rows.rows.map(r => r.id), credit.rows[0].id])

      await client.query('COMMIT')
      out.paid++
      out.totalCredited = Math.round((out.totalCredited + amount) * 100) / 100
      logger.info({ security_deposit_id: d.security_deposit_id, amount, months: rows.rows.length },
        '[deposit-interest] credited statutory interest to the tenant')
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {})
      out.errors++
      // One tenant's failure must not stop the rest of the sweep. The accruals
      // stay unpaid and the next run picks them up.
      logger.error({ err: e, security_deposit_id: d.security_deposit_id },
        '[deposit-interest] could not credit — will retry next run')
    } finally {
      client.release()
    }
  }

  logger.info(out, '[deposit-interest] annual payout sweep')
  return out
}

/**
 * What a landlord/admin screen needs: who is owed, how much, how overdue.
 * Read-only — the sweep is the only thing that pays.
 */
export async function outstandingDepositInterest(landlordIds?: string[] | null) {
  return query<any>(
    `SELECT l.landlord_id,
            p.name  AS property_name,
            u.unit_number,
            TRIM(CONCAT_WS(' ', tu.first_name, tu.last_name)) AS tenant_name,
            a.state_code,
            SUM(a.interest_amount)::float AS owed,
            COUNT(*)::int                 AS months_unpaid,
            MIN(a.accrual_month)::text    AS oldest_unpaid
       FROM security_deposit_interest_accruals a
       JOIN security_deposits sd ON sd.id = a.security_deposit_id
       JOIN leases l  ON l.id = a.lease_id
       JOIN units u   ON u.id = l.unit_id
       JOIN properties p ON p.id = u.property_id
       JOIN tenants t ON t.id = sd.tenant_id
       JOIN users tu  ON tu.id = t.user_id
      WHERE a.paid_at IS NULL
        AND a.interest_amount > 0
        AND sd.disbursed_at IS NULL
        AND ($1::uuid[] IS NULL OR l.landlord_id = ANY($1::uuid[]))
      GROUP BY l.landlord_id, p.name, u.unit_number, tenant_name, a.state_code
      ORDER BY owed DESC`,
    [landlordIds ?? null])
}
