/**
 * Password reset routes — S279.
 *
 * Tests the forgot-password / reset-password pair against a real
 * `users` row (no Stripe mock needed; only the email sender is
 * stubbed so Resend isn't invoked).
 *
 * Covers:
 *   - forgot-password: known + unknown email respond identically
 *     (no account enumeration); known emails get a token + send
 *   - reset-password: happy path, invalid/expired token, single-use
 *     (no replay), password complexity gate
 *   - end-to-end: after reset, the new password works on /login;
 *     the old one doesn't
 */

import { vi, describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import bcrypt from 'bcryptjs'
import { db } from '../db'
import { cleanupAllSchema } from '../test/dbHelpers'

// Stub the email sender so Resend isn't actually called. vi.mock is
// hoisted above the source-order imports, so the mock function has to
// be declared via vi.hoisted to be defined before the factory runs.
const { sendResetMock } = vi.hoisted(() => ({
  sendResetMock: vi.fn<[string, string | null, string, unknown?], Promise<string | null>>(
    async () => 'msg_mock'
  ),
}))
vi.mock('../services/email', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, sendPasswordResetEmail: sendResetMock }
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
  sendResetMock.mockClear()
  // Tests assume JWT_SECRET is set for the /login leg. Provide a
  // deterministic test value when one isn't already present.
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_for_password_reset_tests'
})

interface SeededUser { id: string; email: string }

async function seedUserWithPassword(email: string, password: string): Promise<SeededUser> {
  const hash = await bcrypt.hash(password, 12)
  const res = await db.query<{ id: string }>(
    // email_verified=TRUE — keep tests focused on reset flow. The
    // verification gate has its own suite.
    `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
     VALUES ($1, $2, 'tenant', 'Test', 'User', TRUE) RETURNING id`,
    [email, hash],
  )
  return { id: res.rows[0].id, email }
}

async function readUser(id: string): Promise<{
  password_hash: string
  reset_token: string | null
  reset_token_expires: string | null
}> {
  const r = await db.query<{
    password_hash: string
    reset_token: string | null
    reset_token_expires: string | null
  }>(
    `SELECT password_hash, reset_token, reset_token_expires::text
       FROM users WHERE id=$1`,
    [id],
  )
  return r.rows[0]
}

describe('POST /api/auth/forgot-password', () => {
  it('known email: 200, reset_token stored, email sender invoked', async () => {
    const user = await seedUserWithPassword('alice@test.dev', 'oldpass1234')

    const res = await request(buildApp())
      .post('/api/auth/forgot-password')
      .send({ email: 'alice@test.dev' })
    expect(res.status).toBe(200)
    expect(res.body.data.message).toMatch(/if an account exists/i)

    const row = await readUser(user.id)
    expect(row.reset_token).not.toBeNull()
    expect(row.reset_token!.length).toBe(64)  // 32 bytes hex
    expect(row.reset_token_expires).not.toBeNull()

    expect(sendResetMock).toHaveBeenCalledTimes(1)
    const [to, firstName, url] = sendResetMock.mock.calls[0]
    expect(to).toBe('alice@test.dev')
    expect(firstName).toBe('Test')
    expect(url).toContain(`token=${row.reset_token}`)
  })

  it('unknown email: 200 (same shape), no token written, no email sent', async () => {
    const res = await request(buildApp())
      .post('/api/auth/forgot-password')
      .send({ email: 'ghost@nowhere.test' })
    // Identical to the known-email response — no account enumeration.
    expect(res.status).toBe(200)
    expect(res.body.data.message).toMatch(/if an account exists/i)

    const count = await db.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM users WHERE reset_token IS NOT NULL`,
    )
    expect(count.rows[0].n).toBe('0')
    expect(sendResetMock).not.toHaveBeenCalled()
  })

  it('invalid email format: 400 (zod)', async () => {
    const res = await request(buildApp())
      .post('/api/auth/forgot-password')
      .send({ email: 'not-an-email' })
    expect(res.status).toBe(400)
  })
})

describe('POST /api/auth/reset-password', () => {
  async function requestReset(email: string): Promise<string> {
    await request(buildApp())
      .post('/api/auth/forgot-password')
      .send({ email })
    const r = await db.query<{ reset_token: string }>(
      `SELECT reset_token FROM users WHERE email=$1`,
      [email],
    )
    return r.rows[0].reset_token
  }

  it('happy: valid token + new password → 200, token cleared, hash updated', async () => {
    const user = await seedUserWithPassword('bob@test.dev', 'oldpass1234')
    const before = (await readUser(user.id)).password_hash
    const token = await requestReset('bob@test.dev')

    const res = await request(buildApp())
      .post('/api/auth/reset-password')
      .send({ token, newPassword: 'newpass45678' })
    expect(res.status).toBe(200)
    expect(res.body.data.message).toMatch(/password updated/i)

    const row = await readUser(user.id)
    expect(row.reset_token).toBeNull()
    expect(row.reset_token_expires).toBeNull()
    expect(row.password_hash).not.toBe(before)
  })

  it('invalid token: 400', async () => {
    await seedUserWithPassword('carol@test.dev', 'oldpass1234')
    const res = await request(buildApp())
      .post('/api/auth/reset-password')
      .send({ token: 'totally-bogus-token', newPassword: 'newpass45678' })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/invalid or expired/i)
  })

  it('expired token: 400', async () => {
    const user = await seedUserWithPassword('dave@test.dev', 'oldpass1234')
    const token = await requestReset('dave@test.dev')
    // Backdate expiry to 1 second ago.
    await db.query(
      `UPDATE users SET reset_token_expires = NOW() - INTERVAL '1 second'
        WHERE id=$1`, [user.id],
    )

    const res = await request(buildApp())
      .post('/api/auth/reset-password')
      .send({ token, newPassword: 'newpass45678' })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/invalid or expired/i)
  })

  it('single-use: replay attempt 400s (token cleared by first use)', async () => {
    await seedUserWithPassword('erin@test.dev', 'oldpass1234')
    const token = await requestReset('erin@test.dev')

    const r1 = await request(buildApp())
      .post('/api/auth/reset-password')
      .send({ token, newPassword: 'firstnew5678' })
    expect(r1.status).toBe(200)

    const r2 = await request(buildApp())
      .post('/api/auth/reset-password')
      .send({ token, newPassword: 'anothernew5678' })
    expect(r2.status).toBe(400)
  })

  it('password too short: 400 (zod min 12)', async () => {
    await seedUserWithPassword('frank@test.dev', 'oldpass1234')
    const token = await requestReset('frank@test.dev')

    const res = await request(buildApp())
      .post('/api/auth/reset-password')
      .send({ token, newPassword: 'short' })
    expect(res.status).toBe(400)

    // Token NOT consumed on validation failure (the route throws
    // before the UPDATE).
    const row = await db.query<{ reset_token: string | null }>(
      `SELECT reset_token FROM users WHERE email='frank@test.dev'`,
    )
    expect(row.rows[0].reset_token).not.toBeNull()
  })
})

describe('end-to-end: reset → login with new password', () => {
  it('new password works on /login; old password does not', async () => {
    await seedUserWithPassword('grace@test.dev', 'originalpass1234')
    const token = await (async () => {
      await request(buildApp())
        .post('/api/auth/forgot-password')
        .send({ email: 'grace@test.dev' })
      const r = await db.query<{ reset_token: string }>(
        `SELECT reset_token FROM users WHERE email='grace@test.dev'`,
      )
      return r.rows[0].reset_token
    })()

    const reset = await request(buildApp())
      .post('/api/auth/reset-password')
      .send({ token, newPassword: 'brandnew5678' })
    expect(reset.status).toBe(200)

    // Old password rejected.
    const stale = await request(buildApp())
      .post('/api/auth/login')
      .send({ email: 'grace@test.dev', password: 'originalpass1234' })
    expect(stale.status).toBe(401)

    // New password accepted; token returned.
    const fresh = await request(buildApp())
      .post('/api/auth/login')
      .send({ email: 'grace@test.dev', password: 'brandnew5678' })
    expect(fresh.status).toBe(200)
    expect(typeof fresh.body.data.token).toBe('string')
  })
})
