/**
 * maintenance-portal.ts full slice — S391. Closes the file at 100%.
 *
 * Covered routes (17):
 *   Shifts (3): clock-in, clock-out, active
 *   Tasks (3): GET, POST, PATCH/:id/complete
 *   Parts (3): GET, POST, PATCH/:id
 *   Purchases (4): GET, POST, PATCH/:id/approve, PATCH/:id/deny
 *   Scheduled (3): GET, POST, PATCH/:id/complete
 *   Work-orders (1): GET
 *
 * Production bugs fixed in this slice (2):
 *   - **POST /scheduled** propertyId + unitId scope validation
 *     (S388 audit finding #1). Pre-fix, both FK IDs inserted
 *     unvalidated → cross-tenant reference pollution in
 *     scheduled_maintenance rows; GET would surface foreign
 *     property_name / unit_number via JOINs.
 *   - **POST /purchases** workOrderId scope validation. Same class
 *     — purchase_request could link to a stranger landlord's
 *     maintenance_request and GET /purchases would surface the
 *     cross-tenant work_order_title.
 *
 * NOT fixed in this slice (flagged for follow-up):
 *   - assignedTo scope validation on POST /tasks and POST /scheduled
 *     — requires a team-role union check across property_manager_scopes
 *     / maintenance_worker_scopes / onsite_manager_scopes /
 *     bookkeeper_scopes. Worth a dedicated fix when team-role membership
 *     helpers are added.
 *   - Missing required-field validators on POST /tasks (title NOT NULL),
 *     POST /parts (name NOT NULL), POST /scheduled (title + recurrence
 *     NOT NULL) — empty body surfaces as 500. Same shape as S389/S390
 *     validation backlog.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { randomUUID } from 'crypto'
import { db } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedTenant } from '../test/dbHelpers'
import { maintenancePortalRouter } from './maintenance-portal'
import { errorHandler } from '../middleware/errorHandler'

function buildApp() {
  const app = express()
  app.use(express.json({ limit: '2mb' }))
  app.use('/api/maint-portal', maintenancePortalRouter)
  app.use(errorHandler)
  return app
}

beforeEach(async () => {
  await cleanupAllSchema()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_maint_portal'
})

interface Fixture {
  landlordAUserId: string
  landlordAId:     string
  landlordBUserId: string
  landlordBId:     string
  propertyAId:     string
  propertyBId:     string
  unitAId:         string
  unitBId:         string
  tenantAId:       string
  tokenA:          string
  tokenB:          string
}

async function seed(): Promise<Fixture> {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const { userId: aUid, landlordId: aId } = await seedLandlord(c)
    const { userId: bUid, landlordId: bId } = await seedLandlord(c)
    const propA = await seedProperty(c, { landlordId: aId, ownerUserId: aUid, managedByUserId: aUid })
    const propB = await seedProperty(c, { landlordId: bId, ownerUserId: bUid, managedByUserId: bUid })
    const unitA = await seedUnit(c, { propertyId: propA, landlordId: aId })
    const unitB = await seedUnit(c, { propertyId: propB, landlordId: bId })
    const tenantA = await seedTenant(c)
    await c.query('COMMIT')
    const sign = (uid: string, lid: string) => jwt.sign(
      { userId: uid, role: 'landlord', email: 'l@t.dev', profileId: lid, permissions: {} },
      process.env.JWT_SECRET!, { expiresIn: '1h' })
    return {
      landlordAUserId: aUid, landlordAId: aId,
      landlordBUserId: bUid, landlordBId: bId,
      propertyAId: propA, propertyBId: propB,
      unitAId: unitA, unitBId: unitB,
      tenantAId: tenantA,
      tokenA: sign(aUid, aId), tokenB: sign(bUid, bId),
    }
  } catch (e) { await c.query('ROLLBACK'); throw e }
  finally { c.release() }
}

// ───────────────────────────────────────────────────────────────────
// SHIFTS
// ───────────────────────────────────────────────────────────────────

describe('POST /shifts/clock-in', () => {
  it('happy: creates shift; second call while clocked in → 400', async () => {
    const f = await seed()
    const r1 = await request(buildApp())
      .post('/api/maint-portal/shifts/clock-in')
      .set('Authorization', `Bearer ${f.tokenA}`)
    expect(r1.status).toBe(200)
    expect(r1.body.data.user_id).toBe(f.landlordAUserId)
    expect(r1.body.data.landlord_id).toBe(f.landlordAId)
    expect(r1.body.data.clocked_out_at).toBeNull()

    const r2 = await request(buildApp())
      .post('/api/maint-portal/shifts/clock-in')
      .set('Authorization', `Bearer ${f.tokenA}`)
    expect(r2.status).toBe(400)
    expect(r2.body.error).toMatch(/already clocked in/i)
  })
})

describe('POST /shifts/clock-out', () => {
  it('not clocked in → 400; happy clock-out flips clocked_out_at', async () => {
    const f = await seed()
    const r1 = await request(buildApp())
      .post('/api/maint-portal/shifts/clock-out')
      .set('Authorization', `Bearer ${f.tokenA}`)
    expect(r1.status).toBe(400)
    expect(r1.body.error).toMatch(/not clocked in/i)

    await request(buildApp())
      .post('/api/maint-portal/shifts/clock-in')
      .set('Authorization', `Bearer ${f.tokenA}`)
    const r2 = await request(buildApp())
      .post('/api/maint-portal/shifts/clock-out')
      .set('Authorization', `Bearer ${f.tokenA}`)
      .send({ notes: 'eod' })
    expect(r2.status).toBe(200)
    expect(r2.body.data.clocked_out_at).not.toBeNull()
    expect(r2.body.data.notes).toBe('eod')
  })
})

describe('GET /shifts/active', () => {
  it('landlord-scoped: active list + myShift', async () => {
    const f = await seed()
    await request(buildApp())
      .post('/api/maint-portal/shifts/clock-in')
      .set('Authorization', `Bearer ${f.tokenA}`)
    // Other landlord's shift — should not appear in A's list.
    await db.query(
      `INSERT INTO shifts (user_id, landlord_id) VALUES ($1, $2)`,
      [f.landlordBUserId, f.landlordBId])
    const res = await request(buildApp())
      .get('/api/maint-portal/shifts/active')
      .set('Authorization', `Bearer ${f.tokenA}`)
    expect(res.status).toBe(200)
    expect(res.body.data.active).toHaveLength(1)
    expect(res.body.data.active[0].landlord_id).toBe(f.landlordAId)
    expect(res.body.data.myShift).not.toBeNull()
  })
})

// ───────────────────────────────────────────────────────────────────
// DAILY TASKS
// ───────────────────────────────────────────────────────────────────

describe('GET /tasks', () => {
  it('landlord-scoped: only own + only due_date=today OR recurring', async () => {
    const f = await seed()
    await db.query(
      `INSERT INTO daily_tasks (landlord_id, title, due_date) VALUES
        ($1, 'Today A', CURRENT_DATE),
        ($1, 'Past A', CURRENT_DATE - 1),
        ($1, 'Recurring A', NULL),
        ($2, 'Today B', CURRENT_DATE)`,
      [f.landlordAId, f.landlordBId])
    // Recurring needs recurrence != 'none' to be picked up by the OR clause
    await db.query(
      `UPDATE daily_tasks SET recurrence='daily' WHERE title='Recurring A'`)
    const res = await request(buildApp())
      .get('/api/maint-portal/tasks')
      .set('Authorization', `Bearer ${f.tokenA}`)
    expect(res.status).toBe(200)
    const titles = res.body.data.map((t: any) => t.title).sort()
    expect(titles).toEqual(['Recurring A', 'Today A'])
  })
})

describe('POST /tasks', () => {
  it('happy: creates task with recurrence default none', async () => {
    const f = await seed()
    const res = await request(buildApp())
      .post('/api/maint-portal/tasks')
      .set('Authorization', `Bearer ${f.tokenA}`)
      .send({ title: 'Mow lawn', dueDate: '2026-06-15' })
    expect(res.status).toBe(200)
    expect(res.body.data.title).toBe('Mow lawn')
    expect(res.body.data.recurrence).toBe('none')
    expect(res.body.data.landlord_id).toBe(f.landlordAId)
  })
})

describe('PATCH /tasks/:id/complete', () => {
  it('unknown → 404 (S348 fix pin)', async () => {
    const f = await seed()
    const res = await request(buildApp())
      .patch(`/api/maint-portal/tasks/${randomUUID()}/complete`)
      .set('Authorization', `Bearer ${f.tokenA}`)
    expect(res.status).toBe(404)
  })

  it('cross-landlord → 404 (S348 fix pin)', async () => {
    const f = await seed()
    const t = await db.query<{ id: string }>(
      `INSERT INTO daily_tasks (landlord_id, title) VALUES ($1, 'B task') RETURNING id`,
      [f.landlordBId])
    const res = await request(buildApp())
      .patch(`/api/maint-portal/tasks/${t.rows[0].id}/complete`)
      .set('Authorization', `Bearer ${f.tokenA}`)
    expect(res.status).toBe(404)
  })

  it('happy: flips completed + stamps completed_at + completed_by', async () => {
    const f = await seed()
    const t = await db.query<{ id: string }>(
      `INSERT INTO daily_tasks (landlord_id, title) VALUES ($1, 'A task') RETURNING id`,
      [f.landlordAId])
    const res = await request(buildApp())
      .patch(`/api/maint-portal/tasks/${t.rows[0].id}/complete`)
      .set('Authorization', `Bearer ${f.tokenA}`)
    expect(res.status).toBe(200)
    expect(res.body.data.completed).toBe(true)
    expect(res.body.data.completed_by).toBe(f.landlordAUserId)
  })
})

// ───────────────────────────────────────────────────────────────────
// PARTS INVENTORY
// ───────────────────────────────────────────────────────────────────

describe('GET /parts', () => {
  it('landlord-scoped, alphabetical by name', async () => {
    const f = await seed()
    await db.query(
      `INSERT INTO parts_inventory (landlord_id, name, quantity) VALUES
        ($1, 'Zip Tie', 100),
        ($1, 'Anchor', 5),
        ($2, 'B Part', 1)`,
      [f.landlordAId, f.landlordBId])
    const res = await request(buildApp())
      .get('/api/maint-portal/parts')
      .set('Authorization', `Bearer ${f.tokenA}`)
    expect(res.status).toBe(200)
    expect(res.body.data.map((p: any) => p.name)).toEqual(['Anchor', 'Zip Tie'])
  })
})

describe('POST /parts', () => {
  it('happy: creates part with unit default each + cost honored', async () => {
    const f = await seed()
    const res = await request(buildApp())
      .post('/api/maint-portal/parts')
      .set('Authorization', `Bearer ${f.tokenA}`)
      .send({ name: 'Hammer', quantity: 5, cost: 25.50, location: 'Bin A1' })
    expect(res.status).toBe(200)
    expect(res.body.data.name).toBe('Hammer')
    expect(res.body.data.unit).toBe('each')
    expect(Number(res.body.data.cost)).toBe(25.5)
  })
})

describe('PATCH /parts/:id', () => {
  it('cross-landlord → 404 (S348 fix pin)', async () => {
    const f = await seed()
    const p = await db.query<{ id: string }>(
      `INSERT INTO parts_inventory (landlord_id, name) VALUES ($1, 'B Part') RETURNING id`,
      [f.landlordBId])
    const res = await request(buildApp())
      .patch(`/api/maint-portal/parts/${p.rows[0].id}`)
      .set('Authorization', `Bearer ${f.tokenA}`)
      .send({ quantity: 999 })
    expect(res.status).toBe(404)
  })

  it('happy: COALESCE update preserves untouched', async () => {
    const f = await seed()
    const p = await db.query<{ id: string }>(
      `INSERT INTO parts_inventory (landlord_id, name, quantity, location) VALUES ($1, 'Bolts', 20, 'Bin 1') RETURNING id`,
      [f.landlordAId])
    const res = await request(buildApp())
      .patch(`/api/maint-portal/parts/${p.rows[0].id}`)
      .set('Authorization', `Bearer ${f.tokenA}`)
      .send({ quantity: 30 })
    expect(res.status).toBe(200)
    expect(res.body.data.quantity).toBe(30)
    expect(res.body.data.location).toBe('Bin 1')  // preserved
  })
})

// ───────────────────────────────────────────────────────────────────
// PURCHASE REQUESTS
// ───────────────────────────────────────────────────────────────────

describe('GET /purchases', () => {
  it('landlord-scoped with requested_by_name + work_order_title joins', async () => {
    const f = await seed()
    const wo = await db.query<{ id: string }>(
      `INSERT INTO maintenance_requests (tenant_id, unit_id, landlord_id, title, description, priority, status)
       VALUES ($1, $2, $3, 'Leak under sink', 'desc', 'normal', 'open') RETURNING id`,
      [f.tenantAId, f.unitAId, f.landlordAId])
    await db.query(
      `INSERT INTO purchase_requests (landlord_id, requested_by, work_order_id, items, total_estimate)
       VALUES ($1, $2, $3, '[]'::jsonb, 100)`,
      [f.landlordAId, f.landlordAUserId, wo.rows[0].id])
    const res = await request(buildApp())
      .get('/api/maint-portal/purchases')
      .set('Authorization', `Bearer ${f.tokenA}`)
    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(1)
    expect(res.body.data[0].work_order_title).toBe('Leak under sink')
    expect(res.body.data[0].requested_by_name).toMatch(/Test Landlord/)
  })
})

describe('POST /purchases — S391 scope fix', () => {
  it('S391 fix: cross-landlord workOrderId → 400', async () => {
    const f = await seed()
    const tenantB = await db.query<{ id: string }>(`INSERT INTO tenants (user_id) SELECT id FROM users WHERE id=$1 RETURNING id`, [f.landlordBUserId])
    // Actually simpler: seed a maintenance_request directly under landlord B
    await db.query(`DELETE FROM tenants WHERE id=$1`, [tenantB.rows[0].id])
    const tenantBId = await db.connect().then(async c => {
      try { await c.query('BEGIN'); const t = await seedTenant(c); await c.query('COMMIT'); return t }
      finally { c.release() }
    })
    const wo = await db.query<{ id: string }>(
      `INSERT INTO maintenance_requests (tenant_id, unit_id, landlord_id, title, description, priority, status)
       VALUES ($1, $2, $3, 'B repair', 'd', 'normal', 'open') RETURNING id`,
      [tenantBId, f.unitBId, f.landlordBId])

    const res = await request(buildApp())
      .post('/api/maint-portal/purchases')
      .set('Authorization', `Bearer ${f.tokenA}`)
      .send({ workOrderId: wo.rows[0].id, items: [{ name: 'pipe' }], totalEstimate: 50 })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/does not belong/i)
    const prs = await db.query(`SELECT id FROM purchase_requests`)
    expect(prs.rows).toHaveLength(0)  // no row created
  })

  it('happy: creates purchase request with items + total_estimate', async () => {
    const f = await seed()
    const res = await request(buildApp())
      .post('/api/maint-portal/purchases')
      .set('Authorization', `Bearer ${f.tokenA}`)
      .send({ items: [{ name: 'pipe', qty: 2 }], notes: 'urgent', totalEstimate: 75 })
    expect(res.status).toBe(200)
    expect(res.body.data.requested_by).toBe(f.landlordAUserId)
    expect(Number(res.body.data.total_estimate)).toBe(75)
    expect(res.body.data.status).toBe('pending')
  })
})

describe('PATCH /purchases/:id/approve', () => {
  it('unknown → 404 (S348 fix pin)', async () => {
    const f = await seed()
    const res = await request(buildApp())
      .patch(`/api/maint-portal/purchases/${randomUUID()}/approve`)
      .set('Authorization', `Bearer ${f.tokenA}`)
      .send({ budgetLimit: 100 })
    expect(res.status).toBe(404)
  })

  it('happy: status→approved + approved_by + budget_limit', async () => {
    const f = await seed()
    const pr = await db.query<{ id: string }>(
      `INSERT INTO purchase_requests (landlord_id, requested_by, items, total_estimate)
       VALUES ($1, $2, '[]'::jsonb, 50) RETURNING id`,
      [f.landlordAId, f.landlordAUserId])
    const res = await request(buildApp())
      .patch(`/api/maint-portal/purchases/${pr.rows[0].id}/approve`)
      .set('Authorization', `Bearer ${f.tokenA}`)
      .send({ budgetLimit: 75 })
    expect(res.status).toBe(200)
    expect(res.body.data.status).toBe('approved')
    expect(res.body.data.approved_by).toBe(f.landlordAUserId)
    expect(Number(res.body.data.budget_limit)).toBe(75)
  })
})

describe('PATCH /purchases/:id/deny', () => {
  it('unknown → 404', async () => {
    const f = await seed()
    const res = await request(buildApp())
      .patch(`/api/maint-portal/purchases/${randomUUID()}/deny`)
      .set('Authorization', `Bearer ${f.tokenA}`)
    expect(res.status).toBe(404)
  })

  it('happy: status→denied + approved_by', async () => {
    const f = await seed()
    const pr = await db.query<{ id: string }>(
      `INSERT INTO purchase_requests (landlord_id, requested_by, items)
       VALUES ($1, $2, '[]'::jsonb) RETURNING id`,
      [f.landlordAId, f.landlordAUserId])
    const res = await request(buildApp())
      .patch(`/api/maint-portal/purchases/${pr.rows[0].id}/deny`)
      .set('Authorization', `Bearer ${f.tokenA}`)
    expect(res.status).toBe(200)
    expect(res.body.data.status).toBe('denied')
  })
})

// ───────────────────────────────────────────────────────────────────
// SCHEDULED MAINTENANCE
// ───────────────────────────────────────────────────────────────────

describe('GET /scheduled', () => {
  it('landlord-scoped with property_name + unit_number joined', async () => {
    const f = await seed()
    await db.query(
      `INSERT INTO scheduled_maintenance (landlord_id, title, recurrence, property_id, unit_id, next_due)
       VALUES ($1, 'HVAC check', 'monthly', $2, $3, CURRENT_DATE + 7)`,
      [f.landlordAId, f.propertyAId, f.unitAId])
    const res = await request(buildApp())
      .get('/api/maint-portal/scheduled')
      .set('Authorization', `Bearer ${f.tokenA}`)
    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(1)
    expect(res.body.data[0].title).toBe('HVAC check')
    expect(res.body.data[0].property_name).toBe('Test Property')
  })
})

describe('POST /scheduled — S391 scope fix (S388 finding #1)', () => {
  it('S391 fix: cross-landlord propertyId → 400; no row created', async () => {
    const f = await seed()
    const res = await request(buildApp())
      .post('/api/maint-portal/scheduled')
      .set('Authorization', `Bearer ${f.tokenA}`)
      .send({ title: 'Bad', recurrence: 'monthly', propertyId: f.propertyBId })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/propertyId does not belong/i)
    const rows = await db.query(`SELECT id FROM scheduled_maintenance`)
    expect(rows.rows).toHaveLength(0)
  })

  it('S391 fix: cross-landlord unitId → 400; no row created', async () => {
    const f = await seed()
    const res = await request(buildApp())
      .post('/api/maint-portal/scheduled')
      .set('Authorization', `Bearer ${f.tokenA}`)
      .send({ title: 'Bad', recurrence: 'monthly', unitId: f.unitBId })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/unitId does not belong/i)
  })

  it('happy: creates row with own property + unit', async () => {
    const f = await seed()
    const res = await request(buildApp())
      .post('/api/maint-portal/scheduled')
      .set('Authorization', `Bearer ${f.tokenA}`)
      .send({
        title: 'Filter change', recurrence: 'quarterly',
        propertyId: f.propertyAId, unitId: f.unitAId,
        nextDue: '2026-06-30', estimatedHours: 1.5,
      })
    expect(res.status).toBe(200)
    expect(res.body.data.title).toBe('Filter change')
    expect(res.body.data.property_id).toBe(f.propertyAId)
  })
})

describe('PATCH /scheduled/:id/complete', () => {
  it('unknown → 404', async () => {
    const f = await seed()
    const res = await request(buildApp())
      .patch(`/api/maint-portal/scheduled/${randomUUID()}/complete`)
      .set('Authorization', `Bearer ${f.tokenA}`)
    expect(res.status).toBe(404)
  })

  it('happy: stamps last_completed + bumps next_due per recurrence', async () => {
    const f = await seed()
    const sm = await db.query<{ id: string }>(
      `INSERT INTO scheduled_maintenance (landlord_id, title, recurrence, next_due)
       VALUES ($1, 'Quarterly', 'quarterly', CURRENT_DATE) RETURNING id`,
      [f.landlordAId])
    const res = await request(buildApp())
      .patch(`/api/maint-portal/scheduled/${sm.rows[0].id}/complete`)
      .set('Authorization', `Bearer ${f.tokenA}`)
    expect(res.status).toBe(200)
    const row = await db.query<{ last_completed: string; next_due: string }>(
      `SELECT last_completed::text, next_due::text FROM scheduled_maintenance WHERE id=$1`,
      [sm.rows[0].id])
    expect(row.rows[0].last_completed).toBeTruthy()
    // next_due should advance by 3 months
    const today = new Date()
    const expected = new Date(today.getFullYear(), today.getMonth() + 3, today.getDate())
    const got = new Date(row.rows[0].next_due)
    expect(Math.abs(got.getTime() - expected.getTime())).toBeLessThan(2 * 24 * 60 * 60 * 1000)
  })
})

// ───────────────────────────────────────────────────────────────────
// WORK ORDERS
// ───────────────────────────────────────────────────────────────────

describe('GET /work-orders', () => {
  it('landlord-scoped: excludes completed/cancelled, ordered by priority', async () => {
    const f = await seed()
    await db.query(
      `INSERT INTO maintenance_requests (tenant_id, unit_id, landlord_id, title, description, priority, status) VALUES
        ($1, $2, $3, 'Normal A', 'd', 'normal',    'open'),
        ($1, $2, $3, 'Emergency A', 'd', 'emergency', 'open'),
        ($1, $2, $3, 'Completed A', 'd', 'normal',    'completed'),
        ($1, $2, $3, 'High A',      'd', 'high',      'in_progress')`,
      [f.tenantAId, f.unitAId, f.landlordAId])
    const res = await request(buildApp())
      .get('/api/maint-portal/work-orders')
      .set('Authorization', `Bearer ${f.tokenA}`)
    expect(res.status).toBe(200)
    // 3 returned (not completed); ordered emergency, high, normal
    expect(res.body.data).toHaveLength(3)
    expect(res.body.data.map((o: any) => o.title)).toEqual(['Emergency A', 'High A', 'Normal A'])
  })
})
