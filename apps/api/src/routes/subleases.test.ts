/**
 * Subleases route — S197+ multi-party sublease workflow.
 *
 * Surfaces under test:
 *   - POST   /subleases                request (tenant-only)
 *   - PATCH  /subleases/:id/decision   approve / deny (landlord-only)
 *   - PATCH  /subleases/:id/terminate  early termination (any party)
 *   - GET    /subleases                list scoped per role
 *   - GET    /subleases/:id            scope-gated detail
 *
 * High-leverage paths:
 *   (1) Request-time gates: property-level subleasing_allowed AND lease-
 *       level subleasing_allowed (prohibited / with_consent / allowed).
 *       Auto-approve under 'allowed', pending under 'with_consent',
 *       invite flow when sublessee not yet on the platform.
 *   (2) Decision state machine: pending → awaiting_signatures (approve,
 *       generates document) or terminated (deny). PATCH gates on the
 *       'pending' status.
 *   (3) Termination — three parties can terminate; reason prefix
 *       (sublessor_terminated / sublessee_terminated / landlord_terminated)
 *       reflects who triggered, recipient notifications skip the trigger.
 *   (4) List role scoping; landlord excludes pending_invite (sublessee
 *       not yet known to landlord).
 *
 * Skipped here:
 *   - GET /me/credit + POST /me/credit/withdraw — subleaseAllocation
 *     service-level concern, separable
 *
 * Mocks: creditLedger.appendEvent, subleaseDocuments.generateSubleaseDocument,
 * email.sendSubleaseInvite, four notify* functions, adminNotifications.
 */

import { vi, describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { randomUUID } from 'crypto'
import { db } from '../db'
import {
  cleanupAllSchema,
  seedLandlord, seedTenant, seedProperty, seedUnit, seedLease, seedLeaseTenant,
} from '../test/dbHelpers'

const {
  appendEventMock,
  generateSubleaseDocumentMock,
  sendSubleaseInviteMock,
  notifySubleaseRequestedMock,
  notifySubleaseDecisionMock,
  notifySubleaseTerminatedMock,
  createAdminNotificationMock,
} = vi.hoisted(() => ({
  appendEventMock:                vi.fn(async () => ({ id: 'ev_mock' })),
  generateSubleaseDocumentMock:   vi.fn(async () => ({ documentId: 'doc_mock' })),
  sendSubleaseInviteMock:         vi.fn(async () => 'msg_mock'),
  notifySubleaseRequestedMock:    vi.fn(async () => {}),
  notifySubleaseDecisionMock:     vi.fn(async () => {}),
  notifySubleaseTerminatedMock:   vi.fn(async () => {}),
  createAdminNotificationMock:    vi.fn(async () => {}),
}))
vi.mock('../services/creditLedger', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, appendEvent: appendEventMock }
})
vi.mock('../services/subleaseDocuments', () => ({
  generateSubleaseDocument: generateSubleaseDocumentMock,
}))
vi.mock('../services/email', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, sendSubleaseInvite: sendSubleaseInviteMock }
})
vi.mock('../services/notifications', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    notifySubleaseRequested:  notifySubleaseRequestedMock,
    notifySubleaseDecision:   notifySubleaseDecisionMock,
    notifySubleaseTerminated: notifySubleaseTerminatedMock,
  }
})
vi.mock('../services/adminNotifications', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, createAdminNotification: createAdminNotificationMock }
})

import { subleasesRouter } from './subleases'
import { errorHandler } from '../middleware/errorHandler'

function buildApp() {
  const app = express()
  app.use(express.json({ limit: '2mb' }))
  app.use('/api/subleases', subleasesRouter)
  app.use(errorHandler)
  return app
}

beforeEach(async () => {
  await cleanupAllSchema()
  appendEventMock.mockClear()
  generateSubleaseDocumentMock.mockClear()
  sendSubleaseInviteMock.mockClear()
  notifySubleaseRequestedMock.mockClear()
  notifySubleaseDecisionMock.mockClear()
  notifySubleaseTerminatedMock.mockClear()
  createAdminNotificationMock.mockClear()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_subleases'
})

interface SeedFixture {
  landlordUserId:    string
  landlordId:        string
  sublessorTenantId: string
  sublessorUserId:   string
  sublesseeTenantId: string
  sublesseeUserId:   string
  sublesseeEmail:    string
  unitId:            string
  propertyId:        string
  leaseId:           string
  landlordToken:     string
  sublessorToken:    string
  sublesseeToken:    string
}

async function seedFixture(opts: {
  subleasingAllowed?:           'prohibited' | 'with_consent' | 'allowed'
  propertySubleasingAllowed?:   boolean
  leaseStatus?:                  'pending' | 'active' | 'expired' | 'terminated'
} = {}): Promise<SeedFixture> {
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    const { userId: landlordUserId, landlordId } = await seedLandlord(client)
    const sublessorTenantId = await seedTenant(client)
    const sublesseeEmail = `sublessee-${randomUUID()}@test.dev`
    const sublesseeTenantId = await seedTenant(client, { email: sublesseeEmail })
    const tu1 = await client.query<{ user_id: string }>(`SELECT user_id FROM tenants WHERE id = $1`, [sublessorTenantId])
    const tu2 = await client.query<{ user_id: string }>(`SELECT user_id FROM tenants WHERE id = $1`, [sublesseeTenantId])
    const sublessorUserId = tu1.rows[0].user_id
    const sublesseeUserId = tu2.rows[0].user_id
    const propertyId = await seedProperty(client, { landlordId, ownerUserId: landlordUserId, managedByUserId: landlordUserId })
    // Property subleasing toggle (S247)
    await client.query(
      `UPDATE properties SET subleasing_allowed = $1 WHERE id = $2`,
      [opts.propertySubleasingAllowed ?? true, propertyId],
    )
    const unitId = await seedUnit(client, { propertyId, landlordId })
    const leaseId = await seedLease(client, {
      unitId, landlordId,
      status: (opts.leaseStatus as any) ?? 'active',
    })
    // Set the lease-level subleasing_allowed enum
    await client.query(
      `UPDATE leases SET subleasing_allowed = $1 WHERE id = $2`,
      [opts.subleasingAllowed ?? 'with_consent', leaseId],
    )
    await seedLeaseTenant(client, { leaseId, tenantId: sublessorTenantId })
    await client.query('COMMIT')

    const landlordToken = jwt.sign(
      { userId: landlordUserId, role: 'landlord', email: 'll@test.dev', profileId: landlordId, permissions: {} },
      process.env.JWT_SECRET!, { expiresIn: '1h' },
    )
    const sublessorToken = jwt.sign(
      { userId: sublessorUserId, role: 'tenant', email: 'or@test.dev', profileId: sublessorTenantId, permissions: {} },
      process.env.JWT_SECRET!, { expiresIn: '1h' },
    )
    const sublesseeToken = jwt.sign(
      { userId: sublesseeUserId, role: 'tenant', email: sublesseeEmail, profileId: sublesseeTenantId, permissions: {} },
      process.env.JWT_SECRET!, { expiresIn: '1h' },
    )
    return {
      landlordUserId, landlordId,
      sublessorTenantId, sublessorUserId,
      sublesseeTenantId, sublesseeUserId, sublesseeEmail,
      unitId, propertyId, leaseId,
      landlordToken, sublessorToken, sublesseeToken,
    }
  } catch (e) { await client.query('ROLLBACK'); throw e }
  finally { client.release() }
}

function reqBody(f: SeedFixture, override: Partial<{
  startDate: string; endDate: string | null; subMonthlyAmount: number; masterShareAmount: number; sublesseeEmail: string
}> = {}) {
  return {
    masterLeaseId:     f.leaseId,
    sublesseeEmail:    override.sublesseeEmail ?? f.sublesseeEmail,
    startDate:         override.startDate ?? '2026-07-01',
    endDate:           override.endDate === undefined ? '2026-12-31' : override.endDate,
    subMonthlyAmount:  override.subMonthlyAmount ?? 1200,
    masterShareAmount: override.masterShareAmount,
  }
}

// ─── POST /subleases — request flow ──────────────────────────────

describe('POST /subleases — request gates', () => {
  it('sublessor request with with_consent policy → status=pending, landlord notified, credit event', async () => {
    const f = await seedFixture({ subleasingAllowed: 'with_consent' })
    const res = await request(buildApp())
      .post('/api/subleases')
      .set('Authorization', `Bearer ${f.sublessorToken}`)
      .send(reqBody(f))
    expect(res.status).toBe(201)
    expect(res.body.data.status).toBe('pending')
    expect(res.body.data.sublessee_tenant_id).toBe(f.sublesseeTenantId)
    expect(res.body.data.sublessor_tenant_id).toBe(f.sublessorTenantId)
    expect(notifySubleaseRequestedMock).toHaveBeenCalledTimes(1)
    expect(appendEventMock).toHaveBeenCalledTimes(1)
    const ev = (appendEventMock.mock.calls[0] as unknown as any[])[0]
    expect(ev.eventType).toBe('sublease_requested')
    expect(ev.eventData.subleasing_policy).toBe('with_consent')
    expect(ev.eventData.auto_approved).toBe(false)
  })

  it("'allowed' policy auto-approves → status=active immediately, landlord NOT notified", async () => {
    const f = await seedFixture({ subleasingAllowed: 'allowed' })
    const res = await request(buildApp())
      .post('/api/subleases')
      .set('Authorization', `Bearer ${f.sublessorToken}`)
      .send(reqBody(f))
    expect(res.status).toBe(201)
    expect(res.body.data.status).toBe('active')
    expect(res.body.data.landlord_consent_date).toBeTruthy()
    // Auto-approved → no landlord notification needed
    expect(notifySubleaseRequestedMock).not.toHaveBeenCalled()
    const ev = (appendEventMock.mock.calls[0] as unknown as any[])[0]
    expect(ev.eventData.auto_approved).toBe(true)
  })

  it("'prohibited' policy rejects → 409", async () => {
    const f = await seedFixture({ subleasingAllowed: 'prohibited' })
    const res = await request(buildApp())
      .post('/api/subleases')
      .set('Authorization', `Bearer ${f.sublessorToken}`)
      .send(reqBody(f))
    expect(res.status).toBe(409)
    expect(res.body.error).toMatch(/prohibited/)
  })

  it('property-level subleasing_allowed=false rejects → 409 even if lease enum permits', async () => {
    const f = await seedFixture({ subleasingAllowed: 'allowed', propertySubleasingAllowed: false })
    const res = await request(buildApp())
      .post('/api/subleases')
      .set('Authorization', `Bearer ${f.sublessorToken}`)
      .send(reqBody(f))
    expect(res.status).toBe(409)
    expect(res.body.error).toMatch(/property/i)
  })

  it('lease not active → 409', async () => {
    const f = await seedFixture({ leaseStatus: 'pending' })
    const res = await request(buildApp())
      .post('/api/subleases')
      .set('Authorization', `Bearer ${f.sublessorToken}`)
      .send(reqBody(f))
    expect(res.status).toBe(409)
  })

  it('master lease not found → 404', async () => {
    const f = await seedFixture()
    const res = await request(buildApp())
      .post('/api/subleases')
      .set('Authorization', `Bearer ${f.sublessorToken}`)
      .send({ ...reqBody(f), masterLeaseId: randomUUID() })
    expect(res.status).toBe(404)
  })

  it('tenant not on lease → 403', async () => {
    const f = await seedFixture()
    // Use a different tenant token (sublessee isn't on the lease — only sublessor is).
    const res = await request(buildApp())
      .post('/api/subleases')
      .set('Authorization', `Bearer ${f.sublesseeToken}`)
      .send(reqBody(f))
    expect(res.status).toBe(403)
    expect(res.body.error).toMatch(/not an active tenant/i)
  })

  it('sublessor cannot sublease to themselves → 400', async () => {
    const f = await seedFixture()
    // Find the sublessor's email from the seed (tenants table has user_id → users.email).
    const r = await db.query<{ email: string }>(
      `SELECT u.email FROM tenants t JOIN users u ON u.id = t.user_id WHERE t.id = $1`,
      [f.sublessorTenantId],
    )
    const res = await request(buildApp())
      .post('/api/subleases')
      .set('Authorization', `Bearer ${f.sublessorToken}`)
      .send({ ...reqBody(f), sublesseeEmail: r.rows[0].email })
    expect(res.status).toBe(400)
  })

  it('end_date before start_date → 400', async () => {
    const f = await seedFixture()
    const res = await request(buildApp())
      .post('/api/subleases')
      .set('Authorization', `Bearer ${f.sublessorToken}`)
      .send({ ...reqBody(f), startDate: '2026-12-01', endDate: '2026-07-01' })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/end_date must be/i)
  })

  it('landlord cannot create sublease (tenant-only) → 403', async () => {
    const f = await seedFixture()
    const res = await request(buildApp())
      .post('/api/subleases')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send(reqBody(f))
    expect(res.status).toBe(403)
  })

  it('zod rejects invalid date format', async () => {
    const f = await seedFixture()
    const res = await request(buildApp())
      .post('/api/subleases')
      .set('Authorization', `Bearer ${f.sublessorToken}`)
      .send({ ...reqBody(f), startDate: '07/01/2026' })
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(res.status).toBeLessThan(500)
  })

  it('masterShareAmount defaults to subMonthlyAmount when not provided', async () => {
    const f = await seedFixture()
    const res = await request(buildApp())
      .post('/api/subleases')
      .set('Authorization', `Bearer ${f.sublessorToken}`)
      .send({ ...reqBody(f), subMonthlyAmount: 1500 })
    expect(res.status).toBe(201)
    expect(Number(res.body.data.master_share_amount)).toBe(1500)
  })

  it('explicit masterShareAmount below subMonthlyAmount is honored (sublessor markup)', async () => {
    const f = await seedFixture()
    const res = await request(buildApp())
      .post('/api/subleases')
      .set('Authorization', `Bearer ${f.sublessorToken}`)
      .send({ ...reqBody(f), subMonthlyAmount: 1500, masterShareAmount: 1200 })
    expect(res.status).toBe(201)
    expect(Number(res.body.data.sub_monthly_amount)).toBe(1500)
    expect(Number(res.body.data.master_share_amount)).toBe(1200)
  })
})

describe('POST /subleases — invite flow (sublessee not on platform)', () => {
  it('unknown email triggers invitation row + sublease in pending_invite + email sent', async () => {
    const f = await seedFixture()
    const res = await request(buildApp())
      .post('/api/subleases')
      .set('Authorization', `Bearer ${f.sublessorToken}`)
      .send({ ...reqBody(f), sublesseeEmail: 'never-seen@test.dev' })
    expect(res.status).toBe(201)
    expect(res.body.data.status).toBe('pending_invite')
    expect(res.body.data.sublessee_tenant_id).toBeNull()
    expect(res.body.data.sublessee_invitation_id).toBeTruthy()
    // Email side-effect
    expect(sendSubleaseInviteMock).toHaveBeenCalledTimes(1)
    // Landlord not notified yet for invite flow
    expect(notifySubleaseRequestedMock).not.toHaveBeenCalled()
    // Invitation row links back to the sublease
    const inv = await db.query<{ sublease_id: string }>(
      `SELECT sublease_id FROM sublessee_invitations WHERE id = $1`,
      [res.body.data.sublessee_invitation_id],
    )
    expect(inv.rows[0].sublease_id).toBe(res.body.data.id)
  })
})

// ─── PATCH /subleases/:id/decision ────────────────────────────────

describe('PATCH /subleases/:id/decision', () => {
  it('approve flips pending → awaiting_signatures, sets consent date, generates doc, emits credit event', async () => {
    const f = await seedFixture({ subleasingAllowed: 'with_consent' })
    // Seed an existing pending sublease.
    const sl = await db.query<{ id: string }>(
      `INSERT INTO subleases (master_lease_id, sublessor_tenant_id, sublessee_tenant_id,
                              status, start_date, end_date, sub_monthly_amount, master_share_amount)
       VALUES ($1, $2, $3, 'pending', '2026-07-01', '2026-12-31', 1200, 1200) RETURNING id`,
      [f.leaseId, f.sublessorTenantId, f.sublesseeTenantId],
    )
    const res = await request(buildApp())
      .patch(`/api/subleases/${sl.rows[0].id}/decision`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ decision: 'approve', notes: 'Okay with us' })
    expect(res.status).toBe(200)
    expect(res.body.data.status).toBe('awaiting_signatures')
    expect(res.body.data.landlord_consent_date).toBeTruthy()
    expect(generateSubleaseDocumentMock).toHaveBeenCalledTimes(1)
    expect(notifySubleaseDecisionMock).toHaveBeenCalledTimes(1)
    const ev = (appendEventMock.mock.calls[0] as unknown as any[])[0]
    expect(ev.eventType).toBe('sublease_approved')
    expect(ev.eventData.decision_note).toBe('Okay with us')
  })

  it('deny flips pending → terminated, sets reason, no doc generated, emits sublease_denied event', async () => {
    const f = await seedFixture()
    const sl = await db.query<{ id: string }>(
      `INSERT INTO subleases (master_lease_id, sublessor_tenant_id, sublessee_tenant_id,
                              status, start_date, end_date, sub_monthly_amount, master_share_amount)
       VALUES ($1, $2, $3, 'pending', '2026-07-01', '2026-12-31', 1200, 1200) RETURNING id`,
      [f.leaseId, f.sublessorTenantId, f.sublesseeTenantId],
    )
    const res = await request(buildApp())
      .patch(`/api/subleases/${sl.rows[0].id}/decision`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ decision: 'deny', notes: 'Not at this property' })
    expect(res.status).toBe(200)
    expect(res.body.data.status).toBe('terminated')
    expect(res.body.data.terminated_reason).toBe('landlord_denied')
    expect(generateSubleaseDocumentMock).not.toHaveBeenCalled()
    const ev = (appendEventMock.mock.calls[0] as unknown as any[])[0]
    expect(ev.eventType).toBe('sublease_denied')
  })

  it('cannot decide a non-pending sublease (409)', async () => {
    const f = await seedFixture()
    const sl = await db.query<{ id: string }>(
      `INSERT INTO subleases (master_lease_id, sublessor_tenant_id, sublessee_tenant_id,
                              status, start_date, end_date, sub_monthly_amount, master_share_amount)
       VALUES ($1, $2, $3, 'active', '2026-07-01', '2026-12-31', 1200, 1200) RETURNING id`,
      [f.leaseId, f.sublessorTenantId, f.sublesseeTenantId],
    )
    const res = await request(buildApp())
      .patch(`/api/subleases/${sl.rows[0].id}/decision`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ decision: 'approve' })
    expect(res.status).toBe(409)
  })

  it('cross-landlord rejected', async () => {
    const f = await seedFixture()
    const sl = await db.query<{ id: string }>(
      `INSERT INTO subleases (master_lease_id, sublessor_tenant_id, sublessee_tenant_id,
                              status, start_date, end_date, sub_monthly_amount, master_share_amount)
       VALUES ($1, $2, $3, 'pending', '2026-07-01', '2026-12-31', 1200, 1200) RETURNING id`,
      [f.leaseId, f.sublessorTenantId, f.sublesseeTenantId],
    )
    const otherToken = jwt.sign(
      { userId: randomUUID(), role: 'landlord', email: 'o@test.dev', profileId: randomUUID(), permissions: {} },
      process.env.JWT_SECRET!, { expiresIn: '1h' },
    )
    const res = await request(buildApp())
      .patch(`/api/subleases/${sl.rows[0].id}/decision`)
      .set('Authorization', `Bearer ${otherToken}`)
      .send({ decision: 'approve' })
    expect(res.status).toBe(403)
  })

  it('tenant cannot decide (requireLandlord)', async () => {
    const f = await seedFixture()
    const sl = await db.query<{ id: string }>(
      `INSERT INTO subleases (master_lease_id, sublessor_tenant_id, sublessee_tenant_id,
                              status, start_date, end_date, sub_monthly_amount, master_share_amount)
       VALUES ($1, $2, $3, 'pending', '2026-07-01', '2026-12-31', 1200, 1200) RETURNING id`,
      [f.leaseId, f.sublessorTenantId, f.sublesseeTenantId],
    )
    const res = await request(buildApp())
      .patch(`/api/subleases/${sl.rows[0].id}/decision`)
      .set('Authorization', `Bearer ${f.sublessorToken}`)
      .send({ decision: 'approve' })
    expect(res.status).toBe(403)
  })

  it('approve with doc generation failure still flips status + creates admin notification', async () => {
    const f = await seedFixture()
    generateSubleaseDocumentMock.mockRejectedValueOnce(new Error('PDF render failed'))
    const sl = await db.query<{ id: string }>(
      `INSERT INTO subleases (master_lease_id, sublessor_tenant_id, sublessee_tenant_id,
                              status, start_date, end_date, sub_monthly_amount, master_share_amount)
       VALUES ($1, $2, $3, 'pending', '2026-07-01', '2026-12-31', 1200, 1200) RETURNING id`,
      [f.leaseId, f.sublessorTenantId, f.sublesseeTenantId],
    )
    const res = await request(buildApp())
      .patch(`/api/subleases/${sl.rows[0].id}/decision`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ decision: 'approve' })
    expect(res.status).toBe(200)
    expect(res.body.data.status).toBe('awaiting_signatures')
    expect(createAdminNotificationMock).toHaveBeenCalledTimes(1)
    const adminCall = (createAdminNotificationMock.mock.calls[0] as unknown as any[])[0]
    expect(adminCall.category).toBe('sublease_doc_generation_failed')
  })
})

// ─── PATCH /subleases/:id/terminate ───────────────────────────────

async function seedActiveSublease(f: SeedFixture): Promise<string> {
  const sl = await db.query<{ id: string }>(
    `INSERT INTO subleases (master_lease_id, sublessor_tenant_id, sublessee_tenant_id,
                            status, start_date, end_date, sub_monthly_amount, master_share_amount)
     VALUES ($1, $2, $3, 'active', '2026-07-01', '2026-12-31', 1200, 1200) RETURNING id`,
    [f.leaseId, f.sublessorTenantId, f.sublesseeTenantId],
  )
  return sl.rows[0].id
}

describe('PATCH /subleases/:id/terminate', () => {
  it('sublessor terminates → reason prefix sublessor_terminated, notifies other 2 parties', async () => {
    const f = await seedFixture()
    const id = await seedActiveSublease(f)
    const res = await request(buildApp())
      .patch(`/api/subleases/${id}/terminate`)
      .set('Authorization', `Bearer ${f.sublessorToken}`)
      .send({ reason: 'Moving back early' })
    expect(res.status).toBe(200)
    expect(res.body.data.status).toBe('terminated')
    expect(res.body.data.terminated_reason).toBe('sublessor_terminated: Moving back early')
    // Two notifications (sublessee + landlord), trigger party skipped
    expect(notifySubleaseTerminatedMock).toHaveBeenCalledTimes(2)
    const ev = (appendEventMock.mock.calls[0] as unknown as any[])[0]
    expect(ev.eventType).toBe('sublease_terminated_early')
    expect(ev.eventData.triggered_by).toBe('sublessor_terminated')
  })

  it('sublessee terminates → reason prefix sublessee_terminated', async () => {
    const f = await seedFixture()
    const id = await seedActiveSublease(f)
    const res = await request(buildApp())
      .patch(`/api/subleases/${id}/terminate`)
      .set('Authorization', `Bearer ${f.sublesseeToken}`)
      .send({ reason: 'Lost job' })
    expect(res.status).toBe(200)
    expect(res.body.data.terminated_reason).toBe('sublessee_terminated: Lost job')
  })

  it('landlord terminates → reason prefix landlord_terminated', async () => {
    const f = await seedFixture()
    const id = await seedActiveSublease(f)
    const res = await request(buildApp())
      .patch(`/api/subleases/${id}/terminate`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ reason: 'Lease violation' })
    expect(res.status).toBe(200)
    expect(res.body.data.terminated_reason).toBe('landlord_terminated: Lease violation')
  })

  it('already-terminated → 409', async () => {
    const f = await seedFixture()
    const sl = await db.query<{ id: string }>(
      `INSERT INTO subleases (master_lease_id, sublessor_tenant_id, sublessee_tenant_id,
                              status, terminated_at, start_date, sub_monthly_amount, master_share_amount)
       VALUES ($1, $2, $3, 'terminated', NOW(), '2026-07-01', 1200, 1200) RETURNING id`,
      [f.leaseId, f.sublessorTenantId, f.sublesseeTenantId],
    )
    const res = await request(buildApp())
      .patch(`/api/subleases/${sl.rows[0].id}/terminate`)
      .set('Authorization', `Bearer ${f.sublessorToken}`)
      .send({ reason: 'oops' })
    expect(res.status).toBe(409)
  })

  it('non-party (unrelated tenant) rejected', async () => {
    const f = await seedFixture()
    const id = await seedActiveSublease(f)
    const client = await db.connect()
    let outsiderToken = ''
    try {
      await client.query('BEGIN')
      const otherTenantId = await seedTenant(client, { email: `outsider-${randomUUID()}@test.dev` })
      const tu = await client.query<{ user_id: string }>(`SELECT user_id FROM tenants WHERE id = $1`, [otherTenantId])
      await client.query('COMMIT')
      outsiderToken = jwt.sign(
        { userId: tu.rows[0].user_id, role: 'tenant', email: 'out@test.dev', profileId: otherTenantId, permissions: {} },
        process.env.JWT_SECRET!, { expiresIn: '1h' },
      )
    } finally { client.release() }
    const res = await request(buildApp())
      .patch(`/api/subleases/${id}/terminate`)
      .set('Authorization', `Bearer ${outsiderToken}`)
      .send({ reason: 'shouldnt' })
    expect(res.status).toBe(403)
  })

  it('rejects empty reason (zod min 1)', async () => {
    const f = await seedFixture()
    const id = await seedActiveSublease(f)
    const res = await request(buildApp())
      .patch(`/api/subleases/${id}/terminate`)
      .set('Authorization', `Bearer ${f.sublessorToken}`)
      .send({ reason: '' })
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(res.status).toBeLessThan(500)
  })
})

// ─── GET /subleases — list scoping ───────────────────────────────

describe('GET /subleases — list scoping', () => {
  it('tenant sees subleases where they are sublessor OR sublessee', async () => {
    const f = await seedFixture()
    await seedActiveSublease(f)
    const res = await request(buildApp())
      .get('/api/subleases')
      .set('Authorization', `Bearer ${f.sublessorToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(1)
    const res2 = await request(buildApp())
      .get('/api/subleases')
      .set('Authorization', `Bearer ${f.sublesseeToken}`)
    expect(res2.body.data).toHaveLength(1)
  })

  it('landlord sees own subleases', async () => {
    const f = await seedFixture()
    await seedActiveSublease(f)
    const res = await request(buildApp())
      .get('/api/subleases')
      .set('Authorization', `Bearer ${f.landlordToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(1)
  })

  it('landlord list excludes pending_invite subleases', async () => {
    const f = await seedFixture()
    // Seed one active + one pending_invite
    await seedActiveSublease(f)
    await db.query(
      `INSERT INTO subleases (master_lease_id, sublessor_tenant_id,
                              status, start_date, sub_monthly_amount, master_share_amount)
       VALUES ($1, $2, 'pending_invite', '2026-08-01', 1100, 1100)`,
      [f.leaseId, f.sublessorTenantId],
    )
    const res = await request(buildApp())
      .get('/api/subleases')
      .set('Authorization', `Bearer ${f.landlordToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(1)
    expect((res.body.data as any[])[0].status).toBe('active')
  })

  it('cross-landlord sees empty', async () => {
    const f = await seedFixture()
    await seedActiveSublease(f)
    const otherToken = jwt.sign(
      { userId: randomUUID(), role: 'landlord', email: 'o@test.dev', profileId: randomUUID(), permissions: {} },
      process.env.JWT_SECRET!, { expiresIn: '1h' },
    )
    const res = await request(buildApp())
      .get('/api/subleases')
      .set('Authorization', `Bearer ${otherToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data).toEqual([])
  })

  it('unknown role (bookkeeper) gets empty list', async () => {
    const f = await seedFixture()
    await seedActiveSublease(f)
    const bkToken = jwt.sign(
      { userId: randomUUID(), role: 'bookkeeper', email: 'bk@test.dev', profileId: randomUUID(), permissions: {} },
      process.env.JWT_SECRET!, { expiresIn: '1h' },
    )
    const res = await request(buildApp())
      .get('/api/subleases')
      .set('Authorization', `Bearer ${bkToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data).toEqual([])
  })
})

// ─── GET /subleases/:id — detail scope ──────────────────────────

describe('GET /subleases/:id', () => {
  it('sublessor can read', async () => {
    const f = await seedFixture()
    const id = await seedActiveSublease(f)
    const res = await request(buildApp())
      .get(`/api/subleases/${id}`)
      .set('Authorization', `Bearer ${f.sublessorToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data.id).toBe(id)
  })

  it('sublessee can read', async () => {
    const f = await seedFixture()
    const id = await seedActiveSublease(f)
    const res = await request(buildApp())
      .get(`/api/subleases/${id}`)
      .set('Authorization', `Bearer ${f.sublesseeToken}`)
    expect(res.status).toBe(200)
  })

  it('landlord on master lease can read', async () => {
    const f = await seedFixture()
    const id = await seedActiveSublease(f)
    const res = await request(buildApp())
      .get(`/api/subleases/${id}`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
    expect(res.status).toBe(200)
  })

  it('outsider (unrelated tenant) rejected', async () => {
    const f = await seedFixture()
    const id = await seedActiveSublease(f)
    const client = await db.connect()
    let outsiderToken = ''
    try {
      await client.query('BEGIN')
      const t = await seedTenant(client, { email: `o-${randomUUID()}@test.dev` })
      const tu = await client.query<{ user_id: string }>(`SELECT user_id FROM tenants WHERE id = $1`, [t])
      await client.query('COMMIT')
      outsiderToken = jwt.sign(
        { userId: tu.rows[0].user_id, role: 'tenant', email: 'o@test.dev', profileId: t, permissions: {} },
        process.env.JWT_SECRET!, { expiresIn: '1h' },
      )
    } finally { client.release() }
    const res = await request(buildApp())
      .get(`/api/subleases/${id}`)
      .set('Authorization', `Bearer ${outsiderToken}`)
    expect(res.status).toBe(403)
  })

  it('cross-landlord rejected', async () => {
    const f = await seedFixture()
    const id = await seedActiveSublease(f)
    const otherToken = jwt.sign(
      { userId: randomUUID(), role: 'landlord', email: 'o@test.dev', profileId: randomUUID(), permissions: {} },
      process.env.JWT_SECRET!, { expiresIn: '1h' },
    )
    const res = await request(buildApp())
      .get(`/api/subleases/${id}`)
      .set('Authorization', `Bearer ${otherToken}`)
    expect(res.status).toBe(403)
  })

  it('404 for unknown id', async () => {
    const f = await seedFixture()
    const res = await request(buildApp())
      .get(`/api/subleases/${randomUUID()}`)
      .set('Authorization', `Bearer ${f.sublessorToken}`)
    expect(res.status).toBe(404)
  })
})
