/**
 * S498 — business-portal work orders (mechanic vertical).
 *
 * Endpoints:
 *   POST   /api/business-work-orders                              (create — header only)
 *   GET    /api/business-work-orders                              (list, status filter)
 *   GET    /api/business-work-orders/:id                          (detail with lines)
 *   PATCH  /api/business-work-orders/:id                          (header fields)
 *   POST   /api/business-work-orders/:id/lines                    (add a line; part lines decrement stock)
 *   DELETE /api/business-work-orders/:id/lines/:lineId            (remove; part lines restore stock)
 *   POST   /api/business-work-orders/:id/transition               (status workflow)
 *   POST   /api/business-work-orders/:id/convert-to-invoice       (creates business_invoices row from lines)
 *
 * Status workflow:
 *   open ↔ in_progress ↔ awaiting_parts
 *   any of the three → completed (terminal) or cancelled (terminal)
 *   terminal states can't transition further
 *
 * Part lines decrement stock atomically via SELECT FOR UPDATE on the
 * inventory item + write a 'used' adjustment row. Removing a part line
 * restores stock + writes 'received'. Convert-to-invoice copies the
 * snapshotted lines into business_invoices_lines (does NOT touch stock).
 */

import { Router } from 'express'
import { z } from 'zod'
import { db, query, queryOne } from '../db'
import { requireAuth } from '../middleware/auth'
import { AppError } from '../middleware/errorHandler'

export const businessWorkOrdersRouter = Router()

// ── helpers ────────────────────────────────────────────────────
// S502: work_orders.read for list/detail; work_orders.write for create
// + edit + add/remove lines; work_orders.complete for transitions
// (completed/cancelled lock the WO) and convert-to-invoice (terminal
// action that creates downstream artifacts).
import { requireBusinessAccess } from '../middleware/businessAccess'

const requireRead     = async (req: any) => (await requireBusinessAccess(req, { permission: 'work_orders.read',     feature: 'work_orders' })).businessId
const requireWrite    = async (req: any) => (await requireBusinessAccess(req, { permission: 'work_orders.write',    feature: 'work_orders' })).businessId
const requireComplete = async (req: any) => (await requireBusinessAccess(req, { permission: 'work_orders.complete', feature: 'work_orders' })).businessId

function fmtWoNumber(n: number): string {
  return `WO-${String(n).padStart(6, '0')}`
}

function dec(n: string | number | null | undefined): number {
  return Math.round(Number(n ?? 0) * 100) / 100
}

// Recompute the four money columns on the work-order header from its
// current lines. Used inside transactions after add/remove/edit.
async function recomputeTotals(client: any, workOrderId: string): Promise<void> {
  const { rows: lines } = (await client.query(
    `SELECT line_type, line_subtotal, line_tax
       FROM business_work_order_lines
      WHERE work_order_id = $1`, [workOrderId])) as {
    rows: Array<{ line_type: string; line_subtotal: string; line_tax: string }>
  }
  let labor = 0, parts = 0, tax = 0
  for (const l of lines) {
    if (l.line_type === 'labor') labor += Number(l.line_subtotal)
    else                          parts += Number(l.line_subtotal)
    tax += Number(l.line_tax)
  }
  labor = dec(labor); parts = dec(parts); tax = dec(tax)
  const total = dec(labor + parts + tax)
  await client.query(
    `UPDATE business_work_orders
        SET labor_subtotal = $1,
            parts_subtotal = $2,
            tax_amount     = $3,
            total_amount   = $4
      WHERE id = $5`,
    [labor, parts, tax, total, workOrderId])
}

// ═══════════════════════════════════════════════════════════════
//  POST / — create header
// ═══════════════════════════════════════════════════════════════

const createSchema = z.object({
  customerId:     z.string().uuid(),
  vehicleId:      z.string().uuid().nullable().optional(),
  appointmentId:  z.string().uuid().nullable().optional(),
  intakeMileage:  z.number().int().min(0).nullable().optional(),
  complaint:      z.string().max(2000).nullable().optional(),
  assignedToUserId: z.string().uuid().nullable().optional(),
})

businessWorkOrdersRouter.post('/', requireAuth, async (req, res, next) => {
  try {
    const businessId = await requireWrite(req)
    const body = createSchema.parse(req.body)

    // Verify customer.
    const customer = await queryOne<{ id: string }>(
      `SELECT id FROM business_customers
        WHERE id = $1 AND business_id = $2`,
      [body.customerId, businessId])
    if (!customer) throw new AppError(404, 'Customer not found')

    // Verify vehicle (if supplied) belongs to this business AND customer.
    if (body.vehicleId) {
      const veh = await queryOne<{ id: string; customer_id: string }>(
        `SELECT id, customer_id FROM business_customer_vehicles
          WHERE id = $1 AND business_id = $2`,
        [body.vehicleId, businessId])
      if (!veh) throw new AppError(404, 'Vehicle not found')
      if (veh.customer_id !== body.customerId) {
        throw new AppError(400, 'Vehicle does not belong to this customer')
      }
    }

    // Verify appointment (if supplied).
    if (body.appointmentId) {
      const appt = await queryOne<{ id: string }>(
        `SELECT id FROM appointments WHERE id = $1 AND business_id = $2`,
        [body.appointmentId, businessId])
      if (!appt) throw new AppError(404, 'Appointment not found')
    }

    const client = await db.connect()
    try {
      await client.query('BEGIN')

      const { rows: [seq] } = await client.query<{ next_number: number }>(
        `INSERT INTO business_work_order_sequences (business_id, next_number)
         VALUES ($1, 2)
         ON CONFLICT (business_id)
           DO UPDATE SET next_number = business_work_order_sequences.next_number + 1
         RETURNING next_number`,
        [businessId])
      const isFirst = seq.next_number === 2
      const thisNumber = isFirst ? 1 : seq.next_number - 1
      const woNumber = fmtWoNumber(thisNumber)

      const { rows: [wo] } = await client.query<any>(
        `INSERT INTO business_work_orders
           (business_id, wo_number, customer_id, vehicle_id, appointment_id,
            intake_mileage, complaint, assigned_to_user_id, created_by_user_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING *`,
        [businessId, woNumber, body.customerId,
         body.vehicleId ?? null,
         body.appointmentId ?? null,
         body.intakeMileage ?? null,
         body.complaint?.trim() ?? null,
         body.assignedToUserId ?? null,
         req.user!.userId])

      await client.query('COMMIT')
      res.status(201).json({ success: true, data: { ...wo, lines: [] } })
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {})
      throw e
    } finally {
      client.release()
    }
  } catch (e) { next(e) }
})

// ═══════════════════════════════════════════════════════════════
//  GET / — list
// ═══════════════════════════════════════════════════════════════

const listSchema = z.object({
  status:     z.enum(['open', 'in_progress', 'awaiting_parts', 'completed', 'cancelled']).optional(),
  customerId: z.string().uuid().optional(),
  vehicleId:  z.string().uuid().optional(),
  limit:      z.coerce.number().int().positive().max(500).optional(),
})

businessWorkOrdersRouter.get('/', requireAuth, async (req, res, next) => {
  try {
    const businessId = await requireRead(req)
    const q = listSchema.parse(req.query)
    const params: any[] = [businessId]
    let where = 'WHERE w.business_id = $1'
    if (q.status)     { params.push(q.status);     where += ` AND w.status = $${params.length}` }
    if (q.customerId) { params.push(q.customerId); where += ` AND w.customer_id = $${params.length}` }
    if (q.vehicleId)  { params.push(q.vehicleId);  where += ` AND w.vehicle_id = $${params.length}` }
    params.push(q.limit ?? 100)
    const rows = await query<any>(
      `SELECT w.id, w.wo_number, w.status, w.complaint,
              w.labor_subtotal, w.parts_subtotal, w.tax_amount, w.total_amount,
              w.intake_mileage, w.completed_at, w.cancelled_at,
              w.customer_id, w.vehicle_id, w.invoice_id,
              w.created_at, w.updated_at,
              c.first_name AS customer_first_name,
              c.last_name  AS customer_last_name,
              c.company_name AS customer_company_name,
              v.year   AS vehicle_year,
              v.make   AS vehicle_make,
              v.model  AS vehicle_model,
              v.license_plate AS vehicle_license_plate
         FROM business_work_orders w
         JOIN business_customers c ON c.id = w.customer_id
         LEFT JOIN business_customer_vehicles v ON v.id = w.vehicle_id
         ${where}
        ORDER BY w.created_at DESC
        LIMIT $${params.length}`, params)
    res.json({ success: true, data: rows })
  } catch (e) { next(e) }
})

// ═══════════════════════════════════════════════════════════════
//  GET /:id — detail with lines
// ═══════════════════════════════════════════════════════════════

businessWorkOrdersRouter.get('/:id', requireAuth, async (req, res, next) => {
  try {
    const businessId = await requireRead(req)
    const wo = await queryOne<any>(
      `SELECT w.*,
              c.first_name AS customer_first_name,
              c.last_name  AS customer_last_name,
              c.company_name AS customer_company_name,
              c.phone AS customer_phone, c.email AS customer_email,
              v.year   AS vehicle_year,
              v.make   AS vehicle_make,
              v.model  AS vehicle_model,
              v.vin    AS vehicle_vin,
              v.license_plate AS vehicle_license_plate
         FROM business_work_orders w
         JOIN business_customers c ON c.id = w.customer_id
         LEFT JOIN business_customer_vehicles v ON v.id = w.vehicle_id
        WHERE w.id = $1 AND w.business_id = $2`,
      [req.params.id, businessId])
    if (!wo) throw new AppError(404, 'Work order not found')
    const lines = await query<any>(
      `SELECT * FROM business_work_order_lines
        WHERE work_order_id = $1
        ORDER BY sort_order ASC, created_at ASC`, [wo.id])
    res.json({ success: true, data: { ...wo, lines } })
  } catch (e) { next(e) }
})

// ═══════════════════════════════════════════════════════════════
//  GET /:id/pdf — printable work order PDF (S504)
// ═══════════════════════════════════════════════════════════════

businessWorkOrdersRouter.get('/:id/pdf', requireAuth, async (req, res, next) => {
  try {
    const businessId = await requireRead(req)
    const wo = await queryOne<any>(
      `SELECT w.*,
              b.name AS biz_name, b.email AS biz_email, b.phone AS biz_phone,
              b.street1 AS biz_street1, b.street2 AS biz_street2,
              b.city AS biz_city, b.state AS biz_state, b.zip AS biz_zip,
              c.first_name AS customer_first_name,
              c.last_name AS customer_last_name,
              c.company_name AS customer_company_name,
              c.email AS customer_email, c.phone AS customer_phone,
              c.street1 AS customer_street1, c.city AS customer_city,
              c.state AS customer_state, c.zip AS customer_zip,
              v.year AS vehicle_year, v.make AS vehicle_make,
              v.model AS vehicle_model, v.vin AS vehicle_vin,
              v.license_plate AS vehicle_license_plate
         FROM business_work_orders w
         JOIN business_customers c ON c.id = w.customer_id
         JOIN businesses b ON b.id = w.business_id
         LEFT JOIN business_customer_vehicles v ON v.id = w.vehicle_id
        WHERE w.id = $1 AND w.business_id = $2`,
      [req.params.id, businessId])
    if (!wo) throw new AppError(404, 'Work order not found')
    const lines = await query<any>(
      `SELECT line_type, description, quantity, unit_price, line_total
         FROM business_work_order_lines
        WHERE work_order_id = $1 ORDER BY sort_order ASC`, [wo.id])

    const { renderWorkOrderPdf } = await import('../services/businessPdf')
    const buffer = await renderWorkOrderPdf({
      business: {
        name: wo.biz_name, email: wo.biz_email, phone: wo.biz_phone,
        street1: wo.biz_street1, street2: wo.biz_street2,
        city: wo.biz_city, state: wo.biz_state, zip: wo.biz_zip,
      },
      customer: {
        firstName: wo.customer_first_name, lastName: wo.customer_last_name,
        companyName: wo.customer_company_name,
        email: wo.customer_email, phone: wo.customer_phone,
        street1: wo.customer_street1, city: wo.customer_city,
        state: wo.customer_state, zip: wo.customer_zip,
      },
      woNumber: wo.wo_number,
      status: wo.status,
      createdAt: wo.created_at,
      intakeMileage: wo.intake_mileage,
      closeoutMileage: wo.closeout_mileage,
      closeoutNotes: wo.closeout_notes,
      complaint: wo.complaint,
      vehicle: wo.vehicle_year || wo.vehicle_make || wo.vehicle_vin ? {
        year: wo.vehicle_year, make: wo.vehicle_make,
        model: wo.vehicle_model, vin: wo.vehicle_vin,
        licensePlate: wo.vehicle_license_plate,
      } : null,
      lines: lines.map(l => ({
        lineType:    l.line_type as 'labor' | 'part' | 'fee',
        description: l.description,
        quantity:    Number(l.quantity),
        unitPrice:   Number(l.unit_price),
        lineTotal:   Number(l.line_total),
      })),
      laborSubtotal: Number(wo.labor_subtotal),
      partsSubtotal: Number(wo.parts_subtotal),
      taxAmount:     Number(wo.tax_amount),
      totalAmount:   Number(wo.total_amount),
    })

    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', `inline; filename="${wo.wo_number}.pdf"`)
    res.send(buffer)
  } catch (e) { next(e) }
})

// ═══════════════════════════════════════════════════════════════
//  PATCH /:id — header fields (no totals — those flow from lines)
// ═══════════════════════════════════════════════════════════════

const patchSchema = z.object({
  vehicleId:        z.string().uuid().nullable().optional(),
  intakeMileage:    z.number().int().min(0).nullable().optional(),
  complaint:        z.string().max(2000).nullable().optional(),
  assignedToUserId: z.string().uuid().nullable().optional(),
  closeoutMileage:  z.number().int().min(0).nullable().optional(),
  closeoutNotes:    z.string().max(2000).nullable().optional(),
}).strict()

businessWorkOrdersRouter.patch('/:id', requireAuth, async (req, res, next) => {
  try {
    const businessId = await requireWrite(req)
    const body = patchSchema.parse(req.body)
    if (Object.keys(body).length === 0) throw new AppError(400, 'Nothing to update')

    if (body.vehicleId) {
      const wo = await queryOne<{ customer_id: string }>(
        `SELECT customer_id FROM business_work_orders
          WHERE id = $1 AND business_id = $2`,
        [req.params.id, businessId])
      if (!wo) throw new AppError(404, 'Work order not found')
      const v = await queryOne<{ customer_id: string }>(
        `SELECT customer_id FROM business_customer_vehicles
          WHERE id = $1 AND business_id = $2`,
        [body.vehicleId, businessId])
      if (!v) throw new AppError(404, 'Vehicle not found')
      if (v.customer_id !== wo.customer_id) {
        throw new AppError(400, 'Vehicle does not belong to this work order\'s customer')
      }
    }

    const r = await query<any>(
      `UPDATE business_work_orders
          SET vehicle_id            = COALESCE($1, vehicle_id),
              intake_mileage        = COALESCE($2, intake_mileage),
              complaint             = COALESCE($3, complaint),
              assigned_to_user_id   = COALESCE($4, assigned_to_user_id),
              closeout_mileage      = COALESCE($5, closeout_mileage),
              closeout_notes        = COALESCE($6, closeout_notes)
        WHERE id = $7 AND business_id = $8
        RETURNING *`,
      [
        body.vehicleId ?? null,
        body.intakeMileage ?? null,
        body.complaint === undefined ? null : (body.complaint?.trim() ?? null),
        body.assignedToUserId ?? null,
        body.closeoutMileage ?? null,
        body.closeoutNotes === undefined ? null : (body.closeoutNotes?.trim() ?? null),
        req.params.id, businessId,
      ])
    if (r.length === 0) throw new AppError(404, 'Work order not found')
    res.json({ success: true, data: r[0] })
  } catch (e) { next(e) }
})

// ═══════════════════════════════════════════════════════════════
//  POST /:id/lines — add a line
// ═══════════════════════════════════════════════════════════════

const addLineSchema = z.discriminatedUnion('lineType', [
  z.object({
    lineType:    z.literal('labor'),
    description: z.string().min(1).max(500),
    hours:       z.number().positive().max(10000),
    hourlyRate:  z.number().min(0).max(10000),
    taxRate:     z.number().min(0).max(0.9999).optional(),
  }),
  z.object({
    lineType:    z.literal('part'),
    itemId:      z.string().uuid(),
    quantity:    z.number().positive().max(10000),
    // Allow override; if absent, snapshot from item.sell_price.
    unitPrice:   z.number().min(0).optional(),
  }),
  z.object({
    lineType:    z.literal('fee'),
    description: z.string().min(1).max(500),
    amount:      z.number().min(0).max(1_000_000),
    taxRate:     z.number().min(0).max(0.9999).optional(),
  }),
])

businessWorkOrdersRouter.post('/:id/lines', requireAuth, async (req, res, next) => {
  try {
    const businessId = await requireWrite(req)
    const body = addLineSchema.parse(req.body)

    const client = await db.connect()
    try {
      await client.query('BEGIN')

      // Lock the WO; reject if terminal.
      const { rows: [wo] } = await client.query<{
        id: string; status: string; wo_number: string;
      }>(
        `SELECT id, status, wo_number
           FROM business_work_orders
          WHERE id = $1 AND business_id = $2
          FOR UPDATE`,
        [req.params.id, businessId])
      if (!wo) {
        await client.query('ROLLBACK')
        throw new AppError(404, 'Work order not found')
      }
      if (wo.status === 'completed' || wo.status === 'cancelled') {
        await client.query('ROLLBACK')
        throw new AppError(409, `Cannot add lines to a ${wo.status} work order`)
      }

      // Get next sort_order.
      const { rows: [maxRow] } = await client.query<{ max: number | null }>(
        `SELECT MAX(sort_order) AS max FROM business_work_order_lines
          WHERE work_order_id = $1`, [wo.id])
      const sortOrder = (maxRow?.max ?? -1) + 1

      let line: any
      if (body.lineType === 'labor') {
        const lineSubtotal = dec(body.hours * body.hourlyRate)
        const taxRate = body.taxRate ?? 0
        const lineTax = dec(lineSubtotal * taxRate)
        const lineTotal = dec(lineSubtotal + lineTax)
        const { rows: [created] } = await client.query<any>(
          `INSERT INTO business_work_order_lines
             (work_order_id, line_type, description, quantity, unit_price,
              tax_rate, line_subtotal, line_tax, line_total, sort_order)
           VALUES ($1, 'labor', $2, $3, $4, $5, $6, $7, $8, $9)
           RETURNING *`,
          [wo.id, body.description.trim(), body.hours, body.hourlyRate,
           taxRate, lineSubtotal, lineTax, lineTotal, sortOrder])
        line = created

      } else if (body.lineType === 'fee') {
        const lineSubtotal = dec(body.amount)
        const taxRate = body.taxRate ?? 0
        const lineTax = dec(lineSubtotal * taxRate)
        const lineTotal = dec(lineSubtotal + lineTax)
        const { rows: [created] } = await client.query<any>(
          `INSERT INTO business_work_order_lines
             (work_order_id, line_type, description, quantity, unit_price,
              tax_rate, line_subtotal, line_tax, line_total, sort_order)
           VALUES ($1, 'fee', $2, 1, $3, $4, $5, $6, $7, $8)
           RETURNING *`,
          [wo.id, body.description.trim(), lineSubtotal,
           taxRate, lineSubtotal, lineTax, lineTotal, sortOrder])
        line = created

      } else {
        // part — lock item, snapshot, decrement stock, write 'used' adjustment.
        const { rows: [item] } = await client.query<{
          id: string; name: string; sku: string | null;
          sell_price: string; tax_rate: string; stock_qty: number;
          is_active: boolean;
        }>(
          `SELECT id, name, sku, sell_price, tax_rate, stock_qty, is_active
             FROM business_inventory_items
            WHERE id = $1 AND business_id = $2
            FOR UPDATE`,
          [body.itemId, businessId])
        if (!item) {
          await client.query('ROLLBACK')
          throw new AppError(404, 'Inventory item not found')
        }
        if (!item.is_active) {
          await client.query('ROLLBACK')
          throw new AppError(400, `Item "${item.name}" is archived and cannot be used`)
        }
        if (Number(item.stock_qty) < body.quantity) {
          await client.query('ROLLBACK')
          throw new AppError(400,
            `Not enough stock for "${item.name}" (need ${body.quantity}, have ${item.stock_qty})`)
        }
        const unitPrice = body.unitPrice !== undefined ? dec(body.unitPrice) : dec(item.sell_price)
        const taxRate = dec(item.tax_rate)
        const lineSubtotal = dec(unitPrice * body.quantity)
        const lineTax = dec(lineSubtotal * taxRate)
        const lineTotal = dec(lineSubtotal + lineTax)
        const newStock = item.stock_qty - body.quantity

        const { rows: [created] } = await client.query<any>(
          `INSERT INTO business_work_order_lines
             (work_order_id, line_type, item_id, description, quantity, unit_price,
              tax_rate, line_subtotal, line_tax, line_total, sort_order)
           VALUES ($1, 'part', $2, $3, $4, $5, $6, $7, $8, $9, $10)
           RETURNING *`,
          [wo.id, item.id, item.name, body.quantity, unitPrice,
           taxRate, lineSubtotal, lineTax, lineTotal, sortOrder])
        await client.query(
          `UPDATE business_inventory_items SET stock_qty = $1 WHERE id = $2`,
          [newStock, item.id])
        await client.query(
          `INSERT INTO business_inventory_adjustments
             (business_id, item_id, adjustment_type, quantity_delta,
              stock_qty_after, notes, actor_user_id,
              reference_type, reference_id)
           VALUES ($1, $2, 'used', $3, $4, $5, $6, 'work_order', $7)`,
          [businessId, item.id, -body.quantity, newStock,
           `Used on ${wo.wo_number}`, req.user!.userId, wo.id])
        line = created
      }

      await recomputeTotals(client, wo.id)
      await client.query('COMMIT')
      res.status(201).json({ success: true, data: line })
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {})
      throw e
    } finally {
      client.release()
    }
  } catch (e) { next(e) }
})

// ═══════════════════════════════════════════════════════════════
//  DELETE /:id/lines/:lineId — remove a line
// ═══════════════════════════════════════════════════════════════

businessWorkOrdersRouter.delete('/:id/lines/:lineId', requireAuth, async (req, res, next) => {
  try {
    const businessId = await requireWrite(req)

    const client = await db.connect()
    try {
      await client.query('BEGIN')

      const { rows: [wo] } = await client.query<{
        id: string; status: string; wo_number: string;
      }>(
        `SELECT id, status, wo_number
           FROM business_work_orders
          WHERE id = $1 AND business_id = $2
          FOR UPDATE`,
        [req.params.id, businessId])
      if (!wo) {
        await client.query('ROLLBACK')
        throw new AppError(404, 'Work order not found')
      }
      if (wo.status === 'completed' || wo.status === 'cancelled') {
        await client.query('ROLLBACK')
        throw new AppError(409, `Cannot edit lines on a ${wo.status} work order`)
      }

      const { rows: [ln] } = await client.query<{
        id: string; line_type: string; item_id: string | null; quantity: string;
      }>(
        `SELECT id, line_type, item_id, quantity
           FROM business_work_order_lines
          WHERE id = $1 AND work_order_id = $2`,
        [req.params.lineId, wo.id])
      if (!ln) {
        await client.query('ROLLBACK')
        throw new AppError(404, 'Line not found')
      }

      // If part line — restore stock + write 'received' adjustment.
      if (ln.line_type === 'part' && ln.item_id) {
        const qty = Number(ln.quantity)
        const { rows: [item] } = await client.query<{ stock_qty: number }>(
          `SELECT stock_qty FROM business_inventory_items
            WHERE id = $1 FOR UPDATE`, [ln.item_id])
        const newStock = (item?.stock_qty ?? 0) + qty
        await client.query(
          `UPDATE business_inventory_items SET stock_qty = $1 WHERE id = $2`,
          [newStock, ln.item_id])
        await client.query(
          `INSERT INTO business_inventory_adjustments
             (business_id, item_id, adjustment_type, quantity_delta,
              stock_qty_after, notes, actor_user_id,
              reference_type, reference_id)
           VALUES ($1, $2, 'received', $3, $4, $5, $6, 'work_order', $7)`,
          [businessId, ln.item_id, qty, newStock,
           `Removed from ${wo.wo_number}`, req.user!.userId, wo.id])
      }

      await client.query(
        `DELETE FROM business_work_order_lines WHERE id = $1`,
        [ln.id])
      await recomputeTotals(client, wo.id)
      await client.query('COMMIT')
      res.json({ success: true, data: { id: ln.id } })
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {})
      throw e
    } finally {
      client.release()
    }
  } catch (e) { next(e) }
})

// ═══════════════════════════════════════════════════════════════
//  POST /:id/transition — status workflow
// ═══════════════════════════════════════════════════════════════

const transitionSchema = z.object({
  toStatus: z.enum(['open', 'in_progress', 'awaiting_parts', 'completed', 'cancelled']),
  cancelReason:    z.string().min(1).max(500).optional(),
  closeoutMileage: z.number().int().min(0).optional(),
  closeoutNotes:   z.string().max(2000).optional(),
})

const VALID_TRANSITIONS: Record<string, string[]> = {
  open:            ['in_progress', 'awaiting_parts', 'completed', 'cancelled'],
  in_progress:     ['open', 'awaiting_parts', 'completed', 'cancelled'],
  awaiting_parts:  ['open', 'in_progress', 'completed', 'cancelled'],
  completed:       [],
  cancelled:       [],
}

businessWorkOrdersRouter.post('/:id/transition', requireAuth, async (req, res, next) => {
  try {
    const businessId = await requireComplete(req)
    const body = transitionSchema.parse(req.body)

    const wo = await queryOne<{ id: string; status: string }>(
      `SELECT id, status FROM business_work_orders
        WHERE id = $1 AND business_id = $2`,
      [req.params.id, businessId])
    if (!wo) throw new AppError(404, 'Work order not found')

    if (!VALID_TRANSITIONS[wo.status]?.includes(body.toStatus)) {
      throw new AppError(409, `Cannot transition from ${wo.status} to ${body.toStatus}`)
    }
    if (body.toStatus === 'cancelled' && !body.cancelReason) {
      throw new AppError(400, 'cancelReason required when cancelling')
    }

    const setClauses: string[] = [`status = $1`]
    const params: any[] = [body.toStatus]
    if (body.toStatus === 'completed') {
      setClauses.push(`completed_at = NOW()`)
      if (body.closeoutMileage !== undefined) {
        params.push(body.closeoutMileage)
        setClauses.push(`closeout_mileage = $${params.length}`)
      }
      if (body.closeoutNotes) {
        params.push(body.closeoutNotes.trim())
        setClauses.push(`closeout_notes = $${params.length}`)
      }
    } else if (body.toStatus === 'cancelled') {
      setClauses.push(`cancelled_at = NOW()`)
      params.push(body.cancelReason!.trim())
      setClauses.push(`cancel_reason = $${params.length}`)
    } else {
      // moving out of a terminal state isn't possible by VALID_TRANSITIONS,
      // but if the WO was previously transitioned through completed/cancelled
      // by accident (shouldn't be reachable) we'd null those columns. Skip.
    }

    params.push(req.params.id)
    const r = await query<any>(
      `UPDATE business_work_orders
          SET ${setClauses.join(', ')}
        WHERE id = $${params.length}
        RETURNING *`, params)
    res.json({ success: true, data: r[0] })
  } catch (e) { next(e) }
})

// ═══════════════════════════════════════════════════════════════
//  POST /:id/convert-to-invoice
// ═══════════════════════════════════════════════════════════════

const convertSchema = z.object({
  issueDate: z.string(),
  dueDate:   z.string(),
  notes:     z.string().max(2000).nullable().optional(),
})

businessWorkOrdersRouter.post('/:id/convert-to-invoice', requireAuth, async (req, res, next) => {
  try {
    const businessId = await requireComplete(req)
    const body = convertSchema.parse(req.body)
    if (body.dueDate < body.issueDate) {
      throw new AppError(400, 'Due date must be on or after issue date')
    }

    // Verify invoicing feature is also enabled.
    const biz = await queryOne<{ enabled_features: string[] }>(
      `SELECT enabled_features FROM businesses WHERE id = $1`, [businessId])
    if (!biz?.enabled_features.includes('invoicing')) {
      throw new AppError(400, 'Enable the Invoicing feature first (Settings → Features) before converting to an invoice.')
    }

    const client = await db.connect()
    try {
      await client.query('BEGIN')

      const { rows: [wo] } = await client.query<any>(
        `SELECT * FROM business_work_orders
          WHERE id = $1 AND business_id = $2
          FOR UPDATE`,
        [req.params.id, businessId])
      if (!wo) {
        await client.query('ROLLBACK')
        throw new AppError(404, 'Work order not found')
      }
      if (wo.invoice_id) {
        await client.query('ROLLBACK')
        throw new AppError(409, 'This work order has already been invoiced')
      }
      if (wo.status === 'cancelled') {
        await client.query('ROLLBACK')
        throw new AppError(409, 'Cannot invoice a cancelled work order')
      }

      const { rows: lines } = await client.query<{
        line_type: string; description: string;
        quantity: string; unit_price: string;
        line_subtotal: string; sort_order: number;
      }>(
        `SELECT line_type, description, quantity, unit_price, line_subtotal, sort_order
           FROM business_work_order_lines
          WHERE work_order_id = $1
          ORDER BY sort_order ASC`, [wo.id])
      if (lines.length === 0) {
        await client.query('ROLLBACK')
        throw new AppError(400, 'Work order has no lines to invoice')
      }

      // Bump invoice sequence.
      const { rows: [seq] } = await client.query<{ next_number: number }>(
        `INSERT INTO business_invoice_sequences (business_id, next_number)
         VALUES ($1, 2)
         ON CONFLICT (business_id)
           DO UPDATE SET next_number = business_invoice_sequences.next_number + 1
         RETURNING next_number`,
        [businessId])
      const isFirst = seq.next_number === 2
      const thisNumber = isFirst ? 1 : seq.next_number - 1
      const invoiceNumber = `INV-${String(thisNumber).padStart(4, '0')}`

      const subtotal = dec(Number(wo.labor_subtotal) + Number(wo.parts_subtotal))
      const taxAmount = dec(Number(wo.tax_amount))
      const totalAmount = dec(subtotal + taxAmount)

      const { rows: [inv] } = await client.query<any>(
        `INSERT INTO business_invoices
           (business_id, invoice_number, customer_id,
            issue_date, due_date, status,
            subtotal, tax_amount, total_amount,
            notes, source_work_order_id)
         VALUES ($1, $2, $3, $4, $5, 'draft',
                 $6, $7, $8, $9, $10)
         RETURNING *`,
        [businessId, invoiceNumber, wo.customer_id,
         body.issueDate, body.dueDate,
         subtotal, taxAmount, totalAmount,
         body.notes?.trim() ?? null, wo.id])

      // Copy lines.
      for (let i = 0; i < lines.length; i++) {
        const ln = lines[i]!
        const prefix = ln.line_type === 'labor' ? 'Labor: '
                     : ln.line_type === 'part'  ? 'Part: '
                     : ''
        await client.query(
          `INSERT INTO business_invoice_lines
             (invoice_id, description, quantity, unit_price, line_total, sort_order)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [inv.id,
           `${prefix}${ln.description}`,
           Number(ln.quantity),
           Number(ln.unit_price),
           Number(ln.line_subtotal),
           i])
      }

      // Link WO → invoice.
      await client.query(
        `UPDATE business_work_orders SET invoice_id = $1 WHERE id = $2`,
        [inv.id, wo.id])

      await client.query('COMMIT')
      res.status(201).json({ success: true, data: inv })
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {})
      throw e
    } finally {
      client.release()
    }
  } catch (e) { next(e) }
})
