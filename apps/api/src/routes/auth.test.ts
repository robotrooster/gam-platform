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
import { readFileSync } from 'fs'
import { join } from 'path'

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
import { authRouter, mintAndSendVerifyEmail, RENEWAL_LOCKED_STATUS } from './auth'
import { isAuthRejection } from '@gam/shared'
import { signEmailFactorToken, signEmailOtpSessionToken, emailOtpRouter, issueEmailOtp } from './emailOtp'
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
  // S654 (Nic): "your most recent deploy signed me out." A session was a fixed
  // 7-day pass; the portals now renew it while in use. The renewed pass is
  // REBUILT from the database — a company the account was added to since the
  // old pass shows up on it, instead of never.
  it('happy: renews the pass from the database, not from the old claims', async () => {
    const hash = await bcrypt.hash('super-strong-password-12!', 12)
    const { rows: [u] } = await db.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
       VALUES ($1, $2, 'landlord', 'Re', 'New', TRUE) RETURNING id`, [`refresh-${randomUUID()}@example.com`, hash])
    const { rows: [l1] } = await db.query<{ id: string }>(`INSERT INTO landlords (user_id) VALUES ($1) RETURNING id`, [u.id])
    const old = jwt.sign({ userId: u.id, role: 'landlord', email: 'r@test.dev', profileId: null, landlordIds: [l1.id] },
      process.env.JWT_SECRET!, { expiresIn: '1h' })
    // Added to a second company AFTER the old pass was minted.
    const c = await db.connect()
    let l2 = ''
    try {
      await c.query('BEGIN'); l2 = (await seedLandlord(c)).landlordId
      await c.query(`INSERT INTO landlord_members (landlord_id, user_id, role) VALUES ($1, $2, 'owner')`, [l2, u.id])
      await c.query('COMMIT')
    } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
    const res = await request(buildApp())
      .post('/api/auth/refresh').set('Authorization', `Bearer ${old}`).send({})
    expect(res.status).toBe(200)
    const decoded = jwt.decode(res.body.data.token) as any
    expect(decoded.userId).toBe(u.id)
    expect(decoded.role).toBe('landlord')
    expect(decoded.purpose).toBeUndefined()
    expect([...decoded.landlordIds].sort()).toEqual([l1.id, l2].sort())
    expect(decoded.exp - decoded.iat).toBe(7 * 24 * 3600)
  })

  it('a pass minted before a password change is refused at /me and cannot renew', async () => {
    const hash = await bcrypt.hash('super-strong-password-12!', 12)
    const { rows: [u] } = await db.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
       VALUES ($1, $2, 'tenant', 'Re', 'Set', TRUE) RETURNING id`, [`reset-${randomUUID()}@example.com`, hash])
    await db.query(`INSERT INTO tenants (user_id) VALUES ($1)`, [u.id])
    const before = jwt.sign({ userId: u.id, role: 'tenant', email: 'x@test.dev', profileId: null, iat: Math.floor(Date.now() / 1000) - 120 },
      process.env.JWT_SECRET!, { expiresIn: '1h' })
    await db.query(`UPDATE users SET sessions_valid_from = NOW() WHERE id = $1`, [u.id])   // what every password write does
    const me = await request(buildApp()).get('/api/auth/me').set('Authorization', `Bearer ${before}`)
    expect(me.status).toBe(401)
    const r = await request(buildApp()).post('/api/auth/refresh').set('Authorization', `Bearer ${before}`).send({})
    expect(r.status).toBe(401)
    const after = jwt.sign({ userId: u.id, role: 'tenant', email: 'x@test.dev', profileId: null, iat: Math.floor(Date.now() / 1000) + 5 },
      process.env.JWT_SECRET!, { expiresIn: '1h' })
    expect((await request(buildApp()).get('/api/auth/me').set('Authorization', `Bearer ${after}`)).status).toBe(200)
  })

  it('an account that no longer exists cannot renew', async () => {
    const token = jwt.sign({ userId: randomUUID(), role: 'landlord', email: 'gone@test.dev', profileId: null },
      process.env.JWT_SECRET!, { expiresIn: '1h' })
    const res = await request(buildApp())
      .post('/api/auth/refresh').set('Authorization', `Bearer ${token}`).send({})
    expect(res.status).toBe(401)
  })

  it('no auth → 401', async () => {
    const res = await request(buildApp()).post('/api/auth/refresh').send({})
    expect(res.status).toBe(401)
  })

  // Final sweep (10/3): A LOCK IS NOT A SIGN-OUT. A lock answered the renewal
  // 401, every portal reads a 401 from renewal as "this pass is dead", and a
  // tenant signed in on their phone was thrown out without a word.
  async function lockedTenantWithPass(): Promise<{ userId: string; pass: string }> {
    const { rows: [u] } = await db.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
       VALUES ($1, 'x', 'tenant', 'Lo', 'Cked', TRUE) RETURNING id`, [`locked-${randomUUID()}@example.com`])
    await db.query(`INSERT INTO tenants (user_id) VALUES ($1)`, [u.id])
    // A pass signed two days ago: old enough that the app asks to renew it.
    const pass = jwt.sign({ userId: u.id, role: 'tenant', email: 'l@test.dev', profileId: null,
      iat: Math.floor(Date.now() / 1000) - 2 * 86400 }, process.env.JWT_SECRET!, { expiresIn: '7d' })
    await db.query(`UPDATE users SET failed_login_count = 5, locked_until = NOW() + INTERVAL '10 minutes' WHERE id = $1`, [u.id])
    return { userId: u.id, pass }
  }

  it('a temporary lock answers "locked" (423), not a rejection: the pass stays good and renews after the lock', async () => {
    const { userId, pass } = await lockedTenantWithPass()
    const r = await request(buildApp()).post('/api/auth/refresh').set('Authorization', `Bearer ${pass}`).send({})
    expect(r.status).toBe(RENEWAL_LOCKED_STATUS)
    expect(r.status).toBe(423)
    expect(r.body.success).toBe(false)
    expect(r.body.data).toBeUndefined()           // no new pass while locked
    expect(r.body.error).toBe('Your account is temporarily locked after too many sign-in attempts. You are still signed in; '
      + 'your sign-in renews on its own once the lock ends.')
    // The rule every portal's renewal uses to decide on a sign-out lets it go.
    expect(isAuthRejection({ response: { status: r.status } })).toBe(false)
    // The pass the app holds keeps working.
    expect((await request(buildApp()).get('/api/auth/me').set('Authorization', `Bearer ${pass}`)).status).toBe(200)
    // The lock ends; the next renewal goes through.
    await db.query(`UPDATE users SET locked_until = NOW() - INTERVAL '1 minute' WHERE id = $1`, [userId])
    const after = await request(buildApp()).post('/api/auth/refresh').set('Authorization', `Bearer ${pass}`).send({})
    expect(after.status).toBe(200)
    expect((jwt.decode(after.body.data.token) as any).userId).toBe(userId)
  })

  // The tenant app keeps its own copy of the "locked" answer (it cannot import
  // the API). If one copy changed and the other did not, the app would stop
  // reading a lock as "keep the pass". This pins the two together until the
  // number moves into @gam/shared.
  it('the tenant app\'s "locked" answer is the same number the API sends', () => {
    const tenantRenewal = readFileSync(join(__dirname, '../../../tenant/src/lib/sessionRenewal.ts'), 'utf8')
    const m = tenantRenewal.match(/export const RENEWAL_LOCKED_STATUS\s*=\s*(\d+)/)
    expect(m, 'apps/tenant/src/lib/sessionRenewal.ts no longer declares RENEWAL_LOCKED_STATUS').not.toBeNull()
    expect(Number(m![1])).toBe(RENEWAL_LOCKED_STATUS)
  })

  it('a lock never shields a pass a password change revoked: still 401', async () => {
    const { userId, pass } = await lockedTenantWithPass()
    await db.query(`UPDATE users SET sessions_valid_from = NOW() WHERE id = $1`, [userId])
    const r = await request(buildApp()).post('/api/auth/refresh').set('Authorization', `Bearer ${pass}`).send({})
    expect(r.status).toBe(401)
    expect(r.body.error).toBe('Your password was changed. Please sign in again.')
  })

  it('a lock never shields a worker whose access was pulled: still 403', async () => {
    const { rows: [u] } = await db.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified, locked_until)
       VALUES ($1, 'x', 'property_manager', 'Pulled', 'Worker', TRUE, NOW() + INTERVAL '10 minutes') RETURNING id`,
      [`pulled-${randomUUID()}@example.com`])
    const pass = jwt.sign({ userId: u.id, role: 'property_manager', email: 'p@test.dev', profileId: null },
      process.env.JWT_SECRET!, { expiresIn: '1h' })
    const r = await request(buildApp()).post('/api/auth/refresh').set('Authorization', `Bearer ${pass}`).send({})
    expect(r.status).toBe(403)
  })
})

// ═══════════════════════════════════════════════════════════════
//  S654: the bill email's link as the email step
// ═══════════════════════════════════════════════════════════════
//
// Nic: "if there's a way that the … invoice link email can contain a bypass
// where they can just get on and pay their bill." Opening the link proves the
// inbox — the thing the emailed code proves — so the password alone finishes
// the sign-in. Both factors, no app-switching on a phone.

describe('POST /api/auth/login with the bill link (emailFactor)', () => {
  async function seedTenantUser(): Promise<{ userId: string; email: string }> {
    const email = `ef-${randomUUID()}@example.com`
    const hash = await bcrypt.hash('super-strong-password-12!', 12)
    const { rows: [u] } = await db.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified, email_2fa_enabled)
       VALUES ($1, $2, 'tenant', 'Pay', 'Er', TRUE, TRUE) RETURNING id`, [email, hash])
    await db.query(`INSERT INTO tenants (user_id) VALUES ($1)`, [u.id])
    return { userId: u.id, email }
  }

  it('password + the account\'s own bill link = signed in, no code', async () => {
    const t = await seedTenantUser()
    const res = await request(buildApp()).post('/api/auth/login')
      .send({ email: t.email, password: 'super-strong-password-12!', emailFactor: signEmailFactorToken({ userId: t.userId, email: t.email }) })
    expect(res.status).toBe(200)
    expect(res.body.data.requiresEmailOtp).toBeUndefined()
    expect(res.body.data.token).toEqual(expect.any(String))
    const decoded = jwt.decode(res.body.data.token) as any
    expect(decoded.userId).toBe(t.userId)
    expect(decoded.purpose).toBeUndefined()
    // No code was minted or mailed — the link was the inbox proof.
    expect((await db.query(`SELECT 1 FROM login_email_otps WHERE user_id = $1`, [t.userId])).rowCount).toBe(0)
  })

  it('the wrong password is still the wrong password, link or no link', async () => {
    const t = await seedTenantUser()
    const res = await request(buildApp()).post('/api/auth/login')
      .send({ email: t.email, password: 'nope', emailFactor: signEmailFactorToken({ userId: t.userId, email: t.email }) })
    expect(res.status).toBe(401)
  })

  it('someone else\'s bill link proves nothing about you — the code is asked for', async () => {
    const me = await seedTenantUser()
    const other = await seedTenantUser()
    const res = await request(buildApp()).post('/api/auth/login')
      .send({ email: me.email, password: 'super-strong-password-12!', emailFactor: signEmailFactorToken({ userId: other.userId, email: other.email }) })
    expect(res.status).toBe(200)
    expect(res.body.data.requiresEmailOtp).toBe(true)
    expect(res.body.data.token).toBeUndefined()
  })

  it('an expired link, or a pending-code token passed off as one, means the code', async () => {
    const t = await seedTenantUser()
    const expired = jwt.sign({ userId: t.userId, email: t.email, purpose: 'email_factor' }, process.env.JWT_SECRET!, { expiresIn: -10 })
    const r1 = await request(buildApp()).post('/api/auth/login')
      .send({ email: t.email, password: 'super-strong-password-12!', emailFactor: expired })
    expect(r1.body.data.requiresEmailOtp).toBe(true)
    const pending = signEmailOtpSessionToken({ userId: t.userId, role: 'tenant', email: t.email, profileId: null })
    const r2 = await request(buildApp()).post('/api/auth/login')
      .send({ email: t.email, password: 'super-strong-password-12!', emailFactor: pending })
    expect(r2.body.data.requiresEmailOtp).toBe(true)
    const r3 = await request(buildApp()).post('/api/auth/login')
      .send({ email: t.email, password: 'super-strong-password-12!', emailFactor: 'garbage' })
    expect(r3.body.data.requiresEmailOtp).toBe(true)
  })

  it('an authenticator app is never replaced by the link', async () => {
    const t = await seedTenantUser()
    await db.query(`UPDATE users SET totp_enabled = TRUE, totp_secret = 'JBSWY3DPEHPK3PXP' WHERE id = $1`, [t.userId])
    const res = await request(buildApp()).post('/api/auth/login')
      .send({ email: t.email, password: 'super-strong-password-12!', emailFactor: signEmailFactorToken({ userId: t.userId, email: t.email }) })
    expect(res.status).toBe(200)
    expect(res.body.data.requiresTotp).toBe(true)
    expect(res.body.data.token).toBeUndefined()
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

  // ── S642: THE INLINE APPLICANT FLOW ──────────────────────────────────────
  //
  // Nic: "Can people pay for the background check, start the workflow, and have
  // their tenant portal be created off of the information in the background
  // check?… They never have a spot to type in their name. We're gonna generate
  // accounts off a legal name."
  //
  // The account step is now the front of the screening form, so it creates the
  // account from EMAIL + PASSWORD only and must hand back a usable session — a
  // 6-digit code would stop the applicant mid-form to go hunting in their inbox,
  // and the next step mints a Stripe PaymentIntent that needs the token.
  describe('inline: true (account step inside the screening form)', () => {
    it('creates the account from email + password alone — no name required', async () => {
      const email = `inline-${Date.now()}@gam.dev`
      const res = await request(buildApp())
        .post('/api/auth/register-prospect')
        .send({ email, password: 'correct horse battery', acceptedTerms: true, inline: true })
      expect(res.status).toBe(201)
      const { rows: [u] } = await db.query<any>(
        `SELECT first_name, last_name, role FROM users WHERE email = $1`, [email])
      expect(u.role).toBe('tenant')
      // Empty, NOT a name we invented. The screener supplies the real one.
      expect(u.first_name).toBe('')
      expect(u.last_name).toBe('')
    })

    it('returns a REAL session, not a pending 2FA one', async () => {
      const email = `inline-sess-${Date.now()}@gam.dev`
      const res = await request(buildApp())
        .post('/api/auth/register-prospect')
        .send({ email, password: 'correct horse battery', acceptedTerms: true, inline: true })
      expect(res.body.data.requiresEmailOtp).toBe(false)
      expect(res.body.data.token).toEqual(expect.any(String))
      const claims = jwt.decode(res.body.data.token) as any
      expect(claims.role).toBe('tenant')
      expect(claims.profileId).toEqual(expect.any(String))
    })

    it('still arms 2FA for every LATER sign-in', async () => {
      // The code was never protecting account creation — the rows are written
      // either way. It protects returning logins to an account that by then
      // holds a screening report. That has to survive the inline path.
      const email = `inline-2fa-${Date.now()}@gam.dev`
      await request(buildApp())
        .post('/api/auth/register-prospect')
        .send({ email, password: 'correct horse battery', acceptedTerms: true, inline: true })
      const { rows: [u] } = await db.query<any>(
        `SELECT email_2fa_enabled, email_verified FROM users WHERE email = $1`, [email])
      expect(u.email_2fa_enabled).toBe(true)
      expect(u.email_verified).toBe(false)
    })

    it('a password is still required, and still has to be strong', async () => {
      const res = await request(buildApp())
        .post('/api/auth/register-prospect')
        .send({ email: `inline-weak-${Date.now()}@gam.dev`, password: 'short', acceptedTerms: true, inline: true })
      expect(res.status).toBe(400)
    })

    it('terms are still required', async () => {
      const res = await request(buildApp())
        .post('/api/auth/register-prospect')
        .send({ email: `inline-tos-${Date.now()}@gam.dev`, password: 'correct horse battery', inline: true })
      expect(res.status).toBe(400)
    })

    it('WITHOUT inline, a name is still required (the old contract is intact)', async () => {
      const res = await request(buildApp())
        .post('/api/auth/register-prospect')
        .send({ email: `noinline-${Date.now()}@gam.dev`, password: 'correct horse battery', acceptedTerms: true })
      expect(res.status).toBe(400)
    })
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
// match, while every stored address is lowercase. A phone keyboard capitalizing
// the first letter was enough to make the lookup miss, and a miss returns the
// deliberately vague "Invalid credentials" with no hint that the ADDRESS was
// wrong. The API log proved it: those 401s returned in 5-12ms, far too fast for
// bcrypt to have run.
describe('S639 login is case- and whitespace-insensitive on the address', () => {
  it('signs in when the keyboard capitalized the address', async () => {
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

// ─── S650: A COMPLETED PASSWORD RESET PROVES THE ADDRESS ────────────────────
// Ellen Gregory (Oak Park MH 02) reset her password from the link in her inbox
// and then could not sign in: her account was never email-verified, so login
// answered "verify your email first" on a password she had just set.
describe('S650 resetting the password verifies the email', () => {
  it('signs in straight after a reset on a never-verified account', async () => {
    const email = `s650-reset-${randomUUID().slice(0, 8)}@test.dev`
    const { rows: [u] } = await db.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified, reset_token, reset_token_expires)
       VALUES ($1, 'x', 'tenant', 'Ellen', 'Gregory', FALSE, 'tok-s650', NOW() + interval '1 hour') RETURNING id`, [email])
    await db.query(`INSERT INTO tenants (user_id) VALUES ($1)`, [u.id])

    const reset = await request(buildApp()).post('/api/auth/reset-password')
      .send({ token: 'tok-s650', newPassword: 'CorrectHorse!2026' })
    expect(reset.status).toBe(200)
    const after = (await db.query(`SELECT email_verified, email_verified_at FROM users WHERE id=$1`, [u.id])).rows[0]
    expect(after.email_verified).toBe(true)
    expect(after.email_verified_at).not.toBeNull()

    const login = await request(buildApp()).post('/api/auth/login')
      .send({ email, password: 'CorrectHorse!2026' })
    expect(login.status).toBe(200)            // reaches the 2FA step, not the verify wall
    expect(login.body.data.requiresEmailOtp).toBe(true)
  })
})

// ─── S650: THE ADMIN CONSOLE SIGNS IN STAFF ONLY ─────────────────────────────
// A browser autofilled Nic's landlord address into the admin login; the
// password matched the landlord account and the 2FA code went to the landlord
// inbox. The console now says which portal it is, and a non-staff account is
// refused BEFORE any code is issued.
describe('S650 staff consoles refuse non-staff accounts before sending a code', () => {
  async function user(role: string): Promise<{ email: string; password: string }> {
    const email = `s650-${role}-${randomUUID().slice(0, 8)}@test.dev`
    const password = 'CorrectHorse!2026'
    await db.query(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
       VALUES ($1, $2, $3, 'A', 'B', TRUE)`, [email, await bcrypt.hash(password, 10), role])
    return { email, password }
  }

  it('a landlord at the admin console gets a 403 and no code', async () => {
    const { email, password } = await user('landlord')
    const res = await request(buildApp()).post('/api/auth/login').send({ email, password, portal: 'admin' })
    expect(res.status).toBe(403)
    expect(res.body.data?.emailOtpSession).toBeUndefined()
    const codes = await db.query(
      `SELECT 1 FROM login_email_otps c JOIN users u ON u.id = c.user_id WHERE u.email = $1`, [email])
    expect(codes.rows).toHaveLength(0)
  })

  it('an admin at the admin console proceeds to the second factor', async () => {
    const { email, password } = await user('admin')
    const res = await request(buildApp()).post('/api/auth/login').send({ email, password, portal: 'admin' })
    expect(res.status).toBe(200)
  })

  it('a portfolio manager may use admin-ops but not the full admin console', async () => {
    const { email, password } = await user('portfolio_manager')
    const ops = await request(buildApp()).post('/api/auth/login').send({ email, password, portal: 'admin_ops' })
    expect(ops.status).toBe(200)
    const full = await request(buildApp()).post('/api/auth/login').send({ email, password, portal: 'admin' })
    expect(full.status).toBe(403)
  })

  it('a landlord signing in with no portal named is unaffected', async () => {
    const { email, password } = await user('landlord')
    const res = await request(buildApp()).post('/api/auth/login').send({ email, password })
    expect(res.status).toBe(200)
  })
})

// ─── S639: A RESET LINK GOES TO THE PORTAL YOU ACTUALLY SIGN IN TO ──────────
//
// Nic: "the link you sent me is a password reset request for the landlord page,
// not for my admin login. Why is that the case?"
//
// With no recognized Origin the link fell to a fixed default with no regard for
// WHO was resetting, so an admin was handed a link into a product they do not
// log in to. Origin still wins when we recognize it — the portal that served the
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

  it('a recognized Origin still wins — the portal that served the form knows best', async () => {
    const url = await resetLinkFor('super_admin', 'https://landlord.example.test')
    expect(url).toContain('https://landlord.example.test/reset-password')
  })

  it('an unrecognized Origin is ignored, so a forged one cannot capture the token', async () => {
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

// ─── S655: STAFF AND BOOKS SIGN-INS END A SET TIME AFTER SIGN-IN ────────────
//
// Nic: sign-ins on the admin console, Support (admin-ops) and GAM Books end
// after a set time even while in use, unless the person ticks "Keep me signed
// in on this device". Every other portal keeps renewing while in use (S654).
// The policy rides inside the pass (`sp`), and /refresh refuses to extend a
// fixed one — the browser declining to ask is not the only guard.
describe('S655 session length: fixed at the staff consoles and Books unless kept', () => {
  const PW = 'CorrectHorse!2026'
  const SEVEN_DAYS = 7 * 24 * 3600

  async function person(role: string): Promise<{ id: string; email: string }> {
    const email = `s655-${role}-${randomUUID().slice(0, 8)}@test.dev`
    const { rows: [u] } = await db.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
       VALUES ($1, $2, $3, 'A', 'B', TRUE) RETURNING id`, [email, await bcrypt.hash(PW, 10), role])
    if (role === 'landlord') await db.query(`INSERT INTO landlords (user_id) VALUES ($1)`, [u.id])
    if (role === 'tenant') await db.query(`INSERT INTO tenants (user_id) VALUES ($1)`, [u.id])
    return { id: u.id, email }
  }

  /** Password, then the emailed code — the whole sign-in. Returns the full pass. */
  async function signIn(u: { id: string; email: string }, body: Record<string, unknown> = {}): Promise<any> {
    const app = express()
    app.use(express.json())
    app.use('/api/auth/email-otp', emailOtpRouter)
    app.use('/api/auth', authRouter)
    app.use(errorHandler)
    const login = await request(app).post('/api/auth/login').send({ email: u.email, password: PW, ...body })
    expect(login.status).toBe(200)
    const pending = jwt.decode(login.body.data.emailOtpSession) as any
    const code = await issueEmailOtp(u.id, u.email, { skipSend: true })
    const done = await request(app).post('/api/auth/email-otp/verify')
      .send({ emailOtpSession: login.body.data.emailOtpSession, code })
    expect(done.status).toBe(200)
    return { pending, token: done.body.data.token as string, pass: jwt.decode(done.body.data.token) as any }
  }

  const refresh = (token: string) =>
    request(buildApp()).post('/api/auth/refresh').set('Authorization', `Bearer ${token}`).send({})

  it('the admin console without "keep me signed in" gives a fixed pass, and renewing it never moves the end', async () => {
    const admin = await person('super_admin')
    const s = await signIn(admin, { portal: 'admin' })
    expect(s.pending.sp).toBe('fixed')
    expect(s.pass.sp).toBe('fixed')
    expect(s.pass.exp - s.pass.iat).toBe(SEVEN_DAYS)
    await new Promise(r => setTimeout(r, 1100))   // a renewal a second later would otherwise read as the same exp by luck
    const r = await refresh(s.token)
    expect(r.status).toBe(200)
    const renewed = jwt.decode(r.body.data.token) as any
    expect(renewed.sp).toBe('fixed')
    expect(renewed.exp).toBe(s.pass.exp)
  })

  it('ticking "keep me signed in" at the admin console makes it renew like any other portal', async () => {
    const admin = await person('admin')
    const s = await signIn(admin, { portal: 'admin', keepSignedIn: true })
    expect(s.pass.sp).toBe('rolling')
    await new Promise(r => setTimeout(r, 1100))
    const renewed = jwt.decode((await refresh(s.token)).body.data.token) as any
    expect(renewed.sp).toBe('rolling')
    expect(renewed.exp).toBeGreaterThan(s.pass.exp)
    expect(renewed.exp - renewed.iat).toBe(SEVEN_DAYS)
  })

  it('Support (admin-ops) is fixed by default too', async () => {
    const pm = await person('portfolio_manager')
    const s = await signIn(pm, { portal: 'admin_ops' })
    expect(s.pass.sp).toBe('fixed')
  })

  it('an admin pass minted before this change (no policy on it) is not extended by renewing', async () => {
    const admin = await person('super_admin')
    const exp = Math.floor(Date.now() / 1000) + 3600
    const old = jwt.sign({ userId: admin.id, role: 'super_admin', email: admin.email, profileId: null, exp },
      process.env.JWT_SECRET!)
    const r = await refresh(old)
    expect(r.status).toBe(200)
    const renewed = jwt.decode(r.body.data.token) as any
    expect(renewed.exp).toBe(exp)
    expect(renewed.sp).toBe('fixed')
  })

  it('an admin signing in at the landlord portal is fixed too — another portal cannot roll a staff pass', async () => {
    const admin = await person('super_admin')
    const s = await signIn(admin)
    expect(s.pass.sp).toBe('fixed')
  })

  it('a landlord at the landlord portal is unchanged: renewing, seven days from each renewal', async () => {
    const l = await person('landlord')
    const s = await signIn(l)
    expect(s.pass.sp).toBe('rolling')
    expect(s.pass.exp - s.pass.iat).toBe(SEVEN_DAYS)
    await new Promise(r => setTimeout(r, 1100))
    const renewed = jwt.decode((await refresh(s.token)).body.data.token) as any
    expect(renewed.exp).toBeGreaterThan(s.pass.exp)
  })

  it('GAM Books signs a landlord in on a fixed pass, or a renewing one when kept', async () => {
    const l = await person('landlord')
    expect((await signIn(l, { portal: 'books' })).pass.sp).toBe('fixed')
    expect((await signIn(l, { portal: 'books', keepSignedIn: true })).pass.sp).toBe('rolling')
  })

  it('GAM Books refuses a tenant or an admin before any code is emailed', async () => {
    for (const role of ['tenant', 'super_admin']) {
      const u = await person(role)
      const res = await request(buildApp()).post('/api/auth/login').send({ email: u.email, password: PW, portal: 'books' })
      expect(res.status).toBe(403)
      expect(res.body.data?.emailOtpSession).toBeUndefined()
      expect((await db.query(`SELECT 1 FROM login_email_otps WHERE user_id = $1`, [u.id])).rows).toHaveLength(0)
    }
  })

  it('the bill-link sign-in (no code) carries the policy too', async () => {
    const t = await person('tenant')
    await db.query(`UPDATE users SET email_2fa_enabled = TRUE WHERE id = $1`, [t.id])
    const res = await request(buildApp()).post('/api/auth/login')
      .send({ email: t.email, password: PW, emailFactor: signEmailFactorToken({ userId: t.id, email: t.email }) })
    expect((jwt.decode(res.body.data.token) as any).sp).toBe('rolling')
  })
})
