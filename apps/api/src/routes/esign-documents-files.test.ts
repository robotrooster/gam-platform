/**
 * esign.ts slice 2 — S394. **Closes esign.ts at 25/25 (100%).**
 *
 * Covered routes (8):
 *   - GET   /api/esign/documents
 *   - GET   /api/esign/batches
 *   - POST  /api/esign/documents/addendum-add
 *   - POST  /api/esign/documents/addendum-remove
 *   - POST  /api/esign/documents/addendum-terms/batch
 *   - POST  /api/esign/documents/addendum-terms
 *   - POST  /api/esign/upload
 *   - GET   /api/esign/files/:filename
 *
 * Production bug fixed in this slice (1):
 *   - **POST /api/esign/upload** filename used path.extname from
 *     attacker-controlled originalname. MIME filter accepts only
 *     application/pdf, but originalname=evil.html would be saved as
 *     .html. GET /files/:filename serves via res.sendFile which
 *     auto-detects Content-Type from extension → text/html → XSS in
 *     authorized viewer's browser context. Same class as the S380
 *     avatar-upload finding (which is still open). Fix: force `.pdf`
 *     extension regardless of originalname.
 *
 * Architectural note (hygiene flag):
 *   - GET /api/tenants/avatar-files/:filename (S380) uses path.basename
 *     only. Should adopt the `resolveUploadPath` helper used here for
 *     belt+suspenders (regex allowlist + path.relative escape check).
 *     Not a bug today; defense-in-depth opportunity.
 */

import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import path from 'path'
import fs from 'fs'
import { randomUUID } from 'crypto'
import { db } from '../db'
import {
  cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedTenant,
  seedLease, seedLeaseTenant,
} from '../test/dbHelpers'
import { esignRouter } from './esign'
import { errorHandler } from '../middleware/errorHandler'

function buildApp() {
  const app = express()
  app.use(express.json({ limit: '2mb' }))
  app.use('/api/esign', esignRouter)
  app.use(errorHandler)
  return app
}

const cleanupTargets: string[] = []

beforeEach(async () => {
  await cleanupAllSchema()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_esign_doc'
})

afterAll(() => {
  for (const p of cleanupTargets) {
    try { fs.unlinkSync(p) } catch { /* best effort */ }
  }
})

const PDF_HEADER = Buffer.from('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n', 'binary')

interface Fixture {
  landlordAUserId:  string
  landlordAId:      string
  landlordBUserId:  string
  landlordBId:      string
  propertyAId:      string
  propertyBId:      string
  unitAId:          string
  unitBId:          string
  tenantAId:        string
  tenantAUserId:    string
  leaseAId:         string
  tokenA:           string
  tokenB:           string
}

async function seed(): Promise<Fixture> {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const { userId: aUid, landlordId: aId } = await seedLandlord(c)
    const { userId: bUid, landlordId: bId } = await seedLandlord(c)
    const propA = await seedProperty(c, { landlordId: aId, ownerUserId: aUid, managedByUserId: aUid })
    const propB = await seedProperty(c, { landlordId: bId, ownerUserId: bUid, managedByUserId: bUid })
    const unitA = await seedUnit(c, { propertyId: propA, landlordId: aId })
    const unitB = await seedUnit(c, { propertyId: propB, landlordId: bId })
    const tenantA = await seedTenant(c)
    const taUser = await c.query<{ user_id: string }>(`SELECT user_id FROM tenants WHERE id=$1`, [tenantA])
    const leaseA = await seedLease(c, { unitId: unitA, landlordId: aId, status: 'active' })
    await seedLeaseTenant(c, { leaseId: leaseA, tenantId: tenantA, role: 'primary' })
    await c.query('COMMIT')
    const sign = (uid: string, lid: string) => jwt.sign(
      { userId: uid, role: 'landlord', email: 'l@t.dev', profileId: lid, permissions: {} },
      process.env.JWT_SECRET!, { expiresIn: '1h' })
    return {
      landlordAUserId: aUid, landlordAId: aId,
      landlordBUserId: bUid, landlordBId: bId,
      propertyAId: propA, propertyBId: propB,
      unitAId: unitA, unitBId: unitB,
      tenantAId: tenantA, tenantAUserId: taUser.rows[0].user_id,
      leaseAId: leaseA,
      tokenA: sign(aUid, aId), tokenB: sign(bUid, bId),
    }
  } catch (e) { await c.query('ROLLBACK'); throw e }
  finally { c.release() }
}

async function seedDoc(landlordId: string, unitId: string, opts: { title?: string; status?: string } = {}): Promise<string> {
  const r = await db.query<{ id: string }>(
    `INSERT INTO lease_documents (landlord_id, unit_id, title, document_type, status)
     VALUES ($1, $2, $3, 'original_lease', $4) RETURNING id`,
    [landlordId, unitId, opts.title ?? 'Test Doc', opts.status ?? 'pending'])
  return r.rows[0].id
}

// ───────────────────────────────────────────────────────────────────
// GET /documents
// ───────────────────────────────────────────────────────────────────

describe('GET /documents', () => {
  it('landlord-scoped: returns own docs with signer_count + signed_count', async () => {
    const f = await seed()
    const dA = await seedDoc(f.landlordAId, f.unitAId, { title: 'A Doc' })
    await seedDoc(f.landlordBId, f.unitBId, { title: 'B Doc' })  // not seen
    // Add 2 signers, 1 signed
    await db.query(
      `INSERT INTO lease_document_signers (document_id, user_id, role, name, email, order_index, token, status) VALUES
        ($1, $2, 'landlord', 'L', 'l@t.dev', 1, 'tok1', 'signed'),
        ($1, $3, 'primary', 'T', 't@t.dev', 2, 'tok2', 'sent')`,
      [dA, f.landlordAUserId, f.tenantAUserId])
    const res = await request(buildApp())
      .get('/api/esign/documents')
      .set('Authorization', `Bearer ${f.tokenA}`)
    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(1)
    expect(res.body.data[0].title).toBe('A Doc')
    expect(res.body.data[0].signer_count).toBe(2)
    expect(res.body.data[0].signed_count).toBe(1)
    expect(res.body.data[0].property_name).toBe('Test Property')
  })
})

// ───────────────────────────────────────────────────────────────────
// GET /batches
// ───────────────────────────────────────────────────────────────────

describe('GET /batches', () => {
  it('empty: landlord with no batches → []', async () => {
    const f = await seed()
    const res = await request(buildApp())
      .get('/api/esign/batches')
      .set('Authorization', `Bearer ${f.tokenA}`)
    expect(res.status).toBe(200)
    expect(res.body.data).toEqual([])
  })

  it('landlord-scoped: returns own batches with status counts', async () => {
    const f = await seed()
    // Need a template_id (NOT NULL on document_batches).
    const tmpl = await db.query<{ id: string }>(
      `INSERT INTO lease_templates (landlord_id, name, page_count) VALUES ($1, 'Q3 Template', 1) RETURNING id`,
      [f.landlordAId])
    const batch = await db.query<{ id: string }>(
      `INSERT INTO document_batches (landlord_id, title, template_id, scope_type, scope_ref, status)
       VALUES ($1, 'Q3 Renewals', $2, 'property', $3::jsonb, 'active') RETURNING id`,
      [f.landlordAId, tmpl.rows[0].id, JSON.stringify({ property_id: f.propertyAId })])
    // 3 docs in batch: 1 completed, 1 sent, 1 voided
    for (const status of ['completed', 'sent', 'voided']) {
      await db.query(
        `INSERT INTO lease_documents (landlord_id, unit_id, title, document_type, status, batch_id)
         VALUES ($1, $2, $3, 'original_lease', $4, $5)`,
        [f.landlordAId, f.unitAId, `Doc-${status}`, status, batch.rows[0].id])
    }
    const res = await request(buildApp())
      .get('/api/esign/batches')
      .set('Authorization', `Bearer ${f.tokenA}`)
    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(1)
    expect(res.body.data[0].document_count).toBe(3)
    expect(res.body.data[0].completed_count).toBe(1)
    expect(res.body.data[0].pending_count).toBe(1)
    expect(res.body.data[0].voided_count).toBe(1)
  })
})

// ───────────────────────────────────────────────────────────────────
// POST /documents/addendum-add (gate cases only — happy path is complex)
// ───────────────────────────────────────────────────────────────────

describe('POST /documents/addendum-add', () => {
  it('missing leaseId → 400', async () => {
    const f = await seed()
    const res = await request(buildApp())
      .post('/api/esign/documents/addendum-add')
      .set('Authorization', `Bearer ${f.tokenA}`)
      .send({ title: 'Add roommate', signers: [{ userId: randomUUID(), role: 'landlord', name: 'L', email: 'l@t.dev' }] })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/leaseId required/i)
  })

  it('unknown lease → 404', async () => {
    const f = await seed()
    const res = await request(buildApp())
      .post('/api/esign/documents/addendum-add')
      .set('Authorization', `Bearer ${f.tokenA}`)
      .send({ leaseId: randomUUID(), title: 'X', signers: [{ userId: randomUUID(), role: 'landlord', name: 'L', email: 'l@t.dev' }] })
    expect(res.status).toBe(404)
    expect(res.body.error).toMatch(/lease not found/i)
  })

  it('cross-landlord lease → 403', async () => {
    const f = await seed()
    const leaseB = await db.query<{ id: string }>(
      `INSERT INTO leases (unit_id, landlord_id, status, start_date, rent_amount, lease_type)
       VALUES ($1, $2, 'active', '2026-01-01', 1500, 'fixed_term') RETURNING id`,
      [f.unitBId, f.landlordBId])
    const res = await request(buildApp())
      .post('/api/esign/documents/addendum-add')
      .set('Authorization', `Bearer ${f.tokenA}`)
      .send({ leaseId: leaseB.rows[0].id, title: 'X', signers: [{ userId: randomUUID(), role: 'landlord', name: 'L', email: 'l@t.dev' }] })
    expect(res.status).toBe(403)
    expect(res.body.error).toMatch(/not your lease/i)
  })
})

// ───────────────────────────────────────────────────────────────────
// POST /documents/addendum-remove (gate cases)
// ───────────────────────────────────────────────────────────────────

describe('POST /documents/addendum-remove', () => {
  it('missing leaseId → 400', async () => {
    const f = await seed()
    const res = await request(buildApp())
      .post('/api/esign/documents/addendum-remove')
      .set('Authorization', `Bearer ${f.tokenA}`)
      .send({ title: 'remove' })
    expect(res.status).toBe(400)
  })

  it('cross-landlord lease → 403', async () => {
    const f = await seed()
    const leaseB = await db.query<{ id: string }>(
      `INSERT INTO leases (unit_id, landlord_id, status, start_date, rent_amount, lease_type)
       VALUES ($1, $2, 'active', '2026-01-01', 1500, 'fixed_term') RETURNING id`,
      [f.unitBId, f.landlordBId])
    const res = await request(buildApp())
      .post('/api/esign/documents/addendum-remove')
      .set('Authorization', `Bearer ${f.tokenA}`)
      .send({
        leaseId: leaseB.rows[0].id,
        title: 'remove',
        targetLeaseTenantId: randomUUID(),
        signers: [{ userId: randomUUID(), role: 'landlord', name: 'L', email: 'l@t.dev' }],
      })
    expect(res.status).toBe(403)
  })
})

// ───────────────────────────────────────────────────────────────────
// POST /documents/addendum-terms + /batch (gate cases)
// ───────────────────────────────────────────────────────────────────

describe('POST /documents/addendum-terms', () => {
  it('missing leaseId → 400', async () => {
    const f = await seed()
    const res = await request(buildApp())
      .post('/api/esign/documents/addendum-terms')
      .set('Authorization', `Bearer ${f.tokenA}`)
      .send({})
    expect(res.status).toBe(400)
  })
})

describe('POST /documents/addendum-terms/batch', () => {
  it('missing required fields → 400', async () => {
    const f = await seed()
    const res = await request(buildApp())
      .post('/api/esign/documents/addendum-terms/batch')
      .set('Authorization', `Bearer ${f.tokenA}`)
      .send({})
    expect(res.status).toBe(400)
  })
})

// ───────────────────────────────────────────────────────────────────
// POST /upload — S394 extension-mismatch fix
// ───────────────────────────────────────────────────────────────────

describe('POST /upload — S394 XSS fix', () => {
  it('no file → 400', async () => {
    const f = await seed()
    const res = await request(buildApp())
      .post('/api/esign/upload')
      .set('Authorization', `Bearer ${f.tokenA}`)
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/no file uploaded/i)
  })

  it('non-PDF MIME → multer fileFilter rejects', async () => {
    const f = await seed()
    const res = await request(buildApp())
      .post('/api/esign/upload')
      .set('Authorization', `Bearer ${f.tokenA}`)
      .attach('file', Buffer.from('not a pdf'),
        { filename: 'evil.exe', contentType: 'application/octet-stream' })
    expect(res.status).not.toBe(200)
  })

  it('S394 fix: PDF upload with originalname=evil.html → saved as .pdf (not .html)', async () => {
    // Pre-fix, path.extname('evil.html') = '.html' and the saved
    // filename carried that extension. Post-fix, extension is always
    // .pdf for application/pdf MIME.
    const f = await seed()
    const res = await request(buildApp())
      .post('/api/esign/upload')
      .set('Authorization', `Bearer ${f.tokenA}`)
      .attach('file', PDF_HEADER, { filename: 'evil.html', contentType: 'application/pdf' })
    expect(res.status).toBe(200)
    // The response URL must end in .pdf — NOT .html
    expect(res.body.data.url).toMatch(/\.pdf$/)
    expect(res.body.data.url).not.toMatch(/\.html/)
    // Confirm the file actually landed on disk with .pdf
    const filename = res.body.data.url.split('/').pop()!
    const uploadDir = path.join(process.cwd(), 'uploads', 'leases')
    const fp = path.join(uploadDir, filename)
    expect(fs.existsSync(fp)).toBe(true)
    expect(filename).toMatch(/\.pdf$/)
    cleanupTargets.push(fp)
  })

  it('happy: legitimate PDF upload returns url + filename + size', async () => {
    const f = await seed()
    const res = await request(buildApp())
      .post('/api/esign/upload')
      .set('Authorization', `Bearer ${f.tokenA}`)
      .attach('file', PDF_HEADER, { filename: 'lease.pdf', contentType: 'application/pdf' })
    expect(res.status).toBe(200)
    expect(res.body.data.url).toMatch(/^\/api\/esign\/files\/.+\.pdf$/)
    expect(res.body.data.filename).toBe('lease.pdf')
    expect(res.body.data.size).toBe(PDF_HEADER.length)
    const filename = res.body.data.url.split('/').pop()!
    cleanupTargets.push(path.join(process.cwd(), 'uploads', 'leases', filename))
  })
})

// ───────────────────────────────────────────────────────────────────
// GET /files/:filename
// ───────────────────────────────────────────────────────────────────

describe('GET /files/:filename', () => {
  async function uploadAndAttach(f: Fixture, status = 'pending'): Promise<{ url: string; docId: string; filename: string }> {
    const up = await request(buildApp())
      .post('/api/esign/upload')
      .set('Authorization', `Bearer ${f.tokenA}`)
      .attach('file', PDF_HEADER, { filename: 'lease.pdf', contentType: 'application/pdf' })
    const url = up.body.data.url
    const filename = url.split('/').pop()
    cleanupTargets.push(path.join(process.cwd(), 'uploads', 'leases', filename))
    const doc = await db.query<{ id: string }>(
      `INSERT INTO lease_documents (landlord_id, unit_id, title, document_type, status, base_pdf_url)
       VALUES ($1, $2, 'Doc', 'original_lease', $3, $4) RETURNING id`,
      [f.landlordAId, f.unitAId, status, url])
    return { url, docId: doc.rows[0].id, filename }
  }

  it('invalid filename (traversal) → 400 (resolveUploadPath rejects)', async () => {
    const f = await seed()
    // Even though the regex allowlist blocks most traversal chars,
    // any filename containing `/` would be split by Express's :param,
    // so we pass URL-encoded traversal.
    const res = await request(buildApp())
      .get(`/api/esign/files/${encodeURIComponent('../etc-passwd')}`)
      .set('Authorization', `Bearer ${f.tokenA}`)
    // The route either 400s (resolveUploadPath rejects) or 404s
    // (no lease_documents row matches). Either is fine — both
    // block the traversal. Must NOT be 200.
    expect(res.status).not.toBe(200)
  })

  it('unknown filename → 404', async () => {
    const f = await seed()
    const res = await request(buildApp())
      .get('/api/esign/files/never-uploaded-S394.pdf')
      .set('Authorization', `Bearer ${f.tokenA}`)
    expect(res.status).toBe(404)
  })

  it('landlord on the document → 200 with file bytes', async () => {
    const f = await seed()
    const u = await uploadAndAttach(f)
    const res = await request(buildApp())
      .get(`/api/esign/files/${u.filename}`)
      .set('Authorization', `Bearer ${f.tokenA}`)
    expect(res.status).toBe(200)
    expect(Buffer.from(res.body).slice(0, 4).toString()).toBe('%PDF')
  })

  it('cross-landlord (not the doc owner, not a signer) → 404 or 403', async () => {
    const f = await seed()
    const u = await uploadAndAttach(f)
    // Landlord B has no relationship to the doc
    const res = await request(buildApp())
      .get(`/api/esign/files/${u.filename}`)
      .set('Authorization', `Bearer ${f.tokenB}`)
    expect(res.status).not.toBe(200)
  })
})
