import { Router } from 'express'
import { z } from 'zod'
import { query, queryOne } from '../db'
import { requireAuth, requirePerm } from '../middleware/auth'
import { AppError } from '../middleware/errorHandler'
import { canAccessLandlordResource } from '../middleware/scope'
import {
  generateBillsForMeter,
  generateBillsForProperty,
  generateBillsForLandlord,
} from '../services/utilityBilling'

export const utilityRouter = Router()
utilityRouter.use(requireAuth)

// ── BILLS ────────────────────────────────────────────────────
// Tenant: own bills. Landlord (or scoped worker with units.edit /
// units.view_status / payments.view_all): all bills under their landlord.
// Admin: all.
utilityRouter.get('/bills', async (req, res, next) => {
  try {
    const role = req.user!.role
    const isAdmin = role === 'admin' || role === 'super_admin'
    const params: any[] = []
    let where = ''
    if (role === 'tenant') {
      where = `WHERE ub.tenant_id = $${params.push(req.user!.profileId)}`
    } else if (role === 'landlord') {
      where = `WHERE ub.landlord_id = $${params.push(req.user!.profileId)}`
    } else if (['property_manager','onsite_manager','maintenance'].includes(role)) {
      if (!req.user!.landlordId) return res.json({ success: true, data: [] })
      where = `WHERE ub.landlord_id = $${params.push(req.user!.landlordId)}`
    } else if (!isAdmin) {
      return res.json({ success: true, data: [] })
    }
    const bills = await query<any>(`
      SELECT ub.*, u.unit_number, p.name AS property_name,
        m.utility_type, m.label AS meter_label
      FROM utility_bills ub
      JOIN units u       ON u.id = ub.unit_id
      JOIN properties p  ON p.id = u.property_id
      JOIN utility_meters m ON m.id = ub.meter_id
      ${where} ORDER BY ub.billing_cycle_month DESC, p.name ASC`, params)
    res.json({ success: true, data: bills })
  } catch (e) { next(e) }
})

// ── METERS (landlord management) ─────────────────────────────
// Listing is gated on units.edit / units.view_status — same audience as
// the unit-config view, since meter config sits alongside unit setup.

const utilityTypeEnum = ['water','gas','electric','sewer','trash'] as const
const billingMethodEnum = ['submeter','rubs','master_bill_to_landlord'] as const
const rubsMethodEnum = ['occupant_count','sqft','bedrooms','equal_split'] as const

utilityRouter.get('/meters', requirePerm('units.edit', 'units.view_status', 'properties.edit'), async (req, res, next) => {
  try {
    const params: any[] = []
    let where = ''
    if (req.query.propertyId) {
      // S396 fix: validate propertyId belongs to caller's landlord
      // for non-admin callers. Pre-fix, the WHERE clause was just
      // `m.property_id = $1` with no landlord scope — a landlord
      // could pass another landlord's propertyId in the query string
      // and read that property's meter list (label, billing method,
      // rate). Cross-tenant information disclosure.
      const role = req.user!.role
      if (role !== 'admin' && role !== 'super_admin') {
        const callerLandlordId = role === 'landlord'
          ? req.user!.profileId
          : req.user!.landlordId
        if (!callerLandlordId) throw new AppError(403, 'No landlord scope on caller')
        const prop = await queryOne<{ id: string }>(
          `SELECT id FROM properties WHERE id = $1 AND landlord_id = $2`,
          [req.query.propertyId, callerLandlordId])
        if (!prop) throw new AppError(404, 'Property not found')
      }
      where = `WHERE m.property_id = $${params.push(req.query.propertyId)}`
    } else if (req.user!.role === 'landlord') {
      where = `WHERE p.landlord_id = $${params.push(req.user!.profileId)}`
    } else if (req.user!.landlordId) {
      where = `WHERE p.landlord_id = $${params.push(req.user!.landlordId)}`
    }
    const meters = await query<any>(`
      SELECT m.*, p.name AS property_name,
        (SELECT COUNT(*)::int FROM utility_meter_units WHERE meter_id = m.id) AS unit_count,
        (SELECT MAX(billing_cycle_month) FROM utility_meter_readings WHERE meter_id = m.id) AS last_reading_cycle
      FROM utility_meters m
      JOIN properties p ON p.id = m.property_id
      ${where}
      ORDER BY p.name, m.utility_type, m.label
    `, params)
    res.json({ success: true, data: meters })
  } catch (e) { next(e) }
})

utilityRouter.post('/meters', requirePerm('properties.edit'), async (req, res, next) => {
  try {
    const body = z.object({
      propertyId:     z.string().uuid(),
      utilityType:    z.enum(utilityTypeEnum),
      label:          z.string().min(1),
      billingMethod:  z.enum(billingMethodEnum),
      ratePerUnit:    z.number().nonnegative().nullable().optional(),
      baseFee:        z.number().nonnegative().default(0),
      rubsAllocationMethod: z.enum(rubsMethodEnum).nullable().optional(),
    }).parse(req.body)

    // RUBS requires an allocation method; the inverse (non-RUBS w/
    // allocation set) violates the existing utility_meters_check.
    if (body.billingMethod === 'rubs' && !body.rubsAllocationMethod) {
      throw new AppError(400, 'RUBS billing requires rubsAllocationMethod')
    }
    if (body.billingMethod !== 'rubs' && body.rubsAllocationMethod) {
      throw new AppError(400, 'rubsAllocationMethod only valid when billingMethod is rubs')
    }

    const property = await queryOne<any>(
      `SELECT id, landlord_id FROM properties WHERE id = $1`, [body.propertyId])
    if (!property) throw new AppError(404, 'Property not found')
    if (!canAccessLandlordResource(req.user, property.landlord_id)) {
      throw new AppError(403, 'Forbidden')
    }

    const meter = await queryOne<any>(`
      INSERT INTO utility_meters
        (property_id, utility_type, label, billing_method, rate_per_unit,
         base_fee, rubs_allocation_method)
      VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [body.propertyId, body.utilityType, body.label, body.billingMethod,
       body.ratePerUnit ?? null, body.baseFee,
       body.rubsAllocationMethod ?? null])
    res.status(201).json({ success: true, data: meter })
  } catch (e) { next(e) }
})

utilityRouter.patch('/meters/:id', requirePerm('properties.edit'), async (req, res, next) => {
  try {
    const meter = await queryOne<any>(
      `SELECT m.*, p.landlord_id FROM utility_meters m
         JOIN properties p ON p.id = m.property_id
        WHERE m.id = $1`, [req.params.id])
    if (!meter) throw new AppError(404, 'Meter not found')
    if (!canAccessLandlordResource(req.user, meter.landlord_id)) {
      throw new AppError(403, 'Forbidden')
    }

    const body = z.object({
      label:          z.string().min(1).optional(),
      ratePerUnit:    z.number().nonnegative().nullable().optional(),
      baseFee:        z.number().nonnegative().optional(),
      rubsAllocationMethod: z.enum(rubsMethodEnum).nullable().optional(),
    }).parse(req.body)

    const updated = await queryOne<any>(`
      UPDATE utility_meters SET
        label = COALESCE($1, label),
        rate_per_unit = COALESCE($2, rate_per_unit),
        base_fee = COALESCE($3, base_fee),
        rubs_allocation_method = CASE WHEN $4::text = '__keep__' THEN rubs_allocation_method ELSE $5 END,
        updated_at = NOW()
      WHERE id = $6 RETURNING *`,
      [
        body.label ?? null,
        body.ratePerUnit ?? null,
        body.baseFee ?? null,
        body.rubsAllocationMethod === undefined ? '__keep__' : 'set',
        body.rubsAllocationMethod === undefined ? null : (body.rubsAllocationMethod ?? null),
        req.params.id,
      ])
    res.json({ success: true, data: updated })
  } catch (e) { next(e) }
})

utilityRouter.delete('/meters/:id', requirePerm('properties.edit'), async (req, res, next) => {
  try {
    const meter = await queryOne<any>(
      `SELECT m.*, p.landlord_id FROM utility_meters m
         JOIN properties p ON p.id = m.property_id
        WHERE m.id = $1`, [req.params.id])
    if (!meter) throw new AppError(404, 'Meter not found')
    if (!canAccessLandlordResource(req.user, meter.landlord_id)) {
      throw new AppError(403, 'Forbidden')
    }
    // RESTRICT FK from utility_bills will block delete if any bills
    // reference this meter — that's by design (bills are the legal record
    // of what was charged; meter delete with bills should fail loud).
    await query(`DELETE FROM utility_meters WHERE id = $1`, [req.params.id])
    res.json({ success: true })
  } catch (e: any) {
    if (e?.code === '23503') {
      return next(new AppError(409, 'Cannot delete meter with existing bills'))
    }
    next(e)
  }
})

// ── METER ↔ UNIT ASSIGNMENT ──────────────────────────────────
utilityRouter.post('/meters/:id/units', requirePerm('properties.edit'), async (req, res, next) => {
  try {
    const { unitId } = z.object({ unitId: z.string().uuid() }).parse(req.body)
    const meter = await queryOne<any>(
      `SELECT m.*, p.landlord_id FROM utility_meters m
         JOIN properties p ON p.id = m.property_id
        WHERE m.id = $1`, [req.params.id])
    if (!meter) throw new AppError(404, 'Meter not found')
    if (!canAccessLandlordResource(req.user, meter.landlord_id)) {
      throw new AppError(403, 'Forbidden')
    }
    const unit = await queryOne<any>(
      `SELECT id FROM units WHERE id = $1 AND landlord_id = $2`,
      [unitId, meter.landlord_id])
    if (!unit) throw new AppError(404, 'Unit not found under this landlord')

    await query(`
      INSERT INTO utility_meter_units (meter_id, unit_id) VALUES ($1, $2)
      ON CONFLICT DO NOTHING
    `, [req.params.id, unitId])
    res.status(201).json({ success: true })
  } catch (e) { next(e) }
})

utilityRouter.delete('/meters/:id/units/:unitId', requirePerm('properties.edit'), async (req, res, next) => {
  try {
    const meter = await queryOne<any>(
      `SELECT m.*, p.landlord_id FROM utility_meters m
         JOIN properties p ON p.id = m.property_id
        WHERE m.id = $1`, [req.params.id])
    if (!meter) throw new AppError(404, 'Meter not found')
    if (!canAccessLandlordResource(req.user, meter.landlord_id)) {
      throw new AppError(403, 'Forbidden')
    }
    await query(`DELETE FROM utility_meter_units WHERE meter_id = $1 AND unit_id = $2`,
      [req.params.id, req.params.unitId])
    res.json({ success: true })
  } catch (e) { next(e) }
})

// ── METER READINGS ───────────────────────────────────────────
utilityRouter.get('/meters/:id/readings', requirePerm('units.edit', 'units.view_status', 'properties.edit'), async (req, res, next) => {
  try {
    const meter = await queryOne<any>(
      `SELECT m.*, p.landlord_id FROM utility_meters m
         JOIN properties p ON p.id = m.property_id
        WHERE m.id = $1`, [req.params.id])
    if (!meter) throw new AppError(404, 'Meter not found')
    if (!canAccessLandlordResource(req.user, meter.landlord_id)) {
      throw new AppError(403, 'Forbidden')
    }
    const readings = await query<any>(`
      SELECT * FROM utility_meter_readings
       WHERE meter_id = $1
       ORDER BY billing_cycle_month DESC, reading_date DESC`,
      [req.params.id])
    res.json({ success: true, data: readings })
  } catch (e) { next(e) }
})

utilityRouter.post('/meters/:id/readings', requirePerm('properties.edit'), async (req, res, next) => {
  try {
    const body = z.object({
      readingDate:        z.string(),                  // YYYY-MM-DD
      readingValue:       z.number(),
      billingCycleMonth:  z.string(),                  // YYYY-MM-01
    }).parse(req.body)
    const meter = await queryOne<any>(
      `SELECT m.*, p.landlord_id FROM utility_meters m
         JOIN properties p ON p.id = m.property_id
        WHERE m.id = $1`, [req.params.id])
    if (!meter) throw new AppError(404, 'Meter not found')
    if (!canAccessLandlordResource(req.user, meter.landlord_id)) {
      throw new AppError(403, 'Forbidden')
    }
    const reading = await queryOne<any>(`
      INSERT INTO utility_meter_readings
        (meter_id, reading_date, reading_value, billing_cycle_month, created_by_user_id)
      VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [req.params.id, body.readingDate, body.readingValue,
       body.billingCycleMonth, req.user!.userId])
    res.status(201).json({ success: true, data: reading })
  } catch (e) { next(e) }
})

// ── BILL GENERATION TRIGGER ──────────────────────────────────
// Scope: one of meterId | propertyId | landlord-self.
// cycleMonth is YYYY-MM-DD (1st of month). Idempotent — re-running for
// the same cycle won't duplicate bills (UNIQUE on meter_id + unit_id +
// billing_cycle_month).
utilityRouter.post('/generate-bills', requirePerm('properties.edit'), async (req, res, next) => {
  try {
    const body = z.object({
      cycleMonth: z.string().regex(/^\d{4}-\d{2}-01$/, 'cycleMonth must be YYYY-MM-01'),
      meterId:    z.string().uuid().optional(),
      propertyId: z.string().uuid().optional(),
    }).parse(req.body)

    const cycleDate = new Date(body.cycleMonth + 'T00:00:00Z')

    if (body.meterId) {
      const meter = await queryOne<any>(
        `SELECT m.*, p.landlord_id FROM utility_meters m
           JOIN properties p ON p.id = m.property_id
          WHERE m.id = $1`, [body.meterId])
      if (!meter) throw new AppError(404, 'Meter not found')
      if (!canAccessLandlordResource(req.user, meter.landlord_id)) {
        throw new AppError(403, 'Forbidden')
      }
      const result = await generateBillsForMeter(body.meterId, cycleDate)
      return res.json({ success: true, data: [result] })
    }

    if (body.propertyId) {
      const property = await queryOne<any>(
        `SELECT id, landlord_id FROM properties WHERE id = $1`, [body.propertyId])
      if (!property) throw new AppError(404, 'Property not found')
      if (!canAccessLandlordResource(req.user, property.landlord_id)) {
        throw new AppError(403, 'Forbidden')
      }
      const results = await generateBillsForProperty(body.propertyId, cycleDate)
      return res.json({ success: true, data: results })
    }

    // No scope arg — generate for the calling landlord (or admin must specify).
    const landlordId = req.user!.role === 'landlord'
      ? req.user!.profileId
      : req.user!.landlordId
    if (!landlordId) {
      throw new AppError(400, 'meterId or propertyId required for admin/super_admin calls')
    }
    const results = await generateBillsForLandlord(landlordId, cycleDate)
    res.json({ success: true, data: results })
  } catch (e) { next(e) }
})

// POST /api/utility/bills/:id/finalize — landlord/admin marks a bill as
// 'billed' (sent to tenant for payment). Required transition before the
// tenant pay route will accept the bill. S123 closes the S122 gap where
// bills sat in 'unbilled' forever with no path to 'billed'.
//
// Auth: same gate as meter management (`properties.edit`) — billing
// finalization is a property-level admin action.
utilityRouter.post('/bills/:id/finalize', requirePerm('properties.edit'), async (req: any, res, next) => {
  try {
    const bill = await queryOne<{ id: string; landlord_id: string; status: string }>(
      `SELECT id, landlord_id, status FROM utility_bills WHERE id=$1`, [req.params.id]
    )
    if (!bill) throw new AppError(404, 'Utility bill not found')
    if (!canAccessLandlordResource(req.user, bill.landlord_id)) {
      throw new AppError(403, 'Forbidden')
    }
    if (bill.status !== 'unbilled') {
      throw new AppError(409, `Bill is ${bill.status}; only 'unbilled' can be finalized`)
    }
    const updated = await queryOne<any>(
      `UPDATE utility_bills SET status='billed', billed_at=NOW(), updated_at=NOW() WHERE id=$1 RETURNING *`,
      [req.params.id]
    )
    res.json({ success: true, data: updated })
  } catch (e) { next(e) }
})

// POST /api/utility/bills/:id/pay — DEPRECATED at S178.
//
// Pre-S178 this route created a separate payments row per utility bill,
// fired its own Stripe destination charge, and ran a parallel settlement
// path. That broke the architectural intent recorded at S90 ("utilities
// are line items on the rent invoice"). Tenants saw a separate Pay Now
// button per utility bill alongside their rent payments — a UX they
// shouldn't have to track.
//
// S178 fixed-forward by wiring utility_bills into invoiceGeneration:
// utilities now ride the rent invoice as type='utility' child payment
// rows linked via invoice_id. Tenants pay them through the standard
// /api/payments/:id/pay flow against the utility-typed payment row;
// the existing S122 webhook handler still flips utility_bills.status='paid'
// on settlement.
//
// This handler returns 410 Gone with a pointer to the new path. Kept
// registered so any cached frontend or third-party integration calling
// the old route gets a clean error rather than a 404.
utilityRouter.post('/bills/:id/pay', async (req: any, _res, next) => {
  try {
    if (req.user!.role !== 'tenant') {
      throw new AppError(403, 'Only tenants can call this endpoint')
    }
    // Look up the linked invoice payment so the error message can point
    // the caller directly at the correct /payments/:id/pay path.
    const linked = await queryOne<{ payment_id: string | null }>(
      `SELECT payment_id FROM utility_bills WHERE id = $1 AND tenant_id = $2`,
      [req.params.id, req.user!.profileId],
    )
    if (!linked) throw new AppError(404, 'Utility bill not found')
    if (!linked.payment_id) {
      // Bill exists but invoiceGeneration hasn't picked it up yet (next
      // cycle's rent invoice will fold it in). Surface the wait state.
      throw new AppError(409, 'This utility bill has not been invoiced yet. It will appear as a line item on your next rent invoice.')
    }
    throw new AppError(
      410,
      `This endpoint was retired in S178. Pay this utility through POST /api/payments/${linked.payment_id}/pay (utility now invoices as a line item on the rent invoice).`,
    )
  } catch (e) { next(e) }
})

