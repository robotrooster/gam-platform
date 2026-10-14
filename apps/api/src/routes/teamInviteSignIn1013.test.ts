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
 *
 * 10/13 evening (Nic): "After creating the account from the invite link, SKIP
 * the code step once (the invite link counts as proof of email) — sign straight
 * in." So the accept of a NEW account now answers with a full session, built
 * the way /login builds one, and mails no code. Once: opening the link again
 * signs nobody in, a later sign-in asks for the code, and an existing account
 * accepting from its own session gets nothing new.
 */
import { vi, describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { randomUUID } from 'crypto'
import { db } from '../db'
import { readFileSync } from 'fs'
import { join } from 'path'
import { cleanupAllSchema, seedLandlord, seedManager, seedProperty, seedTenant } from '../test/dbHelpers'

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
// 10/13 evening: the link's session as itself, so one test can make it
// impossible to mint (signedIn: false) and see the way out.
const { sessionFailsOnce } = vi.hoisted(() => ({ sessionFailsOnce: { armed: false } }))
vi.mock('./auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./auth')>()
  return {
    ...actual,
    sessionFromTeamInvitation: vi.fn(async (...args: Parameters<typeof actual.sessionFromTeamInvitation>) => {
      if (sessionFailsOnce.armed) { sessionFailsOnce.armed = false; throw new Error('users unavailable') }
      return actual.sessionFromTeamInvitation(...args)
    }),
  }
})
vi.mock('../services/notifications', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, createNotification: vi.fn(async () => undefined) }
})

import { scopesRouter, invitationsRouter } from './scopes'
import { emailOtpRouter } from './emailOtp'
import { authRouter, sessionFromTeamInvitation } from './auth'
import { errorHandler } from '../middleware/errorHandler'

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/scopes', scopesRouter)
  app.use('/api/invitations', invitationsRouter)
  app.use('/api/auth/email-otp', emailOtpRouter)
  app.use('/api/auth', authRouter)
  app.use(errorHandler)
  return app
}

beforeEach(async () => {
  await cleanupAllSchema()
  emailInvitationMock.mockClear()
  sentCodes.length = 0
  sessionFailsOnce.armed = false
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_invite_signin'
})

/** The pass's own claims, without the JWT clock fields. */
function claimsOf(token: string): Record<string, unknown> {
  const { iat: _iat, exp: _exp, ...rest } = jwt.decode(token) as Record<string, unknown>
  return rest
}

/** A normal sign-in later on: password, then the emailed code. */
async function signInLater(email: string, password: string): Promise<request.Response> {
  const login = await request(buildApp()).post('/api/auth/login').send({ email, password })
  if (login.status !== 200 || !login.body.data.requiresEmailOtp) throw new Error(`login: ${login.status} ${JSON.stringify(login.body)}`)
  const code = sentCodes[sentCodes.length - 1].code
  return request(buildApp()).post('/api/auth/email-otp/verify')
    .send({ emailOtpSession: login.body.data.emailOtpSession, code })
}

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
  it("the bookkeeper's path: Create account → signed in to her company's pages; no code, no second trip to a sign-in page", async () => {
    const f = await seedCompany()
    const email = `bk-${randomUUID().slice(0, 8)}@test.dev`
    const token = await invite(f, 'bookkeeper', email)

    const shown = await request(buildApp()).get(`/api/invitations/${token}`)
    expect(shown.status).toBe(200)
    expect(shown.body.data).toMatchObject({ status: 'pending', userExists: false, expired: false, role: 'bookkeeper' })

    const accepted = await request(buildApp()).post(`/api/invitations/${token}/accept`).send(NEW_ACCOUNT)
    expect(accepted.status).toBe(200)
    expect(accepted.body.data.role).toBe('bookkeeper')
    // 10/13 evening (Nic): "the invite link counts as proof of email" — a full
    // session, right here. No pending pass, no code step.
    expect(accepted.body.data.signedIn).toBe(true)
    expect(accepted.body.data).not.toHaveProperty('emailOtpSession')
    expect(accepted.body.data).not.toHaveProperty('requiresEmailOtp')
    const pass = jwt.decode(accepted.body.data.token) as any
    expect(pass).toMatchObject({ role: 'bookkeeper', userId: accepted.body.data.userId, landlordId: f.landlordId, email })
    expect(pass.purpose).toBeUndefined()
    expect(accepted.body.data.user).toMatchObject({
      id: accepted.body.data.userId, email, role: 'bookkeeper', firstName: 'Kay', lastName: 'Keeper', landlordId: f.landlordId,
    })

    // Nothing was mailed and no code was stored: the link was the proof.
    expect(sentCodes).toHaveLength(0)
    expect((await db.query(`SELECT 1 FROM login_email_otps WHERE user_id = $1`, [accepted.body.data.userId])).rows).toHaveLength(0)
    // The account still has the emailed code for every later sign-in (S578).
    const account = (await db.query<{ email_2fa_enabled: boolean; email_verified: boolean; signed_in: boolean }>(
      `SELECT email_2fa_enabled, email_verified, last_login_at IS NOT NULL AS signed_in FROM users WHERE lower(email) = lower($1)`, [email])).rows[0]
    expect(account).toEqual({ email_2fa_enabled: true, email_verified: true, signed_in: true })

    // The session works: /auth/me answers as her, a bookkeeper of THIS company.
    const me = await request(buildApp()).get('/api/auth/me').set('Authorization', `Bearer ${accepted.body.data.token}`)
    expect(me.status).toBe(200)
    expect(me.body.data).toMatchObject({ id: accepted.body.data.userId, role: 'bookkeeper', landlordId: f.landlordId })
  })

  it('once only: the next sign-in is password + emailed code, and it gives the very same session the link did', async () => {
    const f = await seedCompany()
    const email = `later-${randomUUID().slice(0, 8)}@test.dev`
    const token = await invite(f, 'bookkeeper', email)
    const accepted = await request(buildApp()).post(`/api/invitations/${token}/accept`).send(NEW_ACCOUNT)
    expect(accepted.body.data.signedIn).toBe(true)

    // The password alone is not a session: the code is asked for.
    const login = await request(buildApp()).post('/api/auth/login').send({ email, password: NEW_ACCOUNT.password })
    expect(login.status).toBe(200)
    expect(login.body.data.requiresEmailOtp).toBe(true)
    expect(login.body.data).not.toHaveProperty('token')
    expect(sentCodes.map(s => s.to.toLowerCase())).toEqual([email.toLowerCase()])

    // With the code: the same claims and the same session policy the link's pass carried.
    const later = await signInLater(email, NEW_ACCOUNT.password)
    expect(later.status).toBe(200)
    expect(claimsOf(later.body.data.token)).toEqual(claimsOf(accepted.body.data.token))
  })

  it('two taps on Create account at once sign in once: one session, the other is told the account is set up', async () => {
    const f = await seedCompany()
    const token = await invite(f, 'bookkeeper', `twice-${randomUUID().slice(0, 8)}@test.dev`)
    const [a, b] = await Promise.all([
      request(buildApp()).post(`/api/invitations/${token}/accept`).send(NEW_ACCOUNT),
      request(buildApp()).post(`/api/invitations/${token}/accept`).send(NEW_ACCOUNT),
    ])
    const statuses = [a.status, b.status].sort()
    expect(statuses).toEqual([200, 409])
    const [won, lost] = a.status === 200 ? [a, b] : [b, a]
    expect(typeof won.body.data.token).toBe('string')
    expect(lost.body.code).toBe('ALREADY_ACCEPTED')
    expect(JSON.stringify(lost.body)).not.toMatch(/token/)
    expect((await db.query(`SELECT 1 FROM users WHERE lower(email) LIKE 'twice-%'`)).rows).toHaveLength(1)
  })

  it('a password shorter than the platform minimum (12) is refused, and nothing is created', async () => {
    const f = await seedCompany()
    const email = `short-${randomUUID().slice(0, 8)}@test.dev`
    const token = await invite(f, 'maintenance', email)
    const res = await request(buildApp()).post(`/api/invitations/${token}/accept`)
      .send({ ...NEW_ACCOUNT, password: 'elevenchars' })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('Password must be at least 12 characters.')
    expect(res.body).not.toHaveProperty('data')
    expect((await db.query(`SELECT 1 FROM users WHERE lower(email) = lower($1)`, [email])).rows).toHaveLength(0)
    expect((await db.query<{ status: string }>(`SELECT status FROM invitations WHERE token = $1`, [token])).rows[0].status).toBe('pending')
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

    // 10/13 evening: the link opened again signs nobody in.
    expect(JSON.stringify(shown.body)).not.toMatch(/"token"/)

    // A second tap on Create account (or a second tab) hears the same thing.
    const again = await request(buildApp()).post(`/api/invitations/${token}/accept`).send(NEW_ACCOUNT)
    expect(again.status).toBe(409)
    expect(again.body.code).toBe('ALREADY_ACCEPTED')
    expect(again.body.error).toMatch(/already set up/i)
    expect(again.body.error).toMatch(/sign in/i)
    expect(again.body.error).not.toMatch(/send a new/i)
    expect(again.body).not.toHaveProperty('data')
    // Nothing was mailed and nothing changed.
    expect(sentCodes).toHaveLength(0)
    expect((await db.query(`SELECT 1 FROM bookkeeper_scopes`)).rows).toHaveLength(1)
  })

  for (const role of ['onsite_manager', 'property_manager', 'maintenance'] as const) {
    it(`the same path for ${role} (the page and the route are shared)`, async () => {
      const f = await seedCompany()
      const email = `${role}-${randomUUID().slice(0, 8)}@test.dev`
      const token = await invite(f, role, email)

      const accepted = await request(buildApp()).post(`/api/invitations/${token}/accept`).send(NEW_ACCOUNT)
      expect(accepted.status).toBe(200)
      expect(accepted.body.data).toMatchObject({ role, signedIn: true })
      expect(jwt.decode(accepted.body.data.token)).toMatchObject({ role, landlordId: f.landlordId, userId: accepted.body.data.userId })
      expect(sentCodes).toHaveLength(0)

      // And the next sign-in asks for the code, as for everyone.
      const later = await signInLater(email, NEW_ACCOUNT.password)
      expect(later.status).toBe(200)
      expect(sentCodes.map(s => s.to.toLowerCase())).toEqual([email.toLowerCase()])
      expect(claimsOf(later.body.data.token)).toEqual(claimsOf(accepted.body.data.token))
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
    expect(res.body).not.toHaveProperty('data')
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
    expect(res.body).not.toHaveProperty('data')
    expect((await db.query(`SELECT 1 FROM users WHERE lower(email) LIKE 'gone-%'`)).rows).toHaveLength(0)
  })

  it('an existing account accepts from its own session and is already signed in: no code is mailed, no pending pass, no new session', async () => {
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
    // 10/13 evening: the link vouches only for an account it creates. This one
    // signed in the normal way, so the accept hands out nothing.
    expect(res.body.data).not.toHaveProperty('token')
    expect(res.body.data).not.toHaveProperty('signedIn')
    expect(sentCodes).toHaveLength(0)
  })

  it('an existing account with no session of its own: the link alone neither attaches it nor signs it in', async () => {
    const f = await seedCompany()
    const c = await db.connect()
    let userId: string
    try { userId = await seedManager(c) } finally { c.release() }
    const email = (await db.query<{ email: string }>(`SELECT email FROM users WHERE id = $1`, [userId!])).rows[0].email
    const token = await invite(f, 'property_manager', email)

    const res = await request(buildApp()).post(`/api/invitations/${token}/accept`).send(NEW_ACCOUNT)
    expect(res.status).toBe(403)
    expect(res.body).not.toHaveProperty('data')
    expect(JSON.stringify(res.body)).not.toMatch(/"token"/)
    expect((await db.query<{ status: string }>(`SELECT status FROM invitations WHERE token = $1`, [token])).rows[0].status).toBe('pending')
  })

  // 10/13 evening: if the session cannot be made, the account is still set
  // up; the page sends her to sign in (password + code), which gets her in.
  it('when the session cannot be made, the account still exists, signedIn is false, and a normal sign-in gets her in', async () => {
    const f = await seedCompany()
    const email = `nosession-${randomUUID().slice(0, 8)}@test.dev`
    const token = await invite(f, 'bookkeeper', email)
    sessionFailsOnce.armed = true

    const accepted = await request(buildApp()).post(`/api/invitations/${token}/accept`).send(NEW_ACCOUNT)
    expect(accepted.status).toBe(200)
    expect(accepted.body.data).toMatchObject({ role: 'bookkeeper', signedIn: false })
    expect(accepted.body.data).not.toHaveProperty('token')
    expect(sentCodes).toHaveLength(0)
    expect((await db.query(`SELECT status FROM invitations WHERE token = $1`, [token])).rows[0].status).toBe('accepted')

    const later = await signInLater(email, NEW_ACCOUNT.password)
    expect(later.status).toBe(200)
    expect(jwt.decode(later.body.data.token)).toMatchObject({ role: 'bookkeeper', landlordId: f.landlordId })
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
    expect(accepted.body.data).toMatchObject({ role: 'bookkeeper', signedIn: true })
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

// 10/13 review: the link's session is minted by one helper, and only the
// accept of a NEW team account calls it. What keeps it from ever minting any
// other kind of session if a later caller misuses it is its own role check.
describe("10/13 review: the invite link's session is for a team account only", () => {
  const noSignInRecorded = async (userId: string) => {
    expect((await db.query<{ last_login_at: Date | null }>(`SELECT last_login_at FROM users WHERE id = $1`, [userId])).rows[0].last_login_at).toBeNull()
    expect((await db.query(`SELECT 1 FROM product_events WHERE user_id = $1 AND event = 'login'`, [userId])).rows).toHaveLength(0)
  }

  it('a landlord or a tenant account is refused (403): no session, nothing recorded as a sign-in', async () => {
    const c = await db.connect()
    let landlordUserId: string
    let tenantUserId: string
    try {
      landlordUserId = (await seedLandlord(c)).userId
      const tenantId = await seedTenant(c)
      tenantUserId = (await c.query<{ user_id: string }>(`SELECT user_id FROM tenants WHERE id = $1`, [tenantId])).rows[0].user_id
    } finally { c.release() }
    for (const userId of [landlordUserId!, tenantUserId!]) {
      await expect(sessionFromTeamInvitation(userId)).rejects.toMatchObject({
        statusCode: 403, message: 'Only a team account set up from its invitation signs in this way.',
      })
      await noSignInRecorded(userId)
    }
  })

  it('a team-role account with no team row is refused, as /login refuses it', async () => {
    const c = await db.connect()
    let userId: string
    try { userId = await seedManager(c) } finally { c.release() }
    await expect(sessionFromTeamInvitation(userId!)).rejects.toMatchObject({ statusCode: 403 })
    await noSignInRecorded(userId!)
  })

  it('an unknown account is refused (404)', async () => {
    await expect(sessionFromTeamInvitation(randomUUID())).rejects.toMatchObject({ statusCode: 404 })
  })

  // This door now signs people in, so it is held to the sign-in rate limit, as
  // admin-invite is. The tests above build their own app; the mount is
  // index.ts's (which starts the server on import), so it is read from there.
  it('the public invitation routes sit behind the sign-in rate limit in index.ts', () => {
    const index = readFileSync(join(__dirname, '..', 'index.ts'), 'utf8')
    expect(index).toMatch(/const authLimiter = rateLimit\(/)
    const mounts = index.split('\n').filter(l => /app\.use\(\s*'\/api\/invitations'/.test(l))
    expect(mounts).toHaveLength(1)
    expect(mounts[0]).toMatch(/app\.use\(\s*'\/api\/invitations',\s*authLimiter,\s*invitationsRouter\s*\)/)
  })
})
