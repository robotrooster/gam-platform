/**
 * S596 — the private sales/demo calendar subscribe feed.
 *
 *   GET /api/public/sales-calendar/:token(.ics)
 *
 * Unauthenticated; the unguessable singleton token IS the credential. The
 * owner subscribes their calendar to this URL once and every booking then
 * auto-appears (no emailed .ics to hand-add). Rotating the token (admin
 * action) instantly revokes any old subscription. Enumeration-safe: any
 * bad/missing token → 404, no distinction between malformed / unknown.
 *
 * Mirrors publicBusinessCalendar.ts. Each VEVENT carries the survey brief in
 * its DESCRIPTION + the Jitsi room as LOCATION/URL.
 */

import { Router } from 'express'
import { timingSafeEqual } from 'crypto'
import { query, queryOne } from '../db'
import { buildSalesFeedIcs, type DemoSlotRow } from '../services/demoCalendar'

export const publicSalesCalendarRouter = Router()

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function tokenMatches(provided: string, stored: string): boolean {
  const a = Buffer.from(provided)
  const b = Buffer.from(stored)
  return a.length === b.length && timingSafeEqual(a, b)
}

publicSalesCalendarRouter.get('/sales-calendar/:token', async (req, res, next) => {
  try {
    // The published URL ends in `.ics`; calendar clients fetch it verbatim.
    const token = req.params.token.replace(/\.ics$/i, '')
    if (!UUID_RE.test(token)) {
      res.status(404).type('text/plain').send('Not found')
      return
    }

    const feed = await queryOne<{ feed_token: string; busy_feed_token: string | null }>(
      `SELECT feed_token, busy_feed_token FROM sales_calendar_feed WHERE id = true`)
    // The owner's token → full detail; the shareable busy token → stripped
    // time-blocks only. Anything else is indistinguishable from a bad token.
    let scope: 'full' | 'busy' | null = null
    if (feed && tokenMatches(token, feed.feed_token)) scope = 'full'
    else if (feed && feed.busy_feed_token && tokenMatches(token, feed.busy_feed_token)) scope = 'busy'
    if (!scope) {
      res.status(404).type('text/plain').send('Not found')
      return
    }

    // Window: recent-past (a just-finished call still resolves) through the
    // next ~6 months. Include cancelled/no_show so they grey out on the
    // subscriber's calendar rather than lingering.
    const rows = await query<DemoSlotRow>(
      `SELECT s.id, s.starts_at, s.duration_minutes, s.kind, s.status, s.meeting_url,
              s.prospect_name, s.prospect_email, s.prospect_phone, s.notes,
              l.portfolio_size AS lead_portfolio_size,
              l.property_type  AS lead_property_type,
              l.metadata       AS lead_metadata
         FROM sales_call_slots s
         LEFT JOIN sales_leads l ON l.id = s.lead_id
        WHERE s.starts_at >= NOW() - INTERVAL '30 days'
          AND s.starts_at <  NOW() + INTERVAL '180 days'
        ORDER BY s.starts_at ASC`)

    const ics = buildSalesFeedIcs(rows, new Date(), scope)
    res
      .status(200)
      .type('text/calendar; charset=utf-8')
      .set('Content-Disposition', `inline; filename="${scope === 'busy' ? 'gam-schedule' : 'gam-demos'}.ics"`)
      // Clients poll this; let them cache briefly.
      .set('Cache-Control', 'private, max-age=300')
      .send(ics)
  } catch (e) { next(e) }
})
