import crypto from 'crypto'
import { DateTime } from 'luxon'
import type { PoolClient } from 'pg'
import { getClient, query, queryOne } from '../db'
import { AppError } from '../middleware/errorHandler'
import { createBookingDepositCheckoutSession } from './stripeConnect'
import { sendNotificationEmail } from './email'
import { logger } from '../lib/logger'
import { WAITLIST_CLAIM_WINDOW_MINUTES, computeStayPrice } from '@gam/shared'

// ============================================================
// S517 / Walkthrough #11 — public property booking + waitlist.
//
// A guest books a short-term stay on a property's public site and pays a
// DEPOSIT at booking (Stripe Checkout → landlord Connect). The booking is
// 'tentative' (holding the dates for HOLD_MINUTES) until the deposit settles,
// then the webhook flips it 'confirmed'. A full unit/date sends the guest to
// the waitlist; on a cancellation the next waitlister gets a 1-hour claim
// link (then it rolls to the next person).
// ============================================================

const HOLD_MINUTES = 30

/** Public booking site base URL (the customer app; subdomain/path resolves the slug). */
function publicBaseUrl(): string {
  return process.env.CUSTOMER_PORTAL_URL || 'http://localhost:3014'
}

/**
 * Stay pricing for a unit over [checkIn, checkOut). 'weekly' bills whole weeks
 * at weekly_rate plus remainder nights at nightly_rate; 'nightly' bills
 * nights × nightly_rate. Returns null when the chosen rate isn't configured.
 */
export function computeStayTotal(
  stayType: 'nightly' | 'weekly',
  nights: number,
  nightlyRate: number | null,
  weeklyRate: number | null,
): number | null {
  if (nights <= 0) return null
  if (stayType === 'weekly') {
    if (weeklyRate == null) return null
    const weeks = Math.floor(nights / 7)
    const rem = nights % 7
    const remCost = rem > 0 ? (nightlyRate ?? weeklyRate / 7) * rem : 0
    return Math.round((weeks * weeklyRate + remCost) * 100) / 100
  }
  if (nightlyRate == null) return null
  return Math.round(nightlyRate * nights * 100) / 100
}

interface PropertyRow {
  id: string; landlord_id: string; name: string; booking_slug: string
  booking_deposit_pct: string
  nightly_rate: string | null; weekly_rate: string | null; monthly_rate: string | null
  short_term_tax_rate: string | null
}
interface UnitRow {
  id: string; unit_number: string
  nightly_rate: string | null; weekly_rate: string | null; monthly_rate: string | null
  min_stay_nights: number | null; max_stay_nights: number | null; is_bookable: boolean
}

async function resolvePropertyBySlug(slug: string): Promise<PropertyRow> {
  const prop = await queryOne<PropertyRow>(
    `SELECT id, landlord_id, name, booking_slug, booking_deposit_pct,
            nightly_rate, weekly_rate, monthly_rate, short_term_tax_rate
       FROM properties WHERE booking_slug=$1 AND public_booking_enabled=TRUE`, [slug])
  if (!prop) throw new AppError(404, 'Booking site not found')
  return prop
}

async function resolveUnit(propertyId: string, unitId: string): Promise<UnitRow> {
  const unit = await queryOne<UnitRow>(
    `SELECT id, unit_number, nightly_rate, weekly_rate, monthly_rate, min_stay_nights, max_stay_nights, is_bookable
       FROM units WHERE id=$1 AND property_id=$2`, [unitId, propertyId])
  if (!unit || !unit.is_bookable) throw new AppError(404, 'Unit not bookable')
  return unit
}

interface StayQuote { nights: number; base: number; tax: number; total: number; deposit: number; tier: 'nightly' | 'weekly' | 'monthly' }

/** Validate the requested stay against the unit's rules and price it + the deposit.
 *  Pricing is AUTO-TIERED by length (guest does not pick a billing type — Nic
 *  2026-06-27): <7 nights nightly, 7–29 weekly, 30+ monthly, prorated. Rates pull
 *  from the UNIT, falling back to the PROPERTY default. Short-term lodging tax
 *  (property-level `short_term_tax_rate`, landlord-set for their city/state) is
 *  added to every stay under 30 nights; 30+ is tax-exempt. The deposit % then
 *  applies to the taxed total. */
function quoteStay(unit: UnitRow, prop: PropertyRow, checkIn: string, checkOut: string): StayQuote {
  const ci = DateTime.fromISO(checkIn), co = DateTime.fromISO(checkOut)
  if (!ci.isValid || !co.isValid) throw new AppError(400, 'Invalid dates')
  const nights = Math.round(co.startOf('day').diff(ci.startOf('day'), 'days').days)
  if (nights <= 0) throw new AppError(400, 'Check-out must be after check-in')
  if (ci < DateTime.now().startOf('day')) throw new AppError(400, 'Check-in is in the past')
  if (unit.min_stay_nights != null && nights < unit.min_stay_nights) throw new AppError(400, `Minimum stay is ${unit.min_stay_nights} nights`)
  if (unit.max_stay_nights != null && nights > unit.max_stay_nights) throw new AppError(400, `Maximum stay is ${unit.max_stay_nights} nights`)
  const num = (x: string | null) => x != null ? Number(x) : null
  const price = computeStayPrice(
    { nightly: num(unit.nightly_rate) ?? num(prop.nightly_rate),
      weekly:  num(unit.weekly_rate)  ?? num(prop.weekly_rate),
      monthly: num(unit.monthly_rate) ?? num(prop.monthly_rate) },
    Number(prop.short_term_tax_rate || 0), nights)
  if (price.total <= 0) throw new AppError(400, 'No rate is configured for this unit')
  const deposit = Math.round(price.total * (Number(prop.booking_deposit_pct) / 100) * 100) / 100
  return { nights, base: price.base, tax: price.tax, total: price.total, deposit, tier: price.tier }
}

/** Landlord's Connect account for destination charges; null if not onboarded. */
async function landlordConnect(landlordId: string): Promise<string | null> {
  const r = await queryOne<{ stripe_connect_account_id: string | null }>(
    `SELECT u.stripe_connect_account_id FROM landlords l JOIN users u ON u.id=l.user_id WHERE l.id=$1`, [landlordId])
  return r?.stripe_connect_account_id ?? null
}

/** True if a live booking (not cancelled, not an expired hold) overlaps the range. */
async function hasConflict(client: PoolClient, unitId: string, checkIn: string, checkOut: string): Promise<boolean> {
  const c = await client.query(
    `SELECT 1 FROM unit_bookings
      WHERE unit_id=$1 AND status<>'cancelled'
        AND NOT (status='tentative' AND hold_expires_at IS NOT NULL AND hold_expires_at < now())
        AND check_in < $2::date AND check_out > $3::date LIMIT 1`,
    [unitId, checkOut, checkIn])
  return c.rows.length > 0
}

export class UnitFullError extends AppError {
  constructor() { super(409, 'Those dates are fully booked') }
}

interface GuestBooking {
  slug: string; unitId: string
  guestName: string; guestEmail: string; guestPhone?: string | null
  checkIn: string; checkOut: string
  // Legacy — the guest no longer picks a billing type; pricing auto-tiers by
  // length. Accepted for backward compat but ignored.
  stayType?: 'nightly' | 'weekly'
}

export interface BookingDepositResult { bookingId: string; depositAmount: number; total: number; checkoutUrl: string }

/**
 * Create a tentative booking holding the dates, then a Stripe deposit checkout.
 * Throws UnitFullError when the dates are taken (the caller offers the waitlist).
 * Concurrency-safe via a per-unit advisory lock inside the transaction.
 */
export async function bookStay(opts: GuestBooking): Promise<BookingDepositResult> {
  const prop = await resolvePropertyBySlug(opts.slug)
  const unit = await resolveUnit(prop.id, opts.unitId)
  const quote = quoteStay(unit, prop, opts.checkIn, opts.checkOut)
  const connect = await landlordConnect(prop.landlord_id)
  if (!connect) throw new AppError(409, 'This property is not accepting online deposits yet')

  const client = await getClient()
  try {
    await client.query('BEGIN')
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`unit_booking:${unit.id}`])
    if (await hasConflict(client, unit.id, opts.checkIn, opts.checkOut)) {
      await client.query('ROLLBACK')
      throw new UnitFullError()
    }
    const holdExpires = DateTime.now().plus({ minutes: HOLD_MINUTES }).toISO()
    const ins = await client.query<{ id: string }>(
      `INSERT INTO unit_bookings
         (unit_id, landlord_id, lease_type, check_in, check_out, nights,
          guest_name, guest_email, guest_phone, nightly_rate, weekly_rate,
          total_amount, deposit_amount, platform_fee, status, source, hold_expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,0,'tentative','public',$14)
       RETURNING id`,
      [unit.id, prop.landlord_id, quote.tier, opts.checkIn, opts.checkOut, quote.nights,
       opts.guestName, opts.guestEmail, opts.guestPhone ?? null,
       unit.nightly_rate, unit.weekly_rate, quote.total, quote.deposit, holdExpires])
    const bookingId = ins.rows[0].id
    await client.query('COMMIT')

    const checkout = await createBookingDepositCheckoutSession({
      amountCents: Math.round(quote.deposit * 100),
      landlordConnectAccountId: connect,
      unitLabel: `${prop.name} · Unit ${unit.unit_number}`,
      guestEmail: opts.guestEmail,
      successUrl: `${publicBaseUrl()}/property/${prop.booking_slug}/booked`,
      cancelUrl:  `${publicBaseUrl()}/property/${prop.booking_slug}`,
      applicationFeeCents: 0,
      metadata: { gam_booking_id: bookingId },
    })
    await query(`UPDATE unit_bookings SET stripe_checkout_session_id=$1, updated_at=now() WHERE id=$2`,
      [checkout.sessionId, bookingId])
    return { bookingId, depositAmount: quote.deposit, total: quote.total, checkoutUrl: checkout.hostedUrl }
  } catch (e) {
    try { await client.query('ROLLBACK') } catch {}
    throw e
  } finally {
    client.release()
  }
}

/** Mark a booking's deposit paid + confirm it (webhook-driven, idempotent). */
export async function confirmBookingDeposit(bookingId: string, sessionId: string): Promise<void> {
  await query(
    `UPDATE unit_bookings
        SET status='confirmed', deposit_paid_at=COALESCE(deposit_paid_at, now()),
            hold_expires_at=NULL, updated_at=now()
      WHERE id=$1 AND stripe_checkout_session_id=$2 AND status='tentative'`,
    [bookingId, sessionId])
}

// ── Waitlist ─────────────────────────────────────────────────

export async function joinWaitlist(opts: GuestBooking): Promise<{ waitlistId: string; position: number }> {
  const prop = await resolvePropertyBySlug(opts.slug)
  const unit = await resolveUnit(prop.id, opts.unitId)
  quoteStay(unit, prop, opts.checkIn, opts.checkOut) // validate dates/stay
  const ins = await query<{ id: string }>(
    `INSERT INTO unit_booking_waitlists
       (unit_id, property_id, landlord_id, guest_name, guest_email, guest_phone, check_in, check_out)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [unit.id, prop.id, prop.landlord_id, opts.guestName, opts.guestEmail, opts.guestPhone ?? null, opts.checkIn, opts.checkOut])
  const ahead = await queryOne<{ n: string }>(
    `SELECT COUNT(*) AS n FROM unit_booking_waitlists
      WHERE unit_id=$1 AND status='waiting' AND created_at < (SELECT created_at FROM unit_booking_waitlists WHERE id=$2)`,
    [unit.id, ins[0].id])
  return { waitlistId: ins[0].id, position: Number(ahead?.n ?? 0) + 1 }
}

/**
 * Promote the earliest still-waiting guest whose dates are now actually free.
 * Mints a 1-hour claim token + emails them. One promotion at a time per unit:
 * if a guest is already 'notified' and unexpired, do nothing (wait for them).
 */
export async function promoteNextWaitlister(unitId: string): Promise<boolean> {
  const client = await getClient()
  try {
    await client.query('BEGIN')
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`waitlist:${unitId}`])

    // The freed unit's property — so property-wide waiters (unit_id NULL, any
    // unit at the property) are considered alongside this unit's own waiters.
    const propRow = await client.query<{ property_id: string }>(
      `SELECT property_id FROM units WHERE id=$1`, [unitId])
    const propId = propRow.rows[0]?.property_id ?? null

    // Someone already holding an unexpired claim for this unit or this property? leave it.
    const active = await client.query(
      `SELECT 1 FROM unit_booking_waitlists
        WHERE (unit_id=$1 OR (unit_id IS NULL AND property_id=$2)) AND status='notified' AND claim_expires_at > now() LIMIT 1`,
      [unitId, propId])
    if (active.rows.length > 0) { await client.query('COMMIT'); return false }

    const waiting = await client.query<any>(
      `SELECT * FROM unit_booking_waitlists
        WHERE (unit_id=$1 OR (unit_id IS NULL AND property_id=$2)) AND status='waiting'
        ORDER BY created_at ASC`, [unitId, propId])
    for (const w of waiting.rows) {
      if (await hasConflict(client, unitId, w.check_in, w.check_out)) continue
      const token = crypto.randomBytes(24).toString('hex')
      const expires = DateTime.now().plus({ minutes: WAITLIST_CLAIM_WINDOW_MINUTES }).toISO()
      // Pin a property-wide waiter to the freed unit so the claim books it.
      await client.query(
        `UPDATE unit_booking_waitlists
            SET status='notified', unit_id=$4, claim_token=$1, notified_at=now(), claim_expires_at=$2, updated_at=now()
          WHERE id=$3`, [token, expires, w.id, unitId])
      await client.query('COMMIT')
      await emailClaimLink(w, token).catch(err => logger.error({ err, waitlist_id: w.id }, '[waitlist] claim email failed'))
      return true
    }
    await client.query('COMMIT')
    return false
  } catch (e) {
    try { await client.query('ROLLBACK') } catch {}
    throw e
  } finally {
    client.release()
  }
}

async function emailClaimLink(w: any, token: string): Promise<void> {
  const slugRow = await queryOne<{ booking_slug: string; name: string }>(
    `SELECT booking_slug, name FROM properties WHERE id=$1`, [w.property_id])
  if (!slugRow) return
  const url = `${publicBaseUrl()}/property/${slugRow.booking_slug}/claim/${token}`
  const html = `
    <h2>A spot just opened up</h2>
    <p>Good news ${w.guest_name} — a stay at <b>${slugRow.name}</b> for ${w.check_in} → ${w.check_out} is now available.</p>
    <p>You have <b>1 hour</b> to claim it before it rolls to the next person.</p>
    <p><a href="${url}" style="display:inline-block;padding:12px 20px;background:#c9a227;color:#10141f;border-radius:8px;text-decoration:none;font-weight:700">Claim your stay</a></p>
    <p style="color:#888;font-size:12px">${url}</p>`
  await sendNotificationEmail({
    to: w.guest_email,
    subject: `Your waitlisted stay at ${slugRow.name} is available`,
    html,
    notificationType: 'waitlist_claim_link',
    landlordId: w.landlord_id,
  })
}

export async function getWaitlistClaim(token: string): Promise<any | null> {
  return queryOne<any>(
    `SELECT w.*, p.name AS property_name, p.booking_slug, u.unit_number
       FROM unit_booking_waitlists w
       JOIN properties p ON p.id=w.property_id
       JOIN units u ON u.id=w.unit_id
      WHERE w.claim_token=$1`, [token])
}

/** Claim a promoted waitlist spot → a tentative booking + deposit checkout. */
export async function claimWaitlistSpot(token: string, _stayType?: 'nightly' | 'weekly'): Promise<BookingDepositResult> {
  const w = await getWaitlistClaim(token)
  if (!w) throw new AppError(404, 'Claim link not found')
  if (w.status !== 'notified') throw new AppError(409, 'This claim is no longer available')
  if (!w.claim_expires_at || new Date(w.claim_expires_at) < new Date()) throw new AppError(409, 'This claim window has expired')

  const result = await bookStay({
    slug: w.booking_slug, unitId: w.unit_id,
    guestName: w.guest_name, guestEmail: w.guest_email, guestPhone: w.guest_phone,
    checkIn: w.check_in instanceof Date ? w.check_in.toISOString().slice(0, 10) : String(w.check_in).slice(0, 10),
    checkOut: w.check_out instanceof Date ? w.check_out.toISOString().slice(0, 10) : String(w.check_out).slice(0, 10),
  })
  await query(`UPDATE unit_booking_waitlists SET status='claimed', claimed_booking_id=$1, updated_at=now() WHERE id=$2`,
    [result.bookingId, w.id])
  return result
}

/**
 * Sweep: expire abandoned tentative holds and stale waitlist claims, promoting
 * the next waitlister for any unit a cancellation/expiry frees. Cron-driven.
 */
export async function sweepBookingHoldsAndClaims(): Promise<{ holdsExpired: number; claimsExpired: number; promoted: number }> {
  const expiredHolds = await query<{ unit_id: string }>(
    `UPDATE unit_bookings SET status='cancelled', updated_at=now()
      WHERE status='tentative' AND hold_expires_at IS NOT NULL AND hold_expires_at < now()
      RETURNING unit_id`)
  const expiredClaims = await query<{ unit_id: string }>(
    `UPDATE unit_booking_waitlists SET status='expired', updated_at=now()
      WHERE status='notified' AND claim_expires_at IS NOT NULL AND claim_expires_at < now()
      RETURNING unit_id`)
  const units = new Set<string>([...expiredHolds.map(r => r.unit_id), ...expiredClaims.map(r => r.unit_id)])
  let promoted = 0
  for (const unitId of units) {
    try { if (await promoteNextWaitlister(unitId)) promoted++ }
    catch (e) { logger.error({ err: e, unit_id: unitId }, '[booking-sweep] promote failed') }
  }
  return { holdsExpired: expiredHolds.length, claimsExpired: expiredClaims.length, promoted }
}
