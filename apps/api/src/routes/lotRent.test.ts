// S568: investor-operator lot rent — accrual (homes-only only, idempotent),
// record-paid, and the net portfolio.
import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { db } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit } from '../test/dbHelpers'
import { accrueLotRentCharges } from '../services/lotRent'
import { lotRentRouter } from './lotRent'
import { errorHandler } from '../middleware/errorHandler'

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/lot-rent', lotRentRouter)
  app.use(errorHandler)
  return app
}

beforeEach(async () => {
  await cleanupAllSchema()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_lotrent'
})

async function seed() {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const { userId: llUser, landlordId } = await seedLandlord(c)
    // Homes-only external park + a home with lot rent.
    const extProp = await seedProperty(c, { landlordId, ownerUserId: llUser, managedByUserId: llUser })
    await c.query(`UPDATE properties SET operator_owns_land=FALSE WHERE id=$1`, [extProp])
    const home = await seedUnit(c, { propertyId: extProp, landlordId, rentAmount: 900 })
    await c.query(`UPDATE units SET lot_rent_amount=350 WHERE id=$1`, [home])
    // A normal owned park + unit (should NOT accrue lot rent).
    const ownedProp = await seedProperty(c, { landlordId, ownerUserId: llUser, managedByUserId: llUser })
    const ownedUnit = await seedUnit(c, { propertyId: ownedProp, landlordId, rentAmount: 800 })
    await c.query('COMMIT')
    const token = jwt.sign({ userId: llUser, role: 'landlord', email: 'll@t.dev', profileId: landlordId, permissions: {} },
      process.env.JWT_SECRET!, { expiresIn: '1h' })
    return { landlordId, extProp, home, ownedProp, ownedUnit, token }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

describe('lot rent', () => {
  it('accrues one charge per homes-only home with lot rent (idempotent); skips owned parks', async () => {
    const f = await seed()
    const n = await accrueLotRentCharges('2026-08-01')
    expect(n).toBe(1)                                   // only the homes-only home
    const rows = await db.query<any>(`SELECT unit_id, amount::float AS amount, status FROM lot_rent_charges`)
    expect(rows.rows).toHaveLength(1)
    expect(rows.rows[0].unit_id).toBe(f.home)
    expect(rows.rows[0].amount).toBe(350)
    expect(rows.rows[0].status).toBe('pending')
    // Re-run same month → no duplicate.
    expect(await accrueLotRentCharges('2026-08-01')).toBe(0)
  })

  it('portfolio shows net = rent − lot rent for homes-only homes only', async () => {
    const f = await seed()
    await accrueLotRentCharges('2026-08-01')
    const res = await request(buildApp()).get('/api/lot-rent/portfolio').set('Authorization', `Bearer ${f.token}`)
    expect(res.status).toBe(200)
    expect(res.body.data.homes).toHaveLength(1)          // owned-park unit excluded
    expect(res.body.data.homes[0].net).toBe(550)         // 900 − 350
    expect(res.body.data.totals.rent).toBe(900)
    expect(res.body.data.totals.lotRent).toBe(350)
    expect(res.body.data.totals.net).toBe(550)
    expect(res.body.data.outstandingLotRent.count).toBe(1)
    expect(res.body.data.outstandingLotRent.amount).toBe(350)
  })

  it('record-paid marks the obligation paid (and clears from outstanding)', async () => {
    const f = await seed()
    await accrueLotRentCharges('2026-08-01')
    const charges = await request(buildApp()).get('/api/lot-rent/charges').set('Authorization', `Bearer ${f.token}`)
    const chargeId = charges.body.data[0].id
    const paid = await request(buildApp()).post(`/api/lot-rent/charges/${chargeId}/record-paid`).set('Authorization', `Bearer ${f.token}`).send({})
    expect(paid.status).toBe(200)
    const port = await request(buildApp()).get('/api/lot-rent/portfolio').set('Authorization', `Bearer ${f.token}`)
    expect(port.body.data.outstandingLotRent.count).toBe(0)
    // Re-paying → 404 (already paid).
    const again = await request(buildApp()).post(`/api/lot-rent/charges/${chargeId}/record-paid`).set('Authorization', `Bearer ${f.token}`).send({})
    expect(again.status).toBe(404)
  })
})
