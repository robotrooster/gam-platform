/**
 * TOTP 2FA endpoints (S288).
 *
 * Covers enrollment (start → confirm), login gating, /verify with both
 * TOTP codes and recovery codes, disable, and the recovery-code
 * single-use guarantee.
 *
 * Approach: real otplib (not mocked) — generate a fresh TOTP token in
 * the test by feeding the same secret into `authenticator.generate()`.
 * This catches a class of bugs that mocks would silently mask (window
 * mismatches, secret encoding drift). Same posture as the lateFee
 * tests using real luxon for date math.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { authenticator } from 'otplib'
import { db } from '../db'
import { cleanupAllSchema } from '../test/dbHelpers'
import { authRouter } from './auth'
import { totpRouter } from './totp'
import { errorHandler } from '../middleware/errorHandler'

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/auth', authRouter)
  app.use('/api/auth/totp', totpRouter)
  app.use(errorHandler)
  return app
}

beforeEach(async () => {
  await cleanupAllSchema()
  await db.query(`DELETE FROM user_totp_recovery_codes`)
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_totp_2fa'
})

async function seedUser(args: {
  email:           string
  password:        string
  role?:           string
  totpEnabled?:    boolean
  totpSecret?:     string | null
  emailVerified?:  boolean
}): Promise<{ userId: string; token: string }> {
  const hash = await bcrypt.hash(args.password, 12)
  const res = await db.query<{ id: string }>(
    `INSERT INTO users
       (email, password_hash, role, first_name, last_name,
        email_verified, totp_enabled, totp_secret)
     VALUES ($1, $2, $3, 'Test', 'User', $4, $5, $6) RETURNING id`,
    [
      args.email, hash, args.role ?? 'tenant',
      args.emailVerified ?? true,
      args.totpEnabled ?? false,
      args.totpSecret ?? null,
    ],
  )
  const userId = res.rows[0].id
  const token = jwt.sign(
    { userId, role: args.role ?? 'tenant', email: args.email, profileId: null },
    process.env.JWT_SECRET!,
    { expiresIn: '1h' },
  )
  return { userId, token }
}

// ── /enroll-start + /enroll-confirm ────────────────────────────────────────

describe('POST /api/auth/totp/enroll-start', () => {
  it('returns secret + QR + 10 recovery codes; stores secret + hashed codes; does NOT flip totp_enabled', async () => {
    const { userId, token } = await seedUser({
      email: 'enroll@test.dev', password: 'pw123456789012',
    })

    const res = await request(buildApp())
      .post('/api/auth/totp/enroll-start')
      .set('Authorization', `Bearer ${token}`)
      .send({})
    expect(res.status).toBe(200)
    expect(res.body.data.otpauthUrl).toMatch(/^otpauth:\/\/totp\//)
    expect(res.body.data.qrDataUri).toMatch(/^data:image\/png;base64,/)
    expect(res.body.data.recoveryCodes).toHaveLength(10)
    // Codes look like `xxxxx-xxxxx` (10 hex with mid-hyphen)
    for (const code of res.body.data.recoveryCodes) {
      expect(code).toMatch(/^[a-f0-9]{5}-[a-f0-9]{5}$/)
    }

    const row = await db.query<{
      totp_secret: string | null; totp_enabled: boolean
    }>(`SELECT totp_secret, totp_enabled FROM users WHERE id=$1`, [userId])
    expect(row.rows[0].totp_secret).not.toBeNull()
    expect(row.rows[0].totp_secret!.length).toBeGreaterThan(10)
    expect(row.rows[0].totp_enabled).toBe(false)  // not enabled yet

    const codeRows = await db.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM user_totp_recovery_codes
        WHERE user_id=$1`, [userId]
    )
    expect(codeRows.rows[0].n).toBe('10')
  })

  it('rejects re-enroll when totp_enabled is already TRUE', async () => {
    const { token } = await seedUser({
      email: 'already-enabled@test.dev',
      password: 'pw123456789012',
      totpEnabled: true,
      totpSecret: authenticator.generateSecret(),
    })
    const res = await request(buildApp())
      .post('/api/auth/totp/enroll-start')
      .set('Authorization', `Bearer ${token}`)
      .send({})
    expect(res.status).toBe(409)
  })
})

describe('POST /api/auth/totp/enroll-confirm', () => {
  it('valid TOTP code flips totp_enabled=TRUE + stamps totp_enrolled_at', async () => {
    const { userId, token } = await seedUser({
      email: 'confirm@test.dev', password: 'pw123456789012',
    })
    // enroll-start to get the secret
    const startRes = await request(buildApp())
      .post('/api/auth/totp/enroll-start')
      .set('Authorization', `Bearer ${token}`)
      .send({})
    expect(startRes.status).toBe(200)

    // Pull the secret from DB, generate the current token.
    const secretRow = await db.query<{ totp_secret: string }>(
      `SELECT totp_secret FROM users WHERE id=$1`, [userId]
    )
    const currentToken = authenticator.generate(secretRow.rows[0].totp_secret)

    const confirm = await request(buildApp())
      .post('/api/auth/totp/enroll-confirm')
      .set('Authorization', `Bearer ${token}`)
      .send({ token: currentToken })
    expect(confirm.status).toBe(200)

    const row = await db.query<{
      totp_enabled: boolean; totp_enrolled_at: string | null
    }>(`SELECT totp_enabled, totp_enrolled_at FROM users WHERE id=$1`, [userId])
    expect(row.rows[0].totp_enabled).toBe(true)
    expect(row.rows[0].totp_enrolled_at).not.toBeNull()
  })

  it('invalid code: 400, totp_enabled stays FALSE', async () => {
    const { userId, token } = await seedUser({
      email: 'bad-confirm@test.dev', password: 'pw123456789012',
    })
    await request(buildApp())
      .post('/api/auth/totp/enroll-start')
      .set('Authorization', `Bearer ${token}`)
      .send({})

    const res = await request(buildApp())
      .post('/api/auth/totp/enroll-confirm')
      .set('Authorization', `Bearer ${token}`)
      .send({ token: '000000' })
    expect(res.status).toBe(400)

    const row = await db.query<{ totp_enabled: boolean }>(
      `SELECT totp_enabled FROM users WHERE id=$1`, [userId]
    )
    expect(row.rows[0].totp_enabled).toBe(false)
  })

  it('rejects when enroll-start was never called', async () => {
    const { token } = await seedUser({
      email: 'no-start@test.dev', password: 'pw123456789012',
    })
    const res = await request(buildApp())
      .post('/api/auth/totp/enroll-confirm')
      .set('Authorization', `Bearer ${token}`)
      .send({ token: '123456' })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/start enrollment/i)
  })
})

// ── /login gate + /verify ──────────────────────────────────────────────────

describe('POST /api/auth/login with TOTP enabled', () => {
  it('returns requiresTotp + totpSession instead of full token', async () => {
    const secret = authenticator.generateSecret()
    await seedUser({
      email: 'totp-user@test.dev', password: 'pw123456789012',
      totpEnabled: true, totpSecret: secret,
    })
    const res = await request(buildApp())
      .post('/api/auth/login')
      .send({ email: 'totp-user@test.dev', password: 'pw123456789012' })
    expect(res.status).toBe(200)
    expect(res.body.data.requiresTotp).toBe(true)
    expect(typeof res.body.data.totpSession).toBe('string')
    expect(res.body.data.token).toBeUndefined()
  })
})

describe('POST /api/auth/totp/verify', () => {
  it('valid TOTP code redeems full JWT', async () => {
    const secret = authenticator.generateSecret()
    await seedUser({
      email: 'verify@test.dev', password: 'pw123456789012',
      totpEnabled: true, totpSecret: secret,
    })
    const login = await request(buildApp())
      .post('/api/auth/login')
      .send({ email: 'verify@test.dev', password: 'pw123456789012' })
    const totpSession = login.body.data.totpSession as string
    const code = authenticator.generate(secret)

    const verify = await request(buildApp())
      .post('/api/auth/totp/verify')
      .send({ totpSession, code })
    expect(verify.status).toBe(200)
    expect(typeof verify.body.data.token).toBe('string')

    const decoded = jwt.verify(verify.body.data.token, process.env.JWT_SECRET!) as any
    expect(decoded.email).toBe('verify@test.dev')
    expect(decoded.purpose).toBeUndefined()  // full JWT, not totp_pending
  })

  it('invalid TOTP code: 401', async () => {
    const secret = authenticator.generateSecret()
    await seedUser({
      email: 'invalid-totp@test.dev', password: 'pw123456789012',
      totpEnabled: true, totpSecret: secret,
    })
    const login = await request(buildApp())
      .post('/api/auth/login')
      .send({ email: 'invalid-totp@test.dev', password: 'pw123456789012' })

    const res = await request(buildApp())
      .post('/api/auth/totp/verify')
      .send({ totpSession: login.body.data.totpSession, code: '000000' })
    expect(res.status).toBe(401)
  })

  it('recovery code redeems JWT + marks the code used', async () => {
    const { userId, token } = await seedUser({
      email: 'recovery@test.dev', password: 'pw123456789012',
    })
    const start = await request(buildApp())
      .post('/api/auth/totp/enroll-start')
      .set('Authorization', `Bearer ${token}`)
      .send({})
    const recoveryCodes = start.body.data.recoveryCodes as string[]

    // Confirm enrollment so login routes through /verify.
    const secret = (await db.query<{ totp_secret: string }>(
      `SELECT totp_secret FROM users WHERE id=$1`, [userId]
    )).rows[0].totp_secret
    await request(buildApp())
      .post('/api/auth/totp/enroll-confirm')
      .set('Authorization', `Bearer ${token}`)
      .send({ token: authenticator.generate(secret) })

    // Now log in + verify with a recovery code.
    const login = await request(buildApp())
      .post('/api/auth/login')
      .send({ email: 'recovery@test.dev', password: 'pw123456789012' })

    const usedCode = recoveryCodes[0]
    const verify = await request(buildApp())
      .post('/api/auth/totp/verify')
      .send({ totpSession: login.body.data.totpSession, code: usedCode })
    expect(verify.status).toBe(200)
    expect(typeof verify.body.data.token).toBe('string')

    // One code used.
    const used = await db.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM user_totp_recovery_codes
        WHERE user_id=$1 AND used_at IS NOT NULL`,
      [userId],
    )
    expect(used.rows[0].n).toBe('1')

    // Second attempt with the same code: fails (single-use).
    const login2 = await request(buildApp())
      .post('/api/auth/login')
      .send({ email: 'recovery@test.dev', password: 'pw123456789012' })
    const replay = await request(buildApp())
      .post('/api/auth/totp/verify')
      .send({ totpSession: login2.body.data.totpSession, code: usedCode })
    expect(replay.status).toBe(401)
  })

  it('expired totpSession (signed against a different secret): 401', async () => {
    const secret = authenticator.generateSecret()
    await seedUser({
      email: 'expired@test.dev', password: 'pw123456789012',
      totpEnabled: true, totpSecret: secret,
    })
    // Forge a session signed with the wrong secret — jwt.verify rejects.
    const fakeSession = jwt.sign(
      { userId: 'x', purpose: 'totp_pending' },
      'wrong_secret',
    )
    const res = await request(buildApp())
      .post('/api/auth/totp/verify')
      .send({ totpSession: fakeSession, code: authenticator.generate(secret) })
    expect(res.status).toBe(401)
  })

  it('rejects a non-totp_pending session (defense vs replaying a full session JWT)', async () => {
    const secret = authenticator.generateSecret()
    const { token } = await seedUser({
      email: 'wrong-purpose@test.dev', password: 'pw123456789012',
      totpEnabled: true, totpSecret: secret,
    })
    // `token` is a regular auth JWT — no `purpose: 'totp_pending'`.
    // /verify should refuse it.
    const res = await request(buildApp())
      .post('/api/auth/totp/verify')
      .send({ totpSession: token, code: authenticator.generate(secret) })
    expect(res.status).toBe(401)
  })
})

// ── /disable ───────────────────────────────────────────────────────────────

describe('POST /api/auth/totp/disable', () => {
  it('wrong password: 401, totp_enabled stays TRUE', async () => {
    const secret = authenticator.generateSecret()
    const { userId, token } = await seedUser({
      email: 'disable@test.dev', password: 'pw123456789012',
      totpEnabled: true, totpSecret: secret,
    })
    const res = await request(buildApp())
      .post('/api/auth/totp/disable')
      .set('Authorization', `Bearer ${token}`)
      .send({ password: 'wrong-password' })
    expect(res.status).toBe(401)

    const row = await db.query<{ totp_enabled: boolean }>(
      `SELECT totp_enabled FROM users WHERE id=$1`, [userId]
    )
    expect(row.rows[0].totp_enabled).toBe(true)
  })

  it('correct password: clears totp state + recovery codes', async () => {
    const secret = authenticator.generateSecret()
    const { userId, token } = await seedUser({
      email: 'disable-ok@test.dev', password: 'pw123456789012',
      totpEnabled: true, totpSecret: secret,
    })
    // Seed a few recovery codes so we can assert they get wiped.
    for (let i = 0; i < 3; i++) {
      await db.query(
        `INSERT INTO user_totp_recovery_codes (user_id, code_hash)
         VALUES ($1, $2)`,
        [userId, await bcrypt.hash(`code-${i}`, 4)],
      )
    }

    const res = await request(buildApp())
      .post('/api/auth/totp/disable')
      .set('Authorization', `Bearer ${token}`)
      .send({ password: 'pw123456789012' })
    expect(res.status).toBe(200)

    const row = await db.query<{
      totp_enabled: boolean
      totp_secret: string | null
      totp_enrolled_at: string | null
    }>(
      `SELECT totp_enabled, totp_secret, totp_enrolled_at
         FROM users WHERE id=$1`, [userId]
    )
    expect(row.rows[0]).toMatchObject({
      totp_enabled:     false,
      totp_secret:      null,
      totp_enrolled_at: null,
    })

    const codeCount = await db.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM user_totp_recovery_codes WHERE user_id=$1`,
      [userId]
    )
    expect(codeCount.rows[0].n).toBe('0')
  })

  it('rejects when totp not enabled', async () => {
    const { token } = await seedUser({
      email: 'never-enabled@test.dev', password: 'pw123456789012',
    })
    const res = await request(buildApp())
      .post('/api/auth/totp/disable')
      .set('Authorization', `Bearer ${token}`)
      .send({ password: 'pw123456789012' })
    expect(res.status).toBe(400)
  })
})

// ── /me TOTP fields (S290) ────────────────────────────────────────────────
//
// S290 extended /auth/me to return totp_enabled and a server-computed
// must_enroll_totp flag. Frontend auth contexts read these to gate the
// enrollment redirect. These tests pin the behavior across the
// mandatory-role × enabled-state matrix.

describe('GET /api/auth/me — TOTP fields', () => {
  it('tenant (non-mandatory role), no TOTP: totpEnabled=false, mustEnrollTotp=false', async () => {
    const { token } = await seedUser({
      email: 'me-tenant@test.dev', password: 'pw123456789012',
      role: 'tenant', totpEnabled: false,
    })
    const res = await request(buildApp())
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    expect(res.body.data.totpEnabled).toBe(false)
    expect(res.body.data.mustEnrollTotp).toBe(false)
  })

  it('admin (mandatory role), no TOTP: totpEnabled=false, mustEnrollTotp=true', async () => {
    const { token } = await seedUser({
      email: 'me-admin@test.dev', password: 'pw123456789012',
      role: 'admin', totpEnabled: false,
    })
    const res = await request(buildApp())
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    expect(res.body.data.totpEnabled).toBe(false)
    expect(res.body.data.mustEnrollTotp).toBe(true)
  })

  it('admin (mandatory role), TOTP enabled: totpEnabled=true, mustEnrollTotp=false', async () => {
    const secret = authenticator.generateSecret()
    const { token } = await seedUser({
      email: 'me-admin-enrolled@test.dev', password: 'pw123456789012',
      role: 'admin', totpEnabled: true, totpSecret: secret,
    })
    const res = await request(buildApp())
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    expect(res.body.data.totpEnabled).toBe(true)
    expect(res.body.data.mustEnrollTotp).toBe(false)
  })

  it('super_admin (mandatory role), no TOTP: mustEnrollTotp=true', async () => {
    const { token } = await seedUser({
      email: 'me-superadmin@test.dev', password: 'pw123456789012',
      role: 'super_admin', totpEnabled: false,
    })
    const res = await request(buildApp())
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    expect(res.body.data.mustEnrollTotp).toBe(true)
  })

  it('landlord (NOT in mandatory roles, optional-with-prompts at launch): mustEnrollTotp=false even without TOTP', async () => {
    const { token } = await seedUser({
      email: 'me-landlord@test.dev', password: 'pw123456789012',
      role: 'landlord', totpEnabled: false,
    })
    const res = await request(buildApp())
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    expect(res.body.data.totpEnabled).toBe(false)
    // Landlord is opt-in at launch — banner-prompted on the
    // dashboard, not forced.
    expect(res.body.data.mustEnrollTotp).toBe(false)
  })
})
