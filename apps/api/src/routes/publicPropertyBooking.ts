import { Router } from 'express'
import rateLimit from 'express-rate-limit'
import { z } from 'zod'
import path from 'path'
import { DateTime } from 'luxon'
import { query, queryOne, getClient } from '../db'
import { resolveUploadPath } from '../lib/uploadPaths'
import { AppError } from '../middleware/errorHandler'
import {
  computeStayTotal, bookStay, joinWaitlist, getWaitlistClaim, claimWaitlistSpot, UnitFullError,
} from '../services/propertyBooking'
import {
  type PropertyRow, type SiteType,
  resolveProperty, bookableUnits, groupSiteTypes, resolveSiteType, typeRates, typeAvailability,
} from '../services/propertyBookingQuote'
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

// Tighter than the global /api limiter (3000/15min): these public, unauthed
// endpoints send email on every call (landlord inquiry notification / guest
// stay-link) or mint a Stripe checkout session + DB rows (/book), so they're an
// abuse + Resend-sender-reputation vector. A real guest sends 1–2; 8/15min/IP is
// generous for a human, brutal for a bot. Keyed by IP (default), so it caps an
// attacker across every property slug at once. Read endpoints (availability
// polling) stay on the global limiter — only these writes are throttled.
const publicWriteLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 8,
  message: { success: false, error: 'Too many requests. Please try again in a few minutes.' },
  // No-op under the test runner (same idiom as lib/logger.ts) so a suite firing
  // many writes from one IP never 429-flakes; always active in dev/prod.
  skip: () => process.env.NODE_ENV === 'test' || !!process.env.VITEST_POOL_ID,
})


// ── GET /api/public/property/:slug — site profile + bookable units ──
publicPropertyBookingRouter.get('/property/:slug', async (req, res, next) => {
  try {
    const prop = await resolveProperty(req.params.slug)
    const units = await bookableUnits(prop.id)
    // S544: amenities for the storefront — the property's active common
    // areas (names/descriptions/hours only; reservations stay
    // resident-only in the tenant portal).
    // S547: reservable areas expose enough for the guest reserve flow
    // (fees, event posture, window rules) — still no unit inventory.
    const amenities = await query<any>(
      `SELECT id, name, description, capacity, open_time, close_time,
              reservable, requires_approval, reservation_fee, weekend_fee,
              events_enabled, event_deposit_amount,
              max_reservation_hours, advance_booking_days
         FROM common_areas
        WHERE property_id = $1 AND active = TRUE
        ORDER BY name`,
      [prop.id])
    // S547: full property-website content — gallery photos + FAQs. Public by
    // virtue of the site being published (resolveProperty gates on
    // public_booking_enabled).
    const photos = (await query<any>(
      `SELECT id, caption FROM property_site_photos
        WHERE property_id = $1 ORDER BY sort_order ASC, created_at ASC`,
      [prop.id])).map((p: any) => ({
        id: p.id, caption: p.caption,
        url: `/api/public/property/${req.params.slug}/photo/${p.id}`,
      }))
    const faqs = await query<any>(
      `SELECT id, question, answer FROM property_faqs
        WHERE property_id = $1 ORDER BY sort_order ASC, created_at ASC`,
      [prop.id])
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
          // S602 personalization sections (rendered on the storefront home page)
          about: prop.booking_about,
          area: prop.booking_area,
          depositPct: Number(prop.booking_deposit_pct),
          // S547 contact page
          street1: prop.street1,
          zip: prop.zip,
          officePhone: prop.office_phone,
          officeEmail: prop.office_email,
          officeHours: prop.office_hours,
        },
        siteTypes,
        amenities,
        photos,
        faqs,
      },
    })
  } catch (e) { next(e) }
})

// ── GET /property/:slug/photo/:photoId — S547 public gallery image ──
// Streams a site photo from disk. Only rows belonging to a PUBLISHED site
// resolve (resolveProperty 404s otherwise), and only from the site-photo
// dir — internal unit/inspection photos are unreachable by construction.
const SITE_PHOTO_DIR = path.join(process.cwd(), 'uploads', 'property-site-photos')
publicPropertyBookingRouter.get('/property/:slug/photo/:photoId', async (req, res, next) => {
  try {
    const prop = await resolveProperty(req.params.slug)
    if (!z.string().uuid().safeParse(req.params.photoId).success) throw new AppError(404, 'Photo not found')
    const row = await queryOne<{ filename: string }>(
      `SELECT filename FROM property_site_photos WHERE id=$1 AND property_id=$2`,
      [req.params.photoId, prop.id])
    if (!row) throw new AppError(404, 'Photo not found')
    const fp = resolveUploadPath(SITE_PHOTO_DIR, row.filename)
    if (!fp) throw new AppError(404, 'Photo not found')
    res.setHeader('Cache-Control', 'public, max-age=3600')
    // Helmet defaults CORP to same-origin, which blocks the storefront's
    // cross-origin <img> embeds — this image is public by definition.
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin')
    res.sendFile(fp, err => { if (err && !res.headersSent) next(new AppError(404, 'Photo not found')) })
  } catch (e) { next(e) }
})

// ── POST /property/:slug/inquiry — S544 storefront contact form ──
// Anonymous guests asking about sites/amenities/availability. Stored
// durably + landlord notification (with email) carrying the message.
publicPropertyBookingRouter.post('/property/:slug/inquiry', publicWriteLimiter, async (req, res, next) => {
  try {
    const b = z.object({
      name:    z.string().min(1).max(120),
      email:   z.string().email().max(200),
      phone:   z.string().max(40).optional(),
      message: z.string().min(1).max(2000),
    }).parse(req.body)
    const prop = await resolveProperty(req.params.slug)
    await recordGuestInquiry(prop, b)
    res.json({ success: true, data: { received: true } })
  } catch (e) { next(e) }
})

/** Store a guest inquiry + notify (and email) the landlord. Shared by the
 *  standalone contact form and the S547 with-reservation question. */
async function recordGuestInquiry(
  prop: PropertyRow,
  b: { name: string; email: string; phone?: string | null; message: string },
  titlePrefix = 'New inquiry',
): Promise<void> {
  const row = await queryOne<{ id: string }>(
    `INSERT INTO property_inquiries (property_id, guest_name, guest_email, guest_phone, message)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [prop.id, b.name, b.email, b.phone ?? null, b.message])

  const landlord = await queryOne<{ user_id: string; email: string }>(
    `SELECT l.user_id, u.email FROM landlords l JOIN users u ON u.id = l.user_id
      WHERE l.id = $1`, [prop.landlord_id])
  if (landlord) {
    const { createNotification } = await import('../services/notifications')
    await createNotification({
      userId: landlord.user_id,
      landlordId: prop.landlord_id,
      type: 'property_inquiry',
      title: `${titlePrefix} — ${prop.name}`,
      body: `${b.name} (${b.email}${b.phone ? `, ${b.phone}` : ''}): ${b.message}`,
      data: { inquiry_id: row!.id, property_id: prop.id },
      sendEmail: true,
      emailTo: landlord.email,
      emailSubject: `${titlePrefix} — ${prop.name}`,
    })
  }
}

// ── S547 guest stay surface (token-gated, per Nic: amenity booking must
// never look publicly bookable). The guest's STAY LINK (emailed at booking,
// QR at the desk, expires after check-out) is the key: /stay/:token on the
// property's own subdomain shows their stay + amenity booking. ──

// GET /property/:slug/stay/:token — stay summary for the tokened page.
publicPropertyBookingRouter.get('/property/:slug/stay/:token', async (req, res, next) => {
  try {
    const prop = await resolveProperty(req.params.slug)
    const { resolveBookingGuestToken } = await import('../services/bookingGuestTokens')
    const guest = await resolveBookingGuestToken(req.params.token)
    if (!guest) throw new AppError(404, 'This stay link is invalid or has expired')
    const stay = await queryOne<any>(
      `SELECT b.id, b.guest_name, b.check_in, b.check_out, b.nights, b.status
         FROM unit_bookings b JOIN units u ON u.id = b.unit_id
        WHERE b.id = $1 AND u.property_id = $2`, [guest.bookingId, prop.id])
    if (!stay || stay.status === 'cancelled') throw new AppError(404, 'This stay link is invalid or has expired')
    res.json({
      success: true,
      data: {
        guestName: stay.guest_name,
        checkIn: stay.check_in, checkOut: stay.check_out, nights: stay.nights,
        status: stay.status, propertyName: prop.name,
      },
    })
  } catch (e) { next(e) }
})

// POST /property/:slug/stay-link — "resend my stay link". Always answers
// success (no email enumeration); live stays under the email get a fresh
// tokened link by email.
publicPropertyBookingRouter.post('/property/:slug/stay-link', publicWriteLimiter, async (req, res, next) => {
  try {
    const b = z.object({ email: z.string().email().max(200) }).parse(req.body)
    const prop = await resolveProperty(req.params.slug)
    const stays = await query<any>(
      `SELECT b.id, b.guest_name FROM unit_bookings b
         JOIN units u ON u.id = b.unit_id
        WHERE u.property_id = $1
          AND LOWER(b.guest_email) = LOWER($2)
          AND b.status IN ('confirmed', 'checked_in')
          AND b.check_out >= CURRENT_DATE
        ORDER BY b.check_in LIMIT 3`, [prop.id, b.email])
    for (const s of stays) {
      const { issueBookingGuestToken } = await import('../services/bookingGuestTokens')
      const issued = await issueBookingGuestToken({ bookingId: s.id, landlordId: prop.landlord_id, delivery: 'email' })
      const { emailGuestStayLink } = await import('../services/email')
      await emailGuestStayLink(b.email, s.guest_name, prop.name,
        storefrontStayUrl(req.params.slug, issued.token), { landlordId: prop.landlord_id })
        .catch(() => {})
    }
    res.json({ success: true, data: { sent: true } })
  } catch (e) { next(e) }
})

/** The stay page on the property's own site (path-slug dev / subdomain prod). */
function storefrontStayUrl(slug: string, token: string): string {
  const template = process.env.STOREFRONT_URL_TEMPLATE || 'http://localhost:3015/{slug}'
  return template.replace('{slug}', slug) + `/stay/${token}`
}

// POST /property/:slug/stay/:token/amenity/:areaId/reserve — the guest's
// amenity booking, authenticated by their stay link. Reuses the tenant
// flow's machinery (window rules, advisory-lock conflict check, approval
// posture, resident alerts). Fees are recorded but collected at the office —
// guests have no payment rail yet.
publicPropertyBookingRouter.post('/property/:slug/stay/:token/amenity/:areaId/reserve', async (req, res, next) => {
  try {
    const b = z.object({
      startsAt:   z.string().datetime(),
      endsAt:     z.string().datetime(),
      title:      z.string().trim().max(160).optional(),
      guestCount: z.number().int().positive().nullable().optional(),
      notes:      z.string().trim().max(2000).optional(),
      isEvent:    z.boolean().optional(),
    }).parse(req.body)
    const prop = await resolveProperty(req.params.slug)

    const { resolveBookingGuestToken } = await import('../services/bookingGuestTokens')
    const guest = await resolveBookingGuestToken(req.params.token)
    if (!guest) throw new AppError(401, 'This stay link is invalid or has expired')

    const { loadArea, validateWindow, fireAmenityAlert } = await import('./commonAreas')
    const area = await loadArea(req.params.areaId)
    if (!area || area.property_id !== prop.id || !area.active) throw new AppError(404, 'Common area not found')
    if (!area.reservable) throw new AppError(400, 'This area is not reservable')
    if (b.isEvent && !area.events_enabled) throw new AppError(400, `${area.name} does not host private events`)

    // The reservation day must fall inside THIS stay.
    const stay = await queryOne<any>(
      `SELECT b.id, b.guest_name FROM unit_bookings b
         JOIN units u ON u.id = b.unit_id
        WHERE b.id = $1 AND u.property_id = $2
          AND b.status IN ('tentative', 'confirmed', 'checked_in')
          AND $3::date BETWEEN b.check_in AND b.check_out`,
      [guest.bookingId, prop.id, b.startsAt.slice(0, 10)])
    if (!stay) {
      throw new AppError(403, 'Amenity reservations must fall within your stay dates.')
    }

    // Advance cap skipped: the stay-date bound above is the guest's limit.
    validateWindow(area, b.startsAt, b.endsAt, { skipAdvanceLimit: true })
    const { lockArea, findApprovedConflict, computeReservationFee, assertMonthlyReservationLimit } = await import('../services/commonAreas')
    // S547: per-person monthly cap (bad-actor guard) — a guest can't squat
    // the pool with stacked daily holds.
    await assertMonthlyReservationLimit(area, { guestBookingId: stay.id }, b.startsAt)
    const fee = b.isEvent ? Number(area.event_deposit_amount || 0) : computeReservationFee(area, b.startsAt)
    const kind = b.isEvent ? 'event' : 'guest_reservation'
    const notifyFlag = b.isEvent ? area.event_announce !== false : true
    const autoApprove = !area.requires_approval
    let id: string

    if (autoApprove) {
      const client = await getClient()
      try {
        await client.query('BEGIN')
        await lockArea(client, area.id)
        const conflict = await findApprovedConflict(client, area.id, b.startsAt, b.endsAt)
        if (conflict) throw new AppError(409, 'That window is already reserved — pick another time')
        const ins = await client.query(
          `INSERT INTO common_area_reservations
             (common_area_id, property_id, landlord_id, guest_booking_id,
              title, kind, starts_at, ends_at, status, guest_count, notes, fee_amount,
              notify_residents, decided_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'approved',$9,$10,$11,$12,now()) RETURNING id`,
          [area.id, prop.id, prop.landlord_id, stay.id,
           b.title ?? null, kind, b.startsAt, b.endsAt, b.guestCount ?? null, b.notes ?? null, fee, notifyFlag])
        id = ins.rows[0].id
        await client.query('COMMIT')
      } catch (e) { try { await client.query('ROLLBACK') } catch {} throw e } finally { client.release() }
      await fireAmenityAlert(id)
    } else {
      const ins = await queryOne<any>(
        `INSERT INTO common_area_reservations
           (common_area_id, property_id, landlord_id, guest_booking_id,
            title, kind, starts_at, ends_at, status, guest_count, notes, fee_amount,
            notify_residents)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending',$9,$10,$11,$12) RETURNING id`,
        [area.id, prop.id, prop.landlord_id, stay.id,
         b.title ?? null, kind, b.startsAt, b.endsAt, b.guestCount ?? null, b.notes ?? null, fee, notifyFlag])
      id = ins!.id
      const meta = await queryOne<any>(
        `SELECT lu.id AS landlord_user_id, lu.email AS landlord_email
           FROM landlords l JOIN users lu ON lu.id = l.user_id WHERE l.id = $1`, [prop.landlord_id])
      if (meta?.landlord_user_id) {
        const { notifyReservationRequested } = await import('../services/notifications')
        await notifyReservationRequested({
          landlordUserId: meta.landlord_user_id, landlordId: prop.landlord_id,
          landlordEmail: meta.landlord_email,
          tenantName: `${stay.guest_name || 'A guest'} (short-term guest)`,
          areaName: area.name, propertyName: prop.name,
          startsAt: b.startsAt, endsAt: b.endsAt, reservationId: id, guestCount: b.guestCount ?? null,
        })
      }
    }

    res.status(201).json({
      success: true,
      data: {
        reservationId: id,
        status: autoApprove ? 'approved' : 'pending',
        feeAmount: fee,
      },
    })
  } catch (e) { next(e) }
})

// ── GET /api/public/property/:slug/availability ──
// ?checkIn=&checkOut=[&siteTypeId=] → availability + indicative price.
// With siteTypeId: the original single-type shape (legacy customer portal).
// Without (S547, Nic — dates-first storefront): every site type's
// availability + stay quote in one call, so the guest picks dates first and
// only ever chooses from what's actually open.


publicPropertyBookingRouter.get('/property/:slug/availability', async (req, res, next) => {
  try {
    const q = z.object({
      siteTypeId: z.string().optional(),
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

    const units = await bookableUnits(prop.id)

    if (q.siteTypeId) {
      const siteType = resolveSiteType(units, q.siteTypeId)
      const a = await typeAvailability(prop, siteType, nights, q.checkIn, q.checkOut)
      return res.json({ success: true, data: { ...a, nights } })
    }

    const siteTypes = []
    for (const t of groupSiteTypes(units)) {
      const a = await typeAvailability(prop, t, nights, q.checkIn, q.checkOut)
      siteTypes.push({
        id: t.id,
        name: t.name,
        minStayNights: t.units[0].min_stay_nights,
        checkInTime: t.units[0].check_in_time,
        checkOutTime: t.units[0].check_out_time,
        ...a,
      })
    }
    res.json({
      success: true,
      data: {
        nights,
        depositPct: Number(prop.booking_deposit_pct),
        // S547: monthly-tier quotes show "plus utilities" when the property
        // bills utilities back on long stays.
        utilitiesBilled: prop.booking_utilities_billed,
        siteTypes,
      },
    })
  } catch (e) { next(e) }
})

// Guest-supplied booking details (the guest is not a GAM user).
const guestBody = z.object({
  siteTypeId: z.string().max(100),
  guestName: z.string().min(1).max(120),
  guestEmail: z.string().email().max(200),
  guestPhone: z.string().max(40).optional(),
  checkIn:   z.string(),
  checkOut:  z.string(),
  stayType:  z.enum(['nightly', 'weekly']).default('nightly'),
  // S547: optional question submitted WITH the reservation (the standalone
  // contact form lives on the home page, not the booking page).
  note: z.string().max(2000).optional(),
})

// ── POST /property/:slug/book — tentative hold + Stripe deposit checkout ──
publicPropertyBookingRouter.post('/property/:slug/book', publicWriteLimiter, async (req, res, next) => {
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
        // S547: a question riding along with the reservation lands in the
        // landlord's inquiry stream too (the booking's notes alone would sit
        // unseen). Best-effort — never fails the booking.
        if (b.note?.trim()) {
          recordGuestInquiry(prop,
            { name: b.guestName, email: b.guestEmail, phone: b.guestPhone, message: b.note.trim() },
            'Reservation question')
            .catch(() => {})
        }
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

// ── GET /property/:slug/booking/:id — S547 confirmation-page status ──
// The Stripe success URL returns the guest to /booked?booking=<id>; the page
// polls this until the deposit webhook flips the booking 'confirmed'. Keyed by
// the unguessable booking uuid + slug match; returns only what the guest
// already knows plus status — never unit inventory or site numbers.
publicPropertyBookingRouter.get('/property/:slug/booking/:id', async (req, res, next) => {
  try {
    const prop = await resolveProperty(req.params.slug)
    if (!z.string().uuid().safeParse(req.params.id).success) throw new AppError(404, 'Booking not found')
    const b = await queryOne<any>(
      `SELECT b.status, b.check_in, b.check_out, b.nights, b.guest_name,
              b.deposit_amount, b.total_amount, b.hold_expires_at
         FROM unit_bookings b
         JOIN units u ON u.id = b.unit_id
        WHERE b.id = $1 AND u.property_id = $2`,
      [req.params.id, prop.id])
    if (!b) throw new AppError(404, 'Booking not found')
    res.json({
      success: true,
      data: {
        status: b.status,
        checkIn: b.check_in, checkOut: b.check_out, nights: b.nights,
        guestName: b.guest_name,
        depositAmount: b.deposit_amount != null ? Number(b.deposit_amount) : null,
        total: b.total_amount != null ? Number(b.total_amount) : null,
        holdExpiresAt: b.hold_expires_at,
        propertyName: prop.name,
      },
    })
  } catch (e) { next(e) }
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
