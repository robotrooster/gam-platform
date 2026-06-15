/**
 * S510 — public card-update flow coverage.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import bcrypt from 'bcryptjs'
import { randomUUID } from 'crypto'

const { customerCreateMock, setupIntentCreateMock, setupIntentRetrieveMock,
        paymentMethodRetrieveMock, paymentMethodDetachMock, customerUpdateMock
} = vi.hoisted(() => ({
  customerCreateMock: vi.fn(),
  customerUpdateMock: vi.fn(),
  setupIntentCreateMock: vi.fn(),
  setupIntentRetrieveMock: vi.fn(),
  paymentMethodRetrieveMock: vi.fn(),
  paymentMethodDetachMock: vi.fn(),
}))

vi.mock('stripe', () => {
  const Stripe: any = function () {
    return {
      customers: { create: customerCreateMock, update: customerUpdateMock },
      setupIntents: { create: setupIntentCreateMock, retrieve: setupIntentRetrieveMock },
      paymentMethods: { retrieve: paymentMethodRetrieveMock, detach: paymentMethodDetachMock },
    }
  }
  Stripe.default = Stripe
  return { default: Stripe }
})

import { db } from '../db'
import { cleanupAllSchema } from '../test/dbHelpers'
import { publicCardUpdateRouter } from './publicCardUpdate'
import { errorHandler } from '../middleware/errorHandler'

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/public', publicCardUpdateRouter)
  app.use(errorHandler)
  return app
}

beforeEach(async () => {
  await cleanupAllSchema()
  customerCreateMock.mockReset()
  customerUpdateMock.mockReset().mockResolvedValue({})
  setupIntentCreateMock.mockReset()
  setupIntentRetrieveMock.mockReset()
  paymentMethodRetrieveMock.mockReset()
  paymentMethodDetachMock.mockReset().mockResolvedValue({})
  process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'sk_test_dummy'
  process.env.STRIPE_PUBLISHABLE_KEY = 'pk_test_dummy'
})

interface Fixture {
  businessId: string
  customerId: string
  token: string
}

async function seed(opts: { existingStripeCustomerId?: string | null } = {}): Promise<Fixture> {
  // `?? 'cus_existing'` would replace an explicit `null` with the
  // default. Use `in` to keep null when explicitly passed.
  const stripeCustomerId = 'existingStripeCustomerId' in opts
    ? opts.existingStripeCustomerId
    : 'cus_existing'
  const hash = await bcrypt.hash('pw', 12)
  const email = `o-${randomUUID()}@test.dev`
  const { rows: [u] } = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
     VALUES ($1, $2, 'business_owner', 'B', 'O', TRUE) RETURNING id`,
    [email, hash])
  const { rows: [b] } = await db.query<{ id: string }>(
    `INSERT INTO businesses (owner_user_id, name, business_type, email, enabled_features)
     VALUES ($1, 'Test Shop', 'other', $2, ARRAY['customers','staff']::text[])
     RETURNING id`, [u.id, email])
  const { rows: [c] } = await db.query<{ id: string }>(
    `INSERT INTO business_customers
       (business_id, customer_type, first_name, last_name,
        email, phone, street1, city, state, zip,
        stripe_customer_id, default_payment_method_id,
        payment_method_brand, payment_method_last4)
     VALUES ($1, 'individual', 'Jane', 'Doe', 'jane@test.dev', '555-0100',
             '100 Main', 'Phoenix', 'AZ', '85001',
             $2, 'pm_old', 'visa', '0001')
     RETURNING id`,
    [b.id, stripeCustomerId])
  const token = randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '')
  const expires = new Date(Date.now() + 24 * 3600 * 1000).toISOString()
  await db.query(
    `INSERT INTO business_customer_payment_update_tokens
       (token, business_id, customer_id, expires_at)
     VALUES ($1, $2, $3, $4)`,
    [token, b.id, c.id, expires])
  return { businessId: b.id, customerId: c.id, token }
}

// ═══════════════════════════════════════════════════════════════
//  GET /update-payment/:token
// ═══════════════════════════════════════════════════════════════

describe('GET /update-payment/:token', () => {
  it('returns customer + existing card + SetupIntent client_secret', async () => {
    const f = await seed()
    setupIntentCreateMock.mockResolvedValue({
      id: 'si_test', client_secret: 'cs_test_secret',
    })
    const res = await request(buildApp())
      .get(`/api/public/update-payment/${f.token}`)
    expect(res.status).toBe(200)
    expect(res.body.data.business_name).toBe('Test Shop')
    expect(res.body.data.existing_card.brand).toBe('visa')
    expect(res.body.data.existing_card.last4).toBe('0001')
    expect(res.body.data.client_secret).toBe('cs_test_secret')
    expect(res.body.data.publishable_key).toBe('pk_test_dummy')
    expect(setupIntentCreateMock).toHaveBeenCalledWith(expect.objectContaining({
      customer: 'cus_existing',
      usage: 'off_session',
    }))
  })

  it('creates a Stripe Customer when business_customer has none', async () => {
    const f = await seed({ existingStripeCustomerId: null })
    customerCreateMock.mockResolvedValue({ id: 'cus_new' })
    setupIntentCreateMock.mockResolvedValue({
      id: 'si_test', client_secret: 'cs_test_secret',
    })
    const res = await request(buildApp())
      .get(`/api/public/update-payment/${f.token}`)
    expect(res.status).toBe(200)
    expect(customerCreateMock).toHaveBeenCalledTimes(1)
    // Customer id is persisted on the row.
    const { rows: [c] } = await db.query<{ stripe_customer_id: string }>(
      `SELECT stripe_customer_id FROM business_customers WHERE id = $1`,
      [f.customerId])
    expect(c.stripe_customer_id).toBe('cus_new')
  })

  it('expired token → 410', async () => {
    const f = await seed()
    await db.query(
      `UPDATE business_customer_payment_update_tokens
          SET expires_at = NOW() - INTERVAL '1 hour' WHERE token = $1`,
      [f.token])
    const res = await request(buildApp())
      .get(`/api/public/update-payment/${f.token}`)
    expect(res.status).toBe(410)
  })

  it('used token → 410', async () => {
    const f = await seed()
    await db.query(
      `UPDATE business_customer_payment_update_tokens
          SET used_at = NOW() WHERE token = $1`, [f.token])
    const res = await request(buildApp())
      .get(`/api/public/update-payment/${f.token}`)
    expect(res.status).toBe(410)
  })

  it('unknown token → 404', async () => {
    const res = await request(buildApp())
      .get('/api/public/update-payment/notarealtoken')
    expect(res.status).toBe(404)
  })
})

// ═══════════════════════════════════════════════════════════════
//  POST /update-payment/:token/confirm
// ═══════════════════════════════════════════════════════════════

describe('POST /update-payment/:token/confirm', () => {
  it('happy: SetupIntent succeeded → persists new PM, retires old, marks used', async () => {
    const f = await seed()
    setupIntentRetrieveMock.mockResolvedValue({
      id: 'si_test', status: 'succeeded',
      payment_method: 'pm_new',
      customer: 'cus_existing',
      metadata: { gam_business_customer_id: f.customerId },
    })
    paymentMethodRetrieveMock.mockResolvedValue({
      id: 'pm_new',
      customer: 'cus_existing',
      card: { brand: 'mastercard', last4: '4444', exp_month: 12, exp_year: 2030 },
    })

    const res = await request(buildApp())
      .post(`/api/public/update-payment/${f.token}/confirm`)
      .send({ setupIntentId: 'si_test' })
    expect(res.status).toBe(200)
    expect(res.body.data.card_brand).toBe('mastercard')

    // business_customers updated
    const { rows: [c] } = await db.query<{
      default_payment_method_id: string;
      payment_method_brand: string;
      payment_method_last4: string;
    }>(
      `SELECT default_payment_method_id, payment_method_brand, payment_method_last4
         FROM business_customers WHERE id = $1`, [f.customerId])
    expect(c.default_payment_method_id).toBe('pm_new')
    expect(c.payment_method_brand).toBe('mastercard')
    expect(c.payment_method_last4).toBe('4444')

    // Token marked used
    const { rows: [tok] } = await db.query<{ used_at: string | null }>(
      `SELECT used_at FROM business_customer_payment_update_tokens WHERE token = $1`,
      [f.token])
    expect(tok.used_at).not.toBeNull()

    // Old PM detached
    expect(paymentMethodDetachMock).toHaveBeenCalledWith('pm_old')

    // Stripe Customer's default PM updated
    expect(customerUpdateMock).toHaveBeenCalledWith('cus_existing', expect.objectContaining({
      invoice_settings: { default_payment_method: 'pm_new' },
    }))
  })

  it('SetupIntent customer mismatch → 403', async () => {
    const f = await seed()
    setupIntentRetrieveMock.mockResolvedValue({
      id: 'si_test', status: 'succeeded',
      payment_method: 'pm_new',
      customer: 'cus_existing',
      metadata: { gam_business_customer_id: 'wrong-id' },
    })
    const res = await request(buildApp())
      .post(`/api/public/update-payment/${f.token}/confirm`)
      .send({ setupIntentId: 'si_test' })
    expect(res.status).toBe(403)
  })

  it('SetupIntent not succeeded → 400', async () => {
    const f = await seed()
    setupIntentRetrieveMock.mockResolvedValue({
      id: 'si_test', status: 'requires_action',
      metadata: { gam_business_customer_id: f.customerId },
    })
    const res = await request(buildApp())
      .post(`/api/public/update-payment/${f.token}/confirm`)
      .send({ setupIntentId: 'si_test' })
    expect(res.status).toBe(400)
  })

  it('used token cannot be confirmed', async () => {
    const f = await seed()
    await db.query(
      `UPDATE business_customer_payment_update_tokens
          SET used_at = NOW() WHERE token = $1`, [f.token])
    const res = await request(buildApp())
      .post(`/api/public/update-payment/${f.token}/confirm`)
      .send({ setupIntentId: 'si_test' })
    expect(res.status).toBe(410)
  })

  it('PM detach failure does not break the swap', async () => {
    const f = await seed()
    setupIntentRetrieveMock.mockResolvedValue({
      id: 'si_test', status: 'succeeded',
      payment_method: 'pm_new', customer: 'cus_existing',
      metadata: { gam_business_customer_id: f.customerId },
    })
    paymentMethodRetrieveMock.mockResolvedValue({
      id: 'pm_new', customer: 'cus_existing',
      card: { brand: 'visa', last4: '4242', exp_month: 1, exp_year: 2030 },
    })
    paymentMethodDetachMock.mockRejectedValue(new Error('Stripe detach down'))

    const res = await request(buildApp())
      .post(`/api/public/update-payment/${f.token}/confirm`)
      .send({ setupIntentId: 'si_test' })
    expect(res.status).toBe(200)
  })
})
