/**
 * 10/12 (Nic) — GAM BOOKS LEDGER: THE ENGINE'S TEST PROJECTOR
 *
 * Phase P3 builds the engine dark; the real projectors (what each money event
 * posts, design §6) come in later phases. This one trivial projector proves
 * the engine end to end on a real money table with real capture triggers:
 * money in that a landlord filed as other income (landlord_other_income).
 *
 *   active row  →  Dr Suspense (to classify)   amount
 *                  Cr Other income             amount   (Received, 'other_income')
 *   voided or missing row → nothing (its posting is reversed)
 *
 * dated income_date, tagged with the row's property (or its unit's), company
 * level when common. It is NOT the design's I4 rule (that debits the bank line
 * the money arrived in) and it is NEVER registered in production — tests
 * register it themselves (registerLedgerProjector(otherIncomeTestProjector)).
 */
import type { PoolClient } from 'pg'
import type { LedgerProjector, DesiredPosting, LedgerSourceRef } from './ledgerEngine'
import type { LedgerOwner } from './ledgerOwner'

export const otherIncomeTestProjector: LedgerProjector = {
  sourceType: 'other_income',
  ruleVersion: 1,
  async project(client: PoolClient, sourceId: string): Promise<DesiredPosting[]> {
    const r = await client.query<{
      landlord_id: string; property_id: string | null; unit_id: string | null; amount: string
      income_date: string; status: string; voided_at: string | null; is_common: boolean | null
    }>(
      `SELECT o.landlord_id, COALESCE(o.property_id, u.property_id) AS property_id, o.unit_id, o.amount::text AS amount,
              o.income_date::text AS income_date, o.status, o.voided_at::text AS voided_at, o.is_common
         FROM landlord_other_income o LEFT JOIN units u ON u.id = o.unit_id
        WHERE o.id::text = $1`, [sourceId])
    const row = r.rows[0]
    if (!row || row.status !== 'active' || row.voided_at) return []
    const cents = Math.round(Number(row.amount) * 100)
    const propertyId = row.is_common ? null : row.property_id
    return [{
      owner: { landlordId: row.landlord_id },
      intendedDate: row.income_date,
      memo: 'Other income',
      lines: [
        { role: 'suspense', debitCents: cents, propertyId, unitId: row.unit_id },
        { role: 'other_income', creditCents: cents, propertyId, unitId: row.unit_id, cashEffect: 'in', reportCategory: 'other_income' },
      ],
    }]
  },
  async listSources(client: PoolClient, owner: LedgerOwner, opts: { since?: string | null }): Promise<LedgerSourceRef[]> {
    if (!owner.landlordId) return []
    const r = await client.query<{ id: string; day: string }>(
      `SELECT id::text AS id, income_date::text AS day FROM landlord_other_income
        WHERE landlord_id = $1 AND ($2::date IS NULL OR income_date >= $2::date)`, [owner.landlordId, opts.since ?? null])
    return r.rows
  },
}
