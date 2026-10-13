/**
 * 10/12 (Nic) — 20261013120000_delinquency_first_late_day.sql: a space turns
 * delinquent on the same FIRST LATE DAY as everything else (services/lateness:
 * due + GREATEST(grace, 1), "the 6th is late, the day late fees start").
 *
 * The trigger (trg_sync_unit_delinquency) used to read "after due + grace" —
 * the 7th — so on the 6th the morning job marked a space and the next change to
 * its charges cleared it. LF2 (Nic, 10/12): a bill written after its due date
 * is late counted from the day it was written ("delinquency trigger too"), so
 * the rows below are written before their due date unless a test says
 * otherwise. Each test applies the migration inside a transaction
 * that is rolled back, so it runs the same before and after schema.sql carries
 * it, and never leaks into another file.
 */
import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import type { PoolClient } from 'pg'
import { withRollback, seedLandlord, seedProperty, seedUnit, seedTenant, seedLease, seedLeaseTenant } from '../test/dbHelpers'
import { firstLateDay, DEFAULT_LATE_GRACE_DAYS } from '../services/lateness'

const MIGRATION = fs.readFileSync(path.join(__dirname, 'migrations', '20261013120000_delinquency_first_late_day.sql'), 'utf8')

/** A rent line on a fresh space, due `daysAgo` days before today (the property's day); the space's status after. */
async function spaceAfterRent(c: PoolClient, o: RentOpts): Promise<string> {
  return (await rentOnFreshSpace(c, o)).status
}

/**
 * `writtenDaysAgo`: when GAM wrote the row (its created_at), in days before
 * now. Left out, the row was written 3 days before its due date (the usual
 * invoice run), so lateness counts from the due date.
 */
type RentOpts = { daysAgo: number; leaseGrace?: number | null; amount?: number; writtenDaysAgo?: number }

async function rentOnFreshSpace(
  c: PoolClient, o: RentOpts,
): Promise<{ status: string; unitId: string; paymentId: string; leaseId: string; tenantId: string; landlordId: string }> {
  const ll = await seedLandlord(c)
  const propertyId = await seedProperty(c, { landlordId: ll.landlordId, ownerUserId: ll.userId, managedByUserId: ll.userId })
  await c.query(`UPDATE properties SET timezone = 'America/Phoenix', late_fee_grace_days = 5 WHERE id = $1`, [propertyId])
  const unitId = await seedUnit(c, { propertyId, landlordId: ll.landlordId })
  const tenantId = await seedTenant(c)
  const leaseId = await seedLease(c, { unitId, landlordId: ll.landlordId, rentAmount: 460, status: 'active' })
  await c.query(`UPDATE leases SET late_fee_grace_days = $2 WHERE id = $1`, [leaseId, o.leaseGrace ?? null])
  await seedLeaseTenant(c, { leaseId, tenantId, role: 'primary' })
  await c.query(`UPDATE units SET status = 'active' WHERE id = $1`, [unitId])
  const paymentId = (await c.query<{ id: string }>(
    `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, entry_description, due_date, created_at)
     VALUES ($1,$2,$3,$4,'rent',$5,'pending','RENT',
             (NOW() AT TIME ZONE 'America/Phoenix')::date - $6::int,
             NOW() - make_interval(days => $7::int)) RETURNING id`,
    [unitId, leaseId, tenantId, ll.landlordId, o.amount ?? 460, o.daysAgo, o.writtenDaysAgo ?? o.daysAgo + 3])).rows[0].id
  const status = (await c.query<{ status: string }>(`SELECT status FROM units WHERE id = $1`, [unitId])).rows[0].status
  return { status, unitId, paymentId, leaseId, tenantId, landlordId: ll.landlordId }
}

describe('20261013120000 — delinquent from the first late day', () => {
  it('the property\'s 5 days: the 6th is late (due 5 days ago), the 5th is not', async () => {
    // The one rule in code says the same: due the 1st with 5 days → the 6th.
    expect(firstLateDay('2026-10-01', DEFAULT_LATE_GRACE_DAYS)).toBe('2026-10-06')
    await withRollback(async c => {
      await c.query(MIGRATION)
      expect(await spaceAfterRent(c, { daysAgo: 5 })).toBe('delinquent')
      expect(await spaceAfterRent(c, { daysAgo: 4 })).toBe('active')
    })
  })

  it('the lease grace wins; a grace of 0 makes the day after the due date the first late day', async () => {
    expect(firstLateDay('2026-10-01', 0)).toBe('2026-10-02')
    await withRollback(async c => {
      await c.query(MIGRATION)
      expect(await spaceAfterRent(c, { daysAgo: 9, leaseGrace: 10 })).toBe('active')
      expect(await spaceAfterRent(c, { daysAgo: 10, leaseGrace: 10 })).toBe('delinquent')
      expect(await spaceAfterRent(c, { daysAgo: 0, leaseGrace: 0 })).toBe('active')
      expect(await spaceAfterRent(c, { daysAgo: 1, leaseGrace: 0 })).toBe('delinquent')
    })
  })

  it('a $0 rent line is never owed', async () => {
    await withRollback(async c => {
      await c.query(MIGRATION)
      expect(await spaceAfterRent(c, { daysAgo: 40, amount: 0 })).toBe('active')
    })
  })

  it('paying the late rent clears the space', async () => {
    await withRollback(async c => {
      await c.query(MIGRATION)
      const r = await rentOnFreshSpace(c, { daysAgo: 5 })
      expect(r.status).toBe('delinquent')
      await c.query(`UPDATE payments SET status = 'settled', settled_at = NOW(), manual_method = 'cash' WHERE id = $1`, [r.paymentId])
      expect((await c.query(`SELECT status FROM units WHERE id = $1`, [r.unitId])).rows[0].status).toBe('active')
    })
  })

  it('LF2: a bill written 10 days after its due date is late from the day it was written + grace', async () => {
    await withRollback(async c => {
      await c.query(MIGRATION)
      // Due 10 days ago, written today: the 5 grace days start today.
      expect(await spaceAfterRent(c, { daysAgo: 10, writtenDaysAgo: 0 })).toBe('active')
      // Due 14 days ago, written 4 days ago: still inside the grace days.
      expect(await spaceAfterRent(c, { daysAgo: 14, writtenDaysAgo: 4 })).toBe('active')
      // Due 15 days ago, written 5 days ago: written day + 5 is today.
      expect(await spaceAfterRent(c, { daysAgo: 15, writtenDaysAgo: 5 })).toBe('delinquent')
    })
  })

  it('LF2: the rest of a part-paid bill counts from its bill, not from the day the rest was written', async () => {
    await withRollback(async c => {
      await c.query(MIGRATION)
      // The bill: due 10 days ago, written before it, paid in part today.
      const r = await rentOnFreshSpace(c, { daysAgo: 10 })
      expect(r.status).toBe('delinquent')
      await c.query(`UPDATE payments SET status = 'settled', settled_at = NOW(), manual_method = 'cash', amount = 200 WHERE id = $1`, [r.paymentId])
      expect((await c.query(`SELECT status FROM units WHERE id = $1`, [r.unitId])).rows[0].status).toBe('active')
      // The rest is written today, on the same bill.
      await c.query(
        `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, entry_description, due_date, is_remainder, notes)
         SELECT unit_id, lease_id, tenant_id, landlord_id, 'rent', 260, 'pending', 'RENT', due_date, TRUE,
                'What is left of this bill after a part payment'
           FROM payments WHERE id = $1`, [r.paymentId])
      expect((await c.query(`SELECT status FROM units WHERE id = $1`, [r.unitId])).rows[0].status).toBe('delinquent')
    })
  })
})
