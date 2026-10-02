/**
 * S648 (Nic, DIRECTIVE) — page 8 is the move-in invoice, and the system keeps
 * it honest.
 *
 *   "First month's rent and proration... should be changeable [for new
 *    tenants]... the total should still calculate everything from those and
 *    not be typable." "Page eight security deposit copies page two so they
 *    can't disagree." Onboarding residents: already paid — $0.
 *
 * Restamps a document's computed page 8 boxes from its own values:
 *   - move_in_security_deposit ← page 2 deposit (new tenant) / $0 (onboarding)
 *   - onboarding only: first month ← the monthly rent, proration ← $0, and
 *     every move-in fee box ← $0 (Clay Simpson and Martin Alvarado were billed
 *     page 2's rent while page 8 said something else; for an existing
 *     resident the two cannot differ)
 *   - move_in_total_due ← the sum of everything the move-in invoice bills
 *
 * RENEWAL (Nic: "people get billed on their due date according to how the
 * landlord sets the property"). A renewal is not a move-in: its rent continues
 * on the household's own due dates, billed by the nightly run, so page 8 bills
 * NO rent — first month and proration are $0 and locked. Its deposit line is
 * only what rises above the deposit the old lease already holds (the S534
 * top-up the build bills), and each deposit-type box likewise; a fee box bills
 * as typed. The total is the one-time bill the renewal actually sends.
 *
 * Runs when a lease is drafted and again when the landlord signs, on the
 * caller's connection so it sees the values just written. Only unsigned
 * computed boxes are touched — nothing a signature already sits over changes —
 * except the computed boxes themselves (the deposit copy, the total, and on a
 * renewal the $0 rent lines), which are the system's to keep honest.
 */
import {
  FEE_TYPES, FEE_TYPE_META, moveInDepositMirror, moveInTotalDue, moneyBoxValue, defaultMoneyKind,
  type FeeType,
} from '@gam/shared'

type Exec = { query: (sql: string, params: any[]) => Promise<{ rows: any[] }> }

const MOVE_IN_FEE_TAGS = FEE_TYPES.filter(t =>
  t !== 'security_deposit' && FEE_TYPE_META[t].dueTiming === 'move_in')

const money = (n: number) => n.toFixed(2)

export async function isExistingTenancyDocument(c: Exec, documentId: string): Promise<boolean> {
  const r = await c.query(
    `SELECT COALESCE(
        (SELECT l.is_existing_tenancy FROM leases l WHERE l.id = d.lease_id),
        (SELECT bool_or(COALESCE(i.is_existing_tenancy, false)) FROM pending_tenant_intents i
          WHERE i.unit_id = d.unit_id AND i.cancelled_at IS NULL
            AND (i.resolved_at IS NULL OR i.resolved_lease_id = d.lease_id)),
        false) AS existing
       FROM lease_documents d WHERE d.id = $1`, [documentId])
  return r.rows[0]?.existing === true
}

export async function restampMoveInBoxes(c: Exec, documentId: string): Promise<void> {
  const rows = (await c.query(
    `SELECT id, lease_column, value, signed_at FROM lease_document_fields
      WHERE document_id = $1 AND lease_column IS NOT NULL`, [documentId])).rows as Array<{
      id: string; lease_column: string; value: string | null; signed_at: string | null }>
  if (!rows.some(r => r.lease_column === 'move_in_total_due' || r.lease_column === 'move_in_security_deposit'
      || r.lease_column === 'move_in_first_month_rent')) return

  const first = (col: string) => rows.find(r => r.lease_column === col && r.value != null && r.value.trim() !== '')?.value ?? null
  const billed = await renewalBilledAmount(c, documentId)
  const renewal = billed !== null
  const existing = !renewal && await isExistingTenancyDocument(c, documentId)
  const computed = renewal
    ? ['move_in_security_deposit', 'move_in_total_due', 'move_in_first_month_rent', 'move_in_proration']
    : ['move_in_security_deposit', 'move_in_total_due']
  const set = async (col: string, value: string) => {
    await c.query(
      `UPDATE lease_document_fields SET value = $3
        WHERE document_id = $1 AND lease_column = $2
          AND (signed_at IS NULL OR lease_column = ANY($4::text[]))
          AND value IS DISTINCT FROM $3`,
      [documentId, col, value, computed])
    for (const r of rows) if (r.lease_column === col) r.value = value
  }

  if (renewal) {
    // The renewal's rent is billed on the household's due dates by the nightly
    // run — never on page 8.
    await set('move_in_first_month_rent', money(0))
    await set('move_in_proration', money(0))
    const deposit = billed('security_deposit', moneyBoxValue(first('security_deposit')))
    await set('move_in_security_deposit', money(deposit))
    const total = moveInTotalDue({
      firstMonthRent: 0, proration: 0, depositMirror: deposit,
      moveInFees: MOVE_IN_FEE_TAGS.filter(t => t !== 'other_fee').map(t => billed(t, moneyBoxValue(first(t)))),
    })
    await set('move_in_total_due', money(total))
    return
  }

  if (existing) {
    await set('move_in_first_month_rent', money(moneyBoxValue(first('rent_amount'))))
    await set('move_in_proration', money(0))
    for (const tag of MOVE_IN_FEE_TAGS) {
      if (tag === 'other_fee') continue
      if (rows.some(r => r.lease_column === tag)) await set(tag, money(0))
    }
  }

  const deposit = moveInDepositMirror(first('security_deposit'), existing)
  await set('move_in_security_deposit', money(deposit))

  const total = moveInTotalDue({
    firstMonthRent: first('move_in_first_month_rent'),
    proration: first('move_in_proration'),
    depositMirror: deposit,
    moveInFees: MOVE_IN_FEE_TAGS.filter(t => t !== 'other_fee').map(t => first(t)),
  })
  await set('move_in_total_due', money(total))
}

/**
 * What a move-in box bills on a RENEWAL, or null when the document is not one.
 *
 * Mirrors the build exactly (routes/esign.ts executeOriginalLease, S534): a
 * box tagged deposit or prepaid — refundable money the household may already
 * have paid on the old lease — bills only what rises above what the old lease
 * carries for that type, never below $0; a fee box bills as typed.
 */
export async function renewalBilledAmount(
  c: Exec, documentId: string,
): Promise<((tag: FeeType, amount: number) => number) | null> {
  const doc = (await c.query(
    `SELECT renews_lease_id, template_id FROM lease_documents WHERE id = $1`, [documentId])).rows[0]
  if (!doc?.renews_lease_id) return null
  const carried: Record<string, number> = {}
  for (const r of (await c.query(
    `SELECT fee_type, SUM(amount)::text AS total FROM lease_fees
      WHERE lease_id = $1 AND due_timing = 'move_in' AND is_refundable = TRUE
      GROUP BY fee_type`, [doc.renews_lease_id])).rows) carried[r.fee_type] = Number(r.total) || 0
  const kinds: Record<string, string> = {}
  if (doc.template_id) {
    for (const r of (await c.query(
      `SELECT lease_column, money_kind FROM lease_template_fields
        WHERE template_id = $1 AND money_kind IS NOT NULL AND lease_column IS NOT NULL`,
      [doc.template_id])).rows) kinds[r.lease_column] = r.money_kind
  }
  return (tag, amount) => (kinds[tag] ?? defaultMoneyKind(tag)) === 'fee'
    ? amount
    : Math.max(0, Math.round((amount - (carried[tag] ?? 0)) * 100) / 100)
}
