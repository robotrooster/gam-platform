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
    'List the landlord’s units that are currently vacant or available, optionally at ONE property. ' +
    'Use for “what’s vacant?”, “which units do I need to fill?”, and the follow-up “which of those ' +
    'are at Sunset Palms?”. Read-only.',
  // S624: `property` was missing, so the drill-down every landlord makes —
  // portfolio number first, then one property — could not be answered. The
  // agent correctly refused to invent a figure and looked evasive doing it.
  // Answering the broad question and failing the narrow one is backwards: the
  // narrow one is the easier query.
  parameters: {
    type: 'object',
    properties: {
      property: { type: 'string', description: 'Optional property name (or part of it) to filter to, e.g. "Sunset Palms".' },
      limit: { type: 'integer', description: 'How many (default 50, max 200).' },
    },
  },
  audiences: ['landlord'],
  async execute(args, actor: AgentActor) {
    const rawLimit = Number(args.limit)
    const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(Math.trunc(rawLimit), 1), 200) : 50
    const property = String(args.property ?? '').trim()
    const rows = await query<Row>(
      `SELECT u.unit_number, p.name AS property_name, u.status
         FROM units u JOIN properties p ON p.id = u.property_id
        -- S605: retired units are never "vacant to fill" — they hold history
        -- only, and can't take a new lease or booking.
        WHERE u.landlord_id = $1 AND u.status = ANY($2) AND u.retired_at IS NULL
          AND ($4::text IS NULL OR p.name ILIKE '%' || $4 || '%')
        ORDER BY p.name, u.unit_number
        LIMIT $3`,
      [actor.profileId, VACANT, limit, property || null]
    )
    return {
      ok: true,
      count: rows.length,
      // A filtered empty result and an unfiltered one mean different things, and
      // saying "everything is occupied" for a property name that matched nothing
      // would be a confident wrong answer.
      note: rows.length > 0 ? undefined
        : property
          ? `No vacant units at a property matching "${property}" — check the name, or ask without it to see the whole portfolio.`
          : 'No vacant units — everything is occupied.',
      filteredToProperty: property || undefined,
      vacantUnits: rows.map((r) => ({ property: r.property_name, unit: r.unit_number, status: r.status })),
    }
  },
}
