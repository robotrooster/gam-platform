/**
 * units.ts gap-close slice — S400. Closes the file at 16/17 (94%).
 *
 * Covered routes (9):
 *   - GET   /api/units                                  (S400 fix)
 *   - PATCH /api/units/:id/status
 *   - POST  /api/units/:id/eviction-mode
 *   - PATCH /api/units/:id/type
 *   - GET   /api/units/:id/availability
 *   - GET   /api/units/:id/bookings
 *   - PATCH /api/units/:id/bookings/:bookingId/acknowledge
 *   - GET   /api/units/schedule/master                  (S400 fix)
 *   - POST  /api/units/:id/cancel-scheduled-activation
 *
 * Out of scope:
 *   - GET /:id/economics — walkthrough-blocked (per S398 deferred list)
 *
 * Production bugs fixed in this slice (2):
 *   - **GET /api/units** team-role landlord-id misresolution. Pre-fix
 *     used req.user.profileId unconditionally, which is the user_id for
 *     PM / maintenance_worker / onsite_manager roles, not the
 *     landlord_id. Team members got an empty list — silently. Fixed by
 *     resolving to landlordId for non-landlord, non-admin roles.
 *   - **GET /api/units/schedule/master** same class as above. Team
 *     members got empty {units, bookings, leases} payload. Same fix.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { randomUUID } from 'crypto'
import { db } from '../db'
import {
  cleanupAllSchema, seedLandlord, seedProperty, seedUnit,
} from '../test/dbHelpers'
import { unitsRouter } from './units'
import { errorHandler } from '../middleware/errorHandler'

function buildApp() {
  const app = express()
  app.use(express.json({ limit: '2mb' }))
  app.use('/api/units', unitsRouter)
  app.use(errorHandler)
  return app
}

beforeEach(async () => {
  await cleanupAllSchema()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_units_gap'
})

interface Fixture {
  // Two landlords, each with a property + unit + a booking on that unit.
  aUid: string; aLid: string; aPropId: string; aUnitId: string; aBookingId: string
  bUid: string; bLid: string; bPropId: string; bUnitId: string
  pmUserId: string                  // team-role user attached to landlord A
  tokenA: string                    // role=landlord, profileId=aLid
  tokenB: string                    // role=landlord, profileId=bLid
  tokenPMa: string                  // role=property_manager, profileId=pmUserId, landlordId=aLid
  tokenAdmin: string                // role=admin
}

async function seed(): Promise<Fixture> {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const { userId: aUid, landlordId: aLid } = await seedLandlord(c)
    const { userId: bUid, landlordId: bLid } = await seedLandlord(c)
    const aPropId = await seedProperty(c, { landlordId: aLid, ownerUserId: aUid, managedByUserId: aUid })
    const bPropId = await seedProperty(c, { landlordId: bLid, ownerUserId: bUid, managedByUserId: bUid })
    const aUnitId = await seedUnit(c, { propertyId: aPropId, landlordId: aLid })
    const bUnitId = await seedUnit(c, { propertyId: bPropId, landlordId: bLid })

    // Open lease_types_allowed on A's unit so booking-related tests work.
    await c.query(
      `UPDATE units SET lease_types_allowed = $1::text[] WHERE id = $2`,
      [['nightly', 'weekly', 'month_to_month', 'long_term'], aUnitId])

    // Seed a future booking on A's unit (for /availability and /bookings reads).
    const { rows: [{ id: aBookingId }] } = await c.query<{ id: string }>(
      `INSERT INTO unit_bookings (unit_id, landlord_id, guest_name, lease_type,
        check_in, check_out, nights, total_amount, platform_fee, source)
       VALUES ($1, $2, 'Test Guest', 'nightly',
               CURRENT_DATE + 5, CURRENT_DATE + 8, 3, 300, 15, 'direct') RETURNING id`,
      [aUnitId, aLid])

    // Team-role membership lives in property_manager_scopes, not on users.
    // The route layer trusts the JWT for landlordId, so we sign a token
    // with landlordId=aLid and don't need any DB row for the PM user.
    const pmUserId = randomUUID()

    await c.query('COMMIT')
    const sign = (claims: any) =>
      jwt.sign(claims, process.env.JWT_SECRET!, { expiresIn: '1h' })
    const ALL_PERMS = {
      'units.create': true, 'units.edit': true, 'units.view_status': true,
      'guests.check_in': true, 'guests.check_out': true,
    }
    return {
      aUid, aLid, aPropId, aUnitId, aBookingId,
      bUid, bLid, bPropId, bUnitId,
      pmUserId,
      tokenA: sign({ userId: aUid, role: 'landlord', email: 'a@t.dev',
                     profileId: aLid, permissions: {} }),
      tokenB: sign({ userId: bUid, role: 'landlord', email: 'b@t.dev',
                     profileId: bLid, permissions: {} }),
      tokenPMa: sign({ userId: pmUserId, role: 'property_manager', email: 'pm@t.dev',
                       profileId: pmUserId, landlordId: aLid, permissions: ALL_PERMS }),
      tokenAdmin: sign({ userId: randomUUID(), role: 'admin', email: 'admin@t.dev',
                         profileId: randomUUID(), permissions: {} }),
    }
  } catch (e) { await c.query('ROLLBACK'); throw e }
  finally { c.release() }
}

// ─── GET /api/units ──────────────────────────────────────────

describe('GET /api/units', () => {
  it('landlord sees only own units (cross-tenant rows filtered)', async () => {
    const f = await seed()
    const res = await request(buildApp()).get('/api/units')
      .set('Authorization', `Bearer ${f.tokenA}`)
    expect(res.status).toBe(200)
    const ids = (res.body.data as any[]).map(u => u.id)
    expect(ids).toContain(f.aUnitId)
    expect(ids).not.toContain(f.bUnitId)
  })

  it('admin sees units across all landlords', async () => {
    const f = await seed()
    const res = await request(buildApp()).get('/api/units')
      .set('Authorization', `Bearer ${f.tokenAdmin}`)
    expect(res.status).toBe(200)
    const ids = (res.body.data as any[]).map(u => u.id)
    expect(ids).toContain(f.aUnitId)
    expect(ids).toContain(f.bUnitId)
  })

  it('propertyId filter narrows results', async () => {
    const f = await seed()
    const res = await request(buildApp()).get(`/api/units?propertyId=${f.aPropId}`)
      .set('Authorization', `Bearer ${f.tokenAdmin}`)
    expect(res.status).toBe(200)
    const ids = (res.body.data as any[]).map(u => u.id)
    expect(ids).toEqual([f.aUnitId])
  })

  it('S400 fix: property_manager team-role member sees their landlord\'s units (was empty pre-fix)', async () => {
    const f = await seed()
    const res = await request(buildApp()).get('/api/units')
      .set('Authorization', `Bearer ${f.tokenPMa}`)
    expect(res.status).toBe(200)
    const ids = (res.body.data as any[]).map(u => u.id)
    // Pre-fix this would be [] because filter used the PM's user_id, not
    // the landlord_id they work for.
    expect(ids).toContain(f.aUnitId)
    expect(ids).not.toContain(f.bUnitId)
  })
})

// ─── PATCH /api/units/:id/status ────────────────────────────

describe('PATCH /api/units/:id/status', () => {
  it('happy: landlord sets status', async () => {
    const f = await seed()
    const res = await request(buildApp())
      .patch(`/api/units/${f.aUnitId}/status`)
      .set('Authorization', `Bearer ${f.tokenA}`)
      .send({ status: 'suspended' })
    expect(res.status).toBe(200)
    expect(res.body.data.status).toBe('suspended')
  })

  it('cross-landlord → 403', async () => {
    const f = await seed()
    const res = await request(buildApp())
      .patch(`/api/units/${f.bUnitId}/status`)
      .set('Authorization', `Bearer ${f.tokenA}`)
      .send({ status: 'suspended' })
    expect(res.status).toBe(403)
  })

  it('unknown unit → 404', async () => {
    const f = await seed()
    const res = await request(buildApp())
      .patch(`/api/units/${randomUUID()}/status`)
      .set('Authorization', `Bearer ${f.tokenA}`)
      .send({ status: 'vacant' })
    expect(res.status).toBe(404)
  })

  it('invalid status enum → 400', async () => {
    const f = await seed()
    const res = await request(buildApp())
      .patch(`/api/units/${f.aUnitId}/status`)
      .set('Authorization', `Bearer ${f.tokenA}`)
      .send({ status: 'nonsense_status' })
    expect(res.status).toBe(400)
  })
})

// ─── POST /api/units/:id/eviction-mode ─────────────────────

describe('POST /api/units/:id/eviction-mode', () => {
  it('happy: enable + confirm → payment_block ON, blocking message returned', async () => {
    const f = await seed()
    const res = await request(buildApp())
      .post(`/api/units/${f.aUnitId}/eviction-mode`)
      .set('Authorization', `Bearer ${f.tokenA}`)
      .send({ enable: true, confirm: true })
    expect(res.status).toBe(200)
    expect(res.body.data.payment_block).toBe(true)
    expect(res.body.data.payment_block_set_at).toBeTruthy()
    expect(res.body.data.payment_block_set_by).toBe(f.aUid)
    expect(res.body.message).toMatch(/EVICTION MODE ACTIVE/)
  })

  it('happy: disable clears the block + timestamp + actor', async () => {
    const f = await seed()
    // Pre-flip ON, then OFF.
    await request(buildApp())
      .post(`/api/units/${f.aUnitId}/eviction-mode`)
      .set('Authorization', `Bearer ${f.tokenA}`)
      .send({ enable: true, confirm: true })
    const res = await request(buildApp())
      .post(`/api/units/${f.aUnitId}/eviction-mode`)
      .set('Authorization', `Bearer ${f.tokenA}`)
      .send({ enable: false, confirm: true })
    expect(res.status).toBe(200)
    expect(res.body.data.payment_block).toBe(false)
    expect(res.body.data.payment_block_set_at).toBeNull()
    expect(res.body.data.payment_block_set_by).toBeNull()
    expect(res.body.message).toMatch(/deactivated/)
  })

  it('missing confirm → 400 (zod refine)', async () => {
    const f = await seed()
    const res = await request(buildApp())
      .post(`/api/units/${f.aUnitId}/eviction-mode`)
      .set('Authorization', `Bearer ${f.tokenA}`)
      .send({ enable: true, confirm: false })
    expect(res.status).toBe(400)
  })

  it('cross-landlord → 403', async () => {
    const f = await seed()
    const res = await request(buildApp())
      .post(`/api/units/${f.bUnitId}/eviction-mode`)
      .set('Authorization', `Bearer ${f.tokenA}`)
      .send({ enable: true, confirm: true })
    expect(res.status).toBe(403)
  })

  it('property_manager team member → 403 (canManageLandlordResource with [] blocks all team roles)', async () => {
    const f = await seed()
    const res = await request(buildApp())
      .post(`/api/units/${f.aUnitId}/eviction-mode`)
      .set('Authorization', `Bearer ${f.tokenPMa}`)
      .send({ enable: true, confirm: true })
    expect(res.status).toBe(403)
  })
})

// ─── PATCH /api/units/:id/type ─────────────────────────────

describe('PATCH /api/units/:id/type', () => {
  it('happy: sets type + applies lease_types_allowed matrix', async () => {
    const f = await seed()
    const res = await request(buildApp())
      .patch(`/api/units/${f.aUnitId}/type`)
      .set('Authorization', `Bearer ${f.tokenA}`)
      .send({ unitType: 'rv_spot', nightlyRate: 50, weeklyRate: 300, isBookable: true })
    expect(res.status).toBe(200)
    expect(res.body.data.unit_type).toBe('rv_spot')
    expect(res.body.data.lease_types_allowed).toEqual(
      expect.arrayContaining(['nightly', 'weekly', 'month_to_month', 'long_term']))
    expect(Number(res.body.data.nightly_rate)).toBe(50)
    expect(res.body.data.is_bookable).toBe(true)
  })

  it('S400 finding (NOT a test of intended behavior): LEASE_TYPE_MATRIX drifts from units_unit_type_check', async () => {
    // The route's LEASE_TYPE_MATRIX has keys 'residential', 'rv_spot',
    // 'storage', 'parking', 'short_term_cabin'. The schema CHECK on
    // units.unit_type allows ['apartment', 'single_family', 'rv_spot',
    // 'mobile_home', 'storage', 'commercial']. So 4 of the 5 matrix keys
    // ('residential', 'parking', 'short_term_cabin' — plus the default
    // 'residential' fallback) are NOT writable into units.unit_type at all.
    // This is the CLAUDE.md "single source of truth for enums" rule
    // violation; flagged for the validation-hygiene micro-session.
    // We pin the observable consequence: passing one of the disallowed
    // matrix keys returns a DB CHECK violation, not a clean 400.
    const f = await seed()
    const res = await request(buildApp())
      .patch(`/api/units/${f.aUnitId}/type`)
      .set('Authorization', `Bearer ${f.tokenA}`)
      .send({ unitType: 'short_term_cabin' })
    expect(res.status).toBe(500) // 23514 — flag, do not fix in S400 scope
  })

  it('cross-landlord → 403', async () => {
    const f = await seed()
    const res = await request(buildApp())
      .patch(`/api/units/${f.bUnitId}/type`)
      .set('Authorization', `Bearer ${f.tokenA}`)
      .send({ unitType: 'rv_spot' })
    expect(res.status).toBe(403)
  })
})

// ─── GET /api/units/:id/availability ──────────────────────

describe('GET /api/units/:id/availability', () => {
  it('happy: returns seeded booking inside default 90-day window', async () => {
    const f = await seed()
    const res = await request(buildApp())
      .get(`/api/units/${f.aUnitId}/availability`)
      .set('Authorization', `Bearer ${f.tokenA}`)
    expect(res.status).toBe(200)
    const ids = (res.body.data as any[]).map(b => b.id)
    expect(ids).toContain(f.aBookingId)
  })

  it('cross-landlord → 403', async () => {
    const f = await seed()
    const res = await request(buildApp())
      .get(`/api/units/${f.aUnitId}/availability`)
      .set('Authorization', `Bearer ${f.tokenB}`)
    expect(res.status).toBe(403)
  })

  it('unknown unit → 404', async () => {
    const f = await seed()
    const res = await request(buildApp())
      .get(`/api/units/${randomUUID()}/availability`)
      .set('Authorization', `Bearer ${f.tokenA}`)
    expect(res.status).toBe(404)
  })
})

// ─── GET /api/units/:id/bookings ──────────────────────────

describe('GET /api/units/:id/bookings', () => {
  it('happy: returns booking with requires_booking_acknowledgment from property', async () => {
    const f = await seed()
    const res = await request(buildApp())
      .get(`/api/units/${f.aUnitId}/bookings`)
      .set('Authorization', `Bearer ${f.tokenA}`)
    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(1)
    expect(res.body.data[0]).toHaveProperty('requires_booking_acknowledgment')
    expect(res.body.data[0]).toHaveProperty('unit_number')
  })

  it('cross-landlord → 403', async () => {
    const f = await seed()
    const res = await request(buildApp())
      .get(`/api/units/${f.aUnitId}/bookings`)
      .set('Authorization', `Bearer ${f.tokenB}`)
    expect(res.status).toBe(403)
  })
})

// ─── PATCH /api/units/:id/bookings/:bookingId/acknowledge ──

describe('PATCH /api/units/:id/bookings/:bookingId/acknowledge', () => {
  it('happy: stamps acknowledgment_signed_at', async () => {
    const f = await seed()
    const res = await request(buildApp())
      .patch(`/api/units/${f.aUnitId}/bookings/${f.aBookingId}/acknowledge`)
      .set('Authorization', `Bearer ${f.tokenA}`)
      .send({})
    expect(res.status).toBe(200)
    expect(res.body.data.acknowledgment_signed_at).toBeTruthy()
  })

  it('idempotent: re-acknowledging is a no-op, not an error', async () => {
    const f = await seed()
    await request(buildApp())
      .patch(`/api/units/${f.aUnitId}/bookings/${f.aBookingId}/acknowledge`)
      .set('Authorization', `Bearer ${f.tokenA}`)
      .send({})
    const res = await request(buildApp())
      .patch(`/api/units/${f.aUnitId}/bookings/${f.aBookingId}/acknowledge`)
      .set('Authorization', `Bearer ${f.tokenA}`)
      .send({})
    expect(res.status).toBe(200)
    expect(res.body.data.acknowledgment_signed_at).toBeTruthy()
  })

  it('cross-landlord → 403', async () => {
    const f = await seed()
    const res = await request(buildApp())
      .patch(`/api/units/${f.aUnitId}/bookings/${f.aBookingId}/acknowledge`)
      .set('Authorization', `Bearer ${f.tokenB}`)
      .send({})
    expect(res.status).toBe(403)
  })

  it('unknown booking → 404', async () => {
    const f = await seed()
    const res = await request(buildApp())
      .patch(`/api/units/${f.aUnitId}/bookings/${randomUUID()}/acknowledge`)
      .set('Authorization', `Bearer ${f.tokenA}`)
      .send({})
    expect(res.status).toBe(404)
  })
})

// ─── GET /api/units/schedule/master ────────────────────────

describe('GET /api/units/schedule/master', () => {
  it('happy: returns units + bookings + leases, scoped to caller landlord', async () => {
    const f = await seed()
    const res = await request(buildApp())
      .get('/api/units/schedule/master')
      .set('Authorization', `Bearer ${f.tokenA}`)
    expect(res.status).toBe(200)
    const unitIds = (res.body.data.units as any[]).map(u => u.id)
    expect(unitIds).toContain(f.aUnitId)
    expect(unitIds).not.toContain(f.bUnitId)
    const bookIds = (res.body.data.bookings as any[]).map(b => b.id)
    expect(bookIds).toContain(f.aBookingId)
    expect(res.body.data).toHaveProperty('leases')
    expect(res.body.data.range).toHaveProperty('from')
    expect(res.body.data.range).toHaveProperty('to')
  })

  it('unitType filter narrows the units array', async () => {
    const f = await seed()
    // Flip the seeded unit to rv_spot so the filter can match.
    await db.query(`UPDATE units SET unit_type='rv_spot' WHERE id=$1`, [f.aUnitId])
    const res = await request(buildApp())
      .get('/api/units/schedule/master?unitType=rv_spot')
      .set('Authorization', `Bearer ${f.tokenA}`)
    expect(res.status).toBe(200)
    expect((res.body.data.units as any[]).every(u => u.unit_type === 'rv_spot')).toBe(true)
  })

  it('S400 fix: property_manager team-role member sees their landlord\'s schedule (was empty pre-fix)', async () => {
    const f = await seed()
    const res = await request(buildApp())
      .get('/api/units/schedule/master')
      .set('Authorization', `Bearer ${f.tokenPMa}`)
    expect(res.status).toBe(200)
    const unitIds = (res.body.data.units as any[]).map(u => u.id)
    // Pre-fix this would be [] because filter used the PM's user_id, not
    // the landlord_id they work for.
    expect(unitIds).toContain(f.aUnitId)
  })
})

// ─── POST /api/units/:id/cancel-scheduled-activation ──────

describe('POST /api/units/:id/cancel-scheduled-activation', () => {
  it('happy: clears scheduled_activation_at + scheduled_activation_by', async () => {
    const f = await seed()
    // Pre-set the scheduled fields so cancel has something to clear.
    const when = new Date(Date.now() + 24 * 60 * 60 * 1000)
    await db.query(
      `UPDATE units SET scheduled_activation_at=$1, scheduled_activation_by=$2 WHERE id=$3`,
      [when, f.aUid, f.aUnitId])
    const res = await request(buildApp())
      .post(`/api/units/${f.aUnitId}/cancel-scheduled-activation`)
      .set('Authorization', `Bearer ${f.tokenA}`)
    expect(res.status).toBe(200)
    expect(res.body.data.scheduled_activation_at).toBeNull()
    expect(res.body.data.scheduled_activation_by).toBeNull()
  })

  it('no scheduled activation → 400', async () => {
    const f = await seed()
    const res = await request(buildApp())
      .post(`/api/units/${f.aUnitId}/cancel-scheduled-activation`)
      .set('Authorization', `Bearer ${f.tokenA}`)
    expect(res.status).toBe(400)
  })

  it('cross-landlord → 403', async () => {
    const f = await seed()
    const when = new Date(Date.now() + 24 * 60 * 60 * 1000)
    await db.query(
      `UPDATE units SET scheduled_activation_at=$1 WHERE id=$2`,
      [when, f.bUnitId])
    const res = await request(buildApp())
      .post(`/api/units/${f.bUnitId}/cancel-scheduled-activation`)
      .set('Authorization', `Bearer ${f.tokenA}`)
    expect(res.status).toBe(403)
  })
})
