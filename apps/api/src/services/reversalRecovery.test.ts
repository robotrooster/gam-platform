/**
 * S561 Phase 3: reversal recovery decision engine.
 *
 * decideReversalRecovery picks NETTING vs ACH-PULL for reclaiming a reversed
 * rent from an already-paid landlord, based on whether a covering GUARANTEED
 * lease influx is due within REVERSAL_NETTING_WINDOW_DAYS. `asOf` is pinned so
 * the window math is deterministic regardless of the real clock.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { db } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedTenant, seedLease } from '../test/dbHelpers'
import { anticipatedLeaseInflux, decideReversalRecovery, escalateStaleNetting } from './reversalRecovery'

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
