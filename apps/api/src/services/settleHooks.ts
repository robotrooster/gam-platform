// S655 money plan §1.5 (Step 1): THE one routine that runs after charge rows
// are settled, whatever settled them.
//
// The Stripe webhook and the desk (services/manualPaymentSettle) each grew their
// own copy of "what happens once money has landed": the landlord goes live on
// their first money through GAM (S600/S637; 10/5 any kind, not only rent), the
// tenant's payment history gets its on-time or late mark (S652), and the person
// who paid gets a receipt (S637).
// The money plan adds five more settle paths (credit-only, whole-bill, FlexPay
// cover, bank-deposit match, posted payment); a seventh copy of each step would
// drift the way the first two already had (the desk marked reopened rows, the
// webhook did not). This is lifted from those two files without changing them;
// they switch to it in Steps 8 and 10.
//
// Runs INSIDE the caller's transaction (activation and the payment-history mark
// move with the money: if either fails, the settle rolls back). The receipt is
// the exception: email never runs inside a money transaction, so the caller
// gets afterCommit() and calls it once COMMIT has returned.
//
// THE CONTRACT: pass the rows THIS transaction just settled, i.e. the ids its
// own UPDATE ... SET status = 'settled' ... WHERE status <> 'settled'
// RETURNING id gave back. Never "every settled row on the lease", never the ids
// a replayed webhook names. The payment-history mark is also guarded here (a
// row that already has its mark never gets a second one, so a replay cannot
// write a duplicate on-time mark) and activation only ever starts a landlord
// once; the receipt cannot be guarded, so passing rows settled earlier emails
// the tenant a receipt for money they paid before.
//
//   const settled = await client.query(`UPDATE payments SET status = 'settled', ...
//                                        WHERE id = ANY($1) AND status <> 'settled' RETURNING id`, [ids])
//   const after = await afterRowsSettled(client, settled.rows.map(r => r.id), {
//     attestationSource: 'stripe_attested', receipt: { method: 'card' } })
//   await client.query('COMMIT')
//   await after.afterCommit()

import type { PoolClient } from 'pg'
import { CREDIT_EVENT_TYPES } from '@gam/shared'
import type { CreditAttestationSource } from '@gam/shared'
import { activateBillingForSettledPayments } from './billingActivation'
import { emitPaymentSettledEvent } from './creditLedgerEmitters'
import type { ReceiptOpts } from './paymentReceipt'
import { logger } from '../lib/logger'

export interface AfterRowsSettledContext {
  /**
   * Who vouches that the money arrived, for the payment-history mark:
   *   'stripe_attested'                       card or ACH through Stripe
   *   'landlord_self_reported_with_evidence'  desk cash/check/money order, a
   *                                           matched bank deposit, a posted payment
   *   'gam_workflow_auto'                     paid by credit, the whole-bill rule,
   *                                           the FlexPay cover
   */
  attestationSource: CreditAttestationSource
  /** What backs it (check number, bank row, intent id). Omitted for a Stripe
   *  settle, each row's own intent id is recorded. */
  attestationEvidence?: Record<string, unknown>
  /** The receipt to send AFTER the caller commits, covering every row passed.
   *  null when this event sends no receipt (or the caller sends its own). */
  receipt: Omit<ReceiptOpts, 'paymentIds'> | null
  /**
   * 10/5 (Nic): rows the caller paid only IN PART (a part payment recorded at
   * the desk; the rest stays open on its own row). They settle, but carry no
   * on-time or late mark: a bill's mark is for the day it is paid in full,
   * which is when its rest is paid.
   */
  partPaidIds?: readonly string[]
}

export interface AfterRowsSettledResult {
  /** The passed rows that are settled; everything below ran for these only. */
  settledIds: string[]
  /** Landlords whose billing this settle started (10/5: their first money through GAM, any kind). */
  billingActivated: number
  /** payment_received_* marks written (rent and utility rows, reopened rows excluded). */
  eventsEmitted: number
  /** Rows passed in that already carried their payment mark (a replay); none was written again. */
  alreadyMarked: string[]
  /** Call once after COMMIT: sends the receipt. Never throws. Not calling it means no receipt. */
  afterCommit: () => Promise<void>
}

/** The payment-history marks a settled rent or utility row can carry (one per row). */
const PAYMENT_MARK_TYPES: readonly string[] = CREDIT_EVENT_TYPES.filter(t => t.startsWith('payment_received_'))

/**
 * Run the post-settle steps for rows the caller just settled in this
 * transaction (see THE CONTRACT above):
 *   1. activateBillingForSettledPayments: the landlord's first money through
 *      GAM ends their onboarding grace — 10/5 (Nic), any kind of payment, not
 *      only rent ("Somebody's only paying utilities, that's the landlord
 *      doesn't have free onboarding"). Reopened rows are skipped: their
 *      landlord went live when the original row settled. So is a row paid
 *      wholly by account credit (no new money). Starts a landlord only once.
 *   2. emitPaymentSettledEvent for each rent and utility row with a tenant: the
 *      on-time / late mark (S652), on the property's calendar, with the
 *      attestation the caller names. Reopened rows (paid again after a dispute
 *      or return) are skipped: a re-payment is not a fresh on-time signal. A
 *      row that already carries a mark is skipped too (a replay), whatever
 *      became of that mark since: a mark an admin later corrected stays
 *      corrected. 10/6 (Nic): a row whose bill has a late fee on it is
 *      marked LATE, from the day this runs (the day GAM recorded it), onboarding
 *      month or not.
 *   3. the receipt, queued for afterCommit().
 * Ids that are not settled (or do not exist) are ignored and logged. The rows
 * are locked, so two replays of one settle cannot both find no mark.
 */
export async function afterRowsSettled(
  client: PoolClient,
  paymentIds: readonly string[],
  ctx: AfterRowsSettledContext,
): Promise<AfterRowsSettledResult> {
  const unique = [...new Set(paymentIds)].sort()
  const rows = unique.length === 0 ? [] : (await client.query<{
    id: string; type: string; tenant_id: string | null; lease_id: string | null
    amount: string; due_date: string | null; settled_at: Date | null
    reversal_id: string | null; stripe_payment_intent_id: string | null
    late_fee_grace_days: number | null; property_tz: string | null
  }>(
    `SELECT p.id, p.type, p.tenant_id, p.lease_id, p.amount::text AS amount,
            p.due_date::text AS due_date, p.settled_at, p.reversal_id,
            p.stripe_payment_intent_id,
            l.late_fee_grace_days,
            pr.timezone AS property_tz
       FROM payments p
       LEFT JOIN leases l      ON l.id = p.lease_id
       LEFT JOIN units u       ON u.id = p.unit_id
       LEFT JOIN properties pr ON pr.id = u.property_id
      WHERE p.id = ANY($1::uuid[]) AND p.status = 'settled'
      ORDER BY p.id
        FOR UPDATE OF p`,
    [unique])).rows

  if (rows.length !== unique.length) {
    const seen = new Set(rows.map(r => r.id))
    logger.warn({ notSettled: unique.filter(id => !seen.has(id)) },
      '[afterRowsSettled] some rows passed in are not settled; skipped')
  }

  const fresh = rows.filter(r => !r.reversal_id)
  // 10/5 (Nic): "money movement is the end of onboarding" — every type.
  const billingActivated = await activateBillingForSettledPayments(client, fresh.map(r => r.id))

  const partPaid = new Set(ctx.partPaidIds ?? [])
  const markable = fresh.filter(r => r.tenant_id && r.due_date && (r.type === 'rent' || r.type === 'utility')
    && !partPaid.has(r.id))
  // Each of the row's marks is followed to the end of its correction chain
  // (superseded_by). The row is marked unless every chain ends in a mark
  // withdrawn as no longer vouched for (it points at itself,
  // 'attestation_invalidated' — an undone bank match): then the line paid
  // again earns its own mark. A chain ending in a live mark, or in one an
  // admin corrected away, still counts (a corrected mark stays corrected).
  const marked = new Set(markable.length === 0 ? [] : (await client.query<{ payment_id: string }>(
    `WITH RECURSIVE chain AS (
       SELECT e.id AS cur, e.superseded_by, e.superseded_reason, e.event_data->>'payment_id' AS payment_id, 0 AS hops
         FROM credit_events e
        WHERE e.event_type = ANY($1::text[])
          AND e.event_data->>'payment_id' = ANY($2::text[])
       UNION ALL
       SELECT n.id, n.superseded_by, n.superseded_reason, c.payment_id, c.hops + 1
         FROM chain c JOIN credit_events n ON n.id = c.superseded_by
        WHERE c.superseded_by IS NOT NULL AND c.superseded_by <> c.cur AND c.hops < 20
     )
     SELECT DISTINCT payment_id FROM chain
      WHERE superseded_by IS NULL
         OR (superseded_by = cur AND superseded_reason IS DISTINCT FROM 'attestation_invalidated')`,
    [PAYMENT_MARK_TYPES, markable.map(r => r.id)])).rows.map(r => r.payment_id))
  const alreadyMarked = markable.filter(r => marked.has(r.id)).map(r => r.id)
  if (alreadyMarked.length > 0) {
    logger.warn({ alreadyMarked }, '[afterRowsSettled] rows already carry their payment mark; not marked again')
  }

  // 10/6 (Nic): "the late payment still shows on their payment history" — no
  // exceptions. A bill with a late fee on it (charged and not deleted: one
  // credited because the money turns out to have been in the bank still
  // counts) gets a LATE mark for its rent and utility, counted from the day
  // the payment was recorded or confirmed in GAM, never from an earlier date
  // the record carries (a bank deposit's date) — whether or not the tenant
  // reported it first, onboarding month or not (creditLedgerEmitters). Only the
  // landlord deleting the late fee, in the onboarding month, lifts it
  // (services/lateFeeDelete → reRateMarksWithoutLateFee).
  const toMark = markable.filter(r => !marked.has(r.id))
  const withLateFee = new Set(toMark.length === 0 ? [] : (await client.query<{ id: string }>(
    `SELECT p.id FROM payments p
      WHERE p.id = ANY($1::uuid[]) AND p.invoice_id IS NOT NULL
        AND EXISTS (SELECT 1 FROM payments f
                     WHERE f.invoice_id = p.invoice_id AND f.type = 'late_fee'
                       AND f.amount > 0 AND f.status <> 'voided')`,
    [toMark.map(r => r.id)])).rows.map(r => r.id))
  const recordedAt = new Date()

  let eventsEmitted = 0
  for (const r of markable) {
    if (marked.has(r.id) || !r.tenant_id || !r.due_date || (r.type !== 'rent' && r.type !== 'utility')) continue
    const settledAt = r.settled_at ? new Date(r.settled_at) : recordedAt
    const lateFeeOnBill = withLateFee.has(r.id)
    await emitPaymentSettledEvent(client, {
      tenantId:              r.tenant_id,
      paymentId:             r.id,
      paymentType:           r.type,
      amount:                r.amount,
      dueDate:               r.due_date,
      settledAt:             lateFeeOnBill && settledAt < recordedAt ? recordedAt : settledAt,
      lateFeeOnBill,
      moneyPaidAt:           lateFeeOnBill ? settledAt : null,
      graceDays:             r.late_fee_grace_days,
      // Only a Stripe settle vouches with its intent; a row an old, failed
      // intent once touched must not cite it when the desk or credit paid it.
      stripePaymentIntentId: ctx.attestationSource === 'stripe_attested' ? r.stripe_payment_intent_id : null,
      propertyTz:            r.property_tz,
      attestationSource:     ctx.attestationSource,
      attestationEvidence:   ctx.attestationEvidence,
    })
    eventsEmitted++
  }

  const settledIds = rows.map(r => r.id)
  const receipt = ctx.receipt
  let sent = false
  const afterCommit = async (): Promise<void> => {
    if (sent || !receipt || settledIds.length === 0) return
    sent = true
    try {
      const { sendPaymentReceipt } = await import('./paymentReceipt')
      await sendPaymentReceipt({ ...receipt, paymentIds: settledIds })
    } catch (e) {
      logger.error({ err: e, paymentIds: settledIds }, '[afterRowsSettled] receipt failed')
    }
  }

  return { settledIds, billingActivated, eventsEmitted, alreadyMarked, afterCommit }
}
