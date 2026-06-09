/**
 * Tool: get_my_maintenance_requests (tenant).
 *
 * Lists the tenant's OWN maintenance requests and their status. Hard-scoped
 * to actor.profileId (maintenance_requests.tenant_id).
 */

import { query } from '../../../db'
import type { AgentTool, AgentActor } from './types'

interface RequestRow {
  id: string
  title: string
  status: string
  priority: string
  created_at: string
  unit_number: string | null
  property_name: string | null
}

export const getMyMaintenanceRequests: AgentTool = {
  name: 'get_my_maintenance_requests',
  description:
    'List the tenant’s own maintenance requests and their current status (open, awaiting ' +
    'approval, assigned, in progress, completed, cancelled). Use for “what’s the status of my ' +
    'repair request?” or “did my maintenance request get handled?”. Read-only.',
  parameters: {
    type: 'object',
    properties: {
      limit: { type: 'integer', description: 'How many recent requests to return (default 10, max 25).' },
    },
  },
  audiences: ['tenant'],

  async execute(args, actor: AgentActor) {
    const rawLimit = Number(args.limit)
    const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(Math.trunc(rawLimit), 1), 25) : 10

    const rows = await query<RequestRow>(
      `SELECT mr.id, mr.title, mr.status, mr.priority, mr.created_at,
              u.unit_number, p.name AS property_name
         FROM maintenance_requests mr
         JOIN units u ON u.id = mr.unit_id
         JOIN properties p ON p.id = u.property_id
        WHERE mr.tenant_id = $1
        ORDER BY mr.created_at DESC
        LIMIT $2`,
      [actor.profileId, limit]
    )

    return {
      ok: true,
      count: rows.length,
      note: rows.length === 0 ? 'No maintenance requests on record for this tenant.' : undefined,
      requests: rows.map((r) => ({
        requestId: r.id, // pass to add_maintenance_comment / cancel_maintenance_request
        title: r.title,
        status: r.status,
        priority: r.priority,
        property: r.property_name,
        unit: r.unit_number,
        submitted: r.created_at,
      })),
    }
  },
}
