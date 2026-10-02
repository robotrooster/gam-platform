/**
 * S639 (Nic): "When the reservation is longer than thirty days, don't have me
 * manually click on a thing to send a request for screening. Longer than thirty
 * days, they automatically get the link for the background check."
 *
 * The landlord notification already warned that screening some guests and not
 * others in the same situation can be considered discriminatory — and then
 * handed the landlord a button that makes exactly that choice, guest by guest,
 * looking at somebody's name. The consistent policy is the automatic one.
 */
import { vi, describe, it, expect, beforeEach } from 'vitest'
import { randomUUID } from 'crypto'

const { screeningMock } = vi.hoisted(() => ({ screeningMock: vi.fn(async (..._a: any[]) => 'msg_mock') }))
vi.mock('../services/email', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  emailBackgroundCheckScreeningRequest: screeningMock,
}))
vi.mock('./email', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  emailBackgroundCheckScreeningRequest: screeningMock,
}))

import { db, getClient } from '../db'
import {
  cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedTenant, seedLease, seedLeaseTenant,
} from '../test/dbHelpers'
import { maybeDraftLeaseFromBooking } from './bookingLeaseDraft'

beforeEach(async () => { await cleanupAllSchema(); screeningMock.mockClear() })

async function seedBooking(nights: number, guestEmail: string | null) {
  const c = await getClient()
  try {
    await c.query('BEGIN')
    const { userId, landlordId } = await seedLandlord(c)
    const propertyId = await seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: userId })
    const unitId = await seedUnit(c, { propertyId, landlordId })
    await c.query(`UPDATE units SET rent_amount = 900 WHERE id = $1`, [unitId])
    const { rows: [b] } = await c.query<{ id: string }>(
      `INSERT INTO unit_bookings
         (unit_id, landlord_id, guest_name, guest_email, check_in, check_out, status, lease_type, total_amount)
       VALUES ($1, $2, 'Long Stayer', $3, CURRENT_DATE,
               (CURRENT_DATE + ($4 || ' days')::interval)::date, 'confirmed', 'month_to_month', 900)
       RETURNING id`,
      [unitId, landlordId, guestEmail, nights])
    await c.query('COMMIT')
    return b.id
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

describe('S639 a long stay is screened automatically', () => {
  it('emails the guest a background-check link when the stay crosses the threshold', async () => {
    const email = `s639-guest-${randomUUID().slice(0, 6)}@test.dev`
    const bookingId = await seedBooking(45, email)
    const r = await maybeDraftLeaseFromBooking(bookingId)
    expect(r.drafted).toBe(true)
    // Nobody had to decide. That is the point.
    expect(screeningMock).toHaveBeenCalledTimes(1)
    expect(String(screeningMock.mock.calls[0][0])).toBe(email)
  })

  it('does not screen a short stay — no lease, no email', async () => {
    const bookingId = await seedBooking(5, `s639-short-${randomUUID().slice(0, 6)}@test.dev`)
    const r = await maybeDraftLeaseFromBooking(bookingId)
    expect(r.drafted).toBe(false)
    expect(screeningMock).not.toHaveBeenCalled()
  })

  it('drafts the lease even when there is no guest email to screen', async () => {
    const bookingId = await seedBooking(45, null)
    const r = await maybeDraftLeaseFromBooking(bookingId)
    // The lease still exists — a missing address must not cost them the tenancy.
    expect(r.drafted).toBe(true)
    expect(screeningMock).not.toHaveBeenCalled()
  })
})

// S654: the continuity walk read every lease date as an Invalid Date (a bare
// pg DATE stringified as "Fri Jul 10"), so the walk never advanced and
// continuity was judged off the check date alone. These two cases pin both
// directions: a lease chain that DOES reach today, and an old check with a
// long gap before the current lease.
async function seedHistory(
  email: string, checkDaysAgo: number,
  leases: Array<{ startAgo: number; endAgo: number | null; status: 'active' | 'expired' }>,
) {
  const c = await getClient()
  try {
    await c.query('BEGIN')
    const { userId, landlordId } = await seedLandlord(c)
    const propertyId = await seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: userId })
    const unitId = await seedUnit(c, { propertyId, landlordId })
    const tenantId = await seedTenant(c, { email })
    const { rows: [t] } = await c.query(`SELECT user_id FROM tenants WHERE id = $1`, [tenantId])
    await c.query(
      `INSERT INTO background_checks (landlord_id, user_id, tenant_id, status, decided_at)
       VALUES ($1, $2, $3, 'approved', now() - ($4 || ' days')::interval)`,
      [landlordId, t.user_id, tenantId, checkDaysAgo])
    for (const l of leases) {
      const leaseUnit = await seedUnit(c, { propertyId, landlordId })
      const { rows: [d] } = await c.query(
        `SELECT (CURRENT_DATE - $1::int)::text AS s,
                CASE WHEN $2::int IS NULL THEN NULL ELSE (CURRENT_DATE - $2::int)::text END AS e`,
        [l.startAgo, l.endAgo])
      const leaseId = await seedLease(c, { unitId: leaseUnit, landlordId, rentAmount: 900, startDate: d.s, status: l.status })
      await c.query(`UPDATE leases SET end_date = $2 WHERE id = $1`, [leaseId, d.e])
      await seedLeaseTenant(c, { leaseId, tenantId })
    }
    const { rows: [b] } = await c.query<{ id: string }>(
      `INSERT INTO unit_bookings
         (unit_id, landlord_id, guest_name, guest_email, check_in, check_out, status, lease_type, total_amount)
       VALUES ($1, $2, 'Long Stayer', $3, CURRENT_DATE, CURRENT_DATE + 45, 'confirmed', 'month_to_month', 900)
       RETURNING id`,
      [unitId, landlordId, email])
    await c.query('COMMIT')
    return b.id
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

async function draftNotice(): Promise<any> {
  const { rows } = await db.query(
    `SELECT data FROM notifications WHERE type = 'lease_drafted_from_booking'`)
  expect(rows).toHaveLength(1)
  return rows[0].data
}

describe('S654 continuity since an approved check', () => {
  it('a lease that ran from before the check to 10 days ago is continuous — no screening email', async () => {
    const email = `cont-${randomUUID().slice(0, 6)}@test.dev`
    const bookingId = await seedHistory(email, 90, [{ startAgo: 85, endAgo: 10, status: 'expired' }])
    const r = await maybeDraftLeaseFromBooking(bookingId)
    expect(r.drafted).toBe(true)
    const data = await draftNotice()
    expect(data.approvedCheckAt).toBeTruthy()
    expect(data.continuousTenancySince).toBe(true)
    expect(screeningMock).not.toHaveBeenCalled()
  })

  it('an old check with a long gap before the current lease is NOT continuous — screened once', async () => {
    const email = `gap-${randomUUID().slice(0, 6)}@test.dev`
    const bookingId = await seedHistory(email, 200, [{ startAgo: 20, endAgo: null, status: 'active' }])
    const r = await maybeDraftLeaseFromBooking(bookingId)
    expect(r.drafted).toBe(true)
    const data = await draftNotice()
    expect(data.approvedCheckAt).toBeTruthy()
    expect(data.continuousTenancySince).toBe(false)
    expect(screeningMock).toHaveBeenCalledTimes(1)
    expect(String(screeningMock.mock.calls[0][0])).toBe(email)
  })
})
