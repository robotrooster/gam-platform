import { Router } from 'express'
import { z } from 'zod'
import { query, queryOne } from '../db'
import { requireAuth } from '../middleware/auth'
import { AppError } from '../middleware/errorHandler'
import { canManageLandlordResource } from '../middleware/scope'

// ============================================================
// S517 / Walkthrough #11 — landlord-facing booking-site config + waitlist
// view. The public site itself is in routes/publicPropertyBooking.ts.
// ============================================================

export const propertyBookingAdminRouter = Router()
// requireAuth is applied PER ROUTE below, not router-wide: this router is
// mounted at the broad `/api` path, and a router-level `.use(requireAuth)`
// would 401 every tokenless request that merely falls through it — including
// the public, unauthenticated /api/sales and /api/guest agent endpoints
// mounted after it. Per-route auth lets non-matching paths pass through.

async function getOwnedProperty(propertyId: string, user: any) {
  const prop = await queryOne<any>('SELECT * FROM properties WHERE id=$1', [propertyId])
  if (!prop) throw new AppError(404, 'Property not found')
  if (!canManageLandlordResource(user, prop.landlord_id, ['property_manager'])) {
    throw new AppError(403, 'Forbidden')
  }
  return prop
}

// ── GET /api/properties/:id/booking-config ──
propertyBookingAdminRouter.get('/properties/:id/booking-config', requireAuth, async (req, res, next) => {
  try {
    const prop = await getOwnedProperty(req.params.id, req.user)
    res.json({
      success: true,
      data: {
        enabled: prop.public_booking_enabled,
        slug: prop.booking_slug,
        intro: prop.booking_intro,
        depositPct: Number(prop.booking_deposit_pct),
        nightlyRate: prop.nightly_rate != null ? Number(prop.nightly_rate) : null,
        weeklyRate:  prop.weekly_rate  != null ? Number(prop.weekly_rate)  : null,
        monthlyRate: prop.monthly_rate != null ? Number(prop.monthly_rate) : null,
        shortTermTaxRate: Number(prop.short_term_tax_rate),
      },
    })
  } catch (e) { next(e) }
})

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,60}$/

// ── PATCH /api/properties/:id/booking-config ──
propertyBookingAdminRouter.patch('/properties/:id/booking-config', requireAuth, async (req, res, next) => {
  try {
    const body = z.object({
      enabled:    z.boolean().optional(),
      slug:       z.string().nullable().optional(),
      intro:      z.string().nullable().optional(),
      depositPct: z.number().min(0).max(100).optional(),
      nightlyRate: z.number().min(0).nullable().optional(),
      weeklyRate:  z.number().min(0).nullable().optional(),
      monthlyRate: z.number().min(0).nullable().optional(),
      shortTermTaxRate: z.number().min(0).max(100).optional(),
    }).parse(req.body)

    const prop = await getOwnedProperty(req.params.id, req.user)

    // Validate + uniqueness-check the slug before the write so the guest URL
    // is well-formed and globally unique.
    let slug = prop.booking_slug as string | null
    if (body.slug !== undefined) {
      slug = body.slug
      if (slug != null) {
        if (!SLUG_RE.test(slug) || slug.includes('--')) {
          throw new AppError(400, 'Slug must be lowercase letters/numbers/hyphens (2–61 chars), no leading or doubled hyphens')
        }
        const taken = await queryOne<{ id: string }>(
          'SELECT id FROM properties WHERE booking_slug=$1 AND id<>$2', [slug, prop.id])
        if (taken) throw new AppError(409, 'That booking address is already taken')
      }
    }

    const enabled = body.enabled !== undefined ? body.enabled : prop.public_booking_enabled
    if (enabled && !slug) throw new AppError(400, 'Set a booking address (slug) before enabling the site')

    // Rates: a key present in the body sets it (null clears); absent = keep.
    const setNum = (v: number | null | undefined) => v === undefined ? undefined : v
    const updated = await queryOne<any>(
      `UPDATE properties
          SET public_booking_enabled=$1,
              booking_slug=$2,
              booking_intro=COALESCE($3, booking_intro),
              booking_deposit_pct=COALESCE($4, booking_deposit_pct),
              nightly_rate = CASE WHEN $6::boolean THEN $7 ELSE nightly_rate END,
              weekly_rate  = CASE WHEN $8::boolean THEN $9 ELSE weekly_rate END,
              monthly_rate = CASE WHEN $10::boolean THEN $11 ELSE monthly_rate END,
              short_term_tax_rate = COALESCE($12, short_term_tax_rate),
              updated_at=now()
        WHERE id=$5 RETURNING *`,
      [enabled, slug,
       body.intro === undefined ? null : body.intro,
       body.depositPct === undefined ? null : body.depositPct,
       prop.id,
       body.nightlyRate !== undefined, setNum(body.nightlyRate) ?? null,
       body.weeklyRate  !== undefined, setNum(body.weeklyRate)  ?? null,
       body.monthlyRate !== undefined, setNum(body.monthlyRate) ?? null,
       body.shortTermTaxRate === undefined ? null : body.shortTermTaxRate])

    res.json({
      success: true,
      data: {
        enabled: updated.public_booking_enabled,
        slug: updated.booking_slug,
        intro: updated.booking_intro,
        depositPct: Number(updated.booking_deposit_pct),
        nightlyRate: updated.nightly_rate != null ? Number(updated.nightly_rate) : null,
        weeklyRate:  updated.weekly_rate  != null ? Number(updated.weekly_rate)  : null,
        monthlyRate: updated.monthly_rate != null ? Number(updated.monthly_rate) : null,
        shortTermTaxRate: Number(updated.short_term_tax_rate),
      },
    })
  } catch (e) { next(e) }
})

// ── POST /api/properties/:id/waitlist — staff adds a guest to a property-wide
// waitlist (any unit). Used when every unit is full for the requested dates. ──
propertyBookingAdminRouter.post('/properties/:id/waitlist', requireAuth, async (req, res, next) => {
  try {
    const body = z.object({
      guestName:  z.string().min(1),
      // Required — it's how the promoted guest gets their 1-hour claim link.
      guestEmail: z.string().email(),
      guestPhone: z.string().nullish(),
      checkIn:    z.string(),
      checkOut:   z.string(),
    }).parse(req.body)
    const prop = await getOwnedProperty(req.params.id, req.user)
    const row = await queryOne<{ id: string }>(
      `INSERT INTO unit_booking_waitlists
         (unit_id, property_id, landlord_id, guest_name, guest_email, guest_phone, check_in, check_out)
       VALUES (NULL, $1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [prop.id, prop.landlord_id, body.guestName, body.guestEmail, body.guestPhone ?? null, body.checkIn, body.checkOut])
    res.status(201).json({ success: true, data: { waitlistId: row!.id } })
  } catch (e) { next(e) }
})

// ── GET /api/units/:id/waitlist — the queue for a unit ──
propertyBookingAdminRouter.get('/units/:id/waitlist', requireAuth, async (req, res, next) => {
  try {
    const unit = await queryOne<{ landlord_id: string }>('SELECT landlord_id FROM units WHERE id=$1', [req.params.id])
    if (!unit) throw new AppError(404, 'Unit not found')
    if (!canManageLandlordResource(req.user, unit.landlord_id, ['property_manager'])) {
      throw new AppError(403, 'Forbidden')
    }
    const rows = await query<any>(
      `SELECT id, guest_name, guest_email, guest_phone, check_in, check_out, status,
              notified_at, claim_expires_at, created_at
         FROM unit_booking_waitlists
        WHERE unit_id=$1 AND status IN ('waiting','notified')
        ORDER BY created_at ASC`, [req.params.id])
    res.json({ success: true, data: rows })
  } catch (e) { next(e) }
})
