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
import type { CreditAttestationSource } from '@gam/shared'
import { activateBillingForSettledPayments } from './billingActivation'
import { syncBillMarksAfterSettle, billKeysOfPayments } from './creditLedgerEmitters'
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
   * the desk; the rest stays open on its own row). 10/12: no longer read — the
   * bill's one mark comes from its records (a bill part paid is judged a
   * partly-paid bill, and only once past grace); kept so callers need not change.
   */
  partPaidIds?: readonly string[]
  /**
   * 10/6 (Nic, "Yes, build it"): these rows were paid by a BANK LINE matched to
   * the bill (services/bankDepositConfirm), so the bank's date decides: the
   * mark counts from the row's settled day (the bank-validated date), on time
   * if it was on time. The forced-late rule below does not apply. Only a late
   * fee genuinely owed — one charged on or before that day, still on the bill
   * — makes the mark late (and lifts the onboarding month's positive-only
   * rule, as any late fee on the bill does): "If it was deposited on the 3rd,
   * and the landlord chose to log it on the 5th or the 6th, we're not going
   * to just waive the late fee and still show that they paid late."
   */
  bankValidated?: boolean
  // 10/12: attestationSource and attestationEvidence are no longer read for
  // the payment history: a bill's mark is derived from its records
  // ('system_derived'). bankValidated still is: the bank's day is the rows'
  // settled day before the match writes its allocation rows.
}

export interface AfterRowsSettledResult {
  /** The passed rows that are settled; everything below ran for these only. */
  settledIds: string[]
  /** Landlords whose billing this settle started (10/5: their first money through GAM, any kind). */
  billingActivated: number
  /** 10/12: bill marks written (one per bill whose mark was written or corrected). */
  eventsEmitted: number
  /** 10/12: rows on bills whose mark was already right (a replay, a bill not judged yet); nothing written for them. */
  alreadyMarked: string[]
  /**
   * Call once after COMMIT: sends the receipt, and (10/12, GAM Books ledger)
   * posts this settle to the books right away instead of at the next minute's
   * drain. Never throws. Not calling it means no receipt; the books still post
   * within the minute.
   */
  afterCommit: () => Promise<void>
}

/**
 * Run the post-settle steps for rows the caller just settled in this
 * transaction (see THE CONTRACT above):
 *   1. activateBillingForSettledPayments: the landlord's first money through
 *      GAM ends their onboarding grace — 10/5 (Nic), any kind of payment, not
 *      only rent ("Somebody's only paying utilities, that's the landlord
 *      doesn't have free onboarding"). Reopened rows are skipped: their
 *      landlord went live when the original row settled. So is a row paid
 *      wholly by account credit (no new money). Starts a landlord only once.
 *   2. the payment history (10/12, Nic: "one mark per invoice"): the bills
 *      the rows are on are judged by the payment-health rule and each bill's
 *      one mark brought to it (services/creditBillMarks). A replay writes
 *      nothing (the bill's mark is already right); a mark an admin corrected
 *      after a dispute stays corrected. The rule reads the bill's records:
 *      the attestation the caller names is no longer used for it.
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

  // 10/12 (Nic): "the payment history should be a health percentage. one mark
  // per invoice." The rows' BILLS are judged — once, together — by the
  // payment-health rule, and each bill's one mark brought to what the rule
  // gives it (creditLedgerEmitters.syncBillMarksAfterSettle →
  // services/creditBillMarks), in this transaction: the mark moves with the
  // money. Every settled row counts, whatever its kind, a part payment and a
  // reopened row included — the bill's own records decide (a part payment past
  // grace is a partly-paid bill; a re-payment after a bounce is that bill paid
  // late or on time). A replay finds its bill's mark already right and writes
  // nothing. The day each line counts from, the onboarding month, a bank
  // match, a late fee on the bill — 10/6: a line logged by hand after a late
  // fee was charged counts from the day GAM recorded it, a bank line's day
  // decides when one is matched — all live in that rule now.
  const changes = await syncBillMarksAfterSettle(client, rows.map(r => r.id), { bankValidated: ctx.bankValidated === true })
  const eventsEmitted = changes.filter(c => c.eventId !== null).length
  const changedBills = new Set(changes.map(c => c.billKey))
  const billOf = rows.length === 0 ? new Map<string, string>() : await billKeysOfPayments(client, rows.map(r => r.id))
  const alreadyMarked = [...billOf].filter(([, k]) => !changedBills.has(k)).map(([id]) => id).sort()

  const settledIds = rows.map(r => r.id)
  const receipt = ctx.receipt

  // 10/12 (Nic, ledger L1): the books post "within a minute" of the money
  // event. The minute drain always gets there; once this settle commits, the
  // kick posts its sources at once (gam-ledger-design-2026-10-12 §3). It needs
  // this transaction's id, read here — but only while the ledger posts anything
  // at all: dark (no projector registered) means no extra query in the money
  // transaction. A load failure only skips the kick.
  let ledgerXid: string | null = null
  if (settledIds.length > 0) {
    let posting = false
    try {
      posting = (await import('./ledgerEngine')).registeredLedgerSourceTypes().length > 0
    } catch { /* the minute drain posts it */ }
    if (posting) {
      ledgerXid = (await client.query<{ xid: string }>(`SELECT pg_current_xact_id()::text AS xid`)).rows[0]?.xid ?? null
    }
  }

  let sent = false
  let kicked = false
  const afterCommit = async (): Promise<void> => {
    if (ledgerXid && !kicked) {
      kicked = true
      const xid = ledgerXid
      // Not awaited: the books never hold up the caller's response.
      void import('./ledgerEngine').then(m => m.kickLedgerAfterCommit(xid)).catch(() => {})
    }
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
