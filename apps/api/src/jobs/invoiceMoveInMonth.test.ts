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

// S652 (Nic): the property's first billing cycle is the hard floor on the DUE
// month. Country Acres was set to October; the nightly job billed September on
// the 23rd for eight households, and the late-fee job followed the next night.
describe('the property\'s first billing cycle is the floor on every due month', () => {
  it('bills nothing before the first cycle, everything from it', async () => {
    const s = await seedStack({ startDate: '2026-05-01', rentDueDay: 1 })
    await db.query(`UPDATE leases SET is_existing_tenancy = TRUE WHERE id = $1`, [s.leaseId])
    await db.query(`UPDATE properties SET first_billing_cycle = '2026-07-01' WHERE id = $1`, [s.propertyId])
    await backfill({ from: '2026-05-01', to: '2026-08-31', leaseId: s.leaseId })
    expect(await rentDueDates(s.leaseId)).toEqual(['2026-07-01', '2026-08-01'])
  })

  it('without a first cycle the job behaves as before', async () => {
    const s = await seedStack({ startDate: '2026-05-01', rentDueDay: 1 })
    await db.query(`UPDATE leases SET is_existing_tenancy = TRUE WHERE id = $1`, [s.leaseId])
    await backfill({ from: '2026-05-01', to: '2026-08-31', leaseId: s.leaseId })
    expect(await rentDueDates(s.leaseId)).toEqual(['2026-06-01', '2026-07-01', '2026-08-01'])
  })
})

describe('move-in month is never double-billed by daily generation', () => {
  // S648 (Nic): rent can be due on a day other than the 1st, and the move-in
  // invoice now covers the move-in day UP TO the next due date — not the whole
  // calendar month. So a due date inside the start month is a real bill, and
  // every period is billed exactly once. (Before S648 the move-in charged the
  // whole start month and that due date was skipped instead.)
  const rentsOf = async (leaseId: string) => (await db.query<{ d: string; a: number }>(
    `SELECT to_char(due_date,'YYYY-MM-DD') AS d, amount::float AS a FROM payments
      WHERE lease_id=$1 AND type='rent' ORDER BY due_date`, [leaseId])).rows

  it('due on the 15th, start on the 1st: move-in covers May 1–14, May 15 bills', async () => {
    const s = await seedStack({ startDate: '2026-05-01', rentDueDay: 15 })
    await genMoveIn({
      lease_id: s.leaseId, unit_id: s.unitId, tenant_id: s.tenantId,
      landlord_id: s.landlordId, rent_amount: 1000, start_date: '2026-05-01',
    } as any)
    await backfill({ from: '2026-05-01', to: '2026-07-31', leaseId: s.leaseId })
    // Apr 15 → May 15 is 30 days; May 1–14 is 14 of them.
    expect(await rentsOf(s.leaseId)).toEqual([
      { d: '2026-05-01', a: 466.67 }, { d: '2026-05-15', a: 1000 },
      { d: '2026-06-15', a: 1000 }, { d: '2026-07-15', a: 1000 },
    ])
  })

  it('due on the 20th, start on the 5th: move-in covers May 5–19, each period once', async () => {
    const s = await seedStack({ startDate: '2026-05-05', rentDueDay: 20 })
    await genMoveIn({
      lease_id: s.leaseId, unit_id: s.unitId, tenant_id: s.tenantId,
      landlord_id: s.landlordId, rent_amount: 1000, start_date: '2026-05-05',
    } as any)
    await backfill({ from: '2026-05-01', to: '2026-07-31', leaseId: s.leaseId })
    // Apr 20 → May 20 is 30 days; May 5–19 is 15 of them.
    expect(await rentsOf(s.leaseId)).toEqual([
      { d: '2026-05-05', a: 500 }, { d: '2026-05-20', a: 1000 },
      { d: '2026-06-20', a: 1000 }, { d: '2026-07-20', a: 1000 },
    ])
  })

  it('due on the move-in day: a full first period, then monthly on that day', async () => {
    const s = await seedStack({ startDate: '2026-05-20', rentDueDay: 20 })
    await genMoveIn({
      lease_id: s.leaseId, unit_id: s.unitId, tenant_id: s.tenantId,
      landlord_id: s.landlordId, rent_amount: 1000, start_date: '2026-05-20',
    } as any)
    await backfill({ from: '2026-05-01', to: '2026-07-31', leaseId: s.leaseId })
    expect(await rentsOf(s.leaseId)).toEqual([
      { d: '2026-05-20', a: 1000 }, { d: '2026-06-20', a: 1000 }, { d: '2026-07-20', a: 1000 },
    ])
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

// S622 (Nic): "I just wanted to make sure that the tenant would actually still
// get charged. The lease would still get created, all that kind of stuff if they
// took till the fifth or the sixth to sign it."
//
// Oak Park's shape: leases dated the 1st, signatures landing days later. The
// esign suite mocks generateMoveInInvoice, so the billing step is asserted as
// "called" there and proven for real here — the money has to actually appear.
describe('S622: a lease finalized AFTER its start date still bills', () => {
  it('creates the move-in invoice dated the lease start, with rent the tenant owes', async () => {
    // Lease began on the 1st of last month; the signature lands today.
    // Built from LOCAL parts: toISOString() converts to UTC, which pushed the
    // 1st to the 2nd whenever this ran after ~17:00 local and quietly turned a
    // full month's rent into a prorated one. A date-only value must never make
    // a round trip through a timestamp.
    const d = new Date()
    d.setMonth(d.getMonth() - 1, 1)
    const startDate = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`

    const { leaseId, unitId, landlordId, tenantId } = await seedStack({ startDate, rentDueDay: 1, rent: 1000 })
    const res = await genMoveIn({
      lease_id: leaseId, unit_id: unitId, tenant_id: tenantId,
      landlord_id: landlordId, rent_amount: 1000, start_date: startDate,
    } as any)

    // The invoice exists, dated the lease's real start — not the signing date.
    expect(res.invoiceCreated).toBe(true)
    const inv = await db.query<{ due_date: string }>(
      `SELECT to_char(due_date,'YYYY-MM-DD') AS due_date FROM invoices WHERE lease_id=$1`, [leaseId])
    expect(inv.rows.length).toBe(1)
    expect(inv.rows[0].due_date).toBe(startDate)

    // And the tenant is actually charged: a rent row for the full month, since
    // the lease starts on the 1st (nothing to prorate).
    const rent = await db.query<{ amount: string; due_date: string }>(
      `SELECT amount::text AS amount, to_char(due_date,'YYYY-MM-DD') AS due_date
         FROM payments WHERE lease_id=$1 AND type='rent'`, [leaseId])
    expect(rent.rows.length).toBe(1)
    expect(Number(rent.rows[0].amount)).toBe(1000)
    expect(rent.rows[0].due_date).toBe(startDate)
    expect(res.rentAmount).toBe(1000)
  })
})
