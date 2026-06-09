/**
 * Tool: get_property_rent_roll (landlord). The landlord's rent roll — each
 * unit with its occupancy status, current rent, and active tenant(s) —
 * optionally for one property. Hard-scoped to actor.profileId
 * (units.landlord_id).
 */

import { query } from '../../../db'
import type { AgentTool, AgentActor } from './types'

interface Row {
  property_name: string | null
  unit_number: string | null
  status: string
  rent_amount: string | null
  tenants: string | null
}

export const getPropertyRentRoll: AgentTool = {
  name: 'get_property_rent_roll',
  description:
    'Get the landlord’s rent roll — each unit with its status (occupied/vacant), current rent, and ' +
    'who the active tenant(s) are. Optionally limit to one property by name. Use for “show me the ' +
    'rent roll for Maple Court” or “what’s the rent on each of my units?”. Read-only.',
  parameters: {
    type: 'object',
    properties: {
      propertyName: { type: 'string', description: 'Optional — limit to this property (by name). Omit for the whole portfolio.' },
      limit: { type: 'integer', description: 'How many units (default 100, max 300).' },
    },
  },
  audiences: ['landlord'],
  async execute(args, actor: AgentActor) {
    const rawLimit = Number(args.limit)
    const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(Math.trunc(rawLimit), 1), 300) : 100
    const propertyName = typeof args.propertyName === 'string' && args.propertyName.trim() ? args.propertyName.trim() : null

    const params: any[] = [actor.profileId]
    let propFilter = ''
    if (propertyName) {
      params.push(`%${propertyName}%`)
      propFilter = `AND p.name ILIKE $${params.length}`
    }
    params.push(limit)

    const rows = await query<Row>(
      `SELECT p.name AS property_name, u.unit_number, u.status, l.rent_amount,
              (SELECT string_agg(vlat.first_name || ' ' || vlat.last_name, ', ')
                 FROM v_lease_active_tenants vlat WHERE vlat.lease_id = l.id) AS tenants
         FROM units u
         JOIN properties p ON p.id = u.property_id
         LEFT JOIN leases l ON l.unit_id = u.id AND l.status = 'active'
        WHERE u.landlord_id = $1 ${propFilter}
        ORDER BY p.name, u.unit_number
        LIMIT $${params.length}`,
      params
    )
    return {
      ok: true,
      count: rows.length,
      scope: propertyName ? `property "${propertyName}"` : 'whole portfolio',
      note: rows.length === 0 ? 'No units found for that scope.' : undefined,
      rentRoll: rows.map((r) => ({
        property: r.property_name, unit: r.unit_number, status: r.status,
        rent: r.rent_amount != null ? Number(r.rent_amount) : null, tenants: r.tenants,
      })),
    }
  },
}
