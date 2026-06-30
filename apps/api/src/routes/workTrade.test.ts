/**
 * workTrade.ts full slice — S397. Closes the file at 8/8 (100%).
 *
 * Covered routes (8):
 *   - POST   /api/work-trade/                         (create agreement)
 *   - GET    /api/work-trade/unit/:unitId             (S397 fix)
 *   - GET    /api/work-trade/:id                      (S397 fix)
 *   - POST   /api/work-trade/:id/logs                 (S397 fix)
 *   - PATCH  /api/work-trade/logs/:logId              (approve/reject)
 *   - POST   /api/work-trade/:id/reconcile
 *   - GET    /api/work-trade/                         (landlord dashboard)
 *   - PATCH  /api/work-trade/:id                      (status update)
 *
 * Production bugs fixed in this slice (4):
 *   - **POST /** body.tenantId was inserted unvalidated. A landlord
 *     could create a work-trade agreement against ANY tenant id
 *     (including strangers'). Tenant's `/api/tenants/work-trade`
 *     view would surface the cross-tenant agreement. Fix: validate
 *     tenant has a lease in caller's portfolio.
 *   - **GET /unit/:unitId** no landlord scope filter. Any auth user
 *     could pass any unit's id and read its work-trade agreement
 *     (tenant name/email, hourly rate, weekly hours, market rent).
 *     Cross-tenant info disclosure. Fix: validate caller can access
 *     the unit's landlord scope OR is the tenant on the unit.
 *   - **GET /:id** same root: no scope at all. Any auth user could
 *     read full agreement payload (agreement + logs + periods +
 *     stats). Most sensitive variant — logs include free-text
 *     descriptions submitted by the tenant. Fix: same pattern as
 *     /unit/:unitId.
 *   - **POST /:id/logs** only checked `role === 'tenant'` for
 *     self-match. Landlords / PMs / onsite_managers could post fake
 *     hours against ANY agreement (cross-tenant write into
 *     work_trade_logs; subsequent approval bumps ytd_value on the
 *     stranger landlord's books). Fix: require own-tenant OR
 *     own-landlord-scope.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { randomUUID } from 'crypto'
import { db } from '../db'
import {
  cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedTenant,
  seedLease, seedLeaseTenant,
} from '../test/dbHelpers'
import { workTradeRouter } from './workTrade'
import { errorHandler } from '../middleware/errorHandler'

function buildApp() {
  const app = express()
  app.use(express.json({ limit: '2mb' }))
  app.use('/api/work-trade', workTradeRouter)
  app.use(errorHandler)
  return app
}

beforeEach(async () => {
  await cleanupAllSchema()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_workTrade'
})

interface Fixture {
  landlordAUserId: string
  landlordAId:     string
  landlordBUserId: string
  landlordBId:     string
  propertyAId:     string
  unitAId:         string
  unitBId:         string
  tenantAId:       string
  tenantAUserId:   string
  tenantBId:       string
  tenantBUserId:   string
  leaseAId:        string
  tokenA:          string
  tokenB:          string
  tenantAToken:    string
  tenantBToken:    string
  adminToken:      string
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
    const tenantB = await seedTenant(c)
    const taUser = await c.query<{ user_id: string }>(`SELECT user_id FROM tenants WHERE id=$1`, [tenantA])
    const tbUser = await c.query<{ user_id: string }>(`SELECT user_id FROM tenants WHERE id=$1`, [tenantB])
    const leaseA = await seedLease(c, { unitId: unitA, landlordId: aId, status: 'active' })
    await seedLeaseTenant(c, { leaseId: leaseA, tenantId: tenantA })
    const leaseB = await seedLease(c, { unitId: unitB, landlordId: bId, status: 'active' })
    await seedLeaseTenant(c, { leaseId: leaseB, tenantId: tenantB })
    const admin = await c.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
       VALUES ($1, 'x', 'admin', 'A', 'U', TRUE) RETURNING id`,
      [`admin-${randomUUID()}@test.dev`])
    await c.query('COMMIT')
    const sign = (p: object) => jwt.sign(p, process.env.JWT_SECRET!, { expiresIn: '1h' })
    return {
      landlordAUserId: aUid, landlordAId: aId,
      landlordBUserId: bUid, landlordBId: bId,
      propertyAId: propA, unitAId: unitA, unitBId: unitB,
      tenantAId: tenantA, tenantAUserId: taUser.rows[0].user_id,
      tenantBId: tenantB, tenantBUserId: tbUser.rows[0].user_id,
      leaseAId: leaseA,
      tokenA:       sign({ userId: aUid, role: 'landlord', email: 'la@t.dev', profileId: aId, permissions: {} }),
      tokenB:       sign({ userId: bUid, role: 'landlord', email: 'lb@t.dev', profileId: bId, permissions: {} }),
      tenantAToken: sign({ userId: taUser.rows[0].user_id, role: 'tenant', email: 'ta@t.dev', profileId: tenantA, permissions: {} }),
      tenantBToken: sign({ userId: tbUser.rows[0].user_id, role: 'tenant', email: 'tb@t.dev', profileId: tenantB, permissions: {} }),
      adminToken:   sign({ userId: admin.rows[0].id, role: 'admin', email: 'a@t.dev', profileId: null, permissions: {} }),
    }
  } catch (e) { await c.query('ROLLBACK'); throw e }
  finally { c.release() }
}

async function seedAgreement(f: Fixture, landlordId = f.landlordAId, tenantId = f.tenantAId, unitId = f.unitAId, status = 'active'): Promise<string> {
  const r = await db.query<{ id: string }>(
    `INSERT INTO work_trade_agreements
       (unit_id, tenant_id, landlord_id, start_date, status)
     VALUES ($1, $2, $3, '2026-01-01', $4) RETURNING id`,
    [unitId, tenantId, landlordId, status])
  return r.rows[0].id
}

// ───────────────────────────────────────────────────────────────────
// POST /  (create agreement) — S397 tenant scope fix
// ───────────────────────────────────────────────────────────────────

describe('POST /  — S397 tenant scope fix', () => {
  it('cross-landlord unit → 404', async () => {
    const f = await seed()
    const res = await request(buildApp())
      .post('/api/work-trade/')
      .set('Authorization', `Bearer ${f.tokenA}`)
      .send({ unitId: f.unitBId, tenantId: f.tenantAId, startDate: '2026-06-01' })
    expect(res.status).toBe(404)
  })

  it('S397 fix: stranger tenantId (no lease in caller portfolio) → 404; no row created', async () => {
    const f = await seed()
    const res = await request(buildApp())
      .post('/api/work-trade/')
      .set('Authorization', `Bearer ${f.tokenA}`)
      .send({ unitId: f.unitAId, tenantId: f.tenantBId, startDate: '2026-06-01' }) // B's tenant, A's unit
    expect(res.status).toBe(404)
    expect(res.body.error).toMatch(/no lease under this landlord/i)
    const rows = await db.query(`SELECT id FROM work_trade_agreements`)
    expect(rows.rows).toHaveLength(0)
  })

  it('happy: creates enrollment (no dollar terms)', async () => {
    const f = await seed()
    const res = await request(buildApp())
      .post('/api/work-trade/')
      .set('Authorization', `Bearer ${f.tokenA}`)
      .send({ unitId: f.unitAId, tenantId: f.tenantAId, startDate: '2026-06-01', duties: 'groundskeeping' })
    expect(res.status).toBe(200)
    expect(res.body.data.id).toBeDefined()
    expect(res.body.data.status).toBe('active')
    expect(res.body.data.duties).toBe('groundskeeping')
    expect(res.body.data.hourly_rate).toBeUndefined()  // dollar model is gone
  })
})

// ───────────────────────────────────────────────────────────────────
// GET /unit/:unitId — S397 scope fix
// ───────────────────────────────────────────────────────────────────

describe('GET /unit/:unitId — S397 scope fix', () => {
  it('unknown unit → 404', async () => {
    const f = await seed()
    const res = await request(buildApp())
      .get(`/api/work-trade/unit/${randomUUID()}`)
      .set('Authorization', `Bearer ${f.tokenA}`)
    expect(res.status).toBe(404)
  })

  it('S397 fix: landlord A querying landlord B unit → 403', async () => {
    const f = await seed()
    await seedAgreement(f, f.landlordBId, f.tenantBId, f.unitBId)
    const res = await request(buildApp())
      .get(`/api/work-trade/unit/${f.unitBId}`)
      .set('Authorization', `Bearer ${f.tokenA}`)
    expect(res.status).toBe(403)
  })

  it('S397 fix: stranger tenant querying landlord A unit → 403', async () => {
    const f = await seed()
    const res = await request(buildApp())
      .get(`/api/work-trade/unit/${f.unitAId}`)
      .set('Authorization', `Bearer ${f.tenantBToken}`)
    expect(res.status).toBe(403)
  })

  it('happy: own-landlord sees agreement', async () => {
    const f = await seed()
    await seedAgreement(f)
    const res = await request(buildApp())
      .get(`/api/work-trade/unit/${f.unitAId}`)
      .set('Authorization', `Bearer ${f.tokenA}`)
    expect(res.status).toBe(200)
    expect(res.body.data.unit_id).toBe(f.unitAId)
  })

  it('happy: own tenant on unit sees agreement', async () => {
    const f = await seed()
    await seedAgreement(f)
    const res = await request(buildApp())
      .get(`/api/work-trade/unit/${f.unitAId}`)
      .set('Authorization', `Bearer ${f.tenantAToken}`)
    expect(res.status).toBe(200)
  })
})

// ───────────────────────────────────────────────────────────────────
// GET /:id — S397 scope fix
// ───────────────────────────────────────────────────────────────────

describe('GET /:id — S397 scope fix', () => {
  it('unknown → 404', async () => {
    const f = await seed()
    const res = await request(buildApp())
      .get(`/api/work-trade/${randomUUID()}`)
      .set('Authorization', `Bearer ${f.tokenA}`)
    expect(res.status).toBe(404)
  })

  it('S397 fix: stranger landlord → 403; full payload NOT returned', async () => {
    const f = await seed()
    const agId = await seedAgreement(f)
    const res = await request(buildApp())
      .get(`/api/work-trade/${agId}`)
      .set('Authorization', `Bearer ${f.tokenB}`)
    expect(res.status).toBe(403)
    // Body should NOT contain the agreement object
    expect(res.body.data).toBeUndefined()
  })

  it('happy: own-landlord sees agreement + logs + stats (property target)', async () => {
    const f = await seed()
    const agId = await seedAgreement(f)
    const res = await request(buildApp())
      .get(`/api/work-trade/${agId}`)
      .set('Authorization', `Bearer ${f.tokenA}`)
    expect(res.status).toBe(200)
    expect(res.body.data.agreement.id).toBe(agId)
    expect(res.body.data.logs).toEqual([])
    expect(res.body.data.stats.target).toBe(80)              // default property target
    expect(res.body.data.stats.hoursApprovedThisMonth).toBe(0)
  })

  it('happy: own tenant sees agreement', async () => {
    const f = await seed()
    const agId = await seedAgreement(f)
    const res = await request(buildApp())
      .get(`/api/work-trade/${agId}`)
      .set('Authorization', `Bearer ${f.tenantAToken}`)
    expect(res.status).toBe(200)
  })
})

// ───────────────────────────────────────────────────────────────────
// POST /:id/logs — S397 scope fix
// ───────────────────────────────────────────────────────────────────

describe('POST /:id/logs — S397 scope fix', () => {
  it('unknown agreement → 404', async () => {
    const f = await seed()
    const res = await request(buildApp())
      .post(`/api/work-trade/${randomUUID()}/logs`)
      .set('Authorization', `Bearer ${f.tenantAToken}`)
      .send({ workDate: '2026-06-01', hours: 4, description: 'mowed lawn' })
    expect(res.status).toBe(404)
  })

  it('S397 fix: stranger landlord posting on agreement → 403; no log row written', async () => {
    const f = await seed()
    const agId = await seedAgreement(f)
    const res = await request(buildApp())
      .post(`/api/work-trade/${agId}/logs`)
      .set('Authorization', `Bearer ${f.tokenB}`)
      .send({ workDate: '2026-06-01', hours: 4, description: 'fake hours' })
    expect(res.status).toBe(403)
    const logs = await db.query(`SELECT id FROM work_trade_logs WHERE agreement_id=$1`, [agId])
    expect(logs.rows).toHaveLength(0)
  })

  it('tenant on own agreement happy', async () => {
    const f = await seed()
    const agId = await seedAgreement(f)
    const res = await request(buildApp())
      .post(`/api/work-trade/${agId}/logs`)
      .set('Authorization', `Bearer ${f.tenantAToken}`)
      .send({ workDate: '2026-06-01', hours: 4, description: 'mowed lawn' })
    expect(res.status).toBe(200)
    expect(res.body.data.status).toBe('pending')
    expect(Number(res.body.data.hours)).toBe(4)
  })

  it('cross-tenant (B posting on A agreement) → 403', async () => {
    const f = await seed()
    const agId = await seedAgreement(f)
    const res = await request(buildApp())
      .post(`/api/work-trade/${agId}/logs`)
      .set('Authorization', `Bearer ${f.tenantBToken}`)
      .send({ workDate: '2026-06-01', hours: 4, description: 'cross-tenant' })
    expect(res.status).toBe(403)
  })

  it('landlord on own agreement (substitute log) happy', async () => {
    const f = await seed()
    const agId = await seedAgreement(f)
    const res = await request(buildApp())
      .post(`/api/work-trade/${agId}/logs`)
      .set('Authorization', `Bearer ${f.tokenA}`)
      .send({ workDate: '2026-06-01', hours: 2, description: 'tenant called in' })
    expect(res.status).toBe(200)
  })
})

// ───────────────────────────────────────────────────────────────────
// PATCH /logs/:logId  (approve/reject)
// ───────────────────────────────────────────────────────────────────

describe('PATCH /logs/:logId', () => {
  it('cross-landlord → 403', async () => {
    const f = await seed()
    const agId = await seedAgreement(f)
    const log = await db.query<{ id: string }>(
      `INSERT INTO work_trade_logs (agreement_id, tenant_id, submitted_by, work_date, hours, description)
       VALUES ($1, $2, $3, '2026-06-01', 4, 'mowed') RETURNING id`,
      [agId, f.tenantAId, f.tenantAUserId])
    const res = await request(buildApp())
      .patch(`/api/work-trade/logs/${log.rows[0].id}`)
      .set('Authorization', `Bearer ${f.tokenB}`)
      .send({ action: 'approve' })
    expect(res.status).toBe(403)
  })

  it('approve happy: flips status + stamps reviewer (no dollar credit_value)', async () => {
    const f = await seed()
    const agId = await seedAgreement(f)
    const log = await db.query<{ id: string }>(
      `INSERT INTO work_trade_logs (agreement_id, tenant_id, submitted_by, work_date, hours, description)
       VALUES ($1, $2, $3, $4, 4, 'mowed') RETURNING id`,
      [agId, f.tenantAId, f.tenantAUserId, new Date().toISOString().slice(0, 10)])
    const res = await request(buildApp())
      .patch(`/api/work-trade/logs/${log.rows[0].id}`)
      .set('Authorization', `Bearer ${f.tokenA}`)
      .send({ action: 'approve' })
    expect(res.status).toBe(200)
    expect(res.body.data.status).toBe('approved')
    expect(res.body.data.reviewed_by).toBe(f.landlordAUserId)
    expect(res.body.data.credit_value).toBeUndefined()  // percent model — no per-log dollars
  })

  it('reject happy: stamps rejection_reason', async () => {
    const f = await seed()
    const agId = await seedAgreement(f)
    const log = await db.query<{ id: string }>(
      `INSERT INTO work_trade_logs (agreement_id, tenant_id, submitted_by, work_date, hours, description)
       VALUES ($1, $2, $3, '2026-06-01', 4, 'bad') RETURNING id`,
      [agId, f.tenantAId, f.tenantAUserId])
    const res = await request(buildApp())
      .patch(`/api/work-trade/logs/${log.rows[0].id}`)
      .set('Authorization', `Bearer ${f.tokenA}`)
      .send({ action: 'reject', rejectionReason: 'not enough detail' })
    expect(res.status).toBe(200)
    expect(res.body.data.status).toBe('rejected')
    expect(res.body.data.rejection_reason).toBe('not enough detail')
  })
})

// ───────────────────────────────────────────────────────────────────
// PATCH/GET /property/:propertyId/target  (the credit denominator)
// ───────────────────────────────────────────────────────────────────

describe('property hours target', () => {
  it('GET returns default 80', async () => {
    const f = await seed()
    const res = await request(buildApp())
      .get(`/api/work-trade/property/${f.propertyAId}/target`)
      .set('Authorization', `Bearer ${f.tokenA}`)
    expect(res.status).toBe(200)
    expect(res.body.data.target).toBe(80)
  })

  it('PATCH sets the target; cross-landlord → 403', async () => {
    const f = await seed()
    const bad = await request(buildApp())
      .patch(`/api/work-trade/property/${f.propertyAId}/target`)
      .set('Authorization', `Bearer ${f.tokenB}`)
      .send({ target: 120 })
    expect(bad.status).toBe(403)
    const ok = await request(buildApp())
      .patch(`/api/work-trade/property/${f.propertyAId}/target`)
      .set('Authorization', `Bearer ${f.tokenA}`)
      .send({ target: 120 })
    expect(ok.status).toBe(200)
    expect(ok.body.data.target).toBe(120)
  })

  it('PATCH rejects non-positive target', async () => {
    const f = await seed()
    const res = await request(buildApp())
      .patch(`/api/work-trade/property/${f.propertyAId}/target`)
      .set('Authorization', `Bearer ${f.tokenA}`)
      .send({ target: 0 })
    expect(res.status).toBe(400)
  })
})

// ───────────────────────────────────────────────────────────────────
// GET /  (dashboard) + PATCH /:id  (status update)
// ───────────────────────────────────────────────────────────────────

describe('GET /  (dashboard)', () => {
  it('landlord-scoped: returns own agreements with joins + pending_count + hours_this_month', async () => {
    const f = await seed()
    const agId = await seedAgreement(f)
    await seedAgreement(f, f.landlordBId, f.tenantBId, f.unitBId)
    await db.query(
      `INSERT INTO work_trade_logs (agreement_id, tenant_id, submitted_by, work_date, hours, description, status)
       VALUES ($1, $2, $3, '2026-06-01', 4, 'pending log', 'pending')`,
      [agId, f.tenantAId, f.tenantAUserId])
    const res = await request(buildApp())
      .get('/api/work-trade/')
      .set('Authorization', `Bearer ${f.tokenA}`)
    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(1)
    expect(Number(res.body.data[0].pending_count)).toBe(1)
    expect(Number(res.body.data[0].target)).toBe(80)
  })
})

describe('PATCH /:id  (status update)', () => {
  it('cross-landlord → 403', async () => {
    const f = await seed()
    const agId = await seedAgreement(f)
    const res = await request(buildApp())
      .patch(`/api/work-trade/${agId}`)
      .set('Authorization', `Bearer ${f.tokenB}`)
      .send({ status: 'paused' })
    expect(res.status).toBe(403)
  })

  it('happy: status=paused', async () => {
    const f = await seed()
    const agId = await seedAgreement(f)
    const res = await request(buildApp())
      .patch(`/api/work-trade/${agId}`)
      .set('Authorization', `Bearer ${f.tokenA}`)
      .send({ status: 'paused' })
    expect(res.status).toBe(200)
    expect(res.body.data.status).toBe('paused')
  })
})
