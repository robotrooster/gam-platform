/**
 * Shared inspection-checklist progress logic, used by both the tenant tool
 * (get_inspection_checklist) and the landlord tool (get_inspection_progress).
 *
 * Given an inspection joined to its unit, it builds the standard area
 * checklist (sized to the unit via the shared single source) and flags which
 * areas already have a photo (photo → item → area, case-insensitive). Photo
 * capture itself happens in the inspection UI; this only reads progress.
 */

import { query } from '../../../db'
import { buildInspectionChecklist } from '@gam/shared'

export interface InspectionUnitRow {
  id: string
  inspection_type: string
  status: string
  unit_number: string | null
  bedrooms: number | null
  unit_type: string | null
}

export const CLOSED_INSPECTION_STATUSES = ['finalized', 'cancelled']

export interface ChecklistProgress {
  areas: { area: string; items: readonly string[]; photographed: boolean }[]
  remainingAreas: string[]
  closed: boolean
}

export async function checklistProgress(insp: InspectionUnitRow): Promise<ChecklistProgress> {
  const checklist = buildInspectionChecklist({ unitType: insp.unit_type, bedrooms: insp.bedrooms })
  // Areas that already have at least one photo. Case-insensitive so an ad-hoc
  // "kitchen" item still counts toward the standard "Kitchen" area.
  const photographedRows = await query<{ area: string }>(
    `SELECT DISTINCT i.area
       FROM unit_inspection_items i
       JOIN unit_inspection_photos p ON p.item_id = i.id
      WHERE i.inspection_id = $1`,
    [insp.id]
  )
  const photographed = new Set(photographedRows.map((r) => (r.area ?? '').trim().toLowerCase()))
  const areas = checklist.map((a) => ({
    area: a.area,
    items: a.items,
    photographed: photographed.has(a.area.toLowerCase()),
  }))
  const remainingAreas = areas.filter((a) => !a.photographed).map((a) => a.area)
  const closed = CLOSED_INSPECTION_STATUSES.includes(insp.status)
  return { areas, remainingAreas, closed }
}
