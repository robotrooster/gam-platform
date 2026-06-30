import { Router } from 'express'
import { z } from 'zod'
import { DateTime } from 'luxon'
import { query, queryOne } from '../db'
import { AppError } from '../middleware/errorHandler'
import {
  computeStayTotal, bookStay, joinWaitlist, getWaitlistClaim, claimWaitlistSpot, UnitFullError,
} from '../services/propertyBooking'
import { computeStayPrice } from '@gam/shared'

// Re-exported for tests that import the legacy pure pricing helper from the
// route. (Pricing now auto-tiers via the shared computeStayPrice — see below.)
export { computeStayTotal }

// ============================================================
// S517 / Walkthrough #11 — public per-property booking site (read APIs).
//
// Unauthenticated, slug-keyed — mirrors the S507 business booking model
// (routes/publicBooking.ts) but for property units + dated short-term stays.
// The slug arrives via subdomain (prod) or path (dev); the API only cares
// about the slug. Stage 2: profile + availability (read-only). Booking +
// deposit + waitlist land in later stages.
// ============================================================

export const publicPropertyBookingRouter = Router()

interface PropertyRow {
  id: string
  landlord_id: string
  name: string
  city: string | null
  state: string | null
  booking_intro: string | null
  booking_deposit_pct: string
  nightly_rate: string | null
  weekly_rate: string | null
  monthly_rate: string | null
  short_term_tax_rate: string | null
}

/** Resolve a property by its public booking slug, 404 unless enabled. */
async function resolveProperty(slug: string): Promise<PropertyRow> {
  const prop = await queryOne<PropertyRow>(
    `SELECT id, landlord_id, name, city, state, booking_intro, booking_deposit_pct,
            nightly_rate, weekly_rate, monthly_rate, short_term_tax_rate
       FROM properties
      WHERE booking_slug = $1 AND public_booking_enabled = TRUE`,
    [slug])
  if (!prop) throw new AppError(404, 'Booking site not found')
  return prop
}

/** Units that the public can book: bookable + allow a short-term stay type. */
async function bookableUnits(propertyId: string) {
  return query<any>(
    `SELECT id, unit_number, nightly_rate, weekly_rate, monthly_rate,
            min_stay_nights, max_stay_nights, check_in_time, check_out_time,
            lease_types_allowed
       FROM units
      WHERE property_id = $1
        AND is_bookable = TRUE
        AND (lease_types_allowed && ARRAY['nightly','weekly']::text[])
      ORDER BY unit_number`,
    [propertyId])
}

// ── GET /api/public/property/:slug — site profile + bookable units ──
publicPropertyBookingRouter.get('/property/:slug', async (req, res, next) => {
  try {
    const prop = await resolveProperty(req.params.slug)
    const units = await bookableUnits(prop.id)
    res.json({
      success: true,
      data: {
        property: {
          name: prop.name,
          city: prop.city,
          state: prop.state,
          intro: prop.booking_intro,
          depositPct: Number(prop.booking_deposit_pct),
        },
        units: units.map(u => ({
          id: u.id,
          unitNumber: u.unit_number,
          nightlyRate: u.nightly_rate != null ? Number(u.nightly_rate) : null,
          weeklyRate: u.weekly_rate != null ? Number(u.weekly_rate) : null,
          minStayNights: u.min_stay_nights,
          maxStayNights: u.max_stay_nights,
          checkInTime: u.check_in_time,
          checkOutTime: u.check_out_time,
          stayTypes: (u.lease_types_allowed || []).filter((t: string) => t === 'nightly' || t === 'weekly'),
        })),
      },
    })
  } catch (e) { next(e) }
})

// ── GET /api/public/property/:slug/availability ──
// ?unitId=&checkIn=&checkOut=&stayType=  → availability + indicative price.
publicPropertyBookingRouter.get('/property/:slug/availability', async (req, res, next) => {
  try {
    const q = z.object({
      unitId:   z.string().uuid(),
      checkIn:  z.string(),
      checkOut: z.string(),
      stayType: z.enum(['nightly', 'weekly']).default('nightly'),
    }).parse(req.query)

    const prop = await resolveProperty(req.params.slug)

    const ci = DateTime.fromISO(q.checkIn)
    const co = DateTime.fromISO(q.checkOut)
    if (!ci.isValid || !co.isValid) throw new AppError(400, 'Invalid dates')
    const nights = Math.round(co.startOf('day').diff(ci.startOf('day'), 'days').days)
    if (nights <= 0) throw new AppError(400, 'Check-out must be after check-in')
    if (ci < DateTime.now().startOf('day')) throw new AppError(400, 'Check-in is in the past')

    const unit = await queryOne<any>(
      `SELECT id, nightly_rate, weekly_rate, monthly_rate, min_stay_nights, max_stay_nights, is_bookable
         FROM units WHERE id = $1 AND property_id = $2`,
      [q.unitId, prop.id])
    if (!unit || !unit.is_bookable) throw new AppError(404, 'Unit not bookable')

    // Date-range overlap vs live bookings — ignore cancelled and abandoned
    // unpaid holds (tentative past hold_expires_at).
    const conflict = await queryOne<{ id: string }>(
      `SELECT id FROM unit_bookings
        WHERE unit_id = $1
          AND status <> 'cancelled'
          AND NOT (status = 'tentative' AND hold_expires_at IS NOT NULL AND hold_expires_at < now())
          AND check_in < $2::date AND check_out > $3::date
        LIMIT 1`,
      [q.unitId, q.checkOut, q.checkIn])

    // Auto-tiered pricing (guest does not pick a billing type — Nic 2026-06-27):
    // length decides nightly/weekly/monthly, prorated, with short-term lodging
    // tax (property-level rate the landlord sets for their city/state) on stays
    // under 30 nights. Rates pull from the UNIT, property rate as the default.
    const price = computeStayPrice(
      { nightly: unit.nightly_rate ?? prop.nightly_rate,
        weekly:  unit.weekly_rate  ?? prop.weekly_rate,
        monthly: unit.monthly_rate ?? prop.monthly_rate },
      Number(prop.short_term_tax_rate || 0), nights)
    const total = price.total > 0 ? price.total : null
    const depositPct = Number(prop.booking_deposit_pct)
    const depositAmount = total != null ? Math.round(total * (depositPct / 100) * 100) / 100 : null

    const minStay = unit.min_stay_nights
    const maxStay = unit.max_stay_nights
    const stayTooShort = minStay != null && nights < minStay
    const stayTooLong  = maxStay != null && nights > maxStay

    const available = !conflict && !stayTooShort && !stayTooLong && total != null

    res.json({
      success: true,
      data: {
        available,
        unavailableReason: conflict ? 'booked'
          : stayTooShort ? `Minimum stay is ${minStay} nights`
          : stayTooLong ? `Maximum stay is ${maxStay} nights`
          : total == null ? 'rate_unavailable'
          : null,
        nights, tier: price.tier, base: price.base, tax: price.tax, taxable: price.taxable,
        total, depositPct, depositAmount,
      },
    })
  } catch (e) { next(e) }
})

// Guest-supplied booking details (the guest is not a GAM user).
const guestBody = z.object({
  unitId:    z.string().uuid(),
  guestName: z.string().min(1),
  guestEmail: z.string().email(),
  guestPhone: z.string().optional(),
  checkIn:   z.string(),
  checkOut:  z.string(),
  stayType:  z.enum(['nightly', 'weekly']).default('nightly'),
})

// ── POST /property/:slug/book — tentative hold + Stripe deposit checkout ──
publicPropertyBookingRouter.post('/property/:slug/book', async (req, res, next) => {
  try {
    const b = guestBody.parse(req.body)
    const r = await bookStay({ slug: req.params.slug, ...b })
    res.json({ success: true, data: r })
  } catch (e) {
    if (e instanceof UnitFullError) {
      return res.status(409).json({ success: false, full: true, error: e.message })
    }
    next(e)
  }
})

// ── POST /property/:slug/waitlist — join when dates are full ──
publicPropertyBookingRouter.post('/property/:slug/waitlist', async (req, res, next) => {
  try {
    const b = guestBody.parse(req.body)
    const r = await joinWaitlist({ slug: req.params.slug, ...b })
    res.json({ success: true, data: r })
  } catch (e) { next(e) }
})

// ── GET /property/:slug/claim/:token — claim-link landing info ──
publicPropertyBookingRouter.get('/property/:slug/claim/:token', async (req, res, next) => {
  try {
    const w = await getWaitlistClaim(req.params.token)
    if (!w || w.booking_slug !== req.params.slug) throw new AppError(404, 'Claim link not found')
    const expired = w.status !== 'notified' || !w.claim_expires_at || new Date(w.claim_expires_at) < new Date()
    res.json({
      success: true,
      data: {
        propertyName: w.property_name,
        unitNumber: w.unit_number,
        checkIn: w.check_in, checkOut: w.check_out,
        guestName: w.guest_name,
        claimExpiresAt: w.claim_expires_at,
        expired,
      },
    })
  } catch (e) { next(e) }
})

// ── POST /property/:slug/claim/:token — claim → booking + deposit ──
publicPropertyBookingRouter.post('/property/:slug/claim/:token', async (req, res, next) => {
  try {
    const { stayType } = z.object({ stayType: z.enum(['nightly', 'weekly']).default('nightly') }).parse(req.body)
    const r = await claimWaitlistSpot(req.params.token, stayType)
    res.json({ success: true, data: r })
  } catch (e) {
    if (e instanceof UnitFullError) {
      return res.status(409).json({ success: false, full: true, error: 'Those dates were just taken' })
    }
    next(e)
  }
})
