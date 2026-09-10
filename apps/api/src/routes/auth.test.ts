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

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import bcrypt from 'bcryptjs'
import { randomUUID } from 'crypto'

// Email is mocked at module level so /register and /register-prospect
// don't try to send real verification emails through Resend. Pattern
// matches loginLockout.test.ts / emailVerification.test.ts.
const { sendVerifyMock, sendResetMock } = vi.hoisted(() => ({
  // S639: typed with the real signature (to, firstName, url, ctx) so a test can
  // assert on the URL it was called with. An arg-less vi.fn() infers calls as
  // [][], which vitest runs happily and `tsc -b` then rejects — the build broke
  // on it after the suite had gone green.
  sendVerifyMock: vi.fn(async (..._args: any[]) => 'msg_mock_verify'),
  sendResetMock:  vi.fn(async (..._args: any[]) => 'msg_mock_reset'),
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
import { authRouter, mintAndSendVerifyEmail } from './auth'
import { errorHandler } from '../middleware/errorHandler'
import { cleanupAllSchema, seedLandlord, seedTenant } from '../test/dbHelpers'

function buildApp() {
  const app = express()
  app.use(express.json())
  // S639: mirrors the app-level no-store middleware in index.ts.
  app.use('/api', (_q: any, r: any, n: any) => {
    r.set('Cache-Control', 'no-store, no-cache, must-revalidate, private'); n()
  })
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
  it('happy landlord: 201 with requiresEmailOtp (mandatory 2FA at signup) + landlord profile row', async () => {
    const body = validRegister({ role: 'landlord' })
    const res = await request(buildApp())
      .post('/api/auth/register').send(body)
    expect(res.status).toBe(201)
    expect(res.body.success).toBe(true)
    // S578: mandatory email-2FA at signup — a pending session + emailed code,
    // never a full token.
    expect(res.body.data.requiresEmailOtp).toBe(true)
    expect(res.body.data.emailOtpSession).toEqual(expect.any(String))
    expect(res.body.data.token).toBeUndefined()
    expect(res.body.data.user.role).toBe('landlord')
    expect(res.body.data.user.email).toBe(body.email)
    expect(res.body.data.user.profileId).toEqual(expect.any(String))

    // Side effects: landlord row, accepted_tos_at + accepted_privacy_at
    // stamped, email_2fa_enabled canonicalized TRUE, email_verified still FALSE
    // (it flips when the emailed code is entered at /email-otp/verify).
    const { rows: [u] } = await db.query<any>(
      `SELECT email_verified, email_2fa_enabled, accepted_tos_at, accepted_privacy_at
         FROM users WHERE email = $1`, [body.email])
    expect(u.email_verified).toBe(false)
    expect(u.email_2fa_enabled).toBe(true)
    expect(u.accepted_tos_at).not.toBeNull()
    expect(u.accepted_privacy_at).not.toBeNull()

    const { rows: ll } = await db.query<any>(
      `SELECT id FROM landlords WHERE id = $1`, [res.body.data.user.profileId])
    expect(ll).toHaveLength(1)
  })

  it('happy tenant: 201 with requiresEmailOtp + tenant profile row, role=tenant', async () => {
    const body = validRegister({ role: 'tenant' })
    const res = await request(buildApp())
      .post('/api/auth/register').send(body)
    expect(res.status).toBe(201)
    expect(res.body.data.requiresEmailOtp).toBe(true)
    expect(res.body.data.token).toBeUndefined()
    expect(res.body.data.user.role).toBe('tenant')

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

  it('S578: signup issues an email 2FA code (login_email_otps row), not a verify link', async () => {
    const body = validRegister()
    const res = await request(buildApp())
      .post('/api/auth/register').send(body)
    expect(res.status).toBe(201)
    expect(res.body.data.requiresEmailOtp).toBe(true)
    // Allow the void/fire-and-forget flush.
    await new Promise(r => setTimeout(r, 50))
    // No separate verification LINK — the emailed 2FA code doubles as
    // verification once entered.
    expect(sendVerifyMock).not.toHaveBeenCalled()
    const { rows: otps } = await db.query<any>(
      `SELECT o.id FROM login_email_otps o JOIN users u ON u.id = o.user_id
        WHERE u.email = $1 AND o.consumed_at IS NULL`, [body.email])
    expect(otps.length).toBeGreaterThanOrEqual(1)
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

  // S574: email-code 2FA is MANDATORY for every landlord (mirrors tenants). A
  // landlord login no longer returns a full token — it gates on the emailed code
  // and canonicalizes email_2fa_enabled=TRUE on first sign-in.
  it('landlord: mandatory email 2FA — requiresEmailOtp, no full token, flag canonicalized', async () => {
    const email = `login-ll-${randomUUID()}@example.com`
    const { userId } = await seedVerifiedUser({ email, role: 'landlord' })
    const res = await request(buildApp())
      .post('/api/auth/login').send({ email, password: 'super-strong-password-12!' })
    expect(res.status).toBe(200)
    expect(res.body.data.requiresEmailOtp).toBe(true)
    expect(res.body.data.emailOtpSession).toBeTruthy()
    expect(res.body.data.token).toBeUndefined()
    // Login canonicalizes the flag so the Settings status card reads truthfully.
    const flag = (await db.query(`SELECT email_2fa_enabled FROM users WHERE id=$1`, [userId])).rows[0]
    expect(flag.email_2fa_enabled).toBe(true)
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
    // S578: universal 2FA — worker roles get an emailed code too. The scope
    // claims ride the pending-session JWT (and the full token after verify), so
    // downstream requireAuth has them once the code is entered.
    expect(res.body.data.requiresEmailOtp).toBe(true)
    const decoded = jwt.decode(res.body.data.emailOtpSession) as any
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

  it('S578: non-admin worker roles also get mandatory email 2FA (not a TOTP-enroll session)', async () => {
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
    // Universal 2FA supersedes the old mustEnrollTotp path — a worker gets an
    // emailed code, never a full token and never a forced authenticator enroll.
    expect(res.body.data.requiresEmailOtp).toBe(true)
    expect(res.body.data.token).toBeUndefined()
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
  it('happy: 201 with requiresEmailOtp (mandatory 2FA at signup) + tenant profile + ToS timestamps', async () => {
    const body = validProspect()
    const res = await request(buildApp())
      .post('/api/auth/register-prospect').send(body)
    expect(res.status).toBe(201)
    expect(res.body.data.user.role).toBe('tenant')
    expect(res.body.data.requiresEmailOtp).toBe(true)
    expect(res.body.data.emailOtpSession).toEqual(expect.any(String))

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

  it('landlordId in body stamps the pending 2FA session (for downstream lease attribution)', async () => {
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
    const decoded = jwt.decode(res.body.data.emailOtpSession) as any
    expect(decoded.landlordId).toBe(landlordId)
  })

  it('no landlordId → pending session carries landlordId=null (does not throw)', async () => {
    const res = await request(buildApp())
      .post('/api/auth/register-prospect').send(validProspect())
    expect(res.status).toBe(201)
    const decoded = jwt.decode(res.body.data.emailOtpSession) as any
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

  it('S578: issues an email 2FA code (login_email_otps row), not a verify link', async () => {
    const body = validProspect()
    await request(buildApp())
      .post('/api/auth/register-prospect').send(body)
    await new Promise(r => setTimeout(r, 50))
    // The emailed 2FA code doubles as verification once entered — no separate
    // verification-LINK email is sent at signup.
    expect(sendVerifyMock).not.toHaveBeenCalled()
    const { rows: otps } = await db.query<any>(
      `SELECT o.id FROM login_email_otps o JOIN users u ON u.id = o.user_id
        WHERE u.email = $1 AND o.consumed_at IS NULL`, [body.email])
    expect(otps.length).toBeGreaterThanOrEqual(1)
  })
})

// ─── S637: a sign-in code must not be readable in the email log ──────────────
//
// email_send_log is PERMANENT by design — triggers refuse UPDATE and DELETE so
// an outreach record cannot be rewritten after the fact. Putting the code in the
// subject therefore wrote 183 live second factors into a table any admin can
// read and every nightly backup carries. A second factor that anyone with
// database access can read is not a second factor.
describe('S637 login codes stay out of the permanent log', () => {
  it('logs the send without logging the code', async () => {
    const { emailLoginCode } = await import('../services/email')
    await emailLoginCode('code-check@test.dev', '424242', 10, { userId: undefined })

    const { rows } = await db.query<{ subject: string; body_text: string | null }>(
      `SELECT subject, body_text FROM email_send_log
        WHERE to_email = 'code-check@test.dev' ORDER BY created_at DESC LIMIT 1`)
    expect(rows).toHaveLength(1)
    // The send is still recorded — we know a code went out, and when.
    expect(rows[0].subject).toMatch(/sign-in code/i)
    // But the code itself is nowhere in the row.
    expect(rows[0].subject).not.toMatch(/424242/)
    expect(rows[0].body_text ?? '').not.toMatch(/424242/)
  })

  it('no six-digit code sits in any logged subject', async () => {
    const { emailLoginCode } = await import('../services/email')
    await emailLoginCode('code-check2@test.dev', '987654', 10, { userId: undefined })
    const { rows } = await db.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM email_send_log
        WHERE category = 'login_2fa_code' AND subject ~ '[0-9]{6}'
          AND created_at > NOW() - INTERVAL '1 minute'`)
    expect(Number(rows[0].n)).toBe(0)
  })
})

// ─── S639: A VERIFICATION LINK MUST LAND IN THE RIGHT PRODUCT ───────────────
//
// Nic: "add the other admins on the admin portal. Point their login to not the
// local host. Point it to the right thing. Every time they log in, it just shows
// them nothing."
//
// Login refuses an unverified account and auto-resends the verification email —
// so a link pointed at the wrong product is an account nobody can ever get into.
// The role branch handled landlord and property_manager and let EVERYTHING else
// fall through to the tenant app, admins included. Ben Ferrell and Nicholas
// Fausett, both super_admins, were mailed tenant.goldassetmanagement.com three
// times and never once reached a login code.
describe('S639 verification link is routed by role', () => {
  const origEnv = { ...process.env }
  afterEach(() => { process.env = { ...origEnv } })

  it('sends an admin to the ADMIN portal, not the tenant app', async () => {
    process.env.ADMIN_APP_URL = 'https://admin.example.test'
    process.env.TENANT_APP_URL = 'https://tenant.example.test'
    process.env.LANDLORD_APP_URL = 'https://landlord.example.test'
    delete process.env.VERIFY_EMAIL_URL

    for (const role of ['admin', 'super_admin']) {
      const email = `s639-${role}-${randomUUID().slice(0, 6)}@test.dev`
      const { rows: [u] } = await db.query<{ id: string }>(
        `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
         VALUES ($1,'x',$2,'A','B',FALSE) RETURNING id`, [email, role])
      sendVerifyMock.mockClear()
      await mintAndSendVerifyEmail(u.id, email, 'A')
      // sendEmailVerification(to, firstName, verifyUrl, ctx)
      const url = String(sendVerifyMock.mock.calls.at(-1)?.[2] ?? '')
      expect(url).toContain('https://admin.example.test/verify-email')
      expect(url).not.toContain('tenant.example.test')
    }
  })

  it('still sends a landlord to the landlord portal and a tenant to the tenant app', async () => {
    process.env.ADMIN_APP_URL = 'https://admin.example.test'
    process.env.TENANT_APP_URL = 'https://tenant.example.test'
    process.env.LANDLORD_APP_URL = 'https://landlord.example.test'
    delete process.env.VERIFY_EMAIL_URL

    const cases: Array<[string, string]> = [
      ['landlord', 'https://landlord.example.test/verify-email'],
      ['tenant',   'https://tenant.example.test/verify-email'],
    ]
    for (const [role, expected] of cases) {
      const email = `s639-${role}-${randomUUID().slice(0, 6)}@test.dev`
      const { rows: [u] } = await db.query<{ id: string }>(
        `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
         VALUES ($1,'x',$2,'A','B',FALSE) RETURNING id`, [email, role])
      sendVerifyMock.mockClear()
      await mintAndSendVerifyEmail(u.id, email, 'A')
      expect(String(sendVerifyMock.mock.calls.at(-1)?.[2] ?? '')).toContain(expected)
    }
  })
})

// ─── S639 OUTAGE: AN ADDRESS IS THE SAME ADDRESS ────────────────────────────
//
// Nic: "we are all getting invalid credentials during login now… it is both
// Nicks locked out."
//
// Nobody was locked — locked_until was null on every admin account. Login
// compared the typed email RAW against users.email, an exact case-sensitive
// match, while every stored address is lowercase. A phone keyboard capitalising
// the first letter was enough to make the lookup miss, and a miss returns the
// deliberately vague "Invalid credentials" with no hint that the ADDRESS was
// wrong. The API log proved it: those 401s returned in 5-12ms, far too fast for
// bcrypt to have run.
describe('S639 login is case- and whitespace-insensitive on the address', () => {
  it('signs in when the keyboard capitalised the address', async () => {
    const email = `s639-case-${randomUUID().slice(0, 8)}@test.dev`
    const password = 'CorrectHorse!2026'
    await db.query(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
       VALUES ($1, $2, 'tenant', 'A', 'B', TRUE)`,
      [email, await bcrypt.hash(password, 10)])

    for (const typed of [email.toUpperCase(), email[0].toUpperCase() + email.slice(1), `  ${email} `]) {
      const res = await request(buildApp()).post('/api/auth/login').send({ email: typed, password })
      // 200 with a code challenge is a SUCCESSFUL credential check — email 2FA
      // is universal now, so the win condition is "not 401", not "has a token".
      expect(res.status, `typed as ${JSON.stringify(typed)}`).toBe(200)
    }
  })

  it('still refuses a genuinely wrong password', async () => {
    const email = `s639-wrong-${randomUUID().slice(0, 8)}@test.dev`
    await db.query(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
       VALUES ($1, $2, 'tenant', 'A', 'B', TRUE)`,
      [email, await bcrypt.hash('CorrectHorse!2026', 10)])
    const res = await request(buildApp()).post('/api/auth/login')
      .send({ email: email.toUpperCase(), password: 'not-the-password' })
    expect(res.status).toBe(401)
  })
})

// ─── S639: A RESET LINK GOES TO THE PORTAL YOU ACTUALLY SIGN IN TO ──────────
//
// Nic: "the link you sent me is a password reset request for the landlord page,
// not for my admin login. Why is that the case?"
//
// With no recognised Origin the link fell to a fixed default with no regard for
// WHO was resetting, so an admin was handed a link into a product they do not
// log in to. Origin still wins when we recognise it — the portal that served the
// form is the best answer, and echoing only allow-listed origins is what keeps a
// forged Origin from redirecting a live reset token.
describe('S639 password reset link is routed by role when there is no Origin', () => {
  const orig = { ...process.env }
  afterEach(() => { process.env = { ...orig } })

  async function resetLinkFor(role: string, origin?: string): Promise<string> {
    process.env.ADMIN_APP_URL = 'https://admin.example.test'
    process.env.LANDLORD_APP_URL = 'https://landlord.example.test'
    process.env.TENANT_APP_URL = 'https://tenant.example.test'
    const email = `s639-reset-${role}-${randomUUID().slice(0, 6)}@test.dev`
    await db.query(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
       VALUES ($1,'x',$2,'A','B',TRUE)`, [email, role])
    sendResetMock.mockClear()
    const r = request(buildApp()).post('/api/auth/forgot-password')
    if (origin) r.set('Origin', origin)
    await r.send({ email })
    // sendPasswordResetEmail(to, firstName, resetUrl, ctx)
    return String(sendResetMock.mock.calls.at(-1)?.[2] ?? '')
  }

  it('sends an admin to the admin portal, not the landlord one', async () => {
    for (const role of ['admin', 'super_admin']) {
      const url = await resetLinkFor(role)
      expect(url).toContain('https://admin.example.test/reset-password')
      expect(url).not.toContain('landlord.example.test')
    }
  })

  it('sends a landlord to the landlord portal and a tenant to the tenant app', async () => {
    expect(await resetLinkFor('landlord')).toContain('https://landlord.example.test/reset-password')
    expect(await resetLinkFor('tenant')).toContain('https://tenant.example.test/reset-password')
  })

  it('a recognised Origin still wins — the portal that served the form knows best', async () => {
    const url = await resetLinkFor('super_admin', 'https://landlord.example.test')
    expect(url).toContain('https://landlord.example.test/reset-password')
  })

  it('an unrecognised Origin is ignored, so a forged one cannot capture the token', async () => {
    const url = await resetLinkFor('super_admin', 'https://evil.example.com')
    expect(url).toContain('https://admin.example.test/reset-password')
    expect(url).not.toContain('evil.example.com')
  })
})

// ─── S639 SECURITY: PER-USER RESPONSES ARE NEVER CACHEABLE ──────────────────
//
// Nick Platt accepted his invite on a browser where another household member was
// already signed in and landed in THEIR profile. The client query cache was the
// main culprit and is fixed in every portal, but the API log showed the other
// half: /api/tenants/me and /api/auth/me answering 304, which means a browser
// revalidating a cached body rather than fetching a fresh one. On a shared
// device with a changed identity that is a second route to the same leak.
describe('S639 API responses are not cacheable', () => {
  it('sends no-store on API responses, so no browser reuses one user for another', async () => {
    const app = buildApp()
    const res = await request(app).post('/api/auth/login').send({ email: 'nobody@test.dev', password: 'x' })
    expect(String(res.headers['cache-control'] || '')).toMatch(/no-store/)
  })
})
