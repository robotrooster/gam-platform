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
  // S637 (Nic, whose account owns two LLCs): GET /lot-rent/portfolio answered
  // "You own more than one company. Choose which one this record belongs to."
  // — on a READ, so the Lot Rent tab could not be opened at all. Same defect as
  // the Expenses tab: the WRITE resolver was scoping a list.
  //
  // Reads span every entity the account owns; writes still name their target.
  it('S637: an account owning TWO entities can open the portfolio, spanning both', async () => {
    const c = await db.connect()
    let userId = '', llB = ''
    try {
      await c.query('BEGIN')
      const a = await seedLandlord(c); userId = a.userId
      const propA = await seedProperty(c, { landlordId: a.landlordId, ownerUserId: userId, managedByUserId: userId })
      await c.query(`UPDATE properties SET operator_owns_land = FALSE WHERE id = $1`, [propA])
      await seedUnit(c, { propertyId: propA, landlordId: a.landlordId })

      const b = await c.query<{ id: string }>(
        `INSERT INTO landlords (user_id, billing_starts_at) VALUES ($1, DATE '2000-01-01') RETURNING id`, [userId])
      llB = b.rows[0].id
      const propB = await seedProperty(c, { landlordId: llB, ownerUserId: userId, managedByUserId: userId })
      await c.query(`UPDATE properties SET operator_owns_land = FALSE WHERE id = $1`, [propB])
      await seedUnit(c, { propertyId: propB, landlordId: llB })
      await c.query('COMMIT')
    } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }

    // profileId null — what auth.ts mints for a landlord since S633.
    const token = jwt.sign({ userId, role: 'landlord', email: 'two@t.dev', profileId: null, permissions: {} },
      process.env.JWT_SECRET!, { expiresIn: '1h' })

    const res = await request(buildApp()).get('/api/lot-rent/portfolio')
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)                       // was 400 before S637
    expect(res.body.data.homes.length).toBe(2)         // one from each company

    // ?entityId= still narrows, through the same authorisation.
    const justB = await request(buildApp()).get(`/api/lot-rent/portfolio?entityId=${llB}`)
      .set('Authorization', `Bearer ${token}`)
    expect(justB.status).toBe(200)
    expect(justB.body.data.homes.length).toBe(1)

    // Charges list spans the account too, rather than 400ing.
    const charges = await request(buildApp()).get('/api/lot-rent/charges')
      .set('Authorization', `Bearer ${token}`)
    expect(charges.status).toBe(200)
  })

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
