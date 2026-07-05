import { Router } from 'express'
import { z } from 'zod'
import { DateTime } from 'luxon'
import { query, queryOne } from '../db'
import { AppError } from '../middleware/errorHandler'
import {
  computeStayTotal, bookStay, joinWaitlist, getWaitlistClaim, claimWaitlistSpot, UnitFullError,
} from '../services/propertyBooking'
import { computeStayPrice } from '@gam/shared'
import { rankUnitsBestFit } from '../services/scheduleCompression'

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
    `SELECT u.id, u.unit_number, u.nightly_rate, u.weekly_rate, u.monthly_rate,
            u.min_stay_nights, u.max_stay_nights, u.check_in_time, u.check_out_time,
            u.lease_types_allowed, u.subtype_id,
            s.name AS subtype_name, s.rv_site_layout AS subtype_layout,
            s.rv_amp_service AS subtype_amp,
            s.nightly_rate AS subtype_nightly, s.weekly_rate AS subtype_weekly,
            s.monthly_rate AS subtype_monthly
       FROM units u
       LEFT JOIN property_unit_subtypes s ON s.id = u.subtype_id
      WHERE u.property_id = $1
        AND u.is_bookable = TRUE
        AND (u.lease_types_allowed && ARRAY['nightly','weekly']::text[])
      ORDER BY u.unit_number`,
    [propertyId])
}

// W-20 (S531, Nic): guests book a SITE TYPE, not a specific unit — the
// system assigns the actual site internally and reveals it the morning of
// check-in (so the schedule can self-compress). Types = the property's
// unit subtypes; units without a subtype pool into a "general" type with
// no site requirements.
interface SiteType {
  id: string            // subtype uuid, or 'general'
  name: string
  requiredLayout: string | null
  requiredAmp: string | null
  units: any[]          // candidate units, unit_number order
}
function groupSiteTypes(units: any[]): SiteType[] {
  const byType = new Map<string, SiteType>()
  for (const u of units) {
    const key = u.subtype_id ?? 'general'
    let t = byType.get(key)
    if (!t) {
      t = {
        id: key,
        name: u.subtype_id ? u.subtype_name : 'RV Site',
        requiredLayout: u.subtype_id ? (u.subtype_layout ?? null) : null,
        requiredAmp: u.subtype_id ? (u.subtype_amp ?? null) : null,
        units: [],
      }
      byType.set(key, t)
    }
    t.units.push(u)
  }
  return [...byType.values()]
}
function resolveSiteType(units: any[], siteTypeId: string): SiteType {
  const t = groupSiteTypes(units).find(x => x.id === siteTypeId)
  if (!t) throw new AppError(404, 'Site type not found')
  return t
}
/** Representative rates for a type: subtype rates, else the first unit's. */
function typeRates(t: SiteType) {
  const u = t.units[0]
  return {
    nightly: (u.subtype_nightly ?? u.nightly_rate) != null ? Number(u.subtype_nightly ?? u.nightly_rate) : null,
    weekly:  (u.subtype_weekly ?? u.weekly_rate) != null ? Number(u.subtype_weekly ?? u.weekly_rate) : null,
  }
}

// ── GET /api/public/property/:slug — site profile + bookable units ──
publicPropertyBookingRouter.get('/property/:slug', async (req, res, next) => {
  try {
    const prop = await resolveProperty(req.params.slug)
    const units = await bookableUnits(prop.id)
    // W-20: expose site TYPES only — never the unit inventory. The guest
    // learns their actual site the morning of check-in.
    const siteTypes = groupSiteTypes(units).map(t => {
      const rates = typeRates(t)
      return {
        id: t.id,
        name: t.name,
        siteCount: t.units.length,
        nightlyRate: rates.nightly,
        weeklyRate: rates.weekly,
        minStayNights: t.units[0].min_stay_nights,
        maxStayNights: t.units[0].max_stay_nights,
        checkInTime: t.units[0].check_in_time,
        checkOutTime: t.units[0].check_out_time,
      }
    })
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
        siteTypes,
      },
    })
  } catch (e) { next(e) }
})

// ── GET /api/public/property/:slug/availability ──
// ?unitId=&checkIn=&checkOut=&stayType=  → availability + indicative price.
publicPropertyBookingRouter.get('/property/:slug/availability', async (req, res, next) => {
  try {
    const q = z.object({
      siteTypeId: z.string(),
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

    // W-20: availability = ANY unit of the requested site type free for the
    // window (guests never see per-unit inventory).
    const siteType = resolveSiteType(await bookableUnits(prop.id), q.siteTypeId)
    let freeUnit: any = null
    for (const u of siteType.units) {
      const conflict = await queryOne<{ id: string }>(
        `SELECT id FROM unit_bookings
          WHERE unit_id = $1
            AND status <> 'cancelled'
            AND NOT (status = 'tentative' AND hold_expires_at IS NOT NULL AND hold_expires_at < now())
            AND check_in < $2::date AND check_out > $3::date
          LIMIT 1`,
        [u.id, q.checkOut, q.checkIn])
      if (!conflict) { freeUnit = u; break }
    }

    // Auto-tiered pricing (guest does not pick a billing type — Nic 2026-06-27):
    // length decides nightly/weekly/monthly, prorated, with short-term lodging
    // tax on stays under 30 nights. Rates: subtype, else unit, else property.
    const rep = freeUnit ?? siteType.units[0]
    const price = computeStayPrice(
      { nightly: rep.subtype_nightly ?? rep.nightly_rate ?? prop.nightly_rate,
        weekly:  rep.subtype_weekly  ?? rep.weekly_rate  ?? prop.weekly_rate,
        monthly: rep.subtype_monthly ?? rep.monthly_rate ?? prop.monthly_rate },
      Number(prop.short_term_tax_rate || 0), nights)
    const total = price.total > 0 ? price.total : null
    const depositPct = Number(prop.booking_deposit_pct)
    const depositAmount = total != null ? Math.round(total * (depositPct / 100) * 100) / 100 : null

    const minStay = rep.min_stay_nights
    const maxStay = rep.max_stay_nights
    const stayTooShort = minStay != null && nights < minStay
    const stayTooLong  = maxStay != null && nights > maxStay

    const available = !!freeUnit && !stayTooShort && !stayTooLong && total != null

    res.json({
      success: true,
      data: {
        available,
        unavailableReason: !freeUnit ? 'booked'
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
  siteTypeId: z.string(),
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
    // W-20 (Nic): the system picks the site BEST-FIT — the stay slots into
    // the snuggest compatible gap between existing reservations, so
    // wide-open sites stay free for longer stays (same objective as the
    // nightly packer). The per-unit advisory lock inside bookStay stays the
    // race guard; UnitFullError just advances to the next candidate.
    const prop = await resolveProperty(req.params.slug)
    const siteType = resolveSiteType(await bookableUnits(prop.id), b.siteTypeId)
    const ranked = await rankUnitsBestFit(
      siteType.units.map((u: any) => u.id),
      { checkIn: b.checkIn, checkOut: b.checkOut })
    let lastFull: UnitFullError | null = null
    for (const unitId of ranked) {
      try {
        const r = await bookStay({
          slug: req.params.slug, ...b, unitId,
          requiredSiteLayout: siteType.requiredLayout ?? 'none',
          requiredAmpService: siteType.requiredAmp ?? 'none',
        })
        return res.json({ success: true, data: r })
      } catch (e) {
        if (e instanceof UnitFullError) { lastFull = e; continue }
        throw e
      }
    }
    return res.status(409).json({ success: false, full: true, error: lastFull?.message || 'Those dates are full' })
  } catch (e) {
    next(e)
  }
})

// ── POST /property/:slug/waitlist — join when dates are full ──
publicPropertyBookingRouter.post('/property/:slug/waitlist', async (req, res, next) => {
  try {
    const b = guestBody.parse(req.body)
    // Waitlist rows are per-unit under the hood — anchor on the type's
    // first candidate. The nightly compressor keeps the pool packed, so
    // "that unit frees up" ≈ "the type frees up".
    const prop = await resolveProperty(req.params.slug)
    const siteType = resolveSiteType(await bookableUnits(prop.id), b.siteTypeId)
    const r = await joinWaitlist({ slug: req.params.slug, ...b, unitId: siteType.units[0].id })
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
        // W-20: no site number pre-check-in — the claim is for a site TYPE;
        // the actual site arrives the morning of check-in.
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
