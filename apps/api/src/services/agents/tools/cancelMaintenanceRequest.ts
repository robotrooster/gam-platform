/**
 * Tool: cancel_maintenance_request (tenant ACTION).
 *
 * Lets a tenant cancel one of their OWN maintenance requests — but only
 * while it's still 'open' or 'awaiting_approval' (before a worker has been
 * assigned and work has started). Once assigned/in progress, the tenant
 * adds a comment or contacts the landlord instead of unilaterally cancelling.
 * Hard-scoped: tenant_id = actor.profileId. The requestId comes from
 * get_my_maintenance_requests.
 */

import { query, queryOne } from '../../../db'
import type { AgentTool, AgentActor } from './types'

// Cancellable by the tenant only before any work is engaged.
const TENANT_CANCELLABLE = ['open', 'awaiting_approval']

export const cancelMaintenanceRequest: AgentTool = {
  name: 'cancel_maintenance_request',
  description:
    'Cancel one of the tenant’s own maintenance requests they no longer need — only works while the ' +
    'request is still open or awaiting approval (not once it’s been assigned or work has started). ' +
    'Get the requestId from get_my_maintenance_requests. Confirm with the tenant before cancelling.',
  parameters: {
    type: 'object',
    properties: {
      requestId: { type: 'string', description: 'The id of the tenant’s request to cancel (from get_my_maintenance_requests).' },
    },
    required: ['requestId'],
  },
  audiences: ['tenant'],

  async execute(args, actor: AgentActor) {
    const requestId = String(args.requestId ?? '').trim()
    if (!requestId) return { ok: false, error: 'A requestId is required (get it from get_my_maintenance_requests).' }

    const request = await queryOne<any>(
      'SELECT id, title, status FROM maintenance_requests WHERE id = $1 AND tenant_id = $2',
      [requestId, actor.profileId]
    )
    if (!request) return { ok: false, error: 'No such maintenance request on your account.' }
    if (!TENANT_CANCELLABLE.includes(request.status)) {
      return {
        ok: false,
        error: `That request is "${request.status}" — it’s already being handled, so it can’t be cancelled here. Add a note to it or contact your property team instead.`,
      }
    }

    // Self-scoped write: re-assert ownership + the cancellable states, so a
    // request that got assigned between the read and the write isn't pulled
    // out from under an engaged worker.
    const updated = await queryOne<any>(
      `UPDATE maintenance_requests SET status = 'cancelled', updated_at = NOW()
        WHERE id = $1 AND tenant_id = $2 AND status = ANY($3) RETURNING id`,
      [requestId, actor.profileId, TENANT_CANCELLABLE]
    )
    if (!updated) return { ok: false, error: 'That request was just updated — it may now be in progress. Please re-check before cancelling.' }

    await query(
      `INSERT INTO maintenance_comments (request_id, user_id, role, message, is_internal)
       VALUES ($1, $2, 'tenant', 'Cancelled by tenant', FALSE)`,
      [requestId, actor.userId]
    )

    return { ok: true, requestId, title: request.title, newStatus: 'cancelled', message: `Cancelled “${request.title}”.` }
  },
}
