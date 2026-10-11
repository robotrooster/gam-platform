/**
 * Payment reconciliation — does our ledger agree with Stripe?
 *
 * S620 (Nic, on finding a $2 rent payment still showing as owed after the
 * money had left his bank): "They cannot be not marking payments as made on
 * their back end. That is the number one red flag."
 *
 * WHAT WAS ACTUALLY WRONG. Nothing, on that payment — Stripe had not yet
 * flipped the charge, and our row mirrored Stripe exactly. What the
 * investigation exposed is structural and much worse:
 *
 *   THE ONLY PATH FROM 'processing' TO 'settled' IS A WEBHOOK ARRIVING.
 *
 * There is no poll, no backstop, no reconcile. If `payment_intent.succeeded`
 * is missed — the endpoint is down, the Mac is mid-brownout (see §0 of every
 * recent handoff), Stripe exhausts its retries — that payment stays
 * 'processing' forever. Nothing ever looks again. The tenant has paid, GAM
 * holds the money, and the platform goes on reporting them delinquent: late
 * fees keep accruing, the landlord sees them on the delinquent list, and the
 * agent tells them to their face that they owe it.
 *
 * That is the failure this job exists to catch, and it is a launch blocker
 * for Oak Park precisely because it is silent.
 *
 * WHAT THIS JOB DOES NOT DO: settle anything. The settlement path is ~500
 * lines inside the webhook handler — money movement, transfers, allocation,
 * supersedence. Reimplementing it here to "fix" a stuck row is how a payment
 * gets applied twice, which is a worse bug than the one being fixed. This job
 * DETECTS divergence and raises a human. The durable fix is an event backfill
 * that replays missed events through the SAME handler (which is already
 * idempotent on stripe_event_id) — that needs the handler extracted from the
 * route first, and it is the next step, not this one.
 */

import Stripe from 'stripe'
import { query, getClient } from '../db'
import { logger } from '../lib/logger'
import { createAdminNotification } from '../services/adminNotifications'
import { dateIn } from '../lib/timezone'
import { lockHousehold } from '../services/moneyPredicates'
import { releaseHeldForRemittance } from '../services/creditUse'
import { CARD_CONFIRM_HOLD_MINUTES } from '../services/rentCharge'

/** How long a payment may sit in 'processing' before we ask Stripe about it.
 *  ACH settles in 3-5 business days; a card is near-instant. 24h is well
 *  inside the ACH window, so this asks a question rather than raising alarms. */
const STALE_AFTER_HOURS = 24

interface StuckRow {
  id: string
  amount: string
  due_date: string
  created_at: string
  stripe_payment_intent_id: string | null
  tenant_email: string | null
}

export interface ReconcileResult {
  checked: number
  diverged: number
  unknown: number
}

/**
 * Compare every payment sitting in 'processing' against Stripe.
 *
 * Three outcomes per row:
 *   - Stripe also says processing  → in flight, nothing to do, stay quiet.
 *   - Stripe says succeeded        → WE MISSED THE WEBHOOK. Alarm.
 *   - Stripe says canceled/failed  → we missed that one too. Alarm.
 */
export async function reconcileStuckPayments(stripe: Stripe): Promise<ReconcileResult> {
  // A backstop for the 3-D Secure release sweep below (its own cron runs it
  // every five minutes — jobs/scheduler.ts): a bill held by a card nobody
  // confirmed is released here too, never left waiting on it.
  try {
    await releaseUnconfirmedCardCharges(stripe)
  } catch (err) {
    logger.error({ err }, '[reconcile] unconfirmed card release sweep failed')
  }
  const rows = await query<StuckRow>(
    `SELECT p.id, p.amount, p.due_date, p.created_at, p.stripe_payment_intent_id,
            u.email AS tenant_email
       FROM payments p
       LEFT JOIN tenants t ON t.id = p.tenant_id
       LEFT JOIN users u ON u.id = t.user_id
      WHERE p.status = 'processing'
        AND p.created_at < now() - ($1 || ' hours')::interval
      ORDER BY p.created_at`,
    [String(STALE_AFTER_HOURS)]
  )

  let diverged = 0
  let unknown = 0

  for (const row of rows) {
    // A payment in 'processing' with no PaymentIntent cannot be reconciled at
    // all — it is its own kind of broken, and silence is not an answer.
    if (!row.stripe_payment_intent_id) {
      unknown++
      logger.error({ paymentId: row.id }, '[reconcile] processing payment has no stripe_payment_intent_id')
      await createAdminNotification({
        severity: 'warn',
        category: 'payment_reconcile',
        title: `Payment stuck with no Stripe reference — $${row.amount}`,
        // S654: the day it started, on GAM's Phoenix calendar — UTC named the
        // next day for anything created after 5 pm Phoenix.
        body: `Payment ${row.id} has been 'processing' since ${dateIn(null, new Date(row.created_at))} `
            + `and carries no PaymentIntent id, so its real state cannot be checked. Investigate by hand.`,
        context: { paymentId: row.id, amount: row.amount, tenantEmail: row.tenant_email },
      }).catch(() => {})
      continue
    }

    let pi: Stripe.PaymentIntent
    try {
      pi = await stripe.paymentIntents.retrieve(row.stripe_payment_intent_id)
    } catch (err) {
      unknown++
      logger.error({ err, paymentId: row.id, pi: row.stripe_payment_intent_id },
        '[reconcile] could not retrieve PaymentIntent')
      continue
    }

    if (pi.status === 'processing' || pi.status === 'requires_action') {
      // Genuinely in flight. This is the normal case for ACH and must NOT
      // generate noise, or the real alarms get ignored.
      continue
    }

    diverged++
    const settled = pi.status === 'succeeded'
    logger.error(
      { paymentId: row.id, piStatus: pi.status, amount: row.amount },
      '[reconcile] LEDGER DISAGREES WITH STRIPE — a webhook was missed')

    await createAdminNotification({
      severity: 'critical',
      category: 'payment_reconcile',
      title: settled
        ? `Paid in Stripe, still owed in GAM — $${row.amount}`
        : `Payment ${pi.status} in Stripe, still 'processing' in GAM — $${row.amount}`,
      body: settled
        ? `Stripe says PaymentIntent ${pi.id} SUCCEEDED, but payment ${row.id} is still 'processing' here, so `
        + `${row.tenant_email ?? 'the tenant'} is being treated as though they still owe $${row.amount}. `
        + `The webhook was missed. Late fees may be accruing on money that has already been paid. `
        + `Replay the event from the Stripe dashboard rather than editing the row by hand — the handler is `
        + `idempotent and will do the full settlement correctly.`
        : `Stripe says PaymentIntent ${pi.id} is '${pi.status}', but payment ${row.id} is still 'processing' here. `
        + `The failure webhook was missed, so nothing was retried and nobody was told.`,
      context: {
        paymentId: row.id, paymentIntentId: pi.id, stripeStatus: pi.status,
        amount: row.amount, dueDate: row.due_date, tenantEmail: row.tenant_email,
      },
    }).catch(() => {})
  }

  if (diverged || unknown) {
    logger.warn({ checked: rows.length, diverged, unknown }, '[reconcile] finished with findings')
  } else {
    logger.info({ checked: rows.length }, '[reconcile] ledger agrees with Stripe')
  }
  return { checked: rows.length, diverged, unknown }
}

// ── decisions.md #48.4: card payments nobody confirmed (3-D Secure) ─────────
//
// On the pay screen, a card whose bank asks the cardholder to confirm the
// payment is confirmed on the spot (services/rentCharge confirmOnScreen). While
// they do, the charge's rows wait on it ('processing') — the bill is held so
// it cannot be paid twice. Nobody may hold a bill that way for long: after
// CARD_CONFIRM_HOLD_MINUTES the charge is canceled in Stripe and the bill is
// released — exactly what payment_intent.canceled does (webhooks.ts
// failIntentRows), done here so the release never waits on that event:
//   - its rows still waiting on it are open again exactly as before it
//     ('pending', no payment on them) — the bill simply opens again: no
//     'Failed' mark on a bill for a bank window the payer closed;
//   - the credit it set aside comes back (releaseHeldForRemittance);
//   - its receipt closes as failed, noted with why (CARD_RELEASE_NOTE: the
//     history shows "Canceled — nothing charged", or "Declined — nothing
//     charged" when the card's bank refused it);
//   - an old balance it paid part of is one row again (rejoinSplitOldBalance);
//   - a tenant-paid platform fee it carried is owed again on the next payment
//     (the charge that would have collected it never happened).
// The webhook that follows finds nothing left to move. A charge that went
// through meanwhile is never touched: the success webhook settles it.

/** Stripe statuses of a charge still waiting on the cardholder (or on a new card after a failed confirmation). */
export const UNCONFIRMED_CARD_STATUSES: ReadonlySet<string> = new Set(['requires_action', 'requires_payment_method', 'requires_confirmation'])
const UNCONFIRMED_STATUSES = UNCONFIRMED_CARD_STATUSES

/**
 * decisions.md #48.4 applies to ONE kind of card charge: the pay screen's,
 * which services/rentCharge stamps `gam_confirm_on_screen` when the payer is
 * there to answer their bank. Only such a charge holds a bill for its
 * cardholder, is released after CARD_CONFIRM_HOLD_MINUTES, is shown to the
 * household as waiting on a card's bank, and may be canceled from the
 * Payments page. Any other card charge that waits in Stripe is someone
 * else's to finish — a move-out balance charge GAM confirms itself
 * (services/depositReturn finishPendingGapCharges) is never canceled, never
 * shown as waiting on the tenant's bank, and never released here.
 */
export function confirmedOnScreen(pi: { metadata?: Stripe.Metadata | null } | null | undefined): boolean {
  return pi?.metadata?.gam_confirm_on_screen === 'true'
}

/** A pay-screen card charge still waiting on its cardholder (see confirmedOnScreen). */
export function heldForCardholder(pi: { status: string; metadata?: Stripe.Metadata | null } | null | undefined): boolean {
  return !!pi && confirmedOnScreen(pi) && UNCONFIRMED_STATUSES.has(pi.status)
}
/** Statuses that mean the money is taken or on its way (or a reader hold): never released here. */
const WENT_THROUGH_STATUSES = new Set(['succeeded', 'processing', 'requires_capture'])

/**
 * decisions.md #48.4: what a card payment released before anything was
 * charged is noted as on its receipt — a recorded fact the payment history
 * reads (GET /payments/remittances), never inferred from what else exists.
 * 'canceled': its bank's confirmation was closed, failed or ran out, or it was
 * canceled to pay another way. 'declined': the card's bank refused the payment
 * itself after the cardholder confirmed it. A receipt noted 'canceled' is
 * corrected to 'declined' when the decline is learned later (the failure
 * event can land after the screen's own release); never the other way.
 */
export const CARD_RELEASE_REASON_VALUES = ['canceled', 'declined'] as const
export type CardReleaseReason = typeof CARD_RELEASE_REASON_VALUES[number]
export const CARD_RELEASE_NOTE: Record<CardReleaseReason, string> = {
  canceled: 'Card payment canceled before anything was charged — its bank did not confirm it, or it was canceled to pay another way.',
  declined: 'Card payment declined by the card’s bank before anything was charged.',
}

export type UnconfirmedReleaseOutcome =
  /** Canceled in Stripe and the bill released (or already released). */
  | 'released'
  /** The cardholder confirmed in time: the money is taken or on its way. */
  | 'went_through'
  /**
   * Not a pay-screen charge (see confirmedOnScreen): nothing was done — it
   * is not the cardholder's to cancel and no hold of theirs is on the bill.
   */
  | 'not_held'

/**
 * The card's bank refused the payment itself (a decline such as insufficient
 * funds) rather than the cardholder's confirmation failing or being
 * abandoned. Stripe marks a failed or abandoned 3-D Secure confirmation
 * 'payment_intent_authentication_failure'; any other card error on the intent
 * is a decline. Used only to say the right thing on the pay screen.
 */
export function declinedByCardBank(pi: { last_payment_error?: Stripe.PaymentIntent['last_payment_error'] } | null | undefined): boolean {
  const err = pi?.last_payment_error
  if (!err || err.type !== 'card_error') return false
  return !!err.code && err.code !== 'payment_intent_authentication_failure'
}

/**
 * Release one card charge that is waiting on the cardholder's confirmation:
 * cancel it in Stripe, then release its rows and held credit. A charge that
 * went through is left alone ('went_through'). Idempotent. `declined`: the
 * card's bank refused the payment itself (declinedByCardBank) — the bill is
 * released the same way; only what the screen says differs.
 */
export async function releaseUnconfirmedChargeDetailed(
  stripe: Stripe, paymentIntentId: string,
  /** The decline is already known (the failure event's own copy of the charge). */
  opts: { declined?: boolean } = {},
): Promise<{ outcome: UnconfirmedReleaseOutcome; declined: boolean }> {
  let pi = await stripe.paymentIntents.retrieve(paymentIntentId)
  if (!confirmedOnScreen(pi)) return { outcome: 'not_held', declined: false }
  if (WENT_THROUGH_STATUSES.has(pi.status)) return { outcome: 'went_through', declined: false }
  // Read before the cancel: Stripe clears last_payment_error once the charge
  // is canceled. A decline the failure webhook already recorded on the
  // receipt counts too (releaseCanceledCardCharge answers it).
  const declined = opts.declined === true || declinedByCardBank(pi)
  if (pi.status !== 'canceled') {
    try {
      pi = await stripe.paymentIntents.cancel(paymentIntentId)
    } catch (err) {
      // It moved under us: confirmed a moment ago, or canceled elsewhere.
      pi = await stripe.paymentIntents.retrieve(paymentIntentId)
      if (WENT_THROUGH_STATUSES.has(pi.status)) return { outcome: 'went_through', declined: false }
      if (pi.status !== 'canceled') throw err
    }
  }
  const recorded = await releaseCanceledCardCharge(paymentIntentId, declined ? 'declined' : 'canceled')
  return { outcome: 'released', declined: recorded === 'declined' }
}

/** releaseUnconfirmedChargeDetailed, outcome only. */
export async function releaseUnconfirmedCharge(stripe: Stripe, paymentIntentId: string): Promise<UnconfirmedReleaseOutcome> {
  return (await releaseUnconfirmedChargeDetailed(stripe, paymentIntentId)).outcome
}

/** The note "partly paid toward the old balance" rentCharge puts on the old-balance row a charge paid only part of. */
const PARTLY_PAID_NOTE_RE = 'partly paid toward the old balance; \\$[0-9.,]+ remains on a separate row$'

/**
 * The bill side of a canceled card charge, under the household lock (see the
 * block comment above). Returns what its receipt is noted as (the reason
 * given, or a decline recorded before) — null when it has no receipt.
 */
async function releaseCanceledCardCharge(paymentIntentId: string, reason: CardReleaseReason): Promise<CardReleaseReason | null> {
  const client = await getClient()
  try {
    await client.query('BEGIN')
    const who = (await client.query<{ tenant_id: string; landlord_id: string }>(
      `SELECT tenant_id, landlord_id FROM tenant_remittances
        WHERE stripe_payment_intent_id = $1 ORDER BY created_at LIMIT 1`, [paymentIntentId])).rows[0]
    if (who) await lockHousehold(client, who.tenant_id, who.landlord_id)
    const rem = (await client.query<{ id: string }>(
      `SELECT id FROM tenant_remittances WHERE stripe_payment_intent_id = $1
        ORDER BY created_at LIMIT 1 FOR UPDATE`, [paymentIntentId])).rows[0] ?? null
    // An old balance this charge paid only part of was split in two by
    // services/rentCharge (the paid slice kept the row, "partly paid toward
    // the old balance; $X remains on a separate row", and the rest went on a
    // new row). Nothing was paid, so the two are one row again, as before the
    // charge — unless the other row has moved on since (paid, or tied to
    // something), in which case each stays as it is and the note stops
    // claiming a part payment that never happened.
    if (rem) await rejoinSplitOldBalance(client, paymentIntentId, rem.id)
    // The platform fee it carried is owed again by the next payment — cleared
    // while the rows still name this charge.
    await client.query(
      `UPDATE platform_fee_accruals SET tenant_charge_id = NULL, updated_at = NOW()
        WHERE tenant_charge_id IN (SELECT id FROM payments WHERE stripe_payment_intent_id = $1 AND status = 'processing')`,
      [paymentIntentId])
    // The bill simply opens again: its rows are open as a fresh bill is
    // ('pending', no payment on them, not yet held by GAM, no way paid) —
    // never 'Failed' for a bank window the payer closed or a hold that ran
    // out. (The same reopening as a move-out balance charge GAM lets go,
    // services/depositReturn.) The receipt below keeps the trace.
    await client.query(
      `UPDATE payments
          SET status = 'pending', stripe_payment_intent_id = NULL, next_retry_at = NULL,
              platform_held = FALSE, payment_channel = NULL
        WHERE id IN (SELECT id FROM payments WHERE stripe_payment_intent_id = $1 AND status = 'processing'
                      ORDER BY id FOR UPDATE)`,
      [paymentIntentId])
    let recorded: CardReleaseReason | null = null
    if (rem) {
      await releaseHeldForRemittance(client, rem.id, 'payment_canceled')
      // The receipt closes as failed, noted with why (the history reads it).
      // A decline learned after the receipt was noted 'canceled' corrects it.
      const note = (await client.query<{ notes: string | null }>(
        `UPDATE tenant_remittances
            SET status = 'failed', updated_at = NOW(),
                notes = CASE WHEN status = 'processing' THEN COALESCE(notes, $2)
                             WHEN notes = $3 AND $4::boolean THEN $2
                             ELSE notes END
          WHERE id = $1 AND status IN ('processing', 'failed')
          RETURNING notes`,
        [rem.id, CARD_RELEASE_NOTE[reason], CARD_RELEASE_NOTE.canceled, reason === 'declined'])).rows[0]?.notes ?? null
      recorded = note === CARD_RELEASE_NOTE.declined ? 'declined' : note === CARD_RELEASE_NOTE.canceled ? 'canceled' : null
    }
    await client.query('COMMIT')
    return recorded
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    client.release()
  }
}

/** See releaseCanceledCardCharge: an old balance this charge split, made whole again. */
async function rejoinSplitOldBalance(client: import('pg').PoolClient, paymentIntentId: string, remittanceId: string): Promise<void> {
  const split = (await client.query<{ id: string; lease_id: string | null; invoice_id: string | null; unit_id: string | null
    tenant_id: string | null; type: string; due_date: string | null; entry_description: string | null }>(
    `SELECT id, lease_id, invoice_id, unit_id, tenant_id, type, due_date::text AS due_date, entry_description
       FROM payments
      WHERE stripe_payment_intent_id = $1 AND status = 'processing' AND notes ~ $2
      ORDER BY id FOR UPDATE`, [paymentIntentId, PARTLY_PAID_NOTE_RE])).rows
  for (const p of split) {
    // The rest of it: written in the same transaction as this charge's receipt
    // (so the same created_at), still open, and touched by nothing since.
    const rest = (await client.query<{ id: string; amount: string }>(
      `SELECT r.id, r.amount FROM payments r
        WHERE r.is_remainder AND r.created_at = (SELECT created_at FROM tenant_remittances WHERE id = $1)
          AND r.status = 'pending' AND r.stripe_payment_intent_id IS NULL
          AND r.type = $2
          AND r.lease_id IS NOT DISTINCT FROM $3::uuid AND r.invoice_id IS NOT DISTINCT FROM $4::uuid
          AND r.unit_id IS NOT DISTINCT FROM $5::uuid AND r.tenant_id IS NOT DISTINCT FROM $6::uuid
          AND r.due_date IS NOT DISTINCT FROM $7::date
          AND r.entry_description IS NOT DISTINCT FROM $8
          AND NOT EXISTS (SELECT 1 FROM remittance_applications ra WHERE ra.payment_id = r.id)
          AND NOT EXISTS (SELECT 1 FROM credit_uses u WHERE u.payment_id = r.id)
        ORDER BY r.id LIMIT 1 FOR UPDATE`,
      [remittanceId, p.type, p.lease_id, p.invoice_id, p.unit_id, p.tenant_id, p.due_date, p.entry_description])).rows[0]
    if (rest) {
      await client.query('SAVEPOINT rejoin_old_balance')
      try {
        await client.query(`DELETE FROM payments WHERE id = $1`, [rest.id])
        await client.query(
          `UPDATE payments
              SET amount = amount + $2::numeric,
                  notes = NULLIF(regexp_replace(notes, '( — )?' || $3, ''), '')
            WHERE id = $1`, [p.id, rest.amount, PARTLY_PAID_NOTE_RE])
        await client.query('RELEASE SAVEPOINT rejoin_old_balance')
        continue
      } catch (err) {
        // Something else holds on to the other row: leave both as they are.
        await client.query('ROLLBACK TO SAVEPOINT rejoin_old_balance')
        logger.warn({ err, paymentId: p.id, restId: rest.id }, '[reconcile] could not rejoin a split old balance; notes corrected only')
      }
    }
    await client.query(
      `UPDATE payments SET notes = regexp_replace(notes, $2, 'part of the old balance; the rest is on a separate row') WHERE id = $1`,
      [p.id, PARTLY_PAID_NOTE_RE])
  }
}

/**
 * A tenant-paid platform fee tied to a card charge that failed for good (its
 * row 'failed' with no retry, its receipt closed as failed) was never
 * collected: the link is cleared so the next payment carries it. Card only —
 * a bank debit's retries carry their own rows.
 */
async function unlinkFailedCardChargeFees(tenantId: string | null, landlordIds: string[] | null): Promise<void> {
  await query(
    `UPDATE platform_fee_accruals a SET tenant_charge_id = NULL, updated_at = NOW()
       FROM payments p
       JOIN tenant_remittances r ON r.stripe_payment_intent_id = p.stripe_payment_intent_id
      WHERE a.tenant_charge_id = p.id
        AND p.status = 'failed' AND p.next_retry_at IS NULL
        AND r.payment_method = 'card' AND r.status = 'failed'
        AND ($1::uuid IS NULL OR r.tenant_id = $1::uuid)
        AND ($2::uuid[] IS NULL OR r.landlord_id = ANY($2::uuid[]))`,
    [tenantId, landlordIds])
}

export interface UnconfirmedSweepResult {
  checked: number
  released: number
  /** Could not be read or canceled; tried again next run. */
  errors: number
}

/**
 * The pay screen's card charge failed its bank's confirmation (or was refused
 * once confirmed) — Stripe's payment_intent.payment_failed for an intent
 * services/rentCharge stamped `gam_confirm_on_screen`. The payer is on the
 * screen and is told there; nothing else is owed for it. So it is released
 * exactly as the screen's own release does — canceled in Stripe, its rows
 * owed again, its credit back, its platform-fee link cleared — and is NOT a
 * declined payment: no decline fee, no failed-payment mark on the tenant's
 * record, no notices (the same as a card refused on the pay screen at once,
 * which never leaves rows and bills no decline fee either — whether S603's $1
 * should apply to a card refused on the pay screen, at once or after its bank's
 * confirmation, is for Nic). true = handled here; the webhook does nothing
 * more. false = not such a charge (the normal failure path applies).
 * Whichever of this and the screen's release lands first does the work; the
 * other finds nothing left.
 */
export async function releaseFailedOnScreenConfirmation(
  stripe: Stripe,
  pi: Pick<Stripe.PaymentIntent, 'id' | 'metadata'> & { status?: string | null; last_payment_error?: Stripe.PaymentIntent['last_payment_error'] },
): Promise<boolean> {
  if (!confirmedOnScreen(pi)) return false
  // The event's own copy of the charge says whether the card's bank declined
  // it (Stripe clears that once the charge is canceled): recorded on the
  // receipt, so the history and the pay screen say "declined" truthfully.
  const declined = declinedByCardBank(pi)
  // payment_intent.canceled: already canceled in Stripe (by the sweep, the
  // screen's Cancel, or in Stripe itself) — only the bill side is left, so
  // Stripe is not asked again.
  if (pi.status === 'canceled') {
    await releaseCanceledCardCharge(pi.id, declined ? 'declined' : 'canceled')
    return true
  }
  await releaseUnconfirmedChargeDetailed(stripe, pi.id, { declined })
  return true
}

/**
 * Card charges the sweep found went through (succeeded, processing, or a
 * reader hold): not asked about again by this process — the success webhook
 * settles them, and the twice-daily reconcile alarms if it never comes. Keeps
 * a missed webhook from costing a Stripe read every five minutes.
 */
const WENT_THROUGH_SEEN = new Set<string>()
const WENT_THROUGH_SEEN_MAX = 5000
/**
 * Card charges the sweep found are not the pay screen's (confirmedOnScreen):
 * never its to release, and what a charge was made for never changes — not
 * asked about again by this process (a move-out balance charge GAM is still
 * finishing would otherwise cost a Stripe read every five minutes).
 */
const NOT_ON_SCREEN_SEEN = new Set<string>()
/** Forget what the sweep has seen (a fresh process; tests). */
export function forgetSweptCardCharges(): void { WENT_THROUGH_SEEN.clear(); NOT_ON_SCREEN_SEEN.clear() }

/**
 * Every card charge still waiting on its cardholder's confirmation more than
 * CARD_CONFIRM_HOLD_MINUTES after it was made: canceled, and its bill
 * released. `tenantId` limits it to one household: that tenant's own charges
 * and any on a lease they are on (the pay route and the bill read run it, so
 * nobody in the household is refused or shown a held bill over an abandoned
 * one). `landlordIds` limits it to those companies' charges (the landlord
 * assistant's cash tool, which finds the household only by name). The desk
 * quote and settle run it for the household first, so staff never see — or
 * turn a resident away over — a hold that has already run out. Call it with no
 * row or household lock held by the caller's own transaction: it takes the
 * household lock on its own connection. Only card receipts still 'processing' with a row waiting on them are
 * asked about; Stripe decides — anything that went through is left alone, and
 * so is any card charge the pay screen did not make (confirmedOnScreen: a
 * move-out balance charge GAM is finishing is never canceled here).
 *
 * Also clears the platform-fee link of a card charge that failed for good
 * (its rows owed again, no retry): the fee it would have collected was never
 * collected, so the next payment carries it (a failure the webhook closed
 * before the release could).
 */
export async function releaseUnconfirmedCardCharges(
  /** Stripe, or how to get it — asked for only when a charge is due (most runs find none). */
  stripeOrGetter: Stripe | (() => Stripe), opts: { tenantId?: string; landlordIds?: string[] } = {},
): Promise<UnconfirmedSweepResult> {
  const due = await query<{ pi: string }>(
    `SELECT DISTINCT r.stripe_payment_intent_id AS pi
       FROM tenant_remittances r
      WHERE r.status = 'processing' AND r.payment_method = 'card'
        AND r.stripe_payment_intent_id IS NOT NULL
        AND r.created_at < now() - ($1 || ' minutes')::interval
        AND EXISTS (SELECT 1 FROM payments p
                     WHERE p.stripe_payment_intent_id = r.stripe_payment_intent_id AND p.status = 'processing')
        AND ($2::uuid IS NULL OR r.tenant_id = $2::uuid
             OR EXISTS (SELECT 1 FROM payments p
                          LEFT JOIN invoices inv ON inv.id = p.invoice_id
                          JOIN lease_tenants lt ON lt.lease_id = COALESCE(p.lease_id, inv.lease_id)
                         WHERE p.stripe_payment_intent_id = r.stripe_payment_intent_id
                           AND lt.tenant_id = $2::uuid
                           AND lt.status IN ('active','pending_add','pending_remove')))
        AND ($3::uuid[] IS NULL OR r.landlord_id = ANY($3::uuid[]))`,
    [String(CARD_CONFIRM_HOLD_MINUTES), opts.tenantId ?? null, opts.landlordIds ?? null])
  await unlinkFailedCardChargeFees(opts.tenantId ?? null, opts.landlordIds ?? null)
  const out: UnconfirmedSweepResult = { checked: due.length, released: 0, errors: 0 }
  if (due.length === 0) return out
  const stripe = typeof stripeOrGetter === 'function' ? (stripeOrGetter as () => Stripe)() : stripeOrGetter
  for (const { pi } of due) {
    if (WENT_THROUGH_SEEN.has(pi) || NOT_ON_SCREEN_SEEN.has(pi)) continue
    try {
      const live = await stripe.paymentIntents.retrieve(pi)
      if (!confirmedOnScreen(live)) {
        if (NOT_ON_SCREEN_SEEN.size >= WENT_THROUGH_SEEN_MAX) NOT_ON_SCREEN_SEEN.clear()
        NOT_ON_SCREEN_SEEN.add(pi)
        continue
      }
      if (WENT_THROUGH_STATUSES.has(live.status)) {
        if (WENT_THROUGH_SEEN.size >= WENT_THROUGH_SEEN_MAX) WENT_THROUGH_SEEN.clear()
        WENT_THROUGH_SEEN.add(pi)
        continue
      }
      if (!UNCONFIRMED_STATUSES.has(live.status) && live.status !== 'canceled') continue
      if (await releaseUnconfirmedCharge(stripe, pi) === 'released') out.released++
    } catch (err) {
      out.errors++
      logger.error({ err, paymentIntentId: pi }, '[reconcile] could not release an unconfirmed card charge')
    }
  }
  if (out.released > 0 || out.errors > 0) logger.info(out, '[reconcile] unconfirmed card charges')
  return out
}
