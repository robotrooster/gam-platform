/**
 * Tool: reject_maintenance_request (landlord ACTION).
 *
 * Declines / cancels one of the landlord's OWN maintenance requests — the
 * counterpart to approve_maintenance_request. Hard-scoped: the request must
 * have landlord_id = actor.profileId and not already be completed/cancelled.
 * Sets status = 'cancelled', records the reason as a comment, and notifies
 * the tenant. The requestId comes from get_pending_maintenance.
 */

import { query, queryOne } from '../../../db'
import { notifyMaintenanceUpdated } from '../../notifications'
import { logger } from '../../../lib/logger'
import type { AgentTool, AgentActor } from './types'

export const rejectMaintenanceRequest: AgentTool = {
  name: 'reject_maintenance_request',
  description:
    'Decline or cancel a maintenance request — e.g. reject one awaiting the landlord’s approval, or ' +
    'cancel one that’s no longer needed. Only works on the landlord’s own requests that aren’t ' +
    'already completed or cancelled. Get the requestId from get_pending_maintenance. Always confirm ' +
    'with the landlord first (and capture a brief reason) — this cancels the work and notifies the tenant.',
  parameters: {
    type: 'object',
    properties: {
      requestId: { type: 'string', description: 'The id of the request to decline/cancel (from get_pending_maintenance).' },
      reason: { type: 'string', description: 'Optional short reason, recorded on the request and shown to the tenant context.' },
    },
    required: ['requestId'],
  },
  audiences: ['landlord'],

  async execute(args, actor: AgentActor) {
    const requestId = String(args.requestId ?? '').trim()
    const reason = String(args.reason ?? '').trim()
    if (!requestId) return { ok: false, error: 'A requestId is required (get it from get_pending_maintenance).' }

    const request = await queryOne<any>(
      'SELECT * FROM maintenance_requests WHERE id = $1 AND landlord_id = $2',
      [requestId, actor.profileId]
    )
    if (!request) return { ok: false, error: 'No such maintenance request for your account.' }
    if (request.status === 'completed' || request.status === 'cancelled') {
      return { ok: false, error: `That request is already "${request.status}".` }
    }

    // Self-scoped write: re-assert ownership + exclude terminal states so a
    // row whose owner/state changed between read and write can't be mutated,
    // and a concurrent close finds no matching row (no double comment/notify).
    const updated = await queryOne<any>(
      `UPDATE maintenance_requests SET status = 'cancelled', updated_at = NOW()
        WHERE id = $1 AND landlord_id = $2 AND status NOT IN ('completed','cancelled') RETURNING *`,
      [requestId, actor.profileId]
    )
    if (!updated) return { ok: false, error: 'That request was just updated — please re-check its status first.' }

    await query(
      `INSERT INTO maintenance_comments (request_id, user_id, role, message, is_internal)
       VALUES ($1, $2, 'landlord', $3, FALSE)`,
      [requestId, actor.userId, `Declined by landlord${reason ? ` — ${reason}` : ''}`]
    )

    // Notify the tenant their request was cancelled (best-effort).
    try {
      const tenant = request.tenant_id
        ? await queryOne<any>(`SELECT u.id, u.email, u.phone FROM users u JOIN tenants t ON t.user_id = u.id WHERE t.id = $1`, [request.tenant_id])
        : null
      const unit = await queryOne<any>(`SELECT unit_number FROM units WHERE id = $1`, [request.unit_id]).catch(() => null)
      if (tenant) {
        await notifyMaintenanceUpdated({
          tenantUserId: tenant.id, tenantEmail: tenant.email, tenantPhone: tenant.phone,
          unitNumber: unit?.unit_number, requestTitle: request.title, newStatus: 'cancelled',
          scheduledAt: undefined, notes: reason || undefined,
        })
      }
    } catch (e) {
      logger.error({ err: e }, '[agent] maintenance reject — notify tenant')
    }

    return { ok: true, requestId, title: request.title, newStatus: 'cancelled', message: `Declined “${request.title}” — the tenant has been notified.` }
  },
}
