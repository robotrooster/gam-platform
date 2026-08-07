import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { db } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit } from '../test/dbHelpers'
import { residentHomeSaleRouter } from './residentHomeSale'
import { errorHandler } from '../middleware/errorHandler'

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/resident-home-sales', residentHomeSaleRouter)
  app.use(errorHandler)
  return app
}

beforeEach(async () => {
  await cleanupAllSchema()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_resident_sale'
})

// A landlord + a tenant-owned unit whose home is owned by `sellerUserId`.
async function seed(dwelling: 'tenant' | 'landlord' = 'tenant') {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const { userId: llUser, landlordId } = await seedLandlord(c)
    const propertyId = await seedProperty(c, { landlordId, ownerUserId: llUser, managedByUserId: llUser })
    const unitId = await seedUnit(c, { propertyId, landlordId })
    await c.query(`UPDATE units SET dwelling_ownership=$2 WHERE id=$1`, [unitId, dwelling])
    // The selling home owner: a user + an active home_ownerships record.
    const seller = (await c.query(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
       VALUES ($1,'x','tenant','Sam','Seller',TRUE) RETURNING id`, [`seller-${unitId}@t.dev`])).rows[0].id
    if (dwelling === 'tenant') {
      await c.query(`INSERT INTO home_ownerships (unit_id, owner_user_id, status) VALUES ($1,$2,'active')`, [unitId, seller])
    }
    await c.query('COMMIT')
    const token = jwt.sign({ userId: llUser, role: 'landlord', email: 'll@t.dev', profileId: landlordId, permissions: {} },
      process.env.JWT_SECRET!, { expiresIn: '1h' })
    return { landlordId, propertyId, unitId, sellerUserId: seller, token }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

describe('resident-to-resident home sale', () => {
  it('records a flat sale + schedule and creates NO money/payments rows', async () => {
    const f = await seed()
    const res = await request(buildApp()).post('/api/resident-home-sales')
      .set('Authorization', `Bearer ${f.token}`)
      .send({ unitId: f.unitId, planType: 'flat', monthlyAmount: 400, numberOfPayments: 6,
              startMonth: '2026-08-01', buyerName: 'Betty Buyer', buyerEmail: 'betty@buyer.dev' })
    expect(res.status).toBe(201)
    expect(res.body.data.sale.plan_type).toBe('flat')
    expect(Number(res.body.data.sale.sale_price)).toBe(2400)     // 400 × 6
    expect(res.body.data.schedule).toHaveLength(6)
    expect(Number(res.body.data.schedule[0].amount)).toBe(400)
    // GAM processes NO money — there must be zero payments rows for this unit.
    const pays = await db.query(`SELECT count(*)::int n FROM payments WHERE unit_id=$1`, [f.unitId])
    expect(pays.rows[0].n).toBe(0)
  })

  it('marks installments paid; the final one flips home ownership to the buyer', async () => {
    const f = await seed()
    const create = await request(buildApp()).post('/api/resident-home-sales')
      .set('Authorization', `Bearer ${f.token}`)
      .send({ unitId: f.unitId, planType: 'flat', monthlyAmount: 500, numberOfPayments: 3,
              startMonth: '2026-08-01', buyerName: 'Betty Buyer', buyerEmail: 'betty@buyer.dev' })
      .expect(201)
    const saleId = create.body.data.sale.id
    const buyerUserId = create.body.data.sale.buyer_user_id

    // Pay 1 and 2 → still active.
    for (const n of [1, 2]) {
      await request(buildApp()).post(`/api/resident-home-sales/${saleId}/installments/${n}/mark-paid`)
        .set('Authorization', `Bearer ${f.token}`).send({ paid: true }).expect(200)
    }
    let sale = await db.query<any>(`SELECT status FROM resident_home_sales WHERE id=$1`, [saleId])
    expect(sale.rows[0].status).toBe('active')

    // Pay the final installment → paid_off + ownership flips to the buyer.
    const last = await request(buildApp()).post(`/api/resident-home-sales/${saleId}/installments/3/mark-paid`)
      .set('Authorization', `Bearer ${f.token}`).send({ paid: true }).expect(200)
    expect(last.body.data.status).toBe('paid_off')

    const owner = await db.query<any>(
      `SELECT owner_user_id FROM home_ownerships WHERE unit_id=$1 AND status='active'`, [f.unitId])
    expect(owner.rows[0].owner_user_id).toBe(buyerUserId)          // buyer now owns the home
    const dwelling = await db.query<any>(`SELECT dwelling_ownership FROM units WHERE id=$1`, [f.unitId])
    expect(dwelling.rows[0].dwelling_ownership).toBe('tenant')     // still tenant-owned, just a new owner
  })

  it('rejects a park-owned unit (that is the landlord→tenant sale) → 409', async () => {
    const f = await seed('landlord')
    const res = await request(buildApp()).post('/api/resident-home-sales')
      .set('Authorization', `Bearer ${f.token}`)
      .send({ unitId: f.unitId, planType: 'flat', monthlyAmount: 400, numberOfPayments: 6,
              startMonth: '2026-08-01', buyerName: 'Betty Buyer', buyerEmail: 'betty@buyer.dev' })
    expect(res.status).toBe(409)
  })

  it('rejects when the home has no recorded owner (nothing to sell) → 400', async () => {
    const f = await seed()
    await db.query(`UPDATE home_ownerships SET status='removed' WHERE unit_id=$1`, [f.unitId])
    const res = await request(buildApp()).post('/api/resident-home-sales')
      .set('Authorization', `Bearer ${f.token}`)
      .send({ unitId: f.unitId, planType: 'flat', monthlyAmount: 400, numberOfPayments: 6,
              startMonth: '2026-08-01', buyerName: 'Betty Buyer', buyerEmail: 'betty@buyer.dev' })
    expect(res.status).toBe(400)
  })
})
