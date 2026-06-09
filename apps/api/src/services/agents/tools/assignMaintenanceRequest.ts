/**
 * Tool: assign_maintenance_request (landlord ACTION).
 *
 * Assigns one of the landlord's OWN maintenance requests to a worker on the
 * landlord's maintenance team. Doubly hard-scoped:
 *   - the request must have landlord_id = actor.profileId
 *   - the worker must be on the SAME landlord's maintenance team
 *     (maintenance_worker_scopes.landlord_id = actor.profileId)
 * so the model can neither touch another landlord's request nor assign an
 * arbitrary user. maintenance_requests.contractor_id references users.id
 * (the team worker), NOT the platform `contractors` marketplace.
 *
 * The model gives the worker by NAME (it never sees user ids); we resolve
 * it within the team and ask to disambiguate on multiple matches — the
 * same shape as lookup_tenant_payment_status. Mirrors the assign path of
 * PATCH /api/maintenance/:id: set contractor_id + assigned_at, move
 * open→assigned (an awaiting_approval request keeps that status — the
 * worker is recorded and approval then auto-flips it to assigned), add an
 * assignment comment, notify the worker (and the tenant when it goes live).
 */

import { query, queryOne } from '../../../db'
import { createNotification, notifyMaintenanceUpdated } from '../../notifications'
import { logger } from '../../../lib/logger'
import type { AgentTool, AgentActor } from './types'

interface TeamWorker {
  user_id: string
  first_name: string | null
  last_name: string | null
  email: string | null
  phone: string | null
}

function workerName(w: TeamWorker): string {
  return [w.first_name, w.last_name].filter(Boolean).join(' ') || 'the worker'
}

export const assignMaintenanceRequest: AgentTool = {
  name: 'assign_maintenance_request',
  description:
    'Assign a maintenance request to one of the landlord’s own maintenance-team workers, so they ' +
    'can start the job. Give the worker by name (e.g. “assign it to Mike”); get the requestId from ' +
    'get_pending_maintenance and, if unsure who is available, the team from get_maintenance_team. ' +
    'Only works on the landlord’s own requests and their own team. Confirm the request and the ' +
    'worker with the landlord before assigning — this notifies the worker to begin.',
  parameters: {
    type: 'object',
    properties: {
      requestId: { type: 'string', description: 'The id of the request to assign (from get_pending_maintenance).' },
      workerName: { type: 'string', description: 'The name of the team worker to assign it to (e.g. "Mike" or "Mike Diaz").' },
      workerId: { type: 'string', description: 'The worker’s id from get_maintenance_team. Use this instead of workerName when you already have it (e.g. to resolve a disambiguation).' },
    },
    required: ['requestId'],
  },
  audiences: ['landlord'],

  async execute(args, actor: AgentActor) {
    const requestId = String(args.requestId ?? '').trim()
    const workerId = String(args.workerId ?? '').trim()
    const workerNameArg = String(args.workerName ?? '').trim()
    if (!requestId) return { ok: false, error: 'A requestId is required (get it from get_pending_maintenance).' }
    if (!workerId && !workerNameArg) {
      return { ok: false, error: 'Tell me who to assign it to — a worker’s name. Use get_maintenance_team to see who’s available.' }
    }

    // 1) The request must be THIS landlord's, and still assignable.
    const request = await queryOne<any>(
      'SELECT * FROM maintenance_requests WHERE id = $1 AND landlord_id = $2',
      [requestId, actor.profileId]
    )
    if (!request) return { ok: false, error: 'No such maintenance request for your account.' }
    if (request.status === 'completed' || request.status === 'cancelled') {
      return { ok: false, error: `That request is "${request.status}" — it can’t be assigned.` }
    }

    // 2) Resolve the worker WITHIN this landlord's maintenance team.
    let worker: TeamWorker | null = null
    if (workerId) {
      worker = await queryOne<TeamWorker>(
        `SELECT DISTINCT s.user_id, u.first_name, u.last_name, u.email, u.phone
           FROM maintenance_worker_scopes s JOIN users u ON u.id = s.user_id
          WHERE s.landlord_id = $1 AND s.user_id = $2`,
        [actor.profileId, workerId]
      )
      if (!worker) return { ok: false, error: 'That worker isn’t on your maintenance team.' }
    } else {
      const matches = await query<TeamWorker>(
        `SELECT DISTINCT s.user_id, u.first_name, u.last_name, u.email, u.phone
           FROM maintenance_worker_scopes s JOIN users u ON u.id = s.user_id
          WHERE s.landlord_id = $1
            AND (u.first_name ILIKE $2 OR u.last_name ILIKE $2
                 OR (COALESCE(u.first_name,'') || ' ' || COALESCE(u.last_name,'')) ILIKE $2)`,
        [actor.profileId, `%${workerNameArg}%`]
      )
      if (matches.length === 0) {
        return { ok: false, error: `No worker named “${workerNameArg}” is on your maintenance team. Use get_maintenance_team to see who’s available.` }
      }
      if (matches.length > 1) {
        return {
          ok: false,
          needsDisambiguation: true,
          message: `More than one team worker matches “${workerNameArg}”. Ask the landlord which one, then call again with their workerId.`,
          candidates: matches.map((m) => ({ workerId: m.user_id, name: workerName(m) })),
        }
      }
      worker = matches[0]
    }

    // 3) open → assigned. awaiting_approval keeps its status (recording the
    //    worker; the approve step flips it to assigned because contractor_id
    //    is now set). assigned / in_progress = a reassignment, status kept.
    const newStatus = request.status === 'open' ? 'assigned' : request.status

    // Self-scoped write: re-assert ownership + exclude closed states in the
    // UPDATE so a row whose owner/state changed between read and write can't
    // be mutated, and a concurrent close finds no matching row.
    const updated = await queryOne<any>(
      `UPDATE maintenance_requests
          SET contractor_id = $1, status = $2, assigned_at = NOW(), updated_at = NOW()
        WHERE id = $3 AND landlord_id = $4 AND status NOT IN ('completed','cancelled')
        RETURNING *`,
      [worker.user_id, newStatus, requestId, actor.profileId]
    )
    if (!updated) return { ok: false, error: 'That request was just updated — please re-check its status before assigning.' }

    const name = workerName(worker)
    await query(
      `INSERT INTO maintenance_comments (request_id, user_id, role, message, is_internal)
       VALUES ($1, $2, 'landlord', $3, FALSE)`,
      [requestId, actor.userId, `Assigned to ${name}`]
    )

    const unit = await queryOne<any>(`SELECT unit_number FROM units WHERE id = $1`, [request.unit_id]).catch(() => null)
    const unitLabel = unit?.unit_number ? ` (unit ${unit.unit_number})` : ''

    // Notify the assigned worker (best-effort, respects their prefs).
    try {
      await createNotification({
        userId: worker.user_id,
        landlordId: actor.profileId,
        type: 'maintenance_assigned',
        title: `New work order: ${request.title}`,
        body: `You’ve been assigned a ${request.priority} maintenance request${unitLabel}: ${request.title}.`,
        data: { requestId, priority: request.priority, category: request.category },
        sendEmail: true,
        emailTo: worker.email || undefined,
        emailSubject: `New work order assigned — ${request.title}`,
        emailHtml: `<p>You’ve been assigned a <b>${request.priority}</b> maintenance request${unitLabel}:</p><p><b>${request.title}</b></p><p>${request.description || ''}</p>`,
      })
    } catch (e) {
      logger.error({ err: e }, '[agent] maintenance assign — notify worker')
    }

    // If it went live (open → assigned), tell the tenant their request is moving.
    if (newStatus === 'assigned' && request.tenant_id) {
      try {
        const tenant = await queryOne<any>(
          `SELECT u.id, u.email, u.phone FROM users u JOIN tenants t ON t.user_id = u.id WHERE t.id = $1`,
          [request.tenant_id]
        )
        if (tenant) {
          await notifyMaintenanceUpdated({
            tenantUserId: tenant.id, tenantEmail: tenant.email, tenantPhone: tenant.phone,
            unitNumber: unit?.unit_number, requestTitle: request.title, newStatus: 'assigned',
            scheduledAt: undefined, notes: undefined,
          })
        }
      } catch (e) {
        logger.error({ err: e }, '[agent] maintenance assign — notify tenant')
      }
    }

    return {
      ok: true,
      requestId,
      title: request.title,
      assignedTo: name,
      newStatus: updated.status,
      message: `Assigned “${request.title}” to ${name}${newStatus === 'assigned' ? ' — they’ve been notified to begin' : ` (status stays "${updated.status}")`}.`,
    }
  },
}
