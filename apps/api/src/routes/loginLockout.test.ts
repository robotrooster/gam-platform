/**
 * Login lockout — S280.
 *
 * 5 failed attempts in a row → 15-minute lockout. The gate runs
 * BEFORE bcrypt.compare so a correct password during the lockout
 * window stays denied. Successful login + password reset both clear
 * the counter and any lockout stamp.
 *
 * Schema: `users.failed_login_count int NOT NULL DEFAULT 0`,
 * `users.locked_until timestamptz` (S280 migration).
 */

import { vi, describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import bcrypt from 'bcryptjs'
import { db } from '../db'
import { cleanupAllSchema } from '../test/dbHelpers'

// Email sender is mocked everywhere else; keep parity here so
// nothing accidentally hits Resend during password-reset assertions.
const { sendResetMock } = vi.hoisted(() => ({
  sendResetMock: vi.fn(async () => 'msg_mock'),
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
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_login_lockout'
})

async function seedUser(email: string, password: string): Promise<string> {
  const hash = await bcrypt.hash(password, 12)
  const res = await db.query<{ id: string }>(
    // email_verified=TRUE — lockout suite tests the lockout gate
    // specifically; verification gate has its own suite.
    `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
     VALUES ($1, $2, 'tenant', 'Test', 'User', TRUE) RETURNING id`,
    [email, hash],
  )
  return res.rows[0].id
}

async function readLockoutState(userId: string): Promise<{
  failed_login_count: number
  locked_until: string | null
}> {
  const r = await db.query<{
    failed_login_count: number
    locked_until: string | null
  }>(
    `SELECT failed_login_count, locked_until::text FROM users WHERE id=$1`,
    [userId],
  )
  return r.rows[0]
}

async function attemptLogin(email: string, password: string) {
  return request(buildApp())
    .post('/api/auth/login')
    .send({ email, password })
}

describe('login lockout', () => {
  it('4 failures: counter bumps, account still unlocked', async () => {
    const id = await seedUser('a@test.dev', 'rightpass123')
    for (let i = 0; i < 4; i++) {
      const res = await attemptLogin('a@test.dev', 'wrongpass')
      expect(res.status).toBe(401)
      expect(res.body.error).toBe('Invalid credentials')
    }
    const state = await readLockoutState(id)
    expect(state.failed_login_count).toBe(4)
    expect(state.locked_until).toBeNull()
  })

  it('5 failures: account locks (locked_until ~15min out)', async () => {
    const id = await seedUser('b@test.dev', 'rightpass123')
    for (let i = 0; i < 5; i++) {
      await attemptLogin('b@test.dev', 'wrongpass')
    }
    const state = await readLockoutState(id)
    expect(state.failed_login_count).toBe(5)
    expect(state.locked_until).not.toBeNull()
    const lockMs = new Date(state.locked_until!).getTime() - Date.now()
    // Should be between 14 and 16 minutes from now.
    expect(lockMs).toBeGreaterThan(14 * 60_000)
    expect(lockMs).toBeLessThan(16 * 60_000)
  })

  it('correct password during lockout: still 401 with lockout message', async () => {
    const id = await seedUser('c@test.dev', 'rightpass123')
    for (let i = 0; i < 5; i++) {
      await attemptLogin('c@test.dev', 'wrongpass')
    }
    const res = await attemptLogin('c@test.dev', 'rightpass123')
    expect(res.status).toBe(401)
    expect(res.body.error).toMatch(/temporarily locked/i)

    // Counter is unchanged on the gate path (we don't bump for
    // attempts during an active lockout; only ones that reach
    // bcrypt do).
    const state = await readLockoutState(id)
    expect(state.failed_login_count).toBe(5)
  })

  it('expired lockout: correct password works AND counter resets to 0', async () => {
    const id = await seedUser('d@test.dev', 'rightpass123')
    for (let i = 0; i < 5; i++) {
      await attemptLogin('d@test.dev', 'wrongpass')
    }
    // Backdate the lockout stamp to simulate the 15-min window passing.
    await db.query(
      `UPDATE users SET locked_until = NOW() - INTERVAL '1 minute' WHERE id=$1`,
      [id],
    )
    const res = await attemptLogin('d@test.dev', 'rightpass123')
    expect(res.status).toBe(200)
    expect(typeof res.body.data.token).toBe('string')

    const state = await readLockoutState(id)
    expect(state.failed_login_count).toBe(0)
    expect(state.locked_until).toBeNull()
  })

  it('intermediate success resets the counter (3 fails + 1 success)', async () => {
    const id = await seedUser('e@test.dev', 'rightpass123')
    for (let i = 0; i < 3; i++) {
      await attemptLogin('e@test.dev', 'wrongpass')
    }
    expect((await readLockoutState(id)).failed_login_count).toBe(3)

    const ok = await attemptLogin('e@test.dev', 'rightpass123')
    expect(ok.status).toBe(200)
    expect((await readLockoutState(id)).failed_login_count).toBe(0)
  })

  it('password reset clears lockout state', async () => {
    const id = await seedUser('f@test.dev', 'rightpass123')
    for (let i = 0; i < 5; i++) {
      await attemptLogin('f@test.dev', 'wrongpass')
    }
    expect((await readLockoutState(id)).locked_until).not.toBeNull()

    // Request + consume a reset.
    await request(buildApp())
      .post('/api/auth/forgot-password')
      .send({ email: 'f@test.dev' })
    const { rows: [{ reset_token }] } = await db.query<{ reset_token: string }>(
      `SELECT reset_token FROM users WHERE id=$1`, [id],
    )
    const reset = await request(buildApp())
      .post('/api/auth/reset-password')
      .send({ token: reset_token, newPassword: 'newpass45678' })
    expect(reset.status).toBe(200)

    const state = await readLockoutState(id)
    expect(state.failed_login_count).toBe(0)
    expect(state.locked_until).toBeNull()

    // And the new password works immediately — no waiting out the
    // lockout window.
    const login = await attemptLogin('f@test.dev', 'newpass45678')
    expect(login.status).toBe(200)
  })

  it('unknown email: 401 (no enumeration); does not throw on missing locked_until', async () => {
    const res = await attemptLogin('ghost@nowhere.test', 'anything')
    expect(res.status).toBe(401)
    expect(res.body.error).toBe('Invalid credentials')
  })
})
