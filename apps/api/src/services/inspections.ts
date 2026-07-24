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
  /** units.bathrooms — one checklist area per real bathroom (S550) */
  bathrooms?: number | null
  /** units.dwelling_ownership — drives site-only vs interior checklists (S550) */
  dwellingOwnership?: string | null
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
  const checklist = buildInspectionChecklist({
    unitType: p.unitType,
    bedrooms: p.bedrooms,
    bathrooms: p.bathrooms ?? null,
    dwellingOwnership: p.dwellingOwnership ?? null,
  })
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

  // S550: a move-out inspection also ASSESSES the lease's conditional fees
  // ("professional carpet cleaning within N days, else $150"). One checklist
  // item per unassessed conditional fee, linked via lease_fee_id, under the
  // 'Lease conditions' area. At finalize: good/fair -> condition met (no
  // charge); damaged/missing -> failed (the fee joins the deposit sweep).
  let conditionItems = 0
  if (p.inspectionType === 'move_out' && p.leaseId) {
    const fees = (await client.query(
      `SELECT id, amount::text AS amount, description, condition_text
         FROM lease_fees
        WHERE lease_id = $1 AND condition_text IS NOT NULL AND condition_result IS NULL`,
      [p.leaseId],
    )).rows as Array<{ id: string; amount: string; description: string | null; condition_text: string }>
    for (const fee of fees) {
      const label = `${fee.description || 'Lease condition'} — $${Number(fee.amount).toFixed(2)} if not met`
      await client.query(
        `INSERT INTO unit_inspection_items
           (inspection_id, area, item_label, condition, notes, lease_fee_id)
         VALUES ($1, 'Lease conditions', $2, 'na', $3, $4)
         ON CONFLICT (inspection_id, area, item_label) DO NOTHING`,
        [inserted.id, label.slice(0, 200), fee.condition_text.slice(0, 500), fee.id],
      )
      conditionItems++
    }
  }
  return { id: inserted.id, seededItems: seedRows.length + conditionItems }
}
