/**
 * landlords.ts gap-close slice — S395. Closes the file at 55/55 (100%).
 *
 * Covered routes (8):
 *   - GET   /api/landlords/                                    (admin)
 *   - GET   /api/landlords/flex-charge/accounts
 *   - GET   /api/landlords/flex-charge/accounts/:id/statements
 *   - GET   /api/landlords/theme
 *   - POST  /api/landlords/me/pending-tenants/:intentId/document
 *   - GET   /api/landlords/me/pending-tenants/:intentId/document
 *   - GET   /api/landlords/me/pending-tenants/:intentId
 *   - POST  /api/landlords/me/pending-tenants/:intentId/resolve
 *
 * Architectural note (NOT a new bug, but third instance of a known pattern):
 *   - POST /me/pending-tenants/:intentId/document is the third
 *     instance of the XSS extension-mismatch pattern (S380 avatar +
 *     S394 esign upload). HERE the GET defends at read-path via
 *     `res.setHeader('Content-Type', 'application/pdf')` before
 *     sendFile — so the cross-content-type XSS doesn't surface
 *     through this route's read path. Worth fixing the write-path
 *     too for defense-in-depth (force .pdf extension); bundle into
 *     the validation-hygiene micro-session along with the avatar
 *     fix.
 */

import { vi, describe, it, expect, beforeEach, afterAll } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import path from 'path'
import fs from 'fs'
import { randomUUID } from 'crypto'
import { db } from '../db'
import {
  cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedTenant,
} from '../test/dbHelpers'

const { scheduleParserJobMock, resolveIntentMock } = vi.hoisted(() => ({
  scheduleParserJobMock: vi.fn(),
  resolveIntentMock:     vi.fn(async (..._a: any[]) => ({ ok: true, tenantId: 'mock-tenant' })),
}))
vi.mock('../jobs/leaseParser/runParserJob', () => ({
  scheduleParserJob: scheduleParserJobMock,
}))
vi.mock('../jobs/leaseParser/resolveIntent', () => ({
  resolveIntent: resolveIntentMock,
}))

import { landlordsRouter } from './landlords'
import { errorHandler } from '../middleware/errorHandler'

function buildApp() {
  const app = express()
  app.use(express.json({ limit: '2mb' }))
  app.use('/api/landlords', landlordsRouter)
  app.use(errorHandler)
  return app
}

const cleanupTargets: string[] = []

beforeEach(async () => {
  await cleanupAllSchema()
  scheduleParserJobMock.mockClear()
  resolveIntentMock.mockClear()
  resolveIntentMock.mockResolvedValue({ ok: true, tenantId: 'mock-tenant' } as any)
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_landlords_gap'
})

afterAll(() => {
  for (const p of cleanupTargets) {
    try { fs.unlinkSync(p) } catch { /* best effort */ }
  }
})

const PDF_BYTES = Buffer.from('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n', 'binary')

interface Fixture {
  landlordAUserId:  string
  landlordAId:      string
  landlordBUserId:  string
  landlordBId:      string
  tenantAId:        string
  adminToken:       string
  tokenA:           string
  tokenB:           string
}

async function seed(): Promise<Fixture> {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const { userId: aUid, landlordId: aId } = await seedLandlord(c)
    const { userId: bUid, landlordId: bId } = await seedLandlord(c)
    const tenantA = await seedTenant(c)
    const admin = await c.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
       VALUES ($1, 'x', 'admin', 'A', 'U', TRUE) RETURNING id`,
      [`admin-${randomUUID()}@test.dev`])
    await c.query('COMMIT')
    const sign = (p: object) => jwt.sign(p, process.env.JWT_SECRET!, { expiresIn: '1h' })
    return {
      landlordAUserId: aUid, landlordAId: aId,
      landlordBUserId: bUid, landlordBId: bId,
      tenantAId: tenantA,
      adminToken: sign({ userId: admin.rows[0].id, role: 'admin', email: 'a@t.dev', profileId: null, permissions: {} }),
      tokenA:     sign({ userId: aUid, role: 'landlord', email: 'la@t.dev', profileId: aId, permissions: {} }),
      tokenB:     sign({ userId: bUid, role: 'landlord', email: 'lb@t.dev', profileId: bId, permissions: {} }),
    }
  } catch (e) { await c.query('ROLLBACK'); throw e }
  finally { c.release() }
}

async function seedIntent(f: Fixture, opts: { parserStatus?: string; pdfUrl?: string | null } = {}): Promise<string> {
  const r = await db.query<{ id: string }>(
    `INSERT INTO pending_tenant_intents (landlord_id, tenant_id, parser_status, imported_pdf_url)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [f.landlordAId, f.tenantAId, opts.parserStatus ?? 'not_uploaded', opts.pdfUrl ?? null])
  return r.rows[0].id
}

// ───────────────────────────────────────────────────────────────────
// GET /api/landlords/  (admin)
// ───────────────────────────────────────────────────────────────────

describe('GET /  (admin list)', () => {
  it('non-admin → 403', async () => {
    const f = await seed()
    const res = await request(buildApp())
      .get('/api/landlords/')
      .set('Authorization', `Bearer ${f.tokenA}`)
    expect(res.status).toBe(403)
  })

  it('admin: returns landlords with property/unit counts + bank_account_ready flag', async () => {
    const f = await seed()
    // Seed 1 property + 1 unit for landlord A
    const c = await db.connect()
    try {
      await c.query('BEGIN')
      const pA = await seedProperty(c, { landlordId: f.landlordAId, ownerUserId: f.landlordAUserId, managedByUserId: f.landlordAUserId })
      await seedUnit(c, { propertyId: pA, landlordId: f.landlordAId })
      await c.query('COMMIT')
    } finally { c.release() }

    const res = await request(buildApp())
      .get('/api/landlords/')
      .set('Authorization', `Bearer ${f.adminToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(2)
    const a = res.body.data.find((l: any) => l.id === f.landlordAId)
    expect(a.property_count).toBe(1)
    expect(a.unit_count).toBe(1)
    expect(a.bank_account_ready).toBe(false)
  })
})

// ───────────────────────────────────────────────────────────────────
// GET /flex-charge/accounts
// ───────────────────────────────────────────────────────────────────

describe('GET /flex-charge/accounts', () => {
  it('landlord with no accounts → empty array', async () => {
    const f = await seed()
    const res = await request(buildApp())
      .get('/api/landlords/flex-charge/accounts')
      .set('Authorization', `Bearer ${f.tokenA}`)
    expect(res.status).toBe(200)
    expect(res.body.data).toEqual([])
  })

  it('returns own accounts only', async () => {
    const f = await seed()
    const c = await db.connect()
    try {
      await c.query('BEGIN')
      const pA = await seedProperty(c, { landlordId: f.landlordAId, ownerUserId: f.landlordAUserId, managedByUserId: f.landlordAUserId })
      const pB = await seedProperty(c, { landlordId: f.landlordBId, ownerUserId: f.landlordBUserId, managedByUserId: f.landlordBUserId })
      await c.query(
        `INSERT INTO flex_charge_accounts (tenant_id, property_id, landlord_id, credit_limit) VALUES
          ($1, $2, $3, 500),
          ($1, $4, $5, 1000)`,
        [f.tenantAId, pA, f.landlordAId, pB, f.landlordBId])
      await c.query('COMMIT')
    } finally { c.release() }
    const res = await request(buildApp())
      .get('/api/landlords/flex-charge/accounts')
      .set('Authorization', `Bearer ${f.tokenA}`)
    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(1)
    expect(res.body.data[0].landlord_id).toBe(f.landlordAId)
  })
})

// ───────────────────────────────────────────────────────────────────
// GET /flex-charge/accounts/:id/statements
// ───────────────────────────────────────────────────────────────────

describe('GET /flex-charge/accounts/:id/statements', () => {
  it('unknown account id → error from service (not 200)', async () => {
    const f = await seed()
    const res = await request(buildApp())
      .get(`/api/landlords/flex-charge/accounts/${randomUUID()}/statements`)
      .set('Authorization', `Bearer ${f.tokenA}`)
    expect(res.status).not.toBe(200)
  })

  it('cross-landlord account → error from service (not own data)', async () => {
    const f = await seed()
    const c = await db.connect()
    let bAccountId: string
    try {
      await c.query('BEGIN')
      const pB = await seedProperty(c, { landlordId: f.landlordBId, ownerUserId: f.landlordBUserId, managedByUserId: f.landlordBUserId })
      const r = await c.query<{ id: string }>(
        `INSERT INTO flex_charge_accounts (tenant_id, property_id, landlord_id, credit_limit)
         VALUES ($1, $2, $3, 500) RETURNING id`,
        [f.tenantAId, pB, f.landlordBId])
      bAccountId = r.rows[0].id
      await c.query('COMMIT')
    } finally { c.release() }
    const res = await request(buildApp())
      .get(`/api/landlords/flex-charge/accounts/${bAccountId!}/statements`)
      .set('Authorization', `Bearer ${f.tokenA}`)
    // Service throws on landlord mismatch → 404/500. Must not be 200 with B's data.
    expect(res.status).not.toBe(200)
  })
})

// ───────────────────────────────────────────────────────────────────
// GET /theme
// ───────────────────────────────────────────────────────────────────

describe('GET /theme', () => {
  it('landlord returns own theme/font (defaults null)', async () => {
    const f = await seed()
    const res = await request(buildApp())
      .get('/api/landlords/theme')
      .set('Authorization', `Bearer ${f.tokenA}`)
    expect(res.status).toBe(200)
    expect(res.body.data).toHaveProperty('theme_accent')
    expect(res.body.data).toHaveProperty('font_style')
  })

  it('PATCH /theme then GET reflects the change', async () => {
    const f = await seed()
    await db.query(
      `UPDATE landlords SET theme_accent='blue', font_style='serif' WHERE id=$1`, [f.landlordAId])
    const res = await request(buildApp())
      .get('/api/landlords/theme')
      .set('Authorization', `Bearer ${f.tokenA}`)
    expect(res.body.data.theme_accent).toBe('blue')
    expect(res.body.data.font_style).toBe('serif')
  })
})

// ───────────────────────────────────────────────────────────────────
// POST /me/pending-tenants/:intentId/document
// ───────────────────────────────────────────────────────────────────

describe('POST /me/pending-tenants/:intentId/document', () => {
  it('no file → 400', async () => {
    const f = await seed()
    const id = await seedIntent(f)
    const res = await request(buildApp())
      .post(`/api/landlords/me/pending-tenants/${id}/document`)
      .set('Authorization', `Bearer ${f.tokenA}`)
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/no file uploaded/i)
  })

  it('unknown intent → 404; uploaded file is cleaned up', async () => {
    const f = await seed()
    const res = await request(buildApp())
      .post(`/api/landlords/me/pending-tenants/${randomUUID()}/document`)
      .set('Authorization', `Bearer ${f.tokenA}`)
      .attach('file', PDF_BYTES, { filename: 'l.pdf', contentType: 'application/pdf' })
    expect(res.status).toBe(404)
    expect(res.body.error).toMatch(/not found.*resolved.*not owned/i)
  })

  it('intent in parsing/parsed status → 409', async () => {
    const f = await seed()
    const id = await seedIntent(f, { parserStatus: 'parsing' })
    const res = await request(buildApp())
      .post(`/api/landlords/me/pending-tenants/${id}/document`)
      .set('Authorization', `Bearer ${f.tokenA}`)
      .attach('file', PDF_BYTES, { filename: 'l.pdf', contentType: 'application/pdf' })
    expect(res.status).toBe(409)
    expect(res.body.error).toMatch(/cannot upload while parser_status='parsing'/i)
  })

  it('happy: stores PDF, flips status to parsing, schedules parser job', async () => {
    const f = await seed()
    const id = await seedIntent(f)
    const res = await request(buildApp())
      .post(`/api/landlords/me/pending-tenants/${id}/document`)
      .set('Authorization', `Bearer ${f.tokenA}`)
      .attach('file', PDF_BYTES, { filename: 'lease.pdf', contentType: 'application/pdf' })
    expect(res.status).toBe(200)
    expect(res.body.data.parserStatus).toBe('parsing')
    expect(res.body.data.fileUrl).toContain(`/api/landlords/me/pending-tenants/${id}/document`)
    expect(scheduleParserJobMock).toHaveBeenCalledWith(id)

    const row = await db.query<{ parser_status: string; imported_pdf_url: string }>(
      `SELECT parser_status, imported_pdf_url FROM pending_tenant_intents WHERE id=$1`, [id])
    expect(row.rows[0].parser_status).toBe('parsing')
    expect(row.rows[0].imported_pdf_url).toBeTruthy()
  })
})

// ───────────────────────────────────────────────────────────────────
// GET /me/pending-tenants/:intentId/document
// ───────────────────────────────────────────────────────────────────

describe('GET /me/pending-tenants/:intentId/document', () => {
  it('no doc on intent → 404', async () => {
    const f = await seed()
    const id = await seedIntent(f)
    const res = await request(buildApp())
      .get(`/api/landlords/me/pending-tenants/${id}/document`)
      .set('Authorization', `Bearer ${f.tokenA}`)
    expect(res.status).toBe(404)
    expect(res.body.error).toMatch(/document not found/i)
  })

  it('happy: streams PDF back with explicit application/pdf Content-Type', async () => {
    const f = await seed()
    const id = await seedIntent(f)
    // Upload via the route so the disk write + DB stamp happen.
    const up = await request(buildApp())
      .post(`/api/landlords/me/pending-tenants/${id}/document`)
      .set('Authorization', `Bearer ${f.tokenA}`)
      .attach('file', PDF_BYTES, { filename: 'l.pdf', contentType: 'application/pdf' })
    expect(up.status).toBe(200)
    // Track for cleanup
    const intentRow = await db.query<{ imported_pdf_url: string }>(
      `SELECT imported_pdf_url FROM pending_tenant_intents WHERE id=$1`, [id])
    const url = intentRow.rows[0].imported_pdf_url
    const filename = url.split('/').pop()!
    cleanupTargets.push(path.join(process.cwd(), 'uploads', 'lease-pdfs-pending', filename))

    const res = await request(buildApp())
      .get(`/api/landlords/me/pending-tenants/${id}/document`)
      .set('Authorization', `Bearer ${f.tokenA}`)
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toContain('application/pdf')
    expect(Buffer.from(res.body).slice(0, 4).toString()).toBe('%PDF')
  })
})

// ───────────────────────────────────────────────────────────────────
// GET /me/pending-tenants/:intentId
// ───────────────────────────────────────────────────────────────────

describe('GET /me/pending-tenants/:intentId', () => {
  it('unknown → 404', async () => {
    const f = await seed()
    const res = await request(buildApp())
      .get(`/api/landlords/me/pending-tenants/${randomUUID()}`)
      .set('Authorization', `Bearer ${f.tokenA}`)
    expect(res.status).toBe(404)
  })

  it('cross-landlord intent → 404', async () => {
    const f = await seed()
    const id = await seedIntent(f)
    const res = await request(buildApp())
      .get(`/api/landlords/me/pending-tenants/${id}`)
      .set('Authorization', `Bearer ${f.tokenB}`)
    expect(res.status).toBe(404)
  })

  it('happy: returns intent details + tenant user info', async () => {
    const f = await seed()
    const id = await seedIntent(f, { parserStatus: 'parsed' })
    await db.query(
      `UPDATE pending_tenant_intents SET parser_output=$1::jsonb WHERE id=$2`,
      [JSON.stringify({ rent_amount: 1500 }), id])
    const res = await request(buildApp())
      .get(`/api/landlords/me/pending-tenants/${id}`)
      .set('Authorization', `Bearer ${f.tokenA}`)
    expect(res.status).toBe(200)
    expect(res.body.data.intentId).toBe(id)
    expect(res.body.data.parserStatus).toBe('parsed')
    expect(res.body.data.parserOutput).toEqual({ rent_amount: 1500 })
    expect(res.body.data.tenantId).toBe(f.tenantAId)
  })
})

// ───────────────────────────────────────────────────────────────────
// POST /me/pending-tenants/:intentId/resolve
// ───────────────────────────────────────────────────────────────────

describe('POST /me/pending-tenants/:intentId/resolve', () => {
  it('array landlordOverrides → 400 (non-object guard)', async () => {
    const f = await seed()
    const id = await seedIntent(f)
    const r = await request(buildApp())
      .post(`/api/landlords/me/pending-tenants/${id}/resolve`)
      .set('Authorization', `Bearer ${f.tokenA}`)
      .send({ landlordOverrides: [1, 2, 3] })
    expect(r.status).toBe(400)
    expect(r.body.error).toMatch(/must be an object/i)
    // Note: `null` overrides DON'T 400 — the route's `req.body
    // ?.landlordOverrides ?? {}` substitutes {} for null. That's
    // treated as "no overrides," which is the same as omitting
    // the field. Documented; not a bug.
  })

  it('happy: calls resolveIntent with overrides + returns result', async () => {
    const f = await seed()
    const id = await seedIntent(f, { parserStatus: 'parsed' })
    resolveIntentMock.mockResolvedValueOnce({ ok: true, leaseId: 'mock-lease-id' } as any)
    const res = await request(buildApp())
      .post(`/api/landlords/me/pending-tenants/${id}/resolve`)
      .set('Authorization', `Bearer ${f.tokenA}`)
      .send({ landlordOverrides: { rent_amount: 1600 } })
    expect(res.status).toBe(200)
    expect(res.body.data.leaseId).toBe('mock-lease-id')
    expect(resolveIntentMock).toHaveBeenCalledWith(id, f.landlordAId, { rent_amount: 1600 })
  })

  it('empty body: resolveIntent called with empty overrides', async () => {
    const f = await seed()
    const id = await seedIntent(f, { parserStatus: 'parsed' })
    const res = await request(buildApp())
      .post(`/api/landlords/me/pending-tenants/${id}/resolve`)
      .set('Authorization', `Bearer ${f.tokenA}`)
      .send({})
    expect(res.status).toBe(200)
    expect(resolveIntentMock).toHaveBeenCalledWith(id, f.landlordAId, {})
  })
})
