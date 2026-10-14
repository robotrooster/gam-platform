/**
 * 10/13 (Nic): "there was some kind of issue on the signing up flow through
 * the bookkeeper invite link. She said she figured it out now, but it told her
 * to sign in and then something about it not going anywhere ... whatever the
 * process is, it's not smooth."
 *
 * The live log, 10/13 (Phoenix time): the owner invited a bookkeeper (company-
 * wide). She opened the link at 16:30, created her account at 16:31 (accept,
 * 200), opened the link again at 16:32 and 16:34, and got in at 16:37 only by
 * finding the landlord portal's sign-in herself (password, then the emailed
 * code). She was brand new to GAM.
 *
 * The cause, end to end: the accept answered with no way in (no session, no
 * code step), so the page told her to go sign in somewhere else — GAM Books,
 * whose /login answered with a 404 — and opening the link again said "This
 * invitation is accepted. Ask your employer to send a new invite link."
 *
 * Now a new account's accept answers with the emailed-code step, the same
 * pending pass /login hands out (built the same way), so the page goes from
 * "Create account" to the code box and from there to her pages. Opening the
 * link again is told, in plain words, that the account is already set up and
 * to sign in. The other team roles share the page and the route.
 */
import { vi, describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { randomUUID } from 'crypto'
import { db } from '../db'
import { cleanupAllSchema, seedLandlord, seedManager, seedProperty } from '../test/dbHelpers'

const { emailInvitationMock, sentCodes } = vi.hoisted(() => ({
  emailInvitationMock: vi.fn(async (..._args: any[]) => 'msg_invitation_mock'),
  sentCodes: [] as Array<{ to: string; code: string }>,
}))
vi.mock('../services/email', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    emailInvitation: emailInvitationMock,
    emailLoginCode: vi.fn(async (to: string, code: string) => { sentCodes.push({ to, code }); return 'msg_code_mock' }),
  }
})
// 10/13 review: issueEmailOtp as itself, so one test can make the code
// impossible to issue (otpSent: false) and see the way out.
const { issueFailsOnce } = vi.hoisted(() => ({ issueFailsOnce: { armed: false } }))
vi.mock('./emailOtp', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./emailOtp')>()
  return {
    ...actual,
    issueEmailOtp: vi.fn(async (...args: Parameters<typeof actual.issueEmailOtp>) => {
      if (issueFailsOnce.armed) { issueFailsOnce.armed = false; throw new Error('login_email_otps unavailable') }
      return actual.issueEmailOtp(...args)
    }),
  }
})
vi.mock('../services/notifications', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, createNotification: vi.fn(async () => undefined) }
})

import { scopesRouter, invitationsRouter } from './scopes'
import { emailOtpRouter } from './emailOtp'
import { errorHandler } from '../middleware/errorHandler'

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/scopes', scopesRouter)
  app.use('/api/invitations', invitationsRouter)
  app.use('/api/auth/email-otp', emailOtpRouter)
  app.use(errorHandler)
  return app
}

beforeEach(async () => {
  await cleanupAllSchema()
  emailInvitationMock.mockClear()
  sentCodes.length = 0
  issueFailsOnce.armed = false
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_invite_signin'
})

/** The token from the last invitation email's link — the only place it goes. */
function tokenFromEmail(): string {
  const calls = emailInvitationMock.mock.calls
  return String(calls[calls.length - 1]?.[3] ?? '').split('/').pop() ?? ''
}

async function seedCompany(): Promise<{ landlordId: string; landlordUserId: string; ownerToken: string; park: string }> {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const { userId: landlordUserId, landlordId } = await seedLandlord(c)
    const park = await seedProperty(c, { landlordId, ownerUserId: landlordUserId, managedByUserId: landlordUserId })
    await c.query('COMMIT')
    const ownerToken = jwt.sign(
      { userId: landlordUserId, role: 'landlord', email: 'owner@test.dev', profileId: null, landlordIds: [landlordId], permissions: {} },
      process.env.JWT_SECRET!, { expiresIn: '1h' })
    return { landlordId, landlordUserId, ownerToken, park }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

type Role = 'bookkeeper' | 'onsite_manager' | 'property_manager' | 'maintenance'
function scopeFor(role: Role, park: string) {
  if (role === 'bookkeeper') return { propertyIds: [park], companyWide: true }
  if (role === 'maintenance') return { propertyIds: [park], unitIds: [], jobCategories: [], allProperties: false }
  return { propertyIds: [park], unitIds: [], allProperties: false }
}

async function invite(f: Awaited<ReturnType<typeof seedCompany>>, role: Role, email: string): Promise<string> {
  const res = await request(buildApp())
    .post(`/api/scopes/${role}/invite`)
    .set('Authorization', `Bearer ${f.ownerToken}`)
    .send({ email, scope: scopeFor(role, f.park) })
  if (res.status !== 201) throw new Error(`invite failed: ${res.status} ${JSON.stringify(res.body)}`)
  return tokenFromEmail()
}

const NEW_ACCOUNT = { password: 'her_own_pw_1013', firstName: 'Kay', lastName: 'Keeper' }

describe('10/13: a new team member goes from the emailed link to signed in, in one path', () => {
  it("the bookkeeper's path: Create account → the code box → a session for her company (no second trip to a sign-in page)", async () => {
    const f = await seedCompany()
    const email = `bk-${randomUUID().slice(0, 8)}@test.dev`
    const token = await invite(f, 'bookkeeper', email)

    const shown = await request(buildApp()).get(`/api/invitations/${token}`)
    expect(shown.status).toBe(200)
    expect(shown.body.data).toMatchObject({ status: 'pending', userExists: false, expired: false, role: 'bookkeeper' })

    const accepted = await request(buildApp()).post(`/api/invitations/${token}/accept`).send(NEW_ACCOUNT)
    expect(accepted.status).toBe(200)
    expect(accepted.body.data.role).toBe('bookkeeper')
    // The code step, right here — the same pending pass /login hands out.
    expect(accepted.body.data.requiresEmailOtp).toBe(true)
    expect(typeof accepted.body.data.emailOtpSession).toBe('string')
    expect(accepted.body.data.otpSent).toBe(true)
    // Never a full session without the code (S578: no account is exempt).
    expect(accepted.body.data).not.toHaveProperty('token')
    const pending = jwt.decode(accepted.body.data.emailOtpSession) as any
    expect(pending.purpose).toBe('email_otp_pending')

    // The code went to her address, the one the invitation was sent to.
    expect(sentCodes).toHaveLength(1)
    expect(sentCodes[0].to.toLowerCase()).toBe(email.toLowerCase())
    const account = (await db.query<{ email_2fa_enabled: boolean; email_verified: boolean }>(
      `SELECT email_2fa_enabled, email_verified FROM users WHERE lower(email) = lower($1)`, [email])).rows[0]
    expect(account).toEqual({ email_2fa_enabled: true, email_verified: true })

    // She types the code: signed in, as a bookkeeper of THIS company.
    const signedIn = await request(buildApp()).post('/api/auth/email-otp/verify')
      .send({ emailOtpSession: accepted.body.data.emailOtpSession, code: sentCodes[0].code })
    expect(signedIn.status).toBe(200)
    const pass = jwt.decode(signedIn.body.data.token) as any
    expect(pass).toMatchObject({ role: 'bookkeeper', userId: accepted.body.data.userId, landlordId: f.landlordId })
    expect(pass.purpose).toBeUndefined()
  })

  it('opening the link again after accepting says the account is set up and to sign in — never "ask for a new invite"', async () => {
    const f = await seedCompany()
    const email = `again-${randomUUID().slice(0, 8)}@test.dev`
    const token = await invite(f, 'bookkeeper', email)
    expect((await request(buildApp()).post(`/api/invitations/${token}/accept`).send(NEW_ACCOUNT)).status).toBe(200)

    // 16:32 and 16:34: the link opened again.
    const shown = await request(buildApp()).get(`/api/invitations/${token}`)
    expect(shown.status).toBe(200)
    expect(shown.body.data).toMatchObject({ status: 'accepted', userExists: true, expired: false })

    // A second tap on Create account (or a second tab) hears the same thing.
    const again = await request(buildApp()).post(`/api/invitations/${token}/accept`).send(NEW_ACCOUNT)
    expect(again.status).toBe(409)
    expect(again.body.code).toBe('ALREADY_ACCEPTED')
    expect(again.body.error).toMatch(/already set up/i)
    expect(again.body.error).toMatch(/sign in/i)
    expect(again.body.error).not.toMatch(/send a new/i)
    // Nothing new was mailed and nothing changed.
    expect(sentCodes).toHaveLength(1)
    expect((await db.query(`SELECT 1 FROM bookkeeper_scopes`)).rows).toHaveLength(1)
  })

  for (const role of ['onsite_manager', 'property_manager', 'maintenance'] as const) {
    it(`the same path for ${role} (the page and the route are shared)`, async () => {
      const f = await seedCompany()
      const email = `${role}-${randomUUID().slice(0, 8)}@test.dev`
      const token = await invite(f, role, email)

      const accepted = await request(buildApp()).post(`/api/invitations/${token}/accept`).send(NEW_ACCOUNT)
      expect(accepted.status).toBe(200)
      expect(accepted.body.data).toMatchObject({ role, requiresEmailOtp: true, otpSent: true })
      expect(sentCodes.map(s => s.to.toLowerCase())).toEqual([email.toLowerCase()])

      const signedIn = await request(buildApp()).post('/api/auth/email-otp/verify')
        .send({ emailOtpSession: accepted.body.data.emailOtpSession, code: sentCodes[0].code })
      expect(signedIn.status).toBe(200)
      expect(jwt.decode(signedIn.body.data.token)).toMatchObject({ role, landlordId: f.landlordId })
    })
  }

  it('an expired link says so before anyone fills the form, and the refusal says what to do', async () => {
    const f = await seedCompany()
    const token = await invite(f, 'bookkeeper', `late-${randomUUID().slice(0, 8)}@test.dev`)
    await db.query(`UPDATE invitations SET expires_at = NOW() - INTERVAL '1 hour' WHERE token = $1`, [token])

    const shown = await request(buildApp()).get(`/api/invitations/${token}`)
    expect(shown.body.data).toMatchObject({ status: 'pending', expired: true })

    const res = await request(buildApp()).post(`/api/invitations/${token}/accept`).send(NEW_ACCOUNT)
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/expired/)
    expect(res.body.error).toMatch(/new one/i)
    expect(sentCodes).toHaveLength(0)

    // After the hourly sweep (jobs/scheduler processInvitationExpiry) marks it.
    await db.query(`UPDATE invitations SET status = 'expired' WHERE token = $1`, [token])
    expect((await request(buildApp()).get(`/api/invitations/${token}`)).body.data).toMatchObject({ status: 'expired', expired: true })
    const swept = await request(buildApp()).post(`/api/invitations/${token}/accept`).send(NEW_ACCOUNT)
    expect(swept.status).toBe(400)
    expect(swept.body.error).toMatch(/expired/)
    expect((await db.query(`SELECT 1 FROM users WHERE lower(email) LIKE 'late-%'`)).rows).toHaveLength(0)
  })

  it('a withdrawn invitation is told in plain words, not "Invitation is revoked"', async () => {
    const f = await seedCompany()
    const token = await invite(f, 'maintenance', `gone-${randomUUID().slice(0, 8)}@test.dev`)
    await db.query(`UPDATE invitations SET status = 'revoked', revoked_at = NOW() WHERE token = $1`, [token])

    const res = await request(buildApp()).post(`/api/invitations/${token}/accept`).send(NEW_ACCOUNT)
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/withdrawn/i)
    expect(res.body.error).not.toMatch(/revoked/)
  })

  it('an existing account accepts from its own session and is already signed in: no code is mailed, no pending pass', async () => {
    const f = await seedCompany()
    const c = await db.connect()
    let userId: string
    try { userId = await seedManager(c) } finally { c.release() }
    const email = (await db.query<{ email: string }>(`SELECT email FROM users WHERE id = $1`, [userId!])).rows[0].email
    const token = await invite(f, 'property_manager', email)
    const ownSession = jwt.sign({ userId: userId!, role: 'property_manager', email, profileId: null, permissions: {} },
      process.env.JWT_SECRET!, { expiresIn: '1h' })

    const res = await request(buildApp()).post(`/api/invitations/${token}/accept`)
      .set('Authorization', `Bearer ${ownSession}`).send({})
    expect(res.status).toBe(200)
    expect(res.body.data.userId).toBe(userId!)
    expect(res.body.data).not.toHaveProperty('emailOtpSession')
    expect(sentCodes).toHaveLength(0)
  })

  // 10/13 review: otpSent: false means no code could be issued at all — the
  // page then says so (not "we sent") and its Resend is the way out.
  it('when no code can be issued, the account still exists, the pass is handed over with otpSent: false, and Resend gets her in', async () => {
    const f = await seedCompany()
    const email = `nocode-${randomUUID().slice(0, 8)}@test.dev`
    const token = await invite(f, 'bookkeeper', email)
    issueFailsOnce.armed = true

    const accepted = await request(buildApp()).post(`/api/invitations/${token}/accept`).send(NEW_ACCOUNT)
    expect(accepted.status).toBe(200)
    expect(accepted.body.data).toMatchObject({ role: 'bookkeeper', requiresEmailOtp: true, otpSent: false })
    expect(sentCodes).toHaveLength(0)
    expect((await db.query(`SELECT 1 FROM login_email_otps o JOIN users u ON u.id = o.user_id WHERE lower(u.email) = lower($1)`, [email])).rows).toHaveLength(0)
    expect((await db.query(`SELECT status FROM invitations WHERE token = $1`, [token])).rows[0].status).toBe('accepted')

    const resent = await request(buildApp()).post('/api/auth/email-otp/resend')
      .send({ emailOtpSession: accepted.body.data.emailOtpSession })
    expect(resent.status).toBe(200)
    expect(sentCodes.map(c => c.to.toLowerCase())).toEqual([email.toLowerCase()])
    const signedIn = await request(buildApp()).post('/api/auth/email-otp/verify')
      .send({ emailOtpSession: accepted.body.data.emailOtpSession, code: sentCodes[0].code })
    expect(signedIn.status).toBe(200)
    expect(jwt.decode(signedIn.body.data.token)).toMatchObject({ role: 'bookkeeper', landlordId: f.landlordId })
  })
})

// 10/13 review: the expired page says "ask them to send you a new one" — so
// the owner must be able to, at once, not after the hourly sweep.
describe('10/13: an expired invitation can be replaced right away', () => {
  it('inviting the same address again replaces a lapsed invitation (marked expired, as the sweep would), and the new link works', async () => {
    const f = await seedCompany()
    const email = `redo-${randomUUID().slice(0, 8)}@test.dev`
    const oldToken = await invite(f, 'bookkeeper', email)
    // Past its expiry, still 'pending' — the hourly sweep has not run.
    await db.query(`UPDATE invitations SET expires_at = NOW() - INTERVAL '1 minute' WHERE token = $1`, [oldToken])
    const oldId = (await db.query<{ id: string }>(`SELECT id FROM invitations WHERE token = $1`, [oldToken])).rows[0].id

    const newToken = await invite(f, 'bookkeeper', email)
    expect(newToken).not.toBe(oldToken)

    const rows = (await db.query<{ token: string; status: string }>(
      `SELECT token, status FROM invitations WHERE lower(email) = lower($1) ORDER BY created_at`, [email])).rows
    expect(rows.map(r => [r.token, r.status])).toEqual([[oldToken, 'expired'], [newToken, 'pending']])
    const events = (await db.query<{ event_type: string; actor_user_id: string | null }>(
      `SELECT event_type, actor_user_id FROM platform_events WHERE subject_id = $1 ORDER BY created_at`, [oldId])).rows
    expect(events).toEqual([
      { event_type: 'invitation.created', actor_user_id: f.landlordUserId },
      { event_type: 'invitation.expired', actor_user_id: null },
    ])

    // The old link still says expired; the new one sets her up.
    expect((await request(buildApp()).get(`/api/invitations/${oldToken}`)).body.data).toMatchObject({ status: 'expired', expired: true })
    const accepted = await request(buildApp()).post(`/api/invitations/${newToken}/accept`).send(NEW_ACCOUNT)
    expect(accepted.status).toBe(200)
    expect(accepted.body.data).toMatchObject({ role: 'bookkeeper', requiresEmailOtp: true })
  })

  it('a live pending invitation to the same address is still refused (no second link while the first works)', async () => {
    const f = await seedCompany()
    const email = `twice-${randomUUID().slice(0, 8)}@test.dev`
    await invite(f, 'bookkeeper', email)
    const again = await request(buildApp())
      .post('/api/scopes/bookkeeper/invite')
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .send({ email, scope: scopeFor('bookkeeper', f.park) })
    expect(again.status).toBe(409)
    expect(again.body.error).toMatch(/pending invitation already exists/)
    expect((await db.query(`SELECT status FROM invitations WHERE lower(email) = lower($1)`, [email])).rows)
      .toEqual([{ status: 'pending' }])
  })
})
