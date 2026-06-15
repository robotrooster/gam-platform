/**
 * S502 — requireBusinessAccess coverage.
 *
 * Verifies the four matrix-axes:
 *   1. Owner — always passes when business exists; feature gate still applies
 *   2. Staff — must be member of THIS business + active + permission granted
 *   3. Feature gate — surfaces "X is not enabled" 403 whether owner or staff
 *   4. ownerOnly flag — staff blocked even when they have the permission
 *
 * Tests run against a small Express harness with two mock endpoints, so
 * the assertions also exercise the full HTTP error path.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { randomUUID } from 'crypto'
import { db } from '../db'
import { cleanupAllSchema } from '../test/dbHelpers'
import { requireAuth } from './auth'
import { requireBusinessAccess } from './businessAccess'
import { errorHandler } from './errorHandler'

function buildApp() {
  const app = express()
  app.use(express.json())

  // Test endpoint #1 — requires invoices.read + invoicing feature
  app.get('/test/read', requireAuth, async (req: any, res, next) => {
    try {
      const a = await requireBusinessAccess(req, {
        permission: 'invoices.read', feature: 'invoicing',
      })
      res.json({ success: true, data: a })
    } catch (e) { next(e) }
  })

  // Test endpoint #2 — owner-only (settings-like)
  app.get('/test/owner', requireAuth, async (req: any, res, next) => {
    try {
      const a = await requireBusinessAccess(req, { ownerOnly: true })
      res.json({ success: true, data: a })
    } catch (e) { next(e) }
  })

  // Test endpoint #3 — no constraint (just resolve businessId)
  app.get('/test/any', requireAuth, async (req: any, res, next) => {
    try {
      const a = await requireBusinessAccess(req)
      res.json({ success: true, data: a })
    } catch (e) { next(e) }
  })

  app.use(errorHandler)
  return app
}

beforeEach(async () => {
  await cleanupAllSchema()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_s502'
})

interface Owner {
  userId: string; token: string; businessId: string; email: string;
}
async function seedOwner(opts: { features?: string[] } = {}): Promise<Owner> {
  const hash = await bcrypt.hash('super-strong-password-12!', 12)
  const email = `o-${randomUUID()}@test.dev`
  const { rows: [u] } = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
     VALUES ($1, $2, 'business_owner', 'B', 'O', TRUE) RETURNING id`,
    [email, hash])
  const features = opts.features ?? ['customers', 'staff', 'invoicing']
  const { rows: [b] } = await db.query<{ id: string }>(
    `INSERT INTO businesses (owner_user_id, name, business_type, email, enabled_features)
     VALUES ($1, 'Test Co', 'other', $2, $3) RETURNING id`,
    [u.id, email, features])
  const token = jwt.sign(
    { userId: u.id, role: 'business_owner', email, profileId: b.id, businessId: b.id },
    process.env.JWT_SECRET!, { expiresIn: '1h' })
  return { userId: u.id, token, businessId: b.id, email }
}

interface Staff {
  userId: string; token: string;
}
async function seedStaff(owner: Owner, opts: {
  permissions?: string[]
  status?: string
  businessIdOverride?: string  // for cross-business JWT test
  staffRole?: string
} = {}): Promise<Staff> {
  const hash = await bcrypt.hash('super-strong-password-12!', 12)
  const email = `s-${randomUUID()}@test.dev`
  const { rows: [u] } = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
     VALUES ($1, $2, 'business_staff', 'St', 'aff', TRUE) RETURNING id`,
    [email, hash])
  await db.query(
    `INSERT INTO business_users (business_id, user_id, staff_role, permissions, status)
     VALUES ($1, $2, $3, $4, $5)`,
    [owner.businessId, u.id, opts.staffRole ?? 'office',
     JSON.stringify(opts.permissions ?? []),
     opts.status ?? 'active'])
  const tokenBizId = opts.businessIdOverride ?? owner.businessId
  const token = jwt.sign(
    { userId: u.id, role: 'business_staff', email,
      profileId: tokenBizId, businessId: tokenBizId },
    process.env.JWT_SECRET!, { expiresIn: '1h' })
  return { userId: u.id, token }
}

// ═══════════════════════════════════════════════════════════════
//  Owner path
// ═══════════════════════════════════════════════════════════════

describe('Owner path', () => {
  it('owner gets through when business + feature both present', async () => {
    const o = await seedOwner()
    const res = await request(buildApp())
      .get('/test/read')
      .set('Authorization', `Bearer ${o.token}`)
    expect(res.status).toBe(200)
    expect(res.body.data.role).toBe('business_owner')
    expect(res.body.data.businessId).toBe(o.businessId)
  })

  it('owner blocked when feature disabled', async () => {
    const o = await seedOwner({ features: ['customers', 'staff'] })
    const res = await request(buildApp())
      .get('/test/read')
      .set('Authorization', `Bearer ${o.token}`)
    expect(res.status).toBe(403)
    expect(res.body.error).toMatch(/Invoicing is not enabled/i)
  })

  it('owner passes ownerOnly check', async () => {
    const o = await seedOwner()
    const res = await request(buildApp())
      .get('/test/owner')
      .set('Authorization', `Bearer ${o.token}`)
    expect(res.status).toBe(200)
  })
})

// ═══════════════════════════════════════════════════════════════
//  Staff path
// ═══════════════════════════════════════════════════════════════

describe('Staff path — basic membership + permission', () => {
  it('staff with permission gets through', async () => {
    const o = await seedOwner()
    const s = await seedStaff(o, { permissions: ['invoices.read'] })
    const res = await request(buildApp())
      .get('/test/read')
      .set('Authorization', `Bearer ${s.token}`)
    expect(res.status).toBe(200)
    expect(res.body.data.role).toBe('business_staff')
    expect(res.body.data.permissions).toContain('invoices.read')
  })

  it('staff WITHOUT permission → 403', async () => {
    const o = await seedOwner()
    const s = await seedStaff(o, { permissions: ['customers.read'] })  // no invoices.read
    const res = await request(buildApp())
      .get('/test/read')
      .set('Authorization', `Bearer ${s.token}`)
    expect(res.status).toBe(403)
    expect(res.body.error).toMatch(/Missing permission: invoices\.read/i)
  })

  it('revoked staff → 403', async () => {
    const o = await seedOwner()
    const s = await seedStaff(o, { permissions: ['invoices.read'], status: 'revoked' })
    const res = await request(buildApp())
      .get('/test/read')
      .set('Authorization', `Bearer ${s.token}`)
    expect(res.status).toBe(403)
    expect(res.body.error).toMatch(/not active/i)
  })

  it('invited (not yet accepted) staff → 403', async () => {
    const o = await seedOwner()
    const s = await seedStaff(o, { permissions: ['invoices.read'], status: 'invited' })
    const res = await request(buildApp())
      .get('/test/read')
      .set('Authorization', `Bearer ${s.token}`)
    expect(res.status).toBe(403)
  })

  it('staff with feature disabled on business → 403 even with permission', async () => {
    const o = await seedOwner({ features: ['customers', 'staff'] })  // no invoicing
    const s = await seedStaff(o, { permissions: ['invoices.read'] })
    const res = await request(buildApp())
      .get('/test/read')
      .set('Authorization', `Bearer ${s.token}`)
    expect(res.status).toBe(403)
    expect(res.body.error).toMatch(/not enabled/i)
  })

  it('staff blocked from ownerOnly endpoint even with permissions', async () => {
    const o = await seedOwner()
    const s = await seedStaff(o, { permissions: ['invoices.read'] })
    const res = await request(buildApp())
      .get('/test/owner')
      .set('Authorization', `Bearer ${s.token}`)
    expect(res.status).toBe(403)
    expect(res.body.error).toMatch(/Owner-only/i)
  })

  it('staff JWT referencing a different business → 403', async () => {
    const a = await seedOwner()
    const b = await seedOwner()  // separate business, separate owner
    // Staff member in business A, but JWT lies and claims business B
    const s = await seedStaff(a, {
      permissions: ['invoices.read'],
      businessIdOverride: b.businessId,
    })
    const res = await request(buildApp())
      .get('/test/read')
      .set('Authorization', `Bearer ${s.token}`)
    expect(res.status).toBe(403)
    expect(res.body.error).toMatch(/Not a member of this business/i)
  })

  it('legacy permissions shape `{}` is treated as empty (no permissions)', async () => {
    const o = await seedOwner()
    const hash = await bcrypt.hash('pw', 12)
    const email = `s-${randomUUID()}@test.dev`
    const { rows: [u] } = await db.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
       VALUES ($1, $2, 'business_staff', 'X', 'Y', TRUE) RETURNING id`,
      [email, hash])
    // Insert with legacy {} jsonb (not an array)
    await db.query(
      `INSERT INTO business_users (business_id, user_id, staff_role, permissions, status)
       VALUES ($1, $2, 'office', '{}'::jsonb, 'active')`,
      [o.businessId, u.id])
    const token = jwt.sign(
      { userId: u.id, role: 'business_staff', email,
        profileId: o.businessId, businessId: o.businessId },
      process.env.JWT_SECRET!, { expiresIn: '1h' })
    const res = await request(buildApp())
      .get('/test/read')
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(403)
    expect(res.body.error).toMatch(/Missing permission/i)
  })
})

// ═══════════════════════════════════════════════════════════════
//  Permission catalog respected
// ═══════════════════════════════════════════════════════════════

describe('Permission catalog', () => {
  it('unknown permission keys in row are silently filtered out', async () => {
    const o = await seedOwner()
    const s = await seedStaff(o, { permissions: ['invoices.read', 'made.up.key'] })
    const res = await request(buildApp())
      .get('/test/read')
      .set('Authorization', `Bearer ${s.token}`)
    expect(res.status).toBe(200)
    // 'made.up.key' should be filtered out
    expect(res.body.data.permissions).not.toContain('made.up.key')
    expect(res.body.data.permissions).toContain('invoices.read')
  })
})
