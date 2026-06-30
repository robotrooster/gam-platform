import { Router } from 'express'
import { z } from 'zod'
import { query, queryOne, getClient } from '../db'
import { requireAuth, requirePerm } from '../middleware/auth'
import { canAccessLandlordResource, canManageLandlordResource } from '../middleware/scope'
import { AppError } from '../middleware/errorHandler'
import { routeMaintenanceNotification, notifyMaintenanceUpdated } from '../services/notifications'
import { createMaintenanceRequest } from '../services/maintenanceRequests'
import { PLATFORM_FEES, MAINTENANCE_PRIORITIES } from '@gam/shared'
import {
  classifyMaintenanceTier,
  emitMaintenanceResolvedEvents,
} from '../services/creditLedgerEmitters'
import { logger } from '../lib/logger'

export const maintenanceRouter = Router()
maintenanceRouter.use(requireAuth)

// GET /api/maintenance
maintenanceRouter.get('/', async (req, res, next) => {
  try {
    const params: any[] = []
    const unitFilter = req.query.unitId
      ? `AND mr.unit_id = $${params.push(req.query.unitId)}`
      : ''
    // S69: explicit branches per role. Pre-S69 used `role !== 'admin'`,
    // which (a) trapped super_admin into a profileId filter, and (b)
    // routed team-role users (PM, onsite_manager, maintenance) to the
    // same wrong branch.
    const role = req.user!.role
    let roleFilter = ''
    if (role === 'tenant') {
      roleFilter = `AND mr.tenant_id = $${params.push(req.user!.profileId)}`
    } else if (role === 'landlord') {
      roleFilter = `AND mr.landlord_id = $${params.push(req.user!.profileId)}`
    } else if (role === 'property_manager' || role === 'onsite_manager' || role === 'maintenance') {
      if (!req.user!.landlordId) return res.json({ success: true, data: [] })
      roleFilter = `AND mr.landlord_id = $${params.push(req.user!.landlordId)}`
    } else if (role !== 'admin' && role !== 'super_admin') {
      // Unknown role — empty rather than leak.
      return res.json({ success: true, data: [] })
    }

    const requests = await query<any>(`
      SELECT mr.*,
        u.unit_number, p.name as property_name,
        tu.first_name as tenant_first, tu.last_name as tenant_last,
        au.first_name as assigned_first, au.last_name as assigned_last,
        (SELECT COUNT(*) FROM maintenance_comments mc WHERE mc.request_id = mr.id) as comment_count
      FROM maintenance_requests mr
      JOIN units u ON u.id = mr.unit_id
      JOIN properties p ON p.id = u.property_id
      LEFT JOIN tenants t ON t.id = mr.tenant_id
      LEFT JOIN users tu ON tu.id = t.user_id
      LEFT JOIN users au ON au.id = mr.contractor_id
      WHERE 1=1 ${roleFilter} ${unitFilter}
      ORDER BY
        CASE mr.priority WHEN 'emergency' THEN 1 WHEN 'high' THEN 2 WHEN 'normal' THEN 3 ELSE 4 END,
        mr.created_at DESC`, params)
    res.json({ success: true, data: requests })
  } catch (e) { next(e) }
})

// GET /api/maintenance/:id
maintenanceRouter.get('/:id', async (req, res, next) => {
  try {
    const request = await queryOne<any>(`
      SELECT mr.*,
        u.unit_number, u.rent_amount, p.name as property_name, p.street1, p.city,
        tu.first_name as tenant_first, tu.last_name as tenant_last,
        tu.email as tenant_email, tu.phone as tenant_phone,
        au.first_name as assigned_first, au.last_name as assigned_last, au.email as assigned_email
      FROM maintenance_requests mr
      JOIN units u ON u.id = mr.unit_id
      JOIN properties p ON p.id = u.property_id
      LEFT JOIN tenants t ON t.id = mr.tenant_id
      LEFT JOIN users tu ON tu.id = t.user_id
      LEFT JOIN users au ON au.id = mr.contractor_id
      WHERE mr.id = $1`, [req.params.id])
    if (!request) throw new AppError(404, 'Request not found')

    // S69: pre-S69 had no scope check on this endpoint at all — any
    // authenticated user could read any maintenance request.
    if (req.user!.role === 'tenant') {
      if (request.tenant_id !== req.user!.profileId) {
        throw new AppError(403, 'Forbidden')
      }
    } else if (!canAccessLandlordResource(req.user, request.landlord_id)) {
      throw new AppError(403, 'Forbidden')
    }

    const comments = await query<any>(`
      SELECT mc.*, u.first_name, u.last_name, u.role
      FROM maintenance_comments mc
      JOIN users u ON u.id = mc.user_id
      WHERE mc.request_id = $1
      ${req.user!.role === 'tenant' ? "AND mc.is_internal = FALSE" : ''}
      ORDER BY mc.created_at ASC`, [req.params.id])

    res.json({ success: true, data: { ...request, comments } })
  } catch (e) { next(e) }
})

// POST /api/maintenance — create request (tenant or landlord)
maintenanceRouter.post('/', async (req, res, next) => {
  try {
    const body = z.object({
      unitId:      z.string().uuid(),
      title:       z.string().min(3),
      description: z.string().min(5),
      priority:    z.enum(MAINTENANCE_PRIORITIES).default('normal'),
      photos:      z.array(z.string()).optional(),
    }).parse(req.body)

    // Create via the shared service (same path the agent's
    // file_maintenance_request tool uses — one source of truth).
    const request = await createMaintenanceRequest({
      unitId:      body.unitId,
      title:       body.title,
      description: body.description,
      priority:    body.priority,
      photos:      body.photos,
      actor: {
        userId:    req.user!.userId,
        role:      req.user!.role,
        profileId: req.user!.profileId,
      },
    })

    res.status(201).json({ success: true, data: request })
  } catch (e) { next(e) }
})

// PATCH /api/maintenance/:id — update status, assign, add cost, approve
maintenanceRouter.patch('/:id', requirePerm('work_orders.complete', 'work_orders.reassign', 'maintenance.approve_above_threshold'), async (req, res, next) => {
  try {
    const { status: rawStatus, assignedTo, estimatedCost, actualCost, scheduledAt, landlordNotes, manHours } = req.body

    const request = await queryOne<any>(
      'SELECT * FROM maintenance_requests WHERE id=$1', [req.params.id])
    if (!request) throw new AppError(404, 'Request not found')
    if (!canManageLandlordResource(req.user, request.landlord_id)) {
      throw new AppError(403, 'Forbidden')
    }

    // Auto-approval gate: if a new estimated cost is being set AND it exceeds the
    // landlord's threshold AND the caller didn't explicitly pick a status, flip to
    // awaiting_approval. If the estimate is below the threshold, leave the status alone.
    let effectiveStatus: string | null = rawStatus || null
    const estimatedCostNum = estimatedCost != null ? Number(estimatedCost) : null
    const estimateIsNew = estimatedCostNum != null && estimatedCostNum !== Number(request.estimated_cost || 0)

    if (estimateIsNew && !rawStatus && request.status !== 'awaiting_approval') {
      const landlord = await queryOne<any>(
        'SELECT maint_approval_threshold FROM landlords WHERE id=$1',
        [request.landlord_id])
      const threshold = Number(landlord?.maint_approval_threshold ?? 500)
      if (estimatedCostNum > threshold) {
        effectiveStatus = 'awaiting_approval'
      }
    }

    const platformFee = actualCost ? actualCost * PLATFORM_FEES.MAINTENANCE_PCT : null

    const updated = await queryOne<any>(`
      UPDATE maintenance_requests SET
        status         = COALESCE($1, status),
        contractor_id  = COALESCE($2, contractor_id),
        assigned_at    = CASE WHEN $2 IS NOT NULL THEN NOW() ELSE assigned_at END,
        estimated_cost = COALESCE($3, estimated_cost),
        actual_cost    = COALESCE($4, actual_cost),
        platform_fee   = COALESCE($5, platform_fee),
        scheduled_at   = COALESCE($6, scheduled_at),
        landlord_notes = COALESCE($7, landlord_notes),
        man_hours      = COALESCE($9, man_hours),
        completed_at   = CASE WHEN $1 = 'completed' THEN NOW() ELSE completed_at END,
        updated_at     = NOW()
      WHERE id=$8 RETURNING *`,
      [effectiveStatus, assignedTo||null, estimatedCostNum,
       actualCost||null, platformFee, scheduledAt||null,
       landlordNotes||null, req.params.id, manHours||null])

    // Auto-add status change comment
    if (effectiveStatus && effectiveStatus !== request.status) {
      const statusLabels: Record<string, string> = {
        awaiting_approval: `Estimated cost ${estimatedCostNum != null ? '$' + estimatedCostNum : ''} exceeds approval threshold — awaiting landlord approval`,
        assigned: 'Request assigned to maintenance',
        in_progress: 'Work in progress',
        completed: `Work completed${actualCost ? ` — cost: $${actualCost}` : ''}`,
        cancelled: 'Request cancelled',
      }
      await query(`INSERT INTO maintenance_comments (request_id, user_id, role, message, is_internal)
        VALUES ($1,$2,'landlord',$3,FALSE)`,
        [req.params.id, req.user!.userId, statusLabels[effectiveStatus] || `Status updated to ${effectiveStatus}`])
    }

    // Notify tenant on status change (skip awaiting_approval — tenants don't need to see internal approval flow)
    try {
      if (effectiveStatus && effectiveStatus !== request.status && effectiveStatus !== 'awaiting_approval') {
        const tenant = await queryOne<any>(`SELECT u.id, u.email, u.phone FROM users u JOIN tenants t ON t.user_id=u.id WHERE t.id=$1`, [request.tenant_id])
        const unit = await queryOne<any>(`SELECT unit_number FROM units WHERE id=$1`, [request.unit_id])
        if (tenant) await notifyMaintenanceUpdated({
          tenantUserId: tenant.id,
          tenantEmail: tenant.email,
          tenantPhone: tenant.phone,
          unitNumber: unit?.unit_number,
          requestTitle: request.title,
          newStatus: effectiveStatus,
          scheduledAt: scheduledAt,
          notes: landlordNotes
        })
      }
    } catch(e) { logger.error({ err: e }, '[NOTIFY] maintenance update:') }

    // Credit ledger: when the request transitions to 'completed', emit a
    // landlord-side resolution-tier event. Best-effort — failures get
    // logged but don't kill the response (PATCH already committed).
    if (
      effectiveStatus === 'completed' &&
      request.status !== 'completed' &&
      request.created_at
    ) {
      try {
        const tier = classifyMaintenanceTier({
          createdAt:  new Date(request.created_at),
          resolvedAt: new Date(),
        })
        const ledgerClient = await getClient()
        try {
          await emitMaintenanceResolvedEvents(ledgerClient, {
            landlordId:   request.landlord_id,
            requestId:    request.id,
            resolvedAt:   new Date(),
            responseTier: tier,
          })
        } finally {
          ledgerClient.release()
        }
      } catch (e) {
        logger.error({ err: e }, '[credit-ledger] maintenance resolved emit failed:')
      }
    }

    res.json({ success: true, data: updated })
  } catch (e) { next(e) }
})

// POST /api/maintenance/:id/approve — landlord approves a request in awaiting_approval
// Approval over the threshold is a financial/policy decision — landlord/admin only.
maintenanceRouter.post('/:id/approve', requirePerm('maintenance.approve_above_threshold'), async (req, res, next) => {
  try {
    const request = await queryOne<any>(
      'SELECT * FROM maintenance_requests WHERE id=$1', [req.params.id])
    if (!request) throw new AppError(404, 'Request not found')
    if (!canManageLandlordResource(req.user, request.landlord_id, ['property_manager'])) {
      throw new AppError(403, 'Forbidden')
    }
    if (request.status !== 'awaiting_approval') {
      throw new AppError(400, 'Request is not awaiting approval')
    }

    // Flip to 'assigned' if a contractor is already set, otherwise back to 'open'
    const nextStatus = request.contractor_id ? 'assigned' : 'open'
    const nowAssigned = nextStatus === 'assigned' ? ', assigned_at = COALESCE(assigned_at, NOW())' : ''

    const updated = await queryOne<any>(
      `UPDATE maintenance_requests SET status=$1${nowAssigned}, updated_at=NOW() WHERE id=$2 RETURNING *`,
      [nextStatus, req.params.id])

    await query(`INSERT INTO maintenance_comments (request_id, user_id, role, message, is_internal)
      VALUES ($1,$2,'landlord',$3,FALSE)`,
      [req.params.id, req.user!.userId, `Approved by landlord${request.estimated_cost ? ' — estimated cost: $' + request.estimated_cost : ''}`])

    // Notify tenant — their request is moving forward
    try {
      const tenant = await queryOne<any>(`SELECT u.id, u.email, u.phone FROM users u JOIN tenants t ON t.user_id=u.id WHERE t.id=$1`, [request.tenant_id])
      const unit = await queryOne<any>(`SELECT unit_number FROM units WHERE id=$1`, [request.unit_id])
      if (tenant) await notifyMaintenanceUpdated({
        tenantUserId: tenant.id,
        tenantEmail: tenant.email,
        tenantPhone: tenant.phone,
        unitNumber: unit?.unit_number,
        requestTitle: request.title,
        newStatus: nextStatus,
        scheduledAt: undefined,
        notes: undefined
      })
    } catch(e) { logger.error({ err: e }, '[NOTIFY] maintenance approve:') }

    res.json({ success: true, data: updated })
  } catch (e) { next(e) }
})

// POST /api/maintenance/:id/comments — add comment
maintenanceRouter.post('/:id/comments', async (req, res, next) => {
  try {
    const { message, isInternal } = req.body
    if (!message?.trim()) return res.status(400).json({ success: false, error: 'Message required' })

    const request = await queryOne<any>('SELECT * FROM maintenance_requests WHERE id=$1', [req.params.id])
    if (!request) throw new AppError(404, 'Request not found')

    // S69: tenant can only comment on their own requests; everyone else
    // gated through the standard landlord-scope helper. Pre-S69 this
    // endpoint allowed any non-tenant authenticated user to comment on
    // any request platform-wide.
    if (req.user!.role === 'tenant') {
      if (request.tenant_id !== req.user!.profileId) {
        throw new AppError(403, 'Forbidden')
      }
    } else if (!canAccessLandlordResource(req.user, request.landlord_id)) {
      throw new AppError(403, 'Forbidden')
    }

    const role = ['landlord','property_manager','onsite_manager'].includes(req.user!.role)
      ? 'landlord' : req.user!.role === 'maintenance' ? 'maintenance' : 'tenant'

    const comment = await queryOne<any>(`
      INSERT INTO maintenance_comments (request_id, user_id, role, message, is_internal)
      VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [req.params.id, req.user!.userId, role, message.trim(),
       isInternal && role !== 'tenant' ? true : false])

    res.json({ success: true, data: comment })
  } catch (e) { next(e) }
})

// GET /api/maintenance/stats — summary for dashboard
// Scoped to whichever landlord the calling user belongs to. Admin sees
// platform-wide rollup. Team roles inherit their landlord's scope via the
// landlordId JWT claim.
maintenanceRouter.get('/stats/summary', requirePerm('work_orders.complete', 'work_orders.reassign', 'maintenance.approve_above_threshold'), async (req, res, next) => {
  try {
    const role = req.user!.role
    const isAdmin = role === 'admin' || role === 'super_admin'
    const params: any[] = []
    let where = ''
    if (role === 'landlord') {
      where = `WHERE landlord_id = $${params.push(req.user!.profileId)}`
    } else if (role === 'property_manager' || role === 'onsite_manager' || role === 'maintenance') {
      if (!req.user!.landlordId) return res.json({ success: true, data: {} })
      where = `WHERE landlord_id = $${params.push(req.user!.landlordId)}`
    } else if (!isAdmin) {
      return res.json({ success: true, data: {} })
    }
    const stats = await queryOne<any>(`
      SELECT
        COUNT(*) FILTER (WHERE status = 'open') as open_count,
        COUNT(*) FILTER (WHERE status = 'assigned') as assigned_count,
        COUNT(*) FILTER (WHERE status = 'in_progress') as in_progress_count,
        COUNT(*) FILTER (WHERE status = 'completed') as completed_count,
        COUNT(*) FILTER (WHERE priority = 'emergency' AND status != 'completed') as emergency_count,
        COALESCE(SUM(actual_cost) FILTER (WHERE status = 'completed'), 0) as total_cost
      FROM maintenance_requests ${where}`, params)
    res.json({ success: true, data: stats })
  } catch (e) { next(e) }
})
