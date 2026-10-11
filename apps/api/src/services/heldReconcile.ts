/**
 * S648 — the daily check behind "every cent flows through GAM".
 *
 * 1. A charge GAM took with nothing recorded against it. Every non-rent
 *    charge writes its record (a sale, a paid deposit, an invoice payment) in
 *    the same step that takes the money, but a crash in the instant between
 *    Stripe capturing and our database committing would leave money on GAM's
 *    balance that no payout knows about. This finds those and tells an admin.
 *
 * 2. A payee who owes GAM more than GAM holds for them (a chargeback or refund
 *    bigger than their incoming money) and has for two weeks. It nets
 *    automatically the moment money comes in; until then GAM is floating it,
 *    so an admin is told.
 */
import type Stripe from 'stripe'
import { query, queryOne } from '../db'
import { getStripe } from '../lib/stripe'
import { createAdminNotification } from './adminNotifications'
import { logger } from '../lib/logger'

// What records each kind of charge. Rent has its own reconciliation.
const RECORD_FOR: Record<string, string> = {
  pos_terminal:          `SELECT 1 FROM pos_transactions WHERE stripe_payment_intent_id = $1`,
  pos_pay_link:          `SELECT 1 FROM pos_transactions WHERE stripe_payment_intent_id = $1`,
  booking_deposit:       `SELECT 1 FROM unit_bookings WHERE stripe_payment_intent_id = $1`,
  business_invoice:      `SELECT 1 FROM business_invoice_payments WHERE stripe_payment_intent_id = $1`,
  business_pos_terminal: `SELECT 1 FROM business_pos_transactions WHERE stripe_payment_intent_id = $1`,
}

const LOOKBACK_DAYS = 3
// Leave room for the webhook and the register to finish.
const GRACE_MINUTES = 60
const FLOAT_ALERT_DAYS = 14

export async function findUnrecordedCharges(now: Date = new Date()): Promise<string[]> {
  const stripe = getStripe()
  const gte = Math.floor(now.getTime() / 1000) - LOOKBACK_DAYS * 86400
  const cutoff = Math.floor(now.getTime() / 1000) - GRACE_MINUTES * 60
  const missing: string[] = []
  await stripe.paymentIntents.list({ created: { gte }, limit: 100 })
    .autoPagingEach(async (pi: Stripe.PaymentIntent) => {
      const sql = RECORD_FOR[pi.metadata?.gam_purpose ?? '']
      if (!sql || pi.status !== 'succeeded' || pi.created > cutoff) return
      if (await queryOne(sql, [pi.id])) return
      missing.push(pi.id)
      const already = await queryOne(
        `SELECT 1 FROM admin_notifications
          WHERE category = 'held_charge_unrecorded' AND context->>'payment_intent' = $1`, [pi.id])
      if (already) return
      await createAdminNotification({
        severity: 'critical',
        category: 'held_charge_unrecorded',
        title: `A $${(pi.amount / 100).toFixed(2)} card charge has no ${pi.metadata.gam_purpose.replace(/_/g, ' ')} recorded`,
        body: 'GAM holds this money but nothing will pay it out. Find the sale/booking/invoice it belongs to and record it, or refund it.',
        context: { payment_intent: pi.id, purpose: pi.metadata.gam_purpose, metadata: pi.metadata },
      })
    })
  return missing
}

export async function findFloatedBalances(): Promise<Array<{ landlordId: string | null; businessId: string | null; owedBack: number }>> {
  const rows = await query<{ landlord_id: string | null; business_id: string | null; total: string }>(
    `SELECT landlord_id, business_id, SUM(amount)::text AS total
       FROM held_payout_items
      WHERE payout_intent_id IS NULL
      GROUP BY landlord_id, business_id
     HAVING SUM(amount) < 0
        AND MIN(created_at) FILTER (WHERE amount < 0) < NOW() - make_interval(days => $1)`,
    [FLOAT_ALERT_DAYS])
  const out = rows.map(r => ({ landlordId: r.landlord_id, businessId: r.business_id, owedBack: -Number(r.total) }))
  for (const r of out) {
    const key = r.landlordId ?? r.businessId
    const recent = await queryOne(
      `SELECT 1 FROM admin_notifications
        WHERE category = 'held_balance_negative' AND context->>'payee' = $1
          AND created_at > NOW() - INTERVAL '7 days'`, [key])
    if (recent) continue
    await createAdminNotification({
      severity: 'warn',
      category: 'held_balance_negative',
      title: `A ${r.landlordId ? 'landlord' : 'business'} has owed back $${r.owedBack.toFixed(2)} for over ${FLOAT_ALERT_DAYS} days`,
      body: 'Chargebacks or refunds exceed the money coming in for them. It nets automatically from their next incoming payment; until then GAM is covering it.',
      context: { payee: key, landlord_id: r.landlordId, business_id: r.businessId, owed_back: r.owedBack },
    })
  }
  return out
}

export async function runHeldReconcile(now: Date = new Date()): Promise<{ unrecorded: number; floated: number }> {
  let unrecorded = 0
  try { unrecorded = (await findUnrecordedCharges(now)).length }
  catch (e) { logger.error({ err: e }, '[held-reconcile] Stripe scan failed') }
  const floated = (await findFloatedBalances()).length
  return { unrecorded, floated }
}
