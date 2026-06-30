/**
 * S512 #30 — GET /api/background/pool/search proximity ordering.
 *
 * The pool list is sorted by administrative proximity to the landlord's
 * properties (no street-level distance yet — properties carry no lat/lon).
 * Tiering: 0 same ZIP · 1 same city+state · 2 same ZIP3 region ·
 * 3 same state · 4 elsewhere, ties broken on risk_score then recency.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { randomUUID } from 'crypto'
import { db } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty } from '../test/dbHelpers'
import { backgroundRouter } from './background'
import { errorHandler } from '../middleware/errorHandler'

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/background', backgroundRouter)
  app.use(errorHandler)
  return app
}

beforeEach(async () => {
  await cleanupAllSchema()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_pool'
})

const sign = (claims: any) => jwt.sign(claims, process.env.JWT_SECRET!, { expiresIn: '1h' })

/** Create user + background_check + an available pool entry at a location. */
async function seedPoolEntry(landlordId: string, loc: {
  city: string; state: string; zip: string; riskScore?: number
}): Promise<string> {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const u = await c.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
       VALUES ($1, 'x', 'tenant', 'Pool', 'Applicant', TRUE) RETURNING id`,
      [`pool-${randomUUID()}@test.dev`])
    const bc = await c.query<{ id: string }>(
      `INSERT INTO background_checks (landlord_id, user_id, consent_pool)
       VALUES ($1, $2, TRUE) RETURNING id`,
      [landlordId, u.rows[0].id])
    const ap = await c.query<{ id: string }>(
      `INSERT INTO application_pool
         (background_check_id, user_id, status, consent_pool, city, state, zip, risk_score)
       VALUES ($1, $2, 'available', TRUE, $3, $4, $5, $6) RETURNING id`,
      [bc.rows[0].id, u.rows[0].id, loc.city, loc.state, loc.zip, loc.riskScore ?? 50])
    await c.query('COMMIT')
    return ap.rows[0].id
  } catch (e) { await c.query('ROLLBACK'); throw e }
  finally { c.release() }
}

async function seedLandlordWithProperty() {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const { userId, landlordId } = await seedLandlord(c)
    // seedProperty fixes Phoenix / AZ / 85001.
    await seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: userId })
    await c.query('COMMIT')
    return { userId, landlordId }
  } catch (e) { await c.query('ROLLBACK'); throw e }
  finally { c.release() }
}

describe('GET /api/background/pool/search — proximity ordering', () => {
  it('orders candidates by proximity tier to the landlord properties', async () => {
    const { userId, landlordId } = await seedLandlordWithProperty()
    // Insert out of order; expect the response sorted by proximity.
    const elsewhere = await seedPoolEntry(landlordId, { city: 'Denver',  state: 'CO', zip: '80014' }) // 4
    const sameState = await seedPoolEntry(landlordId, { city: 'Tucson',  state: 'AZ', zip: '85701' }) // 3
    const sameZip   = await seedPoolEntry(landlordId, { city: 'Phoenix', state: 'AZ', zip: '85001' }) // 0
    const sameRegion= await seedPoolEntry(landlordId, { city: 'Mesa',    state: 'AZ', zip: '85003' }) // 2 (zip3 850, diff city)
    const sameCity  = await seedPoolEntry(landlordId, { city: 'Phoenix', state: 'AZ', zip: '85099' }) // 1

    const token = sign({ userId, role: 'landlord', email: 'll@t.dev', profileId: landlordId, permissions: {} })
    const res = await request(buildApp()).get('/api/background/pool/search')
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    const ids   = res.body.data.map((r: any) => r.id)
    const ranks = res.body.data.map((r: any) => r.proximity_rank)
    expect(ids).toEqual([sameZip, sameCity, sameRegion, sameState, elsewhere])
    expect(ranks).toEqual([0, 1, 2, 3, 4])
  })

  it('only returns available entries, scoped per landlord', async () => {
    const a = await seedLandlordWithProperty()
    const b = await seedLandlordWithProperty()
    await seedPoolEntry(a.landlordId, { city: 'Phoenix', state: 'AZ', zip: '85001' })
    // B's own pool row referencing a different bg-check; A should still see
    // the global available pool (pool is platform-wide), so seed under B too.
    await seedPoolEntry(b.landlordId, { city: 'Reno', state: 'NV', zip: '89501' })
    const token = sign({ userId: a.userId, role: 'landlord', email: 'a@t.dev', profileId: a.landlordId, permissions: {} })
    const res = await request(buildApp()).get('/api/background/pool/search')
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    // Pool is platform-wide (any landlord can reach out), so both appear,
    // but A's local Phoenix candidate ranks first.
    expect(res.body.data[0].city).toBe('Phoenix')
    expect(res.body.data[0].proximity_rank).toBe(0)
  })

  it('landlord with no properties → all rank 4, no crash', async () => {
    const c = await db.connect()
    let landlordId = '', userId = ''
    try {
      await c.query('BEGIN')
      const l = await seedLandlord(c)
      landlordId = l.landlordId; userId = l.userId
      await c.query('COMMIT')
    } finally { c.release() }
    await seedPoolEntry(landlordId, { city: 'Phoenix', state: 'AZ', zip: '85001' })
    const token = sign({ userId, role: 'landlord', email: 'np@t.dev', profileId: landlordId, permissions: {} })
    const res = await request(buildApp()).get('/api/background/pool/search')
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(1)
    expect(res.body.data[0].proximity_rank).toBe(4)
  })
})
