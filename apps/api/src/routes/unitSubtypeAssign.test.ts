/**
 * S630 (Nic): "Setting that subtype on the bulk creation does not actually link
 * it... my subtypes are showing zero units in each."
 *
 * The creation bug is fixed elsewhere. This is the way back for units already on
 * the platform — 53 RV spaces created unlinked, and properties are permanent, so
 * re-making them was never an option.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { db } from '../db'
import { unitsRouter } from './units'
import { errorHandler } from '../middleware/errorHandler'
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit } from '../test/dbHelpers'

function buildApp() {
  const app = express(); app.use(express.json())
  app.use('/api/units', unitsRouter); app.use(errorHandler); return app
}

describe('POST /api/units/subtype', () => {
  let token = '', landlordId = '', userId = '', propId = ''
  let rvA = '', rvB = '', home = '', rvSub = '', homeSub = ''

  beforeEach(async () => {
    await cleanupAllSchema()
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_s450'
    const c = await db.connect()
    try {
      await c.query('BEGIN')
      const ll = await seedLandlord(c); userId = ll.userId; landlordId = ll.landlordId
      propId = await seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: userId })
      rvA  = await seedUnit(c, { propertyId: propId, landlordId, unitType: 'rv_spot' })
      rvB  = await seedUnit(c, { propertyId: propId, landlordId, unitType: 'rv_spot' })
      home = await seedUnit(c, { propertyId: propId, landlordId, unitType: 'mobile_home' })
      // A subtype with NO price — the shape that broke creation in the first place.
      rvSub = (await c.query(
        `INSERT INTO property_unit_subtypes (property_id, unit_type, name) VALUES ($1,'rv_spot','Pull-Through') RETURNING id`,
        [propId])).rows[0].id
      homeSub = (await c.query(
        `INSERT INTO property_unit_subtypes (property_id, unit_type, name) VALUES ($1,'mobile_home','Tenant Owned') RETURNING id`,
        [propId])).rows[0].id
      await c.query('COMMIT')
    } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
    token = jwt.sign({ userId, role: 'landlord', email: 'll@t.dev', profileId: landlordId,
                       landlordIds: [landlordId], permissions: {} }, process.env.JWT_SECRET!, { expiresIn: '1h' })
  })

  const post = (body: any) => request(buildApp()).post('/api/units/subtype')
    .set('Authorization', `Bearer ${token}`).send(body)

  it('classifies units in bulk', async () => {
    const res = await post({ unitIds: [rvA, rvB], subtypeId: rvSub })
    expect(res.status).toBe(200)
    expect(res.body.data.updated).toBe(2)
    const rows = await db.query<any>(`SELECT count(*)::int AS n FROM units WHERE subtype_id=$1`, [rvSub])
    expect(rows.rows[0].n).toBe(2)
  })

  it('clears a subtype when passed null', async () => {
    await post({ unitIds: [rvA], subtypeId: rvSub })
    const res = await post({ unitIds: [rvA], subtypeId: null })
    expect(res.status).toBe(200)
    const rows = await db.query<any>(`SELECT subtype_id FROM units WHERE id=$1`, [rvA])
    expect(rows.rows[0].subtype_id).toBeNull()
  })

  // Classifying 40 of 53 and staying quiet about the rest is worse than doing
  // nothing — the landlord would never know which ones missed.
  it('refuses the whole batch when any unit is the wrong type, and names them', async () => {
    const res = await post({ unitIds: [rvA, home], subtypeId: rvSub })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/Nothing was changed/i)
    const rows = await db.query<any>(`SELECT count(*)::int AS n FROM units WHERE subtype_id IS NOT NULL`)
    expect(rows.rows[0].n).toBe(0)
  })

  it('refuses a subtype from another property', async () => {
    const c = await db.connect()
    let foreignSub = ''
    try {
      await c.query('BEGIN')
      const other = await seedLandlord(c)
      const otherProp = await seedProperty(c, { landlordId: other.landlordId, ownerUserId: other.userId, managedByUserId: other.userId })
      foreignSub = (await c.query(
        `INSERT INTO property_unit_subtypes (property_id, unit_type, name) VALUES ($1,'rv_spot','Theirs') RETURNING id`,
        [otherProp])).rows[0].id
      await c.query('COMMIT')
    } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
    const res = await post({ unitIds: [rvA], subtypeId: foreignSub })
    expect(res.status).toBe(404)
  })

  it('another landlord cannot reclassify these units', async () => {
    const c = await db.connect()
    let otherToken = ''
    try {
      await c.query('BEGIN')
      const other = await seedLandlord(c)
      await c.query('COMMIT')
      otherToken = jwt.sign({ userId: other.userId, role: 'landlord', email: 'b@t.dev',
                              profileId: other.landlordId, landlordIds: [other.landlordId], permissions: {} },
                             process.env.JWT_SECRET!, { expiresIn: '1h' })
    } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
    const res = await request(buildApp()).post('/api/units/subtype')
      .set('Authorization', `Bearer ${otherToken}`).send({ unitIds: [rvA], subtypeId: rvSub })
    expect(res.status).toBe(403)
  })
})
