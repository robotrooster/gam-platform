/**
 * pos.ts inventory + vendors + categories + low-stock slice — S389.
 *
 * Covered routes (10):
 *   - GET   /api/pos/items
 *   - PATCH /api/pos/items/:id
 *   - POST  /api/pos/items/:id/adjust-stock
 *   - GET   /api/pos/items/:id/shelf-label
 *   - GET   /api/pos/vendors
 *   - POST  /api/pos/vendors
 *   - PATCH /api/pos/vendors/:id
 *   - GET   /api/pos/low-stock
 *   - GET   /api/pos/categories
 *   - PATCH /api/pos/categories/:id
 *
 * Complements S347's pos.inventory.test.ts which explicitly skipped
 * these as "mechanical CRUD" — but the S388 audit flagged a
 * cross-tenant scope bypass on PATCH /items vendorId, fixed in this
 * slice. After this slice: pos.ts coverage 42/55 (76%, up from 58%).
 *
 * Production bug fixed in this slice (1):
 *   - **PATCH /api/pos/items vendorId scope bypass** (S388 finding #3):
 *     vendorId from body written without ownership check. A landlord
 *     could PATCH their item to reference another landlord's vendor;
 *     GET /items would join the cross-tenant vendor_name. Same class
 *     as the books.ts S386 bill scope-bypass. Fix mirrors the existing
 *     propertyId pattern (null clears, undefined preserves, uuid
 *     re-assigns + validates ownership).
 */

import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { randomUUID } from 'crypto'
import { db } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty } from '../test/dbHelpers'
import { posRouter } from './pos'
import { errorHandler } from '../middleware/errorHandler'

function buildApp() {
  const app = express()
  app.use(express.json({ limit: '2mb' }))
  app.use('/api/pos', posRouter)
  app.use(errorHandler)
  return app
}

beforeEach(async () => {
  await cleanupAllSchema()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_pos_inv2'
})

interface Fixture {
  landlordAUserId: string
  landlordAId:     string
  landlordBUserId: string
  landlordBId:     string
  propertyAId:     string
  categoryAId:     string
  vendorAId:       string
  vendorBId:       string
  tokenA:          string
  tokenB:          string
}

async function seed(): Promise<Fixture> {
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    const { userId: aUid, landlordId: aId } = await seedLandlord(client)
    const { userId: bUid, landlordId: bId } = await seedLandlord(client)
    const propAId = await seedProperty(client, {
      landlordId: aId, ownerUserId: aUid, managedByUserId: aUid,
    })
    const catA = await client.query<{ id: string }>(
      `INSERT INTO pos_categories (landlord_id, name, sort_order, is_active)
       VALUES ($1, $2, 1, TRUE) RETURNING id`,
      [aId, `CatA-${randomUUID().slice(0, 6)}`])
    const vA = await client.query<{ id: string }>(
      `INSERT INTO pos_vendors (landlord_id, name) VALUES ($1, $2) RETURNING id`,
      [aId, `VendA-${randomUUID().slice(0, 6)}`])
    const vB = await client.query<{ id: string }>(
      `INSERT INTO pos_vendors (landlord_id, name) VALUES ($1, $2) RETURNING id`,
      [bId, `VendB-${randomUUID().slice(0, 6)}`])
    await client.query('COMMIT')
    const sign = (uid: string, lid: string) => jwt.sign(
      { userId: uid, role: 'landlord', email: 'l@t.dev', profileId: lid, permissions: {} },
      process.env.JWT_SECRET!, { expiresIn: '1h' })
    return {
      landlordAUserId: aUid, landlordAId: aId,
      landlordBUserId: bUid, landlordBId: bId,
      propertyAId: propAId, categoryAId: catA.rows[0].id,
      vendorAId: vA.rows[0].id, vendorBId: vB.rows[0].id,
      tokenA: sign(aUid, aId), tokenB: sign(bUid, bId),
    }
  } catch (e) { await client.query('ROLLBACK'); throw e }
  finally { client.release() }
}

async function seedItem(f: Fixture, opts: {
  landlordId?: string; propertyId?: string; categoryId?: string;
  vendorId?: string | null; stockQty?: number; stockMin?: number;
  stockMax?: number; isActive?: boolean; name?: string;
} = {}): Promise<string> {
  const r = await db.query<{ id: string }>(
    `INSERT INTO pos_items
       (landlord_id, property_id, category_id, name, sell_price, cost_price,
        vendor_id, stock_qty, stock_min, stock_max, is_active, charge_eligible)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,TRUE)
     RETURNING id`,
    [opts.landlordId ?? f.landlordAId,
     opts.propertyId ?? f.propertyAId,
     opts.categoryId ?? f.categoryAId,
     opts.name ?? `Item-${randomUUID().slice(0, 6)}`,
     10, 5,
     opts.vendorId ?? null,
     opts.stockQty ?? 10, opts.stockMin ?? 5, opts.stockMax ?? 50,
     opts.isActive ?? true])
  return r.rows[0].id
}

// ───────────────────────────────────────────────────────────────────
// GET /items
// ───────────────────────────────────────────────────────────────────

describe('GET /items', () => {
  it('landlord-scoped: returns only own active items', async () => {
    const f = await seed()
    await seedItem(f, { name: 'Pin-A' })
    await seedItem(f, { name: 'Pin-A-inactive', isActive: false })
    // Other landlord's item — not seen
    const propBId = await db.connect().then(async c => {
      try {
        await c.query('BEGIN')
        const p = await seedProperty(c, { landlordId: f.landlordBId, ownerUserId: f.landlordBUserId, managedByUserId: f.landlordBUserId })
        await c.query('COMMIT')
        return p
      } finally { c.release() }
    })
    const catB = await db.query<{ id: string }>(
      `INSERT INTO pos_categories (landlord_id, name) VALUES ($1, 'B Cat') RETURNING id`, [f.landlordBId])
    await db.query(
      `INSERT INTO pos_items (landlord_id, property_id, category_id, name, sell_price, stock_qty, stock_min, stock_max, is_active)
       VALUES ($1, $2, $3, 'Pin-B', 10, 5, 1, 10, TRUE)`,
      [f.landlordBId, propBId, catB.rows[0].id])

    const res = await request(buildApp())
      .get('/api/pos/items')
      .set('Authorization', `Bearer ${f.tokenA}`)
    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(1)
    expect(res.body.data[0].name).toBe('Pin-A')
  })

  it('propertyId filter narrows to that property', async () => {
    const f = await seed()
    const propA2 = await db.connect().then(async c => {
      try {
        await c.query('BEGIN')
        const p = await seedProperty(c, { landlordId: f.landlordAId, ownerUserId: f.landlordAUserId, managedByUserId: f.landlordAUserId })
        await c.query('COMMIT')
        return p
      } finally { c.release() }
    })
    await seedItem(f, { name: 'Prop-1-Item', propertyId: f.propertyAId })
    await seedItem(f, { name: 'Prop-2-Item', propertyId: propA2 })

    const res = await request(buildApp())
      .get(`/api/pos/items?propertyId=${f.propertyAId}`)
      .set('Authorization', `Bearer ${f.tokenA}`)
    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(1)
    expect(res.body.data[0].name).toBe('Prop-1-Item')
  })
})

// ───────────────────────────────────────────────────────────────────
// PATCH /items/:id — S389 vendorId scope fix
// ───────────────────────────────────────────────────────────────────

describe('PATCH /items/:id — S389 vendorId scope fix', () => {
  it('cross-landlord modify blocked → 404', async () => {
    const f = await seed()
    const propBId = await db.connect().then(async c => {
      try {
        await c.query('BEGIN')
        const p = await seedProperty(c, { landlordId: f.landlordBId, ownerUserId: f.landlordBUserId, managedByUserId: f.landlordBUserId })
        await c.query('COMMIT'); return p
      } finally { c.release() }
    })
    const catB = await db.query<{ id: string }>(
      `INSERT INTO pos_categories (landlord_id, name) VALUES ($1, 'B Cat') RETURNING id`, [f.landlordBId])
    const itemB = await seedItem(f, { landlordId: f.landlordBId, propertyId: propBId, categoryId: catB.rows[0].id })
    const res = await request(buildApp())
      .patch(`/api/pos/items/${itemB}`)
      .set('Authorization', `Bearer ${f.tokenA}`)
      .send({ name: 'Hijacked' })
    expect(res.status).toBe(404)
  })

  it('happy: COALESCE update preserves untouched fields', async () => {
    const f = await seed()
    const itemId = await seedItem(f, { name: 'Original' })
    const res = await request(buildApp())
      .patch(`/api/pos/items/${itemId}`)
      .set('Authorization', `Bearer ${f.tokenA}`)
      .send({ name: 'Renamed' })
    expect(res.status).toBe(200)
    expect(res.body.data.name).toBe('Renamed')
    expect(Number(res.body.data.sell_price)).toBe(10)  // preserved
  })

  it('S389 fix: vendorId from another landlord → 400; row unchanged', async () => {
    const f = await seed()
    const itemId = await seedItem(f, { vendorId: f.vendorAId })
    const res = await request(buildApp())
      .patch(`/api/pos/items/${itemId}`)
      .set('Authorization', `Bearer ${f.tokenA}`)
      .send({ vendorId: f.vendorBId })  // landlord B's vendor
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/does not belong to this landlord/i)
    const row = await db.query<{ vendor_id: string }>(
      `SELECT vendor_id FROM pos_items WHERE id=$1`, [itemId])
    expect(row.rows[0].vendor_id).toBe(f.vendorAId)  // unchanged
  })

  it('vendorId=null explicitly clears the assignment', async () => {
    const f = await seed()
    const itemId = await seedItem(f, { vendorId: f.vendorAId })
    const res = await request(buildApp())
      .patch(`/api/pos/items/${itemId}`)
      .set('Authorization', `Bearer ${f.tokenA}`)
      .send({ vendorId: null })
    expect(res.status).toBe(200)
    expect(res.body.data.vendor_id).toBeNull()
  })

  it('vendorId=own-vendor re-assigns correctly', async () => {
    const f = await seed()
    const itemId = await seedItem(f, { vendorId: null })
    const res = await request(buildApp())
      .patch(`/api/pos/items/${itemId}`)
      .set('Authorization', `Bearer ${f.tokenA}`)
      .send({ vendorId: f.vendorAId })
    expect(res.status).toBe(200)
    expect(res.body.data.vendor_id).toBe(f.vendorAId)
  })
})

// ───────────────────────────────────────────────────────────────────
// POST /items/:id/adjust-stock
// ───────────────────────────────────────────────────────────────────

describe('POST /items/:id/adjust-stock', () => {
  it('cross-landlord → 404', async () => {
    const f = await seed()
    const propBId = await db.connect().then(async c => {
      try { await c.query('BEGIN'); const p = await seedProperty(c, { landlordId: f.landlordBId, ownerUserId: f.landlordBUserId, managedByUserId: f.landlordBUserId }); await c.query('COMMIT'); return p }
      finally { c.release() }
    })
    const catB = await db.query<{ id: string }>(
      `INSERT INTO pos_categories (landlord_id, name) VALUES ($1, 'CB') RETURNING id`, [f.landlordBId])
    const itemB = await seedItem(f, { landlordId: f.landlordBId, propertyId: propBId, categoryId: catB.rows[0].id, stockQty: 20 })
    const res = await request(buildApp())
      .post(`/api/pos/items/${itemB}/adjust-stock`)
      .set('Authorization', `Bearer ${f.tokenA}`)
      .send({ changeQty: -5 })
    expect(res.status).toBe(404)
  })

  it('positive adjust: stock_qty bumped + inventory_log row written', async () => {
    const f = await seed()
    const itemId = await seedItem(f, { stockQty: 10 })
    const res = await request(buildApp())
      .post(`/api/pos/items/${itemId}/adjust-stock`)
      .set('Authorization', `Bearer ${f.tokenA}`)
      .send({ changeQty: 5, reason: 'manual', notes: 'box from vendor' })
    expect(res.status).toBe(200)
    expect(res.body.data.stockBefore).toBe(10)
    expect(res.body.data.stockAfter).toBe(15)
    const log = await db.query(
      `SELECT change_qty, reason FROM pos_inventory_log WHERE item_id=$1`, [itemId])
    expect(log.rows).toHaveLength(1)
    expect(Number(log.rows[0].change_qty)).toBe(5)
    expect(log.rows[0].reason).toBe('manual')
  })

  it('FINDING (S389): invalid reason string yields 500 not 400 (no route-level enum validation)', async () => {
    // pos_inventory_log.reason CHECK accepts only:
    //   ['adjustment','sale','po_received','return','manual','other']
    // Route accepts any string and forwards to the DB. Invalid values
    // surface as 500 via the constraint violation. Should be a clean
    // 400 from a route-level validator. Pinned current behavior.
    const f = await seed()
    const itemId = await seedItem(f, { stockQty: 10 })
    const res = await request(buildApp())
      .post(`/api/pos/items/${itemId}/adjust-stock`)
      .set('Authorization', `Bearer ${f.tokenA}`)
      .send({ changeQty: 1, reason: 'NOT_A_VALID_REASON' })
    expect([400, 500]).toContain(res.status)  // currently 500; should be 400
  })

  it('negative adjust below zero: floors stock at 0', async () => {
    const f = await seed()
    const itemId = await seedItem(f, { stockQty: 3 })
    const res = await request(buildApp())
      .post(`/api/pos/items/${itemId}/adjust-stock`)
      .set('Authorization', `Bearer ${f.tokenA}`)
      .send({ changeQty: -10 })
    expect(res.status).toBe(200)
    expect(res.body.data.stockAfter).toBe(0)
  })
})

// ───────────────────────────────────────────────────────────────────
// GET /items/:id/shelf-label (public — no auth)
// ───────────────────────────────────────────────────────────────────

describe('GET /items/:id/shelf-label', () => {
  // FINDING (S389): the route's source comment says "public shelf
  // label data" but `posRouter.use(requireAuth)` at line 16 gates
  // every route, including this one. No public-scanner frontend
  // exists today (landlord + pos portals both call via apiGet with
  // auth headers), so the actual contract is auth-required. Comment-
  // vs-code mismatch flagged for cleanup; tests pin the actual
  // (auth-gated) behavior.
  it('unauthenticated → 401', async () => {
    const res = await request(buildApp())
      .get(`/api/pos/items/${randomUUID()}/shelf-label`)
    expect(res.status).toBe(401)
  })

  it('unknown → 404', async () => {
    const f = await seed()
    const res = await request(buildApp())
      .get(`/api/pos/items/${randomUUID()}/shelf-label`)
      .set('Authorization', `Bearer ${f.tokenA}`)
    expect(res.status).toBe(404)
  })

  it('happy: returns label payload with category name', async () => {
    const f = await seed()
    const itemId = await seedItem(f, { name: 'Hammer' })
    const res = await request(buildApp())
      .get(`/api/pos/items/${itemId}/shelf-label`)
      .set('Authorization', `Bearer ${f.tokenA}`)
    expect(res.status).toBe(200)
    expect(res.body.data.name).toBe('Hammer')
    expect(res.body.data.category).toMatch(/^CatA-/)
    expect(Number(res.body.data.sell_price)).toBe(10)
  })
})

// ───────────────────────────────────────────────────────────────────
// GET / POST / PATCH /vendors
// ───────────────────────────────────────────────────────────────────

describe('GET /vendors', () => {
  it('landlord-scoped: caller sees only own', async () => {
    const f = await seed()
    const res = await request(buildApp())
      .get('/api/pos/vendors')
      .set('Authorization', `Bearer ${f.tokenA}`)
    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(1)
    expect(res.body.data[0].id).toBe(f.vendorAId)
  })
})

describe('POST /vendors', () => {
  it('happy: creates vendor with leadTimeDays defaulting to 3', async () => {
    const f = await seed()
    const res = await request(buildApp())
      .post('/api/pos/vendors')
      .set('Authorization', `Bearer ${f.tokenA}`)
      .send({ name: 'Acme Supply', contactName: 'Joe', email: 'joe@acme.test' })
    expect(res.status).toBe(201)
    expect(res.body.data.name).toBe('Acme Supply')
    expect(res.body.data.lead_time_days).toBe(3)
    expect(res.body.data.landlord_id).toBe(f.landlordAId)
  })

  it('FINDING (S389): empty body accepted, NOT NULL constraint surfaces as 500 not 400', async () => {
    // Pre-fix behavior pinned. Route has no required-field check and
    // pos_vendors.name is NOT NULL — request with no name yields a
    // 23502 (not_null_violation) returned as 500 by the global error
    // handler. Should be a clean 400 with 'name required'. Same class
    // as the S384 contractors validation gap; flagged for fix when
    // pos vendor validation is normalized.
    const f = await seed()
    const res = await request(buildApp())
      .post('/api/pos/vendors')
      .set('Authorization', `Bearer ${f.tokenA}`)
      .send({})
    expect([400, 500]).toContain(res.status)  // currently 500; should be 400
  })
})

describe('PATCH /vendors/:id', () => {
  it('cross-landlord → 404', async () => {
    const f = await seed()
    const res = await request(buildApp())
      .patch(`/api/pos/vendors/${f.vendorBId}`)
      .set('Authorization', `Bearer ${f.tokenA}`)
      .send({ name: 'Hijacked' })
    expect(res.status).toBe(404)
  })

  it('happy: COALESCE update preserves untouched fields', async () => {
    const f = await seed()
    const res = await request(buildApp())
      .patch(`/api/pos/vendors/${f.vendorAId}`)
      .set('Authorization', `Bearer ${f.tokenA}`)
      .send({ contactName: 'Updated Joe' })
    expect(res.status).toBe(200)
    expect(res.body.data.contact_name).toBe('Updated Joe')
    expect(res.body.data.name).toMatch(/^VendA-/)  // preserved
  })
})

// ───────────────────────────────────────────────────────────────────
// GET /low-stock
// ───────────────────────────────────────────────────────────────────

describe('GET /low-stock', () => {
  it('empty when all items above stock_min', async () => {
    const f = await seed()
    await seedItem(f, { stockQty: 10, stockMin: 5, stockMax: 50 })
    const res = await request(buildApp())
      .get('/api/pos/low-stock')
      .set('Authorization', `Bearer ${f.tokenA}`)
    expect(res.status).toBe(200)
    expect(res.body.data).toEqual([])
  })

  it('returns items at/below min with vendor_name joined; excludes items where stock_max >= 999', async () => {
    const f = await seed()
    // Item 1: below threshold (3 <= 5) AND stock_max < 999 → included
    await seedItem(f, { name: 'Low-1', stockQty: 3, stockMin: 5, stockMax: 50, vendorId: f.vendorAId })
    // Item 2: at threshold (5 <= 5) AND stock_max < 999 → included
    await seedItem(f, { name: 'Low-2', stockQty: 5, stockMin: 5, stockMax: 50 })
    // Item 3: at threshold BUT stock_max=999 → excluded (sentinel for "no max")
    await seedItem(f, { name: 'NoMax', stockQty: 1, stockMin: 5, stockMax: 999 })
    // Item 4: above threshold → excluded
    await seedItem(f, { name: 'Healthy', stockQty: 20, stockMin: 5, stockMax: 50 })

    const res = await request(buildApp())
      .get('/api/pos/low-stock')
      .set('Authorization', `Bearer ${f.tokenA}`)
    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(2)
    const names = res.body.data.map((r: any) => r.name).sort()
    expect(names).toEqual(['Low-1', 'Low-2'])
    const low1 = res.body.data.find((r: any) => r.name === 'Low-1')
    expect(low1.vendor_name).toMatch(/^VendA-/)
  })
})

// ───────────────────────────────────────────────────────────────────
// GET /categories
// ───────────────────────────────────────────────────────────────────

describe('GET /categories', () => {
  it('default: active-only', async () => {
    const f = await seed()
    // The fixture seeded one active category. Add an inactive one.
    await db.query(
      `INSERT INTO pos_categories (landlord_id, name, is_active) VALUES ($1, 'OldCat', FALSE)`,
      [f.landlordAId])
    const res = await request(buildApp())
      .get('/api/pos/categories')
      .set('Authorization', `Bearer ${f.tokenA}`)
    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(1)
    expect(res.body.data[0].id).toBe(f.categoryAId)
  })

  it('?all=1 includes inactive', async () => {
    const f = await seed()
    await db.query(
      `INSERT INTO pos_categories (landlord_id, name, is_active) VALUES ($1, 'OldCat', FALSE)`,
      [f.landlordAId])
    const res = await request(buildApp())
      .get('/api/pos/categories?all=1')
      .set('Authorization', `Bearer ${f.tokenA}`)
    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(2)
  })
})

// ───────────────────────────────────────────────────────────────────
// PATCH /categories/:id
// ───────────────────────────────────────────────────────────────────

describe('PATCH /categories/:id', () => {
  it('unknown id → 404 (note: returns {success:false,error:"Not found"} not an AppError)', async () => {
    const f = await seed()
    const res = await request(buildApp())
      .patch(`/api/pos/categories/${randomUUID()}`)
      .set('Authorization', `Bearer ${f.tokenA}`)
      .send({ name: 'X' })
    expect(res.status).toBe(404)
    expect(res.body.success).toBe(false)
  })

  it('happy: rename + sortOrder=0 honored (S219 fix)', async () => {
    const f = await seed()
    const res = await request(buildApp())
      .patch(`/api/pos/categories/${f.categoryAId}`)
      .set('Authorization', `Bearer ${f.tokenA}`)
      .send({ name: 'Renamed', sortOrder: 0 })
    expect(res.status).toBe(200)
    expect(res.body.data.name).toBe('Renamed')
    expect(res.body.data.sort_order).toBe(0)
  })

  it('propertyId from another landlord → 400', async () => {
    const f = await seed()
    const propBId = await db.connect().then(async c => {
      try { await c.query('BEGIN'); const p = await seedProperty(c, { landlordId: f.landlordBId, ownerUserId: f.landlordBUserId, managedByUserId: f.landlordBUserId }); await c.query('COMMIT'); return p }
      finally { c.release() }
    })
    const res = await request(buildApp())
      .patch(`/api/pos/categories/${f.categoryAId}`)
      .set('Authorization', `Bearer ${f.tokenA}`)
      .send({ propertyId: propBId })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/does not belong/i)
  })
})
