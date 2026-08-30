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
import { suggestBookingSlug } from './propertyBookingAdmin'
import { openOnboardingWindow, getOnboardingWindow, closeOnboardingWindow } from '../services/onboardingWindow'
import { draftLeaseFromApplication } from '../services/applicationLeaseDraft'
import { loadSubtype, setSubtypeUnits } from '../services/unitSubtype'
import { AppError } from '../middleware/errorHandler'
import { landlordScopeIds, isEntityMember } from '../lib/landlordScope'
import {
  FEE_PAYER_VALUES,
  PLACEMENT_FEE_TYPE_VALUES,
  PropertyReviewStatus,
  AGENT_REVENUE_CAPABILITIES,
  UNIT_TYPES,
  OCCUPANCY_MODES,
  LISTING_MIN_PHOTOS_BY_UNIT_TYPE,
  LISTING_MIN_PHOTOS_DEFAULT,
  timezoneForState,
} from '@gam/shared'
import { listAgentPermissions, setAgentCapability } from '../services/agentPermissions'
import { logger } from '../lib/logger'
import { checkAgainstStatute, checkLeaseAgainstStateLaw, type LawFlag } from '../services/stateLaw'
import { resolveLeaseSigner } from '../services/leaseSigner'
import { initiateTransfer, approveTransfer, declineTransfer } from '../services/propertyTransfer'

export const propertiesRouter = Router()
export const publicPropertiesRouter = Router()
propertiesRouter.use(requireAuth)

propertiesRouter.get('/', async (req, res, next) => {
  try {
    const isAdmin = req.user!.role === 'admin' || req.user!.role === 'super_admin'
    // S553: a landlord's portfolio aggregates EVERY entity they're an
    // owner-member of (Oak Park LLC next to their own properties — one
    // list, no switcher). Staff/team stay scoped to their one landlord.
    const u = req.user!
    const memberIds = u.role === 'landlord'
      ? Array.from(new Set([u.profileId, ...(u.landlordIds ?? [])]))
      : [u.profileId]
    const filter = isAdmin ? '' : 'WHERE p.landlord_id = ANY($1)'
    const qParams: any[] = isAdmin ? [] : [memberIds]
    // S355 fix: property_allocation_rules has no `id` column (primary key
    // is `property_id`, 1:1 with properties). Pre-S355 the GROUP BY r.id
    // crashed with "column r.id does not exist" on every list call where
    // any property had an allocation_rule row. Group by r.property_id
    // instead — the underlying PK that's referenced via the JOIN.
    const props = await query<any>(`
      SELECT p.*, COUNT(u.id)::int AS total_units,
        COUNT(u.id) FILTER (WHERE u.status='active')::int AS occupied_units,
        COUNT(u.id) FILTER (WHERE u.status='vacant')::int AS vacant_units,
        to_jsonb(r.*) AS allocation_rule,
        COALESCE(ll.business_name, lu.first_name || ' ' || lu.last_name) AS entity_name
      FROM properties p
      LEFT JOIN units u ON u.property_id = p.id
      LEFT JOIN property_allocation_rules r ON r.property_id = p.id
      LEFT JOIN landlords ll ON ll.id = p.landlord_id
      LEFT JOIN users lu ON lu.id = ll.user_id
      ${filter}
      GROUP BY p.id, r.property_id, ll.business_name, lu.first_name, lu.last_name
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
      // S568: FALSE = homes-only external park (investor operates without owning
      // the land; park owner not on GAM). Default TRUE (operator owns the park).
      operatorOwnsLand: z.boolean().optional(),
      // S179 / B3: per-property booking acknowledgment toggle.
      requiresBookingAcknowledgment: z.boolean().optional(),
      // S620 (Nic): "property under new entity but same parent company — same
      // land owner, different LLCs." Which entity this property belongs to.
      // Optional so every existing caller keeps landing on the caller's own
      // entity; supplied by the entity picker on the Add Property form.
      landlordId: z.string().uuid().optional(),
      // 16a: allocation rule required on every property creation.
      // S116: three independent fee toggles replace bankingFeePayer.
      // Legacy callers passing bankingFeePayer auto-mirror into ACH+card.
      allocationRule: z.object({
        achFeePayer:        z.enum(FEE_PAYER_VALUES).optional(),
        cardFeePayer:       z.enum(FEE_PAYER_VALUES).optional(),
        // S607 lock (Nic): the platform fee is ALWAYS the landlord's — GAM's
        // volume discounts must never reach a tenant's bill. Accepted for
        // backward compatibility with older clients, then ignored below.
        platformFeePayer:   z.enum(FEE_PAYER_VALUES).default('landlord'),
        // S607 (Nic): who reimburses the cash/check/money-order fee.
        // Defaults to the tenant — a landlord who has not opted in has not
        // agreed to absorb anything.
        manualFeePayer:     z.enum(FEE_PAYER_VALUES).default('tenant'),
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

    // S550 (Nic): a landlord CAN own two properties that share a name — he
    // buys another "Oak Park", it keeps its name. NEVER block on name alone.
    // The true duplicate is same landlord + same name + same ADDRESS: that's
    // the same physical property entered twice → 409. Distinct address =
    // distinct property; the ADDRESS is the disambiguator everywhere
    // (lease imports resolve by the street number on the lease, and the
    // cross-landlord same-address case is flagged for admin review below).
    // S550 (Nic, final form): the FULL ADDRESS — street + suite/unit line
    // (street2) — is the property. One full address = one record = one
    // account. Strip malls and split outbuildings are real: different
    // owners at "100 Main St" are distinguished by their suite line
    // ("Suite A" vs "Suite B"), so a different account at the same street
    // is allowed ONLY with a different street2 (and still lands in the
    // fuzzy duplicate-address admin flag below for review). A co-owner of
    // the SAME space gets added as a USER on the primary account — never a
    // rival property record.
    //   * Your own account, same name + full address -> "entered twice".
    //   * Your own account, same address, different name -> allowed.
    //   * OTHER account, same street + SAME suite line (or both blank) ->
    //     blocked claim + admin alert (nothing revealed about the owner).
    //   * OTHER account, same street, DIFFERENT suite -> allowed + flagged.
    const atAddress = await queryOne<{ id: string; landlord_id: string; name: string }>(
      `SELECT id, landlord_id, name FROM properties
        WHERE LOWER(TRIM(street1)) = LOWER(TRIM($1))
          AND LOWER(TRIM(city)) = LOWER(TRIM($2))
          AND LOWER(TRIM(state)) = LOWER(TRIM($3))
          AND COALESCE(LOWER(TRIM(street2)), '') = COALESCE(LOWER(TRIM($4)), '')
          AND (landlord_id <> $5 OR LOWER(TRIM(name)) = LOWER(TRIM($6)))
        ORDER BY (landlord_id = $5) DESC
        LIMIT 1`,
      [body.street1, body.city, body.state, body.street2 ?? '', req.user!.profileId, body.name],
    )
    if (atAddress) {
      if (atAddress.landlord_id === req.user!.profileId) {
        throw new AppError(409,
          `"${body.name}" at ${body.street1}, ${body.city} is already in your account — ` +
          `this looks like the same property entered twice. A different property that happens ` +
          `to share the name is fine; enter it with its own address.`)
      }
      const { createAdminNotification } = await import('../services/adminNotifications')
      await createAdminNotification({
        severity: 'warn',
        category: 'duplicate_property_claim',
        title: `Blocked duplicate property claim: ${body.street1}, ${body.city}`,
        body: `Landlord ${req.user!.profileId} tried to create "${body.name}" at ` +
              `${body.street1}${body.street2 ? ' ' + body.street2 : ''}, ${body.city}, ${body.state} — ` +
              `that full address is already registered as "${atAddress.name}" under landlord ` +
              `${atAddress.landlord_id} (property ${atAddress.id}). Possible typo or false claim; ` +
              `review if it repeats.`,
        context: { attemptingLandlordId: req.user!.profileId, existingPropertyId: atAddress.id },
      }).catch(() => {})
      throw new AppError(409,
        `The address ${body.street1}${body.street2 ? ' ' + body.street2 : ''}, ${body.city} is ` +
        `already registered on GAM. If you own a different suite or building at this address, ` +
        `include its suite/unit line (e.g. "Suite B") in the address. If you co-own this ` +
        `property, ask the primary account holder to add you as a user — or contact support ` +
        `if you believe this is an error.`)
    }

    // S620: WHICH ENTITY DOES THIS PROPERTY BELONG TO?
    //
    // Defaults to the caller's own entity, which is what every existing caller
    // gets. When the Add Property form names one, it must be an entity the
    // caller is actually a member of — otherwise anyone could create a property
    // inside somebody else's LLC, which is a far worse bug than the one this
    // feature fixes.
    const targetLandlordId = body.landlordId ?? req.user!.profileId
    // S629: checked against the DATABASE, not just the token. landlordIds is
    // baked into the JWT at login, so an entity created after that login is
    // invisible to a synchronous check — and the session that created the
    // entity is the one session that cannot use it. A landlord who signed up
    // on the 24th and created his LLC on the 28th could not save a property
    // under it: the picker offered the entity (read from the DB) and the route
    // refused it (read from the token), with nothing in the message to suggest
    // that logging out and back in would fix it. See isEntityMember — the
    // token stays the fast path, the DB is consulted only when it says no.
    if (body.landlordId && !(await isEntityMember(req.user!, body.landlordId, query))) {
      throw new AppError(403, 'You are not a member of that entity')
    }

    // S624: the property's TIME ZONE, from its state.
    //
    // Every property used to take the column default `America/Phoenix` — right
    // for the first ones, three hours wrong for the first out-of-state signup.
    // The late-fee engine runs on `NOW() AT TIME ZONE p.timezone`.
    //
    // ONE ZONE PER STATE (Nic S624). A ZIP-level version of this existed for
    // about an hour and was cut: grace periods are measured in days, so an hour
    // of drift only changes an outcome for someone paying within sixty minutes
    // of local midnight on the last day of grace. Not worth a fifteen-state
    // table that is wrong at the edges anyway. A landlord in the minority half
    // of a split state sets it themselves.
    const timezone = timezoneForState(body.state)

    await client.query('BEGIN')

    // Property INSERT — owner_user_id + managed_by_user_id default to the
    // creating user (resolved from landlords.user_id). Owner-self-managed
    // is the default; managed_by can be re-pointed later when handing a
    // property over to a separate PM user.
    const propRes = await client.query<any>(`
      INSERT INTO properties
        (landlord_id, name, street1, street2, city, state, zip, type, unit_types,
         requires_booking_acknowledgment, operator_owns_land,
         owner_user_id, managed_by_user_id, timezone, timezone_source)
      VALUES
        ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,
         (SELECT user_id FROM landlords WHERE id=$1),
         (SELECT user_id FROM landlords WHERE id=$1),
         $12,'derived')
      RETURNING *`,
      [targetLandlordId, body.name, body.street1, body.street2 ?? null,
       body.city, body.state, body.zip, body.type || 'mixed', body.unitTypes || [],
       body.requiresBookingAcknowledgment ?? false, body.operatorOwnsLand ?? true,
       timezone])
    const prop = propRes.rows[0]

    // S579: open the property's onboarding window. While it's open the landlord
    // can grandfather sitting tenants past the background check (per occupied
    // unit, attested); after it closes every new tenant must screen. Length is
    // recomputed against unit count on read, so units added next extend it
    // (within the 30-day cap). See services/onboardingWindow.ts.
    await openOnboardingWindow(prop.id, client)

    // S574 (Nic): every property gets a live public website the moment it's
    // created — auto-assign a booking slug and publish it so the landlord has a
    // shareable site immediately, with no separate "enable" step to hunt for.
    // suggestBookingSlug derives name-city (→ name-street# → name on collision)
    // and guarantees uniqueness. The landlord can rename the address or unpublish
    // per-property on Schedule → Booking Page. Wrapped so a slug collision or any
    // hiccup NEVER blocks property creation — worst case the site stays
    // unpublished and the landlord enables it manually.
    try {
      const autoSlug = await suggestBookingSlug(prop)
      if (autoSlug) {
        await client.query(
          `UPDATE properties SET booking_slug=$1, public_booking_enabled=TRUE WHERE id=$2`,
          [autoSlug, prop.id])
        prop.booking_slug = autoSlug
        prop.public_booking_enabled = true
      }
    } catch (slugErr) {
      logger.error({ err: slugErr, ctx: prop.id }, '[auto-slug] could not auto-publish property site')
    }

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
    const platformFeePayer  = 'landlord'   // S607 lock — never from the request
    await client.query(`
      INSERT INTO property_allocation_rules
        (property_id, ach_fee_payer, card_fee_payer, platform_fee_payer,
         manual_fee_payer,
         rent_percent, rent_percent_floor, rent_percent_ceiling,
         flat_monthly_fee, per_unit_fee,
         placement_fee_type, placement_fee_value,
         maintenance_markup_percent, owner_bank_account_id)
      VALUES ($1,$2,$3,$4,$14,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [prop.id, achFeePayer, cardFeePayer, platformFeePayer,
       ar.rentPercent ?? null, ar.rentPercentFloor ?? null, ar.rentPercentCeiling ?? null,
       ar.flatMonthlyFee ?? null, ar.perUnitFee ?? null,
       ar.placementFeeType ?? null, ar.placementFeeValue ?? null,
       ar.maintenanceMarkupPercent ?? null, ar.ownerBankAccountId ?? null,
       ar.manualFeePayer ?? 'tenant'])

    await client.query('COMMIT')

    // S604 (Nic): if GAM cannot lawfully hold deposits in this state with the
    // current custody vehicle (T-bills via Jiko), raise it the MOMENT the
    // landlord onboards — this is an immediate build, not a backlog item.
    // Post-commit and non-throwing: a custody gap must never block a signup.
    {
      const { flagUnsupportedCustodyState, flagDepositInterestObligation } =
        await import('../services/depositCustody')
      const ctx = {
        stateCode:    body.state,
        landlordId:   req.user!.profileId,
        propertyId:   prop.id,
        propertyName: prop.name,
      }
      // Two independent checks: WHERE the money may sit, and WHAT is owed on it.
      // A state can be fine to custody in and still owe interest from day one.
      void flagUnsupportedCustodyState(ctx)
      void flagDepositInterestObligation(ctx)
    }

    // S550: real-world address verification (parcel corroboration + geocode)
    // — fire-and-forget; never blocks or delays creation. Lands
    // address_verification on the row moments later; 'unverified' raises an
    // admin alert.
    {
      const { verifyPropertyAddress } = await import('../services/addressVerification')
      void verifyPropertyAddress(prop.id, {
        street1: body.street1, street2: body.street2 ?? null,
        city: body.city, state: body.state, zip: body.zip,
      }).catch(() => {})
    }

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
      `SELECT ua.*, u.unit_number, p.name AS property_name,
              t.background_check_status,
              EXISTS (SELECT 1 FROM leases l WHERE l.source_application_id = ua.id) AS lease_drafted
       FROM unit_applications ua
       LEFT JOIN units u ON u.id = ua.unit_id
       LEFT JOIN properties p ON p.id = u.property_id
       LEFT JOIN tenants t ON t.user_id = ua.applicant_user_id
       WHERE ua.landlord_id = $1
       ORDER BY ua.created_at DESC`,
      [req.user!.profileId]
    )
    res.json({ success: true, data: rows })
  } catch (e) { next(e) }
})

// POST /api/properties/applications/:id/onboard — S593 defrag bridge.
// The landlord converts a listings-marketplace application into a draft lease
// (→ the Master Schedule), the long-term mirror of the booking→lease bridge.
// The applicant already has an account + (usually) a cleared background check;
// this drafts a pending/needs-review lease they can review + send for signing.
propertiesRouter.post('/applications/:id/onboard', requirePerm('tenants.create'), async (req: any, res, next) => {
  try {
    const app = await queryOne<{ id: string; landlord_id: string; unit_id: string | null }>(
      'SELECT id, landlord_id, unit_id FROM unit_applications WHERE id=$1', [req.params.id])
    if (!app) throw new AppError(404, 'Application not found')
    if (!canManageLandlordResource(req.user, app.landlord_id)) throw new AppError(403, 'Forbidden')
    if (!app.unit_id) throw new AppError(400, 'This application is not tied to a specific unit — assign a unit first.')
    const result = await draftLeaseFromApplication(req.params.id)
    if (!result.leaseId) throw new AppError(400, 'Could not draft a lease from this application.')
    res.status(201).json({ success: true, data: { leaseId: result.leaseId, alreadyDrafted: !result.drafted } })
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
    // S613: dwelling_ownership was never SELECTed here, so the editor read it
    // back as undefined and defaulted the dropdown to 'tenant' — editing a
    // "Park Model Rental" subtype for any other reason silently flipped it to
    // tenant-owned. unit_count answers "which units is this subtype on?", the
    // question that had no answer anywhere in the product.
    const rows = await query<any>(
      `SELECT s.id, s.unit_type, s.name, s.bedrooms, s.bathrooms, s.rv_site_layout,
              s.rv_amp_service, s.storage_size, s.dwelling_ownership,
              s.rent_amount, s.security_deposit,
              s.nightly_rate, s.weekly_rate, s.monthly_rate, s.created_at, s.updated_at,
              (SELECT count(*) FROM units u
                WHERE u.subtype_id = s.id AND u.retired_at IS NULL)::int AS unit_count
         FROM property_unit_subtypes s
        WHERE s.property_id = $1
        ORDER BY s.unit_type, s.name`,
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
  // S630 DIRECTIVE (Nic): a subtype does NOT price a unit. These are still
  // ACCEPTED so an older client does not start erroring, and they are still
  // stored, but nothing reads them any more — creation, the guest booking quote
  // and the subtype editor all take the price from the UNIT. Do not reintroduce a
  // read; "one price for every unit in the class" is exactly what this directive
  // removed, because one awkward spot has to be discountable on its own.
  rentAmount: z.number().min(0).nullable().optional(),
  securityDeposit: z.number().min(0).nullable().optional(),
  nightlyRate: z.number().min(0).nullable().optional(),
  weeklyRate: z.number().min(0).nullable().optional(),
  monthlyRate: z.number().min(0).nullable().optional(),
  // S550: subtype-level dwelling ownership (rv_spot / mobile_home only) —
  // "MH Lot" mints tenant-owned units, "Park Model Rental" mints park-owned.
  dwellingOwnership: z.enum(['landlord', 'tenant']).nullable().optional(),
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
    const ownershipRelevant = isRv || body.unitType === 'mobile_home'
    const vals = [
      req.params.id, body.unitType, body.name,
      hasBedrooms ? body.bedrooms ?? null : null,
      hasBedrooms ? body.bathrooms ?? null : null,
      isRv ? body.rvSiteLayout ?? null : null,
      isRv ? body.rvAmpService ?? null : null,
      isStorage ? (body.storageSize?.trim() || null) : null,
      body.rentAmount ?? null, body.securityDeposit ?? null,
      body.nightlyRate ?? null, body.weeklyRate ?? null, body.monthlyRate ?? null,
      ownershipRelevant ? body.dwellingOwnership ?? null : null,
    ]

    // S613 (Nic, DATA LOSS): a create whose name already existed used to
    // ON CONFLICT DO UPDATE — it overwrote the existing subtype in place and
    // returned 200, so the landlord saw a save succeed and one subtype in the
    // list. Nic built "Back In / 50 amp" and then "Back In / 30 amp" at Oak
    // Park and the second silently ate the first; the audit log shows the amp
    // flipping 50→30→50→30 on ONE row while he tried again.
    //
    // A property can carry as many subtypes per unit type as the landlord has
    // variations. What it cannot carry is two with the SAME name — the name is
    // how a human picks one when adding a unit, and two identical rows in that
    // picker are unusable. So the collision is refused out loud, naming what
    // already exists and what it holds, instead of being resolved by deletion.
    const clash = await queryOne<any>(
      `SELECT id, name, rv_site_layout, rv_amp_service, bedrooms, bathrooms, storage_size
         FROM property_unit_subtypes
        WHERE property_id=$1 AND unit_type=$2 AND lower(btrim(name))=lower(btrim($3))
          AND ($4::uuid IS NULL OR id <> $4)`,
      [req.params.id, body.unitType, body.name, body.id ?? null],
    )
    if (clash) {
      const facts = [
        clash.bedrooms != null ? (clash.bedrooms === 0 ? 'studio' : `${clash.bedrooms} bed`) : null,
        clash.rv_site_layout && clash.rv_site_layout !== 'none'
          ? (clash.rv_site_layout === 'pull_through' ? 'pull-through' : 'back-in') : null,
        clash.rv_amp_service && clash.rv_amp_service !== 'none'
          ? (clash.rv_amp_service === 'both' ? '30/50 amp' : `${clash.rv_amp_service} amp`) : null,
        clash.storage_size || null,
      ].filter(Boolean).join(', ')
      throw new AppError(409,
        `You already have a subtype called "${clash.name}" for this unit type` +
        (facts ? ` (${facts})` : '') +
        '. Give this one a different name — "Back-in 50 amp" and "Back-in 30 amp" are two subtypes, ' +
        'not one — or edit the existing subtype instead.')
    }

    let row
    if (body.id) {
      row = await queryOne<any>(
        `UPDATE property_unit_subtypes SET
           unit_type=$2, name=$3, bedrooms=$4, bathrooms=$5, rv_site_layout=$6,
           rv_amp_service=$7, storage_size=$8, rent_amount=$9, security_deposit=$10,
           nightly_rate=$11, weekly_rate=$12, monthly_rate=$13,
           dwelling_ownership=$14, updated_at=NOW()
         WHERE id=$15 AND property_id=$1
         RETURNING *`,
        [...vals, body.id],
      )
      if (!row) throw new AppError(404, 'Subtype not found')
    } else {
      row = await queryOne<any>(
        `INSERT INTO property_unit_subtypes
           (property_id, unit_type, name, bedrooms, bathrooms, rv_site_layout,
            rv_amp_service, storage_size, rent_amount, security_deposit,
            nightly_rate, weekly_rate, monthly_rate, dwelling_ownership)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
         RETURNING *`,
        vals,
      )
    }
    res.json({ success: true, data: row })
  } catch (e) { next(e) }
})

// GET /api/properties/:id/unit-subtypes/:rowId/units — which units carry this
// subtype, plus every unit on the property that COULD (same unit type). S613:
// the answer to "where does a subtype link to units" — there was no such
// screen, so the link existed in the database and nowhere a person could see.
propertiesRouter.get('/:id/unit-subtypes/:rowId/units', async (req, res, next) => {
  try {
    const p = await queryOne<any>(`SELECT id, landlord_id FROM properties WHERE id=$1`, [req.params.id])
    if (!p) throw new AppError(404, 'Property not found')
    if (!canAccessLandlordResource(req.user, p.landlord_id)) throw new AppError(403, 'Forbidden')
    const s = await loadSubtype(req.params.rowId, req.params.id)
    if (!s) throw new AppError(404, 'Subtype not found')
    const rows = await query<any>(
      `SELECT u.id, u.unit_number, u.subtype_id,
              EXISTS (SELECT 1 FROM leases l WHERE l.unit_id = u.id
                        AND l.status IN ('active','pending')) AS leased,
              st.name AS current_subtype_name
         FROM units u
         LEFT JOIN property_unit_subtypes st ON st.id = u.subtype_id
        WHERE u.property_id = $1 AND u.unit_type = $2 AND u.retired_at IS NULL
        ORDER BY u.unit_number`,
      [req.params.id, s.unit_type],
    )
    res.json({ success: true, data: rows })
  } catch (e) { next(e) }
})

// PUT /api/properties/:id/unit-subtypes/:rowId/units — set which units carry
// this subtype. MEMBERSHIP: unchecked units currently on it are unlinked.
propertiesRouter.put('/:id/unit-subtypes/:rowId/units', requirePerm('properties.edit'), async (req, res, next) => {
  try {
    const p = await queryOne<any>(`SELECT id, landlord_id FROM properties WHERE id=$1`, [req.params.id])
    if (!p) throw new AppError(404, 'Property not found')
    if (!canManageLandlordResource(req.user, p.landlord_id)) throw new AppError(403, 'Forbidden')
    const body = z.object({
      unitIds: z.array(z.string().uuid()).max(2000),
      // Off by default: linking is classification. Applying rewrites the units.
      applyDetails: z.boolean().optional(),
    }).parse(req.body)
    const s = await loadSubtype(req.params.rowId, req.params.id)
    if (!s) throw new AppError(404, 'Subtype not found')
    try {
      const result = await setSubtypeUnits(s, body.unitIds, { applyDetails: !!body.applyDetails })
      res.json({ success: true, data: result })
    } catch (e: any) {
      throw new AppError(400, e?.message || 'Could not assign those units')
    }
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
        // S577: where the accrual counts from once grace is crossed. Default
        // due_date_inclusive (fits the first cohort; landlord-configurable,
        // neutral copy). grace_end = accrual starts after grace (prior behavior).
        accrualFrom:   z.enum(['grace_end', 'due_date', 'due_date_inclusive']).default('due_date_inclusive'),
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
    // S577: retroactive modes charge only the accrual — force no initial fee
    // when accrual_from is retroactive AND an accrual is configured.
    const retroWithAccrual = !body.noLateFee && body.accrualFrom !== 'grace_end' && body.accrualAmount != null
    const vals = body.noLateFee
      ? { grace: null, amount: null, type: null, accA: null, accT: null, accP: null, accFrom: 'grace_end', capA: null, capT: null }
      : { grace: body.graceDays,
          amount: (retroWithAccrual ? 0 : body.initialAmount).toFixed(2),
          type: body.initialType,
          accA: body.accrualAmount != null ? body.accrualAmount.toFixed(2) : null,
          accT: body.accrualType ?? null, accP: body.accrualPeriod ?? null,
          accFrom: body.accrualFrom,
          capA: body.capAmount != null ? body.capAmount.toFixed(2) : null,
          capT: body.capType ?? null }
    const row = await queryOne<any>(`
      INSERT INTO property_unit_type_late_fees
        (property_id, unit_type, no_late_fee, late_fee_grace_days, late_fee_initial_amount, late_fee_initial_type,
         late_fee_accrual_amount, late_fee_accrual_type, late_fee_accrual_period, late_fee_accrual_from, late_fee_cap_amount, late_fee_cap_type)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      ON CONFLICT (property_id, unit_type) DO UPDATE SET
        no_late_fee = EXCLUDED.no_late_fee,
        late_fee_grace_days = EXCLUDED.late_fee_grace_days,
        late_fee_initial_amount = EXCLUDED.late_fee_initial_amount,
        late_fee_initial_type = EXCLUDED.late_fee_initial_type,
        late_fee_accrual_amount = EXCLUDED.late_fee_accrual_amount,
        late_fee_accrual_type   = EXCLUDED.late_fee_accrual_type,
        late_fee_accrual_period = EXCLUDED.late_fee_accrual_period,
        late_fee_accrual_from   = EXCLUDED.late_fee_accrual_from,
        late_fee_cap_amount     = EXCLUDED.late_fee_cap_amount,
        late_fee_cap_type       = EXCLUDED.late_fee_cap_type,
        updated_at = NOW()
      RETURNING *`,
      [req.params.id, body.unitType, body.noLateFee, vals.grace, vals.amount, vals.type,
       vals.accA, vals.accT, vals.accP, vals.accFrom, vals.capA, vals.capT])
    res.json({ success: true, data: row })
  } catch (e) { next(e) }
})

// S558: the per-(property, unit_type) deposit-multiplier CRUD was removed. The
// deposit multiplier is now a LEASE term on the template (lease_templates.
// deposit_months) so the charge always matches the signed lease — see
// migration 20260726091031 + services/depositPolicy.ts. No property-level
// deposit setting exists any more.

propertiesRouter.delete('/:id/late-fee-overrides/:unitType', requirePerm('properties.edit'), async (req, res, next) => {
  try {
    const prop = await queryOne<any>('SELECT id, landlord_id FROM properties WHERE id=$1', [req.params.id])
    if (!prop) throw new AppError(404, 'Property not found')
    if (!canManageLandlordResource(req.user, prop.landlord_id, ['property_manager'])) throw new AppError(403, 'Forbidden')
    // S577: the forced-decision gate is retired — no fee is the default, so
    // removing a late fee simply reverts the class to no fee. Allowed anytime
    // (existing signed leases keep their stamped terms; only new leases change).
    await query(`DELETE FROM property_unit_type_late_fees WHERE property_id=$1 AND unit_type=$2`,
      [req.params.id, req.params.unitType])
    res.json({ success: true })
  } catch (e) { next(e) }
})

// S579: onboarding-window status for the grandfather UI — how long the window
// is open, whether sitting tenants can still be waived past screening.
propertiesRouter.get('/:id/onboarding-window', async (req, res, next) => {
  try {
    const prop = await queryOne<{ landlord_id: string }>(`SELECT landlord_id FROM properties WHERE id=$1`, [req.params.id])
    if (!prop) throw new AppError(404, 'Property not found')
    if (!canAccessLandlordResource(req.user, prop.landlord_id)) throw new AppError(403, 'Forbidden')
    res.json({ success: true, data: await getOnboardingWindow(req.params.id) })
  } catch (e) { next(e) }
})

// S579: landlord marks onboarding complete — closes the grandfather window
// early. After this, every new tenant on the property must screen.
propertiesRouter.post('/:id/onboarding-complete', requirePerm('properties.edit'), async (req, res, next) => {
  try {
    const prop = await queryOne<{ landlord_id: string }>(`SELECT landlord_id FROM properties WHERE id=$1`, [req.params.id])
    if (!prop) throw new AppError(404, 'Property not found')
    if (!canManageLandlordResource(req.user, prop.landlord_id)) throw new AppError(403, 'Forbidden')
    await closeOnboardingWindow(req.params.id)
    res.json({ success: true, data: await getOnboardingWindow(req.params.id) })
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
    // S630 (Nic): where THIS property's lease-signing requests go, so an on-site
    // manager can sign for their property without the portfolio login or the
    // other properties' mail. Sent explicitly (even as '') to allow clearing it
    // back to the account email, which COALESCE alone cannot express.
    const signingEmailSent = raw.leaseSigningEmail !== undefined
    const signingEmail = signingEmailSent
      ? (String(raw.leaseSigningEmail).trim().toLowerCase() || null) : null
    if (signingEmail && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(signingEmail)) {
      throw new AppError(400, 'That lease-signing address is not a valid email.')
    }
    const signingNameSent = raw.leaseSigningName !== undefined
    const signingName = signingNameSent
      ? (String(raw.leaseSigningName).trim().slice(0, 120) || null) : null

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
    // S616 (Nic): partial payments are not a setting — see the migration.
    // A converged invoice carries two landlords' charges due the same day, and
    // a partial against it has no defensible allocation.
    // S558: property DEFAULT occupancy mode — seeds new units only (each unit's
    // own occupancy_mode is authoritative). Not a governing property setting.
    const defaultOccupancyMode =
      (OCCUPANCY_MODES as readonly string[]).includes(raw.defaultOccupancyMode) ? raw.defaultOccupancyMode : undefined

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
        default_occupancy_mode  = COALESCE($17, default_occupancy_mode),
        operator_owns_land      = COALESCE($18, operator_owns_land),
        lease_signing_email = CASE WHEN $19::boolean THEN $20 ELSE lease_signing_email END,
        lease_signing_name  = CASE WHEN $21::boolean THEN $22 ELSE lease_signing_name  END,
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
       defaultOccupancyMode ?? null,
       typeof raw.operatorOwnsLand === 'boolean' ? raw.operatorOwnsLand : null,
       signingEmailSent, signingEmail, signingNameSent, signingName]
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
      manualFeePayer:     z.enum(FEE_PAYER_VALUES).optional(),
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
    if (body.manualFeePayer !== undefined) {
      params.push(body.manualFeePayer)
      sets.push(`manual_fee_payer = $${params.length}`)
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
    // S607 lock (Nic): platformFeePayer is deliberately NOT patchable — the
    // platform fee is always the landlord's, so GAM's volume discounts can
    // never reach a tenant's bill. The field is still accepted in the body for
    // older clients and simply ignored; a DB CHECK backs the rule up so no
    // future route, script or manual UPDATE can quietly reintroduce it.
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
// ── The public listings marketplace (S593 — 3-tier funnel) ──────────────
// Tier 1 (anonymous): teaser cards — approximate location + price + specs + a
//   few photos. NO exact address, NO property name, NO landlord identity.
// Tier 2 (free account): full details — exact address, all photos, full
//   description. Still NO landlord contact.
// Tier 3 (background-check approved): POST .../apply files the application and
//   reveals the landlord contact — the ONLY path that ever does. See below.
// A unit is listable only when vacant + explicitly listed + has beds/baths +
// enough photos. Neither read exposes the landlord (contact = tier 3), so
// the landlords/users join is gone from both.
//
// S609 (Nic): the photo minimum DEPENDS ON THE UNIT TYPE. A flat five is right
// for somewhere people live inside and impossible for a bare site — an RV spot
// is a patch of ground with a hookup and the renter tows in the thing that would
// have been photographed. One is the honest requirement there; five stopped real
// listings going out.
//
// Built from LISTING_MIN_PHOTOS_BY_UNIT_TYPE so SQL and application agree — the
// values are the shared single source, not a second copy that can drift. The
// CASE is generated rather than written out for the same reason.
const MIN_PHOTO_CASE = `CASE u.unit_type ${
  Object.entries(LISTING_MIN_PHOTOS_BY_UNIT_TYPE)
    .map(([t, n]) => `WHEN '${t}' THEN ${n}`)
    .join(' ')
} ELSE ${LISTING_MIN_PHOTOS_DEFAULT} END`

const LISTABLE_FILTER = `
      FROM units u
      JOIN properties p ON p.id = u.property_id
      LEFT JOIN unit_photos up ON up.unit_id = u.id
      WHERE u.status = 'vacant' AND u.listed_vacant = TRUE
        AND u.bedrooms IS NOT NULL AND u.bathrooms IS NOT NULL
      GROUP BY u.id, p.id
      HAVING COUNT(up.id) >= ${MIN_PHOTO_CASE}
      ORDER BY u.rent_amount ASC`

// GET /api/public/properties/listing-photo/:filename — PUBLIC unit photo.
// S593 (Nic): unit listing photos are marketing images a prospective renter
// can see with NO account. But only photos belonging to a CURRENTLY-LISTED
// vacancy are public here — every other unit photo stays behind the authed
// /unit-photo-files route. Path traversal guarded by resolveUploadPath.
publicPropertiesRouter.get('/listing-photo/:filename', async (req, res, next) => {
  try {
    const fp = resolveUploadPath(uploadDir, req.params.filename)
    if (!fp) throw new AppError(400, 'Invalid filename')
    const row = await queryOne<{ id: string }>(
      `SELECT up.id FROM unit_photos up
         JOIN units u ON u.id = up.unit_id
        WHERE up.url = ANY($1)
          AND u.status = 'vacant' AND u.listed_vacant = TRUE
        LIMIT 1`,
      [[`/api/properties/unit-photo-files/${req.params.filename}`,
        `/uploads/unit-photos/${req.params.filename}`]])
    if (!row) throw new AppError(404, 'Photo not found')
    if (!fs.existsSync(fp)) throw new AppError(404, 'Photo not found')
    res.setHeader('Content-Type', EXT_TO_MIME[path.extname(fp).toLowerCase()] ?? 'image/jpeg')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    // Public marketing image — allow the listings storefront's cross-origin <img>.
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin')
    res.sendFile(fp)
  } catch (e) { next(e) }
})

// Listing photos serve publicly via /listing-photo above; rewrite the stored
// authed path to that public route so anonymous + logged-in reads both load.
const toPublicPhoto = (u: string): string => u
  .replace('/api/properties/unit-photo-files/', '/api/public/properties/listing-photo/')
  .replace('/uploads/unit-photos/', '/api/public/properties/listing-photo/')

// Tier 1 — GET /api/public/properties/listings/browse (NO AUTH).
// The teaser a stranger sees: general area (city/state), rent, specs, and up to
// 3 photos. Deliberately withholds exact address, property name, and any
// landlord info — those are the account / bg-check tiers below.
publicPropertiesRouter.get('/listings/browse', async (_req, res, next) => {
  try {
    const { rows } = await db.query(`
      SELECT
        u.id, u.bedrooms, u.bathrooms, u.sqft, u.rent_amount, u.available_date,
        u.floor_level, u.is_ada_accessible,
        p.city, p.state, p.type AS property_type,
        COALESCE(
          json_agg(up.url ORDER BY up.sort_order ASC) FILTER (WHERE up.id IS NOT NULL),
          '[]'
        ) AS photos,
        COUNT(up.id)::int AS photo_count
      ${LISTABLE_FILTER}
    `)
    // Only the first 3 photos travel to an anonymous viewer, via the public route.
    const teasers = rows.map((r: any) => ({ ...r, photos: (r.photos || []).slice(0, 3).map(toPublicPhoto) }))
    res.json({ success: true, data: teasers })
  } catch (e) { next(e) }
})

// Tier 2 — GET /api/public/properties/listings (LOGGED-IN, any account).
// The S593 redesign removes the old approved-background-check gate from
// BROWSING (it now gates the Apply/Contact action instead). A free account sees
// full details — exact address, all photos, description — but the landlord's
// identity/contact is still withheld until tier 3.
publicPropertiesRouter.get('/listings', requireAuth, async (_req, res, next) => {
  try {
    const { rows } = await db.query(`
      SELECT
        u.id, u.unit_number, u.bedrooms, u.bathrooms, u.sqft,
        u.rent_amount, u.security_deposit, u.available_date, u.listing_description,
        u.floor_level, u.is_ada_accessible,
        p.name AS property_name, p.street1, p.city, p.state, p.zip,
        p.type AS property_type,
        COALESCE(
          json_agg(up.url ORDER BY up.sort_order ASC) FILTER (WHERE up.id IS NOT NULL),
          '[]'
        ) AS photos,
        COUNT(up.id)::int AS photo_count
      ${LISTABLE_FILTER}
    `)
    const out = rows.map((r: any) => ({ ...r, photos: (r.photos || []).map(toPublicPhoto) }))
    res.json({ success: true, data: out })
  } catch (e) { next(e) }
})

// Tier 3 — POST /api/public/properties/listings/:unitId/apply (LOGGED-IN).
// The background check is the ONE hard gate: only an approved/waived renter can
// apply, and applying is the ONLY thing that reveals the landlord's contact
// (anti-circumvention — no landlord↔renter contact before screening).
// Renter-initiated + inbound to the landlord's own listing → FREE (the $1
// contact charge applies only to landlord-initiated pool reach-out).
publicPropertiesRouter.post('/listings/:unitId/apply', requireAuth, async (req: any, res, next) => {
  try {
    const u = req.user!
    if (u.role !== 'tenant') throw new AppError(403, 'Sign in with a renter account to apply')
    if (!z.string().uuid().safeParse(req.params.unitId).success) throw new AppError(404, 'Listing not found')
    const body = z.object({ message: z.string().max(5000).nullish() }).parse(req.body ?? {})

    // The one hard gate. 403 here is what the frontend turns into "start your
    // background check" — the server never trusts the client to have gated it.
    const t = await queryOne<{ background_check_status: string }>(
      'SELECT background_check_status FROM tenants WHERE user_id=$1', [u.userId])
    if (!t || !['approved', 'waived'].includes(t.background_check_status)) {
      throw new AppError(403, 'A completed background check is required to contact a landlord')
    }

    const unit = await queryOne<any>(`
      SELECT u.id, u.unit_number, u.landlord_id, p.name AS property_name,
             lu.id AS landlord_user_id, lu.first_name AS landlord_first,
             lu.last_name AS landlord_last, lu.email AS landlord_email, lu.phone AS landlord_phone
        FROM units u
        JOIN properties p ON p.id = u.property_id
        JOIN landlords l ON l.id = u.landlord_id
        JOIN users lu ON lu.id = l.user_id
       WHERE u.id=$1 AND u.status='vacant' AND u.listed_vacant=TRUE`, [req.params.unitId])
    if (!unit) throw new AppError(404, 'Listing not found')

    const me = await queryOne<any>(
      'SELECT first_name, last_name, email, phone FROM users WHERE id=$1', [u.userId])

    // Idempotent: one application per (listing, renter). A second click just
    // re-reveals the contact instead of stacking duplicate rows.
    let app = await queryOne<{ id: string }>(
      'SELECT id FROM unit_applications WHERE unit_id=$1 AND applicant_user_id=$2', [unit.id, u.userId])
    if (!app) {
      app = await queryOne<{ id: string }>(
        `INSERT INTO unit_applications
           (unit_id, landlord_id, applicant_user_id, first_name, last_name, email, phone, message)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [unit.id, unit.landlord_id, u.userId, me.first_name, me.last_name, me.email, me.phone ?? null,
         body.message ?? null])
      const { createNotification } = await import('../services/notifications')
      await createNotification({
        userId: unit.landlord_user_id,
        landlordId: unit.landlord_id,
        type: 'unit_application',
        title: `New application — ${unit.property_name} · Unit ${unit.unit_number}`,
        body: `${me.first_name} ${me.last_name} (background check cleared) applied to your listing.`,
        data: { application_id: app!.id, unit_id: unit.id, applicant_user_id: u.userId },
        sendEmail: true,
        emailTo: unit.landlord_email,
        emailSubject: `New application — ${unit.property_name} · Unit ${unit.unit_number}`,
      }).catch(() => {})
    }

    res.status(201).json({
      success: true,
      data: {
        applicationId: app!.id,
        landlord: {
          name: `${unit.landlord_first ?? ''} ${unit.landlord_last ?? ''}`.trim() || null,
          email: unit.landlord_email,
          phone: unit.landlord_phone,
        },
      },
    })
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
// S592: resolve the landlord AUTHORITATIVELY — never trust a body-supplied
// landlordId as-is. unit_applications has NO foreign keys, so the DB won't
// reject a bogus id or a unit/landlord mismatch: a public submitter could
// otherwise file an application into another landlord's inbox, or reference a
// unit they don't own (cross-landlord). When a unit is named, its owner is the
// source of truth and any supplied landlordId must match it; a landlord-only
// application must reference a landlord that actually exists.
const publicApplySchema = z.object({
  unitId:         z.string().uuid().optional(),
  landlordId:     z.string().uuid().optional(),
  firstName:      z.string().trim().min(1).max(120),
  lastName:       z.string().trim().min(1).max(120),
  email:          z.string().email().max(200),
  phone:          z.string().max(40).nullish(),
  moveInDate:     z.string().max(40).nullish(),
  monthlyIncome:  z.number().nonnegative().nullish(),
  occupants:      z.number().int().positive().max(50).optional(),
  hasPets:        z.boolean().optional(),
  petDescription: z.string().max(2000).nullish(),
  message:        z.string().max(5000).nullish(),
})
publicPropertiesRouter.post('/apply', async (req, res, next) => {
  try {
    const b = publicApplySchema.parse(req.body)
    if (!b.unitId && !b.landlordId) throw new AppError(400, 'unitId or landlordId required')

    let lid: string
    if (b.unitId) {
      const unit = await queryOne<{ landlord_id: string }>('SELECT landlord_id FROM units WHERE id=$1', [b.unitId])
      if (!unit) throw new AppError(404, 'Unit not found')
      if (b.landlordId && b.landlordId !== unit.landlord_id) throw new AppError(400, 'Unit does not belong to that landlord')
      lid = unit.landlord_id
    } else {
      const landlord = await queryOne<{ id: string }>('SELECT id FROM landlords WHERE id=$1', [b.landlordId!])
      if (!landlord) throw new AppError(404, 'Landlord not found')
      lid = b.landlordId!
    }

    const { rows: [app] } = await db.query(
      `INSERT INTO unit_applications
         (unit_id, landlord_id, first_name, last_name, email, phone, move_in_date, monthly_income, occupants, has_pets, pet_description, message)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [b.unitId ?? null, lid, b.firstName, b.lastName, b.email, b.phone ?? null, b.moveInDate ?? null,
       b.monthlyIncome ?? null, b.occupants ?? 1, b.hasPets ?? false, b.petDescription ?? null, b.message ?? null]
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

// ── S605 (Nic): DESIGNATED LEASE SIGNER ─────────────────────────────────────
// "The property owner can assign it to an on-site manager, but it shouldn't go
// to both people... limit that permission to only one user per property. And if
// that person gets fired or removed from permission, then it defaults back to
// the landlord or the owner."
//
// ONE signer per property, held in a single column so a second is not
// expressible. Only the OWNER may set it — delegating who signs the lease is not
// something a delegate should be able to hand to themselves.
propertiesRouter.put('/:id/lease-signer', requirePerm('properties.edit'), async (req, res, next) => {
  try {
    const body = z.object({
      // null clears the designation — the owner signs again.
      userId: z.string().uuid().nullable(),
    }).parse(req.body)

    const prop = await queryOne<any>(
      `SELECT p.id, p.landlord_id, l.user_id AS owner_user_id
         FROM properties p JOIN landlords l ON l.id = p.landlord_id
        WHERE p.id = $1`, [req.params.id])
    if (!prop) throw new AppError(404, 'Property not found')
    if (!canManageLandlordResource(req.user, prop.landlord_id)) throw new AppError(403, 'Forbidden')
    // The delegation itself is the owner's call, not a manager's.
    if (req.user!.userId !== prop.owner_user_id && req.user!.role !== 'admin' && req.user!.role !== 'super_admin') {
      throw new AppError(403, 'Only the account owner can choose who signs leases')
    }

    if (body.userId) {
      // Must be an on-site manager scoped to THIS property and entitled to sign.
      // Refusing here — rather than silently falling back at signing time — is
      // what makes the setting mean something when the landlord saves it.
      const ok = await queryOne<{ id: string }>(
        `SELECT s.id FROM onsite_manager_scopes s
          WHERE s.user_id = $1 AND s.landlord_id = $2
            AND (s.all_properties = TRUE OR $3 = ANY(s.property_ids))
            AND COALESCE((s.permissions ->> 'leases.sign')::boolean, FALSE) = TRUE
          LIMIT 1`, [body.userId, prop.landlord_id, req.params.id])
      if (!ok) {
        throw new AppError(400,
          'That person needs the “sign leases” permission for this property before they can be the signer.')
      }
    }

    const updated = await queryOne<any>(
      `UPDATE properties SET lease_signer_user_id = $2, updated_at = NOW()
        WHERE id = $1 RETURNING id, lease_signer_user_id`,
      [req.params.id, body.userId])
    res.json({ success: true, data: updated })
  } catch (e) { next(e) }
})

// Who signs today — the designation if it still holds, otherwise the owner.
propertiesRouter.get('/:id/lease-signer', async (req, res, next) => {
  try {
    const prop = await queryOne<any>(
      `SELECT id, landlord_id, lease_signer_user_id FROM properties WHERE id = $1`, [req.params.id])
    if (!prop) throw new AppError(404, 'Property not found')
    if (!canAccessLandlordResource(req.user, prop.landlord_id)) throw new AppError(403, 'Forbidden')
    const signer = await resolveLeaseSigner(prop.landlord_id, prop.id)
    res.json({ success: true, data: {
      designatedUserId: prop.lease_signer_user_id,
      // Differs from designatedUserId when the designated manager has lost the
      // permission — the UI can then say so instead of showing a stale name.
      effectiveSigner: signer,
    } })
  } catch (e) { next(e) }
})

// ── S605 (Nic): SELL A PROPERTY ─────────────────────────────────────────────
// "Transferring ownership of the property account and the record of deposits and
// leases." No money moves — the closing contract settles proration via a credit
// at closing. See services/propertyTransfer.ts for what moves and what stays.
propertiesRouter.post('/:id/transfer', requirePerm('properties.edit'), async (req, res, next) => {
  try {
    const body = z.object({
      // Identify the buyer by the email they log in with — a landlord selling a
      // park knows the buyer's email, not their internal id.
      toEmail: z.string().trim().email(),
      note: z.string().max(500).optional(),
    }).parse(req.body)

    const prop = await queryOne<any>(
      `SELECT p.id, p.landlord_id, l.user_id AS owner_user_id
         FROM properties p JOIN landlords l ON l.id = p.landlord_id
        WHERE p.id = $1`, [req.params.id])
    if (!prop) throw new AppError(404, 'Property not found')
    if (!canManageLandlordResource(req.user, prop.landlord_id)) throw new AppError(403, 'Forbidden')
    // Selling is the owner's act. A manager with properties.edit can configure a
    // property; they cannot give it away.
    if (req.user!.userId !== prop.owner_user_id && req.user!.role !== 'admin' && req.user!.role !== 'super_admin') {
      throw new AppError(403, 'Only the account owner can transfer a property')
    }

    const buyer = await queryOne<any>(
      `SELECT l.id FROM users u JOIN landlords l ON l.user_id = u.id
        WHERE lower(u.email) = lower($1)`, [body.toEmail])
    if (!buyer) {
      throw new AppError(404,
        'No landlord account with that email. The buyer needs to register on GAM before the property can be transferred to them.')
    }

    // S605 (Nic): this RAISES a request — it no longer transfers anything.
    // "Anybody that has a GAM platform account as an owner needs to all have a
    // signing or confirmation... so that one person can't just accidentally sell
    // or transfer account ownership out from underneath other people."
    const result = await initiateTransfer({
      propertyId: req.params.id,
      fromLandlordId: prop.landlord_id,
      toLandlordId: buyer.id,
      byUserId: req.user!.userId,
      note: body.note ?? null,
    })
    res.status(202).json({ success: true, data: result })
  } catch (e) { next(e) }
})

// The transfer history for a property — who owned it, and when it changed hands.
propertiesRouter.get('/:id/transfers', async (req, res, next) => {
  try {
    const prop = await queryOne<any>(
      `SELECT id, landlord_id FROM properties WHERE id = $1`, [req.params.id])
    if (!prop) throw new AppError(404, 'Property not found')
    if (!canAccessLandlordResource(req.user, prop.landlord_id)) throw new AppError(403, 'Forbidden')
    const rows = await query<any>(
      `SELECT t.id, t.transferred_at, t.moved, t.note,
              fl.business_name AS from_name, tl.business_name AS to_name
         FROM property_transfers t
         JOIN landlords fl ON fl.id = t.from_landlord_id
         JOIN landlords tl ON tl.id = t.to_landlord_id
        WHERE t.property_id = $1
        ORDER BY t.transferred_at DESC`, [req.params.id])
    res.json({ success: true, data: rows })
  } catch (e) { next(e) }
})

// The pending sale for a property, and where each owner stands on it.
propertiesRouter.get('/:id/transfer-request', async (req, res, next) => {
  try {
    const prop = await queryOne<any>(
      `SELECT id, landlord_id FROM properties WHERE id = $1`, [req.params.id])
    if (!prop) throw new AppError(404, 'Property not found')
    if (!canAccessLandlordResource(req.user, prop.landlord_id)) throw new AppError(403, 'Forbidden')

    const reqRow = await queryOne<any>(
      `SELECT r.id, r.status, r.expires_at, r.note, r.initiated_by,
              tl.business_name AS buyer_name
         FROM property_transfer_requests r
         JOIN landlords tl ON tl.id = r.to_landlord_id
        WHERE r.property_id = $1 AND r.status = 'pending'
        LIMIT 1`, [req.params.id])
    if (!reqRow) return res.json({ success: true, data: null })

    const approvals = await query<any>(
      `SELECT a.user_id, a.approved_at, a.declined_at,
              TRIM(COALESCE(u.first_name,'') || ' ' || COALESCE(u.last_name,'')) AS name, u.email
         FROM property_transfer_approvals a JOIN users u ON u.id = a.user_id
        WHERE a.request_id = $1
        ORDER BY u.first_name`, [reqRow.id])

    res.json({ success: true, data: {
      ...reqRow,
      approvals,
      // Never send the codes — each owner has their own, by email.
      youApproved: approvals.some((a: any) => a.user_id === req.user!.userId && a.approved_at),
      youAreApprover: approvals.some((a: any) => a.user_id === req.user!.userId),
    } })
  } catch (e) { next(e) }
})

// Confirm with the code from your email. The LAST approval executes the sale.
propertiesRouter.post('/transfer-request/:requestId/approve', async (req, res, next) => {
  try {
    const { code } = z.object({ code: z.string().min(4).max(12) }).parse(req.body)
    const result = await approveTransfer({
      requestId: req.params.requestId, userId: req.user!.userId, code: code.trim(),
    })
    res.json({ success: true, data: result })
  } catch (e) { next(e) }
})

// Any one owner can stop it — consent is unanimous, so a single refusal decides.
propertiesRouter.post('/transfer-request/:requestId/decline', async (req, res, next) => {
  try {
    await declineTransfer(req.params.requestId, req.user!.userId)
    res.json({ success: true, data: { cancelled: true } })
  } catch (e) { next(e) }
})

/**
 * Whatever real history a property carries, in the landlord's words.
 *
 * S630 (Nic): "there's no possible way to delete a property that I can see."
 * There wasn't — units had a delete path and properties never did, so a test
 * property created during an earlier session's application-fee work sat in his
 * portfolio with no way to remove it.
 *
 * TENANCY is what makes a property undeletable: somebody lived there, paid, or
 * booked. GAM's own bookkeeping about the property — the monthly fee accrual and
 * the analytics snapshots — is not the landlord's history and does not block;
 * those are handled below.
 */
async function propertyHistoryBlocker(propertyId: string): Promise<string | null> {
  const probes: Array<{ label: string; sql: string }> = [
    { label: 'a lease',    sql: `SELECT 1 FROM leases l JOIN units u ON u.id=l.unit_id WHERE u.property_id=$1 LIMIT 1` },
    { label: 'a payment',  sql: `SELECT 1 FROM payments p WHERE p.unit_id IN (SELECT id FROM units WHERE property_id=$1) LIMIT 1` },
    { label: 'a booking',  sql: `SELECT 1 FROM unit_bookings b WHERE b.unit_id IN (SELECT id FROM units WHERE property_id=$1) LIMIT 1` },
    { label: 'a security deposit', sql: `SELECT 1 FROM security_deposits d WHERE d.unit_id IN (SELECT id FROM units WHERE property_id=$1) LIMIT 1` },
    { label: 'a maintenance request', sql: `SELECT 1 FROM maintenance_requests m WHERE m.unit_id IN (SELECT id FROM units WHERE property_id=$1) LIMIT 1` },
    { label: 'a tenant invited to it', sql: `SELECT 1 FROM pending_tenant_intents i WHERE i.property_id=$1 AND i.cancelled_at IS NULL LIMIT 1` },
    { label: 'a utility meter with readings',
      sql: `SELECT 1 FROM utility_meters m JOIN utility_meter_readings r ON r.meter_id=m.id WHERE m.property_id=$1 LIMIT 1` },
  ]
  for (const p of probes) {
    const hit = await queryOne<{ one: number }>(p.sql.replace('SELECT 1', 'SELECT 1 AS one'), [propertyId])
    if (hit) return p.label
  }
  return null
}

// DELETE /api/properties/:id — PLATFORM OPERATOR ONLY.
//
// S630 DIRECTIVE (Nic): "Properties are not allowed to be deleted... landlords
// are not allowed to delete properties as we need to check the full history of
// stuff on the platform. Landlords can transfer property to another landlord,
// they can be non-charged for a property if all the units become vacant. That is
// it. Once the property is on the platform, it's on there forever."
//
// I had briefly put a delete control on the property page. That was wrong and it
// is gone. A landlord's route out of a property is TRANSFER, or letting it go
// vacant and stop being billable — never removal, because the platform has to be
// able to look back at what happened at an address.
//
// This survives for one narrow case: a record that was never a real property, of
// the kind an operator creates while testing. Restricted to super_admin, and it
// still refuses the moment any tenancy exists.
//
// GAM never erases history. What this clears is GAM's own bookkeeping about the
// property: the monthly platform-fee accrual (a working calculation) and the
// growth snapshots (analytics, recomputed nightly). The platform_revenue_ledger
// entry is NEVER deleted — it is the book of record and carries a running balance
// every later row is computed from; its property_id is nulled instead, so the
// money survives with its note and only the pointer goes.
propertiesRouter.delete('/:id', async (req, res, next) => {
  try {
    if (req.user!.role !== 'super_admin') {
      throw new AppError(403,
        'Properties cannot be deleted. A property stays on the platform so its history stays with ' +
        'it — transfer it to another landlord instead, or let it go vacant so it stops being billable.')
    }
    const prop = await queryOne<any>('SELECT * FROM properties WHERE id=$1', [req.params.id])
    if (!prop) throw new AppError(404, 'Property not found')

    const blocker = await propertyHistoryBlocker(req.params.id)
    if (blocker) {
      throw new AppError(409,
        `“${prop.name}” has ${blocker} on record, so it can't be deleted — GAM keeps that history. ` +
        `If it is no longer yours, transfer it instead.`)
    }

    const client = await db.connect()
    try {
      await client.query('BEGIN')
      await client.query(
        `UPDATE platform_revenue_ledger SET property_id = NULL WHERE property_id = $1`, [req.params.id])
      await client.query(`DELETE FROM platform_fee_accruals   WHERE property_id = $1`, [req.params.id])
      await client.query(`DELETE FROM property_growth_snapshots WHERE property_id = $1`, [req.params.id])
      await client.query(`DELETE FROM utility_meter_units WHERE meter_id IN (SELECT id FROM utility_meters WHERE property_id=$1)`, [req.params.id])
      await client.query(`DELETE FROM utility_meters WHERE property_id = $1`, [req.params.id])
      await client.query(`DELETE FROM units      WHERE property_id = $1`, [req.params.id])
      await client.query(`DELETE FROM properties WHERE id = $1`, [req.params.id])
      await client.query(
        `INSERT INTO audit_log (user_id, action, entity_type, entity_id, old_value, new_value)
         VALUES ($1,'property_deleted','property',$2,$3::jsonb,'{}'::jsonb)`,
        [req.user!.userId, req.params.id,
         JSON.stringify({ name: prop.name, street1: prop.street1, landlord_id: prop.landlord_id })]
      ).catch(() => {})
      await client.query('COMMIT')
    } catch (e) { await client.query('ROLLBACK'); throw e }
    finally { client.release() }

    res.json({ success: true, data: { deleted: true, name: prop.name } })
  } catch (e) { next(e) }
})
