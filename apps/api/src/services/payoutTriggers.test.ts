/**
 * S616 — paying the landlord sooner without paying Stripe more.
 *
 * Nic: "That's a lot of margin we're giving up on an extra twenty five cent
 * initiation. If we're doing that ten times a month instead of two or three
 * strategic ones per connect account, that's a lot of money... we're processing
 * sixty million dollars a month and spending ten thousand dollars a month on
 * extra processing charges that could be eliminated."
 *
 * "Let's fire a disbursement when it's fifty percent of occupied units paid...
 * and then we do another one at ninety percent... you don't want the landlord
 * being held up by a bunch of rent money for one or two late people."
 *
 * The cap is the feature: three firings per Connect account per cycle, enforced
 * by a unique index rather than by the code that reads it.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { db } from '../db'
import {
  cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedTenant,
  seedLease, seedLeaseTenant,
} from '../test/dbHelpers'
import {
  rollProgressForLandlordUser, claimThresholdIfReached, claimMonthlySweep,
  dueTriggers, markTriggerFired, SETTLE_LEAD_DAYS, hasShortTermActivity,
} from './payoutTriggers'

beforeEach(async () => { await cleanupAllSchema() })

const CYCLE = '2026-03-01'
const TODAY = '2026-03-02'

/** A landlord with `units` occupied units, each owing rent this cycle. */
async function landlordWithRoll(units: number, cycle: string = CYCLE) {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const { userId, landlordId } = await seedLandlord(c)
    const propertyId = await seedProperty(c, {
      landlordId, ownerUserId: userId, managedByUserId: userId,
    })
    const unitIds: string[] = []
    for (let i = 0; i < units; i++) {
      const unitId = await seedUnit(c, { propertyId, landlordId, rentAmount: 500 })
      const tenantId = await seedTenant(c)
      const leaseId = await seedLease(c, {
        unitId, landlordId, status: 'active', rentAmount: 500, startDate: '2026-01-01',
      })
      await seedLeaseTenant(c, { leaseId, tenantId, role: 'primary' })
      await c.query(
        `INSERT INTO payments (landlord_id, tenant_id, lease_id, unit_id, type,
                               entry_description, amount, status, due_date)
         VALUES ($1,$2,$3,$4,'rent','RENT',500,'pending',$5)`,
        [landlordId, tenantId, leaseId, unitId, cycle])
      unitIds.push(unitId)
    }
    await c.query('COMMIT')
    return { userId, landlordId, unitIds }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

/** Mark the first `n` units' rent as paid. */
async function markPaid(unitIds: string[], n: number, status = 'settled') {
  for (const unitId of unitIds.slice(0, n)) {
    await db.query(
      `UPDATE payments SET status = $2 WHERE unit_id = $1 AND type = 'rent'`,
      [unitId, status])
  }
}

describe('rent-roll progress (S616)', () => {
  it('counts money the tenant has SENT, not only what cleared', async () => {
    const f = await landlordWithRoll(10)
    await markPaid(f.unitIds, 3, 'settled')
    await markPaid(f.unitIds.slice(3), 2, 'processing')

    const p = await rollProgressForLandlordUser(f.userId, CYCLE)
    expect(p.unitsTotal).toBe(10)
    // An ACH sits in 'processing' for days AFTER the tenant's bank was debited.
    // Counting only settled money would make every roll look empty in the exact
    // week rent arrives.
    expect(p.unitsPaid).toBe(5)
    expect(p.percentPaid).toBe(50)
  })

  it('an empty roll is 0%, never 100%', async () => {
    const f = await landlordWithRoll(0)
    const p = await rollProgressForLandlordUser(f.userId, CYCLE)
    expect(p.unitsTotal).toBe(0)
    // Reporting an empty roll as complete would trip both thresholds on a
    // landlord who billed nobody.
    expect(p.percentPaid).toBe(0)
  })
})

describe('threshold claiming (S616)', () => {
  it('claims 50% and schedules it four days out', async () => {
    const f = await landlordWithRoll(10)
    await markPaid(f.unitIds, 5)
    const p = await rollProgressForLandlordUser(f.userId, CYCLE)

    const c = await claimThresholdIfReached('user', f.userId, CYCLE, TODAY, p)
    expect(c.claimed).toBe(true)
    expect(c.triggerKind).toBe('threshold_50')
    // Trigger on PAID, fire when it will have settled. Mon Mar 2 + 4 business
    // days = Fri Mar 6 — this window happens to contain no weekend, so it is
    // the one case where the old calendar count agreed.
    expect(c.scheduledFor).toBe('2026-03-06')
    expect(SETTLE_LEAD_DAYS).toBe(4)
  })

  // S617 (Nic): "threshold trigger plus four business days." The lead time was
  // four CALENDAR days while Stripe releases an ACH four BUSINESS days out. A
  // payout scheduled short fires before the money exists, reads an empty
  // balance, and autoPayouts retires the trigger anyway — burning one of the
  // landlord's three monthly payouts on nothing.
  it('steps the lead time over a weekend rather than counting calendar days', async () => {
    const f = await landlordWithRoll(10)
    await markPaid(f.unitIds, 5)
    const p = await rollProgressForLandlordUser(f.userId, CYCLE)

    // March rent, half of it in by Thu 2026-03-05. Four business days is
    // Wed 2026-03-11; the calendar count said Mon 2026-03-09.
    const c = await claimThresholdIfReached('user', f.userId, CYCLE, '2026-03-05', p)
    expect(c.claimed).toBe(true)
    expect(c.scheduledFor).toBe('2026-03-11')
  })

  it('steps the lead time over a federal holiday', async () => {
    // September rent, paid in September — Labor Day falls inside the window.
    const SEPT = '2026-09-01'
    const f = await landlordWithRoll(10, SEPT)
    await markPaid(f.unitIds, 5)
    const p = await rollProgressForLandlordUser(f.userId, SEPT)
    expect(p.percentPaid).toBe(50)

    // Half the roll is in on Wed Sep 2. Labor Day is Mon Sep 7, so four
    // business days is Wed Sep 9. The calendar count said Sun Sep 6 — a day
    // the payout cron does not even run, and two days before Stripe would
    // have released the money.
    const c = await claimThresholdIfReached('user', f.userId, SEPT, '2026-09-02', p)
    expect(c.claimed).toBe(true)
    expect(c.scheduledFor).toBe('2026-09-09')
  })

  it('does not claim below 50%', async () => {
    const f = await landlordWithRoll(10)
    await markPaid(f.unitIds, 4)
    const p = await rollProgressForLandlordUser(f.userId, CYCLE)
    expect((await claimThresholdIfReached('user', f.userId, CYCLE, TODAY, p)).claimed).toBe(false)
  })

  it('claims the same threshold only once a cycle', async () => {
    const f = await landlordWithRoll(10)
    await markPaid(f.unitIds, 6)
    const p = await rollProgressForLandlordUser(f.userId, CYCLE)

    expect((await claimThresholdIfReached('user', f.userId, CYCLE, TODAY, p)).claimed).toBe(true)
    // Running again the next day must not buy a second firing.
    expect((await claimThresholdIfReached('user', f.userId, CYCLE, '2026-03-03', p)).claimed).toBe(false)
  })

  it('a roll that jumps straight past 90% claims the 90, not both', async () => {
    const f = await landlordWithRoll(10)
    await markPaid(f.unitIds, 10)
    const p = await rollProgressForLandlordUser(f.userId, CYCLE)

    const c = await claimThresholdIfReached('user', f.userId, CYCLE, TODAY, p)
    expect(c.triggerKind).toBe('threshold_90')
    // The 50 stays unclaimed rather than burning a second firing on one moment.
    const { rows } = await db.query(
      `SELECT trigger_kind FROM payout_triggers WHERE entity_id = $1`, [f.userId])
    expect(rows).toHaveLength(1)
  })

  it('50 then 90 across the month is two firings, and no more', async () => {
    const f = await landlordWithRoll(10)
    await markPaid(f.unitIds, 5)
    await claimThresholdIfReached('user', f.userId, CYCLE, TODAY,
      await rollProgressForLandlordUser(f.userId, CYCLE))

    await markPaid(f.unitIds, 9)
    await claimThresholdIfReached('user', f.userId, CYCLE, '2026-03-05',
      await rollProgressForLandlordUser(f.userId, CYCLE))

    // …and the last tenant pays, which must NOT buy a third.
    await markPaid(f.unitIds, 10)
    await claimThresholdIfReached('user', f.userId, CYCLE, '2026-03-09',
      await rollProgressForLandlordUser(f.userId, CYCLE))

    const { rows } = await db.query(
      `SELECT trigger_kind FROM payout_triggers WHERE entity_id = $1 ORDER BY trigger_kind`,
      [f.userId])
    expect(rows.map((r: any) => r.trigger_kind)).toEqual(['threshold_50', 'threshold_90'])
  })
})

describe('the cap holds (S616)', () => {
  it('never exceeds three firings per account per cycle', async () => {
    const f = await landlordWithRoll(10)
    // Every weekday of a month, thresholds met, sweep day every time.
    for (let d = 1; d <= 28; d++) {
      const day = `2026-03-${String(d).padStart(2, '0')}`
      await markPaid(f.unitIds, 10)
      const p = await rollProgressForLandlordUser(f.userId, CYCLE)
      await claimThresholdIfReached('user', f.userId, CYCLE, day, p)
      await claimMonthlySweep('user', f.userId, CYCLE, day)
    }
    const { rows } = await db.query(
      `SELECT trigger_kind FROM payout_triggers WHERE entity_id = $1`, [f.userId])
    // Three is the ceiling, and it is the database that enforces it.
    expect(rows.length).toBeLessThanOrEqual(3)
  })

  it('a new cycle gets its own three', async () => {
    const f = await landlordWithRoll(10)
    await markPaid(f.unitIds, 10)
    const p = await rollProgressForLandlordUser(f.userId, CYCLE)
    await claimThresholdIfReached('user', f.userId, CYCLE, TODAY, p)
    await claimMonthlySweep('user', f.userId, CYCLE, '2026-03-24')

    await claimMonthlySweep('user', f.userId, '2026-04-01', '2026-04-21')
    const { rows } = await db.query(
      `SELECT cycle_month FROM payout_triggers WHERE entity_id = $1`, [f.userId])
    expect(rows.length).toBe(3)
  })
})

describe('firing (S616)', () => {
  it('a trigger is due only on or after its scheduled day', async () => {
    const f = await landlordWithRoll(10)
    await markPaid(f.unitIds, 5)
    await claimThresholdIfReached('user', f.userId, CYCLE, TODAY,
      await rollProgressForLandlordUser(f.userId, CYCLE))

    expect(await dueTriggers('2026-03-05')).toHaveLength(0)   // scheduled the 6th
    expect(await dueTriggers('2026-03-06')).toHaveLength(1)
  })

  // A firing that found nothing is not a failure — the tenants paid but Stripe
  // has not released it. It must still be retired, or it re-fires daily and
  // spends the whole cycle budget on empty payouts.
  it('an empty firing is retired, not retried forever', async () => {
    const f = await landlordWithRoll(10)
    await markPaid(f.unitIds, 5)
    await claimThresholdIfReached('user', f.userId, CYCLE, TODAY,
      await rollProgressForLandlordUser(f.userId, CYCLE))

    const [t] = await dueTriggers('2026-03-06')
    await markTriggerFired(t.id, 'zero_balance')
    expect(await dueTriggers('2026-03-07')).toHaveLength(0)

    const { rows } = await db.query(
      `SELECT skipped_reason FROM payout_triggers WHERE id = $1`, [t.id])
    expect(rows[0].skipped_reason).toBe('zero_balance')
  })
})

// S616 (Nic): "leases follow 3 batch plan we made. short term stays follow
// weekly plan." Two revenue shapes, two cadences.
describe('short-term stays keep the weekly cadence (S616)', () => {
  async function bookNightly(landlordId: string, unitId: string,
                             checkIn: string, checkOut: string,
                             status = 'confirmed') {
    await db.query(
      `INSERT INTO unit_bookings (landlord_id, unit_id, lease_type, status,
                                  check_in, check_out, total_amount,
                                  guest_name, guest_email)
       VALUES ($1,$2,'nightly',$3,$4,$5,300,'Guest','g@t.dev')`,
      [landlordId, unitId, status, checkIn, checkOut])
  }

  it('spots a nightly stay overlapping the cycle', async () => {
    const f = await landlordWithRoll(4)
    await bookNightly(f.landlordId, f.unitIds[0], '2026-03-10', '2026-03-14')
    expect(await hasShortTermActivity(f.userId, CYCLE)).toBe(true)
  })

  it('a long-term-only landlord has none', async () => {
    const f = await landlordWithRoll(4)
    expect(await hasShortTermActivity(f.userId, CYCLE)).toBe(false)
  })

  it('a cancelled booking is not activity', async () => {
    const f = await landlordWithRoll(4)
    await bookNightly(f.landlordId, f.unitIds[0], '2026-03-10', '2026-03-14', 'cancelled')
    expect(await hasShortTermActivity(f.userId, CYCLE)).toBe(false)
  })

  it('a stay in another month does not count for this one', async () => {
    const f = await landlordWithRoll(4)
    await bookNightly(f.landlordId, f.unitIds[0], '2026-05-10', '2026-05-14')
    expect(await hasShortTermActivity(f.userId, CYCLE)).toBe(false)
  })

  // Oak Park is exactly this landlord: long-term leases AND 29 of 30 units
  // open to nightly stays. Both streams apply; neither replaces the other.
  it('a MIXED landlord gets both — thresholds for rent, weekly for stays', async () => {
    const f = await landlordWithRoll(10)
    await bookNightly(f.landlordId, f.unitIds[0], '2026-03-10', '2026-03-14')

    await markPaid(f.unitIds, 5)
    const p = await rollProgressForLandlordUser(f.userId, CYCLE)
    const claimed = await claimThresholdIfReached('user', f.userId, CYCLE, TODAY, p)

    expect(claimed.claimed).toBe(true)                            // rent stream
    expect(await hasShortTermActivity(f.userId, CYCLE)).toBe(true) // stay stream
  })

  // Bookings live in unit_bookings and write no payments rows, so they must
  // never move the rent-roll denominator — a nightly guest is not a tenant who
  // owes rent, and counting them would hold the threshold down all month.
  it('bookings do not pollute the rent roll', async () => {
    const f = await landlordWithRoll(4)
    await bookNightly(f.landlordId, f.unitIds[0], '2026-03-10', '2026-03-14')
    const p = await rollProgressForLandlordUser(f.userId, CYCLE)
    expect(p.unitsTotal).toBe(4)
  })
})
