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
import { addBusinessDays } from '../services/moveOutInspections'

const {
  emitInspectionFinalizedEventsMock,
  notifyReadyMock, notifyTenantSignedMock, notifyFinalizedMock,
  createNotificationMock,
  getResponsiblePartyMock,
} = vi.hoisted(() => ({
  emitInspectionFinalizedEventsMock: vi.fn(async () => {}),
  notifyReadyMock:                   vi.fn(async () => {}),
  notifyTenantSignedMock:            vi.fn(async () => {}),
  notifyFinalizedMock:               vi.fn(async () => {}),
  createNotificationMock:            vi.fn(async () => {}),
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
    createNotification:             createNotificationMock,
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
  createNotificationMock.mockClear()
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

async function insertItem(inspectionId: string, area: string, item: string, cond: string | null) {
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

// S573: satisfy the completeness gate — set any un-inspected item to 'good',
// add a note to fair/damaged items, and add one photo per area. Leaves already-
// set conditions untouched (so comparison scenarios keep their intent).
async function makeComplete(inspectionId: string) {
  await db.query(`UPDATE unit_inspection_items SET condition='good' WHERE inspection_id=$1 AND condition IS NULL`, [inspectionId])
  await db.query(`UPDATE unit_inspection_items SET notes='documented' WHERE inspection_id=$1 AND condition IN ('fair','damaged_missing') AND (notes IS NULL OR notes='')`, [inspectionId])
  const uploader = await db.query<{ uid: string }>(
    `SELECT us.id AS uid FROM unit_inspections i JOIN landlords l ON l.id=i.landlord_id JOIN users us ON us.id=l.user_id WHERE i.id=$1`, [inspectionId])
  const uid = uploader.rows[0]?.uid
  const areas = await db.query<{ area: string; id: string }>(
    `SELECT DISTINCT ON (i.area) i.area, i.id FROM unit_inspection_items i
      WHERE i.inspection_id=$1
        AND NOT EXISTS (SELECT 1 FROM unit_inspection_photos p JOIN unit_inspection_items i2 ON i2.id=p.item_id
                         WHERE i2.inspection_id=$1 AND i2.area=i.area)
      ORDER BY i.area, i.id`, [inspectionId])
  for (const a of areas.rows) {
    await db.query(`INSERT INTO unit_inspection_photos (inspection_id, item_id, photo_url, uploaded_by) VALUES ($1,$2,'/x.jpg',$3)`,
      [inspectionId, a.id, uid])
  }
}

// ─── GET /inspections/preview (S573) ──────────────────────────────
describe('GET /inspections/preview — pre-inspection review', () => {
  it('resolves the master template for the unit without creating anything', async () => {
    const f = await seedFixture()
    const before = await db.query<{ c: string }>(`SELECT COUNT(*)::text AS c FROM unit_inspections WHERE unit_id=$1`, [f.unitId])
    const res = await request(buildApp())
      .get(`/api/inspections/preview?unitId=${f.unitId}&inspectionType=move_in`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data.checklist.length).toBeGreaterThan(0)
    expect(res.body.data.itemCount).toBeGreaterThan(0)
    // no side effect — no inspection row created
    const after = await db.query<{ c: string }>(`SELECT COUNT(*)::text AS c FROM unit_inspections WHERE unit_id=$1`, [f.unitId])
    expect(after.rows[0].c).toBe(before.rows[0].c)
  })

  it('reflects the unit multi-level + ADA flags in the resolved areas', async () => {
    const f = await seedFixture()
    await db.query(`UPDATE units SET unit_type='single_family', is_multi_level=true, is_ada_accessible=true WHERE id=$1`, [f.unitId])
    const res = await request(buildApp())
      .get(`/api/inspections/preview?unitId=${f.unitId}`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
    expect(res.status).toBe(200)
    const areas = (res.body.data.checklist as any[]).map(a => a.area)
    const stairItems = (res.body.data.checklist as any[]).find(a => a.area === 'Hallways & stairs')?.items ?? []
    expect(stairItems).toContain('Staircase & treads')
    expect(areas).toContain('Accessibility')
    expect(areas).toContain('Yard & grounds')
    expect(res.body.data.unit.isMultiLevel).toBe(true)
    expect(res.body.data.unit.isAdaAccessible).toBe(true)
  })

  it('403s a landlord previewing another landlord\'s unit', async () => {
    const f = await seedFixture()
    const otherToken = jwt.sign(
      { userId: randomUUID(), role: 'landlord', email: 'other@test.dev', profileId: randomUUID(), permissions: {} },
      process.env.JWT_SECRET!, { expiresIn: '1h' },
    )
    const res = await request(buildApp())
      .get(`/api/inspections/preview?unitId=${f.unitId}`)
      .set('Authorization', `Bearer ${otherToken}`)
    expect(res.status).toBe(403)
  })
})

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

  it('seeds the standard walkthrough checklist as un-inspected (null) items on create', async () => {
    const f = await seedFixture()
    const res = await request(buildApp())
      .post('/api/inspections')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ unitId: f.unitId, leaseId: f.leaseId, tenantId: f.tenantId, inspectionType: 'move_in' })
    expect(res.status).toBe(200)
    expect(res.body.data.seededItems).toBeGreaterThan(0)
    const items = await db.query<{ area: string; condition: string | null }>(
      `SELECT area, condition FROM unit_inspection_items WHERE inspection_id = $1`, [res.body.data.id],
    )
    expect(items.rows.length).toBe(res.body.data.seededItems)
    // S573: seeded items start un-inspected (null), never 'na'.
    expect(items.rows.every((r) => r.condition === null)).toBe(true)
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
      .send({ area: 'kitchen', itemLabel: 'sink', condition: 'damaged_missing', notes: 'cracked' })
    const items = await db.query<{ condition: string; notes: string | null }>(
      `SELECT condition, notes FROM unit_inspection_items WHERE inspection_id = $1`, [id],
    )
    expect(items.rows).toHaveLength(1)
    expect(items.rows[0].condition).toBe('damaged_missing')
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

  it('S550: landlord signs a move-out with an UNSIGNED tenant → landlord_signed (tenant sig only gates move-in)', async () => {
    const f = await seedFixture()
    const id = await createInspection(f, { inspectionType: 'move_out' })
    const res = await request(buildApp())
      .post(`/api/inspections/${id}/sign`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
    expect(res.status).toBe(200)
    // Staff-conducted under entry notice — the tenant gets notice, not a
    // veto. Landlord signature alone reaches landlord_signed, so the
    // deposit-return gate can never be stalled by a tenant who won't sign.
    expect(res.body.data.status).toBe('landlord_signed')
    const fin = await request(buildApp())
      .post(`/api/inspections/${id}/finalize`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
    expect(fin.status).toBe(200)
    expect(fin.body.data.status).toBe('finalized')
  })

  it('S550: landlord signs a tenant-assigned periodic without the tenant → landlord_signed', async () => {
    const f = await seedFixture()
    const id = await createInspection(f, { inspectionType: 'periodic' })
    const res = await request(buildApp())
      .post(`/api/inspections/${id}/sign`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data.status).toBe('landlord_signed')
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

  it('S573: finalize files a summary report to the inspection + the tenant Documents', async () => {
    const f = await seedFixture()
    const id = await createInspection(f, { status: 'landlord_signed' })
    const res = await request(buildApp())
      .post(`/api/inspections/${id}/finalize`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
    expect(res.status).toBe(200)
    // report_url set on the inspection (landlord reporting)
    const row = await db.query<{ report_url: string }>(`SELECT report_url FROM unit_inspections WHERE id=$1`, [id])
    expect(row.rows[0].report_url).toMatch(/^\/api\/inspections\/report-files\/inspection-report-/)
    // a documents row filed to the tenant (surfaces in their Documents tab)
    const docs = await db.query<{ type: string; tenant_id: string }>(
      `SELECT type, tenant_id FROM documents WHERE url=$1`, [row.rows[0].report_url])
    expect(docs.rows.length).toBe(1)
    expect(docs.rows[0].type).toBe('move_in_checklist')
    expect(docs.rows[0].tenant_id).toBe(f.tenantId)
    // the tenant can fetch their own report PDF
    const filename = row.rows[0].report_url.split('/').pop()!
    const dl = await request(buildApp())
      .get(`/api/inspections/report-files/${filename}`)
      .set('Authorization', `Bearer ${f.tenantToken}`)
    expect(dl.status).toBe(200)
    expect(dl.headers['content-type']).toContain('application/pdf')
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
    await makeComplete(moveOutId)

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
    await insertItem(moveOutId, 'kitchen', 'sink',  'damaged_missing')   // worse
    await insertItem(moveOutId, 'kitchen', 'stove', 'good')
    await makeComplete(moveOutId)

    const res = await request(buildApp())
      .post(`/api/inspections/${moveOutId}/finalize`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data.matches_move_in).toBe(false)
    expect(res.body.data.damage_documented).toBe(true)
  })

  it('S573: completeness gate blocks finalize when an item is un-inspected (null)', async () => {
    const f = await seedFixture()
    const moveOutId = await createInspection(f, { inspectionType: 'move_out', status: 'landlord_signed' })
    await insertItem(moveOutId, 'kitchen', 'sink', 'good')
    await insertItem(moveOutId, 'kitchen', 'dishwasher', null)   // un-inspected
    // add a photo for the area so ONLY the null condition blocks finalize
    await makeComplete(moveOutId)
    await db.query(`UPDATE unit_inspection_items SET condition=NULL WHERE inspection_id=$1 AND item_label='dishwasher'`, [moveOutId])
    const res = await request(buildApp())
      .post(`/api/inspections/${moveOutId}/finalize`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
    expect(res.status).toBe(409)
    expect(res.body.error).toMatch(/not complete/i)
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
    await insertItem(moveOutId, 'kitchen', 'new_lamp', 'damaged_missing')
    await makeComplete(moveOutId)

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
      { inspectionId: created.inspectionId, area: 'Kitchen', itemLabel: 'Sink', condition: 'damaged_missing', notes: 'leak', estimatedRepairCost: 120 },
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

// ─── POST /inspections/:id/flag-suspicious — S549 verdict loop ────

describe('POST /inspections/:id/flag-suspicious', () => {
  it('closes the tenant-submitted periodic inspection and schedules an in-person follow-up', async () => {
    const f = await seedFixture()
    const inspId = await createInspection(f, { inspectionType: 'periodic', status: 'tenant_signed' })
    const res = await request(buildApp())
      .post(`/api/inspections/${inspId}/flag-suspicious`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ reason: 'Photos appear reused from the move-in inspection' })
    expect(res.status).toBe(200)
    const followupId = res.body.data.followupInspectionId
    expect(followupId).toBeTruthy()
    expect(res.body.data.scheduledFor).toBe(addBusinessDays(new Date().toISOString().slice(0, 10), 3))

    // Flagged record: closed with flag metadata + link to the follow-up.
    const flagged = (await db.query<any>(
      `SELECT status, flagged_suspicious_at, flagged_by_user_id, flag_reason, followup_inspection_id
         FROM unit_inspections WHERE id = $1`, [inspId],
    )).rows[0]
    expect(flagged.status).toBe('cancelled')
    expect(flagged.flagged_suspicious_at).toBeTruthy()
    expect(flagged.flagged_by_user_id).toBe(f.landlordUserId)
    expect(flagged.flag_reason).toContain('reused')
    expect(flagged.followup_inspection_id).toBe(followupId)

    // Follow-up: in-person (no tenant_id), periodic, compares against the
    // flagged submission, checklist seeded.
    const followup = (await db.query<any>(
      `SELECT inspection_type, status, tenant_id, lease_id, comparison_inspection_id,
              to_char(scheduled_for, 'YYYY-MM-DD') AS scheduled_day
         FROM unit_inspections WHERE id = $1`, [followupId],
    )).rows[0]
    expect(followup.inspection_type).toBe('periodic')
    expect(followup.status).toBe('draft')
    expect(followup.tenant_id).toBeNull()
    expect(followup.lease_id).toBe(f.leaseId)
    expect(followup.comparison_inspection_id).toBe(inspId)
    expect(followup.scheduled_day).toBe(res.body.data.scheduledFor)
    const items = await db.query(
      `SELECT id FROM unit_inspection_items WHERE inspection_id = $1`, [followupId],
    )
    expect(items.rows.length).toBeGreaterThan(0)
  })

  it('notifies landlord-side with the reason and the tenant with neutral copy only', async () => {
    const f = await seedFixture()
    const inspId = await createInspection(f, { inspectionType: 'periodic', status: 'tenant_signed' })
    // Flag as a property manager so the landlord is a distinct recipient.
    const pmUserId = randomUUID()
    await db.query(
      `INSERT INTO users (id, email, password_hash, role, first_name, last_name)
       VALUES ($1, $2, 'x', 'property_manager', 'Pat', 'Manager')`,
      [pmUserId, `pm-${pmUserId.slice(0, 8)}@test.dev`],
    )
    // S550 property lock: a worker with no scope row reaches nothing.
    await db.query(
      `INSERT INTO property_manager_scopes (user_id, landlord_id, all_properties, permissions)
       VALUES ($1, $2, TRUE, '{"inspections.manage": true}'::jsonb)`,
      [pmUserId, f.landlordId],
    )
    const pmToken = jwt.sign(
      { userId: pmUserId, role: 'property_manager', email: 'pm@test.dev', profileId: f.landlordId,
        landlordId: f.landlordId, permissions: { 'inspections.manage': true } },
      process.env.JWT_SECRET!, { expiresIn: '1h' },
    )
    const res = await request(buildApp())
      .post(`/api/inspections/${inspId}/flag-suspicious`)
      .set('Authorization', `Bearer ${pmToken}`)
      .send({ reason: 'Bathroom damage cropped out of frame' })
    expect(res.status).toBe(200)

    const calls = createNotificationMock.mock.calls.map((c: any[]) => c[0])
    const landlordCall = calls.find((c: any) => c.userId === f.landlordUserId)
    expect(landlordCall).toBeTruthy()
    expect(landlordCall.type).toBe('inspection_flagged_suspicious')
    expect(landlordCall.body).toContain('cropped out')
    const tenantCall = calls.find((c: any) => c.userId === f.tenantUserId)
    expect(tenantCall).toBeTruthy()
    expect(tenantCall.type).toBe('inspection_scheduled')
    expect(tenantCall.body).not.toContain('suspicious')
    expect(tenantCall.body).not.toContain('cropped out')
  })

  it('rejects non-periodic, tenant-less, terminal, and repeat flags', async () => {
    const f = await seedFixture()
    const app = buildApp()
    const auth = (r: request.Test) => r.set('Authorization', `Bearer ${f.landlordToken}`)

    const moveIn = await createInspection(f, { inspectionType: 'move_in', status: 'tenant_signed' })
    expect((await auth(request(app).post(`/api/inspections/${moveIn}/flag-suspicious`)).send({ reason: 'nope' })).status).toBe(409)

    const noTenant = await createInspection(f, { inspectionType: 'periodic', tenantId: null })
    expect((await auth(request(app).post(`/api/inspections/${noTenant}/flag-suspicious`)).send({ reason: 'nope' })).status).toBe(409)

    const finalized = await createInspection(f, { inspectionType: 'periodic', status: 'finalized' })
    expect((await auth(request(app).post(`/api/inspections/${finalized}/flag-suspicious`)).send({ reason: 'nope' })).status).toBe(409)

    const flagged = await createInspection(f, { inspectionType: 'periodic', status: 'tenant_signed' })
    expect((await auth(request(app).post(`/api/inspections/${flagged}/flag-suspicious`)).send({ reason: 'first flag' })).status).toBe(200)
    expect((await auth(request(app).post(`/api/inspections/${flagged}/flag-suspicious`)).send({ reason: 'second flag' })).status).toBe(409)
  })

  it('tenant cannot flag, and flag metadata is redacted from tenant reads', async () => {
    const f = await seedFixture()
    const app = buildApp()
    const inspId = await createInspection(f, { inspectionType: 'periodic', status: 'tenant_signed' })

    const deny = await request(app)
      .post(`/api/inspections/${inspId}/flag-suspicious`)
      .set('Authorization', `Bearer ${f.tenantToken}`)
      .send({ reason: 'self flag' })
    expect(deny.status).toBe(403)

    await request(app)
      .post(`/api/inspections/${inspId}/flag-suspicious`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ reason: 'Internal-only reason text' })

    const tenantDetail = await request(app)
      .get(`/api/inspections/${inspId}`)
      .set('Authorization', `Bearer ${f.tenantToken}`)
    expect(tenantDetail.status).toBe(200)
    expect(tenantDetail.body.data.flag_reason).toBeUndefined()
    expect(tenantDetail.body.data.flagged_suspicious_at).toBeUndefined()
    expect(JSON.stringify(tenantDetail.body.data)).not.toContain('Internal-only')

    const tenantList = await request(app)
      .get(`/api/inspections`)
      .set('Authorization', `Bearer ${f.tenantToken}`)
    const listRow = tenantList.body.data.find((r: any) => r.id === inspId)
    expect(listRow).toBeTruthy()
    expect(listRow.flagged_suspicious_at).toBeUndefined()

    const landlordDetail = await request(app)
      .get(`/api/inspections/${inspId}`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
    expect(landlordDetail.body.data.flag_reason).toBe('Internal-only reason text')
  })
})

// ─── S550: tenant signature is move-in only; periodic is SUBMITTED ─

describe('S550 — tenant sign restriction + POST /inspections/:id/submit', () => {
  it('tenant cannot sign a periodic or move-out (signature is move-in only)', async () => {
    const f = await seedFixture()
    const app = buildApp()
    for (const inspectionType of ['periodic', 'move_out'] as const) {
      const id = await createInspection(f, { inspectionType })
      const res = await request(app)
        .post(`/api/inspections/${id}/sign`)
        .set('Authorization', `Bearer ${f.tenantToken}`)
      expect(res.status).toBe(409)
    }
  })

  it('tenant submits a periodic with photos → tenant_signed with NO signature row, front desk notified', async () => {
    const f = await seedFixture()
    const id = await createInspection(f, { inspectionType: 'periodic' })
    await db.query(
      `INSERT INTO unit_inspection_photos (inspection_id, photo_url, captured_live, uploaded_by)
       VALUES ($1, '/api/inspections/photo-files/test.jpg', TRUE, $2)`,
      [id, f.tenantUserId],
    )
    getResponsiblePartyMock.mockResolvedValue({
      primaries: [{ user_id: f.landlordUserId, email: 'll@test.dev' }],
    })
    const res = await request(buildApp())
      .post(`/api/inspections/${id}/submit`)
      .set('Authorization', `Bearer ${f.tenantToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data.status).toBe('tenant_signed')

    const row = (await db.query<any>(
      `SELECT status, conducted_at FROM unit_inspections WHERE id = $1`, [id],
    )).rows[0]
    expect(row.status).toBe('tenant_signed')
    expect(row.conducted_at).toBeTruthy()
    // The whole point: submission writes NO signature.
    const sigs = await db.query(
      `SELECT 1 FROM unit_inspection_signatures WHERE inspection_id = $1`, [id],
    )
    expect(sigs.rows.length).toBe(0)
    const notif = createNotificationMock.mock.calls
      .map((c: any[]) => c[0])
      .find((c: any) => c.type === 'inspection_submitted')
    expect(notif).toBeTruthy()
    expect(notif.userId).toBe(f.landlordUserId)
  })

  it('submit guards: photos required, periodic only, tenant only, draft only', async () => {
    const f = await seedFixture()
    const app = buildApp()

    const noPhotos = await createInspection(f, { inspectionType: 'periodic' })
    await insertItem(noPhotos, 'Kitchen', 'Sink', 'good')  // an item with no area photo → incomplete
    expect((await request(app).post(`/api/inspections/${noPhotos}/submit`)
      .set('Authorization', `Bearer ${f.tenantToken}`)).status).toBe(409)

    const moveIn = await createInspection(f, { inspectionType: 'move_in' })
    expect((await request(app).post(`/api/inspections/${moveIn}/submit`)
      .set('Authorization', `Bearer ${f.tenantToken}`)).status).toBe(409)

    const asLandlord = await createInspection(f, { inspectionType: 'periodic' })
    expect((await request(app).post(`/api/inspections/${asLandlord}/submit`)
      .set('Authorization', `Bearer ${f.landlordToken}`)).status).toBe(403)

    const submitted = await createInspection(f, { inspectionType: 'periodic', status: 'tenant_signed' })
    expect((await request(app).post(`/api/inspections/${submitted}/submit`)
      .set('Authorization', `Bearer ${f.tenantToken}`)).status).toBe(409)
  })
})

// ─── S550: property lock + dwelling-ownership checklist catalog ────

describe('S550 — property lock on inspections', () => {
  async function seedScopedStaff(f: SeedFixture, propertyIds: string[]) {
    const staffUserId = randomUUID()
    await db.query(
      `INSERT INTO users (id, email, password_hash, role, first_name, last_name)
       VALUES ($1, $2, 'x', 'onsite_manager', 'Scoped', 'Staff')`,
      [staffUserId, `staff-${staffUserId.slice(0, 8)}@test.dev`],
    )
    await db.query(
      `INSERT INTO onsite_manager_scopes (user_id, landlord_id, all_properties, property_ids, permissions)
       VALUES ($1, $2, FALSE, $3::uuid[], '{"inspections.view": true, "inspections.manage": true, "inspections.create": true}'::jsonb)`,
      [staffUserId, f.landlordId, propertyIds],
    )
    return jwt.sign(
      { userId: staffUserId, role: 'onsite_manager', email: 's@test.dev', profileId: f.landlordId,
        landlordId: f.landlordId,
        permissions: { 'inspections.view': true, 'inspections.manage': true, 'inspections.create': true } },
      process.env.JWT_SECRET!, { expiresIn: '1h' },
    )
  }

  async function seedSecondProperty(f: SeedFixture): Promise<{ propertyId: string; unitId: string; inspectionId: string }> {
    const client = await db.connect()
    try {
      await client.query('BEGIN')
      const propertyId = await seedProperty(client, { landlordId: f.landlordId, ownerUserId: f.landlordUserId, managedByUserId: f.landlordUserId })
      const unitId = await seedUnit(client, { propertyId, landlordId: f.landlordId })
      await client.query('COMMIT')
      const ins = await db.query<{ id: string }>(
        `INSERT INTO unit_inspections (unit_id, landlord_id, inspection_type, status)
         VALUES ($1, $2, 'periodic', 'draft') RETURNING id`,
        [unitId, f.landlordId],
      )
      return { propertyId, unitId, inspectionId: ins.rows[0].id }
    } catch (e) { await client.query('ROLLBACK'); throw e }
    finally { client.release() }
  }

  it('scoped staff list only their assigned properties; the landlord sees everything', async () => {
    const f = await seedFixture()
    const inScope = await createInspection(f, { inspectionType: 'periodic' })
    const other = await seedSecondProperty(f)
    const staffToken = await seedScopedStaff(f, [f.propertyId])
    const app = buildApp()

    const staffList = await request(app).get('/api/inspections')
      .set('Authorization', `Bearer ${staffToken}`)
    const staffIds = staffList.body.data.map((r: any) => r.id)
    expect(staffIds).toContain(inScope)
    expect(staffIds).not.toContain(other.inspectionId)

    const llList = await request(app).get('/api/inspections')
      .set('Authorization', `Bearer ${f.landlordToken}`)
    const llIds = llList.body.data.map((r: any) => r.id)
    expect(llIds).toContain(inScope)
    expect(llIds).toContain(other.inspectionId)
  })

  it('scoped staff get 403 on detail, create, and flag for an out-of-scope property', async () => {
    const f = await seedFixture()
    const other = await seedSecondProperty(f)
    const staffToken = await seedScopedStaff(f, [f.propertyId])
    const app = buildApp()

    expect((await request(app).get(`/api/inspections/${other.inspectionId}`)
      .set('Authorization', `Bearer ${staffToken}`)).status).toBe(403)

    expect((await request(app).post('/api/inspections')
      .set('Authorization', `Bearer ${staffToken}`)
      .send({ unitId: other.unitId, inspectionType: 'periodic' })).status).toBe(403)

    // In-scope still works end to end.
    const ok = await request(app).post('/api/inspections')
      .set('Authorization', `Bearer ${staffToken}`)
      .send({ unitId: f.unitId, inspectionType: 'periodic' })
    expect(ok.status).toBe(200)
  })
})

describe('S550 — dwelling-ownership checklist catalog', () => {
  async function seededAreas(f: SeedFixture, unitType: string, ownership: string, bedrooms: number, bathrooms = 1): Promise<string[]> {
    await db.query(
      `UPDATE units SET unit_type=$1, dwelling_ownership=$2, bedrooms=$3, bathrooms=$4 WHERE id=$5`,
      [unitType, ownership, bedrooms, bathrooms, f.unitId],
    )
    const res = await request(buildApp()).post('/api/inspections')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ unitId: f.unitId, inspectionType: 'periodic' })
    expect(res.status).toBe(200)
    const rows = await db.query<{ area: string }>(
      `SELECT DISTINCT area FROM unit_inspection_items WHERE inspection_id = $1`,
      [res.body.data.id],
    )
    return rows.rows.map(r => r.area)
  }

  it('tenant-owned rv_spot: site only — no rig interior, never bedrooms', async () => {
    const f = await seedFixture()
    const areas = await seededAreas(f, 'rv_spot', 'tenant', 0)
    expect(areas).toContain('RV site')
    expect(areas).not.toContain('RV interior')
    expect(areas.some(a => a.startsWith('Bedroom'))).toBe(false)
  })

  it('park-owned rv_spot: site plus the rig — still never bedrooms', async () => {
    const f = await seedFixture()
    const areas = await seededAreas(f, 'rv_spot', 'landlord', 2)
    expect(areas).toContain('RV site')
    expect(areas).toContain('RV interior')
    expect(areas).toContain('RV systems')
    expect(areas.some(a => a.startsWith('Bedroom'))).toBe(false)
  })

  it('tenant-owned mobile_home: lot/space only — never inside their home', async () => {
    const f = await seedFixture()
    const areas = await seededAreas(f, 'mobile_home', 'tenant', 3)
    expect(areas).toContain('Yard & grounds')
    expect(areas).not.toContain('Kitchen')
    expect(areas.some(a => a.startsWith('Bedroom'))).toBe(false)
  })

  it('park-owned mobile_home: full interior sized to the REAL bedroom count', async () => {
    const f = await seedFixture()
    const areas = await seededAreas(f, 'mobile_home', 'landlord', 2)
    expect(areas).toContain('Kitchen')
    expect(areas).toContain('Bedroom 1')
    expect(areas).toContain('Bedroom 2')
    expect(areas).not.toContain('Bedroom 3')
  })

  it('single_family: four real bedrooms means four bedroom areas', async () => {
    const f = await seedFixture()
    const areas = await seededAreas(f, 'single_family', 'landlord', 4)
    expect(areas).toContain('Bedroom 4')
    expect(areas).not.toContain('Bedroom 5' as any)
  })

  it('bathrooms are sized to the REAL count — 2.5 baths = three areas, last marked half', async () => {
    const f = await seedFixture()
    const areas = await seededAreas(f, 'single_family', 'landlord', 3, 2.5)
    expect(areas).toContain('Bathroom 1')
    expect(areas).toContain('Bathroom 2')
    expect(areas).toContain('Bathroom 3 (half)')
    expect(areas).not.toContain('Bathroom 4')
    // A one-bath unit keeps the plain single area.
    const oneBath = await seededAreas(f, 'apartment', 'landlord', 1, 1)
    expect(oneBath).toContain('Bathroom')
    expect(oneBath).not.toContain('Bathroom 1')
  })

  it('every interior checklist covers kitchen and living/dining', async () => {
    const f = await seedFixture()
    const areas = await seededAreas(f, 'apartment', 'landlord', 1)
    expect(areas).toContain('Kitchen')
    expect(areas).toContain('Living / dining')
  })
})

describe('S550 — tenant on-the-go issue reporting', () => {
  it('tenant adds an ad-hoc finding to their own draft periodic', async () => {
    const f = await seedFixture()
    const inspId = await createInspection(f, { inspectionType: 'periodic' })
    const res = await request(buildApp())
      .post(`/api/inspections/${inspId}/items`)
      .set('Authorization', `Bearer ${f.tenantToken}`)
      .send({ area: 'Reported issues', itemLabel: 'Bedroom window is broken', condition: 'damaged_missing', notes: 'Bedroom window is broken' })
    expect(res.status).toBe(200)
    const row = (await db.query<any>(
      `SELECT area, item_label, condition FROM unit_inspection_items
        WHERE inspection_id = $1 AND area = 'Reported issues'`, [inspId],
    )).rows[0]
    expect(row.item_label).toBe('Bedroom window is broken')
    expect(row.condition).toBe('damaged_missing')
  })
})

// ─── S550: conditional-fee assessment on the move-out inspection ───

describe('S550 — conditional lease fees assessed at move-out', () => {
  async function addConditionalFee(leaseId: string, amount: number): Promise<string> {
    const r = await db.query<{ id: string }>(
      `INSERT INTO lease_fees
         (lease_id, fee_type, amount, due_timing, is_refundable, description, condition_text)
       VALUES ($1, 'other_fee', $2, 'move_out', FALSE, 'Carpet cleaning',
               'Carpets professionally cleaned within 3 days of move-out, else this charge applies.')
       RETURNING id`,
      [leaseId, amount],
    )
    return r.rows[0].id
  }

  async function createMoveOutWithCondition(f: SeedFixture, feeId: string) {
    const res = await request(buildApp())
      .post('/api/inspections')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ unitId: f.unitId, leaseId: f.leaseId, tenantId: f.tenantId, inspectionType: 'move_out' })
    expect(res.status).toBe(200)
    const item = (await db.query<{ id: string; area: string; item_label: string }>(
      `SELECT id, area, item_label FROM unit_inspection_items
        WHERE inspection_id = $1 AND lease_fee_id = $2`,
      [res.body.data.id, feeId],
    )).rows[0]
    expect(item).toBeTruthy()
    expect(item.area).toBe('Lease conditions')
    expect(item.item_label).toContain('Carpet cleaning')
    return { inspectionId: res.body.data.id as string, itemLabel: item.item_label }
  }

  async function assessAndFinalize(f: SeedFixture, inspectionId: string, itemLabel: string, condition: string) {
    const app = buildApp()
    const upsert = await request(app)
      .post(`/api/inspections/${inspectionId}/items`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ area: 'Lease conditions', itemLabel, condition })
    expect(upsert.status).toBe(200)
    await makeComplete(inspectionId)
    expect((await request(app).post(`/api/inspections/${inspectionId}/sign`)
      .set('Authorization', `Bearer ${f.landlordToken}`)).status).toBe(200)
    expect((await request(app).post(`/api/inspections/${inspectionId}/finalize`)
      .set('Authorization', `Bearer ${f.landlordToken}`)).status).toBe(200)
  }

  it('item marked damaged at finalize → condition FAILED (fee will sweep)', async () => {
    const f = await seedFixture()
    const feeId = await addConditionalFee(f.leaseId, 150)
    const { inspectionId, itemLabel } = await createMoveOutWithCondition(f, feeId)
    await assessAndFinalize(f, inspectionId, itemLabel, 'damaged_missing')
    const fee = (await db.query<any>(
      `SELECT condition_result, condition_assessed_at, condition_assessed_by
         FROM lease_fees WHERE id = $1`, [feeId],
    )).rows[0]
    expect(fee.condition_result).toBe('failed')
    expect(fee.condition_assessed_at).toBeTruthy()
    expect(fee.condition_assessed_by).toBe(f.landlordUserId)
  })

  it('item marked good → condition MET; S573: every seeded condition gets assessed (no un-inspected path)', async () => {
    const f = await seedFixture()
    const metFee = await addConditionalFee(f.leaseId, 150)
    const otherFee = await addConditionalFee(f.leaseId, 75)
    const { inspectionId } = await createMoveOutWithCondition(f, metFee)
    const metLabel = (await db.query<{ item_label: string }>(
      `SELECT item_label FROM unit_inspection_items WHERE inspection_id=$1 AND lease_fee_id=$2`,
      [inspectionId, metFee],
    )).rows[0].item_label
    // assessAndFinalize marks metFee 'good' and makeComplete fills every other
    // seeded condition to 'good' — completeness requires all items inspected.
    await assessAndFinalize(f, inspectionId, metLabel, 'good')
    const rows = (await db.query<any>(
      `SELECT id, condition_result FROM lease_fees WHERE id = ANY($1::uuid[])`,
      [[metFee, otherFee]],
    )).rows
    expect(rows.find((r: any) => r.id === metFee).condition_result).toBe('met')
    // The other conditional fee was seeded as an item too → now also assessed 'met'.
    expect(rows.find((r: any) => r.id === otherFee).condition_result).toBe('met')
  })
})
