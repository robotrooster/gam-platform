/**
 * S637 — what the per-property platform fee actually is, month by month.
 *
 * Nic: "we're showing a twenty dollar flat platform fee for three occupied
 * units for Oak Park... it would be six dollars, but our minimum property
 * amount is ten dollars, so it should be showing ten dollars. Mountain View
 * RV is showing eight people, which should be sixteen dollars, but it's
 * showing twenty six."
 *
 * The arithmetic was right and the READING was the problem — the tab opened
 * on the full year, so both figures were running totals. These pin the
 * per-month numbers so the distinction is a fact in the suite rather than
 * something to re-derive by hand next time it looks wrong.
 *
 * The floor is per CONNECT PAYOUT ACCOUNT (S630), not per property, so a
 * landlord with two small properties owes $10 between them, not $10 each.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { db } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedTenant, seedLease } from '../test/dbHelpers'
import { platformFeesByProperty, periodMonths } from './platformFee'

let landlordId: string, propId: string

async function occupy(count: number, startDate: string) {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    for (let i = 0; i < count; i++) {
      const unitId = await seedUnit(c, { propertyId: propId, landlordId })
      const tenantId = await seedTenant(c)
      const leaseId = await seedLease(c, { unitId, landlordId, status: 'active', startDate })
      await c.query(`UPDATE leases SET end_date = NULL WHERE id = $1`, [leaseId])
      void tenantId
    }
    await c.query('COMMIT')
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

beforeEach(async () => {
  await cleanupAllSchema()
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const l = await seedLandlord(c)
    landlordId = l.landlordId
    propId = await seedProperty(c, { landlordId, ownerUserId: l.userId, managedByUserId: l.userId })
    await c.query(`UPDATE properties SET created_at = '2026-08-01' WHERE id = $1`, [propId])
    // S637: past the onboarding grace, so these months are billable at all.
    // The grace rule itself is covered separately below.
    await c.query(`UPDATE landlords SET billing_starts_at = '2026-08-01' WHERE id = $1`, [landlordId])
    await c.query('COMMIT')
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
})

describe('platform fee for one month', () => {
  it('floors three occupied units at the $10 minimum, not $6', async () => {
    await occupy(3, '2026-08-01')
    const fees = await platformFeesByProperty(landlordId, ['2026-09-01'])
    expect(fees.get(propId)).toBe(10)
  })

  it('charges $2 a unit once that clears the floor — eight is $16', async () => {
    await occupy(8, '2026-08-01')
    const fees = await platformFeesByProperty(landlordId, ['2026-09-01'])
    expect(fees.get(propId)).toBe(16)
  })
})

describe('a full-year figure is a RUNNING TOTAL, not a monthly charge', () => {
  it('sums each month — three units across Aug+Sep is $20, not $10', async () => {
    await occupy(3, '2026-08-01')
    const fees = await platformFeesByProperty(landlordId, ['2026-08-01', '2026-09-01'])
    expect(fees.get(propId)).toBe(20)
  })

  it('an EMPTY August adds nothing — the $26 Nic saw was a phantom floor', async () => {
    // The tenancies begin 1 September, so August had nobody in a spot. It used
    // to be floored to $10 regardless, which is where Mountain View's \$26 came
    // from: \$10 for a month it had no tenants, plus September's \$16. Under
    // S631 an empty month bills nothing, so the running total is just \$16.
    await occupy(8, '2026-09-01')
    const fees = await platformFeesByProperty(landlordId, ['2026-08-01', '2026-09-01'])
    expect(fees.get(propId)).toBe(16)
  })
})

describe('periodMonths is what decides which of the two you get', () => {
  it('a named month is exactly one month', () => {
    expect(periodMonths(2026, 9, new Date('2026-09-15'))).toEqual(['2026-09-01'])
  })

  it('no month means every elapsed month of the year', () => {
    expect(periodMonths(2026, null, new Date('2026-09-15'))).toHaveLength(9)
  })
})


describe('S637 onboarding grace and the "only when money moves" floor', () => {
  it('bills nothing while the landlord is still in grace', async () => {
    await occupy(3, '2026-08-01')
    await db.query(`UPDATE landlords SET billing_starts_at = NULL WHERE id = $1`, [landlordId])
    const fees = await platformFeesByProperty(landlordId, ['2026-09-01'])
    expect(fees.get(propId) ?? 0).toBe(0)
  })

  it('bills nothing for months before billing began', async () => {
    await occupy(3, '2026-08-01')
    await db.query(`UPDATE landlords SET billing_starts_at = '2026-09-01' WHERE id = $1`, [landlordId])
    expect(await platformFeesByProperty(landlordId, ['2026-08-01']).then(f => f.get(propId) ?? 0)).toBe(0)
    expect(await platformFeesByProperty(landlordId, ['2026-09-01']).then(f => f.get(propId) ?? 0)).toBe(10)
  })

  it('does NOT floor a month with nothing occupied — S631', async () => {
    // No leases at all. The floor is what a transacting account pays when
    // $2/unit lands under $10, never a subscription for an empty record.
    await db.query(`UPDATE landlords SET billing_starts_at = '2026-08-01' WHERE id = $1`, [landlordId])
    const fees = await platformFeesByProperty(landlordId, ['2026-09-01'])
    expect(fees.get(propId) ?? 0).toBe(0)
  })
})
