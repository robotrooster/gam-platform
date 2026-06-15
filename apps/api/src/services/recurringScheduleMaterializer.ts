/**
 * S460 / Phase 1a.2 — recurring-schedule materializer.
 *
 * Walks active recurring_schedules and creates concrete appointment
 * rows for the next N days. Idempotent — re-running on the same
 * window produces no duplicates (UNIQUE index
 * `uniq_appointments_recurring_occurrence` ON CONFLICT DO NOTHING).
 *
 * Designed to run as a daily cron. Manual invocation is fine too —
 * tests call materializeAllSchedules() directly with an injected
 * `now` Date so occurrence math is deterministic.
 *
 * RRULE library: `rrule` (npm, MIT). RFC 5545 format. Examples:
 *   FREQ=WEEKLY;BYDAY=TU       — every Tuesday
 *   FREQ=WEEKLY;BYDAY=TU,TH    — every Tuesday + Thursday
 *   FREQ=MONTHLY;BYMONTHDAY=15 — every 15th
 *   FREQ=DAILY;INTERVAL=2      — every other day
 *
 * Time-of-day is stored separately on recurring_schedules.time_of_day
 * (HH:MM format, UTC). RRULE handles the date pattern; we combine
 * with time at materialization. This avoids the RRULE-DTSTART
 * complexity for a time-only override.
 */

import { RRule } from 'rrule'
import { db, query, queryOne } from '../db'
import { logger } from '../lib/logger'

/** How far ahead the materializer looks each run. 60 days keeps a
 *  rolling 2-month window of route-engine input without flooding
 *  the appointments table for years out. Adjustable per business
 *  in a future session if a use case demands it. */
const DEFAULT_LOOKAHEAD_DAYS = 60

export interface MaterializeResult {
  schedules_scanned:   number
  appointments_created: number
  errors:              number
}

/** Combine a date (YYYY-MM-DD or Date) with HH:MM into a UTC ISO
 *  string. The rrule library returns Dates set to UTC midnight; we
 *  layer the schedule's time_of_day on top. */
function withTimeOfDay(dateOnly: Date, timeOfDay: string): Date {
  const [h, m] = timeOfDay.split(':').map(Number)
  const out = new Date(dateOnly)
  out.setUTCHours(h, m, 0, 0)
  return out
}

/** Compute occurrences for ONE schedule in [from, to]. Exposed for
 *  direct testing. */
export function computeOccurrences(args: {
  rrule:       string
  timeOfDay:   string
  startDate:   string  // YYYY-MM-DD
  endDate:     string | null
  from:        Date
  to:          Date
}): Date[] {
  const scheduleStart = new Date(`${args.startDate}T00:00:00Z`)
  // rrule needs a DTSTART; we attach the schedule's start_date.
  // Pattern is the existing rrule body; merge as the library expects.
  const ruleString = `DTSTART:${scheduleStart.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')}\nRRULE:${args.rrule}`
  const rule = RRule.fromString(ruleString)
  // Use the LATER of (schedule start, from-window) as the effective
  // start so we don't generate rows for dates before the schedule
  // technically existed.
  const effectiveFrom = scheduleStart.getTime() > args.from.getTime()
    ? scheduleStart : args.from
  // Likewise, respect end_date if set.
  const effectiveTo = args.endDate
    ? new Date(`${args.endDate}T23:59:59Z`).getTime() < args.to.getTime()
      ? new Date(`${args.endDate}T23:59:59Z`)
      : args.to
    : args.to
  if (effectiveFrom.getTime() > effectiveTo.getTime()) return []
  const dates = rule.between(effectiveFrom, effectiveTo, true)
  return dates.map(d => withTimeOfDay(d, args.timeOfDay))
}

/** Materialize all active schedules. Default window: next 60 days
 *  starting from `now`. */
export async function materializeAllSchedules(
  now: Date = new Date(),
  lookaheadDays: number = DEFAULT_LOOKAHEAD_DAYS,
): Promise<MaterializeResult> {
  const out: MaterializeResult = {
    schedules_scanned: 0,
    appointments_created: 0,
    errors: 0,
  }
  const to = new Date(now.getTime() + lookaheadDays * 24 * 3600 * 1000)

  const schedules = await query<{
    id: string
    business_id: string
    customer_id: string
    service_type: string
    rrule: string
    time_of_day: string
    start_date: string
    end_date: string | null
    default_duration_minutes: number
    default_notes: string | null
  }>(
    `SELECT id, business_id, customer_id, service_type, rrule,
            time_of_day,
            start_date::text AS start_date,
            end_date::text   AS end_date,
            default_duration_minutes, default_notes
       FROM recurring_schedules
      WHERE status = 'active'`)
  out.schedules_scanned = schedules.length

  for (const s of schedules) {
    try {
      const occurrences = computeOccurrences({
        rrule:     s.rrule,
        timeOfDay: s.time_of_day,
        startDate: s.start_date,
        endDate:   s.end_date,
        from:      now,
        to,
      })
      for (const ts of occurrences) {
        const r = await db.query<{ id: string }>(
          `INSERT INTO appointments
             (business_id, customer_id, recurring_schedule_id,
              service_type, scheduled_for, duration_minutes, notes)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (recurring_schedule_id, scheduled_for)
             WHERE recurring_schedule_id IS NOT NULL
             DO NOTHING
           RETURNING id`,
          [s.business_id, s.customer_id, s.id,
           s.service_type, ts.toISOString(),
           s.default_duration_minutes, s.default_notes])
        if (r.rows.length > 0) out.appointments_created += 1
      }
      // Stamp last_materialized_at after the schedule's occurrences
      // are processed. Used for ops observability; the cron doesn't
      // resume FROM this value — every run re-queries the full window
      // for idempotency safety.
      await query(
        `UPDATE recurring_schedules SET last_materialized_at = $1 WHERE id = $2`,
        [now, s.id])
    } catch (e) {
      logger.error({ err: e, ctx: s.id }, '[materializer] schedule failed:')
      out.errors += 1
    }
  }

  return out
}
