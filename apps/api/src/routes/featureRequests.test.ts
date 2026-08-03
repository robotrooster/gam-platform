import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { randomUUID } from 'crypto'
import { db } from '../db'
import { cleanupAllSchema, seedTenant } from '../test/dbHelpers'
import { featureRequestsRouter } from './featureRequests'
import { errorHandler } from '../middleware/errorHandler'

function buildApp() {
  const app = express()
  app.use(express.json({ limit: '2mb' }))
  app.use('/api/feature-requests', featureRequestsRouter)
  app.use(errorHandler)
  return app
}

beforeEach(async () => {
  await cleanupAllSchema()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_feature'
})

async function seedTenantToken(): Promise<{ userId: string; token: string }> {
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    const tenantId = await seedTenant(client)
    const tu = await client.query<{ user_id: string }>(`SELECT user_id FROM tenants WHERE id=$1`, [tenantId])
    await client.query('COMMIT')
    const userId = tu.rows[0].user_id
    const token = jwt.sign({ userId, role: 'tenant', email: 't@test.dev', profileId: tenantId, permissions: {} }, process.env.JWT_SECRET!, { expiresIn: '1h' })
    return { userId, token }
  } finally { client.release() }
}

function superAdminToken(): string {
  // requireSuperAdmin only inspects the JWT role — no users row needed.
  return jwt.sign({ userId: randomUUID(), role: 'super_admin', email: 'owner@gam.dev', profileId: randomUUID(), permissions: {} }, process.env.JWT_SECRET!, { expiresIn: '1h' })
}

describe('feature requests', () => {
  it('a tenant can submit and see their own request', async () => {
    const { token } = await seedTenantToken()
    const app = buildApp()
    const res = await request(app).post('/api/feature-requests')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'Installment rent', description: 'Let me split rent into two payments a month.' })
    expect(res.status).toBe(201)
    expect(res.body.data.status).toBe('new')
    expect(res.body.data.submitter_role).toBe('tenant')

    const mine = await request(app).get('/api/feature-requests/mine').set('Authorization', `Bearer ${token}`)
    expect(mine.status).toBe(200)
    expect(mine.body.data).toHaveLength(1)
  })

  it('rejects a too-short submission (zod)', async () => {
    const { token } = await seedTenantToken()
    const res = await request(buildApp()).post('/api/feature-requests')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'x', description: 'y' })
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(res.status).toBeLessThan(500)
  })

  it('a tenant cannot list all requests (super-admin only)', async () => {
    const { token } = await seedTenantToken()
    const res = await request(buildApp()).get('/api/feature-requests').set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(403)
  })

  it('super-admin can list and triage', async () => {
    const { token } = await seedTenantToken()
    const app = buildApp()
    const created = await request(app).post('/api/feature-requests')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'Dark mode', description: 'Please add a dark theme to the portal.' })
    const id = created.body.data.id

    const admin = superAdminToken()
    const list = await request(app).get('/api/feature-requests').set('Authorization', `Bearer ${admin}`)
    expect(list.status).toBe(200)
    expect(list.body.data.length).toBeGreaterThanOrEqual(1)

    const patched = await request(app).patch(`/api/feature-requests/${id}`)
      .set('Authorization', `Bearer ${admin}`)
      .send({ status: 'planned', adminNotes: 'Good idea' })
    expect(patched.status).toBe(200)
    expect(patched.body.data.status).toBe('planned')
  })
})
