/**
 * tenants.ts admin-views slice — S379 (tenants.ts slice 6 of N).
 *
 * Covered routes (3):
 *   - GET  /api/tenants/:id/profile — lifetime tenant profile
 *     (large aggregation: tenant + units + payments + maintenance
 *     + workTrade + stats). Authz: tenant viewing self, admin,
 *     or related landlord/team via lease_tenants.
 *   - POST /api/tenants/:id/transfer — retired 501 with requirePerm
 *     ('tenants.archive') gate
 *   - GET  /api/tenants/:id/available-units — vacant units owned by
 *     the calling landlord, with requirePerm('tenants.archive')
 *
 * Slices 1–5 covered 29 of 40 tenants.ts routes (~73%).
 * After this slice: 32 of 40 (~80%).
 *
 * Out of slice (next sessions): profile patch + avatar POST/GET +
 *   password, work-trade, charge-account.
 *
 * Production bug fixed in this slice:
 *   - /:id/profile stats.lateCount was filtering for payments.status
 *     = 'late', which doesn't exist in the payments_status_check
 *     enum — the FILTER always returned 0. Source now reads from
 *     tenants.late_payment_count (maintained by scheduler.ts).
 */

import { vi, describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { randomUUID } from 'crypto'
import { db } from '../db'
import {
  cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedTenant,
  seedLease, seedLeaseTenant,
} from '../test/dbHelpers'

import { tenantsRouter } from './tenants'
import { errorHandler } from '../middleware/errorHandler'

function buildApp() {
  const app = express()
  app.use(express.json({ limit: '2mb' }))
  app.use('/api/tenants', tenantsRouter)
  app.use(errorHandler)
  return app
}

beforeEach(async () => {
  await cleanupAllSchema()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_tenants_admin_views'
})

interface PortfolioFixture {
  landlordUserId: string
  landlordId:     string
  propertyId:     string
  unitId:         string
  tenantId:       string
  tenantUserId:   string
  leaseId:        string
  landlordToken:  string
  tenantToken:    string
  adminToken:     string
}

async function seedPortfolio(opts: { skipLeaseTenant?: boolean } = {}): Promise<PortfolioFixture> {
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    const { userId: landlordUserId, landlordId } = await seedLandlord(client)
    const propertyId = await seedProperty(client, {
      landlordId, ownerUserId: landlordUserId, managedByUserId: landlordUserId,
    })
    const unitId = await seedUnit(client, { propertyId, landlordId })
    const tenantId = await seedTenant(client)
    const tu = await client.query<{ user_id: string }>(
      `SELECT user_id FROM tenants WHERE id=$1`, [tenantId])
    const leaseId = await seedLease(client, { unitId, landlordId, status: 'active' })
    if (!opts.skipLeaseTenant) {
      await seedLeaseTenant(client, { leaseId, tenantId, role: 'primary' })
    }
    // Admin user (no profile binding — admin role is global).
    const adminRes = await client.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
       VALUES ($1, 'x', 'admin', 'Admin', 'User', TRUE) RETURNING id`,
      [`admin-${randomUUID()}@test.dev`])
    await client.query('COMMIT')

    const sign = (payload: object) => jwt.sign(payload, process.env.JWT_SECRET!, { expiresIn: '1h' })
    return {
      landlordUserId, landlordId, propertyId, unitId,
      tenantId, tenantUserId: tu.rows[0].user_id, leaseId,
      landlordToken: sign({ userId: landlordUserId, role: 'landlord', email: 'll@test.dev',
                            profileId: landlordId, permissions: {} }),
      tenantToken:   sign({ userId: tu.rows[0].user_id, role: 'tenant', email: 't@test.dev',
                            profileId: tenantId, permissions: {} }),
      adminToken:    sign({ userId: adminRes.rows[0].id, role: 'admin', email: 'admin@test.dev',
                            profileId: null, permissions: {} }),
    }
  } catch (e) { await client.query('ROLLBACK'); throw e }
  finally { client.release() }
}

describe('GET /:id/profile — lifetime tenant profile', () => {
  it('unknown tenant id → 404', async () => {
    const f = await seedPortfolio()
    const res = await request(buildApp())
      .get(`/api/tenants/${randomUUID()}/profile`)
      .set('Authorization', `Bearer ${f.adminToken}`)
    expect(res.status).toBe(404)
    expect(res.body.error).toMatch(/tenant not found/i)
  })

  it('unrelated landlord (no lease_tenants chain) → 403', async () => {
    const f = await seedPortfolio()
    const other = await seedPortfolio()  // separate landlord/tenant
    const res = await request(buildApp())
      .get(`/api/tenants/${f.tenantId}/profile`)
      .set('Authorization', `Bearer ${other.landlordToken}`)
    expect(res.status).toBe(403)
    expect(res.body.error).toMatch(/forbidden/i)
  })

  it('tenant viewing themselves → 200', async () => {
    const f = await seedPortfolio()
    const res = await request(buildApp())
      .get(`/api/tenants/${f.tenantId}/profile`)
      .set('Authorization', `Bearer ${f.tenantToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data.tenant.id).toBe(f.tenantId)
  })

  it('admin viewing any tenant → 200', async () => {
    const f = await seedPortfolio()
    const res = await request(buildApp())
      .get(`/api/tenants/${f.tenantId}/profile`)
      .set('Authorization', `Bearer ${f.adminToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data.tenant.id).toBe(f.tenantId)
  })

  it('landlord with a lease_tenants relationship → 200', async () => {
    const f = await seedPortfolio()
    const res = await request(buildApp())
      .get(`/api/tenants/${f.tenantId}/profile`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
    expect(res.status).toBe(200)
    // Units aggregation surfaces the current unit + is_current=true
    expect(res.body.data.units).toHaveLength(1)
    expect(res.body.data.units[0].id).toBe(f.unitId)
    expect(res.body.data.units[0].is_current).toBe(true)
  })

  it('happy aggregation: payments + maintenance + stats populated', async () => {
    const f = await seedPortfolio()
    // Seed 2 settled payments + 1 failed payment + 1 maintenance request.
    // S414: spread settled payments across distinct due_dates so they
    // don't collide on ux_payments_unit_type_due_date_active.
    let monthOffset = 0
    for (const amount of [1000, 1100]) {
      await db.query(
        `INSERT INTO payments
           (unit_id, tenant_id, landlord_id, type, amount, status,
            entry_description, due_date)
         VALUES ($1, $2, $3, 'rent', $4, 'settled', 'RENT',
                 CURRENT_DATE - ($5 || ' months')::interval)`,
        [f.unitId, f.tenantId, f.landlordId, amount, monthOffset++])
    }
    await db.query(
      `INSERT INTO payments
         (unit_id, tenant_id, landlord_id, type, amount, status,
          entry_description, due_date)
       VALUES ($1, $2, $3, 'rent', 1200, 'failed', 'RENT', CURRENT_DATE)`,
      [f.unitId, f.tenantId, f.landlordId])
    await db.query(
      `INSERT INTO maintenance_requests
         (tenant_id, unit_id, landlord_id, title, description, priority, status)
       VALUES ($1, $2, $3, 'leak', 'leak under sink', 'normal', 'open')`,
      [f.tenantId, f.unitId, f.landlordId])

    const res = await request(buildApp())
      .get(`/api/tenants/${f.tenantId}/profile`)
      .set('Authorization', `Bearer ${f.adminToken}`)

    expect(res.status).toBe(200)
    expect(res.body.data.payments).toHaveLength(3)
    expect(res.body.data.maintenance).toHaveLength(1)
    expect(res.body.data.stats.totalPayments).toBe(3)
    expect(res.body.data.stats.settledCount).toBe(2)
    expect(res.body.data.stats.failedCount).toBe(1)
    expect(res.body.data.stats.totalPaid).toBeCloseTo(2100, 2)
    expect(res.body.data.stats.avgPayment).toBeCloseTo(1050, 2)
    expect(res.body.data.stats.onTimeRate).toBe(67)  // 2/3 = 0.666… → 67
    expect(res.body.data.stats.maintenanceCount).toBe(1)
    expect(res.body.data.stats.unitsOccupied).toBe(1)
  })

  it('lateCount sources from tenants.late_payment_count, NOT a payments filter', async () => {
    // Pre-fix bug: lateCount was COUNT(*) FILTER (WHERE status='late')
    // — but payments_status_check enum has no 'late', so it always
    // returned 0. Fixed in S379: now reads from
    // tenants.late_payment_count (maintained by scheduler.ts late-fee
    // job).
    const f = await seedPortfolio()
    await db.query(
      `UPDATE tenants SET late_payment_count=4 WHERE id=$1`, [f.tenantId])

    const res = await request(buildApp())
      .get(`/api/tenants/${f.tenantId}/profile`)
      .set('Authorization', `Bearer ${f.adminToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data.stats.lateCount).toBe(4)
  })
})

describe('POST /:id/transfer — retired 501', () => {
  it('non-permitted role → 403 from requirePerm gate', async () => {
    const f = await seedPortfolio()
    const res = await request(buildApp())
      .post(`/api/tenants/${f.tenantId}/transfer`)
      .set('Authorization', `Bearer ${f.tenantToken}`)  // tenant lacks tenants.archive
      .send({})
    expect(res.status).toBe(403)
    expect(res.body.error).toMatch(/insufficient permissions/i)
  })

  it('permitted role → 501 with retired-endpoint message', async () => {
    const f = await seedPortfolio()
    const res = await request(buildApp())
      .post(`/api/tenants/${f.tenantId}/transfer`)
      .set('Authorization', `Bearer ${f.landlordToken}`)  // landlord = OWNER_ROLES auto-pass
      .send({ newUnitId: randomUUID() })
    expect(res.status).toBe(501)
    expect(res.body.error).toMatch(/retired/i)
    expect(res.body.error).toMatch(/e-sign/i)
  })
})

describe('GET /:id/available-units', () => {
  it('non-permitted role → 403', async () => {
    const f = await seedPortfolio()
    const res = await request(buildApp())
      .get(`/api/tenants/${f.tenantId}/available-units`)
      .set('Authorization', `Bearer ${f.tenantToken}`)
    expect(res.status).toBe(403)
  })

  it('landlord with no vacant units → 200 empty', async () => {
    const f = await seedPortfolio()
    // Default fixture has 1 unit with an active lease → not vacant.
    const res = await request(buildApp())
      .get(`/api/tenants/${f.tenantId}/available-units`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data).toEqual([])
  })

  it('landlord with mixed units → returns only vacant + no pending/active lease', async () => {
    const f = await seedPortfolio()
    // Seed a second + third unit. Second is vacant with no lease — should
    // appear. Third is vacant but has a 'pending' lease — should NOT appear
    // (NOT EXISTS guard).
    const client = await db.connect()
    try {
      await client.query('BEGIN')
      const vacantUnitId = await seedUnit(client, { propertyId: f.propertyId, landlordId: f.landlordId })
      await client.query(`UPDATE units SET status='vacant' WHERE id=$1`, [vacantUnitId])
      const pendingUnitId = await seedUnit(client, { propertyId: f.propertyId, landlordId: f.landlordId })
      await client.query(`UPDATE units SET status='vacant' WHERE id=$1`, [pendingUnitId])
      await seedLease(client, { unitId: pendingUnitId, landlordId: f.landlordId, status: 'pending' })
      await client.query('COMMIT')

      const res = await request(buildApp())
        .get(`/api/tenants/${f.tenantId}/available-units`)
        .set('Authorization', `Bearer ${f.landlordToken}`)
      expect(res.status).toBe(200)
      expect(res.body.data).toHaveLength(1)
      expect(res.body.data[0].id).toBe(vacantUnitId)
    } finally { client.release() }
  })

  it('admin caller with null profileId → 200 empty (units filtered by landlord_id = profileId)', async () => {
    const f = await seedPortfolio()
    // Admin's profileId is null in our JWT seed — the SQL filter
    // u.landlord_id = $1 matches nothing.
    const res = await request(buildApp())
      .get(`/api/tenants/${f.tenantId}/available-units`)
      .set('Authorization', `Bearer ${f.adminToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data).toEqual([])
  })
})
