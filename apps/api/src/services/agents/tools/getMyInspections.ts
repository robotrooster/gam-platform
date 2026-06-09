/**
 * Tool: get_my_inspections (tenant). Reads the tenant's OWN unit
 * inspections. Hard-scoped to actor.profileId (unit_inspections.tenant_id).
 */

import { query } from '../../../db'
import type { AgentTool, AgentActor } from './types'

interface Row {
  inspection_type: string
  status: string
  scheduled_for: string | null
  conducted_at: string | null
  finalized_at: string | null
  notes: string | null
}

export const getMyInspections: AgentTool = {
  name: 'get_my_inspections',
  description:
    'List the tenant’s own unit inspections (type, status, scheduled date, results notes). Use ' +
    'for “do I have an inspection coming up?” or “what did my inspection find?”. Read-only.',
  parameters: { type: 'object', properties: { limit: { type: 'integer', description: 'How many to return (default 10, max 25).' } } },
  audiences: ['tenant'],
  async execute(args, actor: AgentActor) {
    const rawLimit = Number(args.limit)
    const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(Math.trunc(rawLimit), 1), 25) : 10
    const rows = await query<Row>(
      `SELECT inspection_type, status, scheduled_for, conducted_at, finalized_at, notes
         FROM unit_inspections WHERE tenant_id = $1
        ORDER BY COALESCE(scheduled_for, created_at) DESC LIMIT $2`,
      [actor.profileId, limit]
    )
    return {
      ok: true,
      count: rows.length,
      note: rows.length === 0 ? 'No inspections on record for this tenant.' : undefined,
      inspections: rows.map((r) => ({
        type: r.inspection_type, status: r.status,
        scheduledFor: r.scheduled_for, conductedAt: r.conducted_at, finalizedAt: r.finalized_at, notes: r.notes,
      })),
    }
  },
}
