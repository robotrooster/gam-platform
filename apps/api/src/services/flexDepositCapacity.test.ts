/**
 * 10/26 (Nic) — THE FLEXDEPOSIT CEILING.
 *
 *   "We have to be careful about how many people we can onboard on that at a
 *    time. That needs to be scoped to some sort of capacity limit. So we don't
 *    get freaking 500 people sign up tomorrow that we cannot realistically
 *    [serve]."
 *
 * What is rationed is not cash — under custody GAM floats nothing — but the
 * number of UNFUNDED deposits GAM carries for landlords at once, each one a
 * conversation if the tenant stops. So a plan count and the total still
 * uncollected, either of which closes the door.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { db, query } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedTenant, seedLease } from '../test/dbHelpers'
import { flexDepositCapacity } from './flexDeposit'

beforeEach(async () => {
  await cleanupAllSchema()
  await query(`DELETE FROM flexdeposit_capacity`)
})

const setCap = (plans: number | null, uncollected: number | null) => query(
  `INSERT INTO flexdeposit_capacity (id, max_active_plans, max_uncollected, note)
   VALUES (TRUE, $1, $2, 'test')
   ON CONFLICT (id) DO UPDATE SET max_active_plans = $1, max_uncollected = $2`,
  [plans, uncollected])

/** An active FlexDeposit plan with `total` owed and `collected` paid in. */
async function plan(total: number, collected: number) {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const ll = await seedLandlord(c)
    const propertyId = await seedProperty(c, { landlordId: ll.landlordId, ownerUserId: ll.userId, managedByUserId: ll.userId })
    const unitId = await seedUnit(c, { propertyId, landlordId: ll.landlordId })
    const tenantId = await seedTenant(c)
    const leaseId = await seedLease(c, { unitId, landlordId: ll.landlordId, rentAmount: 600 })
    await c.query(
      `INSERT INTO security_deposits
         (tenant_id, lease_id, unit_id, total_amount, collected_amount, status,
          flex_deposit_enabled, flex_deposit_plan_status, held_by)
       VALUES ($1,$2,$3,$4,$5,'partial',TRUE,'active','gam_escrow')`,
      [tenantId, leaseId, unitId, total, collected])
    await c.query('COMMIT')
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e } finally { c.release() }
}

describe('room for another plan', () => {
  it('has room when nothing is running', async () => {
    await setCap(10, 15000)
    const cap = await flexDepositCapacity()
    expect(cap).toMatchObject({ room: true, activePlans: 0, uncollected: 0 })
  })

  it('counts active plans and sums only what is STILL UNCOLLECTED', async () => {
    await setCap(10, 15000)
    await plan(1200, 300)   // 900 outstanding
    await plan(900, 900)    // fully funded — nothing outstanding
    const cap = await flexDepositCapacity()
    expect(cap.activePlans).toBe(2)
    expect(cap.uncollected).toBe(900)
    expect(cap.room).toBe(true)
  })

  it('closes at the plan ceiling — AT the limit there is no room for one more', async () => {
    await setCap(2, null)
    await plan(600, 0)
    expect((await flexDepositCapacity()).room).toBe(true)
    await plan(600, 0)
    const cap = await flexDepositCapacity()
    expect(cap.activePlans).toBe(2)
    expect(cap.room).toBe(false)
  })

  it('closes on uncollected dollars even when the plan count is fine', async () => {
    await setCap(100, 1000)
    await plan(1200, 0)
    const cap = await flexDepositCapacity()
    expect(cap.uncollected).toBe(1200)
    expect(cap.room).toBe(false)
  })

  it('a NULL limit does not apply', async () => {
    await setCap(null, null)
    for (let i = 0; i < 3; i++) await plan(2000, 0)
    expect((await flexDepositCapacity()).room).toBe(true)
  })

  it('a cancelled or finished plan frees its room back up', async () => {
    await setCap(1, null)
    await plan(600, 0)
    expect((await flexDepositCapacity()).room).toBe(false)
    await query(`UPDATE security_deposits SET flex_deposit_plan_status = 'completed'`)
    expect((await flexDepositCapacity()).room).toBe(true)
  })

  it('an over-collected deposit never counts as negative room', async () => {
    // GREATEST(...,0): a deposit collected past its total must not create
    // headroom that lets an extra plan through.
    await setCap(100, 500)
    await plan(600, 900)
    await plan(600, 0)
    const cap = await flexDepositCapacity()
    expect(cap.uncollected).toBe(600)
    expect(cap.room).toBe(false)
  })

  it('no capacity row at all means unlimited, not zero', async () => {
    // A missing row must not silently shut the product off.
    for (let i = 0; i < 2; i++) await plan(2000, 0)
    const cap = await flexDepositCapacity()
    expect(cap.maxActivePlans).toBeNull()
    expect(cap.room).toBe(true)
  })

  it('only one capacity row can exist', async () => {
    await setCap(5, null)
    await expect(query(
      `INSERT INTO flexdeposit_capacity (id, max_active_plans) VALUES (FALSE, 99)`))
      .rejects.toThrow()
  })
})
