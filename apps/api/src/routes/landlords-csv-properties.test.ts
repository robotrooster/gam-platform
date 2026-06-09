/**
 * landlords.ts properties-CSV slice — S359 (landlords slice 4 of N).
 *
 * Onboarding CSV import: template / validate / commit triad for the
 * properties+units flow. 3 routes, ~450 LoC.
 *
 * Coverage focus:
 *   - Template returns the right CSV and Content-Disposition; unknown
 *     source → 400
 *   - Validate: parse errors, required-field blockers, in-batch dup
 *     unit_number, existing-property resolution, unit_type validation
 *   - Commit: empty body / blockers-still-present / generic-without-
 *     claim-name guards; happy path creates property + unit +
 *     allocation rule in one txn
 *
 * Out of scope (future sessions):
 *   - Tenants CSV (validate + commit + template, 3 routes)
 *   - Payment-history CSV (validate + commit + template, 3 routes)
 *
 * The csvImportAttempts service is mocked — its review-queue +
 * super_admin notification side-effects have their own coverage
 * (csvImportAttempts.test.ts since S346).
 */

import { vi, describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { db } from '../db'
import { cleanupAllSchema, seedLandlord } from '../test/dbHelpers'

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
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_csv'
})

interface CFixture {
  landlordUserId: string
  landlordId:     string
  landlordToken:  string
}

async function seedCFixture(): Promise<CFixture> {
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    const { userId: landlordUserId, landlordId } = await seedLandlord(client)
    await client.query('COMMIT')
    const landlordToken = jwt.sign(
      { userId: landlordUserId, role: 'landlord', email: 'll@test.dev',
        profileId: landlordId, permissions: {} },
      process.env.JWT_SECRET!, { expiresIn: '1h' },
    )
    return { landlordUserId, landlordId, landlordToken }
  } catch (e) { await client.query('ROLLBACK'); throw e }
  finally { client.release() }
}

const CANONICAL_HEADERS = [
  'property_name', 'street1', 'street2', 'city', 'state', 'zip',
  'property_type', 'unit_number', 'bedrooms', 'bathrooms', 'sqft',
  'unit_type', 'rent_amount', 'security_deposit',
].join(',')

describe('GET /api/landlords/me/onboard-properties-csv/template', () => {
  it('source=generic returns CSV body with Content-Disposition + filename', async () => {
    const f = await seedCFixture()
    const res = await request(buildApp())
      .get('/api/landlords/me/onboard-properties-csv/template?source=generic')
      .set('Authorization', `Bearer ${f.landlordToken}`)
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toMatch(/text\/csv/)
    expect(res.headers['content-disposition']).toMatch(/filename="gam-property-template/)
    expect(res.text.length).toBeGreaterThan(0)
    // Body should at minimum mention property_name (canonical column)
    expect(res.text.toLowerCase()).toMatch(/property_name/)
  })

  it('unknown source → 400', async () => {
    const f = await seedCFixture()
    const res = await request(buildApp())
      .get('/api/landlords/me/onboard-properties-csv/template?source=not_a_real_platform')
      .set('Authorization', `Bearer ${f.landlordToken}`)
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/Unknown source/)
  })
})

describe('POST /api/landlords/me/onboard-properties-csv/validate', () => {
  it('CSV with headers but no data rows → 400 "no data rows"', async () => {
    const f = await seedCFixture()
    const res = await request(buildApp())
      .post('/api/landlords/me/onboard-properties-csv/validate')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ csv: CANONICAL_HEADERS, source: 'generic' })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/no data rows/)
  })

  it('happy path: 1 fully-valid row → summary ready=1, blockers=0, newProperties=1, newUnits=1', async () => {
    const f = await seedCFixture()
    const csv = CANONICAL_HEADERS + '\n' +
      'Sunset Apts,123 Main St,,Phoenix,AZ,85001,residential,101,2,1.5,850,apartment,1450,1000'
    const res = await request(buildApp())
      .post('/api/landlords/me/onboard-properties-csv/validate')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ csv, source: 'generic' })
    expect(res.status).toBe(200)
    expect(res.body.data.summary).toMatchObject({
      total: 1, blockers: 0, ready: 1, newProperties: 1, newUnits: 1,
    })
    expect(res.body.data.rows[0].propertyName).toBe('Sunset Apts')
    expect(res.body.data.rows[0].unitNumber).toBe('101')
    expect(res.body.data.rows[0].issues).toEqual([])
    expect(recordValidateAttemptMock).toHaveBeenCalledTimes(1)
  })

  it('missing property_name → blocker on row', async () => {
    const f = await seedCFixture()
    const csv = CANONICAL_HEADERS + '\n' +
      ',123 Main St,,Phoenix,AZ,85001,residential,101,2,1,850,apartment,1450,'
    const res = await request(buildApp())
      .post('/api/landlords/me/onboard-properties-csv/validate')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ csv, source: 'generic' })
    expect(res.status).toBe(200)
    expect(res.body.data.summary.blockers).toBeGreaterThanOrEqual(1)
    const issues = res.body.data.rows[0].issues
    expect(issues.some((i: any) => i.field === 'property_name' && i.severity === 'block')).toBe(true)
  })

  it('negative rent_amount → blocker', async () => {
    const f = await seedCFixture()
    const csv = CANONICAL_HEADERS + '\n' +
      'X,1 Main,,Phoenix,AZ,85001,residential,101,1,1,500,apartment,-50,0'
    const res = await request(buildApp())
      .post('/api/landlords/me/onboard-properties-csv/validate')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ csv, source: 'generic' })
    expect(res.status).toBe(200)
    const issues = res.body.data.rows[0].issues
    expect(issues.some((i: any) => i.field === 'rent_amount' && i.severity === 'block')).toBe(true)
  })

  it('in-batch duplicate unit_number on same property → blocker on the second row', async () => {
    const f = await seedCFixture()
    const csv = CANONICAL_HEADERS + '\n' +
      'Sunset Apts,1 Main,,Phoenix,AZ,85001,residential,101,1,1,500,apartment,1000,\n' +
      'Sunset Apts,1 Main,,Phoenix,AZ,85001,residential,101,1,1,500,apartment,1100,'
    const res = await request(buildApp())
      .post('/api/landlords/me/onboard-properties-csv/validate')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ csv, source: 'generic' })
    expect(res.status).toBe(200)
    // First row clean (it's the seed); second row blocked
    expect(res.body.data.rows[0].issues).toEqual([])
    const dup = res.body.data.rows[1].issues
    expect(dup.some((i: any) => i.field === 'unit_number' && i.severity === 'block' && /Duplicate/.test(i.message))).toBe(true)
  })

  it('existing property (same name + street1) → resolvedPropertyId stamped, no new-property count', async () => {
    const f = await seedCFixture()
    // Pre-seed a property matching the CSV row
    const propRes = await db.query<{ id: string }>(
      `INSERT INTO properties
         (landlord_id, name, street1, city, state, zip,
          owner_user_id, managed_by_user_id)
       VALUES ($1, 'Sunset Apts', '1 Main St', 'Phoenix', 'AZ', '85001',
               (SELECT user_id FROM landlords WHERE id=$1),
               (SELECT user_id FROM landlords WHERE id=$1))
       RETURNING id`, [f.landlordId])
    const existingId = propRes.rows[0].id

    const csv = CANONICAL_HEADERS + '\n' +
      'Sunset Apts,1 Main St,,Phoenix,AZ,85001,residential,201,2,1,800,apartment,1500,0'
    const res = await request(buildApp())
      .post('/api/landlords/me/onboard-properties-csv/validate')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ csv, source: 'generic' })
    expect(res.status).toBe(200)
    expect(res.body.data.rows[0].resolvedPropertyId).toBe(existingId)
    expect(res.body.data.summary.newProperties).toBe(0)
    expect(res.body.data.summary.newUnits).toBe(1)
  })

  it('unknown unit_type → blocker (different severity from property_type which is warn)', async () => {
    const f = await seedCFixture()
    const csv = CANONICAL_HEADERS + '\n' +
      'X,1 Main,,Phoenix,AZ,85001,residential,101,1,1,500,treehouse,1000,'
    const res = await request(buildApp())
      .post('/api/landlords/me/onboard-properties-csv/validate')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ csv, source: 'generic' })
    expect(res.status).toBe(200)
    const issues = res.body.data.rows[0].issues
    expect(issues.some((i: any) => i.field === 'unit_type' && i.severity === 'block')).toBe(true)
  })
})

describe('POST /api/landlords/me/onboard-properties-csv/commit', () => {
  it('empty rows array → 400', async () => {
    const f = await seedCFixture()
    const res = await request(buildApp())
      .post('/api/landlords/me/onboard-properties-csv/commit')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ rows: [], source: 'generic', claimedPlatformName: 'X' })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/rows array required/)
  })

  it('generic source without claimedPlatformName → 400', async () => {
    const f = await seedCFixture()
    const res = await request(buildApp())
      .post('/api/landlords/me/onboard-properties-csv/commit')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({
        rows: [{
          rowIndex: 0, propertyName: 'X', street1: '1 Main', city: 'Phoenix',
          state: 'AZ', zip: '85001', unitNumber: '1',
          rentAmount: '1000', issues: [],
        }],
        source: 'generic',
        // claimedPlatformName missing
      })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/claimedPlatformName is required/)
  })

  it('row with remaining blockers → 400 + nothing committed', async () => {
    const f = await seedCFixture()
    const res = await request(buildApp())
      .post('/api/landlords/me/onboard-properties-csv/commit')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({
        rows: [{
          rowIndex: 0, propertyName: 'X', street1: '1 Main', city: 'Phoenix',
          state: 'AZ', zip: '85001', unitNumber: '1',
          rentAmount: '1000',
          issues: [{ severity: 'block', field: 'foo', message: 'still broken' }],
        }],
        source: 'generic', claimedPlatformName: 'TestPlatform',
      })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/Row 1 still has blockers: still broken/)
    // No property or unit created
    const props = await db.query(`SELECT id FROM properties WHERE landlord_id=$1`, [f.landlordId])
    expect(props.rows.length).toBe(0)
  })

  it('happy path: creates property + unit + allocation rule in one txn', async () => {
    const f = await seedCFixture()
    const res = await request(buildApp())
      .post('/api/landlords/me/onboard-properties-csv/commit')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({
        rows: [{
          rowIndex: 0,
          propertyName: 'Sunset Apts', street1: '1 Main St', street2: '',
          city: 'Phoenix', state: 'AZ', zip: '85001',
          propertyType: 'residential',
          unitNumber: '101', bedrooms: '2', bathrooms: '1.5', sqft: '850',
          unitType: 'apartment',
          rentAmount: '1450', securityDeposit: '1000',
          issues: [],
        }],
        source: 'generic', claimedPlatformName: 'TestPlatform',
      })
    expect(res.status).toBe(200)
    expect(res.body.data.propertiesCreated).toBe(1)
    expect(res.body.data.unitsCreated).toBe(1)
    expect(res.body.data.unitsSkipped).toBe(0)

    // Verify the rows landed
    const props = await db.query<{ id: string; name: string; type: string }>(
      `SELECT id, name, type FROM properties WHERE landlord_id=$1`, [f.landlordId])
    expect(props.rows.length).toBe(1)
    expect(props.rows[0].name).toBe('Sunset Apts')
    expect(props.rows[0].type).toBe('residential')

    // Allocation rule inserted with the import-default fee-payer shape
    const ar = await db.query<{ ach_fee_payer: string; card_fee_payer: string; platform_fee_payer: string }>(
      `SELECT ach_fee_payer, card_fee_payer, platform_fee_payer
         FROM property_allocation_rules WHERE property_id=$1`,
      [props.rows[0].id])
    expect(ar.rows.length).toBe(1)
    expect(ar.rows[0].ach_fee_payer).toBe('tenant')
    expect(ar.rows[0].card_fee_payer).toBe('tenant')
    expect(ar.rows[0].platform_fee_payer).toBe('landlord')

    // Unit inserted under the property with the expected shape
    const units = await db.query<{ unit_number: string; unit_type: string; rent_amount: string }>(
      `SELECT unit_number, unit_type, rent_amount::text FROM units WHERE property_id=$1`,
      [props.rows[0].id])
    expect(units.rows.length).toBe(1)
    expect(units.rows[0].unit_number).toBe('101')
    expect(units.rows[0].unit_type).toBe('apartment')
    expect(Number(units.rows[0].rent_amount)).toBe(1450)
  })
})
