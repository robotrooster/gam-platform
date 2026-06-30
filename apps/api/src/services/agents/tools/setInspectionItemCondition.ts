/**
 * Tool: set_inspection_item_condition (landlord ACTION).
 *
 * Records the condition of one checklist item on one of the landlord's OWN
 * DRAFT inspections — the "write" half of the agent-guided walkthrough: as the
 * landlord (or whoever is on-site) reports what they see, the agent logs it.
 * Mirrors POST /api/inspections/:id/items exactly (upsert on
 * (inspection_id, area, item_label); draft-only).
 *
 * Hard-scoped: inspection.landlord_id = actor.profileId, status must be
 * 'draft' (conditions lock once anyone signs). The agent records conditions;
 * it never signs or finalizes — the human does that.
 */
import { queryOne } from '../../../db'
import { INSPECTION_ITEM_CONDITIONS, type InspectionItemCondition } from '@gam/shared'
import type { AgentTool, AgentActor } from './types'

export const setInspectionItemCondition: AgentTool = {
  name: 'set_inspection_item_condition',
  description:
    'Record the condition of one item on one of the landlord’s OWN draft inspections, as you walk them ' +
    'through the unit. Get the inspectionId from create_inspection or get_inspection_progress, and the ' +
    'area/item from the checklist. condition is one of: good, fair, damaged, missing, na. Add notes and ' +
    'an estimatedRepairCost (dollars) for anything damaged or missing. Re-recording the same area+item ' +
    'updates it. Only works while the inspection is still a draft (before anyone signs). You record ' +
    'conditions; signing and finalizing stay with the people involved.',
  parameters: {
    type: 'object',
    properties: {
      inspectionId: { type: 'string', description: 'The inspection to write to (from create_inspection or get_inspection_progress).' },
      area: { type: 'string', description: 'The area, e.g. "Kitchen" (from the checklist).' },
      itemLabel: { type: 'string', description: 'The item within the area, e.g. "Refrigerator".' },
      condition: { type: 'string', enum: [...INSPECTION_ITEM_CONDITIONS], description: 'good, fair, damaged, missing, or na.' },
      notes: { type: 'string', description: 'Optional note about the item’s condition.' },
      estimatedRepairCost: { type: 'number', description: 'Optional estimated repair cost in dollars, for damaged/missing items.' },
    },
    required: ['inspectionId', 'area', 'itemLabel', 'condition'],
  },
  audiences: ['landlord'],

  async execute(args, actor: AgentActor) {
    const inspectionId = String(args.inspectionId ?? '').trim()
    const area = String(args.area ?? '').trim()
    const itemLabel = String(args.itemLabel ?? '').trim()
    const condition = String(args.condition ?? '').trim() as InspectionItemCondition
    const notes = String(args.notes ?? '').trim() || null
    const repairRaw = args.estimatedRepairCost
    const estimatedRepairCost =
      repairRaw == null || repairRaw === '' ? null : Number(repairRaw)

    if (!inspectionId) return { ok: false, error: 'An inspectionId is required (from create_inspection or get_inspection_progress).' }
    if (!area || !itemLabel) return { ok: false, error: 'Both an area and an item are required.' }
    if (!(INSPECTION_ITEM_CONDITIONS as readonly string[]).includes(condition)) {
      return { ok: false, error: 'condition must be one of: good, fair, damaged, missing, na.' }
    }
    if (estimatedRepairCost != null && !Number.isFinite(estimatedRepairCost)) {
      return { ok: false, error: 'estimatedRepairCost must be a number of dollars, or omit it.' }
    }

    // Hard-scope to THIS landlord's inspection; conditions are draft-only.
    const insp = await queryOne<{ id: string; status: string }>(
      `SELECT id, status FROM unit_inspections WHERE id = $1 AND landlord_id = $2`,
      [inspectionId, actor.profileId],
    )
    if (!insp) return { ok: false, error: 'No such inspection on your account.' }
    if (insp.status !== 'draft') {
      return { ok: false, error: `That inspection is "${insp.status}" — items can only be changed while it’s a draft (before anyone signs).` }
    }

    const r = await queryOne<{ id: string }>(
      `INSERT INTO unit_inspection_items (inspection_id, area, item_label, condition, notes, estimated_repair_cost)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (inspection_id, area, item_label) DO UPDATE
         SET condition = EXCLUDED.condition,
             notes = EXCLUDED.notes,
             estimated_repair_cost = EXCLUDED.estimated_repair_cost,
             updated_at = NOW()
       RETURNING id`,
      [inspectionId, area, itemLabel, condition, notes, estimatedRepairCost],
    )

    return {
      ok: true,
      itemId: r!.id,
      area,
      itemLabel,
      condition,
      message: `Recorded ${area} → ${itemLabel}: ${condition}${estimatedRepairCost != null ? ` ($${estimatedRepairCost} est. repair)` : ''}.`,
    }
  },
}
