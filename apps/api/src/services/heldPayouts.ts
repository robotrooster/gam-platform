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
  'business_pos_sale', 'refund', 'dispute', 'platform_fee', 'prepaid_draw',
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
  /** S650: stop once the running total would pass this (GAM's available funds). */
  capCents?: number,
): Promise<{ ids: string[]; totalCents: number }> {
  const col = 'landlordId' in payee ? 'landlord_id' : 'business_id'
  const id = 'landlordId' in payee ? payee.landlordId : payee.businessId
  const rows = (await client.query<{ id: string; amount: string }>(
    `SELECT id, amount::text AS amount FROM held_payout_items
      WHERE ${col} = $1 AND payout_intent_id IS NULL
      ORDER BY created_at ASC
      FOR UPDATE`, [id])).rows
  const ids: string[] = []
  let totalCents = 0
  for (const r of rows) {
    const c = Math.round(parseFloat(r.amount) * 100)
    if (capCents != null && totalCents + c > capCents) break   // oldest first; the rest waits
    ids.push(r.id)
    totalCents += c
  }
  return { ids, totalCents }
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
 *
 * Step 10 final fix (decisions #55): only money Stripe took is netted. A
 * bank's INQUIRY (warning_*) takes nothing, so it nets nobody; the event that
 * turns it into a dispute (charge.dispute.updated / funds_withdrawn / closed
 * 'lost') nets it then, once (one line per Stripe dispute). A dispute GAM WON
 * gives the payee back what the chargeback took off their payout — the
 * disputed amount, plus Stripe's dispute fee when Stripe gave that back too —
 * on the line stripeCosts reads for it (wonChargebackReturnSourceId), once.
 */
export async function recordChargeback(input: {
  paymentIntentId: string | null
  amountCents: number
  feeCents: number
  stripeDisputeId: string
  /**
   * The dispute's status at this event. Left out (older callers), money is
   * taken. An inquiry or any status under which Stripe holds no money nets
   * nobody; 'won' gives a chargeback back.
   */
  disputeStatus?: string | null
  /** 'won' only: cents of Stripe's dispute fee Stripe gave back (stripeCosts.disputeFeeReturnedOnWinCents). */
  feeReturnedCents?: number
}): Promise<{ handled: boolean; reason?: string }> {
  if (!input.paymentIntentId) return { handled: false, reason: 'no payment intent' }
  const pi = input.paymentIntentId
  const { DISPUTE_STATUSES_MONEY_TAKEN, DISPUTE_STATUS_WON } = await import('./creditUse')
  const status = input.disputeStatus ?? null
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

  // Fix pass 2 (review): the decision and its line are one step per dispute
  // (a lock on the dispute id). Stripe does not deliver events in order: a
  // stale event that says money is taken, handled at the same moment as the
  // win, reads the dispute on file under the lock — once it says 'won' (or
  // any status under which Stripe holds no money) it nets nobody. A win is not
  // given back here in this deploy (decisions #55-AMENDED): the webhook raises
  // paymentReversal.raiseWonDisputeNotice, which waits on this same lock and
  // lists the chargeback line to give back by hand. The 'won' branch below is
  // kept for the automatic follow-up and is reached only by tests today.
  const client = await getClient()
  try {
    await client.query('BEGIN')
    await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`chargeback:${input.stripeDisputeId}`])
    const onFile = (await client.query<{ status: string }>(
      `SELECT status FROM connect_disputes WHERE stripe_dispute_id = $1`, [input.stripeDisputeId])).rows[0]?.status ?? null
    const r = await chargebackUnderLock(client, input, pi, payee, status, onFile, { DISPUTE_STATUSES_MONEY_TAKEN, DISPUTE_STATUS_WON })
    await client.query('COMMIT')
    return r
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    client.release()
  }
}

async function chargebackUnderLock(
  client: PoolClient,
  input: { amountCents: number; feeCents: number; stripeDisputeId: string; feeReturnedCents?: number },
  pi: string,
  payee: { landlord_id: string | null; business_id: string | null; what: string },
  status: string | null,
  onFile: string | null,
  c: { DISPUTE_STATUSES_MONEY_TAKEN: readonly string[]; DISPUTE_STATUS_WON: string },
): Promise<{ handled: boolean; reason?: string }> {
  if (status === c.DISPUTE_STATUS_WON) {
    // What the chargeback took off their payout (none: nothing to give back).
    const taken = (await client.query<{ amount: string }>(
      `SELECT (-amount)::text AS amount FROM held_payout_items WHERE source_type = 'dispute' AND source_id = $1 AND amount < 0`,
      [input.stripeDisputeId])).rows[0]
    if (!taken) return { handled: false, reason: 'nothing was charged back' }
    const takenCents = Math.round(parseFloat(taken.amount) * 100)
    const backCents = Math.min(takenCents, Math.max(0, input.amountCents) + Math.max(0, input.feeReturnedCents ?? 0))
    if (backCents <= 0) return { handled: false, reason: 'nothing to give back' }
    const { wonChargebackReturnSourceId } = await import('./stripeCosts')
    const recorded = await recordHeldItem({
      landlordId: payee.landlord_id, businessId: payee.business_id,
      sourceType: 'dispute', sourceId: wonChargebackReturnSourceId(input.stripeDisputeId),
      amount: backCents / 100,
      description: `Chargeback on a ${payee.what} given back: the card company decided the dispute for us`,
    }, client)
    if (!recorded) return { handled: false, reason: 'already given back' }
    logger.info({ ...payee, pi, backCents }, '[chargeback] dispute won — the chargeback is given back on the next payout')
    return { handled: true }
  }
  if (status != null && !c.DISPUTE_STATUSES_MONEY_TAKEN.includes(status)) {
    return { handled: false, reason: 'no money taken' }
  }
  // The dispute on file holds no money now (won while this event was on its way, or still an inquiry): nobody is netted.
  if (onFile != null && !c.DISPUTE_STATUSES_MONEY_TAKEN.includes(onFile)) {
    return { handled: false, reason: 'no money taken' }
  }

  const feeCents = input.feeCents > 0 ? input.feeCents : 1500
  const owedBack = (Math.max(0, input.amountCents) + feeCents) / 100
  const recorded = await recordHeldItem({
    landlordId: payee.landlord_id, businessId: payee.business_id,
    sourceType: 'dispute', sourceId: input.stripeDisputeId,
    amount: -owedBack, description: `Chargeback on a ${payee.what} (includes Stripe's dispute fee)`,
  }, client)
  if (!recorded) return { handled: false, reason: 'already recorded' }
  logger.warn({ ...payee, pi, owedBack }, '[chargeback] held charge disputed — nets against the next payout')
  return { handled: true }
}
