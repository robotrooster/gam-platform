/**
 * admin.ts arc gap-closer — S373.
 *
 * Audit of S362+S368-S372 revealed 4 admin.ts routes uncovered.
 * Closing them before pivoting to the next file (tenants.ts).
 *
 * The 4 gaps:
 *   - GET /admin/property-flags — list endpoint (S362 covered the
 *     POST resolve but missed the GET list)
 *   - PATCH /admin/landlords/:id/otp-rollout — super_admin OTP
 *     rollout toggle (never tested)
 *   - POST /admin/platform-review-statuses/:platform_key/:import_type/unverify
 *     — S368 explicitly skipped as "same shape as verify"
 *   - GET /admin/platform-claims/promoted — S368 explicitly skipped
 *     as "straightforward SELECT"
 *
 * After S373: admin.ts route coverage = 42/42.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { randomUUID } from 'crypto'
import { db } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty } from '../test/dbHelpers'
import { adminRouter } from './admin'
import { errorHandler } from '../middleware/errorHandler'

function buildApp() {
  const app = express()
  app.use(express.json({ limit: '2mb' }))
  app.use('/api/admin', adminRouter)
  app.use(errorHandler)
  return app
}

beforeEach(async () => {
  await cleanupAllSchema()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_admin_gaps'
})

interface AFixture {
  landlordUserId: string
  landlordId:     string
  adminUserId:    string
  superAdminUserId: string
  adminToken:     string
  superAdminToken: string
}

async function seedAFixture(): Promise<AFixture> {
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    const { userId: landlordUserId, landlordId } = await seedLandlord(client)
    const adminRes = await client.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
       VALUES ($1, 'x', 'admin', 'A', 'D', TRUE) RETURNING id`,
      [`admin-${randomUUID()}@test.dev`])
    const superAdminRes = await client.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
       VALUES ($1, 'x', 'super_admin', 'S', 'U', TRUE) RETURNING id`,
      [`super-${randomUUID()}@test.dev`])
    await client.query('COMMIT')
    const sign = (id: string, role: string) => jwt.sign(
      { userId: id, role, email: 'x@test.dev', profileId: id, permissions: {} },
      process.env.JWT_SECRET!, { expiresIn: '1h' },
    )
    return {
      landlordUserId, landlordId,
      adminUserId:      adminRes.rows[0].id,
      superAdminUserId: superAdminRes.rows[0].id,
      adminToken:       sign(adminRes.rows[0].id, 'admin'),
      superAdminToken:  sign(superAdminRes.rows[0].id, 'super_admin'),
    }
  } catch (e) { await client.query('ROLLBACK'); throw e }
  finally { client.release() }
}

describe('GET /api/admin/property-flags', () => {
  async function seedFlag(f: AFixture, opts: { resolved?: boolean } = {}): Promise<string> {
    const client = await db.connect()
    try {
      await client.query('BEGIN')
      const propertyId = await seedProperty(client, {
        landlordId: f.landlordId, ownerUserId: f.landlordUserId,
        managedByUserId: f.landlordUserId,
      })
      const other = await seedLandlord(client)
      const otherPropertyId = await seedProperty(client, {
        landlordId: other.landlordId, ownerUserId: other.userId,
        managedByUserId: other.userId,
      })
      const flagRes = await client.query<{ id: string }>(
        `INSERT INTO property_duplicate_flags
           (property_id, conflicting_property_id, reason, normalized_key,
            resolved_at, resolved_by, resolution)
         VALUES ($1, $2, 'duplicate_address', 'k',
                 ${opts.resolved ? 'NOW()' : 'NULL'},
                 ${opts.resolved ? '$3' : 'NULL'},
                 ${opts.resolved ? "'approved_separate'" : 'NULL'})
         RETURNING id`,
        opts.resolved ? [propertyId, otherPropertyId, f.adminUserId] : [propertyId, otherPropertyId])
      await client.query('COMMIT')
      return flagRes.rows[0].id
    } catch (e) { await client.query('ROLLBACK'); throw e } finally { client.release() }
  }

  it('default status=pending: returns unresolved flags only', async () => {
    const f = await seedAFixture()
    const pendingId = await seedFlag(f, { resolved: false })
    await seedFlag(f, { resolved: true })

    const res = await request(buildApp())
      .get('/api/admin/property-flags')
      .set('Authorization', `Bearer ${f.adminToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data.length).toBe(1)
    expect(res.body.data[0].id).toBe(pendingId)
    expect(res.body.data[0].resolved_at).toBeNull()
    // Verify the multi-JOIN columns landed
    expect(res.body.data[0].new_landlord_email).toBeDefined()
    expect(res.body.data[0].orig_landlord_email).toBeDefined()
  })

  it('?status=resolved: returns resolved flags only', async () => {
    const f = await seedAFixture()
    await seedFlag(f, { resolved: false })
    const resolvedId = await seedFlag(f, { resolved: true })

    const res = await request(buildApp())
      .get('/api/admin/property-flags?status=resolved')
      .set('Authorization', `Bearer ${f.adminToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data.length).toBe(1)
    expect(res.body.data[0].id).toBe(resolvedId)
    expect(res.body.data[0].resolution).toBe('approved_separate')
  })
})

describe('PATCH /api/admin/landlords/:id/otp-rollout', () => {
  it('plain admin → 403 (super_admin only)', async () => {
    const f = await seedAFixture()
    const res = await request(buildApp())
      .patch(`/api/admin/landlords/${f.landlordId}/otp-rollout`)
      .set('Authorization', `Bearer ${f.adminToken}`)
      .send({ enabled: true })
    expect(res.status).toBe(403)
    // Flag unchanged
    const row = await db.query<{ otp_rollout_enabled: boolean }>(
      `SELECT otp_rollout_enabled FROM landlords WHERE id=$1`, [f.landlordId])
    expect(row.rows[0].otp_rollout_enabled).toBe(false)
  })

  it('super_admin happy: flips otp_rollout_enabled', async () => {
    const f = await seedAFixture()
    const res = await request(buildApp())
      .patch(`/api/admin/landlords/${f.landlordId}/otp-rollout`)
      .set('Authorization', `Bearer ${f.superAdminToken}`)
      .send({ enabled: true })
    expect(res.status).toBe(200)
    const row = await db.query<{ otp_rollout_enabled: boolean }>(
      `SELECT otp_rollout_enabled FROM landlords WHERE id=$1`, [f.landlordId])
    expect(row.rows[0].otp_rollout_enabled).toBe(true)
  })
})

describe('POST /api/admin/platform-review-statuses/:platform_key/:import_type/unverify', () => {
  it('reverts a previously-verified slot back to unverified + clears verified_at/verified_by', async () => {
    const f = await seedAFixture()
    // Pre-verify the slot
    await request(buildApp())
      .post('/api/admin/platform-review-statuses/doorloop/tenant/verify')
      .set('Authorization', `Bearer ${f.superAdminToken}`)
      .send({})
    const before = await db.query<{ mapping_status: string; verified_at: string | null }>(
      `SELECT mapping_status, verified_at FROM platform_review_status
        WHERE platform_key='doorloop' AND import_type='tenant'`)
    expect(before.rows[0].mapping_status).toBe('verified')
    expect(before.rows[0].verified_at).not.toBeNull()

    // Unverify
    const res = await request(buildApp())
      .post('/api/admin/platform-review-statuses/doorloop/tenant/unverify')
      .set('Authorization', `Bearer ${f.superAdminToken}`)
      .send({ notes: 'mapping changed, needs re-review' })
    expect(res.status).toBe(200)
    expect(res.body.data.mapping_status).toBe('unverified')
    expect(res.body.data.verified_at).toBeNull()
    expect(res.body.data.verified_by).toBeNull()
    expect(res.body.data.notes).toBe('mapping changed, needs re-review')

    // Audit log row written (S368 fix path — no targetId composite-key bug)
    const log = await db.query<{ action_type: string }>(
      `SELECT action_type FROM admin_action_log
        WHERE target_type='platform_review_status' AND admin_user_id=$1
          AND action_type='platform_review_status.unverify'`,
      [f.superAdminUserId])
    expect(log.rows.length).toBe(1)
  })
})

describe('GET /api/admin/platform-claims/promoted', () => {
  it('returns previously-promoted claim names with promoter info; ordered by promoted_at DESC', async () => {
    const f = await seedAFixture()
    // Seed two promotions at different times
    await db.query(
      `INSERT INTO platform_claim_promotions
         (normalized_name, promoted_by, example_raw_name, promoted_at, notes) VALUES
         ('rentmanager', $1, 'Rent Manager', NOW() - INTERVAL '1 day', 'older'),
         ('buildiumpro', $1, 'BuildiumPro',   NOW(),                    'newer')`,
      [f.superAdminUserId])

    const res = await request(buildApp())
      .get('/api/admin/platform-claims/promoted')
      .set('Authorization', `Bearer ${f.adminToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data.rows.length).toBe(2)
    // DESC order: buildiumpro (now) first, rentmanager (1d ago) second
    expect(res.body.data.rows[0].normalized_name).toBe('buildiumpro')
    expect(res.body.data.rows[1].normalized_name).toBe('rentmanager')
    // Promoter info joined from users
    expect(res.body.data.rows[0].promoter_first_name).toBe('S')
    expect(res.body.data.rows[0].example_raw_name).toBe('BuildiumPro')
  })
})
