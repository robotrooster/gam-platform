// 10/27 (Nic) — THE COOL-OFF LADDER, COUNTED IN DAYS ON GAM.
//
//   "90 days is a cool-off period before they're re-invited for the first
//    time. After that, the time might be longer. 6 months the second time and
//    a year the third time."
//
// And the part no stored end date can express:
//
//   "If they're 3 months into their year-long cooldown and they switch
//    landlords, that cooldown only counts while they're on GAM. So if they
//    leave GAM for 2 years, they need to be back on GAM for the remaining 9
//    months."
//
// This also pins the reversal of S578: a second default used to end FlexPay
// for good. It now buys a six-month wait instead, so the test that the ban no
// longer gates anything is as important as the ladder itself.

import { describe, it, expect, beforeEach } from 'vitest'
import { db } from '../db'
import { flexPayCooldown, getFlexPayEligibility } from './flexpay'
import { FLEXPAY_COOLDOWN_ON_PLATFORM_DAYS, flexPayCooldownDays, flexPayReentrySurcharge } from '@gam/shared'
import {
  cleanupAllSchema,
  seedLandlord, seedTenant, seedProperty, seedUnit, seedLease, seedLeaseTenant,
} from '../test/dbHelpers'

/**
 * A tenant with a default `defaults` times, stamped `agoDays` ago, holding a
 * lease for the stretches given. Each stretch is [startDaysAgo, endDaysAgo],
 * where a null end means still here.
 */
async function withHistory(o: {
  defaults: number
  agoDays: number
  tenancy: Array<[number, number | null]>
}): Promise<string> {
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    const { userId: ownerUserId, landlordId } = await seedLandlord(client)
    const tenantId = await seedTenant(client)
    const propertyId = await seedProperty(client, { landlordId, ownerUserId, managedByUserId: ownerUserId })
    for (const [from, to] of o.tenancy) {
      const unitId = await seedUnit(client, { propertyId, landlordId, rentAmount: 900 })
      const leaseId = await seedLease(client, {
        unitId, landlordId, rentAmount: 900,
        status: to === null ? 'active' : 'expired',
      })
      await client.query(
        `UPDATE leases
            SET start_date = (CURRENT_DATE - ($2::int || ' days')::interval)::date,
                end_date   = CASE WHEN $3::int IS NULL THEN NULL
                             ELSE (CURRENT_DATE - ($3::int || ' days')::interval)::date END
          WHERE id = $1`,
        [leaseId, from, to])
      await seedLeaseTenant(client, { leaseId, tenantId, role: 'primary' })
    }
    if (o.defaults > 0) {
      await client.query(
        `UPDATE tenants
            SET flexpay_default_count = $2,
                flexpay_cooldown_from = NOW() - ($3::int || ' days')::interval
          WHERE id = $1`,
        [tenantId, o.defaults, o.agoDays])
    }
    await client.query('COMMIT')
    return tenantId
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally { client.release() }
}

beforeEach(cleanupAllSchema)

describe('the rungs', () => {
  it('is 90 days, then six months, then a year', () => {
    expect(FLEXPAY_COOLDOWN_ON_PLATFORM_DAYS).toEqual([90, 182, 365])
    expect(flexPayCooldownDays(1)).toBe(90)
    expect(flexPayCooldownDays(2)).toBe(182)
    expect(flexPayCooldownDays(3)).toBe(365)
  })

  it('stays on the top rung after the third — it does not keep climbing', () => {
    expect(flexPayCooldownDays(4)).toBe(365)
    expect(flexPayCooldownDays(9)).toBe(365)
  })

  it('is nothing at all for somebody who never defaulted', () => {
    expect(flexPayCooldownDays(0)).toBe(0)
  })
})

describe('the clock runs only while they are on GAM', () => {
  it('counts a continuous tenancy as calendar days', async () => {
    // Defaulted 100 days ago and here throughout: the 90 is served.
    const tenantId = await withHistory({ defaults: 1, agoDays: 100, tenancy: [[400, null]] })
    const c = await flexPayCooldown(tenantId)
    expect(c.required_days).toBe(90)
    expect(c.on_platform_days).toBeGreaterThanOrEqual(99)
    expect(c.cleared).toBe(true)
    expect(c.remaining_days).toBe(0)
  })

  it('does NOT count the time they were away', async () => {
    // Defaulted 400 days ago. Left 30 days later, came back 20 days ago. So
    // only ~50 days of tenancy have passed since — the 90 is not served,
    // although more than a year of calendar time has.
    const tenantId = await withHistory({
      defaults: 1, agoDays: 400, tenancy: [[500, 370], [20, null]] })
    const c = await flexPayCooldown(tenantId)
    expect(c.on_platform_days).toBeLessThan(90)
    expect(c.cleared).toBe(false)
    expect(c.remaining_days).toBeGreaterThan(0)
  })

  it('a year of calendar time away serves none of it', async () => {
    // His case exactly: three months served, then gone. The remaining nine
    // months still have to be served HERE.
    const tenantId = await withHistory({
      defaults: 3, agoDays: 900, tenancy: [[950, 860]] })   // 90 days, long ago
    const c = await flexPayCooldown(tenantId)
    expect(c.required_days).toBe(365)
    expect(c.on_platform_days).toBeLessThanOrEqual(91)
    expect(c.remaining_days).toBeGreaterThan(270)
  })

  it('counts two overlapping leases as ONE stretch of time', async () => {
    // A resident holding two spaces at once lived one stretch. Counting both
    // would serve the cool-off in half the days.
    const one = await withHistory({ defaults: 1, agoDays: 60, tenancy: [[200, null]] })
    const two = await withHistory({ defaults: 1, agoDays: 60, tenancy: [[200, null], [200, null]] })
    const a = await flexPayCooldown(one)
    const b = await flexPayCooldown(two)
    expect(b.on_platform_days).toBe(a.on_platform_days)
    expect(b.cleared).toBe(false)   // 60 days of the 90
  })

  it('reports nothing to serve for a tenant who never defaulted', async () => {
    const tenantId = await withHistory({ defaults: 0, agoDays: 0, tenancy: [[300, null]] })
    const c = await flexPayCooldown(tenantId)
    expect(c).toMatchObject({ defaults: 0, required_days: 0, remaining_days: 0, cleared: true, since: null })
  })
})

describe('what eligibility does with it', () => {
  it('holds a tenant off while the wait is unserved', async () => {
    const tenantId = await withHistory({ defaults: 2, agoDays: 30, tenancy: [[300, null]] })
    const e = await getFlexPayEligibility(tenantId)
    expect(e.blockers).toContain('tenant_suspended_nsf')
    // The date shown is DERIVED — the earliest it could end if they stay.
    expect(e.suspended_until).not.toBeNull()
  })

  it('lets them through once it is served', async () => {
    const tenantId = await withHistory({ defaults: 1, agoDays: 200, tenancy: [[400, null]] })
    const e = await getFlexPayEligibility(tenantId)
    expect(e.blockers).not.toContain('tenant_suspended_nsf')
  })

  it('no longer bans anybody for good — S578 is reversed', async () => {
    // The flag is still written as a record that a 2nd default happened, and
    // must no longer gate anything: a 2nd default buys six months, not a
    // permanent end.
    const tenantId = await withHistory({ defaults: 2, agoDays: 400, tenancy: [[500, null]] })
    await db.query(`UPDATE tenants SET flexpay_permanently_banned = TRUE WHERE id = $1`, [tenantId])
    const e = await getFlexPayEligibility(tenantId)
    expect(e.blockers).not.toContain('tenant_suspended_nsf')
    expect(JSON.stringify(e.blockers)).not.toContain('banned')
  })
})

describe('what a second chance costs', () => {
  it('is the ordinary price the first time back', () => {
    // "they can get back on at the same price the first time. I get that
    // things happen. Maybe somebody had an issue with their bank."
    expect(flexPayReentrySurcharge(0)).toBe(0)
    expect(flexPayReentrySurcharge(1)).toBe(0)
  })

  it('is $5 more on every price point from the second time', () => {
    expect(flexPayReentrySurcharge(2)).toBe(5)
    expect(flexPayReentrySurcharge(3)).toBe(5)
    expect(flexPayReentrySurcharge(7)).toBe(5)
  })
})
