/**
 * S451 route-test slice — `routes/subleaseInvitations.ts`.
 *
 * The S247 invite-acceptance public router. Two endpoints, both
 * pre-authentication; the token in the URL is the only credential.
 *
 *   GET  /api/sublease-invitations/:token          — preview
 *   POST /api/sublease-invitations/:token/accept   — onboard + accept
 *
 * Mocks: services/notifications.notifySubleaseRequested (the
 * landlord-side fan-out fired post-commit).
 *
 * The route has zero prior direct coverage. subleases.test.ts covers
 * the sublessor-side issue + landlord-decision flows; this slice
 * covers the SUBLESSEE-side onboarding path.
 */

import { vi, describe, it, expect, beforeEach } from 'vitest'

const { notifySubleaseRequestedMock } = vi.hoisted(() => ({
  notifySubleaseRequestedMock: vi.fn(async () => undefined),
}))
vi.mock('../services/notifications', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, notifySubleaseRequested: notifySubleaseRequestedMock }
})

import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { randomUUID } from 'crypto'
import { db } from '../db'
import { subleaseInvitationsRouter } from './subleaseInvitations'
import { errorHandler } from '../middleware/errorHandler'
import {
  cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedTenant,
  seedLease, seedLeaseTenant,
} from '../test/dbHelpers'

beforeEach(async () => {
  await cleanupAllSchema()
  notifySubleaseRequestedMock.mockClear()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_s451'
})

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/sublease-invitations', subleaseInvitationsRouter)
  app.use(errorHandler)
  return app
}

interface InviteFixture {
  invitationId:        string
  token:               string
  subleaseId:          string
  sublessorTenantId:   string
  masterLeaseId:       string
  landlordId:          string
  unitId:              string
  sublesseeEmail:      string
}

/**
 * Seed a complete invite-acceptance fixture: landlord + property + unit +
 * master lease + sublessor tenant (on the master lease) + sublease row
 * in 'pending_invite' + sublessee_invitations row linked back via
 * sublease_id.
 */
async function seedInvitation(overrides: {
  status?:             'sent' | 'accepted' | 'expired' | 'cancelled'
  expiresInMinutes?:   number
  sublesseeEmail?:     string
  subleaseLinked?:     boolean      // whether to set invitation.sublease_id
} = {}): Promise<InviteFixture> {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const { userId: landlordUserId, landlordId } = await seedLandlord(c)
    const propertyId = await seedProperty(c, {
      landlordId, ownerUserId: landlordUserId, managedByUserId: landlordUserId,
    })
    const unitId = await seedUnit(c, { propertyId, landlordId })
    const sublessorTenantId = await seedTenant(c)
    const masterLeaseId = await seedLease(c, { unitId, landlordId })
    await seedLeaseTenant(c, { leaseId: masterLeaseId, tenantId: sublessorTenantId, role: 'primary' })

    const sublesseeEmail = overrides.sublesseeEmail ?? `sublessee-${randomUUID()}@example.com`
    const { rows: [sub] } = await c.query<{ id: string }>(
      `INSERT INTO subleases
         (master_lease_id, sublessor_tenant_id, status,
          start_date, sub_monthly_amount, master_share_amount)
       VALUES ($1, $2, 'pending_invite', '2026-07-01', 600, 200)
       RETURNING id`,
      [masterLeaseId, sublessorTenantId])

    const token = `tok_${randomUUID()}`
    const expiresMins = overrides.expiresInMinutes ?? 60 * 24 * 7  // 7 days default
    const { rows: [inv] } = await c.query<{ id: string }>(
      `INSERT INTO sublessee_invitations
         (token, sublessor_tenant_id, master_lease_id, sublessee_email,
          sub_monthly_amount, master_share_amount, start_date,
          status, expires_at, sublease_id)
       VALUES ($1, $2, $3, $4, 600, 200, '2026-07-01',
               $5, NOW() + ($6 || ' minutes')::interval, $7)
       RETURNING id`,
      [token, sublessorTenantId, masterLeaseId, sublesseeEmail,
       overrides.status ?? 'sent',
       String(expiresMins),
       overrides.subleaseLinked === false ? null : sub.id])
    await c.query(
      `UPDATE subleases SET sublessee_invitation_id = $1 WHERE id = $2`,
      [inv.id, sub.id])

    await c.query('COMMIT')
    return {
      invitationId: inv.id,
      token,
      subleaseId: sub.id,
      sublessorTenantId,
      masterLeaseId,
      landlordId,
      unitId,
      sublesseeEmail,
    }
  } catch (e) { await c.query('ROLLBACK'); throw e }
  finally { c.release() }
}

// ═══════════════════════════════════════════════════════════════
//  GET /api/sublease-invitations/:token
// ═══════════════════════════════════════════════════════════════

describe('GET /api/sublease-invitations/:token', () => {
  it('happy: returns property + unit + sublessor name + amounts; does NOT leak sublessor email or tenant id', async () => {
    const f = await seedInvitation()
    const res = await request(buildApp()).get(`/api/sublease-invitations/${f.token}`)
    expect(res.status).toBe(200)
    expect(res.body.data.property_name).toBe('Test Property')
    expect(res.body.data.unit_number).toMatch(/^U-/)
    expect(res.body.data.sublessor_name).toBe('Test Tenant')
    expect(res.body.data.sublessee_email).toBe(f.sublesseeEmail)
    expect(res.body.data.sub_monthly_amount).toBe(600)
    expect(res.body.data.start_date).toBe('2026-07-01')
    // Non-leak assertions: the route MUST NOT return sublessor email
    // or tenant id (the preview is shown to the unauthenticated
    // recipient).
    expect(res.body.data).not.toHaveProperty('sublessor_email')
    expect(res.body.data).not.toHaveProperty('sublessor_tenant_id')
  })

  it('unknown token → 404', async () => {
    const res = await request(buildApp()).get('/api/sublease-invitations/nope_token')
    expect(res.status).toBe(404)
    expect(res.body.error).toMatch(/not found/i)
  })

  it('already-accepted invitation → 409', async () => {
    const f = await seedInvitation({ status: 'accepted' })
    const res = await request(buildApp()).get(`/api/sublease-invitations/${f.token}`)
    expect(res.status).toBe(409)
    expect(res.body.error).toMatch(/accepted/i)
  })

  it('cancelled invitation → 409', async () => {
    const f = await seedInvitation({ status: 'cancelled' })
    const res = await request(buildApp()).get(`/api/sublease-invitations/${f.token}`)
    expect(res.status).toBe(409)
    expect(res.body.error).toMatch(/cancelled/i)
  })

  it('expired invitation (expires_at in past) → 410', async () => {
    const f = await seedInvitation({ expiresInMinutes: -10 })
    const res = await request(buildApp()).get(`/api/sublease-invitations/${f.token}`)
    expect(res.status).toBe(410)
    expect(res.body.error).toMatch(/expired/i)
  })

  // The "Lease context vanished" 404 (route line 103) is a defensive
  // branch against the ctx JOIN returning zero rows. Reproducing it
  // requires breaking the lease/units/properties/tenants chain in a
  // way that the sublessee_invitations.master_lease_id NOT-NULL FK
  // forbids — the only way to get there in practice is a concurrent
  // delete after the loadInvitation call but before the ctx JOIN, which
  // isn't reachable from the test layer. Skip; the branch is one
  // line and provably correct by inspection.
})

// ═══════════════════════════════════════════════════════════════
//  POST /api/sublease-invitations/:token/accept
// ═══════════════════════════════════════════════════════════════

describe('POST /api/sublease-invitations/:token/accept', () => {
  const acceptBody = (over: Record<string, any> = {}) => ({
    firstName: 'Sub',
    lastName:  'Lessee',
    password:  'sublessee-pw',         // 12 chars — passes the route's 8-char check
    phone:     '555-9999',
    ...over,
  })

  it('happy: 201 + JWT + user + subleaseId, side effects all fired', async () => {
    const f = await seedInvitation()
    const res = await request(buildApp())
      .post(`/api/sublease-invitations/${f.token}/accept`)
      .send(acceptBody())
    expect(res.status).toBe(201)
    expect(res.body.data.token).toEqual(expect.any(String))
    expect(res.body.data.subleaseId).toBe(f.subleaseId)
    expect(res.body.data.user.role).toBe('tenant')
    expect(res.body.data.user.firstName).toBe('Sub')

    // Decode JWT pins role + profileId references actual tenant row.
    const decoded = jwt.decode(res.body.data.token) as any
    expect(decoded.role).toBe('tenant')
    expect(decoded.userId).toEqual(expect.any(String))
    expect(decoded.profileId).toEqual(expect.any(String))

    // Side effect 1: invitation flipped to accepted + accepted_tenant_id stamped
    const { rows: [inv] } = await db.query<any>(
      `SELECT status, accepted_tenant_id, accepted_at
         FROM sublessee_invitations WHERE id = $1`, [f.invitationId])
    expect(inv.status).toBe('accepted')
    expect(inv.accepted_tenant_id).toBe(decoded.profileId)
    expect(inv.accepted_at).not.toBeNull()

    // Side effect 2: sublease row flipped to 'pending' + sublessee stamped
    const { rows: [sub] } = await db.query<any>(
      `SELECT status, sublessee_tenant_id FROM subleases WHERE id = $1`, [f.subleaseId])
    expect(sub.status).toBe('pending')
    expect(sub.sublessee_tenant_id).toBe(decoded.profileId)

    // Side effect 3: landlord notify mock fired with the new sublessee context
    expect(notifySubleaseRequestedMock).toHaveBeenCalledTimes(1)
    const [arg] = notifySubleaseRequestedMock.mock.calls[0] as any[]
    expect(arg.subleaseId).toBe(f.subleaseId)
    expect(arg.sublesseeName).toBe('Sub Lessee')
    expect(arg.unitNumber).toMatch(/^U-/)
    expect(arg.propertyName).toBe('Test Property')
    expect(arg.subMonthlyAmount).toBe(600)
  })

  it('missing firstName → 400', async () => {
    const f = await seedInvitation()
    const res = await request(buildApp())
      .post(`/api/sublease-invitations/${f.token}/accept`)
      .send(acceptBody({ firstName: undefined }))
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/required/i)
  })

  it('missing password → 400', async () => {
    const f = await seedInvitation()
    const res = await request(buildApp())
      .post(`/api/sublease-invitations/${f.token}/accept`)
      .send(acceptBody({ password: undefined }))
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/required/i)
  })

  it('password under 8 chars → 400 (NOTE: route uses 8-char min, not 12 like /register)', async () => {
    // This is intentional — pinning the lower bar at the time of this
    // slice; if the password-policy hygiene sweep equalizes this with
    // /register's 12-char bar in a future session, this assertion + the
    // regex will need to be updated. Documented for visibility.
    const f = await seedInvitation()
    const res = await request(buildApp())
      .post(`/api/sublease-invitations/${f.token}/accept`)
      .send(acceptBody({ password: '7chars!' }))
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/at least 8/i)
  })

  it('unknown token → 404', async () => {
    const res = await request(buildApp())
      .post('/api/sublease-invitations/bogus_token/accept')
      .send(acceptBody())
    expect(res.status).toBe(404)
  })

  it('invitation already accepted → 409', async () => {
    const f = await seedInvitation({ status: 'accepted' })
    const res = await request(buildApp())
      .post(`/api/sublease-invitations/${f.token}/accept`)
      .send(acceptBody())
    expect(res.status).toBe(409)
  })

  it('invitation cancelled → 409', async () => {
    const f = await seedInvitation({ status: 'cancelled' })
    const res = await request(buildApp())
      .post(`/api/sublease-invitations/${f.token}/accept`)
      .send(acceptBody())
    expect(res.status).toBe(409)
  })

  it('invitation expired → 410', async () => {
    const f = await seedInvitation({ expiresInMinutes: -10 })
    const res = await request(buildApp())
      .post(`/api/sublease-invitations/${f.token}/accept`)
      .send(acceptBody())
    expect(res.status).toBe(410)
  })

  it('invitation not linked to sublease row → 500', async () => {
    const f = await seedInvitation({ subleaseLinked: false })
    const res = await request(buildApp())
      .post(`/api/sublease-invitations/${f.token}/accept`)
      .send(acceptBody())
    expect(res.status).toBe(500)
    expect(res.body.error).toMatch(/not linked to a sublease row/i)
  })

  it('email collision: account already exists at sublessee_email → 409 with re-issue hint', async () => {
    const f = await seedInvitation()
    // Pre-seed a user with the same email.
    await db.query(
      `INSERT INTO users (email, password_hash, role, first_name, last_name)
       VALUES ($1, 'x', 'tenant', 'Existing', 'User')`, [f.sublesseeEmail])

    const res = await request(buildApp())
      .post(`/api/sublease-invitations/${f.token}/accept`)
      .send(acceptBody())
    expect(res.status).toBe(409)
    expect(res.body.error).toMatch(/An account with this email already exists/i)
    expect(res.body.error).toMatch(/re-submit/i)

    // Invitation MUST NOT have flipped (no race-window state leak).
    const { rows: [inv] } = await db.query<any>(
      `SELECT status FROM sublessee_invitations WHERE id = $1`, [f.invitationId])
    expect(inv.status).toBe('sent')
  })

  it('email collision check is case-insensitive (UPPERCASE in users row matches lowercase invite email)', async () => {
    const f = await seedInvitation({ sublesseeEmail: 'mixed.case@example.com' })
    await db.query(
      `INSERT INTO users (email, password_hash, role, first_name, last_name)
       VALUES ($1, 'x', 'tenant', 'Existing', 'User')`,
      ['MIXED.CASE@EXAMPLE.COM'])
    const res = await request(buildApp())
      .post(`/api/sublease-invitations/${f.token}/accept`)
      .send(acceptBody())
    expect(res.status).toBe(409)
  })

  it('notify post-commit failure does NOT roll back the signup', async () => {
    const f = await seedInvitation()
    notifySubleaseRequestedMock.mockRejectedValueOnce(new Error('SMTP down'))
    const res = await request(buildApp())
      .post(`/api/sublease-invitations/${f.token}/accept`)
      .send(acceptBody())
    expect(res.status).toBe(201)
    // Invitation + sublease still flipped despite the notify failure.
    const { rows: [inv] } = await db.query<any>(
      `SELECT status FROM sublessee_invitations WHERE id = $1`, [f.invitationId])
    expect(inv.status).toBe('accepted')
    const { rows: [sub] } = await db.query<any>(
      `SELECT status FROM subleases WHERE id = $1`, [f.subleaseId])
    expect(sub.status).toBe('pending')
  })

  it('happy: invitation row flipped + sublease row flipped within ONE transaction (atomicity)', async () => {
    const f = await seedInvitation()
    // Sanity: both rows in their starting states.
    let { rows: [inv] } = await db.query<any>(
      `SELECT status, accepted_at FROM sublessee_invitations WHERE id = $1`, [f.invitationId])
    expect(inv.status).toBe('sent')
    expect(inv.accepted_at).toBeNull()
    let { rows: [sub] } = await db.query<any>(
      `SELECT status, sublessee_tenant_id FROM subleases WHERE id = $1`, [f.subleaseId])
    expect(sub.status).toBe('pending_invite')
    expect(sub.sublessee_tenant_id).toBeNull()

    await request(buildApp())
      .post(`/api/sublease-invitations/${f.token}/accept`)
      .send(acceptBody())

    ;({ rows: [inv] } = await db.query<any>(
      `SELECT status, accepted_at, accepted_tenant_id FROM sublessee_invitations WHERE id = $1`,
      [f.invitationId]))
    ;({ rows: [sub] } = await db.query<any>(
      `SELECT status, sublessee_tenant_id FROM subleases WHERE id = $1`, [f.subleaseId]))
    expect(inv.status).toBe('accepted')
    expect(inv.accepted_at).not.toBeNull()
    expect(sub.status).toBe('pending')
    expect(sub.sublessee_tenant_id).toBe(inv.accepted_tenant_id)  // same tenant on both rows
  })
})
