/**
 * tenants.ts misc slice — S381 (tenants.ts slice 8 of N, the CLOSER).
 *
 * Covered routes (2):
 *   - GET /api/tenants/work-trade — active work-trade agreement
 *   - GET /api/tenants/charge-account — deprecated 410 (S381)
 *
 * This slice closes the tenants.ts arc. After S381, all 40 routes
 * in tenants.ts have at least one test pin.
 *
 * Slice arc map (cumulative):
 *   S374 slice 1: /me + landlord-banking + verify-ach + deposit-interest (5)
 *   S375 slice 2: FlexCharge/Pay/Deposit/Suite + portability auth (13)
 *   S376 slice 3: OTP/credit/payments + portability decline + re-accept preview (5)
 *   S377 slice 4: invite + accept-invite + invite-info (3) [+ 2 bugs fixed]
 *   S378 slice 5: lease views (3)
 *   S379 slice 6: admin :id/profile + :id/transfer + :id/available-units (3) [+ 1 bug fixed]
 *   S380 slice 7: profile patch + avatar POST/GET + password (4) [+ 3 bugs fixed]
 *   S381 slice 8: work-trade + charge-account (2) [+ 1 bug fixed via retire-410]
 *
 * Production bug fixed in this slice:
 *   - GET /charge-account referenced non-existent
 *     pos_transactions.settled column; would 500 on every call.
 *     Route is orphaned (no frontend consumer); FlexCharge subsystem
 *     replaced it. Retired as 410 with redirect message to
 *     /api/tenants/flexcharge.
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
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_tenants_misc'
})

interface TFixture {
  landlordId: string
  unitId:     string
  tenantId:   string
  token:      string
}

async function seedFixture(): Promise<TFixture> {
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
    await client.query('COMMIT')
    const token = jwt.sign(
      { userId: tu.rows[0].user_id, role: 'tenant', email: 't@test.dev',
        profileId: tenantId, permissions: {} },
      process.env.JWT_SECRET!, { expiresIn: '1h' },
    )
    return { landlordId, unitId, tenantId, token }
  } catch (e) { await client.query('ROLLBACK'); throw e }
  finally { client.release() }
}

describe('GET /work-trade', () => {
  it('no tenants row for caller → 404 Tenant not found', async () => {
    const token = jwt.sign(
      { userId: randomUUID(), role: 'tenant', email: 't@test.dev',
        profileId: randomUUID(), permissions: {} },
      process.env.JWT_SECRET!, { expiresIn: '1h' })
    const res = await request(buildApp())
      .get('/api/tenants/work-trade')
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(404)
    expect(res.body.error).toMatch(/tenant not found/i)
  })

  it('tenant with no active agreement → 200 data:null', async () => {
    const f = await seedFixture()
    const res = await request(buildApp())
      .get('/api/tenants/work-trade')
      .set('Authorization', `Bearer ${f.token}`)
    expect(res.status).toBe(200)
    expect(res.body.success).toBe(true)
    expect(res.body.data).toBeNull()
  })

  it('happy: returns active agreement with unit_number + property_name', async () => {
    const f = await seedFixture()
    await db.query(
      `INSERT INTO work_trade_agreements
         (unit_id, tenant_id, landlord_id, start_date, status, duties)
       VALUES ($1, $2, $3, CURRENT_DATE, 'active', 'groundskeeping')`,
      [f.unitId, f.tenantId, f.landlordId])

    const res = await request(buildApp())
      .get('/api/tenants/work-trade')
      .set('Authorization', `Bearer ${f.token}`)
    expect(res.status).toBe(200)
    expect(res.body.data.status).toBe('active')
    expect(res.body.data.duties).toBe('groundskeeping')
    expect(res.body.data.unit_number).toMatch(/^U-/)
    expect(res.body.data.property_name).toBe('Test Property')
  })

  it('paused/ended agreements are NOT returned (status=active filter)', async () => {
    const f = await seedFixture()
    await db.query(
      `INSERT INTO work_trade_agreements
         (unit_id, tenant_id, landlord_id, start_date, status)
       VALUES ($1, $2, $3, CURRENT_DATE - interval '1 year', 'ended')`,
      [f.unitId, f.tenantId, f.landlordId])

    const res = await request(buildApp())
      .get('/api/tenants/work-trade')
      .set('Authorization', `Bearer ${f.token}`)
    expect(res.status).toBe(200)
    expect(res.body.data).toBeNull()
  })
})

describe('GET /charge-account (deprecated S381)', () => {
  it('returns 410 with redirect message to /flexcharge', async () => {
    const f = await seedFixture()
    const res = await request(buildApp())
      .get('/api/tenants/charge-account')
      .set('Authorization', `Bearer ${f.token}`)
    expect(res.status).toBe(410)
    expect(res.body.success).toBe(false)
    expect(res.body.error).toMatch(/deprecated/i)
    expect(res.body.error).toMatch(/flexcharge/i)
  })
})
