/**
 * posCustomerOnboarding.ts gap-close slice — S405. Closes the file
 * at 3/3 (100%).
 *
 * Covered routes (3):
 *   - GET  /api/pos-customer-onboarding/:token
 *   - POST /api/pos-customer-onboarding/:token/start
 *   - POST /api/pos-customer-onboarding/:token/complete
 *
 * Public token-gated flow (recipient is a non-tenant
 * pos_customer; no GAM account). Stripe is mocked; the slice
 * verifies token state machine + Stripe call shape + DB writes.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('stripe', () => {
  const customersCreate = vi.fn(async (args: any) => ({
    id: 'cus_mock_' + Math.random().toString(36).slice(2, 8),
    email: args.email,
  }))
  const customersUpdate = vi.fn(async () => ({}))
  const setupIntentsCreate = vi.fn(async () => ({
    id: 'seti_mock', client_secret: 'seti_mock_secret', status: 'requires_payment_method',
  }))
  const setupIntentsRetrieve = vi.fn(async () => ({
    id: 'seti_mock', client_secret: 'seti_mock_secret',
    status: 'succeeded', customer: 'cus_mock_abc',
    payment_method: { id: 'pm_mock', us_bank_account: { last4: '6789' } },
  }))
  function FakeStripe(this: any) {
    this.customers = { create: customersCreate, update: customersUpdate }
    this.setupIntents = { create: setupIntentsCreate, retrieve: setupIntentsRetrieve }
  }
  ;(FakeStripe as any).__mocks = {
    customersCreate, customersUpdate, setupIntentsCreate, setupIntentsRetrieve,
  }
  return { default: FakeStripe }
})

import express from 'express'
import request from 'supertest'
import { randomUUID } from 'crypto'
import Stripe from 'stripe'
import { db } from '../db'
import { cleanupAllSchema, seedLandlord } from '../test/dbHelpers'
import { posCustomerOnboardingRouter } from './posCustomerOnboarding'
import { errorHandler } from '../middleware/errorHandler'

function buildApp() {
  const app = express()
  app.use(express.json({ limit: '2mb' }))
  app.use('/api/pos-customer-onboarding', posCustomerOnboardingRouter)
  app.use(errorHandler)
  return app
}

const stripeMocks = (Stripe as any).__mocks as {
  customersCreate:      ReturnType<typeof vi.fn>
  customersUpdate:      ReturnType<typeof vi.fn>
  setupIntentsCreate:   ReturnType<typeof vi.fn>
  setupIntentsRetrieve: ReturnType<typeof vi.fn>
}

beforeEach(async () => {
  await cleanupAllSchema()
  process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'sk_test_mock'
  stripeMocks.customersCreate.mockClear()
  stripeMocks.customersUpdate.mockClear()
  stripeMocks.setupIntentsCreate.mockClear()
  stripeMocks.setupIntentsRetrieve.mockClear()
  // Reset retrieve to the succeeded default so each test starts clean.
  stripeMocks.setupIntentsRetrieve.mockResolvedValue({
    id: 'seti_mock', client_secret: 'seti_mock_secret',
    status: 'succeeded', customer: 'cus_mock_abc',
    payment_method: { id: 'pm_mock', us_bank_account: { last4: '6789' } },
  } as any)
  stripeMocks.setupIntentsCreate.mockResolvedValue({
    id: 'seti_mock', client_secret: 'seti_mock_secret',
    status: 'requires_payment_method',
  } as any)
})

interface Fixture {
  landlordId:  string
  posCustId:   string
  token:       string
  invitationId: string
}

async function seed(opts: {
  status?: 'sent' | 'in_progress' | 'accepted' | 'cancelled'
  expired?: boolean
  setupIntentId?: string | null
} = {}): Promise<Fixture> {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const { userId: aUid, landlordId } = await seedLandlord(c)
    await c.query(`UPDATE landlords SET business_name='Acme POS' WHERE id=$1`, [landlordId])
    const { rows: [{ id: posCustId }] } = await c.query<{ id: string }>(
      `INSERT INTO pos_customers (landlord_id, first_name, last_name, email)
       VALUES ($1, 'Pat', 'Customer', 'pat@example.com') RETURNING id`,
      [landlordId])
    const token = randomUUID()
    const expiresAt = opts.expired
      ? new Date(Date.now() - 24*60*60*1000)
      : new Date(Date.now() + 7*24*60*60*1000)
    const { rows: [{ id: invitationId }] } = await c.query<{ id: string }>(
      `INSERT INTO pos_customer_invitations
         (token, pos_customer_id, landlord_id, status, setup_intent_id, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [token, posCustId, landlordId, opts.status ?? 'sent', opts.setupIntentId ?? null, expiresAt])
    await c.query('COMMIT')
    return { landlordId, posCustId, token, invitationId }
  } catch (e) { await c.query('ROLLBACK'); throw e }
  finally { c.release() }
}

// ─── GET /api/pos-customer-onboarding/:token ─────────────────

describe('GET /api/pos-customer-onboarding/:token', () => {
  it('happy: returns preview shape with merchant + customer names', async () => {
    const f = await seed()
    const res = await request(buildApp()).get(`/api/pos-customer-onboarding/${f.token}`)
    expect(res.status).toBe(200)
    expect(res.body.data).toMatchObject({
      customer_first_name: 'Pat',
      customer_last_name:  'Customer',
      customer_email:      'pat@example.com',
      merchant_name:       'Acme POS',
      status:              'sent',
    })
    expect(res.body.data.expires_at).toBeTruthy()
  })

  it('unknown token → 404', async () => {
    const res = await request(buildApp()).get(`/api/pos-customer-onboarding/${randomUUID()}`)
    expect(res.status).toBe(404)
  })

  it('cancelled invitation → 409', async () => {
    const f = await seed({ status: 'cancelled' })
    const res = await request(buildApp()).get(`/api/pos-customer-onboarding/${f.token}`)
    expect(res.status).toBe(409)
  })

  it('already accepted → 409', async () => {
    const f = await seed({ status: 'accepted' })
    const res = await request(buildApp()).get(`/api/pos-customer-onboarding/${f.token}`)
    expect(res.status).toBe(409)
  })

  it('expired → 410', async () => {
    const f = await seed({ expired: true })
    const res = await request(buildApp()).get(`/api/pos-customer-onboarding/${f.token}`)
    expect(res.status).toBe(410)
  })

  it('falls back to first_name+last_name when landlord business_name is null', async () => {
    const f = await seed()
    await db.query(`UPDATE landlords SET business_name=NULL WHERE id=$1`, [f.landlordId])
    await db.query(
      `UPDATE users SET first_name='John', last_name='Owner' WHERE id=(
        SELECT user_id FROM landlords WHERE id=$1)`, [f.landlordId])
    const res = await request(buildApp()).get(`/api/pos-customer-onboarding/${f.token}`)
    expect(res.status).toBe(200)
    expect(res.body.data.merchant_name).toBe('John Owner')
  })
})

// ─── POST /api/pos-customer-onboarding/:token/start ─────────

describe('POST /api/pos-customer-onboarding/:token/start', () => {
  it('happy: creates Stripe customer + SetupIntent, flips status in_progress', async () => {
    const f = await seed()
    const res = await request(buildApp())
      .post(`/api/pos-customer-onboarding/${f.token}/start`)
    expect(res.status).toBe(200)
    expect(res.body.data.setup_intent_id).toBe('seti_mock')
    expect(res.body.data.client_secret).toBe('seti_mock_secret')
    expect(res.body.data.stripe_customer_id).toMatch(/^cus_mock_/)
    expect(stripeMocks.customersCreate).toHaveBeenCalledTimes(1)
    expect(stripeMocks.setupIntentsCreate).toHaveBeenCalledTimes(1)
    // Verify DB writes
    const { rows: [inv] } = await db.query<any>(
      `SELECT status, setup_intent_id FROM pos_customer_invitations WHERE id=$1`,
      [f.invitationId])
    expect(inv.status).toBe('in_progress')
    expect(inv.setup_intent_id).toBe('seti_mock')
    const { rows: [pc] } = await db.query<any>(
      `SELECT stripe_customer_id FROM pos_customers WHERE id=$1`,
      [f.posCustId])
    expect(pc.stripe_customer_id).toMatch(/^cus_mock_/)
  })

  it('reuses existing Stripe customer when stripe_customer_id is already stamped', async () => {
    const f = await seed()
    await db.query(
      `UPDATE pos_customers SET stripe_customer_id='cus_existing_999' WHERE id=$1`,
      [f.posCustId])
    const res = await request(buildApp())
      .post(`/api/pos-customer-onboarding/${f.token}/start`)
    expect(res.status).toBe(200)
    expect(res.body.data.stripe_customer_id).toBe('cus_existing_999')
    expect(stripeMocks.customersCreate).not.toHaveBeenCalled()
    expect(stripeMocks.setupIntentsCreate).toHaveBeenCalledWith(
      expect.objectContaining({ customer: 'cus_existing_999' }))
  })

  it('reuses existing SetupIntent when invitation already has one (still pending)', async () => {
    const f = await seed({ status: 'in_progress', setupIntentId: 'seti_existing' })
    stripeMocks.setupIntentsRetrieve.mockResolvedValueOnce({
      id: 'seti_existing', client_secret: 'seti_existing_secret',
      status: 'requires_payment_method',
    } as any)
    const res = await request(buildApp())
      .post(`/api/pos-customer-onboarding/${f.token}/start`)
    expect(res.status).toBe(200)
    expect(res.body.data.setup_intent_id).toBe('seti_existing')
    expect(res.body.data.client_secret).toBe('seti_existing_secret')
    expect(stripeMocks.setupIntentsCreate).not.toHaveBeenCalled()
  })

  it('creates new SetupIntent when prior one was canceled', async () => {
    const f = await seed({ status: 'in_progress', setupIntentId: 'seti_stale' })
    stripeMocks.setupIntentsRetrieve.mockResolvedValueOnce({
      id: 'seti_stale', client_secret: null, status: 'canceled',
    } as any)
    const res = await request(buildApp())
      .post(`/api/pos-customer-onboarding/${f.token}/start`)
    expect(res.status).toBe(200)
    expect(stripeMocks.setupIntentsCreate).toHaveBeenCalledTimes(1)
    expect(res.body.data.setup_intent_id).toBe('seti_mock')
  })

  it('SetupIntent created with Financial Connections + us_bank_account params', async () => {
    const f = await seed()
    await request(buildApp())
      .post(`/api/pos-customer-onboarding/${f.token}/start`)
    const call = stripeMocks.setupIntentsCreate.mock.calls[0][0] as any
    expect(call.payment_method_types).toEqual(['us_bank_account'])
    expect(call.payment_method_options.us_bank_account).toMatchObject({
      financial_connections: { permissions: ['payment_method', 'balances'] },
      verification_method:   'instant',
    })
    // GAM-attribution metadata is set.
    expect(call.metadata.gam_purpose).toBe('pos_customer_ach_onboarding')
    expect(call.metadata.gam_pos_customer_id).toBe(f.posCustId)
    expect(call.metadata.gam_invitation_id).toBe(f.invitationId)
  })

  it('unknown token → 404', async () => {
    const res = await request(buildApp())
      .post(`/api/pos-customer-onboarding/${randomUUID()}/start`)
    expect(res.status).toBe(404)
  })

  it('cancelled → 409', async () => {
    const f = await seed({ status: 'cancelled' })
    const res = await request(buildApp())
      .post(`/api/pos-customer-onboarding/${f.token}/start`)
    expect(res.status).toBe(409)
  })

  it('accepted → 409', async () => {
    const f = await seed({ status: 'accepted' })
    const res = await request(buildApp())
      .post(`/api/pos-customer-onboarding/${f.token}/start`)
    expect(res.status).toBe(409)
  })

  it('expired → 410', async () => {
    const f = await seed({ expired: true })
    const res = await request(buildApp())
      .post(`/api/pos-customer-onboarding/${f.token}/start`)
    expect(res.status).toBe(410)
  })
})

// ─── POST /api/pos-customer-onboarding/:token/complete ──────

describe('POST /api/pos-customer-onboarding/:token/complete', () => {
  it('happy: stamps ach_verified=TRUE + bank_last4 + accepted', async () => {
    const f = await seed({ status: 'in_progress', setupIntentId: 'seti_done' })
    const res = await request(buildApp())
      .post(`/api/pos-customer-onboarding/${f.token}/complete`)
    expect(res.status).toBe(200)
    expect(res.body.data).toEqual({ status: 'accepted', bank_last4: '6789' })
    const { rows: [pc] } = await db.query<any>(
      `SELECT ach_verified, bank_last4 FROM pos_customers WHERE id=$1`,
      [f.posCustId])
    expect(pc.ach_verified).toBe(true)
    expect(pc.bank_last4).toBe('6789')
    const { rows: [inv] } = await db.query<any>(
      `SELECT status, accepted_at FROM pos_customer_invitations WHERE id=$1`,
      [f.invitationId])
    expect(inv.status).toBe('accepted')
    expect(inv.accepted_at).toBeTruthy()
  })

  it('sets the verified PM as the customer\'s default_payment_method', async () => {
    const f = await seed({ status: 'in_progress', setupIntentId: 'seti_done' })
    await request(buildApp())
      .post(`/api/pos-customer-onboarding/${f.token}/complete`)
    expect(stripeMocks.customersUpdate).toHaveBeenCalledWith(
      'cus_mock_abc',
      expect.objectContaining({
        invoice_settings: { default_payment_method: 'pm_mock' },
      }))
  })

  it('default_payment_method failure is logged but does NOT fail onboarding', async () => {
    const f = await seed({ status: 'in_progress', setupIntentId: 'seti_done' })
    stripeMocks.customersUpdate.mockRejectedValueOnce(new Error('Stripe down'))
    const res = await request(buildApp())
      .post(`/api/pos-customer-onboarding/${f.token}/complete`)
    expect(res.status).toBe(200)
    expect(res.body.data.status).toBe('accepted')
    // Verify the invitation still got flipped to accepted.
    const { rows: [inv] } = await db.query<any>(
      `SELECT status FROM pos_customer_invitations WHERE id=$1`, [f.invitationId])
    expect(inv.status).toBe('accepted')
  })

  it('idempotent: already-accepted returns success without re-running Stripe', async () => {
    const f = await seed({ status: 'accepted', setupIntentId: 'seti_done' })
    const res = await request(buildApp())
      .post(`/api/pos-customer-onboarding/${f.token}/complete`)
    expect(res.status).toBe(200)
    expect(res.body.data).toEqual({ status: 'accepted' })
    expect(stripeMocks.setupIntentsRetrieve).not.toHaveBeenCalled()
  })

  it('no setup_intent_id yet → 400 "call /start first"', async () => {
    const f = await seed({ status: 'sent' })
    const res = await request(buildApp())
      .post(`/api/pos-customer-onboarding/${f.token}/complete`)
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/start/)
  })

  it('SetupIntent status not succeeded → 409', async () => {
    const f = await seed({ status: 'in_progress', setupIntentId: 'seti_pending' })
    stripeMocks.setupIntentsRetrieve.mockResolvedValueOnce({
      id: 'seti_pending', status: 'requires_action',
      payment_method: { id: 'pm_mock', us_bank_account: { last4: '6789' } },
    } as any)
    const res = await request(buildApp())
      .post(`/api/pos-customer-onboarding/${f.token}/complete`)
    expect(res.status).toBe(409)
    // pos_customers row stays unverified.
    const { rows: [pc] } = await db.query<any>(
      `SELECT ach_verified FROM pos_customers WHERE id=$1`, [f.posCustId])
    expect(pc.ach_verified).toBe(false)
  })

  it('S418 fix: bank_last4 missing on the SetupIntent → 422 (was 200 pre-fix with verified=TRUE + last4=NULL)', async () => {
    const f = await seed({ status: 'in_progress', setupIntentId: 'seti_done' })
    stripeMocks.setupIntentsRetrieve.mockResolvedValueOnce({
      id: 'seti_done', status: 'succeeded', customer: 'cus_mock_abc',
      payment_method: { id: 'pm_mock' },  // no us_bank_account
    } as any)
    const res = await request(buildApp())
      .post(`/api/pos-customer-onboarding/${f.token}/complete`)
    expect(res.status).toBe(422)
    expect(res.body.error).toMatch(/bank.*identifier|verification incomplete/i)
    // Verify the pos_customers row was NOT mis-stamped.
    const { rows: [pc] } = await db.query<any>(
      `SELECT ach_verified, bank_last4 FROM pos_customers WHERE id=$1`,
      [f.posCustId])
    expect(pc.ach_verified).toBe(false)
    expect(pc.bank_last4).toBeNull()
    // Invitation status stays in_progress (NOT flipped to accepted).
    const { rows: [inv] } = await db.query<any>(
      `SELECT status FROM pos_customer_invitations WHERE id=$1`, [f.invitationId])
    expect(inv.status).toBe('in_progress')
  })

  it('S418 fix: expired invitation → 410 even if /start succeeded earlier', async () => {
    // Seed an invitation that was started before expiry but is now expired.
    const f = await seed({
      status: 'in_progress', setupIntentId: 'seti_done', expired: true,
    })
    const res = await request(buildApp())
      .post(`/api/pos-customer-onboarding/${f.token}/complete`)
    expect(res.status).toBe(410)
    // Verify NO state change — pos_customers + invitation row unchanged.
    const { rows: [pc] } = await db.query<any>(
      `SELECT ach_verified FROM pos_customers WHERE id=$1`, [f.posCustId])
    expect(pc.ach_verified).toBe(false)
    const { rows: [inv] } = await db.query<any>(
      `SELECT status FROM pos_customer_invitations WHERE id=$1`, [f.invitationId])
    expect(inv.status).toBe('in_progress')
    // Stripe SetupIntent was NOT retrieved either — gate is checked first.
    expect(stripeMocks.setupIntentsRetrieve).not.toHaveBeenCalled()
  })

  it('unknown token → 404', async () => {
    const res = await request(buildApp())
      .post(`/api/pos-customer-onboarding/${randomUUID()}/complete`)
    expect(res.status).toBe(404)
  })
})
