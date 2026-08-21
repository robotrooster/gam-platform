import { Router } from 'express'
import { z } from 'zod'
import { meterReadingModulus, METER_READING_DIGIT_OPTIONS, METER_READING_DEFAULT_DIGITS, METER_USAGE_ALERT_THRESHOLDS, MASTER_TOTAL_JUMP_FACTOR, METER_READ_REASONS, RUBS_ALLOCATION_METHODS, RUBS_BASES, RUBS_SUBMETER_RATES, RUBS_EXCLUSION_MODES } from '@gam/shared'
import { query, queryOne, getClient } from '../db'
import { requireAuth, requirePerm, assertPropertyInScope, getScopedPropertyIds } from '../middleware/auth'
import { AppError } from '../middleware/errorHandler'
import { canAccessLandlordResource, canManageLandlordResource } from '../middleware/scope'
import {
  generateBillsForMeter,
  generateBillsForProperty,
  generateBillsForLandlord,
  billMoveOutRead,
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
  getReadsDue,
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

// S613 (Nic): propane joins the list — a central tank split across spaces is a
// RUBS master like any other, and a flat monthly propane charge is a flat
// charge like any other. A per-space TANK is the third shape and is not a meter
// at all (units.has_propane_tank); it bills off deliveries, not readings.
const utilityTypeEnum = ['water','gas','electric','sewer','trash','propane'] as const
// S609 (Nic): PROPANE has a property-level price per gallon too — "we need a way
// to also set the rate for the propane at the property level, that way when
// we're putting in gallons it can calculate the bill for that tenant correctly."
// It is NOT a meterable utility (there is no propane meter — fills are events),
// so it belongs in the RATES list without joining the meter list.
const rateUtilityTypeEnum = utilityTypeEnum
const billingMethodEnum = ['submeter','rubs','master_bill_to_landlord','flat_rate'] as const
// Single source of truth lives in @gam/shared — never re-declare here.
const rubsMethodEnum = RUBS_ALLOCATION_METHODS

utilityRouter.get('/meters', requirePerm('units.edit', 'units.view_status', 'properties.edit', 'utility.read_meters'), async (req, res, next) => {
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
    // S560: a property-locked worker (e.g. front-desk onsite_manager with
    // utility.read_meters) may only see meters at their assigned properties.
    // null = unrestricted (owners / all_properties).
    const scopedPropIds = await getScopedPropertyIds(req.user)
    if (scopedPropIds !== null) {
      where += `${where ? ' AND' : 'WHERE'} m.property_id = ANY($${params.push(scopedPropIds)}::uuid[])`
    }
    const meters = await query<any>(`
      SELECT m.*, p.name AS property_name,
        (SELECT COUNT(*)::int FROM utility_meter_units WHERE meter_id = m.id) AS unit_count,
        (SELECT MAX(billing_cycle_month) FROM utility_meter_readings WHERE meter_id = m.id) AS last_reading_cycle,
        -- S605 (Nic): a submeter with no read at all cannot produce a bill —
        -- there is no prior value to subtract from — and today that failure is
        -- SILENT. Surfacing it per meter lets the utilities page say so before
        -- the cycle closes instead of the landlord discovering a missing bill
        -- after the fact. Only submeters are affected: RUBS and master-bill
        -- allocate from the property invoice and never read an odometer.
        (m.billing_method <> 'submeter'
         OR EXISTS (SELECT 1 FROM utility_meter_readings WHERE meter_id = m.id)) AS has_baseline,
        -- S613: the opening read itself, so a landlord who mistyped one can SEE
        -- the number and correct it rather than only being told whether one
        -- exists. Null once anything later has been read.
        (SELECT jsonb_build_object('id', r.id, 'value', r.reading_value,
                                   'date', r.reading_date)
           FROM utility_meter_readings r
          WHERE r.meter_id = m.id AND r.reason = 'baseline'
          ORDER BY r.reading_date DESC, r.created_at DESC LIMIT 1) AS opening_read,
        -- W-36 (S531): assigned unit ids ride along so the management UI can
        -- render/edit assignments without an N+1 per meter.
        ARRAY(SELECT unit_id FROM utility_meter_units WHERE meter_id = m.id) AS assigned_unit_ids,
        -- S613: {unitId: count} for a flat charge, so the unit page can show
        -- "2 cans × $25" without a second round trip.
        COALESCE((SELECT jsonb_object_agg(mu.unit_id::text, mu.quantity)
                    FROM utility_meter_units mu WHERE mu.meter_id = m.id), '{}'::jsonb) AS unit_quantities,
        -- S613 (Nic): units on this meter whose ACTIVE lease doesn't bill this
        -- utility back. They are configured perfectly and bill nothing, and the
        -- run says so only as a count of unitsSkipped. Surfaced so a landlord
        -- who has just ticked twenty-seven units onto a new trash charge is told
        -- how many of them will actually produce a charge.
        ARRAY(
          SELECT mu.unit_id FROM utility_meter_units mu
            JOIN leases lz ON lz.unit_id = mu.unit_id AND lz.status = 'active'
           WHERE mu.meter_id = m.id
             AND NOT EXISTS (
               SELECT 1 FROM lease_utility_responsibilities lur
                WHERE lur.lease_id = lz.id AND lur.utility_type = m.utility_type
                  AND lur.tenant_responsible)
        ) AS units_not_billing,
        -- S609 (Nic): has this meter actually MEASURED or BILLED anything yet?
        -- Until it has, every setting on it can still be corrected — including
        -- the utility and billing method. The edit form reads this to decide
        -- what to offer; PATCH enforces the same rule server-side.
        -- Unit assignments deliberately do NOT count: they are configuration,
        -- and a landlord fixing a wrong setup should keep them.
        (EXISTS (SELECT 1 FROM utility_meter_readings WHERE meter_id = m.id)
         OR EXISTS (SELECT 1 FROM utility_bills WHERE meter_id = m.id)) AS has_history
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
      rubsAllocationMethod: z.enum(rubsMethodEnum as unknown as [string, ...string[]]).nullable().optional(),
      // S607: how a RUBS master prices its pool — usage × rate (default), or
      // divide the provider's actual dollar bill. Landlord's choice per master.
      rubsBasis: z.enum(RUBS_BASES as unknown as [string, ...string[]]).optional(),
      rubsSubmeterRate: z.enum(RUBS_SUBMETER_RATES as unknown as [string, ...string[]]).optional(),
      rubsExclusionMode: z.enum(RUBS_EXCLUSION_MODES as unknown as [string, ...string[]]).optional(),
      // S607: config for the allocation bases that need one (unit_type_weight,
      // hybrid). Shape differs per basis — see the column
      // comment on utility_meters.rubs_weights.
      rubsWeights: z.record(z.any()).nullable().optional(),
      // Odometer width — how many digits the physical meter face has.
      digits:         z.number().int().refine(
        d => (METER_READING_DIGIT_OPTIONS as readonly number[]).includes(d),
        `digits must be one of ${METER_READING_DIGIT_OPTIONS.join(', ')}`,
      ).default(METER_READING_DEFAULT_DIGITS),
      // S613 (Nic): what ONE turn of the last digit on the FACE is worth. A
      // water register that counts per hundred gallons is 100 — 413 on the dial
      // is 41,300 gallons. Reads stay the face; only usage multiplies.
      readingMultiplier: z.number().positive().max(100000).optional(),
      // Sewer rides the water meter (S533) — same reading bills sewer
      // at this rate. Water meters only; there is no sewer meter.
      sewerRatePerUnit: z.number().nonnegative().nullable().optional(),
      // S605 (Nic): the OPENING READ. A submeter's first cycle produces no bill
      // — there is nothing to subtract from — and the engine says so only in a
      // preview the landlord may never open. A landlord onboarding mid-month who
      // enters just the end-of-month read gets NO bill and NO warning, and by
      // the time that is visible the cycle has closed. Capturing the baseline
      // WITH the meter is the only point where it is obvious what it's for.
      // Optional here (a meter can be created before anyone walks the property)
      // but its absence is surfaced loudly — see hasBaseline on GET /meters.
      baselineReading:  z.number().nonnegative().nullable().optional(),
      baselineDate:     z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
      // S605 (Nic hit this): creating a meter and assigning it to a unit were
      // two separate client calls, so when the assignment was refused the meter
      // had ALREADY been created and stayed behind. Three attempts left three
      // orphaned meters on Oak Park with no unit and no way to notice them.
      // Passing the unit here makes it one transaction: either both happen or
      // neither does.
      assignUnitId:     z.string().uuid().nullable().optional(),
    }).parse(req.body)
    if (body.baselineReading != null && !body.baselineDate) {
      throw new AppError(400, 'An opening read needs the date it was taken')
    }
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

    // S605: the double-billing guard is checked BEFORE the meter exists, so a
    // refused assignment can no longer leave a half-created meter behind.
    if (body.assignUnitId) {
      const unit = await queryOne<any>(
        `SELECT id FROM units WHERE id = $1 AND landlord_id = $2`,
        [body.assignUnitId, property.landlord_id])
      if (!unit) throw new AppError(404, 'Unit not found under this landlord')
      const clash = await queryOne<{ label: string }>(
        `SELECT m.label FROM utility_meter_units mu
           JOIN utility_meters m ON m.id = mu.meter_id
          WHERE mu.unit_id = $1 AND m.utility_type = $2
            AND (m.billing_method = 'submeter') = ($3 = 'submeter')
          LIMIT 1`,
        [body.assignUnitId, body.utilityType, body.billingMethod])
      if (clash) {
        throw new AppError(400,
          `This unit is already on "${clash.label}" for ${body.utilityType}. ` +
          `A unit can only be on one ${body.billingMethod === 'submeter' ? 'submeter' : 'master meter'} ` +
          `per utility, or it would be billed twice.`)
      }
    }

    const client = await getClient()
    let meter: any
    try {
      await client.query('BEGIN')
      const created = await client.query<any>(`
        INSERT INTO utility_meters
          (property_id, utility_type, label, billing_method, rate_per_unit,
           base_fee, rubs_allocation_method, digits, sewer_rate_per_unit, rubs_basis,
           rubs_submeter_rate, rubs_exclusion_mode, rubs_weights, reading_multiplier)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
        [body.propertyId, body.utilityType, body.label, body.billingMethod,
         body.ratePerUnit ?? null, body.baseFee,
         body.rubsAllocationMethod ?? null,
         // S613 (Nic): "There needs to be no digits at all ever selectable on
         // trash, because that's not a thing." Nothing is read on trash or on a
         // flat rate, so the width is NULL rather than a default nobody meant.
         (body.utilityType === 'trash' || body.billingMethod === 'flat_rate') ? null : body.digits,
         body.sewerRatePerUnit ?? null,
         body.rubsBasis ?? 'usage_rate',
         body.rubsSubmeterRate ?? 'property_rate',
         body.rubsExclusionMode ?? 'usage',
         body.rubsWeights ? JSON.stringify(body.rubsWeights) : null,
         // S613: what one turn of the last digit is worth. 1 unless the face
         // counts in hundreds (a per-hundred-gallon water register).
         body.readingMultiplier ?? 1])
      meter = created.rows[0]

      // Stamped as reason 'baseline' rather than 'monthly_cycle': it is the
      // starting odometer, not a cycle read, and must never be mistaken for one
      // by the cycle-usage query. billing_cycle_month is the month it was taken.
      if (body.baselineReading != null && body.baselineDate) {
        await client.query(`
          INSERT INTO utility_meter_readings
            (meter_id, reading_date, reading_value, billing_cycle_month, reason, created_by_user_id)
          VALUES ($1,$2,$3,$4,'baseline',$5)`,
          [meter.id, body.baselineDate, body.baselineReading,
           body.baselineDate.slice(0, 7) + '-01', req.user!.userId])
      }
      if (body.assignUnitId) {
        await client.query(
          `INSERT INTO utility_meter_units (meter_id, unit_id) VALUES ($1,$2)
           ON CONFLICT DO NOTHING`, [meter.id, body.assignUnitId])
      }
      await client.query('COMMIT')
    } catch (e) {
      await client.query('ROLLBACK'); throw e
    } finally { client.release() }

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
      // S609 (Nic, DIRECTIVE): "Every feature needs to be editable on meters
      // when there is no history. Only lock it once there's history, not once
      // it's created. Somebody accidentally setting something up the wrong way
      // needs to be able to change it so they don't have to redo potentially
      // everything. That's gonna be a friction point during onboarding."
      //
      // So these two — which decide how a reading is interpreted and how a bill
      // is calculated — are editable right up until the meter has actually
      // measured or billed something. After that they are frozen, because
      // changing them would silently re-interpret readings already taken and
      // bills already sent rather than correct anything.
      utilityType:    z.enum(utilityTypeEnum).optional(),
      billingMethod:  z.enum(billingMethodEnum).optional(),
      ratePerUnit:    z.number().nonnegative().nullable().optional(),
      baseFee:        z.number().nonnegative().optional(),
      rubsAllocationMethod: z.enum(rubsMethodEnum as unknown as [string, ...string[]]).nullable().optional(),
      rubsBasis: z.enum(RUBS_BASES as unknown as [string, ...string[]]).optional(),
      rubsSubmeterRate: z.enum(RUBS_SUBMETER_RATES as unknown as [string, ...string[]]).optional(),
      rubsExclusionMode: z.enum(RUBS_EXCLUSION_MODES as unknown as [string, ...string[]]).optional(),
      rubsWeights: z.record(z.any()).nullable().optional(),
      digits:         z.number().int().refine(
        d => (METER_READING_DIGIT_OPTIONS as readonly number[]).includes(d),
        `digits must be one of ${METER_READING_DIGIT_OPTIONS.join(', ')}`,
      ).optional(),
      // S613 (Nic): what ONE turn of the last digit is worth. A water face that
      // counts per hundred gallons is 100. Reads stay the face; usage multiplies.
      readingMultiplier: z.number().positive().max(100000).optional(),
      sewerRatePerUnit: z.number().nonnegative().nullable().optional(),
      // S559: mark a meter broken/repaired. Broken meters bill the lowest
      // comparable usage and are never flagged for reread. Stamps the "since"
      // date going in, clears it on repair.
      outOfService:   z.boolean().optional(),
    }).parse(req.body)
    // What a meter has actually DONE. Unit and lease assignments are config, not
    // history — they deliberately survive an edit, which is the whole point:
    // fixing a wrong setup must not mean redoing the assignments too.
    const structural = body.utilityType !== undefined || body.billingMethod !== undefined
    const history = await queryOne<{ readings: string; bills: string }>(
      `SELECT (SELECT COUNT(*) FROM utility_meter_readings WHERE meter_id = $1)::text AS readings,
              (SELECT COUNT(*) FROM utility_bills          WHERE meter_id = $1)::text AS bills`,
      [req.params.id])
    const hasHistory = Number(history?.readings ?? 0) > 0 || Number(history?.bills ?? 0) > 0
    if (structural && hasHistory) {
      throw new AppError(409,
        Number(history?.bills ?? 0) > 0
          ? 'This meter has already billed a tenant, so its utility and billing method are fixed — changing them now would re-interpret bills that have already gone out. Add the meter you meant and retire this one.'
          : 'This meter already has readings recorded, so its utility and billing method are fixed — changing them now would re-interpret readings already taken. Add the meter you meant and retire this one.')
    }

    // The values AFTER this edit, so every rule below is checked against what
    // the meter is about to become rather than what it used to be.
    const nextUtility = body.utilityType ?? meter.utility_type
    const nextMethod  = body.billingMethod ?? meter.billing_method
    const nextAlloc   = body.rubsAllocationMethod !== undefined
      ? body.rubsAllocationMethod
      : meter.rubs_allocation_method

    // utility_meters_check: a RUBS master must carry an allocation method, and
    // anything else must not. Switching method without fixing the allocation
    // would hit the constraint as a raw database error, so it is caught here in
    // words the landlord can act on.
    if (nextMethod === 'rubs' && !nextAlloc) {
      throw new AppError(400, 'A RUBS master needs a split method — choose how the bill is divided.')
    }
    if (nextMethod !== 'rubs' && nextAlloc) {
      throw new AppError(400, 'A split method only applies to a RUBS master.')
    }

    // Sewer rides the water reading; there is no sewer meter. Checked against
    // the utility this meter is BECOMING, and a stored rate that no longer
    // applies is cleared rather than left behind to bill from.
    const nextSewer = body.sewerRatePerUnit !== undefined
      ? body.sewerRatePerUnit
      : (meter.sewer_rate_per_unit != null ? Number(meter.sewer_rate_per_unit) : null)
    if (nextSewer != null && nextUtility !== 'water') {
      if (body.sewerRatePerUnit != null) {
        throw new AppError(400, 'Sewer rate only applies to water meters — sewer bills off the water reading')
      }
      // Switching a water meter to another utility: drop the now-meaningless
      // sewer rate instead of leaving it to be billed from later.
      body.sewerRatePerUnit = null
    }
    // S558: metered exclusion is UNIT-DRIVEN — a submeter is excluded from a
    // RUBS pool simply by sharing a served unit with the master. No manual
    // meter-to-meter link (the rubs_parent_meter_id column was removed).

    // Shrinking the width below an existing reading would corrupt the
    // rollover math (a stored 45210 can't live on a 4-digit meter).
    // S613: a width can't be set on something with no dial. Refused out loud —
    // an ignored setting is how a landlord ends up believing a number that
    // isn't true of his property.
    if (body.digits != null && (nextUtility === 'trash' || nextMethod === 'flat_rate')) {
      throw new AppError(400,
        nextUtility === 'trash'
          ? 'Trash has no meter to read — it is a flat charge per household, or the hauler’s bill split across the units on it. There is no odometer size to set.'
          : 'A flat charge has no reading, so it has no odometer size.')
    }
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
        utility_type = COALESCE($16, utility_type),
        billing_method = COALESCE($17, billing_method),
        label = COALESCE($1, label),
        rate_per_unit = COALESCE($2, rate_per_unit),
        base_fee = COALESCE($3, base_fee),
        rubs_allocation_method = CASE WHEN $4::text = '__keep__' THEN rubs_allocation_method ELSE $5 END,
        -- S613: a meter that BECOMES trash or a flat rate loses its width (the
        -- constraint requires NULL there); one that stops being either needs a
        -- width again, so it falls back to the default rather than failing the
        -- save with a constraint error the landlord can do nothing about.
        reading_multiplier = COALESCE($20, reading_multiplier),
        digits = CASE
          WHEN $18::text = 'trash' OR $19::text = 'flat_rate' THEN NULL
          ELSE COALESCE($6, digits, 6)
        END,
        sewer_rate_per_unit = CASE WHEN $7::text = '__keep__' THEN sewer_rate_per_unit ELSE $8::numeric END,
        rubs_basis = COALESCE($11, rubs_basis),
        rubs_submeter_rate = COALESCE($12, rubs_submeter_rate),
        rubs_exclusion_mode = COALESCE($13, rubs_exclusion_mode),
        rubs_weights = CASE WHEN $14::text = '__keep__' THEN rubs_weights ELSE $15::jsonb END,
        out_of_service = COALESCE($10, out_of_service),
        out_of_service_since = CASE
          WHEN $10::boolean IS TRUE  THEN COALESCE(out_of_service_since, CURRENT_DATE)
          WHEN $10::boolean IS FALSE THEN NULL
          ELSE out_of_service_since END,
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
        body.outOfService ?? null,
        body.rubsBasis ?? null,
        body.rubsSubmeterRate ?? null,
        body.rubsExclusionMode ?? null,
        body.rubsWeights === undefined ? '__keep__' : 'set',
        body.rubsWeights === undefined ? null : (body.rubsWeights ? JSON.stringify(body.rubsWeights) : null),
        body.utilityType ?? null,
        body.billingMethod ?? null,
        // $18/$19: what the meter is BECOMING, for the digits rule above.
        nextUtility,
        nextMethod,
        body.readingMultiplier ?? null,
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
    // Retention guard (data-retention rule — reading history is permanent).
    // The utility_meter_readings FK is ON DELETE CASCADE, so hard-deleting a
    // meter would silently WIPE its whole reading history (point-in-time reads,
    // turnover comparisons, leak checks). Block that: a meter that has ever been
    // read is retired via `out_of_service`, never deleted. Only a mis-created
    // meter with zero readings may be hard-deleted.
    const readCount = await queryOne<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM utility_meter_readings WHERE meter_id = $1`, [req.params.id])
    if (Number(readCount?.n ?? 0) > 0) {
      throw new AppError(409, 'This meter has recorded readings and cannot be deleted — its reading history is kept permanently. Mark it out of service instead.')
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
/**
 * Assign one or MANY units to a meter.
 *
 * S609 (Nic): "Every time I click add a unit and then click the unit from that
 * drop down, it takes a second to load, and then it moves my button over, and it
 * puts it at the end of the list. So I have to keep moving the mouse to the new
 * button spot to click and add the next submeter. I want to have it where it
 * opens a little window, and I just can checkbox all the units that get applied
 * to that master meter."
 *
 * Oak Park's water master serves 27 units. One-at-a-time meant 27 round trips
 * with the target moving after every one.
 *
 * `unitIds` takes the whole selection. Each unit is judged on its own and the
 * response says what happened to each: a unit that clashes with another meter is
 * SKIPPED with the reason, and the rest still go on. All-or-nothing would be
 * worse here — one bad unit would silently discard a selection of twenty-six.
 *
 * `unitId` (singular) still works so nothing that already calls this breaks.
 */
utilityRouter.post('/meters/:id/units', requirePerm('properties.edit'), async (req, res, next) => {
  try {
    const body = z.object({
      unitId:  z.string().uuid().optional(),
      unitIds: z.array(z.string().uuid()).min(1).max(500).optional(),
    }).refine(b => b.unitId || b.unitIds, 'unitId or unitIds is required')
      .parse(req.body)
    const requested = body.unitIds ?? [body.unitId!]
    const meter = await queryOne<any>(
      `SELECT m.*, p.landlord_id FROM utility_meters m
         JOIN properties p ON p.id = m.property_id
        WHERE m.id = $1`, [req.params.id])
    if (!meter) throw new AppError(404, 'Meter not found')
    if (!canAccessLandlordResource(req.user, meter.landlord_id)) {
      throw new AppError(403, 'Forbidden')
    }
    // A submeter measures exactly ONE unit, so a multi-select against one is a
    // mistake worth naming rather than half-applying.
    if (meter.billing_method === 'submeter' && requested.length > 1) {
      throw new AppError(400, 'A submeter measures a single unit. Pick one, or use a RUBS master to serve several.')
    }

    const added: string[] = []
    // `status` is carried so a single-unit call can rethrow with the code it
    // always used — 404 for "no such unit of yours", 400 for a rule refusing it.
    // The multi-unit response drops it; the caller only needs the reason.
    const skipped: { unitId: string; reason: string; status: number }[] = []

    for (const unitId of requested) {
    const unit = await queryOne<any>(
      `SELECT id FROM units WHERE id = $1 AND landlord_id = $2`,
      [unitId, meter.landlord_id])
    if (!unit) { skipped.push({ unitId, reason: 'Unit not found under this landlord', status: 404 }); continue }

    // S558: a submeter measures exactly ONE unit (its reading IS that unit's
    // usage). Multiple units only make sense for a RUBS master (the group that
    // splits the pool) or a flat-rate meter. Refuse a second unit on a submeter.
    if (meter.billing_method === 'submeter') {
      const existing = await queryOne<{ n: string }>(
        `SELECT COUNT(*)::text AS n FROM utility_meter_units WHERE meter_id = $1 AND unit_id <> $2`,
        [req.params.id, unitId])
      if (Number(existing?.n || 0) >= 1) {
        skipped.push({ unitId, status: 400, reason: 'A submeter measures a single unit. Remove the current unit first, or use a RUBS master to serve multiple units.' })
        continue
      }
    }

    // S604 (Nic): DOUBLE-BILLING GUARD. Nothing previously stopped the same unit
    // being attached to two meters of the SAME utility — e.g. RV 01 on two water
    // RUBS masters — and billing iterates meters, so that unit would receive two
    // water charges every cycle with nothing to flag it.
    //
    // The ONE legitimate same-utility overlap is S558's metered exclusion: a unit
    // with its own submeter that is ALSO in a RUBS master's served group, so its
    // usage can be subtracted from the pool before the split (Oak Park's
    // submetered mobile homes on the shared water master). That pairs exactly one
    // submeter with exactly one non-submeter meter, so it stays allowed.
    const clash = await queryOne<{ label: string; billing_method: string }>(
      `SELECT m.label, m.billing_method
         FROM utility_meter_units mu
         JOIN utility_meters m ON m.id = mu.meter_id
        WHERE mu.unit_id = $1
          AND m.id <> $2
          AND m.utility_type = $3
          -- allow the submeter + master pairing, block a second meter of the
          -- same KIND (two masters, or two submeters)
          AND (m.billing_method = 'submeter') = ($4 = 'submeter')
        LIMIT 1`,
      [unitId, req.params.id, meter.utility_type, meter.billing_method])
    if (clash) {
      skipped.push({ unitId, status: 400, reason:
        `Already on "${clash.label}" for ${meter.utility_type} — a unit can only be on one ` +
        `${meter.billing_method === 'submeter' ? 'submeter' : 'master meter'} per utility, ` +
        `or it would be billed twice. Remove it there first.` })
      continue
    }

    await query(`
      INSERT INTO utility_meter_units (meter_id, unit_id) VALUES ($1, $2)
      ON CONFLICT DO NOTHING
    `, [req.params.id, unitId])
    added.push(unitId)
    }

    // A single-unit call keeps its original all-or-nothing contract: one unit
    // that could not be assigned is an error, not a silent skip.
    if (!body.unitIds && skipped.length > 0) {
      throw new AppError(skipped[0].status, skipped[0].reason)
    }
    res.status(201).json({
      success: true,
      data: { added, skipped: skipped.map(({ unitId, reason }) => ({ unitId, reason })) },
    })
  } catch (e) { next(e) }
})

// POST /api/utility/meters/:id/bill-back — S613 (Nic, DIRECTIVE): record, for
// every unit on this meter whose active lease is silent about this utility,
// that it is billed back to the tenant.
//
// "Trash or other stuff may be an addendum when billed back separately, as
//  things change. There needs to be able to be other charges that are not on
//  the lease."
//
// The per-unit door exists too; this is the one that matters when a park starts
// charging for something it never charged for, because doing it a unit at a time
// across twenty-seven spaces is how half of them get missed. A responsibility
// that came FROM a signed lease is never touched — this only fills silences.
utilityRouter.post('/meters/:id/bill-back', requirePerm('properties.edit'), async (req, res, next) => {
  try {
    const { note } = z.object({ note: z.string().trim().max(300).optional() }).parse(req.body ?? {})
    const meter = await queryOne<any>(
      `SELECT m.*, p.landlord_id FROM utility_meters m
         JOIN properties p ON p.id = m.property_id WHERE m.id = $1`, [req.params.id])
    if (!meter) throw new AppError(404, 'Meter not found')
    if (!canManageLandlordResource(req.user, meter.landlord_id)) throw new AppError(403, 'Forbidden')

    const rows = await query<{ lease_id: string }>(
      `INSERT INTO lease_utility_responsibilities
         (lease_id, utility_type, tenant_responsible, source, set_by_user_id, set_at, note)
       SELECT lz.id, $2, true, 'addendum', $3, NOW(), $4
         FROM utility_meter_units mu
         JOIN leases lz ON lz.unit_id = mu.unit_id AND lz.status = 'active'
        WHERE mu.meter_id = $1
       ON CONFLICT (lease_id, utility_type) DO UPDATE
         SET tenant_responsible = true, source = 'addendum',
             set_by_user_id = EXCLUDED.set_by_user_id, set_at = NOW(), note = EXCLUDED.note
         WHERE lease_utility_responsibilities.tenant_responsible = false
       RETURNING lease_id`,
      [req.params.id, meter.utility_type, req.user!.userId, note ?? null])
    res.json({ success: true, data: { leasesUpdated: rows.length } })
  } catch (e) { next(e) }
})

// PATCH /api/utility/meters/:id/units/:unitId — S613 (Nic): how many of this
// service the unit takes. "Say one household uses a lot of trash and they
// actually have a second can — is there a way to toggle can count times the
// property rate for their bill?"
//
// Quantity only, never price. The amount stays the property's, identical for
// everyone (S609 anti-discrimination); what differs is how many cans get
// emptied. Flat charges only: on a submeter or a RUBS master the usage already
// carries how much the unit used, and multiplying it would double-count.
utilityRouter.patch('/meters/:id/units/:unitId', requirePerm('properties.edit'), async (req, res, next) => {
  try {
    const { quantity } = z.object({ quantity: z.number().int().min(1).max(99) }).parse(req.body)
    const meter = await queryOne<any>(
      `SELECT m.*, p.landlord_id FROM utility_meters m
         JOIN properties p ON p.id = m.property_id WHERE m.id = $1`, [req.params.id])
    if (!meter) throw new AppError(404, 'Meter not found')
    if (!canManageLandlordResource(req.user, meter.landlord_id)) throw new AppError(403, 'Forbidden')
    if (meter.billing_method !== 'flat_rate') {
      throw new AppError(400,
        'A count only applies to a flat charge. On a meter, usage already reflects how much this unit used.')
    }
    const row = await queryOne<any>(
      `UPDATE utility_meter_units SET quantity = $3
        WHERE meter_id = $1 AND unit_id = $2 RETURNING *`,
      [req.params.id, req.params.unitId, quantity])
    if (!row) throw new AppError(404, 'That unit is not on this charge')
    res.json({ success: true, data: row })
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

// GET /api/utility/recovery?propertyId=&from=&to= — S613 (Nic).
//
// "Unbilled utility tracking would just be the difference between an owner
//  importing their total charges coming into the property and subtracting the
//  outgoing charges, and knowing the difference in dollar amounts... over a
//  whole year when there's fifty thousand dollars in utilities and there's
//  twelve thousand maybe not billed back to people, we wanna see that."
//
// Exactly that, and no new ledger for it: what the property SPENT is its utility
// expenses, what it RECOVERED is the bills it sent, and the gap is the answer.
// The one slice that can be named without guessing is the owner-occupied share,
// because that is recorded as it happens. Everything else in the gap — common
// areas, a nightly stay with power in the rate, a vacant space, a lease that
// doesn't pass it through — is reported together as "not recovered", because
// attributing it would mean inventing a number rather than reading one.
utilityRouter.get('/recovery', requirePerm('properties.edit', 'units.view_status'), async (req, res, next) => {
  try {
    const propertyId = z.string().uuid().parse(req.query.propertyId)
    const from = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).parse(req.query.from)
    const to   = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).parse(req.query.to)
    const property = await queryOne<any>(
      `SELECT id, landlord_id FROM properties WHERE id = $1`, [propertyId])
    if (!property) throw new AppError(404, 'Property not found')
    if (!canAccessLandlordResource(req.user, property.landlord_id)) throw new AppError(403, 'Forbidden')

    const rows = await query<any>(`
      WITH spent AS (
        SELECT COALESCE(e.utility_type, 'unspecified') AS utility_type,
               SUM(e.amount)::numeric AS amount
          FROM landlord_expenses e
         WHERE e.property_id = $1 AND e.category = 'utilities'
           AND e.status = 'active'
           AND e.expense_date BETWEEN $2::date AND $3::date
         GROUP BY 1
      ),
      recovered AS (
        SELECT ub.utility_type, SUM(ub.charge_amount)::numeric AS amount
          FROM utility_bills ub
          JOIN units u ON u.id = ub.unit_id
         WHERE u.property_id = $1
           AND ub.billing_cycle_month BETWEEN date_trunc('month', $2::date)::date
                                          AND date_trunc('month', $3::date)::date
         GROUP BY 1
      ),
      owner_use AS (
        SELECT a.utility_type, SUM(a.charge_amount)::numeric AS amount
          FROM utility_owner_use_absorptions a
          JOIN units u ON u.id = a.unit_id
         WHERE u.property_id = $1
           AND a.billing_cycle_month BETWEEN date_trunc('month', $2::date)::date
                                         AND date_trunc('month', $3::date)::date
         GROUP BY 1
      )
      SELECT t.utility_type,
             COALESCE(s.amount, 0)::float  AS spent,
             COALESCE(r.amount, 0)::float  AS recovered,
             COALESCE(o.amount, 0)::float  AS owner_occupied
        FROM (SELECT utility_type FROM spent
              UNION SELECT utility_type FROM recovered
              UNION SELECT utility_type FROM owner_use) t
        LEFT JOIN spent s     ON s.utility_type = t.utility_type
        LEFT JOIN recovered r ON r.utility_type = t.utility_type
        LEFT JOIN owner_use o ON o.utility_type = t.utility_type
       ORDER BY 2 DESC
    `, [propertyId, from, to])

    const lines = rows.map((r: any) => ({
      utilityType: r.utility_type,
      spent: Number(r.spent),
      recovered: Number(r.recovered),
      ownerOccupied: Number(r.owner_occupied),
      // Only meaningful where the landlord recorded what he SPENT. Without the
      // bill on the expense side there is nothing to subtract from, so this
      // reports null rather than implying the whole recovery was a shortfall.
      notRecovered: Number(r.spent) > 0
        ? Math.round((Number(r.spent) - Number(r.recovered)) * 100) / 100
        : null,
    }))
    const sum = (k: 'spent' | 'recovered' | 'ownerOccupied') =>
      Math.round(lines.reduce((n: number, l: any) => n + l[k], 0) * 100) / 100
    res.json({ success: true, data: {
      from, to, lines,
      totals: {
        spent: sum('spent'), recovered: sum('recovered'), ownerOccupied: sum('ownerOccupied'),
        notRecovered: Math.round((sum('spent') - sum('recovered')) * 100) / 100,
      },
    } })
  } catch (e) { next(e) }
})

// ── METER READINGS ───────────────────────────────────────────
// S560: LANDLORD-ONLY. Returns raw historical reading VALUES, so it must NOT
// be reachable by the blind front-desk reader (utility.read_meters) — same
// lockdown as /readings/flagged. Front desk enters reads blind via the run
// walk / special-read; it never needs the value history.
utilityRouter.get('/meters/:id/readings', requirePerm('properties.edit'), async (req, res, next) => {
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
      // S605 (Nic): this route is the BACKDATABLE one — it takes an explicit
      // reading date, which is what an opening read needs (Oak Park's baselines
      // have to be dated before the reads they enable). Only 'baseline' is
      // accepted from a caller; every other reason is stamped by the system from
      // the calendar, and letting a client claim 'monthly_cycle' here would let
      // it forge the billed read.
      reason:             z.literal('baseline').optional(),
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
        (meter_id, reading_date, reading_value, billing_cycle_month, reason, created_by_user_id)
      VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [req.params.id, body.readingDate, body.readingValue,
       body.billingCycleMonth, body.reason ?? 'monthly_cycle', req.user!.userId])
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
// PATCH /api/utility/meters/:id/readings/:readingId — S613 (Nic): fix a
// mistyped read.
//
//   "I just fat fingered an opening meter read. I need a way to edit it...
//    clicking to edit the actual thing only lets me choose the billing method
//    and the name of the spot."
//
// A read could be entered and never corrected, which is untenable for a number
// typed off a dial in a field — and it hit him on the very first walk.
//
// WHAT IT REFUSES: a read that something has already BILLED FROM. Usage is the
// difference between two reads, so moving one silently re-writes what a tenant
// was charged on an invoice already issued. Those need the reversal path, not a
// quiet edit. Every correction is audit-logged either way (the trigger added in
// 20260821140000), because what the number used to say is part of the story of
// the bill it produced.
utilityRouter.patch('/meters/:id/readings/:readingId', requirePerm('properties.edit'), async (req, res, next) => {
  try {
    const body = z.object({
      readingValue: z.number().nonnegative().optional(),
      readingDate:  z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      note:         z.string().trim().max(300).optional(),
    }).parse(req.body)
    if (body.readingValue == null && body.readingDate == null) {
      throw new AppError(400, 'Nothing to change — send a new value or a new date.')
    }

    const meter = await queryOne<any>(
      `SELECT m.*, p.landlord_id FROM utility_meters m
         JOIN properties p ON p.id = m.property_id WHERE m.id = $1`, [req.params.id])
    if (!meter) throw new AppError(404, 'Meter not found')
    if (!canManageLandlordResource(req.user, meter.landlord_id)) throw new AppError(403, 'Forbidden')

    const reading = await queryOne<any>(
      `SELECT * FROM utility_meter_readings WHERE id = $1 AND meter_id = $2`,
      [req.params.readingId, req.params.id])
    if (!reading) throw new AppError(404, 'Reading not found on this meter')

    if (body.readingValue != null && meter.digits != null
        && body.readingValue >= meterReadingModulus(meter.digits)) {
      throw new AppError(400,
        `That is more than a ${meter.digits}-digit meter can show. Check the odometer size on the meter if the face is wider.`)
    }

    // Anything billed from this read, or from the span that starts at it.
    const billed = await queryOne<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM utility_bills
        WHERE meter_id = $1 AND billing_cycle_month >= $2::date`,
      [req.params.id, reading.billing_cycle_month])
    if (Number(billed?.n ?? 0) > 0) {
      throw new AppError(409,
        'A bill has already been issued from this read, so changing it would rewrite a charge a tenant has already seen. ' +
        'Enter a correcting read instead, or reverse that bill first.')
    }

    const updated = await queryOne<any>(
      `UPDATE utility_meter_readings
          SET reading_value = COALESCE($3, reading_value),
              reading_date  = COALESCE($4::date, reading_date),
              review_note   = COALESCE($5, review_note)
        WHERE id = $1 AND meter_id = $2
        RETURNING *`,
      [req.params.readingId, req.params.id,
       body.readingValue ?? null, body.readingDate ?? null, body.note ?? null])
    res.json({ success: true, data: updated })
  } catch (e) { next(e) }
})

utilityRouter.get('/reading-runs', requirePerm('units.edit', 'units.view_status', 'properties.edit', 'utility.read_meters'), async (req, res, next) => {
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
                  AND rd.reason = 'monthly_cycle'
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
utilityRouter.post('/reading-runs', requirePerm('properties.edit', 'utility.read_meters'), async (req, res, next) => {
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
    await assertPropertyInScope(req.user, body.propertyId)  // S560: property-lock
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
utilityRouter.get('/reading-runs/:id/meters', requirePerm('units.edit', 'units.view_status', 'properties.edit', 'utility.read_meters'), async (req, res, next) => {
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
utilityRouter.post('/reading-runs/:id/meters/:meterId/reading', requirePerm('properties.edit', 'utility.read_meters'), async (req, res, next) => {
  try {
    // Reads are odometer values; the digit width is per-meter (landlord
    // setting). Bounds are checked against the meter's own capacity
    // after the meter row is fetched below.
    const body = z.object({
      readingValue: z.number().int().min(0),
      // S607: a RUBS master on the bill_amount basis also carries the utility
      // provider's dollar charge for the cycle. Ignored on every other meter.
      billAmount: z.number().min(0).max(10_000_000).optional(),
    }).parse(req.body)
    const run = await queryOne<any>(
      `SELECT * FROM utility_reading_runs WHERE id = $1`, [req.params.id])
    if (!run) throw new AppError(404, 'Reading run not found')
    if (!canAccessLandlordResource(req.user, run.landlord_id)) {
      throw new AppError(403, 'Forbidden')
    }
    await assertPropertyInScope(req.user, run.property_id)  // S560: property-lock
    if (run.status !== 'open') throw new AppError(409, 'Reading run is already completed')
    const meter = await queryOne<any>(
      `SELECT m.* FROM utility_meters m
        WHERE m.id = $1 AND m.property_id = $2`, [req.params.meterId, run.property_id])
    if (!meter) throw new AppError(404, 'Meter not found on this run')
    const modulus = meterReadingModulus(meter.digits)
    // S607: the digit cap is an ODOMETER bound — it describes the face of a
    // physical dial, and only a submeter has one. A RUBS master records a period
    // TOTAL off the utility's bill, which is bounded by how much the park used,
    // not by a dial width; a big park clears a 6-digit master's 999,999 in a
    // month. Capping it there would have made the total unenterable with no way
    // to tell why.
    if (meter.billing_method !== 'rubs' && body.readingValue >= modulus) {
      throw new AppError(400, `Reading exceeds this meter's ${meter.digits}-digit capacity`)
    }
    const isDollarMaster = meter.billing_method === 'rubs' && meter.rubs_basis === 'bill_amount'
    if (isDollarMaster && body.billAmount == null) {
      throw new AppError(400, 'This master bills from the utility bill total — enter the amount charged for this cycle')
    }

    // Below-previous handling (S533): rollover is AUTOMATIC — RV parks
    // roll meters constantly and a double-check per rollover wastes the
    // manager's time. wrap = (10^digits − prior) + current; a plausible
    // wrap (< half the meter's range) bills as a rollover with no
    // friction. A wrap ≥ half the range is almost certainly a typo or a
    // meter swap — NOT billed; silently flagged for the landlord
    // double-check (NO GIVEAWAYS to the reader either way: identical
    // 201, nothing in the response).
    // Point-in-time prior (S559): the most recent existing read for this
    // meter (by time), excluding this cycle's own monthly_cycle row on
    // re-entry. May be a mid-month turnover/reference read.
    const prior = await queryOne<{ reading_value: string }>(
      `SELECT reading_value FROM utility_meter_readings
        WHERE meter_id = $1
          AND NOT (billing_cycle_month = $2 AND reason = 'monthly_cycle')
        ORDER BY reading_date DESC, created_at DESC LIMIT 1`,
      [meter.id, run.billing_cycle_month])
    let isRollover = false
    let needsReview = false
    let reviewNote: string | null = null
    // Broken meter (S559): a meter marked out of service reads the same
    // (or garbage) every cycle and bills from comparable units, not from
    // its own usage. Accept the read as-is — never flag it for reread and
    // never let it hold the end-of-month billing flow. (It can still be
    // caught by the RANDOM reread padding; that's harmless.)
    // S607 (Nic): SUBMETERS ONLY. A RUBS master's entry is the cycle's USAGE
    // TOTAL off the utility's own bill — generateBillsForMeter bills
    // reading_value directly, with no prior subtracted — so there is no
    // odometer to wrap and "below the previous reading" carries no meaning.
    // Ungated, this flagged the master every time the park simply used less
    // water than the month before (any decrease produces a wrap ≥ half the
    // range), and invoiceGeneration's flagHold then held the WHOLE invoice,
    // rent included, for every unit that master feeds until a human cleared
    // it. Seasonal drops are normal; they must not hold the park's rent.
    if (!meter.out_of_service && meter.billing_method === 'submeter'
        && prior && body.readingValue < Number(prior.reading_value)) {
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
    if (!meter.out_of_service && !needsReview && meter.billing_method === 'submeter' && prior) {
      const threshold = METER_USAGE_ALERT_THRESHOLDS[meter.utility_type] ?? null
      const usage = isRollover
        ? (modulus - Number(prior.reading_value)) + body.readingValue
        : body.readingValue - Number(prior.reading_value)
      if (threshold != null && usage > threshold) {
        needsReview = true
        reviewNote = `Unusually high usage this cycle (${usage.toLocaleString()}) — double-check the meter`
      }
    }
    // Master typo guard (S607) — RUBS MASTERS ONLY, the mirror of the submeter
    // check above. A master total is the one reading with nothing behind it:
    // the blind verification walk builds its list from submeters, so a slipped
    // digit here is never re-read, and it prices every unit on the pool at
    // once. Compared against the master's OWN previous total rather than a
    // fixed threshold — park sizes differ by an order of magnitude, so no
    // single gallon figure fits them all.
    if (!meter.out_of_service && !needsReview && meter.billing_method === 'rubs' && prior) {
      const priorTotal = Number(prior.reading_value)
      if (priorTotal > 0 && body.readingValue > priorTotal * MASTER_TOTAL_JUMP_FACTOR) {
        needsReview = true
        reviewNote = `Usage total is ${(body.readingValue / priorTotal).toFixed(1)}× last cycle's `
          + `(${priorTotal.toLocaleString()} → ${body.readingValue.toLocaleString()}) — `
          + `check it against the utility bill`
      }
    }

    const reading = await queryOne<any>(
      `INSERT INTO utility_meter_readings
         (meter_id, reading_date, reading_value, billing_cycle_month, created_by_user_id,
          needs_review, review_note, is_rollover, reason, bill_amount)
       VALUES ($1, CURRENT_DATE, $2, $3, $4, $5, $6, $7, 'monthly_cycle', $8)
       ON CONFLICT (meter_id, billing_cycle_month) WHERE reason = 'monthly_cycle'
       DO UPDATE SET reading_value = EXCLUDED.reading_value,
                     reading_date = EXCLUDED.reading_date,
                     created_by_user_id = EXCLUDED.created_by_user_id,
                     needs_review = EXCLUDED.needs_review,
                     review_note = EXCLUDED.review_note,
                     is_rollover = EXCLUDED.is_rollover,
                     bill_amount = EXCLUDED.bill_amount
       RETURNING id, meter_id, billing_cycle_month`,
      [meter.id, body.readingValue, run.billing_cycle_month, req.user!.userId,
       needsReview, reviewNote, isRollover, isDollarMaster ? body.billAmount : null])

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
utilityRouter.get('/reading-runs/:id/double-checks', requirePerm('units.edit', 'units.view_status', 'properties.edit', 'utility.read_meters'), async (req, res, next) => {
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

utilityRouter.post('/reading-runs/:id/double-checks/:meterId', requirePerm('properties.edit', 'utility.read_meters'), async (req, res, next) => {
  try {
    const body = z.object({
      readingValue: z.number().int().min(0),
      // S607: a RUBS master on the bill_amount basis also carries the utility
      // provider's dollar charge for the cycle. Ignored on every other meter.
      billAmount: z.number().min(0).max(10_000_000).optional(),
    }).parse(req.body)
    const run = await queryOne<any>(
      `SELECT * FROM utility_reading_runs WHERE id = $1`, [req.params.id])
    if (!run) throw new AppError(404, 'Reading run not found')
    if (!canAccessLandlordResource(req.user, run.landlord_id)) {
      throw new AppError(403, 'Forbidden')
    }
    await assertPropertyInScope(req.user, run.property_id)  // S560: property-lock
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

// ── READS DUE (S559): live, calendar-derived front-desk to-do ─
// Departures on submetered spots with no post-departure read yet. Derived
// fresh each call so extensions / early checkouts / cancellations self-
// correct. Front desk (utility.read_meters) + landlord.
utilityRouter.get('/reads-due', requirePerm('properties.edit', 'utility.read_meters'), async (req, res, next) => {
  try {
    const propertyId = z.string().uuid().parse(req.query.propertyId)
    const property = await queryOne<{ landlord_id: string }>(
      `SELECT landlord_id FROM properties WHERE id = $1`, [propertyId])
    if (!property) throw new AppError(404, 'Property not found')
    if (!canAccessLandlordResource(req.user, property.landlord_id)) throw new AppError(403, 'Forbidden')
    await assertPropertyInScope(req.user, propertyId)  // S560: property-lock
    res.json({ success: true, data: await getReadsDue(propertyId) })
  } catch (e) { next(e) }
})

// ── SPECIAL / OFF-CYCLE READ (S559) ──────────────────────────
// A read taken OUTSIDE the monthly run — front desk at stay turnover /
// move-out (auto-reason from the to-do), a meter swap, or an ad-hoc
// reference read. Blind on the way out (never echoes values). The reason
// decides billing: move_out_final bills the departing responsible tenant
// (usage since the previous read); every other non-cycle reason is
// reference/baseline only (the point-in-time model makes it reset the
// baseline, keeping a departed guest's usage off the next arrival's bill).
// monthly_cycle is NOT allowed here — that read only comes from the run.
utilityRouter.post('/meters/:id/reads', requirePerm('properties.edit', 'utility.read_meters'), async (req, res, next) => {
  try {
    const body = z.object({
      readingValue: z.number().int().min(0),
      reason: z.enum(METER_READ_REASONS as unknown as [string, ...string[]]),
      reasonNote: z.string().max(500).optional(),
    }).parse(req.body)
    if (body.reason === 'monthly_cycle') {
      throw new AppError(400, 'Monthly-cycle reads are entered through the reading run, not as a special read')
    }
    const meter = await queryOne<any>(`SELECT * FROM utility_meters WHERE id = $1`, [req.params.id])
    if (!meter) throw new AppError(404, 'Meter not found')
    const property = await queryOne<{ landlord_id: string }>(
      `SELECT landlord_id FROM properties WHERE id = $1`, [meter.property_id])
    if (!property || !canAccessLandlordResource(req.user, property.landlord_id)) {
      throw new AppError(403, 'Forbidden')
    }
    await assertPropertyInScope(req.user, meter.property_id)  // S560: property-lock
    if (body.readingValue >= meterReadingModulus(meter.digits)) {
      throw new AppError(400, `Reading exceeds this meter's ${meter.digits}-digit capacity`)
    }
    // Reference/turnover reads are never flagged (needs_review defaults false)
    // — they're deliberate, and the reader must stay blind.
    const reading = await queryOne<any>(
      `INSERT INTO utility_meter_readings
         (meter_id, reading_date, reading_value, billing_cycle_month, created_by_user_id, reason, reason_note)
       VALUES ($1, CURRENT_DATE, $2, date_trunc('month', CURRENT_DATE)::date, $3, $4, $5)
       RETURNING id`,
      [meter.id, body.readingValue, req.user!.userId, body.reason, body.reasonNote ?? null])

    let billed = false
    if (body.reason === 'move_out_final') {
      const r = await billMoveOutRead(meter.id, reading.id)
      billed = r.billed
    }
    // Blind response — id + reason + whether it billed, never the values.
    res.status(201).json({ success: true, data: { id: reading.id, reason: body.reason, billed } })
  } catch (e) { next(e) }
})

// ── FLAGGED READINGS (double-check queue) ────────────────────
// Readings the walk silently flagged (below previous). The reviewer —
// unlike the reader — sees both values; that's the point of the check.
// S559: LANDLORD-ONLY. This is the one surface that shows entered + prior
// values side by side (the rollover-vs-swap money decision). Front desk
// (utility.read_meters) must NEVER see a prior/entered value — their walks
// are blind — so this endpoint is gated to properties.edit only, NOT the
// units.* read perms that gate the meter list.
utilityRouter.get('/readings/flagged', requirePerm('properties.edit'), async (req, res, next) => {
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
                 WHERE p.meter_id = r.meter_id
                   AND (p.reading_date, p.created_at) < (r.reading_date, r.created_at)
                 ORDER BY p.reading_date DESC, p.created_at DESC LIMIT 1
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

// ── S605 (Nic, DIRECTIVE): PROPERTY-LEVEL UTILITY RATES ─────────────────────
// "Make utility rates set at the property level. Adding each unit is redundant
// and possible discrimination."
//
// Pricing is policy, decided once per property per utility, not per tenant. The
// billing engine reads these and they override the meter columns — so two
// neighbours on the same water main cannot be charged different rates because
// of who entered their unit. Same posture as the S535 property-level late fees.
utilityRouter.get('/property-rates', requirePerm('units.edit', 'units.view_status', 'properties.edit'), async (req, res, next) => {
  try {
    const propertyId = String(req.query.propertyId || '')
    if (!propertyId) throw new AppError(400, 'propertyId is required')
    const property = await queryOne<any>(
      `SELECT id, landlord_id FROM properties WHERE id = $1`, [propertyId])
    if (!property) throw new AppError(404, 'Property not found')
    if (!canAccessLandlordResource(req.user, property.landlord_id)) throw new AppError(403, 'Forbidden')
    const rows = await query<any>(
      `SELECT utility_type, rate_per_unit, base_fee, sewer_rate_per_unit,
              prevailing_residential_rate, updated_at
         FROM property_utility_rates WHERE property_id = $1 ORDER BY utility_type`, [propertyId])
    res.json({ success: true, data: rows })
  } catch (e) { next(e) }
})

utilityRouter.post('/property-rates', requirePerm('properties.edit'), async (req, res, next) => {
  try {
    const body = z.object({
      propertyId:       z.string().uuid(),
      // S609: includes 'propane' — a per-gallon price set once for the property,
      // so recording gallons is enough to bill a fill correctly.
      utilityType:      z.enum(rateUtilityTypeEnum),
      ratePerUnit:      z.number().nonnegative().nullable().optional(),
      baseFee:          z.number().nonnegative().default(0),
      sewerRatePerUnit: z.number().nonnegative().nullable().optional(),
      // S607: optional CEILING on what a submetered tenant may be charged per
      // unit of usage — the serving utility's ordinary residential rate. Several
      // states cap a landlord reselling a utility at that rate; where it applies
      // and the landlord has recorded it, the charge is held to it and the
      // landlord absorbs the difference. Unset = no cap, so it never blocks.
      prevailingResidentialRate: z.number().nonnegative().nullable().optional(),
    }).parse(req.body)
    if (body.sewerRatePerUnit != null && body.utilityType !== 'water') {
      throw new AppError(400, 'Sewer rate only applies to water — sewer bills off the water reading')
    }
    const property = await queryOne<any>(
      `SELECT id, landlord_id FROM properties WHERE id = $1`, [body.propertyId])
    if (!property) throw new AppError(404, 'Property not found')
    if (!canManageLandlordResource(req.user, property.landlord_id)) throw new AppError(403, 'Forbidden')

    const row = await queryOne<any>(
      `INSERT INTO property_utility_rates
         (property_id, utility_type, rate_per_unit, base_fee, sewer_rate_per_unit,
          prevailing_residential_rate)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (property_id, utility_type)
       DO UPDATE SET rate_per_unit = EXCLUDED.rate_per_unit,
                     base_fee = EXCLUDED.base_fee,
                     sewer_rate_per_unit = EXCLUDED.sewer_rate_per_unit,
                     prevailing_residential_rate = EXCLUDED.prevailing_residential_rate,
                     updated_at = now()
       RETURNING *`,
      [body.propertyId, body.utilityType, body.ratePerUnit ?? null,
       body.baseFee, body.sewerRatePerUnit ?? null,
       body.prevailingResidentialRate ?? null])

    // S609 (Nic): TRASH IS NOT A METER. "It's not a master meter. It's a toggle
    // on or off for people that have it or don't. It's a flat rate."
    //
    // He is right, and asking him to "add a meter" for trash was an
    // implementation detail leaking into his workflow — there is nothing to
    // meter and nothing to read. Billing still needs a row to hang the per-unit
    // membership off, so setting the RATE creates it silently. The landlord's
    // whole interaction is: set the price here, toggle it on for the units that
    // have it.
    //
    // Only for utilities that are inherently unmetered. Water/gas/electric are
    // read from a meter someone installs, and creating one implicitly would
    // invent equipment that does not exist.
    //
    // The guard checks for ANY trash setup, not just a flat-rate one (Nic):
    // "Trash should also be billable through a RUBS system if that's how the
    // landlord wants to operate. You keep writing inside the lines to deal with
    // a specific type of property." Right — a landlord who splits one hauler
    // bill across units by occupancy is doing trash by RUBS, and auto-creating a
    // flat-rate meter underneath them would give them TWO trash meters and trip
    // the double-billing guard. Setting a price only creates the simple case
    // when nothing else is set up; it never overrides a choice already made.
    if (body.utilityType === 'trash' && (body.ratePerUnit ?? 0) > 0) {
      await query(
        `INSERT INTO utility_meters (property_id, utility_type, label, billing_method, base_fee)
         SELECT $1, 'trash', 'Trash', 'flat_rate', 0
          WHERE NOT EXISTS (
            SELECT 1 FROM utility_meters
             WHERE property_id = $1 AND utility_type = 'trash')`,
        [body.propertyId])
    }

    // Changing policy must not rewrite bills already issued — utility_bills
    // snapshots the rate each bill was charged at. This only affects what is
    // generated from here on.
    res.status(201).json({ success: true, data: row })
  } catch (e) { next(e) }
})
