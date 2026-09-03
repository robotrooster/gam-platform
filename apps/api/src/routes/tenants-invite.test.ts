/**
 * tenants.ts public-onboarding slice — S377 (tenants.ts slice 4 of N).
 *
 * Covered routes (3):
 *   - POST /api/tenants/invite — landlord invites a tenant
 *     (gated by tenants.create + canAccessLandlordResource)
 *   - POST /api/tenants/accept-invite — tenant activates via token
 *   - GET  /api/tenants/invite-info?token= — unauthenticated invite
 *     preview (used by the accept-invite page)
 *
 * Slice 1 (S374): /me + landlord-banking + verify-ach + deposit-interest.
 * Slice 2 (S375): all Flex (FlexCharge/FlexPay/FlexDeposit/FlexSuite
 *   re-accept + DELETE flex*) + portability eligibility/authorize.
 * Slice 3 (S376): OTP-deprecated + credit-reporting + payments +
 *   portability decline + re-acceptance preview.
 *
 * Out of slice (next sessions): admin-facing /:id/profile +
 *   /:id/transfer + /:id/available-units, profile patch + avatar +
 *   password, lease views, work-trade, charge-account.
 */

import { vi, describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { randomUUID } from 'crypto'
import { db } from '../db'
import {
  cleanupAllSchema, seedLandlord, seedProperty, seedUnit,
} from '../test/dbHelpers'

// notifyTenantInviteAccepted is the only non-trivial side effect in
// /accept-invite — mock it so we don't need the email plumbing.
const { notifyTenantInviteAcceptedMock, getPropertyResponsiblePartyMock, issueEmailOtpMock } = vi.hoisted(() => ({
  notifyTenantInviteAcceptedMock:    vi.fn(async (..._a: any[]) => undefined),
  getPropertyResponsiblePartyMock:   vi.fn(async (..._a: any[]) => null as any),
  // S637: the 2FA code send is the likeliest thing in this route to fail for
  // real (it talks to an email provider), so the suite can make it fail.
  issueEmailOtpMock:                 vi.fn(async (..._a: any[]) => undefined as any),
}))
vi.mock('./emailOtp', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, issueEmailOtp: issueEmailOtpMock }
})
vi.mock('../services/notifications', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, notifyTenantInviteAccepted: notifyTenantInviteAcceptedMock }
})
vi.mock('../services/responsibleParty', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, getPropertyResponsibleParty: getPropertyResponsiblePartyMock }
})

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
  notifyTenantInviteAcceptedMock.mockClear()
  notifyTenantInviteAcceptedMock.mockResolvedValue(undefined as any)
  getPropertyResponsiblePartyMock.mockClear()
  getPropertyResponsiblePartyMock.mockResolvedValue(null as any)
  issueEmailOtpMock.mockClear()
  issueEmailOtpMock.mockResolvedValue(undefined as any)
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_tenants_invite'
})

interface LandlordFixture {
  userId:     string
  landlordId: string
  propertyId: string
  unitId:     string
  token:      string
}

async function seedLandlordFixture(): Promise<LandlordFixture> {
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    const { userId, landlordId } = await seedLandlord(client)
    const propertyId = await seedProperty(client, {
      landlordId, ownerUserId: userId, managedByUserId: userId,
    })
    const unitId = await seedUnit(client, { propertyId, landlordId })
    await client.query('COMMIT')
    const token = jwt.sign(
      { userId, role: 'landlord', email: 'll@test.dev',
        profileId: landlordId, permissions: {} },
      process.env.JWT_SECRET!, { expiresIn: '1h' },
    )
    return { userId, landlordId, propertyId, unitId, token }
  } catch (e) { await client.query('ROLLBACK'); throw e }
  finally { client.release() }
}

describe('POST /invite — landlord invites tenant', () => {
  it('missing email / firstName / unitId → 400', async () => {
    const f = await seedLandlordFixture()
    const cases = [
      {},
      { email: 'x@y.com' },
      { email: 'x@y.com', firstName: 'X' },
      { firstName: 'X', unitId: f.unitId },
    ]
    for (const body of cases) {
      const res = await request(buildApp())
        .post('/api/tenants/invite')
        .set('Authorization', `Bearer ${f.token}`)
        .send(body)
      expect(res.status).toBe(400)
      expect(res.body.error).toMatch(/required/i)
    }
  })

  it('unit not found → 404', async () => {
    const f = await seedLandlordFixture()
    const res = await request(buildApp())
      .post('/api/tenants/invite')
      .set('Authorization', `Bearer ${f.token}`)
      .send({ email: 'a@b.com', firstName: 'A', unitId: randomUUID() })
    expect(res.status).toBe(404)
    expect(res.body.error).toMatch(/unit not found/i)
  })

  it('cross-landlord forbidden → 403 (landlord A invites onto landlord B unit)', async () => {
    const a = await seedLandlordFixture()
    const b = await seedLandlordFixture()
    // a tries to invite to b's unit.
    const res = await request(buildApp())
      .post('/api/tenants/invite')
      .set('Authorization', `Bearer ${a.token}`)
      .send({ email: 'a@b.com', firstName: 'A', unitId: b.unitId })
    expect(res.status).toBe(403)
    expect(res.body.error).toMatch(/forbidden/i)
  })

  it('happy: creates user + tenant + invite token; URL uses TENANT_APP_URL', async () => {
    const f = await seedLandlordFixture()
    process.env.TENANT_APP_URL = 'https://tenant.test.gam'
    const res = await request(buildApp())
      .post('/api/tenants/invite')
      .set('Authorization', `Bearer ${f.token}`)
      .send({ email: 'new-tenant@test.dev', firstName: 'New', lastName: 'Tenant', unitId: f.unitId, phone: '5555550100' })

    expect(res.status).toBe(200)
    expect(res.body.success).toBe(true)
    expect(res.body.data.email).toBe('new-tenant@test.dev')
    expect(res.body.data.inviteToken).toMatch(/^[0-9a-f]{64}$/)
    expect(res.body.data.acceptUrl).toContain('https://tenant.test.gam/accept-invite?token=')

    // Side effects: user row + tenants row + token stamped on users.
    // S410 (S377): read tenant_invite_token + expiry, not email_verify_token.
    const u = await db.query<{ id: string; first_name: string; phone: string;
                                tenant_invite_token: string;
                                tenant_invite_expires_at: Date }>(
      `SELECT id, first_name, phone, tenant_invite_token, tenant_invite_expires_at
         FROM users WHERE email=$1`,
      ['new-tenant@test.dev'])
    expect(u.rows[0].first_name).toBe('New')
    expect(u.rows[0].phone).toBe('5555550100')
    expect(u.rows[0].tenant_invite_token).toBe(res.body.data.inviteToken)
    // S410: 7-day expiry stamped at invite time.
    const expiresAt = new Date(u.rows[0].tenant_invite_expires_at)
    const expectedExpiry = Date.now() + 7 * 24 * 60 * 60 * 1000
    expect(Math.abs(expiresAt.getTime() - expectedExpiry)).toBeLessThan(60 * 1000)
    const t = await db.query<{ id: string }>(`SELECT id FROM tenants WHERE user_id=$1`, [u.rows[0].id])
    expect(t.rows).toHaveLength(1)
  })

  it('re-invite same email reuses existing user (no duplicate)', async () => {
    const f = await seedLandlordFixture()
    // Pre-seed an existing user row with this email.
    await db.query(
      `INSERT INTO users (email, password_hash, role, first_name, last_name)
       VALUES ($1, 'x', 'tenant', 'Pre', 'Existing')`,
      ['preexist@test.dev'])

    const r = await request(buildApp())
      .post('/api/tenants/invite')
      .set('Authorization', `Bearer ${f.token}`)
      .send({ email: 'preexist@test.dev', firstName: 'Ignored', unitId: f.unitId })

    expect(r.status).toBe(200)
    const u = await db.query(`SELECT id FROM users WHERE email=$1`, ['preexist@test.dev'])
    expect(u.rows).toHaveLength(1)  // not duplicated
  })
})

describe('POST /accept-invite — tenant activates account', () => {
  async function seedPendingInvite(): Promise<{ token: string; userId: string; tenantId: string }> {
    const client = await db.connect()
    try {
      await client.query('BEGIN')
      const inviteToken = 'invitetoken_' + randomUUID().replace(/-/g, '')
      // S410 (S377): write to tenant_invite_token + 7d expiry, not the
      // overloaded email_verify_token.
      const u = await client.query<{ id: string }>(
        `INSERT INTO users (email, password_hash, role, first_name, last_name,
                            tenant_invite_token, tenant_invite_expires_at, email_verified)
         VALUES ($1, '$2b$10$placeholder_invite_pending', 'tenant', 'Pending', 'Tenant',
                 $2, NOW() + INTERVAL '7 days', FALSE)
         RETURNING id`,
        ['pending-' + randomUUID() + '@test.dev', inviteToken])
      const t = await client.query<{ id: string }>(
        `INSERT INTO tenants (user_id) VALUES ($1) RETURNING id`, [u.rows[0].id])
      await client.query('COMMIT')
      return { token: inviteToken, userId: u.rows[0].id, tenantId: t.rows[0].id }
    } catch (e) { await client.query('ROLLBACK'); throw e }
    finally { client.release() }
  }

  // ── S637: A FAILURE MUST NEVER SPEND THE LINK ────────────────────────
  //
  // Laurel Rhoades, MH 02 Mountain View. She set a password and a phone number,
  // the page told her it failed, and her retry said "invalid or expired invite
  // link" — because the token was cleared two statements in, before the work it
  // authorised was done, in a route with no transaction. Her password, phone and
  // terms acceptance were saved; her invite was never marked accepted and her
  // lease was never drafted. She had an account she could not reach and a link
  // that was already spent.
  it('S637: a failure mid-activation leaves the invite link still usable', async () => {
    const f = await seedPendingInvite()

    // Something after the password write blows up. (The real one was somewhere
    // in the three unguarded statements that followed it.)
    const boom = new Error('database went away mid-activation')
    issueEmailOtpMock.mockRejectedValueOnce(boom)

    // The OTP send is deliberately NON-fatal now, so this still succeeds — the
    // account is committed and the code send is best-effort.
    const first = await request(buildApp())
      .post('/api/tenants/accept-invite')
      .send({ token: f.token, password: 'longenoughpassword', phone: '5205551234', acceptedTerms: true })
    expect(first.status).toBe(200)
    // ...and it says the code did not go, so the page can offer a resend
    // instead of claiming the link was bad.
    expect(first.body.data.otpSent).toBe(false)

    // The activation itself is whole: password, phone, terms AND the 2FA flag,
    // which used to be a separate late UPDATE that Laurel never reached.
    const u = await db.query<{ pw: string; phone: string; tos: string | null; twofa: boolean; tok: string | null }>(
      `SELECT password_hash AS pw, phone, accepted_tos_at AS tos,
              email_2fa_enabled AS twofa, tenant_invite_token AS tok
         FROM users WHERE id = $1`, [f.userId])
    expect(u.rows[0].pw.startsWith('$2')).toBe(true)
    expect(u.rows[0].phone).toBe('5205551234')
    expect(u.rows[0].tos).not.toBeNull()
    expect(u.rows[0].twofa).toBe(true)
    // Spent, because the activation genuinely committed.
    expect(u.rows[0].tok).toBeNull()
  })

  it('S637: the token is only spent if the activation commits', async () => {
    const f = await seedPendingInvite()

    // Force a REAL failure inside the activation transaction. A trigger that
    // raises on a sentinel phone number fires during the very UPDATE that would
    // clear the token, so this exercises the rollback path rather than
    // describing it.
    await db.query(`
      CREATE OR REPLACE FUNCTION s637_boom() RETURNS trigger AS $$
      BEGIN
        IF NEW.phone = '0000000000' THEN RAISE EXCEPTION 's637 forced failure'; END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql`)
    await db.query(`DROP TRIGGER IF EXISTS s637_boom_trg ON users`)
    await db.query(`CREATE TRIGGER s637_boom_trg BEFORE UPDATE ON users
                    FOR EACH ROW EXECUTE FUNCTION s637_boom()`)
    try {
      const failed = await request(buildApp())
        .post('/api/tenants/accept-invite')
        .send({ token: f.token, password: 'longenoughpassword', phone: '0000000000', acceptedTerms: true })
      expect(failed.status).toBeGreaterThanOrEqual(500)

      // NOTHING was written — and crucially the invite token is untouched, so
      // the link already sitting in the tenant's inbox still works.
      const after = await db.query<{ tok: string | null; tos: string | null }>(
        `SELECT tenant_invite_token AS tok, accepted_tos_at AS tos FROM users WHERE id = $1`, [f.userId])
      expect(after.rows[0].tok).toBe(f.token)
      expect(after.rows[0].tos).toBeNull()
    } finally {
      await db.query(`DROP TRIGGER IF EXISTS s637_boom_trg ON users`)
      await db.query(`DROP FUNCTION IF EXISTS s637_boom()`)
    }

    // With the fault cleared, the very same link still activates the account.
    const ok = await request(buildApp())
      .post('/api/tenants/accept-invite')
      .send({ token: f.token, password: 'longenoughpassword', acceptedTerms: true })
    expect(ok.status).toBe(200)

    // And it is single-use: a replay of a SPENT link is refused, rather than
    // activating twice and drafting a second lease.
    const replay = await request(buildApp())
      .post('/api/tenants/accept-invite')
      .send({ token: f.token, password: 'longenoughpassword', acceptedTerms: true })
    expect(replay.status).toBe(404)
  })

  it('missing token → 400', async () => {
    const res = await request(buildApp())
      .post('/api/tenants/accept-invite')
      .send({ password: 'longenough', acceptedTerms: true })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/token.*required/i)
  })

  it('missing password → 400', async () => {
    const res = await request(buildApp())
      .post('/api/tenants/accept-invite')
      .send({ token: 'tok', acceptedTerms: true })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/password.*required/i)
  })

  it('password < 12 chars → 400', async () => {
    const res = await request(buildApp())
      .post('/api/tenants/accept-invite')
      .send({ token: 'tok', password: 'short', acceptedTerms: true })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/at least 12/i)
  })

  it('acceptedTerms !== true → 400', async () => {
    const res = await request(buildApp())
      .post('/api/tenants/accept-invite')
      .send({ token: 'tok', password: 'longenoughpwd', acceptedTerms: false })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/accept.*terms/i)
  })

  it('invalid token → 404', async () => {
    const res = await request(buildApp())
      .post('/api/tenants/accept-invite')
      .send({ token: 'nope_does_not_exist', password: 'longenoughpwd', acceptedTerms: true })
    expect(res.status).toBe(404)
    expect(res.body.error).toMatch(/invalid.*expired/i)
  })

  it('happy: sets password, clears token, stamps tos+privacy+verified, returns pending 2FA session', async () => {
    const { token, userId, tenantId } = await seedPendingInvite()
    const res = await request(buildApp())
      .post('/api/tenants/accept-invite')
      .send({ token, password: 'newpass8chars', phone: '5555550199', acceptedTerms: true })

    expect(res.status).toBe(200)
    // S578: mandatory email-2FA at activation — a PENDING session, not a full
    // token. The client trades the emailed code at /email-otp/verify.
    expect(res.body.data.requiresEmailOtp).toBe(true)
    expect(res.body.data.emailOtpSession).toBeTruthy()
    const decoded = jwt.verify(res.body.data.emailOtpSession, process.env.JWT_SECRET!) as any
    expect(decoded.userId).toBe(userId)
    expect(decoded.profileId).toBe(tenantId)
    expect(decoded.role).toBe('tenant')
    expect(decoded.purpose).toBe('email_otp_pending')

    // S410 (S377): accept clears tenant_invite_token + expiry. Email
    // verification column is independent.
    const u = await db.query<{
      password_hash: string; tenant_invite_token: string | null;
      tenant_invite_expires_at: Date | null; email_verified: boolean;
      phone: string | null; accepted_tos_at: Date | null; accepted_privacy_at: Date | null;
    }>(
      `SELECT password_hash, tenant_invite_token, tenant_invite_expires_at,
              email_verified, phone, accepted_tos_at, accepted_privacy_at
         FROM users WHERE id=$1`, [userId])
    expect(u.rows[0].password_hash).not.toBe('$2b$10$placeholder_invite_pending')
    expect(u.rows[0].password_hash).toMatch(/^\$2[aby]\$/)  // bcrypt envelope
    expect(u.rows[0].tenant_invite_token).toBeNull()
    expect(u.rows[0].tenant_invite_expires_at).toBeNull()
    expect(u.rows[0].email_verified).toBe(true)
    expect(u.rows[0].phone).toBe('5555550199')
    expect(u.rows[0].accepted_tos_at).not.toBeNull()
    expect(u.rows[0].accepted_privacy_at).not.toBeNull()
  })

  it('happy with ssiSsdi=true: flips tenants.ssi_ssdi flag', async () => {
    const { token, userId } = await seedPendingInvite()
    const res = await request(buildApp())
      .post('/api/tenants/accept-invite')
      .send({ token, password: 'newpass8chars', acceptedTerms: true, ssiSsdi: true })
    expect(res.status).toBe(200)
    const t = await db.query<{ ssi_ssdi: boolean }>(
      `SELECT ssi_ssdi FROM tenants WHERE user_id=$1`, [userId])
    expect(t.rows[0].ssi_ssdi).toBe(true)
  })
})

describe('GET /invite-info — unauthenticated preview', () => {
  it('missing token → 400', async () => {
    const res = await request(buildApp())
      .get('/api/tenants/invite-info')
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/token required/i)
  })

  it('invalid token → 404', async () => {
    const res = await request(buildApp())
      .get('/api/tenants/invite-info?token=does_not_exist_anywhere')
    expect(res.status).toBe(404)
    expect(res.body.error).toMatch(/invalid.*expired/i)
  })

  it('happy without active lease: returns user, unit=null', async () => {
    // S410 (S377): seed on tenant_invite_token + 7d expiry, not the
    // overloaded email_verify_token column.
    const inviteToken = 'preview_' + randomUUID().replace(/-/g, '')
    await db.query(
      `INSERT INTO users (email, password_hash, role, first_name, last_name,
                          tenant_invite_token, tenant_invite_expires_at)
       VALUES ($1, 'x', 'tenant', 'Preview', 'User', $2, NOW() + INTERVAL '7 days')`,
      ['preview@test.dev', inviteToken])

    const res = await request(buildApp())
      .get(`/api/tenants/invite-info?token=${inviteToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data.user).toMatchObject({
      email: 'preview@test.dev', first_name: 'Preview', last_name: 'User',
    })
    expect(res.body.data.unit).toBeNull()
  })
})
