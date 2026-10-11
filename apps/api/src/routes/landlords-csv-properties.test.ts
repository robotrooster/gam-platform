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
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit } from '../test/dbHelpers'

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
import { getOnboardingWindow } from '../services/onboardingWindow'

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

const TZ_HEADERS = [
  'property_name', 'street1', 'street2', 'city', 'state', 'zip', 'timezone',
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
      'Sunset Apts,123 Main St,,Phoenix,AZ,85001,residential,Apt 101,2,1.5,850,apartment,1450,1000'
    const res = await request(buildApp())
      .post('/api/landlords/me/onboard-properties-csv/validate')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ csv, source: 'generic' })
    expect(res.status).toBe(200)
    expect(res.body.data.summary).toMatchObject({
      total: 1, blockers: 0, ready: 1, newProperties: 1, newUnits: 1,
    })
    expect(res.body.data.rows[0].propertyName).toBe('Sunset Apts')
    expect(res.body.data.rows[0].unitNumber).toBe('Apt 101')
    expect(res.body.data.rows[0].issues).toEqual([])
    expect(recordValidateAttemptMock).toHaveBeenCalledTimes(1)
  })

  it('missing property_name → blocker on row', async () => {
    const f = await seedCFixture()
    const csv = CANONICAL_HEADERS + '\n' +
      ',123 Main St,,Phoenix,AZ,85001,residential,Apt 101,2,1,850,apartment,1450,'
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
      'X,1 Main,,Phoenix,AZ,85001,residential,Apt 101,1,1,500,apartment,-50,0'
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
      'Sunset Apts,1 Main,,Phoenix,AZ,85001,residential,Apt 101,1,1,500,apartment,1000,\n' +
      'Sunset Apts,1 Main,,Phoenix,AZ,85001,residential,Apt 101,1,1,500,apartment,1100,'
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
      'Sunset Apts,1 Main St,,Phoenix,AZ,85001,residential,Apt 201,2,1,800,apartment,1500,0'
    const res = await request(buildApp())
      .post('/api/landlords/me/onboard-properties-csv/validate')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ csv, source: 'generic' })
    expect(res.status).toBe(200)
    expect(res.body.data.rows[0].resolvedPropertyId).toBe(existingId)
    expect(res.body.data.summary.newProperties).toBe(0)
    expect(res.body.data.summary.newUnits).toBe(1)
  })

  // S654: a property's dates are its own. A zone the file names is stored in
  // its standard spelling; one GAM can't read (a label like "Mountain", an
  // abbreviation, an offset) is a warning and the state's zone is used (S624).
  it('time zone column: an unreadable zone warns and uses the state\'s zone; a readable one comes back standardized', async () => {
    const f = await seedCFixture()
    const csv = TZ_HEADERS + '\n' +
      'A Apts,1 A St,,Denver,CO,80202,Mars/Base,residential,Apt 1,1,1,500,apartment,1000,\n' +
      'B Apts,1 B St,,Denver,CO,80202,+05:00,residential,Apt 1,1,1,500,apartment,1000,\n' +
      'C Apts,1 C St,,Denver,CO,80202,EST,residential,Apt 1,1,1,500,apartment,1000,\n' +
      'D Apts,1 D St,,Denver,CO,80202,america/denver,residential,Apt 1,1,1,500,apartment,1000,\n' +
      'E Apts,1 E St,,Denver,CO,80202,,residential,Apt 1,1,1,500,apartment,1000,\n' +
      'F Apts,1 F St,,Denver,CO,80202,Mountain,residential,Apt 1,1,1,500,apartment,1000,\n' +
      'G Apts,1 G St,,Denver,CO,80202,MST,residential,Apt 1,1,1,500,apartment,1000,'
    const res = await request(buildApp())
      .post('/api/landlords/me/onboard-properties-csv/validate')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ csv, source: 'generic' })
    expect(res.status).toBe(200)
    const rows = res.body.data.rows
    const tz = (r: any) => r.issues.filter((i: any) => i.field === 'timezone')
    for (const i of [0, 1, 2, 5, 6]) {
      expect(tz(rows[i])).toHaveLength(1)
      expect(tz(rows[i])[0].severity).toBe('warn')
      expect(tz(rows[i])[0].message).toMatch(/GAM can't read ".+" as a time zone, so the property uses its state's time zone \(Mountain time\)/)
    }
    expect(res.body.data.summary.blockers).toBe(0)
    expect(tz(rows[3])).toEqual([])
    expect(rows[3].timezone).toBe('America/Denver')
    expect(rows[4].issues).toEqual([])
  })

  it('time zone column: a state GAM doesn\'t know, with no zone, is blocked in plain words', async () => {
    const f = await seedCFixture()
    const csv = TZ_HEADERS + '\n' +
      'A Apts,1 A St,,Denver,Colorado,80202,,residential,Apt 1,1,1,500,apartment,1000,\n' +
      'B Apts,1 B St,,Denver,XX,80202,Mountain,residential,Apt 1,1,1,500,apartment,1000,\n' +
      'C Apts,1 C St,,Denver,Colorado,80202,America/Denver,residential,Apt 1,1,1,500,apartment,1000,\n' +
      'D Apts,1 D St,,Phoenix,AZ,85001,,residential,Apt 1,1,1,500,apartment,1000,'
    const res = await request(buildApp())
      .post('/api/landlords/me/onboard-properties-csv/validate')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ csv, source: 'generic' })
    expect(res.status).toBe(200)
    const rows = res.body.data.rows
    const stateIssues = (r: any) => r.issues.filter((i: any) => i.field === 'state')
    // Blank zone + unknown state: one blocker, and it replaces the 2-letter hint.
    expect(stateIssues(rows[0])).toEqual([{ severity: 'block', field: 'state',
      message: 'GAM doesn\'t know the state "COLORADO". Use the 2-letter code, like CO, so the property\'s dates run on its own time zone.' }])
    // An unreadable zone falls back to the state, so an unknown state blocks too.
    expect(stateIssues(rows[1]).map((i: any) => i.severity)).toEqual(['block'])
    // A readable zone named in the file needs no state zone.
    expect(stateIssues(rows[2]).map((i: any) => i.severity)).toEqual(['warn'])
    // Arizona IS known — its zone is the old default by right.
    expect(rows[3].issues).toEqual([])
  })

  it('time zone column: a zone on a row for a property already on GAM is a warning, never a change', async () => {
    const f = await seedCFixture()
    const c = await db.connect()
    try {
      await seedProperty(c, { landlordId: f.landlordId, ownerUserId: f.landlordUserId, managedByUserId: f.landlordUserId })
    } finally { c.release() }
    const csv = TZ_HEADERS + '\n' +
      'Test Property,1 Test St,,Phoenix,AZ,85001,America/Denver,residential,Apt 9,1,1,500,apartment,1000,'
    const res = await request(buildApp())
      .post('/api/landlords/me/onboard-properties-csv/validate')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ csv, source: 'generic' })
    expect(res.status).toBe(200)
    const row = res.body.data.rows[0]
    expect(row.resolvedPropertyId).toBeTruthy()
    expect(row.issues.filter((i: any) => i.field === 'timezone')).toEqual([{ severity: 'warn', field: 'timezone',
      message: 'This property is already on GAM, so the import doesn\'t change its time zone. Change it on the property\'s page if it\'s wrong.' }])
  })

  it('time zone column: rows of one property naming two zones → the second is blocked', async () => {
    const f = await seedCFixture()
    const csv = TZ_HEADERS + '\n' +
      'Sunset Apts,1 Main,,Denver,CO,80202,America/Denver,residential,Apt 101,1,1,500,apartment,1000,\n' +
      'Sunset Apts,1 Main,,Denver,CO,80202,America/Chicago,residential,Apt 102,1,1,500,apartment,1000,'
    const res = await request(buildApp())
      .post('/api/landlords/me/onboard-properties-csv/validate')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ csv, source: 'generic' })
    expect(res.status).toBe(200)
    expect(res.body.data.rows[0].issues).toEqual([])
    expect(res.body.data.rows[1].issues.some((i: any) =>
      i.field === 'timezone' && i.severity === 'block' && /America\/Denver/.test(i.message))).toBe(true)
  })

  it('unknown unit_type → blocker (different severity from property_type which is warn)', async () => {
    const f = await seedCFixture()
    const csv = CANONICAL_HEADERS + '\n' +
      'X,1 Main,,Phoenix,AZ,85001,residential,Apt 101,1,1,500,treehouse,1000,'
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
          state: 'AZ', zip: '85001', unitNumber: 'Apt 1',
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
          state: 'AZ', zip: '85001', unitNumber: 'Apt 1',
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
          unitNumber: 'Apt 101', bedrooms: '2', bathrooms: '1.5', sqft: '850',
          unitType: 'apartment',
          rentAmount: '1450', securityDeposit: '1000',
          issues: [],
        }],
        source: 'generic', claimedPlatformName: 'TestPlatform',
        lateFeeDecisions: [{ propertyName: 'Sunset Apts', street1: '1 Main St', unitType: 'apartment', noLateFee: false, graceDays: 5, initialAmount: 15, initialType: 'flat' }],
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
    expect(units.rows[0].unit_number).toBe('Apt 101')
    expect(units.rows[0].unit_type).toBe('apartment')
    expect(Number(units.rows[0].rent_amount)).toBe(1450)
  })

  const commitRow = (over: Record<string, unknown> = {}) => ({
    rowIndex: 0,
    propertyName: 'Pines Park', street1: '9 Pine Rd', street2: '',
    city: 'Denver', state: 'CO', zip: '80202', timezone: '',
    propertyType: 'rv_longterm',
    unitNumber: 'Site 1', bedrooms: '', bathrooms: '', sqft: '',
    unitType: 'rv_spot', rentAmount: '600', securityDeposit: '',
    issues: [],
    ...over,
  })
  const pinesDecision = [{ propertyName: 'Pines Park', street1: '9 Pine Rd', unitType: 'rv_spot', noLateFee: true }]

  // S654: POST /properties opened the window; the CSV commit never did, so a
  // CSV-made property's sitting residents could never skip the background
  // check and the late-fee question never showed.
  it('S654: a CSV-made property has an open onboarding window and its state\'s zone; its first bill is left for the landlord', async () => {
    const f = await seedCFixture()
    const res = await request(buildApp())
      .post('/api/landlords/me/onboard-properties-csv/commit')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ rows: [commitRow()], source: 'generic', claimedPlatformName: 'TestPlatform',
        lateFeeDecisions: pinesDecision })
    expect(res.status).toBe(200)
    const propertyId = res.body.data.properties[0].id as string

    const win = await getOnboardingWindow(propertyId)
    expect(win.open).toBe(true)
    expect(win.startedAt).not.toBeNull()
    expect(win.completedAt).toBeNull()
    expect(win.unitCount).toBe(1)

    const p = (await db.query<{ timezone: string; timezone_source: string; first_billing_cycle: string }>(
      `SELECT timezone, timezone_source, first_billing_cycle::text FROM properties WHERE id=$1`,
      [propertyId])).rows[0]
    expect(p.timezone).toBe('America/Denver')   // was America/Phoenix for every CSV property
    expect(p.timezone_source).toBe('derived')
    // S652: answered once by the landlord, so the import does not pick it.
    expect(p.first_billing_cycle).toBeNull()
  })

  it('S654: a zone the file names is stored in standard form as the landlord\'s own', async () => {
    const f = await seedCFixture()
    const res = await request(buildApp())
      .post('/api/landlords/me/onboard-properties-csv/commit')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ rows: [commitRow({ timezone: 'america/chicago' })], source: 'generic',
        claimedPlatformName: 'TestPlatform', lateFeeDecisions: pinesDecision })
    expect(res.status).toBe(200)
    const p = (await db.query<{ timezone: string; timezone_source: string }>(
      `SELECT timezone, timezone_source FROM properties WHERE id=$1`,
      [res.body.data.properties[0].id])).rows[0]
    expect(p.timezone).toBe('America/Chicago')
    expect(p.timezone_source).toBe('manual')
  })

  it('S654: a zone commit cannot read is left out and the state\'s zone is used', async () => {
    const f = await seedCFixture()
    const res = await request(buildApp())
      .post('/api/landlords/me/onboard-properties-csv/commit')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ rows: [commitRow({ timezone: 'Mountain' })], source: 'generic',
        claimedPlatformName: 'TestPlatform', lateFeeDecisions: pinesDecision })
    expect(res.status).toBe(200)
    const p = (await db.query<{ timezone: string; timezone_source: string }>(
      `SELECT timezone, timezone_source FROM properties WHERE id=$1`,
      [res.body.data.properties[0].id])).rows[0]
    expect(p).toEqual({ timezone: 'America/Denver', timezone_source: 'derived' })
  })

  it('S654: commit refuses a new property in a state GAM doesn\'t know, even with no blocker sent', async () => {
    const f = await seedCFixture()
    const res = await request(buildApp())
      .post('/api/landlords/me/onboard-properties-csv/commit')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ rows: [commitRow({ state: 'Colorado' })], source: 'generic',
        claimedPlatformName: 'TestPlatform', lateFeeDecisions: pinesDecision })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('Row 1: GAM doesn\'t know the state "Colorado". Use the 2-letter code, like CO, so the property\'s dates run on its own time zone.')
    const props = await db.query(`SELECT id FROM properties WHERE landlord_id=$1`, [f.landlordId])
    expect(props.rows.length).toBe(0)
  })

  it('S654: a zone on a row for a property already on GAM does not change it', async () => {
    const f = await seedCFixture()
    const c = await db.connect()
    let propertyId: string
    try {
      propertyId = await seedProperty(c, { landlordId: f.landlordId, ownerUserId: f.landlordUserId, managedByUserId: f.landlordUserId })
    } finally { c.release() }
    const res = await request(buildApp())
      .post('/api/landlords/me/onboard-properties-csv/commit')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ rows: [commitRow({ propertyName: 'Test Property', street1: '1 Test St', city: 'Phoenix', state: 'AZ',
                                 timezone: 'America/Denver', resolvedPropertyId: propertyId! })],
        source: 'generic', claimedPlatformName: 'TestPlatform',
        lateFeeDecisions: [{ propertyName: 'Test Property', street1: '1 Test St', unitType: 'rv_spot', noLateFee: true }] })
    expect(res.status).toBe(200)
    expect(res.body.data.propertiesCreated).toBe(0)
    const p = (await db.query<{ timezone: string }>(`SELECT timezone FROM properties WHERE id=$1`, [propertyId!])).rows[0]
    expect(p.timezone).toBe('America/Phoenix')
  })

  // S654: the property id on a row comes back from the browser. Another
  // landlord's id put a unit on their property and rewrote its late fee.
  it('S654: a row naming another landlord\'s property is refused, and nothing of theirs changes', async () => {
    const a = await seedCFixture()
    const b = await seedCFixture()
    const c = await db.connect()
    let aProperty: string
    try {
      aProperty = await seedProperty(c, { landlordId: a.landlordId, ownerUserId: a.landlordUserId, managedByUserId: a.landlordUserId })
      await seedUnit(c, { propertyId: aProperty, landlordId: a.landlordId, unitType: 'rv_spot', withLateFeeDecision: true })
      await c.query(
        `UPDATE property_unit_type_late_fees
            SET no_late_fee = FALSE, late_fee_grace_days = 5, late_fee_initial_amount = 50, late_fee_initial_type = 'flat'
          WHERE property_id = $1 AND unit_type = 'rv_spot'`, [aProperty])
    } finally { c.release() }
    const snapshot = async () => ({
      units: (await db.query(`SELECT id, unit_number, landlord_id FROM units WHERE property_id=$1 ORDER BY id`, [aProperty!])).rows,
      fees: (await db.query(
        `SELECT unit_type, no_late_fee, late_fee_grace_days, late_fee_initial_amount::text, late_fee_initial_type
           FROM property_unit_type_late_fees WHERE property_id=$1 ORDER BY unit_type`, [aProperty!])).rows,
      property: (await db.query(`SELECT name, landlord_id, timezone FROM properties WHERE id=$1`, [aProperty!])).rows,
    })
    const before = await snapshot()

    const res = await request(buildApp())
      .post('/api/landlords/me/onboard-properties-csv/commit')
      .set('Authorization', `Bearer ${b.landlordToken}`)
      .send({ rows: [commitRow({ propertyName: 'Test Property', street1: '1 Test St', unitNumber: 'Site 1',
                                 resolvedPropertyId: aProperty! })],
        source: 'generic', claimedPlatformName: 'TestPlatform',
        lateFeeDecisions: [{ propertyName: 'Test Property', street1: '1 Test St', unitType: 'rv_spot', noLateFee: true }] })
    expect(res.status).toBe(403)
    expect(res.body.error).toBe('Row 1 references a property not owned by this landlord')
    expect(await snapshot()).toEqual(before)
    expect(before.fees[0].late_fee_initial_amount).toBe('50.00')
    expect((await db.query(`SELECT id FROM units WHERE landlord_id=$1`, [b.landlordId])).rows).toEqual([])

    // A made-up id is refused the same way, not a server error.
    const junk = await request(buildApp())
      .post('/api/landlords/me/onboard-properties-csv/commit')
      .set('Authorization', `Bearer ${b.landlordToken}`)
      .send({ rows: [commitRow({ resolvedPropertyId: 'not-a-uuid' })],
        source: 'generic', claimedPlatformName: 'TestPlatform', lateFeeDecisions: pinesDecision })
    expect(junk.status).toBe(403)
  })
})
