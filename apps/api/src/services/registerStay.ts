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
import { computeStayPrice, computeMonthlyStaySchedule, longCalendarDate, type StayTerms } from '@gam/shared'
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
    /**
     * 10/5 (Nic, R2): the counter's answer for a 30+ night stay — 'lease' or
     * 'stay' (no lease). Null under 30 nights. The lease itself is drafted by
     * services/stayTerms (chooseStayTerms) once the sale has committed.
     */
    stayTerms?: StayTerms | null
    /** The resident the sale names, so their back-to-back stays add up (R7). */
    tenantId?: string | null
    /** 10/5 (Nic, R1/R9): a stay of 22+ continuous nights — check-in waits on its background check. */
    screeningRequired?: boolean
    /**
     * 10/5: a stay its LEASE bills (stayTerms 'lease') is paid only its
     * deposit at the counter — recorded as the deposit, never as the stay paid
     * in full (reservationDue: the lease bills the rest).
     */
    depositAmount?: number | null
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
        source, pos_transaction_id, deposit_paid_at, notes, booked_check_out,
        stay_terms, tenant_id, screening_required, deposit_amount)
     VALUES ($1,$2,$3,$4,$5,$6::date,$7::date,$8,$9,$13,$10,
             $14,$11, CASE WHEN $13 = 'confirmed' THEN NOW() ELSE NULL END, $12, $7::date,
             $15, $16, $17, $18)
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
     opts.status ?? 'confirmed', opts.source ?? 'register',
     opts.stayTerms ?? null, opts.tenantId ?? null, opts.screeningRequired === true,
     opts.depositAmount != null ? Math.round(opts.depositAmount * 100) / 100 : null])

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
 * WHOLE AT THE REGISTER. The lease bills the stay: the arrival month on
 * arrival day, monthly after that (services/bookingLeaseBilling). The register
 * takes only what is due NOW — the deposit the booking site would have asked
 * for the same stay (services/propertyBooking depositForStay), or the one
 * already on the reservation — and the lease bills the rest. Taking the whole
 * quote here as well billed the stay twice the moment the lease was signed.
 * `owed` is then what the register may still take (the deposit, less what was
 * paid toward it) and `leaseBillsRest` says so.
 *
 * 10/5 (Nic, R3/R14): a lease bills a stay ONLY when one was chosen — a lease
 * drafted from it, or the guest's (or the counter's) answer 'lease'
 * (stay_terms). Length alone never makes a lease any more ("the stay only
 * guarantees it for the time that you've paid ahead of time"), so a 30+ night
 * stay with no lease is owed whole, wherever it was made, and a park's
 * weekly-lease setting no longer moves anything.
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

/**
 * The deposit the booking site quotes for the same nights on the same site
 * (services/propertyBooking depositForStay) — what a stay its lease bills is
 * paid at the register. `p` carries the property's deposit settings and the
 * stay's rates (the site's, else the property's).
 */
async function longStayDeposit(p: {
  booking_deposit_pct: string | number | null; booking_monthly_deposit: string | number | null
  short_term_tax_rate: string | number | null
  nightly_rate: number | null; weekly_rate: number | null; monthly_rate: number | null
}, total: number, nights: number): Promise<number> {
  const { depositForStay } = await import('./propertyBooking')
  const price = computeStayPrice(
    { nightly: p.nightly_rate, weekly: p.weekly_rate, monthly: p.monthly_rate },
    Number(p.short_term_tax_rate || 0), nights)
  return depositForStay(
    { booking_deposit_pct: p.booking_deposit_pct ?? 0, booking_monthly_deposit: p.booking_monthly_deposit },
    { tier: price.tier, total, monthlyRate: p.monthly_rate ?? null })
}

/**
 * 10/5 (Nic, R2/R4): the deposit a NEW stay its lease will bill is paid at the
 * counter (or on its link) — the same deposit reservationDue asks of a stay a
 * lease bills (longStayDeposit), from the site's rates and the property's
 * deposit settings. Never more than the stay's own price.
 */
export async function leaseDepositFor(q: Pick<PoolClient, 'query'>, unitId: string, total: number, nights: number): Promise<number> {
  const r = (await q.query<any>(
    `SELECT p.booking_deposit_pct, p.booking_monthly_deposit, p.short_term_tax_rate,
            COALESCE(u.nightly_rate, p.nightly_rate)::float AS nightly_rate,
            COALESCE(u.weekly_rate, p.weekly_rate)::float AS weekly_rate,
            COALESCE(u.monthly_rate, p.monthly_rate)::float AS monthly_rate
       FROM units u JOIN properties p ON p.id = u.property_id WHERE u.id = $1`, [unitId])).rows[0]
  if (!r) return 0
  const d = await longStayDeposit(r, total, nights)
  return Math.round(Math.min(total, Math.max(0, d)) * 100) / 100
}

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
            b.balance_pay_link_id, b.stay_terms,
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
  // or one whose lease was chosen (10/5, R2: stay_terms 'lease' — its draft
  // follows the sale that chose it).
  const leaseBillsRest = total > 0 && (r.has_lease === true || r.stay_terms === 'lease')
  let depositDue: number | null = null
  if (leaseBillsRest) {
    depositDue = r.deposit_amount != null
      ? round(Number(r.deposit_amount) || 0)
      : await longStayDeposit(r, total, bookedNights)
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

// ── 10/5 (Nic, R5): THE REGISTER NEVER PRORATES A STAY ───────────────────

/**
 * 10/5 (Nic, R8): the name the background check's fee goes by on a register
 * sale, a pay link, the card page and the receipt — its own line, added by the
 * server only, that the clerk cannot take off.
 */
export const SCREENING_LINE_NAME = 'Background check (required for a stay over three weeks)'

const round2 = (n: number) => Math.round(n * 100) / 100

/** The pricing tier one of each is sold at. */
const TIER_OF: Record<StayUnit, 'nightly' | 'weekly' | 'monthly'> = { night: 'nightly', week: 'weekly', month: 'monthly' }
/** "nightly", "weekly", "monthly" — the rate a stay of these is sold at, in the clerk's words. */
export const STAY_RATE_WORD: Record<StayUnit, string> = { night: 'nightly', week: 'weekly', month: 'monthly' }

export interface WholeStayPrice {
  total: number; base: number; tax: number; taxRate: number; nights: number
  tier: 'nightly' | 'weekly' | 'monthly'
  /** The rate one of these is sold at (the site's, else the property's); null when neither has one. */
  rate: number | null
  checkOut: string
}

/**
 * 10/5 (Nic, R5) — "point of sale cannot prorate a stay." The register (and a
 * link sent from it) sells a stay in WHOLE nights, weeks or months, each at the
 * rate for what one of them is: three nights are three times the nightly rate,
 * two weeks twice the weekly rate, a month the monthly rate — never a month cut
 * into calendar pieces, never a week priced as nights. The rate is the site's,
 * else the property's ("one price, and it is the site's", S652). The
 * property's short-term lodging tax is added to nights and weeks under 30
 * nights (decisions #21); a month is the monthly tier and is never taxed.
 * Prorating belongs to a lease, by the property's rent-due setting (R4).
 * `total` is 0 (and `rate` null) when nothing prices one of these.
 */
export function wholeStayPrice(
  rates: { nightly: number | string | null; weekly: number | string | null; monthly: number | string | null },
  taxPct: number | string | null, stayUnit: StayUnit, qty: number, checkIn: string,
): WholeStayPrice {
  const checkOut = checkOutFor(checkIn, stayUnit, qty)
  const nights = nightsBetween(checkIn, checkOut)
  const tier = TIER_OF[stayUnit]
  const raw = stayUnit === 'night' ? rates.nightly : stayUnit === 'week' ? rates.weekly : rates.monthly
  const rate = raw == null || raw === '' ? null : Number(raw)
  if (rate == null || !(rate > 0)) return { total: 0, base: 0, tax: 0, taxRate: 0, nights, tier, rate: null, checkOut }
  const base = round2(rate * qty)
  const pct = Number(taxPct || 0)
  const taxRate = stayUnit !== 'month' && nights < 30 && pct > 0 ? pct / 100 : 0
  const tax = round2(base * taxRate)
  return { total: round2(base + tax), base, tax, taxRate, nights, tier, rate, checkOut }
}

/** The site's rates (else the property's) and the property's lodging tax, read once. */
async function siteRates(q: Pick<PoolClient, 'query'>, unitId: string): Promise<{
  unit_number: string; nightly_rate: number | null; weekly_rate: number | null; monthly_rate: number | null
  short_term_tax_rate: number | null; property_id: string
} | null> {
  return (await q.query<any>(
    `SELECT COALESCE(NULLIF(u.display_label, ''), u.unit_number) AS unit_number, u.property_id,
            COALESCE(u.nightly_rate, p.nightly_rate)::float AS nightly_rate,
            COALESCE(u.weekly_rate, p.weekly_rate)::float AS weekly_rate,
            COALESCE(u.monthly_rate, p.monthly_rate)::float AS monthly_rate,
            p.short_term_tax_rate::float AS short_term_tax_rate
       FROM units u JOIN properties p ON p.id = u.property_id WHERE u.id = $1`, [unitId])).rows[0] ?? null
}

/**
 * wholeStayPrice for a site, read from the database. Refuses (in the clerk's
 * words — `noRateWords`, or "nothing was charged" by default) a site that has
 * no rate for what one of these is.
 */
export async function priceWholeStay(
  q: Pick<PoolClient, 'query'>, unitId: string, stayUnit: StayUnit, qty: number, checkIn: string,
  noRateWords?: (unitNumber: string, rateWord: string) => string,
): Promise<WholeStayPrice & { unitNumber: string }> {
  const u = await siteRates(q, unitId)
  if (!u) throw new AppError(404, 'That site is not on this account any more — pick the site again.')
  const priced = wholeStayPrice({ nightly: u.nightly_rate, weekly: u.weekly_rate, monthly: u.monthly_rate },
    u.short_term_tax_rate, stayUnit, qty, checkIn)
  if (!(priced.total > 0)) {
    const word = STAY_RATE_WORD[stayUnit]
    throw new AppError(409, noRateWords ? noRateWords(u.unit_number, word)
      : `Site ${u.unit_number} has no ${word} rate set, and neither does the property, so this stay cannot be priced — nothing was charged. `
        + `Set the site's ${word} rate (or the property's), then press Charge again.`)
  }
  return { ...priced, unitNumber: u.unit_number }
}

// ── 10/5 (Nic, R6): ADD A MONTH TO THE STAY THAT IS HERE NOW ─────────────

/**
 * What adding a month to a guest's current stay comes to — read, never
 * written (extendStayByMonth writes it). The SAME booking is lengthened by one
 * calendar month from its check-out, and the month is priced on its own at the
 * monthly rate (the site's, else the property's): no reprice of the whole
 * stay, no proration (R5, R6).
 */
export interface StayExtension {
  bookingId: string
  unitId: string
  unitNumber: string
  propertyId: string
  checkIn: string
  /** The stay's check-out now — the first night of the added month. */
  fromCheckOut: string
  /** Its check-out with the month added. */
  checkOut: string
  /** Nights on the stay with the month added. */
  nights: number
  addedNights: number
  /** The added month, at the monthly rate. */
  price: number
  /** Paid toward the stay before the month (all of it — nothing may be owed). */
  paidBefore: number
  guestName: string | null
  guestEmail: string | null
  tenantId: string | null
  stayTerms: StayTerms | null
}

/** What the clerk is told when the month cannot be added (`nothing`: 'charged' or 'sent'). */
const extendWords = {
  gone: (n: string) => `That stay is not on the schedule any more — nothing was ${n}. Pick the stay again.`,
  over: (n: string) => `That stay has ended (checked out, canceled or a no-show) — nothing was ${n}. Ring a new stay with a site and dates instead.`,
  unpaid: (n: string) => `That stay is not paid yet — nothing was ${n}. Settle it first (open its ticket or pay link from the open list), then add a month.`,
  lease: (n: string) => `That stay has a lease — the lease holds the site for as long as they stay and bills each month, so there is no month to add — nothing was ${n}.`,
  owes: (owed: number, n: string) => `That stay still owes $${owed.toFixed(2)} — nothing was ${n}. Take that first (open its ticket or pay link from the open list), then add a month.`,
  noRate: (unit: string, n: string) => `Site ${unit} has no monthly rate set, and neither does the property, so a month cannot be priced — nothing was ${n}. Set the site's monthly rate (or the property's), then try again.`,
  taken: (unit: string, from: string, to: string, n: string) => `Site ${unit} is not free for the whole month from ${longCalendarDate(from)} to ${longCalendarDate(to)} — someone else has it for some of those nights, so the stay cannot be lengthened there. Nothing was ${n}. Ring a new stay on another site instead.`,
}

export async function stayExtensionQuote(
  q: Pick<PoolClient, 'query'>, args: { landlordId: string; propertyId: string; bookingId: string; nothing?: 'charged' | 'sent'; lock?: boolean },
): Promise<StayExtension> {
  const n = args.nothing ?? 'charged'
  if (!/^[0-9a-f-]{36}$/i.test(String(args.bookingId ?? ''))) throw new AppError(404, extendWords.gone(n))
  const b = (await q.query<any>(
    `SELECT b.id, b.unit_id, b.status, b.landlord_id, u.property_id,
            to_char(b.check_in, 'YYYY-MM-DD') AS check_in, to_char(b.check_out, 'YYYY-MM-DD') AS check_out,
            b.guest_name, b.guest_email, b.tenant_id, b.stay_terms,
            EXISTS (SELECT 1 FROM leases l WHERE l.source_booking_id = b.id AND l.status IN ('pending', 'active')) AS has_lease
       FROM unit_bookings b JOIN units u ON u.id = b.unit_id
      WHERE b.id = $1${args.lock ? ' FOR UPDATE OF b' : ''}`, [args.bookingId])).rows[0]
  if (!b || b.property_id !== args.propertyId || b.landlord_id !== args.landlordId) throw new AppError(404, extendWords.gone(n))
  if (['cancelled', 'no_show', 'checked_out'].includes(b.status)) throw new AppError(409, extendWords.over(n))
  if (b.status === 'tentative') throw new AppError(409, extendWords.unpaid(n))
  if (b.has_lease || b.stay_terms === 'lease') throw new AppError(409, extendWords.lease(n))
  const due = await reservationDue(q, b.id)
  if (!due || due.closed) throw new AppError(409, extendWords.over(n))
  if (due.owed > 0.005) throw new AppError(409, extendWords.owes(due.owed, n))
  const u = await siteRates(q, b.unit_id)
  const monthly = u?.monthly_rate != null ? Number(u.monthly_rate) : null
  if (!u || monthly == null || !(monthly > 0)) throw new AppError(409, extendWords.noRate(u?.unit_number ?? '—', n))
  const checkOut = checkOutFor(b.check_out, 'month', 1)
  return {
    bookingId: b.id, unitId: b.unit_id, unitNumber: u.unit_number, propertyId: b.property_id,
    checkIn: b.check_in, fromCheckOut: b.check_out, checkOut,
    nights: nightsBetween(b.check_in, checkOut), addedNights: nightsBetween(b.check_out, checkOut),
    price: round2(monthly), paidBefore: due.paid,
    guestName: b.guest_name ?? null, guestEmail: b.guest_email ?? null, tenantId: b.tenant_id ?? null,
    stayTerms: b.stay_terms ?? null,
  }
}

/**
 * 10/5 (Nic, R6) — "Add a month" EXTENDS the stay: the same booking's
 * check-out (and the length it is sold for, booked_check_out) move one
 * calendar month, its price grows by the month, and what was paid before is
 * kept as paid toward it — so the month is what is owed now, paid by the sale
 * or the link that added it (payTowardStay / settleLinkBooking). Refused, in
 * plain words, when anyone else has the site for any night of that month (a
 * paid month never moves somebody else's hold).
 *
 * Runs in the caller's transaction. Lock order as the schedule takes it: the
 * site's row, the booking, then the site's two stay locks.
 */
export async function extendStayByMonth(
  client: PoolClient, args: { landlordId: string; propertyId: string; bookingId: string; nothing?: 'charged' | 'sent' },
): Promise<StayExtension> {
  const n = args.nothing ?? 'charged'
  const first = await stayExtensionQuote(client, { ...args })
  await client.query(`SELECT id FROM units WHERE id = $1 FOR KEY SHARE`, [first.unitId])
  const ext = await stayExtensionQuote(client, { ...args, lock: true })
  if (ext.unitId !== first.unitId || ext.fromCheckOut !== first.fromCheckOut) {
    throw new AppError(409, `That stay changed a moment ago — nothing was ${n}. Pick the stay again.`)
  }
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`unit-booking:${ext.unitId}`])
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`unit_booking:${ext.unitId}`])
  // The stay ends on the month's first night, so it never reads as in the way of itself.
  if (!await siteIsFree(client, ext.unitId, ext.fromCheckOut, ext.checkOut)) {
    throw new AppError(409, extendWords.taken(ext.unitNumber, ext.fromCheckOut, ext.checkOut, n))
  }
  const upd = await client.query(
    `UPDATE unit_bookings
        SET check_out = $2::date, booked_check_out = $2::date, nights = $3,
            total_amount = COALESCE(total_amount, 0) + $4::numeric,
            deposit_amount = $5::numeric, deposit_paid_at = COALESCE(deposit_paid_at, NOW()),
            balance_paid_at = NULL, updated_at = NOW()
      WHERE id = $1 AND check_out = $6::date RETURNING id`,
    [ext.bookingId, ext.checkOut, ext.nights, ext.price, ext.paidBefore, ext.fromCheckOut])
  if (!upd.rows.length) throw new AppError(409, `That stay changed a moment ago — nothing was ${n}. Pick the stay again.`)
  return ext
}

/**
 * A month added by a pay link that was closed before anything was paid on it
 * goes again: the stay's check-out and price go back to what they were, and a
 * stay that was paid whole before reads as paid whole again. Only while the
 * stay still ends where the month left it and nothing was paid toward the
 * month. Returns whether it was undone.
 */
export async function undoStayExtension(
  client: Pick<PoolClient, 'query'>, ext: { bookingId: string; fromCheckOut: string; checkOut: string; price: number },
): Promise<boolean> {
  const r = await client.query(
    `UPDATE unit_bookings
        SET check_out = $2::date, booked_check_out = $2::date, nights = ($2::date - check_in),
            total_amount = total_amount - $4::numeric,
            balance_paid_at = CASE WHEN COALESCE(deposit_amount, 0) >= total_amount - $4::numeric - 0.005
                                   THEN COALESCE(balance_paid_at, NOW()) ELSE balance_paid_at END,
            updated_at = NOW()
      WHERE id = $1 AND check_out = $3::date AND status IN ('confirmed', 'checked_in')
        AND COALESCE(deposit_amount, 0) <= total_amount - $4::numeric + 0.005
      RETURNING id`,
    [ext.bookingId, ext.fromCheckOut, ext.checkOut, round2(ext.price)])
  return r.rows.length > 0
}

/**
 * Money a sale at the counter paid toward a stay already on the schedule (a
 * month added to it): added to what was paid before, and once that covers the
 * stay's price its balance is stamped billed and paid — the same rule a pay
 * link follows (posPayLinks settleLinkBooking). Itemized by how it was paid
 * (decisions #37.B, #38).
 */
export async function payTowardStay(
  client: PoolClient, o: { bookingId: string; saleId: string; amount: number },
): Promise<void> {
  const amount = round2(Math.max(0, Number(o.amount) || 0))
  if (!(amount > 0)) return
  const b = (await client.query<{ total: number; deposit_amount: number | null; deposit_paid: boolean }>(
    `SELECT COALESCE(total_amount, 0)::float AS total, deposit_amount::float AS deposit_amount,
            (deposit_paid_at IS NOT NULL) AS deposit_paid
       FROM unit_bookings WHERE id = $1 FOR UPDATE`, [o.bookingId])).rows[0]
  if (!b) return
  const before = b.deposit_paid ? (b.deposit_amount == null ? Number(b.total) : Number(b.deposit_amount)) : 0
  const paidNow = round2(before + amount)
  const whole = paidNow >= Number(b.total) - 0.005
  await client.query(
    `UPDATE unit_bookings
        SET deposit_amount = $2::numeric, deposit_paid_at = COALESCE(deposit_paid_at, NOW()),
            pos_transaction_id = COALESCE(pos_transaction_id, $3),
            balance_billed_at = CASE WHEN $4::boolean THEN COALESCE(balance_billed_at, NOW()) ELSE balance_billed_at END,
            balance_paid_at   = CASE WHEN $4::boolean THEN COALESCE(balance_paid_at, NOW()) ELSE balance_paid_at END,
            updated_at = NOW()
      WHERE id = $1`, [o.bookingId, paidNow, o.saleId, whole])
  const { recordSaleTowardStay } = await import('./stayPayments')
  await recordSaleTowardStay(client, { bookingId: o.bookingId, saleId: o.saleId, toward: amount })
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
  // 10/5 (Nic, M2): the background check a ticket carries stays on it only
  // while it is still owed — the stay stands (paid in full some other way, or
  // its lease bills it) and no check is recorded for it yet. A cancelled or
  // no-show stay needs no check; one already paid is never asked twice.
  const screeningGone = tickets.length ? !!(await q.query<{ gone: boolean }>(
    `SELECT (b.id IS NULL OR b.status IN ('cancelled', 'no_show')
             OR EXISTS (SELECT 1 FROM screening_prepayments sp WHERE sp.booking_id = $1 AND sp.status <> 'void')) AS gone
       FROM (SELECT $1::uuid AS id) x LEFT JOIN unit_bookings b ON b.id = x.id`, [bookingId])).rows[0]?.gone : false
  for (const t of tickets) {
    const items = Array.isArray(t.items) ? t.items : []
    const stays = await stayItemIdsIn(q, t.landlord_id, items)
    const rest = items.filter((i: any) => !stays.has(lowerItemId(i?.id)) && !(screeningGone && !i?.id && i?.screening === true))
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
