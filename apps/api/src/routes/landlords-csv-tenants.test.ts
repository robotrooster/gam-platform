/**
 * landlords.ts tenants-CSV slice — S360 (landlords slice 5 of N).
 *
 * Companion to S359's properties-CSV slice. Onboarding triad for
 * existing tenants: template / validate / commit. 3 routes, ~700 LoC.
 *
 * Coverage focus:
 *   - Template returns CSV with canonical first_name column
 *   - Validate: required-field blockers, email format, unit
 *     resolution (no match / occupied / co-tenant + dup-email
 *     warning), auto_renew + auto_renew_mode pairing
 *   - Commit: empty-rows guard, generic-without-claim guard,
 *     defense-in-depth cross-landlord unit (403), blockers-still-
 *     present (400), happy path (creates users + tenants + lease +
 *     lease_tenants + emails)
 *
 * Out of scope (future sessions):
 *   - Payment-history CSV (template + validate + commit, 3 routes)
 *
 * csvImportAttempts + emailTenantOnboarded are mocked (their
 * side-effects have their own coverage).
 */

import { vi, describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { randomUUID } from 'crypto'
import { db } from '../db'
import {
  cleanupAllSchema, seedLandlord, seedProperty, seedUnit,
} from '../test/dbHelpers'

const {
  recordValidateAttemptMock,
  recordCommitAttemptMock,
  getPlatformReviewStatusMock,
  extractAttemptShapeMock,
  notifyCsvReviewPendingIfNeededMock,
  emailTenantOnboardedMock,
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
  emailTenantOnboardedMock:           vi.fn(async (..._args: any[]) => 'msg_mock'),
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
vi.mock('../services/email', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, emailTenantOnboarded: emailTenantOnboardedMock }
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
  emailTenantOnboardedMock.mockClear()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_csv_tn'
})

interface TFixture {
  landlordUserId: string
  landlordId:     string
  landlordToken:  string
  propertyId:     string
  unitId:         string
  propertyName:   string
  unitNumber:     string
}

async function seedTFixture(): Promise<TFixture> {
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    const { userId: landlordUserId, landlordId } = await seedLandlord(client)
    const propertyId = await seedProperty(client, {
      landlordId, ownerUserId: landlordUserId, managedByUserId: landlordUserId,
    })
    // Force property name + unit number to known values so CSV rows can match
    const propertyName = `CSV-Prop-${randomUUID().slice(0, 6)}`
    await client.query(`UPDATE properties SET name=$1 WHERE id=$2`, [propertyName, propertyId])
    const unitId = await seedUnit(client, { propertyId, landlordId })
    const unitNumber = '101'
    await client.query(`UPDATE units SET unit_number=$1 WHERE id=$2`, [unitNumber, unitId])
    await client.query('COMMIT')
    const landlordToken = jwt.sign(
      { userId: landlordUserId, role: 'landlord', email: 'll@test.dev',
        profileId: landlordId, permissions: {} },
      process.env.JWT_SECRET!, { expiresIn: '1h' },
    )
    return { landlordUserId, landlordId, landlordToken, propertyId, unitId, propertyName, unitNumber }
  } catch (e) { await client.query('ROLLBACK'); throw e }
  finally { client.release() }
}

const CANONICAL_HEADERS = [
  'first_name', 'last_name', 'email', 'phone',
  'property_name', 'unit_number',
  'lease_start', 'lease_end', 'monthly_rent', 'security_deposit',
  'late_fee_amount', 'late_fee_grace_days',
  'auto_renew', 'auto_renew_mode', 'notice_days_required',
  'outstanding_balance',
].join(',')

function rowFor(f: TFixture, overrides: Record<string, string> = {}): string {
  const defaults: Record<string, string> = {
    first_name: 'Alice', last_name: 'Smith',
    email: `alice-${randomUUID().slice(0,6)}@test.dev`, phone: '555-1234',
    property_name: f.propertyName, unit_number: f.unitNumber,
    lease_start: '2026-01-01', lease_end: '2027-01-01',
    monthly_rent: '1500', security_deposit: '1000',
    late_fee_amount: '', late_fee_grace_days: '',
    auto_renew: '', auto_renew_mode: '', notice_days_required: '',
    outstanding_balance: '',
  }
  const merged = { ...defaults, ...overrides }
  return [
    merged.first_name, merged.last_name, merged.email, merged.phone,
    merged.property_name, merged.unit_number,
    merged.lease_start, merged.lease_end, merged.monthly_rent, merged.security_deposit,
    merged.late_fee_amount, merged.late_fee_grace_days,
    merged.auto_renew, merged.auto_renew_mode, merged.notice_days_required,
    merged.outstanding_balance,
  ].join(',')
}

describe('GET /api/landlords/me/onboard-tenants-csv/template', () => {
  it('source=generic returns CSV with first_name column', async () => {
    const f = await seedTFixture()
    const res = await request(buildApp())
      .get('/api/landlords/me/onboard-tenants-csv/template?source=generic')
      .set('Authorization', `Bearer ${f.landlordToken}`)
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toMatch(/text\/csv/)
    expect(res.text.toLowerCase()).toMatch(/first_name/)
  })
})

describe('POST /api/landlords/me/onboard-tenants-csv/validate', () => {
  it('headers only (no data rows) → 400', async () => {
    const f = await seedTFixture()
    const res = await request(buildApp())
      .post('/api/landlords/me/onboard-tenants-csv/validate')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ csv: CANONICAL_HEADERS, source: 'generic' })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/no data rows/)
  })

  it('happy: 1 row with matching unit → resolvedUnitId stamped, ready=1', async () => {
    const f = await seedTFixture()
    const csv = CANONICAL_HEADERS + '\n' + rowFor(f)
    const res = await request(buildApp())
      .post('/api/landlords/me/onboard-tenants-csv/validate')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ csv, source: 'generic' })
    expect(res.status).toBe(200)
    expect(res.body.data.summary).toMatchObject({ total: 1, blockers: 0, ready: 1 })
    expect(res.body.data.rows[0].resolvedUnitId).toBe(f.unitId)
    expect(res.body.data.rows[0].issues).toEqual([])
  })

  it('invalid email format → blocker on email field', async () => {
    const f = await seedTFixture()
    const csv = CANONICAL_HEADERS + '\n' + rowFor(f, { email: 'not-an-email' })
    const res = await request(buildApp())
      .post('/api/landlords/me/onboard-tenants-csv/validate')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ csv, source: 'generic' })
    expect(res.status).toBe(200)
    const issues = res.body.data.rows[0].issues
    expect(issues.some((i: any) => i.field === 'email' && i.severity === 'block' && /Invalid email/.test(i.message))).toBe(true)
  })

  it('no matching unit in landlord portfolio → blocker', async () => {
    const f = await seedTFixture()
    const csv = CANONICAL_HEADERS + '\n' + rowFor(f, { property_name: 'Nonexistent', unit_number: '999' })
    const res = await request(buildApp())
      .post('/api/landlords/me/onboard-tenants-csv/validate')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ csv, source: 'generic' })
    expect(res.status).toBe(200)
    const issues = res.body.data.rows[0].issues
    expect(issues.some((i: any) => i.field === 'unit_number' && i.severity === 'block' && /No unit/.test(i.message))).toBe(true)
    expect(res.body.data.rows[0].resolvedUnitId).toBeUndefined()
  })

  it('unit already occupied → blocker on first new row', async () => {
    const f = await seedTFixture()
    // Pre-seed an active lease + lease_tenant linking a primary tenant to f.unitId,
    // so v_unit_occupancy reports it occupied.
    const client = await db.connect()
    try {
      await client.query('BEGIN')
      const u = await client.query<{ id: string }>(
        `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
         VALUES ($1, 'x', 'tenant', 'Existing', 'Tenant', TRUE) RETURNING id`,
        [`existing-${randomUUID()}@test.dev`])
      const t = await client.query<{ id: string }>(
        `INSERT INTO tenants (user_id) VALUES ($1) RETURNING id`, [u.rows[0].id])
      const l = await client.query<{ id: string }>(
        `INSERT INTO leases (unit_id, landlord_id, status, start_date, rent_amount, lease_type)
         VALUES ($1, $2, 'active', CURRENT_DATE, 1500, 'fixed_term') RETURNING id`,
        [f.unitId, f.landlordId])
      await client.query(
        `INSERT INTO lease_tenants (lease_id, tenant_id, role, status)
         VALUES ($1, $2, 'primary', 'active')`,
        [l.rows[0].id, t.rows[0].id])
      await client.query('COMMIT')
    } catch (e) { await client.query('ROLLBACK'); throw e } finally { client.release() }

    const csv = CANONICAL_HEADERS + '\n' + rowFor(f)
    const res = await request(buildApp())
      .post('/api/landlords/me/onboard-tenants-csv/validate')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ csv, source: 'generic' })
    expect(res.status).toBe(200)
    const issues = res.body.data.rows[0].issues
    expect(issues.some((i: any) => i.field === 'unit_number' && i.severity === 'block' && /already occupied/.test(i.message))).toBe(true)
  })

  it('duplicate email in batch → warn on second row', async () => {
    const f = await seedTFixture()
    const sharedEmail = `dup-${randomUUID().slice(0,6)}@test.dev`
    const csv = CANONICAL_HEADERS + '\n'
      + rowFor(f, { email: sharedEmail }) + '\n'
      + rowFor(f, { email: sharedEmail, first_name: 'Bob' })
    const res = await request(buildApp())
      .post('/api/landlords/me/onboard-tenants-csv/validate')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ csv, source: 'generic' })
    expect(res.status).toBe(200)
    // Second row has the duplicate-email warn
    const secondIssues = res.body.data.rows[1].issues
    expect(secondIssues.some((i: any) => i.field === 'email' && i.severity === 'warn' && /Duplicate/.test(i.message))).toBe(true)
  })

  it('auto_renew=yes without auto_renew_mode → blocker', async () => {
    const f = await seedTFixture()
    const csv = CANONICAL_HEADERS + '\n' + rowFor(f, { auto_renew: 'yes' })
    const res = await request(buildApp())
      .post('/api/landlords/me/onboard-tenants-csv/validate')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ csv, source: 'generic' })
    expect(res.status).toBe(200)
    const issues = res.body.data.rows[0].issues
    expect(issues.some((i: any) => i.field === 'auto_renew_mode' && i.severity === 'block')).toBe(true)
  })
})

describe('POST /api/landlords/me/onboard-tenants-csv/commit', () => {
  function baseRow(f: TFixture, overrides: any = {}) {
    return {
      rowIndex: 0,
      firstName: 'Alice', lastName: 'Smith',
      email: `alice-${randomUUID().slice(0,6)}@test.dev`,
      phone: '555-1234',
      propertyName: f.propertyName, unitNumber: f.unitNumber,
      leaseStart: '2026-01-01', leaseEnd: '2027-01-01',
      monthlyRent: '1500', securityDeposit: '1000',
      lateFeeAmount: '', lateFeeGraceDays: '',
      autoRenew: '', autoRenewMode: '', noticeDaysRequired: '',
      outstandingBalance: '',
      resolvedUnitId: f.unitId,
      issues: [],
      ...overrides,
    }
  }

  it('empty rows → 400', async () => {
    const f = await seedTFixture()
    const res = await request(buildApp())
      .post('/api/landlords/me/onboard-tenants-csv/commit')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ rows: [], source: 'generic', claimedPlatformName: 'X' })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/rows array required/)
  })

  it('generic source without claimedPlatformName → 400', async () => {
    const f = await seedTFixture()
    const res = await request(buildApp())
      .post('/api/landlords/me/onboard-tenants-csv/commit')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ rows: [baseRow(f)], source: 'generic' })  // no claimedPlatformName
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/claimedPlatformName is required/)
  })

  it('defense-in-depth: cross-landlord unit → 403', async () => {
    const a = await seedTFixture()
    const b = await seedTFixture()
    const res = await request(buildApp())
      .post('/api/landlords/me/onboard-tenants-csv/commit')
      .set('Authorization', `Bearer ${a.landlordToken}`)
      .send({
        rows: [baseRow(a, { resolvedUnitId: b.unitId })],  // b's unit, a's token
        source: 'generic', claimedPlatformName: 'TestPlatform',
      })
    expect(res.status).toBe(403)
    expect(res.body.error).toMatch(/not owned by this landlord/)
  })

  it('rows with remaining blockers → 400 + nothing committed', async () => {
    const f = await seedTFixture()
    const res = await request(buildApp())
      .post('/api/landlords/me/onboard-tenants-csv/commit')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({
        rows: [baseRow(f, { issues: [{ severity: 'block', field: 'foo', message: 'still bad' }] })],
        source: 'generic', claimedPlatformName: 'TestPlatform',
      })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/Row 1 still has blockers: still bad/)
    // No tenant created
    const tenants = await db.query(`SELECT id FROM tenants`)
    expect(tenants.rows.length).toBe(0)
  })

  it('happy path: creates user + tenant + lease + lease_tenant + fires email', async () => {
    const f = await seedTFixture()
    const email = `alice-${randomUUID().slice(0,6)}@test.dev`
    const res = await request(buildApp())
      .post('/api/landlords/me/onboard-tenants-csv/commit')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({
        rows: [baseRow(f, { email })],
        source: 'generic', claimedPlatformName: 'TestPlatform',
      })
    expect(res.status).toBe(200)
    expect(res.body.data.committed).toBe(1)
    expect(res.body.data.leases).toBe(1)

    const u = await db.query<{ id: string; role: string }>(
      `SELECT id, role FROM users WHERE email=$1`, [email])
    expect(u.rows.length).toBe(1)
    expect(u.rows[0].role).toBe('tenant')

    const t = await db.query<{ id: string; user_id: string }>(
      `SELECT id, user_id FROM tenants WHERE user_id=$1`, [u.rows[0].id])
    expect(t.rows.length).toBe(1)

    const l = await db.query<{ id: string; status: string; rent_amount: string; lease_source: string }>(
      `SELECT id, status, rent_amount::text, lease_source FROM leases WHERE unit_id=$1`, [f.unitId])
    expect(l.rows.length).toBe(1)
    expect(l.rows[0].status).toBe('active')
    expect(Number(l.rows[0].rent_amount)).toBe(1500)
    expect(l.rows[0].lease_source).toBe('imported')

    const lt = await db.query<{ role: string; status: string }>(
      `SELECT role, status FROM lease_tenants WHERE lease_id=$1 AND tenant_id=$2`,
      [l.rows[0].id, t.rows[0].id])
    expect(lt.rows.length).toBe(1)
    expect(lt.rows[0].role).toBe('primary')
    expect(lt.rows[0].status).toBe('active')

    expect(emailTenantOnboardedMock).toHaveBeenCalledTimes(1)
    const callArgs = emailTenantOnboardedMock.mock.calls[0]!
    expect(callArgs[0]).toBe(email)  // first arg is recipient email
  })
})
