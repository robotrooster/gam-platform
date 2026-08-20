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
import { confirmBookingDeposit } from '../services/propertyBooking'
import { applyTenantSupersedence, type PostCommitTransfer } from '../services/supersedence'
import { activateBillingForSettledRent } from '../services/billingActivation'
import {
  emitPaymentSettledEvent,
  emitPaymentFailedEvent,
} from '../services/creditLedgerEmitters'
import { logger } from '../lib/logger'
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

      const charge = await resolveCharge(stripe, pi)
      const paymentMethod = extractPaymentMethod(charge)
      // S113-Phase2.5: snapshot the underlying charge id so post-commit
      // Transfer firing can use it as `source_transaction` to pull funds
      // from the original charge instead of the platform balance.
      const stripeChargeId = charge?.id ?? null

      const client = await getClient()
      let settledRows: { id: string; type: string }[] = []
      const supersedenceTransfers: { paymentId: string; transfers: PostCommitTransfer[]; residual: number; tenantId: string | null }[] = []
      const propaneRedistributions: { tenantId: string; applied: number; rentRemainder: number; paymentAmount: number; propanePaymentIds: string[] }[] = []
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
          reversal_id: string | null
          // S609: needed to decide whether this row carries an owner share.
          revenue_owner: string
          unit_id: string | null
        }>(
          `UPDATE payments
              SET status='settled', settled_at=NOW(),
                  stripe_payment_intent_id=$1,
                  stripe_charge_id = COALESCE($2, stripe_charge_id)
            WHERE stripe_payment_intent_id=$1
              AND status != 'settled'
            RETURNING id, type, tenant_id, due_date, lease_id, amount, settled_at, reversal_id,
                      revenue_owner, unit_id`,
          [pi.id, stripeChargeId]
        )
        // S561: reopened-after-reversal rows are handled in the loop below and
        // must NOT drive the post-commit PM-transfer / rent-collected paths (a
        // re-payment, not a fresh collection) — exclude them from settledRows.
        settledRows = settled.rows.filter((r) => !r.reversal_id).map((r) => ({ id: r.id, type: r.type }))

        // S600 no-double-bill grace: first settled RENT = the landlord GOES LIVE.
        // Ends their onboarding grace so the platform fee begins from this cycle.
        await activateBillingForSettledRent(
          client,
          settled.rows.filter((r) => !r.reversal_id && r.type === 'rent').map((r) => r.id)
        )

        // Run allocation for every settled row that carries an owner share.
        // Utility payments use the same engine as rent (S122).
        //
        // S609 (Nic): LATE FEES AND LANDLORD-BILLED FEES NOW TOO. "Late fees
        // that come from the lease and are on the invoice need to go to the
        // landlord... those also need to go to the landlord. I don't know why
        // that would go to GAM." Until now they got no allocation at all, so
        // the tenant paid them and the money stopped on GAM's books.
        //
        // A row only allocates if it is the LANDLORD'S money — a 'fee' row can
        // be either side's (GAM's ACH-return, decline, manual-payment and
        // opt-in-product fees are stamped revenue_owner='gam' at creation), and
        // it needs a unit to resolve a property (FlexCharge rows carry none).
        for (const row of settled.rows) {
          const allocatable =
            (ALLOCATABLE_PAYMENT_TYPES as readonly string[]).includes(row.type) &&
            row.revenue_owner === 'landlord' &&
            !!row.unit_id
          if (allocatable) {
            if (!paymentMethod) {
              throw new Error(
                `payment_intent ${pi.id} succeeded but payment_method could not be ` +
                `determined from charges payload (${row.type} payment ${row.id})`
              )
            }

            // S561: a reopened-after-reversal rent settling = the tenant made
            // GAM whole. Resolve the reversal + route the money — landlord
            // already clawed back → re-disburse to them (normal allocation);
            // otherwise GAM keeps the re-payment (reimburses its reversal loss)
            // and no owner allocation runs. Skip the credit event (a
            // re-payment, not a fresh signal). PM/manager-cut reversal = Phase 4
            // (Oak Park is self-managed).
            if (row.reversal_id) {
              const { resolveReversalOnTenantPayment } = await import('../services/paymentReversal')
              const reDisburse = await resolveReversalOnTenantPayment(client, row.reversal_id)
              if (reDisburse) await executeRentAllocation(client, row.id, paymentMethod)
              continue
            }

            // S609: rent and utilities stay STRICT — allocation failing on them
            // rolls the settle back so Stripe retries, which is the long-
            // standing "settle + ledger move together" posture and must not
            // change. The kinds ADDED in S609 (late fees, landlord-billed fees)
            // are lenient instead:
            //
            //   A LATE FEE MUST NEVER ROLL BACK A TENANT'S PAYMENT. It rides on
            //   the same charge as the rent, so a property missing its payout
            //   configuration would have taken the whole settlement down with
            //   it — the tenant's rent included. That is the same shape of
            //   defect Nic called out on invoice generation ("if it ever
            //   becomes broken it still sends the rent bill and doesn't gate
            //   the invoice"), and the same answer applies: the primary money
            //   movement completes, the secondary concern raises an alert.
            //
            // The money is not lost — the row is settled and platform_held, so
            // re-running allocation once the configuration is fixed books the
            // landlord's share.
            const strict = row.type === 'rent' || row.type === 'utility'
            if (strict) {
              await executeRentAllocation(client, row.id, paymentMethod)
            } else {
              await client.query('SAVEPOINT fee_alloc')
              try {
                await executeRentAllocation(client, row.id, paymentMethod)
                await client.query('RELEASE SAVEPOINT fee_alloc')
              } catch (allocErr) {
                await client.query('ROLLBACK TO SAVEPOINT fee_alloc')
                logger.error({ err: allocErr, payment_id: row.id, type: row.type },
                  '[settle] fee allocated to nobody — payment still settled')
                await createAdminNotification({
                  severity: 'warn',
                  category: 'fee_allocation_failed',
                  title: `A ${row.type} could not be credited to the landlord (payment ${row.id})`,
                  body: `The tenant's payment settled normally, but this charge could not be split out to the landlord — usually a property missing its payout configuration. The money is held on the platform; fix the configuration and re-run allocation for this payment.`,
                  context: { payment_id: row.id, type: row.type, stripe_payment_intent_id: pi.id },
                }).catch(() => {})
              }
            }

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
              // (OTP is hidden/gated behind otp_rollout_visible — this
              // no-ops while the feature is off; kept intact for re-enable.)
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
              // S583: FlexCharge pay-DOWN reconcile (customer paid more than the
              // minimum). Self-gates on the PI metadata gam_purpose.
              try {
                const meta = (pi.metadata ?? {}) as Record<string, string>
                if (meta.gam_purpose === 'flexcharge_paydown') {
                  const { reconcileFlexChargePaydown } = await import('../services/flexCharge')
                  await reconcileFlexChargePaydown(row.id, meta)
                }
              } catch (e) {
                logger.error({ err: e, payment_id: row.id }, 'flexcharge paydown reconcile failed')
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

          // S533: accelerated-propane priority — redirect this rent
          // payment's funds to unpaid accelerated propane rows first
          // (whole rows, oldest first) and split the rent row into a
          // settled portion + pending remainder. LEDGER-ONLY: the funds
          // sit on the platform rails (Connect balance) and reach the
          // landlord solely via the Friday batch payout — this changes
          // which obligations the money satisfies, never where it goes.
          // Sits BEHIND supersedence (GAM-first) by running after it.
          if (row.type === 'rent') {
            try {
              const { applyAcceleratedPropane } = await import('../services/propaneRedistribution')
              const redis = await applyAcceleratedPropane(client, row as any)
              if (redis) propaneRedistributions.push({ tenantId: row.tenant_id!, ...redis, paymentAmount: Number(row.amount) })
            } catch (e) {
              logger.error({ err: e, payment_id: row.id }, 'propane redistribution failed')
              throw e // same posture as allocation: settle + ledger move together
            }
          }
        }

        // S537: FIFO remittance settle — the covered rows were settled by
        // the standard by-PI path above; here we close the remittance and
        // bank any pay-ahead remainder as a prepaid credit for the next
        // invoice generation to consume.
        if (pi.metadata?.gam_remittance_id) {
          const remRes = await client.query<{ id: string; tenant_id: string; lease_id: string | null; unapplied_amount: string }>(
            `UPDATE tenant_remittances
                SET status='settled', settled_at=NOW(), updated_at=NOW()
              WHERE id = $1 AND status != 'settled'
              RETURNING id, tenant_id, lease_id, unapplied_amount`,
            [pi.metadata.gam_remittance_id])
          const remRow = remRes.rows[0]
          if (remRow && Number(remRow.unapplied_amount) > 0 && remRow.lease_id) {
            await client.query(
              `INSERT INTO lease_prepaid_credits (lease_id, tenant_id, amount_original, amount_remaining, source_remittance_id)
               VALUES ($1, $2, $3, $3, $4)`,
              [remRow.lease_id, remRow.tenant_id, remRow.unapplied_amount, remRow.id])
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
        await stampWebhookError(rawEventId, e)
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
      // statements satisfied via supersedence. The merchant share is
      // (balance − GAM's 1.5% service_fee) — GAM keeps the 1.5% as its
      // merchant subscription (S583, Nic: the fee is the merchant's cost,
      // never the borrower's). Lands on the landlord's Connect account,
      // funded from GAM platform balance (where the supersedence boost
      // landed). Residual amounts (boost > FIFO total) get an admin notification.
      // S533 post-commit: tell the tenant exactly how their payment was
      // applied when accelerated propane took priority over rent.
      for (const r of propaneRedistributions) {
        try {
          const tenantUser = await query<{ user_id: string; email: string; landlord_id: string }>(
            `SELECT t.user_id, u.email, p.landlord_id
               FROM tenants t
               JOIN users u ON u.id = t.user_id
               JOIN payments p ON p.tenant_id = t.id
              WHERE t.id = $1 LIMIT 1`, [r.tenantId])
          if (tenantUser.length) {
            const { createNotification } = await import('../services/notifications')
            await createNotification({
              userId: tenantUser[0].user_id,
              landlordId: tenantUser[0].landlord_id,
              type: 'propane_priority_applied',
              title: 'How your payment was applied',
              body: `Of your $${r.paymentAmount.toFixed(2)} payment, $${r.applied.toFixed(2)} was applied to your outstanding propane balance first; $${(r.paymentAmount - r.applied).toFixed(2)} went to rent. Remaining rent due: $${r.rentRemainder.toFixed(2)}.`,
              actionUrl: '/payments',
              sendEmail: true, emailTo: tenantUser[0].email,
              emailSubject: 'How your payment was applied',
              emailHtml: `Of your $${r.paymentAmount.toFixed(2)} payment, <b>$${r.applied.toFixed(2)}</b> was applied to your outstanding propane balance first; $${(r.paymentAmount - r.applied).toFixed(2)} went to rent. Remaining rent due: <b>$${r.rentRemainder.toFixed(2)}</b>.`,
            })
          }
        } catch (e) {
          logger.error({ err: e, tenant_id: r.tenantId }, 'propane redistribution notification failed')
        }
      }

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

      // S537: a failed FIFO remittance is closed out; its covered rows
      // revert / retry through the standard by-PI NACHA logic below, and
      // no prepaid credit is ever created for a failed pull.
      if (pi.metadata?.gam_remittance_id) {
        await query(
          `UPDATE tenant_remittances SET status='failed', updated_at=NOW()
            WHERE id = $1 AND status = 'processing'`,
          [pi.metadata.gam_remittance_id])
      }

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

      // S603: declined-CARD-attempt fee ($1.00, entry_description
      // 'DECLINEFEE'). Stripe bills per AUTHORIZATION, so EVERY refused attempt
      // costs GAM $0.28 ($0.26 per-auth + $0.02 Radar) with no revenue — hence
      // this fires on every decline, not just the terminal one. The surplus over
      // that $0.28 funds card-save / re-save authorizations, which is what keeps
      // card-on-file (and autopay) viable. ACH is excluded: it carries its own
      // $4.00 RETURNFEE. POS terminal declines already returned above.
      //
      // Idempotent by PaymentIntent: the raw-event insert uses ON CONFLICT DO
      // NOTHING but does NOT stop reprocessing, so a Stripe redelivery would
      // otherwise double-bill. The deterministic notes string keyed to pi.id is
      // the dedupe key.
      const pmType = (pi.last_payment_error as any)?.payment_method?.type
      const isCardAttempt = pmType
        ? pmType === 'card'
        : (pi.payment_method_types || []).includes('card')
            && !(pi.payment_method_types || []).includes('us_bank_account')
      if (updatedRow && isCardAttempt) {
        try {
          const { CARD_DECLINE_FEE } = await import('@gam/shared')
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
          logger.error({ err: e, payment_id: updatedRow.id, pi: pi.id },
            'decline-fee insert failed')
        }
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
            // the loss per the regulatory boundary. (Gated/no-op while
            // OTP is hidden; kept intact for re-enable.)
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
        await stampWebhookError(rawEventId, e)
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

        // S561 (platform-holds Phase 3): on a NEWLY created dispute, if the
        // disputed payment already SETTLED (it was batched to the landlord),
        // run the post-settlement reversal flow — reopen the tenant + record
        // the landlord receivable. Card chargebacks arrive here; the exact
        // late-ACH-return event is confirmed + wired at C3 (live keys). The
        // handler is idempotent (unique stripe_event_id + not-settled guard).
        if (event.type === 'charge.dispute.created') {
          const piId = typeof dispute.payment_intent === 'string'
            ? dispute.payment_intent
            : dispute.payment_intent?.id ?? null
          const settledPay = piId ? await queryOne<{ id: string }>(
            `SELECT id FROM payments
              WHERE stripe_payment_intent_id = $1 AND status = 'settled'
                AND type IN ('rent', 'utility') LIMIT 1`, [piId]
          ) : null
          if (settledPay) {
            const disputeRow = await queryOne<{ id: string }>(
              `SELECT id FROM connect_disputes WHERE stripe_dispute_id = $1`, [dispute.id]
            )
            // Pass-through fee = the actual Stripe dispute fee (balance-txn
            // fee), fallback to the standard $15 card-dispute fee.
            const feeCents = (dispute.balance_transactions ?? [])
              .reduce((s, bt) => s + Math.abs(bt.fee ?? 0), 0)
            const { handlePaymentReversal } = await import('../services/paymentReversal')
            await handlePaymentReversal({
              paymentId:        settledPay.id,
              reversalType:     'card_dispute',
              reversedAmount:   (dispute.amount ?? 0) / 100,
              reversalFee:      feeCents > 0 ? feeCents / 100 : 15,
              stripeEventId:    event.id,
              stripeObjectId:   dispute.id,
              connectDisputeId: disputeRow?.id ?? null,
              rawEvent:         event,
            })
          }
        }
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

        if (isCard) {
          // S571 guard: a CARD setup must NOT flip ach_verified / stamp bank
          // fields (pre-S571 this branch assumed us_bank_account and would mark
          // ach_verified=TRUE with a null last4 for a saved card). Nothing else
          // to do for a card here — email 2FA is already on for every tenant.
          logger.info({ tenant_id: tenantId, customer: customerId, setup_intent: setupIntent.id }, '[webhook] tenant card saved (no ACH flip)')
          break
        }

        const bank = pm?.us_bank_account
        const bankLast4 = bank?.last4 ?? null
        const routing = bank?.routing_number ?? null
        const routingLast4 = bank?.routing_number?.slice(-4) ?? null
        // Flip only on the FALSE→TRUE transition (idempotent on re-delivery).
        const flipped = await queryOne<{ id: string }>(
          `UPDATE tenants SET ach_verified = TRUE, bank_last4 = $2, bank_routing_last4 = $3
            WHERE ${tenantId ? 'id = $1' : 'stripe_customer_id = $1'}
              AND ach_verified = FALSE
            RETURNING id`,
          [tenantId ?? customerId, bankLast4, routingLast4],
        )
        if (flipped?.id) {
          await query(`
            INSERT INTO ach_monitoring_log (event_type, tenant_id, bank_fingerprint, notes)
            VALUES ('first_sender', $1, $2, 'Microdeposits confirmed — bank verified, first-time sender tracking initiated')`,
            [flipped.id, `${routing}_${bankLast4}`],
          )

          // S607 (Nic): PROMOTE the verified bank to the customer's default.
          //
          // routes/stripe.ts already refuses to let a saved card take the
          // default away from a bank ("don't steal from ACH"). Only half of that
          // preference was implemented: nothing promoted the bank once it
          // verified. The sequence every tenant hits — rent is due, add a card
          // to pay now, bank verifies 1–3 days later — therefore left the CARD
          // as default permanently, and the tenant kept paying card rates on a
          // bank they waited three days to verify.
          //
          // Done here rather than in the verify endpoint because this is already
          // the single source of truth for "the bank is verified", so a
          // Stripe-side confirmation promotes it too. A PM can only be made
          // default once ATTACHED, which is exactly what succeeded means.
          //
          // Deliberately only on the FALSE→TRUE transition (we are inside it):
          // a tenant who later chooses a card as default keeps that choice, and
          // a re-delivered webhook will not silently undo it.
          if (pmId && customerId) {
            try {
              await getStripe().customers.update(customerId, {
                invoice_settings: { default_payment_method: pmId },
              })
              logger.info({ tenant_id: flipped.id, pm: pmId }, '[webhook] verified bank promoted to default payment method')
            } catch (e) {
              // Never fail the verification over the default. The bank IS
              // verified; the tenant can still pick it at pay time, and the
              // PATCH /tenant/default-payment-method route remains available.
              logger.error({ err: e, tenant_id: flipped.id, pm: pmId },
                '[webhook] could not promote verified bank to default')
            }
          }
          logger.info({ tenant_id: flipped.id, setup_intent: setupIntent.id }, '[webhook] ACH microdeposits verified')
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
async function stampWebhookError(stripeEventId: string, err: unknown): Promise<void> {
  const msg = err instanceof Error ? err.message : String(err)
  try {
    await query(
      `UPDATE stripe_webhook_events SET processing_error = $2 WHERE stripe_event_id = $1`,
      [stripeEventId, msg]
    )
  } catch { /* best-effort */ }
}

/**
 * Map Stripe charge payment_method_details.type to GAM's collapsed bucket.
 * - 'us_bank_account' (ACH debit) → 'ach'
 * - 'card' (credit + debit, collapsed S64) → 'card'
 * - Anything else (link, cashapp, etc.) → null; allocation will throw.
 */
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
  if (type === 'card') return 'card'
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
    }
  } catch (err) {
    logger.error({ err, messageId }, '[resend-webhook] failed to record event')
    // 500 so Svix retries — losing a bounce is worse than a duplicate.
    return res.status(500).json({ error: 'Failed to record' })
  }

  res.json({ received: true })
})
