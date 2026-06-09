/**
 * Tool: get_pending_maintenance (landlord).
 *
 * Lists the landlord's OWN open maintenance requests that need attention,
 * surfacing awaiting-approval ones first. Hard-scoped to actor.profileId
 * (maintenance_requests.landlord_id).
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

// "Needs attention" = not yet completed or cancelled.
const OPEN_STATUSES = ['open', 'awaiting_approval', 'assigned', 'in_progress']

export const getPendingMaintenance: AgentTool = {
  name: 'get_pending_maintenance',
  description:
    'List the landlord’s open maintenance requests that need attention (awaiting approval, open, ' +
    'assigned, or in progress), with those awaiting the landlord’s approval shown first. Use for ' +
    '“what maintenance needs my attention?” or “anything waiting on my approval?”. Read-only.',
  parameters: {
    type: 'object',
    properties: {
      limit: { type: 'integer', description: 'How many to return (default 15, max 40).' },
    },
  },
  audiences: ['landlord'],

  async execute(args, actor: AgentActor) {
    const rawLimit = Number(args.limit)
    const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(Math.trunc(rawLimit), 1), 40) : 15

    const rows = await query<RequestRow>(
      `SELECT mr.id, mr.title, mr.status, mr.priority, mr.created_at,
              u.unit_number, p.name AS property_name
         FROM maintenance_requests mr
         JOIN units u ON u.id = mr.unit_id
         JOIN properties p ON p.id = u.property_id
        WHERE mr.landlord_id = $1 AND mr.status = ANY($2)
        ORDER BY (mr.status = 'awaiting_approval') DESC, mr.created_at DESC
        LIMIT $3`,
      [actor.profileId, OPEN_STATUSES, limit]
    )

    const awaitingApproval = rows.filter((r) => r.status === 'awaiting_approval').length
    return {
      ok: true,
      count: rows.length,
      awaitingApproval,
      note: rows.length === 0 ? 'No open maintenance requests need attention.' : undefined,
      requests: rows.map((r) => ({
        requestId: r.id, // pass to approve_maintenance_request
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
