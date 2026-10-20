/**
 * A STAY'S UTILITY AGREEMENT CARRIES NO LATE FEE. EVER.
 *
 * 10/20 (Nic), asked whether to re-stamp RV 10 and RV 11 with Mountain View's
 * real RV policy instead of the $15 they carry: "It's gone, but they paid when
 * they arrived, so why would there ever be a late fee? Stays are paid ahead of
 * time, so they should never have late fees. It's not the same as a lease.
 * Stays are paid for the duration at the time they show up. That's the whole
 * distinction we made with somebody that didn't want a lease but wanted to stay
 * 6 months. They would have to pay for 6 months all up front."
 *
 * So the answer was not "the right fee" — it was NO fee. A stay is money in
 * hand on arrival; there is no debt for a penalty to sit on.
 *
 * Two doors mint a utility service agreement and they now answer differently,
 * which is the thing these tests hold down. The register selling a stay of
 * 30-plus nights stamps no fee. The landlord-facing door — a serviced space
 * with no stay behind it, the neighbor GAM supplies power to, billed month
 * after month with nothing paid up front — keeps the per-unit-type policy, and
 * has its own suite. `booking_id` is what tells them apart.
 *
 * This door had no test on its late-fee terms at all, which is how the $15
 * nobody chose reached two real instruments: the earlier fix went in on the
 * door that was tested and the door that caused it was never asserted on. The
 * same shape bit the space-rent carry-forward the same morning — 21 tests green
 * before and after, not one of them covering an RV spot.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { randomUUID } from 'crypto'

import { db, getClient } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit } from '../test/dbHelpers'
import { syncStayUtilityAgreement } from './stayTerms'

beforeEach(async () => {
  await cleanupAllSchema()
})

interface Park { landlordId: string; userId: string; propertyId: string; unitId: string }

/** An RV park with one site, built the way Mountain View is. */
async function park(opts: { lateFeesOn?: boolean } = {}): Promise<Park> {
  const c = await getClient()
  try {
    await c.query('BEGIN')
    const { userId, landlordId } = await seedLandlord(c)
    const propertyId = await seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: userId })
    await c.query(`UPDATE properties SET late_fee_enabled = $2 WHERE id = $1`,
      [propertyId, opts.lateFeesOn ?? true])
    const unitId = await seedUnit(c, { propertyId, landlordId, rentAmount: 589, unitType: 'rv_spot' })
    await c.query('COMMIT')
    return { landlordId, userId, propertyId, unitId }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

/**
 * Mountain View's own recorded rv_spot policy, read out of production on
 * 10/20: five days of grace, nothing to start, then $5 a day counted from the
 * due date itself. A lease on this site would be drafted with exactly this —
 * and a stay still gets none of it.
 */
async function recordMountainViewPolicy(propertyId: string): Promise<void> {
  await db.query(
    `INSERT INTO property_unit_type_late_fees
       (property_id, unit_type, no_late_fee, late_fee_grace_days,
        late_fee_initial_amount, late_fee_initial_type,
        late_fee_accrual_amount, late_fee_accrual_type, late_fee_accrual_period,
        late_fee_accrual_from)
     VALUES ($1, 'rv_spot', FALSE, 5, 0.00, 'flat', 5.00, 'flat', 'daily', 'due_date_inclusive')`,
    [propertyId])
}

/** The figures the old code copied: a schema default nobody chose. */
async function putTheDeadDefaultsBack(propertyId: string): Promise<void> {
  await db.query(
    `UPDATE properties
        SET late_fee_grace_days = 5, late_fee_initial_amount = 15.00, late_fee_initial_type = 'flat'
      WHERE id = $1`, [propertyId])
}

/** A stay of 31 nights, sold as a stay rather than a lease. */
async function thirtyOneNightStay(p: Park): Promise<string> {
  const { rows: [b] } = await db.query<{ id: string }>(
    `INSERT INTO unit_bookings
       (unit_id, landlord_id, guest_name, guest_email, check_in, check_out, status,
        lease_type, total_amount, stay_terms)
     VALUES ($1, $2, 'Long Stayer', $3, CURRENT_DATE, CURRENT_DATE + 31, 'confirmed',
             'month_to_month', 589, 'stay')
     RETURNING id`,
    [p.unitId, p.landlordId, `stay-${randomUUID().slice(0, 6)}@test.dev`])
  return b.id
}

interface Stamp {
  enabled: boolean
  grace: number | null
  initial: string | null
  initial_type: string
  accrual: string | null
  accrual_type: string | null
  accrual_period: string | null
  cap: string | null
  booking_id: string | null
}

async function stampOn(bookingId: string): Promise<Stamp> {
  const { rows } = await db.query<Stamp>(
    `SELECT late_fee_enabled                 AS enabled,
            late_fee_grace_days              AS grace,
            late_fee_initial_amount::text    AS initial,
            late_fee_initial_type            AS initial_type,
            late_fee_accrual_amount::text    AS accrual,
            late_fee_accrual_type            AS accrual_type,
            late_fee_accrual_period          AS accrual_period,
            late_fee_cap_amount::text        AS cap,
            booking_id
       FROM utility_service_agreements WHERE booking_id = $1`, [bookingId])
  expect(rows, 'the stay should have minted a utility service agreement').toHaveLength(1)
  return rows[0]
}

/** No fee at all: the switch off and every figure empty. */
function expectNoFee(s: Stamp): void {
  expect(s.enabled).toBe(false)
  expect(s.grace).toBeNull()
  expect(s.initial).toBeNull()
  expect(s.accrual).toBeNull()
  expect(s.accrual_type).toBeNull()
  expect(s.accrual_period).toBeNull()
  expect(s.cap).toBeNull()
  // NOT NULL in the schema, so it has to say something. With no amount behind
  // it the engine writes nothing (jobs/lateFees qualifyingInvoicesSql), so the
  // agreement is inert rather than fineable-looking.
  expect(s.initial_type).toBe('flat')
}

describe('a stay of 30+ nights is never given a late fee', () => {
  it('stamps no fee even where the park HAS a recorded policy for that space', async () => {
    // The load-bearing one. A lease on this exact site would be drafted with
    // $0 + $5/day; the stay gets nothing, because the guest already paid for
    // their whole time on arrival.
    const p = await park()
    await recordMountainViewPolicy(p.propertyId)
    const b = await thirtyOneNightStay(p)

    expect((await syncStayUtilityAgreement(b, { byUserId: p.userId })).action).toBe('created')

    const s = await stampOn(b)
    expectNoFee(s)
    expect(s.booking_id, 'a stay agreement is the one with a booking behind it').toBe(b)
  })

  it('stamps no fee when nobody recorded a policy either', async () => {
    const p = await park()
    const b = await thirtyOneNightStay(p)
    expect((await syncStayUtilityAgreement(b, { byUserId: p.userId })).action).toBe('created')
    expectNoFee(await stampOn(b))
  })

  it('stamps no fee when the park has late fees switched off', async () => {
    const p = await park({ lateFeesOn: false })
    await recordMountainViewPolicy(p.propertyId)
    const b = await thirtyOneNightStay(p)
    expect((await syncStayUtilityAgreement(b, { byUserId: p.userId })).action).toBe('created')
    expectNoFee(await stampOn(b))
  })

  it('never reads the property columns — the RV 10 and RV 11 regression', async () => {
    // THE ACTUAL BUG. Both live agreements carry a $15 flat fee with a 5-day
    // grace that came from the property row and from nowhere a human ever
    // typed. Put those figures back, record the real policy beside them, and
    // the agreement has to ignore both.
    const p = await park()
    await putTheDeadDefaultsBack(p.propertyId)
    await recordMountainViewPolicy(p.propertyId)
    const b = await thirtyOneNightStay(p)

    expect((await syncStayUtilityAgreement(b, { byUserId: p.userId })).action).toBe('created')

    const s = await stampOn(b)
    expect(s.initial, 'the $15 came off the property row; it must not be here').not.toBe('15.00')
    expectNoFee(s)
  })

  it('and with no policy recorded, the property columns still cannot leak in', async () => {
    const p = await park()
    await putTheDeadDefaultsBack(p.propertyId)
    const b = await thirtyOneNightStay(p)
    expect((await syncStayUtilityAgreement(b, { byUserId: p.userId })).action).toBe('created')
    expectNoFee(await stampOn(b))
  })
})
