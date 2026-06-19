/**
 * S513 (J) — business discount-code coverage.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { randomUUID } from 'crypto'
import { db } from '../db'
import { cleanupAllSchema } from '../test/dbHelpers'
import { businessDiscountsRouter } from './businessDiscounts'
import { errorHandler } from '../middleware/errorHandler'

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/business-discounts', businessDiscountsRouter)
  app.use(errorHandler)
  return app
}

beforeEach(async () => {
  await cleanupAllSchema()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_s513'
})

async function seed(opts: { discountsEnabled?: boolean } = {}) {
  const hash = await bcrypt.hash('super-strong-password-12!', 12)
  const email = `o-${randomUUID()}@test.dev`
  const { rows: [u] } = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
     VALUES ($1, $2, 'business_owner', 'Biz', 'Owner', TRUE) RETURNING id`, [email, hash])
  const features = ['customers', 'staff']
  if (opts.discountsEnabled !== false) features.push('discounts')
  const { rows: [b] } = await db.query<{ id: string }>(
    `INSERT INTO businesses (owner_user_id, name, business_type, email, enabled_features)
     VALUES ($1, 'Test Co', 'mini_market', $2, $3) RETURNING id`, [u.id, email, features])
  const ownerToken = jwt.sign(
    { userId: u.id, role: 'business_owner', email, profileId: b.id, businessId: b.id },
    process.env.JWT_SECRET!, { expiresIn: '1h' })
  return { ownerToken, businessId: b.id }
}

const create = (token: string, body: any) =>
  request(buildApp()).post('/api/business-discounts')
    .set('Authorization', `Bearer ${token}`).send(body)

describe('Feature gate', () => {
  it('discounts off → 403', async () => {
    const f = await seed({ discountsEnabled: false })
    const res = await create(f.ownerToken, { code: 'X', discountType: 'percent', discountValue: 10 })
    expect(res.status).toBe(403)
  })
})

describe('POST / create', () => {
  it('creates a percent code, upper-cases it', async () => {
    const f = await seed()
    const res = await create(f.ownerToken, { code: 'save10', discountType: 'percent', discountValue: 10 })
    expect(res.status).toBe(201)
    expect(res.body.data.code).toBe('SAVE10')
    expect(res.body.data.redemption_count).toBe(0)
  })

  it('rejects percent > 100', async () => {
    const f = await seed()
    const res = await create(f.ownerToken, { code: 'BIG', discountType: 'percent', discountValue: 150 })
    expect(res.status).toBe(400)
  })

  it('rejects bad code chars', async () => {
    const f = await seed()
    const res = await create(f.ownerToken, { code: 'no spaces!', discountType: 'fixed', discountValue: 5 })
    expect(res.status).toBe(400)
  })

  it('duplicate code → 409', async () => {
    const f = await seed()
    await create(f.ownerToken, { code: 'DUP', discountType: 'fixed', discountValue: 5 })
    const res = await create(f.ownerToken, { code: 'dup', discountType: 'fixed', discountValue: 5 })
    expect(res.status).toBe(409)
  })

  it('rejects expiresAt <= startsAt', async () => {
    const f = await seed()
    const res = await create(f.ownerToken, {
      code: 'WIN', discountType: 'fixed', discountValue: 5,
      startsAt: '2026-07-01T00:00:00.000Z', expiresAt: '2026-06-01T00:00:00.000Z',
    })
    expect(res.status).toBe(400)
  })
})

describe('POST /preview', () => {
  const preview = (token: string, body: any) =>
    request(buildApp()).post('/api/business-discounts/preview')
      .set('Authorization', `Bearer ${token}`).send(body)

  it('percent: computes amount off subtotal', async () => {
    const f = await seed()
    await create(f.ownerToken, { code: 'P20', discountType: 'percent', discountValue: 20 })
    const res = await preview(f.ownerToken, { code: 'p20', subtotal: 50 })
    expect(res.status).toBe(200)
    expect(res.body.data.discountAmount).toBeCloseTo(10)
  })

  it('fixed: clamps to subtotal', async () => {
    const f = await seed()
    await create(f.ownerToken, { code: 'OFF100', discountType: 'fixed', discountValue: 100 })
    const res = await preview(f.ownerToken, { code: 'OFF100', subtotal: 30 })
    expect(res.body.data.discountAmount).toBeCloseTo(30)
  })

  it('unknown code → 404', async () => {
    const f = await seed()
    const res = await preview(f.ownerToken, { code: 'NOPE', subtotal: 10 })
    expect(res.status).toBe(404)
  })

  it('inactive code → 409', async () => {
    const f = await seed()
    const c = await create(f.ownerToken, { code: 'OFF', discountType: 'fixed', discountValue: 5, isActive: false })
    expect(c.status).toBe(201)
    const res = await preview(f.ownerToken, { code: 'OFF', subtotal: 10 })
    expect(res.status).toBe(409)
  })

  it('expired code → 409', async () => {
    const f = await seed()
    await create(f.ownerToken, {
      code: 'OLD', discountType: 'fixed', discountValue: 5,
      expiresAt: '2020-01-01T00:00:00.000Z',
    })
    const res = await preview(f.ownerToken, { code: 'OLD', subtotal: 10 })
    expect(res.status).toBe(409)
  })

  it('redemption cap reached → 409', async () => {
    const f = await seed()
    const c = await create(f.ownerToken, { code: 'ONCE', discountType: 'fixed', discountValue: 5, maxRedemptions: 1 })
    await db.query(`UPDATE business_discount_codes SET redemption_count = 1 WHERE id = $1`, [c.body.data.id])
    const res = await preview(f.ownerToken, { code: 'ONCE', subtotal: 10 })
    expect(res.status).toBe(409)
  })
})

describe('PATCH /:id', () => {
  it('toggles active', async () => {
    const f = await seed()
    const c = await create(f.ownerToken, { code: 'T', discountType: 'fixed', discountValue: 5 })
    const res = await request(buildApp()).patch(`/api/business-discounts/${c.body.data.id}`)
      .set('Authorization', `Bearer ${f.ownerToken}`).send({ isActive: false })
    expect(res.status).toBe(200)
    expect(res.body.data.is_active).toBe(false)
  })
})

describe('DELETE /:id', () => {
  it('deletes an unused code', async () => {
    const f = await seed()
    const c = await create(f.ownerToken, { code: 'DEL', discountType: 'fixed', discountValue: 5 })
    const res = await request(buildApp()).delete(`/api/business-discounts/${c.body.data.id}`)
      .set('Authorization', `Bearer ${f.ownerToken}`)
    expect(res.status).toBe(200)
  })

  it('refuses to delete a used code → 409', async () => {
    const f = await seed()
    const c = await create(f.ownerToken, { code: 'USED', discountType: 'fixed', discountValue: 5 })
    await db.query(`UPDATE business_discount_codes SET redemption_count = 3 WHERE id = $1`, [c.body.data.id])
    const res = await request(buildApp()).delete(`/api/business-discounts/${c.body.data.id}`)
      .set('Authorization', `Bearer ${f.ownerToken}`)
    expect(res.status).toBe(409)
  })
})
