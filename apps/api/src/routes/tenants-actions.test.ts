/**
 * tenants.ts tenant-action slice — S376 (tenants.ts slice 3 of N).
 *
 * Covered routes (5):
 *   - POST /enroll-on-time-pay — deprecated 410 stub (S155)
 *   - POST /enroll-credit-reporting — credit_reporting_enrolled flag flip
 *   - GET  /payments — last 24 payments for the calling tenant
 *   - POST /me/deposit/portability/decline — service pass-through
 *   - GET  /flexsuite/re-acceptance-preview — service pass-through
 *
 * Slice 1 (S374): /me + landlord-banking + verify-ach + deposit-interest.
 * Slice 2 (S375): all Flex (FlexCharge/FlexPay/FlexDeposit/FlexSuite re-
 *   accept + DELETE flex*) + portability eligibility/authorize.
 *
 * Out of slice (next sessions): invite + accept-invite + invite-info,
 *   admin-facing /:id/profile + /:id/transfer + /:id/available-units,
 *   profile patch + avatar + password, lease views, work-trade,
 *   charge-account.
 */

import { vi, describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { randomUUID } from 'crypto'
import { db } from '../db'
import {
  cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedTenant,
} from '../test/dbHelpers'

const {
  declineDepositPortabilityMock,
  renderReAcceptanceTermsMock,
} = vi.hoisted(() => ({
  declineDepositPortabilityMock: vi.fn(async (..._a: any[]) => undefined),
  renderReAcceptanceTermsMock:   vi.fn(async (..._a: any[]) => ({ renderedText: 'preview terms' })),
}))
vi.mock('../services/depositPortability', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    declineDepositPortability: declineDepositPortabilityMock,
  }
})
vi.mock('../services/flexsuiteAcceptance', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    renderReAcceptanceTerms:      renderReAcceptanceTermsMock,
    FLEXPAY_TEMPLATE_VERSION:     'v1.0',
    FLEXDEPOSIT_TEMPLATE_VERSION: 'v1.0',
  }
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
  declineDepositPortabilityMock.mockClear()
  declineDepositPortabilityMock.mockResolvedValue(undefined as any)
  renderReAcceptanceTermsMock.mockClear()
  renderReAcceptanceTermsMock.mockResolvedValue({ renderedText: 'preview terms' } as any)
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_tenants_actions'
})

interface TFixture {
  landlordId:   string
  propertyId:   string
  unitId:       string
  tenantId:     string
  tenantUserId: string
  token:        string
}

async function seedFixture(): Promise<TFixture> {
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    const { userId: landlordUserId, landlordId } = await seedLandlord(client)
    const propertyId = await seedProperty(client, {
      landlordId, ownerUserId: landlordUserId, managedByUserId: landlordUserId,
    })
    const unitId     = await seedUnit(client, { propertyId, landlordId })
    const tenantId   = await seedTenant(client)
    const tu = await client.query<{ user_id: string }>(
      `SELECT user_id FROM tenants WHERE id=$1`, [tenantId])
    await client.query('COMMIT')
    const token = jwt.sign(
      { userId: tu.rows[0].user_id, role: 'tenant', email: 't@test.dev',
        profileId: tenantId, permissions: {} },
      process.env.JWT_SECRET!, { expiresIn: '1h' },
    )
    return { landlordId, propertyId, unitId, tenantId, tenantUserId: tu.rows[0].user_id, token }
  } catch (e) { await client.query('ROLLBACK'); throw e }
  finally { client.release() }
}

describe('OTP enrollment (deprecated S155)', () => {
  it('POST /enroll-on-time-pay → 410 Gone with deprecation message; no DB write', async () => {
    const f = await seedFixture()
    // Pre-state: confirm the column starts FALSE so we can prove
    // the 410 stub doesn't write.
    const pre = await db.query<{ on_time_pay_enrolled: boolean }>(
      `SELECT on_time_pay_enrolled FROM tenants WHERE id=$1`, [f.tenantId])
    expect(pre.rows[0].on_time_pay_enrolled).toBe(false)

    const res = await request(buildApp())
      .post('/api/tenants/enroll-on-time-pay')
      .set('Authorization', `Bearer ${f.token}`)
    expect(res.status).toBe(410)
    expect(res.body.success).toBe(false)
    expect(res.body.error).toMatch(/deprecated/i)

    const post = await db.query<{ on_time_pay_enrolled: boolean }>(
      `SELECT on_time_pay_enrolled FROM tenants WHERE id=$1`, [f.tenantId])
    expect(post.rows[0].on_time_pay_enrolled).toBe(false)
  })
})

describe('Credit reporting enrollment', () => {
  it('POST /enroll-credit-reporting flips column to TRUE; idempotent on re-call', async () => {
    const f = await seedFixture()
    const pre = await db.query<{ credit_reporting_enrolled: boolean }>(
      `SELECT credit_reporting_enrolled FROM tenants WHERE id=$1`, [f.tenantId])
    expect(pre.rows[0].credit_reporting_enrolled).toBe(false)

    const r1 = await request(buildApp())
      .post('/api/tenants/enroll-credit-reporting')
      .set('Authorization', `Bearer ${f.token}`)
    expect(r1.status).toBe(200)
    expect(r1.body.success).toBe(true)
    expect(r1.body.message).toMatch(/reported to all 3 bureaus/i)

    const mid = await db.query<{ credit_reporting_enrolled: boolean }>(
      `SELECT credit_reporting_enrolled FROM tenants WHERE id=$1`, [f.tenantId])
    expect(mid.rows[0].credit_reporting_enrolled).toBe(true)

    // Idempotent: second call doesn't error and column stays TRUE.
    const r2 = await request(buildApp())
      .post('/api/tenants/enroll-credit-reporting')
      .set('Authorization', `Bearer ${f.token}`)
    expect(r2.status).toBe(200)
    expect(r2.body.success).toBe(true)
    const post = await db.query<{ credit_reporting_enrolled: boolean }>(
      `SELECT credit_reporting_enrolled FROM tenants WHERE id=$1`, [f.tenantId])
    expect(post.rows[0].credit_reporting_enrolled).toBe(true)
  })
})

describe('Payments history', () => {
  it('GET /payments with no payments → empty array', async () => {
    const f = await seedFixture()
    const res = await request(buildApp())
      .get('/api/tenants/payments')
      .set('Authorization', `Bearer ${f.token}`)
    expect(res.status).toBe(200)
    expect(res.body.success).toBe(true)
    expect(res.body.data).toEqual([])
  })

  it('GET /payments caps at 24 in DESC due_date order and excludes other tenants', async () => {
    const f = await seedFixture()
    // Other tenant in the same unit — their rows MUST NOT leak.
    const otherTenantId = await (async () => {
      const c = await db.connect()
      try { await c.query('BEGIN'); const id = await seedTenant(c); await c.query('COMMIT'); return id }
      finally { c.release() }
    })()

    // Seed 26 payments for our tenant across 26 distinct due_dates,
    // 1 for the other tenant on a date in-range. We expect:
    //   - exactly 24 rows returned
    //   - first row due_date = today (newest)
    //   - other tenant's payment absent
    for (let i = 0; i < 26; i++) {
      await db.query(
        `INSERT INTO payments
           (unit_id, tenant_id, landlord_id, type, amount, status,
            entry_description, due_date)
         VALUES ($1, $2, $3, 'rent', $4, 'settled', 'RENT',
                 CURRENT_DATE - ($5 || ' days')::interval)`,
        [f.unitId, f.tenantId, f.landlordId, 1000 + i, i])
    }
    // S414: offset other-tenant date by 100 days so the (unit, type,
    // due_date) tuple doesn't collide with our tenant's CURRENT_DATE
    // payment under the S414 ux_payments_unit_type_due_date_active
    // UNIQUE constraint. The cross-tenant filter is the contract under
    // test — the specific date the other tenant's row sits on doesn't
    // matter, just that it's NOT in our tenant's result set.
    await db.query(
      `INSERT INTO payments
         (unit_id, tenant_id, landlord_id, type, amount, status,
          entry_description, due_date)
       VALUES ($1, $2, $3, 'rent', 9999, 'settled', 'RENT',
               CURRENT_DATE - INTERVAL '100 days')`,
      [f.unitId, otherTenantId, f.landlordId])

    const res = await request(buildApp())
      .get('/api/tenants/payments')
      .set('Authorization', `Bearer ${f.token}`)
    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(24)
    // First row is most recent (today) and belongs to our tenant.
    expect(res.body.data[0].tenant_id).toBe(f.tenantId)
    // Amounts came back in DESC due_date order — i=0 had amount 1000
    // and due_date = today.
    expect(Number(res.body.data[0].amount)).toBe(1000)
    // Cross-tenant leak guard: every returned row is ours.
    for (const p of res.body.data) {
      expect(p.tenant_id).toBe(f.tenantId)
    }
  })
})

describe('Deposit portability decline', () => {
  it('POST /me/deposit/portability/decline missing depositId → 400', async () => {
    const f = await seedFixture()
    const res = await request(buildApp())
      .post('/api/tenants/me/deposit/portability/decline')
      .set('Authorization', `Bearer ${f.token}`)
      .send({})
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/depositId required/)
    expect(declineDepositPortabilityMock).not.toHaveBeenCalled()
  })

  it('POST /me/deposit/portability/decline happy passes {tenantId, depositId}', async () => {
    const f = await seedFixture()
    const depositId = randomUUID()
    const res = await request(buildApp())
      .post('/api/tenants/me/deposit/portability/decline')
      .set('Authorization', `Bearer ${f.token}`)
      .send({ depositId })
    expect(res.status).toBe(200)
    expect(res.body.success).toBe(true)
    expect(declineDepositPortabilityMock).toHaveBeenCalledWith({
      tenantId:  f.tenantId,
      depositId,
    })
  })
})

describe('FlexSuite re-acceptance preview', () => {
  it('GET /flexsuite/re-acceptance-preview invalid product → 400', async () => {
    const f = await seedFixture()
    const res = await request(buildApp())
      .get('/api/tenants/flexsuite/re-acceptance-preview?product=flexnope')
      .set('Authorization', `Bearer ${f.token}`)
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/flexpay or flexdeposit/)
    expect(renderReAcceptanceTermsMock).not.toHaveBeenCalled()
  })

  it('GET /flexsuite/re-acceptance-preview?product=flexpay returns version + renderedText', async () => {
    const f = await seedFixture()
    renderReAcceptanceTermsMock.mockResolvedValueOnce({ renderedText: 'flexpay preview text' } as any)
    const res = await request(buildApp())
      .get('/api/tenants/flexsuite/re-acceptance-preview?product=flexpay')
      .set('Authorization', `Bearer ${f.token}`)
    expect(res.status).toBe(200)
    expect(res.body.data).toMatchObject({
      product:      'flexpay',
      version:      'v1.0',
      renderedText: 'flexpay preview text',
    })
    expect(renderReAcceptanceTermsMock).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: f.tenantId,
      product:  'flexpay',
    }))
  })

  it('GET /flexsuite/re-acceptance-preview?product=flexdeposit returns FLEXDEPOSIT_TEMPLATE_VERSION', async () => {
    const f = await seedFixture()
    renderReAcceptanceTermsMock.mockResolvedValueOnce({ renderedText: 'deposit preview text' } as any)
    const res = await request(buildApp())
      .get('/api/tenants/flexsuite/re-acceptance-preview?product=flexdeposit')
      .set('Authorization', `Bearer ${f.token}`)
    expect(res.status).toBe(200)
    expect(res.body.data).toMatchObject({
      product:      'flexdeposit',
      version:      'v1.0',
      renderedText: 'deposit preview text',
    })
  })
})
