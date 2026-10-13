/**
 * 10/12 (Nic) — test helper for keep-everything (services/chargeVoids).
 *
 * The paths that used to DELETE a charge nobody owes now VOID it and keep the
 * row. That is only right if every figure reads the same as it did when the
 * row was gone. moneyFigures() reads the figures a landlord and a tenant see —
 * Money billed and Money received, the household's pay-in-full quote, what is
 * owed, every bill's status and total, the space's status and the household's
 * payment health — and voidedKeptVsDeleted() reads them with the voided rows
 * kept, then deletes those rows (the old behavior) and reads them again, so a
 * test can expect the two to be equal.
 *
 * Test databases only: it deletes rows, and refuses anything not *_test.
 */
import { db, getClient } from '../db'
import { incomeTotals } from '../services/incomeBasis'
import { householdQuote } from '../services/creditUse'
import { openAmountSql, openBalanceSql } from '../services/openBalances'
import { healthByHousehold, householdsOf } from '../services/householdMonths'

const RANGE = { start: '2024-01-01', end: '2028-12-31' }

export async function moneyFigures(landlordId: string, tenantId: string): Promise<Record<string, unknown>> {
  const strip = (t: any) => ({ lines: t.lines, parts: t.parts, beside: t.beside, total: t.total })
  const billed = strip(await incomeTotals({ landlordIds: [landlordId], ...RANGE, basis: 'billed' }))
  const received = strip(await incomeTotals({ landlordIds: [landlordId], ...RANGE, basis: 'received' }))
  const c = await getClient()
  let quote: unknown
  try { quote = (await householdQuote(c, { tenantId, landlordId })).totals } finally { c.release() }
  const owed = (await db.query<{ n: string }>(
    `SELECT COALESCE(SUM(${openAmountSql('p')}), 0)::text AS n FROM payments p
      WHERE p.landlord_id = $1 AND ${openBalanceSql('p')}`, [landlordId])).rows[0].n
  const invoices = (await db.query(
    `SELECT id, status, total_amount::text AS total, subtotal_rent::text AS rent, subtotal_late_fees::text AS late_fees
       FROM invoices WHERE landlord_id = $1 ORDER BY id`, [landlordId])).rows
  const units = (await db.query(`SELECT id, status FROM units WHERE landlord_id = $1 ORDER BY id`, [landlordId])).rows
  const hh = (await householdsOf([tenantId], [landlordId])).get(tenantId) ?? tenantId
  const health = (await healthByHousehold({ landlordIds: [landlordId], householdIds: [hh] })).get(hh) ?? null
  return { billed, received, quote, owed, invoices, units, health }
}

/**
 * The figures with this landlord's voided rows kept, and again after deleting
 * them (what the old code did). Also returns how many voided rows there were,
 * so a test knows the comparison was not empty.
 */
export async function voidedKeptVsDeleted(landlordId: string, tenantId: string): Promise<{
  kept: Record<string, unknown>; deleted: Record<string, unknown>; voidedRows: number
}> {
  const who = (await db.query<{ d: string }>(`SELECT current_database() AS d`)).rows[0].d
  if (!who.endsWith('_test')) throw new Error(`voidedKeptVsDeleted REFUSED: connected to "${who}"`)
  const kept = await moneyFigures(landlordId, tenantId)
  const gone = await db.query(`DELETE FROM payments WHERE landlord_id = $1 AND status = 'voided'`, [landlordId])
  const deleted = await moneyFigures(landlordId, tenantId)
  return { kept, deleted, voidedRows: gone.rowCount ?? 0 }
}
