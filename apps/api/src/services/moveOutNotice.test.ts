/**
 * S653 (Nic) — "they're leaving on…" is a FRONT DESK mark, not a document.
 *
 *   "They're going to come in and say, hey, I'm pulling out Saturday with like
 *    maybe three or four days notice, if that. We need the front desk to be able
 *    to mark it as, hey, they're leaving then. When we get the final meter read,
 *    we can initiate the final bill cycle."
 *
 * The mark is the lease's end date, so everything that already honors an end
 * date (the schedule, reservations, the reads-due list, the 2am move-out, the
 * final utility invoice) follows from it with no second mechanism.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { DateTime } from 'luxon'
import { db } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedLease, seedTenant, seedLeaseTenant } from '../test/dbHelpers'

const notify = vi.fn(async (..._a: any[]) => ({}))
vi.mock('./notifications', () => ({ createNotification: (...a: any[]) => notify(...a) }))

import { recordMoveOutNotice, cancelMoveOutNotice, listResidentsForDesk } from './moveOutNotice'
import { findStayConflict } from './unitAvailability'
import { getReadsDue } from './utilityReadingRuns'
import { processLeaseEnds } from '../jobs/scheduler'

beforeEach(async () => { await cleanupAllSchema(); notify.mockClear() })

const today = () => DateTime.now().setZone('America/Phoenix')
const iso = (d: DateTime) => d.toISODate()!

async function world(opts: { endDate?: string | null } = {}) {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const ll = await seedLandlord(c)
    const propertyId = await seedProperty(c, { landlordId: ll.landlordId, ownerUserId: ll.userId, managedByUserId: ll.userId })
    const unitId = await seedUnit(c, { propertyId, landlordId: ll.landlordId })
    await c.query(`UPDATE units SET unit_number='RV 27', unit_type='rv_spot', status='active' WHERE id=$1`, [unitId])
    const leaseId = await seedLease(c, { unitId, landlordId: ll.landlordId, startDate: '2026-01-01',
      leaseType: opts.endDate ? 'fixed_term' : 'month_to_month' })
    if (opts.endDate) await c.query(`UPDATE leases SET end_date=$2 WHERE id=$1`, [leaseId, opts.endDate])
    const tenantId = await seedTenant(c, { email: 'razo@test.dev' })
    await seedLeaseTenant(c, { leaseId, tenantId })
    await c.query(`UPDATE users SET first_name='Andres', last_name='Razo' WHERE id=(SELECT user_id FROM tenants WHERE id=$1)`, [tenantId])
    const m = await c.query<{ id: string }>(
      `INSERT INTO utility_meters (property_id, utility_type, label, billing_method, digits)
       VALUES ($1,'electric','RV 27 electric','submeter',6) RETURNING id`, [propertyId])
    await c.query(`INSERT INTO utility_meter_units (meter_id, unit_id) VALUES ($1,$2)`, [m.rows[0].id, unitId])
    await c.query('COMMIT')
    return { ...ll, propertyId, unitId, leaseId, tenantId, meterId: m.rows[0].id }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

describe('marking a resident as leaving', () => {
  it('sets the day they said as the lease end and remembers it was a notice', async () => {
    const w = await world()
    const sat = iso(today().plus({ days: 4 }))
    const lease = await recordMoveOutNotice({ leaseId: w.leaseId, on: sat, note: 'pulling out Saturday', byUserId: w.userId })
    expect(lease.end_date).toBe(sat)
    expect(lease.move_out_notice_at).toBeTruthy()
    expect(lease.move_out_notice_by).toBe(w.userId)
    expect(lease.move_out_notice_note).toBe('pulling out Saturday')
    expect(lease.move_out_notice_prev_end_date).toBeNull()      // was month to month
    expect(lease.status).toBe('active')                          // nothing ends today
  })

  it('tells the resident the day that was written down', async () => {
    const w = await world()
    const sat = iso(today().plus({ days: 4 }))
    await recordMoveOutNotice({ leaseId: w.leaseId, on: sat, byUserId: w.userId })
    expect(notify).toHaveBeenCalledTimes(1)
    const n = (notify.mock.calls[0] as any)[0]
    expect(n.type).toBe('lease_move_out_notice')
    expect(n.emailTo).toBe('razo@test.dev')
    expect(n.body).toContain('RV 27')
  })

  it('opens the space for a reservation from that day', async () => {
    const w = await world()
    const sat = iso(today().plus({ days: 4 }))
    expect(await findStayConflict(w.unitId, { checkIn: sat, checkOut: iso(today().plus({ days: 9 })) })).toBe('lease')
    await recordMoveOutNotice({ leaseId: w.leaseId, on: sat, byUserId: w.userId })
    expect(await findStayConflict(w.unitId, { checkIn: sat, checkOut: iso(today().plus({ days: 9 })) })).toBeNull()
    // still theirs the night before
    expect(await findStayConflict(w.unitId, { checkIn: iso(today().plus({ days: 3 })), checkOut: sat })).toBe('lease')
  })

  it('asks for the final meter read on the day, and the 2am job moves them out', async () => {
    const w = await world()
    const day = iso(today())
    await recordMoveOutNotice({ leaseId: w.leaseId, on: day, byUserId: w.userId })
    const due = await getReadsDue(w.propertyId)
    expect(due.some((r: any) => r.meter_id === w.meterId && r.lease_id === w.leaseId)).toBe(true)

    await processLeaseEnds()
    const { rows } = await db.query(`SELECT l.status, u.status AS unit_status FROM leases l JOIN units u ON u.id=l.unit_id WHERE l.id=$1`, [w.leaseId])
    expect(rows[0]).toMatchObject({ status: 'expired', unit_status: 'vacant' })
  })

  it('refuses a day in the past or before they moved in', async () => {
    const w = await world()
    await expect(recordMoveOutNotice({ leaseId: w.leaseId, on: iso(today().minus({ days: 1 })), byUserId: w.userId }))
      .rejects.toThrow(/past/)
  })

  it('refuses to stretch a signed term — that is a new lease, not a notice', async () => {
    const end = iso(today().plus({ days: 10 }))
    const w = await world({ endDate: end })
    await expect(recordMoveOutNotice({ leaseId: w.leaseId, on: iso(today().plus({ days: 20 })), byUserId: w.userId }))
      .rejects.toThrow(/already ends/)
    // leaving EARLY is what a notice is for
    const lease = await recordMoveOutNotice({ leaseId: w.leaseId, on: iso(today().plus({ days: 3 })), byUserId: w.userId })
    expect(lease.end_date).toBe(iso(today().plus({ days: 3 })))
    expect(lease.move_out_notice_prev_end_date).toBe(end)
  })

  it('re-marking keeps the original end date so a call-off restores the real one', async () => {
    const end = iso(today().plus({ days: 10 }))
    const w = await world({ endDate: end })
    await recordMoveOutNotice({ leaseId: w.leaseId, on: iso(today().plus({ days: 3 })), byUserId: w.userId })
    const again = await recordMoveOutNotice({ leaseId: w.leaseId, on: iso(today().plus({ days: 5 })), byUserId: w.userId })
    expect(again.move_out_notice_prev_end_date).toBe(end)
    const back = await cancelMoveOutNotice({ leaseId: w.leaseId, byUserId: w.userId })
    expect(back.end_date).toBe(end)
    expect(back.move_out_notice_at).toBeNull()
  })

  it('calling it off puts a month-to-month resident back to open-ended', async () => {
    const w = await world()
    await recordMoveOutNotice({ leaseId: w.leaseId, on: iso(today().plus({ days: 4 })), byUserId: w.userId })
    const back = await cancelMoveOutNotice({ leaseId: w.leaseId, byUserId: w.userId })
    expect(back.end_date).toBeNull()
    expect(await findStayConflict(w.unitId, { checkIn: iso(today().plus({ days: 30 })), checkOut: null })).toBe('lease')
    expect(notify).toHaveBeenCalledTimes(2)
    expect((notify.mock.calls[1] as any)[0].type).toBe('lease_move_out_notice_cancelled')
  })

  it('will not call it off over somebody already booked behind them', async () => {
    const w = await world()
    const sat = iso(today().plus({ days: 4 }))
    await recordMoveOutNotice({ leaseId: w.leaseId, on: sat, byUserId: w.userId })
    await db.query(
      `INSERT INTO unit_bookings (unit_id, landlord_id, guest_name, check_in, check_out, nights, lease_type, nightly_rate, total_amount, status, deposit_paid_at)
       VALUES ($1,$2,'Next Guest',$3,$4,5,'nightly',49,245,'confirmed',NOW())`,
      [w.unitId, w.landlordId, sat, iso(today().plus({ days: 9 }))])
    await expect(cancelMoveOutNotice({ leaseId: w.leaseId, byUserId: w.userId })).rejects.toThrow(/already booked/)
    const { rows } = await db.query(`SELECT to_char(end_date,'YYYY-MM-DD') AS e FROM leases WHERE id=$1`, [w.leaseId])
    expect(rows[0].e).toBe(sat)
  })

  it('the desk list finds a household by name or space and shows the leaving date', async () => {
    const w = await world()
    const sat = iso(today().plus({ days: 4 }))
    await recordMoveOutNotice({ leaseId: w.leaseId, on: sat, byUserId: w.userId })
    const byName = await listResidentsForDesk({ landlordIds: [w.landlordId], propertyIds: null, q: 'razo' })
    expect(byName).toHaveLength(1)
    expect(byName[0]).toMatchObject({ lease_id: w.leaseId, unit_number: 'RV 27', end_date: sat, names: 'Andres Razo' })
    expect(byName[0].move_out_notice_at).toBeTruthy()
    const bySpace = await listResidentsForDesk({ landlordIds: [w.landlordId], propertyIds: null, q: 'rv 27' })
    expect(bySpace).toHaveLength(1)
    const elsewhere = await listResidentsForDesk({ landlordIds: [w.landlordId], propertyIds: ['00000000-0000-0000-0000-000000000000'] })
    expect(elsewhere).toHaveLength(0)
  })
})
