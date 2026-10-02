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
 * Runs when a lease is drafted and again when the landlord signs, on the
 * caller's connection so it sees the values just written. Only unsigned
 * computed boxes are touched — nothing a signature already sits over changes.
 */
import {
  FEE_TYPES, FEE_TYPE_META, moveInDepositMirror, moveInTotalDue, moneyBoxValue,
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
  const existing = await isExistingTenancyDocument(c, documentId)
  const set = async (col: string, value: string) => {
    await c.query(
      `UPDATE lease_document_fields SET value = $3
        WHERE document_id = $1 AND lease_column = $2
          AND (signed_at IS NULL OR lease_column IN ('move_in_security_deposit', 'move_in_total_due'))
          AND value IS DISTINCT FROM $3`,
      [documentId, col, value])
    for (const r of rows) if (r.lease_column === col) r.value = value
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
