/**
 * S640 — the yearly emergency-contact check.
 *
 * Nic: "maybe make a thing where we can ping tenants to update an emergency
 * contact — maybe once a year, we make sure it's still relevant."
 *
 * The thing these guard is restraint. GAM has already sent 952 signing
 * reminders to 39 people; a job that asks every resident every night for
 * something nobody considers urgent would be the same mistake in a new place.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

const notifyMock = vi.hoisted(() => vi.fn(async (..._args: any[]) => undefined))
vi.mock('../services/notifications', () => ({ createNotification: notifyMock }))

import { db, getClient } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit } from '../test/dbHelpers'
import { pingTenantsForEmergencyContact } from './emergencyContactRefresh'

beforeEach(async () => {
  await cleanupAllSchema()
  notifyMock.mockClear()
})

/** One housed resident, with whatever emergency contact the test wants. */
async function seedResident(contact: {
  none?: boolean; phone?: string | null; confirmedDaysAgo?: number | null; askedDaysAgo?: number | null
}) {
  const c = await getClient()
  try {
    await c.query('BEGIN')
    const { userId: ownerId, landlordId } = await seedLandlord(c)
    const propertyId = await seedProperty(c, { landlordId, ownerUserId: ownerId, managedByUserId: ownerId })
    const unitId = await seedUnit(c, { propertyId, landlordId, rentAmount: 500 })
    const u = await c.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
       VALUES ('r-' || gen_random_uuid() || '@t.dev','x','tenant','Ray','Resident',TRUE) RETURNING id`)
    const t = await c.query<{ id: string }>(
      `INSERT INTO tenants (user_id) VALUES ($1) RETURNING id`, [u.rows[0].id])
    const l = await c.query<{ id: string }>(
      `INSERT INTO leases (unit_id, landlord_id, rent_amount, lease_type, status, start_date)
       VALUES ($1,$2,500,'month_to_month','active', CURRENT_DATE - 400) RETURNING id`,
      [unitId, landlordId])
    await c.query(`INSERT INTO lease_tenants (lease_id, tenant_id, role) VALUES ($1,$2,'primary')`,
      [l.rows[0].id, t.rows[0].id])
    if (!contact.none) {
      await c.query(
        `INSERT INTO emergency_contacts (tenant_id, name, phone, source, confirmed_at, asked_at, sort_order)
         VALUES ($1,'Pat Kin',$2,'staff',
                 CASE WHEN $3::int IS NULL THEN NULL ELSE NOW() - ($3 || ' days')::interval END,
                 CASE WHEN $4::int IS NULL THEN NULL ELSE NOW() - ($4 || ' days')::interval END, 0)`,
        [t.rows[0].id, contact.phone ?? null,
         contact.confirmedDaysAgo ?? null, contact.askedDaysAgo ?? null])
    }
    await c.query('COMMIT')
    return { tenantId: t.rows[0].id }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

describe('S640 who gets asked', () => {
  it('asks a resident with nothing on file', async () => {
    await seedResident({ none: true })
    const r = await pingTenantsForEmergencyContact()
    expect(r.asked).toBe(1)
    expect(notifyMock).toHaveBeenCalledTimes(1)
    expect(notifyMock.mock.calls[0][0] as any).toMatchObject({ type: 'emergency_contact_refresh' })
  })

  it('asks when there is a name but no number to ring', async () => {
    await seedResident({ phone: null, confirmedDaysAgo: 5 })
    expect((await pingTenantsForEmergencyContact()).asked).toBe(1)
  })

  it('asks when nobody has confirmed it in over a year', async () => {
    await seedResident({ phone: '5205551234', confirmedDaysAgo: 400 })
    expect((await pingTenantsForEmergencyContact()).asked).toBe(1)
  })

  it('leaves a contact confirmed this year alone', async () => {
    await seedResident({ phone: '5205551234', confirmedDaysAgo: 30 })
    const r = await pingTenantsForEmergencyContact()
    expect(r.due).toBe(0)
    expect(notifyMock).not.toHaveBeenCalled()
  })

  // The restraint. 952 reminders to 39 people is the cautionary tale.
  it('does not ask again within ninety days', async () => {
    await seedResident({ phone: null, askedDaysAgo: 10 })
    const r = await pingTenantsForEmergencyContact()
    expect(r.due).toBe(0)
    expect(notifyMock).not.toHaveBeenCalled()
  })

  it('asks again once the quiet period is over', async () => {
    await seedResident({ phone: null, askedDaysAgo: 120 })
    expect((await pingTenantsForEmergencyContact()).asked).toBe(1)
  })

  // A resident with no row would otherwise be asked on every single run.
  it('records the ask for somebody who has no contact row yet, and stops', async () => {
    await seedResident({ none: true })
    await pingTenantsForEmergencyContact()
    const { rows } = await db.query<any>(`SELECT asked_at FROM emergency_contacts`)
    expect(rows).toHaveLength(1)
    expect(rows[0].asked_at).not.toBeNull()

    notifyMock.mockClear()
    const second = await pingTenantsForEmergencyContact()
    expect(second.due).toBe(0)
    expect(notifyMock).not.toHaveBeenCalled()
  })

  it('tells somebody who already has one what we have, rather than starting over', async () => {
    await seedResident({ phone: '5205551234', confirmedDaysAgo: 400 })
    await pingTenantsForEmergencyContact()
    expect(String((notifyMock.mock.calls[0][0] as any).body)).toContain('Pat Kin')
  })
})
