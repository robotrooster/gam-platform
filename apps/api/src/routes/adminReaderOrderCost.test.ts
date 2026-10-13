/**
 * 10/12 (Nic) — GAM's Reader Orders desk records what each reader cost GAM.
 *
 * "331.73 after tax and shipping. 299 base. those orders are going to need to
 * be tracked because shipping will vary." POST /api/admin/reader-orders/:id/cost
 * (super admin only) adds a cost entry; GET /api/admin/reader-orders shows the
 * price charged, GAM's cost and the markup on every order.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { randomUUID } from 'crypto'
import { db } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty } from '../test/dbHelpers'
import { adminRouter } from './admin'
import { errorHandler } from '../middleware/errorHandler'
import { camelizeKeys } from '@gam/shared'
import { raiseDueInstallments } from '../services/readerOrders'

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/admin', adminRouter)
  app.use(errorHandler)
  return app
}

beforeEach(async () => {
  await cleanupAllSchema()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_admin_bul'
})

async function fixture() {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const ll = await seedLandlord(c)
    const propertyId = await seedProperty(c, { landlordId: ll.landlordId, ownerUserId: ll.userId, managedByUserId: ll.userId })
    const order = (await c.query<{ id: string }>(
      `INSERT INTO pos_reader_orders (landlord_id, property_id, status, model, price, installments, installment_amount,
                                      ship_name, ship_line1, ship_city, ship_state, ship_zip)
       VALUES ($1, $2, 'ordered', 'stripe_reader_s710', 350, 4, 87.5, 'Lisa S', '1 Road', 'Amado', 'AZ', '85645') RETURNING id`,
      [ll.landlordId, propertyId])).rows[0].id
    const user = async (role: string) => (await c.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
       VALUES ($1, 'x', $2, 'Nic', 'R', TRUE) RETURNING id`, [`${role}-${randomUUID()}@test.dev`, role])).rows[0].id
    const superId = await user('super_admin')
    const adminId = await user('admin')
    await c.query('COMMIT')
    const sign = (id: string, role: string) => jwt.sign(
      { userId: id, role, email: 'x@test.dev', profileId: id, permissions: {} }, process.env.JWT_SECRET!, { expiresIn: '1h' })
    return { order, superToken: sign(superId, 'super_admin'), adminToken: sign(adminId, 'admin') }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

describe('POST /api/admin/reader-orders/:id/cost', () => {
  it('records the cost; the desk shows charged, cost and markup, and who typed it', async () => {
    const f = await fixture()
    const res = await request(buildApp()).post(`/api/admin/reader-orders/${f.order}/cost`)
      .set('Authorization', `Bearer ${f.superToken}`).send({ basePrice: 299, taxAndShipping: 32.73 })
    expect(res.status).toBe(200)
    expect(res.body.data).toMatchObject({ charged: 350, cost_total: 331.73, markup: 18.27, cost_locked: false })
    const list = await request(buildApp()).get('/api/admin/reader-orders').set('Authorization', `Bearer ${f.superToken}`)
    expect(list.status).toBe(200)
    const row = list.body.data.find((o: any) => o.id === f.order)
    expect(row.cost_history).toHaveLength(1)
    expect(row.cost_history[0]).toMatchObject({ base_price: 299, tax_and_shipping: 32.73, total: 331.73, entered_by: 'Nic R' })
    expect(row.pieces[3]).toMatchObject({ n: 4, cost: 69.23, markup: 18.27 })
    // The admin portal reads it camelized — `pieces` and `costHistory` come through.
    const camel: any[] = camelizeKeys(list.body.data)
    expect(camel.find((o: any) => o.id === f.order)).toMatchObject({
      costTotal: 331.73, costHistory: [{ taxAndShipping: 32.73, enteredBy: 'Nic R' }], pieces: [{ n: 1 }, { n: 2 }, { n: 3 }, { n: 4, markup: 18.27 }],
    })
    const log = await db.query(`SELECT action_type FROM admin_action_log WHERE target_id = $1`, [f.order])
    expect(log.rows.map((r: any) => r.action_type)).toEqual(['reader_order_cost_recorded'])
  })

  // 10/12 (review): fixed once markup figured from the cost is booked as GAM's earnings — not the
  // day the reader ships (it usually ships itself before anyone types the receipt).
  it('refuses a changed total once markup is booked (409) — a typo after shipping is still corrected — and a bad body (400)', async () => {
    const f = await fixture()
    const app = buildApp()
    const post = (body: any) => request(app).post(`/api/admin/reader-orders/${f.order}/cost`)
      .set('Authorization', `Bearer ${f.superToken}`).send(body)
    expect((await post({ basePrice: 299, tax: 1, taxAndShipping: 2 })).status).toBe(400)
    expect((await post({ basePrice: 'lots' })).status).toBe(400)
    await db.query(`UPDATE pos_reader_orders SET status = 'shipped', shipped_at = NOW() WHERE id = $1`, [f.order])
    expect((await post({ basePrice: 299, taxAndShipping: 23.73 })).status).toBe(200)   // the typo
    expect((await post({ basePrice: 299, taxAndShipping: 32.73 })).status).toBe(200)   // corrected
    // Every piece billed — the last carries the markup, booked as GAM's earnings: fixed from here.
    await db.query(`UPDATE pos_reader_orders SET shipped_at = NOW() - INTERVAL '5 months' WHERE id = $1`, [f.order])
    expect(await raiseDueInstallments()).toBe(4)
    const r = await post({ basePrice: 299, taxAndShipping: 40 })
    expect(r.status).toBe(409)
    expect(r.body.error).toMatch(/from a cost of \$331\.73/)
    expect((await post({ basePrice: 299, tax: 20, shipping: 12.73 })).status).toBe(200)
  })

  it('is for the super admin only', async () => {
    const f = await fixture()
    const res = await request(buildApp()).post(`/api/admin/reader-orders/${f.order}/cost`)
      .set('Authorization', `Bearer ${f.adminToken}`).send({ basePrice: 299 })
    expect(res.status).toBe(403)
  })

  it('a reader order that does not exist is a 404', async () => {
    const f = await fixture()
    const res = await request(buildApp()).post(`/api/admin/reader-orders/${randomUUID()}/cost`)
      .set('Authorization', `Bearer ${f.superToken}`).send({ basePrice: 299 })
    expect(res.status).toBe(404)
  })
})
