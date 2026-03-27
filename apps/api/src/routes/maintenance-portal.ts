import { Router } from 'express'
import { requireAuth } from '../middleware/auth'
import { query, queryOne } from '../db'
import { AppError } from '../middleware/errorHandler'

export const maintenancePortalRouter = Router()

// ── SHIFTS ────────────────────────────────────────────────────
maintenancePortalRouter.post('/shifts/clock-in', requireAuth, async (req, res, next) => {
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

maintenancePortalRouter.post('/shifts/clock-out', requireAuth, async (req, res, next) => {
  try {
    const shift = await queryOne<any>(
      'UPDATE shifts SET clocked_out_at=NOW(), notes=$1 WHERE user_id=$2 AND clocked_out_at IS NULL RETURNING *',
      [req.body.notes||null, req.user!.userId]
    )
    if (!shift) throw new AppError(400, 'Not clocked in')
    res.json({ success: true, data: shift })
  } catch(e) { next(e) }
})

maintenancePortalRouter.get('/shifts/active', requireAuth, async (req, res, next) => {
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
maintenancePortalRouter.get('/tasks', requireAuth, async (req, res, next) => {
  try {
    const tasks = await query<any>(`
      SELECT t.*, u.first_name||' '||u.last_name as assigned_name
      FROM daily_tasks t LEFT JOIN users u ON u.id=t.assigned_to
      WHERE t.landlord_id=$1 AND (t.due_date=CURRENT_DATE OR t.recurrence!='none')
      ORDER BY t.completed ASC, t.due_date ASC`, [req.user!.profileId])
    res.json({ success: true, data: tasks })
  } catch(e) { next(e) }
})

maintenancePortalRouter.post('/tasks', requireAuth, async (req, res, next) => {
  try {
    const { title, description, assignedTo, dueDate, recurrence } = req.body
    const task = await queryOne<any>(
      'INSERT INTO daily_tasks (landlord_id, title, description, assigned_to, due_date, recurrence) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
      [req.user!.profileId, title, description||null, assignedTo||null, dueDate||null, recurrence||'none']
    )
    res.json({ success: true, data: task })
  } catch(e) { next(e) }
})

maintenancePortalRouter.patch('/tasks/:id/complete', requireAuth, async (req, res, next) => {
  try {
    const task = await queryOne<any>(
      'UPDATE daily_tasks SET completed=TRUE, completed_at=NOW(), completed_by=$1 WHERE id=$2 AND landlord_id=$3 RETURNING *',
      [req.user!.userId, req.params.id, req.user!.profileId]
    )
    res.json({ success: true, data: task })
  } catch(e) { next(e) }
})

// ── PARTS INVENTORY ───────────────────────────────────────────
maintenancePortalRouter.get('/parts', requireAuth, async (req, res, next) => {
  try {
    const parts = await query<any>(
      'SELECT * FROM parts_inventory WHERE landlord_id=$1 ORDER BY name ASC',
      [req.user!.profileId]
    )
    res.json({ success: true, data: parts })
  } catch(e) { next(e) }
})

maintenancePortalRouter.post('/parts', requireAuth, async (req, res, next) => {
  try {
    const { name, description, sku, quantity, minQuantity, unit, location, cost } = req.body
    const part = await queryOne<any>(
      'INSERT INTO parts_inventory (landlord_id,name,description,sku,quantity,min_quantity,unit,location,cost) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *',
      [req.user!.profileId, name, description||null, sku||null, quantity||0, minQuantity||0, unit||'each', location||null, cost||null]
    )
    res.json({ success: true, data: part })
  } catch(e) { next(e) }
})

maintenancePortalRouter.patch('/parts/:id', requireAuth, async (req, res, next) => {
  try {
    const { quantity, name, minQuantity, location, cost } = req.body
    const part = await queryOne<any>(
      'UPDATE parts_inventory SET quantity=COALESCE($1,quantity), name=COALESCE($2,name), min_quantity=COALESCE($3,min_quantity), location=COALESCE($4,location), cost=COALESCE($5,cost), updated_at=NOW() WHERE id=$6 AND landlord_id=$7 RETURNING *',
      [quantity, name, minQuantity, location, cost, req.params.id, req.user!.profileId]
    )
    res.json({ success: true, data: part })
  } catch(e) { next(e) }
})

// ── PURCHASE REQUESTS ─────────────────────────────────────────
maintenancePortalRouter.get('/purchases', requireAuth, async (req, res, next) => {
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

maintenancePortalRouter.post('/purchases', requireAuth, async (req, res, next) => {
  try {
    const { workOrderId, items, notes, totalEstimate } = req.body
    const pr = await queryOne<any>(
      'INSERT INTO purchase_requests (landlord_id,requested_by,work_order_id,items,notes,total_estimate) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
      [req.user!.profileId, req.user!.userId, workOrderId||null, JSON.stringify(items||[]), notes||null, totalEstimate||null]
    )
    res.json({ success: true, data: pr })
  } catch(e) { next(e) }
})

maintenancePortalRouter.patch('/purchases/:id/approve', requireAuth, async (req, res, next) => {
  try {
    const { budgetLimit } = req.body
    const pr = await queryOne<any>(
      "UPDATE purchase_requests SET status='approved', approved_by=$1, approved_at=NOW(), budget_limit=$2 WHERE id=$3 AND landlord_id=$4 RETURNING *",
      [req.user!.userId, budgetLimit||null, req.params.id, req.user!.profileId]
    )
    res.json({ success: true, data: pr })
  } catch(e) { next(e) }
})

maintenancePortalRouter.patch('/purchases/:id/deny', requireAuth, async (req, res, next) => {
  try {
    const pr = await queryOne<any>(
      "UPDATE purchase_requests SET status='denied', approved_by=$1, approved_at=NOW() WHERE id=$2 AND landlord_id=$3 RETURNING *",
      [req.user!.userId, req.params.id, req.user!.profileId]
    )
    res.json({ success: true, data: pr })
  } catch(e) { next(e) }
})

// ── SCHEDULED MAINTENANCE ─────────────────────────────────────
maintenancePortalRouter.get('/scheduled', requireAuth, async (req, res, next) => {
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

maintenancePortalRouter.post('/scheduled', requireAuth, async (req, res, next) => {
  try {
    const { title, description, recurrence, propertyId, unitId, assignedTo, nextDue, estimatedHours } = req.body
    const sm = await queryOne<any>(
      'INSERT INTO scheduled_maintenance (landlord_id,title,description,recurrence,property_id,unit_id,assigned_to,next_due,estimated_hours) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *',
      [req.user!.profileId, title, description||null, recurrence, propertyId||null, unitId||null, assignedTo||null, nextDue||null, estimatedHours||null]
    )
    res.json({ success: true, data: sm })
  } catch(e) { next(e) }
})

maintenancePortalRouter.patch('/scheduled/:id/complete', requireAuth, async (req, res, next) => {
  try {
    const item = await queryOne<any>('SELECT * FROM scheduled_maintenance WHERE id=$1', [req.params.id])
    if (!item) throw new AppError(404, 'Not found')
    // Calculate next due date based on recurrence
    const recurrenceMap: Record<string,string> = {
      weekly:'7 days', monthly:'1 month', quarterly:'3 months', biannual:'6 months', annual:'1 year'
    }
    const interval = recurrenceMap[item.recurrence] || '1 month'
    await queryOne<any>(
      `UPDATE scheduled_maintenance SET last_completed=CURRENT_DATE, next_due=CURRENT_DATE + INTERVAL '${interval}' WHERE id=$1 RETURNING *`,
      [req.params.id]
    )
    res.json({ success: true })
  } catch(e) { next(e) }
})

// ── WORK ORDERS (maintenance staff view) ─────────────────────
maintenancePortalRouter.get('/work-orders', requireAuth, async (req, res, next) => {
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
