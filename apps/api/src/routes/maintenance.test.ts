/**
 * Maintenance route — launch-critical work-order flow.
 *
 * Surfaces under test:
 *   - POST   /maintenance               create (tenant or landlord)
 *   - GET    /maintenance               role-scoped list
 *   - GET    /maintenance/:id           scoped detail + comments
 *   - PATCH  /maintenance/:id           update + auto-approval threshold gate
 *   - POST   /maintenance/:id/approve   landlord lifts awaiting_approval
 *   - POST   /maintenance/:id/comments  tenant-on-own / staff scoped
 *
 * The high-leverage path is the PATCH auto-approval gate: when an
 * estimated cost is set above the landlord's
 * `maint_approval_threshold` (default $500) and the caller didn't
 * explicitly pick a status, the request flips to
 * `awaiting_approval`. Below threshold leaves status alone; explicit
 * status in body overrides the auto-flip; same-value estimate is a
 * no-op. The approve endpoint is the only way out of that state.
 *
 * Notification side-effects are mocked — the route catches errors
 * from these calls anyway, but mocking keeps the suite fast and
 * avoids Resend chatter.
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

// Mock notification side-effects so tests don't depend on Resend / SMS.
const { routeMaintenanceNotificationMock, notifyMaintenanceUpdatedMock } = vi.hoisted(() => ({
  routeMaintenanceNotificationMock: vi.fn(async () => {}),
  notifyMaintenanceUpdatedMock:     vi.fn(async () => {}),
}))
vi.mock('../services/notifications', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    routeMaintenanceNotification: routeMaintenanceNotificationMock,
    notifyMaintenanceUpdated:     notifyMaintenanceUpdatedMock,
  }
})

// Mock credit-ledger emitters — the route's completed-status branch
// fires these inside a try/catch but actual emission needs the
// credit_score_formulas seed and adds noise.
const { emitMaintenanceResolvedEventsMock } = vi.hoisted(() => ({
  emitMaintenanceResolvedEventsMock: vi.fn(async () => {}),
}))
vi.mock('../services/creditLedgerEmitters', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    emitMaintenanceResolvedEvents: emitMaintenanceResolvedEventsMock,
  }
})

import { maintenanceRouter } from './maintenance'
import { errorHandler } from '../middleware/errorHandler'

function buildApp() {
  const app = express()
  app.use(express.json({ limit: '2mb' }))
  app.use('/api/maintenance', maintenanceRouter)
  app.use(errorHandler)
  return app
}

beforeEach(async () => {
  await cleanupAllSchema()
  routeMaintenanceNotificationMock.mockClear()
  notifyMaintenanceUpdatedMock.mockClear()
  emitMaintenanceResolvedEventsMock.mockClear()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_maintenance'
})

interface SeedFixture {
  landlordUserId: string
  landlordId:     string
  tenantUserId:   string
  tenantId:       string
  unitId:         string
  propertyId:     string
  landlordToken:  string
  tenantToken:    string
}

async function seedFixture(overrides: { threshold?: number } = {}): Promise<SeedFixture> {
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    const { userId: landlordUserId, landlordId } = await seedLandlord(client)
    if (overrides.threshold !== undefined) {
      await client.query(
        `UPDATE landlords SET maint_approval_threshold = $1 WHERE id = $2`,
        [overrides.threshold, landlordId],
      )
    }
    const tenantId = await seedTenant(client)
    const tu = await client.query<{ user_id: string }>(
      `SELECT user_id FROM tenants WHERE id = $1`, [tenantId],
    )
    const tenantUserId = tu.rows[0].user_id

    const propertyId = await seedProperty(client, { landlordId, ownerUserId: landlordUserId, managedByUserId: landlordUserId })
    const unitId     = await seedUnit(client, { propertyId, landlordId })

    const leaseId = await seedLease(client, { unitId, landlordId })
    await seedLeaseTenant(client, { leaseId, tenantId })

    await client.query('COMMIT')

    const landlordToken = jwt.sign(
      { userId: landlordUserId, role: 'landlord', email: 'll@test.dev', profileId: landlordId, permissions: {} },
      process.env.JWT_SECRET!,
      { expiresIn: '1h' },
    )
    const tenantToken = jwt.sign(
      { userId: tenantUserId, role: 'tenant', email: 't@test.dev', profileId: tenantId, permissions: {} },
      process.env.JWT_SECRET!,
      { expiresIn: '1h' },
    )

    return { landlordUserId, landlordId, tenantUserId, tenantId, unitId, propertyId, landlordToken, tenantToken }
  } catch (e) {
    await client.query('ROLLBACK')
    throw e
  } finally {
    client.release()
  }
}

async function seedExtraTenantOnUnit(unitId: string, landlordId: string): Promise<{ tenantId: string; tenantUserId: string; tenantToken: string }> {
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    const tenantId = await seedTenant(client)
    const tu = await client.query<{ user_id: string }>(
      `SELECT user_id FROM tenants WHERE id = $1`, [tenantId],
    )
    const tenantUserId = tu.rows[0].user_id
    const leaseId = await seedLease(client, { unitId, landlordId })
    await seedLeaseTenant(client, { leaseId, tenantId })
    await client.query('COMMIT')
    const tenantToken = jwt.sign(
      { userId: tenantUserId, role: 'tenant', email: 'other@test.dev', profileId: tenantId, permissions: {} },
      process.env.JWT_SECRET!, { expiresIn: '1h' },
    )
    return { tenantId, tenantUserId, tenantToken }
  } finally {
    client.release()
  }
}

async function createBaseRequest(f: SeedFixture, override: Partial<{ status: string; estimatedCost: number; contractorId: string | null }> = {}): Promise<string> {
  const res = await db.query<{ id: string }>(
    `INSERT INTO maintenance_requests
       (unit_id, tenant_id, landlord_id, title, description, priority, status, estimated_cost, contractor_id)
     VALUES ($1, $2, $3, 'Leak', 'Pipe under sink', 'normal', $4, $5, $6)
     RETURNING id`,
    [f.unitId, f.tenantId, f.landlordId,
     override.status ?? 'open',
     override.estimatedCost ?? null,
     override.contractorId ?? null],
  )
  return res.rows[0].id
}

// ─── POST /maintenance — create ────────────────────────────────────

describe('POST /maintenance', () => {
  it('tenant on the active lease can create a request for their unit', async () => {
    const f = await seedFixture()
    const res = await request(buildApp())
      .post('/api/maintenance')
      .set('Authorization', `Bearer ${f.tenantToken}`)
      .send({ unitId: f.unitId, title: 'Leak', description: 'Sink leaking', priority: 'normal' })
    expect(res.status).toBe(201)
    expect(res.body.data.unit_id).toBe(f.unitId)
    expect(res.body.data.tenant_id).toBe(f.tenantId)
    expect(res.body.data.landlord_id).toBe(f.landlordId)
    expect(res.body.data.status).toBe('open')
    expect(routeMaintenanceNotificationMock).toHaveBeenCalledTimes(1)
  })

  it('tenant rejected when not on the unit', async () => {
    const f = await seedFixture()
    // Create a SECOND landlord + unit; tenant from f is not on it.
    const client = await db.connect()
    let otherUnitId = ''
    try {
      await client.query('BEGIN')
      const { userId: otherUserId, landlordId: otherLandlordId } = await seedLandlord(client, { email: 'll2@test.dev' })
      const otherProp = await seedProperty(client, { landlordId: otherLandlordId, ownerUserId: otherUserId, managedByUserId: otherUserId })
      otherUnitId = await seedUnit(client, { propertyId: otherProp, landlordId: otherLandlordId })
      await client.query('COMMIT')
    } finally { client.release() }
    const res = await request(buildApp())
      .post('/api/maintenance')
      .set('Authorization', `Bearer ${f.tenantToken}`)
      .send({ unitId: otherUnitId, title: 'Leak', description: 'Sink leaking', priority: 'normal' })
    expect(res.status).toBe(403)
  })

  it('landlord can create on their own unit — tenantId resolves to primary tenant on the unit', async () => {
    const f = await seedFixture()
    const res = await request(buildApp())
      .post('/api/maintenance')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ unitId: f.unitId, title: 'Outlet broken', description: 'Outlet in kitchen', priority: 'high' })
    expect(res.status).toBe(201)
    // Landlord-filed request gets attributed to the primary tenant on the unit.
    expect(res.body.data.tenant_id).toBe(f.tenantId)
    expect(res.body.data.priority).toBe('high')
  })

  it('rejects malformed body (zod) — missing title', async () => {
    const f = await seedFixture()
    const res = await request(buildApp())
      .post('/api/maintenance')
      .set('Authorization', `Bearer ${f.tenantToken}`)
      .send({ unitId: f.unitId, description: 'no title here' })
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(res.status).toBeLessThan(500)
  })

  it('rejects invalid priority enum', async () => {
    const f = await seedFixture()
    const res = await request(buildApp())
      .post('/api/maintenance')
      .set('Authorization', `Bearer ${f.tenantToken}`)
      .send({ unitId: f.unitId, title: 'X', description: 'Yyyy', priority: 'urgent' })
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(res.status).toBeLessThan(500)
  })
})

// ─── PATCH /maintenance/:id — auto-approval threshold gate ──────────

describe('PATCH /maintenance/:id — auto-approval threshold gate', () => {
  it('estimate BELOW landlord threshold does not change status', async () => {
    const f = await seedFixture({ threshold: 500 })
    const id = await createBaseRequest(f, { status: 'open' })
    const res = await request(buildApp())
      .patch(`/api/maintenance/${id}`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ estimatedCost: 250 })
    expect(res.status).toBe(200)
    expect(res.body.data.status).toBe('open')
    expect(Number(res.body.data.estimated_cost)).toBe(250)
  })

  it('estimate ABOVE default $500 threshold flips to awaiting_approval', async () => {
    // Don't set threshold override — leans on the default 500.
    const f = await seedFixture()
    const id = await createBaseRequest(f, { status: 'open' })
    const res = await request(buildApp())
      .patch(`/api/maintenance/${id}`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ estimatedCost: 750 })
    expect(res.status).toBe(200)
    expect(res.body.data.status).toBe('awaiting_approval')
  })

  it('respects a landlord-configured threshold higher than default', async () => {
    const f = await seedFixture({ threshold: 2000 })
    const id = await createBaseRequest(f, { status: 'open' })
    const res = await request(buildApp())
      .patch(`/api/maintenance/${id}`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ estimatedCost: 1500 })
    expect(res.status).toBe(200)
    // 1500 < 2000 → stays open
    expect(res.body.data.status).toBe('open')
  })

  it('explicit status in body wins over auto-flip', async () => {
    const f = await seedFixture({ threshold: 500 })
    const id = await createBaseRequest(f, { status: 'open' })
    const res = await request(buildApp())
      .patch(`/api/maintenance/${id}`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ estimatedCost: 1000, status: 'in_progress' })
    expect(res.status).toBe(200)
    expect(res.body.data.status).toBe('in_progress')
  })

  it('same estimate (no change) does not flip even above threshold', async () => {
    const f = await seedFixture({ threshold: 500 })
    // Seed an already-estimated request at $1000.
    const id = await createBaseRequest(f, { status: 'in_progress', estimatedCost: 1000 })
    const res = await request(buildApp())
      .patch(`/api/maintenance/${id}`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ estimatedCost: 1000, landlordNotes: 'still working on it' })
    expect(res.status).toBe(200)
    expect(res.body.data.status).toBe('in_progress')  // no flip
  })

  it('already in awaiting_approval does not re-flip on another estimate change', async () => {
    const f = await seedFixture({ threshold: 500 })
    const id = await createBaseRequest(f, { status: 'awaiting_approval', estimatedCost: 800 })
    const res = await request(buildApp())
      .patch(`/api/maintenance/${id}`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ estimatedCost: 1200 })
    expect(res.status).toBe(200)
    // Still awaiting_approval — request was already there; this is just an estimate revision.
    expect(res.body.data.status).toBe('awaiting_approval')
  })

  it('completing a request fires the credit-ledger emitter', async () => {
    const f = await seedFixture()
    const id = await createBaseRequest(f, { status: 'in_progress' })
    const res = await request(buildApp())
      .patch(`/api/maintenance/${id}`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ status: 'completed', actualCost: 350 })
    expect(res.status).toBe(200)
    expect(res.body.data.status).toBe('completed')
    expect(res.body.data.completed_at).toBeTruthy()
    expect(emitMaintenanceResolvedEventsMock).toHaveBeenCalledTimes(1)
  })

  it('writes the platform-fee column off actualCost', async () => {
    const f = await seedFixture()
    const id = await createBaseRequest(f, { status: 'in_progress' })
    const res = await request(buildApp())
      .patch(`/api/maintenance/${id}`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ status: 'completed', actualCost: 500 })
    expect(res.status).toBe(200)
    expect(Number(res.body.data.platform_fee)).toBeGreaterThan(0)
  })

  it('rejects when caller is from another landlord', async () => {
    const f = await seedFixture()
    const id = await createBaseRequest(f, { status: 'open' })
    // Token for an unrelated landlord
    const otherLandlordToken = jwt.sign(
      { userId: randomUUID(), role: 'landlord', email: 'other@test.dev', profileId: randomUUID(), permissions: {} },
      process.env.JWT_SECRET!, { expiresIn: '1h' },
    )
    const res = await request(buildApp())
      .patch(`/api/maintenance/${id}`)
      .set('Authorization', `Bearer ${otherLandlordToken}`)
      .send({ estimatedCost: 100 })
    expect(res.status).toBe(403)
  })
})

// ─── POST /maintenance/:id/approve ──────────────────────────────────

describe('POST /maintenance/:id/approve', () => {
  it('flips awaiting_approval → assigned when a contractor is already set', async () => {
    const f = await seedFixture()
    // S444: maintenance_requests.contractor_id FKs users(id), not the
    // contractors directory — assignment hands the request to one of the
    // landlord's own maintenance workers (per the 20260609130000 migration).
    const workerRes = await db.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
       VALUES ($1, 'x', 'maintenance', 'Mtc', 'Worker', TRUE) RETURNING id`,
      [`mtc-${randomUUID()}@test.dev`],
    )
    const id = await createBaseRequest(f, { status: 'awaiting_approval', estimatedCost: 800, contractorId: workerRes.rows[0].id })
    const res = await request(buildApp())
      .post(`/api/maintenance/${id}/approve`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({})
    expect(res.status).toBe(200)
    expect(res.body.data.status).toBe('assigned')
    expect(res.body.data.assigned_at).toBeTruthy()
  })

  it('flips awaiting_approval → open when no contractor set', async () => {
    const f = await seedFixture()
    const id = await createBaseRequest(f, { status: 'awaiting_approval', estimatedCost: 800 })
    const res = await request(buildApp())
      .post(`/api/maintenance/${id}/approve`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({})
    expect(res.status).toBe(200)
    expect(res.body.data.status).toBe('open')
  })

  it('rejects when request is not in awaiting_approval', async () => {
    const f = await seedFixture()
    const id = await createBaseRequest(f, { status: 'open' })
    const res = await request(buildApp())
      .post(`/api/maintenance/${id}/approve`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({})
    expect(res.status).toBe(400)
  })

  it('rejects when caller is from another landlord', async () => {
    const f = await seedFixture()
    const id = await createBaseRequest(f, { status: 'awaiting_approval', estimatedCost: 800 })
    const otherLandlordToken = jwt.sign(
      { userId: randomUUID(), role: 'landlord', email: 'other@test.dev', profileId: randomUUID(), permissions: {} },
      process.env.JWT_SECRET!, { expiresIn: '1h' },
    )
    const res = await request(buildApp())
      .post(`/api/maintenance/${id}/approve`)
      .set('Authorization', `Bearer ${otherLandlordToken}`)
      .send({})
    expect(res.status).toBe(403)
  })
})

// ─── GET /maintenance/:id — scope check ────────────────────────────

describe('GET /maintenance/:id — scope check', () => {
  it('tenant can read their own request', async () => {
    const f = await seedFixture()
    const id = await createBaseRequest(f)
    const res = await request(buildApp())
      .get(`/api/maintenance/${id}`)
      .set('Authorization', `Bearer ${f.tenantToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data.id).toBe(id)
  })

  it('tenant rejected from another tenant request', async () => {
    const f = await seedFixture()
    const id = await createBaseRequest(f)
    // Add a second tenant on the unit (co-tenant), seed a request owned by f.tenantId,
    // then a different tenant tries to read it.
    const other = await seedExtraTenantOnUnit(f.unitId, f.landlordId)
    const res = await request(buildApp())
      .get(`/api/maintenance/${id}`)
      .set('Authorization', `Bearer ${other.tenantToken}`)
    expect(res.status).toBe(403)
  })

  it('landlord can read requests on their own unit', async () => {
    const f = await seedFixture()
    const id = await createBaseRequest(f)
    const res = await request(buildApp())
      .get(`/api/maintenance/${id}`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
    expect(res.status).toBe(200)
  })

  it('unrelated landlord cannot read', async () => {
    const f = await seedFixture()
    const id = await createBaseRequest(f)
    const otherLandlordToken = jwt.sign(
      { userId: randomUUID(), role: 'landlord', email: 'other@test.dev', profileId: randomUUID(), permissions: {} },
      process.env.JWT_SECRET!, { expiresIn: '1h' },
    )
    const res = await request(buildApp())
      .get(`/api/maintenance/${id}`)
      .set('Authorization', `Bearer ${otherLandlordToken}`)
    expect(res.status).toBe(403)
  })

  it('tenant detail call strips internal comments', async () => {
    const f = await seedFixture()
    const id = await createBaseRequest(f)
    // Add one tenant-visible and one internal comment.
    await db.query(
      `INSERT INTO maintenance_comments (request_id, user_id, role, message, is_internal)
       VALUES ($1, $2, 'landlord', 'External update', FALSE),
              ($1, $2, 'landlord', 'Internal note',   TRUE)`,
      [id, f.landlordUserId],
    )
    const res = await request(buildApp())
      .get(`/api/maintenance/${id}`)
      .set('Authorization', `Bearer ${f.tenantToken}`)
    expect(res.status).toBe(200)
    const msgs = (res.body.data.comments as any[]).map(c => c.message)
    expect(msgs).toContain('External update')
    expect(msgs).not.toContain('Internal note')
  })
})

// ─── GET /maintenance — list scoping ───────────────────────────────

describe('GET /maintenance — list scoping', () => {
  it('tenant sees only their own requests', async () => {
    const f = await seedFixture()
    const ownId = await createBaseRequest(f)
    // Seed an unrelated tenant's request on the same landlord/unit; same
    // unit but different tenant_id should NOT come back to f.tenantId.
    const other = await seedExtraTenantOnUnit(f.unitId, f.landlordId)
    await db.query(
      `INSERT INTO maintenance_requests
         (unit_id, tenant_id, landlord_id, title, description, priority, status)
       VALUES ($1, $2, $3, 'Other', 'Other body', 'normal', 'open')`,
      [f.unitId, other.tenantId, f.landlordId],
    )
    const res = await request(buildApp())
      .get('/api/maintenance')
      .set('Authorization', `Bearer ${f.tenantToken}`)
    expect(res.status).toBe(200)
    const ids = (res.body.data as any[]).map(r => r.id)
    expect(ids).toContain(ownId)
    expect(ids).toHaveLength(1)
  })

  it('landlord sees all requests on their properties', async () => {
    const f = await seedFixture()
    await createBaseRequest(f)
    await createBaseRequest(f)
    const res = await request(buildApp())
      .get('/api/maintenance')
      .set('Authorization', `Bearer ${f.landlordToken}`)
    expect(res.status).toBe(200)
    expect((res.body.data as any[]).length).toBe(2)
  })

  it('unknown role gets empty list, not 500', async () => {
    const f = await seedFixture()
    await createBaseRequest(f)
    // bookkeeper hits the explicit-branches code path and falls through
    // to the "empty rather than leak" guard.
    const bkToken = jwt.sign(
      { userId: randomUUID(), role: 'bookkeeper', email: 'bk@test.dev', profileId: randomUUID(), permissions: {} },
      process.env.JWT_SECRET!, { expiresIn: '1h' },
    )
    const res = await request(buildApp())
      .get('/api/maintenance')
      .set('Authorization', `Bearer ${bkToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data).toEqual([])
  })
})

// ─── POST /maintenance/:id/comments ────────────────────────────────

describe('POST /maintenance/:id/comments', () => {
  it('tenant can comment on their own request', async () => {
    const f = await seedFixture()
    const id = await createBaseRequest(f)
    const res = await request(buildApp())
      .post(`/api/maintenance/${id}/comments`)
      .set('Authorization', `Bearer ${f.tenantToken}`)
      .send({ message: 'Any update?' })
    expect(res.status).toBe(200)
    expect(res.body.data.role).toBe('tenant')
    expect(res.body.data.is_internal).toBe(false)
  })

  it('tenant rejected from another tenant request', async () => {
    const f = await seedFixture()
    const id = await createBaseRequest(f)
    const other = await seedExtraTenantOnUnit(f.unitId, f.landlordId)
    const res = await request(buildApp())
      .post(`/api/maintenance/${id}/comments`)
      .set('Authorization', `Bearer ${other.tenantToken}`)
      .send({ message: 'shouldnt land' })
    expect(res.status).toBe(403)
  })

  it('tenant request for is_internal=true is force-overridden to false', async () => {
    const f = await seedFixture()
    const id = await createBaseRequest(f)
    const res = await request(buildApp())
      .post(`/api/maintenance/${id}/comments`)
      .set('Authorization', `Bearer ${f.tenantToken}`)
      .send({ message: 'sneaky internal', isInternal: true })
    expect(res.status).toBe(200)
    expect(res.body.data.is_internal).toBe(false)
  })

  it('landlord can comment and mark is_internal=true', async () => {
    const f = await seedFixture()
    const id = await createBaseRequest(f)
    const res = await request(buildApp())
      .post(`/api/maintenance/${id}/comments`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ message: 'Internal note for the team', isInternal: true })
    expect(res.status).toBe(200)
    expect(res.body.data.is_internal).toBe(true)
    expect(res.body.data.role).toBe('landlord')
  })

  it('rejects empty message', async () => {
    const f = await seedFixture()
    const id = await createBaseRequest(f)
    const res = await request(buildApp())
      .post(`/api/maintenance/${id}/comments`)
      .set('Authorization', `Bearer ${f.tenantToken}`)
      .send({ message: '   ' })
    expect(res.status).toBe(400)
  })
})
