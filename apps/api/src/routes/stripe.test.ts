/**
 * stripe.ts gap-close slice — S406. Closes the file at 5/5 (100%).
 *
 * Covered routes (5):
 *   - POST /api/stripe/connect/onboarding-session
 *   - GET  /api/stripe/connect/status
 *   - POST /api/stripe/tenant/setup
 *   - POST /api/stripe/tenant/confirm-setup       (S406 fixes)
 *   - GET  /api/stripe/tenant/payment-methods
 *
 * Stripe SDK + lib/stripe + services/stripeConnect are mocked.
 *
 * Production bugs fixed in this slice (2):
 *   - **POST /tenant/confirm-setup missing tenant-only check.** Sibling
 *     routes /tenant/setup and /tenant/payment-methods enforced it;
 *     this one did not. A non-tenant caller hit the ach_monitoring_log
 *     INSERT and 500'd on the tenant_id FK violation. Added the
 *     `if (req.user.role !== 'tenant') 403` gate consistent with siblings.
 *   - **POST /tenant/confirm-setup did not verify paymentMethodId
 *     ownership.** A tenant could supply another tenant's PM id and
 *     stamp their own row with foreign bank_last4 / routing — silent
 *     data corruption. Added a `pm.customer === tenant.stripe_customer_id`
 *     check; 403 on mismatch.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('../services/stripeConnect', () => ({
  ensureConnectAccount: vi.fn(async () => 'acct_mock_123'),
  createOnboardingSession: vi.fn(async () => 'as_mock_secret'),
  fetchAccountStatus: vi.fn(async () => ({
    charges_enabled: true,
    payouts_enabled: true,
    details_submitted: true,
  })),
}))

vi.mock('../lib/stripe', async () => {
  const customersCreate = vi.fn(async (args: any) => ({
    id: 'cus_mock_' + Math.random().toString(36).slice(2, 8),
    email: args.email,
  }))
  const setupIntentsCreate = vi.fn(async () => ({
    id: 'seti_mock', client_secret: 'seti_mock_secret',
  }))
  const paymentMethodsRetrieve = vi.fn(async () => ({
    id: 'pm_mock',
    customer: 'cus_mock_tenant',
    us_bank_account: { last4: '6789', routing_number: '110000000', bank_name: 'Test Bank' },
  }))
  const paymentMethodsList = vi.fn(async (args: any) => {
    if (args.type === 'us_bank_account') {
      return {
        data: [{ id: 'pm_ach_1',
                 us_bank_account: { bank_name: 'Test Bank', last4: '4321' } }],
      }
    }
    return {
      data: [{ id: 'pm_card_1',
               card: { brand: 'visa', last4: '1111', exp_month: 12, exp_year: 2030, country: 'US' } }],
    }
  })
  const fakeStripe = {
    customers: { create: customersCreate },
    setupIntents: { create: setupIntentsCreate },
    paymentMethods: { retrieve: paymentMethodsRetrieve, list: paymentMethodsList },
  }
  const createTenantAchSetup = vi.fn(async () => ({
    customerId: 'cus_mock_tenant', clientSecret: 'seti_mock_seed_secret',
  }))
  ;(globalThis as any).__stripeMocks = {
    customersCreate, setupIntentsCreate, paymentMethodsRetrieve,
    paymentMethodsList, createTenantAchSetup,
  }
  return {
    getStripe: () => fakeStripe,
    createTenantAchSetup,
  }
})

import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { randomUUID } from 'crypto'
import { db } from '../db'
import {
  cleanupAllSchema, seedLandlord, seedTenant,
} from '../test/dbHelpers'
import { stripeRouter } from './stripe'
import { errorHandler } from '../middleware/errorHandler'
import * as stripeConnect from '../services/stripeConnect'

function buildApp() {
  const app = express()
  app.use(express.json({ limit: '2mb' }))
  app.use('/api/stripe', stripeRouter)
  app.use(errorHandler)
  return app
}

const stripeMocks = (globalThis as any).__stripeMocks as {
  customersCreate:        ReturnType<typeof vi.fn>
  setupIntentsCreate:     ReturnType<typeof vi.fn>
  paymentMethodsRetrieve: ReturnType<typeof vi.fn>
  paymentMethodsList:     ReturnType<typeof vi.fn>
  createTenantAchSetup:   ReturnType<typeof vi.fn>
}

beforeEach(async () => {
  await cleanupAllSchema()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_stripe'
  ;[stripeMocks.customersCreate, stripeMocks.setupIntentsCreate,
    stripeMocks.paymentMethodsRetrieve, stripeMocks.paymentMethodsList,
    stripeMocks.createTenantAchSetup,
    stripeConnect.ensureConnectAccount as ReturnType<typeof vi.fn>,
    stripeConnect.createOnboardingSession as ReturnType<typeof vi.fn>,
    stripeConnect.fetchAccountStatus as ReturnType<typeof vi.fn>,
  ].forEach(m => (m as any).mockClear())
  stripeMocks.paymentMethodsRetrieve.mockResolvedValue({
    id: 'pm_mock',
    customer: 'cus_mock_tenant',
    us_bank_account: { last4: '6789', routing_number: '110000000', bank_name: 'Test Bank' },
  } as any)
})

const sign = (claims: any) =>
  jwt.sign(claims, process.env.JWT_SECRET!, { expiresIn: '1h' })

// ─── POST /api/stripe/connect/onboarding-session ────────────

describe('POST /api/stripe/connect/onboarding-session', () => {
  it('happy: entity=user creates / reuses caller\'s Connect account', async () => {
    const c = await db.connect()
    let aUid = ''
    try {
      await c.query('BEGIN')
      const { userId, landlordId } = await seedLandlord(c)
      aUid = userId
      await c.query('COMMIT')
      const token = sign({ userId: aUid, role: 'landlord', email: 'll@t.dev',
                           profileId: landlordId, permissions: {} })
      const res = await request(buildApp()).post('/api/stripe/connect/onboarding-session')
        .set('Authorization', `Bearer ${token}`)
        .send({ entity: 'user' })
      expect(res.status).toBe(200)
      expect(res.body.data.connectAccountId).toBe('acct_mock_123')
      expect(res.body.data.clientSecret).toBe('as_mock_secret')
      expect(stripeConnect.ensureConnectAccount).toHaveBeenCalledWith(
        expect.objectContaining({ entity: 'user', entityId: aUid }))
    } finally { c.release() }
  })

  it('entity=pm_company: caller is active owner → 200', async () => {
    const c = await db.connect()
    try {
      await c.query('BEGIN')
      const { userId } = await seedLandlord(c)
      const { rows: [{ id: pmCompanyId }] } = await c.query<{ id: string }>(
        `INSERT INTO pm_companies (name, business_email)
         VALUES ('Co', 'biz@co.dev') RETURNING id`)
      await c.query(
        `INSERT INTO pm_staff (pm_company_id, user_id, role, status)
         VALUES ($1, $2, 'owner', 'active')`, [pmCompanyId, userId])
      await c.query('COMMIT')
      const token = sign({ userId, role: 'landlord', email: 'll@t.dev',
                           profileId: randomUUID(), permissions: {} })
      const res = await request(buildApp()).post('/api/stripe/connect/onboarding-session')
        .set('Authorization', `Bearer ${token}`)
        .send({ entity: 'pm_company', entityId: pmCompanyId })
      expect(res.status).toBe(200)
      expect(stripeConnect.ensureConnectAccount).toHaveBeenCalledWith(
        expect.objectContaining({ entity: 'pm_company', entityId: pmCompanyId,
                                  email: 'biz@co.dev', businessName: 'Co' }))
    } finally { c.release() }
  })

  it('entity=pm_company: non-owner staff → 403', async () => {
    const c = await db.connect()
    try {
      await c.query('BEGIN')
      const { userId } = await seedLandlord(c)
      const { rows: [{ id: pmCompanyId }] } = await c.query<{ id: string }>(
        `INSERT INTO pm_companies (name) VALUES ('Co') RETURNING id`)
      await c.query(
        `INSERT INTO pm_staff (pm_company_id, user_id, role, status)
         VALUES ($1, $2, 'manager', 'active')`, [pmCompanyId, userId])
      await c.query('COMMIT')
      const token = sign({ userId, role: 'landlord', email: 'll@t.dev',
                           profileId: randomUUID(), permissions: {} })
      const res = await request(buildApp()).post('/api/stripe/connect/onboarding-session')
        .set('Authorization', `Bearer ${token}`)
        .send({ entity: 'pm_company', entityId: pmCompanyId })
      expect(res.status).toBe(403)
    } finally { c.release() }
  })

  it('entity=pm_company: non-staff caller → 403', async () => {
    const c = await db.connect()
    try {
      await c.query('BEGIN')
      const { userId } = await seedLandlord(c)
      const { rows: [{ id: pmCompanyId }] } = await c.query<{ id: string }>(
        `INSERT INTO pm_companies (name) VALUES ('Co') RETURNING id`)
      await c.query('COMMIT')
      const token = sign({ userId, role: 'landlord', email: 'll@t.dev',
                           profileId: randomUUID(), permissions: {} })
      const res = await request(buildApp()).post('/api/stripe/connect/onboarding-session')
        .set('Authorization', `Bearer ${token}`)
        .send({ entity: 'pm_company', entityId: pmCompanyId })
      expect(res.status).toBe(403)
    } finally { c.release() }
  })

  it('entity=pm_company: missing entityId → 400', async () => {
    const c = await db.connect()
    try {
      await c.query('BEGIN')
      const { userId, landlordId } = await seedLandlord(c)
      await c.query('COMMIT')
      const token = sign({ userId, role: 'landlord', email: 'll@t.dev',
                           profileId: landlordId, permissions: {} })
      const res = await request(buildApp()).post('/api/stripe/connect/onboarding-session')
        .set('Authorization', `Bearer ${token}`)
        .send({ entity: 'pm_company' })
      expect(res.status).toBe(400)
    } finally { c.release() }
  })

  it('invalid entity enum → 400', async () => {
    const c = await db.connect()
    try {
      await c.query('BEGIN')
      const { userId, landlordId } = await seedLandlord(c)
      await c.query('COMMIT')
      const token = sign({ userId, role: 'landlord', email: 'll@t.dev',
                           profileId: landlordId, permissions: {} })
      const res = await request(buildApp()).post('/api/stripe/connect/onboarding-session')
        .set('Authorization', `Bearer ${token}`)
        .send({ entity: 'organization' })
      expect(res.status).toBe(400)
    } finally { c.release() }
  })
})

// ─── GET /api/stripe/connect/status ─────────────────────────

describe('GET /api/stripe/connect/status', () => {
  it('entity=user with no Connect account stamped → exists:false', async () => {
    const c = await db.connect()
    try {
      await c.query('BEGIN')
      const { userId, landlordId } = await seedLandlord(c)
      await c.query('COMMIT')
      const token = sign({ userId, role: 'landlord', email: 'll@t.dev',
                           profileId: landlordId, permissions: {} })
      const res = await request(buildApp()).get('/api/stripe/connect/status?entity=user')
        .set('Authorization', `Bearer ${token}`)
      expect(res.status).toBe(200)
      expect(res.body.data).toEqual({ connectAccountId: null, exists: false })
      expect(stripeConnect.fetchAccountStatus).not.toHaveBeenCalled()
    } finally { c.release() }
  })

  it('entity=user with stamped account → returns Stripe status', async () => {
    const c = await db.connect()
    try {
      await c.query('BEGIN')
      const { userId, landlordId } = await seedLandlord(c)
      await c.query(`UPDATE users SET stripe_connect_account_id='acct_existing' WHERE id=$1`, [userId])
      await c.query('COMMIT')
      const token = sign({ userId, role: 'landlord', email: 'll@t.dev',
                           profileId: landlordId, permissions: {} })
      const res = await request(buildApp()).get('/api/stripe/connect/status?entity=user')
        .set('Authorization', `Bearer ${token}`)
      expect(res.status).toBe(200)
      expect(res.body.data).toMatchObject({
        connectAccountId: 'acct_existing', exists: true,
        charges_enabled: true, payouts_enabled: true,
      })
    } finally { c.release() }
  })

  it('entity=pm_company: non-staff → 403', async () => {
    const c = await db.connect()
    try {
      await c.query('BEGIN')
      const { userId } = await seedLandlord(c)
      const { rows: [{ id: pmCompanyId }] } = await c.query<{ id: string }>(
        `INSERT INTO pm_companies (name) VALUES ('Co') RETURNING id`)
      await c.query('COMMIT')
      const token = sign({ userId, role: 'landlord', email: 'll@t.dev',
                           profileId: randomUUID(), permissions: {} })
      const res = await request(buildApp())
        .get(`/api/stripe/connect/status?entity=pm_company&entityId=${pmCompanyId}`)
        .set('Authorization', `Bearer ${token}`)
      expect(res.status).toBe(403)
    } finally { c.release() }
  })

  it('entity=pm_company: missing entityId → 400', async () => {
    const c = await db.connect()
    try {
      await c.query('BEGIN')
      const { userId, landlordId } = await seedLandlord(c)
      await c.query('COMMIT')
      const token = sign({ userId, role: 'landlord', email: 'll@t.dev',
                           profileId: landlordId, permissions: {} })
      const res = await request(buildApp())
        .get('/api/stripe/connect/status?entity=pm_company')
        .set('Authorization', `Bearer ${token}`)
      expect(res.status).toBe(400)
    } finally { c.release() }
  })
})

// ─── POST /api/stripe/tenant/setup ──────────────────────────

describe('POST /api/stripe/tenant/setup', () => {
  it('non-tenant role → 403', async () => {
    const c = await db.connect()
    try {
      await c.query('BEGIN')
      const { userId, landlordId } = await seedLandlord(c)
      await c.query('COMMIT')
      const token = sign({ userId, role: 'landlord', email: 'll@t.dev',
                           profileId: landlordId, permissions: {} })
      const res = await request(buildApp()).post('/api/stripe/tenant/setup')
        .set('Authorization', `Bearer ${token}`)
        .send({ method: 'ach' })
      expect(res.status).toBe(403)
    } finally { c.release() }
  })

  it('ach first-setup: calls createTenantAchSetup + stamps stripe_customer_id', async () => {
    const c = await db.connect()
    let tenantId = ''; let userId = ''
    try {
      await c.query('BEGIN')
      tenantId = await seedTenant(c)
      const { rows: [{ user_id }] } = await c.query<{ user_id: string }>(
        `SELECT user_id FROM tenants WHERE id=$1`, [tenantId])
      userId = user_id
      await c.query('COMMIT')
      const token = sign({ userId, role: 'tenant', email: 't@t.dev', profileId: tenantId })
      const res = await request(buildApp()).post('/api/stripe/tenant/setup')
        .set('Authorization', `Bearer ${token}`)
        .send({ method: 'ach' })
      expect(res.status).toBe(200)
      expect(res.body.data.method).toBe('ach')
      expect(res.body.data.customerId).toBe('cus_mock_tenant')
      expect(stripeMocks.createTenantAchSetup).toHaveBeenCalledTimes(1)
      const { rows: [t] } = await db.query<any>(
        `SELECT stripe_customer_id FROM tenants WHERE id=$1`, [tenantId])
      expect(t.stripe_customer_id).toBe('cus_mock_tenant')
    } finally { c.release() }
  })

  it('card first-setup: creates customer + SetupIntent with card type', async () => {
    const c = await db.connect()
    let tenantId = ''; let userId = ''
    try {
      await c.query('BEGIN')
      tenantId = await seedTenant(c)
      const { rows: [{ user_id }] } = await c.query<{ user_id: string }>(
        `SELECT user_id FROM tenants WHERE id=$1`, [tenantId])
      userId = user_id
      await c.query('COMMIT')
      const token = sign({ userId, role: 'tenant', email: 't@t.dev', profileId: tenantId })
      const res = await request(buildApp()).post('/api/stripe/tenant/setup')
        .set('Authorization', `Bearer ${token}`)
        .send({ method: 'card' })
      expect(res.status).toBe(200)
      expect(res.body.data.method).toBe('card')
      expect(stripeMocks.customersCreate).toHaveBeenCalledTimes(1)
      const siCall = stripeMocks.setupIntentsCreate.mock.calls[0][0] as any
      expect(siCall.payment_method_types).toEqual(['card'])
      expect(siCall.usage).toBe('off_session')
    } finally { c.release() }
  })

  it('reuses existing stripe_customer_id (no createTenantAchSetup call)', async () => {
    const c = await db.connect()
    let tenantId = ''; let userId = ''
    try {
      await c.query('BEGIN')
      tenantId = await seedTenant(c)
      const { rows: [{ user_id }] } = await c.query<{ user_id: string }>(
        `SELECT user_id FROM tenants WHERE id=$1`, [tenantId])
      userId = user_id
      await c.query(`UPDATE tenants SET stripe_customer_id='cus_pre_existing' WHERE id=$1`, [tenantId])
      await c.query('COMMIT')
      const token = sign({ userId, role: 'tenant', email: 't@t.dev', profileId: tenantId })
      const res = await request(buildApp()).post('/api/stripe/tenant/setup')
        .set('Authorization', `Bearer ${token}`)
        .send({ method: 'ach' })
      expect(res.status).toBe(200)
      expect(res.body.data.customerId).toBe('cus_pre_existing')
      expect(stripeMocks.createTenantAchSetup).not.toHaveBeenCalled()
      expect(stripeMocks.setupIntentsCreate).toHaveBeenCalledWith(
        expect.objectContaining({ customer: 'cus_pre_existing' }))
    } finally { c.release() }
  })

  it('invalid method enum → 400', async () => {
    const c = await db.connect()
    let tenantId = ''; let userId = ''
    try {
      await c.query('BEGIN')
      tenantId = await seedTenant(c)
      const { rows: [{ user_id }] } = await c.query<{ user_id: string }>(
        `SELECT user_id FROM tenants WHERE id=$1`, [tenantId])
      userId = user_id
      await c.query('COMMIT')
      const token = sign({ userId, role: 'tenant', email: 't@t.dev', profileId: tenantId })
      const res = await request(buildApp()).post('/api/stripe/tenant/setup')
        .set('Authorization', `Bearer ${token}`)
        .send({ method: 'crypto' })
      expect(res.status).toBe(400)
    } finally { c.release() }
  })
})

// ─── POST /api/stripe/tenant/confirm-setup ──────────────────

describe('POST /api/stripe/tenant/confirm-setup', () => {
  async function seedTenantWithStripe() {
    const c = await db.connect()
    try {
      await c.query('BEGIN')
      const tenantId = await seedTenant(c)
      const { rows: [{ user_id }] } = await c.query<{ user_id: string }>(
        `SELECT user_id FROM tenants WHERE id=$1`, [tenantId])
      await c.query(`UPDATE tenants SET stripe_customer_id='cus_mock_tenant' WHERE id=$1`, [tenantId])
      await c.query('COMMIT')
      return { tenantId, userId: user_id }
    } catch (e) { await c.query('ROLLBACK'); throw e }
    finally { c.release() }
  }

  it('happy: stamps ach_verified=TRUE + bank info, logs first-sender row', async () => {
    const { tenantId, userId } = await seedTenantWithStripe()
    const token = sign({ userId, role: 'tenant', email: 't@t.dev', profileId: tenantId })
    const res = await request(buildApp()).post('/api/stripe/tenant/confirm-setup')
      .set('Authorization', `Bearer ${token}`)
      .send({ setupIntentId: 'seti_x', paymentMethodId: 'pm_x' })
    expect(res.status).toBe(200)
    const { rows: [t] } = await db.query<any>(
      `SELECT ach_verified, bank_last4, bank_routing_last4 FROM tenants WHERE id=$1`,
      [tenantId])
    expect(t.ach_verified).toBe(true)
    expect(t.bank_last4).toBe('6789')
    expect(t.bank_routing_last4).toBe('0000')
    const { rows: log } = await db.query<any>(
      `SELECT event_type FROM ach_monitoring_log WHERE tenant_id=$1`, [tenantId])
    expect(log).toHaveLength(1)
    expect(log[0].event_type).toBe('first_sender')
  })

  it('S406 fix: non-tenant caller → 403 (was 500 pre-fix from ach_monitoring_log FK)', async () => {
    const c = await db.connect()
    try {
      await c.query('BEGIN')
      const { userId, landlordId } = await seedLandlord(c)
      await c.query('COMMIT')
      const token = sign({ userId, role: 'landlord', email: 'll@t.dev',
                           profileId: landlordId, permissions: {} })
      const res = await request(buildApp()).post('/api/stripe/tenant/confirm-setup')
        .set('Authorization', `Bearer ${token}`)
        .send({ setupIntentId: 'seti_x', paymentMethodId: 'pm_x' })
      expect(res.status).toBe(403)
    } finally { c.release() }
  })

  it('S406 fix: paymentMethod from another tenant\'s customer → 403', async () => {
    const { tenantId, userId } = await seedTenantWithStripe()
    // Stripe returns a PM whose customer is someone else's.
    stripeMocks.paymentMethodsRetrieve.mockResolvedValueOnce({
      id: 'pm_foreign',
      customer: 'cus_some_other_tenant',
      us_bank_account: { last4: '9999', routing_number: '111111111' },
    } as any)
    const token = sign({ userId, role: 'tenant', email: 't@t.dev', profileId: tenantId })
    const res = await request(buildApp()).post('/api/stripe/tenant/confirm-setup')
      .set('Authorization', `Bearer ${token}`)
      .send({ setupIntentId: 'seti_x', paymentMethodId: 'pm_foreign' })
    expect(res.status).toBe(403)
    // Verify the caller's row was NOT updated with foreign data.
    const { rows: [t] } = await db.query<any>(
      `SELECT ach_verified, bank_last4 FROM tenants WHERE id=$1`, [tenantId])
    expect(t.ach_verified).toBe(false)
    expect(t.bank_last4).toBeNull()
  })

  it('tenant with no stripe_customer_id yet → 409', async () => {
    const c = await db.connect()
    let tenantId = ''; let userId = ''
    try {
      await c.query('BEGIN')
      tenantId = await seedTenant(c)
      const { rows: [{ user_id }] } = await c.query<{ user_id: string }>(
        `SELECT user_id FROM tenants WHERE id=$1`, [tenantId])
      userId = user_id
      await c.query('COMMIT')
      const token = sign({ userId, role: 'tenant', email: 't@t.dev', profileId: tenantId })
      const res = await request(buildApp()).post('/api/stripe/tenant/confirm-setup')
        .set('Authorization', `Bearer ${token}`)
        .send({ setupIntentId: 'seti_x', paymentMethodId: 'pm_x' })
      expect(res.status).toBe(409)
    } finally { c.release() }
  })

  it('missing setupIntentId → 400', async () => {
    const { tenantId, userId } = await seedTenantWithStripe()
    const token = sign({ userId, role: 'tenant', email: 't@t.dev', profileId: tenantId })
    const res = await request(buildApp()).post('/api/stripe/tenant/confirm-setup')
      .set('Authorization', `Bearer ${token}`)
      .send({ paymentMethodId: 'pm_x' })
    expect(res.status).toBe(400)
  })
})

// ─── GET /api/stripe/tenant/payment-methods ─────────────────

describe('GET /api/stripe/tenant/payment-methods', () => {
  it('non-tenant → 403', async () => {
    const c = await db.connect()
    try {
      await c.query('BEGIN')
      const { userId, landlordId } = await seedLandlord(c)
      await c.query('COMMIT')
      const token = sign({ userId, role: 'landlord', email: 'll@t.dev',
                           profileId: landlordId, permissions: {} })
      const res = await request(buildApp()).get('/api/stripe/tenant/payment-methods')
        .set('Authorization', `Bearer ${token}`)
      expect(res.status).toBe(403)
    } finally { c.release() }
  })

  it('tenant with no stripe_customer_id → [] (no Stripe calls)', async () => {
    const c = await db.connect()
    let tenantId = ''; let userId = ''
    try {
      await c.query('BEGIN')
      tenantId = await seedTenant(c)
      const { rows: [{ user_id }] } = await c.query<{ user_id: string }>(
        `SELECT user_id FROM tenants WHERE id=$1`, [tenantId])
      userId = user_id
      await c.query('COMMIT')
      const token = sign({ userId, role: 'tenant', email: 't@t.dev', profileId: tenantId })
      const res = await request(buildApp()).get('/api/stripe/tenant/payment-methods')
        .set('Authorization', `Bearer ${token}`)
      expect(res.status).toBe(200)
      expect(res.body.data).toEqual([])
      expect(stripeMocks.paymentMethodsList).not.toHaveBeenCalled()
    } finally { c.release() }
  })

  it('happy: combines ACH + card lists with normalized shape', async () => {
    const c = await db.connect()
    let tenantId = ''; let userId = ''
    try {
      await c.query('BEGIN')
      tenantId = await seedTenant(c)
      const { rows: [{ user_id }] } = await c.query<{ user_id: string }>(
        `SELECT user_id FROM tenants WHERE id=$1`, [tenantId])
      userId = user_id
      await c.query(`UPDATE tenants SET stripe_customer_id='cus_mock_tenant' WHERE id=$1`, [tenantId])
      await c.query('COMMIT')
      const token = sign({ userId, role: 'tenant', email: 't@t.dev', profileId: tenantId })
      const res = await request(buildApp()).get('/api/stripe/tenant/payment-methods')
        .set('Authorization', `Bearer ${token}`)
      expect(res.status).toBe(200)
      expect(res.body.data).toHaveLength(2)
      const ach = res.body.data.find((p: any) => p.type === 'ach')
      const card = res.body.data.find((p: any) => p.type === 'card')
      expect(ach).toMatchObject({ id: 'pm_ach_1', bankName: 'Test Bank', last4: '4321' })
      expect(card).toMatchObject({ id: 'pm_card_1', brand: 'visa', last4: '1111',
                                   expMonth: 12, expYear: 2030, country: 'US' })
    } finally { c.release() }
  })

  it('tenant not found → 404', async () => {
    const token = sign({ userId: randomUUID(), role: 'tenant',
                         email: 't@t.dev', profileId: randomUUID() })
    const res = await request(buildApp()).get('/api/stripe/tenant/payment-methods')
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(404)
  })
})
