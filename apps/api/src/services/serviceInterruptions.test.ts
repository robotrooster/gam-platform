/**
 * S517 — service-interruption auto-activation (scheduled → active at start).
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { db, getClient } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty } from '../test/dbHelpers'
import { activateDueServiceInterruptions } from './serviceInterruptions'

beforeEach(async () => { await cleanupAllSchema() })

async function seedInterruption(status: string, startsAt: string) {
  const c = await getClient()
  try {
    await c.query('BEGIN')
    const { userId, landlordId } = await seedLandlord(c)
    const propertyId = await seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: userId })
    const r = await c.query<{ id: string }>(
      `INSERT INTO service_interruptions
         (property_id, landlord_id, utility_type, starts_at, status, created_by_user_id)
       VALUES ($1,$2,'water',$3,$4,$5) RETURNING id`,
      [propertyId, landlordId, startsAt, status, userId])
    await c.query('COMMIT')
    return r.rows[0].id
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

const status = async (id: string) =>
  (await db.query<{ status: string }>('SELECT status FROM service_interruptions WHERE id=$1', [id])).rows[0].status

describe('activateDueServiceInterruptions', () => {
  it('flips scheduled → active once start time has passed', async () => {
    const id = await seedInterruption('scheduled', '2026-01-01T00:00:00Z')
    const r = await activateDueServiceInterruptions(new Date('2026-06-26T00:00:00Z'))
    expect(r.activated).toBe(1)
    expect(await status(id)).toBe('active')
  })

  it('leaves future-scheduled outages untouched', async () => {
    const id = await seedInterruption('scheduled', '2026-12-31T00:00:00Z')
    const r = await activateDueServiceInterruptions(new Date('2026-06-26T00:00:00Z'))
    expect(r.activated).toBe(0)
    expect(await status(id)).toBe('scheduled')
  })

  it('does not touch already-active, resolved, or cancelled notices', async () => {
    const a = await seedInterruption('active', '2026-01-01T00:00:00Z')
    const res = await seedInterruption('resolved', '2026-01-01T00:00:00Z')
    const can = await seedInterruption('cancelled', '2026-01-01T00:00:00Z')
    const r = await activateDueServiceInterruptions(new Date('2026-06-26T00:00:00Z'))
    expect(r.activated).toBe(0)
    expect(await status(a)).toBe('active')
    expect(await status(res)).toBe('resolved')
    expect(await status(can)).toBe('cancelled')
  })
})
