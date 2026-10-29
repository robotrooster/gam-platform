/**
 * 10/20 (Nic) — THE BILLING GATE ASKS WHETHER A FINAL STUB IS A WASH.
 *
 *   "We don't refund the money, but we also don't bill them a final electric
 *    bill. We need to still get the meter reads to close it out and count that
 *    as ... electric that's not billed back ... but it doesn't need to get
 *    attached to anything."
 *
 * services/earlyDepartureWash owns the rule; these hold utilityBilling's
 * tryInsertBill to the three things it has to get right about it:
 *   - a wash writes NO bill and the power goes on the absorption book instead;
 *   - ONLY the final stub washes, so an earlier cycle of the same guest bills;
 *   - the departure comes from the payer the span was resolved to, never from
 *     "somebody left this site", which is the S548 / S641 bug class — at an RV
 *     park a site turns over the same day and the arrival must never be handed
 *     the guest-before's absorbed power.
 *
 * The shapes are the two live departures that prompted the feature: RV 10 and
 * RV 11 at Mountain View, $589 paid for a month, out at 14 nights, no refund.
 *
 * Run (migration 20261021210000 is not on production yet, so the suite needs to
 * be told to apply it on top of schema.sql):
 *   cd apps/api && DB_NAME=gam_wash_test TEST_DB_NAME=gam_wash_test \
 *   TEST_APPLY_MIGRATIONS_AFTER=20261021170000 \
 *   npx vitest run src/services/utilityBillingWash.test.ts
 */
import { describe, it, expect, beforeEach } from 'vitest'
import type { PoolClient } from 'pg'
import { db, getClient } from '../db'
import {
  cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedTenant,
  seedUtilityMeter, seedLease, seedLeaseTenant,
} from '../test/dbHelpers'
import { tryInsertBill, billMoveOutRead } from './utilityBilling'
import { STAY_SHORTENED_CREDIT_NOTE } from './bookingLeaseBilling'
import { STAY_DEPOSIT_CREDIT_NOTE } from '../jobs/moveInBundle'

type Park = {
  userId: string; landlordId: string; propertyId: string; unitId: string
  meterId: string; tenantId: string
}

/** A park, an RV site, a submeter on it at 12c a unit, and a guest. */
async function park(client: PoolClient): Promise<Park> {
  const { userId, landlordId } = await seedLandlord(client)
  const propertyId = await seedProperty(client, { landlordId, ownerUserId: userId, managedByUserId: userId })
  const unitId = await seedUnit(client, { propertyId, landlordId, unitType: 'rv_spot' })
  const meterId = await seedUtilityMeter(client, { propertyId, utilityType: 'electric', billingMethod: 'submeter' })
  await client.query(
    `UPDATE utility_meters SET rate_per_unit = 0.12, base_fee = 0 WHERE id = $1`, [meterId])
  await client.query(
    `INSERT INTO utility_meter_units (meter_id, unit_id) VALUES ($1, $2)`, [meterId, unitId])
  const tenantId = await seedTenant(client)
  return { userId, landlordId, propertyId, unitId, meterId, tenantId }
}

/** A month-rate stay that pulled out early — the RV 10 shape. */
async function stay(client: PoolClient, p: Park, o: {
  checkIn?: string; leftOn?: string; bookedThrough?: string
  paid?: number; guest?: string; status?: string; tenantId?: string
} = {}): Promise<{ bookingId: string; agreementId: string; tenantId: string }> {
  const checkIn = o.checkIn ?? '2026-10-04'
  const leftOn = o.leftOn ?? '2026-10-18'
  const bookedThrough = o.bookedThrough ?? '2026-11-04'
  const tenantId = o.tenantId ?? p.tenantId
  const bookingId = (await client.query<{ id: string }>(
    `INSERT INTO unit_bookings
       (unit_id, landlord_id, lease_type, status, check_in, check_out, booked_check_out,
        guest_name, total_amount, balance_paid_at)
     VALUES ($1, $2, 'month_to_month', $3, $4::date, $5::date, $6::date, $7, $8, now())
     RETURNING id`,
    [p.unitId, p.landlordId, o.status ?? 'checked_out', checkIn, leftOn, bookedThrough,
     o.guest ?? 'Victor Cardoza', o.paid ?? 589])).rows[0].id
  // A stay that has checked out carries an ENDED agreement, the way stayTerms
  // leaves it — and only one live agreement per site is allowed, which is what
  // lets the next arrival have one of their own.
  const agreementId = (await client.query<{ id: string }>(
    `INSERT INTO utility_service_agreements
       (landlord_id, unit_id, tenant_id, booking_id, start_date, end_date, status)
     VALUES ($1, $2, $3, $4, $5::date, $6::date, $7) RETURNING id`,
    [p.landlordId, p.unitId, tenantId, bookingId, checkIn, leftOn,
     (o.status ?? 'checked_out') === 'checked_out' ? 'ended' : 'active'])).rows[0].id
  return { bookingId, agreementId, tenantId }
}

/**
 * The check-out window's money answer. $589 paid, 14 nights worth $538 on the
 * two-week rate, so $51 was on the table and the desk declined it.
 */
async function answer(client: PoolClient, p: Park, bookingId: string, o: {
  choice?: 'no_refund' | 'refund_unused' | 'refund_other' | 'keep_price' | 'nights_only' | null
  refundTotal?: number; paid?: number; stayedWorth?: number; leftOn?: string
} = {}): Promise<void> {
  const decided = o.choice != null
  await client.query(
    `INSERT INTO stay_checkout_decisions
       (booking_id, landlord_id, left_on, question, choice, status,
        booked_price, stayed_worth, paid, refund_total, decided_at)
     VALUES ($1, $2, $3::date, 'overpaid', $4, $5, $6, $7, $8, $9,
             CASE WHEN $5 = 'decided' THEN now() ELSE NULL END)`,
    [bookingId, p.landlordId, o.leftOn ?? '2026-10-18',
     o.choice ?? null, decided ? 'decided' : 'pending',
     o.paid ?? 589, o.stayedWorth ?? 538, o.paid ?? 589, o.refundTotal ?? 0])
}

/** The closing read's stub, exactly as billMoveOutRead builds it. */
const finalStub = (p: Park, o: { cycle?: string; from?: string; to?: string; usage?: number } = {}) => ({
  meterId: p.meterId, unitId: p.unitId, landlordId: p.landlordId,
  utilityType: 'electric', cycleMonth: o.cycle ?? '2026-10-01',
  usageAmount: o.usage ?? 100, allocationMethod: 'submeter', allocationBasis: null,
  ratePerUnit: 0.12, baseFeeShare: 0, chargeAmount: (o.usage ?? 100) * 0.12,
  taxRatePct: 0, taxAmount: 0,
  readingStart: 1000, readingEnd: 1000 + (o.usage ?? 100),
  readingStartDate: o.from ?? '2026-10-04', readingEndDate: o.to ?? '2026-10-18',
  moveOut: true,
})

const bills = async (p: Park) => (await db.query(
  `SELECT * FROM utility_bills WHERE meter_id = $1 ORDER BY billing_cycle_month`, [p.meterId])).rows
const absorbed = async (p: Park) => (await db.query(
  `SELECT *, to_char(departed_on, 'YYYY-MM-DD') AS departed_day
     FROM utility_absorbed_charges WHERE meter_id = $1`, [p.meterId])).rows
const holds = async (p: Park) => (await db.query(
  `SELECT * FROM utility_wash_holds WHERE meter_id = $1 AND absorbed_at IS NULL AND released_at IS NULL`,
  [p.meterId])).rows

async function inPark<T>(fn: (client: PoolClient, p: Park) => Promise<T>): Promise<T> {
  const client = await getClient()
  try {
    const p = await park(client)
    return await fn(client, p)
  } finally { client.release() }
}

describe('utilityBilling — a departing payer whose money the park kept', () => {
  beforeEach(async () => { await cleanupAllSchema() })

  it('bills NOBODY and records the power instead when they left early and kept no refund', async () => {
    await inPark(async (client, p) => {
      const { bookingId } = await stay(client, p)
      await answer(client, p, bookingId, { choice: 'no_refund' })

      const inserted = await tryInsertBill(finalStub(p))

      // "it doesn't need to get attached to anything"
      expect(inserted).toBe(false)
      expect(await bills(p)).toHaveLength(0)

      const rows = await absorbed(p)
      expect(rows).toHaveLength(1)
      expect(rows[0].reason).toBe('early_departure_wash')
      expect(Number(rows[0].charge_amount)).toBeCloseTo(12, 2)
      expect(rows[0].booking_id).toBe(bookingId)
      expect(rows[0].departed_day).toBe('2026-10-18')
      // The money side is on the book beside it, which is the whole point.
      const wash = (await db.query(
        `SELECT * FROM early_departure_washes WHERE id = $1`, [rows[0].wash_id])).rows[0]
      expect(Number(wash.amount_kept)).toBeCloseTo(51, 2)
      expect(wash.refund_given).toBe(false)
    })
  })

  it('still bills an EARLIER cycle of the same guest', async () => {
    await inPark(async (client, p) => {
      // A 61-night stay booked 9/4 through 11/4, out on 10/18.
      const { bookingId, tenantId } = await stay(client, p, {
        checkIn: '2026-09-04', bookedThrough: '2026-11-04', leftOn: '2026-10-18', paid: 1178,
      })
      await answer(client, p, bookingId, { choice: 'no_refund', paid: 1178, stayedWorth: 1100 })

      // September's span closes 10/01, before they left: their bill, as always.
      const inserted = await tryInsertBill(finalStub(p, {
        cycle: '2026-09-01', from: '2026-09-04', to: '2026-10-01',
      }))
      expect(inserted).toBe(true)
      const rows = await bills(p)
      expect(rows).toHaveLength(1)
      expect(rows[0].tenant_id).toBe(tenantId)
      expect(await absorbed(p)).toHaveLength(0)
      expect(await holds(p)).toHaveLength(0)

      // And the stub that runs to the day they left is the one that washes.
      expect(await tryInsertBill(finalStub(p, { cycle: '2026-10-01', from: '2026-10-01' }))).toBe(false)
      expect(await bills(p)).toHaveLength(1)
      expect(await absorbed(p)).toHaveLength(1)
    })
  })

  it('still bills the NEXT ARRIVAL on a same-day turnover', async () => {
    await inPark(async (client, p) => {
      const { bookingId } = await stay(client, p)
      await answer(client, p, bookingId, { choice: 'no_refund' })
      expect(await tryInsertBill(finalStub(p))).toBe(false)
      expect(await absorbed(p)).toHaveLength(1)

      // A new guest on the same site from the day the last one left.
      const next = await seedTenant(client)
      await stay(client, p, {
        checkIn: '2026-10-18', leftOn: '2026-11-18', bookedThrough: '2026-11-18',
        guest: 'Next Guest', status: 'checked_in', tenantId: next,
      })

      const inserted = await tryInsertBill({
        ...finalStub(p, { cycle: '2026-10-01', from: '2026-10-18', to: '2026-11-01', usage: 40 }),
        moveOut: false,
      })

      expect(inserted).toBe(true)
      const rows = await bills(p)
      expect(rows).toHaveLength(1)
      expect(rows[0].tenant_id).toBe(next)
      expect(Number(rows[0].charge_amount)).toBeCloseTo(4.8, 2)
      // The guest before's wash stayed the guest before's.
      const abs = await absorbed(p)
      expect(abs).toHaveLength(1)
      expect(abs[0].booking_id).toBe(bookingId)
    })
  })

  it('HOLDS the stub while the money question is unanswered, and tells the landlord nothing', async () => {
    await inPark(async (client, p) => {
      const { bookingId } = await stay(client, p)
      // The clerk who checked them out has no "Issue refunds", so the answer waits.
      await answer(client, p, bookingId, { choice: null })

      const inserted = await tryInsertBill(finalStub(p))

      expect(inserted).toBe(false)
      expect(await bills(p)).toHaveLength(0)
      // Not absorbed either: a hold is not an absorption and must never count as one.
      expect(await absorbed(p)).toHaveLength(0)
      const parked = await holds(p)
      expect(parked).toHaveLength(1)
      expect(Number(parked[0].charge_amount)).toBeCloseTo(12, 2)
      expect(parked[0].booking_id).toBe(bookingId)

      // "nobody to bill" would be both wrong and alarming — there IS a payer.
      const told = await db.query(
        `SELECT 1 FROM notifications WHERE landlord_id = $1 AND type = 'utility_usage_unbilled'`,
        [p.landlordId])
      expect(told.rows).toHaveLength(0)
    })
  })

  it('bills normally once a refund has gone out', async () => {
    await inPark(async (client, p) => {
      const { bookingId, tenantId } = await stay(client, p)
      await answer(client, p, bookingId, { choice: 'refund_unused', refundTotal: 51 })

      const inserted = await tryInsertBill(finalStub(p))

      expect(inserted).toBe(true)
      const rows = await bills(p)
      expect(rows).toHaveLength(1)
      expect(rows[0].tenant_id).toBe(tenantId)
      expect(await absorbed(p)).toHaveLength(0)
      expect(await holds(p)).toHaveLength(0)
    })
  })

  it('records the absorbed stub ONCE however often billing re-runs', async () => {
    await inPark(async (client, p) => {
      const { bookingId } = await stay(client, p)
      await answer(client, p, bookingId, { choice: 'no_refund' })

      expect(await tryInsertBill(finalStub(p))).toBe(false)
      expect(await tryInsertBill(finalStub(p))).toBe(false)
      // A later run with the month read instead of the check-out read — the same
      // final stub by a different span, which must not become a second row.
      expect(await tryInsertBill(finalStub(p, { from: '2026-10-01', to: '2026-11-01' }))).toBe(false)

      expect(await absorbed(p)).toHaveLength(1)
      expect(await bills(p)).toHaveLength(0)
      const washes = await db.query(
        `SELECT id FROM early_departure_washes WHERE booking_id = $1`, [bookingId])
      expect(washes.rows).toHaveLength(1)
    })
  })

  it('a FLAT charge on the same departure bills normally — a fee is not a final read', async () => {
    await inPark(async (client, p) => {
      const { bookingId, tenantId } = await stay(client, p)
      await answer(client, p, bookingId, { choice: 'no_refund' })

      const inserted = await tryInsertBill({
        meterId: p.meterId, unitId: p.unitId, landlordId: p.landlordId,
        utilityType: 'electric', cycleMonth: '2026-10-01',
        usageAmount: null, allocationMethod: 'flat_rate', allocationBasis: 1,
        ratePerUnit: 25, baseFeeShare: 25, chargeAmount: 25, taxRatePct: 0,
      })

      expect(inserted).toBe(true)
      expect((await bills(p))[0].tenant_id).toBe(tenantId)
      expect(await absorbed(p)).toHaveLength(0)
      expect(await holds(p)).toHaveLength(0)
    })
  })

  it('a POOLED RUBS share on the same departure bills normally', async () => {
    await inPark(async (client, p) => {
      const { bookingId, tenantId } = await stay(client, p)
      await answer(client, p, bookingId, { choice: 'no_refund' })

      const inserted = await tryInsertBill({
        meterId: p.meterId, unitId: p.unitId, landlordId: p.landlordId,
        utilityType: 'electric', cycleMonth: '2026-10-01',
        usageAmount: null, allocationMethod: 'occupant_count', allocationBasis: 1,
        pooledShare: true, ratePerUnit: 0, baseFeeShare: 0, chargeAmount: 30,
        taxRatePct: 0, readingEndDate: '2026-11-01',
      })

      expect(inserted).toBe(true)
      expect((await bills(p))[0].tenant_id).toBe(tenantId)
      expect(await absorbed(p)).toHaveLength(0)
      expect(await holds(p)).toHaveLength(0)
    })
  })

  it('the closing read taken at the desk washes it — through billMoveOutRead', async () => {
    await inPark(async (client, p) => {
      const { bookingId } = await stay(client, p)
      await answer(client, p, bookingId, { choice: 'no_refund' })
      // The turnover read check-in waits for, then the read at the desk when
      // they pulled out. Neither is the monthly cycle read.
      await client.query(
        `INSERT INTO utility_meter_readings
           (meter_id, reading_date, reading_value, billing_cycle_month, reason, created_by_user_id)
         VALUES ($1, '2026-10-04', 1000, '2026-10-01', 'stay_turnover', $2)`, [p.meterId, p.userId])
      const closing = (await client.query<{ id: string }>(
        `INSERT INTO utility_meter_readings
           (meter_id, reading_date, reading_value, billing_cycle_month, reason, created_by_user_id)
         VALUES ($1, '2026-10-18', 1100, '2026-10-01', 'move_out_final', $2) RETURNING id`,
        [p.meterId, p.userId])).rows[0].id

      const res = await billMoveOutRead(p.meterId, closing)

      expect(res.billed).toBe(false)
      expect(await bills(p)).toHaveLength(0)
      const rows = await absorbed(p)
      expect(rows).toHaveLength(1)
      expect(Number(rows[0].charge_amount)).toBeCloseTo(12, 2)
      expect(Number(rows[0].usage_amount)).toBeCloseTo(100, 2)
    })
  })
})

describe('utilityBilling — a lease move-out', () => {
  beforeEach(async () => { await cleanupAllSchema() })

  it('an ORDINARY move-out is never asked about, so its final read bills', async () => {
    await inPark(async (client, p) => {
      const leaseId = await seedLease(client, {
        unitId: p.unitId, landlordId: p.landlordId, status: 'expired', startDate: '2026-01-01',
      })
      await client.query(`UPDATE leases SET end_date = '2026-10-18' WHERE id = $1`, [leaseId])
      await seedLeaseTenant(client, { leaseId, tenantId: p.tenantId })

      const inserted = await tryInsertBill(finalStub(p, { from: '2026-10-01' }))

      // Nothing was paid past the day they left, so there is nothing to wash —
      // and above all nothing to PARK. A gate that asked about every move-out
      // would hold the final stub of every lease that ever ended.
      expect(inserted).toBe(true)
      expect((await bills(p))[0].lease_id).toBe(leaseId)
      expect(await holds(p)).toHaveLength(0)
      expect(await absorbed(p)).toHaveLength(0)
    })
  })

  it('a long lease drafted from a reservation bills its mid-lease cycles', async () => {
    await inPark(async (client, p) => {
      // The reservation became a year lease. Its check-out day is ten months
      // behind the cycle being billed, and it is NOT the day anybody left.
      const bookingId = (await client.query<{ id: string }>(
        `INSERT INTO unit_bookings
           (unit_id, landlord_id, lease_type, status, check_in, check_out, booked_check_out,
            guest_name, total_amount, balance_paid_at)
         VALUES ($1, $2, 'long_term', 'checked_in', '2026-01-01', '2026-02-01', '2026-02-01',
                 'Long Termer', 589, now()) RETURNING id`,
        [p.unitId, p.landlordId])).rows[0].id
      const leaseId = await seedLease(client, {
        unitId: p.unitId, landlordId: p.landlordId, status: 'active', startDate: '2026-01-01',
      })
      await client.query(
        `UPDATE leases SET end_date = '2026-12-31', source_booking_id = $2 WHERE id = $1`,
        [leaseId, bookingId])
      await seedLeaseTenant(client, { leaseId, tenantId: p.tenantId })
      // Paid-ahead money on the lease, which is what makes the wash question
      // get asked at all — the reservation date must still not answer it.
      await client.query(
        `INSERT INTO lease_prepaid_credits
           (lease_id, tenant_id, amount_original, amount_remaining, funded_by, note)
         VALUES ($1, $2, 589, 589, 'reclassified', $3)`,
        [leaseId, p.tenantId, STAY_SHORTENED_CREDIT_NOTE])

      const inserted = await tryInsertBill(finalStub(p, { from: '2026-10-01' }))

      expect(inserted).toBe(true)
      expect((await bills(p))[0].lease_id).toBe(leaseId)
      expect(await holds(p)).toHaveLength(0)
      expect(await absorbed(p)).toHaveLength(0)
    })
  })

  it("a reservation deposit's LEFTOVER is not somebody leaving early — the final cycle bills", async () => {
    await inPark(async (client, p) => {
      // The shape that parks a stub forever: a lease drafted from a reservation
      // whose deposit came to more than the arrival month's rent. moveInBundle
      // banks the difference as a 'reclassified' credit that stands for the
      // WHOLE tenancy, and the guest then stayed to the last day of the lease.
      // Nobody left early and nothing is on the table, so the one cycle that
      // runs to the lease's own last day must bill like any other.
      const bookingId = (await client.query<{ id: string }>(
        `INSERT INTO unit_bookings
           (unit_id, landlord_id, lease_type, status, check_in, check_out, booked_check_out,
            guest_name, total_amount, balance_paid_at)
         VALUES ($1, $2, 'long_term', 'checked_out', '2026-04-01', '2026-10-31', '2026-10-31',
                 'Full Termer', 589, now()) RETURNING id`,
        [p.unitId, p.landlordId])).rows[0].id
      const leaseId = await seedLease(client, {
        unitId: p.unitId, landlordId: p.landlordId, status: 'expired', startDate: '2026-04-01',
      })
      await client.query(
        `UPDATE leases SET end_date = '2026-10-31', source_booking_id = $2 WHERE id = $1`,
        [leaseId, bookingId])
      await seedLeaseTenant(client, { leaseId, tenantId: p.tenantId })
      await client.query(
        `INSERT INTO lease_prepaid_credits
           (lease_id, tenant_id, amount_original, amount_remaining, funded_by, note)
         VALUES ($1, $2, 37, 37, 'reclassified', $3)`,
        [leaseId, p.tenantId, STAY_DEPOSIT_CREDIT_NOTE])

      const inserted = await tryInsertBill(finalStub(p, { from: '2026-10-01', to: '2026-10-31' }))

      // Parked, this stub is unreachable: nothing releases a hold on a
      // departure the check-out window never wrote a money answer for.
      expect(inserted).toBe(true)
      expect((await bills(p))[0].lease_id).toBe(leaseId)
      expect(await holds(p)).toHaveLength(0)
      expect(await absorbed(p)).toHaveLength(0)
    })
  })

  it('rent paid past a shortened end still BILLS the stub — a lease is owed', async () => {
    // 10/20 (Nic), pushing back on the wash covering a lease: "A lease is an
    // agreed upon amount. They're responsible for that time... If it says
    // they're good through, you know, 2 more months and they leave early and we
    // keep the money, that's money that we're legally entitled to."
    //
    // So rent banked past a shortened end is not a windfall to weigh a power
    // bill against — the tenant contracted for that time. Their final stub is
    // billed to them like any other month, with nothing parked and nobody asked.
    // It used to park here, which also meant a departing tenant's last power
    // bill could sit unissued while nobody knew a question was owed.
    await inPark(async (client, p) => {
      const leaseId = await seedLease(client, {
        unitId: p.unitId, landlordId: p.landlordId, status: 'expired', startDate: '2026-01-01',
      })
      await client.query(`UPDATE leases SET end_date = '2026-10-18' WHERE id = $1`, [leaseId])
      await seedLeaseTenant(client, { leaseId, tenantId: p.tenantId })
      // What bookingLeaseBilling banks when rent was paid past a shortened end —
      // note and all, because the note is what tells it apart from the OTHER
      // reclassified kind, a reservation deposit's leftover.
      await client.query(
        `INSERT INTO lease_prepaid_credits
           (lease_id, tenant_id, amount_original, amount_remaining, funded_by, note)
         VALUES ($1, $2, 589, 589, 'reclassified', $3)`,
        [leaseId, p.tenantId, STAY_SHORTENED_CREDIT_NOTE])

      const inserted = await tryInsertBill(finalStub(p, { from: '2026-10-01' }))

      expect(inserted).toBe(true)
      const out = await bills(p)
      expect(out).toHaveLength(1)
      expect(out[0].lease_id).toBe(leaseId)
      expect(await absorbed(p)).toHaveLength(0)
      expect(await holds(p)).toHaveLength(0)
    })
  })
})
