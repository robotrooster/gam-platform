/**
 * S613 — linking existing units to a property's unit subtypes.
 *
 * Nic (Oak Park): "I also wanna figure out how to link subtypes to different
 * units because there's nowhere that I can see that links those."
 *
 * `units.subtype_id` existed since S527 but was written only at unit creation.
 * These cover the two ways it can now be set — one unit from the unit page,
 * many units from the subtype — and the rule that makes it safe to do on an
 * occupied park: classification is always allowed, PRICING never moves under an
 * active lease.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { db } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedLease } from '../test/dbHelpers'
import { unitsRouter } from './units'
import { propertiesRouter } from './properties'
import { errorHandler } from '../middleware/errorHandler'

function buildApp() {
  const app = express()
  app.use(express.json({ limit: '2mb' }))
  app.use('/api/units', unitsRouter)
  app.use('/api/properties', propertiesRouter)
  app.use(errorHandler)
  return app
}

beforeEach(async () => {
  await cleanupAllSchema()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_subtype_link'
})

async function seed() {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const { userId, landlordId } = await seedLandlord(c)
    const propertyId = await seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: userId })
    const rvA = await seedUnit(c, { propertyId, landlordId, unitType: 'rv_spot' })
    const rvB = await seedUnit(c, { propertyId, landlordId, unitType: 'rv_spot' })
    const apt = await seedUnit(c, { propertyId, landlordId, unitType: 'apartment' })
    await c.query('COMMIT')
    const token = jwt.sign(
      { userId, role: 'landlord', profileId: landlordId, landlordId },
      process.env.JWT_SECRET!, { expiresIn: '1h' })
    return { userId, landlordId, propertyId, rvA, rvB, apt, token }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

async function makeSubtype(app: any, f: any, body: any) {
  const res = await request(app).post(`/api/properties/${f.propertyId}/unit-subtypes`)
    .set('Authorization', `Bearer ${f.token}`).send(body)
  expect(res.status).toBe(200)
  return res.body.data
}

describe('unit ↔ subtype linking (S613)', () => {
  it('links one unit and shows the subtype name back on the unit', async () => {
    const app = buildApp(); const f = await seed()
    const s = await makeSubtype(app, f, {
      unitType: 'rv_spot', name: 'Back-in 50 amp', rvSiteLayout: 'back_in', rvAmpService: '50',
    })
    const res = await request(app).patch(`/api/units/${f.rvA}/subtype`)
      .set('Authorization', `Bearer ${f.token}`).send({ subtypeId: s.id })
    expect(res.status).toBe(200)
    const unit = await request(app).get(`/api/units/${f.rvA}`).set('Authorization', `Bearer ${f.token}`)
    expect(unit.body.data.subtype_id ?? unit.body.data.subtypeId).toBe(s.id)
    expect(unit.body.data.subtype_name ?? unit.body.data.subtypeName).toBe('Back-in 50 amp')
  })

  it('applying pushes the physical facts onto the unit', async () => {
    const app = buildApp(); const f = await seed()
    const s = await makeSubtype(app, f, {
      unitType: 'rv_spot', name: 'Back-in 30 amp', rvSiteLayout: 'back_in', rvAmpService: '30',
      rentAmount: 440,
    })
    await request(app).patch(`/api/units/${f.rvA}/subtype`)
      .set('Authorization', `Bearer ${f.token}`).send({ subtypeId: s.id, applyDetails: true })
    const row = (await db.query(`SELECT rv_site_layout, rv_amp_service, rent_amount FROM units WHERE id=$1`, [f.rvA])).rows[0]
    expect(row.rv_site_layout).toBe('back_in')
    expect(row.rv_amp_service).toBe('30')
    expect(Number(row.rent_amount)).toBe(440)
  })

  it('an occupied unit can still be classified, but its rent does not move', async () => {
    const app = buildApp(); const f = await seed()
    const c = await db.connect()
    try { await seedLease(c, { unitId: f.rvA, landlordId: f.landlordId, status: 'active' }) } finally { c.release() }
    const before = (await db.query(`SELECT rent_amount FROM units WHERE id=$1`, [f.rvA])).rows[0].rent_amount
    const s = await makeSubtype(app, f, {
      unitType: 'rv_spot', name: 'Back-in 50 amp', rvSiteLayout: 'back_in', rvAmpService: '50', rentAmount: 999,
    })
    const res = await request(app).patch(`/api/units/${f.rvA}/subtype`)
      .set('Authorization', `Bearer ${f.token}`).send({ subtypeId: s.id, applyDetails: true })
    expect(res.status).toBe(200)
    expect(res.body.data.pricingHeldBack).toBe(true)
    const row = (await db.query(`SELECT subtype_id, rv_amp_service, rent_amount FROM units WHERE id=$1`, [f.rvA])).rows[0]
    expect(row.subtype_id).toBe(s.id)          // classified
    expect(row.rv_amp_service).toBe('50')      // a fact about the space
    expect(Number(row.rent_amount)).toBe(Number(before))  // committed to the lease
  })

  it('refuses a subtype for a different kind of unit', async () => {
    const app = buildApp(); const f = await seed()
    const s = await makeSubtype(app, f, { unitType: 'rv_spot', name: 'Back-in 50 amp' })
    const res = await request(app).patch(`/api/units/${f.apt}/subtype`)
      .set('Authorization', `Bearer ${f.token}`).send({ subtypeId: s.id })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/different kind of unit/i)
  })

  it('bulk assign sets membership — unchecked units are unlinked', async () => {
    const app = buildApp(); const f = await seed()
    const s = await makeSubtype(app, f, { unitType: 'rv_spot', name: 'Back-in 50 amp', rvAmpService: '50' })

    const both = await request(app).put(`/api/properties/${f.propertyId}/unit-subtypes/${s.id}/units`)
      .set('Authorization', `Bearer ${f.token}`).send({ unitIds: [f.rvA, f.rvB] })
    expect(both.status).toBe(200)
    expect(both.body.data.linked).toBe(2)

    const one = await request(app).put(`/api/properties/${f.propertyId}/unit-subtypes/${s.id}/units`)
      .set('Authorization', `Bearer ${f.token}`).send({ unitIds: [f.rvA] })
    expect(one.status).toBe(200)
    const rows = (await db.query(`SELECT id, subtype_id FROM units WHERE id = ANY($1::uuid[])`, [[f.rvA, f.rvB]])).rows
    expect(rows.find((r: any) => r.id === f.rvA).subtype_id).toBe(s.id)
    expect(rows.find((r: any) => r.id === f.rvB).subtype_id).toBeNull()
  })

  it('bulk assign offers only units of the subtype\'s own type', async () => {
    const app = buildApp(); const f = await seed()
    const s = await makeSubtype(app, f, { unitType: 'rv_spot', name: 'Back-in 50 amp' })
    const list = await request(app).get(`/api/properties/${f.propertyId}/unit-subtypes/${s.id}/units`)
      .set('Authorization', `Bearer ${f.token}`)
    expect(list.status).toBe(200)
    const ids = list.body.data.map((r: any) => r.id).sort()
    expect(ids).toEqual([f.rvA, f.rvB].sort())
  })

  it('the subtype list reports how many units carry it', async () => {
    const app = buildApp(); const f = await seed()
    const s = await makeSubtype(app, f, { unitType: 'rv_spot', name: 'Back-in 50 amp' })
    await request(app).put(`/api/properties/${f.propertyId}/unit-subtypes/${s.id}/units`)
      .set('Authorization', `Bearer ${f.token}`).send({ unitIds: [f.rvA, f.rvB] })
    const list = await request(app).get(`/api/properties/${f.propertyId}/unit-subtypes`)
      .set('Authorization', `Bearer ${f.token}`)
    expect(list.body.data[0].unit_count).toBe(2)
  })

  it('clearing the subtype leaves the unit\'s own values alone', async () => {
    const app = buildApp(); const f = await seed()
    const s = await makeSubtype(app, f, {
      unitType: 'rv_spot', name: 'Back-in 50 amp', rvSiteLayout: 'back_in', rvAmpService: '50' })
    await request(app).patch(`/api/units/${f.rvA}/subtype`)
      .set('Authorization', `Bearer ${f.token}`).send({ subtypeId: s.id, applyDetails: true })
    const res = await request(app).patch(`/api/units/${f.rvA}/subtype`)
      .set('Authorization', `Bearer ${f.token}`).send({ subtypeId: null })
    expect(res.status).toBe(200)
    const row = (await db.query(`SELECT subtype_id, rv_amp_service FROM units WHERE id=$1`, [f.rvA])).rows[0]
    expect(row.subtype_id).toBeNull()
    expect(row.rv_amp_service).toBe('50')
  })
})
