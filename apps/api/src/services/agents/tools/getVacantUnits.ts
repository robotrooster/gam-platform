/**
 * Tool: get_vacant_units (landlord). Lists the landlord's OWN vacant units.
 * Hard-scoped to actor.profileId (units.landlord_id).
 */

import { query } from '../../../db'
import type { AgentTool, AgentActor } from './types'

interface Row { unit_number: string | null; property_name: string | null; status: string }

const VACANT = ['vacant', 'available']

export const getVacantUnits: AgentTool = {
  name: 'get_vacant_units',
  description:
    'List the landlord’s units that are currently vacant or available. Use for “what’s vacant?” or ' +
    '“which units do I need to fill?”. Read-only.',
  parameters: { type: 'object', properties: { limit: { type: 'integer', description: 'How many (default 50, max 200).' } } },
  audiences: ['landlord'],
  async execute(args, actor: AgentActor) {
    const rawLimit = Number(args.limit)
    const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(Math.trunc(rawLimit), 1), 200) : 50
    const rows = await query<Row>(
      `SELECT u.unit_number, p.name AS property_name, u.status
         FROM units u JOIN properties p ON p.id = u.property_id
        WHERE u.landlord_id = $1 AND u.status = ANY($2)
        ORDER BY p.name, u.unit_number
        LIMIT $3`,
      [actor.profileId, VACANT, limit]
    )
    return {
      ok: true,
      count: rows.length,
      note: rows.length === 0 ? 'No vacant units — everything is occupied.' : undefined,
      vacantUnits: rows.map((r) => ({ property: r.property_name, unit: r.unit_number, status: r.status })),
    }
  },
}
