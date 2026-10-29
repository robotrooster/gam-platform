/**
 * 10/12 (Nic) — KEEP EVERYTHING: a charge nobody owes is VOIDED, never deleted.
 *
 * Nine places used to DELETE an unpaid charge row the moment it stopped being
 * owed (design gam-ledger-design-2026-10-12 §P2):
 *   - a lease voided before the tenant signed (lib/unwindIssuedLease, 4 sites);
 *   - a new lease that will never start (services/renewalSuccessor, 2 sites);
 *   - rent past a shortened stay's new end (services/bookingLeaseBilling);
 *   - a reservation's fee when the reservation went away (services/commonAreas);
 *   - a home sale's payments when its agreement is voided (lib/voidDocument).
 * The row and everything it said — what was billed, to whom, for when, and
 * that it stopped being owed — went with it. Each now marks the row with the
 * recorded void status decisions #48.5 already gave payments: status
 * 'voided', voided_at and a plain void_reason. The row is kept forever, owed by
 * nobody, paid by nothing, and in no balance or total (every balance reads
 * 'pending'/'failed'; every report and total leaves 'voided' out).
 *
 * WHAT IS VOIDED is exactly what the DELETE removed, and nothing more:
 *   - only a charge still owed ('pending' or 'failed') — the same guard every
 *     DELETE carried, and the one trg_payments_voided_is_a_record enforces;
 *   - never a charge another record points at (chargeHeldByRecordSql). The
 *     database refused to DELETE such a row (every foreign key into payments
 *     without an ON DELETE action, and live account credit), and each caller
 *     already did something with that refusal: one void is refused in plain
 *     words, another keeps the row for GAM to take off by hand. An UPDATE is
 *     never refused that way, so the same rows are found up front and handed
 *     back to the caller to decide exactly as before.
 *
 * ON THE ROW, besides the stamps:
 *   - next_retry_at is cleared: a charge nobody owes is never pulled again
 *     (the existing voids do the same);
 *   - work_trade_suspended_at is cleared: a voided line is parked under
 *     nothing. Left stamped, every reader that counts the stamp alone
 *     (work-trade standing, the month-close credit, the "covered by work trade"
 *     lines beside a report) would keep counting a line that used to vanish.
 *   - a home-sale payment lets go of its installment (10/12 review): the
 *     installment is unbilled again (home_sale_installments.payment_id =
 *     NULL) and the voided row gives up home_sale_installment_id, whose
 *     unique slot covers every status. The DELETE did the first through its
 *     ON DELETE SET NULL; without both, the installment could never be billed
 *     again (every bill run picks only installments with no payment, and
 *     inserts ON CONFLICT on that slot) and the sale could never be paid off.
 *     A caller that is cancelling the sale itself (lib/voidDocument) says so
 *     (keepInstallmentLink): its installments never bill again, so the voided
 *     row keeps naming the one it billed.
 * The amount, dates, lease, unit, tenant and bill are left exactly as they
 * were — that is the record. (The old values of the cleared columns are kept
 * by the audit trigger on payments, which is how a voided home payment still
 * names its installment.)
 *
 * THE OTHER FOREIGN KEYS THAT SET NULL ON A DELETE each had a side effect a
 * void must account for (chargeVoids.test.ts holds every one to this list):
 *   - home_sale_installments.payment_id — released here (above);
 *   - utility_bills.payment_id — unlinked by the paths that void utility
 *     lines (lib/unwindIssuedLease, services/renewalSuccessor);
 *   - common_area_reservations.fee_payment_id — kept on purpose: the
 *     reservation keeps pointing at its voided fee and is marked fee_voided
 *     (services/commonAreas);
 *   - credit_uses.payment_id — only a RELEASED use can be on a charge voided
 *     here (a live one holds it: chargeHeldByRecordSql), and it is left as
 *     it is, naming the charge it was once set against;
 *   - connect_disputes.payment_id — a dispute is on a paid charge, never on
 *     one still owed, so none can be on a row voided here.
 *   - utility_pay_link_settlements.payment_id — 10/20 (Nic): a utility bill
 *     collected on a pay link records which charge the collection took off the
 *     payer's invoice, and keeps naming it after the void, the way the common
 *     area's reservation does. The void itself happens THERE
 *     (services/utilityPayLink), because the money came in through a register
 *     sale and a settled charge would accrue the same income twice.
 */
import { AppError } from '../middleware/errorHandler'

type Q = (text: string, params?: any[]) => Promise<{ rows: any[] }>

const ALIAS = /^[a-z_][a-z0-9_]*$/i

/**
 * TRUE when another record points at the charge row `a` in a way the
 * database refused to DELETE it for: a foreign key into payments with no ON
 * DELETE action (or RESTRICT), or account credit still on it (held or applied
 * — trg_payments_keep_rows_with_live_credit). The foreign keys that SET NULL
 * on a delete (a utility bill, a released credit use, a reservation's fee, a
 * home-sale installment, a dispute) never stopped one and are not here.
 *
 * One list for every caller. chargeVoids.test.ts reads the live schema and
 * fails when a foreign key into payments is added without it.
 */
export function chargeHeldByRecordSql(a = 'p'): string {
  if (!ALIAS.test(a)) throw new Error(`chargeHeldByRecordSql: "${a}" is not a table alias`)
  return `(EXISTS (SELECT 1 FROM ach_monitoring_log x WHERE x.payment_id = ${a}.id)
      OR EXISTS (SELECT 1 FROM bank_deposit_allocations x WHERE x.payment_id = ${a}.id)
      OR EXISTS (SELECT 1 FROM bank_transactions x WHERE x.matched_payment_id = ${a}.id)
      OR EXISTS (SELECT 1 FROM deposit_returns x WHERE x.gap_payment_id = ${a}.id OR x.refund_payment_id = ${a}.id)
      OR EXISTS (SELECT 1 FROM flex_charge_statements x WHERE x.payment_id = ${a}.id)
      OR EXISTS (SELECT 1 FROM flex_deposit_custody_charges x WHERE x.payment_id = ${a}.id)
      OR EXISTS (SELECT 1 FROM flex_deposit_installments x WHERE x.payment_id = ${a}.id)
      OR EXISTS (SELECT 1 FROM flexpay_advances x WHERE x.fee_payment_id = ${a}.id OR x.rent_payment_id = ${a}.id)
      OR EXISTS (SELECT 1 FROM lease_prepaid_credit_draws x WHERE x.payment_id = ${a}.id)
      OR EXISTS (SELECT 1 FROM lease_prepaid_credits x WHERE x.source_payment_id = ${a}.id)
      OR EXISTS (SELECT 1 FROM lease_termination_requests x WHERE x.fee_payment_id = ${a}.id)
      OR EXISTS (SELECT 1 FROM otp_advances x WHERE x.advance_payment_id = ${a}.id OR x.reconciled_with_payment_id = ${a}.id)
      OR EXISTS (SELECT 1 FROM payment_reversals x WHERE x.payment_id = ${a}.id)
      OR EXISTS (SELECT 1 FROM propane_fill_installments x WHERE x.payment_id = ${a}.id)
      OR EXISTS (SELECT 1 FROM remittance_applications x WHERE x.payment_id = ${a}.id)
      OR EXISTS (SELECT 1 FROM stay_refund_parts x WHERE x.deposit_payment_id = ${a}.id)
      OR EXISTS (SELECT 1 FROM tenant_one_off_charges x WHERE x.payment_id = ${a}.id)
      OR EXISTS (SELECT 1 FROM credit_uses x WHERE x.payment_id = ${a}.id AND x.status <> 'released'))`
}

/** A charge row voided by voidUnowedCharges. */
export interface VoidedCharge {
  id: string
  invoiceId: string | null
  type: string
  amount: number
}

/**
 * Void the charge rows `ids` that are still owed and that no record points at
 * (see the header), inside the caller's transaction, stamped with `reason`.
 * The caller holds the household lock. Returns the rows voided and the ids it
 * left alone because a record points at them (`held`) — the rows a DELETE
 * would have been refused on. An id already settled, voided or gone is in
 * neither list, as a DELETE guarded by status would have skipped it.
 */
export async function voidUnowedCharges(
  q: Q, ids: readonly string[], reason: string,
  opts: { keepInstallmentLink?: boolean } = {},
): Promise<{ voided: VoidedCharge[]; held: string[] }> {
  if (!reason.trim()) throw new Error('voidUnowedCharges: a void needs its reason')
  const unique = [...new Set(ids.filter(Boolean))]
  if (unique.length === 0) return { voided: [], held: [] }
  // Read under the rows' locks, so the split below is the one the UPDATE sees.
  const rows = (await q(
    `SELECT p.id, ${chargeHeldByRecordSql('p')} AS held
       FROM payments p
      WHERE p.id = ANY($1::uuid[]) AND p.status IN ('pending', 'failed')
      ORDER BY p.id
      FOR UPDATE OF p`, [unique])).rows as Array<{ id: string; held: boolean }>
  const held = rows.filter(r => r.held).map(r => r.id)
  const free = rows.filter(r => !r.held).map(r => r.id)
  if (free.length === 0) return { voided: [], held }
  const voided = (await q(
    `UPDATE payments
        SET status = 'voided', voided_at = NOW(), void_reason = $2,
            next_retry_at = NULL, work_trade_suspended_at = NULL
      WHERE id = ANY($1::uuid[]) AND status IN ('pending', 'failed')
      RETURNING id, invoice_id, type, amount::text AS amount`, [free, reason])).rows
  // 10/12 (ledger P2 review): a home-sale payment releases its installment —
  // unbilled again, and its unique slot on payments given up (see the header).
  const ids2 = voided.map((r: any) => r.id)
  if (ids2.length > 0) {
    await q(`UPDATE home_sale_installments SET payment_id = NULL WHERE payment_id = ANY($1::uuid[])`, [ids2])
    if (!opts.keepInstallmentLink) {
      await q(
        `UPDATE payments SET home_sale_installment_id = NULL
          WHERE id = ANY($1::uuid[]) AND home_sale_installment_id IS NOT NULL`, [ids2])
    }
  }
  return {
    voided: voided
      .map((r: any) => ({ id: r.id, invoiceId: r.invoice_id ?? null, type: r.type, amount: Number(r.amount) }))
      .sort((x, y) => x.id.localeCompare(y.id)),
    held,
  }
}

/**
 * For a path where a charge a record points at stopped the whole change
 * before (the DELETE raised and the transaction rolled back): refuse it the
 * same way, in plain words. `refusal` is the sentence the person is shown.
 *
 * 10/12 (ledger P2 review): decided on the LOCKED read (voidUnowedCharges
 * reads under the rows' locks). An unlocked check first could pass, then a
 * record (a receipt application, a bank match) commit before the locks were
 * taken, and the held charge was left owed while the caller went on — a lease
 * voided with an owed line on its void bill. The refusal throws inside the
 * caller's transaction, which rolls back whatever was voided, exactly as the
 * DELETE's error did.
 */
export async function voidUnowedChargesOrRefuse(
  q: Q, ids: readonly string[], reason: string, refusal: string,
  opts: { keepInstallmentLink?: boolean } = {},
): Promise<VoidedCharge[]> {
  const unique = [...new Set(ids.filter(Boolean))]
  if (unique.length === 0) return []
  const r = await voidUnowedCharges(q, unique, reason, opts)
  if (r.held.length > 0) throw new AppError(409, refusal)
  return r.voided
}
