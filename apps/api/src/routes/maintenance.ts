import { Router } from 'express'
import { z } from 'zod'
import { query, queryOne } from '../db'
import { requireAuth, requireLandlord } from '../middleware/auth'
import { AppError } from '../middleware/errorHandler'
import { routeMaintenanceNotification, notifyMaintenanceUpdated } from '../services/notifications'
import { PLATFORM_FEES, MAINTENANCE_PRIORITIES } from '@gam/shared'

export const maintenanceRouter = Router()
maintenanceRouter.use(requireAuth)

// GET /api/maintenance
maintenanceRouter.get('/', async (req, res, next) => {
  try {
    const unitFilter = req.query.unitId ? `AND mr.unit_id = '${req.query.unitId}'` : ''
    const roleFilter = req.user!.role === 'tenant'
      ? `AND mr.tenant_id = '${req.user!.profileId}'`
      : req.user!.role !== 'admin'
        ? `AND mr.landlord_id = '${req.user!.profileId}'`
        : ''

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
        mr.created_at DESC`)
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

    // Get unit and landlord
    const unit = await queryOne<any>('SELECT * FROM units WHERE id=$1', [body.unitId])
    if (!unit) throw new AppError(404, 'Unit not found')

    // Verify access — tenant must be on an active lease for this unit (primary or co-tenant)
    if (req.user!.role === 'tenant') {
      const onUnit = await queryOne<any>(`
        SELECT 1 FROM v_lease_active_tenants vlat
        JOIN leases l ON l.id = vlat.lease_id AND l.status = 'active'
        WHERE l.unit_id = $1 AND vlat.tenant_id = $2 LIMIT 1`,
        [body.unitId, req.user!.profileId])
      if (!onUnit) throw new AppError(403, 'You are not assigned to this unit')
    }

    // Attribution: tenant filing → themselves; landlord filing → primary tenant on the unit
    let tenantId: string | null
    if (req.user!.role === 'tenant') {
      tenantId = req.user!.profileId
    } else {
      const occ = await queryOne<any>(
        `SELECT primary_tenant_id FROM v_unit_occupancy WHERE unit_id = $1`,
        [body.unitId])
      tenantId = occ?.primary_tenant_id || null
    }

    const request = await queryOne<any>(`
      INSERT INTO maintenance_requests
        (unit_id, tenant_id, landlord_id, title, description, priority, photos)
      VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [body.unitId, tenantId || null, unit.landlord_id,
       body.title, body.description, body.priority,
       body.photos || []])

    // Auto-add first comment
    await query(`INSERT INTO maintenance_comments (request_id, user_id, role, message)
      VALUES ($1,$2,$3,$4)`,
      [request!.id, req.user!.userId,
       req.user!.role === 'tenant' ? 'tenant' : 'landlord',
       `Request submitted: ${body.description}`])

    // Notify landlord
    try {
      const landlord = await queryOne<any>(`SELECT u.email, u.first_name, l.id as landlord_id, u.id as user_id FROM landlords l JOIN users u ON u.id=l.user_id WHERE l.id=$1`, [req.user!.profileId || request.landlord_id])
      const tenant = await queryOne<any>(`SELECT u.first_name, u.last_name FROM users u JOIN tenants t ON t.user_id=u.id WHERE t.id=$1`, [request.tenant_id])
      const unit = await queryOne<any>(`SELECT unit_number, p.name as property_name FROM units u JOIN properties p ON p.id=u.property_id WHERE u.id=$1`, [request.unit_id])
      if (landlord && tenant && unit) {
        await routeMaintenanceNotification(request.id)
      }
    } catch(e) { console.error('[NOTIFY] maintenance submit:', e) }
    res.status(201).json({ success: true, data: request })
  } catch (e) { next(e) }
})

// PATCH /api/maintenance/:id — update status, assign, add cost, approve
maintenanceRouter.patch('/:id', requireLandlord, async (req, res, next) => {
  try {
    const { status: rawStatus, assignedTo, estimatedCost, actualCost, scheduledAt, landlordNotes, manHours } = req.body

    const request = await queryOne<any>(
      'SELECT * FROM maintenance_requests WHERE id=$1 AND landlord_id=$2',
      [req.params.id, req.user!.profileId])
    if (!request) throw new AppError(404, 'Request not found')

    // Auto-approval gate: if a new estimated cost is being set AND it exceeds the
    // landlord's threshold AND the caller didn't explicitly pick a status, flip to
    // awaiting_approval. If the estimate is below the threshold, leave the status alone.
    let effectiveStatus: string | null = rawStatus || null
    const estimatedCostNum = estimatedCost != null ? Number(estimatedCost) : null
    const estimateIsNew = estimatedCostNum != null && estimatedCostNum !== Number(request.estimated_cost || 0)

    if (estimateIsNew && !rawStatus && request.status !== 'awaiting_approval') {
      const landlord = await queryOne<any>(
        'SELECT maint_approval_threshold FROM landlords WHERE id=$1',
        [req.user!.profileId])
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
    } catch(e) { console.error('[NOTIFY] maintenance update:', e) }
    res.json({ success: true, data: updated })
  } catch (e) { next(e) }
})

// POST /api/maintenance/:id/approve — landlord approves a request in awaiting_approval
maintenanceRouter.post('/:id/approve', requireLandlord, async (req, res, next) => {
  try {
    const request = await queryOne<any>(
      'SELECT * FROM maintenance_requests WHERE id=$1 AND landlord_id=$2',
      [req.params.id, req.user!.profileId])
    if (!request) throw new AppError(404, 'Request not found')
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
    } catch(e) { console.error('[NOTIFY] maintenance approve:', e) }

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

    // Tenant can only comment on their own requests
    if (req.user!.role === 'tenant' && request.tenant_id !== req.user!.profileId) {
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
maintenanceRouter.get('/stats/summary', requireLandlord, async (req, res, next) => {
  try {
    const stats = await queryOne<any>(`
      SELECT
        COUNT(*) FILTER (WHERE status = 'open') as open_count,
        COUNT(*) FILTER (WHERE status = 'assigned') as assigned_count,
        COUNT(*) FILTER (WHERE status = 'in_progress') as in_progress_count,
        COUNT(*) FILTER (WHERE status = 'completed') as completed_count,
        COUNT(*) FILTER (WHERE priority = 'emergency' AND status != 'completed') as emergency_count,
        COALESCE(SUM(actual_cost) FILTER (WHERE status = 'completed'), 0) as total_cost,
        COALESCE(SUM(platform_fee) FILTER (WHERE status = 'completed'), 0) as total_fees
      FROM maintenance_requests WHERE landlord_id = $1`, [req.user!.profileId])
    res.json({ success: true, data: stats })
  } catch (e) { next(e) }
})
