/**
 * S511 — public appointments ICS feed (walkthrough Business #7).
 *
 *   GET /api/public/business-calendar/:token(.ics)
 *
 * Unauthenticated; the unguessable per-business token IS the credential.
 * Returns a text/calendar document the owner subscribes to in Google / Apple /
 * Outlook. Rotating the token (owner action) instantly revokes any old
 * subscription. Enumeration-safe: any bad/missing token → 404, no distinction
 * between "malformed", "unknown", and "inactive business".
 */

import { Router } from 'express'
import { query, queryOne } from '../db'
import {
  buildAppointmentsIcs,
  type CalendarFeedAppointment,
  type CalendarFeedBusiness,
} from '../services/calendarFeed'

export const publicBusinessCalendarRouter = Router()

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

publicBusinessCalendarRouter.get('/business-calendar/:token', async (req, res, next) => {
  try {
    // The published URL ends in `.ics`; calendar clients fetch it verbatim.
    const token = req.params.token.replace(/\.ics$/i, '')
    if (!UUID_RE.test(token)) {
      res.status(404).type('text/plain').send('Not found')
      return
    }

    const business = await queryOne<CalendarFeedBusiness>(
      `SELECT id, name FROM businesses
        WHERE calendar_feed_token = $1 AND status = 'active'`,
      [token])
    if (!business) {
      res.status(404).type('text/plain').send('Not found')
      return
    }

    // Window: recent past (so a just-finished job still resolves on the
    // subscriber's calendar) through the next ~6 months of scheduled work.
    const appointments = await query<CalendarFeedAppointment>(
      `SELECT a.id, a.service_type, a.scheduled_for, a.duration_minutes,
              a.status, a.notes,
              c.first_name, c.last_name, c.company_name,
              c.street1, c.city, c.state, c.zip
         FROM appointments a
         JOIN business_customers c ON c.id = a.customer_id
        WHERE a.business_id = $1
          AND a.scheduled_for >= NOW() - INTERVAL '30 days'
          AND a.scheduled_for <  NOW() + INTERVAL '180 days'
        ORDER BY a.scheduled_for ASC`,
      [business.id])

    const ics = buildAppointmentsIcs(business, appointments, new Date())
    res
      .status(200)
      .type('text/calendar; charset=utf-8')
      .set('Content-Disposition', 'inline; filename="gam-appointments.ics"')
      // Let clients cache briefly; the feed is polled, not pushed.
      .set('Cache-Control', 'private, max-age=300')
      .send(ics)
  } catch (e) { next(e) }
})
