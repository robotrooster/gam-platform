/**
 * admin.ts overview slice — S362 part 1 of N.
 *
 * First slice of the admin.ts arc (1514 lines, NO TESTS — biggest
 * unwalked file at session start). Covered surfaces:
 *   - File-wide admin/super_admin gating (rejects landlord/tenant)
 *   - GET /overview + /onboarding/overview rollups (F1-class probe
 *     targets per the S355 + S358 SQL-drift pattern)
 *   - GET /tenants admin list
 *   - POST /property-flags/:id/resolve (audit log + status flip)
 *   - GET /system-features (admin readable) + PATCH (super_admin only)
 *   - GET /notifications + POST /:id/acknowledge (idempotency)
 *
 * Out of scope (future slices):
 *   - Bulletin moderation (5 routes, super_admin)
 *   - NACHA monitoring
 *   - Onboarding landlord/tenant detail views
 *   - Income projection
 *   - Audit log viewer + invoices backfill
 *   - Email failures, deposit-portability, connect-readiness,
 *     OTP/FlexCharge retry helpers
 *   - CSV-import-attempts review queue (5 routes)
 *   - Platform claim aggregation surface (4 routes)
 */

import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { randomUUID } from 'crypto'
import { db } from '../db'
import {
  cleanupAllSchema, seedLandlord, seedProperty,
} from '../test/dbHelpers'
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
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_admin'
})

interface AFixture {
  adminUserId:      string
  superAdminUserId: string
  landlordUserId:   string
  landlordId:       string
  adminToken:       string
  superAdminToken:  string
  landlordToken:   string
}

async function seedAFixture(): Promise<AFixture> {
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    const { userId: landlordUserId, landlordId } = await seedLandlord(client)
    const adminRes = await client.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
       VALUES ($1, 'x', 'admin', 'Test', 'Admin', TRUE) RETURNING id`,
      [`admin-${randomUUID()}@test.dev`])
    const superAdminRes = await client.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
       VALUES ($1, 'x', 'super_admin', 'Test', 'SuperAdmin', TRUE) RETURNING id`,
      [`super-${randomUUID()}@test.dev`])
    await client.query('COMMIT')
    const sign = (u: { id: string }, role: string) => jwt.sign(
      { userId: u.id, role, email: 'x@test.dev', profileId: u.id, permissions: {} },
      process.env.JWT_SECRET!, { expiresIn: '1h' },
    )
    return {
      adminUserId:      adminRes.rows[0].id,
      superAdminUserId: superAdminRes.rows[0].id,
      landlordUserId,
      landlordId,
      adminToken:       sign(adminRes.rows[0], 'admin'),
      superAdminToken:  sign(superAdminRes.rows[0], 'super_admin'),
      landlordToken:    jwt.sign(
        { userId: landlordUserId, role: 'landlord', email: 'll@test.dev',
          profileId: landlordId, permissions: {} },
        process.env.JWT_SECRET!, { expiresIn: '1h' },
      ),
    }
  } catch (e) { await client.query('ROLLBACK'); throw e }
  finally { client.release() }
}

describe('file-wide admin gating', () => {
  it('landlord token → 403 on /overview (admin/super_admin only)', async () => {
    const f = await seedAFixture()
    const res = await request(buildApp())
      .get('/api/admin/overview')
      .set('Authorization', `Bearer ${f.landlordToken}`)
    expect(res.status).toBe(403)
    expect(res.body.error).toMatch(/Insufficient permissions/)
  })
})

describe('GET /api/admin/overview', () => {
  it('happy path: returns rollup shape with all counter fields', async () => {
    const f = await seedAFixture()
    const res = await request(buildApp())
      .get('/api/admin/overview')
      .set('Authorization', `Bearer ${f.adminToken}`)
    expect(res.status).toBe(200)
    // Shape pin — every field present, all numeric
    const d = res.body.data
    expect(typeof d.total_landlords).toBe('number')
    expect(typeof d.total_tenants).toBe('number')
    expect(typeof d.active_units).toBe('number')
    expect(typeof d.vacant_units).toBe('number')
    expect(typeof d.eviction_mode_units).toBe('number')
    expect(typeof d.pending_payments).toBe('number')
    expect(typeof d.pending_disbursements).toBe('number')
    expect(typeof d.open_maintenance).toBe('number')
    expect(typeof d.zero_tolerance_events).toBe('number')
    expect(typeof d.csv_imports_pending_review).toBe('number')
    // Fixture has 1 landlord
    expect(d.total_landlords).toBe(1)
  })
})

describe('GET /api/admin/onboarding/overview', () => {
  it('returns onboarding stats shape', async () => {
    const f = await seedAFixture()
    const res = await request(buildApp())
      .get('/api/admin/onboarding/overview')
      .set('Authorization', `Bearer ${f.adminToken}`)
    expect(res.status).toBe(200)
    const d = res.body.data
    expect(typeof d.landlords_incomplete).toBe('number')
    expect(typeof d.landlords_no_bank).toBe('number')
    expect(typeof d.tenants_no_ach).toBe('number')
    expect(typeof d.vacant_units).toBe('number')
    // Fixture: 1 landlord, no bank account → landlords_no_bank = 1
    expect(d.landlords_no_bank).toBe(1)
  })
})

describe('GET /api/admin/tenants', () => {
  it('empty fixture → []', async () => {
    const f = await seedAFixture()
    const res = await request(buildApp())
      .get('/api/admin/tenants')
      .set('Authorization', `Bearer ${f.adminToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data).toEqual([])
  })
})

describe('POST /api/admin/property-flags/:id/resolve', () => {
  it('happy path: status flips, audit log row written', async () => {
    const f = await seedAFixture()
    const client = await db.connect()
    let flagId = ''
    let propertyId = ''
    try {
      await client.query('BEGIN')
      propertyId = await seedProperty(client, {
        landlordId: f.landlordId, ownerUserId: f.landlordUserId,
        managedByUserId: f.landlordUserId,
      })
      const other = await seedLandlord(client)
      const otherPropertyId = await seedProperty(client, {
        landlordId: other.landlordId, ownerUserId: other.userId,
        managedByUserId: other.userId,
      })
      await client.query(
        `UPDATE properties SET review_status='pending_review' WHERE id=$1`, [propertyId])
      const flagRes = await client.query<{ id: string }>(
        `INSERT INTO property_duplicate_flags (property_id, conflicting_property_id, reason, normalized_key)
         VALUES ($1, $2, 'duplicate_address', 'k') RETURNING id`,
        [propertyId, otherPropertyId])
      flagId = flagRes.rows[0].id
      await client.query('COMMIT')
    } catch (e) { await client.query('ROLLBACK'); throw e } finally { client.release() }

    const res = await request(buildApp())
      .post(`/api/admin/property-flags/${flagId}/resolve`)
      .set('Authorization', `Bearer ${f.adminToken}`)
      .send({ resolution: 'approved_separate', notes: 'distinct buildings' })
    expect(res.status).toBe(200)

    const flag = await db.query<{ resolution: string; resolved_by: string }>(
      `SELECT resolution, resolved_by FROM property_duplicate_flags WHERE id=$1`, [flagId])
    expect(flag.rows[0].resolution).toBe('approved_separate')
    expect(flag.rows[0].resolved_by).toBe(f.adminUserId)

    const prop = await db.query<{ review_status: string }>(
      `SELECT review_status FROM properties WHERE id=$1`, [propertyId])
    expect(prop.rows[0].review_status).toBe('active')

    const log = await db.query<{ action_type: string; target_id: string }>(
      `SELECT action_type, target_id FROM admin_action_log
        WHERE admin_user_id=$1 AND target_type='property'`,
      [f.adminUserId])
    expect(log.rows.length).toBe(1)
    expect(log.rows[0].action_type).toBe('property_flag_approved_separate')
    expect(log.rows[0].target_id).toBe(propertyId)
  })

  it('invalid resolution string → 400', async () => {
    const f = await seedAFixture()
    const res = await request(buildApp())
      .post(`/api/admin/property-flags/${randomUUID()}/resolve`)
      .set('Authorization', `Bearer ${f.adminToken}`)
      .send({ resolution: 'i_am_the_law' })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/Invalid resolution/)
  })

  it('already-resolved (or non-existent) flag → 404', async () => {
    const f = await seedAFixture()
    const res = await request(buildApp())
      .post(`/api/admin/property-flags/${randomUUID()}/resolve`)
      .set('Authorization', `Bearer ${f.adminToken}`)
      .send({ resolution: 'approved_separate' })
    expect(res.status).toBe(404)
  })
})

describe('GET /api/admin/system-features + PATCH (super_admin)', () => {
  it('GET returns rows; admin role allowed', async () => {
    const f = await seedAFixture()
    await db.query(
      `INSERT INTO system_features (key, enabled, description)
       VALUES ('test_feature', FALSE, 'Test feature flag')`)
    const res = await request(buildApp())
      .get('/api/admin/system-features')
      .set('Authorization', `Bearer ${f.adminToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data.length).toBe(1)
    expect(res.body.data[0].key).toBe('test_feature')
    expect(res.body.data[0].enabled).toBe(false)
  })

  it('PATCH as super_admin flips enabled flag', async () => {
    const f = await seedAFixture()
    await db.query(
      `INSERT INTO system_features (key, enabled, description)
       VALUES ('toggle_test', FALSE, 'Toggle me')`)
    const res = await request(buildApp())
      .patch('/api/admin/system-features/toggle_test')
      .set('Authorization', `Bearer ${f.superAdminToken}`)
      .send({ enabled: true })
    expect(res.status).toBe(200)
    const row = await db.query<{ enabled: boolean; updated_by_user_id: string }>(
      `SELECT enabled, updated_by_user_id FROM system_features WHERE key='toggle_test'`)
    expect(row.rows[0].enabled).toBe(true)
    expect(row.rows[0].updated_by_user_id).toBe(f.superAdminUserId)
  })

  it('PATCH as plain admin → 403 (super_admin only)', async () => {
    const f = await seedAFixture()
    await db.query(
      `INSERT INTO system_features (key, enabled, description)
       VALUES ('locked_feature', FALSE, 'desc')`)
    const res = await request(buildApp())
      .patch('/api/admin/system-features/locked_feature')
      .set('Authorization', `Bearer ${f.adminToken}`)
      .send({ enabled: true })
    expect(res.status).toBe(403)
    // Flag unchanged
    const row = await db.query<{ enabled: boolean }>(
      `SELECT enabled FROM system_features WHERE key='locked_feature'`)
    expect(row.rows[0].enabled).toBe(false)
  })
})

describe('GET /api/admin/notifications + POST /:id/acknowledge', () => {
  it('GET returns unacked rows by default + count rollup', async () => {
    const f = await seedAFixture()
    await db.query(
      `INSERT INTO admin_notifications (severity, category, title, body)
       VALUES ('critical', 'test', 'thing broke', 'details')`)
    await db.query(
      `INSERT INTO admin_notifications (severity, category, title, body, acknowledged_at, acknowledged_by)
       VALUES ('info', 'test', 'old', 'old', NOW(), $1)`,
      [f.adminUserId])

    const res = await request(buildApp())
      .get('/api/admin/notifications')
      .set('Authorization', `Bearer ${f.adminToken}`)
    expect(res.status).toBe(200)
    // Only unacked row returned by default
    expect(res.body.data.rows.length).toBe(1)
    expect(res.body.data.rows[0].title).toBe('thing broke')
    expect(Number(res.body.data.counts.unacked)).toBe(1)
    expect(Number(res.body.data.counts.unacked_critical)).toBe(1)
  })

  it('POST acknowledge stamps acked_at + idempotent (second call → 404)', async () => {
    const f = await seedAFixture()
    const n = await db.query<{ id: string }>(
      `INSERT INTO admin_notifications (severity, category, title, body)
       VALUES ('warn', 'test', 'ack me', 'details') RETURNING id`)
    const r1 = await request(buildApp())
      .post(`/api/admin/notifications/${n.rows[0].id}/acknowledge`)
      .set('Authorization', `Bearer ${f.adminToken}`).send({})
    expect(r1.status).toBe(200)
    expect(r1.body.data.acknowledged_by).toBe(f.adminUserId)
    expect(r1.body.data.acknowledged_at).not.toBeNull()

    const r2 = await request(buildApp())
      .post(`/api/admin/notifications/${n.rows[0].id}/acknowledge`)
      .set('Authorization', `Bearer ${f.adminToken}`).send({})
    expect(r2.status).toBe(404)
    expect(r2.body.error).toMatch(/already acknowledged/)
  })
})
