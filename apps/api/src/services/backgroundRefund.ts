// S552: applicant refunds for screenings that never happened.
//
// The applicant pays GAM before the Checkr order is placed (see
// routes/background.ts). When a check is cancelled without a report —
// applicant-initiated cancel, or the stale-order sweep below — the payment
// is refunded IN FULL and any unbilled landlord accrual for the check is
// voided (no report ⇒ Checkr never bills GAM ⇒ the landlord owes nothing).
//
// Full-refund-everywhere is deliberate: some actual-cost states (MN
// explicitly) REQUIRE refunding when no screening is performed; one
// behavior for all 50 states is the simplest compliant posture.
//
// Already-billed accruals (billed_at NOT NULL — the monthly sweep ran
// between submit and cancel) are left alone and logged: rare, small, and an
// admin adjustment beats automated ledger surgery.

import Stripe from 'stripe'
import { query, queryOne } from '../db'
import { logger } from '../lib/logger'

function isMockIntentId(id: string): boolean {
  return id.startsWith('pi_intake_mock_') || id.startsWith('pi_pool_mock_')
}

export interface RefundResult {
  refunded: boolean
  reason: string
  refundId?: string
}

export async function refundBackgroundCheckPayment(backgroundCheckId: string): Promise<RefundResult> {
  const check = await queryOne<{
    id: string
    applicant_payment_intent_id: string | null
    stripe_refund_id: string | null
    status: string
  }>(
    `SELECT id, applicant_payment_intent_id, stripe_refund_id, status
       FROM background_checks WHERE id = $1`,
    [backgroundCheckId]
  )
  if (!check) return { refunded: false, reason: 'check not found' }
  if (check.stripe_refund_id) return { refunded: false, reason: 'already refunded' }
  if (check.status === 'complete') return { refunded: false, reason: 'report was delivered — not refundable' }

  const pi = check.applicant_payment_intent_id
  if (!pi) {
    // Fee-prohibited state or no payment collected — nothing to refund,
    // but still void any unbilled accrual below.
    await voidUnbilledAccrual(check.id)
    return { refunded: false, reason: 'no payment to refund' }
  }
  if (isMockIntentId(pi)) {
    await voidUnbilledAccrual(check.id)
    return { refunded: false, reason: 'mock payment (dev) — nothing to refund' }
  }
  if (!process.env.STRIPE_SECRET_KEY) {
    return { refunded: false, reason: 'Stripe not configured' }
  }

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2023-10-16' })
  const refund = await stripe.refunds.create({ payment_intent: pi })
  await query(
    `UPDATE background_checks SET stripe_refund_id = $1, refunded_at = NOW() WHERE id = $2`,
    [refund.id, check.id]
  )
  await voidUnbilledAccrual(check.id)
  logger.info({ background_check_id: check.id, refund_id: refund.id }, '[BGC REFUND] applicant refunded')
  return { refunded: true, reason: 'refunded', refundId: refund.id }
}

// No report ⇒ no Checkr cost ⇒ the landlord owes neither the $5 compliance
// fee nor any shortfall. Delete only UNBILLED rows; billed ones are logged
// for manual adjustment (the sweep already posted them to revenue).
async function voidUnbilledAccrual(backgroundCheckId: string): Promise<void> {
  const del = await query<{ id: string }>(
    `DELETE FROM screening_fee_accruals
      WHERE background_check_id = $1 AND billed_at IS NULL
      RETURNING id`,
    [backgroundCheckId]
  )
  if (del.length === 0) {
    const billed = await queryOne<{ id: string }>(
      `SELECT id FROM screening_fee_accruals WHERE background_check_id = $1`,
      [backgroundCheckId]
    )
    if (billed) {
      logger.warn({ background_check_id: backgroundCheckId, accrual_id: billed.id },
        '[BGC REFUND] accrual already swept to revenue — needs manual adjustment')
    }
  }
}

// ── STALE-ORDER SWEEP ────────────────────────────────────────────────────
//
// Checkr Tenant has no order-cancel API and no order.canceled webhook, so
// staleness is OUR policy: a check stuck in awaiting_applicant (the
// applicant never finished Checkr's apply flow) for BGC_STALE_DAYS
// (default 30) is cancelled locally and the applicant refunded. If the
// applicant somehow completes the apply flow AFTER this window and a report
// arrives, the webhook still records it — the refund simply stands as
// goodwill (rare enough to accept; the window is generous).
export async function sweepStaleBackgroundChecks(): Promise<{ swept: number; refunded: number }> {
  const staleDays = parseInt(process.env.BGC_STALE_DAYS || '30', 10)
  const stale = await query<{ id: string }>(
    `SELECT id FROM background_checks
      WHERE status = 'awaiting_applicant'
        AND created_at < NOW() - make_interval(days => $1)`,
    [staleDays]
  )
  let refunded = 0
  for (const row of stale) {
    try {
      await query(`UPDATE background_checks SET status='cancelled' WHERE id=$1`, [row.id])
      await query(
        `UPDATE tenants SET background_check_status='cancelled' WHERE background_check_id=$1`,
        [row.id]
      )
      const r = await refundBackgroundCheckPayment(row.id)
      if (r.refunded) refunded++
    } catch (e) {
      logger.error({ err: e, background_check_id: row.id }, '[BGC STALE SWEEP] failed')
    }
  }
  return { swept: stale.length, refunded }
}
