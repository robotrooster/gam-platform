/**
 * The last resort: pulling GAM's fees out of a landlord's bank account.
 *
 * Everything in landlordGamAccount.ts exists so this file almost never runs.
 * GAM's fees come out of money already moving to the landlord; a bank debit is
 * an extra money movement, and Nic's standing position is that extra movements
 * are waste. But an ALL-CASH property moves no money through the platform, so
 * there is nothing to net against and the balance only grows. That is the one
 * case this covers.
 *
 * Nic (S650): "Never ACH-debit a landlord by default — take it out of the money
 * flowing through. When the debit is built for all-cash properties, the bank
 * cost is its own line item so the landlord doesn't dispute the charge."
 *
 * "BY DEFAULT" MEANS NOT AS THE FIRST RESORT. It does not mean the landlord
 * gets to decline. Nic, on an earlier draft of this file that had a consent
 * toggle on it: "That's not a landlord choice to fucking pay us. It's
 * mandatory. If there's no electronic charges to debit against, then when it
 * hits the threshold, we debit from their account that they have linked."
 *
 * Which is obviously right. The fee is owed for running the park, however the
 * rent arrived. Netting is preferred because it moves no extra money — a cost
 * preference, not a permission structure — and a landlord who could switch off
 * the only remaining route could simply never pay at all. The landlord agreed
 * to be billed when they signed up. That is the authorization, and it is not
 * re-asked per pull.
 *
 * TWO GATES, both of which must be open:
 *   1. The balance is at or over the property threshold. Below it, the debt
 *      waits — carrying $20 to next month is cheaper than a bank pull.
 *   2. Netting had its chance first. This runs on its own schedule, after the
 *      passthrough batch, so anything collectable from a payout already was.
 *
 * A landlord with no usable bank link cannot be debited. That is a COLLECTION
 * FAILURE, not an exemption: it alerts, and the debt stays owed.
 *
 * WHAT THE LANDLORD SEES, and why it is two numbers. Mountain View's September
 * platform fee was $82 (41 spots) — one landlord, one company, one park:
 *   Platform fee — September    $82.00
 *   Bank transfer cost          $ 6.00
 * rather than one $88.00 they can't reconcile against anything. The cost is a
 * real landlord_gam_charges row (kind 'bank_debit_cost') so it lands in the
 * same statement as everything else, gets collected the same way, and shows up
 * in the same total. A number a landlord can argue with is a number they don't
 * phone their bank about.
 */

import type Stripe from 'stripe'
import type { PoolClient } from 'pg'
import { createHash } from 'crypto'
import { getStripe } from '../lib/stripe'
import { getClient, query, queryOne } from '../db'
import { logger } from '../lib/logger'
import { isDefiniteStripeRefusal } from '../lib/stripeRefusal'
import {
  chargeLandlord, outstandingForLandlord, debitThresholdForLandlord,
  GAM_CHARGE_OWED_SQL, gamAccountLockKey, voidGamCharge, recordGamChargeCollections,
} from './landlordGamAccount'
import type { LandlordGamChargeVoidReason } from '@gam/shared'
import { recordPlatformRevenue } from './platformRevenue'
// GAM has ONE ACH price — $6 flat — and a fee debit is not allowed to invent a
// second one. See ACH_DEBIT_FLAT below.
import { PROCESSING_FEES } from '@gam/shared'

/**
 * An ACH transfer costs $6 flat. GAM has exactly one ACH price and this is it.
 *
 * $6 flat at any amount — no percentage, no cap, no second answer depending on
 * the size of the transfer. It is the only bank number anyone at GAM states, on
 * rent and here alike, and a fee debit is not allowed to invent a different
 * one: a landlord reading some other figure beside the $6 on their own tenant's
 * rent would be right to ask which of the two was the lie.
 *
 * Read from the shared schedule rather than copied, so a reprice carries this
 * with it instead of leaving it behind. Do not replace this with a processor's
 * published rate card; GAM's schedule is the schedule.
 * (memory: gam-ach-fee-schedule-untouchable)
 *
 * NOTE THE PROPORTION, because it is the argument for the threshold: $6 against
 * Oak Park's $48 September fee is 12.5%. Collecting little and often by bank
 * transfer is expensive for the landlord, which is exactly why the debt waits
 * below the threshold and why netting is always tried first.
 */
export const ACH_DEBIT_FLAT = PROCESSING_FEES.ACH_FLAT

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** What the transfer itself costs. Flat, at any amount. */
export function bankCostFor(amount: number): number {
  if (amount <= 0) return 0
  return ACH_DEBIT_FLAT
}

export interface DebitOutcome {
  status: 'debited' | 'skipped'
  reason?:
    | 'under_threshold'
    | 'nothing_owed'
    | 'debit_in_flight'
    /** no usable bank link — the debt stays owed and this alerts */
    | 'no_bank_link'
    | 'stripe_failed'
  /** S652: WHY the link is unusable, in words a person can act on. */
  detail?: string
  debitId?: string
  chargesAmount?: number
  bankCost?: number
  total?: number
  error?: string
}

interface LandlordDebitRow {
  id: string
  business_name: string | null
  gam_debit_payment_method_id: string | null
  stripe_fc_customer_id: string | null
}

/** 10/12 (ledger P0 review): the idempotency key of one pull — the same on every ask. */
export const debitIdempotencyKey = (debitId: string): string => `gam_debit_${debitId}`

/**
 * The Stripe request for one pull. One definition, so asking again under the
 * same key (resumeUnconfirmedDebit) sends exactly what the first ask sent:
 * Stripe refuses a key reused with other parameters.
 */
function debitIntentRequest(d: {
  debitId: string; landlordId: string; customerId: string; paymentMethodId: string
  total: number; chargesAmount: number; bankCost: number
}): Stripe.PaymentIntentCreateParams {
  return {
    amount: Math.round(d.total * 100),
    currency: 'usd',
    customer: d.customerId,
    payment_method: d.paymentMethodId,
    payment_method_types: ['us_bank_account'],
    confirm: true,
    off_session: true,
    // S652 (Nic): linking the bank IS the authorization — "when they link a
    // bank, they're authorizing debits and payouts." Stripe needs that said on
    // the debit itself or it refuses ("requires a mandate"). Offline
    // acceptance, dated when the link was made.
    mandate_data: { customer_acceptance: { type: 'offline' } },
    // NACHA company-entry description — 8 chars, what prints on their
    // statement. A landlord reading "GAMFEES" knows what it is without
    // phoning anyone, which is the whole objective here.
    statement_descriptor: 'GAM FEES',
    description: `GAM charges + bank cost - Gold Asset Management`,
    metadata: {
      gam_debit_id: d.debitId,
      landlord_id: d.landlordId,
      charges_amount: d.chargesAmount.toFixed(2),
      bank_cost_amount: d.bankCost.toFixed(2),
      entry_description: 'GAMFEES',
    },
  } as Stripe.PaymentIntentCreateParams
}

/**
 * Stripe refused the pull outright: it never happened. The pull is marked
 * failed and the charges stay owed — but not the cost line, which is a debt
 * raised for a pull that never happened. Reverse it rather than dunning
 * somebody for the price of a transfer that did not occur.
 * 10/12 (Nic, ledger P0): VOIDED and kept (keep-everything), and by its own
 * id. It was a DELETE of any uncollected cost line raised in the last ten
 * minutes, which erased the record and could reach another pull's line.
 */
async function markPullRefused(
  debitId: string, landlordId: string, costChargeId: string | null, msg: string,
  /** 10/12 (G1): the PaymentIntent the refusal names, when Stripe made one and failed it. */
  refusedIntentId: string | null = null,
): Promise<void> {
  await query(
    `UPDATE landlord_gam_debits
        SET status = 'failed', failure_reason = $2, settled_at = NOW(), updated_at = NOW(),
            stripe_payment_intent_id = COALESCE(stripe_payment_intent_id, $3)
      WHERE id = $1 AND status = 'pending'`,
    [debitId, msg.slice(0, 500), refusedIntentId])
  if (costChargeId) {
    await voidGamCharge(null, costChargeId, 'bank_debit_not_made').catch((err) => {
      logger.error({ err, landlordId, debitId, costChargeId }, '[gam-debit] could not void the cost line of a pull that never happened')
    })
  }
  logger.error({ landlordId, debitId, err: msg }, '[gam-debit] the pull failed')
  // 10/12 (Nic, G1): "gam eats no fees of failed pulls ever." A refusal Stripe
  // answered with a failed PaymentIntent can still have cost GAM a fee;
  // whatever it cost is the landlord's, at cost. No intent: nothing was made,
  // and nothing cost anything.
  await billFailedPullCost(debitId, refusedIntentId, null)
}

/** The PaymentIntent a Stripe refusal names (a confirm Stripe made and failed carries it). */
function intentOfRefusal(e: unknown): string | null {
  const err = e as { payment_intent?: { id?: unknown }; raw?: { payment_intent?: { id?: unknown } } } | null
  const id = err?.payment_intent?.id ?? err?.raw?.payment_intent?.id
  return typeof id === 'string' && id.startsWith('pi_') ? id : null
}

/**
 * 10/12 (Nic, G1) — WHAT A FAILED PULL ACTUALLY COST GAM, read from Stripe.
 *
 * The debit's own fee (the charge's balance transaction) and the failure fee
 * (its failure balance transaction — the reversal Stripe books when the bank
 * sends the debit back, which carries the return fee), netted: a fee Stripe
 * gave back on the failure lowers it. In cents, never below zero. A pull that
 * never reached a charge cost nothing. Throws when Stripe cannot be read — the
 * caller leaves the cost unread and the nightly sweep asks again.
 */
export async function failedPullCostCents(
  stripe: { paymentIntents: { retrieve: (id: string, params?: any) => Promise<any> } },
  paymentIntentId: string,
): Promise<number> {
  const pi = await stripe.paymentIntents.retrieve(paymentIntentId, {
    expand: ['latest_charge.balance_transaction', 'latest_charge.failure_balance_transaction'],
  })
  const ch = pi?.latest_charge
  if (!ch) return 0
  if (typeof ch === 'string') throw new Error(`Stripe did not expand the charge on ${paymentIntentId}`)
  const feeOf = (t: any): number => {
    if (!t) return 0
    if (typeof t === 'string') throw new Error(`Stripe did not expand balance transaction ${t} on ${paymentIntentId}`)
    return Number(t.fee) || 0
  }
  return Math.max(0, Math.round(feeOf(ch.balance_transaction) + feeOf(ch.failure_balance_transaction)))
}

/**
 * 10/12 (Nic, G1): "gam eats no fees of failed pulls ever" — whatever a failed
 * or returned bank pull of GAM's fees actually cost GAM is owed by the
 * landlord, on the spot or on a later return alike.
 *
 *   - The pull's own $6 cost line (GAM's price for a transfer that collects)
 *     is taken back when the pull failed after it was made (`voidReason`
 *     'bank_debit_failed'); a pull Stripe refused outright already voided it
 *     ('bank_debit_not_made', markPullRefused). Voided, never deleted.
 *   - What Stripe actually charged for the failed pull (failedPullCostCents)
 *     is billed as its own GAM charge, kind 'bank_debit_failed_cost', at cost,
 *     collected like every other GAM charge (from the next payout, or the
 *     next pull once it is over the threshold). Idempotent per pull (its
 *     source is the pull), and recorded on the pull (failure_cost_*).
 *   - Stripe unreadable: nothing is billed yet and the pull's cost stays
 *     unread; the nightly sweep (readFailedPullCosts) asks again.
 *
 * Never throws: the failure itself is already recorded.
 */
export async function billFailedPullCost(
  debitId: string, paymentIntentId: string | null, voidReason: LandlordGamChargeVoidReason | null,
): Promise<{ read: boolean; costCents: number | null; chargeId: string | null }> {
  try {
    const d = await queryOne<{ landlord_id: string; created_at: Date; charge_ids: string[] | null; failure_cost_read_at: Date | null; status: string }>(
      `SELECT landlord_id, created_at, charge_ids, failure_cost_read_at, status FROM landlord_gam_debits WHERE id = $1`, [debitId])
    if (!d || d.status !== 'failed') return { read: false, costCents: null, chargeId: null }
    if (voidReason) {
      // The pull's own cost line: written in the pull's own transaction, so it
      // shares the pull's created_at (NOW() is the transaction's clock). An
      // older cost line this pull also claimed stays owed — it was never this
      // pull's.
      // (Compared in SQL: a timestamp read into JavaScript loses its microseconds.)
      const own = await queryOne<{ id: string }>(
        `SELECT c.id FROM landlord_gam_charges c
          WHERE c.id = ANY ((SELECT charge_ids FROM landlord_gam_debits WHERE id = $1)::uuid[])
            AND c.kind = 'bank_debit_cost'
            AND c.created_at = (SELECT created_at FROM landlord_gam_debits WHERE id = $1)
          LIMIT 1`, [debitId])
      if (own) {
        await voidGamCharge(null, own.id, voidReason).catch((err) => {
          logger.error({ err, debitId, chargeId: own.id }, '[gam-debit] could not void the cost line of a pull that failed')
        })
      }
    }
    if (d.failure_cost_read_at) return { read: true, costCents: null, chargeId: null }

    let costCents = 0
    if (paymentIntentId) {
      try {
        costCents = await failedPullCostCents(getStripe(), paymentIntentId)
      } catch (err) {
        logger.warn({ err, debitId, paymentIntentId }, '[gam-debit] what the failed pull cost could not be read from Stripe — asked again next sweep')
        return { read: false, costCents: null, chargeId: null }
      }
    }

    const client = await getClient()
    try {
      await client.query('BEGIN')
      await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [gamAccountLockKey(d.landlord_id)])
      const still = await client.query(
        `SELECT 1 FROM landlord_gam_debits WHERE id = $1 AND failure_cost_read_at IS NULL FOR UPDATE`, [debitId])
      if (!still.rows.length) { await client.query('ROLLBACK'); return { read: true, costCents, chargeId: null } }
      let chargeId: string | null = null
      if (costCents > 0) {
        const day = new Date(d.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'America/Phoenix' })
        chargeId = await chargeLandlord(client, {
          landlordId: d.landlord_id,
          kind: 'bank_debit_failed_cost',
          amount: costCents / 100,
          sourceType: 'gam_bank_debit_failed',
          sourceId: debitId,
          notes: `What Stripe charged for the ${day} bank transfer of GAM's fees that did not go through, passed on at cost`,
        })
        chargeId ??= (await client.query<{ id: string }>(
          `SELECT id FROM landlord_gam_charges WHERE source_type = 'gam_bank_debit_failed' AND source_id = $1`, [debitId])).rows[0]?.id ?? null
      }
      await client.query(
        `UPDATE landlord_gam_debits
            SET failure_cost_amount = $2, failure_cost_charge_id = $3, failure_cost_read_at = NOW(), updated_at = NOW()
          WHERE id = $1`,
        [debitId, (costCents / 100).toFixed(2), chargeId])
      await client.query('COMMIT')
      if (costCents > 0) {
        logger.warn({ debitId, landlordId: d.landlord_id, cost: costCents / 100 },
          '[gam-debit] a failed pull cost GAM a fee — billed to the landlord at cost')
      }
      return { read: true, costCents, chargeId }
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {})
      throw e
    } finally {
      client.release()
    }
  } catch (err) {
    logger.error({ err, debitId }, '[gam-debit] the cost of a failed pull could not be billed — asked again next sweep')
    return { read: false, costCents: null, chargeId: null }
  }
}

/** A failed pull whose cost is still unread after this many days tells an admin. */
export const FAILED_PULL_COST_UNREAD_DAYS = 3

/**
 * 10/12 (G1): the nightly sweep's pass over failed pulls whose cost was never
 * read (Stripe could not be reached when they failed): read and bill it now.
 * Pulls that failed in the last 60 days; one still unread after
 * FAILED_PULL_COST_UNREAD_DAYS raises an admin notice (once per pull) — a
 * cost nobody reads is a cost GAM absorbs.
 */
export async function readFailedPullCosts(): Promise<{ considered: number; read: number }> {
  const rows = await query<{ id: string; landlord_id: string; stripe_payment_intent_id: string; settled_at: Date | null; total_amount: string }>(
    `SELECT id, landlord_id, stripe_payment_intent_id, settled_at, total_amount::text AS total_amount
       FROM landlord_gam_debits
      WHERE status = 'failed' AND failure_cost_read_at IS NULL AND stripe_payment_intent_id IS NOT NULL
        AND COALESCE(settled_at, updated_at) > NOW() - INTERVAL '60 days'
      ORDER BY created_at`)
  let read = 0
  for (const r of rows) {
    const out = await billFailedPullCost(r.id, r.stripe_payment_intent_id, null)
    if (out.read) { read++; continue }
    const age = Date.now() - new Date(r.settled_at ?? Date.now()).getTime()
    if (age < FAILED_PULL_COST_UNREAD_DAYS * 86_400_000) continue
    const told = await queryOne<{ x: number }>(
      `SELECT 1 AS x FROM admin_notifications WHERE category = 'gam_debit_failed_cost_unread' AND context->>'debit_id' = $1 LIMIT 1`, [r.id])
    if (told) continue
    const { createAdminNotification } = await import('./adminNotifications')
    await createAdminNotification({
      severity: 'warn',
      category: 'gam_debit_failed_cost_unread',
      title: `What a failed $${Number(r.total_amount).toFixed(2)} bank pull of GAM's fees cost has not been read from Stripe`,
      body: `Pull ${r.id} (payment ${r.stripe_payment_intent_id}) failed, and Stripe's fees on it could not be read, so the landlord has not been billed for them. ` +
        'Check the payment in Stripe; the nightly sweep keeps asking.',
      context: { debit_id: r.id, landlord_id: r.landlord_id, payment_intent_id: r.stripe_payment_intent_id },
    }).catch(() => {})
  }
  return { considered: rows.length, read }
}

/** A pull still pending, as resumeUnconfirmedDebit reads it. */
interface UnconfirmedDebitRow {
  id: string
  landlord_id: string
  charges_amount: string
  bank_cost_amount: string
  total_amount: string
  payment_method_id: string | null
  created_at: Date
}

/**
 * 10/12 (Nic, ledger P0 review) — a pull GAM recorded but never heard back
 * about (the create timed out, Stripe errored, or the payment id could not be
 * stamped), so it carries no payment id. Left alone it would sit pending for
 * good: its charges are skipped by netting (they are inside a pull) and the
 * portal lock would count them against a landlord who may have paid.
 *
 * The nightly sweep asks Stripe about it once more:
 *   - a pull Stripe made for it (found by the id in its metadata) is stamped,
 *     and settled at once if the bank has already answered;
 *   - otherwise the same request is sent again under the same idempotency
 *     key — Stripe hands back the pull it made, or makes it once.
 * A definite refusal ends it as the first ask would have. Anything else
 * leaves it pending for the next sweep, and after a day an admin is told.
 */
async function resumeUnconfirmedDebit(d: UnconfirmedDebitRow): Promise<DebitOutcome> {
  const chargesAmount = Math.round(parseFloat(d.charges_amount) * 100) / 100
  const bankCost = Math.round(parseFloat(d.bank_cost_amount) * 100) / 100
  const total = Math.round(parseFloat(d.total_amount) * 100) / 100
  try {
    const stripe = getStripe()
    const found = await stripe.paymentIntents.search({ query: `metadata['gam_debit_id']:'${d.id}'`, limit: 10 })
    let pi: Stripe.PaymentIntent | null = found.data.find(i => i.status !== 'canceled') ?? null
    if (!pi && found.data.length > 0) {
      // Only a canceled pull: it moved no money and never will.
      await settleGamDebit(found.data[0].id, false, 'the bank pull was canceled', d.id)
      return { status: 'skipped', reason: 'stripe_failed', debitId: d.id, error: 'the bank pull was canceled' }
    }
    if (!pi) {
      const l = await queryOne<{ stripe_fc_customer_id: string | null }>(
        `SELECT stripe_fc_customer_id FROM landlords WHERE id = $1`, [d.landlord_id])
      if (!l?.stripe_fc_customer_id || !d.payment_method_id) {
        throw new Error('the pull\'s bank customer or payment method is no longer on file')
      }
      pi = await stripe.paymentIntents.create(
        debitIntentRequest({
          debitId: d.id, landlordId: d.landlord_id, customerId: l.stripe_fc_customer_id,
          paymentMethodId: d.payment_method_id, total, chargesAmount, bankCost,
        }),
        { idempotencyKey: debitIdempotencyKey(d.id) })
    }
    await query(
      `UPDATE landlord_gam_debits SET stripe_payment_intent_id = $2, updated_at = NOW()
        WHERE id = $1 AND stripe_payment_intent_id IS NULL`, [d.id, pi.id])
    if (pi.status === 'succeeded') await settleGamDebit(pi.id, true)
    else if (pi.status === 'requires_payment_method') {
      await settleGamDebit(pi.id, false, pi.last_payment_error?.message ?? 'the bank refused the transfer')
    }
    logger.warn({ landlordId: d.landlord_id, debitId: d.id, pi: pi.id, status: pi.status },
      '[gam-debit] an unconfirmed pull was found or made under its own key')
    return { status: 'skipped', reason: 'debit_in_flight', debitId: d.id }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (isDefiniteStripeRefusal(e)) {
      // Its cost line was written in the pull's own transaction, so it shares
      // the pull's created_at (NOW() is the transaction's clock).
      const cost = await queryOne<{ id: string }>(
        `SELECT c.id FROM landlord_gam_charges c
          WHERE c.id = ANY ((SELECT charge_ids FROM landlord_gam_debits WHERE id = $1)::uuid[])
            AND c.kind = 'bank_debit_cost'
            AND c.created_at = (SELECT created_at FROM landlord_gam_debits WHERE id = $1) LIMIT 1`, [d.id])
      await markPullRefused(d.id, d.landlord_id, cost?.id ?? null, msg, intentOfRefusal(e))
      return { status: 'skipped', reason: 'stripe_failed', debitId: d.id, error: msg }
    }
    await query(
      `UPDATE landlord_gam_debits SET failure_reason = $2, updated_at = NOW() WHERE id = $1 AND status = 'pending'`,
      [d.id, msg.slice(0, 500)])
    logger.error({ landlordId: d.landlord_id, debitId: d.id, err: msg },
      '[gam-debit] an unconfirmed pull is still unconfirmed — asked again next sweep')
    if (Date.now() - new Date(d.created_at).getTime() > 24 * 3600 * 1000) {
      const { createAdminNotification } = await import('./adminNotifications')
      await createAdminNotification({
        severity: 'critical',
        category: 'gam_debit_unconfirmed',
        title:    `A $${total.toFixed(2)} bank pull of GAM's fees has had no answer from Stripe for over a day`,
        body:     `Pull ${d.id} was recorded but Stripe never confirmed it (${msg}). Its charges are held out of netting until it is settled. Check Stripe for a payment with metadata gam_debit_id = ${d.id}.`,
        context:  { debit_id: d.id, landlord_id: d.landlord_id, total, error: msg },
      }).catch(() => {})
    }
    return { status: 'skipped', reason: 'debit_in_flight', debitId: d.id, error: msg }
  }
}

/**
 * Pull what this landlord owes GAM out of the bank they linked. Linked, not
 * authorized for this: the bank feed is where the link came from, which is
 * why a link made before the payment_method permission cannot be debited.
 *
 * Returns without doing anything — and says why — when any gate is shut. The
 * caller is a nightly job, so "skipped" is the normal, healthy answer and
 * should not read as a failure anywhere.
 */
export async function debitLandlordForCharges(landlordId: string): Promise<DebitOutcome> {
  const l = await queryOne<LandlordDebitRow>(
    `SELECT id, business_name, gam_debit_payment_method_id, stripe_fc_customer_id
       FROM landlords WHERE id = $1`,
    [landlordId])
  if (!l) return { status: 'skipped', reason: 'nothing_owed' }

  // GATE 2 (checked first, 10/12 review: a pull left unconfirmed is asked
  // about again whatever the threshold says now) — an ACH pull takes days to
  // settle. Firing a second one tomorrow for the same fees is how a landlord
  // gets double-debited, so the unique partial index and this check both
  // guard it.
  const inFlight = await queryOne<UnconfirmedDebitRow & { stripe_payment_intent_id: string | null }>(
    `SELECT id, landlord_id, charges_amount::text AS charges_amount, bank_cost_amount::text AS bank_cost_amount,
            total_amount::text AS total_amount, payment_method_id, created_at, stripe_payment_intent_id
       FROM landlord_gam_debits WHERE landlord_id = $1 AND status = 'pending' LIMIT 1`,
    [landlordId])
  if (inFlight) {
    // 10/12 (ledger P0 review): a pull whose create never got an answer from
    // Stripe carries no payment id. Asked about again here, under its own key,
    // rather than left in flight for good.
    if (!inFlight.stripe_payment_intent_id) return resumeUnconfirmedDebit(inFlight)
    return { status: 'skipped', reason: 'debit_in_flight' }
  }

  // GATE 1 — worth a bank pull at all. Below the threshold the debt waits;
  // carrying $20 to next month is cheaper than the transfer to collect it.
  const [owedBefore, threshold] = await Promise.all([
    outstandingForLandlord(landlordId),
    debitThresholdForLandlord(landlordId),
  ])
  // Read again under the lock, from the rows the pull claims (below).
  let owed = owedBefore
  if (owed <= 0) return { status: 'skipped', reason: 'nothing_owed' }
  if (owed < threshold) return { status: 'skipped', reason: 'under_threshold' }

  // The bank to pull from is the one they already linked. Minted on first use
  // rather than at link time, so a landlord who never owes anything never has a
  // payment method sitting on their account.
  //
  // No usable link is a COLLECTION FAILURE, not an exemption. It alerts loudly
  // and the debt stays exactly where it is — the alternative is a park running
  // for free because nobody noticed a bank was never connected.
  let paymentMethodId = l.gam_debit_payment_method_id
  if (!paymentMethodId) {
    const { createDebitPaymentMethod } = await import('./bankFeed')
    // S652 (Nic): "why the fuck are we having a problem with that?" The reason
    // was swallowed here: Oak Park's PNC feed link was made without the
    // payment_method permission, and this logged only "no usable bank link".
    let why: string | null = null
    const pm = await createDebitPaymentMethod(landlordId).catch((e: any) => { why = e?.message ?? String(e); return null })
    if (!pm) {
      if (!why) {
        const { debitLinkProblem } = await import('./bankFeed')
        why = await debitLinkProblem(landlordId)
      }
      logger.error({ landlordId, owed, threshold, why },
        '[gam-debit] OWES GAM AND CANNOT BE COLLECTED FROM — no usable bank link')
      return { status: 'skipped', reason: 'no_bank_link', detail: why ?? undefined }
    }
    paymentMethodId = pm.paymentMethodId
    await query(
      `UPDATE landlords
          SET gam_debit_payment_method_id = $2, gam_debit_bank_last4 = $3,
              gam_debit_bank_name = $4,
              gam_debit_authorized_at = COALESCE(gam_debit_authorized_at, NOW()),
              updated_at = NOW()
        WHERE id = $1`,
      [landlordId, pm.paymentMethodId, pm.last4, pm.bankName])
  }
  const customerId = l.stripe_fc_customer_id
    ?? await (await import('./bankFeed')).getOrCreateFcCustomer(landlordId)

  const stripe = getStripe()

  // The cost line is written BEFORE the pull and is itself part of what gets
  // pulled, so the landlord pays the fees and the cost of collecting them in
  // one movement rather than carrying a $1.04 debt into next month that would
  // itself one day need a $5 pull to collect.
  const client = await getClient()
  let debitId: string
  let total: number
  let chargeIds: string[]
  let bankCost: number
  let costChargeId: string | null = null
  try {
    await client.query('BEGIN')
    // 10/12 (Nic, ledger P0): the same lock a payout batch holds while it nets
    // GAM's charges (landlordPassthrough RESERVE). Without it a batch could
    // net a charge this pull is claiming, and the landlord would pay it twice.
    await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [gamAccountLockKey(landlordId)])
    if ((await client.query(
      `SELECT 1 FROM landlord_gam_debits WHERE landlord_id = $1 AND status = 'pending' LIMIT 1`,
      [landlordId])).rows.length) {
      await client.query('ROLLBACK')
      return { status: 'skipped', reason: 'debit_in_flight' }
    }

    const outstanding = await client.query<{ id: string; outstanding: string }>(
      `SELECT c.id, (c.amount - c.collected_amount)::text AS outstanding
         FROM landlord_gam_charges c
        WHERE c.landlord_id = $1 AND ${GAM_CHARGE_OWED_SQL('c')}
        ORDER BY c.created_at ASC FOR UPDATE`,
      [landlordId])
    chargeIds = outstanding.rows.map(r => r.id)
    // 10/12: what is owed NOW, read from the rows this pull claims. The figure
    // read before the lock can be stale — a payout that netted some of it in
    // between would have been pulled again from the bank.
    owed = Math.round(outstanding.rows.reduce((a, r) => a + Math.round(parseFloat(r.outstanding) * 100), 0)) / 100
    if (owed <= 0) { await client.query('ROLLBACK'); return { status: 'skipped', reason: 'nothing_owed' } }
    if (owed < threshold) { await client.query('ROLLBACK'); return { status: 'skipped', reason: 'under_threshold' } }
    bankCost = bankCostFor(owed)

    if (bankCost > 0) {
      costChargeId = await chargeLandlord(client, {
        landlordId,
        kind: 'bank_debit_cost',
        amount: bankCost,
        sourceType: 'gam_bank_debit_cost',
        // deterministic per pull: the in-flight guard above already stops a
        // second pull, and a retry of THIS one must not add a second cost line
        sourceId: null,
        notes: `Bank transfer to collect $${owed.toFixed(2)} of GAM charges — $6 flat, GAM's one ACH price`,
      })
      if (costChargeId) chargeIds.push(costChargeId)
    }

    total = Math.round((owed + bankCost) * 100) / 100

    const ins = await client.query<{ id: string }>(
      `INSERT INTO landlord_gam_debits
         (landlord_id, charges_amount, bank_cost_amount, total_amount,
          payment_method_id, charge_ids, threshold_at_debit)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING id`,
      [landlordId, owed.toFixed(2), bankCost.toFixed(2), total.toFixed(2),
       paymentMethodId, chargeIds, threshold.toFixed(2)])
    debitId = ins.rows[0].id

    await client.query('COMMIT')
  } catch (e) {
    try { await client.query('ROLLBACK') } catch {}
    logger.error({ landlordId, err: e }, '[gam-debit] could not raise the debit')
    return { status: 'skipped', reason: 'stripe_failed', error: e instanceof Error ? e.message : String(e) }
  } finally {
    client.release()
  }

  // The Stripe call sits OUTSIDE the transaction deliberately: a pull that
  // succeeds against a rolled-back row is money taken with no record of why.
  // This way the record always exists first and a failed pull just marks it.
  let pi: Stripe.PaymentIntent
  try {
    // 10/12 (Nic, ledger P0 review): under the pull's own idempotency key, so
    // asking again (resumeUnconfirmedDebit) can never pull twice.
    pi = await stripe.paymentIntents.create(
      debitIntentRequest({ debitId, landlordId, customerId, paymentMethodId, total, chargesAmount: owed, bankCost }),
      { idempotencyKey: debitIdempotencyKey(debitId) })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    // 10/12 (Nic, ledger P0 review): only a definite refusal is a pull that
    // never happened. A timeout, a dropped connection or Stripe's own error
    // can come back after Stripe made the pull — marking that failed voided
    // its cost line, left the fees owed and pulled them again the next night.
    // Unknown: the pull stays pending (nothing else pulls these charges), the
    // webhook settles it by the id in its metadata if it was made, and the
    // next sweep asks Stripe again under the same key (lib/stripeRefusal).
    if (!isDefiniteStripeRefusal(e)) {
      await query(
        `UPDATE landlord_gam_debits SET failure_reason = $2, updated_at = NOW() WHERE id = $1 AND status = 'pending'`,
        [debitId, msg.slice(0, 500)])
      logger.error({ landlordId, debitId, err: msg }, '[gam-debit] Stripe\'s answer to the pull is unknown — left pending, asked again next sweep')
      return { status: 'skipped', reason: 'stripe_failed', debitId, error: msg }
    }
    await markPullRefused(debitId, landlordId, costChargeId, msg, intentOfRefusal(e))
    return { status: 'skipped', reason: 'stripe_failed', debitId, error: msg }
  }

  // 10/12: outside the try above. Stripe has made the pull by now; a database
  // error stamping it must not mark the pull failed and void its cost line
  // (money taken, recorded as never taken). It throws instead, and the pull
  // stays pending, which also stops a second pull until someone looks.
  await query(
    `UPDATE landlord_gam_debits
        SET stripe_payment_intent_id = $2, updated_at = NOW()
      WHERE id = $1`,
    [debitId, pi.id])

  logger.warn({ landlordId, debitId, owed, bankCost, total, pi: pi.id },
    '[gam-debit] no payout to net against — pulled from the bank')
  return { status: 'debited', debitId, chargesAmount: owed, bankCost, total }
}

/**
 * Settle a debit the bank finally answered on. Called from the Stripe webhook.
 *
 * Marking the charges collected only HERE, on settlement, is deliberate: ACH
 * can fail days later, and a charge marked paid on submission would let the
 * next month's fee accrue on top of a debt that bounced.
 */
export async function settleGamDebit(
  paymentIntentId: string,
  ok: boolean,
  failureReason?: string,
  /** 10/12 (ledger P0 review): the pull's id from the intent's metadata (gam_debit_id). */
  gamDebitId?: string | null,
): Promise<void> {
  type DebitRow = { id: string; landlord_id: string; charge_ids: string[]; status: string; total_amount: string }
  let debit = await queryOne<DebitRow>(
    `SELECT id, landlord_id, charge_ids, status, total_amount::text AS total_amount FROM landlord_gam_debits
      WHERE stripe_payment_intent_id = $1`,
    [paymentIntentId])
  // 10/12 (Nic, ledger P0 review): a pull Stripe made that GAM never stamped
  // (the create's answer was lost, or stamping it failed) is found by the id
  // it carries in its metadata, stamped, and settled as usual. Found only by
  // the payment id, it stayed pending for good: its charges owed, skipped by
  // netting, and counted by the portal lock against a landlord who had paid.
  if (!debit && gamDebitId && UUID_RE.test(gamDebitId)) {
    debit = await queryOne<DebitRow>(
      `UPDATE landlord_gam_debits SET stripe_payment_intent_id = $2, updated_at = NOW()
        WHERE id = $1 AND stripe_payment_intent_id IS NULL
        RETURNING id, landlord_id, charge_ids, status, total_amount::text AS total_amount`,
      [gamDebitId, paymentIntentId])
  }
  if (debit && debit.status === 'failed' && ok) {
    // Money arrived for a pull recorded as never made (one marked failed
    // before 10/12 on a timeout): its fees are still owed and would be pulled
    // again. A person settles it.
    const { createAdminNotification } = await import('./adminNotifications')
    await createAdminNotification({
      severity: 'critical',
      category: 'gam_debit_paid_after_failed',
      title:    `A bank pull of GAM's fees recorded as failed was paid ($${Number(debit.total_amount).toFixed(2)})`,
      body:     `Stripe says payment ${paymentIntentId} for pull ${debit.id} succeeded, but the pull is recorded as failed, so its charges still read as owed. Mark them collected by hand and make sure they are not pulled again.`,
      context:  { debit_id: debit.id, landlord_id: debit.landlord_id, payment_intent_id: paymentIntentId },
    }).catch(() => {})
    return
  }
  if (!debit || debit.status !== 'pending') return

  if (!ok) {
    const failed = await query(
      `UPDATE landlord_gam_debits
          SET status='failed', failure_reason=$2, settled_at=NOW(), updated_at=NOW()
        WHERE id=$1 AND status = 'pending'
        RETURNING id`,
      [debit.id, (failureReason ?? 'bank declined').slice(0, 500)])
    if (!failed.length) return
    logger.error({ debitId: debit.id, landlordId: debit.landlord_id, failureReason },
      '[gam-debit] the bank refused the pull — the charges stay owed')
    // 10/12 (Nic, G1): the pull was made and failed (or came back). Its $6
    // price is taken back, and what the failure actually cost GAM is billed to
    // the landlord at cost — GAM absorbs none of it.
    await billFailedPullCost(debit.id, paymentIntentId, 'bank_debit_failed')
    return
  }

  let recordedCents = 0
  let pulledCents = 0
  const client = await getClient()
  try {
    await client.query('BEGIN')
    // Claimed first, and only while still pending: two deliveries of the same
    // webhook racing each other settle it once (the read above is outside this
    // transaction and both could pass it).
    const claimed = await client.query<{ bank_cost_amount: string; total_amount: string }>(
      `UPDATE landlord_gam_debits
          SET status='succeeded', settled_at=NOW(), updated_at=NOW()
        WHERE id=$1 AND status='pending'
        RETURNING bank_cost_amount::text AS bank_cost_amount, total_amount::text AS total_amount`,
      [debit.id])
    if (!claimed.rows.length) { await client.query('ROLLBACK'); return }
    // 10/12 (Nic, ledger P0): what this pull collected on each charge, as a
    // record against the pull. Netting skips a charge while its pull is
    // pending (landlordGamAccount), so what is left on each is exactly what
    // the pull took for it.
    const owedNow = await client.query<{ id: string; left: string }>(
      `SELECT id, (amount - collected_amount)::text AS left FROM landlord_gam_charges
        WHERE id = ANY($1::uuid[]) AND collected_amount < amount
        FOR UPDATE`,
      [debit.charge_ids])
    await client.query(
      `UPDATE landlord_gam_charges
          SET collected_amount = amount, collected_at = NOW(), updated_at = NOW()
        WHERE id = ANY($1::uuid[])`,
      [debit.charge_ids])
    await recordGamChargeCollections(client,
      owedNow.rows.map(r => ({ chargeId: r.id, amount: parseFloat(r.left) })),
      { landlordGamDebitId: debit.id })
    // 10/12 (Nic, ledger P0 review): the records must add up to what the bank
    // took (the fees and the cost line together). They differ only when a
    // charge was collected another way while the pull was in flight — a pull
    // raised by code from before 10/12, netted by a payout of that code — and
    // then GAM holds money nobody's record explains. Said, never absorbed.
    recordedCents = owedNow.rows.reduce((a, r) => a + Math.round(parseFloat(r.left) * 100), 0)
    pulledCents = Math.round(parseFloat(claimed.rows[0].total_amount) * 100)
    // 10/3 (Nic's admin cards): the $6 bank cost is GAM's processing revenue —
    // GAM's one ACH price, charged for the transfer that collected its fees —
    // and it was never written down: the pull's Stripe fee ($0.27 on Oak Park's
    // $54) was counted as a cost while the $6 that paid for it was counted
    // nowhere. Booked when the money lands, like a bank rent payment's fee, as
    // a processing spread (the month's true-up subtracts what Stripe took).
    const bankCost = Math.round(parseFloat(claimed.rows[0].bank_cost_amount) * 100) / 100
    if (bankCost > 0) {
      await recordPlatformRevenue({
        type: 'banking_spread',
        amount: bankCost,
        customerFeeCharged: bankCost,
        referenceId: debit.id,
        referenceType: 'gam_bank_debit',
        notes: 'Bank transfer cost on a debit of GAM fees ($6 flat, GAM\'s one ACH price)',
      }, client)
    }
    await client.query('COMMIT')
  } catch (e) {
    try { await client.query('ROLLBACK') } catch {}
    throw e
  } finally {
    client.release()
  }
  if (pulledCents > 0 && recordedCents !== pulledCents) {
    const over = pulledCents > recordedCents
    const diff = (Math.abs(pulledCents - recordedCents) / 100).toFixed(2)
    const { createAdminNotification } = await import('./adminNotifications')
    await createAdminNotification({
      severity: 'critical',
      category: over ? 'gam_debit_overcollected' : 'gam_debit_undercollected',
      title:    over
        ? `A bank pull took $${diff} more than its charges still owed (pull ${debit.id})`
        : `A bank pull's charges owed $${diff} more than it took (pull ${debit.id})`,
      body:     `The pull took $${(pulledCents / 100).toFixed(2)}; what its charges still owed when it settled was $${(recordedCents / 100).toFixed(2)}. `
        + (over ? 'Some of it was collected another way while the pull was in flight, so the difference is on no charge\'s record.'
                : 'Check the pull\'s charges by hand.'),
      context:  { debit_id: debit.id, landlord_id: debit.landlord_id, pulled: pulledCents / 100, recorded: recordedCents / 100 },
    }).catch((err) => logger.error({ err, debitId: debit!.id }, '[gam-debit] could not raise the mismatch notice'))
  }
  logger.info({ debitId: debit.id, landlordId: debit.landlord_id }, '[gam-debit] settled')
}

/**
 * The nightly sweep — every landlord who owes GAM anything.
 *
 * Cheap and usually silent, because almost everyone is under their threshold:
 * the platform fee nets out of the electronic rent passing through. The ones
 * that surface here are the all-cash properties (S654: cash itself is free —
 * what they owe is the platform fee), which is exactly who this was built for.
 */
export async function runGamDebitSweep(): Promise<{ considered: number; debited: number; skipped: Record<string, number> }> {
  // 10/12 (G1): failed pulls whose cost could not be read when they failed —
  // billed now, before anyone's balance is weighed against the threshold.
  await readFailedPullCosts().catch((err) => logger.error({ err }, '[gam-debit-sweep] reading failed pulls\' costs failed'))
  // 10/13 (Nic): disputes GAM won whose undoing waited on a later pull still
  // settling (or whose win no webhook carried) — undone now, before the
  // balances are weighed.
  await applyWonGamDebitDisputes().catch((err) => logger.error({ err }, '[gam-debit-sweep] undoing won pull disputes failed'))
  // 10/13 (G1): and disputed pulls whose cost was not read when the dispute
  // came — or was billed at $15 while Stripe had not stated its dispute fee.
  await readDisputedPullCosts().catch((err) => logger.error({ err }, '[gam-debit-sweep] reading disputed pulls\' costs failed'))
  const rows = await query<{ id: string }>(
    `SELECT l.id FROM landlords l
      WHERE l.is_demo = FALSE
        AND EXISTS (SELECT 1 FROM landlord_gam_charges c
                     WHERE c.landlord_id = l.id AND ${GAM_CHARGE_OWED_SQL('c')})`)

  const skipped: Record<string, number> = {}
  let debited = 0
  for (const r of rows) {
    const out = await debitLandlordForCharges(r.id).catch((e): DebitOutcome => ({
      status: 'skipped', reason: 'stripe_failed', error: e instanceof Error ? e.message : String(e),
    }))
    if (out.status === 'debited') debited++
    else skipped[out.reason ?? 'unknown'] = (skipped[out.reason ?? 'unknown'] ?? 0) + 1
  }
  // A landlord over their threshold with no bank GAM can reach is money that
  // will never arrive unless somebody acts. It does not belong in an info log
  // nobody reads.
  if (skipped.no_bank_link) {
    logger.error({ count: skipped.no_bank_link },
      '[gam-debit-sweep] landlords owe GAM and have no bank link to collect from')
  }
  return { considered: rows.length, debited, skipped }
}

/**
 * S652 — landlords GAM is owed money by and has no way to collect from.
 *
 * The end of every collection route is a bank: netting from a payout, or an ACH
 * debit against a linked account. A landlord with neither has, without ever
 * saying so, opted out of all of them — and until this existed the only trace
 * was an error line in a log nobody reads.
 *
 * SURFACES, DOES NOT ACT. Nic asked for a lock as "a safety precaution" for the
 * case where somebody "refuse[s] to put a bank account in there" — and an
 * automatic lockout is one bug away from taking a paying customer's whole
 * operation offline on a Saturday. A person at GAM reads this list and decides.
 */
export interface UncollectableLandlord {
  landlordId: string
  businessName: string | null
  owed: number
  threshold: number
  hasBankLink: boolean
  noticeSentAt: string | null
  lockedAt: string | null
  oldestChargeAt: string | null
}

export async function uncollectableLandlords(): Promise<UncollectableLandlord[]> {
  const rows = await query<any>(
    `SELECT l.id, l.business_name, l.platform_locked_at, l.uncollectable_notice_at,
            l.gam_debit_payment_method_id,
            COALESCE(SUM(c.amount - c.collected_amount), 0)::float AS owed,
            MIN(c.created_at) AS oldest_charge_at,
            EXISTS (SELECT 1 FROM bank_connections bc
                     WHERE bc.landlord_id = l.id AND bc.status = 'active') AS has_bank_link
       FROM landlords l
       JOIN landlord_gam_charges c ON c.landlord_id = l.id AND ${GAM_CHARGE_OWED_SQL('c')}
      WHERE l.is_demo = FALSE
      GROUP BY l.id
      ORDER BY owed DESC`)

  const out: UncollectableLandlord[] = []
  for (const r of rows) {
    const threshold = await debitThresholdForLandlord(r.id)
    // Under the threshold the debt is simply waiting, which is the design —
    // carrying $20 to next month is cheaper than the $6 transfer to collect it.
    if (Number(r.owed) < threshold) continue
    // A bank GAM can actually pull from means this is a timing question, not a
    // collection failure. The sweep will take it.
    if (r.gam_debit_payment_method_id) continue
    out.push({
      landlordId: r.id,
      businessName: r.business_name,
      owed: Math.round(Number(r.owed) * 100) / 100,
      threshold,
      hasBankLink: r.has_bank_link === true,
      noticeSentAt: r.uncollectable_notice_at,
      lockedAt: r.platform_locked_at,
      oldestChargeAt: r.oldest_charge_at,
    })
  }
  return out
}

// ── 10/13 (Nic): A PULL THE LANDLORD'S BANK DISPUTES ─────────────────────────
//
//   "GAM fee pull disputed by landlord's bank: AUTOMATIC — the disputed fees
//    reopen as owed by the landlord, collected on the next pull, admin told."
//
// A pull that went through and that the landlord's bank later disputes (an ACH
// "unauthorized" return) comes to the dispute webhook as a dispute on the
// pull's own PaymentIntent. It used to be a charge nobody could place: one
// admin notice (dispute_charge_unplaced), and the fees the bank took back read
// as collected. Now, once Stripe has taken the money (DISPUTE_STATUSES_MONEY_TAKEN):
//   - every fee the pull collected is owed again — its collected_amount comes
//     back down by what this pull took for it (its
//     landlord_gam_charge_collections rows; kept as written). Owed again, the
//     fees are collected the usual way: netted from the landlord's next payout,
//     or on the next pull (runGamDebitSweep, once over the threshold — a pull
//     happened, so they were). A fee voided since the pull collected it (a
//     dispute's cost a win or a re-bill took back) is owed by nobody and was
//     already given back on a payout: the bank returning the pull's part of it
//     again, that part is taken back from the next payout instead
//     (gamChargeVoidedTakeBackSourceId) — every dollar counted once;
//   - a pull that came back is a failed pull for Nic G1 ("gam eats no fees of
//     failed pulls ever", on a later return alike — billFailedPullCost): the
//     pull's own $6 cost line, GAM's price for a transfer that collects, is
//     voided (reason 'bank_debit_failed', kept on record) and the $6 GAM wrote
//     down as earned when the pull landed is taken back off GAM's book (an
//     adjustment, as a disputed tenant payment's spread is); what the pull
//     actually cost GAM — Stripe's fee on the pull and Stripe's dispute fee —
//     is billed to the landlord at cost (billDisputedPullCost: kind
//     bank_debit_failed_cost, source 'gam_bank_debit_disputed'), read from
//     Stripe. Not readable yet, the nightly sweep asks again
//     (readDisputedPullCosts). 10/13 (Nic, afternoon): "Dispute fee unknown →
//     bill $15." When Stripe still has not stated its dispute fee
//     FAILED_PULL_COST_UNREAD_DAYS after the dispute, $15 — Stripe's usual
//     dispute fee (STRIPE_USUAL_DISPUTE_FEE_CENTS) — is billed in its place;
//     once Stripe states its fee the bill is corrected to it, never billed
//     twice (rebillDisputeCost). Stripe that cannot be reached at all for that
//     long still tells an admin — a cost nobody reads is a cost GAM absorbs;
//   - the pull is marked disputed (disputed_at, stripe_dispute_id,
//     dispute_reopened_amount) and stays 'succeeded': it did go through;
//   - an admin is told, once per dispute.
// An inquiry takes no money and reopens nothing (an admin is told, once). A
// dispute arriving before the pull's own success is recorded is put off
// ('not_settled': the webhook answers 503 and Stripe sends it again).
//
// 10/13 (Nic, afternoon): "Won GAM pull dispute: AUTOMATIC (back to collected;
// anything collected twice credited back)." A dispute Stripe decides for GAM
// undoes itself (applyWonGamDebitDispute): the fees go back to collected, the
// pull's $6 with them (the transfer collected after all), what was collected
// twice meanwhile is given back to the landlord on their next payout, the
// dispute's cost charge is voided (only what Stripe kept of its fee stays
// theirs), and an admin is told. Once, whatever event or sweep brings it.

/** Admin notice categories for a disputed pull. */
export const GAM_DEBIT_DISPUTED_CATEGORY = 'gam_debit_disputed'
export const GAM_DEBIT_DISPUTE_INQUIRY_CATEGORY = 'gam_debit_dispute_inquiry'
export const GAM_DEBIT_DISPUTE_UNPLACED_CATEGORY = 'gam_debit_dispute_unplaced'
export const GAM_DEBIT_DISPUTE_WON_CATEGORY = 'gam_debit_dispute_won'
export const GAM_DEBIT_DISPUTE_COST_UNREAD_CATEGORY = 'gam_debit_dispute_cost_unread'
/** 10/13: $15 billed as the dispute fee because Stripe had not stated it. */
export const GAM_DEBIT_DISPUTE_FEE_ASSUMED_CATEGORY = 'gam_debit_dispute_fee_assumed'
/** 10/13: the $15 corrected to the dispute fee Stripe stated. */
export const GAM_DEBIT_DISPUTE_FEE_CORRECTED_CATEGORY = 'gam_debit_dispute_fee_corrected'
/** The source of the GAM charge that bills what a disputed pull cost GAM. */
export const GAM_DEBIT_DISPUTE_COST_SOURCE = 'gam_bank_debit_disputed'
/**
 * 10/13: the reference_type of the banking_spread row (platform_revenue_ledger,
 * reference_id = the pull) that books the pull's $6 again when GAM wins its
 * dispute — the mirror of the 'dispute_spread_reversal' adjustment the
 * dispute wrote.
 */
export const GAM_DEBIT_DISPUTE_WON_SPREAD_REFERENCE = 'gam_bank_debit_dispute_won'

/**
 * 10/13 (Nic): "Dispute fee unknown → bill $15." Stripe's usual dispute fee,
 * billed in place of the fee Stripe has not stated FAILED_PULL_COST_UNREAD_DAYS
 * after the dispute; corrected to Stripe's own word when it says it.
 */
export const STRIPE_USUAL_DISPUTE_FEE_CENTS = 1500

/**
 * 10/13 (Nic, "anything collected twice credited back"): the payout line
 * (held_payout_items, source_type 'refund', positive) that gives a landlord
 * back what GAM's win left it holding twice for one charge — the disputed pull
 * took it, and a payout or a later pull collected it again meanwhile.
 */
export const gamDebitWonGiveBackSourceId = (debitId: string, chargeId: string): string =>
  `gam_debit_dispute_won:${debitId}:${chargeId}`
/**
 * 10/13: the payout line that gives back what was collected on a dispute cost
 * charge that was then voided (a win, or a re-bill) — it is owed by nobody.
 */
export const gamChargeVoidedGiveBackSourceId = (chargeId: string): string => `gam_charge_voided:${chargeId}`
/**
 * 10/13 review ("every dollar counted once"): the payout line (held_payout_items,
 * source_type 'refund', NEGATIVE) that takes back what a voided charge's
 * give-back (gamChargeVoidedGiveBackSourceId) paid for a pull the landlord's
 * bank then disputed. The pull collected the charge, the charge was voided and
 * what it collected given back on a payout — and the bank's dispute of the pull
 * returns that same money to them a second time. One per (pull, charge); a win
 * on that pull gives it back again (gamDebitWonGiveBackSourceId, "voided since").
 */
export const gamChargeVoidedTakeBackSourceId = (debitId: string, chargeId: string): string =>
  `gam_charge_voided_taken_back:${debitId}:${chargeId}`

/** What a re-bill of a dispute's cost is computed on (migration 20261015180000). */
type DisputeCostBasis = 'stated' | 'won_stated' | 'won_assumed'
/**
 * The source_id of a re-bill of a dispute's cost: md5('<pull id>:<basis>') as
 * a uuid — one per basis, so a retry can never bill one basis twice. The first
 * bill's source_id is the pull itself.
 */
export function disputeCostRebillSourceId(debitId: string, basis: DisputeCostBasis): string {
  const h = createHash('md5').update(`${debitId}:${basis}`).digest('hex')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`
}

/**
 * The pull's own $6 cost line: written in the pull's own transaction, so it
 * shares the pull's created_at (NOW() is the transaction's clock) — the rule
 * billFailedPullCost and resumeUnconfirmedDebit use. An older cost line the
 * pull also carried was never this pull's. $1 = the pull.
 */
const PULL_OWN_COST_LINE_SQL =
  `SELECT c.id FROM landlord_gam_charges c
    WHERE c.id = ANY ((SELECT charge_ids FROM landlord_gam_debits WHERE id = $1)::uuid[])
      AND c.kind = 'bank_debit_cost'
      AND c.created_at = (SELECT created_at FROM landlord_gam_debits WHERE id = $1)
    LIMIT 1`

/**
 * SQL: the charge is inside a bank pull that has not settled yet — its money
 * is on its way, so nothing may void it or give it back now (the rule
 * landlordGamAccount voidGamCharge and netting use).
 */
const IN_PENDING_PULL_SQL = (c: string) =>
  `EXISTS (SELECT 1 FROM landlord_gam_debits pd
            WHERE pd.landlord_id = ${c}.landlord_id AND pd.status = 'pending'
              AND ${c}.id = ANY (pd.charge_ids))`

export interface GamDebitDisputeInput {
  paymentIntentId: string
  stripeDisputeId: string
  /** The status the event acts on: the furthest Stripe has told GAM (webhooks, disputeStatusRank). */
  disputeStatus: string
  /** The event's own status ('won' only on the event that carries the win). */
  eventStatus: string
  disputedCents: number
  /** Stripe's dispute fee, from this event's balance transactions. */
  feeCents: number
  /**
   * Whether this event carried the dispute's balance transactions at all — so
   * feeCents is Stripe's word on its fee (0 included). False: Stripe has not
   * said it on this event, and it is read from Stripe instead.
   */
  feeStated?: boolean
  /** On a win: the part of the fee Stripe gave back. */
  feeReturnedCents?: number
}

export type GamDebitDisputeOutcome =
  | { handled: false }
  | {
      handled: true
      action: 'reopened' | 'already_reopened' | 'inquiry' | 'not_settled' | 'unplaced' | 'won' | 'won_waiting'
      debitId: string
      reopened?: number
      /** What the pull cost GAM, billed at cost (null: not read from Stripe yet). */
      costBilled?: number | null
      /**
       * Dollars the pull had paid on charges voided since — already given back
       * to the landlord — taken back from their next payout (gamChargeVoidedTakeBackSourceId).
       */
      takenBack?: number
      /** On a win: what went back to collected, and what was given back to the landlord. */
      restored?: number
      givenBack?: number
    }

const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`
const toCents = (v: string | number | null | undefined): number => Math.round((Number(v) || 0) * 100)
const pullDay = (createdAt: Date) =>
  new Date(createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'America/Phoenix' })

/** One admin notice per (category, dispute) — the live list and the archive both count. */
async function noticeOncePerDispute(category: string, stripeDisputeId: string,
  n: { severity: 'info' | 'warn' | 'critical'; title: string; body: string; context: Record<string, unknown> }): Promise<boolean> {
  const seen = await queryOne(
    `SELECT 1 FROM admin_notifications WHERE category = $1 AND context->>'stripe_dispute_id' = $2
     UNION ALL
     SELECT 1 FROM admin_notifications_archive WHERE category = $1 AND context->>'stripe_dispute_id' = $2
     LIMIT 1`, [category, stripeDisputeId])
  if (seen) return false
  const { createAdminNotification } = await import('./adminNotifications')
  await createAdminNotification({ ...n, category, context: { ...n.context, stripe_dispute_id: stripeDisputeId } })
  return true
}

/**
 * Handle a dispute on a GAM fee pull. `handled: false` when the disputed
 * charge is not a pull (the caller carries on with a tenant's payment or a held
 * charge). Throws only on a database failure (the webhook answers 500 and
 * Stripe sends the event again; nothing half-done stays — one transaction).
 */
export async function handleGamDebitDispute(d: GamDebitDisputeInput): Promise<GamDebitDisputeOutcome> {
  type Pull = {
    id: string; landlord_id: string; status: string; total_amount: string; created_at: Date
    disputed_at: Date | null; business_name: string | null
  }
  const pull = await queryOne<Pull>(
    `SELECT d.id, d.landlord_id, d.status, d.total_amount::text AS total_amount, d.created_at,
            d.disputed_at, l.business_name
       FROM landlord_gam_debits d LEFT JOIN landlords l ON l.id = d.landlord_id
      WHERE d.stripe_payment_intent_id = $1`, [d.paymentIntentId])
  if (!pull) return { handled: false }
  const { DISPUTE_STATUSES_MONEY_TAKEN, DISPUTE_STATUS_WON } = await import('./creditUse')
  const day = pullDay(pull.created_at)
  const who = pull.business_name ?? 'the landlord'
  const ctx = { debit_id: pull.id, landlord_id: pull.landlord_id, stripe_payment_intent_id: d.paymentIntentId,
                disputed: d.disputedCents / 100 }

  // WON — 10/13 (Nic): "AUTOMATIC (back to collected; anything collected
  // twice credited back)." Undone once, by any event that reads the win (an
  // older event after it acts on the win on file); only the event that
  // carries the win states what Stripe gave back of its fee, and the fee.
  if (d.disputeStatus === DISPUTE_STATUS_WON) {
    const carriesWin = d.eventStatus === DISPUTE_STATUS_WON
    const won = await applyWonGamDebitDispute({
      debitId: pull.id, stripeDisputeId: d.stripeDisputeId,
      eventFeeCents: carriesWin && d.feeStated ? Math.max(0, Math.round(d.feeCents)) : null,
      eventReturnedCents: carriesWin ? Math.max(0, Math.round(d.feeReturnedCents ?? 0)) : null,
      disputedCents: d.disputedCents,
    })
    return { handled: true, action: won.action, debitId: pull.id, restored: won.restored, givenBack: won.givenBack,
             costBilled: won.costBilled }
  }

  // An inquiry takes no money: nothing reopens. An admin is told, once.
  if (!(DISPUTE_STATUSES_MONEY_TAKEN as readonly string[]).includes(d.disputeStatus)) {
    await noticeOncePerDispute(GAM_DEBIT_DISPUTE_INQUIRY_CATEGORY, d.stripeDisputeId, {
      severity: 'warn',
      title: `${who}'s bank is asking about GAM's fee pull of ${day} (${usd(d.disputedCents)})`,
      body: `Stripe opened inquiry ${d.stripeDisputeId} on pull ${pull.id}. No money has moved, so nothing was reopened. `
        + 'If it becomes a dispute, the fees the pull collected are owed again and go on the next pull.',
      context: ctx,
    })
    return { handled: true, action: 'inquiry', debitId: pull.id }
  }

  // The pull's own success is not recorded yet (events arrive in any order):
  // its charges are not marked collected, so there is nothing to reopen yet.
  if (pull.status === 'pending') return { handled: true, action: 'not_settled', debitId: pull.id }

  // A dispute on a pull GAM recorded as failed, or for part of it, cannot be
  // placed by rule — a person looks (once per dispute). ACH disputes are for
  // the whole payment.
  const totalCents = Math.round(parseFloat(pull.total_amount) * 100)
  if (pull.status !== 'succeeded' || d.disputedCents !== totalCents) {
    await noticeOncePerDispute(GAM_DEBIT_DISPUTE_UNPLACED_CATEGORY, d.stripeDisputeId, {
      severity: 'critical',
      title: `A dispute on GAM's fee pull of ${day} from ${who} could not be placed by itself (${d.paymentIntentId})`,
      body: pull.status !== 'succeeded'
        ? `Stripe opened dispute ${d.stripeDisputeId} for ${usd(d.disputedCents)} on pull ${pull.id}, which is recorded as ${pull.status}. Nothing was reopened. Check the pull and its charges by hand.`
        : `Stripe opened dispute ${d.stripeDisputeId} for ${usd(d.disputedCents)} on pull ${pull.id}, which took ${usd(totalCents)}. A dispute for part of a pull is not reopened by itself: decide by hand which charges are owed again.`,
      context: { ...ctx, pull_status: pull.status, pulled: totalCents / 100 },
    })
    return { handled: true, action: 'unplaced', debitId: pull.id }
  }

  let action: 'reopened' | 'already_reopened' = 'already_reopened'
  let reopenedCents = 0
  let charges = 0
  let costLineCents = 0
  let takenBackCents = 0
  const client = await getClient()
  try {
    await client.query('BEGIN')
    // The account's lock first (a payout batch netting, or a pull claiming,
    // takes it before its row locks), then the pull.
    await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [gamAccountLockKey(pull.landlord_id)])
    const now = (await client.query<{ disputed_at: Date | null; status: string; stripe_dispute_id: string | null }>(
      `SELECT disputed_at, status, stripe_dispute_id FROM landlord_gam_debits WHERE id = $1 FOR UPDATE`,
      [pull.id])).rows[0]
    if (!now.disputed_at) {
      action = 'reopened'
      const ownCostLine = (await client.query<{ id: string }>(PULL_OWN_COST_LINE_SQL, [pull.id])).rows[0]?.id ?? null
      // What this pull collected on each charge (its collection records, kept as written).
      const took = (await client.query<{ charge_id: string; amount: string }>(
        `SELECT col.charge_id, SUM(col.amount)::text AS amount
           FROM landlord_gam_charge_collections col
          WHERE col.landlord_gam_debit_id = $1
          GROUP BY col.charge_id
          ORDER BY col.charge_id`, [pull.id])).rows
      for (const t of took) {
        const cents = Math.round(parseFloat(t.amount) * 100)
        if (cents <= 0) continue
        const r = await client.query<{ back: string; voided: boolean; property_id: string | null }>(
          `WITH old AS (SELECT id, collected_amount, voided_at, property_id FROM landlord_gam_charges WHERE id = $1 FOR UPDATE)
           UPDATE landlord_gam_charges c
              SET collected_amount = GREATEST(old.collected_amount - $2::numeric, 0),
                  collected_at = NULL, updated_at = NOW()
             FROM old WHERE c.id = old.id
           RETURNING (old.collected_amount - GREATEST(old.collected_amount - $2::numeric, 0))::text AS back,
                     old.voided_at IS NOT NULL AS voided, old.property_id`,
          [t.charge_id, (cents / 100).toFixed(2)])
        const back = Math.round(parseFloat(r.rows[0]?.back ?? '0') * 100)
        if (back <= 0) continue
        // 10/13 review ("every dollar counted once"): a charge voided since this
        // pull collected it — a dispute's cost a win or a re-bill took back
        // (rebillDisputeCost) — is owed by nobody, so it is never owed again;
        // what it had collected was already given back on a payout
        // ('gam_charge_voided:<charge>'), and the bank's dispute returns this
        // pull's part of it to them a second time. That part is taken back
        // from their next payout (a negative line, gamChargeVoidedTakeBackSourceId);
        // a win on this pull gives it back again ("voided since",
        // applyWonGamDebitDispute).
        if (r.rows[0]?.voided) {
          const { recordHeldItem } = await import('./heldPayouts')
          await recordHeldItem({
            landlordId: pull.landlord_id, sourceType: 'refund', sourceId: gamChargeVoidedTakeBackSourceId(pull.id, t.charge_id),
            amount: -back / 100, property: { propertyId: r.rows[0].property_id },
            description: 'Taken back: your bank\'s dispute of a bank transfer of GAM\'s fees returned what it paid on a fee GAM had already taken off and given back to you',
          }, client)
          takenBackCents += back
          continue
        }
        // Nic G1: the pull's own $6 is GAM's price for a transfer that
        // collects, and this one came back — voided, as on a failed pull
        // (kept on record). One that cannot be voided stays owed with the fees.
        if (t.charge_id === ownCostLine && await voidGamCharge(client, t.charge_id, 'bank_debit_failed')) {
          costLineCents += back
          continue
        }
        reopenedCents += back
        charges++
      }
      // The $6 GAM wrote down as earned when the pull landed (settleGamDebit,
      // banking_spread) is taken back off GAM's book — once per pull, as a
      // disputed tenant payment's spread is (paymentReversal reverseChargeSpread).
      if (costLineCents > 0) {
        const booked = (await client.query<{ s: string; done: boolean }>(
          `SELECT COALESCE(SUM(amount) FILTER (WHERE type = 'banking_spread' AND reference_type = 'gam_bank_debit'), 0)::text AS s,
                  bool_or(reference_type = 'dispute_spread_reversal') AS done
             FROM platform_revenue_ledger WHERE reference_id = $1`, [pull.id])).rows[0]
        const bookedCents = Math.round(parseFloat(booked?.s ?? '0') * 100)
        if (bookedCents > 0 && !booked?.done) {
          await recordPlatformRevenue({
            type: 'adjustment',
            amount: -bookedCents / 100,
            referenceId: pull.id,
            referenceType: 'dispute_spread_reversal',
            notes: `Bank transfer cost taken back: the landlord's bank disputed GAM's fee pull ${pull.id} (dispute ${d.stripeDisputeId})`,
          }, client)
        }
      }
      await client.query(
        `UPDATE landlord_gam_debits
            SET disputed_at = NOW(), stripe_dispute_id = $2, dispute_reopened_amount = $3, updated_at = NOW()
          WHERE id = $1`, [pull.id, d.stripeDisputeId, (reopenedCents / 100).toFixed(2)])
    } else if (now.stripe_dispute_id !== d.stripeDisputeId) {
      // A second dispute on one pull cannot take the money twice: told, never reopened again.
      await client.query('COMMIT')
      await noticeOncePerDispute(GAM_DEBIT_DISPUTE_UNPLACED_CATEGORY, d.stripeDisputeId, {
        severity: 'critical',
        title: `A second dispute on GAM's fee pull of ${day} from ${who} (${d.paymentIntentId})`,
        body: `Stripe opened dispute ${d.stripeDisputeId} on pull ${pull.id}, already reopened for dispute ${now.stripe_dispute_id}. Nothing was reopened again. Check it in Stripe by hand.`,
        context: { ...ctx, first_dispute: now.stripe_dispute_id },
      })
      return { handled: true, action: 'unplaced', debitId: pull.id }
    }
    await client.query('COMMIT')
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    client.release()
  }

  // What the pull cost GAM, at cost — once, when Stripe says it (this event's
  // word on the dispute fee, else read from Stripe); a $15 billed while Stripe
  // had not said it is corrected by the event that does. Never throws.
  const cost = await billDisputedPullCost(pull.id, d.feeStated ? Math.max(0, Math.round(d.feeCents)) : null)
  const costBilled = cost.read && cost.costCents != null ? cost.costCents / 100 : null

  if (action === 'reopened') {
    logger.warn({ debitId: pull.id, landlordId: pull.landlord_id, reopened: reopenedCents / 100, costLine: costLineCents / 100,
                  takenBack: takenBackCents / 100, stripeDisputeId: d.stripeDisputeId },
      '[gam-debit] the landlord\'s bank disputed a pull — its fees are owed again')
    await noticeOncePerDispute(GAM_DEBIT_DISPUTED_CATEGORY, d.stripeDisputeId, {
      severity: 'warn',
      title: `${who}'s bank disputed GAM's fee pull of ${day} (${usd(totalCents)}): the fees are owed again`,
      body: `Stripe opened dispute ${d.stripeDisputeId} on pull ${pull.id} and took back ${usd(d.disputedCents)}. `
        + (charges > 0
          ? `The ${charges} charge${charges === 1 ? '' : 's'} it paid (${usd(reopenedCents)}) ${charges === 1 ? 'is' : 'are'} owed by ${who} again and `
            + `${charges === 1 ? 'is' : 'are'} collected from their next payout, or on the next pull. `
          : '')
        + (costLineCents > 0
          ? `The pull's own ${usd(costLineCents)} bank transfer cost was taken off: GAM's price is for a transfer that collects. `
          : '')
        + (takenBackCents > 0
          ? `${usd(takenBackCents)} it paid on a fee GAM has since taken off had already been given back to ${who} (a payout line); `
            + 'the dispute returned it to them again, so it is taken back from their next payout. '
          : '')
        + (costBilled == null
          ? 'What the pull cost GAM at Stripe could not be read yet; it is billed to them at cost when it is (the nightly sweep asks again, '
            + 'and bills Stripe\'s usual $15 dispute fee if Stripe has still not said its own after three days).'
          : costBilled > 0
            ? `What the pull cost GAM at Stripe (${usd(Math.round(costBilled * 100))}: its fee on the transfer and the dispute fee) is billed to them at cost.`
            : 'Stripe charged nothing for it.'),
      context: { ...ctx, reopened: reopenedCents / 100, charges, cost_line_voided: costLineCents / 100, taken_back: takenBackCents / 100,
                 cost_billed: costBilled },
    }).catch((err) => logger.error({ err, debitId: pull.id }, '[gam-debit] could not tell an admin about the disputed pull'))
  }
  return { handled: true, action, debitId: pull.id, reopened: reopenedCents / 100, takenBack: takenBackCents / 100, costBilled }
}

/**
 * Stripe's fee for a dispute, read from Stripe: the fees on its balance
 * transactions (the same sum the webhook reads off an event). null when the
 * dispute has no balance transaction yet — Stripe has not said it.
 */
export async function disputeFeeCentsFromStripe(
  stripe: { disputes: { retrieve: (id: string) => Promise<any> } },
  stripeDisputeId: string,
): Promise<number | null> {
  return (await disputeFeesFromStripe(stripe, stripeDisputeId)).fee
}

/**
 * 10/13: Stripe's dispute fee and, on a won dispute, the part of it Stripe
 * gave back — both read from the dispute itself (stripeCosts
 * disputeFeeReturnedOnWinCents, the rule the webhook reads). `fee` null: the
 * dispute has no balance transaction yet.
 */
export async function disputeFeesFromStripe(
  stripe: { disputes: { retrieve: (id: string) => Promise<any> } },
  stripeDisputeId: string,
): Promise<{ fee: number | null; returned: number }> {
  const dp = await stripe.disputes.retrieve(stripeDisputeId)
  const bts: any[] = Array.isArray(dp?.balance_transactions) ? dp.balance_transactions : []
  if (!bts.length) return { fee: null, returned: 0 }
  const fee = bts.reduce((s, bt) => {
    if (typeof bt === 'string') throw new Error(`Stripe did not include balance transaction ${bt} on dispute ${stripeDisputeId}`)
    return s + Math.max(0, Math.round(Number(bt?.fee) || 0))
  }, 0)
  const { disputeFeeReturnedOnWinCents } = await import('./stripeCosts')
  return { fee, returned: disputeFeeReturnedOnWinCents(dp) }
}

/**
 * 10/13: the part of its dispute fee Stripe gave back with a win, in cents, as
 * the dispute's own webhooks said it (stored before processing —
 * stripeCosts.disputeFeeReturnedOnWinSql). 0 when none says so.
 */
async function storedFeeReturnedCents(stripeDisputeId: string): Promise<number> {
  const { disputeFeeReturnedOnWinSql } = await import('./stripeCosts')
  const r = await queryOne<{ back: string }>(
    `SELECT (${disputeFeeReturnedOnWinSql('cd')})::text AS back FROM (SELECT $1::text AS stripe_dispute_id) cd`,
    [stripeDisputeId])
  return Math.max(0, toCents(r?.back))
}

/**
 * 10/13 (Nic): bring the bill for what a dispute costs the landlord to
 * `targetCents`, never billing twice. The charge billing it now (if any) is
 * voided — `voidReason`, kept on record — and what was already collected on it
 * is given back on their next payout (gamChargeVoidedGiveBackSourceId); the
 * new amount, when above zero, is a new charge (kind bank_debit_failed_cost,
 * source 'gam_bank_debit_disputed', source_id disputeCostRebillSourceId(pull,
 * basis)); the pull then names it (dispute_cost_*). Nothing changes when the
 * bill already says it. `ok: false` when the charge is inside a pull still
 * settling — its money is on its way, so the caller tries again later.
 *
 * Runs in the caller's transaction, after the account's lock and the pull's row.
 */
async function rebillDisputeCost(client: PoolClient, a: {
  debitId: string; landlordId: string; currentChargeId: string | null
  basis: DisputeCostBasis; targetCents: number; voidReason: 'dispute_won' | 'dispute_cost_rebilled'; notes: string
  giveBackWords: string
}): Promise<{ ok: boolean; changed: boolean; chargeId: string | null; givenBackCents: number }> {
  let givenBackCents = 0
  if (a.currentChargeId) {
    const c = (await client.query<{ amount: string; collected_amount: string; voided_at: Date | null; property_id: string | null; in_flight: boolean }>(
      `SELECT c.amount::text, c.collected_amount::text, c.voided_at, c.property_id, ${IN_PENDING_PULL_SQL('c')} AS in_flight
         FROM landlord_gam_charges c WHERE c.id = $1 FOR UPDATE`, [a.currentChargeId])).rows[0]
    if (c?.in_flight) return { ok: false, changed: false, chargeId: a.currentChargeId, givenBackCents: 0 }
    if (c && !c.voided_at && toCents(c.amount) === a.targetCents) {
      return { ok: true, changed: false, chargeId: a.currentChargeId, givenBackCents: 0 }
    }
    if (c && !c.voided_at) {
      await client.query(
        `UPDATE landlord_gam_charges SET voided_at = NOW(), void_reason = $2, updated_at = NOW() WHERE id = $1`,
        [a.currentChargeId, a.voidReason])
      givenBackCents = toCents(c.collected_amount)
      if (givenBackCents > 0) {
        const { recordHeldItem } = await import('./heldPayouts')
        await recordHeldItem({
          landlordId: a.landlordId, sourceType: 'refund', sourceId: gamChargeVoidedGiveBackSourceId(a.currentChargeId),
          amount: givenBackCents / 100, description: a.giveBackWords, property: { propertyId: c.property_id },
        }, client)
      }
    }
  } else if (a.targetCents === 0) {
    return { ok: true, changed: false, chargeId: null, givenBackCents: 0 }
  }
  let chargeId: string | null = null
  if (a.targetCents > 0) {
    const sourceId = disputeCostRebillSourceId(a.debitId, a.basis)
    chargeId = await chargeLandlord(client, {
      landlordId: a.landlordId, kind: 'bank_debit_failed_cost', amount: a.targetCents / 100,
      sourceType: GAM_DEBIT_DISPUTE_COST_SOURCE, sourceId, notes: a.notes,
    })
    chargeId ??= (await client.query<{ id: string }>(
      `SELECT id FROM landlord_gam_charges WHERE source_type = $1 AND source_id = $2`,
      [GAM_DEBIT_DISPUTE_COST_SOURCE, sourceId])).rows[0]?.id ?? null
  }
  await client.query(
    `UPDATE landlord_gam_debits SET dispute_cost_amount = $2, dispute_cost_charge_id = $3, updated_at = NOW() WHERE id = $1`,
    [a.debitId, (a.targetCents / 100).toFixed(2), chargeId])
  return { ok: true, changed: true, chargeId, givenBackCents }
}

/**
 * 10/13 (Nic G1, "gam eats no fees of failed pulls ever", on a later return
 * alike): what a disputed pull actually cost GAM is the landlord's, at cost —
 * Stripe's fee on the pull itself (the $6 that paid for it was voided with the
 * dispute) and Stripe's dispute fee. Billed as its own GAM charge, kind
 * 'bank_debit_failed_cost', source 'gam_bank_debit_disputed', collected like
 * every other GAM charge; idempotent per pull (its source is the pull) and
 * recorded on the pull (dispute_cost_*, dispute_fee_*). After a win
 * (dispute_won_at) only the part of the dispute fee Stripe kept is theirs —
 * the $6 is back and covers the pull's own fee again.
 *
 * `disputeFeeCents`: the dispute fee an event stated (null: read the dispute
 * from Stripe). Stripe unreadable, or the dispute fee not said yet: nothing is
 * billed and the cost stays unread; the nightly sweep (readDisputedPullCosts)
 * asks again — and, `assumeIfSilent` (three days on), 10/13 (Nic): "Dispute
 * fee unknown → bill $15": Stripe's usual dispute fee is billed in its place
 * (dispute_fee_assumed_at). A pull billed that way is read again on every
 * call: once Stripe states its fee, the bill is corrected to it
 * (rebillDisputeCost, reason 'dispute_cost_rebilled'), never billed twice.
 * Never throws.
 */
export async function billDisputedPullCost(
  debitId: string, disputeFeeCents: number | null = null, opts: { assumeIfSilent?: boolean } = {},
): Promise<{ read: boolean; costCents: number | null; chargeId: string | null; assumed?: boolean; corrected?: boolean }> {
  type State = {
    landlord_id: string; created_at: Date; pi: string | null; dispute_id: string | null; business_name: string | null
    disputed: boolean; won: boolean; read: boolean; cost_cents: number | null; charge_id: string | null
    fee_cents: number | null; assumed: boolean; stated: boolean
  }
  const STATE_SQL =
    `SELECT d.landlord_id, d.created_at, d.stripe_payment_intent_id AS pi, d.stripe_dispute_id AS dispute_id, l.business_name,
            d.disputed_at IS NOT NULL AS disputed, d.dispute_won_at IS NOT NULL AS won, d.dispute_cost_read_at IS NOT NULL AS read,
            ROUND(d.dispute_cost_amount * 100)::int AS cost_cents, d.dispute_cost_charge_id AS charge_id,
            ROUND(d.dispute_fee_amount * 100)::int AS fee_cents,
            d.dispute_fee_assumed_at IS NOT NULL AS assumed, d.dispute_fee_stated_at IS NOT NULL AS stated
       FROM landlord_gam_debits d LEFT JOIN landlords l ON l.id = d.landlord_id WHERE d.id = $1`
  const unread = { read: false, costCents: null, chargeId: null }
  /** A $15 billed in place of the fee Stripe had not stated: it waits on Stripe's word. */
  const waiting = (s: State) => s.read && s.assumed && !s.stated
  try {
    const d = await queryOne<State>(STATE_SQL, [debitId])
    if (!d || !d.disputed || !d.dispute_id) return unread
    const current = () => ({ read: true, costCents: d.cost_cents, chargeId: d.charge_id })
    if (d.read && !waiting(d)) return current()

    let fee: number | null = disputeFeeCents == null ? null : Math.max(0, Math.round(disputeFeeCents))
    let returned = 0
    let pullFee = 0
    let assumed = false
    try {
      const stripe = getStripe() as any
      if (fee == null) ({ fee, returned } = await disputeFeesFromStripe(stripe, d.dispute_id))
      if (fee == null) {
        if (d.read) return current()  // still the $15 — asked again next sweep
        if (!opts.assumeIfSilent) {
          logger.warn({ debitId, stripeDisputeId: d.dispute_id }, '[gam-debit] Stripe has not said the dispute fee on a disputed pull yet — asked again next sweep')
          return unread
        }
        fee = STRIPE_USUAL_DISPUTE_FEE_CENTS
        assumed = true
      }
      // A pull that went through has no failure fee: this reads its own fee.
      // Only a first bill before a win needs it (a correction keeps the one billed).
      if (!d.read && !d.won && d.pi) pullFee = Math.max(0, await failedPullCostCents(stripe, d.pi))
    } catch (err) {
      logger.warn({ err, debitId }, '[gam-debit] what the disputed pull cost could not be read from Stripe — asked again next sweep')
      return d.read ? current() : unread
    }
    if (d.won) returned = Math.max(returned, await storedFeeReturnedCents(d.dispute_id))

    const day = pullDay(d.created_at)
    const who = d.business_name ?? 'the landlord'
    let out: { read: boolean; costCents: number | null; chargeId: string | null; assumed?: boolean; corrected?: boolean } = unread
    let was: number | null = null
    const client = await getClient()
    try {
      await client.query('BEGIN')
      await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [gamAccountLockKey(d.landlord_id)])
      const now = (await client.query<State>(`${STATE_SQL} FOR UPDATE OF d`, [debitId])).rows[0]
      // Read meanwhile (a redelivered event, or the sweep), or won meanwhile:
      // what it says now stands, and the next call reads it afresh.
      if (!now?.disputed || (now.read && !waiting(now)) || now.won !== d.won || now.read !== d.read) {
        await client.query('ROLLBACK')
        const latest = await queryOne<State>(STATE_SQL, [debitId])
        return latest?.read ? { read: true, costCents: latest.cost_cents, chargeId: latest.charge_id } : unread
      }
      if (!now.read) {
        // The first bill: Stripe's fee on the pull and the dispute fee — after
        // a win, only what Stripe kept of its dispute fee.
        const target = now.won ? Math.max(0, fee - returned) : pullFee + fee
        let chargeId: string | null = null
        if (target > 0) {
          chargeId = await chargeLandlord(client, {
            landlordId: now.landlord_id,
            kind: 'bank_debit_failed_cost',
            amount: target / 100,
            sourceType: GAM_DEBIT_DISPUTE_COST_SOURCE,
            sourceId: debitId,
            notes: now.won
              ? `The part of Stripe's dispute fee it kept when GAM won the dispute your bank opened on the ${day} bank transfer of GAM's fees, passed on at cost`
              : `What Stripe charged for the ${day} bank transfer of GAM's fees that your bank disputed (its fee on the transfer and its dispute fee`
                + (assumed ? ', $15 — Stripe\'s usual dispute fee, as Stripe has not stated its own' : '') + '), passed on at cost',
          })
          chargeId ??= (await client.query<{ id: string }>(
            `SELECT id FROM landlord_gam_charges WHERE source_type = $1 AND source_id = $2`,
            [GAM_DEBIT_DISPUTE_COST_SOURCE, debitId])).rows[0]?.id ?? null
        }
        await client.query(
          `UPDATE landlord_gam_debits
              SET dispute_cost_amount = $2, dispute_cost_charge_id = $3, dispute_cost_read_at = NOW(),
                  dispute_fee_amount = $4,
                  dispute_fee_assumed_at = CASE WHEN $5 THEN NOW() END,
                  dispute_fee_stated_at = CASE WHEN $5 THEN NULL ELSE NOW() END,
                  updated_at = NOW()
            WHERE id = $1`,
          [debitId, (target / 100).toFixed(2), chargeId, (fee / 100).toFixed(2), assumed])
        out = { read: true, costCents: target, chargeId, assumed }
      } else {
        // 10/13 (Nic): Stripe has stated the fee the $15 stood in for — the bill
        // is corrected to it (the pull's own fee, billed with the $15, stays).
        const pullFeeBilled = now.won ? 0 : Math.max(0, (now.cost_cents ?? 0) - (now.fee_cents ?? 0))
        const target = now.won ? Math.max(0, fee - returned) : pullFeeBilled + fee
        const r = await rebillDisputeCost(client, {
          debitId, landlordId: now.landlord_id, currentChargeId: now.charge_id,
          basis: now.won ? 'won_stated' : 'stated', targetCents: target, voidReason: 'dispute_cost_rebilled',
          notes: now.won
            ? `The part of Stripe's dispute fee it kept when GAM won the dispute your bank opened on the ${day} bank transfer of GAM's fees, passed on at cost (corrected to the fee Stripe stated)`
            : `What Stripe charged for the ${day} bank transfer of GAM's fees that your bank disputed (its fee on the transfer and its dispute fee), passed on at cost — corrected to the dispute fee Stripe stated, in place of the $15 billed before`,
          giveBackWords: 'Given back: the $15 dispute fee GAM billed in place of the one Stripe had not stated, now corrected to Stripe\'s own',
        })
        if (!r.ok) {
          // The $15 is inside a pull still settling: corrected once it settles.
          await client.query('ROLLBACK')
          return current()
        }
        await client.query(
          `UPDATE landlord_gam_debits SET dispute_fee_amount = $2, dispute_fee_stated_at = NOW(), updated_at = NOW() WHERE id = $1`,
          [debitId, (fee / 100).toFixed(2)])
        was = now.cost_cents
        out = { read: true, costCents: target, chargeId: r.chargeId, corrected: r.changed }
      }
      await client.query('COMMIT')
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {})
      throw e
    } finally {
      client.release()
    }

    const ctx = { debit_id: debitId, landlord_id: d.landlord_id, payment_intent_id: d.pi }
    if (out.assumed) {
      logger.warn({ debitId, landlordId: d.landlord_id, cost: (out.costCents ?? 0) / 100 },
        '[gam-debit] Stripe never said the dispute fee on a disputed pull — $15 billed in its place')
      await noticeOncePerDispute(GAM_DEBIT_DISPUTE_FEE_ASSUMED_CATEGORY, d.dispute_id, {
        severity: 'info',
        title: `Stripe has not said its fee on the dispute of GAM's fee pull of ${day} from ${who}: $15 billed`,
        body: `Dispute ${d.dispute_id} on pull ${debitId}: Stripe has still not stated its dispute fee, so ${who} was billed `
          + `${usd(out.costCents ?? 0)} for it — Stripe's usual $15 dispute fee`
          + (d.won ? '' : ' and its fee on the transfer') + '. When Stripe states its fee, the bill is corrected to it.',
        context: { ...ctx, cost_billed: (out.costCents ?? 0) / 100 },
      }).catch(() => {})
    } else if (out.corrected) {
      logger.warn({ debitId, landlordId: d.landlord_id, was: (was ?? 0) / 100, now: (out.costCents ?? 0) / 100 },
        '[gam-debit] the $15 billed for a dispute fee was corrected to the fee Stripe stated')
      await noticeOncePerDispute(GAM_DEBIT_DISPUTE_FEE_CORRECTED_CATEGORY, d.dispute_id, {
        severity: 'info',
        title: `The dispute fee billed to ${who} was corrected to Stripe's own (${usd(was ?? 0)} → ${usd(out.costCents ?? 0)})`,
        body: `Dispute ${d.dispute_id} on pull ${debitId}: Stripe stated its dispute fee (${usd(fee)}) after $15 had been billed in its place. `
          + `The bill was replaced: ${usd(out.costCents ?? 0)} now, and anything already collected on the old one is given back on their next payout.`,
        context: { ...ctx, was: (was ?? 0) / 100, now: (out.costCents ?? 0) / 100, stated_fee: fee / 100 },
      }).catch(() => {})
    } else if (out.read && (out.costCents ?? 0) > 0 && !d.read) {
      logger.warn({ debitId, landlordId: d.landlord_id, cost: (out.costCents ?? 0) / 100 },
        '[gam-debit] a disputed pull cost GAM fees — billed to the landlord at cost')
    }
    return out
  } catch (err) {
    logger.error({ err, debitId }, '[gam-debit] the cost of a disputed pull could not be billed — asked again next sweep')
    return unread
  }
}

/**
 * 10/13 (G1): the nightly sweep's pass over disputed pulls whose cost was
 * never read (Stripe could not be reached, or had not said its dispute fee):
 * read and bill it now. Pulls disputed in the last 60 days. 10/13 (Nic):
 * "Dispute fee unknown → bill $15" — one whose dispute fee Stripe has still
 * not stated after FAILED_PULL_COST_UNREAD_DAYS is billed with $15 in its
 * place, and read again every night after that until Stripe states it (the
 * bill is then corrected to it). One Stripe could not be read for at all in
 * that time tells an admin (once per dispute) — a cost nobody reads is a cost
 * GAM absorbs. `read` counts first bills only.
 */
export async function readDisputedPullCosts(): Promise<{ considered: number; read: number }> {
  const rows = await query<{
    id: string; landlord_id: string; stripe_payment_intent_id: string | null; stripe_dispute_id: string
    disputed_at: Date; total_amount: string; was_read: boolean
  }>(
    `SELECT id, landlord_id, stripe_payment_intent_id, stripe_dispute_id, disputed_at, total_amount::text AS total_amount,
            dispute_cost_read_at IS NOT NULL AS was_read
       FROM landlord_gam_debits
      WHERE disputed_at IS NOT NULL
        AND (dispute_cost_read_at IS NULL OR (dispute_fee_assumed_at IS NOT NULL AND dispute_fee_stated_at IS NULL))
        AND disputed_at > NOW() - INTERVAL '60 days'
      ORDER BY disputed_at`)
  let read = 0
  for (const r of rows) {
    const late = Date.now() - new Date(r.disputed_at).getTime() >= FAILED_PULL_COST_UNREAD_DAYS * 86_400_000
    const out = await billDisputedPullCost(r.id, null, { assumeIfSilent: late })
    if (r.was_read) continue
    if (out.read) { read++; continue }
    if (!late) continue
    await noticeOncePerDispute(GAM_DEBIT_DISPUTE_COST_UNREAD_CATEGORY, r.stripe_dispute_id, {
      severity: 'warn',
      title: `What a disputed $${Number(r.total_amount).toFixed(2)} bank pull of GAM's fees cost has not been read from Stripe`,
      body: `Pull ${r.id} (payment ${r.stripe_payment_intent_id ?? 'unknown'}) was disputed (${r.stripe_dispute_id}), and Stripe's fees on it — its fee on the transfer and its dispute fee — could not be read, so the landlord has not been billed for them. `
        + 'Check the dispute in Stripe; the nightly sweep keeps asking.',
      context: { debit_id: r.id, landlord_id: r.landlord_id, payment_intent_id: r.stripe_payment_intent_id },
    }).catch(() => {})
  }
  return { considered: rows.length, read }
}

export interface WonGamDebitDisputeInput {
  debitId: string
  stripeDisputeId: string
  /** Stripe's dispute fee as the event carrying the win stated it (null: not stated on it). */
  eventFeeCents?: number | null
  /** The part of its dispute fee Stripe gave back, as the event carrying the win stated it. */
  eventReturnedCents?: number | null
  /** What Stripe put back (the disputed amount), for the admin's notice. */
  disputedCents?: number | null
}

export interface WonGamDebitDisputeOutcome {
  /** 'won_waiting': a charge is inside a later pull still settling — undone by the nightly sweep once it settles. */
  action: 'won' | 'won_waiting'
  /** Already undone by an earlier event or sweep: nothing changed now. */
  already?: boolean
  /** Dollars put back to collected (the pull's own $6 included). */
  restored: number
  /** Dollars given back to the landlord on their next payout. */
  givenBack: number
  /** What the dispute still costs the landlord (what Stripe kept of its fee); null: not read yet. */
  costBilled: number | null
}

/**
 * 10/13 (Nic): "Won GAM pull dispute: AUTOMATIC (back to collected; anything
 * collected twice credited back)." Stripe decided the landlord's bank's
 * dispute on a pull of GAM's fees for GAM and put the money back. In one
 * transaction, under the account's lock and the pull's row, once
 * (dispute_won_at):
 *   - every charge the pull collected goes back to collected by what the pull
 *     took for it (its collection records count again — they were never
 *     removed);
 *   - the pull's own $6 cost line, voided when the dispute opened, is
 *     un-voided and collected again — the transfer collected after all, so
 *     GAM's price for it stands (its void stays in the change journal) — and
 *     the $6 taken back off GAM's book is put back;
 *   - what a charge can no longer take — it was collected again meanwhile, by
 *     a payout or a later pull, or was voided (a charge voided before the
 *     dispute opened had this pull's part of its give-back taken back then,
 *     gamChargeVoidedTakeBackSourceId) — is given back to the landlord on
 *     their next payout (a positive held line, gamDebitWonGiveBackSourceId);
 *   - the dispute's cost charge is voided ('dispute_won'), anything collected
 *     on it given back; only the part of Stripe's dispute fee Stripe kept, if
 *     any, stays theirs (Nic G1) and is billed again on its own;
 *   - an admin is told, once.
 * A charge inside a later pull still settling holds it all back ('won_waiting'
 * — that money is on its way); the nightly sweep (applyWonGamDebitDisputes)
 * undoes it once that pull settles. A dispute that never reopened the pull
 * (an inquiry, a part dispute, a second dispute) has nothing to undo; an
 * admin is told so. Throws only on a database failure.
 */
export async function applyWonGamDebitDispute(w: WonGamDebitDisputeInput): Promise<WonGamDebitDisputeOutcome> {
  const p = await queryOne<{
    id: string; landlord_id: string; created_at: Date; pi: string | null; business_name: string | null
    disputed: boolean; stripe_dispute_id: string | null; won: boolean
    restored: string | null; given_back: string | null; cost: string | null
  }>(
    `SELECT d.id, d.landlord_id, d.created_at, d.stripe_payment_intent_id AS pi, l.business_name,
            d.disputed_at IS NOT NULL AS disputed, d.stripe_dispute_id, d.dispute_won_at IS NOT NULL AS won,
            d.dispute_won_restored_amount::text AS restored, d.dispute_won_given_back_amount::text AS given_back,
            d.dispute_cost_amount::text AS cost
       FROM landlord_gam_debits d LEFT JOIN landlords l ON l.id = d.landlord_id WHERE d.id = $1`, [w.debitId])
  const none: WonGamDebitDisputeOutcome = { action: 'won', restored: 0, givenBack: 0, costBilled: null }
  if (!p) return none
  const day = pullDay(p.created_at)
  const who = p.business_name ?? 'the landlord'
  const ctx = { debit_id: p.id, landlord_id: p.landlord_id, stripe_payment_intent_id: p.pi }
  const putBack = w.disputedCents != null ? ` and put back ${usd(Math.max(0, w.disputedCents))}` : ''

  // Nothing was reopened for this dispute: nothing to undo.
  if (!p.disputed || p.stripe_dispute_id !== w.stripeDisputeId) {
    await noticeOncePerDispute(GAM_DEBIT_DISPUTE_WON_CATEGORY, w.stripeDisputeId, {
      severity: 'info',
      title: `A dispute on GAM's fee pull was won: nothing to undo (${p.pi ?? p.id})`,
      body: `Stripe decided dispute ${w.stripeDisputeId} on GAM's fee pull of ${day} from ${who} for GAM${putBack}. `
        + 'Nothing was reopened for it, so nothing changed.',
      context: ctx,
    }).catch((err) => logger.error({ err, debitId: p.id }, '[gam-debit] could not tell an admin about the won dispute'))
    return none
  }
  if (p.won) {
    return { action: 'won', already: true, restored: toCents(p.restored) / 100, givenBack: toCents(p.given_back) / 100,
             costBilled: p.cost == null ? null : toCents(p.cost) / 100 }
  }

  // What Stripe gave back of its dispute fee with the win: the event's word,
  // or what the dispute's stored webhooks said (the same rule).
  const returned = Math.max(Math.max(0, w.eventReturnedCents ?? 0), await storedFeeReturnedCents(w.stripeDisputeId))

  let restoredCents = 0
  let twiceCents = 0
  let voidedBackCents = 0
  let costGivenBackCents = 0
  let costLineCents = 0
  let charges = 0
  let costWas: number | null = null
  let costNow: number | null = null
  const client = await getClient()
  try {
    await client.query('BEGIN')
    await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [gamAccountLockKey(p.landlord_id)])
    const now = (await client.query<{
      won_at: Date | null; read: boolean; cost_cents: number | null; charge_id: string | null
      fee_cents: number | null; assumed: boolean; stated: boolean
    }>(
      `SELECT dispute_won_at AS won_at, dispute_cost_read_at IS NOT NULL AS read,
              ROUND(dispute_cost_amount * 100)::int AS cost_cents, dispute_cost_charge_id AS charge_id,
              ROUND(dispute_fee_amount * 100)::int AS fee_cents,
              dispute_fee_assumed_at IS NOT NULL AS assumed, dispute_fee_stated_at IS NOT NULL AS stated
         FROM landlord_gam_debits WHERE id = $1 FOR UPDATE`, [p.id])).rows[0]
    if (now.won_at) {
      await client.query('ROLLBACK')
      return applyWonGamDebitDispute(w)
    }
    const ownCostLine = (await client.query<{ id: string }>(PULL_OWN_COST_LINE_SQL, [p.id])).rows[0]?.id ?? null
    // What the pull took for each charge (its collection records, kept as written).
    const took = (await client.query<{ charge_id: string; amount: string }>(
      `SELECT charge_id, SUM(amount)::text AS amount FROM landlord_gam_charge_collections
        WHERE landlord_gam_debit_id = $1 GROUP BY charge_id ORDER BY charge_id`, [p.id])).rows
    const ids = [...new Set([...took.map(t => t.charge_id), ...(now.charge_id ? [now.charge_id] : [])])]
    const rows = (await client.query<{
      id: string; amount: string; collected_amount: string; voided_at: Date | null; void_reason: string | null
      property_id: string | null; in_flight: boolean
    }>(
      `SELECT c.id, c.amount::text, c.collected_amount::text, c.voided_at, c.void_reason, c.property_id,
              ${IN_PENDING_PULL_SQL('c')} AS in_flight
         FROM landlord_gam_charges c WHERE c.id = ANY($1::uuid[]) ORDER BY c.id FOR UPDATE`, [ids])).rows
    const byId = new Map(rows.map(r => [r.id, r]))
    const inFlight = rows.filter(r => r.in_flight).map(r => r.id)
    if (inFlight.length) {
      // That money is on its way in a later pull: undone once it settles.
      await client.query('ROLLBACK')
      logger.info({ debitId: p.id, stripeDisputeId: w.stripeDisputeId, inFlight },
        '[gam-debit] a won pull dispute waits on a later pull still settling — the nightly sweep undoes it')
      return { action: 'won_waiting', restored: 0, givenBack: 0, costBilled: null }
    }

    const { recordHeldItem } = await import('./heldPayouts')
    // 10/13 review: said as it is — collected twice, or voided since (a fee
    // nobody owes is not "collected again").
    const giveBack = async (chargeId: string, cents: number, propertyId: string | null, why: 'twice' | 'voided') => {
      if (cents <= 0) return
      await recordHeldItem({
        landlordId: p.landlord_id, sourceType: 'refund', sourceId: gamDebitWonGiveBackSourceId(p.id, chargeId),
        amount: cents / 100, property: { propertyId },
        description: why === 'twice'
          ? 'Given back: GAM won the dispute your bank opened on a bank transfer of GAM\'s fees, and this fee had been collected again meanwhile'
          : 'Given back: GAM won the dispute your bank opened on a bank transfer of GAM\'s fees, and this fee has since been taken off',
      }, client)
      if (why === 'twice') twiceCents += cents
      else voidedBackCents += cents
    }
    for (const t of took) {
      const c = byId.get(t.charge_id)
      const tookCents = toCents(t.amount)
      if (!c || tookCents <= 0) continue
      // The pull's own $6, voided when the dispute opened: the transfer
      // collected after all, so GAM's price for it stands — collected again.
      if (t.charge_id === ownCostLine && c.voided_at && c.void_reason === 'bank_debit_failed') {
        const back = Math.min(tookCents, toCents(c.amount))
        await client.query(
          `UPDATE landlord_gam_charges
              SET voided_at = NULL, void_reason = NULL, collected_amount = $2, collected_at = NOW(), updated_at = NOW()
            WHERE id = $1`, [c.id, (back / 100).toFixed(2)])
        restoredCents += back
        costLineCents += back
        await giveBack(c.id, tookCents - back, c.property_id, 'twice')
        continue
      }
      // Voided since: nobody owes it, so what the pull took for it is theirs.
      // Voided before this dispute opened (a dispute's cost a win or a re-bill
      // took back, its collections given back whole), the dispute took this
      // pull's part of that give-back back (gamChargeVoidedTakeBackSourceId):
      // the win stands the pull's collection again, so it is given back again —
      // counted once either way.
      if (c.voided_at) { await giveBack(c.id, tookCents, c.property_id, 'voided'); continue }
      const room = Math.max(0, toCents(c.amount) - toCents(c.collected_amount))
      const restore = Math.min(tookCents, room)
      if (restore > 0) {
        await client.query(
          `UPDATE landlord_gam_charges
              SET collected_amount = collected_amount + $2::numeric,
                  collected_at = CASE WHEN collected_amount + $2::numeric >= amount THEN NOW() ELSE collected_at END,
                  updated_at = NOW()
            WHERE id = $1`, [c.id, (restore / 100).toFixed(2)])
        restoredCents += restore
        charges++
      }
      // Collected again meanwhile (a payout, a later pull): collected twice.
      await giveBack(c.id, tookCents - restore, c.property_id, 'twice')
    }

    // GAM's own book: the $6 taken back when the dispute opened is earned
    // again — a banking spread of its own (one per pull: the book's
    // (reference, type) is unique), so the processing margin reads it.
    if (costLineCents > 0) {
      const off = toCents((await client.query<{ s: string }>(
        `SELECT COALESCE(SUM(amount), 0)::text AS s FROM platform_revenue_ledger
          WHERE reference_id = $1 AND type = 'adjustment' AND reference_type = 'dispute_spread_reversal'`, [p.id])).rows[0]?.s)
      if (off < 0) {
        await recordPlatformRevenue({
          type: 'banking_spread',
          amount: -off / 100,
          referenceId: p.id,
          referenceType: GAM_DEBIT_DISPUTE_WON_SPREAD_REFERENCE,
          notes: `Bank transfer cost earned again: GAM won the dispute on its fee pull ${p.id} (dispute ${w.stripeDisputeId}) — the transfer collected after all`,
        }, client)
      }
    }

    // The dispute's cost: only what Stripe kept of its dispute fee stays theirs (Nic G1).
    if (now.read) {
      const fee = w.eventFeeCents ?? now.fee_cents ?? now.cost_cents ?? 0
      const stated = w.eventFeeCents != null || now.stated || !now.assumed
      const target = Math.max(0, fee - returned)
      costWas = now.cost_cents
      const r = await rebillDisputeCost(client, {
        debitId: p.id, landlordId: p.landlord_id, currentChargeId: now.charge_id,
        basis: stated ? 'won_stated' : 'won_assumed', targetCents: target, voidReason: 'dispute_won',
        notes: `The part of Stripe's dispute fee it kept when GAM won the dispute your bank opened on the ${day} bank transfer of GAM's fees, passed on at cost`,
        giveBackWords: 'Given back: GAM won the dispute your bank opened on a bank transfer of GAM\'s fees, so what the dispute cost is taken off',
      })
      costGivenBackCents = r.givenBackCents
      costNow = target
      if (w.eventFeeCents != null) {
        await client.query(
          `UPDATE landlord_gam_debits SET dispute_fee_amount = $2, dispute_fee_stated_at = COALESCE(dispute_fee_stated_at, NOW()) WHERE id = $1`,
          [p.id, (w.eventFeeCents / 100).toFixed(2)])
      }
    } else if (w.eventFeeCents != null) {
      // Never read before the win: billed now, only what Stripe kept.
      const target = Math.max(0, w.eventFeeCents - returned)
      let chargeId: string | null = null
      if (target > 0) {
        chargeId = await chargeLandlord(client, {
          landlordId: p.landlord_id, kind: 'bank_debit_failed_cost', amount: target / 100,
          sourceType: GAM_DEBIT_DISPUTE_COST_SOURCE, sourceId: p.id,
          notes: `The part of Stripe's dispute fee it kept when GAM won the dispute your bank opened on the ${day} bank transfer of GAM's fees, passed on at cost`,
        })
        chargeId ??= (await client.query<{ id: string }>(
          `SELECT id FROM landlord_gam_charges WHERE source_type = $1 AND source_id = $2`,
          [GAM_DEBIT_DISPUTE_COST_SOURCE, p.id])).rows[0]?.id ?? null
      }
      await client.query(
        `UPDATE landlord_gam_debits
            SET dispute_cost_amount = $2, dispute_cost_charge_id = $3, dispute_cost_read_at = NOW(),
                dispute_fee_amount = $4, dispute_fee_stated_at = NOW()
          WHERE id = $1`, [p.id, (target / 100).toFixed(2), chargeId, (w.eventFeeCents / 100).toFixed(2)])
      costNow = target
    }

    await client.query(
      `UPDATE landlord_gam_debits
          SET dispute_won_at = NOW(), dispute_won_restored_amount = $2, dispute_won_given_back_amount = $3, updated_at = NOW()
        WHERE id = $1`,
      [p.id, (restoredCents / 100).toFixed(2), ((twiceCents + voidedBackCents + costGivenBackCents) / 100).toFixed(2)])
    await client.query('COMMIT')
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    client.release()
  }

  const givenBackCents = twiceCents + voidedBackCents + costGivenBackCents
  logger.warn({ debitId: p.id, landlordId: p.landlord_id, restored: restoredCents / 100, givenBack: givenBackCents / 100,
                stripeDisputeId: w.stripeDisputeId }, '[gam-debit] GAM won the dispute on a pull — undone')
  const steps: string[] = []
  if (restoredCents - costLineCents > 0) {
    steps.push(`The ${charges} charge${charges === 1 ? '' : 's'} it had paid went back to collected (${usd(restoredCents - costLineCents)}).`)
  }
  if (costLineCents > 0) steps.push(`The pull's own ${usd(costLineCents)} bank transfer cost is collected again and back on GAM's book: the transfer collected after all.`)
  if (twiceCents > 0) steps.push(`${usd(twiceCents)} had been collected again meanwhile (collected twice); it is given back to ${who} on their next payout.`)
  if (voidedBackCents > 0) {
    steps.push(`${usd(voidedBackCents)} it had paid on fees taken off since is given back to ${who} on their next payout: nobody owes those fees.`)
  }
  if (costWas != null && costWas !== costNow) {
    steps.push(`What the dispute cost (${usd(costWas)}) was taken off`
      + (costGivenBackCents > 0 ? `; the ${usd(costGivenBackCents)} already collected on it is given back on their next payout` : '')
      + ((costNow ?? 0) > 0 ? `. Stripe kept ${usd(costNow ?? 0)} of its dispute fee, which stays theirs at cost.` : '.'))
  } else if (costWas == null && (costNow ?? 0) > 0) {
    steps.push(`Stripe kept ${usd(costNow ?? 0)} of its dispute fee, billed to them at cost.`)
  }
  await noticeOncePerDispute(GAM_DEBIT_DISPUTE_WON_CATEGORY, w.stripeDisputeId, {
    severity: 'info',
    title: `GAM won the dispute on its fee pull of ${day} from ${who}: the fees are collected again`,
    body: `Stripe decided dispute ${w.stripeDisputeId} on pull ${p.id} for GAM${putBack}. GAM undid the dispute by itself:\n`
      + (steps.length ? steps.map((s, i) => `${i + 1}. ${s}`).join('\n') : 'Nothing had been reopened, so nothing changed.'),
    context: { ...ctx, restored: restoredCents / 100, collected_twice: twiceCents / 100, voided_given_back: voidedBackCents / 100,
               cost_given_back: costGivenBackCents / 100,
               cost_line_restored: costLineCents / 100, cost_was: costWas == null ? null : costWas / 100,
               cost_now: costNow == null ? null : costNow / 100, fee_returned: returned / 100 },
  }).catch((err) => logger.error({ err, debitId: p.id }, '[gam-debit] could not tell an admin about the won dispute'))
  return { action: 'won', restored: restoredCents / 100, givenBack: givenBackCents / 100,
           costBilled: costNow == null ? null : costNow / 100 }
}

/**
 * 10/13 (Nic): the nightly sweep's pass over disputes GAM won whose undoing
 * has not run — it waited on a later pull still settling ('won_waiting'), or
 * no webhook carried the win through. The win on file (connect_disputes) is
 * undone now (applyWonGamDebitDispute; once, under the pull's row).
 */
export async function applyWonGamDebitDisputes(): Promise<{ considered: number; applied: number }> {
  const { DISPUTE_STATUS_WON } = await import('./creditUse')
  const rows = await query<{ id: string; stripe_dispute_id: string; amount: string }>(
    `SELECT d.id, d.stripe_dispute_id, cd.amount::text AS amount
       FROM landlord_gam_debits d
       JOIN connect_disputes cd ON cd.stripe_dispute_id = d.stripe_dispute_id
      WHERE d.disputed_at IS NOT NULL AND d.dispute_won_at IS NULL AND cd.status = $1
      ORDER BY d.disputed_at`, [DISPUTE_STATUS_WON])
  let applied = 0
  for (const r of rows) {
    try {
      const out = await applyWonGamDebitDispute({ debitId: r.id, stripeDisputeId: r.stripe_dispute_id, disputedCents: toCents(r.amount) })
      if (out.action === 'won' && !out.already) applied++
    } catch (err) {
      logger.error({ err, debitId: r.id }, '[gam-debit-sweep] could not undo a won pull dispute — tried again next sweep')
    }
  }
  return { considered: rows.length, applied }
}
