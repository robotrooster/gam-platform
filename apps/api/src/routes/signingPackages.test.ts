/**
 * S641 — the signing-package routes, and the two things a package must never do:
 * reach for somebody else's template, or pin to somebody else's property.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { db } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit } from '../test/dbHelpers'
import { signingPackagesRouter } from './signingPackages'
import { errorHandler } from '../middleware/errorHandler'

function buildApp() {
  const app = express()
  app.use(express.json({ limit: '2mb' }))
  app.use('/api/signing-packages', signingPackagesRouter)
  app.use(errorHandler)
  return app
}

beforeEach(async () => {
  await cleanupAllSchema()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_packages'
})

async function seed() {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const a = await seedLandlord(c)
    const b = await seedLandlord(c)
    const propA1 = await seedProperty(c, { landlordId: a.landlordId, ownerUserId: a.userId, managedByUserId: a.userId })
    const propA2 = await seedProperty(c, { landlordId: a.landlordId, ownerUserId: a.userId, managedByUserId: a.userId })
    const propB  = await seedProperty(c, { landlordId: b.landlordId, ownerUserId: b.userId, managedByUserId: b.userId })
    const unitA = await seedUnit(c, { propertyId: propA1, landlordId: a.landlordId })
    await c.query(`UPDATE units SET unit_type='mobile_home' WHERE id=$1`, [unitA])
    const tplA = await c.query<{ id: string }>(
      `INSERT INTO lease_templates (landlord_id, name, purpose) VALUES ($1,'A Lease','lease') RETURNING id`, [a.landlordId])
    const tplB = await c.query<{ id: string }>(
      `INSERT INTO lease_templates (landlord_id, name, purpose) VALUES ($1,'B Lease','lease') RETURNING id`, [b.landlordId])
    await c.query('COMMIT')

    const sign = (uid: string, lid: string) => jwt.sign(
      { userId: uid, role: 'landlord', email: 'l@t.dev', profileId: lid, permissions: {} },
      process.env.JWT_SECRET!, { expiresIn: '1h' })
    return {
      a, b, propA1, propA2, propB, unitA,
      tplA: tplA.rows[0].id, tplB: tplB.rows[0].id,
      tokenA: sign(a.userId, a.landlordId), tokenB: sign(b.userId, b.landlordId),
    }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

describe('packages', () => {
  it('creates one with its items and reads it back in order', async () => {
    const f = await seed()
    const create = await request(buildApp())
      .post('/api/signing-packages').set('Authorization', `Bearer ${f.tokenA}`)
      .send({ name: 'AZ Park-Owned Homes', unitType: 'mobile_home', isDefault: true,
              items: [{ templateId: f.tplA, renewalBehavior: 'with_lease', required: true }] })
    expect(create.status).toBe(201)

    const list = await request(buildApp())
      .get('/api/signing-packages').set('Authorization', `Bearer ${f.tokenA}`)
    expect(list.status).toBe(200)
    expect(list.body.data).toHaveLength(1)
    expect(list.body.data[0].items[0].templateName).toBe('A Lease')
    expect(list.body.data[0].items[0].required).toBe(true)
  })

  it('refuses to build a package out of somebody else\'s template', async () => {
    const f = await seed()
    const res = await request(buildApp())
      .post('/api/signing-packages').set('Authorization', `Bearer ${f.tokenA}`)
      .send({ name: 'Sneaky', items: [{ templateId: f.tplB }] })
    expect(res.status).toBe(403)
  })

  it('another landlord cannot see it', async () => {
    const f = await seed()
    await request(buildApp()).post('/api/signing-packages')
      .set('Authorization', `Bearer ${f.tokenA}`).send({ name: 'Mine' })
    const res = await request(buildApp())
      .get('/api/signing-packages').set('Authorization', `Bearer ${f.tokenB}`)
    expect(res.body.data).toHaveLength(0)
  })

  it('deleting archives rather than erasing', async () => {
    const f = await seed()
    const c = await request(buildApp()).post('/api/signing-packages')
      .set('Authorization', `Bearer ${f.tokenA}`).send({ name: 'Old' })
    await request(buildApp()).delete(`/api/signing-packages/${c.body.data.id}`)
      .set('Authorization', `Bearer ${f.tokenA}`).expect(200)

    const { rows } = await db.query(`SELECT archived_at FROM document_packages WHERE id=$1`, [c.body.data.id])
    expect(rows).toHaveLength(1)
    expect(rows[0].archived_at).not.toBeNull()
  })
})

describe('pinning a template to properties', () => {
  it('pins to two and leaves the third alone', async () => {
    const f = await seed()
    await request(buildApp())
      .put(`/api/signing-packages/templates/${f.tplA}/properties`)
      .set('Authorization', `Bearer ${f.tokenA}`)
      .send({ propertyIds: [f.propA1, f.propA2] }).expect(200)

    const res = await request(buildApp())
      .get(`/api/signing-packages/templates/${f.tplA}/properties`)
      .set('Authorization', `Bearer ${f.tokenA}`)
    expect(res.body.data.sort()).toEqual([f.propA1, f.propA2].sort())
  })

  it('an empty list unpins back to available everywhere', async () => {
    const f = await seed()
    const app = buildApp()
    await request(app).put(`/api/signing-packages/templates/${f.tplA}/properties`)
      .set('Authorization', `Bearer ${f.tokenA}`).send({ propertyIds: [f.propA1] }).expect(200)
    await request(app).put(`/api/signing-packages/templates/${f.tplA}/properties`)
      .set('Authorization', `Bearer ${f.tokenA}`).send({ propertyIds: [] }).expect(200)

    const res = await request(app).get(`/api/signing-packages/templates/${f.tplA}/properties`)
      .set('Authorization', `Bearer ${f.tokenA}`)
    expect(res.body.data).toEqual([])
  })

  it('cannot pin to a property belonging to somebody else', async () => {
    const f = await seed()
    const res = await request(buildApp())
      .put(`/api/signing-packages/templates/${f.tplA}/properties`)
      .set('Authorization', `Bearer ${f.tokenA}`)
      .send({ propertyIds: [f.propB] })
    expect(res.status).toBe(403)
  })

  it('cannot pin somebody else\'s template', async () => {
    const f = await seed()
    const res = await request(buildApp())
      .put(`/api/signing-packages/templates/${f.tplB}/properties`)
      .set('Authorization', `Bearer ${f.tokenA}`)
      .send({ propertyIds: [f.propA1] })
    expect(res.status).toBe(404)
  })
})

describe('the draft checklist for a unit', () => {
  it('returns the default package with items pre-ticked', async () => {
    const f = await seed()
    await request(buildApp()).post('/api/signing-packages')
      .set('Authorization', `Bearer ${f.tokenA}`)
      .send({ name: 'AZ Homes', unitType: 'mobile_home', isDefault: true,
              items: [{ templateId: f.tplA }] }).expect(201)

    const res = await request(buildApp())
      .get(`/api/signing-packages/for-unit/${f.unitA}`)
      .set('Authorization', `Bearer ${f.tokenA}`)
    expect(res.status).toBe(200)
    expect(res.body.data.name).toBe('AZ Homes')
    expect(res.body.data.items[0].suggested).toBe(true)
  })

  it('another landlord cannot ask about this unit', async () => {
    const f = await seed()
    const res = await request(buildApp())
      .get(`/api/signing-packages/for-unit/${f.unitA}`)
      .set('Authorization', `Bearer ${f.tokenB}`)
    expect(res.status).toBe(404)
  })
})
