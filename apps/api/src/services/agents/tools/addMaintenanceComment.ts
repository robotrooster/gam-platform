/**
 * Tool: add_maintenance_comment (tenant ACTION).
 *
 * Adds a follow-up comment from the tenant to one of their OWN maintenance
 * requests (e.g. "it's getting worse", "the part arrived"). Hard-scoped:
 * the request must have tenant_id = actor.profileId. Mirrors the tenant
 * branch of POST /api/maintenance/:id/comments — role 'tenant', never
 * internal. The requestId comes from get_my_maintenance_requests.
 */

import { query, queryOne } from '../../../db'
import type { AgentTool, AgentActor } from './types'

export const addMaintenanceComment: AgentTool = {
  name: 'add_maintenance_comment',
  description:
    'Add a follow-up note from the tenant to one of their own maintenance requests — e.g. to add ' +
    'detail, report it got worse, or share access info. Get the requestId from ' +
    'get_my_maintenance_requests first. Only works on the tenant’s own requests.',
  parameters: {
    type: 'object',
    properties: {
      requestId: { type: 'string', description: 'The id of the tenant’s request (from get_my_maintenance_requests).' },
      message: { type: 'string', description: 'The comment to add (the tenant’s words).' },
    },
    required: ['requestId', 'message'],
  },
  audiences: ['tenant'],

  async execute(args, actor: AgentActor) {
    const requestId = String(args.requestId ?? '').trim()
    const message = String(args.message ?? '').trim()
    if (!requestId) return { ok: false, error: 'A requestId is required (get it from get_my_maintenance_requests).' }
    if (!message) return { ok: false, error: 'There’s no comment to add — what would you like to say?' }

    // Must be THIS tenant's own request.
    const request = await queryOne<any>(
      'SELECT id, title FROM maintenance_requests WHERE id = $1 AND tenant_id = $2',
      [requestId, actor.profileId]
    )
    if (!request) return { ok: false, error: 'No such maintenance request on your account.' }

    await query(
      `INSERT INTO maintenance_comments (request_id, user_id, role, message, is_internal)
       VALUES ($1, $2, 'tenant', $3, FALSE)`,
      [requestId, actor.userId, message]
    )

    return { ok: true, requestId, title: request.title, message: 'Added your note to the request — your property team will see it.' }
  },
}
