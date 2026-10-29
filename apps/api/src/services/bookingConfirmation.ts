/**
 * 10/20 (Nic) — THE CONFIRMATION, AND THE DEPOSIT IT OFFERS.
 *
 *   "the confirmation actually says that they have a reservation on these
 *    dates. I'd like it to tell them a grand total if it's a short-term stay,
 *    like less than a month or whatever. If they're seasonal and going to be
 *    here more than the 30 days, I just want it to tell them the first month's
 *    rate. I also want it to tell them a deposit of 10% or whatever that
 *    property's deposit rate is. Have it display that as available to pay now.
 *    But I also want it to not be required and just say, hey, paying the
 *    deposit guarantees the spot, not paying the deposit risks the site being
 *    given away by other people that have paid ahead, and there are no refunds
 *    on deposits. So I don't know the best way to word that, but the tenant or
 *    the customer basically has to gamble. Hey, do they think the spot's going
 *    to be given away? Do they choose not to pay the deposit, or do they pay
 *    the deposit? That way it's their choice to pay or not. And then it kind of
 *    justifies the no refund of the deposit if they end up not making it. And
 *    the percentage being set at the property level makes it consistent with
 *    everybody. So if somebody wants to say, stay a week at the 269 rate, we
 *    send them a deposit of 10%. They pay their $26, $27, plus the card fee,
 *    and boom, they're confirmed."
 *
 * ── NOTHING HERE EVER SENDS ITSELF ────────────────────────────────────────
 *
 * There is no hook on booking creation and no job that sweeps for unsent
 * confirmations, and there must never be one. Nic is mid-migration with real
 * customers on the board — people who were told they were confirmed in the old
 * system, people who may already have paid a deposit off-platform — and the
 * worst outcome of this whole build is a blast. The only thing that sends a
 * confirmation is a person pressing send (routes/bookings), and the send is
 * recorded on the reservation so nobody is told the same thing twice.
 *
 * ── WHICH FIGURE THE GUEST IS TOLD ────────────────────────────────────────
 *
 * Under 30 nights: the grand total, lodging tax in, because that is what they
 * owe for the whole thing. 30 nights or more: the FIRST MONTH only, said in so
 * many words — a guest down for the season on a $589 month must not read "$589"
 * and think six months cost that. A stay of 30+ nights carries no short-term
 * lodging tax and a shorter one does; that rule is priceStay's, not ours.
 *
 * GAM HAS ONE OPINION ABOUT WHAT A STAY COSTS. The whole-stay figure is the
 * price the reservation was SOLD at (unit_bookings.total_amount — itself
 * priceStay's answer at the moment it was taken, or the price a clerk typed for
 * a site with no rate card on it), and priceStay only fills in for a row that
 * has no total at all. Re-pricing a reservation that already exists would quote
 * the guest one number here and charge another on the arrival ticket, which is
 * the same stay billed two ways.
 *
 * WHICH MEANS THE FIRST MONTH IS NOT ALWAYS THERE TO BE QUOTED. The first month
 * comes from soldStayFirstMonth, the booking site's own definition of a 30+ stay's
 * first month — and it is priceStay underneath, so it can only cut a month out
 * of the RATE CARD. A reservation the rate card did not price (the typed total
 * above; a figure imported out of the old system) has one price and it covers
 * the whole stay, so that is what the guest is told, in so many words, and the
 * arrival ticket raises the same figure. GAM does not divide a lump sum into
 * months it was never quoted in.
 *
 * ── THE DEPOSIT IS THE CARD PAGE'S OWN NUMBER ─────────────────────────────
 *
 * The deposit rule is `depositForStay` and nothing else: the property's
 * booking_deposit_pct of the figure above for a short stay, and for 30+ nights
 * the property's FLAT booking_monthly_deposit capped at one month's rent. The
 * flat amount wins on a long stay because the percentage of six months would be
 * a deposit nobody would pay, and because that is already the rule every other
 * door quotes (S547, migration 20260718184500: "stays 30+ nights owe AT MOST
 * one month"). The percentage is for short stays. Nothing new is invented here.
 *
 * And once a deposit link exists, the LINK's own lines are what the email
 * quotes — not a fresh calculation. A card page that charges $57 under an email
 * that promised $26 is the single worst thing this email could do, and the way
 * that happens is two places doing the arithmetic. So the figures are read back
 * off the link GAM is actually going to charge.
 *
 * There is ONE kind of deposit link in GAM (createBookingDepositLink: it claims
 * the reservation's deposit_amount, so it can never bill a second deposit) and
 * this uses it. It does not mint a second kind.
 *
 * ── ONE EMAIL, OR NONE ────────────────────────────────────────────────────
 *
 * That link maker emails the guest itself, because its other caller is the
 * schedule's "Ask for the deposit" button, where the email IS the ask. So
 * pressing send here used to put two emails in front of the guest and the bare
 * one — "Reservation deposit: $28.39", no dates, no reason — arrived first. It
 * is withheld now for the length of that call (services/emailWithheld.ts), the
 * confirmation carries the card page itself, and the stamp that says the guest
 * was ASKED is written after the confirmation is out rather than when the link
 * was made. A confirmation that fails therefore leaves the guest with nothing
 * at all, which is the only acceptable version of failing.
 */
import { query, queryOne } from '../db'
import { AppError } from '../middleware/errorHandler'
import { logger } from '../lib/logger'
import {
  STAY_LEASE_CHOICE_NIGHTS, cardFeeSplit, priceStay, stayDepositAsk, stayHeldWords,
  stayNightsBetween, type BookingStatus, type CardFeePayer, type StayRates, type StayTerms,
} from '@gam/shared'
import { depositForStay } from './propertyBooking'
import { soldStayFirstMonth } from './propertyBookingQuote'
import { PAID_TOWARD_SQL } from './bookingLeaseDraft'
import { replyToProperty } from './replyRouting'
import { withholdEmails } from './emailWithheld'

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100

/** The figures a confirmation quotes. */
export interface ConfirmationFigures {
  nights: number
  /**
   * True when `amount` is the FIRST MONTH rather than the whole stay. A stay of
   * 30 nights or more, EXCEPT one the rate card never priced: a season sold at
   * a figure of its own has no month GAM can name, so it is quoted whole and
   * this is false (see confirmationFigures).
   */
  firstMonthOnly: boolean
  /** The grand total for a short stay, or the first month's rate for a long one. */
  amount: number
  /** The first month's last day (30+ stays), for the email to name. */
  firstMonthThrough: string | null
  /**
   * The lodging tax inside `amount`, or null when we are not breaking it out.
   * Null for a 30+ stay (there is none) and for a reservation whose stored
   * total is not what the rate card prices today — we will quote the figure the
   * stay was sold at, but we will not invent a tax split for it.
   */
  tax: number | null
  /** The deposit this property asks for on a stay like this; 0 when it asks none. */
  deposit: number
  /** R13's held-through sentence, for a 30+ stay with no lease. */
  heldThrough: string | null
}

/**
 * The figures, from the reservation and the property's own settings. Pure: no
 * database, no link, no email — so the arithmetic can be pinned on its own.
 */
export function confirmationFigures(args: {
  checkIn: string
  checkOut: string
  /** unit_bookings.total_amount — the price this reservation was sold at. */
  bookedTotal: number | string | null
  /** The site's rates, else the property's (the same fallback every door uses). */
  rates: StayRates
  /** properties.short_term_tax_rate, as a percent. */
  taxRatePct: number | string | null
  property: { booking_deposit_pct: string | number; booking_monthly_deposit: string | number | null }
  /**
   * unit_bookings.stay_terms. The held-through sentence belongs to a stay that
   * ANSWERED "stay" — the same test linkHeldWords and propertyBooking use, so
   * there is one answer to "is this guest held only through what they paid
   * for". A reservation that was never asked the question (an import, a soft
   * hold: stay_terms null) is not told about a lease choice nobody offered it.
   */
  stayTerms?: StayTerms | null
}): ConfirmationFigures {
  const nights = stayNightsBetween(args.checkIn, args.checkOut)
  const rate = (v: number | string | null | undefined) => (v == null || v === '' ? null : Number(v))
  const monthlyRate = rate(args.rates.monthly)
  const longStay = nights >= STAY_LEASE_CHOICE_NIGHTS
  const booked = round2(Number(args.bookedTotal) || 0)
  const priced = priceStay(args.rates, args.taxRatePct, args.checkIn, nights)

  let amount: number
  let tax: number | null
  let firstMonthOnly = longStay
  let firstMonthThrough: string | null = null
  if (longStay) {
    // ── WHOSE PRICE IS THIS, BEFORE A MONTH IS CUT OUT OF IT ───────────────
    //
    // 10/20 (review): a month can only be carved out of a price the rate card
    // actually set. This branch used to carve one regardless, and Nic's board
    // is full of reservations the card never priced — a total a clerk typed on
    // a site with no rate on it, a figure imported straight across out of the
    // old system. A month cut out of somebody else's price belongs to a
    // different stay than the guest booked: a season sold for $1,767 came back
    // quoted at $1,519 for its first month, and one sold on a site with no
    // rate at all came back at $0.00 with no deposit and no card page.
    //
    // So the card is asked first whether it priced THIS stay — the same test
    // the tax split below has always used — and a reservation with no price of
    // its own is the card's to price.
    //
    // 10/20 (defect): asked THERE and not here, because the run that raises the
    // ticket on arrival morning asks the same question of the same row
    // (services/stayBalance) and the two answered it differently — the guest
    // read $1,767 and the card page asked for $1,519. One answer, two readers
    // (propertyBookingQuote soldStayFirstMonth: the booking site's own first
    // month, the 6th to the 6th, never past the check-out asked for, never
    // prorated, never taxed, and never more than the stay was sold for).
    const owed = soldStayFirstMonth({
      checkIn: args.checkIn, checkOut: args.checkOut, soldTotal: args.bookedTotal,
      rates: { nightly: rate(args.rates.nightly), weekly: rate(args.rates.weekly), monthly: monthlyRate },
    })
    if (owed.kind === 'month') {
      amount = owed.amount
      firstMonthThrough = owed.checkOut
    } else if (booked > 0) {
      // NOTHING PRICED A MONTH, so the email does not pretend to name one.
      // The only price this stay has is the one it was sold at, and that price
      // is the whole stay — so the whole stay is what the guest is told, which
      // is also exactly what GAM will bill them (services/stayBalance raises
      // the total less the deposit on the day they turn up). Quoting an
      // invented month and then billing the season on arrival would be the
      // worst of both.
      amount = booked
      firstMonthOnly = false
    } else {
      // A long stay with no price anywhere: a work trade that covers the site,
      // or one nobody has priced yet. There is no figure to quote and none is
      // invented.
      amount = 0
    }
    tax = null
  } else {
    // What it was sold at wins; the rate card only fills in a row with no total.
    amount = booked > 0 ? booked : round2(priced.total)
    // Only break the tax out when the figure we are quoting IS the one the rate
    // card priced — otherwise the split belongs to a different number.
    tax = priced.taxable && priced.tax > 0 && round2(priced.total) === amount ? round2(priced.tax) : null
  }

  const deposit = depositForStay(args.property, { total: amount, nights, monthlyRate })
  return {
    nights,
    firstMonthOnly,
    amount,
    firstMonthThrough,
    tax,
    deposit: round2(deposit),
    // The held-through sentence belongs to the stay's LENGTH, not to which of
    // the two figures we ended up quoting — an imported seasonal quoted its
    // whole sold price is still held only through the dates it paid for.
    heldThrough: longStay && args.stayTerms === 'stay' ? stayHeldWords(args.checkOut) : null,
  }
}

/**
 * 10/20 (defect) — WHAT MONEY IS ALREADY IN, ANSWERED ONCE.
 *
 * A guest who paid his whole $286.75 — on the card page, or across the counter
 * — read two false things in one email: that "your deposit of $28.68 is paid",
 * which is the property's 10% and not money anybody ever charged him, and that
 * "the balance is due when you arrive", which asks a man who owes nothing to
 * pay the lot again at the gate.
 *
 * Both came from one root. This email had no single answer to "what has this
 * reservation been paid", so each paragraph made its own up: the deposit line
 * fell back on the property's percentage whenever the row carried no deposit
 * amount, and the price line assumed nothing was in, always. This is that one
 * answer, and both paragraphs are written from it.
 *
 * IT IS NOT A NEW OPINION. What a reservation has been paid is already defined
 * in exactly one place — services/bookingLeaseDraft PAID_TOWARD_SQL, the figure
 * a lease drafted from the stay takes off its first bill: the whole price once
 * the balance is stamped paid, otherwise the deposit amount, and a deposit
 * stamped paid with NO amount beside it is the whole price too, because that is
 * what the doors taking the money mean by it (posPayLinks settleLinkBooking and
 * registerStay payTowardStay both keep deposit_amount as everything paid so
 * far, and registerStay reservationDue reads a missing one as the lot). Whether
 * the guest may be asked at all is still stayDepositAsk's question, unchanged.
 *
 * AND IT NAMES NO FIGURE IT CANNOT STAND BEHIND. A register sale against a
 * reservation that recorded no amount on the row is money in with no way to say
 * how much: `amount` is null and the email says the true half only. Quoting a
 * figure nobody paid is the whole of what went wrong here.
 */
export interface ConfirmationPaid {
  /** 'stay': the whole price is in, so nothing is owed on arrival. 'deposit': part of it is. */
  kind: 'deposit' | 'stay'
  /** What is in, or null when the reservation cannot say — then no figure is quoted. */
  amount: number | null
}

export function confirmationPaid(stay: {
  status: BookingStatus
  depositPaidAt?: string | Date | null
  balancePaidAt?: string | Date | null
  posTransactionId?: string | null
  guestEmail?: string | null
  /** bookingLeaseDraft PAID_TOWARD_SQL, read off this row. */
  paidToward: number | string | null
  /** unit_bookings.total_amount — what the stay was sold for. */
  total: number | string | null
}): ConfirmationPaid | null {
  if (stayDepositAsk(stay) !== 'already_paid') return null
  const paid = stay.paidToward == null || stay.paidToward === '' ? null : round2(Number(stay.paidToward))
  const total = round2(Number(stay.total) || 0)
  // To the cent, not to the dollar: a cent short of the price is still a balance.
  const whole = !!stay.balancePaidAt || (total > 0 && paid != null && paid >= total - 0.005)
  return { kind: whole ? 'stay' : 'deposit', amount: paid != null && paid > 0 ? paid : null }
}

/** What the card page will charge, line by line — the deposit offer in the email. */
export interface ConfirmationDepositOffer {
  /** The deposit itself. */
  deposit: number
  /** A background check riding on the same link (22+ nights with nothing on file); 0 when none. */
  screening: number
  /** GAM's card fee — 0 when the property covers it. Always shown before they pay. */
  cardFee: number
  /** What the card page charges, all in. */
  total: number
  /** The card page. Null when there is no link to offer and the office has to take it. */
  url: string | null
}

interface BookingRow {
  id: string; unit_id: string; landlord_id: string; property_id: string; unit_number: string
  property_name: string; status: string
  /** The guest's tenant record when they have one — how the continuous stay is walked (R7). */
  tenant_id: string | null
  guest_name: string | null; guest_email: string | null
  check_in: string; check_out: string
  total_amount: number | null
  stay_terms: StayTerms | null
  deposit_amount: number | null
  deposit_paid_at: string | null
  balance_paid_at: string | null
  pos_transaction_id: string | null
  /** What this reservation has been paid (bookingLeaseDraft PAID_TOWARD_SQL); null when nothing has. */
  paid_toward: number | null
  hold_expires_at: string | null
  deposit_pay_link_id: string | null
  confirmation_sent_at: string | null
  booking_deposit_pct: string; booking_monthly_deposit: string | null
  booking_card_fee_payer: CardFeePayer
  short_term_tax_rate: string | null
  u_nightly: string | null; u_weekly: string | null; u_monthly: string | null
  p_nightly: string | null; p_weekly: string | null; p_monthly: string | null
}

/** The reservation, its site's rates and its property's settings, in one read. */
export async function loadConfirmationBooking(bookingId: string): Promise<BookingRow | null> {
  return queryOne<BookingRow>(
    `SELECT b.id, b.unit_id, b.landlord_id, b.status, b.tenant_id, b.guest_name, b.guest_email,
            to_char(b.check_in,  'YYYY-MM-DD') AS check_in,
            to_char(b.check_out, 'YYYY-MM-DD') AS check_out,
            b.total_amount::float AS total_amount, b.stay_terms,
            b.deposit_amount::float AS deposit_amount,
            ${PAID_TOWARD_SQL}::float AS paid_toward,
            b.deposit_paid_at, b.balance_paid_at, b.pos_transaction_id, b.hold_expires_at,
            b.deposit_pay_link_id, b.confirmation_sent_at,
            u.property_id, u.unit_number,
            u.nightly_rate AS u_nightly, u.weekly_rate AS u_weekly, u.monthly_rate AS u_monthly,
            p.name AS property_name, p.booking_deposit_pct, p.booking_monthly_deposit,
            p.booking_card_fee_payer, p.short_term_tax_rate,
            p.nightly_rate AS p_nightly, p.weekly_rate AS p_weekly, p.monthly_rate AS p_monthly
       FROM unit_bookings b
       JOIN units u ON u.id = b.unit_id
       JOIN properties p ON p.id = u.property_id
      WHERE b.id = $1`, [bookingId])
}

/** The rates a stay on this site prices from: the site's, else the property's. */
const ratesOf = (b: BookingRow): StayRates => ({
  nightly: b.u_nightly ?? b.p_nightly,
  weekly: b.u_weekly ?? b.p_weekly,
  monthly: b.u_monthly ?? b.p_monthly,
})

export const CONFIRMATION_NO_EMAIL =
  'There is no email address on this reservation, so there is nowhere to send a confirmation. '
  + 'Add the guest\'s email on the reservation first. Nothing was sent.'

/** A reservation that is not holding its dates any more has nothing to confirm. */
export const CONFIRMATION_NOT_LIVE: Record<string, string> = {
  checked_in: 'This guest has already arrived — confirming a reservation they are sitting on would only confuse them. Nothing was sent.',
  checked_out: 'This stay is already finished. Nothing was sent.',
  cancelled: 'This reservation is canceled, so there is nothing to confirm. Nothing was sent.',
  no_show: 'This guest never arrived, so there is nothing to confirm. Nothing was sent.',
}

/**
 * 10/20 (review) — THE CHECK'S FEE THIS RESERVATION HAS TO CARRY.
 *
 * A stay of 22+ continuous nights with nothing on file owes GAM a background
 * check, and its fee rides on whatever payment the stay is handed to (R8/A2).
 * This email mints a deposit link, so it IS one of those payments — and it went
 * out without the fee on it. Quoting short is the smaller half: a deposit link
 * CLAIMS the reservation's deposit_amount, so the schedule's "Ask for the
 * deposit" afterwards got the fee-less link handed back from then on, the fee
 * was never billed, no prepaid check was recorded for the guest, and check-in
 * sat waiting on a check nobody had paid for.
 *
 * Nothing is recomputed here. It is the ONE answer every other door asks
 * (services/stayTerms screeningFeeToCarry), so the schedule's button and this
 * email quote the same money for the same reservation.
 *
 * 'unreadable' is its own answer and it means MINT NOTHING. A link made while
 * we cannot tell whether the fee belongs on it is the same defect again, and it
 * cannot be put right afterwards, because the claim is taken. The deposit is
 * quoted without a card page instead and the office takes it — which is what
 * this path already does when card payments are not set up.
 */
async function screeningFeeForConfirmation(b: BookingRow): Promise<number | null | 'unreadable'> {
  try {
    const { stayNeeds, screeningFeeToCarry } = await import('./stayTerms')
    const needs = await stayNeeds({
      landlordId: b.landlord_id, propertyId: b.property_id, bookingId: b.id,
      tenantId: b.tenant_id, email: b.guest_email,
      checkIn: b.check_in, checkOut: b.check_out,
    })
    return await screeningFeeToCarry(needs, b.id)
  } catch (err) {
    logger.error({ err, bookingId: b.id }, '[booking-confirmation] could not tell what this stay owes for its background check')
    return 'unreadable'
  }
}

/**
 * The deposit offer: the link GAM is really going to charge, read back off its
 * own lines, or a fresh one made the one way GAM makes them.
 *
 * An EXPIRED link is not an offer — the public card page refuses it with a
 * closed page (routes/posPayLinks) — so it is not handed to a guest as
 * something they can pay. A deposit link never expires, but a reservation can
 * be carrying other links, and the same test is used for all of them.
 */
async function depositOfferFor(
  b: BookingRow, figures: ConfirmationFigures,
): Promise<ConfirmationDepositOffer | null> {
  if (!(figures.deposit > 0)) return null
  const { payLinkUrl, payLinkCharge, isScreeningLine } = await import('../routes/posPayLinks')

  const offerFromLink = (link: { token: string; total: number; items: any[]; card_fee_on_top: boolean }) => {
    const lines: any[] = Array.isArray(link.items) ? link.items : []
    const sum = (keep: (l: any) => boolean) => round2(lines.filter(keep)
      .reduce((s, l) => s + Number(l.price ?? 0) * Number(l.qty ?? 1), 0))
    // 10/18's lesson, applied to copy: the deposit is the deposit LINE, never
    // the link's total — a link carrying a background check as well would
    // otherwise be read out to the guest as a deposit several times its size.
    const screening = sum(isScreeningLine)
    const deposit = sum(l => !isScreeningLine(l))
    const charge = payLinkCharge(Number(link.total), link.card_fee_on_top ? 'customer' : 'landlord')
    return {
      deposit, screening,
      cardFee: round2(charge.customerFee),
      total: round2(charge.charged),
      url: payLinkUrl(link.token),
    }
  }

  const out = b.deposit_pay_link_id
    ? await queryOne<{ token: string; total: number; items: any[]; card_fee_on_top: boolean }>(
        `SELECT token, total::float AS total, items, card_fee_on_top
           FROM pos_pay_links
          WHERE id = $1 AND status = 'open' AND (expires_at IS NULL OR expires_at > NOW())`,
        [b.deposit_pay_link_id])
    : null
  if (out) return offerFromLink(out)

  // A BOOKING-SITE CHECKOUT IN FLIGHT IS ALREADY ASKING FOR THIS DEPOSIT.
  // `hold_expires_at` is written by the booking site alone (propertyBooking
  // bookStay — a counter reservation deliberately has none), and while it runs
  // the guest is on the website's own card page being asked for this same
  // money. A second card page beside it is two ways to pay one reservation,
  // which is how a guest pays twice. The figure is quoted; the button is not.
  const holdLive = !!b.hold_expires_at && new Date(b.hold_expires_at).getTime() > Date.now()

  // Nothing out: make the one kind of deposit link GAM has. It claims the
  // reservation's deposit_amount, so a reservation whose deposit an earlier
  // link already claimed gets null back and the figure is quoted without a
  // button rather than billed twice.
  //
  // AND IT EMAILS THE GUEST ITSELF, WHICH THIS ONE MUST NOT LET IT DO.
  // 10/20 (review): the link maker's other caller is the schedule's "Ask for
  // the deposit" button, where the email IS the ask, so it sends one every
  // time it makes a link (routes/posPayLinks, and it takes no flag). Here the
  // CONFIRMATION is the ask — it carries this very card page under the dates
  // and the price — so the link's own bare "Reservation deposit: $28.39" is
  // withheld for the length of this call (services/emailWithheld.ts). It
  // arrived FIRST, and to a guest Nic told "you're confirmed" by text in March
  // it was a payment demand from a company they had never heard of; if the
  // confirmation behind it then failed, it was the only thing they ever got.
  // One email, or none.
  //
  // The background check's fee goes ON it when this stay still owes one — the
  // same line, from the same answer, as the schedule's own button puts there
  // (screeningFeeForConfirmation above). It is a fixed line the payer cannot
  // take off, and paying it records the guest's prepaid check.
  const fee = holdLive ? null : await screeningFeeForConfirmation(b)
  const { createBookingDepositLink } = await import('../routes/posPayLinks')
  const made = holdLive || fee === 'unreadable' ? null : await withholdEmails({
    categories: ['pos_pay_link'],
    because: 'the guest\'s reservation confirmation carries this deposit link',
  }, () => createBookingDepositLink({
    bookingId: b.id, landlordId: b.landlord_id, propertyId: b.property_id,
    amount: figures.deposit, guestName: b.guest_name, guestEmail: b.guest_email!,
    ...(fee ? { screeningFee: fee } : {}),
  })).catch((err) => {
    // Card payments not set up yet, or the link failed. The confirmation is
    // still worth sending — it is the dates and the price — so the deposit is
    // quoted and the office takes it.
    logger.error({ err, bookingId: b.id }, '[booking-confirmation] deposit link failed')
    return null
  })
  if (!made) {
    // No card page, but the money owed is the money owed: the check's fee is
    // named here too, so a guest who rings the office is told the same total
    // the link would have charged.
    const screening = typeof fee === 'number' && fee > 0 ? fee : 0
    const charge = cardFeeSplit(round2(figures.deposit + screening), b.booking_card_fee_payer, screening)
    return {
      deposit: figures.deposit, screening,
      cardFee: b.booking_card_fee_payer === 'customer' ? round2(charge.fee) : 0,
      total: round2(charge.charged), url: null,
    }
  }
  // WHICH LINK IS THIS RESERVATION'S DEPOSIT. createBookingDepositLink does not
  // write this — its callers do (routes/units sendStayDepositLink) — and without
  // it the next confirmation finds no link, tries to make a second one, is
  // refused (the deposit is already claimed) and quotes the guest a figure with
  // no card page behind it. A reservation can also be carrying links that ask
  // for other money (the whole stay, an added month, the arrival balance), and
  // reading one of those out as "the deposit" is how a guest is quoted five
  // times the figure (the 10/18 review).
  //
  // THE "ASKED" STAMP IS NOT WRITTEN HERE. It says the guest has been asked
  // for this deposit — it is what the schedule shows ("Emailed to …") and what
  // stops the "Ask for the deposit" button emailing them a second time — and
  // the thing that asks them is the CONFIRMATION, which has not gone out yet.
  // A link's own email no longer goes with the link either (it is withheld
  // above), so `made.emailed` is no longer the answer to "were they asked".
  // sendBookingConfirmation stamps it once the confirmation is really out; a
  // send that failed is not an ask.
  await query(
    `UPDATE unit_bookings SET deposit_pay_link_id = $2, updated_at = NOW() WHERE id = $1`,
    [b.id, made.id])
    .catch((err) => logger.error({ err, bookingId: b.id }, '[booking-confirmation] deposit link stamp failed'))

  const fresh = await queryOne<{ token: string; total: number; items: any[]; card_fee_on_top: boolean }>(
    `SELECT token, total::float AS total, items, card_fee_on_top FROM pos_pay_links WHERE id = $1`, [made.id])
  return fresh ? offerFromLink(fresh) : null
}

export interface ConfirmationSent {
  sentTo: string
  guestName: string | null
  figures: ConfirmationFigures
  deposit: ConfirmationDepositOffer | null
  /** Money is already in, so the email says WHICH money and how much instead of asking. */
  paid: ConfirmationPaid | null
}

/**
 * Email this guest their reservation. Called by one thing only: a person
 * pressing send (routes/bookings). The stamp is written after the email, so a
 * send that failed is not recorded as a guest who was told.
 */
export async function sendBookingConfirmation(
  b: BookingRow, byUserId: string | null,
): Promise<ConfirmationSent> {
  if (!b.guest_email || !b.guest_email.trim()) throw new AppError(409, CONFIRMATION_NO_EMAIL)
  const notLive = CONFIRMATION_NOT_LIVE[b.status]
  if (notLive) throw new AppError(409, notLive)

  const figures = confirmationFigures({
    checkIn: b.check_in, checkOut: b.check_out, bookedTotal: b.total_amount,
    rates: ratesOf(b), taxRatePct: b.short_term_tax_rate,
    property: { booking_deposit_pct: b.booking_deposit_pct, booking_monthly_deposit: b.booking_monthly_deposit },
    stayTerms: b.stay_terms,
  })

  // ── NEVER ASK FOR MONEY THAT IS ALREADY IN ──────────────────────────────
  //
  // A guest who has paid their deposit — on a link, at the counter, on the
  // booking site, or in the old system before any of this existed, which is
  // most of the board right now ("they may have already paid a deposit") —
  // must not be sent an email asking for it and telling them the site could be
  // given away. They are the one guest whose site genuinely cannot be.
  //
  // Which is read from the ONE rule the schedule's button and the deposit
  // route already read (@gam/shared stayDepositAsk: paid is paid, whichever
  // way the money came), not from a fourth opinion about what "paid" means.
  //
  // 10/20 (defect): and HOW MUCH is in, and whether it covers the stay, is
  // confirmationPaid's single answer above — because this used to fall back on
  // the property's deposit percentage for a row with no deposit amount on it,
  // which told a guest who had paid $286.75 that his "$28.68 deposit" was in.
  // The price paragraph reads the same answer, so the two can never disagree
  // about whether anything is owed on arrival.
  const paid = confirmationPaid({
    status: b.status as BookingStatus, depositPaidAt: b.deposit_paid_at,
    balancePaidAt: b.balance_paid_at, posTransactionId: b.pos_transaction_id,
    guestEmail: b.guest_email, paidToward: b.paid_toward, total: b.total_amount,
  })
  const deposit = paid ? null : await depositOfferFor(b, figures)

  const { emailBookingConfirmation } = await import('./email')
  await emailBookingConfirmation({
    to: b.guest_email,
    guestName: b.guest_name,
    propertyName: b.property_name,
    checkIn: b.check_in,
    checkOut: b.check_out,
    nights: figures.nights,
    firstMonthOnly: figures.firstMonthOnly,
    amount: figures.amount,
    firstMonthThrough: figures.firstMonthThrough,
    tax: figures.tax,
    heldThrough: figures.heldThrough,
    depositPct: Number(b.booking_deposit_pct),
    deposit,
    paid,
    ctx: { landlordId: b.landlord_id, bookingId: b.id, replyTo: replyToProperty(b.property_id) },
  })

  // Only now: the guest has been told. Best-effort — the email is out either
  // way, and a stamp that failed to write is better than one that claims a send
  // that never happened.
  //
  // AND THIS EMAIL IS THE DEPOSIT ASK. It is the one that put the card page in
  // front of the guest, so the "asked" stamp belongs to it (10/20 review): the
  // schedule reads that stamp to say "Emailed to dale@… · Mar 3, 2:14 PM", and
  // the "Ask for the deposit" button reads it to hand the same link back
  // instead of emailing them again. Written only when the email really carried
  // somewhere to pay — no card page, no ask — and never moved once it is set,
  // because the first time they were asked is the time the schedule should
  // show. A reservation whose confirmation threw on the way out keeps a NULL
  // here, which is exactly right: a link was made, nobody was asked, and the
  // desk is told as much (routes/units, `emailFailed`).
  const askedForTheDeposit = !!deposit?.url
  await query(
    `UPDATE unit_bookings
        SET confirmation_sent_at = NOW(), confirmation_sent_by = $2,
            deposit_link_sent_at = CASE WHEN $3::boolean
                                        THEN COALESCE(deposit_link_sent_at, NOW())
                                        ELSE deposit_link_sent_at END,
            deposit_link_sent_by = CASE WHEN $3::boolean AND deposit_link_sent_at IS NULL
                                        THEN $2 ELSE deposit_link_sent_by END,
            updated_at = NOW()
      WHERE id = $1`, [b.id, byUserId, askedForTheDeposit])
    .catch((err) => logger.error({ err, bookingId: b.id }, '[booking-confirmation] sent-stamp failed'))

  return { sentTo: b.guest_email, guestName: b.guest_name, figures, deposit, paid }
}
