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
 * THE PRICE IS THE UNIT'S, AND THERE IS ONLY ONE OF THEM.
 *
 * Nic, S652, after this file had it backwards: "There's no variation allowed in
 * terms of charging one price in the booking flow and one price if they come in
 * and get it on the POS and one price if they do whatever. It's all the same.
 * It's based on the unit." The property's rates live on its units — site 5 is a
 * back-in at $40 a night, site 6 a pull-through at $42 — and the register and
 * the booking site both read them. A signed lease is the only thing that
 * supersedes a unit's rate, and only for that unit.
 *
 * The catalog price on a stay item is therefore NOT what a stay costs. The item
 * is the button and it says what one of quantity buys; the site says what it
 * costs. Which is why an earlier draft's story — that a catalog price and a
 * rate card were two legitimately different numbers — did not survive contact
 * with the data: Mountain View's units said $269 a week while its register item
 * said $250, and nobody could have told you which one a guest owed.
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
 * The column on `units` that holds the rate for one of these.
 *
 * One map, exported, so that every surface that prices a stay — the register,
 * the booking site, the counter's availability list — is reading the same
 * three columns rather than each deciding for itself which one applies.
 */
export const STAY_RATE_COLUMN = {
  night: 'nightly_rate',
  week:  'weekly_rate',
  month: 'monthly_rate',
} as const

export type StayUnit = keyof typeof STAY_RATE_COLUMN

/** What one night/week/month on this site costs, or null when nobody set it. */
export function rateForStay(
  unit: { nightly_rate?: any; weekly_rate?: any; monthly_rate?: any } | null | undefined,
  stayUnit: StayUnit,
): number | null {
  if (!unit) return null
  const raw = (unit as any)[STAY_RATE_COLUMN[stayUnit]]
  if (raw === null || raw === undefined || raw === '') return null
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null
}

/** "a weekly rate" — for saying which one is missing, in words a person uses. */
export function stayRateLabel(stayUnit: StayUnit): string {
  return stayUnit === 'night' ? 'a nightly rate'
       : stayUnit === 'week'  ? 'a weekly rate'
       :                        'a monthly rate'
}

/**
 * Price a stay from the site it is on.
 *
 * THE SITE FIRST, THEN THE PROPERTY — the same order, and the same two places,
 * the booking site already quotes from (services/propertyBookingQuote: `rep
 * .nightly_rate ?? prop.nightly_rate`). A site may be worth more or less than
 * its neighbours and carries its own number; the property's rate is what the
 * rest of the sites cost. If the register consulted only the unit, a property
 * that prices at the property level would sell on the booking site and be
 * refused at the counter — the identical split this whole change exists to
 * close, rebuilt one layer down.
 *
 * Throws rather than falling back to the catalog price. No rate in either place
 * is a setup mistake somebody has to fix, and quietly charging a different
 * number instead is how the prices got out of step in the first place.
 */
export async function priceStayFromUnit(
  /** A rows-returning query — `db.query`, or a PoolClient wrapped to match. */
  q: (sql: string, params: any[]) => Promise<any[]>,
  unitId: string,
  landlordId: string,
  stayUnit: StayUnit,
  qty: number,
): Promise<{ rate: number; lineTotal: number; unitNumber: string; from: 'site' | 'property' }> {
  const rows = await q(
    `SELECT u.unit_number, u.nightly_rate, u.weekly_rate, u.monthly_rate,
            p.nightly_rate AS p_nightly_rate, p.weekly_rate AS p_weekly_rate,
            p.monthly_rate AS p_monthly_rate
       FROM units u JOIN properties p ON p.id = u.property_id
      WHERE u.id = $1 AND u.landlord_id = $2`,
    [unitId, landlordId])
  const u = rows[0]
  if (!u) throw new AppError(404, 'That site is not one of yours')
  const own = rateForStay(u, stayUnit)
  const fallback = rateForStay({
    nightly_rate: u.p_nightly_rate, weekly_rate: u.p_weekly_rate, monthly_rate: u.p_monthly_rate,
  }, stayUnit)
  const rate = own ?? fallback
  if (rate === null) {
    throw new AppError(409,
      `Site ${u.unit_number} has no ${stayRateLabel(stayUnit).replace(/^a /, '')} set, and neither does the property. `
      + 'Set it and it will be the price everywhere — the counter, the booking site, both.')
  }
  return {
    rate,
    lineTotal: Math.round(rate * qty * 100) / 100,
    unitNumber: u.unit_number,
    from: own !== null ? 'site' : 'property',
  }
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
