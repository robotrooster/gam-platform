/**
 * landlords.ts PM property invitations slice — S366 (landlords slice
 * 10 of N).
 *
 * 7 routes covering the owner-side of the PM ↔ Landlord property
 * handshake (S157):
 *   - PATCH /me/default-pm-company — set/clear landlord-level default
 *   - GET  /me/linked-pm-companies — DISTINCT companies on this
 *     landlord's properties + counts
 *   - POST /me/pm-property-invitations — owner sends owner_to_pm
 *   - GET  /me/pm-property-invitations — list landlord-scoped
 *   - POST /me/pm-property-invitations/:id/accept — owner accepts
 *     pm_to_owner (only valid direction)
 *   - POST /me/pm-property-invitations/:id/reject — owner rejects
 *     pm_to_owner
 *   - DELETE /me/pm-property-invitations/:id — owner revokes own
 *     owner_to_pm invite
 *
 * The PM-side of the same handshake (POST from PM company portal)
 * lives in pm.ts and is its own slice. Service helpers
 * (sendPropertyInvitation / acceptPropertyInvitation /
 * rejectPropertyInvitation / revokePropertyInvitation) are mocked —
 * their multi-table writes have their own coverage and would drag in
 * cross-table fixtures.
 */

import { vi, describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { randomUUID } from 'crypto'
import { db } from '../db'
import {
  cleanupAllSchema, seedLandlord, seedProperty,
} from '../test/dbHelpers'

const {
  sendPropertyInvitationMock,
  acceptPropertyInvitationMock,
  rejectPropertyInvitationMock,
  revokePropertyInvitationMock,
  emailPmPropertyInvitationMock,
} = vi.hoisted(() => ({
  sendPropertyInvitationMock:   vi.fn(async (..._args: any[]) => ({ invitationId: 'inv_mock', token: 'tok_mock_64chars' })),
  acceptPropertyInvitationMock: vi.fn(async (..._args: any[]) => ({ ok: true })),
  rejectPropertyInvitationMock: vi.fn(async (..._args: any[]) => ({ ok: true })),
  revokePropertyInvitationMock: vi.fn(async (..._args: any[]) => undefined),
  emailPmPropertyInvitationMock: vi.fn(async (..._args: any[]) => 'msg_mock'),
}))
vi.mock('../services/pm', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    sendPropertyInvitation:   sendPropertyInvitationMock,
    acceptPropertyInvitation: acceptPropertyInvitationMock,
    rejectPropertyInvitation: rejectPropertyInvitationMock,
    revokePropertyInvitation: revokePropertyInvitationMock,
  }
})
vi.mock('../services/email', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, emailPmPropertyInvitation: emailPmPropertyInvitationMock }
})

import { landlordsRouter } from './landlords'
import { errorHandler } from '../middleware/errorHandler'

function buildApp() {
  const app = express()
  app.use(express.json({ limit: '2mb' }))
  app.use('/api/landlords', landlordsRouter)
  app.use(errorHandler)
  return app
}

beforeEach(async () => {
  await cleanupAllSchema()
  sendPropertyInvitationMock.mockClear()
  sendPropertyInvitationMock.mockResolvedValue({ invitationId: 'inv_mock', token: 'tok_mock_64chars' } as any)
  acceptPropertyInvitationMock.mockClear(); acceptPropertyInvitationMock.mockResolvedValue({ ok: true } as any)
  rejectPropertyInvitationMock.mockClear(); rejectPropertyInvitationMock.mockResolvedValue({ ok: true } as any)
  revokePropertyInvitationMock.mockClear(); revokePropertyInvitationMock.mockResolvedValue(undefined as any)
  emailPmPropertyInvitationMock.mockClear()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_pm_invites'
})

interface PMIFixture {
  landlordUserId: string
  landlordId:     string
  landlordToken:  string
  propertyId:     string
}

async function seedPMIFixture(): Promise<PMIFixture> {
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    const { userId: landlordUserId, landlordId } = await seedLandlord(client)
    const propertyId = await seedProperty(client, {
      landlordId, ownerUserId: landlordUserId, managedByUserId: landlordUserId,
    })
    await client.query('COMMIT')
    const landlordToken = jwt.sign(
      { userId: landlordUserId, role: 'landlord', email: 'll@test.dev',
        profileId: landlordId, permissions: {} },
      process.env.JWT_SECRET!, { expiresIn: '1h' },
    )
    return { landlordUserId, landlordId, landlordToken, propertyId }
  } catch (e) { await client.query('ROLLBACK'); throw e }
  finally { client.release() }
}

async function seedPmCompany(opts: { status?: string } = {}): Promise<string> {
  const r = await db.query<{ id: string }>(
    `INSERT INTO pm_companies (name, status) VALUES ($1, $2) RETURNING id`,
    [`PM-${randomUUID().slice(0, 6)}`, opts.status ?? 'active'])
  return r.rows[0].id
}

async function seedInvite(f: PMIFixture, opts: {
  direction: 'owner_to_pm' | 'pm_to_owner';
  pmCompanyId: string;
  landlordId?: string;
  status?: string;
}): Promise<string> {
  const r = await db.query<{ id: string }>(
    `INSERT INTO pm_property_invitations
       (direction, pm_company_id, property_id, landlord_id, invited_email,
        invited_by_user_id, token, expires_at, status)
     VALUES ($1, $2, $3, $4, 'invitee@test.dev', $5, $6,
             NOW() + INTERVAL '7 days', $7)
     RETURNING id`,
    [opts.direction, opts.pmCompanyId, f.propertyId,
     opts.landlordId ?? f.landlordId, f.landlordUserId,
     randomUUID().replace(/-/g, ''),
     opts.status ?? 'pending'])
  return r.rows[0].id
}

describe('PATCH /me/default-pm-company', () => {
  it('set to active PM company → 200; landlords.default_pm_company_id updated', async () => {
    const f = await seedPMIFixture()
    const pmId = await seedPmCompany({ status: 'active' })
    const res = await request(buildApp())
      .patch('/api/landlords/me/default-pm-company')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ pmCompanyId: pmId })
    expect(res.status).toBe(200)
    expect(res.body.data.default_pm_company_id).toBe(pmId)
  })

  it('non-existent pmCompanyId → 404', async () => {
    const f = await seedPMIFixture()
    const res = await request(buildApp())
      .patch('/api/landlords/me/default-pm-company')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ pmCompanyId: randomUUID() })
    expect(res.status).toBe(404)
    expect(res.body.error).toMatch(/PM company not found/)
  })

  it('inactive PM company → 400', async () => {
    const f = await seedPMIFixture()
    const pmId = await seedPmCompany({ status: 'inactive' })
    const res = await request(buildApp())
      .patch('/api/landlords/me/default-pm-company')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ pmCompanyId: pmId })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/PM company is not active/)
  })
})

describe('GET /me/linked-pm-companies', () => {
  it('returns DISTINCT pm_companies linked via properties + per-company property_count', async () => {
    const f = await seedPMIFixture()
    const pmId = await seedPmCompany()
    // Link property to PM company directly
    await db.query(`UPDATE properties SET pm_company_id=$1 WHERE id=$2`, [pmId, f.propertyId])

    const res = await request(buildApp())
      .get('/api/landlords/me/linked-pm-companies')
      .set('Authorization', `Bearer ${f.landlordToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data.length).toBe(1)
    expect(res.body.data[0].id).toBe(pmId)
    expect(res.body.data[0].property_count).toBe(1)
  })
})

describe('POST /me/pm-property-invitations — send owner_to_pm', () => {
  it('happy: calls sendPropertyInvitation + fires email; returns invitation_id', async () => {
    const f = await seedPMIFixture()
    const pmId = await seedPmCompany()
    const res = await request(buildApp())
      .post('/api/landlords/me/pm-property-invitations')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({
        pmCompanyId: pmId, propertyId: f.propertyId,
        invitedEmail: 'pm@test.dev', proposedScope: 'manage',
      })
    expect(res.status).toBe(201)
    expect(res.body.data.invitation_id).toBe('inv_mock')
    expect(sendPropertyInvitationMock).toHaveBeenCalledTimes(1)
    expect(sendPropertyInvitationMock.mock.calls[0]![0]).toMatchObject({
      direction: 'owner_to_pm', pmCompanyId: pmId, propertyId: f.propertyId,
      landlordId: f.landlordId, invitedEmail: 'pm@test.dev', proposedScope: 'manage',
    })
    expect(emailPmPropertyInvitationMock).toHaveBeenCalledTimes(1)
  })
})

describe('GET /me/pm-property-invitations — list', () => {
  it('landlord-scoped + status filter narrows results', async () => {
    const a = await seedPMIFixture()
    const b = await seedPMIFixture()
    const pmIdA = await seedPmCompany()
    const pmIdB = await seedPmCompany()
    await seedInvite(a, { direction: 'owner_to_pm', pmCompanyId: pmIdA, status: 'pending' })
    await seedInvite(a, { direction: 'owner_to_pm', pmCompanyId: pmIdA, status: 'rejected' })
    await seedInvite(b, { direction: 'owner_to_pm', pmCompanyId: pmIdB, status: 'pending' })

    // All a's invites
    const all = await request(buildApp())
      .get('/api/landlords/me/pm-property-invitations')
      .set('Authorization', `Bearer ${a.landlordToken}`)
    expect(all.status).toBe(200)
    expect(all.body.data.length).toBe(2)

    // Filter to pending only
    const pending = await request(buildApp())
      .get('/api/landlords/me/pm-property-invitations?status=pending')
      .set('Authorization', `Bearer ${a.landlordToken}`)
    expect(pending.body.data.length).toBe(1)
    expect(pending.body.data[0].status).toBe('pending')
  })
})

describe('POST /me/pm-property-invitations/:invId/accept', () => {
  it('cross-landlord invitation → 403; service NOT called', async () => {
    const a = await seedPMIFixture()
    const b = await seedPMIFixture()
    const pmId = await seedPmCompany()
    const bInvId = await seedInvite(b, { direction: 'pm_to_owner', pmCompanyId: pmId })

    const res = await request(buildApp())
      .post(`/api/landlords/me/pm-property-invitations/${bInvId}/accept`)
      .set('Authorization', `Bearer ${a.landlordToken}`).send({})
    expect(res.status).toBe(403)
    expect(acceptPropertyInvitationMock).not.toHaveBeenCalled()
  })

  it('owner_to_pm direction → 400 (only pm_to_owner can be owner-accepted)', async () => {
    const f = await seedPMIFixture()
    const pmId = await seedPmCompany()
    const invId = await seedInvite(f, { direction: 'owner_to_pm', pmCompanyId: pmId })

    const res = await request(buildApp())
      .post(`/api/landlords/me/pm-property-invitations/${invId}/accept`)
      .set('Authorization', `Bearer ${f.landlordToken}`).send({})
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/Only pm_to_owner invitations can be accepted by owner/)
    expect(acceptPropertyInvitationMock).not.toHaveBeenCalled()
  })

  it('happy: pm_to_owner → acceptPropertyInvitation called with token + replace=false default', async () => {
    const f = await seedPMIFixture()
    const pmId = await seedPmCompany()
    const invId = await seedInvite(f, { direction: 'pm_to_owner', pmCompanyId: pmId })

    const res = await request(buildApp())
      .post(`/api/landlords/me/pm-property-invitations/${invId}/accept`)
      .set('Authorization', `Bearer ${f.landlordToken}`).send({})
    expect(res.status).toBe(200)
    expect(acceptPropertyInvitationMock).toHaveBeenCalledTimes(1)
    expect(acceptPropertyInvitationMock.mock.calls[0]![0]).toMatchObject({
      acceptingUserId: f.landlordUserId,
      replace: false,
    })
  })
})

describe('POST /me/pm-property-invitations/:invId/reject', () => {
  it('owner_to_pm direction → 400 (only pm_to_owner can be owner-rejected)', async () => {
    const f = await seedPMIFixture()
    const pmId = await seedPmCompany()
    const invId = await seedInvite(f, { direction: 'owner_to_pm', pmCompanyId: pmId })

    const res = await request(buildApp())
      .post(`/api/landlords/me/pm-property-invitations/${invId}/reject`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ reason: 'no thanks' })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/Only pm_to_owner invitations can be rejected by owner/)
    expect(rejectPropertyInvitationMock).not.toHaveBeenCalled()
  })
})

describe('DELETE /me/pm-property-invitations/:invId — owner revokes own owner_to_pm', () => {
  it('pm_to_owner direction → 400 (only owner-sent revocable here)', async () => {
    const f = await seedPMIFixture()
    const pmId = await seedPmCompany()
    const invId = await seedInvite(f, { direction: 'pm_to_owner', pmCompanyId: pmId })

    const res = await request(buildApp())
      .delete(`/api/landlords/me/pm-property-invitations/${invId}`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/Only owner-sent invitations can be revoked here/)
    expect(revokePropertyInvitationMock).not.toHaveBeenCalled()
  })

  it('happy: owner_to_pm → revokePropertyInvitation called with invId + userId', async () => {
    const f = await seedPMIFixture()
    const pmId = await seedPmCompany()
    const invId = await seedInvite(f, { direction: 'owner_to_pm', pmCompanyId: pmId })

    const res = await request(buildApp())
      .delete(`/api/landlords/me/pm-property-invitations/${invId}`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
    expect(res.status).toBe(200)
    expect(revokePropertyInvitationMock).toHaveBeenCalledTimes(1)
    // Args: (client, invId, userId)
    const args = revokePropertyInvitationMock.mock.calls[0]!
    expect(args[1]).toBe(invId)
    expect(args[2]).toBe(f.landlordUserId)
  })
})
