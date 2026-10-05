/**
 * 10/5: an applicant who paid the screening fee and left before pressing Submit
 * comes back to the payment step. A second charge would take the fee twice and
 * strand the first payment, so a paid, unused screening fee of the same amount
 * is handed back instead; a payment that already backs a check never is.
 *
 * This file runs the LIVE branch of /payment-intent against a mocked Stripe SDK
 * (a test key, set before background.ts loads; nothing reaches Stripe).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { randomUUID } from 'crypto'

vi.hoisted(() => { process.env.STRIPE_SECRET_KEY = 'sk_test_intake_reuse_dummy' })

const stripe = vi.hoisted(() => ({
  search: vi.fn(async (_q: any): Promise<any> => ({ data: [] })),
  create: vi.fn(async (args: any) => ({ id: 'pi_new_' + Math.random().toString(36).slice(2, 8), client_secret: 'pi_new_secret', amount: args.amount })),
}))
vi.mock('stripe', () => ({
  default: class {
    paymentIntents = { create: stripe.create, search: stripe.search }
    customers = { create: vi.fn(async () => ({ id: 'cus_intake_reuse' })) }
  },
}))

import { db } from '../db'
import { cleanupAllSchema, seedLandlord } from '../test/dbHelpers'
import { backgroundRouter } from './background'
import { errorHandler } from '../middleware/errorHandler'

const SECRET = 'test_jwt_secret_intake_reuse'
const app = () => { const a = express(); a.use(express.json()); a.use('/api/background', backgroundRouter); a.use(errorHandler); return a }

let userId: string, tenantId: string, landlordId: string, token: string
beforeEach(async () => {
  await cleanupAllSchema()
  stripe.search.mockReset(); stripe.search.mockImplementation(async () => ({ data: [] }))
  stripe.create.mockClear()
  process.env.JWT_SECRET = SECRET
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    landlordId = (await seedLandlord(c)).landlordId
    const { rows: [u] } = await c.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name) VALUES ($1,'x','tenant','','') RETURNING id`,
      [`reuse-${randomUUID()}@test.dev`])
    userId = u.id
    tenantId = (await c.query<{ id: string }>(`INSERT INTO tenants (user_id) VALUES ($1) RETURNING id`, [userId])).rows[0].id
    await c.query('COMMIT')
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
  token = jwt.sign({ userId, role: 'tenant', email: 'x@test.dev', profileId: tenantId }, SECRET, { expiresIn: '1h' })
})

const ask = () => request(app()).post('/api/background/payment-intent')
  .set('Authorization', `Bearer ${token}`).send({ landlordId })

describe('POST /background/payment-intent when the fee was already paid on an earlier visit', () => {
  it('runs on the live branch here (the mocked SDK is used, not the dev mock)', async () => {
    const res = await ask()
    expect(res.status).toBe(200)
    expect(res.body.data.testMode).toBe(false)
    expect(stripe.create).toHaveBeenCalledTimes(1)
  })

  it('a paid screening fee of the same amount that no check used is handed back — nothing is charged again', async () => {
    const amountCents = (await ask()).body.data.amount * 100
    stripe.create.mockClear()
    stripe.search.mockImplementation(async () => ({ data: [{ id: 'pi_paid_earlier', amount: Math.round(amountCents), status: 'succeeded' }] }))
    const res = await ask()
    expect(res.status).toBe(200)
    expect(res.body.data.alreadyPaid).toBe(true)
    expect(res.body.data.intentId).toBe('pi_paid_earlier')
    expect(stripe.create).not.toHaveBeenCalled()
    // It looked for THIS applicant's paid screening fees only.
    expect(String(stripe.search.mock.calls[0][0].query)).toContain(`metadata['userId']:'${userId}'`)
    expect(String(stripe.search.mock.calls[0][0].query)).toContain(`metadata['kind']:'background_check_intake'`)
  })

  it('a paid fee that already backs a check is never handed back again', async () => {
    const amountCents = (await ask()).body.data.amount * 100
    await db.query(
      `INSERT INTO background_checks (landlord_id, user_id, applicant_payment_intent_id) VALUES ($1,$2,'pi_used')`,
      [landlordId, userId])
    stripe.create.mockClear()
    stripe.search.mockImplementation(async () => ({ data: [{ id: 'pi_used', amount: Math.round(amountCents), status: 'succeeded' }] }))
    const res = await ask()
    expect(res.body.data.alreadyPaid).toBeFalsy()
    expect(stripe.create).toHaveBeenCalledTimes(1)
  })

  it('a paid fee of a different amount is not handed back', async () => {
    stripe.search.mockImplementation(async () => ({ data: [{ id: 'pi_other_amount', amount: 1, status: 'succeeded' }] }))
    const res = await ask()
    expect(res.body.data.alreadyPaid).toBeFalsy()
    expect(stripe.create).toHaveBeenCalledTimes(1)
  })

  it('when the search fails, a fresh payment starts as before', async () => {
    stripe.search.mockImplementation(async () => { throw new Error('search unavailable') })
    const res = await ask()
    expect(res.status).toBe(200)
    expect(res.body.data.alreadyPaid).toBeFalsy()
    expect(stripe.create).toHaveBeenCalledTimes(1)
  })
})
