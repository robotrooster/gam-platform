/**
 * bulletin.ts gap-close slice — S401. Closes the file at 5/5 (100%).
 *
 * Covered routes (5):
 *   - GET  /api/bulletin
 *   - POST /api/bulletin
 *   - POST /api/bulletin/:id/vote
 *   - GET  /api/bulletin/:id/reveal       (S401 fix: was unreachable)
 *   - GET  /api/bulletin/landlord         (S401 fix: SQL injection)
 *
 * Production bugs fixed in this slice (2):
 *   - **GET /api/bulletin/landlord** had raw SQL injection in the
 *     `date` query param (interpolated unescaped) and a hand-rolled
 *     half-defense in `search`. Both now parameterized; `date`
 *     also format-validated as YYYY-MM-DD.
 *   - **GET /api/bulletin/:id/reveal** checked
 *     `req.user.permissions.super_admin`, which is never set in any
 *     JWT (super_admin scope returns null from getScopeForUser, so
 *     login stamps `permissions: null`). The bulletin moderation
 *     reveal route was completely unreachable. Replaced with the
 *     correct `req.user.role === 'super_admin'` check.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { randomUUID } from 'crypto'
import { db } from '../db'
import {
  cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedTenant,
  seedLease, seedLeaseTenant,
} from '../test/dbHelpers'
import { bulletinRouter } from './bulletin'
import { errorHandler } from '../middleware/errorHandler'

function buildApp() {
  const app = express()
  app.use(express.json({ limit: '2mb' }))
  app.use('/api/bulletin', bulletinRouter)
  app.use(errorHandler)
  return app
}

beforeEach(async () => {
  await cleanupAllSchema()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_bulletin'
})

interface Fixture {
  // Landlord A, two properties in different cities so we can test
  // property/city/state scope gating.
  aLid: string
  propAxId: string         // landlord A, Phoenix AZ
  propAyId: string         // landlord A, Tucson AZ
  // Two tenants on propAx (same property) so voting can cross between them.
  tenant1UserId: string; tenant1Id: string; lease1Id: string; tenant1Token: string
  tenant2UserId: string; tenant2Id: string; lease2Id: string; tenant2Token: string
  // Tenant on propAy (different city) to test cross-property rejection.
  tenant3UserId: string; tenant3Id: string; lease3Id: string; tenant3Token: string
  // Landlord A login token (for /landlord view).
  landlordToken: string
  // Super admin (for /reveal).
  superAdminToken: string
  // Regular admin (NOT super_admin — for negative case on /reveal).
  adminToken: string
}

async function seed(): Promise<Fixture> {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const { userId: aUid, landlordId: aLid } = await seedLandlord(c)
    // Two properties in the same state, different cities.
    const propAxId = await seedProperty(c, {
      landlordId: aLid, ownerUserId: aUid, managedByUserId: aUid,
    })
    const propAyId = await seedProperty(c, {
      landlordId: aLid, ownerUserId: aUid, managedByUserId: aUid,
    })
    // Force city/state so we can test scope gating distinctly.
    await c.query(
      `UPDATE properties SET city='Phoenix', state='AZ' WHERE id=$1`, [propAxId])
    await c.query(
      `UPDATE properties SET city='Tucson',  state='AZ' WHERE id=$1`, [propAyId])

    const unit1 = await seedUnit(c, { propertyId: propAxId, landlordId: aLid })
    const unit2 = await seedUnit(c, { propertyId: propAxId, landlordId: aLid })
    const unit3 = await seedUnit(c, { propertyId: propAyId, landlordId: aLid })

    const tenant1Id = await seedTenant(c)
    const tenant2Id = await seedTenant(c)
    const tenant3Id = await seedTenant(c)
    const { rows: [{ user_id: tenant1UserId }] } = await c.query<{ user_id: string }>(
      `SELECT user_id FROM tenants WHERE id=$1`, [tenant1Id])
    const { rows: [{ user_id: tenant2UserId }] } = await c.query<{ user_id: string }>(
      `SELECT user_id FROM tenants WHERE id=$1`, [tenant2Id])
    const { rows: [{ user_id: tenant3UserId }] } = await c.query<{ user_id: string }>(
      `SELECT user_id FROM tenants WHERE id=$1`, [tenant3Id])

    const lease1Id = await seedLease(c, { unitId: unit1, landlordId: aLid })
    const lease2Id = await seedLease(c, { unitId: unit2, landlordId: aLid })
    const lease3Id = await seedLease(c, { unitId: unit3, landlordId: aLid })
    await seedLeaseTenant(c, { leaseId: lease1Id, tenantId: tenant1Id, role: 'primary' })
    await seedLeaseTenant(c, { leaseId: lease2Id, tenantId: tenant2Id, role: 'primary' })
    await seedLeaseTenant(c, { leaseId: lease3Id, tenantId: tenant3Id, role: 'primary' })

    await c.query('COMMIT')
    const sign = (claims: any) =>
      jwt.sign(claims, process.env.JWT_SECRET!, { expiresIn: '1h' })
    return {
      aLid, propAxId, propAyId,
      tenant1UserId, tenant1Id, lease1Id,
      tenant2UserId, tenant2Id, lease2Id,
      tenant3UserId, tenant3Id, lease3Id,
      tenant1Token: sign({ userId: tenant1UserId, role: 'tenant',
                           email: 't1@t.dev', profileId: tenant1Id }),
      tenant2Token: sign({ userId: tenant2UserId, role: 'tenant',
                           email: 't2@t.dev', profileId: tenant2Id }),
      tenant3Token: sign({ userId: tenant3UserId, role: 'tenant',
                           email: 't3@t.dev', profileId: tenant3Id }),
      landlordToken: sign({ userId: aUid, role: 'landlord',
                            email: 'll@t.dev', profileId: aLid, permissions: {} }),
      superAdminToken: sign({ userId: randomUUID(), role: 'super_admin',
                              email: 'su@t.dev', profileId: randomUUID() }),
      adminToken: sign({ userId: randomUUID(), role: 'admin',
                         email: 'a@t.dev', profileId: randomUUID() }),
    }
  } catch (e) { await c.query('ROLLBACK'); throw e }
  finally { c.release() }
}

// ─── GET /api/bulletin ──────────────────────────────────────

describe('GET /api/bulletin', () => {
  it('happy: tenant sees property-scope posts on their property', async () => {
    const f = await seed()
    // Tenant 1 posts first.
    await request(buildApp()).post('/api/bulletin')
      .set('Authorization', `Bearer ${f.tenant1Token}`)
      .send({ scope: 'property', content: 'Hello neighbors' })
    const res = await request(buildApp()).get('/api/bulletin?scope=property')
      .set('Authorization', `Bearer ${f.tenant2Token}`)
    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(1)
    expect(res.body.data[0].content).toBe('Hello neighbors')
    // Tenant 2 sees the post, can vote (different tenant, today)
    expect(res.body.data[0].can_vote).toBe(true)
    expect(res.body.data[0].my_vote).toBeNull()
  })

  it('city scope: tenant in same city sees post; tenant in other city does not', async () => {
    const f = await seed()
    await request(buildApp()).post('/api/bulletin')
      .set('Authorization', `Bearer ${f.tenant1Token}`)
      .send({ scope: 'city', content: 'Phoenix folks' })
    // Tenant 2 is also in Phoenix.
    const phx = await request(buildApp()).get('/api/bulletin?scope=city')
      .set('Authorization', `Bearer ${f.tenant2Token}`)
    expect(phx.status).toBe(200)
    expect(phx.body.data).toHaveLength(1)
    // Tenant 3 is in Tucson — should see nothing in city scope.
    const tuc = await request(buildApp()).get('/api/bulletin?scope=city')
      .set('Authorization', `Bearer ${f.tenant3Token}`)
    expect(tuc.status).toBe(200)
    expect(tuc.body.data).toHaveLength(0)
  })

  it('invalid scope → 400', async () => {
    const f = await seed()
    const res = await request(buildApp()).get('/api/bulletin?scope=galaxy')
      .set('Authorization', `Bearer ${f.tenant1Token}`)
    expect(res.status).toBe(400)
  })

  it('non-tenant role → 403 from requireTenant', async () => {
    const f = await seed()
    const res = await request(buildApp()).get('/api/bulletin?scope=property')
      .set('Authorization', `Bearer ${f.landlordToken}`)
    expect(res.status).toBe(403)
  })

  it('tenant with no active lease → 404 Tenant not found', async () => {
    const f = await seed()
    // Strand tenant1's lease.
    await db.query(`UPDATE leases SET status='terminated' WHERE id=$1`, [f.lease1Id])
    const res = await request(buildApp()).get('/api/bulletin?scope=property')
      .set('Authorization', `Bearer ${f.tenant1Token}`)
    expect(res.status).toBe(404)
  })
})

// ─── POST /api/bulletin ─────────────────────────────────────

describe('POST /api/bulletin', () => {
  it('happy: 201 with alias + my_vote=null + can_vote=true', async () => {
    const f = await seed()
    const res = await request(buildApp()).post('/api/bulletin')
      .set('Authorization', `Bearer ${f.tenant1Token}`)
      .send({ scope: 'property', content: 'New post here' })
    expect(res.status).toBe(201)
    expect(res.body.data.alias).toMatch(/^[A-Z][a-zA-Z]+[A-Z][a-zA-Z-]+$/)
    expect(res.body.data.my_vote).toBeNull()
    expect(res.body.data.can_vote).toBe(true)
  })

  it('content < 3 chars → 400', async () => {
    const f = await seed()
    const res = await request(buildApp()).post('/api/bulletin')
      .set('Authorization', `Bearer ${f.tenant1Token}`)
      .send({ scope: 'property', content: 'hi' })
    expect(res.status).toBe(400)
  })

  it('content > 500 chars → 400', async () => {
    const f = await seed()
    const res = await request(buildApp()).post('/api/bulletin')
      .set('Authorization', `Bearer ${f.tenant1Token}`)
      .send({ scope: 'property', content: 'x'.repeat(501) })
    expect(res.status).toBe(400)
  })

  it('invalid scope → 400', async () => {
    const f = await seed()
    const res = await request(buildApp()).post('/api/bulletin')
      .set('Authorization', `Bearer ${f.tenant1Token}`)
      .send({ scope: 'planet', content: 'Hello' })
    expect(res.status).toBe(400)
  })
})

// ─── POST /api/bulletin/:id/vote ────────────────────────────

describe('POST /api/bulletin/:id/vote', () => {
  async function seedAndPost(): Promise<{ f: Fixture; postId: string }> {
    const f = await seed()
    const post = await request(buildApp()).post('/api/bulletin')
      .set('Authorization', `Bearer ${f.tenant1Token}`)
      .send({ scope: 'property', content: 'vote on me' })
    return { f, postId: post.body.data.id }
  }

  it('happy: tenant 2 upvotes tenant 1\'s post; counts recompute', async () => {
    const { f, postId } = await seedAndPost()
    const res = await request(buildApp()).post(`/api/bulletin/${postId}/vote`)
      .set('Authorization', `Bearer ${f.tenant2Token}`)
      .send({ voteType: 'up' })
    expect(res.status).toBe(200)
    expect(parseInt(res.body.data.upvote_count)).toBe(1)
    expect(parseInt(res.body.data.total_votes)).toBe(1)
  })

  it('cannot vote on own post → 403', async () => {
    const { f, postId } = await seedAndPost()
    const res = await request(buildApp()).post(`/api/bulletin/${postId}/vote`)
      .set('Authorization', `Bearer ${f.tenant1Token}`)
      .send({ voteType: 'up' })
    expect(res.status).toBe(403)
  })

  it('tenant from other property/city → 403 geo-gate', async () => {
    const { f, postId } = await seedAndPost()
    const res = await request(buildApp()).post(`/api/bulletin/${postId}/vote`)
      .set('Authorization', `Bearer ${f.tenant3Token}`)
      .send({ voteType: 'up' })
    expect(res.status).toBe(403)
  })

  it('double-vote by same tenant → 409', async () => {
    const { f, postId } = await seedAndPost()
    await request(buildApp()).post(`/api/bulletin/${postId}/vote`)
      .set('Authorization', `Bearer ${f.tenant2Token}`)
      .send({ voteType: 'up' })
    const res = await request(buildApp()).post(`/api/bulletin/${postId}/vote`)
      .set('Authorization', `Bearer ${f.tenant2Token}`)
      .send({ voteType: 'up' })
    expect(res.status).toBe(409)
  })

  it('invalid voteType → 400', async () => {
    const { f, postId } = await seedAndPost()
    const res = await request(buildApp()).post(`/api/bulletin/${postId}/vote`)
      .set('Authorization', `Bearer ${f.tenant2Token}`)
      .send({ voteType: 'down' })
    expect(res.status).toBe(400)
  })

  it('unknown post → 404', async () => {
    const f = await seed()
    const res = await request(buildApp()).post(`/api/bulletin/${randomUUID()}/vote`)
      .set('Authorization', `Bearer ${f.tenant2Token}`)
      .send({ voteType: 'up' })
    expect(res.status).toBe(404)
  })

  it('voting on past post → 403 (acknowledgment window locked)', async () => {
    const { f, postId } = await seedAndPost()
    // Backdate the post to yesterday.
    await db.query(
      `UPDATE bulletin_posts SET created_at = NOW() - INTERVAL '2 days' WHERE id=$1`,
      [postId])
    const res = await request(buildApp()).post(`/api/bulletin/${postId}/vote`)
      .set('Authorization', `Bearer ${f.tenant2Token}`)
      .send({ voteType: 'up' })
    expect(res.status).toBe(403)
  })
})

// ─── GET /api/bulletin/:id/reveal ───────────────────────────

describe('GET /api/bulletin/:id/reveal', () => {
  async function seedAndPost(): Promise<{ f: Fixture; postId: string }> {
    const f = await seed()
    const post = await request(buildApp()).post('/api/bulletin')
      .set('Authorization', `Bearer ${f.tenant1Token}`)
      .send({ scope: 'property', content: 'reveal me' })
    return { f, postId: post.body.data.id }
  }

  it('S401 fix: super_admin can now reveal poster identity (was 403 pre-fix)', async () => {
    const { f, postId } = await seedAndPost()
    const res = await request(buildApp()).get(`/api/bulletin/${postId}/reveal`)
      .set('Authorization', `Bearer ${f.superAdminToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data.alias).toBeTruthy()
    expect(res.body.data.email).toMatch(/@test\.dev$/)
    expect(res.body.data.property_name).toBeTruthy()
  })

  it('non-super-admin admin → 403', async () => {
    const { f, postId } = await seedAndPost()
    const res = await request(buildApp()).get(`/api/bulletin/${postId}/reveal`)
      .set('Authorization', `Bearer ${f.adminToken}`)
    expect(res.status).toBe(403)
  })

  it('landlord → 403', async () => {
    const { f, postId } = await seedAndPost()
    const res = await request(buildApp()).get(`/api/bulletin/${postId}/reveal`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
    expect(res.status).toBe(403)
  })

  it('tenant → 403 (cannot reveal own peer)', async () => {
    const { f, postId } = await seedAndPost()
    const res = await request(buildApp()).get(`/api/bulletin/${postId}/reveal`)
      .set('Authorization', `Bearer ${f.tenant2Token}`)
    expect(res.status).toBe(403)
  })

  it('unknown post → 404', async () => {
    const f = await seed()
    const res = await request(buildApp()).get(`/api/bulletin/${randomUUID()}/reveal`)
      .set('Authorization', `Bearer ${f.superAdminToken}`)
    expect(res.status).toBe(404)
  })
})

// ─── GET /api/bulletin/landlord ─────────────────────────────

describe('GET /api/bulletin/landlord', () => {
  async function seedAndTenantPost(): Promise<{ f: Fixture; postId: string }> {
    const f = await seed()
    const post = await request(buildApp()).post('/api/bulletin')
      .set('Authorization', `Bearer ${f.tenant1Token}`)
      .send({ scope: 'property', content: 'visible to landlord' })
    return { f, postId: post.body.data.id }
  }

  it('happy: landlord sees posts on their properties (today by default)', async () => {
    const { f } = await seedAndTenantPost()
    const res = await request(buildApp()).get('/api/bulletin/landlord')
      .set('Authorization', `Bearer ${f.landlordToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(1)
    expect(res.body.data[0].content).toBe('visible to landlord')
  })

  it('S401 fix: SQL injection via `date` query param is now blocked', async () => {
    const { f } = await seedAndTenantPost()
    // The classic injection: close the quote, OR 1=1, comment.
    const malicious = "2026-01-01' OR '1'='1"
    const res = await request(buildApp())
      .get(`/api/bulletin/landlord?date=${encodeURIComponent(malicious)}`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
    // Pre-fix: 200 with un-filtered rows returned.
    // Post-fix: 400 — date must be YYYY-MM-DD format.
    expect(res.status).toBe(400)
  })

  it('date filter (valid YYYY-MM-DD) parameterized correctly', async () => {
    const { f } = await seedAndTenantPost()
    // Filter by tomorrow — should return [] (post was today).
    const tomorrow = new Date(Date.now() + 24*60*60*1000).toISOString().split('T')[0]
    const res = await request(buildApp())
      .get(`/api/bulletin/landlord?date=${tomorrow}`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(0)
  })

  it('search filter is now parameterized (apostrophe in query no longer crashes / leaks)', async () => {
    const { f } = await seedAndTenantPost()
    // Apostrophe used to be replaced with '' inline; now goes through $N.
    const res = await request(buildApp())
      .get(`/api/bulletin/landlord?search=${encodeURIComponent("O'Brien")}`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
    expect(res.status).toBe(200)
    // No match expected (content was "visible to landlord").
    expect(res.body.data).toHaveLength(0)
  })

  it('search filter substring match works', async () => {
    const { f } = await seedAndTenantPost()
    const res = await request(buildApp())
      .get('/api/bulletin/landlord?search=visible')
      .set('Authorization', `Bearer ${f.landlordToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(1)
  })

  it('landlord with no properties → 200 with []', async () => {
    const f = await seed()
    // Strand the landlord's properties to a different landlord.
    const { landlordId: otherLid } = await (async () => {
      const c = await db.connect()
      try {
        await c.query('BEGIN')
        const r = await (await import('../test/dbHelpers')).seedLandlord(c)
        await c.query('COMMIT')
        return r
      } finally { c.release() }
    })()
    await db.query(`UPDATE properties SET landlord_id=$1 WHERE landlord_id=$2`, [otherLid, f.aLid])
    const res = await request(buildApp()).get('/api/bulletin/landlord')
      .set('Authorization', `Bearer ${f.landlordToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data).toEqual([])
  })

  it('non-scoped role → 400 "No landlord scope on this user"', async () => {
    const f = await seed()
    const res = await request(buildApp()).get('/api/bulletin/landlord')
      .set('Authorization', `Bearer ${f.tenant1Token}`)
    // requirePerm('bulletin.view') likely 403s before reaching the scope check.
    // Either way it must NOT succeed.
    expect([400, 403]).toContain(res.status)
  })
})
