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
    const rows = await db.query<any>(
      `SELECT count(*)::int AS n FROM unit_subtype_links WHERE subtype_id=$1`, [rvSub])
    expect(rows.rows[0].n).toBe(2)
  })

  // S630 DIRECTIVE (Nic): "Units need to be able to handle multiple subtypes as a
  // checkbox... it's not having back in fifty and back in thirty as two separate
  // things. Each distinct categorization is selectable without being bundled."
  it('holds several independent subtypes at once', async () => {
    const c = await db.connect()
    let amp50 = ''
    try {
      amp50 = (await c.query(
        `INSERT INTO property_unit_subtypes (property_id, unit_type, name)
         VALUES ($1,'rv_spot','50 Amp') RETURNING id`, [propId])).rows[0].id
    } finally { c.release() }

    const res = await post({ unitIds: [rvA], subtypeIds: [rvSub, amp50] })
    expect(res.status).toBe(200)
    expect(res.body.data.subtypes.sort()).toEqual(['50 Amp', 'Pull-Through'])

    const links = await db.query<any>(
      `SELECT s.name FROM unit_subtype_links l
         JOIN property_unit_subtypes s ON s.id=l.subtype_id
        WHERE l.unit_id=$1 ORDER BY s.name`, [rvA])
    expect(links.rows.map((r: any) => r.name)).toEqual(['50 Amp', 'Pull-Through'])
  })

  it('REPLACES the set — unchecking one is expressed by leaving it out', async () => {
    const c = await db.connect()
    let amp50 = ''
    try {
      amp50 = (await c.query(
        `INSERT INTO property_unit_subtypes (property_id, unit_type, name)
         VALUES ($1,'rv_spot','50 Amp') RETURNING id`, [propId])).rows[0].id
    } finally { c.release() }

    await post({ unitIds: [rvA], subtypeIds: [rvSub, amp50] })
    await post({ unitIds: [rvA], subtypeIds: [amp50] })
    const links = await db.query<any>(
      `SELECT s.name FROM unit_subtype_links l
         JOIN property_unit_subtypes s ON s.id=l.subtype_id WHERE l.unit_id=$1`, [rvA])
    expect(links.rows.map((r: any) => r.name)).toEqual(['50 Amp'])
  })

  it('clears every subtype when passed an empty list', async () => {
    await post({ unitIds: [rvA], subtypeIds: [rvSub] })
    const res = await post({ unitIds: [rvA], subtypeIds: [] })
    expect(res.status).toBe(200)
    const links = await db.query(`SELECT 1 FROM unit_subtype_links WHERE unit_id=$1`, [rvA])
    expect(links.rows).toHaveLength(0)
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
    const rows = await db.query<any>(`SELECT count(*)::int AS n FROM unit_subtype_links`)
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
