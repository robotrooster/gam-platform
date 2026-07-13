import { Router } from 'express'
import multer from 'multer'
import path from 'path'
import fs from 'fs'
import { z } from 'zod'
import { normalizeAddress } from '../lib/address'
import { formatPropertyInput, formatName, formatStreet, formatStreet2, formatCity, formatState, formatZip } from '../lib/format'
import { db, query, queryOne, getClient } from '../db'
import { requireAuth, requireLandlord, requirePerm } from '../middleware/auth'
import { resolveUploadPath } from '../lib/uploadPaths'
import { canAccessLandlordResource, canManageLandlordResource } from '../middleware/scope'
import { AppError } from '../middleware/errorHandler'
import {
  FEE_PAYER_VALUES,
  PLACEMENT_FEE_TYPE_VALUES,
  PropertyReviewStatus,
  AGENT_REVENUE_CAPABILITIES,
  UNIT_TYPES,
} from '@gam/shared'
import { listAgentPermissions, setAgentCapability } from '../services/agentPermissions'
import { logger } from '../lib/logger'
import { checkAgainstStatute, checkLeaseAgainstStateLaw, type LawFlag } from '../services/stateLaw'

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
      // S513 (#2): fee payers are no longer required on create. card_fee_payer
      // is hard-locked to 'tenant' and ach_fee_payer inherits the landlord's
      // onboarding election (landlords.default_ach_fee_payer) when omitted, so
      // a caller need not supply either. allocationRule itself is optional —
      // this also fixes onboarding step-1, which posts a property with no
      // allocationRule and previously 400'd on the old required-payer refine.
      }).default({}),
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
    // S116: three independent fee toggles. S513 (walkthrough #2): card_fee_payer
    // is hard-locked to 'tenant' — the landlord NEVER covers card (S512). ACH
    // defaults to the landlord's onboarding election
    // (landlords.default_ach_fee_payer), overridable per-property by an explicit
    // achFeePayer in the request. Legacy bankingFeePayer still mirrors into ACH.
    const dfltRes = await client.query<{ default_ach_fee_payer: string }>(
      `SELECT default_ach_fee_payer FROM landlords WHERE id=$1`,
      [req.user!.profileId]
    )
    const landlordAchDefault = dfltRes.rows[0]?.default_ach_fee_payer ?? 'tenant'
    const achFeePayer       = ar.achFeePayer ?? ar.bankingFeePayer ?? landlordAchDefault
    const cardFeePayer      = 'tenant'
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

    // S486: recompute state-law warnings against the persisted
    // property defaults so the detail page surfaces current-state
    // mismatches without waiting for a PATCH. Deposit check skips
    // automatically (no rentAmount at property level); only the
    // late-fee checks fire. Best-effort; errors logged.
    let stateLawWarnings: LawFlag[] = []
    try {
      stateLawWarnings = await checkLeaseAgainstStateLaw({
        stateCode:            p.state,
        rentAmount:           null,  // no per-property rent figure
        lateFeeInitialAmount: p.late_fee_initial_amount != null ? Number(p.late_fee_initial_amount) : null,
        lateFeeInitialType:   p.late_fee_initial_type,
        lateFeeGraceDays:     p.late_fee_grace_days != null ? Number(p.late_fee_grace_days) : null,
      })
    } catch (e) {
      logger.error({ err: e, property_id: p.id }, '[stateLaw] property GET checks failed')
    }

    res.json({
      success: true,
      data: { ...p, state_law_warnings: stateLawWarnings },
    })
  } catch (e) { next(e) }
})

// ─────────────────────────────────────────────────────────────
// OWNER-DEFINED UNIT SUBTYPES (S527 — replaces the S526 subtype_key
// pricing model). A subtype is the owner's own named class of unit on
// a property ("Studio", "Riverfront pull-through", "10x10"): name +
// type-relevant facts + creation-time pricing. Blank per landlord
// until they add them. Add Unit prefills from the picked subtype; the
// unit stores its own copy.
// ─────────────────────────────────────────────────────────────

// GET /api/properties/:id/unit-subtypes — all subtypes for a property
propertiesRouter.get('/:id/unit-subtypes', async (req, res, next) => {
  try {
    const p = await queryOne<any>(`SELECT id, landlord_id FROM properties WHERE id=$1`, [req.params.id])
    if (!p) throw new AppError(404, 'Property not found')
    if (!canAccessLandlordResource(req.user, p.landlord_id)) throw new AppError(403, 'Forbidden')
    const rows = await query<any>(
      `SELECT id, unit_type, name, bedrooms, bathrooms, rv_site_layout,
              rv_amp_service, storage_size, rent_amount, security_deposit,
              nightly_rate, weekly_rate, monthly_rate, created_at, updated_at
         FROM property_unit_subtypes
        WHERE property_id = $1
        ORDER BY unit_type, name`,
      [req.params.id],
    )
    res.json({ success: true, data: rows })
  } catch (e) { next(e) }
})

const unitSubtypeSchema = z.object({
  unitType: z.enum(UNIT_TYPES as unknown as [string, ...string[]]),
  name: z.string().trim().min(1).max(60),
  bedrooms: z.number().int().min(0).nullable().optional(),
  bathrooms: z.number().min(0).nullable().optional(),
  rvSiteLayout: z.enum(['none', 'back_in', 'pull_through']).nullable().optional(),
  rvAmpService: z.enum(['none', '30', '50', 'both']).nullable().optional(),
  storageSize: z.string().trim().max(40).nullable().optional(),
  rentAmount: z.number().min(0).nullable().optional(),
  securityDeposit: z.number().min(0).nullable().optional(),
  nightlyRate: z.number().min(0).nullable().optional(),
  weeklyRate: z.number().min(0).nullable().optional(),
  monthlyRate: z.number().min(0).nullable().optional(),
})

// POST /api/properties/:id/unit-subtypes — create (or update via id) one
// subtype. Facts irrelevant to the unit type are nulled server-side so a
// type switch can't leave stale attributes behind.
propertiesRouter.post('/:id/unit-subtypes', requirePerm('properties.edit'), async (req, res, next) => {
  try {
    const p = await queryOne<any>(`SELECT id, landlord_id FROM properties WHERE id=$1`, [req.params.id])
    if (!p) throw new AppError(404, 'Property not found')
    if (!canManageLandlordResource(req.user, p.landlord_id)) throw new AppError(403, 'Forbidden')
    const body = unitSubtypeSchema.extend({ id: z.string().uuid().optional() }).parse(req.body)

    const hasBedrooms = ['apartment', 'single_family', 'mobile_home'].includes(body.unitType)
    const isRv = body.unitType === 'rv_spot'
    const isStorage = body.unitType === 'storage'
    const vals = [
      req.params.id, body.unitType, body.name,
      hasBedrooms ? body.bedrooms ?? null : null,
      hasBedrooms ? body.bathrooms ?? null : null,
      isRv ? body.rvSiteLayout ?? null : null,
      isRv ? body.rvAmpService ?? null : null,
      isStorage ? (body.storageSize?.trim() || null) : null,
      body.rentAmount ?? null, body.securityDeposit ?? null,
      body.nightlyRate ?? null, body.weeklyRate ?? null, body.monthlyRate ?? null,
    ]

    let row
    if (body.id) {
      row = await queryOne<any>(
        `UPDATE property_unit_subtypes SET
           unit_type=$2, name=$3, bedrooms=$4, bathrooms=$5, rv_site_layout=$6,
           rv_amp_service=$7, storage_size=$8, rent_amount=$9, security_deposit=$10,
           nightly_rate=$11, weekly_rate=$12, monthly_rate=$13, updated_at=NOW()
         WHERE id=$14 AND property_id=$1
         RETURNING *`,
        [...vals, body.id],
      )
      if (!row) throw new AppError(404, 'Subtype not found')
    } else {
      row = await queryOne<any>(
        `INSERT INTO property_unit_subtypes
           (property_id, unit_type, name, bedrooms, bathrooms, rv_site_layout,
            rv_amp_service, storage_size, rent_amount, security_deposit,
            nightly_rate, weekly_rate, monthly_rate)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         ON CONFLICT (property_id, unit_type, name) DO UPDATE
           SET bedrooms=EXCLUDED.bedrooms, bathrooms=EXCLUDED.bathrooms,
               rv_site_layout=EXCLUDED.rv_site_layout, rv_amp_service=EXCLUDED.rv_amp_service,
               storage_size=EXCLUDED.storage_size, rent_amount=EXCLUDED.rent_amount,
               security_deposit=EXCLUDED.security_deposit, nightly_rate=EXCLUDED.nightly_rate,
               weekly_rate=EXCLUDED.weekly_rate, monthly_rate=EXCLUDED.monthly_rate,
               updated_at=NOW()
         RETURNING *`,
        vals,
      )
    }
    res.json({ success: true, data: row })
  } catch (e) { next(e) }
})

// DELETE /api/properties/:id/unit-subtypes/:rowId — units created from it
// keep their copied values (units.subtype_id → NULL via FK).
propertiesRouter.delete('/:id/unit-subtypes/:rowId', requirePerm('properties.edit'), async (req, res, next) => {
  try {
    const p = await queryOne<any>(`SELECT id, landlord_id FROM properties WHERE id=$1`, [req.params.id])
    if (!p) throw new AppError(404, 'Property not found')
    if (!canManageLandlordResource(req.user, p.landlord_id)) throw new AppError(403, 'Forbidden')
    await query(
      `DELETE FROM property_unit_subtypes WHERE id=$1 AND property_id=$2`,
      [req.params.rowId, req.params.id],
    )
    res.json({ success: true })
  } catch (e) { next(e) }
})

// ─────────────────────────────────────────────────────────────
// PROPERTY FEE SCHEDULE (S154)
// Anti-discrimination model: per-property standard fees that
// pre-populate new lease documents. Lease remains the legal
// contract; this is the policy.
// NOTE (S526): the landlord-facing fee-schedule page is RETIRED — each
// tenant is charged per their own signed lease (lease_fees, parsed at
// e-sign finalize). These routes stay for the esign is_override audit
// comparison and any legacy rows; no UI writes them anymore.
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

// ─────────────────────────────────────────────────────────────
// AGENT REVENUE PERMISSIONS (S498 foundation → S501 settings UI)
// Per-property opt-in for revenue-affecting agent actions. Default
// OFF; absence of a row means OFF. The same gate the in-chat
// set_agent_permission tool writes — this is the property-settings
// surface so a landlord can manage it outside of chat.
// ─────────────────────────────────────────────────────────────

// GET /api/properties/:id/agent-permissions — full capability map (every capability, default false)
propertiesRouter.get('/:id/agent-permissions', async (req, res, next) => {
  try {
    const p = await queryOne<any>(`SELECT id, landlord_id FROM properties WHERE id=$1`, [req.params.id])
    if (!p) throw new AppError(404, 'Property not found')
    if (!canAccessLandlordResource(req.user, p.landlord_id)) throw new AppError(403, 'Forbidden')
    const map = await listAgentPermissions(req.params.id)
    res.json({ success: true, data: map })
  } catch (e) { next(e) }
})

// PATCH /api/properties/:id/agent-permissions — toggle one capability
const agentPermSchema = z.object({
  capability: z.enum(AGENT_REVENUE_CAPABILITIES),
  enabled: z.boolean(),
})
propertiesRouter.patch('/:id/agent-permissions', requirePerm('properties.edit'), async (req, res, next) => {
  try {
    const p = await queryOne<any>(`SELECT id, landlord_id FROM properties WHERE id=$1`, [req.params.id])
    if (!p) throw new AppError(404, 'Property not found')
    if (!canManageLandlordResource(req.user, p.landlord_id)) throw new AppError(403, 'Forbidden')
    const body = agentPermSchema.parse(req.body)
    const enabled = await setAgentCapability(req.params.id, body.capability, body.enabled, req.user!.userId)
    res.json({ success: true, data: { capability: body.capability, enabled } })
  } catch (e) { next(e) }
})

// PATCH /api/properties/:id
// S81: gated by properties.edit sub-permission. Property managers with the
// perm can rename / change addresses on properties within their scope.
// Onsite managers and maintenance never reach here (no perm key).
// ── S535: per-UNIT-TYPE late-fee overrides ───────────────────────────
// Late fees are property-level policy; a landlord may vary them by unit
// CLASS (RV spot vs apartment vs storage — never by tenant). An
// override row replaces the property default wholesale for its type;
// resolution lives in services/lateFeePolicy.ts and stamps into every
// drafted lease at creation.
propertiesRouter.get('/:id/late-fee-overrides', requirePerm('properties.edit'), async (req, res, next) => {
  try {
    const prop = await queryOne<any>('SELECT id, landlord_id FROM properties WHERE id=$1', [req.params.id])
    if (!prop) throw new AppError(404, 'Property not found')
    if (!canManageLandlordResource(req.user, prop.landlord_id, ['property_manager'])) throw new AppError(403, 'Forbidden')
    const rows = await query<any>(
      `SELECT * FROM property_unit_type_late_fees WHERE property_id=$1 ORDER BY unit_type`, [req.params.id])
    res.json({ success: true, data: rows })
  } catch (e) { next(e) }
})

propertiesRouter.put('/:id/late-fee-overrides', requirePerm('properties.edit'), async (req, res, next) => {
  try {
    // S537: a row is an explicit DECISION — either fee terms or
    // noLateFee=true ("this class has no late fee"). Both shapes satisfy
    // the onboarding gate; absence of a row means UNDECIDED and gates.
    const body = z.discriminatedUnion('noLateFee', [
      z.object({
        noLateFee:     z.literal(true),
        unitType:      z.enum(UNIT_TYPES as unknown as [string, ...string[]]),
      }),
      z.object({
        noLateFee:     z.literal(false).default(false),
        unitType:      z.enum(UNIT_TYPES as unknown as [string, ...string[]]),
        graceDays:     z.number().int().min(0).max(60),
        initialAmount: z.number().min(0),
        initialType:   z.enum(['flat', 'percent_of_rent']),
        // S537: accrual + cap are part of the class decision (Nic's own
        // policy is $25 initial + $5/day). All-or-nothing per group.
        accrualAmount: z.number().min(0).nullish(),
        accrualType:   z.enum(['flat', 'percent_of_rent']).nullish(),
        accrualPeriod: z.enum(['daily', 'weekly', 'monthly']).nullish(),
        capAmount:     z.number().min(0).nullish(),
        capType:       z.enum(['flat', 'percent_of_rent']).nullish(),
      }),
    ]).parse({ noLateFee: false, ...req.body })
    // zod discriminatedUnion can't carry refinements — enforce the
    // all-or-nothing groups imperatively.
    if (!body.noLateFee) {
      const accSet = [body.accrualAmount != null, body.accrualType != null, body.accrualPeriod != null]
      if (new Set(accSet).size > 1) {
        throw new AppError(400, 'accrualAmount, accrualType and accrualPeriod must be set together')
      }
      if ((body.capAmount != null) !== (body.capType != null)) {
        throw new AppError(400, 'capAmount and capType must be set together')
      }
    }
    const prop = await queryOne<any>('SELECT id, landlord_id FROM properties WHERE id=$1', [req.params.id])
    if (!prop) throw new AppError(404, 'Property not found')
    if (!canManageLandlordResource(req.user, prop.landlord_id, ['property_manager'])) throw new AppError(403, 'Forbidden')
    const vals = body.noLateFee
      ? { grace: null, amount: null, type: null, accA: null, accT: null, accP: null, capA: null, capT: null }
      : { grace: body.graceDays, amount: body.initialAmount.toFixed(2), type: body.initialType,
          accA: body.accrualAmount != null ? body.accrualAmount.toFixed(2) : null,
          accT: body.accrualType ?? null, accP: body.accrualPeriod ?? null,
          capA: body.capAmount != null ? body.capAmount.toFixed(2) : null,
          capT: body.capType ?? null }
    const row = await queryOne<any>(`
      INSERT INTO property_unit_type_late_fees
        (property_id, unit_type, no_late_fee, late_fee_grace_days, late_fee_initial_amount, late_fee_initial_type,
         late_fee_accrual_amount, late_fee_accrual_type, late_fee_accrual_period, late_fee_cap_amount, late_fee_cap_type)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      ON CONFLICT (property_id, unit_type) DO UPDATE SET
        no_late_fee = EXCLUDED.no_late_fee,
        late_fee_grace_days = EXCLUDED.late_fee_grace_days,
        late_fee_initial_amount = EXCLUDED.late_fee_initial_amount,
        late_fee_initial_type = EXCLUDED.late_fee_initial_type,
        late_fee_accrual_amount = EXCLUDED.late_fee_accrual_amount,
        late_fee_accrual_type   = EXCLUDED.late_fee_accrual_type,
        late_fee_accrual_period = EXCLUDED.late_fee_accrual_period,
        late_fee_cap_amount     = EXCLUDED.late_fee_cap_amount,
        late_fee_cap_type       = EXCLUDED.late_fee_cap_type,
        updated_at = NOW()
      RETURNING *`,
      [req.params.id, body.unitType, body.noLateFee, vals.grace, vals.amount, vals.type,
       vals.accA, vals.accT, vals.accP, vals.capA, vals.capT])
    res.json({ success: true, data: row })
  } catch (e) { next(e) }
})

propertiesRouter.delete('/:id/late-fee-overrides/:unitType', requirePerm('properties.edit'), async (req, res, next) => {
  try {
    const prop = await queryOne<any>('SELECT id, landlord_id FROM properties WHERE id=$1', [req.params.id])
    if (!prop) throw new AppError(404, 'Property not found')
    if (!canManageLandlordResource(req.user, prop.landlord_id, ['property_manager'])) throw new AppError(403, 'Forbidden')
    // S537: deleting a decision returns the class to UNDECIDED, which the
    // gate forbids while units of the class exist — change the decision
    // instead. Delete only cleans up classes with no units.
    const inUse = await queryOne<any>(
      `SELECT 1 FROM units WHERE property_id=$1 AND unit_type=$2 LIMIT 1`,
      [req.params.id, req.params.unitType])
    if (inUse) {
      throw new AppError(409,
        `Units of this type exist at the property — a late-fee decision must stay in place. ` +
        `Edit the terms or switch it to "no late fee" instead of removing it.`)
    }
    await query(`DELETE FROM property_unit_type_late_fees WHERE property_id=$1 AND unit_type=$2`,
      [req.params.id, req.params.unitType])
    res.json({ success: true })
  } catch (e) { next(e) }
})

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
    // S526: weekly-lease jurisdictions — drops the auto-lease-draft threshold
    // for long stays from 30 days to 7 (services/bookingLeaseDraft.ts).
    const weeklyLeaseMode =
      typeof raw.weeklyLeaseMode === 'boolean' ? raw.weeklyLeaseMode : undefined
    // S537 (Nic): partial payments reset the eviction clock — a landlord
    // preparing to act can refuse anything under the full outstanding
    // balance. Tenant portal's Pay Now enforces it server-side.
    const acceptPartialPayments =
      typeof raw.acceptPartialPayments === 'boolean' ? raw.acceptPartialPayments : undefined

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
        weekly_lease_mode       = COALESCE($15, weekly_lease_mode),
        accept_partial_payments = COALESCE($17, accept_partial_payments),
        updated_at  = NOW()
      WHERE id=$16 RETURNING *`,
      [name||null, street1||null, street2||null, city||null, state||null,
       zip||null, type||null,
       reqAck === undefined ? null : reqAck,
       lateFeeEnabled === undefined ? null : lateFeeEnabled,
       lateFeeGraceDays === undefined ? null : lateFeeGraceDays,
       lateFeeInitialAmount === undefined ? null : lateFeeInitialAmount,
       lateFeeInitialType ?? null,
       subleasingAllowed === undefined ? null : subleasingAllowed,
       flexchargeEnabled === undefined ? null : flexchargeEnabled,
       weeklyLeaseMode === undefined ? null : weeklyLeaseMode,
       req.params.id,
       acceptPartialPayments === undefined ? null : acceptPartialPayments]
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

    // S481: state-law mismatches against the property state's
    // catalogued figures. Mirrors the S476 lease PATCH posture —
    // only checks fields TOUCHED in this PATCH so the warning fires
    // when the landlord acts, not on unrelated edits. The default
    // late-fee config here flows into NEW leases at this property
    // via the LeaseFormModal default-pull, so surfacing the hedged
    // factual notice now beats waiting for per-lease re-flagging
    // later.
    const stateLawWarnings: LawFlag[] = []
    try {
      const stateCode = updated?.state
      if (stateCode) {
        if (lateFeeInitialAmount !== undefined && lateFeeInitialType === 'percent_of_rent') {
          const flag = await checkAgainstStatute(
            stateCode, 'late_fee_max_pct', Number(lateFeeInitialAmount))
          if (flag) stateLawWarnings.push(flag)
        }
        if (lateFeeGraceDays !== undefined) {
          const flag = await checkAgainstStatute(
            stateCode, 'late_fee_grace_days', Number(lateFeeGraceDays))
          if (flag) stateLawWarnings.push(flag)
        }
      }
    } catch (e) {
      logger.error({ err: e, property_id: prop.id }, '[stateLaw] property PATCH checks failed')
    }

    res.json({
      success: true,
      data: { ...updated, state_law_warnings: stateLawWarnings },
    })
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
      // S513 lock: card is always the tenant's — the landlord can never elect to
      // cover card. Accept the field for backward compat but force 'tenant'.
      params.push('tenant')
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
//   - Target user_id must have an active property_manager_scopes OR
//     onsite_manager_scopes row covering this property under this
//     landlord (gate prevents the owner from routing to Random
//     Stranger). S527: onsite managers added — they ARE the day-to-day
//     person at a property; restricting to PM scopes predated the
//     team consolidation.
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

propertiesRouter.patch('/:id/manager', requirePerm('properties.assign_manager'), async (req, res, next) => {
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
      // Validate the target has a property_manager OR onsite_manager
      // scope covering this property under this landlord.
      // all_properties=true OR property_id listed OR a unit under the
      // property listed all qualify.
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
          UNION ALL
         SELECT s.id
           FROM onsite_manager_scopes s
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
          'Target user is not a property-manager or on-site-manager scope holder for this property under this landlord. Add the scope on the Team page first.'
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
// owner (as 'self') plus every property_manager_scopes AND
// onsite_manager_scopes holder whose scope covers this property
// (S527 — a user holding both dedups to property_manager). Frontend
// feeds this to the manager-selection dropdown on the property detail
// page; staff_role labels each row's origin.
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
      staff_role: 'property_manager' | 'onsite_manager'
    }>(
      `WITH scoped AS (
         SELECT s.user_id, 'property_manager'::text AS staff_role
           FROM property_manager_scopes s
          WHERE s.landlord_id = $1
            AND (
              s.all_properties = true
              OR $2::uuid = ANY(s.property_ids)
              OR EXISTS (
                SELECT 1 FROM units un
                 WHERE un.property_id = $2 AND un.id = ANY(s.unit_ids)
              )
            )
         UNION ALL
         SELECT s.user_id, 'onsite_manager'
           FROM onsite_manager_scopes s
          WHERE s.landlord_id = $1
            AND (
              s.all_properties = true
              OR $2::uuid = ANY(s.property_ids)
              OR EXISTS (
                SELECT 1 FROM units un
                 WHERE un.property_id = $2 AND un.id = ANY(s.unit_ids)
              )
            )
       ), dedup AS (
         -- staff_role DESC: 'property_manager' > 'onsite_manager', so a
         -- user holding both scope rows surfaces as property_manager.
         SELECT DISTINCT ON (user_id) user_id, staff_role
           FROM scoped ORDER BY user_id, staff_role DESC
       )
       SELECT u.id AS user_id, u.email, u.first_name, u.last_name, d.staff_role
         FROM dedup d
         JOIN users u ON u.id = d.user_id
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
// path.extname(originalname) — XSS extension-mismatch class (S380
// avatar + S394 esign upload + S395 pending-tenants + this). S535:
// photos are no longer static-served; GET /unit-photo-files/:filename
// below pins the Content-Type from this whitelist, so the on-disk
// extension can never drive text/html.
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

// GET /api/public/properties/listings — S535 (Nic-locked): listings are
// NOT public. Viewing requires sign-in, and tenant-role callers must
// have an approved background check ("accepted to the platform").
// Landlord/staff/admin roles pass on auth alone. The /api/public prefix
// is kept so the listings app URL doesn't move; rename when that
// surface gets its real sign-in flow.
publicPropertiesRouter.get('/listings', requireAuth, async (req: any, res, next) => {
  try {
    const u = req.user!
    if (u.role === 'tenant') {
      const t = await queryOne<{ background_check_status: string }>(
        'SELECT background_check_status FROM tenants WHERE id=$1', [u.profileId])
      if (t?.background_check_status !== 'approved') {
        throw new AppError(403, 'Listings require an approved background check')
      }
    }
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

// GET /api/properties/listings/preview — includes units with < 5 photos
// (landlord preview). S535: moved off the public router — it always read
// req.user!.profileId, so an anonymous hit was a latent 500; it belongs
// behind landlord auth.
propertiesRouter.get('/listings/preview', requireLandlord, async (req, res, next) => {
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

// GET /api/properties/unit-photo-files/:filename — serve a unit photo.
// S535 (Nic-locked): NOTHING is revealed without login — the static
// /uploads/unit-photos mount is gone. Any authenticated platform user
// may fetch photos (landlord staff today; approved applicants when the
// listings surface launches). Content-Type pinned from the extension
// whitelist per the S398/S409 posture.
const EXT_TO_MIME: Record<string, string> = {
  '.jpg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif',
}
propertiesRouter.get('/unit-photo-files/:filename', async (req, res, next) => {
  try {
    const fp = resolveUploadPath(uploadDir, req.params.filename)
    if (!fp) throw new AppError(400, 'Invalid filename')
    if (!fs.existsSync(fp)) throw new AppError(404, 'Not found')
    res.setHeader('Content-Type', EXT_TO_MIME[path.extname(fp).toLowerCase()] ?? 'image/jpeg')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.sendFile(fp)
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
propertiesRouter.post('/units/:id/photos', requirePerm('units.edit_listing'), upload.array('photos', 20), async (req, res, next) => {
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
      const url = `/api/properties/unit-photo-files/${file.filename}`
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
propertiesRouter.delete('/units/:id/photos/:photoId', requirePerm('units.edit_listing'), async (req, res, next) => {
  try {
    const photo = await queryOne<any>(
      'SELECT * FROM unit_photos WHERE id=$1 AND unit_id=$2',
      [req.params.photoId, req.params.id]
    )
    if (!photo) throw new AppError(404, 'Photo not found')
    if (!canManageLandlordResource(req.user, photo.landlord_id)) {
      throw new AppError(403, 'Forbidden')
    }
    // photo.url is '/api/properties/unit-photo-files/<f>' (S535) or the
    // legacy '/uploads/unit-photos/<f>' — resolveUploadPath basenames
    // either form into the photos dir (and blocks traversal).
    const filePath = resolveUploadPath(uploadDir, photo.url)
    if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath)
    await db.query('DELETE FROM unit_photos WHERE id=$1', [photo.id])
    res.json({ success: true })
  } catch (e) { next(e) }
})

// PATCH /api/properties/units/:id/listing — update listing details
propertiesRouter.patch('/units/:id/listing', requirePerm('units.edit_listing'), async (req, res, next) => {
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

// POST /api/properties/:id/units/bulk — REMOVED S527. The Add Property
// wizard's bulk "Create Units" step is gone (Nic: one door for creating
// units). Multi-unit creation is POST /api/units with `quantity` — same
// type/subtype/pricing machinery as single-unit creation.
