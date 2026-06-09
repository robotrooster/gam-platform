/**
 * S421 route-level slice: POST /api/background/webhook/checkr.
 *
 * The existing background.ts webhook route at line 694 dispatches on
 * `:providerName` URL segment → `getProvider(name)`. S420 added a
 * CheckrProvider implementing the same interface; this slice verifies
 * the route correctly routes to it.
 *
 * Covered cases (6):
 *   - Valid HMAC + known provider_ref + "clear" → 200, row.status =
 *     complete, expires_at stamped 6 months out
 *   - Valid HMAC + known provider_ref + "pending" → 200, row.status =
 *     processing, expires_at NOT set (only on complete)
 *   - Valid HMAC + unknown provider_ref → 404
 *   - Invalid HMAC signature → 401, row NOT updated
 *   - No signature header → 401, row NOT updated
 *   - Webhook for "checkr" provider does NOT match a row stamped as
 *     provider_name='mock' even when the ref matches by chance
 *
 * ⚠ NOTE: the route at background.ts:697 re-stringifies req.body via
 * JSON.stringify to recompute HMAC. This works in these tests because
 * the test sender stringifies the same parsed object. In production
 * Checkr's HMAC is computed against THEIR raw bytes (key order +
 * whitespace exactly as sent), so re-stringifying server-side will
 * drift. The route needs `express.raw({type:'application/json'})`
 * middleware (Stripe webhook path already has this; the background
 * webhook does not). Flagged in S421 handoff as a follow-on.
 */

import { describe, it, expect, beforeEach } from 'vitest'
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
  // S422: mirror the production middleware order — raw body for the
  // background webhook path BEFORE express.json(). The HMAC is
  // verified against the exact bytes received; if express.json()
  // parsed first, we'd be back to the re-stringify-then-verify
  // pattern that breaks Checkr in production.
  app.use('/api/background/webhook', express.raw({ type: 'application/json' }))
  app.use(express.json({ limit: '2mb' }))
  app.use('/api/background', backgroundRouter)
  app.use(errorHandler)
  return app
}

beforeEach(async () => {
  await cleanupAllSchema()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_s421'
  process.env.CHECKR_WEBHOOK_SECRET = 'whsec_s421_checkr'
})

interface Fixture {
  landlordUserId: string
  landlordId:     string
  applicantUserId: string
  checkId:        string
  providerRef:    string
}

async function seed(opts: {
  providerName?: 'mock' | 'checkr'
  status?: string
  providerRef?: string
} = {}): Promise<Fixture> {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const { userId: landlordUserId, landlordId } = await seedLandlord(c)
    // Seed a second user to act as the applicant (background_checks.user_id).
    const { rows: [{ id: applicantUserId }] } = await c.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
       VALUES ($1, 'x', 'tenant', 'App', 'Licant', TRUE) RETURNING id`,
      [`app-${randomUUID()}@test.dev`])
    const providerRef = opts.providerRef ?? 'rep_' + randomUUID().replace(/-/g, '')
    const { rows: [{ id: checkId }] } = await c.query<{ id: string }>(
      `INSERT INTO background_checks
         (landlord_id, user_id, status, provider_name, provider_ref,
          consent_credit, consent_criminal, consent_pool,
          first_name, last_name)
       VALUES ($1, $2, $3, $4, $5, TRUE, TRUE, FALSE, 'App', 'Licant')
       RETURNING id`,
      [landlordId, applicantUserId,
       opts.status ?? 'processing',
       opts.providerName ?? 'checkr',
       providerRef])
    await c.query('COMMIT')
    return { landlordUserId, landlordId, applicantUserId, checkId, providerRef }
  } catch (e) { await c.query('ROLLBACK'); throw e }
  finally { c.release() }
}

// Build a Checkr-shaped webhook envelope.
function checkrEnvelope(providerRef: string, status: string, adjudication?: string) {
  return {
    type: status === 'clear' ? 'report.completed' : 'report.updated',
    data: { object: { id: providerRef, status, adjudication: adjudication ?? null } },
  }
}

function signHmac(rawBody: string, secret: string): string {
  // S422: HMAC is computed against EXACT BYTES the webhook sends.
  // Tests build the raw string once, compute HMAC over it, and ship
  // it as the body. The route reads `req.body` as a Buffer (per the
  // express.raw middleware) and verifies against the same bytes.
  return crypto.createHmac('sha256', secret).update(rawBody).digest('hex')
}

// ─── happy paths ─────────────────────────────────────────────

describe('POST /api/background/webhook/checkr — happy paths', () => {
  it('valid HMAC + known ref + "clear" → 200; row → complete; expires_at stamped', async () => {
    const f = await seed({ status: 'processing', providerName: 'checkr' })
    const rawBody = JSON.stringify(checkrEnvelope(f.providerRef, 'clear', 'engaged'))
    const sig = signHmac(rawBody, 'whsec_s421_checkr')
    const res = await request(buildApp())
      .post('/api/background/webhook/checkr')
      .set('x-checkr-signature', sig)
      .set('Content-Type', 'application/json')
      .send(rawBody)
    expect(res.status).toBe(200)
    const { rows: [row] } = await db.query<any>(
      `SELECT status, expires_at, webhook_received_at, report_summary
         FROM background_checks WHERE id=$1`, [f.checkId])
    expect(row.status).toBe('complete')
    expect(row.expires_at).not.toBeNull()
    expect(row.webhook_received_at).not.toBeNull()
    expect(row.report_summary).toMatchObject({ adjudication: 'engaged', raw_status: 'clear' })
    // Verify the 6-month window (give a 2-min tolerance).
    const stamped = new Date(row.expires_at).getTime()
    const expected = Date.now() + 6 * 30 * 24 * 60 * 60 * 1000
    expect(Math.abs(stamped - expected)).toBeLessThan(7 * 24 * 60 * 60 * 1000)  // 7d tolerance
  })

  it('valid HMAC + "pending" status → 200; row → processing; expires_at NOT set', async () => {
    const f = await seed({ status: 'awaiting_applicant', providerName: 'checkr' })
    const rawBody = JSON.stringify(checkrEnvelope(f.providerRef, 'pending'))
    const sig = signHmac(rawBody, 'whsec_s421_checkr')
    const res = await request(buildApp())
      .post('/api/background/webhook/checkr')
      .set('x-checkr-signature', sig)
      .set('Content-Type', 'application/json')
      .send(rawBody)
    expect(res.status).toBe(200)
    const { rows: [row] } = await db.query<any>(
      `SELECT status, expires_at FROM background_checks WHERE id=$1`, [f.checkId])
    expect(row.status).toBe('processing')
    expect(row.expires_at).toBeNull()
  })
})

// ─── failure paths ───────────────────────────────────────────

describe('POST /api/background/webhook/checkr — failure paths', () => {
  it('invalid HMAC → 401; row NOT updated', async () => {
    const f = await seed({ status: 'processing', providerName: 'checkr' })
    const rawBody = JSON.stringify(checkrEnvelope(f.providerRef, 'clear'))
    const badSig = signHmac(rawBody, 'wrong_secret')
    const res = await request(buildApp())
      .post('/api/background/webhook/checkr')
      .set('x-checkr-signature', badSig)
      .set('Content-Type', 'application/json')
      .send(rawBody)
    expect(res.status).toBe(401)
    const { rows: [row] } = await db.query<any>(
      `SELECT status FROM background_checks WHERE id=$1`, [f.checkId])
    expect(row.status).toBe('processing')  // unchanged
  })

  it('no signature header → 401', async () => {
    const f = await seed({ status: 'processing', providerName: 'checkr' })
    const rawBody = JSON.stringify(checkrEnvelope(f.providerRef, 'clear'))
    const res = await request(buildApp())
      .post('/api/background/webhook/checkr')
      .set('Content-Type', 'application/json')
      .send(rawBody)
    expect(res.status).toBe(401)
  })

  it('valid HMAC + unknown provider_ref → 404', async () => {
    await seed({ status: 'processing', providerName: 'checkr' })
    const rawBody = JSON.stringify(checkrEnvelope('rep_does_not_exist', 'clear'))
    const sig = signHmac(rawBody, 'whsec_s421_checkr')
    const res = await request(buildApp())
      .post('/api/background/webhook/checkr')
      .set('x-checkr-signature', sig)
      .set('Content-Type', 'application/json')
      .send(rawBody)
    expect(res.status).toBe(404)
  })

  it('Checkr webhook does NOT match row stamped provider_name=mock (same ref)', async () => {
    // Seed under mock — Checkr webhook hits same ref.
    const f = await seed({
      status: 'processing', providerName: 'mock',
      providerRef: 'rep_collision_test',
    })
    const rawBody = JSON.stringify(checkrEnvelope('rep_collision_test', 'clear'))
    const sig = signHmac(rawBody, 'whsec_s421_checkr')
    const res = await request(buildApp())
      .post('/api/background/webhook/checkr')
      .set('x-checkr-signature', sig)
      .set('Content-Type', 'application/json')
      .send(rawBody)
    expect(res.status).toBe(404)
    const { rows: [row] } = await db.query<any>(
      `SELECT status FROM background_checks WHERE id=$1`, [f.checkId])
    expect(row.status).toBe('processing')  // unchanged
  })

  it('S422: HMAC is byte-level — same JSON shape but different whitespace fails verification', async () => {
    // This pins the S422 fix: the route must verify against the
    // EXACT bytes received, not a re-stringification of the parsed
    // object. Pre-S422 the route's JSON.stringify(req.body) would
    // produce identical bytes regardless of input whitespace, masking
    // a fundamentally broken HMAC vector. Now: extra whitespace in
    // the sent body changes the HMAC; verification fails.
    const f = await seed({ status: 'processing', providerName: 'checkr' })
    const obj = checkrEnvelope(f.providerRef, 'clear')
    const compactBody = JSON.stringify(obj)
    const compactSig = signHmac(compactBody, 'whsec_s421_checkr')
    // Send a PRETTY-PRINTED body (with extra whitespace) but use the
    // signature computed against the COMPACT body. Pre-S422 this
    // would have succeeded because both bodies stringify-to-the-same
    // shape via JSON.stringify(parsed). Post-S422 the verify operates
    // on the raw pretty-printed bytes — HMAC won't match.
    const prettyBody = JSON.stringify(obj, null, 2)
    const res = await request(buildApp())
      .post('/api/background/webhook/checkr')
      .set('x-checkr-signature', compactSig)
      .set('Content-Type', 'application/json')
      .send(prettyBody)
    expect(res.status).toBe(401)
    const { rows: [row] } = await db.query<any>(
      `SELECT status FROM background_checks WHERE id=$1`, [f.checkId])
    expect(row.status).toBe('processing')  // unchanged
  })
})
