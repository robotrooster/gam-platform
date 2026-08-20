// apps/api/src/services/paymentReversal.ts
//
// S561 (money-flow platform-holds, Phase 3): post-settlement reversal handler.
//
// A rent payment that already SETTLED and was batched to the landlord, then
// reverses — a late ACH return / unauthorized return (up to 60 days) or a card
// chargeback. Stripe pulls the funds back from GAM's platform balance, but the
// landlord already has the money. This handler is the rail-agnostic entry
// point: it reopens the tenant's obligation and records the landlord
// receivable. Reclaiming the cash from the landlord (net-vs-ACH-pull per the
// 7-day guaranteed-lease influx rule) is a separate step (recovery engine).
//
// TRIGGER: called from the webhook layer for whatever Stripe event signals a
// reversal on an already-`settled` payment. The exact event name for a late
// ACH return is confirmed at C3 (live keys); card chargebacks arrive as
// charge.dispute.created. This handler is event-name-agnostic — it takes a
// normalized signal — so only the webhook dispatch changes at C3.
//
// REOPEN MODEL (two-row): the original payment flips 'settled' → 'returned'
// (preserving its Stripe charge + owner_share ledger, which the recovery engine
// needs), and a FRESH 'pending' rent row is inserted with the ORIGINAL due date
// and no PaymentIntent — that row is what the tenant re-pays via the FIFO
// pay-balance route, and its presence makes the late-fee engine back-fill fees
// retroactively to the original due date ("as if the payment never happened").

import type { PoolClient } from 'pg'
import { getClient, queryOne, query } from '../db'
import { createAdminNotification } from './adminNotifications'
import { logger } from '../lib/logger'
import type { PaymentReversalType } from '@gam/shared'

export interface PaymentReversalInput {
  paymentId:         string
  reversalType:      PaymentReversalType
  reversedAmount:    number
  reversalFee:       number          // $4 ACH / $15 card GAM was charged; passed through to tenant at cost
  stripeEventId:     string          // idempotency
  stripeObjectId?:   string | null   // dispute id / charge id / refund id
  connectDisputeId?: string | null   // connect_disputes.id for card disputes
  rawEvent:          unknown         // raw webhook payload, stored append-only
}

export interface PaymentReversalResult {
  handled:     boolean
  reason?:     string
  reversalId?: string
}

const REVERSAL_FEE_DESCRIPTION: Record<PaymentReversalType, string> = {
  ach_return:       'ACH return fee (passed through at cost)',
  ach_unauthorized: 'ACH unauthorized-return fee (passed through at cost)',
  card_dispute:     'Card dispute fee (passed through at cost)',
}

export async function handlePaymentReversal(input: PaymentReversalInput): Promise<PaymentReversalResult> {
  // Only a payment that already SETTLED (and was therefore batched to the
  // landlord) needs the reopen + reclaim flow. A pre-settlement ACH failure
  // never became 'settled' and is owned by the achRetry pipeline
  // (payment_intent.payment_failed) — skip.
  const pay = await queryOne<{
    id: string; type: string; status: string; invoice_id: string | null
    tenant_id: string | null; landlord_id: string; lease_id: string | null
    unit_id: string | null; amount: string; due_date: string; entry_description: string
  }>(
    `SELECT id, type, status, invoice_id, tenant_id, landlord_id, lease_id,
            unit_id, amount::text AS amount, due_date::text AS due_date, entry_description
       FROM payments WHERE id = $1`,
    [input.paymentId]
  )
  if (!pay) return { handled: false, reason: 'payment_not_found' }
  if (pay.status !== 'settled') return { handled: false, reason: `not_settled(${pay.status})` }

  const feeDescription = REVERSAL_FEE_DESCRIPTION[input.reversalType]

  const client = await getClient()
  try {
    await client.query('BEGIN')
    // Serialize concurrent webhook deliveries for the same payment.
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
      [`payment_reversal:${input.paymentId}`]
    )

    // Idempotency: one reversal per Stripe event (Stripe re-delivers webhooks).
    const ins = await client.query<{ id: string }>(
      `INSERT INTO payment_reversals
         (payment_id, landlord_id, tenant_id, lease_id, reversal_type,
          reversed_amount, reversal_fee, stripe_event_id, stripe_object_id,
          connect_dispute_id, raw_event)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (stripe_event_id) DO NOTHING
       RETURNING id`,
      [
        pay.id, pay.landlord_id, pay.tenant_id, pay.lease_id, input.reversalType,
        input.reversedAmount, input.reversalFee, input.stripeEventId,
        input.stripeObjectId ?? null, input.connectDisputeId ?? null,
        JSON.stringify(input.rawEvent ?? {}),
      ]
    )
    if ((ins.rowCount ?? 0) === 0) {
      await client.query('ROLLBACK')
      return { handled: false, reason: 'already_processed' }
    }
    const reversalId = ins.rows[0].id

    // Original settled charge → 'returned' (audit + ledger linkage preserved).
    await client.query(
      `UPDATE payments
          SET status = 'returned', return_code = $2, return_reason = $3
        WHERE id = $1`,
      [pay.id, input.reversalType, feeDescription]
    )

    // Fresh re-owed rent obligation: 'pending', NO PaymentIntent (so the FIFO
    // pay-balance route surfaces it), ORIGINAL due date (so late fees back-fill
    // from the original due date, not today).
    await client.query(
      `INSERT INTO payments
         (unit_id, lease_id, tenant_id, landlord_id, type, amount, status,
          entry_description, due_date, invoice_id, notes, reversal_id)
       VALUES ($1,$2,$3,$4,$5,$6,'pending',$7,$8,$9,$10,$11)`,
      [
        pay.unit_id, pay.lease_id, pay.tenant_id, pay.landlord_id, pay.type,
        input.reversedAmount, pay.entry_description, pay.due_date, pay.invoice_id,
        'Reopened after payment reversal', reversalId,
      ]
    )

    // Reversal fee ($4 ACH / $15 card) passes through to the tenant at cost as
    // an owed 'fee' row on the same invoice — routes to the platform (not the
    // landlord) when collected via the GAM-first FIFO.
    if (input.reversalFee > 0) {
      await client.query(
        `INSERT INTO payments
           (unit_id, lease_id, tenant_id, landlord_id, type, amount, status,
            entry_description, due_date, invoice_id, notes, revenue_owner)
         -- -- S609: GAM's own fee (REVENUE_OWNERS, packages/shared) — never an owner share. An ACH retry is one of the three
         -- Nic named as GAM's.
         VALUES ($1,$2,$3,$4,'fee',$5,'pending','RETURNFEE', CURRENT_DATE, $6, $7, 'gam')`,
        [pay.unit_id, pay.lease_id, pay.tenant_id, pay.landlord_id,
         input.reversalFee, pay.invoice_id, feeDescription]
      )
    }

    // Reopen the invoice so the late-fee engine + FIFO see it as owed again.
    if (pay.invoice_id) {
      const others = await client.query(
        `SELECT 1 FROM payments
          WHERE invoice_id = $1 AND type <> 'late_fee'
            AND status = 'settled' AND id <> $2 LIMIT 1`,
        [pay.invoice_id, pay.id]
      )
      const newStatus = (others.rowCount ?? 0) > 0 ? 'partial' : 'pending'
      await client.query(
        `UPDATE invoices SET status = $2, updated_at = NOW()
          WHERE id = $1 AND status <> 'void'`,
        [pay.invoice_id, newStatus]
      )
    }

    await client.query('COMMIT')

    // Immediately back-fill late fees for the reopened invoice so the balance +
    // landlord notification reflect the true amount now, not after the nightly
    // run. Best-effort — the nightly cron is the backstop; the engine is
    // idempotent so double-runs don't duplicate.
    if (pay.invoice_id) {
      try {
        const { generateLateFeesForInvoice } = await import('../jobs/lateFees')
        await generateLateFeesForInvoice(pay.invoice_id)
      } catch (e) {
        logger.error({ err: e, invoice_id: pay.invoice_id }, '[payment_reversal] late-fee backfill failed')
      }
    }

    // Bold landlord alert — they were paid on the batch, so they must be told
    // they've been shorted or they'll never act (post notice / begin eviction).
    await notifyLandlordOfReversal(pay.id).catch((e) =>
      logger.error({ err: e, payment_id: pay.id }, '[payment_reversal] landlord notify failed')
    )

    // Decide recovery immediately (net vs ACH pull) so the Tuesday batch / pull
    // executor can act right away; best-effort, the daily cron backstops it.
    try {
      const { decideReversalRecovery } = await import('./reversalRecovery')
      await decideReversalRecovery(reversalId)
    } catch (e) {
      logger.error({ err: e, reversalId }, '[payment_reversal] recovery decision failed')
    }

    return { handled: true, reversalId }
  } catch (e) {
    try { await client.query('ROLLBACK') } catch { /* already rolled back */ }
    await createAdminNotification({
      severity: 'critical',
      category: 'payment_reversal_failed',
      title:    `Payment reversal handling failed for payment ${input.paymentId}`,
      body:     e instanceof Error ? e.message : String(e),
      context:  { payment_id: input.paymentId, stripe_event_id: input.stripeEventId },
    })
    throw e
  } finally {
    client.release()
  }
}

/**
 * Resolve a reversal when the tenant re-pays the reopened rent. Called from the
 * settle path INSIDE the webhook transaction (the reopened rent row carries
 * payments.reversal_id). Returns whether the landlord was ALREADY clawed back:
 *   - true  → the caller re-disburses the re-payment to the landlord (normal
 *             allocation) — they were made short by the clawback.
 *   - false → GAM KEEPS the re-payment (reimbursing its reversal loss); the
 *             landlord was never disturbed, so its scheduled clawback is
 *             cancelled (recovery_status = 'not_needed').
 * Either way GAM keeps the late fee + reversal fee (late_fee_owner = 'gam').
 * Idempotent. The rare partial-clawback edge (netted some, then the tenant
 * paid before the rest netted) is treated as GAM-keeps to protect the no-loss
 * rule, and raises an admin alert to reconcile the landlord's partial shortfall.
 */
export async function resolveReversalOnTenantPayment(
  client: PoolClient,
  reversalId: string,
): Promise<boolean> {
  const res = await client.query<{
    recovery_status: string; recovered_amount: string; reversed_amount: string; landlord_id: string
  }>(
    `SELECT recovery_status,
            recovered_amount::text AS recovered_amount,
            reversed_amount::text  AS reversed_amount,
            landlord_id
       FROM payment_reversals WHERE id = $1 FOR UPDATE`,
    [reversalId]
  )
  const rev = res.rows[0]
  if (!rev) return false

  const recovered = parseFloat(rev.recovered_amount)
  const reversed  = parseFloat(rev.reversed_amount)
  const fullyRecovered   = rev.recovery_status === 'recovered' || recovered >= reversed
  const partialRecovered = !fullyRecovered && recovered > 0

  await client.query(
    `UPDATE payment_reversals
        SET outcome         = 'tenant_paid',
            late_fee_owner  = 'gam',
            status          = 'resolved',
            resolved_at     = COALESCE(resolved_at, NOW()),
            recovery_status = CASE WHEN $2 THEN recovery_status ELSE 'not_needed' END,
            updated_at = NOW()
      WHERE id = $1`,
    [reversalId, fullyRecovered]
  )

  if (partialRecovered) {
    await createAdminNotification({
      severity: 'warn',
      category: 'payment_reversal_partial_clawback_tenant_paid',
      title:    `Reversal ${reversalId}: tenant re-paid after a PARTIAL landlord clawback`,
      body:     `GAM kept the tenant re-payment (no-loss rule). Landlord ${rev.landlord_id} was clawed back $${recovered.toFixed(2)} of $${reversed.toFixed(2)} — reconcile the partial shortfall by hand.`,
      context:  { reversal_id: reversalId, landlord_id: rev.landlord_id, recovered, reversed },
    })
  }

  return fullyRecovered
}

// Gather context + current owed total and fire the bold landlord alert to the
// property's responsible party. Mirrors the rent-collected notification path.
async function notifyLandlordOfReversal(paymentId: string): Promise<void> {
  const ctx = await query<{
    landlord_id_pk: string; property_id: string
    tenant_name: string; unit_number: string; property_name: string
    invoice_id: string | null
  }>(
    `SELECT l.id AS landlord_id_pk, pr.id AS property_id,
            tu.first_name || ' ' || tu.last_name AS tenant_name,
            un.unit_number, pr.name AS property_name, p.invoice_id
       FROM payments p
       JOIN tenants t     ON t.id = p.tenant_id
       JOIN users tu      ON tu.id = t.user_id
       JOIN landlords l   ON l.id = p.landlord_id
       JOIN units un      ON un.id = p.unit_id
       JOIN properties pr ON pr.id = un.property_id
      WHERE p.id = $1`,
    [paymentId]
  )
  const c = ctx[0]
  if (!c) return

  // Current amount the tenant owes on the reopened invoice = every payable
  // child (the fresh 'pending' rent, the back-filled late fees, the reversal
  // fee). The original 'returned' row is excluded (it's superseded by the
  // fresh pending rent row).
  let amountOwed = 0
  if (c.invoice_id) {
    const owed = await queryOne<{ owed: string }>(
      `SELECT COALESCE(SUM(amount), 0)::text AS owed FROM payments
        WHERE invoice_id = $1 AND status IN ('pending', 'failed')`,
      [c.invoice_id]
    )
    amountOwed = parseFloat(owed?.owed ?? '0')
  }

  const { getPropertyResponsibleParty } = await import('./responsibleParty')
  const targets = await getPropertyResponsibleParty(c.property_id)
  if (!targets) return
  const { notifyRentReversed } = await import('./notifications')
  for (const recipient of targets.primaries) {
    await notifyRentReversed({
      landlordUserId: recipient.user_id,
      landlordId:     c.landlord_id_pk,
      landlordEmail:  recipient.email,
      landlordPhone:  recipient.phone ?? undefined,
      tenantName:     c.tenant_name,
      unitNumber:     c.unit_number,
      propertyName:   c.property_name,
      amountOwed,
      actionUrl:      c.invoice_id ? `/payments?invoice=${c.invoice_id}` : undefined,
    })
  }
}
