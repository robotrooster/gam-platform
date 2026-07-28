/**
 * S558 (Nic): security-deposit multiplier resolution — sourced from the LEASE
 * TEMPLATE, never a property-level setting.
 *
 * A lease's security deposit is DERIVED: deposit = unit rent × deposit_months.
 * The rent comes from the unit; the MULTIPLIER ("one / one-and-a-half / two
 * months' rent") is a term of the LEASE, stored on the template as
 * lease_templates.deposit_months. Draft-time lease creation reads it here so
 * the security_deposit box auto-fills, and — because it comes from the same
 * template the tenant signs — the charge always matches the signed document.
 *
 * (Supersedes the S556 per-(property,unit_type) property_unit_type_deposits
 * table, which could drift from the lease's actual words — removed in
 * migration 20260726091031.)
 *
 * NULL deposit_months = the template states no derivable multiplier → return
 * null so the caller leaves the deposit box for the landlord to fill. No silent
 * default: the lease is law; we never invent a deposit (same posture as late
 * fees).
 */
import { queryOne } from '../db'

type Exec = { query: (sql: string, params: any[]) => Promise<{ rows: any[] }> } | null

/** Resolve the deposit multiplier (months of rent) stated by a lease template.
 *  Runs through an open transaction client when provided (doc creation runs
 *  inside one), else the pool. Returns null when the template has no
 *  deposit_months set (or no templateId) — caller leaves the deposit blank. */
export async function resolveDepositMonths(
  templateId: string | null | undefined,
  exec: Exec = null,
): Promise<number | null> {
  if (!templateId) return null
  const sql = `SELECT deposit_months FROM lease_templates WHERE id = $1`
  const row = exec
    ? await exec.query(sql, [templateId]).then((r) => r.rows[0])
    : await queryOne<{ deposit_months: string | null }>(sql, [templateId])
  if (!row || row.deposit_months == null) return null
  const m = Number(row.deposit_months)
  return Number.isFinite(m) && m >= 0 ? m : null
}

/** Compute a derived deposit from a rent amount + multiplier, rounded to cents. */
export function computeDeposit(rentAmount: number, months: number): number {
  return Math.round(rentAmount * months * 100) / 100
}
