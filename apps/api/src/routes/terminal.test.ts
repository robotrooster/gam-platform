/**
 * terminal.ts gap-close slice — S403. Closes the file at 4/4 (100%).
 *
 * Covered routes (4):
 *   - POST /api/terminal/connection-token
 *   - POST /api/terminal/create-payment-intent  (S403 fixes)
 *   - POST /api/terminal/capture/:id
 *   - POST /api/terminal/cancel/:id
 *
 * Stripe SDK is mocked end-to-end. We verify (a) auth gating,
 * (b) the exact arguments passed to stripe.* — particularly the
 * metadata shape on create-payment-intent.
 *
 * Production bugs fixed in this slice (2):
 *   - **create-payment-intent metadata override.** Pre-fix had
 *     `metadata: { landlord_id: req.user.profileId, ...metadata }`.
 *     The spread came AFTER the server-set field, so a client could
 *     pass `metadata: { landlord_id: 'attacker-controlled' }` and
 *     override audit attribution. Now `landlord_id` is set AFTER
 *     the spread, so server always wins.
 *   - **create-payment-intent team-role landlord_id misresolution.**
 *     Same class as S400's units.ts bug. Pre-fix wrote
 *     req.user.profileId (= user_id for PM/onsite_manager/
 *     maintenance) into the metadata as "landlord_id". Resolved
 *     to actual landlord_id via the shared
 *     resolveLandlordIdForUser helper.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('stripe', () => {
  const connectionTokensCreate = vi.fn(async () => ({ secret: 'pst_mock_secret' }))
  const paymentIntentsCreate = vi.fn(async (args: any) => ({
    id: 'pi_mock', client_secret: 'pi_mock_secret', amount: args.amount,
  }))
  const paymentIntentsCapture = vi.fn(async (id: string) => ({
    id, status: 'succeeded', amount: 5000,
  }))
  const paymentIntentsCancel = vi.fn(async () => ({}))
  // S419: retrieve mock used by the new ownership-verify path.
  // Default returns a PI whose metadata.landlord_id matches the
  // caller's. Per-test mockResolvedValueOnce overrides cover the
  // cross-landlord + missing-metadata cases.
  const paymentIntentsRetrieve = vi.fn(async (id: string) => ({
    id, metadata: { landlord_id: 'will-be-overridden-per-test' },
  }))
  function FakeStripe(this: any) {
    this.terminal = { connectionTokens: { create: connectionTokensCreate } }
    this.paymentIntents = {
      create: paymentIntentsCreate,
      capture: paymentIntentsCapture,
      cancel: paymentIntentsCancel,
      retrieve: paymentIntentsRetrieve,
    }
  }
  ;(FakeStripe as any).__mocks = {
    connectionTokensCreate, paymentIntentsCreate,
    paymentIntentsCapture, paymentIntentsCancel,
    paymentIntentsRetrieve,
  }
  return { default: FakeStripe }
})

import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { randomUUID } from 'crypto'
import Stripe from 'stripe'
import { terminalRouter } from './terminal'
import { errorHandler } from '../middleware/errorHandler'

function buildApp() {
  const app = express()
  app.use(express.json({ limit: '2mb' }))
  app.use('/api/terminal', terminalRouter)
  app.use(errorHandler)
  return app
}

const stripeMocks = (Stripe as any).__mocks as {
  connectionTokensCreate:  ReturnType<typeof vi.fn>
  paymentIntentsCreate:    ReturnType<typeof vi.fn>
  paymentIntentsCapture:   ReturnType<typeof vi.fn>
  paymentIntentsCancel:    ReturnType<typeof vi.fn>
  paymentIntentsRetrieve:  ReturnType<typeof vi.fn>
}

beforeEach(() => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_terminal'
  stripeMocks.connectionTokensCreate.mockClear()
  stripeMocks.paymentIntentsCreate.mockClear()
  stripeMocks.paymentIntentsCapture.mockClear()
  stripeMocks.paymentIntentsCancel.mockClear()
  stripeMocks.paymentIntentsRetrieve.mockClear()
})

const sign = (claims: any) =>
  jwt.sign(claims, process.env.JWT_SECRET!, { expiresIn: '1h' })

function landlordTokenWithPerm(landlordId: string) {
  return sign({
    userId: randomUUID(), role: 'landlord', email: 'll@t.dev',
    profileId: landlordId, permissions: {},
  })
}
function pmTokenWithPerm(userId: string, landlordId: string) {
  return sign({
    userId, role: 'property_manager', email: 'pm@t.dev',
    profileId: userId, landlordId,
    permissions: { 'pos.ring_sale': true },
  })
}
function pmTokenNoPerm(landlordId: string) {
  return sign({
    userId: randomUUID(), role: 'property_manager', email: 'pm@t.dev',
    profileId: randomUUID(), landlordId, permissions: {},
  })
}
function tenantTokenWithPerm() {
  return sign({
    userId: randomUUID(), role: 'tenant', email: 't@t.dev',
    profileId: randomUUID(),
    permissions: { 'pos.ring_sale': true },
  })
}

// ─── POST /api/terminal/connection-token ────────────────────

describe('POST /api/terminal/connection-token', () => {
  it('happy: returns secret from stripe.terminal.connectionTokens.create', async () => {
    const res = await request(buildApp()).post('/api/terminal/connection-token')
      .set('Authorization', `Bearer ${landlordTokenWithPerm(randomUUID())}`)
    expect(res.status).toBe(200)
    expect(res.body.data.secret).toBe('pst_mock_secret')
    expect(stripeMocks.connectionTokensCreate).toHaveBeenCalledTimes(1)
  })

  it('non-owner without pos.ring_sale → 403', async () => {
    const res = await request(buildApp()).post('/api/terminal/connection-token')
      .set('Authorization', `Bearer ${pmTokenNoPerm(randomUUID())}`)
    expect(res.status).toBe(403)
    expect(stripeMocks.connectionTokensCreate).not.toHaveBeenCalled()
  })

  it('unauthenticated → 401', async () => {
    const res = await request(buildApp()).post('/api/terminal/connection-token')
    expect(res.status).toBe(401)
  })
})

// ─── POST /api/terminal/create-payment-intent ───────────────

describe('POST /api/terminal/create-payment-intent', () => {
  it('happy: amount converted to cents, server-set metadata.landlord_id', async () => {
    const landlordId = randomUUID()
    const res = await request(buildApp()).post('/api/terminal/create-payment-intent')
      .set('Authorization', `Bearer ${landlordTokenWithPerm(landlordId)}`)
      .send({ amount: 12.34, description: 'Test sale' })
    expect(res.status).toBe(200)
    expect(res.body.data.id).toBe('pi_mock')
    expect(stripeMocks.paymentIntentsCreate).toHaveBeenCalledWith(expect.objectContaining({
      amount: 1234,
      currency: 'usd',
      payment_method_types: ['card_present'],
      capture_method: 'automatic',
      description: 'Test sale',
      metadata: { landlord_id: landlordId },
    }))
  })

  it('S403 fix: client cannot override metadata.landlord_id via body', async () => {
    const realLandlordId = randomUUID()
    const attackerLandlordId = randomUUID()
    await request(buildApp()).post('/api/terminal/create-payment-intent')
      .set('Authorization', `Bearer ${landlordTokenWithPerm(realLandlordId)}`)
      .send({
        amount: 10,
        metadata: { landlord_id: attackerLandlordId, register: 'POS-1' },
      })
    const call = stripeMocks.paymentIntentsCreate.mock.calls[0][0] as any
    // Server-set landlord_id wins; the foreign client-set value is overridden.
    expect(call.metadata.landlord_id).toBe(realLandlordId)
    expect(call.metadata.landlord_id).not.toBe(attackerLandlordId)
    // Non-conflicting client metadata still flows through.
    expect(call.metadata.register).toBe('POS-1')
  })

  it('S403 fix: property_manager team-role gets actual landlord_id (not their user_id)', async () => {
    const pmUserId = randomUUID()
    const landlordId = randomUUID()
    await request(buildApp()).post('/api/terminal/create-payment-intent')
      .set('Authorization', `Bearer ${pmTokenWithPerm(pmUserId, landlordId)}`)
      .send({ amount: 5 })
    const call = stripeMocks.paymentIntentsCreate.mock.calls[0][0] as any
    expect(call.metadata.landlord_id).toBe(landlordId)
    expect(call.metadata.landlord_id).not.toBe(pmUserId)
  })

  it('amount = 0 → 400', async () => {
    const res = await request(buildApp()).post('/api/terminal/create-payment-intent')
      .set('Authorization', `Bearer ${landlordTokenWithPerm(randomUUID())}`)
      .send({ amount: 0 })
    expect(res.status).toBe(400)
    expect(stripeMocks.paymentIntentsCreate).not.toHaveBeenCalled()
  })

  it('negative amount → 400', async () => {
    const res = await request(buildApp()).post('/api/terminal/create-payment-intent')
      .set('Authorization', `Bearer ${landlordTokenWithPerm(randomUUID())}`)
      .send({ amount: -5 })
    expect(res.status).toBe(400)
    expect(stripeMocks.paymentIntentsCreate).not.toHaveBeenCalled()
  })

  it('missing amount → 400', async () => {
    const res = await request(buildApp()).post('/api/terminal/create-payment-intent')
      .set('Authorization', `Bearer ${landlordTokenWithPerm(randomUUID())}`)
      .send({})
    expect(res.status).toBe(400)
    expect(stripeMocks.paymentIntentsCreate).not.toHaveBeenCalled()
  })

  it('caller with perm but no landlord scope (tenant) → 400 No landlord scope', async () => {
    const res = await request(buildApp()).post('/api/terminal/create-payment-intent')
      .set('Authorization', `Bearer ${tenantTokenWithPerm()}`)
      .send({ amount: 10 })
    expect(res.status).toBe(400)
    expect(stripeMocks.paymentIntentsCreate).not.toHaveBeenCalled()
  })

  it('default description applied when none provided', async () => {
    await request(buildApp()).post('/api/terminal/create-payment-intent')
      .set('Authorization', `Bearer ${landlordTokenWithPerm(randomUUID())}`)
      .send({ amount: 5 })
    const call = stripeMocks.paymentIntentsCreate.mock.calls[0][0] as any
    expect(call.description).toBe('GAM POS Sale')
  })
})

// ─── POST /api/terminal/capture/:id ─────────────────────────

describe('POST /api/terminal/capture/:id', () => {
  it('happy: passes PI id to stripe.paymentIntents.capture when metadata.landlord_id matches', async () => {
    const landlordId = randomUUID()
    stripeMocks.paymentIntentsRetrieve.mockResolvedValueOnce({
      id: 'pi_test_123', metadata: { landlord_id: landlordId },
    } as any)
    const res = await request(buildApp()).post('/api/terminal/capture/pi_test_123')
      .set('Authorization', `Bearer ${landlordTokenWithPerm(landlordId)}`)
    expect(res.status).toBe(200)
    expect(res.body.data).toEqual({ id: 'pi_test_123', status: 'succeeded', amount: 5000 })
    expect(stripeMocks.paymentIntentsCapture).toHaveBeenCalledWith('pi_test_123')
    expect(stripeMocks.paymentIntentsRetrieve).toHaveBeenCalledWith('pi_test_123')
  })

  it('S419 fix: cross-landlord PI → 403; capture NOT called', async () => {
    const callerLandlordId = randomUUID()
    const piOwnerLandlordId = randomUUID()
    stripeMocks.paymentIntentsRetrieve.mockResolvedValueOnce({
      id: 'pi_foreign', metadata: { landlord_id: piOwnerLandlordId },
    } as any)
    const res = await request(buildApp()).post('/api/terminal/capture/pi_foreign')
      .set('Authorization', `Bearer ${landlordTokenWithPerm(callerLandlordId)}`)
    expect(res.status).toBe(403)
    expect(stripeMocks.paymentIntentsCapture).not.toHaveBeenCalled()
  })

  it('S419 fix: PI with no metadata.landlord_id → 404; capture NOT called', async () => {
    stripeMocks.paymentIntentsRetrieve.mockResolvedValueOnce({
      id: 'pi_alien', metadata: {},
    } as any)
    const res = await request(buildApp()).post('/api/terminal/capture/pi_alien')
      .set('Authorization', `Bearer ${landlordTokenWithPerm(randomUUID())}`)
    expect(res.status).toBe(404)
    expect(stripeMocks.paymentIntentsCapture).not.toHaveBeenCalled()
  })

  it('non-owner without pos.ring_sale → 403; retrieve NOT called (perm gate fires first)', async () => {
    const res = await request(buildApp()).post('/api/terminal/capture/pi_test_123')
      .set('Authorization', `Bearer ${pmTokenNoPerm(randomUUID())}`)
    expect(res.status).toBe(403)
    expect(stripeMocks.paymentIntentsRetrieve).not.toHaveBeenCalled()
    expect(stripeMocks.paymentIntentsCapture).not.toHaveBeenCalled()
  })
})

// ─── POST /api/terminal/cancel/:id ──────────────────────────

describe('POST /api/terminal/cancel/:id', () => {
  it('happy: passes PI id to stripe.paymentIntents.cancel when metadata.landlord_id matches', async () => {
    const landlordId = randomUUID()
    stripeMocks.paymentIntentsRetrieve.mockResolvedValueOnce({
      id: 'pi_test_456', metadata: { landlord_id: landlordId },
    } as any)
    const res = await request(buildApp()).post('/api/terminal/cancel/pi_test_456')
      .set('Authorization', `Bearer ${landlordTokenWithPerm(landlordId)}`)
    expect(res.status).toBe(200)
    expect(stripeMocks.paymentIntentsCancel).toHaveBeenCalledWith('pi_test_456')
  })

  it('S419 fix: cross-landlord PI → 403; cancel NOT called', async () => {
    const callerLandlordId = randomUUID()
    const piOwnerLandlordId = randomUUID()
    stripeMocks.paymentIntentsRetrieve.mockResolvedValueOnce({
      id: 'pi_foreign', metadata: { landlord_id: piOwnerLandlordId },
    } as any)
    const res = await request(buildApp()).post('/api/terminal/cancel/pi_foreign')
      .set('Authorization', `Bearer ${landlordTokenWithPerm(callerLandlordId)}`)
    expect(res.status).toBe(403)
    expect(stripeMocks.paymentIntentsCancel).not.toHaveBeenCalled()
  })

  it('S419 fix: PI with no metadata.landlord_id → 404; cancel NOT called', async () => {
    stripeMocks.paymentIntentsRetrieve.mockResolvedValueOnce({
      id: 'pi_alien', metadata: {},
    } as any)
    const res = await request(buildApp()).post('/api/terminal/cancel/pi_alien')
      .set('Authorization', `Bearer ${landlordTokenWithPerm(randomUUID())}`)
    expect(res.status).toBe(404)
    expect(stripeMocks.paymentIntentsCancel).not.toHaveBeenCalled()
  })

  it('non-owner without pos.ring_sale → 403; retrieve NOT called', async () => {
    const res = await request(buildApp()).post('/api/terminal/cancel/pi_test_456')
      .set('Authorization', `Bearer ${pmTokenNoPerm(randomUUID())}`)
    expect(res.status).toBe(403)
    expect(stripeMocks.paymentIntentsRetrieve).not.toHaveBeenCalled()
    expect(stripeMocks.paymentIntentsCancel).not.toHaveBeenCalled()
  })
})
