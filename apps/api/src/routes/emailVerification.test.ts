/**
 * Email verification — S281.
 *
 * Three routes:
 *   - POST /api/auth/register (existing) — now mints email_verify_token
 *     + sends verification email post-commit
 *   - POST /api/auth/verify-email — consumes token, flips
 *     email_verified=true, clears token (single-use)
 *   - POST /api/auth/resend-verification — anti-enumeration response;
 *     known+unverified rotates token + re-sends, everyone else no-ops
 *
 * Plus the /login gate: refuses if email_verified=false, auto-fires
 * a fresh verification email so the user can recover one-click.
 */

import { vi, describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import bcrypt from 'bcryptjs'
import { db } from '../db'
import { cleanupAllSchema } from '../test/dbHelpers'

const { sendVerifyMock, sendResetMock } = vi.hoisted(() => ({
  sendVerifyMock: vi.fn<[string, string | null, string, unknown?], Promise<string | null>>(
    async () => 'msg_verify'
  ),
  sendResetMock: vi.fn(async () => 'msg_reset'),
}))
vi.mock('../services/email', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    sendEmailVerification:  sendVerifyMock,
    sendPasswordResetEmail: sendResetMock,
  }
})

import { authRouter } from './auth'
import { errorHandler } from '../middleware/errorHandler'

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
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_email_verify'
})

async function seedUserPassword(
  email: string, password: string,
  opts: { emailVerified?: boolean } = {},
): Promise<string> {
  const hash = await bcrypt.hash(password, 12)
  const verified = opts.emailVerified ?? false
  const res = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
     VALUES ($1, $2, 'tenant', 'Test', 'User', $3) RETURNING id`,
    [email, hash, verified],
  )
  return res.rows[0].id
}

async function readVerify(userId: string): Promise<{
  email_verified: boolean
  email_verify_token: string | null
  email_verified_at: string | null
}> {
  const r = await db.query<{
    email_verified: boolean
    email_verify_token: string | null
    email_verified_at: string | null
  }>(
    `SELECT email_verified, email_verify_token, email_verified_at
       FROM users WHERE id=$1`,
    [userId],
  )
  return r.rows[0]
}

describe('POST /api/auth/register — verification email side effect', () => {
  it('register: mints email_verify_token and fires verification email', async () => {
    const res = await request(buildApp())
      .post('/api/auth/register')
      .send({
        email: 'newuser@test.dev',
        password: 'goodpass1234',
        firstName: 'New',
        lastName: 'User',
        role: 'tenant',
        acceptedTerms: true,
      })
    expect(res.status).toBe(201)
    // Register still issues a JWT for the just-registered session.
    expect(typeof res.body.data.token).toBe('string')

    // Fire-and-forget — poll until the post-commit UPDATE lands.
    let token: string | null = null
    const deadline = Date.now() + 2000
    while (Date.now() < deadline) {
      const row = await db.query<{ email_verify_token: string | null }>(
        `SELECT email_verify_token FROM users WHERE email='newuser@test.dev'`,
      )
      if (row.rows[0]?.email_verify_token) {
        token = row.rows[0].email_verify_token
        break
      }
      await new Promise((r) => setTimeout(r, 20))
    }
    expect(token).not.toBeNull()
    expect(token!.length).toBe(64)

    const verifyState = await db.query<{ email_verified: boolean }>(
      `SELECT email_verified FROM users WHERE email='newuser@test.dev'`,
    )
    expect(verifyState.rows[0].email_verified).toBe(false)

    expect(sendVerifyMock).toHaveBeenCalledTimes(1)
    const [to, firstName, url] = sendVerifyMock.mock.calls[0]
    expect(to).toBe('newuser@test.dev')
    expect(firstName).toBe('New')
    expect(url).toContain(`token=${token}`)
  })
})

describe('POST /api/auth/verify-email', () => {
  it('happy: valid token flips email_verified=true, stamps email_verified_at, clears token', async () => {
    const userId = await seedUserPassword('a@test.dev', 'pw12345678')
    // Pre-seed a token (skip the register flow for isolation).
    await db.query(
      `UPDATE users SET email_verify_token = 'verify-token-abc' WHERE id=$1`,
      [userId],
    )

    // Sanity: audit timestamp is NULL before verification.
    const pre = await readVerify(userId)
    expect(pre.email_verified).toBe(false)
    expect(pre.email_verified_at).toBeNull()

    const res = await request(buildApp())
      .post('/api/auth/verify-email')
      .send({ token: 'verify-token-abc' })
    expect(res.status).toBe(200)
    expect(res.body.data.message).toMatch(/email verified/i)

    const row = await readVerify(userId)
    expect(row.email_verified).toBe(true)
    expect(row.email_verify_token).toBeNull()
    // S284: audit stamp written. Bounds check — within last 60s — guards
    // against accidentally writing a static literal or a wrong-timezone
    // value while keeping the assertion loose enough for test latency.
    expect(row.email_verified_at).not.toBeNull()
    const stampedAt = new Date(row.email_verified_at!).getTime()
    expect(Date.now() - stampedAt).toBeLessThan(60_000)
  })

  it('invalid token: 400', async () => {
    await seedUserPassword('b@test.dev', 'pw12345678')
    const res = await request(buildApp())
      .post('/api/auth/verify-email')
      .send({ token: 'no-such-token' })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/invalid or already used/i)
  })

  it('single-use: replay attempt 400s after first success', async () => {
    const userId = await seedUserPassword('c@test.dev', 'pw12345678')
    await db.query(
      `UPDATE users SET email_verify_token = 'used-once' WHERE id=$1`,
      [userId],
    )

    const r1 = await request(buildApp())
      .post('/api/auth/verify-email').send({ token: 'used-once' })
    expect(r1.status).toBe(200)

    const r2 = await request(buildApp())
      .post('/api/auth/verify-email').send({ token: 'used-once' })
    expect(r2.status).toBe(400)
  })

  it('missing token: 400 (zod)', async () => {
    const res = await request(buildApp())
      .post('/api/auth/verify-email').send({})
    expect(res.status).toBe(400)
  })
})

describe('POST /api/auth/resend-verification', () => {
  it('known unverified email: 200, new token, email sent', async () => {
    const userId = await seedUserPassword('d@test.dev', 'pw12345678',
      { emailVerified: false })
    await db.query(
      `UPDATE users SET email_verify_token = 'old-token' WHERE id=$1`,
      [userId],
    )

    const res = await request(buildApp())
      .post('/api/auth/resend-verification').send({ email: 'd@test.dev' })
    expect(res.status).toBe(200)
    expect(res.body.data.message).toMatch(/if an account exists/i)

    // Poll for the token-rotation UPDATE (fire-and-forget after response).
    let row = await readVerify(userId)
    const deadline = Date.now() + 2000
    while (row.email_verify_token === 'old-token' && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20))
      row = await readVerify(userId)
    }
    // New token differs from the old one and is 64 hex chars.
    expect(row.email_verify_token).not.toBe('old-token')
    expect(row.email_verify_token!.length).toBe(64)
    expect(sendVerifyMock).toHaveBeenCalledTimes(1)
  })

  it('known but already-verified email: 200, no-op (no email, no token change)', async () => {
    const userId = await seedUserPassword('e@test.dev', 'pw12345678',
      { emailVerified: true })

    const res = await request(buildApp())
      .post('/api/auth/resend-verification').send({ email: 'e@test.dev' })
    expect(res.status).toBe(200)

    const row = await readVerify(userId)
    expect(row.email_verified).toBe(true)
    expect(row.email_verify_token).toBeNull()
    expect(sendVerifyMock).not.toHaveBeenCalled()
  })

  it('unknown email: 200 (same response, no enumeration)', async () => {
    const res = await request(buildApp())
      .post('/api/auth/resend-verification').send({ email: 'ghost@nowhere.test' })
    expect(res.status).toBe(200)
    expect(res.body.data.message).toMatch(/if an account exists/i)
    expect(sendVerifyMock).not.toHaveBeenCalled()
  })

  it('invalid email format: 400 (zod)', async () => {
    const res = await request(buildApp())
      .post('/api/auth/resend-verification').send({ email: 'not-an-email' })
    expect(res.status).toBe(400)
  })
})

describe('login gate on email_verified', () => {
  it('unverified user with correct password: 401 "please verify" + new email fires', async () => {
    await seedUserPassword('f@test.dev', 'rightpass1234',
      { emailVerified: false })

    const res = await request(buildApp())
      .post('/api/auth/login')
      .send({ email: 'f@test.dev', password: 'rightpass1234' })
    expect(res.status).toBe(401)
    expect(res.body.error).toMatch(/please verify your email/i)

    // Poll for the fire-and-forget resend.
    const deadline = Date.now() + 2000
    while (sendVerifyMock.mock.calls.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20))
    }
    expect(sendVerifyMock).toHaveBeenCalledTimes(1)
  })

  it('unverified user with wrong password: 401 "Invalid credentials" (gate runs after bcrypt)', async () => {
    await seedUserPassword('g@test.dev', 'rightpass1234',
      { emailVerified: false })

    const res = await request(buildApp())
      .post('/api/auth/login')
      .send({ email: 'g@test.dev', password: 'wrongpass' })
    expect(res.status).toBe(401)
    // Generic message — don't leak "account exists but unverified".
    expect(res.body.error).toBe('Invalid credentials')
    expect(sendVerifyMock).not.toHaveBeenCalled()
  })

  it('verified user with correct password: 200 + JWT', async () => {
    await seedUserPassword('h@test.dev', 'rightpass1234',
      { emailVerified: true })

    const res = await request(buildApp())
      .post('/api/auth/login')
      .send({ email: 'h@test.dev', password: 'rightpass1234' })
    expect(res.status).toBe(200)
    expect(typeof res.body.data.token).toBe('string')
  })
})
