// 10/6 (Nic) — deleting a late fee outright, onboarding month only, at the
// landlord's discretion.
//
//   "Late fees are not automatically on time because of the onboarding month.
//    That's the landlord's discretion. This landlord does not want to give
//    grace past the grace period for late fees for tenants that are screwing
//    stuff up. So the late fee is only available to be completely deleted
//    during the onboarding month. Other than that, they get a credit against
//    their bill and the late payment still shows on their payment history."
//
// A late fee a bank deposit's date shows was never owed is CREDITED by itself
// (services/lateFeeCredit, from bankDepositConfirm.reverseLateFees): the fee
// stays, a credit nets it out, and the payment still counts late. It is
// deleted only when the landlord chooses to, and only on the onboarding bill:
//   - the box on Record payment / Post a payment ("Delete the late fee
//     completely (onboarding month)", off by default): the never-owed fee is
//     deleted outright as the deposit is recorded, with no credit at all;
//   - "Delete this late fee" on its line in the landlord's Payments history,
//     for an onboarding fee already credited (or zeroed by the code before
//     10/6): the fee AND the credit applied to it go — the credit is taken
//     back off it and withdrawn (services/lateFeeCredit.withdrawLateFeeCredit).
//
// Once no late fee is left on the bill, its rent's late mark is replaced by
// the mark from the deposit's date (creditLedgerEmitters.
// reRateMarksWithoutLateFee) — nothing shows on their record.
//
// THE ONBOARDING BILL is judged by the bill the fee belongs to: the rent on
// the same invoice, by the one onboarding-month rule
// (creditLedgerEmitters.isOnboardingMonthCharge). A late fee's own date is the
// day it was charged, often in the next month, so it is never judged by itself.
//
// WHO: the landlord's owner and their property managers — the same people who
// may issue a discretionary credit such as waiving a late fee (routes/
// tenantCredits: canManageLandlordResource(…, ['property_manager'])). Front-desk
// staff who take payments may not (S641, Nic: "She cannot just issue random
// credits that a landlord would issue for, you know, waiving a late fee."),
// and neither may GAM staff — it is the landlord's choice.
//
// WHAT GOES: the payments row, and with it everything that exists only because
// of it — the invoice's late-fee subtotal, its status and the unit's
// delinquency are rolled up again by the payments triggers. Nothing else that
// records money may point at it: a receipt, a bank match, other credit, a
// dispute or return, any instrument row (every foreign key to payments.id in
// db/schema.sql). If one does, the delete is refused in plain words, the fee
// stays credited, and why is logged.
//
// WHAT IS KEPT: the full row as it was, in audit_log (action
// 'late_fee_deleted', on the INVOICE, so the late-fee engine and Undo find it
// by an indexed lookup), with the credit taken back off it; the credit use
// itself (released, kept forever) and the withdrawn credit; and an audit line
// in the API log (who, when, the row). The engine never charges that day again
// (deletedLateFeeDates), and an Undo of the bank match that credited it puts
// it back exactly, same id (restoreDeletedLateFees).

import type { PoolClient } from 'pg'
import type { AuthPayload } from '../middleware/auth'
import { canManageLandlordResource } from '../middleware/scope'
import { isOnboardingMonthCharge, reRateMarksWithoutLateFee } from './creditLedgerEmitters'
import { isCreditedLateFee, withdrawLateFeeCredit } from './lateFeeCredit'
import { logger } from '../lib/logger'

type Q = Pick<PoolClient, 'query'>

/** The note reverseLateFees wrote on a late fee it zeroed, before 10/6 (a fee is credited now: lateFeeCredit.CREDITED_LATE_FEE_NOTE). */
export const REVERSED_LATE_FEE_NOTE = 'Reversed: rent was paid '

/** Besides the owner: the team roles that may delete a late fee (never GAM admin — canDeleteLateFees). */
export const LATE_FEE_DELETE_TEAM_ROLES: readonly string[] = ['property_manager']

export const LATE_FEE_DELETE_NOT_ALLOWED =
  'Only the owner or a property manager can delete a late fee. Leave the box unchecked and the late fee is credited instead — it still counts as a late payment on their history.'

/**
 * May this person delete a late fee of this landlord's? The landlord's own
 * owner and property managers only. 10/6 (Nic): "the late fee is only deleted
 * during onboarding at landlord's discretion" — the landlord's choice, so GAM
 * staff (admin, super_admin) are refused here, though canManageLandlordResource
 * lets them through for other things.
 */
export function canDeleteLateFees(user: AuthPayload | undefined, landlordId: string | null | undefined): boolean {
  if (!user || user.role === 'admin' || user.role === 'super_admin') return false
  return canManageLandlordResource(user, landlordId, LATE_FEE_DELETE_TEAM_ROLES)
}

/** The audit_log action a delete writes (on entity_type 'invoice'), and the one a restore writes. */
export const LATE_FEE_DELETED_ACTION = 'late_fee_deleted'
export const LATE_FEE_RESTORED_ACTION = 'late_fee_restored'

/**
 * Is this bill the household's onboarding bill? The rent on it, by the one
 * onboarding-month rule (creditLedgerEmitters.isOnboardingMonthCharge).
 */
export async function isOnboardingBill(client: Q, invoiceId: string | null | undefined): Promise<boolean> {
  if (!invoiceId) return false
  const rents = (await client.query<{ id: string }>(
    `SELECT id FROM payments WHERE invoice_id = $1 AND type = 'rent' AND lease_id IS NOT NULL ORDER BY id`,
    [invoiceId])).rows
  for (const r of rents) if (await isOnboardingMonthCharge(client, r.id)) return true
  return false
}

/**
 * Everything that records money against a payments row (each foreign key to
 * payments.id in db/schema.sql). A released credit use is not money (its
 * target is cleared when its row is removed — chargeDeleteGuard).
 */
const MONEY_REFERENCES: ReadonlyArray<{ what: string; sql: string }> = [
  { what: 'a receipt applied to it', sql: `SELECT 1 FROM remittance_applications WHERE payment_id = $1` },
  { what: 'a bank deposit paid it', sql: `SELECT 1 FROM bank_deposit_allocations WHERE payment_id = $1` },
  { what: 'a bank deposit is matched to it', sql: `SELECT 1 FROM bank_transactions WHERE matched_payment_id = $1` },
  // Its own late-fee credit is not in the way: it is taken back with the fee.
  { what: 'account credit is on it', sql: `SELECT 1 FROM credit_uses WHERE payment_id = $1 AND status <> 'released' AND source <> 'late_fee_credit'` },
  { what: 'paid-ahead money paid it', sql: `SELECT 1 FROM lease_prepaid_credit_draws WHERE payment_id = $1` },
  { what: 'paid-ahead money came from it', sql: `SELECT 1 FROM lease_prepaid_credits WHERE source_payment_id = $1` },
  { what: 'a dispute or bank return is on it', sql: `SELECT 1 FROM payment_reversals WHERE payment_id = $1` },
  { what: 'a card dispute is on it', sql: `SELECT 1 FROM connect_disputes WHERE payment_id = $1` },
  { what: 'a bank payment was watched on it', sql: `SELECT 1 FROM ach_monitoring_log WHERE payment_id = $1` },
  { what: 'a deposit return points at it', sql: `SELECT 1 FROM deposit_returns WHERE gap_payment_id = $1 OR refund_payment_id = $1` },
  { what: 'a stay refund points at it', sql: `SELECT 1 FROM stay_refund_parts WHERE deposit_payment_id = $1 OR stay_payment_id = $1` },
  { what: 'a charge record points at it', sql: `SELECT 1 FROM tenant_one_off_charges WHERE payment_id = $1` },
  { what: 'a utility bill points at it', sql: `SELECT 1 FROM utility_bills WHERE payment_id = $1` },
  { what: 'a reservation points at it', sql: `SELECT 1 FROM common_area_reservations WHERE fee_payment_id = $1` },
  { what: 'a lease ending points at it', sql: `SELECT 1 FROM lease_termination_requests WHERE fee_payment_id = $1` },
  { what: 'a home payment points at it', sql: `SELECT 1 FROM home_sale_installments WHERE payment_id = $1` },
  { what: 'a propane plan points at it', sql: `SELECT 1 FROM propane_fill_installments WHERE payment_id = $1` },
  {
    what: 'a GAM product points at it',
    sql: `SELECT 1 FROM flex_charge_statements WHERE payment_id = $1
          UNION ALL SELECT 1 FROM flex_deposit_custody_charges WHERE payment_id = $1
          UNION ALL SELECT 1 FROM flex_deposit_installments WHERE payment_id = $1
          UNION ALL SELECT 1 FROM flexcredit_charges WHERE payment_id = $1
          UNION ALL SELECT 1 FROM flexpay_advances WHERE fee_payment_id = $1 OR rent_payment_id = $1
          UNION ALL SELECT 1 FROM otp_advances WHERE advance_payment_id = $1 OR reconciled_with_payment_id = $1`,
  },
]

/** What records money against this row (plain words), or [] when nothing does. */
async function moneyReferences(client: Q, paymentId: string): Promise<string[]> {
  const out: string[] = []
  for (const r of MONEY_REFERENCES) {
    if (((await client.query(`SELECT EXISTS (${r.sql}) AS x`, [paymentId])).rows[0] as { x: boolean }).x) out.push(r.what)
  }
  return out
}

interface FeeRow {
  id: string; type: string; amount: string; status: string; notes: string | null
  invoice_id: string | null; landlord_id: string; tenant_id: string | null
  stripe_payment_intent_id: string | null; row: Record<string, unknown>
}

export type LateFeeDeleteRefusal = 'not_found' | 'not_late_fee' | 'not_credited' | 'not_onboarding' | 'money'

export const LATE_FEE_DELETE_REFUSAL_TEXT: Record<LateFeeDeleteRefusal, string> = {
  not_found: 'That late fee is no longer there.',
  not_late_fee: 'Only a late fee can be deleted this way.',
  not_credited: 'Only a late fee that was credited because the rent was already in the bank can be deleted.',
  not_onboarding: 'A late fee can be deleted only on the onboarding month\'s bill. This one stays credited — it no longer counts toward what they owe, and it still counts as a late payment on their history.',
  money: 'Money is recorded against this late fee, so it can\'t be deleted. It stays credited — it no longer counts toward what they owe, and it still counts as a late payment on their history.',
}

/** Which kind of never-owed late fee this is (null: none a landlord may delete). */
type DeletableKind = 'credited' | 'zeroed' | 'never_owed'

async function kindOf(client: Q, fee: FeeRow, neverOwed: boolean): Promise<DeletableKind | null> {
  // Credited by a reversal (10/6): charged, netted out by its own late-fee credit.
  if (await isCreditedLateFee(client, fee)) return 'credited'
  // Zeroed by a reversal before 10/6: $0, settled by the reversal, with its note.
  if (Number(fee.amount) === 0 && fee.status === 'settled' && (fee.notes ?? '').includes(REVERSED_LATE_FEE_NOTE)) return 'zeroed'
  // The box: a fee the deposit being recorded shows was never owed, still unpaid.
  if (neverOwed && Number(fee.amount) > 0 && !fee.stripe_payment_intent_id
      && (fee.status === 'pending' || fee.status === 'failed')) return 'never_owed'
  return null
}

/** Why this late fee may not be deleted (or, when it may, which kind it is), with what records money against it. */
async function refusalFor(
  client: Q, fee: FeeRow | undefined, neverOwed = false,
): Promise<{ code: LateFeeDeleteRefusal; money?: string[] } | { kind: DeletableKind }> {
  if (!fee) return { code: 'not_found' }
  if (fee.type !== 'late_fee') return { code: 'not_late_fee' }
  const kind = await kindOf(client, fee, neverOwed)
  if (!kind) return { code: 'not_credited' }
  if (!(await isOnboardingBill(client, fee.invoice_id))) return { code: 'not_onboarding' }
  const money = await moneyReferences(client, fee.id)
  if (fee.stripe_payment_intent_id) money.unshift('a card or bank payment was made on it')
  if (money.length > 0) return { code: 'money', money }
  return { kind }
}

const FEE_SELECT = `
  SELECT p.id, p.type, p.amount::text AS amount, p.status, p.notes, p.invoice_id, p.landlord_id, p.tenant_id,
         p.stripe_payment_intent_id, to_jsonb(p) AS row
    FROM payments p`

/** The credited (or, from before 10/6, zeroed) late fees among these that may be deleted — for the Payments history line. Read-only. */
export async function deletableLateFeeIds(client: Q, paymentIds: readonly string[]): Promise<Set<string>> {
  const ids = [...new Set(paymentIds)]
  if (ids.length === 0) return new Set()
  const rows = (await client.query<FeeRow>(
    `${FEE_SELECT} WHERE p.id = ANY($1::uuid[]) AND p.type = 'late_fee' AND p.status = 'settled'
     ORDER BY p.id`, [ids])).rows
  const ok = new Set<string>()
  for (const r of rows) if ('kind' in (await refusalFor(client, r))) ok.add(r.id)
  return ok
}

export interface LateFeeDeleteResult {
  deleted: boolean
  /** Why not (when not deleted). */
  refusal: LateFeeDeleteRefusal | null
  /** The refusal said plainly (null when deleted). */
  message: string | null
  invoiceId: string | null
  tenantId: string | null
  landlordId: string | null
  /** The late-fee credit taken back off it and withdrawn with it (dollars; 0 when it had none). */
  creditWithdrawn: number
  /**
   * Credit subjects whose payment marks were re-rated because no late fee is
   * left on the bill (creditLedgerEmitters.reRateMarksWithoutLateFee) — the
   * caller recomputes their scores after its commit.
   */
  reRatedSubjects: string[]
  /**
   * Another late fee is still on the bill after this one went (charged and
   * not voided — the test settleHooks marks by), so its payment still counts
   * late: "nothing shows on their record" would be false.
   */
  lateFeeLeftOnBill: boolean
}

/**
 * Delete a never-owed late fee on an onboarding bill, inside the caller's
 * transaction (the caller holds the household lock and has checked who may:
 * canDeleteLateFees). Three kinds may go: one a reversal credited (its credit
 * is taken back and withdrawn first), one zeroed before 10/6, and — with
 * `neverOwedSince`, from the reversal itself (the box) — an unpaid fee the
 * deposit being recorded shows was never owed. Refused in plain words
 * otherwise — nothing changes then; a refusal for money recorded against it is
 * logged. When no late fee is left on the bill, its payment marks are re-rated
 * from the deposit's date.
 */
export async function deleteLateFee(
  client: PoolClient,
  paymentId: string,
  o: {
    deletedBy: string | null
    /** Where the landlord chose it: the Record payment / Post a payment box, or the history line. */
    via: 'record_payment' | 'post_payment' | 'history_line'
    /** The box: the day the deposit being recorded was made (the fee is unpaid and was never owed). */
    neverOwedSince?: string | null
  },
): Promise<LateFeeDeleteResult> {
  const fee = (await client.query<FeeRow>(`${FEE_SELECT} WHERE p.id = $1 FOR UPDATE OF p`, [paymentId])).rows[0]
  const verdict = await refusalFor(client, fee, !!o.neverOwedSince)
  const base = {
    invoiceId: fee?.invoice_id ?? null, tenantId: fee?.tenant_id ?? null, landlordId: fee?.landlord_id ?? null,
    creditWithdrawn: 0, reRatedSubjects: [] as string[], lateFeeLeftOnBill: false,
  }
  if (!('kind' in verdict)) {
    if (verdict.code === 'money') {
      logger.warn({ paymentId, deletedBy: o.deletedBy, via: o.via, money: verdict.money },
        '[late-fee-delete] refused: money is recorded against this late fee; it stays credited')
    }
    return { ...base, deleted: false, refusal: verdict.code, message: LATE_FEE_DELETE_REFUSAL_TEXT[verdict.code] }
  }
  // Its own late-fee credit comes off first (released and withdrawn — both
  // kept), so the row as kept in the audit log is the fee as charged, unpaid
  // by any credit, and an Undo that puts it back finds it that way.
  const withdrawn = verdict.kind === 'credited'
    ? await withdrawLateFeeCredit(client, paymentId)
    : { useIds: [] as string[], creditIds: [] as string[], amount: 0 }
  const row = verdict.kind === 'credited'
    ? (await client.query<{ row: Record<string, unknown> }>(`SELECT to_jsonb(p) AS row FROM payments p WHERE p.id = $1`, [paymentId])).rows[0].row
    : fee!.row
  const at = new Date().toISOString()
  const record = {
    paymentId, via: o.via, deletedAt: at, kind: verdict.kind,
    neverOwedSince: o.neverOwedSince ?? null,
    creditWithdrawn: verdict.kind === 'credited'
      ? { amount: withdrawn.amount, useIds: withdrawn.useIds, creditIds: withdrawn.creditIds } : null,
  }
  await client.query(
    `INSERT INTO audit_log (user_id, action, entity_type, entity_id, old_value, new_value)
     VALUES ($1, $2, 'invoice', $3, $4::jsonb, $5::jsonb)`,
    [o.deletedBy, LATE_FEE_DELETED_ACTION, fee!.invoice_id, JSON.stringify(row), JSON.stringify(record)])
  const d = await client.query(`DELETE FROM payments WHERE id = $1`, [paymentId])
  if ((d.rowCount ?? 0) !== 1) {
    // Locked above; cannot happen. Never leave an audit line for a row still there.
    throw new Error(`late fee ${paymentId} could not be deleted`)
  }
  logger.info({ audit: LATE_FEE_DELETED_ACTION, paymentId, deletedBy: o.deletedBy, deletedAt: at, via: o.via, row, record },
    '[late-fee-delete] onboarding late fee deleted at the landlord\'s choice')
  const reRatedSubjects = fee!.invoice_id ? await reRateMarksWithoutLateFee(client, fee!.invoice_id) : []
  const lateFeeLeftOnBill = !!fee!.invoice_id && ((await client.query<{ x: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM payments f WHERE f.invoice_id = $1 AND f.type = 'late_fee'
                       AND f.amount > 0 AND f.status <> 'voided') AS x`, [fee!.invoice_id])).rows[0]?.x ?? false)
  return {
    ...base, deleted: true, refusal: null, message: null, creditWithdrawn: withdrawn.amount, reRatedSubjects, lateFeeLeftOnBill,
  }
}

/**
 * The days of late fees deleted from this bill — the late-fee engine treats
 * each as already charged (a deleted fee is never charged again, just as a
 * zeroed one is not). audit_log rows older than 24 months move to
 * audit_log_archive (jobs/complianceArchive), so a bill that old is read there too.
 */
export async function deletedLateFeeDates(client: Q, invoiceId: string, invoiceDueDate?: string | null): Promise<string[]> {
  const old = invoiceDueDate != null && Date.parse(`${invoiceDueDate}T00:00:00Z`) < Date.now() - 700 * 86_400_000
  const r = await client.query<{ d: string }>(
    `SELECT DISTINCT d FROM (
       SELECT old_value->>'due_date' AS d FROM audit_log
        WHERE entity_type = 'invoice' AND entity_id = $1 AND action = $2
       ${old ? `UNION ALL
       SELECT old_value->>'due_date' AS d FROM audit_log_archive
        WHERE entity_type = 'invoice' AND entity_id = $1 AND action = $2` : ''}
     ) x WHERE d IS NOT NULL ORDER BY d`,
    [invoiceId, LATE_FEE_DELETED_ACTION])
  return r.rows.map(x => x.d.slice(0, 10))
}

/**
 * Put deleted late fees back exactly as they were deleted (same id, every
 * column), inside the caller's transaction — an Undo of the bank match that
 * zeroed or credited them (bankDepositConfirm.undoDepositMatch), which then
 * makes each owed again as it does for any fee the match took off (a credited
 * fee's credit was already taken back and withdrawn by the delete). Only fees
 * not already there. Returns the ids put back.
 */
export async function restoreDeletedLateFees(
  client: PoolClient,
  o: { paymentIds: readonly string[]; invoiceIds: readonly string[]; restoredBy: string | null },
): Promise<string[]> {
  const ids = [...new Set(o.paymentIds)]
  if (ids.length === 0) return []
  const present = new Set((await client.query<{ id: string }>(
    `SELECT id FROM payments WHERE id = ANY($1::uuid[])`, [ids])).rows.map(r => r.id))
  const missing = ids.filter(id => !present.has(id))
  if (missing.length === 0) return []
  const invoices = [...new Set(o.invoiceIds.filter(Boolean))]
  const find = (byInvoice: boolean) => client.query<{ id: string; row: Record<string, unknown>; invoice_id: string | null }>(
    `SELECT DISTINCT ON (old_value->>'id') old_value->>'id' AS id, old_value AS row, entity_id AS invoice_id
       FROM audit_log
      WHERE entity_type = 'invoice' AND action = $1 AND old_value->>'id' = ANY($2::text[])
        ${byInvoice ? 'AND entity_id = ANY($3::uuid[])' : ''}
      ORDER BY old_value->>'id', created_at DESC`,
    byInvoice ? [LATE_FEE_DELETED_ACTION, missing, invoices] : [LATE_FEE_DELETED_ACTION, missing])
  const found = new Map((await find(invoices.length > 0)).rows.map(r => [r.id, r]))
  if (found.size < missing.length) {
    // A fee whose bill was not among the ones named: looked up by its id alone (rare).
    for (const r of (await find(false)).rows) if (!found.has(r.id)) found.set(r.id, r)
  }
  const restored: string[] = []
  for (const id of missing) {
    const f = found.get(id)
    if (!f) continue
    await client.query(
      `INSERT INTO payments SELECT * FROM jsonb_populate_record(NULL::payments, $1::jsonb)`, [JSON.stringify(f.row)])
    await client.query(
      `INSERT INTO audit_log (user_id, action, entity_type, entity_id, new_value)
       VALUES ($1, $2, 'invoice', $3, $4::jsonb)`,
      [o.restoredBy, LATE_FEE_RESTORED_ACTION, f.invoice_id, JSON.stringify({ paymentId: id, restoredAt: new Date().toISOString() })])
    logger.info({ audit: LATE_FEE_RESTORED_ACTION, paymentId: id, restoredBy: o.restoredBy, row: f.row },
      '[late-fee-delete] deleted late fee put back by an undo')
    restored.push(id)
  }
  return restored
}
