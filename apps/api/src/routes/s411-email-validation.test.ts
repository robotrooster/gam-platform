/**
 * S411 hygiene: S380 email validation on PATCH /tenants/profile.
 *
 * Nic-locked decision (S398): "do all three" plus the 4th defensive
 * preserve-on-omit case.
 *
 *   1. Format check (zod email regex)        → 400
 *   2. Uniqueness pre-check                   → 409 (was 500 from
 *                                                  DB UNIQUE pg error)
 *   3. Disposable-domain block                 → 400
 *   4. Omitted email preserves current value   → was 500 from NOT NULL
 */

import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { randomUUID } from 'crypto'
import { db } from '../db'
import { cleanupAllSchema, seedTenant } from '../test/dbHelpers'
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
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_s411'
})

interface Fixture {
  tenantId: string
  userId:   string
  email:    string
  token:    string
}

async function seedTenantFixture(): Promise<Fixture> {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const tenantId = await seedTenant(c)
    const { rows: [{ user_id, email }] } = await c.query<{ user_id: string; email: string }>(
      `SELECT u.id AS user_id, u.email
         FROM tenants t JOIN users u ON u.id = t.user_id
        WHERE t.id = $1`, [tenantId])
    await c.query('COMMIT')
    const token = jwt.sign(
      { userId: user_id, role: 'tenant', email,
        profileId: tenantId, permissions: {} },
      process.env.JWT_SECRET!, { expiresIn: '1h' })
    return { tenantId, userId: user_id, email, token }
  } catch (e) { await c.query('ROLLBACK'); throw e }
  finally { c.release() }
}

describe('PATCH /api/tenants/profile — S380 email validation', () => {
  // ── 1. Format check ───────────────────────────────────────

  it('non-email string → 400 (format check)', async () => {
    const f = await seedTenantFixture()
    const res = await request(buildApp())
      .patch('/api/tenants/profile')
      .set('Authorization', `Bearer ${f.token}`)
      .send({ email: 'not-an-email' })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/invalid|email/i)
    // Verify the row was NOT updated.
    const { rows: [u] } = await db.query<{ email: string }>(
      `SELECT email FROM users WHERE id=$1`, [f.userId])
    expect(u.email).toBe(f.email)
  })

  it('empty string email → 400', async () => {
    const f = await seedTenantFixture()
    const res = await request(buildApp())
      .patch('/api/tenants/profile')
      .set('Authorization', `Bearer ${f.token}`)
      .send({ email: '' })
    expect(res.status).toBe(400)
  })

  // ── 2. Uniqueness pre-check ───────────────────────────────

  it('email already in use by another user → 409 (was 500 pre-fix)', async () => {
    const f = await seedTenantFixture()
    // Seed a second user with a known email.
    const collidingEmail = `taken-${randomUUID()}@test.dev`
    await db.query(
      `INSERT INTO users (email, password_hash, role, first_name, last_name)
       VALUES ($1, 'x', 'tenant', 'Other', 'User')`,
      [collidingEmail])
    const res = await request(buildApp())
      .patch('/api/tenants/profile')
      .set('Authorization', `Bearer ${f.token}`)
      .send({ email: collidingEmail })
    expect(res.status).toBe(409)
    expect(res.body.error).toMatch(/already in use/i)
  })

  it('uniqueness check is case-insensitive (LOWER() comparison)', async () => {
    const f = await seedTenantFixture()
    const existing = `MIXED-${randomUUID()}@test.dev`
    await db.query(
      `INSERT INTO users (email, password_hash, role, first_name, last_name)
       VALUES ($1, 'x', 'tenant', 'Other', 'User')`,
      [existing])
    const res = await request(buildApp())
      .patch('/api/tenants/profile')
      .set('Authorization', `Bearer ${f.token}`)
      .send({ email: existing.toUpperCase() })  // different case, same address
    expect(res.status).toBe(409)
  })

  it('updating to OWN current email → 200 (not flagged as duplicate)', async () => {
    const f = await seedTenantFixture()
    const res = await request(buildApp())
      .patch('/api/tenants/profile')
      .set('Authorization', `Bearer ${f.token}`)
      .send({ email: f.email })
    expect(res.status).toBe(200)
  })

  // ── 3. Disposable-domain block ────────────────────────────

  it('disposable domain (mailinator.com) → 400', async () => {
    const f = await seedTenantFixture()
    const res = await request(buildApp())
      .patch('/api/tenants/profile')
      .set('Authorization', `Bearer ${f.token}`)
      .send({ email: 'someone@mailinator.com' })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/disposable|temporary/i)
  })

  it('disposable domain (yopmail.com) → 400', async () => {
    const f = await seedTenantFixture()
    const res = await request(buildApp())
      .patch('/api/tenants/profile')
      .set('Authorization', `Bearer ${f.token}`)
      .send({ email: 'someone@YOPMAIL.COM' })  // case-insensitive
    expect(res.status).toBe(400)
  })

  it('disposable check does not block legit gmail.com', async () => {
    const f = await seedTenantFixture()
    const res = await request(buildApp())
      .patch('/api/tenants/profile')
      .set('Authorization', `Bearer ${f.token}`)
      .send({ email: `legit-${randomUUID()}@gmail.com` })
    expect(res.status).toBe(200)
  })

  // ── 4. Preserve current email when omitted ────────────────

  it('omitted email → original email preserved (was 500 from NOT NULL pre-fix)', async () => {
    const f = await seedTenantFixture()
    const res = await request(buildApp())
      .patch('/api/tenants/profile')
      .set('Authorization', `Bearer ${f.token}`)
      .send({ phone: '5550199', bio: 'updated bio' })
    expect(res.status).toBe(200)
    const { rows: [u] } = await db.query<{ email: string; phone: string }>(
      `SELECT email, phone FROM users WHERE id=$1`, [f.userId])
    // Email survives; phone + bio updated.
    expect(u.email).toBe(f.email)
    expect(u.phone).toBe('5550199')
    const { rows: [t] } = await db.query<{ bio: string }>(
      `SELECT bio FROM tenants WHERE id=$1`, [f.tenantId])
    expect(t.bio).toBe('updated bio')
  })

  // ── Happy: normalization ──────────────────────────────────

  it('email is lowercased + trimmed on update', async () => {
    const f = await seedTenantFixture()
    const newEmail = `Mixed-${randomUUID()}@Test.Dev`
    const res = await request(buildApp())
      .patch('/api/tenants/profile')
      .set('Authorization', `Bearer ${f.token}`)
      .send({ email: `  ${newEmail}  ` })  // surrounding whitespace
    expect(res.status).toBe(200)
    const { rows: [u] } = await db.query<{ email: string }>(
      `SELECT email FROM users WHERE id=$1`, [f.userId])
    expect(u.email).toBe(newEmail.toLowerCase())
  })
})
