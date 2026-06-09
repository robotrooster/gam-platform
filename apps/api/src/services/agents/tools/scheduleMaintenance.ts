/**
 * Tool: schedule_maintenance (landlord ACTION).
 *
 * Sets the scheduled date/time on one of the landlord's OWN maintenance
 * requests and notifies the tenant when the work is coming. Hard-scoped:
 * the request must have landlord_id = actor.profileId and not be
 * completed/cancelled. Mirrors the scheduledAt path of
 * PATCH /api/maintenance/:id (sets scheduled_at; status unchanged —
 * scheduling is independent of assignment). The requestId comes from
 * get_pending_maintenance.
 */

import { query, queryOne } from '../../../db'
import { notifyMaintenanceUpdated } from '../../notifications'
import { logger } from '../../../lib/logger'
import type { AgentTool, AgentActor } from './types'

export const scheduleMaintenance: AgentTool = {
  name: 'schedule_maintenance',
  description:
    'Set when a maintenance request is scheduled to happen, so the tenant knows when to expect the ' +
    'work. Pass scheduledAt as an ISO date-time (e.g. "2026-06-13T09:00:00"). Get the requestId from ' +
    'get_pending_maintenance. Only works on the landlord’s own requests that aren’t completed or ' +
    'cancelled. Confirm the date with the landlord first — this notifies the tenant.',
  parameters: {
    type: 'object',
    properties: {
      requestId: { type: 'string', description: 'The id of the request to schedule (from get_pending_maintenance).' },
      scheduledAt: { type: 'string', description: 'When the work is scheduled, as an ISO date-time string (e.g. "2026-06-13T09:00:00").' },
    },
    required: ['requestId', 'scheduledAt'],
  },
  audiences: ['landlord'],

  async execute(args, actor: AgentActor) {
    const requestId = String(args.requestId ?? '').trim()
    const scheduledAt = String(args.scheduledAt ?? '').trim()
    if (!requestId) return { ok: false, error: 'A requestId is required (get it from get_pending_maintenance).' }
    const when = new Date(scheduledAt)
    if (!scheduledAt || Number.isNaN(when.getTime())) {
      return { ok: false, error: 'Provide a valid date/time for the work (e.g. "2026-06-13T09:00").' }
    }

    const request = await queryOne<any>(
      'SELECT * FROM maintenance_requests WHERE id = $1 AND landlord_id = $2',
      [requestId, actor.profileId]
    )
    if (!request) return { ok: false, error: 'No such maintenance request for your account.' }
    if (request.status === 'completed' || request.status === 'cancelled') {
      return { ok: false, error: `That request is "${request.status}" — it can’t be scheduled.` }
    }

    // Self-scoped write: re-assert ownership + exclude terminal states.
    const updated = await queryOne<any>(
      `UPDATE maintenance_requests SET scheduled_at = $1, updated_at = NOW()
        WHERE id = $2 AND landlord_id = $3 AND status NOT IN ('completed','cancelled') RETURNING *`,
      [when.toISOString(), requestId, actor.profileId]
    )
    if (!updated) return { ok: false, error: 'That request was just updated — please re-check its status first.' }

    await query(
      `INSERT INTO maintenance_comments (request_id, user_id, role, message, is_internal)
       VALUES ($1, $2, 'landlord', $3, FALSE)`,
      [requestId, actor.userId, `Scheduled for ${when.toISOString()}`]
    )

    // Tell the tenant when to expect the work (best-effort).
    if (request.tenant_id) {
      try {
        const tenant = await queryOne<any>(
          `SELECT u.id, u.email, u.phone FROM users u JOIN tenants t ON t.user_id = u.id WHERE t.id = $1`,
          [request.tenant_id]
        )
        const unit = await queryOne<any>(`SELECT unit_number FROM units WHERE id = $1`, [request.unit_id]).catch(() => null)
        if (tenant) {
          await notifyMaintenanceUpdated({
            tenantUserId: tenant.id, tenantEmail: tenant.email, tenantPhone: tenant.phone,
            unitNumber: unit?.unit_number, requestTitle: request.title, newStatus: request.status,
            scheduledAt: when.toISOString(), notes: undefined,
          })
        }
      } catch (e) {
        logger.error({ err: e }, '[agent] maintenance schedule — notify tenant')
      }
    }

    return { ok: true, requestId, title: request.title, scheduledAt: when.toISOString(), message: `Scheduled “${request.title}” — the tenant has been notified.` }
  },
}
