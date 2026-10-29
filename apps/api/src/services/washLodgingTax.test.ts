/**
 * 10/20 (Nic) — THE LODGING TAX GOES INTO THE WASH DIFFERENCE, EVEN THOUGH
 * NOBODY WAS CHARGED IT.
 *
 *   "Victor and Nemesio, it's $269 each at 2 weeks, but it's also plus the
 *    short-term lodging tax. That, like, even though they weren't charged the
 *    tax needs to be factored in as opposed to the difference calculation for
 *    the wash, [be]cause that's tax we would have to pay if we refunded the
 *    difference and relog it as a 2 week stay."
 *
 * THE LIVE CASE, read out of production and reproduced here row for row. RV 10
 * and RV 11 at Mountain View: booked 2026-10-04 through 2026-11-04 at the $589
 * month rate, paid in full, pulled out 2026-10-18 at 14 nights, and the desk
 * answered "No refund". The site is $49 / $269 / $589 and the property's
 * short-term tax rate is 6.60%. The check-out decision row carries
 * stayed_worth = 572.16 — $538 with the 6.35% stamped on the booking added on —
 * which is the shape this suite exists to get right:
 *
 *     paid                                            $589.00
 *     14 nights = 2 weeks at $269                     -$538.00
 *     the lodging tax re-pricing owes, at 6.60%        -$35.51
 *     -------------------------------------------------------
 *     really ahead                                      $15.49   per guest
 *                                                       $30.98   for both
 *
 * and NOT the naive $51.00 / $102.00, and not the $16.84 that falls out of
 * subtracting a decision row whose worth already carries a tax nobody paid.
 *
 * This suite calls the money side DIRECTLY, with the figures in hand. What the
 * CHECK-OUT WINDOW stamps on the row when a clerk presses "No refund" — the
 * path every real departure takes, and where the $16.84 actually got written —
 * is pinned in earlyCheckOutWash.test.ts ("a taxed park: what the till is up is
 * stamped before tax"), because a figure this suite gets right by being handed
 * it is not the same as one the production path gets right by itself.
 *
 * A 30+ night stay collects no short-term lodging tax; a two-week stay is
 * short-term and taxable. So re-pricing creates a liability that was never
 * collected, the landlord remits it out of his own pocket if he squares it up,
 * and counting it as money he kept would flatter him by $35.51 a departure — in
 * the one report whose whole purpose is "I want to make sure that it's somewhat
 * fair."
 *
 * Run (migrations 20261022090000+ are not on production yet):
 *   DB_NAME=gam_wash_tax_test TEST_DB_NAME=gam_wash_tax_test \
 *   TEST_APPLY_MIGRATIONS_AFTER=20261021220000 \
 *   npx vitest run src/services/washLodgingTax.test.ts
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { PoolClient } from 'pg'
import { getClient } from '../db'
import { cleanupAllSchema, seedLandlord, seedLease, seedProperty, seedUnit, seedUtilityMeter } from '../test/dbHelpers'
import {
  moneyKeptForDeparture, recordMoneyKeptOnDeparture, repricedStayTax,
  settleFinalStubForDeparture, washPairing,
} from './earlyDepartureWash'

const ARRIVED = '2026-10-04'
const LEFT = '2026-10-18'
const BOOKED_THROUGH = '2026-11-04'

type Park = {
  userId: string; landlordId: string; propertyId: string; unitId: string; meterId: string
}

/**
 * Mountain View, with its real figures on it. `taxRate` is the property's own
 * short-term rate; `rates` off makes a site with nothing to price with.
 */
async function park(client: PoolClient, o: { taxRate?: number; rates?: boolean } = {}): Promise<Park> {
  const { userId, landlordId } = await seedLandlord(client)
  const propertyId = await seedProperty(client, { landlordId, ownerUserId: userId, managedByUserId: userId })
  await client.query(
    `UPDATE properties SET name = 'Mountain View RV Ranch', timezone = 'America/Phoenix',
            short_term_tax_rate = $2 WHERE id = $1`,
    [propertyId, o.taxRate ?? 6.60])
  const unitId = await seedUnit(client, { propertyId, landlordId, unitType: 'rv_spot' })
  await client.query(
    o.rates === false
      ? `UPDATE units SET unit_number = 'RV 10' WHERE id = $1`
      : `UPDATE units SET unit_number = 'RV 10', nightly_rate = 49, weekly_rate = 269,
                monthly_rate = 589 WHERE id = $1`,
    [unitId])
  const meterId = await seedUtilityMeter(client, { propertyId, utilityType: 'electric', billingMethod: 'submeter' })
  await client.query(`INSERT INTO utility_meter_units (meter_id, unit_id) VALUES ($1, $2)`, [meterId, unitId])
  return { userId, landlordId, propertyId, unitId, meterId }
}

/** The reservation: a month at $589, paid, pulled out at 14 nights. */
async function stay(client: PoolClient, p: Park, o: {
  guest?: string; unitId?: string; leftOn?: string; bookedThrough?: string
  total?: number; stampedTaxRate?: number
} = {}): Promise<string> {
  return (await client.query<{ id: string }>(
    `INSERT INTO unit_bookings
       (unit_id, landlord_id, lease_type, status, check_in, check_out, booked_check_out,
        guest_name, total_amount, stay_tax_rate, balance_paid_at)
     VALUES ($1,$2,'month_to_month','checked_out',$3::date,$4::date,$5::date,$6,$7,$8,now())
     RETURNING id`,
    [o.unitId ?? p.unitId, p.landlordId, ARRIVED, o.leftOn ?? LEFT,
     o.bookedThrough ?? BOOKED_THROUGH, o.guest ?? 'Victor Cardoza',
     o.total ?? 589, o.stampedTaxRate ?? 0.0635])).rows[0].id
}

/**
 * The check-out decision exactly as production holds it: stayed_worth 572.16,
 * which is $538 of nights with the booking's own stamped 6.35% added in.
 */
async function answer(client: PoolClient, p: Park, bookingId: string, o: {
  stayedWorth?: number; paid?: number; refundTotal?: number; choice?: string; leftOn?: string
} = {}): Promise<string> {
  return (await client.query<{ id: string }>(
    `INSERT INTO stay_checkout_decisions
       (booking_id, landlord_id, left_on, question, choice, status,
        booked_price, stayed_worth, paid, refund_total, decided_at)
     VALUES ($1,$2,$3::date,'overpaid',$4,'decided',589,$5,$6,$7,now())
     RETURNING id`,
    [bookingId, p.landlordId, o.leftOn ?? LEFT, o.choice ?? 'no_refund',
     o.stayedWorth ?? 572.16, o.paid ?? 589, o.refundTotal ?? 0])).rows[0].id
}

/** The closing read nobody was billed for: 387 kWh at 21c. */
const stub = (p: Park, bookingId: string, over: Record<string, unknown> = {}) => ({
  landlordId: p.landlordId, meterId: p.meterId, unitId: p.unitId,
  utilityType: 'electric', cycleMonth: '2026-10-01',
  chargeAmount: 81.27, baseFeeShare: 0, taxAmount: 0, taxRatePct: 0,
  usageAmount: 387, allocationMethod: 'submeter', allocationBasis: null,
  ratePerUnit: 0.21, readingStart: 1000, readingEnd: 1387,
  readingStartDate: ARRIVED, readingEndDate: LEFT,
  ref: { bookingId }, ...over,
})

let client: PoolClient
beforeEach(async () => { await cleanupAllSchema(); client = await getClient() })
afterEach(() => { client?.release() })

describe('the lodging tax a re-priced stay would owe (10/20)', () => {
  it('RV 10: $589 paid, 14 nights worth $538, $35.51 of tax — $15.49 really kept', async () => {
    const p = await park(client)
    const bookingId = await stay(client, p)
    await answer(client, p, bookingId)

    const kept = await moneyKeptForDeparture({ bookingId }, p.landlordId, client)
    // The till is up $51: what they paid above the PRE-TAX worth of the nights
    // they used. The decision row's own $572.16 is not used for this, because
    // the tax inside it was never charged on a 31-night booking.
    expect(kept!.amountKept).toBe(51)
    expect(kept!.lodgingTaxOwed).toBe(35.51)
    // Nic's figure, to the cent.
    expect(kept!.amountKeptNet).toBe(15.49)
    expect(kept!.departedOn).toBe(LEFT)
    expect(kept!.paidThrough).toBe(BOOKED_THROUGH)
  })

  it('the stamped rate on the booking is NOT the rate — the property\'s current one is', async () => {
    // The booking carries 6.35% from the day it was quoted. Nothing was ever
    // collected or remitted on it (a 31-night stay is not short-term), so there
    // is no history to reprice — the liability is what a stay re-logged TODAY
    // would owe, and that is the property's rate now.
    const p = await park(client, { taxRate: 6.60 })
    const bookingId = await stay(client, p, { stampedTaxRate: 0.0635 })
    await answer(client, p, bookingId)
    const kept = await moneyKeptForDeparture({ bookingId }, p.landlordId, client)
    expect(kept!.lodgingTaxOwed).toBe(35.51)         // 538.00 x 6.60%
    expect(kept!.lodgingTaxOwed).not.toBe(34.16)     // 538.00 x 6.35%, the stamped one
  })

  it('a property with no short-term tax rate is untouched — kept is kept', async () => {
    const p = await park(client, { taxRate: 0 })
    const bookingId = await stay(client, p)
    await answer(client, p, bookingId, { stayedWorth: 538 })
    const kept = await moneyKeptForDeparture({ bookingId }, p.landlordId, client)
    expect(kept!.amountKept).toBe(51)
    expect(kept!.lodgingTaxOwed).toBe(0)
    expect(kept!.amountKeptNet).toBe(51)
  })

  it('a departure still 30+ nights after re-pricing owes nothing — the shared pricer knows the cliff', async () => {
    // In 2026-10-04, booked through 2026-12-04, gone on 2026-11-20: 47 nights
    // stayed. Still long-term, so re-pricing it carries no lodging tax at all,
    // and the rule is not written a second time here to say so.
    const p = await park(client)
    const bookingId = await stay(client, p, {
      leftOn: '2026-11-20', bookedThrough: '2026-12-04', total: 1300 })
    await answer(client, p, bookingId, { paid: 1300, stayedWorth: 1000, leftOn: '2026-11-20' })
    const kept = await moneyKeptForDeparture({ bookingId }, p.landlordId, client)
    expect(kept!.lodgingTaxOwed).toBe(0)
    expect(kept!.amountKeptNet).toBe(kept!.amountKept)
  })

  it('a refund of any size means nothing is kept, so no tax is claimed either', async () => {
    // Nic's own rule: "Any refund, even partial, means no wash." A $51 refund
    // empties the difference, and a tax on a re-log nobody is going to do would
    // make the figure read as a LOSS.
    const p = await park(client)
    const bookingId = await stay(client, p)
    await answer(client, p, bookingId, { choice: 'refund_unused', refundTotal: 51 })
    const kept = await moneyKeptForDeparture({ bookingId }, p.landlordId, client)
    expect(kept!.amountKept).toBe(0)
    expect(kept!.lodgingTaxOwed).toBe(0)
    expect(kept!.amountKeptNet).toBe(0)
    expect(kept!.refundGiven).toBe(true)
  })

  it('a site with no rates on file claims nothing — the record is used and no tax invented', async () => {
    // Nothing to price the nights with, so the check-out record's own worth is
    // all there is and no tax is asserted on top of a figure nobody can check.
    const p = await park(client, { rates: false })
    const bookingId = await stay(client, p)
    await answer(client, p, bookingId, { stayedWorth: 538 })
    const kept = await moneyKeptForDeparture({ bookingId }, p.landlordId, client)
    expect(kept!.amountKept).toBe(51)
    expect(kept!.lodgingTaxOwed).toBe(0)
    expect(repricedStayTax({ rst_check_in: null, rst_tax_pct: 6.6 }, LEFT).pretaxWorth).toBeNull()
  })

  it('a property that never gives money back reaches the same figure with no decision row', async () => {
    const p = await park(client)
    await client.query(
      `UPDATE properties SET early_departure_refunds = false WHERE id = $1`, [p.propertyId])
    const bookingId = await stay(client, p, { guest: 'Nemesio Rivera' })
    const kept = await moneyKeptForDeparture({ bookingId }, p.landlordId, client)
    expect(kept!.amountKept).toBe(51)
    expect(kept!.lodgingTaxOwed).toBe(35.51)
    expect(kept!.amountKeptNet).toBe(15.49)
  })
})

describe('the money kept on the report (10/20)', () => {
  it('both live departures: $51 in the till each, $30.98 really ahead, against the power', async () => {
    const p = await park(client)
    const second = await seedUnit(client, { propertyId: p.propertyId, landlordId: p.landlordId, unitType: 'rv_spot' })
    await client.query(
      `UPDATE units SET unit_number = 'RV 11', nightly_rate = 49, weekly_rate = 269,
              monthly_rate = 589 WHERE id = $1`, [second])

    for (const [guest, unitId] of [['Victor Cardoza', p.unitId], ['Nemesio Rivera', second]] as const) {
      const bookingId = await stay(client, p, { guest, unitId })
      const decisionId = await answer(client, p, bookingId)
      const rec = await recordMoneyKeptOnDeparture({
        landlordId: p.landlordId, ref: { bookingId },
        propertyId: p.propertyId, unitId, checkoutDecisionId: decisionId, client,
      })
      expect(rec.isWash).toBe(true)
      // What is STAMPED is the cash difference. The tax is a liability, not a
      // stamp, so it is priced when the report is read.
      expect(rec.amountKept).toBe(51)
      await settleFinalStubForDeparture({ ...stub(p, bookingId, { unitId }), client })
    }

    const pairs = await washPairing(p.landlordId, {}, client)
    expect(pairs).toHaveLength(2)
    for (const d of pairs) {
      expect(d.moneyKeptBeforeTax).toBe(51)
      expect(d.lodgingTaxOwed).toBe(35.51)
      expect(d.moneyKept).toBe(15.49)
      expect(d.utilityAbsorbed).toBe(81.27)
      // $15.49 against $81.27 of power: the park is $65.78 SHORT on this one,
      // where the naive $51 would have read as only $30.27 short. The figure
      // leaning harder against the landlord is the point — he asked whether it
      // is fair, not to be reassured.
      expect(d.evenedOutBy).toBe(-65.78)
    }
    expect(Math.round(pairs.reduce((n, d) => n + d.moneyKept, 0) * 100) / 100).toBe(30.98)
  })

  it('a wash with no stay behind it owes no lodging tax — a lease is not a short stay', async () => {
    // washPairing is read for whatever is on the book; a row that names a LEASE
    // and no booking must not have a stay's tax priced onto it. Rent for an
    // agreed time is not short-term lodging and re-pricing it owes nothing.
    // recordMoneyKeptOnDeparture refuses a lease outright, so this is the belt
    // to that braces.
    const p = await park(client)
    const leaseId = await seedLease(client, {
      unitId: p.unitId, landlordId: p.landlordId, status: 'expired', startDate: '2026-04-01' })
    const { rows: [w] } = await client.query<any>(
      `INSERT INTO early_departure_washes
         (landlord_id, property_id, unit_id, lease_id, departed_on, paid_through, amount_kept)
       VALUES ($1,$2,$3,$4,'2026-10-18','2026-11-04',420) RETURNING id`,
      [p.landlordId, p.propertyId, p.unitId, leaseId])
    const [pair] = await washPairing(p.landlordId, {}, client)
    expect(pair.washId).toBe(w.id)
    expect(pair.moneyKeptBeforeTax).toBe(420)
    expect(pair.lodgingTaxOwed).toBe(0)
    expect(pair.moneyKept).toBe(420)
  })
})
