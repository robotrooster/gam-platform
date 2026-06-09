/**
 * admin.ts bulletin + income + onboarding-detail slice — S369
 * (admin.ts slice 3 of N).
 *
 * Coverage focus:
 *   - Bulletin moderation (super_admin): list / reveal / pin /
 *     remove. Reveal writes bulletin_reveal_log directly; pin +
 *     remove write through logAdminAction (with proper uuid
 *     targetIds — different shape from S368's F1).
 *   - Income projection: financial rollup with seeded
 *     active-unit + flex tenants — pin the math without testing
 *     every fee constant.
 *   - Onboarding landlord detail: checklist derivation
 *     (bank/property/unit/tenant/onboarding flags).
 *
 * Out of slice (next admin.ts session): NACHA monitoring, audit
 * log viewer, invoices backfill, email failures, OTP+FlexCharge
 * retry, deposit-portability, connect-readiness, onboarding
 * tenant detail (parallel to landlord detail but separate test).
 */

import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { randomUUID } from 'crypto'
import { db } from '../db'
import {
  cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedTenant,
  seedUserBankAccount,
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
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_admin_bul'
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

async function seedBulletinPost(opts: {
  tenantId: string;
  propertyId?: string | null;
  alias?: string;
  content?: string;
  pinned?: boolean;
  removed?: boolean;
}): Promise<string> {
  const r = await db.query<{ id: string }>(
    `INSERT INTO bulletin_posts (tenant_id, property_id, alias, content, pinned, is_removed)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [opts.tenantId, opts.propertyId ?? null, opts.alias ?? 'Anon',
     opts.content ?? 'test post', opts.pinned ?? false, opts.removed ?? false])
  return r.rows[0].id
}

describe('GET /api/admin/bulletin — super_admin moderation list', () => {
  it('plain admin → 403 (super_admin only)', async () => {
    const f = await seedAFixture()
    const res = await request(buildApp())
      .get('/api/admin/bulletin')
      .set('Authorization', `Bearer ${f.adminToken}`)
    expect(res.status).toBe(403)
  })

  it('returns non-removed posts; pinned first then created_at DESC', async () => {
    const f = await seedAFixture()
    const client = await db.connect()
    let tenantId = ''
    try { tenantId = await seedTenant(client) } finally { client.release() }
    const oldPost = await seedBulletinPost({ tenantId, content: 'oldest' })
    const removed = await seedBulletinPost({ tenantId, content: 'removed', removed: true })
    const pinned = await seedBulletinPost({ tenantId, content: 'pinned latest', pinned: true })

    const res = await request(buildApp())
      .get('/api/admin/bulletin')
      .set('Authorization', `Bearer ${f.superAdminToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data.length).toBe(2)  // removed excluded
    expect(res.body.data[0].id).toBe(pinned)  // pinned ordered first
    expect(res.body.data[1].id).toBe(oldPost)
    expect(res.body.data.map((p: any) => p.id)).not.toContain(removed)
  })
})

describe('GET /api/admin/bulletin/:id/reveal', () => {
  it('returns tenant identity + alias + writes bulletin_reveal_log row', async () => {
    const f = await seedAFixture()
    const client = await db.connect()
    let tenantId = ''
    try { tenantId = await seedTenant(client) } finally { client.release() }
    const postId = await seedBulletinPost({ tenantId, alias: 'AnonymousFrog' })

    const res = await request(buildApp())
      .get(`/api/admin/bulletin/${postId}/reveal`)
      .set('Authorization', `Bearer ${f.superAdminToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data.alias).toBe('AnonymousFrog')
    expect(res.body.data.first_name).toBeDefined()
    expect(res.body.data.email).toBeDefined()

    const log = await db.query<{ admin_id: string; post_id: string }>(
      `SELECT admin_id, post_id FROM bulletin_reveal_log WHERE post_id=$1`, [postId])
    expect(log.rows.length).toBe(1)
    expect(log.rows[0].admin_id).toBe(f.superAdminUserId)
  })

  it('post not found → 404', async () => {
    const f = await seedAFixture()
    const res = await request(buildApp())
      .get(`/api/admin/bulletin/${randomUUID()}/reveal`)
      .set('Authorization', `Bearer ${f.superAdminToken}`)
    expect(res.status).toBe(404)
    expect(res.body.error).toMatch(/Post not found/)
  })
})

describe('POST /api/admin/bulletin/:id/pin + /remove', () => {
  it('pin=true sets pinned + writes admin_action_log (bulletin_pin)', async () => {
    const f = await seedAFixture()
    const client = await db.connect()
    let tenantId = ''
    try { tenantId = await seedTenant(client) } finally { client.release() }
    const postId = await seedBulletinPost({ tenantId })

    const res = await request(buildApp())
      .post(`/api/admin/bulletin/${postId}/pin`)
      .set('Authorization', `Bearer ${f.superAdminToken}`)
      .send({ pin: true })
    expect(res.status).toBe(200)
    const row = await db.query<{ pinned: boolean }>(
      `SELECT pinned FROM bulletin_posts WHERE id=$1`, [postId])
    expect(row.rows[0].pinned).toBe(true)
    const log = await db.query<{ action_type: string; target_id: string }>(
      `SELECT action_type, target_id FROM admin_action_log WHERE target_type='bulletin_post' AND admin_user_id=$1`,
      [f.superAdminUserId])
    expect(log.rows.length).toBe(1)
    expect(log.rows[0].action_type).toBe('bulletin_pin')
    expect(log.rows[0].target_id).toBe(postId)
  })

  it('pin=false sets unpin action_type', async () => {
    const f = await seedAFixture()
    const client = await db.connect()
    let tenantId = ''
    try { tenantId = await seedTenant(client) } finally { client.release() }
    const postId = await seedBulletinPost({ tenantId, pinned: true })

    await request(buildApp())
      .post(`/api/admin/bulletin/${postId}/pin`)
      .set('Authorization', `Bearer ${f.superAdminToken}`)
      .send({ pin: false })
    const log = await db.query<{ action_type: string }>(
      `SELECT action_type FROM admin_action_log WHERE target_id=$1`, [postId])
    expect(log.rows[0].action_type).toBe('bulletin_unpin')
  })

  it('/remove sets is_removed + stamps removed_at + removed_by + writes audit log', async () => {
    const f = await seedAFixture()
    const client = await db.connect()
    let tenantId = ''
    try { tenantId = await seedTenant(client) } finally { client.release() }
    const postId = await seedBulletinPost({ tenantId })

    const res = await request(buildApp())
      .post(`/api/admin/bulletin/${postId}/remove`)
      .set('Authorization', `Bearer ${f.superAdminToken}`).send({})
    expect(res.status).toBe(200)
    const row = await db.query<{ is_removed: boolean; removed_by: string; removed_at: string | null }>(
      `SELECT is_removed, removed_by, removed_at FROM bulletin_posts WHERE id=$1`, [postId])
    expect(row.rows[0].is_removed).toBe(true)
    expect(row.rows[0].removed_by).toBe(f.superAdminUserId)
    expect(row.rows[0].removed_at).not.toBeNull()
    const log = await db.query<{ action_type: string }>(
      `SELECT action_type FROM admin_action_log WHERE target_id=$1`, [postId])
    expect(log.rows[0].action_type).toBe('bulletin_remove')
  })
})

describe('GET /api/admin/income/projection', () => {
  it('empty fixture: returns zero-everything shape with correct fee constants', async () => {
    const f = await seedAFixture()
    const res = await request(buildApp())
      .get('/api/admin/income/projection')
      .set('Authorization', `Bearer ${f.adminToken}`)
    expect(res.status).toBe(200)
    const d = res.body.data
    expect(d.monthly).toMatchObject({
      otp_unit_fees: 0, direct_unit_fees: 0, flex_pay_fees: 0,
      bg_check_fees: 0, total: 0,
    })
    expect(d.annual).toBe(0)
    expect(d.counts).toMatchObject({
      otp_units: 0, direct_units: 0, active_units: 0,
      flex_pay: 0, bg_checks: 0,
    })
  })

  it('seeded data: math pins direct-unit fees ($5/active unit without OTP)', async () => {
    const f = await seedAFixture()
    const client = await db.connect()
    try {
      await client.query('BEGIN')
      const propertyId = await seedProperty(client, {
        landlordId: f.landlordId, ownerUserId: f.landlordUserId,
        managedByUserId: f.landlordUserId,
      })
      const u1 = await seedUnit(client, { propertyId, landlordId: f.landlordId })
      const u2 = await seedUnit(client, { propertyId, landlordId: f.landlordId })
      await client.query(`UPDATE units SET status='active' WHERE id IN ($1, $2)`, [u1, u2])
      await client.query('COMMIT')
    } catch (e) { await client.query('ROLLBACK'); throw e } finally { client.release() }

    const res = await request(buildApp())
      .get('/api/admin/income/projection')
      .set('Authorization', `Bearer ${f.adminToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data.counts.active_units).toBe(2)
    expect(res.body.data.counts.direct_units).toBe(2)  // no OTP enrolled
    expect(res.body.data.monthly.direct_unit_fees).toBe(10)  // 2 × $5
    expect(res.body.data.annual).toBe(120)  // 10 × 12
  })
})

describe('GET /api/admin/onboarding/landlord/:id — detail + checklist', () => {
  it('happy path: checklist reflects state (bank=false initially)', async () => {
    const f = await seedAFixture()
    const res = await request(buildApp())
      .get(`/api/admin/onboarding/landlord/${f.landlordId}`)
      .set('Authorization', `Bearer ${f.adminToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data.landlord.id).toBe(f.landlordId)
    const checklist = Object.fromEntries(
      res.body.data.checklist.map((c: any) => [c.key, c.done]))
    expect(checklist.account_created).toBe(true)
    expect(checklist.bank_account_added).toBe(false)  // no bank seeded
    expect(checklist.property_added).toBe(false)
    expect(checklist.onboarding_complete).toBe(false)  // landlords default
  })

  it('checklist updates after seeding bank + property + unit', async () => {
    const f = await seedAFixture()
    const client = await db.connect()
    try {
      await client.query('BEGIN')
      await seedUserBankAccount(client, { userId: f.landlordUserId })
      const propertyId = await seedProperty(client, {
        landlordId: f.landlordId, ownerUserId: f.landlordUserId,
        managedByUserId: f.landlordUserId,
      })
      await seedUnit(client, { propertyId, landlordId: f.landlordId })
      await client.query('COMMIT')
    } catch (e) { await client.query('ROLLBACK'); throw e } finally { client.release() }

    const res = await request(buildApp())
      .get(`/api/admin/onboarding/landlord/${f.landlordId}`)
      .set('Authorization', `Bearer ${f.adminToken}`)
    expect(res.status).toBe(200)
    const checklist = Object.fromEntries(
      res.body.data.checklist.map((c: any) => [c.key, c.done]))
    expect(checklist.bank_account_added).toBe(true)
    expect(checklist.property_added).toBe(true)
    expect(checklist.unit_added).toBe(true)
    expect(checklist.tenant_invited).toBe(false)  // no active lease
    expect(res.body.data.counts.property_count).toBe(1)
    expect(res.body.data.counts.unit_count).toBe(1)
  })
})
