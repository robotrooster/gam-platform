/**
 * S550 — address verification tiers. Deps injected (no live geocoder, no
 * parcels DB): the contract under test is the grading + persistence +
 * admin alert on unverified.
 */
import { vi, describe, it, expect, beforeEach } from 'vitest'
import { db } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty } from '../test/dbHelpers'

const { createAdminNotificationMock } = vi.hoisted(() => ({
  createAdminNotificationMock: vi.fn(async () => {}),
}))
vi.mock('./adminNotifications', () => ({
  createAdminNotification: createAdminNotificationMock,
}))

import { verifyPropertyAddress } from './addressVerification'

beforeEach(async () => {
  await cleanupAllSchema()
  createAdminNotificationMock.mockClear()
})

async function seedProp() {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const { userId, landlordId } = await seedLandlord(c)
    const propertyId = await seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: userId })
    await c.query('COMMIT')
    return propertyId
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

const ADDR = { street1: '22658 Highway 89', street2: null, city: 'Yarnell', state: 'AZ', zip: '85362' }

describe('verifyPropertyAddress', () => {
  it('parcel corroboration wins over geocode; row + timestamp persisted', async () => {
    const id = await seedProp()
    const level = await verifyPropertyAddress(id, ADDR, {
      geocodeFn: async () => ({ lat: 34.22, lon: -112.74 }),
      parcelMatchFn: async () => true,
    })
    expect(level).toBe('parcel')
    const row = (await db.query<any>(
      `SELECT address_verification, latitude, longitude, address_verified_at FROM properties WHERE id=$1`, [id],
    )).rows[0]
    expect(row.address_verification).toBe('parcel')
    expect(Number(row.latitude)).toBeCloseTo(34.22)
    expect(row.address_verified_at).toBeTruthy()
    expect(createAdminNotificationMock).not.toHaveBeenCalled()
  })

  it('geocode-only lands geocoded (typo case: parcel finds nothing)', async () => {
    const id = await seedProp()
    const level = await verifyPropertyAddress(id, { ...ADDR, street1: '22656 Highway 89' }, {
      geocodeFn: async () => ({ lat: 34.2, lon: -112.7 }),
      parcelMatchFn: async () => false,
    })
    expect(level).toBe('geocoded')
    expect(createAdminNotificationMock).not.toHaveBeenCalled()
  })

  it('neither signal → unverified + admin alert, property untouched otherwise', async () => {
    const id = await seedProp()
    const level = await verifyPropertyAddress(id, { ...ADDR, street1: '1 Nowhere At All' }, {
      geocodeFn: async () => null,
      parcelMatchFn: async () => false,
    })
    expect(level).toBe('unverified')
    const row = (await db.query<any>(
      `SELECT address_verification FROM properties WHERE id=$1`, [id],
    )).rows[0]
    expect(row.address_verification).toBe('unverified')
    const call = (createAdminNotificationMock.mock.calls as any[])[0]?.[0]
    expect(call.category).toBe('unverified_property_address')
  })

  it('never throws — geocoder blowing up still resolves', async () => {
    const id = await seedProp()
    const level = await verifyPropertyAddress(id, ADDR, {
      geocodeFn: async () => { throw new Error('network down') },
      parcelMatchFn: async () => { throw new Error('db down') },
    })
    expect(level).toBe('unverified')
  })
})

describe('sweepUnverifiedAddresses — heat-map coverage guarantee', () => {
  it('picks up never-attempted rows, grades them, and reports counts', async () => {
    const a = await seedProp()
    const b = await seedProp()
    const res = await (await import('./addressVerification')).sweepUnverifiedAddresses({
      delayMs: 0,
      deps: {
        geocodeFn: async () => ({ lat: 33.4, lon: -112.0 }),
        parcelMatchFn: async (addr) => addr.street1.startsWith('1 '),
      },
    })
    expect(res.attempted).toBeGreaterThanOrEqual(2)
    const rows = (await db.query<any>(
      `SELECT id, address_verification, latitude FROM properties WHERE id = ANY($1::uuid[])`,
      [[a, b]],
    )).rows
    for (const r of rows) {
      expect(['parcel', 'geocoded']).toContain(r.address_verification)
      expect(r.latitude).not.toBeNull()
    }
    // A second sweep finds nothing left to do.
    const again = await (await import('./addressVerification')).sweepUnverifiedAddresses({
      delayMs: 0,
      deps: { geocodeFn: async () => null, parcelMatchFn: async () => false },
    })
    expect(again.attempted).toBe(0)
  })
})
