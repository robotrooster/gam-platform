/**
 * S565: email-code 2FA.
 *   - /login for an email_2fa_enabled user returns requiresEmailOtp + a pending
 *     session (no full token) and stores a hashed code.
 *   - /email-otp/verify exchanges the code for a full session; wrong/expired/
 *     too-many-attempts are rejected; the pending token is purpose-scoped.
 *   - /email-otp/resend issues a fresh code and retires the prior one.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import bcrypt from 'bcryptjs'
import { randomUUID } from 'crypto'
import { db } from '../db'
import { cleanupAllSchema } from '../test/dbHelpers'
import { errorHandler } from '../middleware/errorHandler'

// Capture the emailed code instead of sending it.
const sentCodes: string[] = []
vi.mock('../services/email', async (orig) => {
  const actual = await orig<Record<string, unknown>>()
  return { ...actual, emailLoginCode: vi.fn(async (_to: string, code: string) => { sentCodes.push(code); return 'msg_mock' }) }
})

import { emailOtpRouter, signEmailOtpSessionToken, issueEmailOtp } from './emailOtp'
import { authRouter } from './auth'

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/auth', authRouter)
  app.use('/api/auth/email-otp', emailOtpRouter)
  app.use(errorHandler)
  return app
}

async function seedOwner(opts?: { email2fa?: boolean }) {
  const email = `owner-${randomUUID()}@test.dev`
  const pw = 'OwnerPass1234!'
  const hash = await bcrypt.hash(pw, 10)
  const id = (await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified, totp_enabled, email_2fa_enabled)
     VALUES ($1,$2,'super_admin','O','W',TRUE,FALSE,$3) RETURNING id`,
    [email, hash, opts?.email2fa ?? true]
  )).rows[0].id
  return { id, email, pw }
}

beforeEach(async () => {
  await cleanupAllSchema()
  await db.query('DELETE FROM login_email_otps')
  sentCodes.length = 0
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_emailotp'
})

describe('/login with email_2fa_enabled', () => {
  it('returns requiresEmailOtp + pending session, no full token, and emails a code', async () => {
    const u = await seedOwner()
    const res = await request(buildApp()).post('/api/auth/login').send({ email: u.email, password: u.pw })
    expect(res.status).toBe(200)
    expect(res.body.data.requiresEmailOtp).toBe(true)
    expect(res.body.data.emailOtpSession).toBeTruthy()
    expect(res.body.data.token).toBeUndefined()
    expect(sentCodes.length).toBe(1)
    // The pending token is purpose-scoped.
    const decoded: any = jwt.verify(res.body.data.emailOtpSession, process.env.JWT_SECRET!)
    expect(decoded.purpose).toBe('email_otp_pending')
    // A hashed code row exists.
    const row = (await db.query(`SELECT id FROM login_email_otps WHERE user_id=$1 AND consumed_at IS NULL`, [u.id])).rows
    expect(row.length).toBe(1)
  })
})

describe('/email-otp/verify', () => {
  it('exchanges a correct code for a full session token', async () => {
    const u = await seedOwner()
    const session = signEmailOtpSessionToken({ userId: u.id, role: 'super_admin', email: u.email, profileId: null })
    const code = await issueEmailOtp(u.id, u.email, { skipSend: true })
    const res = await request(buildApp()).post('/api/auth/email-otp/verify').send({ emailOtpSession: session, code })
    expect(res.status).toBe(200)
    expect(res.body.data.token).toBeTruthy()
    const decoded: any = jwt.verify(res.body.data.token, process.env.JWT_SECRET!)
    expect(decoded.role).toBe('super_admin')
    expect(decoded.purpose).toBeUndefined() // full session, not purpose-scoped
    // Code is now consumed.
    const active = (await db.query(`SELECT id FROM login_email_otps WHERE user_id=$1 AND consumed_at IS NULL`, [u.id])).rows
    expect(active.length).toBe(0)
  })

  it('rejects a wrong code and counts the attempt', async () => {
    const u = await seedOwner()
    const session = signEmailOtpSessionToken({ userId: u.id, role: 'super_admin', email: u.email, profileId: null })
    await issueEmailOtp(u.id, u.email, { skipSend: true })
    const res = await request(buildApp()).post('/api/auth/email-otp/verify').send({ emailOtpSession: session, code: '000000' })
    expect(res.status).toBe(401)
    const row = (await db.query<{ attempts: number }>(`SELECT attempts FROM login_email_otps WHERE user_id=$1`, [u.id])).rows[0]
    expect(row.attempts).toBe(1)
  })

  it('locks out after too many attempts', async () => {
    const u = await seedOwner()
    const session = signEmailOtpSessionToken({ userId: u.id, role: 'super_admin', email: u.email, profileId: null })
    await issueEmailOtp(u.id, u.email, { skipSend: true })
    for (let i = 0; i < 5; i++) {
      await request(buildApp()).post('/api/auth/email-otp/verify').send({ emailOtpSession: session, code: '000000' })
    }
    const res = await request(buildApp()).post('/api/auth/email-otp/verify').send({ emailOtpSession: session, code: '000000' })
    expect(res.status).toBe(401)
    expect(res.body.error).toMatch(/too many/i)
  })

  it('rejects an expired code', async () => {
    const u = await seedOwner()
    const session = signEmailOtpSessionToken({ userId: u.id, role: 'super_admin', email: u.email, profileId: null })
    const code = await issueEmailOtp(u.id, u.email, { skipSend: true })
    await db.query(`UPDATE login_email_otps SET expires_at = NOW() - INTERVAL '1 minute' WHERE user_id=$1`, [u.id])
    const res = await request(buildApp()).post('/api/auth/email-otp/verify').send({ emailOtpSession: session, code })
    expect(res.status).toBe(401)
    expect(res.body.error).toMatch(/expired/i)
  })

  it('rejects a non-email-otp (forged) session', async () => {
    const u = await seedOwner()
    const bad = jwt.sign({ userId: u.id, role: 'super_admin', email: u.email }, process.env.JWT_SECRET!, { expiresIn: '5m' })
    await issueEmailOtp(u.id, u.email, { skipSend: true })
    const res = await request(buildApp()).post('/api/auth/email-otp/verify').send({ emailOtpSession: bad, code: '000000' })
    expect(res.status).toBe(401)
  })
})

describe('/email-otp/resend', () => {
  it('issues a fresh code and retires the prior one', async () => {
    const u = await seedOwner()
    const session = signEmailOtpSessionToken({ userId: u.id, role: 'super_admin', email: u.email, profileId: null })
    const first = await issueEmailOtp(u.id, u.email, { skipSend: true })
    await request(buildApp()).post('/api/auth/email-otp/resend').send({ emailOtpSession: session })
    // Exactly one active code; the old one no longer verifies.
    const active = (await db.query(`SELECT id FROM login_email_otps WHERE user_id=$1 AND consumed_at IS NULL`, [u.id])).rows
    expect(active.length).toBe(1)
    const res = await request(buildApp()).post('/api/auth/email-otp/verify').send({ emailOtpSession: session, code: first })
    expect(res.status).toBe(401) // old code retired
  })
})

// ── S571: tenant email-2FA is universal (mandatory, always on) ─────────────
async function seedTenantUser(opts?: { enabled?: boolean }) {
  const email = `t2fa-${randomUUID()}@test.dev`
  const pw = 'TenantPass1234!'
  const hash = await bcrypt.hash(pw, 10)
  const id = (await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified, email_2fa_enabled)
     VALUES ($1,$2,'tenant','T','U',TRUE,$3) RETURNING id`,
    [email, hash, opts?.enabled ?? false]
  )).rows[0].id
  const token = jwt.sign({ userId: id, role: 'tenant', email, profileId: id, permissions: {} }, process.env.JWT_SECRET!, { expiresIn: '1h' })
  return { id, email, pw, token }
}

describe('tenant email-2FA (universal)', () => {
  it('GET /status reports enabled=true for a tenant even if the flag lags, with the login email', async () => {
    const u = await seedTenantUser({ enabled: false })
    const res = await request(buildApp()).get('/api/auth/email-otp/status').set('Authorization', `Bearer ${u.token}`)
    expect(res.status).toBe(200)
    expect(res.body.data).toMatchObject({ enabled: true, email: u.email })
  })

  it('login canonicalizes a tenant flag to TRUE and requires an email code', async () => {
    const u = await seedTenantUser({ enabled: false })
    const res = await request(buildApp()).post('/api/auth/login').send({ email: u.email, password: u.pw })
    expect(res.status).toBe(200)
    expect(res.body.data.requiresEmailOtp).toBe(true)
    const row = (await db.query<{ email_2fa_enabled: boolean }>(`SELECT email_2fa_enabled FROM users WHERE id=$1`, [u.id])).rows[0]
    expect(row.email_2fa_enabled).toBe(true) // flipped on during login
  })
})
