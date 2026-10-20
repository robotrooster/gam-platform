/**
 * 10/20 (Nic) — WHAT A CONFIRMATION TELLS A GUEST THEY OWE.
 *
 *   "I'd like it to tell them a grand total if it's a short-term stay, like
 *    less than a month or whatever. If they're seasonal and going to be here
 *    more than the 30 days, I just want it to tell them the first month's rate.
 *    I also want it to tell them a deposit of 10% or whatever that property's
 *    deposit rate is."
 *
 * The arithmetic on its own: the two figures, the deposit off each of them, and
 * the one rule that would hurt a guest most if it slipped — a six-month guest
 * reading one month's rate as the price of the whole season.
 *
 * Rates throughout are Nic's own: $49 a night, $269 a week, $589 a month, and
 * Mountain View's 6.60% short-term lodging tax.
 */
import { describe, it, expect } from 'vitest'
import { confirmationFigures, confirmationPaid } from './bookingConfirmation'

const RATES = { nightly: 49, weekly: 269, monthly: 589 }

const figures = (o: Partial<Parameters<typeof confirmationFigures>[0]> = {}) => confirmationFigures({
  checkIn: '2027-03-06',
  checkOut: '2027-03-13',
  bookedTotal: null,
  rates: RATES,
  taxRatePct: 6.6,
  property: { booking_deposit_pct: 10, booking_monthly_deposit: null },
  ...o,
})

describe('a short stay is told its grand total', () => {
  it('quotes the whole stay, lodging tax in, and names the tax', () => {
    // Six or seven nights are charged as a week — the cheapest combination
    // (@gam/shared priceStay). $269 + 6.60% = $286.75.
    const f = figures()
    expect(f.nights).toBe(7)
    expect(f.firstMonthOnly).toBe(false)
    expect(f.amount).toBe(286.75)
    expect(f.tax).toBe(17.75)
    expect(f.heldThrough).toBeNull()
  })

  it('is Nic\'s own example on a park with no lodging tax', () => {
    // "somebody wants to say, stay a week at the 269 rate, we send them a
    // deposit of 10%. They pay their $26, $27" — $26.90.
    const f = figures({ taxRatePct: 0 })
    expect(f.amount).toBe(269)
    expect(f.tax).toBeNull()
    expect(f.deposit).toBe(26.9)
  })

  it('reads the deposit rate off the property, whatever it is set to', () => {
    expect(figures({ property: { booking_deposit_pct: 5, booking_monthly_deposit: null } }).deposit).toBe(14.34)
    expect(figures({ property: { booking_deposit_pct: 10, booking_monthly_deposit: null } }).deposit).toBe(28.68)
    expect(figures({ property: { booking_deposit_pct: 15, booking_monthly_deposit: null } }).deposit).toBe(43.01)
    expect(figures({ property: { booking_deposit_pct: 20, booking_monthly_deposit: null } }).deposit).toBe(57.35)
  })

  it('asks no deposit at all where the property asks none', () => {
    // The percentage column only holds 5 / 10 / 15 / 20 (properties
    // _booking_deposit_pct_steps), so "no deposit" is a park that has set its
    // flat long-stay deposit to zero — pinned on the stay it governs.
    expect(figures({
      checkOut: '2027-06-06',
      property: { booking_deposit_pct: 20, booking_monthly_deposit: 0 },
    }).deposit).toBe(0)
  })

  it('quotes the price the reservation was SOLD at, not today\'s rate card', () => {
    // A site with no rate on it anywhere, taken at a price the clerk typed: the
    // reservation's own total is the only price it has, and the tax is NOT
    // broken out — we quote the figure, we do not invent a split for it.
    const hand = figures({ rates: { nightly: null, weekly: null, monthly: null }, bookedTotal: 310 })
    expect(hand.amount).toBe(310)
    expect(hand.tax).toBeNull()
    expect(hand.deposit).toBe(31)
    // And a stay sold at a figure the rate card no longer agrees with still
    // quotes what was sold — one stay, one price, the arrival ticket's.
    const repriced = figures({ bookedTotal: 250 })
    expect(repriced.amount).toBe(250)
    expect(repriced.tax).toBeNull()
  })
})

describe('a stay of 30 nights or more is told its FIRST MONTH', () => {
  it('quotes one month, never the whole season', () => {
    // March 6 to June 6: three months on the ground. The guest is told $589,
    // and the email says it is the first month — not $589 for the lot and not
    // $1,767 in one go.
    const f = figures({ checkOut: '2027-06-06' })
    expect(f.nights).toBe(92)
    expect(f.firstMonthOnly).toBe(true)
    expect(f.amount).toBe(589)
    expect(f.firstMonthThrough).toBe('2027-04-06')
  })

  it('carries no lodging tax, because a 30+ night stay never does', () => {
    const f = figures({ checkOut: '2027-06-06' })
    expect(f.tax).toBeNull()
    // Nor does a park with a 0% rate change anything about it.
    expect(figures({ checkOut: '2027-06-06', taxRatePct: 0 }).amount).toBe(589)
  })

  it('never cuts the first month short of the stay they asked for', () => {
    // Exactly 30 nights: the month window would run past the check-out, so the
    // first month stops at the check-out.
    const f = figures({ checkOut: '2027-04-05' })
    expect(f.nights).toBe(30)
    expect(f.firstMonthOnly).toBe(true)
    expect(f.firstMonthThrough).toBe('2027-04-05')
  })

  it('owes the property\'s FLAT monthly deposit, capped at one month', () => {
    // S547 / migration 20260718184500: the percentage is for short stays; a
    // 30+ stay owes a flat amount and "at most one month". 20% of a season
    // would be a deposit nobody would pay.
    const long = { checkOut: '2027-06-06' as const }
    expect(figures({ ...long, property: { booking_deposit_pct: 20, booking_monthly_deposit: 300 } }).deposit).toBe(300)
    // No flat amount set: the platform default, not the percentage.
    expect(figures({ ...long, property: { booking_deposit_pct: 20, booking_monthly_deposit: null } }).deposit).toBe(150)
    // More than a month set: held to one month's rent.
    expect(figures({ ...long, property: { booking_deposit_pct: 20, booking_monthly_deposit: 900 } }).deposit).toBe(589)
  })

  it('tells a guest who chose a stay how long the site is held', () => {
    expect(figures({ checkOut: '2027-06-06', stayTerms: 'stay' }).heldThrough)
      .toMatch(/held through June 6, 2027/)
    // A guest who chose a lease is held for as long as they stay, so the
    // held-through sentence would be a lie.
    expect(figures({ checkOut: '2027-06-06', stayTerms: 'lease' }).heldThrough).toBeNull()
    // And one nobody ever asked (an import, a soft hold) is not told about a
    // choice it was never offered — the same test linkHeldWords applies.
    expect(figures({ checkOut: '2027-06-06', stayTerms: null }).heldThrough).toBeNull()
  })
})

/**
 * 10/20 (defect) — WHAT MONEY IS ALREADY IN, AND THEREFORE WHAT THE EMAIL MAY
 * CLAIM.
 *
 * A guest who had paid his whole $286.75 was told that a deposit of $28.68 —
 * the property's 10%, which nobody had ever charged him — was paid, and that
 * "the balance is due when you arrive". Both halves came from the same root:
 * the email had no single answer to "what has this reservation been paid", so
 * the deposit paragraph guessed with the property's percentage and the price
 * paragraph assumed nothing was in. This is that one answer, on its own.
 */
describe('what the reservation has been paid', () => {
  const paid = (o: Partial<Parameters<typeof confirmationPaid>[0]> = {}) => confirmationPaid({
    status: 'confirmed',
    guestEmail: 'dale@t.dev',
    depositPaidAt: null,
    balancePaidAt: null,
    posTransactionId: null,
    paidToward: null,
    total: 286.75,
    ...o,
  })

  it('is nothing at all when nobody has paid anything', () => {
    expect(paid()).toBeNull()
  })

  it('is the WHOLE STAY when the balance is stamped paid', () => {
    // The case that bit: a pay link or a register sale stamped the balance and
    // left no separate deposit amount behind it. $286.75 is in and nothing is
    // owed on arrival — and 10% of the stay is not a figure in this story.
    expect(paid({ balancePaidAt: new Date(), paidToward: 286.75 }))
      .toEqual({ kind: 'stay', amount: 286.75 })
  })

  it('is the whole stay for a deposit paid with no amount recorded', () => {
    // GAM's standing convention for that row (services/registerStay
    // reservationDue: "with no amount on record, the whole stay").
    expect(paid({ depositPaidAt: new Date(), paidToward: 286.75 }))
      .toEqual({ kind: 'stay', amount: 286.75 })
  })

  it('is a DEPOSIT while part of the price is still outstanding', () => {
    expect(paid({ depositPaidAt: new Date(), paidToward: 28.68 }))
      .toEqual({ kind: 'deposit', amount: 28.68 })
    expect(paid({ depositPaidAt: new Date(), paidToward: 100 }))
      .toEqual({ kind: 'deposit', amount: 100 })
  })

  it('counts a payment to the last cent, not to the dollar', () => {
    // A cent short is still a balance. A cent over is paid.
    expect(paid({ depositPaidAt: new Date(), paidToward: 286.74 })!.kind).toBe('deposit')
    expect(paid({ depositPaidAt: new Date(), paidToward: 286.76 })!.kind).toBe('stay')
  })

  it('names no figure rather than invent one', () => {
    // A register sale against the reservation and nothing on the row saying
    // how much of it was the stay. Money is in; what it was is not ours to
    // guess, so the amount is null and the email says the true half only.
    expect(paid({ posTransactionId: 'sale-1' })).toEqual({ kind: 'deposit', amount: null })
    // And a reservation with no price on it at all, stamped paid: in full,
    // with no figure to quote.
    expect(paid({ balancePaidAt: new Date(), total: null, paidToward: null }))
      .toEqual({ kind: 'stay', amount: null })
  })

  it('is nothing once the reservation has stopped holding its dates', () => {
    // Checked in, checked out, canceled, a no-show: the whole question is over
    // and the confirmation is refused upstream anyway.
    for (const status of ['checked_in', 'checked_out', 'cancelled', 'no_show'] as const) {
      expect(paid({ status, balancePaidAt: new Date(), paidToward: 286.75 }), status).toBeNull()
    }
  })
})

describe('a seasonal stay that was sold at a price of its own', () => {
  // 10/20 (review) — THE RATE CARD IS NOT ALWAYS THIS RESERVATION'S PRICE.
  //
  // The 30+ branch cut its first month straight out of the rate card without
  // ever asking whether the rate card priced THIS stay. Nic's board is full of
  // reservations it did not price: totals a clerk typed on a site with no rate
  // on it, and figures imported straight across out of the old system. A month
  // carved out of somebody else's price belongs to a different stay.
  //
  // March 6 to June 6 throughout — 92 nights, sold for $1,767 (three months at
  // Nic's $589).
  const SEASON = { checkIn: '2027-03-06', checkOut: '2027-06-06' }
  const NO_RATES = { nightly: null, weekly: null, monthly: null }

  it('does not quote a seasonal guest $0.00 and then ask for no deposit', () => {
    // The worst version of this email, and the one that was going out: a site
    // with no rate on it anywhere, taken at a typed total. The rate card priced
    // the first month at nothing, so the guest read "Your first month is
    // $0.00" with no deposit paragraph and no card page behind it at all.
    const f = figures({ ...SEASON, rates: NO_RATES, bookedTotal: 1767 })
    expect(f.nights).toBe(92)
    expect(f.amount).toBe(1767)
    // Nothing priced a month, so the email does not pretend to name one. It
    // quotes the stay at the price it was sold for — which is also exactly what
    // the arrival ticket bills (services/stayBalance: the total less the
    // deposit, on the day they turn up).
    expect(f.firstMonthOnly).toBe(false)
    expect(f.firstMonthThrough).toBeNull()
    expect(f.tax).toBeNull()
    // And the park's flat long-stay deposit is asked for, instead of nothing.
    expect(f.deposit).toBe(150)
  })

  it('never carves a month out of a rate card that did not price this stay', () => {
    // An imported row: $1,767 for the season, at a park whose sites carry a
    // nightly rate and no monthly one. The card prices the first 31 nights at
    // $1,519 — 86% of what the whole season was sold for — and takes 10% of
    // that as the deposit.
    const f = figures({ ...SEASON, rates: { nightly: 49, weekly: null, monthly: null }, bookedTotal: 1767 })
    expect(f.amount).toBe(1767)
    expect(f.firstMonthOnly).toBe(false)
    expect(f.deposit).toBe(150)
  })

  it('owes the flat long-stay deposit with no monthly rate on the site', () => {
    // The flat rule is the stay's LENGTH, never the rate it happens to be
    // charged at (propertyBooking depositForStay, 10/6) — so a site with no
    // monthly rate must not fall through to the short-stay percentage.
    const f = figures({
      ...SEASON, rates: { nightly: 49, weekly: 269, monthly: null }, bookedTotal: 1767,
      property: { booking_deposit_pct: 20, booking_monthly_deposit: 300 },
    })
    expect(f.deposit).toBe(300)
    // And the platform default where the park has set no flat amount.
    expect(figures({ ...SEASON, rates: NO_RATES, bookedTotal: 1767 }).deposit).toBe(150)
  })

  it('still quotes the first month when the rate card IS this stay\'s price', () => {
    // The ordinary seasonal, and the one Nic's sentence is about: the counter
    // priced it off the card ($589 a month, three months, $1,767), so the card
    // is allowed to carve its own month out of it — "I just want it to tell
    // them the first month's rate."
    const f = figures({ ...SEASON, bookedTotal: 1767 })
    expect(f.firstMonthOnly).toBe(true)
    expect(f.amount).toBe(589)
    expect(f.firstMonthThrough).toBe('2027-04-06')
    expect(f.deposit).toBe(150)
  })

  it('honors the sold price when the first month IS the whole reservation', () => {
    // How the booking site stores a 30+ stay with no lease: the row ends where
    // the first month ends, so the price it was sold at IS the first month's.
    const f = figures({ checkIn: '2027-03-06', checkOut: '2027-04-06', bookedTotal: 589 })
    expect(f.nights).toBe(31)
    expect(f.firstMonthOnly).toBe(true)
    expect(f.amount).toBe(589)
  })

  it('still tells an imported seasonal how long their site is held', () => {
    // The held-through sentence belongs to the stay's LENGTH, not to which of
    // the two figures we ended up quoting.
    const f = figures({ ...SEASON, rates: NO_RATES, bookedTotal: 1767, stayTerms: 'stay' })
    expect(f.firstMonthOnly).toBe(false)
    expect(f.heldThrough).toMatch(/held through June 6, 2027/)
  })
})
