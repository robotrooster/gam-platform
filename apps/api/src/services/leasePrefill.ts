/**
 * S556 (Nic): suggested lease-document field values derived from the assigned
 * UNIT, so a lease drafted off a unit auto-fills what the unit already knows —
 * the landlord reviews/adjusts instead of retyping. Single source of truth for
 * both the server-side seed (esign createDocumentRecord) and the GET endpoint
 * the send-form calls to pre-populate its inputs.
 *
 * Derived values:
 *   rent_amount      ← unit market rent
 *   security_deposit ← unit rent × template.deposit_months (S558 — the deposit
 *                      multiplier is a LEASE term on the template, not a
 *                      property setting; only filled when a templateId is given
 *                      AND that template states deposit_months)
 *   unit_number      ← unit
 *   property_name    ← property
 *   property_address ← property street/city/state/zip
 */
import { query } from '../db'
import { resolveDepositMonths, computeDeposit } from './depositPolicy'

type Exec = { query: (sql: string, params: any[]) => Promise<{ rows: any[] }> } | null

export async function suggestUnitPrefill(
  unitId: string,
  exec: Exec = null,
  templateId: string | null = null,
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
    // Deposit derives from the lease term (template.deposit_months) × unit rent.
    // No template / no stated multiplier → leave the box for the landlord to
    // fill (never invent a deposit; the lease is law).
    const months = await resolveDepositMonths(templateId, exec)
    if (months != null) out.security_deposit = computeDeposit(rent, months).toFixed(2)
  }
  if (u.unit_number) out.unit_number = u.unit_number
  if (u.property_name) out.property_name = u.property_name
  const addr = [u.street1, u.street2, u.city, u.state, u.zip].filter(Boolean).join(', ')
  if (addr) out.property_address = addr
  return out
}
