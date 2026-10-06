// 10/6 (Nic, "Yes, build it") — the bank feed shows a deposit the landlord
// already logged by hand.
//
//   "When the bank transaction matches up to their invoice, like a bank deposit
//    matches up to their invoice, we are using the date of the bank deposit as
//    validation for whether or not a late fee is there. If it was deposited on
//    the 3rd, and the landlord chose to log it on the 5th or the 6th, we're not
//    going to just waive the late fee and still show that they paid late. It's
//    determined by the matching transaction from the bank log. The only reason
//    we have it any sort of different in the onboarding window is because of
//    the landlord's bank maybe not being fully synced up yet."
//
// A resident deposits rent at the landlord's bank; the office logs it by hand
// from the bank's receipt (Record payment / Post a payment, method "Bank
// deposit" — services/manualPaymentSettle). With no bank line yet, a late fee
// charged after the receipt's date is CREDITED and the payment counts late.
// When the bank line for that same deposit arrives, the 10/5 double-count
// guard holds it out of every automatic step (services/bankFeed decideDeposit
// step 0) — the money is already on the bills. This is what then happens to
// it: the line is tied to the receipt it IS (no money moves again), and the
// bank's date decides after all —
//
//   - the effective day: the receipt's own day when the bank posted the
//     deposit that day or the next business day after it, else the bank's
//     posting day (the same rule a tenant's report gets —
//     depositBackdate.effectivePaidDateFor);
//   - a late fee charged after that day was never owed: the late-fee credit the
//     hand logging applied is withdrawn and the fee zeroed; an unpaid one is
//     zeroed; one the tenant had already paid (dated on or before the
//     receipt's day, so the hand logging did not already refund it) comes back
//     as credit (bankDepositConfirm.reverseLateFees, bankValidated);
//   - each rent and utility mark the deposit paid is re-rated from that day
//     through the ledger's correction chain — to ON TIME when the bank shows it
//     was on time (creditLedgerEmitters.reRateMarksFromBankDate);
//   - when the bank's day shows it was actually late, the late-fee credit
//     stays and a late mark stands; an on-time mark the desk's date gave (a
//     receipt dated on time that the bank posted later than the next business
//     day, past grace) is corrected to the late mark the bank's day earns.
//
// The landlord ties a line to a receipt on the deposit review (POST
// /api/bank-feed/deposits/:id/recorded-deposit); the feed does it by itself
// only when it is certain (recordedDepositToTieBySelf). Everything changed is
// written down (bank_transactions.auto_settle_undo, kind 'recorded_deposit'),
// so Undo puts it all back exactly (undoRecordedDepositMatch).

import type { PoolClient } from 'pg'
import { getClient, queryOne } from '../db'
import { AppError } from '../middleware/errorHandler'
import { logger } from '../lib/logger'
import { lockHousehold, lockPaymentRowsById } from './moneyPredicates'
import { effectivePaidDateFor } from './depositBackdate'
import { declarationReaches } from './bankDepositMatch'
import {
  pendingDepositRefusal, reverseLateFees, restoreZeroedLateFee, type DepositSettleUndo, type UndoneMarker,
} from './bankDepositConfirm'
import { withdrawLateFeeCredit, type CreditedLateFee } from './lateFeeCredit'
import {
  reRateMarksFromBankDate, undoBankDateMarks, type BankDateMarkCorrection,
} from './creditLedgerEmitters'
import { createNotification } from './notifications'
import { runWholeBillCheckAfterCommit } from './creditUse'
import { lateFeeOffBankDateTenantText, lateFeeOffBankDateLandlordText, monthDayLabel } from '@gam/shared'

const toCents = (v: number | string | null | undefined): number => Math.round(Number(v ?? 0) * 100)
const toDollars = (c: number): number => Math.round(c) / 100

/** The kind a recorded-deposit match writes on the bank row's undo record. */
export const RECORDED_DEPOSIT_KIND = 'recorded_deposit' as const

/** A deposit the office logged by hand that a bank line could be. */
export interface RecordedDepositCandidate {
  receiptId: string
  tenantId: string
  tenantName: string
  unitNumber: string | null
  propertyName: string | null
  amount: number
  /** The day the hand logging gave (the receipt's day, on the property's calendar). */
  recordedOn: string
  reference: string | null
  /** The receipt's reference number appears in the bank line's description. */
  referenceInMemo: boolean
  /** The property takes rent its tenants deposit at the bank (properties.tenants_deposit_at_bank). */
  depositsTaken: boolean
}

/** What the bank row keeps so Undo can put everything back (bank_transactions.auto_settle_undo). */
export interface RecordedDepositUndo {
  version: 1
  kind: typeof RECORDED_DEPOSIT_KIND
  /** The hand-logged receipt this line is (the key every "already banked" check reads). */
  receiptId: string
  tenantId: string
  recordedOn: string
  effectivePaidDate: string
  /** Late fees taken off (zeroed), each as it was — credited ones with the day they were credited from. */
  lateFeesZeroed: DepositSettleUndo['lateFeesZeroed']
  /** Late fees that could not be zeroed (other credit on them) and were credited instead. */
  lateFeesCredited: CreditedLateFee[]
  /** Late-fee refund credits for fees already paid. */
  lateFeeRefundCreditIds: string[]
  /** Payment-history marks re-rated from the bank's day. */
  marks: BankDateMarkCorrection[]
  /** The bill lines the receipt paid (bank_deposit_allocations written for each). */
  paymentIds: string[]
  confirmedBy: string | null
  auto: boolean
}

/** A reference number, as letters and digits only, upper case. */
function refKey(v: string | null | undefined): string {
  return String(v ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '')
}

/**
 * Does the receipt's reference number appear on the bank line? Compared as
 * letters and digits only; a reference shorter than 4 characters says nothing.
 */
export function referenceInMemo(reference: string | null | undefined, description: string | null | undefined): boolean {
  const r = refKey(reference)
  return r.length >= 4 && refKey(description).includes(r)
}

/**
 * Every hand-logged bank deposit this bank line could be: the same company,
 * the same amount to the cent, its day within the report window's reach of
 * the bank's posting, settled, and not already tied to a bank line. The ones
 * whose reference appears on the line first.
 */
export async function recordedDepositsFitting(
  runner: Pick<PoolClient, 'query'>,
  txn: { id: string; landlord_id: string; amount: number | string; posted_date: string; description: string | null },
): Promise<RecordedDepositCandidate[]> {
  const { bankMatchReceiptSql } = await import('./depositSlips')
  const rows = (await runner.query<{
    id: string; tenant_id: string; tenant_name: string | null; unit_number: string | null; property_name: string | null
    amount: string; recorded_on: string; reference: string | null; deposits_taken: boolean | null
  }>(
    `SELECT r.id, r.tenant_id,
            NULLIF(TRIM(COALESCE(usr.first_name, '') || ' ' || COALESCE(usr.last_name, '')), '') AS tenant_name,
            u.unit_number, pr.name AS property_name, r.amount::text AS amount,
            to_char((r.settled_at AT TIME ZONE COALESCE(pr.timezone, 'America/Phoenix'))::date, 'YYYY-MM-DD') AS recorded_on,
            r.reference, pr.tenants_deposit_at_bank AS deposits_taken
       FROM tenant_remittances r
       LEFT JOIN leases l      ON l.id = r.lease_id
       LEFT JOIN units u       ON u.id = l.unit_id
       LEFT JOIN properties pr ON pr.id = u.property_id
       LEFT JOIN tenants tn    ON tn.id = r.tenant_id
       LEFT JOIN users usr     ON usr.id = tn.user_id
      WHERE r.landlord_id = $1 AND r.status = 'settled' AND r.payment_method = 'bank_deposit'
        AND r.stripe_payment_intent_id IS NULL
        AND r.amount = $2::numeric
        AND r.settled_at::date BETWEEN ($3::date - 7) AND ($3::date + 7)
        AND NOT ${bankMatchReceiptSql('r')}
      ORDER BY r.settled_at, r.id`,
    [txn.landlord_id, toDollars(toCents(txn.amount)).toFixed(2), txn.posted_date])).rows
  return rows
    .filter(r => declarationReaches(r.recorded_on, txn.posted_date))
    .map(r => ({
      receiptId: r.id, tenantId: r.tenant_id, tenantName: r.tenant_name || 'Tenant',
      unitNumber: r.unit_number, propertyName: r.property_name, amount: toDollars(toCents(r.amount)),
      recordedOn: r.recorded_on, reference: r.reference,
      referenceInMemo: referenceInMemo(r.reference, txn.description),
      depositsTaken: r.deposits_taken === true,
    }))
    .sort((a, b) => Number(b.referenceInMemo) - Number(a.referenceInMemo))
}

/**
 * The one hand-logged deposit the feed may tie this line to BY ITSELF, or
 * null (a person looks at it). 10/6 (Nic): "some people's rents would be
 * exactly the same ... And that's why the tenant needs to put the reference
 * number ... Is the reference number on the receipt the same reference number
 * on the transaction for the bank account? Because if so, then we make that
 * mandatory and then it's auto-matched that way."
 *   - the receipt's reference number appears on the bank line, and no other
 *     receipt's does; or
 *   - it is the ONLY hand-logged deposit that fits, the bank posted it that
 *     day or the next business day after it, no other bank line of the same
 *     amount sits near it, AND no tenant could be the one who made it — no
 *     pending report of that amount and no open bill of exactly that amount
 *     (tenantCouldBePayer). Two residents with the same rent: the office logs
 *     A's $650 from A's receipt, B deposits $650 the same day and B's line
 *     posts first — without the last check B's line would be tied to A's
 *     receipt and B's bank date would decide A's late fees and mark;
 * and, either way, only at a property that takes bank deposits from tenants.
 */
export function recordedDepositToTieBySelf(
  fits: readonly RecordedDepositCandidate[], postedDate: string, sameAmountLines: number,
  tenantCouldBePayer: boolean,
): RecordedDepositCandidate | null {
  const byRef = fits.filter(f => f.referenceInMemo)
  const pick = byRef.length === 1 ? byRef[0]
    : byRef.length === 0 && fits.length === 1 && sameAmountLines === 0 && !tenantCouldBePayer
        && effectivePaidDateFor(fits[0].recordedOn, postedDate) === fits[0].recordedOn ? fits[0]
    : null
  return pick && pick.depositsTaken ? pick : null
}

/**
 * Tie a bank line to the hand-logged deposit it is, and let the bank's date
 * decide (see the header). One transaction. Refused in plain words when the
 * line is no longer waiting, the receipt is not one this line can be, or
 * (by itself) the property does not take bank deposits from tenants.
 */
export async function matchRecordedDeposit(input: {
  bankTransactionId: string; receiptId: string; confirmedByUserId: string | null; auto?: boolean
}): Promise<{
  receiptId: string; effectivePaidDate: string; recordedOn: string
  lateFeesOff: number; lateFeesRefunded: number; marksCorrected: number; undo: RecordedDepositUndo
}> {
  const client = await getClient()
  let tell: { tenantId: string; landlordId: string; off: number; refunded: number; count: number; day: string; amount: number } | null = null
  let subjects: string[] = []
  let refunds = false
  try {
    await client.query('BEGIN')
    const txn = (await client.query<{
      id: string; landlord_id: string; amount: string; description: string | null; posted_date: string
      status: string; landlord_other_income_id: string | null; bank_status: string | null
    }>(
      `SELECT id, landlord_id, amount::text AS amount, description, to_char(posted_date,'YYYY-MM-DD') AS posted_date,
              status, landlord_other_income_id, bank_status
         FROM bank_transactions WHERE id = $1 FOR UPDATE`, [input.bankTransactionId])).rows[0]
    if (!txn) throw new AppError(404, 'Bank transaction not found')
    if (txn.status === 'matched') throw new AppError(409, 'This deposit has already been matched')
    if (txn.status !== 'needs_review' || txn.landlord_other_income_id) {
      throw new AppError(409, 'This deposit is no longer waiting to be matched: it was filed or ignored meanwhile.')
    }
    if (!(toCents(txn.amount) > 0)) throw new AppError(400, 'Only a deposit can be the bank deposit you recorded.')
    const bankRefusal = pendingDepositRefusal(txn.bank_status)
    if (bankRefusal) throw new AppError(409, bankRefusal)

    const fits = await recordedDepositsFitting(client, txn)
    const fit = fits.find(f => f.receiptId === input.receiptId)
    if (!fit) {
      throw new AppError(409,
        'That recorded bank deposit can’t be this one: the amount or the date is different, or another bank line is already tied to it.')
    }
    if (input.auto && !fit.depositsTaken) {
      throw new AppError(409, 'Tenants there don’t deposit rent at the bank, so GAM does not tie a deposit to their bill by itself.')
    }

    // The household first, then the receipt and the rows by id (§1.5).
    await lockHousehold(client, fit.tenantId, txn.landlord_id)
    const receipt = (await client.query<{ status: string; lease_id: string | null }>(
      `SELECT status, lease_id FROM tenant_remittances WHERE id = $1 FOR UPDATE`, [fit.receiptId])).rows[0]
    if (receipt?.status !== 'settled') throw new AppError(409, 'That recorded bank deposit was undone or closed since.')
    // Checked again under the household lock: recordedDepositsFitting read
    // "not tied yet" before it, so two bank lines of the same amount (the
    // feed's own step and a landlord's click, or two clicks) could both pass
    // it and each be tied to this one receipt — one recorded deposit counted
    // against two bank deposits. Whoever held the lock first has committed by
    // now, and this statement's fresh snapshot sees it.
    const { bankMatchReceiptSql } = await import('./depositSlips')
    const stillFree = (await client.query(
      `SELECT 1 FROM tenant_remittances r WHERE r.id = $1 AND NOT ${bankMatchReceiptSql('r')}`, [fit.receiptId])).rows[0]
    if (!stillFree) throw new AppError(409, 'Another bank line was tied to that recorded bank deposit meanwhile.')
    const lines = (await client.query<{ payment_id: string; amount: string; invoice_id: string | null; lease_id: string | null }>(
      `SELECT ra.payment_id, SUM(ra.amount_applied)::text AS amount, p.invoice_id, p.lease_id
         FROM remittance_applications ra JOIN payments p ON p.id = ra.payment_id
        WHERE ra.remittance_id = $1 AND p.status = 'settled'
        GROUP BY ra.payment_id, p.invoice_id, p.lease_id
        ORDER BY ra.payment_id`, [fit.receiptId])).rows
    const paymentIds = lines.map(l => l.payment_id)
    await lockPaymentRowsById(client, paymentIds)

    // The bank's date decides: the receipt's own day when the bank bears it out.
    const day = effectivePaidDateFor(fit.recordedOn, txn.posted_date)

    const zeroed: DepositSettleUndo['lateFeesZeroed'] = []
    const credited: CreditedLateFee[] = []
    const refundCredits: string[] = []
    let offCents = 0
    let refundedCents = 0
    const invoices = [...new Set(lines.map(l => l.invoice_id).filter((x): x is string => !!x))].sort()
    for (const invoiceId of invoices) {
      const head = lines.find(l => l.invoice_id === invoiceId)!
      const r = await reverseLateFees(client, invoiceId, day, {
        settlingIds: paymentIds, tenantId: fit.tenantId, landlordId: txn.landlord_id,
        leaseId: head.lease_id ?? receipt.lease_id, createdBy: input.confirmedByUserId,
        bankValidated: true, includeCredited: true, refundOnlyThrough: fit.recordedOn,
      })
      zeroed.push(...r.zeroed)
      credited.push(...r.credited)
      if (r.refundCreditId) refundCredits.push(r.refundCreditId)
      offCents += toCents(r.unbilled)
      refundedCents += toCents(r.refunded)
    }
    const marks = await reRateMarksFromBankDate(client, { paymentIds, paidOn: day })
    subjects = [...new Set(marks.map(m => m.subjectId))]

    for (const l of lines) {
      if (toCents(l.amount) <= 0) continue
      await client.query(
        `INSERT INTO bank_deposit_allocations
           (bank_transaction_id, payment_id, landlord_id, amount, effective_paid_date)
         VALUES ($1, $2, $3, $4, $5::date)
         ON CONFLICT (bank_transaction_id, payment_id)
           DO UPDATE SET amount = EXCLUDED.amount, effective_paid_date = EXCLUDED.effective_paid_date,
                         reversed_at = NULL, reversed_by = NULL`,
        [txn.id, l.payment_id, txn.landlord_id, toDollars(toCents(l.amount)).toFixed(2), day])
    }

    const undo: RecordedDepositUndo = {
      version: 1, kind: RECORDED_DEPOSIT_KIND, receiptId: fit.receiptId, tenantId: fit.tenantId,
      recordedOn: fit.recordedOn, effectivePaidDate: day,
      lateFeesZeroed: zeroed, lateFeesCredited: credited, lateFeeRefundCreditIds: refundCredits,
      marks, paymentIds, confirmedBy: input.confirmedByUserId, auto: input.auto === true,
    }
    await client.query(
      `UPDATE bank_transactions
          SET status = 'matched', matched_payment_id = $2, auto_settle_undo = $3::jsonb,
              auto_settled_at = CASE WHEN $4::boolean THEN NOW() ELSE NULL END, updated_at = NOW()
        WHERE id = $1`,
      [txn.id, paymentIds[0] ?? null, JSON.stringify(undo), input.auto === true])
    await client.query('COMMIT')

    refunds = refundCredits.length > 0
    const offCount = zeroed.length + credited.length
    tell = {
      tenantId: fit.tenantId, landlordId: txn.landlord_id, off: toDollars(offCents + refundedCents), refunded: toDollars(refundedCents),
      count: offCount + (refundedCents > 0 ? 1 : 0), day, amount: toDollars(toCents(txn.amount)),
    }
    const result = {
      receiptId: fit.receiptId, effectivePaidDate: day, recordedOn: fit.recordedOn,
      lateFeesOff: toDollars(offCents), lateFeesRefunded: toDollars(refundedCents), marksCorrected: marks.length, undo,
    }
    await afterCommit()
    return result
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    client.release()
  }

  async function afterCommit(): Promise<void> {
    if (subjects.length > 0) {
      const { recomputeAndSnapshot } = await import('./creditScore')
      for (const s of subjects) {
        await recomputeAndSnapshot(s).catch(err =>
          logger.error({ err, subjectId: s }, '[recorded-deposit] score recompute failed; the nightly run picks it up'))
      }
    }
    if (tell && refunds) {
      await runWholeBillCheckAfterCommit({ tenantId: tell.tenantId, landlordId: tell.landlordId })
        .catch(err => logger.error({ err }, '[recorded-deposit] whole-bill check failed'))
    }
    if (tell && tell.off > 0) {
      const t = tell
      void notifyLateFeesOff(t).catch(err => logger.error({ err }, '[recorded-deposit] notice failed'))
    }
  }
}

/** Both sides hear that the bank's date took the late fee off (only when one came off). Never throws past its caller. */
async function notifyLateFeesOff(t: { tenantId: string; landlordId: string; off: number; refunded: number; count: number; day: string; amount: number }): Promise<void> {
  const tenantUser = (await queryOne<{ user_id: string }>(`SELECT user_id FROM tenants WHERE id = $1`, [t.tenantId]))?.user_id
  if (tenantUser) {
    await createNotification({
      userId: tenantUser,
      type: 'payment_recorded',
      title: 'Your bank deposit showed up at the bank',
      body: lateFeeOffBankDateTenantText({ depositedOn: t.day, amount: t.off, count: t.count, refunded: t.refunded }),
      actionUrl: '/payments',
    })
  }
  const landlordUser = (await queryOne<{ user_id: string }>(`SELECT user_id FROM landlords WHERE id = $1`, [t.landlordId]))?.user_id
  if (landlordUser) {
    await createNotification({
      userId: landlordUser,
      landlordId: t.landlordId,
      type: 'rent_collected',
      title: 'A bank deposit you recorded showed up at the bank',
      body: `Your $${t.amount.toFixed(2)} bank deposit of ${monthDayLabel(t.day)} matched the deposit you recorded. `
        + lateFeeOffBankDateLandlordText({ depositedOn: t.day, amount: t.off }),
      actionUrl: '/bank?tab=feed',
    })
  }
}

/**
 * Undo of matchRecordedDeposit, inside undoDepositMatch's transaction (the
 * bank row is locked and was matched by this): every late fee it took off is
 * put back as it was (a credited one credited again from its own day), the
 * refund credits are withdrawn (refused when one was used), a fallback credit
 * it applied is taken back, the marks it re-rated are put back through the
 * correction chain, the bank allocations are marked reversed. The hand-logged
 * receipt and its payments are not touched — they were never this match's.
 * Returns the credits withdrawn and the credit subjects changed.
 */
export async function undoRecordedDepositMatch(
  client: PoolClient, a: { transactionId: string; landlordId: string; undo: RecordedDepositUndo; undoneBy: string | null },
): Promise<{ creditsWithdrawn: string[]; lateFeesRestored: number; subjects: string[] }> {
  const u = a.undo
  const changed = (why: string) => new AppError(409, `${why} Nothing was undone — the match stays as it is.`)
  await lockHousehold(client, u.tenantId, a.landlordId)
  const feeIds = [...u.lateFeesZeroed.map(z => z.paymentId), ...u.lateFeesCredited.map(c => c.paymentId)]
  await lockPaymentRowsById(client, [...u.paymentIds, ...feeIds])

  if (u.lateFeesZeroed.length > 0) {
    const fees = (await client.query<{ id: string; amount: string; status: string }>(
      `SELECT id, amount::text AS amount, status FROM payments WHERE id = ANY($1::uuid[])`,
      [u.lateFeesZeroed.map(z => z.paymentId)])).rows
    if (fees.length !== u.lateFeesZeroed.length || fees.some(f => toCents(f.amount) !== 0 || f.status !== 'settled')) {
      throw changed('A late fee this match took off has changed since.')
    }
  }
  const refundIds = u.lateFeeRefundCreditIds ?? []
  if (refundIds.length > 0) {
    const used = (await client.query<{ status: string; used: boolean }>(
      `SELECT tc.status,
              EXISTS (SELECT 1 FROM credit_uses cu WHERE cu.tenant_credit_id = tc.id AND cu.status <> 'released') AS used
         FROM tenant_credits tc WHERE tc.id = ANY($1::uuid[]) FOR UPDATE`, [refundIds])).rows
    if (used.some(c => c.used)) throw changed('The late-fee refund credit from this match has already been used.')
    if (used.some(c => c.status !== 'active')) throw changed('A late-fee refund credit from this match was voided since.')
  }

  for (const z of u.lateFeesZeroed) await restoreZeroedLateFee(client, z, { tenantId: u.tenantId, by: a.undoneBy })
  const withdrawn: string[] = []
  for (const c of u.lateFeesCredited) {
    const w = await withdrawLateFeeCredit(client, c.paymentId)
    withdrawn.push(...w.creditIds)
    await client.query(
      `UPDATE payments SET status = $2, settled_at = NULL, notes = $3 WHERE id = $1 AND status = 'settled'`,
      [c.paymentId, c.priorStatus === 'failed' ? 'failed' : 'pending', c.priorNotes])
  }
  for (const id of refundIds) {
    await client.query(
      `UPDATE tenant_credits SET status = 'void', voided_at = NOW(), updated_at = NOW() WHERE id = $1 AND status = 'active'`, [id])
    withdrawn.push(id)
  }
  const subjects = await undoBankDateMarks(client, u.marks ?? [])
  await client.query(
    `UPDATE bank_deposit_allocations SET reversed_at = NOW(), reversed_by = $2
      WHERE bank_transaction_id = $1 AND reversed_at IS NULL`, [a.transactionId, a.undoneBy])
  return { creditsWithdrawn: withdrawn, lateFeesRestored: u.lateFeesZeroed.length + u.lateFeesCredited.length, subjects }
}

/** Is this bank row's undo record a recorded-deposit match? */
export function isRecordedDepositUndo(undo: unknown): undo is RecordedDepositUndo {
  return !!undo && typeof undo === 'object' && (undo as { kind?: unknown }).kind === RECORDED_DEPOSIT_KIND
}

/** The marker type re-exported for callers that build one. */
export type { UndoneMarker }
