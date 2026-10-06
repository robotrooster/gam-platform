// 10/6 (Nic) — a late fee that was never owed is CREDITED, never zeroed.
//
//   "Late fees are not automatically on time because of the onboarding month.
//    That's the landlord's discretion. This landlord does not want to give
//    grace past the grace period for late fees for tenants that are screwing
//    stuff up. So the late fee is only available to be completely deleted
//    during the onboarding month. Other than that, they get a credit against
//    their bill and the late payment still shows on their payment history."
//
// A bank deposit dated before a late fee was charged shows the fee was never
// owed (services/bankDepositConfirm.reverseLateFees). The fee STAYS as it was
// charged; a credit the landlord gives (tenant_credits, category
// late_fee_refund, "Late fee credited — …") is APPLIED to it through the one
// credit ledger (credit_uses, source late_fee_credit), so its line reads paid
// by credit and the bill nets to zero on every balance, invoice and statement
// (v_payment_money: money_part = amount − issued_credit_amount = 0). The fee
// still being on the bill is what keeps the payment counted late on the
// tenant's payment history (services/settleHooks).
//
// Two ways back out, both inside the caller's transaction:
//   - an Undo of the bank match that credited it (bankDepositConfirm.
//     undoDepositMatch): the credit is taken back off the fee and withdrawn,
//     and the fee is owed again exactly as before;
//   - the landlord deleting the fee in the onboarding month (services/
//     lateFeeDelete): the credit is taken back and withdrawn, then the fee row
//     is removed.
// "Taken back" is the credit use released with release_reason
// 'late_fee_credit_withdrawn' (migration 20261006100000) — the use is kept
// forever, like every use; the trigger gives the amount back to the credit
// and recounts the fee's issued_credit_amount.

import type { PoolClient } from 'pg'
import { monthDayLabel } from '@gam/shared'
import { createIssuedCredit, applyCredit } from './creditUse'

const toCents = (v: number | string | null | undefined): number => Math.round(Number(v ?? 0) * 100)
const toDollars = (c: number): number => Math.round(c) / 100

/** The note a credited late fee carries (the date the rent was really paid follows). */
export const CREDITED_LATE_FEE_NOTE = 'Late fee credited: rent was paid '

/**
 * 10/6 (Nic, "Yes, build it"): the note on a late fee a MATCHED BANK LINE
 * showed was never owed — taken off at $0.00, not credited (the bank's date
 * follows). Different from the pre-10/6 "Reversed: rent was paid" note on
 * purpose: scripts/oct6_fix_reversed_late_fees converts only those, and must
 * never turn a bank-validated fee back into a credited one.
 */
export const BANK_SHOWS_LATE_FEE_NOTE = 'Came off: the bank shows the deposit on '

/** The credit's reason, in plain words (shown wherever the tenant's credits are listed). */
export function lateFeeCreditReason(paidOn: string): string {
  // 10/6 (Nic): plain words — "Oct 2", never the stored date's ISO form.
  return `Late fee credited — the bank shows rent was paid on ${monthDayLabel(paidOn)}, before this fee was charged`
}

/** A late fee this credited, as it was before (for an exact Undo). */
export interface CreditedLateFee {
  paymentId: string
  /** Dollars the credit paid on it (the fee's open amount). */
  amount: number
  priorStatus: string
  priorNotes: string | null
  /**
   * Dollars of other credit already applied to it before (its
   * issued_credit_amount then) — that credit stays applied; Undo checks the
   * fee carries exactly this plus `amount`. Absent on a record written before
   * it was kept: 0.
   */
  priorIssued?: number
  creditId: string
  useId: string
}

/**
 * Credit one unpaid late fee that was never owed, so it nets to zero. The fee
 * must be unpaid and owed in money (pending with no card or bank payment on
 * its way, or failed) and sit on a lease and a space (the ledger's rule for any
 * credit). Returns null — and changes nothing — when it is not; the caller
 * leaves that fee as it is. Credit the tenant had already spent on part of it
 * stays spent (alreadyPaidByCredit): the caller gives it back with the refund
 * for fees already paid.
 */
export async function creditLateFee(
  client: PoolClient,
  paymentId: string,
  o: { paidOn: string; tenantId: string; createdBy: string | null },
): Promise<(CreditedLateFee & { alreadyPaidByCredit: number }) | null> {
  const f = (await client.query<{
    id: string; type: string; amount: string; status: string; notes: string | null
    lease_id: string | null; unit_id: string | null; tenant_id: string | null; landlord_id: string
    stripe_payment_intent_id: string | null; billing_month: string; on_it: string; held: string; issued: string
  }>(
    `SELECT p.id, p.type, p.amount::text AS amount, p.status, p.notes, p.lease_id, p.unit_id, p.tenant_id,
            p.landlord_id, p.stripe_payment_intent_id, p.issued_credit_amount::text AS issued,
            to_char(date_trunc('month', COALESCE(inv.due_date, p.due_date)), 'YYYY-MM-DD') AS billing_month,
            (SELECT COALESCE(SUM(u.amount), 0) FROM credit_uses u
              WHERE u.payment_id = p.id AND u.status = 'applied')::text AS on_it,
            (SELECT COALESCE(SUM(u.amount), 0) FROM credit_uses u
              WHERE u.payment_id = p.id AND u.status = 'held')::text AS held
       FROM payments p
       LEFT JOIN invoices inv ON inv.id = p.invoice_id
      WHERE p.id = $1
        FOR UPDATE OF p`, [paymentId])).rows[0]
  if (!f || f.type !== 'late_fee') return null
  const owed = (f.status === 'pending' && !f.stripe_payment_intent_id) || f.status === 'failed'
  if (!owed || !f.lease_id || !f.unit_id || toCents(f.held) > 0) return null
  const open = toCents(f.amount) - toCents(f.on_it)
  if (open <= 0) return null

  const creditId = await createIssuedCredit(client, {
    landlordId: f.landlord_id, tenantId: f.tenant_id ?? o.tenantId, leaseId: f.lease_id,
    amount: toDollars(open), category: 'late_fee_refund',
    reason: lateFeeCreditReason(o.paidOn), createdBy: o.createdBy,
  })
  const [useId] = await applyCredit(client, [{
    creditKind: 'issued', creditId, paymentId: f.id, leaseId: f.lease_id,
    amount: toDollars(open), billingMonth: f.billing_month,
  }], { source: 'late_fee_credit', createdBy: o.createdBy })
  const u = await client.query(
    `UPDATE payments
        SET status = 'settled', settled_at = NOW(), next_retry_at = NULL,
            notes = COALESCE(notes || ' — ', '') || $2 || $3::text || ', before this fee was charged'
      WHERE id = $1 AND status IN ('pending', 'failed')`,
    [f.id, CREDITED_LATE_FEE_NOTE, o.paidOn])
  if ((u.rowCount ?? 0) !== 1) throw new Error(`late fee ${f.id} changed while it was being credited`)
  return {
    paymentId: f.id, amount: toDollars(open), priorStatus: f.status, priorNotes: f.notes,
    priorIssued: toDollars(toCents(f.issued)), creditId, useId,
    alreadyPaidByCredit: toDollars(toCents(f.on_it)),
  }
}

/** The late-fee credit on one late fee: its live uses and the credits they spend. */
export async function lateFeeCreditsOn(
  client: Pick<PoolClient, 'query'>, paymentId: string,
): Promise<Array<{ useId: string; creditId: string; amount: number; creditStatus: string; otherUses: number }>> {
  const r = await client.query<{ use_id: string; credit_id: string; amount: string; credit_status: string; other_uses: number }>(
    `SELECT u.id AS use_id, u.tenant_credit_id AS credit_id, u.amount::text AS amount, tc.status AS credit_status,
            (SELECT COUNT(*)::int FROM credit_uses o
              WHERE o.tenant_credit_id = u.tenant_credit_id AND o.id <> u.id AND o.status IN ('held','applied')) AS other_uses
       FROM credit_uses u JOIN tenant_credits tc ON tc.id = u.tenant_credit_id
      WHERE u.payment_id = $1 AND u.status = 'applied' AND u.source = 'late_fee_credit'
        AND tc.category = 'late_fee_refund'
      ORDER BY u.id`, [paymentId])
  return r.rows.map(x => ({
    useId: x.use_id, creditId: x.credit_id, amount: toDollars(toCents(x.amount)),
    creditStatus: x.credit_status, otherUses: x.other_uses,
  }))
}

/**
 * Take the late-fee credit back off one late fee, inside the caller's
 * transaction: each late_fee_credit use on it is released
 * ('late_fee_credit_withdrawn' — the amount goes back to the credit), and each
 * credit that existed only for this fee is withdrawn (void), so nothing of it
 * is left for the tenant to spend. Leaves the fee's own row as it is (the
 * caller reopens or deletes it). Returns what it took back.
 */
export async function withdrawLateFeeCredit(
  client: PoolClient, paymentId: string,
): Promise<{ useIds: string[]; creditIds: string[]; amount: number }> {
  const on = await lateFeeCreditsOn(client, paymentId)
  const useIds: string[] = []
  const creditIds: string[] = []
  let cents = 0
  for (const c of on) {
    const r = await client.query(
      `UPDATE credit_uses
          SET status = 'released', released_at = NOW(), release_reason = 'late_fee_credit_withdrawn'
        WHERE id = $1 AND status = 'applied'`, [c.useId])
    if ((r.rowCount ?? 0) !== 1) throw new Error(`late-fee credit use ${c.useId} changed while it was being taken back`)
    useIds.push(c.useId)
    cents += toCents(c.amount)
    if (c.otherUses === 0) {
      await client.query(
        `UPDATE tenant_credits SET status = 'void', voided_at = NOW(), updated_at = NOW()
          WHERE id = $1 AND status = 'active'`, [c.creditId])
      creditIds.push(c.creditId)
    }
  }
  return { useIds, creditIds, amount: toDollars(cents) }
}

/**
 * Is this late fee one a reversal credited (it nets to zero, its open part paid
 * by its own late-fee credit)? Settled, carrying the credited note, with a
 * live late-fee credit on it and its whole amount covered by credit. Other
 * credit applied to it before the reversal (a landlord's own credit) may sit
 * beside the late-fee credit: the fee is still a credited one — and
 * lateFeeDelete then refuses to delete it because that other credit is
 * recorded against it, saying so.
 */
export async function isCreditedLateFee(
  client: Pick<PoolClient, 'query'>,
  fee: { id: string; type: string; amount: string | number; status: string; notes: string | null },
): Promise<boolean> {
  if (fee.type !== 'late_fee' || fee.status !== 'settled' || !(fee.notes ?? '').includes(CREDITED_LATE_FEE_NOTE)) return false
  const r = (await client.query<{ credited: string; other: string }>(
    `SELECT COALESCE(SUM(u.amount) FILTER (WHERE u.source = 'late_fee_credit' AND u.status = 'applied'), 0)::text AS credited,
            COALESCE(SUM(u.amount) FILTER (WHERE NOT (u.source = 'late_fee_credit' AND u.status = 'applied')
                                              AND u.status = 'applied'), 0)::text AS other
       FROM credit_uses u WHERE u.payment_id = $1`, [fee.id])).rows[0]
  return toCents(r.credited) > 0 && toCents(r.credited) + toCents(r.other) === toCents(fee.amount)
}
