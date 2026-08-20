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
  // S570: confirm-setup gates ach_verified on the SetupIntent status.
  // Default 'succeeded' (verified path); the microdeposit-pending test overrides.
  // S605: confirm-setup proves PM ownership from the SetupIntent (customer +
  // payment_method) rather than pm.customer, because a microdeposit ACH
  // PaymentMethod stays unattached until the deposits are confirmed. The mock
  // must carry both fields, as the real Stripe object does.
  const setupIntentsRetrieve = vi.fn(async () => ({
    id: 'seti_mock', status: 'succeeded',
    customer: 'cus_mock_tenant', payment_method: 'pm_x',
  }))
  // S605: the microdeposit verify path lists the tenant's SetupIntents and
  // submits either amounts or a descriptor code.
  const setupIntentsList = vi.fn(async () => ({ data: [] as any[] }))
  const verifyMicrodeposits = vi.fn(async () => ({ id: 'seti_pending', status: 'processing' }))
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
  // S571: default payment method lives on the customer; swap detaches others.
  const customersRetrieve = vi.fn(async (id: string) => ({
    id, invoice_settings: { default_payment_method: 'pm_ach_1' },
  }))
  const customersUpdate = vi.fn(async (id: string, args: any) => ({ id, ...args }))
  const paymentMethodsDetach = vi.fn(async (id: string) => ({ id }))
  const fakeStripe = {
    customers: { create: customersCreate, retrieve: customersRetrieve, update: customersUpdate },
    setupIntents: { create: setupIntentsCreate, retrieve: setupIntentsRetrieve, list: setupIntentsList, verifyMicrodeposits },
    paymentMethods: { retrieve: paymentMethodsRetrieve, list: paymentMethodsList, detach: paymentMethodsDetach },
  }
  const createTenantAchSetup = vi.fn(async () => ({
    customerId: 'cus_mock_tenant', clientSecret: 'seti_mock_seed_secret',
  }))
  ;(globalThis as any).__stripeMocks = {
    customersCreate, customersRetrieve, customersUpdate, setupIntentsCreate, setupIntentsRetrieve,
    setupIntentsList, verifyMicrodeposits,
    paymentMethodsRetrieve, paymentMethodsList, paymentMethodsDetach, createTenantAchSetup,
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
  setupIntentsRetrieve:   ReturnType<typeof vi.fn>
  setupIntentsList:       ReturnType<typeof vi.fn>
  verifyMicrodeposits:    ReturnType<typeof vi.fn>
  paymentMethodsRetrieve: ReturnType<typeof vi.fn>
  paymentMethodsList:     ReturnType<typeof vi.fn>
  paymentMethodsDetach:   ReturnType<typeof vi.fn>
  customersRetrieve:      ReturnType<typeof vi.fn>
  customersUpdate:        ReturnType<typeof vi.fn>
  createTenantAchSetup:   ReturnType<typeof vi.fn>
}

beforeEach(async () => {
  await cleanupAllSchema()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_stripe'
  ;[stripeMocks.customersCreate, stripeMocks.setupIntentsCreate,
    stripeMocks.setupIntentsRetrieve,
    stripeMocks.paymentMethodsRetrieve, stripeMocks.paymentMethodsList,
    stripeMocks.paymentMethodsDetach, stripeMocks.customersRetrieve, stripeMocks.customersUpdate,
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
  // S570: default SetupIntent status = succeeded (verified path).
  stripeMocks.setupIntentsRetrieve.mockResolvedValue({ id: 'seti_mock', status: 'succeeded', customer: 'cus_mock_tenant', payment_method: 'pm_x' } as any)
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

  // S603: a tenant may only add a CARD when something is actually due — storing
  // a card early burns a $0.26 Stripe authorization (+ $0.02 Radar) that collects
  // nothing. Card entry belongs at the moment of payment. ACH is exempt.
  async function seedOutstanding(c: any, tenantId: string): Promise<void> {
    const { landlordId } = await seedLandlord(c)
    await c.query(
      `INSERT INTO payments
         (tenant_id, landlord_id, type, amount, status, entry_description, due_date)
       VALUES ($1, $2, 'rent', 1000, 'pending', 'RENT', CURRENT_DATE)`,
      [tenantId, landlordId])
  }

  it('card setup is REFUSED when the tenant owes nothing (S603 auth-cost gate)', async () => {
    const c = await db.connect()
    try {
      await c.query('BEGIN')
      const tenantId = await seedTenant(c)
      const { rows: [{ user_id }] } = await c.query<{ user_id: string }>(
        `SELECT user_id FROM tenants WHERE id=$1`, [tenantId])
      await c.query('COMMIT')
      const token = sign({ userId: user_id, role: 'tenant', email: 't@t.dev', profileId: tenantId })
      const res = await request(buildApp()).post('/api/stripe/tenant/setup')
        .set('Authorization', `Bearer ${token}`)
        .send({ method: 'card' })
      expect(res.status).toBe(409)
      // No Stripe object may be created — that's the whole point of the gate.
      expect(stripeMocks.setupIntentsCreate).not.toHaveBeenCalled()
      expect(stripeMocks.customersCreate).not.toHaveBeenCalled()
    } finally { c.release() }
  })

  it('ACH setup is still allowed with nothing due (a bank mandate is not an authorization)', async () => {
    const c = await db.connect()
    try {
      await c.query('BEGIN')
      const tenantId = await seedTenant(c)
      const { rows: [{ user_id }] } = await c.query<{ user_id: string }>(
        `SELECT user_id FROM tenants WHERE id=$1`, [tenantId])
      await c.query('COMMIT')
      const token = sign({ userId: user_id, role: 'tenant', email: 't@t.dev', profileId: tenantId })
      const res = await request(buildApp()).post('/api/stripe/tenant/setup')
        .set('Authorization', `Bearer ${token}`)
        .send({ method: 'ach' })
      expect(res.status).toBe(200)
    } finally { c.release() }
  })

  it('card first-setup: creates customer + SetupIntent with card type', async () => {
    const c = await db.connect()
    let tenantId = ''; let userId = ''
    try {
      await c.query('BEGIN')
      tenantId = await seedTenant(c)
      await seedOutstanding(c, tenantId)
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

  it('S570 microdeposit pending: SetupIntent not succeeded → ach_verified stays FALSE, no first-sender log, stamps bank + returns verified:false', async () => {
    const { tenantId, userId } = await seedTenantWithStripe()
    // S605: the pending-microdeposit case is exactly where the PaymentMethod is
    // NOT yet attached, so the SetupIntent carries the ownership proof.
    stripeMocks.setupIntentsRetrieve.mockResolvedValueOnce(
      { id: 'seti_x', status: 'requires_action', customer: 'cus_mock_tenant', payment_method: 'pm_x' } as any)
    const token = sign({ userId, role: 'tenant', email: 't@t.dev', profileId: tenantId })
    const res = await request(buildApp()).post('/api/stripe/tenant/confirm-setup')
      .set('Authorization', `Bearer ${token}`)
      .send({ setupIntentId: 'seti_x', paymentMethodId: 'pm_x' })
    expect(res.status).toBe(200)
    expect(res.body.verified).toBe(false)
    const { rows: [t] } = await db.query<any>(
      `SELECT ach_verified, bank_last4 FROM tenants WHERE id=$1`, [tenantId])
    expect(t.ach_verified).toBe(false)
    expect(t.bank_last4).toBe('6789')       // bank metadata still stamped
    const { rows: log } = await db.query<any>(
      `SELECT event_type FROM ach_monitoring_log WHERE tenant_id=$1`, [tenantId])
    expect(log).toHaveLength(0)             // first-sender waits for the webhook
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

  // S605 (Nic hit this live): the very first bank a tenant added always 403'd
  // with "payment method does not belong to this tenant" — the check read
  // pm.customer, which is NULL for microdeposit ACH until the deposits clear
  // days later. Stripe had accepted the bank; GAM refused to record it.
  it('S605: unattached microdeposit PM (pm.customer null) is still recorded', async () => {
    const { tenantId, userId } = await seedTenantWithStripe()
    stripeMocks.setupIntentsRetrieve.mockResolvedValueOnce(
      { id: 'seti_x', status: 'requires_action', customer: 'cus_mock_tenant', payment_method: 'pm_x' } as any)
    stripeMocks.paymentMethodsRetrieve.mockResolvedValueOnce({
      id: 'pm_x',
      customer: null,                       // the whole point: NOT yet attached
      us_bank_account: { last4: '5059', routing_number: '325070760', bank_name: 'WAFD BANK' },
    } as any)
    const token = sign({ userId, role: 'tenant', email: 't@t.dev', profileId: tenantId })
    const res = await request(buildApp()).post('/api/stripe/tenant/confirm-setup')
      .set('Authorization', `Bearer ${token}`)
      .send({ setupIntentId: 'seti_x', paymentMethodId: 'pm_x' })
    expect(res.status).toBe(200)
    expect(res.body.verified).toBe(false)   // pending microdeposits, not verified
    expect(res.body.bankName).toBe('WAFD BANK')
    const { rows: [t] } = await db.query<any>(
      `SELECT bank_last4 FROM tenants WHERE id=$1`, [tenantId])
    expect(t.bank_last4).toBe('5059')
  })

  // The S406 property must survive the S605 rewrite: ownership is now proven
  // from the SetupIntent, so a foreign PM id fails because it isn't on the
  // caller's SetupIntent — not because of pm.customer.
  it('S605: a payment method NOT on the callers SetupIntent → 403', async () => {
    const { tenantId, userId } = await seedTenantWithStripe()
    stripeMocks.setupIntentsRetrieve.mockResolvedValueOnce(
      { id: 'seti_x', status: 'succeeded', customer: 'cus_mock_tenant', payment_method: 'pm_mine' } as any)
    const token = sign({ userId, role: 'tenant', email: 't@t.dev', profileId: tenantId })
    const res = await request(buildApp()).post('/api/stripe/tenant/confirm-setup')
      .set('Authorization', `Bearer ${token}`)
      .send({ setupIntentId: 'seti_x', paymentMethodId: 'pm_someone_elses' })
    expect(res.status).toBe(403)
  })

  // A SetupIntent belonging to a DIFFERENT Stripe customer must be refused even
  // when the payment method id lines up.
  it('S605: a SetupIntent owned by another customer → 403', async () => {
    const { tenantId, userId } = await seedTenantWithStripe()
    stripeMocks.setupIntentsRetrieve.mockResolvedValueOnce(
      { id: 'seti_x', status: 'succeeded', customer: 'cus_some_other_tenant', payment_method: 'pm_x' } as any)
    const token = sign({ userId, role: 'tenant', email: 't@t.dev', profileId: tenantId })
    const res = await request(buildApp()).post('/api/stripe/tenant/confirm-setup')
      .set('Authorization', `Bearer ${token}`)
      .send({ setupIntentId: 'seti_x', paymentMethodId: 'pm_x' })
    expect(res.status).toBe(403)
  })

  // S605 (Nic): "we need our user interface to also allow the correct inputs
  // based on what the bank chooses." The GET drives which fields render, so it
  // must report the REAL type and must not invent one.
  describe('GET /api/stripe/tenant/microdeposits — type drives the UI', () => {
    const pendingSi = (mdType: string | null) => ({
      id: 'seti_pending', status: 'requires_action',
      next_action: {
        type: 'verify_with_microdeposits',
        verify_with_microdeposits: {
          ...(mdType ? { microdeposit_type: mdType } : {}),
          arrival_date: 1755500000,
        },
      },
    })

    it('descriptor_code is reported as descriptor_code', async () => {
      const { tenantId, userId } = await seedTenantWithStripe()
      stripeMocks.setupIntentsList.mockResolvedValueOnce({ data: [pendingSi('descriptor_code')] } as any)
      const token = sign({ userId, role: 'tenant', email: 't@t.dev', profileId: tenantId })
      const res = await request(buildApp()).get('/api/stripe/tenant/microdeposits')
        .set('Authorization', `Bearer ${token}`)
      expect(res.status).toBe(200)
      expect(res.body.data.pending).toBe(true)
      expect(res.body.data.microdepositType).toBe('descriptor_code')
    })

    it('amounts is reported as amounts', async () => {
      const { tenantId, userId } = await seedTenantWithStripe()
      stripeMocks.setupIntentsList.mockResolvedValueOnce({ data: [pendingSi('amounts')] } as any)
      const token = sign({ userId, role: 'tenant', email: 't@t.dev', profileId: tenantId })
      const res = await request(buildApp()).get('/api/stripe/tenant/microdeposits')
        .set('Authorization', `Bearer ${token}`)
      expect(res.body.data.microdepositType).toBe('amounts')
    })

    // The regression that matters: this used to default to 'amounts', which
    // would show two amount boxes to a tenant holding a six-digit code.
    it('an undetectable type reports NULL, never a guess', async () => {
      const { tenantId, userId } = await seedTenantWithStripe()
      stripeMocks.setupIntentsList.mockResolvedValueOnce({ data: [pendingSi(null)] } as any)
      const token = sign({ userId, role: 'tenant', email: 't@t.dev', profileId: tenantId })
      const res = await request(buildApp()).get('/api/stripe/tenant/microdeposits')
        .set('Authorization', `Bearer ${token}`)
      expect(res.body.data.pending).toBe(true)
      expect(res.body.data.microdepositType).toBeNull()
    })
  })

  // Whatever the UI renders, the verify endpoint must accept BOTH shapes — that
  // is what makes the unknown-type screen (which offers both) usable.
  describe('POST /api/stripe/tenant/microdeposits/verify — both input shapes', () => {
    const pending = {
      id: 'seti_pending', status: 'requires_action',
      next_action: { type: 'verify_with_microdeposits', verify_with_microdeposits: {} },
    }

    it('accepts a descriptor code', async () => {
      const { tenantId, userId } = await seedTenantWithStripe()
      stripeMocks.setupIntentsList.mockResolvedValueOnce({ data: [pending] } as any)
      const token = sign({ userId, role: 'tenant', email: 't@t.dev', profileId: tenantId })
      const res = await request(buildApp()).post('/api/stripe/tenant/microdeposits/verify')
        .set('Authorization', `Bearer ${token}`).send({ descriptorCode: 'SM1234' })
      expect(res.status).toBe(200)
      expect(stripeMocks.verifyMicrodeposits).toHaveBeenCalledWith('seti_pending', { descriptor_code: 'SM1234' })
    })

    // S607 (Nic): "is it case sensitive because the field is letting me type
    // lowercase? Should we lock the field to capital letters?" Stripe issues the
    // code upper case and a statement may render it either way. A wrong guess is
    // not free — Stripe counts them and locks the SetupIntent — so the code is
    // normalised on the SERVER, covering every client rather than only the one
    // field that was fixed alongside it.
    it('upper-cases a lower-case descriptor code before it reaches Stripe', async () => {
      const { tenantId, userId } = await seedTenantWithStripe()
      stripeMocks.setupIntentsList.mockResolvedValueOnce({ data: [pending] } as any)
      const token = sign({ userId, role: 'tenant', email: 't@t.dev', profileId: tenantId })
      const res = await request(buildApp()).post('/api/stripe/tenant/microdeposits/verify')
        .set('Authorization', `Bearer ${token}`).send({ descriptorCode: '  sm12ab ' })
      expect(res.status).toBe(200)
      expect(stripeMocks.verifyMicrodeposits).toHaveBeenCalledWith('seti_pending', { descriptor_code: 'SM12AB' })
    })

    it('accepts two amounts', async () => {
      const { tenantId, userId } = await seedTenantWithStripe()
      stripeMocks.setupIntentsList.mockResolvedValueOnce({ data: [pending] } as any)
      const token = sign({ userId, role: 'tenant', email: 't@t.dev', profileId: tenantId })
      const res = await request(buildApp()).post('/api/stripe/tenant/microdeposits/verify')
        .set('Authorization', `Bearer ${token}`).send({ amounts: [32, 45] })
      expect(res.status).toBe(200)
      expect(stripeMocks.verifyMicrodeposits).toHaveBeenCalledWith('seti_pending', { amounts: [32, 45] })
    })

    it('rejects an empty submission', async () => {
      const { tenantId, userId } = await seedTenantWithStripe()
      const token = sign({ userId, role: 'tenant', email: 't@t.dev', profileId: tenantId })
      const res = await request(buildApp()).post('/api/stripe/tenant/microdeposits/verify')
        .set('Authorization', `Bearer ${token}`).send({})
      expect(res.status).toBe(400)
    })
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

  it('S571: marks the customer default method with isDefault', async () => {
    const c = await db.connect()
    let tenantId = ''; let userId = ''
    try {
      await c.query('BEGIN')
      tenantId = await seedTenant(c)
      const { rows: [{ user_id }] } = await c.query<{ user_id: string }>(`SELECT user_id FROM tenants WHERE id=$1`, [tenantId])
      userId = user_id
      await c.query(`UPDATE tenants SET stripe_customer_id='cus_mock_tenant' WHERE id=$1`, [tenantId])
      await c.query('COMMIT')
    } finally { c.release() }
    // Mock customer default = pm_ach_1.
    const token = sign({ userId, role: 'tenant', email: 't@t.dev', profileId: tenantId })
    const res = await request(buildApp()).get('/api/stripe/tenant/payment-methods').set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    expect(res.body.data.find((p: any) => p.id === 'pm_ach_1').isDefault).toBe(true)
    expect(res.body.data.find((p: any) => p.id === 'pm_card_1').isDefault).toBe(false)
  })
})

// ─── S571: default + one-of-each swap ─────────────────────────
describe('S571 payment-method default + swap', () => {
  async function seedStripeTenant() {
    const c = await db.connect()
    try {
      await c.query('BEGIN')
      const tenantId = await seedTenant(c)
      const { rows: [{ user_id }] } = await c.query<{ user_id: string }>(`SELECT user_id FROM tenants WHERE id=$1`, [tenantId])
      await c.query(`UPDATE tenants SET stripe_customer_id='cus_mock_tenant' WHERE id=$1`, [tenantId])
      await c.query('COMMIT')
      return { tenantId, userId: user_id }
    } finally { c.release() }
  }

  it('PATCH default-payment-method sets the customer default', async () => {
    const { tenantId, userId } = await seedStripeTenant()
    stripeMocks.paymentMethodsRetrieve.mockResolvedValueOnce({ id: 'pm_card_1', customer: 'cus_mock_tenant', type: 'card' })
    const token = sign({ userId, role: 'tenant', email: 't@t.dev', profileId: tenantId })
    const res = await request(buildApp()).patch('/api/stripe/tenant/default-payment-method')
      .set('Authorization', `Bearer ${token}`).send({ paymentMethodId: 'pm_card_1' })
    expect(res.status).toBe(200)
    expect(stripeMocks.customersUpdate).toHaveBeenCalledWith('cus_mock_tenant', { invoice_settings: { default_payment_method: 'pm_card_1' } })
  })

  it('PATCH rejects a payment method that is not the tenant\'s', async () => {
    const { tenantId, userId } = await seedStripeTenant()
    stripeMocks.paymentMethodsRetrieve.mockResolvedValueOnce({ id: 'pm_x', customer: 'cus_someone_else', type: 'card' })
    const token = sign({ userId, role: 'tenant', email: 't@t.dev', profileId: tenantId })
    const res = await request(buildApp()).patch('/api/stripe/tenant/default-payment-method')
      .set('Authorization', `Bearer ${token}`).send({ paymentMethodId: 'pm_x' })
    expect(res.status).toBe(403)
  })

  it('confirm-card detaches the old card (one card on file), keeps ACH default', async () => {
    const { tenantId, userId } = await seedStripeTenant()
    // The new card:
    stripeMocks.paymentMethodsRetrieve.mockResolvedValueOnce({ id: 'pm_card_new', customer: 'cus_mock_tenant', type: 'card' })
    // Two cards currently attached — the old one must be detached.
    stripeMocks.paymentMethodsList.mockResolvedValueOnce({ data: [{ id: 'pm_card_old' }, { id: 'pm_card_new' }] })
    const token = sign({ userId, role: 'tenant', email: 't@t.dev', profileId: tenantId })
    const res = await request(buildApp()).post('/api/stripe/tenant/confirm-card')
      .set('Authorization', `Bearer ${token}`).send({ paymentMethodId: 'pm_card_new' })
    expect(res.status).toBe(200)
    expect(stripeMocks.paymentMethodsDetach).toHaveBeenCalledWith('pm_card_old')
    expect(stripeMocks.paymentMethodsDetach).not.toHaveBeenCalledWith('pm_card_new')
    // ACH already default (mock customersRetrieve) → confirm-card must NOT override it.
    expect(stripeMocks.customersUpdate).not.toHaveBeenCalled()
  })
})
