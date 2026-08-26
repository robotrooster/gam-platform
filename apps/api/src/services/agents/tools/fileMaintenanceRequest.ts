/**
 * Tool: file_maintenance_request (tenant).
 *
 * Lets a tenant agent open a maintenance request on the tenant's behalf,
 * routed to their landlord — the "do it for them" half of the property-
 * issue routing. Creation goes through the shared createMaintenanceRequest
 * service (same path as the HTTP route), hard-scoped to the logged-in
 * tenant: the model never supplies the tenant id or unit ownership.
 *
 * Unit resolution: a tenant is usually on one active unit. If they're on
 * several, the tool does NOT guess — it returns the list and asks the
 * model to confirm which one with the tenant.
 */

import { query } from '../../../db'
import { AppError } from '../../../middleware/errorHandler'
import { createMaintenanceRequest } from '../../maintenanceRequests'
import { MAINTENANCE_CATEGORIES, type MaintenanceCategory } from '@gam/shared'
import type { AgentTool, AgentActor } from './types'

interface ActiveUnit {
  unit_id: string
  unit_number: string | null
  property_name: string | null
}

async function activeUnitsForTenant(tenantId: string): Promise<ActiveUnit[]> {
  return query<ActiveUnit>(
    `SELECT DISTINCT u.id AS unit_id, u.unit_number, p.name AS property_name
       FROM v_lease_active_tenants vlat
       JOIN leases l ON l.id = vlat.lease_id AND l.status = 'active'
       JOIN units u ON u.id = l.unit_id
       JOIN properties p ON p.id = u.property_id
      WHERE vlat.tenant_id = $1`,
    [tenantId]
  )
}

export const fileMaintenanceRequest: AgentTool = {
  name: 'file_maintenance_request',
  description:
    'Open a maintenance request on behalf of the tenant for a property or unit issue ' +
    '(repairs, appliances, locks, plumbing, heating/cooling, pests, damage), routed to ' +
    'the tenant’s landlord. Call this tool directly as soon as the tenant has described ' +
    'the issue and wants it filed (they asked you to, or said go ahead) — do NOT just say ' +
    'you will file it without calling the tool. Do not use it for GAM account, payment, ' +
    'or lease questions.',
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Short summary of the issue, e.g. "Leaking kitchen sink"' },
      description: { type: 'string', description: 'Details: what is wrong, where, since when' },
      category: {
        type: 'string',
        enum: [...MAINTENANCE_CATEGORIES],
        description: 'Issue category, e.g. plumbing, electrical, hvac, appliance. Use general if unsure.',
      },
      unitId: {
        type: 'string',
        description: 'Only needed if the tenant is on multiple units; the id from a prior list.',
      },
    },
    required: ['title', 'description'],
  },
  audiences: ['tenant'],

  async execute(args, actor: AgentActor) {
    const title = String(args.title ?? '').trim()
    const description = String(args.description ?? '').trim()
    if (title.length < 3) return { ok: false, error: 'A title of at least 3 characters is required.' }
    if (description.length < 5) return { ok: false, error: 'A description of at least 5 characters is required.' }

    // S571: the agent does NOT set priority — createMaintenanceRequest runs the
    // in-house priority recommender for every tenant-originated request (one
    // source of truth). The agent only supplies the category.
    const category = MAINTENANCE_CATEGORIES.includes(args.category as MaintenanceCategory)
      ? (args.category as MaintenanceCategory)
      : undefined

    const units = await activeUnitsForTenant(actor.profileId)
    if (units.length === 0) {
      return { ok: false, error: 'No active lease found for this tenant, so a maintenance request cannot be filed.' }
    }

    let unitId = typeof args.unitId === 'string' ? args.unitId : undefined
    if (!unitId) {
      if (units.length > 1) {
        return {
          ok: false,
          needsUnitSelection: true,
          message: 'The tenant is on more than one unit. Ask which one this is for, then pass its unitId.',
          units: units.map((u) => ({
            unitId: u.unit_id,
            label: `${u.property_name ?? 'Property'}${u.unit_number ? ` — Unit ${u.unit_number}` : ''}`,
          })),
        }
      }
      unitId = units[0].unit_id
    } else if (!units.some((u) => u.unit_id === unitId)) {
      // Guard: the model may only file for a unit the tenant is actually on.
      return { ok: false, error: 'That unit is not one of the tenant’s active units.' }
    }

    // S624 — DO NOT FILE THE SAME THING TWICE.
    //
    // From the two-turn review: the agent filed the request, the tenant replied
    // "yes please, go ahead and put that in for me", and it filed a SECOND one.
    // Confirming something already done is the commonest two-turn shape there
    // is, and the duplicate is not cosmetic — it is a real row on the landlord's
    // board, a second notification, and a maintenance history that disagrees
    // with itself.
    //
    // Matched on the same unit and the same title within a short window, which
    // is what a re-confirmation looks like. Deliberately narrow: a tenant with a
    // genuinely recurring problem ("sink leaking again") files it days later, and
    // an identical title minutes apart is not that.
    const recent = await query<{ id: string; status: string; created_at: string }>(
      `SELECT id, status, created_at
         FROM maintenance_requests
        WHERE unit_id = $1
          AND LOWER(TRIM(title)) = LOWER(TRIM($2))
          AND status NOT IN ('completed', 'cancelled')
          AND created_at > NOW() - INTERVAL '30 minutes'
        ORDER BY created_at DESC LIMIT 1`,
      [unitId, title])
    if (recent.length > 0) {
      const unit = units.find((u) => u.unit_id === unitId)
      return {
        ok: true,
        alreadyFiled: true,
        requestId: recent[0].id,
        status: recent[0].status,
        unit: unit ? `${unit.property_name ?? 'Property'}${unit.unit_number ? ` — Unit ${unit.unit_number}` : ''}` : undefined,
        // Tell the agent what to SAY, since the useful reply here is not "done"
        // a second time — it is confirmation plus what happens next.
        message: 'This was already filed a moment ago — do NOT file it again. Confirm it is in, and tell them maintenance usually responds within 24-48 hours.',
      }
    }

    try {
      const request = await createMaintenanceRequest({
        unitId,
        title,
        description,
        category,
        actor: { userId: actor.userId, role: actor.role, profileId: actor.profileId },
      })
      const unit = units.find((u) => u.unit_id === unitId)
      return {
        ok: true,
        requestId: request.id,
        status: request.status,
        priority: request.priority,
        unit: unit ? `${unit.property_name ?? 'Property'}${unit.unit_number ? ` — Unit ${unit.unit_number}` : ''}` : undefined,
        message: 'Maintenance request filed and routed to the landlord.',
      }
    } catch (e) {
      if (e instanceof AppError) return { ok: false, error: e.message }
      throw e
    }
  },
}
