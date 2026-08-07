/**
 * S579 — screening grandfather (onboarding-window waive) + property-level invite.
 *
 * Covers:
 *   - computeWindowDays formula (14 + 1/10 units, cap 30)
 *   - getOnboardingWindow open/closed semantics
 *   - POST /tenants/invite with propertyId → property-bound intent (unit_id NULL)
 *   - POST /tenants/:id/waive-screening — window-gated grandfather:
 *       open + attested → status='waived' + audit; closed → 403;
 *       not attested → 400; one-grandfather-per-unit → 409.
 */
import { vi, describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { randomUUID } from 'crypto'
import { db } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit } from '../test/dbHelpers'
import {
  computeWindowDays, getOnboardingWindow, openOnboardingWindow, closeOnboardingWindow,
  ONBOARDING_WINDOW_CAP_DAYS,
} from '../services/onboardingWindow'

vi.mock('../services/notifications', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, notifyTenantInviteAccepted: vi.fn(async () => undefined) }
})

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
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_screening_gf'
})

async function seedFixture() {
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    const { userId, landlordId } = await seedLandlord(client)
    const propertyId = await seedProperty(client, { landlordId, ownerUserId: userId, managedByUserId: userId })
    const unitId = await seedUnit(client, { propertyId, landlordId })
    await client.query('COMMIT')
    const token = jwt.sign(
      { userId, role: 'landlord', email: 'll@test.dev', profileId: landlordId, permissions: {} },
      process.env.JWT_SECRET!, { expiresIn: '1h' })
    return { userId, landlordId, propertyId, unitId, token }
  } catch (e) { await client.query('ROLLBACK'); throw e } finally { client.release() }
}

async function seedTenant(): Promise<string> {
  const u = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, role, first_name, last_name)
     VALUES ($1,'x','tenant','Sit','Ting') RETURNING id`, [`t-${randomUUID()}@test.dev`])
  const t = await db.query<{ id: string }>(`INSERT INTO tenants (user_id) VALUES ($1) RETURNING id`, [u.rows[0].id])
  return t.rows[0].id
}

/** Open the property's onboarding window for the waive tests. */
async function openWindow(propertyId: string) {
  await openOnboardingWindow(propertyId)
}

describe('computeWindowDays', () => {
  it('base 14 for small properties', () => {
    expect(computeWindowDays(0)).toBe(14)
    expect(computeWindowDays(9)).toBe(14)
    expect(computeWindowDays(10)).toBe(15)
    expect(computeWindowDays(32)).toBe(17)   // Oak Park ~32 units
    expect(computeWindowDays(100)).toBe(24)
  })
  it('caps at 30 (one billing cycle)', () => {
    expect(computeWindowDays(300)).toBe(ONBOARDING_WINDOW_CAP_DAYS)
    expect(computeWindowDays(9999)).toBe(30)
  })
})

describe('getOnboardingWindow', () => {
  it('a freshly-opened window is open; closing it ends the grandfather', async () => {
    const f = await seedFixture()
    await openWindow(f.propertyId)
    let w = await getOnboardingWindow(f.propertyId)
    expect(w.open).toBe(true)
    expect(w.startedAt).not.toBeNull()
    expect((w.daysRemaining ?? 0)).toBeGreaterThan(0)

    await closeOnboardingWindow(f.propertyId)
    w = await getOnboardingWindow(f.propertyId)
    expect(w.open).toBe(false)
    expect(w.completedAt).not.toBeNull()
  })
})

describe('POST /tenants/invite — property-level', () => {
  it('propertyId (no unit) creates a property-bound intent with unit_id NULL', async () => {
    const f = await seedFixture()
    const res = await request(buildApp())
      .post('/api/tenants/invite')
      .set('Authorization', `Bearer ${f.token}`)
      .send({ email: 'applicant@test.dev', firstName: 'App', lastName: 'Licant', propertyId: f.propertyId })
    expect(res.status).toBe(200)
    const intent = await db.query<{ property_id: string; unit_id: string | null }>(
      `SELECT property_id, unit_id FROM pending_tenant_intents pti
         JOIN tenants t ON t.id = pti.tenant_id
         JOIN users u ON u.id = t.user_id WHERE u.email = $1`, ['applicant@test.dev'])
    expect(intent.rows).toHaveLength(1)
    expect(intent.rows[0].property_id).toBe(f.propertyId)
    expect(intent.rows[0].unit_id).toBeNull()   // no unit → no lease auto-draft
  })
})

describe('POST /tenants/:id/waive-screening — grandfather', () => {
  it('window open + attested → status waived + audit recorded', async () => {
    const f = await seedFixture()
    await openWindow(f.propertyId)
    const tenantId = await seedTenant()
    const res = await request(buildApp())
      .post(`/api/tenants/${tenantId}/waive-screening`)
      .set('Authorization', `Bearer ${f.token}`)
      .send({ propertyId: f.propertyId, unitId: f.unitId, attested: true })
    expect(res.status).toBe(200)
    const t = await db.query<{ background_check_status: string }>(
      `SELECT background_check_status FROM tenants WHERE id=$1`, [tenantId])
    expect(t.rows[0].background_check_status).toBe('waived')
    const intent = await db.query<{ screening_waived: boolean; screening_attested: boolean; screening_waived_unit_id: string; unit_id: string | null }>(
      `SELECT screening_waived, screening_attested, screening_waived_unit_id, unit_id
         FROM pending_tenant_intents WHERE tenant_id=$1`, [tenantId])
    expect(intent.rows[0].screening_waived).toBe(true)
    expect(intent.rows[0].screening_attested).toBe(true)
    expect(intent.rows[0].screening_waived_unit_id).toBe(f.unitId)
    expect(intent.rows[0].unit_id).toBeNull()   // NOT set → no lease auto-draft
  })

  it('not attested → 400', async () => {
    const f = await seedFixture()
    await openWindow(f.propertyId)
    const tenantId = await seedTenant()
    const res = await request(buildApp())
      .post(`/api/tenants/${tenantId}/waive-screening`)
      .set('Authorization', `Bearer ${f.token}`)
      .send({ propertyId: f.propertyId, unitId: f.unitId, attested: false })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/attest/i)
  })

  it('window closed → 403 (screening mandatory)', async () => {
    const f = await seedFixture()
    await openWindow(f.propertyId)
    await closeOnboardingWindow(f.propertyId)
    const tenantId = await seedTenant()
    const res = await request(buildApp())
      .post(`/api/tenants/${tenantId}/waive-screening`)
      .set('Authorization', `Bearer ${f.token}`)
      .send({ propertyId: f.propertyId, unitId: f.unitId, attested: true })
    expect(res.status).toBe(403)
    expect(res.body.error).toMatch(/onboarding window/i)
  })

  it('one grandfather per occupied unit → 409 for a second tenant on the same unit', async () => {
    const f = await seedFixture()
    await openWindow(f.propertyId)
    const first = await seedTenant()
    const second = await seedTenant()
    await request(buildApp()).post(`/api/tenants/${first}/waive-screening`)
      .set('Authorization', `Bearer ${f.token}`)
      .send({ propertyId: f.propertyId, unitId: f.unitId, attested: true }).expect(200)
    const res = await request(buildApp()).post(`/api/tenants/${second}/waive-screening`)
      .set('Authorization', `Bearer ${f.token}`)
      .send({ propertyId: f.propertyId, unitId: f.unitId, attested: true })
    expect(res.status).toBe(409)
    expect(res.body.error).toMatch(/already has a grandfathered/i)
  })
})
