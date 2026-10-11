import crypto from 'crypto'
import { DateTime } from 'luxon'
import type { PoolClient } from 'pg'
import { getClient, query, queryOne } from '../db'
import { AppError } from '../middleware/errorHandler'
import { getStripe } from '../lib/stripe'
import { recordHeldItem } from './heldPayouts'
import { sendNotificationEmail } from './email'
import { logger } from '../lib/logger'
import { todayIn } from '../lib/timezone'
import {
  WAITLIST_CLAIM_WINDOW_MINUTES, priceStay, BOOKING_MONTHLY_DEPOSIT_DEFAULT,
  SHORT_STAY_LOCKED_UNIT_TYPES, processingFeeFor, stayHeldWords, longCalendarDate,
  STAY_LEASE_CHOICE_NIGHTS, type CardFeePayer, type StayTerms,
} from '@gam/shared'
import {
  stayNeeds, chooseStayTerms, recordScreeningPrepayment, type StayNeeds, type RecordedPrepayment,
} from './stayTerms'
import { LEASE_OR_STAY_WORDS, dueNowFor, firstStayMonth, leaseFromStay, type DueNow } from './propertyBookingQuote'
import { activateBillingForMoneyMoved } from './billingActivation'

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

/**
 * Guest-facing storefront URL for a property (S544 — supersedes the legacy
 * customer-portal base for booking returns and claim links). The template's
 * {slug} token covers both hosting modes: path-slug in dev
 * (http://localhost:3015/{slug}) and subdomain in prod
 * ({slug}.gam.biz).
 *
 * S636 (Nic): "the QR code link is generated from localhost three thousand
 * and fifteen. That means that's not gonna work at all."
 *
 * STOREFRONT_URL_TEMPLATE was never set in production, and the fallback was
 * the DEV one — so every link this builds had been emitting
 * http://localhost:3015/... on the live API: guest stay links emailed at
 * booking, Stripe checkout success/cancel returns, and waitlist claim
 * links. All of them dead for anyone who was not on this Mac.
 *
 * The env var is now set, but the default is what makes that mistake
 * unrepeatable: in production the fallback is the PUBLIC template, so a
 * missing variable can never again silently hand a guest a localhost URL.
 * Dev keeps the path-slug form.
 */
export function storefrontUrl(slug: string, path = ''): string {
  const template = process.env.STOREFRONT_URL_TEMPLATE
    || (process.env.NODE_ENV === 'production'
          ? 'https://{slug}.gam.biz'
          : 'http://localhost:3015/{slug}')
  return template.replace('{slug}', slug) + path
}

interface PropertyRow {
  id: string; landlord_id: string; name: string; booking_slug: string
  booking_deposit_pct: string
  booking_monthly_deposit: string | null
  booking_card_fee_payer: CardFeePayer
  nightly_rate: string | null; weekly_rate: string | null; monthly_rate: string | null
  short_term_tax_rate: string | null
  timezone: string | null
  rent_due_mode: string | null
  rent_due_day: number | null
}
interface UnitRow {
  id: string; unit_number: string
  nightly_rate: string | null; weekly_rate: string | null; monthly_rate: string | null
  rent_amount: string | null
  min_stay_nights: number | null; max_stay_nights: number | null; is_bookable: boolean
}

async function resolvePropertyBySlug(slug: string): Promise<PropertyRow> {
  const prop = await queryOne<PropertyRow>(
    `SELECT id, landlord_id, name, booking_slug, booking_deposit_pct, booking_monthly_deposit, booking_card_fee_payer,
            nightly_rate, weekly_rate, monthly_rate, short_term_tax_rate, timezone, rent_due_mode, rent_due_day
       FROM properties WHERE booking_slug=$1 AND public_booking_enabled=TRUE`, [slug])
  if (!prop) throw new AppError(404, 'Booking site not found')
  return prop
}

async function resolveUnit(propertyId: string, unitId: string): Promise<UnitRow> {
  const unit = await queryOne<UnitRow & { unit_type?: string }>(
    `SELECT u.id, u.unit_number, u.unit_type, u.nightly_rate, u.weekly_rate, u.monthly_rate, u.rent_amount,
            u.min_stay_nights, u.max_stay_nights, u.is_bookable
       FROM units u
      WHERE u.id=$1 AND u.property_id=$2`, [unitId, propertyId])
  if (!unit || !unit.is_bookable) throw new AppError(404, 'Unit not bookable')
  // S538 (Nic): storage is hard-locked out of short-term rental — belt over
  // the config gates, covers legacy rows flagged bookable before the lock.
  if ((SHORT_STAY_LOCKED_UNIT_TYPES as readonly string[]).includes(unit.unit_type ?? '')) {
    throw new AppError(404, 'Unit not bookable')
  }
  return unit
}

interface StayQuote { nights: number; base: number; tax: number; total: number; deposit: number; tier: 'nightly' | 'weekly' | 'monthly' }

/** The rates a stay on this unit prices from: the unit's, else the property default. */
function stayRates(unit: UnitRow, prop: PropertyRow): { nightly: number | null; weekly: number | null; monthly: number | null } {
  const num = (x: string | null) => x != null ? Number(x) : null
  return {
    nightly: num(unit.nightly_rate) ?? num(prop.nightly_rate),
    weekly:  num(unit.weekly_rate)  ?? num(prop.weekly_rate),
    monthly: num(unit.monthly_rate) ?? num(prop.monthly_rate),
  }
}

/** Validate the requested stay against the unit's rules and price it + the deposit.
 *  The guest does not pick a billing type (Nic 2026-06-27). 10/6 (Nic): the
 *  price is the one every door charges for these nights — the cheapest whole
 *  months, weeks and nights that cover them (shared priceStay), never
 *  prorated. Rates pull from the UNIT, falling back to the PROPERTY default.
 *  Short-term lodging tax (property-level `short_term_tax_rate`, landlord-set
 *  for their city/state) is added to a stay under 30 nights; 30+ is
 *  tax-exempt. The deposit % then applies to the taxed total (a 30+ night
 *  stay owes the flat monthly deposit instead). */
function quoteStay(unit: UnitRow, prop: PropertyRow, checkIn: string, checkOut: string): StayQuote {
  const ci = DateTime.fromISO(checkIn), co = DateTime.fromISO(checkOut)
  if (!ci.isValid || !co.isValid) throw new AppError(400, 'Invalid dates')
  const nights = Math.round(co.startOf('day').diff(ci.startOf('day'), 'days').days)
  if (nights <= 0) throw new AppError(400, 'Check-out must be after check-in')
  // S654: "past" on the park's calendar, not the server's. A UTC server called a
  // same-day check-in booked at 6 pm Phoenix "yesterday".
  if (ci.toISODate()! < todayIn(prop.timezone)) throw new AppError(400, 'Check-in is in the past')
  if (unit.min_stay_nights != null && nights < unit.min_stay_nights) throw new AppError(400, `Minimum stay is ${unit.min_stay_nights} nights`)
  if (unit.max_stay_nights != null && nights > unit.max_stay_nights) throw new AppError(400, `Maximum stay is ${unit.max_stay_nights} nights`)
  // Rate resolution mirrors the availability quote exactly: the unit's rate,
  // then the property default. S613: the unit's rate IS its subtype's rate —
  // the subtype owns pricing and the DB trigger keeps its units on it — so the
  // separate site-type tier that used to sit in front of this is gone, along
  // with the chance of the two tiers disagreeing.
  const rates = stayRates(unit, prop)
  const price = priceStay(rates, prop.short_term_tax_rate, checkIn, nights)
  if (price.total <= 0) throw new AppError(400, 'No rate is configured for this unit')
  const deposit = depositForStay(prop, { total: price.total, nights, monthlyRate: rates.monthly })
  return { nights, base: price.base, tax: price.tax, total: price.total, deposit, tier: price.tier }
}

/**
 * The deposit on a stay, from the property's own two settings.
 *
 * A flat amount for a stay of 30+ nights (S547: the percentage is for short
 * stays only) — hard-capped at one month's rent regardless of what the flat
 * setting says. Everything shorter is a percentage of the taxed total.
 * 10/6: decided by the stay's LENGTH, not by the rate it is charged at — a
 * 25-night stay charged at the monthly rate (the lower price) is still a short
 * stay and owes the percentage.
 *
 * S652: pulled out of quoteStay so a reservation taken at the COUNTER quotes
 * the same deposit the booking site would have. A guest who phones and a guest
 * who books online are buying the same nights on the same site and must not be
 * told two different numbers. (memory: gam-register-price-is-its-own-thing)
 */
export function depositForStay(
  prop: { booking_deposit_pct: string | number; booking_monthly_deposit: string | number | null },
  stay: { total: number; nights: number; monthlyRate: number | null },
): number {
  if (stay.nights >= STAY_LEASE_CHOICE_NIGHTS && stay.monthlyRate != null && stay.monthlyRate > 0) {
    const flat = prop.booking_monthly_deposit != null
      ? Number(prop.booking_monthly_deposit) : BOOKING_MONTHLY_DEPOSIT_DEFAULT
    return Math.round(Math.min(flat, stay.monthlyRate) * 100) / 100
  }
  return Math.round(stay.total * (Number(prop.booking_deposit_pct) / 100) * 100) / 100
}

/**
 * What deposit to ask for on a reservation the counter just took.
 *
 * Deliberately NOT quoteStay: that one also enforces the booking site's gates
 * (minimum stay, maximum stay, no past check-in), and a staff reservation is
 * allowed to break all three — somebody standing at the desk can book one night
 * where the website requires two. Only the money is shared.
 */
export async function quoteStayDeposit(
  unitId: string, checkIn: string, checkOut: string,
): Promise<number> {
  const row = await queryOne<any>(
    `SELECT u.nightly_rate, u.weekly_rate, u.monthly_rate,
            p.nightly_rate AS p_nightly, p.weekly_rate AS p_weekly, p.monthly_rate AS p_monthly,
            p.short_term_tax_rate, p.booking_deposit_pct, p.booking_monthly_deposit
       FROM units u JOIN properties p ON p.id = u.property_id
      WHERE u.id = $1`, [unitId])
  if (!row) throw new AppError(404, 'Unit not found')
  const num = (x: any) => x != null ? Number(x) : null
  const monthlyRate = num(row.monthly_rate) ?? num(row.p_monthly)
  const nights = Math.round(
    DateTime.fromISO(checkOut).startOf('day').diff(DateTime.fromISO(checkIn).startOf('day'), 'days').days)
  const price = priceStay(
    { nightly: num(row.nightly_rate) ?? num(row.p_nightly),
      weekly:  num(row.weekly_rate)  ?? num(row.p_weekly),
      monthly: monthlyRate },
    row.short_term_tax_rate, checkIn, nights)
  return depositForStay(row, { total: price.total, nights, monthlyRate })
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
    // S593: the Master Schedule is the single occupancy source of truth — a unit
    // can be offered on BOTH public channels (short-term booking + long-term
    // listing), so availability must respect BOTH. A short-term booking is
    // blocked by an overlapping booking OR an overlapping active/pending
    // long-term lease (end_date NULL = open-ended m2m) — the same active+pending
    // occupancy model the best-fit ranker uses. This closes the write-time gap
    // for paths that bypass the ranker (e.g. claimWaitlistSpot → bookStay) and
    // stops the two surfaces from contradicting into a double-occupancy.
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
       -- S649: an out-of-order site can't take a stay
       OR unit_out_of_order_overlaps($1, $3::date, $2::date)
     LIMIT 1`,
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
  // S547: optional guest question submitted with the reservation.
  note?: string | null
  // Legacy — the guest no longer picks a billing type; pricing auto-tiers by
  // length. Accepted for backward compat but ignored.
  stayType?: 'nightly' | 'weekly'
  // W-20 (S531): the guest books a SITE TYPE, not a unit — these stamp what
  // the booking is entitled to, so the nightly compressor can re-site it to
  // any compatible unit. 'none' = no requirement (any site).
  requiredSiteLayout?: string | null
  requiredAmpService?: string | null
  // 10/5 (Nic, R2): the guest's answer for a stay of 30+ nights — a lease or a
  // stay. Required once their continuous stay here reaches 30 nights.
  stayTerms?: StayTerms | null
}

export interface BookingDepositResult {
  bookingId: string
  /** The stay's part of the charge: a deposit, or a no-lease stay's first month. */
  depositAmount: number
  /** GAM's card fee on the whole charge (0 when the property covers it). */
  cardFee: number
  /** What the booking itself covers (a no-lease stay: its first month). */
  total: number
  checkoutUrl: string
  /** 10/5 (R8): the background check on this charge — 0 when none is due. */
  screeningFee: number
  /** Everything charged now: the stay's part + the check + the card fee. */
  dueNow: number
  /** The booking's own check-out: a no-lease stay of 30+ nights is booked a month at a time (R5). */
  checkOut: string
  stayTerms: StayTerms | null
  /** R13: "Your site is held through …" — a 30+ night stay with no lease. */
  heldWords: string | null
}

/**
 * 10/5 (Nic, R2): a stay of 30+ continuous nights can't be booked until the
 * guest has chosen a lease or a stay. The booking page asks before paying;
 * this catches the case it could not see (a guest whose back-to-back stays
 * here add up to 30).
 */
export class StayTermsNeededError extends AppError {
  readonly words = LEASE_OR_STAY_WORDS
  constructor() { super(409, 'A stay of 30 nights or more needs a choice first: a lease or a stay.') }
}

/** What a booking-site stay books and charges for this guest — the one plan the checkout charges and the claim page shows. */
interface StayPlan {
  needs: StayNeeds
  terms: StayTerms | null
  checkOut: string
  nights: number
  tier: 'nightly' | 'weekly' | 'monthly'
  /** R5: this charge is a no-lease 30+ night stay's first month (not a deposit). */
  firstMonth: boolean
  /** The stay's part of the charge: a deposit, or a no-lease stay's first month. */
  stayPart: number
  /** What the booking covers. */
  total: number
  due: DueNow
  heldWords: string | null
}

/**
 * 10/5 (Nic): the long-stay rules for a booking-site stay, from
 * services/stayTerms — never decided here.
 *   R7     the guest's back-to-back stays at this property add up (by email);
 *   R2     30+ nights → lease or stay (StayTermsNeededError until answered);
 *   R5     a STAY books and pays its first month only, at the monthly rate;
 *          a LEASE pays today's deposit and the lease bills the rest;
 *   R1/R8  22+ nights with no check on file → the background check's fee is
 *          a fixed line on this charge.
 */
async function planStay(
  prop: PropertyRow, unit: UnitRow,
  o: { checkIn: string; checkOut: string; email: string; stayTerms?: StayTerms | null },
): Promise<StayPlan> {
  const quote = quoteStay(unit, prop, o.checkIn, o.checkOut)
  const ask = (checkOut: string, stayTerms: StayTerms | null) => stayNeeds({
    landlordId: prop.landlord_id, propertyId: prop.id, email: o.email,
    checkIn: o.checkIn, checkOut, stayTerms,
  })
  let needs = await ask(o.checkOut, o.stayTerms ?? null)
  if (needs.leaseChoice === 'needed') throw new StayTermsNeededError()
  const terms: StayTerms | null = needs.leaseChoice === 'lease' || needs.leaseChoice === 'stay' ? needs.leaseChoice : null

  // R5: a stay asked for 30+ nights with no lease is booked a month at a time.
  // (A short stay that continues one only inherits the answer — it is priced
  // as the short stay it is.)
  const first = terms === 'stay' && quote.nights >= STAY_LEASE_CHOICE_NIGHTS
    ? firstStayMonth(o.checkIn, o.checkOut, stayRates(unit, prop), Number(prop.short_term_tax_rate || 0))
    : null
  // The rules for the dates actually booked.
  if (first && first.checkOut !== o.checkOut) needs = await ask(first.checkOut, terms)

  const screening = needs.screening === 'fee_due' ? needs.screeningFee?.amount ?? 0 : 0
  const stayPart = first ? first.amount : quote.deposit
  const checkOut = first?.checkOut ?? o.checkOut
  return {
    needs, terms, checkOut,
    nights: first ? first.nights : quote.nights,
    tier: first ? 'monthly' : quote.tier,
    firstMonth: first != null,
    stayPart,
    total: first ? first.amount : quote.total,
    due: dueNowFor(stayPart, screening, prop.booking_card_fee_payer),
    heldWords: terms === 'stay' ? stayHeldWords(checkOut) : null,
  }
}

/**
 * 10/6: a booking-site stay's lease_type from its length (as the schedule's
 * new-reservation form decides it): a no-lease stay's first month or 30+
 * nights is month_to_month, 7+ weekly, else nightly.
 */
export function bookingSiteLeaseType(plan: { firstMonth: boolean; nights: number }): 'nightly' | 'weekly' | 'month_to_month' {
  if (plan.firstMonth || plan.nights >= STAY_LEASE_CHOICE_NIGHTS) return 'month_to_month'
  return plan.nights >= 7 ? 'weekly' : 'nightly'
}

/**
 * The booking site's Stripe checkout, line by line: the stay's part (a deposit,
 * or a no-lease stay's first month), the background check when one is due
 * (10/5, R8: its own line, never folded into the stay and never removable),
 * and GAM's card fee. Card only; the charge is GAM's (S648) and the webhook
 * confirms the booking on checkout.session.completed (gam_purpose
 * 'booking_deposit'), as before. The check's fee rides in the metadata
 * (gam_screening_fee) so the confirmation reads what was charged (M12).
 */
async function createSiteCheckoutSession(o: {
  lines: Array<{ name: string; cents: number }>
  guestEmail: string
  successUrl: string
  cancelUrl: string
  metadata: Record<string, string>
}): Promise<{ sessionId: string; hostedUrl: string }> {
  const metadata = { gam_purpose: 'booking_deposit', ...o.metadata }
  const session = await getStripe().checkout.sessions.create({
    mode: 'payment',
    payment_method_types: ['card'],
    line_items: o.lines.filter(l => l.cents > 0).map(l => ({
      quantity: 1,
      price_data: { currency: 'usd', unit_amount: l.cents, product_data: { name: l.name.slice(0, 250) } },
    })),
    payment_intent_data: { metadata },
    metadata,
    customer_email: o.guestEmail,
    success_url: o.successUrl,
    cancel_url: o.cancelUrl,
    // 10/5: the card page closes when the hold does. Stripe's default is 24
    // hours, while the sweep cancels the hold after HOLD_MINUTES — a guest who
    // paid after that was charged on GAM's account for a booking that no
    // longer existed, and nothing recorded the money. Stripe needs at least 30
    // minutes, so this is the hold plus a minute; a payment in that last
    // minute (or a webhook that arrives after the sweep) is caught by
    // confirmBookingDeposit's paid-after-the-hold path.
    expires_at: Math.floor(Date.now() / 1000) + HOLD_MINUTES * 60 + 60,
  })
  if (!session.url) throw new AppError(500, 'Stripe returned a Checkout Session with no URL')
  return { sessionId: session.id, hostedUrl: session.url }
}

/**
 * Create a tentative booking holding the dates, then a Stripe checkout.
 * Throws UnitFullError when the dates are taken (the caller offers the
 * waitlist) and StayTermsNeededError when a 30+ night stay has no answer yet.
 * Concurrency-safe via a per-unit advisory lock inside the transaction.
 *
 * 10/5 (Nic, R3): no lease is drafted here, or anywhere, on its own. A lease
 * is drafted only when the guest chose one, once their payment lands
 * (confirmBookingDeposit → stayTerms.chooseStayTerms).
 */
export async function bookStay(opts: GuestBooking): Promise<BookingDepositResult> {
  const prop = await resolvePropertyBySlug(opts.slug)
  const unit = await resolveUnit(prop.id, opts.unitId)
  const plan = await planStay(prop, unit, {
    checkIn: opts.checkIn, checkOut: opts.checkOut, email: opts.guestEmail, stayTerms: opts.stayTerms,
  })
  const connect = await landlordConnect(prop.landlord_id)
  // S547 dev-mock: demo landlords have no Connect account, so outside
  // production a Connect-less landlord gets a SIMULATED deposit checkout and
  // the whole guest flow is walkable end-to-end. A dev landlord WITH Connect
  // still exercises real Stripe; in production the gate below is absolute.
  const mockCheckout = process.env.NODE_ENV !== 'production' && !connect
  if (!connect && !mockCheckout) throw new AppError(409, 'This property is not accepting online deposits yet')

  const client = await getClient()
  try {
    await client.query('BEGIN')
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`unit_booking:${unit.id}`])
    if (await hasConflict(client, unit.id, opts.checkIn, plan.checkOut)) {
      await client.query('ROLLBACK')
      throw new UnitFullError()
    }
    const holdExpires = DateTime.now().plus({ minutes: HOLD_MINUTES }).toISO()
    const ins = await client.query<{ id: string }>(
      `INSERT INTO unit_bookings
         (unit_id, landlord_id, lease_type, check_in, check_out, nights,
          guest_name, guest_email, guest_phone, nightly_rate, weekly_rate,
          total_amount, deposit_amount, platform_fee, status, source, hold_expires_at,
          required_site_layout, required_amp_service, notes, stay_terms, screening_required)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,0,'tentative','public',$14,$15,$16,$17,$18,$19)
       RETURNING id`,
      // unit_bookings.lease_type has no 'monthly' — 30+ night stays store as
      // month_to_month (pre-existing gap: monthly-tier public bookings always
      // violated the CHECK; surfaced by the S547 long-stay flow). A month of a
      // no-lease stay is one too, whatever its nights (a February is 28).
      // 10/6: the stay's LENGTH decides it, never the rate it was charged at —
      // a 25-night stay charged the monthly price is still a short stay
      // (occupancy, the dashboard and payout triggers count nightly/weekly).
      [unit.id, prop.landlord_id, bookingSiteLeaseType(plan), opts.checkIn, plan.checkOut, plan.nights,
       opts.guestName, opts.guestEmail, opts.guestPhone ?? null,
       unit.nightly_rate, unit.weekly_rate, plan.total, plan.stayPart, holdExpires,
       opts.requiredSiteLayout ?? 'none', opts.requiredAmpService ?? 'none',
       opts.note?.trim() || null,
       // R2: the answer is saved with the stay; R9: check-in waits on screening.
       plan.terms, plan.needs.screening !== 'not_needed'])
    const bookingId = ins.rows[0].id
    await client.query('COMMIT')

    // S547: every public booking emails the guest their STAY LINK — the
    // tokened page on the property's site where amenities are booked (Nic:
    // amenity booking must never look publicly bookable). Best-effort.
    ;(async () => {
      const { issueBookingGuestToken } = await import('./bookingGuestTokens')
      const issued = await issueBookingGuestToken({ bookingId, landlordId: prop.landlord_id, delivery: 'email' })
      const { emailGuestStayLink } = await import('./email')
      // 10/5: replies reach the people who run this property (services/replyRouting).
      await emailGuestStayLink(opts.guestEmail, opts.guestName, prop.name,
        storefrontUrl(prop.booking_slug, `/stay/${issued.token}`),
        { landlordId: prop.landlord_id, replyTo: { kind: 'property', propertyId: prop.id } })
    })().catch(err => logger.error({ err, bookingId }, '[propertyBooking] guest stay-link email failed'))

    const result = (checkoutUrl: string): BookingDepositResult => ({
      bookingId, depositAmount: plan.stayPart, cardFee: plan.due.cardFee, total: plan.total, checkoutUrl,
      screeningFee: plan.due.screening, dueNow: plan.due.total,
      checkOut: plan.checkOut, stayTerms: plan.terms, heldWords: plan.heldWords,
    })

    if (mockCheckout) {
      // Mirror the real path: stamp a session id, then confirm through the
      // same function the Stripe webhook calls.
      const mockSession = `mock_${bookingId}`
      await query(`UPDATE unit_bookings SET stripe_checkout_session_id=$1, updated_at=now() WHERE id=$2`,
        [mockSession, bookingId])
      await confirmBookingDeposit(bookingId, mockSession)
      logger.warn({ bookingId }, '[propertyBooking] dev-mock checkout — landlord has no Connect account, deposit simulated, booking auto-confirmed')
      return { ...result(storefrontUrl(prop.booking_slug, `/booked?booking=${bookingId}`)), cardFee: 0, dueNow: round2(plan.due.stay + plan.due.screening) }
    }

    // S648: GAM's charge; the stay's money is held for the landlord (whose
    // payout account the gate above requires). GAM's card fee is on the whole
    // charge — on top unless the property covers it, then it comes out of the
    // payout. W-20: no site number — the site is assigned the morning of
    // check-in and the nightly packer may move it before then.
    const checkout = await createSiteCheckoutSession({
      lines: [
        { name: plan.firstMonth
            ? `First month — ${prop.name}, through ${longCalendarDate(plan.checkOut)}`
            : `Stay deposit — ${prop.name}`,
          cents: Math.round(plan.due.stay * 100) },
        { name: 'Background check — required for stays over three weeks', cents: Math.round(plan.due.screening * 100) },
        { name: 'Card processing fee', cents: Math.round(plan.due.cardFee * 100) },
      ],
      guestEmail: opts.guestEmail,
      successUrl: storefrontUrl(prop.booking_slug, `/booked?booking=${bookingId}`),
      cancelUrl:  storefrontUrl(prop.booking_slug),
      metadata: {
        gam_booking_id: bookingId, gam_landlord_id: prop.landlord_id,
        ...(plan.due.screening > 0 ? { gam_screening_fee: plan.due.screening.toFixed(2) } : {}),
      },
    })
    await query(`UPDATE unit_bookings SET stripe_checkout_session_id=$1, updated_at=now() WHERE id=$2`,
      [checkout.sessionId, bookingId])
    return result(checkout.hostedUrl)
  } catch (e) {
    try { await client.query('ROLLBACK') } catch {}
    throw e
  } finally {
    client.release()
  }
}

/**
 * The claim page's figures for a promoted waitlister — the same plan the
 * claim's checkout charges (planStay). For a 30+ night stay, both answers are
 * priced so the guest chooses before paying (R2).
 */
export async function claimQuote(token: string): Promise<null | {
  nights: number
  screeningFee: number | null
  askStayTerms: boolean
  words: string | null
  dueNow: DueNow | null
  lease: { dueNow: DueNow; monthlyRent: number | null; rentWords: string } | null
  stay: { dueNow: DueNow; checkOut: string; heldWords: string | null } | null
}> {
  const w = await getWaitlistClaim(token)
  if (!w) return null
  const prop = await resolvePropertyBySlug(w.booking_slug)
  const unit = await resolveUnit(prop.id, w.unit_id)
  const o = { checkIn: w.check_in_ymd, checkOut: w.check_out_ymd, email: w.guest_email }
  try {
    const plain = await planStay(prop, unit, o)
    return {
      nights: plain.needs.nights, screeningFee: plain.due.screening || null,
      askStayTerms: false, words: null, dueNow: plain.due, lease: null, stay: null,
    }
  } catch (e) {
    if (!(e instanceof StayTermsNeededError)) throw e
  }
  const lease = await planStay(prop, unit, { ...o, stayTerms: 'lease' })
  const stay = await planStay(prop, unit, { ...o, stayTerms: 'stay' })
  return {
    nights: lease.needs.nights, screeningFee: lease.due.screening || null,
    askStayTerms: true, words: LEASE_OR_STAY_WORDS, dueNow: null,
    lease: { dueNow: lease.due, ...leaseFromStay(prop, unit, stayRates(unit, prop).monthly, o.checkIn) },
    stay: { dueNow: stay.due, checkOut: stay.checkOut, heldWords: stay.heldWords },
  }
}

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100

/**
 * 10/5 (R8, review M12): the background check a booking-site charge carried —
 * exactly the fee its Stripe checkout was built with (bookStay's
 * gam_screening_fee metadata), never worked out again now. Between the hold and
 * the payment the fee's price can change, or a check can come on file; the
 * money already charged is what counts. 0 when the checkout carried none.
 *
 * `fromCheckout` is that metadata value when the caller already holds the
 * session (undefined = not known, so the session is read from Stripe).
 */
async function screeningCarried(
  bookingId: string, sessionId: string, chargedCents: number, fromCheckout: string | number | null | undefined,
): Promise<number> {
  const b = await queryOne<{ deposit_amount: string | null; payer: CardFeePayer; status: string; screening_required: boolean }>(
    `SELECT b.deposit_amount::text AS deposit_amount, p.booking_card_fee_payer AS payer, b.status, b.screening_required
       FROM unit_bookings b JOIN units u ON u.id = b.unit_id JOIN properties p ON p.id = u.property_id
      WHERE b.id = $1 AND b.stripe_checkout_session_id = $2`, [bookingId, sessionId])
  // bookStay marks a stay that needs screening when it takes the hold; any
  // other booking's checkout never carried the line.
  if (!b || b.status !== 'tentative' || !b.screening_required) return 0
  let raw = fromCheckout
  if (raw === undefined) {
    // A failed read throws: confirming without knowing whose money the charge
    // is would hold GAM's check money for the landlord.
    const session = await getStripe().checkout.sessions.retrieve(sessionId)
    raw = session.metadata?.gam_screening_fee ?? null
  }
  const fee = round2(Number(raw ?? 0))
  if (!(fee > 0)) return 0
  const cents = (n: number) => Math.round(n * 100)
  if (cents(fee) > chargedCents) {
    logger.error({ bookingId, fee, chargedCents },
      '[propertyBooking] the checkout\'s background check is more than was charged — no screening recorded; a person should look')
    return 0
  }
  if (cents(dueNowFor(Number(b.deposit_amount ?? 0), fee, b.payer).total) !== chargedCents) {
    logger.error({ bookingId, fee, chargedCents },
      '[propertyBooking] booking-site charge differs from the stay plus its background check — the check is recorded as the checkout carried it; a person should look')
  }
  return fee
}

/**
 * 10/5 — a booking-site payment that landed after its hold was gone: the sweep
 * cancelled the booking (the guest paid after HOLD_MINUTES), or it was
 * cancelled another way, before the webhook arrived. The guest's money is on
 * GAM's account all the same, so (Nic: "money movement is the end of
 * onboarding") the landlord's free window ends when any of it was for the
 * stay, and a person is told to give it back or rebook the guest — the money
 * is never left without a word. A booking already confirmed (a webhook
 * delivered twice) is not this, and nothing happens.
 */
async function paidAfterTheHold(
  client: PoolClient, bookingId: string, sessionId: string,
  paymentIntentId: string | null, chargedCents: number,
): Promise<void> {
  const r = (await client.query<{ landlord_id: string; status: string; deposit_paid: boolean; deposit_amount: string | null; guest_name: string | null; guest_email: string | null }>(
    `SELECT landlord_id, status, deposit_paid_at IS NOT NULL AS deposit_paid, deposit_amount::text AS deposit_amount,
            guest_name, guest_email
       FROM unit_bookings WHERE id = $1 AND stripe_checkout_session_id = $2`, [bookingId, sessionId])).rows[0]
  if (!r || r.deposit_paid || r.status === 'confirmed') return
  // Part of it was for the stay (a checkout for the background check alone
  // carries no stay part, and that money is GAM's).
  if (Number(r.deposit_amount ?? 0) > 0) {
    await activateBillingForMoneyMoved(client, [r.landlord_id])
  }
  const seen = await client.query(
    `SELECT 1 FROM admin_notifications WHERE category = 'booking_paid_after_hold' AND context->>'stripe_checkout_session_id' = $1
     UNION ALL
     SELECT 1 FROM admin_notifications_archive WHERE category = 'booking_paid_after_hold' AND context->>'stripe_checkout_session_id' = $1
     LIMIT 1`, [sessionId])
  logger.error({ bookingId, sessionId, paymentIntentId, chargedCents, status: r.status },
    '[propertyBooking] a booking-site payment landed after the hold was gone — nothing recorded; a person must refund or rebook')
  if (seen.rows.length) return
  const { createAdminNotification } = await import('./adminNotifications')
  await createAdminNotification({
    severity: 'warn',
    category: 'booking_paid_after_hold',
    title: `A guest paid for a booking that was already ${r.status === 'cancelled' ? 'cancelled' : r.status}`,
    body: `${r.guest_name ?? 'A guest'}${r.guest_email ? ` (${r.guest_email})` : ''} paid $${(chargedCents / 100).toFixed(2)} on the booking site ` +
      `after the hold on their dates was gone. The money is on GAM's account and nothing was recorded for it. ` +
      `Refund it in Stripe (${paymentIntentId ?? sessionId}), or book the guest and record the payment.`,
    context: { booking_id: bookingId, stripe_checkout_session_id: sessionId, stripe_payment_intent_id: paymentIntentId,
               landlord_id: r.landlord_id, charged: (chargedCents / 100).toFixed(2) },
  })
}

/**
 * Mark a booking's deposit paid + confirm it (webhook-driven, idempotent).
 * S648: the deposit is GAM's to hold until the landlord's weekly payout; the
 * held item is written with the confirmation so neither happens without the
 * other. `paid` carries the checkout's PaymentIntent and amount (absent for
 * the dev mock, which moves no money).
 *
 * 10/5 (Nic): a background check on the charge (R8) is GAM's screening money —
 * never held for the landlord or counted as stay money (an early check-out
 * must not refund it to the card). It is recorded as a paid screening waiting
 * for the guest, who is emailed the link. Then the 30+ night answer is acted
 * on (R2): a lease is drafted for the landlord, or the stay is recorded and
 * the landlord told.
 */
export async function confirmBookingDeposit(
  bookingId: string, sessionId: string,
  paid?: {
    paymentIntentId: string | null; amountTotalCents: number | null
    /** The checkout's gam_screening_fee metadata, when the caller holds the session (omit to read it from Stripe). */
    screeningFee?: string | number | null
  },
): Promise<void> {
  const chargedCents = paid?.amountTotalCents ?? 0
  const screening = paid ? await screeningCarried(bookingId, sessionId, chargedCents, paid.screeningFee) : 0
  const client = await getClient()
  let confirmed: { stay_terms: StayTerms | null } | null = null
  let prepaid: RecordedPrepayment | null = null
  try {
    await client.query('BEGIN')
    const b = (await client.query<{
      landlord_id: string; deposit_amount: string | null; total_amount: string | null; stay_terms: StayTerms | null
      guest_email: string | null; tenant_id: string | null; property_id: string
    }>(
      `UPDATE unit_bookings b
          SET status='confirmed', deposit_paid_at=COALESCE(b.deposit_paid_at, now()),
              hold_expires_at=NULL, updated_at=now(),
              stripe_payment_intent_id=COALESCE(b.stripe_payment_intent_id, $3)
         FROM units u
        WHERE b.id=$1 AND u.id = b.unit_id AND b.stripe_checkout_session_id=$2 AND b.status='tentative'
        RETURNING b.landlord_id, b.deposit_amount::text AS deposit_amount, b.total_amount::text AS total_amount, b.stay_terms,
                  b.guest_email, b.tenant_id, u.property_id`,
      [bookingId, sessionId, paid?.paymentIntentId ?? null])).rows[0]
    confirmed = b ?? null
    if (!b && paid && chargedCents > 0) {
      await paidAfterTheHold(client, bookingId, sessionId, paid.paymentIntentId, chargedCents)
    }
    if (b && paid) {
      const deposit = Number(b.deposit_amount ?? 0)
      const charged = chargedCents / 100
      // GAM's fee is on the whole charge (the stay's part + any check), and
      // comes out whoever paid it: on top (charged = base + fee) or absorbed
      // (charged = base).
      const base = round2(deposit + screening)
      const cardFee = processingFeeFor({ amount: base, paymentMethod: 'card' })
      const baseCents = Math.round(base * 100)
      if (chargedCents !== baseCents && chargedCents !== baseCents + Math.round(cardFee * 100)) {
        logger.error({ bookingId, deposit, screening, cardFee, got: chargedCents }, '[propertyBooking] deposit amount mismatch — holding what was charged, less the card fee')
      }
      const held = round2(charged - cardFee - screening)
      // 10/5 (Nic): "money movement is the end of onboarding" — a guest's
      // payment toward a stay on the booking site ends the landlord's free
      // onboarding window. Only the stay's share: a checkout that carried
      // nothing but the background check is GAM's screening money, not the
      // company's payers' (the same line billingActivation draws).
      if (held > 0) {
        await activateBillingForMoneyMoved(client, [b.landlord_id])
      }
      if (held > 0) {
        await recordHeldItem({
          landlordId: b.landlord_id, sourceType: 'booking_deposit', sourceId: bookingId,
          // A no-lease stay's first month is paid whole, not as a deposit (R5).
          amount: held, description: Number(b.total_amount) > 0 && Number(b.total_amount) === deposit ? 'Stay payment' : 'Stay deposit',
        }, client)
      }
      // 10/4 (decisions #37.B, #38): the deposit is a payment toward the stay,
      // itemized — an early check-out gives it back to this card. Only the
      // stay's share of the card fee rides with it; the check's share is GAM's.
      if (paid.paymentIntentId) {
        const share = base > 0 ? deposit / base : 1
        const onTop = Math.max(0, charged - base)
        const { recordSiteDeposit } = await import('./stayPayments')
        await recordSiteDeposit(client, {
          bookingId, landlordId: b.landlord_id, paymentIntentId: paid.paymentIntentId,
          deposit, charged: round2(deposit + onTop * share), gamFee: round2(cardFee * share),
        })
      }
      if (screening > 0) {
        prepaid = await recordScreeningPrepayment(client, {
          landlordId: b.landlord_id, propertyId: b.property_id, bookingId,
          tenantId: b.tenant_id, email: b.guest_email, amount: screening, source: 'booking_site',
          // 10/5 (A5): the check's money was kept out of the landlord's held
          // share above — it is already on GAM's balance, so nothing is charged
          // back to the landlord.
          collectedBy: 'gam',
        })
      }
    }
    await client.query('COMMIT')
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    client.release()
  }

  // After commit: the guest's paid screening link, then the 30+ night answer.
  // Neither undoes the confirmation if it fails.
  if (prepaid) await prepaid.afterCommit()
  if (confirmed?.stay_terms) {
    await chooseStayTerms(bookingId, confirmed.stay_terms).catch(err =>
      logger.error({ err, bookingId }, '[propertyBooking] acting on the lease-or-stay answer failed'))
  }
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

    // S654: the calendar days as text — a pg DATE arrives as local midnight,
    // and its UTC string is the day before on any server east of UTC.
    const waiting = await client.query<any>(
      `SELECT *, check_in::text AS check_in_ymd, check_out::text AS check_out_ymd
         FROM unit_booking_waitlists
        WHERE (unit_id=$1 OR (unit_id IS NULL AND property_id=$2)) AND status='waiting'
        ORDER BY created_at ASC`, [unitId, propId])
    for (const w of waiting.rows) {
      if (await hasConflict(client, unitId, w.check_in_ymd, w.check_out_ymd)) continue
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
  const slugRow = await queryOne<{ booking_slug: string; name: string; landlord_id: string }>(
    `SELECT booking_slug, name, landlord_id FROM properties WHERE id=$1`, [w.property_id])
  if (!slugRow) return
  const url = storefrontUrl(slugRow.booking_slug, `/claim/${token}`)
  const esc = (x: string) => String(x ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  // 10/5 (Nic): what a long stay asks of them before they pay — the background
  // check's fee (R8, from stayNeeds) and the lease-or-stay choice (R2).
  const needs = await stayNeeds({
    landlordId: slugRow.landlord_id, propertyId: w.property_id, email: w.guest_email,
    checkIn: w.check_in_ymd, checkOut: w.check_out_ymd,
  }).catch(err => { logger.error({ err, waitlist_id: w.id }, '[waitlist] long-stay rules for the claim email failed'); return null })
  const longStay = [
    needs?.screening === 'fee_due' && needs.screeningFee
      ? `<p>Your stay is longer than three weeks, so a background check is required before check-in. Its $${needs.screeningFee.amount.toFixed(2)} fee is added when you pay.</p>`
      : '',
    needs?.leaseChoice === 'needed'
      ? `<p>It's 30 nights or more, so when you claim it you'll choose a lease or a stay. ${esc(LEASE_OR_STAY_WORDS)}</p>`
      : '',
  ].join('')
  const html = `
    <h2>A spot just opened up</h2>
    <p>Good news ${esc(w.guest_name)} — a stay at <b>${esc(slugRow.name)}</b> for ${longCalendarDate(w.check_in_ymd)} to ${longCalendarDate(w.check_out_ymd)} is now available.</p>
    <p>You have <b>1 hour</b> to claim it before it rolls to the next person.</p>${longStay}
    <p><a href="${url}" style="display:inline-block;padding:12px 20px;background:#c9a227;color:#10141f;border-radius:8px;text-decoration:none;font-weight:700">Claim your stay</a></p>
    <p style="color:#888;font-size:12px">${url}</p>`
  await sendNotificationEmail({
    to: w.guest_email,
    subject: `Your waitlisted stay at ${slugRow.name} is available`,
    html,
    notificationType: 'waitlist_claim_link',
    landlordId: w.landlord_id,
    // 10/5: replies reach the people who run this property (services/replyRouting).
    replyTo: { kind: 'property', propertyId: w.property_id },
  })
}

export async function getWaitlistClaim(token: string): Promise<any | null> {
  return queryOne<any>(
    `SELECT w.*, w.check_in::text AS check_in_ymd, w.check_out::text AS check_out_ymd,
            p.name AS property_name, p.booking_slug, u.unit_number
       FROM unit_booking_waitlists w
       JOIN properties p ON p.id=w.property_id
       JOIN units u ON u.id=w.unit_id
      WHERE w.claim_token=$1`, [token])
}

/**
 * Claim a promoted waitlist spot → a tentative booking + checkout. 10/5: a
 * 30+ night claim carries the guest's lease-or-stay answer (R2), like any
 * booking-site stay.
 */
export async function claimWaitlistSpot(token: string, stayTerms?: StayTerms | null): Promise<BookingDepositResult> {
  const w = await getWaitlistClaim(token)
  if (!w) throw new AppError(404, 'Claim link not found')
  if (w.status !== 'notified') throw new AppError(409, 'This claim is no longer available')
  if (!w.claim_expires_at || new Date(w.claim_expires_at) < new Date()) throw new AppError(409, 'This claim window has expired')

  const result = await bookStay({
    slug: w.booking_slug, unitId: w.unit_id,
    guestName: w.guest_name, guestEmail: w.guest_email, guestPhone: w.guest_phone,
    // S654: the calendar days as text — a pg DATE arrives as local midnight,
    // and its UTC string is the day before on any server east of UTC.
    checkIn: w.check_in_ymd,
    checkOut: w.check_out_ymd,
    stayTerms: stayTerms ?? null,
  })
  await query(`UPDATE unit_booking_waitlists SET status='claimed', claimed_booking_id=$1, updated_at=now() WHERE id=$2`,
    [result.bookingId, w.id])
  return result
}

/**
 * The booking sweep let a hold go but could not close the signed lease drafted
 * with it (money was paid on it, a payment is on its way, or the close failed):
 * the lease is left pending on a site that is no longer held. The landlord is
 * told once — in the app and by email — naming the lease, the tenant and the
 * close's own words (which name the next step). Never throws.
 */
async function notifyHoldLeaseLeftOpen(
  l: { id: string; source_booking_id: string }, refusal: string | null,
): Promise<void> {
  try {
    const r = await queryOne<{
      landlord_id: string; owner_user_id: string; owner_email: string | null
      unit_number: string | null; property_name: string | null; tenant_name: string | null; start_date: string | null
    }>(
      `SELECT l.landlord_id, ll.user_id AS owner_user_id, ou.email AS owner_email,
              un.unit_number, pr.name AS property_name,
              to_char(l.start_date, 'FMMonth FMDD, YYYY') AS start_date,
              COALESCE(
                (SELECT NULLIF(TRIM(CONCAT(tu.first_name, ' ', tu.last_name)), '')
                   FROM lease_tenants lt JOIN tenants t ON t.id = lt.tenant_id JOIN users tu ON tu.id = t.user_id
                  WHERE lt.lease_id = l.id
                  ORDER BY (lt.role = 'primary') DESC, lt.tenant_id LIMIT 1),
                (SELECT NULLIF(TRIM(b.guest_name), '') FROM unit_bookings b WHERE b.id = $2)) AS tenant_name
         FROM leases l
         JOIN landlords ll ON ll.id = l.landlord_id
         LEFT JOIN users ou ON ou.id = ll.user_id
         LEFT JOIN units un ON un.id = l.unit_id
         LEFT JOIN properties pr ON pr.id = un.property_id
        WHERE l.id = $1`, [l.id, l.source_booking_id])
    if (!r) return
    const who = r.tenant_name ?? 'the tenant'
    const site = [r.property_name, r.unit_number ? `site ${r.unit_number}` : null].filter(Boolean).join(', ')
    const why = refusal ?? 'GAM could not close it on its own.'
    const title = `A hold ran out but ${who}'s lease is still open`
    const body =
      `The unpaid hold for ${who}${site ? ` at ${site}` : ''} ran out and the site was let go, ` +
      `but the lease signed with it was not ended. ${why} ` +
      `Open the lease and decide what happens to it${r.start_date ? ` before it starts on ${r.start_date}` : ''}.`
    const { createNotification, emailTemplate } = await import('./notifications')
    const { portalLink } = await import('../lib/portalUrls')
    const actionUrl = `/leases?open=${l.id}`
    // The in-app copy is plain text (the screen escapes it). The email is
    // HTML, and the name can be the guest name typed on the public booking
    // form, so every word goes in escaped — with a button to the lease.
    const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
    await createNotification({
      userId: r.owner_user_id,
      landlordId: r.landlord_id,
      type: 'hold_lease_left_open',
      title, body,
      data: { leaseId: l.id, bookingId: l.source_booking_id },
      actionUrl,
      sendEmail: !!r.owner_email, emailTo: r.owner_email ?? undefined,
      emailSubject: title.replace(/\s+/g, ' '),   // one line, whatever was typed
      emailHtml: emailTemplate(esc(title), esc(body), { label: 'Open the lease', url: portalLink('landlord', actionUrl) }),
    })
  } catch (err) {
    logger.error({ err, leaseId: l.id }, '[booking-sweep] telling the landlord about a lease left open failed')
  }
}

/**
 * Sweep: expire abandoned tentative holds and stale waitlist claims, promoting
 * the next waitlister for any unit a cancellation/expiry frees. Cron-driven.
 */
export async function sweepBookingHoldsAndClaims(): Promise<{ holdsExpired: number; claimsExpired: number; promoted: number }> {
  const expiredHolds = await query<{ id: string; unit_id: string }>(
    `UPDATE unit_bookings SET status='cancelled',
            cancelled_at = COALESCE(cancelled_at, now()), updated_at=now()
      WHERE status='tentative' AND hold_expires_at IS NOT NULL AND hold_expires_at < now()
      RETURNING id, unit_id`)
  // S640: a cancelled reservation takes its unsigned draft lease with it. That
  // rule went in on the master-schedule cancel route (S639) and this second
  // door — an abandoned hold expiring on its own — was left doing the old
  // thing, so a lapsed hold would strand exactly the kind of orphan draft Nic
  // had no way to delete. Unsigned paperwork only; an executed lease is never
  // touched by an expiring hold.
  if (expiredHolds.length) {
    const holdIds = expiredHolds.map(h => h.id)
    // Paperwork only — the landlord never signed it and no bill was made on
    // it — ends with a bare status change, as before.
    try {
      const killed = await query<{ id: string }>(
        `UPDATE leases SET status = 'terminated', needs_review = FALSE, updated_at = NOW()
          WHERE source_booking_id = ANY($1::uuid[]) AND status IN ('pending', 'draft')
            AND signed_by_landlord IS NOT TRUE
            AND NOT EXISTS (SELECT 1 FROM invoices i WHERE i.lease_id = leases.id)
          RETURNING id`, [holdIds])
      if (killed.length) {
        logger.info({ leaseIds: killed.map(k => k.id) },
          '[booking-sweep] expired holds also cancelled their unsigned draft leases')
      }
    } catch (err) {
      logger.error({ err }, '[booking-sweep] draft-lease cancel on hold expiry failed')
    }
    // 10/4 (review LOW): a lease the landlord signed, or one that already has
    // its move-in bill, goes through the one never-moved-in close (decisions
    // #46.4 / #53: "if they never pay the deposit or never move in, zero it
    // out and end the lease") — the unpaid move-in bill zeroed and voided,
    // the household taken off — never a bare status change that would leave
    // that bill owed on an ended lease. When the close does not apply (money
    // paid on it, a payment on its way) nothing changes and it is logged for
    // a person to look at.
    const issued = await query<{ id: string; unit_id: string; source_booking_id: string }>(
      `SELECT id, unit_id, source_booking_id FROM leases
        WHERE source_booking_id = ANY($1::uuid[]) AND status IN ('pending', 'draft')
        ORDER BY created_at, id`, [holdIds]).catch((err) => {
      logger.error({ err }, '[booking-sweep] reading signed leases of expired holds failed')
      return [] as { id: string; unit_id: string; source_booking_id: string }[]
    })
    for (const l of issued) {
      const { endLeaseNeverMovedIn } = await import('../lib/unwindIssuedLease')
      const client = await getClient()
      let stop: string[] = []
      try {
        await client.query('BEGIN')
        const closed = await endLeaseNeverMovedIn(client, l, { cancelingBooking: l.source_booking_id })
        stop = closed.cancelAfterCommit
        await client.query('COMMIT')
        logger.info({ leaseId: l.id, zeroed: closed.closedAmount },
          '[booking-sweep] an expired hold ended its signed lease through the never-moved-in close')
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {})
        logger.error({ err, leaseId: l.id, bookingId: l.source_booking_id },
          '[booking-sweep] an expired hold\'s signed lease could not be closed as never moved in; left as it is')
        // 10/4 (review LOW): the hold is canceled and the site let go, but the
        // lease stays pending — and no later sweep looks at it again (only
        // holds canceled in this run come back). Tell the landlord, naming the
        // lease, the tenant and why, so a person decides before its start day.
        await notifyHoldLeaseLeftOpen(l, err instanceof AppError ? err.message : null)
      } finally { client.release() }
      if (stop.length) {
        const { cancelSupersededIntents } = await import('./creditUse')
        await cancelSupersededIntents(stop)   // never throws
      }
    }
  }
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
