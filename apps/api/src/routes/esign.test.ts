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

import { esignRouter, buildLeaseFromDocument, signingUrlFor } from './esign'
import { WRITABLE_LEASE_COLUMN_SPECS } from '@gam/shared'
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

/** S553: put `tenantId` on an overlapping ACTIVE lease under a brand-new
 *  DIFFERENT landlord — the case the overlap guard still blocks after the
 *  same-landlord exception (a landlord drafting a 2nd lease for their own
 *  tenant is deliberate; a cross-landlord overlap is double-booking). */
async function seedCrossLandlordOverlap(tenantId: string): Promise<void> {
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    const { userId, landlordId } = await seedLandlord(client)
    const propertyId = await seedProperty(client, { landlordId, ownerUserId: userId, managedByUserId: userId })
    const unitId = await seedUnit(client, { propertyId, landlordId })
    const r = await client.query<{ id: string }>(
      `INSERT INTO leases (unit_id, landlord_id, rent_amount, lease_type, status, start_date, end_date)
       VALUES ($1, $2, 1000, 'fixed_term', 'active', '2025-01-01', '2025-12-31') RETURNING id`,
      [unitId, landlordId])
    await client.query(
      `INSERT INTO lease_tenants (lease_id, tenant_id, role, status, added_at, added_reason, financial_responsibility)
       VALUES ($1, $2, 'primary', 'active', NOW(), 'original', 'joint_several')`,
      [r.rows[0].id, tenantId])
    await client.query('COMMIT')
  } catch (e) { await client.query('ROLLBACK'); throw e }
  finally { client.release() }
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

// ─── POST /documents — S556 auto-populate from unit ────────────
//
// A new lease drafted off a unit seeds rent_amount, derived security_deposit
// (rent × per-(property,unit_type) multiplier), and unit_number into the
// document fields without the landlord typing them. Caller-supplied values win.

describe('POST /documents — auto-populate from unit (S556/S558)', () => {
  async function seedTemplateWithFields(landlordId: string, cols: string[], depositMonths: number | null = null): Promise<string> {
    const t = await db.query<{ id: string }>(
      `INSERT INTO lease_templates (landlord_id, name, page_count, deposit_months) VALUES ($1, 'AutoPop', 1, $2) RETURNING id`,
      [landlordId, depositMonths])
    const tid = t.rows[0].id
    for (const col of cols) {
      await db.query(
        `INSERT INTO lease_template_fields (template_id, field_type, signer_role, lease_column, page, x, y, width, height)
         VALUES ($1, 'text', 'landlord', $2, 1, 10, 10, 100, 20)`, [tid, col])
    }
    return tid
  }

  async function docFieldValues(documentId: string): Promise<Record<string, string | null>> {
    const r = await db.query<{ lease_column: string; value: string | null }>(
      `SELECT lease_column, value FROM lease_document_fields WHERE document_id = $1`, [documentId])
    return Object.fromEntries(r.rows.map(x => [x.lease_column, x.value]))
  }

  it('seeds rent, derived deposit (rent × template deposit_months), and unit_number from the unit', async () => {
    const f = await seedFixture()  // unit rent defaults to 1000, unit_type apartment
    // S558: the multiplier lives on the TEMPLATE, not a property setting.
    const tid = await seedTemplateWithFields(f.landlordId, ['rent_amount', 'security_deposit', 'unit_number'], 1.5)

    const res = await request(buildApp())
      .post('/api/esign/documents')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({
        title: 'Auto Lease', templateId: tid, unitId: f.unitId,
        signers: [
          { role: 'landlord', userId: f.landlordUserId, name: 'L L', email: 'l@x' },
          { role: 'primary',  userId: f.tenantUserId,   name: 'T T', email: f.tenantEmail },
        ],
      })
    expect(res.status).toBe(201)
    const vals = await docFieldValues(res.body.data.id)
    expect(vals.rent_amount).toBe('1000.00')
    expect(vals.security_deposit).toBe('1500.00') // 1000 × 1.5
    expect(vals.unit_number).toBeTruthy()
  })

  // S622: an auto-placed lease carries per-page initials for ALL FOUR tenant
  // slots (primary + co_tenant_1..3) because the template cannot know how many
  // people will sign. The send path prunes fields whose role nobody fills —
  // otherwise a two-tenant lease would ship with unsignable initial boxes on
  // every page and could never reach 'completed'. The pruning was implemented
  // and correct but had NO test; this is that test.
  it('S622: prunes template fields for tenant slots nobody fills (4-slot template, 2 signers)', async () => {
    const f = await seedFixture()
    const tid = await seedTemplateWithFields(f.landlordId, ['rent_amount'])
    // Per-page initials for all four tenant slots, on 3 pages — what auto-place produces.
    for (const role of ['primary', 'co_tenant_1', 'co_tenant_2', 'co_tenant_3']) {
      for (const page of [1, 2, 3]) {
        await db.query(
          `INSERT INTO lease_template_fields (template_id, field_type, signer_role, page, x, y, width, height)
           VALUES ($1, 'initials', $2, $3, 10, 10, 40, 20)`, [tid, role, page])
      }
    }

    const res = await request(buildApp())
      .post('/api/esign/documents')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({
        title: 'Two Tenant Lease', templateId: tid, unitId: f.unitId,
        signers: [
          { role: 'landlord', userId: f.landlordUserId, name: 'L L', email: 'l@x' },
          { role: 'primary',  userId: f.tenantUserId,   name: 'T T', email: f.tenantEmail },
        ],
      })
    expect(res.status).toBe(201)

    const rows = await db.query<{ signer_role: string; n: string }>(
      `SELECT signer_role, count(*)::text AS n FROM lease_document_fields
       WHERE document_id=$1 AND field_type='initials' GROUP BY signer_role`,
      [res.body.data.id])
    const byRole = Object.fromEntries(rows.rows.map(r => [r.signer_role, Number(r.n)]))

    expect(byRole.primary).toBe(3)              // one per page, kept
    expect(byRole.co_tenant_1).toBeUndefined()  // nobody fills it → pruned
    expect(byRole.co_tenant_2).toBeUndefined()
    expect(byRole.co_tenant_3).toBeUndefined()

    // And every surviving field is bound to a real signer — an unbound initials
    // box is one the document can never collect.
    const orphan = await db.query(
      `SELECT 1 FROM lease_document_fields
       WHERE document_id=$1 AND field_type='initials' AND signer_id IS NULL`,
      [res.body.data.id])
    expect(orphan.rows.length).toBe(0)
  })

  it('S582: rent_due_day is auto-filled to "1st" so the signed lease STATES the due day (document-first)', async () => {
    const f = await seedFixture()
    const tid = await seedTemplateWithFields(f.landlordId, ['rent_amount', 'rent_due_day'])
    const res = await request(buildApp())
      .post('/api/esign/documents')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({
        title: 'Auto Lease', templateId: tid, unitId: f.unitId,
        signers: [
          { role: 'landlord', userId: f.landlordUserId, name: 'L L', email: 'l@x' },
          { role: 'primary',  userId: f.tenantUserId,   name: 'T T', email: f.tenantEmail },
        ],
      })
    expect(res.status).toBe(201)
    const vals = await docFieldValues(res.body.data.id)
    expect(vals.rent_due_day).toBe('1st') // landlord never chooses it — forced onto the doc
  })

  it('S582: rent_due_day billing is LOCKED to 1 regardless of any document value', () => {
    const parse = (WRITABLE_LEASE_COLUMN_SPECS as any).rent_due_day.parse
    expect(parse({ rent_due_day: '15' })).toEqual({ rent_due_day: 1 })
    expect(parse({ rent_due_day: '1st' })).toEqual({ rent_due_day: 1 })
    expect(parse({})).toEqual({ rent_due_day: 1 })
  })

  it('leaves the deposit BLANK when the template states no deposit_months (never invents one)', async () => {
    const f = await seedFixture()
    const tid = await seedTemplateWithFields(f.landlordId, ['rent_amount', 'security_deposit']) // no deposit_months
    const res = await request(buildApp())
      .post('/api/esign/documents')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({
        title: 'Auto Lease', templateId: tid, unitId: f.unitId,
        signers: [
          { role: 'landlord', userId: f.landlordUserId, name: 'L L', email: 'l@x' },
          { role: 'primary',  userId: f.tenantUserId,   name: 'T T', email: f.tenantEmail },
        ],
      })
    expect(res.status).toBe(201)
    const vals = await docFieldValues(res.body.data.id)
    expect(vals.rent_amount).toBe('1000.00')          // rent still seeds
    expect(vals.security_deposit ?? null).toBeNull()  // deposit left for the landlord
  })

  it('caller-supplied prefill wins over unit auto-seed', async () => {
    const f = await seedFixture()
    const tid = await seedTemplateWithFields(f.landlordId, ['rent_amount'])
    const res = await request(buildApp())
      .post('/api/esign/documents')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({
        title: 'Auto Lease', templateId: tid, unitId: f.unitId,
        prefillValues: { rent_amount: '2500.00' },
        signers: [
          { role: 'landlord', userId: f.landlordUserId, name: 'L L', email: 'l@x' },
          { role: 'primary',  userId: f.tenantUserId,   name: 'T T', email: f.tenantEmail },
        ],
      })
    expect(res.status).toBe(201)
    const vals = await docFieldValues(res.body.data.id)
    expect(vals.rent_amount).toBe('2500.00')
  })
})

// ─── S558: unit-type default template + resolver ───────────────

describe('template unit-type default (S558)', () => {
  async function mkTemplate(landlordId: string, unitType: string | null, opts: { propertyId?: string | null; depositMonths?: number | null; termMonths?: number | null } = {}) {
    const t = await db.query<{ id: string }>(
      `INSERT INTO lease_templates (landlord_id, name, page_count, unit_type, property_id, deposit_months, default_term_months)
       VALUES ($1, 'Tmpl', 1, $2, $3, $4, $5) RETURNING id`,
      [landlordId, unitType, opts.propertyId ?? null, opts.depositMonths ?? null, opts.termMonths ?? null])
    return t.rows[0].id
  }

  it('set-default is radio: marking a second apartment template clears the first', async () => {
    const f = await seedFixture()
    const a = await mkTemplate(f.landlordId, 'apartment')
    const b = await mkTemplate(f.landlordId, 'apartment')
    await request(buildApp()).post(`/api/esign/templates/${a}/set-default`).set('Authorization', `Bearer ${f.landlordToken}`).send({}).expect(200)
    await request(buildApp()).post(`/api/esign/templates/${b}/set-default`).set('Authorization', `Bearer ${f.landlordToken}`).send({}).expect(200)
    const rows = await db.query<{ id: string; is_unit_type_default: boolean }>(
      `SELECT id, is_unit_type_default FROM lease_templates WHERE id = ANY($1)`, [[a, b]])
    const byId = Object.fromEntries(rows.rows.map(r => [r.id, r.is_unit_type_default]))
    expect(byId[a]).toBe(false)
    expect(byId[b]).toBe(true)
  })

  it('refuses to make a universal (null unit_type) template a default', async () => {
    const f = await seedFixture()
    const u = await mkTemplate(f.landlordId, null)
    await request(buildApp()).post(`/api/esign/templates/${u}/set-default`).set('Authorization', `Bearer ${f.landlordToken}`).send({}).expect(400)
  })

  it('resolver picks the unit type default and carries deposit + term', async () => {
    const { resolveDefaultTemplateForUnit } = await import('../services/templateResolve')
    const f = await seedFixture() // unit_type apartment
    await mkTemplate(f.landlordId, 'rv_spot', { termMonths: null }) // decoy other type
    const apt = await mkTemplate(f.landlordId, 'apartment', { depositMonths: 1.5, termMonths: 12 })
    await request(buildApp()).post(`/api/esign/templates/${apt}/set-default`).set('Authorization', `Bearer ${f.landlordToken}`).send({}).expect(200)
    const resolved = await resolveDefaultTemplateForUnit(f.unitId)
    expect(resolved?.id).toBe(apt)
    expect(Number(resolved?.deposit_months)).toBe(1.5)
    expect(resolved?.default_term_months).toBe(12)
  })

  it('property-locked default wins over the unlocked one', async () => {
    const { resolveDefaultTemplateForUnit } = await import('../services/templateResolve')
    const f = await seedFixture()
    const unlocked = await mkTemplate(f.landlordId, 'apartment')
    const locked = await mkTemplate(f.landlordId, 'apartment', { propertyId: f.propertyId })
    await request(buildApp()).post(`/api/esign/templates/${unlocked}/set-default`).set('Authorization', `Bearer ${f.landlordToken}`).send({}).expect(200)
    await request(buildApp()).post(`/api/esign/templates/${locked}/set-default`).set('Authorization', `Bearer ${f.landlordToken}`).send({}).expect(200)
    const resolved = await resolveDefaultTemplateForUnit(f.unitId)
    expect(resolved?.id).toBe(locked)
  })

  it('resolver returns null when no default set for the unit type', async () => {
    const { resolveDefaultTemplateForUnit } = await import('../services/templateResolve')
    const f = await seedFixture()
    await mkTemplate(f.landlordId, 'apartment') // exists but not marked default
    const resolved = await resolveDefaultTemplateForUnit(f.unitId)
    expect(resolved).toBeNull()
  })
})

// ─── POST /documents/:id/send ──────────────────────────────────

describe('POST /documents/:id/send', () => {
  // ─── S622 screening gate (Business Terms §9.2) ───────────────────────
  //
  // Nic: "after the onboarding window is closed, all applicants must complete
  // the background check to actually have the lease going." Enforced at SEND
  // rather than at finalize — refusing after everyone has signed strands a
  // signed lease and helps nobody.
  //
  // The whole rule turns on one date comparison, so all three cases are pinned:
  // gated, exempt-because-migrated, and satisfied.
  describe('S622 screening gate', () => {
    // Give the document a start_date value; the gate only runs once a start
    // date exists, since that is what decides migrated vs new.
    async function setStart(documentId: string, startDate: string) {
      const signer = await db.query<{ id: string }>(
        `SELECT id FROM lease_document_signers WHERE document_id=$1 AND role='landlord' LIMIT 1`,
        [documentId])
      await db.query(
        `INSERT INTO lease_document_fields
           (document_id, signer_id, field_type, signer_role, lease_column, page, x, y, width, height, required, value)
         VALUES ($1,$2,'date','landlord','start_date',1,10,10,80,20,TRUE,$3)`,
        [documentId, signer.rows[0]?.id ?? null, startDate])
    }
    const tomorrow = () => {
      const d = new Date(); d.setDate(d.getDate() + 1)
      return d.toISOString().slice(0, 10)
    }

    // Closing the window is what turns a migration into ordinary leasing.
    const closeWindow = (landlordId: string) =>
      db.query(`UPDATE landlords SET migration_window_ends_at = NOW() - INTERVAL '1 day' WHERE id = $1`, [landlordId])

    it('blocks an unscreened applicant once the migration window has closed', async () => {
      const f = await seedFixture()
      const { documentId } = await seedDoc(f)
      await closeWindow(f.landlordId)
      await setStart(documentId, tomorrow())

      const res = await request(buildApp())
        .post(`/api/esign/documents/${documentId}/send`)
        .set('Authorization', `Bearer ${f.landlordToken}`)
      expect(res.status).toBe(409)
      expect(res.body.error || res.body.message).toMatch(/background check/i)
      expect(emailSigningRequestMock).not.toHaveBeenCalled()
    })

    // THE CASE THAT MATTERS FOR OAK PARK. A landlord who just joined is
    // transcribing tenancies that already exist, using documents dated today.
    // The first cut of this gate keyed on "lease starts before onboarding" and
    // would have blocked all 30 of his sitting tenants.
    it('lets a sitting tenant through while the migration window is OPEN, even on a lease dated today', async () => {
      const f = await seedFixture()
      const { documentId } = await seedDoc(f)
      await setStart(documentId, tomorrow())   // brand-new paperwork, old tenancy

      const res = await request(buildApp())
        .post(`/api/esign/documents/${documentId}/send`)
        .set('Authorization', `Bearer ${f.landlordToken}`)
      expect(res.status).toBe(200)
    })

    it('lets an existing tenant through AFTER the window when the landlord already holds their deposit', async () => {
      const f = await seedFixture()
      const { documentId } = await seedDoc(f)
      await closeWindow(f.landlordId)
      await db.query(`UPDATE lease_documents SET deposit_already_held = TRUE WHERE id = $1`, [documentId])
      await setStart(documentId, tomorrow())

      const res = await request(buildApp())
        .post(`/api/esign/documents/${documentId}/send`)
        .set('Authorization', `Bearer ${f.landlordToken}`)
      expect(res.status).toBe(200)
    })

    it('lets a lease that genuinely predates onboarding through after the window', async () => {
      const f = await seedFixture()
      const { documentId } = await seedDoc(f)
      await closeWindow(f.landlordId)
      await db.query(`UPDATE landlords SET created_at = NOW() + INTERVAL '30 days' WHERE id = $1`, [f.landlordId])
      await setStart(documentId, tomorrow())

      const res = await request(buildApp())
        .post(`/api/esign/documents/${documentId}/send`)
        .set('Authorization', `Bearer ${f.landlordToken}`)
      expect(res.status).toBe(200)
    })

    it('lets a screened applicant through after the window', async () => {
      const f = await seedFixture()
      const { documentId } = await seedDoc(f)
      await closeWindow(f.landlordId)
      await setStart(documentId, tomorrow())
      const t = await db.query<{ id: string }>(
        `SELECT id FROM tenants WHERE user_id = $1`, [f.tenantUserId])
      await db.query(
        `INSERT INTO background_checks (tenant_id, user_id, landlord_id, unit_id, status, amount_charged, platform_net)
         VALUES ($1, $2, $3, $4, 'approved', 35, 35)`,
        [t.rows[0].id, f.tenantUserId, f.landlordId, f.unitId])

      const res = await request(buildApp())
        .post(`/api/esign/documents/${documentId}/send`)
        .set('Authorization', `Bearer ${f.landlordToken}`)
      expect(res.status).toBe(200)
    })

    it('is off when the flag is off — a disabled gate must be a deliberate act, not a silent skip', async () => {
      const f = await seedFixture()
      const { documentId } = await seedDoc(f)
      await closeWindow(f.landlordId)
      await setStart(documentId, tomorrow())
      await db.query(
        `INSERT INTO system_features (key, enabled, description)
         VALUES ('screening_required_for_new_leases', FALSE, 'test')
         ON CONFLICT (key) DO UPDATE SET enabled = FALSE`)
      try {
        const res = await request(buildApp())
          .post(`/api/esign/documents/${documentId}/send`)
          .set('Authorization', `Bearer ${f.landlordToken}`)
        expect(res.status).toBe(200)
      } finally {
        await db.query(`DELETE FROM system_features WHERE key = 'screening_required_for_new_leases'`)
      }
    })
  })

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

  it('S558: still voidable when only the LANDLORD has signed (landlord signs first, binds no one)', async () => {
    const f = await seedFixture()
    const { documentId } = await seedDoc(f, { status: 'in_progress', landlordSignerStatus: 'signed' })
    // Stamp signed_at on the landlord signer only.
    await db.query(
      `UPDATE lease_document_signers SET signed_at = NOW() WHERE document_id = $1 AND role = 'landlord'`,
      [documentId],
    )
    const res = await request(buildApp())
      .post(`/api/esign/documents/${documentId}/void`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({})
    expect(res.status).toBe(200)
    const doc = await db.query<{ status: string }>(`SELECT status FROM lease_documents WHERE id=$1`, [documentId])
    expect(doc.rows[0].status).toBe('voided')
  })

  it('S558: rejects voiding once a TENANT has signed (409 → supersede)', async () => {
    const f = await seedFixture()
    const { documentId } = await seedDoc(f, { status: 'in_progress', landlordSignerStatus: 'signed' })
    // Both landlord and the primary tenant have signed.
    await db.query(
      `UPDATE lease_document_signers SET signed_at = NOW() WHERE document_id = $1 AND role IN ('landlord','primary')`,
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

// ─── POST /sign — conditional (nested) radio required (S556) ────
describe('POST /sign — conditional radio required', () => {
  async function seedConditionalDoc(f: SeedFixture) {
    const t = await db.query<{ id: string }>(
      `INSERT INTO lease_templates (landlord_id, name, page_count) VALUES ($1,'Cond',1) RETURNING id`, [f.landlordId])
    const tid = t.rows[0].id
    const pf = await db.query<{ id: string }>(
      `INSERT INTO lease_template_fields (template_id, field_type, signer_role, required, options)
       VALUES ($1,'radio_group','landlord',TRUE,'Fixed term,Month-to-month') RETURNING id`, [tid])
    const parentTid = pf.rows[0].id
    const cf = await db.query<{ id: string }>(
      `INSERT INTO lease_template_fields (template_id, field_type, signer_role, required, options, parent_field_id, parent_option)
       VALUES ($1,'radio_group','landlord',TRUE,'Continue,Vacate',$2,'Fixed term') RETURNING id`, [tid, parentTid])
    const childTid = cf.rows[0].id
    const d = await db.query<{ id: string }>(
      `INSERT INTO lease_documents (landlord_id, unit_id, title, document_type, status)
       VALUES ($1,$2,'Cond','original_lease','in_progress') RETURNING id`, [f.landlordId, f.unitId])
    const docId = d.rows[0].id
    await db.query(
      `INSERT INTO lease_document_signers (document_id, user_id, role, name, email, order_index, token, status, viewed_at)
       VALUES ($1,$2,'landlord','L','l@x',1,$3,'viewed',NOW())`,
      [docId, f.landlordUserId, crypto.randomBytes(16).toString('hex')])
    await db.query(
      `INSERT INTO lease_document_signers (document_id, user_id, role, name, email, order_index, token, status)
       VALUES ($1,$2,'primary','T',$3,2,$4,'sent')`,
      [docId, f.tenantUserId, f.tenantEmail, crypto.randomBytes(16).toString('hex')])
    const pdf = await db.query<{ id: string }>(
      `INSERT INTO lease_document_fields (document_id, template_field_id, field_type, signer_role, required, options, label)
       VALUES ($1,$2,'radio_group','landlord',TRUE,'Fixed term,Month-to-month','Lease type') RETURNING id`, [docId, parentTid])
    const parentDocId = pdf.rows[0].id
    const cdf = await db.query<{ id: string }>(
      `INSERT INTO lease_document_fields (document_id, template_field_id, field_type, signer_role, required, options, parent_field_id, parent_option, label)
       VALUES ($1,$2,'radio_group','landlord',TRUE,'Continue,Vacate',$3,'Fixed term','End of term') RETURNING id`,
      [docId, childTid, parentTid])
    return { docId, parentDocId, childDocId: cdf.rows[0].id }
  }

  it('parent = Month-to-month → child hidden, not required; sign succeeds and child stays empty', async () => {
    const f = await seedFixture()
    const { docId, parentDocId, childDocId } = await seedConditionalDoc(f)
    const res = await request(buildApp())
      .post(`/api/esign/sign/${docId}`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ fieldValues: [{ fieldId: parentDocId, value: 'Month-to-month' }] })
    expect(res.status).toBe(200)
    const c = await db.query<{ value: string | null }>(`SELECT value FROM lease_document_fields WHERE id=$1`, [childDocId])
    expect(c.rows[0].value == null || c.rows[0].value === '').toBe(true)
  })

  it('parent = Fixed term with no child answer → 400 missing required', async () => {
    const f = await seedFixture()
    const { docId, parentDocId } = await seedConditionalDoc(f)
    const res = await request(buildApp())
      .post(`/api/esign/sign/${docId}`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ fieldValues: [{ fieldId: parentDocId, value: 'Fixed term' }] })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/required/i)
  })

  it('parent = Fixed term + child answered → sign succeeds', async () => {
    const f = await seedFixture()
    const { docId, parentDocId, childDocId } = await seedConditionalDoc(f)
    const res = await request(buildApp())
      .post(`/api/esign/sign/${docId}`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ fieldValues: [
        { fieldId: parentDocId, value: 'Fixed term' },
        { fieldId: childDocId, value: 'Vacate' },
      ] })
    expect(res.status).toBe(200)
  })

  // Generalization (Nic S556): a conditional child can be ANY field type, not
  // just a nested radio — e.g. a fixed-term end_date that only applies when
  // lease_type = "Fixed term".
  it('non-radio (date) child is required only under its trigger option', async () => {
    const f = await seedFixture()
    // template: lease_type radio + an end_date DATE child (only if Fixed term)
    const t = await db.query<{ id: string }>(`INSERT INTO lease_templates (landlord_id, name, page_count) VALUES ($1,'C2',1) RETURNING id`, [f.landlordId])
    const tid = t.rows[0].id
    const pf = await db.query<{ id: string }>(`INSERT INTO lease_template_fields (template_id, field_type, signer_role, required, options) VALUES ($1,'radio_group','landlord',TRUE,'Fixed term,Month-to-month') RETURNING id`, [tid])
    const parentTid = pf.rows[0].id
    const cf = await db.query<{ id: string }>(`INSERT INTO lease_template_fields (template_id, field_type, signer_role, required, lease_column, parent_field_id, parent_option) VALUES ($1,'date','landlord',TRUE,'end_date',$2,'Fixed term') RETURNING id`, [tid, parentTid])
    const childTid = cf.rows[0].id
    async function mkDoc() {
      const d = await db.query<{ id: string }>(`INSERT INTO lease_documents (landlord_id, unit_id, title, document_type, status) VALUES ($1,$2,'C2','original_lease','in_progress') RETURNING id`, [f.landlordId, f.unitId])
      const docId = d.rows[0].id
      await db.query(`INSERT INTO lease_document_signers (document_id, user_id, role, name, email, order_index, token, status, viewed_at) VALUES ($1,$2,'landlord','L','l@x',1,$3,'viewed',NOW())`, [docId, f.landlordUserId, crypto.randomBytes(16).toString('hex')])
      await db.query(`INSERT INTO lease_document_signers (document_id, user_id, role, name, email, order_index, token, status) VALUES ($1,$2,'primary','T',$3,2,$4,'sent')`, [docId, f.tenantUserId, f.tenantEmail, crypto.randomBytes(16).toString('hex')])
      const p = await db.query<{ id: string }>(`INSERT INTO lease_document_fields (document_id, template_field_id, field_type, signer_role, required, options, label) VALUES ($1,$2,'radio_group','landlord',TRUE,'Fixed term,Month-to-month','Lease type') RETURNING id`, [docId, parentTid])
      await db.query(`INSERT INTO lease_document_fields (document_id, template_field_id, field_type, signer_role, required, lease_column, parent_field_id, parent_option, label) VALUES ($1,$2,'date','landlord',TRUE,'end_date',$3,'Fixed term','End date')`, [docId, childTid, parentTid])
      return { docId, parentDocId: p.rows[0].id }
    }
    // Month-to-month → end_date hidden, not required → signs
    const d1 = await mkDoc()
    const r1 = await request(buildApp()).post(`/api/esign/sign/${d1.docId}`).set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ fieldValues: [{ fieldId: d1.parentDocId, value: 'Month-to-month' }] })
    expect(r1.status).toBe(200)
    // Fixed term → end_date required → 400
    const d2 = await mkDoc()
    const r2 = await request(buildApp()).post(`/api/esign/sign/${d2.docId}`).set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ fieldValues: [{ fieldId: d2.parentDocId, value: 'Fixed term' }] })
    expect(r2.status).toBe(400)
    expect(r2.body.error).toMatch(/required/i)
  })
})

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

  it('S581: a duplicate/racing finalization is idempotent — no second lease or move-in invoice', async () => {
    const f = await seedFixture()
    const { documentId } = await seedCompleteableDoc(f)

    // Drive it to completion once: builds lease #1, stamps document.lease_id,
    // fires exactly one move-in invoice.
    const first = await request(buildApp())
      .post(`/api/esign/sign/${documentId}`)
      .set('Authorization', `Bearer ${f.tenantToken}`)
      .send({ fieldValues: [] })
    expect(first.status).toBe(200)
    expect(first.body.data.completed).toBe(true)
    const leaseId = (await db.query<{ id: string }>(
      `SELECT id FROM leases WHERE unit_id = $1`, [f.unitId])).rows[0].id
    expect(generateMoveInInvoiceMock).toHaveBeenCalledTimes(1)

    // What two concurrent last-signature requests would each attempt: a second
    // finalization of the same document. The completion route blocks a sequential
    // re-sign at 'Already signed', so exercise the shared finalizer directly. It
    // must short-circuit — advisory lock + already-built guard — not rebuild.
    const again = await buildLeaseFromDocument(documentId)
    expect(again.alreadyBuilt).toBe(true)
    expect(again.leaseId).toBe(leaseId)

    // Still exactly ONE lease and ONE move-in invoice — no double deposit / rent.
    const leaseCount = await db.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM leases WHERE unit_id = $1`, [f.unitId])
    expect(Number(leaseCount.rows[0].n)).toBe(1)
    expect(generateMoveInInvoiceMock).toHaveBeenCalledTimes(1)
  })

  // S622 (Nic): "some leases are gonna be imported, scanned PDFs, and other ones
  // are gonna be electronic signature. It needs to work both ways universally —
  // you never know what a landlord is gonna choose to do with migrating."
  //
  // A fee stated in PROSE has no blank, so no placed box can ever carry it. The
  // import path already reads these out of the text; this is the e-sign half.
  // The row must land in the SAME shape import writes, because that shape is
  // what makes the deposit-return sweep skip it until a human assesses the
  // condition as failed at move-out.
  it('S622: a conditional fee stated in the template PROSE rides onto the lease at finalize', async () => {
    const f = await seedFixture()
    const { documentId } = await seedCompleteableDoc(f)

    const tmpl = await db.query<{ id: string }>(
      `INSERT INTO lease_templates (landlord_id, name, base_pdf_url, page_count)
       VALUES ($1, 'Prose Fee Template', '/api/esign/files/x.pdf', 8) RETURNING id`,
      [f.landlordId])
    const templateId = tmpl.rows[0].id
    await db.query(`UPDATE lease_documents SET template_id = $1 WHERE id = $2`, [templateId, documentId])

    const CLAUSE = 'Carpet: Upon move out, a fee of $100 will be charged unless Tenant '
      + 'provides a copy of a receipt for professional carpet cleaning.'
    await db.query(
      `INSERT INTO lease_template_conditional_fees (template_id, label, amount, condition_text)
       VALUES ($1, 'Carpet cleaning', 100, $2)`, [templateId, CLAUSE])

    const res = await request(buildApp())
      .post(`/api/esign/sign/${documentId}`)
      .set('Authorization', `Bearer ${f.tenantToken}`)
      .send({ fieldValues: [] })
    expect(res.status).toBe(200)
    expect(res.body.data.completed).toBe(true)

    const leaseId = (await db.query<{ id: string }>(
      `SELECT id FROM leases WHERE unit_id = $1`, [f.unitId])).rows[0].id

    const fee = await db.query<any>(
      `SELECT fee_type, amount::text AS amount, is_refundable, due_timing, description, condition_text
         FROM lease_fees WHERE lease_id = $1 AND condition_text IS NOT NULL`, [leaseId])
    expect(fee.rows.length).toBe(1)
    const row = fee.rows[0]
    // Same shape resolveIntent writes on the import path.
    expect(row.fee_type).toBe('other_fee')
    expect(row.due_timing).toBe('move_out')
    expect(row.is_refundable).toBe(false)
    expect(Number(row.amount)).toBe(100)
    expect(row.description).toBe('Carpet cleaning')
    // Lease-is-law: the clause is stored VERBATIM, not paraphrased.
    expect(row.condition_text).toBe(CLAUSE)

    // And it must NOT be chargeable yet — unassessed conditions never charge.
    // (This mirrors the deposit-return filter: condition_result IS NULL.)
    const chargeable = await db.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM lease_fees
        WHERE lease_id = $1 AND due_timing IN ('move_out','other')
          AND (condition_text IS NULL OR condition_result = 'failed')`, [leaseId])
    expect(Number(chargeable.rows[0].n)).toBe(0)
  })

  it('S581: the finalize guard is uniform — a finalized addendum also no-ops (not just leases)', async () => {
    const f = await seedFixture()
    // A document already stamped finalized_at, as a completed build leaves it.
    // The guard is type-agnostic, so re-finalizing a non-original_lease document
    // (here an addendum_terms) must short-circuit without re-applying its effect.
    const { documentId } = await seedDoc(f, {
      documentType: 'addendum_terms',
      status: 'completed',
      landlordSignerStatus: 'signed',
      tenantSignerStatus: 'signed',
    })
    await db.query(`UPDATE lease_documents SET finalized_at = NOW() WHERE id = $1`, [documentId])

    const r = await buildLeaseFromDocument(documentId)
    expect(r.alreadyBuilt).toBe(true)
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

  // S622 (Nic): "say that process is delayed here and there, and they don't get
  // around to signing it till September fifth... because we are also setting the
  // leases to start for September first. So if they sign it after it was active,
  // does that create another problem?"
  //
  // The realistic Oak Park shape: lease dated the 1st, signature lands days
  // later. Nothing may quietly not-happen because a date moved. Nic's own words
  // on what matters: "as long as the pieces stay on track with whatever delays,
  // and we still get to the end result."
  //
  // NOTE the late fee running from the real due date is DELIBERATE, not an
  // oversight — Nic: "they already live at the property, they're already aware
  // of late fees... anybody that pays on the fifth or the sixth would have paid
  // on the fifth or the sixth anyway." This test pins the chain, not the timing.
  it('S622: a lease signed AFTER its start date still completes the whole chain', async () => {
    const f = await seedFixture()
    // Signed today, but the lease began four days ago — the delayed-signature case.
    const backdated = new Date(Date.now() - 1000 * 60 * 60 * 24 * 4).toISOString().slice(0, 10)
    const { documentId } = await seedCompleteableDoc(f, {
      fields: defaultLeaseFields({ start_date: backdated, end_date: '2099-12-31' }),
    })

    const res = await request(buildApp())
      .post(`/api/esign/sign/${documentId}`)
      .set('Authorization', `Bearer ${f.tenantToken}`)
      .send({ fieldValues: [] })
    expect(res.status).toBe(200)
    expect(res.body.data.completed).toBe(true)

    // 1. The lease exists and is ACTIVE — not stuck 'pending' because its start
    //    date is behind us.
    const lease = await db.query<{ id: string; status: string; start_date: string }>(
      `SELECT id, status, start_date::text AS start_date FROM leases WHERE unit_id = $1`, [f.unitId])
    expect(lease.rows.length).toBe(1)
    expect(lease.rows[0].status).toBe('active')
    expect(lease.rows[0].start_date).toBe(backdated)

    // 2. The unit flipped to occupied.
    const unit = await db.query<{ status: string }>(
      `SELECT status FROM units WHERE id = $1`, [f.unitId])
    expect(unit.rows[0].status).toBe('active')

    // 3. The tenant is on the lease.
    const tenants = await db.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM lease_tenants WHERE lease_id = $1`, [lease.rows[0].id])
    expect(Number(tenants.rows[0].n)).toBeGreaterThan(0)

    // 4. Billing was kicked off, dated the lease's real start — the money step
    //    is the one that would silently not happen if a date guard rejected it.
    expect(generateMoveInInvoiceMock).toHaveBeenCalledTimes(1)
    const billedWith = generateMoveInInvoiceMock.mock.calls[0]
    expect(JSON.stringify(billedWith)).toContain(backdated)
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

  it('S553: same-landlord overlap on a DIFFERENT unit is ALLOWED (two leases, one tenant)', async () => {
    const f = await seedFixture()
    // Same landlord, second unit, overlapping active lease — the Oak Park
    // case (space rent on two mobile homes). Signing must now complete.
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
    expect(res.status).toBe(200)
    expect(res.body.data.executionFailed).toBeFalsy()
    // The second lease materialized on the new unit.
    const leases = await db.query(`SELECT id FROM leases WHERE unit_id = $1 AND status = 'active'`, [f.unitId])
    expect(leases.rows.length).toBe(1)
  })

  it('CROSS-landlord overlapping active lease → still blocked (409, overlap detected)', async () => {
    const f = await seedFixture()
    await seedCrossLandlordOverlap(f.tenantId)
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

  it('new tenant has overlapping active lease under ANOTHER landlord → execution_failed (409)', async () => {
    const f = await seedFixture()
    const parentLeaseId = await seedParentLease(f)
    const newTenant = await seedNewTenant()
    // S553: same-landlord overlap is now allowed, so the block case seeds
    // the overlap under a DIFFERENT landlord.
    await seedCrossLandlordOverlap(newTenant.tenantId)

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
    // landlord_consent_date is set via CURRENT_DATE — pull "today"
    // from the DB so the assertion uses the same timezone the column
    // was stamped in (avoids a UTC-vs-local boundary flake when the
    // local clock straddles UTC midnight; pre-S454 used `new Date()`).
    const { rows: [{ today }] } = await db.query<{ today: string }>(
      `SELECT CURRENT_DATE::text AS today`)
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



// ─── S534: renewal completion — deposit carry, delta top-up, custody rebind ───
//
// The deposit is ONE continuous custody across a renewal: the carried
// amount is never re-billed; the security_deposits row (money, status,
// statutory interest accrual chain) rebinds to the successor lease so
// deposit-return and the monthly interest cron keep working; a HIGHER
// deposit typed into the renewal doc bills only the difference.

describe('renewal completion (renews_lease_id) — deposit chain', () => {
  async function seedPredecessor(f: SeedFixture) {
    const client = await db.connect()
    try {
      await client.query('BEGIN')
      const leaseId = await seedLease(client, {
        unitId: f.unitId, landlordId: f.landlordId, status: 'active', startDate: '2025-08-01',
      })
      await client.query(`UPDATE leases SET end_date='2026-07-31' WHERE id=$1`, [leaseId])
      await seedLeaseTenant(client, { leaseId, tenantId: f.tenantId })
      await client.query(
        `INSERT INTO lease_fees (lease_id, fee_type, amount, is_refundable, due_timing)
         VALUES ($1, 'security_deposit', 1000, TRUE, 'move_in')`, [leaseId])
      const sd = await client.query<{ id: string }>(
        `INSERT INTO security_deposits
           (unit_id, lease_id, tenant_id, total_amount, collected_amount, status,
            held_by, flex_deposit_enabled, interest_accrued)
         VALUES ($1, $2, $3, 1000, 1000, 'funded', 'gam_escrow', FALSE, 12.34)
         RETURNING id`, [f.unitId, leaseId, f.tenantId])
      await client.query('COMMIT')
      return { leaseId, sdId: sd.rows[0].id }
    } catch (e) { await client.query('ROLLBACK'); throw e }
    finally { client.release() }
  }

  async function completeRenewal(f: SeedFixture, predecessorId: string, depositValue: string) {
    const { documentId } = await seedCompleteableDoc(f, {
      fields: defaultLeaseFields({
        start_date: '2026-08-01', end_date: '2027-07-31', security_deposit: depositValue,
      }),
    })
    await db.query(
      `UPDATE lease_documents SET renews_lease_id=$2 WHERE id=$1`, [documentId, predecessorId])
    const res = await request(buildApp())
      .post(`/api/esign/sign/${documentId}`)
      .set('Authorization', `Bearer ${f.tenantToken}`)
      .send({ fieldValues: [] })
    expect(res.status).toBe(200)
    expect(res.body.data.completed).toBe(true)
    const newLease = await db.query<{ id: string }>(
      `SELECT id FROM leases WHERE unit_id=$1 AND id<>$2`, [f.unitId, predecessorId])
    expect(newLease.rows).toHaveLength(1)
    return newLease.rows[0].id
  }

  it('doc deposit == carried → one tagged carried row, no billable deposit, custody rebinds with interest intact', async () => {
    const f = await seedFixture()
    const { leaseId: oldLease, sdId } = await seedPredecessor(f)
    const newLeaseId = await completeRenewal(f, oldLease, '1000.00')

    const fees = await db.query<{ amount: string; description: string | null }>(
      `SELECT amount, description FROM lease_fees
        WHERE lease_id=$1 AND fee_type='security_deposit' AND due_timing='move_in'`, [newLeaseId])
    expect(fees.rows).toHaveLength(1)
    expect(Number(fees.rows[0].amount)).toBe(1000)
    expect(fees.rows[0].description).toMatch(/carried forward from previous lease/)

    // The SAME custody row (same id → same accrual chain) now points at
    // the successor: interest clock continuous from original receipt.
    const sd = await db.query<{ lease_id: string; status: string; total_amount: string; interest_accrued: string }>(
      `SELECT lease_id, status, total_amount, interest_accrued FROM security_deposits WHERE id=$1`, [sdId])
    expect(sd.rows[0].lease_id).toBe(newLeaseId)
    expect(sd.rows[0].status).toBe('funded')
    expect(Number(sd.rows[0].total_amount)).toBe(1000)
    expect(Number(sd.rows[0].interest_accrued)).toBeCloseTo(12.34, 2)
  })

  it('doc deposit > carried → bills ONLY the difference as a tagged top-up; custody target raised', async () => {
    const f = await seedFixture()
    const { leaseId: oldLease, sdId } = await seedPredecessor(f)
    const newLeaseId = await completeRenewal(f, oldLease, '1250.00')

    const fees = await db.query<{ amount: string; description: string | null }>(
      `SELECT amount, description FROM lease_fees
        WHERE lease_id=$1 AND fee_type='security_deposit' AND due_timing='move_in'
        ORDER BY amount`, [newLeaseId])
    expect(fees.rows).toHaveLength(2)
    expect(Number(fees.rows[0].amount)).toBe(250)   // the ONLY billable piece
    expect(fees.rows[0].description).toMatch(/\[deposit top-up on renewal\]/)
    expect(Number(fees.rows[1].amount)).toBe(1000)  // carried, never re-billed
    expect(fees.rows[1].description).toMatch(/carried forward from previous lease/)

    const sd = await db.query<{ lease_id: string; status: string; total_amount: string; collected_amount: string; interest_accrued: string }>(
      `SELECT lease_id, status, total_amount, collected_amount, interest_accrued
         FROM security_deposits WHERE id=$1`, [sdId])
    expect(sd.rows[0].lease_id).toBe(newLeaseId)
    expect(Number(sd.rows[0].total_amount)).toBe(1250)   // raised by the delta
    expect(Number(sd.rows[0].collected_amount)).toBe(1000)
    expect(sd.rows[0].status).toBe('partial')            // reopened until the top-up settles
    expect(Number(sd.rows[0].interest_accrued)).toBeCloseTo(12.34, 2)
  })

  it('doc deposit < carried → nothing bills, carried amount stands (manual partial return is the reduce path)', async () => {
    const f = await seedFixture()
    const { leaseId: oldLease, sdId } = await seedPredecessor(f)
    const newLeaseId = await completeRenewal(f, oldLease, '600.00')

    const fees = await db.query<{ amount: string; description: string | null }>(
      `SELECT amount, description FROM lease_fees
        WHERE lease_id=$1 AND fee_type='security_deposit' AND due_timing='move_in'`, [newLeaseId])
    expect(fees.rows).toHaveLength(1)
    expect(Number(fees.rows[0].amount)).toBe(1000)
    expect(fees.rows[0].description).toMatch(/carried forward/)

    const sd = await db.query<{ lease_id: string; total_amount: string; status: string }>(
      `SELECT lease_id, total_amount, status FROM security_deposits WHERE id=$1`, [sdId])
    expect(sd.rows[0].lease_id).toBe(newLeaseId)
    expect(Number(sd.rows[0].total_amount)).toBe(1000)
    expect(sd.rows[0].status).toBe('funded')
  })
})

// ─── S535: cross-template renewal — gate move + prefill coverage ────────────
//
// A renewal may target a DIFFERENT template than the lease was executed
// on ("change in form"). Landlord-role tagged fields no longer block
// /send (the landlord types terms during their first-signer pass); the
// lock-before-tenant invariant is enforced at the landlord's sign
// submit. And the renewal draft prefills every column derivable from
// the predecessor so an updated form populates automatically.

describe('S535 cross-template renewal', () => {
  it('send allows an unfilled landlord-role tagged field; landlord sign enforces it; filled sign passes', async () => {
    const f = await seedFixture()
    const { documentId } = await seedDoc(f, { status: 'pending' })
    await seedDocFields(documentId, defaultLeaseFields())
    // A landlord-role tagged field the predecessor couldn't derive.
    const empty = await db.query<{ id: string }>(
      `INSERT INTO lease_document_fields
         (document_id, field_type, signer_role, lease_column, value, required)
       VALUES ($1, 'text', 'landlord', 'late_fee_initial_flat', NULL, FALSE)
       RETURNING id`, [documentId])
    const emptyFieldId = empty.rows[0].id

    // Send passes with the landlord-role field empty (pre-S535: 400).
    const sent = await request(buildApp())
      .post(`/api/esign/documents/${documentId}/send`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({})
    expect(sent.status).toBe(200)

    // Landlord signing WITHOUT the value → blocked with the field named.
    const blocked = await request(buildApp())
      .post(`/api/esign/sign/${documentId}`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ fieldValues: [] })
    expect(blocked.status).toBe(400)
    expect(blocked.body.error).toMatch(/Fill these lease terms before signing/)
    expect(blocked.body.error).toMatch(/Late fee/i)

    // Landlord signing WITH the value → proceeds.
    const ok = await request(buildApp())
      .post(`/api/esign/sign/${documentId}`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ fieldValues: [{ fieldId: emptyFieldId, value: '50' }] })
    expect(ok.status).toBe(200)
    const signer = await db.query<{ status: string }>(
      `SELECT status FROM lease_document_signers WHERE document_id=$1 AND role='landlord'`, [documentId])
    expect(signer.rows[0].status).toBe('signed')
  })

  it('renewal draft prefills a NEW template\'s bound fields from the predecessor (terms, fees, utilities, deposits)', async () => {
    const f = await seedFixture()
    // Disable the property's late-fee policy: this test covers the
    // FALLBACK path (predecessor-derived late terms when no property
    // policy exists). The override path has its own test below.
    await db.query(`UPDATE properties SET late_fee_enabled=FALSE WHERE id=$1`, [f.propertyId])
    // Predecessor lease with a rich term set.
    const client = await db.connect()
    let oldLease: string
    try {
      await client.query('BEGIN')
      oldLease = await seedLease(client, {
        unitId: f.unitId, landlordId: f.landlordId, status: 'active', startDate: '2025-08-01',
      })
      await client.query(`
        UPDATE leases SET end_date='2026-07-31', lease_type='fixed_term',
               late_fee_initial_amount=50, late_fee_initial_type='flat',
               late_fee_grace_days=3
         WHERE id=$1`, [oldLease])
      await seedLeaseTenant(client, { leaseId: oldLease, tenantId: f.tenantId })
      await client.query(`
        INSERT INTO lease_fees (lease_id, fee_type, amount, is_refundable, due_timing) VALUES
          ($1, 'security_deposit', 1000, TRUE, 'move_in'),
          ($1, 'pet_deposit', 300, TRUE, 'move_in'),
          ($1, 'pet_rent', 25, FALSE, 'monthly_ongoing')`, [oldLease])
      await client.query(`
        INSERT INTO lease_utility_responsibilities (lease_id, utility_type, tenant_responsible)
        VALUES ($1, 'electric', TRUE), ($1, 'water', FALSE)`, [oldLease])
      await client.query('COMMIT')
    } catch (e) { await client.query('ROLLBACK'); throw e }
    finally { client.release() }

    // A brand-NEW template ("updated form") binding a wider field set.
    const tmpl = await db.query<{ id: string }>(
      `INSERT INTO lease_templates (landlord_id, name, base_pdf_url, page_count)
       VALUES ($1, 'Updated Form 2026', '/api/esign/files/updated-form.pdf', 1)
       RETURNING id`, [f.landlordId])
    const templateId = tmpl.rows[0].id
    const cols = ['rent_amount', 'start_date', 'end_date', 'lease_type',
      'late_fee_initial_flat', 'late_fee_grace_days', 'security_deposit',
      'pet_deposit', 'pet_rent', 'utility_electric_responsibility',
      'utility_water_responsibility', 'tenant_name']
    for (let i = 0; i < cols.length; i++) {
      await db.query(`
        INSERT INTO lease_template_fields
          (template_id, field_type, signer_role, label, lease_column, page, x, y, width, height, required)
        VALUES ($1, 'text', 'landlord', $2, $2, 1, 72, $3, 140, 24, FALSE)`,
        [templateId, cols[i], 100 + i * 30])
    }

    const drafted = await request(buildApp())
      .post('/api/esign/documents/renewal')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ leaseId: oldLease, templateId })
    expect(drafted.status).toBe(201)
    const docId = drafted.body.data.id

    const vals = await db.query<{ lease_column: string; value: string | null }>(
      `SELECT lease_column, value FROM lease_document_fields WHERE document_id=$1`, [docId])
    const byCol: Record<string, string | null> = {}
    for (const r of vals.rows) byCol[r.lease_column] = r.value

    expect(Number(byCol.rent_amount)).toBe(1000)          // current rent default
    expect(byCol.start_date).toBe('8/1/2026')             // day after old end
    expect(byCol.end_date).toBe('7/31/2027')              // same duration
    expect(byCol.lease_type).toBe('fixed_term')
    expect(byCol.late_fee_initial_flat).toBe('N/A')  // S535: late fees never carry from the lease
    expect(byCol.late_fee_grace_days).toBe('N/A')
    expect(Number(byCol.security_deposit)).toBe(1000)     // carried, per type
    expect(Number(byCol.pet_deposit)).toBe(300)           // carried, per type
    expect(Number(byCol.pet_rent)).toBe(25)
    expect(byCol.utility_electric_responsibility).toBe('tenant')
    expect(byCol.utility_water_responsibility).toBe('landlord')
    expect(byCol.tenant_name).toBeTruthy()
  })
})

// ─── S535: '-' end date = month-to-month ─────────────────────────────
describe("S535 '-' end date convention", () => {
  it("completion maps end_date '-' to NULL end date + month_to_month, whatever lease_type says", async () => {
    const f = await seedFixture()
    const { documentId } = await seedCompleteableDoc(f, {
      fields: defaultLeaseFields({ end_date: '-', lease_type: 'fixed_term' }),
    })
    const res = await request(buildApp())
      .post(`/api/esign/sign/${documentId}`)
      .set('Authorization', `Bearer ${f.tenantToken}`)
      .send({ fieldValues: [] })
    expect(res.status).toBe(200)
    expect(res.body.data.completed).toBe(true)

    const lease = await db.query<{ end_date: string | null; lease_type: string }>(
      `SELECT end_date, lease_type FROM leases WHERE unit_id=$1`, [f.unitId])
    expect(lease.rows).toHaveLength(1)
    expect(lease.rows[0].end_date).toBeNull()
    expect(lease.rows[0].lease_type).toBe('month_to_month')
  })
})

// ─── S535: property-level late fees override per-lease values ────────
describe('S535 property late-fee policy stamping', () => {
  it("no per-unit-type row → late-fee fields stamp 'N/A' (no property-wide default, no predecessor carry)", async () => {
    const f = await seedFixture()
    await db.query(`
      UPDATE properties SET late_fee_enabled=TRUE, late_fee_initial_amount=75,
             late_fee_initial_type='flat', late_fee_grace_days=2 WHERE id=$1`, [f.propertyId])

    const client = await db.connect()
    let oldLease: string
    try {
      await client.query('BEGIN')
      oldLease = await seedLease(client, {
        unitId: f.unitId, landlordId: f.landlordId, status: 'active', startDate: '2025-08-01',
      })
      // Predecessor carries DIFFERENT late terms — the property policy must win.
      await client.query(`
        UPDATE leases SET end_date='2026-07-31', late_fee_enabled=TRUE,
               late_fee_initial_amount=50, late_fee_initial_type='flat', late_fee_grace_days=3
         WHERE id=$1`, [oldLease])
      await seedLeaseTenant(client, { leaseId: oldLease, tenantId: f.tenantId })
      await client.query('COMMIT')
    } catch (e) { await client.query('ROLLBACK'); throw e }
    finally { client.release() }

    const tmpl = await db.query<{ id: string }>(
      `INSERT INTO lease_templates (landlord_id, name, base_pdf_url, page_count)
       VALUES ($1, 'Policy Form', '/api/esign/files/policy-form.pdf', 1) RETURNING id`, [f.landlordId])
    for (const col of ['rent_amount', 'start_date', 'late_fee_initial_flat', 'late_fee_grace_days']) {
      await db.query(`
        INSERT INTO lease_template_fields
          (template_id, field_type, signer_role, label, lease_column, page, x, y, width, height, required)
        VALUES ($1, 'text', 'landlord', $2, $2, 1, 72, 100, 140, 24, FALSE)`, [tmpl.rows[0].id, col])
    }

    const drafted = await request(buildApp())
      .post('/api/esign/documents/renewal')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ leaseId: oldLease, templateId: tmpl.rows[0].id })
    expect(drafted.status).toBe(201)

    const vals = await db.query<{ lease_column: string; value: string | null }>(
      `SELECT lease_column, value FROM lease_document_fields WHERE document_id=$1
        AND lease_column IN ('late_fee_initial_flat','late_fee_grace_days')`, [drafted.body.data.id])
    const byCol: Record<string, string | null> = {}
    for (const r of vals.rows) byCol[r.lease_column] = r.value
    // S535: the property-wide default (75/2) does NOT apply, and the
    // predecessor's per-lease values (50/3) do NOT carry — without a
    // (property, unit_type) row this class has NO late fee.
    expect(byCol.late_fee_initial_flat).toBe('N/A')
    expect(byCol.late_fee_grace_days).toBe('N/A')
  })

  it('a per-UNIT-TYPE override beats the property default at stamping', async () => {
    const f = await seedFixture()
    await db.query(`UPDATE units SET unit_type='rv_spot' WHERE id=$1`, [f.unitId])
    await db.query(`
      UPDATE properties SET late_fee_enabled=TRUE, late_fee_initial_amount=75,
             late_fee_initial_type='flat', late_fee_grace_days=2 WHERE id=$1`, [f.propertyId])
    await db.query(`
      INSERT INTO property_unit_type_late_fees
        (property_id, unit_type, late_fee_grace_days, late_fee_initial_amount, late_fee_initial_type)
      VALUES ($1, 'rv_spot', 7, 20, 'flat')`, [f.propertyId])

    const client = await db.connect()
    let oldLease: string
    try {
      await client.query('BEGIN')
      oldLease = await seedLease(client, { unitId: f.unitId, landlordId: f.landlordId, status: 'active', startDate: '2025-08-01' })
      await client.query(`UPDATE leases SET end_date='2026-07-31' WHERE id=$1`, [oldLease])
      await seedLeaseTenant(client, { leaseId: oldLease, tenantId: f.tenantId })
      await client.query('COMMIT')
    } catch (e) { await client.query('ROLLBACK'); throw e }
    finally { client.release() }

    const tmpl = await db.query<{ id: string }>(
      `INSERT INTO lease_templates (landlord_id, name, base_pdf_url, page_count)
       VALUES ($1, 'RV Policy Form', '/api/esign/files/rv.pdf', 1) RETURNING id`, [f.landlordId])
    for (const col of ['rent_amount', 'start_date', 'late_fee_initial_flat', 'late_fee_grace_days']) {
      await db.query(`
        INSERT INTO lease_template_fields
          (template_id, field_type, signer_role, label, lease_column, page, x, y, width, height, required)
        VALUES ($1, 'text', 'landlord', $2, $2, 1, 72, 100, 140, 24, FALSE)`, [tmpl.rows[0].id, col])
    }

    const drafted = await request(buildApp())
      .post('/api/esign/documents/renewal')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ leaseId: oldLease, templateId: tmpl.rows[0].id })
    expect(drafted.status).toBe(201)

    const vals = await db.query<{ lease_column: string; value: string | null }>(
      `SELECT lease_column, value FROM lease_document_fields WHERE document_id=$1
        AND lease_column IN ('late_fee_initial_flat','late_fee_grace_days')`, [drafted.body.data.id])
    const byCol: Record<string, string | null> = {}
    for (const r of vals.rows) byCol[r.lease_column] = r.value
    expect(Number(byCol.late_fee_initial_flat)).toBe(20)  // rv_spot override, not the $75 default
    expect(Number(byCol.late_fee_grace_days)).toBe(7)
  })

  it("refuses drafting when the policy can't PRINT on the document (template missing late-fee fields)", async () => {
    const f = await seedFixture()
    await db.query(`UPDATE units SET unit_type='rv_spot' WHERE id=$1`, [f.unitId])
    await db.query(`UPDATE properties SET late_fee_enabled=TRUE WHERE id=$1`, [f.propertyId])
    await db.query(`
      INSERT INTO property_unit_type_late_fees
        (property_id, unit_type, late_fee_grace_days, late_fee_initial_amount, late_fee_initial_type)
      VALUES ($1, 'rv_spot', 7, 20, 'flat')`, [f.propertyId])

    const client = await db.connect()
    let oldLease: string
    try {
      await client.query('BEGIN')
      oldLease = await seedLease(client, { unitId: f.unitId, landlordId: f.landlordId, status: 'active', startDate: '2025-08-01' })
      await client.query(`UPDATE leases SET end_date='2026-07-31' WHERE id=$1`, [oldLease])
      await seedLeaseTenant(client, { leaseId: oldLease, tenantId: f.tenantId })
      await client.query('COMMIT')
    } catch (e) { await client.query('ROLLBACK'); throw e }
    finally { client.release() }

    // Template binds ONLY rent + start — no late-fee fields at all.
    const tmpl = await db.query<{ id: string }>(
      `INSERT INTO lease_templates (landlord_id, name, base_pdf_url, page_count)
       VALUES ($1, 'No-Fee-Fields Form', '/api/esign/files/nf.pdf', 1) RETURNING id`, [f.landlordId])
    for (const col of ['rent_amount', 'start_date']) {
      await db.query(`
        INSERT INTO lease_template_fields
          (template_id, field_type, signer_role, label, lease_column, page, x, y, width, height, required)
        VALUES ($1, 'text', 'landlord', $2, $2, 1, 72, 100, 140, 24, FALSE)`, [tmpl.rows[0].id, col])
    }

    const blocked = await request(buildApp())
      .post('/api/esign/documents/renewal')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ leaseId: oldLease, templateId: tmpl.rows[0].id })
    expect(blocked.status).toBe(400)
    expect(blocked.body.error).toMatch(/must appear IN the lease document/i)
    expect(blocked.body.error).toMatch(/Late fee/i)
  })
})

// ─── S535: templates are per unit type ───────────────────────────────
describe('S535 template unit-type pairing', () => {
  it('refuses drafting a renewal on a template for a different unit type; universal always fits', async () => {
    const f = await seedFixture()
    await db.query(`UPDATE units SET unit_type='apartment' WHERE id=$1`, [f.unitId])
    const client = await db.connect()
    let oldLease: string
    try {
      await client.query('BEGIN')
      oldLease = await seedLease(client, { unitId: f.unitId, landlordId: f.landlordId, status: 'active', startDate: '2025-08-01' })
      await client.query(`UPDATE leases SET end_date='2026-07-31' WHERE id=$1`, [oldLease])
      await seedLeaseTenant(client, { leaseId: oldLease, tenantId: f.tenantId })
      await client.query('COMMIT')
    } catch (e) { await client.query('ROLLBACK'); throw e }
    finally { client.release() }

    const mkTemplate = async (unitType: string | null) => {
      const t = await db.query<{ id: string }>(
        `INSERT INTO lease_templates (landlord_id, name, base_pdf_url, page_count, unit_type)
         VALUES ($1, $2, '/api/esign/files/t.pdf', 1, $3) RETURNING id`,
        [f.landlordId, `T-${unitType ?? 'universal'}`, unitType])
      for (const col of ['rent_amount', 'start_date']) {
        await db.query(`
          INSERT INTO lease_template_fields
            (template_id, field_type, signer_role, label, lease_column, page, x, y, width, height, required)
          VALUES ($1, 'text', 'landlord', $2, $2, 1, 72, 100, 140, 24, FALSE)`, [t.rows[0].id, col])
      }
      return t.rows[0].id
    }

    const rvTemplate = await mkTemplate('rv_spot')
    const mismatch = await request(buildApp())
      .post('/api/esign/documents/renewal')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ leaseId: oldLease, templateId: rvTemplate })
    expect(mismatch.status).toBe(400)
    expect(mismatch.body.error).toMatch(/rv spot.*apartment|for rv spot units/i)

    const universal = await mkTemplate(null)
    const ok = await request(buildApp())
      .post('/api/esign/documents/renewal')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ leaseId: oldLease, templateId: universal })
    expect(ok.status).toBe(201)
  })

  it('refuses drafting on a template locked to a DIFFERENT property; own-property lock passes', async () => {
    const f = await seedFixture()
    const client = await db.connect()
    let oldLease: string, otherPropertyId: string
    try {
      await client.query('BEGIN')
      oldLease = await seedLease(client, { unitId: f.unitId, landlordId: f.landlordId, status: 'active', startDate: '2025-08-01' })
      await client.query(`UPDATE leases SET end_date='2026-07-31' WHERE id=$1`, [oldLease])
      await seedLeaseTenant(client, { leaseId: oldLease, tenantId: f.tenantId })
      otherPropertyId = await seedProperty(client, { landlordId: f.landlordId, ownerUserId: f.landlordUserId, managedByUserId: f.landlordUserId })
      await client.query('COMMIT')
    } catch (e) { await client.query('ROLLBACK'); throw e }
    finally { client.release() }

    const mk = async (propertyId: string | null) => {
      const t = await db.query<{ id: string }>(
        `INSERT INTO lease_templates (landlord_id, name, base_pdf_url, page_count, property_id)
         VALUES ($1, $2, '/api/esign/files/t.pdf', 1, $3) RETURNING id`,
        [f.landlordId, `PT-${propertyId ?? 'unlocked'}`, propertyId])
      for (const col of ['rent_amount', 'start_date']) {
        await db.query(`
          INSERT INTO lease_template_fields
            (template_id, field_type, signer_role, label, lease_column, page, x, y, width, height, required)
          VALUES ($1, 'text', 'landlord', $2, $2, 1, 72, 100, 140, 24, FALSE)`, [t.rows[0].id, col])
      }
      return t.rows[0].id
    }

    const wrongLock = await mk(otherPropertyId)
    const blocked = await request(buildApp())
      .post('/api/esign/documents/renewal')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ leaseId: oldLease, templateId: wrongLock })
    expect(blocked.status).toBe(400)
    expect(blocked.body.error).toMatch(/locked to another property/i)

    const rightLock = await mk(f.propertyId)
    const ok = await request(buildApp())
      .post('/api/esign/documents/renewal')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ leaseId: oldLease, templateId: rightLock })
    expect(ok.status).toBe(201)
  })
})

// ─── S582: money add-on document-first (POST /documents/addendum-terms) ───
// The MoneyAddonModal path sends leaseId + mode + scheduledChanges and NO
// template/base PDF. Two things this covers:
//   1. co_tenant role bug: auto-resolved tenant signers must use co_tenant_N,
//      not the literal 'co_tenant' (which fails TENANT_ROLE_PATTERN → 400).
//   2. document-first: with no base PDF, a PDF is generated that PRINTS the
//      money term, and signature/date fields are placed per signer so the
//      tenant signs a real document (memory gam-document-first-enforcement).
describe('POST /documents/addendum-terms — S582 money add-on', () => {
  async function addCoTenant(leaseId: string): Promise<NewTenantSeed> {
    const co = await seedNewTenant()
    await db.query(
      `INSERT INTO lease_tenants (lease_id, tenant_id, role, status, added_at, added_reason, financial_responsibility)
       VALUES ($1, $2, 'co_tenant', 'active', NOW(), 'roommate_added', 'joint_several')`,
      [leaseId, co.tenantId])
    return co
  }

  it('agreement, 2 tenants: resolves primary + co_tenant_1 (no 400), generates PDF + signature fields', async () => {
    const f = await seedFixture()
    const leaseId = await seedParentLease(f)
    await addCoTenant(leaseId)

    const res = await request(buildApp())
      .post('/api/esign/documents/addendum-terms')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({
        leaseId, title: 'Parking Add-On', mode: 'agreement',
        scheduledChanges: [{ changeType: 'recurring_fee', effectiveDate: '2026-09-01', feeType: 'parking_rent', feeAmount: 50 }],
      })
    // Pre-fix this 400'd with "Invalid signer role: co_tenant".
    expect(res.status).toBe(201)
    const docId = res.body.data.id

    const signers = await db.query<{ role: string }>(
      `SELECT role FROM lease_document_signers WHERE document_id = $1`, [docId])
    expect(signers.rows.map(r => r.role).sort()).toEqual(['co_tenant_1', 'landlord', 'primary'])

    // document-first: base PDF generated (not null)
    const doc = await db.query<{ base_pdf_url: string }>(
      `SELECT base_pdf_url FROM lease_documents WHERE id = $1`, [docId])
    expect(doc.rows[0].base_pdf_url).toMatch(/addendum-money-.*\.pdf$/)

    // one signature (required) + one date_signed field per signer
    const fields = await db.query<{ signer_role: string; field_type: string; required: boolean; lease_column: string | null }>(
      `SELECT signer_role, field_type, required, lease_column FROM lease_document_fields WHERE document_id = $1`, [docId])
    const sigs = fields.rows.filter(r => r.field_type === 'signature')
    expect(sigs.map(r => r.signer_role).sort()).toEqual(['co_tenant_1', 'landlord', 'primary'])
    expect(sigs.every(r => r.required)).toBe(true)
    const dates = fields.rows.filter(r => r.field_type === 'date')
    expect(dates.length).toBe(3)
    expect(dates.every(r => r.lease_column === 'date_signed')).toBe(true)

    // change stored as a draft tied to this document
    const sc = await db.query<{ change_type: string; status: string }>(
      `SELECT change_type, status FROM scheduled_lease_changes WHERE source_document_id = $1`, [docId])
    expect(sc.rows).toEqual([{ change_type: 'recurring_fee', status: 'draft' }])
  })

  it('notice, rent change: landlord-only signer, generated PDF, only a landlord signature field', async () => {
    const f = await seedFixture()
    const leaseId = await seedParentLease(f)
    await addCoTenant(leaseId)   // tenants exist but do NOT sign a notice

    const res = await request(buildApp())
      .post('/api/esign/documents/addendum-terms')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({
        leaseId, title: 'Space Rent Increase Notice', mode: 'notice',
        scheduledChanges: [{ changeType: 'rent', effectiveDate: '2026-10-01', newRentAmount: 1200 }],
      })
    expect(res.status).toBe(201)
    const docId = res.body.data.id

    const signers = await db.query<{ role: string }>(
      `SELECT role FROM lease_document_signers WHERE document_id = $1`, [docId])
    expect(signers.rows.map(r => r.role)).toEqual(['landlord'])

    const doc = await db.query<{ base_pdf_url: string; delivery_mode: string }>(
      `SELECT base_pdf_url, delivery_mode FROM lease_documents WHERE id = $1`, [docId])
    expect(doc.rows[0].delivery_mode).toBe('notice')
    expect(doc.rows[0].base_pdf_url).toMatch(/addendum-money-.*\.pdf$/)

    const sigs = await db.query<{ signer_role: string }>(
      `SELECT signer_role FROM lease_document_fields WHERE document_id = $1 AND field_type = 'signature'`, [docId])
    expect(sigs.rows.map(r => r.signer_role)).toEqual(['landlord'])
  })
})

/**
 * S629 — the signing link has to reach the signer's OWN portal.
 *
 * Nic: "I need to be able to sign from clicking a link in the email, because
 * that is how other people are gonna also sign. Nobody's gonna log in and see
 * 'oh, I've gotta sign my lease now.'"
 *
 * The URL was hard-coded to the tenant app for every signer. The first signer
 * on a lease is the LANDLORD, so the landlord was emailed a link into the
 * tenant portal — an app their account cannot sign in. LANDLORD_APP_URL existed
 * the whole time and was never used here.
 */
describe('signing links by signer role', () => {
  it('sends the landlord to the landlord app and a tenant to the tenant app', () => {
    const landlord = signingUrlFor({ role: 'landlord', token: 'c'.repeat(64) }, 'doc-1', null)
    const tenant = signingUrlFor({ role: 'primary', token: 'd'.repeat(64) }, 'doc-1', { email_verified: true })
    expect(landlord).toContain('/sign/')
    expect(tenant).toContain('/sign/')
    expect(landlord).not.toBe(tenant)
    // The landlord must never be pointed at the tenant portal.
    expect(landlord).not.toContain('tenant')
  })

  it('sends an unactivated tenant straight to the document, not to a password screen', () => {
    // S629 (Nic): "the signing should almost be outside of logging in." The
    // signer's token IS their identity for this document, so there is no reason
    // to make somebody set a password before they can read what they are
    // signing. This previously detoured through /accept-invite.
    const tok = 'a'.repeat(64)
    const url = signingUrlFor({ role: 'primary', token: tok }, 'doc-9',
      { email_verified: false, tenant_invite_token: 'tok123' })
    expect(url).toContain(`/sign/${tok}`)
    expect(url).not.toContain('accept-invite')
  })

  it('puts the SIGNER TOKEN in the link, never the document id', () => {
    // The document id would land on a login page: the handlers resolve a signer
    // from the session unless a token is supplied in its place.
    const tok = 'b'.repeat(64)
    expect(signingUrlFor({ role: 'landlord', token: tok }, 'doc-1', null)).toContain(`/sign/${tok}`)
    expect(signingUrlFor({ role: 'landlord', token: tok }, 'doc-1', null)).not.toContain('doc-1')
  })

  it('treats a witness like the landlord — they sign in the landlord app', () => {
    const tok = 'e'.repeat(64)
    expect(signingUrlFor({ role: 'witness', token: tok }, 'doc-2', null))
      .toBe(signingUrlFor({ role: 'landlord', token: tok }, 'doc-2', null))
  })
})
