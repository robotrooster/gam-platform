/**
 * S641 (Nic) — "Oak Park is showing twenty two dollars and Mountain View is
 * showing zero. Why are they different? They shouldn't be different in terms of
 * one being no charge."
 *
 * They were not different. The dashboard computed the fee for ONE entity while
 * listing properties across EVERY entity on the account, so any property under
 * a different company fell through `feeMap.get(id) ?? 0` and reported nothing.
 * Mountain View's 25 billable units quoted $0 instead of $50 — the card whose
 * whole job is to say what the account owes, understating it.
 *
 * S633 in one line: reads span the account, writes name the company.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { db } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedLease } from '../test/dbHelpers'
import { platformFeesByProperty, platformFeesByPropertyForEntities, periodMonths } from './platformFee'

beforeEach(async () => { await cleanupAllSchema() })

const MONTHS = periodMonths(new Date().getFullYear(), new Date().getMonth() + 1)

/** One account, two companies, a property under each. */
async function twoEntityAccount() {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const a = await seedLandlord(c)
    // second company, SAME human
    const b = await c.query<{ id: string }>(
      `INSERT INTO landlords (user_id, business_name, billing_starts_at)
       VALUES ($1, 'Second Company LLC', date_trunc('month', now())) RETURNING id`, [a.userId])
    await c.query(`UPDATE landlords SET billing_starts_at = date_trunc('month', now()) WHERE id = $1`, [a.landlordId])

    const mk = async (landlordId: string, name: string, units: number) => {
      const propertyId = await seedProperty(c, { landlordId, ownerUserId: a.userId, managedByUserId: a.userId })
      await c.query(`UPDATE properties SET name=$2 WHERE id=$1`, [propertyId, name])
      for (let i = 0; i < units; i++) {
        const unitId = await seedUnit(c, { propertyId, landlordId })
        await c.query(`UPDATE units SET status='active' WHERE id=$1`, [unitId])
        await seedLease(c, { unitId, landlordId, startDate: '2025-01-01' })
      }
      return propertyId
    }
    const first  = await mk(a.landlordId, 'First Park', 11)
    const second = await mk(b.rows[0].id, 'Second Park', 25)
    await c.query('COMMIT')
    return { userId: a.userId, entityA: a.landlordId, entityB: b.rows[0].id, first, second }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

describe('platform fee across an account with two companies', () => {
  it('the single-entity call cannot see the other company — the bug', async () => {
    const w = await twoEntityAccount()
    const fees = await platformFeesByProperty(w.entityA, MONTHS)
    expect(fees.get(w.first)).toBeGreaterThan(0)
    // this is what made Mountain View read $0 on the dashboard
    expect(fees.get(w.second)).toBeUndefined()
  })

  it('the account-wide call prices BOTH properties', async () => {
    const w = await twoEntityAccount()
    const fees = await platformFeesByPropertyForEntities([w.entityA, w.entityB], MONTHS)
    expect(fees.get(w.first)).toBeGreaterThan(0)
    expect(fees.get(w.second)).toBeGreaterThan(0)
  })

  it('neither property is silently free', async () => {
    const w = await twoEntityAccount()
    const fees = await platformFeesByPropertyForEntities([w.entityA, w.entityB], MONTHS)
    for (const id of [w.first, w.second]) {
      expect(fees.get(id) ?? 0, `property ${id} priced at zero`).toBeGreaterThan(0)
    }
  })

  it('the bigger property costs more — the fee follows the units', async () => {
    const w = await twoEntityAccount()
    const fees = await platformFeesByPropertyForEntities([w.entityA, w.entityB], MONTHS)
    expect(fees.get(w.second)!).toBeGreaterThan(fees.get(w.first)!)
  })
})
