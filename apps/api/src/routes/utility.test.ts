/**
 * utility.ts full slice — S396. Closes the file at 12/12 (100%).
 *
 * Covered routes (12):
 *   - GET    /api/utility/bills
 *   - GET    /api/utility/meters                   (S396 fix)
 *   - POST   /api/utility/meters
 *   - PATCH  /api/utility/meters/:id
 *   - DELETE /api/utility/meters/:id
 *   - POST   /api/utility/meters/:id/units
 *   - DELETE /api/utility/meters/:id/units/:unitId
 *   - GET    /api/utility/meters/:id/readings
 *   - POST   /api/utility/meters/:id/readings
 *   - POST   /api/utility/generate-bills
 *   - POST   /api/utility/bills/:id/finalize
 *   - POST   /api/utility/bills/:id/pay            (410 deprecated)
 *
 * Production bug fixed in this slice (1):
 *   - **GET /meters** with `?propertyId=` had NO landlord scope filter.
 *     A non-admin caller could pass another landlord's propertyId
 *     and read that property's meter list (label, billing method,
 *     rate). Cross-tenant information disclosure. Fix: validate
 *     property belongs to caller's landlord before applying the
 *     propertyId filter.
 */

import { vi, describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { randomUUID } from 'crypto'
import { db } from '../db'
import {
  cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedTenant,
  seedLease, seedLeaseTenant, seedUtilityMeter, seedUtilityBill,
} from '../test/dbHelpers'

const { generateBillsForMeterMock, generateBillsForPropertyMock, generateBillsForLandlordMock } = vi.hoisted(() => ({
  generateBillsForMeterMock:    vi.fn(async (..._a: any[]) => ({ meterId: 'mock', billsCreated: 0 })),
  generateBillsForPropertyMock: vi.fn(async (..._a: any[]) => ([] as any[])),
  generateBillsForLandlordMock: vi.fn(async (..._a: any[]) => ([] as any[])),
}))
vi.mock('../services/utilityBilling', () => ({
  generateBillsForMeter:    generateBillsForMeterMock,
  generateBillsForProperty: generateBillsForPropertyMock,
  generateBillsForLandlord: generateBillsForLandlordMock,
}))

import { utilityRouter } from './utility'
import { errorHandler } from '../middleware/errorHandler'

function buildApp() {
  const app = express()
  app.use(express.json({ limit: '2mb' }))
  app.use('/api/utility', utilityRouter)
  app.use(errorHandler)
  return app
}

beforeEach(async () => {
  await cleanupAllSchema()
  generateBillsForMeterMock.mockClear()
  generateBillsForMeterMock.mockResolvedValue({ meterId: 'mock', billsCreated: 0 } as any)
  generateBillsForPropertyMock.mockClear()
  generateBillsForPropertyMock.mockResolvedValue([])
  generateBillsForLandlordMock.mockClear()
  generateBillsForLandlordMock.mockResolvedValue([])
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_utility'
})

interface Fixture {
  landlordAUserId: string
  landlordAId:     string
  landlordBUserId: string
  landlordBId:     string
  propertyAId:     string
  propertyBId:     string
  unitAId:         string
  unitBId:         string
  tenantAId:       string
  leaseAId:        string
  adminToken:      string
  tokenA:          string
  tokenB:          string
  tenantToken:     string
}

async function seed(): Promise<Fixture> {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const { userId: aUid, landlordId: aId } = await seedLandlord(c)
    const { userId: bUid, landlordId: bId } = await seedLandlord(c)
    const propA = await seedProperty(c, { landlordId: aId, ownerUserId: aUid, managedByUserId: aUid })
    const propB = await seedProperty(c, { landlordId: bId, ownerUserId: bUid, managedByUserId: bUid })
    const unitA = await seedUnit(c, { propertyId: propA, landlordId: aId })
    const unitB = await seedUnit(c, { propertyId: propB, landlordId: bId })
    const tenantA = await seedTenant(c)
    const taUser = await c.query<{ user_id: string }>(`SELECT user_id FROM tenants WHERE id=$1`, [tenantA])
    const leaseA = await seedLease(c, { unitId: unitA, landlordId: aId, status: 'active' })
    await seedLeaseTenant(c, { leaseId: leaseA, tenantId: tenantA })
    const admin = await c.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
       VALUES ($1, 'x', 'admin', 'A', 'U', TRUE) RETURNING id`,
      [`admin-${randomUUID()}@test.dev`])
    await c.query('COMMIT')
    const sign = (p: object) => jwt.sign(p, process.env.JWT_SECRET!, { expiresIn: '1h' })
    return {
      landlordAUserId: aUid, landlordAId: aId,
      landlordBUserId: bUid, landlordBId: bId,
      propertyAId: propA, propertyBId: propB,
      unitAId: unitA, unitBId: unitB,
      tenantAId: tenantA, leaseAId: leaseA,
      adminToken:  sign({ userId: admin.rows[0].id, role: 'admin', email: 'a@t.dev', profileId: null, permissions: {} }),
      tokenA:      sign({ userId: aUid, role: 'landlord', email: 'la@t.dev', profileId: aId, permissions: {} }),
      tokenB:      sign({ userId: bUid, role: 'landlord', email: 'lb@t.dev', profileId: bId, permissions: {} }),
      tenantToken: sign({ userId: taUser.rows[0].user_id, role: 'tenant', email: 't@t.dev', profileId: tenantA, permissions: {} }),
    }
  } catch (e) { await c.query('ROLLBACK'); throw e }
  finally { c.release() }
}

async function seedMeter(f: Fixture, propertyId: string, opts: { billingMethod?: 'submeter' | 'rubs' | 'master_bill_to_landlord' } = {}): Promise<string> {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const id = await seedUtilityMeter(c, { propertyId, billingMethod: opts.billingMethod ?? 'submeter' })
    await c.query('COMMIT')
    return id
  } finally { c.release() }
}

async function seedBill(f: Fixture, meterId: string): Promise<string> {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const id = await seedUtilityBill(c, {
      meterId, unitId: f.unitAId, tenantId: f.tenantAId,
      leaseId: f.leaseAId, landlordId: f.landlordAId,
      chargeAmount: 100, status: 'unbilled',
    })
    await c.query('COMMIT')
    return id
  } finally { c.release() }
}

// ───────────────────────────────────────────────────────────────────
// GET /bills
// ───────────────────────────────────────────────────────────────────

describe('GET /bills', () => {
  it('tenant: sees only own bills', async () => {
    const f = await seed()
    const meter = await seedMeter(f, f.propertyAId)
    await seedBill(f, meter)
    const res = await request(buildApp())
      .get('/api/utility/bills')
      .set('Authorization', `Bearer ${f.tenantToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(1)
    expect(res.body.data[0].tenant_id).toBe(f.tenantAId)
  })

  it('landlord: sees own-landlord bills only', async () => {
    const f = await seed()
    const meterA = await seedMeter(f, f.propertyAId)
    await seedBill(f, meterA)
    const res = await request(buildApp())
      .get('/api/utility/bills')
      .set('Authorization', `Bearer ${f.tokenA}`)
    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(1)
    const resB = await request(buildApp())
      .get('/api/utility/bills')
      .set('Authorization', `Bearer ${f.tokenB}`)
    expect(resB.body.data).toEqual([])
  })
})

// ───────────────────────────────────────────────────────────────────
// GET /meters — S396 scope fix
// ───────────────────────────────────────────────────────────────────

describe('GET /meters — S396 scope fix', () => {
  it('landlord with no propertyId filter: sees own meters only', async () => {
    const f = await seed()
    await seedMeter(f, f.propertyAId)
    await seedMeter(f, f.propertyBId)
    const res = await request(buildApp())
      .get('/api/utility/meters')
      .set('Authorization', `Bearer ${f.tokenA}`)
    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(1)
  })

  it('S396 fix: landlord A with ?propertyId=<B propertyId> → 404 (was: leaked B meters)', async () => {
    const f = await seed()
    await seedMeter(f, f.propertyBId)
    const res = await request(buildApp())
      .get(`/api/utility/meters?propertyId=${f.propertyBId}`)
      .set('Authorization', `Bearer ${f.tokenA}`)
    expect(res.status).toBe(404)
    expect(res.body.error).toMatch(/property not found/i)
  })

  it('landlord A with ?propertyId=<own propertyId> → 200 with own meters', async () => {
    const f = await seed()
    await seedMeter(f, f.propertyAId)
    const res = await request(buildApp())
      .get(`/api/utility/meters?propertyId=${f.propertyAId}`)
      .set('Authorization', `Bearer ${f.tokenA}`)
    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(1)
  })

  it('admin with ?propertyId=any → 200 (admin bypasses ownership)', async () => {
    const f = await seed()
    await seedMeter(f, f.propertyBId)
    const res = await request(buildApp())
      .get(`/api/utility/meters?propertyId=${f.propertyBId}`)
      .set('Authorization', `Bearer ${f.adminToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(1)
  })
})

// ───────────────────────────────────────────────────────────────────
// POST /meters
// ───────────────────────────────────────────────────────────────────

describe('POST /meters', () => {
  it('cross-landlord property → 403', async () => {
    const f = await seed()
    const res = await request(buildApp())
      .post('/api/utility/meters')
      .set('Authorization', `Bearer ${f.tokenA}`)
      .send({
        propertyId: f.propertyBId, utilityType: 'water', label: 'X',
        billingMethod: 'submeter',
      })
    expect(res.status).toBe(403)
  })

  it('RUBS without rubsAllocationMethod → 400', async () => {
    const f = await seed()
    const res = await request(buildApp())
      .post('/api/utility/meters')
      .set('Authorization', `Bearer ${f.tokenA}`)
      .send({
        propertyId: f.propertyAId, utilityType: 'water', label: 'X',
        billingMethod: 'rubs',
      })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/rubs.*requires.*rubsAllocationMethod/i)
  })

  it('non-RUBS with rubsAllocationMethod → 400', async () => {
    const f = await seed()
    const res = await request(buildApp())
      .post('/api/utility/meters')
      .set('Authorization', `Bearer ${f.tokenA}`)
      .send({
        propertyId: f.propertyAId, utilityType: 'water', label: 'X',
        billingMethod: 'submeter', rubsAllocationMethod: 'sqft',
      })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/only valid when.*rubs/i)
  })

  it('happy: submeter creates meter, baseFee defaults 0', async () => {
    const f = await seed()
    const res = await request(buildApp())
      .post('/api/utility/meters')
      .set('Authorization', `Bearer ${f.tokenA}`)
      .send({
        propertyId: f.propertyAId, utilityType: 'water', label: 'Bldg A',
        billingMethod: 'submeter', ratePerUnit: 0.05,
      })
    expect(res.status).toBe(201)
    expect(res.body.data.utility_type).toBe('water')
    expect(Number(res.body.data.base_fee)).toBe(0)
  })
})

// ───────────────────────────────────────────────────────────────────
// PATCH /meters/:id
// ───────────────────────────────────────────────────────────────────

describe('PATCH /meters/:id', () => {
  it('unknown id → 404', async () => {
    const f = await seed()
    const res = await request(buildApp())
      .patch(`/api/utility/meters/${randomUUID()}`)
      .set('Authorization', `Bearer ${f.tokenA}`)
      .send({ label: 'X' })
    expect(res.status).toBe(404)
  })

  it('cross-landlord → 403', async () => {
    const f = await seed()
    const meterB = await seedMeter(f, f.propertyBId)
    const res = await request(buildApp())
      .patch(`/api/utility/meters/${meterB}`)
      .set('Authorization', `Bearer ${f.tokenA}`)
      .send({ label: 'Hijack' })
    expect(res.status).toBe(403)
  })

  it('happy: updates label + rate', async () => {
    const f = await seed()
    const m = await seedMeter(f, f.propertyAId)
    const res = await request(buildApp())
      .patch(`/api/utility/meters/${m}`)
      .set('Authorization', `Bearer ${f.tokenA}`)
      .send({ label: 'Updated', ratePerUnit: 0.10 })
    expect(res.status).toBe(200)
    expect(res.body.data.label).toBe('Updated')
    expect(Number(res.body.data.rate_per_unit)).toBe(0.1)
  })
})

// ───────────────────────────────────────────────────────────────────
// DELETE /meters/:id
// ───────────────────────────────────────────────────────────────────

describe('DELETE /meters/:id', () => {
  it('cross-landlord → 403', async () => {
    const f = await seed()
    const m = await seedMeter(f, f.propertyBId)
    const res = await request(buildApp())
      .delete(`/api/utility/meters/${m}`)
      .set('Authorization', `Bearer ${f.tokenA}`)
    expect(res.status).toBe(403)
  })

  it('meter with bills → 409 (RESTRICT FK)', async () => {
    const f = await seed()
    const m = await seedMeter(f, f.propertyAId)
    await seedBill(f, m)
    const res = await request(buildApp())
      .delete(`/api/utility/meters/${m}`)
      .set('Authorization', `Bearer ${f.tokenA}`)
    expect(res.status).toBe(409)
    expect(res.body.error).toMatch(/existing bills/i)
  })

  it('happy: meter without bills deletes', async () => {
    const f = await seed()
    const m = await seedMeter(f, f.propertyAId)
    const res = await request(buildApp())
      .delete(`/api/utility/meters/${m}`)
      .set('Authorization', `Bearer ${f.tokenA}`)
    expect(res.status).toBe(200)
  })
})

// ───────────────────────────────────────────────────────────────────
// POST /meters/:id/units + DELETE
// ───────────────────────────────────────────────────────────────────

describe('POST /meters/:id/units', () => {
  it('cross-landlord unitId → 404', async () => {
    const f = await seed()
    const m = await seedMeter(f, f.propertyAId)
    const res = await request(buildApp())
      .post(`/api/utility/meters/${m}/units`)
      .set('Authorization', `Bearer ${f.tokenA}`)
      .send({ unitId: f.unitBId })  // landlord B's unit
    expect(res.status).toBe(404)
    expect(res.body.error).toMatch(/unit not found/i)
  })

  it('happy: assigns own unit; ON CONFLICT DO NOTHING is idempotent', async () => {
    const f = await seed()
    const m = await seedMeter(f, f.propertyAId)
    const r1 = await request(buildApp())
      .post(`/api/utility/meters/${m}/units`)
      .set('Authorization', `Bearer ${f.tokenA}`)
      .send({ unitId: f.unitAId })
    expect(r1.status).toBe(201)
    const r2 = await request(buildApp())
      .post(`/api/utility/meters/${m}/units`)
      .set('Authorization', `Bearer ${f.tokenA}`)
      .send({ unitId: f.unitAId })
    expect(r2.status).toBe(201)  // idempotent
    const rows = await db.query(`SELECT 1 FROM utility_meter_units WHERE meter_id=$1 AND unit_id=$2`,
      [m, f.unitAId])
    expect(rows.rows).toHaveLength(1)
  })
})

describe('DELETE /meters/:id/units/:unitId', () => {
  it('happy: removes assignment', async () => {
    const f = await seed()
    const m = await seedMeter(f, f.propertyAId)
    await db.query(`INSERT INTO utility_meter_units (meter_id, unit_id) VALUES ($1, $2)`,
      [m, f.unitAId])
    const res = await request(buildApp())
      .delete(`/api/utility/meters/${m}/units/${f.unitAId}`)
      .set('Authorization', `Bearer ${f.tokenA}`)
    expect(res.status).toBe(200)
    const rows = await db.query(`SELECT 1 FROM utility_meter_units WHERE meter_id=$1 AND unit_id=$2`,
      [m, f.unitAId])
    expect(rows.rows).toHaveLength(0)
  })
})

// ───────────────────────────────────────────────────────────────────
// GET + POST /meters/:id/readings
// ───────────────────────────────────────────────────────────────────

describe('Meter readings', () => {
  it('GET readings: cross-landlord → 403', async () => {
    const f = await seed()
    const m = await seedMeter(f, f.propertyBId)
    const res = await request(buildApp())
      .get(`/api/utility/meters/${m}/readings`)
      .set('Authorization', `Bearer ${f.tokenA}`)
    expect(res.status).toBe(403)
  })

  it('GET readings happy: returns readings DESC by cycle/date', async () => {
    const f = await seed()
    const m = await seedMeter(f, f.propertyAId)
    await db.query(
      `INSERT INTO utility_meter_readings (meter_id, reading_date, reading_value, billing_cycle_month, created_by_user_id) VALUES
        ($1, '2026-05-15', 100, '2026-05-01', $2),
        ($1, '2026-04-15', 80, '2026-04-01', $2)`,
      [m, f.landlordAUserId])
    const res = await request(buildApp())
      .get(`/api/utility/meters/${m}/readings`)
      .set('Authorization', `Bearer ${f.tokenA}`)
    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(2)
    expect(res.body.data[0].billing_cycle_month).toMatch(/2026-05/)
  })

  it('POST reading happy: stores reading + stamps created_by_user_id', async () => {
    const f = await seed()
    const m = await seedMeter(f, f.propertyAId)
    const res = await request(buildApp())
      .post(`/api/utility/meters/${m}/readings`)
      .set('Authorization', `Bearer ${f.tokenA}`)
      .send({ readingDate: '2026-06-01', readingValue: 150, billingCycleMonth: '2026-06-01' })
    expect(res.status).toBe(201)
    expect(Number(res.body.data.reading_value)).toBe(150)
    expect(res.body.data.created_by_user_id).toBe(f.landlordAUserId)
  })
})

// ───────────────────────────────────────────────────────────────────
// POST /generate-bills
// ───────────────────────────────────────────────────────────────────

describe('POST /generate-bills', () => {
  it('invalid cycleMonth format → 400', async () => {
    const f = await seed()
    const res = await request(buildApp())
      .post('/api/utility/generate-bills')
      .set('Authorization', `Bearer ${f.tokenA}`)
      .send({ cycleMonth: '2026-06-15' })  // not YYYY-MM-01
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/cycleMonth must be YYYY-MM-01/i)
  })

  it('meterId branch: cross-landlord → 403; happy calls service', async () => {
    const f = await seed()
    const meterB = await seedMeter(f, f.propertyBId)
    const r1 = await request(buildApp())
      .post('/api/utility/generate-bills')
      .set('Authorization', `Bearer ${f.tokenA}`)
      .send({ cycleMonth: '2026-06-01', meterId: meterB })
    expect(r1.status).toBe(403)

    const meterA = await seedMeter(f, f.propertyAId)
    const r2 = await request(buildApp())
      .post('/api/utility/generate-bills')
      .set('Authorization', `Bearer ${f.tokenA}`)
      .send({ cycleMonth: '2026-06-01', meterId: meterA })
    expect(r2.status).toBe(200)
    expect(generateBillsForMeterMock).toHaveBeenCalledWith(meterA, expect.any(Date))
  })

  it('propertyId branch: cross-landlord → 403', async () => {
    const f = await seed()
    const res = await request(buildApp())
      .post('/api/utility/generate-bills')
      .set('Authorization', `Bearer ${f.tokenA}`)
      .send({ cycleMonth: '2026-06-01', propertyId: f.propertyBId })
    expect(res.status).toBe(403)
  })

  it('no scope arg: calls generateBillsForLandlord with caller id', async () => {
    const f = await seed()
    const res = await request(buildApp())
      .post('/api/utility/generate-bills')
      .set('Authorization', `Bearer ${f.tokenA}`)
      .send({ cycleMonth: '2026-06-01' })
    expect(res.status).toBe(200)
    expect(generateBillsForLandlordMock).toHaveBeenCalledWith(f.landlordAId, expect.any(Date))
  })

  it('admin with no scope arg → 400 (must specify)', async () => {
    const f = await seed()
    const res = await request(buildApp())
      .post('/api/utility/generate-bills')
      .set('Authorization', `Bearer ${f.adminToken}`)
      .send({ cycleMonth: '2026-06-01' })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/meterId or propertyId required/i)
  })
})

// ───────────────────────────────────────────────────────────────────
// POST /bills/:id/finalize
// ───────────────────────────────────────────────────────────────────

describe('POST /bills/:id/finalize', () => {
  it('unknown bill → 404', async () => {
    const f = await seed()
    const res = await request(buildApp())
      .post(`/api/utility/bills/${randomUUID()}/finalize`)
      .set('Authorization', `Bearer ${f.tokenA}`)
    expect(res.status).toBe(404)
  })

  it('cross-landlord → 403', async () => {
    const f = await seed()
    const meterB = await seedMeter(f, f.propertyBId)
    // Seed a B bill (need a B tenant + lease)
    const tenantB = await db.connect().then(async c => {
      try { await c.query('BEGIN'); const t = await seedTenant(c); await c.query('COMMIT'); return t }
      finally { c.release() }
    })
    const leaseB = await db.connect().then(async c => {
      try { await c.query('BEGIN')
        const l = await seedLease(c, { unitId: f.unitBId, landlordId: f.landlordBId, status: 'active' })
        await seedLeaseTenant(c, { leaseId: l, tenantId: tenantB })
        await c.query('COMMIT')
        return l
      } finally { c.release() }
    })
    const billB = await db.connect().then(async c => {
      try { await c.query('BEGIN')
        const id = await seedUtilityBill(c, {
          meterId: meterB, unitId: f.unitBId, tenantId: tenantB, leaseId: leaseB,
          landlordId: f.landlordBId, chargeAmount: 50, status: 'unbilled',
        })
        await c.query('COMMIT')
        return id
      } finally { c.release() }
    })
    const res = await request(buildApp())
      .post(`/api/utility/bills/${billB}/finalize`)
      .set('Authorization', `Bearer ${f.tokenA}`)
    expect(res.status).toBe(403)
  })

  it('non-unbilled status → 409', async () => {
    const f = await seed()
    const m = await seedMeter(f, f.propertyAId)
    const bill = await db.connect().then(async c => {
      try { await c.query('BEGIN')
        const id = await seedUtilityBill(c, {
          meterId: m, unitId: f.unitAId, tenantId: f.tenantAId, leaseId: f.leaseAId,
          landlordId: f.landlordAId, chargeAmount: 100, status: 'billed',
        })
        await c.query('COMMIT')
        return id
      } finally { c.release() }
    })
    const res = await request(buildApp())
      .post(`/api/utility/bills/${bill}/finalize`)
      .set('Authorization', `Bearer ${f.tokenA}`)
    expect(res.status).toBe(409)
    expect(res.body.error).toMatch(/only 'unbilled' can be finalized/i)
  })

  it('happy: flips status unbilled → billed + stamps billed_at', async () => {
    const f = await seed()
    const m = await seedMeter(f, f.propertyAId)
    const bill = await seedBill(f, m)  // status='unbilled' from helper default
    const res = await request(buildApp())
      .post(`/api/utility/bills/${bill}/finalize`)
      .set('Authorization', `Bearer ${f.tokenA}`)
    expect(res.status).toBe(200)
    expect(res.body.data.status).toBe('billed')
    expect(res.body.data.billed_at).not.toBeNull()
  })
})

// ───────────────────────────────────────────────────────────────────
// POST /bills/:id/pay (deprecated S178)
// ───────────────────────────────────────────────────────────────────

describe('POST /bills/:id/pay (deprecated)', () => {
  it('non-tenant → 403', async () => {
    const f = await seed()
    const res = await request(buildApp())
      .post(`/api/utility/bills/${randomUUID()}/pay`)
      .set('Authorization', `Bearer ${f.tokenA}`)
    expect(res.status).toBe(403)
  })

  it('tenant unknown bill → 404', async () => {
    const f = await seed()
    const res = await request(buildApp())
      .post(`/api/utility/bills/${randomUUID()}/pay`)
      .set('Authorization', `Bearer ${f.tenantToken}`)
    expect(res.status).toBe(404)
  })

  it('tenant own bill not invoiced yet → 409', async () => {
    const f = await seed()
    const m = await seedMeter(f, f.propertyAId)
    const bill = await seedBill(f, m)  // no payment_id linked
    const res = await request(buildApp())
      .post(`/api/utility/bills/${bill}/pay`)
      .set('Authorization', `Bearer ${f.tenantToken}`)
    expect(res.status).toBe(409)
    expect(res.body.error).toMatch(/not been invoiced yet/i)
  })

  it('tenant own bill with payment_id → 410 with redirect to /payments/:id/pay', async () => {
    const f = await seed()
    const m = await seedMeter(f, f.propertyAId)
    // Seed a payment first to link the bill to
    const p = await db.query<{ id: string }>(
      `INSERT INTO payments (unit_id, tenant_id, landlord_id, type, amount, status, entry_description, due_date)
       VALUES ($1, $2, $3, 'utility', 100, 'pending', 'UTILITY', CURRENT_DATE) RETURNING id`,
      [f.unitAId, f.tenantAId, f.landlordAId])
    const bill = await db.connect().then(async c => {
      try { await c.query('BEGIN')
        const id = await seedUtilityBill(c, {
          meterId: m, unitId: f.unitAId, tenantId: f.tenantAId, leaseId: f.leaseAId,
          landlordId: f.landlordAId, chargeAmount: 100, status: 'billed',
          paymentId: p.rows[0].id,
        })
        await c.query('COMMIT')
        return id
      } finally { c.release() }
    })
    const res = await request(buildApp())
      .post(`/api/utility/bills/${bill}/pay`)
      .set('Authorization', `Bearer ${f.tenantToken}`)
    expect(res.status).toBe(410)
    expect(res.body.error).toContain(p.rows[0].id)
  })
})
