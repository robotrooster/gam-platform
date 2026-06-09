/**
 * admin.ts CSV review queue slice — S368 (admin.ts slice 2 of N).
 *
 * Closes the CSV onboarding subsystem end-to-end. Data side covered
 * in S359-S361 (landlords-csv-properties/tenants/payments);
 * moderation side covered here:
 *   - GET /admin/csv-import-attempts (list with filters)
 *   - GET /admin/csv-import-attempts/:id (detail + related-validate
 *     cross-link)
 *   - POST /admin/csv-import-attempts/:id/mark-reviewed
 *   - GET /admin/csv-import-attempts/_stats/platforms
 *   - GET /admin/platform-review-statuses (slot merge view)
 *   - POST .../verify (upsert mapping_status='verified')
 *   - POST .../notes (upsert notes only)
 *   - POST .../unverify (revert to unverified)
 *   - GET /admin/platform-claims/candidates (S297 promotion candidates)
 *   - POST /admin/platform-claims/:normalized/promote (super_admin)
 *
 * Out of slice (next admin.ts session): income projection / bulletin
 * moderation / OTP+FlexCharge retry / deposit-portability / connect-
 * readiness / onboarding detail / email failures / audit log viewer.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { randomUUID } from 'crypto'
import { db } from '../db'
import { cleanupAllSchema, seedLandlord } from '../test/dbHelpers'
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
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_admin_csv'
})

interface CRFixture {
  landlordUserId: string
  landlordId:     string
  adminUserId:    string
  superAdminUserId: string
  adminToken:     string
  superAdminToken: string
}

async function seedCRFixture(): Promise<CRFixture> {
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

async function seedAttempt(landlordId: string, opts: {
  status?: 'validated' | 'committed' | 'reviewed';
  platformKey?: string;
  importType?: 'tenant' | 'property' | 'payment';
  claimedName?: string | null;
} = {}): Promise<string> {
  const r = await db.query<{ id: string }>(
    `INSERT INTO csv_import_attempts
       (landlord_id, import_type, platform_key, claimed_platform_name,
        column_headers, sample_rows, row_count, blockers, warnings, status)
     VALUES ($1, $2, $3, $4, '["col1","col2"]'::jsonb, '[{}]'::jsonb, 5, 0, 0, $5)
     RETURNING id`,
    [landlordId, opts.importType ?? 'tenant',
     opts.platformKey ?? 'generic', opts.claimedName ?? null,
     opts.status ?? 'validated'])
  return r.rows[0].id
}

describe('GET /api/admin/csv-import-attempts — list with filters', () => {
  it('default status=pending: returns validated + committed; reviewed excluded', async () => {
    const f = await seedCRFixture()
    const a = await seedAttempt(f.landlordId, { status: 'validated' })
    const b = await seedAttempt(f.landlordId, { status: 'committed' })
    await seedAttempt(f.landlordId, { status: 'reviewed' })

    const res = await request(buildApp())
      .get('/api/admin/csv-import-attempts')
      .set('Authorization', `Bearer ${f.adminToken}`)
    expect(res.status).toBe(200)
    const ids = res.body.data.rows.map((r: any) => r.id).sort()
    expect(ids).toEqual([a, b].sort())
    expect(res.body.data.filters.status).toBe('pending')
  })

  it('platform + import_type filters narrow results', async () => {
    const f = await seedCRFixture()
    const targetId = await seedAttempt(f.landlordId, { platformKey: 'doorloop', importType: 'tenant' })
    await seedAttempt(f.landlordId, { platformKey: 'appfolio', importType: 'tenant' })
    await seedAttempt(f.landlordId, { platformKey: 'doorloop', importType: 'property' })

    const res = await request(buildApp())
      .get('/api/admin/csv-import-attempts?platform=doorloop&import_type=tenant')
      .set('Authorization', `Bearer ${f.adminToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data.rows.length).toBe(1)
    expect(res.body.data.rows[0].id).toBe(targetId)
  })
})

describe('GET /api/admin/csv-import-attempts/:id — detail', () => {
  it('happy path: full row with related_validate_attempt_id when status=committed', async () => {
    const f = await seedCRFixture()
    // Seed a validate row first, then a commit row from the same landlord +
    // platform + type — the route should cross-link them.
    const validate = await seedAttempt(f.landlordId, {
      status: 'validated', platformKey: 'doorloop', importType: 'tenant',
    })
    // Backdate validate so commit's created_at is strictly later.
    await db.query(
      `UPDATE csv_import_attempts SET created_at = NOW() - INTERVAL '1 minute' WHERE id=$1`,
      [validate])
    const commit = await seedAttempt(f.landlordId, {
      status: 'committed', platformKey: 'doorloop', importType: 'tenant',
    })

    const res = await request(buildApp())
      .get(`/api/admin/csv-import-attempts/${commit}`)
      .set('Authorization', `Bearer ${f.superAdminToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data.id).toBe(commit)
    expect(res.body.data.related_validate_attempt_id).toBe(validate)
  })

  it('not found → 404', async () => {
    const f = await seedCRFixture()
    const res = await request(buildApp())
      .get(`/api/admin/csv-import-attempts/${randomUUID()}`)
      .set('Authorization', `Bearer ${f.superAdminToken}`)
    expect(res.status).toBe(404)
  })
})

describe('POST /api/admin/csv-import-attempts/:id/mark-reviewed', () => {
  it('happy: flips to reviewed + stamps reviewer + writes admin_action_log', async () => {
    const f = await seedCRFixture()
    const id = await seedAttempt(f.landlordId, { status: 'committed' })
    const res = await request(buildApp())
      .post(`/api/admin/csv-import-attempts/${id}/mark-reviewed`)
      .set('Authorization', `Bearer ${f.superAdminToken}`)
      .send({})
    expect(res.status).toBe(200)
    expect(res.body.data.status).toBe('reviewed')
    expect(res.body.data.reviewed_by).toBe(f.superAdminUserId)

    const log = await db.query<{ action_type: string; target_id: string }>(
      `SELECT action_type, target_id FROM admin_action_log
        WHERE admin_user_id=$1 AND target_type='csv_import_attempt'`,
      [f.superAdminUserId])
    expect(log.rows.length).toBe(1)
    expect(log.rows[0].action_type).toBe('csv_import_attempt.mark_reviewed')
    expect(log.rows[0].target_id).toBe(id)
  })
})

describe('GET /api/admin/csv-import-attempts/_stats/platforms', () => {
  it('aggregates committed_count + reviewed_count per (platform, type)', async () => {
    const f = await seedCRFixture()
    await seedAttempt(f.landlordId, { status: 'committed', platformKey: 'doorloop', importType: 'tenant' })
    await seedAttempt(f.landlordId, { status: 'committed', platformKey: 'doorloop', importType: 'tenant' })
    await seedAttempt(f.landlordId, { status: 'reviewed',  platformKey: 'doorloop', importType: 'tenant' })
    // validated rows excluded
    await seedAttempt(f.landlordId, { status: 'validated', platformKey: 'doorloop', importType: 'tenant' })

    const res = await request(buildApp())
      .get('/api/admin/csv-import-attempts/_stats/platforms')
      .set('Authorization', `Bearer ${f.superAdminToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data.rows.length).toBe(1)
    const row = res.body.data.rows[0]
    expect(row.platform_key).toBe('doorloop')
    expect(row.import_type).toBe('tenant')
    expect(row.committed_count).toBe(3)  // 2 committed + 1 reviewed (both counted)
    expect(row.reviewed_count).toBe(1)
  })
})

describe('GET /api/admin/platform-review-statuses', () => {
  it('merged view: slots from review_status UNION stats; commit-count counted', async () => {
    const f = await seedCRFixture()
    // Seed a commit attempt — generates a stats row, NO platform_review_status row
    await seedAttempt(f.landlordId, { status: 'committed', platformKey: 'unverified_plat', importType: 'tenant' })
    // Seed a verified slot in review_status — generates a slot row, NO commits
    await db.query(
      `INSERT INTO platform_review_status (platform_key, import_type, mapping_status, verified_at, verified_by)
       VALUES ('verified_plat', 'property', 'verified', NOW(), $1)`,
      [f.superAdminUserId])

    const res = await request(buildApp())
      .get('/api/admin/platform-review-statuses')
      .set('Authorization', `Bearer ${f.adminToken}`)
    expect(res.status).toBe(200)
    const byKey = Object.fromEntries(res.body.data.rows.map((r: any) => [r.platform_key, r]))
    expect(byKey['unverified_plat'].mapping_status).toBe('unverified')
    expect(Number(byKey['unverified_plat'].committed_count)).toBe(1)
    expect(byKey['verified_plat'].mapping_status).toBe('verified')
    expect(byKey['verified_plat'].verified_by).toBe(f.superAdminUserId)
  })
})

describe('POST /api/admin/platform-review-statuses/:platform_key/:import_type/verify', () => {
  it('happy: upsert to verified + stamps verifier; admin_action_log row written', async () => {
    const f = await seedCRFixture()
    const res = await request(buildApp())
      .post('/api/admin/platform-review-statuses/doorloop/tenant/verify')
      .set('Authorization', `Bearer ${f.superAdminToken}`)
      .send({ notes: 'reviewed 6 imports, mapping looks clean' })
    expect(res.status).toBe(200)
    expect(res.body.data.mapping_status).toBe('verified')
    expect(res.body.data.verified_by).toBe(f.superAdminUserId)
    expect(res.body.data.notes).toBe('reviewed 6 imports, mapping looks clean')

    const log = await db.query<{ action_type: string }>(
      `SELECT action_type FROM admin_action_log WHERE target_type='platform_review_status' AND admin_user_id=$1`,
      [f.superAdminUserId])
    expect(log.rows.length).toBe(1)
    expect(log.rows[0].action_type).toBe('platform_review_status.verify')
  })

  it('invalid import_type → 400', async () => {
    const f = await seedCRFixture()
    const res = await request(buildApp())
      .post('/api/admin/platform-review-statuses/doorloop/lease/verify')
      .set('Authorization', `Bearer ${f.superAdminToken}`)
      .send({})
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/import_type must be tenant\/property\/payment/)
  })
})

describe('POST /api/admin/platform-review-statuses/:platform_key/:import_type/notes', () => {
  it('upserts notes WITHOUT disturbing verified_at (no status change)', async () => {
    const f = await seedCRFixture()
    // Pre-verify the slot
    await request(buildApp())
      .post('/api/admin/platform-review-statuses/doorloop/tenant/verify')
      .set('Authorization', `Bearer ${f.superAdminToken}`)
      .send({})
    const before = await db.query<{ verified_at: string; mapping_status: string }>(
      `SELECT verified_at, mapping_status FROM platform_review_status
        WHERE platform_key='doorloop' AND import_type='tenant'`)
    const verifiedAtBefore = new Date(before.rows[0].verified_at).getTime()

    // Update notes only
    const res = await request(buildApp())
      .post('/api/admin/platform-review-statuses/doorloop/tenant/notes')
      .set('Authorization', `Bearer ${f.superAdminToken}`)
      .send({ notes: 'updated context' })
    expect(res.status).toBe(200)
    expect(res.body.data.notes).toBe('updated context')
    expect(res.body.data.mapping_status).toBe('verified')  // unchanged
    // Compare instants, not string formats (pg ::text vs JSON ISO differ)
    expect(new Date(res.body.data.verified_at).getTime()).toBe(verifiedAtBefore)
  })
})

describe('GET /api/admin/platform-claims/candidates', () => {
  it('groups by normalized name; excludes already-promoted; counts distinct landlords', async () => {
    const f1 = await seedCRFixture()
    const f2 = await seedCRFixture()
    // Two landlords claim "RentManager" (different raw spellings)
    await seedAttempt(f1.landlordId, { claimedName: 'Rent Manager' })
    await seedAttempt(f2.landlordId, { claimedName: 'RentManager' })
    // One landlord claims "BuildiumPro" — but it's been promoted, so excluded
    await seedAttempt(f1.landlordId, { claimedName: 'BuildiumPro' })
    await db.query(
      `INSERT INTO platform_claim_promotions (normalized_name, promoted_by, example_raw_name)
       VALUES ('buildiumpro', $1, 'BuildiumPro')`, [f1.superAdminUserId])

    const res = await request(buildApp())
      .get('/api/admin/platform-claims/candidates')
      .set('Authorization', `Bearer ${f1.adminToken}`)
    expect(res.status).toBe(200)
    const names = res.body.data.rows.map((r: any) => r.normalized_name)
    expect(names).toContain('rentmanager')
    expect(names).not.toContain('buildiumpro')  // excluded — already promoted
    const rentMgr = res.body.data.rows.find((r: any) => r.normalized_name === 'rentmanager')
    expect(rentMgr.distinct_landlords).toBe(2)
    expect(rentMgr.total_mentions).toBe(2)
  })
})

describe('POST /api/admin/platform-claims/:normalized/promote — super_admin only', () => {
  it('happy: upserts promotion row + writes admin_action_log; example_raw_name set from most-common raw', async () => {
    const f = await seedCRFixture()
    await seedAttempt(f.landlordId, { claimedName: 'Rent Manager' })
    await seedAttempt(f.landlordId, { claimedName: 'Rent Manager' })
    await seedAttempt(f.landlordId, { claimedName: 'rentmanager' })

    const res = await request(buildApp())
      .post('/api/admin/platform-claims/rentmanager/promote')
      .set('Authorization', `Bearer ${f.superAdminToken}`)
      .send({ notes: 'adding to PLATFORMS this sprint' })
    expect(res.status).toBe(200)
    expect(res.body.data.normalized_name).toBe('rentmanager')
    expect(res.body.data.promoted_by).toBe(f.superAdminUserId)
    expect(res.body.data.example_raw_name).toBe('Rent Manager')  // 2 mentions vs 1 for 'rentmanager'

    const log = await db.query<{ action_type: string }>(
      `SELECT action_type FROM admin_action_log
        WHERE target_type='platform_claim' AND admin_user_id=$1`, [f.superAdminUserId])
    expect(log.rows.length).toBe(1)
    expect(log.rows[0].action_type).toBe('platform_claim.promote')
  })

  it('plain admin → 403 (super_admin only)', async () => {
    const f = await seedCRFixture()
    const res = await request(buildApp())
      .post('/api/admin/platform-claims/rentmanager/promote')
      .set('Authorization', `Bearer ${f.adminToken}`)
      .send({})
    expect(res.status).toBe(403)
  })
})
