// 10/6 (Nic) — deleting a late fee outright, onboarding month only, at the
// landlord's discretion.
//
//   "I want to completely remove the late fees from the database to preserve
//    these people's payment history at a hundred percent" — then: "any late
//    fees that should not be charged after onboarding that happen just get
//    zero not delete. this is just for onboarding" — and: "the late fee is
//    only deleted during onboarding at landlord's discretion."
//
// So a late fee is NEVER deleted by itself. It is zeroed first, exactly as
// today (bankDepositConfirm.reverseLateFees: a fee charged for days after the
// money was already in the bank was never owed), and only then, when a
// landlord chooses to, deleted:
//   - the box on Record payment / Post a payment ("Delete the late fee
//     completely (onboarding month)", off by default), for a fee that
//     recording takes off an onboarding bill;
//   - "Delete this late fee" on its line in the landlord's Payments history,
//     for a fee a reversal already zeroed on an onboarding bill (that covers
//     the ones zeroed before this shipped — there is no cleanup script).
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
// credits that a landlord would issue for, you know, waiving a late fee.").
//
// WHAT GOES: the payments row, and with it everything that exists only because
// of it — the invoice's late-fee subtotal, its status and the unit's
// delinquency are rolled up again by the payments triggers, exactly as
// zeroing does. Nothing that records money may point at it: a receipt, a bank
// match, credit, a dispute or return, any instrument row (every foreign key to
// payments.id in db/schema.sql). If one does, the delete is refused in plain
// words, the fee stays zeroed, and why is logged.
//
// WHAT IS KEPT: the full row as it was, in audit_log (action
// 'late_fee_deleted', on the INVOICE, so the late-fee engine and Undo find it
// by an indexed lookup), and an audit line in the API log (who, when, the
// row). The engine never charges that day again (deletedLateFeeDates), and an
// Undo of the bank match that zeroed it puts it back exactly, same id
// (restoreDeletedLateFees). A delete never touches a payment-history mark: the
// rent's own mark is what it was (the onboarding month is positive-only).

import type { PoolClient } from 'pg'
import type { AuthPayload } from '../middleware/auth'
import { canManageLandlordResource } from '../middleware/scope'
import { isOnboardingMonthCharge } from './creditLedgerEmitters'
import { logger } from '../lib/logger'

type Q = Pick<PoolClient, 'query'>

/** The note reverseLateFees writes on a late fee it zeroed (bankDepositConfirm). */
export const REVERSED_LATE_FEE_NOTE = 'Reversed: rent was paid '

/** Besides the owner: the team roles that may delete a late fee (never GAM admin — canDeleteLateFees). */
export const LATE_FEE_DELETE_TEAM_ROLES: readonly string[] = ['property_manager']

export const LATE_FEE_DELETE_NOT_ALLOWED =
  'Only the owner or a property manager can delete a late fee. Leave the box unchecked and the late fee still comes off — it shows $0.00.'

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
  { what: 'account credit is on it', sql: `SELECT 1 FROM credit_uses WHERE payment_id = $1 AND status <> 'released'` },
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

export type LateFeeDeleteRefusal = 'not_found' | 'not_late_fee' | 'not_zeroed' | 'not_onboarding' | 'money'

export const LATE_FEE_DELETE_REFUSAL_TEXT: Record<LateFeeDeleteRefusal, string> = {
  not_found: 'That late fee is no longer there.',
  not_late_fee: 'Only a late fee can be deleted this way.',
  not_zeroed: 'Only a late fee that already came off (it shows $0.00) can be deleted.',
  not_onboarding: 'A late fee can be deleted only on the onboarding month\'s bill. This one stays at $0.00 — it no longer counts toward what they owe.',
  money: 'Money is recorded against this late fee, so it can\'t be deleted. It stays at $0.00 — it no longer counts toward what they owe.',
}

/** Why this late fee may not be deleted (null: it may), with what records money against it. */
async function refusalFor(client: Q, fee: FeeRow | undefined): Promise<{ code: LateFeeDeleteRefusal; money?: string[] } | null> {
  if (!fee) return { code: 'not_found' }
  if (fee.type !== 'late_fee') return { code: 'not_late_fee' }
  // Zeroed by a reversal: $0, settled by the reversal, with its note.
  if (Number(fee.amount) !== 0 || fee.status !== 'settled' || !(fee.notes ?? '').includes(REVERSED_LATE_FEE_NOTE)) {
    return { code: 'not_zeroed' }
  }
  if (!(await isOnboardingBill(client, fee.invoice_id))) return { code: 'not_onboarding' }
  const money = await moneyReferences(client, fee.id)
  if (fee.stripe_payment_intent_id) money.unshift('a card or bank payment was made on it')
  if (money.length > 0) return { code: 'money', money }
  return null
}

const FEE_SELECT = `
  SELECT p.id, p.type, p.amount::text AS amount, p.status, p.notes, p.invoice_id, p.landlord_id, p.tenant_id,
         p.stripe_payment_intent_id, to_jsonb(p) AS row
    FROM payments p`

/** The zeroed late fees among these that may be deleted (for the Payments history line). Read-only. */
export async function deletableLateFeeIds(client: Q, paymentIds: readonly string[]): Promise<Set<string>> {
  const ids = [...new Set(paymentIds)]
  if (ids.length === 0) return new Set()
  const rows = (await client.query<FeeRow>(
    `${FEE_SELECT} WHERE p.id = ANY($1::uuid[]) AND p.type = 'late_fee' AND p.amount = 0 AND p.status = 'settled'
       AND p.notes LIKE '%' || $2 || '%'
     ORDER BY p.id`, [ids, REVERSED_LATE_FEE_NOTE])).rows
  const ok = new Set<string>()
  for (const r of rows) if (!(await refusalFor(client, r))) ok.add(r.id)
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
}

/**
 * Delete a late fee a reversal already zeroed, on an onboarding bill, inside
 * the caller's transaction (the caller holds the household lock and has
 * checked who may: canDeleteLateFees). Refused in plain words otherwise —
 * nothing changes then; a refusal for money recorded against it is logged.
 */
export async function deleteZeroedLateFee(
  client: PoolClient,
  paymentId: string,
  o: {
    deletedBy: string | null
    /** Where the landlord chose it: the Record payment / Post a payment box, or the history line. */
    via: 'record_payment' | 'post_payment' | 'history_line'
    /** The fee as it was before this recording zeroed it (the box), for the record. */
    beforeZeroing?: { amount: number; status: string; notes: string | null } | null
  },
): Promise<LateFeeDeleteResult> {
  const fee = (await client.query<FeeRow>(`${FEE_SELECT} WHERE p.id = $1 FOR UPDATE OF p`, [paymentId])).rows[0]
  const refusal = await refusalFor(client, fee)
  const base = { invoiceId: fee?.invoice_id ?? null, tenantId: fee?.tenant_id ?? null, landlordId: fee?.landlord_id ?? null }
  if (refusal) {
    if (refusal.code === 'money') {
      logger.warn({ paymentId, deletedBy: o.deletedBy, via: o.via, money: refusal.money },
        '[late-fee-delete] refused: money is recorded against this late fee; it stays zeroed')
    }
    return { ...base, deleted: false, refusal: refusal.code, message: LATE_FEE_DELETE_REFUSAL_TEXT[refusal.code] }
  }
  const at = new Date().toISOString()
  await client.query(
    `INSERT INTO audit_log (user_id, action, entity_type, entity_id, old_value, new_value)
     VALUES ($1, $2, 'invoice', $3, $4::jsonb, $5::jsonb)`,
    [o.deletedBy, LATE_FEE_DELETED_ACTION, fee!.invoice_id, JSON.stringify(fee!.row),
     JSON.stringify({ paymentId, via: o.via, deletedAt: at, beforeZeroing: o.beforeZeroing ?? null })])
  const d = await client.query(`DELETE FROM payments WHERE id = $1`, [paymentId])
  if ((d.rowCount ?? 0) !== 1) {
    // Locked above; cannot happen. Never leave an audit line for a row still there.
    throw new Error(`late fee ${paymentId} could not be deleted`)
  }
  logger.info({ audit: LATE_FEE_DELETED_ACTION, paymentId, deletedBy: o.deletedBy, deletedAt: at, via: o.via, row: fee!.row,
    beforeZeroing: o.beforeZeroing ?? null }, '[late-fee-delete] onboarding late fee deleted at the landlord\'s choice')
  return { ...base, deleted: true, refusal: null, message: null }
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
 * zeroed them (bankDepositConfirm.undoDepositMatch), which then restores
 * their amount as it does for any zeroed fee. Only fees not already there.
 * Returns the ids put back.
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
