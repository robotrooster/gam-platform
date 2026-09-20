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
import { chargeLandlord, outstandingForLandlord, debitThresholdForLandlord } from './landlordGamAccount'
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

  // GATE 1 — worth a bank pull at all. Below the threshold the debt waits;
  // carrying $20 to next month is cheaper than the transfer to collect it.
  const [owed, threshold] = await Promise.all([
    outstandingForLandlord(landlordId),
    debitThresholdForLandlord(landlordId),
  ])
  if (owed <= 0) return { status: 'skipped', reason: 'nothing_owed' }
  if (owed < threshold) return { status: 'skipped', reason: 'under_threshold' }

  // GATE 2 — an ACH pull takes days to settle. Firing a second one tomorrow
  // for the same fees is how a landlord gets double-debited, so the unique
  // partial index and this check both guard it.
  const inFlight = await queryOne<{ id: string }>(
    `SELECT id FROM landlord_gam_debits WHERE landlord_id = $1 AND status = 'pending' LIMIT 1`,
    [landlordId])
  if (inFlight) return { status: 'skipped', reason: 'debit_in_flight' }

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
    const pm = await createDebitPaymentMethod(landlordId).catch(() => null)
    if (!pm) {
      logger.error({ landlordId, owed, threshold },
        '[gam-debit] OWES GAM AND CANNOT BE COLLECTED FROM — no usable bank link')
      return { status: 'skipped', reason: 'no_bank_link' }
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

  const bankCost = bankCostFor(owed)
  const stripe = getStripe()

  // The cost line is written BEFORE the pull and is itself part of what gets
  // pulled, so the landlord pays the fees and the cost of collecting them in
  // one movement rather than carrying a $1.04 debt into next month that would
  // itself one day need a $5 pull to collect.
  const client = await getClient()
  let debitId: string
  let total: number
  let chargeIds: string[]
  try {
    await client.query('BEGIN')

    const outstanding = await client.query<{ id: string }>(
      `SELECT id FROM landlord_gam_charges
        WHERE landlord_id = $1 AND collected_amount < amount
        ORDER BY created_at ASC FOR UPDATE`,
      [landlordId])
    chargeIds = outstanding.rows.map(r => r.id)

    let costChargeId: string | null = null
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
  try {
    const pi = await stripe.paymentIntents.create({
      amount: Math.round(total * 100),
      currency: 'usd',
      customer: customerId,
      payment_method: paymentMethodId,
      payment_method_types: ['us_bank_account'],
      confirm: true,
      off_session: true,
      // NACHA company-entry description — 8 chars, what prints on their
      // statement. A landlord reading "GAMFEES" knows what it is without
      // phoning anyone, which is the whole objective here.
      statement_descriptor: 'GAM FEES',
      description: `GAM charges + bank cost - Gold Asset Management`,
      metadata: {
        gam_debit_id: debitId,
        landlord_id: landlordId,
        charges_amount: owed.toFixed(2),
        bank_cost_amount: bankCost.toFixed(2),
        entry_description: 'GAMFEES',
      },
    } as Stripe.PaymentIntentCreateParams)

    await query(
      `UPDATE landlord_gam_debits
          SET stripe_payment_intent_id = $2, updated_at = NOW()
        WHERE id = $1`,
      [debitId, pi.id])

    logger.warn({ landlordId, debitId, owed, bankCost, total, pi: pi.id },
      '[gam-debit] no payout to net against — pulled from the bank')
    return { status: 'debited', debitId, chargesAmount: owed, bankCost, total }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    await query(
      `UPDATE landlord_gam_debits
          SET status = 'failed', failure_reason = $2, settled_at = NOW(), updated_at = NOW()
        WHERE id = $1`,
      [debitId, msg.slice(0, 500)])
    // The charges stay owed — including the cost line, which is now a debt
    // raised for a pull that never happened. Reverse it rather than dunning
    // somebody for the price of a transfer that did not occur.
    await query(
      `DELETE FROM landlord_gam_charges
        WHERE landlord_id = $1 AND kind = 'bank_debit_cost'
          AND collected_amount = 0
          AND source_type = 'gam_bank_debit_cost'
          AND created_at >= NOW() - INTERVAL '10 minutes'`,
      [landlordId]).catch(() => {})
    logger.error({ landlordId, debitId, err: msg }, '[gam-debit] the pull failed')
    return { status: 'skipped', reason: 'stripe_failed', debitId, error: msg }
  }
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
): Promise<void> {
  const debit = await queryOne<{ id: string; landlord_id: string; charge_ids: string[]; status: string }>(
    `SELECT id, landlord_id, charge_ids, status FROM landlord_gam_debits
      WHERE stripe_payment_intent_id = $1`,
    [paymentIntentId])
  if (!debit || debit.status !== 'pending') return

  if (!ok) {
    await query(
      `UPDATE landlord_gam_debits
          SET status='failed', failure_reason=$2, settled_at=NOW(), updated_at=NOW()
        WHERE id=$1`,
      [debit.id, (failureReason ?? 'bank declined').slice(0, 500)])
    logger.error({ debitId: debit.id, landlordId: debit.landlord_id, failureReason },
      '[gam-debit] the bank refused the pull — the charges stay owed')
    return
  }

  const client = await getClient()
  try {
    await client.query('BEGIN')
    await client.query(
      `UPDATE landlord_gam_charges
          SET collected_amount = amount, collected_at = NOW(), updated_at = NOW()
        WHERE id = ANY($1::uuid[])`,
      [debit.charge_ids])
    await client.query(
      `UPDATE landlord_gam_debits
          SET status='succeeded', settled_at=NOW(), updated_at=NOW()
        WHERE id=$1`,
      [debit.id])
    await client.query('COMMIT')
  } catch (e) {
    try { await client.query('ROLLBACK') } catch {}
    throw e
  } finally {
    client.release()
  }
  logger.info({ debitId: debit.id, landlordId: debit.landlord_id }, '[gam-debit] settled')
}

/**
 * The nightly sweep — every landlord who owes GAM anything.
 *
 * Cheap and usually silent, because almost everyone is under their threshold:
 * one ACH rent payment at Oak Park offsets roughly 44 cash fees and the park
 * does not have 44 spaces. The ones that surface here are the all-cash
 * properties, which is exactly who this was built for.
 */
export async function runGamDebitSweep(): Promise<{ considered: number; debited: number; skipped: Record<string, number> }> {
  const rows = await query<{ id: string }>(
    `SELECT l.id FROM landlords l
      WHERE l.is_demo = FALSE
        AND EXISTS (SELECT 1 FROM landlord_gam_charges c
                     WHERE c.landlord_id = l.id AND c.collected_amount < c.amount)`)

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
