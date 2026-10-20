/**
 * Property booking QUOTE + availability engine — the pricing/availability math
 * behind the public per-property booking site.
 *
 * Extracted from routes/publicPropertyBooking.ts (S601) so BOTH the public
 * booking route AND the property agent's tools quote from ONE source — a guest
 * asking the agent "what's a pull-through cost?" and the same guest using the
 * booking form must never see different numbers. Pure data + math; no HTTP.
 *
 * W-20 (Nic): guests book a SITE TYPE, not a specific unit — the system assigns
 * the actual site internally. Types = the property's unit subtypes; units with
 * no subtype pool into a "general" RV Site type.
 */

import { DateTime } from 'luxon'
import { query, queryOne } from '../db'
import { AppError } from '../middleware/errorHandler'
import {
  priceStay, BOOKING_MONTHLY_DEPOSIT_DEFAULT, processingFeeFor, cardFeeSplit, stayNightsBetween,
  STAY_LEASE_CHOICE_NIGHTS, STAY_SCREENING_NIGHTS, stayHeldWords, stayPlanWords, leaseDueDay, dueDayLabel, type CardFeePayer,
} from '@gam/shared'
import { stayNeeds } from './stayTerms'

export interface PropertyRow {
  id: string
  landlord_id: string
  booking_slug: string
  name: string
  city: string | null
  state: string | null
  booking_intro: string | null
  booking_about: string | null
  booking_area: string | null
  booking_deposit_pct: string
  booking_monthly_deposit: string | null
  booking_card_fee_payer: CardFeePayer
  booking_utilities_billed: boolean
  street1: string | null
  zip: string | null
  office_phone: string | null
  office_email: string | null
  office_hours: string | null
  nightly_rate: string | null
  weekly_rate: string | null
  monthly_rate: string | null
  short_term_tax_rate: string | null
  /** S654: the park's IANA zone — "today" for a stay is the park's today. */
  timezone: string | null
  /** 10/5 (R4): a lease drafted from a stay is due per the property's rent-due setting. */
  rent_due_mode: string | null
  rent_due_day: number | null
}

/** Resolve a property by its public booking slug, 404 unless enabled. */
export async function resolveProperty(slug: string): Promise<PropertyRow> {
  const prop = await queryOne<PropertyRow>(
    `SELECT id, landlord_id, booking_slug, name, city, state, booking_intro, booking_about, booking_area, booking_deposit_pct,
            booking_monthly_deposit, booking_utilities_billed, booking_card_fee_payer,
            street1, zip, office_phone, office_email, office_hours,
            nightly_rate, weekly_rate, monthly_rate, short_term_tax_rate, timezone, rent_due_mode, rent_due_day
       FROM properties
      WHERE booking_slug = $1 AND public_booking_enabled = TRUE`,
    [slug])
  if (!prop) throw new AppError(404, 'Booking site not found')
  return prop
}

/** Same resolution keyed by property id (the agent door already has the id). */
export async function resolvePropertyById(propertyId: string): Promise<PropertyRow | null> {
  return queryOne<PropertyRow>(
    `SELECT id, landlord_id, booking_slug, name, city, state, booking_intro, booking_about, booking_area, booking_deposit_pct,
            booking_monthly_deposit, booking_utilities_billed, booking_card_fee_payer,
            street1, zip, office_phone, office_email, office_hours,
            nightly_rate, weekly_rate, monthly_rate, short_term_tax_rate, timezone, rent_due_mode, rent_due_day
       FROM properties
      WHERE id = $1 AND public_booking_enabled = TRUE`,
    [propertyId])
}

/** Units that the public can book: bookable + allow a short-term stay type. */
export async function bookableUnits(propertyId: string) {
  return query<any>(
    `SELECT u.id, u.unit_number, u.unit_type, u.nightly_rate, u.weekly_rate, u.monthly_rate, u.rent_amount,
            u.min_stay_nights, u.max_stay_nights, u.check_in_time, u.check_out_time,
            u.lease_types_allowed, u.subtype_id,
            s.name AS subtype_name, s.unit_type AS subtype_unit_type, s.rv_site_layout AS subtype_layout,
            s.rv_amp_service AS subtype_amp
       FROM units u
       LEFT JOIN property_unit_subtypes s ON s.id = u.subtype_id
      WHERE u.property_id = $1
        AND u.is_bookable = TRUE
        AND (u.lease_types_allowed && ARRAY['nightly','weekly']::text[])
      ORDER BY u.unit_number`,
    [propertyId])
}

export interface SiteType {
  id: string            // subtype uuid, or 'general'
  name: string
  unitType: string      // rv_spot | hotel_room | mobile_home | … — for booking-page grouping
  requiredLayout: string | null
  requiredAmp: string | null
  units: any[]          // candidate units, unit_number order
}
export function groupSiteTypes(units: any[]): SiteType[] {
  const byType = new Map<string, SiteType>()
  for (const u of units) {
    const key = u.subtype_id ?? 'general'
    let t = byType.get(key)
    if (!t) {
      t = {
        id: key,
        name: u.subtype_id ? u.subtype_name : 'RV Site',
        unitType: u.subtype_id ? (u.subtype_unit_type ?? 'rv_spot') : (u.unit_type ?? 'rv_spot'),
        requiredLayout: u.subtype_id ? (u.subtype_layout ?? null) : null,
        requiredAmp: u.subtype_id ? (u.subtype_amp ?? null) : null,
        units: [],
      }
      byType.set(key, t)
    }
    t.units.push(u)
  }
  return [...byType.values()]
}
export function resolveSiteType(units: any[], siteTypeId: string): SiteType {
  const t = groupSiteTypes(units).find(x => x.id === siteTypeId)
  if (!t) throw new AppError(404, 'Site type not found')
  return t
}
/** Representative rates for a type — read off the unit.
 *
 *  S613: this used to prefer the SUBTYPE's rate over the unit's while the
 *  renter-pool match preferred the opposite, so which number a guest saw
 *  depended on which screen asked. Price now lives on the subtype and reaches
 *  its units through the DB trigger, so the unit IS the class rate and there is
 *  one number to read. */
export function typeRates(t: SiteType) {
  const u = t.units[0]
  return {
    nightly: u.nightly_rate != null ? Number(u.nightly_rate) : null,
    weekly:  u.weekly_rate  != null ? Number(u.weekly_rate)  : null,
  }
}

// ── 10/5 (Nic): PREPAID STAYS on the booking site ──────────────────────────
//
//   "If they're booking online, it will ask them a lease guarantees your spot
//    indefinitely and the stay only guarantees it for the time that you've paid
//    ahead of time. And if they choose to just do the stay, that's fine. If they
//    choose to do the lease, then it drafts one for me."
//
// The rules themselves live in services/stayTerms (stayNeeds); this is only
// what the booking site QUOTES from them, so the guest sees the same figures
// the checkout then charges (services/propertyBooking bookStay).

/** R2: what the guest reads before choosing — word for word, on every booking-site door. */
export const LEASE_OR_STAY_WORDS =
  'A lease holds your site for as long as you stay. A stay holds it only through the time you\'ve paid for.'

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100

/**
 * The deposit on a stay, from the property's own two settings.
 *
 * A flat amount for a stay of 30+ nights (S547: the percentage is for short
 * stays only), held to one month's rent regardless of what the flat setting
 * says. Everything shorter is a percentage of the taxed total.
 * 10/6: decided by the stay's LENGTH, not by the rate it is charged at — a
 * 25-night stay charged at the monthly rate (the lower price) is still a short
 * stay and owes the percentage.
 *
 * S652: pulled out of quoteStay so a reservation taken at the COUNTER quotes
 * the same deposit the booking site would have. A guest who phones and a guest
 * who books online are buying the same nights on the same site and must not be
 * told two different numbers. (memory: gam-register-price-is-its-own-thing)
 *
 * 10/20 (review) — A SITE WITH NO MONTHLY RATE IS STILL A SEASONAL SITE.
 * The flat rule used to be gated on the site HAVING a monthly rate, so a 92-
 * night reservation on a site priced by the night (or not priced at all, taken
 * at a typed total) fell through to the short-stay percentage and was asked
 * 10% of a season. The monthly rate was never the trigger; it is only the CAP,
 * which is what migration 20260718184500 means by "stays 30+ nights owe AT
 * MOST one month". With no monthly rate there is no month to cap against, so
 * the figure the stay was sold at caps it instead, and a stay with no price at
 * all is asked for nothing — the office settles that one by hand.
 *
 * It lives here rather than in propertyBooking because the booking site's own
 * quote (typeAvailability, below) used to carry a SECOND copy of this
 * arithmetic, and the copies drifted on exactly the case above. One function,
 * so the website and the counter cannot quote a guest two different deposits.
 */
export function depositForStay(
  prop: { booking_deposit_pct: string | number; booking_monthly_deposit: string | number | null },
  stay: { total: number; nights: number; monthlyRate: number | null },
): number {
  if (stay.nights >= STAY_LEASE_CHOICE_NIGHTS) {
    const flat = prop.booking_monthly_deposit != null
      ? Number(prop.booking_monthly_deposit) : BOOKING_MONTHLY_DEPOSIT_DEFAULT
    const caps = [stay.monthlyRate, stay.total].filter((n): n is number => n != null && n > 0)
    return caps.length ? round2(Math.min(flat, ...caps)) : 0
  }
  return round2(stay.total * (Number(prop.booking_deposit_pct) / 100))
}

/**
 * What the guest pays now, line by line: the stay's part (a deposit, or a
 * no-lease stay's first month), the background check (R8 — a fixed line that
 * cannot be removed; 0 when none is due) and GAM's card fee on the whole of it
 * (0 when the property covers the fee). The checkout charges exactly this.
 */
export interface DueNow { stay: number; screening: number; cardFee: number; total: number }
export function dueNowFor(stay: number, screening: number, payer: CardFeePayer): DueNow {
  const base = round2(stay + screening)
  const split = cardFeeSplit(base, payer)
  return { stay: round2(stay), screening: round2(screening), cardFee: round2(split.charged - base), total: split.charged }
}

/**
 * 10/5 (Nic, R5): a stay of 30+ nights with no lease is paid one month at a
 * time online. The booking covers the first calendar month only — the 4th to
 * the 4th, never past the check-out asked for — never prorated. Later months
 * are added at the counter, on a pay link or on the schedule ("Add a month").
 * 10/6 (Nic): those nights cost what every door charges for them (priceStay —
 * the cheapest whole months, weeks and nights that cover them): a whole
 * calendar month is the monthly rate; with no monthly rate set, the weeks and
 * nights.
 */
export function firstStayMonth(
  checkIn: string, checkOut: string,
  rates: { nightly: number | null; weekly: number | null; monthly: number | null },
  taxRatePct: number,
): { checkOut: string; nights: number; amount: number } {
  const monthOut = DateTime.fromISO(checkIn).plus({ months: 1 }).toISODate()!
  const out = checkOut < monthOut ? checkOut : monthOut
  const nights = Math.round(DateTime.fromISO(out).diff(DateTime.fromISO(checkIn), 'days').days)
  // 10/6 (review): the stay asked for is 30+ nights, and a stay of 30+ nights
  // carries no lodging tax — so neither does its first month, even a 28-night
  // February charged as four weeks (registerStay untaxedMonthStaySql reads it
  // back the same way). `taxRatePct` is kept for the callers; it never applies.
  void taxRatePct
  const amount = priceStay(rates, 0, checkIn, nights).total
  return { checkOut: out, nights, amount }
}

/**
 * 10/20 (defect) — WHAT A RESERVATION OWES RIGHT NOW, ANSWERED ONCE.
 *
 * Two doors ask this question about the same row and they must never come to
 * different money: the confirmation a person presses send on
 * (services/bookingConfirmation) and the ticket arrival morning raises
 * (services/stayBalance). Both used to decide it for themselves, and they
 * disagreed on exactly the reservations Nic is bringing over from the old
 * system.
 *
 *   "If they're seasonal and going to be here more than the 30 days, I just
 *    want it to tell them the first month's rate."
 *
 * That sentence is about a stay the RATE CARD priced. A month can only be cut
 * out of a price the card actually set, and Nic's board is full of figures it
 * never set: a total a clerk typed on a site with no rate on it, a season
 * imported straight across at a price of its own. A 92-night season sold for
 * $1,767 on a site carrying nothing but a $49 nightly rate has a card-priced
 * "first month" of $1,519 — 86% of the whole season, a figure no door ever
 * showed anybody, and it left $248 that nothing at all would ever bill.
 *
 * So the question is answered in one place, in four plain answers, and each
 * caller decides what to DO with them (the confirmation quotes; the arrival run
 * bills). `checkOut` is the check-out the stay was SOLD for — registerStay
 * soldCheckOutSql — never a check-out an early departure moved, because a guest
 * who leaves early does not retroactively become a short stay.
 */
export type SoldStayMonth =
  /** 30+ nights the card priced: this is the first month, already held to the price the stay was sold at. */
  | { kind: 'month'; checkOut: string; nights: number; amount: number }
  /** Under 30 nights: there is no "first month" — the stay is its own figure. */
  | { kind: 'short_stay' }
  /** 30+ nights the card did NOT price: the only figure this stay has is the one it was sold at. */
  | { kind: 'whole_stay' }
  /** 30+ nights and nothing can price a month of it — no rate on the site or the property. */
  | { kind: 'unpriceable' }

export function soldStayFirstMonth(args: {
  checkIn: string
  /** The check-out the stay was SOLD for. */
  checkOut: string
  /** unit_bookings.total_amount — the price it was sold at; null or 0 when it has none. */
  soldTotal: number | string | null
  rates: { nightly: number | null; weekly: number | null; monthly: number | null }
}): SoldStayMonth {
  if (stayNightsBetween(args.checkIn, args.checkOut) < STAY_LEASE_CHOICE_NIGHTS) return { kind: 'short_stay' }
  const sold = round2(Number(args.soldTotal) || 0)
  const month = firstStayMonth(args.checkIn, args.checkOut, args.rates, 0)
  const amount = round2(month.amount)
  // Asked FIRST, because a site with no rate card at all cannot be told apart
  // from one whose card disagrees by comparing prices — both come to nothing.
  if (!(amount > 0)) return { kind: 'unpriceable' }
  // WHOSE PRICE IS THIS? Only the card's own price may be cut into months; a
  // reservation with no price of its own is the card's to price. (A 30+ night
  // stay carries no lodging tax, so the card's figure is the whole comparison
  // — there is no tax split to line up.)
  const nights = stayNightsBetween(args.checkIn, args.checkOut)
  if (sold > 0 && round2(priceStay(args.rates, 0, args.checkIn, nights).total) !== sold) {
    return { kind: 'whole_stay' }
  }
  // Never more than the stay costs altogether: a season sold flat, below the
  // card's month, owes that flat price and not the card's.
  return { ...month, kind: 'month', amount: sold > 0 ? Math.min(amount, sold) : amount }
}

/**
 * R4: the lease a guest asks for, as the booking site describes it — the same
 * rent draftLeaseFromStay (services/stayTerms) writes on the draft (the unit's
 * monthly rent, else its monthly stay rate), due per the PROPERTY's rent-due
 * setting (leaseDueDay). A check-in off the due day makes the first bill
 * prorated; what was paid on the reservation comes off that bill.
 */
export function leaseFromStay(
  prop: Pick<PropertyRow, 'rent_due_mode' | 'rent_due_day'>,
  unit: { rent_amount?: string | number | null },
  monthlyRate: number | null,
  checkIn: string,
): { monthlyRent: number | null; rentWords: string } {
  const monthlyRent = Number(unit.rent_amount) > 0 ? Number(unit.rent_amount)
    : monthlyRate != null && monthlyRate > 0 ? monthlyRate : null
  const dueDay = leaseDueDay({ mode: prop.rent_due_mode ?? 'fixed_day', propertyDay: prop.rent_due_day ?? 1, startIso: checkIn })
  const prorated = Number(checkIn.slice(8, 10)) !== dueDay
  return {
    monthlyRent,
    rentWords: `Rent is due on the ${dueDayLabel(dueDay)} of each month.`
      + (prorated ? ' Your first month is prorated to the days you\'re here.' : '')
      + ' What you pay today comes off your first bill.',
  }
}

/**
 * R1/R8: the background-check fee a stay of these dates carries — null under
 * 22 nights. Quoted before we know who is booking; the guest's own history (a
 * check already on file, back-to-back stays that add up) is looked at when
 * they book (propertyBooking bookStay asks stayNeeds again with their email).
 */
export async function quoteScreeningFee(
  prop: Pick<PropertyRow, 'id' | 'landlord_id'>, checkIn: string, checkOut: string,
): Promise<number | null> {
  const nights = Math.round(DateTime.fromISO(checkOut).diff(DateTime.fromISO(checkIn), 'days').days)
  if (!(nights >= STAY_SCREENING_NIGHTS)) return null
  const needs = await stayNeeds({ landlordId: prop.landlord_id, propertyId: prop.id, checkIn, checkOut })
  return needs.screeningFee?.amount ?? null
}

/** W-20: availability = ANY unit of the site type free for the window
 *  (guests never see per-unit inventory). Returns the quote fields shared by
 *  both response shapes. `screeningFee` may be passed in when the caller
 *  quotes several site types for the same dates (it never depends on the type). */
export async function typeAvailability(
  prop: PropertyRow, siteType: SiteType, nights: number, checkIn: string, checkOut: string,
  opts: { screeningFee?: number | null } = {},
) {
  let freeUnit: any = null
  for (const u of siteType.units) {
    // S593: mirror the write-time guard (services/propertyBooking.hasConflict) —
    // a unit is free only if NEITHER an overlapping booking NOR an overlapping
    // ACTIVE long-term lease occupies it. Keeps the displayed availability from
    // contradicting what a booking attempt will actually allow.
    const conflict = await queryOne<{ x: number }>(
      `SELECT 1 AS x WHERE
         EXISTS (
           SELECT 1 FROM unit_bookings
            WHERE unit_id = $1 AND status <> 'cancelled'
              AND NOT (status = 'tentative' AND hold_expires_at IS NOT NULL AND hold_expires_at < now())
              AND check_in < $2::date AND check_out > $3::date
         )
         OR EXISTS (
           SELECT 1 FROM leases
            WHERE unit_id = $1 AND status IN ('active','pending')
              AND start_date < $2::date AND (end_date IS NULL OR end_date > $3::date)
         )
         -- S649: out-of-order sites are never offered
         OR unit_out_of_order_overlaps($1, $3::date, $2::date)
       LIMIT 1`,
      [u.id, checkOut, checkIn])
    if (!conflict) { freeUnit = u; break }
  }

  // The guest does not pick a billing type (Nic 2026-06-27). 10/6 (Nic): the
  // price is the one every door charges for these nights — the cheapest whole
  // months, weeks and nights that cover them (shared priceStay), never
  // prorated — with short-term lodging tax on stays under 30 nights.
  //
  // S630 DIRECTIVE (Nic): rates come from the UNIT, else the property. NEVER the
  // subtype — "subtypes should not price the unit... maybe one spot's bigger and
  // worth more, maybe one spot's tiny or inconvenient so they get a deal. It
  // doesn't change the fact that it's a pull through or a fifty amp spot."
  // A guest quote priced off the class could not be discounted for one awkward
  // site without repricing every site that shares the class.
  const rep = freeUnit ?? siteType.units[0]
  const rates = {
    nightly: rep.nightly_rate ?? prop.nightly_rate,
    weekly:  rep.weekly_rate  ?? prop.weekly_rate,
    monthly: rep.monthly_rate ?? prop.monthly_rate,
  }
  const price = priceStay(rates, prop.short_term_tax_rate, checkIn, nights)
  // 10/5 (R5): a 30+ night stay's total is the whole stay asked for, as an
  // estimate — nothing bills it as a lump. A lease bills by the property's
  // rent-due setting; a stay is paid a month at a time (longStay below).
  const total = price.total > 0 ? price.total : null
  const depositPct = Number(prop.booking_deposit_pct)
  // Deposit rule (S547, Nic): % of total for short stays only; a stay of 30+
  // nights owes a flat deposit (per-property, default utility-bill-sized),
  // held to one month. (10/6: by the stay's length, as depositForStay — never
  // by the rate it is charged at.) 10/20 (review): this was a second copy of
  // that arithmetic and it had drifted, so it calls the one function now.
  const monthlyRateNum = rates.monthly != null && Number(rates.monthly) > 0 ? Number(rates.monthly) : null
  const depositAmount = total == null ? null
    : depositForStay(prop, { total, nights, monthlyRate: monthlyRateNum })

  // 10/5 (R1/R8, R2/R5): the background check and the lease-or-stay choice.
  const screeningFee = opts.screeningFee !== undefined
    ? opts.screeningFee
    : await quoteScreeningFee(prop, checkIn, checkOut)
  const screening = screeningFee ?? 0
  const payer = prop.booking_card_fee_payer
  const num = (v: any) => (v == null ? null : Number(v))
  const longStay = nights >= STAY_LEASE_CHOICE_NIGHTS && depositAmount != null
    ? (() => {
        const monthlyRate = num(rates.monthly)
        const first = firstStayMonth(checkIn, checkOut,
          { nightly: num(rates.nightly), weekly: num(rates.weekly), monthly: monthlyRate },
          Number(prop.short_term_tax_rate || 0))
        return {
          words: LEASE_OR_STAY_WORDS,
          monthlyRate,
          lease: { dueNow: dueNowFor(depositAmount, screening, payer), ...leaseFromStay(prop, rep, monthlyRate, checkIn) },
          stay: {
            checkOut: first.checkOut, nights: first.nights,
            dueNow: dueNowFor(first.amount, screening, payer),
            heldWords: stayHeldWords(first.checkOut),
          },
        }
      })()
    : null

  const minStay = rep.min_stay_nights
  const maxStay = rep.max_stay_nights
  const stayTooShort = minStay != null && nights < minStay
  const stayTooLong  = maxStay != null && nights > maxStay

  // S547 adaptive booking (Nic): when the type is full for the FULL range,
  // find the longest stay that DOES fit starting at the same check-in — "a
  // pull-through is open for 9 of your 10 nights" — so the guest can shorten
  // instead of walking away, and the schedule packs tighter.
  let altStay: { checkOut: string; nights: number } | null = null
  if (!freeUnit && siteType.units.length > 0) {
    const conflicts = await query<{ unit_id: string; first_conflict: string }>(
      `SELECT unit_id, MIN(check_in)::text AS first_conflict
         FROM unit_bookings
        WHERE unit_id = ANY($1::uuid[])
          AND status <> 'cancelled'
          AND NOT (status = 'tentative' AND hold_expires_at IS NOT NULL AND hold_expires_at < now())
          AND check_in < $2::date AND check_out > $3::date
        GROUP BY unit_id`,
      [siteType.units.map((u: any) => u.id), checkOut, checkIn])
    const byUnit = new Map(conflicts.map(c => [c.unit_id, c.first_conflict.slice(0, 10)]))
    let bestEnd: string | null = null
    for (const u of siteType.units) {
      const end = byUnit.get(u.id)
      if (!end) continue                    // shouldn't happen: no conflict = freeUnit above
      if (end > checkIn && (!bestEnd || end > bestEnd)) bestEnd = end
    }
    if (bestEnd && bestEnd < checkOut) {
      const altNights = Math.round(
        (new Date(bestEnd + 'T12:00:00Z').getTime() - new Date(checkIn + 'T12:00:00Z').getTime()) / 86400000)
      if (altNights >= Math.max(1, minStay ?? 1)) altStay = { checkOut: bestEnd, nights: altNights }
    }
  }

  return {
    altStay,
    available: !!freeUnit && !stayTooShort && !stayTooLong && total != null,
    unavailableReason: !freeUnit ? 'booked'
      : stayTooShort ? `Minimum stay is ${minStay} nights`
      : stayTooLong ? `Maximum stay is ${maxStay} nights`
      : total == null ? 'rate_unavailable'
      : null,
    tier: price.tier,
    // 10/6: what the stay is charged as, in words ("1 week + 1 night").
    chargedAs: price.total > 0 ? stayPlanWords(price.plan) : null,
    // 10/6 (review): "the lower price" only when the smaller rates cost more.
    chargedLower: price.total > 0 && price.lowerPrice,
    base: price.base,
    tax: price.tax,
    taxable: price.taxable,
    total, depositPct, depositAmount,
    // S648 (Nic): deposits are card only; the card fee is added on top unless
    // the landlord absorbs it (then this is 0). The deposit's own fee — what a
    // stay with no background check pays; dueNow below is the whole charge.
    depositCardFee: depositAmount == null ? null
      : prop.booking_card_fee_payer === 'landlord' ? 0
      : processingFeeFor({ amount: depositAmount, paymentMethod: 'card' }),
    // 10/5 (R8): the background check's fixed line on the checkout, null when
    // the stay is under 22 nights.
    screeningFee,
    // Under 30 nights: the whole charge to reserve — deposit, check, card fee.
    dueNow: depositAmount != null && !longStay ? dueNowFor(depositAmount, screening, payer) : null,
    // 30+ nights (R2): the guest chooses, and each choice is priced. Lease:
    // the deposit today, then the lease bills. Stay: the first month today.
    longStay,
  }
}

/**
 * Pricing catalog WITHOUT dates — every bookable site type + its rates, the
 * layout (back-in / pull-through) and amp service that distinguish them, and
 * the property-level deposit / tax. Powers the agent's get_property_pricing so
 * it can answer "what's a pull-through run?" before any dates are chosen.
 * Rates fall back subtype → representative unit → property, matching the dated
 * quote engine above.
 */
export async function listSiteTypePricing(prop: PropertyRow) {
  const units = await bookableUnits(prop.id)
  const num = (v: any) => (v == null ? null : Number(v))
  const types = groupSiteTypes(units).map((t) => {
    const rep = t.units[0]
    return {
      id: t.id,
      name: t.name,
      layout: t.requiredLayout,               // 'back_in' | 'pull_through' | 'none' | null
      ampService: t.requiredAmp,              // 'none' | '30' | '50' | 'both' | null
      nightlyRate: num(rep.nightly_rate ?? prop.nightly_rate),
      weeklyRate:  num(rep.weekly_rate  ?? prop.weekly_rate),
      monthlyRate: num(rep.monthly_rate ?? prop.monthly_rate),
      minStayNights: rep.min_stay_nights ?? null,
      maxStayNights: rep.max_stay_nights ?? null,
      checkInTime: rep.check_in_time ?? null,
      checkOutTime: rep.check_out_time ?? null,
    }
  })
  return {
    propertyName: prop.name,
    depositPct: Number(prop.booking_deposit_pct),
    shortTermTaxRatePct: Number(prop.short_term_tax_rate || 0),
    utilitiesBilledOnMonthly: prop.booking_utilities_billed,
    siteTypes: types,
  }
}
