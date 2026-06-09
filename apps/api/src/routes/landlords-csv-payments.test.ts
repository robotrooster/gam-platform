/**
 * landlords.ts payment-history-CSV slice — S361 (landlords slice 6 of N).
 *
 * Closes the CSV onboarding triad started in S359 (properties) +
 * S360 (tenants). 3 routes, ~300 LoC. Phase B per the route comments:
 * migrate historical rent collections from a prior PM software.
 *
 * Coverage focus:
 *   - Template returns CSV with canonical column
 *   - Validate: required-field + format blockers; resolution via
 *     email (lookupsByEmail) and tenant_name fallback
 *     (lookupsByName + variant normalization); property/unit
 *     disambiguation warns; unresolved tenant blocks
 *   - Commit: empty / no-claim / blockers-still-present / cross-
 *     landlord (403) / happy path → payments row written with
 *     `import_source` + correct `entry_description` for type
 *
 * csvImportAttempts mocked (same pattern as S359 + S360).
 */

import { vi, describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { randomUUID } from 'crypto'
import { db } from '../db'
import {
  cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedTenant,
  seedLease, seedLeaseTenant,
} from '../test/dbHelpers'

const {
  recordValidateAttemptMock,
  recordCommitAttemptMock,
  getPlatformReviewStatusMock,
  extractAttemptShapeMock,
  notifyCsvReviewPendingIfNeededMock,
} = vi.hoisted(() => ({
  recordValidateAttemptMock:        vi.fn(async (..._args: any[]) => undefined),
  recordCommitAttemptMock:          vi.fn(async (..._args: any[]) => undefined),
  getPlatformReviewStatusMock:      vi.fn(async (..._args: any[]) => ({
    escalateToSuperAdmin: false,
    mappingStatus: 'verified' as const,
  })),
  extractAttemptShapeMock:          vi.fn((..._args: any[]) => ({
    columnHeaders: [] as string[],
    sampleRows: [] as any[],
  })),
  notifyCsvReviewPendingIfNeededMock: vi.fn(async (..._args: any[]) => undefined),
}))
vi.mock('../services/csvImportAttempts', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    recordValidateAttempt:        recordValidateAttemptMock,
    recordCommitAttempt:          recordCommitAttemptMock,
    getPlatformReviewStatus:      getPlatformReviewStatusMock,
    extractAttemptShape:          extractAttemptShapeMock,
    notifyCsvReviewPendingIfNeeded: notifyCsvReviewPendingIfNeededMock,
  }
})

import { landlordsRouter } from './landlords'
import { errorHandler } from '../middleware/errorHandler'

function buildApp() {
  const app = express()
  app.use(express.json({ limit: '2mb' }))
  app.use('/api/landlords', landlordsRouter)
  app.use(errorHandler)
  return app
}

beforeEach(async () => {
  await cleanupAllSchema()
  recordValidateAttemptMock.mockClear()
  recordCommitAttemptMock.mockClear()
  getPlatformReviewStatusMock.mockClear()
  getPlatformReviewStatusMock.mockResolvedValue({
    escalateToSuperAdmin: false, mappingStatus: 'verified' as any,
  })
  extractAttemptShapeMock.mockClear()
  extractAttemptShapeMock.mockReturnValue({ columnHeaders: [], sampleRows: [] })
  notifyCsvReviewPendingIfNeededMock.mockClear()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_csv_pay'
})

interface PFixture {
  landlordUserId: string
  landlordId:     string
  landlordToken:  string
  propertyId:     string
  unitId:         string
  tenantId:       string
  tenantUserId:   string
  tenantEmail:    string
  leaseId:        string
}

async function seedPFixture(opts: { tenantFirst?: string; tenantLast?: string } = {}): Promise<PFixture> {
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    const { userId: landlordUserId, landlordId } = await seedLandlord(client)
    const propertyId = await seedProperty(client, {
      landlordId, ownerUserId: landlordUserId, managedByUserId: landlordUserId,
    })
    await client.query(`UPDATE properties SET name='CSV-Pay-Prop' WHERE id=$1`, [propertyId])
    const unitId = await seedUnit(client, { propertyId, landlordId })
    await client.query(`UPDATE units SET unit_number='101' WHERE id=$1`, [unitId])
    const tenantEmail = `tn-${randomUUID().slice(0, 6)}@test.dev`
    // Create tenant + override email + name fields on users
    const tenantId = await seedTenant(client, { email: tenantEmail })
    const tu = await client.query<{ user_id: string }>(
      `SELECT user_id FROM tenants WHERE id=$1`, [tenantId])
    const tenantUserId = tu.rows[0].user_id
    if (opts.tenantFirst || opts.tenantLast) {
      await client.query(
        `UPDATE users SET first_name=$1, last_name=$2 WHERE id=$3`,
        [opts.tenantFirst || 'Test', opts.tenantLast || 'Tenant', tenantUserId])
    }
    const leaseId = await seedLease(client, { unitId, landlordId, rentAmount: 1500 })
    await seedLeaseTenant(client, { leaseId, tenantId, role: 'primary' })
    await client.query('COMMIT')
    const landlordToken = jwt.sign(
      { userId: landlordUserId, role: 'landlord', email: 'll@test.dev',
        profileId: landlordId, permissions: {} },
      process.env.JWT_SECRET!, { expiresIn: '1h' },
    )
    return { landlordUserId, landlordId, landlordToken, propertyId, unitId,
             tenantId, tenantUserId, tenantEmail, leaseId }
  } catch (e) { await client.query('ROLLBACK'); throw e }
  finally { client.release() }
}

const CANONICAL_HEADERS = [
  'tenant_email', 'tenant_name', 'payment_date', 'amount',
  'payment_type', 'payment_method', 'property_name', 'unit_number', 'reference',
].join(',')

function rowFor(overrides: Record<string, string> = {}): string {
  const defaults: Record<string, string> = {
    tenant_email: '', tenant_name: '', payment_date: '2026-05-01',
    amount: '1500', payment_type: 'rent', payment_method: 'ach',
    property_name: '', unit_number: '', reference: '',
  }
  const merged = { ...defaults, ...overrides }
  return [
    merged.tenant_email, merged.tenant_name, merged.payment_date,
    merged.amount, merged.payment_type, merged.payment_method,
    merged.property_name, merged.unit_number, merged.reference,
  ].join(',')
}

describe('GET /api/landlords/me/onboard-payment-history-csv/template', () => {
  it('source=generic returns CSV with tenant_email canonical column', async () => {
    const f = await seedPFixture()
    const res = await request(buildApp())
      .get('/api/landlords/me/onboard-payment-history-csv/template?source=generic')
      .set('Authorization', `Bearer ${f.landlordToken}`)
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toMatch(/text\/csv/)
    expect(res.text.toLowerCase()).toMatch(/tenant_email/)
  })
})

describe('POST /api/landlords/me/onboard-payment-history-csv/validate', () => {
  it('headers only (no data rows) → 400', async () => {
    const f = await seedPFixture()
    const res = await request(buildApp())
      .post('/api/landlords/me/onboard-payment-history-csv/validate')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ csv: CANONICAL_HEADERS, source: 'generic' })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/no data rows/)
  })

  it('happy: 1 row resolves by email → resolvedTenantId/LeaseId/UnitId stamped, ready=1', async () => {
    const f = await seedPFixture()
    const csv = CANONICAL_HEADERS + '\n' + rowFor({ tenant_email: f.tenantEmail })
    const res = await request(buildApp())
      .post('/api/landlords/me/onboard-payment-history-csv/validate')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ csv, source: 'generic' })
    expect(res.status).toBe(200)
    expect(res.body.data.summary).toMatchObject({ total: 1, blockers: 0, ready: 1 })
    expect(res.body.data.rows[0].resolvedTenantId).toBe(f.tenantId)
    expect(res.body.data.rows[0].resolvedLeaseId).toBe(f.leaseId)
    expect(res.body.data.rows[0].resolvedUnitId).toBe(f.unitId)
    expect(res.body.data.rows[0].resolvedVia).toBe('email')
  })

  it('missing BOTH tenant_email and tenant_name → blocker', async () => {
    const f = await seedPFixture()
    const csv = CANONICAL_HEADERS + '\n' + rowFor({})  // both blank
    const res = await request(buildApp())
      .post('/api/landlords/me/onboard-payment-history-csv/validate')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ csv, source: 'generic' })
    expect(res.status).toBe(200)
    const issues = res.body.data.rows[0].issues
    expect(issues.some((i: any) => i.field === 'tenant_email' && i.severity === 'block' && /Either.*required/.test(i.message))).toBe(true)
  })

  it('invalid email format → blocker', async () => {
    const f = await seedPFixture()
    const csv = CANONICAL_HEADERS + '\n' + rowFor({ tenant_email: 'not-an-email' })
    const res = await request(buildApp())
      .post('/api/landlords/me/onboard-payment-history-csv/validate')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ csv, source: 'generic' })
    expect(res.status).toBe(200)
    const issues = res.body.data.rows[0].issues
    expect(issues.some((i: any) => i.field === 'tenant_email' && i.severity === 'block' && /Invalid email/.test(i.message))).toBe(true)
  })

  it('zero or negative amount → blocker (refunds out of scope for Phase B)', async () => {
    const f = await seedPFixture()
    const csv = CANONICAL_HEADERS + '\n' + rowFor({ tenant_email: f.tenantEmail, amount: '-50' })
    const res = await request(buildApp())
      .post('/api/landlords/me/onboard-payment-history-csv/validate')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ csv, source: 'generic' })
    expect(res.status).toBe(200)
    const issues = res.body.data.rows[0].issues
    expect(issues.some((i: any) => i.field === 'amount' && i.severity === 'block' && /greater than zero/.test(i.message))).toBe(true)
  })

  it('unknown payment_type → blocker', async () => {
    const f = await seedPFixture()
    const csv = CANONICAL_HEADERS + '\n' + rowFor({ tenant_email: f.tenantEmail, payment_type: 'pet_chinchilla_subsidy' })
    const res = await request(buildApp())
      .post('/api/landlords/me/onboard-payment-history-csv/validate')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ csv, source: 'generic' })
    expect(res.status).toBe(200)
    const issues = res.body.data.rows[0].issues
    expect(issues.some((i: any) => i.field === 'payment_type' && i.severity === 'block')).toBe(true)
  })

  it('tenant_email not in portfolio → blocker "No active lease"', async () => {
    const f = await seedPFixture()
    const csv = CANONICAL_HEADERS + '\n' + rowFor({ tenant_email: 'ghost@nowhere.test' })
    const res = await request(buildApp())
      .post('/api/landlords/me/onboard-payment-history-csv/validate')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ csv, source: 'generic' })
    expect(res.status).toBe(200)
    const issues = res.body.data.rows[0].issues
    expect(issues.some((i: any) => i.field === 'tenant_email' && i.severity === 'block' && /No active lease/.test(i.message))).toBe(true)
  })

  it('name fallback resolves via tenant_name when email missing', async () => {
    const f = await seedPFixture({ tenantFirst: 'Alice', tenantLast: 'Johnson' })
    const csv = CANONICAL_HEADERS + '\n' + rowFor({ tenant_name: 'Alice Johnson' })
    const res = await request(buildApp())
      .post('/api/landlords/me/onboard-payment-history-csv/validate')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ csv, source: 'generic' })
    expect(res.status).toBe(200)
    expect(res.body.data.rows[0].resolvedTenantId).toBe(f.tenantId)
    expect(res.body.data.rows[0].resolvedVia).toBe('name')
  })
})

describe('POST /api/landlords/me/onboard-payment-history-csv/commit', () => {
  function baseRow(f: PFixture, overrides: any = {}) {
    return {
      rowIndex: 0,
      tenantEmail: f.tenantEmail, tenantName: '',
      paymentDate: '2026-05-01', amount: '1500',
      paymentType: 'rent', paymentMethod: 'ach',
      propertyName: '', unitNumber: '', reference: 'inv-1001',
      resolvedTenantId: f.tenantId, resolvedLeaseId: f.leaseId,
      resolvedUnitId: f.unitId, resolvedVia: 'email',
      issues: [],
      ...overrides,
    }
  }

  it('empty rows → 400', async () => {
    const f = await seedPFixture()
    const res = await request(buildApp())
      .post('/api/landlords/me/onboard-payment-history-csv/commit')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ rows: [], source: 'generic', claimedPlatformName: 'X' })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/rows array required/)
  })

  it('generic source without claimedPlatformName → 400', async () => {
    const f = await seedPFixture()
    const res = await request(buildApp())
      .post('/api/landlords/me/onboard-payment-history-csv/commit')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ rows: [baseRow(f)], source: 'generic' })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/claimedPlatformName is required/)
  })

  it('defense-in-depth: cross-landlord lease → 403', async () => {
    const a = await seedPFixture()
    const b = await seedPFixture()
    const res = await request(buildApp())
      .post('/api/landlords/me/onboard-payment-history-csv/commit')
      .set('Authorization', `Bearer ${a.landlordToken}`)
      .send({
        rows: [baseRow(a, { resolvedLeaseId: b.leaseId })],  // b's lease
        source: 'generic', claimedPlatformName: 'TestPlatform',
      })
    expect(res.status).toBe(403)
    expect(res.body.error).toMatch(/not owned by this landlord/)
  })

  it('happy path: payments row inserted with import_source + correct entry_description', async () => {
    const f = await seedPFixture()
    const res = await request(buildApp())
      .post('/api/landlords/me/onboard-payment-history-csv/commit')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({
        rows: [baseRow(f)],
        source: 'generic', claimedPlatformName: 'TestPlatform',
      })
    expect(res.status).toBe(200)
    expect(res.body.data.committed).toBe(1)

    const p = await db.query<{
      type: string; entry_description: string; amount: string;
      status: string; import_source: string; notes: string
    }>(
      `SELECT type, entry_description, amount::text, status, import_source, notes
         FROM payments WHERE landlord_id=$1`, [f.landlordId])
    expect(p.rows.length).toBe(1)
    expect(p.rows[0].type).toBe('rent')
    expect(p.rows[0].entry_description).toBe('RENT')  // ENTRY_DESC_BY_TYPE
    expect(Number(p.rows[0].amount)).toBe(1500)
    expect(p.rows[0].status).toBe('settled')
    expect(p.rows[0].import_source).toBe('generic')
    expect(p.rows[0].notes).toMatch(/Imported from generic/)
    expect(p.rows[0].notes).toMatch(/method: ach/)
    expect(p.rows[0].notes).toMatch(/ref: inv-1001/)
  })
})
