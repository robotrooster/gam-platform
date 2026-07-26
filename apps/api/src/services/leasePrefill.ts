/**
 * S556 (Nic): suggested lease-document field values derived from the assigned
 * UNIT, so a lease drafted off a unit auto-fills what the unit already knows —
 * the landlord reviews/adjusts instead of retyping. Single source of truth for
 * both the server-side seed (esign createDocumentRecord) and the GET endpoint
 * the send-form calls to pre-populate its inputs.
 *
 * Derived values:
 *   rent_amount      ← unit market rent
 *   security_deposit ← rent × per-(property,unit_type) multiplier (depositPolicy)
 *   unit_number      ← unit
 *   property_name    ← property
 *   property_address ← property street/city/state/zip
 */
import { query } from '../db'
import { resolveDepositMultiplier, computeDeposit } from './depositPolicy'

type Exec = { query: (sql: string, params: any[]) => Promise<{ rows: any[] }> } | null

export async function suggestUnitPrefill(
  unitId: string,
  exec: Exec = null,
): Promise<Record<string, string>> {
  const sql = `SELECT u.rent_amount, u.unit_number, u.unit_type, u.property_id,
                      p.name AS property_name, p.street1, p.street2, p.city, p.state, p.zip
                 FROM units u JOIN properties p ON p.id = u.property_id
                WHERE u.id = $1`
  const u = exec
    ? await exec.query(sql, [unitId]).then((r) => r.rows[0])
    : (await query<any>(sql, [unitId]))[0]
  if (!u) return {}

  const out: Record<string, string> = {}
  const rent = Number(u.rent_amount)
  if (Number.isFinite(rent) && rent > 0) {
    out.rent_amount = rent.toFixed(2)
    const mult = await resolveDepositMultiplier(u.property_id, u.unit_type, exec)
    out.security_deposit = computeDeposit(rent, mult).toFixed(2)
  }
  if (u.unit_number) out.unit_number = u.unit_number
  if (u.property_name) out.property_name = u.property_name
  const addr = [u.street1, u.street2, u.city, u.state, u.zip].filter(Boolean).join(', ')
  if (addr) out.property_address = addr
  return out
}
