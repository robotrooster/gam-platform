/**
 * 10/20 — A LONG STAY'S WASH IS RENT PAID AHEAD, NOT A RE-PRICED STAY.
 *
 * The wash row holds what the till is up BEFORE the lodging tax, because the
 * report prices that tax when it READS the row (washPairing). For a plain stay
 * that means taking the desk's tax-in worth back out: $589 paid, 14 nights
 * worth $538 before tax, $51 stamped — the RV 10 shape, covered in
 * earlyCheckOutWash.test.ts.
 *
 * A LONG STAY IS A DIFFERENT SHAPE OF MONEY. Checking one out ends its lease on
 * the day they left, and the money then in question is the RENT already paid
 * past that day, banked as money paid ahead (#38 Q8). So the check-out window
 * writes its decision row with `stayed_worth` 0 ON PURPOSE: there is no stay
 * price to net off, and rent carries no short-term lodging tax at all. Nic, on
 * why the two are not the same: "A lease is an agreed upon amount. They're
 * responsible for that time. Stays are just kind of a verbal, like, hey, we're
 * here."
 *
 * Re-pricing the nights anyway takes the two weeks they DID stay off the rent
 * they had paid ahead, and then takes a lodging tax off what is left — a tax on
 * rent. $1,178.00 of paid-ahead rent reads $640.00, and a departure with less
 * than $538.00 behind it reads $0.00 and gets no wash row at all, while the
 * power is still washed: absorbed by GAM and invisible in the one report the
 * whole feature exists to produce.
 *
 * Run (nothing here needs a migration that is not in schema.sql):
 *   DB_NAME=gam_leasewash_test TEST_DB_NAME=gam_leasewash_test \
 *   npx vitest run src/services/washLeaseBackedStay.test.ts
 */
import { randomUUID } from 'crypto'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { PoolClient } from 'pg'
import { db, query, getClient } from '../db'
import {
  cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedTenant, seedLease,
  seedLeaseTenant, seedUtilityMeter,
} from '../test/dbHelpers'
import { decideEarlyCheckOut, quoteEarlyCheckOut, poolQ } from './earlyCheckOut'
import {
  moneyKeptForDeparture, settleFinalStubForDeparture, washPairing, washVerdict,
} from './earlyDepartureWash'

// Phoenix, mid-afternoon on the day they drove away.
const NOW = new Date('2026-10-18T20:00:00Z')
const LEFT = '2026-10-18'
const ARRIVED = '2026-10-04'
/** Three months booked: the long stay that gets a lease. */
const BOOKED_THROUGH = '2027-01-04'

/** The note bookingLeaseBilling writes on rent paid past a shortened end. */
const SHORTENED_NOTE = 'Stay shortened — rent already paid past the new end'

beforeEach(async () => {
  await cleanupAllSchema()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
})
afterEach(() => { vi.useRealTimers() })

interface Park {
  userId: string; landlordId: string; propertyId: string; unitId: string
  tenantId: string; meterId: string
}

/**
 * Mountain View's shape, with the park's real short-term rate on it (6.60%) —
 * the one value that decides whether a lodging tax can be wrongly claimed here
 * at all, and the value the live property carries.
 */
async function park(): Promise<Park> {
  const c = await getClient()
  try {
    await c.query('BEGIN')
    const { userId, landlordId } = await seedLandlord(c)
    const propertyId = await seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: userId })
    await c.query(
      `UPDATE properties SET name = 'Mountain View RV Ranch', timezone = 'America/Phoenix',
              timezone_source = 'manual', short_term_tax_rate = 6.6,
              early_departure_refunds = TRUE WHERE id = $1`, [propertyId])
    const unitId = await seedUnit(c, { propertyId, landlordId, unitType: 'rv_spot' })
    await c.query(
      `UPDATE units SET unit_number = 'RV 10', is_bookable = TRUE,
              nightly_rate = 49, weekly_rate = 269, monthly_rate = 589 WHERE id = $1`, [unitId])
    const tenantId = await seedTenant(c)
    const meterId = await seedUtilityMeter(c, { propertyId, utilityType: 'electric', billingMethod: 'submeter' })
    await c.query(`INSERT INTO utility_meter_units (meter_id, unit_id) VALUES ($1, $2)`, [meterId, unitId])
    await c.query('COMMIT')
    return { userId, landlordId, propertyId, unitId, tenantId, meterId }
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e } finally { c.release() }
}

/**
 * The long stay and the lease behind it — three months at $589, still checked
 * in, with the lease the schedule made for it (`source_booking_id`, which is
 * what makes this a lease-backed departure everywhere downstream).
 */
async function longStay(p: Park): Promise<{ bookingId: string; leaseId: string }> {
  const bookingId = (await query<{ id: string }>(
    `INSERT INTO unit_bookings
       (landlord_id, unit_id, guest_name, lease_type, check_in, check_out, nights,
        total_amount, platform_fee, status, source, booked_check_out, stay_tax_rate)
     VALUES ($1,$2,'Hector Salas','month_to_month',$3::date,$4::date,($4::date - $3::date),
             1767,0,'checked_in','direct',$4::date,0.0635)
     RETURNING id`, [p.landlordId, p.unitId, ARRIVED, BOOKED_THROUGH]))[0].id
  const c = await getClient()
  let leaseId: string
  try {
    await c.query('BEGIN')
    leaseId = await seedLease(c, {
      unitId: p.unitId, landlordId: p.landlordId, rentAmount: 589,
      leaseType: 'month_to_month', status: 'active', startDate: ARRIVED,
    })
    await c.query(
      `UPDATE leases SET source_booking_id = $2, end_date = $3::date WHERE id = $1`,
      [leaseId, bookingId, BOOKED_THROUGH])
    await seedLeaseTenant(c, { leaseId, tenantId: p.tenantId })
    await c.query('COMMIT')
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e } finally { c.release() }
  return { bookingId, leaseId }
}

/**
 * The rent paid past the day the lease ended, as money paid ahead — the
 * 'reclassified' credit the lease sync banks, which is the ONLY place a long
 * stay's paid-ahead money lives (earlyCheckOut leasePaidAhead reads exactly
 * this). Supplied here the way a fixture supplies a payment: the sync has no
 * rent charges to reclassify in a bare fixture, and the figure under test is
 * what the check-out does with the credit, not how it got banked.
 */
async function paidAhead(p: Park, leaseId: string, amount: number): Promise<void> {
  await query(
    `INSERT INTO lease_prepaid_credits
       (lease_id, tenant_id, amount_original, amount_remaining, funded_by, note, received_at)
     VALUES ($1, $2, $3, $3, 'reclassified', $4, NOW())`,
    [leaseId, p.tenantId, amount.toFixed(2), SHORTENED_NOTE])
}

/** One press of the Check out window. */
async function press(p: Park, bookingId: string, choice: string | null, o: { leftOn?: string | null } = {}) {
  const q = await quoteEarlyCheckOut(poolQ, bookingId, {
    leftOn: o.leftOn ?? null, canRefund: true, canCheckOut: true })
  return {
    quote: q,
    result: await decideEarlyCheckOut({
      bookingId,
      actor: { userId: p.userId, canCheckOut: true, canRefund: true },
      leftOn: o.leftOn ?? null,
      choice: choice as any,
      refundAmount: null,
      quoteToken: q.quoteToken,
      idempotencyKey: randomUUID(),
    }),
  }
}

/**
 * Check the long stay out (which ends its lease), bank the rent that was paid
 * past that day, then answer "No refund" — the two presses the desk really
 * makes, because a long stay's paid-ahead money does not exist until the lease
 * sync has banked it.
 */
async function leftEarlyAndKeptIt(p: Park, amount: number): Promise<{ bookingId: string; leaseId: string }> {
  const { bookingId, leaseId } = await longStay(p)
  await press(p, bookingId, null, { leftOn: LEFT })
  await paidAhead(p, leaseId, amount)
  const { quote } = await press(p, bookingId, 'no_refund')
  // The premise, pinned: this is the paid-ahead rent question, and the window
  // puts no stay price against it.
  expect(quote.question).toBe('overpaid')
  expect(quote.unused).toBe(amount)
  expect(quote.stayed.worth).toBe(0)
  expect(quote.early).toBe(true)
  return { bookingId, leaseId }
}

const washes = async (landlordId: string) => (await db.query<any>(
  `SELECT amount_kept::float AS kept, refund_given, lease_id IS NOT NULL AS leased,
          to_char(departed_on, 'YYYY-MM-DD') AS departed_on,
          to_char(paid_through, 'YYYY-MM-DD') AS paid_through
     FROM early_departure_washes WHERE landlord_id = $1 ORDER BY created_at`, [landlordId])).rows

/** The final stub the closing read produced: 387 kWh at 21¢, $81.27. */
const stub = (p: Park, ref: { bookingId?: string; leaseId?: string }) => ({
  landlordId: p.landlordId, meterId: p.meterId, unitId: p.unitId,
  utilityType: 'electric', cycleMonth: '2026-10-01',
  chargeAmount: 81.27, baseFeeShare: 0, taxAmount: 0, taxRatePct: 0,
  usageAmount: 387, allocationMethod: 'submeter', allocationBasis: null,
  ratePerUnit: 0.21, readingStart: 1000, readingEnd: 1387,
  readingStartDate: '2026-10-01', readingEndDate: '2026-10-18',
  ref,
})

describe('a long stay: the wash is the rent paid ahead, whole and untaxed', () => {
  it('$1,178.00 of paid-ahead rent is $1,178.00 kept — the nights they stayed are not priced against it', async () => {
    const p = await park()
    const { bookingId } = await leftEarlyAndKeptIt(p, 1178)

    expect(await washes(p.landlordId)).toMatchObject([{
      kept: 1178, refund_given: false, leased: true,
      departed_on: LEFT, paid_through: BOOKED_THROUGH,
    }])

    // And the reader agrees, with NO lodging tax claimed: rent is not a
    // short-term stay, so re-logging it owes the state nothing.
    expect(await moneyKeptForDeparture({ bookingId }, p.landlordId)).toMatchObject({
      amountKept: 1178, lodgingTaxOwed: 0, amountKeptNet: 1178,
    })

    // The landlord's card: the whole $1,178.00, never $1,178.00 less two weeks
    // of stay and then a lodging tax on the remainder.
    expect(await washPairing(p.landlordId)).toMatchObject([{
      unitNumber: 'RV 10',
      moneyKeptBeforeTax: 1178, lodgingTaxOwed: 0, moneyKept: 1178,
      utilityAbsorbed: 0, evenedOutBy: 1178,
    }])
  })

  it('and when the closing read lands it is absorbed and measured against the whole figure', async () => {
    const p = await park()
    const { bookingId } = await leftEarlyAndKeptIt(p, 1178)
    expect((await settleFinalStubForDeparture(stub(p, { bookingId }))).outcome).toBe('absorbed')

    expect(await washPairing(p.landlordId)).toMatchObject([{
      moneyKept: 1178, utilityAbsorbed: 81.27, closingReadsIn: true, evenedOutBy: 1096.73,
    }])
  })

  /**
   * The one that loses a departure outright. Rent paid ahead of less than the
   * nights they stayed are worth comes to nothing once those nights are priced
   * against it — so no wash row is written at all, while the verdict still says
   * wash and the power is absorbed. The money kept and the power eaten are both
   * off the report, which is the only number this feature exists to produce.
   */
  it('a departure with less paid ahead than the nights are worth still gets its row', async () => {
    const p = await park()
    const { bookingId } = await leftEarlyAndKeptIt(p, 400)

    expect(await washes(p.landlordId)).toMatchObject([{ kept: 400, leased: true }])
    const verdict = await washVerdict({ bookingId }, p.landlordId)
    expect(verdict.verdict).toBe('wash')
    expect(verdict.amountKept).toBe(400)
    expect(verdict.washId).not.toBeNull()

    expect(await washPairing(p.landlordId)).toMatchObject([{
      moneyKeptBeforeTax: 400, lodgingTaxOwed: 0, moneyKept: 400,
    }])
  })
})
