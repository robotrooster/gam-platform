/**
 * Tool: get_inspection_progress (landlord). The landlord-side companion to
 * the tenant's get_inspection_checklist — lets the agent run/coordinate an
 * inspection walkthrough from the LANDLORD's chat while whoever is on-site
 * (the tenant, or a turnover crew on an empty unit) takes the photos.
 *
 * Returns the standard area checklist for one of the landlord's OWN unit
 * inspections (sized to the unit) plus which areas still need a photo, so the
 * agent can say "unit 4 still needs the kitchen and both bedrooms shot."
 * Hard-scoped to actor.profileId (unit_inspections.landlord_id). Read-only.
 */

import { query, queryOne } from '../../../db'
import { checklistProgress, type InspectionUnitRow } from './inspectionChecklistShared'
import type { AgentTool, AgentActor } from './types'

export const getInspectionProgress: AgentTool = {
  name: 'get_inspection_progress',
  description:
    'Get the photo-walkthrough progress for one of the landlord’s OWN unit inspections, so you can ' +
    'help them run it (the tenant, or a turnover crew on an empty unit, takes the photos). Pass an ' +
    'inspectionId, or a unit number to use that unit’s current inspection. Omit both to list the ' +
    'landlord’s open inspections so you can ask which one. Returns the areas to photograph (sized to ' +
    'the unit) and what’s still missing. Read-only.',
  parameters: {
    type: 'object',
    properties: {
      inspectionId: { type: 'string', description: 'A specific inspection id.' },
      unit: { type: 'string', description: 'A unit number — uses that unit’s current (open, newest) inspection.' },
    },
  },
  audiences: ['landlord'],

  async execute(args, actor: AgentActor) {
    const inspectionId = String(args.inspectionId ?? '').trim()
    const unit = String(args.unit ?? '').trim()

    let insp: InspectionUnitRow | null = null
    if (inspectionId) {
      insp = await queryOne<InspectionUnitRow>(
        `SELECT i.id, i.inspection_type, i.status, u.unit_number, u.bedrooms, u.unit_type
           FROM unit_inspections i JOIN units u ON u.id = i.unit_id
          WHERE i.id = $1 AND i.landlord_id = $2`,
        [inspectionId, actor.profileId]
      )
      if (!insp) return { ok: false, error: 'No such inspection on your account.' }
    } else if (unit) {
      insp = await queryOne<InspectionUnitRow>(
        // The unit's most relevant inspection: prefer open, newest first.
        `SELECT i.id, i.inspection_type, i.status, u.unit_number, u.bedrooms, u.unit_type
           FROM unit_inspections i JOIN units u ON u.id = i.unit_id
          WHERE i.landlord_id = $1 AND u.unit_number ILIKE $2
          ORDER BY (i.status NOT IN ('finalized','cancelled')) DESC, COALESCE(i.scheduled_for, i.created_at) DESC
          LIMIT 1`,
        [actor.profileId, unit]
      )
      if (!insp) return { ok: false, error: `No inspection found for unit “${unit}”. Create one for that unit first, or check the unit number.` }
    } else {
      // No selector — list open inspections so the agent can ask which.
      const open = await query<any>(
        `SELECT i.id, i.inspection_type, i.status, u.unit_number, p.name AS property_name
           FROM unit_inspections i
           JOIN units u ON u.id = i.unit_id
           JOIN properties p ON p.id = u.property_id
          WHERE i.landlord_id = $1 AND i.status NOT IN ('finalized','cancelled')
          ORDER BY COALESCE(i.scheduled_for, i.created_at) DESC LIMIT 10`,
        [actor.profileId]
      )
      return {
        ok: false,
        needsSelection: true,
        message: open.length
          ? 'Which inspection? Ask the landlord by unit/property, then call again with the unit or inspectionId.'
          : 'You have no open inspections right now.',
        openInspections: open.map((r) => ({ inspectionId: r.id, type: r.inspection_type, status: r.status, unit: r.unit_number, property: r.property_name })),
      }
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
        ? `This inspection is ${insp.status} — it’s closed, so no more photos are needed.`
        : remainingAreas.length === 0
          ? 'Every area has a photo — the walkthrough’s photo coverage is complete and it can be signed/finalized.'
          : `Remaining areas: ${remainingAreas.join(', ')}. Have whoever’s on-site (the tenant, or your turnover crew for an empty unit) take a fresh photo of each — any item that’s damaged or missing gets its own close-up.`,
    }
  },
}
