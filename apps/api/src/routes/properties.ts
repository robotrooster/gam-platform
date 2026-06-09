import { Router } from 'express'
import multer from 'multer'
import path from 'path'
import fs from 'fs'
import { z } from 'zod'
import { normalizeAddress } from '../lib/address'
import { formatPropertyInput, formatName, formatStreet, formatStreet2, formatCity, formatState, formatZip } from '../lib/format'
import { db, query, queryOne, getClient } from '../db'
import { requireAuth, requireLandlord, requirePerm } from '../middleware/auth'
import { canAccessLandlordResource, canManageLandlordResource } from '../middleware/scope'
import { AppError } from '../middleware/errorHandler'
import {
  FEE_PAYER_VALUES,
  PLACEMENT_FEE_TYPE_VALUES,
  PropertyReviewStatus,
} from '@gam/shared'
import { logger } from '../lib/logger'

export const propertiesRouter = Router()
export const publicPropertiesRouter = Router()
propertiesRouter.use(requireAuth)

propertiesRouter.get('/', async (req, res, next) => {
  try {
    const isAdmin = req.user!.role === 'admin' || req.user!.role === 'super_admin'
    const filter = isAdmin ? '' : 'WHERE p.landlord_id = $1'
    const qParams = isAdmin ? [] : [req.user!.profileId]
    // S355 fix: property_allocation_rules has no `id` column (primary key
    // is `property_id`, 1:1 with properties). Pre-S355 the GROUP BY r.id
    // crashed with "column r.id does not exist" on every list call where
    // any property had an allocation_rule row. Group by r.property_id
    // instead — the underlying PK that's referenced via the JOIN.
    const props = await query<any>(`
      SELECT p.*, COUNT(u.id)::int AS total_units,
        COUNT(u.id) FILTER (WHERE u.status='active')::int AS occupied_units,
        COUNT(u.id) FILTER (WHERE u.status='vacant')::int AS vacant_units,
        to_jsonb(r.*) AS allocation_rule
      FROM properties p
      LEFT JOIN units u ON u.property_id = p.id
      LEFT JOIN property_allocation_rules r ON r.property_id = p.id
      ${filter}
      GROUP BY p.id, r.property_id
      ORDER BY p.name`, qParams)
    res.json({ success: true, data: props })
  } catch (e) { next(e) }
})

propertiesRouter.post('/', requirePerm('properties.create'), async (req, res, next) => {
  const client = await getClient()
  try {
    // S319: wire-format convention — camelCase request bodies.
    const rawBody = z.object({
      name:    z.string().min(1),
      street1: z.string(), street2: z.string().optional(),
      city: z.string(), state: z.string(), zip: z.string(),
      type: z.enum(['residential','rv_longterm','rv_weekly','rv_nightly','mixed']).default('residential').optional(),
      unitTypes: z.array(z.string()).optional(),
      // S179 / B3: per-property booking acknowledgment toggle.
      requiresBookingAcknowledgment: z.boolean().optional(),
      // 16a: allocation rule required on every property creation.
      // S116: three independent fee toggles replace bankingFeePayer.
      // Legacy callers passing bankingFeePayer auto-mirror into ACH+card.
      allocationRule: z.object({
        achFeePayer:        z.enum(FEE_PAYER_VALUES).optional(),
        cardFeePayer:       z.enum(FEE_PAYER_VALUES).optional(),
        platformFeePayer:   z.enum(FEE_PAYER_VALUES).default('landlord'),
        // Deprecated S116 — accepted for backward compat; if set, mirrors
        // into achFeePayer + cardFeePayer when those aren't supplied.
        bankingFeePayer:    z.enum(FEE_PAYER_VALUES).optional(),
        rentPercent: z.number().nullable().optional(),
        rentPercentFloor: z.number().nullable().optional(),
        rentPercentCeiling: z.number().nullable().optional(),
        flatMonthlyFee: z.number().nullable().optional(),
        perUnitFee: z.number().nullable().optional(),
        placementFeeType: z.enum(PLACEMENT_FEE_TYPE_VALUES).nullable().optional(),
        placementFeeValue: z.number().nullable().optional(),
        maintenanceMarkupPercent: z.number().nullable().optional(),
        ownerBankAccountId: z.string().uuid().nullable().optional(),
      }).refine(
        ar => (ar.achFeePayer && ar.cardFeePayer) || ar.bankingFeePayer,
        { message: 'Provide achFeePayer + cardFeePayer (or legacy bankingFeePayer)' }
      ),
    }).parse(req.body)
    // Quiet formatter — clean up capitalization, state, zip before storage
    const body = {
      ...rawBody,
      name:    formatName(rawBody.name),
      street1: formatStreet(rawBody.street1),
      street2: rawBody.street2 ? formatStreet2(rawBody.street2) : rawBody.street2,
      city:    formatCity(rawBody.city),
      state:   formatState(rawBody.state),
      zip:     formatZip(rawBody.zip),
    }
    const ar = body.allocationRule

    await client.query('BEGIN')

    // Property INSERT — owner_user_id + managed_by_user_id default to the
    // creating user (resolved from landlords.user_id). Owner-self-managed
    // is the default; managed_by can be re-pointed later when handing a
    // property over to a separate PM user.
    const propRes = await client.query<any>(`
      INSERT INTO properties
        (landlord_id, name, street1, street2, city, state, zip, type, unit_types,
         requires_booking_acknowledgment,
         owner_user_id, managed_by_user_id)
      VALUES
        ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
         (SELECT user_id FROM landlords WHERE id=$1),
         (SELECT user_id FROM landlords WHERE id=$1))
      RETURNING *`,
      [req.user!.profileId, body.name, body.street1, body.street2 ?? null,
       body.city, body.state, body.zip, body.type || 'mixed', body.unitTypes || [],
       body.requiresBookingAcknowledgment ?? false])
    const prop = propRes.rows[0]

    // S66: validate ownerBankAccountId (if provided) belongs to the
    // property's owner_user_id. The DB FK only enforces existence, not
    // ownership — same-user check has to happen in app code.
    if (ar.ownerBankAccountId) {
      const ba = await client.query<{ user_id: string; status: string }>(
        `SELECT user_id, status FROM user_bank_accounts WHERE id=$1`,
        [ar.ownerBankAccountId]
      )
      if (ba.rowCount === 0) {
        throw new AppError(400, 'Bank account not found')
      }
      if (ba.rows[0].user_id !== prop.owner_user_id) {
        throw new AppError(403, 'Bank account does not belong to property owner')
      }
      if (ba.rows[0].status !== 'active') {
        throw new AppError(400, 'Bank account is archived')
      }
    }

    // Allocation rule INSERT — 1:1 with property.
    // S116: three independent fee toggles. Legacy bankingFeePayer (if
    // sent) mirrors into ach + card when those aren't supplied.
    const achFeePayer       = ar.achFeePayer ?? ar.bankingFeePayer ?? 'landlord'
    const cardFeePayer      = ar.cardFeePayer ?? ar.bankingFeePayer ?? 'landlord'
    const platformFeePayer  = ar.platformFeePayer ?? 'landlord'
    await client.query(`
      INSERT INTO property_allocation_rules
        (property_id, ach_fee_payer, card_fee_payer, platform_fee_payer,
         rent_percent, rent_percent_floor, rent_percent_ceiling,
         flat_monthly_fee, per_unit_fee,
         placement_fee_type, placement_fee_value,
         maintenance_markup_percent, owner_bank_account_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [prop.id, achFeePayer, cardFeePayer, platformFeePayer,
       ar.rentPercent ?? null, ar.rentPercentFloor ?? null, ar.rentPercentCeiling ?? null,
       ar.flatMonthlyFee ?? null, ar.perUnitFee ?? null,
       ar.placementFeeType ?? null, ar.placementFeeValue ?? null,
       ar.maintenanceMarkupPercent ?? null, ar.ownerBankAccountId ?? null])

    await client.query('COMMIT')

    // Silent duplicate-address check → flags for admin review
    try {
      const key = normalizeAddress({ street1: body.street1, city: body.city, state: body.state, zip: body.zip })
      const [, street, city, state, zip] = key.match(/^(.*)\|(.*)\|(.*)\|(.*)$/) || []
      if (street && zip) {
        const dupes = await query<any>(`
          SELECT id, landlord_id FROM properties
          WHERE id <> $1
            AND LOWER(TRIM(REGEXP_REPLACE(street1,'\\s+',' ','g'))) LIKE $2
            AND LOWER(TRIM(city))=$3
            AND LOWER(TRIM(state))=$4
            AND LEFT(TRIM(zip),5)=$5
          LIMIT 5`,
          [prop.id, '%'+street.replace(/[%_]/g,'')+'%', city, state, zip])
        // Refine with exact normalized match (cheap, in JS)
        const matches: any[] = []
        for (const d of dupes) {
          const other = await queryOne<any>('SELECT street1,city,state,zip FROM properties WHERE id=$1',[d.id])
          if (other && normalizeAddress(other) === key) matches.push(d)
        }
        if (matches.length > 0) {
          const flaggedStatus: PropertyReviewStatus = 'pending_review'
          await query(`UPDATE properties SET review_status=$1 WHERE id=$2`, [flaggedStatus, prop.id])
          for (const m of matches) {
            await query(`
              INSERT INTO property_duplicate_flags (property_id, conflicting_property_id, reason, normalized_key)
              VALUES ($1,$2,'duplicate_address',$3)`,
              [prop.id, m.id, key])
          }
        }
      }
    } catch (flagErr) {
      logger.error({ err: flagErr, ctx: prop.id }, '[duplicate-flag] failed for property')
      // Non-fatal — property already created, admin can rescan later
    }

    res.status(201).json({ success: true, data: prop })
  } catch (e) {
    try { await client.query('ROLLBACK') } catch {}
    next(e)
  } finally {
    client.release()
  }
})

// S399 fix: /applications declared BEFORE GET /:id so Express doesn't
// match `applications` as the :id param. Pre-fix the dedicated
// /applications handler at the bottom of this file was unreachable —
// requests hit GET /:id first which tried to query the literal string
// 'applications' as a UUID and returned 500. The handler body lives
// further down; this is just the routing-order fix.

propertiesRouter.get('/applications', requirePerm('tenants.create'), async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT ua.*, u.unit_number, p.name AS property_name
       FROM unit_applications ua
       LEFT JOIN units u ON u.id = ua.unit_id
       LEFT JOIN properties p ON p.id = u.property_id
       WHERE ua.landlord_id = $1
       ORDER BY ua.created_at DESC`,
      [req.user!.profileId]
    )
    res.json({ success: true, data: rows })
  } catch (e) { next(e) }
})

propertiesRouter.get('/:id', async (req, res, next) => {
  try {
    const p = await queryOne<any>(`SELECT * FROM properties WHERE id=$1`,[req.params.id])
    if (!p) throw new AppError(404,'Property not found')
    if (!canAccessLandlordResource(req.user, p.landlord_id)) throw new AppError(403, 'Forbidden')
    res.json({ success: true, data: p })
  } catch (e) { next(e) }
})

// ─────────────────────────────────────────────────────────────
// PROPERTY FEE SCHEDULE (S154)
// Anti-discrimination model: per-property standard fees that
// pre-populate new lease documents. Lease remains the legal
// contract; this is the policy.
// ─────────────────────────────────────────────────────────────

// GET /api/properties/:id/fee-schedule — list rows for a property
propertiesRouter.get('/:id/fee-schedule', async (req, res, next) => {
  try {
    const p = await queryOne<any>(`SELECT id, landlord_id FROM properties WHERE id=$1`, [req.params.id])
    if (!p) throw new AppError(404, 'Property not found')
    if (!canAccessLandlordResource(req.user, p.landlord_id)) throw new AppError(403, 'Forbidden')

    const rows = await query<any>(
      `SELECT id, fee_type, slot_index, description, amount, is_refundable, due_timing, created_at, updated_at
         FROM property_fee_schedules
        WHERE property_id = $1
        ORDER BY fee_type, slot_index`,
      [req.params.id],
    )
    res.json({ success: true, data: rows })
  } catch (e) { next(e) }
})

// POST /api/properties/:id/fee-schedule — upsert a row
// (single-instance fee_types: slot_index implicit 0; other_fee:
// caller passes slot_index)
const feeRowSchema = z.object({
  feeType: z.enum([
    'pet_deposit', 'key_deposit', 'cleaning_deposit',
    'move_in_fee', 'cleaning_fee', 'pet_fee', 'application_fee',
    'amenity_fee', 'hoa_transfer_fee', 'lease_prep_fee',
    'pet_rent', 'parking_rent', 'storage_rent', 'amenity_fee_monthly',
    'trash_fee', 'pest_control_fee', 'technology_fee',
    'last_month_rent', 'early_termination_fee', 'other_fee',
  ]),
  slotIndex: z.number().int().min(0).optional(),
  description: z.string().max(200).optional(),
  amount: z.number().nonnegative(),
  isRefundable: z.boolean(),
  dueTiming: z.enum(['move_in', 'monthly_ongoing', 'move_out', 'other']),
})

propertiesRouter.post('/:id/fee-schedule', requirePerm('properties.edit'), async (req, res, next) => {
  try {
    const p = await queryOne<any>(`SELECT id, landlord_id FROM properties WHERE id=$1`, [req.params.id])
    if (!p) throw new AppError(404, 'Property not found')
    if (!canManageLandlordResource(req.user, p.landlord_id)) throw new AppError(403, 'Forbidden')

    const body = feeRowSchema.parse(req.body)
    const slotIndex = body.feeType === 'other_fee' ? (body.slotIndex ?? 0) : 0

    const upserted = await queryOne<any>(
      `INSERT INTO property_fee_schedules
         (property_id, fee_type, slot_index, description, amount, is_refundable, due_timing)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (property_id, fee_type, slot_index) DO UPDATE
         SET description = EXCLUDED.description,
             amount = EXCLUDED.amount,
             is_refundable = EXCLUDED.is_refundable,
             due_timing = EXCLUDED.due_timing,
             updated_at = NOW()
       RETURNING *`,
      [req.params.id, body.feeType, slotIndex, body.description ?? null, body.amount, body.isRefundable, body.dueTiming],
    )
    res.json({ success: true, data: upserted })
  } catch (e) { next(e) }
})

// DELETE /api/properties/:id/fee-schedule/:rowId
propertiesRouter.delete('/:id/fee-schedule/:rowId', requirePerm('properties.edit'), async (req, res, next) => {
  try {
    const p = await queryOne<any>(`SELECT id, landlord_id FROM properties WHERE id=$1`, [req.params.id])
    if (!p) throw new AppError(404, 'Property not found')
    if (!canManageLandlordResource(req.user, p.landlord_id)) throw new AppError(403, 'Forbidden')
    await query(`DELETE FROM property_fee_schedules WHERE id=$1 AND property_id=$2`, [req.params.rowId, req.params.id])
    res.json({ success: true })
  } catch (e) { next(e) }
})

// PATCH /api/properties/:id
// S81: gated by properties.edit sub-permission. Property managers with the
// perm can rename / change addresses on properties within their scope.
// Onsite managers and maintenance never reach here (no perm key).
propertiesRouter.patch('/:id', requirePerm('properties.edit'), async (req, res, next) => {
  try {
    const raw = req.body as any
    const name    = raw.name    !== undefined ? formatName(raw.name)       : undefined
    const street1 = raw.street1 !== undefined ? formatStreet(raw.street1)  : undefined
    const street2 = raw.street2 !== undefined ? (raw.street2 ? formatStreet2(raw.street2) : raw.street2) : undefined
    const city    = raw.city    !== undefined ? formatCity(raw.city)       : undefined
    const state   = raw.state   !== undefined ? formatState(raw.state)     : undefined
    const zip     = raw.zip     !== undefined ? formatZip(raw.zip)         : undefined
    const { type } = raw
    // S179 / B3: per-property booking acknowledgment toggle. Sent only when
    // the form actually changed; preserves COALESCE semantics on the others.
    const reqAck =
      typeof raw.requiresBookingAcknowledgment === 'boolean'
        ? raw.requiresBookingAcknowledgment
        : undefined
    // S223: property-level late-fee policy fields. Define defaults that flow
    // into new leases at this property (LeaseFormModal default-pull is a
    // separate carry-forward; for now this surface stores the policy).
    // CHECK constraint allows late_fee_initial_type ∈ {flat, percent_of_rent}.
    const lateFeeEnabled =
      typeof raw.lateFeeEnabled === 'boolean' ? raw.lateFeeEnabled : undefined
    const lateFeeGraceDays =
      raw.lateFeeGraceDays !== undefined && raw.lateFeeGraceDays !== null
        ? Number(raw.lateFeeGraceDays)
        : undefined
    const lateFeeInitialAmount =
      raw.lateFeeInitialAmount !== undefined && raw.lateFeeInitialAmount !== null
        ? Number(raw.lateFeeInitialAmount)
        : undefined
    const lateFeeInitialType =
      raw.lateFeeInitialType === 'flat' || raw.lateFeeInitialType === 'percent_of_rent'
        ? raw.lateFeeInitialType
        : undefined
    if (lateFeeGraceDays !== undefined && (!Number.isFinite(lateFeeGraceDays) || lateFeeGraceDays < 0)) {
      throw new AppError(400, 'late_fee_grace_days must be a non-negative integer')
    }
    if (lateFeeInitialAmount !== undefined && (!Number.isFinite(lateFeeInitialAmount) || lateFeeInitialAmount < 0)) {
      throw new AppError(400, 'late_fee_initial_amount must be a non-negative number')
    }

    // S226: accrual + cap fields. Nullable on properties, so undefined =
    // preserve, explicit null = clear. Validation: accrual triple + cap
    // pair must be all-set or all-null (matches the lateFees engine
    // expectations and the leases-side check).
    const isNumOrNullOrUndef = (v: any) => v === undefined || v === null || (Number.isFinite(Number(v)) && Number(v) >= 0)
    const lateFeeAccrualAmount = raw.lateFeeAccrualAmount === undefined ? undefined : (raw.lateFeeAccrualAmount === null ? null : Number(raw.lateFeeAccrualAmount))
    const lateFeeAccrualType   = raw.lateFeeAccrualType   === undefined ? undefined : (raw.lateFeeAccrualType === null ? null : raw.lateFeeAccrualType)
    const lateFeeAccrualPeriod = raw.lateFeeAccrualPeriod === undefined ? undefined : (raw.lateFeeAccrualPeriod === null ? null : raw.lateFeeAccrualPeriod)
    const lateFeeCapAmount     = raw.lateFeeCapAmount     === undefined ? undefined : (raw.lateFeeCapAmount === null ? null : Number(raw.lateFeeCapAmount))
    const lateFeeCapType       = raw.lateFeeCapType       === undefined ? undefined : (raw.lateFeeCapType === null ? null : raw.lateFeeCapType)
    if (!isNumOrNullOrUndef(raw.lateFeeAccrualAmount)) {
      throw new AppError(400, 'late_fee_accrual_amount must be a non-negative number or null')
    }
    if (!isNumOrNullOrUndef(raw.lateFeeCapAmount)) {
      throw new AppError(400, 'late_fee_cap_amount must be a non-negative number or null')
    }
    if (lateFeeAccrualType !== undefined && lateFeeAccrualType !== null && lateFeeAccrualType !== 'flat' && lateFeeAccrualType !== 'percent_of_rent') {
      throw new AppError(400, 'late_fee_accrual_type must be flat, percent_of_rent, or null')
    }
    if (lateFeeAccrualPeriod !== undefined && lateFeeAccrualPeriod !== null && !['daily', 'weekly', 'monthly'].includes(lateFeeAccrualPeriod)) {
      throw new AppError(400, 'late_fee_accrual_period must be daily, weekly, monthly, or null')
    }
    if (lateFeeCapType !== undefined && lateFeeCapType !== null && lateFeeCapType !== 'flat' && lateFeeCapType !== 'percent_of_rent') {
      throw new AppError(400, 'late_fee_cap_type must be flat, percent_of_rent, or null')
    }

    const prop = await queryOne<any>('SELECT * FROM properties WHERE id=$1', [req.params.id])
    if (!prop) throw new AppError(404, 'Property not found')
    if (!canManageLandlordResource(req.user, prop.landlord_id, ['property_manager'])) {
      throw new AppError(403, 'Forbidden')
    }

    // S247: per-property subleasing toggle. NULL = no change.
    const subleasingAllowed =
      typeof raw.subleasingAllowed === 'boolean' ? raw.subleasingAllowed : undefined
    // S309: per-property FlexCharge enablement gate. NULL = no change.
    // Default-FALSE on new properties (the migration); landlords opt in
    // per property when they want to offer FlexCharge at that Location.
    const flexchargeEnabled =
      typeof raw.flexchargeEnabled === 'boolean' ? raw.flexchargeEnabled : undefined

    let updated = await queryOne<any>(`
      UPDATE properties SET
        name        = COALESCE($1, name),
        street1     = COALESCE($2, street1),
        street2     = COALESCE($3, street2),
        city        = COALESCE($4, city),
        state       = COALESCE($5, state),
        zip         = COALESCE($6, zip),
        type        = COALESCE($7, type),
        requires_booking_acknowledgment = COALESCE($8, requires_booking_acknowledgment),
        late_fee_enabled        = COALESCE($9,  late_fee_enabled),
        late_fee_grace_days     = COALESCE($10, late_fee_grace_days),
        late_fee_initial_amount = COALESCE($11, late_fee_initial_amount),
        late_fee_initial_type   = COALESCE($12, late_fee_initial_type),
        subleasing_allowed      = COALESCE($13, subleasing_allowed),
        flexcharge_enabled      = COALESCE($14, flexcharge_enabled),
        updated_at  = NOW()
      WHERE id=$15 RETURNING *`,
      [name||null, street1||null, street2||null, city||null, state||null,
       zip||null, type||null,
       reqAck === undefined ? null : reqAck,
       lateFeeEnabled === undefined ? null : lateFeeEnabled,
       lateFeeGraceDays === undefined ? null : lateFeeGraceDays,
       lateFeeInitialAmount === undefined ? null : lateFeeInitialAmount,
       lateFeeInitialType ?? null,
       subleasingAllowed === undefined ? null : subleasingAllowed,
       flexchargeEnabled === undefined ? null : flexchargeEnabled,
       req.params.id]
    )

    // S226: separate dynamic UPDATE for accrual + cap. The COALESCE
    // pattern above can't distinguish "preserve" from "clear", and
    // these columns are nullable on properties — so we need direct
    // assignment with undefined-skip semantics.
    const lfFields: Record<string, any> = {
      late_fee_accrual_amount: lateFeeAccrualAmount,
      late_fee_accrual_type:   lateFeeAccrualType,
      late_fee_accrual_period: lateFeeAccrualPeriod,
      late_fee_cap_amount:     lateFeeCapAmount,
      late_fee_cap_type:       lateFeeCapType,
    }
    const lfSetParts: string[] = []
    const lfValues: any[] = []
    for (const [col, val] of Object.entries(lfFields)) {
      if (val === undefined) continue
      lfSetParts.push(col + '=$' + (lfValues.length + 1))
      lfValues.push(val)
    }
    if (lfSetParts.length > 0) {
      // All-or-nothing validation against the post-update final state.
      const finalAccrualAmount = lateFeeAccrualAmount === undefined ? updated.late_fee_accrual_amount : lateFeeAccrualAmount
      const finalAccrualType   = lateFeeAccrualType   === undefined ? updated.late_fee_accrual_type   : lateFeeAccrualType
      const finalAccrualPeriod = lateFeeAccrualPeriod === undefined ? updated.late_fee_accrual_period : lateFeeAccrualPeriod
      const accrualSetCount = [finalAccrualAmount, finalAccrualType, finalAccrualPeriod].filter(v => v !== null && v !== undefined).length
      if (accrualSetCount !== 0 && accrualSetCount !== 3) {
        throw new AppError(400, 'late-fee accrual requires all of amount, type, and period — or none')
      }
      const finalCapAmount = lateFeeCapAmount === undefined ? updated.late_fee_cap_amount : lateFeeCapAmount
      const finalCapType   = lateFeeCapType   === undefined ? updated.late_fee_cap_type   : lateFeeCapType
      const capSetCount = [finalCapAmount, finalCapType].filter(v => v !== null && v !== undefined).length
      if (capSetCount !== 0 && capSetCount !== 2) {
        throw new AppError(400, 'late-fee cap requires both amount and type — or neither')
      }
      lfValues.push(req.params.id)
      updated = await queryOne<any>(
        'UPDATE properties SET ' + lfSetParts.join(', ') + ' WHERE id=$' + lfValues.length + ' RETURNING *',
        lfValues,
      )
    }
    res.json({ success: true, data: updated })
  } catch (e) { next(e) }
})

// PATCH /api/properties/:id/allocation-rule
// S66: scoped patch for the allocation rule.
// S172: extended to accept ach_fee_payer / card_fee_payer / platform_fee_payer
// updates. Pre-S172 these were create-time-only, which forced landlords to
// recreate properties to flip who absorbs processing fees — punishing UX.
// Manager-fee math (rent_percent, flat_monthly_fee, per_unit_fee, etc.)
// and placement / maintenance fields remain create-time-only because they
// affect retroactive ledger interpretation; the fee_payer toggles only
// govern who pays the next charge so they're safe to flip live.
// All body fields are optional — caller only sends what changed.
// S131: stays requireLandlord. Routing payouts to a bank account is
// financial-control authority — owner/admin only.
propertiesRouter.patch('/:id/allocation-rule', requireLandlord, async (req, res, next) => {
  try {
    const body = z.object({
      ownerBankAccountId: z.string().uuid().nullable().optional(),
      achFeePayer:        z.enum(FEE_PAYER_VALUES).optional(),
      cardFeePayer:       z.enum(FEE_PAYER_VALUES).optional(),
      platformFeePayer:   z.enum(FEE_PAYER_VALUES).optional(),
    }).parse(req.body)

    const prop = await queryOne<any>(
      `SELECT id, owner_user_id, landlord_id FROM properties WHERE id=$1`,
      [req.params.id]
    )
    if (!prop) throw new AppError(404, 'Property not found')
    // Allocation rule changes (fee-payer toggles, manager fee config, payout
    // bank account) are financial — landlord/admin only, no team roles.
    if (!canManageLandlordResource(req.user, prop.landlord_id, [])) {
      throw new AppError(403, 'Forbidden')
    }

    if (body.ownerBankAccountId !== undefined && body.ownerBankAccountId !== null) {
      const ba = await queryOne<{ user_id: string; status: string }>(
        `SELECT user_id, status FROM user_bank_accounts WHERE id=$1`,
        [body.ownerBankAccountId]
      )
      if (!ba) throw new AppError(400, 'Bank account not found')
      if (ba.user_id !== prop.owner_user_id) {
        throw new AppError(403, 'Bank account does not belong to property owner')
      }
      if (ba.status !== 'active') {
        throw new AppError(400, 'Bank account is archived')
      }
    }

    // Build a dynamic UPDATE clause from only the fields the caller sent.
    const sets: string[] = []
    const params: any[] = []
    if (body.ownerBankAccountId !== undefined) {
      params.push(body.ownerBankAccountId)
      sets.push(`owner_bank_account_id = $${params.length}`)
    }
    if (body.achFeePayer !== undefined) {
      params.push(body.achFeePayer)
      sets.push(`ach_fee_payer = $${params.length}`)
    }
    if (body.cardFeePayer !== undefined) {
      params.push(body.cardFeePayer)
      sets.push(`card_fee_payer = $${params.length}`)
    }
    if (body.platformFeePayer !== undefined) {
      params.push(body.platformFeePayer)
      sets.push(`platform_fee_payer = $${params.length}`)
    }
    if (sets.length === 0) {
      throw new AppError(400, 'No allocation-rule fields supplied')
    }
    params.push(req.params.id)
    const updated = await queryOne<any>(`
      UPDATE property_allocation_rules
         SET ${sets.join(', ')}
       WHERE property_id = $${params.length}
       RETURNING *
    `, params)
    if (!updated) throw new AppError(404, 'Allocation rule not found for property')
    res.json({ success: true, data: updated })
  } catch (e) { next(e) }
})

// PATCH /api/properties/:id/pm-assignment — assign third-party PM company
// + fee plan to a property. Both nullable (null = self-managed).
// Owner/admin only. Cross-table invariant enforced: if pm_fee_plan_id is
// set, it must belong to the pm_company_id on the same property.
// S109 — fee-cut allocation engine wire-up lands S110.
// S131: stays requireLandlord. Granting a PM company authority over a
// property (and a fee cut against it) is owner-only by definition —
// the PM grant is what creates PM authority in the first place.
propertiesRouter.patch('/:id/pm-assignment', requireLandlord, async (req, res, next) => {
  try {
    const body = z.object({
      pmCompanyId: z.string().uuid().nullable(),
      pmFeePlanId: z.string().uuid().nullable(),
    }).parse(req.body)

    const prop = await queryOne<any>(
      `SELECT id, owner_user_id, landlord_id FROM properties WHERE id=$1`,
      [req.params.id]
    )
    if (!prop) throw new AppError(404, 'Property not found')
    // PM assignment is a financial decision — landlord/admin only,
    // no team roles (matches the allocation-rule endpoint above).
    if (!canManageLandlordResource(req.user, prop.landlord_id, [])) {
      throw new AppError(403, 'Forbidden')
    }

    // Mutually-consistent: a fee plan without a company makes no sense.
    if (body.pmFeePlanId && !body.pmCompanyId) {
      throw new AppError(400, 'pmFeePlanId requires pmCompanyId')
    }

    if (body.pmCompanyId) {
      const co = await queryOne<{ status: string; bank_account_id: string | null }>(
        `SELECT status, bank_account_id FROM pm_companies WHERE id=$1`, [body.pmCompanyId]
      )
      if (!co) throw new AppError(404, 'PM company not found')
      if (co.status !== 'active') throw new AppError(400, 'PM company is not active')
      // S110: PM company must have bank routing set before properties can be
      // assigned — allocation requires it. Defends in depth alongside the
      // allocation engine's own runtime check.
      if (!co.bank_account_id) {
        throw new AppError(409, 'PM company has no bank account assigned (set bank_account_id first)')
      }
    }

    if (body.pmFeePlanId) {
      // Cross-table invariant: plan must belong to the company being assigned.
      const plan = await queryOne<{ pm_company_id: string; status: string }>(
        `SELECT pm_company_id, status FROM pm_fee_plans WHERE id=$1`, [body.pmFeePlanId]
      )
      if (!plan) throw new AppError(404, 'Fee plan not found')
      if (plan.pm_company_id !== body.pmCompanyId) {
        throw new AppError(400, 'Fee plan does not belong to the selected PM company')
      }
      if (plan.status !== 'active') throw new AppError(400, 'Fee plan is not active')
    }

    const updated = await queryOne<any>(`
      UPDATE properties
         SET pm_company_id  = $1,
             pm_fee_plan_id = $2,
             updated_at     = NOW()
       WHERE id = $3
       RETURNING id, name, pm_company_id, pm_fee_plan_id
    `, [body.pmCompanyId, body.pmFeePlanId, req.params.id])
    res.json({ success: true, data: updated })
  } catch (e) { next(e) }
})

// PATCH /api/properties/:id/manager — assign individual day-to-day
// manager (single user pointer). S183/S184: pairs with the responsible-
// party resolver in services/responsibleParty.ts. When set to a non-
// owner user, that user becomes the recipient of routine notifications
// (lease expiring, rent collected, etc.) for this property; the owner
// stops getting those pings.
//
// Body: { userId: string | null }. null reverts to owner self-management.
//
// Validation:
//   - Target user_id must have an active property_manager_scopes row
//     covering this property under this landlord (gate prevents the
//     owner from routing to Random Stranger).
//   - Refuses while pm_company_id is set — PM company takes precedence
//     in the resolver, and an individual manager assignment is
//     meaningless under a PM company contract. Owner must clear the
//     PM company first via /pm-assignment.
//
// Auth: owner/admin only (matches /pm-assignment posture). Delegating
// authority over a property is an owner decision.
const managerAssignmentSchema = z.object({
  userId: z.string().uuid().nullable(),
})

propertiesRouter.patch('/:id/manager', requireLandlord, async (req, res, next) => {
  try {
    const body = managerAssignmentSchema.parse(req.body)

    const prop = await queryOne<{
      id: string
      landlord_id: string
      owner_user_id: string
      pm_company_id: string | null
    }>(
      `SELECT id, landlord_id, owner_user_id, pm_company_id FROM properties WHERE id=$1`,
      [req.params.id]
    )
    if (!prop) throw new AppError(404, 'Property not found')
    if (!canManageLandlordResource(req.user, prop.landlord_id, [])) {
      throw new AppError(403, 'Forbidden')
    }

    if (prop.pm_company_id) {
      throw new AppError(
        409,
        'Property is assigned to a PM company. Clear the PM assignment before setting an individual manager.'
      )
    }

    // null = revert to owner self-management. Resolves to the property's
    // owner_user_id so the column stays NOT NULL.
    const targetUserId = body.userId ?? prop.owner_user_id

    if (targetUserId !== prop.owner_user_id) {
      // Validate the target has property_manager scope covering this
      // property under this landlord. all_properties=true OR property_id
      // listed OR a unit under the property listed all qualify.
      const scope = await queryOne<{ id: string }>(
        `SELECT s.id
           FROM property_manager_scopes s
          WHERE s.user_id = $1
            AND s.landlord_id = $2
            AND (
              s.all_properties = true
              OR $3::uuid = ANY(s.property_ids)
              OR EXISTS (
                SELECT 1 FROM units u
                 WHERE u.property_id = $3 AND u.id = ANY(s.unit_ids)
              )
            )
          LIMIT 1`,
        [targetUserId, prop.landlord_id, prop.id]
      )
      if (!scope) {
        throw new AppError(
          400,
          'Target user is not a property_manager scope holder for this property under this landlord. Add the scope on the Team page first.'
        )
      }
    }

    const updated = await queryOne<any>(
      `UPDATE properties
          SET managed_by_user_id = $1,
              updated_at         = NOW()
        WHERE id = $2
        RETURNING id, name, owner_user_id, managed_by_user_id, pm_company_id`,
      [targetUserId, prop.id]
    )
    res.json({ success: true, data: updated })
  } catch (e) { next(e) }
})

// GET /api/properties/:id/eligible-managers — list of users who can be
// assigned as the day-to-day manager for this property. Includes the
// owner (as 'self') plus every active property_manager_scopes holder
// whose scope covers this property. Frontend feeds this to the
// manager-selection dropdown on the property detail page.
propertiesRouter.get('/:id/eligible-managers', async (req, res, next) => {
  try {
    const prop = await queryOne<{
      id: string
      landlord_id: string
      owner_user_id: string
      managed_by_user_id: string
    }>(
      `SELECT id, landlord_id, owner_user_id, managed_by_user_id
         FROM properties WHERE id=$1`,
      [req.params.id]
    )
    if (!prop) throw new AppError(404, 'Property not found')
    if (!canAccessLandlordResource(req.user, prop.landlord_id)) {
      throw new AppError(403, 'Forbidden')
    }

    const owner = await queryOne<{
      user_id: string
      email: string
      first_name: string | null
      last_name: string | null
    }>(
      `SELECT id AS user_id, email, first_name, last_name
         FROM users WHERE id=$1`,
      [prop.owner_user_id]
    )

    const managers = await query<{
      user_id: string
      email: string
      first_name: string | null
      last_name: string | null
    }>(
      `SELECT u.id AS user_id, u.email, u.first_name, u.last_name
         FROM property_manager_scopes s
         JOIN users u ON u.id = s.user_id
        WHERE s.landlord_id = $1
          AND (
            s.all_properties = true
            OR $2::uuid = ANY(s.property_ids)
            OR EXISTS (
              SELECT 1 FROM units un
               WHERE un.property_id = $2 AND un.id = ANY(s.unit_ids)
            )
          )
        ORDER BY u.last_name NULLS LAST, u.first_name NULLS LAST, u.email`,
      [prop.landlord_id, prop.id]
    )

    res.json({
      success: true,
      data: {
        current_managed_by_user_id: prop.managed_by_user_id,
        owner_user_id:               prop.owner_user_id,
        owner: owner ? {
          user_id:    owner.user_id,
          email:      owner.email,
          first_name: owner.first_name,
          last_name:  owner.last_name,
          role:       'self' as const,
        } : null,
        managers: managers.map((m) => ({
          ...m,
          role: 'manager' as const,
        })),
      },
    })
  } catch (e) { next(e) }
})

// ════════════════════════════════════════
// PUBLIC LISTINGS
// ════════════════════════════════════════

const uploadDir = path.join(process.cwd(), 'uploads', 'unit-photos')
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true })

// S399 fix: force safe extension from MIME instead of taking
// path.extname(originalname). Pre-fix, an attacker could upload bytes
// with MIME=image/jpeg + originalname=evil.html — saved as .html and
// served via express.static('/uploads') as text/html → XSS. Fourth
// instance of this pattern (S380 avatar + S394 esign upload + S395
// pending-tenants + this). Aligned with S398 Nic decision posture:
// always pin the served content-type to image, here via the on-disk
// extension since /uploads is a static-served path.
const MIME_TO_EXT: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png':  '.png',
  'image/webp': '.webp',
  'image/gif':  '.gif',
}
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename: (_req, file, cb) => {
    const ext = MIME_TO_EXT[file.mimetype] ?? '.bin'
    cb(null, `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`)
  }
})
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 }, fileFilter: (_req, file, cb) => {
  if (file.mimetype.startsWith('image/')) cb(null, true)
  else cb(new Error('Images only'))
}})

// GET /api/properties/listings — public, no auth needed
publicPropertiesRouter.get('/listings', async (req, res, next) => {
  try {
    const { rows } = await db.query(`
      SELECT
        u.id, u.unit_number, u.bedrooms, u.bathrooms, u.sqft,
        u.rent_amount, u.security_deposit, u.available_date, u.listing_description,
        p.name AS property_name, p.street1, p.city, p.state, p.zip,
        p.type AS property_type,
        l.id AS landlord_id,
        lu.first_name AS landlord_first, lu.last_name AS landlord_last,
        lu.phone AS landlord_phone,
        COALESCE(
          json_agg(up.url ORDER BY up.sort_order ASC) FILTER (WHERE up.id IS NOT NULL),
          '[]'
        ) AS photos,
        COUNT(up.id)::int AS photo_count
      FROM units u
      JOIN properties p ON p.id = u.property_id
      JOIN landlords l ON l.id = u.landlord_id
      JOIN users lu ON lu.id = l.user_id
      LEFT JOIN unit_photos up ON up.unit_id = u.id
      WHERE u.status = 'vacant' AND u.listed_vacant = TRUE
        AND u.bedrooms IS NOT NULL AND u.bathrooms IS NOT NULL
      GROUP BY u.id, p.id, l.id, lu.id
      HAVING COUNT(up.id) >= 5
      ORDER BY u.rent_amount ASC
    `)
    res.json({ success: true, data: rows })
  } catch (e) { next(e) }
})

// GET /api/properties/listings/all — includes units with < 5 photos (for landlord preview)
publicPropertiesRouter.get('/listings/preview', async (req, res, next) => {
  try {
    const { rows } = await db.query(`
      SELECT
        u.id, u.unit_number, u.bedrooms, u.bathrooms, u.sqft,
        u.rent_amount, u.security_deposit, u.available_date, u.listing_description,
        u.listed_vacant,
        p.name AS property_name, p.street1, p.city, p.state, p.zip,
        COALESCE(
          json_agg(up.url ORDER BY up.sort_order ASC) FILTER (WHERE up.id IS NOT NULL),
          '[]'
        ) AS photos,
        COUNT(up.id)::int AS photo_count
      FROM units u
      JOIN properties p ON p.id = u.property_id
      LEFT JOIN unit_photos up ON up.unit_id = u.id
      WHERE u.landlord_id = $1 AND u.status = 'vacant'
      GROUP BY u.id, p.id
      ORDER BY p.name, u.unit_number
    `, [req.user!.profileId])
    res.json({ success: true, data: rows })
  } catch (e) { next(e) }
})

// GET /api/properties/units/:id/photos
propertiesRouter.get('/units/:id/photos', requirePerm('units.edit', 'units.view_status'), async (req, res, next) => {
  try {
    // S399 fix: verify the unit belongs to the caller's landlord scope.
    // Pre-fix, the route filtered only by unit_id with no landlord
    // check — a caller knowing a foreign unit UUID could read its
    // photo list (URLs). Cross-tenant info disclosure.
    const unit = await queryOne<{ landlord_id: string }>(
      `SELECT landlord_id FROM units WHERE id=$1`, [req.params.id])
    if (!unit) throw new AppError(404, 'Unit not found')
    if (!canAccessLandlordResource(req.user, unit.landlord_id)) {
      throw new AppError(403, 'Forbidden')
    }
    const { rows } = await db.query(
      'SELECT * FROM unit_photos WHERE unit_id=$1 ORDER BY sort_order ASC',
      [req.params.id]
    )
    res.json({ success: true, data: rows })
  } catch (e) { next(e) }
})

// POST /api/properties/units/:id/photos — upload photos.
// Listing changes are operational, not financial. PMs and onsite managers
// routinely refresh listing photos; default canManageLandlordResource policy
// (all team roles) is correct here.
propertiesRouter.post('/units/:id/photos', requirePerm('units.edit'), upload.array('photos', 20), async (req, res, next) => {
  try {
    const unit = await queryOne<any>('SELECT * FROM units WHERE id=$1', [req.params.id])
    if (!unit) throw new AppError(404, 'Unit not found')
    if (!canManageLandlordResource(req.user, unit.landlord_id)) {
      throw new AppError(403, 'Forbidden')
    }
    const files = req.files as Express.Multer.File[]
    if (!files?.length) throw new AppError(400, 'No files uploaded')
    const { rows: existing } = await db.query('SELECT COUNT(*) FROM unit_photos WHERE unit_id=$1', [req.params.id])
    let sortOrder = +existing[0].count
    const inserted = []
    for (const file of files) {
      const url = `/uploads/unit-photos/${file.filename}`
      const { rows: [photo] } = await db.query(
        'INSERT INTO unit_photos (unit_id, landlord_id, url, sort_order) VALUES ($1,$2,$3,$4) RETURNING *',
        [req.params.id, unit.landlord_id, url, sortOrder++]
      )
      inserted.push(photo)
    }
    res.status(201).json({ success: true, data: inserted })
  } catch (e) { next(e) }
})

// DELETE /api/properties/units/:id/photos/:photoId
propertiesRouter.delete('/units/:id/photos/:photoId', requirePerm('units.edit'), async (req, res, next) => {
  try {
    const photo = await queryOne<any>(
      'SELECT * FROM unit_photos WHERE id=$1 AND unit_id=$2',
      [req.params.photoId, req.params.id]
    )
    if (!photo) throw new AppError(404, 'Photo not found')
    if (!canManageLandlordResource(req.user, photo.landlord_id)) {
      throw new AppError(403, 'Forbidden')
    }
    const filePath = path.join(process.cwd(), photo.url)
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath)
    await db.query('DELETE FROM unit_photos WHERE id=$1', [photo.id])
    res.json({ success: true })
  } catch (e) { next(e) }
})

// PATCH /api/properties/units/:id/listing — update listing details
propertiesRouter.patch('/units/:id/listing', requirePerm('units.edit'), async (req, res, next) => {
  try {
    const unit = await queryOne<any>('SELECT id, landlord_id FROM units WHERE id=$1', [req.params.id])
    if (!unit) throw new AppError(404, 'Unit not found')
    if (!canManageLandlordResource(req.user, unit.landlord_id)) {
      throw new AppError(403, 'Forbidden')
    }
    const { availableDate, listingDescription, listedVacant, bedrooms, bathrooms, sqft } = req.body
    const { rows: [updated] } = await db.query(
      `UPDATE units SET
         available_date=COALESCE($1,available_date),
         listing_description=COALESCE($2,listing_description),
         listed_vacant=COALESCE($3,listed_vacant),
         bedrooms=COALESCE($4,bedrooms),
         bathrooms=COALESCE($5,bathrooms),
         sqft=COALESCE($6,sqft),
         updated_at=NOW()
       WHERE id=$7 RETURNING *`,
      [availableDate||null, listingDescription||null, listedVacant??null,
       bedrooms||null, bathrooms||null, sqft||null, req.params.id]
    )
    res.json({ success: true, data: updated })
  } catch (e) { next(e) }
})

// POST /api/properties/apply — submit application (public)
publicPropertiesRouter.post('/apply', async (req, res, next) => {
  try {
    const { unitId, landlordId, firstName, lastName, email, phone, moveInDate, monthlyIncome, occupants, hasPets, petDescription, message } = req.body
    if (!firstName || !lastName || !email) throw new AppError(400, 'firstName, lastName, email required')
    if (!unitId && !landlordId) throw new AppError(400, 'unitId or landlordId required')

    // Get landlordId from unit if not provided
    let lid = landlordId
    if (unitId && !lid) {
      const unit = await queryOne<any>('SELECT landlord_id FROM units WHERE id=$1', [unitId])
      if (!unit) throw new AppError(404, 'Unit not found')
      lid = unit.landlord_id
    }

    const { rows: [app] } = await db.query(
      `INSERT INTO unit_applications
         (unit_id, landlord_id, first_name, last_name, email, phone, move_in_date, monthly_income, occupants, has_pets, pet_description, message)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [unitId||null, lid, firstName, lastName, email, phone||null, moveInDate||null,
       monthlyIncome||null, occupants||1, hasPets||false, petDescription||null, message||null]
    )
    res.status(201).json({ success: true, data: app })
  } catch (e) { next(e) }
})

// (GET /api/properties/applications declared above, before GET /:id —
// see S399 routing-order fix.)

// POST /api/properties/:id/units/bulk — create multiple units by type.
// Creating units is operational — PMs do this regularly. Default
// canManageLandlordResource policy (all team roles) is correct.
propertiesRouter.post('/:id/units/bulk', requirePerm('units.create'), async (req, res, next) => {
  try {
    const prop = await queryOne<any>(
      'SELECT * FROM properties WHERE id=$1',
      [req.params.id]
    )
    if (!prop) throw new AppError(404, 'Property not found')
    if (!canManageLandlordResource(req.user, prop.landlord_id)) {
      throw new AppError(403, 'Forbidden')
    }

    // unitGroups: [{ type: 'rv_spot', count: 20, prefix: 'RV', rentAmount: 500 }, ...]
    const { unitGroups } = req.body
    if (!unitGroups?.length) throw new AppError(400, 'unitGroups required')

    // S414 (S399 finding): per-group input validation. Pre-fix accepted
    // arbitrary count (DoS via count=10000), arbitrary prefix length,
    // and arbitrary type strings (only caught later by the DB
    // units_unit_type_check constraint at INSERT time → 500 with
    // cryptic 23514). Now validated upfront with zod.
    const UNIT_TYPES = ['apartment', 'single_family', 'rv_spot', 'mobile_home', 'storage', 'commercial'] as const
    const bulkSchema = z.array(z.object({
      type:            z.enum(UNIT_TYPES),
      count:           z.number().int().min(1).max(200, 'count must be ≤ 200 per group'),
      prefix:          z.string().max(32, 'prefix must be ≤ 32 chars').optional(),
      rentAmount:      z.number().positive().optional(),
      securityDeposit: z.number().min(0).optional(),
    })).min(1, 'unitGroups must have at least one group')
    const validatedGroups = bulkSchema.parse(unitGroups)

    // Default prefix per unit type (user-typed prefix overrides this).
    // S414: keys aligned to units_unit_type_check allow-list — pre-fix
    // had 'house' and 'other' keys that never matched the schema CHECK.
    const TYPE_PREFIXES: Record<string,string> = {
      apartment:     'Apt',
      single_family: 'House',
      mobile_home:   'MH',
      rv_spot:       'RV',
      storage:       'Storage',
      commercial:    'Com',
    }

    const created = []
    for (const group of validatedGroups) {
      const { type, count, prefix, rentAmount, securityDeposit } = group
      // User prefix goes through formatName; fallback to TYPE_PREFIXES default.
      const pfx = prefix ? formatName(prefix) : (TYPE_PREFIXES[type] || 'Unit')

      // Find existing max number for this prefix in this property (case-insensitive match)
      const { rows: existing } = await db.query(
        `SELECT unit_number FROM units WHERE property_id=$1 AND LOWER(unit_number) LIKE LOWER($2) ORDER BY unit_number`,
        [req.params.id, `${pfx} %`]
      )
      const existingNums = existing.map((r: any) => {
        const m = r.unit_number.match(/\s(\d+)$/)
        return m ? parseInt(m[1]) : 0
      })
      const startNum = existingNums.length > 0 ? Math.max(...existingNums) + 1 : 1

      for (let i = 0; i < count; i++) {
        const unitNum = `${pfx} ${String(startNum + i).padStart(2, '0')}`
        const { rows: [unit] } = await db.query(
          `INSERT INTO units (property_id, landlord_id, unit_number, unit_type, rent_amount, security_deposit, status)
           VALUES ($1,$2,$3,$4,$5,$6,'vacant') RETURNING *`,
          // S399 fix: security_deposit is NOT NULL with DEFAULT 0 in the
          // schema. Pre-fix the route passed null when securityDeposit
          // was omitted from a unitGroup, which overrode the default →
          // 23502 not-null violation → 500 on every bulk-create that
          // didn't explicitly provide securityDeposit per group.
          [req.params.id, prop.landlord_id, unitNum, type, rentAmount||null, securityDeposit||0]
        )
        created.push(unit)
      }
    }

    // Update property unit_types
    const types = [...new Set(validatedGroups.map((g) => g.type))]
    await db.query(
      'UPDATE properties SET unit_types=$1 WHERE id=$2',
      [types, req.params.id]
    )

    res.status(201).json({ success: true, data: { created: created.length, units: created } })
  } catch (e) { next(e) }
})
