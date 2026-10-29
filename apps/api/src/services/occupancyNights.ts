/**
 * 10/21 (Nic) — WHO WAS IN THE SPOT LAST NIGHT, WRITTEN DOWN.
 *
 *   "that's one of the reasons why I want the reservation locked at checkout
 *    with no way to delete it. Because if, like, say I had 10 or 12 people go
 *    in the month, and then the landlord goes to delete all of those out of the
 *    schedule before the close of the month, then when it reads the schedule,
 *    the landlord could be cheating us out of the subscription fee by deleting
 *    the history. We need a way to have that no matter what changes they try to
 *    do."
 *
 *   "let's do the migration you were talking about where it counts who's in the
 *    spot each night. That way, you know, that way if people extend or leave
 *    early, it's got an accurate count."
 *
 * Nightly and weekly nights are the one thing GAM bills in ARREARS, counted on
 * the 1st for the month just ended. That count used to read the reservations'
 * own dates at the moment the bill was cut, and editing the dates of a stay
 * that already happened is deliberately allowed (S548) — so a landlord
 * re-dating a month's stays on the 30th lowered what GAM billed, and no rule
 * could tell that apart from an honest early check-out.
 *
 * So each night is written down the morning after it happened, from what the
 * schedule said for that site that night, and never rewritten (the migration's
 * triggers refuse a delete and freeze the site, the night and the kind). The
 * bill counts those rows. Nothing anybody edits afterwards can take a night
 * away.
 *
 * ── WHAT THIS DOES NOT CHANGE ───────────────────────────────────────────────
 *
 * What GAM bills. The stamp applies the same status rule the live count applied
 * (feeCountedNightsStatusSql): a stay cancelled before arrival stamps nothing
 * (all its nights are still ahead of it when it is cancelled), and one
 * cancelled on or after arrival — or marked a no-show — goes on being stamped
 * to its booked check-out, exactly as the old count charged it. S652: "the site
 * was held, it could not be sold to anybody else."
 *
 * An early check-out stops the nights from the day they leave, because the
 * stamp only ever records nights that have passed and the schedule no longer
 * carries them. A stay nobody closed out keeps stamping to its booked
 * check-out, which bills the landlord for nights nobody slept. Nic, told that
 * plainly: "that's going to be on their front desk people to stay on top of the
 * schedule correctly."
 *
 * ── THE READ IS IN services/billableUnits ───────────────────────────────────
 *
 * Deliberately. One place owns "how many spaces is this property billed for",
 * the accrual and the landlord's estimate both call it, and a discrepancy
 * between what GAM shows and what GAM bills has to stay impossible. That read
 * counts the stamps, and falls back to the live schedule for a night no stamp
 * covers — a night from the hours since the last run, or a reservation typed in
 * (or imported) after the night had already passed. So nothing is ever lost by
 * this job being late, and a night it has already written cannot be moved.
 */
import type { PoolClient } from 'pg'

import { db } from '../db'
import { logger } from '../lib/logger'
import { feeCountedNightsStatusSql } from './billableUnits'

type Q = Pick<PoolClient, 'query'>

/**
 * How far back a run reaches. A month and a half, so a park whose API was down
 * for a weekend — or for a fortnight — still has every night of the month
 * written before the 1st, while the statement stays a few hundred rows.
 */
export const STAMP_LOOKBACK_DAYS = 45

/**
 * Write down every night that has passed and is not written down yet.
 *
 * Idempotent (one row per reservation per night, by unique index), so running
 * it again costs nothing and running it twice at once cannot double-count.
 * Bounded by the property's OWN calendar: "last night" is the night that ended
 * in the park's time zone, never the server's.
 *
 * `propertyId`: one park, or every park when absent. `from`: the earliest night
 * to consider, default STAMP_LOOKBACK_DAYS back. `through`: the last night to
 * consider, default last night (it is capped at last night either way — a night
 * that has not ended is not an occupied night).
 */
export async function stampOccupancyNights(q: Q, args: {
  propertyId?: string | null
  from?: string | null
  through?: string | null
} = {}): Promise<{ stamped: number }> {
  const r = await q.query(
    `INSERT INTO unit_occupancy_nights
       (landlord_id, property_id, unit_id, booking_id, night, lease_type, unit_type, status_at_stamp, stay_terms)
     SELECT b.landlord_id, u.property_id, b.unit_id, b.id, d::date,
            b.lease_type, u.unit_type, b.status, b.stay_terms
       FROM unit_bookings b
       JOIN units u ON u.id = b.unit_id
       JOIN properties p ON p.id = u.property_id
       CROSS JOIN LATERAL generate_series(
         GREATEST(b.check_in, COALESCE($2::date, CURRENT_DATE - $4::int)),
         LEAST(
           -- The night before check-out is the last night slept there.
           b.check_out - 1,
           -- Last night in the park's own time zone, and no later than asked.
           ((NOW() AT TIME ZONE COALESCE(p.timezone, 'America/Phoenix'))::date - 1),
           COALESCE($3::date, 'infinity'::date)),
         INTERVAL '1 day') d
      WHERE ($1::uuid IS NULL OR u.property_id = $1::uuid)
        -- The same rule the bill applies: a stay cancelled before it arrived
        -- never happened; one cancelled on or after arrival held the site.
        AND ${feeCountedNightsStatusSql('b')}
     ON CONFLICT (booking_id, night) DO NOTHING`,
    [args.propertyId ?? null, args.from ?? null, args.through ?? null, STAMP_LOOKBACK_DAYS])
  return { stamped: r.rowCount ?? 0 }
}

/**
 * The hourly run. Hourly rather than nightly because a park's own midnight is
 * its own: the parks run in four time zones today and will run in more, and an
 * hourly pass means every one of them has last night written down within the
 * hour of its own midnight — in particular before the 1st-of-the-month accrual
 * reads the month (jobs/platformFeeAccrual, 1:30 am Phoenix).
 *
 * It writes nothing on most runs, because the night it would write is already
 * written.
 */
export async function stampOccupancyNightsHourly(): Promise<{ stamped: number }> {
  const out = await stampOccupancyNights(db)
  if (out.stamped > 0) logger.info(out, '[occupancy-nights] nights written down')
  return out
}
