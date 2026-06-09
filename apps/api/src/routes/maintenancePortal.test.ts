/**
 * maintenance-portal route slice — S348.
 *
 * Pins admin-side maintenance staff routes: shifts (clock-in/out),
 * daily tasks, parts inventory, purchase requests, scheduled
 * maintenance. Owner-role JWT (landlord) bypasses each requirePerm
 * gate via OWNER_ROLES; tests exercise the underlying SQL + landlord
 * scope rather than the per-permission allowlist.
 *
 * S348 fixes pinned here:
 *   - F1: /scheduled/:id/complete previously used WHERE id=$1 with no
 *         landlord scope on both the SELECT and UPDATE — cross-tenant
 *         data leak + cross-tenant write. Now scoped on landlord_id.
 *   - F2: PATCH /tasks/:id/complete, /parts/:id, /purchases/:id/approve,
 *         /purchases/:id/deny returned 200 with data:null when the row
 *         didn't exist or belonged to another landlord. Now 404.
 *
 * Surfaces not exercised here (mechanical SELECTs with landlord-scoped
 * WHERE, same pattern as the covered POSTs; per-surface tests would be
 * low yield):
 *   - GET /tasks, GET /parts, GET /purchases, GET /scheduled, GET /work-orders
 */

import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { randomUUID } from 'crypto'
import { db } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit } from '../test/dbHelpers'
import { maintenancePortalRouter } from './maintenance-portal'
import { errorHandler } from '../middleware/errorHandler'

function buildApp() {
  const app = express()
  app.use(express.json({ limit: '2mb' }))
  app.use('/api/maintenance-portal', maintenancePortalRouter)
  app.use(errorHandler)
  return app
}

beforeEach(async () => {
  await cleanupAllSchema()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_mp'
})

interface MPFixture {
  landlordUserId: string
  landlordId:     string
  token:          string
}

async function seedMPFixture(): Promise<MPFixture> {
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    const { userId: landlordUserId, landlordId } = await seedLandlord(client)
    await client.query('COMMIT')
    const token = jwt.sign(
      { userId: landlordUserId, role: 'landlord', email: 'll@test.dev', profileId: landlordId, permissions: {} },
      process.env.JWT_SECRET!, { expiresIn: '1h' },
    )
    return { landlordUserId, landlordId, token }
  } catch (e) { await client.query('ROLLBACK'); throw e }
  finally { client.release() }
}

describe('POST /api/maintenance-portal/shifts/clock-in + clock-out', () => {
  it('happy path: clock-in inserts shift, second call returns 400', async () => {
    const f = await seedMPFixture()
    const r1 = await request(buildApp())
      .post('/api/maintenance-portal/shifts/clock-in')
      .set('Authorization', `Bearer ${f.token}`).send({})
    expect(r1.status).toBe(200)
    expect(r1.body.data.user_id).toBe(f.landlordUserId)
    expect(r1.body.data.landlord_id).toBe(f.landlordId)
    expect(r1.body.data.clocked_out_at).toBeNull()

    const r2 = await request(buildApp())
      .post('/api/maintenance-portal/shifts/clock-in')
      .set('Authorization', `Bearer ${f.token}`).send({})
    expect(r2.status).toBe(400)
    expect(r2.body.error).toMatch(/Already clocked in/)
  })

  it('clock-out without active shift → 400', async () => {
    const f = await seedMPFixture()
    const res = await request(buildApp())
      .post('/api/maintenance-portal/shifts/clock-out')
      .set('Authorization', `Bearer ${f.token}`).send({ notes: 'done' })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/Not clocked in/)
  })

  it('clock-out persists notes + stamps clocked_out_at', async () => {
    const f = await seedMPFixture()
    await request(buildApp())
      .post('/api/maintenance-portal/shifts/clock-in')
      .set('Authorization', `Bearer ${f.token}`).send({})
    const out = await request(buildApp())
      .post('/api/maintenance-portal/shifts/clock-out')
      .set('Authorization', `Bearer ${f.token}`).send({ notes: 'wrapped up' })
    expect(out.status).toBe(200)
    expect(out.body.data.notes).toBe('wrapped up')
    expect(out.body.data.clocked_out_at).not.toBeNull()
  })
})

describe('PATCH /api/maintenance-portal/tasks/:id/complete', () => {
  it('stamps completed_by + completed_at on landlord-scoped row', async () => {
    const f = await seedMPFixture()
    const created = await request(buildApp())
      .post('/api/maintenance-portal/tasks')
      .set('Authorization', `Bearer ${f.token}`)
      .send({ title: 'Sweep lobby' })
    expect(created.status).toBe(200)
    const taskId = created.body.data.id

    const done = await request(buildApp())
      .patch(`/api/maintenance-portal/tasks/${taskId}/complete`)
      .set('Authorization', `Bearer ${f.token}`).send({})
    expect(done.status).toBe(200)
    expect(done.body.data.completed).toBe(true)
    expect(done.body.data.completed_by).toBe(f.landlordUserId)
    expect(done.body.data.completed_at).not.toBeNull()
  })

  it('S348 F2: cross-landlord task id → 404 (was 200 data:null pre-fix)', async () => {
    const a = await seedMPFixture()
    const b = await seedMPFixture()
    const bTask = await request(buildApp())
      .post('/api/maintenance-portal/tasks')
      .set('Authorization', `Bearer ${b.token}`)
      .send({ title: "b's task" })
    const bTaskId = bTask.body.data.id

    // a tries to complete b's task
    const res = await request(buildApp())
      .patch(`/api/maintenance-portal/tasks/${bTaskId}/complete`)
      .set('Authorization', `Bearer ${a.token}`).send({})
    expect(res.status).toBe(404)

    // b's task untouched
    const row = await db.query<{ completed: boolean }>(
      `SELECT completed FROM daily_tasks WHERE id = $1`, [bTaskId])
    expect(row.rows[0].completed).toBe(false)
  })
})

describe('POST /api/maintenance-portal/parts + PATCH /parts/:id', () => {
  it('POST happy path: inserts row scoped to landlord with defaults', async () => {
    const f = await seedMPFixture()
    const res = await request(buildApp())
      .post('/api/maintenance-portal/parts')
      .set('Authorization', `Bearer ${f.token}`)
      .send({ name: 'Hex bolt #4', quantity: 50, minQuantity: 10, cost: 0.25 })
    expect(res.status).toBe(200)
    expect(res.body.data.landlord_id).toBe(f.landlordId)
    expect(res.body.data.quantity).toBe(50)
    expect(res.body.data.min_quantity).toBe(10)
    expect(res.body.data.unit).toBe('each')  // default
  })

  it('S348 F2: PATCH /parts/:id with cross-landlord id → 404', async () => {
    const a = await seedMPFixture()
    const b = await seedMPFixture()
    const bPart = await request(buildApp())
      .post('/api/maintenance-portal/parts')
      .set('Authorization', `Bearer ${b.token}`)
      .send({ name: "b's part", quantity: 5 })
    const bPartId = bPart.body.data.id

    const res = await request(buildApp())
      .patch(`/api/maintenance-portal/parts/${bPartId}`)
      .set('Authorization', `Bearer ${a.token}`)
      .send({ quantity: 999 })
    expect(res.status).toBe(404)

    // b's row untouched
    const row = await db.query<{ quantity: number }>(
      `SELECT quantity FROM parts_inventory WHERE id = $1`, [bPartId])
    expect(row.rows[0].quantity).toBe(5)
  })
})

describe('POST /api/maintenance-portal/purchases + PATCH approve/deny', () => {
  it('POST happy path: items JSONB roundtrip + landlord/requester stamped', async () => {
    const f = await seedMPFixture()
    const items = [{ sku: 'X-100', qty: 2, est: 12.50 }, { sku: 'Y-200', qty: 1, est: 4 }]
    const res = await request(buildApp())
      .post('/api/maintenance-portal/purchases')
      .set('Authorization', `Bearer ${f.token}`)
      .send({ items, notes: 'kitchen sink repair', totalEstimate: 29 })
    expect(res.status).toBe(200)
    expect(res.body.data.landlord_id).toBe(f.landlordId)
    expect(res.body.data.requested_by).toBe(f.landlordUserId)
    expect(res.body.data.status).toBe('pending')  // default
    expect(res.body.data.items).toEqual(items)    // jsonb roundtrip
    expect(Number(res.body.data.total_estimate)).toBe(29)
  })

  it('PATCH /:id/approve: flips status, stamps approver + budget_limit', async () => {
    const f = await seedMPFixture()
    const created = await request(buildApp())
      .post('/api/maintenance-portal/purchases')
      .set('Authorization', `Bearer ${f.token}`)
      .send({ items: [], totalEstimate: 100 })
    const prId = created.body.data.id

    const ap = await request(buildApp())
      .patch(`/api/maintenance-portal/purchases/${prId}/approve`)
      .set('Authorization', `Bearer ${f.token}`)
      .send({ budgetLimit: 150 })
    expect(ap.status).toBe(200)
    expect(ap.body.data.status).toBe('approved')
    expect(ap.body.data.approved_by).toBe(f.landlordUserId)
    expect(Number(ap.body.data.budget_limit)).toBe(150)
    expect(ap.body.data.approved_at).not.toBeNull()
  })

  it('S348 F2: PATCH /:id/deny on cross-landlord id → 404', async () => {
    const a = await seedMPFixture()
    const b = await seedMPFixture()
    const bPr = await request(buildApp())
      .post('/api/maintenance-portal/purchases')
      .set('Authorization', `Bearer ${b.token}`)
      .send({ items: [] })
    const bPrId = bPr.body.data.id

    const res = await request(buildApp())
      .patch(`/api/maintenance-portal/purchases/${bPrId}/deny`)
      .set('Authorization', `Bearer ${a.token}`).send({})
    expect(res.status).toBe(404)

    const row = await db.query<{ status: string }>(
      `SELECT status FROM purchase_requests WHERE id = $1`, [bPrId])
    expect(row.rows[0].status).toBe('pending')  // untouched
  })
})

describe('PATCH /api/maintenance-portal/scheduled/:id/complete', () => {
  // S348 F1: pre-fix the SELECT + UPDATE used WHERE id=$1 with no landlord
  // scope. Any caller with work_orders.complete (or owner role) could read
  // + mark complete any landlord's scheduled_maintenance row.

  it('happy path: weekly recurrence bumps next_due by 7 days, stamps last_completed=today', async () => {
    const f = await seedMPFixture()
    const created = await request(buildApp())
      .post('/api/maintenance-portal/scheduled')
      .set('Authorization', `Bearer ${f.token}`)
      .send({ title: 'Inspect filters', recurrence: 'weekly', nextDue: '2026-05-01' })
    const smId = created.body.data.id

    const res = await request(buildApp())
      .patch(`/api/maintenance-portal/scheduled/${smId}/complete`)
      .set('Authorization', `Bearer ${f.token}`).send({})
    expect(res.status).toBe(200)

    const row = await db.query<{ last_completed: string; next_due: string }>(
      `SELECT last_completed::text, next_due::text
         FROM scheduled_maintenance WHERE id=$1`, [smId])
    expect(row.rows[0].last_completed).not.toBeNull()
    // next_due = last_completed + 7 days (Postgres CURRENT_DATE + INTERVAL '7 days')
    const last = new Date(row.rows[0].last_completed + 'T00:00:00Z')
    const next = new Date(row.rows[0].next_due + 'T00:00:00Z')
    expect(Math.round((next.getTime() - last.getTime()) / 86400000)).toBe(7)
  })

  it('F1 fix: cross-landlord id → 404 (no data leak, no cross-tenant write)', async () => {
    const a = await seedMPFixture()
    const b = await seedMPFixture()
    const bSm = await request(buildApp())
      .post('/api/maintenance-portal/scheduled')
      .set('Authorization', `Bearer ${b.token}`)
      .send({ title: "b's filter check", recurrence: 'monthly', nextDue: '2026-06-01' })
    const bSmId = bSm.body.data.id

    const res = await request(buildApp())
      .patch(`/api/maintenance-portal/scheduled/${bSmId}/complete`)
      .set('Authorization', `Bearer ${a.token}`).send({})
    expect(res.status).toBe(404)

    // b's row untouched
    const row = await db.query<{ last_completed: string | null; next_due: string }>(
      `SELECT last_completed::text, next_due::text
         FROM scheduled_maintenance WHERE id=$1`, [bSmId])
    expect(row.rows[0].last_completed).toBeNull()
    expect(row.rows[0].next_due).toBe('2026-06-01')
  })

  it('unknown id → 404 (not silent success)', async () => {
    const f = await seedMPFixture()
    const fakeId = randomUUID()
    const res = await request(buildApp())
      .patch(`/api/maintenance-portal/scheduled/${fakeId}/complete`)
      .set('Authorization', `Bearer ${f.token}`).send({})
    expect(res.status).toBe(404)
  })
})

describe('GET /api/maintenance-portal/shifts/active', () => {
  it('returns landlord-scoped active list + myShift for the calling user', async () => {
    const f = await seedMPFixture()
    await request(buildApp())
      .post('/api/maintenance-portal/shifts/clock-in')
      .set('Authorization', `Bearer ${f.token}`).send({})

    const res = await request(buildApp())
      .get('/api/maintenance-portal/shifts/active')
      .set('Authorization', `Bearer ${f.token}`)
    expect(res.status).toBe(200)
    expect(res.body.data.active.length).toBe(1)
    expect(res.body.data.active[0].user_id).toBe(f.landlordUserId)
    expect(res.body.data.myShift).not.toBeNull()
    expect(res.body.data.myShift.user_id).toBe(f.landlordUserId)
  })

  it('other landlord\'s active shifts not returned (landlord-scoped)', async () => {
    const a = await seedMPFixture()
    const b = await seedMPFixture()
    await request(buildApp())
      .post('/api/maintenance-portal/shifts/clock-in')
      .set('Authorization', `Bearer ${b.token}`).send({})

    const res = await request(buildApp())
      .get('/api/maintenance-portal/shifts/active')
      .set('Authorization', `Bearer ${a.token}`)
    expect(res.status).toBe(200)
    expect(res.body.data.active.length).toBe(0)
    expect(res.body.data.myShift).toBeNull()
  })
})
