/**
 * S565: admin nexus-monitor routes.
 *   GET  /api/admin/nexus/dashboard  (super_admin) — read model
 *   POST /api/admin/nexus/recompute  (super_admin) — manual tally rebuild
 *   POST /api/admin/nexus/register   (super_admin) — flip collection gate + audit
 */
import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { randomUUID } from 'crypto'
import { db } from '../db'
import { cleanupAllSchema } from '../test/dbHelpers'
import { adminRouter } from './admin'
import { errorHandler } from '../middleware/errorHandler'

function buildApp() {
  const app = express()
  app.use(express.json({ limit: '2mb' }))
  app.use('/api/admin', adminRouter)
  app.use(errorHandler)
  return app
}

async function clearCatalog() {
  await db.query('DELETE FROM nexus_revenue_tally')
  await db.query('DELETE FROM state_tax_registrations')
  await db.query('DELETE FROM state_nexus_thresholds')
  await db.query('DELETE FROM state_screening_tax_rates')
}

async function tokens() {
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_nexus'
  const su = (await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
     VALUES ($1,'x','super_admin','S','A',TRUE) RETURNING id`, [`su-${randomUUID()}@test.dev`]
  )).rows[0].id
  const ll = (await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
     VALUES ($1,'x','landlord','L','L',TRUE) RETURNING id`, [`ll-${randomUUID()}@test.dev`]
  )).rows[0].id
  const sign = (id: string, role: string) =>
    jwt.sign({ userId: id, role, email: 'x@test.dev', profileId: id, permissions: {} }, process.env.JWT_SECRET!, { expiresIn: '1h' })
  return { superAdminToken: sign(su, 'super_admin'), landlordToken: sign(ll, 'landlord') }
}

beforeEach(async () => {
  await cleanupAllSchema()
  await clearCatalog()
})

describe('GET /api/admin/nexus/dashboard', () => {
  it('rejects a non-super-admin', async () => {
    const { landlordToken } = await tokens()
    const res = await request(buildApp())
      .get('/api/admin/nexus/dashboard')
      .set('Authorization', `Bearer ${landlordToken}`)
    expect(res.status).toBe(403)
  })

  it('returns states + summary + warnFraction for super_admin', async () => {
    const { superAdminToken } = await tokens()
    await db.query(
      `INSERT INTO state_nexus_thresholds (state_code, effective_year, revenue_threshold_usd, txn_threshold, count_rule, status)
       VALUES ('TX',2026,500000,NULL,'revenue_only','research')`
    )
    await db.query(`INSERT INTO nexus_revenue_tally (state_code, period_year, revenue_usd, txn_count) VALUES ('TX',2026,600000,3)`)
    const res = await request(buildApp())
      .get('/api/admin/nexus/dashboard')
      .set('Authorization', `Bearer ${superAdminToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data.warnFraction).toBe(0.8)
    const tx = res.body.data.states.find((s: any) => s.stateCode === 'TX')
    expect(tx.status).toBe('crossed')
  })
})

describe('POST /api/admin/nexus/register', () => {
  it('flips the registration gate and writes an audit row', async () => {
    const { superAdminToken } = await tokens()
    const res = await request(buildApp())
      .post('/api/admin/nexus/register')
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({ stateCode: 'TX', registered: true, notes: 'permit 123' })
    expect(res.status).toBe(200)
    const reg = (await db.query<{ registered: boolean }>(
      `SELECT registered FROM state_tax_registrations WHERE state_code='TX'`
    )).rows[0]
    expect(reg.registered).toBe(true)
    const audit = (await db.query<{ n: string }>(
      `SELECT COUNT(*) n FROM admin_action_log WHERE action_type='nexus_state_registration'`
    )).rows[0]
    expect(Number(audit.n)).toBe(1)
  })

  it('rejects an invalid state code', async () => {
    const { superAdminToken } = await tokens()
    const res = await request(buildApp())
      .post('/api/admin/nexus/register')
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({ stateCode: 'TEXAS', registered: true })
    expect(res.status).toBeGreaterThanOrEqual(400)
  })
})

describe('POST /api/admin/nexus/recompute', () => {
  it('runs the tally and returns years + rows', async () => {
    const { superAdminToken } = await tokens()
    const res = await request(buildApp())
      .post('/api/admin/nexus/recompute')
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({})
    expect(res.status).toBe(200)
    expect(Array.isArray(res.body.data.years)).toBe(true)
    expect(res.body.data.years.length).toBe(2)
  })
})
