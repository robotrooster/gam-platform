/**
 * S457 — business_customers CRUD.
 *
 * Five endpoints managing a business's customer roster:
 *
 *   POST   /api/business-customers              — create
 *   GET    /api/business-customers              — list (status filter)
 *   GET    /api/business-customers/:id          — read
 *   PATCH  /api/business-customers/:id          — update
 *   POST   /api/business-customers/:id/archive  — flip status
 *
 * Owner-only for now. Staff access (managers/dispatchers can edit;
 * drivers can read their assigned customers only) is a future expansion
 * once the staff-permission framework is built out — flagged in the
 * S457 handoff.
 *
 * lat/lon are nullable here; populated by the geocoder that lands in
 * Phase 1a.2. Routing engine in Phase 1a.3 will skip un-geocoded
 * customers until they backfill.
 */

import { Router } from 'express'
import { z } from 'zod'
import { query, queryOne } from '../db'
import { requireAuth } from '../middleware/auth'
import { AppError } from '../middleware/errorHandler'
import { geocode } from '../services/geocoder'
import { logger } from '../lib/logger'
import {
  BUSINESS_CUSTOMER_TYPES,
  BUSINESS_CUSTOMER_STATUSES,
} from '@gam/shared'

export const businessCustomersRouter = Router()

// ── helpers ────────────────────────────────────────────────────

/** Resolve the businessId for the calling owner. Errors if non-owner
 *  or no active business. */
async function requireOwnerBusinessId(req: any): Promise<string> {
  if (req.user!.role !== 'business_owner') {
    throw new AppError(403, 'Only business owners can manage customers')
  }
  const biz = await queryOne<{ id: string }>(
    `SELECT id FROM businesses
      WHERE owner_user_id = $1 AND status IN ('active', 'suspended')
      ORDER BY created_at DESC LIMIT 1`,
    [req.user!.userId])
  if (!biz) throw new AppError(404, 'No active business for this owner')
  return biz.id
}

// ═══════════════════════════════════════════════════════════════
//  POST /  — create
// ═══════════════════════════════════════════════════════════════

const createSchema = z.object({
  customerType: z.enum(BUSINESS_CUSTOMER_TYPES),
  companyName:  z.string().optional(),
  firstName:    z.string().min(1),
  lastName:     z.string().min(1),
  email:        z.string().email().optional(),
  phone:        z.string().optional(),
  street1:      z.string().min(1),
  street2:      z.string().optional(),
  city:         z.string().min(1),
  state:        z.string().min(1),
  zip:          z.string().min(1),
  notes:        z.string().optional(),
  unitCount:    z.number().int().min(0).optional(),
})

businessCustomersRouter.post('/', requireAuth, async (req, res, next) => {
  try {
    const businessId = await requireOwnerBusinessId(req)
    const body = createSchema.parse(req.body)

    // App-layer guard mirroring the schema CHECK so the user gets a
    // clean 400 instead of a 500 on the constraint violation.
    if (body.customerType === 'business' && !body.companyName?.trim()) {
      throw new AppError(400, 'companyName is required when customerType is "business"')
    }

    const [row] = await query<{ id: string }>(
      `INSERT INTO business_customers
         (business_id, customer_type, company_name,
          first_name, last_name, email, phone,
          street1, street2, city, state, zip, notes, unit_count)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       RETURNING id`,
      [businessId, body.customerType,
       body.customerType === 'business' ? body.companyName?.trim() : null,
       body.firstName, body.lastName,
       body.email ?? null, body.phone ?? null,
       body.street1, body.street2 ?? null,
       body.city, body.state, body.zip,
       body.notes ?? null, body.unitCount ?? 1])

    // S465: synchronous geocode on create. Failure-tolerant — if the
    // geocoder can't resolve the address, the row stays with
    // lat/lon=null and the dispatcher backfills via /:id/geocode
    // later. The geocoder service contract is "NEVER throws," but
    // S469 belt-and-suspenders wraps the call defensively so a future
    // contract slip doesn't take down customer create.
    let coords: { lat: number; lon: number } | null = null
    try {
      coords = await geocode({
        street1: body.street1, street2: body.street2 ?? null,
        city: body.city, state: body.state, zip: body.zip,
      })
    } catch (e) {
      logger.error({ err: e, customer_id: row.id }, '[geocoder] hypothetical throw — customer create continues without coords')
    }
    if (coords) {
      await query(
        `UPDATE business_customers SET lat = $1, lon = $2 WHERE id = $3`,
        [coords.lat, coords.lon, row.id])
    }

    const full = await queryOne<any>(
      `SELECT * FROM business_customers WHERE id = $1`, [row.id])
    res.status(201).json({ success: true, data: full })
  } catch (e) { next(e) }
})

// ═══════════════════════════════════════════════════════════════
//  S515 (D) — POST /import : bulk CSV customer import
// ═══════════════════════════════════════════════════════════════
//
// The frontend parses the CSV and posts a JSON array of rows. We validate
// each row independently and insert the valid ones, returning a per-row
// error report so the operator can fix and re-import the rejects. Geocode
// is skipped on bulk import (kept fast); lat/lon backfills later via
// POST /:id/geocode, same as any address edit.

const importRowSchema = z.object({
  customerType: z.enum(BUSINESS_CUSTOMER_TYPES).optional(),
  companyName:  z.string().optional(),
  firstName:    z.string().min(1),
  lastName:     z.string().min(1),
  email:        z.string().email().optional().or(z.literal('')),
  phone:        z.string().optional(),
  street1:      z.string().min(1),
  street2:      z.string().optional(),
  city:         z.string().min(1),
  state:        z.string().min(1),
  zip:          z.string().min(1),
  notes:        z.string().optional(),
})

const importSchema = z.object({
  customers: z.array(z.any()).min(1).max(1000),
})

businessCustomersRouter.post('/import', requireAuth, async (req, res, next) => {
  try {
    const businessId = await requireOwnerBusinessId(req)
    const { customers } = importSchema.parse(req.body)

    let created = 0
    const errors: Array<{ row: number; reason: string }> = []

    for (let i = 0; i < customers.length; i++) {
      const parsed = importRowSchema.safeParse(customers[i])
      if (!parsed.success) {
        const issue = parsed.error.issues[0]
        errors.push({ row: i + 1, reason: issue ? `${issue.path.join('.')}: ${issue.message}` : 'invalid row' })
        continue
      }
      const r = parsed.data
      const type = r.customerType ?? (r.companyName?.trim() ? 'business' : 'individual')
      if (type === 'business' && !r.companyName?.trim()) {
        errors.push({ row: i + 1, reason: 'companyName required for a business customer' })
        continue
      }
      const email = r.email && r.email.trim() ? r.email.trim() : null
      try {
        await query(
          `INSERT INTO business_customers
             (business_id, customer_type, company_name,
              first_name, last_name, email, phone,
              street1, street2, city, state, zip, notes)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
          [businessId, type,
           type === 'business' ? r.companyName?.trim() : null,
           r.firstName, r.lastName, email, r.phone ?? null,
           r.street1, r.street2 ?? null, r.city, r.state, r.zip,
           r.notes ?? null])
        created++
      } catch (e) {
        logger.error({ err: e, row: i + 1 }, '[customer-import] row insert failed')
        errors.push({ row: i + 1, reason: 'database insert failed' })
      }
    }

    res.status(201).json({ success: true, data: {
      created, skipped: errors.length, total: customers.length, errors,
    } })
  } catch (e) { next(e) }
})

// ═══════════════════════════════════════════════════════════════
//  POST /:id/geocode  — backfill coords for an existing customer
// ═══════════════════════════════════════════════════════════════

businessCustomersRouter.post('/:id/geocode', requireAuth, async (req, res, next) => {
  try {
    const businessId = await requireOwnerBusinessId(req)
    const customer = await queryOne<{
      id: string; street1: string; street2: string | null
      city: string; state: string; zip: string
    }>(
      `SELECT id, street1, street2, city, state, zip
         FROM business_customers
        WHERE id = $1 AND business_id = $2 AND status = 'active'`,
      [req.params.id, businessId])
    if (!customer) throw new AppError(404, 'Customer not found')

    const coords = await geocode({
      street1: customer.street1, street2: customer.street2,
      city: customer.city, state: customer.state, zip: customer.zip,
    })
    if (!coords) {
      // The geocoder returned no result — surface a clear 422 so the
      // dispatcher knows to manually enter coords (PATCH /:id with
      // explicit lat/lon — note: PATCH currently doesn't accept those
      // fields; left as a future hygiene item alongside the in-app
      // manual-coord-entry path).
      logger.warn({ ctx: customer.id }, '[geocoder] backfill returned null')
      throw new AppError(422, 'Address could not be geocoded — please verify and try again, or enter coordinates manually')
    }
    await query(
      `UPDATE business_customers SET lat = $1, lon = $2 WHERE id = $3`,
      [coords.lat, coords.lon, customer.id])
    const full = await queryOne<any>(
      `SELECT * FROM business_customers WHERE id = $1`, [customer.id])
    res.json({ success: true, data: full })
  } catch (e) { next(e) }
})

// ═══════════════════════════════════════════════════════════════
//  GET /  — list with status filter + simple search
// ═══════════════════════════════════════════════════════════════

const listSchema = z.object({
  status: z.enum(BUSINESS_CUSTOMER_STATUSES).optional(),
  q:      z.string().min(1).optional(),
  limit:  z.coerce.number().int().positive().max(500).optional(),
})

businessCustomersRouter.get('/', requireAuth, async (req, res, next) => {
  try {
    const businessId = await requireOwnerBusinessId(req)
    const q = listSchema.parse(req.query)
    const params: any[] = [businessId]
    let whereSql = 'WHERE bc.business_id = $1'

    // Default to status='active' so the list isn't polluted with
    // archived rows; explicit ?status=archived for the archive view.
    const status = q.status ?? 'active'
    params.push(status)
    whereSql += ` AND bc.status = $${params.length}`

    if (q.q) {
      params.push(`%${q.q}%`)
      const i = params.length
      whereSql += ` AND (LOWER(bc.first_name) LIKE LOWER($${i})
                     OR LOWER(bc.last_name)   LIKE LOWER($${i})
                     OR LOWER(bc.company_name) LIKE LOWER($${i})
                     OR LOWER(bc.email)        LIKE LOWER($${i}))`
    }

    params.push(q.limit ?? 100)
    // S473: lastServicedAt rolls up from route_stops — the actual
    // execution event (driver tapped Complete). Appointments don't
    // get their status flipped on stop-complete today (separate
    // hygiene flag, S473 handoff), so route_stops is the source of
    // truth for "when did this customer last actually get served."
    const rows = await query<any>(
      `SELECT bc.id, bc.customer_type, bc.company_name,
              bc.first_name, bc.last_name, bc.email, bc.phone,
              bc.street1, bc.street2, bc.city, bc.state, bc.zip,
              bc.lat, bc.lon, bc.notes, bc.status, bc.unit_count,
              bc.tax_exempt, bc.tax_exempt_reason,
              bc.payment_method_brand, bc.payment_method_last4,
              bc.payment_method_exp_month, bc.payment_method_exp_year,
              (bc.default_payment_method_id IS NOT NULL) AS has_saved_card,
              bc.created_at, bc.updated_at,
              ls.last_serviced_at
         FROM business_customers bc
         LEFT JOIN LATERAL (
           SELECT rs.actual_departure AS last_serviced_at
             FROM route_stops rs
             JOIN appointments a ON a.id = rs.appointment_id
            WHERE a.customer_id = bc.id
              AND rs.status = 'completed'
              AND rs.actual_departure IS NOT NULL
            ORDER BY rs.actual_departure DESC
            LIMIT 1
         ) ls ON true
         ${whereSql}
        ORDER BY bc.created_at DESC
        LIMIT $${params.length}`, params)
    res.json({ success: true, data: rows })
  } catch (e) { next(e) }
})

// ═══════════════════════════════════════════════════════════════
//  GET /:id  — read one
// ═══════════════════════════════════════════════════════════════

businessCustomersRouter.get('/:id', requireAuth, async (req, res, next) => {
  try {
    const businessId = await requireOwnerBusinessId(req)
    const row = await queryOne<any>(
      `SELECT * FROM business_customers
        WHERE id = $1 AND business_id = $2`,
      [req.params.id, businessId])
    if (!row) throw new AppError(404, 'Customer not found')
    res.json({ success: true, data: row })
  } catch (e) { next(e) }
})

// ═══════════════════════════════════════════════════════════════
//  PATCH /:id  — update mutable fields
// ═══════════════════════════════════════════════════════════════

const patchSchema = z.object({
  customerType: z.enum(BUSINESS_CUSTOMER_TYPES).optional(),
  companyName:  z.string().nullable().optional(),
  firstName:    z.string().min(1).optional(),
  lastName:     z.string().min(1).optional(),
  email:        z.string().email().nullable().optional(),
  phone:        z.string().nullable().optional(),
  street1:      z.string().min(1).optional(),
  street2:      z.string().nullable().optional(),
  city:         z.string().min(1).optional(),
  state:        z.string().min(1).optional(),
  zip:          z.string().min(1).optional(),
  notes:        z.string().nullable().optional(),
  // Manual coordinate entry (S469 hygiene): used when the geocoder
  // can't resolve an address and the dispatcher pastes coords from
  // Google Maps. Bounds-checked. Both-or-neither enforced below.
  lat:          z.number().gte(-90).lte(90).nullable().optional(),
  lon:          z.number().gte(-180).lte(180).nullable().optional(),
  // S506: tax exemption.
  taxExempt:       z.boolean().optional(),
  taxExemptReason: z.string().max(500).nullable().optional(),
  // S510: standing quantity (e.g. # cans) — drives per-unit service time.
  unitCount:       z.number().int().min(0).optional(),
}).strict()

// S510: owner triggers a card-update email for a customer.
businessCustomersRouter.post('/:id/send-card-update-link', requireAuth, async (req, res, next) => {
  try {
    const businessId = await requireOwnerBusinessId(req)
    // Verify customer belongs to this business.
    const customer = await queryOne<{ id: string }>(
      `SELECT id FROM business_customers
        WHERE id = $1 AND business_id = $2`,
      [req.params.id, businessId])
    if (!customer) throw new AppError(404, 'Customer not found')
    const { sendCardUpdateEmail } = await import('../services/cardUpdateTokens')
    const sent = await sendCardUpdateEmail({
      businessId,
      customerId: customer.id,
      createdByUserId: req.user!.userId,
      reasonHint: 'manual',
    })
    if (!sent) {
      throw new AppError(400, 'Customer has no email on file — add one first.')
    }
    res.json({ success: true, data: { ok: true } })
  } catch (e) { next(e) }
})

// S502 — get (or create) the customer's self-service portal link. Reuses a
// live token so the customer's existing link keeps working. The owner copies
// the URL or has it emailed to the customer.
businessCustomersRouter.post('/:id/portal-link', requireAuth, async (req, res, next) => {
  try {
    const businessId = await requireOwnerBusinessId(req)
    const customer = await queryOne<{ id: string; email: string | null }>(
      `SELECT id, email FROM business_customers WHERE id = $1 AND business_id = $2`,
      [req.params.id, businessId])
    if (!customer) throw new AppError(404, 'Customer not found')

    const { getOrCreateCustomerPortalToken } = await import('../services/customerPortalTokens')
    const link = await getOrCreateCustomerPortalToken({
      businessId, customerId: customer.id, createdByUserId: req.user!.userId,
    })

    // Optionally email the link to the customer (when they have an email).
    let emailed = false
    if (req.body?.sendEmail === true && customer.email) {
      const [{ emailBusinessCustomerPortalLink }, biz] = await Promise.all([
        import('../services/email'),
        queryOne<{ name: string }>(`SELECT name FROM businesses WHERE id = $1`, [businessId]),
      ])
      await emailBusinessCustomerPortalLink({
        to: customer.email,
        businessName: biz?.name ?? 'your service provider',
        portalUrl: link.url,
        ctx: { businessId, customerId: customer.id },
      })
      emailed = true
    }

    res.json({ success: true, data: { url: link.url, expiresAt: link.expiresAt, emailed } })
  } catch (e) { next(e) }
})

// Revoke a customer's portal access — the off-switch for a leaked or stale
// self-service link. Kills every live token; the next portal-link issue mints
// a fresh one. Owner-only, scoped to the owner's business.
businessCustomersRouter.post('/:id/revoke-portal-access', requireAuth, async (req, res, next) => {
  try {
    const businessId = await requireOwnerBusinessId(req)
    const customer = await queryOne<{ id: string }>(
      `SELECT id FROM business_customers WHERE id = $1 AND business_id = $2`,
      [req.params.id, businessId])
    if (!customer) throw new AppError(404, 'Customer not found')

    const { revokeCustomerPortalTokens } = await import('../services/customerPortalTokens')
    const { revoked } = await revokeCustomerPortalTokens({ businessId, customerId: customer.id })

    res.json({ success: true, data: { revoked } })
  } catch (e) { next(e) }
})

businessCustomersRouter.patch('/:id', requireAuth, async (req, res, next) => {
  try {
    const businessId = await requireOwnerBusinessId(req)
    const patch = patchSchema.parse(req.body)
    if (Object.keys(patch).length === 0) {
      throw new AppError(400, 'Nothing to update')
    }

    // S469: lat/lon must move together. Partial updates would either
    // leave the row in an inconsistent state (one new + one stale) or
    // half-clear (one null + one number) which fails the schema's NOT
    // NULL pair invariant. Accept both, or neither.
    const latProvided = patch.lat !== undefined
    const lonProvided = patch.lon !== undefined
    if (latProvided !== lonProvided) {
      throw new AppError(400, 'lat and lon must be supplied together')
    }
    // Both-null is a valid "clear coordinates" gesture.
    // Both-number is a valid "set coordinates" gesture.
    // (zod schema already enforces each individually.)

    // Cross-tier guard: changing customerType TO 'business' without
    // supplying companyName would fail the CHECK at the DB layer.
    // Pre-flight at the app layer for a clean 400.
    if (patch.customerType === 'business' && patch.companyName === null) {
      throw new AppError(400, 'companyName cannot be null when customerType is "business"')
    }
    if (patch.customerType === 'business' && patch.companyName === undefined) {
      // The PATCH could be just `{ customerType: 'business' }` on a row
      // that's currently 'individual' with company_name=NULL. Reading
      // current row tells us whether the change is safe.
      const current = await queryOne<{ company_name: string | null }>(
        `SELECT company_name FROM business_customers
          WHERE id = $1 AND business_id = $2`,
        [req.params.id, businessId])
      if (!current) throw new AppError(404, 'Customer not found')
      if (!current.company_name) {
        throw new AppError(400, 'companyName must be set when changing customerType to "business"')
      }
    }

    const r = await query<{ id: string }>(
      `UPDATE business_customers
          SET customer_type = COALESCE($1,  customer_type),
              company_name  = COALESCE($2,  company_name),
              first_name    = COALESCE($3,  first_name),
              last_name     = COALESCE($4,  last_name),
              email         = COALESCE($5,  email),
              phone         = COALESCE($6,  phone),
              street1       = COALESCE($7,  street1),
              street2       = COALESCE($8,  street2),
              city          = COALESCE($9,  city),
              state         = COALESCE($10, state),
              zip           = COALESCE($11, zip),
              notes         = COALESCE($12, notes),
              tax_exempt        = COALESCE($15, tax_exempt),
              tax_exempt_reason = COALESCE($16, tax_exempt_reason),
              unit_count        = COALESCE($17, unit_count)
        WHERE id = $13 AND business_id = $14
       RETURNING id`,
      [
        patch.customerType ?? null,
        patch.companyName  ?? null,
        patch.firstName    ?? null,
        patch.lastName     ?? null,
        patch.email        ?? null,
        patch.phone        ?? null,
        patch.street1      ?? null,
        patch.street2      ?? null,
        patch.city         ?? null,
        patch.state        ?? null,
        patch.zip          ?? null,
        patch.notes        ?? null,
        req.params.id, businessId,
        patch.taxExempt    ?? null,
        patch.taxExemptReason === undefined ? null : patch.taxExemptReason,
        patch.unitCount    ?? null,
      ])
    if (r.length === 0) throw new AppError(404, 'Customer not found')

    // S469: lat/lon follow-up. COALESCE can't distinguish "clear" (null
    // intentionally) from "preserve" (omit) — so we run a separate
    // UPDATE only when both were supplied. Both-or-neither already
    // enforced above; reaching here with one set is impossible.
    if (latProvided && lonProvided) {
      await query(
        `UPDATE business_customers
            SET lat = $1, lon = $2
          WHERE id = $3 AND business_id = $4`,
        [patch.lat ?? null, patch.lon ?? null, r[0].id, businessId])
    }
    const full = await queryOne<any>(
      `SELECT * FROM business_customers WHERE id = $1`, [r[0].id])
    res.json({ success: true, data: full })
  } catch (e) { next(e) }
})

// ═══════════════════════════════════════════════════════════════
//  POST /:id/archive
// ═══════════════════════════════════════════════════════════════

businessCustomersRouter.post('/:id/archive', requireAuth, async (req, res, next) => {
  try {
    const businessId = await requireOwnerBusinessId(req)
    const r = await query<{ id: string; status: string }>(
      `UPDATE business_customers
          SET status = 'archived', archived_at = NOW()
        WHERE id = $1 AND business_id = $2 AND status <> 'archived'
        RETURNING id, status`,
      [req.params.id, businessId])
    if (r.length === 0) {
      // Either not in this business OR already archived. Hidden behind
      // a generic 404 (same posture as /revoke on business_users).
      throw new AppError(404, 'Customer not found')
    }
    res.json({ success: true, data: r[0] })
  } catch (e) { next(e) }
})
