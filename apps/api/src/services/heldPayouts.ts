/**
 * S648 (Nic): "money all needs to flow through the platform. Every single
 * cent... so that it can be batched and paid out accordingly. We are gonna hold
 * all funds even if briefly."
 *
 * Every charge GAM takes lands on GAM's own Stripe balance. What GAM then owes
 * a landlord or a business — outside rent, which keeps its owner-share ledger —
 * is written here as a held item, and the weekly payout pays the sum:
 *
 *   landlords  → services/landlordPassthrough.ts adds these to their rent batch
 *   businesses → reconcileBusinessHeldFunds below, run by jobs/autoPayouts.ts
 *
 * A negative item (a refund GAM sent, a chargeback, a GAM fee) nets in the same
 * batch. When a payee's total is zero or less nothing moves and everything
 * carries to the next run.
 */
import type { PoolClient } from 'pg'
import { query, queryOne, getClient } from '../db'
import { processingFeeFor } from '@gam/shared'
import { logger } from '../lib/logger'

export const HELD_ITEM_SOURCES = [
  'pos_sale', 'booking_deposit', 'business_invoice_payment',
  'business_pos_sale', 'refund', 'dispute', 'platform_fee',
] as const
export type HeldItemSource = typeof HELD_ITEM_SOURCES[number]

export interface HeldItem {
  landlordId?: string | null
  businessId?: string | null
  sourceType: HeldItemSource
  sourceId: string
  amount: number
  description?: string
}

type Runner = Pick<PoolClient, 'query'>

// S649 (Nic): "Card fees are the same platform wide, no matter where they pay,
// no matter who's paying it." A business pays GAM the same processing fee as
// everyone else: 3.5% + $0.55 on a card, the flat $6 on a bank payment.

/** GAM's cut of a business invoice paid online. */
export function businessInvoiceCutCents(amountCents: number, paidByBank = false): number {
  return Math.round(processingFeeFor({ amount: amountCents / 100, paymentMethod: paidByBank ? 'ach' : 'card' }) * 100)
}

/** GAM's cut of a business register card sale. */
export function businessTerminalCutCents(amountCents: number): number {
  return Math.round(processingFeeFor({ amount: amountCents / 100, paymentMethod: 'card' }) * 100)
}

/**
 * Write what GAM now holds for someone. One item per source (Stripe re-delivers
 * webhooks); returns false when this source was already recorded.
 */
export async function recordHeldItem(item: HeldItem, runner?: Runner): Promise<boolean> {
  const amount = Math.round(item.amount * 100) / 100
  if (amount === 0) return false
  if (!item.landlordId === !item.businessId) throw new Error('A held item has exactly one payee')
  const sql = `INSERT INTO held_payout_items (landlord_id, business_id, source_type, source_id, amount, description)
               VALUES ($1, $2, $3, $4, $5, $6)
               ON CONFLICT (source_type, source_id) DO NOTHING
               RETURNING id`
  const params = [item.landlordId ?? null, item.businessId ?? null, item.sourceType, item.sourceId, amount, item.description ?? null]
  const rows = runner ? (await runner.query(sql, params)).rows : await query(sql, params)
  return rows.length > 0
}

/** Held, unbatched items for one payee, locked for a batch transaction. */
export async function lockHeldItems(
  client: PoolClient, payee: { landlordId: string } | { businessId: string },
): Promise<{ ids: string[]; totalCents: number }> {
  const col = 'landlordId' in payee ? 'landlord_id' : 'business_id'
  const id = 'landlordId' in payee ? payee.landlordId : payee.businessId
  const rows = (await client.query<{ id: string; amount: string }>(
    `SELECT id, amount::text AS amount FROM held_payout_items
      WHERE ${col} = $1 AND payout_intent_id IS NULL
      FOR UPDATE`, [id])).rows
  return {
    ids: rows.map(r => r.id),
    totalCents: rows.reduce((a, r) => a + Math.round(parseFloat(r.amount) * 100), 0),
  }
}

export async function stampHeldItems(client: PoolClient, ids: string[], intentId: string): Promise<void> {
  if (!ids.length) return
  await client.query(`UPDATE held_payout_items SET payout_intent_id = $1 WHERE id = ANY($2::uuid[])`, [intentId, ids])
}

/** Display: what GAM holds for a business right now, before any netting. */
export async function heldForBusiness(businessId: string): Promise<number> {
  const r = await queryOne<{ s: string }>(
    `SELECT COALESCE(SUM(amount), 0)::text AS s FROM held_payout_items
      WHERE business_id = $1 AND payout_intent_id IS NULL`, [businessId])
  return Math.round(parseFloat(r?.s ?? '0') * 100) / 100
}

/**
 * The weekly batch for one business: claim its held items (fees already netted
 * in as negative items by the fee job), and
 * pay the total to its payout account through the same durable transfer-intent
 * path landlords use (retry-safe, never double-pays).
 */
export async function reconcileBusinessHeldFunds(businessId: string): Promise<{ intentId: string | null; amount: number }> {
  const biz = await queryOne<{ stripe_connect_account_id: string | null }>(
    `SELECT stripe_connect_account_id FROM businesses WHERE id = $1`, [businessId])
  if (!biz?.stripe_connect_account_id) return { intentId: null, amount: 0 }

  const client = await getClient()
  let intentId: string
  let amountCents: number
  try {
    await client.query('BEGIN')
    await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`business_held_reconcile:${businessId}`])
    const held = await lockHeldItems(client, { businessId })
    amountCents = held.totalCents
    if (amountCents <= 0) { await client.query('ROLLBACK'); return { intentId: null, amount: 0 } }
    const row = await client.query<{ id: string }>(
      `INSERT INTO platform_transfer_intents
         (business_id, destination_connect_account_id, amount, gross_owed, netted_amount, status, payments_settled)
       VALUES ($1, $2, $3, $3, 0, 'pending', $4) RETURNING id`,
      [businessId, biz.stripe_connect_account_id, amountCents / 100, held.ids.length])
    intentId = row.rows[0].id
    await stampHeldItems(client, held.ids, intentId)
    await client.query('COMMIT')
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    client.release()
  }
  const { executePlatformTransferIntent } = await import('./landlordPassthrough')
  const tid = await executePlatformTransferIntent(intentId)
  if (!tid) logger.warn({ businessId, intentId }, '[business_held] transfer pending — recovery will retry')
  return { intentId, amount: amountCents / 100 }
}

/**
 * A chargeback on any held-then-paid-out charge (register sale, booking
 * deposit, business invoice or register sale). There is no customer to bill,
 * so the payee owes back the disputed amount plus Stripe's fee (GAM absorbs
 * nothing, S512). It nets against their next payout.
 */
export async function recordChargeback(input: {
  paymentIntentId: string | null
  amountCents: number
  feeCents: number
  stripeDisputeId: string
}): Promise<{ handled: boolean; reason?: string }> {
  if (!input.paymentIntentId) return { handled: false, reason: 'no payment intent' }
  const pi = input.paymentIntentId
  const payee = await queryOne<{ landlord_id: string | null; business_id: string | null; what: string }>(
    `SELECT landlord_id, NULL::uuid AS business_id, 'register sale' AS what
       FROM pos_transactions WHERE stripe_payment_intent_id = $1
     UNION ALL
     SELECT landlord_id, NULL, 'stay deposit' FROM unit_bookings WHERE stripe_payment_intent_id = $1
     UNION ALL
     SELECT NULL, business_id, 'invoice payment' FROM business_invoice_payments WHERE stripe_payment_intent_id = $1
     UNION ALL
     SELECT NULL, business_id, 'invoice payment' FROM business_invoices WHERE stripe_payment_intent_id = $1
     UNION ALL
     SELECT NULL, business_id, 'register sale' FROM business_pos_transactions WHERE stripe_payment_intent_id = $1
     LIMIT 1`, [pi])
  if (!payee) return { handled: false, reason: 'not a held charge' }
  const feeCents = input.feeCents > 0 ? input.feeCents : 1500
  const owedBack = (Math.max(0, input.amountCents) + feeCents) / 100
  const recorded = await recordHeldItem({
    landlordId: payee.landlord_id, businessId: payee.business_id,
    sourceType: 'dispute', sourceId: input.stripeDisputeId,
    amount: -owedBack, description: `Chargeback on a ${payee.what} (includes Stripe's dispute fee)`,
  })
  if (!recorded) return { handled: false, reason: 'already recorded' }
  logger.warn({ ...payee, pi, owedBack }, '[chargeback] held charge disputed — nets against the next payout')
  return { handled: true }
}
