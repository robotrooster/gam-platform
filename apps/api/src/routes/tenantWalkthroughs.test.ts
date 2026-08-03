import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { db } from '../db'
import { cleanupAllSchema, seedLandlord, seedTenant, seedProperty, seedUnit, seedLease, seedLeaseTenant } from '../test/dbHelpers'
import { tenantWalkthroughsRouter } from './tenantWalkthroughs'
import { errorHandler } from '../middleware/errorHandler'

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/tenant-walkthroughs', tenantWalkthroughsRouter)
  app.use(errorHandler)
  return app
}

beforeEach(async () => {
  await cleanupAllSchema()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_walkthrough'
})

async function seedTenantOnUnit() {
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    const { userId: llUser, landlordId } = await seedLandlord(client)
    const tenantId = await seedTenant(client)
    const tu = await client.query<{ user_id: string }>(`SELECT user_id FROM tenants WHERE id=$1`, [tenantId])
    const propertyId = await seedProperty(client, { landlordId, ownerUserId: llUser, managedByUserId: llUser })
    const unitId = await seedUnit(client, { propertyId, landlordId })
    const leaseId = await seedLease(client, { unitId, landlordId })
    await seedLeaseTenant(client, { leaseId, tenantId })
    await client.query('COMMIT')
    const token = jwt.sign({ userId: tu.rows[0].user_id, role: 'tenant', email: 't@test.dev', profileId: tenantId, permissions: {} }, process.env.JWT_SECRET!, { expiresIn: '1h' })
    return { tenantId, token, unitId }
  } catch (e) { await client.query('ROLLBACK'); throw e } finally { client.release() }
}

const jpg = () => Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46])

describe('tenant walkthroughs', () => {
  it('a tenant can upload a walkthrough photo and list their own', async () => {
    const t = await seedTenantOnUnit()
    const up = await request(buildApp())
      .post('/api/tenant-walkthroughs/media')
      .set('Authorization', `Bearer ${t.token}`)
      .field('caption', 'kitchen — move-in condition')
      .attach('file', jpg(), { filename: 'w.jpg', contentType: 'image/jpeg' })
    expect(up.status).toBe(201)
    expect(up.body.data.media_type).toBe('photo')

    const mine = await request(buildApp())
      .get('/api/tenant-walkthroughs/mine')
      .set('Authorization', `Bearer ${t.token}`)
    expect(mine.status).toBe(200)
    expect(mine.body.data).toHaveLength(1)
    expect(mine.body.data[0].caption).toContain('move-in')
    // Resolved the unit from the active lease.
    expect(mine.body.data[0].unit_number).toBeTruthy()
  })

  it('a non-tenant cannot upload', async () => {
    const admin = jwt.sign({ userId: '00000000-0000-0000-0000-000000000001', role: 'landlord', email: 'l@test.dev', profileId: '00000000-0000-0000-0000-000000000002', permissions: {} }, process.env.JWT_SECRET!, { expiresIn: '1h' })
    const res = await request(buildApp())
      .post('/api/tenant-walkthroughs/media')
      .set('Authorization', `Bearer ${admin}`)
      .attach('file', jpg(), { filename: 'w.jpg', contentType: 'image/jpeg' })
    expect(res.status).toBe(403)
  })

  it('is immutable — no delete route (404)', async () => {
    const t = await seedTenantOnUnit()
    const res = await request(buildApp())
      .delete('/api/tenant-walkthroughs/media/whatever')
      .set('Authorization', `Bearer ${t.token}`)
    expect(res.status).toBe(404)
  })
})
