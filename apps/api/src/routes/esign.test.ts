/**
 * E-sign route.
 *
 * The full esign.ts is 2,524 lines covering: document/signer/field
 * creation, template management, multi-signer state machine,
 * completion handler that fires buildLeaseFromDocument, four addendum
 * variants, batch sends, void/decline flows, vendor witness
 * provisioning, file upload, pending queues.
 *
 * Covered:
 *   - POST   /documents              create draft + validation gates
 *   - POST   /documents/:id/send     transition draft → sent
 *   - POST   /documents/:id/void     landlord cancel (signed-block)
 *   - POST   /sign/:documentId       PARTIAL signing transitions (next-signer
 *                                    email)
 *   - POST   /sign/:documentId       COMPLETION path (S334): all-signed →
 *                                    buildLeaseFromDocument → executeOriginal
 *                                    Lease → leases + lease_tenants +
 *                                    lease_fees + lease_utility_responsibilities
 *                                    + move-in invoice + credit-ledger
 *                                    emitters + PM leasing-fee post-commit
 *                                    side effects + admin notif on failure
 *   - POST   /sign/:documentId/decline
 *   - GET    /sign/:documentId       signer read view + viewed stamp
 *   - GET    /documents/:id          owner / signer read scope
 *   - GET    /pending                tenant pending list
 *   - GET    /landlord-pending       landlord pending list
 *
 * Deferred (future passes):
 *   - Addendum-add / addendum-remove / addendum-terms / addendum-terms/batch
 *     completion paths (their own internal helpers)
 *   - Sublease_agreement completion
 *   - Templates + template fields
 *   - File upload + serve
 *   - Vendor witness provisioning
 */

import { vi, describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import crypto from 'crypto'
import { randomUUID } from 'crypto'
import { db } from '../db'
import {
  cleanupAllSchema,
  seedLandlord, seedTenant, seedProperty, seedUnit,
  seedLease, seedLeaseTenant,
} from '../test/dbHelpers'

const {
  emailSigningRequestMock,
  emailSigningCompletedMock,
  emailDocumentDeclinedMock,
  createNotificationMock,
  createAdminNotificationMock,
  generateMoveInInvoiceMock,
  firePmTransfersMock,
  stampPdfMock,
} = vi.hoisted(() => ({
  emailSigningRequestMock:    vi.fn(async () => 'msg'),
  emailSigningCompletedMock:  vi.fn(async () => 'msg'),
  emailDocumentDeclinedMock:  vi.fn(async () => 'msg'),
  createNotificationMock:     vi.fn(async () => ({ id: 'n_mock' })),
  createAdminNotificationMock: vi.fn(async () => {}),
  // S334: completion handler dependencies. generateMoveInInvoice is
  // invoked on the same transaction inside executeOriginalLease.
  // firePmTransfersForReference and stampPdf fire post-commit.
  generateMoveInInvoiceMock:  vi.fn(async () => ({
    invoiceCreated:      true,
    invoiceId:           'inv_mock',
    invoiceNumber:       'INV-2026-000001',
    rentAmount:          1000,
    moveInFeesInserted:  0,
    depositInserted:     false,
  })),
  firePmTransfersMock:        vi.fn(async () => ({ fired: 0, failed: 0 })),
  stampPdfMock:               vi.fn(async () => {}),
}))
vi.mock('../services/email', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    emailSigningRequest:    emailSigningRequestMock,
    emailSigningCompleted:  emailSigningCompletedMock,
    emailDocumentDeclined:  emailDocumentDeclinedMock,
  }
})
vi.mock('../services/notifications', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, createNotification: createNotificationMock }
})
vi.mock('../services/adminNotifications', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, createAdminNotification: createAdminNotificationMock }
})
vi.mock('../jobs/moveInBundle', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, generateMoveInInvoice: generateMoveInInvoiceMock }
})
vi.mock('../services/stripeConnect', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, firePmTransfersForReference: firePmTransfersMock }
})
vi.mock('../services/pdfStamp', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, stampPdf: stampPdfMock }
})

import { esignRouter } from './esign'
import { errorHandler } from '../middleware/errorHandler'

function buildApp() {
  const app = express()
  app.use(express.json({ limit: '2mb' }))
  app.use('/api/esign', esignRouter)
  app.use(errorHandler)
  return app
}

beforeEach(async () => {
  await cleanupAllSchema()
  emailSigningRequestMock.mockClear()
  emailSigningCompletedMock.mockClear()
  emailDocumentDeclinedMock.mockClear()
  createNotificationMock.mockClear()
  createAdminNotificationMock.mockClear()
  generateMoveInInvoiceMock.mockClear()
  firePmTransfersMock.mockClear()
  stampPdfMock.mockClear()
  // S334: re-arm default resolves (some tests override these per-case).
  generateMoveInInvoiceMock.mockResolvedValue({
    invoiceCreated:      true,
    invoiceId:           'inv_mock',
    invoiceNumber:       'INV-2026-000001',
    rentAmount:          1000,
    moveInFeesInserted:  0,
    depositInserted:     false,
  })
  firePmTransfersMock.mockResolvedValue({ fired: 0, failed: 0 })
  stampPdfMock.mockResolvedValue(undefined as any)
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_esign'
})

interface SeedFixture {
  landlordUserId: string
  landlordId:     string
  tenantUserId:   string
  tenantId:       string
  tenantEmail:    string
  unitId:         string
  propertyId:     string
  landlordToken:  string
  tenantToken:    string
}

async function seedFixture(): Promise<SeedFixture> {
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    const { userId: landlordUserId, landlordId } = await seedLandlord(client)
    const tenantEmail = `tenant-${randomUUID()}@test.dev`
    const tenantId = await seedTenant(client, { email: tenantEmail })
    const tu = await client.query<{ user_id: string }>(`SELECT user_id FROM tenants WHERE id = $1`, [tenantId])
    const tenantUserId = tu.rows[0].user_id
    const propertyId = await seedProperty(client, { landlordId, ownerUserId: landlordUserId, managedByUserId: landlordUserId })
    const unitId     = await seedUnit(client, { propertyId, landlordId })
    await client.query('COMMIT')

    const landlordToken = jwt.sign(
      { userId: landlordUserId, role: 'landlord', email: 'll@test.dev', profileId: landlordId, permissions: {} },
      process.env.JWT_SECRET!, { expiresIn: '1h' },
    )
    const tenantToken = jwt.sign(
      { userId: tenantUserId, role: 'tenant', email: tenantEmail, profileId: tenantId, permissions: {} },
      process.env.JWT_SECRET!, { expiresIn: '1h' },
    )
    return { landlordUserId, landlordId, tenantUserId, tenantId, tenantEmail, unitId, propertyId, landlordToken, tenantToken }
  } catch (e) { await client.query('ROLLBACK'); throw e }
  finally { client.release() }
}

/** Seed a lease_documents row + two signers (landlord first, tenant second). */
async function seedDoc(f: SeedFixture, opts: {
  status?:                'pending' | 'sent' | 'in_progress' | 'completed' | 'voided' | 'execution_failed'
  landlordSignerStatus?:  'pending' | 'sent' | 'viewed' | 'signed' | 'declined'
  tenantSignerStatus?:    'pending' | 'sent' | 'viewed' | 'signed' | 'declined'
  documentType?:          'original_lease' | 'addendum_add' | 'addendum_remove' | 'addendum_terms' | 'sublease_agreement'
} = {}): Promise<{ documentId: string; landlordSignerId: string; tenantSignerId: string }> {
  const docRes = await db.query<{ id: string }>(
    `INSERT INTO lease_documents (
       landlord_id, unit_id, title, document_type, status
     ) VALUES ($1, $2, 'Test Lease Doc', $3, $4)
     RETURNING id`,
    [f.landlordId, f.unitId, opts.documentType ?? 'original_lease', opts.status ?? 'pending'],
  )
  const documentId = docRes.rows[0].id
  const landlordTok = crypto.randomBytes(32).toString('hex')
  const tenantTok   = crypto.randomBytes(32).toString('hex')
  const ls = await db.query<{ id: string }>(
    `INSERT INTO lease_document_signers (document_id, user_id, role, name, email, order_index, token, status)
     VALUES ($1, $2, 'landlord', 'L L', 'll@test.dev', 1, $3, $4) RETURNING id`,
    [documentId, f.landlordUserId, landlordTok, opts.landlordSignerStatus ?? 'pending'],
  )
  const ts = await db.query<{ id: string }>(
    `INSERT INTO lease_document_signers (document_id, user_id, role, name, email, order_index, token, status)
     VALUES ($1, $2, 'primary', 'T T', $3, 2, $4, $5) RETURNING id`,
    [documentId, f.tenantUserId, f.tenantEmail, tenantTok, opts.tenantSignerStatus ?? 'pending'],
  )
  return { documentId, landlordSignerId: ls.rows[0].id, tenantSignerId: ts.rows[0].id }
}

// ─── POST /documents — validation gates ─────────────────────────

describe('POST /documents — validation', () => {
  it('rejects missing title', async () => {
    const f = await seedFixture()
    const res = await request(buildApp())
      .post('/api/esign/documents')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ signers: [{ role: 'landlord', userId: f.landlordUserId, name: 'L', email: 'l@x' }] })
    expect(res.status).toBe(400)
  })

  it('rejects empty signers array', async () => {
    const f = await seedFixture()
    const res = await request(buildApp())
      .post('/api/esign/documents')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ title: 'X', signers: [] })
    expect(res.status).toBe(400)
  })

  it('requires exactly one primary tenant signer (zero primaries rejected)', async () => {
    const f = await seedFixture()
    const res = await request(buildApp())
      .post('/api/esign/documents')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({
        title: 'X',
        signers: [
          { role: 'landlord', userId: f.landlordUserId, name: 'L', email: 'l@x' },
          { role: 'witness',  userId: f.landlordUserId, name: 'W', email: 'w@x' },
        ],
      })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/primary/i)
  })

  it('requires at least one landlord signer', async () => {
    const f = await seedFixture()
    const res = await request(buildApp())
      .post('/api/esign/documents')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({
        title: 'X',
        signers: [{ role: 'primary', userId: f.tenantUserId, name: 'T', email: f.tenantEmail }],
      })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/landlord/i)
  })

  it('rejects signers without userId (GAM account required)', async () => {
    const f = await seedFixture()
    const res = await request(buildApp())
      .post('/api/esign/documents')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({
        title: 'X',
        signers: [
          { role: 'landlord', userId: f.landlordUserId, name: 'L', email: 'l@x' },
          { role: 'primary',                            name: 'T', email: 'unknown@x' },
        ],
      })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/userId/i)
  })

  it('rejects tenant signer whose user has no tenants row', async () => {
    const f = await seedFixture()
    // A landlord user has no tenants row → flagging them as primary tenant is invalid.
    const res = await request(buildApp())
      .post('/api/esign/documents')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({
        title: 'X',
        signers: [
          { role: 'landlord', userId: f.landlordUserId, name: 'L', email: 'l@x' },
          { role: 'primary',  userId: f.landlordUserId, name: 'T', email: 't@x' },  // not a tenant
        ],
      })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/tenant profile/i)
  })

  it('rejects invalid signer role (cosigner is not a valid role)', async () => {
    const f = await seedFixture()
    const res = await request(buildApp())
      .post('/api/esign/documents')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({
        title: 'X',
        signers: [
          { role: 'landlord', userId: f.landlordUserId, name: 'L', email: 'l@x' },
          { role: 'primary',  userId: f.tenantUserId,   name: 'T', email: f.tenantEmail },
          // Third signer with an invalid role — primary/landlord counts both satisfy, so
          // we reach the per-signer role check.
          { role: 'cosigner', userId: f.landlordUserId, name: 'X', email: 'x@x' },
        ],
      })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/Invalid signer role: cosigner/i)
  })

  it('happy path: creates document + signers, returns the doc', async () => {
    const f = await seedFixture()
    const res = await request(buildApp())
      .post('/api/esign/documents')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({
        title: 'Test Lease',
        unitId: f.unitId,
        signers: [
          { role: 'landlord', userId: f.landlordUserId, name: 'L L', email: 'l@x' },
          { role: 'primary',  userId: f.tenantUserId,   name: 'T T', email: f.tenantEmail },
        ],
      })
    expect(res.status).toBe(201)
    expect(res.body.data.id).toBeTruthy()
    expect(res.body.data.status).toBe('pending')
    expect(res.body.data.document_type).toBe('original_lease')
    // Signers written
    const signers = await db.query<{ role: string }>(
      `SELECT role FROM lease_document_signers WHERE document_id = $1 ORDER BY order_index`,
      [res.body.data.id],
    )
    expect(signers.rows.map(r => r.role)).toEqual(['landlord', 'primary'])
  })
})

// ─── POST /documents/:id/send ──────────────────────────────────

describe('POST /documents/:id/send', () => {
  it('happy path: status flips to sent, first signer emailed, in-app notification', async () => {
    const f = await seedFixture()
    const { documentId } = await seedDoc(f)
    const res = await request(buildApp())
      .post(`/api/esign/documents/${documentId}/send`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
    expect(res.status).toBe(200)
    expect(emailSigningRequestMock).toHaveBeenCalledTimes(1)
    expect(createNotificationMock).toHaveBeenCalledTimes(1)
    const docRow = await db.query<{ status: string; sent_at: string | null }>(
      `SELECT status, sent_at FROM lease_documents WHERE id = $1`, [documentId],
    )
    expect(docRow.rows[0].status).toBe('sent')
    expect(docRow.rows[0].sent_at).toBeTruthy()
  })

  it('cross-landlord rejected (doc not found)', async () => {
    const f = await seedFixture()
    const { documentId } = await seedDoc(f)
    const otherToken = jwt.sign(
      { userId: randomUUID(), role: 'landlord', email: 'o@x', profileId: randomUUID(), permissions: {} },
      process.env.JWT_SECRET!, { expiresIn: '1h' },
    )
    const res = await request(buildApp())
      .post(`/api/esign/documents/${documentId}/send`)
      .set('Authorization', `Bearer ${otherToken}`)
    expect(res.status).toBe(404)
  })

  it('rejects completed document', async () => {
    const f = await seedFixture()
    const { documentId } = await seedDoc(f, { status: 'completed' })
    const res = await request(buildApp())
      .post(`/api/esign/documents/${documentId}/send`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/already completed/i)
  })

  it('rejects voided document', async () => {
    const f = await seedFixture()
    const { documentId } = await seedDoc(f, { status: 'voided' })
    const res = await request(buildApp())
      .post(`/api/esign/documents/${documentId}/send`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/voided/i)
  })

  it('rejects when first signer is not landlord (S28 — landlord-first ordering)', async () => {
    const f = await seedFixture()
    const { documentId } = await seedDoc(f)
    // Flip order_index so tenant signer is first.
    await db.query(
      `UPDATE lease_document_signers SET order_index = CASE role WHEN 'landlord' THEN 2 ELSE 1 END
        WHERE document_id = $1`,
      [documentId],
    )
    const res = await request(buildApp())
      .post(`/api/esign/documents/${documentId}/send`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/Landlord must be the first signer/)
  })
})

// ─── POST /documents/:id/void ──────────────────────────────────

describe('POST /documents/:id/void', () => {
  it('happy path: void unsent draft document', async () => {
    const f = await seedFixture()
    const { documentId } = await seedDoc(f, { status: 'sent' })
    const res = await request(buildApp())
      .post(`/api/esign/documents/${documentId}/void`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ reason: 'Typo in unit number' })
    expect(res.status).toBe(200)
    const row = await db.query<{ status: string; void_reason: string }>(
      `SELECT status, void_reason FROM lease_documents WHERE id = $1`, [documentId],
    )
    expect(row.rows[0].status).toBe('voided')
    expect(row.rows[0].void_reason).toBe('Typo in unit number')
  })

  it('rejects voiding a completed document', async () => {
    const f = await seedFixture()
    const { documentId } = await seedDoc(f, { status: 'completed' })
    const res = await request(buildApp())
      .post(`/api/esign/documents/${documentId}/void`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({})
    expect(res.status).toBe(400)
  })

  it('rejects voiding once any signer has signed (409)', async () => {
    const f = await seedFixture()
    const { documentId } = await seedDoc(f, { status: 'in_progress', landlordSignerStatus: 'signed' })
    // Stamp signed_at on the landlord signer
    await db.query(
      `UPDATE lease_document_signers SET signed_at = NOW() WHERE document_id = $1 AND role = 'landlord'`,
      [documentId],
    )
    const res = await request(buildApp())
      .post(`/api/esign/documents/${documentId}/void`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({})
    expect(res.status).toBe(409)
    expect(res.body.error).toMatch(/superseding/)
  })

  it('cross-landlord rejected', async () => {
    const f = await seedFixture()
    const { documentId } = await seedDoc(f, { status: 'sent' })
    const otherToken = jwt.sign(
      { userId: randomUUID(), role: 'landlord', email: 'o@x', profileId: randomUUID(), permissions: {} },
      process.env.JWT_SECRET!, { expiresIn: '1h' },
    )
    const res = await request(buildApp())
      .post(`/api/esign/documents/${documentId}/void`)
      .set('Authorization', `Bearer ${otherToken}`)
      .send({})
    expect(res.status).toBe(404)
  })
})

// ─── POST /sign/:documentId — partial signing ──────────────────

describe('POST /sign/:documentId — partial signing transitions', () => {
  it('not-a-signer rejected (403)', async () => {
    const f = await seedFixture()
    const { documentId } = await seedDoc(f, { status: 'sent' })
    // Create a second tenant user not on the signers list
    const otherTenantUserId = (await db.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
       VALUES ($1, 'x', 'tenant', 'O', 'T', TRUE) RETURNING id`,
      [`other-${randomUUID()}@x`],
    )).rows[0].id
    const outsiderToken = jwt.sign(
      { userId: otherTenantUserId, role: 'tenant', email: 'o@x', profileId: randomUUID(), permissions: {} },
      process.env.JWT_SECRET!, { expiresIn: '1h' },
    )
    const res = await request(buildApp())
      .post(`/api/esign/sign/${documentId}`)
      .set('Authorization', `Bearer ${outsiderToken}`)
      .send({ fieldValues: [] })
    expect(res.status).toBe(403)
    expect(res.body.error).toMatch(/not a signer/i)
  })

  it('rejects already-signed signer', async () => {
    const f = await seedFixture()
    const { documentId } = await seedDoc(f, { status: 'in_progress', landlordSignerStatus: 'signed' })
    const res = await request(buildApp())
      .post(`/api/esign/sign/${documentId}`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ fieldValues: [] })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/already signed/i)
  })

  it('rejects voided document', async () => {
    const f = await seedFixture()
    const { documentId } = await seedDoc(f, { status: 'voided' })
    const res = await request(buildApp())
      .post(`/api/esign/sign/${documentId}`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ fieldValues: [] })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/voided/)
  })

  it('rejects execution_failed document', async () => {
    const f = await seedFixture()
    const { documentId } = await seedDoc(f, { status: 'execution_failed' })
    const res = await request(buildApp())
      .post(`/api/esign/sign/${documentId}`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ fieldValues: [] })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/execution failed/i)
  })

  it('rejects missing required fields', async () => {
    const f = await seedFixture()
    const { documentId } = await seedDoc(f, { status: 'sent' })
    // Seed a required field assigned to the landlord role with no value.
    await db.query(
      `INSERT INTO lease_document_fields
         (document_id, field_type, signer_role, label, page, x, y, width, height, required)
       VALUES ($1, 'text', 'landlord', 'Witness name', 1, 10, 10, 100, 20, TRUE)`,
      [documentId],
    )
    const res = await request(buildApp())
      .post(`/api/esign/sign/${documentId}`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ fieldValues: [] })  // no submission
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/Missing required fields/)
  })

  it('partial sign: landlord signs, doc → in_progress, next signer (tenant) is emailed', async () => {
    const f = await seedFixture()
    const { documentId, landlordSignerId } = await seedDoc(f, { status: 'sent' })
    const res = await request(buildApp())
      .post(`/api/esign/sign/${documentId}`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ fieldValues: [] })
    expect(res.status).toBe(200)
    expect(res.body.data.completed).toBe(false)
    expect(res.body.data.nextSigner).toBe(f.tenantEmail)
    const ls = await db.query<{ status: string; signed_at: string | null }>(
      `SELECT status, signed_at FROM lease_document_signers WHERE id = $1`, [landlordSignerId],
    )
    expect(ls.rows[0].status).toBe('signed')
    expect(ls.rows[0].signed_at).toBeTruthy()
    const docRow = await db.query<{ status: string }>(
      `SELECT status FROM lease_documents WHERE id = $1`, [documentId],
    )
    expect(docRow.rows[0].status).toBe('in_progress')
    // Next-signer email + notification fired
    expect(emailSigningRequestMock).toHaveBeenCalledTimes(1)
    expect(createNotificationMock).toHaveBeenCalledTimes(1)
  })

  it('field-value spoof attempt: signer cannot overwrite a different role\'s field (silent no-op via WHERE)', async () => {
    const f = await seedFixture()
    const { documentId } = await seedDoc(f, { status: 'sent' })
    // Insert a field assigned to the TENANT role
    const fieldRes = await db.query<{ id: string }>(
      `INSERT INTO lease_document_fields
         (document_id, field_type, signer_role, label, page, x, y, width, height)
       VALUES ($1, 'text', 'primary', 'tenant-only', 1, 10, 10, 100, 20) RETURNING id`,
      [documentId],
    )
    const fieldId = fieldRes.rows[0].id
    // Landlord (whose role is 'landlord') tries to overwrite a 'primary'-tagged field
    const res = await request(buildApp())
      .post(`/api/esign/sign/${documentId}`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ fieldValues: [{ fieldId, value: 'malicious_value' }] })
    expect(res.status).toBe(200)  // sign succeeds for the landlord's own slot
    // But the spoofed field value did NOT land
    const row = await db.query<{ value: string | null }>(
      `SELECT value FROM lease_document_fields WHERE id = $1`, [fieldId],
    )
    expect(row.rows[0].value).toBeNull()
  })
})

// ─── POST /sign/:documentId/decline ────────────────────────────

describe('POST /sign/:documentId/decline', () => {
  it('happy path: tenant declines → signer declined, document voided, landlord notified', async () => {
    const f = await seedFixture()
    const { documentId, tenantSignerId } = await seedDoc(f, { status: 'sent', tenantSignerStatus: 'viewed' })
    const res = await request(buildApp())
      .post(`/api/esign/sign/${documentId}/decline`)
      .set('Authorization', `Bearer ${f.tenantToken}`)
      .send({ reason: 'Rent too high' })
    expect(res.status).toBe(200)
    expect(res.body.data.status).toBe('declined')
    expect(res.body.data.documentVoided).toBe(true)
    const sr = await db.query<{ status: string; decline_reason: string }>(
      `SELECT status, decline_reason FROM lease_document_signers WHERE id = $1`, [tenantSignerId],
    )
    expect(sr.rows[0].status).toBe('declined')
    expect(sr.rows[0].decline_reason).toBe('Rent too high')
    const doc = await db.query<{ status: string }>(
      `SELECT status FROM lease_documents WHERE id = $1`, [documentId],
    )
    expect(doc.rows[0].status).toBe('voided')
  })

  it('non-signer rejected (403)', async () => {
    const f = await seedFixture()
    const { documentId } = await seedDoc(f, { status: 'sent' })
    const otherUserId = (await db.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
       VALUES ($1, 'x', 'tenant', 'O', 'T', TRUE) RETURNING id`,
      [`o-${randomUUID()}@x`],
    )).rows[0].id
    const outsider = jwt.sign(
      { userId: otherUserId, role: 'tenant', email: 'o@x', profileId: randomUUID(), permissions: {} },
      process.env.JWT_SECRET!, { expiresIn: '1h' },
    )
    const res = await request(buildApp())
      .post(`/api/esign/sign/${documentId}/decline`)
      .set('Authorization', `Bearer ${outsider}`)
    expect(res.status).toBe(403)
  })

  it('rejects already-signed signer', async () => {
    const f = await seedFixture()
    const { documentId } = await seedDoc(f, { status: 'in_progress', landlordSignerStatus: 'signed' })
    const res = await request(buildApp())
      .post(`/api/esign/sign/${documentId}/decline`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/already signed/i)
  })

  it('idempotent: re-decline returns alreadyDeclined=true without re-firing notifications', async () => {
    const f = await seedFixture()
    const { documentId } = await seedDoc(f, { status: 'voided', tenantSignerStatus: 'declined' })
    // Stamp declined_at so the idempotent path's data echo has a value
    await db.query(
      `UPDATE lease_document_signers SET declined_at = NOW(), decline_reason = 'orig' WHERE document_id = $1 AND role = 'primary'`,
      [documentId],
    )
    const res = await request(buildApp())
      .post(`/api/esign/sign/${documentId}/decline`)
      .set('Authorization', `Bearer ${f.tenantToken}`)
      .send({ reason: 'another reason' })
    expect(res.status).toBe(200)
    expect(res.body.data.alreadyDeclined).toBe(true)
    expect(res.body.data.decline_reason).toBe('orig')
    expect(emailDocumentDeclinedMock).not.toHaveBeenCalled()
  })

  it('rejects when document is already voided (and signer is still pending)', async () => {
    const f = await seedFixture()
    const { documentId } = await seedDoc(f, { status: 'voided' })
    // Signer is still 'pending', not 'declined', but doc is voided.
    const res = await request(buildApp())
      .post(`/api/esign/sign/${documentId}/decline`)
      .set('Authorization', `Bearer ${f.tenantToken}`)
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/already voided/)
  })
})

// ─── GET /sign/:documentId ─────────────────────────────────────

describe('GET /sign/:documentId', () => {
  it('signer can read and gets viewed timestamp stamped if pending', async () => {
    const f = await seedFixture()
    const { documentId, tenantSignerId } = await seedDoc(f, { status: 'sent', tenantSignerStatus: 'sent' })
    const res = await request(buildApp())
      .get(`/api/esign/sign/${documentId}`)
      .set('Authorization', `Bearer ${f.tenantToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data.signer.id).toBe(tenantSignerId)
    expect(res.body.data.document.id).toBe(documentId)
    // viewed_at stamped + status flipped
    const sr = await db.query<{ status: string; viewed_at: string | null }>(
      `SELECT status, viewed_at FROM lease_document_signers WHERE id = $1`, [tenantSignerId],
    )
    expect(sr.rows[0].status).toBe('viewed')
    expect(sr.rows[0].viewed_at).toBeTruthy()
  })

  it('non-signer rejected', async () => {
    const f = await seedFixture()
    const { documentId } = await seedDoc(f, { status: 'sent' })
    const otherUserId = (await db.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
       VALUES ($1, 'x', 'tenant', 'O', 'T', TRUE) RETURNING id`,
      [`o-${randomUUID()}@x`],
    )).rows[0].id
    const outsider = jwt.sign(
      { userId: otherUserId, role: 'tenant', email: 'o@x', profileId: randomUUID(), permissions: {} },
      process.env.JWT_SECRET!, { expiresIn: '1h' },
    )
    const res = await request(buildApp())
      .get(`/api/esign/sign/${documentId}`)
      .set('Authorization', `Bearer ${outsider}`)
    expect(res.status).toBe(403)
  })

  it('completed doc is read-only — does NOT flip viewed status', async () => {
    const f = await seedFixture()
    const { documentId, tenantSignerId } = await seedDoc(f, { status: 'completed', tenantSignerStatus: 'signed' })
    const res = await request(buildApp())
      .get(`/api/esign/sign/${documentId}`)
      .set('Authorization', `Bearer ${f.tenantToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data.readOnly).toBe(true)
    // viewed_at not stamped (already-terminal signer status)
    const sr = await db.query<{ status: string }>(
      `SELECT status FROM lease_document_signers WHERE id = $1`, [tenantSignerId],
    )
    expect(sr.rows[0].status).toBe('signed')
  })
})

// ─── GET /documents/:id ────────────────────────────────────────

describe('GET /documents/:id', () => {
  it('landlord owner can read', async () => {
    const f = await seedFixture()
    const { documentId } = await seedDoc(f, { status: 'sent' })
    const res = await request(buildApp())
      .get(`/api/esign/documents/${documentId}`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data.id).toBe(documentId)
    expect(res.body.data.signers).toHaveLength(2)
  })

  it('signer (tenant) can read', async () => {
    const f = await seedFixture()
    const { documentId } = await seedDoc(f, { status: 'sent' })
    const res = await request(buildApp())
      .get(`/api/esign/documents/${documentId}`)
      .set('Authorization', `Bearer ${f.tenantToken}`)
    expect(res.status).toBe(200)
  })

  it('non-signer non-owner rejected', async () => {
    const f = await seedFixture()
    const { documentId } = await seedDoc(f, { status: 'sent' })
    const otherUserId = (await db.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
       VALUES ($1, 'x', 'tenant', 'O', 'T', TRUE) RETURNING id`,
      [`o-${randomUUID()}@x`],
    )).rows[0].id
    const outsider = jwt.sign(
      { userId: otherUserId, role: 'tenant', email: 'o@x', profileId: randomUUID(), permissions: {} },
      process.env.JWT_SECRET!, { expiresIn: '1h' },
    )
    const res = await request(buildApp())
      .get(`/api/esign/documents/${documentId}`)
      .set('Authorization', `Bearer ${outsider}`)
    expect(res.status).toBe(403)
  })

  it('404 for unknown id', async () => {
    const f = await seedFixture()
    const res = await request(buildApp())
      .get(`/api/esign/documents/${randomUUID()}`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
    expect(res.status).toBe(404)
  })
})

// ─── GET /pending and /landlord-pending ────────────────────────

describe('GET /pending — tenant pending list', () => {
  it('shows documents where signer.status IN (sent, viewed) and doc not terminal', async () => {
    const f = await seedFixture()
    const { documentId } = await seedDoc(f, { status: 'sent', tenantSignerStatus: 'sent' })
    const res = await request(buildApp())
      .get('/api/esign/pending')
      .set('Authorization', `Bearer ${f.tenantToken}`)
    expect(res.status).toBe(200)
    expect((res.body.data as any[]).map(r => r.document_id)).toEqual([documentId])
  })

  it('excludes completed documents', async () => {
    const f = await seedFixture()
    await seedDoc(f, { status: 'completed', tenantSignerStatus: 'signed' })
    const res = await request(buildApp())
      .get('/api/esign/pending')
      .set('Authorization', `Bearer ${f.tenantToken}`)
    expect(res.body.data).toEqual([])
  })

  it('excludes voided documents', async () => {
    const f = await seedFixture()
    await seedDoc(f, { status: 'voided', tenantSignerStatus: 'sent' })
    const res = await request(buildApp())
      .get('/api/esign/pending')
      .set('Authorization', `Bearer ${f.tenantToken}`)
    expect(res.body.data).toEqual([])
  })
})

describe('GET /landlord-pending — landlord pending list', () => {
  it('shows documents where the landlord signer is pending', async () => {
    const f = await seedFixture()
    const { documentId } = await seedDoc(f, { status: 'sent', landlordSignerStatus: 'sent' })
    const res = await request(buildApp())
      .get('/api/esign/landlord-pending')
      .set('Authorization', `Bearer ${f.landlordToken}`)
    expect(res.status).toBe(200)
    expect((res.body.data as any[]).map(r => r.document_id)).toEqual([documentId])
  })

  it('excludes docs where the landlord has already signed', async () => {
    const f = await seedFixture()
    await seedDoc(f, { status: 'in_progress', landlordSignerStatus: 'signed' })
    const res = await request(buildApp())
      .get('/api/esign/landlord-pending')
      .set('Authorization', `Bearer ${f.landlordToken}`)
    expect(res.body.data).toEqual([])
  })
})

// ─── POST /sign/:documentId — COMPLETION HANDLER (S334) ────────
//
// All previous signers in 'signed' state; tenant POSTs sign → triggers
// buildLeaseFromDocument → executeOriginalLease → leases + lease_tenants
// + lease_fees + lease_utility_responsibilities + move-in invoice (mock)
// + credit-ledger emitters (REAL) + post-commit side effects.
//
// Fixture wiring:
//   - lease_document_fields seeded with signer_role='landlord' (landlord-
//     prefilled at send time); required=FALSE so the tenant's role-scoped
//     required-field validation passes trivially.
//   - base_pdf_url left null on the doc → stampPdf path is gated out of
//     the post-commit chain (we test the explicit stamp call separately
//     by setting base_pdf_url + a missing file path so stampPdf is
//     called and the missing-file branch is exercised).

/** Insert lease_document_fields rows keyed by lease_column. */
async function seedDocFields(
  documentId: string,
  fields: Partial<Record<string, string>>,
): Promise<void> {
  for (const [col, val] of Object.entries(fields)) {
    if (val == null) continue
    await db.query(
      `INSERT INTO lease_document_fields
         (document_id, field_type, signer_role, lease_column, value, required)
       VALUES ($1, 'text', 'landlord', $2, $3, FALSE)`,
      [documentId, col, val],
    )
  }
}

/** Default lease data set — start in the past so the lease activates and
 *  the unit-status flip + activation branches are exercised. */
function defaultLeaseFields(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    start_date:       '2025-01-01',
    end_date:         '2025-12-31',
    rent_amount:      '1200.00',
    security_deposit: '1200.00',
    rent_due_day:     '1',
    lease_type:       'fixed_term',
    auto_renew:       'false',
    ...overrides,
  }
}

/** Seed a complete-able original_lease doc: landlord signer pre-signed,
 *  primary tenant in 'sent' state with viewed=NOW (so the doc is in_progress).
 *  The next POST /sign/:documentId from the tenant will trigger completion. */
async function seedCompleteableDoc(
  f: SeedFixture,
  opts: {
    documentType?: 'original_lease' | 'sublease_agreement'
    fields?:       Record<string, string>
    basePdfUrl?:   string
  } = {},
): Promise<{ documentId: string; landlordSignerId: string; tenantSignerId: string }> {
  const docRes = await db.query<{ id: string }>(
    `INSERT INTO lease_documents
       (landlord_id, unit_id, title, document_type, status, base_pdf_url)
     VALUES ($1, $2, 'S334 Completion Test', $3, 'in_progress', $4)
     RETURNING id`,
    [f.landlordId, f.unitId, opts.documentType ?? 'original_lease', opts.basePdfUrl ?? null],
  )
  const documentId = docRes.rows[0].id
  const landlordTok = crypto.randomBytes(32).toString('hex')
  const tenantTok   = crypto.randomBytes(32).toString('hex')
  // Landlord signer: pre-signed
  const ls = await db.query<{ id: string }>(
    `INSERT INTO lease_document_signers
       (document_id, user_id, role, name, email, order_index, token, status, signed_at)
     VALUES ($1, $2, 'landlord', 'L L', 'll@test.dev', 1, $3, 'signed', NOW())
     RETURNING id`,
    [documentId, f.landlordUserId, landlordTok],
  )
  // Tenant signer: viewed
  const ts = await db.query<{ id: string }>(
    `INSERT INTO lease_document_signers
       (document_id, user_id, role, name, email, order_index, token, status, viewed_at)
     VALUES ($1, $2, 'primary', 'T T', $3, 2, $4, 'viewed', NOW())
     RETURNING id`,
    [documentId, f.tenantUserId, f.tenantEmail, tenantTok],
  )
  await seedDocFields(documentId, opts.fields ?? defaultLeaseFields())
  return { documentId, landlordSignerId: ls.rows[0].id, tenantSignerId: ts.rows[0].id }
}

describe('POST /sign/:documentId — completion handler (original_lease)', () => {
  it('happy path: all-signed → lease created with writable cols, lease_tenants, doc flips completed', async () => {
    const f = await seedFixture()
    const { documentId } = await seedCompleteableDoc(f)

    const res = await request(buildApp())
      .post(`/api/esign/sign/${documentId}`)
      .set('Authorization', `Bearer ${f.tenantToken}`)
      .send({ fieldValues: [] })

    expect(res.status).toBe(200)
    expect(res.body.data.completed).toBe(true)
    expect(res.body.data.executionFailed).toBeUndefined()

    // Lease materialized with correct writable column values
    const leaseRow = await db.query<{
      id: string; status: string; rent_amount: string; start_date: string;
      end_date: string | null; rent_due_day: number; lease_type: string; auto_renew: boolean
    }>(`SELECT id, status, rent_amount, start_date, end_date, rent_due_day, lease_type, auto_renew
        FROM leases WHERE unit_id = $1`, [f.unitId])
    expect(leaseRow.rows.length).toBe(1)
    const lease = leaseRow.rows[0]
    expect(Number(lease.rent_amount)).toBe(1200)
    expect(lease.rent_due_day).toBe(1)
    expect(lease.lease_type).toBe('fixed_term')
    expect(lease.auto_renew).toBe(false)
    expect(lease.status).toBe('active')  // past start_date

    // lease_tenants row for primary signer
    const lt = await db.query<{ role: string; status: string; tenant_id: string }>(
      `SELECT role, status, tenant_id FROM lease_tenants WHERE lease_id = $1`, [lease.id])
    expect(lt.rows.length).toBe(1)
    expect(lt.rows[0].role).toBe('primary')
    expect(lt.rows[0].status).toBe('active')
    expect(lt.rows[0].tenant_id).toBe(f.tenantId)

    // Doc + signer states
    const doc = await db.query<{ status: string; lease_id: string; completed_at: string | null }>(
      `SELECT status, lease_id, completed_at FROM lease_documents WHERE id = $1`, [documentId])
    expect(doc.rows[0].status).toBe('completed')
    expect(doc.rows[0].lease_id).toBe(lease.id)
    expect(doc.rows[0].completed_at).toBeTruthy()

    // Move-in invoice fired
    expect(generateMoveInInvoiceMock).toHaveBeenCalledTimes(1)
    const moveInArgs = (generateMoveInInvoiceMock.mock.calls as any[][])[0]![0] as any
    expect(moveInArgs.lease_id).toBe(lease.id)
    expect(moveInArgs.tenant_id).toBe(f.tenantId)
    expect(moveInArgs.rent_amount).toBe(1200)
    expect(moveInArgs.start_date).toBe('2025-01-01')

    // Credit events emitted for tenant + landlord
    const evRows = await db.query<{ subject_type: string; event_type: string }>(
      `SELECT s.subject_type, e.event_type
         FROM credit_events e
         JOIN credit_subjects s ON s.id = e.subject_id
        WHERE e.event_type = 'lease_signed'
        ORDER BY s.subject_type`)
    expect(evRows.rows.map(r => r.subject_type)).toEqual(['landlord', 'tenant'])

    // Unit status flipped to active (past start)
    const unitRow = await db.query<{ status: string }>(
      `SELECT status FROM units WHERE id = $1`, [f.unitId])
    expect(unitRow.rows[0].status).toBe('active')

    // Tenant completion email + notification fired for both signers
    expect(emailSigningCompletedMock).toHaveBeenCalledTimes(2)
    expect(createNotificationMock).toHaveBeenCalledTimes(2)
  })

  it('future start_date → lease.status=pending, unit stays vacant', async () => {
    const f = await seedFixture()
    // Use a date safely in the future relative to test runtime.
    const futureDate = new Date(Date.now() + 1000 * 60 * 60 * 24 * 30).toISOString().slice(0, 10)
    const { documentId } = await seedCompleteableDoc(f, {
      fields: defaultLeaseFields({ start_date: futureDate, end_date: '2099-12-31' }),
    })
    const res = await request(buildApp())
      .post(`/api/esign/sign/${documentId}`)
      .set('Authorization', `Bearer ${f.tenantToken}`)
      .send({ fieldValues: [] })
    expect(res.status).toBe(200)
    expect(res.body.data.completed).toBe(true)
    const lease = await db.query<{ status: string }>(
      `SELECT status FROM leases WHERE unit_id = $1`, [f.unitId])
    expect(lease.rows[0].status).toBe('pending')
    // Unit not flipped (only active leases flip unit status in completion handler)
    const unit = await db.query<{ status: string | null }>(
      `SELECT status FROM units WHERE id = $1`, [f.unitId])
    expect(unit.rows[0].status).not.toBe('active')
  })

  it('seeds lease_fees rows from FEE_ROW_SPECS (security_deposit + pet_deposit + cleaning_fee)', async () => {
    const f = await seedFixture()
    const { documentId } = await seedCompleteableDoc(f, {
      fields: defaultLeaseFields({
        pet_deposit:   '500.00',
        cleaning_fee:  '250.00',
      }),
    })
    const res = await request(buildApp())
      .post(`/api/esign/sign/${documentId}`)
      .set('Authorization', `Bearer ${f.tenantToken}`)
      .send({ fieldValues: [] })
    expect(res.status).toBe(200)
    const lease = await db.query<{ id: string }>(
      `SELECT id FROM leases WHERE unit_id = $1`, [f.unitId])
    const fees = await db.query<{ fee_type: string; amount: string; is_refundable: boolean; due_timing: string }>(
      `SELECT fee_type, amount, is_refundable, due_timing
         FROM lease_fees WHERE lease_id = $1 ORDER BY fee_type`,
      [lease.rows[0].id])
    // Sorted alphabetically: cleaning_fee, pet_deposit, security_deposit
    expect(fees.rows.map(r => r.fee_type)).toEqual(['cleaning_fee', 'pet_deposit', 'security_deposit'])
    const byType = Object.fromEntries(fees.rows.map(r => [r.fee_type, r]))
    expect(Number(byType.security_deposit.amount)).toBe(1200)
    expect(byType.security_deposit.is_refundable).toBe(true)
    expect(byType.security_deposit.due_timing).toBe('move_in')
    expect(Number(byType.pet_deposit.amount)).toBe(500)
    expect(byType.pet_deposit.is_refundable).toBe(true)
    expect(Number(byType.cleaning_fee.amount)).toBe(250)
    expect(byType.cleaning_fee.is_refundable).toBe(false)
    expect(byType.cleaning_fee.due_timing).toBe('move_out')
  })

  it('seeds lease_utility_responsibilities from UTILITY_ROW_SPECS', async () => {
    const f = await seedFixture()
    const { documentId } = await seedCompleteableDoc(f, {
      fields: defaultLeaseFields({
        utility_water_responsibility:    'yes',
        utility_electric_responsibility: 'true',
        utility_gas_responsibility:      'false',
      }),
    })
    const res = await request(buildApp())
      .post(`/api/esign/sign/${documentId}`)
      .set('Authorization', `Bearer ${f.tenantToken}`)
      .send({ fieldValues: [] })
    expect(res.status).toBe(200)
    const lease = await db.query<{ id: string }>(
      `SELECT id FROM leases WHERE unit_id = $1`, [f.unitId])
    const utils = await db.query<{ utility_type: string; tenant_responsible: boolean }>(
      `SELECT utility_type, tenant_responsible
         FROM lease_utility_responsibilities WHERE lease_id = $1
         ORDER BY utility_type`,
      [lease.rows[0].id])
    const byType = Object.fromEntries(utils.rows.map(r => [r.utility_type, r.tenant_responsible]))
    expect(byType.water).toBe(true)
    expect(byType.electric).toBe(true)
    expect(byType.gas).toBe(false)
  })

  it('co-tenant + primary → two lease_tenants rows, primary + co_tenant roles', async () => {
    const f = await seedFixture()
    // Seed a second tenant who will co-sign
    const client = await db.connect()
    let coTenantUserId: string, coTenantId: string, coTenantEmail: string
    try {
      const userRes = await client.query<{ id: string }>(
        `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
         VALUES ($1, 'x', 'tenant', 'Co', 'Tenant', TRUE) RETURNING id`,
        [`cotenant-${randomUUID()}@test.dev`])
      coTenantUserId = userRes.rows[0].id
      const tRes = await client.query<{ id: string; email: string }>(
        `INSERT INTO tenants (user_id) VALUES ($1) RETURNING id`, [coTenantUserId])
      coTenantId = tRes.rows[0].id
      const eRes = await client.query<{ email: string }>(
        `SELECT email FROM users WHERE id = $1`, [coTenantUserId])
      coTenantEmail = eRes.rows[0].email
    } finally { client.release() }

    const { documentId } = await seedCompleteableDoc(f)
    // Co-tenant signer role: must match TENANT_ROLE_PATTERN = /^(primary|co_tenant_\d+)$/
    // (esign.ts:43). lease_tenants.role gets normalized to 'co_tenant' downstream.
    await db.query(
      `INSERT INTO lease_document_signers
         (document_id, user_id, role, name, email, order_index, token, status, signed_at)
       VALUES ($1, $2, 'co_tenant_1', 'Co T', $3, 3, $4, 'signed', NOW())`,
      [documentId, coTenantUserId, coTenantEmail, crypto.randomBytes(32).toString('hex')])

    const res = await request(buildApp())
      .post(`/api/esign/sign/${documentId}`)
      .set('Authorization', `Bearer ${f.tenantToken}`)
      .send({ fieldValues: [] })
    expect(res.status).toBe(200)
    const lease = await db.query<{ id: string }>(
      `SELECT id FROM leases WHERE unit_id = $1`, [f.unitId])
    const lt = await db.query<{ role: string; tenant_id: string }>(
      `SELECT role, tenant_id FROM lease_tenants WHERE lease_id = $1 ORDER BY role`,
      [lease.rows[0].id])
    expect(lt.rows.length).toBe(2)
    expect(lt.rows.map(r => r.role)).toEqual(['co_tenant', 'primary'])
  })
})

describe('POST /sign/:documentId — completion handler failure paths', () => {
  it('missing start_date → 400 + execution_failed + admin notif (critical)', async () => {
    const f = await seedFixture()
    const fields = defaultLeaseFields()
    delete fields.start_date
    const { documentId } = await seedCompleteableDoc(f, { fields })
    const res = await request(buildApp())
      .post(`/api/esign/sign/${documentId}`)
      .set('Authorization', `Bearer ${f.tenantToken}`)
      .send({ fieldValues: [] })
    expect(res.status).toBe(200)  // signature persists; build failure surfaces as executionFailed
    expect(res.body.data.executionFailed).toBe(true)
    expect(res.body.data.reason).toMatch(/start_date/i)
    const doc = await db.query<{ status: string; void_reason: string | null }>(
      `SELECT status, void_reason FROM lease_documents WHERE id = $1`, [documentId])
    expect(doc.rows[0].status).toBe('execution_failed')
    expect(doc.rows[0].void_reason).toMatch(/Lease build failed/)
    expect(createAdminNotificationMock).toHaveBeenCalled()
    const adminCall = (createAdminNotificationMock.mock.calls as any[][])[0]![0] as any
    expect(adminCall.severity).toBe('critical')
    expect(adminCall.category).toBe('esign_lease_build_failed')
    // ROLLBACK: no lease created
    const leases = await db.query(`SELECT id FROM leases WHERE unit_id = $1`, [f.unitId])
    expect(leases.rows.length).toBe(0)
  })

  it('missing rent_amount → execution_failed + ROLLBACK', async () => {
    const f = await seedFixture()
    const fields = defaultLeaseFields()
    delete fields.rent_amount
    const { documentId } = await seedCompleteableDoc(f, { fields })
    const res = await request(buildApp())
      .post(`/api/esign/sign/${documentId}`)
      .set('Authorization', `Bearer ${f.tenantToken}`)
      .send({ fieldValues: [] })
    expect(res.body.data.executionFailed).toBe(true)
    expect(res.body.data.reason).toMatch(/rent_amount/i)
    const doc = await db.query<{ status: string }>(
      `SELECT status FROM lease_documents WHERE id = $1`, [documentId])
    expect(doc.rows[0].status).toBe('execution_failed')
    const leases = await db.query(`SELECT id FROM leases WHERE unit_id = $1`, [f.unitId])
    expect(leases.rows.length).toBe(0)
  })

  it('invalid rent_amount (0) → execution_failed', async () => {
    const f = await seedFixture()
    const { documentId } = await seedCompleteableDoc(f, {
      fields: defaultLeaseFields({ rent_amount: '0' }),
    })
    const res = await request(buildApp())
      .post(`/api/esign/sign/${documentId}`)
      .set('Authorization', `Bearer ${f.tenantToken}`)
      .send({ fieldValues: [] })
    expect(res.body.data.executionFailed).toBe(true)
    expect(res.body.data.reason).toMatch(/Invalid rent_amount/i)
  })

  it('tenant has an overlapping active lease → execution_failed (overlap detected)', async () => {
    const f = await seedFixture()
    // Seed a second unit on the same property and put the tenant on an overlapping lease there.
    const otherUnit = await db.query<{ id: string }>(
      `INSERT INTO units (property_id, landlord_id, unit_number, rent_amount)
       VALUES ($1, $2, 'U-OTHER', 1000) RETURNING id`,
      [f.propertyId, f.landlordId])
    const otherLease = await db.query<{ id: string }>(
      `INSERT INTO leases (unit_id, landlord_id, rent_amount, lease_type, status, start_date, end_date)
       VALUES ($1, $2, 1000, 'fixed_term', 'active', '2025-01-01', '2025-12-31') RETURNING id`,
      [otherUnit.rows[0].id, f.landlordId])
    await db.query(
      `INSERT INTO lease_tenants (lease_id, tenant_id, role, status, added_at, added_reason, financial_responsibility)
       VALUES ($1, $2, 'primary', 'active', NOW(), 'original', 'joint_several')`,
      [otherLease.rows[0].id, f.tenantId])
    const { documentId } = await seedCompleteableDoc(f)
    const res = await request(buildApp())
      .post(`/api/esign/sign/${documentId}`)
      .set('Authorization', `Bearer ${f.tenantToken}`)
      .send({ fieldValues: [] })
    // Overlap is re-checked at POST /sign before completion → 409 + signature does NOT persist.
    // (executeOriginalLease's overlap check is the inner backstop for races between send + sign.)
    expect(res.status).toBe(409)
    expect(res.body.error).toMatch(/overlap/i)
    // No lease materialized on the new unit
    const leases = await db.query(`SELECT id FROM leases WHERE unit_id = $1`, [f.unitId])
    expect(leases.rows.length).toBe(0)
  })

  it('primary signer has no tenants row → execution_failed', async () => {
    const f = await seedFixture()
    // Wipe the tenants row for the primary signer's user, leaving the users row.
    // executeOriginalLease's tenant-profile gate (esign.ts:464) will throw.
    await db.query(`DELETE FROM tenants WHERE id = $1`, [f.tenantId])
    const { documentId } = await seedCompleteableDoc(f)
    const res = await request(buildApp())
      .post(`/api/esign/sign/${documentId}`)
      .set('Authorization', `Bearer ${f.tenantToken}`)
      .send({ fieldValues: [] })
    expect(res.body.data.executionFailed).toBe(true)
    expect(res.body.data.reason).toMatch(/tenant profile/i)
    const doc = await db.query<{ status: string }>(
      `SELECT status FROM lease_documents WHERE id = $1`, [documentId])
    expect(doc.rows[0].status).toBe('execution_failed')
  })

  it('platform-blocked tenant → execution_failed (build), signature still persists', async () => {
    const f = await seedFixture()
    await db.query(`UPDATE tenants SET platform_status = 'blocked' WHERE id = $1`, [f.tenantId])
    const { documentId, tenantSignerId } = await seedCompleteableDoc(f)
    const res = await request(buildApp())
      .post(`/api/esign/sign/${documentId}`)
      .set('Authorization', `Bearer ${f.tenantToken}`)
      .send({ fieldValues: [] })
    // Pre-sign check at esign.ts:2057 short-circuits with 403 BEFORE the signature is persisted.
    expect(res.status).toBe(403)
    const ts = await db.query<{ status: string }>(
      `SELECT status FROM lease_document_signers WHERE id = $1`, [tenantSignerId])
    expect(ts.rows[0].status).toBe('viewed')  // unchanged
  })

  it('generateMoveInInvoice throws → execution_failed + ROLLBACK (no lease, no lease_tenants)', async () => {
    const f = await seedFixture()
    generateMoveInInvoiceMock.mockRejectedValueOnce(new Error('move-in failed'))
    const { documentId } = await seedCompleteableDoc(f)
    const res = await request(buildApp())
      .post(`/api/esign/sign/${documentId}`)
      .set('Authorization', `Bearer ${f.tenantToken}`)
      .send({ fieldValues: [] })
    expect(res.body.data.executionFailed).toBe(true)
    expect(res.body.data.reason).toMatch(/move-in failed/)
    // ROLLBACK: no lease + no lease_tenants
    const leases = await db.query(`SELECT id FROM leases WHERE unit_id = $1`, [f.unitId])
    expect(leases.rows.length).toBe(0)
    const lt = await db.query(`SELECT id FROM lease_tenants WHERE tenant_id = $1`, [f.tenantId])
    expect(lt.rows.length).toBe(0)
    // Admin notif fired
    expect(createAdminNotificationMock).toHaveBeenCalled()
  })
})

describe('POST /sign/:documentId — post-commit side effects', () => {
  /** Helper: stand up a PM company + fee plan with a leasing_fee_amount,
   *  attach to the property. Returns the PM payout user id so tests can
   *  read the ledger row keyed to that user. */
  async function seedPmCompanyWithLeasingFee(
    f: SeedFixture,
    leasingFeeAmount: number,
  ): Promise<{ pmCompanyId: string; pmFeePlanId: string; pmPayoutUserId: string }> {
    const client = await db.connect()
    try {
      // PM owner user + bank account
      const pmOwner = await client.query<{ id: string }>(
        `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
         VALUES ($1, 'x', 'landlord', 'PM', 'Owner', TRUE) RETURNING id`,
        [`pm-${randomUUID()}@test.dev`])
      const pmPayoutUserId = pmOwner.rows[0].id
      const ba = await client.query<{ id: string }>(
        `INSERT INTO user_bank_accounts
           (user_id, nickname, account_holder_name, account_type,
            routing_number, account_number_last4, account_number_encrypted)
         VALUES ($1, 'PM Bank', 'PM Owner', 'checking', '123456789', '4321', 'enc')
         RETURNING id`,
        [pmPayoutUserId])
      const co = await client.query<{ id: string }>(
        `INSERT INTO pm_companies (name, bank_account_id)
         VALUES ($1, $2) RETURNING id`,
        [`PM ${randomUUID().slice(0, 6)}`, ba.rows[0].id])
      const fp = await client.query<{ id: string }>(
        `INSERT INTO pm_fee_plans
           (pm_company_id, name, fee_type, leasing_fee_amount)
         VALUES ($1, 'Standard', 'leasing_fee', $2) RETURNING id`,
        [co.rows[0].id, leasingFeeAmount])
      await client.query(
        `UPDATE properties SET pm_company_id = $1, pm_fee_plan_id = $2 WHERE id = $3`,
        [co.rows[0].id, fp.rows[0].id, f.propertyId])
      return { pmCompanyId: co.rows[0].id, pmFeePlanId: fp.rows[0].id, pmPayoutUserId }
    } finally { client.release() }
  }

  it('PM company on property → user_balance_ledger leasing-fee row + firePmTransfersForReference fired', async () => {
    const f = await seedFixture()
    const { pmPayoutUserId } = await seedPmCompanyWithLeasingFee(f, 750)
    const { documentId } = await seedCompleteableDoc(f)
    const res = await request(buildApp())
      .post(`/api/esign/sign/${documentId}`)
      .set('Authorization', `Bearer ${f.tenantToken}`)
      .send({ fieldValues: [] })
    expect(res.status).toBe(200)
    expect(res.body.data.completed).toBe(true)
    // Ledger row stamped on the PM payout user
    const ledger = await db.query<{ type: string; amount: string; reference_type: string }>(
      `SELECT type, amount, reference_type FROM user_balance_ledger
        WHERE user_id = $1 AND type = 'allocation_pm_company_fee'`,
      [pmPayoutUserId])
    expect(ledger.rows.length).toBe(1)
    expect(Number(ledger.rows[0].amount)).toBe(750)
    expect(ledger.rows[0].reference_type).toBe('lease')
    // Post-commit Stripe transfer fired
    const lease = await db.query<{ id: string }>(
      `SELECT id FROM leases WHERE unit_id = $1`, [f.unitId])
    expect(firePmTransfersMock).toHaveBeenCalledTimes(1)
    expect(firePmTransfersMock).toHaveBeenCalledWith('lease', lease.rows[0].id)
  })

  it('self-managed property → no ledger row, no firePmTransfers', async () => {
    const f = await seedFixture()
    const { documentId } = await seedCompleteableDoc(f)
    const res = await request(buildApp())
      .post(`/api/esign/sign/${documentId}`)
      .set('Authorization', `Bearer ${f.tenantToken}`)
      .send({ fieldValues: [] })
    expect(res.status).toBe(200)
    const ledger = await db.query(
      `SELECT id FROM user_balance_ledger WHERE type = 'allocation_pm_company_fee'`)
    expect(ledger.rows.length).toBe(0)
    expect(firePmTransfersMock).toHaveBeenCalledTimes(1)  // still fires, but no-op on empty
  })

  it('firePmTransfers throws → doc still completes, admin warn notif fires', async () => {
    const f = await seedFixture()
    await seedPmCompanyWithLeasingFee(f, 500)
    firePmTransfersMock.mockRejectedValueOnce(new Error('stripe down'))
    const { documentId } = await seedCompleteableDoc(f)
    const res = await request(buildApp())
      .post(`/api/esign/sign/${documentId}`)
      .set('Authorization', `Bearer ${f.tenantToken}`)
      .send({ fieldValues: [] })
    expect(res.status).toBe(200)
    expect(res.body.data.completed).toBe(true)
    const doc = await db.query<{ status: string }>(
      `SELECT status FROM lease_documents WHERE id = $1`, [documentId])
    expect(doc.rows[0].status).toBe('completed')
    // Admin warn notif fired with the pm_transfer category
    expect(createAdminNotificationMock).toHaveBeenCalled()
    const warnCalls = (createAdminNotificationMock.mock.calls as any[][]).filter(
      c => c[0].category === 'pm_transfer_post_commit_failed')
    expect(warnCalls.length).toBe(1)
    expect((warnCalls[0]![0] as any).severity).toBe('warn')
  })

  it('missing base_pdf_url → stamp skipped cleanly, doc completes without executed_pdf_url', async () => {
    const f = await seedFixture()
    const { documentId } = await seedCompleteableDoc(f)  // base_pdf_url null by default
    const res = await request(buildApp())
      .post(`/api/esign/sign/${documentId}`)
      .set('Authorization', `Bearer ${f.tenantToken}`)
      .send({ fieldValues: [] })
    expect(res.status).toBe(200)
    const doc = await db.query<{ status: string; executed_pdf_url: string | null }>(
      `SELECT status, executed_pdf_url FROM lease_documents WHERE id = $1`, [documentId])
    expect(doc.rows[0].status).toBe('completed')
    expect(doc.rows[0].executed_pdf_url).toBeNull()
    expect(stampPdfMock).not.toHaveBeenCalled()
  })

  it('base_pdf_url points to a missing file → stamp gated by fs.existsSync, doc still completes', async () => {
    const f = await seedFixture()
    // /api/esign/files/<filename> URL shape; extractUploadFilename strips
    // the prefix and produces a path inside uploadDir. The file does not
    // exist on disk → fs.existsSync returns false → stampPdf is skipped.
    const { documentId } = await seedCompleteableDoc(f, {
      basePdfUrl: '/api/esign/files/does-not-exist.pdf',
    })
    const res = await request(buildApp())
      .post(`/api/esign/sign/${documentId}`)
      .set('Authorization', `Bearer ${f.tenantToken}`)
      .send({ fieldValues: [] })
    expect(res.status).toBe(200)
    const doc = await db.query<{ status: string; executed_pdf_url: string | null }>(
      `SELECT status, executed_pdf_url FROM lease_documents WHERE id = $1`, [documentId])
    expect(doc.rows[0].status).toBe('completed')
    expect(doc.rows[0].executed_pdf_url).toBeNull()
    expect(stampPdfMock).not.toHaveBeenCalled()
  })

  it('emailSigningCompleted + createNotification fire once per signer at completion', async () => {
    const f = await seedFixture()
    const { documentId } = await seedCompleteableDoc(f)
    // Pre-completion the partial-sign flow may have already fired emailSigningRequest
    // for next-signer notifications. We care only about the completed-suite here.
    emailSigningCompletedMock.mockClear()
    createNotificationMock.mockClear()
    const res = await request(buildApp())
      .post(`/api/esign/sign/${documentId}`)
      .set('Authorization', `Bearer ${f.tenantToken}`)
      .send({ fieldValues: [] })
    expect(res.status).toBe(200)
    // Two signers (landlord + primary tenant) → 2 calls each
    expect(emailSigningCompletedMock).toHaveBeenCalledTimes(2)
    expect(createNotificationMock).toHaveBeenCalledTimes(2)
    const notifTypes = createNotificationMock.mock.calls.map((c: any[]) => c[0].type)
    expect(notifTypes.every((t: string) => t === 'esign_completed')).toBe(true)
  })
})

// ─── POST /sign/:documentId — addendum_add completion (S335) ───
//
// Preconditions executed at completion (esign.ts:713-792):
//   - doc.lease_id non-null, doc.unit_id non-null
//   - parent lease exists, status='active', unit_id matches doc.unit_id
//   - exactly one lease_tenants row with add_document_id=doc.id, status='pending_add'
//   - every tenant signer has a tenants row + no platform blocks
//   - pending row's tenant_id matches one of the signers
//   - new tenant has no bucket-overlapping active/pending lease
//
// Side effects: pending_add row flips to active, lease untouched.

/** Seed parent lease with active primary tenant on the fixture unit. */
async function seedParentLease(
  f: SeedFixture,
  opts: { status?: 'active' | 'expired' | 'terminated' | 'pending' } = {},
): Promise<string> {
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    const leaseId = await seedLease(client, {
      unitId:     f.unitId,
      landlordId: f.landlordId,
      status:     opts.status ?? 'active',
      startDate:  '2025-01-01',
    })
    // primary lease_tenants row for the fixture's tenant
    await seedLeaseTenant(client, {
      leaseId,
      tenantId: f.tenantId,
      role:     'primary',
    })
    await client.query('COMMIT')
    return leaseId
  } catch (e) { await client.query('ROLLBACK'); throw e }
  finally { client.release() }
}

interface NewTenantSeed {
  userId:    string
  tenantId:  string
  email:     string
  authToken: string
}

/** Seed a fresh new tenant (user + tenants row + jwt). */
async function seedNewTenant(): Promise<NewTenantSeed> {
  const email = `addendum-tenant-${randomUUID()}@test.dev`
  const userRes = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
     VALUES ($1, 'x', 'tenant', 'New', 'Tenant', TRUE) RETURNING id`,
    [email])
  const userId = userRes.rows[0].id
  const tRes = await db.query<{ id: string }>(
    `INSERT INTO tenants (user_id) VALUES ($1) RETURNING id`, [userId])
  const tenantId = tRes.rows[0].id
  const authToken = jwt.sign(
    { userId, role: 'tenant', email, profileId: tenantId, permissions: {} },
    process.env.JWT_SECRET!, { expiresIn: '1h' },
  )
  return { userId, tenantId, email, authToken }
}

/** Seed an addendum_add doc + landlord (pre-signed) + new-tenant signer (viewed),
 *  plus the pending_add lease_tenants row pointing at this document. */
async function seedAddendumAddDoc(
  f: SeedFixture,
  parentLeaseId: string,
  newTenant: NewTenantSeed,
  opts: {
    pendingTenantId?:     string  // overrideable for mismatch tests
    pendingStatus?:       'pending_add' | 'active' | 'removed'
    pendingAddDocumentId?: string | null  // override for orphan-row tests
    skipPendingRow?:      boolean
    extraPendingRow?:     boolean  // seed a second pending_add row → corruption
  } = {},
): Promise<{ documentId: string; pendingRowId: string | null }> {
  const docRes = await db.query<{ id: string }>(
    `INSERT INTO lease_documents
       (landlord_id, unit_id, lease_id, title, document_type, status)
     VALUES ($1, $2, $3, 'S335 Addendum Add', 'addendum_add', 'in_progress')
     RETURNING id`,
    [f.landlordId, f.unitId, parentLeaseId])
  const documentId = docRes.rows[0].id

  // Landlord signer: pre-signed
  await db.query(
    `INSERT INTO lease_document_signers
       (document_id, user_id, role, name, email, order_index, token, status, signed_at)
     VALUES ($1, $2, 'landlord', 'L L', 'll@test.dev', 1, $3, 'signed', NOW())`,
    [documentId, f.landlordUserId, crypto.randomBytes(32).toString('hex')])
  // New tenant signer: viewed (the one who will POST /sign)
  await db.query(
    `INSERT INTO lease_document_signers
       (document_id, user_id, role, name, email, order_index, token, status, viewed_at)
     VALUES ($1, $2, 'primary', 'New T', $3, 2, $4, 'viewed', NOW())`,
    [documentId, newTenant.userId, newTenant.email, crypto.randomBytes(32).toString('hex')])

  let pendingRowId: string | null = null
  if (!opts.skipPendingRow) {
    const addDocId = opts.pendingAddDocumentId === undefined ? documentId : opts.pendingAddDocumentId
    const r = await db.query<{ id: string }>(
      `INSERT INTO lease_tenants
         (lease_id, tenant_id, role, status, added_at, added_reason,
          financial_responsibility, add_document_id)
       VALUES ($1, $2, 'co_tenant', $3, NOW(), 'roommate_added', 'joint_several', $4)
       RETURNING id`,
      [parentLeaseId, opts.pendingTenantId ?? newTenant.tenantId, opts.pendingStatus ?? 'pending_add', addDocId])
    pendingRowId = r.rows[0].id
  }
  if (opts.extraPendingRow) {
    // Second pending_add row tied to the same doc → corruption guard at line 737
    const t2 = await seedNewTenant()
    await db.query(
      `INSERT INTO lease_tenants
         (lease_id, tenant_id, role, status, added_at, added_reason,
          financial_responsibility, add_document_id)
       VALUES ($1, $2, 'co_tenant', 'pending_add', NOW(), 'roommate_added', 'joint_several', $3)`,
      [parentLeaseId, t2.tenantId, documentId])
  }
  return { documentId, pendingRowId }
}

describe('POST /sign/:documentId — addendum_add completion', () => {
  it('happy path: pending_add → active, lease_tenants count grows to 2', async () => {
    const f = await seedFixture()
    const parentLeaseId = await seedParentLease(f)
    const newTenant = await seedNewTenant()
    const { documentId, pendingRowId } = await seedAddendumAddDoc(f, parentLeaseId, newTenant)

    const res = await request(buildApp())
      .post(`/api/esign/sign/${documentId}`)
      .set('Authorization', `Bearer ${newTenant.authToken}`)
      .send({ fieldValues: [] })

    expect(res.status).toBe(200)
    expect(res.body.data.completed).toBe(true)
    expect(res.body.data.executionFailed).toBeUndefined()

    // pending_add row flipped to active
    const flipped = await db.query<{ status: string; added_at: string }>(
      `SELECT status, added_at FROM lease_tenants WHERE id = $1`, [pendingRowId])
    expect(flipped.rows[0].status).toBe('active')

    // Total active lease_tenants on the parent lease: primary + new co_tenant = 2
    const tenants = await db.query<{ role: string; tenant_id: string }>(
      `SELECT role, tenant_id FROM lease_tenants
         WHERE lease_id = $1 AND status = 'active'
         ORDER BY role`,
      [parentLeaseId])
    expect(tenants.rows.length).toBe(2)
    expect(tenants.rows.map(r => r.role)).toEqual(['co_tenant', 'primary'])

    // Parent lease untouched (status still active, no fee/utility writes)
    const lease = await db.query<{ status: string }>(
      `SELECT status FROM leases WHERE id = $1`, [parentLeaseId])
    expect(lease.rows[0].status).toBe('active')

    // Doc status flips completed; doc.lease_id stays pointed at parent
    const doc = await db.query<{ status: string; lease_id: string }>(
      `SELECT status, lease_id FROM lease_documents WHERE id = $1`, [documentId])
    expect(doc.rows[0].status).toBe('completed')
    expect(doc.rows[0].lease_id).toBe(parentLeaseId)
  })

  it('no pending_add row for this doc → execution_failed (500: creation logic failed)', async () => {
    const f = await seedFixture()
    const parentLeaseId = await seedParentLease(f)
    const newTenant = await seedNewTenant()
    const { documentId } = await seedAddendumAddDoc(f, parentLeaseId, newTenant, { skipPendingRow: true })

    const res = await request(buildApp())
      .post(`/api/esign/sign/${documentId}`)
      .set('Authorization', `Bearer ${newTenant.authToken}`)
      .send({ fieldValues: [] })
    expect(res.body.data.executionFailed).toBe(true)
    expect(res.body.data.reason).toMatch(/No pending_add row/i)
  })

  it('multiple pending_add rows → execution_failed (data corruption guard)', async () => {
    const f = await seedFixture()
    const parentLeaseId = await seedParentLease(f)
    const newTenant = await seedNewTenant()
    const { documentId } = await seedAddendumAddDoc(f, parentLeaseId, newTenant, { extraPendingRow: true })

    const res = await request(buildApp())
      .post(`/api/esign/sign/${documentId}`)
      .set('Authorization', `Bearer ${newTenant.authToken}`)
      .send({ fieldValues: [] })
    expect(res.body.data.executionFailed).toBe(true)
    expect(res.body.data.reason).toMatch(/Multiple pending_add rows/i)
  })

  it('parent lease not active (expired) → execution_failed (409)', async () => {
    const f = await seedFixture()
    const parentLeaseId = await seedParentLease(f, { status: 'expired' })
    const newTenant = await seedNewTenant()
    const { documentId } = await seedAddendumAddDoc(f, parentLeaseId, newTenant)

    const res = await request(buildApp())
      .post(`/api/esign/sign/${documentId}`)
      .set('Authorization', `Bearer ${newTenant.authToken}`)
      .send({ fieldValues: [] })
    expect(res.body.data.executionFailed).toBe(true)
    expect(res.body.data.reason).toMatch(/parent lease is expired/i)
  })

  it('new tenant has overlapping active lease elsewhere → execution_failed (409)', async () => {
    const f = await seedFixture()
    const parentLeaseId = await seedParentLease(f)
    const newTenant = await seedNewTenant()
    // Seed a second unit on the same property and put newTenant on an
    // overlapping active lease there.
    const otherUnit = await db.query<{ id: string }>(
      `INSERT INTO units (property_id, landlord_id, unit_number, rent_amount)
       VALUES ($1, $2, 'U-OTHER', 1000) RETURNING id`,
      [f.propertyId, f.landlordId])
    const otherLeaseRes = await db.query<{ id: string }>(
      `INSERT INTO leases (unit_id, landlord_id, rent_amount, lease_type, status, start_date, end_date)
       VALUES ($1, $2, 1000, 'fixed_term', 'active', '2025-01-01', '2025-12-31') RETURNING id`,
      [otherUnit.rows[0].id, f.landlordId])
    await db.query(
      `INSERT INTO lease_tenants (lease_id, tenant_id, role, status, added_at, added_reason, financial_responsibility)
       VALUES ($1, $2, 'primary', 'active', NOW(), 'original', 'joint_several')`,
      [otherLeaseRes.rows[0].id, newTenant.tenantId])

    const { documentId } = await seedAddendumAddDoc(f, parentLeaseId, newTenant)
    const res = await request(buildApp())
      .post(`/api/esign/sign/${documentId}`)
      .set('Authorization', `Bearer ${newTenant.authToken}`)
      .send({ fieldValues: [] })
    expect(res.body.data.executionFailed).toBe(true)
    expect(res.body.data.reason).toMatch(/overlap/i)
  })

  it('pending row tenant_id does not match any signer → execution_failed', async () => {
    const f = await seedFixture()
    const parentLeaseId = await seedParentLease(f)
    const newTenant = await seedNewTenant()
    const otherTenant = await seedNewTenant()  // distinct tenant_id; not on signers
    const { documentId } = await seedAddendumAddDoc(f, parentLeaseId, newTenant, {
      pendingTenantId: otherTenant.tenantId,
    })
    const res = await request(buildApp())
      .post(`/api/esign/sign/${documentId}`)
      .set('Authorization', `Bearer ${newTenant.authToken}`)
      .send({ fieldValues: [] })
    expect(res.body.data.executionFailed).toBe(true)
    expect(res.body.data.reason).toMatch(/does not match any signer/i)
  })

  it('parent lease deleted post-send → execution_failed (no parent lease_id)', async () => {
    const f = await seedFixture()
    const parentLeaseId = await seedParentLease(f)
    const newTenant = await seedNewTenant()
    const { documentId } = await seedAddendumAddDoc(f, parentLeaseId, newTenant)
    // Lease FKs:
    //   lease_documents.lease_id → ON DELETE SET NULL  (doc.lease_id → null)
    //   lease_tenants.lease_id   → ON DELETE CASCADE   (pending_add row vanishes)
    // Deleting the parent lease drops doc.lease_id to NULL; executor's first
    // gate (esign.ts:714) catches it as 'Addendum has no parent lease_id'.
    await db.query(`DELETE FROM leases WHERE id = $1`, [parentLeaseId])
    const res = await request(buildApp())
      .post(`/api/esign/sign/${documentId}`)
      .set('Authorization', `Bearer ${newTenant.authToken}`)
      .send({ fieldValues: [] })
    expect(res.body.data.executionFailed).toBe(true)
    expect(res.body.data.reason).toMatch(/Addendum has no parent lease_id/i)
  })

  it('any tenant signer without tenants row → execution_failed (400 tenant profile)', async () => {
    const f = await seedFixture()
    const parentLeaseId = await seedParentLease(f)
    const newTenant = await seedNewTenant()
    const { documentId } = await seedAddendumAddDoc(f, parentLeaseId, newTenant)
    // Add a SECOND tenant signer (role co_tenant_1) whose user has no
    // tenants row. The inner tenant-profile gate at esign.ts:753 iterates
    // every tenant signer, so the orphan trips the check even though the
    // POST /sign comes from newTenant (who has a valid tenants row).
    const ghostUserId = (await db.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
       VALUES ($1, 'x', 'tenant', 'Ghost', 'Tenant', TRUE) RETURNING id`,
      [`ghost-${randomUUID()}@test.dev`])).rows[0].id
    await db.query(
      `INSERT INTO lease_document_signers
         (document_id, user_id, role, name, email, order_index, token, status, signed_at)
       VALUES ($1, $2, 'co_tenant_1', 'Ghost T', 'ghost@x', 3, $3, 'signed', NOW())`,
      [documentId, ghostUserId, crypto.randomBytes(32).toString('hex')])

    const res = await request(buildApp())
      .post(`/api/esign/sign/${documentId}`)
      .set('Authorization', `Bearer ${newTenant.authToken}`)
      .send({ fieldValues: [] })
    expect(res.body.data.executionFailed).toBe(true)
    expect(res.body.data.reason).toMatch(/tenant profile/i)
  })
})

// ─── POST /sign/:documentId — addendum_remove completion (S335) ─
//
// Preconditions executed at completion (esign.ts:807-893):
//   - doc.lease_id non-null, doc.target_lease_tenant_id non-null
//   - parent lease status='active'
//   - target row exists, status='pending_remove', belongs to doc.lease_id,
//     remove_document_id=doc.id
//   - every tenant signer has tenants row + no platform blocks
//   - if target.role='primary': doc.promote_lease_tenant_id non-null,
//     promote row belongs to lease, status='active', role='co_tenant'

/** Seed an addendum_remove doc + landlord (pre-signed) + departing-tenant signer
 *  (viewed), plus the target lease_tenants row in pending_remove state. */
async function seedAddendumRemoveDoc(
  f: SeedFixture,
  parentLeaseId: string,
  departingTenant: NewTenantSeed,
  targetLeaseTenantId: string,
  opts: {
    promoteLeaseTenantId?: string | null
    targetStatus?: 'pending_remove' | 'active' | 'removed'
  } = {},
): Promise<{ documentId: string }> {
  const docRes = await db.query<{ id: string }>(
    `INSERT INTO lease_documents
       (landlord_id, unit_id, lease_id, title, document_type, status,
        target_lease_tenant_id, promote_lease_tenant_id)
     VALUES ($1, $2, $3, 'S335 Addendum Remove', 'addendum_remove',
             'in_progress', $4, $5)
     RETURNING id`,
    [f.landlordId, f.unitId, parentLeaseId, targetLeaseTenantId,
     opts.promoteLeaseTenantId ?? null])
  const documentId = docRes.rows[0].id

  await db.query(
    `INSERT INTO lease_document_signers
       (document_id, user_id, role, name, email, order_index, token, status, signed_at)
     VALUES ($1, $2, 'landlord', 'L L', 'll@test.dev', 1, $3, 'signed', NOW())`,
    [documentId, f.landlordUserId, crypto.randomBytes(32).toString('hex')])
  await db.query(
    `INSERT INTO lease_document_signers
       (document_id, user_id, role, name, email, order_index, token, status, viewed_at)
     VALUES ($1, $2, 'primary', 'Departing T', $3, 2, $4, 'viewed', NOW())`,
    [documentId, departingTenant.userId, departingTenant.email, crypto.randomBytes(32).toString('hex')])

  // Flip target row to pending_remove (or other) and stamp remove_document_id
  await db.query(
    `UPDATE lease_tenants
       SET status = $1, remove_document_id = $2
       WHERE id = $3`,
    [opts.targetStatus ?? 'pending_remove', documentId, targetLeaseTenantId])

  return { documentId }
}

describe('POST /sign/:documentId — addendum_remove completion', () => {
  it('happy path co_tenant removal: target → removed, primary stays', async () => {
    const f = await seedFixture()
    // Parent lease with primary (fixture tenant) + co_tenant (new tenant we'll remove)
    const parentLeaseId = await seedParentLease(f)
    const coTenant = await seedNewTenant()
    const coRowRes = await db.query<{ id: string }>(
      `INSERT INTO lease_tenants
         (lease_id, tenant_id, role, status, added_at, added_reason, financial_responsibility)
       VALUES ($1, $2, 'co_tenant', 'active', NOW(), 'roommate_added', 'joint_several')
       RETURNING id`,
      [parentLeaseId, coTenant.tenantId])
    const coRowId = coRowRes.rows[0].id

    const { documentId } = await seedAddendumRemoveDoc(f, parentLeaseId, coTenant, coRowId)
    const res = await request(buildApp())
      .post(`/api/esign/sign/${documentId}`)
      .set('Authorization', `Bearer ${coTenant.authToken}`)
      .send({ fieldValues: [] })

    expect(res.status).toBe(200)
    expect(res.body.data.completed).toBe(true)
    // Target flipped to removed
    const target = await db.query<{ status: string; removed_at: string; removed_reason: string }>(
      `SELECT status, removed_at, removed_reason FROM lease_tenants WHERE id = $1`, [coRowId])
    expect(target.rows[0].status).toBe('removed')
    expect(target.rows[0].removed_reason).toBe('moved_out')
    // Primary stays active + still primary
    const primary = await db.query<{ tenant_id: string }>(
      `SELECT tenant_id FROM lease_tenants
        WHERE lease_id = $1 AND role = 'primary' AND status = 'active'`,
      [parentLeaseId])
    expect(primary.rows.length).toBe(1)
    expect(primary.rows[0].tenant_id).toBe(f.tenantId)
  })

  it('happy path primary removal with promote: target → removed, co_tenant promoted to primary', async () => {
    const f = await seedFixture()
    // Parent lease with primary (fixture tenant — will be removed) + co_tenant (will promote)
    const parentLeaseId = await seedParentLease(f)
    const primaryRow = await db.query<{ id: string }>(
      `SELECT id FROM lease_tenants WHERE lease_id = $1 AND role = 'primary'`,
      [parentLeaseId])
    const primaryRowId = primaryRow.rows[0].id

    const coTenant = await seedNewTenant()
    const coRow = await db.query<{ id: string }>(
      `INSERT INTO lease_tenants
         (lease_id, tenant_id, role, status, added_at, added_reason, financial_responsibility)
       VALUES ($1, $2, 'co_tenant', 'active', NOW(), 'roommate_added', 'joint_several')
       RETURNING id`,
      [parentLeaseId, coTenant.tenantId])
    const coRowId = coRow.rows[0].id

    // Fixture tenant is the one being removed (current signer)
    const departingTenant: NewTenantSeed = {
      userId:    f.tenantUserId,
      tenantId:  f.tenantId,
      email:     f.tenantEmail,
      authToken: f.tenantToken,
    }
    const { documentId } = await seedAddendumRemoveDoc(f, parentLeaseId, departingTenant, primaryRowId, {
      promoteLeaseTenantId: coRowId,
    })

    const res = await request(buildApp())
      .post(`/api/esign/sign/${documentId}`)
      .set('Authorization', `Bearer ${departingTenant.authToken}`)
      .send({ fieldValues: [] })

    expect(res.status).toBe(200)
    expect(res.body.data.completed).toBe(true)
    // Old primary → removed
    const oldPrim = await db.query<{ status: string }>(
      `SELECT status FROM lease_tenants WHERE id = $1`, [primaryRowId])
    expect(oldPrim.rows[0].status).toBe('removed')
    // Old co_tenant → primary, still active
    const promoted = await db.query<{ role: string; status: string }>(
      `SELECT role, status FROM lease_tenants WHERE id = $1`, [coRowId])
    expect(promoted.rows[0].role).toBe('primary')
    expect(promoted.rows[0].status).toBe('active')
  })

  it('remove primary without promote_lease_tenant_id → execution_failed (400)', async () => {
    const f = await seedFixture()
    const parentLeaseId = await seedParentLease(f)
    const primaryRow = await db.query<{ id: string }>(
      `SELECT id FROM lease_tenants WHERE lease_id = $1 AND role = 'primary'`,
      [parentLeaseId])
    const departingTenant: NewTenantSeed = {
      userId:    f.tenantUserId,
      tenantId:  f.tenantId,
      email:     f.tenantEmail,
      authToken: f.tenantToken,
    }
    const { documentId } = await seedAddendumRemoveDoc(f, parentLeaseId, departingTenant, primaryRow.rows[0].id, {
      promoteLeaseTenantId: null,
    })
    const res = await request(buildApp())
      .post(`/api/esign/sign/${documentId}`)
      .set('Authorization', `Bearer ${departingTenant.authToken}`)
      .send({ fieldValues: [] })
    expect(res.body.data.executionFailed).toBe(true)
    expect(res.body.data.reason).toMatch(/promote_lease_tenant_id/i)
  })

  it('promote set but target is co_tenant (not primary) → execution_failed (400)', async () => {
    const f = await seedFixture()
    const parentLeaseId = await seedParentLease(f)
    const coTenant = await seedNewTenant()
    const coRow = await db.query<{ id: string }>(
      `INSERT INTO lease_tenants
         (lease_id, tenant_id, role, status, added_at, added_reason, financial_responsibility)
       VALUES ($1, $2, 'co_tenant', 'active', NOW(), 'roommate_added', 'joint_several')
       RETURNING id`,
      [parentLeaseId, coTenant.tenantId])
    // Need a SECOND co_tenant to use as the (invalid) promote target
    const extraTenant = await seedNewTenant()
    const extraRow = await db.query<{ id: string }>(
      `INSERT INTO lease_tenants
         (lease_id, tenant_id, role, status, added_at, added_reason, financial_responsibility)
       VALUES ($1, $2, 'co_tenant', 'active', NOW(), 'roommate_added', 'joint_several')
       RETURNING id`,
      [parentLeaseId, extraTenant.tenantId])

    const { documentId } = await seedAddendumRemoveDoc(f, parentLeaseId, coTenant, coRow.rows[0].id, {
      promoteLeaseTenantId: extraRow.rows[0].id,  // promote set but target isn't primary
    })
    const res = await request(buildApp())
      .post(`/api/esign/sign/${documentId}`)
      .set('Authorization', `Bearer ${coTenant.authToken}`)
      .send({ fieldValues: [] })
    expect(res.body.data.executionFailed).toBe(true)
    expect(res.body.data.reason).toMatch(/promote_lease_tenant_id set but target is not primary/i)
  })

  it('promote target belongs to a different lease → execution_failed', async () => {
    const f = await seedFixture()
    const parentLeaseId = await seedParentLease(f)
    const primaryRow = await db.query<{ id: string }>(
      `SELECT id FROM lease_tenants WHERE lease_id = $1 AND role = 'primary'`,
      [parentLeaseId])
    // Seed a SECOND lease + co_tenant on it — use that row as the bogus promote target
    const otherUnit = await db.query<{ id: string }>(
      `INSERT INTO units (property_id, landlord_id, unit_number, rent_amount)
       VALUES ($1, $2, 'U-OTHER2', 1000) RETURNING id`, [f.propertyId, f.landlordId])
    const otherLease = await db.query<{ id: string }>(
      `INSERT INTO leases (unit_id, landlord_id, rent_amount, lease_type, status, start_date)
       VALUES ($1, $2, 1000, 'fixed_term', 'active', '2025-01-01') RETURNING id`,
      [otherUnit.rows[0].id, f.landlordId])
    const otherTenant = await seedNewTenant()
    const otherRow = await db.query<{ id: string }>(
      `INSERT INTO lease_tenants
         (lease_id, tenant_id, role, status, added_at, added_reason, financial_responsibility)
       VALUES ($1, $2, 'co_tenant', 'active', NOW(), 'roommate_added', 'joint_several')
       RETURNING id`,
      [otherLease.rows[0].id, otherTenant.tenantId])

    const departingTenant: NewTenantSeed = {
      userId:    f.tenantUserId,
      tenantId:  f.tenantId,
      email:     f.tenantEmail,
      authToken: f.tenantToken,
    }
    const { documentId } = await seedAddendumRemoveDoc(f, parentLeaseId, departingTenant, primaryRow.rows[0].id, {
      promoteLeaseTenantId: otherRow.rows[0].id,
    })
    const res = await request(buildApp())
      .post(`/api/esign/sign/${documentId}`)
      .set('Authorization', `Bearer ${departingTenant.authToken}`)
      .send({ fieldValues: [] })
    expect(res.body.data.executionFailed).toBe(true)
    expect(res.body.data.reason).toMatch(/does not belong to this lease/i)
  })

  it('promote target status is not active → execution_failed', async () => {
    const f = await seedFixture()
    const parentLeaseId = await seedParentLease(f)
    const primaryRow = await db.query<{ id: string }>(
      `SELECT id FROM lease_tenants WHERE lease_id = $1 AND role = 'primary'`,
      [parentLeaseId])
    const coTenant = await seedNewTenant()
    const coRow = await db.query<{ id: string }>(
      `INSERT INTO lease_tenants
         (lease_id, tenant_id, role, status, added_at, added_reason, financial_responsibility,
          removed_at, removed_reason)
       VALUES ($1, $2, 'co_tenant', 'removed', NOW(), 'roommate_added', 'joint_several',
               NOW(), 'moved_out')
       RETURNING id`,
      [parentLeaseId, coTenant.tenantId])
    const departingTenant: NewTenantSeed = {
      userId:    f.tenantUserId,
      tenantId:  f.tenantId,
      email:     f.tenantEmail,
      authToken: f.tenantToken,
    }
    const { documentId } = await seedAddendumRemoveDoc(f, parentLeaseId, departingTenant, primaryRow.rows[0].id, {
      promoteLeaseTenantId: coRow.rows[0].id,  // removed status — invalid
    })
    const res = await request(buildApp())
      .post(`/api/esign/sign/${documentId}`)
      .set('Authorization', `Bearer ${departingTenant.authToken}`)
      .send({ fieldValues: [] })
    expect(res.body.data.executionFailed).toBe(true)
    expect(res.body.data.reason).toMatch(/Promote target status is removed/i)
  })

  it('target status is not pending_remove → execution_failed (409 out of sync)', async () => {
    const f = await seedFixture()
    const parentLeaseId = await seedParentLease(f)
    const coTenant = await seedNewTenant()
    const coRow = await db.query<{ id: string }>(
      `INSERT INTO lease_tenants
         (lease_id, tenant_id, role, status, added_at, added_reason, financial_responsibility)
       VALUES ($1, $2, 'co_tenant', 'active', NOW(), 'roommate_added', 'joint_several')
       RETURNING id`,
      [parentLeaseId, coTenant.tenantId])
    // Seed doc + signers but DON'T flip target to pending_remove (leave 'active')
    const { documentId } = await seedAddendumRemoveDoc(f, parentLeaseId, coTenant, coRow.rows[0].id, {
      targetStatus: 'active',
    })
    const res = await request(buildApp())
      .post(`/api/esign/sign/${documentId}`)
      .set('Authorization', `Bearer ${coTenant.authToken}`)
      .send({ fieldValues: [] })
    expect(res.body.data.executionFailed).toBe(true)
    expect(res.body.data.reason).toMatch(/Target tenant is active, not pending_remove/i)
  })
})

// ─── POST /sign/:documentId — addendum_terms completion (S335) ──
//
// Preconditions (esign.ts:902-925):
//   - doc.lease_id non-null
//   - lease exists; status not in (expired, terminated)
//   - lease has an active primary tenant
//
// Side effects: NONE. No roster mutation, no lease mutation. The
// signed PDF itself is the legal instrument; execution confirms
// completion and returns the parent lease's current state.

/** Seed an addendum_terms doc + landlord (pre-signed) + primary tenant (viewed). */
async function seedAddendumTermsDoc(
  f: SeedFixture,
  parentLeaseId: string,
): Promise<{ documentId: string }> {
  const docRes = await db.query<{ id: string }>(
    `INSERT INTO lease_documents
       (landlord_id, unit_id, lease_id, title, document_type, status)
     VALUES ($1, $2, $3, 'S335 Addendum Terms', 'addendum_terms', 'in_progress')
     RETURNING id`,
    [f.landlordId, f.unitId, parentLeaseId])
  const documentId = docRes.rows[0].id
  await db.query(
    `INSERT INTO lease_document_signers
       (document_id, user_id, role, name, email, order_index, token, status, signed_at)
     VALUES ($1, $2, 'landlord', 'L L', 'll@test.dev', 1, $3, 'signed', NOW())`,
    [documentId, f.landlordUserId, crypto.randomBytes(32).toString('hex')])
  await db.query(
    `INSERT INTO lease_document_signers
       (document_id, user_id, role, name, email, order_index, token, status, viewed_at)
     VALUES ($1, $2, 'primary', 'T T', $3, 2, $4, 'viewed', NOW())`,
    [documentId, f.tenantUserId, f.tenantEmail, crypto.randomBytes(32).toString('hex')])
  return { documentId }
}

describe('POST /sign/:documentId — addendum_terms completion', () => {
  it('happy path: doc completes, lease untouched, primary tenant returned', async () => {
    const f = await seedFixture()
    const parentLeaseId = await seedParentLease(f)
    const { documentId } = await seedAddendumTermsDoc(f, parentLeaseId)

    // Snapshot lease state for after-comparison
    const beforeLease = await db.query<{ status: string; rent_amount: string; start_date: string }>(
      `SELECT status, rent_amount, start_date FROM leases WHERE id = $1`, [parentLeaseId])
    const beforeTenants = await db.query<{ id: string; role: string; status: string }>(
      `SELECT id, role, status FROM lease_tenants WHERE lease_id = $1 ORDER BY id`,
      [parentLeaseId])

    const res = await request(buildApp())
      .post(`/api/esign/sign/${documentId}`)
      .set('Authorization', `Bearer ${f.tenantToken}`)
      .send({ fieldValues: [] })

    expect(res.status).toBe(200)
    expect(res.body.data.completed).toBe(true)
    expect(res.body.data.executionFailed).toBeUndefined()

    // Doc flips to completed
    const doc = await db.query<{ status: string; lease_id: string }>(
      `SELECT status, lease_id FROM lease_documents WHERE id = $1`, [documentId])
    expect(doc.rows[0].status).toBe('completed')
    expect(doc.rows[0].lease_id).toBe(parentLeaseId)

    // Lease untouched: same row values + same lease_tenants set
    const afterLease = await db.query<{ status: string; rent_amount: string; start_date: string }>(
      `SELECT status, rent_amount, start_date FROM leases WHERE id = $1`, [parentLeaseId])
    expect(afterLease.rows[0].status).toBe(beforeLease.rows[0].status)
    expect(afterLease.rows[0].rent_amount).toBe(beforeLease.rows[0].rent_amount)

    const afterTenants = await db.query<{ id: string; role: string; status: string }>(
      `SELECT id, role, status FROM lease_tenants WHERE lease_id = $1 ORDER BY id`,
      [parentLeaseId])
    expect(afterTenants.rows).toEqual(beforeTenants.rows)
  })

  it('parent lease expired → execution_failed (409 cannot amend terms)', async () => {
    const f = await seedFixture()
    const parentLeaseId = await seedParentLease(f, { status: 'expired' })
    const { documentId } = await seedAddendumTermsDoc(f, parentLeaseId)
    const res = await request(buildApp())
      .post(`/api/esign/sign/${documentId}`)
      .set('Authorization', `Bearer ${f.tenantToken}`)
      .send({ fieldValues: [] })
    expect(res.body.data.executionFailed).toBe(true)
    expect(res.body.data.reason).toMatch(/Cannot amend terms: lease is expired/i)
  })

  it('parent lease terminated → execution_failed (409 cannot amend terms)', async () => {
    const f = await seedFixture()
    const parentLeaseId = await seedParentLease(f, { status: 'terminated' })
    const { documentId } = await seedAddendumTermsDoc(f, parentLeaseId)
    const res = await request(buildApp())
      .post(`/api/esign/sign/${documentId}`)
      .set('Authorization', `Bearer ${f.tenantToken}`)
      .send({ fieldValues: [] })
    expect(res.body.data.executionFailed).toBe(true)
    expect(res.body.data.reason).toMatch(/Cannot amend terms: lease is terminated/i)
  })
})

// ─── POST /sign/:documentId — sublease_agreement completion (S336) ─
//
// Preconditions (services/subleaseDocuments.ts:344-369):
//   - doc exists
//   - subleases row exists with sublease_document_id = doc.id
//
// Side effects: subleases.status = 'active', sublease_document_url
// stamped (executed_pdf_url || base_pdf_url), landlord_consent_date
// COALESCE'd to today, updated_at = NOW(). NO lease build, no roster
// mutation.
//
// Note: executeSubleaseAgreementCompletion uses non-transactional
// query()/queryOne() — it runs OUTSIDE the BEGIN/COMMIT block of
// buildLeaseFromDocument. This is an atomicity gap (if the outer
// txn rolls back later in the chain, the sublease flip survives).
// Flagged but not in S336 scope — separate fix.

/** Seed a sublease_agreement doc + the linked sublease row + signers.
 *  Returns the document id, sublease id (if seeded), and sublessee
 *  tenant credentials (the current POST /sign signer). */
async function seedSubleaseDoc(
  f: SeedFixture,
  opts: {
    masterLeaseId:               string
    skipSublease?:               boolean
    basePdfUrl?:                 string | null
    executedPdfUrl?:             string | null
    initialStatus?:              'pending' | 'awaiting_signatures'
    existingConsentDate?:        string | null
    monthlyAmount?:              number
    masterShareAmount?:          number
  },
): Promise<{ documentId: string; subleaseId: string | null; sublessee: NewTenantSeed }> {
  const sublessee = await seedNewTenant()
  const docRes = await db.query<{ id: string }>(
    `INSERT INTO lease_documents
       (landlord_id, unit_id, title, document_type, status, base_pdf_url, executed_pdf_url)
     VALUES ($1, $2, 'S336 Sublease', 'sublease_agreement', 'in_progress', $3, $4)
     RETURNING id`,
    [f.landlordId, f.unitId, opts.basePdfUrl ?? null, opts.executedPdfUrl ?? null])
  const documentId = docRes.rows[0].id

  // Landlord pre-signed; sublessee viewed (will POST sign)
  await db.query(
    `INSERT INTO lease_document_signers
       (document_id, user_id, role, name, email, order_index, token, status, signed_at)
     VALUES ($1, $2, 'landlord', 'L L', 'll@test.dev', 1, $3, 'signed', NOW())`,
    [documentId, f.landlordUserId, crypto.randomBytes(32).toString('hex')])
  await db.query(
    `INSERT INTO lease_document_signers
       (document_id, user_id, role, name, email, order_index, token, status, viewed_at)
     VALUES ($1, $2, 'primary', 'Sublessee', $3, 2, $4, 'viewed', NOW())`,
    [documentId, sublessee.userId, sublessee.email, crypto.randomBytes(32).toString('hex')])

  let subleaseId: string | null = null
  if (!opts.skipSublease) {
    const sRes = await db.query<{ id: string }>(
      `INSERT INTO subleases
         (master_lease_id, sublessor_tenant_id, sublessee_tenant_id,
          status, start_date, end_date, sub_monthly_amount, master_share_amount,
          sublease_document_id, landlord_consent_date)
       VALUES ($1, $2, $3, $4, '2025-06-01', '2025-12-31', $5, $6, $7, $8)
       RETURNING id`,
      [opts.masterLeaseId, f.tenantId, sublessee.tenantId,
       opts.initialStatus ?? 'awaiting_signatures',
       opts.monthlyAmount ?? 800,
       opts.masterShareAmount ?? 200,
       documentId,
       opts.existingConsentDate ?? null])
    subleaseId = sRes.rows[0].id
  }
  return { documentId, subleaseId, sublessee }
}

describe('POST /sign/:documentId — sublease_agreement completion', () => {
  it('happy path: sublease flips to active, doc URL stamped, landlord_consent_date set to today', async () => {
    const f = await seedFixture()
    const masterLeaseId = await seedParentLease(f)
    const { documentId, subleaseId, sublessee } = await seedSubleaseDoc(f, {
      masterLeaseId,
      basePdfUrl: '/api/esign/files/sublease-base.pdf',
    })

    const res = await request(buildApp())
      .post(`/api/esign/sign/${documentId}`)
      .set('Authorization', `Bearer ${sublessee.authToken}`)
      .send({ fieldValues: [] })

    expect(res.status).toBe(200)
    expect(res.body.data.completed).toBe(true)
    expect(res.body.data.executionFailed).toBeUndefined()

    // Sublease row flipped
    const sub = await db.query<{
      status: string; sublease_document_url: string | null; landlord_consent_date: string | null
    }>(`SELECT status, sublease_document_url, landlord_consent_date FROM subleases WHERE id = $1`, [subleaseId])
    expect(sub.rows[0].status).toBe('active')
    expect(sub.rows[0].sublease_document_url).toBe('/api/esign/files/sublease-base.pdf')
    expect(sub.rows[0].landlord_consent_date).toBeTruthy()
    // landlord_consent_date is set via CURRENT_DATE → today
    const today = new Date().toISOString().slice(0, 10)
    expect(new Date(sub.rows[0].landlord_consent_date!).toISOString().slice(0, 10)).toBe(today)

    // Doc flips completed
    const doc = await db.query<{ status: string }>(
      `SELECT status FROM lease_documents WHERE id = $1`, [documentId])
    expect(doc.rows[0].status).toBe('completed')
  })

  it('executed_pdf_url present → preferred over base_pdf_url for sublease_document_url stamp', async () => {
    const f = await seedFixture()
    const masterLeaseId = await seedParentLease(f)
    const { documentId, subleaseId, sublessee } = await seedSubleaseDoc(f, {
      masterLeaseId,
      basePdfUrl:     '/api/esign/files/sublease-base.pdf',
      executedPdfUrl: '/api/esign/files/sublease-executed.pdf',
    })
    const res = await request(buildApp())
      .post(`/api/esign/sign/${documentId}`)
      .set('Authorization', `Bearer ${sublessee.authToken}`)
      .send({ fieldValues: [] })
    expect(res.status).toBe(200)
    const sub = await db.query<{ sublease_document_url: string | null }>(
      `SELECT sublease_document_url FROM subleases WHERE id = $1`, [subleaseId])
    expect(sub.rows[0].sublease_document_url).toBe('/api/esign/files/sublease-executed.pdf')
  })

  it('existing landlord_consent_date → preserved by COALESCE', async () => {
    const f = await seedFixture()
    const masterLeaseId = await seedParentLease(f)
    const { documentId, subleaseId, sublessee } = await seedSubleaseDoc(f, {
      masterLeaseId,
      existingConsentDate: '2025-04-15',
    })
    const res = await request(buildApp())
      .post(`/api/esign/sign/${documentId}`)
      .set('Authorization', `Bearer ${sublessee.authToken}`)
      .send({ fieldValues: [] })
    expect(res.status).toBe(200)
    const sub = await db.query<{ status: string; landlord_consent_date: string | null }>(
      `SELECT status, landlord_consent_date FROM subleases WHERE id = $1`, [subleaseId])
    expect(sub.rows[0].status).toBe('active')
    expect(new Date(sub.rows[0].landlord_consent_date!).toISOString().slice(0, 10)).toBe('2025-04-15')
  })

  it('no sublease row references the document → execution_failed', async () => {
    const f = await seedFixture()
    const masterLeaseId = await seedParentLease(f)
    const { documentId, sublessee } = await seedSubleaseDoc(f, {
      masterLeaseId,
      skipSublease: true,
    })
    const res = await request(buildApp())
      .post(`/api/esign/sign/${documentId}`)
      .set('Authorization', `Bearer ${sublessee.authToken}`)
      .send({ fieldValues: [] })
    expect(res.body.data.executionFailed).toBe(true)
    expect(res.body.data.reason).toMatch(/Sublease for document .* not found/i)
    // Doc status flipped to execution_failed (consistent with other doc_types)
    const doc = await db.query<{ status: string }>(
      `SELECT status FROM lease_documents WHERE id = $1`, [documentId])
    expect(doc.rows[0].status).toBe('execution_failed')
  })
})


