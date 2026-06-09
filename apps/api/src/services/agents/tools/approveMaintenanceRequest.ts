/**
 * Tool: approve_maintenance_request (landlord ACTION).
 *
 * Approves one of the landlord's OWN maintenance requests that is awaiting
 * approval. Hard-scoped: the request must have landlord_id = actor.profileId
 * AND status = 'awaiting_approval'. Mirrors POST /api/maintenance/:id/approve
 * (flip to assigned/open, add an approval comment, notify the tenant). The
 * request id comes from get_pending_maintenance.
 */

import { query, queryOne } from '../../../db'
import { notifyMaintenanceUpdated } from '../../notifications'
import { logger } from '../../../lib/logger'
import type { AgentTool, AgentActor } from './types'

export const approveMaintenanceRequest: AgentTool = {
  name: 'approve_maintenance_request',
  description:
    'Approve a maintenance request that is awaiting the landlord’s approval, so the work can move ' +
    'forward. Only works on the landlord’s own requests in the awaiting-approval state. Get the ' +
    'requestId from get_pending_maintenance first. Confirm with the landlord before approving — ' +
    'approving authorizes the work (and its cost).',
  parameters: {
    type: 'object',
    properties: { requestId: { type: 'string', description: 'The id of the awaiting-approval request (from get_pending_maintenance).' } },
    required: ['requestId'],
  },
  audiences: ['landlord'],

  async execute(args, actor: AgentActor) {
    const requestId = String(args.requestId ?? '').trim()
    if (!requestId) return { ok: false, error: 'A requestId is required.' }

    // Scope: must be THIS landlord's request, and awaiting approval.
    const request = await queryOne<any>(
      'SELECT * FROM maintenance_requests WHERE id = $1 AND landlord_id = $2',
      [requestId, actor.profileId]
    )
    if (!request) return { ok: false, error: 'No such maintenance request for your account.' }
    if (request.status !== 'awaiting_approval') {
      return { ok: false, error: `That request is "${request.status}", not awaiting approval.` }
    }

    const nextStatus = request.contractor_id ? 'assigned' : 'open'
    const nowAssigned = nextStatus === 'assigned' ? ', assigned_at = COALESCE(assigned_at, NOW())' : ''
    // Self-scoped write: re-assert ownership + the awaiting_approval state in
    // the UPDATE itself, so it cannot mutate a row whose owner/state changed
    // between the read and the write — and a concurrent second approve finds
    // no matching row (no double comment/notification).
    const updated = await queryOne<any>(
      `UPDATE maintenance_requests SET status = $1${nowAssigned}, updated_at = NOW()
        WHERE id = $2 AND landlord_id = $3 AND status = 'awaiting_approval' RETURNING *`,
      [nextStatus, requestId, actor.profileId]
    )
    if (!updated) return { ok: false, error: 'That request was just updated — please re-check its status before approving.' }
    await query(
      `INSERT INTO maintenance_comments (request_id, user_id, role, message, is_internal)
       VALUES ($1, $2, 'landlord', $3, FALSE)`,
      [requestId, actor.userId, `Approved by landlord${request.estimated_cost ? ' — estimated cost: $' + request.estimated_cost : ''}`]
    )

    // Notify the tenant their request is moving forward (best-effort).
    try {
      const tenant = await queryOne<any>(`SELECT u.id, u.email, u.phone FROM users u JOIN tenants t ON t.user_id = u.id WHERE t.id = $1`, [request.tenant_id])
      const unit = await queryOne<any>(`SELECT unit_number FROM units WHERE id = $1`, [request.unit_id])
      if (tenant) {
        await notifyMaintenanceUpdated({
          tenantUserId: tenant.id, tenantEmail: tenant.email, tenantPhone: tenant.phone,
          unitNumber: unit?.unit_number, requestTitle: request.title, newStatus: nextStatus,
          scheduledAt: undefined, notes: undefined,
        })
      }
    } catch (e) {
      logger.error({ err: e }, '[agent] maintenance approve notify')
    }

    return { ok: true, requestId, title: request.title, newStatus: updated.status, message: 'Approved — the request is moving forward and the tenant has been notified.' }
  },
}
