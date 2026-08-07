/**
 * S581 sweep (Subsystem 3 — rent invoicing) regression:
 *
 * The move-in invoice (moveInBundle, dated lease.start_date) prorates rent for
 * the ENTIRE start calendar month. Daily invoice generation used to skip only
 * the due date exactly equal to start_date, so a lease with a mid-month
 * rent_due_day (any rent_due_day > 1) landed a SECOND full-month invoice inside
 * the already-covered move-in window and double-billed the first month.
 *
 * These lock in: no regular invoice is ever generated for the start month,
 * regardless of rent_due_day — while later months bill normally, and the
 * common rent_due_day=1 case is unchanged.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { db, getClient } from '../db'
import {
  cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedTenant,
  seedLease, seedLeaseTenant,
} from '../test/dbHelpers'
import { backfillInvoices as backfill } from './invoiceGeneration'
import { generateMoveInInvoice as genMoveIn } from './moveInBundle'

beforeEach(async () => { await cleanupAllSchema() })

async function seedStack(opts: { startDate: string; rentDueDay: number; rent?: number }) {
  const client = await getClient()
  try {
    await client.query('BEGIN')
    const { userId, landlordId } = await seedLandlord(client)
    const tenantId = await seedTenant(client)
    const propertyId = await seedProperty(client, { landlordId, ownerUserId: userId, managedByUserId: userId })
    const unitId = await seedUnit(client, { propertyId, landlordId })
    const leaseId = await seedLease(client, { unitId, landlordId, rentAmount: opts.rent ?? 1000, startDate: opts.startDate })
    await seedLeaseTenant(client, { leaseId, tenantId })
    await client.query(
      `UPDATE leases SET rent_due_day=$2, needs_review=false WHERE id=$1`,
      [leaseId, opts.rentDueDay])
    await client.query('COMMIT')
    return { userId, landlordId, tenantId, propertyId, unitId, leaseId }
  } catch (e) { await client.query('ROLLBACK'); throw e } finally { client.release() }
}

async function rentDueDates(leaseId: string): Promise<string[]> {
  const rows = await db.query<{ d: string }>(
    `SELECT to_char(due_date, 'YYYY-MM-DD') AS d
       FROM payments WHERE lease_id=$1 AND type='rent' ORDER BY due_date`, [leaseId])
  return rows.rows.map(r => r.d)
}

describe('move-in month is never double-billed by daily generation', () => {
  it('mid-month rent_due_day, start on the 1st: no second start-month invoice', async () => {
    // Start May 1 (move-in bills full May), rent due on the 15th.
    const s = await seedStack({ startDate: '2026-05-01', rentDueDay: 15 })
    await genMoveIn({
      lease_id: s.leaseId, unit_id: s.unitId, tenant_id: s.tenantId,
      landlord_id: s.landlordId, rent_amount: 1000, start_date: '2026-05-01',
    } as any)
    await backfill({ from: '2026-05-01', to: '2026-07-31', leaseId: s.leaseId })

    const dates = await rentDueDates(s.leaseId)
    // Move-in occupies May 1; NO May 15 second invoice; June 15 + July 15 bill.
    expect(dates).toContain('2026-05-01')
    expect(dates).not.toContain('2026-05-15')
    expect(dates).toContain('2026-06-15')
    expect(dates).toContain('2026-07-15')
    // Exactly one rent row inside the start month.
    expect(dates.filter(d => d.startsWith('2026-05'))).toHaveLength(1)
  })

  it('mid-month start AND mid-month due day: start month billed only by move-in', async () => {
    // Start May 5 (move-in prorates May 5–31), rent due on the 20th.
    const s = await seedStack({ startDate: '2026-05-05', rentDueDay: 20 })
    await genMoveIn({
      lease_id: s.leaseId, unit_id: s.unitId, tenant_id: s.tenantId,
      landlord_id: s.landlordId, rent_amount: 1000, start_date: '2026-05-05',
    } as any)
    await backfill({ from: '2026-05-01', to: '2026-07-31', leaseId: s.leaseId })

    const dates = await rentDueDates(s.leaseId)
    expect(dates).toContain('2026-05-05')          // move-in
    expect(dates).not.toContain('2026-05-20')      // the bug's phantom second charge
    expect(dates.filter(d => d.startsWith('2026-05'))).toHaveLength(1)
    expect(dates).toContain('2026-06-20')
    expect(dates).toContain('2026-07-20')
  })

  it('rent_due_day=1 (the common case) is unchanged: later months bill', async () => {
    const s = await seedStack({ startDate: '2026-05-01', rentDueDay: 1 })
    await genMoveIn({
      lease_id: s.leaseId, unit_id: s.unitId, tenant_id: s.tenantId,
      landlord_id: s.landlordId, rent_amount: 1000, start_date: '2026-05-01',
    } as any)
    await backfill({ from: '2026-05-01', to: '2026-07-31', leaseId: s.leaseId })

    const dates = await rentDueDates(s.leaseId)
    expect(dates.filter(d => d.startsWith('2026-05'))).toHaveLength(1)  // move-in only
    expect(dates).toContain('2026-06-01')
    expect(dates).toContain('2026-07-01')
  })
})
