/**
 * Tool: create_inspection (landlord ACTION).
 *
 * Creates a draft inspection for one of the landlord's OWN units and seeds
 * its standard area checklist — the hands-off way to start a move-in /
 * move-out / periodic / turnover walkthrough from the landlord's chat. Mirrors
 * POST /api/inspections exactly (same shared insertInspectionWithChecklist),
 * so an agent-created inspection is identical to a UI-created one.
 *
 * Hard-scoped: the unit must have landlord_id = actor.profileId. For move-in /
 * move-out it auto-links the unit's active lease + primary tenant (so the
 * tenant can sign and credit events fire); for move-out it auto-links the most
 * recent finalized move-in as the comparison baseline. Periodic / turnover are
 * landlord-only (no tenant needed — the landlord's signature finalizes them).
 *
 * The agent only CREATES the draft and records conditions
 * (set_inspection_item_condition). Signing and finalizing stay with the
 * human — this tool never signs or finalizes.
 */
import { getClient, queryOne } from '../../../db'
import { insertInspectionWithChecklist } from '../../inspections'
import { INSPECTION_TYPES, type InspectionType } from '@gam/shared'
import { logger } from '../../../lib/logger'
import type { AgentTool, AgentActor } from './types'

interface UnitRow {
  id: string
  unit_number: string | null
  bedrooms: number | null
  unit_type: string | null
}

export const createInspection: AgentTool = {
  name: 'create_inspection',
  description:
    'Start a new inspection on one of the landlord’s OWN units and seed its room-by-room checklist. ' +
    'Use when the landlord wants to begin a move-in, move-out, periodic, or turnover walkthrough. ' +
    'Pass the unit number and the type. For move-in/move-out the current tenant and lease are linked ' +
    'automatically, and a move-out is automatically compared against the unit’s last finalized move-in. ' +
    'Creates a DRAFT only — after this, walk them through each area and record conditions with ' +
    'set_inspection_item_condition. You never sign or finalize; that’s the landlord’s (and tenant’s) to do.',
  parameters: {
    type: 'object',
    properties: {
      unit: { type: 'string', description: 'The unit number to inspect (e.g. "4" or "101").' },
      inspectionType: {
        type: 'string',
        enum: [...INSPECTION_TYPES],
        description: 'move_in, move_out, periodic, or turnover.',
      },
      scheduledFor: { type: 'string', description: 'Optional ISO date-time the inspection is scheduled for.' },
      notes: { type: 'string', description: 'Optional internal notes for the inspection.' },
    },
    required: ['unit', 'inspectionType'],
  },
  audiences: ['landlord'],

  async execute(args, actor: AgentActor) {
    const unitArg = String(args.unit ?? '').trim()
    const inspectionType = String(args.inspectionType ?? '').trim() as InspectionType
    const scheduledForRaw = String(args.scheduledFor ?? '').trim()
    const notes = String(args.notes ?? '').trim() || null

    if (!unitArg) return { ok: false, error: 'Which unit? Pass the unit number.' }
    if (!(INSPECTION_TYPES as readonly string[]).includes(inspectionType)) {
      return { ok: false, error: 'inspectionType must be one of: move_in, move_out, periodic, turnover.' }
    }
    let scheduledFor: string | null = null
    if (scheduledForRaw) {
      const d = new Date(scheduledForRaw)
      if (Number.isNaN(d.getTime())) return { ok: false, error: 'scheduledFor must be a valid date-time, or omit it.' }
      scheduledFor = d.toISOString()
    }

    // Resolve the unit, hard-scoped to THIS landlord.
    const unit = await queryOne<UnitRow>(
      `SELECT id, unit_number, bedrooms, unit_type
         FROM units WHERE unit_number ILIKE $1 AND landlord_id = $2
         ORDER BY unit_number LIMIT 1`,
      [unitArg, actor.profileId],
    )
    if (!unit) return { ok: false, error: `No unit “${unitArg}” on your account. Check the unit number.` }

    // Move-in / move-out: auto-link the unit's active lease + primary tenant so
    // the tenant can sign and credit events fire. Best-effort — a periodic /
    // turnover (or a unit with no active lease) just stays landlord-only.
    let leaseId: string | null = null
    let tenantId: string | null = null
    let tenantName: string | null = null
    if (inspectionType === 'move_in' || inspectionType === 'move_out') {
      const link = await queryOne<{ lease_id: string; tenant_id: string; first_name: string | null; last_name: string | null }>(
        `SELECT l.id AS lease_id, vat.tenant_id, vat.first_name, vat.last_name
           FROM leases l
           JOIN v_lease_active_tenants vat ON vat.lease_id = l.id AND vat.role = 'primary'
          WHERE l.unit_id = $1 AND l.status = 'active'
          ORDER BY l.start_date DESC
          LIMIT 1`,
        [unit.id],
      ).catch(() => null)
      if (link) {
        leaseId = link.lease_id
        tenantId = link.tenant_id
        tenantName = `${link.first_name ?? ''} ${link.last_name ?? ''}`.trim() || null
      }
    }

    // Move-out: auto-link the unit's most recent finalized move-in as the
    // comparison baseline so finalize can emit matches / damage-documented.
    let comparisonInspectionId: string | null = null
    if (inspectionType === 'move_out') {
      const baseline = await queryOne<{ id: string }>(
        `SELECT id FROM unit_inspections
          WHERE unit_id = $1 AND inspection_type = 'move_in' AND status = 'finalized'
          ORDER BY finalized_at DESC NULLS LAST LIMIT 1`,
        [unit.id],
      ).catch(() => null)
      comparisonInspectionId = baseline?.id ?? null
    }

    const client = await getClient()
    try {
      await client.query('BEGIN')
      const { id, seededItems } = await insertInspectionWithChecklist(client, {
        unitId: unit.id,
        landlordId: actor.profileId,
        unitType: unit.unit_type,
        bedrooms: unit.bedrooms,
        leaseId,
        tenantId,
        inspectionType,
        comparisonInspectionId,
        scheduledFor,
        notes,
      })
      await client.query('COMMIT')

      const tenantNote =
        (inspectionType === 'move_in' || inspectionType === 'move_out')
          ? tenantId
            ? `Linked tenant ${tenantName ?? ''}`.trim() + ' — they can sign once you’ve recorded conditions.'
            : 'No active lease/tenant found on this unit, so it’s landlord-only — add a tenant in the app if one should sign.'
          : 'Landlord-only inspection (no tenant needed).'

      return {
        ok: true,
        inspectionId: id,
        unit: unit.unit_number,
        type: inspectionType,
        seededItems,
        comparisonLinked: comparisonInspectionId != null,
        tenantLinked: tenantId != null,
        message:
          `Created a draft ${inspectionType.replace('_', '-')} inspection for unit ${unit.unit_number} with ${seededItems} checklist items. ` +
          tenantNote +
          (inspectionType === 'move_out'
            ? comparisonInspectionId
              ? ' It will be compared against the last finalized move-in.'
              : ' No finalized move-in to compare against, so no condition comparison will run.'
            : '') +
          ' Now walk them through each area and record conditions; signing and finalizing stay with the people involved.',
      }
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {})
      logger.error({ err: e }, '[agent] create_inspection')
      return { ok: false, error: 'Could not create the inspection — please try again.' }
    } finally {
      client.release()
    }
  },
}
