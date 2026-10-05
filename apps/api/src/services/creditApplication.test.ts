/**
 * S607 → S655 — services/creditApplication is now a thin wrapper over the
 * whole-bill rule (creditUse.settleWholeBillIfCovered), kept for the bill run
 * and the portal charge until they call the rule themselves (Steps 7 and 8),
 * deleted in Step 18.
 *
 * Nic (10/2): credit applies by itself only when it covers the WHOLE bill.
 * The S638 rule ("posting a credit changes no charge") still holds for a credit
 * smaller than the bill; what a credit route does after issuing one is the
 * route's own test (routes/tenantCredits.test.ts, Step 7).
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { db } from '../db'
import {
  cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedTenant,
  seedLease, seedLeaseTenant, seedAllocationRule,
} from '../test/dbHelpers'
import { applyCreditsToOpenCharges } from './creditApplication'

beforeEach(async () => { await cleanupAllSchema() })

async function seedLeaseWithCharges(charges: number[]) {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const { userId, landlordId } = await seedLandlord(c)
    const propertyId = await seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: userId })
    await seedAllocationRule(c, { propertyId, achFeePayer: 'tenant', cardFeePayer: 'tenant' })
    const unitId = await seedUnit(c, { propertyId, landlordId })
    const tenantId = await seedTenant(c)
    const leaseId = await seedLease(c, { unitId, landlordId, status: 'active' })
    await seedLeaseTenant(c, { leaseId, tenantId, role: 'primary' })
    let day = 1
    for (const amt of charges) {
      await c.query(
        `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description)
         VALUES ($1,$2,$3,$4,'late_fee',$5,'pending', DATE '2026-09-01' + ($6::int), 'LATEFEE')`,
        [unitId, leaseId, tenantId, landlordId, amt, day++])
    }
    await c.query('COMMIT')
    return { leaseId, tenantId, landlordId, unitId }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

const openBalance = async (leaseId: string) => Number((await db.query<{ t: string }>(
  `SELECT COALESCE(SUM(amount),0)::text AS t FROM payments
    WHERE lease_id = $1 AND status = 'pending'`, [leaseId])).rows[0].t)

async function apply(leaseId: string) {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const r = await applyCreditsToOpenCharges(c, { leaseId, scope: 'lease' })
    await c.query('COMMIT')
    return r
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

const credit = (landlordId: string, tenantId: string, leaseId: string | null, amount: number) => db.query(
  `INSERT INTO tenant_credits (landlord_id, tenant_id, lease_id, amount_original, amount_remaining, category)
   VALUES ($1,$2,$3,$4,$4,'goodwill')`, [landlordId, tenantId, leaseId, amount])

describe('the wrapper delegates to the whole-bill rule', () => {
  it('a credit smaller than the whole bill changes no charge and stays whole (Kim Harland)', async () => {
    const f = await seedLeaseWithCharges([25, 5, 5])
    await credit(f.landlordId, f.tenantId, f.leaseId, 30)
    expect(await apply(f.leaseId)).toEqual({ applied: 0, rowsTouched: 0 })
    // The charges stand: nothing settled, nothing split, nothing invented.
    expect(await openBalance(f.leaseId)).toBeCloseTo(35, 2)
    const settled = await db.query(`SELECT 1 FROM payments WHERE lease_id = $1 AND status <> 'pending'`, [f.leaseId])
    expect(settled.rowCount).toBe(0)
    expect(Number((await db.query(`SELECT amount_remaining FROM tenant_credits`)).rows[0].amount_remaining)).toBe(30)
    expect((await db.query(`SELECT 1 FROM credit_uses`)).rowCount).toBe(0)
  })

  it('a credit covering the whole bill settles every row, through the credit ledger', async () => {
    const f = await seedLeaseWithCharges([25, 5, 5])
    await credit(f.landlordId, f.tenantId, f.leaseId, 50)
    expect(await apply(f.leaseId)).toEqual({ applied: 35, rowsTouched: 3 })
    expect(await openBalance(f.leaseId)).toBe(0)
    expect(Number((await db.query(`SELECT amount_remaining FROM tenant_credits`)).rows[0].amount_remaining)).toBe(15)
    const uses = await db.query<any>(`SELECT source, status, SUM(amount)::float AS a FROM credit_uses GROUP BY 1, 2`)
    expect(uses.rows).toEqual([{ source: 'whole_bill', status: 'applied', a: 35 }])
  })

  // S648 (Nic): "every dollar should only be counted once." A general
  // (lease-less) credit is spent by the lease it covers, once, and only the
  // issuing landlord's.
  it('a general credit is spent by the lease it covers, once', async () => {
    const f = await seedLeaseWithCharges([40])
    await credit(f.landlordId, f.tenantId, null, 50)
    expect((await apply(f.leaseId)).applied).toBe(40)
    expect((await apply(f.leaseId)).applied).toBe(0)
    const left = (await db.query(`SELECT amount_remaining::float AS a FROM tenant_credits WHERE tenant_id=$1`, [f.tenantId])).rows[0].a
    expect(left).toBe(10)
  })

  it('a general credit never crosses to another landlord', async () => {
    const f = await seedLeaseWithCharges([40])
    const other = await (async () => {
      const c = await db.connect()
      try { return (await seedLandlord(c)).landlordId } finally { c.release() }
    })()
    await credit(other, f.tenantId, null, 50)
    expect((await apply(f.leaseId)).applied).toBe(0)
  })

  it('a lease with nothing open is a clean no-op', async () => {
    const f = await seedLeaseWithCharges([])
    await credit(f.landlordId, f.tenantId, f.leaseId, 100)
    expect(await apply(f.leaseId)).toEqual({ applied: 0, rowsTouched: 0 })
  })
})
