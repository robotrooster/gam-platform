import { Router } from 'express'
import { requireAuth, requirePerm } from '../middleware/auth'
import { query, queryOne } from '../db'
import { AppError } from '../middleware/errorHandler'

export const maintenancePortalRouter = Router()

// S81: pre-S81 every endpoint here was bare `requireAuth` — any tenant
// account could clock in, create tasks, approve purchase requests, etc.
// Each endpoint now gates on the appropriate maintenance/onsite_manager
// sub-permission. Owner roles (admin / super_admin / landlord) bypass.
maintenancePortalRouter.use(requireAuth)

// ── SHIFTS ────────────────────────────────────────────────────
maintenancePortalRouter.post('/shifts/clock-in', requirePerm('time.clock_in_out'), async (req, res, next) => {
  try {
    const active = await queryOne<any>('SELECT id FROM shifts WHERE user_id=$1 AND clocked_out_at IS NULL', [req.user!.userId])
    if (active) throw new AppError(400, 'Already clocked in')
    const shift = await queryOne<any>(
      'INSERT INTO shifts (user_id, landlord_id) VALUES ($1, $2) RETURNING *',
      [req.user!.userId, req.user!.profileId]
    )
    res.json({ success: true, data: shift })
  } catch(e) { next(e) }
})

maintenancePortalRouter.post('/shifts/clock-out', requirePerm('time.clock_in_out'), async (req, res, next) => {
  try {
    const shift = await queryOne<any>(
      'UPDATE shifts SET clocked_out_at=NOW(), notes=$1 WHERE user_id=$2 AND clocked_out_at IS NULL RETURNING *',
      [req.body.notes||null, req.user!.userId]
    )
    if (!shift) throw new AppError(400, 'Not clocked in')
    res.json({ success: true, data: shift })
  } catch(e) { next(e) }
})

maintenancePortalRouter.get('/shifts/active', requirePerm('time.clock_in_out'), async (req, res, next) => {
  try {
    const active = await query<any>(`
      SELECT s.*, u.first_name, u.last_name, u.email,
        EXTRACT(EPOCH FROM (NOW()-s.clocked_in_at))/3600 as hours_on_shift
      FROM shifts s JOIN users u ON u.id=s.user_id
      WHERE s.landlord_id=$1 AND s.clocked_out_at IS NULL
      ORDER BY s.clocked_in_at ASC`, [req.user!.profileId])
    const myShift = await queryOne<any>('SELECT * FROM shifts WHERE user_id=$1 AND clocked_out_at IS NULL', [req.user!.userId])
    res.json({ success: true, data: { active, myShift } })
  } catch(e) { next(e) }
})

// ── DAILY TASKS ───────────────────────────────────────────────
maintenancePortalRouter.get('/tasks', requirePerm('work_orders.create', 'work_orders.complete', 'work_orders.reassign', 'time.clock_in_out'), async (req, res, next) => {
  try {
    const tasks = await query<any>(`
      SELECT t.*, u.first_name||' '||u.last_name as assigned_name
      FROM daily_tasks t LEFT JOIN users u ON u.id=t.assigned_to
      WHERE t.landlord_id=$1 AND (t.due_date=CURRENT_DATE OR t.recurrence!='none')
      ORDER BY t.completed ASC, t.due_date ASC`, [req.user!.profileId])
    res.json({ success: true, data: tasks })
  } catch(e) { next(e) }
})

maintenancePortalRouter.post('/tasks', requirePerm('work_orders.create', 'work_orders.reassign'), async (req, res, next) => {
  try {
    const { title, description, assignedTo, dueDate, recurrence } = req.body
    const task = await queryOne<any>(
      'INSERT INTO daily_tasks (landlord_id, title, description, assigned_to, due_date, recurrence) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
      [req.user!.profileId, title, description||null, assignedTo||null, dueDate||null, recurrence||'none']
    )
    res.json({ success: true, data: task })
  } catch(e) { next(e) }
})

maintenancePortalRouter.patch('/tasks/:id/complete', requirePerm('work_orders.complete'), async (req, res, next) => {
  try {
    // S348: surface 404 when no matching landlord-scoped row exists, instead
    // of silently returning data:null.
    const task = await queryOne<any>(
      'UPDATE daily_tasks SET completed=TRUE, completed_at=NOW(), completed_by=$1 WHERE id=$2 AND landlord_id=$3 RETURNING *',
      [req.user!.userId, req.params.id, req.user!.profileId]
    )
    if (!task) throw new AppError(404, 'Task not found')
    res.json({ success: true, data: task })
  } catch(e) { next(e) }
})

// ── PARTS INVENTORY ───────────────────────────────────────────
maintenancePortalRouter.get('/parts', requirePerm('purchases.request', 'purchases.approve', 'work_orders.complete', 'unit_access.view'), async (req, res, next) => {
  try {
    const parts = await query<any>(
      'SELECT * FROM parts_inventory WHERE landlord_id=$1 ORDER BY name ASC',
      [req.user!.profileId]
    )
    res.json({ success: true, data: parts })
  } catch(e) { next(e) }
})

maintenancePortalRouter.post('/parts', requirePerm('purchases.request', 'purchases.approve'), async (req, res, next) => {
  try {
    const { name, description, sku, quantity, minQuantity, unit, location, cost } = req.body
    const part = await queryOne<any>(
      'INSERT INTO parts_inventory (landlord_id,name,description,sku,quantity,min_quantity,unit,location,cost) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *',
      [req.user!.profileId, name, description||null, sku||null, quantity||0, minQuantity||0, unit||'each', location||null, cost||null]
    )
    res.json({ success: true, data: part })
  } catch(e) { next(e) }
})

maintenancePortalRouter.patch('/parts/:id', requirePerm('purchases.request', 'purchases.approve'), async (req, res, next) => {
  try {
    const { quantity, name, minQuantity, location, cost } = req.body
    // S348: 404 instead of silent data:null when no matching row.
    const part = await queryOne<any>(
      'UPDATE parts_inventory SET quantity=COALESCE($1,quantity), name=COALESCE($2,name), min_quantity=COALESCE($3,min_quantity), location=COALESCE($4,location), cost=COALESCE($5,cost), updated_at=NOW() WHERE id=$6 AND landlord_id=$7 RETURNING *',
      [quantity, name, minQuantity, location, cost, req.params.id, req.user!.profileId]
    )
    if (!part) throw new AppError(404, 'Part not found')
    res.json({ success: true, data: part })
  } catch(e) { next(e) }
})

// ── PURCHASE REQUESTS ─────────────────────────────────────────
maintenancePortalRouter.get('/purchases', requirePerm('purchases.request', 'purchases.approve'), async (req, res, next) => {
  try {
    const purchases = await query<any>(`
      SELECT pr.*, u.first_name||' '||u.last_name as requested_by_name,
        au.first_name||' '||au.last_name as approved_by_name,
        mr.title as work_order_title
      FROM purchase_requests pr
      JOIN users u ON u.id=pr.requested_by
      LEFT JOIN users au ON au.id=pr.approved_by
      LEFT JOIN maintenance_requests mr ON mr.id=pr.work_order_id
      WHERE pr.landlord_id=$1
      ORDER BY pr.created_at DESC LIMIT 50`, [req.user!.profileId])
    res.json({ success: true, data: purchases })
  } catch(e) { next(e) }
})

maintenancePortalRouter.post('/purchases', requirePerm('purchases.request'), async (req, res, next) => {
  try {
    const { workOrderId, items, notes, totalEstimate } = req.body
    // S391 fix: workOrderId scope validation. Pre-fix the FK was
    // inserted unvalidated — a caller could link a purchase request
    // to another landlord's maintenance_request, and GET /purchases
    // would surface the cross-tenant work_order_title via the LEFT JOIN.
    if (workOrderId) {
      const ok = await queryOne<{ id: string }>(
        'SELECT id FROM maintenance_requests WHERE id=$1 AND landlord_id=$2',
        [workOrderId, req.user!.profileId]
      )
      if (!ok) throw new AppError(400, 'workOrderId does not belong to this landlord')
    }
    const pr = await queryOne<any>(
      'INSERT INTO purchase_requests (landlord_id,requested_by,work_order_id,items,notes,total_estimate) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
      [req.user!.profileId, req.user!.userId, workOrderId||null, JSON.stringify(items||[]), notes||null, totalEstimate||null]
    )
    res.json({ success: true, data: pr })
  } catch(e) { next(e) }
})

maintenancePortalRouter.patch('/purchases/:id/approve', requirePerm('purchases.approve'), async (req, res, next) => {
  try {
    const { budgetLimit } = req.body
    // S348: 404 instead of silent data:null when no matching row.
    const pr = await queryOne<any>(
      "UPDATE purchase_requests SET status='approved', approved_by=$1, approved_at=NOW(), budget_limit=$2 WHERE id=$3 AND landlord_id=$4 RETURNING *",
      [req.user!.userId, budgetLimit||null, req.params.id, req.user!.profileId]
    )
    if (!pr) throw new AppError(404, 'Purchase request not found')
    res.json({ success: true, data: pr })
  } catch(e) { next(e) }
})

maintenancePortalRouter.patch('/purchases/:id/deny', requirePerm('purchases.approve'), async (req, res, next) => {
  try {
    // S348: 404 instead of silent data:null when no matching row.
    const pr = await queryOne<any>(
      "UPDATE purchase_requests SET status='denied', approved_by=$1, approved_at=NOW() WHERE id=$2 AND landlord_id=$3 RETURNING *",
      [req.user!.userId, req.params.id, req.user!.profileId]
    )
    if (!pr) throw new AppError(404, 'Purchase request not found')
    res.json({ success: true, data: pr })
  } catch(e) { next(e) }
})

// ── SCHEDULED MAINTENANCE ─────────────────────────────────────
maintenancePortalRouter.get('/scheduled', requirePerm('work_orders.complete', 'work_orders.reassign', 'work_orders.create'), async (req, res, next) => {
  try {
    const scheduled = await query<any>(`
      SELECT sm.*, p.name as property_name, u.unit_number,
        au.first_name||' '||au.last_name as assigned_name
      FROM scheduled_maintenance sm
      LEFT JOIN properties p ON p.id=sm.property_id
      LEFT JOIN units u ON u.id=sm.unit_id
      LEFT JOIN users au ON au.id=sm.assigned_to
      WHERE sm.landlord_id=$1
      ORDER BY sm.next_due ASC`, [req.user!.profileId])
    res.json({ success: true, data: scheduled })
  } catch(e) { next(e) }
})

maintenancePortalRouter.post('/scheduled', requirePerm('work_orders.create'), async (req, res, next) => {
  try {
    const { title, description, recurrence, propertyId, unitId, assignedTo, nextDue, estimatedHours } = req.body
    // S391 fix (S388 finding #1): propertyId + unitId scope validation.
    // Pre-fix, both FK IDs were inserted unvalidated — a landlord could
    // reference another landlord's property or unit, and the GET /scheduled
    // JOIN would surface the cross-tenant property_name / unit_number.
    // assignedTo validation requires a team-role union check (see
    // property_manager_scopes / maintenance_worker_scopes / onsite_manager_scopes)
    // — flagged for follow-up rather than bundled here.
    if (propertyId) {
      const ok = await queryOne<{ id: string }>(
        'SELECT id FROM properties WHERE id=$1 AND landlord_id=$2',
        [propertyId, req.user!.profileId]
      )
      if (!ok) throw new AppError(400, 'propertyId does not belong to this landlord')
    }
    if (unitId) {
      const ok = await queryOne<{ id: string }>(
        'SELECT id FROM units WHERE id=$1 AND landlord_id=$2',
        [unitId, req.user!.profileId]
      )
      if (!ok) throw new AppError(400, 'unitId does not belong to this landlord')
    }
    const sm = await queryOne<any>(
      'INSERT INTO scheduled_maintenance (landlord_id,title,description,recurrence,property_id,unit_id,assigned_to,next_due,estimated_hours) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *',
      [req.user!.profileId, title, description||null, recurrence, propertyId||null, unitId||null, assignedTo||null, nextDue||null, estimatedHours||null]
    )
    res.json({ success: true, data: sm })
  } catch(e) { next(e) }
})

maintenancePortalRouter.patch('/scheduled/:id/complete', requirePerm('work_orders.complete'), async (req, res, next) => {
  try {
    // S348 fix: pre-S348 both the SELECT and the UPDATE used `WHERE id=$1`
    // with no landlord scope — any caller with the work_orders.complete
    // permission could mark any landlord's scheduled_maintenance row
    // complete, leaking row data via the SELECT and writing
    // last_completed/next_due on a row outside their org. Both queries
    // now scope on landlord_id.
    const item = await queryOne<any>(
      'SELECT * FROM scheduled_maintenance WHERE id=$1 AND landlord_id=$2',
      [req.params.id, req.user!.profileId]
    )
    if (!item) throw new AppError(404, 'Not found')
    // Calculate next due date based on recurrence
    const recurrenceMap: Record<string,string> = {
      weekly:'7 days', monthly:'1 month', quarterly:'3 months', biannual:'6 months', annual:'1 year'
    }
    const interval = recurrenceMap[item.recurrence] || '1 month'
    await queryOne<any>(
      `UPDATE scheduled_maintenance SET last_completed=CURRENT_DATE, next_due=CURRENT_DATE + INTERVAL '${interval}' WHERE id=$1 AND landlord_id=$2 RETURNING *`,
      [req.params.id, req.user!.profileId]
    )
    res.json({ success: true })
  } catch(e) { next(e) }
})

// ── WORK ORDERS (maintenance staff view) ─────────────────────
maintenancePortalRouter.get('/work-orders', requirePerm('work_orders.complete', 'work_orders.reassign'), async (req, res, next) => {
  try {
    const orders = await query<any>(`
      SELECT mr.*, u.unit_number, p.name as property_name,
        t.first_name||' '||t.last_name as tenant_name,
        tu.phone as tenant_phone
      FROM maintenance_requests mr
      JOIN units u ON u.id=mr.unit_id
      JOIN properties p ON p.id=u.property_id
      LEFT JOIN tenants tn ON tn.id=mr.tenant_id
      LEFT JOIN users t ON t.id=tn.user_id
      LEFT JOIN users tu ON tu.id=tn.user_id
      WHERE mr.landlord_id=$1
        AND mr.status NOT IN ('completed','cancelled')
      ORDER BY
        CASE mr.priority WHEN 'emergency' THEN 1 WHEN 'high' THEN 2 WHEN 'normal' THEN 3 ELSE 4 END,
        mr.created_at ASC`, [req.user!.profileId])
    res.json({ success: true, data: orders })
  } catch(e) { next(e) }
})
