/**
 * S414 hygiene bundle:
 *
 *   1. S399 bulk-create input hardening on
 *      POST /api/properties/:id/units/bulk
 *      - count cap (≤ 200)
 *      - prefix length cap (≤ 32)
 *      - type enum validation (was: caught later by DB CHECK → 500)
 *
 *   2. S407 follow-on: UNIQUE constraint on
 *      payments(unit_id, type, due_date) WHERE status != 'cancelled'.
 *      The S407 SELECT-then-skip guard defends sequential repeats;
 *      this index closes the residual concurrent-write race.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { randomUUID } from 'crypto'
import { db } from '../db'
import {
  cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedTenant,
} from '../test/dbHelpers'
import { propertiesRouter } from './properties'
import { errorHandler } from '../middleware/errorHandler'

function buildPropsApp() {
  const app = express()
  app.use(express.json({ limit: '2mb' }))
  app.use('/api/properties', propertiesRouter)
  app.use(errorHandler)
  return app
}

beforeEach(async () => {
  await cleanupAllSchema()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_s414'
})

const sign = (claims: any) =>
  jwt.sign(claims, process.env.JWT_SECRET!, { expiresIn: '1h' })

interface PropsFixture {
  userId:     string
  landlordId: string
  propertyId: string
  token:      string
}

async function seedPropsFixture(): Promise<PropsFixture> {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const { userId, landlordId } = await seedLandlord(c)
    const propertyId = await seedProperty(c, {
      landlordId, ownerUserId: userId, managedByUserId: userId,
    })
    await c.query('COMMIT')
    return {
      userId, landlordId, propertyId,
      token: sign({ userId, role: 'landlord', email: 'l@t.dev',
                     profileId: landlordId, permissions: {} }),
    }
  } catch (e) { await c.query('ROLLBACK'); throw e }
  finally { c.release() }
}

// ─── S399: bulk-create input hardening ───────────────────────

describe('POST /api/properties/:id/units/bulk — S399 input hardening', () => {
  it('happy: type=rv_spot, count=3 → 201 + 3 units', async () => {
    const f = await seedPropsFixture()
    const res = await request(buildPropsApp())
      .post(`/api/properties/${f.propertyId}/units/bulk`)
      .set('Authorization', `Bearer ${f.token}`)
      .send({ unitGroups: [{ type: 'rv_spot', count: 3, prefix: 'RV', rentAmount: 500 }] })
    expect(res.status).toBe(201)
    expect(res.body.data.created).toBe(3)
  })

  it('S414 fix: count > 200 → 400 "count must be ≤ 200"', async () => {
    const f = await seedPropsFixture()
    const res = await request(buildPropsApp())
      .post(`/api/properties/${f.propertyId}/units/bulk`)
      .set('Authorization', `Bearer ${f.token}`)
      .send({ unitGroups: [{ type: 'rv_spot', count: 201, rentAmount: 500 }] })
    expect(res.status).toBe(400)
  })

  it('S414 fix: count = 200 exactly → 201 (boundary)', async () => {
    const f = await seedPropsFixture()
    const res = await request(buildPropsApp())
      .post(`/api/properties/${f.propertyId}/units/bulk`)
      .set('Authorization', `Bearer ${f.token}`)
      .send({ unitGroups: [{ type: 'rv_spot', count: 200, prefix: 'RV', rentAmount: 500 }] })
    expect(res.status).toBe(201)
    expect(res.body.data.created).toBe(200)
  }, 30_000)

  it('S414 fix: prefix > 32 chars → 400', async () => {
    const f = await seedPropsFixture()
    const res = await request(buildPropsApp())
      .post(`/api/properties/${f.propertyId}/units/bulk`)
      .set('Authorization', `Bearer ${f.token}`)
      .send({ unitGroups: [{ type: 'rv_spot', count: 3, prefix: 'A'.repeat(33), rentAmount: 500 }] })
    expect(res.status).toBe(400)
  })

  it('S414 fix: invalid type "house" → 400 (was 500 from DB CHECK pre-fix)', async () => {
    const f = await seedPropsFixture()
    const res = await request(buildPropsApp())
      .post(`/api/properties/${f.propertyId}/units/bulk`)
      .set('Authorization', `Bearer ${f.token}`)
      .send({ unitGroups: [{ type: 'house', count: 3, prefix: 'H', rentAmount: 500 }] })
    expect(res.status).toBe(400)
  })

  it('S414 fix: type=single_family (was missing from old prefix map) → 201', async () => {
    const f = await seedPropsFixture()
    const res = await request(buildPropsApp())
      .post(`/api/properties/${f.propertyId}/units/bulk`)
      .set('Authorization', `Bearer ${f.token}`)
      .send({ unitGroups: [{ type: 'single_family', count: 2, rentAmount: 1200 }] })
    expect(res.status).toBe(201)
    expect(res.body.data.created).toBe(2)
    // Default prefix for single_family is 'House' per the S414 prefix map.
    const numbers = res.body.data.units.map((u: any) => u.unit_number)
    expect(numbers.every((n: string) => n.startsWith('House'))).toBe(true)
  })

  it('S414: empty unitGroups array → 400', async () => {
    const f = await seedPropsFixture()
    const res = await request(buildPropsApp())
      .post(`/api/properties/${f.propertyId}/units/bulk`)
      .set('Authorization', `Bearer ${f.token}`)
      .send({ unitGroups: [] })
    expect(res.status).toBe(400)
  })

  it('S414: count = 0 → 400 (was: silently skipped pre-fix)', async () => {
    const f = await seedPropsFixture()
    const res = await request(buildPropsApp())
      .post(`/api/properties/${f.propertyId}/units/bulk`)
      .set('Authorization', `Bearer ${f.token}`)
      .send({ unitGroups: [{ type: 'rv_spot', count: 0, rentAmount: 500 }] })
    expect(res.status).toBe(400)
  })
})

// ─── S407 follow-on: payments UNIQUE constraint ──────────────

describe('payments UNIQUE constraint — S407 follow-on (S414)', () => {
  it('S414: direct duplicate INSERT raises 23505 unique_violation', async () => {
    const c = await db.connect()
    try {
      await c.query('BEGIN')
      const { landlordId, userId } = await seedLandlord(c)
      const propertyId = await seedProperty(c, {
        landlordId, ownerUserId: userId, managedByUserId: userId,
      })
      const unitId = await seedUnit(c, { propertyId, landlordId })
      const tenantId = await seedTenant(c)
      // First insert OK.
      await c.query(
        `INSERT INTO payments (unit_id, tenant_id, landlord_id, type, amount,
                                status, entry_description, due_date)
         VALUES ($1, $2, $3, 'rent', 1000, 'pending', 'RENT', '2026-07-01')`,
        [unitId, tenantId, landlordId])
      // Second insert: same (unit, type, due_date), non-cancelled → 23505.
      await expect(c.query(
        `INSERT INTO payments (unit_id, tenant_id, landlord_id, type, amount,
                                status, entry_description, due_date)
         VALUES ($1, $2, $3, 'rent', 1000, 'pending', 'RENT', '2026-07-01')`,
        [unitId, tenantId, landlordId])).rejects.toMatchObject({ code: '23505' })
      await c.query('ROLLBACK')
    } finally { c.release() }
  })

  it('S414: failed + returned rows excluded from the UNIQUE — retry-eligible after a failure', async () => {
    const c = await db.connect()
    try {
      await c.query('BEGIN')
      const { landlordId, userId } = await seedLandlord(c)
      const propertyId = await seedProperty(c, {
        landlordId, ownerUserId: userId, managedByUserId: userId,
      })
      const unitId = await seedUnit(c, { propertyId, landlordId })
      const tenantId = await seedTenant(c)
      // 1 failed + 1 returned + 1 active (pending) for the same
      // (unit, type, due_date) → all OK because failure end-states
      // are excluded from the partial UNIQUE.
      await c.query(
        `INSERT INTO payments (unit_id, tenant_id, landlord_id, type, amount,
                                status, entry_description, due_date)
         VALUES ($1, $2, $3, 'rent', 1000, 'failed',   'RENT', '2026-07-01'),
                ($1, $2, $3, 'rent', 1000, 'returned', 'RENT', '2026-07-01'),
                ($1, $2, $3, 'rent', 1000, 'pending',  'RENT', '2026-07-01')`,
        [unitId, tenantId, landlordId])
      const { rows } = await c.query(
        `SELECT COUNT(*) AS n FROM payments
          WHERE unit_id=$1 AND type='rent' AND due_date='2026-07-01'`,
        [unitId])
      expect(Number(rows[0].n)).toBe(3)
      await c.query('ROLLBACK')
    } finally { c.release() }
  })

  it('S414: different (unit, type, due_date) combos allowed even when active', async () => {
    const c = await db.connect()
    try {
      await c.query('BEGIN')
      const { landlordId, userId } = await seedLandlord(c)
      const propertyId = await seedProperty(c, {
        landlordId, ownerUserId: userId, managedByUserId: userId,
      })
      const unitId = await seedUnit(c, { propertyId, landlordId })
      const tenantId = await seedTenant(c)
      // Same unit, different types — OK.
      // Same unit, same type, different due_date — OK.
      await c.query(
        `INSERT INTO payments (unit_id, tenant_id, landlord_id, type, amount,
                                status, entry_description, due_date)
         VALUES ($1, $2, $3, 'rent',     1000, 'pending', 'RENT', '2026-07-01'),
                ($1, $2, $3, 'late_fee',   25, 'pending', 'LATEFEE', '2026-07-01'),
                ($1, $2, $3, 'rent',     1000, 'pending', 'RENT', '2026-08-01')`,
        [unitId, tenantId, landlordId])
      const { rows } = await c.query(
        `SELECT COUNT(*) AS n FROM payments WHERE unit_id=$1`, [unitId])
      expect(Number(rows[0].n)).toBe(3)
      await c.query('ROLLBACK')
    } finally { c.release() }
  })
})
