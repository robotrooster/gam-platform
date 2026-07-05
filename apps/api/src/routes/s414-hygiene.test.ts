/**
 * S414 hygiene bundle:
 *
 *   1. S399 bulk-create input hardening — S527: the bulk route
 *      (POST /api/properties/:id/units/bulk) is REMOVED; batch creation
 *      is now POST /api/units with `quantity`. The same protections
 *      carry over and are asserted here against the new path:
 *      - quantity cap (≤ 200)
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
import { unitsRouter } from './units'
import { errorHandler } from '../middleware/errorHandler'

function buildUnitsApp() {
  const app = express()
  app.use(express.json({ limit: '2mb' }))
  app.use('/api/units', unitsRouter)
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

// ─── S399/S527: batch-create input hardening (POST /api/units quantity) ───

describe('POST /api/units quantity — S399 hardening carried to S527 path', () => {
  it('happy: rv_spot quantity=3 → 201 + 3 numbered units', async () => {
    const f = await seedPropsFixture()
    const res = await request(buildUnitsApp())
      .post('/api/units')
      .set('Authorization', `Bearer ${f.token}`)
      .send({ propertyId: f.propertyId, unitNumber: 'RV', quantity: 3, unitType: 'rv_spot', rentAmount: 500 })
    expect(res.status).toBe(201)
    expect(res.body.data.created).toBe(3)
    const numbers = res.body.data.units.map((u: any) => u.unit_number)
    expect(numbers).toEqual(['RV 01', 'RV 02', 'RV 03'])
  })

  it('quantity > 200 → 400', async () => {
    const f = await seedPropsFixture()
    const res = await request(buildUnitsApp())
      .post('/api/units')
      .set('Authorization', `Bearer ${f.token}`)
      .send({ propertyId: f.propertyId, unitNumber: 'RV', quantity: 201, unitType: 'rv_spot', rentAmount: 500 })
    expect(res.status).toBe(400)
  })

  it('quantity = 200 exactly → 201 (boundary)', async () => {
    const f = await seedPropsFixture()
    const res = await request(buildUnitsApp())
      .post('/api/units')
      .set('Authorization', `Bearer ${f.token}`)
      .send({ propertyId: f.propertyId, unitNumber: 'RV', quantity: 200, unitType: 'rv_spot', rentAmount: 500 })
    expect(res.status).toBe(201)
    expect(res.body.data.created).toBe(200)
  }, 30_000)

  it('invalid type "house" → 400 (was 500 from DB CHECK pre-S414)', async () => {
    const f = await seedPropsFixture()
    const res = await request(buildUnitsApp())
      .post('/api/units')
      .set('Authorization', `Bearer ${f.token}`)
      .send({ propertyId: f.propertyId, unitNumber: 'H', quantity: 3, unitType: 'house', rentAmount: 500 })
    expect(res.status).toBe(400)
  })

  it('quantity = 0 → 400', async () => {
    const f = await seedPropsFixture()
    const res = await request(buildUnitsApp())
      .post('/api/units')
      .set('Authorization', `Bearer ${f.token}`)
      .send({ propertyId: f.propertyId, unitNumber: 'RV', quantity: 0, unitType: 'rv_spot', rentAmount: 500 })
    expect(res.status).toBe(400)
  })

  it('numbering continues after existing max for the prefix', async () => {
    const f = await seedPropsFixture()
    const app = buildUnitsApp()
    await request(app).post('/api/units').set('Authorization', `Bearer ${f.token}`)
      .send({ propertyId: f.propertyId, unitNumber: 'RV', quantity: 2, unitType: 'rv_spot', rentAmount: 500 })
    const res = await request(app).post('/api/units').set('Authorization', `Bearer ${f.token}`)
      .send({ propertyId: f.propertyId, unitNumber: 'RV', quantity: 2, unitType: 'rv_spot', rentAmount: 500 })
    expect(res.status).toBe(201)
    const numbers = res.body.data.units.map((u: any) => u.unit_number)
    expect(numbers).toEqual(['RV 03', 'RV 04'])
  })

  it('S527: subtypeId supplies type, facts, and pricing; units record it', async () => {
    const f = await seedPropsFixture()
    const sub = await db.query<{ id: string }>(
      `INSERT INTO property_unit_subtypes
         (property_id, unit_type, name, rv_site_layout, rv_amp_service, rent_amount, security_deposit, nightly_rate)
       VALUES ($1, 'rv_spot', 'Riverfront', 'pull_through', '50', 500, 300, 60) RETURNING id`,
      [f.propertyId])
    const res = await request(buildUnitsApp())
      .post('/api/units')
      .set('Authorization', `Bearer ${f.token}`)
      .send({ propertyId: f.propertyId, unitNumber: 'RV', quantity: 2, subtypeId: sub.rows[0].id })
    expect(res.status).toBe(201)
    const units = res.body.data.units
    expect(units).toHaveLength(2)
    for (const u of units) {
      expect(u.unit_type).toBe('rv_spot')
      expect(u.rv_site_layout).toBe('pull_through')
      expect(u.rv_amp_service).toBe('50')
      expect(Number(u.rent_amount)).toBe(500)
      expect(Number(u.nightly_rate)).toBe(60)
      expect(u.subtype_id).toBe(sub.rows[0].id)
      expect(u.is_bookable).toBe(true)
    }
  })

  it('S527: no rent anywhere (body or subtype) → 400', async () => {
    const f = await seedPropsFixture()
    const res = await request(buildUnitsApp())
      .post('/api/units')
      .set('Authorization', `Bearer ${f.token}`)
      .send({ propertyId: f.propertyId, unitNumber: 'A1', unitType: 'apartment' })
    expect(res.status).toBe(400)
  })

  it("S527: foreign property's subtypeId → 404", async () => {
    const f = await seedPropsFixture()
    const g = await seedPropsFixture()
    const sub = await db.query<{ id: string }>(
      `INSERT INTO property_unit_subtypes (property_id, unit_type, name, rent_amount)
       VALUES ($1, 'apartment', 'Studio', 600) RETURNING id`,
      [g.propertyId])
    const res = await request(buildUnitsApp())
      .post('/api/units')
      .set('Authorization', `Bearer ${f.token}`)
      .send({ propertyId: f.propertyId, unitNumber: 'A1', subtypeId: sub.rows[0].id })
    expect(res.status).toBe(404)
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
