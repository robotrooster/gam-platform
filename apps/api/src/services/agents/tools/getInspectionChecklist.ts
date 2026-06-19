/**
 * Tool: get_inspection_checklist (tenant). Drives the agent-guided
 * walkthrough of a move-in / move-out / periodic inspection.
 *
 * Returns the STANDARD area checklist for the inspection's unit — sized to
 * the unit's real bedroom count and unit type via the shared single source
 * `buildInspectionChecklist` (so the agent never asks for a bedroom that
 * doesn't exist) — plus which areas already have a photo, so the agent can
 * walk the tenant area-by-area ("now a fresh photo of the kitchen") and
 * nudge only what's still missing.
 *
 * Read-only and hard-scoped to actor.profileId (unit_inspections.tenant_id).
 * Photo CAPTURE happens in the inspection UI (fresh camera, not upload — a
 * later slice), not here; this tool only reads progress and guides.
 */

import { queryOne } from '../../../db'
import { checklistProgress, type InspectionUnitRow } from './inspectionChecklistShared'
import type { AgentTool, AgentActor } from './types'

export const getInspectionChecklist: AgentTool = {
  name: 'get_inspection_checklist',
  description:
    'Get the room-by-room photo checklist for the tenant’s inspection so you can walk them through it. ' +
    'Returns the standard areas to photograph (already sized to THIS unit — only the bedrooms it actually ' +
    'has) and which areas still need a photo. Use when a tenant is doing a move-in/move-out inspection or ' +
    'asks for help with one: read this, then guide them one area at a time ("take a fresh photo of the ' +
    'kitchen"), and remind them of anything still missing. Read-only.',
  parameters: {
    type: 'object',
    properties: { inspectionId: { type: 'string', description: 'A specific inspection id. Omit to use the tenant’s most recent open inspection.' } },
  },
  audiences: ['tenant'],

  async execute(args, actor: AgentActor) {
    const inspectionId = String(args.inspectionId ?? '').trim()

    // Resolve the inspection, hard-scoped to THIS tenant, joined to the unit
    // for the bedroom/type facts that size the checklist.
    const insp = inspectionId
      ? await queryOne<InspectionUnitRow>(
          `SELECT i.id, i.inspection_type, i.status, u.unit_number, u.bedrooms, u.unit_type
             FROM unit_inspections i JOIN units u ON u.id = i.unit_id
            WHERE i.id = $1 AND i.tenant_id = $2`,
          [inspectionId, actor.profileId]
        )
      : await queryOne<InspectionUnitRow>(
          // Prefer an OPEN inspection (not finalized/cancelled), newest first.
          `SELECT i.id, i.inspection_type, i.status, u.unit_number, u.bedrooms, u.unit_type
             FROM unit_inspections i JOIN units u ON u.id = i.unit_id
            WHERE i.tenant_id = $1
            ORDER BY (i.status NOT IN ('finalized','cancelled')) DESC, COALESCE(i.scheduled_for, i.created_at) DESC
            LIMIT 1`,
          [actor.profileId]
        )

    if (!insp) {
      return { ok: false, error: inspectionId ? 'No such inspection on your account.' : 'You don’t have any inspections on record.' }
    }

    const { areas, remainingAreas, closed } = await checklistProgress(insp)

    return {
      ok: true,
      inspection: { id: insp.id, type: insp.inspection_type, status: insp.status, unit: insp.unit_number },
      closed,
      areaCount: areas.length,
      remainingCount: remainingAreas.length,
      remainingAreas,
      areas,
      note: closed
        ? `This inspection is ${insp.status} — it’s closed, so don’t prompt for more photos.`
        : remainingAreas.length === 0
          ? 'Every area has a photo. Let the tenant know they’re done and can sign.'
          : `Walk the tenant through the remaining areas one at a time, asking for a fresh photo of each. Remind them any item that’s damaged or missing should get its own close-up.`,
    }
  },
}
