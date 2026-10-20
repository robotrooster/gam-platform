/**
 * 10/20 (Nic) — CALL IT A WASH.
 *
 *   "I would like to keep track of money that wasn't refunded versus electric
 *    that should have been billed that wasn't charged to see how close we
 *    actually get to evening out."
 *
 * The shapes these hold the rule to are the two live departures that prompted
 * it: RV 10 and RV 11 at Mountain View, both paid $589 for a month, both pulled
 * out at 14 nights, neither refunded. Two guests leaving one site in one month
 * is a routine season week, and the old owner-use key could only hold one of
 * them — so "two departures on one site in one month" is the test that matters
 * most here.
 *
 * Run (migration 20261021210000 is not on production yet):
 *   DB_NAME=gam_wash_test TEST_DB_NAME=gam_wash_test \
 *   TEST_APPLY_MIGRATIONS_AFTER=20261021170000 \
 *   npx vitest run src/services/earlyDepartureWash.test.ts
 */
import { randomUUID } from 'crypto'
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import type { PoolClient } from 'pg'
import { db, getClient } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedTenant, seedUtilityMeter, seedLease } from '../test/dbHelpers'
import {
  ABSORBED_CHARGE_REASONS, ABSORBED_CHARGE_REASON_LABEL,
  WASH_UNWIND_REASONS, WASH_UNWIND_REASON_LABEL,
  moneyKeptForDeparture, normalizeDeparture, openWashHolds,
  recordMoneyKeptOnDeparture, settleFinalStubForDeparture, unwindWash,
  washPairing, washVerdict, WashInputError,
} from './earlyDepartureWash'

// A park, a site and a meter on it, plus the pieces a stay needs.
type Park = {
  userId: string; landlordId: string; propertyId: string; unitId: string
  meterId: string; tenantId: string
}

async function park(client: PoolClient, opts: { refunds?: boolean } = {}): Promise<Park> {
  const { userId, landlordId } = await seedLandlord(client)
  const propertyId = await seedProperty(client, { landlordId, ownerUserId: userId, managedByUserId: userId })
  if (opts.refunds === false) {
    await client.query(`UPDATE properties SET early_departure_refunds = false WHERE id = $1`, [propertyId])
  }
  const unitId = await seedUnit(client, { propertyId, landlordId, unitType: 'rv_spot' })
  // RV 10's real rates. 10/20: the money figure prices the nights stayed with
  // the shared stay pricer, so a site with no rates on file cannot be priced
  // and no figure is claimed for it. $49 / $269 / $589 is what Mountain View
  // actually charges, and 14 nights on it come to the $538 these tests are
  // built around. seedProperty leaves short_term_tax_rate at 0, so no lodging
  // tax arises here — repricedStayTax has its own suite for that.
  await client.query(
    `UPDATE units SET nightly_rate = 49, weekly_rate = 269, monthly_rate = 589 WHERE id = $1`, [unitId])
  const meterId = await seedUtilityMeter(client, { propertyId, utilityType: 'electric', billingMethod: 'submeter' })
  await client.query(`INSERT INTO utility_meter_units (meter_id, unit_id) VALUES ($1, $2)`, [meterId, unitId])
  const tenantId = await seedTenant(client)
  return { userId, landlordId, propertyId, unitId, meterId, tenantId }
}

/** A month-rate stay that pulled out early, the RV 10 / RV 11 shape. */
async function stay(client: PoolClient, p: Park, o: {
  checkIn?: string; leftOn?: string; bookedThrough?: string; guest?: string
} = {}): Promise<string> {
  const checkIn = o.checkIn ?? '2026-10-04'
  const leftOn = o.leftOn ?? '2026-10-18'
  const bookedThrough = o.bookedThrough ?? '2026-11-04'
  return (await client.query<{ id: string }>(
    `INSERT INTO unit_bookings
       (unit_id, landlord_id, lease_type, status, check_in, check_out, booked_check_out,
        guest_name, total_amount, balance_paid_at)
     VALUES ($1, $2, 'month_to_month', 'checked_out', $3::date, $4::date, $5::date, $6, 589, now())
     RETURNING id`,
    [p.unitId, p.landlordId, checkIn, leftOn, bookedThrough, o.guest ?? 'Victor Cardoza'])).rows[0].id
}

/** The same month-rate stay, on a named site. */
async function stayOnUnit(client: PoolClient, p: Park, unitId: string, guest: string): Promise<string> {
  return (await client.query<{ id: string }>(
    `INSERT INTO unit_bookings
       (unit_id, landlord_id, lease_type, status, check_in, check_out, booked_check_out,
        guest_name, total_amount, balance_paid_at)
     VALUES ($1, $2, 'month_to_month', 'checked_out', '2026-10-04', '2026-10-18', '2026-11-04', $3, 589, now())
     RETURNING id`, [unitId, p.landlordId, guest])).rows[0].id
}

/**
 * The LEASE a long stay was drafted from. The only link between the two is
 * `leases.source_booking_id` — a booking has no lease column — and that link is
 * what makes a month stay bill through the lease instead of its stay agreement.
 */
async function leaseOnStay(client: PoolClient, p: Park, bookingId: string, o: {
  status?: 'active' | 'expired'; unitId?: string
} = {}): Promise<string> {
  const leaseId = await seedLease(client, {
    unitId: o.unitId ?? p.unitId, landlordId: p.landlordId,
    status: o.status ?? 'active', startDate: '2026-04-01',
  })
  await client.query(
    `UPDATE leases SET source_booking_id = $2, end_date = '2026-10-18' WHERE id = $1`,
    [leaseId, bookingId])
  return leaseId
}

/**
 * The closing read already billed THROUGH THE LEASE, which is the only shape a
 * long stay's bill can take: tryInsertBill resolves the lease first and
 * utility_bills carries one payer or the other by CHECK, never both — so
 * service_agreement_id is NULL on exactly these bills.
 */
async function leaseKeyedBill(client: PoolClient, p: Park, leaseId: string, o: {
  meterId?: string; unitId?: string
} = {}): Promise<string> {
  return (await client.query<{ id: string }>(
    `INSERT INTO utility_bills
       (meter_id, unit_id, tenant_id, landlord_id, lease_id, billing_cycle_month,
        charge_amount, utility_type, status, allocation_method, rate_per_unit,
        usage_amount, reading_start, reading_end, reading_start_date, reading_end_date)
     VALUES ($1, $2, $3, $4, $5, '2026-10-01', 72.55, 'electric', 'billed', 'submeter', 0.21,
             345, 1000, 1345, '2026-10-01', '2026-10-18')
     RETURNING id`,
    [o.meterId ?? p.meterId, o.unitId ?? p.unitId, p.tenantId, p.landlordId, leaseId])).rows[0].id
}

/**
 * The check-out window's money answer. `paid` and `stayedWorth` are what the
 * desk was shown: $589 paid, 14 nights worth $538 on the two-week rate, so $51
 * was on the table.
 */
async function answer(client: PoolClient, p: Park, bookingId: string, o: {
  choice?: 'no_refund' | 'refund_unused' | 'refund_other' | 'keep_price' | 'nights_only' | null
  refundTotal?: number; paid?: number; stayedWorth?: number; leftOn?: string
} = {}): Promise<string> {
  const decided = o.choice != null
  return (await client.query<{ id: string }>(
    `INSERT INTO stay_checkout_decisions
       (booking_id, landlord_id, left_on, question, choice, status,
        booked_price, stayed_worth, paid, refund_total, decided_at)
     VALUES ($1, $2, $3::date, 'overpaid', $4, $5, 589, $6, $7, $8, $9)
     RETURNING id`,
    [bookingId, p.landlordId, o.leftOn ?? '2026-10-18', o.choice ?? null,
     decided ? 'decided' : 'pending', o.stayedWorth ?? 538, o.paid ?? 589,
     o.refundTotal ?? 0, decided ? new Date() : null])).rows[0].id
}

/** The final stub the closing read produced: 387 kWh at 21¢, $81.27. */
const stub = (p: Park, ref: { bookingId?: string; leaseId?: string }, over: Record<string, unknown> = {}) => ({
  landlordId: p.landlordId, meterId: p.meterId, unitId: p.unitId,
  utilityType: 'electric', cycleMonth: '2026-10-01',
  chargeAmount: 81.27, baseFeeShare: 0, taxAmount: 0, taxRatePct: 0,
  usageAmount: 387, allocationMethod: 'submeter', allocationBasis: null,
  ratePerUnit: 0.21, readingStart: 1000, readingEnd: 1387,
  readingStartDate: '2026-10-01', readingEndDate: '2026-10-18',
  ref, ...over,
})

const absorbed = async (landlordId: string) =>
  (await db.query<any>(
    `SELECT reason, charge_amount::float AS charge_amount, wash_id, booking_id, lease_id,
            to_char(departed_on, 'YYYY-MM-DD') AS departed_on, usage_amount::float AS usage_amount
       FROM utility_absorbed_charges WHERE landlord_id = $1 ORDER BY charge_amount`, [landlordId])).rows

describe('the value sets have one definition (CLAUDE.md)', () => {
  it('the reason CHECK in the database lists exactly ABSORBED_CHARGE_REASONS', async () => {
    const def = (await db.query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conname = 'utility_absorbed_charges_reason_check'`)).rows[0]?.def ?? ''
    const inDb = [...def.matchAll(/'([a-z_]+)'::text/g)].map(m => m[1]).sort()
    expect(inDb).toEqual([...ABSORBED_CHARGE_REASONS].sort())
  })

  it('every reason and unwind reason has words a person can read', () => {
    for (const r of ABSORBED_CHARGE_REASONS) {
      expect(ABSORBED_CHARGE_REASON_LABEL[r]).toBeTruthy()
      expect(ABSORBED_CHARGE_REASON_LABEL[r]).not.toContain('_')
    }
    for (const r of WASH_UNWIND_REASONS) expect(WASH_UNWIND_REASON_LABEL[r]).toBeTruthy()
  })

  it('a departure is a booking or a lease, and a stay with both is its booking', () => {
    expect(() => normalizeDeparture({})).toThrow(WashInputError)
    const both = normalizeDeparture({ bookingId: 'b', leaseId: 'l' })
    expect(both.key).toBe('b')
    expect(normalizeDeparture({ leaseId: 'l' }).key).toBe('l')
  })
})

describe('a wash: left early, kept the money, eat the power', () => {
  let p: Park
  let client: PoolClient

  afterEach(() => { client?.release() })

  beforeEach(async () => {
    await cleanupAllSchema()
    client = await getClient()
    p = await park(client)
  })

  it('records the money kept and the absorbed stub, and reads them back side by side', async () => {
    const bookingId = await stay(client, p)
    const decisionId = await answer(client, p, bookingId, { choice: 'no_refund' })

    const rec = await recordMoneyKeptOnDeparture({
      landlordId: p.landlordId, ref: { bookingId },
      propertyId: p.propertyId, unitId: p.unitId, tenantId: p.tenantId,
      checkoutDecisionId: decisionId, client,
    })
    expect(rec.isWash).toBe(true)
    // $589 paid, 14 nights worth $538 — the $51 the desk declined to give back.
    expect(rec.amountKept).toBe(51)
    expect(rec.washId).toBeTruthy()

    const verdict = await washVerdict({ bookingId }, p.landlordId, client)
    expect(verdict.verdict).toBe('wash')
    expect(verdict.amountKept).toBe(51)

    const settled = await settleFinalStubForDeparture({ ...stub(p, { bookingId }), client })
    expect(settled.outcome).toBe('absorbed')
    expect(settled.washId).toBe(rec.washId)

    const rows = (await client.query<any>(
      `SELECT reason, charge_amount::float AS charge_amount, wash_id, booking_id,
              to_char(departed_on, 'YYYY-MM-DD') AS departed_on
         FROM utility_absorbed_charges WHERE landlord_id = $1`, [p.landlordId])).rows
    expect(rows).toHaveLength(1)
    expect(rows[0].reason).toBe('early_departure_wash')
    expect(rows[0].charge_amount).toBe(81.27)
    expect(rows[0].wash_id).toBe(rec.washId)
    expect(rows[0].booking_id).toBe(bookingId)
    expect(rows[0].departed_on).toBe('2026-10-18')

    // Nobody was billed for it.
    const bills = (await client.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM utility_bills WHERE landlord_id = $1`, [p.landlordId])).rows[0]
    expect(Number(bills.n)).toBe(0)
  })

  it('the pairing read gives the money and the power on one row', async () => {
    const bookingId = await stay(client, p)
    await answer(client, p, bookingId, { choice: 'no_refund' })
    await recordMoneyKeptOnDeparture({
      landlordId: p.landlordId, ref: { bookingId },
      propertyId: p.propertyId, unitId: p.unitId, client,
    })
    await settleFinalStubForDeparture({ ...stub(p, { bookingId }), client })

    const pairs = await washPairing(p.landlordId, {}, client)
    expect(pairs).toHaveLength(1)
    expect(pairs[0].moneyKept).toBe(51)
    expect(pairs[0].utilityAbsorbed).toBe(81.27)
    // $51 kept against $81.27 of power: short by $30.27, which is the whole
    // point of the report.
    expect(pairs[0].evenedOutBy).toBe(-30.27)
    expect(pairs[0].closingReadsIn).toBe(true)
    expect(pairs[0].heldStubs).toBe(0)
    expect(pairs[0].who).toBe('Victor Cardoza')
  })

  it('a billing re-run writes the same absorbed row, never a second one', async () => {
    const bookingId = await stay(client, p)
    await answer(client, p, bookingId, { choice: 'no_refund' })
    await recordMoneyKeptOnDeparture({
      landlordId: p.landlordId, ref: { bookingId },
      propertyId: p.propertyId, unitId: p.unitId, client,
    })
    const first = await settleFinalStubForDeparture({ ...stub(p, { bookingId }), client })
    const again = await settleFinalStubForDeparture({ ...stub(p, { bookingId }), client })
    expect(again.outcome).toBe('absorbed')
    expect(again.absorbedChargeId).toBe(first.absorbedChargeId)
    const rows = (await client.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM utility_absorbed_charges WHERE landlord_id = $1`, [p.landlordId])).rows[0]
    expect(Number(rows.n)).toBe(1)
  })

  /**
   * 10/20 — THE OVERWRITE. A departure has one absorbed stub per meter and the
   * key leaves the month out on purpose, so a second absorbed write for the same
   * departure REPLACES the first. Absorbing writes no utility_bills row, so the
   * per-cycle bill uniqueness that normally stops a second pass is not there,
   * and the month-end run resolves cycle 10 to the lease that covered the 1st —
   * the one that just ended. Its span starts at the departing guest's own
   * closing read, so it is the ARRIVAL's power, and under "ends after they left"
   * alone it looked final too: October's $40.11 came back as $3.00, one
   * departure's absorbed power gone and a stranger's use booked under their
   * wash. The only number this whole feature exists to produce, short by a
   * departure, with nothing anywhere saying so.
   */
  it('a span that starts the day they left is not their final stub, and cannot overwrite it', async () => {
    // On a STAY, since a lease never washes (10/20, Nic).
    const bookingId = await stay(client, p)
    await answer(client, p, bookingId, { choice: 'no_refund' })
    await recordMoneyKeptOnDeparture({
      landlordId: p.landlordId, ref: { bookingId },
      propertyId: p.propertyId, unitId: p.unitId, tenantId: p.tenantId,
      departedOn: '2026-10-18', paidThrough: '2026-11-04',
      amountKept: 420, refundGiven: false, client,
    })

    // The closing read at the desk on the day they pulled out: theirs, absorbed.
    const closing = await settleFinalStubForDeparture({
      ...stub(p, { bookingId }, {
        chargeAmount: 40.11, usageAmount: 191, readingStart: 1000, readingEnd: 1191,
        readingStartDate: '2026-10-04', readingEndDate: '2026-10-18',
      }),
      client,
    })
    expect(closing.outcome).toBe('absorbed')

    // The month-end run on the same cycle, measured from that closing read.
    const afterTheyWent = await settleFinalStubForDeparture({
      ...stub(p, { bookingId }, {
        chargeAmount: 3, usageAmount: 14, readingStart: 1191, readingEnd: 1205,
        readingStartDate: '2026-10-18', readingEndDate: '2026-10-31',
      }),
      client,
    })
    expect(afterTheyWent.outcome).toBe('bill_normally')

    // ...and next month's cycle, which carries no reads of its own at all.
    const nextMonth = await settleFinalStubForDeparture({
      ...stub(p, { bookingId }, {
        cycleMonth: '2026-11-01', chargeAmount: 62.5, usageAmount: 298,
        readingStart: null, readingEnd: null, readingStartDate: null, readingEndDate: null,
      }),
      client,
    })
    expect(nextMonth.outcome).toBe('bill_normally')

    // What they were absorbed stayed what they were absorbed.
    const rows2 = await absorbed(p.landlordId)
    expect(rows2).toHaveLength(1)
    expect(rows2[0].charge_amount).toBe(40.11)
    expect(rows2[0].usage_amount).toBe(191)
    expect((await washPairing(p.landlordId, {}, client))[0].utilityAbsorbed).toBe(40.11)
  })

  it('a month read entered after they had gone is still their final stub (S548)', async () => {
    // No closing read was ever taken, so the month read folds the gap days in
    // and IS the final one. It begins before they left, so it is theirs.
    const bookingId = await stay(client, p)
    await answer(client, p, bookingId, { choice: 'no_refund' })
    await recordMoneyKeptOnDeparture({
      landlordId: p.landlordId, ref: { bookingId },
      propertyId: p.propertyId, unitId: p.unitId, client,
    })
    const settled = await settleFinalStubForDeparture({
      ...stub(p, { bookingId }, { readingStartDate: '2026-10-04', readingEndDate: '2026-10-31' }),
      client,
    })
    expect(settled.outcome).toBe('absorbed')
    expect((await absorbed(p.landlordId))[0].charge_amount).toBe(81.27)
  })

  it('a property that never gives money back washes without anyone being asked', async () => {
    const noRefunds = await park(client, { refunds: false })
    const bookingId = await stay(client, noRefunds, { guest: 'Nemesio Rivera' })
    // No check-out decision at all: there was no question to put to the desk.
    const verdict = await washVerdict({ bookingId }, noRefunds.landlordId, client)
    expect(verdict.verdict).toBe('wash')
    expect(verdict.why).toContain('does not give money back')

    const settled = await settleFinalStubForDeparture({ ...stub(noRefunds, { bookingId }), client })
    expect(settled.outcome).toBe('absorbed')
    const pairs = await washPairing(noRefunds.landlordId, {}, client)
    expect(pairs).toHaveLength(1)
    expect(pairs[0].utilityAbsorbed).toBe(81.27)
  })

  it('a LEASE move-out never washes, however much was kept', async () => {
    // 10/20 (Nic), pushing back on the wash covering both: "A lease is an
    // agreed upon amount. They're responsible for that time. Stays are just
    // kind of a verbal, like, hey, we're here. But a lease is a legal
    // document. If it says they're good through, you know, 2 more months and
    // they leave early and we keep the money, that's money that we're legally
    // entitled to. They are obligated to that because it's a lease."
    //
    // So rent left behind on a lease is a debt the tenant still owes, not a
    // windfall to set a power bill against, and their final utility is theirs
    // to pay like any other month of it. Releasing the spot early is the one
    // thing that would change this, and he declined to open it.
    const leaseId = await seedLease(client, { unitId: p.unitId, landlordId: p.landlordId, status: 'expired' })
    await client.query(`UPDATE leases SET end_date = '2026-10-18' WHERE id = $1`, [leaseId])

    const verdict = await washVerdict({ leaseId }, p.landlordId, client)
    expect(verdict.verdict).toBe('bill')
    expect(verdict.washId).toBeNull()

    const rec = await recordMoneyKeptOnDeparture({
      landlordId: p.landlordId, ref: { leaseId },
      propertyId: p.propertyId, unitId: p.unitId, tenantId: p.tenantId,
      departedOn: '2026-10-18', paidThrough: '2026-10-31',
      amountKept: 420, refundGiven: false, client,
    })
    expect(rec.isWash).toBe(false)
    expect(rec.washId).toBeNull()

    const settled = await settleFinalStubForDeparture({ ...stub(p, { leaseId }), client })
    expect(settled.outcome).toBe('bill_normally')
    expect(await absorbed(p.landlordId)).toHaveLength(0)
    // Nothing on the fairness report either — a lease is not part of that math.
    expect(await washPairing(p.landlordId, {}, client)).toHaveLength(0)
  })
})

describe('not a wash', () => {
  let p: Park
  let client: PoolClient

  afterEach(() => { client?.release() })

  beforeEach(async () => {
    await cleanupAllSchema()
    client = await getClient()
    p = await park(client)
  })

  it('a refund of any size means the final stub bills normally', async () => {
    const bookingId = await stay(client, p)
    await answer(client, p, bookingId, { choice: 'refund_unused', refundTotal: 51 })

    const verdict = await washVerdict({ bookingId }, p.landlordId, client)
    expect(verdict.verdict).toBe('bill')
    expect(verdict.refundGiven).toBe(true)

    const rec = await recordMoneyKeptOnDeparture({
      landlordId: p.landlordId, ref: { bookingId },
      propertyId: p.propertyId, unitId: p.unitId, client,
    })
    expect(rec.isWash).toBe(false)

    const settled = await settleFinalStubForDeparture({ ...stub(p, { bookingId }), client })
    expect(settled.outcome).toBe('bill_normally')
    expect(await absorbed(p.landlordId)).toHaveLength(0)
    // ...and it never shows in the report.
    expect(await washPairing(p.landlordId, {}, client)).toHaveLength(0)
  })

  it('a PARTIAL refund is the same answer (the judgment call, held to on purpose)', async () => {
    const bookingId = await stay(client, p)
    await answer(client, p, bookingId, { choice: 'refund_other', refundTotal: 25 })
    const verdict = await washVerdict({ bookingId }, p.landlordId, client)
    expect(verdict.verdict).toBe('bill')
    const settled = await settleFinalStubForDeparture({ ...stub(p, { bookingId }), client })
    expect(settled.outcome).toBe('bill_normally')
  })

  it('somebody who left on their booked day kept nothing, so nothing is recorded', async () => {
    const bookingId = await stay(client, p, { leftOn: '2026-11-04', bookedThrough: '2026-11-04' })
    await answer(client, p, bookingId, { choice: 'no_refund', leftOn: '2026-11-04' })
    const verdict = await washVerdict({ bookingId }, p.landlordId, client)
    expect(verdict.verdict).toBe('bill')
    expect(verdict.why).toContain('booked through')

    const rec = await recordMoneyKeptOnDeparture({
      landlordId: p.landlordId, ref: { bookingId },
      propertyId: p.propertyId, unitId: p.unitId, client,
    })
    expect(rec.washId).toBeNull()
    expect((await client.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM early_departure_washes`)).rows[0].n).toBe('0')
  })

  it('somebody who still OWED is not a wash — money kept is the question', async () => {
    const bookingId = await stay(client, p)
    // The "still owes" question, not the overpaid one.
    await client.query(
      `INSERT INTO stay_checkout_decisions
         (booking_id, landlord_id, left_on, question, choice, status, booked_price, stayed_worth, paid, decided_at)
       VALUES ($1, $2, '2026-10-18', 'owes', 'nights_only', 'decided', 589, 538, 0, now())`,
      [bookingId, p.landlordId])
    const verdict = await washVerdict({ bookingId }, p.landlordId, client)
    expect(verdict.verdict).toBe('bill')
    expect(verdict.why).toContain('still owed')
  })
})

describe('the money answer and the closing read, in either order', () => {
  let p: Park
  let client: PoolClient

  afterEach(() => { client?.release() })

  beforeEach(async () => {
    await cleanupAllSchema()
    client = await getClient()
    p = await park(client)
  })

  it('an unanswered question HOLDS the stub and reports it as not billed', async () => {
    const bookingId = await stay(client, p)
    // Checked out by a clerk with no "Issue refunds": the question waits.
    await answer(client, p, bookingId, { choice: null })

    const verdict = await washVerdict({ bookingId }, p.landlordId, client)
    expect(verdict.verdict).toBe('undecided')

    const settled = await settleFinalStubForDeparture({ ...stub(p, { bookingId }), client })
    expect(settled.outcome).toBe('held')
    expect(settled.holdId).toBeTruthy()
    // Nothing on the book and nothing billed while it waits.
    expect(await absorbed(p.landlordId)).toHaveLength(0)
    const held = await openWashHolds(p.landlordId, { bookingId }, client)
    expect(held).toHaveLength(1)
    expect(held[0].chargeAmount).toBe(81.27)
    expect(held[0].usageAmount).toBe(387)

    const pairs = await washPairing(p.landlordId, {}, client)
    expect(pairs).toHaveLength(0)
  })

  it('a re-run parks the same hold, never a second one', async () => {
    const bookingId = await stay(client, p)
    await answer(client, p, bookingId, { choice: null })
    const a = await settleFinalStubForDeparture({ ...stub(p, { bookingId }), client })
    const b = await settleFinalStubForDeparture({ ...stub(p, { bookingId }), client })
    expect(b.outcome).toBe('held')
    expect(b.holdId).toBe(a.holdId)
    expect(await openWashHolds(p.landlordId, { bookingId }, client)).toHaveLength(1)
  })

  it('CLOSING READ FIRST: the answer arrives later and the hold becomes the book', async () => {
    const bookingId = await stay(client, p)
    await answer(client, p, bookingId, { choice: null })
    await settleFinalStubForDeparture({ ...stub(p, { bookingId }), client })
    expect(await openWashHolds(p.landlordId, { bookingId }, client)).toHaveLength(1)

    // Somebody with "Issue refunds" answers: no refund.
    await client.query(
      `UPDATE stay_checkout_decisions SET choice = 'no_refund', status = 'decided', decided_at = now()
        WHERE booking_id = $1`, [bookingId])
    const rec = await recordMoneyKeptOnDeparture({
      landlordId: p.landlordId, ref: { bookingId },
      propertyId: p.propertyId, unitId: p.unitId, client,
    })
    expect(rec.isWash).toBe(true)
    expect(rec.absorbedHolds).toBe(1)
    const rows = await absorbed(p.landlordId)
    expect(rows).toHaveLength(1)
    expect(rows[0].charge_amount).toBe(81.27)
    expect(rows[0].wash_id).toBe(rec.washId)
    expect(await openWashHolds(p.landlordId, { bookingId }, client)).toHaveLength(0)
  })

  it('CLOSING READ FIRST and the answer is a refund: the held stub goes back to billing', async () => {
    const bookingId = await stay(client, p)
    await answer(client, p, bookingId, { choice: null })
    await settleFinalStubForDeparture({ ...stub(p, { bookingId }), client })

    await client.query(
      `UPDATE stay_checkout_decisions SET choice = 'refund_unused', status = 'decided',
              refund_total = 51, decided_at = now() WHERE booking_id = $1`, [bookingId])
    const rec = await recordMoneyKeptOnDeparture({
      landlordId: p.landlordId, ref: { bookingId },
      propertyId: p.propertyId, unitId: p.unitId, client,
    })
    expect(rec.isWash).toBe(false)
    expect(rec.releasedStubs).toHaveLength(1)
    // Everything the billing engine needs to bill it comes back with it.
    expect(rec.releasedStubs[0].chargeAmount).toBe(81.27)
    expect(rec.releasedStubs[0].meterId).toBe(p.meterId)
    expect(rec.releasedStubs[0].readingEnd).toBe(1387)
    expect(rec.releasedStubs[0].cycleMonth).toBe('2026-10-01')
    expect(await absorbed(p.landlordId)).toHaveLength(0)
    expect(await openWashHolds(p.landlordId, { bookingId }, client)).toHaveLength(0)
  })

  it('a wash decided AFTER the stub was billed takes that bill back', async () => {
    const bookingId = await stay(client, p)
    const saId = (await client.query<{ id: string }>(
      `INSERT INTO utility_service_agreements (landlord_id, unit_id, tenant_id, booking_id, start_date, end_date)
       VALUES ($1, $2, $3, $4, '2026-10-04', '2026-10-18') RETURNING id`,
      [p.landlordId, p.unitId, p.tenantId, bookingId])).rows[0].id
    const billId = (await client.query<{ id: string }>(
      `INSERT INTO utility_bills
         (meter_id, unit_id, tenant_id, landlord_id, service_agreement_id, billing_cycle_month,
          charge_amount, utility_type, status, allocation_method, reading_end_date)
       VALUES ($1, $2, $3, $4, $5, '2026-10-01', 81.27, 'electric', 'billed', 'submeter', '2026-10-18')
       RETURNING id`, [p.meterId, p.unitId, p.tenantId, p.landlordId, saId])).rows[0].id

    await answer(client, p, bookingId, { choice: 'no_refund' })
    const rec = await recordMoneyKeptOnDeparture({
      landlordId: p.landlordId, ref: { bookingId },
      propertyId: p.propertyId, unitId: p.unitId, client,
    })
    expect(rec.isWash).toBe(true)
    expect(rec.reversedBills).toBe(1)
    const bill = (await client.query<any>(
      `SELECT status, void_reason FROM utility_bills WHERE id = $1`, [billId])).rows[0]
    expect(bill.status).toBe('void')
    expect(bill.void_reason).toContain('wash')
  })

  it('and that voided bill goes ON THE BOOK — taking it off their account is absorbing it', async () => {
    const bookingId = await stay(client, p)
    const saId = (await client.query<{ id: string }>(
      `INSERT INTO utility_service_agreements (landlord_id, unit_id, tenant_id, booking_id, start_date, end_date)
       VALUES ($1, $2, $3, $4, '2026-10-04', '2026-10-18') RETURNING id`,
      [p.landlordId, p.unitId, p.tenantId, bookingId])).rows[0].id
    // The gate billed this one normally — nothing on file said wash yet, so the
    // resident was invoiced $39.11 plus a dollar of tax.
    await client.query(
      `INSERT INTO utility_bills
         (meter_id, unit_id, tenant_id, landlord_id, service_agreement_id, billing_cycle_month,
          charge_amount, base_fee_share, tax_amount, tax_rate_pct, usage_amount,
          allocation_method, rate_per_unit, reading_start, reading_end,
          reading_start_date, reading_end_date, utility_type, status)
       VALUES ($1, $2, $3, $4, $5, '2026-10-01', 39.11, 1.00, 1.00, 2.5, 191,
               'submeter', 0.21, 1000, 1191, '2026-10-01', '2026-10-18', 'electric', 'billed')`,
      [p.meterId, p.unitId, p.tenantId, p.landlordId, saId])

    await answer(client, p, bookingId, { choice: 'no_refund' })
    const rec = await recordMoneyKeptOnDeparture({
      landlordId: p.landlordId, ref: { bookingId },
      propertyId: p.propertyId, unitId: p.unitId, client,
    })
    expect(rec.isWash).toBe(true)
    expect(rec.reversedBills).toBe(1)

    // The landlord ate it. "If we're keeping track of electric that's not
    // billed back, we need to count that there" — a void that writes nothing
    // here is power that came off their account and onto nobody's.
    const book = (await client.query<any>(
      `SELECT reason, wash_id, booking_id, utility_type,
              charge_amount::float AS charge_amount, base_fee_share::float AS base_fee_share,
              tax_amount::float AS tax_amount, usage_amount::float AS usage_amount,
              reading_start::float AS reading_start, reading_end::float AS reading_end,
              to_char(billing_cycle_month, 'YYYY-MM-DD') AS cycle_month,
              to_char(departed_on, 'YYYY-MM-DD') AS departed_on
         FROM utility_absorbed_charges WHERE landlord_id = $1`, [p.landlordId])).rows
    expect(book).toHaveLength(1)
    expect(book[0]).toMatchObject({
      reason: 'early_departure_wash', wash_id: rec.washId, booking_id: bookingId,
      utility_type: 'electric', charge_amount: 39.11, base_fee_share: 1, tax_amount: 1,
      usage_amount: 191, reading_start: 1000, reading_end: 1191,
      cycle_month: '2026-10-01', departed_on: '2026-10-18',
    })
    expect(rec.absorbedBills).toBe(1)

    // And the comparison Nic asked for comes out even-ish instead of reading
    // as $51 of pure profit.
    const [pair] = await washPairing(p.landlordId, {}, client)
    expect(pair.moneyKept).toBe(51)
    expect(pair.utilityAbsorbed).toBe(40.11)
    expect(pair.evenedOutBy).toBe(10.89)
    expect(pair.closingReadsIn).toBe(true)
  })

  it('a stub split over two cycles — one billed, one held — keeps BOTH halves on the book', async () => {
    const bookingId = await stay(client, p)
    const saId = (await client.query<{ id: string }>(
      `INSERT INTO utility_service_agreements (landlord_id, unit_id, tenant_id, booking_id, start_date, end_date)
       VALUES ($1, $2, $3, $4, '2026-10-04', '2026-10-18') RETURNING id`,
      [p.landlordId, p.unitId, p.tenantId, bookingId])).rows[0].id
    // October's read was billed before anyone knew this was a departure.
    await client.query(
      `INSERT INTO utility_bills
         (meter_id, unit_id, tenant_id, landlord_id, service_agreement_id, billing_cycle_month,
          charge_amount, utility_type, status, allocation_method, reading_end_date)
       VALUES ($1, $2, $3, $4, $5, '2026-10-01', 30.00, 'electric', 'billed', 'submeter', '2026-10-18')`,
      [p.meterId, p.unitId, p.tenantId, p.landlordId, saId])
    // November's landed at the gate with the money question still open, so it parked.
    await answer(client, p, bookingId, { choice: null })
    expect((await settleFinalStubForDeparture({
      ...stub(p, { bookingId }, { cycleMonth: '2026-11-01', chargeAmount: 10, usageAmount: 48 }),
      client,
    })).outcome).toBe('held')

    await client.query(
      `UPDATE stay_checkout_decisions SET choice = 'no_refund', status = 'decided', decided_at = now()
        WHERE booking_id = $1`, [bookingId])
    const rec = await recordMoneyKeptOnDeparture({
      landlordId: p.landlordId, ref: { bookingId },
      propertyId: p.propertyId, unitId: p.unitId, client,
    })
    expect(rec.absorbedHolds).toBe(1)
    expect(rec.reversedBills).toBe(1)
    // One row per departure per meter is the key, so the two halves are one
    // line — and the line is worth both of them, not whichever landed last.
    const book = await absorbed(p.landlordId)
    expect(book).toHaveLength(1)
    expect(book[0].charge_amount).toBe(40)
    expect((await washPairing(p.landlordId, {}, client))[0].utilityAbsorbed).toBe(40)
  })

  it('an already-PAID final bill is left alone and said out loud', async () => {
    const bookingId = await stay(client, p)
    const saId = (await client.query<{ id: string }>(
      `INSERT INTO utility_service_agreements (landlord_id, unit_id, tenant_id, booking_id, start_date, end_date)
       VALUES ($1, $2, $3, $4, '2026-10-04', '2026-10-18') RETURNING id`,
      [p.landlordId, p.unitId, p.tenantId, bookingId])).rows[0].id
    await client.query(
      `INSERT INTO utility_bills
         (meter_id, unit_id, tenant_id, landlord_id, service_agreement_id, billing_cycle_month,
          charge_amount, utility_type, status, allocation_method, paid_at, reading_end_date)
       VALUES ($1, $2, $3, $4, $5, '2026-10-01', 81.27, 'electric', 'paid', 'submeter', now(), '2026-10-18')`,
      [p.meterId, p.unitId, p.tenantId, p.landlordId, saId])

    await answer(client, p, bookingId, { choice: 'no_refund' })
    const rec = await recordMoneyKeptOnDeparture({
      landlordId: p.landlordId, ref: { bookingId },
      propertyId: p.propertyId, unitId: p.unitId, client,
    })
    expect(rec.reversedBills).toBe(0)
    expect(rec.paidBillsLeftAlone).toBe(1)
    expect(rec.why).toContain('already paid')
  })

  /**
   * A LONG STAY ON A LEASE bills through the LEASE, and the void has to look
   * there. This is the shape that was quietly broken: the departure hands over
   * both ids, so picking the stay agreement because a booking id is present
   * searched `service_agreement_id` — a column that is NULL on every one of
   * these bills — and voided nothing. The landlord's book said "called it a
   * wash" while the resident still held the invoice, the debt and the late fee.
   */
  it('a wash on a LONG STAY takes back the bill its LEASE was billed under', async () => {
    const bookingId = await stay(client, p)
    const leaseId = await leaseOnStay(client, p, bookingId)
    const billId = await leaseKeyedBill(client, p, leaseId)

    await answer(client, p, bookingId, { choice: 'no_refund' })
    const rec = await recordMoneyKeptOnDeparture({
      landlordId: p.landlordId, ref: { bookingId, leaseId },
      propertyId: p.propertyId, unitId: p.unitId, client,
    })
    expect(rec.isWash).toBe(true)
    expect(rec.reversedBills).toBe(1)
    const bill = (await client.query<any>(
      `SELECT status, void_reason FROM utility_bills WHERE id = $1`, [billId])).rows[0]
    expect(bill.status).toBe('void')
    expect(bill.void_reason).toContain('wash')
  })

  /**
   * ...and the caller does not always HAVE the lease id. The check-out window
   * only joins a lease that is still 'active' or 'pending', so once the nightly
   * lease-end processor has expired it, a redate or a corrected answer
   * (afterPatchEarlyCheckOut → recordWashNobodyWasAsked) re-records the wash
   * with the booking alone. The lease has to be read off the booking, or the
   * same resident keeps the same bill a day later.
   */
  it('and takes it back when the lease has since expired and only the booking is handed over', async () => {
    const bookingId = await stay(client, p)
    const leaseId = await leaseOnStay(client, p, bookingId, { status: 'expired' })
    const billId = await leaseKeyedBill(client, p, leaseId)

    await answer(client, p, bookingId, { choice: 'no_refund' })
    const rec = await recordMoneyKeptOnDeparture({
      landlordId: p.landlordId, ref: { bookingId },
      propertyId: p.propertyId, unitId: p.unitId, client,
    })
    expect(rec.isWash).toBe(true)
    expect(rec.reversedBills).toBe(1)
    expect((await client.query<any>(
      `SELECT status FROM utility_bills WHERE id = $1`, [billId])).rows[0].status).toBe('void')
  })

  /**
   * Reading the lease off the booking must not reach past this landlord, and it
   * must not reach past this departure: another landlord's lease on another
   * booking keeps its bill, wash or no wash.
   */
  it('a wash never voids a bill that belongs to another departure', async () => {
    const bookingId = await stay(client, p)
    const leaseId = await leaseOnStay(client, p, bookingId)
    await leaseKeyedBill(client, p, leaseId)

    // RV 11, next door: its own site and its own meter, because one meter holds
    // one bill per cycle (utility_bills_one_per_meter_unit_cycle).
    const nbUnit = await seedUnit(client, { propertyId: p.propertyId, landlordId: p.landlordId, unitType: 'rv_spot' })
    const nbMeter = await seedUtilityMeter(client, { propertyId: p.propertyId, utilityType: 'electric', billingMethod: 'submeter' })
    await client.query(`INSERT INTO utility_meter_units (meter_id, unit_id) VALUES ($1, $2)`, [nbMeter, nbUnit])
    const neighborBooking = await stayOnUnit(client, p, nbUnit, 'Nemesio Rivera')
    const neighborLease = await leaseOnStay(client, p, neighborBooking, { unitId: nbUnit })
    const neighborBill = await leaseKeyedBill(client, p, neighborLease, { meterId: nbMeter, unitId: nbUnit })

    await answer(client, p, bookingId, { choice: 'no_refund' })
    const rec = await recordMoneyKeptOnDeparture({
      landlordId: p.landlordId, ref: { bookingId, leaseId },
      propertyId: p.propertyId, unitId: p.unitId, client,
    })
    expect(rec.reversedBills).toBe(1)
    expect((await client.query<any>(
      `SELECT status FROM utility_bills WHERE id = $1`, [neighborBill])).rows[0].status).toBe('billed')
  })

  /**
   * WHAT A WASH MAY TAKE BACK: the payer's OWN metered read, and nothing else.
   *
   * The gate bills a pooled RUBS share and a flat charge on a wash deliberately
   * (WASH_COVERED_ALLOCATION_METHODS), and so never absorbs either one — which
   * the void has to agree with or a real receivable disappears. It matched on
   * the DATE alone, and a pooled share carries the MASTER's read date: the
   * October water share of a resident who left on the 18th, off a master read
   * on the 28th, passed that test and came off their account with nothing
   * written in its place. The money was then in no column of the recovery
   * report — not `recovered`, not `earlyDepartureWash`, just gone. Oak Park has
   * 21 water spaces on a master with no submeter, so this is the live
   * configuration and not an edge case.
   */
  it('takes back their metered read and LEAVES the pooled water share and the trash fee alone', async () => {
    const bookingId = await stay(client, p)
    const saId = (await client.query<{ id: string }>(
      `INSERT INTO utility_service_agreements (landlord_id, unit_id, tenant_id, booking_id, start_date, end_date)
       VALUES ($1, $2, $3, $4, '2026-10-04', '2026-10-18') RETURNING id`,
      [p.landlordId, p.unitId, p.tenantId, bookingId])).rows[0].id
    // The water master nobody reads per space, read on the 28th and split
    // across the park, and the trash fee, which is a price and not a reading.
    const waterMaster = await seedUtilityMeter(client, {
      propertyId: p.propertyId, utilityType: 'water',
      billingMethod: 'rubs', rubsAllocationMethod: 'occupant_count',
    })
    const trashMeter = await seedUtilityMeter(client, {
      propertyId: p.propertyId, utilityType: 'trash', billingMethod: 'flat_rate',
    })
    const bill = async (meterId: string, type: string, method: string, amount: number, readEnd: string) =>
      (await client.query<{ id: string }>(
        `INSERT INTO utility_bills
           (meter_id, unit_id, tenant_id, landlord_id, service_agreement_id, billing_cycle_month,
            charge_amount, utility_type, allocation_method, status, reading_end_date)
         VALUES ($1, $2, $3, $4, $5, '2026-10-01', $6, $7, $8, 'billed', $9::date)
         RETURNING id`,
        [meterId, p.unitId, p.tenantId, p.landlordId, saId, amount, type, method, readEnd])).rows[0].id
    const theirRead = await bill(p.meterId, 'electric', 'submeter', 81.27, '2026-10-18')
    const pooledShare = await bill(waterMaster, 'water', 'occupant_count', 24.50, '2026-10-28')
    const trashFee = await bill(trashMeter, 'trash', 'flat_rate', 25.00, '2026-10-31')

    await answer(client, p, bookingId, { choice: 'no_refund' })
    const rec = await recordMoneyKeptOnDeparture({
      landlordId: p.landlordId, ref: { bookingId },
      propertyId: p.propertyId, unitId: p.unitId, client,
    })
    expect(rec.isWash).toBe(true)
    expect(rec.reversedBills).toBe(1)

    const status = async (id: string) => (await client.query<any>(
      `SELECT status FROM utility_bills WHERE id = $1`, [id])).rows[0].status
    expect(await status(theirRead)).toBe('void')
    expect(await status(pooledShare)).toBe('billed')
    expect(await status(trashFee)).toBe('billed')

    // And nothing went on the book for either of them, which is the other half
    // of the hole: money off an account and onto nobody's.
    expect((await client.query<any>(
      `SELECT utility_type FROM utility_absorbed_charges
        WHERE landlord_id = $1 AND utility_type <> 'electric'`, [p.landlordId])).rows).toHaveLength(0)
  })

  it('a PAID pooled share is not reported as a final bill waiting on a refund decision', async () => {
    // paidBillsLeftAlone is what tells the desk "that money has moved, handing
    // it back is a refund decision somebody makes". Said about a pooled share,
    // it asks for a refund decision on money nobody was going to give back.
    const bookingId = await stay(client, p)
    const saId = (await client.query<{ id: string }>(
      `INSERT INTO utility_service_agreements (landlord_id, unit_id, tenant_id, booking_id, start_date, end_date)
       VALUES ($1, $2, $3, $4, '2026-10-04', '2026-10-18') RETURNING id`,
      [p.landlordId, p.unitId, p.tenantId, bookingId])).rows[0].id
    const waterMaster = await seedUtilityMeter(client, {
      propertyId: p.propertyId, utilityType: 'water',
      billingMethod: 'rubs', rubsAllocationMethod: 'occupant_count',
    })
    await client.query(
      `INSERT INTO utility_bills
         (meter_id, unit_id, tenant_id, landlord_id, service_agreement_id, billing_cycle_month,
          charge_amount, utility_type, allocation_method, status, paid_at, reading_end_date)
       VALUES ($1, $2, $3, $4, $5, '2026-10-01', 24.50, 'water', 'occupant_count', 'paid', now(), '2026-10-28')`,
      [waterMaster, p.unitId, p.tenantId, p.landlordId, saId])

    await answer(client, p, bookingId, { choice: 'no_refund' })
    const rec = await recordMoneyKeptOnDeparture({
      landlordId: p.landlordId, ref: { bookingId },
      propertyId: p.propertyId, unitId: p.unitId, client,
    })
    expect(rec.paidBillsLeftAlone).toBe(0)
    expect(rec.why).not.toContain('already paid')
  })
})

describe('two departures on one site in one month — the key that matters', () => {
  let p: Park
  let client: PoolClient

  afterEach(() => { client?.release() })

  beforeEach(async () => {
    await cleanupAllSchema()
    client = await getClient()
    p = await park(client)
  })

  it('both are recorded, and neither overwrites the other', async () => {
    // The old owner-use key was (meter, unit, cycle month): these two would
    // have collided and the park would have been short one departure, silently.
    const first = await stay(client, p, {
      checkIn: '2026-10-01', leftOn: '2026-10-10', bookedThrough: '2026-10-31', guest: 'Victor Cardoza',
    })
    await answer(client, p, first, { choice: 'no_refund', leftOn: '2026-10-10' })
    const second = await stay(client, p, {
      checkIn: '2026-10-12', leftOn: '2026-10-25', bookedThrough: '2026-11-12', guest: 'Nemesio Rivera',
    })
    await answer(client, p, second, { choice: 'no_refund', leftOn: '2026-10-25' })

    const a = await recordMoneyKeptOnDeparture({
      landlordId: p.landlordId, ref: { bookingId: first },
      propertyId: p.propertyId, unitId: p.unitId, client,
    })
    const b = await recordMoneyKeptOnDeparture({
      landlordId: p.landlordId, ref: { bookingId: second },
      propertyId: p.propertyId, unitId: p.unitId, client,
    })
    expect(a.washId).not.toBe(b.washId)

    await settleFinalStubForDeparture({
      ...stub(p, { bookingId: first }, { chargeAmount: 40.11, readingStartDate: '2026-10-01', readingEndDate: '2026-10-10' }),
      client,
    })
    await settleFinalStubForDeparture({
      ...stub(p, { bookingId: second }, { chargeAmount: 81.27, readingStartDate: '2026-10-12', readingEndDate: '2026-10-25' }),
      client,
    })

    const rows = await absorbed(p.landlordId)
    expect(rows).toHaveLength(2)
    expect(rows.map(r => r.charge_amount)).toEqual([40.11, 81.27])
    expect(new Set(rows.map(r => r.wash_id)).size).toBe(2)

    // ...and the report shows the park what it actually ate in October.
    const pairs = await washPairing(p.landlordId, {}, client)
    expect(pairs).toHaveLength(2)
    expect(pairs.reduce((s, r) => s + r.utilityAbsorbed, 0)).toBe(121.38)
  })

  it('one departure still cannot be written twice on the same meter', async () => {
    const bookingId = await stay(client, p)
    await answer(client, p, bookingId, { choice: 'no_refund' })
    const rec = await recordMoneyKeptOnDeparture({
      landlordId: p.landlordId, ref: { bookingId },
      propertyId: p.propertyId, unitId: p.unitId, client,
    })
    await expect(client.query(
      `INSERT INTO utility_absorbed_charges
         (meter_id, unit_id, landlord_id, utility_type, billing_cycle_month, charge_amount, reason, wash_id)
       VALUES ($1, $2, $3, 'electric', '2026-11-01', 81.27, 'early_departure_wash', $4)`,
      [p.meterId, p.unitId, p.landlordId, rec.washId])).resolves.toBeTruthy()
    // A SECOND row for the same departure and meter is refused even in a
    // different month — one departure, one final stub per meter.
    await expect(client.query(
      `INSERT INTO utility_absorbed_charges
         (meter_id, unit_id, landlord_id, utility_type, billing_cycle_month, charge_amount, reason, wash_id)
       VALUES ($1, $2, $3, 'electric', '2026-12-01', 10, 'early_departure_wash', $4)`,
      [p.meterId, p.unitId, p.landlordId, rec.washId])).rejects.toThrow(/duplicate key/)
  })

  it('a second wash on the same booking is refused outright', async () => {
    const bookingId = await stay(client, p)
    await answer(client, p, bookingId, { choice: 'no_refund' })
    await recordMoneyKeptOnDeparture({
      landlordId: p.landlordId, ref: { bookingId },
      propertyId: p.propertyId, unitId: p.unitId, client,
    })
    await expect(client.query(
      `INSERT INTO early_departure_washes
         (landlord_id, property_id, unit_id, booking_id, departed_on, paid_through, amount_kept)
       VALUES ($1, $2, $3, $4, '2026-10-18', '2026-11-04', 51)`,
      [p.landlordId, p.propertyId, p.unitId, bookingId])).rejects.toThrow(/duplicate key/)
  })
})

describe('unwinding a wash', () => {
  let p: Park
  let client: PoolClient

  afterEach(() => { client?.release() })

  beforeEach(async () => {
    await cleanupAllSchema()
    client = await getClient()
    p = await park(client)
  })

  it('a check-out undone takes the absorbed power back off the book', async () => {
    const bookingId = await stay(client, p)
    await answer(client, p, bookingId, { choice: 'no_refund' })
    await recordMoneyKeptOnDeparture({
      landlordId: p.landlordId, ref: { bookingId },
      propertyId: p.propertyId, unitId: p.unitId, client,
    })
    await settleFinalStubForDeparture({ ...stub(p, { bookingId }), client })
    expect(await absorbed(p.landlordId)).toHaveLength(1)

    const un = await unwindWash({
      landlordId: p.landlordId, ref: { bookingId }, reason: 'checkout_undone', client,
    })
    expect(un.unwound).toBe(true)
    expect(un.releasedAbsorptions).toBe(1)
    expect(await absorbed(p.landlordId)).toHaveLength(0)
    // The row is KEPT and stamped — GAM never erases — and stops counting.
    const w = (await client.query<any>(
      `SELECT unwound_at, unwound_reason FROM early_departure_washes WHERE id = $1`, [un.washId])).rows[0]
    expect(w.unwound_at).toBeTruthy()
    expect(w.unwound_reason).toBe(WASH_UNWIND_REASON_LABEL.checkout_undone)
    expect(await washPairing(p.landlordId, {}, client)).toHaveLength(0)
    // ...and the stub bills normally from here.
    const after = await washVerdict({ bookingId }, p.landlordId, client)
    expect(after.verdict).toBe('bill')
  })

  it('a refund issued after the fact unwinds it and records what went back', async () => {
    const bookingId = await stay(client, p)
    await answer(client, p, bookingId, { choice: 'no_refund' })
    await recordMoneyKeptOnDeparture({
      landlordId: p.landlordId, ref: { bookingId },
      propertyId: p.propertyId, unitId: p.unitId, client,
    })
    await settleFinalStubForDeparture({ ...stub(p, { bookingId }), client })

    const un = await unwindWash({
      landlordId: p.landlordId, ref: { bookingId }, reason: 'refund_issued', refundAmount: 51, client,
    })
    expect(un.unwound).toBe(true)
    expect(un.releasedAbsorptions).toBe(1)
    const w = (await client.query<any>(
      `SELECT refund_given, refund_amount::float AS refund_amount FROM early_departure_washes WHERE id = $1`,
      [un.washId])).rows[0]
    expect(w.refund_given).toBe(true)
    expect(w.refund_amount).toBe(51)

    const settled = await settleFinalStubForDeparture({ ...stub(p, { bookingId }), client })
    expect(settled.outcome).toBe('bill_normally')
  })

  it('unwinding releases a stub that was only held', async () => {
    const bookingId = await stay(client, p)
    await answer(client, p, bookingId, { choice: null })
    await settleFinalStubForDeparture({ ...stub(p, { bookingId }), client })
    const un = await unwindWash({
      landlordId: p.landlordId, ref: { bookingId }, reason: 'checkout_undone', client,
    })
    expect(un.releasedStubs).toHaveLength(1)
    expect(un.releasedStubs[0].chargeAmount).toBe(81.27)
    expect(await openWashHolds(p.landlordId, { bookingId }, client)).toHaveLength(0)
  })

  it('unwinds a wash whose stub was PARKED first, and hands that stub back to bill', async () => {
    // The ordering the hold exists for, then undone: the closing read landed
    // before the money answer, so the stub was parked and later absorbed when
    // the desk said no refund. A refund after that has to come back through
    // here, and the hold still pointing at the absorbed line is the part that
    // has to be let go of first.
    const bookingId = await stay(client, p)
    await answer(client, p, bookingId, { choice: null })
    expect((await settleFinalStubForDeparture({ ...stub(p, { bookingId }), client })).outcome).toBe('held')

    await client.query(
      `UPDATE stay_checkout_decisions SET choice = 'no_refund', status = 'decided', decided_at = now()
        WHERE booking_id = $1`, [bookingId])
    const rec = await recordMoneyKeptOnDeparture({
      landlordId: p.landlordId, ref: { bookingId },
      propertyId: p.propertyId, unitId: p.unitId, client,
    })
    expect(rec.absorbedHolds).toBe(1)
    expect(await absorbed(p.landlordId)).toHaveLength(1)

    // ...and then the money goes back after all.
    const un = await unwindWash({
      landlordId: p.landlordId, ref: { bookingId }, reason: 'refund_issued', refundAmount: 51, client,
    })
    expect(un.unwound).toBe(true)
    expect(un.releasedAbsorptions).toBe(1)
    expect(await absorbed(p.landlordId)).toHaveLength(0)
    // The stub is owed again, and comes back with everything needed to bill it.
    expect(un.releasedStubs).toHaveLength(1)
    expect(un.releasedStubs[0].chargeAmount).toBe(81.27)
    expect(un.releasedStubs[0].readingEnd).toBe(1387)
    // The hold is on nobody's book and is not still waiting either: closed,
    // with the words that closed it.
    expect(await openWashHolds(p.landlordId, { bookingId }, client)).toHaveLength(0)
    const holds = (await client.query<any>(
      `SELECT absorbed_at, absorbed_charge_id, released_at, released_reason
         FROM utility_wash_holds WHERE booking_id = $1`, [bookingId])).rows
    expect(holds).toHaveLength(1)
    expect(holds[0].absorbed_at).toBeNull()
    expect(holds[0].absorbed_charge_id).toBeNull()
    expect(holds[0].released_at).toBeTruthy()
    expect(holds[0].released_reason).toBe(WASH_UNWIND_REASON_LABEL.refund_issued)
    // The next run bills it, rather than parking it a second time.
    expect((await settleFinalStubForDeparture({ ...stub(p, { bookingId }), client })).outcome).toBe('bill_normally')
  })

  it('and the billing gate takes a parked-then-absorbed stub off the book without falling over', async () => {
    // Same stale answer as the test above this one, but reached through the
    // gate — which runs on its own transaction inside the property's utility
    // run, so a throw here does not fail one departure, it fails the whole
    // property's billing.
    const bookingId = await stay(client, p)
    await answer(client, p, bookingId, { choice: null })
    await settleFinalStubForDeparture({ ...stub(p, { bookingId }), client })
    await client.query(
      `UPDATE stay_checkout_decisions SET choice = 'no_refund', status = 'decided', decided_at = now()
        WHERE booking_id = $1`, [bookingId])
    await recordMoneyKeptOnDeparture({
      landlordId: p.landlordId, ref: { bookingId },
      propertyId: p.propertyId, unitId: p.unitId, client,
    })
    expect(await absorbed(p.landlordId)).toHaveLength(1)

    await client.query(
      `UPDATE early_departure_washes SET refund_given = true, refund_amount = 51
        WHERE booking_id = $1`, [bookingId])
    const settled = await settleFinalStubForDeparture({ ...stub(p, { bookingId }), client })
    expect(settled.outcome).toBe('bill_normally')
    expect(await absorbed(p.landlordId)).toHaveLength(0)
  })

  it('the billing gate itself takes a stale absorption off the book', async () => {
    // The answer can change without this module hearing about it — a decision
    // edited straight in the database, a lane that answers elsewhere. If the
    // gate returned "bill it" while the absorbed row still sat on the book,
    // that power would be counted twice: once billed, once absorbed.
    const bookingId = await stay(client, p)
    await answer(client, p, bookingId, { choice: 'no_refund' })
    await recordMoneyKeptOnDeparture({
      landlordId: p.landlordId, ref: { bookingId },
      propertyId: p.propertyId, unitId: p.unitId, client,
    })
    await settleFinalStubForDeparture({ ...stub(p, { bookingId }), client })
    expect(await absorbed(p.landlordId)).toHaveLength(1)

    await client.query(
      `UPDATE early_departure_washes SET refund_given = true, refund_amount = 51
        WHERE booking_id = $1`, [bookingId])
    const settled = await settleFinalStubForDeparture({ ...stub(p, { bookingId }), client })
    expect(settled.outcome).toBe('bill_normally')
    expect(await absorbed(p.landlordId)).toHaveLength(0)
  })

  it('a reason that is not one of the two is refused', async () => {
    await expect(unwindWash({
      landlordId: p.landlordId, ref: { bookingId: randomUUID() },
      reason: 'because_i_said_so' as any, client,
    })).rejects.toThrow(WashInputError)
  })
})

describe('landlord scoping: each sees only their own', () => {
  let client: PoolClient

  afterEach(() => { client?.release() })

  beforeEach(async () => {
    await cleanupAllSchema()
    client = await getClient()
  })

  it('another landlord cannot read, record against, or unwind this departure', async () => {
    const mine = await park(client)
    const theirs = await park(client)
    const bookingId = await stay(client, mine)
    await answer(client, mine, bookingId, { choice: 'no_refund' })
    const rec = await recordMoneyKeptOnDeparture({
      landlordId: mine.landlordId, ref: { bookingId },
      propertyId: mine.propertyId, unitId: mine.unitId, client,
    })
    await settleFinalStubForDeparture({ ...stub(mine, { bookingId }), client })
    expect(rec.isWash).toBe(true)

    // The other landlord sees nothing of it.
    const theirView = await washVerdict({ bookingId }, theirs.landlordId, client)
    expect(theirView.verdict).toBe('undecided')
    expect(theirView.washId).toBeNull()
    expect(theirView.why).toContain('not on this landlord')
    expect(await moneyKeptForDeparture({ bookingId }, theirs.landlordId, client)).toBeNull()
    expect(await washPairing(theirs.landlordId, {}, client)).toHaveLength(0)
    expect(await openWashHolds(theirs.landlordId, undefined, client)).toHaveLength(0)

    // A space that belongs to somebody else is refused outright, rather than a
    // wash being pinned onto it (gam-foreign-ref-write-scope).
    await expect(recordMoneyKeptOnDeparture({
      landlordId: mine.landlordId, ref: { bookingId },
      propertyId: theirs.propertyId, unitId: theirs.unitId, client,
    })).rejects.toThrow(WashInputError)

    // ...and cannot undo it.
    const un = await unwindWash({
      landlordId: theirs.landlordId, ref: { bookingId }, reason: 'checkout_undone', client,
    })
    expect(un.unwound).toBe(false)
    expect(un.releasedAbsorptions).toBe(0)
    expect(await absorbed(mine.landlordId)).toHaveLength(1)

    // The owner still sees their own.
    expect(await washPairing(mine.landlordId, {}, client)).toHaveLength(1)
  })

  it('the pairing read filters by property and by the days asked for', async () => {
    const p = await park(client)
    const other = await seedProperty(client, {
      landlordId: p.landlordId, ownerUserId: p.userId, managedByUserId: p.userId })
    const bookingId = await stay(client, p)
    await answer(client, p, bookingId, { choice: 'no_refund' })
    await recordMoneyKeptOnDeparture({
      landlordId: p.landlordId, ref: { bookingId },
      propertyId: p.propertyId, unitId: p.unitId, client,
    })
    expect(await washPairing(p.landlordId, { propertyId: other }, client)).toHaveLength(0)
    expect(await washPairing(p.landlordId, { propertyId: p.propertyId }, client)).toHaveLength(1)
    expect(await washPairing(p.landlordId, { from: '2026-11-01' }, client)).toHaveLength(0)
    expect(await washPairing(p.landlordId, { from: '2026-10-01', to: '2026-10-31' }, client)).toHaveLength(1)
  })
})

/**
 * The reversal and the billing gate are one test asked at two moments — the
 * gate on a stub about to be billed, the void on one already billed when the
 * money answer lands late. Anything the gate bills ON PURPOSE has to survive
 * the void, and anything the gate would have absorbed has to come back. These
 * hold the two halves of that to each other.
 */
describe('the void takes back ONLY what the gate would have absorbed', () => {
  let p: Park
  let client: PoolClient

  afterEach(() => { client?.release() })

  beforeEach(async () => {
    await cleanupAllSchema()
    client = await getClient()
    p = await park(client)
  })

  /** The stay's own utility agreement, which is what its bills hang off. */
  const agreement = async (bookingId: string): Promise<string> =>
    (await client.query<{ id: string }>(
      `INSERT INTO utility_service_agreements (landlord_id, unit_id, tenant_id, booking_id, start_date, end_date)
       VALUES ($1, $2, $3, $4, '2026-10-04', '2026-10-18') RETURNING id`,
      [p.landlordId, p.unitId, p.tenantId, bookingId])).rows[0].id

  const billOnAgreement = async (saId: string, o: {
    meterId?: string; utilityType?: string; cycle: string; amount: number
    allocationMethod: string | null; readingEndDate: string | null
  }): Promise<string> =>
    (await client.query<{ id: string }>(
      `INSERT INTO utility_bills
         (meter_id, unit_id, tenant_id, landlord_id, service_agreement_id, billing_cycle_month,
          charge_amount, utility_type, status, allocation_method, reading_end_date)
       VALUES ($1, $2, $3, $4, $5, $6::date, $7, $8, 'billed', $9, $10::date)
       RETURNING id`,
      [o.meterId ?? p.meterId, p.unitId, p.tenantId, p.landlordId, saId, o.cycle,
       o.amount, o.utilityType ?? 'electric', o.allocationMethod, o.readingEndDate])).rows[0].id

  const statusOf = async (billId: string): Promise<string> =>
    (await client.query<{ status: string }>(
      `SELECT status FROM utility_bills WHERE id = $1`, [billId])).rows[0].status

  it('a POOLED RUBS share keeps standing — the gate bills it on purpose, so the wash never ate it', async () => {
    // RV 11's shape: in 10/04, out 10/18, booked through 11/04, $51 kept.
    const bookingId = await stay(client, p)
    const saId = await agreement(bookingId)
    // The park's water is a master with no submeter on the spaces — Oak Park's
    // 21 water spaces are exactly this — so this guest's water is a slice of a
    // pool, dated by the MASTER's month-end read, not by anything of theirs.
    const waterMeterId = await seedUtilityMeter(client, {
      propertyId: p.propertyId, utilityType: 'water',
      billingMethod: 'rubs', rubsAllocationMethod: 'occupant_count',
    })
    await client.query(
      `INSERT INTO utility_meter_units (meter_id, unit_id) VALUES ($1, $2)`, [waterMeterId, p.unitId])

    const septemberElectric = await billOnAgreement(saId, {
      cycle: '2026-09-01', amount: 44.10, allocationMethod: 'submeter', readingEndDate: '2026-10-04' })
    const pooledWater = await billOnAgreement(saId, {
      meterId: waterMeterId, utilityType: 'water', cycle: '2026-10-01', amount: 18.42,
      allocationMethod: 'occupant_count', readingEndDate: '2026-10-31' })
    const finalElectric = await billOnAgreement(saId, {
      cycle: '2026-10-01', amount: 81.27, allocationMethod: 'submeter', readingEndDate: '2026-10-18' })

    await answer(client, p, bookingId, { choice: 'no_refund' })
    const rec = await recordMoneyKeptOnDeparture({
      landlordId: p.landlordId, ref: { bookingId },
      propertyId: p.propertyId, unitId: p.unitId, client,
    })
    expect(rec.isWash).toBe(true)

    // ONE bill came back: their own closing read.
    expect(rec.reversedBills).toBe(1)
    expect(await statusOf(finalElectric)).toBe('void')
    // September's span ended on the 4th, before they left — a bill they
    // received and owe. Forgiving it would be a write-off, not a wash.
    expect(await statusOf(septemberElectric)).toBe('billed')
    // And the water share stays on their account, because the neighbors were
    // split against it. Voiding it took a real receivable off the books with no
    // absorbed row behind it — billed to nobody and recorded nowhere, which is
    // the one failure this whole feature exists to prevent.
    expect(await statusOf(pooledWater)).toBe('billed')

    const book = await absorbed(p.landlordId)
    expect(book).toHaveLength(1)
    expect(book[0].charge_amount).toBe(81.27)
    const water = (await client.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM utility_absorbed_charges WHERE meter_id = $1`,
      [waterMeterId])).rows[0]
    expect(Number(water.n)).toBe(0)

    // The report's two halves still line up: $51 kept against the $81.27 of
    // power, and nothing of the water in either column.
    const pairs = await washPairing(p.landlordId, {}, client)
    expect(pairs).toHaveLength(1)
    expect(pairs[0].moneyKept).toBe(51)
    expect(pairs[0].utilityAbsorbed).toBe(81.27)
  })

  it("a final stub whose read carries no date still comes back — the gate dates it to the cycle's end", async () => {
    const bookingId = await stay(client, p)
    const saId = await agreement(bookingId)
    // A read entered with no date on it: the gate reads that span as running to
    // the end of the cycle and absorbs it, so the void has to find the same
    // bill. Dating it to the FIRST of the month instead left it sitting on the
    // guest's account after the landlord had agreed to eat it.
    const dateless = await billOnAgreement(saId, {
      cycle: '2026-10-01', amount: 63.40, allocationMethod: 'submeter', readingEndDate: null })

    await answer(client, p, bookingId, { choice: 'no_refund' })
    const rec = await recordMoneyKeptOnDeparture({
      landlordId: p.landlordId, ref: { bookingId },
      propertyId: p.propertyId, unitId: p.unitId, client,
    })
    expect(rec.reversedBills).toBe(1)
    expect(await statusOf(dateless)).toBe('void')
    const book = await absorbed(p.landlordId)
    expect(book).toHaveLength(1)
    expect(book[0].charge_amount).toBe(63.40)
  })
})

// ─── Letting a hold go is billing it ────────────────────────────────────────

/**
 * 10/20 (review) — THE PARKED STUB THAT WENT NOWHERE.
 *
 * Releasing a hold stamped released_at, handed the stub back and trusted the
 * caller to bill it. Nobody was that caller. The desk answering "Refund the
 * unused nights" reaches unwindWash through earlyCheckOut applyDecision, which
 * throws the return value away — so the closing read was let go into thin air:
 * no utility_bills row, because the gate had already reported the stub as not
 * billed and never ran its insert; no absorbed row, because a refund means it
 * is not a wash; and off openWashHolds, which lists only holds still waiting.
 *
 * "If we're keeping track of electric that's not billed back, we need to count
 * that there" — and this was electric that was neither billed nor counted.
 *
 * The shape is RV 10's: $589 for the month, out at 14 nights, 387 kWh on the
 * closing read, and a live utility service agreement on the site.
 */
describe('a hold that is let go is BILLED in the same breath', () => {
  let p: Park
  let client: PoolClient

  afterEach(() => { client?.release() })

  beforeEach(async () => {
    await cleanupAllSchema()
    client = await getClient()
    p = await park(client)
  })

  /** The agreement a 30+ night stay pays its site's utilities through. */
  const agreementOn = async (bookingId: string): Promise<string> =>
    (await client.query<{ id: string }>(
      `INSERT INTO utility_service_agreements
         (landlord_id, unit_id, tenant_id, booking_id, start_date, end_date)
       VALUES ($1, $2, $3, $4, '2026-10-04', '2026-10-18') RETURNING id`,
      [p.landlordId, p.unitId, p.tenantId, bookingId])).rows[0].id

  const bills = async () =>
    (await client.query<any>(
      `SELECT id, charge_amount::float AS charge_amount, usage_amount::float AS usage_amount,
              status, tenant_id, lease_id, service_agreement_id, utility_type, notes,
              to_char(billing_cycle_month, 'YYYY-MM-DD') AS cycle,
              to_char(reading_end_date, 'YYYY-MM-DD') AS read_to
         FROM utility_bills WHERE landlord_id = $1 ORDER BY utility_type`, [p.landlordId])).rows

  const holds = async () =>
    (await client.query<any>(
      `SELECT utility_type, released_at IS NOT NULL AS released, released_reason, released_bill_id,
              absorbed_at IS NOT NULL AS absorbed
         FROM utility_wash_holds WHERE landlord_id = $1 ORDER BY utility_type`, [p.landlordId])).rows

  it('THE DEFECT: the refund that releases a parked stub bills it', async () => {
    const bookingId = await stay(client, p)
    const saId = await agreementOn(bookingId)
    // The clerk who checked them out has no "Issue refunds", so the money
    // question waits — and the closing read arrives first.
    await answer(client, p, bookingId, { choice: null })
    expect((await settleFinalStubForDeparture({ ...stub(p, { bookingId }), client })).outcome).toBe('held')
    expect(await bills()).toHaveLength(0)

    // Somebody who can refund answers: give back the unused nights. This is the
    // call applyDecision makes, and it discards what comes back.
    const un = await unwindWash({
      landlordId: p.landlordId, ref: { bookingId }, reason: 'refund_issued', refundAmount: 51, client,
    })
    expect(un.releasedStubs).toHaveLength(1)

    // The power is on their account instead of nowhere.
    const out = await bills()
    expect(out).toHaveLength(1)
    expect(out[0].charge_amount).toBe(81.27)
    expect(out[0].usage_amount).toBe(387)
    expect(out[0].utility_type).toBe('electric')
    expect(out[0].cycle).toBe('2026-10-01')
    expect(out[0].read_to).toBe('2026-10-18')
    expect(out[0].status).toBe('unbilled')
    expect(out[0].tenant_id).toBe(p.tenantId)
    // The payer the gate had already settled on: a stay pays through its
    // agreement, and utility_bills carries one payer or the other, never both.
    expect(out[0].service_agreement_id).toBe(saId)
    expect(out[0].lease_id).toBeNull()

    // ...and the hold names the bill it became, the way a released invite hold
    // does (suspended_utility_charges.released_bill_id).
    expect(un.releasedStubs[0].billId).toBe(out[0].id)
    const h = await holds()
    expect(h).toHaveLength(1)
    expect(h[0]).toMatchObject({ released: true, absorbed: false, released_bill_id: out[0].id })
    expect(h[0].released_reason).toBe(WASH_UNWIND_REASON_LABEL.refund_issued)
    // A refund went back, so nobody ate it: the absorbed book stays empty.
    expect(await absorbed(p.landlordId)).toHaveLength(0)
    expect(await openWashHolds(p.landlordId, { bookingId }, client)).toHaveLength(0)
  })

  it('the money answer landing on a recorded wash bills what it releases too', async () => {
    const bookingId = await stay(client, p)
    const saId = await agreementOn(bookingId)
    await answer(client, p, bookingId, { choice: null })
    await settleFinalStubForDeparture({ ...stub(p, { bookingId }), client })

    await client.query(
      `UPDATE stay_checkout_decisions SET choice = 'refund_unused', status = 'decided',
              refund_total = 51, decided_at = now() WHERE booking_id = $1`, [bookingId])
    const rec = await recordMoneyKeptOnDeparture({
      landlordId: p.landlordId, ref: { bookingId },
      propertyId: p.propertyId, unitId: p.unitId, client,
    })
    expect(rec.isWash).toBe(false)
    expect(rec.releasedStubs).toHaveLength(1)

    const out = await bills()
    expect(out).toHaveLength(1)
    expect(out[0].charge_amount).toBe(81.27)
    expect(out[0].service_agreement_id).toBe(saId)
    expect(rec.releasedStubs[0].billId).toBe(out[0].id)
    // The bill says why it arrived late, because the guest reads it.
    expect(out[0].notes).toContain('held while that question was open')
  })

  it('a wash undone AFTER the stub was absorbed bills it back out of the hold', async () => {
    const bookingId = await stay(client, p)
    await agreementOn(bookingId)
    await answer(client, p, bookingId, { choice: null })
    expect((await settleFinalStubForDeparture({ ...stub(p, { bookingId }), client })).outcome).toBe('held')

    // "No refund" absorbs it out of the hold and onto the book...
    await client.query(
      `UPDATE stay_checkout_decisions SET choice = 'no_refund', status = 'decided', decided_at = now()
        WHERE booking_id = $1`, [bookingId])
    expect((await recordMoneyKeptOnDeparture({
      landlordId: p.landlordId, ref: { bookingId },
      propertyId: p.propertyId, unitId: p.unitId, client,
    })).absorbedHolds).toBe(1)
    expect(await bills()).toHaveLength(0)

    // ...and then the money goes back after all, so it is owed again — which
    // means billed, not merely taken off the book.
    const un = await unwindWash({
      landlordId: p.landlordId, ref: { bookingId }, reason: 'refund_issued', refundAmount: 51, client,
    })
    expect(un.releasedAbsorptions).toBe(1)
    expect(await absorbed(p.landlordId)).toHaveLength(0)
    const out = await bills()
    expect(out).toHaveLength(1)
    expect(out[0].charge_amount).toBe(81.27)
    expect(un.releasedStubs[0].billId).toBe(out[0].id)
    expect((await holds())[0]).toMatchObject({ released: true, absorbed: false, released_bill_id: out[0].id })
  })

  it('the stub the billing run has in hand is left to the run; everything else parked is billed here', async () => {
    const bookingId = await stay(client, p)
    await agreementOn(bookingId)
    const waterId = await seedUtilityMeter(client, {
      propertyId: p.propertyId, utilityType: 'water', billingMethod: 'submeter' })
    await client.query(`INSERT INTO utility_meter_units (meter_id, unit_id) VALUES ($1, $2)`, [waterId, p.unitId])
    await answer(client, p, bookingId, { choice: null })

    // Both closing reads land while the question waits.
    await settleFinalStubForDeparture({ ...stub(p, { bookingId }), client })
    await settleFinalStubForDeparture({ ...stub(p, { bookingId },
      { meterId: waterId, utilityType: 'water', chargeAmount: 18.40, usageAmount: 2.4, ratePerUnit: 7.67 }), client })
    expect(await openWashHolds(p.landlordId, { bookingId }, client)).toHaveLength(2)

    // A refund goes out, and the property's utility run comes back round to the
    // ELECTRIC stub — which it has in hand and inserts itself the moment the
    // gate says 'bill_normally', with its own fresher numbers.
    await client.query(
      `UPDATE stay_checkout_decisions SET choice = 'refund_unused', status = 'decided',
              refund_total = 51, decided_at = now() WHERE booking_id = $1`, [bookingId])
    expect((await settleFinalStubForDeparture({ ...stub(p, { bookingId }), client })).outcome).toBe('bill_normally')

    // So the electric hold names no bill of its own — one insert, not two
    // fighting over utility_bills_one_per_meter_unit_cycle — and the water,
    // which no run is looking at, is billed right here.
    const h = await holds()
    expect(h.map(r => r.utility_type)).toEqual(['electric', 'water'])
    expect(h.every(r => r.released)).toBe(true)
    expect(h[0].released_bill_id).toBeNull()
    const out = await bills()
    expect(out).toHaveLength(1)
    expect(out[0].utility_type).toBe('water')
    expect(out[0].charge_amount).toBe(18.40)
    expect(h[1].released_bill_id).toBe(out[0].id)
  })

  it('a LEASE move-out never parks its final stub — it bills, and this path never touches it', async () => {
    // 10/20 (Nic): a lease is an agreed amount for an agreed time, so a tenant
    // who leaves early still owes it and their final utility is theirs to pay.
    // The wash machinery therefore has NOTHING to decide about a lease: the
    // closing read does not wait on a money answer, is never absorbed, and is
    // billed by the ordinary path (utilityBilling.tryInsertBill, which puts it
    // on the lease — the payer utility_bills carries for a tenancy).
    //
    // Before this rule the stub parked here waiting on the desk, which meant a
    // departing tenant's last power bill could sit unissued indefinitely while
    // nobody realized a question was owed.
    const leaseId = await seedLease(client, {
      unitId: p.unitId, landlordId: p.landlordId, status: 'expired' })
    await client.query(`UPDATE leases SET end_date = '2026-10-18' WHERE id = $1`, [leaseId])
    await client.query(
      `INSERT INTO lease_tenants (lease_id, tenant_id, role) VALUES ($1, $2, 'primary')`,
      [leaseId, p.tenantId])

    expect((await washVerdict({ leaseId }, p.landlordId, client)).verdict).toBe('bill')
    expect((await settleFinalStubForDeparture({ ...stub(p, { leaseId }), client })).outcome)
      .toBe('bill_normally')
    // Nothing parked, nothing absorbed, and no bill written from here — the
    // ordinary billing path owns it.
    expect(await holds()).toHaveLength(0)
    expect(await absorbed(p.landlordId)).toHaveLength(0)
    expect(await bills()).toHaveLength(0)

    // Even once the desk answers, with money kept, it stays the tenant's.
    const rec = await recordMoneyKeptOnDeparture({
      landlordId: p.landlordId, ref: { leaseId },
      propertyId: p.propertyId, unitId: p.unitId, tenantId: p.tenantId,
      departedOn: '2026-10-18', paidThrough: '2026-10-31',
      amountKept: 420, refundGiven: false, client,
    })
    expect(rec.isWash).toBe(false)
    expect(rec.washId).toBeNull()
    expect(rec.releasedStubs).toHaveLength(0)
    expect(await absorbed(p.landlordId)).toHaveLength(0)
  })

  it('a second run over the same departure does not bill it twice', async () => {
    const bookingId = await stay(client, p)
    await agreementOn(bookingId)
    await answer(client, p, bookingId, { choice: null })
    await settleFinalStubForDeparture({ ...stub(p, { bookingId }), client })
    await unwindWash({
      landlordId: p.landlordId, ref: { bookingId }, reason: 'refund_issued', refundAmount: 51, client,
    })
    const first = await bills()
    expect(first).toHaveLength(1)

    // The hold is closed, so a second pass finds nothing to let go of, and the
    // one bill stands.
    const again = await unwindWash({
      landlordId: p.landlordId, ref: { bookingId }, reason: 'refund_issued', refundAmount: 51, client,
    })
    expect(again.releasedStubs).toHaveLength(0)
    expect((await bills()).map(b => b.id)).toEqual([first[0].id])
  })
})
