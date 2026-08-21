import { Router } from 'express'
import { z } from 'zod'
import { db, query, queryOne } from '../db'
import { requireAuth, requireLandlord, requirePerm, getScopedPropertyIds, assertPropertyInScope } from '../middleware/auth'
import { canAccessLandlordResource, canManageLandlordResource, canViewLandlordFinances } from '../middleware/scope'
import { AppError } from '../middleware/errorHandler'
import { canonicalUnitNumber, UNIT_TYPE_PREFIX } from '@gam/shared'
import { UTILITY_TYPES, UnitStatus, calcNetPerUnit, getReservePhase, LAUNCH_PLATFORM_FEE, UNIT_STATUSES, UNIT_TYPES, computeStayPrice, computeMonthlyStaySchedule, RV_SITE_LAYOUTS, RV_AMP_SERVICES, isSiteLayoutMismatch, isAmpServiceMismatch, SHORT_STAY_LOCKED_UNIT_TYPES, DWELLING_OWNERSHIP_VALUES, OCCUPANCY_MODES, FLOOR_LEVELS, MAX_INSPECTION_LIVING_AREAS, UNIT_FEATURE_CATALOG, dayDiff } from '@gam/shared'
import { findStayConflict, findAvailableUnits, STAY_CONFLICT_MESSAGE } from '../services/unitAvailability'
import { formatUnitNumber } from '../lib/format'
import { logger } from '../lib/logger'
import { promoteNextWaitlister } from '../services/propertyBooking'
import { linkUnitToSubtype } from '../services/unitSubtype'
import { recordBookingEvent, recordBookingChange } from '../services/bookingEvents'
import { maybeDraftLeaseFromBooking } from '../services/bookingLeaseDraft'
import { unitPendingReads } from '../services/utilityReadingRuns'
import { syncLeaseWithBookingDates } from '../services/bookingLeaseBilling'
import { assertLateFeeDecision } from '../services/lateFeePolicy'
import {
  sendBookingGuestAccessEmail,
  issueBookingGuestToken,
  bookingGuestQrDataUrl,
  revokeBookingGuestTokens,
} from '../services/bookingGuestTokens'

export const unitsRouter = Router()
unitsRouter.use(requireAuth)

// GET /api/units  — landlord sees their units, admin sees all
unitsRouter.get('/', async (req, res, next) => {
  try {
    const isSuper = req.user!.role === 'super_admin'
    const isAdmin = req.user!.role === 'admin' || isSuper
    const params: any[] = []
    // S400 fix: pre-fix used req.user.profileId unconditionally, which is the
    // landlord_id for role=landlord but the user_id for team roles (PM /
    // maintenance_worker / onsite_manager). Team members got an empty list
    // because user_id never matches units.landlord_id. Resolve to landlordId
    // for team members. Same pattern as credit.ts (line 109).
    const callerLandlordId = req.user!.role === 'landlord'
      ? req.user!.profileId
      : req.user!.landlordId
    // S567 portfolio scoping: super sees all; a regular admin (portfolio
    // manager) sees only units under landlords they close or service; a
    // landlord/team member sees only their own.
    let landlordFilter = ''
    if (!isAdmin) {
      landlordFilter = `AND u.landlord_id = $${params.push(callerLandlordId)}`
    } else if (!isSuper) {
      const i = params.push(req.user!.userId)
      landlordFilter = `AND u.landlord_id IN (SELECT id FROM landlords WHERE portfolio_manager_id = $${i} OR service_manager_id = $${i})`
    }
    const propertyFilter = req.query.propertyId
      ? `AND u.property_id = $${params.push(req.query.propertyId)}`
      : ''
    // S605: retired units are EXCLUDED by default — fail-closed. Any frontend
    // that feeds a dropdown from this endpoint would otherwise silently offer a
    // unit the server will refuse to lease or book, and a long-lived park would
    // accumulate retired rows in its working list forever. Surfaces that show
    // history (the Units page, reports) opt in explicitly.
    const retiredFilter = req.query.includeRetired === 'true' ? '' : 'AND u.retired_at IS NULL'
    const units = await query<any>(`
      SELECT u.*,
        p.name AS property_name, p.street1, p.city, p.state, p.zip,
        vuo.primary_tenant_id AS tenant_id,
        vuo.primary_first_name AS tenant_first,
        vuo.primary_last_name AS tenant_last,
        vuo.primary_email AS tenant_email,
        vuo.tenant_count,
        -- S554 (button-sweep bug #10): the admin-ops Units panel reads
        -- achVerified for the primary tenant's ACH badge; without this the
        -- field was always undefined and the badge stuck on "Pending".
        pt.ach_verified,
        -- S613 (Nic): how many people have ALREADY been invited to this unit and
        -- have not finished a lease yet. v_unit_occupancy only knows about an
        -- ACTIVE tenancy, so a unit with an invite out still looked free — and
        -- inviting thirty households in one sitting, that is how the same space
        -- gets offered to two of them.
        (SELECT COUNT(*)::int FROM pending_lease_drafts pld
          WHERE pld.unit_id = u.id AND pld.resolved_at IS NULL) AS pending_invite_count
      FROM units u
      JOIN properties p ON p.id = u.property_id
      LEFT JOIN v_unit_occupancy vuo ON vuo.unit_id = u.id
      LEFT JOIN tenants pt ON pt.id = vuo.primary_tenant_id
      WHERE 1=1 ${landlordFilter} ${propertyFilter} ${retiredFilter}
      ORDER BY p.name, u.unit_number
    `, params)
    res.json({ success: true, data: units })
  } catch (e) { next(e) }
})

// GET /api/units/available — W-19/W-48 (S529): the ONE availability surface.
// Free-for-window units (no overlapping non-cancelled booking / active lease
// via services/unitAvailability) with optional RV-requirement filtering, so
// pickers offer only units the server would actually accept. Registered
// BEFORE /:id so the literal path wins the match.
unitsRouter.get('/available', async (req, res, next) => {
  try {
    const q = z.object({
      checkIn:            z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      checkOut:           z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
      excludeBookingId:   z.string().uuid().nullish(),
      requiredSiteLayout: z.enum(RV_SITE_LAYOUTS as unknown as [string, ...string[]]).nullish(),
      requiredAmpService: z.enum(RV_AMP_SERVICES as unknown as [string, ...string[]]).nullish(),
      propertyId:         z.string().uuid().nullish(),
    }).parse(req.query)
    const callerLandlordId = req.user!.role === 'landlord'
      ? req.user!.profileId
      : req.user!.landlordId
    if (!callerLandlordId) throw new AppError(403, 'Forbidden')
    const scopedIds = await getScopedPropertyIds(req.user)
    const rows = await findAvailableUnits({
      landlordId: callerLandlordId,
      window: {
        checkIn: q.checkIn || new Date().toISOString().slice(0, 10),
        checkOut: q.checkOut ?? null,
        excludeBookingId: q.excludeBookingId ?? null,
      },
      propertyId: q.propertyId ?? null,
      scopedPropertyIds: scopedIds,
    })
    const data = rows.filter(u =>
      !isSiteLayoutMismatch(q.requiredSiteLayout, u.rv_site_layout) &&
      !isAmpServiceMismatch(q.requiredAmpService, u.rv_amp_service))
    res.json({ success: true, data })
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
        vuo.primary_first_name AS tenant_first,
        vuo.primary_last_name AS tenant_last,
        vuo.primary_email AS tenant_email,
        vuo.primary_phone AS tenant_phone,
        vuo.primary_tenant_id AS tenant_id,
        vuo.tenant_count,
        -- S573: unit settings lock while a lease is active/pending (rent is
        -- committed to the signed doc). Free to edit only between leases.
        EXISTS (SELECT 1 FROM leases le WHERE le.unit_id = u.id
                  AND le.status IN ('active','pending')) AS has_active_lease,
        -- S613: the unit's subtype, so the page can SHOW what class this space
        -- is. subtype_id has been stored since S527 and displayed nowhere.
        st.name AS subtype_name,
        -- S613: which utilities THIS unit's active lease actually makes the
        -- tenant responsible for. Nothing bills without it and it fails
        -- SILENTLY — the run just reports unitsSkipped — so the unit page has to
        -- be able to say "you configured this and it will still bill nobody".
        -- Written at e-sign from the lease's own tags; there is no other writer,
        -- because the lease is what a tenant agreed to pay.
        (SELECT COALESCE(array_agg(lur.utility_type), '{}')
           FROM lease_utility_responsibilities lur
           JOIN leases lz ON lz.id = lur.lease_id
          WHERE lz.unit_id = u.id AND lz.status = 'active'
            AND lur.tenant_responsible) AS tenant_billed_utilities
      FROM units u
      LEFT JOIN property_unit_subtypes st ON st.id = u.subtype_id
      JOIN properties p ON p.id = u.property_id
      JOIN landlords l ON l.id = u.landlord_id
      JOIN users ul ON ul.id = l.user_id
      LEFT JOIN v_unit_occupancy vuo ON vuo.unit_id = u.id
      LEFT JOIN tenants te ON te.id = vuo.primary_tenant_id
      WHERE u.id = $1`, [req.params.id])
    if (!unit) throw new AppError(404, 'Unit not found')
    if (!canAccessLandlordResource(req.user, unit.landlord_id)) {
      throw new AppError(403, 'Forbidden')
    }
    res.json({ success: true, data: unit })
  } catch (e) { next(e) }
})

// POST /api/units
unitsRouter.post('/', requirePerm('properties.add_unit'), async (req, res, next) => {
  try {
    // S526: units are created WITH their type + attributes (RV layout/amp,
    // bedrooms). S527: subtypeId prefills type/facts/pricing from the owner's
    // named subtype (body fields override), and quantity creates a numbered
    // batch — this replaces the removed POST /properties/:id/units/bulk, so
    // there is ONE door for creating units.
    const body = z.object({
      propertyId:      z.string().uuid(),
      unitNumber:      z.string(),
      subtypeId:       z.string().uuid().nullable().optional(),
      quantity:        z.number().int().min(1).max(200).default(1),
      // S604 (Nic): real parks have signage the software must match, not the
      // other way round. Oak Park runs RV 1-3, apartments 4-5, motel 6-12,
      // apartments 13-19, then RV 20-36 — the second RV block cannot be created
      // by "continue after the highest", which would produce RV 04. startAt lets
      // the landlord name a block to match the ground.
      startAt:         z.number().int().min(1).max(100000).optional(),
      // S605: IGNORED — padding is fixed at 2 platform-wide. Kept in the schema
      // only so an older client sending it doesn't get a validation error.
      padWidth:        z.number().int().min(1).max(6).optional(),
      unitType:        z.enum(UNIT_TYPES as unknown as [string, ...string[]]).optional(),
      bedrooms:        z.number().int().min(0).optional(),
      bathrooms:       z.number().min(0).optional(),
      sqft:            z.number().int().nullable().optional(),
      rentAmount:      z.number().positive().optional(),
      securityDeposit: z.number().min(0).optional(),
      rvSiteLayout:    z.enum(RV_SITE_LAYOUTS as unknown as [string, ...string[]]).optional(),
      rvAmpService:    z.enum(RV_AMP_SERVICES as unknown as [string, ...string[]]).optional(),
      // S550: who owns the dwelling — drives the inspection checklist
      // (site-only for tenant-owned MH/RV vs full interior). Only meaningful
      // for rv_spot / mobile_home; defaulted below.
      dwellingOwnership: z.enum(DWELLING_OWNERSHIP_VALUES as unknown as [string, ...string[]]).optional(),
      // S573: multi-level dwelling — adds the stairs & handrails inspection area.
      // Only meaningful for interior residential types; ignored otherwise.
      isMultiLevel:    z.boolean().optional(),
      // S573: ADA-accessible unit — adds the accessibility inspection area.
      isAdaAccessible: z.boolean().optional(),
      // S573: floor placement for tenant search filtering (ground/upper/etc).
      floorLevel:      z.enum(FLOOR_LEVELS as unknown as [string, ...string[]]).nullable().optional(),
      // S573: living-area count + feature map (what the unit has → inspection).
      livingAreas:     z.number().int().min(1).max(MAX_INSPECTION_LIVING_AREAS).optional(),
      features:        z.record(z.boolean()).optional(),
      storageSize:     z.string().max(40).optional(),
      nightlyRate:     z.number().min(0).nullable().optional(),
      weeklyRate:      z.number().min(0).nullable().optional(),
      monthlyRate:     z.number().min(0).nullable().optional(),
      // S568: monthly lot rent the operator pays an EXTERNAL park for this home's
      // lot (homes-only properties; investor-operator model). 0 when land-owned.
      lotRentAmount:   z.number().min(0).optional(),
      // S527 fix: the Add Unit modal always sent status but the schema
      // stripped it — the "Initial Status" picker was a silent no-op and
      // every unit was born vacant. Suspended stays excluded (eviction-mode
      // coupling, S524). direct_pay retired W-15/S531.
      // S609 (Nic): OWNER-OCCUPIED is settable at creation. It was only
      // available by creating the unit and then changing it in the units list,
      // which is why Nic was marking his own occupied spots VACANT: "I'm marking
      // them all vacant on setup because there's no way to mark them owner
      // occupied." A vacant-marked owner unit is not cosmetic — it takes no
      // share of a RUBS split, so the owner's own utility usage lands on the
      // paying tenants.
      status:          z.enum(['vacant', 'active', 'owner_use']).default('vacant'),
      // How many people live in an owner-occupied unit. Read only when
      // status='owner_use' — such a unit has no lease, so there are no tenants
      // to count for a headcount-based utility split.
      ownerHouseholdSize: z.number().int().min(1).max(30).optional(),
    }).parse(req.body)

    // Verify the calling user can manage units on this property's landlord.
    const prop = await queryOne<any>(
      `SELECT id, landlord_id FROM properties WHERE id = $1`,
      [body.propertyId]
    )
    if (!prop) throw new AppError(404, 'Property not found')
    if (!canManageLandlordResource(req.user, prop.landlord_id)) {
      throw new AppError(403, 'Forbidden')
    }

    // Owner subtype (S527): the unit's defaults. Must belong to this property.
    let sub: any = null
    if (body.subtypeId) {
      sub = await queryOne<any>(
        `SELECT * FROM property_unit_subtypes WHERE id=$1 AND property_id=$2`,
        [body.subtypeId, body.propertyId]
      )
      if (!sub) throw new AppError(404, 'Subtype not found on this property')
    }

    // S537 (Nic): a subtype LOCKS the unit type — "Back-in 30 amp" can
    // only ever mint an rv_spot. A conflicting explicit unitType in the
    // body is a client bug, not a preference; refuse rather than pick.
    if (sub && body.unitType && body.unitType !== sub.unit_type) {
      throw new AppError(400,
        `Subtype "${sub.name}" is a ${String(sub.unit_type).replace(/_/g, ' ')} subtype — it cannot create a ${String(body.unitType).replace(/_/g, ' ')} unit. Pick a matching subtype or clear the unit type.`)
    }
    const unitType = sub?.unit_type ?? body.unitType ?? 'apartment'
    // S537 gate: no units of an UNDECIDED late-fee class. The landlord
    // must hold an explicit (property, unit_type) decision — fee terms or
    // "no late fee" — before this class can exist at the property.
    await assertLateFeeDecision(body.propertyId, unitType)
    const num = (v: any) => v == null ? null : Number(v)
    const rentAmount = body.rentAmount ?? num(sub?.rent_amount)
    if (rentAmount == null || rentAmount <= 0) {
      throw new AppError(400, 'rentAmount required (directly or via the subtype)')
    }
    const securityDeposit = body.securityDeposit ?? num(sub?.security_deposit) ?? 0
    const bedrooms  = body.bedrooms ?? (sub?.bedrooms ?? 1)
    const bathrooms = body.bathrooms ?? num(sub?.bathrooms) ?? 1
    // RV sub-type fields only apply to rv_spot units; storage size to storage.
    const rvLayout = unitType === 'rv_spot' ? (body.rvSiteLayout ?? sub?.rv_site_layout ?? 'none') : 'none'
    const rvAmp    = unitType === 'rv_spot' ? (body.rvAmpService ?? sub?.rv_amp_service ?? 'none') : 'none'
    const storageSize = unitType === 'storage' ? (body.storageSize?.trim() || sub?.storage_size || null) : null
    const nightlyRate = body.nightlyRate ?? num(sub?.nightly_rate)
    const weeklyRate  = body.weeklyRate  ?? num(sub?.weekly_rate)
    const monthlyRate = body.monthlyRate ?? num(sub?.monthly_rate)
    // S526 (Nic): every RV site is short- AND long-term capable by default —
    // bookable, all stay lengths allowed. Landlord can narrow later.
    const isRv = unitType === 'rv_spot'
    // S550 default (Nic): parks mostly do NOT own the dwellings — rv_spot
    // AND mobile_home default TENANT-owned (space rent only); the subtype's
    // ownership wins when set; park-owned rentals are the explicit exception.
    const dwellingOwnership = body.dwellingOwnership
      ?? sub?.dwelling_ownership
      ?? ((isRv || unitType === 'mobile_home') ? 'tenant' : 'landlord')
    // S573: stairs & accessibility areas only exist on interior residential
    // types. These flags on an RV pad / storage unit are meaningless — force
    // false there so a mis-set flag never adds an irrelevant area.
    const INTERIOR_RESIDENTIAL_TYPES = ['apartment', 'single_family', 'mobile_home']
    const isInteriorResidential = INTERIOR_RESIDENTIAL_TYPES.includes(unitType)
    const isMultiLevel = isInteriorResidential ? (body.isMultiLevel ?? false) : false
    const isAdaAccessible = isInteriorResidential ? (body.isAdaAccessible ?? false) : false
    // S573: floor placement — meaningful for building units only (not RV/storage).
    const FLOOR_LEVEL_TYPES = ['apartment', 'single_family', 'mobile_home', 'hotel_room', 'commercial']
    const floorLevel = FLOOR_LEVEL_TYPES.includes(unitType) ? (body.floorLevel ?? null) : null
    // S573: living-area count + feature map (sanitized to keys offered for the type).
    const livingAreas = isInteriorResidential ? (body.livingAreas ?? 1) : 1
    const offeredKeys = new Set(UNIT_FEATURE_CATALOG.filter(f => f.types.includes(unitType)).map(f => f.key))
    const features: Record<string, boolean> = {}
    if (body.features) for (const [k, v] of Object.entries(body.features)) if (offeredKeys.has(k)) features[k] = !!v

    // S605 (Nic): the field means ONE thing everywhere — the unit NUMBER. The
    // prefix comes from the unit type, and for a batch the number is the
    // STARTING point that the counter runs on from.
    const unitNumbers: string[] = []
    if (body.quantity > 1) {
      // The prefix is the unit TYPE's, platform-wide — never what was typed.
      // "I don't want it to be mobile home site one spelled out on one property
      // and MH one on a different property."
      const pfx = (UNIT_TYPE_PREFIX as any)[unitType] ?? formatUnitNumber(body.unitNumber)
      const existing = await query<{ unit_number: string }>(
        `SELECT unit_number FROM units WHERE property_id=$1 AND LOWER(unit_number) LIKE LOWER($2)`,
        [body.propertyId, `${pfx} %`]
      )
      const nums = existing.map(r => { const m = r.unit_number.match(/\s(\d+)$/); return m ? parseInt(m[1]) : 0 })
      // When the prefix moved to the unit type, nothing took over reading the
      // typed value — so a landlord entering "1" as their starting number had it
      // silently discarded and got numbering continued from somewhere else.
      // The typed number wins; startAt stays as the explicit override; otherwise
      // continue after the highest existing number with this prefix.
      const typedStart = /^\d+$/.test(String(body.unitNumber ?? '').trim())
        ? parseInt(String(body.unitNumber).trim(), 10)
        : null
      const start = typedStart ?? body.startAt ?? (nums.length ? Math.max(...nums) + 1 : 1)
      // S605 (Nic, DIRECTIVE): "I want consistency platform wide. Remove those
      // number padding options." Padding is FIXED at two digits — a per-batch
      // choice meant one property could render "RV 8" while another rendered
      // "RV 08", which is the same drift the standard prefixes just ended.
      // padWidth is still accepted so older clients don't 400; it is ignored.
      const pad = 2
      for (let i = 0; i < body.quantity; i++) {
        unitNumbers.push(`${pfx} ${String(start + i).padStart(pad, '0')}`)
      }
    } else {
      // Canonical form: standard prefix + identifier, single digits zero-padded.
      // Accepts "7", "RV 7" or "Space 7" and stores "RV 07" for all three.
      unitNumbers.push(canonicalUnitNumber(unitType as any, body.unitNumber))
    }

    // S605: no bare-number guard is needed here any more — canonicalUnitNumber
    // supplies the unit type's standard prefix, so "37" becomes "RV 37" and a
    // prefix-less name can no longer be constructed. Enforced by construction
    // rather than by rejection.

    // S613 (Nic): a subtype is OPTIONAL. With one, the unit takes the class's
    // price and every unit in that class matches. Without one, the unit carries
    // its own price — which is why a landlord adding a single unit never has to
    // learn what a subtype is.
    const created: any[] = []
    for (const unitNumber of unitNumbers) {
      // W-16: the units_property_unit_number_uniq index rejects duplicate
      // numbers at a property — surface it as a friendly 409, not a 500.
      try {
      // S538 (Nic): storage units are LOCKED out of short-term rental —
      // their allow-list never contains nightly/weekly.
      const leaseTypesAllowed = (SHORT_STAY_LOCKED_UNIT_TYPES as readonly string[]).includes(unitType)
        ? ['month_to_month', 'long_term']
        : isRv
          ? ['nightly', 'weekly', 'month_to_month', 'long_term']
          : ['nightly', 'weekly', 'month_to_month']
      const [unit] = await query<any>(`
        INSERT INTO units (property_id, landlord_id, unit_number, unit_type, bedrooms, bathrooms, sqft,
                           rent_amount, security_deposit, rv_site_layout, rv_amp_service,
                           nightly_rate, weekly_rate, monthly_rate, storage_size, subtype_id, status,
                           is_bookable, lease_types_allowed, dwelling_ownership, lot_rent_amount, is_multi_level, is_ada_accessible, floor_level, living_areas, features, owner_household_size, occupancy_mode)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,
                $18, $19::text[], $20, $21, $22, $23, $24, $25, $26::jsonb, $27,
                -- S558: new unit inherits the property's default occupancy mode
                -- (a seed, not a governing setting — the unit owns it after).
                (SELECT default_occupancy_mode FROM properties WHERE id=$1))
        RETURNING *`,
        [body.propertyId, prop.landlord_id, unitNumber, unitType, bedrooms,
         bathrooms, body.sqft ?? null, rentAmount, securityDeposit, rvLayout, rvAmp,
         nightlyRate, weeklyRate, monthlyRate, storageSize, sub?.id ?? null, body.status,
         isRv, leaseTypesAllowed, dwellingOwnership, body.lotRentAmount ?? 0, isMultiLevel, isAdaAccessible, floorLevel, livingAreas, JSON.stringify(features),
         body.ownerHouseholdSize ?? 1]
      )
      created.push(unit)
      } catch (err: any) {
        // Two guards can fire: the pre-existing exact-case
        // units_property_id_unit_number_key, or the S529 case-insensitive
        // units_property_unit_number_uniq ("apt 204" vs "Apt 204").
        if (err?.code === '23505' && /unit_number/.test(err?.constraint || '')) {
          throw new AppError(409, `Unit "${unitNumber}" already exists at this property`)
        }
        throw err
      }
    }

    // Keep the property's unit_types chips accurate (the removed bulk route
    // did this; the single-unit path never had — fix-it-right).
    await query(
      `UPDATE properties
          SET unit_types = (SELECT array_agg(DISTINCT t) FROM unnest(COALESCE(unit_types,'{}') || $1::text) AS t)
        WHERE id = $2`,
      [unitType, body.propertyId]
    )

    res.status(201).json({ success: true, data: created.length === 1 ? created[0] : { created: created.length, units: created } })
  } catch (e) { next(e) }
})

// ─── S604 (Nic): RENAME + DELETE ────────────────────────────────────────────
// Neither existed. A unit's number was permanent from creation and there was no
// way to remove one created by mistake — "accidental creation just means I have
// to, what, delete a whole thing... that's not a good look."
//
// Renaming is safe at the data layer: invoices, leases, payments and meters all
// reference unit_id, never the number. The only constraint is the unique index
// on (property_id, lower(trim(unit_number))).

/** S604: does this unit carry history that must stay attached to it?
 *  Used by BOTH rename and delete. Nic's rule: a unit is freely editable during
 *  onboarding, and permanent the moment anything real touches it — a lease of
 *  ANY status (including ended), a booking, a payment, a deposit, a meter link
 *  or a maintenance request. */
async function unitHistoryBlocker(unitId: string): Promise<string | null> {
  const probes: Array<{ label: string; sql: string }> = [
    { label: 'a lease',               sql: 'SELECT 1 FROM leases WHERE unit_id=$1 LIMIT 1' },
    { label: 'a payment',             sql: 'SELECT 1 FROM payments WHERE unit_id=$1 LIMIT 1' },
    { label: 'a booking',             sql: 'SELECT 1 FROM unit_bookings WHERE unit_id=$1 LIMIT 1' },
    { label: 'a security deposit',    sql: 'SELECT 1 FROM security_deposits WHERE unit_id=$1 LIMIT 1' },
    // S605 (Nic): a meter LINK is not history — it is setup. Bulk-adding RV
    // sites with electric submetering attached a meter to every unit, which
    // then froze the numbers: "I cannot renumber the units even though no bills
    // have gone out, no anything." Renumbering during onboarding is normal —
    // gaps, and blocks like 14/14A, only become obvious once the list is on
    // screen.
    //
    // A meter blocks only once it carries something real: a READING or a BILL.
    // Until then the unit is still being set up, which is exactly the rule this
    // function was written to express.
    { label: 'a utility meter with readings',
      sql: `SELECT 1 FROM utility_meter_units mu
             WHERE mu.unit_id = $1
               AND (EXISTS (SELECT 1 FROM utility_meter_readings r WHERE r.meter_id = mu.meter_id)
                 OR EXISTS (SELECT 1 FROM utility_bills b WHERE b.meter_id = mu.meter_id))
             LIMIT 1` },
    { label: 'a maintenance request', sql: 'SELECT 1 FROM maintenance_requests WHERE unit_id=$1 LIMIT 1' },
  ]
  for (const p of probes) {
    if (await queryOne<any>(p.sql, [unitId])) return p.label
  }
  return null
}

// PATCH /api/units/:id/number — renumber a unit.
unitsRouter.patch('/:id/number', requirePerm('units.edit'), async (req, res, next) => {
  try {
    const { unitNumber } = z.object({ unitNumber: z.string().min(1).max(40) }).parse(req.body)
    const unit = await queryOne<any>('SELECT * FROM units WHERE id=$1', [req.params.id])
    if (!unit) throw new AppError(404, 'Unit not found')
    if (!canManageLandlordResource(req.user, unit.landlord_id)) throw new AppError(403, 'Forbidden')

    const next_ = canonicalUnitNumber(unit.unit_type, unitNumber)
    if (next_.toLowerCase() === String(unit.unit_number).toLowerCase()) {
      return res.json({ success: true, data: unit })   // no-op
    }

    // S604 (Nic): NO rename once the unit carries data. Nothing snapshots
    // unit_number — every invoice and payment renders the CURRENT value — so a
    // rename would retroactively rewrite how years of records display, while
    // executed lease PDFs keep the original and silently disagree. The intended
    // path is to RETIRE the unit and create its replacement under the new
    // number, keeping one physical space as two clean database records.
    const blocker = await unitHistoryBlocker(req.params.id)
    if (blocker) {
      throw new AppError(409,
        `This unit has ${blocker} on record, so its number is locked — renaming it would change how past invoices and records display. ` +
        `Retire this unit and add its replacement under the new number instead.`)
    }
    // Surface the collision as a friendly 409 rather than a 500 from the index.
    const clash = await queryOne<{ id: string }>(
      `SELECT id FROM units
        WHERE property_id = $1 AND lower(btrim(unit_number)) = lower(btrim($2)) AND id <> $3`,
      [unit.property_id, next_, req.params.id])
    if (clash) {
      throw new AppError(409, `"${next_}" is already used by another unit on this property. Unit numbers are unique per property regardless of unit type — use a prefix (e.g. "RV 01" vs "MH 01") if two types share a number.`)
    }
    const [updated] = await query<any>(
      `UPDATE units SET unit_number=$1, updated_at=NOW() WHERE id=$2 RETURNING *`,
      [next_, req.params.id])

    // S605: meter labels are generated as "<unit number> <utility>" when a unit
    // is created, so a renumber leaves them pointing at the OLD number — the
    // reading run would then send someone to "RV 03 electric" for a spot now
    // called RV 14. Only labels still matching the generated pattern are
    // rewritten; anything the landlord renamed by hand is theirs and is left
    // alone.
    const relabelled = await query<{ id: string }>(
      `UPDATE utility_meters m
          SET label = $3 || substring(m.label from char_length($2) + 1), updated_at = NOW()
        FROM utility_meter_units mu
       WHERE mu.meter_id = m.id
         AND mu.unit_id = $1
         AND lower(m.label) LIKE lower($2) || ' %'
       RETURNING m.id`,
      [req.params.id, unit.unit_number, next_])

    res.json({ success: true, data: updated, metersRelabelled: relabelled.length })
  } catch (e) { next(e) }
})

// DELETE /api/units/:id — remove a unit created by mistake.
//
// GAM never erases data (retention rule), so this is deliberately NOT a general
// delete: it is refused the moment a unit has ANY history. A unit with a lease,
// payment, booking, deposit or meter link carries records that must survive, and
// those are handled by taking the unit out of service, not by deleting it.
unitsRouter.delete('/:id', requirePerm('units.edit'), async (req, res, next) => {
  try {
    const unit = await queryOne<any>('SELECT * FROM units WHERE id=$1', [req.params.id])
    if (!unit) throw new AppError(404, 'Unit not found')
    if (!canManageLandlordResource(req.user, unit.landlord_id)) throw new AppError(403, 'Forbidden')

    const blocker = await unitHistoryBlocker(req.params.id)
    if (blocker) {
      throw new AppError(409,
        `This unit has ${blocker} on record, so it can't be deleted — GAM keeps that history. ` +
        `Take it out of service instead (set it vacant, or owner-use if you occupy it).`)
    }
    await query('DELETE FROM units WHERE id=$1', [req.params.id])
    res.json({ success: true, data: { deleted: true } })
  } catch (e) { next(e) }
})

// ── S605: RETIRE & REPLACE (Nic's design, decided S604) ───────────────────
//
// A unit that carries data can't be renumbered (nothing snapshots unit_number,
// so a rename rewrites how years of records display). Instead the one physical
// space becomes two records: retire the old, create the replacement under the
// new number, link them both ways. History stays exactly where it was written.
//
// The replacement inherits every physical/pricing attribute. That list is
// explicit rather than `SELECT *` because a handful of columns MUST NOT carry
// over — and `unitCloneColumns.test.ts` fails if a new `units` column is added
// without being classified here, so the list can't silently go stale.

/** Columns copied verbatim onto the replacement unit. */
export const UNIT_CLONE_COPIED = [
  'property_id', 'landlord_id', 'bedrooms', 'bathrooms', 'sqft',
  'rent_amount', 'security_deposit', 'listed_vacant', 'available_date',
  'listing_description', 'unit_type', 'nightly_rate', 'weekly_rate',
  'monthly_rate', 'is_bookable', 'lease_types_allowed', 'check_in_time',
  'check_out_time', 'amenities', 'unit_description', 'min_stay_nights',
  'max_stay_nights', 'import_extra_data', 'rv_site_layout', 'rv_amp_service',
  'storage_size', 'subtype_id', 'dwelling_ownership', 'occupancy_mode',
  'lot_rent_amount', 'is_multi_level', 'is_ada_accessible', 'floor_level',
  'features', 'living_areas',
  // S609: added by the S608 utility work and never classified — the drift guard
  // caught it. It COPIES: how many water fixtures a space has is a fact about
  // the physical space, and retire-and-replace is the same space under a new
  // number. Left uncopied it would silently reset to nothing, and a unit on a
  // fixture-count water split would then contribute zero — under-billing that
  // unit and over-billing every neighbour on the same meter.
  'water_fixture_count',
  // S609: same reasoning. Retire-and-replace is a RENUMBERING of one physical
  // space, not a turnover — the same household is still in it. Resetting this to
  // 1 would silently shrink an owner-occupied unit's share of a utility split
  // the next time it is marked owner-occupied, pushing the difference onto the
  // tenants. (Status itself still resets to vacant; this is a fact about the
  // household preserved, not an occupancy state carried over.)
  'owner_household_size',
  // S613: the propane tank is bolted to the space, and retire-and-replace is
  // that same space under a new number. Left uncopied, the replacement would
  // drop off the Record Delivery form and the next fill would have nowhere to
  // go — the renumbering would silently un-plumb the site.
  'has_propane_tank',
] as const

/**
 * Columns deliberately NOT copied, with the reason each is reset.
 * Keyed so the drift test can assert every units column is accounted for.
 */
export const UNIT_CLONE_RESET: Record<string, string> = {
  id:                      'new identity',
  unit_number:             'the whole point — the replacement takes the new number',
  created_at:              'the replacement is created now',
  updated_at:              'the replacement is created now',
  status:                  "starts 'vacant' — a fresh unit holds no lease",
  retired_at:              'the replacement is live',
  superseded_by_unit_id:   'nothing supersedes the replacement yet',
  replaces_unit_id:        'set to the retired unit',
  payment_block:           'eviction state belongs to the old tenancy, never carried',
  payment_block_set_at:    'eviction state belongs to the old tenancy, never carried',
  payment_block_set_by:    'eviction state belongs to the old tenancy, never carried',
  status_before_block:     'eviction state belongs to the old tenancy, never carried',
  scheduled_activation_at: 'a pending activation refers to the old record',
  scheduled_activation_by: 'a pending activation refers to the old record',
  on_time_pay_active:      'an enrollment belongs to the old unit/tenancy',
}

// POST /api/units/:id/retire — retire this unit, create its replacement.
unitsRouter.post('/:id/retire', requirePerm('units.edit'), async (req, res, next) => {
  try {
    const { unitNumber, reason } = z.object({
      unitNumber: z.string().min(1).max(40),
      reason:     z.string().trim().max(500).optional(),
    }).parse(req.body)

    const unit = await queryOne<any>('SELECT * FROM units WHERE id=$1', [req.params.id])
    if (!unit) throw new AppError(404, 'Unit not found')
    if (!canManageLandlordResource(req.user, unit.landlord_id)) throw new AppError(403, 'Forbidden')
    if (unit.retired_at) throw new AppError(409, 'This unit is already retired.')

    const newNumber = formatUnitNumber(unitNumber)
    if (newNumber.toLowerCase() === String(unit.unit_number).toLowerCase()) {
      throw new AppError(400, 'The replacement needs a different number — retiring a unit to the same number would leave two records claiming it.')
    }
    const clash = await queryOne<{ id: string }>(
      `SELECT id FROM units WHERE property_id = $1 AND lower(btrim(unit_number)) = lower(btrim($2))`,
      [unit.property_id, newNumber])
    if (clash) throw new AppError(409, `"${newNumber}" is already used by another unit on this property.`)

    // The unit must be FREE before it retires. This is what makes "a retired
    // unit is never billed" structural rather than a filter we have to remember:
    // platform-fee billing counts units with an ACTIVE LEASE plus short-stay
    // booking nights, and the DB triggers block any NEW lease or booking once
    // retired_at is set. End or transfer the tenancy first.
    const liveLease = await queryOne<{ id: string }>(
      `SELECT id FROM leases WHERE unit_id=$1 AND status IN ('active','pending') LIMIT 1`, [req.params.id])
    if (liveLease) {
      throw new AppError(409,
        'This unit still has an active or pending lease. End or transfer the tenancy before retiring it, ' +
        'so the replacement starts clean and nothing keeps billing against the old record.')
    }
    const futureBooking = await queryOne<{ id: string }>(
      `SELECT id FROM unit_bookings
        WHERE unit_id=$1 AND status NOT IN ('cancelled','no_show') AND check_out > now() LIMIT 1`,
      [req.params.id])
    if (futureBooking) {
      throw new AppError(409,
        'This unit has an upcoming booking. Move or cancel it before retiring the unit — a retired unit can’t be checked into.')
    }

    const client = await db.connect()
    try {
      await client.query('BEGIN')
      const cols = UNIT_CLONE_COPIED.join(', ')
      const [replacement] = await client.query<any>(
        `INSERT INTO units (unit_number, status, replaces_unit_id, ${cols})
         SELECT $2, 'vacant', $1, ${cols} FROM units WHERE id = $1
         RETURNING *`,
        [req.params.id, newNumber]
      ).then((r: any) => r.rows)

      const [retired] = await client.query<any>(
        `UPDATE units
            SET retired_at = now(), superseded_by_unit_id = $2, updated_at = now()
          WHERE id = $1 RETURNING *`,
        [req.params.id, replacement.id]
      ).then((r: any) => r.rows)

      await client.query(
        `INSERT INTO audit_log (user_id, action, entity_type, entity_id, old_value, new_value)
         VALUES ($1, 'unit_retired', 'unit', $2, $3::jsonb, $4::jsonb)`,
        [req.user!.userId, req.params.id,
         JSON.stringify({ unit_number: unit.unit_number }),
         JSON.stringify({ replacement_unit_id: replacement.id, unit_number: newNumber, reason: reason ?? null })]
      ).catch(() => {})

      await client.query('COMMIT')
      res.status(201).json({ success: true, data: { retired, replacement } })
    } catch (e) { await client.query('ROLLBACK'); throw e }
    finally { client.release() }
  } catch (e) { next(e) }
})

// PATCH /api/units/:id/status — set unit status
unitsRouter.patch('/:id/status', requirePerm('units.set_status'), async (req, res, next) => {
  try {
    const { status } = z.object({
      status: z.enum([...UNIT_STATUSES] as [string, ...string[]])
    }).parse(req.body)

    const unit = await queryOne<any>(`SELECT * FROM units WHERE id = $1`, [req.params.id])
    if (!unit) throw new AppError(404, 'Unit not found')
    if (!canManageLandlordResource(req.user, unit.landlord_id)) {
      throw new AppError(403, 'Forbidden')
    }
    // 'suspended' is coupled 1:1 to eviction mode (see POST /:id/eviction-mode).
    // It can't be set directly, and a unit that IS suspended can't be moved off
    // 'suspended' here — both directions go through the eviction-mode toggle so
    // status and payment_block never desync.
    if (status === 'suspended') {
      throw new AppError(400, "Use eviction mode to suspend a unit — 'suspended' can't be set directly")
    }
    if (unit.status === 'suspended') {
      throw new AppError(400, 'This unit is in eviction mode. Turn eviction mode off to change its status')
    }
    // S604: 'owner_use' means the OWNER occupies it — no lease, no rent. A unit
    // with a live lease has a tenant in it, so the two states are mutually
    // exclusive. Enforced rather than documented: without this a landlord could
    // flip an occupied, rent-paying unit to owner_use and keep the tenancy
    // while dropping out of every revenue-shaped aggregate.
    if (status === 'owner_use') {
      const live = await queryOne<{ n: string }>(
        `SELECT COUNT(*)::text AS n FROM leases
          WHERE unit_id = $1 AND status IN ('active','pending')`,
        [req.params.id],
      )
      if (Number(live?.n ?? 0) > 0) {
        throw new AppError(400, 'This unit has an active or pending lease. End the lease before marking it owner-occupied.')
      }
    }
    // Setting owner_use also takes the unit off the market: it is neither
    // listed to renters nor bookable for short stays. Leaving those flags set
    // would keep an owner-occupied unit accepting reservations.
    const [updated] = await query<any>(
      `UPDATE units
          SET status = $1,
              listed_vacant = CASE WHEN $1 = 'owner_use' THEN FALSE ELSE listed_vacant END,
              is_bookable   = CASE WHEN $1 = 'owner_use' THEN FALSE ELSE is_bookable   END,
              updated_at = NOW()
        WHERE id = $2 RETURNING *`, [status, req.params.id]
    )
    res.json({ success: true, data: updated })
  } catch (e) { next(e) }
})

// POST /api/units/:id/eviction-mode — Eviction mode — HARD BLOCK all tenant ACH
// Hard-blocks tenant ACH while eviction is active. Landlord is responsible for knowing their local eviction rules.
unitsRouter.post('/:id/eviction-mode', requirePerm('units.eviction_mode'), async (req, res, next) => {
  try {
    const { enable, confirm } = z.object({
      enable:  z.boolean(),
      confirm: z.boolean().refine(v => v === true, 'Must confirm eviction mode')
    }).parse(req.body)

    const unit = await queryOne<any>(`SELECT * FROM units WHERE id = $1`, [req.params.id])
    if (!unit) throw new AppError(404, 'Unit not found')
    // Eviction mode is high-stakes and legally fraught — landlord/admin only.
    if (!canManageLandlordResource(req.user, unit.landlord_id, [])) {
      throw new AppError(403, 'Forbidden')
    }

    // S400 fix: cast $2 to uuid. Postgres can't infer the type of a
    // parameter that only appears inside a CASE expression assigned to a
    // typed column, so pre-fix this UPDATE returned 42804 "column
    // payment_block_set_by is of type uuid but expression is of type
    // text" → 500 on every call. The eviction-mode toggle was effectively
    // non-functional before this cast.
    // Eviction mode is coupled 1:1 to the 'suspended' unit status. Turning it
    // ON suspends the unit (saving the prior status so we can restore it);
    // turning it OFF restores that prior status. A unit is 'suspended' iff
    // eviction mode is on — 'suspended' is never set any other way. All SET
    // RHS expressions read the OLD row, so `status` / `status_before_block`
    // below reference the pre-update values.
    const [updated] = await query<any>(`
      UPDATE units
      SET payment_block = $1,
          payment_block_set_at = CASE WHEN $1 THEN NOW() ELSE NULL END,
          payment_block_set_by = CASE WHEN $1 THEN $2::uuid ELSE NULL END,
          status = CASE
                     WHEN $1 AND status <> 'suspended' THEN 'suspended'
                     WHEN NOT $1 AND status = 'suspended' THEN COALESCE(status_before_block, 'active')
                     ELSE status
                   END,
          status_before_block = CASE
                     WHEN $1 AND status <> 'suspended' THEN status
                     WHEN NOT $1 AND status = 'suspended' THEN NULL
                     ELSE status_before_block
                   END
      WHERE id = $3
      RETURNING *`,
      [enable, req.user!.userId, req.params.id]
    )
    res.json({
      success: true,
      data: updated,
      message: enable
        ? '⚠️ EVICTION MODE ACTIVE — All tenant ACH hard blocked. Check your local laws before accepting any payment.'
        : 'Eviction mode deactivated — ACH collections resumed'
    })
  } catch (e) { next(e) }
})

// GET /api/units/:id/economics
unitsRouter.get('/:id/economics', async (req, res, next) => {
  try {
    const unit = await queryOne<any>('SELECT * FROM units WHERE id = $1', [req.params.id])
    if (!unit) throw new AppError(404, 'Unit not found')
    // Per-unit P&L view is financial — landlord/admin only.
    if (!canViewLandlordFinances(req.user, unit.landlord_id)) {
      throw new AppError(403, 'Forbidden')
    }
    const [{ count }] = await query('SELECT COUNT(*)::int AS count FROM units WHERE landlord_id = $1 AND status = $2', [unit.landlord_id, 'active'])
    const { rate } = getReservePhase(count)
    const econ = calcNetPerUnit(unit.rent_amount, rate)
    // Launch fee model (walkthrough #34): flat $2 per OCCUPIED unit, vacant
    // $0 — retires the old $15/$5 OTP/direct tiers. The $10/property minimum
    // is a per-property accrual floor, not attributable to a single unit, so
    // the per-unit lifetime fee is just $2 × occupied months. Occupied =
    // active + delinquent + suspended (rent-obligation principle): the real
    // accrual in services/platformFee.ts counts by active LEASE, which those
    // statuses all still carry — pre-W-15 this preview showed $0 for
    // delinquent/suspended units while the accrual charged them.
    const fee = ['active', 'delinquent', 'suspended'].includes(unit.status)
      ? LAUNCH_PLATFORM_FEE.PER_OCCUPIED_UNIT : 0
    const feeNum = Number(fee)
    const ps = await queryOne("SELECT COALESCE(SUM(amount) FILTER (WHERE status = 'settled'), 0) as total_collected, COALESCE(SUM(amount) FILTER (WHERE status = 'settled' AND due_date >= date_trunc('month', NOW())), 0) as this_month, COALESCE(SUM(amount) FILTER (WHERE status = 'settled' AND due_date >= date_trunc('year', NOW())), 0) as this_year, COUNT(*) FILTER (WHERE status = 'settled') as settled_count, COUNT(*) FILTER (WHERE status = 'failed') as failed_count, MIN(due_date) as first_payment FROM payments WHERE unit_id = $1", [req.params.id])
    const ms = await queryOne("SELECT COALESCE(SUM(actual_cost), 0) as total_cost, COALESCE(SUM(actual_cost) FILTER (WHERE created_at >= date_trunc('month', NOW())), 0) as this_month_cost, COUNT(*) as total_requests FROM maintenance_requests WHERE unit_id = $1", [req.params.id])
    const fp = ps && ps.first_payment ? new Date(ps.first_payment) : null
    const months = fp ? Math.floor((Date.now() - fp.getTime()) / (1000*60*60*24*30)) : 0
    const lc = parseFloat(ps && ps.total_collected || 0)
    const lm = parseFloat(ms && ms.total_cost || 0)
    // S603: `econ` (calcNetPerUnit) is GAM's OWN margin math — gross platform
    // fee, GAM's Stripe cost, GAM's reserve rate and net kept. That is GAM's
    // markup, and it must never reach a landlord (same rule the agents run
    // under). The landlord portal renders none of it; it was only ever leaking
    // over the wire. Admin keeps the full view.
    const isAdmin = req.user!.role === 'admin' || req.user!.role === 'super_admin'
    const gamInternals = isAdmin ? { ...econ, reserveRate: rate } : {}
    res.json({ success: true, data: { ...gamInternals, platformFee: fee, occupiedPortfolio: count, netRentMonthly: unit.rent_amount - feeNum, netRentYearly: (unit.rent_amount - feeNum) * 12, netThisMonth: parseFloat(ps && ps.this_month || 0) - feeNum - parseFloat(ms && ms.this_month_cost || 0), netThisYear: parseFloat(ps && ps.this_year || 0) - (feeNum*12) - lm, tenantMonths: months, lifetimeCollected: lc, lifetimeMaintCost: lm, lifetimeNet: lc - (feeNum*months) - lm, lifetimePlatformFees: feeNum*months, settledCount: parseInt(ps && ps.settled_count || 0), failedCount: parseInt(ps && ps.failed_count || 0), totalRequests: parseInt(ms && ms.total_requests || 0) } })
  } catch (e) { next(e) }
})

// ── UNIT TYPE + SHORT-TERM CONFIG ─────────────────────────────

const LEASE_TYPE_MATRIX: Record<string, string[]> = {
  residential:     ['month_to_month', 'long_term'],
  rv_spot:         ['nightly', 'weekly', 'month_to_month', 'long_term'],
  storage:         ['month_to_month', 'long_term'],
  // S577: parking is bookable at every stay length — daily bookings bill 5%,
  // a monthly rental bills $2/unit. (Not short-stay-locked; that's storage only.)
  parking:         ['nightly', 'weekly', 'month_to_month', 'long_term'],
  short_term_cabin:['nightly', 'weekly', 'month_to_month'],
  // S538: hotel/motel rooms — every stay length (weekly-rate motels and
  // long-term room tenants like Oak Park's are both real).
  hotel_room:      ['nightly', 'weekly', 'month_to_month', 'long_term'],
  // S577: boat slip + land/lot bookable at every stay length. Short-term = 5%;
  // monthly = $2/unit. (Land short-term = event/vendor space.)
  boat_slip:       ['nightly', 'weekly', 'month_to_month', 'long_term'],
  land_lot:        ['nightly', 'weekly', 'month_to_month', 'long_term'],
  // S577: campsite = tent/primitive site, bookable like an RV spot.
  campsite:        ['nightly', 'weekly', 'month_to_month', 'long_term'],
}

// PATCH /api/units/:id/type — set unit type and rates
unitsRouter.patch('/:id/type', requirePerm('schedule.configure_unit'), async (req, res, next) => {
  try {
    const { unitType, nightlyRate, weeklyRate, monthlyRate, minStayNights, maxStayNights,
            checkInTime, checkOutTime, amenities, unitDescription, isBookable, rvSiteLayout, rvAmpService,
            dwellingOwnership, occupancyMode, lotRentAmount, isMultiLevel, isAdaAccessible } = req.body

    if (rvSiteLayout != null && !RV_SITE_LAYOUTS.includes(rvSiteLayout)) {
      throw new AppError(400, `Invalid rvSiteLayout '${rvSiteLayout}'`)
    }
    // S558: occupancy mode — whole_unit (one lease) vs by_room (stacked leases).
    if (occupancyMode != null && !(OCCUPANCY_MODES as readonly string[]).includes(occupancyMode)) {
      throw new AppError(400, `Invalid occupancyMode '${occupancyMode}'`)
    }
    if (dwellingOwnership != null && !(DWELLING_OWNERSHIP_VALUES as readonly string[]).includes(dwellingOwnership)) {
      throw new AppError(400, `Invalid dwellingOwnership '${dwellingOwnership}'`)
    }
    if (rvAmpService != null && !RV_AMP_SERVICES.includes(rvAmpService)) {
      throw new AppError(400, `Invalid rvAmpService '${rvAmpService}'`)
    }

    const unit = await queryOne<any>('SELECT * FROM units WHERE id=$1', [req.params.id])
    if (!unit) throw new AppError(404, 'Unit not found')
    if (!canManageLandlordResource(req.user, unit.landlord_id)) {
      throw new AppError(403, 'Forbidden')
    }

    // S538 (Nic): storage can never be publicly bookable (the public flow
    // auto-tiers nightly/weekly pricing — is_bookable IS the short-stay gate).
    if ((SHORT_STAY_LOCKED_UNIT_TYPES as readonly string[]).includes(unitType || 'residential') && isBookable) {
      throw new AppError(400, 'Storage units cannot be made bookable for short-term stays')
    }

    const leaseTypesAllowed = LEASE_TYPE_MATRIX[unitType] || LEASE_TYPE_MATRIX['residential']

    const updated = await queryOne<any>(`UPDATE units SET
      unit_type=$1, lease_types_allowed=$2, nightly_rate=$3, weekly_rate=$4, monthly_rate=$5,
      min_stay_nights=$6, max_stay_nights=$7, check_in_time=$8, check_out_time=$9,
      amenities=$10, unit_description=$11, is_bookable=$12,
      rv_site_layout=COALESCE($14,rv_site_layout),
      rv_amp_service=COALESCE($15,rv_amp_service),
      dwelling_ownership=COALESCE($16,dwelling_ownership),
      occupancy_mode=COALESCE($17,occupancy_mode),
      lot_rent_amount=COALESCE($18,lot_rent_amount),
      is_multi_level=COALESCE($19,is_multi_level),
      is_ada_accessible=COALESCE($20,is_ada_accessible), updated_at=NOW()
      WHERE id=$13 RETURNING *`,
      [unitType||'residential', leaseTypesAllowed, nightlyRate||null, weeklyRate||null,
       monthlyRate||null, minStayNights||1, maxStayNights||null,
       checkInTime||'15:00', checkOutTime||'11:00',
       amenities||[], unitDescription||null, isBookable??false, unit.id, rvSiteLayout ?? null, rvAmpService ?? null,
       dwellingOwnership ?? null, occupancyMode ?? null,
       lotRentAmount == null ? null : Number(lotRentAmount),
       typeof isMultiLevel === 'boolean' ? isMultiLevel : null,
       typeof isAdaAccessible === 'boolean' ? isAdaAccessible : null])

    res.json({ success: true, data: updated })
  } catch (e) { next(e) }
})

// PATCH /api/units/:id/occupancy-mode (S558) — flip a single unit between
// whole_unit and by_room. Dedicated route (not /type) so it never clobbers the
// unit's other config. Guard: can't switch to whole_unit while >1 active lease
// exists (that mode allows only one).
unitsRouter.patch('/:id/occupancy-mode', requirePerm('schedule.configure_unit'), async (req, res, next) => {
  try {
    const { occupancyMode } = req.body
    if (!(OCCUPANCY_MODES as readonly string[]).includes(occupancyMode)) {
      throw new AppError(400, `Invalid occupancyMode '${occupancyMode}'`)
    }
    const unit = await queryOne<any>('SELECT id, landlord_id FROM units WHERE id=$1', [req.params.id])
    if (!unit) throw new AppError(404, 'Unit not found')
    if (!canManageLandlordResource(req.user, unit.landlord_id)) throw new AppError(403, 'Forbidden')
    if (occupancyMode === 'whole_unit') {
      const n = await queryOne<any>(`SELECT COUNT(*)::int AS c FROM leases WHERE unit_id=$1 AND status IN ('active','pending')`, [req.params.id])
      if ((n?.c ?? 0) > 1) throw new AppError(409, 'This unit has multiple active leases — end all but one before switching to whole-unit mode.')
    }
    const updated = await queryOne<any>(`UPDATE units SET occupancy_mode=$1, updated_at=NOW() WHERE id=$2 RETURNING *`, [occupancyMode, req.params.id])
    res.json({ success: true, data: updated })
  } catch (e) { next(e) }
})

// PATCH /api/units/:id/inspection-attributes (S573) — flip a single unit's
// inspection-template filter flags (is_multi_level, is_ada_accessible).
// Dedicated route (not /type) so a standalone toggle never clobbers the unit's
// unit_type/rates. Each field is optional; COALESCE leaves the others untouched.
unitsRouter.patch('/:id/inspection-attributes', requirePerm('schedule.configure_unit'), async (req, res, next) => {
  try {
    const { isMultiLevel, isAdaAccessible } = req.body
    if (isMultiLevel != null && typeof isMultiLevel !== 'boolean') throw new AppError(400, 'isMultiLevel must be a boolean')
    if (isAdaAccessible != null && typeof isAdaAccessible !== 'boolean') throw new AppError(400, 'isAdaAccessible must be a boolean')
    if (isMultiLevel == null && isAdaAccessible == null) throw new AppError(400, 'Nothing to update')
    const unit = await queryOne<any>('SELECT id, landlord_id FROM units WHERE id=$1', [req.params.id])
    if (!unit) throw new AppError(404, 'Unit not found')
    if (!canManageLandlordResource(req.user, unit.landlord_id)) throw new AppError(403, 'Forbidden')
    const updated = await queryOne<any>(
      `UPDATE units SET
         is_multi_level=COALESCE($1, is_multi_level),
         is_ada_accessible=COALESCE($2, is_ada_accessible),
         updated_at=NOW()
       WHERE id=$3 RETURNING *`,
      [typeof isMultiLevel === 'boolean' ? isMultiLevel : null,
       typeof isAdaAccessible === 'boolean' ? isAdaAccessible : null,
       req.params.id])
    res.json({ success: true, data: updated })
  } catch (e) { next(e) }
})

// PATCH /api/units/:id/details (S573) — the SINGLE consolidated unit editor.
// Every unit setting is editable here, but ONLY while the unit has no active/
// pending lease. Once a lease is active/pending the settings freeze (rent is
// committed to the signed doc; between-lease is when a landlord raises rent or
// remodels bed/bath). Replaces the scattered listing/type/attribute edits.
unitsRouter.patch('/:id/details', requirePerm('schedule.configure_unit'), async (req, res, next) => {
  try {
    const body = z.object({
      unitType:        z.enum(UNIT_TYPES as unknown as [string, ...string[]]).optional(),
      bedrooms:        z.number().int().min(0).max(30).optional(),
      bathrooms:       z.number().min(0).max(30).optional(),
      sqft:            z.number().int().min(0).nullable().optional(),
      // S613 (Nic): accepted for a unit with NO subtype, refused for one in a
      // subtype — the subtype sets the price for every unit in it.
      rentAmount:      z.number().min(0).optional(),
      securityDeposit: z.number().min(0).optional(),
      dwellingOwnership: z.enum(DWELLING_OWNERSHIP_VALUES as unknown as [string, ...string[]]).optional(),
      isMultiLevel:    z.boolean().optional(),
      isAdaAccessible: z.boolean().optional(),
      floorLevel:      z.enum(FLOOR_LEVELS as unknown as [string, ...string[]]).nullable().optional(),
      livingAreas:     z.number().int().min(1).max(MAX_INSPECTION_LIVING_AREAS).optional(),
      features:        z.record(z.boolean()).optional(),
      occupancyMode:   z.enum(OCCUPANCY_MODES as unknown as [string, ...string[]]).optional(),
      rvSiteLayout:    z.enum(RV_SITE_LAYOUTS as unknown as [string, ...string[]]).optional(),
      rvAmpService:    z.enum(RV_AMP_SERVICES as unknown as [string, ...string[]]).optional(),
      storageSize:     z.string().max(40).nullable().optional(),
      lotRentAmount:   z.number().min(0).optional(),
      // S609: household size for an OWNER-OCCUPIED unit — see the migration.
      ownerHouseholdSize: z.number().int().min(1).max(30).optional(),
      // S613 (Nic): does this space have a propane tank to fill. Set in the same
      // place as its submeters and flat charges — "all those things should be
      // selectable in the same spot even though it's not always a meter."
      hasPropaneTank:  z.boolean().optional(),
      nightlyRate:     z.number().min(0).nullable().optional(),
      weeklyRate:      z.number().min(0).nullable().optional(),
      monthlyRate:     z.number().min(0).nullable().optional(),
      isBookable:      z.boolean().optional(),
    }).parse(req.body)

    const unit = await queryOne<any>('SELECT * FROM units WHERE id=$1', [req.params.id])
    if (!unit) throw new AppError(404, 'Unit not found')
    if (!canManageLandlordResource(req.user, unit.landlord_id)) throw new AppError(403, 'Forbidden')

    // S613 (Nic, DIRECTIVE): "when there is a subtype set, all units with that
    // subtype have to be the same price because it's set at the subtype level.
    // If one doesn't exist, then it can be a different price."
    //
    // So the price fields live here for an unclassed unit and are refused for a
    // classed one — accepting them there would let two units of one class drift
    // apart, which is the whole thing a class prevents. Refusing out loud beats
    // ignoring: a save that reports success and changes nothing is how the
    // subtype overwrite went unnoticed for a session.
    const priceFields = ['rentAmount', 'securityDeposit', 'nightlyRate', 'weeklyRate', 'monthlyRate'] as const
    const sentPrice = priceFields.filter(k => (body as any)[k] !== undefined)
    const classOwnsPrice = !!unit.subtype_id
    if (sentPrice.length && classOwnsPrice) {
      const sub = await queryOne<any>(
        `SELECT name FROM property_unit_subtypes WHERE id=$1`, [unit.subtype_id])
      throw new AppError(400,
        `This unit is a "${sub?.name ?? 'subtype'}", and that subtype sets the price for every unit ` +
        'in it. Change it on the subtype and they all follow — or take this unit out of the subtype ' +
        'to price it on its own.')
    }

    // Lease-lock — the whole point of this workflow (Nic): no edits while a
    // lease is active/pending; everything is editable only between leases.
    const leased = await queryOne<any>(
      `SELECT 1 FROM leases WHERE unit_id=$1 AND status IN ('active','pending') LIMIT 1`, [req.params.id])
    if (leased) {
      throw new AppError(409,
        'This unit has an active lease — its settings are locked until the lease ends. ' +
        'Rent and terms are committed to the signed lease; edit unit settings between leases.')
    }

    const unitType = body.unitType ?? unit.unit_type ?? 'apartment'
    // Same late-fee-decision gate as unit creation — no unit of an undecided
    // class, so a type switch can't sneak past it.
    if (body.unitType && body.unitType !== unit.unit_type) {
      await assertLateFeeDecision(unit.property_id, unitType)
    }

    let isBookable = body.isBookable ?? unit.is_bookable
    if ((SHORT_STAY_LOCKED_UNIT_TYPES as readonly string[]).includes(unitType) && isBookable) {
      throw new AppError(400, 'Storage units cannot be made bookable for short-term stays')
    }

    const isRv = unitType === 'rv_spot'
    const INTERIOR_RESIDENTIAL_TYPES = ['apartment', 'single_family', 'mobile_home']
    const isInteriorResidential = INTERIOR_RESIDENTIAL_TYPES.includes(unitType)
    // Normalize type-specific fields so a type switch never leaves stale attrs.
    const rvLayout    = isRv ? (body.rvSiteLayout ?? unit.rv_site_layout ?? 'none') : 'none'
    const rvAmp       = isRv ? (body.rvAmpService ?? unit.rv_amp_service ?? 'none') : 'none'
    const storageSize = unitType === 'storage' ? ((body.storageSize ?? unit.storage_size) || null) : null
    const isMultiLevel    = isInteriorResidential ? (body.isMultiLevel ?? unit.is_multi_level ?? false) : false
    const isAdaAccessible = isInteriorResidential ? (body.isAdaAccessible ?? unit.is_ada_accessible ?? false) : false
    const dwellingOwnership = (isRv || unitType === 'mobile_home')
      ? (body.dwellingOwnership ?? unit.dwelling_ownership ?? 'tenant')
      : 'landlord'
    // Floor placement — building units only; cleared on RV/storage/parking.
    const FLOOR_LEVEL_TYPES = ['apartment', 'single_family', 'mobile_home', 'hotel_room', 'commercial']
    const floorLevel = FLOOR_LEVEL_TYPES.includes(unitType)
      ? (body.floorLevel === undefined ? unit.floor_level : body.floorLevel)
      : null
    const leaseTypesAllowed = LEASE_TYPE_MATRIX[unitType] || LEASE_TYPE_MATRIX['residential']

    const bedrooms   = body.bedrooms ?? unit.bedrooms
    const bathrooms  = body.bathrooms ?? unit.bathrooms
    const sqft       = body.sqft === undefined ? unit.sqft : body.sqft
    // S613: a CLASSED unit carries these through untouched — its subtype writes
    // them, via the trigger when the class is edited and via the link when the
    // unit moves class. An unclassed unit owns them, as it always did.
    const rentAmount = classOwnsPrice ? Number(unit.rent_amount) : (body.rentAmount ?? Number(unit.rent_amount))
    const securityDeposit = classOwnsPrice ? Number(unit.security_deposit) : (body.securityDeposit ?? Number(unit.security_deposit))
    const nightlyRate = classOwnsPrice || body.nightlyRate === undefined ? unit.nightly_rate : body.nightlyRate
    const weeklyRate  = classOwnsPrice || body.weeklyRate  === undefined ? unit.weekly_rate  : body.weeklyRate
    const monthlyRate = classOwnsPrice || body.monthlyRate === undefined ? unit.monthly_rate : body.monthlyRate
    const lotRentAmount = body.lotRentAmount ?? Number(unit.lot_rent_amount ?? 0)
    const occupancyMode = body.occupancyMode ?? unit.occupancy_mode
    // S573: living-area count (bedroom types only) + feature map (only keys the
    // catalog offers for this type; drops stale keys on a type switch).
    const livingAreas = INTERIOR_RESIDENTIAL_TYPES.includes(unitType)
      ? (body.livingAreas ?? unit.living_areas ?? 1) : 1
    let features = (unit.features ?? {}) as Record<string, boolean>
    if (body.features) {
      const offered = new Set(UNIT_FEATURE_CATALOG.filter(f => f.types.includes(unitType)).map(f => f.key))
      const clean: Record<string, boolean> = {}
      for (const [k, v] of Object.entries(body.features)) if (offered.has(k)) clean[k] = !!v
      features = clean
    }

    const updated = await queryOne<any>(`
      UPDATE units SET
        unit_type=$1, bedrooms=$2, bathrooms=$3, sqft=$4,
        rent_amount=$5, security_deposit=$6, dwelling_ownership=$7,
        is_multi_level=$8, is_ada_accessible=$9, occupancy_mode=$10,
        rv_site_layout=$11, rv_amp_service=$12, storage_size=$13,
        lot_rent_amount=$14, nightly_rate=$15, weekly_rate=$16, monthly_rate=$17,
        is_bookable=$18, lease_types_allowed=$19::text[], floor_level=$21,
        living_areas=$22, features=$23::jsonb,
        owner_household_size=COALESCE($24, owner_household_size),
        has_propane_tank=COALESCE($25, has_propane_tank), updated_at=NOW()
      WHERE id=$20 RETURNING *`,
      [unitType, bedrooms, bathrooms, sqft, rentAmount, securityDeposit, dwellingOwnership,
       isMultiLevel, isAdaAccessible, occupancyMode, rvLayout, rvAmp, storageSize,
       lotRentAmount, nightlyRate, weeklyRate, monthlyRate, isBookable, leaseTypesAllowed,
       req.params.id, floorLevel, livingAreas, JSON.stringify(features),
       body.ownerHouseholdSize ?? null, body.hasPropaneTank ?? null])
    res.json({ success: true, data: updated })
  } catch (e) { next(e) }
})

// PATCH /api/units/:id/subtype — S613 (Nic): "I wanna figure out how to link
// subtypes to different units because there's nowhere that I can see that
// links those."
//
// Deliberately NOT part of PATCH /:id/details, which is locked whole while a
// lease is active. Moving a space between classes stays available on an
// occupied unit — otherwise a full park could never classify a single space,
// and it is safe because the unit's price is the ASKING price: a tenant is
// billed from leases.rent_amount and the lease is law (S613).
unitsRouter.patch('/:id/subtype', requirePerm('schedule.configure_unit'), async (req, res, next) => {
  try {
    const body = z.object({
      // null = no class. The unit then owns its price again, keeping whatever
      // it currently has — leaving a class is not a reason to reprice a unit.
      subtypeId:    z.string().uuid().nullable(),
      applyDetails: z.boolean().optional(),
    }).parse(req.body)

    const unit = await queryOne<any>(`
      SELECT u.id, u.unit_number, u.unit_type, u.property_id, u.landlord_id, u.retired_at,
             EXISTS (SELECT 1 FROM leases l WHERE l.unit_id = u.id
                       AND l.status IN ('active','pending')) AS leased
        FROM units u WHERE u.id = $1`, [req.params.id])
    if (!unit) throw new AppError(404, 'Unit not found')
    if (!canManageLandlordResource(req.user, unit.landlord_id)) throw new AppError(403, 'Forbidden')
    if (unit.retired_at) throw new AppError(409, 'A retired unit keeps the details it was retired with.')

    try {
      const out = await linkUnitToSubtype(unit, body.subtypeId, { applyDetails: !!body.applyDetails })
      res.json({ success: true, data: {
        subtypeId: out.subtype?.id ?? null,
        subtypeName: out.subtype?.name ?? null,
      } })
    } catch (e: any) {
      throw new AppError(400, e?.message || 'Could not set that subtype')
    }
  } catch (e) { next(e) }
})

// PATCH /api/units/:id/utility-responsibility — S613 (Nic, DIRECTIVE).
//
// "Trash or other stuff may be an ADDENDUM when billed back separately, as
//  things change. There needs to be able to be other charges that are not on the
//  lease. The accuracy we're going for is that the things that are IN the lease
//  cannot be ALTERED on the charge, not that no other charges happen."
//
// Until now this row had exactly one writer — e-sign, parsing the lease's own
// tags — which made a utility the lease never mentioned unbillable forever. A
// landlord who added trash service in year two configured everything correctly
// and the run reported unitsSkipped, silently, every month.
//
// What this does NOT open: rent, deposits, or any amount the lease fixes. Those
// come off the lease row and still have no editor. This says only WHETHER a
// utility is billed back, which is what an addendum ordinarily says on paper —
// and it records who asserted it and when, because GAM cannot see the paper.
unitsRouter.patch('/:id/utility-responsibility', requirePerm('properties.edit'), async (req, res, next) => {
  try {
    const body = z.object({
      utilityType:       z.enum(UTILITY_TYPES as unknown as [string, ...string[]]),
      tenantResponsible: z.boolean(),
      note:              z.string().trim().max(300).optional(),
    }).parse(req.body)

    const unit = await queryOne<any>(
      `SELECT id, landlord_id, unit_number FROM units WHERE id = $1`, [req.params.id])
    if (!unit) throw new AppError(404, 'Unit not found')
    if (!canManageLandlordResource(req.user, unit.landlord_id)) throw new AppError(403, 'Forbidden')

    const lease = await queryOne<any>(
      `SELECT id FROM leases WHERE unit_id = $1 AND status = 'active' LIMIT 1`, [req.params.id])
    if (!lease) {
      throw new AppError(409,
        `Unit ${unit.unit_number} has no active lease, so there is nobody to bill it back to. ` +
        `The next lease decides this on its own terms.`)
    }

    // A responsibility that CAME FROM the signed lease is not overwritten into
    // silence here: switching one off would be altering what the tenant signed,
    // which is the thing this whole rule protects.
    const existing = await queryOne<any>(
      `SELECT source, tenant_responsible FROM lease_utility_responsibilities
        WHERE lease_id = $1 AND utility_type = $2`, [lease.id, body.utilityType])
    if (existing && existing.source === 'lease' && existing.tenant_responsible && !body.tenantResponsible) {
      throw new AppError(409,
        `The signed lease makes this tenant responsible for ${body.utilityType}. That is a term of ` +
        `the lease, so it can't be switched off here — it changes on the next lease, or by an ` +
        `agreement you both sign.`)
    }

    const row = await queryOne<any>(
      `INSERT INTO lease_utility_responsibilities
         (lease_id, utility_type, tenant_responsible, source, set_by_user_id, set_at, note)
       VALUES ($1, $2, $3, 'addendum', $4, NOW(), $5)
       ON CONFLICT (lease_id, utility_type) DO UPDATE
         SET tenant_responsible = EXCLUDED.tenant_responsible,
             source = 'addendum', set_by_user_id = EXCLUDED.set_by_user_id,
             set_at = NOW(), note = EXCLUDED.note
       RETURNING *`,
      [lease.id, body.utilityType, body.tenantResponsible, req.user!.userId, body.note ?? null])
    res.json({ success: true, data: row })
  } catch (e) { next(e) }
})

// GET /api/units/:id/availability — get booked dates
unitsRouter.get('/:id/availability', async (req, res, next) => {
  try {
    const unit = await queryOne<any>('SELECT landlord_id FROM units WHERE id = $1', [req.params.id])
    if (!unit) throw new AppError(404, 'Unit not found')
    if (!canAccessLandlordResource(req.user, unit.landlord_id)) {
      throw new AppError(403, 'Forbidden')
    }

    const { from, to } = req.query
    const fromDate = from || new Date().toISOString().split('T')[0]
    const toDate = to || new Date(Date.now() + 90*24*60*60*1000).toISOString().split('T')[0]

    const bookings = await query<any>(`
      SELECT id, check_in, check_out, status, lease_type, guest_name
      FROM unit_bookings
      WHERE unit_id=$1 AND status NOT IN ('cancelled') AND check_out >= $2 AND check_in <= $3
      ORDER BY check_in`, [req.params.id, fromDate, toDate])

    res.json({ success: true, data: bookings })
  } catch (e) { next(e) }
})

// POST /api/units/:id/bookings — create booking
//
// S354: added zod validation. Pre-S354 missing required fields
// (leaseType / checkIn / checkOut) produced 500 from the DB NOT NULL
// or CHECK violation instead of clean 400. checkOut <= checkIn was
// also silently accepted, producing 0 or negative nights via the
// Math.ceil calc. Both now caught at the zod / pre-INSERT layer.
unitsRouter.post('/:id/bookings', requirePerm('schedule.create_reservation'), async (req, res, next) => {
  try {
    const body = z.object({
      guestName:   z.string().nullish(),
      guestEmail:  z.string().email().nullish(),
      guestPhone:  z.string().nullish(),
      leaseType:   z.enum(['nightly', 'weekly', 'month_to_month', 'long_term', 'lease_hold']),
      checkIn:     z.string(),
      checkOut:    z.string(),
      tenantId:    z.string().uuid().nullish(),
      nightlyRate: z.number().min(0).nullish(),
      weeklyRate:  z.number().min(0).nullish(),
      totalAmount: z.number().min(0).nullish(),
      notes:       z.string().nullish(),
      source:      z.string().nullish(),
      requiredSiteLayout: z.enum(RV_SITE_LAYOUTS as unknown as [string, ...string[]]).nullish(),
      requiredAmpService: z.enum(RV_AMP_SERVICES as unknown as [string, ...string[]]).nullish(),
    }).parse(req.body)

    const checkInD  = new Date(body.checkIn)
    const checkOutD = new Date(body.checkOut)
    if (isNaN(checkInD.getTime())) throw new AppError(400, 'Invalid checkIn date')
    if (isNaN(checkOutD.getTime())) throw new AppError(400, 'Invalid checkOut date')
    if (checkOutD.getTime() <= checkInD.getTime()) {
      throw new AppError(400, 'checkOut must be after checkIn')
    }

    const unit = await queryOne<any>('SELECT * FROM units WHERE id=$1', [req.params.id])
    if (!unit) throw new AppError(404, 'Unit not found')
    if (!canManageLandlordResource(req.user, unit.landlord_id)) {
      throw new AppError(403, 'Forbidden')
    }
    // Property-locked workers may only create reservations at their properties.
    await assertPropertyInScope(req.user, unit.property_id)

    // S538 (Nic): storage is HARD-locked out of short-term rental — the
    // block holds even when the allow-list is empty/unrestricted.
    if ((SHORT_STAY_LOCKED_UNIT_TYPES as readonly string[]).includes(unit.unit_type)
        && (body.leaseType === 'nightly' || body.leaseType === 'weekly')) {
      throw new AppError(400, `${unit.unit_type} units cannot be booked short-term`)
    }
    // Check allowed lease types. An EMPTY list means unrestricted (a manual
    // staff reservation can book any unit) — only enforce when the unit has an
    // explicit allow-list configured.
    if (unit.lease_types_allowed?.length && !unit.lease_types_allowed.includes(body.leaseType)) {
      throw new AppError(400, `Lease type '${body.leaseType}' not allowed for ${unit.unit_type} units`)
    }

    // Conflicts (bookings + active leases): the shared predicate in
    // services/unitAvailability — same rule GET /units/available filters by.
    const conflict = await findStayConflict(unit.id, { checkIn: body.checkIn, checkOut: body.checkOut })
    if (conflict) throw new AppError(409, STAY_CONFLICT_MESSAGE[conflict])

    const nights = dayDiff(body.checkIn, body.checkOut)
    // Price authoritatively from the UNIT's stay rates, falling back to the
    // PROPERTY default per rate when the unit hasn't been configured separately
    // (Nic: rates are uniform by default — RV spots/storage share a price — but
    // a landlord can override a specific unit, e.g. pull-through vs back-in RV
    // sites). Tier by length, prorated, short-term tax (tax stays property-level).
    // Falls back to a client-supplied total only when no rate is set at all.
    const prop = await queryOne<any>(
      'SELECT nightly_rate, weekly_rate, monthly_rate, short_term_tax_rate FROM properties WHERE id=$1',
      [unit.property_id])
    const staffMonthlyRate = unit.monthly_rate ?? prop?.monthly_rate
    const price = computeStayPrice(
      { nightly: unit.nightly_rate ?? prop?.nightly_rate,
        weekly:  unit.weekly_rate  ?? prop?.weekly_rate,
        monthly: staffMonthlyRate },
      Number(prop?.short_term_tax_rate || 0), nights)
    // S547: monthly-tier stays price on the calendar-aligned schedule (prorated
    // arrival/departure months, flat months between) — same rule everywhere.
    const total = price.tier === 'monthly' && staffMonthlyRate != null
      ? computeMonthlyStaySchedule(body.checkIn, body.checkOut, Number(staffMonthlyRate)).total
      : price.total > 0 ? price.total : (body.totalAmount || 0)
    // S526 (Nic): reservations carry ZERO platform fee — GAM's income is the
    // $2/occupied-unit monthly fee (services/platformFee.ts), not a booking cut.
    const platformFee = 0

    const booking = await queryOne<any>(`INSERT INTO unit_bookings
      (unit_id, landlord_id, tenant_id, guest_name, guest_email, guest_phone,
       lease_type, check_in, check_out, nights, nightly_rate, weekly_rate,
       total_amount, platform_fee, notes, source, required_site_layout, required_amp_service)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING *`,
      [unit.id, unit.landlord_id, body.tenantId ?? null, body.guestName ?? null, body.guestEmail ?? null,
       body.guestPhone ?? null, body.leaseType, body.checkIn, body.checkOut, nights,
       body.nightlyRate ?? unit.nightly_rate ?? null, body.weeklyRate ?? unit.weekly_rate ?? null,
       total, platformFee, body.notes ?? null, body.source ?? 'direct', body.requiredSiteLayout ?? 'none', body.requiredAmpService ?? 'none'])

    // S517: change-history (Master Schedule). Best-effort — never fail the booking.
    recordBookingEvent({
      bookingId: booking.id, unitId: unit.id, landlordId: unit.landlord_id,
      eventType: 'created', actorUserId: req.user!.userId,
      summary: `Reservation created for ${booking.guest_name || 'Guest'} (${body.checkIn}→${body.checkOut})`,
      detail: { check_in: body.checkIn, check_out: body.checkOut, lease_type: body.leaseType, source: body.source ?? 'direct' },
    }).catch((err) => logger.error({ err, bookingId: booking.id }, '[booking] event record failed'))

    // S526: 30+ day stays (7+ in weekly-lease mode) get a lease drafted
    // automatically for the landlord to review. Best-effort.
    maybeDraftLeaseFromBooking(booking.id)
      .catch((err) => logger.error({ err, bookingId: booking.id }, '[booking] lease draft failed'))

    // Booking guests with no GAM account get a stay-assistant link by email
    // (a host can also issue a QR from the booking). Best-effort — a missing
    // or failed token must never fail the booking itself.
    if (booking.guest_email) {
      sendBookingGuestAccessEmail({
        bookingId: booking.id,
        landlordId: unit.landlord_id,
        createdByUserId: req.user!.userId,
      }).catch((err) => logger.error({ err, bookingId: booking.id }, '[booking] guest access email failed'))
    }

    res.status(201).json({ success: true, data: booking })
  } catch (e) { next(e) }
})

// POST /api/units/:id/bookings/:bookingId/guest-access — issue (or re-issue)
// the guest's stay-assistant token and return the link + a QR for the host to
// show/print on-site. Optionally also emails the link to the guest. This is
// the QR/email delivery surface for the booking-guest agent.
unitsRouter.post('/:id/bookings/:bookingId/guest-access', requirePerm('guest_access'), async (req, res, next) => {
  try {
    const body = z.object({
      delivery: z.enum(['email', 'qr']).optional(),
      sendEmail: z.boolean().optional(),
    }).parse(req.body ?? {})

    const booking = await queryOne<any>(
      `SELECT b.id, b.landlord_id, b.guest_email
         FROM unit_bookings b WHERE b.id = $1 AND b.unit_id = $2`,
      [req.params.bookingId, req.params.id])
    if (!booking) throw new AppError(404, 'Booking not found')
    if (!canManageLandlordResource(req.user, booking.landlord_id)) throw new AppError(403, 'Forbidden')

    const issued = await issueBookingGuestToken({
      bookingId: booking.id,
      landlordId: booking.landlord_id,
      delivery: body.delivery ?? 'qr',
      createdByUserId: req.user!.userId,
    })
    const qrDataUrl = await bookingGuestQrDataUrl(issued.token)

    let emailed = false
    if (body.sendEmail && booking.guest_email) {
      const { emailBookingGuestAccess } = await import('../services/email')
      const ctx = await queryOne<any>(
        `SELECT b.guest_name, b.check_in, b.check_out, p.name AS property_name, u.unit_number
           FROM unit_bookings b
           LEFT JOIN units u ON u.id = b.unit_id
           LEFT JOIN properties p ON p.id = u.property_id
          WHERE b.id = $1`, [booking.id])
      await emailBookingGuestAccess({
        to: booking.guest_email,
        guestName: ctx?.guest_name ?? null,
        propertyName: ctx?.property_name ?? null,
        unitNumber: ctx?.unit_number ?? null,
        checkIn: ctx?.check_in,
        checkOut: ctx?.check_out,
        stayUrl: issued.url,
        expiresAt: issued.expiresAt,
        ctx: { landlordId: booking.landlord_id, bookingId: booking.id },
      })
      emailed = true
    }

    res.json({
      success: true,
      data: { url: issued.url, qrDataUrl, expiresAt: issued.expiresAt, emailed },
    })
  } catch (e) { next(e) }
})

// DELETE /api/units/:id/bookings/:bookingId/guest-access — revoke the guest's
// stay-assistant access. Kills EVERY outstanding link for the booking (each
// issue mints a fresh token without retiring the last), so this is the host's
// single kill switch. Same auth as issue. Idempotent: re-revoking returns 0.
unitsRouter.delete('/:id/bookings/:bookingId/guest-access', requirePerm('guest_access'), async (req, res, next) => {
  try {
    const booking = await queryOne<any>(
      `SELECT b.id, b.landlord_id
         FROM unit_bookings b WHERE b.id = $1 AND b.unit_id = $2`,
      [req.params.bookingId, req.params.id])
    if (!booking) throw new AppError(404, 'Booking not found')
    if (!canManageLandlordResource(req.user, booking.landlord_id)) throw new AppError(403, 'Forbidden')

    const { revoked } = await revokeBookingGuestTokens({
      bookingId: booking.id,
      landlordId: booking.landlord_id,
    })

    res.json({ success: true, data: { revoked } })
  } catch (e) { next(e) }
})

// GET /api/units/:id/bookings — list bookings for a unit.
// Catalog keys first (what the permissions page grants), legacy keys kept
// for existing scope rows. Property-locked workers may only read units at
// their assigned properties.
unitsRouter.get('/:id/bookings', requirePerm(
  'schedule.tab.timeline', 'schedule.tab.list', 'schedule.tab.units', 'bookings.view',
  'guests.check_in', 'guests.check_out', 'units.view_status', 'units.edit',
), async (req, res, next) => {
  try {
    const unit = await queryOne<any>('SELECT landlord_id, property_id FROM units WHERE id=$1', [req.params.id])
    if (!unit) throw new AppError(404, 'Unit not found')
    if (!canAccessLandlordResource(req.user, unit.landlord_id)) {
      throw new AppError(403, 'Forbidden')
    }
    await assertPropertyInScope(req.user, unit.property_id)
    // S313: JOIN properties to surface requires_booking_acknowledgment
    // per booking row. SchedulePage's "ack needed" badge (S200) reads
    // this flag from each booking; pre-S313 the column was undefined
    // on the response so the badge never rendered. Mirrors the same
    // JOIN already in bookings.ts § GET /bookings.
    const bookings = await query<any>(`
      SELECT b.*,
             u.unit_number,
             u.unit_type,
             p.requires_booking_acknowledgment
      FROM unit_bookings b
      JOIN units u ON u.id = b.unit_id
      JOIN properties p ON p.id = u.property_id
      WHERE b.unit_id=$1
      ORDER BY b.check_in DESC`, [req.params.id])
    res.json({ success: true, data: bookings })
  } catch (e) { next(e) }
})

// PATCH /api/units/:id/bookings/:bookingId — update booking (status, move dates, swap unit)
unitsRouter.patch('/:id/bookings/:bookingId', requirePerm('schedule.edit_reservation'), async (req, res, next) => {
  try {
    const { status, notes, checkIn, checkOut, unitId, guestName, guestEmail, guestPhone, requiredSiteLayout, requiredAmpService, lockedToUnit } = req.body
    if (requiredSiteLayout != null && !RV_SITE_LAYOUTS.includes(requiredSiteLayout)) {
      throw new AppError(400, `Invalid requiredSiteLayout '${requiredSiteLayout}'`)
    }
    if (requiredAmpService != null && !RV_AMP_SERVICES.includes(requiredAmpService)) {
      throw new AppError(400, `Invalid requiredAmpService '${requiredAmpService}'`)
    }
    const booking = await queryOne<any>('SELECT * FROM unit_bookings WHERE id=$1', [req.params.bookingId])
    if (!booking) throw new AppError(404, 'Booking not found')
    if (!canManageLandlordResource(req.user, booking.landlord_id)) {
      throw new AppError(403, 'Forbidden')
    }
    // Property-locked workers may only edit reservations at their properties.
    const bookingUnit = await queryOne<any>('SELECT property_id FROM units WHERE id=$1', [booking.unit_id])
    await assertPropertyInScope(req.user, bookingUnit?.property_id)

    let newUnitId = unitId || booking.unit_id
    const newCheckIn = checkIn || booking.check_in
    const newCheckOut = checkOut || booking.check_out
    const datesOrUnitChanged = !!(checkIn || checkOut || unitId)
    // W-20: set when the extension fallback moved the EXTENDING guest to a
    // different site — surfaced in the response so staff can tell them.
    let extendedGuestMovedTo: { unitId: string; unitNumber: string } | null = null

    // If dates or unit changed, verify target unit exists, belongs to the
    // same landlord, and check for conflicts. Repricing below reads its rates.
    let targetUnit: any = null
    if (datesOrUnitChanged) {
      targetUnit = await queryOne<any>('SELECT * FROM units WHERE id=$1 AND landlord_id=$2', [newUnitId, booking.landlord_id])
      if (!targetUnit) throw new AppError(404, 'Target unit not found')
      // Moving to another unit: the destination property must also be in scope.
      if (unitId && unitId !== booking.unit_id) {
        await assertPropertyInScope(req.user, targetUnit.property_id)
      }

      // Shared predicate (services/unitAvailability): bookings + active
      // leases, excluding this booking and any lease drafted from it.
      let conflict = await findStayConflict(newUnitId, {
        checkIn: newCheckIn, checkOut: newCheckOut, excludeBookingId: booking.id,
      })
      // W-20 extension protection (Nic): the sitting guest extending on
      // their OWN site takes priority — the incoming reservation gets
      // relocated to a compatible open site (it hasn't been revealed yet,
      // so the incoming guest never sees the move). Only for same-unit
      // date changes; a deliberate unit swap into a conflict still 409s.
      if (conflict === 'booking' && !unitId && (checkIn || checkOut)) {
        const { relocateBlockingBookings, rankUnitsBestFit } =
          await import('../services/scheduleCompression')
        const relo = await relocateBlockingBookings(
          newUnitId, { checkIn: newCheckIn, checkOut: newCheckOut }, booking.id)
        if (relo.ok) {
          conflict = await findStayConflict(newUnitId, {
            checkIn: newCheckIn, checkOut: newCheckOut, excludeBookingId: booking.id,
          })
        } else if (booking.locked_to_unit) {
          // S547: a locked (snowbird) reservation never moves — not even by
          // its own extension. The extension simply fails on conflict.
          throw new AppError(409, `Cannot extend: ${relo.reason}, and this reservation is locked to its site`)
        } else {
          // BACKUP (Nic — busy seasons are competitive): the incoming
          // reservation can't move, so try moving the EXTENDING guest
          // instead — any compatible site where the WHOLE extended stay
          // fits. Their site was already revealed, but this move is their
          // own choice: extend-and-relocate beats no-extension.
          const candidates = await query<any>(`
            SELECT id, unit_number, rv_site_layout, rv_amp_service
              FROM units
             WHERE property_id = $1 AND id != $2
               AND is_bookable = TRUE
               AND (lease_types_allowed && ARRAY['nightly','weekly']::text[])
             ORDER BY unit_number`, [targetUnit.property_id, booking.unit_id])
          const compatible = candidates.filter((c: any) =>
            !isSiteLayoutMismatch(booking.required_site_layout, c.rv_site_layout) &&
            !isAmpServiceMismatch(booking.required_amp_service, c.rv_amp_service))
          const ranked = await rankUnitsBestFit(
            compatible.map((c: any) => c.id),
            { checkIn: newCheckIn, checkOut: newCheckOut })
          if (!ranked.length) {
            throw new AppError(409,
              `Cannot extend: ${relo.reason}, and no open site fits the extended stay`)
          }
          newUnitId = ranked[0]
          const dest = candidates.find((c: any) => c.id === ranked[0])
          extendedGuestMovedTo = { unitId: ranked[0], unitNumber: dest?.unit_number ?? '' }
          targetUnit = await queryOne<any>(
            'SELECT * FROM units WHERE id=$1 AND landlord_id=$2', [newUnitId, booking.landlord_id])
          logger.info(`[extend] extending guest moves sites: booking=${booking.id} → ${dest?.unit_number}`)
          conflict = null
        }
      }
      if (conflict) throw new AppError(409, STAY_CONFLICT_MESSAGE[conflict])
    }

    // S559: same-day turnover guard — do NOT check a new guest into a spot
    // whose previous occupant's submeter hasn't been read yet, or the two
    // stays' usage smears together. Surface the pending read so the desk can
    // take it inline (blind) and retry; a landlord (properties.edit) may
    // override for a broken/unreadable meter so a paying guest is never
    // stranded. Broken meters are already excluded (they bill from comparables).
    if (status === 'checked_in' && booking.status !== 'checked_in') {
      const pending = await unitPendingReads(newUnitId)
      const isOwner = ['landlord', 'admin', 'super_admin'].includes(req.user!.role)
      const canOverride = isOwner || (req.user!.permissions as any)?.['properties.edit'] === true
      if (pending.length > 0 && !(req.body.overrideMeterRead && canOverride)) {
        return res.status(409).json({
          success: false,
          code: 'meter_read_due',
          error: 'A closing meter read is due on this spot before check-in. Take the read, then check the guest in.',
          meters: pending,
          canOverride,
        })
      }
    }

    // S553: newCheckIn/newCheckOut mix 'YYYY-MM-DD' strings (from the
    // request) with pg DATE Dates (from the row) — dayDiff is immune to
    // the representation; raw ms math was host-timezone-dependent.
    const nights = dayDiff(newCheckIn, newCheckOut)

    // Reprice when dates or the unit change — the stored total must never drift
    // from the new stay. Same unit-rate-then-property-default rule as create.
    // A pure status/notes/guest edit keeps the existing total.
    let newTotal: number | null = null
    if (datesOrUnitChanged) {
      const prop = await queryOne<any>(
        'SELECT nightly_rate, weekly_rate, monthly_rate, short_term_tax_rate FROM properties WHERE id=$1',
        [targetUnit.property_id])
      const monthlyRate = targetUnit.monthly_rate ?? prop?.monthly_rate
      const price = computeStayPrice(
        { nightly: targetUnit.nightly_rate ?? prop?.nightly_rate,
          weekly:  targetUnit.weekly_rate  ?? prop?.weekly_rate,
          monthly: monthlyRate },
        Number(prop?.short_term_tax_rate || 0), nights)
      // S547: monthly-tier stays reprice on the calendar-aligned schedule —
      // same rule as booking creation, so edits never drift from invoices.
      if (price.tier === 'monthly' && monthlyRate != null) {
        newTotal = computeMonthlyStaySchedule(newCheckIn, newCheckOut, Number(monthlyRate)).total
      } else if (price.total > 0) newTotal = price.total
    }

    const updated = await queryOne<any>(`
      UPDATE unit_bookings
      SET status=COALESCE($1,status), notes=COALESCE($2,notes),
          unit_id=$3, check_in=$4, check_out=$5, nights=$6,
          guest_name=COALESCE($8,guest_name),
          guest_email=COALESCE($9,guest_email),
          guest_phone=COALESCE($10,guest_phone),
          total_amount=COALESCE($11,total_amount),
          platform_fee=COALESCE($12,platform_fee),
          required_site_layout=COALESCE($13,required_site_layout),
          required_amp_service=COALESCE($14,required_amp_service),
          locked_to_unit=COALESCE($15,locked_to_unit),
          updated_at=NOW()
      WHERE id=$7 RETURNING *`,
      [status||null, notes||null, newUnitId, newCheckIn, newCheckOut, nights, booking.id,
       guestName ?? null, guestEmail ?? null, guestPhone ?? null,
       // Reprice zeroes the fee too (S526: reservations carry no platform fee).
       newTotal, newTotal != null ? 0 : null, requiredSiteLayout ?? null, requiredAmpService ?? null,
       typeof lockedToUnit === 'boolean' ? lockedToUnit : null])

    // S526: an extension can push the stay over the lease threshold (30d, or
    // 7d in weekly-lease mode) — re-check on every edit. Best-effort.
    maybeDraftLeaseFromBooking(booking.id)
      .catch((err) => logger.error({ err, bookingId: booking.id }, '[booking] lease draft failed'))

    // S548 (Nic): the Master Schedule is the source of truth for what a
    // long-stay guest owes. A date change flows into the lease: pending
    // drafts follow the dates; an active lease's end moves, no-longer-owed
    // pending rent is dropped, and rent paid past the new end is banked as
    // a prepaid credit that nets against the final bill. Best-effort.
    if (datesOrUnitChanged) {
      syncLeaseWithBookingDates(booking.id)
        .catch((err) => logger.error({ err, bookingId: booking.id }, '[booking] lease-billing sync failed'))
    }

    // S517: append the change-history events (moved / dates_changed / cancelled
    // / status_changed) by diffing old → new. Best-effort.
    recordBookingChange(booking, updated, req.user!.userId).catch(err =>
      logger.error({ err, bookingId: booking.id }, '[booking] change event record failed'))

    // S517: a cancellation frees the dates — promote the next waitlister
    // (best-effort; mints a 1-hour claim link + emails them).
    if (status === 'cancelled' && booking.status !== 'cancelled') {
      promoteNextWaitlister(booking.unit_id).catch(err =>
        logger.error({ err, unit_id: booking.unit_id }, '[booking] waitlist promote on cancel failed'))
    }
    res.json({
      success: true,
      data: updated,
      // W-20: non-null when the extension moved the EXTENDING guest to a
      // new site — the UI tells staff so they can coordinate the physical
      // move with the guest.
      extendedGuestMovedTo,
    })
  } catch (e) { next(e) }
})

// PATCH /api/units/:id/bookings/:bookingId/acknowledge — S179 / B3.
// Stamps acknowledgment_signed_at = NOW() once landlord/staff confirms the
// guest signed the property rules. The toggle on properties
// (requires_booking_acknowledgment) governs whether the booking should be
// gated on this; today the column is informational and surface UI badging
// is a follow-on session.
unitsRouter.patch('/:id/bookings/:bookingId/acknowledge', requirePerm('bookings.acknowledge'), async (req, res, next) => {
  try {
    const booking = await queryOne<any>('SELECT * FROM unit_bookings WHERE id=$1', [req.params.bookingId])
    if (!booking) throw new AppError(404, 'Booking not found')
    if (!canManageLandlordResource(req.user, booking.landlord_id)) {
      throw new AppError(403, 'Forbidden')
    }
    if (booking.acknowledgment_signed_at) {
      // Idempotent: re-acknowledging is a no-op rather than an error so a
      // double-click on the staff UI doesn't bounce.
      return res.json({ success: true, data: booking })
    }
    const updated = await queryOne<any>(`
      UPDATE unit_bookings
         SET acknowledgment_signed_at = NOW(),
             updated_at               = NOW()
       WHERE id = $1
       RETURNING *`,
      [booking.id])
    res.json({ success: true, data: updated })
  } catch (e) { next(e) }
})

// GET /api/units/schedule — master schedule across all units for a landlord.
// Perm keys: the catalog schedule.tab.* / bookings.view keys (what the
// permissions page actually grants — the Front Desk preset holds these) plus
// the legacy pre-catalog keys so existing scope rows keep working.
// Property-scoped: a property-locked worker only sees units/bookings/leases
// at their assigned properties.
unitsRouter.get('/schedule/master', requirePerm(
  'schedule.tab.timeline', 'schedule.tab.list', 'schedule.tab.units', 'schedule.tab.history',
  'bookings.view',
  'guests.check_in', 'units.view_status', 'units.edit',
), async (req, res, next) => {
  try {
    const { from, to, unitType } = req.query
    const fromDate = from || new Date().toISOString().split('T')[0]
    const toDate = to || new Date(Date.now() + 30*24*60*60*1000).toISOString().split('T')[0]

    // S400 fix: same class as GET / above. For team-role callers (PM /
    // maintenance_worker / onsite_manager) req.user.profileId is the user_id,
    // not the landlord_id, so the WHERE landlord_id=$1 filter returned an
    // empty schedule. Resolve to landlordId for team members.
    const callerLandlordId = req.user!.role === 'landlord'
      ? req.user!.profileId
      : req.user!.landlordId
    const scopedIds = await getScopedPropertyIds(req.user)

    const units = await query<any>(`
      SELECT u.id, u.unit_number, u.unit_type, u.status, u.rent_amount,
        u.nightly_rate, u.weekly_rate, u.monthly_rate, u.is_bookable, u.lease_types_allowed,
        u.rv_site_layout, u.rv_amp_service,
        u.check_in_time, u.check_out_time, u.amenities, u.unit_description,
        p.id as property_id, p.name as property_name,
        p.nightly_rate as property_nightly_rate, p.weekly_rate as property_weekly_rate,
        p.monthly_rate as property_monthly_rate, p.short_term_tax_rate as property_tax_rate,
        vuo.primary_first_name as tenant_first,
        vuo.primary_last_name as tenant_last
      FROM units u
      JOIN properties p ON p.id = u.property_id
      LEFT JOIN v_unit_occupancy vuo ON vuo.unit_id = u.id
      WHERE u.landlord_id=$1
        AND ($2::uuid[] IS NULL OR u.property_id = ANY($2::uuid[]))
        ${unitType ? "AND u.unit_type=$3" : ""}
      ORDER BY u.unit_type, p.name, u.unit_number`,
      unitType ? [callerLandlordId, scopedIds, unitType] : [callerLandlordId, scopedIds])

    // Get all bookings in range. S200: include the property's
    // requires_booking_acknowledgment flag so the schedule tile can
    // render an ack-needed badge (companion to S191's BookingsPage
    // surface).
    const bookings = await query<any>(`
      SELECT b.*, u.unit_number, u.unit_type, p.name as property_name,
             p.requires_booking_acknowledgment
      FROM unit_bookings b
      JOIN units u ON u.id = b.unit_id
      JOIN properties p ON p.id = u.property_id
      WHERE b.landlord_id=$1 AND b.status NOT IN ('cancelled')
        AND b.check_out >= $2 AND b.check_in <= $3
        AND ($4::uuid[] IS NULL OR u.property_id = ANY($4::uuid[]))
      ORDER BY b.check_in`, [callerLandlordId, fromDate, toDate, scopedIds])

    // Get active leases in range
    const leases = await query<any>(`
      SELECT l.*, u.unit_number, u.unit_type, p.name as property_name,
        vlat.first_name, vlat.last_name, vlat.email, vlat.phone
      FROM leases l
      JOIN units u ON u.id = l.unit_id
      JOIN properties p ON p.id = u.property_id
      LEFT JOIN LATERAL (
        -- S527 W-55: email/phone too — the schedule detail popup shows the
        -- same contact fields for leases as for reservations.
        SELECT first_name, last_name, email, phone
        FROM v_lease_active_tenants
        WHERE lease_id = l.id AND role = 'primary'
        LIMIT 1
      ) vlat ON TRUE
      WHERE u.landlord_id=$1 AND l.status='active'
        -- S527 fix: NULL end_date = open-ended (month-to-month) lease. The
        -- old "end_date >= $2" dropped those rows, so occupied units looked
        -- EMPTY on the schedule (while the booking guard rightly blocked
        -- them — "conflict on an empty spot" reports).
        AND (l.end_date IS NULL OR l.end_date >= $2) AND l.start_date <= $3
        AND ($4::uuid[] IS NULL OR u.property_id = ANY($4::uuid[]))
      ORDER BY l.start_date`, [callerLandlordId, fromDate, toDate, scopedIds])

    res.json({ success: true, data: { units, bookings, leases, range: { from: fromDate, to: toDate } } })
  } catch (e) { next(e) }
})

// GET /api/units/schedule/history — S517 / #10. Master-schedule change log:
// every reservation create / move / date-change / cancel, newest first.
unitsRouter.get('/schedule/history', requirePerm(
  'schedule.tab.history',
  'guests.check_in', 'units.view_status', 'units.edit',
), async (req, res, next) => {
  try {
    const callerLandlordId = req.user!.role === 'landlord' ? req.user!.profileId : req.user!.landlordId
    const scopedIds = await getScopedPropertyIds(req.user)
    const limit = Math.min(200, Math.max(1, parseInt(String(req.query.limit ?? '100')) || 100))
    const events = await query<any>(`
      SELECT e.id, e.event_type, e.summary, e.detail, e.created_at,
             u.unit_number, p.name AS property_name,
             a.first_name AS actor_first, a.last_name AS actor_last
        FROM unit_booking_events e
        JOIN units u ON u.id = e.unit_id
        JOIN properties p ON p.id = u.property_id
        LEFT JOIN users a ON a.id = e.actor_user_id
       WHERE e.landlord_id = $1
         AND ($3::uuid[] IS NULL OR u.property_id = ANY($3::uuid[]))
       ORDER BY e.created_at DESC
       LIMIT $2`, [callerLandlordId, limit, scopedIds])
    res.json({ success: true, data: events })
  } catch (e) { next(e) }
})


// ─── UNIT ACTIVATION / AVAILABILITY (landlord-controlled) ──────

// POST /api/units/:id/mark-available — vacant → available (listed, no billing yet)
unitsRouter.post('/:id/mark-available', requirePerm('units.manage_lifecycle'), async (req, res, next) => {
  try {
    const unit = await queryOne<any>('SELECT * FROM units WHERE id=$1', [req.params.id])
    if (!unit) throw new AppError(404, 'Unit not found')
    if (!canManageLandlordResource(req.user, unit.landlord_id)) {
      throw new AppError(403, 'Forbidden')
    }
    if (unit.status !== 'vacant') throw new AppError(400, `Cannot mark available from status '${unit.status}'. Only vacant units can be marked available.`)
    const updated = await queryOne<any>(`UPDATE units SET status='available', updated_at=NOW() WHERE id=$1 RETURNING *`, [req.params.id])
    res.json({ success: true, data: updated })
  } catch (e) { next(e) }
})

// POST /api/units/:id/mark-vacant — available → vacant (withdraw from listing)
unitsRouter.post('/:id/mark-vacant', requirePerm('units.manage_lifecycle'), async (req, res, next) => {
  try {
    const unit = await queryOne<any>('SELECT * FROM units WHERE id=$1', [req.params.id])
    if (!unit) throw new AppError(404, 'Unit not found')
    if (!canManageLandlordResource(req.user, unit.landlord_id)) {
      throw new AppError(403, 'Forbidden')
    }
    if (unit.status !== 'available') throw new AppError(400, `Cannot mark vacant from status '${unit.status}'. Only available units can be marked vacant.`)
    const updated = await queryOne<any>(`UPDATE units SET status='vacant', updated_at=NOW() WHERE id=$1 RETURNING *`, [req.params.id])
    res.json({ success: true, data: updated })
  } catch (e) { next(e) }
})

// POST /api/units/:id/activate — gate: lease + tenant + rent. Optional scheduledFor ISO datetime (UTC).
// S128: opened to property_manager with units.edit. Activation kicks off
// billing but is fundamentally a unit-state change — same operational
// surface as PATCH /:id/status, which is already units.edit.
unitsRouter.post('/:id/activate', requirePerm('units.manage_lifecycle'), async (req, res, next) => {
  try {
    const body = z.object({ scheduledFor: z.string().datetime().optional() }).parse(req.body)
    const unit = await queryOne<any>('SELECT * FROM units WHERE id=$1', [req.params.id])
    if (!unit) throw new AppError(404, 'Unit not found')
    if (!canManageLandlordResource(req.user, unit.landlord_id, ['property_manager'])) {
      throw new AppError(403, 'Forbidden')
    }
    if (unit.status === 'active') throw new AppError(400, 'Unit is already active')
    if (!unit.rent_amount || unit.rent_amount <= 0) throw new AppError(400, 'Cannot activate without a rent amount')

    const activeLease = await queryOne<any>(`SELECT id FROM leases WHERE unit_id=$1 AND status='active' ORDER BY created_at DESC LIMIT 1`, [req.params.id])
    if (!activeLease) throw new AppError(400, 'Cannot activate without an active lease')

    if (body.scheduledFor) {
      const when = new Date(body.scheduledFor)
      if (isNaN(when.getTime())) throw new AppError(400, 'Invalid scheduledFor datetime')
      if (when.getTime() <= Date.now()) throw new AppError(400, 'scheduledFor must be in the future')
      const updated = await queryOne<any>(`UPDATE units SET scheduled_activation_at=$1, scheduled_activation_by=$2, updated_at=NOW() WHERE id=$3 RETURNING *`, [when, req.user!.userId, req.params.id])
      return res.json({ success: true, data: updated, scheduled: true })
    }

    // Immediate activation
    const updated = await queryOne<any>(`UPDATE units SET status='active', scheduled_activation_at=NULL, scheduled_activation_by=NULL, updated_at=NOW() WHERE id=$1 RETURNING *`, [req.params.id])
    res.json({ success: true, data: updated, scheduled: false })
  } catch (e) { next(e) }
})

// POST /api/units/:id/cancel-scheduled-activation
// S128: opened to property_manager with units.edit (same surface as activate).
unitsRouter.post('/:id/cancel-scheduled-activation', requirePerm('units.manage_lifecycle'), async (req, res, next) => {
  try {
    const unit = await queryOne<any>('SELECT * FROM units WHERE id=$1', [req.params.id])
    if (!unit) throw new AppError(404, 'Unit not found')
    if (!canManageLandlordResource(req.user, unit.landlord_id, ['property_manager'])) {
      throw new AppError(403, 'Forbidden')
    }
    if (!unit.scheduled_activation_at) throw new AppError(400, 'No scheduled activation to cancel')
    const updated = await queryOne<any>(`UPDATE units SET scheduled_activation_at=NULL, scheduled_activation_by=NULL, updated_at=NOW() WHERE id=$1 RETURNING *`, [req.params.id])
    res.json({ success: true, data: updated })
  } catch (e) { next(e) }
})
