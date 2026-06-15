/**
 * S507 — public self-service booking surface (NO AUTH).
 *
 * Three endpoints, all keyed by the business's public_booking_slug:
 *
 *   GET  /api/public/booking/:slug                — business profile + services
 *   GET  /api/public/booking/:slug/availability?serviceId&fromDate&toDate
 *                                                — list of available slots
 *   POST /api/public/booking/:slug/book           — create customer + appointment
 *
 * The endpoints are mounted under a CORS-permissive express.Router so
 * the marketing site can call them. Only published when
 * businesses.public_booking_enabled = TRUE.
 *
 * Privacy posture: NO authenticated info is exposed. The profile
 * returns business name + intro + services. The availability endpoint
 * doesn't reveal which customer holds which slot — only "this slot is
 * busy". The book endpoint accepts customer details and either
 * matches an existing customer (by email + business_id) or creates a
 * new one with status='active'.
 *
 * Rate limit: applied at app level (the global limiter at apps/api/
 * src/index.ts covers /api/* including /api/public/*).
 */

import { Router } from 'express'
import { z } from 'zod'
import { db, query, queryOne } from '../db'
import { AppError } from '../middleware/errorHandler'
import { logger } from '../lib/logger'

export const publicBookingRouter = Router()

// Default hours when business hasn't customized: Mon-Fri 9-5, Sat-Sun closed.
const DEFAULT_HOURS: Record<string, { open: string; close: string } | null> = {
  '0': null,
  '1': { open: '09:00', close: '17:00' },
  '2': { open: '09:00', close: '17:00' },
  '3': { open: '09:00', close: '17:00' },
  '4': { open: '09:00', close: '17:00' },
  '5': { open: '09:00', close: '17:00' },
  '6': null,
}

const MAX_AVAILABILITY_DAYS = 90
// Minimum lead time before a slot can be booked (anti-abuse + giving
// the operator time to see the appointment land).
const MIN_LEAD_TIME_MINUTES = 60
// Slot granularity — the public surface offers slots on these
// boundaries within the open window. 15-min works for most service
// businesses; durations longer than 15 still fit because slot start
// times stay on the grid and the service occupies multiple slots.
const SLOT_GRANULARITY_MINUTES = 15

interface BizRow {
  id: string
  name: string
  email: string
  phone: string | null
  street1: string | null
  city: string | null
  state: string | null
  zip: string | null
  public_booking_intro: string | null
  business_hours: Record<string, { open: string; close: string } | null>
}

async function resolveBiz(slug: string): Promise<BizRow> {
  const biz = await queryOne<BizRow>(
    `SELECT id, name, email, phone, street1, city, state, zip,
            public_booking_intro, business_hours
       FROM businesses
      WHERE public_booking_slug = $1
        AND public_booking_enabled = TRUE
        AND status = 'active'`, [slug])
  if (!biz) throw new AppError(404, 'Booking page not found')
  return biz
}

// ═══════════════════════════════════════════════════════════════
//  GET /booking/:slug — public profile
// ═══════════════════════════════════════════════════════════════

publicBookingRouter.get('/booking/:slug', async (req, res, next) => {
  try {
    const biz = await resolveBiz(req.params.slug)
    const services = await query<{
      id: string; name: string; description: string | null;
      duration_minutes: number; price: string | null;
    }>(
      `SELECT id, name, description, duration_minutes, price
         FROM business_bookable_services
        WHERE business_id = $1 AND is_active = TRUE
        ORDER BY sort_order ASC, name ASC`, [biz.id])
    res.json({
      success: true,
      data: {
        name: biz.name,
        email: biz.email,
        phone: biz.phone,
        address: {
          street1: biz.street1, city: biz.city, state: biz.state, zip: biz.zip,
        },
        intro: biz.public_booking_intro,
        services,
        business_hours: biz.business_hours && Object.keys(biz.business_hours).length > 0
          ? biz.business_hours : DEFAULT_HOURS,
      },
    })
  } catch (e) { next(e) }
})

// ═══════════════════════════════════════════════════════════════
//  GET /booking/:slug/availability
// ═══════════════════════════════════════════════════════════════

const availabilitySchema = z.object({
  serviceId: z.string().uuid(),
  fromDate:  z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  toDate:    z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
})

interface SlotRow {
  date: string         // YYYY-MM-DD
  slots: string[]      // HH:MM (24h) array of available start times
}

publicBookingRouter.get('/booking/:slug/availability', async (req, res, next) => {
  try {
    const biz = await resolveBiz(req.params.slug)
    const q = availabilitySchema.parse(req.query)
    const service = await queryOne<{ id: string; duration_minutes: number }>(
      `SELECT id, duration_minutes FROM business_bookable_services
        WHERE id = $1 AND business_id = $2 AND is_active = TRUE`,
      [q.serviceId, biz.id])
    if (!service) throw new AppError(404, 'Service not found')

    const fromDate = parseDate(q.fromDate)
    // Default window: from + 13 → 14 days inclusive (matches the
    // marketing-site UI which renders two weeks).
    const toDate = q.toDate ? parseDate(q.toDate) : addDays(fromDate, 13)
    if (toDate < fromDate) throw new AppError(400, 'toDate must be >= fromDate')
    const dayCount = Math.floor((toDate.getTime() - fromDate.getTime()) / (24 * 3600 * 1000)) + 1
    if (dayCount > MAX_AVAILABILITY_DAYS) {
      throw new AppError(400, `Window too large; max ${MAX_AVAILABILITY_DAYS} days`)
    }

    // Pull all existing scheduled appointments overlapping the window.
    const existing = await query<{
      scheduled_for: Date; duration_minutes: number;
    }>(
      `SELECT scheduled_for, duration_minutes
         FROM appointments
        WHERE business_id = $1
          AND status = 'scheduled'
          AND scheduled_for >= $2::date
          AND scheduled_for <  ($3::date + INTERVAL '1 day')`,
      [biz.id, q.fromDate, q.toDate ?? q.fromDate])

    const hours = biz.business_hours && Object.keys(biz.business_hours).length > 0
      ? biz.business_hours : DEFAULT_HOURS

    const result: SlotRow[] = []
    for (let i = 0; i < dayCount; i++) {
      const date = addDays(fromDate, i)
      const dow = String(date.getDay()) // 0-6 local TZ
      const window = hours[dow]
      if (!window) {
        result.push({ date: isoDate(date), slots: [] })
        continue
      }
      const dayStart = withTime(date, window.open)
      const dayEnd = withTime(date, window.close)
      const slots: string[] = []
      const now = new Date()
      const minBookable = new Date(now.getTime() + MIN_LEAD_TIME_MINUTES * 60_000)
      for (let t = dayStart.getTime();
           t + service.duration_minutes * 60_000 <= dayEnd.getTime();
           t += SLOT_GRANULARITY_MINUTES * 60_000) {
        const slotStart = new Date(t)
        if (slotStart < minBookable) continue
        const slotEnd = new Date(t + service.duration_minutes * 60_000)
        // Conflict check: any existing scheduled appt whose [start, end)
        // overlaps [slot_start, slot_end).
        const conflict = existing.some(a => {
          const aStart = a.scheduled_for instanceof Date ? a.scheduled_for : new Date(a.scheduled_for)
          const aEnd = new Date(aStart.getTime() + a.duration_minutes * 60_000)
          return aStart < slotEnd && aEnd > slotStart
        })
        if (!conflict) {
          slots.push(formatTime(slotStart))
        }
      }
      result.push({ date: isoDate(date), slots })
    }

    res.json({
      success: true,
      data: {
        service_id: service.id,
        duration_minutes: service.duration_minutes,
        days: result,
      },
    })
  } catch (e) { next(e) }
})

// ═══════════════════════════════════════════════════════════════
//  POST /booking/:slug/book — create customer + appointment
// ═══════════════════════════════════════════════════════════════

const bookSchema = z.object({
  serviceId:    z.string().uuid(),
  scheduledFor: z.string().datetime(),  // ISO 8601 timestamp
  firstName:    z.string().min(1).max(120),
  lastName:     z.string().min(1).max(120),
  email:        z.string().email(),
  phone:        z.string().min(1).max(30),
  notes:        z.string().max(1000).optional(),
})

publicBookingRouter.post('/booking/:slug/book', async (req, res, next) => {
  try {
    const biz = await resolveBiz(req.params.slug)
    const body = bookSchema.parse(req.body)
    const service = await queryOne<{
      id: string; name: string; duration_minutes: number;
    }>(
      `SELECT id, name, duration_minutes FROM business_bookable_services
        WHERE id = $1 AND business_id = $2 AND is_active = TRUE`,
      [body.serviceId, biz.id])
    if (!service) throw new AppError(404, 'Service not found')

    const slotStart = new Date(body.scheduledFor)
    const slotEnd = new Date(slotStart.getTime() + service.duration_minutes * 60_000)
    const now = new Date()
    const minBookable = new Date(now.getTime() + MIN_LEAD_TIME_MINUTES * 60_000)
    if (slotStart < minBookable) {
      throw new AppError(400, 'Slot must be at least 60 minutes from now')
    }

    const client = await db.connect()
    try {
      await client.query('BEGIN')

      // Match an existing customer by lowercase email, or insert a new
      // one. Email match is the dedup key — phone is not reliable
      // (same family shares numbers).
      const { rows: [existing] } = await client.query<{ id: string }>(
        `SELECT id FROM business_customers
          WHERE business_id = $1 AND LOWER(email) = LOWER($2) AND status = 'active'
          LIMIT 1`,
        [biz.id, body.email])

      let customerId: string
      if (existing) {
        customerId = existing.id
      } else {
        const { rows: [created] } = await client.query<{ id: string }>(
          `INSERT INTO business_customers
             (business_id, customer_type, first_name, last_name,
              email, phone, street1, city, state, zip, status)
           VALUES ($1, 'individual', $2, $3, $4, $5, $6, $7, $8, $9, 'active')
           RETURNING id`,
          [biz.id, body.firstName.trim(), body.lastName.trim(),
           body.email.trim().toLowerCase(), body.phone.trim(),
           // Address fields are required NOT NULL on business_customers;
           // public booking doesn't collect them, so seed with the
           // business's own address as a placeholder the operator can
           // fix later. Future: relax NOT NULL on these.
           biz.street1 ?? 'TBD',
           biz.city ?? 'TBD',
           biz.state ?? 'XX',
           biz.zip ?? '00000'])
        customerId = created.id
      }

      // Last-mile conflict check: someone else might have grabbed the
      // same slot between the availability call and this submit.
      const { rows: conflicts } = await client.query<{ id: string }>(
        `SELECT id FROM appointments
          WHERE business_id = $1
            AND status = 'scheduled'
            AND scheduled_for < $3
            AND (scheduled_for + (duration_minutes * INTERVAL '1 minute')) > $2`,
        [biz.id, slotStart.toISOString(), slotEnd.toISOString()])
      if (conflicts.length > 0) {
        await client.query('ROLLBACK')
        throw new AppError(409, 'That slot was just booked — pick another time')
      }

      const { rows: [appt] } = await client.query<{ id: string }>(
        `INSERT INTO appointments
           (business_id, customer_id, service_type,
            scheduled_for, duration_minutes, notes, status)
         VALUES ($1, $2, $3, $4, $5, $6, 'scheduled')
         RETURNING id`,
        [biz.id, customerId, service.name,
         slotStart.toISOString(), service.duration_minutes,
         body.notes?.trim() || null])

      await client.query('COMMIT')

      // Best-effort emails (don't block on failure).
      try {
        const { emailBusinessAppointmentConfirmed } = await import('../services/email')
        const customerName = `${body.firstName.trim()} ${body.lastName.trim()}`.trim() || null
        await emailBusinessAppointmentConfirmed({
          to:              body.email,
          customerName,
          businessName:    biz.name,
          serviceType:     service.name,
          scheduledFor:    slotStart,
          durationMinutes: service.duration_minutes,
          notes:           body.notes?.trim() || null,
          ctx: { businessId: biz.id, appointmentId: appt.id },
        })
      } catch (e) {
        logger.error({ err: e, appointmentId: appt.id }, '[public-booking] customer email failed')
      }
      // Notify the business owner too — they need to see it land in
      // their portal but a heads-up email gives them confidence the
      // public surface is working.
      if (biz.email) {
        try {
          const { emailBusinessAppointmentConfirmed } = await import('../services/email')
          await emailBusinessAppointmentConfirmed({
            to:              biz.email,
            customerName:    `${body.firstName} ${body.lastName} (customer)`,
            businessName:    biz.name,
            serviceType:     service.name,
            scheduledFor:    slotStart,
            durationMinutes: service.duration_minutes,
            notes:           `Booked via public page. Customer: ${body.email} / ${body.phone}`,
            ctx: { businessId: biz.id, appointmentId: appt.id },
          })
        } catch (e) {
          logger.error({ err: e, appointmentId: appt.id }, '[public-booking] owner email failed')
        }
      }

      res.status(201).json({
        success: true,
        data: {
          appointment_id: appt.id,
          confirmation:   `Your ${service.name} is confirmed for ${slotStart.toLocaleString()}.`,
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

// ── Date helpers ──────────────────────────────────────────────

function parseDate(iso: string): Date {
  return new Date(`${iso}T00:00:00`)
}
function addDays(d: Date, n: number): Date {
  const out = new Date(d.getTime())
  out.setDate(out.getDate() + n)
  return out
}
function isoDate(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}
function withTime(d: Date, hhmm: string): Date {
  const [h, m] = hhmm.split(':').map(n => parseInt(n, 10))
  const out = new Date(d.getTime())
  out.setHours(h ?? 0, m ?? 0, 0, 0)
  return out
}
function formatTime(d: Date): string {
  const h = String(d.getHours()).padStart(2, '0')
  const m = String(d.getMinutes()).padStart(2, '0')
  return `${h}:${m}`
}
