/**
 * 10/20 (Nic) — CALL IT A WASH.
 *
 *   "So what we do when people leave early is we'll usually call it a wash. We
 *    don't refund the money, but we also don't bill them a final electric bill.
 *    We need to still get the meter reads to close it out and count that as, if
 *    we're keeping track of electric that's not billed back, we need to count
 *    that there, but it doesn't need to get attached to anything. I would like
 *    to call it a wash, though. I would like to keep track of money that wasn't
 *    refunded versus electric that should have been billed that wasn't charged
 *    to see how close we actually get to evening out. You know, because people
 *    leave at various times and we try to be generous with it, but I want to
 *    make sure that it's somewhat fair."
 *
 * ONE module owns this rule, because four different surfaces need the answer —
 * the check-out window, the billing gate, the recovery report and the undo
 * paths — and a rule about money that four places each decide for themselves
 * is a rule that four places eventually disagree about.
 *
 * THE RULE. A departure is a wash when BOTH hold:
 *   (a) they left EARLY — before the day they had paid or booked through; and
 *   (b) NO money went back. The desk answered "No refund (keep the price as
 *       booked)", or the property does not give money back at all, so the whole
 *       unused amount stayed with the landlord.
 *
 * For a wash the final utility stub bills NOBODY: no invoice, no debt, no late
 * fee, nothing on their account — "it doesn't need to get attached to
 * anything" — and the absorbed amount is written to utility_absorbed_charges
 * with reason 'early_departure_wash', pointing at the departure, beside the
 * money kept in early_departure_washes.
 *
 * NOT A WASH, and the stub bills normally:
 *   - ANY refund, full or partial. JUDGMENT CALL, and worth naming as one:
 *     Nic described the paired no-refund case and said nothing about a partial.
 *     A partial refund is a different animal — somebody split the difference in
 *     cash and eating the power on top would be giving twice — so the decision
 *     taken here is that any refund at all means the power bills as usual. If
 *     Nic wants a partial refund to still wash the power, this is the one line
 *     that changes.
 *   - Somebody who left on their booked day. Nothing was kept, nothing to wash,
 *     and the money table's CHECK (departed_on < paid_through) will not even
 *     hold such a row.
 *   - Somebody who still OWED for the stay. The wash is about money KEPT, not
 *     money never collected; forgiving a debt is a write-off, not a wash.
 *
 * SCOPE. A lease move-out and a 30+ night stay with no lease, identically —
 * utilityReadingRuns departuresCte already treats them as one kind of event and
 * the rule reads the same for each: kept their money, eat their power. The wash
 * covers ONLY the final stub, the usage from their last billed read to the
 * closing read. An electric bill from two months ago that they received and
 * never paid is still a debt they owe.
 *
 * The absorbed power does NOT post again as an expense in the books. The
 * utility company's master bill is already fully expensed when the bank feed
 * books it; the unbilled share is revenue not recovered, not a second cost, and
 * posting it twice would overstate what the property spent.
 *
 * ORDERING, which is the subtle part. The money answer and the closing read
 * arrive at different desks, in either order.
 *   - Check-out first, the normal way round: the answer is on file, so when the
 *     closing read lands the stub is absorbed or billed accordingly.
 *   - Closing read first — or the money question still waiting because the
 *     clerk who checked them out has no "Issue refunds" — and the stub must NOT
 *     be billed yet. Billing it and then learning it was a wash means reversing
 *     a charge the guest may already have read in an email. So it is PARKED
 *     (utility_wash_holds) and reported to the billing engine as not billed,
 *     exactly as the invite hold is (utilityBilling holdChargeForPendingUnit,
 *     S629), and settled the moment the money answer lands.
 *   - A check-out undone, or a refund issued after the fact, UNWINDS the wash:
 *     the absorbed rows come off the book and the stub is BILLED again, in the
 *     same breath as its hold is let go (letGoOfHolds) rather than handed to a
 *     caller to bill. A wash decided after the stub was already billed reverses
 *     that bill.
 *
 * Everything here is scoped by landlord. Nic's standing rule: landlord, tenant
 * and platform each see only their own.
 */
import type { PoolClient } from 'pg'
// The ONE definition of what the days a guest actually stayed are worth, the
// same one the check-out window prices its refund figure with. Re-deriving it
// here would be a second opinion on a number the desk already quoted.
import { priceNightsStayedBetween, type StayRates } from '@gam/shared'
import { query, getClient } from '../db'
import { logger } from '../lib/logger'
// 10/18 (Nic): the property's own answer on whether it gives money back at all,
// read so this works whether or not migration 20261020120000 has reached the
// database yet. services/departureRules is the one place that knows.
import { departureRuleSql } from './departureRules'

/** A connection to read or write on: a PoolClient inside a transaction, or the pool. */
type Q = Pick<PoolClient, 'query'>

/** The pool in the shape above, for a read outside any transaction. */
export const poolQ: Q = { query: (async (sql: string, p?: any[]) => ({ rows: await query(sql, p) })) as any }

const round2 = (n: number) => Math.round(n * 100) / 100
const num = (v: unknown): number => (v == null ? 0 : round2(Number(v)))
const nullNum = (v: unknown): number | null => (v == null ? null : Number(v))

/** "$1,234.56", for the plain sentences this module hands back. */
const money = (n: number): string =>
  `$${round2(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

// ─── The value sets ──────────────────────────────────────────────────────────

/**
 * Why a utility cost ended up billed to nobody. SINGLE SOURCE (CLAUDE.md: one
 * definition per value set) — migration 20261021210000's
 * utility_absorbed_charges_reason_check lists exactly these.
 *
 * It lives here rather than in packages/shared because no frontend reads it
 * yet; the first surface that renders one of these moves this array and the
 * label map below into packages/shared/src/index.ts and imports them from
 * there, rather than typing the strings a second time.
 */
export const ABSORBED_CHARGE_REASONS = [
  'owner_use', 'early_departure_wash', 'short_stay_in_rate', 'vacant',
] as const
export type AbsorbedChargeReason = typeof ABSORBED_CHARGE_REASONS[number]

/** What a person reads. Never show the raw value. */
export const ABSORBED_CHARGE_REASON_LABEL: Record<AbsorbedChargeReason, string> = {
  owner_use: 'Owner-occupied space',
  early_departure_wash: 'Left early, called it a wash',
  short_stay_in_rate: 'Included in the nightly rate',
  vacant: 'Empty space',
}

/** Why a wash stopped counting. */
export const WASH_UNWIND_REASONS = ['checkout_undone', 'refund_issued'] as const
export type WashUnwindReason = typeof WASH_UNWIND_REASONS[number]

export const WASH_UNWIND_REASON_LABEL: Record<WashUnwindReason, string> = {
  checkout_undone: 'The check-out was undone',
  refund_issued: 'A refund went out after all',
}

/**
 * WHICH UTILITY A WASH COVERS — ONE LIST, TWO READERS.
 *
 * The billing gate asks this of a stub it is ABOUT to bill (utilityBilling
 * departingPayersFinalStubBillsNobody); voidBilledFinalStubs below asks it of a
 * stub ALREADY billed, when the money answer lands late. It was spelled out in
 * both places, and the two spellings drifted: the gate refuses a pooled RUBS
 * share, the reversal took one back anyway — so a neighbor-split share that no
 * wash ever absorbed came off the guest's account and was written down nowhere,
 * which is exactly the migration's own warning ("the first one somebody forgets
 * is the day the number stops being trustworthy"). So there is one list and
 * both sides read it.
 *
 * A wash covers a departing payer's OWN read and nothing else:
 *   'submeter'       — their meter, their kilowatts.
 *   'comparable_low' — the estimate that stands in for their read when the
 *                      meter stopped turning. A meter that quit is not a reason
 *                      the departing guest's final bill lands on them after all.
 *
 * Everything else bills as usual. A flat charge is not usage — it is the price
 * of the month the lease sets, and the money side of a wash is already the
 * price-as-booked money they were not given back, so eating it too would hand
 * the same thing over twice. A pooled share is a slice of a master nobody read
 * for this space, and absorbing a share the neighbors were split against would
 * quietly change what every one of them was billed for.
 */
export const WASH_COVERED_ALLOCATION_METHODS = ['submeter', 'comparable_low'] as const
export type WashCoveredAllocationMethod = typeof WASH_COVERED_ALLOCATION_METHODS[number]

/** True when a wash can absorb — or take back — a stub allocated this way. */
export const washCoversAllocationMethod = (m: string | null | undefined): boolean =>
  m != null && (WASH_COVERED_ALLOCATION_METHODS as readonly string[]).includes(m)

/**
 * Where a departure stands on the money question.
 *   'wash'      — they left early and kept no refund: eat the final stub.
 *   'bill'      — a refund went out, they left on their booked day, or they
 *                 still owed: bill the final stub as usual.
 *   'undecided' — nobody has answered yet. This is what drives the hold, and it
 *                 is why this is not a boolean: a `false` here would read as
 *                 "bill it", which is the one thing that must not happen while
 *                 the answer is still open.
 */
export type WashVerdict = 'wash' | 'bill' | 'undecided'

// ─── The departure ───────────────────────────────────────────────────────────

/**
 * Which departure is being talked about. At least one id, and WHEN A STAY HAS
 * BOTH, THE BOOKING IS THE DEPARTURE — a long stay on a lease is one person
 * driving away, not two events, and keying it twice is how the double-count
 * Nic is trying to avoid gets in. `normalizeDeparture` enforces that before
 * anything is written, so no caller has to remember it.
 */
export interface DepartureRef {
  bookingId?: string | null
  leaseId?: string | null
}

export class WashInputError extends Error {}

/** The booking wins when there is one; the lease alone is an ordinary move-out. */
export function normalizeDeparture(ref: DepartureRef): { bookingId: string | null; leaseId: string | null; key: string } {
  const bookingId = ref.bookingId ?? null
  const leaseId = ref.leaseId ?? null
  if (!bookingId && !leaseId) throw new WashInputError('A departure needs a booking or a lease to be about.')
  return { bookingId, leaseId, key: bookingId ?? (leaseId as string) }
}

/**
 * The day a stay was BOOKED THROUGH — the same expression loadStay reads as
 * `sold_check_out` (earlyCheckOut), not a column of its own. An early check-out
 * moves check_out back to the day they left and keeps the day they bought in
 * booked_check_out, so the day they paid through is the later of the two.
 */
const BOOKED_THROUGH_SQL = `GREATEST(COALESCE(b.booked_check_out, b.check_out), b.check_out)`

/** Matches the one wash row for a departure, booking first. */
const washWhere = (bookingId: string | null, leaseId: string | null) =>
  bookingId
    ? { sql: 'w.booking_id = $2', param: bookingId }
    : { sql: 'w.booking_id IS NULL AND w.lease_id = $2', param: leaseId as string }

// ─── Where the money-kept figure comes from ──────────────────────────────────

export interface MoneyKept {
  /**
   * Money that stayed with the landlord above what the nights they used are
   * worth BEFORE tax. $589 paid, 14 nights worth $538 on the two-week rate, so
   * $51. See `lodgingTaxOnRepricedStay` for why the tax is kept out of here.
   */
  amountKept: number
  refundGiven: boolean
  refundAmount: number
  departedOn: string | null
  paidThrough: string | null
  /** The short-term lodging tax re-pricing the stay would owe. 0 on a lease. */
  lodgingTaxOwed: number
  /**
   * `amountKept` less that tax — what the landlord is REALLY ahead. $15.49 on
   * the live RV 10 departure.
   *
   * Only `amountKept` is ever STAMPED on the wash row, because that is a cash
   * fact and the tax is a liability. The report prices the tax again when it is
   * read (washPairing), so a property that changes its short-term rate sees
   * today's liability rather than one frozen at check-out — which is the right
   * way round: the figure answers "what would squaring this up cost me now?"
   */
  amountKeptNet: number
  /** Plain words naming the record this was read from, for the log and the report. */
  source: string
}

// ─── The lodging tax a re-priced stay would owe and nobody collected ─────────

/**
 * 10/20 (Nic) — THE TAX HAS TO BE IN THE DIFFERENCE, EVEN THOUGH NOBODY PAID IT.
 *
 *   "Victor and Nemesio, it's $269 each at 2 weeks, but it's also plus the
 *    short-term lodging tax. That, like, even though they weren't charged the
 *    tax needs to be factored in as opposed to the difference calculation for
 *    the wash, [be]cause that's tax we would have to pay if we refunded the
 *    difference and relog it as a 2 week stay."
 *
 * A stay of 30 nights or more carries NO short-term lodging tax; a two-week
 * stay is short-term and taxable. So a month guest who pulls out at 14 nights
 * paid $589 with no tax on it, and the honest version of what they used is a
 * two-week stay — which would have owed the tax. Calling the whole difference
 * money kept says the landlord is $51 ahead when the real answer is:
 *
 *     paid                                            $589.00
 *     14 nights = 2 weeks at $269                     -$538.00
 *     the lodging tax that re-pricing owes, at 6.60%   -$35.51
 *     ------------------------------------------------------
 *     really ahead                                      $15.49
 *
 * and $15.49 is the figure the absorbed power gets set against. The landlord
 * remits that tax out of his own pocket if he ever squares it up, so counting
 * it as money he kept would flatter him by $35.51 a departure — in a report
 * whose entire purpose is "I want to make sure that it's somewhat fair."
 *
 * WHICH RATE, AND WHY IT IS THE PROPERTY'S CURRENT ONE. `unit_bookings`
 * stamps `stay_tax_rate` at booking time (Mountain View's two live departures
 * carry 6.35%), and GAM never reprices history off a stamped rate. But this is
 * not history: it is the tax a stay RE-LOGGED TODAY would owe, and nothing was
 * ever collected or remitted on the long stay to reprice. The rate that would
 * actually be handed to the state is the property's own short-term rate now
 * (6.60%), so that is the rate, and it is the rate Nic worked the figure at.
 *
 * AND THE WORTH ITSELF IS NOT A SECOND OPINION. The nights stayed are priced by
 * the shared `priceNightsStayedBetween` with this property's own proration
 * answer — the same function, the same rates and the same setting the desk's
 * "Refund the unused nights ($X)" figure comes from. Only the lodging rate fed
 * into it differs, which is precisely the thing being corrected. The pricer
 * already knows the 30-night cliff, so a departure that is still 30+ nights
 * after re-pricing owes nothing and a property with no short-term rate is
 * untouched, without either rule being written a second time here.
 */
export interface RepricedStayTax {
  /** The nights stayed, priced BEFORE any lodging tax. Null if the site has no rates on file. */
  pretaxWorth: number | null
  /** The lodging tax those nights would owe at the property's current short-term rate. */
  lodgingTaxOwed: number
  /** The rate used, as a percentage, for the sentence a landlord reads. */
  taxRatePct: number
}

/** The columns `repricedStayTax` needs, on a query that already joins the stay. */
const REPRICED_STAY_TAX_COLUMNS = `
  to_char(b.check_in, 'YYYY-MM-DD') AS rst_check_in,
  COALESCE(p.short_term_tax_rate, 0)::float AS rst_tax_pct,
  COALESCE(u.nightly_rate, p.nightly_rate) AS rst_nightly,
  COALESCE(u.weekly_rate, p.weekly_rate)   AS rst_weekly,
  COALESCE(u.monthly_rate, p.monthly_rate) AS rst_monthly,
  ${departureRuleSql('prorates_mid_month_rent')} AS rst_prorates`

/**
 * Price the nights stayed and the lodging tax re-pricing them would owe, off a
 * row that selected `REPRICED_STAY_TAX_COLUMNS`.
 *
 * `pretaxWorth` comes back null when the space has no nightly, weekly or
 * monthly rate on file — there is nothing to price with, so the caller keeps
 * whatever worth its own record carries and no tax is claimed. Inventing one
 * would be the guess this module exists to avoid.
 */
export function repricedStayTax(
  row: any, leftOn: string | null, opts: { leased?: boolean } = {},
): RepricedStayTax {
  const pct = Number(row?.rst_tax_pct ?? 0)
  const none: RepricedStayTax = { pretaxWorth: null, lodgingTaxOwed: 0, taxRatePct: pct }
  // 10/20 — A LEASE-BACKED DEPARTURE HAS NO STAY PRICE TO TAKE OFF.
  //
  // Checking a LONG stay out ends its lease on the day they left, and the money
  // then in question is the RENT already paid past that day (#38 Q8) — which is
  // why the check-out window writes its decision row with `stayed_worth` 0 on
  // purpose. Pricing the nights they did stay against that rent takes two weeks
  // of stay off money that was never a stay charge, and then this function's
  // tax comes off the remainder: a short-term lodging tax on rent. $1,178.00 of
  // paid-ahead rent read $604.49 on the landlord's card, and a departure with
  // less than the nights are worth behind it read nothing at all and got no
  // wash row, while its power was absorbed all the same.
  //
  // Rent is not a short stay and re-logging it owes the state nothing — the
  // same answer this module already gives a plain lease move-out
  // (moneyKeptForDeparture's lease branch). Nothing to re-price and no rate
  // used, so no rate is named either.
  if (opts.leased) return { pretaxWorth: null, lodgingTaxOwed: 0, taxRatePct: 0 }
  if (!row?.rst_check_in || !leftOn) return none
  const rates: StayRates = { nightly: row.rst_nightly, weekly: row.rst_weekly, monthly: row.rst_monthly }
  if (rates.nightly == null && rates.weekly == null && rates.monthly == null) return none
  const priced = priceNightsStayedBetween(rates, pct, row.rst_check_in, leftOn,
    { proratesMidMonth: row.rst_prorates !== false })
  if (!(priced.base > 0)) return none
  return { pretaxWorth: round2(priced.base), lodgingTaxOwed: round2(priced.tax), taxRatePct: pct }
}

/**
 * The same answer for a caller that has the departure in its hand instead of a
 * row — the check-out window, which writes the wash the moment the desk says
 * "no refund" and must stamp the SAME pre-tax worth this module reads back.
 *
 * It exists so the figure has one definition. The desk's own "what the nights
 * they stayed are worth" is priced TAX IN, at the rate stamped on the booking,
 * because that is what the guest's money was priced at; the wash row holds what
 * the till is up BEFORE tax, because the report prices the lodging tax against
 * it when it is read (washPairing). A writer that takes the tax out itself has
 * it taken out twice, and the landlord's card says he kept nothing on a
 * departure he is $51 up on.
 */
export async function repricedStayTaxForBooking(
  q: Q, bookingId: string, leftOn: string | null, opts: { leased?: boolean } = {},
): Promise<RepricedStayTax> {
  // A caller that holds the departure holds the lease behind it too, and says
  // so here: a long stay's money is paid-ahead rent, not a stay price, so
  // there is nothing to re-price (see repricedStayTax). Not read off the
  // booking, because by the time this runs the check-out has already ended
  // that lease and the row would say different things at different moments.
  if (opts.leased) return repricedStayTax(null, leftOn, opts)
  const row = (await q.query<any>(
    `SELECT ${REPRICED_STAY_TAX_COLUMNS}
       FROM unit_bookings b
       JOIN units u ON u.id = b.unit_id
       JOIN properties p ON p.id = u.property_id
      WHERE b.id = $1`, [bookingId])).rows[0]
  return repricedStayTax(row, leftOn, opts)
}

/**
 * THE MONEY KEPT, READ AND NEVER INVENTED.
 *
 * For a stay it comes out of stay_checkout_decisions, the row the check-out
 * window wrote: GREATEST(0, paid − stayed_worth) − refund_total. That is the
 * same arithmetic behind the "Refund the unused nights ($X)" figure the desk
 * was shown and declined (earlyCheckOut Quote.unused), so the number in the
 * book is the number the person at the desk saw, not a later re-derivation that
 * could drift when a rate or a ladder changes. RV 10 and RV 11: $589 paid, 14
 * nights worth $538 on the two-week rate, so $51 each stayed with the landlord.
 *
 * For a lease move-out with no stay it comes out of lease_prepaid_credits —
 * the 'reclassified' credit that bookingLeaseBilling banks when rent has been
 * paid past a shortened end — which is where a resident's paid-ahead money
 * actually sits.
 *
 * Null when neither record exists. The caller then has nothing to record, and
 * guessing would put a made-up number in the one place Nic wants to trust.
 */
export async function moneyKeptForDeparture(
  ref: DepartureRef, landlordId: string, q: Q = poolQ,
): Promise<MoneyKept | null> {
  const { bookingId, leaseId } = normalizeDeparture(ref)

  if (bookingId) {
    const d = (await q.query<any>(
      `SELECT to_char(d.left_on, 'YYYY-MM-DD') AS left_on,
              to_char(${BOOKED_THROUGH_SQL}, 'YYYY-MM-DD') AS booked_through,
              d.paid, d.stayed_worth, d.refund_total, d.status, d.choice, d.lease_id,
              ${REPRICED_STAY_TAX_COLUMNS}
         FROM stay_checkout_decisions d
         JOIN unit_bookings b ON b.id = d.booking_id
         JOIN units u ON u.id = b.unit_id
         JOIN properties p ON p.id = u.property_id
        WHERE d.booking_id = $1 AND d.landlord_id = $2 AND d.status IN ('pending', 'decided')`,
      [bookingId, landlordId])).rows[0]
    if (!d) return await moneyKeptFromTheBookingItself(bookingId, landlordId, q)
    const refundAmount = num(d.refund_total)
    // The nights they used, priced BEFORE the lodging tax. The decision row's
    // own `stayed_worth` carries the tax at the rate stamped on the booking,
    // which on a 30+ night stay was never charged and never remitted — so
    // leaving it in there would subtract a tax nobody paid and then subtract
    // the real liability on top of it. Where the space has no rates to price
    // with, the record's worth is all there is and no tax is claimed.
    //
    // A LONG stay is the other shape: its row carries a lease and a
    // `stayed_worth` of 0, because the money is rent paid past the day that
    // lease ended rather than a stay price. Nothing to re-price there and no
    // lodging tax on rent — `leased` says so, and the row's own worth stands.
    const rst = repricedStayTax(d, d.left_on, { leased: !!d.lease_id })
    const pretaxWorth = rst.pretaxWorth ?? num(d.stayed_worth)
    const unused = Math.max(0, round2(num(d.paid) - pretaxWorth))
    const amountKept = Math.max(0, round2(unused - refundAmount))
    // No difference means nothing to re-log, so no tax arises. The liability
    // comes from re-pricing the stay, not from the stay existing.
    const lodgingTaxOwed = amountKept > 0 ? rst.lodgingTaxOwed : 0
    return {
      amountKept,
      refundGiven: refundAmount > 0,
      refundAmount,
      departedOn: d.left_on,
      paidThrough: d.booked_through,
      lodgingTaxOwed,
      amountKeptNet: Math.max(0, round2(amountKept - lodgingTaxOwed)),
      source: 'the check-out window\'s money answer (stay_checkout_decisions: what they paid beyond the nights they stayed, less anything refunded)',
    }
  }

  // The day a LEASE was paid through is stored nowhere as a day. What IS stored
  // is the rent the paid-ahead credit was reclassified FROM, and that rent's
  // due date is a day they had genuinely paid toward — a real fact rather than
  // a re-derivation of the property's billing cycle, which is not this module's
  // to guess. A caller that knows better (the lane that ends the lease knows
  // exactly which rent it dropped) passes paidThrough and this is not used.
  const l = (await q.query<{ ahead: string; ended_on: string | null; paid_through: string | null }>(
    `SELECT COALESCE(SUM(c.amount_remaining), 0) AS ahead,
            to_char(LEAST(COALESCE(l.end_date, 'infinity'::date),
                          COALESCE(timezone(p.timezone, l.terminated_at)::date, 'infinity'::date)), 'YYYY-MM-DD') AS ended_on,
            to_char(MAX(pay.due_date), 'YYYY-MM-DD') AS paid_through
       FROM leases l
       JOIN units u ON u.id = l.unit_id
       JOIN properties p ON p.id = u.property_id
       LEFT JOIN lease_prepaid_credits c
         ON c.lease_id = l.id AND c.funded_by = 'reclassified'
        AND c.voided_at IS NULL AND c.amount_remaining > 0
       LEFT JOIN payments pay ON pay.id = c.source_payment_id
      WHERE l.id = $1 AND l.landlord_id = $2
      GROUP BY l.id, l.end_date, l.terminated_at, p.timezone`,
    [leaseId, landlordId])).rows[0]
  if (!l) return null
  const ahead = num(l.ahead)
  if (!(ahead > 0)) return null
  return {
    amountKept: ahead,
    refundGiven: false,
    refundAmount: 0,
    departedOn: l.ended_on,
    paidThrough: l.paid_through,
    // A lease is rent, not a short stay, so re-pricing it owes no lodging tax.
    // (And a lease never becomes a wash anyway — recordMoneyKeptOnDeparture
    // refuses one. Zero here says so plainly instead of leaving it undefined.)
    lodgingTaxOwed: 0,
    amountKeptNet: ahead,
    source: 'rent paid past the day the lease ended (lease_prepaid_credits, the reclassified paid-ahead credit)',
  }
}

/**
 * A STAY WITH NO MONEY ANSWER ON FILE, which is what a property that never
 * gives money back produces: the check-out window writes no decision row
 * because it put no question to the desk (earlyCheckOut `noRefunds`), yet real
 * money stayed with the landlord and somebody is about to be billed for power
 * they would not have used.
 *
 * So the figure comes from the booking itself — what they paid, less what the
 * nights they stayed are worth — priced by the SHARED priceNightsStayedBetween
 * with this property's own proration answer, which is the same function and the
 * same setting the desk's "Refund the unused nights ($X)" figure comes from.
 *
 * 10/20 (Nic): the worth is taken PRE-TAX and the lodging tax a re-priced stay
 * would owe is reported beside it, at the property's current short-term rate —
 * see repricedStayTax for why that rate and not the one stamped on the booking.
 *
 * Null when they have not paid: nothing was kept, so there is nothing to wash.
 */
async function moneyKeptFromTheBookingItself(
  bookingId: string, landlordId: string, q: Q,
): Promise<MoneyKept | null> {
  const b = (await q.query<any>(
    `SELECT to_char(b.check_out, 'YYYY-MM-DD') AS left_on,
            to_char(${BOOKED_THROUGH_SQL}, 'YYYY-MM-DD') AS booked_through,
            COALESCE(b.total_amount, 0)::float AS paid,
            (b.balance_paid_at IS NOT NULL) AS balance_paid,
            ${REPRICED_STAY_TAX_COLUMNS}
       FROM unit_bookings b
       JOIN units u ON u.id = b.unit_id
       JOIN properties p ON p.id = u.property_id
      WHERE b.id = $1 AND b.landlord_id = $2`, [bookingId, landlordId])).rows[0]
  if (!b || !b.balance_paid || !(num(b.paid) > 0)) return null
  if (!(b.left_on < b.booked_through)) return null
  // No `leased` flag to pass, and none is needed: checking a LONG stay out
  // always ends its lease (writeCheckOut's only caller passes
  // endsLease: !!s.lease_id), which moves booked_check_out to the day they
  // left — so the gate just above has already turned a lease-backed departure
  // away before any of its rent could be re-priced as a stay. Anything that
  // ever checks a lease-backed stay out WITHOUT ending its lease has to pass
  // the flag here, the way the other two readers do.
  const rst = repricedStayTax(b, b.left_on)
  // No rates on the space, so nothing can be priced and nothing can be claimed.
  if (rst.pretaxWorth == null) return null
  const kept = Math.max(0, round2(num(b.paid) - rst.pretaxWorth))
  if (!(kept > 0)) return null
  return {
    amountKept: kept, refundGiven: false, refundAmount: 0,
    departedOn: b.left_on, paidThrough: b.booked_through,
    lodgingTaxOwed: rst.lodgingTaxOwed,
    amountKeptNet: Math.max(0, round2(kept - rst.lodgingTaxOwed)),
    source: 'the reservation itself (what they paid, less what the nights they stayed are worth on the shared stay pricer) — this property never puts the refund question to the desk',
  }
}

// ─── 1. Is this departure a wash? ────────────────────────────────────────────

export interface WashStatus {
  verdict: WashVerdict
  /** Plain words for a log line, a to-do or the landlord. Never an enum. */
  why: string
  /** The wash row, once one is on file. */
  washId: string | null
  amountKept: number
  refundGiven: boolean
  refundAmount: number
  departedOn: string | null
  paidThrough: string | null
}

/**
 * The one answer to "do we eat this one's power?".
 *
 * Reads, in order: the wash row if it is already on file (the money answer has
 * landed and been recorded); else the check-out window's own answer; else the
 * property's early_departure_refunds setting, because a property that does not
 * give money back has nothing to ask and nothing went back by definition.
 */
export async function washVerdict(
  ref: DepartureRef, landlordId: string, q: Q = poolQ,
): Promise<WashStatus> {
  const { bookingId, leaseId } = normalizeDeparture(ref)
  const none: WashStatus = {
    verdict: 'undecided', why: '', washId: null, amountKept: 0,
    refundGiven: false, refundAmount: 0, departedOn: null, paidThrough: null,
  }

  // A LEASE NEVER WASHES. STAYS ONLY.
  //
  // 10/20 (Nic), pushing back on this covering both: "A lease is an agreed upon
  // amount. They're responsible for that time. Stays are just kind of a verbal,
  // like, hey, we're here. But a lease is a legal document. If it says they're
  // good through, you know, 2 more months and they leave early and we keep the
  // money, that's money that we're legally entitled to. They are obligated to
  // that because it's a lease. Unless we release the spot early. But that's a
  // whole mess I don't want to get into at this point."
  //
  // So the two are not the same shape of money and the wash does not read
  // across them. Rent a departing tenant owes for time they contracted for is
  // not a windfall to set a power bill against — it is a debt they still owe,
  // and their final utility is theirs to pay like any other month of it. The
  // wash exists for a stay, where the money was never owed under a document in
  // the first place and keeping it is a judgment call at the desk.
  //
  // Releasing the spot early is the open question he named and declined, and it
  // is the one thing that would change this answer. Nothing here guesses at it.
  if (!bookingId) {
    return { ...none, verdict: 'bill',
      why: 'A lease is an agreed amount for an agreed time, so a tenant who leaves early still owes it '
        + 'and their final utility bills normally. The wash is for stays.' }
  }

  // Already recorded. An unwound row is not a wash any more, and says so.
  const w = washWhere(bookingId, leaseId)
  const live = (await q.query<{
    id: string; amount_kept: string; refund_given: boolean; refund_amount: string
    departed_on: string; paid_through: string; unwound_at: Date | null; unwound_reason: string | null
  }>(
    `SELECT w.id, w.amount_kept, w.refund_given, w.refund_amount,
            to_char(w.departed_on, 'YYYY-MM-DD') AS departed_on,
            to_char(w.paid_through, 'YYYY-MM-DD') AS paid_through,
            w.unwound_at, w.unwound_reason
       FROM early_departure_washes w
      WHERE ${w.sql} AND w.landlord_id = $1`, [landlordId, w.param])).rows[0]
  if (live) {
    const base = {
      washId: live.id,
      amountKept: num(live.amount_kept),
      refundGiven: live.refund_given,
      refundAmount: num(live.refund_amount),
      departedOn: live.departed_on,
      paidThrough: live.paid_through,
    }
    if (live.unwound_at) {
      return { ...base, verdict: 'bill', amountKept: 0, why: `${live.unwound_reason}, so the final utility bills normally.` }
    }
    if (live.refund_given) {
      return { ...base, verdict: 'bill', why: `${money(base.refundAmount)} went back, so the final utility bills normally.` }
    }
    if (!(base.amountKept > 0)) {
      return { ...base, verdict: 'bill', why: 'Nothing stayed with the landlord, so there is nothing to wash.' }
    }
    return { ...base, verdict: 'wash', why: `They left early and ${money(base.amountKept)} stayed with the landlord, so the final utility is a wash.` }
  }

  // Not recorded yet: read the check-out window directly.
  if (bookingId) {
    const d = (await q.query<{ status: string; choice: string | null; refund_total: string; early: boolean }>(
      `SELECT d.status, d.choice, d.refund_total, (d.left_on < ${BOOKED_THROUGH_SQL}) AS early
         FROM stay_checkout_decisions d
         JOIN unit_bookings b ON b.id = d.booking_id
        WHERE d.booking_id = $1 AND d.landlord_id = $2 AND d.status IN ('pending', 'decided')`,
      [bookingId, landlordId])).rows[0]
    if (d) {
      const kept = await moneyKeptForDeparture({ bookingId }, landlordId, q)
      const shared = {
        washId: null,
        amountKept: kept?.amountKept ?? 0,
        refundGiven: kept?.refundGiven ?? false,
        refundAmount: kept?.refundAmount ?? num(d.refund_total),
        departedOn: kept?.departedOn ?? null,
        paidThrough: kept?.paidThrough ?? null,
      }
      if (!d.early) return { ...shared, verdict: 'bill', why: 'They left on the day they booked through, so nothing was kept.' }
      // Waiting on somebody who can refund. The stub holds; see settleFinalStubForDeparture.
      if (d.status === 'pending' || !d.choice) {
        return { ...shared, verdict: 'undecided', why: 'The money question on this check-out has not been answered yet.' }
      }
      if (d.choice === 'no_refund') {
        return { ...shared, verdict: 'wash', why: `No refund was given and ${money(shared.amountKept)} stayed with the landlord, so the final utility is a wash.` }
      }
      if (d.choice === 'refund_unused' || d.choice === 'refund_other') {
        return { ...shared, verdict: 'bill', why: `${money(shared.refundAmount)} went back, so the final utility bills normally.` }
      }
      // 'keep_price' / 'nights_only' answer the OTHER question — a guest who
      // still owed. Nothing was kept, so there is nothing to wash: the wash is
      // about money kept, not money never collected.
      return { ...shared, verdict: 'bill', why: 'They still owed for the stay, so there is nothing to wash — money kept is the question, not money never collected.' }
    }
  }

  // No answer on file anywhere. A property that does not give money back has
  // no question to ask: the price as booked stands, so nothing went back.
  const prop = (await q.query<{ refunds: boolean }>(
    bookingId
      ? `SELECT ${departureRuleSql('early_departure_refunds')} AS refunds
           FROM unit_bookings b JOIN units u ON u.id = b.unit_id JOIN properties p ON p.id = u.property_id
          WHERE b.id = $1 AND b.landlord_id = $2`
      : `SELECT ${departureRuleSql('early_departure_refunds')} AS refunds
           FROM leases l JOIN units u ON u.id = l.unit_id JOIN properties p ON p.id = u.property_id
          WHERE l.id = $1 AND l.landlord_id = $2`,
    [bookingId ?? leaseId, landlordId])).rows[0]
  if (!prop) return { ...none, why: 'That departure is not on this landlord\'s books.' }

  const kept = await moneyKeptForDeparture(ref, landlordId, q)
  if (prop.refunds) {
    return {
      ...none,
      amountKept: kept?.amountKept ?? 0,
      departedOn: kept?.departedOn ?? null,
      paidThrough: kept?.paidThrough ?? null,
      why: 'Nobody has answered the money question on this departure yet.',
    }
  }
  if (!kept || !(kept.amountKept > 0)) {
    return { ...none, verdict: 'bill', why: 'Nothing was paid past the day they left, so there is nothing to wash.' }
  }
  return {
    washId: null, verdict: 'wash',
    amountKept: kept.amountKept, refundGiven: false, refundAmount: 0,
    departedOn: kept.departedOn, paidThrough: kept.paidThrough,
    why: `This property does not give money back when someone leaves early, so ${money(kept.amountKept)} stayed with the landlord and the final utility is a wash.`,
  }
}

// ─── 2. Record the money kept (called at check-out) ──────────────────────────

export interface RecordMoneyKeptInput {
  landlordId: string
  ref: DepartureRef
  /**
   * The space this departure was on. Optional, and CHECKED rather than
   * trusted: these arrive from a request body, and the departure itself is
   * already scoped to the landlord, so the space is read from the departure
   * and a value passed here only ever has to agree with it. Without that a
   * request could have pinned one landlord's wash onto another's space.
   */
  propertyId?: string
  unitId?: string
  tenantId?: string | null
  checkoutDecisionId?: string | null
  /** The day they left and the day they had paid or booked through. */
  departedOn?: string | null
  paidThrough?: string | null
  /** Omit and it is read from the record — see moneyKeptForDeparture. */
  amountKept?: number
  refundGiven?: boolean
  refundAmount?: number
  recordedBy?: string | null
  notes?: string | null
  /** Pass the check-out's own client so this lands or rolls back with it. */
  client?: PoolClient
}

export interface RecordMoneyKeptResult {
  /** Null when there was nothing to record (nothing kept, or they left on their booked day). */
  washId: string | null
  isWash: boolean
  amountKept: number
  /** Stubs that were parked waiting on this answer and are now on the book. */
  absorbedHolds: number
  /**
   * Parked stubs this answer sent back to normal billing — each already BILLED
   * as it was let go, and each naming the bill it became (`billId`). Here to be
   * reported, not to be acted on: a caller that drops it loses nothing.
   */
  releasedStubs: ParkedStub[]
  /** Already-billed stubs this answer voided, because a wash bills nobody. */
  reversedBills: number
  /**
   * Lines the voided bills above were written to on the absorbed book, one per
   * meter. Never fewer than one when something was voided: a charge taken off a
   * resident's account that lands on no book is the number Nic asked for going
   * missing.
   */
  absorbedBills: number
  /**
   * Already-billed stubs that could NOT be voided because they are paid. Never
   * swallowed: a paid bill is money that has moved, and giving it back is a
   * refund decision, not something this module makes on its own.
   */
  paidBillsLeftAlone: number
  why: string
}

/**
 * Called when the desk answers the money question (and again if the answer
 * changes). Writes the money side, then settles whatever the power side is
 * already waiting on — in either order, which is the point.
 */
export async function recordMoneyKeptOnDeparture(input: RecordMoneyKeptInput): Promise<RecordMoneyKeptResult> {
  const { bookingId, leaseId } = normalizeDeparture(input.ref)
  const own = !input.client
  const client = input.client ?? await getClient()
  try {
    if (own) await client.query('BEGIN')

    const read = (input.amountKept == null || !input.departedOn || !input.paidThrough)
      ? await moneyKeptForDeparture(input.ref, input.landlordId, client)
      : null
    const amountKept = round2(input.amountKept ?? read?.amountKept ?? 0)
    const refundAmount = round2(input.refundAmount ?? read?.refundAmount ?? 0)
    const refundGiven = input.refundGiven ?? (refundAmount > 0)
    const departedOn = input.departedOn ?? read?.departedOn ?? null
    const paidThrough = input.paidThrough ?? read?.paidThrough ?? null

    const nothing = (why: string): RecordMoneyKeptResult => ({
      washId: null, isWash: false, amountKept: 0, absorbedHolds: 0,
      releasedStubs: [], reversedBills: 0, absorbedBills: 0, paidBillsLeftAlone: 0, why,
    })

    // Stays only (10/20, Nic — see washVerdict for his words). Rent a tenant
    // contracted for and left behind is a debt they still owe, not a windfall
    // to set a power bill against, so no lease departure gets a wash row at
    // all. Gated here as well as in washVerdict so one cannot be written by a
    // caller that never asks for a verdict.
    if (!bookingId) {
      return nothing('A lease is an agreed amount for an agreed time, so nothing is washed and the '
        + 'final utility bills normally. The wash is for stays.')
    }

    if (!departedOn || !paidThrough) {
      return nothing('There is no record of when they left or what they had paid through, so nothing was recorded.')
    }
    // The money table only holds EARLY departures, by CHECK. Say so plainly
    // rather than letting the constraint raise.
    if (!(departedOn < paidThrough)) {
      return nothing('They left on the day they had paid through, so nothing was kept and there is nothing to record.')
    }
    if (!(amountKept > 0) && !refundGiven) {
      return nothing('Nothing stayed with the landlord, so there is nothing to record.')
    }

    // The space comes from the departure, which is already this landlord's.
    const where = await departureWhere(client, input.landlordId, { bookingId, leaseId })
    if (!where) return nothing('That departure is not on this landlord\'s books, so nothing was recorded.')
    if ((input.propertyId && input.propertyId !== where.propertyId)
        || (input.unitId && input.unitId !== where.unitId)) {
      throw new WashInputError('That space is not the one this departure was on.')
    }

    // refund_given and refund_amount must agree (CHECK): a refund of nothing is
    // not a refund.
    const refundOut = refundGiven && refundAmount > 0 ? refundAmount : 0
    const washed = refundOut === 0 && amountKept > 0

    const w = washWhere(bookingId, leaseId)
    const existing = (await client.query<{ id: string }>(
      `SELECT w.id FROM early_departure_washes w WHERE ${w.sql} AND w.landlord_id = $1`,
      [input.landlordId, w.param])).rows[0]

    let washId: string
    if (existing) {
      washId = existing.id
      await client.query(
        `UPDATE early_departure_washes
            SET amount_kept = $2, refund_given = $3, refund_amount = $4,
                departed_on = $5::date, paid_through = $6::date,
                tenant_id = COALESCE($7, tenant_id),
                checkout_decision_id = COALESCE($8, checkout_decision_id),
                notes = COALESCE($9, notes),
                -- A fresh answer puts the row back in play; the undo paths are
                -- what stamp it unwound.
                unwound_at = NULL, unwound_reason = NULL,
                updated_at = now()
          WHERE id = $1 AND landlord_id = $10`,
        [washId, amountKept, refundOut > 0, refundOut, departedOn, paidThrough,
         input.tenantId ?? where.tenantId, input.checkoutDecisionId ?? null, input.notes ?? null, input.landlordId])
    } else {
      washId = (await client.query<{ id: string }>(
        `INSERT INTO early_departure_washes
           (landlord_id, property_id, unit_id, tenant_id, lease_id, booking_id,
            checkout_decision_id, departed_on, paid_through, amount_kept,
            refund_given, refund_amount, recorded_by, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::date,$9::date,$10,$11,$12,$13,$14)
         RETURNING id`,
        [input.landlordId, where.propertyId, where.unitId, input.tenantId ?? where.tenantId,
         leaseId, bookingId, input.checkoutDecisionId ?? null, departedOn, paidThrough,
         amountKept, refundOut > 0, refundOut, input.recordedBy ?? null, input.notes ?? null])).rows[0].id
    }

    // Now the power side, whichever way round the two arrived.
    const backToBilling = `${money(refundOut)} went back, so the final utility bills normally`
    const settled = washed
      ? await absorbParkedStubs(client, input.landlordId, washId, { bookingId, leaseId })
      : await releaseParkedStubs(client, input.landlordId, { bookingId, leaseId }, backToBilling)
    // A wash decided after the stub was already billed takes that bill back off
    // the departing payer — a wash bills NOBODY — and writes it to the book in
    // the same breath, because that is the landlord absorbing it.
    const reversed = washed
      ? await voidBilledFinalStubs(client, input.landlordId, washId, { bookingId, leaseId }, departedOn)
      : { voided: 0, absorbed: 0, paidLeftAlone: 0 }
    // ...and a wash that stops being one puts any absorbed stub back. A stub
    // that was parked before this answer arrived and absorbed when it did comes
    // back through the absorbed side, not the parked one, so both lists go to
    // the caller as stubs it owes a bill for.
    const offTheBook = washed
      ? { takenBack: 0, released: [] as ParkedStub[] }
      : await takeAbsorbedStubsOffTheBook(client, input.landlordId, washId, backToBilling)
    const releasedStubs = [...settled.released, ...offTheBook.released]

    if (own) await client.query('COMMIT')

    const why = washed
      ? `${money(amountKept)} stayed with the landlord and no refund went out, so this departure is a wash.`
      : `${money(refundOut)} went back, so this departure is not a wash and the final utility bills normally.`
    logger.info({ washId, bookingId, leaseId, amountKept, refundOut, washed,
                  absorbedHolds: settled.absorbed, releasedStubs: releasedStubs.length,
                  takenBackAbsorptions: offTheBook.takenBack, reversedBills: reversed.voided,
                  absorbedBills: reversed.absorbed },
      'early departure: money kept recorded')
    return {
      washId, isWash: washed, amountKept,
      absorbedHolds: settled.absorbed,
      releasedStubs,
      reversedBills: reversed.voided,
      absorbedBills: reversed.absorbed,
      paidBillsLeftAlone: reversed.paidLeftAlone,
      why: reversed.paidLeftAlone > 0
        ? `${why} ${reversed.paidLeftAlone} final utility bill(s) were already paid, so they were left alone — giving that money back is a refund decision, not a wash.`
        : why,
    }
  } catch (e) {
    if (own) await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    if (own) client.release()
  }
}

// ─── 3. The billing gate: absorb, hold, or bill ──────────────────────────────

/**
 * A departing payer's final stub, as the billing engine computed it. The field
 * names match utilityBilling's InsertBillArgs on purpose, so a stub that comes
 * back out of a hold can be billed without re-deriving anything.
 */
export interface FinalStubInput {
  landlordId: string
  meterId: string
  unitId: string
  utilityType: string
  /** 'YYYY-MM-01'. */
  cycleMonth: string
  chargeAmount: number
  baseFeeShare?: number
  taxAmount?: number | null
  taxRatePct?: number | null
  usageAmount?: number | null
  allocationMethod?: string | null
  allocationBasis?: number | null
  ratePerUnit?: number | null
  sewerRatePerUnit?: number | null
  readingStart?: number | null
  readingEnd?: number | null
  readingStartDate?: string | null
  readingEndDate?: string | null
  ref: DepartureRef
  tenantId?: string | null
  notes?: string | null
  client?: PoolClient
}

/**
 * What happened to the stub.
 *   'absorbed'      — recorded as billed to nobody. Do NOT bill it.
 *   'held'          — parked until the money question is answered. Do NOT bill
 *                     it, and report it as not billed, the way the invite hold
 *                     already is.
 *   'bill_normally' — not a wash. Bill it as usual.
 */
export type FinalStubOutcome = 'absorbed' | 'held' | 'bill_normally'

export interface FinalStubResult {
  outcome: FinalStubOutcome
  washId: string | null
  holdId: string | null
  absorbedChargeId: string | null
  why: string
}

/**
 * 'YYYY-MM-DD' from either shape a day arrives in. The declared type is a
 * string, but a `date` column read straight off node-pg is a Date at local
 * midnight, and a Date compared against a string reads as neither before nor
 * after — which would make the test below answer "not theirs" for the stub that
 * IS theirs and bill a departed guest. Same local getters utilityBilling's
 * isoDay uses, for the same reason.
 */
const asDay = (v: string | Date | null | undefined): string | null =>
  v == null
    ? null
    : typeof v === 'string'
      ? v.slice(0, 10)
      : `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`

/** 'YYYY-MM-DD' — the last day of the cycle that starts on `cycleMonth`. */
const lastDayOfCycleMonth = (cycleMonth: string): string => {
  const [y, m] = cycleMonth.slice(0, 10).split('-').map(Number)
  const last = new Date(Date.UTC(y, m, 0))
  return `${last.getUTCFullYear()}-${String(last.getUTCMonth() + 1).padStart(2, '0')}-${String(last.getUTCDate()).padStart(2, '0')}`
}

/**
 * IS THIS SPAN THEIRS TO WASH? — and it is the whole safety of the per-departure
 * key, so it lives here with the rule rather than in whichever caller remembers.
 *
 * A departure has ONE final stub per meter: ux_utility_absorbed_charge_per_departure
 * keys on (wash_id, meter_id) and deliberately leaves the month out, so a second
 * absorbed write for the same departure and meter REPLACES the first. That is
 * right when it is the same stub recomputed — a corrected read, a billing re-run
 * — and silently destructive when it is a different span, and nothing else
 * stands in the way: absorbing writes no utility_bills row, so the per-cycle
 * bill uniqueness that normally stops a second pass is not there.
 *
 * What got through: a guest leaves a submetered site on 10/18, the closing
 * read's stub (10/4→10/18, $40.11) is absorbed, and then the month-end run
 * resolves cycle 10 to the same lease — it covered the 1st, which is
 * utilityBilling's lease_unit_history rule — with the span 10/18→10/31. Under
 * "does it end on or after the day they left" that span looked final too, and
 * October's $40.11 became $3.00: one departure's absorbed power gone and the
 * ARRIVAL's use booked under their wash.
 *
 * So the test is not "does it end after they left" but "does it cover a day they
 * were there": it runs TO OR PAST the day they left AND it BEGINS BEFORE it. A
 * span that begins on the day they left starts at their own closing read and
 * measures what came after them — the next guest's power, or nobody's. The
 * degenerate case where a span both begins and ends on that day is their own
 * closing read pair and stays theirs; without that clause a same-day final read
 * would be billed to somebody who had already driven away.
 *
 * A span with no dates of its own is the cycle month, the same fallback the
 * billing gate uses. With no day on file to test against there is nothing to
 * say, so the verdict decides, exactly as before.
 */
function spanCoversADayTheyWereThere(input: FinalStubInput, leftOn: string | null): boolean {
  if (!leftOn) return true
  const start = asDay(input.readingStartDate) ?? input.cycleMonth.slice(0, 10)
  const end = asDay(input.readingEndDate) ?? lastDayOfCycleMonth(input.cycleMonth)
  // Ends before they left: an earlier cycle of theirs, which bills as it always has.
  if (end < leftOn) return false
  if (start < leftOn) return true
  return start === leftOn && end === leftOn
}

/**
 * THE ONE CALL THE BILLING GATE MAKES on a departing payer's final stub, before
 * it decides who to bill. `outcome !== 'bill_normally'` means the share is not
 * billed to anybody and the caller reports it as not billed — exactly what
 * tryInsertBill already does with a held invite share (it returns false and the
 * unit lands in unitsSkipped, which is accurate: the unit was skipped for
 * billing).
 */
export async function settleFinalStubForDeparture(input: FinalStubInput): Promise<FinalStubResult> {
  const { bookingId, leaseId } = normalizeDeparture(input.ref)
  const own = !input.client
  const client = input.client ?? await getClient()
  try {
    if (own) await client.query('BEGIN')
    const status = await washVerdict(input.ref, input.landlordId, client)

    let result: FinalStubResult
    if (!spanCoversADayTheyWereThere(input, status.departedOn)) {
      // Not their final stub, so this module has nothing to say about it:
      // absorbing it under their departure would overwrite the stub that IS
      // theirs with use they were not here for. Whoever this belongs to, the
      // caller bills it the way it always did. Nothing parked or absorbed is
      // disturbed either — only the final stub moves wash state.
      result = {
        outcome: 'bill_normally', washId: status.washId, holdId: null, absorbedChargeId: null,
        why: 'That read does not cover the day they left, so it is not their final utility and bills as usual.',
      }
    } else if (status.verdict === 'bill') {
      // Anything parked on an earlier run was parked on a stale answer.
      // This run has the current stub in hand and inserts it the moment this
      // returns 'bill_normally', so its hold is let go without a second bill.
      // Anything else parked on this departure is billed as it is let go.
      await releaseParkedStubs(client, input.landlordId, { bookingId, leaseId }, status.why, {
        meterId: input.meterId, unitId: input.unitId,
        cycleMonth: input.cycleMonth, utilityType: input.utilityType,
      })
      if (status.washId) await takeAbsorbedStubsOffTheBook(client, input.landlordId, status.washId, status.why)
      result = { outcome: 'bill_normally', washId: status.washId, holdId: null, absorbedChargeId: null, why: status.why }
    } else if (status.verdict === 'undecided') {
      const holdId = await parkStub(client, input, { bookingId, leaseId }, status.departedOn)
      result = {
        outcome: 'held', washId: null, holdId, absorbedChargeId: null,
        why: `${status.why} The final utility is held until it is, so nobody is billed for something that may turn out to be a wash.`,
      }
    } else {
      // A wash with no row yet (the property gives no money back, so there was
      // never a question to answer): write the money side first, so the
      // absorbed stub has a departure to point at and the report has both
      // halves side by side.
      let washId = status.washId
      if (!washId) {
        const rec = await recordMoneyKeptOnDeparture({
          landlordId: input.landlordId, ref: { bookingId, leaseId },
          tenantId: input.tenantId ?? null,
          departedOn: status.departedOn, paidThrough: status.paidThrough,
          amountKept: status.amountKept, refundGiven: false, refundAmount: 0,
          notes: 'This property does not give money back when someone leaves early.',
          client,
        })
        washId = rec.washId
      }
      if (!washId) {
        if (own) await client.query('COMMIT')
        return { outcome: 'bill_normally', washId: null, holdId: null, absorbedChargeId: null,
                 why: 'Nothing stayed with the landlord, so the final utility bills normally.' }
      }
      const absorbedChargeId = await writeAbsorbedCharge(client, input, washId, { bookingId, leaseId }, status.departedOn)
      // Anything parked for this departure is now on the book.
      await absorbParkedStubs(client, input.landlordId, washId, { bookingId, leaseId })
      result = {
        outcome: 'absorbed', washId, holdId: null, absorbedChargeId,
        why: `${status.why} ${money(round2(input.chargeAmount + num(input.taxAmount)))} of ${input.utilityType} was recorded as billed to nobody.`,
      }
    }

    if (own) await client.query('COMMIT')
    logger.info({ meterId: input.meterId, unitId: input.unitId, cycle: input.cycleMonth,
                  bookingId, leaseId, outcome: result.outcome, amount: input.chargeAmount },
      'early departure: final utility stub settled')
    return result
  } catch (e) {
    if (own) await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    if (own) client.release()
  }
}

// ─── 4. Unwind ───────────────────────────────────────────────────────────────

export interface UnwindWashInput {
  landlordId: string
  ref: DepartureRef
  reason: WashUnwindReason
  /** With 'refund_issued': what went back. */
  refundAmount?: number
  client?: PoolClient
}

export interface UnwindWashResult {
  unwound: boolean
  washId: string | null
  /** Absorbed stubs taken back off the book; each is billable again. */
  releasedAbsorptions: number
  /**
   * Parked stubs let go, each BILLED on the way out and naming the bill it
   * became (`billId`). Here to be reported, not to be acted on — which is the
   * point: both callers in earlyCheckOut discard this, and when billing was
   * their job instead the power went nowhere.
   */
  releasedStubs: ParkedStub[]
  why: string
}

/**
 * A check-out undone, or a refund issued after the fact. The wash stops
 * counting and the power becomes billable again.
 *
 * The wash row is KEPT and stamped (GAM never erases), so the book still shows
 * that a wash was recorded and then undone. The absorbed rows ARE removed:
 * utility_absorbed_charges answers "what did we not get back", and a stub that
 * is about to be billed to somebody is not that. The change journal
 * (audit_utility_absorbed_charges) holds what they said.
 */
export async function unwindWash(input: UnwindWashInput): Promise<UnwindWashResult> {
  const { bookingId, leaseId } = normalizeDeparture(input.ref)
  if (!(WASH_UNWIND_REASONS as readonly string[]).includes(input.reason)) {
    throw new WashInputError(`'${input.reason}' is not a reason a wash comes undone.`)
  }
  const own = !input.client
  const client = input.client ?? await getClient()
  try {
    if (own) await client.query('BEGIN')
    const w = washWhere(bookingId, leaseId)
    const row = (await client.query<{ id: string }>(
      `SELECT w.id FROM early_departure_washes w
        WHERE ${w.sql} AND w.landlord_id = $1 AND w.unwound_at IS NULL FOR UPDATE`,
      [input.landlordId, w.param])).rows[0]

    const words = WASH_UNWIND_REASON_LABEL[input.reason]
    if (!row) {
      // Nothing recorded, but a stub may still be parked on an answer that has
      // just stopped being true.
      const released = await releaseParkedStubs(client, input.landlordId, { bookingId, leaseId }, words)
      if (own) await client.query('COMMIT')
      return {
        unwound: false, washId: null, releasedAbsorptions: 0, releasedStubs: released.released,
        why: released.released.length
          ? `${words}, so the final utility that was waiting bills normally.`
          : 'There was no wash on this departure to undo.',
      }
    }

    const refundOut = round2(input.refundAmount ?? 0)
    await client.query(
      `UPDATE early_departure_washes
          SET unwound_at = now(), unwound_reason = $2, updated_at = now(),
              refund_given = $3, refund_amount = $4
        WHERE id = $1 AND landlord_id = $5`,
      [row.id, words, refundOut > 0, refundOut, input.landlordId])

    const takenBack = await takeAbsorbedStubsOffTheBook(client, input.landlordId, row.id, words)
    const released = await releaseParkedStubs(client, input.landlordId, { bookingId, leaseId }, words)
    // A stub that was parked and then absorbed is one stub, and it comes back
    // on the absorbed side; one still waiting comes back on the parked side.
    const releasedStubs = [...takenBack.released, ...released.released]

    if (own) await client.query('COMMIT')
    logger.info({ washId: row.id, bookingId, leaseId, reason: input.reason,
                  releasedAbsorptions: takenBack.takenBack, releasedStubs: releasedStubs.length },
      'early departure: wash unwound')
    return {
      unwound: true, washId: row.id,
      releasedAbsorptions: takenBack.takenBack, releasedStubs,
      why: `${words}, so this is no longer a wash: the absorbed utility came back off the book and the final bill is owed again.`,
    }
  } catch (e) {
    if (own) await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    if (own) client.release()
  }
}

// ─── 5. The side-by-side read ────────────────────────────────────────────────

export interface WashPairingRow {
  washId: string
  propertyId: string
  unitId: string
  unitNumber: string
  who: string | null
  departedOn: string
  paidThrough: string
  /**
   * Money that stayed with the landlord, net of the lodging tax re-pricing the
   * stay would owe. THE figure the absorbed power is set against — "the amount
   * he is really ahead" (10/20, Nic). $15.49 on the live RV 10 departure, not
   * the $51.00 the till is up.
   */
  moneyKept: number
  /** What the till is up, before that tax: $51.00. */
  moneyKeptBeforeTax: number
  /**
   * The short-term lodging tax a re-priced stay would owe and nobody collected
   * — the landlord's to remit out of pocket, so never money he kept.
   * 0 on a departure with no stay behind it, and on a property with no rate.
   */
  lodgingTaxOwed: number
  /** Utility that should have been billed and was not, across every meter. */
  utilityAbsorbed: number
  /** Positive when the kept money covered the power; negative when it did not. */
  evenedOutBy: number
  /** Whether the power side has landed yet. */
  closingReadsIn: boolean
  /** Still parked on an unanswered money question. */
  heldStubs: number
}

/**
 * The report Nic asked for: "money that wasn't refunded versus electric that
 * should have been billed that wasn't charged to see how close we actually get
 * to evening out." One row per departure, both halves on it, read off the
 * wash_id join the migration keys for.
 *
 * Unwound washes are left out — they stopped being washes — and so are
 * refunded departures, which were never one.
 *
 * 10/20 (Nic): the lodging tax a re-priced stay would owe comes off the money
 * side here, because `early_departure_washes.amount_kept` stamps what the till
 * is up and that tax is a liability, not a stamp. It is priced per row off the
 * stay the wash names (repricedStayTax), in this one query, so a park with a
 * season of departures is still one read. A wash with no booking behind it owes
 * none — a lease is not a short stay.
 */
export async function washPairing(
  landlordId: string,
  opts: { propertyId?: string | null; from?: string | null; to?: string | null } = {},
  q: Q = poolQ,
): Promise<WashPairingRow[]> {
  const rows = (await q.query<any>(
    `SELECT w.id, w.property_id, w.unit_id, u.unit_number,
            to_char(w.departed_on, 'YYYY-MM-DD') AS departed_on,
            to_char(w.paid_through, 'YYYY-MM-DD') AS paid_through,
            w.amount_kept, w.lease_id,
            COALESCE(a.absorbed, 0) AS absorbed,
            COALESCE(a.n, 0) AS absorbed_rows,
            COALESCE(h.n, 0) AS held_stubs,
            COALESCE(
              (SELECT us.first_name || ' ' || us.last_name
                 FROM lease_tenants lt JOIN tenants t ON t.id = lt.tenant_id
                 JOIN users us ON us.id = t.user_id
                WHERE lt.lease_id = w.lease_id AND lt.role = 'primary' LIMIT 1),
              (SELECT b.guest_name FROM unit_bookings b WHERE b.id = w.booking_id)) AS who,
            ${REPRICED_STAY_TAX_COLUMNS}
       FROM early_departure_washes w
       JOIN units u ON u.id = w.unit_id
       JOIN properties p ON p.id = u.property_id
       LEFT JOIN unit_bookings b ON b.id = w.booking_id
       LEFT JOIN LATERAL (
         SELECT SUM(c.charge_amount + c.tax_amount) AS absorbed, COUNT(*) AS n
           FROM utility_absorbed_charges c
          WHERE c.wash_id = w.id AND c.landlord_id = w.landlord_id) a ON TRUE
       LEFT JOIN LATERAL (
         SELECT COUNT(*) AS n FROM utility_wash_holds hh
          WHERE hh.landlord_id = w.landlord_id
            AND COALESCE(hh.booking_id, hh.lease_id) = COALESCE(w.booking_id, w.lease_id)
            AND hh.absorbed_at IS NULL AND hh.released_at IS NULL) h ON TRUE
      WHERE w.landlord_id = $1
        AND w.unwound_at IS NULL AND w.refund_given = false
        AND ($2::uuid IS NULL OR w.property_id = $2::uuid)
        AND ($3::date IS NULL OR w.departed_on >= $3::date)
        AND ($4::date IS NULL OR w.departed_on <= $4::date)
      ORDER BY w.departed_on DESC, u.unit_number`,
    [landlordId, opts.propertyId ?? null, opts.from ?? null, opts.to ?? null])).rows
  return rows.map(r => {
    const moneyKeptBeforeTax = num(r.amount_kept)
    const utilityAbsorbed = num(r.absorbed)
    // Nothing kept means there was nothing to re-log, so no tax arises — and
    // neither does it on a LONG stay, whose kept figure is rent paid past the
    // day its lease ended rather than a stay price (`leased`, see
    // repricedStayTax). The lease is read off the wash row itself, which is the
    // record of what kind of departure this was.
    const lodgingTaxOwed = moneyKeptBeforeTax > 0
      ? repricedStayTax(r, r.departed_on, { leased: !!r.lease_id }).lodgingTaxOwed
      : 0
    const moneyKept = Math.max(0, round2(moneyKeptBeforeTax - lodgingTaxOwed))
    return {
      washId: r.id, propertyId: r.property_id, unitId: r.unit_id, unitNumber: r.unit_number,
      who: r.who ?? null, departedOn: r.departed_on, paidThrough: r.paid_through,
      moneyKept, moneyKeptBeforeTax, lodgingTaxOwed, utilityAbsorbed,
      evenedOutBy: round2(moneyKept - utilityAbsorbed),
      closingReadsIn: Number(r.absorbed_rows) > 0,
      heldStubs: Number(r.held_stubs),
    }
  })
}

// ─── The machinery behind the four ───────────────────────────────────────────

/** A stub waiting on a money answer, in the shape utilityBilling bills from. */
export interface ParkedStub {
  holdId: string
  landlordId: string
  meterId: string
  unitId: string
  utilityType: string
  cycleMonth: string
  chargeAmount: number
  baseFeeShare: number
  taxAmount: number | null
  taxRatePct: number | null
  usageAmount: number | null
  allocationMethod: string | null
  allocationBasis: number | null
  ratePerUnit: number | null
  sewerRatePerUnit: number | null
  readingStart: number | null
  readingEnd: number | null
  readingStartDate: string | null
  readingEndDate: string | null
  leaseId: string | null
  bookingId: string | null
  tenantId: string | null
  departedOn: string
  /**
   * The bill this stub became when its hold was let go. Null while it is still
   * parked; null too on the one hold the billing run releases and bills itself,
   * and on a space with nobody set up to be billed for utilities — letGoOfHolds
   * says which in released_reason either way.
   */
  billId: string | null
}

const PARKED_COLS = `h.id, h.landlord_id, h.meter_id, h.unit_id, h.utility_type,
  to_char(h.billing_cycle_month, 'YYYY-MM-DD') AS cycle_month,
  h.charge_amount, h.base_fee_share, h.tax_amount, h.tax_rate_pct, h.usage_amount,
  h.allocation_method, h.allocation_basis, h.rate_per_unit, h.sewer_rate_per_unit,
  h.reading_start, h.reading_end,
  to_char(h.reading_start_date, 'YYYY-MM-DD') AS reading_start_date,
  to_char(h.reading_end_date, 'YYYY-MM-DD') AS reading_end_date,
  h.lease_id, h.booking_id, h.tenant_id, to_char(h.departed_on, 'YYYY-MM-DD') AS departed_on,
  h.notes, h.released_bill_id`

const toParked = (r: any): ParkedStub => ({
  holdId: r.id, landlordId: r.landlord_id, meterId: r.meter_id, unitId: r.unit_id,
  utilityType: r.utility_type, cycleMonth: r.cycle_month,
  chargeAmount: num(r.charge_amount), baseFeeShare: num(r.base_fee_share),
  taxAmount: nullNum(r.tax_amount), taxRatePct: nullNum(r.tax_rate_pct),
  usageAmount: nullNum(r.usage_amount), allocationMethod: r.allocation_method,
  allocationBasis: nullNum(r.allocation_basis), ratePerUnit: nullNum(r.rate_per_unit),
  sewerRatePerUnit: nullNum(r.sewer_rate_per_unit),
  readingStart: nullNum(r.reading_start), readingEnd: nullNum(r.reading_end),
  readingStartDate: r.reading_start_date, readingEndDate: r.reading_end_date,
  leaseId: r.lease_id, bookingId: r.booking_id, tenantId: r.tenant_id,
  departedOn: r.departed_on, billId: r.released_bill_id ?? null,
})

/** The property, space and resident a departure belongs to. */
async function departureWhere(
  q: Q, landlordId: string, d: { bookingId: string | null; leaseId: string | null },
): Promise<{ propertyId: string; unitId: string; tenantId: string | null } | null> {
  const r = d.bookingId
    ? (await q.query<any>(
        `SELECT u.property_id, u.id AS unit_id,
                (SELECT sa.tenant_id FROM utility_service_agreements sa WHERE sa.booking_id = b.id LIMIT 1) AS tenant_id
           FROM unit_bookings b JOIN units u ON u.id = b.unit_id
          WHERE b.id = $1 AND b.landlord_id = $2`, [d.bookingId, landlordId])).rows[0]
    : (await q.query<any>(
        `SELECT u.property_id, u.id AS unit_id,
                (SELECT lt.tenant_id FROM lease_tenants lt WHERE lt.lease_id = l.id AND lt.role = 'primary' LIMIT 1) AS tenant_id
           FROM leases l JOIN units u ON u.id = l.unit_id
          WHERE l.id = $1 AND l.landlord_id = $2`, [d.leaseId, landlordId])).rows[0]
  return r ? { propertyId: r.property_id, unitId: r.unit_id, tenantId: r.tenant_id ?? null } : null
}

/**
 * What to do when this departure already has a line on the book for this meter.
 *
 *   'replace' — the billing gate, re-running on a stub it recomputed. The new
 *               figure IS the stub, so it stands in for the old one.
 *   'add'     — a ONE-WAY handover: a hold absorbed, a billed stub voided. The
 *               row it came from is stamped in the same transaction and can
 *               never be handed over twice, so adding cannot double-count — and
 *               adding is the only way a final stub that straddles two cycles,
 *               one piece billed and one piece parked, keeps both halves. Under
 *               'replace' the second piece to land would quietly stand in for
 *               the first and the book would be short by it.
 */
type OnExistingLine = 'replace' | 'add'

/** One line in the book: utility this departure used that nobody was billed for. */
async function writeAbsorbedCharge(
  q: Q, input: FinalStubInput, washId: string,
  d: { bookingId: string | null; leaseId: string | null }, departedOn: string | null,
  onExisting: OnExistingLine = 'replace',
): Promise<string> {
  const notes = input.notes
    ?? 'Left early and kept no refund — their final utility, absorbed by the landlord and billed to nobody.'
  // One absorbed stub per departure per meter (ux_utility_absorbed_charge_per_departure),
  // so a billing re-run writes the same row rather than a second one. Replacing
  // is only safe because the caller has already established that this span is
  // the departure's own final stub (spanCoversADayTheyWereThere): a span they
  // were not here for would overwrite real absorbed dollars with the next
  // guest's use, and nothing in the database would say so.
  //
  // On 'add' the cycle and the read span widen to hold both pieces rather than
  // being replaced: the month taken is the LATER one, because that is where the
  // closing read landed and where the recovery report's month filter should find
  // the departure. LEAST and GREATEST ignore nulls, so a piece with no read
  // leaves the span it already had alone.
  const add = onExisting === 'add'
  const row = (await q.query<{ id: string }>(
    `INSERT INTO utility_absorbed_charges AS c
       (meter_id, unit_id, landlord_id, utility_type, billing_cycle_month,
        allocation_method, allocation_basis, charge_amount, base_fee_share, tax_amount,
        rate_per_unit, usage_amount, reading_start, reading_end,
        reading_start_date, reading_end_date,
        reason, wash_id, lease_id, booking_id, tenant_id, departed_on, notes)
     VALUES ($1,$2,$3,$4,$5::date,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::date,$16::date,
             'early_departure_wash',$17,$18,$19,$20,$21::date,$22)
     ON CONFLICT (wash_id, meter_id) WHERE wash_id IS NOT NULL DO UPDATE
       SET charge_amount = CASE WHEN $23 THEN c.charge_amount + EXCLUDED.charge_amount
                                ELSE EXCLUDED.charge_amount END,
           base_fee_share = CASE WHEN $23 THEN c.base_fee_share + EXCLUDED.base_fee_share
                                 ELSE EXCLUDED.base_fee_share END,
           tax_amount = CASE WHEN $23 THEN c.tax_amount + EXCLUDED.tax_amount
                             ELSE EXCLUDED.tax_amount END,
           usage_amount = CASE WHEN $23
                               THEN COALESCE(c.usage_amount, 0) + COALESCE(EXCLUDED.usage_amount, 0)
                               ELSE EXCLUDED.usage_amount END,
           billing_cycle_month = CASE WHEN $23
                                      THEN GREATEST(c.billing_cycle_month, EXCLUDED.billing_cycle_month)
                                      ELSE EXCLUDED.billing_cycle_month END,
           reading_start = CASE WHEN $23 THEN LEAST(c.reading_start, EXCLUDED.reading_start)
                                ELSE EXCLUDED.reading_start END,
           reading_end = CASE WHEN $23 THEN GREATEST(c.reading_end, EXCLUDED.reading_end)
                              ELSE EXCLUDED.reading_end END,
           reading_start_date = CASE WHEN $23 THEN LEAST(c.reading_start_date, EXCLUDED.reading_start_date)
                                     ELSE EXCLUDED.reading_start_date END,
           reading_end_date = CASE WHEN $23 THEN GREATEST(c.reading_end_date, EXCLUDED.reading_end_date)
                                   ELSE EXCLUDED.reading_end_date END,
           updated_at = now()
     RETURNING c.id`,
    [input.meterId, input.unitId, input.landlordId, input.utilityType, input.cycleMonth,
     input.allocationMethod ?? null, input.allocationBasis ?? null,
     round2(input.chargeAmount), round2(input.baseFeeShare ?? 0), round2(num(input.taxAmount)),
     input.ratePerUnit ?? null, input.usageAmount ?? null,
     input.readingStart ?? null, input.readingEnd ?? null,
     input.readingStartDate ?? null, input.readingEndDate ?? null,
     washId, d.leaseId, d.bookingId, input.tenantId ?? null, departedOn, notes, add])).rows[0]
  return row.id
}

/** Park a stub until the money question is answered. */
async function parkStub(
  q: Q, input: FinalStubInput,
  d: { bookingId: string | null; leaseId: string | null }, departedOn: string | null,
): Promise<string | null> {
  // Never null: a stub that could be filed under no day at all would be
  // neither billed nor parked, which is the one outcome that loses it.
  const day = departedOn ?? input.readingEndDate ?? input.cycleMonth
  const r = (await q.query<{ id: string }>(
    `INSERT INTO utility_wash_holds
       (meter_id, unit_id, landlord_id, lease_id, booking_id, tenant_id, departed_on,
        billing_cycle_month, utility_type, usage_amount, allocation_method, allocation_basis,
        rate_per_unit, base_fee_share, charge_amount, tax_rate_pct, tax_amount,
        sewer_rate_per_unit, reading_start, reading_end, reading_start_date, reading_end_date, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7::date,$8::date,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21::date,$22::date,$23)
     ON CONFLICT (meter_id, unit_id, COALESCE(booking_id, lease_id))
       WHERE absorbed_at IS NULL AND released_at IS NULL
       DO UPDATE SET charge_amount = EXCLUDED.charge_amount,
                     base_fee_share = EXCLUDED.base_fee_share,
                     tax_amount = EXCLUDED.tax_amount,
                     usage_amount = EXCLUDED.usage_amount,
                     billing_cycle_month = EXCLUDED.billing_cycle_month,
                     reading_start = EXCLUDED.reading_start,
                     reading_end = EXCLUDED.reading_end,
                     reading_start_date = EXCLUDED.reading_start_date,
                     reading_end_date = EXCLUDED.reading_end_date,
                     updated_at = now()
     RETURNING id`,
    [input.meterId, input.unitId, input.landlordId, d.leaseId, d.bookingId,
     input.tenantId ?? null, day, input.cycleMonth, input.utilityType,
     input.usageAmount ?? null, input.allocationMethod ?? null, input.allocationBasis ?? null,
     input.ratePerUnit ?? null, round2(input.baseFeeShare ?? 0), round2(input.chargeAmount),
     input.taxRatePct ?? null, input.taxAmount ?? null, input.sewerRatePerUnit ?? null,
     input.readingStart ?? null, input.readingEnd ?? null,
     input.readingStartDate ?? null, input.readingEndDate ?? null,
     input.notes ?? 'Held: they left early and the money question has not been answered yet.'])).rows[0]
  return r?.id ?? null
}


/** The money answer came back a wash: every parked stub becomes a line in the book. */
async function absorbParkedStubs(
  q: Q, landlordId: string, washId: string,
  d: { bookingId: string | null; leaseId: string | null },
): Promise<{ absorbed: number; released: ParkedStub[] }> {
  const open = (await q.query<any>(
    `SELECT ${PARKED_COLS} FROM utility_wash_holds h
      WHERE h.landlord_id = $1 AND COALESCE(h.booking_id, h.lease_id) = $2
        AND h.absorbed_at IS NULL AND h.released_at IS NULL
      FOR UPDATE`, [landlordId, d.bookingId ?? d.leaseId])).rows
  let absorbed = 0
  for (const r of open) {
    const p = toParked(r)
    const chargeId = await writeAbsorbedCharge(q, {
      landlordId, meterId: p.meterId, unitId: p.unitId, utilityType: p.utilityType,
      cycleMonth: p.cycleMonth, chargeAmount: p.chargeAmount, baseFeeShare: p.baseFeeShare,
      taxAmount: p.taxAmount, taxRatePct: p.taxRatePct, usageAmount: p.usageAmount,
      allocationMethod: p.allocationMethod, allocationBasis: p.allocationBasis,
      ratePerUnit: p.ratePerUnit, sewerRatePerUnit: p.sewerRatePerUnit,
      readingStart: p.readingStart, readingEnd: p.readingEnd,
      readingStartDate: p.readingStartDate, readingEndDate: p.readingEndDate,
      ref: d, tenantId: p.tenantId,
      // A hold is handed over exactly once — absorbed_at is stamped below in
      // this same transaction — so it adds to whatever this meter already has
      // on the book instead of standing in for it.
    }, washId, d, p.departedOn, 'add')
    await q.query(
      `UPDATE utility_wash_holds SET absorbed_at = now(), absorbed_charge_id = $2, updated_at = now()
        WHERE id = $1 AND landlord_id = $3`, [p.holdId, chargeId, landlordId])
    absorbed++
  }
  return { absorbed, released: [] }
}

/** One sentence, however the caller's words arrived. */
const sentence = (s: string) => `${s.replace(/\s*\.?$/, '')}.`

/** What utility_bills is unique on: one bill per space, cycle and utility. */
type StubKey = { meterId: string; unitId: string; cycleMonth: string; utilityType: string }

const sameStub = (p: ParkedStub, k: StubKey): boolean =>
  p.meterId === k.meterId && p.unitId === k.unitId && p.utilityType === k.utilityType
  && p.cycleMonth.slice(0, 10) === k.cycleMonth.slice(0, 10)

/**
 * A HOLD THAT IS LET GO IS BILLED IN THE SAME BREATH.
 *
 * It did not used to be, and that is the bug this function exists to close.
 * Releasing stamped released_at, handed a ParkedStub back and trusted the
 * caller to bill it — and not one of the three callers did. The desk answering
 * "Refund the unused nights" reaches unwindWash through applyDecision, which
 * throws the return value away, so the closing read was released into nothing:
 * no utility_bills row, because the gate had already reported the stub as not
 * billed and never ran its insert; no absorbed row, because a refund means it
 * is not a wash; and off openWashHolds, which lists only holds still waiting.
 * The power was neither charged to the guest who got their money back nor
 * written down as absorbed, and the only thing that ever recovered it was a
 * billing run happening to look at that meter and cycle again inside the two
 * cycles it looks back over.
 *
 * The invite hold this table is shaped after never had that gap: releasing a
 * suspended_utility_charges row INSERTs the bill in the same statement and
 * stamps released_bill_id (utilityBilling, S629). This is the same shape.
 *
 * Nothing is re-derived. The payer is the one the billing gate had already
 * settled on when it parked this — a lease, or the agreement a stay pays its
 * site's utilities through — which is why a hold keeps the columns
 * utilityBilling bills from. Null when that payer can no longer be found, and
 * the caller says so out loud rather than swallowing it.
 */
async function billReleasedStub(
  q: Q, landlordId: string, p: ParkedStub, why: string,
): Promise<string | null> {
  // utility_bills takes exactly one payer (utility_bills_payer_source_check)
  // and its tenant_id is NOT NULL, so a hold parked without one reads the
  // payer's own resident rather than stranding the stub.
  type Payer = { lease_id: string | null; sa_id: string | null; tenant_id: string | null }
  const payer = p.leaseId
    ? (await q.query<Payer>(
        `SELECT l.id AS lease_id, NULL::uuid AS sa_id,
                COALESCE($3::uuid, (SELECT lt.tenant_id FROM lease_tenants lt
                                     WHERE lt.lease_id = l.id AND lt.role = 'primary' LIMIT 1)) AS tenant_id
           FROM leases l WHERE l.id = $1 AND l.landlord_id = $2`,
        [p.leaseId, landlordId, p.tenantId])).rows[0]
    // The agreement on this hold's own space first, then the newest: a guest
    // can have more than one on a site over a season.
    : (await q.query<Payer>(
        `SELECT NULL::uuid AS lease_id, sa.id AS sa_id,
                COALESCE($3::uuid, sa.tenant_id) AS tenant_id
           FROM utility_service_agreements sa
          WHERE sa.booking_id = $1 AND sa.landlord_id = $2
          ORDER BY (sa.unit_id = $4::uuid) DESC, sa.start_date DESC
          LIMIT 1`,
        [p.bookingId, landlordId, p.tenantId, p.unitId])).rows[0]
  if (!payer?.tenant_id) return null

  const bill = (await q.query<{ id: string }>(
    `INSERT INTO utility_bills
       (meter_id, unit_id, tenant_id, lease_id, landlord_id, billing_cycle_month,
        usage_amount, allocation_method, allocation_basis, rate_per_unit,
        base_fee_share, charge_amount, tax_rate_pct, tax_amount, utility_type,
        sewer_rate_per_unit, reading_start, reading_end,
        reading_start_date, reading_end_date, service_agreement_id, notes)
     VALUES ($1,$2,$3,$4,$5,$6::date,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,
             $19::date,$20::date,$21,$22)
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [p.meterId, p.unitId, payer.tenant_id, payer.lease_id, landlordId, p.cycleMonth,
     p.usageAmount, p.allocationMethod, p.allocationBasis, p.ratePerUnit,
     round2(p.baseFeeShare), round2(p.chargeAmount),
     // Both are NOT NULL on utility_bills and a hold may carry neither, on an
     // untaxed utility. 0 is the honest value for "no tax was charged"; NULL
     // would raise and strand the stub all over again.
     p.taxRatePct ?? 0, round2(num(p.taxAmount)), p.utilityType,
     p.sewerRatePerUnit, p.readingStart, p.readingEnd,
     p.readingStartDate, p.readingEndDate, payer.sa_id,
     `${sentence(why)} It was held while that question was open, so it is billed now.`])).rows[0]
  if (bill) return bill.id
  // The cycle already has a bill on this space — the usage is accounted for, so
  // the hold points at that one and stops waiting rather than re-running.
  return (await q.query<{ id: string }>(
    `SELECT id FROM utility_bills
      WHERE landlord_id = $5 AND meter_id = $1 AND unit_id = $2
        AND billing_cycle_month = $3::date AND utility_type = $4 AND voided_at IS NULL
      ORDER BY created_at LIMIT 1`,
    [p.meterId, p.unitId, p.cycleMonth, p.utilityType, landlordId])).rows[0]?.id ?? null
}

/**
 * Let these holds go, billing each one as it goes, so a hold is never closed
 * with its stub landing nowhere.
 *
 * `billedByCaller` names the one stub the billing run is about to insert
 * itself. The gate asks about a stub it already has in hand, and ITS numbers
 * are the fresher ones — a corrected reading changes them — so that hold is let
 * go without a bill of its own and the run's own insert is the bill. Without
 * the exception the parked copy's older figures would win the unique index and
 * the run's insert would lose to its own release.
 *
 * The stamp tolerates a hold that is already released because the absorbed path
 * has to do it in one statement: clearing absorbed_at would otherwise leave the
 * row open, and ux_utility_wash_hold_open allows only one open hold per site, so
 * a departure with a later cycle still parked would collide with itself.
 */
async function letGoOfHolds(
  q: Q, landlordId: string, holds: ParkedStub[], why: string, billedByCaller?: StubKey,
): Promise<ParkedStub[]> {
  const out: ParkedStub[] = []
  for (const p of holds) {
    const theirs = !!billedByCaller && sameStub(p, billedByCaller)
    const billId = theirs ? null : await billReleasedStub(q, landlordId, p, why)
    if (!theirs && !billId) {
      // Unreachable from the billing gate, which parks a stub only after it has
      // settled on a payer — so if it happens, something took the lease or the
      // agreement away underneath the hold and somebody has to hear about it.
      logger.error({ holdId: p.holdId, landlordId, meterId: p.meterId, unitId: p.unitId,
                     cycle: p.cycleMonth, amount: p.chargeAmount },
        'early departure: a released hold had nobody to bill — no lease and no utility service agreement on that space')
    } else {
      logger.info({ holdId: p.holdId, landlordId, billId, billedByTheRun: theirs,
                    amount: p.chargeAmount }, 'early departure: a parked stub was let go and billed')
    }
    // released_reason stays the caller's own words — the desk reads it, and
    // "The check-out was undone" is the whole of what happened. WHICH bill it
    // became is released_bill_id's job, not a sentence appended to a reason.
    await q.query(
      `UPDATE utility_wash_holds
          SET released_at = COALESCE(released_at, now()), released_reason = $2,
              released_bill_id = $3, updated_at = now()
        WHERE id = $1 AND landlord_id = $4`, [p.holdId, why, billId, landlordId])
    out.push({ ...p, billId })
  }
  return out
}

/** The money answer came back a refund: parked stubs are billed and let go. */
async function releaseParkedStubs(
  q: Q, landlordId: string,
  d: { bookingId: string | null; leaseId: string | null }, why: string,
  billedByCaller?: StubKey,
): Promise<{ absorbed: number; released: ParkedStub[] }> {
  const open = (await q.query<any>(
    `SELECT ${PARKED_COLS} FROM utility_wash_holds h
      WHERE h.landlord_id = $1 AND COALESCE(h.booking_id, h.lease_id) = $2
        AND h.absorbed_at IS NULL AND h.released_at IS NULL
      FOR UPDATE`, [landlordId, d.bookingId ?? d.leaseId])).rows
  return {
    absorbed: 0,
    released: await letGoOfHolds(q, landlordId, open.map(toParked), why, billedByCaller),
  }
}

/**
 * A wash that stopped being one: its absorbed lines come off the book.
 *
 * Removed rather than flagged, because utility_absorbed_charges answers "what
 * did we not get back" and a stub that is about to be billed to somebody is not
 * that. What they said is in the change journal.
 *
 * THE HOLD LETS GO OF THE LINE FIRST, and it has to be in that order. A stub
 * that was parked before the money answer landed was absorbed out of its hold
 * (absorbParkedStubs), so the hold still names the line being deleted —
 * absorbed_charge_id, which is ON DELETE SET NULL, against a row whose shape
 * CHECK says absorbed_at and absorbed_charge_id are set together or not at all.
 * Deleting the line underneath it clears one half of that pair and the CHECK
 * raises, inside whichever transaction the caller is holding: the desk's refund
 * decision, the undo of a check-out, or the property's whole utility run.
 *
 * Closing the hold is also what the rule wanted anyway. Coming off the book
 * means the stub is owed again, and a hold is the one place that stub exists in
 * full, so it is let go with the words that undid the wash — and BILLED, by the
 * one function that owns that pairing (letGoOfHolds). Stamping it released and
 * leaving the bill to somebody else is the whole of the bug that function was
 * written to close; leaving it marked absorbed with nothing to point at is the
 * worse bug the CHECK was there to catch, a stub that is neither on the book,
 * nor billed, nor waiting on anybody. What it said while it was absorbed is in
 * the change journal (audit_utility_wash_holds).
 */
async function takeAbsorbedStubsOffTheBook(
  q: Q, landlordId: string, washId: string, why: string,
): Promise<{ takenBack: number; released: ParkedStub[] }> {
  const released = (await q.query<any>(
    `UPDATE utility_wash_holds h
        SET absorbed_at = NULL, absorbed_charge_id = NULL,
            released_at = now(), released_reason = $3, updated_at = now()
      WHERE h.landlord_id = $1
        AND h.absorbed_charge_id IN (
              SELECT c.id FROM utility_absorbed_charges c
               WHERE c.wash_id = $2 AND c.landlord_id = $1
                 AND c.reason = 'early_departure_wash')
      RETURNING ${PARKED_COLS}`, [landlordId, washId, why])).rows
  const r = (await q.query<{ id: string }>(
    `DELETE FROM utility_absorbed_charges
      WHERE wash_id = $1 AND landlord_id = $2 AND reason = 'early_departure_wash'
      RETURNING id`, [washId, landlordId])).rows
  // Off the book means owed again, and owed again means billed.
  return { takenBack: r.length, released: await letGoOfHolds(q, landlordId, released.map(toParked), why) }
}

/**
 * A wash decided after the closing read was already billed: that bill comes off
 * the departing payer, because a wash bills NOBODY — AND ONTO THE BOOK, because
 * taking a charge off somebody's account is the landlord absorbing it.
 *
 * The void alone used to be the whole of it, and that was the bug. "If we're
 * keeping track of electric that's not billed back, we need to count that
 * there": a stub voided with nothing written in its place is power that left
 * the resident's account for nowhere. The recovery report drops a voided bill
 * from what was billed back and finds no absorbed row to put it in, and the
 * pairing read shows the kept money against an absorbed total of zero — so a
 * departure that actually evened out prints as "you came out ahead by $51.00",
 * which is the one number this whole feature exists to get right. Nothing
 * regenerates the bill on its own, either: generateBillsForMeter only runs off
 * a recorded reading or somebody pressing generate.
 *
 * So each voided stub is written to utility_absorbed_charges against the same
 * departure, out of the bill's OWN figures — the same dollars, usage and reads
 * the resident was invoiced, not a re-derivation that could drift. Summed per
 * meter first, because one departure gets one line per meter and two pieces of
 * one final stub are that line's two halves, not a race to write it last.
 *
 * Only the FINAL stub — a bill whose closing read is on or after the day they
 * left. An electric bill from two months ago that they received and never paid
 * is a debt they still owe; forgiving it is a write-off, not a wash.
 *
 * And only a stub a wash COVERS — WASH_COVERED_ALLOCATION_METHODS above, the
 * same list the gate refuses on. The date by itself is not the test, because a
 * pooled share carries the MASTER's read date: an October water share for a
 * resident who left on the 18th, off a master read on the 28th, passed the date
 * test and came off their account — a receivable the gate bills on purpose and
 * so never absorbed, leaving nothing in its place and a hole in the report.
 *
 * A PAID bill is never touched: utility_bills refuses a void that still carries
 * a payment, and rightly — that money has moved, and handing it back is a
 * refund decision somebody makes, not something this module does quietly. The
 * count comes back to the caller to surface.
 */
/**
 * The day a bill's read span ENDS, dated the way the billing gate dates a stub
 * in flight: the closing read, or the LAST day of the cycle when the read
 * carries no date of its own (utilityBilling isoDay ?? lastDayOfCycle). Taking
 * the cycle's FIRST day here was the same drift as the allocation list pointing
 * the other way — the gate absorbs a dateless October stub for somebody who
 * left on the 18th and the void could not find that same bill, so the charge
 * stayed on the account of a resident whose power the landlord had already
 * agreed to eat, under a book row saying it had not.
 */
const BILL_SPAN_END_SQL =
  `COALESCE(ub.reading_end_date, (ub.billing_cycle_month + INTERVAL '1 month' - INTERVAL '1 day')::date)`

async function voidBilledFinalStubs(
  q: Q, landlordId: string, washId: string,
  d: { bookingId: string | null; leaseId: string | null }, departedOn: string,
): Promise<{ voided: number; absorbed: number; paidLeftAlone: number }> {
  // BOTH PAYERS, from the one departure key — never one column picked by which
  // id the caller happened to hold.
  //
  // utility_bills carries one payer or the other and never both
  // (utility_bills_payer_source_check), and tryInsertBill resolves the LEASE
  // first (lease_unit_history), falling through to a stay agreement only when no
  // lease covered the cycle. So a long stay on a lease — the shape that hands
  // this module both ids — always produces a LEASE-keyed bill whose
  // service_agreement_id is NULL. Reading `d.bookingId ? agreement : lease`
  // therefore searched, on exactly those departures, the one column that is null
  // on exactly those bills: the void found nothing, the landlord's book said
  // "called it a wash", and the resident still held the invoice, the debt and
  // the late fee.
  //
  // The lease is reached THROUGH the booking rather than taken from the caller,
  // because the caller does not always have it. The check-out window joins a
  // lease only while it is 'active' or 'pending' (earlyCheckOut loadStay), so
  // once the nightly lease-end processor has expired it, a redate or a corrected
  // answer re-records the wash with the booking alone (recordWashNobodyWasAsked)
  // — and the same resident would keep the same bill a day later.
  // leases.source_booking_id is the one link between a stay and its lease, the
  // same column the billing side pairs them through (utilityBilling
  // earlyDepartureForPayer).
  const payer = `(ub.lease_id IN (SELECT l.id FROM leases l
                                   WHERE l.landlord_id = $1 AND (l.id = $2 OR l.source_booking_id = $2))
                  OR ub.service_agreement_id IN (SELECT sa.id FROM utility_service_agreements sa
                                                  WHERE sa.booking_id = $2))`
  const note = 'Left early and kept no refund — called it a wash, so this final utility bills nobody.'
  const methods = [...WASH_COVERED_ALLOCATION_METHODS]
  const voided = (await q.query<any>(
    `UPDATE utility_bills ub
        SET status = 'void', voided_at = now(), void_reason = $4, updated_at = now(),
            notes = CASE WHEN COALESCE(ub.notes, '') = '' THEN $4 ELSE ub.notes || ' — ' || $4 END
      WHERE ub.landlord_id = $1 AND ${payer}
        AND ub.status IN ('unbilled', 'billed')
        AND ub.payment_id IS NULL
        AND ub.allocation_method = ANY($5::text[])
        AND ${BILL_SPAN_END_SQL} >= $3::date
      RETURNING ub.id, ub.meter_id, ub.unit_id, ub.utility_type, ub.tenant_id,
                to_char(ub.billing_cycle_month, 'YYYY-MM-DD') AS cycle_month,
                ub.charge_amount, ub.base_fee_share, ub.tax_amount, ub.tax_rate_pct,
                ub.usage_amount, ub.allocation_method, ub.allocation_basis,
                ub.rate_per_unit, ub.sewer_rate_per_unit, ub.reading_start, ub.reading_end,
                to_char(ub.reading_start_date, 'YYYY-MM-DD') AS reading_start_date,
                to_char(ub.reading_end_date, 'YYYY-MM-DD') AS reading_end_date`,
    [landlordId, d.bookingId ?? d.leaseId, departedOn, note, methods])).rows

  // Per meter, because the book holds one line per departure per meter and a
  // stub split across two cycles is that one line's two halves. Writing them
  // one at a time would let the second stand in for the first.
  const perMeter = new Map<string, any[]>()
  for (const b of voided) perMeter.set(b.meter_id, [...(perMeter.get(b.meter_id) ?? []), b])
  let absorbed = 0
  for (const [meterId, bills] of perMeter) {
    const sum = (f: string) => round2(bills.reduce((t, b) => t + num(b[f]), 0))
    const span = (f: string, pick: 'min' | 'max') => {
      const vals = bills.map(b => b[f]).filter(v => v != null)
      if (!vals.length) return null
      return vals.reduce((a, b) => (pick === 'min' ? (b < a ? b : a) : (b > a ? b : a)))
    }
    const first = bills[0]
    await writeAbsorbedCharge(q, {
      landlordId, meterId, unitId: first.unit_id, utilityType: first.utility_type,
      // The later cycle when a stub straddles two: that is where the closing
      // read landed, and where the recovery report's month filter looks.
      cycleMonth: span('cycle_month', 'max') as string,
      chargeAmount: sum('charge_amount'), baseFeeShare: sum('base_fee_share'),
      taxAmount: sum('tax_amount'), taxRatePct: nullNum(first.tax_rate_pct),
      usageAmount: bills.some(b => b.usage_amount != null) ? sum('usage_amount') : null,
      allocationMethod: first.allocation_method, allocationBasis: nullNum(first.allocation_basis),
      ratePerUnit: nullNum(first.rate_per_unit), sewerRatePerUnit: nullNum(first.sewer_rate_per_unit),
      readingStart: nullNum(span('reading_start', 'min')), readingEnd: nullNum(span('reading_end', 'max')),
      readingStartDate: span('reading_start_date', 'min') as string | null,
      readingEndDate: span('reading_end_date', 'max') as string | null,
      ref: d, tenantId: first.tenant_id,
      notes: 'Left early and kept no refund — this final utility was billed and then taken back off their account, so the landlord absorbed it.',
    }, washId, d, departedOn, 'add')
    absorbed++
  }

  const paid = (await q.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM utility_bills ub
      WHERE ub.landlord_id = $1 AND ${payer}
        AND (ub.status = 'paid' OR ub.payment_id IS NOT NULL)
        AND ub.allocation_method = ANY($4::text[])
        AND ${BILL_SPAN_END_SQL} >= $3::date`,
    [landlordId, d.bookingId ?? d.leaseId, departedOn, methods])).rows[0]
  return { voided: voided.length, absorbed, paidLeftAlone: Number(paid?.n ?? 0) }
}

/** Every stub still parked on an unanswered money question, for a to-do list. */
export async function openWashHolds(
  landlordId: string, ref?: DepartureRef, q: Q = poolQ,
): Promise<ParkedStub[]> {
  const key = ref ? normalizeDeparture(ref).key : null
  const rows = (await q.query<any>(
    `SELECT ${PARKED_COLS} FROM utility_wash_holds h
      WHERE h.landlord_id = $1 AND h.absorbed_at IS NULL AND h.released_at IS NULL
        AND ($2::uuid IS NULL OR COALESCE(h.booking_id, h.lease_id) = $2::uuid)
      ORDER BY h.departed_on, h.created_at`, [landlordId, key])).rows
  return rows.map(toParked)
}
