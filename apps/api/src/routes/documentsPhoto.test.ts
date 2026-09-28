/**
 * S652 (Nic): "maintenance people need to be able to add a picture… a picture
 * of said notice to that tenant's profile." A worker holding ONLY "Add photos &
 * posted notices" can put a photo on a resident's record at a property they
 * are assigned to, and nothing more through the documents door.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { db } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedTenant, seedLease, seedLeaseTenant } from '../test/dbHelpers'
import { documentsRouter } from './documents'
import { errorHandler } from '../middleware/errorHandler'

function buildApp() {
  const app = express(); app.use(express.json()); app.use('/api/documents', documentsRouter); app.use(errorHandler); return app
}
beforeEach(async () => { await cleanupAllSchema(); process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_docs_photo' })
const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fe0d7a5f2c0000000049454e44ae426082', 'hex')

async function seed() {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const ll = await seedLandlord(c)
    const parkA = await seedProperty(c, { landlordId: ll.landlordId, ownerUserId: ll.userId, managedByUserId: ll.userId })
    const parkB = await seedProperty(c, { landlordId: ll.landlordId, ownerUserId: ll.userId, managedByUserId: ll.userId })
    const mk = async (propertyId: string) => {
      const unitId = await seedUnit(c, { propertyId, landlordId: ll.landlordId })
      const tenantId = await seedTenant(c)
      const leaseId = await seedLease(c, { unitId, landlordId: ll.landlordId, startDate: '2026-01-01' })
      await seedLeaseTenant(c, { leaseId, tenantId })
      const t = await c.query<{ user_id: string }>(`SELECT user_id FROM tenants WHERE id=$1`, [tenantId])
      return { unitId, tenantId, tenantUserId: t.rows[0].user_id }
    }
    const a = await mk(parkA), b = await mk(parkB)
    const w = await c.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
       VALUES ($1,'x','maintenance','Wrench','Worker',TRUE) RETURNING id`, [`w-${Date.now()}@test.dev`])
    const workerId = w.rows[0].id
    await c.query(`INSERT INTO maintenance_worker_scopes (user_id, landlord_id, property_ids, unit_ids, job_categories, all_properties, permissions)
                   VALUES ($1,$2,$3,'{}','{}',FALSE,'{"documents.post_photo": true}')`, [workerId, ll.landlordId, [parkA]])
    await c.query('COMMIT')
    const worker = jwt.sign({ userId: workerId, role: 'maintenance', email: 'w@test.dev', profileId: workerId, landlordId: ll.landlordId, permissions: { 'documents.post_photo': true } }, process.env.JWT_SECRET!, { expiresIn: '1h' })
    const landlord = jwt.sign({ userId: ll.userId, role: 'landlord', email: 'll@test.dev', profileId: ll.landlordId, landlordIds: [ll.landlordId], permissions: {} }, process.env.JWT_SECRET!, { expiresIn: '1h' })
    const tenantA = jwt.sign({ userId: a.tenantUserId, role: 'tenant', email: 't@test.dev', profileId: a.tenantId, permissions: {} }, process.env.JWT_SECRET!, { expiresIn: '1h' })
    return { ll, parkA, parkB, a, b, worker, landlord, tenantA }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

describe('a posted-notice photo on a resident\'s record', () => {
  it('worker with only the photo permission: sees their park, its residents, and files the photo', async () => {
    const f = await seed()
    const props = await request(buildApp()).get('/api/documents/photo-targets').set('Authorization', `Bearer ${f.worker}`)
    expect(props.status).toBe(200)
    expect(props.body.data.properties.map((p: any) => p.id)).toEqual([f.parkA])
    const who = await request(buildApp()).get(`/api/documents/photo-targets?propertyId=${f.parkA}`).set('Authorization', `Bearer ${f.worker}`)
    expect(who.body.data.residents.map((r: any) => r.tenant_id)).toEqual([f.a.tenantId])

    const res = await request(buildApp()).post('/api/documents').set('Authorization', `Bearer ${f.worker}`)
      .field('type', 'notice').field('tenantId', f.a.tenantId).field('note', '5-day notice, front door').field('postedAt', '2026-09-28')
      .attach('file', png, { filename: 'door.png', contentType: 'image/png' })
    expect(res.status, JSON.stringify(res.body)).toBe(201)
    expect(res.body.data.type).toBe('notice')
    expect(res.body.data.note).toBe('5-day notice, front door')
    expect(res.body.data.unit_id).toBe(f.a.unitId)

    // the landlord sees it on the resident's record; the resident sees it in their documents
    const ll = await request(buildApp()).get(`/api/documents?tenantId=${f.a.tenantId}`).set('Authorization', `Bearer ${f.landlord}`)
    expect(ll.body.data.map((d: any) => d.type)).toEqual(['notice'])
    const mine = await request(buildApp()).get('/api/documents').set('Authorization', `Bearer ${f.tenantA}`)
    expect(mine.body.data).toHaveLength(1)
    expect(mine.body.data[0].posted_at).toMatch(/^2026-09-28/)
  })

  it('refuses a resident at a park they are not assigned to, a non-photo, and a lease upload', async () => {
    const f = await seed()
    const foreign = await request(buildApp()).post('/api/documents').set('Authorization', `Bearer ${f.worker}`)
      .field('type', 'notice').field('tenantId', f.b.tenantId).attach('file', png, { filename: 'x.png', contentType: 'image/png' })
    expect(foreign.status).toBe(403)
    const pdf = await request(buildApp()).post('/api/documents').set('Authorization', `Bearer ${f.worker}`)
      .field('type', 'notice').field('tenantId', f.a.tenantId).attach('file', Buffer.from('%PDF-1.4'), { filename: 'x.pdf', contentType: 'application/pdf' })
    expect(pdf.status).toBe(400)
    const lease = await request(buildApp()).post('/api/documents').set('Authorization', `Bearer ${f.worker}`)
      .field('type', 'lease').field('tenantId', f.a.tenantId).attach('file', png, { filename: 'x.png', contentType: 'image/png' })
    expect(lease.status).toBe(403)
    const none = await request(buildApp()).post('/api/documents').set('Authorization', `Bearer ${f.worker}`)
      .field('type', 'notice').attach('file', png, { filename: 'x.png', contentType: 'image/png' })
    expect(none.status).toBe(400)
  })
})
