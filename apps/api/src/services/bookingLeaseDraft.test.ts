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
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit } from '../test/dbHelpers'
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
