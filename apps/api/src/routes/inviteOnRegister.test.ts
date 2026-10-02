/**
 * S637 — registering with an invited email ends with the invitation accepted.
 * S655 — but only once the address is PROVEN, never at the signup form.
 *
 * Nic (S637): "you need to fix it so that his registered new account is the
 * invite accepted. They need to be merged into one. He doesn't have a separate
 * account for anything." Dusty Rhoades was invited as a co-owner of Mountain
 * View, then REGISTERED instead of opening the invite link.
 *
 * S655 security: registration used to accept the invitation inside the same
 * transaction that created the account — before anything proved the person
 * owns the address. Anyone who knew an invited address could register it
 * first and the database recorded THEIR password as an owner of the company,
 * while the real partner's link said "already used". The claim now happens
 * at the step that proves the address: the emailed code (or a reset or
 * verification link from that inbox). For a real invitee that is seconds
 * later on the same screen.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import bcrypt from 'bcryptjs'
import { randomUUID } from 'crypto'
import { db } from '../db'
import { cleanupAllSchema, seedLandlord } from '../test/dbHelpers'

// The emailed code, captured instead of sent.
const { sentCodes } = vi.hoisted(() => ({ sentCodes: [] as Array<{ to: string; code: string }> }))
vi.mock('../services/email', async (orig) => ({
  ...(await orig() as any),
  emailLoginCode: vi.fn(async (to: string, code: string) => { sentCodes.push({ to, code }); return 'msg' }),
  sendEmailVerification: vi.fn(async () => 'msg'),
  sendPasswordResetEmail: vi.fn(async () => 'msg'),
  sendLandlordSignupHeadsUp: vi.fn(async () => 'msg'),
  emailLandlordWelcomeOutreach: vi.fn(async () => 'msg'),
}))

import { authRouter } from './auth'
import { emailOtpRouter } from './emailOtp'
import { landlordsRouter } from './landlords'
import { errorHandler } from '../middleware/errorHandler'
import { _clearMembershipCache, requireAuth } from '../middleware/auth'

function buildApp() {
  const app = express()
  app.use(express.json())
  // What requireAuth says this session's companies are, right now.
  app.get('/echo', requireAuth, (req, res) => res.json({ landlordIds: req.user!.landlordIds }))
  app.use('/api/auth/email-otp', emailOtpRouter)
  app.use('/api/auth', authRouter)
  app.use('/api/landlords', landlordsRouter)
  app.use(errorHandler)
  return app
}

const PASSWORD = 'Str0ng!Passw0rd'
let inviterUserId: string, entityId: string

beforeEach(async () => {
  await cleanupAllSchema()
  sentCodes.length = 0
  _clearMembershipCache()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_invitereg'
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const l = await seedLandlord(c)
    inviterUserId = l.userId
    entityId = l.landlordId
    await c.query(`UPDATE landlords SET business_name='Mountain View RV Park Ranch LLC' WHERE id=$1`, [entityId])
    await c.query('COMMIT')
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
})

const invite = async (email: string, opts: { expired?: boolean; status?: string } = {}) => {
  const token = randomUUID().replace(/-/g, '')
  await db.query(
    `INSERT INTO landlord_member_invitations
       (landlord_id, email, invited_by_user_id, status, token, expires_at)
     VALUES ($1,$2,$3,$4,$5, now() + ($6 || ' days')::interval)`,
    [entityId, email, inviterUserId, opts.status ?? 'pending', token, opts.expired ? '-1' : '7'])
  return token
}

const register = (email: string, password = PASSWORD) =>
  request(buildApp()).post('/api/auth/register').send({
    email, password, firstName: 'Dusty', lastName: 'Rhoades',
    role: 'landlord', acceptedTerms: true,
  })

/** The code most recently mailed to this address. */
const lastCodeFor = (email: string) =>
  [...sentCodes].reverse().find(c => c.to.toLowerCase() === email.toLowerCase())?.code

/** Trade a pending session for the full pass with the code that was mailed. */
const enterCode = (emailOtpSession: string, email: string) =>
  request(buildApp()).post('/api/auth/email-otp/verify').send({ emailOtpSession, code: lastCodeFor(email) })

const membershipsFor = async (email: string) => (await db.query<any>(
  `SELECT m.landlord_id, m.role FROM landlord_members m
     JOIN users u ON u.id = m.user_id WHERE LOWER(u.email) = LOWER($1)`, [email])).rows

const companiesFoundedBy = async (email: string) => (await db.query<any>(
  `SELECT l.id FROM landlords l JOIN users u ON u.id = l.user_id WHERE LOWER(u.email) = LOWER($1)`, [email])).rows

const inviteRow = async (email: string) => (await db.query<any>(
  `SELECT status, accepted_user_id FROM landlord_member_invitations WHERE LOWER(email) = LOWER($1)`, [email])).rows[0]

const userIdFor = async (email: string) => (await db.query<{ id: string }>(
  `SELECT id FROM users WHERE LOWER(email) = LOWER($1)`, [email])).rows[0].id

describe('S655 registering with a pending invitation claims nothing until the address is proven', () => {
  it('the signup form alone leaves the invitation pending, with no membership and no company', async () => {
    const email = `dusty-${randomUUID().slice(0, 8)}@mailer-test.co`
    await invite(email)
    const res = await register(email)
    expect(res.status).toBe(201)
    expect(res.body.data.requiresEmailOtp).toBe(true)

    expect(await membershipsFor(email)).toEqual([])
    expect(await companiesFoundedBy(email)).toEqual([])
    expect((await inviteRow(email)).status).toBe('pending')
    // The pending pass names no company either.
    const pending = jwt.decode(res.body.data.emailOtpSession) as any
    expect(pending.landlordIds).toEqual([])
  })

  it('entering the emailed code makes them an owner of the company they were invited to — and only that one', async () => {
    const email = `dusty-${randomUUID().slice(0, 8)}@mailer-test.co`
    await invite(email)
    const reg = await register(email)
    const done = await enterCode(reg.body.data.emailOtpSession, email)
    expect(done.status).toBe(200)

    const rows = await membershipsFor(email)
    expect(rows.map((r: any) => r.landlord_id)).toEqual([entityId])
    expect(rows[0].role).toBe('owner')
    // S637 still holds: no blank company of their own beside it.
    expect(await companiesFoundedBy(email)).toEqual([])
    // The very first full pass already carries the company.
    expect((jwt.decode(done.body.data.token) as any).landlordIds).toEqual([entityId])
  })

  it('marks the invitation accepted against that user, and makes the inviting owner their referrer', async () => {
    const email = `dusty-${randomUUID().slice(0, 8)}@mailer-test.co`
    await invite(email)
    const reg = await register(email)
    await enterCode(reg.body.data.emailOtpSession, email)
    const uid = await userIdFor(email)
    const inv = await inviteRow(email)
    expect(inv.status).toBe('accepted')
    expect(inv.accepted_user_id).toBe(uid)
    // S654: the same rule the invite link applies.
    const { rows: [u] } = await db.query<any>(`SELECT referred_by_user_id FROM users WHERE id = $1`, [uid])
    expect(u.referred_by_user_id).toBe(inviterUserId)
  })

  it('somebody who registers an invited address but never has the code never becomes an owner', async () => {
    const email = `partner-${randomUUID().slice(0, 8)}@mailer-test.co`
    const token = await invite(email)
    await register(email, 'Attacker-Chosen-Pw-1')   // not the partner — they cannot read the inbox
    expect(await membershipsFor(email)).toEqual([])
    expect((await inviteRow(email)).status).toBe('pending')
    // The real partner's link still shows the invitation, not "already used".
    const preview = await request(buildApp()).get(`/api/landlords/member-invite/${token}`)
    expect(preview.status).toBe(200)
    expect(preview.body.data.accepted).toBe(false)
  })

  it('the real owner of the address gets the invitation by resetting the password from their inbox', async () => {
    const email = `partner-${randomUUID().slice(0, 8)}@mailer-test.co`
    await invite(email)
    await register(email, 'Attacker-Chosen-Pw-1')
    const uid = await userIdFor(email)
    // The reset link only ever reaches the real inbox.
    const resetToken = randomUUID().replace(/-/g, '')
    await db.query(
      `UPDATE users SET reset_token = $1, reset_token_expires = NOW() + INTERVAL '1 hour' WHERE id = $2`,
      [resetToken, uid])
    const reset = await request(buildApp()).post('/api/auth/reset-password')
      .send({ token: resetToken, newPassword: 'Real-Partner-Pw-22' })
    expect(reset.status).toBe(200)
    expect((await membershipsFor(email)).map((r: any) => r.landlord_id)).toEqual([entityId])
    expect((await inviteRow(email)).accepted_user_id).toBe(uid)

    // And the sign-in that follows works with the new password and the code.
    const login = await request(buildApp()).post('/api/auth/login').send({ email, password: 'Real-Partner-Pw-22' })
    expect(login.body.data.requiresEmailOtp).toBe(true)
    const done = await enterCode(login.body.data.emailOtpSession, email)
    expect(done.status).toBe(200)
    expect((jwt.decode(done.body.data.token) as any).landlordIds).toEqual([entityId])
  })

  it('a verification link from the inbox proves the address too, and claims the same way', async () => {
    const email = `linked-${randomUUID().slice(0, 8)}@mailer-test.co`
    await invite(email)
    await register(email)
    const verifyToken = randomUUID().replace(/-/g, '')
    await db.query(`UPDATE users SET email_verify_token = $1 WHERE LOWER(email) = LOWER($2)`, [verifyToken, email])
    const res = await request(buildApp()).post('/api/auth/verify-email').send({ token: verifyToken })
    expect(res.status).toBe(200)
    expect((await membershipsFor(email)).map((r: any) => r.landlord_id)).toEqual([entityId])
    expect(await companiesFoundedBy(email)).toEqual([])
  })

  it('a landlord who already has a company is never attached at sign-in — they accept from the link', async () => {
    const email = `existing-${randomUUID().slice(0, 8)}@mailer-test.co`
    const { rows: [u] } = await db.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
       VALUES ($1, $2, 'landlord', 'Own', 'Company', TRUE) RETURNING id`, [email, await bcrypt.hash(PASSWORD, 10)])
    const { rows: [own] } = await db.query<{ id: string }>(`INSERT INTO landlords (user_id) VALUES ($1) RETURNING id`, [u.id])
    await invite(email)

    const login = await request(buildApp()).post('/api/auth/login').send({ email, password: PASSWORD })
    const done = await enterCode(login.body.data.emailOtpSession, email)
    expect(done.status).toBe(200)
    expect(await membershipsFor(email)).not.toContainEqual(expect.objectContaining({ landlord_id: entityId }))
    expect((await inviteRow(email)).status).toBe('pending')
    expect((jwt.decode(done.body.data.token) as any).landlordIds).toEqual([own.id])
  })

  it('an invitation revoked before the code leaves them with a company of their own, not with nothing', async () => {
    const email = `revoked-${randomUUID().slice(0, 8)}@mailer-test.co`
    await invite(email)
    const reg = await register(email)
    await db.query(`UPDATE landlord_member_invitations SET status = 'revoked', revoked_at = now() WHERE LOWER(email) = LOWER($1)`, [email])
    const done = await enterCode(reg.body.data.emailOtpSession, email)
    expect(done.status).toBe(200)
    const founded = await companiesFoundedBy(email)
    expect(founded).toHaveLength(1)
    const rows = await membershipsFor(email)
    expect(rows.map((r: any) => r.landlord_id)).toEqual([founded[0].id])
    expect((jwt.decode(done.body.data.token) as any).landlordIds).toEqual([founded[0].id])
  })

  it('matches the address case-insensitively', async () => {
    const email = `Dusty-${randomUUID().slice(0, 8)}@Mailer-Test.co`
    await invite(email.toLowerCase())
    const reg = await register(email.toUpperCase())
    await enterCode(reg.body.data.emailOtpSession, email)
    expect((await membershipsFor(email)).map((r: any) => r.landlord_id)).toContain(entityId)
  })

  it('ignores an EXPIRED invitation — the signup gets its own company as usual', async () => {
    const email = `late-${randomUUID().slice(0, 8)}@mailer-test.co`
    await invite(email, { expired: true })
    const reg = await register(email)
    await enterCode(reg.body.data.emailOtpSession, email)
    const rows = await membershipsFor(email)
    expect(rows.map((r: any) => r.landlord_id)).not.toContain(entityId)
    expect(rows).toHaveLength(1)
  })

  it('ignores an already-accepted invitation', async () => {
    const email = `done-${randomUUID().slice(0, 8)}@mailer-test.co`
    await invite(email, { status: 'accepted' })
    const reg = await register(email)
    await enterCode(reg.body.data.emailOtpSession, email)
    expect((await membershipsFor(email)).map((r: any) => r.landlord_id)).not.toContain(entityId)
  })

  it('attaches nothing to somebody who was never invited', async () => {
    const email = `stranger-${randomUUID().slice(0, 8)}@mailer-test.co`
    const reg = await register(email)
    // Their own company exists from the form, exactly as before.
    expect(await companiesFoundedBy(email)).toHaveLength(1)
    await enterCode(reg.body.data.emailOtpSession, email)
    const rows = await membershipsFor(email)
    expect(rows.map((r: any) => r.landlord_id)).not.toContain(entityId)
    expect(rows).toHaveLength(1)
  })

  it('after the code, the registration redirect to the invite says "accepted", not "already used"', async () => {
    const email = `redirect-${randomUUID().slice(0, 8)}@mailer-test.co`
    const token = await invite(email)
    const reg = await register(email)
    const done = await enterCode(reg.body.data.emailOtpSession, email)
    const preview = await request(buildApp()).get(`/api/landlords/member-invite/${token}`)
    expect(preview.status).toBe(200)
    expect(preview.body.data.accepted).toBe(true)
    const accept = await request(buildApp()).post(`/api/landlords/member-invite/${token}/accept`)
      .set('Authorization', `Bearer ${done.body.data.token}`).send({})
    expect(accept.status).toBe(200)
    expect(accept.body.data.alreadyAccepted).toBe(true)
    expect(accept.body.data.landlordId).toBe(entityId)
  })
})

// S655 review — the S654 consent rule. Registering with an invited address is
// consent to the invitations that made the person register (S637). It is not
// consent to an invitation that arrives later: a login can hold no company for
// other reasons (a co-owner removed from their only company, an older account),
// and an ordinary code sign-in must not make it an owner of somebody else's
// company — or write that company's founder in as its referrer.
describe('S655 only invitations already waiting at registration are claimed', () => {
  it('a login with no company is not attached by an invitation sent after it registered', async () => {
    const email = `nocompany-${randomUUID().slice(0, 8)}@mailer-test.co`
    const { rows: [u] } = await db.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified, created_at)
       VALUES ($1, $2, 'landlord', 'No', 'Company', TRUE, now() - interval '40 days') RETURNING id`,
      [email, await bcrypt.hash(PASSWORD, 10)])
    await invite(email)   // sent today, 40 days after the account was made

    const login = await request(buildApp()).post('/api/auth/login').send({ email, password: PASSWORD })
    const done = await enterCode(login.body.data.emailOtpSession, email)
    expect(done.status).toBe(200)

    expect((await inviteRow(email)).status).toBe('pending')
    expect(await membershipsFor(email)).toEqual([])
    expect(await companiesFoundedBy(email)).toEqual([])
    const { rows: [after] } = await db.query<any>(`SELECT referred_by_user_id FROM users WHERE id=$1`, [u.id])
    expect(after.referred_by_user_id).toBeNull()
    expect((jwt.decode(done.body.data.token) as any).landlordIds ?? []).not.toContain(entityId)
  })

  it('the same login can still accept that invitation from its link, while signed in', async () => {
    const email = `nocompany-link-${randomUUID().slice(0, 8)}@mailer-test.co`
    await db.query(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified, created_at)
       VALUES ($1, $2, 'landlord', 'No', 'Company', TRUE, now() - interval '40 days')`,
      [email, await bcrypt.hash(PASSWORD, 10)])
    const token = await invite(email)
    const login = await request(buildApp()).post('/api/auth/login').send({ email, password: PASSWORD })
    const done = await enterCode(login.body.data.emailOtpSession, email)
    const accept = await request(buildApp()).post(`/api/landlords/member-invite/${token}/accept`)
      .set('Authorization', `Bearer ${done.body.data.token}`).send({})
    expect(accept.status).toBe(200)
    expect(accept.body.data.alreadyAccepted).toBe(false)
    expect((await membershipsFor(email)).map((r: any) => r.landlord_id)).toEqual([entityId])
  })

  it('an invitation re-sent between the form and the code is still claimed (same row, same age)', async () => {
    const email = `resent-${randomUUID().slice(0, 8)}@mailer-test.co`
    await invite(email)
    const reg = await register(email)
    // A re-send refreshes the pending row in place (createCoOwnerInvitation).
    await db.query(
      `UPDATE landlord_member_invitations SET token = $2, expires_at = now() + interval '7 days', updated_at = now()
        WHERE LOWER(email) = LOWER($1)`, [email, randomUUID().replace(/-/g, '')])
    const done = await enterCode(reg.body.data.emailOtpSession, email)
    expect(done.status).toBe(200)
    expect((await membershipsFor(email)).map((r: any) => r.landlord_id)).toEqual([entityId])
  })

  it('a NEW invitation sent after registering gets no blank company beside it — it is joined from its link', async () => {
    const email = `reinvited-${randomUUID().slice(0, 8)}@mailer-test.co`
    await invite(email)
    const reg = await register(email)
    // The first invitation is revoked and a fresh one sent, after the form.
    await db.query(`UPDATE landlord_member_invitations SET status = 'revoked', revoked_at = now() WHERE LOWER(email) = LOWER($1)`, [email])
    const token = await invite(email)

    const done = await enterCode(reg.body.data.emailOtpSession, email)
    expect(done.status).toBe(200)
    expect(await companiesFoundedBy(email)).toEqual([])   // no S637 phantom
    expect(await membershipsFor(email)).toEqual([])
    const { rows: [fresh] } = await db.query<any>(
      `SELECT status FROM landlord_member_invitations WHERE token = $1`, [token])
    expect(fresh.status).toBe('pending')

    const accept = await request(buildApp()).post(`/api/landlords/member-invite/${token}/accept`)
      .set('Authorization', `Bearer ${done.body.data.token}`).send({})
    expect(accept.status).toBe(200)
    expect((await membershipsFor(email)).map((r: any) => r.landlord_id)).toEqual([entityId])
  })
})

// S655 review: a re-send refreshes the pending row IN PLACE (new token, new
// expiry, same created_at), and nothing ever moves a lapsed invitation out of
// 'pending'. So an invitation that lapsed before a login was even made came
// back to life on a re-send, still "older than the account", and that login's
// next ordinary code sign-in accepted it without the link ever being opened.
// Only the address's FIRST proof claims now.
describe('S655 only the first proof of the address claims an invitation', () => {
  it('a lapsed invitation older than the login, re-sent, stays pending at an ordinary code sign-in', async () => {
    const email = `lapsed-${randomUUID().slice(0, 8)}@mailer-test.co`
    // The company invited this address 30 days ago; it lapsed after a week.
    await db.query(
      `INSERT INTO landlord_member_invitations
         (landlord_id, email, invited_by_user_id, status, token, expires_at, created_at)
       VALUES ($1, $2, $3, 'pending', $4, now() - interval '23 days', now() - interval '30 days')`,
      [entityId, email, inviterUserId, randomUUID().replace(/-/g, '')])
    // A login made 20 days ago, its address long since proven, owning no company.
    const { rows: [u] } = await db.query<{ id: string; created_at: Date }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name,
                          email_verified, email_verified_at, created_at)
       VALUES ($1, $2, 'landlord', 'Bob', 'Nocompany', TRUE, now() - interval '20 days', now() - interval '20 days')
       RETURNING id, created_at`,
      [email, await bcrypt.hash(PASSWORD, 10)])

    // The company re-sends, through the real route.
    const ownerToken = jwt.sign(
      { userId: inviterUserId, role: 'landlord', email: 'owner@mailer-test.co', profileId: entityId, permissions: {} },
      process.env.JWT_SECRET!, { expiresIn: '1h' })
    const resend = await request(buildApp()).post('/api/landlords/members')
      .set('Authorization', `Bearer ${ownerToken}`).send({ email })
    expect(resend.status).toBe(202)
    const { rows: [inv] } = await db.query<any>(
      `SELECT status, created_at, expires_at FROM landlord_member_invitations WHERE LOWER(email) = LOWER($1)`, [email])
    expect(inv.status).toBe('pending')
    expect(new Date(inv.expires_at).getTime()).toBeGreaterThan(Date.now())                  // live again
    expect(new Date(inv.created_at).getTime()).toBeLessThan(new Date(u.created_at).getTime()) // and still "older"

    const login = await request(buildApp()).post('/api/auth/login').send({ email, password: PASSWORD })
    expect(login.body.data.requiresEmailOtp).toBe(true)
    const done = await enterCode(login.body.data.emailOtpSession, email)
    expect(done.status).toBe(200)

    expect((await inviteRow(email)).status).toBe('pending')
    expect(await membershipsFor(email)).toEqual([])
    expect(await companiesFoundedBy(email)).toEqual([])
    const { rows: [after] } = await db.query<any>(`SELECT referred_by_user_id FROM users WHERE id = $1`, [u.id])
    expect(after.referred_by_user_id).toBeNull()
    expect((jwt.decode(done.body.data.token) as any).landlordIds ?? []).not.toContain(entityId)
  })

  it('a later proof claims nothing, even an invitation that was waiting at registration — that one is accepted from its link', async () => {
    const { claimInvitationsOnProvenAddress } = await import('../services/coOwnerInvites')
    const email = `later-${randomUUID().slice(0, 8)}@mailer-test.co`
    await invite(email)
    await register(email)
    const uid = await userIdFor(email)
    expect(await claimInvitationsOnProvenAddress(uid, { firstVerification: false })).toEqual([])
    expect((await inviteRow(email)).status).toBe('pending')
    expect(await membershipsFor(email)).toEqual([])
    expect(await companiesFoundedBy(email)).toEqual([])
    // The first proof still does it.
    expect(await claimInvitationsOnProvenAddress(uid, { firstVerification: true })).toEqual([entityId])
    expect((await inviteRow(email)).accepted_user_id).toBe(uid)
  })
})

// S655 review: requireAuth keeps each account's companies for 15 seconds
// (S629). A session already open elsewhere filled that before the code was
// entered; the claim has to drop it, or that session — and the cache hit that
// ignores a newer pass's own list — still shows nothing.
describe('S655 a claimed company shows up on the next request', () => {
  it('a session already open sees the invited company right after the code claims it', async () => {
    const email = `cached-${randomUUID().slice(0, 8)}@mailer-test.co`
    await invite(email)
    const reg = await register(email)
    const userId = await userIdFor(email)
    const openElsewhere = jwt.sign({ userId, role: 'landlord', email, profileId: null, landlordIds: [], permissions: {} },
      process.env.JWT_SECRET!, { expiresIn: '1h' })
    const before = await request(buildApp()).get('/echo').set('Authorization', `Bearer ${openElsewhere}`)
    expect(before.body.landlordIds).toEqual([])

    const done = await enterCode(reg.body.data.emailOtpSession, email)
    expect(done.status).toBe(200)

    const elsewhere = await request(buildApp()).get('/echo').set('Authorization', `Bearer ${openElsewhere}`)
    expect(elsewhere.body.landlordIds).toEqual([entityId])
    const fresh = await request(buildApp()).get('/echo').set('Authorization', `Bearer ${done.body.data.token}`)
    expect(fresh.body.landlordIds).toEqual([entityId])
  })
})
