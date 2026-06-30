import { Router } from 'express'
import Stripe from 'stripe'
import { query, getClient } from '../db'
import { executeRentAllocation, type PaymentMethod } from '../services/allocation'
import {
  recordAccountUpdated, recordPayoutEvent, recordDisputeEvent,
  firePmTransfersForReference, fireManagerTransfersForReference,
} from '../services/stripeConnect'
import { createAdminNotification } from '../services/adminNotifications'
import { confirmBookingDeposit } from '../services/propertyBooking'
import { applyTenantSupersedence, type PostCommitTransfer } from '../services/supersedence'
import {
  emitPaymentSettledEvent,
  emitPaymentFailedEvent,
} from '../services/creditLedgerEmitters'
import { logger } from '../lib/logger'

export const webhooksRouter = Router()

// Stripe webhook — raw body required (set before express.json() in index.ts)
webhooksRouter.post('/stripe', async (req, res) => {
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: '2023-10-16' })
  const sig = req.headers['stripe-signature'] as string
  let event: Stripe.Event

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET!)
  } catch (err: any) {
    return res.status(400).json({ error: `Webhook signature failed: ${err.message}` })
  }

  switch (event.type) {
    case 'payment_intent.succeeded': {
      const pi = event.data.object as Stripe.PaymentIntent

      // S242: POS terminal card-present PIs live on the landlord's
      // Connect account and have no matching row in `payments`. Skip the
      // rent/utility allocation path entirely — these settle directly
      // on the landlord's Connect balance and need no GAM-side ledger
      // write. The `metadata.gam_purpose` stamp is set by
      // services/posTerminal.ts when the PI is created; absence means
      // it's a platform-rent flow and falls through to the normal path.
      if (pi.metadata?.gam_purpose === 'pos_terminal') {
        // Logged for audit; the POS transaction row was already written
        // by POST /pos/transactions (which validates the PI before
        // insert). No further work to do here.
        break
      }

      const paymentMethod = extractPaymentMethod(pi)
      // S113-Phase2.5: snapshot the underlying charge id so post-commit
      // Transfer firing can use it as `source_transaction` to pull funds
      // from the original charge instead of the platform balance.
      const stripeChargeId = (pi as any).charges?.data?.[0]?.id ?? null

      const client = await getClient()
      let settledRows: { id: string; type: string }[] = []
      const supersedenceTransfers: { paymentId: string; transfers: PostCommitTransfer[]; residual: number; tenantId: string | null }[] = []
      try {
        await client.query('BEGIN')

        // Flip status to settled. RETURNING gives us id+type+context for
        // allocation routing AND credit-ledger emission. tenant_id +
        // due_date + lease_id come back so we can emit the right
        // payment_received_* event without a second SELECT.
        const settled = await client.query<{
          id: string
          type: string
          tenant_id: string | null
          due_date: string
          lease_id: string | null
          amount: string
          settled_at: string
        }>(
          `UPDATE payments
              SET status='settled', settled_at=NOW(),
                  stripe_payment_intent_id=$1,
                  stripe_charge_id = COALESCE($2, stripe_charge_id)
            WHERE stripe_payment_intent_id=$1
              AND status != 'settled'
            RETURNING id, type, tenant_id, due_date, lease_id, amount, settled_at`,
          [pi.id, stripeChargeId]
        )
        settledRows = settled.rows.map((r) => ({ id: r.id, type: r.type }))

        // Run allocation for every settled rent OR utility payment in this
        // batch. Utility payments use the same allocation engine as rent
        // (S122) — same banking_fee math, same owner/PM split, just a
        // different entry_description on the payment row.
        for (const row of settled.rows) {
          if (row.type === 'rent' || row.type === 'utility') {
            if (!paymentMethod) {
              throw new Error(
                `payment_intent ${pi.id} succeeded but payment_method could not be ` +
                `determined from charges payload (${row.type} payment ${row.id})`
              )
            }
            await executeRentAllocation(client, row.id, paymentMethod)

            // Credit ledger: emit payment_received_* event tagged to the
            // tenant subject. Skipped if the payment row has no
            // tenant_id (rare — historically deposit-style writes can
            // be landlord-only). Same transaction as allocation; if the
            // ledger write fails, the whole settlement rolls back and
            // Stripe retries.
            if (row.tenant_id) {
              const graceRow = row.lease_id
                ? await client.query<{ late_fee_grace_days: number }>(
                    `SELECT late_fee_grace_days FROM leases WHERE id=$1`,
                    [row.lease_id]
                  )
                : { rows: [] as { late_fee_grace_days: number }[] }
              const graceDays = graceRow.rows[0]?.late_fee_grace_days ?? null

              await emitPaymentSettledEvent(client, {
                tenantId:               row.tenant_id,
                paymentId:              row.id,
                paymentType:            row.type as 'rent' | 'utility',
                amount:                 row.amount,
                dueDate:                new Date(row.due_date),
                settledAt:              new Date(row.settled_at),
                graceDays,
                stripePaymentIntentId:  pi.id,
              })

              // OTP reconciliation (S155): when a rent payment settles,
              // close out any matching advance for this tenant + cycle.
              // Outside the transaction since reconcileSettledRentPayment
              // does its own DB connection. Best-effort; if it fails,
              // the cron-driven reconciliation could pick it up later.
              if (row.type === 'rent') {
                try {
                  const { reconcileSettledRentPayment } = await import('../services/otp')
                  await reconcileSettledRentPayment(row.id)
                } catch (e) {
                  logger.error({ err: e, payment_id: row.id }, 'otp reconcile-on-settle failed')
                }
                // S245: FlexPay reconciliation runs alongside OTP. A
                // tenant can be on both products simultaneously; their
                // reconciler is a no-op when the payment isn't tagged
                // FLEXPAY, so calling both is safe and idempotent.
                try {
                  const { reconcileSettledFlexPayPayment } = await import('../services/flexpay')
                  await reconcileSettledFlexPayPayment(row.id)
                } catch (e) {
                  logger.error({ err: e, payment_id: row.id }, 'flexpay reconcile-on-settle failed')
                }
              }
              // S246: FlexDeposit reconciles installments + custody-fee.
              // S514: also handles voluntary pay-ahead settlement via PI
              // metadata (gam_purpose='flexdeposit_payahead'). Pass the PI
              // metadata so the reconciler can dispatch.
              // Idempotent and shape-checks internally — safe to call on
              // any settled payment regardless of type.
              try {
                const { reconcileSettledFlexDepositPayment } = await import('../services/flexDeposit')
                await reconcileSettledFlexDepositPayment(row.id, pi.metadata as Record<string, string>)
              } catch (e) {
                logger.error({ err: e, payment_id: row.id }, 'flexdeposit reconcile-on-settle failed')
              }
              // S515: regular (non-FlexDeposit) deposit settle → advance the
              // security_deposits row (collected_amount + status). Self-gates
              // on type='deposit' and a non-FlexDeposit deposit row.
              try {
                const { reconcileSettledDepositPayment } = await import('../services/leaseFeesSync')
                await reconcileSettledDepositPayment(row.id)
              } catch (e) {
                logger.error({ err: e, payment_id: row.id }, 'deposit reconcile-on-settle failed')
              }
              // S247: credit sublessor markup when this rent payment
              // belongs to an active sublease. No-op for non-sublease
              // payments. Idempotent via payments.sublease_credit_applied.
              if (row.type === 'rent') {
                try {
                  const { creditSublessorMarkupForPayment } = await import('../services/subleaseAllocation')
                  await creditSublessorMarkupForPayment(row.id)
                } catch (e) {
                  logger.error({ err: e, payment_id: row.id }, 'sublease credit-on-settle failed')
                }
              }
              // S253: FlexCharge statement reconcile + merchant Transfer.
              // Self-gates on entry_description='SUBSCRIP' AND a matching
              // flex_charge_statements.payment_id row. No-op otherwise.
              try {
                const { reconcileSettledFlexChargeStatement } = await import('../services/flexCharge')
                await reconcileSettledFlexChargeStatement(row.id)
              } catch (e) {
                logger.error({ err: e, payment_id: row.id }, 'flexcharge reconcile-on-settle failed')
              }
            }
          }

          // S122: flip the linked utility_bill to 'paid' so the tenant's
          // utility tab no longer shows it as outstanding.
          if (row.type === 'utility') {
            await client.query(
              `UPDATE utility_bills
                  SET status='paid', paid_at=NOW(), updated_at=NOW()
                WHERE payment_id=$1`,
              [row.id]
            )
          }

          // S261: GAM-supersedence — distribute the boost portion of
          // this payment FIFO across the tenant's outstanding GAM
          // balances (FlexDeposit installments / FlexCharge / FlexPay /
          // custody). Idempotent + self-gates on
          // tenant_id + non-zero gam_supersedence_amount. FlexCharge
          // merchant Transfers are deferred to post-commit so we
          // don't hold the tx open across Stripe API calls.
          const result = await applyTenantSupersedence(client, row.id)
          if (result.applied) {
            supersedenceTransfers.push({
              paymentId: row.id,
              transfers: result.post_commit_transfers,
              residual:  result.amount_residual,
              tenantId:  row.tenant_id ?? null,
            })
          }
        }

        await client.query('COMMIT')
      } catch (e) {
        await client.query('ROLLBACK')
        logger.error({ err: e, stripe_payment_intent_id: pi.id }, 'webhook payment_intent.succeeded handler failed')
        // S132: critical — allocation engine broke on a settled payment.
        // Stripe will retry the webhook (we 500 below), but admin needs
        // visibility regardless because the payment did settle and the
        // allocation didn't.
        await createAdminNotification({
          severity: 'critical',
          category: 'webhook_payment_settled_handler_failed',
          title:    `Allocation engine failed on settled PaymentIntent ${pi.id}`,
          body:     e instanceof Error ? e.message : String(e),
          context:  { stripe_payment_intent_id: pi.id },
        })
        // Return 500 so Stripe retries with backoff.
        return res.status(500).json({ error: 'webhook handler failed' })
      } finally {
        client.release()
      }

      // S119 post-commit: fire Stripe Transfers for any PM company cuts
      // that landed on the ledger as ghosts. Done AFTER the tx commits so
      // we don't hold locks across Stripe API calls. Errors are logged
      // but don't propagate — failed rows stay without transfer_id and
      // can be retried by a reconciliation job.
      for (const row of settledRows) {
        if (row.type === 'rent' || row.type === 'utility') {
          try {
            await firePmTransfersForReference('payment', row.id)
          } catch (e) {
            logger.error({ err: e, payment_id: row.id, payment_type: row.type }, 'pm_transfer post-commit firing failed')
            // S132: warn — PM cut didn't fire; ledger has ghost rows
            // pending a retry. Reconciliation job will pick it up but
            // admin should see the failure.
            await createAdminNotification({
              severity: 'warn',
              category: 'pm_transfer_post_commit_failed',
              title:    `PM transfer firing failed for ${row.type} payment ${row.id}`,
              body:     e instanceof Error ? e.message : String(e),
              context:  { payment_id: row.id, payment_type: row.type },
            })
          }
          // S113-Phase1: parallel manager-fee Transfer fire. Only fires
          // when allocation.ts wrote an allocation_manager_fee row for
          // this payment (manager ≠ owner AND no PM company contracted).
          // Quiet no-op otherwise.
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
            })
          }
        }
      }

      // S261 post-commit: fire FlexCharge merchant Transfers for any
      // statements satisfied via supersedence. The merchant share
      // (statement.balance, not total_due — the 1.5% service_fee stays
      // on platform as GAM revenue) lands on the landlord's Connect
      // account. Funded from GAM platform balance (where the
      // supersedence boost landed). Residual amounts (boost > FIFO
      // total) get an admin notification.
      for (const entry of supersedenceTransfers) {
        for (const t of entry.transfers) {
          if (t.source !== 'flexcharge_statement') continue
          if (!t.destination_connect_account) {
            await createAdminNotification({
              severity: 'warn',
              category: 'flexcharge_merchant_transfer_pending',
              title:    `FlexCharge merchant Transfer waiting (supersedence) — statement ${t.ref_id}`,
              body:     `Statement ${t.ref_id} satisfied via supersedence from payment ${entry.paymentId}; merchant share $${t.amount.toFixed(2)} is on platform balance pending landlord Connect onboarding.`,
              context:  { statement_id: t.ref_id, paid_via_payment_id: entry.paymentId, amount: t.amount },
            })
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
                  gam_purpose:           'flexcharge_merchant_payout',
                  gam_statement_id:      t.ref_id,
                  gam_via_supersedence:  'true',
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
            })
          }
        }
        if (entry.residual > 0.005) {
          await createAdminNotification({
            severity: 'warn',
            category: 'supersedence_residual_unallocated',
            title:    `Supersedence residual unallocated — payment ${entry.paymentId}`,
            body:     `Payment ${entry.paymentId} carried $${entry.residual.toFixed(2)} of supersedence boost that exceeded the tenant's live GAM-debt total at settle. Funds remain on platform balance.`,
            context:  { payment_id: entry.paymentId, residual: entry.residual, tenant_id: entry.tenantId },
          })
        }
      }

      // S174 / S183: rent-collected notification routed to the per-property
      // responsible party (PM company staff fan-out, individually-delegated
      // user, or owner if self-managed). Pre-S183 this notified the landlord
      // owner regardless of whether the property was delegated, which spammed
      // owners about properties they'd handed off to a PM. Failures don't
      // propagate; credit ledger event inside the tx is the durable record.
      // Skip utility rows — utilities are smaller / more frequent.
      for (const row of settledRows) {
        if (row.type !== 'rent') continue
        try {
          const ctx = await query<{
            amount:         string
            landlord_id_pk: string
            property_id:    string
            tenant_name:    string
            unit_number:    string
            property_name:  string
          }>(
            `SELECT p.amount,
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
              WHERE p.id = $1`,
            [row.id],
          )
          const c = ctx[0]
          if (!c) continue
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
              amount:         parseFloat(c.amount),
            })
          }
        } catch (e) {
          // Notification failure shouldn't fail the webhook (Stripe would
          // retry the whole thing and re-allocate). Log and continue.
          logger.error({ err: e, payment_id: row.id }, 'rent-collected-notify failed')
        }
      }

      // Reserve fund replenishment block (S68): removed.
      //
      // The original block was the flip side of payments.ts:121's
      // initiate-disbursements pre-16a flow: GAM fronted rent from reserve
      // before tenant ACH cleared, then this hook replenished reserve when
      // the tenant payment landed. Under 16a, GAM is the merchant of record
      // and money is held in-platform until withdrawal — there is no
      // forward-funding, so there is nothing to replenish.
      //
      // The block also passed [0] for the amount and was a no-op for over
      // a year. Reserve fund logic for chargeback / ACH-reversal coverage
      // under 16a is a separate concern flagged for its own session.
      break
    }
    case 'payment_intent.payment_failed': {
      // S124: NACHA-compliant retry decision. Read the return code from
      // Stripe's last_payment_error chain; if retryable AND retry_count < 2,
      // schedule next_retry_at = NOW() + 3 days (NACHA recommends ≥1
      // business day; 3 calendar days is a conservative weekend-safe proxy).
      // Otherwise: permanent failure, status='failed', next_retry_at=NULL.
      // S125: notification fires post-update — retry-scheduled or
      // retries-exhausted depending on outcome.
      const pi = event.data.object as Stripe.PaymentIntent

      // S242: POS terminal failures (card declined at reader) are handled
      // by the operator at the POS — retry the swipe, try a different
      // card, or abandon the sale. No ledger row, no NACHA retry logic,
      // no notification. Skip.
      if (pi.metadata?.gam_purpose === 'pos_terminal') break

      const { extractReturnCode, decideRetry } = await import('../services/achRetry')
      const { ACH_RETURN_CONFIG } = await import('@gam/shared')
      const returnCode = extractReturnCode(pi)
      const decision = decideRetry(returnCode)
      const reasonText = (returnCode && ACH_RETURN_CONFIG[returnCode]?.description)
        || 'Payment processor reported the charge failed'

      // FlexDeposit installment + voluntary pay-ahead pulls bypass the
      // generic achRetry pipeline. Installment retries fire on the
      // pre-scheduled retry_pull_date (set at enrollment); a failed
      // pay-ahead is benign (no terminal state — the tenant can retry it).
      // Force next_retry_at=NULL so achRetry never picks these up.
      const isFlexDepositPull = (
        pi.metadata?.gam_purpose === 'flexdeposit_installment' ||
        pi.metadata?.gam_purpose === 'flexdeposit_payahead'
      )

      let willRetry = false
      let updatedRow: { id: string; retry_count: number } | null = null

      if (decision === 'retry' && !isFlexDepositPull) {
        const r = await query<{ id: string; retry_count: number }>(
          `UPDATE payments
              SET status='failed',
                  return_code=$1,
                  next_retry_at = NOW() + INTERVAL '3 days',
                  stripe_payment_intent_id=$2
            WHERE stripe_payment_intent_id=$2 AND retry_count < 2
            RETURNING id, retry_count`,
          [returnCode, pi.id]
        )
        if (r.length > 0) {
          updatedRow = r[0]
          willRetry = true
        }
      }

      // If retry path didn't claim (cap reached or non-retryable), fall
      // through to permanent.
      if (!updatedRow) {
        const r = await query<{ id: string; retry_count: number }>(
          `UPDATE payments
              SET status='failed',
                  return_code=$1,
                  next_retry_at=NULL,
                  stripe_payment_intent_id=$2
            WHERE stripe_payment_intent_id=$2
            RETURNING id, retry_count`,
          [returnCode, pi.id]
        )
        updatedRow = r.length > 0 ? r[0] : null
      }

      // Credit ledger: emit payment_failed_nsf when the failure is
      // terminal (retries exhausted, no next_retry_at). A still-retrying
      // payment is alive — the tenant's record only takes a hit when
      // it actually flunks for good.
      if (updatedRow && !willRetry) {
        try {
          const pinfo = await query<{
            id: string
            tenant_id: string | null
            type: string
            amount: string
            due_date: string
          }>(
            `SELECT id, tenant_id, type, amount, due_date FROM payments WHERE id=$1`,
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
                dueDate:                new Date(p.due_date),
                failedAt:               new Date(),
                stripePaymentIntentId:  pi.id,
                failureCode:            returnCode ?? null,
                failureMessage:         reasonText,
              })
            } finally {
              ledgerClient.release()
            }

            // OTP NSF default (S155): if this terminal failure is on a
            // rent payment with an outstanding advance, mark it
            // defaulted + disqualify the tenant for 6 months. GAM eats
            // the loss per the regulatory boundary.
            if (p.type === 'rent') {
              try {
                const { handleRentPaymentNsf } = await import('../services/otp')
                await handleRentPaymentNsf(p.id)
              } catch (e) {
                logger.error({ err: e, payment_id: p.id }, 'otp nsf-handler failed')
              }
              // S245: FlexPay NSF — second failure (retry exhausted)
              // marks the advance defaulted + suspends tenant 60 days.
              // First-failure events are handled by the standard ACH
              // retry pipeline; the FlexPay handler checks retry_count
              // and no-ops on first failure.
              try {
                const { handleFlexPayPaymentNsf } = await import('../services/flexpay')
                await handleFlexPayPaymentNsf(p.id)
              } catch (e) {
                logger.error({ err: e, payment_id: p.id }, 'flexpay nsf-handler failed')
              }
              // S246 / S514: FlexDeposit NSF dispatcher (custody model).
              // Installment pulls: handleFlexDepositPaymentNsf reads
              // attempt_count to decide between primary-failed-await-retry
              // and retry-failed → mark installment 'missed' (no
              // acceleration, no plan default — ToS § 9.1.5).
              // Voluntary pay-ahead pulls (gam_purpose='flexdeposit_payahead')
              // have no installment row, so the handler no-ops on them; a
              // failed pay-ahead is benign — the plan stays 'active' and the
              // scheduled installment pulls continue.
              try {
                const { handleFlexDepositPaymentNsf } = await import('../services/flexDeposit')
                await handleFlexDepositPaymentNsf(p.id)
              } catch (e) {
                logger.error({ err: e, payment_id: p.id }, 'flexdeposit nsf-handler failed')
              }
            }
          }

          // S253: FlexCharge statement NSF runs OUTSIDE the
          // (rent|utility)+tenant_id gate above. FlexCharge statement
          // payments have type='fee' and may have NULL tenant_id
          // (pos_customer accounts). Handler self-gates on
          // entry_description='SUBSCRIP' + a matching statement row —
          // safe to call on any failed payment; no-ops when not
          // FlexCharge.
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

      // S125 / S186: fire the appropriate notification post-update.
      // ACH retry / exhausted are operational rent-collection events;
      // routed through the responsible-party resolver so the manager
      // (not owner) handles delegated properties.
      if (updatedRow) {
        try {
          // Pull payment context for the notify helper
          const ctx = await query<{
            id:              string
            amount:          string
            tenant_user_id:  string
            tenant_email:    string
            tenant_phone:    string | null
            tenant_name:     string
            landlord_id_pk:  string
            property_id:     string
            unit_number:     string
            property_name:   string
          }>(`
            SELECT p.id, p.amount,
                   t.user_id AS tenant_user_id,
                   tu.email  AS tenant_email,
                   tu.phone  AS tenant_phone,
                   tu.first_name || ' ' || tu.last_name AS tenant_name,
                   l.id  AS landlord_id_pk,
                   pr.id AS property_id,
                   un.unit_number,
                   pr.name AS property_name
              FROM payments p
              JOIN tenants    t  ON t.id = p.tenant_id
              JOIN users      tu ON tu.id = t.user_id
              JOIN landlords  l  ON l.id = p.landlord_id
              JOIN units      un ON un.id = p.unit_id
              JOIN properties pr ON pr.id = un.property_id
             WHERE p.id = $1
          `, [updatedRow.id])
          const pctx = ctx[0]
          if (pctx) {
            const { getPropertyResponsibleParty } = await import('../services/responsibleParty')
            const targets = await getPropertyResponsibleParty(pctx.property_id)
            const recipients = targets?.primaries ?? []
            const { notifyAchRetryScheduled, notifyAchRetriesExhausted } =
              await import('../services/notifications')
            if (willRetry) {
              const retryDate = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000)
                .toISOString().slice(0, 10)
              for (const recipient of recipients) {
                await notifyAchRetryScheduled({
                  tenantUserId:    pctx.tenant_user_id,
                  tenantEmail:     pctx.tenant_email,
                  tenantPhone:     pctx.tenant_phone ?? undefined,
                  tenantName:      pctx.tenant_name,
                  landlordUserId:  recipient.user_id,
                  landlordId:      pctx.landlord_id_pk,
                  landlordEmail:   recipient.email,
                  unitNumber:      pctx.unit_number,
                  propertyName:    pctx.property_name,
                  amount:          parseFloat(pctx.amount),
                  reason:          reasonText,
                  retryDate,
                  retryAttempt:    (updatedRow.retry_count + 1) as 1 | 2,
                })
              }
            } else {
              for (const recipient of recipients) {
                await notifyAchRetriesExhausted({
                  paymentId:       pctx.id,
                  tenantUserId:    pctx.tenant_user_id,
                  tenantEmail:     pctx.tenant_email,
                  tenantPhone:     pctx.tenant_phone ?? undefined,
                  tenantName:      pctx.tenant_name,
                  landlordUserId:  recipient.user_id,
                  landlordId:      pctx.landlord_id_pk,
                  landlordEmail:   recipient.email,
                  landlordPhone:   recipient.phone ?? undefined,
                  unitNumber:      pctx.unit_number,
                  propertyName:    pctx.property_name,
                  amount:          parseFloat(pctx.amount),
                  reason:          reasonText,
                })
              }
            }
          }
        } catch (e) {
          // Notification failure shouldn't fail the webhook (Stripe would
          // retry the whole thing). Log and continue.
          logger.error({ err: e, payment_id: updatedRow.id }, 'ach-retry-notify failed')
        }
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
        return res.status(500).json({ error: 'webhook handler failed' })
      }
      break
    }
    case 'charge.dispute.created':
    case 'charge.dispute.updated':
    case 'charge.dispute.closed': {
      // S117: disputes hit GAM's platform balance (loss responsibility =
      // application). Record locally for the GAM-native dashboard.
      const dispute = event.data.object as Stripe.Dispute
      try {
        await recordDisputeEvent(dispute)
      } catch (e) {
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
        })
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
        return res.status(500).json({ error: 'webhook handler failed' })
      }
      break
    }

    // S494: business-invoice customer-pay completion. Stripe Checkout
    // Sessions fire this when the customer finishes the hosted-pay
    // flow. We match on the session id we stored at send time, mark
    // the invoice paid, and stamp the PaymentIntent id for audit.
    case 'checkout.session.completed': {
      const session = event.data.object as Stripe.Checkout.Session
      // S517: public property-booking deposit → confirm the held booking.
      if (session.metadata?.gam_purpose === 'booking_deposit') {
        const bookingId = session.metadata?.gam_booking_id ?? null
        if (bookingId) {
          try {
            await confirmBookingDeposit(bookingId, session.id)
            logger.info({ booking_id: bookingId, session_id: session.id }, '[webhook] booking deposit confirmed')
          } catch (e) {
            logger.error({ err: e, booking_id: bookingId }, '[webhook] booking deposit confirm failed')
          }
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
        const ins = await query<{ id: string }>(
          `INSERT INTO business_invoice_payments
             (business_id, invoice_id, amount, kind, method,
              stripe_checkout_session_id, stripe_payment_intent_id)
           SELECT bi.business_id, bi.id, $2, $3, 'card', $4, $5
             FROM business_invoices bi
            WHERE bi.id = $1
           ON CONFLICT (stripe_checkout_session_id)
             WHERE stripe_checkout_session_id IS NOT NULL DO NOTHING
           RETURNING id`,
          [invoiceId, amountPaid, paymentKind, session.id, piId],
        )
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
                  payment_method  = 'card',
                  stripe_payment_intent_id = COALESCE(bi.stripe_payment_intent_id, $2),
                  updated_at      = NOW()
             FROM (SELECT COALESCE(SUM(amount), 0) AS paid
                     FROM business_invoice_payments WHERE invoice_id = $1) sub
            WHERE bi.id = $1
            RETURNING bi.id, bi.customer_id`,
          [invoiceId, piId],
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
        return res.status(500).json({ error: 'webhook handler failed' })
      }
      break
    }
  }

  res.json({ received: true })
})

/**
 * Map Stripe charge payment_method_details.type to GAM's collapsed bucket.
 * - 'us_bank_account' (ACH debit) → 'ach'
 * - 'card' (credit + debit, collapsed S64) → 'card'
 * - Anything else (link, cashapp, etc.) → null; allocation will throw.
 */
function extractPaymentMethod(pi: Stripe.PaymentIntent): PaymentMethod | null {
  // Stripe SDK 2023-10-16 dropped `charges` from the default PaymentIntent type
  // (use `expand: ['charges']` to retrieve it). The webhook event payload still
  // ships it at runtime, so cast through. Schema-wise we read the same field.
  const charge = (pi as any).charges?.data?.[0]
  const type = charge?.payment_method_details?.type
  if (type === 'us_bank_account') return 'ach'
  if (type === 'card') return 'card'
  return null
}
