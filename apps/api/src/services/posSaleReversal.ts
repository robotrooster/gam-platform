/**
 * S648 — a card dispute on a register sale.
 *
 * Register card sales (the counter reader and pay links) are charged on GAM's
 * account and paid to the landlord in the weekly batch, the same as rent. A
 * chargeback takes the money back out of GAM's balance, so — as with a rent
 * chargeback — it becomes a receivable the landlord owes back: the next payout
 * nets it, or a bank pull recovers it when nothing is coming
 * (services/reversalRecovery.ts decides which). GAM never absorbs a fee
 * (S512), and there is no tenant invoice to put Stripe's dispute fee on, so the
 * receivable is the disputed amount PLUS the dispute fee.
 */
import { query, queryOne } from '../db'
import { logger } from '../lib/logger'

// Stripe's standard card-dispute fee, used when the event doesn't carry it.
const DEFAULT_DISPUTE_FEE_CENTS = 1500

export async function handlePosSaleDispute(input: {
  paymentIntentId: string | null
  amountCents: number
  feeCents: number
  stripeEventId: string
  stripeDisputeId: string
  rawEvent: unknown
}): Promise<{ handled: boolean; reason?: string }> {
  if (!input.paymentIntentId) return { handled: false, reason: 'no payment intent' }
  const sale = await queryOne<{ id: string; landlord_id: string; tenant_id: string | null }>(
    `SELECT id, landlord_id, tenant_id FROM pos_transactions
      WHERE stripe_payment_intent_id = $1 AND payment_method = 'card'`,
    [input.paymentIntentId])
  if (!sale) return { handled: false, reason: 'not a register sale' }

  const feeCents = input.feeCents > 0 ? input.feeCents : DEFAULT_DISPUTE_FEE_CENTS
  const owedBack = (Math.max(0, input.amountCents) + feeCents) / 100
  // One receivable per Stripe event (webhooks are re-delivered).
  const rows = await query<{ id: string }>(
    `INSERT INTO payment_reversals
       (pos_transaction_id, landlord_id, tenant_id, reversal_type,
        reversed_amount, reversal_fee, stripe_event_id, stripe_object_id, raw_event)
     VALUES ($1, $2, $3, 'card_dispute', $4, $5, $6, $7, $8)
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [sale.id, sale.landlord_id, sale.tenant_id, owedBack, feeCents / 100,
     input.stripeEventId, input.stripeDisputeId, JSON.stringify(input.rawEvent ?? {})])
  if (!rows.length) return { handled: false, reason: 'already recorded' }
  logger.warn({ saleId: sale.id, landlordId: sale.landlord_id, owedBack, reversalId: rows[0].id },
    '[pos_dispute] register card sale disputed — landlord receivable opened')
  return { handled: true }
}
