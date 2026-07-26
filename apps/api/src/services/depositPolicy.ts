/**
 * S556 (Nic): security-deposit multiplier resolution — per (property,
 * unit_type), same shape as the late-fee policy (services/lateFeePolicy.ts).
 *
 * A lease's security deposit is DERIVED: deposit = rent_amount × multiplier.
 * The unit stores market rent; this resolver supplies the multiplier so lease
 * creation can seed the security_deposit box automatically. Absence of a row
 * means multiplier 1.0 (deposit == one month's rent) — a safe, non-surprising
 * default (unlike late fees, a deposit is not legally hazardous to default, so
 * there is no "undecided" gate here).
 */
import { queryOne } from '../db'

type Exec = { query: (sql: string, params: any[]) => Promise<{ rows: any[] }> } | null

export const DEFAULT_DEPOSIT_MULTIPLIER = 1.0

/** Resolve the deposit multiplier for a unit's (property, unit_type). Runs
 *  through an open transaction client when provided (doc creation runs inside
 *  one), else the pool. Returns DEFAULT_DEPOSIT_MULTIPLIER when no row. */
export async function resolveDepositMultiplier(
  propertyId: string,
  unitType: string | null,
  exec: Exec = null,
): Promise<number> {
  if (!propertyId || !unitType) return DEFAULT_DEPOSIT_MULTIPLIER
  const sql = `SELECT deposit_multiplier FROM property_unit_type_deposits
               WHERE property_id = $1 AND unit_type = $2`
  const row = exec
    ? await exec.query(sql, [propertyId, unitType]).then((r) => r.rows[0])
    : await queryOne<{ deposit_multiplier: string }>(sql, [propertyId, unitType])
  if (!row || row.deposit_multiplier == null) return DEFAULT_DEPOSIT_MULTIPLIER
  const m = Number(row.deposit_multiplier)
  return Number.isFinite(m) && m >= 0 ? m : DEFAULT_DEPOSIT_MULTIPLIER
}

/** Compute a derived deposit from a rent amount + multiplier, rounded to cents. */
export function computeDeposit(rentAmount: number, multiplier: number): number {
  return Math.round(rentAmount * multiplier * 100) / 100
}
