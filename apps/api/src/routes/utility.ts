import { Router } from 'express'
import { z } from 'zod'
import { meterReadingModulus, METER_READING_DIGIT_OPTIONS, METER_READING_DEFAULT_DIGITS, METER_USAGE_ALERT_THRESHOLDS } from '@gam/shared'
import { query, queryOne } from '../db'
import { requireAuth, requirePerm } from '../middleware/auth'
import { AppError } from '../middleware/errorHandler'
import { canAccessLandlordResource } from '../middleware/scope'
import {
  generateBillsForMeter,
  generateBillsForProperty,
  generateBillsForLandlord,
} from '../services/utilityBilling'
import {
  openReadingRun,
  getRunMeters,
  completeReadingRun,
  isRunFullyRead,
  startDoubleCheckPhase,
  getDoubleChecks,
  enterDoubleCheck,
  countEscalations,
} from '../services/utilityReadingRuns'

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
        m.label AS meter_label, m.digits
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
        (SELECT MAX(billing_cycle_month) FROM utility_meter_readings WHERE meter_id = m.id) AS last_reading_cycle,
        -- W-36 (S531): assigned unit ids ride along so the management UI can
        -- render/edit assignments without an N+1 per meter.
        ARRAY(SELECT unit_id FROM utility_meter_units WHERE meter_id = m.id) AS assigned_unit_ids
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
      // Odometer width — how many digits the physical meter face has.
      digits:         z.number().int().refine(
        d => (METER_READING_DIGIT_OPTIONS as readonly number[]).includes(d),
        `digits must be one of ${METER_READING_DIGIT_OPTIONS.join(', ')}`,
      ).default(METER_READING_DEFAULT_DIGITS),
      // Sewer rides the water meter (S533) — same reading bills sewer
      // at this rate. Water meters only; there is no sewer meter.
      sewerRatePerUnit: z.number().nonnegative().nullable().optional(),
    }).parse(req.body)
    if (body.sewerRatePerUnit != null && body.utilityType !== 'water') {
      throw new AppError(400, 'Sewer rate only applies to water meters — sewer bills off the water reading')
    }

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
         base_fee, rubs_allocation_method, digits, sewer_rate_per_unit)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [body.propertyId, body.utilityType, body.label, body.billingMethod,
       body.ratePerUnit ?? null, body.baseFee,
       body.rubsAllocationMethod ?? null, body.digits, body.sewerRatePerUnit ?? null])
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
      digits:         z.number().int().refine(
        d => (METER_READING_DIGIT_OPTIONS as readonly number[]).includes(d),
        `digits must be one of ${METER_READING_DIGIT_OPTIONS.join(', ')}`,
      ).optional(),
      sewerRatePerUnit: z.number().nonnegative().nullable().optional(),
    }).parse(req.body)
    if (body.sewerRatePerUnit != null && meter.utility_type !== 'water') {
      throw new AppError(400, 'Sewer rate only applies to water meters — sewer bills off the water reading')
    }

    // Shrinking the width below an existing reading would corrupt the
    // rollover math (a stored 45210 can't live on a 4-digit meter).
    if (body.digits != null) {
      const maxRead = await queryOne<{ max: string | null }>(
        `SELECT MAX(reading_value) AS max FROM utility_meter_readings WHERE meter_id = $1`,
        [req.params.id])
      if (maxRead?.max != null && Number(maxRead.max) >= meterReadingModulus(body.digits)) {
        throw new AppError(400, `This meter has a recorded reading of ${maxRead.max} — it can't be a ${body.digits}-digit meter`)
      }
    }

    const updated = await queryOne<any>(`
      UPDATE utility_meters SET
        label = COALESCE($1, label),
        rate_per_unit = COALESCE($2, rate_per_unit),
        base_fee = COALESCE($3, base_fee),
        rubs_allocation_method = CASE WHEN $4::text = '__keep__' THEN rubs_allocation_method ELSE $5 END,
        digits = COALESCE($6, digits),
        sewer_rate_per_unit = CASE WHEN $7::text = '__keep__' THEN sewer_rate_per_unit ELSE $8::numeric END,
        updated_at = NOW()
      WHERE id = $9 RETURNING *`,
      [
        body.label ?? null,
        body.ratePerUnit ?? null,
        body.baseFee ?? null,
        body.rubsAllocationMethod === undefined ? '__keep__' : 'set',
        body.rubsAllocationMethod === undefined ? null : (body.rubsAllocationMethod ?? null),
        body.digits ?? null,
        body.sewerRatePerUnit === undefined ? '__keep__' : 'set',
        body.sewerRatePerUnit === undefined ? null : body.sewerRatePerUnit,
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

// ── UTILITY TAX RATES (landlord-entered; S533) ───────────────
// Per property, per utility type (+ 'propane'). Landlord-configured —
// never state-derived (no-state-specific-logic rule). Snapshotted onto
// bills/fills at billing time.
const TAX_TYPES = ['water','gas','electric','sewer','trash','propane'] as const

utilityRouter.get('/tax-rates', requirePerm('units.edit', 'units.view_status', 'properties.edit'), async (req, res, next) => {
  try {
    const propertyId = z.string().uuid().parse(req.query.propertyId)
    const property = await queryOne<any>(
      `SELECT id, landlord_id FROM properties WHERE id = $1`, [propertyId])
    if (!property) throw new AppError(404, 'Property not found')
    if (!canAccessLandlordResource(req.user, property.landlord_id)) {
      throw new AppError(403, 'Forbidden')
    }
    const rows = await query<any>(
      `SELECT utility_type, tax_rate_pct, label FROM property_utility_tax_rates
        WHERE property_id = $1`, [propertyId])
    res.json({ success: true, data: rows })
  } catch (e) { next(e) }
})

utilityRouter.post('/tax-rates', requirePerm('properties.edit'), async (req, res, next) => {
  try {
    const body = z.object({
      propertyId:  z.string().uuid(),
      utilityType: z.enum(TAX_TYPES),
      taxRatePct:  z.number().min(0).max(100),
      label:       z.string().max(60).nullable().optional(),
    }).parse(req.body)
    const property = await queryOne<any>(
      `SELECT id, landlord_id FROM properties WHERE id = $1`, [body.propertyId])
    if (!property) throw new AppError(404, 'Property not found')
    if (!canAccessLandlordResource(req.user, property.landlord_id)) {
      throw new AppError(403, 'Forbidden')
    }
    const row = await queryOne<any>(
      `INSERT INTO property_utility_tax_rates (property_id, utility_type, tax_rate_pct, label)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (property_id, utility_type)
       DO UPDATE SET tax_rate_pct = EXCLUDED.tax_rate_pct, label = EXCLUDED.label, updated_at = NOW()
       RETURNING utility_type, tax_rate_pct, label`,
      [body.propertyId, body.utilityType, body.taxRatePct, body.label ?? null])
    res.json({ success: true, data: row })
  } catch (e) { next(e) }
})

// ── READING RUNS (end-of-month workflow) ─────────────────────
// The scheduler opens a run per property on the last business day of
// the month; these routes power the guided walk. Reading entry inside
// a run stamps the run's cycle automatically; when the last meter is
// read the run completes itself — bills generate + finalize and ride
// the tenant's next monthly invoice (S178).

// List runs for a property (open first, then recent history).
utilityRouter.get('/reading-runs', requirePerm('units.edit', 'units.view_status', 'properties.edit'), async (req, res, next) => {
  try {
    const propertyId = z.string().uuid().parse(req.query.propertyId)
    const property = await queryOne<any>(
      `SELECT id, landlord_id FROM properties WHERE id = $1`, [propertyId])
    if (!property) throw new AppError(404, 'Property not found')
    if (!canAccessLandlordResource(req.user, property.landlord_id)) {
      throw new AppError(403, 'Forbidden')
    }
    const runs = await query<any>(
      `SELECT r.*,
              (SELECT COUNT(*)::int FROM utility_meters m
                WHERE m.property_id = r.property_id
                  AND m.billing_method IN ('submeter','rubs')) AS meters_total,
              (SELECT COUNT(*)::int FROM utility_meters m
                 JOIN utility_meter_readings rd
                   ON rd.meter_id = m.id AND rd.billing_cycle_month = r.billing_cycle_month
                WHERE m.property_id = r.property_id
                  AND m.billing_method IN ('submeter','rubs')) AS meters_read,
              (SELECT COUNT(*)::int FROM utility_reading_double_checks dc
                WHERE dc.run_id = r.id) AS dc_total,
              (SELECT COUNT(*)::int FROM utility_reading_double_checks dc
                WHERE dc.run_id = r.id AND dc.second_value IS NOT NULL) AS dc_done
         FROM utility_reading_runs r
        WHERE r.property_id = $1
        ORDER BY (r.status IN ('open','double_check')) DESC, r.billing_cycle_month DESC
        LIMIT 12`,
      [propertyId])
    res.json({ success: true, data: runs })
  } catch (e) { next(e) }
})

// Manual open — lets a landlord start the run before the scheduled last
// business day (or re-open coverage for a property added mid-month).
utilityRouter.post('/reading-runs', requirePerm('properties.edit'), async (req, res, next) => {
  try {
    const body = z.object({
      propertyId: z.string().uuid(),
      cycleMonth: z.string().regex(/^\d{4}-\d{2}-01$/, 'cycleMonth must be YYYY-MM-01').optional(),
    }).parse(req.body)
    const property = await queryOne<any>(
      `SELECT id, landlord_id FROM properties WHERE id = $1`, [body.propertyId])
    if (!property) throw new AppError(404, 'Property not found')
    if (!canAccessLandlordResource(req.user, property.landlord_id)) {
      throw new AppError(403, 'Forbidden')
    }
    const cycle = body.cycleMonth
      ?? new Date().toISOString().slice(0, 7) + '-01'
    const run = await openReadingRun(body.propertyId, cycle, { notify: false })
    if (!run) throw new AppError(400, 'Property has no readable meters (submeter or RUBS)')
    res.status(201).json({ success: true, data: run })
  } catch (e) { next(e) }
})

// Guided-walk payload: every readable meter with unit, prior reading,
// this-cycle reading (if entered) and whether a lease makes the tenant
// responsible (the auto-calc/bill preview).
utilityRouter.get('/reading-runs/:id/meters', requirePerm('units.edit', 'units.view_status', 'properties.edit'), async (req, res, next) => {
  try {
    const run = await queryOne<any>(
      `SELECT * FROM utility_reading_runs WHERE id = $1`, [req.params.id])
    if (!run) throw new AppError(404, 'Reading run not found')
    if (!canAccessLandlordResource(req.user, run.landlord_id)) {
      throw new AppError(403, 'Forbidden')
    }
    res.json({ success: true, data: await getRunMeters(req.params.id) })
  } catch (e) { next(e) }
})

// Enter one meter's reading inside a run. Cycle comes from the run —
// the reader never picks dates. Auto-completes the run (generate +
// finalize bills) when this was the last unread meter.
utilityRouter.post('/reading-runs/:id/meters/:meterId/reading', requirePerm('properties.edit'), async (req, res, next) => {
  try {
    // Reads are odometer values; the digit width is per-meter (landlord
    // setting). Bounds are checked against the meter's own capacity
    // after the meter row is fetched below.
    const body = z.object({ readingValue: z.number().int().min(0) }).parse(req.body)
    const run = await queryOne<any>(
      `SELECT * FROM utility_reading_runs WHERE id = $1`, [req.params.id])
    if (!run) throw new AppError(404, 'Reading run not found')
    if (!canAccessLandlordResource(req.user, run.landlord_id)) {
      throw new AppError(403, 'Forbidden')
    }
    if (run.status !== 'open') throw new AppError(409, 'Reading run is already completed')
    const meter = await queryOne<any>(
      `SELECT m.* FROM utility_meters m
        WHERE m.id = $1 AND m.property_id = $2`, [req.params.meterId, run.property_id])
    if (!meter) throw new AppError(404, 'Meter not found on this run')
    const modulus = meterReadingModulus(meter.digits)
    if (body.readingValue >= modulus) {
      throw new AppError(400, `Reading exceeds this meter's ${meter.digits}-digit capacity`)
    }

    // Below-previous handling (S533): rollover is AUTOMATIC — RV parks
    // roll meters constantly and a double-check per rollover wastes the
    // manager's time. wrap = (10^digits − prior) + current; a plausible
    // wrap (< half the meter's range) bills as a rollover with no
    // friction. A wrap ≥ half the range is almost certainly a typo or a
    // meter swap — NOT billed; silently flagged for the landlord
    // double-check (NO GIVEAWAYS to the reader either way: identical
    // 201, nothing in the response).
    const prior = await queryOne<{ reading_value: string }>(
      `SELECT reading_value FROM utility_meter_readings
        WHERE meter_id = $1 AND billing_cycle_month < $2
        ORDER BY billing_cycle_month DESC, reading_date DESC LIMIT 1`,
      [meter.id, run.billing_cycle_month])
    let isRollover = false
    let needsReview = false
    let reviewNote: string | null = null
    if (prior && body.readingValue < Number(prior.reading_value)) {
      const wrap = (modulus - Number(prior.reading_value)) + body.readingValue
      if (wrap < modulus / 2) isRollover = true
      else {
        needsReview = true
        reviewNote = 'Reading is below the previous reading — double-check the meter'
      }
    }
    // Suspicious-usage flag (Nic, S533) — individual submeters only.
    // Wrap-aware usage over the utility type's threshold is silently
    // flagged and held from billing until the landlord double-checks —
    // a misread that slipped past the rollover guard would otherwise
    // land a huge charge on the tenant's next invoice.
    if (!needsReview && meter.billing_method === 'submeter' && prior) {
      const threshold = METER_USAGE_ALERT_THRESHOLDS[meter.utility_type] ?? null
      const usage = isRollover
        ? (modulus - Number(prior.reading_value)) + body.readingValue
        : body.readingValue - Number(prior.reading_value)
      if (threshold != null && usage > threshold) {
        needsReview = true
        reviewNote = `Unusually high usage this cycle (${usage.toLocaleString()}) — double-check the meter`
      }
    }

    const reading = await queryOne<any>(
      `INSERT INTO utility_meter_readings
         (meter_id, reading_date, reading_value, billing_cycle_month, created_by_user_id,
          needs_review, review_note, is_rollover)
       VALUES ($1, CURRENT_DATE, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (meter_id, billing_cycle_month)
       DO UPDATE SET reading_value = EXCLUDED.reading_value,
                     reading_date = EXCLUDED.reading_date,
                     created_by_user_id = EXCLUDED.created_by_user_id,
                     needs_review = EXCLUDED.needs_review,
                     review_note = EXCLUDED.review_note,
                     is_rollover = EXCLUDED.is_rollover
       RETURNING id, meter_id, billing_cycle_month`,
      [meter.id, body.readingValue, run.billing_cycle_month, req.user!.userId,
       needsReview, reviewNote, isRollover])

    // When the last meter is read, the run moves to its VERIFICATION
    // phase (S533) — the system builds the blind double-check list and
    // billing waits for it. No mid-walk interruptions ever.
    let updatedRun = null
    if (await isRunFullyRead(run.id)) {
      updatedRun = await startDoubleCheckPhase(run.id)
    }
    // Response deliberately excludes reading_value/needs_review — the
    // walk client needs only confirmation + run state (+ the size of
    // the freshly generated verification list for the summary screen).
    const dcTotal = updatedRun?.status === 'double_check'
      ? (await getDoubleChecks(run.id)).length : 0
    res.status(201).json({ success: true, data: { reading, run: updatedRun ?? run, dcTotal } })
  } catch (e) { next(e) }
})

// ── DOUBLE-CHECK VERIFICATION (blind re-read walk) ───────────
utilityRouter.get('/reading-runs/:id/double-checks', requirePerm('units.edit', 'units.view_status', 'properties.edit'), async (req, res, next) => {
  try {
    const run = await queryOne<any>(
      `SELECT * FROM utility_reading_runs WHERE id = $1`, [req.params.id])
    if (!run) throw new AppError(404, 'Reading run not found')
    if (!canAccessLandlordResource(req.user, run.landlord_id)) {
      throw new AppError(403, 'Forbidden')
    }
    res.json({ success: true, data: await getDoubleChecks(req.params.id) })
  } catch (e) { next(e) }
})

utilityRouter.post('/reading-runs/:id/double-checks/:meterId', requirePerm('properties.edit'), async (req, res, next) => {
  try {
    const body = z.object({ readingValue: z.number().int().min(0) }).parse(req.body)
    const run = await queryOne<any>(
      `SELECT * FROM utility_reading_runs WHERE id = $1`, [req.params.id])
    if (!run) throw new AppError(404, 'Reading run not found')
    if (!canAccessLandlordResource(req.user, run.landlord_id)) {
      throw new AppError(403, 'Forbidden')
    }
    if (run.status !== 'double_check') throw new AppError(409, 'Run is not in its verification phase')
    const meter = await queryOne<any>(
      `SELECT * FROM utility_meters WHERE id = $1 AND property_id = $2`,
      [req.params.meterId, run.property_id])
    if (!meter) throw new AppError(404, 'Meter not found on this run')
    if (body.readingValue >= meterReadingModulus(meter.digits)) {
      throw new AppError(400, `Reading exceeds this meter's ${meter.digits}-digit capacity`)
    }
    const result = await enterDoubleCheck(run.id, meter.id, body.readingValue, req.user!.userId)
    if (!result) throw new AppError(404, 'Meter is not on this run\'s verification list')
    // Blind on the way out too: no values, no outcome — just run state
    // (+ escalation count once completed, for the landlord-facing summary).
    const escalated = result.run?.status === 'completed' ? await countEscalations(run.id) : 0
    res.status(201).json({ success: true, data: { run: result.run, escalated } })
  } catch (e) { next(e) }
})

// ── FLAGGED READINGS (double-check queue) ────────────────────
// Readings the walk silently flagged (below previous). The reviewer —
// unlike the reader — sees both values; that's the point of the check.
utilityRouter.get('/readings/flagged', requirePerm('units.edit', 'units.view_status', 'properties.edit'), async (req, res, next) => {
  try {
    const propertyId = z.string().uuid().parse(req.query.propertyId)
    const property = await queryOne<any>(
      `SELECT id, landlord_id FROM properties WHERE id = $1`, [propertyId])
    if (!property) throw new AppError(404, 'Property not found')
    if (!canAccessLandlordResource(req.user, property.landlord_id)) {
      throw new AppError(403, 'Forbidden')
    }
    const rows = await query<any>(
      `SELECT r.id, r.reading_value, r.reading_date, r.billing_cycle_month, r.review_note,
              m.id AS meter_id, m.label, m.utility_type, m.digits,
              (SELECT u.unit_number FROM utility_meter_units mu JOIN units u ON u.id = mu.unit_id
                WHERE mu.meter_id = m.id LIMIT 1) AS unit_number,
              prior.reading_value AS prior_reading_value,
              prior.reading_date  AS prior_reading_date
         FROM utility_meter_readings r
         JOIN utility_meters m ON m.id = r.meter_id
         LEFT JOIN LATERAL (
                SELECT reading_value, reading_date FROM utility_meter_readings p
                 WHERE p.meter_id = r.meter_id AND p.billing_cycle_month < r.billing_cycle_month
                 ORDER BY p.billing_cycle_month DESC, p.reading_date DESC LIMIT 1
              ) prior ON TRUE
        WHERE m.property_id = $1 AND r.needs_review
        ORDER BY r.billing_cycle_month DESC, m.label`,
      [propertyId])
    res.json({ success: true, data: rows })
  } catch (e) { next(e) }
})

// Resolve a flagged reading: save a corrected value, or confirm the low
// reading is genuine. A genuine low read is one of two different things
// and the money outcome differs:
//   rollover=true  — the 6-digit odometer wrapped past 999999; the
//                    engine bills wrap-around usage (MODULUS − prior) + current.
//   rollover=false — meter swap/reset; nothing bills that cycle (new
//                    meter, unknown usage).
// Either way the flag clears; if the cycle's run already completed,
// billing re-runs for that meter (idempotent — UNIQUE meter+unit+cycle).
utilityRouter.post('/readings/:id/resolve-review', requirePerm('properties.edit'), async (req, res, next) => {
  try {
    const body = z.object({
      correctedValue: z.number().int().min(0).optional(),
      rollover: z.boolean().optional(),
    }).parse(req.body)
    const reading = await queryOne<any>(
      `SELECT r.*, m.property_id, m.digits, p.landlord_id
         FROM utility_meter_readings r
         JOIN utility_meters m ON m.id = r.meter_id
         JOIN properties p ON p.id = m.property_id
        WHERE r.id = $1`, [req.params.id])
    if (!reading) throw new AppError(404, 'Reading not found')
    if (!canAccessLandlordResource(req.user, reading.landlord_id)) {
      throw new AppError(403, 'Forbidden')
    }
    if (!reading.needs_review) throw new AppError(409, 'Reading is not flagged for review')
    if (body.correctedValue != null && body.correctedValue >= meterReadingModulus(reading.digits)) {
      throw new AppError(400, `Reading exceeds this meter's ${reading.digits}-digit capacity`)
    }

    const updated = await queryOne<any>(
      `UPDATE utility_meter_readings
          SET reading_value = COALESCE($2, reading_value),
              needs_review = FALSE,
              is_rollover = $4,
              review_note = $3
        WHERE id = $1 RETURNING *`,
      [req.params.id, body.correctedValue ?? null,
       (body.correctedValue != null ? 'Corrected after double-check' : 'Confirmed correct after double-check')
         + (body.rollover ? ' (rollover)' : ''),
       !!body.rollover])

    // If this cycle's run already completed, the flagged meter was
    // skipped by the engine (negative usage) — re-run it now.
    let billsCreated = 0
    const run = await queryOne<any>(
      `SELECT * FROM utility_reading_runs
        WHERE property_id = $1 AND billing_cycle_month = $2 AND status = 'completed'`,
      [reading.property_id, reading.billing_cycle_month])
    if (run) {
      const cycleDay = reading.billing_cycle_month instanceof Date
        ? `${reading.billing_cycle_month.getFullYear()}-${String(reading.billing_cycle_month.getMonth() + 1).padStart(2, '0')}-${String(reading.billing_cycle_month.getDate()).padStart(2, '0')}`
        : String(reading.billing_cycle_month).slice(0, 10)
      const result = await generateBillsForMeter(reading.meter_id, new Date(cycleDay + 'T00:00:00Z'))
      billsCreated = result.billsCreated || 0
      if (billsCreated > 0) {
        await query(
          `UPDATE utility_bills SET status = 'billed', billed_at = NOW(), updated_at = NOW()
            WHERE meter_id = $1 AND billing_cycle_month = $2 AND status = 'unbilled'`,
          [reading.meter_id, reading.billing_cycle_month])
      }
    }
    res.json({ success: true, data: { reading: updated, billsCreated } })
  } catch (e) { next(e) }
})

// Force-complete a stuck run — e.g. a physically unreadable meter
// blocking the walk, or a verification phase that can't finish. Bills
// whatever is clean; flagged/unread meters produce no bill this cycle.
// Surfaced on the run banner (S534) because a missing original read on
// a tenant-responsible submeter now HOLDS that unit's invoice — this is
// the landlord's unblock.
utilityRouter.post('/reading-runs/:id/complete', requirePerm('properties.edit'), async (req, res, next) => {
  try {
    const run = await queryOne<any>(
      `SELECT * FROM utility_reading_runs WHERE id = $1`, [req.params.id])
    if (!run) throw new AppError(404, 'Reading run not found')
    if (!canAccessLandlordResource(req.user, run.landlord_id)) {
      throw new AppError(403, 'Forbidden')
    }
    if (run.status === 'completed') throw new AppError(409, 'Reading run is already completed')
    const completed = await completeReadingRun(run.id, req.user!.userId)
    res.json({ success: true, data: completed })
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

