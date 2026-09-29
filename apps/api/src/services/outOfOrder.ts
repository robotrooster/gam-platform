/**
 * S649 (Nic): "we need a way to mark RV sites out of order... I want the
 * compression and expansion to be able to detect out of order sites and not
 * push something in there when there's no reservation."
 *
 * A window on one site. Every availability path reads it through the SQL
 * function unit_out_of_order_overlaps() (or the compressor's obstacle list), so
 * marking a site takes it out of the online booking site, staff bookings, the
 * unit picker and the schedule compressor at once. The compressor moves a stay
 * already on it to another compatible site when there is one; when there isn't,
 * the landlord is told, because only a person can decide what happens next.
 */
import { query, queryOne } from '../db'
import { AppError } from '../middleware/errorHandler'
import { createNotification } from './notifications'
import { compressPropertySchedule } from './scheduleCompression'
import { logger } from '../lib/logger'

export async function markOutOfOrder(opts: {
  unitId: string; landlordId: string; userId: string
  startsOn?: string | null; endsOn?: string | null; reason?: string | null
}): Promise<any> {
  const unit = await queryOne<{ property_id: string; landlord_id: string }>(
    `SELECT property_id, landlord_id FROM units WHERE id = $1`, [opts.unitId])
  if (!unit || unit.landlord_id !== opts.landlordId) throw new AppError(404, 'Unit not found')
  const row = await queryOne<any>(
    `INSERT INTO unit_out_of_order (unit_id, landlord_id, starts_on, ends_on, reason, created_by)
     VALUES ($1, $2, COALESCE($3::date, CURRENT_DATE), $4::date, $5, $6) RETURNING *`,
    [opts.unitId, opts.landlordId, opts.startsOn ?? null, opts.endsOn ?? null,
     opts.reason?.trim() || null, opts.userId])
  // Move what can be moved now, rather than waiting for the nightly pack.
  await compressPropertySchedule(unit.property_id).catch(err =>
    logger.error({ err, unitId: opts.unitId }, '[out-of-order] repack failed'))
  await alertStaysOnOutOfOrderSites(unit.property_id)
  return row
}

export async function clearOutOfOrder(opts: { id: string; landlordId: string; userId: string }): Promise<any> {
  const row = await queryOne<any>(
    `UPDATE unit_out_of_order SET cleared_at = NOW(), cleared_by = $3
      WHERE id = $1 AND landlord_id = $2 AND cleared_at IS NULL RETURNING *`,
    [opts.id, opts.landlordId, opts.userId])
  if (!row) throw new AppError(404, 'Not found, or already back in service')
  return row
}

/**
 * Stays still sitting on a site during its out-of-order window — nowhere else
 * fit them, or they can't move (checked in, site already revealed, locked by
 * the landlord, or under a lease). Tells the landlord once per stay per week.
 */
export async function alertStaysOnOutOfOrderSites(propertyId: string): Promise<number> {
  const stuck = await query<any>(
    `SELECT b.id, b.guest_name, to_char(b.check_in, 'YYYY-MM-DD') AS check_in,
            to_char(b.check_out, 'YYYY-MM-DD') AS check_out, u.unit_number, b.landlord_id, l.user_id
       FROM unit_bookings b
       JOIN units u ON u.id = b.unit_id
       JOIN landlords l ON l.id = b.landlord_id
      WHERE u.property_id = $1
        AND b.status NOT IN ('cancelled', 'no_show', 'checked_out')
        AND b.check_out > CURRENT_DATE
        AND unit_out_of_order_overlaps(b.unit_id, b.check_in, b.check_out)
        AND NOT EXISTS (
          SELECT 1 FROM notifications n
           WHERE n.type = 'site_out_of_order_stay' AND n.data->>'bookingId' = b.id::text
             AND n.created_at > NOW() - INTERVAL '7 days')`, [propertyId])
  for (const s of stuck) {
    await createNotification({
      userId: s.user_id, landlordId: s.landlord_id, type: 'site_out_of_order_stay',
      title: `Site ${s.unit_number} is out of order, but ${s.guest_name || 'a guest'} is booked on it`,
      body: `The stay from ${s.check_in} to ${s.check_out} couldn't be moved to another open site. ` +
        'Move it on the schedule, or put the site back in service.',
      data: { bookingId: s.id },
      actionUrl: '/schedule',
    })
  }
  return stuck.length
}

/**
 * S652 (Nic): "When I mark it back in service, is it going to show a history of
 * how long the site was out of order?... keep track of it on the back end so we
 * can say, okay, our average RV sites, when they go down, they're down for a
 * day or 10 days."
 *
 * Nothing is ever deleted from unit_out_of_order — putting a site back in
 * service only stamps cleared_at — so the history was always there; nothing
 * read it. An outage's real end is the EARLIER of its planned end and the day
 * it was put back. One cancelled before it began was never an outage.
 */
export const OOO_EFFECTIVE_END_SQL = `LEAST(o.ends_on, (o.cleared_at AT TIME ZONE COALESCE(p.timezone, 'America/Phoenix'))::date)`
export const OOO_TODAY_SQL = `(NOW() AT TIME ZONE COALESCE(p.timezone, 'America/Phoenix'))::date`

export async function outOfOrderHistoryForUnit(unitId: string): Promise<any[]> {
  return query<any>(
    `SELECT o.id, to_char(o.starts_on, 'YYYY-MM-DD') AS starts_on,
            to_char(${OOO_EFFECTIVE_END_SQL}, 'YYYY-MM-DD') AS ended_on,
            (${OOO_EFFECTIVE_END_SQL} - o.starts_on) AS days_out,
            o.reason, (o.cleared_at IS NOT NULL) AS put_back
       FROM unit_out_of_order o
       JOIN units u ON u.id = o.unit_id
       JOIN properties p ON p.id = u.property_id
      WHERE o.unit_id = $1
        AND ${OOO_EFFECTIVE_END_SQL} IS NOT NULL
        AND ${OOO_EFFECTIVE_END_SQL} >= o.starts_on
        AND ${OOO_EFFECTIVE_END_SQL} <= ${OOO_TODAY_SQL}
      ORDER BY o.starts_on DESC
      LIMIT 50`, [unitId])
}

/**
 * Downtime per property and kind of space: how many outages are over, how long
 * they ran on average, the longest one, and how many spaces are out right now.
 * The average is over FINISHED outages only — a site still out has no length
 * yet, and twenty new sites waiting to be built would otherwise swamp it.
 */
export async function siteDowntimeReport(landlordIds: string[], from: string, to: string): Promise<any[]> {
  return query<any>(
    `WITH w AS (
       SELECT u.property_id, p.name AS property_name, u.unit_type, o.unit_id, o.starts_on,
              ${OOO_EFFECTIVE_END_SQL} AS ended_on,
              ${OOO_TODAY_SQL} AS today
         FROM unit_out_of_order o
         JOIN units u ON u.id = o.unit_id
         JOIN properties p ON p.id = u.property_id
        WHERE u.landlord_id = ANY($1::uuid[])
     )
     SELECT property_id, property_name, unit_type,
            COUNT(*) FILTER (WHERE ended_on IS NOT NULL AND ended_on >= starts_on AND ended_on <= today
                               AND ended_on BETWEEN $2::date AND $3::date)::int AS finished,
            ROUND(AVG(ended_on - starts_on) FILTER (WHERE ended_on IS NOT NULL AND ended_on >= starts_on AND ended_on <= today
                               AND ended_on BETWEEN $2::date AND $3::date), 1)::float AS avg_days,
            MAX(ended_on - starts_on) FILTER (WHERE ended_on IS NOT NULL AND ended_on >= starts_on AND ended_on <= today
                               AND ended_on BETWEEN $2::date AND $3::date)::int AS longest_days,
            COUNT(DISTINCT unit_id) FILTER (WHERE starts_on <= today AND (ended_on IS NULL OR ended_on > today))::int AS out_now,
            MAX(today - starts_on) FILTER (WHERE starts_on <= today AND (ended_on IS NULL OR ended_on > today))::int AS longest_open_days
       FROM w
      GROUP BY 1, 2, 3
     HAVING COUNT(*) FILTER (WHERE ended_on IS NULL OR ended_on >= starts_on) > 0
      ORDER BY 2, 3`, [landlordIds, from, to])
}
