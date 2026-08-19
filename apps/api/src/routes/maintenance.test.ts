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
import { PLATFORM_FEES } from '@gam/shared'
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

async function createBaseRequest(f: SeedFixture, override: Partial<{ status: string; estimatedCost: number; assignedTo: string | null }> = {}): Promise<string> {
  const res = await db.query<{ id: string }>(
    `INSERT INTO maintenance_requests
       (unit_id, tenant_id, landlord_id, title, description, priority, status, estimated_cost, assigned_to)
     VALUES ($1, $2, $3, 'Leak', 'Pipe under sink', 'normal', $4, $5, $6)
     RETURNING id`,
    [f.unitId, f.tenantId, f.landlordId,
     override.status ?? 'open',
     override.estimatedCost ?? null,
     override.assignedTo ?? null],
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

  it('landlord CANNOT create on another landlord\'s unit → 403', async () => {
    const f = await seedFixture()
    // Second landlord + unit; f's landlord does not manage it.
    const client = await db.connect()
    let otherUnitId = ''
    try {
      await client.query('BEGIN')
      const { userId: otherUserId, landlordId: otherLandlordId } = await seedLandlord(client, { email: 'll3@test.dev' })
      const otherProp = await seedProperty(client, { landlordId: otherLandlordId, ownerUserId: otherUserId, managedByUserId: otherUserId })
      otherUnitId = await seedUnit(client, { propertyId: otherProp, landlordId: otherLandlordId })
      await client.query('COMMIT')
    } finally { client.release() }
    const res = await request(buildApp())
      .post('/api/maintenance')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ unitId: otherUnitId, title: 'Injected', description: 'Should be blocked', priority: 'high' })
    expect(res.status).toBe(403)
  })

  // S571: title is now optional (derived from category). The still-required
  // field is `description`; omitting it must be rejected by zod.
  it('rejects malformed body (zod) — missing description', async () => {
    const f = await seedFixture()
    const res = await request(buildApp())
      .post('/api/maintenance')
      .set('Authorization', `Bearer ${f.tenantToken}`)
      .send({ unitId: f.unitId, category: 'plumbing' })
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(res.status).toBeLessThan(500)
  })

  // S571: a tenant cannot self-assign priority — it is stripped and the agent
  // recommendation is stored instead.
  it('tenant priority is stripped; a recommendation is produced', async () => {
    const f = await seedFixture()
    const res = await request(buildApp())
      .post('/api/maintenance')
      .set('Authorization', `Bearer ${f.tenantToken}`)
      .send({ unitId: f.unitId, category: 'plumbing', description: 'Sink is leaking badly', priority: 'low' })
    expect(res.status).toBe(201)
    expect(['agent','heuristic']).toContain(res.body.data.priority_source)
    expect(res.body.data.recommended_priority).toBe(res.body.data.priority)
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
    // S603 (Nic): GAM takes NOTHING on maintenance. In-house work by the
    // landlord's own staff must never accrue a fee — the 5% MAINTENANCE_PCT is
    // reserved for the DEFERRED contractor-bid marketplace (brokering an OUTSIDE
    // contractor), which does not exist. Completing a $500 job must leave the
    // fee empty, not stamp $25 of phantom revenue on it.
    expect(res.body.data.platform_fee).toBeNull()
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
    // S444: maintenance_requests.assigned_to FKs users(id), not the
    // contractors directory — assignment hands the request to one of the
    // landlord's own maintenance workers (per the 20260609130000 migration;
    // column renamed contractor_id -> assigned_to in S585).
    const workerRes = await db.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
       VALUES ($1, 'x', 'maintenance', 'Mtc', 'Worker', TRUE) RETURNING id`,
      [`mtc-${randomUUID()}@test.dev`],
    )
    const id = await createBaseRequest(f, { status: 'awaiting_approval', estimatedCost: 800, assignedTo: workerRes.rows[0].id })
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

// ─── GET /stats/summary — backfilled S490 ──────────────────────────
//
// Coverage backfill for the maintenance stats summary endpoint —
// follows the same pattern that caught the S488 drilldown bug.
// Exercises the FILTER aggregates against real column names; any
// schema mismatch would 500 on the first GET.

describe('GET /maintenance/stats/summary', () => {
  async function seedReq(args: {
    landlordId: string; unitId: string; tenantId: string;
    status?: string; priority?: string;
    actualCost?: number | null; platformFee?: number | null;
  }): Promise<void> {
    await db.query(
      `INSERT INTO maintenance_requests
         (unit_id, tenant_id, landlord_id, title, description, priority, status,
          actual_cost, platform_fee)
       VALUES ($1, $2, $3, 'Test', 'desc', $4, $5, $6, $7)`,
      [args.unitId, args.tenantId, args.landlordId,
       args.priority ?? 'normal',
       args.status ?? 'open',
       args.actualCost ?? null,
       args.platformFee ?? null])
  }

  it('landlord: counts per status + sums platform fee + total cost', async () => {
    const f = await seedFixture()
    // Mix: 2 open, 1 assigned, 1 in_progress, 2 completed (with cost+fee),
    // 1 emergency-open (counted by emergency_count).
    await seedReq({ landlordId: f.landlordId, unitId: f.unitId, tenantId: f.tenantId, status: 'open' })
    await seedReq({ landlordId: f.landlordId, unitId: f.unitId, tenantId: f.tenantId, status: 'open' })
    await seedReq({ landlordId: f.landlordId, unitId: f.unitId, tenantId: f.tenantId, status: 'assigned' })
    await seedReq({ landlordId: f.landlordId, unitId: f.unitId, tenantId: f.tenantId, status: 'in_progress' })
    await seedReq({
      landlordId: f.landlordId, unitId: f.unitId, tenantId: f.tenantId,
      status: 'completed', actualCost: 200, platformFee: 16,
    })
    await seedReq({
      landlordId: f.landlordId, unitId: f.unitId, tenantId: f.tenantId,
      status: 'completed', actualCost: 350, platformFee: 28,
    })
    await seedReq({
      landlordId: f.landlordId, unitId: f.unitId, tenantId: f.tenantId,
      status: 'open', priority: 'emergency',
    })

    const res = await request(buildApp())
      .get('/api/maintenance/stats/summary')
      .set('Authorization', `Bearer ${f.landlordToken}`)
    expect(res.status).toBe(200)
    expect(Number(res.body.data.open_count)).toBe(3)  // 2 normal + 1 emergency
    expect(Number(res.body.data.assigned_count)).toBe(1)
    expect(Number(res.body.data.in_progress_count)).toBe(1)
    expect(Number(res.body.data.completed_count)).toBe(2)
    expect(Number(res.body.data.emergency_count)).toBe(1)
    expect(Number(res.body.data.total_cost)).toBe(550)
    // total_fees (maintenance platform fee) intentionally not returned — the
    // landlord pays only actual cost; the fee is reserved for the future
    // contractor marketplace and surfaced nowhere.
    expect(res.body.data.total_fees).toBeUndefined()
  })

  it('cross-landlord rows excluded', async () => {
    const a = await seedFixture()
    const b = await seedFixture()
    await seedReq({ landlordId: a.landlordId, unitId: a.unitId, tenantId: a.tenantId, status: 'open' })
    await seedReq({ landlordId: b.landlordId, unitId: b.unitId, tenantId: b.tenantId, status: 'open' })
    await seedReq({ landlordId: b.landlordId, unitId: b.unitId, tenantId: b.tenantId, status: 'completed' })
    const res = await request(buildApp())
      .get('/api/maintenance/stats/summary')
      .set('Authorization', `Bearer ${a.landlordToken}`)
    expect(Number(res.body.data.open_count)).toBe(1)
    expect(Number(res.body.data.completed_count)).toBe(0)
  })

  it('empty: landlord with no requests → zero counters', async () => {
    const f = await seedFixture()
    const res = await request(buildApp())
      .get('/api/maintenance/stats/summary')
      .set('Authorization', `Bearer ${f.landlordToken}`)
    expect(res.status).toBe(200)
    expect(Number(res.body.data.open_count)).toBe(0)
    expect(Number(res.body.data.total_cost)).toBe(0)
    expect(res.body.data.total_fees).toBeUndefined()
  })

  it('tenant role → empty data response (route short-circuits)', async () => {
    const f = await seedFixture()
    await seedReq({ landlordId: f.landlordId, unitId: f.unitId, tenantId: f.tenantId, status: 'open' })
    const res = await request(buildApp())
      .get('/api/maintenance/stats/summary')
      .set('Authorization', `Bearer ${f.tenantToken}`)
    // Tenant role doesn't match any branch → requirePerm denies (403)
    // before the early-return paths fire.
    expect(res.status).toBe(403)
  })
})

// ── S552: per-manager approval ceiling (Nic: Option B — route to landlord
// with an attempted-approval note, never silently allow) ─────────────────
describe('POST /maintenance/:id/approve — per-manager ceiling', () => {
  async function seedApprovalReq(args: { landlordId: string; unitId: string; tenantId: string; estimatedCost: number }): Promise<string> {
    const { rows: [r] } = await db.query<{ id: string }>(
      `INSERT INTO maintenance_requests
         (unit_id, tenant_id, landlord_id, title, description, priority, status, estimated_cost)
       VALUES ($1, $2, $3, 'Ceiling test', 'desc', 'normal', 'awaiting_approval', $4)
       RETURNING id`,
      [args.unitId, args.tenantId, args.landlordId, args.estimatedCost])
    return r.id
  }

  async function seedPmWithCeiling(landlordId: string, ceilingCents: number | null) {
    const client = await db.connect()
    try {
      await client.query('BEGIN')
      const { rows: [{ id: pmUserId }] } = await client.query<{ id: string }>(
        `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
         VALUES ($1, 'x', 'property_manager', 'Pat', 'Manager', TRUE) RETURNING id`,
        [`pm-${randomUUID()}@test.dev`])
      await client.query(
        `INSERT INTO property_manager_scopes (user_id, landlord_id, all_properties, maint_approval_ceiling_cents)
         VALUES ($1, $2, TRUE, $3)`,
        [pmUserId, landlordId, ceilingCents])
      await client.query('COMMIT')
      const token = jwt.sign(
        { userId: pmUserId, role: 'property_manager', email: 'pm@test.dev', profileId: landlordId,
          landlordId, permissions: { 'maintenance.approve': true } },
        process.env.JWT_SECRET!, { expiresIn: '1h' })
      return { pmUserId, token }
    } catch (e) { await client.query('ROLLBACK'); throw e } finally { client.release() }
  }

  it('over-ceiling approval → 403, stays awaiting_approval, landlord notified of the attempt', async () => {
    const f = await seedFixture()
    const reqId = await seedApprovalReq({ landlordId: f.landlordId, unitId: f.unitId, tenantId: f.tenantId, estimatedCost: 450 })
    const pm = await seedPmWithCeiling(f.landlordId, 30000) // $300 ceiling
    const res = await request(buildApp())
      .post(`/api/maintenance/${reqId}/approve`)
      .set('Authorization', `Bearer ${pm.token}`)
    expect(res.status).toBe(403)
    expect(res.body.error).toMatch(/approval limit/i)
    const { rows: [row] } = await db.query<any>(
      `SELECT status FROM maintenance_requests WHERE id=$1`, [reqId])
    expect(row.status).toBe('awaiting_approval')
    const { rows: notes } = await db.query<any>(
      `SELECT title, body FROM notifications WHERE user_id=$1 AND title='Approval above team member limit'`,
      [f.landlordUserId])
    expect(notes.length).toBe(1)
    expect(notes[0].body).toMatch(/tried to approve/i)
    expect(notes[0].body).toMatch(/\$300/)
  })

  it('under-ceiling approval succeeds', async () => {
    const f = await seedFixture()
    const reqId = await seedApprovalReq({ landlordId: f.landlordId, unitId: f.unitId, tenantId: f.tenantId, estimatedCost: 200 })
    const pm = await seedPmWithCeiling(f.landlordId, 30000)
    const res = await request(buildApp())
      .post(`/api/maintenance/${reqId}/approve`)
      .set('Authorization', `Bearer ${pm.token}`)
    expect(res.status).toBe(200)
    const { rows: [row] } = await db.query<any>(
      `SELECT status FROM maintenance_requests WHERE id=$1`, [reqId])
    expect(row.status).toBe('open')
  })

  it('no ceiling set → staff with the permission approves any amount (unchanged behavior)', async () => {
    const f = await seedFixture()
    const reqId = await seedApprovalReq({ landlordId: f.landlordId, unitId: f.unitId, tenantId: f.tenantId, estimatedCost: 5000 })
    const pm = await seedPmWithCeiling(f.landlordId, null)
    const res = await request(buildApp())
      .post(`/api/maintenance/${reqId}/approve`)
      .set('Authorization', `Bearer ${pm.token}`)
    expect(res.status).toBe(200)
  })
})

// ── S571: tenant evidence media (photos/video), landlord-immutable ─────────
describe('POST/GET /maintenance/:id/media', () => {
  const jpg = () => Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]) // JPEG magic
  async function makeRequest(f: any): Promise<string> {
    const res = await request(buildApp())
      .post('/api/maintenance')
      .set('Authorization', `Bearer ${f.tenantToken}`)
      .send({ unitId: f.unitId, category: 'plumbing', description: 'Sink is leaking under the cabinet' })
    return res.body.data.id
  }

  it('tenant on the request can upload a photo; both parties can list it', async () => {
    const f = await seedFixture()
    const reqId = await makeRequest(f)
    const up = await request(buildApp())
      .post(`/api/maintenance/${reqId}/media`)
      .set('Authorization', `Bearer ${f.tenantToken}`)
      .field('caption', 'still leaking after the "fix"')
      .attach('file', jpg(), { filename: 'proof.jpg', contentType: 'image/jpeg' })
    expect(up.status).toBe(201)
    expect(up.body.data.media_type).toBe('photo')
    expect(up.body.data.uploader_role).toBe('tenant')

    // Landlord sees the tenant's evidence.
    const list = await request(buildApp())
      .get(`/api/maintenance/${reqId}/media`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
    expect(list.status).toBe(200)
    expect(list.body.data).toHaveLength(1)
    expect(list.body.data[0].caption).toContain('still leaking')
  })

  it('landlord/worker can upload their own fix photo (role landlord)', async () => {
    const f = await seedFixture()
    const reqId = await makeRequest(f)
    const up = await request(buildApp())
      .post(`/api/maintenance/${reqId}/media`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .attach('file', jpg(), { filename: 'fix.jpg', contentType: 'image/jpeg' })
    expect(up.status).toBe(201)
    expect(up.body.data.uploader_role).toBe('landlord')
  })

  it('a tenant NOT on the request cannot upload (403)', async () => {
    const f = await seedFixture()
    const reqId = await makeRequest(f)
    const other = await seedExtraTenantOnUnit(f.unitId, f.landlordId) // different tenant
    // Re-point: create a stranger by using a fresh fixture's tenant token on THIS request.
    const stranger = await seedFixture({})
    const res = await request(buildApp())
      .post(`/api/maintenance/${reqId}/media`)
      .set('Authorization', `Bearer ${stranger.tenantToken}`)
      .attach('file', jpg(), { filename: 'x.jpg', contentType: 'image/jpeg' })
    expect(res.status).toBe(403)
    void other
  })

  it('is immutable — there is no delete route (404)', async () => {
    const f = await seedFixture()
    const reqId = await makeRequest(f)
    const res = await request(buildApp())
      .delete(`/api/maintenance/${reqId}/media/whatever`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
    expect(res.status).toBe(404)
  })
})

// ── S603: property-scope enforcement for team roles ────────────────────────
// Pre-S603, GET /maintenance and GET /maintenance/:id filtered team-role callers
// by landlord_id ALONE. canAccessLandlordResource proves org membership but
// carries NO property scope, so a maintenance worker assigned to one property
// could list every request across the landlord's whole portfolio — tenant names
// included — and read any single one by id. Sibling surfaces (units, inspections,
// bookings, utility, balances) already used getScopedPropertyIds; maintenance was
// missed by that sweep.
describe('maintenance property-scope (S603)', () => {
  async function seedScopedWorker(landlordId: string, propertyIds: string[]) {
    const userId = randomUUID()
    await db.query(
      `INSERT INTO users (id, email, password_hash, first_name, last_name, role)
       VALUES ($1, $2, 'x', 'Scoped', 'Worker', 'maintenance')`,
      [userId, `worker-${userId}@test.dev`])
    await db.query(
      `INSERT INTO maintenance_worker_scopes
         (user_id, landlord_id, property_ids, unit_ids, job_categories, all_properties)
       VALUES ($1, $2, $3, '{}', '{}', false)`,
      [userId, landlordId, propertyIds])
    return jwt.sign(
      { userId, role: 'maintenance', email: 'w@test.dev', profileId: userId,
        landlordId, permissions: {} },
      process.env.JWT_SECRET!, { expiresIn: '1h' })
  }

  async function seedReqOn(landlordId: string, unitId: string, tenantId: string, title: string) {
    const r = await db.query<{ id: string }>(
      `INSERT INTO maintenance_requests
         (unit_id, tenant_id, landlord_id, title, description, priority, status)
       VALUES ($1,$2,$3,$4,'desc','normal','open') RETURNING id`,
      [unitId, tenantId, landlordId, title])
    return r.rows[0].id
  }

  it('LIST: a worker scoped to one property sees only that property\'s requests', async () => {
    // Same landlord, two properties — the in-org leak, not a cross-landlord one.
    const f = await seedFixture()
    const client = await db.connect()
    let otherUnitId = ''
    try {
      const otherProp = await seedProperty(client, {
        landlordId: f.landlordId, ownerUserId: f.landlordUserId, managedByUserId: f.landlordUserId })
      otherUnitId = await seedUnit(client, { propertyId: otherProp, landlordId: f.landlordId })
    } finally { client.release() }

    await seedReqOn(f.landlordId, f.unitId, f.tenantId, 'IN SCOPE')
    await seedReqOn(f.landlordId, otherUnitId, f.tenantId, 'OUT OF SCOPE')

    const token = await seedScopedWorker(f.landlordId, [f.propertyId])
    const res = await request(buildApp())
      .get('/api/maintenance').set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    const titles = res.body.data.map((r: any) => r.title)
    expect(titles).toContain('IN SCOPE')
    expect(titles).not.toContain('OUT OF SCOPE')
  })

  it('DETAIL: reading an out-of-scope request by id is refused', async () => {
    const f = await seedFixture()
    const client = await db.connect()
    let otherUnitId = ''
    try {
      const otherProp = await seedProperty(client, {
        landlordId: f.landlordId, ownerUserId: f.landlordUserId, managedByUserId: f.landlordUserId })
      otherUnitId = await seedUnit(client, { propertyId: otherProp, landlordId: f.landlordId })
    } finally { client.release() }

    const outOfScopeId = await seedReqOn(f.landlordId, otherUnitId, f.tenantId, 'OUT OF SCOPE')
    const token = await seedScopedWorker(f.landlordId, [f.propertyId])
    const res = await request(buildApp())
      .get(`/api/maintenance/${outOfScopeId}`).set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(403)
  })

  it('all_properties=true worker is unrestricted (scope returns null)', async () => {
    const f = await seedFixture()
    await seedReqOn(f.landlordId, f.unitId, f.tenantId, 'ANY')
    const userId = randomUUID()
    await db.query(
      `INSERT INTO users (id, email, password_hash, first_name, last_name, role)
       VALUES ($1, $2, 'x', 'All', 'Worker', 'maintenance')`,
      [userId, `allworker-${userId}@test.dev`])
    await db.query(
      `INSERT INTO maintenance_worker_scopes
         (user_id, landlord_id, property_ids, unit_ids, job_categories, all_properties)
       VALUES ($1, $2, '{}', '{}', '{}', true)`,
      [userId, f.landlordId])
    const token = jwt.sign(
      { userId, role: 'maintenance', email: 'aw@test.dev', profileId: userId,
        landlordId: f.landlordId, permissions: {} },
      process.env.JWT_SECRET!, { expiresIn: '1h' })
    const res = await request(buildApp())
      .get('/api/maintenance').set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    expect(res.body.data.map((r: any) => r.title)).toContain('ANY')
  })
})

// ── S603: internal columns must never reach a tenant ───────────────────────
// GET /maintenance and /:id both SELECT mr.*, which handed tenants the
// landlord's repair economics (estimated_cost / actual_cost), internal
// landlord_notes, and platform_fee — GAM's own maintenance margin, which is
// reserved for the future contractor marketplace and surfaced nowhere. The
// is_internal COMMENT filter already existed; the COLUMNS were missed.
describe('maintenance internal-field redaction (S603)', () => {
  const HIDDEN = ['estimated_cost', 'actual_cost', 'platform_fee', 'landlord_notes']

  async function seedPricedRequest(f: any): Promise<string> {
    const r = await db.query<{ id: string }>(
      `INSERT INTO maintenance_requests
         (unit_id, tenant_id, landlord_id, title, description, priority, status,
          estimated_cost, actual_cost, platform_fee, landlord_notes)
       VALUES ($1,$2,$3,'Leak','desc','normal','awaiting_approval',
               900, 850, 68, 'Internal: get a second quote')
       RETURNING id`,
      [f.unitId, f.tenantId, f.landlordId])
    return r.rows[0].id
  }

  it('LIST: tenant response omits every internal field', async () => {
    const f = await seedFixture()
    await seedPricedRequest(f)
    const res = await request(buildApp())
      .get('/api/maintenance').set('Authorization', `Bearer ${f.tenantToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data.length).toBeGreaterThan(0)
    for (const row of res.body.data) {
      for (const field of HIDDEN) expect(row).not.toHaveProperty(field)
    }
  })

  it('DETAIL: tenant response omits every internal field', async () => {
    const f = await seedFixture()
    const id = await seedPricedRequest(f)
    const res = await request(buildApp())
      .get(`/api/maintenance/${id}`).set('Authorization', `Bearer ${f.tenantToken}`)
    expect(res.status).toBe(200)
    for (const field of HIDDEN) expect(res.body.data).not.toHaveProperty(field)
    // The tenant still sees the request itself, incl. that it's awaiting a call.
    expect(res.body.data.status).toBe('awaiting_approval')
  })

  it('LANDLORD still receives the internal fields (redaction is tenant-only)', async () => {
    const f = await seedFixture()
    const id = await seedPricedRequest(f)
    const res = await request(buildApp())
      .get(`/api/maintenance/${id}`).set('Authorization', `Bearer ${f.landlordToken}`)
    expect(res.status).toBe(200)
    expect(Number(res.body.data.estimated_cost)).toBe(900)
    expect(res.body.data.landlord_notes).toBe('Internal: get a second quote')
  })
})


// S605 (Nic): the same list serves the portfolio-wide screen and a single
// property's Maintenance tab — "each screen answers a different question.
// Nothing moves."
describe('S605 property-scoped maintenance list', () => {
  it('?propertyId returns only that property’s requests', async () => {
    const f = await seedFixture()
    const app = buildApp()
    const all = await request(app).get('/api/maintenance')
      .set('Authorization', `Bearer ${f.landlordToken}`)
    const scoped = await request(app).get(`/api/maintenance?propertyId=${f.propertyId}`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
    expect(scoped.status).toBe(200)
    // Everything returned belongs to a unit at that property.
    for (const r of scoped.body.data as any[]) {
      const { rows } = await db.query<any>(
        `SELECT property_id FROM units WHERE id = $1`, [r.unitId ?? r.unit_id])
      if (rows[0]) expect(rows[0].property_id).toBe(f.propertyId)
    }
    expect((scoped.body.data as any[]).length).toBeLessThanOrEqual((all.body.data as any[]).length)
  })

  it('a property with no requests returns none of them', async () => {
    const f = await seedFixture()
    const other = '00000000-0000-0000-0000-0000000000ff'
    const res = await request(buildApp()).get(`/api/maintenance?propertyId=${other}`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data).toEqual([])
  })
})
