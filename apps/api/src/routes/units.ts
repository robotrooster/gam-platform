import { Router } from 'express'
import { z } from 'zod'
import { query, queryOne } from '../db'
import { requireAuth, requireLandlord } from '../middleware/auth'
import { AppError } from '../middleware/errorHandler'
import { UnitStatus, calcNetPerUnit, getReservePhase, PLATFORM_FEES } from '@gam/shared'

export const unitsRouter = Router()
unitsRouter.use(requireAuth)

// GET /api/units  — landlord sees their units, admin sees all
unitsRouter.get('/', async (req, res, next) => {
  try {
    const landlordFilter = req.user!.role !== 'admin'
      ? `AND u.landlord_id = '${req.user!.profileId}'` : ''
    const propertyFilter = req.query.propertyId ? `AND u.property_id = '${req.query.propertyId}'` : ''
    const units = await query<any>(`
      SELECT u.*,
        p.name AS property_name, p.street1, p.city, p.state, p.zip,
        t.id AS tenant_id,
        us.first_name AS tenant_first, us.last_name AS tenant_last, us.email AS tenant_email
      FROM units u
      JOIN properties p ON p.id = u.property_id
      LEFT JOIN tenants te ON te.id = u.tenant_id
      LEFT JOIN users us ON us.id = te.user_id
      LEFT JOIN tenants t ON t.id = u.tenant_id
      WHERE 1=1 ${landlordFilter} ${propertyFilter}
      ORDER BY p.name, u.unit_number
    `)
    res.json({ success: true, data: units })
  } catch (e) { next(e) }
})

// GET /api/units/:id
unitsRouter.get('/:id', async (req, res, next) => {
  try {
    const unit = await queryOne<any>(`
      SELECT u.*, p.name AS property_name, p.type AS property_type,
        p.street1, p.city, p.state, p.zip,
        ul.first_name AS landlord_first, ul.last_name AS landlord_last,
        te.ssi_ssdi, te.on_time_pay_enrolled, te.ach_verified,
        tu.first_name AS tenant_first, tu.last_name AS tenant_last, tu.email AS tenant_email, tu.phone AS tenant_phone
      FROM units u
      JOIN properties p ON p.id = u.property_id
      JOIN landlords l ON l.id = u.landlord_id
      JOIN users ul ON ul.id = l.user_id
      LEFT JOIN tenants te ON te.id = u.tenant_id
      LEFT JOIN users tu ON tu.id = te.user_id
      WHERE u.id = $1`, [req.params.id])
    if (!unit) throw new AppError(404, 'Unit not found')
    if (req.user!.role !== 'admin' && unit.landlord_id !== req.user!.profileId) {
      throw new AppError(403, 'Forbidden')
    }
    res.json({ success: true, data: unit })
  } catch (e) { next(e) }
})

// POST /api/units
unitsRouter.post('/', requireLandlord, async (req, res, next) => {
  try {
    const body = z.object({
      propertyId:      z.string().uuid(),
      unitNumber:      z.string(),
      bedrooms:        z.number().int().min(0).default(1),
      bathrooms:       z.number().min(0).default(1),
      sqft:            z.number().int().nullable().optional(),
      rentAmount:      z.number().positive(),
      securityDeposit: z.number().min(0).default(0),
    }).parse(req.body)

    // Verify property belongs to this landlord
    const prop = await queryOne<any>(
      `SELECT id FROM properties WHERE id = $1 AND landlord_id = $2`,
      [body.propertyId, req.user!.profileId]
    )
    if (!prop) throw new AppError(403, 'Property not found or not yours')

    const [unit] = await query<any>(`
      INSERT INTO units (property_id, landlord_id, unit_number, bedrooms, bathrooms, sqft, rent_amount, security_deposit)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      RETURNING *`,
      [body.propertyId, req.user!.profileId, body.unitNumber, body.bedrooms,
       body.bathrooms, body.sqft ?? null, body.rentAmount, body.securityDeposit]
    )
    res.status(201).json({ success: true, data: unit })
  } catch (e) { next(e) }
})

// PATCH /api/units/:id/status — set unit status
unitsRouter.patch('/:id/status', requireLandlord, async (req, res, next) => {
  try {
    const { status } = z.object({
      status: z.nativeEnum(UnitStatus)
    }).parse(req.body)

    const unit = await queryOne<any>(`SELECT * FROM units WHERE id = $1`, [req.params.id])
    if (!unit) throw new AppError(404, 'Unit not found')
    if (unit.landlord_id !== req.user!.profileId && req.user!.role !== 'admin') {
      throw new AppError(403, 'Forbidden')
    }
    const [updated] = await query<any>(
      `UPDATE units SET status = $1 WHERE id = $2 RETURNING *`, [status, req.params.id]
    )
    res.json({ success: true, data: updated })
  } catch (e) { next(e) }
})

// POST /api/units/:id/eviction-mode — Eviction mode — HARD BLOCK all tenant ACH
// Legal basis: ARS 33-1371(A) — accepting any rent waives eviction right
unitsRouter.post('/:id/eviction-mode', requireLandlord, async (req, res, next) => {
  try {
    const { enable, confirm } = z.object({
      enable:  z.boolean(),
      confirm: z.boolean().refine(v => v === true, 'Must confirm eviction mode')
    }).parse(req.body)

    const unit = await queryOne<any>(`SELECT * FROM units WHERE id = $1`, [req.params.id])
    if (!unit) throw new AppError(404, 'Unit not found')
    if (unit.landlord_id !== req.user!.profileId && req.user!.role !== 'admin') {
      throw new AppError(403, 'Forbidden')
    }

    const [updated] = await query<any>(`
      UPDATE units
      SET payment_block = $1,
          payment_block_set_at = CASE WHEN $1 THEN NOW() ELSE NULL END,
          payment_block_set_by = CASE WHEN $1 THEN $2 ELSE NULL END
      WHERE id = $3
      RETURNING *`,
      [enable, req.user!.userId, req.params.id]
    )
    res.json({
      success: true,
      data: updated,
      message: enable
        ? '⚠️ EVICTION MODE ACTIVE — All tenant ACH hard blocked per ARS 33-1371'
        : 'Eviction mode deactivated — ACH collections resumed'
    })
  } catch (e) { next(e) }
})

// GET /api/units/:id/economics
unitsRouter.get('/:id/economics', async (req, res, next) => {
  try {
    const unit = await queryOne('SELECT * FROM units WHERE id = $1', [req.params.id])
    if (!unit) throw new AppError(404, 'Unit not found')
    const [{ count }] = await query('SELECT COUNT(*)::int AS count FROM units WHERE landlord_id = $1 AND status = $2', [unit.landlord_id, 'active'])
    const { rate } = getReservePhase(count)
    const econ = calcNetPerUnit(unit.rent_amount, rate)
    const fee = unit.status === 'active' ? PLATFORM_FEES.ACTIVE_UNIT : unit.status === 'direct_pay' ? PLATFORM_FEES.DIRECT_PAY_UNIT : 0
    const feeNum = Number(fee)
    const ps = await queryOne("SELECT COALESCE(SUM(amount) FILTER (WHERE status = 'settled'), 0) as total_collected, COALESCE(SUM(amount) FILTER (WHERE status = 'settled' AND due_date >= date_trunc('month', NOW())), 0) as this_month, COALESCE(SUM(amount) FILTER (WHERE status = 'settled' AND due_date >= date_trunc('year', NOW())), 0) as this_year, COUNT(*) FILTER (WHERE status = 'settled') as settled_count, COUNT(*) FILTER (WHERE status = 'failed') as failed_count, MIN(due_date) as first_payment FROM payments WHERE unit_id = $1", [req.params.id])
    const ms = await queryOne("SELECT COALESCE(SUM(actual_cost), 0) as total_cost, COALESCE(SUM(actual_cost) FILTER (WHERE created_at >= date_trunc('month', NOW())), 0) as this_month_cost, COUNT(*) as total_requests FROM maintenance_requests WHERE unit_id = $1", [req.params.id])
    const fp = ps && ps.first_payment ? new Date(ps.first_payment) : null
    const months = fp ? Math.floor((Date.now() - fp.getTime()) / (1000*60*60*24*30)) : 0
    const lc = parseFloat(ps && ps.total_collected || 0)
    const lm = parseFloat(ms && ms.total_cost || 0)
    res.json({ success: true, data: { ...econ, platformFee: fee, reserveRate: rate, occupiedPortfolio: count, netRentMonthly: unit.rent_amount - feeNum, netRentYearly: (unit.rent_amount - feeNum) * 12, netThisMonth: parseFloat(ps && ps.this_month || 0) - feeNum - parseFloat(ms && ms.this_month_cost || 0), netThisYear: parseFloat(ps && ps.this_year || 0) - (feeNum*12) - lm, tenantMonths: months, lifetimeCollected: lc, lifetimeMaintCost: lm, lifetimeNet: lc - (feeNum*months) - lm, lifetimePlatformFees: feeNum*months, settledCount: parseInt(ps && ps.settled_count || 0), failedCount: parseInt(ps && ps.failed_count || 0), totalRequests: parseInt(ms && ms.total_requests || 0) } })
  } catch (e) { next(e) }
})
