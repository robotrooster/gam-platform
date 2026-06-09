/**
 * S450 route-test slice — auth.ts core surface.
 *
 * Existing partial coverage:
 *   loginLockout.test.ts        — 5x-failure threshold + reset clearing
 *   emailVerification.test.ts   — verify-email + resend
 *   passwordReset.test.ts       — forgot + reset
 *   totp.test.ts                — TOTP gate on login (totp_session fork)
 *   s417-disposable-email.test.ts — disposable-domain block on signup
 *
 * This slice fills the gaps:
 *   POST /register             — happy (landlord/tenant) + ToS + dup +
 *                                weak password + role enum
 *   POST /login                — basic shape + worker-role scope dispatch
 *                                + worker-without-scope deactivation +
 *                                mustEnrollTotp computed flag
 *   GET  /me                   — landlord/tenant/worker shapes + scope
 *                                landlord_id mirror + bank_account_ready
 *                                + camelCase/snake_case mirror
 *   POST /refresh              — re-sign with current claims
 *   PATCH /me                  — COALESCE partial update + own-user scope
 *   POST /register-prospect    — happy + ToS + dup + missing fields +
 *                                weak password + landlordId stamped on JWT
 */

import { vi, describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import bcrypt from 'bcryptjs'
import { randomUUID } from 'crypto'

// Email is mocked at module level so /register and /register-prospect
// don't try to send real verification emails through Resend. Pattern
// matches loginLockout.test.ts / emailVerification.test.ts.
const { sendVerifyMock, sendResetMock } = vi.hoisted(() => ({
  sendVerifyMock: vi.fn(async () => 'msg_mock_verify'),
  sendResetMock:  vi.fn(async () => 'msg_mock_reset'),
}))
vi.mock('../services/email', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    sendEmailVerification:  sendVerifyMock,
    sendPasswordResetEmail: sendResetMock,
  }
})

import { db } from '../db'
import { authRouter } from './auth'
import { errorHandler } from '../middleware/errorHandler'
import { cleanupAllSchema, seedLandlord, seedTenant } from '../test/dbHelpers'

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/auth', authRouter)
  app.use(errorHandler)
  return app
}

beforeEach(async () => {
  await cleanupAllSchema()
  sendVerifyMock.mockClear()
  sendResetMock.mockClear()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_s450'
})

const validRegister = (over: Record<string, any> = {}) => ({
  email:     `register-${randomUUID()}@example.com`,
  password:  'super-strong-password-12!',
  firstName: 'Test',
  lastName:  'User',
  role:      'tenant',
  acceptedTerms: true,
  ...over,
})

const validProspect = (over: Record<string, any> = {}) => ({
  email:     `prospect-${randomUUID()}@example.com`,
  password:  'super-strong-password-12!',
  firstName: 'Pros',
  lastName:  'Pect',
  acceptedTerms: true,
  ...over,
})

// ═══════════════════════════════════════════════════════════════
//  POST /api/auth/register
// ═══════════════════════════════════════════════════════════════

describe('POST /api/auth/register', () => {
  it('happy landlord: 201 with token + user + landlord profile row', async () => {
    const body = validRegister({ role: 'landlord' })
    const res = await request(buildApp())
      .post('/api/auth/register').send(body)
    expect(res.status).toBe(201)
    expect(res.body.success).toBe(true)
    expect(res.body.data.token).toEqual(expect.any(String))
    expect(res.body.data.user.role).toBe('landlord')
    expect(res.body.data.user.email).toBe(body.email)
    expect(res.body.data.user.profileId).toEqual(expect.any(String))

    // Side effects: landlord row, accepted_tos_at + accepted_privacy_at
    // stamped, email_verified defaults to FALSE (no auto-verify on register).
    const { rows: [u] } = await db.query<any>(
      `SELECT email_verified, accepted_tos_at, accepted_privacy_at
         FROM users WHERE email = $1`, [body.email])
    expect(u.email_verified).toBe(false)
    expect(u.accepted_tos_at).not.toBeNull()
    expect(u.accepted_privacy_at).not.toBeNull()

    const { rows: ll } = await db.query<any>(
      `SELECT id FROM landlords WHERE id = $1`, [res.body.data.user.profileId])
    expect(ll).toHaveLength(1)
  })

  it('happy tenant: 201 with tenant profile row, role=tenant in token', async () => {
    const body = validRegister({ role: 'tenant' })
    const res = await request(buildApp())
      .post('/api/auth/register').send(body)
    expect(res.status).toBe(201)
    const decoded = jwt.decode(res.body.data.token) as any
    expect(decoded.role).toBe('tenant')

    const { rows: t } = await db.query<any>(
      `SELECT id FROM tenants WHERE id = $1`, [res.body.data.user.profileId])
    expect(t).toHaveLength(1)
  })

  it('acceptedTerms missing → 400 (zod literal(true) refuses)', async () => {
    const res = await request(buildApp())
      .post('/api/auth/register').send(validRegister({ acceptedTerms: undefined }))
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/Terms of Service/i)
  })

  it('acceptedTerms=false → 400', async () => {
    const res = await request(buildApp())
      .post('/api/auth/register').send(validRegister({ acceptedTerms: false }))
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/Terms of Service/i)
  })

  it('password under 12 chars → 400 (zod min(PASSWORD_MIN_LEN))', async () => {
    const res = await request(buildApp())
      .post('/api/auth/register').send(validRegister({ password: 'short-pw1' }))
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/password/i)
  })

  it('duplicate email → 409', async () => {
    const body = validRegister()
    await request(buildApp()).post('/api/auth/register').send(body)
    const res = await request(buildApp())
      .post('/api/auth/register').send(body)
    expect(res.status).toBe(409)
    expect(res.body.error).toMatch(/already registered/i)
  })

  it('invalid role → 400 (zod enum)', async () => {
    const res = await request(buildApp())
      .post('/api/auth/register').send(validRegister({ role: 'admin' }))
    expect(res.status).toBe(400)
  })

  it('verification email fired AFTER commit (best-effort, doesn\'t fail the request)', async () => {
    const body = validRegister()
    const res = await request(buildApp())
      .post('/api/auth/register').send(body)
    expect(res.status).toBe(201)
    // Allow the void/fire-and-forget call to flush.
    await new Promise(r => setTimeout(r, 50))
    expect(sendVerifyMock).toHaveBeenCalled()
    const args = sendVerifyMock.mock.calls[0] as any[]
    expect(args[0]).toBe(body.email)
  })
})

// ═══════════════════════════════════════════════════════════════
//  POST /api/auth/login — basic + worker-scope dispatch
// ═══════════════════════════════════════════════════════════════

describe('POST /api/auth/login', () => {
  async function seedVerifiedUser(opts: {
    email: string
    role: 'landlord' | 'tenant' | 'property_manager' | 'onsite_manager' | 'maintenance' | 'bookkeeper'
    password?: string
  }): Promise<{ userId: string; landlordId: string | null }> {
    const hash = await bcrypt.hash(opts.password ?? 'super-strong-password-12!', 12)
    const { rows: [u] } = await db.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
       VALUES ($1, $2, $3, 'Test', 'User', TRUE) RETURNING id`,
      [opts.email, hash, opts.role])
    let landlordId: string | null = null
    if (opts.role === 'landlord') {
      const { rows: [l] } = await db.query<{ id: string }>(
        `INSERT INTO landlords (user_id) VALUES ($1) RETURNING id`, [u.id])
      landlordId = l.id
    } else if (opts.role === 'tenant') {
      await db.query(`INSERT INTO tenants (user_id) VALUES ($1)`, [u.id])
    }
    return { userId: u.id, landlordId }
  }

  it('happy landlord: 200, token + user shape, mustEnrollTotp=false', async () => {
    const email = `login-ll-${randomUUID()}@example.com`
    const { landlordId } = await seedVerifiedUser({ email, role: 'landlord' })
    const res = await request(buildApp())
      .post('/api/auth/login').send({ email, password: 'super-strong-password-12!' })
    expect(res.status).toBe(200)
    expect(res.body.data.token).toEqual(expect.any(String))
    expect(res.body.data.user.role).toBe('landlord')
    expect(res.body.data.user.profileId).toBe(landlordId)
    expect(res.body.data.user.mustEnrollTotp).toBe(false)  // landlord not in MANDATORY_TOTP_ROLES
    expect(res.body.data.user.directDepositEnabled).toBe(false)  // no scope row
  })

  it('property_manager WITH scope: landlordId + permissions land on JWT + user', async () => {
    const email = `login-pm-${randomUUID()}@example.com`
    const { userId } = await seedVerifiedUser({ email, role: 'property_manager' })
    // Seed the scope row pointing to a landlord.
    const c = await db.connect()
    let landlordId = ''
    try {
      await c.query('BEGIN')
      const seeded = await seedLandlord(c)
      landlordId = seeded.landlordId
      await c.query(
        `INSERT INTO property_manager_scopes
           (user_id, landlord_id, permissions, all_properties, property_ids, unit_ids,
            direct_deposit_enabled)
         VALUES ($1, $2, $3, TRUE, ARRAY[]::uuid[], ARRAY[]::uuid[], TRUE)`,
        [userId, landlordId, JSON.stringify({ payments: { view_all: true } })])
      await c.query('COMMIT')
    } finally { c.release() }

    const res = await request(buildApp())
      .post('/api/auth/login').send({ email, password: 'super-strong-password-12!' })
    expect(res.status).toBe(200)
    expect(res.body.data.user.landlordId).toBe(landlordId)
    expect(res.body.data.user.permissions).toMatchObject({ payments: { view_all: true } })
    expect(res.body.data.user.directDepositEnabled).toBe(true)

    // JWT carries the same claims (so downstream requireAuth has them).
    const decoded = jwt.decode(res.body.data.token) as any
    expect(decoded.landlordId).toBe(landlordId)
    expect(decoded.permissions).toMatchObject({ payments: { view_all: true } })
  })

  it('worker WITHOUT scope row → 403 deactivated', async () => {
    const email = `login-deact-${randomUUID()}@example.com`
    await seedVerifiedUser({ email, role: 'maintenance' })
    // No scope row seeded — user was scoped then revoked.
    const res = await request(buildApp())
      .post('/api/auth/login').send({ email, password: 'super-strong-password-12!' })
    expect(res.status).toBe(403)
    expect(res.body.error).toMatch(/deactivated/i)
  })

  it('mustEnrollTotp=false for non-mandatory roles (MANDATORY_TOTP_ROLES = admin / super_admin only)', async () => {
    const email = `login-pmtotp-${randomUUID()}@example.com`
    const { userId } = await seedVerifiedUser({ email, role: 'property_manager' })
    const c = await db.connect()
    try {
      await c.query('BEGIN')
      const { landlordId } = await seedLandlord(c)
      await c.query(
        `INSERT INTO property_manager_scopes
           (user_id, landlord_id, permissions, all_properties, property_ids, unit_ids)
         VALUES ($1, $2, $3, TRUE, ARRAY[]::uuid[], ARRAY[]::uuid[])`,
        [userId, landlordId, JSON.stringify({})])
      await c.query('COMMIT')
    } finally { c.release() }
    const res = await request(buildApp())
      .post('/api/auth/login').send({ email, password: 'super-strong-password-12!' })
    expect(res.status).toBe(200)
    expect(res.body.data.user.mustEnrollTotp).toBe(false)
  })

  it('bcrypt mismatch → 401 generic, NO email_verified leak', async () => {
    const email = `login-bad-${randomUUID()}@example.com`
    await seedVerifiedUser({ email, role: 'tenant' })
    const res = await request(buildApp())
      .post('/api/auth/login').send({ email, password: 'wrong-password-but-12c' })
    expect(res.status).toBe(401)
    expect(res.body.error).toMatch(/Invalid credentials/i)
  })

  it('zod validation: missing email → 400', async () => {
    const res = await request(buildApp())
      .post('/api/auth/login').send({ password: 'whatever' })
    expect(res.status).toBe(400)
  })
})

// ═══════════════════════════════════════════════════════════════
//  GET /api/auth/me
// ═══════════════════════════════════════════════════════════════

describe('GET /api/auth/me', () => {
  async function seedLoggedInUser(opts: {
    role: 'landlord' | 'tenant' | 'property_manager'
  }): Promise<{ userId: string; profileId: string | null; token: string }> {
    const c = await db.connect()
    let userId = ''
    let profileId: string | null = null
    try {
      await c.query('BEGIN')
      if (opts.role === 'landlord') {
        const { userId: uid, landlordId } = await seedLandlord(c)
        userId = uid; profileId = landlordId
      } else if (opts.role === 'tenant') {
        userId = await c.query<{ id: string; user_id: string }>(
          `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
           VALUES ($1, 'x', 'tenant', 'T', 'U', TRUE) RETURNING id`,
          [`t-${randomUUID()}@test.dev`]).then(r => r.rows[0].id)
        const { rows: [t] } = await c.query<{ id: string }>(
          `INSERT INTO tenants (user_id) VALUES ($1) RETURNING id`, [userId])
        profileId = t.id
      } else {
        userId = await c.query<{ id: string }>(
          `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
           VALUES ($1, 'x', 'property_manager', 'P', 'M', TRUE) RETURNING id`,
          [`pm-${randomUUID()}@test.dev`]).then(r => r.rows[0].id)
      }
      await c.query('COMMIT')
    } finally { c.release() }
    const token = jwt.sign(
      { userId, role: opts.role, email: `x@y.dev`, profileId },
      process.env.JWT_SECRET!, { expiresIn: '1h' })
    return { userId, profileId, token }
  }

  it('landlord: full shape with profile_id + totpEnabled + mustEnrollTotp + bank_account_ready', async () => {
    const u = await seedLoggedInUser({ role: 'landlord' })
    const res = await request(buildApp())
      .get('/api/auth/me').set('Authorization', `Bearer ${u.token}`)
    expect(res.status).toBe(200)
    expect(res.body.data.role).toBe('landlord')
    expect(res.body.data.profile_id).toBe(u.profileId)
    expect(res.body.data.bank_account_ready).toBe(false)
    expect(res.body.data.totpEnabled).toBe(false)
    expect(res.body.data.mustEnrollTotp).toBe(false)  // landlord not mandatory
  })

  it('tenant: surfaces ach_verified + on_time_pay_enrolled + credit_reporting_enrolled', async () => {
    const u = await seedLoggedInUser({ role: 'tenant' })
    await db.query(
      `UPDATE tenants SET ach_verified = TRUE, on_time_pay_enrolled = TRUE,
                          credit_reporting_enrolled = TRUE WHERE id = $1`, [u.profileId])
    const res = await request(buildApp())
      .get('/api/auth/me').set('Authorization', `Bearer ${u.token}`)
    expect(res.status).toBe(200)
    expect(res.body.data.ach_verified).toBe(true)
    expect(res.body.data.on_time_pay_enrolled).toBe(true)
    expect(res.body.data.credit_reporting_enrolled).toBe(true)
  })

  it('worker role with scope: surfaces landlord_id + landlordId mirror + permissions', async () => {
    const u = await seedLoggedInUser({ role: 'property_manager' })
    const c = await db.connect()
    let landlordId = ''
    try {
      await c.query('BEGIN')
      const seeded = await seedLandlord(c)
      landlordId = seeded.landlordId
      await c.query(
        `INSERT INTO property_manager_scopes
           (user_id, landlord_id, permissions, all_properties, property_ids, unit_ids,
            direct_deposit_enabled)
         VALUES ($1, $2, $3, TRUE, ARRAY[]::uuid[], ARRAY[]::uuid[], TRUE)`,
        [u.userId, landlordId, JSON.stringify({ tenants: { view: true } })])
      await c.query('COMMIT')
    } finally { c.release() }
    const res = await request(buildApp())
      .get('/api/auth/me').set('Authorization', `Bearer ${u.token}`)
    expect(res.status).toBe(200)
    expect(res.body.data.landlord_id).toBe(landlordId)
    expect(res.body.data.landlordId).toBe(landlordId)   // camelCase mirror
    expect(res.body.data.permissions).toMatchObject({ tenants: { view: true } })
    expect(res.body.data.directDepositEnabled).toBe(true)
    expect(res.body.data.mustEnrollTotp).toBe(false)    // PM not in MANDATORY_TOTP_ROLES (admin/super_admin only)
  })

  it('user with active bank_account → bank_account_ready=true', async () => {
    const u = await seedLoggedInUser({ role: 'landlord' })
    await db.query(
      `INSERT INTO user_bank_accounts
         (user_id, nickname, account_holder_name, account_type,
          routing_number, account_number_last4, account_number_encrypted, status)
       VALUES ($1, 'Op', 'Holder', 'checking', '110000000', '1234', 'enc', 'active')`,
      [u.userId])
    const res = await request(buildApp())
      .get('/api/auth/me').set('Authorization', `Bearer ${u.token}`)
    expect(res.body.data.bank_account_ready).toBe(true)
  })

  it('archived bank_account → bank_account_ready stays false (only "active" counts)', async () => {
    const u = await seedLoggedInUser({ role: 'landlord' })
    await db.query(
      `INSERT INTO user_bank_accounts
         (user_id, nickname, account_holder_name, account_type,
          routing_number, account_number_last4, account_number_encrypted, status)
       VALUES ($1, 'Op', 'Holder', 'checking', '110000000', '1234', 'enc', 'archived')`,
      [u.userId])
    const res = await request(buildApp())
      .get('/api/auth/me').set('Authorization', `Bearer ${u.token}`)
    expect(res.body.data.bank_account_ready).toBe(false)
  })

  it('no auth → 401', async () => {
    const res = await request(buildApp()).get('/api/auth/me')
    expect(res.status).toBe(401)
  })

  it('deleted user (token valid, row gone) → 404', async () => {
    const u = await seedLoggedInUser({ role: 'tenant' })
    await db.query(`DELETE FROM tenants WHERE id = $1`, [u.profileId])
    await db.query(`DELETE FROM users WHERE id = $1`, [u.userId])
    const res = await request(buildApp())
      .get('/api/auth/me').set('Authorization', `Bearer ${u.token}`)
    expect(res.status).toBe(404)
  })
})

// ═══════════════════════════════════════════════════════════════
//  POST /api/auth/refresh
// ═══════════════════════════════════════════════════════════════

describe('POST /api/auth/refresh', () => {
  it('happy: returns a new token signed with same claims', async () => {
    const userId = randomUUID()
    const claims = { userId, role: 'landlord', email: 'r@test.dev', profileId: randomUUID() }
    const token = jwt.sign(claims, process.env.JWT_SECRET!, { expiresIn: '1h' })
    const res = await request(buildApp())
      .post('/api/auth/refresh').set('Authorization', `Bearer ${token}`).send({})
    expect(res.status).toBe(200)
    expect(res.body.data.token).toEqual(expect.any(String))
    const decoded = jwt.decode(res.body.data.token) as any
    expect(decoded.userId).toBe(userId)
    expect(decoded.role).toBe('landlord')
  })

  it('no auth → 401', async () => {
    const res = await request(buildApp()).post('/api/auth/refresh').send({})
    expect(res.status).toBe(401)
  })
})

// ═══════════════════════════════════════════════════════════════
//  PATCH /api/auth/me
// ═══════════════════════════════════════════════════════════════

describe('PATCH /api/auth/me', () => {
  async function seedLoggedInLandlord(): Promise<{ userId: string; token: string }> {
    const c = await db.connect()
    let userId = ''
    try {
      await c.query('BEGIN')
      const seeded = await seedLandlord(c)
      userId = seeded.userId
      await c.query('COMMIT')
    } finally { c.release() }
    const token = jwt.sign(
      { userId, role: 'landlord', email: 'x@y.dev', profileId: randomUUID() },
      process.env.JWT_SECRET!, { expiresIn: '1h' })
    return { userId, token }
  }

  it('updates firstName + lastName + phone', async () => {
    const u = await seedLoggedInLandlord()
    const res = await request(buildApp())
      .patch('/api/auth/me').set('Authorization', `Bearer ${u.token}`)
      .send({ firstName: 'New', lastName: 'Name', phone: '555-1234' })
    expect(res.status).toBe(200)
    const { rows: [row] } = await db.query<any>(
      `SELECT first_name, last_name, phone FROM users WHERE id = $1`, [u.userId])
    expect(row.first_name).toBe('New')
    expect(row.last_name).toBe('Name')
    expect(row.phone).toBe('555-1234')
  })

  it('COALESCE: omitted fields preserve current values', async () => {
    const u = await seedLoggedInLandlord()
    // First set full state.
    await request(buildApp())
      .patch('/api/auth/me').set('Authorization', `Bearer ${u.token}`)
      .send({ firstName: 'Initial', lastName: 'Last', phone: '111' })
    // Then patch only firstName.
    await request(buildApp())
      .patch('/api/auth/me').set('Authorization', `Bearer ${u.token}`)
      .send({ firstName: 'Updated' })
    const { rows: [row] } = await db.query<any>(
      `SELECT first_name, last_name, phone FROM users WHERE id = $1`, [u.userId])
    expect(row.first_name).toBe('Updated')
    expect(row.last_name).toBe('Last')      // preserved
    expect(row.phone).toBe('111')           // preserved
  })

  it('only updates the caller\'s row (cannot patch other user)', async () => {
    const me = await seedLoggedInLandlord()
    const other = await seedLoggedInLandlord()
    await request(buildApp())
      .patch('/api/auth/me').set('Authorization', `Bearer ${me.token}`)
      .send({ firstName: 'HackedFirst' })
    const { rows: [otherRow] } = await db.query<any>(
      `SELECT first_name FROM users WHERE id = $1`, [other.userId])
    expect(otherRow.first_name).toBe('Test')  // unchanged (seedLandlord default)
  })

  it('no auth → 401', async () => {
    const res = await request(buildApp()).patch('/api/auth/me').send({ firstName: 'X' })
    expect(res.status).toBe(401)
  })
})

// ═══════════════════════════════════════════════════════════════
//  POST /api/auth/register-prospect
// ═══════════════════════════════════════════════════════════════

describe('POST /api/auth/register-prospect', () => {
  it('happy: 201 with token + tenant profile + ToS timestamps', async () => {
    const body = validProspect()
    const res = await request(buildApp())
      .post('/api/auth/register-prospect').send(body)
    expect(res.status).toBe(201)
    expect(res.body.data.user.role).toBe('tenant')
    expect(res.body.data.token).toEqual(expect.any(String))

    const { rows: [u] } = await db.query<any>(
      `SELECT role, email_verified, accepted_tos_at FROM users WHERE email = $1`, [body.email])
    expect(u.role).toBe('tenant')
    expect(u.email_verified).toBe(false)
    expect(u.accepted_tos_at).not.toBeNull()
    const { rows: t } = await db.query<any>(
      `SELECT id FROM tenants WHERE user_id = (SELECT id FROM users WHERE email = $1)`,
      [body.email])
    expect(t).toHaveLength(1)
  })

  it('landlordId in body stamps JWT (for downstream lease attribution)', async () => {
    const c = await db.connect()
    let landlordId = ''
    try {
      await c.query('BEGIN')
      const seeded = await seedLandlord(c)
      landlordId = seeded.landlordId
      await c.query('COMMIT')
    } finally { c.release() }
    const res = await request(buildApp())
      .post('/api/auth/register-prospect').send(validProspect({ landlordId }))
    expect(res.status).toBe(201)
    const decoded = jwt.decode(res.body.data.token) as any
    expect(decoded.landlordId).toBe(landlordId)
  })

  it('no landlordId → JWT carries landlordId=null (does not throw)', async () => {
    const res = await request(buildApp())
      .post('/api/auth/register-prospect').send(validProspect())
    expect(res.status).toBe(201)
    const decoded = jwt.decode(res.body.data.token) as any
    expect(decoded.landlordId).toBeNull()
  })

  it('acceptedTerms missing → 400', async () => {
    const res = await request(buildApp())
      .post('/api/auth/register-prospect').send(validProspect({ acceptedTerms: undefined }))
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/Terms of Service/i)
  })

  it('password under 12 chars → 400 (manual check before bcrypt)', async () => {
    const res = await request(buildApp())
      .post('/api/auth/register-prospect').send(validProspect({ password: 'short' }))
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/at least 12/i)
  })

  it('duplicate email → 409 with sign-in hint', async () => {
    const body = validProspect()
    await request(buildApp()).post('/api/auth/register-prospect').send(body)
    const res = await request(buildApp())
      .post('/api/auth/register-prospect').send(body)
    expect(res.status).toBe(409)
    expect(res.body.error).toMatch(/Please sign in/i)
  })

  it('missing firstName → 400', async () => {
    const res = await request(buildApp())
      .post('/api/auth/register-prospect').send(validProspect({ firstName: undefined }))
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/required/i)
  })

  it('verification email fired (best-effort)', async () => {
    const body = validProspect()
    await request(buildApp())
      .post('/api/auth/register-prospect').send(body)
    await new Promise(r => setTimeout(r, 50))
    expect(sendVerifyMock).toHaveBeenCalled()
  })
})
