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
 *      corrected.
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
  const marked = new Set(markable.length === 0 ? [] : (await client.query<{ payment_id: string }>(
    `SELECT DISTINCT e.event_data->>'payment_id' AS payment_id
       FROM credit_events e
      WHERE e.event_type = ANY($1::text[])
        AND e.event_data->>'payment_id' = ANY($2::text[])
        -- A mark withdrawn by an undone bank match (it points at itself) no
        -- longer counts: the line paid again earns its own mark.
        -- (NULL-safe: a live mark has superseded_by NULL and must still count.)
        AND NOT (e.superseded_by IS NOT DISTINCT FROM e.id
                 AND e.superseded_reason IS NOT DISTINCT FROM 'attestation_invalidated')`,
    [PAYMENT_MARK_TYPES, markable.map(r => r.id)])).rows.map(r => r.payment_id))
  const alreadyMarked = markable.filter(r => marked.has(r.id)).map(r => r.id)
  if (alreadyMarked.length > 0) {
    logger.warn({ alreadyMarked }, '[afterRowsSettled] rows already carry their payment mark; not marked again')
  }

  let eventsEmitted = 0
  for (const r of markable) {
    if (marked.has(r.id) || !r.tenant_id || !r.due_date || (r.type !== 'rent' && r.type !== 'utility')) continue
    await emitPaymentSettledEvent(client, {
      tenantId:              r.tenant_id,
      paymentId:             r.id,
      paymentType:           r.type,
      amount:                r.amount,
      dueDate:               r.due_date,
      settledAt:             r.settled_at ? new Date(r.settled_at) : new Date(),
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
