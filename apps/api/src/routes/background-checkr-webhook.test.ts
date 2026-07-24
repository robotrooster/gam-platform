/**
 * S421 route-level slice, REWRITTEN S551 for the Checkr Tenant API.
 *
 * POST /api/background/webhook/checkr now speaks the Checkr TENANT webhook
 * protocol (docs: checkr-tenant-api-docs.redocly.app/webhooks):
 *   - Header: Tenant-Signature: t=<unix_ts>,v1=<hmac>
 *   - HMAC-SHA256 over `<t>.<raw_body>` with the endpoint signing secret
 *   - Envelope: { id, object:'event', type, created_at, data }
 *   - report.completed data = { id: report_id, order_id } — the route then
 *     pulls GET /reports/{id} via provider.fetchReport (fetch mocked here)
 *
 * Covered cases:
 *   - report.completed (valid sig) → 200, row complete, expires_at stamped,
 *     summary populated from the fetched report (consider on any product)
 *   - order.applicant.completed → 200, row processing, no expires_at, and a
 *     pre-existing report_summary is PRESERVED (COALESCE guard)
 *   - report.completed with failing report fetch → 200, status still applied
 *   - unknown order ref → 404
 *   - invalid signature → 401, row untouched
 *   - missing signature header → 401
 *   - checkr webhook does not match a row stamped provider_name='mock'
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import crypto from 'crypto'
import { randomUUID } from 'crypto'
import { db } from '../db'
import {
  cleanupAllSchema, seedLandlord,
} from '../test/dbHelpers'
import { backgroundRouter } from './background'
import { errorHandler } from '../middleware/errorHandler'

function buildApp() {
  const app = express()
  // Mirror production middleware order — raw body for the background
  // webhook path BEFORE express.json(); HMAC verifies exact bytes.
  app.use('/api/background/webhook', express.raw({ type: 'application/json' }))
  app.use(express.json({ limit: '2mb' }))
  app.use('/api/background', backgroundRouter)
  app.use(errorHandler)
  return app
}

const SECRET = 'whsec_s551_checkr_tenant'

beforeEach(async () => {
  await cleanupAllSchema()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_s421'
  process.env.CHECKR_WEBHOOK_SECRET = SECRET
  process.env.CHECKR_API_KEY = 'ckr_sk_test_unit_test_key'
})

afterEach(() => {
  vi.unstubAllGlobals()
})

interface Fixture {
  landlordId:  string
  checkId:     string
  providerRef: string
}

async function seed(opts: {
  providerName?: 'mock' | 'checkr'
  status?: string
  providerRef?: string
  reportSummary?: Record<string, unknown> | null
} = {}): Promise<Fixture> {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const { landlordId } = await seedLandlord(c)
    const { rows: [{ id: applicantUserId }] } = await c.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
       VALUES ($1, 'x', 'tenant', 'App', 'Licant', TRUE) RETURNING id`,
      [`app-${randomUUID()}@test.dev`])
    const providerRef = opts.providerRef ?? 'ord_' + randomUUID().replace(/-/g, '')
    const { rows: [{ id: checkId }] } = await c.query<{ id: string }>(
      `INSERT INTO background_checks
         (landlord_id, user_id, status, provider_name, provider_ref,
          consent_credit, consent_criminal, consent_pool,
          first_name, last_name, report_summary)
       VALUES ($1, $2, $3, $4, $5, TRUE, TRUE, FALSE, 'App', 'Licant', $6)
       RETURNING id`,
      [landlordId, applicantUserId,
       opts.status ?? 'processing',
       opts.providerName ?? 'checkr',
       providerRef,
       opts.reportSummary ? JSON.stringify(opts.reportSummary) : null])
    await c.query('COMMIT')
    return { landlordId, checkId, providerRef }
  } catch (e) { await c.query('ROLLBACK'); throw e }
  finally { c.release() }
}

// Tenant event envelope.
function tenantEvent(type: string, data: Record<string, unknown>) {
  return {
    id: 'evt_' + randomUUID().replace(/-/g, ''),
    object: 'event',
    type,
    created_at: new Date().toISOString(),
    data,
  }
}

// Tenant-Signature: t=<ts>,v1=<hmac of "<ts>.<raw>">
function tenantSignature(rawBody: string, secret: string, ts?: number): string {
  const t = ts ?? Math.floor(Date.now() / 1000)
  const v1 = crypto.createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex')
  return `t=${t},v1=${v1}`
}

// Stub global fetch so provider.fetchReport gets a canned Tenant report.
function stubReportFetch(report: Record<string, unknown> | null, ok = true) {
  const mock = vi.fn(async () => ({
    ok,
    status: ok ? 200 : 500,
    json: async () => report,
    text: async () => JSON.stringify(report),
  }))
  vi.stubGlobal('fetch', mock)
  return mock
}

// ─── happy paths ─────────────────────────────────────────────

describe('POST /api/background/webhook/checkr — Tenant events', () => {
  it('report.completed → 200, complete, expires stamped, summary from fetched report', async () => {
    const f = await seed({ status: 'processing' })
    const reportId = 'rp_test_' + randomUUID().replace(/-/g, '')
    const fetchMock = stubReportFetch({
      id: reportId,
      order_id: f.providerRef,
      criminal_history: { status: 'consider' },
      credit_report: { status: 'clear' },
      eviction_history: null,
    })
    const rawBody = JSON.stringify(tenantEvent('report.completed', { id: reportId, order_id: f.providerRef }))
    const res = await request(buildApp())
      .post('/api/background/webhook/checkr')
      .set('Tenant-Signature', tenantSignature(rawBody, SECRET))
      .set('Content-Type', 'application/json')
      .send(rawBody)
    expect(res.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledOnce()
    const { rows: [row] } = await db.query<any>(
      `SELECT status, expires_at, webhook_received_at, report_summary
         FROM background_checks WHERE id=$1`, [f.checkId])
    expect(row.status).toBe('complete')
    expect(row.expires_at).not.toBeNull()
    expect(row.webhook_received_at).not.toBeNull()
    expect(row.report_summary).toMatchObject({
      provider:  'checkr',
      report_id: reportId,
      result:    'consider',
      products:  { criminal_history: 'consider', credit_report: 'clear' },
    })
    // 6 calendar months out (Postgres INTERVAL '6 months' — 181..185 days
    // depending on the months crossed).
    const days = (new Date(row.expires_at).getTime() - Date.now()) / 86400000
    expect(days).toBeGreaterThan(175)
    expect(days).toBeLessThan(190)
  })

  it('order.applicant.completed → processing, no expires, existing summary preserved', async () => {
    const f = await seed({ status: 'awaiting_applicant', reportSummary: { result: 'clear', provider: 'checkr' } })
    const rawBody = JSON.stringify(tenantEvent('order.applicant.completed', { id: f.providerRef }))
    const res = await request(buildApp())
      .post('/api/background/webhook/checkr')
      .set('Tenant-Signature', tenantSignature(rawBody, SECRET))
      .set('Content-Type', 'application/json')
      .send(rawBody)
    expect(res.status).toBe(200)
    const { rows: [row] } = await db.query<any>(
      `SELECT status, expires_at, report_summary FROM background_checks WHERE id=$1`, [f.checkId])
    expect(row.status).toBe('processing')
    expect(row.expires_at).toBeNull()
    // COALESCE guard: the summary-less progress event must not null it.
    expect(row.report_summary).toMatchObject({ result: 'clear' })
  })

  it('report.completed with failing report fetch → 200, status still complete', async () => {
    const f = await seed({ status: 'processing' })
    stubReportFetch(null, false)
    const rawBody = JSON.stringify(tenantEvent('report.completed', { id: 'rp_test_x', order_id: f.providerRef }))
    const res = await request(buildApp())
      .post('/api/background/webhook/checkr')
      .set('Tenant-Signature', tenantSignature(rawBody, SECRET))
      .set('Content-Type', 'application/json')
      .send(rawBody)
    expect(res.status).toBe(200)
    const { rows: [row] } = await db.query<any>(
      `SELECT status, report_summary FROM background_checks WHERE id=$1`, [f.checkId])
    expect(row.status).toBe('complete')
    expect(row.report_summary).toBeNull()
  })
})

// ─── rejection paths ─────────────────────────────────────────

describe('POST /api/background/webhook/checkr — rejections', () => {
  it('unknown order ref → 404', async () => {
    await seed({})
    const rawBody = JSON.stringify(tenantEvent('order.applicant.completed', { id: 'ord_does_not_exist' }))
    const res = await request(buildApp())
      .post('/api/background/webhook/checkr')
      .set('Tenant-Signature', tenantSignature(rawBody, SECRET))
      .set('Content-Type', 'application/json')
      .send(rawBody)
    expect(res.status).toBe(404)
  })

  it('invalid signature → 401, row untouched', async () => {
    const f = await seed({ status: 'processing' })
    const rawBody = JSON.stringify(tenantEvent('report.completed', { id: 'rp_x', order_id: f.providerRef }))
    const res = await request(buildApp())
      .post('/api/background/webhook/checkr')
      .set('Tenant-Signature', tenantSignature(rawBody, 'wrong_secret'))
      .set('Content-Type', 'application/json')
      .send(rawBody)
    expect(res.status).toBe(401)
    const { rows: [row] } = await db.query<any>(
      `SELECT status FROM background_checks WHERE id=$1`, [f.checkId])
    expect(row.status).toBe('processing')
  })

  it('missing Tenant-Signature header → 401', async () => {
    const f = await seed({})
    const rawBody = JSON.stringify(tenantEvent('report.completed', { id: 'rp_x', order_id: f.providerRef }))
    const res = await request(buildApp())
      .post('/api/background/webhook/checkr')
      .set('Content-Type', 'application/json')
      .send(rawBody)
    expect(res.status).toBe(401)
  })

  it('checkr webhook does not match a row stamped provider_name=mock', async () => {
    const f = await seed({ providerName: 'mock' })
    const rawBody = JSON.stringify(tenantEvent('order.applicant.completed', { id: f.providerRef }))
    const res = await request(buildApp())
      .post('/api/background/webhook/checkr')
      .set('Tenant-Signature', tenantSignature(rawBody, SECRET))
      .set('Content-Type', 'application/json')
      .send(rawBody)
    expect(res.status).toBe(404)
  })
})
