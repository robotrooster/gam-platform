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
import { query } from '../db'
import { logger } from '../lib/logger'
import { createAdminNotification } from '../services/adminNotifications'

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
        body: `Payment ${row.id} has been 'processing' since ${new Date(row.created_at).toISOString().slice(0, 10)} `
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
