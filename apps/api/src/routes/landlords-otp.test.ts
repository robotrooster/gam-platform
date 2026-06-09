/**
 * landlords.ts OTP slice — S365 (landlords slice 9 of N).
 *
 * 5 routes covering OTP (On-Time Pay landlord-paid rent-advance
 * product per S155). All gated by requireLandlord — owner-only.
 *
 * Coverage focus:
 *   - visibility gate (isOtpVisibleForLandlord) fires on
 *     /eligible-tenants, /disable, /advances — 403 when false
 *   - /eligible-tenants SQL: returns landlord-scoped tenants +
 *     enriches with getQualificationStatus per tenant
 *   - /enable: service ok:false → 400 with reason; ok:true → 200
 *     with correct args passed
 *   - /disable: reason defaults to 'landlord_initiated' if body
 *     omits it
 *   - /advances: SQL returns landlord-scoped rows with the
 *     expected shape; cross-landlord excluded
 *
 * services/otp mocked — its internal logic (qualification rules,
 * advance lifecycle) belongs to the otp service's own tests.
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

const {
  isOtpVisibleForLandlordMock,
  enableOtpForTenantMock,
  disableOtpForTenantMock,
  getQualificationStatusMock,
} = vi.hoisted(() => ({
  isOtpVisibleForLandlordMock: vi.fn(async (..._args: any[]) => true),
  enableOtpForTenantMock:      vi.fn<any[], Promise<{ ok: boolean; reason?: string }>>(async () => ({ ok: true })),
  disableOtpForTenantMock:     vi.fn(async (..._args: any[]) => undefined),
  getQualificationStatusMock:  vi.fn<any[], Promise<{ qualified: boolean; reasons: string[] }>>(async () => ({ qualified: true, reasons: [] })),
}))
vi.mock('../services/otp', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    isOtpVisibleForLandlord: isOtpVisibleForLandlordMock,
    enableOtpForTenant:      enableOtpForTenantMock,
    disableOtpForTenant:     disableOtpForTenantMock,
    getQualificationStatus:  getQualificationStatusMock,
  }
})

import { landlordsRouter } from './landlords'
import { errorHandler } from '../middleware/errorHandler'

function buildApp() {
  const app = express()
  app.use(express.json({ limit: '2mb' }))
  app.use('/api/landlords', landlordsRouter)
  app.use(errorHandler)
  return app
}

beforeEach(async () => {
  await cleanupAllSchema()
  isOtpVisibleForLandlordMock.mockClear(); isOtpVisibleForLandlordMock.mockResolvedValue(true)
  enableOtpForTenantMock.mockClear();      enableOtpForTenantMock.mockResolvedValue({ ok: true } as any)
  disableOtpForTenantMock.mockClear();     disableOtpForTenantMock.mockResolvedValue(undefined as any)
  getQualificationStatusMock.mockClear();  getQualificationStatusMock.mockResolvedValue({ qualified: true, reasons: [] } as any)
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_otp'
})

interface OFixture {
  landlordUserId: string
  landlordId:     string
  landlordToken:  string
}

async function seedOFixture(): Promise<OFixture> {
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    const { userId: landlordUserId, landlordId } = await seedLandlord(client)
    await client.query('COMMIT')
    const landlordToken = jwt.sign(
      { userId: landlordUserId, role: 'landlord', email: 'll@test.dev',
        profileId: landlordId, permissions: {} },
      process.env.JWT_SECRET!, { expiresIn: '1h' },
    )
    return { landlordUserId, landlordId, landlordToken }
  } catch (e) { await client.query('ROLLBACK'); throw e }
  finally { client.release() }
}

async function seedActiveTenantOnUnit(f: OFixture): Promise<{ tenantId: string; unitId: string; leaseId: string }> {
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    const propertyId = await seedProperty(client, {
      landlordId: f.landlordId, ownerUserId: f.landlordUserId,
      managedByUserId: f.landlordUserId,
    })
    const unitId = await seedUnit(client, { propertyId, landlordId: f.landlordId })
    const tenantId = await seedTenant(client)
    const leaseId = await seedLease(client, { unitId, landlordId: f.landlordId })
    await seedLeaseTenant(client, { leaseId, tenantId, role: 'primary' })
    await client.query('COMMIT')
    return { tenantId, unitId, leaseId }
  } catch (e) { await client.query('ROLLBACK'); throw e }
  finally { client.release() }
}

describe('GET /api/landlords/me/otp/visibility', () => {
  it('returns { visible } from service', async () => {
    const f = await seedOFixture()
    isOtpVisibleForLandlordMock.mockResolvedValueOnce(true)
    const r1 = await request(buildApp())
      .get('/api/landlords/me/otp/visibility')
      .set('Authorization', `Bearer ${f.landlordToken}`)
    expect(r1.status).toBe(200)
    expect(r1.body.data).toEqual({ visible: true })

    isOtpVisibleForLandlordMock.mockResolvedValueOnce(false)
    const r2 = await request(buildApp())
      .get('/api/landlords/me/otp/visibility')
      .set('Authorization', `Bearer ${f.landlordToken}`)
    expect(r2.body.data).toEqual({ visible: false })
  })
})

describe('GET /api/landlords/me/otp/eligible-tenants', () => {
  it('visibility=false → 403', async () => {
    const f = await seedOFixture()
    isOtpVisibleForLandlordMock.mockResolvedValueOnce(false)
    const res = await request(buildApp())
      .get('/api/landlords/me/otp/eligible-tenants')
      .set('Authorization', `Bearer ${f.landlordToken}`)
    expect(res.status).toBe(403)
    expect(res.body.error).toMatch(/OTP not enabled/)
  })

  it('visibility=true + landlord has active tenant → returns enriched list', async () => {
    const f = await seedOFixture()
    const { tenantId } = await seedActiveTenantOnUnit(f)
    getQualificationStatusMock.mockResolvedValueOnce({ qualified: false, reasons: ['no_ach'] })

    const res = await request(buildApp())
      .get('/api/landlords/me/otp/eligible-tenants')
      .set('Authorization', `Bearer ${f.landlordToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data.length).toBe(1)
    expect(res.body.data[0].id).toBe(tenantId)
    expect(res.body.data[0].qualification).toEqual({ qualified: false, reasons: ['no_ach'] })
    expect(getQualificationStatusMock).toHaveBeenCalledWith(tenantId)
  })

  it('cross-landlord tenants excluded', async () => {
    const a = await seedOFixture()
    const b = await seedOFixture()
    await seedActiveTenantOnUnit(b)  // b has the tenant
    const res = await request(buildApp())
      .get('/api/landlords/me/otp/eligible-tenants')
      .set('Authorization', `Bearer ${a.landlordToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data).toEqual([])
  })
})

describe('POST /api/landlords/me/otp/tenants/:tenantId/enable', () => {
  it('service returns ok:false → 400 with reason message', async () => {
    const f = await seedOFixture()
    enableOtpForTenantMock.mockResolvedValueOnce({ ok: false, reason: 'tenant has unverified ACH' } as any)
    const res = await request(buildApp())
      .post(`/api/landlords/me/otp/tenants/${randomUUID()}/enable`)
      .set('Authorization', `Bearer ${f.landlordToken}`).send({})
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/tenant has unverified ACH/)
  })

  it('happy: passes tenantId + landlordId + enabledByUserId to service', async () => {
    const f = await seedOFixture()
    const tenantId = randomUUID()
    const res = await request(buildApp())
      .post(`/api/landlords/me/otp/tenants/${tenantId}/enable`)
      .set('Authorization', `Bearer ${f.landlordToken}`).send({})
    expect(res.status).toBe(200)
    expect(enableOtpForTenantMock).toHaveBeenCalledWith({
      tenantId, landlordId: f.landlordId, enabledByUserId: f.landlordUserId,
    })
  })
})

describe('POST /api/landlords/me/otp/tenants/:tenantId/disable', () => {
  it('visibility=false → 403; service not called', async () => {
    const f = await seedOFixture()
    isOtpVisibleForLandlordMock.mockResolvedValueOnce(false)
    const res = await request(buildApp())
      .post(`/api/landlords/me/otp/tenants/${randomUUID()}/disable`)
      .set('Authorization', `Bearer ${f.landlordToken}`).send({})
    expect(res.status).toBe(403)
    expect(disableOtpForTenantMock).not.toHaveBeenCalled()
  })

  it('reason defaults to "landlord_initiated" when body omits it', async () => {
    const f = await seedOFixture()
    const tenantId = randomUUID()
    const res = await request(buildApp())
      .post(`/api/landlords/me/otp/tenants/${tenantId}/disable`)
      .set('Authorization', `Bearer ${f.landlordToken}`).send({})
    expect(res.status).toBe(200)
    expect(disableOtpForTenantMock).toHaveBeenCalledWith({
      tenantId, landlordId: f.landlordId, reason: 'landlord_initiated',
    })
  })

  it('explicit reason in body is passed through to service', async () => {
    const f = await seedOFixture()
    const tenantId = randomUUID()
    await request(buildApp())
      .post(`/api/landlords/me/otp/tenants/${tenantId}/disable`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ reason: 'tenant_requested' })
    expect(disableOtpForTenantMock).toHaveBeenCalledWith({
      tenantId, landlordId: f.landlordId, reason: 'tenant_requested',
    })
  })
})

describe('GET /api/landlords/me/otp/advances', () => {
  it('visibility=false → 403', async () => {
    const f = await seedOFixture()
    isOtpVisibleForLandlordMock.mockResolvedValueOnce(false)
    const res = await request(buildApp())
      .get('/api/landlords/me/otp/advances')
      .set('Authorization', `Bearer ${f.landlordToken}`)
    expect(res.status).toBe(403)
  })

  it('happy: returns landlord-scoped rows with joined tenant/unit/property shape; cross-landlord excluded', async () => {
    const a = await seedOFixture()
    const b = await seedOFixture()
    const aSeed = await seedActiveTenantOnUnit(a)
    const bSeed = await seedActiveTenantOnUnit(b)
    // Seed otp_advances for both landlords
    await db.query(
      `INSERT INTO otp_advances
         (cycle_month, tenant_id, landlord_id, unit_id, lease_id,
          rent_amount, fee_amount, advance_amount, status)
       VALUES (CURRENT_DATE, $1, $2, $3, $4, 1500, 15, 1485, 'pending')`,
      [aSeed.tenantId, a.landlordId, aSeed.unitId, aSeed.leaseId])
    await db.query(
      `INSERT INTO otp_advances
         (cycle_month, tenant_id, landlord_id, unit_id, lease_id,
          rent_amount, fee_amount, advance_amount, status)
       VALUES (CURRENT_DATE, $1, $2, $3, $4, 2000, 15, 1985, 'pending')`,
      [bSeed.tenantId, b.landlordId, bSeed.unitId, bSeed.leaseId])

    const res = await request(buildApp())
      .get('/api/landlords/me/otp/advances')
      .set('Authorization', `Bearer ${a.landlordToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data.length).toBe(1)
    expect(Number(res.body.data[0].rent_amount)).toBe(1500)
    expect(Number(res.body.data[0].advance_amount)).toBe(1485)
    expect(res.body.data[0].first_name).toBeDefined()
    expect(res.body.data[0].unit_number).toBeDefined()
    expect(res.body.data[0].property_name).toBeDefined()
  })
})
