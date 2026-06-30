/**
 * Inspection creation — shared insert + checklist-seed logic.
 *
 * Single source for "make an inspection row and seed its standard area
 * checklist", used by BOTH the create route (POST /api/inspections) and the
 * agent create_inspection tool. Keeping it here means an agent-created
 * inspection and a UI-created one are seeded identically (same
 * buildInspectionChecklist sizing, same 'na' seed rows, same idempotent
 * ON CONFLICT) — they can never drift.
 *
 * The caller owns the transaction and authorization: it looks up the unit
 * (for landlord_id + bedrooms + unit_type), confirms the actor may manage it,
 * BEGINs, calls this, and COMMITs.
 */
import type { PoolClient } from 'pg'
import { buildInspectionChecklist } from '@gam/shared'

export interface InsertInspectionParams {
  unitId: string
  landlordId: string
  /** unit facts that size the checklist (from the same unit lookup the caller did for auth) */
  unitType: string | null
  bedrooms: number | null
  leaseId?: string | null
  tenantId?: string | null
  inspectionType: string
  comparisonInspectionId?: string | null
  scheduledFor?: string | null
  notes?: string | null
}

export async function insertInspectionWithChecklist(
  client: PoolClient,
  p: InsertInspectionParams,
): Promise<{ id: string; seededItems: number }> {
  const inserted = (await client.query(
    `INSERT INTO unit_inspections (
       unit_id, lease_id, tenant_id, landlord_id,
       inspection_type, comparison_inspection_id,
       scheduled_for, notes
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id`,
    [
      p.unitId,
      p.leaseId ?? null,
      p.tenantId ?? null,
      p.landlordId,
      p.inspectionType,
      p.comparisonInspectionId ?? null,
      p.scheduledFor ?? null,
      p.notes ?? null,
    ],
  )).rows[0] as { id: string }

  // Seed the standard area checklist as 'na' items so the agent-guided
  // walkthrough and per-area photo progress have real rows to attach to.
  // Sized to the unit. ON CONFLICT keeps this idempotent against the
  // (inspection_id, area, item_label) unique key.
  const checklist = buildInspectionChecklist({ unitType: p.unitType, bedrooms: p.bedrooms })
  const seedRows: string[] = []
  const seedParams: any[] = [inserted.id]
  for (const areaDef of checklist) {
    for (const label of areaDef.items) {
      const areaIdx = seedParams.push(areaDef.area)
      const labelIdx = seedParams.push(label)
      seedRows.push(`($1, $${areaIdx}, $${labelIdx}, 'na')`)
    }
  }
  if (seedRows.length) {
    await client.query(
      `INSERT INTO unit_inspection_items (inspection_id, area, item_label, condition)
       VALUES ${seedRows.join(', ')}
       ON CONFLICT (inspection_id, area, item_label) DO NOTHING`,
      seedParams,
    )
  }
  return { id: inserted.id, seededItems: seedRows.length }
}
