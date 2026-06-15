/**
 * S456 — routes/businessUsers.ts coverage.
 *
 * Six endpoints, ~30 cases. Email send is mocked at module level (same
 * pattern as subleaseInvitations.test.ts) so invitations don't try to
 * hit Resend.
 */

import { vi, describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { randomUUID } from 'crypto'

const { emailBusinessInvitationMock } = vi.hoisted(() => ({
  emailBusinessInvitationMock: vi.fn(async () => undefined),
}))
vi.mock('../services/email', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, emailBusinessInvitation: emailBusinessInvitationMock }
})

import { db } from '../db'
import { businessUsersRouter } from './businessUsers'
import { errorHandler } from '../middleware/errorHandler'
import { cleanupAllSchema } from '../test/dbHelpers'

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/business-users', businessUsersRouter)
  app.use(errorHandler)
  return app
}

beforeEach(async () => {
  await cleanupAllSchema()
  emailBusinessInvitationMock.mockClear()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_s456'
})

async function seedOwner(): Promise<{
  userId: string; businessId: string; token: string; email: string; businessName: string
}> {
  const password = 'super-strong-password-12!'
  const hash = await bcrypt.hash(password, 12)
  const email = `owner-${randomUUID()}@example.com`
  const { rows: [u] } = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
     VALUES ($1, $2, 'business_owner', 'Biz', 'Owner', TRUE) RETURNING id`,
    [email, hash])
  const businessName = `Co-${randomUUID().slice(0, 6)}`
  const { rows: [b] } = await db.query<{ id: string }>(
    `INSERT INTO businesses (owner_user_id, name, business_type, email)
     VALUES ($1, $2, 'trash_hauling', $3) RETURNING id`,
    [u.id, businessName, email])
  const token = jwt.sign(
    { userId: u.id, role: 'business_owner', email,
      profileId: b.id, businessId: b.id },
    process.env.JWT_SECRET!, { expiresIn: '1h' })
  return { userId: u.id, businessId: b.id, token, email, businessName }
}

async function seedInvitation(opts: {
  businessId: string
  invitedByUserId: string
  email?: string
  staffRole?: 'manager' | 'dispatcher' | 'driver' | 'office'
  status?: 'sent' | 'accepted' | 'expired' | 'cancelled'
  expiresInMinutes?: number
}): Promise<{ id: string; token: string; email: string }> {
  const token = `tok_${randomUUID()}`
  const email = opts.email ?? `invitee-${randomUUID()}@example.com`
  const status = opts.status ?? 'sent'
  // When seeding an 'accepted' row, the CHECK requires
  // accepted_user_id + accepted_at to be NOT NULL (audit trail). Use
  // the inviter's user id as a placeholder — it's the only user we
  // know is around in the test scope.
  const acceptedUserId = status === 'accepted' ? opts.invitedByUserId : null
  const acceptedAtSql  = status === 'accepted' ? 'NOW()' : 'NULL'
  const { rows: [inv] } = await db.query<{ id: string }>(
    `INSERT INTO business_user_invitations
       (business_id, invited_by_user_id, token, email, staff_role,
        permissions, status, expires_at,
        accepted_user_id, accepted_at)
     VALUES ($1, $2, $3, $4, $5, '{}'::jsonb, $6,
             NOW() + ($7 || ' minutes')::interval,
             $8, ${acceptedAtSql})
     RETURNING id`,
    [opts.businessId, opts.invitedByUserId, token, email,
     opts.staffRole ?? 'dispatcher',
     status,
     String(opts.expiresInMinutes ?? 24 * 60),
     acceptedUserId])
  return { id: inv.id, token, email }
}

// ═══════════════════════════════════════════════════════════════
//  POST /invite
// ═══════════════════════════════════════════════════════════════

describe('POST /api/business-users/invite', () => {
  it('happy: 201 creates invitation row, fires email mock, returns shape', async () => {
    const o = await seedOwner()
    const inviteeEmail = `new-${randomUUID()}@example.com`
    const res = await request(buildApp())
      .post('/api/business-users/invite').set('Authorization', `Bearer ${o.token}`)
      .send({ email: inviteeEmail, staffRole: 'dispatcher' })
    expect(res.status).toBe(201)
    expect(res.body.data.email).toBe(inviteeEmail)
    expect(res.body.data.staffRole).toBe('dispatcher')
    expect(res.body.data.id).toEqual(expect.any(String))

    const { rows: [inv] } = await db.query<any>(
      `SELECT business_id, status FROM business_user_invitations WHERE id=$1`,
      [res.body.data.id])
    expect(inv.business_id).toBe(o.businessId)
    expect(inv.status).toBe('sent')

    expect(emailBusinessInvitationMock).toHaveBeenCalledTimes(1)
    const [to, , bizName, staffRole, acceptUrl, ctx] =
      emailBusinessInvitationMock.mock.calls[0] as any[]
    expect(to).toBe(inviteeEmail)
    expect(bizName).toBe(o.businessName)
    expect(staffRole).toBe('dispatcher')
    expect(acceptUrl).toMatch(/^http.+token=/)
    expect(ctx.businessId).toBe(o.businessId)
  })

  it('non-owner role → 403', async () => {
    const { rows: [u] } = await db.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name)
       VALUES ($1, 'x', 'tenant', 'T', 'T') RETURNING id`,
      [`t-${randomUUID()}@test.dev`])
    const token = jwt.sign(
      { userId: u.id, role: 'tenant', email: 't@t.dev', profileId: u.id },
      process.env.JWT_SECRET!, { expiresIn: '1h' })
    const res = await request(buildApp())
      .post('/api/business-users/invite').set('Authorization', `Bearer ${token}`)
      .send({ email: 'x@y.com', staffRole: 'dispatcher' })
    expect(res.status).toBe(403)
  })

  it('owner with no active business → 404', async () => {
    const { rows: [u] } = await db.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name)
       VALUES ($1, 'x', 'business_owner', 'No', 'Biz') RETURNING id`,
      [`nob-${randomUUID()}@test.dev`])
    const token = jwt.sign(
      { userId: u.id, role: 'business_owner', email: 'n@n.dev', profileId: u.id },
      process.env.JWT_SECRET!, { expiresIn: '1h' })
    const res = await request(buildApp())
      .post('/api/business-users/invite').set('Authorization', `Bearer ${token}`)
      .send({ email: 'x@y.com', staffRole: 'dispatcher' })
    expect(res.status).toBe(404)
  })

  it('invalid staffRole → 400', async () => {
    const o = await seedOwner()
    const res = await request(buildApp())
      .post('/api/business-users/invite').set('Authorization', `Bearer ${o.token}`)
      .send({ email: 'x@y.com', staffRole: 'mechanic' })
    expect(res.status).toBe(400)
  })

  it('disposable email → 400', async () => {
    const o = await seedOwner()
    const res = await request(buildApp())
      .post('/api/business-users/invite').set('Authorization', `Bearer ${o.token}`)
      .send({ email: 'x@mailinator.com', staffRole: 'driver' })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/Disposable/i)
  })

  it('duplicate open invitation for same email → 409', async () => {
    const o = await seedOwner()
    const email = `dup-${randomUUID()}@example.com`
    await request(buildApp())
      .post('/api/business-users/invite').set('Authorization', `Bearer ${o.token}`)
      .send({ email, staffRole: 'driver' })
    const dup = await request(buildApp())
      .post('/api/business-users/invite').set('Authorization', `Bearer ${o.token}`)
      .send({ email, staffRole: 'manager' })
    expect(dup.status).toBe(409)
    expect(dup.body.error).toMatch(/open invitation/i)
  })

  it('email of an already-active staff member → 409 "already part of your team"', async () => {
    const o = await seedOwner()
    // Pre-seed a user + business_users row.
    const staffEmail = `staff-${randomUUID()}@example.com`
    const { rows: [su] } = await db.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name)
       VALUES ($1, 'x', 'business_staff', 'S', 'M') RETURNING id`, [staffEmail])
    await db.query(
      `INSERT INTO business_users
         (business_id, user_id, staff_role, status)
       VALUES ($1, $2, 'driver', 'active')`,
      [o.businessId, su.id])
    const res = await request(buildApp())
      .post('/api/business-users/invite').set('Authorization', `Bearer ${o.token}`)
      .send({ email: staffEmail, staffRole: 'manager' })
    expect(res.status).toBe(409)
    expect(res.body.error).toMatch(/already part of your team/i)
  })

  it('email-send failure does NOT fail the invite (logged, fire-and-forget)', async () => {
    const o = await seedOwner()
    emailBusinessInvitationMock.mockRejectedValueOnce(new Error('SMTP down'))
    const res = await request(buildApp())
      .post('/api/business-users/invite').set('Authorization', `Bearer ${o.token}`)
      .send({ email: 'x@example.com', staffRole: 'office' })
    expect(res.status).toBe(201)
    // Row still persisted.
    const { rows } = await db.query<any>(
      `SELECT id FROM business_user_invitations WHERE id=$1`, [res.body.data.id])
    expect(rows).toHaveLength(1)
  })

  it('no auth → 401', async () => {
    const res = await request(buildApp())
      .post('/api/business-users/invite')
      .send({ email: 'x@y.com', staffRole: 'driver' })
    expect(res.status).toBe(401)
  })
})

// ═══════════════════════════════════════════════════════════════
//  GET /invitations/:token  (public preview)
// ═══════════════════════════════════════════════════════════════

describe('GET /api/business-users/invitations/:token', () => {
  it('happy: returns business_name + inviter_name + email + staff_role', async () => {
    const o = await seedOwner()
    const inv = await seedInvitation({
      businessId: o.businessId, invitedByUserId: o.userId,
      staffRole: 'manager',
    })
    const res = await request(buildApp())
      .get(`/api/business-users/invitations/${inv.token}`)
    expect(res.status).toBe(200)
    expect(res.body.data.business_name).toBe(o.businessName)
    expect(res.body.data.inviter_name).toBe('Biz Owner')
    expect(res.body.data.email).toBe(inv.email)
    expect(res.body.data.staff_role).toBe('manager')
  })

  it('unknown token → 404', async () => {
    const res = await request(buildApp())
      .get('/api/business-users/invitations/nope_token')
    expect(res.status).toBe(404)
  })

  it('accepted invitation → 409', async () => {
    const o = await seedOwner()
    const inv = await seedInvitation({
      businessId: o.businessId, invitedByUserId: o.userId, status: 'accepted',
    })
    const res = await request(buildApp())
      .get(`/api/business-users/invitations/${inv.token}`)
    expect(res.status).toBe(409)
  })

  it('expired invitation (expires_at past) → 410', async () => {
    const o = await seedOwner()
    const inv = await seedInvitation({
      businessId: o.businessId, invitedByUserId: o.userId,
      expiresInMinutes: -10,
    })
    const res = await request(buildApp())
      .get(`/api/business-users/invitations/${inv.token}`)
    expect(res.status).toBe(410)
  })
})

// ═══════════════════════════════════════════════════════════════
//  POST /invitations/:token/accept  (public — sign up)
// ═══════════════════════════════════════════════════════════════

describe('POST /api/business-users/invitations/:token/accept', () => {
  const acceptBody = (over: Record<string, any> = {}) => ({
    firstName: 'Inv',
    lastName:  'Itee',
    password:  'super-strong-password-12!',
    ...over,
  })

  it('happy: 201 + JWT, creates user + scope row, marks invitation accepted', async () => {
    const o = await seedOwner()
    const inv = await seedInvitation({
      businessId: o.businessId, invitedByUserId: o.userId, staffRole: 'driver',
    })
    const res = await request(buildApp())
      .post(`/api/business-users/invitations/${inv.token}/accept`)
      .send(acceptBody())
    expect(res.status).toBe(201)
    expect(res.body.data.user.role).toBe('business_staff')
    expect(res.body.data.user.businessId).toBe(o.businessId)
    expect(res.body.data.user.staffRole).toBe('driver')

    const decoded = jwt.decode(res.body.data.token) as any
    expect(decoded.role).toBe('business_staff')
    expect(decoded.businessId).toBe(o.businessId)
    expect(decoded.staffRole).toBe('driver')

    // Side effects: users + business_users + invitation flipped.
    const { rows: [u] } = await db.query<any>(
      `SELECT role, email_verified FROM users WHERE id=$1`,
      [res.body.data.user.id])
    expect(u.role).toBe('business_staff')
    expect(u.email_verified).toBe(true)

    const { rows: [bu] } = await db.query<any>(
      `SELECT staff_role, status, accepted_at FROM business_users
        WHERE user_id=$1 AND business_id=$2`,
      [res.body.data.user.id, o.businessId])
    expect(bu.staff_role).toBe('driver')
    expect(bu.status).toBe('active')
    expect(bu.accepted_at).not.toBeNull()

    const { rows: [i] } = await db.query<any>(
      `SELECT status, accepted_user_id FROM business_user_invitations WHERE id=$1`,
      [inv.id])
    expect(i.status).toBe('accepted')
    expect(i.accepted_user_id).toBe(res.body.data.user.id)
  })

  it('missing firstName → 400', async () => {
    const o = await seedOwner()
    const inv = await seedInvitation({
      businessId: o.businessId, invitedByUserId: o.userId,
    })
    const res = await request(buildApp())
      .post(`/api/business-users/invitations/${inv.token}/accept`)
      .send(acceptBody({ firstName: undefined }))
    expect(res.status).toBe(400)
  })

  it('password under 12 chars → 400', async () => {
    const o = await seedOwner()
    const inv = await seedInvitation({
      businessId: o.businessId, invitedByUserId: o.userId,
    })
    const res = await request(buildApp())
      .post(`/api/business-users/invitations/${inv.token}/accept`)
      .send(acceptBody({ password: 'short-pw1' }))
    expect(res.status).toBe(400)
  })

  it('unknown token → 404', async () => {
    const res = await request(buildApp())
      .post('/api/business-users/invitations/nope/accept')
      .send(acceptBody())
    expect(res.status).toBe(404)
  })

  it('accepted invitation → 409 (no double-accept)', async () => {
    const o = await seedOwner()
    const inv = await seedInvitation({
      businessId: o.businessId, invitedByUserId: o.userId, status: 'accepted',
    })
    const res = await request(buildApp())
      .post(`/api/business-users/invitations/${inv.token}/accept`)
      .send(acceptBody())
    expect(res.status).toBe(409)
  })

  it('expired invitation → 410', async () => {
    const o = await seedOwner()
    const inv = await seedInvitation({
      businessId: o.businessId, invitedByUserId: o.userId, expiresInMinutes: -5,
    })
    const res = await request(buildApp())
      .post(`/api/business-users/invitations/${inv.token}/accept`)
      .send(acceptBody())
    expect(res.status).toBe(410)
  })

  it('email collision: account already exists → 409 with "ask owner" hint', async () => {
    const o = await seedOwner()
    const inv = await seedInvitation({
      businessId: o.businessId, invitedByUserId: o.userId,
    })
    await db.query(
      `INSERT INTO users (email, password_hash, role, first_name, last_name)
       VALUES ($1, 'x', 'tenant', 'Already', 'Here')`, [inv.email])
    const res = await request(buildApp())
      .post(`/api/business-users/invitations/${inv.token}/accept`)
      .send(acceptBody())
    expect(res.status).toBe(409)
    expect(res.body.error).toMatch(/already exists/i)
    expect(res.body.error).toMatch(/staff list/i)
  })
})

// ═══════════════════════════════════════════════════════════════
//  GET /  (owner list)
// ═══════════════════════════════════════════════════════════════

describe('GET /api/business-users', () => {
  it('returns scoped staff + pending invitations', async () => {
    const o = await seedOwner()
    // Active staff
    const { rows: [su] } = await db.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name)
       VALUES ($1, 'x', 'business_staff', 'S', 'A') RETURNING id`,
      [`a-${randomUUID()}@test.dev`])
    await db.query(
      `INSERT INTO business_users
         (business_id, user_id, staff_role, status)
       VALUES ($1, $2, 'manager', 'active')`,
      [o.businessId, su.id])
    // Pending invite
    await seedInvitation({
      businessId: o.businessId, invitedByUserId: o.userId, staffRole: 'driver',
    })

    const res = await request(buildApp())
      .get('/api/business-users').set('Authorization', `Bearer ${o.token}`)
    expect(res.status).toBe(200)
    expect(res.body.data.staff).toHaveLength(1)
    expect(res.body.data.staff[0].staff_role).toBe('manager')
    expect(res.body.data.staff[0].first_name).toBe('S')
    expect(res.body.data.pendingInvites).toHaveLength(1)
    expect(res.body.data.pendingInvites[0].staff_role).toBe('driver')
  })

  it('does NOT include another business\'s staff (cross-business isolation)', async () => {
    const a = await seedOwner()
    const b = await seedOwner()
    // Staff in business B only
    const { rows: [su] } = await db.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name)
       VALUES ($1, 'x', 'business_staff', 'B', 'Only') RETURNING id`,
      [`b-${randomUUID()}@test.dev`])
    await db.query(
      `INSERT INTO business_users
         (business_id, user_id, staff_role, status)
       VALUES ($1, $2, 'driver', 'active')`,
      [b.businessId, su.id])

    const res = await request(buildApp())
      .get('/api/business-users').set('Authorization', `Bearer ${a.token}`)
    expect(res.body.data.staff).toHaveLength(0)
  })

  it('expired invitations are excluded from pendingInvites', async () => {
    const o = await seedOwner()
    await seedInvitation({
      businessId: o.businessId, invitedByUserId: o.userId,
      expiresInMinutes: -1,
    })
    const res = await request(buildApp())
      .get('/api/business-users').set('Authorization', `Bearer ${o.token}`)
    expect(res.body.data.pendingInvites).toHaveLength(0)
  })

  it('non-owner → 403', async () => {
    const { rows: [u] } = await db.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name)
       VALUES ($1, 'x', 'tenant', 'T', 'T') RETURNING id`,
      [`t-${randomUUID()}@test.dev`])
    const token = jwt.sign(
      { userId: u.id, role: 'tenant', email: 't@t.dev', profileId: u.id },
      process.env.JWT_SECRET!, { expiresIn: '1h' })
    const res = await request(buildApp())
      .get('/api/business-users').set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(403)
  })
})

// ═══════════════════════════════════════════════════════════════
//  PATCH /:id
// ═══════════════════════════════════════════════════════════════

describe('PATCH /api/business-users/:id', () => {
  async function seedActiveStaff(businessId: string): Promise<string> {
    const { rows: [u] } = await db.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name)
       VALUES ($1, 'x', 'business_staff', 'P', 'S') RETURNING id`,
      [`ps-${randomUUID()}@test.dev`])
    const { rows: [bu] } = await db.query<{ id: string }>(
      `INSERT INTO business_users
         (business_id, user_id, staff_role, permissions, status)
       VALUES ($1, $2, 'driver', '{}'::jsonb, 'active')
       RETURNING id`, [businessId, u.id])
    return bu.id
  }

  it('updates staff_role + permissions (S502 shape: array of catalog keys)', async () => {
    const o = await seedOwner()
    const buId = await seedActiveStaff(o.businessId)
    const res = await request(buildApp())
      .patch(`/api/business-users/${buId}`).set('Authorization', `Bearer ${o.token}`)
      .send({ staffRole: 'manager', permissions: ['routes.read', 'routes.write'] })
    expect(res.status).toBe(200)
    expect(res.body.data.staff_role).toBe('manager')
    expect(res.body.data.permissions).toEqual(['routes.read', 'routes.write'])
  })

  it('empty patch → 400', async () => {
    const o = await seedOwner()
    const buId = await seedActiveStaff(o.businessId)
    const res = await request(buildApp())
      .patch(`/api/business-users/${buId}`).set('Authorization', `Bearer ${o.token}`)
      .send({})
    expect(res.status).toBe(400)
  })

  it('unknown key → 400 (strict schema)', async () => {
    const o = await seedOwner()
    const buId = await seedActiveStaff(o.businessId)
    const res = await request(buildApp())
      .patch(`/api/business-users/${buId}`).set('Authorization', `Bearer ${o.token}`)
      .send({ status: 'revoked' })
    expect(res.status).toBe(400)
  })

  it('cross-business: other owner\'s staff → 404', async () => {
    const a = await seedOwner()
    const b = await seedOwner()
    const buInB = await seedActiveStaff(b.businessId)
    const res = await request(buildApp())
      .patch(`/api/business-users/${buInB}`).set('Authorization', `Bearer ${a.token}`)
      .send({ staffRole: 'manager' })
    expect(res.status).toBe(404)
  })
})

// ═══════════════════════════════════════════════════════════════
//  POST /:id/revoke
// ═══════════════════════════════════════════════════════════════

describe('POST /api/business-users/:id/revoke', () => {
  async function seedActiveStaff(businessId: string): Promise<string> {
    const { rows: [u] } = await db.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name)
       VALUES ($1, 'x', 'business_staff', 'R', 'V') RETURNING id`,
      [`rv-${randomUUID()}@test.dev`])
    const { rows: [bu] } = await db.query<{ id: string }>(
      `INSERT INTO business_users
         (business_id, user_id, staff_role, status)
       VALUES ($1, $2, 'driver', 'active')
       RETURNING id`, [businessId, u.id])
    return bu.id
  }

  it('happy: flips status to revoked + stamps revoked_at', async () => {
    const o = await seedOwner()
    const buId = await seedActiveStaff(o.businessId)
    const res = await request(buildApp())
      .post(`/api/business-users/${buId}/revoke`).set('Authorization', `Bearer ${o.token}`)
    expect(res.status).toBe(200)
    expect(res.body.data.status).toBe('revoked')
    const { rows: [bu] } = await db.query<any>(
      `SELECT revoked_at FROM business_users WHERE id=$1`, [buId])
    expect(bu.revoked_at).not.toBeNull()
  })

  it('already revoked → 404 (no leak of "already revoked")', async () => {
    const o = await seedOwner()
    const buId = await seedActiveStaff(o.businessId)
    await request(buildApp())
      .post(`/api/business-users/${buId}/revoke`).set('Authorization', `Bearer ${o.token}`)
    const res = await request(buildApp())
      .post(`/api/business-users/${buId}/revoke`).set('Authorization', `Bearer ${o.token}`)
    expect(res.status).toBe(404)
  })

  it('cross-business: other owner\'s staff → 404', async () => {
    const a = await seedOwner()
    const b = await seedOwner()
    const buInB = await seedActiveStaff(b.businessId)
    const res = await request(buildApp())
      .post(`/api/business-users/${buInB}/revoke`).set('Authorization', `Bearer ${a.token}`)
    expect(res.status).toBe(404)
  })

  it('revoked staff cannot log in afterwards (integration: scope query filters status=active)', async () => {
    // Combined with S454 — revoking removes login access on next attempt.
    // Here we just verify the row state; the auth-gate behavior is pinned
    // in authBusiness.test.ts ("status='revoked' scope row → 403").
    const o = await seedOwner()
    const buId = await seedActiveStaff(o.businessId)
    await request(buildApp())
      .post(`/api/business-users/${buId}/revoke`).set('Authorization', `Bearer ${o.token}`)
    const { rows: [bu] } = await db.query<any>(
      `SELECT status FROM business_users WHERE id=$1`, [buId])
    expect(bu.status).toBe('revoked')
  })
})
