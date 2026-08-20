/**
 * admin.ts audit log + email failures + NACHA + invoices backfill
 * slice — S370 (admin.ts slice 4 of N).
 *
 * 4 super_admin / admin reads + 1 super_admin job-trigger:
 *   - GET /audit-log (super_admin) — multi-filter query builder
 *   - POST /invoices/backfill (super_admin) — dry-run + commit
 *   - GET /email-failures (super_admin) — status + category filters
 *   - GET /nacha/monitoring — read-only ACH stats rollup
 *
 * S370 F1 probe: nacha/monitoring's stats query references
 * `zero_tolerance_flag=TRUE` but the ach_monitoring_log schema
 * has no such column (only `flagged` boolean). Same class as
 * S355 GROUP BY drift.
 */

import { vi, describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { randomUUID } from 'crypto'
import { db } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedTenant } from '../test/dbHelpers'

const { backfillInvoicesMock } = vi.hoisted(() => ({
  backfillInvoicesMock: vi.fn(async (..._args: any[]) => ({
    leasesProcessed: 0, invoicesInserted: 0, invoicesSkipped: 0,
  })),
}))
vi.mock('../jobs/invoiceGeneration', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, backfillInvoices: backfillInvoicesMock }
})

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
  backfillInvoicesMock.mockClear()
  backfillInvoicesMock.mockResolvedValue({
    leasesProcessed: 0, invoicesInserted: 0, invoicesSkipped: 0,
  } as any)
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_admin_audit'
})

interface AFixture {
  adminUserId:     string
  superAdminUserId: string
  adminToken:      string
  superAdminToken: string
}

async function seedAFixture(): Promise<AFixture> {
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    // seedLandlord ensures users table is populated for the JOINs in
    // /audit-log's admins-list query.
    await seedLandlord(client)
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
      adminUserId:      adminRes.rows[0].id,
      superAdminUserId: superAdminRes.rows[0].id,
      adminToken:       sign(adminRes.rows[0].id, 'admin'),
      superAdminToken:  sign(superAdminRes.rows[0].id, 'super_admin'),
    }
  } catch (e) { await client.query('ROLLBACK'); throw e }
  finally { client.release() }
}

describe('GET /api/admin/audit-log', () => {
  it('plain admin → 403 (super_admin only)', async () => {
    const f = await seedAFixture()
    const res = await request(buildApp())
      .get('/api/admin/audit-log')
      .set('Authorization', `Bearer ${f.adminToken}`)
    expect(res.status).toBe(403)
  })

  it('empty → rows:[], total:0, actionTypes:[], admins:[]', async () => {
    const f = await seedAFixture()
    const res = await request(buildApp())
      .get('/api/admin/audit-log')
      .set('Authorization', `Bearer ${f.superAdminToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data.rows).toEqual([])
    expect(res.body.data.total).toBe(0)
    expect(res.body.data.actionTypes).toEqual([])
    expect(res.body.data.admins).toEqual([])
  })

  it('action_type filter narrows results; total reflects filtered count; actionTypes returns DISTINCT list', async () => {
    const f = await seedAFixture()
    // Seed 2 distinct action_types
    await db.query(
      `INSERT INTO admin_action_log (admin_user_id, action_type) VALUES
         ($1, 'nexus_register'),
         ($1, 'nexus_register'),
         ($1, 'invoice_backfill')`,
      [f.superAdminUserId])

    const res = await request(buildApp())
      .get('/api/admin/audit-log?action_type=nexus_register')
      .set('Authorization', `Bearer ${f.superAdminToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data.rows.length).toBe(2)
    expect(res.body.data.total).toBe(2)
    expect(res.body.data.actionTypes.sort()).toEqual(['invoice_backfill', 'nexus_register'])
    expect(res.body.data.admins.length).toBe(1)
    expect(res.body.data.admins[0].id).toBe(f.superAdminUserId)
  })
})

describe('POST /api/admin/invoices/backfill', () => {
  it('missing `from` → 400', async () => {
    const f = await seedAFixture()
    const res = await request(buildApp())
      .post('/api/admin/invoices/backfill')
      .set('Authorization', `Bearer ${f.superAdminToken}`)
      .send({ to: '2026-05-31' })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/from is required as YYYY-MM-DD/)
  })

  it('non-uuid landlord_id → 400', async () => {
    const f = await seedAFixture()
    const res = await request(buildApp())
      .post('/api/admin/invoices/backfill')
      .set('Authorization', `Bearer ${f.superAdminToken}`)
      .send({ from: '2026-01-01', to: '2026-05-31', landlord_id: 'not-a-uuid' })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/landlord_id must be a uuid/)
  })

  it('dry_run=true: calls backfillInvoices with dryRun, returns result + writes audit log', async () => {
    const f = await seedAFixture()
    backfillInvoicesMock.mockResolvedValueOnce({
      leasesProcessed: 5, invoicesInserted: 12, invoicesSkipped: 3,
    } as any)

    const res = await request(buildApp())
      .post('/api/admin/invoices/backfill')
      .set('Authorization', `Bearer ${f.superAdminToken}`)
      .send({ from: '2026-01-01', to: '2026-05-31', dry_run: true })
    expect(res.status).toBe(200)
    expect(res.body.data).toMatchObject({
      dryRun: true, leasesProcessed: 5, invoicesInserted: 12, invoicesSkipped: 3,
    })
    expect(backfillInvoicesMock.mock.calls[0]![0]).toMatchObject({
      from: '2026-01-01', to: '2026-05-31', dryRun: true,
    })

    const log = await db.query<{ action_type: string; notes: string }>(
      `SELECT action_type, notes FROM admin_action_log
        WHERE admin_user_id=$1 AND target_type='invoice'`, [f.superAdminUserId])
    expect(log.rows.length).toBe(1)
    expect(log.rows[0].action_type).toBe('invoices_backfill_dry_run')
    expect(log.rows[0].notes).toMatch(/invoices=12/)
  })
})

describe('GET /api/admin/email-failures', () => {
  it('default status=failed; sent rows excluded', async () => {
    const f = await seedAFixture()
    await db.query(
      `INSERT INTO email_send_log (to_email, subject, category, status) VALUES
         ('a@x.dev', 'failed one', 'tx', 'failed'),
         ('b@x.dev', 'sent one',   'tx', 'sent')`)
    const res = await request(buildApp())
      .get('/api/admin/email-failures')
      .set('Authorization', `Bearer ${f.superAdminToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data.status).toBe('failed')
    expect(res.body.data.rows.length).toBe(1)
    expect(res.body.data.rows[0].subject).toBe('failed one')
  })

  it('category filter narrows results', async () => {
    const f = await seedAFixture()
    await db.query(
      `INSERT INTO email_send_log (to_email, subject, category, status) VALUES
         ('a@x.dev', 'tx-failed',     'tx',          'failed'),
         ('b@x.dev', 'mktg-failed',   'marketing',   'failed')`)
    const res = await request(buildApp())
      .get('/api/admin/email-failures?category=marketing')
      .set('Authorization', `Bearer ${f.superAdminToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data.rows.length).toBe(1)
    expect(res.body.data.rows[0].subject).toBe('mktg-failed')
  })
})

describe('GET /api/admin/nacha/monitoring', () => {
  it('empty fixture → logs:[], stats with zero counters', async () => {
    const f = await seedAFixture()
    const res = await request(buildApp())
      .get('/api/admin/nacha/monitoring')
      .set('Authorization', `Bearer ${f.superAdminToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data.logs).toEqual([])
    expect(Number(res.body.data.stats.total_returns)).toBe(0)
    expect(Number(res.body.data.stats.zero_tolerance_events)).toBe(0)
  })

  it('seeded ach_monitoring_log rows: stats aggregates correctly', async () => {
    const f = await seedAFixture()
    // Seed 2 rows: a velocity_flag and a zero_tolerance_block (flagged)
    await db.query(
      `INSERT INTO ach_monitoring_log (event_type, flagged, return_code) VALUES
         ('velocity_flag',        TRUE, NULL),
         ('zero_tolerance_block', TRUE, 'R01'),
         ('first_sender',         FALSE, NULL)`)

    const res = await request(buildApp())
      .get('/api/admin/nacha/monitoring')
      .set('Authorization', `Bearer ${f.superAdminToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data.logs.length).toBe(3)
    expect(Number(res.body.data.stats.total_returns)).toBe(1)  // 1 row has return_code
    expect(Number(res.body.data.stats.zero_tolerance_events)).toBeGreaterThanOrEqual(1)
    expect(Number(res.body.data.stats.first_senders_30d)).toBe(1)
    expect(Number(res.body.data.stats.velocity_flags_30d)).toBe(1)
  })

  // S592: NACHA/ACH monitoring is super_admin-only (platform-staff). A plain
  // admin (portfolio manager) must not see the platform-wide ACH compliance log.
  it('plain admin → 403 (super_admin only)', async () => {
    const f = await seedAFixture()
    const res = await request(buildApp())
      .get('/api/admin/nacha/monitoring')
      .set('Authorization', `Bearer ${f.adminToken}`)
    expect(res.status).toBe(403)
  })
})

/**
 * S609 (Nic): "on the monthly rent volume trend KPI card, that's showing a graph
 * still that stops in March. It's not updated with the rolling last six months."
 *
 * It wasn't a stale window — the chart was a HARDCODED array of five invented
 * months plus one real value labelled with a month it wasn't. It drew a tidy
 * rising line no matter what the platform did, which on a financial dashboard is
 * worse than showing nothing.
 *
 * These pin the replacement: real settled money, a continuous month series, and
 * a window that reaches back far enough for the long view.
 */
describe('S609 GET /api/admin/rent-volume-trend', () => {
  async function settledRent(f: AFixture, monthsAgo: number, amount: number) {
    const c = await db.connect()
    try {
      await c.query('BEGIN')
      const { userId, landlordId } = await seedLandlord(c)
      const propertyId = await seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: userId })
      const unitId = await seedUnit(c, { propertyId, landlordId })
      const tenantId = await seedTenant(c)
      await c.query(
        `INSERT INTO payments (unit_id, tenant_id, landlord_id, type, amount, status,
                               entry_description, due_date, settled_at)
         VALUES ($1,$2,$3,'rent',$4,'settled','RENT', CURRENT_DATE,
                 date_trunc('month', CURRENT_DATE) - make_interval(months => $5::int))`,
        [unitId, tenantId, landlordId, amount.toFixed(2), monthsAgo])
      await c.query('COMMIT')
    } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
  }

  it('returns one point per month, oldest first', async () => {
    const f = await seedAFixture()
    const res = await request(buildApp())
      .get('/api/admin/rent-volume-trend?months=6')
      .set('Authorization', `Bearer ${f.superAdminToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(6)
    const starts = res.body.data.map((d: any) => d.monthStart)
    expect([...starts].sort()).toEqual(starts)   // already ascending
  })

  it('reports money that actually settled, in the month it settled', async () => {
    const f = await seedAFixture()
    await settledRent(f, 2, 1500)
    await settledRent(f, 0, 900)
    const res = await request(buildApp())
      .get('/api/admin/rent-volume-trend?months=6')
      .set('Authorization', `Bearer ${f.superAdminToken}`)
    const pts = res.body.data as any[]
    expect(pts[pts.length - 1].revenue).toBeCloseTo(900, 2)
    expect(pts[pts.length - 3].revenue).toBeCloseTo(1500, 2)
  })

  it('an empty month is a ZERO, not a missing row', async () => {
    // The heartbeat has to flatline through a dead month. A gap would close up
    // and imply continuous activity that never happened.
    const f = await seedAFixture()
    await settledRent(f, 0, 500)
    const res = await request(buildApp())
      .get('/api/admin/rent-volume-trend?months=6')
      .set('Authorization', `Bearer ${f.superAdminToken}`)
    const pts = res.body.data as any[]
    expect(pts).toHaveLength(6)
    expect(pts.slice(0, 5).every(p => p.revenue === 0)).toBe(true)
  })

  it('unsettled rent is not counted', async () => {
    const f = await seedAFixture()
    const c = await db.connect()
    try {
      await c.query('BEGIN')
      const { userId, landlordId } = await seedLandlord(c)
      const propertyId = await seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: userId })
      const unitId = await seedUnit(c, { propertyId, landlordId })
      const tenantId = await seedTenant(c)
      await c.query(
        `INSERT INTO payments (unit_id, tenant_id, landlord_id, type, amount, status, entry_description, due_date)
         VALUES ($1,$2,$3,'rent',9999,'pending','RENT', CURRENT_DATE)`,
        [unitId, tenantId, landlordId])
      await c.query('COMMIT')
    } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
    const res = await request(buildApp())
      .get('/api/admin/rent-volume-trend?months=6')
      .set('Authorization', `Bearer ${f.superAdminToken}`)
    const total = (res.body.data as any[]).reduce((s, p) => s + p.revenue, 0)
    expect(total).toBe(0)
  })

  it('supports the long view and caps it', async () => {
    const f = await seedAFixture()
    const three = await request(buildApp())
      .get('/api/admin/rent-volume-trend?months=36')
      .set('Authorization', `Bearer ${f.superAdminToken}`)
    expect(three.body.data).toHaveLength(36)
    const absurd = await request(buildApp())
      .get('/api/admin/rent-volume-trend?months=500')
      .set('Authorization', `Bearer ${f.superAdminToken}`)
    expect(absurd.body.data).toHaveLength(36)
  })

  it('a regular admin cannot read platform-wide revenue', async () => {
    const f = await seedAFixture()
    const res = await request(buildApp())
      .get('/api/admin/rent-volume-trend?months=6')
      .set('Authorization', `Bearer ${f.adminToken}`)
    expect(res.status).toBe(403)
  })
})
