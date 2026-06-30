/**
 * Inspections route — move-in / move-out / periodic inspection
 * workflow with sign-off state machine and credit-ledger emission
 * at finalize.
 *
 * Surfaces under test:
 *   - POST   /inspections                create draft (landlord-only)
 *   - GET    /inspections                role-scoped list
 *   - GET    /inspections/:id            detail + items + signatures
 *   - PATCH  /inspections/:id            reschedule (clears reminder)
 *   - POST   /inspections/:id/items      item upsert
 *   - POST   /inspections/:id/sign       sign-off state machine
 *   - POST   /inspections/:id/finalize   ledger emit + move-out compare
 *
 * High-leverage paths:
 *   (1) The sign-off state machine flips through draft → tenant_signed
 *       → landlord_signed; finalize is gated on landlord_signed.
 *   (2) Move-out comparison logic (good < fair < damaged < missing,
 *       'na' excluded, items only in move-out excluded).
 *   (3) emitInspectionFinalizedEvents fires transactionally inside
 *       the same client tx as the status flip.
 *
 * Mocks: credit-ledger emitter + three notification calls +
 * getPropertyResponsibleParty (dynamically imported).
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
import { createInspection as createInspectionTool } from '../services/agents/tools/createInspection'
import { setInspectionItemCondition as setItemConditionTool } from '../services/agents/tools/setInspectionItemCondition'

const {
  emitInspectionFinalizedEventsMock,
  notifyReadyMock, notifyTenantSignedMock, notifyFinalizedMock,
  getResponsiblePartyMock,
} = vi.hoisted(() => ({
  emitInspectionFinalizedEventsMock: vi.fn(async () => {}),
  notifyReadyMock:                   vi.fn(async () => {}),
  notifyTenantSignedMock:            vi.fn(async () => {}),
  notifyFinalizedMock:               vi.fn(async () => {}),
  getResponsiblePartyMock:           vi.fn(async () => null as any),
}))
vi.mock('../services/creditLedgerEmitters', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    emitInspectionFinalizedEvents: emitInspectionFinalizedEventsMock,
  }
})
vi.mock('../services/notifications', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    notifyInspectionReadyForTenant: notifyReadyMock,
    notifyInspectionTenantSigned:   notifyTenantSignedMock,
    notifyInspectionFinalized:      notifyFinalizedMock,
  }
})
vi.mock('../services/responsibleParty', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    getPropertyResponsibleParty: getResponsiblePartyMock,
  }
})

import { inspectionsRouter } from './inspections'
import { errorHandler } from '../middleware/errorHandler'

function buildApp() {
  const app = express()
  app.use(express.json({ limit: '2mb' }))
  app.use('/api/inspections', inspectionsRouter)
  app.use(errorHandler)
  return app
}

beforeEach(async () => {
  await cleanupAllSchema()
  emitInspectionFinalizedEventsMock.mockClear()
  notifyReadyMock.mockClear()
  notifyTenantSignedMock.mockClear()
  notifyFinalizedMock.mockClear()
  getResponsiblePartyMock.mockClear()
  getResponsiblePartyMock.mockResolvedValue(null)
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_inspections'
})

interface SeedFixture {
  landlordUserId: string
  landlordId:     string
  tenantUserId:   string
  tenantId:       string
  unitId:         string
  propertyId:     string
  leaseId:        string
  landlordToken:  string
  tenantToken:    string
}

async function seedFixture(): Promise<SeedFixture> {
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    const { userId: landlordUserId, landlordId } = await seedLandlord(client)
    const tenantId = await seedTenant(client)
    const tu = await client.query<{ user_id: string }>(
      `SELECT user_id FROM tenants WHERE id = $1`, [tenantId],
    )
    const tenantUserId = tu.rows[0].user_id
    const propertyId = await seedProperty(client, { landlordId, ownerUserId: landlordUserId, managedByUserId: landlordUserId })
    const unitId     = await seedUnit(client, { propertyId, landlordId })
    const leaseId    = await seedLease(client, { unitId, landlordId })
    await seedLeaseTenant(client, { leaseId, tenantId })
    await client.query('COMMIT')

    const landlordToken = jwt.sign(
      { userId: landlordUserId, role: 'landlord', email: 'll@test.dev', profileId: landlordId, permissions: {} },
      process.env.JWT_SECRET!, { expiresIn: '1h' },
    )
    const tenantToken = jwt.sign(
      { userId: tenantUserId, role: 'tenant', email: 't@test.dev', profileId: tenantId, permissions: {} },
      process.env.JWT_SECRET!, { expiresIn: '1h' },
    )
    return { landlordUserId, landlordId, tenantUserId, tenantId, unitId, propertyId, leaseId, landlordToken, tenantToken }
  } catch (e) { await client.query('ROLLBACK'); throw e }
  finally { client.release() }
}

async function createInspection(f: SeedFixture, opts: Partial<{
  inspectionType: 'move_in' | 'move_out' | 'periodic'
  status: string
  comparisonInspectionId: string | null
  scheduledFor: string | null
  reminderSentAt: string | null
  tenantId: string | null
}> = {}): Promise<string> {
  const res = await db.query<{ id: string }>(
    `INSERT INTO unit_inspections
       (unit_id, lease_id, tenant_id, landlord_id, inspection_type, status,
        comparison_inspection_id, scheduled_for, reminder_sent_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id`,
    [
      f.unitId, f.leaseId,
      opts.tenantId === null ? null : (opts.tenantId ?? f.tenantId),
      f.landlordId,
      opts.inspectionType ?? 'move_in',
      opts.status ?? 'draft',
      opts.comparisonInspectionId ?? null,
      opts.scheduledFor ?? null,
      opts.reminderSentAt ?? null,
    ],
  )
  return res.rows[0].id
}

async function insertItem(inspectionId: string, area: string, item: string, cond: string) {
  await db.query(
    `INSERT INTO unit_inspection_items (inspection_id, area, item_label, condition)
     VALUES ($1, $2, $3, $4)`,
    [inspectionId, area, item, cond],
  )
}

async function insertSignature(inspectionId: string, userId: string, role: 'tenant' | 'landlord' | 'inspector') {
  await db.query(
    `INSERT INTO unit_inspection_signatures (inspection_id, signer_user_id, signer_role, signature_evidence)
     VALUES ($1, $2, $3, '{}'::jsonb)`,
    [inspectionId, userId, role],
  )
}

// ─── POST /inspections — create ───────────────────────────────────

describe('POST /inspections', () => {
  it('landlord creates a draft inspection', async () => {
    const f = await seedFixture()
    const res = await request(buildApp())
      .post('/api/inspections')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ unitId: f.unitId, leaseId: f.leaseId, tenantId: f.tenantId, inspectionType: 'move_in' })
    expect(res.status).toBe(200)
    expect(res.body.data.id).toBeTruthy()
    const row = await db.query<{ status: string }>(
      `SELECT status FROM unit_inspections WHERE id = $1`, [res.body.data.id],
    )
    expect(row.rows[0].status).toBe('draft')
  })

  it('seeds the standard walkthrough checklist as na items on create', async () => {
    const f = await seedFixture()
    const res = await request(buildApp())
      .post('/api/inspections')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ unitId: f.unitId, leaseId: f.leaseId, tenantId: f.tenantId, inspectionType: 'move_in' })
    expect(res.status).toBe(200)
    expect(res.body.data.seededItems).toBeGreaterThan(0)
    const items = await db.query<{ area: string; condition: string }>(
      `SELECT area, condition FROM unit_inspection_items WHERE inspection_id = $1`, [res.body.data.id],
    )
    expect(items.rows.length).toBe(res.body.data.seededItems)
    expect(items.rows.every((r) => r.condition === 'na')).toBe(true)
    expect(items.rows.map((r) => r.area)).toContain('Kitchen')
  })

  it('tenant denied (only landlord-side can create)', async () => {
    const f = await seedFixture()
    const res = await request(buildApp())
      .post('/api/inspections')
      .set('Authorization', `Bearer ${f.tenantToken}`)
      .send({ unitId: f.unitId, inspectionType: 'move_in' })
    expect(res.status).toBe(403)
  })

  it('cross-landlord denied', async () => {
    const f = await seedFixture()
    const otherLandlordToken = jwt.sign(
      { userId: randomUUID(), role: 'landlord', email: 'other@test.dev', profileId: randomUUID(), permissions: {} },
      process.env.JWT_SECRET!, { expiresIn: '1h' },
    )
    const res = await request(buildApp())
      .post('/api/inspections')
      .set('Authorization', `Bearer ${otherLandlordToken}`)
      .send({ unitId: f.unitId, inspectionType: 'move_in' })
    expect(res.status).toBe(403)
  })

  it('rejects invalid inspectionType (zod enum)', async () => {
    const f = await seedFixture()
    const res = await request(buildApp())
      .post('/api/inspections')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ unitId: f.unitId, inspectionType: 'walk_through' })
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(res.status).toBeLessThan(500)
  })

  it('rejects unknown unit', async () => {
    const f = await seedFixture()
    const res = await request(buildApp())
      .post('/api/inspections')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ unitId: randomUUID(), inspectionType: 'move_in' })
    expect(res.status).toBe(404)
  })
})

// ─── GET /inspections/:id and list ────────────────────────────────

describe('GET /inspections/:id', () => {
  it('landlord can read own inspection with nested items + signatures', async () => {
    const f = await seedFixture()
    const id = await createInspection(f)
    await insertItem(id, 'kitchen', 'sink', 'good')
    await insertSignature(id, f.tenantUserId, 'tenant')
    const res = await request(buildApp())
      .get(`/api/inspections/${id}`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data.id).toBe(id)
    expect(res.body.data.items).toHaveLength(1)
    expect(res.body.data.signatures).toHaveLength(1)
    expect(res.body.data.signatures[0].signer_role).toBe('tenant')
  })

  it('tenant can read own inspection', async () => {
    const f = await seedFixture()
    const id = await createInspection(f)
    const res = await request(buildApp())
      .get(`/api/inspections/${id}`)
      .set('Authorization', `Bearer ${f.tenantToken}`)
    expect(res.status).toBe(200)
  })

  it('tenant rejected from another tenant inspection', async () => {
    const f = await seedFixture()
    const client = await db.connect()
    let otherTenantToken = ''
    try {
      await client.query('BEGIN')
      const otherTenantId = await seedTenant(client, { email: `other-${randomUUID()}@test.dev` })
      const tu = await client.query<{ user_id: string }>(
        `SELECT user_id FROM tenants WHERE id = $1`, [otherTenantId],
      )
      await client.query('COMMIT')
      otherTenantToken = jwt.sign(
        { userId: tu.rows[0].user_id, role: 'tenant', email: 'o@test.dev', profileId: otherTenantId, permissions: {} },
        process.env.JWT_SECRET!, { expiresIn: '1h' },
      )
    } finally { client.release() }
    const id = await createInspection(f)
    const res = await request(buildApp())
      .get(`/api/inspections/${id}`)
      .set('Authorization', `Bearer ${otherTenantToken}`)
    expect(res.status).toBe(403)
  })

  it('cross-landlord cannot read', async () => {
    const f = await seedFixture()
    const id = await createInspection(f)
    const otherLandlordToken = jwt.sign(
      { userId: randomUUID(), role: 'landlord', email: 'other@test.dev', profileId: randomUUID(), permissions: {} },
      process.env.JWT_SECRET!, { expiresIn: '1h' },
    )
    const res = await request(buildApp())
      .get(`/api/inspections/${id}`)
      .set('Authorization', `Bearer ${otherLandlordToken}`)
    expect(res.status).toBe(403)
  })

  it('returns 404 for missing inspection', async () => {
    const f = await seedFixture()
    const res = await request(buildApp())
      .get(`/api/inspections/${randomUUID()}`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
    expect(res.status).toBe(404)
  })
})

describe('GET /inspections — list scoping', () => {
  it('tenant sees only their own', async () => {
    const f = await seedFixture()
    const own = await createInspection(f)
    // Another tenant on same landlord; their inspection should NOT come back.
    const client = await db.connect()
    try {
      await client.query('BEGIN')
      const otherT = await seedTenant(client, { email: `other-${randomUUID()}@test.dev` })
      await client.query('COMMIT')
      await createInspection(f, { tenantId: otherT })
    } finally { client.release() }
    const res = await request(buildApp())
      .get('/api/inspections')
      .set('Authorization', `Bearer ${f.tenantToken}`)
    expect(res.status).toBe(200)
    const ids = (res.body.data as any[]).map(r => r.id)
    expect(ids).toEqual([own])
  })

  it('landlord sees all on their landlord_id', async () => {
    const f = await seedFixture()
    await createInspection(f)
    await createInspection(f, { inspectionType: 'periodic' })
    const res = await request(buildApp())
      .get('/api/inspections')
      .set('Authorization', `Bearer ${f.landlordToken}`)
    expect(res.status).toBe(200)
    expect((res.body.data as any[]).length).toBe(2)
  })

  it('unitId filter narrows the list', async () => {
    const f = await seedFixture()
    const a = await createInspection(f)
    // Different unit on the same landlord.
    const client = await db.connect()
    let otherUnitId = ''
    try {
      await client.query('BEGIN')
      otherUnitId = await seedUnit(client, { propertyId: f.propertyId, landlordId: f.landlordId })
      await client.query('COMMIT')
    } finally { client.release() }
    await db.query(
      `INSERT INTO unit_inspections (unit_id, landlord_id, inspection_type, status)
       VALUES ($1, $2, 'move_in', 'draft')`,
      [otherUnitId, f.landlordId],
    )
    const res = await request(buildApp())
      .get(`/api/inspections?unitId=${f.unitId}`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
    expect(res.status).toBe(200)
    const ids = (res.body.data as any[]).map(r => r.id)
    expect(ids).toEqual([a])
  })
})

// ─── PATCH /inspections/:id ───────────────────────────────────────

describe('PATCH /inspections/:id', () => {
  it('landlord can edit notes in draft status', async () => {
    const f = await seedFixture()
    const id = await createInspection(f)
    const res = await request(buildApp())
      .patch(`/api/inspections/${id}`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ notes: 'Tenant wants morning slot' })
    expect(res.status).toBe(200)
    const row = await db.query<{ notes: string }>(
      `SELECT notes FROM unit_inspections WHERE id = $1`, [id],
    )
    expect(row.rows[0].notes).toBe('Tenant wants morning slot')
  })

  it('rescheduling clears reminder_sent_at', async () => {
    const f = await seedFixture()
    const id = await createInspection(f, {
      scheduledFor: '2026-06-01T10:00:00Z',
      reminderSentAt: '2026-05-31T10:00:00Z',
    })
    const res = await request(buildApp())
      .patch(`/api/inspections/${id}`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ scheduledFor: '2026-06-15T10:00:00Z' })
    expect(res.status).toBe(200)
    expect(res.body.data.rescheduled).toBe(true)
    const row = await db.query<{ reminder_sent_at: string | null }>(
      `SELECT reminder_sent_at FROM unit_inspections WHERE id = $1`, [id],
    )
    expect(row.rows[0].reminder_sent_at).toBeNull()
  })

  it('409 when status is finalized', async () => {
    const f = await seedFixture()
    const id = await createInspection(f, { status: 'finalized' })
    const res = await request(buildApp())
      .patch(`/api/inspections/${id}`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ notes: 'too late' })
    expect(res.status).toBe(409)
  })

  it('409 when status is cancelled', async () => {
    const f = await seedFixture()
    const id = await createInspection(f, { status: 'cancelled' })
    const res = await request(buildApp())
      .patch(`/api/inspections/${id}`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ notes: 'too late' })
    expect(res.status).toBe(409)
  })

  it('tenant cannot patch (landlord-side only)', async () => {
    const f = await seedFixture()
    const id = await createInspection(f)
    const res = await request(buildApp())
      .patch(`/api/inspections/${id}`)
      .set('Authorization', `Bearer ${f.tenantToken}`)
      .send({ notes: 'tenant attempt' })
    expect(res.status).toBe(403)
  })
})

// ─── POST /inspections/:id/items ──────────────────────────────────

describe('POST /inspections/:id/items', () => {
  it('inserts a new item in draft', async () => {
    const f = await seedFixture()
    const id = await createInspection(f)
    const res = await request(buildApp())
      .post(`/api/inspections/${id}/items`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ area: 'kitchen', itemLabel: 'sink', condition: 'good' })
    expect(res.status).toBe(200)
    const items = await db.query<{ area: string; item_label: string; condition: string }>(
      `SELECT area, item_label, condition FROM unit_inspection_items WHERE inspection_id = $1`,
      [id],
    )
    expect(items.rows).toEqual([{ area: 'kitchen', item_label: 'sink', condition: 'good' }])
  })

  it('upserts on (area, itemLabel) conflict — condition is updated', async () => {
    const f = await seedFixture()
    const id = await createInspection(f)
    await request(buildApp())
      .post(`/api/inspections/${id}/items`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ area: 'kitchen', itemLabel: 'sink', condition: 'good' })
    await request(buildApp())
      .post(`/api/inspections/${id}/items`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ area: 'kitchen', itemLabel: 'sink', condition: 'damaged', notes: 'cracked' })
    const items = await db.query<{ condition: string; notes: string | null }>(
      `SELECT condition, notes FROM unit_inspection_items WHERE inspection_id = $1`, [id],
    )
    expect(items.rows).toHaveLength(1)
    expect(items.rows[0].condition).toBe('damaged')
    expect(items.rows[0].notes).toBe('cracked')
  })

  it('409 when status is not draft', async () => {
    const f = await seedFixture()
    const id = await createInspection(f, { status: 'tenant_signed' })
    const res = await request(buildApp())
      .post(`/api/inspections/${id}/items`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ area: 'kitchen', itemLabel: 'sink', condition: 'good' })
    expect(res.status).toBe(409)
  })

  it('rejects invalid condition enum (zod)', async () => {
    const f = await seedFixture()
    const id = await createInspection(f)
    const res = await request(buildApp())
      .post(`/api/inspections/${id}/items`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ area: 'kitchen', itemLabel: 'sink', condition: 'broken' })
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(res.status).toBeLessThan(500)
  })
})

// ─── POST /inspections/:id/sign — state machine ───────────────────

describe('POST /inspections/:id/sign — sign-off state machine', () => {
  it('tenant signs from draft → status flips to tenant_signed', async () => {
    const f = await seedFixture()
    const id = await createInspection(f)
    const res = await request(buildApp())
      .post(`/api/inspections/${id}/sign`)
      .set('Authorization', `Bearer ${f.tenantToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data.signed).toBe('tenant')
    expect(res.body.data.status).toBe('tenant_signed')
  })

  it('landlord signs after tenant → status flips to landlord_signed', async () => {
    const f = await seedFixture()
    const id = await createInspection(f, { status: 'tenant_signed' })
    await insertSignature(id, f.tenantUserId, 'tenant')
    const res = await request(buildApp())
      .post(`/api/inspections/${id}/sign`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data.status).toBe('landlord_signed')
  })

  it('landlord signs FIRST → status stays draft (only tenant-first transitions to tenant_signed)', async () => {
    const f = await seedFixture()
    const id = await createInspection(f)
    const res = await request(buildApp())
      .post(`/api/inspections/${id}/sign`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data.signed).toBe('landlord')
    // Status doesn't flip because tenant hasn't signed yet.
    expect(res.body.data.status).toBe('draft')
  })

  it('landlord signs a tenant-less periodic (no tenant_id) → flips straight to landlord_signed', async () => {
    const f = await seedFixture()
    const id = await createInspection(f, { inspectionType: 'periodic', tenantId: null })
    const res = await request(buildApp())
      .post(`/api/inspections/${id}/sign`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data.signed).toBe('landlord')
    // No tenant exists to sign — the landlord's signature alone is sufficient,
    // otherwise a landlord-initiated periodic could never be finalized.
    expect(res.body.data.status).toBe('landlord_signed')
  })

  it('cannot sign in finalized status', async () => {
    const f = await seedFixture()
    const id = await createInspection(f, { status: 'finalized' })
    const res = await request(buildApp())
      .post(`/api/inspections/${id}/sign`)
      .set('Authorization', `Bearer ${f.tenantToken}`)
    expect(res.status).toBe(409)
  })

  it('cannot sign in cancelled status', async () => {
    const f = await seedFixture()
    const id = await createInspection(f, { status: 'cancelled' })
    const res = await request(buildApp())
      .post(`/api/inspections/${id}/sign`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
    expect(res.status).toBe(409)
  })

  it('tenant rejected from other tenant inspection', async () => {
    const f = await seedFixture()
    const client = await db.connect()
    let otherToken = ''
    try {
      await client.query('BEGIN')
      const otherTenantId = await seedTenant(client, { email: `other-${randomUUID()}@test.dev` })
      const tu = await client.query<{ user_id: string }>(
        `SELECT user_id FROM tenants WHERE id = $1`, [otherTenantId],
      )
      await client.query('COMMIT')
      otherToken = jwt.sign(
        { userId: tu.rows[0].user_id, role: 'tenant', email: 'o@test.dev', profileId: otherTenantId, permissions: {} },
        process.env.JWT_SECRET!, { expiresIn: '1h' },
      )
    } finally { client.release() }
    const id = await createInspection(f)
    const res = await request(buildApp())
      .post(`/api/inspections/${id}/sign`)
      .set('Authorization', `Bearer ${otherToken}`)
    expect(res.status).toBe(403)
  })

  it('tenant sign fires notifyInspectionTenantSigned when responsible party resolves', async () => {
    const f = await seedFixture()
    getResponsiblePartyMock.mockResolvedValueOnce({
      primaries: [{ user_id: f.landlordUserId, email: 'll@test.dev', phone: null }],
      additionals: [],
    } as any)
    const id = await createInspection(f)
    await request(buildApp())
      .post(`/api/inspections/${id}/sign`)
      .set('Authorization', `Bearer ${f.tenantToken}`)
    expect(notifyTenantSignedMock).toHaveBeenCalledTimes(1)
  })

  it('landlord sign fires notifyInspectionReadyForTenant', async () => {
    const f = await seedFixture()
    const id = await createInspection(f, { status: 'tenant_signed' })
    await insertSignature(id, f.tenantUserId, 'tenant')
    await request(buildApp())
      .post(`/api/inspections/${id}/sign`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
    expect(notifyReadyMock).toHaveBeenCalledTimes(1)
  })

  it('signing twice as the same role is idempotent via ON CONFLICT update', async () => {
    const f = await seedFixture()
    const id = await createInspection(f)
    await request(buildApp()).post(`/api/inspections/${id}/sign`).set('Authorization', `Bearer ${f.tenantToken}`)
    await request(buildApp()).post(`/api/inspections/${id}/sign`).set('Authorization', `Bearer ${f.tenantToken}`)
    const sigs = await db.query(
      `SELECT signer_user_id, signer_role FROM unit_inspection_signatures WHERE inspection_id = $1`,
      [id],
    )
    expect(sigs.rows.length).toBe(1)
  })
})

// ─── POST /inspections/:id/finalize ───────────────────────────────

describe('POST /inspections/:id/finalize', () => {
  it('landlord finalizes from landlord_signed → status=finalized, ledger emitter fires', async () => {
    const f = await seedFixture()
    const id = await createInspection(f, { status: 'landlord_signed' })
    const res = await request(buildApp())
      .post(`/api/inspections/${id}/finalize`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data.status).toBe('finalized')
    expect(emitInspectionFinalizedEventsMock).toHaveBeenCalledTimes(1)
    const row = await db.query<{ status: string; finalized_at: string }>(
      `SELECT status, finalized_at FROM unit_inspections WHERE id = $1`, [id],
    )
    expect(row.rows[0].status).toBe('finalized')
    expect(row.rows[0].finalized_at).not.toBeNull()
  })

  it('landlord-initiated periodic with no tenant: sign → finalize works end-to-end', async () => {
    const f = await seedFixture()
    const id = await createInspection(f, { inspectionType: 'periodic', tenantId: null })
    // Landlord signs — tenant-less, so this alone reaches landlord_signed.
    const signRes = await request(buildApp())
      .post(`/api/inspections/${id}/sign`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
    expect(signRes.body.data.status).toBe('landlord_signed')
    // …and finalize succeeds from there.
    const finRes = await request(buildApp())
      .post(`/api/inspections/${id}/finalize`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
    expect(finRes.status).toBe(200)
    expect(finRes.body.data.status).toBe('finalized')
  })

  it('rejects from draft status', async () => {
    const f = await seedFixture()
    const id = await createInspection(f, { status: 'draft' })
    const res = await request(buildApp())
      .post(`/api/inspections/${id}/finalize`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
    expect(res.status).toBe(409)
    expect(emitInspectionFinalizedEventsMock).not.toHaveBeenCalled()
  })

  it('rejects from tenant_signed (needs both signatures)', async () => {
    const f = await seedFixture()
    const id = await createInspection(f, { status: 'tenant_signed' })
    const res = await request(buildApp())
      .post(`/api/inspections/${id}/finalize`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
    expect(res.status).toBe(409)
  })

  it('rejects double-finalize (already finalized)', async () => {
    const f = await seedFixture()
    const id = await createInspection(f, { status: 'finalized' })
    const res = await request(buildApp())
      .post(`/api/inspections/${id}/finalize`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
    expect(res.status).toBe(409)
  })

  it('cross-landlord cannot finalize', async () => {
    const f = await seedFixture()
    const id = await createInspection(f, { status: 'landlord_signed' })
    const otherLandlordToken = jwt.sign(
      { userId: randomUUID(), role: 'landlord', email: 'other@test.dev', profileId: randomUUID(), permissions: {} },
      process.env.JWT_SECRET!, { expiresIn: '1h' },
    )
    const res = await request(buildApp())
      .post(`/api/inspections/${id}/finalize`)
      .set('Authorization', `Bearer ${otherLandlordToken}`)
    expect(res.status).toBe(403)
  })

  it('move-out matches move-in: matches_move_in=true, damage_documented=false', async () => {
    const f = await seedFixture()
    const moveInId = await createInspection(f, { inspectionType: 'move_in', status: 'finalized' })
    await insertItem(moveInId, 'kitchen', 'sink',  'good')
    await insertItem(moveInId, 'kitchen', 'stove', 'fair')

    const moveOutId = await createInspection(f, {
      inspectionType: 'move_out', status: 'landlord_signed',
      comparisonInspectionId: moveInId,
    })
    await insertItem(moveOutId, 'kitchen', 'sink',  'good')
    await insertItem(moveOutId, 'kitchen', 'stove', 'fair')

    const res = await request(buildApp())
      .post(`/api/inspections/${moveOutId}/finalize`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data.matches_move_in).toBe(true)
    expect(res.body.data.damage_documented).toBe(false)
  })

  it('move-out worse than move-in: matches_move_in=false, damage_documented=true', async () => {
    const f = await seedFixture()
    const moveInId = await createInspection(f, { inspectionType: 'move_in', status: 'finalized' })
    await insertItem(moveInId, 'kitchen', 'sink',  'good')
    await insertItem(moveInId, 'kitchen', 'stove', 'good')

    const moveOutId = await createInspection(f, {
      inspectionType: 'move_out', status: 'landlord_signed',
      comparisonInspectionId: moveInId,
    })
    await insertItem(moveOutId, 'kitchen', 'sink',  'damaged')   // worse
    await insertItem(moveOutId, 'kitchen', 'stove', 'good')

    const res = await request(buildApp())
      .post(`/api/inspections/${moveOutId}/finalize`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data.matches_move_in).toBe(false)
    expect(res.body.data.damage_documented).toBe(true)
  })

  it("'na' in move-out is excluded from comparison (doesn't count as damage)", async () => {
    const f = await seedFixture()
    const moveInId = await createInspection(f, { inspectionType: 'move_in', status: 'finalized' })
    await insertItem(moveInId, 'kitchen', 'dishwasher', 'good')

    const moveOutId = await createInspection(f, {
      inspectionType: 'move_out', status: 'landlord_signed',
      comparisonInspectionId: moveInId,
    })
    // dishwasher condition can't be assessed at move-out — caller picked 'na'.
    await insertItem(moveOutId, 'kitchen', 'dishwasher', 'na')

    const res = await request(buildApp())
      .post(`/api/inspections/${moveOutId}/finalize`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data.matches_move_in).toBe(true)
  })

  it('items only in move-out (not in move-in) are excluded from comparison', async () => {
    const f = await seedFixture()
    const moveInId = await createInspection(f, { inspectionType: 'move_in', status: 'finalized' })
    await insertItem(moveInId, 'kitchen', 'sink', 'good')

    const moveOutId = await createInspection(f, {
      inspectionType: 'move_out', status: 'landlord_signed',
      comparisonInspectionId: moveInId,
    })
    await insertItem(moveOutId, 'kitchen', 'sink', 'good')
    // New item at move-out — never in move-in. Should not flag damage.
    await insertItem(moveOutId, 'kitchen', 'new_lamp', 'missing')

    const res = await request(buildApp())
      .post(`/api/inspections/${moveOutId}/finalize`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data.matches_move_in).toBe(true)
  })

  it('move-in (non-move_out) skips comparison entirely', async () => {
    const f = await seedFixture()
    const id = await createInspection(f, { inspectionType: 'move_in', status: 'landlord_signed' })
    const res = await request(buildApp())
      .post(`/api/inspections/${id}/finalize`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data.matches_move_in).toBe(false)  // no comparison ran
    expect(res.body.data.damage_documented).toBe(false)
  })

  it('passes photoCount and leaseStartDate to the emitter for move_in', async () => {
    const f = await seedFixture()
    const id = await createInspection(f, { inspectionType: 'move_in', status: 'landlord_signed' })
    // Insert one photo via raw INSERT (skip the multipart route here).
    await db.query(
      `INSERT INTO unit_inspection_photos (inspection_id, photo_url, uploaded_by)
       VALUES ($1, '/x.jpg', $2)`,
      [id, f.landlordUserId],
    )
    await request(buildApp())
      .post(`/api/inspections/${id}/finalize`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
    const call = emitInspectionFinalizedEventsMock.mock.calls[0] as unknown as any[]
    const ctx = call[1]
    expect(ctx.photoCount).toBe(1)
    expect(ctx.inspectionType).toBe('move_in')
    expect(ctx.leaseStartDate).toBeInstanceOf(Date)
  })
})

describe('walkthrough videos + unit lifecycle (landlord/internal)', () => {
  it('accepts the turnover inspection type and seeds its checklist', async () => {
    const f = await seedFixture()
    const res = await request(buildApp())
      .post('/api/inspections')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ unitId: f.unitId, inspectionType: 'turnover' })
    expect(res.status).toBe(200)
    expect(res.body.data.seededItems).toBeGreaterThan(0)
    const row = await db.query<{ inspection_type: string }>(
      `SELECT inspection_type FROM unit_inspections WHERE id = $1`, [res.body.data.id],
    )
    expect(row.rows[0].inspection_type).toBe('turnover')
  })

  it('uploads a video, lists it, and denies the tenant', async () => {
    const f = await seedFixture()
    const inspId = await createInspection(f, { inspectionType: 'move_in' })
    const up = await request(buildApp())
      .post(`/api/inspections/${inspId}/videos`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .field('title', 'Move-in walkthrough')
      .attach('file', Buffer.from('fakemp4data'), { filename: 'clip.mp4', contentType: 'video/mp4' })
    expect(up.status).toBe(200)
    expect(up.body.data.url).toMatch(/\/api\/inspections\/video-files\//)

    const list = await request(buildApp())
      .get(`/api/inspections/${inspId}/videos`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
    expect(list.body.data).toHaveLength(1)
    expect(list.body.data[0].title).toBe('Move-in walkthrough')

    const denied = await request(buildApp())
      .get(`/api/inspections/${inspId}/videos`)
      .set('Authorization', `Bearer ${f.tenantToken}`)
    expect(denied.status).toBe(403)
  })

  it('returns the unit lifecycle oldest-first with each stage’s videos; tenant denied', async () => {
    const f = await seedFixture()
    const moveIn = await createInspection(f, { inspectionType: 'move_in' })
    await db.query(
      `INSERT INTO unit_inspection_videos (inspection_id, title, video_url, uploaded_by)
       VALUES ($1, $2, $3, $4)`,
      [moveIn, 'mi clip', '/api/inspections/video-files/x.mp4', f.landlordUserId],
    )
    const res = await request(buildApp())
      .get(`/api/inspections/unit/${f.unitId}/lifecycle`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
    expect(res.status).toBe(200)
    const stage = res.body.data.stages.find((s: any) => s.id === moveIn)
    expect(stage.videos).toHaveLength(1)
    expect(stage.videos[0].title).toBe('mi clip')

    const denied = await request(buildApp())
      .get(`/api/inspections/unit/${f.unitId}/lifecycle`)
      .set('Authorization', `Bearer ${f.tenantToken}`)
    expect(denied.status).toBe(403)
  })
})

describe('video immutability + tenant uploads & visibility', () => {
  it('blocks deleting a video and repointing its url (DB-enforced immutability)', async () => {
    const f = await seedFixture()
    const inspId = await createInspection(f, { inspectionType: 'move_in' })
    const url = '/api/inspections/video-files/imm-' + Math.floor(performance.now()) + '.mp4'
    await db.query(
      `INSERT INTO unit_inspection_videos (inspection_id, title, video_url, uploaded_by)
       VALUES ($1, 'keep', $2, $3)`, [inspId, url, f.landlordUserId],
    )
    const vid = (await db.query<{ id: string }>(
      `SELECT id FROM unit_inspection_videos WHERE video_url = $1`, [url])).rows[0].id

    await expect(db.query(`DELETE FROM unit_inspection_videos WHERE id = $1`, [vid])).rejects.toThrow(/immutable/i)
    await expect(db.query(`UPDATE unit_inspection_videos SET video_url = '/x' WHERE id = $1`, [vid])).rejects.toThrow(/immutable/i)
    // deleting the parent inspection is blocked too (FK RESTRICT) — videos survive
    await expect(db.query(`DELETE FROM unit_inspections WHERE id = $1`, [inspId])).rejects.toThrow()
    // metadata (thumbnail) stays editable
    await db.query(`UPDATE unit_inspection_videos SET thumbnail_url = '/t.jpg' WHERE id = $1`, [vid])
    const still = await db.query(`SELECT id FROM unit_inspection_videos WHERE id = $1`, [vid])
    expect(still.rows).toHaveLength(1)
  })

  it('lets a tenant upload to their own inspection and see it under /videos/mine', async () => {
    const f = await seedFixture()
    const inspId = await createInspection(f, { inspectionType: 'move_in', tenantId: f.tenantId })
    const up = await request(buildApp())
      .post(`/api/inspections/${inspId}/videos`)
      .set('Authorization', `Bearer ${f.tenantToken}`)
      .field('title', 'My move-in clip')
      .attach('file', Buffer.from('tenantclip'), { filename: 't.mp4', contentType: 'video/mp4' })
    expect(up.status).toBe(200)

    const mine = await request(buildApp())
      .get('/api/inspections/videos/mine')
      .set('Authorization', `Bearer ${f.tenantToken}`)
    expect(mine.status).toBe(200)
    const found = mine.body.data.find((v: any) => v.title === 'My move-in clip')
    expect(found).toBeTruthy()
    expect(found.unit_number).toBeTruthy()
  })

  it('serves a video to its uploader and the unit landlord, but not a stranger', async () => {
    const f = await seedFixture()
    const inspId = await createInspection(f, { inspectionType: 'move_in', tenantId: f.tenantId })
    const up = await request(buildApp())
      .post(`/api/inspections/${inspId}/videos`)
      .set('Authorization', `Bearer ${f.tenantToken}`)
      .attach('file', Buffer.from('clipdata'), { filename: 'c.mp4', contentType: 'video/mp4' })
    const fileUrl = up.body.data.url

    const asUploader = await request(buildApp()).get(fileUrl).set('Authorization', `Bearer ${f.tenantToken}`)
    expect(asUploader.status).toBe(200)
    const asLandlord = await request(buildApp()).get(fileUrl).set('Authorization', `Bearer ${f.landlordToken}`)
    expect(asLandlord.status).toBe(200)

    const stranger = await seedFixture() // different tenant + landlord
    const asStranger = await request(buildApp()).get(fileUrl).set('Authorization', `Bearer ${stranger.tenantToken}`)
    expect(asStranger.status).toBe(403)
  })
})

// ─── Agent inspection tools (create + write conditions) ───────────
// The landlord agent can start an inspection and record item conditions;
// signing/finalizing stay with the humans. These exercise the real tools
// against the real DB via the seeded landlord fixture.
describe('agent inspection tools', () => {
  async function unitNumberOf(unitId: string): Promise<string> {
    const r = await db.query<{ unit_number: string }>('SELECT unit_number FROM units WHERE id=$1', [unitId])
    return r.rows[0].unit_number
  }
  const landlordActor = (f: SeedFixture) => ({ userId: f.landlordUserId, role: 'landlord', profileId: f.landlordId })

  it('create_inspection: creates a draft + seeds the checklist for the landlord’s own unit', async () => {
    const f = await seedFixture()
    const unit = await unitNumberOf(f.unitId)
    const res: any = await createInspectionTool.execute({ unit, inspectionType: 'periodic' }, landlordActor(f))
    expect(res.ok).toBe(true)
    expect(res.seededItems).toBeGreaterThan(0)
    const insp = await db.query('SELECT inspection_type, status, landlord_id FROM unit_inspections WHERE id=$1', [res.inspectionId])
    expect(insp.rows[0]).toMatchObject({ inspection_type: 'periodic', status: 'draft', landlord_id: f.landlordId })
    const items = await db.query<{ n: number }>('SELECT COUNT(*)::int AS n FROM unit_inspection_items WHERE inspection_id=$1', [res.inspectionId])
    expect(items.rows[0].n).toBe(res.seededItems)
  })

  it('create_inspection: refuses a unit the landlord does not own', async () => {
    const f = await seedFixture()
    const res: any = await createInspectionTool.execute({ unit: 'U-nope00', inspectionType: 'periodic' }, landlordActor(f))
    expect(res.ok).toBe(false)
  })

  it('set_inspection_item_condition: upserts a condition on the landlord’s own draft (no duplicate row)', async () => {
    const f = await seedFixture()
    const unit = await unitNumberOf(f.unitId)
    const created: any = await createInspectionTool.execute({ unit, inspectionType: 'periodic' }, landlordActor(f))
    const res: any = await setItemConditionTool.execute(
      { inspectionId: created.inspectionId, area: 'Kitchen', itemLabel: 'Sink', condition: 'damaged', notes: 'leak', estimatedRepairCost: 120 },
      landlordActor(f),
    )
    expect(res.ok).toBe(true)
    // Re-record the same area+item → updates in place, not a second row.
    const res2: any = await setItemConditionTool.execute(
      { inspectionId: created.inspectionId, area: 'Kitchen', itemLabel: 'Sink', condition: 'good' },
      landlordActor(f),
    )
    expect(res2.ok).toBe(true)
    const row = await db.query<{ n: number; c: string }>(
      'SELECT COUNT(*)::int AS n, MAX(condition) AS c FROM unit_inspection_items WHERE inspection_id=$1 AND area=$2 AND item_label=$3',
      [created.inspectionId, 'Kitchen', 'Sink'],
    )
    expect(row.rows[0].n).toBe(1)
    expect(row.rows[0].c).toBe('good')
  })

  it('set_inspection_item_condition: rejects a cross-landlord inspection', async () => {
    const f = await seedFixture()
    const unit = await unitNumberOf(f.unitId)
    const created: any = await createInspectionTool.execute({ unit, inspectionType: 'periodic' }, landlordActor(f))
    const stranger = { userId: 'x', role: 'landlord', profileId: randomUUID() }
    const res: any = await setItemConditionTool.execute(
      { inspectionId: created.inspectionId, area: 'Kitchen', itemLabel: 'Sink', condition: 'good' },
      stranger,
    )
    expect(res.ok).toBe(false)
  })

  it('set_inspection_item_condition: refuses once the inspection is no longer a draft', async () => {
    const f = await seedFixture()
    const unit = await unitNumberOf(f.unitId)
    const created: any = await createInspectionTool.execute({ unit, inspectionType: 'periodic' }, landlordActor(f))
    await db.query(`UPDATE unit_inspections SET status='landlord_signed' WHERE id=$1`, [created.inspectionId])
    const res: any = await setItemConditionTool.execute(
      { inspectionId: created.inspectionId, area: 'Kitchen', itemLabel: 'Sink', condition: 'good' },
      landlordActor(f),
    )
    expect(res.ok).toBe(false)
  })
})
