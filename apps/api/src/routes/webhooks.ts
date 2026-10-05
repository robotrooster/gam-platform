import { Router } from 'express'
import { createHash } from 'crypto'
import Stripe from 'stripe'
import { query, queryOne, getClient } from '../db'
import { executeRentAllocation, ALLOCATABLE_PAYMENT_TYPES, type PaymentMethod } from '../services/allocation'
import {
  recordAccountUpdated, recordPayoutEvent, recordDisputeEvent,
  firePmTransfersForReference, fireManagerTransfersForReference,
} from '../services/stripeConnect'
import { createAdminNotification } from '../services/adminNotifications'
// S651: a bounce must reach the landlord, not just GAM — they are the only one
// who can ask the tenant how their address is spelled.
import { createNotification } from '../services/notifications'
import { confirmBookingDeposit } from '../services/propertyBooking'

// S648: charges GAM takes for someone other than a tenant paying rent.
// S654: 'rent_terminal_pending' is a counter reader waiting for a tap; the
// capture route rewrites its purpose to 'rent_terminal' and stamps the rows
// BEFORE capturing, so payment_intent.succeeded settles it like any card.
const HELD_PURPOSES = new Set(['pos_terminal', 'pos_pay_link', 'booking_deposit', 'business_invoice', 'business_pos_terminal', 'rent_terminal_pending'])
import { applyTenantSupersedence, type PostCommitTransfer } from '../services/supersedence'
import { emitPaymentFailedEvent } from '../services/creditLedgerEmitters'
// S655 (Step 10): the one post-settle routine (going live, the on-time mark,
// the receipt) every settle path shares.
import { afterRowsSettled } from '../services/settleHooks'
import type { PoolClient } from 'pg'
import {
  ACH_RETURN_CONFIG, CARD_DECLINE_FEE, FLEXPAY_PULL_MAX_RETRIES, FLEXPAY_PULL_RETRY_DAYS,
  processingFeeFor, type PaymentReversalType,
} from '@gam/shared'
import { logger } from '../lib/logger'
import { addDaysTo, todayIn } from '../lib/timezone'
import { getStripe } from '../lib/stripe'

export const webhooksRouter = Router()

// Stripe webhook — raw body required (set before express.json() in index.ts)
webhooksRouter.post('/stripe', async (req, res) => {
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: '2023-10-16' })
  const sig = req.headers['stripe-signature'] as string
  let event: Stripe.Event

  // S553 (C3): dual-secret verify. Stripe signs PLATFORM events and
  // CONNECT (connected-account) events with different endpoint secrets,
  // both delivered to this URL. Try platform first, then Connect. A
  // payload that matches neither is rejected exactly as before.
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET!)
  } catch (platformErr: any) {
    const connectSecret = process.env.STRIPE_CONNECT_WEBHOOK_SECRET
    if (!connectSecret) {
      return res.status(400).json({ error: `Webhook signature failed: ${platformErr.message}` })
    }
    try {
      event = stripe.webhooks.constructEvent(req.body, sig, connectSecret)
    } catch (err: any) {
      return res.status(400).json({ error: `Webhook signature failed: ${err.message}` })
    }
  }

  // C3 (S550 data-completeness): persist the raw verified payload append-
  // only BEFORE any processing, so history stays replayable if processing
  // logic ever changes. Idempotent under Stripe re-delivery via the
  // stripe_event_id UNIQUE. If the insert itself fails we 500 — Stripe
  // retries, so a transient DB error never loses a payload. Real Stripe
  // events always carry an id; the body-hash fallback keeps id-less
  // payloads (test fixtures) storable AND idempotent.
  const rawEventId = event.id
    || 'evt_local_' + createHash('sha256').update(req.body).digest('hex').slice(0, 32)
  try {
    await query(
      `INSERT INTO stripe_webhook_events
         (stripe_event_id, event_type, api_version, livemode, payload)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (stripe_event_id) DO NOTHING`,
      [rawEventId, event.type, (event as any).api_version ?? null, event.livemode === true, JSON.stringify(event)]
    )
  } catch (e) {
    logger.error({ err: e, stripe_event_id: event.id }, '[webhook] raw event persist failed')
    return res.status(500).json({ error: 'raw event persist failed' })
  }

  switch (event.type) {
    case 'payment_intent.succeeded': {
      const pi = event.data.object as Stripe.PaymentIntent

      // Non-rent charges (register sales, pay links, stay deposits, business
      // invoices and register sales) have no row in `payments`, so they stay
      // out of the rent allocation path. Since S648 all are GAM's charges; the
      // flow that recorded each one also wrote what GAM holds for the payee.
      if (HELD_PURPOSES.has(pi.metadata?.gam_purpose ?? '')) {
        // Logged for audit; the POS transaction row was already written
        // by POST /pos/transactions (which validates the PI before
        // insert). No further work to do here.
        break
      }

      // S651: GAM pulling its own fees out of a landlord's bank. This is not a
      // tenant payment and has no `payments` row, so it must branch out before
      // the rent allocation path below. The charges are only marked collected
      // HERE — an ACH pull can still bounce days after it was submitted.
      if (pi.metadata?.gam_debit_id) {
        const { settleGamDebit } = await import('../services/landlordGamDebit')
        await settleGamDebit(pi.id, true)
        break
      }

      try {
        await settleSucceededIntent(stripe, pi, rawEventId)
      } catch (e) {
        logger.error({ err: e, stripe_payment_intent_id: pi.id }, 'webhook payment_intent.succeeded handler failed')
        // S132: critical — the money arrived and the settle did not. Stripe
        // retries (we 500 below); admin needs to see it regardless.
        await createAdminNotification({
          severity: 'critical',
          category: 'webhook_payment_settled_handler_failed',
          title:    `Allocation engine failed on settled PaymentIntent ${pi.id}`,
          body:     e instanceof Error ? e.message : String(e),
          context:  { stripe_payment_intent_id: pi.id },
        }).catch(() => {})
        await stampWebhookError(rawEventId, e)
        return res.status(500).json({ error: 'webhook handler failed' })
      }
      break
    }
    case 'payment_intent.payment_failed': {
      // S124: NACHA-compliant retry decision. Read the return code from
      // Stripe's last_payment_error chain (an R-code, or — S654 — the name
      // Stripe gives it, e.g. 'insufficient_funds'); if retryable AND under
      // the retry cap, the rows are retried three calendar days out, at the
      // start of the property's day. Otherwise: final, no retry.
      // S655 (Step 10): only rows still waiting on this charge move, under the
      // household lock; credit stays held for a retry and is given back on a
      // final failure (failIntentRows).
      const pi = event.data.object as Stripe.PaymentIntent

      // S242: POS terminal failures (card declined at reader) are handled
      // by the operator at the POS. No ledger row, no retry, no notice.
      if (HELD_PURPOSES.has(pi.metadata?.gam_purpose ?? '')) break

      // S651: a bounced GAM fee pull. No NACHA retry pipeline — the charges
      // simply stay owed and the nightly sweep will consider the landlord
      // again once nothing is in flight.
      if (pi.metadata?.gam_debit_id) {
        const { settleGamDebit } = await import('../services/landlordGamDebit')
        await settleGamDebit(pi.id, false,
          pi.last_payment_error?.message ?? 'the bank refused the transfer')
        break
      }

      try {
        // decisions.md #48.4: a card the tenant pay screen was confirming with
        // its bank (3-D Secure) that failed or was abandoned there is NOT a
        // declined payment — the payer is on the screen and is told there that
        // nothing was charged and the bill is open again. It is released
        // exactly as the screen's own Cancel does (canceled in Stripe, rows
        // owed again, held credit back): no $1 decline fee, no "payment
        // failed" notice or email, no NSF event on the tenant's record.
        const { releaseFailedOnScreenConfirmation } = await import('../jobs/paymentReconcile')
        if (await releaseFailedOnScreenConfirmation(stripe, pi)) break
        await handleFailedIntent(stripe, pi)
      } catch (e) {
        logger.error({ err: e, stripe_payment_intent_id: pi.id }, 'webhook payment_intent.payment_failed handler failed')
        await stampWebhookError(rawEventId, e)
        return res.status(500).json({ error: 'webhook handler failed' })
      }
      break
    }
    case 'payment_intent.canceled': {
      // S655 (Step 10): a charge GAM canceled (a scheduled retry replaced by a
      // payment made now, a retry GAM could not re-price, a reader hold let
      // go) or one canceled in Stripe. Its rows still waiting on it are owed
      // again with no retry, the credit it set aside is given back, and its
      // receipt closes as failed. Nobody is emailed: the tenant did nothing.
      const pi = event.data.object as Stripe.PaymentIntent
      if (HELD_PURPOSES.has(pi.metadata?.gam_purpose ?? '')) break
      if (pi.metadata?.gam_debit_id) {
        const { settleGamDebit } = await import('../services/landlordGamDebit')
        await settleGamDebit(pi.id, false, 'the bank pull was canceled')
        break
      }
      try {
        // decisions.md #48.4: a pay-screen card confirmation that was canceled
        // (the 30-minute release, the screen's Cancel, or in Stripe) — the
        // same release as its failure above: the bill opens again and its
        // platform-fee link clears, and nobody is told anything.
        const { releaseFailedOnScreenConfirmation } = await import('../jobs/paymentReconcile')
        if (await releaseFailedOnScreenConfirmation(stripe, pi)) break
        const moved = await failIntentRows(pi, { mode: 'canceled', returnCode: null, decision: 'permanent', isFlexDepositPull: false, atBank: false })
        // Step 9 review (fix pass 2): a move-out balance charge canceled with
        // its row still waiting on it (canceled in Stripe, not by GAM's own
        // let-go, which reopens the row first): the balance is owed again and
        // the landlord's deposit-return page says so.
        if (moved.rows.length > 0) await noteGapChargeFromIntent(pi, 'the charge was canceled', 'did_not_go_through')
      } catch (e) {
        logger.error({ err: e, stripe_payment_intent_id: pi.id }, 'webhook payment_intent.canceled handler failed')
        await stampWebhookError(rawEventId, e)
        return res.status(500).json({ error: 'webhook handler failed' })
      }
      break
    }
    // 10/4 (decisions #38): a refund an early check-out sent that Stripe later
    // reports failed (a closed card, a bank that sent it back) — the refund
    // part is marked failed for Try again, the landlord's payout gets the
    // money back, and the owner is told (services/earlyCheckOut). Any other
    // refund is left as it was.
    case 'refund.updated':
    case 'charge.refund.updated': {
      const refund = event.data.object as Stripe.Refund
      if (refund?.metadata?.gam_purpose !== 'stay_early_checkout_refund') break
      try {
        const { stripeRefundFailed } = await import('../services/earlyCheckOut')
        const out = await stripeRefundFailed({ id: refund.id, status: refund.status, metadata: refund.metadata as any })
        // Fix pass (review r3): the refund failed before the send that made it
        // had recorded it — answered 500 so Stripe sends it again once it is
        // recorded, never 200 (that lost the failure for good).
        if (out === 'retry') {
          logger.warn({ refund_id: refund.id }, 'webhook early check-out refund: still being recorded — Stripe will send it again')
          return res.status(500).json({ error: 'refund still being recorded — send again' })
        }
        // 10/4 (decisions #47a): a move-out deposit refund that came back is
        // owed to the tenant again — its replacement part is on the owner's
        // to-do list (stripeRefundFailed told them and GAM once), and the
        // move-out's refund row reads 'pending' again, so GAM's balance book
        // counts the money it holds for it until it is actually sent.
        const depositReturnId = String(refund.metadata?.gam_deposit_return_id ?? '')
        if (out === true && UUID.test(depositReturnId)) {
          const { syncDepositRefundRow } = await import('../services/depositRefundSend')
          await syncDepositRefundRow(depositReturnId)
        }
      } catch (e) {
        logger.error({ err: e, refund_id: refund.id }, 'webhook early check-out refund handler failed')
        await stampWebhookError(rawEventId, e)
        return res.status(500).json({ error: 'webhook handler failed' })
      }
      break
    }
    case 'payout.created':
    case 'payout.paid':
    case 'payout.failed':
    case 'payout.canceled': {
      // S117: under Connect each payout fires against a connected account.
      // event.account is the Stripe Connect account id. Legacy
      // `disbursements` table writes from the GAM-rail era are retired;
      // connect_payouts is the new home.
      const payout = event.data.object as Stripe.Payout
      const accountId = (event as any).account as string | undefined
      if (!accountId) {
        logger.warn({ event_type: event.type, payout_id: payout.id }, 'webhook missing event.account — likely a platform-account payout, skipping')
        break
      }
      try {
        await recordPayoutEvent(payout, accountId)
      } catch (e) {
        logger.error({ err: e, event_type: event.type, account_id: accountId, payout_id: payout.id }, 'payout webhook handler failed')
        await createAdminNotification({
          severity: 'warn',
          category: 'webhook_payout_handler_failed',
          title:    `Connect payout webhook ${event.type} handler failed`,
          body:     e instanceof Error ? e.message : String(e),
          context:  { event_type: event.type, account_id: accountId, payout_id: payout.id },
        })
        await stampWebhookError(rawEventId, e)
        return res.status(500).json({ error: 'webhook handler failed' })
      }
      break
    }
    case 'charge.dispute.created':
    case 'charge.dispute.updated':
    case 'charge.dispute.closed':
    case 'charge.dispute.funds_withdrawn':
    case 'charge.dispute.funds_reinstated': {
      // S117: disputes hit GAM's platform balance (loss responsibility =
      // application). Record locally for the GAM-native dashboard.
      const dispute = event.data.object as Stripe.Dispute
      try {
        // Step 10 final fix (decisions #55): Stripe does not promise events
        // in order. A stale event (an inquiry's 'created' delivered after it
        // became a dispute, an 'updated' after the dispute was won) never
        // rolls the dispute on file back, and the status this event acts on
        // is the furthest one Stripe has told us (disputeStatusRank).
        //
        // Fix pass 2 (review): atomic, and a decided dispute is final. Every
        // event for this dispute takes the same lock for the read and the
        // write, so a stale event handled at the same moment as the win never
        // overwrites 'won' once it is recorded. A dispute on file as decided
        // (won, lost, warning_closed, charge_refunded — all one rank) is never
        // overwritten, not even by another decided status ('lost' after
        // 'won' would make every count read the won dispute's money as
        // taken again). The event then acts on the status on file.
        let onFile: string | null = null
        const lk = await getClient()
        try {
          await lk.query('BEGIN')
          await lk.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`connect_dispute:${dispute.id}`])
          onFile = (await lk.query<{ status: string }>(
            `SELECT status FROM connect_disputes WHERE stripe_dispute_id = $1`, [dispute.id])).rows[0]?.status ?? null
          if (!disputeStatusIsStale(onFile, dispute.status)) await recordDisputeEvent(dispute)
          await lk.query('COMMIT')
        } catch (e) {
          await lk.query('ROLLBACK').catch(() => {})
          throw e
        } finally {
          lk.release()
        }
        const stale = disputeStatusIsStale(onFile, dispute.status)
        const status = stale ? onFile! : dispute.status
        const piId = typeof dispute.payment_intent === 'string'
          ? dispute.payment_intent
          : dispute.payment_intent?.id ?? null
        const { DISPUTE_STATUSES_MONEY_TAKEN, DISPUTE_STATUS_WON } = await import('../services/creditUse')
        const moneyTaken = (DISPUTE_STATUSES_MONEY_TAKEN as readonly string[]).includes(status)
        const feeCents = (dispute.balance_transactions ?? []).reduce((s, bt) => s + Math.max(0, bt.fee ?? 0), 0)
        const disputeRow = await queryOne<{ id: string }>(
          `SELECT id FROM connect_disputes WHERE stripe_dispute_id = $1`, [dispute.id])
        const { recordChargeback } = await import('../services/heldPayouts')

        if (status === DISPUTE_STATUS_WON) {
          // Decisions #55-AMENDED: a won dispute is NOT undone automatically
          // in this deploy — no bill voided, no landlord line, no credit, no
          // chargeback given back (paymentReversal.undoWonDispute and
          // heldPayouts.recordChargeback's 'won' branch are not called). ONE
          // critical admin notice per dispute lists exactly what to undo by
          // hand, with amounts — once, whatever event says 'won' (closed,
          // funds_reinstated, a redelivery — also one whose win was recorded
          // by an earlier try that then failed). An older event read as won
          // (its own status is not 'won') changes nothing — only an event
          // that carries the win knows the fee Stripe gave back with it.
          if (dispute.status !== DISPUTE_STATUS_WON) break
          const { disputeFeeReturnedOnWinCents } = await import('../services/stripeCosts')
          const { raiseWonDisputeNotice } = await import('../services/paymentReversal')
          await raiseWonDisputeNotice({
            stripeDisputeId: dispute.id, stripeEventId: event.id || rawEventId,
            connectDisputeId: disputeRow?.id ?? null, paymentIntentId: piId,
            disputedCents: dispute.amount ?? 0, feeCents,
            feeReturnedCents: disputeFeeReturnedOnWinCents(dispute as any),
          })
          break
        }

        // S648 (Nic): a chargeback on any non-rent charge GAM held (register
        // sale, stay deposit, business invoice) is the payee's to bear —
        // there's no customer to contact. Nets against their next payout —
        // only once Stripe has taken the money (an inquiry takes none), once.
        const chargeback = await recordChargeback({
          paymentIntentId: piId, amountCents: dispute.amount ?? 0, feeCents,
          stripeDisputeId: dispute.id, disputeStatus: status,
        })

        // S561 / S655 (Step 10): every row the disputed charge paid reopens
        // (paymentReversal.handlePaymentReversal: one record per row, the
        // charge's paid-ahead money first, one fee row, one landlord notice,
        // one recovery). An ACH "unauthorized" return arrives here as a
        // dispute on a bank charge. An inquiry (warning_*) moves no money: it
        // only tells an admin, once. Step 10 final fix: the event that turns
        // it into a dispute (updated / funds_withdrawn / closed 'lost' — any
        // status under which Stripe holds the money) reverses it then —
        // exactly once per dispute (handlePaymentReversal is idempotent on
        // the dispute id), whatever event brings it.
        if (piId) {
          // A bank charge's dispute is an ACH unauthorized return.
          const viaBank = await queryOne<{ ach: boolean }>(
            `SELECT (payment_method = 'ach') AS ach FROM tenant_remittances
              WHERE stripe_payment_intent_id = $1 ORDER BY created_at LIMIT 1`, [piId])
          const bankDispute = viaBank?.ach === true
            || (dispute as any).payment_method_details?.type === 'us_bank_account'
          const { handlePaymentReversal } = await import('../services/paymentReversal')
          const reversal = await handlePaymentReversal({
            paymentIntentId:  piId,
            reversalType:     bankDispute ? 'ach_unauthorized' : 'card_dispute',
            reversedAmount:   (dispute.amount ?? 0) / 100,
            // Pass-through fee = Stripe's actual dispute fee; fallback $15.
            reversalFee:      feeCents > 0 ? feeCents / 100 : 15,
            stripeEventId:    event.id || rawEventId,
            stripeObjectId:   dispute.id,
            connectDisputeId: disputeRow?.id ?? null,
            disputeStatus:    status,
            rawEvent:         event,
          })
          // Step 9 review (fix pass 2): a disputed (or bank-returned) move-out
          // balance charge reopened its row: the balance is owed again and
          // the landlord's deposit-return page says so.
          if (reversal.handled) {
            const { noteGapChargeReturned } = await import('../services/depositReturn')
            for (const r of reversal.rows) {
              if (!r.newPaymentId) continue
              await noteGapChargeReturned(r.paymentId,
                `${event.type} ${dispute.id} (${dispute.reason ?? 'no reason given'}) took the move-out balance charge back`,
                { how: 'came_back' })
            }
          }
          // Neither a tenant payment GAM knows (the reversal alerts loudly
          // itself when it knows the charge and reopened nothing) nor a held
          // charge's payee to net it from: an admin must place it — once per
          // dispute, whatever event brings it.
          if (moneyTaken && !reversal.handled && reversal.reason === 'unknown_charge' && !chargeback.handled
              && chargeback.reason === 'not a held charge'
              && !(await queryOne(
                `SELECT 1 FROM admin_notifications WHERE category = 'dispute_charge_unplaced' AND context->>'stripe_dispute_id' = $1
                 UNION ALL
                 SELECT 1 FROM admin_notifications_archive WHERE category = 'dispute_charge_unplaced' AND context->>'stripe_dispute_id' = $1
                 LIMIT 1`, [dispute.id]))) {
            await createAdminNotification({
              severity: 'warn',
              category: 'dispute_charge_unplaced',
              title:    `A dispute on a charge GAM cannot place (${piId})`,
              body:     `Stripe opened dispute ${dispute.id} for $${((dispute.amount ?? 0) / 100).toFixed(2)} on ${piId}, ` +
                        'but no tenant payment, register sale, stay deposit or business invoice carries that charge, so nothing was reopened or netted. Find the charge and decide who bears it.',
              context:  { stripe_dispute_id: dispute.id, stripe_payment_intent_id: piId, amount_cents: dispute.amount ?? 0 },
            }).catch(() => {})
          }
          // Fix pass 1 (rev10, review): the event that took the money may not
          // have said Stripe's fee (the $15 fallback was passed on); a later
          // event of the same dispute that says it, and differs, is told to
          // an admin once — never a silent difference GAM carries.
          if (moneyTaken && feeCents > 0) {
            const { alertDisputeFeeDiffers } = await import('../services/paymentReversal')
            await alertDisputeFeeDiffers({
              stripeDisputeId: dispute.id, paymentIntentId: piId, disputedCents: dispute.amount ?? 0,
              actualFeeCents: feeCents, stripeEventId: event.id || rawEventId,
            })
          }
        }
      } catch (e) {
        // Fix pass (rev9): "try again in a moment" (a refund of this money was
        // being sent at that same moment, or Stripe could not be reached) is
        // no failure: nothing was written. A 503 makes Stripe deliver the
        // event again; no critical alert.
        const { isDisputeRetryLater } = await import('../services/creditUse')
        if (isDisputeRetryLater(e)) {
          logger.warn({ err: e, event_type: event.type, stripe_dispute_id: dispute.id }, 'dispute webhook put off: Stripe will deliver it again')
          return res.status(503).json({ error: 'try again in a moment' })
        }
        logger.error({ err: e, event_type: event.type, stripe_dispute_id: dispute.id }, 'dispute webhook handler failed')
        // S132: critical — disputes hit GAM's platform balance and have
        // legal evidence-deadlines attached. Failing to record one is
        // the kind of thing that loses the case by default.
        await createAdminNotification({
          severity: 'critical',
          category: 'webhook_dispute_handler_failed',
          title:    `Dispute webhook ${event.type} handler failed`,
          body:     e instanceof Error ? e.message : String(e),
          context:  { event_type: event.type, stripe_dispute_id: dispute.id },
        }).catch(() => {})
        await stampWebhookError(rawEventId, e)
        return res.status(500).json({ error: 'webhook handler failed' })
      }
      break
    }
    // S570: microdeposit ACH verification completes here. Tenant setup uses
      // verification_method:'microdeposits' (NOT Financial Connections instant —
      // that bills $1.50/verification). The SetupIntent stays in
      // requires_action/processing until the tenant confirms the two deposits
      // 1–3 days later; Stripe then fires setup_intent.succeeded and we flip
      // ach_verified + stamp bank metadata + log the first-sender NACHA event.
      // Idempotent: the UPDATE only fires the transition when ach_verified was
      // still FALSE, so a re-delivered event won't double-log.
    case 'setup_intent.succeeded': {
      const setupIntent = event.data.object as Stripe.SetupIntent
      const tenantId = (setupIntent.metadata?.tenantId as string | undefined) || null
      const customerId = typeof setupIntent.customer === 'string'
        ? setupIntent.customer
        : setupIntent.customer?.id ?? null

      // POS-customer FlexCharge onboarding: microdeposits clear here (the
      // /complete route can no longer stamp synchronously — the SetupIntent
      // isn't 'succeeded' at collect time). Stamp ach_verified + bank_last4,
      // set the default PM for statement billing, mark the invitation accepted.
      if (setupIntent.metadata?.gam_purpose === 'pos_customer_ach_onboarding') {
        const invId = (setupIntent.metadata?.gam_invitation_id as string | undefined) || null
        const posCustId = (setupIntent.metadata?.gam_pos_customer_id as string | undefined) || null
        if (!posCustId) break
        try {
          const pmId = typeof setupIntent.payment_method === 'string'
            ? setupIntent.payment_method : setupIntent.payment_method?.id ?? null
          let bankLast4: string | null = null
          if (pmId) {
            const pm = await getStripe().paymentMethods.retrieve(pmId)
            bankLast4 = pm.us_bank_account?.last4 ?? null
          }
          const flipped = await queryOne<{ id: string }>(
            `UPDATE pos_customers SET ach_verified = TRUE, bank_last4 = $2, updated_at = NOW()
              WHERE id = $1 AND ach_verified = FALSE RETURNING id`,
            [posCustId, bankLast4])
          if (flipped?.id && pmId && customerId) {
            try {
              await getStripe().customers.update(customerId, {
                invoice_settings: { default_payment_method: pmId },
              })
            } catch (e) { logger.error({ err: e }, '[webhook] POS default PM set failed') }
          }
          if (invId) {
            await query(`UPDATE pos_customer_invitations SET status='accepted', updated_at=NOW()
                          WHERE id=$1 AND status <> 'accepted'`, [invId])
          }
          if (flipped?.id) logger.info({ pos_customer_id: posCustId, setup_intent: setupIntent.id }, '[webhook] POS ACH microdeposits verified')
        } catch (e) {
          logger.error({ err: e, setup_intent: setupIntent.id }, 'webhook setup_intent.succeeded POS handler failed')
          await stampWebhookError(rawEventId, e)
          return res.status(500).json({ error: 'webhook handler failed' })
        }
        break
      }

      if (!tenantId && !customerId) break
      try {
        const pmId = typeof setupIntent.payment_method === 'string'
          ? setupIntent.payment_method
          : setupIntent.payment_method?.id ?? null
        let pm: Stripe.PaymentMethod | null = null
        if (pmId) pm = await getStripe().paymentMethods.retrieve(pmId)
        const isCard = setupIntent.metadata?.gam_purpose === 'tenant_card_setup' || pm?.type === 'card'

        if (isCard || !pmId) {
          // S571 guard: a CARD setup must NOT flip ach_verified / stamp bank
          // fields. Nothing else to do for a card here.
          logger.info({ tenant_id: tenantId, customer: customerId, setup_intent: setupIntent.id }, '[webhook] tenant card saved (no ACH flip)')
          break
        }

        // S607 / S655 (Steps 5 and 10): the bank verified. Recorded through the
        // one routine confirm-setup uses too (tenantBankMethods
        // .recordVerifiedTenantBank, under the tenant's bank lock): the bank
        // must still be on THIS tenant's customer; ach_verified on; the bank
        // on file named; bank_pending_since kept only while another bank still
        // verifies; the NACHA first-sender row once per bank. The new bank is
        // made the DEFAULT once per payment method ('first_time'): a tenant who
        // already had a verified bank gets the new one as default too (the old
        // FALSE→TRUE flip never fired for them), and a redelivered event never
        // takes back a default the tenant chose since.
        const { recordVerifiedTenantBank } = await import('../services/tenantBankMethods')
        const r = await recordVerifiedTenantBank({
          tenantId, customerId, paymentMethodId: pmId,
          bank: pm?.us_bank_account ?? null,
          makeDefault: 'first_time',
          note: 'Microdeposits confirmed — bank verified, first-time sender tracking initiated',
        })
        if (r.refused) {
          logger.warn({ tenant_id: r.tenantId ?? tenantId, setup_intent: setupIntent.id, refused: r.refused },
            '[webhook] verified bank not recorded')
        } else {
          logger.info({ tenant_id: r.tenantId, setup_intent: setupIntent.id, firstTime: r.firstTime, madeDefault: r.madeDefault },
            '[webhook] ACH microdeposits verified')
        }
      } catch (e) {
        logger.error({ err: e, setup_intent: setupIntent.id }, 'webhook setup_intent.succeeded handler failed')
        await stampWebhookError(rawEventId, e)
        return res.status(500).json({ error: 'webhook handler failed' })
      }
      break
    }

    case 'account.updated': {
      // S115: Connect Express account state changed (KYC clears, capability
      // activates, requirements added, etc.). S159+ also caches the
      // capability flags (charges_enabled / payouts_enabled /
      // details_submitted) on the matching users / pm_companies row so
      // gates in withdrawals.ts, autoPayouts.ts, services/pm.ts, etc. can
      // read them without a live Stripe round-trip.
      //
      // Cross-platform Stripe events that don't match a known GAM Connect
      // account are silent no-ops (UPDATE matches 0 rows).
      //
      // PROD CHECKLIST: confirm Stripe Dashboard webhook endpoint config
      // has `account.updated` enabled in the events list, otherwise none
      // of the readiness gates will ever flip true.
      const account = event.data.object as Stripe.Account
      try {
        await recordAccountUpdated(account)
      } catch (e) {
        logger.error({ err: e, stripe_account_id: account.id }, 'webhook account.updated handler failed')
        await stampWebhookError(rawEventId, e)
        return res.status(500).json({ error: 'webhook handler failed' })
      }
      break
    }

    // S494: business-invoice customer-pay completion. Stripe Checkout
    // Sessions fire this when the customer finishes the hosted-pay
    // flow. We match on the session id we stored at send time, mark
    // the invoice paid, and stamp the PaymentIntent id for audit.
    // S648: a bank payment completes checkout UNPAID and only clears days
    // later (async_payment_succeeded). Nothing is marked paid — and nothing is
    // held for a payee — until the money is actually in.
    case 'checkout.session.async_payment_succeeded':
    case 'checkout.session.completed': {
      const session = event.data.object as Stripe.Checkout.Session
      if (session.payment_status !== 'paid') {
        logger.info({ session_id: session.id, payment_status: session.payment_status }, '[webhook] checkout not paid yet — waiting for the money')
        break
      }
      // S517: public property-booking deposit → confirm the held booking.
      if (session.metadata?.gam_purpose === 'booking_deposit') {
        const bookingId = session.metadata?.gam_booking_id ?? null
        if (bookingId) {
          try {
            await confirmBookingDeposit(bookingId, session.id, {
              paymentIntentId: typeof session.payment_intent === 'string'
                ? session.payment_intent : session.payment_intent?.id ?? null,
              amountTotalCents: session.amount_total,
            })
            logger.info({ booking_id: bookingId, session_id: session.id }, '[webhook] booking deposit confirmed')
          } catch (e) {
            logger.error({ err: e, booking_id: bookingId }, '[webhook] booking deposit confirm failed')
          }
        }
        break
      }
      // S648: a register pay link was paid → record the sale, close the link,
      // confirm any stay attached to it.
      if (session.metadata?.gam_purpose === 'pos_pay_link') {
        try {
          const { finalizePayLink } = await import('./posPayLinks')
          const r = await finalizePayLink({
            id: session.id, amount_total: session.amount_total,
            payment_intent: typeof session.payment_intent === 'string'
              ? session.payment_intent : session.payment_intent?.id ?? null,
            metadata: session.metadata as any,
            customer_details: session.customer_details as any,
            custom_fields: (session as any).custom_fields ?? null,
          })
          logger.info({ session_id: session.id, ...r }, '[webhook] pay link')
        } catch (e) {
          logger.error({ err: e, session_id: session.id }, '[webhook] pay link finalize failed')
          await stampWebhookError(rawEventId, e)
          return res.status(500).json({ error: 'webhook handler failed' })
        }
        break
      }
      if (session.metadata?.gam_purpose !== 'business_invoice') {
        // Not ours — fall through silently.
        break
      }
      const piId = typeof session.payment_intent === 'string'
        ? session.payment_intent
        : session.payment_intent?.id ?? null
      const amountPaid = Number(session.amount_total ?? 0) / 100
      const paidByBank = event.type === 'checkout.session.async_payment_succeeded'
      // S511: invoices can be paid in two stages (deposit, then balance), so
      // we no longer match on a single stored session id — we look the invoice
      // up by metadata and record each payment in business_invoice_payments.
      const invoiceId = session.metadata?.business_invoice_id ?? null
      const paymentKind = session.metadata?.payment_kind === 'deposit' ? 'deposit'
        : session.metadata?.payment_kind === 'balance' ? 'balance' : 'full'
      try {
        if (!invoiceId || amountPaid <= 0) {
          logger.warn({ session_id: session.id, invoice_id: invoiceId },
            '[webhook] business_invoice checkout: missing invoice metadata or zero amount')
          break
        }
        // Idempotent ledger insert keyed by the Checkout Session id (Stripe
        // re-delivers events). On conflict we no-op so amount_paid (an additive
        // SUM) can't be double-credited. Insert only succeeds for a real invoice.
        const ins = await query<{ id: string; business_id: string }>(
          `INSERT INTO business_invoice_payments
             (business_id, invoice_id, amount, kind, method,
              stripe_checkout_session_id, stripe_payment_intent_id)
           SELECT bi.business_id, bi.id, $2, $3, $6, $4, $5
             FROM business_invoices bi
            WHERE bi.id = $1
           ON CONFLICT (stripe_checkout_session_id)
             WHERE stripe_checkout_session_id IS NOT NULL DO NOTHING
           RETURNING id, business_id`,
          // A bank payment is the only kind that clears later (S648).
          [invoiceId, amountPaid, paymentKind, session.id, piId, paidByBank ? 'ach' : 'card'],
        )
        if (ins.length > 0) {
          // S648: GAM holds the payment for the business, less GAM's cut,
          // until their weekly payout.
          const { recordHeldItem, businessInvoiceCutCents } = await import('../services/heldPayouts')
          const cents = Math.round(amountPaid * 100)
          await recordHeldItem({
            businessId: ins[0].business_id,
            sourceType: 'business_invoice_payment', sourceId: session.id,
            amount: (cents - businessInvoiceCutCents(cents, paidByBank)) / 100,
            description: `Invoice payment (${paymentKind})`,
          })
        }
        if (ins.length === 0) {
          // Already processed (re-delivery) or unknown invoice — no-op.
          logger.info({ session_id: session.id, invoice_id: invoiceId },
            '[webhook] business_invoice payment: duplicate or unknown — skipped')
          break
        }
        // Recompute the invoice from the ledger SUM. Status flips to 'paid'
        // only when the cumulative total is covered; a deposit-only payment
        // stamps deposit_paid_at but keeps status 'sent' with the balance due.
        const r = await query<{ id: string; customer_id: string }>(
          `UPDATE business_invoices bi
              SET amount_paid     = sub.paid,
                  sent_at         = COALESCE(bi.sent_at, NOW()),
                  deposit_paid_at = CASE WHEN bi.deposit_amount > 0 AND sub.paid >= bi.deposit_amount - 0.005
                                         THEN COALESCE(bi.deposit_paid_at, NOW()) ELSE bi.deposit_paid_at END,
                  status          = CASE WHEN sub.paid >= bi.total_amount - 0.005 THEN 'paid' ELSE 'sent' END,
                  paid_at         = CASE WHEN sub.paid >= bi.total_amount - 0.005 THEN COALESCE(bi.paid_at, NOW()) ELSE bi.paid_at END,
                  payment_method  = $3,
                  stripe_payment_intent_id = COALESCE(bi.stripe_payment_intent_id, $2),
                  updated_at      = NOW()
             FROM (SELECT COALESCE(SUM(amount), 0) AS paid
                     FROM business_invoice_payments WHERE invoice_id = $1) sub
            WHERE bi.id = $1
            RETURNING bi.id, bi.customer_id`,
          [invoiceId, piId, paidByBank ? 'ach' : 'card'],
        )
        if (r.length === 0) {
          logger.warn({ session_id: session.id, invoice_id: invoiceId },
            '[webhook] business_invoice recompute: invoice vanished')
          break
        }

        // S508: persist saved card to the customer row if Stripe attached
        // a Customer + saved a PM. Pull PM details (brand, last4, expiry)
        // for the UI indicator.
        const stripeCustomerId = typeof session.customer === 'string'
          ? session.customer
          : session.customer?.id ?? null
        if (stripeCustomerId && piId) {
          try {
            const pi = await stripe.paymentIntents.retrieve(piId)
            const pmId = typeof pi.payment_method === 'string'
              ? pi.payment_method
              : pi.payment_method?.id ?? null
            if (pmId) {
              const pm = await stripe.paymentMethods.retrieve(pmId)
              const card = pm.card
              await query(
                `UPDATE business_customers
                    SET stripe_customer_id        = $1,
                        default_payment_method_id = $2,
                        payment_method_brand      = $3,
                        payment_method_last4      = $4,
                        payment_method_exp_month  = $5,
                        payment_method_exp_year   = $6
                  WHERE id = $7`,
                [stripeCustomerId, pmId,
                 card?.brand ?? null,
                 card?.last4 ?? null,
                 card?.exp_month ?? null,
                 card?.exp_year ?? null,
                 r[0]!.customer_id])
              logger.info({
                customer_id: r[0]!.customer_id,
                stripe_customer_id: stripeCustomerId,
                pm_brand: card?.brand,
              }, '[S508] saved payment method on business_customer')
            }
          } catch (e) {
            // Don't fail the webhook — the invoice is already marked
            // paid. Just log and the saved-PM slot stays empty until
            // the next payment.
            logger.error({ err: e, session_id: session.id },
              '[S508] saved-PM persist failed')
          }
        }
      } catch (e) {
        logger.error({ err: e, session_id: session.id },
          'webhook checkout.session.completed (business invoice) failed')
        await stampWebhookError(rawEventId, e)
        return res.status(500).json({ error: 'webhook handler failed' })
      }
      break
    }
  }

  // Latest delivery processed clean — clear any failure stamp left by an
  // earlier delivery of this same event (fire-and-forget; best-effort).
  query(
    `UPDATE stripe_webhook_events SET processing_error = NULL
      WHERE stripe_event_id = $1 AND processing_error IS NOT NULL`,
    [rawEventId]
  ).catch(() => {})

  res.json({ received: true })
})

/**
 * Stamp a processing failure on the raw-event row (C3). Best-effort and
 * never throws — the surrounding 500 return already makes Stripe retry;
 * this just makes "which events failed processing" a one-query report.
 */
/**
 * Step 10 final fix: how far a Stripe dispute has gone — an inquiry, then a
 * dispute, then its decision. Stripe does not deliver events in order, so a
 * status on file further along than an event's is never rolled back by it.
 */
function disputeStatusRank(status: string | null | undefined): number {
  switch (status) {
    case 'warning_needs_response': return 1
    case 'warning_under_review':   return 2
    case 'needs_response':         return 3
    case 'under_review':           return 4
    case 'warning_closed':
    case 'charge_refunded':
    case 'won':
    case 'lost':                   return 5
    default:                       return 0
  }
}

/**
 * Fix pass 2 (review): an event's status never replaces the one on file when
 * the dispute is already decided (rank 5 — won, lost, warning_closed,
 * charge_refunded: final, whatever another event says) or has gone further.
 */
function disputeStatusIsStale(onFile: string | null, incoming: string | null | undefined): boolean {
  if (onFile == null) return false
  if (disputeStatusRank(onFile) === 5) return true
  return disputeStatusRank(onFile) > disputeStatusRank(incoming)
}

async function stampWebhookError(stripeEventId: string, err: unknown): Promise<void> {
  const msg = err instanceof Error ? err.message : String(err)
  try {
    await query(
      `UPDATE stripe_webhook_events SET processing_error = $2 WHERE stripe_event_id = $1`,
      [stripeEventId, msg]
    )
  } catch { /* best-effort */ }
}

// ── S655 (money plan §3, Step 10): payment_intent.succeeded ─────────────────
//
// The card or bank money for a charge arrived. In ONE transaction, under the
// household lock (§1.5: household, then the charge's receipt, then its rows by
// id):
//   - only rows still waiting on this charge settle ('processing', or a Flex
//     product's 'pending' pull, or 'failed' when a retry of the same intent
//     went through). A row already 'settled', 'returned' or 'paid_via_deposit'
//     is never touched again: a redelivered success cannot re-settle a row a
//     dispute reopened or a desk settled.
//   - credit the charge set aside on those rows becomes spent
//     (applyHeldForRemittance) BEFORE allocation, so the owner share reads the
//     row's final split (v_payment_money.gam_held_part); credit set aside on a
//     row the charge no longer pays is given back.
//   - allocation books the landlord's share (gam_held_part only) and
//     afterRowsSettled runs the shared post-settle steps.
//   - the SURPLUS rule: whatever the charge's money (the receipt's amount) did
//     not pay on the rows settled now — an over-payment, rows settled another
//     way meanwhile, a receipt whose rows never committed — becomes paid-ahead
//     money GAM holds, received now, and an admin is told when it was not
//     planned. A receipt that never committed is rebuilt from the intent.
//   - rent settled on or after a shortened stay's end banks the stay-shortened
//     money; the whole-bill check runs for any credit created, after commit.
//   - a FlexPay pull reconciles its advance and books the $25 (no owner share,
//     no Rent Collected notice).

interface SucceededRem {
  id: string; tenant_id: string; landlord_id: string; lease_id: string | null
  amount: string; unapplied_amount: string; status: string; processing_fee_amount: string
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/**
 * The product pulls whose own row is written 'pending' with its intent already
 * on it (FlexDeposit installments, pay-aheads and custody fees, FlexCredit
 * fees, FlexCharge statements and pay-downs, a FlexPay pull). Every other
 * charge claims its rows as 'processing' before the intent exists, so a
 * 'pending' row on any other intent is never one this charge was made for.
 */
const PRODUCT_PULL_PURPOSES = new Set([
  'flexpay_pull', 'flexdeposit_installment', 'flexdeposit_payahead', 'flexdeposit_custody_fee',
  'flexcredit_fee', 'flexcharge_statement', 'flexcharge_paydown',
])
const cents = (v: number | string | null | undefined): number => Math.round(Number(v ?? 0) * 100)
const dollars = (c: number): number => Math.round(c) / 100

/** The household a charge belongs to: its receipt's, else its rows', else (an orphan) what the intent's metadata names. */
async function chargeHouseholdFor(
  client: PoolClient, pi: Stripe.PaymentIntent, md: Record<string, string>,
): Promise<{ tenantId: string; landlordId: string } | null> {
  const remId = UUID.test(md.gam_remittance_id ?? '') ? md.gam_remittance_id : null
  const rem = (await client.query<{ tenant_id: string; landlord_id: string }>(
    `SELECT tenant_id, landlord_id FROM tenant_remittances
      WHERE ($1::uuid IS NOT NULL AND id = $1::uuid) OR stripe_payment_intent_id = $2
      ORDER BY (id = $1::uuid) DESC NULLS LAST, created_at LIMIT 1`, [remId, pi.id])).rows[0]
  if (rem) return { tenantId: rem.tenant_id, landlordId: rem.landlord_id }
  const row = (await client.query<{ tenant_id: string; landlord_id: string }>(
    `SELECT p.tenant_id, COALESCE(l.landlord_id, p.landlord_id) AS landlord_id
       FROM payments p LEFT JOIN leases l ON l.id = p.lease_id
      WHERE p.stripe_payment_intent_id = $1 AND p.tenant_id IS NOT NULL
      ORDER BY (p.type = 'rent') DESC, p.id LIMIT 1`, [pi.id])).rows[0]
  if (row) return { tenantId: row.tenant_id, landlordId: row.landlord_id }
  if (UUID.test(md.tenant_id ?? '') && UUID.test(md.landlord_id ?? '')) {
    const ok = (await client.query(
      `SELECT 1 FROM tenants t, landlords l WHERE t.id = $1 AND l.id = $2`, [md.tenant_id, md.landlord_id])).rowCount
    if (ok) return { tenantId: md.tenant_id, landlordId: md.landlord_id }
  }
  return null
}

/**
 * The money part of a charge from its gross: the gross less the processing fee
 * the tenant paid on top, by the shared fee formula and the property's fee
 * payer (exactly what the charge added). Null when no money amount gives this
 * gross (something else rode the charge): a person must look.
 */
export function moneyFromGross(
  grossCents: number, method: 'ach' | 'card', tenantPaysFee: boolean, cardCountry: string | null,
): number | null {
  if (!tenantPaysFee) return grossCents
  const fits = (m: number) => m > 0 && m + cents(processingFeeFor({ amount: dollars(m), paymentMethod: method, cardCountry })) === grossCents
  // The fee is at most a few percent: search near the gross.
  const guess = method === 'ach'
    ? grossCents - cents(processingFeeFor({ amount: dollars(grossCents), paymentMethod: 'ach' }))
    : Math.round(grossCents / 1.06)
  for (let d = 0; d <= Math.max(200, Math.round(grossCents * 0.05)); d++) {
    for (const m of [guess + d, guess - d]) if (fits(m)) return m
  }
  return null
}

/**
 * A receipt whose commit never happened (the process stopped after Stripe
 * took the charge and before GAM's transaction committed): no rows carry the
 * intent and no receipt exists, but the money arrived. It is rebuilt from the
 * intent's metadata (gam_remittance_id, tenant_id, landlord_id, gam_lease_id)
 * with the tenant's processing fee taken off, so the surplus rule banks the
 * money as paid ahead. When the fee cannot be told apart from the money, the
 * receipt is recorded and NOTHING is banked: an admin decides.
 */
async function rebuildOrphanRemittance(
  client: PoolClient, pi: Stripe.PaymentIntent, md: Record<string, string>,
  who: { tenantId: string; landlordId: string }, charge: Stripe.Charge | null, paymentMethod: PaymentMethod | null,
): Promise<{ rem: SucceededRem; bank: boolean } | null> {
  if (!UUID.test(md.gam_remittance_id ?? '')) return null
  const leaseId = UUID.test(md.gam_lease_id ?? '')
    ? (await client.query<{ id: string }>(`SELECT id FROM leases WHERE id = $1 AND landlord_id = $2`,
        [md.gam_lease_id, who.landlordId])).rows[0]?.id ?? null
    : null
  const grossCents = Math.round(Number((pi as any).amount_received ?? pi.amount ?? 0))
  if (!(grossCents > 0)) return null
  const method: 'ach' | 'card' = paymentMethod ?? ((pi.payment_method_types ?? []).includes('us_bank_account') ? 'ach' : 'card')
  const payer = leaseId ? (await client.query<{ ach_fee_payer: string | null; card_fee_payer: string | null }>(
    `SELECT par.ach_fee_payer, par.card_fee_payer
       FROM leases l JOIN units u ON u.id = l.unit_id
       LEFT JOIN property_allocation_rules par ON par.property_id = u.property_id
      WHERE l.id = $1`, [leaseId])).rows[0] : undefined
  const feePayer = method === 'ach' ? payer?.ach_fee_payer : payer?.card_fee_payer
  const country = (charge as any)?.payment_method_details?.card?.country ?? null
  const moneyCents = moneyFromGross(grossCents, method, feePayer !== 'landlord', country)
  const bank = moneyCents !== null && !!leaseId
  const amount = moneyCents ?? grossCents
  const ins = await client.query<SucceededRem>(
    `INSERT INTO tenant_remittances
       (id, tenant_id, lease_id, landlord_id, amount, applied_amount, unapplied_amount, status,
        payment_method, stripe_payment_intent_id, gross_amount, processing_fee_amount, notes)
     VALUES ($1, $2, $3, $4, $5, 0, $5, 'processing', $6, $7, $8, $9, $10)
     ON CONFLICT DO NOTHING
     RETURNING id, tenant_id, landlord_id, lease_id, amount::text, unapplied_amount::text, status,
               processing_fee_amount::text`,
    [md.gam_remittance_id, who.tenantId, leaseId, who.landlordId, dollars(amount).toFixed(2), method, pi.id,
     dollars(grossCents).toFixed(2), dollars(grossCents - amount).toFixed(2),
     'Rebuilt from the card or bank payment: its record never saved when it was made'])
  if (!ins.rows[0]) return null
  return { rem: ins.rows[0], bank }
}

interface SucceededOutcome {
  settledIds: string[]
  /** Settled now, not re-payments of reopened rows: the PM-transfer and Rent Collected set. */
  freshRows: { id: string; type: string }[]
  afterSettle: { afterCommit: () => Promise<void> } | null
  supersedenceTransfers: { paymentId: string; transfers: PostCommitTransfer[]; residual: number; tenantId: string | null }[]
  /** Whole-bill checks to run after commit (a credit was created). */
  wholeBill: Array<{ tenantId: string; landlordId: string; onlyLeaseIds?: string[] }>
  /** The event reopened rows (credit that turned out to be disputed money): one recovery decision. */
  reopened: boolean
  /**
   * Rows settled now and reopened in this same event for the credit part that
   * turned out to be disputed money: never announced as paid in full (no
   * Rent Collected line, no receipt line).
   */
  reopenedIds: string[]
  /** The receipt for the rows this charge paid, sent after the commit. */
  receipt: { method: string; creditBanked: number | undefined } | null
  alerts: Array<Parameters<typeof createAdminNotification>[0]>
}

async function settleSucceededIntent(stripe: Stripe, pi: Stripe.PaymentIntent, eventId: string): Promise<void> {
  const md = (pi.metadata ?? {}) as Record<string, string>

  // A FlexPay pull whose intent never reached its row: recorded on the row its
  // metadata names (never tenant credit, never an orphan receipt).
  if (md.gam_purpose === 'flexpay_pull') {
    const onRow = await queryOne(`SELECT 1 FROM payments WHERE stripe_payment_intent_id = $1 LIMIT 1`, [pi.id])
    if (!onRow) {
      const { adoptFlexPayPullIntent } = await import('../services/flexpay')
      await adoptFlexPayPullIntent(pi as any)
      return
    }
  }

  const charge = await resolveCharge(stripe, pi)
  const paymentMethod = extractPaymentMethod(charge)
  // S652 (Nic): the book records the margin from Stripe's ACTUAL fee on this
  // charge, not a rate-table guess. Best effort.
  let actualStripeFeeTotal: number | null = null
  try {
    const btRef = (charge as any)?.balance_transaction
    const bt = typeof btRef === 'string' ? await stripe.balanceTransactions.retrieve(btRef) : btRef
    if (bt && typeof bt.fee === 'number') actualStripeFeeTotal = bt.fee / 100
  } catch { actualStripeFeeTotal = null }
  // S113-Phase2.5: the charge id, for post-commit transfers' source_transaction.
  const stripeChargeId = charge?.id ?? null

  const out: SucceededOutcome = {
    settledIds: [], freshRows: [], afterSettle: null, supersedenceTransfers: [], wholeBill: [], reopened: false,
    reopenedIds: [], receipt: null, alerts: [],
  }
  const { lockHousehold } = await import('../services/moneyPredicates')
  const {
    applyHeldForRemittance, releaseHeldForRemittance, createPaidAhead, reverseHeldSpendsOfDisputedMoney,
    takeBackDisputedCredit,
  } = await import('../services/creditUse')

  const client = await getClient()
  try {
    await client.query('BEGIN')
    const who = await chargeHouseholdFor(client, pi, md)
    if (who) await lockHousehold(client, who.tenantId, who.landlordId)

    // The receipt, then the rows, locked.
    const remId = UUID.test(md.gam_remittance_id ?? '') ? md.gam_remittance_id : null
    let rem = (await client.query<SucceededRem>(
      `SELECT id, tenant_id, landlord_id, lease_id, amount::text, unapplied_amount::text, status,
              processing_fee_amount::text
         FROM tenant_remittances
        WHERE ($1::uuid IS NOT NULL AND id = $1::uuid) OR stripe_payment_intent_id = $2
        ORDER BY (id = $1::uuid) DESC NULLS LAST, created_at LIMIT 1
        FOR UPDATE`, [remId, pi.id])).rows[0] ?? null
    const rowIds = (await client.query<{ id: string }>(
      `SELECT id FROM payments WHERE stripe_payment_intent_id = $1 ORDER BY id FOR UPDATE`, [pi.id])).rows.map(r => r.id)
    const rows = rowIds.length === 0 ? [] : (await client.query<{
      id: string; status: string; retry_scheduled: boolean; manual_method: string | null; stripe_charge_id: string | null
    }>(
      `SELECT id, status, next_retry_at IS NOT NULL AS retry_scheduled, manual_method, stripe_charge_id
         FROM payments WHERE id = ANY($1::uuid[]) ORDER BY id`,
      [rowIds])).rows
    // Plan §3: success settles the rows waiting on this charge — rows claimed
    // for it ('processing'), a row whose retry is still scheduled (its credit
    // is still held), and a product pull's own 'pending' row. A row that
    // failed for good gave back its credit and closed its receipt: never
    // settled here (the money is banked by the surplus rule, with an alert).
    const productPull = PRODUCT_PULL_PURPOSES.has(md.gam_purpose ?? '')
    const settleIds = rows.filter(r =>
      r.status === 'processing'
      || (r.status === 'failed' && r.retry_scheduled)
      || (r.status === 'pending' && productPull)).map(r => r.id)

    let bankSurplus = true
    let rebuilt = false
    if (!rem && rows.length === 0 && who) {
      const r = await rebuildOrphanRemittance(client, pi, md, who, charge, paymentMethod)
      if (r) { rem = r.rem; bankSurplus = r.bank; rebuilt = true }
    }
    if (!rem && rows.length === 0) {
      // No row and no receipt: not a charge GAM made for a bill (or one whose
      // metadata names nothing). Logged; nothing to settle.
      await client.query('COMMIT')
      logger.warn({ stripe_payment_intent_id: pi.id }, '[webhook] succeeded intent matches no charge row and no receipt')
      return
    }
    // A replay: the receipt is settled and nothing is waiting on this charge.
    if (rem?.status === 'settled' && settleIds.length === 0) {
      await client.query('COMMIT')
      return
    }

    // A bill row still 'pending' with this intent on it was never claimed by
    // this charge (every bill charge claims its rows 'processing' first). The
    // intent would keep it from ever being paid (payableRowSql refuses a
    // pending row that carries one): it is cleared, so the row stays payable —
    // by the paid-ahead money this charge banks below, or by any payment.
    const unclaimedIds = productPull ? [] : rows.filter(r => r.status === 'pending').map(r => r.id)
    if (unclaimedIds.length > 0) {
      await client.query(
        `UPDATE payments SET stripe_payment_intent_id = NULL
          WHERE id = ANY($1::uuid[]) AND status = 'pending' AND stripe_payment_intent_id = $2`,
        [unclaimedIds, pi.id])
    }

    // Rows on the charge, none waiting on it, and no receipt to bank the money
    // on (a product pull whose row failed for good, say): the money arrived
    // and nothing here can record it. A person places it — unless a row on it
    // was settled by this very charge (a redelivery).
    if (!rem && settleIds.length === 0 && rows.length > 0) {
      // A settled row with no charge id recorded (a product pull settled
      // before the charge id was kept) is this charge's own row too: only a
      // DIFFERENT charge id on it means some other payment paid it.
      const paidByThis = rows.some(r => (r.status === 'settled' || r.status === 'returned') && !r.manual_method
        && (!stripeChargeId || r.stripe_charge_id == null || r.stripe_charge_id === stripeChargeId))
      if (!paidByThis) {
        out.alerts.push({
          severity: 'critical', category: 'stripe_success_unplaced',
          title: `A card or bank payment arrived with nothing waiting on it (${pi.id})`,
          body: `Stripe says this payment of $${dollars(Math.round(Number((pi as any).amount_received ?? pi.amount ?? 0))).toFixed(2)} went through, ` +
            `but none of its charges was still waiting on it (${rows.map(r => `${r.id} (${r.status})`).join(', ')}) and there is no receipt to keep the money on as credit. ` +
            'Nothing was recorded. Place the money by hand: pay the charge it was for, or refund it.',
          context: { stripe_payment_intent_id: pi.id, purpose: md.gam_purpose ?? null, rows: rows.map(r => ({ id: r.id, status: r.status })) },
        })
      }
    }
    const remWasSettled = rem?.status === 'settled'

    // Credit the charge set aside: given back where the charge no longer pays
    // the row, spent where it does — before allocation reads the split.
    if (rem) {
      await releaseHeldForRemittance(client, rem.id, 'superseded', { exceptPaymentIds: settleIds })
      await applyHeldForRemittance(client, rem.id)
    }

    // Flip the rows still waiting on this charge to settled.
    const settled = settleIds.length === 0 ? { rows: [] as any[] } : await client.query<{
      id: string; type: string; tenant_id: string | null; lease_id: string | null; revenue_owner: string
      unit_id: string | null; reversal_id: string | null; entry_description: string | null; landlord_id: string
    }>(
      `UPDATE payments
          SET status = 'settled', settled_at = NOW(), next_retry_at = NULL,
              stripe_charge_id = COALESCE($2, stripe_charge_id)
        WHERE id = ANY($1::uuid[]) AND status IN ('processing', 'pending', 'failed')
        RETURNING id, type, tenant_id, lease_id, revenue_owner, unit_id, reversal_id, entry_description, landlord_id`,
      [settleIds, stripeChargeId])
    const settledRows = [...settled.rows].sort((a, b) => a.id.localeCompare(b.id))
    out.settledIds = settledRows.map(r => r.id)
    out.freshRows = settledRows.filter(r => !r.reversal_id).map(r => ({ id: r.id, type: r.type }))

    // I8: a landlord row GAM holds nothing for (credit the landlord holds or
    // gave paid it whole) is not platform-held — never derived for a deposit
    // (held in trust) or a held box row. Only when the charge is known: money
    // is counted on a row only once its Stripe charge is recorded.
    if (stripeChargeId && out.settledIds.length > 0) {
      await client.query(
        `UPDATE payments p
            SET platform_held = COALESCE((SELECT vm.gam_held_part > 0 FROM v_payment_money vm WHERE vm.payment_id = p.id), p.platform_held)
          WHERE p.id = ANY($1::uuid[]) AND p.revenue_owner = 'landlord' AND p.type <> 'deposit'
            AND NOT (p.entry_description = 'DEPOSIT' AND p.lease_fee_id IS NULL)`,
        [out.settledIds])
    }

    for (const row of settledRows) {
      // A reopened row paid again: the reversal resolves; the landlord gets
      // the re-payment only if they were already clawed back (S561).
      if (row.reversal_id) {
        const { resolveReversalOnTenantPayment } = await import('../services/paymentReversal')
        const reDisburse = await resolveReversalOnTenantPayment(client, row.reversal_id)
        const allocatable = (ALLOCATABLE_PAYMENT_TYPES as readonly string[]).includes(row.type)
          && row.revenue_owner === 'landlord' && !!row.unit_id
        if (reDisburse && allocatable) {
          if (!paymentMethod) throw new Error(`payment_intent ${pi.id} succeeded but its payment method could not be read (payment ${row.id})`)
          await executeRentAllocation(client, row.id, paymentMethod, { actualStripeFeeTotal })
        }
      } else {
        const allocatable = (ALLOCATABLE_PAYMENT_TYPES as readonly string[]).includes(row.type)
          && row.revenue_owner === 'landlord' && !!row.unit_id
        if (allocatable) {
          if (!paymentMethod) {
            throw new Error(`payment_intent ${pi.id} succeeded but payment_method could not be ` +
              `determined from charges payload (${row.type} payment ${row.id})`)
          }
          // S609: rent and utilities stay STRICT (a failed allocation rolls the
          // settle back so Stripe retries); late fees and landlord fees are
          // lenient — a late fee must never roll back the tenant's rent.
          const strict = row.type === 'rent' || row.type === 'utility'
          if (strict) {
            await executeRentAllocation(client, row.id, paymentMethod, { actualStripeFeeTotal })
          } else {
            await client.query('SAVEPOINT fee_alloc')
            try {
              await executeRentAllocation(client, row.id, paymentMethod, { actualStripeFeeTotal })
              await client.query('RELEASE SAVEPOINT fee_alloc')
            } catch (allocErr) {
              await client.query('ROLLBACK TO SAVEPOINT fee_alloc')
              logger.error({ err: allocErr, payment_id: row.id, type: row.type },
                '[settle] fee allocated to nobody — payment still settled')
              out.alerts.push({
                severity: 'warn',
                category: 'fee_allocation_failed',
                title: `A ${row.type} could not be credited to the landlord (payment ${row.id})`,
                body: `The tenant's payment settled normally, but this charge could not be split out to the landlord — usually a property missing its payout configuration. The money is held on the platform; fix the configuration and re-run allocation for this payment.`,
                context: { payment_id: row.id, type: row.type, stripe_payment_intent_id: pi.id },
              })
            }
          }
        }
      }

      // S122: the linked utility bill is paid (a reopened line's bill hangs on
      // the row its reversal reopened).
      if (row.type === 'utility') {
        await client.query(
          `UPDATE utility_bills SET status = 'paid', paid_at = NOW(), updated_at = NOW()
            WHERE payment_id = $1
               OR payment_id = (SELECT pr.payment_id FROM payment_reversals pr WHERE pr.id = $2::uuid)`,
          [row.id, row.reversal_id])
      }

      // S615 / S655: a FlexPay pull settled — its advance reconciles and the
      // $25 is booked, in this transaction. Never an owner share, never a Rent
      // Collected notice (the row is GAM's own 'fee').
      if (row.entry_description === 'FLEXPAY') {
        const { reconcileSettledFlexPayPayment } = await import('../services/flexpay')
        await reconcileSettledFlexPayPayment(row.id, client)
      }
      // S515: a security deposit row advances its deposit record (self-gates).
      await (await import('../services/leaseFeesSync')).reconcileSettledDepositPayment(row.id, client)

      // S261: GAM-supersedence — the boost part of this payment pays the
      // tenant's GAM balances FIFO (idempotent; self-gates).
      const result = await applyTenantSupersedence(client, row.id)
      if (result.applied) {
        out.supersedenceTransfers.push({
          paymentId: row.id, transfers: result.post_commit_transfers,
          residual: result.amount_residual, tenantId: row.tenant_id ?? null,
        })
      }
    }

    // The shared post-settle steps for the rows settled now: going live and
    // the on-time / late mark. Before any row is reopened below: the tenant
    // did pay this charge. The receipt is sent after the commit (out.receipt),
    // for the rows this charge paid in full — never a row reopened below.
    const kind = paymentMethod ?? ((pi.payment_method_types ?? [])[0] === 'us_bank_account' ? 'ach' : 'card')
    const receipt = { method: kind === 'ach' ? 'bank transfer' : 'card', creditBanked: undefined as number | undefined }
    out.receipt = receipt
    out.afterSettle = await afterRowsSettled(client, out.settledIds, { attestationSource: 'stripe_attested', receipt: null })

    // Credit this charge set aside that turned out to be disputed money (the
    // credit's own funding was disputed while this charge was in flight): each
    // such spend is undone and its row reopens for the use amount — after the
    // row is allocated, with the landlord's recovery recorded on this event.
    if (rem) {
      const hit = await reverseHeldSpendsOfDisputedMoney(client, rem.id, { drain: false })
      if (hit.reversed.length > 0) {
        const { writeRowReversal } = await import('../services/paymentReversal')
        const byRow = new Map<string, { cents: number; creditId: string }>()
        for (const u of hit.reversed) {
          const e = byRow.get(u.paymentId) ?? { cents: 0, creditId: u.creditId }
          e.cents += cents(u.amount)
          byRow.set(u.paymentId, e)
        }
        const recordByCredit = new Map<string, string>()
        for (const [paymentId, e] of [...byRow.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
          const funding = (await client.query<{ pi: string | null; method: string | null; dispute_id: string | null; returned_type: string | null }>(
            `SELECT r.stripe_payment_intent_id AS pi, r.payment_method AS method,
                    (SELECT d.id FROM connect_disputes d WHERE d.stripe_payment_intent_id = r.stripe_payment_intent_id
                      ORDER BY d.created_at DESC LIMIT 1) AS dispute_id,
                    (SELECT pr.reversal_type FROM payment_reversals pr JOIN payments p ON p.id = pr.payment_id
                      WHERE p.stripe_payment_intent_id = r.stripe_payment_intent_id AND pr.reversal_type <> 'card_dispute'
                      LIMIT 1) AS returned_type
               FROM lease_prepaid_credits c JOIN tenant_remittances r ON r.id = c.source_remittance_id
              WHERE c.id = $1`, [e.creditId])).rows[0]
          const type: PaymentReversalType = (funding?.returned_type as PaymentReversalType | null)
            ?? (funding?.method === 'ach' ? 'ach_unauthorized' : 'card_dispute')
          const row = (await client.query<any>(
            `SELECT id, type, amount::text AS amount, invoice_id, tenant_id, landlord_id, lease_id, unit_id,
                    due_date::text AS due_date, entry_description, revenue_owner, lease_fee_id, notes
               FROM payments WHERE id = $1 FOR UPDATE`, [paymentId])).rows[0]
          if (!row) continue
          const rr = await writeRowReversal(client, {
            row, lostCents: e.cents, reversalType: type, reversalFee: 0,
            stripeEventId: eventId, stripeObjectId: funding?.pi ?? null, connectDisputeId: funding?.dispute_id ?? null,
            rawEvent: { id: eventId, type: 'payment_intent.succeeded', note: 'credit on this charge was disputed money', funding_payment_intent: funding?.pi ?? null },
            kind: 'credit_spend',
          })
          if (rr) {
            out.reopened = out.reopened || rr.landlordRecovery
            if (rr.newPaymentId) out.reopenedIds.push(paymentId)
            if (!recordByCredit.has(e.creditId)) recordByCredit.set(e.creditId, rr.reversalId)
          }
        }
        for (const creditId of hit.pendingCredits) {
          await takeBackDisputedCredit(client, creditId, recordByCredit.get(creditId) ?? null)
        }
        out.alerts.push({
          severity: 'warn',
          category: 'disputed_credit_spent_on_charge',
          title: `A payment used credit whose money was disputed (${pi.id})`,
          body: `The payment settled, but $${dollars([...byRow.values()].reduce((s, e) => s + e.cents, 0)).toFixed(2)} of account credit it used came from a payment that was disputed or returned. Those charges were reopened for the credit part; the tenant owes them again.`,
          context: { stripe_payment_intent_id: pi.id, reopened_payment_ids: [...byRow.keys()] },
        })
      }
    }

    // THE SURPLUS RULE: the receipt's money that no row settled now paid
    // becomes paid-ahead money GAM holds, received today.
    let creditBanked = 0
    if (rem && !remWasSettled) {
      const onRows = out.settledIds.length === 0 ? 0 : cents((await client.query<{ s: string }>(
        `SELECT COALESCE(SUM(vm.money_part), 0)::text AS s FROM v_payment_money vm WHERE vm.payment_id = ANY($1::uuid[])`,
        [out.settledIds])).rows[0]?.s)
      const surplus = cents(rem.amount) - onRows
      const planned = cents(rem.unapplied_amount)
      await client.query(
        `UPDATE tenant_remittances
            SET status = 'settled', settled_at = COALESCE(settled_at, NOW()), updated_at = NOW(),
                applied_amount = $2, unapplied_amount = $3
          WHERE id = $1`,
        [rem.id, dollars(Math.max(0, onRows)).toFixed(2), dollars(Math.max(0, surplus)).toFixed(2)])
      // The receipt's lines are the rows it paid. A line it was planned for
      // and did not pay (settled another way meanwhile, or never claimed) is
      // not one: its planned application goes, in this transaction, so the
      // receipt's lines and applied_amount agree and no bill reads as paid by
      // two payments (paymentsByMonth reads these as each payment's lines).
      // The money it carried is the surplus banked below, never a line (#36.A).
      await client.query(
        `DELETE FROM remittance_applications
          WHERE remittance_id = $1 AND NOT (payment_id = ANY($2::uuid[]))`,
        [rem.id, out.settledIds])
      if (surplus < 0) {
        out.alerts.push({
          severity: 'critical', category: 'stripe_receipt_short',
          title: `A card or bank payment paid more on its rows than it brought in (${pi.id})`,
          body: `Receipt ${rem.id} brought $${dollars(cents(rem.amount)).toFixed(2)} but the rows it settled carry $${dollars(onRows).toFixed(2)} of money. Check the charge and its rows.`,
          context: { stripe_payment_intent_id: pi.id, remittance_id: rem.id, money: dollars(cents(rem.amount)), on_rows: dollars(onRows) },
        })
      } else if (surplus > 0) {
        const already = (await client.query(`SELECT 1 FROM lease_prepaid_credits WHERE source_remittance_id = $1`, [rem.id])).rowCount
        const lease = rem.lease_id
          ?? (await client.query<{ lease_id: string }>(
                `SELECT lease_id FROM payments WHERE id = ANY($1::uuid[]) AND lease_id IS NOT NULL ORDER BY id LIMIT 1`,
                [out.settledIds])).rows[0]?.lease_id
          ?? null
        if (!already && bankSurplus && lease) {
          await createPaidAhead(client, {
            leaseId: lease, tenantId: rem.tenant_id, amount: dollars(surplus), fundedBy: 'gam', receivedAt: new Date(),
            sourceRemittanceId: rem.id, note: 'Paid ahead through GAM',
          })
          creditBanked = dollars(surplus)
          receipt.creditBanked = creditBanked
          out.wholeBill.push({ tenantId: rem.tenant_id, landlordId: rem.landlord_id, onlyLeaseIds: [lease] })
        }
        if (surplus !== planned || rebuilt || !bankSurplus || !lease) {
          const elsewhere = rows.filter(r => !settleIds.includes(r.id) && !unclaimedIds.includes(r.id)).map(r => `${r.id} (${r.status})`)
          const unclaimed = unclaimedIds.map(id => `${id} (pending)`)
          out.alerts.push({
            severity: bankSurplus && lease ? 'warn' : 'critical',
            category: 'stripe_surplus_banked',
            title: bankSurplus && lease
              ? `$${dollars(surplus).toFixed(2)} of a card or bank payment was kept as paid-ahead credit (${pi.id})`
              : `$${dollars(surplus).toFixed(2)} of a card or bank payment has no bill and was not put on credit (${pi.id})`,
            body: (rebuilt
                ? 'The payment\'s record never saved when it was made, so it was rebuilt from the payment itself. '
                : elsewhere.length > 0 || unclaimed.length > 0
                  ? (elsewhere.length > 0
                      ? `Part of what it was paying was no longer waiting on it — settled another way, or already failed for good (${elsewhere.join(', ')}). `
                      : '') +
                    (unclaimed.length > 0
                      ? `A charge carried this payment but was never claimed by it (${unclaimed.join(', ')}); it stays owed and can be paid. `
                      : '')
                  : 'It paid less of the bill than planned. ') +
              (bankSurplus && lease
                ? 'The rest is the tenant\'s paid-ahead credit (GAM holds it) and pays their next bill.'
                : !lease
                  ? 'There is no lease to hold it as credit. Decide with the landlord what to do with it.'
                  : 'The processing fee could not be told apart from the money, so nothing was put on credit. Record it by hand.'),
            context: { stripe_payment_intent_id: pi.id, remittance_id: rem.id, surplus: dollars(surplus), planned: dollars(planned),
                       rebuilt, settled_elsewhere: elsewhere, never_claimed: unclaimedIds },
          })
        }
      }

      // The tenant's processing fee is GAM's whatever the charge paid: when no
      // row booked it (nothing of the landlord's settled — rows settled
      // elsewhere, an orphan, only GAM fees paid), it is booked on the receipt.
      const booked = (await client.query(
        `SELECT 1 FROM platform_revenue_ledger l
          WHERE l.type = 'banking_spread'
            AND ((l.reference_type = 'payment' AND l.reference_id IN (SELECT id FROM payments WHERE stripe_payment_intent_id = $1))
                 OR (l.reference_type = 'tenant_remittance' AND l.reference_id = $2::uuid))
          LIMIT 1`, [pi.id, rem.id])).rowCount
      const fee = cents(rem.processing_fee_amount)
      if (!booked && fee > 0) {
        if (actualStripeFeeTotal != null) {
          const { recordPlatformRevenue } = await import('../services/platformRevenue')
          await recordPlatformRevenue({
            type: 'banking_spread', amount: dollars(fee - cents(actualStripeFeeTotal)), customerFeeCharged: dollars(fee),
            referenceId: rem.id, referenceType: 'tenant_remittance',
            notes: `Banking spread on ${paymentMethod ?? 'card or bank'} charge ${pi.id} (no landlord row on it booked the fee)`,
          }, client)
        } else {
          out.alerts.push({
            severity: 'warn', category: 'stripe_fee_unbooked',
            title: `The processing fee on a payment was not booked (${pi.id})`,
            body: `The tenant paid a $${dollars(fee).toFixed(2)} processing fee on this payment, but no landlord row booked it and Stripe's own fee could not be read. Book GAM's spread by hand.`,
            context: { stripe_payment_intent_id: pi.id, remittance_id: rem.id, fee: dollars(fee) },
          })
        }
      }
    }

    // Rent settled on or after a shortened stay's end banks the stay-shortened
    // money (bookingLeaseBilling); its own savepoint — never undoes the settle.
    if (out.settledIds.length > 0) {
      const { bankShortenedStaysAfterSettle } = await import('../services/bookingLeaseBilling')
      await client.query('SAVEPOINT stay_shortened_hook')
      try {
        for (const b of await bankShortenedStaysAfterSettle(client, out.settledIds)) {
          out.wholeBill.push({ tenantId: b.tenantId, landlordId: b.landlordId, onlyLeaseIds: [b.leaseId] })
        }
        await client.query('RELEASE SAVEPOINT stay_shortened_hook')
      } catch (e) {
        await client.query('ROLLBACK TO SAVEPOINT stay_shortened_hook')
        logger.error({ err: e, payment_ids: out.settledIds }, '[webhook] could not bank rent paid past a shortened stay')
      }
    }

    await client.query('COMMIT')
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    client.release()
  }

  // ── After the commit ───────────────────────────────────────────────────────
  for (const a of out.alerts) await createAdminNotification(a).catch(() => {})
  await out.afterSettle?.afterCommit()
  await sendSucceededReceipt(out)
  await afterSucceededCommit(pi, eventId, out)
}

/**
 * The tenant's receipt for the rows this charge settled — the one receipt
 * (services/paymentReceipt), after the commit. A row reopened in the same event
 * (its credit was disputed money) is left out: the receipt would print it as
 * paid in full, and it is owed again. Never throws.
 */
async function sendSucceededReceipt(out: SucceededOutcome): Promise<void> {
  if (!out.receipt) return
  const reopened = new Set(out.reopenedIds)
  const ids = out.settledIds.filter(id => !reopened.has(id))
  if (ids.length === 0) return
  try {
    const { sendPaymentReceipt } = await import('../services/paymentReceipt')
    await sendPaymentReceipt({ ...out.receipt, paymentIds: ids })
  } catch (e) {
    logger.error({ err: e, paymentIds: ids }, '[webhook] receipt failed')
  }
}

/** The success webhook's work after its commit: transfers, product reconcilers, notices, the whole-bill check. Never throws. */
async function afterSucceededCommit(pi: Stripe.PaymentIntent, eventId: string, out: SucceededOutcome): Promise<void> {
  // S119 post-commit: fire Stripe Transfers for any PM company cuts that landed
  // on the ledger as ghosts. After the commit, so no lock waits on Stripe.
  for (const row of out.freshRows) {
    if (row.type !== 'rent' && row.type !== 'utility') continue
    try {
      await firePmTransfersForReference('payment', row.id)
    } catch (e) {
      logger.error({ err: e, payment_id: row.id, payment_type: row.type }, 'pm_transfer post-commit firing failed')
      await createAdminNotification({
        severity: 'warn',
        category: 'pm_transfer_post_commit_failed',
        title:    `PM transfer firing failed for ${row.type} payment ${row.id}`,
        body:     e instanceof Error ? e.message : String(e),
        context:  { payment_id: row.id, payment_type: row.type },
      }).catch(() => {})
    }
    // S113-Phase1: the manager-fee Transfer, when allocation wrote one.
    try {
      await fireManagerTransfersForReference('payment', row.id)
    } catch (e) {
      logger.error({ err: e, payment_id: row.id, payment_type: row.type }, 'manager_transfer post-commit firing failed')
      await createAdminNotification({
        severity: 'warn',
        category: 'manager_transfer_post_commit_failed',
        title:    `Manager transfer firing failed for ${row.type} payment ${row.id}`,
        body:     e instanceof Error ? e.message : String(e),
        context:  { payment_id: row.id, payment_type: row.type },
      }).catch(() => {})
    }
  }

  // S261 post-commit: FlexCharge merchant Transfers for statements the
  // supersedence boost paid (the merchant share less GAM's 1.5% cut, S583).
  for (const entry of out.supersedenceTransfers) {
    for (const t of entry.transfers) {
      if (t.source !== 'flexcharge_statement') continue
      if (!t.destination_connect_account) {
        await createAdminNotification({
          severity: 'warn',
          category: 'flexcharge_merchant_transfer_pending',
          title:    `FlexCharge merchant Transfer waiting (supersedence) — statement ${t.ref_id}`,
          body:     `Statement ${t.ref_id} satisfied via supersedence from payment ${entry.paymentId}; merchant share $${t.amount.toFixed(2)} is on platform balance pending landlord Connect onboarding.`,
          context:  { statement_id: t.ref_id, paid_via_payment_id: entry.paymentId, amount: t.amount },
        }).catch(() => {})
        continue
      }
      try {
        const stripeApi = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: '2023-10-16' })
        await stripeApi.transfers.create(
          {
            amount:      Math.round(t.amount * 100),
            currency:    'usd',
            destination: t.destination_connect_account,
            description: `FlexCharge merchant payout (supersedence) — statement ${t.ref_id}`,
            metadata: {
              gam_purpose:             'flexcharge_merchant_payout',
              gam_statement_id:        t.ref_id,
              gam_via_supersedence:    'true',
              gam_paid_via_payment_id: entry.paymentId,
            },
          },
          { idempotencyKey: `flexcharge_payout_super_${t.ref_id}` },
        )
      } catch (e) {
        logger.error({ err: e, statement_id: t.ref_id, paid_via_payment_id: entry.paymentId }, 'supersedence flexcharge-merchant-transfer failed')
        await createAdminNotification({
          severity: 'warn',
          category: 'flexcharge_merchant_transfer_failed_supersedence',
          title:    `FlexCharge merchant Transfer failed (supersedence) — statement ${t.ref_id}`,
          body:     e instanceof Error ? e.message : String(e),
          context:  { statement_id: t.ref_id, paid_via_payment_id: entry.paymentId, amount: t.amount },
        }).catch(() => {})
      }
    }
    if (entry.residual > 0.005) {
      await createAdminNotification({
        severity: 'warn',
        category: 'supersedence_residual_unallocated',
        title:    `Supersedence residual unallocated — payment ${entry.paymentId}`,
        body:     `Payment ${entry.paymentId} carried $${entry.residual.toFixed(2)} of supersedence boost that exceeded the tenant's live GAM-debt total at settle. Funds remain on platform balance.`,
        context:  { payment_id: entry.paymentId, residual: entry.residual, tenant_id: entry.tenantId },
      }).catch(() => {})
    }
  }

  // The opt-in products' own records, for every row settled fresh now. Each
  // self-gates on its own kind of row and uses its own connection, so it runs
  // AFTER the commit: inside the settle transaction it could not see the row
  // settled, and one that writes the payment row would wait on the settle's
  // own lock. (Before S655 they ran only for rent-like landlord rows with a
  // unit, so a FlexDeposit installment, a custody fee or a FlexCharge
  // statement never reconciled from here.) Best effort; logged.
  const meta = (pi.metadata ?? {}) as Record<string, string>
  for (const row of out.freshRows) {
    if (row.type === 'rent') {
      try {
        // OTP is shelved (landlord-only); this no-ops while it is hidden.
        const { reconcileSettledRentPayment } = await import('../services/otp')
        await reconcileSettledRentPayment(row.id)
      } catch (e) { logger.error({ err: e, payment_id: row.id }, 'otp reconcile-on-settle failed') }
      try {
        const { creditSublessorMarkupForPayment } = await import('../services/subleaseAllocation')
        await creditSublessorMarkupForPayment(row.id)
      } catch (e) { logger.error({ err: e, payment_id: row.id }, 'sublease credit-on-settle failed') }
    }
    try {
      const { reconcileSettledFlexDepositPayment } = await import('../services/flexDeposit')
      await reconcileSettledFlexDepositPayment(row.id, meta)
    } catch (e) { logger.error({ err: e, payment_id: row.id }, 'flexdeposit reconcile-on-settle failed') }
    try {
      const { reconcileSettledFlexChargeStatement } = await import('../services/flexCharge')
      await reconcileSettledFlexChargeStatement(row.id)
    } catch (e) { logger.error({ err: e, payment_id: row.id }, 'flexcharge reconcile-on-settle failed') }
    if (meta.gam_purpose === 'flexcharge_paydown') {
      try {
        const { reconcileFlexChargePaydown } = await import('../services/flexCharge')
        await reconcileFlexChargePaydown(row.id, meta)
      } catch (e) { logger.error({ err: e, payment_id: row.id }, 'flexcharge paydown reconcile failed') }
    }
  }

  // S174 / S183 / S642: one Rent Collected notice per tenant + unit with the
  // whole amount and its breakdown, to the property's responsible party. An
  // event with no rent stays quiet. Never names FlexPay (a pull is a GAM fee).
  const eventGroups = new Map<string, { rowIds: string[]; hasRent: boolean }>()
  // A row reopened in this event for its disputed-credit part is owed again:
  // never announced as collected.
  const reopenedNow = new Set(out.reopenedIds)
  for (const row of out.freshRows) {
    if (reopenedNow.has(row.id)) continue
    try {
      const keyRow = await query<{ tenant_id: string; unit_id: string }>(
        `SELECT tenant_id::text, unit_id::text FROM payments WHERE id = $1 AND revenue_owner = 'landlord'`, [row.id])
      const k = keyRow[0]
      if (!k || !k.tenant_id || !k.unit_id) continue
      const key = `${k.tenant_id}:${k.unit_id}`
      const g = eventGroups.get(key) ?? { rowIds: [], hasRent: false }
      g.rowIds.push(row.id)
      if (row.type === 'rent') g.hasRent = true
      eventGroups.set(key, g)
    } catch (e) {
      logger.error({ err: e, payment_id: row.id }, 'rent-collected grouping failed')
    }
  }
  for (const [, group] of eventGroups) {
    if (!group.hasRent) continue
    try {
      // Lines are named the way every other notice names them (decisions
      // #17: "Water", never "Utilities" or a raw type): flexpay.billLineLabel
      // over the shared naming facts.
      const { BILL_LINE_NAME_FACTS_SQL, billLineLabel } = await import('../services/flexpay')
      const ctx = await query<{
        amount: string; type: string; notes: string | null; entry_description: string | null; utility_type: string | null
        landlord_id_pk: string; property_id: string
        tenant_name: string; unit_number: string; property_name: string
      }>(
        `SELECT p.amount, p.type, ${BILL_LINE_NAME_FACTS_SQL},
                l.id  AS landlord_id_pk,
                pr.id AS property_id,
                tu.first_name || ' ' || tu.last_name AS tenant_name,
                un.unit_number,
                pr.name AS property_name
           FROM payments p
           JOIN tenants    t  ON t.id = p.tenant_id
           JOIN users      tu ON tu.id = t.user_id
           JOIN landlords  l  ON l.id = p.landlord_id
           JOIN units      un ON un.id = p.unit_id
           JOIN properties pr ON pr.id = un.property_id
          WHERE p.id = ANY($1::uuid[])
          ORDER BY CASE p.type WHEN 'rent' THEN 0 WHEN 'utility' THEN 1
                               WHEN 'fee' THEN 2 ELSE 3 END`,
        [group.rowIds],
      )
      if (!ctx.length) continue
      const c = ctx[0]
      const total = Math.round(ctx.reduce((sum, r) => sum + parseFloat(r.amount), 0) * 100) / 100
      const breakdown = ctx.length > 1
        ? ctx.map((r) => ({ label: billLineLabel(r), amount: parseFloat(r.amount) }))
        : undefined
      const { getPropertyResponsibleParty } = await import('../services/responsibleParty')
      const targets = await getPropertyResponsibleParty(c.property_id)
      if (!targets) continue
      const { notifyRentCollected } = await import('../services/notifications')
      for (const recipient of targets.primaries) {
        await notifyRentCollected({
          landlordUserId: recipient.user_id,
          landlordId:     c.landlord_id_pk,
          landlordEmail:  recipient.email,
          landlordPhone:  recipient.phone ?? undefined,
          tenantName:     c.tenant_name,
          unitNumber:     c.unit_number,
          propertyName:   c.property_name,
          amount:         total,
          breakdown,
        })
      }
    } catch (e) {
      logger.error({ err: e, payment_ids: group.rowIds }, 'rent-collected-notify failed')
    }
  }

  // A credit created here (the surplus, money banked for a shortened stay):
  // the bill it covers in full settles now, in its own transaction.
  const { runWholeBillCheckAfterCommit } = await import('../services/creditUse')
  for (const w of out.wholeBill) await runWholeBillCheckAfterCommit(w)

  // Rows reopened by this event: ONE recovery decision for the event.
  if (out.reopened) {
    try {
      const { decideEventRecovery } = await import('../services/reversalRecovery')
      await decideEventRecovery(eventId)
    } catch (e) { logger.error({ err: e, stripe_event_id: eventId }, '[webhook] recovery decision failed') }
  }
}

// ── S655 (Step 10): payment_intent.payment_failed / payment_intent.canceled ──
//
// Guards: only rows still waiting on THIS charge move ('processing', or a Flex
// product's 'pending' pull). A row already 'failed' is a redelivery — its retry
// date and notices are never moved or sent again — and a 'settled', 'returned'
// or 'paid_via_deposit' row is never reopened by a failure of an old intent.
//
// Credit the charge set aside: a retryable bounce keeps it held (the retry may
// still bring the money; the receipt stays 'processing'); a final failure or a
// cancel gives it back and closes the receipt as failed. The rows are then
// payable again.

type FailedPullRow = { id: string; retry_count: number; amount: string; type: string; entry_description: string | null }

interface FailedOutcome {
  rows: FailedPullRow[]
  willRetry: boolean
  anchor: FailedPullRow | null
  pullTotal: number
  flexAfter: Array<() => Promise<void>>
  flexRetryRows: Array<{ id: string; retryDay: string }>
}

/** Move a failed or canceled charge's rows; returns what moved (nothing on a redelivery). */
async function failIntentRows(
  pi: Stripe.PaymentIntent,
  a: {
    mode: 'failed' | 'canceled'; returnCode: string | null; decision: 'retry' | 'permanent'; isFlexDepositPull: boolean
    /** The tenant's bank refused or returned the debit (achRetry.bankRefusedDebit), readable reason or not. */
    atBank: boolean
  },
): Promise<FailedOutcome> {
  const md = (pi.metadata ?? {}) as Record<string, string>
  const out: FailedOutcome = { rows: [], willRetry: false, anchor: null, pullTotal: 0, flexAfter: [], flexRetryRows: [] }
  const { lockHousehold } = await import('../services/moneyPredicates')
  const { releaseHeldForRemittance } = await import('../services/creditUse')
  const { pickPullAnchor } = await import('../services/achRetry')
  const client = await getClient()
  try {
    await client.query('BEGIN')
    const who = await chargeHouseholdFor(client, pi, md)
    if (who) await lockHousehold(client, who.tenantId, who.landlordId)
    const remId = UUID.test(md.gam_remittance_id ?? '') ? md.gam_remittance_id : null
    const rem = (await client.query<{ id: string; status: string }>(
      `SELECT id, status FROM tenant_remittances
        WHERE ($1::uuid IS NOT NULL AND id = $1::uuid) OR stripe_payment_intent_id = $2
        ORDER BY (id = $1::uuid) DESC NULLS LAST, created_at LIMIT 1
        FOR UPDATE`, [remId, pi.id])).rows[0] ?? null
    const locked = (await client.query<FailedPullRow & { status: string }>(
      `SELECT id, status, COALESCE(retry_count, 0) AS retry_count, amount::text AS amount, type, entry_description
         FROM payments WHERE stripe_payment_intent_id = $1 ORDER BY id FOR UPDATE`, [pi.id])).rows
    const live = locked.filter(r => r.status === 'processing' || r.status === 'pending')
    const liveIds = live.map(r => r.id)

    // A canceled intent is never confirmed again: no retry stays scheduled on it.
    if (a.mode === 'canceled') {
      await client.query(
        `UPDATE payments SET next_retry_at = NULL
          WHERE stripe_payment_intent_id = $1 AND status = 'failed' AND next_retry_at IS NOT NULL`, [pi.id])
    }

    if (liveIds.length > 0) {
      // S124 / S654: NACHA retry — retryable and under the cap: the start of the
      // property's calendar day three days out (the day the tenant is told).
      // A FlexPay pull retries on its own schedule (the FlexPay terms).
      const isFlexPull = live.some(r => r.entry_description === 'FLEXPAY')
      const maxRetries = isFlexPull ? FLEXPAY_PULL_MAX_RETRIES : 2
      const retryDays = isFlexPull ? FLEXPAY_PULL_RETRY_DAYS : 3
      out.willRetry = a.mode === 'failed' && a.decision === 'retry' && !a.isFlexDepositPull
        && Math.max(...live.map(r => Number(r.retry_count))) < maxRetries
      const tz = `COALESCE((SELECT pr.timezone FROM units un JOIN properties pr ON pr.id = un.property_id
                             WHERE un.id = payments.unit_id), 'America/Phoenix')`
      out.rows = (out.willRetry
        ? await client.query<FailedPullRow>(
            `UPDATE payments
                SET status = 'failed', return_code = $2,
                    next_retry_at = (((NOW() AT TIME ZONE ${tz})::date + $3::int)::timestamp AT TIME ZONE ${tz})
              WHERE id = ANY($1::uuid[])
              RETURNING id, COALESCE(retry_count, 0) AS retry_count, amount::text AS amount, type, entry_description`,
            [liveIds, a.returnCode, retryDays])
        : await client.query<FailedPullRow>(
            `UPDATE payments
                SET status = 'failed', return_code = COALESCE($2, return_code), next_retry_at = NULL
              WHERE id = ANY($1::uuid[])
              RETURNING id, COALESCE(retry_count, 0) AS retry_count, amount::text AS amount, type, entry_description`,
            [liveIds, a.returnCode])).rows.sort((x, y) => x.id.localeCompare(y.id))
      out.anchor = pickPullAnchor(out.rows)
      out.pullTotal = Math.round(out.rows.reduce((s, r) => s + Number(r.amount), 0) * 100) / 100
      if (out.willRetry && isFlexPull) {
        const day = (await client.query<{ id: string; d: string }>(
          `SELECT id, ((NOW() AT TIME ZONE ${tz})::date + $2::int)::text AS d FROM payments WHERE id = ANY($1::uuid[])`,
          [out.rows.filter(r => r.entry_description === 'FLEXPAY').map(r => r.id), retryDays])).rows
        out.flexRetryRows = day.map(r => ({ id: r.id, retryDay: r.d }))
      }
    }

    // The receipt and the credit it set aside.
    if (rem && !out.willRetry && (liveIds.length > 0 || a.mode === 'canceled')) {
      await releaseHeldForRemittance(client, rem.id, a.mode === 'canceled' ? 'payment_canceled' : 'payment_failed')
      await client.query(
        `UPDATE tenant_remittances SET status = 'failed', updated_at = NOW() WHERE id = $1 AND status = 'processing'`,
        [rem.id])
    }

    // A FlexPay pull that will not be retried: its advance is handled now,
    // in this transaction; its notices go after the commit.
    if (!out.willRetry) {
      const { handleFlexPayPaymentNsf } = await import('../services/flexpay')
      for (const r of out.rows.filter(x => x.entry_description === 'FLEXPAY')) {
        // Whose failure it is — flexpay.FlexPayFailureSide, FlexPay terms
        // §4.3: a debit the tenant's bank refused or returned is the
        // tenant's, whether or not GAM can read the bank's reason (a frozen
        // or restricted account names no R-code here, and is still the
        // bank's answer); only a cancel, or a failure Stripe says GAM's own
        // request caused, is GAM's (the collection is made again, never held
        // against the tenant).
        const gamSide = a.mode === 'canceled' || !a.atBank
        const fx = await handleFlexPayPaymentNsf(r.id, client, {
          gamSide,
          why: !gamSide ? null : a.mode === 'canceled' ? 'the pull was canceled' : 'Stripe refused GAM\'s own request for the pull',
        })
        out.flexAfter.push(fx.afterCommit)
      }
    }
    await client.query('COMMIT')
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    client.release()
  }
  for (const send of out.flexAfter) {
    try { await send() } catch (e) { logger.error({ err: e }, '[webhook] FlexPay notice failed') }
  }
  return out
}

/**
 * Step 9 review (fix pass 2): when `pi` is a move-out balance charge
 * (depositReturn.attemptGapAutoCharge: metadata gam_kind 'deposit_return_gap',
 * gam_payment_id = the move-out balance row) that will not go through, tell
 * the landlord once (depositReturn.noteGapChargeReturned). Any other intent:
 * nothing. Never throws.
 */
async function noteGapChargeFromIntent(
  pi: Stripe.PaymentIntent, detail: string, how: 'came_back' | 'did_not_go_through' | 'card_declined',
): Promise<void> {
  const md = (pi.metadata ?? {}) as Record<string, string>
  if (md.gam_kind !== 'deposit_return_gap' || !UUID.test(md.gam_payment_id ?? '')) return
  try {
    const { noteGapChargeReturned } = await import('../services/depositReturn')
    await noteGapChargeReturned(md.gam_payment_id, `${detail} (${pi.id})`, { how })
  } catch (e) {
    logger.error({ err: e, stripe_payment_intent_id: pi.id }, '[webhook] move-out balance charge note failed')
  }
}

/** payment_intent.payment_failed for a tenant charge (see failIntentRows for the guards). */
async function handleFailedIntent(stripe: Stripe, pi: Stripe.PaymentIntent): Promise<void> {
  const md = (pi.metadata ?? {}) as Record<string, string>
  // A FlexPay pull whose intent never reached its row: GAM reads its reason on
  // the row its metadata names (flexpay.adoptFlexPayPullIntent).
  if (md.gam_purpose === 'flexpay_pull') {
    const onRow = await queryOne(`SELECT 1 FROM payments WHERE stripe_payment_intent_id = $1 LIMIT 1`, [pi.id])
    if (!onRow) {
      const { adoptFlexPayPullIntent } = await import('../services/flexpay')
      await adoptFlexPayPullIntent(pi as any)
      return
    }
  }

  const { extractReturnCode, decideRetry, pullNoticeContext, bankRefusedDebit } = await import('../services/achRetry')
  let returnCode = extractReturnCode(pi)
  // S654: the event usually carries latest_charge as a bare id. When the
  // intent itself names no reason, read the charge's failure_code — an
  // unreadable reason is treated as final, so a missed read here would deny a
  // short-of-money bounce its retries. resolveCharge never throws.
  if (!returnCode && typeof pi.latest_charge === 'string' && pi.latest_charge) {
    const ch = await resolveCharge(stripe, pi)
    if (ch) returnCode = extractReturnCode({ ...pi, latest_charge: ch } as Stripe.PaymentIntent)
  }
  const decision = decideRetry(returnCode)
  const reasonText = (returnCode && ACH_RETURN_CONFIG[returnCode]?.description)
    || 'Payment processor reported the charge failed'

  // FlexDeposit installment + voluntary pay-ahead pulls bypass the generic
  // retry pipeline: installment retries fire on their pre-scheduled
  // retry_pull_date; a failed pay-ahead is benign.
  const isFlexDepositPull = (
    md.gam_purpose === 'flexdeposit_installment' ||
    md.gam_purpose === 'flexdeposit_payahead'
  )

  const atBank = returnCode != null || bankRefusedDebit(pi)
  const moved = await failIntentRows(pi, { mode: 'failed', returnCode, decision, isFlexDepositPull, atBank })
  const updatedRow = moved.anchor
  const willRetry = moved.willRetry
  const pullTotal = moved.pullTotal
  // A redelivery (every row already failed) or a charge with no rows: nothing
  // moved, so nothing is billed or sent again.
  if (!updatedRow) return
  const isFlexPayPull = moved.rows.some(r => r.entry_description === 'FLEXPAY')

  // Step 9 review (fix pass 2): a move-out balance charge that failed for good
  // (no retry coming): the balance is owed again and the landlord's
  // deposit-return page says so. A retry still coming says nothing yet.
  if (!willRetry) {
    const bank = (pi.payment_method_types ?? []).includes('us_bank_account')
    // Leftovers fix: a card the bank declined is said as declined
    // (depositReturn.GAP_CHARGE_REASON.cardDeclined), never the generic wording.
    await noteGapChargeFromIntent(pi,
      `payment_intent.payment_failed${returnCode ? ` (${returnCode})` : ''}: ${reasonText}`,
      bank ? 'came_back' : pi.last_payment_error?.type === 'card_error' ? 'card_declined' : 'did_not_go_through')
  }

  // S603: declined-CARD-attempt fee ($1.00, entry_description 'DECLINEFEE').
  // Stripe bills per AUTHORIZATION, so EVERY refused attempt costs GAM $0.28
  // with no revenue — hence this fires on every decline, not just the
  // terminal one. ACH is excluded: it carries its own $4.00 RETURNFEE.
  // Idempotent by PaymentIntent (the deterministic note is the dedupe key).
  const pmType = (pi.last_payment_error as any)?.payment_method?.type
  const isCardAttempt = pmType
    ? pmType === 'card'
    : (pi.payment_method_types || []).includes('card')
        && !(pi.payment_method_types || []).includes('us_bank_account')
  if (isCardAttempt) {
    try {
      const declineNote = `Declined card attempt — ${pi.id}`
      await query(
        `INSERT INTO payments
           (unit_id, lease_id, tenant_id, landlord_id, type, amount, status,
            entry_description, due_date, invoice_id, notes, revenue_owner)
         -- -- S609: GAM's own fee (REVENUE_OWNERS, packages/shared) — never an owner share.
         SELECT p.unit_id, p.lease_id, p.tenant_id, p.landlord_id, 'fee', $2,
                'pending', 'DECLINEFEE', CURRENT_DATE, p.invoice_id, $3, 'gam'
           FROM payments p
          WHERE p.id = $1
            AND p.tenant_id IS NOT NULL
            AND NOT EXISTS (
              SELECT 1 FROM payments d
               WHERE d.entry_description = 'DECLINEFEE' AND d.notes = $3
            )`,
        [updatedRow.id, CARD_DECLINE_FEE.toFixed(2), declineNote])
    } catch (e) {
      logger.error({ err: e, payment_id: updatedRow.id, pi: pi.id }, 'decline-fee insert failed')
    }
  }

  // Terminal (no retry coming): the credit ledger's payment_failed_nsf and the
  // opt-in products' own failure handling. A still-retrying payment is alive —
  // the tenant's record only takes a hit when it flunks for good. FlexPay's
  // pull was handled inside failIntentRows (its advance, in the transaction).
  if (!willRetry) {
    try {
      const pinfo = await query<{ id: string; tenant_id: string | null; type: string; amount: string; due_date: string }>(
        `SELECT id, tenant_id, type, amount, due_date::text AS due_date FROM payments WHERE id=$1`,
        [updatedRow.id],
      )
      const p = pinfo[0]
      if (p && p.tenant_id && (p.type === 'rent' || p.type === 'utility')) {
        const ledgerClient = await getClient()
        try {
          await emitPaymentFailedEvent(ledgerClient, {
            tenantId:               p.tenant_id,
            paymentId:              p.id,
            paymentType:            p.type as 'rent' | 'utility',
            amount:                 p.amount,
            dueDate:                p.due_date,
            failedAt:               new Date(),
            stripePaymentIntentId:  pi.id,
            failureCode:            returnCode ?? null,
            failureMessage:         reasonText,
          })
        } finally {
          ledgerClient.release()
        }
        // OTP NSF default (S155; gated/no-op while OTP is hidden).
        if (p.type === 'rent') {
          try {
            const { handleRentPaymentNsf } = await import('../services/otp')
            await handleRentPaymentNsf(p.id)
          } catch (e) {
            logger.error({ err: e, payment_id: p.id }, 'otp nsf-handler failed')
          }
        }
      }
      // S246 / S514 / S654: FlexDeposit NSF dispatcher (custody model);
      // self-gates on type 'deposit' + entry 'DEPOSIT'.
      if (p) {
        try {
          const { handleFlexDepositPaymentNsf } = await import('../services/flexDeposit')
          await handleFlexDepositPaymentNsf(p.id)
        } catch (e) {
          logger.error({ err: e, payment_id: p.id }, 'flexdeposit nsf-handler failed')
        }
      }
      // S253: FlexCharge statement NSF (self-gates on SUBSCRIP + a statement).
      if (p) {
        try {
          const { handleFlexChargeStatementNsf } = await import('../services/flexCharge')
          await handleFlexChargeStatementNsf(p.id)
        } catch (e) {
          logger.error({ err: e, payment_id: p.id }, 'flexcharge nsf-handler failed')
        }
      }
    } catch (e) {
      logger.error({ err: e, stripe_payment_intent_id: pi.id }, 'credit-ledger failed-payment emit failed')
    }
  }

  // S654: a FlexDeposit pull gets neither generic notice — the tenant alone is
  // told, in a tenant-only notice true to the plan.
  if (isFlexDepositPull) {
    try {
      const { notifyFlexDepositPullFailed } = await import('../services/notifications')
      const { payNowLink } = await import('../services/invoiceNotice')
      const who = (await query<{ tenant_user_id: string; tenant_email: string | null }>(
        `SELECT t.user_id AS tenant_user_id, u.email AS tenant_email
           FROM payments p JOIN tenants t ON t.id = p.tenant_id JOIN users u ON u.id = t.user_id
          WHERE p.id = $1`, [updatedRow.id]))[0]
      if (who) {
        const isPayAhead = md.gam_purpose === 'flexdeposit_payahead'
        const inst = isPayAhead ? null : (await query<{ attempt_count: number; retry_pull_date: string | null; status: string }>(
          `SELECT i.attempt_count, i.status,
                  CASE WHEN i.retry_pull_date > (NOW() AT TIME ZONE COALESCE(pr.timezone, 'America/Phoenix'))::date
                       THEN i.retry_pull_date::text END AS retry_pull_date
             FROM flex_deposit_installments i
             JOIN payments p ON p.id = i.payment_id
             LEFT JOIN units u ON u.id = p.unit_id
             LEFT JOIN properties pr ON pr.id = u.property_id
            WHERE i.payment_id = $1`, [updatedRow.id]))[0]
        if (isPayAhead || inst) {
          let leaseUrl: string | null = null
          try { leaseUrl = payNowLink(who, '/lease') } catch (e) {
            logger.error({ err: e, payment_id: updatedRow.id }, 'flexdeposit notice link failed')
          }
          await notifyFlexDepositPullFailed({
            tenantUserId: who.tenant_user_id,
            tenantEmail:  who.tenant_email,
            amount:       pullTotal,
            reason:       (returnCode && ACH_RETURN_CONFIG[returnCode]?.plain) || null,
            outcome:      isPayAhead ? 'pay_ahead'
                        : (inst!.status === 'missed' || inst!.attempt_count >= 2) ? 'missed' : 'will_retry',
            retryDate:    inst?.retry_pull_date ?? null,
            leaseUrl,
          })
        }
      }
    } catch (e) {
      logger.error({ err: e, payment_id: updatedRow.id }, 'flexdeposit-pull-notify failed')
    }
    return
  }

  // A FlexPay pull: the tenant alone hears of it, in FlexPay's own words (the
  // landlord was paid by the cover and never hears of FlexPay). A retry names
  // its day and what it collects; a final failure was told by the FlexPay
  // handler (FlexPay ended).
  if (isFlexPayPull) {
    if (willRetry) {
      const { notifyTenantPullRetry } = await import('../services/flexpay')
      for (const r of moved.flexRetryRows) await notifyTenantPullRetry(r.id, r.retryDay)
    }
    return
  }

  // S125 / S186: the retry-scheduled or retries-exhausted notice, through the
  // responsible-party resolver; one call per failed pull (S654).
  try {
    const pctx = await pullNoticeContext(updatedRow.id)
    if (pctx) {
      const { notifyAchRetryScheduled, notifyAchRetriesExhausted } = await import('../services/notifications')
      const landlordRecipients = pctx.landlordRecipients
      const reasonPlain = (returnCode && ACH_RETURN_CONFIG[returnCode]?.plain) || null
      if (willRetry) {
        const retryDate = addDaysTo(todayIn(pctx.property_tz), 3)
        // 10/5: the tenant's reply reaches the property — for the landlord's
        // own charges; a GAM product's retry stays with GAM support.
        const landlordOwned = (await queryOne<{ ok: boolean }>(
          `SELECT revenue_owner = 'landlord' AS ok FROM payments WHERE id = $1`, [updatedRow.id]))?.ok === true
        await notifyAchRetryScheduled({
          propertyId:      landlordOwned ? pctx.property_id : null,
          tenantUserId:    pctx.tenant_user_id,
          tenantEmail:     pctx.tenant_email,
          tenantName:      pctx.tenant_name,
          landlordId:      pctx.landlord_id_pk,
          landlordRecipients,
          unitNumber:      pctx.unit_number,
          propertyName:    pctx.property_name,
          amount:          pullTotal,
          reason:          reasonPlain,
          retryDate,
          retryAttempt:    (updatedRow.retry_count + 1) as 1 | 2,
        })
      } else {
        // S654 (Nic): the "cannot be retried" email gets a Pay now button and
        // says which of its reasons it is.
        const { payNowLink } = await import('../services/invoiceNotice')
        let payUrl: string | null = null
        try {
          payUrl = payNowLink({ tenant_user_id: pctx.tenant_user_id, tenant_email: pctx.tenant_email })
        } catch (e) {
          logger.error({ err: e, payment_id: pctx.id }, 'ach-retries-exhausted pay link failed')
        }
        await notifyAchRetriesExhausted({
          paymentId:       pctx.id,
          tenantUserId:    pctx.tenant_user_id,
          tenantEmail:     pctx.tenant_email,
          tenantName:      pctx.tenant_name,
          landlordId:      pctx.landlord_id_pk,
          landlordRecipients,
          unitNumber:      pctx.unit_number,
          propertyName:    pctx.property_name,
          amount:          pullTotal,
          reason:          reasonPlain,
          finalReason:     isCardAttempt ? 'card_declined'
                         : decision === 'retry' ? 'retries_used' : 'bank_refused',
          attempts:        updatedRow.retry_count + 1,
          payUrl,
        })
      }
    }
  } catch (e) {
    // A notice failure never fails the webhook (Stripe would retry the whole thing).
    logger.error({ err: e, payment_id: updatedRow.id }, 'ach-retry-notify failed')
  }
}

/**
 * Resolve the Charge for a succeeded PaymentIntent. S560: Stripe removed the
 * `charges` list from the PaymentIntent resource in API version 2022-11-15,
 * replacing it with `latest_charge` (a string id, or the expanded object).
 * Modern accounts (GAM's is 2026) render webhook payloads at the new version,
 * so `charges.data[0]` is empty — reading it returned null, which made
 * allocation throw and the webhook retry forever. Read `latest_charge`
 * (retrieving the charge when it's just an id), with a legacy `charges.data[0]`
 * fallback so both payload shapes work.
 */
async function resolveCharge(stripe: Stripe, pi: Stripe.PaymentIntent): Promise<Stripe.Charge | null> {
  const latest = (pi as any).latest_charge
  if (latest && typeof latest === 'object') return latest as Stripe.Charge
  if (typeof latest === 'string' && latest) {
    try { return await stripe.charges.retrieve(latest) } catch { return null }
  }
  return (pi as any).charges?.data?.[0] ?? null
}

/**
 * Map a Stripe charge's payment_method_details.type to GAM's collapsed bucket.
 * - 'us_bank_account' (ACH debit) → 'ach'
 * - 'card' (credit + debit, collapsed S64) → 'card'
 * - Anything else (link, cashapp, etc.) → null; allocation will throw.
 */
function extractPaymentMethod(charge: Stripe.Charge | null | undefined): PaymentMethod | null {
  const type = charge?.payment_method_details?.type
  if (type === 'us_bank_account') return 'ach'
  // S654: a card tapped on the counter reader (card_present / interac_present)
  // is still a card — same rate row, same fee payer, same settlement path.
  if (type === 'card' || type === 'card_present' || type === 'interac_present') return 'card'
  return null
}

// ── S605: Resend delivery events ─────────────────────────────────────────
//
// Nic asked whether we can tell if a self-signed-up landlord actually received
// (and read) their outreach email. Delivery is the reliable half and this is it:
// Resend posts `email.delivered` / `email.bounced` / `email.complained` /
// `email.delivery_delayed`, and we stamp them onto the send-log row.
//
// This is NOT open tracking. Opens need a 1x1 pixel, and Apple Mail Privacy
// Protection pre-fetches remote images for every message, so "opened" is a
// false positive for a large share of recipients (and a false negative for
// anyone blocking images). The outreach email is deliberately image-free so it
// reads as a person rather than a campaign. The honest engagement signal is the
// booking-link click, recorded in routes/agent.ts on the prefill call.
//
// A BOUNCE is the actionable one: it means every future email to that landlord
// is going nowhere, which previously looked identical to healthy delivery.
//
// Raw body is required for signature verification — mounted with express.raw()
// in index.ts alongside the Stripe webhook.
webhooksRouter.post('/resend', async (req, res) => {
  const secret = process.env.RESEND_WEBHOOK_SECRET
  if (!secret) {
    // Fail CLOSED and loudly. Accepting unverified payloads would let anyone
    // mark a landlord's address bounced; silently 200-ing would hide that the
    // endpoint was never configured.
    logger.error('[resend-webhook] RESEND_WEBHOOK_SECRET is not set — rejecting')
    return res.status(503).json({ error: 'Webhook not configured' })
  }

  let event: any
  try {
    // Resend signs with Svix headers (svix-id / svix-timestamp / svix-signature).
    // The Webhook class does constant-time comparison and enforces the
    // timestamp window, so replayed or tampered payloads are rejected.
    const { Webhook } = await import('svix')
    const payload = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : JSON.stringify(req.body)
    event = new Webhook(secret).verify(payload, {
      'svix-id':        String(req.headers['svix-id'] ?? ''),
      'svix-timestamp': String(req.headers['svix-timestamp'] ?? ''),
      'svix-signature': String(req.headers['svix-signature'] ?? ''),
    })
  } catch (err: any) {
    logger.warn({ err: err?.message }, '[resend-webhook] signature verification failed')
    return res.status(400).json({ error: 'Invalid signature' })
  }

  // e.g. 'email.delivered' → 'delivered'
  const type = String(event?.type ?? '')
  const kind = type.startsWith('email.') ? type.slice('email.'.length) : type
  const messageId = event?.data?.email_id ?? event?.data?.id ?? null

  // Ack anything we don't model — Resend must not retry forever over an event
  // type we simply don't record.
  if (!messageId || !['delivered', 'bounced', 'complained', 'delivery_delayed'].includes(kind)) {
    return res.json({ received: true, ignored: true })
  }

  try {
    // Only move the state FORWARD in time. Svix delivers at-least-once and out
    // of order is possible, so a late 'delivered' must never overwrite a
    // 'bounced' that happened after it.
    const updated = await query<{ id: string; to_email: string; landlord_id: string | null }>(
      `UPDATE email_send_log
          SET last_event = $2, last_event_at = $3::timestamptz
        WHERE provider_message_id = $1
          AND (last_event_at IS NULL OR last_event_at < $3::timestamptz)
      RETURNING id, to_email, landlord_id`,
      [messageId, kind, event?.created_at ?? new Date().toISOString()])

    // A hard bounce or spam complaint on a landlord we're trying to onboard is
    // worth a human looking at — everything else is just bookkeeping.
    if (updated[0] && (kind === 'bounced' || kind === 'complained')) {
      await createAdminNotification({
        severity: 'warn',
        category: 'email_delivery_failure',
        title: `Email ${kind}: ${updated[0].to_email}`,
        body: kind === 'bounced'
          ? `Mail to ${updated[0].to_email} bounced, so every future email to this address is going nowhere. Check the address before more outreach.`
          : `${updated[0].to_email} marked GAM mail as spam. Stop emailing this address.`,
        context: { toEmail: updated[0].to_email, landlordId: updated[0].landlord_id, messageId, kind },
      }).catch(() => {})

      // ── S651: AND TELL THE LANDLORD ────────────────────────────────────
      //
      // Until now this raised a GAM-side alert and stopped. Nic: "the admin
      // portal is not going to babysit that every day for every person. It
      // needs to flag on the landlord side."
      //
      // He is right, and it is not only about workload. GAM cannot fix a
      // bounced address — only the person who can phone the tenant and ask how
      // it is actually spelled can, and that is the landlord. An alert that
      // lands where nobody can act on it is a rumor.
      //
      // Pushed rather than left on a page, because a banner only works if
      // somebody happens to open the right screen. Nic went three weeks without
      // knowing a tenant was unreachable.
      if (updated[0].landlord_id) {
        try {
          const owner = await queryOne<{ user_id: string; business_name: string | null }>(
            `SELECT user_id, business_name FROM landlords WHERE id = $1`, [updated[0].landlord_id])
          // Who this address belongs to, so the notice names a person rather
          // than an address the landlord has to go and look up.
          const who = await queryOne<{ first_name: string; last_name: string; unit_number: string | null }>(
            `SELECT u.first_name, u.last_name,
                    (SELECT un.unit_number FROM lease_tenants lt
                       JOIN leases l ON l.id = lt.lease_id
                       JOIN units un ON un.id = l.unit_id
                      WHERE lt.tenant_id = t.id AND lt.status = 'active'
                      ORDER BY l.created_at DESC LIMIT 1) AS unit_number
               FROM users u LEFT JOIN tenants t ON t.user_id = u.id
              WHERE lower(u.email) = lower($1)`, [updated[0].to_email])
          const name = who ? [who.first_name, who.last_name].filter(Boolean).join(' ') : ''
          const label = [name || updated[0].to_email, who?.unit_number ? `Unit ${who.unit_number}` : null]
            .filter(Boolean).join(' · ')

          if (owner?.user_id) {
            await createNotification({
              userId: owner.user_id,
              landlordId: updated[0].landlord_id,
              type: 'email_undeliverable',
              title: kind === 'bounced'
                ? `Your email to ${label} isn’t arriving`
                : `${label} marked your email as spam`,
              body: kind === 'bounced'
                ? `${updated[0].to_email} rejected the message, and anything else sent there — invitations, reminders, lease signing requests — will go nowhere too. Check the spelling with them and update it on their tenant record.`
                : `${updated[0].to_email} reported GAM mail as spam, so nothing more will be delivered there. Reach them another way before sending again.`,
              actionUrl: '/tenants',
            })
          }
        } catch (e) {
          // Never fail the webhook over a notification — Svix would retry the
          // whole event and the delivery record is the part that must not be lost.
          logger.warn({ err: e, to: updated[0].to_email }, '[resend-webhook] could not notify the landlord')
        }
      }
    }
  } catch (err) {
    logger.error({ err, messageId }, '[resend-webhook] failed to record event')
    // 500 so Svix retries — losing a bounce is worse than a duplicate.
    return res.status(500).json({ error: 'Failed to record' })
  }

  res.json({ received: true })
})
