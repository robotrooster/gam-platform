import { Router } from 'express'
// 10/12 (Nic, ledger P6, L5): which expenses count as a cost, and a repair's cost once (lib/liveExpense).
import { liveExpenseSql, maintenanceCostNotBilledSql } from '../lib/liveExpense'
// 10/12 (Nic, ledger P8): the recovery report's spend reads the books once they are live.
import { ledgerReportsLive } from '../services/ledgerReports'
import { z } from 'zod'
import path from 'path'
import fs from 'fs'
import crypto from 'crypto'
import multer from 'multer'
import { streamStoredFile } from '../lib/fileServe'
import { meterReadingModulus, METER_READING_DIGIT_OPTIONS, METER_READING_DEFAULT_DIGITS, METER_USAGE_ALERT_THRESHOLDS, MASTER_TOTAL_JUMP_FACTOR, METER_READ_REASONS, RUBS_ALLOCATION_METHODS, RUBS_BASES, RUBS_SUBMETER_RATES, RUBS_EXCLUSION_MODES, meterWorksNoUseLabel } from '@gam/shared'
import { query, queryOne, getClient } from '../db'
import { requireAuth, requirePerm, assertPropertyInScope, getScopedPropertyIds, userHasPerm } from '../middleware/auth'
import { AppError } from '../middleware/errorHandler'
import { releaseSuspendedChargesForLease } from '../services/utilityBilling'
// 10/20 (Nic): the departure side of the recovery report. washPairing is the
// ONE place a departure's money kept and power absorbed are put beside each
// other; the report reads it rather than re-deriving either half.
import { washPairing } from '../services/earlyDepartureWash'
import { markMeterRepaired, markMeterWorksNoUse, flaggedPeriodEstimates, flaggedPeriodStart, voidFlaggedPeriodEstimates, ZERO_USE_CLEARED_SET } from '../services/meterRepair'
import { logger } from '../lib/logger'
import { canAccessLandlordResource, canManageLandlordResource } from '../middleware/scope'
import { landlordScopeIds } from '../lib/landlordScope'
import { traderHasFieldPermission } from '../services/workTradeJobs'

// S652 (Nic): "Curtis needs to be able to do and initiate the meter reading."
// A work trader whose landlord ticked Read meters on their agreement takes the
// same walk the front desk does — at their own property only. Staff pass the
// way they always did (their permission, then their property scope).
const METER_READ_PERMS = ['units.edit', 'units.view_status', 'properties.edit', 'utility.read_meters']
function requireMeterReader(req: any, res: any, next: any) {
  const u = req.user
  if (!u) return res.status(401).json({ success: false, error: 'Unauthenticated' })
  if (u.role === 'tenant') return next()   // the handler checks the agreement
  return requirePerm(...METER_READ_PERMS)(req, res, next)
}
async function assertMeterReadAccess(user: any, propertyId: string, landlordId: string) {
  if (user?.role === 'tenant') {
    if (!(await traderHasFieldPermission(user.userId, propertyId, 'read_meters'))) {
      throw new AppError(403, 'Reading meters is not part of your work trade agreement')
    }
    return
  }
  if (!canAccessLandlordResource(user, landlordId)) throw new AppError(403, 'Forbidden')
  await assertPropertyInScope(user, propertyId)  // S560: property-lock
}
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
  finishReadingPhase,
  settleFlaggedOnRun,
  countFlaggedOnRun,
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
      // S652: a bill the landlord has not issued yet — computed early for their
      // review — is not the tenant's to see until it goes out.
      where = `WHERE ub.tenant_id = $${params.push(req.user!.profileId)}
                 AND (ub.status <> 'unbilled' OR ub.payment_id IS NOT NULL)`
    } else if (role === 'landlord') {
      // S652: a landlord's session names no company (S633) — this read
      // profileId and so returned nothing for every landlord.
      where = `WHERE ub.landlord_id = ANY($${params.push(landlordScopeIds(req.user!))}::uuid[])`
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
      // S632 (Nic): "There's no opening read request anywhere." There couldn't
      // be. This check scoped to profileId — the ONE entity the session happens
      // to be signed into — so a landlord who owns two LLCs got a 404 on the
      // other one's meters. Nic's session sits on Oak Park; every meter call for
      // Mountain View failed, the meter list came back empty, and every warning
      // computed from it (opening reads, unread meters, the reading-run banner)
      // silently evaluated to zero. Nothing was broken on those screens — they
      // were rendering an empty list truthfully.
      //
      // canAccessLandlordResource is the platform's actual rule: it consults
      // landlordIds, every entity the user owns, which is what the S553
      // multi-entity model has meant everywhere else since. This route predates
      // that and never got converted. The S396 cross-tenant protection it was
      // written for is fully preserved — a landlord still cannot read another
      // landlord's meters, they just stop being locked out of their own.
      const prop = await queryOne<{ id: string; landlord_id: string }>(
        `SELECT id, landlord_id FROM properties WHERE id = $1`, [req.query.propertyId])
      if (!prop || !canAccessLandlordResource(req.user, prop.landlord_id)) {
        throw new AppError(404, 'Property not found')
      }
      where = `WHERE m.property_id = $${params.push(req.query.propertyId)}`
    } else if (req.user!.role === 'landlord') {
      // S632: every entity this landlord owns, not only the active one.
      const owned = (req.user!.landlordIds?.length ? req.user!.landlordIds : [req.user!.profileId])
        .filter(Boolean)
      where = `WHERE p.landlord_id = ANY($${params.push(owned)}::uuid[])`
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
        -- S648: whether a broken meter here bills an estimate (Mountain View's
        -- stopgap) or nothing — only so the page describes it truthfully.
        p.estimates_stuck_meters,
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
        -- S613 (Nic): units on this meter that genuinely bill NOTHING, so a
        -- landlord who has just ticked twenty-seven units onto a new trash
        -- charge is told how many will actually produce a charge.
        --
        -- S634 — THIS ASKED THE WRONG QUESTION AND CRIED WOLF.
        --
        -- It flagged any unit whose lease had no ROW for the utility. But an
        -- absent lease clause is SILENCE, not "the landlord pays" — the standing
        -- directive is that the meter/unit setup decides who pays, and the
        -- billing engine has always read it that way (tenantOwesUtility: the
        -- lease only governs when it actually says something; otherwise the
        -- meter's billing_method does).
        --
        -- So the warning and the engine disagreed, and the warning was the one
        -- that was wrong. Nic hit it on RV 02 and RV 03 the day their leases were
        -- signed: RV 02 had no utility rows at all and RV 03 none for trash, both
        -- were billing correctly off submeter/RUBS/flat-rate meters, and the page
        -- told him they billed nothing. The "Bill it back" button then offered to
        -- fix a problem that did not exist — and said it would start on the next
        -- invoice, which is what made it look like the money was being lost.
        --
        -- Same rule as the engine now: a unit bills nothing only when the lease
        -- EXPLICITLY says the tenant is not responsible, or the meter bills the
        -- landlord outright.
        ARRAY(
          SELECT mu.unit_id FROM utility_meter_units mu
            JOIN leases lz ON lz.unit_id = mu.unit_id AND lz.status = 'active'
           WHERE mu.meter_id = m.id
             AND (
               m.billing_method = 'master_bill_to_landlord'
               OR EXISTS (
                 SELECT 1 FROM lease_utility_responsibilities lur
                  WHERE lur.lease_id = lz.id AND lur.utility_type = m.utility_type
                    AND lur.tenant_responsible = false)
             )
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
    // 10/3: blind entry (S559). Someone who cannot change meter setup never gets
    // a reading value back — the opening read keeps its id and date, not its
    // number. A staffer who only reads meters (no unit access) gets no prices
    // either; they need the meter, not what it bills at.
    if (userHasPerm(req.user, 'properties.edit', 'units.edit')) return res.json({ success: true, data: meters })
    const seesPrices = userHasPerm(req.user, 'units.view_status')
    res.json({ success: true, data: meters.map((m: any) => {
      const { opening_read, rate_per_unit, base_fee, sewer_rate_per_unit, rubs_weights, ...rest } = m
      return {
        ...rest,
        opening_read: opening_read ? { id: opening_read.id, date: opening_read.date } : null,
        ...(seesPrices ? { rate_per_unit, base_fee, sewer_rate_per_unit, rubs_weights } : {}),
      }
    }) })
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
    // 10/12 (review): held to the properties a team member is scoped to (see PATCH /meters/:id).
    await assertPropertyInScope(req.user, property.id)

    // S605: the double-billing guard is checked BEFORE the meter exists, so a
    // refused assignment can no longer leave a half-created meter behind.
    if (body.assignUnitId) {
      const unit = await queryOne<any>(
        `SELECT id FROM units WHERE id = $1 AND landlord_id = $2`,
        [body.assignUnitId, property.landlord_id])
      if (!unit) throw new AppError(404, 'Unit not found under this landlord')
      // S634 (Nic, DIRECTIVE): ONE meter per unit per utility — not one of each
      // KIND. "The same unit cannot have two meter types for the same utility.
      // It can't be part of one RUBS system and one submeter system." Separate
      // utilities are unaffected: water on a submeter and electric on a master
      // is normal. The DB trigger added in the S634 migration is the real
      // enforcement; this is the readable error.
      const clash = await queryOne<{ label: string }>(
        `SELECT m.label FROM utility_meter_units mu
           JOIN utility_meters m ON m.id = mu.meter_id
          WHERE mu.unit_id = $1 AND m.utility_type = $2
          LIMIT 1`,
        [body.assignUnitId, body.utilityType])
      if (clash) {
        throw new AppError(400,
          `This unit is already on "${clash.label}" for ${body.utilityType}. ` +
          `A unit can only be on one ${body.utilityType} meter — remove it from that one first.`)
      }

      // ── 10/3 (final sweep): AN OCCUPIED UNIT'S OWN METER NEEDS ITS OPENING READ ──
      //
      // Oak Park RV 24 was moved onto a new water submeter on 9/30 with no
      // starting read. A submeter's first cycle read is only a starting point
      // (services/utilityBilling: "no prior reading — first cycle baseline, no
      // bill produced"), so the first month on the new meter would bill no water
      // at all for a space somebody lives in, and nothing would say so until the
      // bill went out without it. On an empty space the first read is the right
      // starting point; on an occupied one the number on the face today is
      // required with the meter. Occupied = the same test the stuck-meter rule
      // uses: not vacant or available, or an active lease, or residents invited.
      if (body.billingMethod === 'submeter' && body.baselineReading == null) {
        const occ = await queryOne<{ unit_number: string; occupied: boolean }>(
          `SELECT u.unit_number,
                  (u.status NOT IN ('vacant', 'available')
                   OR EXISTS (SELECT 1 FROM leases l
                               WHERE l.unit_id = u.id AND l.status IN ('active', 'delinquent', 'suspended'))
                   OR EXISTS (SELECT 1 FROM pending_tenant_intents pti
                               WHERE pti.unit_id = u.id AND pti.resolved_at IS NULL AND pti.cancelled_at IS NULL)
                  ) AS occupied
             FROM units u WHERE u.id = $1`,
          [body.assignUnitId])
        if (occ?.occupied) {
          // utilityType is a plain word (water, electric, gas...) — said as-is,
          // like the clash message above.
          throw new AppError(400,
            `Someone lives in ${occ.unit_number}, so its new ${body.utilityType} meter needs an opening read: ` +
            `the number on the meter face today and the date you read it. Without it, their first month on this ` +
            `meter would not bill. Nothing was added. To add it, open the Utilities page, choose "Add meter", ` +
            `fill in the opening read and the date you read it, then assign the meter to ${occ.unit_number}.`)
        }
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
      `SELECT m.*, p.landlord_id
         FROM utility_meters m
         JOIN properties p ON p.id = m.property_id
        WHERE m.id = $1`, [req.params.id])
    if (!meter) throw new AppError(404, 'Meter not found')
    if (!canAccessLandlordResource(req.user, meter.landlord_id)) {
      throw new AppError(403, 'Forbidden')
    }
    // 10/12 (review): a team member held to some properties edits only
    // those properties' meters, as every other meter write path already
    // required (reads-due, /meters/:id/reads, master bills). Without it, a
    // manager scoped to one park could re-rate, retire or confirm "uses no
    // power" (bills $0) on a meter at another park of the same company.
    await assertPropertyInScope(req.user, meter.property_id)

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
      // S648 (Nic): "for the meters marked broken and then marked as repaired,
      // they also need a new fresh meter read. If they bought a brand new
      // meter, the read's going to be zero. But if they bought a refurbished
      // one somewhere, it may have some number on it. And we need to set that
      // as the starting point for the next billing cycle."
      repairedStartingReading: z.number().nonnegative().optional(),
      // 10/12 (Nic), M1: "ADD 'Works, tenant uses no power' choice next to
      // 'Repaired' (Gerald specifically is gone, not plugged in, paying for
      // occupancy)." The meter works and the household on it uses nothing:
      // back in service with no new reading (nothing was replaced), and a flat
      // read bills $0 instead of being flagged until the meter moves
      // (services/meterRepair → markMeterWorksNoUse).
      // 10/12 (Nic): "usable on ANY meter, any time" — broken or not.
      // 10/12 (review): a boolean, not only `true`. The assistant passes every
      // parameter it was given, so a "mark it repaired" call carrying
      // zeroUseConfirmed: false was refused outright. Only true is the choice;
      // false (or leaving it out) means not this choice.
      zeroUseConfirmed: z.boolean().optional(),
      // 10/12 (Nic, review): take "Works, tenant uses no power" back. On a
      // master or a flat-rate meter nothing else could: "Mark broken" (which
      // also ends it) is offered on submeters only, and those meters never
      // reach the stuck-meter test that ends it on a submeter — a mis-click
      // stayed on the meter for good. Its own field, not zeroUseConfirmed:
      // false, which stays "not this choice" (the assistant sends every
      // parameter it was given, so false on a rename must change nothing).
      // Only true acts; on a meter with no confirmation it changes nothing.
      zeroUseWithdrawn: z.boolean().optional(),
      // 10/12 (Nic), Q-f: "past estimates when picking 'Works': LANDLORD'S
      // CHOICE at that moment (void unpaid estimated charges from the flagged
      // period, or leave them)." Asked in the same window: true voids them
      // (soft — kept on record), false or absent leaves them. Paid ones are
      // never touched (services/meterRepair voidFlaggedPeriodEstimates).
      voidFlaggedEstimates: z.boolean().optional(),
      // 10/12 (review): the estimated charges the window SHOWED (their ids,
      // from GET /meters/:id/flagged-estimates). Only those come off — one
      // written between the question and the answer is never voided unseen.
      voidEstimateIds: z.array(z.string().uuid()).max(1000).optional(),
      // 10/13 (Nic): "Flat-rate meter marked 'Works, nobody using it':
      // LANDLORD'S CHOICE, asked at the moment of marking ('Stop the flat
      // charge too?')." Sent with zeroUseConfirmed on a flat-rate meter, and
      // required there: true stops the flat charge while the meter is marked
      // unused (it starts again once it is not), false keeps it billing.
      stopFlatCharge: z.boolean().optional(),
    }).parse(req.body)
    // S648: marking a broken meter repaired REQUIRES what the new meter reads
    // now. Without it, the first bill after the repair would be measured from
    // the old meter's last number — a meaningless difference between two
    // different devices.
    const repairing = body.outOfService === false && meter.out_of_service === true
    const confirmingNoUse = body.zeroUseConfirmed === true
    if (confirmingNoUse && body.outOfService === true) {
      throw new AppError(400, 'A meter cannot be marked broken and confirmed working at the same time.')
    }
    const withdrawingNoUse = body.zeroUseWithdrawn === true
    if (withdrawingNoUse && confirmingNoUse) {
      throw new AppError(400, '"Works, tenant uses no power" cannot be chosen and taken back at the same time.')
    }
    const voidingEstimates = body.voidFlaggedEstimates === true
    if (voidingEstimates && !confirmingNoUse) {
      throw new AppError(400,
        'Estimated charges come off only with "Works, tenant uses no power" — the meter was working while it was flagged.')
    }
    // 10/12 (Nic), Q-f: the LANDLORD's choice. Voiding charges is a money
    // decision, and the assistant makes none (decisions #38 Q6): it can put
    // the meter back with "Works", and the landlord voids the estimates
    // themselves on the Utilities page.
    if (voidingEstimates && req.get('X-GAM-Actor') === 'agent') {
      throw new AppError(403,
        'Voiding the estimated charges is the landlord\'s own choice on the Utilities page — the assistant does not void charges.')
    }
    if (voidingEstimates && body.voidEstimateIds === undefined) {
      throw new AppError(400, 'Send the estimated charges the window showed (voidEstimateIds) — only those are taken off.')
    }
    // 10/13 (Nic): "Stop the flat charge too?" — a flat-rate meter's question,
    // asked when it is marked "Works, nobody using it", and only then.
    // (Only true acts, like zeroUseConfirmed: false, or leaving it out, changes nothing.)
    const flatRate = meter.billing_method === 'flat_rate'
    if (body.stopFlatCharge === true && !confirmingNoUse) {
      throw new AppError(400,
        `Stopping the flat charge is answered only with "${meterWorksNoUseLabel(meter.utility_type)}".`)
    }
    if (body.stopFlatCharge === true && !flatRate) {
      throw new AppError(400, 'Only a flat-rate charge can be stopped this way — this meter bills what it measures.')
    }
    // ...and it is the landlord's own choice: the assistant makes no money
    // decision (decisions #38 Q6), so it neither stops a charge nor keeps one
    // billing on the landlord's behalf.
    if (confirmingNoUse && flatRate && req.get('X-GAM-Actor') === 'agent') {
      throw new AppError(403,
        `Whether ${meter.label}'s flat charge stops too is the landlord's own choice, made with `
        + `"${meterWorksNoUseLabel(meter.utility_type)}" on the Utilities page — nothing was changed.`)
    }
    if (confirmingNoUse && flatRate && body.stopFlatCharge === undefined) {
      const served = await queryOne<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM utility_meter_units WHERE meter_id = $1`, [meter.id])
      const n = served?.n ?? 0
      return void res.status(409).json({
        success: false, code: 'flat_charge_question',
        error: `Stop the flat charge too? Yes: ${meter.label} bills nothing to the ${n} space${n === 1 ? '' : 's'} on it `
          + 'while it is marked unused, and starts again once it is not. No: it keeps billing.',
        spaces: n,
      })
    }
    // The flagged period this meter is in (services/meterRepair
    // flaggedPeriodStart: since it last came back into service), read BEFORE
    // the meter goes back in service below — that write is the next "came back".
    const flaggedFrom = meter.out_of_service
      ? await flaggedPeriodStart((t, p) => query<any>(t, p).then(rows => ({ rows })), meter.id)
      : null
    // ...and the assistant never takes that choice away by putting a flagged
    // meter back first: once it is back in service there is no flagged period
    // left to ask about. With estimates waiting on the answer, it is the
    // landlord's press, where the window shows how many and how much.
    if (confirmingNoUse && meter.out_of_service && req.get('X-GAM-Actor') === 'agent') {
      const waiting = await flaggedPeriodEstimates(
        (t, p) => query<any>(t, p).then(rows => ({ rows })), meter.id, flaggedFrom)
      if (waiting.length > 0) {
        const total = Math.round(waiting.reduce((s, e) => s + Math.round(e.amount * 100), 0)) / 100
        throw new AppError(409,
          `${meter.label} has ${waiting.length} unpaid estimated charge${waiting.length === 1 ? '' : 's'} from while it was flagged `
          + `($${total.toFixed(2)}). Whether to void them is the landlord's choice, made with "Works, tenant uses no power" `
          + `on the Utilities page (the wrench on the meter) — nothing was changed.`)
      }
    }
    // 10/12 (Nic): "Works, tenant uses no power" — "Any meter". It used to be
    // refused on anything but a submeter (only a submeter is ever flagged for
    // not moving, services/utilityBilling), which left a RUBS master, a
    // master the landlord pays and a flat-rate meter with no way to say it.
    // On those it records the confirmation and puts the meter back in service
    // when it was marked broken; what it bills is unchanged (the stuck-meter
    // test it quiets runs on submeters only).
    // "Works, tenant uses no power" needs no reading: the meter was never
    // broken, so the reads it already has stand and the next is measured from them.
    if (repairing && body.repairedStartingReading == null && !confirmingNoUse) {
      throw new AppError(400,
        'Enter what the repaired or replaced meter reads right now (0 for a brand-new meter). Its next bill is measured from that number.')
    }
    if (repairing && meter.digits != null && body.repairedStartingReading != null
        && body.repairedStartingReading >= meterReadingModulus(Number(meter.digits))) {
      throw new AppError(400,
        `${body.repairedStartingReading} does not fit on a ${meter.digits}-digit meter — check the number, or change the meter's digits first.`)
    }
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

    const tx = await getClient()
    let updated: any
    try {
      await tx.query('BEGIN')
      updated = (await tx.query(`
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
        ])).rows[0]
      // 10/12 (Nic): somebody marking the meter broken by hand overrides an
      // earlier "it works, the household uses nothing" (utility_meters.
      // zero_use_confirmed_at, services/meterRepair): from here a flat read is
      // a stuck meter again. Only written when one is on record.
      // 10/12 (Nic, review): ...and the landlord taking it back (zeroUseWithdrawn).
      // 10/13 (Nic): and a flat charge stopped with it starts again
      // (ZERO_USE_CLEARED_SET clears the answer with the mark).
      if ((body.outOfService === true || withdrawingNoUse) && meter.zero_use_confirmed_at) {
        await tx.query(
          `UPDATE utility_meters SET ${ZERO_USE_CLEARED_SET} WHERE id = $1`,
          [req.params.id])
        updated = (await tx.query(`SELECT * FROM utility_meters WHERE id = $1`, [req.params.id])).rows[0]
      }
      if (repairing && body.repairedStartingReading != null) {
        // The fresh starting point, dated today at the property. Recorded as a
        // replacement read: it starts the next measurement and bills nothing.
        // 10/12: the one repair path (services/meterRepair), shared with the
        // one-time repair of Gerald Logue's meter — confirmed working with
        // nobody using it too, when that is said with it.
        await markMeterRepaired(tx, {
          meterId: req.params.id, startingReading: body.repairedStartingReading, userId: req.user!.userId,
          zeroUseConfirmed: confirmingNoUse, stopFlatCharge: body.stopFlatCharge === true,
        })
        updated = (await tx.query(`SELECT * FROM utility_meters WHERE id = $1`, [req.params.id])).rows[0]
      } else if (confirmingNoUse) {
        // 10/12 (Nic), M1: "Works, tenant uses no power".
        await markMeterWorksNoUse(tx, { meterId: req.params.id, userId: req.user!.userId, stopFlatCharge: body.stopFlatCharge === true })
        updated = (await tx.query(`SELECT * FROM utility_meters WHERE id = $1`, [req.params.id])).rows[0]
      }
      await tx.query('COMMIT')
    } catch (e) {
      await tx.query('ROLLBACK').catch(() => {})
      throw e
    } finally { tx.release() }
    // 10/12 (Nic), Q-f: the landlord chose to void the unpaid estimates billed
    // while the meter was flagged. The flagged period is the one it was in
    // when the choice was made (read above, before it went back in service);
    // a meter that was not flagged has none. Each household is voided under
    // its own lock after the meter is back (services/meterRepair), and only
    // the charges the window showed.
    if (voidingEstimates && flaggedFrom) {
      const result = await voidFlaggedPeriodEstimates({
        meterId: req.params.id, from: flaggedFrom, utilityType: meter.utility_type,
        shownIds: body.voidEstimateIds ?? [],
      })
      return res.json({ success: true, data: { ...updated, flagged_estimates_voided: result } })
    }
    res.json({ success: true, data: updated })
  } catch (e) { next(e) }
})

/**
 * 10/12 (Nic), Q-f — the numbers for the question in the "Works, tenant uses no
 * power" window: "Also void the N unpaid estimated charges from while it was
 * flagged ($X)?" The same list PATCH voids when the landlord says yes
 * (services/meterRepair flaggedPeriodEstimates). Empty for a meter that is not
 * flagged — nothing to ask. Read-only.
 */
utilityRouter.get('/meters/:id/flagged-estimates', requirePerm('properties.edit'), async (req, res, next) => {
  try {
    const meter = await queryOne<any>(
      `SELECT m.id, m.property_id, p.landlord_id FROM utility_meters m
         JOIN properties p ON p.id = m.property_id
        WHERE m.id = $1`, [req.params.id])
    if (!meter) throw new AppError(404, 'Meter not found')
    if (!canAccessLandlordResource(req.user, meter.landlord_id)) throw new AppError(403, 'Forbidden')
    await assertPropertyInScope(req.user, meter.property_id)
    const list = await flaggedPeriodEstimates((t, p) => query<any>(t, p).then(rows => ({ rows })), meter.id)
    const amount = Math.round(list.reduce((s, e) => s + Math.round(e.amount * 100), 0)) / 100
    res.json({ success: true, data: {
      count: list.length,
      amount,
      // 10/12 (review): each charge's id, sent back with "Yes, void them"
      // (PATCH voidEstimateIds) so only what was shown comes off.
      charges: list.map(e => ({
        id: e.id, state: e.state, cycleMonth: e.cycleMonth, amount: e.amount, invoiceNumber: e.invoiceNumber,
      })),
    } })
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
    // 10/12 (review): held to the properties a team member is scoped to (see PATCH).
    await assertPropertyInScope(req.user, meter.property_id)
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
    // 10/12 (review): held to the properties a team member is scoped to (see PATCH /meters/:id).
    await assertPropertyInScope(req.user, meter.property_id)
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
    // S634 (Nic, DIRECTIVE) NARROWED THIS TO ONE METER, FULL STOP. S604 carved
    // out one legitimate overlap: a submetered unit ALSO sitting in a RUBS
    // master's served group, so its usage could be subtracted from the pool
    // before the split (Oak Park's mobile homes on the shared water master).
    // S634 removes the subtraction — the RUBS units divide the whole bill and
    // submeters bill their gallons on top — so that pairing now has no meaning
    // and is exactly the ambiguity Nic ruled out: "It can't be part of one RUBS
    // system and one submeter system... it could be one in one for separate
    // utilities, but not for the same utility."
    const clash = await queryOne<{ label: string; billing_method: string }>(
      `SELECT m.label, m.billing_method
         FROM utility_meter_units mu
         JOIN utility_meters m ON m.id = mu.meter_id
        WHERE mu.unit_id = $1
          AND m.id <> $2
          AND m.utility_type = $3
        LIMIT 1`,
      [unitId, req.params.id, meter.utility_type])
    if (clash) {
      skipped.push({ unitId, status: 400, reason:
        `Already on "${clash.label}" for ${meter.utility_type} — a unit can only be on one `
        + `${meter.utility_type} meter. Remove it from that one first.` })
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
    // 10/12 (review): held to the properties a team member is scoped to (see PATCH /meters/:id).
    await assertPropertyInScope(req.user, meter.property_id)

    const rows = await query<{ lease_id: string; unit_id: string }>(
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
       RETURNING lease_id, (SELECT unit_id FROM leases WHERE id = lease_id) AS unit_id`,
      [req.params.id, meter.utility_type, req.user!.userId, note ?? null])

    // S634 (Nic, DIRECTIVE): "It needs to start immediately with those suspended
    // amounts from the previous meter reads."
    //
    // Turning a utility on used to affect only the NEXT cycle, which quietly
    // wrote off everything already metered and parked. Those held shares are
    // real usage the other residents were already charged around — the money
    // exists, it just had nowhere to go until somebody was responsible for it.
    // Saying "starts next invoice" while sitting on a released-able balance is
    // how a park loses a month of electric.
    //
    // Released here, per unit, the same way a signed lease releases them.
    // Best-effort: a share that will not release stays held rather than
    // vanishing.
    let releasedCount = 0
    let releasedAmount = 0
    for (const r of rows) {
      if (!r.unit_id) continue
      const primary = await queryOne<{ tenant_id: string }>(
        `SELECT lt.tenant_id FROM lease_tenants lt
          WHERE lt.lease_id = $1 AND lt.status = 'active'
          ORDER BY (lt.role = 'primary') DESC LIMIT 1`, [r.lease_id])
      if (!primary) continue
      try {
        const out = await releaseSuspendedChargesForLease({
          unitId: r.unit_id, leaseId: r.lease_id,
          tenantId: primary.tenant_id, landlordId: meter.landlord_id,
        })
        releasedCount += out.released
        releasedAmount += out.amount
      } catch (e) {
        logger.error({ err: e, leaseId: r.lease_id, unitId: r.unit_id },
          'utility bill-back: could not release held shares — left held')
      }
    }
    res.json({ success: true, data: {
      leasesUpdated: rows.length,
      heldChargesReleased: releasedCount,
      heldAmountReleased: Number(releasedAmount.toFixed(2)),
    } })
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
    // 10/12 (review): held to the properties a team member is scoped to (see PATCH /meters/:id).
    await assertPropertyInScope(req.user, meter.property_id)
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
    // 10/12 (review): held to the properties a team member is scoped to (see PATCH /meters/:id).
    await assertPropertyInScope(req.user, meter.property_id)
    await query(`DELETE FROM utility_meter_units WHERE meter_id = $1 AND unit_id = $2`,
      [req.params.id, req.params.unitId])
    res.json({ success: true })
  } catch (e) { next(e) }
})

// 10/20 (Nic) — THE TWO FREE-TEXT STRINGS ARE GONE FROM THIS REPORT.
//
// `registerUtilityType(cat, name)` used to decide whether a register or
// pay-link line was utility money given back by grepping a category name for
// 'utilit%' and an item name for electric / water / sewer / trash / gas. Both
// strings arrived from the request body, so what money WAS could be set by text
// a register posted — and Mountain View's "Propane" at $3.30/gal sits in a
// category literally named "Utilities", safe only because the word "Propane"
// matches none of the patterns. Rename that button "Propane gas" and $328 of
// TPT-taxed fuel revenue reads as gas bill-back.
//
// A line now says what it is: pos_items.recovers_utility on the catalog button,
// snapshotted onto pos_transaction_items at sale time (10/20). NULL means
// PRODUCT — an answer, not a missing value — so dispensed propane can never
// reach this report whatever anyone names or categorizes it.
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
// The slices that can be named without guessing are the ones recorded as they
// happen. Everything else in the gap — common areas, a lease that doesn't pass
// it through — is reported together as unattributed, because attributing it
// would mean inventing a number rather than reading one.
//
// 10/20 (Nic) — AND THE GAP SPLITS THREE WAYS, BECAUSE TWO OF THEM ARE NOT THE
// SAME QUESTION AT ALL.
//
//   "I know we already have a utilities not build back, but it needs to be
//    separated between stuff that the property just generally uses, the
//    property's own consumption, versus what somebody used that didn't get
//    billed back. There's a distinction there that I want to make, and that
//    distinction needs to be applied against money that could have been
//    prorated back that wasn't."
//
//   THE PROPERTY USED IT — the office, the shop, irrigation, a vacant site's
//     base charge, and an owner-occupied space's power. On the last one he was
//     explicit: "owner-occupied power would be considering the property to have
//     used it." A cost of doing business, and never in the gap.
//   RECOVERED — from THREE sources, where this report counted only the first:
//     a utility bill; a register or pay-link sale; and power that was inside a
//     nightly or weekly rate all along. A delivered propane fill is the fourth
//     shape of the first — propane's bill is the fill, billed back in
//     installments, because utility_bills cannot hold propane at all.
//   SOMEBODY'S USAGE, NEVER RECOVERED — a wash, a resident GAM could not bill,
//     a stay with no agreement. THIS is the gap number, and the ONLY one the
//     money-kept figure is set against.
//
// So each line carries `propertyUsed` and `somebodysUsage` beside the whole gap,
// and the comparison at the bottom sets money kept against `somebodysUsage`
// alone. Setting it against the whole gap would charge the departing guests for
// the office lights.
//
// WHAT IS STILL NOT SPLIT, SAID OUT LOUD. The park's own general use is a
// RESIDUAL: no record says "the shop used $40 of power", so it falls into
// `unattributed` along with anything else nobody wrote down. Nic is right that
// most of it is the property's own — but moving it there on that hunch would be
// the invented number this report exists to avoid, so it stays its own figure
// and the screen says what it mostly is.
//
// 10/20 (Nic) — AND THE EARLY DEPARTURES, BOTH HALVES OF THEM.
//
//   "I would like to keep track of money that wasn't refunded versus electric
//    that should have been billed that wasn't charged to see how close we
//    actually get to evening out. You know, because people leave at various
//    times and we try to be generous with it, but I want to make sure that it's
//    somewhat fair."
//
// A wash's power was swallowed into the unattributed gap along with the common
// areas and the vacant spaces, which is exactly why he could not see it. It is
// named now, the way the owner-occupied share already was.
//
// THE GAP IS NOT AN ADDITION SUM, and that matters more than anything else
// here. `notRecovered` is the whole gap — spent minus billed back — and every
// named slice lives INSIDE it. So each line also carries `unattributed`, the
// part no record accounts for, and they reconcile exactly:
//
//     notRecovered = propertyUsed + somebodysUsage + unattributed
//     propertyUsed = ownerOccupied + vacantSpaces
//     somebodysUsage = earlyDepartureWash
//
// Nic's standing rule is that every dollar is counted exactly once. A report
// that showed the absorbed power as its own slice AND left it inside the gap
// would be adding the same dollar twice, and routes/utilityRecovery.test.ts
// asserts that identity rather than trusting it.
//
// TWO WINDOWS, deliberately, because the two questions are asked on different
// axes and pretending otherwise would make one of them wrong:
//   - the per-utility-type slice is scoped by BILLING CYCLE MONTH, like the
//     bills and the owner-use rows it has to reconcile against; and
//   - the comparison in `earlyDepartures` is scoped by the DAY SOMEBODY LEFT
//     and paired per departure (washPairing), because the money kept and the
//     power eaten belong to a person, not to a month. They coincide except at
//     the edge of a window, where a December departure's final read bills in
//     January — which is what `awaitingClosingRead` is there to say out loud
//     instead of quietly reading as a park that came out ahead.
utilityRouter.get('/recovery', requirePerm('properties.edit', 'units.view_status'), async (req, res, next) => {
  try {
    const propertyId = z.string().uuid().parse(req.query.propertyId)
    const from = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).parse(req.query.from)
    const to   = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).parse(req.query.to)
    const property = await queryOne<any>(
      `SELECT id, landlord_id FROM properties WHERE id = $1`, [propertyId])
    if (!property) throw new AppError(404, 'Property not found')
    if (!canAccessLandlordResource(req.user, property.landlord_id)) throw new AppError(403, 'Forbidden')

    // 10/12 (Nic, ledger P8): once the company's books are live, what the
    // property SPENT is its utility expenses as the books hold them — the
    // property's share of each (a company-wide bill split by units included),
    // on its accounting day; the expense still says which utility.
    const onBooks = await ledgerReportsLive([property.landlord_id])
    const spentSql = onBooks
      ? `SELECT COALESCE(e.utility_type, 'unspecified') AS utility_type,
                SUM(l.debit - l.credit)::numeric AS amount
           FROM ledger_posting_lines l
           JOIN ledger_postings ps ON ps.id = l.posting_id AND ps.source_type = 'expense'
           JOIN landlord_expenses e ON e.id::text = ps.source_id
           JOIN books_accounts a ON a.id = l.account_id AND a.type = 'expense'
          WHERE l.landlord_id = $4::uuid AND l.property_id = $1 AND e.category = 'utilities'
            AND l.accounting_date BETWEEN $2::date AND $3::date
          GROUP BY 1`
      : `SELECT COALESCE(e.utility_type, 'unspecified') AS utility_type,
                SUM(e.amount)::numeric AS amount
           FROM landlord_expenses e
          WHERE e.property_id = $1 AND e.category = 'utilities'
            AND ${liveExpenseSql('e')}
            AND e.expense_date BETWEEN $2::date AND $3::date
            AND $4::uuid IS NOT NULL
          GROUP BY 1`
    const rows = await query<any>(`
      WITH spent AS (
        ${spentSql}
      ),
      -- S652 (Nic): "spent zero, billed back $1,588.65, and not recovered
      -- $1,588.65. Those are an exact match and I don't know why it's saying
      -- it's not recovered. Most people at Mountain View have paid." Three
      -- things were wrong at once: VOIDED bills were counted as billed back;
      -- the total subtracted from a spend nobody had entered; and nothing said
      -- how much of what was billed had actually been PAID. Billed excludes
      -- void; collected is what tenants paid; the gap only exists where the
      -- property recorded what the utility charged it.
      --
      -- S652 (Nic): "He is on a work trade. It's unpaid because of a work
      -- trade." A charge the work trade covers is not money a tenant owes — it
      -- is being worked off. It gets its own column: parked under the agreement
      -- while the hours are worked, or closed by the work-trade credit at month
      -- end. Neither one is "paid" and neither one is "still owed".
      --
      -- S652 (Nic): "It needs to count the 387 kilowatts for $81.27 as still
      -- outstanding. It's billed back and not paid." A tenant with no lease is
      -- billed his meter on a PAY LINK — Andres Razo, leaving, got a link
      -- instead of a lease. That is utility billed back exactly like a bill
      -- on an invoice, so it is counted the same: an open link is still owed,
      -- and a utility line rung up and paid (a paid link is a register sale)
      -- is paid.
      --
      -- 10/20 (Nic): three sources, and a "source" column says which, because
      -- one "billed back" number meaning three different things is how a
      -- report stops being readable. A line is utility money only when its own
      -- row says so (pos_items.recovers_utility) — never a name, never a
      -- category.
      billed AS (
        -- SOURCE 1: A UTILITY BILL on somebody's invoice.
        SELECT ub.utility_type,
               (ub.charge_amount + COALESCE(ub.tax_amount, 0))::numeric AS amount,
               CASE WHEN wt.covered THEN 'work_trade'
                    WHEN ub.status = 'paid' THEN 'paid'
                    ELSE 'owed' END AS bucket,
               'bill' AS source
          FROM utility_bills ub
          JOIN units u ON u.id = ub.unit_id
          LEFT JOIN payments pay ON pay.id = ub.payment_id
          CROSS JOIN LATERAL (
            SELECT COALESCE(
              (pay.status = 'pending' AND pay.work_trade_suspended_at IS NOT NULL)
              OR (pay.status = 'settled' AND pay.amount = 0 AND pay.notes ILIKE '%work-trade credit%'),
              false) AS covered
          ) wt
         WHERE u.property_id = $1
           AND ub.status <> 'void'
           AND ub.billing_cycle_month BETWEEN date_trunc('month', $2::date)::date
                                          AND date_trunc('month', $3::date)::date
        UNION ALL
        -- SOURCE 1, THE PROPANE SHAPE OF IT. A DELIVERED fill is propane's
        -- bill: utility_bills' own CHECK holds five types and propane is not
        -- one, so a tank filled on the space can never be a utility_bills row.
        -- It bills back as installments on the resident's invoice, and
        -- total_amount already carries the fill's propane tax and its share
        -- of the delivery charge, so the installments sum to it exactly
        -- (services/propaneFill) and nothing is added on top here.
        --
        -- DISPENSED propane — a bottle filled at the counter — is a PRODUCT and
        -- is not in this report at any point: it has no fill row, and its
        -- register line's recovers_utility is NULL by the item's own say-so.
        SELECT 'propane' AS utility_type,
               i.amount::numeric AS amount,
               CASE WHEN pwt.covered THEN 'work_trade'
                    WHEN ppay.status = 'settled' THEN 'paid'
                    ELSE 'owed' END AS bucket,
               'bill' AS source
          FROM propane_fills f
          JOIN propane_fill_installments i ON i.fill_id = f.id
          LEFT JOIN payments ppay ON ppay.id = i.payment_id
          CROSS JOIN LATERAL (
            SELECT COALESCE(
              (ppay.status = 'pending' AND ppay.work_trade_suspended_at IS NOT NULL)
              OR (ppay.status = 'settled' AND ppay.amount = 0 AND ppay.notes ILIKE '%work-trade credit%'),
              false) AS covered
          ) pwt
         WHERE f.property_id = $1 AND f.landlord_id = $4::uuid
           AND i.billing_cycle_month BETWEEN date_trunc('month', $2::date)::date
                                         AND date_trunc('month', $3::date)::date
        UNION ALL
        -- SOURCE 2a: a utility line on an OPEN pay link — billed back, not paid
        -- yet. The line's catalog item is what says it is a utility, joined by
        -- the id the link carries.
        --
        -- A line RAISED FROM A BILL is deliberately invisible here: it has no
        -- item id (services/utilityPayLink writes id: null with utilityBillId)
        -- so it joins no item, and its bill is already counted by source 1.
        -- Counting the link too would bill the same kilowatts twice.
        SELECT pi.recovers_utility AS utility_type,
               ROUND((it->>'qty')::numeric * (it->>'price')::numeric
                     * (1 + COALESCE((it->>'tax')::numeric, 0)), 2) AS amount,
               'owed' AS bucket,
               'sale' AS source
          FROM pos_pay_links l
          CROSS JOIN LATERAL jsonb_array_elements(l.items) it
          -- The id is read through a shape check before it is cast. A line
          -- with no item (id null, or a hand-typed ad-hoc line) is the normal
          -- case and must land as "no item", not as a 22P02 that takes the
          -- landlord's whole money report down with it.
          CROSS JOIN LATERAL (
            SELECT CASE WHEN it->>'id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                        THEN (it->>'id')::uuid END AS item_id
          ) iid
          JOIN pos_items pi ON pi.id = iid.item_id
         WHERE l.property_id = $1
           AND l.kind = 'one_time' AND l.status = 'open'
           AND (l.expires_at IS NULL OR l.expires_at > NOW())
           AND pi.recovers_utility IS NOT NULL
           AND date_trunc('month', l.created_at)::date BETWEEN date_trunc('month', $2::date)::date
                                                           AND date_trunc('month', $3::date)::date
        UNION ALL
        -- SOURCE 2b: a utility line RUNG UP — at the register or by a pay link
        -- being paid. Read off the sale line's own snapshot, which posSale
        -- writes from the item's DB row and never from the request body, so a
        -- rename or a recategorize cannot restate a settled month.
        --
        -- status = 'completed' leaves out a sale that was refunded in whole or
        -- in part, which is Nic's own rule on the wash applied here: "any
        -- refund, even partial, means no wash." Money handed back is money not
        -- recovered, and apportioning a part refund across a sale's lines would
        -- be inventing a number.
        SELECT ti.recovers_utility AS utility_type,
               ROUND(ti.subtotal * (1 + COALESCE(ti.tax_rate, 0)), 2) AS amount,
               'paid' AS bucket,
               'sale' AS source
          FROM pos_transaction_items ti
          JOIN pos_transactions t ON t.id = ti.transaction_id
         WHERE t.property_id = $1
           AND t.status = 'completed'
           AND ti.recovers_utility IS NOT NULL
           AND date_trunc('month', t.created_at)::date BETWEEN date_trunc('month', $2::date)::date
                                                           AND date_trunc('month', $3::date)::date
        UNION ALL
        -- SOURCE 3: POWER THAT WAS INSIDE THE RATE ALL ALONG. A nightly or
        -- weekly guest's electric is not billed back because the rate already
        -- charged for it, so the money came in with the stay. Recorded as it
        -- happens on the one book for utility billed to nobody, and counted
        -- here as recovered rather than left in the gap — "power inside a
        -- nightly or weekly rate" is the third source Nic named.
        --
        -- Already collected by definition: the stay was paid for at its rate.
        SELECT a.utility_type,
               (a.charge_amount + a.tax_amount)::numeric AS amount,
               'paid' AS bucket,
               'in_rate' AS source
          FROM utility_absorbed_charges a
          JOIN units u ON u.id = a.unit_id
         WHERE u.property_id = $1
           AND a.landlord_id = $4::uuid
           AND a.reason = 'short_stay_in_rate'
           AND a.billing_cycle_month BETWEEN date_trunc('month', $2::date)::date
                                         AND date_trunc('month', $3::date)::date
      ),
      recovered AS (
        SELECT b.utility_type,
               SUM(b.amount)::numeric AS amount,
               SUM(b.amount) FILTER (WHERE b.bucket = 'work_trade')::numeric AS work_trade,
               SUM(b.amount) FILTER (WHERE b.bucket = 'paid')::numeric AS collected,
               SUM(b.amount) FILTER (WHERE b.source = 'bill')::numeric AS from_bills,
               SUM(b.amount) FILTER (WHERE b.source = 'sale')::numeric AS from_sales,
               SUM(b.amount) FILTER (WHERE b.source = 'in_rate')::numeric AS in_the_rate
          FROM billed b
         GROUP BY 1
      ),
      -- THE PROPERTY'S OWN USE, as far as anything is recorded: an
      -- owner-occupied space's share ("owner-occupied power would be
      -- considering the property to have used it") and an empty space's base
      -- charge. Both read off utility_absorbed_charges by reason — the one book
      -- — and never off the compatibility view beside it, which shows owner-use
      -- rows only on purpose.
      property_use AS (
        SELECT a.utility_type,
               SUM(a.charge_amount + a.tax_amount) FILTER (WHERE a.reason = 'owner_use')::numeric AS owner_use,
               SUM(a.charge_amount + a.tax_amount) FILTER (WHERE a.reason = 'vacant')::numeric AS vacant
          FROM utility_absorbed_charges a
          JOIN units u ON u.id = a.unit_id
         WHERE u.property_id = $1
           AND a.landlord_id = $4::uuid
           AND a.reason IN ('owner_use', 'vacant')
           AND a.billing_cycle_month BETWEEN date_trunc('month', $2::date)::date
                                         AND date_trunc('month', $3::date)::date
         GROUP BY 1
      ),
      -- 10/20: the stub a departing guest was never billed because the landlord
      -- kept their money. Read off utility_absorbed_charges by reason — the one
      -- book for utility billed to nobody — and NOT off the compatibility view
      -- beside it, which shows owner-use rows only on purpose so that column
      -- cannot quietly start swallowing washes.
      --
      -- Tax is in it, because the billed side counts tax too; a stub absorbed
      -- with its tax and compared against a recovered figure that includes tax
      -- is the only way the two sides are the same measurement.
      --
      -- Landlord-scoped as well as property-scoped. The property is already
      -- authorized above and its units cannot belong to anyone else, so this is
      -- belt and braces on a money figure rather than the only gate.
      early_wash AS (
        SELECT a.utility_type, SUM(a.charge_amount + a.tax_amount)::numeric AS amount
          FROM utility_absorbed_charges a
          JOIN units u ON u.id = a.unit_id
         WHERE u.property_id = $1
           AND a.landlord_id = $4::uuid
           AND a.reason = 'early_departure_wash'
           AND a.billing_cycle_month BETWEEN date_trunc('month', $2::date)::date
                                         AND date_trunc('month', $3::date)::date
         GROUP BY 1
      )
      SELECT t.utility_type,
             COALESCE(s.amount, 0)::float  AS spent,
             COALESCE(r.amount, 0)::float  AS recovered,
             COALESCE(r.from_bills, 0)::float  AS from_bills,
             COALESCE(r.from_sales, 0)::float  AS from_sales,
             COALESCE(r.in_the_rate, 0)::float AS in_the_rate,
             COALESCE(r.collected, 0)::float AS collected,
             COALESCE(r.work_trade, 0)::float AS work_trade,
             COALESCE(o.owner_use, 0)::float AS owner_occupied,
             COALESCE(o.vacant, 0)::float  AS vacant_spaces,
             COALESCE(w.amount, 0)::float  AS early_departure_wash
        FROM (SELECT utility_type FROM spent
              UNION SELECT utility_type FROM recovered
              UNION SELECT utility_type FROM property_use
              UNION SELECT utility_type FROM early_wash) t
        LEFT JOIN spent s        ON s.utility_type = t.utility_type
        LEFT JOIN recovered r    ON r.utility_type = t.utility_type
        LEFT JOIN property_use o ON o.utility_type = t.utility_type
        LEFT JOIN early_wash w   ON w.utility_type = t.utility_type
       ORDER BY 2 DESC
    `, [propertyId, from, to, property.landlord_id])

    const round2 = (n: number) => Math.round(n * 100) / 100
    const lines = rows.map((r: any) => {
      const spent = Number(r.spent)
      const ownerOccupied = Number(r.owner_occupied)
      const vacantSpaces = Number(r.vacant_spaces)
      const earlyDepartureWash = Number(r.early_departure_wash)
      // 10/20 (Nic), the first of the three: "stuff that the property just
      // generally uses, the property's own consumption." A cost of doing
      // business, so it is named and taken out before anything is compared
      // against money somebody did not get back.
      const propertyUsed = round2(ownerOccupied + vacantSpaces)
      // And the third: "what somebody used that didn't get billed back." The
      // only one the money-kept figure is set against. Today the single
      // recorded shape of it is a wash; a resident GAM could not bill and a
      // stay with no agreement join it the day either is written down.
      const somebodysUsage = earlyDepartureWash
      // Only meaningful where the landlord recorded what he SPENT. Without the
      // bill on the expense side there is nothing to subtract from, so this
      // reports null rather than implying the whole recovery was a shortfall.
      const notRecovered = spent > 0 ? round2(spent - Number(r.recovered)) : null
      return {
        utilityType: r.utility_type,
        spent,
        recovered: Number(r.recovered),
        // The three sources, so "billed back" is never one number meaning
        // three things: a bill (a propane fill among them), a register or
        // pay-link sale, and power that was inside a nightly or weekly rate.
        fromBills: Number(r.from_bills),
        fromSales: Number(r.from_sales),
        inTheRate: Number(r.in_the_rate),
        collected: Number(r.collected),
        workTrade: Number(r.work_trade),
        stillOwed: round2(Number(r.recovered) - Number(r.collected) - Number(r.work_trade)),
        propertyUsed,
        ownerOccupied,
        vacantSpaces,
        somebodysUsage,
        earlyDepartureWash,
        notRecovered,
        // What is left of the gap once the recorded slices come out of it. Null
        // for the same reason notRecovered is: there is no gap to divide up.
        //
        // Mostly the park's own general use — the office, the shop, irrigation
        // — but NOTHING ON FILE SAYS SO, so it is not moved into propertyUsed
        // on that reasoning. It also holds a lease that never passed the
        // utility through.
        //
        // It can come out NEGATIVE, and it is deliberately not clamped. That
        // means more utility is recorded as absorbed than the recorded spend
        // leaves room for — which says the expense side is short, and clamping
        // it to zero would hide the one thing worth knowing.
        unattributed: notRecovered == null
          ? null
          : round2(notRecovered - propertyUsed - somebodysUsage),
      }
    })
    const sum = (k: 'spent' | 'recovered' | 'fromBills' | 'fromSales' | 'inTheRate' | 'collected'
      | 'workTrade' | 'stillOwed' | 'propertyUsed' | 'ownerOccupied' | 'vacantSpaces'
      | 'somebodysUsage' | 'earlyDepartureWash') =>
      round2(lines.reduce((n: number, l: any) => n + l[k], 0))
    // The gap is only a number where a spend was recorded — summed over those
    // utilities alone, so a utility with no bill entered cannot make the
    // total claim a shortfall (or a surplus) that nobody measured.
    //
    // ONE CONSEQUENCE, AND IT IS DELIBERATE: the three-way identity holds on
    // every LINE, and on the totals only when every utility has a spend
    // recorded. A park that entered its electric bill but not its water one
    // still gets water's recorded owner-use and washes in the totals — those
    // are real figures, recorded as they happened — while water's gap is a
    // dash. Dropping them from the totals to make the subtraction come out
    // even would hide money that was actually written down, which is the
    // worse of the two.
    const measured = lines.filter((l: any) => l.notRecovered != null)
    const measuredSum = (k: 'notRecovered' | 'unattributed') => measured.length
      ? round2(measured.reduce((n: number, l: any) => n + l[k], 0))
      : null

    // 10/20 — THE MONEY SIDE, which is money and not a utility type, so it sits
    // in the summary rather than on a per-utility line. Paired per departure by
    // the service that owns the rule; this handler adds nothing up that the
    // service has not already put side by side.
    const departures = await washPairing(property.landlord_id, { propertyId, from, to })
    // 10/20 (Nic): the money figure is NET of the short-term lodging tax a
    // re-priced stay would owe — "even though they weren't charged the tax
    // needs to be factored in" — because the landlord remits that out of his
    // own pocket if he ever squares it up. The service prices it per departure
    // (earlyDepartureWash repricedStayTax); the gross and the tax come up too,
    // so the screen can show the subtraction rather than a figure that dropped
    // $35.51 a departure with no explanation.
    const moneyKept = round2(departures.reduce((n, d) => n + d.moneyKept, 0))
    const moneyKeptBeforeTax = round2(departures.reduce((n, d) => n + d.moneyKeptBeforeTax, 0))
    const lodgingTaxOwed = round2(departures.reduce((n, d) => n + d.lodgingTaxOwed, 0))
    const utilityAbsorbed = round2(departures.reduce((n, d) => n + d.utilityAbsorbed, 0))
    res.json({ success: true, data: {
      from, to, lines,
      totals: {
        spent: sum('spent'), recovered: sum('recovered'), collected: sum('collected'), workTrade: sum('workTrade'), stillOwed: sum('stillOwed'),
        fromBills: sum('fromBills'), fromSales: sum('fromSales'), inTheRate: sum('inTheRate'),
        propertyUsed: sum('propertyUsed'),
        ownerOccupied: sum('ownerOccupied'),
        vacantSpaces: sum('vacantSpaces'),
        somebodysUsage: sum('somebodysUsage'),
        earlyDepartureWash: sum('earlyDepartureWash'),
        notRecovered: measuredSum('notRecovered'),
        unattributed: measuredSum('unattributed'),
        earlyDepartures: {
          departures: departures.length,
          moneyKept,
          moneyKeptBeforeTax,
          lodgingTaxOwed,
          utilityAbsorbed,
          // Which way it leans, signed: positive means the money kept covered
          // the power and then some, negative means the power cost more than
          // was kept. NOT clamped and NOT labelled good or bad — Nic asked
          // whether it is fair, and a number that only ever reads as a win
          // would not answer that.
          evenedOutBy: round2(moneyKept - utilityAbsorbed),
          // Departures whose closing read has not landed, so their power is not
          // in `utilityAbsorbed` yet and the comparison leans generous until it
          // is. Said out loud so nobody reads a half-measured window as even.
          awaitingClosingRead: departures.filter(d => !d.closingReadsIn).length,
          // Final stubs computed but parked on an unanswered money question.
          heldStubs: departures.reduce((n, d) => n + d.heldStubs, 0),
        },
      },
    } })
  } catch (e) { next(e) }
})

// GET /api/utility/reading-history?propertyId=&months= — S652 (Nic): "I don't
// want to download readings… I want stuff to stay in the system, visible
// without downloading external reports… a spot to view the history as some
// sort of spreadsheet, but make it look good." Every submeter at the property
// with its readings, newest first, and the usage each one closed. LANDLORD-ONLY
// for the same reason as /meters/:id/readings: a blind reader never sees values.
utilityRouter.get('/reading-history', requirePerm('properties.edit'), async (req, res, next) => {
  try {
    const propertyId = z.string().uuid().parse(req.query.propertyId)
    const months = Math.min(36, Math.max(1, Number(req.query.months) || 12))
    const property = await queryOne<any>(`SELECT id, landlord_id FROM properties WHERE id = $1`, [propertyId])
    if (!property) throw new AppError(404, 'Property not found')
    if (!canAccessLandlordResource(req.user, property.landlord_id)) throw new AppError(403, 'Forbidden')
    const rows = await query<any>(`
      SELECT m.id AS meter_id, m.label, m.utility_type, m.billing_method, m.digits, m.reading_multiplier,
             COALESCE(m.out_of_service, FALSE) AS out_of_service,
             (SELECT string_agg(u.unit_number, ', ' ORDER BY u.unit_number)
                FROM utility_meter_units mu JOIN units u ON u.id = mu.unit_id WHERE mu.meter_id = m.id) AS unit_numbers,
             r.id AS reading_id, to_char(r.reading_date, 'YYYY-MM-DD') AS reading_date,
             to_char(r.billing_cycle_month, 'YYYY-MM-DD') AS cycle_month,
             r.reading_value, r.reason, r.reason_note, r.needs_review, r.is_rollover,
             (r.photo_url IS NOT NULL) AS has_photo,
             (SELECT pr.reading_value FROM utility_meter_readings pr
               WHERE pr.meter_id = m.id AND (pr.reading_date, pr.created_at) < (r.reading_date, r.created_at)
               ORDER BY pr.reading_date DESC, pr.created_at DESC LIMIT 1) AS prior_value
        FROM utility_meters m
        LEFT JOIN utility_meter_readings r
               ON r.meter_id = m.id AND r.reading_date >= (CURRENT_DATE - ($2::int * INTERVAL '1 month'))
       WHERE m.property_id = $1 AND m.billing_method IN ('submeter', 'rubs')
       ORDER BY m.utility_type, m.label, r.reading_date DESC NULLS LAST, r.created_at DESC NULLS LAST`,
      [propertyId, months])
    const byMeter = new Map<string, any>()
    for (const r of rows) {
      if (!byMeter.has(r.meter_id)) {
        byMeter.set(r.meter_id, {
          meterId: r.meter_id, label: r.label, utilityType: r.utility_type, billingMethod: r.billing_method,
          digits: Number(r.digits) || 6, outOfService: r.out_of_service, unitNumbers: r.unit_numbers, readings: [],
        })
      }
      if (!r.reading_id) continue
      const value = Number(r.reading_value)
      const prior = r.prior_value != null ? Number(r.prior_value) : null
      // A master's number IS the cycle's usage; a submeter's usage is the turn
      // since the read before it (a rollover or a swap shows no figure rather
      // than a negative one).
      const usage = r.billing_method === 'rubs' ? value
        : prior == null || value < prior ? null
        : Math.round((value - prior) * Number(r.reading_multiplier) * 1000) / 1000
      byMeter.get(r.meter_id).readings.push({
        id: r.reading_id, date: r.reading_date, cycleMonth: r.cycle_month, value, usage,
        reason: r.reason, note: r.reason_note, needsReview: r.needs_review, isRollover: r.is_rollover, hasPhoto: r.has_photo,
      })
    }
    const meters = [...byMeter.values()].sort((a, b) =>
      String(a.unitNumbers ?? a.label).localeCompare(String(b.unitNumbers ?? b.label), undefined, { numeric: true, sensitivity: 'base' })
      || String(a.utilityType).localeCompare(String(b.utilityType)))
    res.json({ success: true, data: { months, meters } })
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
    // 10/12 (review): held to the properties a team member is scoped to (see PATCH /meters/:id).
    await assertPropertyInScope(req.user, meter.property_id)
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
    // 10/12 (review): held to the properties a team member is scoped to (see PATCH /meters/:id).
    await assertPropertyInScope(req.user, meter.property_id)
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
    // 10/12 (review): a team member held to some properties acts only on those
    // properties, as every other meter write path requires (assertPropertyInScope).
    await assertPropertyInScope(req.user, property.id)
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
    // 10/12 (review): held to the properties a team member is scoped to (see PATCH /meters/:id).
    await assertPropertyInScope(req.user, meter.property_id)

    const reading = await queryOne<any>(
      `SELECT * FROM utility_meter_readings WHERE id = $1 AND meter_id = $2`,
      [req.params.readingId, req.params.id])
    if (!reading) throw new AppError(404, 'Reading not found on this meter')

    if (body.readingValue != null && meter.digits != null
        && body.readingValue >= meterReadingModulus(meter.digits)) {
      throw new AppError(400,
        `That is more than a ${meter.digits}-digit meter can show. Check the odometer size on the meter if the face is wider.`)
    }

    // Anything ISSUED from this read, or from the span that starts at it.
    // S652: a bill computed for the landlord's review and not yet sent is
    // not a charge anyone has seen — it is dropped and priced again from the
    // corrected read, which is the whole point of reviewing before billing.
    const { dropUnissuedBillsFrom } = await import('../services/utilityReview')
    if (!(await dropUnissuedBillsFrom(req.params.id, reading.billing_cycle_month))) {
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

utilityRouter.get('/reading-runs', requireMeterReader, async (req, res, next) => {
  try {
    const propertyId = z.string().uuid().parse(req.query.propertyId)
    const property = await queryOne<any>(
      `SELECT id, landlord_id FROM properties WHERE id = $1`, [propertyId])
    if (!property) throw new AppError(404, 'Property not found')
    await assertMeterReadAccess(req.user, propertyId, property.landlord_id)
    const runs = await query<any>(
      `SELECT r.*,
              -- S652: does this company hold the month for the landlord's approval?
              (SELECT l.review_utility_bills FROM landlords l WHERE l.id = r.landlord_id) AS needs_approval,
              (SELECT COUNT(*)::int FROM utility_meters m
                WHERE m.property_id = r.property_id
                  AND m.billing_method IN ('submeter','rubs')) AS meters_total,
              (SELECT COUNT(*)::int FROM utility_meters m
                 JOIN utility_meter_readings rd
                   ON rd.meter_id = m.id AND rd.billing_cycle_month = r.billing_cycle_month
                  AND rd.reason = 'monthly_cycle'
                WHERE m.property_id = r.property_id
                  AND m.billing_method IN ('submeter','rubs')) AS meters_read,
              -- S652: reads flagged for the landlord's review this cycle — the
              -- one thing a fully-read run can still be waiting on.
              (SELECT COUNT(*)::int FROM utility_meters m
                 JOIN utility_meter_readings rd
                   ON rd.meter_id = m.id AND rd.billing_cycle_month = r.billing_cycle_month
                  AND rd.reason = 'monthly_cycle' AND rd.needs_review
                WHERE m.property_id = r.property_id
                  AND m.billing_method IN ('submeter','rubs')
                  AND (r.utility_type IS NULL OR m.utility_type = r.utility_type)) AS flagged_count
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
utilityRouter.post('/reading-runs', requireMeterReader, async (req, res, next) => {
  try {
    const body = z.object({
      propertyId: z.string().uuid(),
      cycleMonth: z.string().regex(/^\d{4}-\d{2}-01$/, 'cycleMonth must be YYYY-MM-01').optional(),
      // S631: open a run for ONE utility so it bills as soon as its own reads
      // are in. Omitted = every readable meter, the original behavior.
      utilityType: z.string().min(1).max(40).optional(),
    }).parse(req.body)
    const property = await queryOne<any>(
      `SELECT id, landlord_id FROM properties WHERE id = $1`, [body.propertyId])
    if (!property) throw new AppError(404, 'Property not found')
    await assertMeterReadAccess(req.user, body.propertyId, property.landlord_id)
    const cycle = body.cycleMonth
      ?? new Date().toISOString().slice(0, 7) + '-01'
    const run = await openReadingRun(body.propertyId, cycle,
      { notify: false, utilityType: body.utilityType ?? null })
    if (!run) {
      throw new AppError(400, body.utilityType
        ? `This property has no readable ${body.utilityType} meters (submeter or RUBS).`
        : 'Property has no readable meters (submeter or RUBS)')
    }
    res.status(201).json({ success: true, data: run })
  } catch (e) { next(e) }
})

// Guided-walk payload: every readable meter with unit, prior reading,
// this-cycle reading (if entered) and whether a lease makes the tenant
// responsible (the auto-calc/bill preview).
utilityRouter.get('/reading-runs/:id/meters', requireMeterReader, async (req, res, next) => {
  try {
    const run = await queryOne<any>(
      `SELECT * FROM utility_reading_runs WHERE id = $1`, [req.params.id])
    if (!run) throw new AppError(404, 'Reading run not found')
    await assertMeterReadAccess(req.user, run.property_id, run.landlord_id)
    res.json({ success: true, data: await getRunMeters(req.params.id) })
  } catch (e) { next(e) }
})

// Enter one meter's reading inside a run. Cycle comes from the run —
// the reader never picks dates. Auto-completes the run (generate +
// finalize bills) when this was the last unread meter.
// ── S652: THE METER FACE ────────────────────────────────────────────────────
// Nic: "add the option for the maintenance person to take a picture of each
// meter for historical accuracy." Anyone who may read the meter may photograph
// it — no separate permission. The photo lands beside the reading it belongs
// to (this cycle's monthly read, if it already exists) and is served only to
// people who could see the reading.
const meterPhotoDir = path.join(process.cwd(), 'uploads', 'meters')
if (!fs.existsSync(meterPhotoDir)) fs.mkdirSync(meterPhotoDir, { recursive: true })
const meterPhotoUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, meterPhotoDir),
    filename: (_req, file, cb) => cb(null, `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${(path.extname(file.originalname).toLowerCase() || '.jpg')}`),
  }),
  limits: { fileSize: 12 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (/^image\/(jpeg|png|webp|heic)$/.test(file.mimetype)) cb(null, true)
    else cb(new AppError(400, 'A photo (JPEG, PNG, WebP or HEIC) is required'))
  },
})
utilityRouter.post('/reading-runs/:id/meters/:meterId/photo', requireMeterReader, meterPhotoUpload.single('file'), async (req: any, res, next) => {
  try {
    if (!req.file) throw new AppError(400, 'No photo uploaded')
    const run = await queryOne<any>(`SELECT * FROM utility_reading_runs WHERE id = $1`, [req.params.id])
    if (!run) throw new AppError(404, 'Reading run not found')
    await assertMeterReadAccess(req.user, run.property_id, run.landlord_id)
    const meter = await queryOne<{ id: string }>(`SELECT id FROM utility_meters WHERE id = $1 AND property_id = $2`, [req.params.meterId, run.property_id])
    if (!meter) throw new AppError(404, 'Meter not found on this run')
    const url = `/uploads/meters/${req.file.filename}`
    // A reading already taken this cycle gets the photo now; otherwise the
    // reading that follows carries it in.
    const attached = await queryOne<{ id: string }>(
      `UPDATE utility_meter_readings SET photo_url = $3
        WHERE meter_id = $1 AND billing_cycle_month = $2 AND reason = 'monthly_cycle' RETURNING id`,
      [meter.id, run.billing_cycle_month, url])
    res.status(201).json({ success: true, data: { url, attachedToReadingId: attached?.id ?? null } })
  } catch (e) { next(e) }
})
utilityRouter.get('/readings/:id/photo', async (req: any, res, next) => {
  try {
    const r = await queryOne<any>(
      `SELECT r.photo_url, m.property_id, p.landlord_id FROM utility_meter_readings r
         JOIN utility_meters m ON m.id = r.meter_id JOIN properties p ON p.id = m.property_id WHERE r.id = $1`, [req.params.id])
    if (!r?.photo_url) throw new AppError(404, 'No photo on this reading')
    await assertMeterReadAccess(req.user, r.property_id, r.landlord_id)
    streamStoredFile(res, r.photo_url)
  } catch (e) { next(e) }
})

utilityRouter.post('/reading-runs/:id/meters/:meterId/reading', requireMeterReader, async (req, res, next) => {
  try {
    // Reads are odometer values; the digit width is per-meter (landlord
    // setting). Bounds are checked against the meter's own capacity
    // after the meter row is fetched below.
    const body = z.object({
      readingValue: z.number().int().min(0),
      // S607: a RUBS master on the bill_amount basis also carries the utility
      // provider's dollar charge for the cycle. Ignored on every other meter.
      billAmount: z.number().min(0).max(10_000_000).optional(),
      // S631 (Nic): "I don't want two people reading meters and accidentally
      // overwriting each other by typoing on a spot that was already done."
      // Replacing somebody else's read is a deliberate act, never a side effect
      // of a stray keystroke on the wrong row.
      replace: z.boolean().optional(),
      // S652: the meter face, uploaded a moment earlier via .../photo.
      photoUrl: z.string().regex(/^\/uploads\/meters\/[A-Za-z0-9._-]+$/).optional(),
    }).parse(req.body)
    const run = await queryOne<any>(
      `SELECT * FROM utility_reading_runs WHERE id = $1`, [req.params.id])
    if (!run) throw new AppError(404, 'Reading run not found')
    await assertMeterReadAccess(req.user, run.property_id, run.landlord_id)
    if (run.status !== 'open') throw new AppError(409, 'Reading run is already completed')
    // S652 (Nic): "set it at the property level" — a property that requires
    // the photo will not take a number without one (a photo already on this
    // cycle's reading counts, so a re-read after a photo is not asked twice).
    const propPhoto = await queryOne<{ meter_photo_required: boolean }>(
      `SELECT meter_photo_required FROM properties WHERE id = $1`, [run.property_id])
    if (propPhoto?.meter_photo_required && !body.photoUrl) {
      const already = await queryOne<{ id: string }>(
        `SELECT id FROM utility_meter_readings WHERE meter_id = $1 AND billing_cycle_month = $2 AND reason = 'monthly_cycle' AND photo_url IS NOT NULL`,
        [req.params.meterId, run.billing_cycle_month])
      if (!already) throw new AppError(400, 'This property requires a photo of the meter face with every reading — take the photo, then enter the number.')
    }
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
    // S648 (Nic): a tenant billed on their own day is read the last business
    // day before it. Reading early would cut their period short and push the
    // difference onto next month's bill.
    if (meter.billing_method === 'submeter') {
      const { getRunMeters } = await import('../services/utilityReadingRuns')
      const row = (await getRunMeters(run.id)).find((x: any) => x.meter_id === meter.id && x.not_yet)
      if (row) {
        throw new AppError(409,
          `${row.unit_number || meter.label} is read on ${row.read_by}, the last business day before that tenant's due date.`)
      }
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

    // S631: this cycle's read already exists. Same person correcting their own
    // typo passes straight through — they are fixing their own work, which is
    // what the ON CONFLICT below is for. SOMEBODY ELSE's read is refused unless
    // the caller says explicitly that they mean to replace it, because the whole
    // point of a shared list is that two people work it at once and neither
    // silently undoes the other.
    const priorRead = await queryOne<{ created_by_user_id: string; reading_value: string }>(
      `SELECT created_by_user_id, reading_value::text AS reading_value
         FROM utility_meter_readings
        WHERE meter_id = $1 AND billing_cycle_month = $2 AND reason = 'monthly_cycle'`,
      [meter.id, run.billing_cycle_month])
    if (priorRead && priorRead.created_by_user_id !== req.user!.userId && !body.replace) {
      const who = await queryOne<{ name: string }>(
        `SELECT NULLIF(BTRIM(COALESCE(first_name,'') || ' ' || COALESCE(last_name,'')), '') AS name
           FROM users WHERE id = $1`, [priorRead.created_by_user_id])
      throw new AppError(409,
        `${who?.name || 'Someone else'} already recorded this meter for this cycle. ` +
        `Refresh to see the current list — nothing was changed.`)
    }

    const reading = await queryOne<any>(
      `INSERT INTO utility_meter_readings
         (meter_id, reading_date, reading_value, billing_cycle_month, created_by_user_id,
          needs_review, review_note, is_rollover, reason, bill_amount, photo_url)
       VALUES ($1, CURRENT_DATE, $2, $3, $4, $5, $6, $7, 'monthly_cycle', $8, $9)
       ON CONFLICT (meter_id, billing_cycle_month) WHERE reason = 'monthly_cycle'
       DO UPDATE SET photo_url = COALESCE(EXCLUDED.photo_url, utility_meter_readings.photo_url),
                     reading_value = EXCLUDED.reading_value,
                     reading_date = EXCLUDED.reading_date,
                     created_by_user_id = EXCLUDED.created_by_user_id,
                     needs_review = EXCLUDED.needs_review,
                     review_note = EXCLUDED.review_note,
                     is_rollover = EXCLUDED.is_rollover,
                     bill_amount = EXCLUDED.bill_amount
       RETURNING id, meter_id, billing_cycle_month`,
      [meter.id, body.readingValue, run.billing_cycle_month, req.user!.userId,
       needsReview, reviewNote, isRollover, isDollarMaster ? body.billAmount : null, body.photoUrl ?? null])

    // S652 (Nic): the last meter read finishes the run — unless something is
    // flagged, in which case it waits on the landlord's ONE review window.
    // No mid-walk interruptions ever.
    let updatedRun = null
    if (await isRunFullyRead(run.id)) {
      updatedRun = await finishReadingPhase(run.id, req.user!.userId)
    }
    // Response deliberately excludes reading_value/needs_review — the walk
    // client needs only confirmation + run state (+ how many reads the
    // landlord has to look at, for the summary screen; never which ones).
    const flagged = updatedRun?.status === 'double_check' ? await countFlaggedOnRun(run.id) : 0
    // Fully read, nothing flagged, and the company reviews its bills first:
    // the run stays open until the landlord approves.
    const awaitingApproval = !!updatedRun && updatedRun.status === 'open'
    res.status(201).json({ success: true, data: { reading, run: updatedRun ?? run, flagged, awaitingApproval } })
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

// ── MASTER BILLS (S636) ──────────────────────────────────────
// S636 (Nic): "that is where I wanna see when I input my master fucking
// meters, not every person that gets charged different utilities."
//
// The property utilities tab used to end in a per-unit CHARGE ledger —
// one row per tenant per utility. That is the tenant's invoice restated
// in the landlord's setup screen, and it crowded out the only thing the
// property owner actually receives: the master bill from the provider.
// This returns one row per master reading per cycle — what the provider
// billed, what was measured, and how much of it was pushed back out to
// tenants (so the un-recovered remainder is visible at a glance).
// 10/3: owners / properties.edit only. A staffer who only reads meters reads
// them blind (S559) — past master readings and the provider's dollars are not
// theirs to see.
utilityRouter.get('/master-bills', requirePerm('properties.edit'), async (req, res, next) => {
  try {
    const propertyId = z.string().uuid().parse(req.query.propertyId)
    const property = await queryOne<{ landlord_id: string }>(
      `SELECT landlord_id FROM properties WHERE id = $1`, [propertyId])
    if (!property) throw new AppError(404, 'Property not found')
    if (!canAccessLandlordResource(req.user, property.landlord_id)) throw new AppError(403, 'Forbidden')
    await assertPropertyInScope(req.user, propertyId)
    const rows = await query<any>(`
      SELECT r.id, r.billing_cycle_month, r.reading_date, r.reading_value,
             r.bill_amount, r.reason,
             m.id AS meter_id, m.label AS meter_label, m.utility_type,
             m.billing_method, m.rubs_basis, m.rate_per_unit, m.base_fee,
             (SELECT COUNT(*) FROM utility_meter_units mu WHERE mu.meter_id = m.id) AS unit_count,
             -- 10/12: a voided bill recovered nothing — a tenancy that never
             -- happened (kept, voided_at set, its usage back on hold and billed
             -- to whoever is next) or a voided estimate / paused-cycle marker.
             -- Counting it counted the same usage twice.
             COALESCE((SELECT SUM(ub.charge_amount) FROM utility_bills ub
                        WHERE ub.meter_id = m.id
                          AND ub.billing_cycle_month = r.billing_cycle_month
                          AND ub.voided_at IS NULL AND ub.status <> 'void'), 0) AS recovered_amount,
             COALESCE((SELECT COUNT(*) FROM utility_bills ub
                        WHERE ub.meter_id = m.id
                          AND ub.billing_cycle_month = r.billing_cycle_month
                          AND ub.voided_at IS NULL AND ub.status <> 'void'), 0) AS recovered_count
        FROM utility_meter_readings r
        JOIN utility_meters m ON m.id = r.meter_id
       WHERE m.property_id = $1
         AND m.billing_method IN ('rubs','master_bill_to_landlord')
       ORDER BY r.billing_cycle_month DESC, m.utility_type ASC, m.label ASC`, [propertyId])
    res.json({ success: true, data: rows })
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
      // 10/3: the reads-due row says whose move-out this is. It only breaks a
      // tie between households the move-out rule already counts — it can never
      // put a bill on someone the rule would skip.
      leaseId: z.string().uuid().optional(),
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
    let billingNote: string | undefined
    if (body.reason === 'move_out_final') {
      // A lease from another company is ignored, never an error — the read
      // still bills by the normal rule.
      const named = body.leaseId
        ? await queryOne<{ id: string }>(
            `SELECT l.id FROM leases l JOIN units u ON u.id = l.unit_id JOIN properties p ON p.id = u.property_id
              WHERE l.id = $1 AND p.landlord_id = $2`, [body.leaseId, property.landlord_id])
        : null
      const r = await billMoveOutRead(meter.id, reading.id, { leaseId: named?.id ?? null })
      billed = r.billed
      // S639: say WHY it did not bill. Rollover refusals, an unattached meter
      // and an already-billed cycle all looked identical (a bare false) to the
      // person standing at the meter.
      if (!billed) billingNote = r.reason
    }
    // Blind response — id + reason + whether it billed (and why not), never the values.
    res.status(201).json({ success: true, data: { id: reading.id, reason: body.reason, billed, billingNote } })
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
    // 10/12 (review): a team member held to some properties acts only on those
    // properties, as every other meter write path requires (assertPropertyInScope).
    await assertPropertyInScope(req.user, reading.property_id)
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

    // S652 (Nic): "get rid of the clean meters random blind reread. Just flag
    // the ones that need flagging, with limited to one window." This IS that
    // window. A bill built on the superseded value and not yet on an invoice
    // is stale; and if this was the last flagged read on a waiting run, the
    // run completes here.
    // 10/12: never a voided bill — it is kept on record (keep everything): one
    // voided out of its slot (voided_at, a tenancy that never happened) and
    // the older void markers (a voided estimate, a paused cycle), which hold
    // their cycle so it is never billed again.
    if (body.correctedValue != null && Number(reading.reading_value) !== body.correctedValue) {
      await query(
        `DELETE FROM utility_bills WHERE meter_id = $1 AND billing_cycle_month = $2 AND payment_id IS NULL
            AND voided_at IS NULL AND status <> 'void'`,
        [reading.meter_id, reading.billing_cycle_month])
    }
    const cycleIso = reading.billing_cycle_month instanceof Date
      ? `${reading.billing_cycle_month.getFullYear()}-${String(reading.billing_cycle_month.getMonth() + 1).padStart(2, '0')}-${String(reading.billing_cycle_month.getDate()).padStart(2, '0')}`
      : String(reading.billing_cycle_month).slice(0, 10)
    const walkRun = await settleFlaggedOnRun(reading.property_id, cycleIso, req.user!.userId)

    // If this cycle's run already completed, the flagged meter was
    // skipped by the engine (negative usage) — re-run it now.
    let billsCreated = 0
    const run = walkRun ? null : await queryOne<any>(
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
    res.json({ success: true, data: { reading: updated, billsCreated, run: walkRun } })
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
    // 10/12 (review): a team member held to some properties acts only on those
    // properties, as every other meter write path requires (assertPropertyInScope).
    await assertPropertyInScope(req.user, run.property_id)
    if (run.status === 'completed') throw new AppError(409, 'Reading run is already completed')
    // S652: the landlord completing the run IS the approval of its bills.
    const completed = await completeReadingRun(run.id, req.user!.userId, { approve: true })
    res.json({ success: true, data: completed })
  } catch (e) { next(e) }
})

// ── S652: REVIEW THE BILLS BEFORE THEY GO OUT ─────────────────
// Blu: see what everybody will owe, fix a fat-fingered read, then approve.

utilityRouter.get('/reading-runs/:id/review', requirePerm('properties.edit'), async (req, res, next) => {
  try {
    const run = await queryOne<any>(`SELECT landlord_id FROM utility_reading_runs WHERE id = $1`, [req.params.id])
    if (!run) throw new AppError(404, 'Reading run not found')
    if (!canManageLandlordResource(req.user, run.landlord_id)) throw new AppError(403, 'Forbidden')
    const { billReview } = await import('../services/utilityReview')
    res.json({ success: true, data: await billReview(req.params.id) })
  } catch (e) { next(e) }
})

utilityRouter.post('/reading-runs/:id/approve', requirePerm('properties.edit'), async (req, res, next) => {
  try {
    const run = await queryOne<any>(`SELECT * FROM utility_reading_runs WHERE id = $1`, [req.params.id])
    if (!run) throw new AppError(404, 'Reading run not found')
    if (!canManageLandlordResource(req.user, run.landlord_id)) throw new AppError(403, 'Forbidden')
    // 10/12 (review): a team member held to some properties acts only on those
    // properties, as every other meter write path requires (assertPropertyInScope).
    await assertPropertyInScope(req.user, run.property_id)
    if (run.status === 'completed') throw new AppError(409, 'These bills already went out')
    // A reading still flagged as a possible typo bills nothing and holds only
    // its own unit's invoice (S534) — it never holds the park (Nic).
    const done = await completeReadingRun(run.id, req.user!.userId, { approve: true })
    res.json({ success: true, data: { ...done, flagged: await countFlaggedOnRun(run.id) } })
  } catch (e) { next(e) }
})

// Every read at a property as a spreadsheet — one row per meter, a reading and
// a usage column per month (Nic: "your sites and your reads at different dates
// for total evaluation history of overall utility usage"). CSV opens in Excel.
utilityRouter.get('/readings/export', requirePerm('properties.edit', 'units.view_status'), async (req, res, next) => {
  try {
    const propertyId = z.string().uuid().parse(req.query.propertyId)
    const prop = await queryOne<any>(`SELECT name, landlord_id FROM properties WHERE id = $1`, [propertyId])
    if (!prop || !canAccessLandlordResource(req.user, prop.landlord_id)) throw new AppError(404, 'Property not found')
    const reads = await query<any>(`
      SELECT m.id AS meter_id, m.label, m.utility_type, m.digits, COALESCE(m.reading_multiplier, 1) AS mult,
             (SELECT string_agg(u.unit_number, ' / ' ORDER BY u.unit_number) FROM utility_meter_units mu
                JOIN units u ON u.id = mu.unit_id WHERE mu.meter_id = m.id) AS sites,
             to_char(rd.billing_cycle_month, 'YYYY-MM') AS month, rd.reading_date, rd.reading_value, rd.is_rollover, rd.reason
        FROM utility_meters m
        JOIN utility_meter_readings rd ON rd.meter_id = m.id
       WHERE m.property_id = $1
       ORDER BY m.utility_type, sites NULLS LAST, m.label, rd.reading_date, rd.created_at`, [propertyId])
    const months = [...new Set(reads.filter(r => r.reason === 'monthly_cycle').map(r => r.month))].sort()
    type Row = { sites: string; label: string; type: string; byMonth: Map<string, { read: number; usage: number | null }> }
    const meters = new Map<string, Row>()
    const lastRead = new Map<string, any>()
    for (const r of reads) {
      let row = meters.get(r.meter_id)
      if (!row) meters.set(r.meter_id, row = { sites: r.sites ?? '', label: r.label ?? '', type: r.utility_type, byMonth: new Map() })
      const prev = lastRead.get(r.meter_id)
      lastRead.set(r.meter_id, r)
      if (r.reason !== 'monthly_cycle') continue
      const cur = Number(r.reading_value)
      let usage: number | null = null
      if (prev) {
        const mod = Math.pow(10, Number(r.digits) || 7)
        const diff = cur >= Number(prev.reading_value) ? cur - Number(prev.reading_value)
          : (r.is_rollover ? cur + mod - Number(prev.reading_value) : null)
        usage = diff == null ? null : Math.round(diff * Number(r.mult) * 100) / 100
      }
      row.byMonth.set(r.month, { read: cur, usage })
    }
    const esc = (v: any) => { const t = v == null ? '' : String(v); return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t }
    const header = ['Site', 'Meter', 'Utility', ...months.flatMap(m => [`${m} reading`, `${m} usage`])]
    const lines = [header.map(esc).join(',')]
    for (const row of meters.values()) {
      lines.push([row.sites, row.label, row.type,
        ...months.flatMap(m => { const c = row.byMonth.get(m); return [c?.read ?? '', c?.usage ?? ''] })].map(esc).join(','))
    }
    const file = `${String(prop.name).replace(/[^A-Za-z0-9]+/g, '-')}-meter-readings.csv`
    res.setHeader('Content-Type', 'text/csv; charset=utf-8')
    res.setHeader('Content-Disposition', `attachment; filename="${file}"`)
    res.send('\ufeff' + lines.join('\r\n'))
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
      // 10/12 (review): a team member held to some properties acts only on those
      // properties, as every other meter write path requires (assertPropertyInScope).
      await assertPropertyInScope(req.user, meter.property_id)
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
      await assertPropertyInScope(req.user, property.id)
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
    // 10/12 (review): every property of the company is more than a team member
    // held to some of them may bill — they choose one of theirs.
    if ((await getScopedPropertyIds(req.user)) !== null) {
      throw new AppError(400, 'Choose one of your properties to generate its utility bills.')
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
    const bill = await queryOne<{ id: string; landlord_id: string; status: string; property_id: string | null }>(
      `SELECT ub.id, ub.landlord_id, ub.status, COALESCE(m.property_id, u.property_id) AS property_id
         FROM utility_bills ub
         LEFT JOIN utility_meters m ON m.id = ub.meter_id
         LEFT JOIN units u ON u.id = ub.unit_id
        WHERE ub.id=$1`, [req.params.id]
    )
    if (!bill) throw new AppError(404, 'Utility bill not found')
    if (!canAccessLandlordResource(req.user, bill.landlord_id)) {
      throw new AppError(403, 'Forbidden')
    }
    // 10/12 (review): a team member held to some properties acts only on those
    // properties, as every other meter write path requires (assertPropertyInScope).
    await assertPropertyInScope(req.user, bill.property_id)
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
// rows linked via invoice_id. Tenants pay them with the rest of the bill
// through POST /api/payments/pay-balance (S655: the one-row /payments/:id/pay
// is retired too); the S122 webhook handler still flips
// utility_bills.status='paid' on settlement.
//
// This handler returns 410 Gone with a pointer to the new path. Kept
// registered so any cached frontend or third-party integration calling
// the old route gets a clean error rather than a 404.
utilityRouter.post('/bills/:id/pay', async (req: any, _res, next) => {
  try {
    if (req.user!.role !== 'tenant') {
      throw new AppError(403, 'Only tenants can call this endpoint')
    }
    // Look up the linked invoice payment: a bill not yet on an invoice gets
    // its own answer (it will be on the next one).
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
      'This endpoint was retired. Utilities are a line on the rent bill now — pay the whole bill with POST /api/payments/pay-balance (Pay Now on the Payments page).',
    )
  } catch (e) { next(e) }
})

// ── S605 (Nic, DIRECTIVE): PROPERTY-LEVEL UTILITY RATES ─────────────────────
// "Make utility rates set at the property level. Adding each unit is redundant
// and possible discrimination."
//
// Pricing is policy, decided once per property per utility, not per tenant. The
// billing engine reads these and they override the meter columns — so two
// neighbors on the same water main cannot be charged different rates because
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
    // 10/12 (review): a team member held to some properties acts only on those
    // properties, as every other meter write path requires (assertPropertyInScope).
    await assertPropertyInScope(req.user, property.id)

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

// POST /api/utility/opening-reads
//
// S632 (Nic, DIRECTIVE): "On the onboarding flow, we should treat all opening
// reads as read at the same date. So I should select one date for my opening
// reads and not have to select it on all fifty three meters or potentially a
// hundred meters per property. That's just really tedious to input every time."
//
// He is describing what actually happens on the ground: somebody walks the park
// once, on one afternoon, and writes the starting number beside every space. The
// date is a property of the WALK, not of each meter — asking for it 53 times is
// asking the same question 53 times and inviting 53 chances to answer it
// differently.
//
// One date, many meters, one call. Partial success is reported rather than
// rolled back: a walk that got 51 of 53 should keep the 51, because the two that
// failed are a transcription problem to fix, not a reason to re-enter fifty-one
// correct numbers.
utilityRouter.post('/opening-reads', requirePerm('properties.edit'), async (req, res, next) => {
  try {
    const body = z.object({
      propertyId:  z.string().uuid(),
      // The one date the walk happened. Every read lands on it.
      readingDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      reads: z.array(z.object({
        meterId: z.string().uuid(),
        value:   z.number().nonnegative(),
      })).min(1).max(500),
    }).parse(req.body)

    const property = await queryOne<{ id: string; landlord_id: string }>(
      `SELECT id, landlord_id FROM properties WHERE id = $1`, [body.propertyId])
    if (!property) throw new AppError(404, 'Property not found')
    if (!canManageLandlordResource(req.user, property.landlord_id)) throw new AppError(403, 'Forbidden')
    // 10/12 (review): a team member held to some properties acts only on those
    // properties, as every other meter write path requires (assertPropertyInScope).
    await assertPropertyInScope(req.user, property.id)

    const cycleMonth = body.readingDate.slice(0, 7) + '-01'
    const results: { meterId: string; label: string; status: string; message?: string }[] = []

    for (const r of body.reads) {
      const meter = await queryOne<any>(
        `SELECT id, label, digits, property_id FROM utility_meters WHERE id = $1`, [r.meterId])
      if (!meter || meter.property_id !== body.propertyId) {
        results.push({ meterId: r.meterId, label: meter?.label ?? '(unknown)',
          status: 'error', message: 'That meter is not at this property.' })
        continue
      }
      // A read wider than the face is a typed digit too many — the exact
      // mistake that made 227200 out of 27200 on Oak Park's MH 07.
      if (meter.digits != null && r.value >= meterReadingModulus(meter.digits)) {
        results.push({ meterId: r.meterId, label: meter.label, status: 'error',
          message: `More than a ${meter.digits}-digit meter can show.` })
        continue
      }
      try {
        // Re-running the walk corrects it rather than stacking a second opening
        // read: there is only ever one starting number per meter.
        const existing = await queryOne<{ id: string }>(
          `SELECT id FROM utility_meter_readings
            WHERE meter_id = $1 AND reason = 'baseline'`, [r.meterId])
        if (existing) {
          await query(
            `UPDATE utility_meter_readings
                SET reading_value = $2, reading_date = $3::date,
                    billing_cycle_month = $4::date, created_by_user_id = $5
              WHERE id = $1`,
            [existing.id, r.value, body.readingDate, cycleMonth, req.user!.userId])
          results.push({ meterId: r.meterId, label: meter.label, status: 'updated' })
        } else {
          await query(
            `INSERT INTO utility_meter_readings
               (meter_id, reading_date, reading_value, billing_cycle_month, reason, created_by_user_id)
             VALUES ($1,$2::date,$3,$4::date,'baseline',$5)`,
            [r.meterId, body.readingDate, r.value, cycleMonth, req.user!.userId])
          results.push({ meterId: r.meterId, label: meter.label, status: 'saved' })
        }
      } catch (e: any) {
        results.push({ meterId: r.meterId, label: meter.label, status: 'error',
          message: e?.message || 'Could not save' })
      }
    }

    const saved = results.filter(x => x.status === 'saved' || x.status === 'updated').length
    const failed = results.filter(x => x.status === 'error')
    const stillMissing = await queryOne<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM utility_meters m
        WHERE m.property_id = $1 AND m.billing_method = 'submeter'
          AND NOT EXISTS (SELECT 1 FROM utility_meter_readings r WHERE r.meter_id = m.id)`,
      [body.propertyId])

    res.json({ success: true, data: {
      readingDate: body.readingDate, saved, failed: failed.length,
      stillNeedAnOpeningRead: Number(stillMissing?.n ?? 0),
      results,
    } })
  } catch (e) { next(e) }
})
