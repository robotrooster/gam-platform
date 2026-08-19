/**
 * admin.ts overview slice — S362 part 1 of N.
 *
 * First slice of the admin.ts arc (1514 lines, NO TESTS — biggest
 * unwalked file at session start). Covered surfaces:
 *   - File-wide admin/super_admin gating (rejects landlord/tenant)
 *   - GET /overview + /onboarding/overview rollups (F1-class probe
 *     targets per the S355 + S358 SQL-drift pattern)
 *   - GET /tenants admin list
 *   - POST /property-flags/:id/resolve (super_admin — audit log + status flip)
 *   - GET/PATCH /system-features (owner-only, S567)
 *   - GET /notifications + POST /:id/acknowledge (idempotency)
 *
 * Out of scope (future slices):
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
  cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedLease, seedTenant,
} from '../test/dbHelpers'
import { adminRouter } from './admin'
import { OWNER_EMAIL } from '../middleware/auth'
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
  ownerUserId:      string
  landlordUserId:   string
  landlordId:       string
  adminToken:       string
  superAdminToken:  string
  ownerToken:       string   // super_admin whose email === OWNER_EMAIL (System Features, S567)
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
    // S567: System Features is locked to the platform OWNER (email === OWNER_EMAIL),
    // not merely super_admin. Seed a real user with that email for requireOwner routes.
    const ownerRes = await client.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
       VALUES ($1, 'x', 'super_admin', 'Gam', 'Owner', TRUE) RETURNING id`,
      [OWNER_EMAIL])
    await client.query('COMMIT')
    const sign = (u: { id: string }, role: string, email = 'x@test.dev') => jwt.sign(
      { userId: u.id, role, email, profileId: u.id, permissions: {} },
      process.env.JWT_SECRET!, { expiresIn: '1h' },
    )
    return {
      adminUserId:      adminRes.rows[0].id,
      superAdminUserId: superAdminRes.rows[0].id,
      ownerUserId:      ownerRes.rows[0].id,
      landlordUserId,
      landlordId,
      adminToken:       sign(adminRes.rows[0], 'admin'),
      superAdminToken:  sign(superAdminRes.rows[0], 'super_admin'),
      ownerToken:       sign(ownerRes.rows[0], 'super_admin', OWNER_EMAIL),
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

describe('GET /api/admin/deposit-trust/summary', () => {
  async function seedDeposit(
    client: any, f: AFixture,
    opts: { state: string; total: number; collected: number; status: string; heldBy: string; interest?: number; disbursed?: boolean },
  ) {
    const propertyId = await seedProperty(client, {
      landlordId: f.landlordId, ownerUserId: f.landlordUserId, managedByUserId: f.landlordUserId,
    })
    await client.query(`UPDATE properties SET state=$1 WHERE id=$2`, [opts.state, propertyId])
    const unitId = await seedUnit(client, { propertyId, landlordId: f.landlordId })
    const leaseId = await seedLease(client, { unitId, landlordId: f.landlordId })
    const tenantId = await seedTenant(client)
    await client.query(
      `INSERT INTO security_deposits
         (unit_id, lease_id, tenant_id, total_amount, collected_amount, status, held_by, interest_accrued, disbursed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [unitId, leaseId, tenantId, opts.total, opts.collected, opts.status, opts.heldBy,
       opts.interest ?? 0, opts.disbursed ? new Date().toISOString() : null])
  }

  it('super_admin: sums only currently-held gam_escrow deposits, with a by-state breakdown', async () => {
    const f = await seedAFixture()
    const client = await db.connect()
    try {
      await client.query('BEGIN')
      // Held in trust → counted:
      await seedDeposit(client, f, { state: 'AZ', total: 1000, collected: 1000, status: 'funded', heldBy: 'gam_escrow', interest: 5 })
      await seedDeposit(client, f, { state: 'TX', total: 500,  collected: 500,  status: 'funded', heldBy: 'gam_escrow' })
      // Excluded: landlord holds it / already disbursed / not yet collected:
      await seedDeposit(client, f, { state: 'AZ', total: 800, collected: 800, status: 'funded',    heldBy: 'landlord' })
      await seedDeposit(client, f, { state: 'AZ', total: 700, collected: 700, status: 'disbursed', heldBy: 'gam_escrow', disbursed: true })
      await seedDeposit(client, f, { state: 'AZ', total: 900, collected: 0,   status: 'pending',   heldBy: 'gam_escrow' })
      await client.query('COMMIT')
    } catch (e) { await client.query('ROLLBACK'); throw e } finally { client.release() }

    const res = await request(buildApp())
      .get('/api/admin/deposit-trust/summary')
      .set('Authorization', `Bearer ${f.superAdminToken}`)
    expect(res.status).toBe(200)
    const d = res.body.data
    expect(d.heldCount).toBe(2)
    expect(d.totalPrincipal).toBe(1500)
    expect(d.totalInterestAccrued).toBe(5)
    expect(d.totalLiability).toBe(1505)
    expect(d.byState).toEqual([
      expect.objectContaining({ state: 'AZ', count: 1, principal: 1000, interest: 5 }),
      expect.objectContaining({ state: 'TX', count: 1, principal: 500,  interest: 0 }),
    ])
  })

  it('plain admin → 403 (financials are super_admin only)', async () => {
    const f = await seedAFixture()
    const res = await request(buildApp())
      .get('/api/admin/deposit-trust/summary')
      .set('Authorization', `Bearer ${f.adminToken}`)
    expect(res.status).toBe(403)
  })
})

describe('GET /api/admin/overview', () => {
  it('happy path (super_admin): returns rollup shape with all counter fields', async () => {
    // S570: /overview carries platform financials (income projection, reserve/
    // float balances) → super_admin only. A plain admin (portfolio manager) is
    // now 403 here (see the plain-admin test below).
    const f = await seedAFixture()
    const res = await request(buildApp())
      .get('/api/admin/overview')
      .set('Authorization', `Bearer ${f.superAdminToken}`)
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

  it('plain admin (portfolio manager) → 403 (financials are super_admin only)', async () => {
    const f = await seedAFixture()
    const res = await request(buildApp())
      .get('/api/admin/overview')
      .set('Authorization', `Bearer ${f.adminToken}`)
    expect(res.status).toBe(403)
  })
})

describe('GET /api/admin/onboarding/overview', () => {
  it('returns onboarding stats shape', async () => {
    const f = await seedAFixture()
    const res = await request(buildApp())
      .get('/api/admin/onboarding/overview')
      // S567 scoped every count to the caller's portfolio; super_admin ($1 NULL)
      // gets the platform-wide totals this shape/aggregation test asserts.
      .set('Authorization', `Bearer ${f.superAdminToken}`)
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

// S567: property-duplicate-flag resolution is super_admin-only (it exposes both
// landlords' PII for cross-landlord adjudication) — the tests use superAdminToken.
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
      .set('Authorization', `Bearer ${f.superAdminToken}`)
      .send({ resolution: 'approved_separate', notes: 'distinct buildings' })
    expect(res.status).toBe(200)

    const flag = await db.query<{ resolution: string; resolved_by: string }>(
      `SELECT resolution, resolved_by FROM property_duplicate_flags WHERE id=$1`, [flagId])
    expect(flag.rows[0].resolution).toBe('approved_separate')
    expect(flag.rows[0].resolved_by).toBe(f.superAdminUserId)

    const prop = await db.query<{ review_status: string }>(
      `SELECT review_status FROM properties WHERE id=$1`, [propertyId])
    expect(prop.rows[0].review_status).toBe('active')

    const log = await db.query<{ action_type: string; target_id: string }>(
      `SELECT action_type, target_id FROM admin_action_log
        WHERE admin_user_id=$1 AND target_type='property'`,
      [f.superAdminUserId])
    expect(log.rows.length).toBe(1)
    expect(log.rows[0].action_type).toBe('property_flag_approved_separate')
    expect(log.rows[0].target_id).toBe(propertyId)
  })

  it('invalid resolution string → 400', async () => {
    const f = await seedAFixture()
    const res = await request(buildApp())
      .post(`/api/admin/property-flags/${randomUUID()}/resolve`)
      .set('Authorization', `Bearer ${f.superAdminToken}`)
      .send({ resolution: 'i_am_the_law' })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/Invalid resolution/)
  })

  it('already-resolved (or non-existent) flag → 404', async () => {
    const f = await seedAFixture()
    const res = await request(buildApp())
      .post(`/api/admin/property-flags/${randomUUID()}/resolve`)
      .set('Authorization', `Bearer ${f.superAdminToken}`)
      .send({ resolution: 'approved_separate' })
    expect(res.status).toBe(404)
  })
})

// S567: System Features (feature flags) is locked to the platform OWNER
// (email === OWNER_EMAIL), not just super_admin — so no other admin can flip a
// flag by accident. GET + PATCH both require owner.
describe('GET /api/admin/system-features + PATCH (owner-only, S567)', () => {
  it('GET returns rows for the owner', async () => {
    const f = await seedAFixture()
    await db.query(
      `INSERT INTO system_features (key, enabled, description)
       VALUES ('test_feature', FALSE, 'Test feature flag')`)
    const res = await request(buildApp())
      .get('/api/admin/system-features')
      .set('Authorization', `Bearer ${f.ownerToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data.length).toBe(1)
    expect(res.body.data[0].key).toBe('test_feature')
    expect(res.body.data[0].enabled).toBe(false)
  })

  it('GET as a non-owner super_admin → 403', async () => {
    const f = await seedAFixture()
    const res = await request(buildApp())
      .get('/api/admin/system-features')
      .set('Authorization', `Bearer ${f.superAdminToken}`)
    expect(res.status).toBe(403)
  })

  it('PATCH as owner flips enabled flag', async () => {
    const f = await seedAFixture()
    await db.query(
      `INSERT INTO system_features (key, enabled, description)
       VALUES ('toggle_test', FALSE, 'Toggle me')`)
    const res = await request(buildApp())
      .patch('/api/admin/system-features/toggle_test')
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .send({ enabled: true })
    expect(res.status).toBe(200)
    const row = await db.query<{ enabled: boolean; updated_by_user_id: string }>(
      `SELECT enabled, updated_by_user_id FROM system_features WHERE key='toggle_test'`)
    expect(row.rows[0].enabled).toBe(true)
    expect(row.rows[0].updated_by_user_id).toBe(f.ownerUserId)
  })

  it('PATCH as plain admin → 403 (owner only)', async () => {
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

// S592: assignment + the manual referral re-attach accept the new
// portfolio_manager role.
describe('POST /api/admin/landlords/:id/assign — portfolio_manager role', () => {
  it('assigns a portfolio_manager user as the closing manager', async () => {
    const f = await seedAFixture()
    const pm = await db.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
       VALUES ($1,'x','portfolio_manager','PM','Rep',TRUE) RETURNING id`, [`pm-${randomUUID()}@test.dev`])
    const res = await request(buildApp())
      .post(`/api/admin/landlords/${f.landlordId}/assign`)
      .set('Authorization', `Bearer ${f.superAdminToken}`)
      .send({ role: 'closing', managerId: pm.rows[0].id })
    expect(res.status).toBe(200)
    const row = await db.query<{ portfolio_manager_id: string }>(
      `SELECT portfolio_manager_id FROM landlords WHERE id=$1`, [f.landlordId])
    expect(row.rows[0].portfolio_manager_id).toBe(pm.rows[0].id)
  })

  it('rejects a non-rep (a landlord) as a manager → 400', async () => {
    const f = await seedAFixture()
    const res = await request(buildApp())
      .post(`/api/admin/landlords/${f.landlordId}/assign`)
      .set('Authorization', `Bearer ${f.superAdminToken}`)
      .send({ role: 'closing', managerId: f.landlordUserId })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/valid portfolio manager/i)
  })
})

describe('POST /api/admin/users/:userId/referral-upline — manual re-attach (super_admin)', () => {
  it('sets a person\'s upline; self-reference → 400; non-rep/non-landlord upline → 400', async () => {
    const f = await seedAFixture()
    // happy: attach the landlord under the super_admin (a valid GAM rep upline)
    const ok = await request(buildApp())
      .post(`/api/admin/users/${f.landlordUserId}/referral-upline`)
      .set('Authorization', `Bearer ${f.superAdminToken}`)
      .send({ uplineUserId: f.superAdminUserId })
    expect(ok.status).toBe(200)
    const row = await db.query<{ referred_by_user_id: string }>(
      `SELECT referred_by_user_id FROM users WHERE id=$1`, [f.landlordUserId])
    expect(row.rows[0].referred_by_user_id).toBe(f.superAdminUserId)

    // self-reference rejected
    const self = await request(buildApp())
      .post(`/api/admin/users/${f.landlordUserId}/referral-upline`)
      .set('Authorization', `Bearer ${f.superAdminToken}`)
      .send({ uplineUserId: f.landlordUserId })
    expect(self.status).toBe(400)

    // a tenant is neither a landlord nor a rep → invalid upline
    const tenant = await db.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
       VALUES ($1,'x','tenant','T','U',TRUE) RETURNING id`, [`t-${randomUUID()}@test.dev`])
    const bad = await request(buildApp())
      .post(`/api/admin/users/${f.landlordUserId}/referral-upline`)
      .set('Authorization', `Bearer ${f.superAdminToken}`)
      .send({ uplineUserId: tenant.rows[0].id })
    expect(bad.status).toBe(400)
  })

  it('plain admin (portfolio manager) → 403 (super_admin only)', async () => {
    const f = await seedAFixture()
    const res = await request(buildApp())
      .post(`/api/admin/users/${f.landlordUserId}/referral-upline`)
      .set('Authorization', `Bearer ${f.adminToken}`)
      .send({ uplineUserId: f.superAdminUserId })
    expect(res.status).toBe(403)
  })
})
