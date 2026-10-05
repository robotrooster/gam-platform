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
import { computeStayPrice, computeMonthlyStaySchedule } from '@gam/shared'
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

/**
 * The booking's lease_type for what one of quantity buys — one of the values
 * the unit_bookings CHECK allows (nightly, weekly, month_to_month, long_term,
 * lease_hold). A month sold at the counter is a month-to-month stay.
 */
export function bookingLeaseTypeFor(stayUnit: 'night' | 'week' | 'month'): 'nightly' | 'weekly' | 'month_to_month' {
  return stayUnit === 'night' ? 'nightly' : stayUnit === 'week' ? 'weekly' : 'month_to_month'
}

/** Nights the stay covers, for the booking row's own count. */
export function nightsBetween(checkIn: string, checkOut: string): number {
  return Math.round(
    DateTime.fromISO(checkOut).startOf('day')
      .diff(DateTime.fromISO(checkIn).startOf('day'), 'days').days)
}

/**
 * The column on `units` that holds the rate for one of these — the rate the
 * counter's site list shows beside each site (GET /pos/stays/available).
 *
 * 10/3 (decisions #9): what a stay COSTS is never this rate × a quantity; it is
 * the schedule's own pricing for its nights (priceStayBySchedule below), at
 * the counter, on a link and on the schedule alike.
 */
export const STAY_RATE_COLUMN = {
  night: 'nightly_rate',
  week:  'weekly_rate',
  month: 'monthly_rate',
} as const

export type StayUnit = keyof typeof STAY_RATE_COLUMN

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
    /** Null when the money has not been taken yet — a pay link sent, not paid. */
    posTransactionId: string | null
    lines: StayLine[]
    details: StayDetails
    /**
     * S652 — SOLD, or merely SPOKEN FOR.
     *
     * A sale at the counter is 'confirmed' and paid the instant it is rung,
     * which is what this function has always written. A pay link is different:
     * Nic, on stays as inventory — "when I send a pay link, it should use up
     * inventory according to what spot was booked and for how long." The site
     * comes off the board when the link is SENT, because a link sitting unpaid
     * in an inbox while the counter sells the same site to a walk-in is the
     * double booking this whole mechanism exists to prevent.
     *
     * Unpaid means displaceable: no `deposit_paid_at`, no timer, and it yields
     * to anybody who actually pays (services/holdDisplacement).
     */
    status?: 'confirmed' | 'tentative'
    source?: string
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
  // 10/3 (review, fix round 3): the site's row is taken here, BEFORE the site's
  // lock below. The booking written at the end needs it, and a pay link being
  // sent for the site takes the row first and the site second (posPayLinks);
  // taking the site first and the row last left the sale and the link each
  // waiting on the other, and the database ended the sale.
  const unit = await client.query<{ id: string; property_id: string }>(
    `SELECT id, property_id FROM units WHERE id = $1 AND property_id = $2 AND retired_at IS NULL
        FOR KEY SHARE`,
    [details.unitId, opts.propertyId])
  if (!unit.rows.length) throw new AppError(400, 'That site is not at this property')

  // Serialize everybody selling THIS site, then re-check under the lock.
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`unit-booking:${details.unitId}`])
  if (!await siteIsFree(client, details.unitId, checkIn, checkOut)) {
    throw new AppError(409, 'That site is already taken for those dates — pick another one.')
  }

  const ins = await client.query<{ id: string }>(
    // 10/3 (decisions #33): booked_check_out — the length the stay is sold for.
    `INSERT INTO unit_bookings
       (unit_id, landlord_id, guest_name, guest_email, guest_phone,
        check_in, check_out, nights, total_amount, status, lease_type,
        source, pos_transaction_id, deposit_paid_at, notes, booked_check_out)
     VALUES ($1,$2,$3,$4,$5,$6::date,$7::date,$8,$9,$13,$10,
             $14,$11, CASE WHEN $13 = 'confirmed' THEN NOW() ELSE NULL END, $12, $7::date)
     RETURNING id`,
    [details.unitId, opts.landlordId, details.guestName.trim(),
     details.guestEmail?.trim() || null, details.guestPhone?.trim() || null,
     checkIn, checkOut, nights, line.lineTotal,
     // The lease type the stay was SOLD as, so the schedule and the books agree
     // with the item that was rung rather than re-deriving a tier from nights.
     // 10/2 (review): a month is 'month_to_month' — the bookings CHECK knows no
     // 'monthly', and every month stay rung at the register failed on it.
     bookingLeaseTypeFor(line.stayUnit),
     opts.posTransactionId, details.notes?.trim() || null,
     opts.status ?? 'confirmed', opts.source ?? 'register'])

  return { bookingId: ins.rows[0].id, checkIn, checkOut, nights }
}

/**
 * 10/2 (decisions #9) — WHAT A RESERVATION STILL OWES.
 *
 * "One price, and it is the site's" (Nic, S652): the reservation was quoted
 * once, on the schedule or the booking site, and that quote — unit_bookings
 * .total_amount, its tax already in it — is what it costs. The register never
 * re-prices it per item (an item's rate × a quantity rounded to weeks charged
 * a ten-night stay as one week). What is left to pay is that price less what
 * was paid ahead of arrival:
 *   - the balance stamped paid (balance_paid_at) — nothing is left;
 *   - a deposit stamped paid — its amount (deposit_amount). A deposit stamped
 *     paid with no amount on record is a stay that was paid whole (the counter
 *     and a stay link write it that way), so nothing is left either.
 *
 * 10/3 (decisions #15) — A RESERVATION THAT BECOMES A LEASE IS NEVER CHARGED
 * WHOLE AT THE REGISTER. A stay at or over the lease threshold (30 nights, or 7
 * at a weekly-lease park — services/bookingLeaseDraft) drafts a lease, and the
 * lease bills the stay: the arrival month on arrival day, monthly after that
 * (services/bookingLeaseBilling). The register takes only what is due NOW — the
 * deposit the booking site would have asked for the same stay
 * (services/propertyBooking depositForStay), or the one already on the
 * reservation — and the lease bills the rest. Taking the whole quote here as
 * well billed the stay twice the moment the lease was signed. `owed` is then
 * what the register may still take (the deposit, less what was paid toward it)
 * and `leaseBillsRest` says so. Only a reservation a lease bills counts: one
 * with a lease drafted from it, or one the schedule or the booking site made
 * (they draft one at that length). A stay the register sold itself (source
 * 'register') drafts no lease, so it is charged whole as before.
 */
export interface ReservationDue {
  bookingId: string
  status: string
  unitId: string | null
  unitNumber: string | null
  checkIn: string
  /** The stored check-out — the day the guest leaves (or left, after an early check-out). */
  checkOut: string
  /** Nights on the site: check-in to the stored check-out (occupancy). */
  nights: number
  /**
   * 10/3 (decisions #33): the check-out the stay was SOLD for
   * (soldCheckOutSql). An early check-out moves the stored check-out only;
   * the price, its tax, the lease threshold and the deposit all go by this.
   */
  bookedCheckOut: string
  /** Nights the stay was sold for: check-in to bookedCheckOut. Tax and the lease threshold read this, never `nights`. */
  bookedNights: number
  /** The reservation's own quoted price. */
  total: number
  /** Paid ahead of today. */
  paid: number
  /** What is left for the register to take (for a stay its lease bills: what is left of the deposit). */
  owed: number
  /** A price was quoted and nothing is left for the register to take. */
  paidInFull: boolean
  /** Cancelled, or a no-show: not something to take money for. */
  closed: boolean
  /**
   * Its site went to a guest who paid first (holdDisplacement) — as opposed to
   * cancelled on the schedule. 10/3 (review): only a hold that lost its site
   * and was left with none (displaced_from_unit is still its own site); a hold
   * that was MOVED and later cancelled on the schedule was cancelled there.
   */
  displaced: boolean
  /** No price was ever quoted on it — it has to be set on the schedule. */
  noPrice: boolean
  /** The pay link this booking's arrival-day balance went out on, if any. */
  balancePayLinkId: string | null
  /** decisions #15: a long stay — its lease bills the stay; the register takes only the deposit. */
  leaseBillsRest: boolean
  /** decisions #15: the deposit due now on a long stay (null for any other). */
  depositDue: number | null
  /**
   * 10/3 (decisions #21): the property's short-term lodging tax, as a percent
   * (properties.short_term_tax_rate) — the rate the schedule prices a stay
   * under 30 nights with (computeStayPrice). Its price has the tax in it; a
   * sale that takes it records that part as tax (stayTaxRate, taxInside).
   */
  taxPct: number
  /** The stay's own rates (the site's, else the property's) — for working out the tax rate inside its price (stayTaxRate). */
  rates: { nightly: number | null; weekly: number | null; monthly: number | null }
}

/**
 * 10/3 (decisions #33) — THE CHECK-OUT A STAY WAS SOLD FOR, as SQL, for a
 * unit_bookings alias. The schedule keeps it in booked_check_out (set when the
 * reservation is made and on every deliberate change of its dates); an early
 * check-out moves only check_out, which can then be EARLIER than it. A path
 * that lengthens a stay without setting the column (the guest agent's extra
 * night) can only make check_out LATER — so the later of the two is the length
 * sold, and an empty column reads as check_out. Price, tax, the lease
 * threshold, the deposit and GAM's short-stay revenue split all read this.
 */
export const soldCheckOutSql = (b: string): string =>
  `GREATEST(COALESCE(${b}.booked_check_out, ${b}.check_out), ${b}.check_out)`

/** The lease threshold for a property: 30 nights, or 7 when it runs weekly leases (services/bookingLeaseDraft). */
export const leaseThresholdNights = (weeklyLeaseMode: boolean | null | undefined): number => (weeklyLeaseMode ? 7 : 30)

export async function reservationDue(
  q: Pick<PoolClient, 'query'>, bookingId: string, opts: { lock?: boolean } = {},
): Promise<ReservationDue | null> {
  if (!/^[0-9a-f-]{36}$/i.test(String(bookingId ?? ''))) return null
  const r = (await q.query<any>(
    `SELECT b.id, b.status, b.unit_id, u.unit_number, b.source,
            to_char(b.check_in, 'YYYY-MM-DD') AS check_in, to_char(b.check_out, 'YYYY-MM-DD') AS check_out,
            to_char(${soldCheckOutSql('b')}, 'YYYY-MM-DD') AS booked_check_out,
            COALESCE(b.total_amount, 0)::float AS total, b.deposit_amount::float AS deposit_amount,
            (b.deposit_paid_at IS NOT NULL) AS deposit_paid, (b.balance_paid_at IS NOT NULL) AS balance_paid,
            (b.displaced_at IS NOT NULL AND b.displaced_from_unit IS NOT DISTINCT FROM b.unit_id) AS displaced,
            b.balance_pay_link_id,
            COALESCE(p.weekly_lease_mode, FALSE) AS weekly_lease_mode,
            p.booking_deposit_pct, p.booking_monthly_deposit, p.short_term_tax_rate,
            COALESCE(u.nightly_rate, p.nightly_rate)::float AS nightly_rate,
            COALESCE(u.weekly_rate, p.weekly_rate)::float AS weekly_rate,
            COALESCE(u.monthly_rate, p.monthly_rate)::float AS monthly_rate,
            EXISTS (SELECT 1 FROM leases l WHERE l.source_booking_id = b.id AND l.status <> 'cancelled') AS has_lease
       FROM unit_bookings b
       LEFT JOIN units u ON u.id = b.unit_id
       LEFT JOIN properties p ON p.id = u.property_id
      WHERE b.id = $1${opts.lock ? ' FOR UPDATE OF b' : ''}`, [bookingId])).rows[0]
  if (!r) return null
  const round = (n: number) => Math.round(n * 100) / 100
  const total = round(Number(r.total) || 0)
  const nights = nightsBetween(r.check_in, r.check_out)
  // 10/3 (decisions #33): the length it was SOLD for. An early check-out moves
  // the stored check-out only — it never turns a long stay into a short one
  // here (the counter asking for the whole price of a stay its lease bills),
  // nor an untaxed price into a taxed one (stayTaxRate on `bookedNights`).
  const bookedNights = nightsBetween(r.check_in, r.booked_check_out)
  // decisions #15: a stay its lease bills — one a lease was drafted from (the
  // same test the arrival-day run uses to leave it alone, services/stayBalance),
  // or one at or over the threshold that the schedule or the booking site made
  // (they draft its lease as it is made).
  const leaseBillsRest = total > 0 && (r.has_lease === true
    || (bookedNights >= leaseThresholdNights(r.weekly_lease_mode) && (r.source ?? 'direct') !== 'register'))
  let depositDue: number | null = null
  if (leaseBillsRest) {
    if (r.deposit_amount != null) {
      depositDue = round(Number(r.deposit_amount) || 0)
    } else {
      // The deposit the booking site quotes for the same nights on the same site.
      const { depositForStay } = await import('./propertyBooking')
      const price = computeStayPrice(
        { nightly: r.nightly_rate, weekly: r.weekly_rate, monthly: r.monthly_rate },
        Number(r.short_term_tax_rate || 0), bookedNights)
      depositDue = depositForStay(
        { booking_deposit_pct: r.booking_deposit_pct ?? 0, booking_monthly_deposit: r.booking_monthly_deposit },
        { tier: price.tier, total, monthlyRate: r.monthly_rate ?? null })
    }
    depositDue = Math.min(total, Math.max(0, depositDue))
  }
  const paid = r.balance_paid ? total
    : r.deposit_paid ? Math.min(total, r.deposit_amount == null ? total : round(Number(r.deposit_amount) || 0))
    : 0
  const owed = leaseBillsRest
    ? round(Math.max(0, (depositDue ?? 0) - paid))
    : round(Math.max(0, total - paid))
  return {
    bookingId: r.id, status: r.status, unitId: r.unit_id ?? null, unitNumber: r.unit_number ?? null,
    checkIn: r.check_in, checkOut: r.check_out, nights,
    bookedCheckOut: r.booked_check_out, bookedNights,
    total, paid: round(paid), owed,
    paidInFull: total > 0 && owed < 0.005,
    closed: r.status === 'cancelled' || r.status === 'no_show',
    displaced: r.displaced === true,
    noPrice: !(total > 0),
    balancePayLinkId: r.balance_pay_link_id ?? null,
    leaseBillsRest,
    depositDue,
    taxPct: Number(r.short_term_tax_rate || 0),
    rates: { nightly: r.nightly_rate ?? null, weekly: r.weekly_rate ?? null, monthly: r.monthly_rate ?? null },
  }
}

/**
 * 10/3 (decisions #21) — THE TAX INSIDE A STAY'S PRICE.
 *
 * The schedule prices a stay with computeStayPrice: the site's rates (else the
 * property's), tiered by length, plus the property's short-term lodging tax on
 * a stay under 30 nights; a monthly-tier stay is priced on the calendar
 * schedule (computeMonthlyStaySchedule), untaxed. So the rate a stay's price
 * carries is the lodging tax for a nightly- or weekly-tier stay under 30
 * nights, and nothing otherwise. Returned as a fraction (0.12 for 12%).
 */
export function stayTaxRate(rates: { nightly: number | null; weekly: number | null; monthly: number | null },
                            taxPct: number, nights: number): number {
  if (!(taxPct > 0) || !(nights > 0) || nights >= 30) return 0
  const price = computeStayPrice({ nightly: rates.nightly, weekly: rates.weekly, monthly: rates.monthly }, taxPct, nights)
  return price.tier === 'monthly' ? 0 : taxPct / 100
}

/** How much of an amount that has its tax in it (at `rate`, a fraction) is that tax — to the cent. */
export function taxInside(amount: number, rate: number): number {
  if (!(rate > 0) || !(amount > 0)) return 0
  return Math.round(amount * rate / (1 + rate) * 100) / 100
}

/**
 * 10/3 (decisions #21, review) — THE TAX INSIDE ONE PAYMENT TOWARD A STAY.
 *
 * A stay is often paid in parts — a deposit when it is booked, the balance on
 * arrival — and each part is its own sale. Each records its share of the tax
 * inside the stay's price: what the tax inside everything paid so far comes to
 * now, less what it came to before this payment. So the parts always add up to
 * the tax inside the whole, to the cent, whichever door took each one (the
 * counter, a link paid online, the reservation's ticket). `rate` a fraction.
 */
export function taxInsidePayment(paidBefore: number, amount: number, rate: number): number {
  if (!(rate > 0) || !(amount > 0)) return 0
  const before = Math.max(0, Number(paidBefore) || 0)
  return Math.max(0, Math.round((taxInside(before + amount, rate) - taxInside(before, rate)) * 100) / 100)
}

/**
 * 10/3 (decisions #9, #21) — what a stay costs by the schedule's own pricing,
 * from the rates it is priced from (the site's, else the property's) and the
 * property's short-term lodging tax (a percent): computeStayPrice tiers by
 * length (nightly, weekly, monthly) and adds the tax under 30 nights; a
 * monthly-tier stay prices on the calendar-aligned schedule
 * (computeMonthlyStaySchedule), untaxed. `total` is 0 when no rate prices it.
 * One function, so the schedule, a pay link, the counter and the register's
 * site list cannot price the same nights two ways.
 */
export function scheduleStayPrice(
  rates: { nightly: number | string | null; weekly: number | string | null; monthly: number | string | null },
  taxPct: number | string | null, checkIn: string, checkOut: string,
): { total: number; base: number; tax: number; taxRate: number; nights: number; tier: 'nightly' | 'weekly' | 'monthly' } {
  const num = (x: number | string | null) => (x == null || x === '' ? null : Number(x))
  const nights = nightsBetween(checkIn, checkOut)
  const monthlyRate = num(rates.monthly)
  const pct = Number(taxPct || 0)
  const price = computeStayPrice({ nightly: num(rates.nightly), weekly: num(rates.weekly), monthly: monthlyRate }, pct, nights)
  const onSchedule = price.tier === 'monthly' && monthlyRate != null
  const total = onSchedule ? computeMonthlyStaySchedule(checkIn, checkOut, monthlyRate!).total : price.total
  // 10/3 (decisions #21): the tax in the price, exactly as the schedule added it.
  const tax = onSchedule || !(total > 0) ? 0 : price.tax
  const taxRate = tax > 0 ? pct / 100 : 0
  return { total: total > 0 ? total : 0, base: Math.round(((total > 0 ? total : 0) - tax) * 100) / 100, tax, taxRate, nights, tier: price.tier }
}

/**
 * 10/3 (decisions #9, #21) — what a NEW stay costs by the SAME pricing the
 * schedule uses (routes/units PATCH bookings): the site's rates, else the
 * property's; computeStayPrice tiers by length (nightly, weekly, monthly) and
 * adds the property's short-term tax; a monthly-tier stay prices on the
 * calendar-aligned schedule (computeMonthlyStaySchedule). Used when a link for
 * a stay is sent and when a stay is rung straight at the counter — never an
 * item's rate × nights. (decisions #23: a reservation already on the schedule
 * is never repriced here — it is charged what it owes, reservationDue.)
 * Refuses (in the clerk's words) a site with no rate to price it from.
 */
export async function priceStayBySchedule(
  q: Pick<PoolClient, 'query'>, unitId: string, checkIn: string, checkOut: string,
  /** What the clerk is told when the site has no rate (default: plain words with the next step). */
  noRateWords?: (unitNumber: string) => string,
): Promise<{ total: number; base: number; tax: number; taxRate: number; nights: number; tier: 'nightly' | 'weekly' | 'monthly'; unitNumber: string }> {
  const u = (await q.query<any>(
    `SELECT u.unit_number,
            COALESCE(u.nightly_rate, p.nightly_rate) AS nightly_rate,
            COALESCE(u.weekly_rate, p.weekly_rate) AS weekly_rate,
            COALESCE(u.monthly_rate, p.monthly_rate) AS monthly_rate,
            p.short_term_tax_rate
       FROM units u JOIN properties p ON p.id = u.property_id WHERE u.id = $1`, [unitId])).rows[0]
  if (!u) throw new AppError(404, 'That site is not on this account any more — look the reservation up on the schedule.')
  const priced = scheduleStayPrice({ nightly: u.nightly_rate, weekly: u.weekly_rate, monthly: u.monthly_rate },
    u.short_term_tax_rate, checkIn, checkOut)
  if (!(priced.total > 0)) {
    throw new AppError(409, noRateWords ? noRateWords(u.unit_number)
      : `Site ${u.unit_number} has no stay rate set, so this stay cannot be priced — nothing was changed. `
        + 'Set the site\'s nightly rate (or the property\'s), then try again.')
  }
  return { ...priced, unitNumber: u.unit_number }
}

/**
 * 10/3 (review) — A RESERVATION THAT IS OVER LEAVES THE REST OF ITS TICKET
 * OWED.
 *
 * A reservation ticket can carry more than its stay: a tank of propane the
 * clerk added and held with Clear. When the reservation is over — cancelled,
 * marked a no-show, its site lost to a guest who paid first, or paid in full
 * some other way — the stay comes off the ticket and the ticket stays OPEN
 * with what is left on it, Void button and all: the $20 of propane is still
 * owed, and voiding the whole ticket made it owed nowhere (not on the
 * register, not on Outstanding Balances). A ticket whose stay was its only
 * line has nothing left to take and is voided, with the reason. Kept, never
 * deleted. The ticket keeps naming the booking (a ticket must name someone or
 * something — the booking is who a walk-in's ticket is for); with no stay line
 * left on it, it is an ordinary ticket from then on (ticketCarriesStay).
 */
export async function releaseReservationTickets(
  q: Pick<PoolClient, 'query'>, bookingId: string, reason: string,
  opts: { exceptTicketId?: string | null; onlyTicketId?: string | null } = {},
): Promise<{ voided: string[]; kept: string[] }> {
  const tickets = (await q.query<{ id: string; landlord_id: string; items: any }>(
    `SELECT id, landlord_id, items FROM pos_open_tickets
      WHERE booking_id = $1 AND status = 'open' AND id IS DISTINCT FROM $2
        AND ($3::uuid IS NULL OR id = $3::uuid)
      FOR UPDATE`, [bookingId, opts.exceptTicketId ?? null, opts.onlyTicketId ?? null])).rows
  const out = { voided: [] as string[], kept: [] as string[] }
  for (const t of tickets) {
    const items = Array.isArray(t.items) ? t.items : []
    const stays = await stayItemIdsIn(q, t.landlord_id, items)
    const rest = items.filter((i: any) => !stays.has(lowerItemId(i?.id)))
    if (!rest.length) {
      await q.query(
        `UPDATE pos_open_tickets SET status = 'voided', voided_at = NOW(), updated_at = NOW(), void_reason = $2
          WHERE id = $1 AND status = 'open'`, [t.id, reason])
      out.voided.push(t.id)
    } else {
      await q.query(
        `UPDATE pos_open_tickets
            SET items = $2::jsonb, updated_at = NOW(),
                note = TRIM(BOTH ' ·' FROM COALESCE(note, '') || ' · ' || $3)
          WHERE id = $1 AND status = 'open'`,
        [t.id, JSON.stringify(rest), `${reason} — its stay was taken off this ticket; the rest is still owed`])
      out.kept.push(t.id)
    }
  }
  return out
}

/** A register item id as the database writes it (lowercase), or '' for none. */
const lowerItemId = (x: unknown): string => (typeof x === 'string' ? x.trim().toLowerCase() : '')

/** Which of these lines' register items are stays (pos_items.stay_unit), by id. */
export async function stayItemIdsIn(q: Pick<PoolClient, 'query'>, landlordId: string, items: any[]): Promise<Set<string>> {
  const ids = [...new Set((Array.isArray(items) ? items : []).map((i: any) => lowerItemId(i?.id)).filter((x) => /^[0-9a-f-]{36}$/.test(x)))]
  if (!ids.length) return new Set()
  const rows = (await q.query<{ id: string }>(
    `SELECT id FROM pos_items WHERE id = ANY($1::uuid[]) AND landlord_id = $2 AND stay_unit IS NOT NULL`, [ids, landlordId])).rows
  return new Set(rows.map((r) => r.id))
}

/** A ticket that still carries a stay line — a reservation ticket is one only while it does (releaseReservationTickets). */
export async function ticketCarriesStay(q: Pick<PoolClient, 'query'>, t: { landlord_id: string; items: any }): Promise<boolean> {
  return (await stayItemIdsIn(q, t.landlord_id, Array.isArray(t.items) ? t.items : [])).size > 0
}
