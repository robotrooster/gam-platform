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

import { query, queryOne } from '../db'
import { AppError } from '../middleware/errorHandler'
import { computeStayPrice, computeMonthlyStaySchedule, BOOKING_MONTHLY_DEPOSIT_DEFAULT } from '@gam/shared'

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
}

/** Resolve a property by its public booking slug, 404 unless enabled. */
export async function resolveProperty(slug: string): Promise<PropertyRow> {
  const prop = await queryOne<PropertyRow>(
    `SELECT id, landlord_id, booking_slug, name, city, state, booking_intro, booking_about, booking_area, booking_deposit_pct,
            booking_monthly_deposit, booking_utilities_billed,
            street1, zip, office_phone, office_email, office_hours,
            nightly_rate, weekly_rate, monthly_rate, short_term_tax_rate
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
            booking_monthly_deposit, booking_utilities_billed,
            street1, zip, office_phone, office_email, office_hours,
            nightly_rate, weekly_rate, monthly_rate, short_term_tax_rate
       FROM properties
      WHERE id = $1 AND public_booking_enabled = TRUE`,
    [propertyId])
}

/** Units that the public can book: bookable + allow a short-term stay type. */
export async function bookableUnits(propertyId: string) {
  return query<any>(
    `SELECT u.id, u.unit_number, u.unit_type, u.nightly_rate, u.weekly_rate, u.monthly_rate,
            u.min_stay_nights, u.max_stay_nights, u.check_in_time, u.check_out_time,
            u.lease_types_allowed, u.subtype_id,
            s.name AS subtype_name, s.unit_type AS subtype_unit_type, s.rv_site_layout AS subtype_layout,
            s.rv_amp_service AS subtype_amp,
            s.nightly_rate AS subtype_nightly, s.weekly_rate AS subtype_weekly,
            s.monthly_rate AS subtype_monthly
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

/** W-20: availability = ANY unit of the site type free for the window
 *  (guests never see per-unit inventory). Returns the quote fields shared by
 *  both response shapes. */
export async function typeAvailability(prop: PropertyRow, siteType: SiteType, nights: number, checkIn: string, checkOut: string) {
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
       LIMIT 1`,
      [u.id, checkOut, checkIn])
    if (!conflict) { freeUnit = u; break }
  }

  // Auto-tiered pricing (guest does not pick a billing type — Nic 2026-06-27):
  // length decides nightly/weekly/monthly, prorated, with short-term lodging
  // tax on stays under 30 nights. Rates: subtype, else unit, else property.
  const rep = freeUnit ?? siteType.units[0]
  const rates = {
    nightly: rep.nightly_rate ?? prop.nightly_rate,
    weekly:  rep.subtype_weekly  ?? rep.weekly_rate  ?? prop.weekly_rate,
    monthly: rep.subtype_monthly ?? rep.monthly_rate ?? prop.monthly_rate,
  }
  const price = computeStayPrice(rates, Number(prop.short_term_tax_rate || 0), nights)
  // S547 (Nic): 30+ night stays bill like residents — prorated arrival month
  // (monthly/30), flat monthly on the 1st, prorated departure. The quote
  // total is the schedule sum so quote and invoices can never disagree.
  const monthlyBilling = price.tier === 'monthly' && rates.monthly != null
    ? computeMonthlyStaySchedule(checkIn, checkOut, Number(rates.monthly))
    : null
  const total = monthlyBilling ? monthlyBilling.total : (price.total > 0 ? price.total : null)
  const depositPct = Number(prop.booking_deposit_pct)
  // Deposit rule (S547, Nic): % of total for short stays only; monthly-tier
  // stays owe a flat deposit (per-property, default utility-bill-sized),
  // hard-capped at one month's rent.
  const monthlyFlat = prop.booking_monthly_deposit != null ? Number(prop.booking_monthly_deposit) : BOOKING_MONTHLY_DEPOSIT_DEFAULT
  const depositAmount = total == null ? null
    : monthlyBilling ? Math.round(Math.min(monthlyFlat, Number(rates.monthly)) * 100) / 100
    : Math.round(total * (depositPct / 100) * 100) / 100

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
    base: monthlyBilling ? monthlyBilling.total : price.base,
    tax: monthlyBilling ? 0 : price.tax,
    taxable: monthlyBilling ? false : price.taxable,
    total, depositPct, depositAmount,
    // Present only on monthly-tier stays: the calendar-aligned invoice plan.
    monthlyBilling: monthlyBilling
      ? { monthlyRate: Number(rates.monthly), segments: monthlyBilling.segments }
      : null,
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
      weeklyRate:  num(rep.subtype_weekly  ?? rep.weekly_rate  ?? prop.weekly_rate),
      monthlyRate: num(rep.subtype_monthly ?? rep.monthly_rate ?? prop.monthly_rate),
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
