/**
 * S651 — a stay rung up at the counter becomes a booking on the Master Schedule.
 *
 * The register could already sell "RV site — daily". It took the money and
 * stopped: no site assigned, no dates recorded, nothing on the schedule.
 * Somebody was then parked on a site the software believed was empty, which is
 * how two rigs get sold the same spot on a holiday weekend.
 *
 * Nic: "register stays → booking on the schedule."
 *
 * THE PRICE IS THE REGISTER'S. POS is per property and the catalog price is
 * authoritative here exactly as it is for propane. Nothing in this file reads a
 * unit's rate card or re-quotes anything — the booking records what was
 * actually charged at the counter. (I proposed pricing from the unit instead;
 * Nic: "why are you making prices falsely contradict. register price should be
 * its own thing.")
 *
 * WHAT THE CASHIER SUPPLIES is a site, a check-in date, and a name. Everything
 * else is derived: the item says what one unit of quantity buys (a night, a
 * week, a month), so three of "RV site — daily" is three nights and the
 * check-out date follows. Quantity was already the only thing the register lets
 * anybody type, so this adds no new free text to a screen deliberately built
 * without any.
 */
import type { PoolClient } from 'pg'
import { DateTime } from 'luxon'
import { AppError } from '../middleware/errorHandler'

export interface StayLine {
  itemId: string
  qty: number
  /** what one unit of quantity buys */
  stayUnit: 'night' | 'week' | 'month'
  /** the line's total, as charged — never recomputed here */
  lineTotal: number
  name: string
}

export interface StayDetails {
  unitId: string
  checkIn: string
  guestName: string
  guestPhone?: string | null
  guestEmail?: string | null
  notes?: string | null
}

/**
 * When does a stay end, given what was sold?
 *
 * Months are calendar months, not 30 nights: somebody who pays for a month from
 * the 15th of January is there until the 15th of February, and billing,
 * proration and every human involved already treat it that way.
 */
export function checkOutFor(checkIn: string, unit: 'night' | 'week' | 'month', qty: number): string {
  const ci = DateTime.fromISO(checkIn)
  if (!ci.isValid) throw new AppError(400, 'That check-in date is not a date')
  if (!Number.isFinite(qty) || qty <= 0) throw new AppError(400, 'How many nights?')
  const co = unit === 'night' ? ci.plus({ days: qty })
           : unit === 'week'  ? ci.plus({ weeks: qty })
           :                    ci.plus({ months: qty })
  return co.toISODate()!
}

/** Nights the stay covers, for the booking row's own count. */
export function nightsBetween(checkIn: string, checkOut: string): number {
  return Math.round(
    DateTime.fromISO(checkOut).startOf('day')
      .diff(DateTime.fromISO(checkIn).startOf('day'), 'days').days)
}

/**
 * Is this site free for these dates?
 *
 * The SAME three-way test the storefront uses (services/propertyBooking):
 * another booking, a lease, or an out-of-order window. Duplicating any part of
 * it would let the counter sell a site the booking site is holding.
 * (memory: gam-out-of-order-sites)
 */
export async function siteIsFree(
  client: PoolClient, unitId: string, checkIn: string, checkOut: string,
): Promise<boolean> {
  const clash = await client.query(
    `SELECT 1 WHERE
       EXISTS (
         SELECT 1 FROM unit_bookings
          WHERE unit_id=$1 AND status<>'cancelled'
            AND NOT (status='tentative' AND hold_expires_at IS NOT NULL AND hold_expires_at < now())
            AND check_in < $2::date AND check_out > $3::date
       )
       OR EXISTS (
         SELECT 1 FROM leases
          WHERE unit_id=$1 AND status IN ('active','pending')
            AND start_date < $2::date AND (end_date IS NULL OR end_date > $3::date)
       )
       OR unit_out_of_order_overlaps($1, $3::date, $2::date)
     LIMIT 1`,
    [unitId, checkOut, checkIn])
  return clash.rows.length === 0
}

/**
 * Write the booking for a sale that included a stay.
 *
 * Runs inside the sale's own transaction, so a site that turns out to be taken
 * rolls the whole sale back rather than leaving money taken against a stay
 * nobody can have. The advisory lock closes the gap between the free-check and
 * the insert — two cashiers on two terminals selling the last site is not a
 * hypothetical at a park with one road in.
 */
export async function createStayBooking(
  client: PoolClient,
  opts: {
    landlordId: string
    propertyId: string
    posTransactionId: string
    lines: StayLine[]
    details: StayDetails
  },
): Promise<{ bookingId: string; checkIn: string; checkOut: string; nights: number }> {
  const { lines, details } = opts
  if (!lines.length) throw new AppError(400, 'No stay on this sale')
  if (lines.length > 1) {
    // Two different stay items in one sale is a stay whose length depends on
    // which line you read. Refuse it rather than pick one.
    throw new AppError(400,
      'Ring one kind of stay at a time — nights and weeks on the same sale have no single set of dates.')
  }
  const line = lines[0]
  if (!details?.unitId) throw new AppError(400, 'Which site is this stay on?')
  if (!details?.checkIn) throw new AppError(400, 'What date do they arrive?')
  if (!details?.guestName?.trim()) throw new AppError(400, 'Who is the stay for?')

  const checkIn = details.checkIn
  const checkOut = checkOutFor(checkIn, line.stayUnit, line.qty)
  const nights = nightsBetween(checkIn, checkOut)

  // The site has to be this property's, or a cashier could park somebody on
  // another park's spot from a dropdown that should never have offered it.
  const unit = await client.query<{ id: string; property_id: string }>(
    `SELECT id, property_id FROM units WHERE id = $1 AND property_id = $2 AND retired_at IS NULL`,
    [details.unitId, opts.propertyId])
  if (!unit.rows.length) throw new AppError(400, 'That site is not at this property')

  // Serialise everybody selling THIS site, then re-check under the lock.
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`unit-booking:${details.unitId}`])
  if (!await siteIsFree(client, details.unitId, checkIn, checkOut)) {
    throw new AppError(409, 'That site is already taken for those dates — pick another one.')
  }

  const ins = await client.query<{ id: string }>(
    `INSERT INTO unit_bookings
       (unit_id, landlord_id, guest_name, guest_email, guest_phone,
        check_in, check_out, nights, total_amount, status, lease_type,
        source, pos_transaction_id, deposit_paid_at, notes)
     VALUES ($1,$2,$3,$4,$5,$6::date,$7::date,$8,$9,'confirmed',$10,
             'register',$11, NOW(), $12)
     RETURNING id`,
    [details.unitId, opts.landlordId, details.guestName.trim(),
     details.guestEmail?.trim() || null, details.guestPhone?.trim() || null,
     checkIn, checkOut, nights, line.lineTotal,
     // The lease type the stay was SOLD as, so the schedule and the books agree
     // with the item that was rung rather than re-deriving a tier from nights.
     line.stayUnit === 'night' ? 'nightly' : line.stayUnit === 'week' ? 'weekly' : 'monthly',
     opts.posTransactionId, details.notes?.trim() || null])

  return { bookingId: ins.rows[0].id, checkIn, checkOut, nights }
}
