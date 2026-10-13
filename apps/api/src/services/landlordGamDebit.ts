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
