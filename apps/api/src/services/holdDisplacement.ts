/**
 * S652 — what happens when a site somebody is holding, unpaid, is the last one
 * a paying guest could take.
 *
 * Nic set the whole rule in one sentence, asked how long a counter hold should
 * last: "there's no timer for deposit link but if it's not paid and someone
 * else pays it boots them as unconfirmed when there's no other spaces."
 *
 * A TIMER WAS THE OBVIOUS ANSWER AND IT WAS THE WRONG ONE. Every hold-expiry
 * scheme throws away real business for the crime of being slow — a link sent at
 * five on a Friday, read on Monday, and the site is gone. So an unpaid hold has
 * no clock. What it has instead is a rank: it loses to money.
 *
 * "WHEN THERE'S NO OTHER SPACES" IS THE ORDER OF OPERATIONS, and it is the part
 * that is easy to skip. Displacing an unpaid guest is the LAST resort, not the
 * first. If the park has an equivalent site free for their whole stay, they get
 * moved onto it and they are still coming — a fact they never need to learn.
 * Only a genuinely full park costs somebody their reservation, and when that
 * happens a human is told, because that is a phone call, not a notification.
 *
 * WHAT IS NEVER DISPLACED: anything with a deposit paid, anything already
 * checked in, and anything that is not a hold at all. Paid beats unpaid, and
 * nothing here can reach a confirmed stay.
 */
import type { PoolClient } from 'pg'
import { logger } from '../lib/logger'

export interface UnpaidHold {
  id: string
  unit_id: string
  unit_number: string
  guest_name: string | null
  guest_email: string | null
  guest_phone: string | null
  check_in: string
  check_out: string
  required_site_layout: string
  required_amp_service: string
  locked_to_unit: boolean
}

/**
 * The unpaid holds standing between a paying guest and this site.
 *
 * Deliberately narrow: `tentative` AND no deposit paid. A booking that took a
 * deposit is somebody's money and is not a candidate no matter what its status
 * says, which is why the deposit column is tested rather than trusted to the
 * status alone.
 */
export async function unpaidHoldsOn(
  client: PoolClient, unitId: string, checkIn: string, checkOut: string,
): Promise<UnpaidHold[]> {
  const { rows } = await client.query<UnpaidHold>(
    `SELECT b.id, b.unit_id, u.unit_number, b.guest_name, b.guest_email, b.guest_phone,
            b.check_in::text AS check_in, b.check_out::text AS check_out,
            b.required_site_layout, b.required_amp_service, b.locked_to_unit
       FROM unit_bookings b
       JOIN units u ON u.id = b.unit_id
      WHERE b.unit_id = $1
        AND b.status = 'tentative'
        AND b.deposit_paid_at IS NULL
        AND b.displaced_at IS NULL
        AND b.check_in < $3::date AND b.check_out > $2::date
      FOR UPDATE OF b`,
    [unitId, checkIn, checkOut])
  return rows
}

/**
 * Somewhere else this guest could go, free for their WHOLE stay.
 *
 * Matches on what they asked for rather than on what they were given: a guest
 * who needed a 50-amp pull-through is not "accommodated" by being dropped on a
 * 30-amp back-in. A site with no stated requirement matches anything.
 *
 * Excludes sites holding other unpaid reservations too — moving one guest onto
 * another guest's hold just moves the problem, and would cascade.
 */
export async function equivalentSiteFor(
  client: PoolClient, hold: UnpaidHold, excludeUnitIds: string[],
): Promise<{ id: string; unit_number: string } | null> {
  const { rows } = await client.query<{ id: string; unit_number: string }>(
    `SELECT u.id, u.unit_number
       FROM units u
       JOIN units cur ON cur.id = $1
      WHERE u.property_id = cur.property_id
        AND u.id <> ALL($2::uuid[])
        AND u.retired_at IS NULL
        AND u.status = 'vacant'
        AND u.unit_type = cur.unit_type
        AND ($3 = 'none' OR u.rv_site_layout = $3)
        AND ($4 = 'none' OR u.rv_amp_service = $4 OR u.rv_amp_service = 'both')
        AND NOT EXISTS (
          SELECT 1 FROM unit_bookings b
           WHERE b.unit_id = u.id AND b.status <> 'cancelled'
             AND b.check_in < $6::date AND b.check_out > $5::date)
        AND NOT EXISTS (
          SELECT 1 FROM leases l
           WHERE l.unit_id = u.id AND l.status IN ('active','pending')
             AND l.start_date < $6::date AND (l.end_date IS NULL OR l.end_date > $5::date))
        AND NOT unit_out_of_order_overlaps(u.id, $5::date, $6::date)
      ORDER BY u.unit_number
      LIMIT 1`,
    [hold.unit_id, [hold.unit_id, ...excludeUnitIds], hold.required_site_layout,
     hold.required_amp_service, hold.check_in, hold.check_out])
  return rows[0] ?? null
}

export interface DisplacementOutcome {
  holdId: string
  guestName: string | null
  guestEmail: string | null
  guestPhone: string | null
  outcome: 'moved' | 'displaced'
  /** Where they went, when they went anywhere. */
  toUnitId?: string
  toUnitNumber?: string
  fromUnitNumber: string
  /** They had asked to be pinned to that exact site. Worth a human knowing. */
  wasLocked: boolean
}

/**
 * Clear this site's unpaid holds so a paying booking can have it.
 *
 * Call INSIDE the paying booking's own transaction, before writing it. Both
 * halves then commit together: either the payer has the site and the holder has
 * been moved or told, or neither happened.
 *
 * A LOCKED hold is still moved rather than dropped. The lock says "this exact
 * site", which we can no longer honour either way — and between losing the site
 * you wanted and losing the reservation entirely, the first is the smaller
 * injury. It is reported so somebody can ring them.
 */
export async function clearUnpaidHolds(
  client: PoolClient, unitId: string, checkIn: string, checkOut: string,
  reason = 'A paid reservation took this site',
): Promise<DisplacementOutcome[]> {
  const holds = await unpaidHoldsOn(client, unitId, checkIn, checkOut)
  if (!holds.length) return []

  const out: DisplacementOutcome[] = []
  const taken: string[] = []
  for (const hold of holds) {
    const dest = await equivalentSiteFor(client, hold, taken)
    if (dest) {
      taken.push(dest.id)
      await client.query(
        `UPDATE unit_bookings
            SET unit_id = $2, displaced_at = NOW(), displaced_from_unit = $3,
                displaced_reason = $4, updated_at = NOW()
          WHERE id = $1`,
        [hold.id, dest.id, hold.unit_id, `${reason} — moved to ${dest.unit_number}`])
      out.push({
        holdId: hold.id, guestName: hold.guest_name, guestEmail: hold.guest_email,
        guestPhone: hold.guest_phone, outcome: 'moved', toUnitId: dest.id, toUnitNumber: dest.unit_number,
        fromUnitNumber: hold.unit_number, wasLocked: hold.locked_to_unit,
      })
    } else {
      // Nothing free anywhere. They lose the site — recorded, never deleted
      // (standing retention rule), and surfaced so a person makes the call.
      await client.query(
        `UPDATE unit_bookings
            SET status = 'cancelled', displaced_at = NOW(), displaced_from_unit = unit_id,
                displaced_reason = $2, updated_at = NOW()
          WHERE id = $1`,
        [hold.id, `${reason} — the property had nothing else free for those dates`])
      out.push({
        holdId: hold.id, guestName: hold.guest_name, guestEmail: hold.guest_email,
        guestPhone: hold.guest_phone, outcome: 'displaced', fromUnitNumber: hold.unit_number, wasLocked: hold.locked_to_unit,
      })
    }
  }
  logger.warn({ unitId, checkIn, checkOut, outcomes: out },
    '[hold-displacement] an unpaid hold yielded to a paid booking')
  return out
}

/**
 * Tell the people who need to know that a hold lost its site.
 *
 * TWO DIFFERENT PIECES OF NEWS, and collapsing them would be the mistake. A
 * guest who was MOVED is still coming and needs their new site number. A guest
 * who was DISPLACED has no reservation any more, and no email covers that — the
 * landlord gets told plainly so somebody rings them.
 */
export async function notifyDisplacedHolds(
  landlordId: string,
  propertyId: string,
  outcomes: DisplacementOutcome[],
): Promise<void> {
  const { createNotification } = await import('./notifications')
  const { emailBookingSiteChanged } = await import('./email')
  const { queryOne } = await import('../db')
  const prop = await queryOne<{ name: string }>(
    `SELECT name FROM properties WHERE id = $1`, [propertyId])
  const propName = prop?.name ?? 'the property'
  // The notification goes to the account holder — the person who answers for
  // the park when a guest turns up expecting a site they no longer have.
  const owner = await queryOne<{ user_id: string }>(
    `SELECT user_id FROM landlords WHERE id = $1`, [landlordId])
  if (!owner) return

  for (const o of outcomes) {
    const who = o.guestName || 'A guest'
    if (o.outcome === 'moved') {
      await createNotification({
        userId: owner.user_id,
        landlordId,
        type: 'booking_moved',
        title: `${who} moved to site ${o.toUnitNumber}`,
        body: `${who} was holding site ${o.fromUnitNumber} without a deposit and a paid reservation took it. `
          + `They are now on ${o.toUnitNumber}, free for their whole stay.`
          + (o.wasLocked ? ' They had asked to be pinned to the original site — worth a call.' : ''),
      }).catch(() => {})
      if (o.guestEmail) {
        await emailBookingSiteChanged(
          o.guestEmail, o.guestName, propName, o.fromUnitNumber, o.toUnitNumber!, { landlordId },
        ).catch(() => {})
      }
    } else {
      // No email on purpose. "Your reservation is cancelled because somebody
      // else paid" is not a message to receive from a robot at 2am.
      await createNotification({
        userId: owner.user_id,
        landlordId,
        type: 'booking_displaced',
        title: `${who} lost site ${o.fromUnitNumber} — call them`,
        body: `${who} was holding site ${o.fromUnitNumber} without a deposit, a paid reservation took it, `
          + `and ${propName} had nothing else free for those dates. Their reservation is cancelled. `
          + `They have NOT been emailed — this one needs a phone call`
          + (o.guestPhone ? `: ${o.guestPhone}.` : ', and no phone number was taken.'),
      }).catch(() => {})
    }
  }
}
