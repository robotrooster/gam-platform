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
 * S655 (money plan Step 5, item L — keep the old bank): confirm-setup no
 * longer detaches anything; GET reports each bank's own state; the tenant
 * removes a saved method with DELETE /tenant/payment-methods/:id (refused while
 * it is the only verified bank and the account still needs it). The service
 * behind them, services/tenantBankMethods.ts, is tested here too, on the same
 * Stripe mock.
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
  const setupIntentsCancel = vi.fn(async (id: string) => ({ id, status: 'canceled' }))
  const verifyMicrodeposits = vi.fn(async () => ({ id: 'seti_pending', status: 'processing' }))
  const paymentMethodsRetrieve = vi.fn(async () => ({
    id: 'pm_mock',
    type: 'us_bank_account',
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
  // S655: a verified bank is marked once GAM has made it the default.
  const paymentMethodsUpdate = vi.fn(async (id: string, args: any) => ({ id, ...args }))
  // S655: a removal asks which method each pull still in flight was made from.
  // By default Stripe names none, so only the tests that say otherwise see a
  // pull from one of the tenant's banks.
  const paymentIntentsRetrieve = vi.fn(async (id: string) => ({
    id, status: 'processing', payment_method: null, last_payment_error: null,
  }))
  const fakeStripe = {
    customers: { create: customersCreate, retrieve: customersRetrieve, update: customersUpdate },
    setupIntents: { create: setupIntentsCreate, retrieve: setupIntentsRetrieve, list: setupIntentsList, cancel: setupIntentsCancel, verifyMicrodeposits },
    paymentMethods: { retrieve: paymentMethodsRetrieve, list: paymentMethodsList, detach: paymentMethodsDetach,
                      update: paymentMethodsUpdate },
    paymentIntents: { retrieve: paymentIntentsRetrieve },
  }
  const createTenantAchSetup = vi.fn(async () => ({
    customerId: 'cus_mock_tenant', clientSecret: 'seti_mock_seed_secret',
  }))
  ;(globalThis as any).__stripeMocks = {
    customersCreate, customersRetrieve, customersUpdate, setupIntentsCreate, setupIntentsRetrieve,
    setupIntentsList, setupIntentsCancel, verifyMicrodeposits,
    paymentMethodsRetrieve, paymentMethodsList, paymentMethodsDetach, createTenantAchSetup,
    paymentIntentsRetrieve, paymentMethodsUpdate,
    // S655: the factory implementations, so beforeEach can put back any a
    // test replaced with mockImplementation (mockClear keeps those).
    defaults: { paymentMethodsList, setupIntentsList, customersRetrieve, customersUpdate,
                paymentMethodsDetach, setupIntentsCancel, paymentIntentsRetrieve, paymentMethodsUpdate,
                impl: {
                  paymentMethodsList: paymentMethodsList.getMockImplementation(),
                  setupIntentsList: setupIntentsList.getMockImplementation(),
                  customersRetrieve: customersRetrieve.getMockImplementation(),
                  customersUpdate: customersUpdate.getMockImplementation(),
                  paymentMethodsDetach: paymentMethodsDetach.getMockImplementation(),
                  setupIntentsCancel: setupIntentsCancel.getMockImplementation(),
                  paymentIntentsRetrieve: paymentIntentsRetrieve.getMockImplementation(),
                  paymentMethodsUpdate: paymentMethodsUpdate.getMockImplementation(),
                } },
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
  cleanupAllSchema, seedLandlord, seedTenant, seedProperty, seedUnit, seedLease, seedLeaseTenant,
} from '../test/dbHelpers'
import { stripeRouter } from './stripe'
import {
  recordVerifiedTenantBank, planBankBackfill, readStripeMethodFacts,
  BANK_CHECK_RECEIVED, DEFAULT_BLOCKED_WHILE_CHECKING, DEFAULT_BLOCKED_UNTIL_VERIFIED,
} from '../services/tenantBankMethods'
import { sendBankVerificationNudges } from '../jobs/bankVerificationNudge'
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
  setupIntentsCancel:     ReturnType<typeof vi.fn>
  verifyMicrodeposits:    ReturnType<typeof vi.fn>
  paymentMethodsRetrieve: ReturnType<typeof vi.fn>
  paymentMethodsList:     ReturnType<typeof vi.fn>
  paymentMethodsDetach:   ReturnType<typeof vi.fn>
  customersRetrieve:      ReturnType<typeof vi.fn>
  customersUpdate:        ReturnType<typeof vi.fn>
  createTenantAchSetup:   ReturnType<typeof vi.fn>
  paymentIntentsRetrieve: ReturnType<typeof vi.fn>
  paymentMethodsUpdate:   ReturnType<typeof vi.fn>
  defaults:               { impl: Record<string, any> } & Record<string, ReturnType<typeof vi.fn>>
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
    stripeMocks.setupIntentsList, stripeMocks.setupIntentsCancel,
  ].forEach(m => (m as any).mockClear())
  // S655: put back every implementation a test replaced (mockImplementation
  // survives mockClear, and the removal tests run a stateful Stripe).
  for (const [name, impl] of Object.entries(stripeMocks.defaults.impl)) {
    stripeMocks.defaults[name].mockReset()
    stripeMocks.defaults[name].mockImplementation(impl)
  }
  stripeMocks.paymentMethodsRetrieve.mockResolvedValue({
    id: 'pm_mock',
    type: 'us_bank_account',
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

// A bank setup Stripe is waiting on: the microdeposits are on their way. No
// deposit details, so the route sends no "deposit is coming" email here
// (bankVerifyFirstNotice.test.ts covers that).
const waitingSi = (over: Record<string, any> = {}) => ({
  id: 'seti_x', status: 'requires_action', customer: 'cus_mock_tenant', payment_method: 'pm_x',
  next_action: { type: 'verify_with_microdeposits' }, ...over,
})

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
    // Read twice: by the route, then again under the tenant's bank lock.
    stripeMocks.setupIntentsRetrieve.mockResolvedValue(waitingSi() as any)
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
    // S655: the nudge selects by this, now that ach_verified no longer flips off.
    const { rows: [p] } = await db.query<any>(
      `SELECT bank_pending_since FROM tenants WHERE id=$1`, [tenantId])
    expect(p.bank_pending_since).not.toBeNull()
  })

  // S655 (Nic, item L): "adding never removes … old stays until the tenant
  // deletes it." These two replaced S654's "older bank detached" pair: the old
  // bank used to be detached the moment a new one was entered, and the tenant
  // had nothing chargeable for the 1–3 days the new one took to verify.
  //
  // S654 still holds for the default: Stripe refuses an unattached
  // microdeposit bank as the default, so it waits for verification.
  it('adding a bank keeps the old one: nothing is detached and the verified bank stays on file while the new one verifies', async () => {
    const { tenantId, userId } = await seedTenantWithStripe()
    await db.query(
      `UPDATE tenants SET ach_verified = TRUE, bank_last4 = '4321', bank_routing_last4 = '0000',
              bank_verify_nudge_count = 3 WHERE id = $1`, [tenantId])
    // Read twice: by the route, then again under the tenant's bank lock.
    stripeMocks.setupIntentsRetrieve.mockResolvedValue(waitingSi() as any)
    const token = sign({ userId, role: 'tenant', email: 't@t.dev', profileId: tenantId })
    const res = await request(buildApp()).post('/api/stripe/tenant/confirm-setup')
      .set('Authorization', `Bearer ${token}`)
      .send({ setupIntentId: 'seti_x', paymentMethodId: 'pm_x' })
    expect(res.status).toBe(200)
    expect(res.body.verified).toBe(false)
    expect(stripeMocks.paymentMethodsDetach).not.toHaveBeenCalled()
    expect(stripeMocks.customersUpdate).not.toHaveBeenCalled()
    const { rows: [t] } = await db.query<any>(
      `SELECT ach_verified, bank_last4, bank_pending_since, bank_verify_nudge_count FROM tenants WHERE id=$1`,
      [tenantId])
    expect(t.ach_verified).toBe(true)        // the old bank still pays
    expect(t.bank_last4).toBe('4321')        // and is still the one on file
    expect(t.bank_pending_since).not.toBeNull()
    expect(t.bank_verify_nudge_count).toBe(0) // a fresh attempt is chased afresh
  })

  it('a bank verified at once is added beside the old one and becomes the default', async () => {
    const { tenantId, userId } = await seedTenantWithStripe()
    await db.query(
      `UPDATE tenants SET ach_verified = TRUE, bank_last4 = '4321', bank_pending_since = NOW() WHERE id = $1`,
      [tenantId])
    const token = sign({ userId, role: 'tenant', email: 't@t.dev', profileId: tenantId })
    const res = await request(buildApp()).post('/api/stripe/tenant/confirm-setup')
      .set('Authorization', `Bearer ${token}`)
      .send({ setupIntentId: 'seti_x', paymentMethodId: 'pm_x' })
    expect(res.status).toBe(200)
    expect(res.body.verified).toBe(true)
    expect(stripeMocks.paymentMethodsDetach).not.toHaveBeenCalled()
    expect(stripeMocks.customersUpdate).toHaveBeenCalledTimes(1)
    expect(stripeMocks.customersUpdate).toHaveBeenCalledWith('cus_mock_tenant', {
      invoice_settings: { default_payment_method: 'pm_x' },
    })
    const { rows: [t] } = await db.query<any>(
      `SELECT ach_verified, bank_last4, bank_pending_since FROM tenants WHERE id=$1`, [tenantId])
    expect(t.ach_verified).toBe(true)
    expect(t.bank_last4).toBe('6789')        // the new default is the bank on file
    expect(t.bank_pending_since).toBeNull()  // nothing else is waiting at Stripe
  })

  it('the same bank recorded twice logs the NACHA first-time sender once', async () => {
    const { tenantId, userId } = await seedTenantWithStripe()
    const token = sign({ userId, role: 'tenant', email: 't@t.dev', profileId: tenantId })
    for (let i = 0; i < 2; i++) {
      const res = await request(buildApp()).post('/api/stripe/tenant/confirm-setup')
        .set('Authorization', `Bearer ${token}`)
        .send({ setupIntentId: 'seti_x', paymentMethodId: 'pm_x' })
      expect(res.status).toBe(200)
    }
    const { rows: log } = await db.query<any>(
      `SELECT bank_fingerprint FROM ach_monitoring_log WHERE tenant_id=$1 AND event_type='first_sender'`, [tenantId])
    expect(log).toEqual([{ bank_fingerprint: '110000000_6789' }])
  })

  it('a card sent to the bank step is refused and records nothing', async () => {
    const { tenantId, userId } = await seedTenantWithStripe()
    stripeMocks.paymentMethodsRetrieve.mockResolvedValueOnce(
      { id: 'pm_x', customer: 'cus_mock_tenant', type: 'card', card: { last4: '4242' } } as any)
    const token = sign({ userId, role: 'tenant', email: 't@t.dev', profileId: tenantId })
    const res = await request(buildApp()).post('/api/stripe/tenant/confirm-setup')
      .set('Authorization', `Bearer ${token}`)
      .send({ setupIntentId: 'seti_x', paymentMethodId: 'pm_x' })
    expect(res.status).toBe(400)
    const { rows: [t] } = await db.query<any>(`SELECT ach_verified, bank_last4 FROM tenants WHERE id=$1`, [tenantId])
    expect(t.ach_verified).toBe(false)
    expect(t.bank_last4).toBeNull()
  })

  it('a tenant with no payment setup started is told in plain words to start again', async () => {
    const c = await db.connect()
    let tenantId = '', userId = ''
    try {
      await c.query('BEGIN')
      tenantId = await seedTenant(c)
      ;({ rows: [{ user_id: userId }] } = await c.query<{ user_id: string }>(`SELECT user_id FROM tenants WHERE id=$1`, [tenantId]))
      await c.query('COMMIT')
    } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
    const token = sign({ userId, role: 'tenant', email: 't@t.dev', profileId: tenantId })
    const res = await request(buildApp()).post('/api/stripe/tenant/confirm-setup')
      .set('Authorization', `Bearer ${token}`)
      .send({ setupIntentId: 'seti_x', paymentMethodId: 'pm_x' })
    expect(res.status).toBe(409)
    expect(res.body.error).toBe('We could not find the account you were adding. Start again on the Payments page.')
    const card = await request(buildApp()).post('/api/stripe/tenant/confirm-card')
      .set('Authorization', `Bearer ${token}`).send({ paymentMethodId: 'pm_card_new' })
    expect(card.status).toBe(409)
    expect(card.body.error).toBe('We could not find the card you were adding. Add it again on the Payments page.')
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
    // Read twice: by the route, then again under the tenant's bank lock.
    stripeMocks.setupIntentsRetrieve.mockResolvedValue(waitingSi() as any)
    stripeMocks.paymentMethodsRetrieve.mockResolvedValueOnce({
      id: 'pm_x',
      type: 'us_bank_account',
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

  // S655 (review, PROBE C): DELETE cancels the setup of a bank still
  // verifying. Replaying that canceled setup used to answer "We sent a small
  // verification deposit…", restart the reminders and, with no verified bank,
  // put the removed bank's last 4 on file.
  it('a removed bank still verifying, replayed through confirm-setup, records nothing', async () => {
    const { tenantId, userId } = await seedTenantWithStripe()
    await db.query(`UPDATE tenants SET bank_verify_nudge_count = 2 WHERE id = $1`, [tenantId])
    stripeMocks.setupIntentsRetrieve.mockResolvedValue(waitingSi({ status: 'canceled', next_action: null }) as any)
    stripeMocks.paymentMethodsRetrieve.mockResolvedValue({
      id: 'pm_x', type: 'us_bank_account', customer: null,
      us_bank_account: { last4: '2222', routing_number: '221000000', bank_name: 'New Bank' },
    } as any)
    const token = sign({ userId, role: 'tenant', email: 't@t.dev', profileId: tenantId })
    const res = await request(buildApp()).post('/api/stripe/tenant/confirm-setup')
      .set('Authorization', `Bearer ${token}`)
      .send({ setupIntentId: 'seti_x', paymentMethodId: 'pm_x' })
    expect(res.status).toBe(409)
    expect(res.body.error).toMatch(/That bank was removed from your account/)
    expect(res.body.error).toMatch(/add it as a new bank on the Payments page/)
    const { rows: [t] } = await db.query<any>(
      `SELECT ach_verified, bank_last4, bank_routing_last4, bank_pending_since, bank_verify_nudge_count
         FROM tenants WHERE id=$1`, [tenantId])
    expect(t).toEqual({ ach_verified: false, bank_last4: null, bank_routing_last4: null,
                        bank_pending_since: null, bank_verify_nudge_count: 2 })
  })

  it('a bank whose setup failed is not recorded as waiting on deposits', async () => {
    const { tenantId, userId } = await seedTenantWithStripe()
    stripeMocks.setupIntentsRetrieve.mockResolvedValue(
      waitingSi({ status: 'requires_payment_method', next_action: null }) as any)
    const token = sign({ userId, role: 'tenant', email: 't@t.dev', profileId: tenantId })
    const res = await request(buildApp()).post('/api/stripe/tenant/confirm-setup')
      .set('Authorization', `Bearer ${token}`)
      .send({ setupIntentId: 'seti_x', paymentMethodId: 'pm_x' })
    expect(res.status).toBe(409)
    expect(res.body.error).toBe('That bank could not be set up. Add it again on the Payments page.')
    const { rows: [t] } = await db.query<any>(
      `SELECT bank_last4, bank_pending_since FROM tenants WHERE id=$1`, [tenantId])
    expect(t).toEqual({ bank_last4: null, bank_pending_since: null })
  })

  // The route reads the setup, then the service reads it again under the
  // tenant's bank lock — the lock a removal holds while it cancels the setup.
  it('a removal that lands between the first look and the write: the waiting bank is not recorded', async () => {
    const { tenantId, userId } = await seedTenantWithStripe()
    stripeMocks.setupIntentsRetrieve
      .mockResolvedValueOnce(waitingSi() as any)
      .mockResolvedValueOnce(waitingSi({ status: 'canceled', next_action: null }) as any)
    const token = sign({ userId, role: 'tenant', email: 't@t.dev', profileId: tenantId })
    const res = await request(buildApp()).post('/api/stripe/tenant/confirm-setup')
      .set('Authorization', `Bearer ${token}`)
      .send({ setupIntentId: 'seti_x', paymentMethodId: 'pm_x' })
    expect(res.status).toBe(409)
    expect(res.body.error).toMatch(/That bank was removed from your account/)
    expect(stripeMocks.setupIntentsRetrieve).toHaveBeenCalledTimes(2)
    const { rows: [t] } = await db.query<any>(
      `SELECT bank_last4, bank_pending_since FROM tenants WHERE id=$1`, [tenantId])
    expect(t).toEqual({ bank_last4: null, bank_pending_since: null })
  })

  it('a bank whose deposits were confirmed between the two looks is recorded as verified', async () => {
    const { tenantId, userId } = await seedTenantWithStripe()
    stripeMocks.setupIntentsRetrieve
      .mockResolvedValueOnce(waitingSi() as any)
      .mockResolvedValueOnce(waitingSi({ status: 'succeeded', next_action: null }) as any)
    // Read by the route while it was still unattached; attached by the time
    // the service checks it under the lock.
    stripeMocks.paymentMethodsRetrieve
      .mockResolvedValueOnce({ id: 'pm_x', type: 'us_bank_account', customer: null,
        us_bank_account: { last4: '6789', routing_number: '110000000', bank_name: 'Test Bank' } } as any)
      .mockResolvedValueOnce({ id: 'pm_x', type: 'us_bank_account', customer: 'cus_mock_tenant',
        us_bank_account: { last4: '6789', routing_number: '110000000', bank_name: 'Test Bank' } } as any)
    const token = sign({ userId, role: 'tenant', email: 't@t.dev', profileId: tenantId })
    const res = await request(buildApp()).post('/api/stripe/tenant/confirm-setup')
      .set('Authorization', `Bearer ${token}`)
      .send({ setupIntentId: 'seti_x', paymentMethodId: 'pm_x' })
    expect(res.status).toBe(200)
    expect(res.body.verified).toBe(true)
    const { rows: [t] } = await db.query<any>(
      `SELECT ach_verified, bank_last4, bank_pending_since FROM tenants WHERE id=$1`, [tenantId])
    expect(t).toEqual({ ach_verified: true, bank_last4: '6789', bank_pending_since: null })
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
      payment_method: { id: 'pm_pending', type: 'us_bank_account', us_bank_account: { last4: '1234' } },
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

    // Fix round 1: the form read the newest 10 setups on its own rule while the
    // saved-methods screen read 20. Both now read the same list.
    it('a bank waiting behind ten newer setups still gets its verify form', async () => {
      const { tenantId, userId } = await seedTenantWithStripe()
      const newer = Array.from({ length: 10 }, (_, i) => ({
        id: `seti_card_${i}`, status: 'succeeded', next_action: null,
        payment_method: { id: `pm_card_${i}`, type: 'card', card: { last4: '4242' } },
      }))
      stripeMocks.setupIntentsList.mockImplementationOnce(async (args: any) =>
        ({ data: [...newer, pendingSi('amounts')].slice(0, args.limit ?? 10) }) as any)
      const token = sign({ userId, role: 'tenant', email: 't@t.dev', profileId: tenantId })
      const res = await request(buildApp()).get('/api/stripe/tenant/microdeposits')
        .set('Authorization', `Bearer ${token}`)
      expect(res.body.data).toMatchObject({ pending: true, setupIntentId: 'seti_pending', microdepositType: 'amounts' })
    })

    it('a bank whose deposits Stripe is already checking does not ask for them again', async () => {
      const { tenantId, userId } = await seedTenantWithStripe()
      stripeMocks.setupIntentsList.mockResolvedValueOnce({ data: [{
        id: 'seti_checking', status: 'processing', next_action: null,
        payment_method: { id: 'pm_checking', type: 'us_bank_account', us_bank_account: { last4: '5555' } },
      }] } as any)
      const token = sign({ userId, role: 'tenant', email: 't@t.dev', profileId: tenantId })
      const res = await request(buildApp()).get('/api/stripe/tenant/microdeposits')
        .set('Authorization', `Bearer ${token}`)
      expect(res.body.data).toEqual({ pending: false })
    })
  })

  // Whatever the UI renders, the verify endpoint must accept BOTH shapes — that
  // is what makes the unknown-type screen (which offers both) usable.
  describe('POST /api/stripe/tenant/microdeposits/verify — both input shapes', () => {
    const pending = {
      id: 'seti_pending', status: 'requires_action',
      payment_method: { id: 'pm_pending', type: 'us_bank_account', us_bank_account: { last4: '1234' } },
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
    // normalized on the SERVER, covering every client rather than only the one
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

    // S655 fix round 2: the answer used to be verified: true whatever Stripe
    // said. Entries Stripe is still checking leave the bank unverified, with
    // nothing more for the tenant to do.
    it('entries Stripe is still checking are answered as being checked, not as verified', async () => {
      const { tenantId, userId } = await seedTenantWithStripe()
      stripeMocks.setupIntentsList.mockResolvedValueOnce({ data: [pending] } as any)
      stripeMocks.verifyMicrodeposits.mockResolvedValueOnce({ id: 'seti_pending', status: 'processing' } as any)
      const token = sign({ userId, role: 'tenant', email: 't@t.dev', profileId: tenantId })
      const res = await request(buildApp()).post('/api/stripe/tenant/microdeposits/verify')
        .set('Authorization', `Bearer ${token}`).send({ amounts: [32, 45] })
      expect(res.status).toBe(200)
      expect(res.body.data).toEqual({ verified: false, verificationStep: 'checking', message: BANK_CHECK_RECEIVED })
    })

    it('entries Stripe accepts outright are answered as verified', async () => {
      const { tenantId, userId } = await seedTenantWithStripe()
      stripeMocks.setupIntentsList.mockResolvedValueOnce({ data: [pending] } as any)
      stripeMocks.verifyMicrodeposits.mockResolvedValueOnce({ id: 'seti_pending', status: 'succeeded' } as any)
      const token = sign({ userId, role: 'tenant', email: 't@t.dev', profileId: tenantId })
      const res = await request(buildApp()).post('/api/stripe/tenant/microdeposits/verify')
        .set('Authorization', `Bearer ${token}`).send({ descriptorCode: 'SM1234' })
      expect(res.status).toBe(200)
      expect(res.body.data).toEqual({ verified: true, verificationStep: null, message: 'Bank account verified.' })
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
// ── S637: A BANK MID-VERIFICATION MUST STILL APPEAR ──────────────────
//
// Randall Cox set up ACH, believed he had paid, and his saved-methods list
// showed only a card — no sign the bank existed at all. paymentMethods.list
// returns ATTACHED methods, and in the descriptor-code microdeposit flow
// Stripe does not attach the bank until the code is confirmed. So the bank
// was invisible, `hasPendingBank` in the tenant portal was always false, and
// the "Your bank is still verifying" line — the one thing that tells a tenant
// they have NOT paid — could never fire on the commonest ACH path.
describe('S637 a pending microdeposit bank is listed', () => {
  async function tenantWithCustomer() {
    const c = await db.connect()
    try {
      await c.query('BEGIN')
      const tenantId = await seedTenant(c)
      const { rows: [{ user_id }] } = await c.query<{ user_id: string }>(
        `SELECT user_id FROM tenants WHERE id=$1`, [tenantId])
      await c.query(
        `UPDATE tenants SET stripe_customer_id='cus_mock_tenant', ach_verified=FALSE WHERE id=$1`,
        [tenantId])
      await c.query('COMMIT')
      return { tenantId, userId: user_id }
    } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
  }

  const pendingSetupIntent = {
    id: 'seti_pending_micro',
    status: 'requires_action',
    next_action: { type: 'verify_with_microdeposits' },
    payment_method: {
      id: 'pm_bank_unverified',
      type: 'us_bank_account',
      us_bank_account: { bank_name: 'Wells Fargo', last4: '9988' },
    },
  }

  it('lists it as an UNVERIFIED ach method, so the portal can say so', async () => {
    const { tenantId, userId } = await tenantWithCustomer()
    const m = (globalThis as any).__stripeMocks
    m.setupIntentsList.mockResolvedValueOnce({ data: [pendingSetupIntent] })
    m.paymentMethodsList.mockImplementation(async (args: any) =>
      args.type === 'us_bank_account'
        ? { data: [] }                       // Stripe has NOT attached it yet
        : { data: [{ id: 'pm_card_1', card: { brand: 'visa', last4: '1111', exp_month: 12, exp_year: 2030, country: 'US' } }] })

    const token = sign({ userId, role: 'tenant', email: 't@t.dev', profileId: tenantId, permissions: {} })
    const res = await request(buildApp()).get('/api/stripe/tenant/payment-methods')
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    const bank = res.body.data.find((x: any) => x.type === 'ach')
    expect(bank).toBeTruthy()
    expect(bank.verified).toBe(false)        // payShared refuses to charge this
    expect(bank.last4).toBe('9988')
    // And the card is still there — the tenant CAN pay today.
    expect(res.body.data.some((x: any) => x.type === 'card')).toBe(true)
  })

  it('does not duplicate a bank Stripe has since attached', async () => {
    const { tenantId, userId } = await tenantWithCustomer()
    const m = (globalThis as any).__stripeMocks
    m.setupIntentsList.mockResolvedValueOnce({ data: [pendingSetupIntent] })
    m.paymentMethodsList.mockImplementation(async (args: any) =>
      args.type === 'us_bank_account'
        ? { data: [{ id: 'pm_bank_unverified', us_bank_account: { bank_name: 'Wells Fargo', last4: '9988' } }] }
        : { data: [] })

    const token = sign({ userId, role: 'tenant', email: 't@t.dev', profileId: tenantId, permissions: {} })
    const res = await request(buildApp()).get('/api/stripe/tenant/payment-methods')
      .set('Authorization', `Bearer ${token}`)
    expect(res.body.data.filter((x: any) => x.type === 'ach')).toHaveLength(1)
  })

  it('ignores a setup intent that is not awaiting microdeposits', async () => {
    const { tenantId, userId } = await tenantWithCustomer()
    const m = (globalThis as any).__stripeMocks
    m.setupIntentsList.mockResolvedValueOnce({ data: [
      { ...pendingSetupIntent, status: 'succeeded', next_action: null },
    ] })
    m.paymentMethodsList.mockImplementation(async () => ({ data: [] }))

    const token = sign({ userId, role: 'tenant', email: 't@t.dev', profileId: tenantId, permissions: {} })
    const res = await request(buildApp()).get('/api/stripe/tenant/payment-methods')
      .set('Authorization', `Bearer ${token}`)
    expect(res.body.data.filter((x: any) => x.type === 'ach')).toHaveLength(0)
  })
})

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
    // pm_card_1 is the card the default Stripe mock lists on this customer.
    const token = sign({ userId, role: 'tenant', email: 't@t.dev', profileId: tenantId })
    const res = await request(buildApp()).patch('/api/stripe/tenant/default-payment-method')
      .set('Authorization', `Bearer ${token}`).send({ paymentMethodId: 'pm_card_1' })
    expect(res.status).toBe(200)
    expect(stripeMocks.customersUpdate).toHaveBeenCalledWith('cus_mock_tenant', { invoice_settings: { default_payment_method: 'pm_card_1' } })
  })

  it('PATCH rejects a payment method that is not the tenant\'s', async () => {
    const { tenantId, userId } = await seedStripeTenant()
    // pm_x is not on the tenant's own customer (the default mock lists pm_ach_1 and pm_card_1).
    const token = sign({ userId, role: 'tenant', email: 't@t.dev', profileId: tenantId })
    const res = await request(buildApp()).patch('/api/stripe/tenant/default-payment-method')
      .set('Authorization', `Bearer ${token}`).send({ paymentMethodId: 'pm_x' })
    expect(res.status).toBe(403)
    expect(stripeMocks.customersUpdate).not.toHaveBeenCalled()
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

// ═════════════════════════════════════════════════════════════════════════════
// S655 (money plan Step 5, item L) — KEEP THE OLD BANK
//
// Nic: "adding never removes; new verified bank becomes default; old stays until
// the tenant deletes it; delete blocked while it is their only verified bank,
// EXCEPT when nothing is owed and autopay is off (moved out); cards not
// affected."
// ═════════════════════════════════════════════════════════════════════════════

/**
 * A Stripe customer that remembers: detach takes a method off the lists,
 * cancel ends a waiting setup, and the default follows customers.update — so a
 * second request in the same test sees what the first one did.
 */
function stripeWorld(w: {
  banks?: { id: string; last4: string }[]
  cards?: { id: string; last4: string }[]
  waiting?: { siId: string; pmId: string; last4: string; attached?: boolean; createdS?: number }[]
  defaultId?: string | null
}) {
  const state = {
    attached: new Set<string>([
      ...(w.banks ?? []).map((b) => b.id),
      ...(w.cards ?? []).map((c) => c.id),
      ...(w.waiting ?? []).filter((x) => x.attached).map((x) => x.pmId),
    ]),
    canceled: new Set<string>(),
    defaultId: w.defaultId ?? null,
    /** Each PaymentMethod's metadata (paymentMethods.update merges into it). */
    metadata: new Map<string, Record<string, string>>(),
  }
  const bankRows = [
    ...(w.banks ?? []),
    ...(w.waiting ?? []).filter((x) => x.attached).map((x) => ({ id: x.pmId, last4: x.last4 })),
  ]
  stripeMocks.paymentMethodsList.mockImplementation(async (args: any) =>
    args.type === 'us_bank_account'
      ? { data: bankRows.filter((b) => state.attached.has(b.id)).map((b) => ({
          id: b.id, type: 'us_bank_account',
          us_bank_account: { bank_name: 'Test Bank', last4: b.last4, routing_number: '110000000' },
        })) }
      : { data: (w.cards ?? []).filter((c) => state.attached.has(c.id)).map((c) => ({
          id: c.id, type: 'card',
          card: { brand: 'visa', last4: c.last4, exp_month: 12, exp_year: 2030, country: 'US' },
        })) })
  stripeMocks.setupIntentsList.mockImplementation(async () => ({
    data: (w.waiting ?? []).filter((x) => !state.canceled.has(x.siId)).map((x) => ({
      id: x.siId, status: 'requires_action', created: x.createdS ?? 1759000000,
      next_action: { type: 'verify_with_microdeposits' },
      payment_method: { id: x.pmId, type: 'us_bank_account',
                        us_bank_account: { bank_name: 'New Bank', last4: x.last4, routing_number: '221000000' } },
    })),
  }))
  stripeMocks.customersRetrieve.mockImplementation(async (id: string) =>
    ({ id, invoice_settings: { default_payment_method: state.defaultId } }))
  stripeMocks.customersUpdate.mockImplementation(async (id: string, args: any) => {
    state.defaultId = args.invoice_settings.default_payment_method
    return { id }
  })
  stripeMocks.paymentMethodsDetach.mockImplementation(async (id: string) => {
    state.attached.delete(id)
    if (state.defaultId === id) state.defaultId = null
    return { id }
  })
  stripeMocks.setupIntentsCancel.mockImplementation(async (id: string) => {
    state.canceled.add(id)
    return { id, status: 'canceled' }
  })
  stripeMocks.paymentMethodsUpdate.mockImplementation(async (id: string, args: any) => {
    state.metadata.set(id, { ...(state.metadata.get(id) ?? {}), ...(args?.metadata ?? {}) })
    return { id, metadata: state.metadata.get(id) }
  })
  // A detached (or never attached) method still reads back, with no customer —
  // which is how the verify path tells a removed bank from one on file.
  stripeMocks.paymentMethodsRetrieve.mockImplementation(async (id: string) => {
    const card = (w.cards ?? []).find((c) => c.id === id)
    if (card) {
      return { id, type: 'card', customer: state.attached.has(id) ? 'cus_mock_tenant' : null,
               metadata: state.metadata.get(id) ?? {}, card: { brand: 'visa', last4: card.last4 } }
    }
    const bank = [...(w.banks ?? []), ...(w.waiting ?? []).map((x) => ({ id: x.pmId, last4: x.last4 }))]
      .find((b) => b.id === id)
    return { id, type: 'us_bank_account', customer: state.attached.has(id) ? 'cus_mock_tenant' : null,
             metadata: state.metadata.get(id) ?? {},
             us_bank_account: { bank_name: 'Test Bank', last4: bank?.last4 ?? '0000', routing_number: '110000000' } }
  })
  return state
}

/** A tenant on a lease with a Stripe customer, and whatever the account owes or has on. */
async function bankAccount(opts: {
  owes?: boolean
  clearing?: boolean
  autopay?: { enabled: boolean; pinned?: string | null }
  flexpay?: boolean
  suspended?: boolean
  bankLast4?: string | null
  /** The lease's status; 'terminated' = moved out. */
  leaseStatus?: 'active' | 'terminated' | 'expired'
  /**
   * Money GAM paid on the bill through FlexPay, by where its draw stands:
   *   fronted  paid, the draw from the tenant's bank not yet made
   *   retry    drawn, bounced, a retry scheduled
   *   written_off  every retry failed; the advance is written off
   */
  flexpayDraw?: 'fronted' | 'retry' | 'written_off'
} = {}) {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const ll = await seedLandlord(c)
    const propertyId = await seedProperty(c, { landlordId: ll.landlordId, ownerUserId: ll.userId, managedByUserId: ll.userId })
    const unitId = await seedUnit(c, { propertyId, landlordId: ll.landlordId })
    const leaseId = await seedLease(c, { unitId, landlordId: ll.landlordId })
    const tenantId = await seedTenant(c)
    await seedLeaseTenant(c, { leaseId, tenantId })
    const { rows: [{ user_id }] } = await c.query<{ user_id: string }>(`SELECT user_id FROM tenants WHERE id=$1`, [tenantId])
    await c.query(
      `UPDATE tenants SET stripe_customer_id = 'cus_mock_tenant', ach_verified = TRUE,
              bank_last4 = $2, flexpay_enrolled = $3,
              ach_suspended_at = CASE WHEN $4::boolean THEN NOW() ELSE NULL END
        WHERE id = $1`,
      [tenantId, opts.bankLast4 === undefined ? '1111' : opts.bankLast4, opts.flexpay === true, opts.suspended === true])
    if (opts.owes) {
      await c.query(
        `INSERT INTO payments (landlord_id, unit_id, lease_id, tenant_id, type, amount, status, entry_description, due_date)
         VALUES ($1,$2,$3,$4,'rent',460,'pending','RENT',CURRENT_DATE)`,
        [ll.landlordId, unitId, leaseId, tenantId])
    }
    if (opts.clearing) {
      await c.query(
        `INSERT INTO payments (landlord_id, unit_id, lease_id, tenant_id, type, amount, status, entry_description,
                               due_date, stripe_payment_intent_id)
         VALUES ($1,$2,$3,$4,'rent',460,'processing','RENT',CURRENT_DATE,'pi_clearing')`,
        [ll.landlordId, unitId, leaseId, tenantId])
    }
    if (opts.autopay) {
      await c.query(
        `INSERT INTO tenant_autopay (tenant_id, lease_id, enabled, payment_method_id) VALUES ($1,$2,$3,$4)`,
        [tenantId, leaseId, opts.autopay.enabled, opts.autopay.pinned ?? null])
    }
    if (opts.leaseStatus && opts.leaseStatus !== 'active') {
      await c.query(`UPDATE leases SET status = $2 WHERE id = $1`, [leaseId, opts.leaseStatus])
    }
    if (opts.flexpayDraw) {
      const status = opts.flexpayDraw === 'fronted' ? 'fronted'
        : opts.flexpayDraw === 'retry' ? 'pulled' : 'defaulted'
      const { rows: [adv] } = await c.query<{ id: string }>(
        `INSERT INTO flexpay_advances (cycle_month, tenant_id, landlord_id, unit_id, lease_id, rent_amount,
                                       tenant_fee_amount, pull_day, status, fronted_at, pull_date,
                                       pulled_at, defaulted_at)
         VALUES (date_trunc('month', CURRENT_DATE)::date, $1, $2, $3, $4, 460, 25, 20, $5, NOW(),
                 CURRENT_DATE + 10,
                 CASE WHEN $5 <> 'fronted' THEN NOW() END, CASE WHEN $5 = 'defaulted' THEN NOW() END)
         RETURNING id`,
        [tenantId, ll.landlordId, unitId, leaseId, status])
      if (opts.flexpayDraw !== 'fronted') {
        // The draw row: a bounce with a retry scheduled, or failed for good
        // (next_retry_at cleared) once the advance was written off.
        await c.query(
          `INSERT INTO payments (landlord_id, unit_id, lease_id, tenant_id, type, amount, status, entry_description,
                                 revenue_owner, due_date, stripe_payment_intent_id, flexpay_advance_id, next_retry_at,
                                 retry_count)
           VALUES ($1,$2,$3,$4,'fee',485,'failed','FLEXPAY','gam',CURRENT_DATE,'pi_flex',$5,
                   CASE WHEN $6::boolean THEN NOW() + interval '2 days' END, 1)`,
          [ll.landlordId, unitId, leaseId, tenantId, adv.id, opts.flexpayDraw === 'retry'])
      }
    }
    await c.query('COMMIT')
    const token = sign({ userId: user_id, role: 'tenant', email: 't@t.dev', profileId: tenantId })
    return { tenantId, leaseId, token, landlordId: ll.landlordId, unitId }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

const getMethods = (token: string) =>
  request(buildApp()).get('/api/stripe/tenant/payment-methods').set('Authorization', `Bearer ${token}`)
const removeMethod = (token: string, id: string) =>
  request(buildApp()).delete(`/api/stripe/tenant/payment-methods/${id}`).set('Authorization', `Bearer ${token}`)

describe('S655 GET /tenant/payment-methods reports each bank on its own', () => {
  it('a verified bank stays chargeable while a new one verifies', async () => {
    const { token } = await bankAccount()
    stripeWorld({
      banks: [{ id: 'pm_old', last4: '1111' }],
      waiting: [{ siId: 'seti_new', pmId: 'pm_new', last4: '2222' }],   // not attached yet (S637)
      defaultId: 'pm_old',
    })
    const res = await getMethods(token)
    expect(res.status).toBe(200)
    const old = res.body.data.find((m: any) => m.id === 'pm_old')
    const neu = res.body.data.find((m: any) => m.id === 'pm_new')
    expect(old).toMatchObject({ type: 'ach', verified: true, verifying: false, chargeable: true, isDefault: true })
    expect(neu).toMatchObject({ type: 'ach', last4: '2222', verified: false, verifying: true, chargeable: false, isDefault: false })
  })

  it('an attached bank still named by a waiting setup counts as verifying, not verified', async () => {
    const { token } = await bankAccount()
    stripeWorld({ waiting: [{ siId: 'seti_a', pmId: 'pm_a', last4: '3333', attached: true }] })
    const res = await getMethods(token)
    const banks = res.body.data.filter((m: any) => m.type === 'ach')
    expect(banks).toHaveLength(1)                 // listed once
    expect(banks[0]).toMatchObject({ verified: false, verifying: true, chargeable: false })
  })

  it('with bank payments suspended a verified bank is not chargeable; a card still is', async () => {
    const { token } = await bankAccount({ suspended: true })
    stripeWorld({ banks: [{ id: 'pm_old', last4: '1111' }], cards: [{ id: 'pm_card', last4: '4242' }] })
    const res = await getMethods(token)
    expect(res.body.data.find((m: any) => m.id === 'pm_old')).toMatchObject({ verified: true, chargeable: false })
    expect(res.body.data.find((m: any) => m.id === 'pm_card')).toMatchObject({ chargeable: true })
  })

  it('says, before the tap, which method can be removed and why not', async () => {
    const { token } = await bankAccount({ owes: true })
    stripeWorld({
      banks: [{ id: 'pm_old', last4: '1111' }],
      waiting: [{ siId: 'seti_new', pmId: 'pm_new', last4: '2222' }],
      cards: [{ id: 'pm_card', last4: '4242' }],
    })
    const res = await getMethods(token)
    const by = (id: string) => res.body.data.find((m: any) => m.id === id)
    expect(by('pm_old').canRemove).toBe(false)
    expect(by('pm_old').removeBlockedReason).toMatch(/only verified bank/)
    expect(by('pm_old').removeBlockedReason).toMatch(/owe a balance/)
    expect(by('pm_new')).toMatchObject({ canRemove: true, removeBlockedReason: null })
    expect(by('pm_card')).toMatchObject({ canRemove: true, removeBlockedReason: null })
  })

  it('when Stripe cannot list the waiting setups, the attached banks are still listed', async () => {
    const { token } = await bankAccount()
    stripeWorld({ banks: [{ id: 'pm_old', last4: '1111' }] })
    stripeMocks.setupIntentsList.mockRejectedValueOnce(new Error('stripe down'))
    const res = await getMethods(token)
    expect(res.status).toBe(200)
    expect(res.body.data).toEqual([expect.objectContaining({ id: 'pm_old', verified: true, chargeable: true })])
  })

  it('marks the method an autopay schedule names', async () => {
    const { token } = await bankAccount({ autopay: { enabled: true, pinned: 'pm_b' } })
    stripeWorld({ banks: [{ id: 'pm_a', last4: '1111' }, { id: 'pm_b', last4: '2222' }] })
    const res = await getMethods(token)
    expect(res.body.data.find((m: any) => m.id === 'pm_b').autopayPinned).toBe(true)
    expect(res.body.data.find((m: any) => m.id === 'pm_a').autopayPinned).toBe(false)
  })
})

describe('S655 DELETE /tenant/payment-methods/:id', () => {
  it('the only verified bank cannot be removed while a balance is owed', async () => {
    const { tenantId, token } = await bankAccount({ owes: true })
    stripeWorld({ banks: [{ id: 'pm_old', last4: '1111' }], defaultId: 'pm_old' })
    const res = await removeMethod(token, 'pm_old')
    expect(res.status).toBe(409)
    expect(res.body.error).toMatch(/only verified bank/)
    expect(res.body.error).toMatch(/Add and verify another bank first, or pay what you owe/)
    expect(stripeMocks.paymentMethodsDetach).not.toHaveBeenCalled()
    const { rows: [t] } = await db.query<any>(`SELECT ach_verified, bank_last4 FROM tenants WHERE id=$1`, [tenantId])
    expect(t).toEqual({ ach_verified: true, bank_last4: '1111' })
  })

  it('the only verified bank cannot be removed while autopay is on', async () => {
    const { token } = await bankAccount({ autopay: { enabled: true } })
    stripeWorld({ banks: [{ id: 'pm_old', last4: '1111' }] })
    const res = await removeMethod(token, 'pm_old')
    expect(res.status).toBe(409)
    expect(res.body.error).toMatch(/only verified bank, and autopay is on\./)
    expect(res.body.error).toMatch(/turn off autopay/)
    expect(stripeMocks.paymentMethodsDetach).not.toHaveBeenCalled()
  })

  it('it can be removed when nothing is owed and autopay is off (moved out)', async () => {
    const { tenantId, token } = await bankAccount({ autopay: { enabled: false, pinned: 'pm_old' } })
    stripeWorld({ banks: [{ id: 'pm_old', last4: '1111' }], defaultId: 'pm_old' })
    const res = await removeMethod(token, 'pm_old')
    expect(res.status).toBe(200)
    expect(res.body.data.removedId).toBe('pm_old')
    expect(res.body.data.methods).toEqual([])
    expect(stripeMocks.paymentMethodsDetach).toHaveBeenCalledWith('pm_old')
    const { rows: [t] } = await db.query<any>(
      `SELECT ach_verified, bank_last4, bank_routing_last4, bank_pending_since FROM tenants WHERE id=$1`, [tenantId])
    expect(t).toEqual({ ach_verified: false, bank_last4: null, bank_routing_last4: null, bank_pending_since: null })
  })

  // Nothing turns autopay off at move-out, and the tenant cannot see a schedule
  // on an ended lease to turn it off themselves (GET /api/autopay lists active
  // leases only). The runner never charges it again, so it must not block.
  it('a moved-out tenant whose autopay was left on can remove their only bank (the lease ended, nothing owed)', async () => {
    const { tenantId, token } = await bankAccount({ autopay: { enabled: true }, leaseStatus: 'terminated' })
    stripeWorld({ banks: [{ id: 'pm_old', last4: '1111' }], defaultId: 'pm_old' })
    const before = await getMethods(token)
    expect(before.status).toBe(200)
    expect(before.body.data.find((m: any) => m.id === 'pm_old'))
      .toMatchObject({ canRemove: true, removeBlockedReason: null })
    const res = await removeMethod(token, 'pm_old')
    expect(res.status).toBe(200)
    expect(stripeMocks.paymentMethodsDetach).toHaveBeenCalledWith('pm_old')
    const { rows: [t] } = await db.query<any>(`SELECT ach_verified, bank_last4 FROM tenants WHERE id=$1`, [tenantId])
    expect(t).toEqual({ ach_verified: false, bank_last4: null })
  })

  it('autopay on the lease they still live on keeps blocking, even beside an ended lease', async () => {
    const { tenantId, token } = await bankAccount({ autopay: { enabled: false }, leaseStatus: 'terminated' })
    // A second, active lease for the same tenant with autopay on.
    const c = await db.connect()
    try {
      await c.query('BEGIN')
      const ll = await seedLandlord(c)
      const propertyId = await seedProperty(c, { landlordId: ll.landlordId, ownerUserId: ll.userId, managedByUserId: ll.userId })
      const unitId = await seedUnit(c, { propertyId, landlordId: ll.landlordId })
      const leaseId = await seedLease(c, { unitId, landlordId: ll.landlordId })
      await seedLeaseTenant(c, { leaseId, tenantId })
      await c.query(`INSERT INTO tenant_autopay (tenant_id, lease_id, enabled) VALUES ($1,$2,TRUE)`, [tenantId, leaseId])
      await c.query('COMMIT')
    } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
    stripeWorld({ banks: [{ id: 'pm_old', last4: '1111' }] })
    const res = await removeMethod(token, 'pm_old')
    expect(res.status).toBe(409)
    expect(res.body.error).toMatch(/autopay is on/)
    expect(stripeMocks.paymentMethodsDetach).not.toHaveBeenCalled()
  })

  // Fix round 1: the only verified bank used to be held while ANY payment on
  // the household was clearing — a card payment, or a co-tenant's from their
  // own bank — which went past Nic's rule (nothing owed, autopay off). The
  // bank a payment was made from is still kept (pullBlockFor); nothing else is.
  it('a payment still clearing from the only verified bank keeps it', async () => {
    const { token } = await bankAccount({ clearing: true })
    stripeWorld({ banks: [{ id: 'pm_old', last4: '1111' }] })
    stripeMocks.paymentIntentsRetrieve.mockImplementation(async (id: string) =>
      ({ id, status: 'processing', payment_method: 'pm_old', last_payment_error: null }))
    const res = await removeMethod(token, 'pm_old')
    expect(res.status).toBe(409)
    expect(res.body.error).toMatch(/A payment from this bank is still clearing/)
    expect(stripeMocks.paymentMethodsDetach).not.toHaveBeenCalled()
  })

  it('a card payment still clearing does not keep the only verified bank when nothing is owed and autopay is off', async () => {
    const { tenantId, token } = await bankAccount({ clearing: true })
    const world = stripeWorld({ banks: [{ id: 'pm_old', last4: '1111' }], cards: [{ id: 'pm_card', last4: '4242' }],
                                defaultId: 'pm_old' })
    stripeMocks.paymentIntentsRetrieve.mockImplementation(async (id: string) =>
      ({ id, status: 'processing', payment_method: 'pm_card', last_payment_error: null }))
    const res = await removeMethod(token, 'pm_old')
    expect(res.status).toBe(200)
    expect(world.attached.has('pm_old')).toBe(false)
    const { rows: [t] } = await db.query<any>(`SELECT ach_verified FROM tenants WHERE id=$1`, [tenantId])
    expect(t.ach_verified).toBe(false)
  })

  it('FlexPay enrollment blocks removing the only verified bank', async () => {
    const { token } = await bankAccount({ flexpay: true })
    stripeWorld({ banks: [{ id: 'pm_old', last4: '1111' }] })
    const res = await removeMethod(token, 'pm_old')
    expect(res.status).toBe(409)
    expect(res.body.error).toMatch(/FlexPay draws from it/)
  })

  // S655 review (PROBE A/B): cancelling FlexPay turns enrollment off, but the
  // draw for rent GAM already fronted still runs on its date. With no bank on
  // file it is refused, and after three tries the advance is written off — GAM
  // absorbs the rent. Fronted rent is owed until that draw clears.
  it('a FlexPay draw still owed blocks removing the only verified bank even after FlexPay is cancelled', async () => {
    const { tenantId, token } = await bankAccount({ flexpay: false, flexpayDraw: 'fronted' })
    stripeWorld({ banks: [{ id: 'pm_old', last4: '1111' }], defaultId: 'pm_old' })
    const before = await getMethods(token)
    expect(before.body.data.find((m: any) => m.id === 'pm_old')).toMatchObject({ canRemove: false })
    expect(before.body.data.find((m: any) => m.id === 'pm_old').removeBlockedReason)
      .toMatch(/FlexPay still has to draw what it paid on your bill from it/)
    const res = await removeMethod(token, 'pm_old')
    expect(res.status).toBe(409)
    expect(res.body.error).toBe(
      'This is your only verified bank, and FlexPay still has to draw what it paid on your bill from it. ' +
      'Add and verify another bank first, or wait until that draw has cleared, then you can remove this one.')
    expect(stripeMocks.paymentMethodsDetach).not.toHaveBeenCalled()
    const { rows: [t] } = await db.query<any>(`SELECT ach_verified, bank_last4 FROM tenants WHERE id=$1`, [tenantId])
    expect(t).toEqual({ ach_verified: true, bank_last4: '1111' })
  })

  it('a bounced FlexPay draw waiting to retry blocks it too', async () => {
    const { token } = await bankAccount({ flexpay: false, flexpayDraw: 'retry' })
    stripeWorld({ banks: [{ id: 'pm_old', last4: '1111' }], defaultId: 'pm_old' })
    const res = await removeMethod(token, 'pm_old')
    expect(res.status).toBe(409)
    expect(res.body.error).toMatch(/FlexPay still has to draw/)
    expect(stripeMocks.paymentMethodsDetach).not.toHaveBeenCalled()
  })

  it('a FlexPay draw still owed does not stop removing a bank beside another verified bank', async () => {
    const { token } = await bankAccount({ flexpayDraw: 'fronted' })
    const world = stripeWorld({
      banks: [{ id: 'pm_old', last4: '1111' }, { id: 'pm_new', last4: '2222' }], defaultId: 'pm_old',
    })
    const res = await removeMethod(token, 'pm_old')
    expect(res.status).toBe(200)
    expect(world.defaultId).toBe('pm_new')        // the draw takes the default
  })

  // A written-off advance is recovered from the tenant's next payment to the
  // landlord (supersedence.ts), never drawn from the bank, so it does not keep
  // a moved-out tenant's bank on file. Its draw row stays 'failed' for good.
  it('a FlexPay draw written off after its last retry no longer keeps the bank', async () => {
    const { tenantId, token } = await bankAccount({ flexpayDraw: 'written_off' })
    stripeWorld({ banks: [{ id: 'pm_old', last4: '1111' }], defaultId: 'pm_old' })
    const res = await removeMethod(token, 'pm_old')
    expect(res.status).toBe(200)
    const { rows: [t] } = await db.query<any>(`SELECT ach_verified FROM tenants WHERE id=$1`, [tenantId])
    expect(t.ach_verified).toBe(false)
  })

  // A co-tenant's payment from their own bank never needs this tenant's bank:
  // if it comes back, it is retried on the co-tenant's bank, and what is then
  // owed blocks the removal like any balance.
  it("a co-tenant's payment clearing from their own bank does not keep this tenant's only bank", async () => {
    const { leaseId, landlordId, unitId, token } = await bankAccount()
    const c = await db.connect()
    try {
      await c.query('BEGIN')
      const coTenantId = await seedTenant(c)
      await seedLeaseTenant(c, { leaseId, tenantId: coTenantId })
      await c.query(
        `INSERT INTO payments (landlord_id, unit_id, lease_id, tenant_id, type, amount, status, entry_description,
                               due_date, stripe_payment_intent_id)
         VALUES ($1,$2,$3,$4,'rent',460,'processing','RENT',CURRENT_DATE,'pi_cotenant')`,
        [landlordId, unitId, leaseId, coTenantId])
      await c.query('COMMIT')
    } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
    const world = stripeWorld({ banks: [{ id: 'pm_old', last4: '1111' }] })
    // Stripe says the co-tenant's payment came from a bank that is not this one.
    stripeMocks.paymentIntentsRetrieve.mockImplementation(async (id: string) =>
      ({ id, status: 'processing', payment_method: 'pm_cotenant_bank', last_payment_error: null }))
    const res = await removeMethod(token, 'pm_old')
    expect(res.status).toBe(200)
    expect(world.attached.has('pm_old')).toBe(false)
  })

  // Nic's rule is "autopay is off", whatever method the schedule names. The
  // reason must not say autopay uses this bank when it is pinned to a card.
  it('autopay pinned to a card still blocks, and the reason says autopay is on rather than that it uses the bank', async () => {
    const { token } = await bankAccount({ autopay: { enabled: true, pinned: 'pm_card' } })
    stripeWorld({ banks: [{ id: 'pm_old', last4: '1111' }], cards: [{ id: 'pm_card', last4: '4242' }] })
    const res = await removeMethod(token, 'pm_old')
    expect(res.status).toBe(409)
    expect(res.body.error).toMatch(/only verified bank, and autopay is on\./)
    expect(res.body.error).not.toMatch(/uses it/)
  })

  // ── A removal whose database write fails after Stripe removed it ──────────
  //
  // Stripe is changed before the write commits. A failure there used to return
  // 500 with ach_verified (the FlexPay / FlexDeposit gate) still on and
  // bank_last4 naming a bank that was gone; a retry only found "not saved on
  // your account". The failure is injected with a trigger that refuses the
  // first N updates of this tenant's row (a sequence, so a rollback does not
  // undo the count).
  async function failTenantUpdates(tenantId: string, times: number): Promise<() => Promise<void>> {
    await db.query(`CREATE SEQUENCE IF NOT EXISTS m5_fail_tenant_update_seq`)
    await db.query(`SELECT setval('m5_fail_tenant_update_seq', 1, false)`)
    await db.query(`
      CREATE OR REPLACE FUNCTION m5_fail_tenant_update() RETURNS trigger AS $$
      BEGIN
        IF NEW.id = '${tenantId}'::uuid AND nextval('m5_fail_tenant_update_seq') <= ${times} THEN
          RAISE EXCEPTION 'injected tenants write failure';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql`)
    await db.query(`DROP TRIGGER IF EXISTS m5_fail_tenant_update ON tenants`)
    await db.query(`CREATE TRIGGER m5_fail_tenant_update BEFORE UPDATE ON tenants
                      FOR EACH ROW EXECUTE FUNCTION m5_fail_tenant_update()`)
    return async () => {
      await db.query(`DROP TRIGGER IF EXISTS m5_fail_tenant_update ON tenants`)
      await db.query(`DROP FUNCTION IF EXISTS m5_fail_tenant_update()`)
      await db.query(`DROP SEQUENCE IF EXISTS m5_fail_tenant_update_seq`)
    }
  }

  it('a removal whose database write fails after Stripe removed the bank brings the row back in line with Stripe', async () => {
    const { tenantId, token } = await bankAccount({ autopay: { enabled: false, pinned: 'pm_old' } })
    const world = stripeWorld({ banks: [{ id: 'pm_old', last4: '1111' }], defaultId: 'pm_old' })
    const restore = await failTenantUpdates(tenantId, 1)
    let res: any
    try {
      res = await removeMethod(token, 'pm_old')
    } finally { await restore() }
    expect(stripeMocks.paymentMethodsDetach).toHaveBeenCalledWith('pm_old')
    expect(world.attached.has('pm_old')).toBe(false)
    expect(res.status).toBe(200)
    expect(res.body.data).toEqual({ removedId: 'pm_old', methods: [] })
    const { rows: [t] } = await db.query<any>(
      `SELECT ach_verified, bank_last4, bank_routing_last4 FROM tenants WHERE id=$1`, [tenantId])
    expect(t).toEqual({ ach_verified: false, bank_last4: null, bank_routing_last4: null })
    const { rows: [a] } = await db.query<any>(`SELECT payment_method_id FROM tenant_autopay WHERE tenant_id=$1`, [tenantId])
    expect(a.payment_method_id).toBeNull()
  })

  it('when that fix-up fails too, the tenant is told it was removed, and the next removal corrects the row', async () => {
    const { tenantId, token } = await bankAccount({ autopay: { enabled: false, pinned: 'pm_old' } })
    stripeWorld({ banks: [{ id: 'pm_old', last4: '1111' }], defaultId: 'pm_old' })
    const restore = await failTenantUpdates(tenantId, 2)
    let first: any
    let again: any
    try {
      first = await removeMethod(token, 'pm_old')
      again = await removeMethod(token, 'pm_old')
    } finally { await restore() }
    expect(first.status).toBe(500)
    expect(first.body.error).toMatch(/^That account was removed/)
    expect(again.status).toBe(404)
    expect(again.body.error).toMatch(/not saved on your account/)
    const { rows: [t] } = await db.query<any>(`SELECT ach_verified, bank_last4 FROM tenants WHERE id=$1`, [tenantId])
    expect(t).toEqual({ ach_verified: false, bank_last4: null })
    const { rows: [a] } = await db.query<any>(`SELECT payment_method_id FROM tenant_autopay WHERE tenant_id=$1`, [tenantId])
    expect(a.payment_method_id).toBeNull()
  })

  it('a removal that finds the bank already gone corrects a row still naming it', async () => {
    const { tenantId, token } = await bankAccount({ autopay: { enabled: false, pinned: 'pm_old' } })
    stripeWorld({})                                   // Stripe holds nothing for this tenant
    const res = await removeMethod(token, 'pm_old')
    expect(res.status).toBe(404)
    expect(stripeMocks.paymentMethodsDetach).not.toHaveBeenCalled()
    const { rows: [t] } = await db.query<any>(`SELECT ach_verified, bank_last4 FROM tenants WHERE id=$1`, [tenantId])
    expect(t).toEqual({ ach_verified: false, bank_last4: null })
    const { rows: [a] } = await db.query<any>(`SELECT payment_method_id FROM tenant_autopay WHERE tenant_id=$1`, [tenantId])
    expect(a.payment_method_id).toBeNull()
  })

  it('a bank beside another verified bank can be removed with a balance owed, and the other becomes the default', async () => {
    const { tenantId, token } = await bankAccount({ owes: true, bankLast4: '1111' })
    const world = stripeWorld({
      banks: [{ id: 'pm_old', last4: '1111' }, { id: 'pm_new', last4: '2222' }],
      defaultId: 'pm_old',
    })
    const res = await removeMethod(token, 'pm_old')
    expect(res.status).toBe(200)
    expect(stripeMocks.paymentMethodsDetach).toHaveBeenCalledWith('pm_old')
    expect(stripeMocks.customersUpdate).toHaveBeenCalledWith('cus_mock_tenant',
      { invoice_settings: { default_payment_method: 'pm_new' } })
    expect(world.defaultId).toBe('pm_new')
    expect(res.body.data.methods).toEqual([
      expect.objectContaining({ id: 'pm_new', isDefault: true, canRemove: false }),   // now the only one, and owed
    ])
    const { rows: [t] } = await db.query<any>(`SELECT ach_verified, bank_last4 FROM tenants WHERE id=$1`, [tenantId])
    expect(t).toEqual({ ach_verified: true, bank_last4: '2222' })
  })

  it('removing a pinned bank clears the pin and leaves autopay on', async () => {
    const { leaseId, token } = await bankAccount({ autopay: { enabled: true, pinned: 'pm_old' } })
    stripeWorld({ banks: [{ id: 'pm_old', last4: '1111' }, { id: 'pm_new', last4: '2222' }], defaultId: 'pm_new' })
    const res = await removeMethod(token, 'pm_old')
    expect(res.status).toBe(200)
    const { rows: [a] } = await db.query<any>(
      `SELECT enabled, payment_method_id FROM tenant_autopay WHERE lease_id=$1`, [leaseId])
    expect(a).toEqual({ enabled: true, payment_method_id: null })   // follows the default from now on
    expect(stripeMocks.customersUpdate).not.toHaveBeenCalled()        // the default was not the one removed
  })

  it('a bank still verifying can always be removed: its setup is canceled, nothing detached', async () => {
    const { tenantId, token } = await bankAccount({ owes: true, bankLast4: null })
    await db.query(`UPDATE tenants SET ach_verified = FALSE, bank_pending_since = NOW() WHERE id=$1`, [tenantId])
    stripeWorld({ waiting: [{ siId: 'seti_new', pmId: 'pm_new', last4: '2222' }] })
    const res = await removeMethod(token, 'pm_new')
    expect(res.status).toBe(200)
    expect(stripeMocks.setupIntentsCancel).toHaveBeenCalledWith('seti_new')
    expect(stripeMocks.paymentMethodsDetach).not.toHaveBeenCalled()   // it was never attached
    const { rows: [t] } = await db.query<any>(`SELECT bank_pending_since, ach_verified FROM tenants WHERE id=$1`, [tenantId])
    expect(t.bank_pending_since).toBeNull()
    expect(t.ach_verified).toBe(false)
  })

  it('removing one waiting bank keeps the flag while another still waits', async () => {
    const { tenantId, token } = await bankAccount()
    await db.query(`UPDATE tenants SET bank_pending_since = NOW() - interval '2 days' WHERE id=$1`, [tenantId])
    stripeWorld({
      banks: [{ id: 'pm_old', last4: '1111' }],
      waiting: [{ siId: 'seti_a', pmId: 'pm_a', last4: '2222' }, { siId: 'seti_b', pmId: 'pm_b', last4: '3333' }],
    })
    const res = await removeMethod(token, 'pm_a')
    expect(res.status).toBe(200)
    const { rows: [t] } = await db.query<any>(
      `SELECT bank_pending_since < NOW() - interval '1 day' AS kept, bank_last4 FROM tenants WHERE id=$1`, [tenantId])
    expect(t).toEqual({ kept: true, bank_last4: '1111' })
  })

  it('an attached bank still verifying is detached first, then its setup is canceled', async () => {
    const { token } = await bankAccount({ owes: true })
    stripeWorld({
      banks: [{ id: 'pm_old', last4: '1111' }],
      waiting: [{ siId: 'seti_a', pmId: 'pm_a', last4: '2222', attached: true }],
    })
    const res = await removeMethod(token, 'pm_a')
    expect(res.status).toBe(200)
    expect(stripeMocks.paymentMethodsDetach).toHaveBeenCalledWith('pm_a')
    expect(stripeMocks.setupIntentsCancel).toHaveBeenCalledWith('seti_a')
    expect(stripeMocks.paymentMethodsDetach.mock.invocationCallOrder[0])
      .toBeLessThan(stripeMocks.setupIntentsCancel.mock.invocationCallOrder[0])
  })

  it('a card can be removed while a balance is owed — cards are not affected', async () => {
    const { tenantId, token } = await bankAccount({ owes: true })
    stripeWorld({ banks: [{ id: 'pm_old', last4: '1111' }], cards: [{ id: 'pm_card', last4: '4242' }], defaultId: 'pm_old' })
    const res = await removeMethod(token, 'pm_card')
    expect(res.status).toBe(200)
    expect(stripeMocks.paymentMethodsDetach).toHaveBeenCalledWith('pm_card')
    const { rows: [t] } = await db.query<any>(`SELECT ach_verified, bank_last4 FROM tenants WHERE id=$1`, [tenantId])
    expect(t).toEqual({ ach_verified: true, bank_last4: '1111' })      // the bank on file is untouched
  })

  it('removing a default card with no verified bank leaves no default rather than guessing', async () => {
    const { token } = await bankAccount()
    const world = stripeWorld({ cards: [{ id: 'pm_card', last4: '4242' }], defaultId: 'pm_card' })
    const res = await removeMethod(token, 'pm_card')
    expect(res.status).toBe(200)
    expect(world.defaultId).toBeNull()
    expect(stripeMocks.customersUpdate).not.toHaveBeenCalled()
  })

  it('a payment method not on the account is refused and never sent to Stripe', async () => {
    const { tenantId, token } = await bankAccount()
    stripeWorld({ banks: [{ id: 'pm_old', last4: '1111' }] })
    const res = await removeMethod(token, 'pm_someone_elses')
    expect(res.status).toBe(404)
    expect(stripeMocks.paymentMethodsDetach).not.toHaveBeenCalled()
    expect(stripeMocks.setupIntentsCancel).not.toHaveBeenCalled()
    const { rows: [t] } = await db.query<any>(`SELECT ach_verified, bank_last4 FROM tenants WHERE id=$1`, [tenantId])
    expect(t).toEqual({ ach_verified: true, bank_last4: '1111' })   // a row in line is left alone
  })

  it('non-tenant → 403', async () => {
    const c = await db.connect()
    try {
      const { userId, landlordId } = await seedLandlord(c)
      const token = sign({ userId, role: 'landlord', email: 'll@t.dev', profileId: landlordId, permissions: {} })
      const res = await removeMethod(token, 'pm_old')
      expect(res.status).toBe(403)
    } finally { c.release() }
  })

  it('a Stripe failure removes nothing and says to try again', async () => {
    const { tenantId, token } = await bankAccount({ autopay: { enabled: false, pinned: 'pm_old' } })
    stripeWorld({ banks: [{ id: 'pm_old', last4: '1111' }] })
    stripeMocks.paymentMethodsDetach.mockRejectedValueOnce(new Error('stripe down'))
    const res = await removeMethod(token, 'pm_old')
    expect(res.status).toBe(502)
    expect(res.body.error).toMatch(/Nothing changed/)
    const { rows: [t] } = await db.query<any>(`SELECT ach_verified FROM tenants WHERE id=$1`, [tenantId])
    expect(t.ach_verified).toBe(true)
    const { rows: [a] } = await db.query<any>(`SELECT payment_method_id FROM tenant_autopay WHERE tenant_id=$1`, [tenantId])
    expect(a.payment_method_id).toBe('pm_old')
  })

  it('when Stripe cannot say which banks are verifying, a bank is not removed', async () => {
    const { token } = await bankAccount()
    stripeWorld({ banks: [{ id: 'pm_old', last4: '1111' }, { id: 'pm_new', last4: '2222' }] })
    stripeMocks.setupIntentsList.mockRejectedValueOnce(new Error('stripe down'))
    const res = await removeMethod(token, 'pm_old')
    expect(res.status).toBe(503)
    expect(stripeMocks.paymentMethodsDetach).not.toHaveBeenCalled()
  })

  it('two removals at once cannot take away both verified banks while a balance is owed', async () => {
    const { token } = await bankAccount({ owes: true })
    const world = stripeWorld({ banks: [{ id: 'pm_a', last4: '1111' }, { id: 'pm_b', last4: '2222' }] })
    const [ra, rb] = await Promise.all([removeMethod(token, 'pm_a'), removeMethod(token, 'pm_b')])
    expect([ra.status, rb.status].sort()).toEqual([200, 409])
    expect(stripeMocks.paymentMethodsDetach).toHaveBeenCalledTimes(1)
    expect(world.attached.size).toBe(1)
  })

  // ── A pull made from this very bank keeps it (wave A review, PROBE E/F) ────
  //
  // A retry confirms the same payment on the same bank (achRetry
  // retryConfirmParams). Removing that bank beside another verified one used
  // to pass: Stripe then refused the retry, nothing tried it again, and a
  // FlexPay draw was left 'pulled' — never drawn and never written off.

  /** Stripe's answer for each payment: the bank it is on, or after a bounce the bank on its error. */
  function pullsAtStripe(byIntent: Record<string, { on?: string; bounced?: string; status?: string } | 'missing'>) {
    stripeMocks.paymentIntentsRetrieve.mockImplementation(async (id: string) => {
      const p = byIntent[id]
      if (p === 'missing') {
        throw Object.assign(new Error(`No such payment_intent: '${id}'`), { type: 'StripeInvalidRequestError', code: 'resource_missing' })
      }
      if (!p) return { id, status: 'processing', payment_method: null, last_payment_error: null }
      if (p.bounced) {
        return { id, status: p.status ?? 'requires_payment_method', payment_method: null,
                 last_payment_error: { code: 'insufficient_funds', payment_method: { id: p.bounced, type: 'us_bank_account' } } }
      }
      return { id, status: p.status ?? 'processing', payment_method: p.on ?? null, last_payment_error: null }
    })
  }

  /** 'YYYY-MM-DD' on the seeded property's calendar (America/Phoenix, UTC-7 all year), `days` from today. */
  function phoenixDay(days: number): string {
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Phoenix' }).format(new Date())
    const [y, m, d] = today.split('-').map(Number)
    return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10)
  }
  /** The retry day these tests set: four days out, so the sentence names it (never a day gone by). */
  const RETRY_DAY = phoenixDay(4)
  /** Midnight of a Phoenix calendar day, as the timestamp the retry job stores. */
  const phoenixMidnight = (ymd: string) => `${ymd} 07:00:00+00`

  /** A bank pull on the tenant's lease: still clearing, or bounced with a retry set for `retryDay` (Phoenix). */
  async function pullOnLease(acct: { landlordId: string; unitId: string; leaseId: string; tenantId: string },
                             intent: string, state: 'clearing' | 'retry', retryDay: string = RETRY_DAY) {
    await db.query(
      `INSERT INTO payments (landlord_id, unit_id, lease_id, tenant_id, type, amount, status, entry_description,
                             due_date, stripe_payment_intent_id, next_retry_at, retry_count)
       VALUES ($1,$2,$3,$4,'rent',460,$5,'RENT',CURRENT_DATE,$6,
               CASE WHEN $5 = 'failed' THEN $7::timestamptz END, 0)`,
      [acct.landlordId, acct.unitId, acct.leaseId, acct.tenantId, state === 'retry' ? 'failed' : 'processing', intent,
       phoenixMidnight(retryDay)])
  }

  const RETRY_SENTENCE =
    "A payment from this bank didn't go through and is set to be tried again from it on " +
    new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric' })
      .format(new Date(`${RETRY_DAY}T00:00:00Z`)) + '. ' +
    'You can remove it once that payment has cleared.'
  const CLEARING_SENTENCE =
    'A payment from this bank is still clearing. ' +
    'You can remove it once that payment has cleared (a bank payment takes about 4 business days).'

  it('a bank a bounced payment will be retried from cannot be removed, even beside another verified bank', async () => {
    const acct = await bankAccount()
    await pullOnLease(acct, 'pi_rent_retry', 'retry')
    const world = stripeWorld({ banks: [{ id: 'pm_old', last4: '1111' }, { id: 'pm_new', last4: '2222' }], defaultId: 'pm_old' })
    pullsAtStripe({ pi_rent_retry: { bounced: 'pm_old' } })
    const before = await getMethods(acct.token)
    expect(before.status).toBe(200)
    expect(before.body.data.find((m: any) => m.id === 'pm_old'))
      .toMatchObject({ canRemove: false, removeBlockedReason: RETRY_SENTENCE })
    expect(before.body.data.find((m: any) => m.id === 'pm_new'))
      .toMatchObject({ canRemove: true, removeBlockedReason: null })
    const res = await removeMethod(acct.token, 'pm_old')
    expect(res.status).toBe(409)
    expect(res.body.error).toBe(RETRY_SENTENCE)
    expect(stripeMocks.paymentMethodsDetach).not.toHaveBeenCalled()
    expect(world.attached.has('pm_old')).toBe(true)
    expect(stripeMocks.paymentIntentsRetrieve).toHaveBeenCalledWith('pi_rent_retry')
  })

  it('a FlexPay draw retry from this bank keeps it; the other bank can still go', async () => {
    const acct = await bankAccount({ flexpayDraw: 'retry' })
    const world = stripeWorld({ banks: [{ id: 'pm_old', last4: '1111' }, { id: 'pm_new', last4: '2222' }], defaultId: 'pm_old' })
    pullsAtStripe({ pi_flex: { bounced: 'pm_old' } })
    const res = await removeMethod(acct.token, 'pm_old')
    expect(res.status).toBe(409)
    expect(res.body.error).toMatch(/^A payment from this bank didn't go through and is set to be tried again from it on /)
    expect(world.attached.has('pm_old')).toBe(true)
    const { rows: [adv] } = await db.query<any>(`SELECT status FROM flexpay_advances WHERE tenant_id=$1`, [acct.tenantId])
    expect(adv.status).toBe('pulled')            // the draw is still GAM's to collect from pm_old
    // The draw is not on pm_new, so pm_new is free to go.
    const other = await removeMethod(acct.token, 'pm_new')
    expect(other.status).toBe(200)
    expect(world.attached.has('pm_new')).toBe(false)
  })

  it('a payment clearing from this bank keeps it, even beside another verified bank', async () => {
    const acct = await bankAccount({ clearing: true })
    const world = stripeWorld({ banks: [{ id: 'pm_old', last4: '1111' }, { id: 'pm_new', last4: '2222' }], defaultId: 'pm_old' })
    pullsAtStripe({ pi_clearing: { on: 'pm_old' } })
    const res = await removeMethod(acct.token, 'pm_old')
    expect(res.status).toBe(409)
    expect(res.body.error).toBe(CLEARING_SENTENCE)
    expect(world.attached.has('pm_old')).toBe(true)
  })

  it('a payment clearing from the other bank does not keep this one', async () => {
    const acct = await bankAccount({ clearing: true })
    const world = stripeWorld({ banks: [{ id: 'pm_old', last4: '1111' }, { id: 'pm_new', last4: '2222' }], defaultId: 'pm_old' })
    pullsAtStripe({ pi_clearing: { on: 'pm_new' } })
    const res = await removeMethod(acct.token, 'pm_old')
    expect(res.status).toBe(200)
    expect(world.attached.has('pm_old')).toBe(false)
    // pm_new is now the only bank, and the payment is clearing from it.
    expect(res.body.data.methods).toEqual([
      expect.objectContaining({ id: 'pm_new', canRemove: false, removeBlockedReason: CLEARING_SENTENCE }),
    ])
  })

  it('a payment Stripe has finished, or does not have, does not keep the bank', async () => {
    const acct = await bankAccount()
    await pullOnLease(acct, 'pi_done', 'clearing')     // succeeded at Stripe; the webhook has not landed yet
    await pullOnLease(acct, 'pi_gone', 'retry')        // no such payment on this Stripe account
    const world = stripeWorld({ banks: [{ id: 'pm_old', last4: '1111' }, { id: 'pm_new', last4: '2222' }], defaultId: 'pm_old' })
    pullsAtStripe({ pi_done: { on: 'pm_old', status: 'succeeded' }, pi_gone: 'missing' })
    const res = await removeMethod(acct.token, 'pm_old')
    expect(res.status).toBe(200)
    expect(world.attached.has('pm_old')).toBe(false)
  })

  it("a bounced payment this tenant made on someone else's lease still keeps the bank it will be retried from", async () => {
    const acct = await bankAccount()
    const c = await db.connect()
    try {
      await c.query('BEGIN')
      const { rows: [{ property_id: propertyId }] } = await c.query<{ property_id: string }>(
        `SELECT property_id FROM units WHERE id = $1`, [acct.unitId])
      const otherUnit = await seedUnit(c, { propertyId, landlordId: acct.landlordId })
      const otherLease = await seedLease(c, { unitId: otherUnit, landlordId: acct.landlordId })
      const otherTenant = await seedTenant(c)
      await seedLeaseTenant(c, { leaseId: otherLease, tenantId: otherTenant })
      await c.query(
        `INSERT INTO payments (landlord_id, unit_id, lease_id, tenant_id, type, amount, status, entry_description,
                               due_date, stripe_payment_intent_id, next_retry_at, retry_count)
         VALUES ($1,$2,$3,$4,'rent',300,'failed','RENT',CURRENT_DATE,'pi_paid_for_them',
                 $5::timestamptz, 0)`,
        [acct.landlordId, otherUnit, otherLease, otherTenant, phoenixMidnight(RETRY_DAY)])
      await c.query(
        `INSERT INTO tenant_remittances (tenant_id, lease_id, landlord_id, amount, applied_amount, status,
                                         payment_method, stripe_payment_intent_id)
         VALUES ($1,$2,$3,300,300,'failed','ach','pi_paid_for_them')`,
        [acct.tenantId, otherLease, acct.landlordId])
      await c.query('COMMIT')
    } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
    stripeWorld({ banks: [{ id: 'pm_old', last4: '1111' }, { id: 'pm_new', last4: '2222' }], defaultId: 'pm_old' })
    pullsAtStripe({ pi_paid_for_them: { bounced: 'pm_old' } })
    const res = await removeMethod(acct.token, 'pm_old')
    expect(res.status).toBe(409)
    expect(res.body.error).toBe(RETRY_SENTENCE)
  })

  // Wave A cleanup: the in-flight read stopped at 25 pulls and dropped the
  // rest without a word, so a 26th pull — from the very bank being removed —
  // was never asked about and the bank was detached under it. Past the cap,
  // every verified bank is now held back, on the screen and on removal.
  const OVERFLOW_SENTENCE =
    "Too many payments on your household's account are still clearing for us to tell whether one came from this bank. " +
    'You can remove it once some of them have cleared.'

  /** `n` bank pulls still clearing from `bank`, on earlier days (one rent row per due date), named pi_a_00…. */
  async function clearingPulls(acct: { landlordId: string; unitId: string; leaseId: string; tenantId: string },
                               n: number, bank: string): Promise<Record<string, { on: string }>> {
    const atStripe: Record<string, { on: string }> = {}
    for (let i = 0; i < n; i++) {
      const intent = `pi_a_${String(i).padStart(2, '0')}`
      await db.query(
        `INSERT INTO payments (landlord_id, unit_id, lease_id, tenant_id, type, amount, status, entry_description,
                               due_date, stripe_payment_intent_id)
         VALUES ($1,$2,$3,$4,'rent',460,'processing','RENT',CURRENT_DATE - ($5::int + 1),$6)`,
        [acct.landlordId, acct.unitId, acct.leaseId, acct.tenantId, i, intent])
      atStripe[intent] = { on: bank }
    }
    return atStripe
  }

  it('past 25 pulls in flight, a bank whose pull sorts last is still kept (fails closed)', async () => {
    const acct = await bankAccount()
    const atStripe: Record<string, { on?: string; bounced?: string }> = await clearingPulls(acct, 25, 'pm_new')
    await pullOnLease(acct, 'pi_zz_old', 'retry')      // sorts 26th, past the cap
    atStripe.pi_zz_old = { bounced: 'pm_old' }
    const world = stripeWorld({
      banks: [{ id: 'pm_old', last4: '1111' }, { id: 'pm_new', last4: '2222' }],
      cards: [{ id: 'pm_card', last4: '4242' }],
      defaultId: 'pm_old',
    })
    pullsAtStripe(atStripe)

    const before = await getMethods(acct.token)
    expect(before.status).toBe(200)
    expect(before.body.data.find((m: any) => m.id === 'pm_old'))
      .toMatchObject({ canRemove: false, removeBlockedReason: OVERFLOW_SENTENCE })
    expect(before.body.data.find((m: any) => m.id === 'pm_new'))
      .toMatchObject({ canRemove: false, removeBlockedReason: CLEARING_SENTENCE })
    expect(before.body.data.find((m: any) => m.id === 'pm_card')).toMatchObject({ canRemove: true })
    // Only the first 25 are asked about; the 26th is never looked up.
    expect(stripeMocks.paymentIntentsRetrieve).toHaveBeenCalledTimes(25)
    expect(stripeMocks.paymentIntentsRetrieve).not.toHaveBeenCalledWith('pi_zz_old')

    const res = await removeMethod(acct.token, 'pm_old')
    expect(res.status).toBe(409)
    expect(res.body.error).toBe(OVERFLOW_SENTENCE)
    expect(stripeMocks.paymentMethodsDetach).not.toHaveBeenCalled()
    expect(world.attached.has('pm_old')).toBe(true)
    const { rows: [t] } = await db.query<any>(`SELECT ach_verified, bank_last4 FROM tenants WHERE id=$1`, [acct.tenantId])
    expect(t).toEqual({ ach_verified: true, bank_last4: '1111' })
    // A card is not affected.
    const card = await removeMethod(acct.token, 'pm_card')
    expect(card.status).toBe(200)
  })

  it('exactly 25 pulls in flight are all checked, so a bank none came from can still go', async () => {
    const acct = await bankAccount()
    const atStripe = await clearingPulls(acct, 25, 'pm_new')
    const world = stripeWorld({ banks: [{ id: 'pm_old', last4: '1111' }, { id: 'pm_new', last4: '2222' }], defaultId: 'pm_old' })
    pullsAtStripe(atStripe)
    const res = await removeMethod(acct.token, 'pm_old')
    expect(res.status).toBe(200)
    expect(world.attached.has('pm_old')).toBe(false)
    expect(stripeMocks.paymentIntentsRetrieve).toHaveBeenCalledTimes(25)
  })

  it('exactly 25 pulls in flight: the last one, from this bank, still keeps it', async () => {
    const acct = await bankAccount()
    const atStripe: Record<string, { on?: string; bounced?: string }> = await clearingPulls(acct, 24, 'pm_new')
    await pullOnLease(acct, 'pi_zz_old', 'retry')      // 25th: inside the cap
    atStripe.pi_zz_old = { bounced: 'pm_old' }
    const world = stripeWorld({ banks: [{ id: 'pm_old', last4: '1111' }, { id: 'pm_new', last4: '2222' }], defaultId: 'pm_old' })
    pullsAtStripe(atStripe)
    const res = await removeMethod(acct.token, 'pm_old')
    expect(res.status).toBe(409)
    expect(res.body.error).toBe(RETRY_SENTENCE)
    expect(world.attached.has('pm_old')).toBe(true)
  })

  it('when Stripe cannot say which bank a payment is on, no verified bank is removed and the screen says so', async () => {
    const acct = await bankAccount({ clearing: true })
    const world = stripeWorld({
      banks: [{ id: 'pm_old', last4: '1111' }, { id: 'pm_new', last4: '2222' }],
      cards: [{ id: 'pm_card', last4: '4242' }],
      defaultId: 'pm_old',
    })
    stripeMocks.paymentIntentsRetrieve.mockRejectedValue(new Error('stripe down'))
    const before = await getMethods(acct.token)
    expect(before.status).toBe(200)
    for (const id of ['pm_old', 'pm_new']) {
      const m = before.body.data.find((x: any) => x.id === id)
      expect(m.canRemove).toBe(false)
      expect(m.removeBlockedReason).toMatch(/could not check with our payment processor whether a payment from this bank is still clearing/)
    }
    expect(before.body.data.find((m: any) => m.id === 'pm_card')).toMatchObject({ canRemove: true })
    const res = await removeMethod(acct.token, 'pm_old')
    expect(res.status).toBe(503)
    expect(res.body.error).toMatch(/Nothing was removed/)
    expect(stripeMocks.paymentMethodsDetach).not.toHaveBeenCalled()
    // A card is not affected: it still goes.
    const card = await removeMethod(acct.token, 'pm_card')
    expect(card.status).toBe(200)
    expect(world.attached.has('pm_card')).toBe(false)
  })

  // Wave A review: FlexPay enrollment reads ach_verified, and the removal read
  // flexpay_enrolled off the pool outside its transaction — both could commit,
  // leaving a tenant enrolled with no bank. The removal now locks the tenants
  // row before it reads the account, so an enrollment that commits while it
  // waits is seen.
  it('a FlexPay enrollment that commits while a removal waits on the tenant is seen, and the only bank stays', async () => {
    const { tenantId, token } = await bankAccount()
    const world = stripeWorld({ banks: [{ id: 'pm_old', last4: '1111' }], defaultId: 'pm_old' })
    const enrolling = await db.connect()
    try {
      await enrolling.query('BEGIN')
      await enrolling.query(`UPDATE tenants SET flexpay_enrolled = TRUE WHERE id = $1`, [tenantId])
      const pending = removeMethod(token, 'pm_old').then((r) => r)
      // Wait until the removal is held on the tenants row.
      const until = Date.now() + 10_000
      for (;;) {
        const { rows: [w] } = await db.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
            WHERE NOT l.granted AND a.datname = current_database()`)
        if (w.n > 0) break
        if (Date.now() > until) throw new Error('the removal never waited on the tenants row')
        await new Promise((r) => setTimeout(r, 25))
      }
      await enrolling.query('COMMIT')
      const res = await pending
      expect(res.status).toBe(409)
      expect(res.body.error).toMatch(/FlexPay draws from it/)
      expect(stripeMocks.paymentMethodsDetach).not.toHaveBeenCalled()
      expect(world.attached.has('pm_old')).toBe(true)
    } catch (e) {
      await enrolling.query('ROLLBACK').catch(() => {})
      throw e
    } finally { enrolling.release() }
    const { rows: [t] } = await db.query<any>(`SELECT ach_verified, flexpay_enrolled FROM tenants WHERE id=$1`, [tenantId])
    expect(t).toEqual({ ach_verified: true, flexpay_enrolled: true })
  })

  /** Until a request is held waiting on a row lock in this database. */
  async function untilALockWaits(what: string) {
    const until = Date.now() + 10_000
    for (;;) {
      const { rows: [w] } = await db.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
          WHERE NOT l.granted AND a.datname = current_database()`)
      if (w.n > 0) return
      if (Date.now() > until) throw new Error(what)
      await new Promise((r) => setTimeout(r, 25))
    }
  }

  // Wave A cleanup (PROBE Q): the removal read the pulls in flight BEFORE it
  // locked the tenants row. Pay Now writes its receipt first (a share lock on
  // that row), so the removal waited on the row while the charge stamped its
  // pull from pm_old and committed — and then went on with the list it had
  // read before waiting: pm_old was detached under a payment still clearing,
  // and a bounce of it could never be retried. The pulls are now read after
  // the lock.
  it('a Pay Now that commits while a removal waits on the tenant keeps the bank it pulled from', async () => {
    const acct = await bankAccount()
    const world = stripeWorld({ banks: [{ id: 'pm_old', last4: '1111' }, { id: 'pm_new', last4: '2222' }], defaultId: 'pm_old' })
    pullsAtStripe({ pi_q: { on: 'pm_old' } })
    const paying = await db.connect()
    try {
      await paying.query('BEGIN')
      // The receipt first, as Pay Now writes it before it charges.
      const { rows: [rem] } = await paying.query<{ id: string }>(
        `INSERT INTO tenant_remittances (tenant_id, lease_id, landlord_id, amount, applied_amount, status, payment_method)
         VALUES ($1,$2,$3,460,460,'processing','ach') RETURNING id`,
        [acct.tenantId, acct.leaseId, acct.landlordId])
      const pending = removeMethod(acct.token, 'pm_old').then((r) => r)
      await untilALockWaits('the removal never waited on the tenants row')
      // The charge claims the bill and stamps its pull from pm_old, then commits.
      await paying.query(
        `INSERT INTO payments (landlord_id, unit_id, lease_id, tenant_id, type, amount, status, entry_description,
                               due_date, stripe_payment_intent_id)
         VALUES ($1,$2,$3,$4,'rent',460,'processing','RENT',CURRENT_DATE,'pi_q')`,
        [acct.landlordId, acct.unitId, acct.leaseId, acct.tenantId])
      await paying.query(`UPDATE tenant_remittances SET stripe_payment_intent_id = 'pi_q' WHERE id = $1`, [rem.id])
      await paying.query('COMMIT')
      const res = await pending
      expect(res.status).toBe(409)
      expect(res.body.error).toBe(CLEARING_SENTENCE)
      expect(stripeMocks.paymentMethodsDetach).not.toHaveBeenCalled()
      expect(world.attached.has('pm_old')).toBe(true)
      expect(stripeMocks.paymentIntentsRetrieve).toHaveBeenCalledWith('pi_q')
    } catch (e) {
      await paying.query('ROLLBACK').catch(() => {})
      throw e
    } finally { paying.release() }
    // The other bank was never the one pulled from, so it can still go.
    const other = await removeMethod(acct.token, 'pm_new')
    expect(other.status).toBe(200)
  })

  // Wave A cleanup (PROBE J): a retry day the daily retry run missed was still
  // named ("set to be tried again from it on Thursday, October 1" on Oct 3).
  const OVERDUE_SENTENCE =
    "A payment from this bank didn't go through and is set to be tried again from it shortly. " +
    'You can remove it once that payment has cleared.'

  it('a retry whose day has passed (the daily run has not reached it) is "tried again shortly", never a day gone by', async () => {
    const acct = await bankAccount()
    await pullOnLease(acct, 'pi_late', 'retry', phoenixDay(-2))
    const world = stripeWorld({ banks: [{ id: 'pm_old', last4: '1111' }, { id: 'pm_new', last4: '2222' }], defaultId: 'pm_old' })
    pullsAtStripe({ pi_late: { bounced: 'pm_old' } })
    const before = await getMethods(acct.token)
    expect(before.status).toBe(200)
    expect(before.body.data.find((m: any) => m.id === 'pm_old'))
      .toMatchObject({ canRemove: false, removeBlockedReason: OVERDUE_SENTENCE })
    const res = await removeMethod(acct.token, 'pm_old')
    expect(res.status).toBe(409)
    expect(res.body.error).toBe(OVERDUE_SENTENCE)
    expect(world.attached.has('pm_old')).toBe(true)
  })

  // Wave A cleanup (PROBE J-today): a retry set for today, read after that
  // day's 04:00 retry run, is tried at tomorrow's run — but the sentence still
  // named today. A retry already due (its day has started) always reads
  // "shortly": the next daily run tries it.
  it('a retry already due reads shortly', async () => {
    const acct = await bankAccount()
    await pullOnLease(acct, 'pi_today', 'retry', phoenixDay(0))
    const world = stripeWorld({ banks: [{ id: 'pm_old', last4: '1111' }, { id: 'pm_new', last4: '2222' }], defaultId: 'pm_old' })
    pullsAtStripe({ pi_today: { bounced: 'pm_old' } })
    const before = await getMethods(acct.token)
    expect(before.status).toBe(200)
    expect(before.body.data.find((m: any) => m.id === 'pm_old'))
      .toMatchObject({ canRemove: false, removeBlockedReason: OVERDUE_SENTENCE })
    const res = await removeMethod(acct.token, 'pm_old')
    expect(res.status).toBe(409)
    expect(res.body.error).toBe(OVERDUE_SENTENCE)
    expect(world.attached.has('pm_old')).toBe(true)
  })

  it('a retry set for tomorrow on the property\'s calendar names tomorrow', async () => {
    const acct = await bankAccount()
    const tomorrow = phoenixDay(1)
    await pullOnLease(acct, 'pi_tomorrow', 'retry', tomorrow)
    stripeWorld({ banks: [{ id: 'pm_old', last4: '1111' }, { id: 'pm_new', last4: '2222' }], defaultId: 'pm_old' })
    pullsAtStripe({ pi_tomorrow: { bounced: 'pm_old' } })
    const res = await removeMethod(acct.token, 'pm_old')
    expect(res.status).toBe(409)
    const label = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric' })
      .format(new Date(`${tomorrow}T00:00:00Z`))
    expect(res.body.error).toBe(
      `A payment from this bank didn't go through and is set to be tried again from it on ${label}. ` +
      'You can remove it once that payment has cleared.')
  })
})

// The default is chosen per bank (wave A review): a bank still verifying —
// even one Stripe has attached — cannot be made the default, or autopay would
// charge a bank that cannot be charged yet.
describe('S655 PATCH /tenant/default-payment-method decides on each bank', () => {
  const makeDefault = (token: string, paymentMethodId: string) =>
    request(buildApp()).patch('/api/stripe/tenant/default-payment-method')
      .set('Authorization', `Bearer ${token}`).send({ paymentMethodId })

  it('a bank still verifying cannot be made the default, even once Stripe has attached it', async () => {
    const { token } = await bankAccount()
    const world = stripeWorld({
      banks: [{ id: 'pm_old', last4: '1111' }],
      waiting: [{ siId: 'seti_a', pmId: 'pm_a', last4: '2222', attached: true },
                { siId: 'seti_b', pmId: 'pm_b', last4: '3333' }],
      defaultId: 'pm_old',
    })
    for (const id of ['pm_a', 'pm_b']) {
      const res = await makeDefault(token, id)
      expect(res.status).toBe(409)
      expect(res.body.error).toMatch(/isn’t verified yet\. Finish the verification Stripe sent you first/)
    }
    expect(stripeMocks.customersUpdate).not.toHaveBeenCalled()
    expect(world.defaultId).toBe('pm_old')
  })

  it('a verified bank becomes the default and the bank named on file', async () => {
    const { tenantId, token } = await bankAccount({ bankLast4: '1111' })
    const world = stripeWorld({ banks: [{ id: 'pm_old', last4: '1111' }, { id: 'pm_new', last4: '2222' }], defaultId: 'pm_old' })
    const res = await makeDefault(token, 'pm_new')
    expect(res.status).toBe(200)
    expect(res.body.data).toEqual({ defaultPaymentMethodId: 'pm_new' })
    expect(world.defaultId).toBe('pm_new')
    const { rows: [t] } = await db.query<any>(`SELECT ach_verified, bank_last4 FROM tenants WHERE id=$1`, [tenantId])
    expect(t).toEqual({ ach_verified: true, bank_last4: '2222' })
  })

  it('a card can still be made the default; the bank on file stays', async () => {
    const { tenantId, token } = await bankAccount({ bankLast4: '1111' })
    const world = stripeWorld({ banks: [{ id: 'pm_old', last4: '1111' }], cards: [{ id: 'pm_card', last4: '4242' }], defaultId: 'pm_old' })
    const res = await makeDefault(token, 'pm_card')
    expect(res.status).toBe(200)
    expect(world.defaultId).toBe('pm_card')
    const { rows: [t] } = await db.query<any>(`SELECT ach_verified, bank_last4 FROM tenants WHERE id=$1`, [tenantId])
    expect(t).toEqual({ ach_verified: true, bank_last4: '1111' })
  })

  // Wave A cleanup: with two verified banks, making a card the default named
  // whichever bank Stripe lists first (newest first) as the bank on file — a
  // bank the tenant never picked.
  it('with two verified banks, a card made the default keeps the old default as the bank on file', async () => {
    const { tenantId, token } = await bankAccount({ bankLast4: '1111' })
    // Stripe lists the newer bank first.
    const world = stripeWorld({
      banks: [{ id: 'pm_new', last4: '2222' }, { id: 'pm_old', last4: '1111' }],
      cards: [{ id: 'pm_card', last4: '4242' }],
      defaultId: 'pm_old',
    })
    const res = await makeDefault(token, 'pm_card')
    expect(res.status).toBe(200)
    expect(world.defaultId).toBe('pm_card')
    const bankOnFile = async () =>
      (await db.query<any>(`SELECT ach_verified, bank_last4 FROM tenants WHERE id=$1`, [tenantId])).rows[0]
    expect(await bankOnFile()).toEqual({ ach_verified: true, bank_last4: '1111' })
    // Choosing the card again (the default is already a card) still keeps it.
    const again = await makeDefault(token, 'pm_card')
    expect(again.status).toBe(200)
    expect(await bankOnFile()).toEqual({ ach_verified: true, bank_last4: '1111' })
    // Picking a bank still moves the bank on file to it.
    const bank = await makeDefault(token, 'pm_new')
    expect(bank.status).toBe(200)
    expect(await bankOnFile()).toEqual({ ach_verified: true, bank_last4: '2222' })
  })

  it('with a card as the default, removing another bank keeps the bank on file', async () => {
    const { tenantId, token } = await bankAccount({ bankLast4: '1111' })
    const world = stripeWorld({
      banks: [{ id: 'pm_third', last4: '3333' }, { id: 'pm_new', last4: '2222' }, { id: 'pm_old', last4: '1111' }],
      cards: [{ id: 'pm_card', last4: '4242' }],
      defaultId: 'pm_card',
    })
    const res = await removeMethod(token, 'pm_third')
    expect(res.status).toBe(200)
    expect(world.attached.has('pm_third')).toBe(false)
    expect(world.defaultId).toBe('pm_card')
    const { rows: [t] } = await db.query<any>(`SELECT ach_verified, bank_last4 FROM tenants WHERE id=$1`, [tenantId])
    expect(t).toEqual({ ach_verified: true, bank_last4: '1111' })
  })

  it('a method that is not on the account is refused and never sent to Stripe', async () => {
    const { token } = await bankAccount()
    stripeWorld({ banks: [{ id: 'pm_old', last4: '1111' }], defaultId: 'pm_old' })
    const res = await makeDefault(token, 'pm_someone_elses')
    expect(res.status).toBe(403)
    expect(res.body.error).toBe('That payment method is not saved on your account.')
    expect(stripeMocks.customersUpdate).not.toHaveBeenCalled()
  })

  // Wave A cleanup (PROBE N): a tenant with no Stripe customer was told
  // "Stripe customer not initialized".
  it('a tenant who has never saved a bank or card is told so in plain words, with the next step', async () => {
    const { tenantId, token } = await bankAccount({ bankLast4: null })
    await db.query(`UPDATE tenants SET stripe_customer_id = NULL, ach_verified = FALSE WHERE id = $1`, [tenantId])
    const res = await makeDefault(token, 'pm_anything')
    expect(res.status).toBe(409)
    expect(res.body.error).toBe('You have no saved payment methods yet. Add a bank or card on the Payments page first.')
    expect(stripeMocks.customersUpdate).not.toHaveBeenCalled()
    expect(stripeMocks.paymentMethodsList).not.toHaveBeenCalled()
  })

  it('when Stripe cannot say which banks are verifying, the default is not changed', async () => {
    const { token } = await bankAccount()
    const world = stripeWorld({ banks: [{ id: 'pm_old', last4: '1111' }, { id: 'pm_new', last4: '2222' }], defaultId: 'pm_old' })
    stripeMocks.setupIntentsList.mockRejectedValueOnce(new Error('stripe down'))
    const res = await makeDefault(token, 'pm_new')
    expect(res.status).toBe(503)
    expect(res.body.error).toMatch(/Nothing changed/)
    expect(stripeMocks.customersUpdate).not.toHaveBeenCalled()
    expect(world.defaultId).toBe('pm_old')
  })
})

describe('S655 recordVerifiedTenantBank (setup_intent.succeeded and confirm)', () => {
  it('a verified bank already on file: the new bank is promoted once', async () => {
    const { tenantId } = await bankAccount()
    await db.query(
      `INSERT INTO ach_monitoring_log (event_type, tenant_id, bank_fingerprint, notes)
       VALUES ('first_sender', $1, '110000000_1111', 'old bank')`, [tenantId])
    stripeWorld({ banks: [{ id: 'pm_old', last4: '1111' }, { id: 'pm_new', last4: '2222' }], defaultId: 'pm_old' })

    const first = await recordVerifiedTenantBank({
      customerId: 'cus_mock_tenant', paymentMethodId: 'pm_new',
      bank: { last4: '2222', routing_number: '221000000' }, makeDefault: 'first_time',
    })
    expect(first).toEqual({ tenantId, refused: null, firstTime: true, madeDefault: true })
    expect(stripeMocks.customersUpdate).toHaveBeenCalledTimes(1)

    // Redelivered: nothing new, and a tenant who has since picked a card keeps it.
    const again = await recordVerifiedTenantBank({
      customerId: 'cus_mock_tenant', paymentMethodId: 'pm_new',
      bank: { last4: '2222', routing_number: '221000000' }, makeDefault: 'first_time',
    })
    expect(again).toEqual({ tenantId, refused: null, firstTime: false, madeDefault: false })
    expect(stripeMocks.customersUpdate).toHaveBeenCalledTimes(1)

    const { rows: log } = await db.query<any>(
      `SELECT bank_fingerprint FROM ach_monitoring_log WHERE tenant_id=$1 AND event_type='first_sender' ORDER BY bank_fingerprint`,
      [tenantId])
    expect(log.map((r: any) => r.bank_fingerprint)).toEqual(['110000000_1111', '221000000_2222'])
    const { rows: [t] } = await db.query<any>(`SELECT ach_verified, bank_last4 FROM tenants WHERE id=$1`, [tenantId])
    expect(t).toEqual({ ach_verified: true, bank_last4: '2222' })
  })

  it('clears the waiting flag unless another bank is still waiting', async () => {
    const { tenantId } = await bankAccount()
    await db.query(`UPDATE tenants SET bank_pending_since = NOW() WHERE id=$1`, [tenantId])
    // pm_new has just verified (attached); pm_other is still waiting.
    stripeWorld({ banks: [{ id: 'pm_new', last4: '2222' }],
                  waiting: [{ siId: 'seti_other', pmId: 'pm_other', last4: '3333' }] })
    await recordVerifiedTenantBank({ tenantId, customerId: 'cus_mock_tenant', paymentMethodId: 'pm_new',
      bank: { last4: '2222', routing_number: '221000000' }, makeDefault: 'first_time' })
    let { rows: [t] } = await db.query<any>(`SELECT bank_pending_since FROM tenants WHERE id=$1`, [tenantId])
    expect(t.bank_pending_since).not.toBeNull()       // pm_other is still waiting

    stripeWorld({ banks: [{ id: 'pm_new', last4: '2222' }, { id: 'pm_other', last4: '3333' }] })
    await recordVerifiedTenantBank({ tenantId, customerId: 'cus_mock_tenant', paymentMethodId: 'pm_other',
      bank: { last4: '3333', routing_number: '221000000' }, makeDefault: 'first_time' })
    ;({ rows: [t] } = await db.query<any>(`SELECT bank_pending_since FROM tenants WHERE id=$1`, [tenantId]))
    expect(t.bank_pending_since).toBeNull()
  })

  // Wave A cleanup (finding 2a): the default was decided on the NACHA
  // first-time-sender fingerprint (routing + last 4), so a bank the tenant
  // removed and later added again — a new saved bank on the same account — was
  // verified but never made the default.
  it('a bank removed and added again (same account, new saved bank) becomes the default again', async () => {
    const { tenantId } = await bankAccount({ bankLast4: '1111' })
    await db.query(
      `INSERT INTO ach_monitoring_log (event_type, tenant_id, bank_fingerprint, notes)
       VALUES ('first_sender', $1, '221000000_2222', 'the account, verified before it was removed')`, [tenantId])
    const world = stripeWorld({ banks: [{ id: 'pm_old', last4: '1111' }, { id: 'pm_readded', last4: '2222' }], defaultId: 'pm_old' })
    const r = await recordVerifiedTenantBank({
      customerId: 'cus_mock_tenant', paymentMethodId: 'pm_readded',
      bank: { last4: '2222', routing_number: '221000000' }, makeDefault: 'first_time',
    })
    expect(r).toEqual({ tenantId, refused: null, firstTime: false, madeDefault: true })
    expect(world.defaultId).toBe('pm_readded')
    expect(world.metadata.get('pm_readded')?.gam_made_default_at).toEqual(expect.any(String))
    const { rows: [t] } = await db.query<any>(`SELECT ach_verified, bank_last4 FROM tenants WHERE id=$1`, [tenantId])
    expect(t).toEqual({ ach_verified: true, bank_last4: '2222' })
    // Not a first-time sender again: the account's row stays the only one.
    const { rows: log } = await db.query<any>(
      `SELECT bank_fingerprint FROM ach_monitoring_log WHERE tenant_id=$1 AND event_type='first_sender'`, [tenantId])
    expect(log).toEqual([{ bank_fingerprint: '221000000_2222' }])
  })

  // Wave A cleanup (finding 2b, PROBE P): a verification that did not make the
  // bank the default still wrote it as the bank on file, so the row named
  // pm_new (2222) while Stripe's default stayed pm_old.
  it('a redelivered verification leaves the default and the bank on file where the tenant put them', async () => {
    const { tenantId, token } = await bankAccount({ bankLast4: '1111' })
    const world = stripeWorld({
      banks: [{ id: 'pm_old', last4: '1111' }, { id: 'pm_new', last4: '2222' }],
      cards: [{ id: 'pm_card', last4: '4242' }],
      defaultId: 'pm_old',
    })
    const verify = () => recordVerifiedTenantBank({
      customerId: 'cus_mock_tenant', paymentMethodId: 'pm_new',
      bank: { last4: '2222', routing_number: '221000000' }, makeDefault: 'first_time',
    })
    const bankOnFile = async () =>
      (await db.query<any>(`SELECT ach_verified, bank_last4 FROM tenants WHERE id=$1`, [tenantId])).rows[0]
    const pick = (id: string) => request(buildApp()).patch('/api/stripe/tenant/default-payment-method')
      .set('Authorization', `Bearer ${token}`).send({ paymentMethodId: id })

    expect((await verify()).madeDefault).toBe(true)
    expect(await bankOnFile()).toEqual({ ach_verified: true, bank_last4: '2222' })

    // The tenant goes back to their old bank; the event is delivered again.
    expect((await pick('pm_old')).status).toBe(200)
    stripeMocks.customersUpdate.mockClear()
    expect(await verify()).toEqual({ tenantId, refused: null, firstTime: false, madeDefault: false })
    expect(stripeMocks.customersUpdate).not.toHaveBeenCalled()
    expect(world.defaultId).toBe('pm_old')
    expect(await bankOnFile()).toEqual({ ach_verified: true, bank_last4: '1111' })

    // A card picked as the default stays too, and the bank on file with it.
    expect((await pick('pm_card')).status).toBe(200)
    expect((await verify()).madeDefault).toBe(false)
    expect(world.defaultId).toBe('pm_card')
    expect(await bankOnFile()).toEqual({ ach_verified: true, bank_last4: '1111' })
  })

  it('when Stripe refuses the new default, the bank on file stays the default Stripe has', async () => {
    const { tenantId } = await bankAccount({ bankLast4: '1111' })
    const world = stripeWorld({ banks: [{ id: 'pm_old', last4: '1111' }, { id: 'pm_new', last4: '2222' }], defaultId: 'pm_old' })
    stripeMocks.customersUpdate.mockRejectedValueOnce(new Error('stripe down'))
    const r = await recordVerifiedTenantBank({
      customerId: 'cus_mock_tenant', paymentMethodId: 'pm_new',
      bank: { last4: '2222', routing_number: '221000000' }, makeDefault: 'first_time',
    })
    expect(r).toEqual({ tenantId, refused: null, firstTime: true, madeDefault: false })
    expect(world.defaultId).toBe('pm_old')
    const { rows: [t] } = await db.query<any>(`SELECT ach_verified, bank_last4 FROM tenants WHERE id=$1`, [tenantId])
    expect(t).toEqual({ ach_verified: true, bank_last4: '1111' })
  })

  it('with no verified bank on file, the new bank is named even when Stripe refuses the default', async () => {
    const { tenantId } = await bankAccount({ bankLast4: null })
    await db.query(`UPDATE tenants SET ach_verified = FALSE WHERE id=$1`, [tenantId])
    const world = stripeWorld({ banks: [{ id: 'pm_new', last4: '2222' }], cards: [{ id: 'pm_card', last4: '4242' }],
                                defaultId: 'pm_card' })
    stripeMocks.customersUpdate.mockRejectedValueOnce(new Error('stripe down'))
    const r = await recordVerifiedTenantBank({
      tenantId, customerId: 'cus_mock_tenant', paymentMethodId: 'pm_new',
      bank: { last4: '2222', routing_number: '221000000' }, makeDefault: 'always',
    })
    expect(r).toMatchObject({ refused: null, madeDefault: false })
    expect(world.defaultId).toBe('pm_card')
    const { rows: [t] } = await db.query<any>(`SELECT ach_verified, bank_last4 FROM tenants WHERE id=$1`, [tenantId])
    expect(t).toEqual({ ach_verified: true, bank_last4: '2222' })
  })

  it('an unknown customer changes nothing', async () => {
    const r = await recordVerifiedTenantBank({ customerId: 'cus_nobody', paymentMethodId: 'pm_x',
      bank: { last4: '2222' }, makeDefault: 'first_time' })
    expect(r).toEqual({ tenantId: null, refused: 'no_tenant', firstTime: false, madeDefault: false })
    expect(stripeMocks.customersUpdate).not.toHaveBeenCalled()
  })

  // The tenant removed their only bank (allowed: nothing owed, autopay off) and
  // then sent that bank's old, succeeded SetupIntent through confirm-setup
  // again. Recording it would mark them bank-verified — the FlexPay /
  // FlexDeposit gate — with no bank on file.
  it('a removed bank replayed through confirm-setup is refused and the tenant stays unverified', async () => {
    const { tenantId, token } = await bankAccount()
    stripeWorld({ banks: [{ id: 'pm_old', last4: '1111' }], defaultId: 'pm_old' })
    const removed = await removeMethod(token, 'pm_old')
    expect(removed.status).toBe(200)

    stripeMocks.setupIntentsRetrieve.mockResolvedValueOnce(
      { id: 'seti_old', status: 'succeeded', customer: 'cus_mock_tenant', payment_method: 'pm_old' } as any)
    const res = await request(buildApp()).post('/api/stripe/tenant/confirm-setup')
      .set('Authorization', `Bearer ${token}`)
      .send({ setupIntentId: 'seti_old', paymentMethodId: 'pm_old' })
    expect(res.status).toBe(409)
    expect(res.body.error).toMatch(/That bank was removed from your account/)
    expect(res.body.error).toMatch(/add it as a new bank on the Payments page/)

    const { rows: [t] } = await db.query<any>(
      `SELECT ach_verified, bank_last4, bank_routing_last4 FROM tenants WHERE id=$1`, [tenantId])
    expect(t).toEqual({ ach_verified: false, bank_last4: null, bank_routing_last4: null })
    const { rows: log } = await db.query<any>(`SELECT 1 FROM ach_monitoring_log WHERE tenant_id=$1`, [tenantId])
    expect(log).toHaveLength(0)
    expect(stripeMocks.customersUpdate).not.toHaveBeenCalled()
  })

  // The same replay arriving as a redelivered setup_intent.succeeded (Step 10's
  // webhook calls this service): the service checks under the bank lock itself.
  it('a redelivered verification for a bank the tenant removed records nothing', async () => {
    const { tenantId } = await bankAccount({ bankLast4: null })
    await db.query(`UPDATE tenants SET ach_verified = FALSE WHERE id=$1`, [tenantId])
    stripeWorld({})                                   // pm_gone is no longer attached
    const r = await recordVerifiedTenantBank({
      customerId: 'cus_mock_tenant', paymentMethodId: 'pm_gone',
      bank: { last4: '2222', routing_number: '221000000' }, makeDefault: 'first_time',
    })
    expect(r).toEqual({ tenantId, refused: 'not_on_account', firstTime: false, madeDefault: false })
    const { rows: [t] } = await db.query<any>(`SELECT ach_verified, bank_last4 FROM tenants WHERE id=$1`, [tenantId])
    expect(t).toEqual({ ach_verified: false, bank_last4: null })
    const { rows: log } = await db.query<any>(`SELECT 1 FROM ach_monitoring_log WHERE tenant_id=$1`, [tenantId])
    expect(log).toHaveLength(0)
    expect(stripeMocks.customersUpdate).not.toHaveBeenCalled()
  })

  it('a verification naming another customer than the tenant\'s records nothing', async () => {
    const { tenantId } = await bankAccount({ bankLast4: null })
    await db.query(`UPDATE tenants SET ach_verified = FALSE WHERE id=$1`, [tenantId])
    stripeWorld({ banks: [{ id: 'pm_new', last4: '2222' }] })
    const r = await recordVerifiedTenantBank({
      tenantId, customerId: 'cus_someone_else', paymentMethodId: 'pm_new',
      bank: { last4: '2222', routing_number: '221000000' }, makeDefault: 'always',
    })
    expect(r.refused).toBe('not_on_account')
    const { rows: [t] } = await db.query<any>(`SELECT ach_verified FROM tenants WHERE id=$1`, [tenantId])
    expect(t.ach_verified).toBe(false)
  })

  it('a card is never recorded as a verified bank', async () => {
    const { tenantId } = await bankAccount({ bankLast4: null })
    await db.query(`UPDATE tenants SET ach_verified = FALSE WHERE id=$1`, [tenantId])
    stripeWorld({ cards: [{ id: 'pm_card', last4: '4242' }] })
    const r = await recordVerifiedTenantBank({
      tenantId, customerId: 'cus_mock_tenant', paymentMethodId: 'pm_card',
      bank: null, makeDefault: 'first_time',
    })
    expect(r.refused).toBe('not_a_bank')
    const { rows: [t] } = await db.query<any>(`SELECT ach_verified, bank_last4 FROM tenants WHERE id=$1`, [tenantId])
    expect(t).toEqual({ ach_verified: false, bank_last4: null })
  })

  it('when Stripe cannot be asked about the bank, nothing is recorded and it says to try again', async () => {
    const { tenantId } = await bankAccount({ bankLast4: null })
    await db.query(`UPDATE tenants SET ach_verified = FALSE WHERE id=$1`, [tenantId])
    stripeMocks.paymentMethodsRetrieve.mockRejectedValueOnce(new Error('stripe down'))
    await expect(recordVerifiedTenantBank({
      tenantId, customerId: 'cus_mock_tenant', paymentMethodId: 'pm_new',
      bank: { last4: '2222', routing_number: '221000000' }, makeDefault: 'always',
    })).rejects.toMatchObject({ statusCode: 502 })
    const { rows: [t] } = await db.query<any>(`SELECT ach_verified FROM tenants WHERE id=$1`, [tenantId])
    expect(t.ach_verified).toBe(false)
  })
})

describe('S655 P5 backfill planner (scripts/oct3_bank_pending_since_backfill.ts)', () => {
  const row = (o: Partial<{ ach_verified: boolean; bank_pending_since: Date | null }>) =>
    ({ id: 't', ach_verified: false, bank_pending_since: null, bank_last4: null, ...o })

  it('flags only a bank Stripe is really waiting on, dated when that setup started', async () => {
    stripeWorld({ waiting: [{ siId: 'seti_a', pmId: 'pm_a', last4: '2222', createdS: 1758000000 }] })
    const plan = planBankBackfill(row({}), await readStripeMethodFacts('cus_mock_tenant', { strict: true }))
    expect(plan.pendingSince?.toISOString()).toBe(new Date(1758000000 * 1000).toISOString())
    expect(plan.markVerified).toBeUndefined()
  })

  it('leaves a tenant with nothing waiting and no bank alone, and clears a stale flag', async () => {
    stripeWorld({ cards: [{ id: 'pm_card', last4: '4242' }] })
    const facts = await readStripeMethodFacts('cus_mock_tenant', { strict: true })
    expect(planBankBackfill(row({}), facts)).toEqual({})
    expect(planBankBackfill(row({ bank_pending_since: new Date() }), facts)).toEqual({ pendingSince: null })
  })

  it('turns bank-verified on when Stripe already holds a verified bank', async () => {
    stripeWorld({ banks: [{ id: 'pm_a', last4: '1111' }], defaultId: 'pm_a' })
    const plan = planBankBackfill(row({}), await readStripeMethodFacts('cus_mock_tenant', { strict: true }))
    expect(plan.markVerified).toEqual({ last4: '1111', routingLast4: '0000' })
  })

  it('with a card as the default, turning bank-verified on keeps the bank the row already names', async () => {
    stripeWorld({
      banks: [{ id: 'pm_new', last4: '2222' }, { id: 'pm_old', last4: '1111' }],
      cards: [{ id: 'pm_card', last4: '4242' }],
      defaultId: 'pm_card',
    })
    const plan = planBankBackfill({ ...row({}), bank_last4: '1111' },
      await readStripeMethodFacts('cus_mock_tenant', { strict: true }))
    expect(plan.markVerified).toEqual({ last4: '1111', routingLast4: '0000' })
  })

  it('reports, never undoes, a verified flag with no bank behind it', async () => {
    stripeWorld({})
    const plan = planBankBackfill(row({ ach_verified: true }), await readStripeMethodFacts('cus_mock_tenant', { strict: true }))
    expect(plan).toEqual({ warnVerifiedWithoutBank: true })
  })

  // Before the deploy, handle-return wrote the NACHA zero-tolerance block as
  // ach_verified = FALSE and nothing else; after it, every charge path reads
  // ach_suspended_at. The block is carried there first, so it never lifts.
  it('a block written before the deploy is carried into ach_suspended_at, so bank payments stay stopped', async () => {
    stripeWorld({ banks: [{ id: 'pm_a', last4: '1111' }], defaultId: 'pm_a' })
    const blockedAt = new Date('2026-09-20T15:00:00Z')
    const plan = planBankBackfill(
      { ...row({}), zero_tolerance_blocked_at: blockedAt, ach_suspended_at: null },
      await readStripeMethodFacts('cus_mock_tenant', { strict: true }))
    expect(plan).toEqual({ carrySuspension: blockedAt, markVerified: { last4: '1111', routingLast4: '0000' } })
  })

  it('a blocked tenant with no verified bank at Stripe still has the block carried', async () => {
    stripeWorld({})
    const blockedAt = new Date('2026-09-20T15:00:00Z')
    const plan = planBankBackfill(
      { ...row({}), zero_tolerance_blocked_at: blockedAt, ach_suspended_at: null },
      await readStripeMethodFacts('cus_mock_tenant', { strict: true }))
    expect(plan).toEqual({ carrySuspension: blockedAt })
  })

  it('a block already carried in its own column does not hold bank-verified back', async () => {
    stripeWorld({ banks: [{ id: 'pm_a', last4: '1111' }], defaultId: 'pm_a' })
    const blockedAt = new Date('2026-09-20T15:00:00Z')
    const plan = planBankBackfill(
      { ...row({}), zero_tolerance_blocked_at: blockedAt, ach_suspended_at: blockedAt },
      await readStripeMethodFacts('cus_mock_tenant', { strict: true }))
    expect(plan.markVerified).toEqual({ last4: '1111', routingLast4: '0000' })
    expect(plan.carrySuspension).toBeUndefined()
  })
})

// ─── Fix round 1: banks Stripe is checking, banks only, the default per bank ──
//
// A SetupIntent in 'processing' (Stripe checking the deposits the tenant
// entered) was "waiting" at confirm-setup but missing from the saved-methods
// list, the agent and the nudge — the S637 invisible bank again. Any payment
// method that is not a bank account was recorded as a verified bank unless it
// was a card. And a bank GAM had made the default before, left with no default
// at all, was not made the default again.

/** The setups Stripe lists for the customer: one being checked, plus any given. */
function withSetups(extra: any[]) {
  stripeMocks.setupIntentsList.mockImplementation(async () => ({ data: extra }))
}
const checkingSetup = (pmId: string, last4: string, pmType = 'us_bank_account') => ({
  id: `seti_${pmId}`, status: 'processing', created: 1759100000, next_action: null,
  payment_method: { id: pmId, type: pmType,
                    ...(pmType === 'us_bank_account'
                      ? { us_bank_account: { bank_name: 'Checking Bank', last4, routing_number: '221000000' } }
                      : { card: { brand: 'visa', last4 } }) },
})
const depositsSetup = (pmId: string, last4: string) => ({
  id: `seti_${pmId}`, status: 'requires_action', created: 1759100000,
  next_action: { type: 'verify_with_microdeposits', verify_with_microdeposits: { arrival_date: 1759200000 } },
  payment_method: { id: pmId, type: 'us_bank_account',
                    us_bank_account: { bank_name: 'New Bank', last4, routing_number: '221000000' } },
})

describe('S655 fix round 1: a bank whose deposits Stripe is checking', () => {
  it('is listed as verifying and never chargeable, with where it stands', async () => {
    const { token } = await bankAccount()
    stripeWorld({ banks: [{ id: 'pm_old', last4: '1111' }], defaultId: 'pm_old' })
    withSetups([checkingSetup('pm_checking', '5555'), depositsSetup('pm_deposits', '6666')])
    const res = await getMethods(token)
    expect(res.status).toBe(200)
    const by = (id: string) => res.body.data.find((m: any) => m.id === id)
    expect(by('pm_checking')).toMatchObject({
      type: 'ach', last4: '5555', verified: false, verifying: true, verificationStep: 'checking',
      chargeable: false, isDefault: false, canRemove: false,
    })
    expect(by('pm_checking').removeBlockedReason).toBe(
      'We are checking the verification you entered for this bank with our payment processor right now. ' +
      'You can remove it once that check finishes — try again later.')
    expect(by('pm_deposits')).toMatchObject({ verifying: true, verificationStep: 'deposits', canRemove: true })
    expect(by('pm_old')).toMatchObject({ verified: true, verificationStep: null, chargeable: true })
  })

  it('a card setup being processed is not listed as a bank', async () => {
    const { token } = await bankAccount()
    stripeWorld({ banks: [{ id: 'pm_old', last4: '1111' }] })
    withSetups([checkingSetup('pm_card_setup', '4242', 'card')])
    const res = await getMethods(token)
    expect(res.body.data.filter((m: any) => m.type === 'ach').map((m: any) => m.id)).toEqual(['pm_old'])
  })

  it('cannot be removed while Stripe checks it — nothing is canceled or detached', async () => {
    const { token } = await bankAccount()
    stripeWorld({ banks: [{ id: 'pm_old', last4: '1111' }] })
    withSetups([checkingSetup('pm_checking', '5555')])
    const res = await removeMethod(token, 'pm_checking')
    expect(res.status).toBe(409)
    expect(res.body.error).toMatch(/checking the verification you entered/)
    expect(stripeMocks.setupIntentsCancel).not.toHaveBeenCalled()
    expect(stripeMocks.paymentMethodsDetach).not.toHaveBeenCalled()
  })

  it('confirm-setup records it as a bank still verifying, the same as the list does', async () => {
    const { tenantId, token } = await bankAccount({ bankLast4: '1111' })
    stripeMocks.setupIntentsRetrieve.mockResolvedValue(
      { id: 'seti_x', status: 'processing', customer: 'cus_mock_tenant', payment_method: 'pm_x', next_action: null } as any)
    stripeMocks.paymentMethodsRetrieve.mockResolvedValue({
      id: 'pm_x', type: 'us_bank_account', customer: null,
      us_bank_account: { last4: '5555', routing_number: '221000000', bank_name: 'Checking Bank' },
    } as any)
    const res = await request(buildApp()).post('/api/stripe/tenant/confirm-setup')
      .set('Authorization', `Bearer ${token}`)
      .send({ setupIntentId: 'seti_x', paymentMethodId: 'pm_x' })
    expect(res.status).toBe(200)
    expect(res.body.verified).toBe(false)
    const { rows: [t] } = await db.query<any>(
      `SELECT ach_verified, bank_last4, bank_pending_since FROM tenants WHERE id=$1`, [tenantId])
    expect(t.ach_verified).toBe(true)              // the verified bank still pays
    expect(t.bank_last4).toBe('1111')              // and is still the one on file
    expect(t.bank_pending_since).not.toBeNull()
  })
})

describe('S655 fix round 1: only a bank account is recorded as a bank', () => {
  it('a payment method that is neither a bank nor a card is refused at the bank step and records nothing', async () => {
    const { tenantId, token } = await bankAccount({ bankLast4: null })
    await db.query(`UPDATE tenants SET ach_verified = FALSE WHERE id=$1`, [tenantId])
    stripeMocks.paymentMethodsRetrieve.mockResolvedValue(
      { id: 'pm_x', type: 'link', customer: 'cus_mock_tenant', link: { email: 'x@y.co' } } as any)
    const res = await request(buildApp()).post('/api/stripe/tenant/confirm-setup')
      .set('Authorization', `Bearer ${token}`)
      .send({ setupIntentId: 'seti_x', paymentMethodId: 'pm_x' })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('This step is for bank accounts. Add your bank account on the Payments page.')
    const { rows: [t] } = await db.query<any>(`SELECT ach_verified, bank_last4 FROM tenants WHERE id=$1`, [tenantId])
    expect(t).toEqual({ ach_verified: false, bank_last4: null })
    const { rows: log } = await db.query<any>(`SELECT 1 FROM ach_monitoring_log WHERE tenant_id=$1`, [tenantId])
    expect(log).toHaveLength(0)
    expect(stripeMocks.customersUpdate).not.toHaveBeenCalled()
  })

  it('a verification naming a payment method of another kind is refused as not a bank', async () => {
    const { tenantId } = await bankAccount({ bankLast4: null })
    await db.query(`UPDATE tenants SET ach_verified = FALSE WHERE id=$1`, [tenantId])
    stripeWorld({})
    stripeMocks.paymentMethodsRetrieve.mockResolvedValue(
      { id: 'pm_link', type: 'link', customer: 'cus_mock_tenant' } as any)
    const r = await recordVerifiedTenantBank({
      tenantId, customerId: 'cus_mock_tenant', paymentMethodId: 'pm_link', bank: null, makeDefault: 'first_time',
    })
    expect(r).toEqual({ tenantId, refused: 'not_a_bank', firstTime: false, madeDefault: false })
    const { rows: [t] } = await db.query<any>(`SELECT ach_verified FROM tenants WHERE id=$1`, [tenantId])
    expect(t.ach_verified).toBe(false)
    expect(stripeMocks.customersUpdate).not.toHaveBeenCalled()
  })
})

describe('S655 fix round 1: the default is decided per saved bank', () => {
  it('a bank GAM made the default before is made the default again when the customer has no default left', async () => {
    const { tenantId } = await bankAccount({ bankLast4: '2222' })
    const world = stripeWorld({ banks: [{ id: 'pm_new', last4: '2222' }], defaultId: null })
    world.metadata.set('pm_new', { gam_made_default_at: '2026-10-01T00:00:00.000Z' })
    const r = await recordVerifiedTenantBank({
      customerId: 'cus_mock_tenant', paymentMethodId: 'pm_new',
      bank: { last4: '2222', routing_number: '221000000' }, makeDefault: 'first_time',
    })
    expect(r).toMatchObject({ tenantId, refused: null, madeDefault: true })
    expect(world.defaultId).toBe('pm_new')
  })

  // The mark is written only once the default really changed, so a
  // verification whose default Stripe refused is made the default on the next
  // delivery instead of being taken for a choice the tenant made.
  it('a verification whose default Stripe refused is made the default on the next delivery', async () => {
    const { tenantId } = await bankAccount({ bankLast4: '1111' })
    const world = stripeWorld({ banks: [{ id: 'pm_old', last4: '1111' }, { id: 'pm_new', last4: '2222' }], defaultId: 'pm_old' })
    const verify = () => recordVerifiedTenantBank({
      customerId: 'cus_mock_tenant', paymentMethodId: 'pm_new',
      bank: { last4: '2222', routing_number: '221000000' }, makeDefault: 'first_time',
    })
    stripeMocks.customersUpdate.mockRejectedValueOnce(new Error('stripe down'))
    expect(await verify()).toMatchObject({ madeDefault: false })
    expect(world.metadata.get('pm_new')).toBeUndefined()
    expect(await verify()).toEqual({ tenantId, refused: null, firstTime: false, madeDefault: true })
    expect(world.defaultId).toBe('pm_new')
    expect(world.metadata.get('pm_new')?.gam_made_default_at).toEqual(expect.any(String))
    const { rows: [t] } = await db.query<any>(`SELECT bank_last4 FROM tenants WHERE id=$1`, [tenantId])
    expect(t.bank_last4).toBe('2222')
  })

  it('verifying a bank while another still waits keeps the waiting flag and the reminder count for that one', async () => {
    const { tenantId } = await bankAccount({ bankLast4: '1111' })
    await db.query(
      `UPDATE tenants SET bank_pending_since = NOW() - interval '5 days', bank_verify_nudge_count = 2 WHERE id=$1`,
      [tenantId])
    stripeWorld({ banks: [{ id: 'pm_old', last4: '1111' }, { id: 'pm_new', last4: '2222' }],
                  waiting: [{ siId: 'seti_other', pmId: 'pm_other', last4: '3333' }], defaultId: 'pm_old' })
    await recordVerifiedTenantBank({
      customerId: 'cus_mock_tenant', paymentMethodId: 'pm_new',
      bank: { last4: '2222', routing_number: '221000000' }, makeDefault: 'first_time',
    })
    const { rows: [t] } = await db.query<any>(
      `SELECT bank_last4, bank_pending_since IS NOT NULL AS waiting, bank_verify_nudge_count FROM tenants WHERE id=$1`,
      [tenantId])
    expect(t).toEqual({ bank_last4: '2222', waiting: true, bank_verify_nudge_count: 2 })
  })
})

// ─── Fix round 2: an unknown answer about the other banks changes nothing ────
//
// recordVerifiedTenantBank read the other banks with the non-strict lookup.
// When Stripe's setup list failed for a moment, the waiting list came back
// empty, "nothing else waits" was taken as fact, and the flag and reminder
// count of a bank still waiting on its deposits were wiped — that tenant was
// never reminded again. And a bank whose deposits Stripe is checking was told
// to "finish the verification" it had already finished.

describe('S655 fix round 2: the waiting flag when Stripe cannot say what else waits', () => {
  const chaseState = async (tenantId: string) => (await db.query<any>(
    `SELECT ach_verified, bank_last4, bank_pending_since, bank_verify_nudge_count, bank_verify_nudge_at
       FROM tenants WHERE id=$1`, [tenantId])).rows[0]
  const verifyNew = () => recordVerifiedTenantBank({
    customerId: 'cus_mock_tenant', paymentMethodId: 'pm_new',
    bank: { last4: '2222', routing_number: '221000000' }, makeDefault: 'first_time',
  })
  /** A tenant with a verified bank, a new one about to verify, and two reminders sent. */
  const chasedAccount = async () => {
    const { tenantId } = await bankAccount({ bankLast4: '1111' })
    await db.query(
      `UPDATE tenants SET bank_pending_since = NOW() - interval '6 days', bank_verify_nudge_count = 2,
              bank_verify_nudge_at = NOW() - interval '4 days' WHERE id=$1`, [tenantId])
    return { tenantId, before: await chaseState(tenantId) }
  }
  const setupListFails = () =>
    stripeMocks.setupIntentsList.mockImplementation(async () => { throw new Error('stripe hiccup') })

  it('a verification while the setup list cannot be read leaves another bank\'s waiting flag and reminder count alone', async () => {
    const { tenantId, before } = await chasedAccount()
    stripeWorld({ banks: [{ id: 'pm_old', last4: '1111' }, { id: 'pm_new', last4: '2222' }],
                  waiting: [{ siId: 'seti_other', pmId: 'pm_other', last4: '3333' }], defaultId: 'pm_old' })
    const healthy = stripeMocks.setupIntentsList.getMockImplementation()!
    setupListFails()

    const r = await verifyNew()
    expect(r).toMatchObject({ tenantId, refused: null, madeDefault: true })
    expect(await chaseState(tenantId)).toEqual({
      ach_verified: true,
      bank_last4: '2222',                                   // the new bank is verified and on file
      bank_pending_since: before.bank_pending_since,        // the other bank still waits
      bank_verify_nudge_count: 2,
      bank_verify_nudge_at: before.bank_verify_nudge_at,
    })

    // Stripe answers again: the bank still waiting is chased as before.
    stripeMocks.setupIntentsList.mockImplementation(healthy)
    const nudge = await sendBankVerificationNudges()
    expect(nudge.sent).toBe(1)
    expect((await chaseState(tenantId)).bank_verify_nudge_count).toBe(3)
  })

  // 10/3: a tenant with NO flag yet (the other bank's confirm never reached the
  // server and the nudge has not run) must not drop off the reminder list.
  it('a verification while the setup list cannot be read keeps a tenant with no flag on the reminder list', async () => {
    const { tenantId } = await bankAccount({ bankLast4: '1111' })
    await db.query(`UPDATE tenants SET bank_pending_since = NULL, bank_verify_nudge_count = 0, bank_verify_nudge_at = NULL WHERE id=$1`, [tenantId])
    stripeWorld({ banks: [{ id: 'pm_old', last4: '1111' }, { id: 'pm_new', last4: '2222' }],
                  waiting: [{ siId: 'seti_other', pmId: 'pm_other', last4: '3333' }], defaultId: 'pm_old' })
    const healthy = stripeMocks.setupIntentsList.getMockImplementation()!
    setupListFails()
    await verifyNew()
    expect((await chaseState(tenantId)).bank_pending_since).not.toBeNull()

    stripeMocks.setupIntentsList.mockImplementation(healthy)
    await db.query(`UPDATE tenants SET bank_pending_since = NOW() - interval '6 days' WHERE id=$1`, [tenantId])
    const nudge = await sendBankVerificationNudges()
    expect(nudge.sent).toBe(1)
  })

  it('when nothing else was waiting after all, the nudge clears the kept flag and starts the count over without an email', async () => {
    const { tenantId } = await chasedAccount()
    stripeWorld({ banks: [{ id: 'pm_old', last4: '1111' }, { id: 'pm_new', last4: '2222' }], defaultId: 'pm_old' })
    const healthy = stripeMocks.setupIntentsList.getMockImplementation()!
    setupListFails()
    await verifyNew()
    expect((await chaseState(tenantId)).bank_verify_nudge_count).toBe(2)   // unknown: nothing changed

    stripeMocks.setupIntentsList.mockImplementation(healthy)
    const nudge = await sendBankVerificationNudges()
    expect(nudge).toMatchObject({ sent: 0, skippedNotStalled: 1 })
    expect(await chaseState(tenantId)).toMatchObject({
      bank_pending_since: null, bank_verify_nudge_count: 0, bank_verify_nudge_at: null,
    })
  })

  it('a verification with Stripe answering and no other bank waiting ends the chase', async () => {
    const { tenantId } = await chasedAccount()
    stripeWorld({ banks: [{ id: 'pm_old', last4: '1111' }, { id: 'pm_new', last4: '2222' }], defaultId: 'pm_old' })
    await verifyNew()
    expect(await chaseState(tenantId)).toMatchObject({
      ach_verified: true, bank_last4: '2222',
      bank_pending_since: null, bank_verify_nudge_count: 0, bank_verify_nudge_at: null,
    })
  })

  it('a verification while Stripe cannot list the saved methods at all leaves the flag and the count alone', async () => {
    const { tenantId, before } = await chasedAccount()
    stripeWorld({ banks: [{ id: 'pm_old', last4: '1111' }, { id: 'pm_new', last4: '2222' }], defaultId: 'pm_old' })
    stripeMocks.paymentMethodsList.mockImplementation(async () => { throw new Error('stripe down') })
    const r = await verifyNew()
    expect(r).toMatchObject({ tenantId, refused: null })
    expect(await chaseState(tenantId)).toMatchObject({
      ach_verified: true,
      bank_pending_since: before.bank_pending_since,
      bank_verify_nudge_count: 2,
      bank_verify_nudge_at: before.bank_verify_nudge_at,
    })
  })
})

describe('S655 fix round 2: a bank Stripe is checking is never sent back for a step already taken', () => {
  it('a bank Stripe is checking cannot be made the default, and the tenant is told the check is under way', async () => {
    const { token } = await bankAccount()
    const world = stripeWorld({ banks: [{ id: 'pm_old', last4: '1111' }], defaultId: 'pm_old' })
    withSetups([checkingSetup('pm_checking', '5555')])
    const res = await request(buildApp()).patch('/api/stripe/tenant/default-payment-method')
      .set('Authorization', `Bearer ${token}`).send({ paymentMethodId: 'pm_checking' })
    expect(res.status).toBe(409)
    expect(res.body.error).toBe(DEFAULT_BLOCKED_WHILE_CHECKING)
    expect(res.body.error).toBe(
      'We are still checking the verification you entered for this bank. ' +
      'You can make it your default once that check finishes.')
    expect(res.body.error).not.toMatch(/Finish the verification/)
    expect(stripeMocks.customersUpdate).not.toHaveBeenCalled()
    expect(world.defaultId).toBe('pm_old')
  })

  it('a bank still waiting on its deposits is still told to finish the verification', async () => {
    const { token } = await bankAccount()
    stripeWorld({ banks: [{ id: 'pm_old', last4: '1111' }], defaultId: 'pm_old' })
    withSetups([depositsSetup('pm_deposits', '6666')])
    const res = await request(buildApp()).patch('/api/stripe/tenant/default-payment-method')
      .set('Authorization', `Bearer ${token}`).send({ paymentMethodId: 'pm_deposits' })
    expect(res.status).toBe(409)
    expect(res.body.error).toBe(DEFAULT_BLOCKED_UNTIL_VERIFIED)
  })

  it('confirm-setup for a bank Stripe is checking says the verification was received, not that a deposit was sent', async () => {
    const { tenantId, token } = await bankAccount({ bankLast4: '1111' })
    stripeMocks.setupIntentsRetrieve.mockResolvedValue(
      { id: 'seti_x', status: 'processing', customer: 'cus_mock_tenant', payment_method: 'pm_x', next_action: null } as any)
    stripeMocks.paymentMethodsRetrieve.mockResolvedValue({
      id: 'pm_x', type: 'us_bank_account', customer: null,
      us_bank_account: { last4: '5555', routing_number: '221000000', bank_name: 'Checking Bank' },
    } as any)
    const res = await request(buildApp()).post('/api/stripe/tenant/confirm-setup')
      .set('Authorization', `Bearer ${token}`)
      .send({ setupIntentId: 'seti_x', paymentMethodId: 'pm_x' })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({
      success: true, verified: false, status: 'processing', verificationStep: 'checking',
      bankName: 'Checking Bank', bankLast4: '5555', microdepositType: null, arrivalDate: null,
      message: BANK_CHECK_RECEIVED,
    })
    expect(res.body.message).not.toMatch(/We sent|come back here/)
    // Still recorded as a bank on its way, beside the verified one.
    const { rows: [t] } = await db.query<any>(
      `SELECT ach_verified, bank_last4, bank_pending_since FROM tenants WHERE id=$1`, [tenantId])
    expect(t.ach_verified).toBe(true)
    expect(t.bank_last4).toBe('1111')
    expect(t.bank_pending_since).not.toBeNull()
  })

  it('confirm-setup for a bank waiting on its deposits still explains the deposit', async () => {
    const { token } = await bankAccount({ bankLast4: '1111' })
    stripeMocks.setupIntentsRetrieve.mockResolvedValue({
      id: 'seti_x', status: 'requires_action', customer: 'cus_mock_tenant', payment_method: 'pm_x',
      next_action: { type: 'verify_with_microdeposits',
                     verify_with_microdeposits: { microdeposit_type: 'amounts', arrival_date: 1759200000 } },
    } as any)
    stripeMocks.paymentMethodsRetrieve.mockResolvedValue({
      id: 'pm_x', type: 'us_bank_account', customer: null,
      us_bank_account: { last4: '5555', routing_number: '221000000', bank_name: 'New Bank' },
    } as any)
    const res = await request(buildApp()).post('/api/stripe/tenant/confirm-setup')
      .set('Authorization', `Bearer ${token}`)
      .send({ setupIntentId: 'seti_x', paymentMethodId: 'pm_x' })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({
      verified: false, status: 'requires_action', verificationStep: 'deposits',
      microdepositType: 'amounts', arrivalDate: 1759200000,
    })
    expect(res.body.message).toMatch(/two small deposits/)
  })
})
