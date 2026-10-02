/**
 * computeLandlordPL — the period's LAST DAY counts in full (S654).
 *
 * Callers pass the end as a bare date ('2026-09-30', the Books P&L and the
 * agent's P&L tool) or as monthRange's '2026-09-30T23:59:59-07:00'. A bare
 * date compared to a timestamp is midnight at the START of that day, so
 * `settled_at <= '2026-09-30'` dropped every payment settled on the 30th.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { db } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedTenant } from '../test/dbHelpers'
import { computeLandlordPL } from './landlordPL'

beforeEach(cleanupAllSchema)

async function seed() {
  const c = await db.connect()
  try {
    const { userId, landlordId } = await seedLandlord(c)
    const propertyId = await seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: userId })
    const unitId = await seedUnit(c, { propertyId, landlordId, rentAmount: 1000 })
    const tenantId = await seedTenant(c)
    return { landlordId, unitId, tenantId }
  } finally { c.release() }
}

// One rent row per unit per due date, so each settle gets its own due date.
async function settledRent(f: { landlordId: string; unitId: string; tenantId: string }, amount: number, settledAt: string, dueDate = '2026-09-01') {
  await db.query(
    `INSERT INTO payments (unit_id, tenant_id, landlord_id, type, amount, status, entry_description, due_date, settled_at)
     VALUES ($1, $2, $3, 'rent', $4, 'settled', 'RENT', $5::date, $6::timestamptz)`,
    [f.unitId, f.tenantId, f.landlordId, amount, dueDate, settledAt])
}

async function completedRepair(f: { landlordId: string; unitId: string }, cost: number, completedAt: string) {
  await db.query(
    `INSERT INTO maintenance_requests (unit_id, landlord_id, title, description, status, actual_cost, completed_at)
     VALUES ($1, $2, 'Fix', 'Fix it', 'completed', $3, $4::timestamptz)`,
    [f.unitId, f.landlordId, cost, completedAt])
}

describe('computeLandlordPL — the last day of the period counts (S654)', () => {
  it('a bare-date end includes a payment settled at 3 pm on the last day', async () => {
    const f = await seed()
    await settledRent(f, 1000, '2026-09-30T15:00:00-07:00')
    const pl = await computeLandlordPL(f.landlordId, '2026-09-01', '2026-09-30', ['2026-09-01'])
    expect(pl.gross.rent).toBe(1000)
  })

  it('a bare-date end includes a repair completed on the last day', async () => {
    const f = await seed()
    await completedRepair(f, 250, '2026-09-30T15:00:00-07:00')
    const pl = await computeLandlordPL(f.landlordId, '2026-09-01', '2026-09-30', ['2026-09-01'])
    expect(pl.expenses.maintenance).toBe(250)
  })

  it("monthRange's end-of-day timestamp includes the last day too", async () => {
    const f = await seed()
    await settledRent(f, 1000, '2026-09-30T15:00:00-07:00')
    await completedRepair(f, 250, '2026-09-30T23:59:59.5-07:00')
    const pl = await computeLandlordPL(f.landlordId, '2026-09-01T00:00:00-07:00', '2026-09-30T23:59:59-07:00', ['2026-09-01'])
    expect(pl.gross.rent).toBe(1000)
    expect(pl.expenses.maintenance).toBe(250)
  })

  it('the next day and the day before the start stay out', async () => {
    const f = await seed()
    await settledRent(f, 1000, '2026-10-01T00:00:00-07:00')   // first moment of Oct 1
    await settledRent(f, 500, '2026-08-31T23:59:59-07:00', '2026-08-01') // last moment of Aug 31
    await completedRepair(f, 250, '2026-10-01T00:00:00-07:00')
    const pl = await computeLandlordPL(f.landlordId, '2026-09-01', '2026-09-30', ['2026-09-01'])
    expect(pl.gross.rent).toBe(0)
    expect(pl.expenses.maintenance).toBe(0)
  })
})

/**
 * S654: every dollar counted once. Income is the landlord's own money only —
 * a GAM fee carrying this landlord_id, and paid-ahead money GAM holds, are not.
 */
describe('computeLandlordPL — only the landlord\'s own money is income (S654)', () => {
  async function settled(f: { landlordId: string; unitId: string; tenantId: string },
    type: string, amount: number, owner: 'landlord' | 'gam' | 'held', settledAt: string) {
    await db.query(
      `INSERT INTO payments (unit_id, tenant_id, landlord_id, type, amount, status, entry_description, due_date, settled_at, revenue_owner)
       VALUES ($1, $2, $3, $4, $5, 'settled', $8, '2026-09-01', $6::timestamptz, $7)`,
      [f.unitId, f.tenantId, f.landlordId, type, amount, settledAt, owner,
       ({ rent: 'RENT', deposit: 'DEPOSIT', late_fee: 'LATEFEE' } as Record<string, string>)[type] ?? 'OTHERFEE'])
  }

  it('$700 rent, a $6 GAM fee and a $500 held deposit → rent 700, fees 0, deposits held 500', async () => {
    const f = await seed()
    await settled(f, 'rent', 700, 'landlord', '2026-09-03T10:00:00-07:00')
    await settled(f, 'fee', 6, 'gam', '2026-09-05T10:00:00-07:00')
    await settled(f, 'deposit', 500, 'held', '2026-09-02T10:00:00-07:00')
    const pl = await computeLandlordPL(f.landlordId, '2026-09-01', '2026-09-30', ['2026-09-01'])
    expect(pl.gross.rent).toBe(700)
    expect(pl.gross.fees).toBe(0)
    expect(pl.gross.total).toBe(700)
    expect(pl.depositsHeld).toBe(500)
  })

  it('a landlord fee counts; a held paid-ahead fee does not', async () => {
    const f = await seed()
    await settled(f, 'late_fee', 25, 'landlord', '2026-09-10T10:00:00-07:00')
    await settled(f, 'fee', 700, 'held', '2026-09-11T10:00:00-07:00')
    const pl = await computeLandlordPL(f.landlordId, '2026-09-01', '2026-09-30', ['2026-09-01'])
    expect(pl.gross.fees).toBe(25)
    expect(pl.depositsHeld).toBe(0)
  })
})
