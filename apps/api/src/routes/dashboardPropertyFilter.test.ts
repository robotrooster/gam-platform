/**
 * S637 — filtering the dashboard to one property.
 *
 * Nic: "I need to be able to filter from the dashboard to see what other
 * co-owners are seeing. Right now, all properties are blended on the
 * dashboard. And when a co-owner only sees one property because they don't
 * own all the properties together with me, they're seeing different
 * information on the cards."
 *
 * The one that matters most is the last: propertyId arrives in a query
 * string, and an unchecked one would read another landlord's portfolio
 * through an endpoint that has already passed its auth check.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { randomUUID } from 'crypto'
import { db } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit } from '../test/dbHelpers'
// The camelCase middleware lives in index.ts, not on the router — a test
// harness mounting the router alone sees the raw snake_case columns.
import { landlordsRouter } from './landlords'
import { errorHandler } from '../middleware/errorHandler'

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/landlords', landlordsRouter)
  app.use(errorHandler)
  return app
}

const SECRET = 'test_jwt_secret_dashfilter'
let token: string, propA: string, propB: string, otherProp: string

beforeEach(async () => {
  await cleanupAllSchema()
  process.env.JWT_SECRET = SECRET
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const me = await seedLandlord(c)
    propA = await seedProperty(c, { landlordId: me.landlordId, ownerUserId: me.userId, managedByUserId: me.userId })
    propB = await seedProperty(c, { landlordId: me.landlordId, ownerUserId: me.userId, managedByUserId: me.userId })
    // Two occupied units on A, one on B — so a filter changes the numbers.
    for (const rent of [500, 700]) {
      const u = await seedUnit(c, { propertyId: propA, landlordId: me.landlordId })
      await c.query(`UPDATE units SET status='active', rent_amount=$2 WHERE id=$1`, [u, rent])
    }
    const ub = await seedUnit(c, { propertyId: propB, landlordId: me.landlordId })
    await c.query(`UPDATE units SET status='active', rent_amount=300 WHERE id=$1`, [ub])

    const other = await seedLandlord(c)
    otherProp = await seedProperty(c, { landlordId: other.landlordId, ownerUserId: other.userId, managedByUserId: other.userId })
    await c.query('COMMIT')
    token = jwt.sign(
      { userId: me.userId, role: 'landlord', email: 'me@t.dev', profileId: null,
        landlordIds: [me.landlordId], permissions: {} },
      SECRET, { expiresIn: '1h' })
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
})

const dash = (qs = '') => request(buildApp())
  .get(`/api/landlords/me/dashboard${qs}`).set('Authorization', `Bearer ${token}`)

describe('GET /landlords/me/dashboard?propertyId=', () => {
  it('blends every property when nothing is chosen', async () => {
    const res = await dash()
    expect(res.status).toBe(200)
    expect(res.body.data.total_units).toBe(3)
    expect(Number(res.body.data.monthly_rent_volume)).toBe(1500)
    expect(res.body.data.property_count).toBe(2)
  })

  it('narrows the cards to the chosen property', async () => {
    const res = await dash(`?propertyId=${propA}`)
    expect(res.status).toBe(200)
    expect(res.body.data.total_units).toBe(2)
    expect(Number(res.body.data.monthly_rent_volume)).toBe(1200)
    expect(res.body.data.property_count).toBe(1)
  })

  it('narrows to the smaller one too — this is the co-owner view', async () => {
    const res = await dash(`?propertyId=${propB}`)
    expect(res.body.data.total_units).toBe(1)
    expect(Number(res.body.data.monthly_rent_volume)).toBe(300)
  })

  it("REFUSES another landlord's property id", async () => {
    const res = await dash(`?propertyId=${otherProp}`)
    expect(res.status).toBe(404)
  })

  it('refuses an id that does not exist at all', async () => {
    const res = await dash(`?propertyId=${randomUUID()}`)
    expect(res.status).toBe(404)
  })

  it('treats an empty propertyId as the blended view, not an error', async () => {
    const res = await dash('?propertyId=')
    expect(res.status).toBe(200)
    expect(res.body.data.total_units).toBe(3)
  })
})
