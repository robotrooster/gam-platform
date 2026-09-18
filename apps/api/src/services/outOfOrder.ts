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
