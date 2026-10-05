/**
 * S565: email-code 2FA.
 *   - /login for an email_2fa_enabled user returns requiresEmailOtp + a pending
 *     session (no full token) and stores a hashed code.
 *   - /email-otp/verify exchanges the code for a full session; wrong/expired/
 *     too-many-attempts are rejected; the pending token is purpose-scoped.
 *   - /email-otp/resend issues a fresh code and retires the prior one.
 *   - S655: a pending pass from before a password change can neither verify
 *     nor resend, so it can never spend or cancel the real person's code.
 *   - A pending pass from before the login email changed can neither verify
 *     nor resend: the code it stands for proves the old inbox, not the new one.
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
const sentTo: string[] = []
vi.mock('../services/email', async (orig) => {
  const actual = await orig<Record<string, unknown>>()
  return { ...actual, emailLoginCode: vi.fn(async (to: string, code: string) => { sentCodes.push(code); sentTo.push(to); return 'msg_mock' }) }
})

import {
  emailOtpRouter, signEmailOtpSessionToken, issueEmailOtp,
  PENDING_PASS_EMAIL_CHANGED, PENDING_PASS_PASSWORD_CHANGED,
} from './emailOtp'
import { authRouter } from './auth'
import { tenantsRouter } from './tenants'

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
  sentTo.length = 0
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

// ── S655: the full pass carries the session policy chosen at sign-in ───────
describe('S655 /email-otp/verify mints under the policy chosen at sign-in', () => {
  it('a fixed sign-in becomes a fixed full pass, seven days from now', async () => {
    const u = await seedOwner()
    const session = signEmailOtpSessionToken({ userId: u.id, role: 'super_admin', email: u.email, profileId: null, sp: 'fixed' })
    const code = await issueEmailOtp(u.id, u.email, { skipSend: true })
    const res = await request(buildApp()).post('/api/auth/email-otp/verify').send({ emailOtpSession: session, code })
    const decoded: any = jwt.decode(res.body.data.token)
    expect(decoded.sp).toBe('fixed')
    expect(decoded.exp - decoded.iat).toBe(7 * 24 * 3600)
  })

  it('"keep me signed in" (rolling) survives the code step', async () => {
    const u = await seedOwner()
    const session = signEmailOtpSessionToken({ userId: u.id, role: 'super_admin', email: u.email, profileId: null, sp: 'rolling' })
    const code = await issueEmailOtp(u.id, u.email, { skipSend: true })
    const res = await request(buildApp()).post('/api/auth/email-otp/verify').send({ emailOtpSession: session, code })
    expect((jwt.decode(res.body.data.token) as any).sp).toBe('rolling')
  })

  it('a pending pass from before the change reads by role: staff fixed, tenant rolling', async () => {
    const admin = await seedOwner()
    const s1 = signEmailOtpSessionToken({ userId: admin.id, role: 'super_admin', email: admin.email, profileId: null })
    const c1 = await issueEmailOtp(admin.id, admin.email, { skipSend: true })
    const r1 = await request(buildApp()).post('/api/auth/email-otp/verify').send({ emailOtpSession: s1, code: c1 })
    expect((jwt.decode(r1.body.data.token) as any).sp).toBe('fixed')

    const t = await seedTenantUser({ enabled: true })
    const s2 = signEmailOtpSessionToken({ userId: t.id, role: 'tenant', email: t.email, profileId: null })
    const c2 = await issueEmailOtp(t.id, t.email, { skipSend: true })
    const r2 = await request(buildApp()).post('/api/auth/email-otp/verify').send({ emailOtpSession: s2, code: c2 })
    expect((jwt.decode(r2.body.data.token) as any).sp).toBe('rolling')
  })
})

// ── S655: the code step honors a password change ──────────────────────────
//
// A password change ends every pass minted before it (routes/auth.ts). The
// emailed-code step turns a pending pass into a full one, so it applies the
// same rule — at whole-second precision, because tenant invite activation sets
// the password and mints the pending pass in the same request.
describe('S655 /email-otp/verify refuses a pending pass from before a password change', () => {
  const pendingPassAt = (u: { id: string; email: string }, iat: number) =>
    jwt.sign({ userId: u.id, role: 'super_admin', email: u.email, profileId: null,
               purpose: 'email_otp_pending', iat }, process.env.JWT_SECRET!, { expiresIn: 15 * 60 })

  it('a pass from before the change gets "your password was changed" and no token; the code stays for the real person', async () => {
    const u = await seedOwner()
    const before = pendingPassAt(u, Math.floor(Date.now() / 1000) - 60)
    await db.query(`UPDATE users SET sessions_valid_from = NOW() WHERE id = $1`, [u.id])
    const code = await issueEmailOtp(u.id, u.email, { skipSend: true })

    const refused = await request(buildApp()).post('/api/auth/email-otp/verify').send({ emailOtpSession: before, code })
    expect(refused.status).toBe(401)
    expect(refused.body.error).toMatch(/password was changed/i)
    expect(refused.body.data?.token).toBeUndefined()
    // Neither spent nor counted against: the person who changed the password
    // signs in with the same code.
    const row = (await db.query<{ consumed_at: Date | null; attempts: number }>(
      `SELECT consumed_at, attempts FROM login_email_otps WHERE user_id = $1`, [u.id])).rows[0]
    expect(row).toEqual({ consumed_at: null, attempts: 0 })

    const fresh = signEmailOtpSessionToken({ userId: u.id, role: 'super_admin', email: u.email, profileId: null })
    const ok = await request(buildApp()).post('/api/auth/email-otp/verify').send({ emailOtpSession: fresh, code })
    expect(ok.status).toBe(200)
    expect(ok.body.data.token).toBeTruthy()
  })

  it('a pass minted in the same second as the change counts as after it; a second earlier does not', async () => {
    const u = await seedOwner()
    const second = Math.floor(Date.now() / 1000) - 30
    // The change landed 0.9s into that second.
    await db.query(`UPDATE users SET sessions_valid_from = to_timestamp($2) WHERE id = $1`, [u.id, second + 0.9])

    await issueEmailOtp(u.id, u.email, { skipSend: true })
    const earlier = await request(buildApp()).post('/api/auth/email-otp/verify')
      .send({ emailOtpSession: pendingPassAt(u, second - 1), code: '000000' })
    expect(earlier.status).toBe(401)
    expect(earlier.body.error).toMatch(/password was changed/i)

    const code = await issueEmailOtp(u.id, u.email, { skipSend: true })
    const sameSecond = await request(buildApp()).post('/api/auth/email-otp/verify')
      .send({ emailOtpSession: pendingPassAt(u, second), code })
    expect(sameSecond.status).toBe(200)
    expect(sameSecond.body.data.token).toBeTruthy()
  })

  it('accepting a tenant invite and typing the code straight away signs the tenant in', async () => {
    const app = express()
    app.use(express.json())
    app.use('/api/auth/email-otp', emailOtpRouter)
    app.use('/api/tenants', tenantsRouter)
    app.use(errorHandler)

    const token = 'invitetoken_' + randomUUID().replace(/-/g, '')
    const { rows: [user] } = await db.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name,
                          tenant_invite_token, tenant_invite_expires_at, email_verified)
       VALUES ($1, '$2b$10$placeholder_invite_pending', 'tenant', 'New', 'Resident',
               $2, NOW() + INTERVAL '7 days', FALSE) RETURNING id`,
      [`invited-${randomUUID()}@test.dev`, token])
    await db.query(`INSERT INTO tenants (user_id) VALUES ($1)`, [user.id])

    // Activation stamps sessions_valid_from and mints the pending pass in the
    // same request, so the pass's whole-second iat reads as just "before" it.
    const accepted = await request(app).post('/api/tenants/accept-invite')
      .send({ token, password: 'newpass8chars', acceptedTerms: true })
    expect(accepted.status).toBe(200)
    expect(accepted.body.data.requiresEmailOtp).toBe(true)
    expect(sentCodes).toHaveLength(1)
    const stamp = (await db.query<{ sessions_valid_from: Date }>(
      `SELECT sessions_valid_from FROM users WHERE id = $1`, [user.id])).rows[0].sessions_valid_from
    expect(stamp).not.toBeNull()

    const verified = await request(app).post('/api/auth/email-otp/verify')
      .send({ emailOtpSession: accepted.body.data.emailOtpSession, code: sentCodes[0] })
    expect(verified.status, JSON.stringify(verified.body)).toBe(200)
    expect(verified.body.data.token).toBeTruthy()
  })
})

// ── S655: /resend honors a password change too ────────────────────────────
//
// /resend retires the live code and mails a new one. A pass minted before the
// password changed could otherwise keep cancelling the code the real person is
// about to type, one click at a time, even though /verify refuses that pass.
describe('S655 /email-otp/resend refuses a pending pass from before a password change', () => {
  const pendingPassAt = (u: { id: string; email: string }, iat: number) =>
    jwt.sign({ userId: u.id, role: 'super_admin', email: u.email, profileId: null,
               purpose: 'email_otp_pending', iat }, process.env.JWT_SECRET!, { expiresIn: 15 * 60 })

  it('a pass from before the change gets "your password was changed"; the live code stays and nothing is mailed', async () => {
    const u = await seedOwner()
    const before = pendingPassAt(u, Math.floor(Date.now() / 1000) - 60)
    await db.query(`UPDATE users SET sessions_valid_from = NOW() WHERE id = $1`, [u.id])
    const code = await issueEmailOtp(u.id, u.email, { skipSend: true })

    const refused = await request(buildApp()).post('/api/auth/email-otp/resend').send({ emailOtpSession: before })
    expect(refused.status).toBe(401)
    expect(refused.body.error).toMatch(/password was changed/i)
    expect(sentCodes).toHaveLength(0)

    // The real person's code is untouched: still the only code, unspent, and it signs them in.
    const rows = (await db.query<{ consumed_at: Date | null; attempts: number }>(
      `SELECT consumed_at, attempts FROM login_email_otps WHERE user_id = $1`, [u.id])).rows
    expect(rows).toEqual([{ consumed_at: null, attempts: 0 }])
    const fresh = signEmailOtpSessionToken({ userId: u.id, role: 'super_admin', email: u.email, profileId: null })
    const ok = await request(buildApp()).post('/api/auth/email-otp/verify').send({ emailOtpSession: fresh, code })
    expect(ok.status).toBe(200)
    expect(ok.body.data.token).toBeTruthy()
  })

  it('a pass for an account that no longer exists is refused and mails nothing', async () => {
    const ghost = { id: randomUUID(), email: `ghost-${randomUUID()}@test.dev` }
    const pass = signEmailOtpSessionToken({ userId: ghost.id, role: 'super_admin', email: ghost.email, profileId: null })
    const res = await request(buildApp()).post('/api/auth/email-otp/resend').send({ emailOtpSession: pass })
    expect(res.status).toBe(401)
    expect(sentCodes).toHaveLength(0)
  })

  it('a pass minted after the change still gets a new code', async () => {
    const u = await seedOwner()
    await db.query(`UPDATE users SET sessions_valid_from = NOW() - INTERVAL '5 seconds' WHERE id = $1`, [u.id])
    await issueEmailOtp(u.id, u.email, { skipSend: true })
    const pass = signEmailOtpSessionToken({ userId: u.id, role: 'super_admin', email: u.email, profileId: null })

    const res = await request(buildApp()).post('/api/auth/email-otp/resend').send({ emailOtpSession: pass })
    expect(res.status).toBe(200)
    expect(sentCodes).toHaveLength(1)
    // The earlier code is retired; only the one just mailed is live.
    const live = (await db.query<{ id: string }>(
      `SELECT id FROM login_email_otps WHERE user_id = $1 AND consumed_at IS NULL`, [u.id])).rows
    expect(live).toHaveLength(1)
    const ok = await request(buildApp()).post('/api/auth/email-otp/verify').send({ emailOtpSession: pass, code: sentCodes[0] })
    expect(ok.status).toBe(200)
  })

  it('accepting a tenant invite and asking for a new code straight away mails one', async () => {
    const app = express()
    app.use(express.json())
    app.use('/api/auth/email-otp', emailOtpRouter)
    app.use('/api/tenants', tenantsRouter)
    app.use(errorHandler)

    const token = 'invitetoken_' + randomUUID().replace(/-/g, '')
    const { rows: [user] } = await db.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name,
                          tenant_invite_token, tenant_invite_expires_at, email_verified)
       VALUES ($1, '$2b$10$placeholder_invite_pending', 'tenant', 'New', 'Resident',
               $2, NOW() + INTERVAL '7 days', FALSE) RETURNING id`,
      [`invited-${randomUUID()}@test.dev`, token])
    await db.query(`INSERT INTO tenants (user_id) VALUES ($1)`, [user.id])

    const accepted = await request(app).post('/api/tenants/accept-invite')
      .send({ token, password: 'newpass8chars', acceptedTerms: true })
    expect(accepted.status).toBe(200)
    expect(sentCodes).toHaveLength(1)

    const resent = await request(app).post('/api/auth/email-otp/resend')
      .send({ emailOtpSession: accepted.body.data.emailOtpSession })
    expect(resent.status, JSON.stringify(resent.body)).toBe(200)
    expect(sentCodes).toHaveLength(2)
    const verified = await request(app).post('/api/auth/email-otp/verify')
      .send({ emailOtpSession: accepted.body.data.emailOtpSession, code: sentCodes[1] })
    expect(verified.status, JSON.stringify(verified.body)).toBe(200)
  })
})

// ── A pending pass is bound to the login address it was minted for ─────────
//
// The code /login mailed went to the address copied into the pass. If the
// login address changes mid-sign-in (a confirmed change of email, or a landlord
// correcting a resident's mistyped address), that code proves the OLD inbox:
// it must not mark the new address verified, start a session, or let the old
// pass keep re-mailing codes. The person signs in again with the address they
// have now.
describe('a pending pass from before the login email changed', () => {
  it('cannot ask for a new code: refused in plain words, nothing mailed, the live code untouched', async () => {
    const u = await seedOwner()
    const pass = signEmailOtpSessionToken({ userId: u.id, role: 'super_admin', email: u.email, profileId: null })
    await issueEmailOtp(u.id, u.email, { skipSend: true })
    await db.query(`UPDATE users SET email = $2 WHERE id = $1`, [u.id, `moved-${randomUUID()}@test.dev`])

    const res = await request(buildApp()).post('/api/auth/email-otp/resend').send({ emailOtpSession: pass })
    expect(res.status).toBe(401)
    expect(res.body.error).toBe(PENDING_PASS_EMAIL_CHANGED)
    expect(sentTo).toEqual([])
    const rows = (await db.query<{ consumed_at: Date | null; attempts: number }>(
      `SELECT consumed_at, attempts FROM login_email_otps WHERE user_id = $1`, [u.id])).rows
    expect(rows).toEqual([{ consumed_at: null, attempts: 0 }])
  })

  it('cannot trade the code mailed to the old address: no token, the new address stays unverified, the code is not spent; signing in again with the new address works and names it', async () => {
    const u = await seedOwner()
    const pass = signEmailOtpSessionToken({ userId: u.id, role: 'super_admin', email: u.email, profileId: null })
    const oldCode = await issueEmailOtp(u.id, u.email, { skipSend: true })
    // A landlord-style correction: new address, not yet proven.
    const moved = `moved-${randomUUID()}@test.dev`
    await db.query(`UPDATE users SET email = $2, email_verified = FALSE, email_verified_at = NULL WHERE id = $1`, [u.id, moved])

    const refused = await request(buildApp()).post('/api/auth/email-otp/verify').send({ emailOtpSession: pass, code: oldCode })
    expect(refused.status).toBe(401)
    expect(refused.body.error).toBe(PENDING_PASS_EMAIL_CHANGED)
    expect(refused.body.data?.token).toBeUndefined()
    const after = (await db.query<{ email_verified: boolean }>(`SELECT email_verified FROM users WHERE id = $1`, [u.id])).rows[0]
    expect(after.email_verified).toBe(false)
    // Neither spent nor counted against.
    const row = (await db.query<{ consumed_at: Date | null; attempts: number }>(
      `SELECT consumed_at, attempts FROM login_email_otps WHERE user_id = $1`, [u.id])).rows[0]
    expect(row).toEqual({ consumed_at: null, attempts: 0 })

    // The person proves the new address the way /login asks (its verification
    // link), then signs in again: the code goes to the new address, and the
    // session names it.
    await db.query(`UPDATE users SET email_verified = TRUE, email_verified_at = NOW() WHERE id = $1`, [u.id])
    const login = await request(buildApp()).post('/api/auth/login').send({ email: moved, password: u.pw })
    expect(login.status).toBe(200)
    expect(login.body.data.requiresEmailOtp).toBe(true)
    expect(sentTo).toEqual([moved])
    const ok = await request(buildApp()).post('/api/auth/email-otp/verify')
      .send({ emailOtpSession: login.body.data.emailOtpSession, code: sentCodes[0] })
    expect(ok.status, JSON.stringify(ok.body)).toBe(200)
    expect((jwt.decode(ok.body.data.token) as any).email).toBe(moved)
    expect(ok.body.data.user.email).toBe(moved)
  })

  it('a pass whose address differs only in letter case still works, and the session names the address as stored', async () => {
    const u = await seedOwner()
    const pass = signEmailOtpSessionToken({ userId: u.id, role: 'super_admin', email: u.email.toUpperCase(), profileId: null })

    const resent = await request(buildApp()).post('/api/auth/email-otp/resend').send({ emailOtpSession: pass })
    expect(resent.status).toBe(200)
    expect(sentTo).toEqual([u.email])

    const ok = await request(buildApp()).post('/api/auth/email-otp/verify').send({ emailOtpSession: pass, code: sentCodes[0] })
    expect(ok.status).toBe(200)
    expect((jwt.decode(ok.body.data.token) as any).email).toBe(u.email)
    expect(ok.body.data.user.email).toBe(u.email)
  })
})

// ── A dead pending pass sends the person back to the sign-in form ──────────
//
// Every portal's code screen (landlord, tenant, invite, business, POS, admin,
// Support, GAM Books, PM) drops the pending pass and returns to the sign-in
// form only when the refusal matches /session/i. A refusal without that word
// left the person on the code screen typing codes that could never work, and a
// reload brought the dead pass back. This pins the contract for every way a
// pending pass dies, at both endpoints.
describe('every refusal of a dead pending pass says "session", so the portal returns to sign-in', () => {
  const pendingPassAt = (u: { id: string; email: string }, iat: number) =>
    jwt.sign({ userId: u.id, role: 'super_admin', email: u.email, profileId: null,
               purpose: 'email_otp_pending', iat }, process.env.JWT_SECRET!, { expiresIn: 15 * 60 })

  for (const endpoint of ['verify', 'resend'] as const) {
    it(`/${endpoint}: password changed since the pass was minted`, async () => {
      const u = await seedOwner()
      const before = pendingPassAt(u, Math.floor(Date.now() / 1000) - 60)
      await db.query(`UPDATE users SET sessions_valid_from = NOW() WHERE id = $1`, [u.id])
      const code = await issueEmailOtp(u.id, u.email, { skipSend: true })
      const res = await request(buildApp()).post(`/api/auth/email-otp/${endpoint}`)
        .send(endpoint === 'verify' ? { emailOtpSession: before, code } : { emailOtpSession: before })
      expect(res.status).toBe(401)
      expect(res.body.error).toBe(PENDING_PASS_PASSWORD_CHANGED)
      expect(res.body.error).toMatch(/session/i)
      expect(res.body.error).toMatch(/password was changed/i)
      expect(res.body.error).toMatch(/sign in again/i)
    })

    it(`/${endpoint}: sign-in email changed since the pass was minted`, async () => {
      const u = await seedOwner()
      const pass = signEmailOtpSessionToken({ userId: u.id, role: 'super_admin', email: u.email, profileId: null })
      const code = await issueEmailOtp(u.id, u.email, { skipSend: true })
      await db.query(`UPDATE users SET email = $2 WHERE id = $1`, [u.id, `moved-${randomUUID()}@test.dev`])
      const res = await request(buildApp()).post(`/api/auth/email-otp/${endpoint}`)
        .send(endpoint === 'verify' ? { emailOtpSession: pass, code } : { emailOtpSession: pass })
      expect(res.status).toBe(401)
      expect(res.body.error).toBe(PENDING_PASS_EMAIL_CHANGED)
      expect(res.body.error).toMatch(/session/i)
      expect(res.body.error).toMatch(/sign in again/i)
    })

    it(`/${endpoint}: the account is gone, or the pass is forged or expired`, async () => {
      const ghost = signEmailOtpSessionToken({ userId: randomUUID(), role: 'super_admin', email: 'ghost@test.dev', profileId: null })
      const forged = jwt.sign({ userId: randomUUID(), purpose: 'totp_pending' }, process.env.JWT_SECRET!, { expiresIn: 60 })
      const expired = jwt.sign({ userId: randomUUID(), purpose: 'email_otp_pending',
                                 exp: Math.floor(Date.now() / 1000) - 10 }, process.env.JWT_SECRET!)
      for (const pass of [ghost, forged, expired]) {
        const res = await request(buildApp()).post(`/api/auth/email-otp/${endpoint}`)
          .send(endpoint === 'verify' ? { emailOtpSession: pass, code: '000000' } : { emailOtpSession: pass })
        expect(res.status).toBe(401)
        expect(res.body.error).toMatch(/session/i)
      }
    })
  }

  it('a wrong or expired CODE is not a dead session: the person stays on the code screen', async () => {
    // The opposite half of the contract: these are fixed by typing again or
    // asking for a new code, so they must NOT read as an ended session.
    const u = await seedOwner()
    const pass = signEmailOtpSessionToken({ userId: u.id, role: 'super_admin', email: u.email, profileId: null })
    await issueEmailOtp(u.id, u.email, { skipSend: true })
    const wrong = await request(buildApp()).post('/api/auth/email-otp/verify').send({ emailOtpSession: pass, code: '999999x' })
    expect(wrong.status).toBe(401)
    expect(wrong.body.error).not.toMatch(/session/i)
    await db.query(`UPDATE login_email_otps SET expires_at = NOW() - INTERVAL '1 minute' WHERE user_id = $1`, [u.id])
    const expired = await request(buildApp()).post('/api/auth/email-otp/verify').send({ emailOtpSession: pass, code: '123456' })
    expect(expired.status).toBe(401)
    expect(expired.body.error).not.toMatch(/session/i)
  })
})

// ── The code marks only the address it was checked against ────────────────
//
// liveAccountForPendingPass checks the address before the code lookup and the
// bcrypt compare. A landlord correcting the resident's address (new address,
// email_verified=FALSE) can land in between; the code proves the OLD inbox and
// must not mark the NEW, unproven address verified.
describe('/email-otp/verify: an address corrected mid-check is not marked verified', () => {
  it('the new address stays unverified when the correction lands during the code check', async () => {
    const u = await seedOwner()
    await db.query(`UPDATE users SET email_verified = FALSE, email_verified_at = NULL WHERE id = $1`, [u.id])
    const pass = signEmailOtpSessionToken({ userId: u.id, role: 'super_admin', email: u.email, profileId: null })
    const code = await issueEmailOtp(u.id, u.email, { skipSend: true })
    const moved = `corrected-${randomUUID()}@test.dev`

    const original = bcrypt.compare.bind(bcrypt) as (s: string, h: string) => Promise<boolean>
    const spy = vi.spyOn(bcrypt, 'compare').mockImplementationOnce((async (s: string, h: string) => {
      await db.query(`UPDATE users SET email = $2, email_verified = FALSE, email_verified_at = NULL WHERE id = $1`, [u.id, moved])
      return original(s, h)
    }) as any)
    try {
      const res = await request(buildApp()).post('/api/auth/email-otp/verify').send({ emailOtpSession: pass, code })
      expect(spy).toHaveBeenCalled()
      // The code was right for the address the sign-in started with.
      expect(res.status, JSON.stringify(res.body)).toBe(200)
    } finally { spy.mockRestore() }

    const after = (await db.query<{ email: string; email_verified: boolean; email_verified_at: Date | null }>(
      `SELECT email, email_verified, email_verified_at FROM users WHERE id = $1`, [u.id])).rows[0]
    expect(after.email).toBe(moved)
    expect(after.email_verified).toBe(false)
    expect(after.email_verified_at).toBeNull()
  })

  it('with no correction, the first code still verifies the address', async () => {
    const u = await seedOwner()
    await db.query(`UPDATE users SET email_verified = FALSE, email_verified_at = NULL WHERE id = $1`, [u.id])
    const pass = signEmailOtpSessionToken({ userId: u.id, role: 'super_admin', email: u.email.toUpperCase(), profileId: null })
    const code = await issueEmailOtp(u.id, u.email, { skipSend: true })
    const res = await request(buildApp()).post('/api/auth/email-otp/verify').send({ emailOtpSession: pass, code })
    expect(res.status).toBe(200)
    const after = (await db.query<{ email_verified: boolean; email_verified_at: Date | null }>(
      `SELECT email_verified, email_verified_at FROM users WHERE id = $1`, [u.id])).rows[0]
    expect(after.email_verified).toBe(true)
    expect(after.email_verified_at).not.toBeNull()
  })
})
