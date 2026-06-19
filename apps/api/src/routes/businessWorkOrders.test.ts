/**
 * S498 — vehicles + work orders coverage (mechanic vertical).
 *
 * Covers both businessVehicles and businessWorkOrders endpoints to
 * exercise the cross-table flows (vehicle picked from work-order
 * create; convert-to-invoice writes a business_invoices row).
 */

import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { randomUUID } from 'crypto'
import { db } from '../db'
import { cleanupAllSchema } from '../test/dbHelpers'
import { businessVehiclesRouter } from './businessVehicles'
import { businessWorkOrdersRouter } from './businessWorkOrders'
import { errorHandler } from '../middleware/errorHandler'

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/business-vehicles', businessVehiclesRouter)
  app.use('/api/business-work-orders', businessWorkOrdersRouter)
  app.use(errorHandler)
  return app
}

beforeEach(async () => {
  await cleanupAllSchema()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_s498'
})

interface Fixture {
  ownerToken: string
  businessId: string
  customerId: string
  itemId: string
}

async function seedFixture(opts: {
  vehiclesEnabled?: boolean
  workOrdersEnabled?: boolean
  invoicingEnabled?: boolean
  itemStock?: number
  itemPrice?: number
} = {}): Promise<Fixture> {
  const hash = await bcrypt.hash('super-strong-password-12!', 12)
  const email = `o-${randomUUID()}@test.dev`
  const { rows: [u] } = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
     VALUES ($1, $2, 'business_owner', 'Biz', 'Owner', TRUE) RETURNING id`,
    [email, hash])
  const features = ['customers', 'staff', 'inventory']
  if (opts.vehiclesEnabled   !== false) features.push('customer_vehicles')
  if (opts.workOrdersEnabled !== false) features.push('work_orders')
  if (opts.invoicingEnabled  !== false) features.push('invoicing')
  const { rows: [b] } = await db.query<{ id: string }>(
    `INSERT INTO businesses (owner_user_id, name, business_type, email, enabled_features)
     VALUES ($1, 'Mechanic Co', 'mechanic_stationary', $2, $3) RETURNING id`,
    [u.id, email, features])
  const { rows: [c] } = await db.query<{ id: string }>(
    `INSERT INTO business_customers
       (business_id, customer_type, first_name, last_name,
        street1, city, state, zip)
     VALUES ($1, 'individual', 'Jane', 'Doe', '100 Elm', 'Phoenix', 'AZ', '85001')
     RETURNING id`, [b.id])
  const { rows: [item] } = await db.query<{ id: string }>(
    `INSERT INTO business_inventory_items
       (business_id, name, sku, cost_price, sell_price, tax_rate, stock_qty)
     VALUES ($1, 'Oil Filter', 'OIL-001', 4.00, $2, 0.0875, $3) RETURNING id`,
    [b.id, opts.itemPrice ?? 12.99, opts.itemStock ?? 20])
  const ownerToken = jwt.sign(
    { userId: u.id, role: 'business_owner', email, profileId: b.id, businessId: b.id },
    process.env.JWT_SECRET!, { expiresIn: '1h' })
  return { ownerToken, businessId: b.id, customerId: c.id, itemId: item.id }
}

const VALID_VIN = '1HGCM82633A123456'

// ═══════════════════════════════════════════════════════════════
//  Vehicles
// ═══════════════════════════════════════════════════════════════

describe('Vehicles — feature gate', () => {
  it('customer_vehicles off → 403', async () => {
    const f = await seedFixture({ vehiclesEnabled: false })
    const res = await request(buildApp())
      .get('/api/business-vehicles')
      .set('Authorization', `Bearer ${f.ownerToken}`)
    expect(res.status).toBe(403)
    expect(res.body.error).toMatch(/Vehicle tracking is not enabled/i)
  })
})

describe('POST /business-vehicles', () => {
  it('creates a vehicle linked to a customer', async () => {
    const f = await seedFixture()
    const res = await request(buildApp())
      .post('/api/business-vehicles')
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .send({
        customerId: f.customerId,
        vin: VALID_VIN, licensePlate: 'ABC123', licensePlateState: 'az',
        year: 2018, make: 'Honda', model: 'Civic', color: 'Silver',
        currentMileage: 78000,
      })
    expect(res.status).toBe(201)
    expect(res.body.data.vin).toBe(VALID_VIN)
    expect(res.body.data.license_plate_state).toBe('AZ')  // normalized
    expect(res.body.data.year).toBe(2018)
  })

  it('cross-business customer → 404', async () => {
    const a = await seedFixture()
    const b = await seedFixture()
    const res = await request(buildApp())
      .post('/api/business-vehicles')
      .set('Authorization', `Bearer ${a.ownerToken}`)
      .send({ customerId: b.customerId, vin: VALID_VIN })
    expect(res.status).toBe(404)
  })

  it('duplicate VIN within business → 409', async () => {
    const f = await seedFixture()
    await request(buildApp())
      .post('/api/business-vehicles')
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .send({ customerId: f.customerId, vin: VALID_VIN })
    const res = await request(buildApp())
      .post('/api/business-vehicles')
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .send({ customerId: f.customerId, vin: VALID_VIN })
    expect(res.status).toBe(409)
  })

  it('same VIN across businesses allowed', async () => {
    const a = await seedFixture()
    const b = await seedFixture()
    const r1 = await request(buildApp())
      .post('/api/business-vehicles')
      .set('Authorization', `Bearer ${a.ownerToken}`)
      .send({ customerId: a.customerId, vin: VALID_VIN })
    expect(r1.status).toBe(201)
    const r2 = await request(buildApp())
      .post('/api/business-vehicles')
      .set('Authorization', `Bearer ${b.ownerToken}`)
      .send({ customerId: b.customerId, vin: VALID_VIN })
    expect(r2.status).toBe(201)
  })

  it('invalid VIN format → 400', async () => {
    const f = await seedFixture()
    const res = await request(buildApp())
      .post('/api/business-vehicles')
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .send({ customerId: f.customerId, vin: 'INVALID' })
    expect(res.status).toBe(400)
  })

  it('vehicle with no VIN allowed (multiple allowed)', async () => {
    const f = await seedFixture()
    const r1 = await request(buildApp())
      .post('/api/business-vehicles')
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .send({ customerId: f.customerId, make: 'Ford', model: 'F-150' })
    expect(r1.status).toBe(201)
    const r2 = await request(buildApp())
      .post('/api/business-vehicles')
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .send({ customerId: f.customerId, make: 'Toyota', model: 'Tacoma' })
    expect(r2.status).toBe(201)
  })
})

describe('GET /business-vehicles', () => {
  it('lists own + filters by customer + search by plate/make', async () => {
    const f = await seedFixture()
    await request(buildApp())
      .post('/api/business-vehicles')
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .send({ customerId: f.customerId, make: 'Honda', model: 'Civic', licensePlate: 'ABC123' })
    await request(buildApp())
      .post('/api/business-vehicles')
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .send({ customerId: f.customerId, make: 'Ford', model: 'F-150', licensePlate: 'XYZ789' })
    const r1 = await request(buildApp())
      .get('/api/business-vehicles?q=honda')
      .set('Authorization', `Bearer ${f.ownerToken}`)
    expect(r1.body.data.length).toBe(1)
    expect(r1.body.data[0].make).toBe('Honda')
    const r2 = await request(buildApp())
      .get('/api/business-vehicles?q=xyz')
      .set('Authorization', `Bearer ${f.ownerToken}`)
    expect(r2.body.data.length).toBe(1)
  })

  it('archived excluded by default; includeArchived returns', async () => {
    const f = await seedFixture()
    const c = await request(buildApp())
      .post('/api/business-vehicles')
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .send({ customerId: f.customerId, make: 'Honda' })
    await request(buildApp())
      .post(`/api/business-vehicles/${c.body.data.id}/archive`)
      .set('Authorization', `Bearer ${f.ownerToken}`)
    const def = await request(buildApp())
      .get('/api/business-vehicles')
      .set('Authorization', `Bearer ${f.ownerToken}`)
    expect(def.body.data.length).toBe(0)
    const all = await request(buildApp())
      .get('/api/business-vehicles?includeArchived=true')
      .set('Authorization', `Bearer ${f.ownerToken}`)
    expect(all.body.data.length).toBe(1)
  })
})

// ═══════════════════════════════════════════════════════════════
//  Work orders — create
// ═══════════════════════════════════════════════════════════════

describe('Work orders — feature gate', () => {
  it('work_orders off → 403', async () => {
    const f = await seedFixture({ workOrdersEnabled: false })
    const res = await request(buildApp())
      .post('/api/business-work-orders')
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .send({ customerId: f.customerId })
    expect(res.status).toBe(403)
  })
})

describe('POST /business-work-orders', () => {
  it('creates with sequential WO-NNNNNN', async () => {
    const f = await seedFixture()
    const r1 = await request(buildApp())
      .post('/api/business-work-orders')
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .send({ customerId: f.customerId, complaint: 'Oil change' })
    expect(r1.status).toBe(201)
    expect(r1.body.data.wo_number).toBe('WO-000001')
    expect(r1.body.data.status).toBe('open')
    expect(r1.body.data.lines).toEqual([])

    const r2 = await request(buildApp())
      .post('/api/business-work-orders')
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .send({ customerId: f.customerId })
    expect(r2.body.data.wo_number).toBe('WO-000002')
  })

  it('vehicle must belong to same customer', async () => {
    const f = await seedFixture()
    // Make a vehicle on a different customer.
    const { rows: [c2] } = await db.query<{ id: string }>(
      `INSERT INTO business_customers
         (business_id, customer_type, first_name, last_name, street1, city, state, zip)
       VALUES ($1, 'individual', 'X', 'Y', 'a', 'b', 'AZ', '12345') RETURNING id`,
      [f.businessId])
    const v = await request(buildApp())
      .post('/api/business-vehicles')
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .send({ customerId: c2.id, make: 'Ford' })
    const res = await request(buildApp())
      .post('/api/business-work-orders')
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .send({ customerId: f.customerId, vehicleId: v.body.data.id })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/does not belong/i)
  })

  it('cross-business customer → 404', async () => {
    const a = await seedFixture()
    const b = await seedFixture()
    const res = await request(buildApp())
      .post('/api/business-work-orders')
      .set('Authorization', `Bearer ${a.ownerToken}`)
      .send({ customerId: b.customerId })
    expect(res.status).toBe(404)
  })
})

// ═══════════════════════════════════════════════════════════════
//  Lines — labor + part + fee
// ═══════════════════════════════════════════════════════════════

async function newWo(token: string, customerId: string): Promise<string> {
  const r = await request(buildApp())
    .post('/api/business-work-orders')
    .set('Authorization', `Bearer ${token}`)
    .send({ customerId })
  return r.body.data.id
}

describe('POST /:id/lines — labor', () => {
  it('computes hours × rate; updates header totals', async () => {
    const f = await seedFixture()
    const woId = await newWo(f.ownerToken, f.customerId)
    const res = await request(buildApp())
      .post(`/api/business-work-orders/${woId}/lines`)
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .send({ lineType: 'labor', description: 'Diagnostic', hours: 1.5, hourlyRate: 100, taxRate: 0 })
    expect(res.status).toBe(201)
    expect(Number(res.body.data.line_subtotal)).toBeCloseTo(150)
    expect(Number(res.body.data.line_total)).toBeCloseTo(150)

    const detail = await request(buildApp())
      .get(`/api/business-work-orders/${woId}`)
      .set('Authorization', `Bearer ${f.ownerToken}`)
    expect(Number(detail.body.data.labor_subtotal)).toBeCloseTo(150)
    expect(Number(detail.body.data.parts_subtotal)).toBeCloseTo(0)
    expect(Number(detail.body.data.total_amount)).toBeCloseTo(150)
  })
})

describe('POST /:id/lines — part', () => {
  it('decrements stock + snapshots item + tax_rate, writes used adjustment', async () => {
    const f = await seedFixture({ itemPrice: 12.99, itemStock: 20 })
    const woId = await newWo(f.ownerToken, f.customerId)

    const res = await request(buildApp())
      .post(`/api/business-work-orders/${woId}/lines`)
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .send({ lineType: 'part', itemId: f.itemId, quantity: 3 })
    expect(res.status).toBe(201)
    expect(res.body.data.description).toBe('Oil Filter')
    expect(Number(res.body.data.unit_price)).toBeCloseTo(12.99)
    expect(Number(res.body.data.line_subtotal)).toBeCloseTo(38.97)

    const { rows: [item] } = await db.query<{ stock_qty: number }>(
      `SELECT stock_qty FROM business_inventory_items WHERE id = $1`, [f.itemId])
    expect(item.stock_qty).toBe(17)

    const { rows: adj } = await db.query(
      `SELECT * FROM business_inventory_adjustments
        WHERE item_id = $1 AND adjustment_type = 'used'`, [f.itemId])
    expect(adj.length).toBe(1)
  })

  it('insufficient stock → 400; nothing decremented', async () => {
    const f = await seedFixture({ itemStock: 2 })
    const woId = await newWo(f.ownerToken, f.customerId)
    const res = await request(buildApp())
      .post(`/api/business-work-orders/${woId}/lines`)
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .send({ lineType: 'part', itemId: f.itemId, quantity: 5 })
    expect(res.status).toBe(400)
    const { rows: [item] } = await db.query<{ stock_qty: number }>(
      `SELECT stock_qty FROM business_inventory_items WHERE id = $1`, [f.itemId])
    expect(item.stock_qty).toBe(2)
  })

  it('override unit_price respected', async () => {
    const f = await seedFixture({ itemPrice: 10 })
    const woId = await newWo(f.ownerToken, f.customerId)
    const res = await request(buildApp())
      .post(`/api/business-work-orders/${woId}/lines`)
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .send({ lineType: 'part', itemId: f.itemId, quantity: 1, unitPrice: 25 })
    expect(Number(res.body.data.unit_price)).toBeCloseTo(25)
  })
})

describe('DELETE /:id/lines/:lineId', () => {
  it('part line: restores stock + writes received adjustment', async () => {
    const f = await seedFixture({ itemStock: 20 })
    const woId = await newWo(f.ownerToken, f.customerId)
    const add = await request(buildApp())
      .post(`/api/business-work-orders/${woId}/lines`)
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .send({ lineType: 'part', itemId: f.itemId, quantity: 3 })
    const lineId = add.body.data.id

    const del = await request(buildApp())
      .delete(`/api/business-work-orders/${woId}/lines/${lineId}`)
      .set('Authorization', `Bearer ${f.ownerToken}`)
    expect(del.status).toBe(200)

    const { rows: [item] } = await db.query<{ stock_qty: number }>(
      `SELECT stock_qty FROM business_inventory_items WHERE id = $1`, [f.itemId])
    expect(item.stock_qty).toBe(20)

    const detail = await request(buildApp())
      .get(`/api/business-work-orders/${woId}`)
      .set('Authorization', `Bearer ${f.ownerToken}`)
    expect(detail.body.data.lines.length).toBe(0)
    expect(Number(detail.body.data.parts_subtotal)).toBe(0)
  })

  it('cannot add or remove lines on completed WO', async () => {
    const f = await seedFixture()
    const woId = await newWo(f.ownerToken, f.customerId)
    await request(buildApp())
      .post(`/api/business-work-orders/${woId}/lines`)
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .send({ lineType: 'labor', description: 'work', hours: 1, hourlyRate: 100 })
    await request(buildApp())
      .post(`/api/business-work-orders/${woId}/transition`)
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .send({ toStatus: 'completed' })

    const res = await request(buildApp())
      .post(`/api/business-work-orders/${woId}/lines`)
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .send({ lineType: 'labor', description: 'more work', hours: 1, hourlyRate: 100 })
    expect(res.status).toBe(409)
  })
})

// ═══════════════════════════════════════════════════════════════
//  Transitions
// ═══════════════════════════════════════════════════════════════

describe('Status transitions', () => {
  it('open → in_progress → awaiting_parts → completed', async () => {
    const f = await seedFixture()
    const woId = await newWo(f.ownerToken, f.customerId)
    const a = await request(buildApp())
      .post(`/api/business-work-orders/${woId}/transition`)
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .send({ toStatus: 'in_progress' })
    expect(a.body.data.status).toBe('in_progress')

    const b = await request(buildApp())
      .post(`/api/business-work-orders/${woId}/transition`)
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .send({ toStatus: 'awaiting_parts' })
    expect(b.body.data.status).toBe('awaiting_parts')

    const c = await request(buildApp())
      .post(`/api/business-work-orders/${woId}/transition`)
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .send({ toStatus: 'completed', closeoutMileage: 80000, closeoutNotes: 'Done.' })
    expect(c.body.data.status).toBe('completed')
    expect(c.body.data.completed_at).not.toBeNull()
    expect(c.body.data.closeout_mileage).toBe(80000)
  })

  it('cancel requires reason; sets cancelled_at', async () => {
    const f = await seedFixture()
    const woId = await newWo(f.ownerToken, f.customerId)
    const bad = await request(buildApp())
      .post(`/api/business-work-orders/${woId}/transition`)
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .send({ toStatus: 'cancelled' })
    expect(bad.status).toBe(400)

    const good = await request(buildApp())
      .post(`/api/business-work-orders/${woId}/transition`)
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .send({ toStatus: 'cancelled', cancelReason: 'Customer changed mind' })
    expect(good.body.data.status).toBe('cancelled')
    expect(good.body.data.cancelled_at).not.toBeNull()
    expect(good.body.data.cancel_reason).toBe('Customer changed mind')
  })

  it('terminal status cannot transition further', async () => {
    const f = await seedFixture()
    const woId = await newWo(f.ownerToken, f.customerId)
    await request(buildApp())
      .post(`/api/business-work-orders/${woId}/transition`)
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .send({ toStatus: 'completed' })
    const res = await request(buildApp())
      .post(`/api/business-work-orders/${woId}/transition`)
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .send({ toStatus: 'in_progress' })
    expect(res.status).toBe(409)
  })
})

// ═══════════════════════════════════════════════════════════════
//  Convert to invoice
// ═══════════════════════════════════════════════════════════════

describe('POST /:id/convert-to-invoice', () => {
  it('creates a draft invoice + lines + linkage both directions', async () => {
    const f = await seedFixture({ itemPrice: 10 })
    const woId = await newWo(f.ownerToken, f.customerId)
    await request(buildApp())
      .post(`/api/business-work-orders/${woId}/lines`)
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .send({ lineType: 'labor', description: 'Service', hours: 2, hourlyRate: 75, taxRate: 0 })
    await request(buildApp())
      .post(`/api/business-work-orders/${woId}/lines`)
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .send({ lineType: 'part', itemId: f.itemId, quantity: 1 })

    const conv = await request(buildApp())
      .post(`/api/business-work-orders/${woId}/convert-to-invoice`)
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .send({ issueDate: '2026-06-14', dueDate: '2026-07-14' })
    expect(conv.status).toBe(201)
    expect(conv.body.data.invoice_number).toMatch(/^INV-\d{4}$/)
    expect(conv.body.data.status).toBe('draft')
    expect(conv.body.data.source_work_order_id).toBe(woId)

    // WO has invoice_id set
    const detail = await request(buildApp())
      .get(`/api/business-work-orders/${woId}`)
      .set('Authorization', `Bearer ${f.ownerToken}`)
    expect(detail.body.data.invoice_id).toBe(conv.body.data.id)

    // Invoice lines were copied (verify via DB)
    const { rows: invLines } = await db.query(
      `SELECT description, sort_order FROM business_invoice_lines
        WHERE invoice_id = $1 ORDER BY sort_order`,
      [conv.body.data.id])
    expect(invLines.length).toBe(2)
    expect((invLines[0] as any).description).toMatch(/^Labor: /)
    expect((invLines[1] as any).description).toMatch(/^Part: /)
  })

  it('double-convert → 409', async () => {
    const f = await seedFixture()
    const woId = await newWo(f.ownerToken, f.customerId)
    await request(buildApp())
      .post(`/api/business-work-orders/${woId}/lines`)
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .send({ lineType: 'labor', description: 'work', hours: 1, hourlyRate: 100 })
    await request(buildApp())
      .post(`/api/business-work-orders/${woId}/convert-to-invoice`)
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .send({ issueDate: '2026-06-14', dueDate: '2026-07-14' })
    const res = await request(buildApp())
      .post(`/api/business-work-orders/${woId}/convert-to-invoice`)
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .send({ issueDate: '2026-06-14', dueDate: '2026-07-14' })
    expect(res.status).toBe(409)
  })

  it('cancelled WO cannot be invoiced', async () => {
    const f = await seedFixture()
    const woId = await newWo(f.ownerToken, f.customerId)
    await request(buildApp())
      .post(`/api/business-work-orders/${woId}/transition`)
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .send({ toStatus: 'cancelled', cancelReason: 'X' })
    const res = await request(buildApp())
      .post(`/api/business-work-orders/${woId}/convert-to-invoice`)
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .send({ issueDate: '2026-06-14', dueDate: '2026-07-14' })
    expect(res.status).toBe(409)
  })

  it('empty WO cannot be invoiced', async () => {
    const f = await seedFixture()
    const woId = await newWo(f.ownerToken, f.customerId)
    const res = await request(buildApp())
      .post(`/api/business-work-orders/${woId}/convert-to-invoice`)
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .send({ issueDate: '2026-06-14', dueDate: '2026-07-14' })
    expect(res.status).toBe(400)
  })

  it('invoicing feature must be enabled', async () => {
    const f = await seedFixture({ invoicingEnabled: false })
    const woId = await newWo(f.ownerToken, f.customerId)
    await request(buildApp())
      .post(`/api/business-work-orders/${woId}/lines`)
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .send({ lineType: 'labor', description: 'work', hours: 1, hourlyRate: 100 })
    const res = await request(buildApp())
      .post(`/api/business-work-orders/${woId}/convert-to-invoice`)
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .send({ issueDate: '2026-06-14', dueDate: '2026-07-14' })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/Invoicing feature/i)
  })
})

// ═══════════════════════════════════════════════════════════════
//  Cross-business isolation
// ═══════════════════════════════════════════════════════════════

describe('Cross-business isolation', () => {
  it('list excludes other businesses; detail returns 404', async () => {
    const a = await seedFixture()
    const b = await seedFixture()
    const bWo = await newWo(b.ownerToken, b.customerId)

    const list = await request(buildApp())
      .get('/api/business-work-orders')
      .set('Authorization', `Bearer ${a.ownerToken}`)
    expect(list.body.data.length).toBe(0)

    const detail = await request(buildApp())
      .get(`/api/business-work-orders/${bWo}`)
      .set('Authorization', `Bearer ${a.ownerToken}`)
    expect(detail.status).toBe(404)
  })
})

// ═══════════════════════════════════════════════════════════════
//  S514 — work-order time tracking
// ═══════════════════════════════════════════════════════════════

describe('Time tracking (S514)', () => {
  const post = (token: string, url: string, body?: any) =>
    request(buildApp()).post(url).set('Authorization', `Bearer ${token}`).send(body ?? {})

  it('start creates a running entry; double-start → 409', async () => {
    const f = await seedFixture()
    const woId = await newWo(f.ownerToken, f.customerId)
    const r1 = await post(f.ownerToken, `/api/business-work-orders/${woId}/time/start`)
    expect(r1.status).toBe(201)
    expect(r1.body.data.ended_at).toBeNull()
    expect(r1.body.data.duration_minutes).toBeNull()
    const r2 = await post(f.ownerToken, `/api/business-work-orders/${woId}/time/start`)
    expect(r2.status).toBe(409)
  })

  it('stop closes the running entry with a duration', async () => {
    const f = await seedFixture()
    const woId = await newWo(f.ownerToken, f.customerId)
    await post(f.ownerToken, `/api/business-work-orders/${woId}/time/start`)
    const res = await post(f.ownerToken, `/api/business-work-orders/${woId}/time/stop`)
    expect(res.status).toBe(200)
    expect(res.body.data.ended_at).not.toBeNull()
    expect(res.body.data.duration_minutes).toBeGreaterThanOrEqual(0)
  })

  it('stop with no running timer → 404', async () => {
    const f = await seedFixture()
    const woId = await newWo(f.ownerToken, f.customerId)
    const res = await post(f.ownerToken, `/api/business-work-orders/${woId}/time/stop`)
    expect(res.status).toBe(404)
  })

  it('manual entry records the given duration', async () => {
    const f = await seedFixture()
    const woId = await newWo(f.ownerToken, f.customerId)
    const res = await post(f.ownerToken, `/api/business-work-orders/${woId}/time/manual`, { minutes: 90, note: 'forgot to clock' })
    expect(res.status).toBe(201)
    expect(res.body.data.duration_minutes).toBe(90)
    expect(res.body.data.ended_at).not.toBeNull()
  })

  it('bill rolls unbilled time into a labor line + updates header totals', async () => {
    const f = await seedFixture()
    const woId = await newWo(f.ownerToken, f.customerId)
    await post(f.ownerToken, `/api/business-work-orders/${woId}/time/manual`, { minutes: 90 })  // 1.5h
    const res = await post(f.ownerToken, `/api/business-work-orders/${woId}/time/bill`, { hourlyRate: 100 })
    expect(res.status).toBe(201)
    expect(res.body.data.hours).toBeCloseTo(1.5)
    expect(Number(res.body.data.line.quantity)).toBeCloseTo(1.5)
    expect(Number(res.body.data.line.line_subtotal)).toBeCloseTo(150)

    const detail = await request(buildApp())
      .get(`/api/business-work-orders/${woId}`)
      .set('Authorization', `Bearer ${f.ownerToken}`)
    expect(Number(detail.body.data.labor_subtotal)).toBeCloseTo(150)
    expect(Number(detail.body.data.total_amount)).toBeCloseTo(150)
    expect(detail.body.data.timeEntries.length).toBe(1)
    expect(detail.body.data.timeEntries[0].billed_at).not.toBeNull()
  })

  it('cannot bill the same time twice (marked billed) → 409', async () => {
    const f = await seedFixture()
    const woId = await newWo(f.ownerToken, f.customerId)
    await post(f.ownerToken, `/api/business-work-orders/${woId}/time/manual`, { minutes: 60 })
    await post(f.ownerToken, `/api/business-work-orders/${woId}/time/bill`, { hourlyRate: 50 })
    const second = await post(f.ownerToken, `/api/business-work-orders/${woId}/time/bill`, { hourlyRate: 50 })
    expect(second.status).toBe(409)
  })

  it('bill with nothing tracked → 409', async () => {
    const f = await seedFixture()
    const woId = await newWo(f.ownerToken, f.customerId)
    const res = await post(f.ownerToken, `/api/business-work-orders/${woId}/time/bill`, { hourlyRate: 100 })
    expect(res.status).toBe(409)
  })

  it('delete unbilled ok; delete billed → 409', async () => {
    const f = await seedFixture()
    const woId = await newWo(f.ownerToken, f.customerId)
    const m = await post(f.ownerToken, `/api/business-work-orders/${woId}/time/manual`, { minutes: 30 })
    const del = await request(buildApp())
      .delete(`/api/business-work-orders/${woId}/time/${m.body.data.id}`)
      .set('Authorization', `Bearer ${f.ownerToken}`)
    expect(del.status).toBe(200)
    // Now a billed one
    const m2 = await post(f.ownerToken, `/api/business-work-orders/${woId}/time/manual`, { minutes: 30 })
    await post(f.ownerToken, `/api/business-work-orders/${woId}/time/bill`, { hourlyRate: 80 })
    const del2 = await request(buildApp())
      .delete(`/api/business-work-orders/${woId}/time/${m2.body.data.id}`)
      .set('Authorization', `Bearer ${f.ownerToken}`)
    expect(del2.status).toBe(409)
  })

  it('cannot start time on a completed work order → 409', async () => {
    const f = await seedFixture()
    const woId = await newWo(f.ownerToken, f.customerId)
    await db.query(`UPDATE business_work_orders SET status = 'completed', completed_at = NOW() WHERE id = $1`, [woId])
    const res = await post(f.ownerToken, `/api/business-work-orders/${woId}/time/start`)
    expect(res.status).toBe(409)
  })
})
