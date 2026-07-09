/**
 * S535 (Nic): late-fee policy resolution — per (property, UNIT TYPE)
 * rows ONLY. There is deliberately NO property-wide default: a default
 * silently applied to a unit class it wasn't vetted for is how an
 * illegal charge happens. No row = that class has no late fee.
 *
 * Late fees are never set per lease (anti-discrimination — identical
 * terms for every tenant of a unit class). The unit's type resolves the
 * policy automatically, the same way it pulls the matching lease
 * template. This is the ONE resolver both consumers use:
 *   - document creation (esign createDocumentRecord) stamps the resolved
 *     policy into every drafted lease/renewal → the signed lease snapshot
 *     is the billing source (lease-is-law), so existing leases keep their
 *     signed terms and pick up the current policy at renewal.
 *   - the sign GET payload, so the signing UI locks the fields and the
 *     policy popup states the exact fee-start day.
 *
 * Resolution: the (property, unit_type) row, gated by the property's
 * late_fee_enabled master toggle; null otherwise.
 */
import { queryOne } from '../db'

export interface ResolvedLateFeePolicy {
  source: 'unit_type_override'
  unit_type: string | null
  property_name: string
  late_fee_grace_days: number
  late_fee_initial_amount: string
  late_fee_initial_type: 'flat' | 'percent_of_rent'
  late_fee_accrual_amount: string | null
  late_fee_accrual_type: 'flat' | 'percent_of_rent' | null
  late_fee_accrual_period: 'daily' | 'weekly' | 'monthly' | null
  late_fee_cap_amount: string | null
  late_fee_cap_type: 'flat' | 'percent_of_rent' | null
}

/** Exec through an open transaction client when provided (doc creation
 *  runs inside one), else the pool. */
type Exec = { query: (sql: string, params: any[]) => Promise<{ rows: any[] }> } | null

export async function resolveLateFeePolicyForUnit(
  unitId: string,
  client: Exec = null,
): Promise<ResolvedLateFeePolicy | null> {
  const one = async (sql: string, params: any[]) =>
    client ? (await client.query(sql, params)).rows[0] ?? null : queryOne<any>(sql, params)

  const unit = await one(
    `SELECT u.unit_type, u.property_id, p.name AS property_name, p.late_fee_enabled
       FROM units u JOIN properties p ON p.id = u.property_id
      WHERE u.id = $1`, [unitId])
  if (!unit || !unit.late_fee_enabled) return null

  const override = unit.unit_type
    ? await one(
        `SELECT * FROM property_unit_type_late_fees
          WHERE property_id = $1 AND unit_type = $2`,
        [unit.property_id, unit.unit_type])
    : null

  // S535 (Nic): NO property-wide default — a default silently applied to
  // a unit class it wasn't vetted for is how an illegal charge happens.
  // The per-(property, unit_type) row is the ONLY source; no row = that
  // class has no late fee.
  if (!override) return null
  return {
    source: 'unit_type_override',
    unit_type: unit.unit_type,
    property_name: unit.property_name,
    late_fee_grace_days: override.late_fee_grace_days,
    late_fee_initial_amount: override.late_fee_initial_amount,
    late_fee_initial_type: override.late_fee_initial_type,
    late_fee_accrual_amount: override.late_fee_accrual_amount,
    late_fee_accrual_type: override.late_fee_accrual_type,
    late_fee_accrual_period: override.late_fee_accrual_period,
    late_fee_cap_amount: override.late_fee_cap_amount,
    late_fee_cap_type: override.late_fee_cap_type,
  }
}

/** Map a resolved policy onto the granular late-fee lease-column tags
 *  used as document prefills (tag name encodes type + period). */
export function lateFeePolicyToPrefills(p: ResolvedLateFeePolicy): Record<string, string> {
  const pv: Record<string, string> = {}
  pv.late_fee_grace_days = String(p.late_fee_grace_days ?? 5)
  pv[p.late_fee_initial_type === 'percent_of_rent' ? 'late_fee_initial_percent' : 'late_fee_initial_flat'] =
    String(Number(p.late_fee_initial_amount))
  if (p.late_fee_accrual_amount != null && p.late_fee_accrual_period) {
    const kind = p.late_fee_accrual_type === 'percent_of_rent' ? 'percent' : 'flat'
    pv[`late_fee_accrual_${kind}_${p.late_fee_accrual_period}`] = String(Number(p.late_fee_accrual_amount))
  }
  if (p.late_fee_cap_amount != null) {
    pv[p.late_fee_cap_type === 'percent_of_rent' ? 'late_fee_cap_percent' : 'late_fee_cap_flat'] =
      String(Number(p.late_fee_cap_amount))
  }
  return pv
}
