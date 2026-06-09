/**
 * scopes route slice — S349.
 *
 * Pins team-permissions admin routes: invite / accept / revoke / resend
 * + scope row CRUD across the 4 worker roles (property_manager,
 * onsite_manager, maintenance, bookkeeper). Security-critical surface;
 * the S236 self-edit guards are the highest-value cases here.
 *
 * Coverage focus:
 *   - S236 self-edit guards: PM with team.manage_permissions cannot
 *     PATCH own permissions, own scope, or own direct-deposit toggle.
 *   - Cross-landlord scope-row writes (PATCH / DELETE under another
 *     landlord's id) → 404.
 *   - Invite duplicate-pending guard (409) + onsite-manager platform-
 *     wide uniqueness (409 if already onsite somewhere).
 *   - Accept flow: happy path (new + existing-same-role users),
 *     expired / already-accepted / cross-role-mismatch rejections.
 *   - Revoke/resend gate to pending-only.
 *   - Bookkeeper PATCH /permissions rejection (uses accessLevel).
 *   - Invalid roleType → 400.
 *
 * Out of scope:
 *   - connect-status route (Stripe fetchAccountStatus; needs mock that
 *     wouldn't add coverage beyond auth-check that's already covered
 *     here implicitly).
 *   - GET /:roleType listing (mechanical SELECT, low yield).
 */

import { vi, describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { randomUUID } from 'crypto'
import { db } from '../db'
import { cleanupAllSchema, seedLandlord, seedManager } from '../test/dbHelpers'

const { emailInvitationMock, createNotificationMock } = vi.hoisted(() => ({
  emailInvitationMock:    vi.fn(async (..._args: any[]) => 'msg_invitation_mock'),
  createNotificationMock: vi.fn(async (..._args: any[]) => undefined),
}))
vi.mock('../services/email', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, emailInvitation: emailInvitationMock }
})
vi.mock('../services/notifications', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, createNotification: createNotificationMock }
})

import { scopesRouter, invitationsRouter } from './scopes'
import { errorHandler } from '../middleware/errorHandler'

function buildApp() {
  const app = express()
  app.use(express.json({ limit: '2mb' }))
  app.use('/api/scopes', scopesRouter)
  app.use('/api/invitations', invitationsRouter)
  app.use(errorHandler)
  return app
}

beforeEach(async () => {
  await cleanupAllSchema()
  emailInvitationMock.mockClear()
  createNotificationMock.mockClear()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_scopes'
})

interface ScopesFixture {
  landlordUserId: string
  landlordId:     string
  landlordToken:  string
}

async function seedScopesFixture(): Promise<ScopesFixture> {
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    const { userId: landlordUserId, landlordId } = await seedLandlord(client)
    await client.query('COMMIT')
    const landlordToken = jwt.sign(
      { userId: landlordUserId, role: 'landlord', email: 'll@test.dev', profileId: landlordId, permissions: {} },
      process.env.JWT_SECRET!, { expiresIn: '1h' },
    )
    return { landlordUserId, landlordId, landlordToken }
  } catch (e) { await client.query('ROLLBACK'); throw e }
  finally { client.release() }
}

// Seed a property_manager user + scope row under the landlord, return
// a JWT for them. Used to exercise the S236 self-edit guards (which
// only fire when req.user.role === 'property_manager').
async function seedManagerWithScope(
  f: ScopesFixture,
  perms: Record<string, boolean> = { 'team.manage_permissions': true },
): Promise<{ userId: string; token: string }> {
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    const userId = await seedManager(client)
    await client.query(
      `INSERT INTO property_manager_scopes
         (user_id, landlord_id, property_ids, unit_ids, all_properties, permissions)
       VALUES ($1, $2, '{}', '{}', TRUE, $3)`,
      [userId, f.landlordId, JSON.stringify(perms)])
    await client.query('COMMIT')
    const token = jwt.sign(
      { userId, role: 'property_manager', email: 'mgr@test.dev',
        profileId: userId, landlordId: f.landlordId, permissions: perms },
      process.env.JWT_SECRET!, { expiresIn: '1h' },
    )
    return { userId, token }
  } catch (e) { await client.query('ROLLBACK'); throw e }
  finally { client.release() }
}

describe('S236 self-edit guards on property_manager routes', () => {
  it('PATCH /property_manager/:userId/permissions on SELF → 403', async () => {
    const f = await seedScopesFixture()
    const { userId, token } = await seedManagerWithScope(f)
    const res = await request(buildApp())
      .patch(`/api/scopes/property_manager/${userId}/permissions`)
      .set('Authorization', `Bearer ${token}`)
      .send({ permissions: { 'team.invite': true, 'team.manage_permissions': true } })
    expect(res.status).toBe(403)
    expect(res.body.error).toMatch(/own permissions/)
    // Verify the perms row was NOT updated
    const row = await db.query<{ permissions: any }>(
      `SELECT permissions FROM property_manager_scopes WHERE user_id=$1`, [userId])
    expect(row.rows[0].permissions['team.invite']).toBeUndefined()
  })

  it('PATCH /property_manager/:userId on SELF (scope row) → 403', async () => {
    const f = await seedScopesFixture()
    const { userId, token } = await seedManagerWithScope(f)
    const res = await request(buildApp())
      .patch(`/api/scopes/property_manager/${userId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ propertyIds: [], unitIds: [], allProperties: true, maintApprovalCeilingCents: 99999999 })
    expect(res.status).toBe(403)
    expect(res.body.error).toMatch(/own scope/)
    // maint_approval_ceiling_cents stays null (seed default)
    const row = await db.query<{ maint_approval_ceiling_cents: number | null }>(
      `SELECT maint_approval_ceiling_cents FROM property_manager_scopes WHERE user_id=$1`, [userId])
    expect(row.rows[0].maint_approval_ceiling_cents).toBeNull()
  })

  it('PATCH /property_manager/:userId/direct-deposit on SELF → 403', async () => {
    const f = await seedScopesFixture()
    const { userId, token } = await seedManagerWithScope(f)
    const res = await request(buildApp())
      .patch(`/api/scopes/property_manager/${userId}/direct-deposit`)
      .set('Authorization', `Bearer ${token}`)
      .send({ enabled: true })
    expect(res.status).toBe(403)
    expect(res.body.error).toMatch(/own direct-deposit/)
    expect(createNotificationMock).not.toHaveBeenCalled()
    const row = await db.query<{ direct_deposit_enabled: boolean }>(
      `SELECT direct_deposit_enabled FROM property_manager_scopes WHERE user_id=$1`, [userId])
    expect(row.rows[0].direct_deposit_enabled).toBe(false)
  })

  it('landlord can PATCH any manager\'s direct-deposit, fires notification on false→true', async () => {
    const f = await seedScopesFixture()
    const { userId } = await seedManagerWithScope(f)
    const res = await request(buildApp())
      .patch(`/api/scopes/property_manager/${userId}/direct-deposit`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ enabled: true })
    expect(res.status).toBe(200)
    expect(res.body.data.direct_deposit_enabled).toBe(true)
    expect(createNotificationMock).toHaveBeenCalledTimes(1)
    expect(createNotificationMock.mock.calls[0]![0]).toMatchObject({
      userId, type: 'manager_direct_deposit_enabled',
    })
  })
})

describe('Cross-landlord guards on scope-row CRUD', () => {
  it('DELETE /:roleType/:userId on another landlord\'s scope → 404, row untouched', async () => {
    const a = await seedScopesFixture()
    const b = await seedScopesFixture()
    const bMgr = await seedManagerWithScope(b)  // b's manager

    const res = await request(buildApp())
      .delete(`/api/scopes/property_manager/${bMgr.userId}`)
      .set('Authorization', `Bearer ${a.landlordToken}`)  // a's token attacks b's manager
    expect(res.status).toBe(404)

    const row = await db.query<{ id: string }>(
      `SELECT id FROM property_manager_scopes WHERE user_id=$1`, [bMgr.userId])
    expect(row.rows.length).toBe(1)  // still there
  })

  it('PATCH /:roleType/:userId/permissions cross-landlord → 404', async () => {
    const a = await seedScopesFixture()
    const b = await seedScopesFixture()
    const bMgr = await seedManagerWithScope(b)

    const res = await request(buildApp())
      .patch(`/api/scopes/property_manager/${bMgr.userId}/permissions`)
      .set('Authorization', `Bearer ${a.landlordToken}`)
      .send({ permissions: { 'team.manage_permissions': true } })
    expect(res.status).toBe(404)
  })
})

describe('POST /:roleType/invite', () => {
  it('happy path: creates invitation row + platform_events row + emails', async () => {
    const f = await seedScopesFixture()
    const res = await request(buildApp())
      .post('/api/scopes/maintenance/invite')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({
        email: `worker-${randomUUID()}@test.dev`,
        scope: { propertyIds: [], unitIds: [], jobCategories: ['plumbing'], allProperties: false },
      })
    expect(res.status).toBe(201)
    expect(res.body.data.role).toBe('maintenance')
    expect(res.body.data.status).toBe('pending')
    expect(res.body.data.token).toMatch(/^[0-9a-f]{64}$/)  // 32 bytes hex

    const ev = await db.query<{ event_type: string }>(
      `SELECT event_type FROM platform_events WHERE subject_id=$1`, [res.body.data.id])
    expect(ev.rows.length).toBe(1)
    expect(ev.rows[0].event_type).toBe('invitation.created')
    expect(emailInvitationMock).toHaveBeenCalledTimes(1)
  })

  it('invalid roleType → 400', async () => {
    const f = await seedScopesFixture()
    const res = await request(buildApp())
      .post('/api/scopes/grand_wizard/invite')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ email: 'x@test.dev', scope: {} })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/Invalid roleType/)
  })

  it('duplicate pending invite (same landlord+role+email) → 409', async () => {
    const f = await seedScopesFixture()
    const email = `dup-${randomUUID()}@test.dev`
    const r1 = await request(buildApp())
      .post('/api/scopes/maintenance/invite')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ email, scope: { propertyIds: [], unitIds: [], jobCategories: [], allProperties: true } })
    expect(r1.status).toBe(201)

    const r2 = await request(buildApp())
      .post('/api/scopes/maintenance/invite')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ email, scope: { propertyIds: [], unitIds: [], jobCategories: [], allProperties: true } })
    expect(r2.status).toBe(409)
    expect(r2.body.error).toMatch(/pending invitation already exists/)
  })

  it('onsite_manager invite when target user is already onsite for another landlord → 409', async () => {
    const a = await seedScopesFixture()
    const b = await seedScopesFixture()
    // Seed a user + onsite scope under landlord a.
    const client = await db.connect()
    let omUserId = ''
    try {
      await client.query('BEGIN')
      omUserId = await seedManager(client)
      await client.query(
        `UPDATE users SET role='onsite_manager', email=$1 WHERE id=$2`,
        ['onsite@test.dev', omUserId])
      await client.query(
        `INSERT INTO onsite_manager_scopes (user_id, landlord_id, property_ids, unit_ids, all_properties)
         VALUES ($1, $2, '{}', '{}', TRUE)`,
        [omUserId, a.landlordId])
      await client.query('COMMIT')
    } catch (e) { await client.query('ROLLBACK'); throw e } finally { client.release() }

    // Landlord b tries to invite the same email as onsite_manager → 409
    const res = await request(buildApp())
      .post('/api/scopes/onsite_manager/invite')
      .set('Authorization', `Bearer ${b.landlordToken}`)
      .send({ email: 'onsite@test.dev', scope: { propertyIds: [], unitIds: [], allProperties: true } })
    expect(res.status).toBe(409)
    expect(res.body.error).toMatch(/already an on-site manager for another landlord/)
  })
})

describe('PATCH /:roleType/:userId/permissions — bookkeeper rejection', () => {
  it('bookkeeper rejected → 400 (uses accessLevel, not permissions toggles)', async () => {
    const f = await seedScopesFixture()
    const res = await request(buildApp())
      .patch(`/api/scopes/bookkeeper/${randomUUID()}/permissions`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ permissions: { 'books.edit': true } })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/accessLevel/)
  })
})

describe('POST /invitations/:token/accept', () => {
  async function createPendingInvite(
    f: ScopesFixture,
    role: 'property_manager' | 'onsite_manager' | 'maintenance' | 'bookkeeper',
    email: string,
    scope: any,
  ): Promise<string> {
    const res = await request(buildApp())
      .post(`/api/scopes/${role}/invite`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ email, scope })
    if (res.status !== 201) throw new Error(`invite failed: ${JSON.stringify(res.body)}`)
    return res.body.data.token
  }

  it('happy path: new account, creates user + scope row + flips invitation to accepted', async () => {
    const f = await seedScopesFixture()
    const email = `new-${randomUUID()}@test.dev`
    const token = await createPendingInvite(f, 'maintenance', email, {
      propertyIds: [], unitIds: [], jobCategories: ['general'], allProperties: true,
    })

    const res = await request(buildApp())
      .post(`/api/invitations/${token}/accept`)
      .send({ password: 'super_secure_12', firstName: 'New', lastName: 'Worker' })
    expect(res.status).toBe(200)
    expect(res.body.data.role).toBe('maintenance')

    const u = await db.query<{ role: string }>(
      `SELECT role FROM users WHERE lower(email)=lower($1)`, [email])
    expect(u.rows[0].role).toBe('maintenance')
    const s = await db.query(`SELECT * FROM maintenance_worker_scopes WHERE user_id=$1`,
      [res.body.data.userId])
    expect(s.rows.length).toBe(1)
    const inv = await db.query<{ status: string }>(
      `SELECT status FROM invitations WHERE token=$1`, [token])
    expect(inv.rows[0].status).toBe('accepted')
  })

  it('expired invitation → 400 (no user / scope created)', async () => {
    const f = await seedScopesFixture()
    const email = `expired-${randomUUID()}@test.dev`
    const token = await createPendingInvite(f, 'maintenance', email, {
      propertyIds: [], unitIds: [], jobCategories: [], allProperties: true,
    })
    // Force-expire
    await db.query(
      `UPDATE invitations SET expires_at = NOW() - INTERVAL '1 hour' WHERE token = $1`,
      [token])

    const res = await request(buildApp())
      .post(`/api/invitations/${token}/accept`)
      .send({ password: 'super_secure_12', firstName: 'Late', lastName: 'Joiner' })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/expired/)
    const u = await db.query(`SELECT id FROM users WHERE lower(email)=lower($1)`, [email])
    expect(u.rows.length).toBe(0)
  })

  it('S349 F1: onsite_manager accept-path enforces platform-wide one-landlord rule', async () => {
    // Spec (per scopes.ts:377-384 comment): "Onsite manager uniqueness: one
    // landlord per user, platform-wide." Invite-time check enforces this,
    // but pre-S349 the accept path only checked (user_id, landlord_id) —
    // two landlords could each invite the same email, both invites created
    // (race), and both accepted in sequence to produce two scope rows.
    // This test pins the post-S349 fix: second accept → 409.
    const a = await seedScopesFixture()
    const b = await seedScopesFixture()
    const email = `onsite-race-${randomUUID()}@test.dev`

    // Step 1: directly insert two pending invites (bypass the invite-time
    // dup check, which only catches landlord-A → landlord-A dupes). This
    // simulates the race: both invites created before either accepted.
    const t1 = 'a'.repeat(64), t2 = 'b'.repeat(64)
    await db.query(
      `INSERT INTO invitations (email, landlord_id, role, scope_payload, invited_by_user_id, token, expires_at)
       VALUES ($1, $2, 'onsite_manager', $3::jsonb, $4, $5, NOW() + INTERVAL '1 day'),
              ($1, $6, 'onsite_manager', $3::jsonb, $7, $8, NOW() + INTERVAL '1 day')`,
      [email, a.landlordId,
       JSON.stringify({ propertyIds: [], unitIds: [], allProperties: true }),
       a.landlordUserId, t1,
       b.landlordId, b.landlordUserId, t2])

    // Step 2: accept a's invite → succeeds, scope row created under a
    const r1 = await request(buildApp())
      .post(`/api/invitations/${t1}/accept`)
      .send({ password: 'super_secure_12', firstName: 'Race', lastName: 'Worker' })
    expect(r1.status).toBe(200)
    const userId = r1.body.data.userId

    // Step 3: accept b's invite → MUST 409 (post-fix); pre-fix this succeeded
    // and created a second onsite_manager_scopes row under b.
    const r2 = await request(buildApp())
      .post(`/api/invitations/${t2}/accept`)
      .send({})
    expect(r2.status).toBe(409)
    expect(r2.body.error).toMatch(/already an on-site manager/)

    // Scope rows: exactly one (under landlord a only)
    const scopes = await db.query<{ landlord_id: string }>(
      `SELECT landlord_id FROM onsite_manager_scopes WHERE user_id=$1`, [userId])
    expect(scopes.rows.length).toBe(1)
    expect(scopes.rows[0].landlord_id).toBe(a.landlordId)
  })

  it('cross-role mismatch: existing user has different role → 409', async () => {
    const f = await seedScopesFixture()
    // Seed an existing landlord-role user with email X.
    const client = await db.connect()
    let existingEmail = `existing-${randomUUID()}@test.dev`
    try {
      await client.query('BEGIN')
      await client.query(
        `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
         VALUES ($1, 'x', 'landlord', 'Already', 'Landlord', TRUE)`,
        [existingEmail])
      await client.query('COMMIT')
    } catch (e) { await client.query('ROLLBACK'); throw e } finally { client.release() }

    const token = await createPendingInvite(f, 'maintenance', existingEmail, {
      propertyIds: [], unitIds: [], jobCategories: [], allProperties: true,
    })
    const res = await request(buildApp())
      .post(`/api/invitations/${token}/accept`)
      .send({})
    expect(res.status).toBe(409)
    expect(res.body.error).toMatch(/already registered as landlord/)
    // No scope row created
    const s = await db.query(`SELECT * FROM maintenance_worker_scopes`)
    expect(s.rows.length).toBe(0)
  })
})

describe('POST /invitations/:id/revoke + /resend', () => {
  it('revoke pending → status=revoked + platform_events row', async () => {
    const f = await seedScopesFixture()
    const created = await request(buildApp())
      .post('/api/scopes/maintenance/invite')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ email: `rev-${randomUUID()}@test.dev`,
              scope: { propertyIds: [], unitIds: [], jobCategories: [], allProperties: true } })
    const invId = created.body.data.id

    const res = await request(buildApp())
      .post(`/api/scopes/invitations/${invId}/revoke`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({})
    expect(res.status).toBe(200)
    expect(res.body.data.status).toBe('revoked')
    expect(res.body.data.revoked_at).not.toBeNull()

    const ev = await db.query<{ event_type: string }>(
      `SELECT event_type FROM platform_events WHERE subject_id=$1 ORDER BY created_at DESC LIMIT 1`,
      [invId])
    expect(ev.rows[0].event_type).toBe('invitation.revoked')
  })

  it('cannot resend a non-pending invitation → 400', async () => {
    const f = await seedScopesFixture()
    const created = await request(buildApp())
      .post('/api/scopes/maintenance/invite')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ email: `nr-${randomUUID()}@test.dev`,
              scope: { propertyIds: [], unitIds: [], jobCategories: [], allProperties: true } })
    const invId = created.body.data.id

    // Revoke first
    await request(buildApp())
      .post(`/api/scopes/invitations/${invId}/revoke`)
      .set('Authorization', `Bearer ${f.landlordToken}`).send({})

    // Now try to resend
    const res = await request(buildApp())
      .post(`/api/scopes/invitations/${invId}/resend`)
      .set('Authorization', `Bearer ${f.landlordToken}`).send({})
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/Only pending invitations can be resent/)
  })

  it('cross-landlord revoke → 404 (invitation lookup is landlord-scoped)', async () => {
    const a = await seedScopesFixture()
    const b = await seedScopesFixture()
    const bInv = await request(buildApp())
      .post('/api/scopes/maintenance/invite')
      .set('Authorization', `Bearer ${b.landlordToken}`)
      .send({ email: `cx-${randomUUID()}@test.dev`,
              scope: { propertyIds: [], unitIds: [], jobCategories: [], allProperties: true } })
    const bInvId = bInv.body.data.id

    const res = await request(buildApp())
      .post(`/api/scopes/invitations/${bInvId}/revoke`)
      .set('Authorization', `Bearer ${a.landlordToken}`)  // a attacks b's invite
      .send({})
    expect(res.status).toBe(404)

    // b's invite still pending
    const row = await db.query<{ status: string }>(
      `SELECT status FROM invitations WHERE id = $1`, [bInvId])
    expect(row.rows[0].status).toBe('pending')
  })
})
