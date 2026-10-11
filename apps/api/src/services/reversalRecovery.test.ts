/**
 * S561 Phase 3: reversal recovery decision engine.
 *
 * decideReversalRecovery picks NETTING vs ACH-PULL for reclaiming a reversed
 * rent from an already-paid landlord, based on whether a covering GUARANTEED
 * lease influx is due within REVERSAL_NETTING_WINDOW_DAYS. `asOf` is pinned so
 * the window math is deterministic regardless of the real clock.
 */

import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest'
import { db } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedTenant, seedLease } from '../test/dbHelpers'
import { anticipatedLeaseInflux, decideReversalRecovery, decideEventRecovery, processPendingReversalRecoveries, escalateStaleNetting } from './reversalRecovery'

async function seedLandlordWithLease(rentAmount = 1000): Promise<{ landlordId: string; paymentId: string }> {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const { userId, landlordId } = await seedLandlord(c)
    const propertyId = await seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: userId })
    const unitId = await seedUnit(c, { propertyId, landlordId })
    const tenantId = await seedTenant(c)
    await seedLease(c, { unitId, landlordId, rentAmount }) // rent_due_day defaults to 1, status active
    const { rows: [pay] } = await c.query<{ id: string }>(
      `INSERT INTO payments (unit_id, tenant_id, landlord_id, type, amount, status, entry_description, due_date)
       VALUES ($1,$2,$3,'rent',$4,'returned','RENT',CURRENT_DATE) RETURNING id`,
      [unitId, tenantId, landlordId, rentAmount]
    )
    await c.query('COMMIT')
    return { landlordId, paymentId: pay.id }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

async function insertReversal(paymentId: string, landlordId: string, reversedAmount: number, eventId: string): Promise<string> {
  const { rows: [r] } = await db.query<{ id: string }>(
    `INSERT INTO payment_reversals
       (payment_id, landlord_id, reversal_type, reversed_amount, reversal_fee, stripe_event_id, raw_event)
     VALUES ($1,$2,'ach_unauthorized',$3,4,$4,'{}') RETURNING id`,
    [paymentId, landlordId, reversedAmount, eventId]
  )
  return r.id
}

beforeEach(async () => { await cleanupAllSchema() })

// S655: several records per event (C0 drops the old one-per-event constraint;
// dropped here for this file only, and put back after only if it was there, so
// a run with C0 applied stays post-C0 for every later suite).
let hadOldConstraint = false
beforeAll(async () => {
  hadOldConstraint = (await db.query(
    `SELECT 1 FROM pg_constraint WHERE conname = 'payment_reversals_stripe_event_id_key'`)).rowCount === 1
  await db.query(`ALTER TABLE payment_reversals DROP CONSTRAINT IF EXISTS payment_reversals_stripe_event_id_key`)
})
afterAll(async () => {
  if (!hadOldConstraint) return
  await cleanupAllSchema()
  await db.query(`ALTER TABLE payment_reversals ADD CONSTRAINT payment_reversals_stripe_event_id_key UNIQUE (stripe_event_id)`)
})

describe('anticipatedLeaseInflux', () => {
  it('counts active-lease rent whose due day (the 1st) falls inside the window', async () => {
    const { landlordId } = await seedLandlordWithLease(1000)
    // asOf Mar 28 → window Mar 28..Apr 1 includes the 1st
    expect(await anticipatedLeaseInflux(landlordId, 5, '2026-03-28')).toBe(1000)
    // asOf Mar 20 → window Mar 20..Mar 24 excludes the 1st
    expect(await anticipatedLeaseInflux(landlordId, 5, '2026-03-20')).toBe(0)
  })

  it('rolls a weekend due date to its banking day — weekend pushes it out of a tight window', async () => {
    const { landlordId } = await seedLandlordWithLease(1000)
    // Aug 1 2026 is a SATURDAY → effective banking date is Mon Aug 3.
    // asOf Jul 29, window 5 = [Jul 29..Aug 2]: raw Aug 1 is in-window, but the
    // effective banking date Aug 3 is NOT → excluded (GAM would ACH-pull, not
    // float on a weekend-delayed influx).
    expect(await anticipatedLeaseInflux(landlordId, 5, '2026-07-29')).toBe(0)
    // asOf Jul 30, window 5 = [Jul 30..Aug 3]: effective Aug 3 is in-window.
    expect(await anticipatedLeaseInflux(landlordId, 5, '2026-07-30')).toBe(1000)
  })
})

describe('decideReversalRecovery', () => {
  it('schedules NETTING when a covering guaranteed influx is in-window', async () => {
    const { landlordId, paymentId } = await seedLandlordWithLease(1000)
    const revId = await insertReversal(paymentId, landlordId, 1000, 'evt_net')
    const d = await decideReversalRecovery(revId, '2026-03-28')
    expect(d?.method).toBe('netting')
    const row = await db.query(`SELECT recovery_method, recovery_status, status FROM payment_reversals WHERE id=$1`, [revId])
    expect(row.rows[0]).toMatchObject({ recovery_method: 'netting', recovery_status: 'scheduled_netting', status: 'recovering' })
  })

  it('chooses ACH PULL when no covering influx is in-window', async () => {
    const { landlordId, paymentId } = await seedLandlordWithLease(1000)
    const revId = await insertReversal(paymentId, landlordId, 1000, 'evt_pull')
    const d = await decideReversalRecovery(revId, '2026-03-20') // the 1st is outside this window
    expect(d?.method).toBe('ach_pull')
    const row = await db.query(`SELECT recovery_method, recovery_status FROM payment_reversals WHERE id=$1`, [revId])
    expect(row.rows[0]).toMatchObject({ recovery_method: 'ach_pull', recovery_status: 'pending' })
  })

  it('chooses ACH PULL when the in-window influx does not fully cover the amount', async () => {
    const { landlordId, paymentId } = await seedLandlordWithLease(1000) // influx 1000
    const revId = await insertReversal(paymentId, landlordId, 2500, 'evt_partial') // needs 2500
    const d = await decideReversalRecovery(revId, '2026-03-28') // influx in-window but 1000 < 2500
    expect(d?.method).toBe('ach_pull')
  })
})

describe('escalateStaleNetting', () => {
  it('flips a netting older than the cap to an ACH pull, leaves fresh ones alone', async () => {
    const { landlordId, paymentId } = await seedLandlordWithLease(1000)
    const { rows: [stale] } = await db.query<{ id: string }>(
      `INSERT INTO payment_reversals
         (payment_id, landlord_id, reversal_type, reversed_amount, reversal_fee,
          stripe_event_id, raw_event, recovery_method, recovery_status, status, created_at)
       VALUES ($1,$2,'ach_unauthorized',500,4,'evt_stale','{}','netting','scheduled_netting','recovering', NOW() - INTERVAL '15 days')
       RETURNING id`, [paymentId, landlordId])
    const { rows: [fresh] } = await db.query<{ id: string }>(
      `INSERT INTO payment_reversals
         (payment_id, landlord_id, reversal_type, reversed_amount, reversal_fee,
          stripe_event_id, raw_event, recovery_method, recovery_status, status, created_at)
       VALUES ($1,$2,'ach_unauthorized',500,4,'evt_fresh','{}','netting','scheduled_netting','recovering', NOW() - INTERVAL '2 days')
       RETURNING id`, [paymentId, landlordId])

    const res = await escalateStaleNetting(14)
    expect(res.escalated).toBe(1)

    const s = await db.query(`SELECT recovery_method, recovery_status FROM payment_reversals WHERE id=$1`, [stale.id])
    expect(s.rows[0]).toMatchObject({ recovery_method: 'ach_pull', recovery_status: 'pending' })
    const f = await db.query(`SELECT recovery_status FROM payment_reversals WHERE id=$1`, [fresh.id])
    expect(f.rows[0].recovery_status).toBe('scheduled_netting')
  })
})

describe('S655: one recovery per event', () => {
  async function secondRow(landlordId: string, amount: number): Promise<string> {
    const unit = (await db.query<{ unit_id: string; tenant_id: string }>(
      `SELECT unit_id, tenant_id FROM payments WHERE landlord_id = $1 LIMIT 1`, [landlordId])).rows[0]
    return (await db.query<{ id: string }>(
      `INSERT INTO payments (unit_id, tenant_id, landlord_id, type, amount, status, entry_description, due_date)
       VALUES ($1,$2,$3,'utility',$4,'returned','UTILITY',CURRENT_DATE) RETURNING id`,
      [unit.unit_id, unit.tenant_id, landlordId, amount])).rows[0].id
  }

  it('recovery runs once per event across its rows', async () => {
    // $900 rent + $100 water reversed by one dispute; a $1,000 influx is in the
    // window. Decided per row, each would look covered alone; decided per
    // event, it is the $1,000 that must be covered — and it is, once.
    const { landlordId, paymentId } = await seedLandlordWithLease(1000)
    const water = await secondRow(landlordId, 100)
    const a = await insertReversal(paymentId, landlordId, 900, 'evt_one_dispute')
    const b = await insertReversal(water, landlordId, 100, 'evt_one_dispute')

    const decided = await decideEventRecovery('evt_one_dispute', '2026-03-28')
    expect(decided).toHaveLength(1)
    expect(decided[0]).toMatchObject({ method: 'netting', needed: 1000 })
    expect(decided[0].reversalIds.sort()).toEqual([a, b].sort())
    const rows = await db.query<any>(`SELECT recovery_method, recovery_status FROM payment_reversals WHERE stripe_event_id = 'evt_one_dispute'`)
    expect(rows.rows).toEqual([
      { recovery_method: 'netting', recovery_status: 'scheduled_netting' },
      { recovery_method: 'netting', recovery_status: 'scheduled_netting' },
    ])
    // Nothing left to decide: a second run changes nothing.
    expect(await decideEventRecovery('evt_one_dispute', '2026-03-28')).toEqual([])
    expect(await processPendingReversalRecoveries()).toEqual({ decided: 0, netting: 0, achPull: 0 })
  })

  it('an event too large for the influx is pulled once, for the whole event', async () => {
    const { landlordId, paymentId } = await seedLandlordWithLease(1000)
    const water = await secondRow(landlordId, 600)
    await insertReversal(paymentId, landlordId, 900, 'evt_big')
    const b = await insertReversal(water, landlordId, 600, 'evt_big')
    // decideReversalRecovery on one record decides its whole event.
    const d = await decideReversalRecovery(b, '2026-03-28')
    expect(d).toMatchObject({ method: 'ach_pull', needed: 1500 })
    const rows = await db.query<any>(`SELECT DISTINCT recovery_method FROM payment_reversals WHERE stripe_event_id = 'evt_big'`)
    expect(rows.rows).toEqual([{ recovery_method: 'ach_pull' }])
  })

  it('records GAM recovers from nobody are never part of a decision', async () => {
    const { landlordId, paymentId } = await seedLandlordWithLease(1000)
    await db.query(
      `INSERT INTO payment_reversals (payment_id, landlord_id, reversal_type, reversed_amount, reversal_fee, stripe_event_id,
                                      raw_event, recovery_status, status, resolved_at)
       VALUES ($1,$2,'card_dispute',0,0,'evt_zero','{}','not_needed','resolved',NOW())`, [paymentId, landlordId])
    expect(await decideEventRecovery('evt_zero', '2026-03-28')).toEqual([])
  })
})
