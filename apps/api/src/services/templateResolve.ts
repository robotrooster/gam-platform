/**
 * S558 (Nic): resolve the DEFAULT lease template for a unit — the "primary
 * <unit type> lease" the landlord designated. This is what makes auto-drafting
 * pull the right lease off a unit: match on the unit's (property, unit_type),
 * preferring a property-locked default (that property's own primary lease) over
 * the landlord-wide unlocked default for the unit type.
 *
 * Returns the full template row (so callers get deposit_months +
 * default_term_months in one hop) or null when the landlord hasn't set a
 * default for this unit's type yet — in which case the pipeline can't auto-draft
 * and must tell the landlord to configure the unit type's template.
 */
import { queryOne } from '../db'

export type ResolvedTemplate = {
  id: string
  landlord_id: string
  unit_type: string | null
  property_id: string | null
  deposit_months: string | null
  default_term_months: number | null
  base_pdf_url: string | null
  is_active: boolean
}

type Exec = { query: (sql: string, params: any[]) => Promise<{ rows: any[] }> } | null

/** Resolve the default template for a unit. Property-locked default wins over
 *  the unlocked unit-type default. Only active templates. */
export async function resolveDefaultTemplateForUnit(
  unitId: string,
  exec: Exec = null,
): Promise<ResolvedTemplate | null> {
  const runOne = async (sql: string, params: any[]) =>
    exec ? await exec.query(sql, params).then((r) => r.rows[0] ?? null)
         : await queryOne<any>(sql, params)

  const unit = await runOne(
    `SELECT u.unit_type, u.property_id, p.landlord_id
       FROM units u JOIN properties p ON p.id = u.property_id
      WHERE u.id = $1`,
    [unitId],
  )
  if (!unit || !unit.unit_type) return null

  // Prefer the property-locked default, then the landlord-wide unlocked default.
  const tmpl = await runOne(
    `SELECT * FROM lease_templates
      WHERE landlord_id = $1
        AND unit_type = $2
        AND is_unit_type_default = true
        AND is_active = true
        AND (property_id = $3 OR property_id IS NULL)
      ORDER BY (property_id IS NOT NULL) DESC
      LIMIT 1`,
    [unit.landlord_id, unit.unit_type, unit.property_id],
  )
  return tmpl ?? null
}
