/**
 * S455 — businesses CRUD.
 *
 * Five endpoints serving the new service-business entity (S453):
 *
 *   POST   /api/businesses             — owner self-signup (public)
 *   GET    /api/businesses/me          — current owner's business
 *   PATCH  /api/businesses/me          — update mutable fields
 *   GET    /api/businesses             — admin-only list
 *   PATCH  /api/businesses/:id/status  — admin-only status flip
 *
 * Owner self-signup is a single transaction: creates a `users` row
 * with role='business_owner' (S454 enum), creates the `businesses`
 * row, returns a JWT minted with businessId so the owner lands
 * directly in the business portal.
 *
 * business_users + business_customers CRUD live in subsequent route
 * files (S456 scope).
 */

import { Router } from 'express'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { z } from 'zod'
import { db, query, queryOne } from '../db'
import { requireAuth, requireRole } from '../middleware/auth'
import { AppError } from '../middleware/errorHandler'
import { isDisposableEmail } from '../lib/email'
import {
  BUSINESS_TYPES,
  BUSINESS_STATUSES,
  BUSINESS_FEATURES,
  BUSINESS_TYPE_DEFAULT_FEATURES,
  BUSINESS_FEATURE_ALWAYS_ON,
} from '@gam/shared'

export const businessesRouter = Router()

// S282/S454 alignment: 12 chars min, matches /api/auth/register and
// /api/auth/register-prospect. NIST SP 800-63B — length over composition.
const PASSWORD_MIN_LEN = 12

const signupSchema = z.object({
  // Business identity
  businessName: z.string().min(1),
  businessType: z.enum(BUSINESS_TYPES),
  // Owner identity (becomes the users row)
  firstName: z.string().min(1),
  lastName:  z.string().min(1),
  email:     z.string().email(),
  phone:     z.string().optional(),
  password:  z.string().min(PASSWORD_MIN_LEN),
  // Legal — refuse the signup if false/missing so accepted_*_at
  // timestamps on users are never a lie. Same gate /register uses.
  acceptedTerms: z.literal(true, {
    errorMap: () => ({ message: 'You must accept the Terms of Service and Privacy Policy to register' }),
  }),
  // Optional address; can also be PATCH'd later.
  street1: z.string().optional(),
  street2: z.string().optional(),
  city:    z.string().optional(),
  state:   z.string().optional(),
  zip:     z.string().optional(),
  ein:     z.string().optional(),
})

function signToken(payload: object) {
  return jwt.sign(payload, process.env.JWT_SECRET!, { expiresIn: '7d' })
}

// POST /api/businesses — owner self-signup (public; no auth middleware)
businessesRouter.post('/', async (req, res, next) => {
  try {
    const body = signupSchema.parse(req.body)

    if (isDisposableEmail(body.email)) {
      throw new AppError(400, 'Disposable / temporary email addresses are not allowed')
    }
    const exists = await queryOne('SELECT id FROM users WHERE LOWER(email) = LOWER($1)', [body.email])
    if (exists) throw new AppError(409, 'An account with this email already exists. Please sign in.')

    const hash = await bcrypt.hash(body.password, 12)
    const client = await db.connect()
    try {
      await client.query('BEGIN')

      // 1) users row — role=business_owner (S454 enum), accept_at
      //    timestamps stamped so the legal gate matches /register.
      const { rows: [user] } = await client.query<{
        id: string; email: string; first_name: string; last_name: string
      }>(
        `INSERT INTO users
           (email, password_hash, role, first_name, last_name, phone,
            accepted_tos_at, accepted_privacy_at)
         VALUES ($1, $2, 'business_owner', $3, $4, $5, NOW(), NOW())
         RETURNING id, email, first_name, last_name`,
        [body.email, hash, body.firstName, body.lastName, body.phone ?? null])

      // 2) businesses row — owner_user_id ties it back. Business
      //    `email` defaults to the owner's email at signup; PATCH /me
      //    can change it later if the business has a distinct contact.
      // S492: enabled_features pre-populated from the business_type
      //    default catalog in shared. Owner can edit anytime via
      //    Settings → Features (PATCH /me/features).
      const defaultFeatures = BUSINESS_TYPE_DEFAULT_FEATURES[body.businessType] ?? []
      const { rows: [biz] } = await client.query<{
        id: string; name: string; business_type: string; status: string;
        enabled_features: string[]
      }>(
        `INSERT INTO businesses
           (owner_user_id, name, business_type, email, phone,
            street1, street2, city, state, zip, ein, enabled_features)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         RETURNING id, name, business_type, status, enabled_features`,
        [user.id, body.businessName, body.businessType,
         body.email, body.phone ?? null,
         body.street1 ?? null, body.street2 ?? null,
         body.city ?? null, body.state ?? null, body.zip ?? null,
         body.ein ?? null, defaultFeatures])

      await client.query('COMMIT')

      const token = signToken({
        userId:     user.id,
        role:       'business_owner',
        email:      user.email,
        profileId:  biz.id,
        businessId: biz.id,
        staffRole:  null,
      })
      res.status(201).json({
        success: true,
        data: {
          token,
          user: {
            id: user.id, email: user.email, role: 'business_owner',
            firstName: user.first_name, lastName: user.last_name,
            profileId: biz.id,
            businessId: biz.id,
            staffRole: null,
          },
          business: {
            id: biz.id, name: biz.name,
            businessType: biz.business_type,
            status: biz.status,
            enabledFeatures: biz.enabled_features,
          },
        },
      })
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {})
      throw e
    } finally {
      client.release()
    }
  } catch (e) { next(e) }
})

// GET /api/businesses/me — current owner's business
businessesRouter.get('/me', requireAuth, async (req, res, next) => {
  try {
    if (req.user!.role !== 'business_owner') {
      // Staff use /me-as-staff (future); admins can use the list route.
      // For now, only owners read their business through /me.
      throw new AppError(403, 'Only business owners can read /me')
    }
    const biz = await queryOne<any>(
      `SELECT id, owner_user_id, name, business_type, email, phone,
              street1, street2, city, state, zip, ein,
              stripe_connect_account_id,
              connect_payouts_enabled, connect_details_submitted,
              status, notes, enabled_features,
              default_tax_rate, tax_label,
              public_booking_enabled, public_booking_slug,
              public_booking_intro, business_hours,
              created_at, updated_at
         FROM businesses
        WHERE owner_user_id = $1
          AND status IN ('active', 'suspended')
        ORDER BY created_at DESC
        LIMIT 1`,
      [req.user!.userId])
    if (!biz) throw new AppError(404, 'No active business found for this owner')
    res.json({ success: true, data: biz })
  } catch (e) { next(e) }
})

// S492: PATCH /api/businesses/me/features — owner toggles which
// features are enabled. Validates against the shared catalog +
// enforces always-on features (customers, staff) regardless of body.
// The DB CHECK constraint is the deeper guard against unknown keys.
const patchFeaturesSchema = z.object({
  enabledFeatures: z.array(z.enum(BUSINESS_FEATURES)),
}).strict()

businessesRouter.patch('/me/features', requireAuth, async (req, res, next) => {
  try {
    if (req.user!.role !== 'business_owner') {
      throw new AppError(403, 'Only business owners can update features')
    }
    const { enabledFeatures } = patchFeaturesSchema.parse(req.body)
    // Always-on features are non-negotiable — re-insert if the body
    // omitted them. Owner UI can't turn them off either; this defends
    // against a direct API call that tries.
    const merged = Array.from(new Set([
      ...BUSINESS_FEATURE_ALWAYS_ON,
      ...enabledFeatures,
    ]))
    const r = await query<{ id: string; enabled_features: string[] }>(
      `UPDATE businesses
          SET enabled_features = $1
        WHERE owner_user_id = $2
          AND status IN ('active', 'suspended')
        RETURNING id, enabled_features`,
      [merged, req.user!.userId])
    if (r.length === 0) throw new AppError(404, 'No active business found for this owner')
    res.json({ success: true, data: r[0] })
  } catch (e) { next(e) }
})

const patchMeSchema = z.object({
  businessName:    z.string().min(1).optional(),
  businessType:    z.enum(BUSINESS_TYPES).optional(),
  email:           z.string().email().optional(),
  phone:           z.string().nullable().optional(),
  street1:         z.string().nullable().optional(),
  street2:         z.string().nullable().optional(),
  city:            z.string().nullable().optional(),
  state:           z.string().nullable().optional(),
  zip:             z.string().nullable().optional(),
  ein:             z.string().nullable().optional(),
  notes:           z.string().nullable().optional(),
  // S506 sales-tax config
  defaultTaxRate:  z.number().min(0).max(0.9999).optional(),
  taxLabel:        z.string().min(1).max(60).optional(),
  // S507 public booking config
  publicBookingEnabled: z.boolean().optional(),
  publicBookingSlug:    z.string().regex(/^[a-z0-9][a-z0-9-]{1,60}$/).refine(s => !s.includes('--'),
    'No consecutive hyphens').nullable().optional(),
  publicBookingIntro:   z.string().max(2000).nullable().optional(),
  businessHours:        z.record(z.string(), z.union([
    z.null(),
    z.object({
      open:  z.string().regex(/^\d{2}:\d{2}$/),
      close: z.string().regex(/^\d{2}:\d{2}$/),
    }),
  ])).optional(),
}).strict()  // refuses unknown keys (status flip is the admin route)

// PATCH /api/businesses/me — update mutable fields for the owner's business
businessesRouter.patch('/me', requireAuth, async (req, res, next) => {
  try {
    if (req.user!.role !== 'business_owner') {
      throw new AppError(403, 'Only business owners can update /me')
    }
    const patch = patchMeSchema.parse(req.body)
    // Empty patch — refuse cleanly so callers see the no-op explicitly
    // rather than getting a 200 with nothing changed (matches the
    // PATCH-empty pattern in routes/auth.ts:PATCH /me etc.)
    if (Object.keys(patch).length === 0) {
      throw new AppError(400, 'Nothing to update')
    }
    // COALESCE pattern — omitted fields keep their current value.
    // Explicit null (e.g. clearing notes) is preserved by the query
    // (COALESCE($N, col) only swaps to col when $N is null AND that's
    // what zod's `.nullable()` gates allow above).
    await query(
      `UPDATE businesses
          SET name                   = COALESCE($1,  name),
              business_type          = COALESCE($2,  business_type),
              email                  = COALESCE($3,  email),
              phone                  = COALESCE($4,  phone),
              street1                = COALESCE($5,  street1),
              street2                = COALESCE($6,  street2),
              city                   = COALESCE($7,  city),
              state                  = COALESCE($8,  state),
              zip                    = COALESCE($9,  zip),
              ein                    = COALESCE($10, ein),
              notes                  = COALESCE($11, notes),
              default_tax_rate       = COALESCE($13, default_tax_rate),
              tax_label              = COALESCE($14, tax_label),
              public_booking_enabled = COALESCE($15, public_booking_enabled),
              public_booking_slug    = COALESCE($16, public_booking_slug),
              public_booking_intro   = COALESCE($17, public_booking_intro),
              business_hours         = COALESCE($18, business_hours)
        WHERE owner_user_id = $12
          AND status IN ('active', 'suspended')`,
      [
        patch.businessName ?? null,
        patch.businessType ?? null,
        patch.email        ?? null,
        patch.phone        ?? null,
        patch.street1      ?? null,
        patch.street2      ?? null,
        patch.city         ?? null,
        patch.state        ?? null,
        patch.zip          ?? null,
        patch.ein          ?? null,
        patch.notes        ?? null,
        req.user!.userId,
        patch.defaultTaxRate ?? null,
        patch.taxLabel     ?? null,
        patch.publicBookingEnabled ?? null,
        patch.publicBookingSlug === undefined ? null : patch.publicBookingSlug,
        patch.publicBookingIntro === undefined ? null : (patch.publicBookingIntro?.trim() ?? null),
        patch.businessHours ? JSON.stringify(patch.businessHours) : null,
      ])
    const biz = await queryOne<any>(
      `SELECT id, name, business_type, email, phone,
              street1, street2, city, state, zip, ein, notes,
              status, updated_at,
              default_tax_rate, tax_label,
              public_booking_enabled, public_booking_slug,
              public_booking_intro, business_hours
         FROM businesses
        WHERE owner_user_id = $1
          AND status IN ('active', 'suspended')
        ORDER BY created_at DESC
        LIMIT 1`,
      [req.user!.userId])
    if (!biz) throw new AppError(404, 'No active business found for this owner')
    res.json({ success: true, data: biz })
  } catch (e) { next(e) }
})

// GET /api/businesses — admin-only list
businessesRouter.get('/', requireAuth, requireRole('admin', 'super_admin'),
  async (_req, res, next) => {
  try {
    const rows = await query<any>(
      `SELECT b.id, b.name, b.business_type, b.email, b.phone,
              b.city, b.state, b.status,
              b.created_at,
              u.email AS owner_email,
              u.first_name AS owner_first_name,
              u.last_name  AS owner_last_name
         FROM businesses b
         JOIN users u ON u.id = b.owner_user_id
        ORDER BY b.created_at DESC
        LIMIT 200`)
    res.json({ success: true, data: rows })
  } catch (e) { next(e) }
})

const statusPatchSchema = z.object({
  status: z.enum(BUSINESS_STATUSES),
})

// PATCH /api/businesses/:id/status — admin-only status flip
businessesRouter.patch('/:id/status', requireAuth, requireRole('admin', 'super_admin'),
  async (req, res, next) => {
  try {
    const { status } = statusPatchSchema.parse(req.body)
    const r = await query<{ id: string; status: string }>(
      `UPDATE businesses SET status = $1 WHERE id = $2
       RETURNING id, status`,
      [status, req.params.id])
    if (r.length === 0) throw new AppError(404, 'Business not found')
    res.json({ success: true, data: r[0] })
  } catch (e) { next(e) }
})

// ═══════════════════════════════════════════════════════════════════
//  S494: Stripe Connect onboarding for business operators
// ═══════════════════════════════════════════════════════════════════

// POST /api/businesses/me/connect/onboarding-link — create or reuse the
// business's Stripe Connect account and return a fresh Account Session
// client_secret for the embedded onboarding component.
businessesRouter.post('/me/connect/onboarding-link', requireAuth, async (req, res, next) => {
  try {
    if (req.user!.role !== 'business_owner') {
      throw new AppError(403, 'Only business owners can set up payments')
    }
    const biz = await queryOne<{
      id: string; email: string; name: string;
      stripe_connect_account_id: string | null;
    }>(
      `SELECT id, email, name, stripe_connect_account_id
         FROM businesses
        WHERE owner_user_id = $1 AND status IN ('active', 'suspended')
        ORDER BY created_at DESC LIMIT 1`,
      [req.user!.userId])
    if (!biz) throw new AppError(404, 'No active business for this owner')

    const { ensureConnectAccount, createOnboardingSession } = await import('../services/stripeConnect')
    const accountId = await ensureConnectAccount({
      entity:       'business',
      entityId:     biz.id,
      email:        biz.email,
      businessName: biz.name,
      metadata:     { gam_purpose: 'business_invoicing' },
    })
    const clientSecret = await createOnboardingSession(accountId)
    res.json({
      success: true,
      data: { clientSecret, accountId },
    })
  } catch (e) { next(e) }
})

// GET /api/businesses/me/connect/account-status — live Connect state.
businessesRouter.get('/me/connect/account-status', requireAuth, async (req, res, next) => {
  try {
    if (req.user!.role !== 'business_owner') {
      throw new AppError(403, 'Only business owners can view Connect status')
    }
    const biz = await queryOne<{
      id: string;
      stripe_connect_account_id: string | null;
    }>(
      `SELECT id, stripe_connect_account_id
         FROM businesses
        WHERE owner_user_id = $1 AND status IN ('active', 'suspended')
        ORDER BY created_at DESC LIMIT 1`,
      [req.user!.userId])
    if (!biz) throw new AppError(404, 'No active business for this owner')

    // No Connect account yet — return the placeholder state so the UI
    // can render "Get started" instead of an error.
    if (!biz.stripe_connect_account_id) {
      return res.json({
        success: true,
        data: {
          accountId:                    null,
          charges_enabled:              false,
          payouts_enabled:              false,
          details_submitted:            false,
          requirements_currently_due:   [],
          requirements_past_due:        [],
          requirements_disabled_reason: null,
        },
      })
    }

    const { fetchAccountStatus } = await import('../services/stripeConnect')
    const status = await fetchAccountStatus(biz.stripe_connect_account_id)
    // Persist the flags onto the businesses row so other surfaces
    // (invoice send, dashboard) can read them without round-tripping
    // to Stripe.
    await query(
      `UPDATE businesses
          SET connect_payouts_enabled    = $1,
              connect_details_submitted  = $2
        WHERE id = $3`,
      [status.payouts_enabled, status.details_submitted, biz.id])
    res.json({
      success: true,
      data: { accountId: biz.stripe_connect_account_id, ...status },
    })
  } catch (e) { next(e) }
})
