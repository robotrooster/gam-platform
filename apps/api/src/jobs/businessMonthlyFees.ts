/**
 * S536 (Nic): business pricing — the POS register is FREE; invoicing
 * costs $10/month in any month the business actually SENDS an invoice.
 * Usage-based, no toggle, no plans: send ≥1 invoice in a month → that
 * month accrues the fee; send none → free.
 *
 * Runs daily at 04:15 Phoenix and self-gates: accrual rows are created
 * on the 1st for the PRIOR month (idempotent via UNIQUE(business_id,
 * month)), and every run retries collection of any 'pending' rows —
 * so a business whose Connect wasn't ready on the 1st gets collected
 * later without special-casing.
 *
 * Collection = Stripe ACCOUNT DEBIT: the platform charges the
 * business's Connect balance directly (source: connected account).
 * If the balance is short, Stripe lets it go negative and recovers
 * from future transfers — consistent with "all money flows through
 * GAM" (their POS/invoice revenue lands on that balance; Friday
 * payouts sweep the rest to their bank).
 */

import { PLATFORM_FEES } from '@gam/shared'
import { getStripe } from '../lib/stripe'
import { query, queryOne } from '../db'
import { logger } from '../lib/logger'

const TZ = 'America/Phoenix'

function priorMonthKey(now: Date): string {
  const local = new Date(now.toLocaleString('en-US', { timeZone: TZ }))
  const d = new Date(local.getFullYear(), local.getMonth() - 1, 1)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

function isFirstOfMonth(now: Date): boolean {
  const local = new Date(now.toLocaleString('en-US', { timeZone: TZ }))
  return local.getDate() === 1
}

export async function processBusinessMonthlyFees(now: Date = new Date()): Promise<{ accrued: number; collected: number; failed: number }> {
  const result = { accrued: 0, collected: 0, failed: 0 }

  // 1. On the 1st: accrue for the prior month — every business that
  //    sent at least one invoice during it.
  if (isFirstOfMonth(now)) {
    const month = priorMonthKey(now)
    const [y, m] = month.split('-').map(Number)
    const monthStart = new Date(y, m - 1, 1).toISOString()
    const monthEnd   = new Date(y, m, 1).toISOString()
    const rows = await query<{ id: string }>(
      `INSERT INTO business_platform_fee_accruals (business_id, month, amount)
       SELECT DISTINCT i.business_id, $1, $2
         FROM business_invoices i
         JOIN businesses b ON b.id = i.business_id
        WHERE i.created_at >= $3 AND i.created_at < $4
          AND i.status NOT IN ('draft')
          AND b.status = 'active'
       ON CONFLICT (business_id, month) DO NOTHING
       RETURNING id`,
      [month, PLATFORM_FEES.BUSINESS_INVOICING_MONTHLY, monthStart, monthEnd])
    result.accrued = rows.length
  }

  // 2. Every run: try to collect pending accruals via account debit.
  const pending = await query<{ id: string; business_id: string; amount: string; connect: string | null; ready: boolean }>(
    `SELECT a.id, a.business_id, a.amount,
            b.stripe_connect_account_id AS connect,
            (b.connect_payouts_enabled AND b.connect_details_submitted) AS ready
       FROM business_platform_fee_accruals a
       JOIN businesses b ON b.id = a.business_id
      WHERE a.status = 'pending'`)
  const stripe = getStripe()
  for (const p of pending) {
    if (!p.connect || !p.ready) continue  // retried next run
    try {
      const charge = await stripe.charges.create({
        amount:      Math.round(Number(p.amount) * 100),
        currency:    'usd',
        source:      p.connect,             // account debit: platform charges the connected account
        description: `GAM invoicing subscription — ${p.business_id}`,
      }, { idempotencyKey: `biz_invoicing_fee_${p.id}` })
      await query(
        `UPDATE business_platform_fee_accruals
            SET status='collected', stripe_charge_id=$1, collected_at=NOW()
          WHERE id=$2`, [charge.id, p.id])
      result.collected++
    } catch (e) {
      result.failed++
      logger.error({ err: e, accrual_id: p.id }, '[business-fees] account debit failed')
    }
  }
  return result
}
