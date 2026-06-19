/**
 * S516 — business money-visibility endpoints (balance, payout history,
 * manual payout). Stripe service layer is mocked.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { randomUUID } from 'crypto'
import { db } from '../db'
import { cleanupAllSchema } from '../test/dbHelpers'
import { errorHandler } from '../middleware/errorHandler'

const getConnectBalanceMock = vi.fn()
const getAvailableUsdBalanceMock = vi.fn()
const firePayoutMock = vi.fn()
const fetchAccountStatusMock = vi.fn()

vi.mock('../services/connectPayouts', () => ({
  getConnectBalance:           (...a: any[]) => getConnectBalanceMock(...a),
  getAvailableUsdBalance:      (...a: any[]) => getAvailableUsdBalanceMock(...a),
  firePayoutForConnectAccount: (...a: any[]) => firePayoutMock(...a),
}))
vi.mock('../services/stripeConnect', async (importOriginal) => ({
  ...(await importOriginal<any>()),
  fetchAccountStatus: (...a: any[]) => fetchAccountStatusMock(...a),
}))

// vi.mock calls are hoisted above imports, so a static import already
// sees the mocked service modules.
import { businessesRouter } from './businesses'

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/businesses', businessesRouter)
  app.use(errorHandler)
  return app
}

beforeEach(async () => {
  await cleanupAllSchema()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_s516'
  getConnectBalanceMock.mockReset()
  getAvailableUsdBalanceMock.mockReset()
  firePayoutMock.mockReset()
  fetchAccountStatusMock.mockReset()
})

async function seedOwner(opts: { account?: string | null } = {}) {
  const hash = await bcrypt.hash('super-strong-password-12!', 12)
  const email = `o-${randomUUID()}@test.dev`
  const { rows: [u] } = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
     VALUES ($1, $2, 'business_owner', 'Biz', 'Owner', TRUE) RETURNING id`, [email, hash])
  const { rows: [b] } = await db.query<{ id: string }>(
    `INSERT INTO businesses (owner_user_id, name, business_type, email, stripe_connect_account_id)
     VALUES ($1, 'Test Co', 'mini_market', $2, $3) RETURNING id`,
    [u.id, email, opts.account === undefined ? 'acct_test123' : opts.account])
  const token = jwt.sign(
    { userId: u.id, role: 'business_owner', email, profileId: b.id, businessId: b.id },
    process.env.JWT_SECRET!, { expiresIn: '1h' })
  return { userId: u.id, businessId: b.id, token, account: opts.account === undefined ? 'acct_test123' : opts.account }
}

describe('GET /me/connect/balance', () => {
  it('returns USD available + pending', async () => {
    const o = await seedOwner()
    getConnectBalanceMock.mockResolvedValue({
      available: [{ currency: 'usd', amount: 250.50 }],
      pending:   [{ currency: 'usd', amount: 75.00 }],
      instant_available: [],
    })
    const res = await request(buildApp())
      .get('/api/businesses/me/connect/balance')
      .set('Authorization', `Bearer ${o.token}`)
    expect(res.status).toBe(200)
    expect(res.body.data.availableUsd).toBeCloseTo(250.50)
    expect(res.body.data.pendingUsd).toBeCloseTo(75.00)
    expect(res.body.data.instantAvailableUsd).toBe(0)
  })

  it('no connect account → 409', async () => {
    const o = await seedOwner({ account: null })
    const res = await request(buildApp())
      .get('/api/businesses/me/connect/balance')
      .set('Authorization', `Bearer ${o.token}`)
    expect(res.status).toBe(409)
  })
})

describe('GET /me/connect/payouts', () => {
  it('lists recorded payouts for the account, newest first', async () => {
    const o = await seedOwner()
    await db.query(
      `INSERT INTO connect_payouts (stripe_payout_id, stripe_account_id, amount, status)
       VALUES ('po_1', $1, 100.00, 'paid'), ('po_2', $1, 50.00, 'in_transit')`,
      [o.account])
    // A payout for a different account must not leak in.
    await db.query(
      `INSERT INTO connect_payouts (stripe_payout_id, stripe_account_id, amount, status)
       VALUES ('po_other', 'acct_other', 999.00, 'paid')`, [])
    const res = await request(buildApp())
      .get('/api/businesses/me/connect/payouts')
      .set('Authorization', `Bearer ${o.token}`)
    expect(res.status).toBe(200)
    expect(res.body.data.length).toBe(2)
    expect(res.body.data.map((p: any) => p.stripe_payout_id).sort()).toEqual(['po_1', 'po_2'])
  })
})

describe('POST /me/connect/payouts', () => {
  it('fires a payout for the full available balance', async () => {
    const o = await seedOwner()
    fetchAccountStatusMock.mockResolvedValue({ payouts_enabled: true, charges_enabled: true, details_submitted: true, requirements_currently_due: [], requirements_past_due: [], requirements_disabled_reason: null })
    getAvailableUsdBalanceMock.mockResolvedValue(120.00)
    firePayoutMock.mockResolvedValue({ id: 'po_new', status: 'pending', arrival_date: 1700000000 })
    const res = await request(buildApp())
      .post('/api/businesses/me/connect/payouts')
      .set('Authorization', `Bearer ${o.token}`).send({})
    expect(res.status).toBe(201)
    expect(res.body.data.stripePayoutId).toBe('po_new')
    expect(res.body.data.amount).toBeCloseTo(120.00)
    expect(firePayoutMock).toHaveBeenCalledOnce()
    expect(firePayoutMock.mock.calls[0][0].amount).toBeCloseTo(120.00)
  })

  it('honors a specified amount within the available balance', async () => {
    const o = await seedOwner()
    fetchAccountStatusMock.mockResolvedValue({ payouts_enabled: true })
    getAvailableUsdBalanceMock.mockResolvedValue(120.00)
    firePayoutMock.mockResolvedValue({ id: 'po_partial', status: 'pending', arrival_date: null })
    const res = await request(buildApp())
      .post('/api/businesses/me/connect/payouts')
      .set('Authorization', `Bearer ${o.token}`).send({ amount: 40 })
    expect(res.status).toBe(201)
    expect(res.body.data.amount).toBeCloseTo(40)
  })

  it('rejects an amount above the available balance → 409', async () => {
    const o = await seedOwner()
    fetchAccountStatusMock.mockResolvedValue({ payouts_enabled: true })
    getAvailableUsdBalanceMock.mockResolvedValue(30.00)
    const res = await request(buildApp())
      .post('/api/businesses/me/connect/payouts')
      .set('Authorization', `Bearer ${o.token}`).send({ amount: 100 })
    expect(res.status).toBe(409)
    expect(firePayoutMock).not.toHaveBeenCalled()
  })

  it('payouts not enabled → 409', async () => {
    const o = await seedOwner()
    fetchAccountStatusMock.mockResolvedValue({ payouts_enabled: false })
    const res = await request(buildApp())
      .post('/api/businesses/me/connect/payouts')
      .set('Authorization', `Bearer ${o.token}`).send({})
    expect(res.status).toBe(409)
    expect(firePayoutMock).not.toHaveBeenCalled()
  })

  it('zero available balance → 409', async () => {
    const o = await seedOwner()
    fetchAccountStatusMock.mockResolvedValue({ payouts_enabled: true })
    getAvailableUsdBalanceMock.mockResolvedValue(0)
    const res = await request(buildApp())
      .post('/api/businesses/me/connect/payouts')
      .set('Authorization', `Bearer ${o.token}`).send({})
    expect(res.status).toBe(409)
  })
})
