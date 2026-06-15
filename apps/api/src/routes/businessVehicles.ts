/**
 * S498 — business-portal customer vehicles (mechanic vertical).
 *
 * Endpoints:
 *   POST   /api/business-vehicles                                        (create)
 *   GET    /api/business-vehicles                                        (list, customerId filter)
 *   GET    /api/business-vehicles/:id                                    (detail w/ recent work orders)
 *   PATCH  /api/business-vehicles/:id                                    (update)
 *   POST   /api/business-vehicles/:id/archive                            (soft-delete)
 *
 * Owner-only for now. The `customer_vehicles` feature gate is enforced
 * on every endpoint so direct API calls with the feature off get 403.
 */

import { Router } from 'express'
import { z } from 'zod'
import { query, queryOne } from '../db'
import { requireAuth } from '../middleware/auth'
import { AppError } from '../middleware/errorHandler'

export const businessVehiclesRouter = Router()

// S502: read/write split via the shared access helper.
import { requireBusinessAccess } from '../middleware/businessAccess'

const requireRead  = async (req: any) => (await requireBusinessAccess(req, { permission: 'vehicles.read',  feature: 'customer_vehicles' })).businessId
const requireWrite = async (req: any) => (await requireBusinessAccess(req, { permission: 'vehicles.write', feature: 'customer_vehicles' })).businessId

// ── helpers ────────────────────────────────────────────────────

const VIN_REGEX = /^[A-HJ-NPR-Z0-9]{17}$/  // standard US VIN — no I, O, Q

function normalizeVin(raw: string | null | undefined): string | null {
  if (!raw) return null
  const v = raw.trim().toUpperCase().replace(/[^A-Z0-9]/g, '')
  if (v === '') return null
  return v
}

const createSchema = z.object({
  customerId:        z.string().uuid(),
  vin:               z.string().max(64).nullable().optional(),
  licensePlate:      z.string().max(20).nullable().optional(),
  licensePlateState: z.string().length(2).nullable().optional(),
  year:              z.number().int().min(1900).max(2200).nullable().optional(),
  make:              z.string().max(80).nullable().optional(),
  model:             z.string().max(80).nullable().optional(),
  color:             z.string().max(40).nullable().optional(),
  currentMileage:    z.number().int().min(0).nullable().optional(),
  notes:             z.string().max(1000).nullable().optional(),
})

businessVehiclesRouter.post('/', requireAuth, async (req, res, next) => {
  try {
    const businessId = await requireWrite(req)
    const body = createSchema.parse(req.body)

    // Verify customer belongs to this business.
    const customer = await queryOne<{ id: string }>(
      `SELECT id FROM business_customers
        WHERE id = $1 AND business_id = $2`,
      [body.customerId, businessId])
    if (!customer) throw new AppError(404, 'Customer not found')

    const vin = normalizeVin(body.vin)
    if (vin && !VIN_REGEX.test(vin)) {
      throw new AppError(400, 'VIN must be 17 characters (letters + digits, no I/O/Q)')
    }

    try {
      const r = await queryOne<any>(
        `INSERT INTO business_customer_vehicles
           (business_id, customer_id, vin, license_plate, license_plate_state,
            year, make, model, color, current_mileage, notes)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         RETURNING *`,
        [businessId, body.customerId, vin,
         body.licensePlate?.trim() || null,
         body.licensePlateState?.toUpperCase() || null,
         body.year ?? null,
         body.make?.trim() || null,
         body.model?.trim() || null,
         body.color?.trim() || null,
         body.currentMileage ?? null,
         body.notes?.trim() || null])
      res.status(201).json({ success: true, data: r })
    } catch (e: any) {
      // Surface the unique-VIN collision as 409 instead of 500.
      if (e?.code === '23505' && e?.constraint === 'business_customer_vehicles_unique_vin') {
        throw new AppError(409, 'A vehicle with this VIN already exists for this business')
      }
      throw e
    }
  } catch (e) { next(e) }
})

const listSchema = z.object({
  customerId:      z.string().uuid().optional(),
  includeArchived: z.coerce.boolean().optional(),
  q:               z.string().min(1).max(120).optional(),
  limit:           z.coerce.number().int().positive().max(500).optional(),
})

businessVehiclesRouter.get('/', requireAuth, async (req, res, next) => {
  try {
    const businessId = await requireRead(req)
    const q = listSchema.parse(req.query)
    const params: any[] = [businessId]
    let where = 'WHERE v.business_id = $1'
    if (!q.includeArchived) where += ` AND v.is_active = TRUE`
    if (q.customerId) { params.push(q.customerId); where += ` AND v.customer_id = $${params.length}` }
    if (q.q) {
      params.push(`%${q.q}%`)
      const i = params.length
      where += ` AND (
        UPPER(v.vin) LIKE UPPER($${i})
        OR UPPER(v.license_plate) LIKE UPPER($${i})
        OR UPPER(v.make) LIKE UPPER($${i})
        OR UPPER(v.model) LIKE UPPER($${i})
      )`
    }
    params.push(q.limit ?? 200)
    const rows = await query<any>(
      `SELECT v.id, v.customer_id, v.vin, v.license_plate, v.license_plate_state,
              v.year, v.make, v.model, v.color, v.current_mileage,
              v.notes, v.is_active, v.archived_at, v.created_at, v.updated_at,
              c.first_name AS customer_first_name,
              c.last_name  AS customer_last_name,
              c.company_name AS customer_company_name
         FROM business_customer_vehicles v
         JOIN business_customers c ON c.id = v.customer_id
         ${where}
        ORDER BY v.year DESC NULLS LAST, v.make ASC, v.model ASC
        LIMIT $${params.length}`, params)
    res.json({ success: true, data: rows })
  } catch (e) { next(e) }
})

businessVehiclesRouter.get('/:id', requireAuth, async (req, res, next) => {
  try {
    const businessId = await requireRead(req)
    const v = await queryOne<any>(
      `SELECT v.*,
              c.first_name AS customer_first_name,
              c.last_name  AS customer_last_name,
              c.company_name AS customer_company_name,
              c.phone AS customer_phone, c.email AS customer_email
         FROM business_customer_vehicles v
         JOIN business_customers c ON c.id = v.customer_id
        WHERE v.id = $1 AND v.business_id = $2`,
      [req.params.id, businessId])
    if (!v) throw new AppError(404, 'Vehicle not found')

    const workOrders = await query<any>(
      `SELECT id, wo_number, status, complaint,
              labor_subtotal, parts_subtotal, total_amount,
              completed_at, cancelled_at, created_at
         FROM business_work_orders
        WHERE vehicle_id = $1
        ORDER BY created_at DESC
        LIMIT 20`, [v.id])

    res.json({ success: true, data: { ...v, work_orders: workOrders } })
  } catch (e) { next(e) }
})

const patchSchema = z.object({
  vin:               z.string().max(64).nullable().optional(),
  licensePlate:      z.string().max(20).nullable().optional(),
  licensePlateState: z.string().length(2).nullable().optional(),
  year:              z.number().int().min(1900).max(2200).nullable().optional(),
  make:              z.string().max(80).nullable().optional(),
  model:             z.string().max(80).nullable().optional(),
  color:             z.string().max(40).nullable().optional(),
  currentMileage:    z.number().int().min(0).nullable().optional(),
  notes:             z.string().max(1000).nullable().optional(),
}).strict()

businessVehiclesRouter.patch('/:id', requireAuth, async (req, res, next) => {
  try {
    const businessId = await requireWrite(req)
    const body = patchSchema.parse(req.body)
    if (Object.keys(body).length === 0) throw new AppError(400, 'Nothing to update')

    let vin: string | null | undefined = undefined
    if (body.vin !== undefined) {
      vin = normalizeVin(body.vin)
      if (vin && !VIN_REGEX.test(vin)) {
        throw new AppError(400, 'VIN must be 17 characters (letters + digits, no I/O/Q)')
      }
    }

    try {
      const r = await query<any>(
        `UPDATE business_customer_vehicles
            SET vin                 = COALESCE($1, vin),
                license_plate       = COALESCE($2, license_plate),
                license_plate_state = COALESCE($3, license_plate_state),
                year                = COALESCE($4, year),
                make                = COALESCE($5, make),
                model               = COALESCE($6, model),
                color               = COALESCE($7, color),
                current_mileage     = COALESCE($8, current_mileage),
                notes               = COALESCE($9, notes)
          WHERE id = $10 AND business_id = $11
          RETURNING *`,
        [
          vin === undefined ? null : vin,
          body.licensePlate === undefined ? null : (body.licensePlate?.trim() ?? null),
          body.licensePlateState === undefined ? null : (body.licensePlateState?.toUpperCase() ?? null),
          body.year ?? null,
          body.make === undefined ? null : (body.make?.trim() ?? null),
          body.model === undefined ? null : (body.model?.trim() ?? null),
          body.color === undefined ? null : (body.color?.trim() ?? null),
          body.currentMileage ?? null,
          body.notes === undefined ? null : (body.notes?.trim() ?? null),
          req.params.id, businessId,
        ])
      if (r.length === 0) throw new AppError(404, 'Vehicle not found')
      res.json({ success: true, data: r[0] })
    } catch (e: any) {
      if (e?.code === '23505' && e?.constraint === 'business_customer_vehicles_unique_vin') {
        throw new AppError(409, 'A vehicle with this VIN already exists for this business')
      }
      throw e
    }
  } catch (e) { next(e) }
})

businessVehiclesRouter.post('/:id/archive', requireAuth, async (req, res, next) => {
  try {
    const businessId = await requireWrite(req)
    const r = await query<{ id: string; is_active: boolean }>(
      `UPDATE business_customer_vehicles
          SET is_active   = FALSE,
              archived_at = NOW()
        WHERE id = $1 AND business_id = $2 AND is_active = TRUE
        RETURNING id, is_active`,
      [req.params.id, businessId])
    if (r.length === 0) throw new AppError(404, 'Vehicle not found or already archived')
    res.json({ success: true, data: r[0] })
  } catch (e) { next(e) }
})
