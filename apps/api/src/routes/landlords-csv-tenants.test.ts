/**
 * landlords.ts tenants-CSV slice — S360 (landlords slice 5 of N).
 *
 * S655 (Nic, 10/2): the tenant CSV is a DRAFT ROSTER. template / validate /
 * draft; /commit is retired (410). Validate only checks the file; draft saves
 * who lives where and creates no user, tenant, invite, lease or invoice, and
 * emails nobody. The roster review and confirm live in tenantRosterDrafts.test.ts.
 *
 * Coverage focus:
 *   - Template: roster columns first
 *   - Validate: what blocks a row (name, email, a login that isn't a
 *     resident's, an unreadable balance, no property) and what only notes it
 *     (unit not found or taken → not placed, rent differs, repeated email,
 *     already with you); another company's resident is saved with no note
 *     (the check is not a lookup of who belongs where); lease columns never block
 *   - Draft: nothing created or sent; re-upload updates; blocked rows listed
 *   - Commit: retired
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
  cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedTenant, seedLease, seedLeaseTenant,
} from '../test/dbHelpers'
import { logger } from '../lib/logger'

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
    const unitId = await seedUnit(client, { propertyId, landlordId, withLateFeeDecision: true })
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

describe('POST /api/landlords/me/onboard-tenants-csv/validate — checks the file only', () => {
  const validate = (f: TFixture, csv: string, source = 'generic') => request(buildApp())
    .post('/api/landlords/me/onboard-tenants-csv/validate')
    .set('Authorization', `Bearer ${f.landlordToken}`)
    .send({ csv, source })

  it('headers only (no data rows) → 400', async () => {
    const f = await seedTFixture()
    const res = await validate(f, CANONICAL_HEADERS)
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/no rows/)
  })

  it('a row on a real unit is ready, with its unit and property found', async () => {
    const f = await seedTFixture()
    const res = await validate(f, CANONICAL_HEADERS + '\n' + rowFor(f))
    expect(res.status).toBe(200)
    expect(res.body.data.summary).toMatchObject({ total: 1, blockers: 0, ready: 1 })
    expect(res.body.data.rows[0].resolvedUnitId).toBe(f.unitId)
    expect(res.body.data.rows[0].resolvedPropertyId).toBe(f.propertyId)
    expect(res.body.data.rows[0].issues.filter((i: any) => i.severity === 'block')).toEqual([])
  })

  it('checking the file creates nobody and sends nothing', async () => {
    const f = await seedTFixture()
    const email = `nobody-${randomUUID().slice(0, 6)}@test.dev`
    await validate(f, CANONICAL_HEADERS + '\n' + rowFor(f, { email }))
    expect((await db.query(`SELECT id FROM users WHERE email=$1`, [email])).rows).toEqual([])
    expect((await db.query(`SELECT id FROM tenant_roster_drafts`)).rows).toEqual([])
    expect(emailTenantOnboardedMock).not.toHaveBeenCalled()
  })

  it('invalid email format → blocker on email field', async () => {
    const f = await seedTFixture()
    const res = await validate(f, CANONICAL_HEADERS + '\n' + rowFor(f, { email: 'not-an-email' }))
    const issues = res.body.data.rows[0].issues
    expect(issues.some((i: any) => i.field === 'email' && i.severity === 'block' && /valid address/.test(i.message))).toBe(true)
  })

  it('a property that is not in the company blocks the row and says the name must match', async () => {
    const f = await seedTFixture()
    // A second property so the company has more than one (with one, the file's
    // rows are simply that property's).
    await db.query(
      `INSERT INTO properties (landlord_id, name, street1, city, state, zip, owner_user_id, managed_by_user_id)
       VALUES ($1, 'Other Park', '1 Elm', 'Phoenix', 'AZ', '85001', $2, $2)`, [f.landlordId, f.landlordUserId])
    const res = await validate(f, CANONICAL_HEADERS + '\n' + rowFor(f, { property_name: 'Nonexistent', unit_number: '999' }))
    const issues = res.body.data.rows[0].issues
    expect(issues.some((i: any) => i.field === 'property_name' && i.severity === 'block' && /No property named/.test(i.message))).toBe(true)
    expect(res.body.data.rows[0].resolvedUnitId).toBeUndefined()
  })

  it('a unit the file names that does not exist is NOT a blocker — they are saved as not placed', async () => {
    const f = await seedTFixture()
    const res = await validate(f, CANONICAL_HEADERS + '\n' + rowFor(f, { unit_number: '999' }))
    const row = res.body.data.rows[0]
    expect(row.issues.some((i: any) => i.severity === 'block')).toBe(false)
    expect(row.issues.some((i: any) => i.field === 'unit_number' && /not placed/.test(i.message))).toBe(true)
    expect(row.resolvedUnitId).toBeUndefined()
    expect(row.resolvedPropertyId).toBe(f.propertyId)
    expect(res.body.data.summary.ready).toBe(1)
  })

  it('a unit that already has an active lease places the person nowhere (noted, not blocked)', async () => {
    const f = await seedTFixture()
    const c = await db.connect()
    try {
      await c.query('BEGIN')
      const t = await seedTenant(c)
      const l = await seedLease(c, { unitId: f.unitId, landlordId: f.landlordId, status: 'active' })
      await seedLeaseTenant(c, { leaseId: l, tenantId: t, role: 'primary' })
      await c.query('COMMIT')
    } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
    const res = await validate(f, CANONICAL_HEADERS + '\n' + rowFor(f))
    const row = res.body.data.rows[0]
    expect(row.issues.some((i: any) => i.severity === 'block')).toBe(false)
    expect(row.issues.some((i: any) => /already has an active lease/.test(i.message))).toBe(true)
    expect(row.resolvedUnitId).toBeUndefined()
  })

  it('the same email twice: only the first row is saved, and the second says so', async () => {
    const f = await seedTFixture()
    const shared = `dup-${randomUUID().slice(0, 6)}@test.dev`
    const res = await validate(f, CANONICAL_HEADERS + '\n'
      + rowFor(f, { email: shared }) + '\n' + rowFor(f, { email: shared, first_name: 'Bob' }))
    const second = res.body.data.rows[1]
    expect(second.skip).toBe(true)
    expect(second.issues.some((i: any) => i.field === 'email' && i.severity === 'warn' && /Same email as row 1/.test(i.message))).toBe(true)
    expect(res.body.data.summary.ready).toBe(1)
  })

  it('lease columns are reference only: no phone, no rent, no start date or a half-filled auto-renew never block', async () => {
    const f = await seedTFixture()
    const res = await validate(f, CANONICAL_HEADERS + '\n'
      + rowFor(f, { phone: '', monthly_rent: '', lease_start: '', lease_end: 'whenever', auto_renew: 'yes' }))
    expect(res.body.data.rows[0].issues.filter((i: any) => i.severity === 'block')).toEqual([])
    expect(res.body.data.summary.ready).toBe(1)
  })

  it("a file rent that differs from the unit's rent is flagged with both amounts", async () => {
    const f = await seedTFixture()
    await db.query(`UPDATE units SET rent_amount = 900 WHERE id = $1`, [f.unitId])
    const res = await validate(f, CANONICAL_HEADERS + '\n' + rowFor(f, { monthly_rent: '1500' }))
    const note = res.body.data.rows[0].issues.find((i: any) => i.field === 'monthly_rent')
    expect(note.severity).toBe('warn')
    expect(note.message).toMatch(/\$1500/)
    expect(note.message).toMatch(/\$900/)
    expect(res.body.data.rows[0].unitRent).toBe(900)
  })

  it("another company's resident is never blocked, and the file check never says who belongs to another company", async () => {
    const other = await seedTFixture()
    const f = await seedTFixture()
    const email = `elsewhere-${randomUUID().slice(0, 6)}@test.dev`
    const c = await db.connect()
    try {
      await c.query('BEGIN')
      const t = await seedTenant(c, { email })
      const l = await seedLease(c, { unitId: other.unitId, landlordId: other.landlordId, status: 'active' })
      await seedLeaseTenant(c, { leaseId: l, tenantId: t, role: 'primary' })
      await c.query('COMMIT')
    } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
    const res = await validate(f, CANONICAL_HEADERS + '\n' + rowFor(f, { email }))
    const row = res.body.data.rows[0]
    expect(row.issues.some((i: any) => i.severity === 'block')).toBe(false)
    // Uploading a list of addresses must not reveal which belong to other
    // companies' people: this row reads exactly like a stranger's.
    expect(row.issues.filter((i: any) => i.field === 'email')).toEqual([])
    expect(JSON.stringify(res.body)).not.toMatch(/another company/i)
    expect(res.body.data.summary.ready).toBe(1)
  })

  it("a one-property company's file naming ANOTHER park is blocked, never placed on this park's units", async () => {
    const f = await seedTFixture()
    const res = await validate(f, CANONICAL_HEADERS + '\n' + rowFor(f, { property_name: 'Pine Hollow (not in GAM yet)' }))
    const row = res.body.data.rows[0]
    expect(row.resolvedUnitId).toBeUndefined()
    const block = row.issues.find((i: any) => i.field === 'property_name')
    expect(block.severity).toBe('block')
    expect(block.message).toMatch(/No property named "Pine Hollow \(not in GAM yet\)"/)
    expect(block.message).toContain(f.propertyName)
    expect(res.body.data.summary.ready).toBe(0)
  })

  it("a one-property company may leave the property column blank", async () => {
    const f = await seedTFixture()
    const res = await validate(f, CANONICAL_HEADERS + '\n' + rowFor(f, { property_name: '' }))
    const row = res.body.data.rows[0]
    expect(row.resolvedUnitId).toBe(f.unitId)
    expect(row.issues.some((i: any) => i.severity === 'block')).toBe(false)
  })

  it("a landlord's own login is refused at validate (isn't a resident's)", async () => {
    const victim = await seedTFixture()
    const f = await seedTFixture()
    const victimEmail = (await db.query(`SELECT email FROM users WHERE id=$1`, [victim.landlordUserId])).rows[0].email
    const res = await validate(f, CANONICAL_HEADERS + '\n' + rowFor(f, { email: victimEmail.toUpperCase() }))
    expect(res.body.data.rows[0].issues.some((i: any) => i.severity === 'block' && /isn't a resident's/.test(i.message))).toBe(true)
  })

  it('someone already on an active lease with you is noted and left out', async () => {
    const f = await seedTFixture()
    const email = `mine-${randomUUID().slice(0, 6)}@test.dev`
    const c = await db.connect()
    let unit2 = ''
    try {
      await c.query('BEGIN')
      unit2 = await seedUnit(c, { propertyId: f.propertyId, landlordId: f.landlordId })
      const t = await seedTenant(c, { email })
      const l = await seedLease(c, { unitId: unit2, landlordId: f.landlordId, status: 'active' })
      await seedLeaseTenant(c, { leaseId: l, tenantId: t, role: 'primary' })
      await c.query('COMMIT')
    } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
    const res = await validate(f, CANONICAL_HEADERS + '\n' + rowFor(f, { email }))
    expect(res.body.data.rows[0].skip).toBe(true)
    expect(res.body.data.rows[0].issues.some((i: any) => /Already on an active lease with you/.test(i.message))).toBe(true)
  })
})

describe('POST /api/landlords/me/onboard-tenants-csv/draft — saves a draft roster', () => {
  const draft = (f: TFixture, csv: string, extra: any = {}) => request(buildApp())
    .post('/api/landlords/me/onboard-tenants-csv/draft')
    .set('Authorization', `Bearer ${f.landlordToken}`)
    .send({ csv, source: 'generic', claimedPlatformName: 'TestPlatform', ...extra })

  it('saves who lives where and creates NO user, tenant, invite, lease or invoice — and emails nobody', async () => {
    const f = await seedTFixture()
    const email = `roster-${randomUUID().slice(0, 6)}@test.dev`
    const res = await draft(f, CANONICAL_HEADERS + '\n' + rowFor(f, { email, outstanding_balance: '125.50' }))
    expect(res.status).toBe(200)
    expect(res.body.data.saved).toBe(1)
    expect(res.body.data.properties).toEqual([{ propertyId: f.propertyId, propertyName: f.propertyName, count: 1 }])

    const rows = (await db.query(
      `SELECT unit_id, email, opening_balance::float AS opening_balance, confirmed_at, file_values
         FROM tenant_roster_drafts WHERE landlord_id=$1`, [f.landlordId])).rows
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ unit_id: f.unitId, email, opening_balance: 125.5, confirmed_at: null })
    expect(rows[0].file_values.monthlyRent).toBe('1500')

    expect((await db.query(`SELECT id FROM users WHERE email=$1`, [email])).rows).toEqual([])
    expect((await db.query(`SELECT id FROM pending_tenant_intents`)).rows).toEqual([])
    expect((await db.query(`SELECT id FROM leases WHERE landlord_id=$1`, [f.landlordId])).rows).toEqual([])
    expect((await db.query(`SELECT id FROM invoices WHERE landlord_id=$1`, [f.landlordId])).rows).toEqual([])
    expect(emailTenantOnboardedMock).not.toHaveBeenCalled()
    expect(recordCommitAttemptMock).toHaveBeenCalledTimes(1)
  })

  it('uploading the file again updates the same person instead of adding them twice', async () => {
    const f = await seedTFixture()
    const email = `again-${randomUUID().slice(0, 6)}@test.dev`
    await draft(f, CANONICAL_HEADERS + '\n' + rowFor(f, { email, first_name: 'Ann' }))
    const res = await draft(f, CANONICAL_HEADERS + '\n' + rowFor(f, { email: email.toUpperCase(), first_name: 'Anne' }))
    expect(res.body.data.saved).toBe(0)
    expect(res.body.data.updated).toBe(1)
    const rows = (await db.query(`SELECT first_name FROM tenant_roster_drafts WHERE landlord_id=$1`, [f.landlordId])).rows
    expect(rows).toEqual([{ first_name: 'Anne' }])
  })

  it('a row that cannot be saved is listed with why, and everyone else is saved', async () => {
    const f = await seedTFixture()
    const ok = `ok-${randomUUID().slice(0, 6)}@test.dev`
    const res = await draft(f, CANONICAL_HEADERS + '\n'
      + rowFor(f, { email: ok }) + '\n' + rowFor(f, { email: 'broken', first_name: 'Bad' }))
    expect(res.body.data.saved).toBe(1)
    expect(res.body.data.notSaved).toHaveLength(1)
    expect(res.body.data.notSaved[0].rowIndex).toBe(1)
    expect(res.body.data.notSaved[0].reasons.join(' ')).toMatch(/valid address/)
  })

  it('a generic file must name the platform it came from first', async () => {
    const f = await seedTFixture()
    const res = await draft(f, CANONICAL_HEADERS + '\n' + rowFor(f), { claimedPlatformName: '' })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/platform/)
  })

  it("another company's resident is saved like anyone else (imports are never blocked)", async () => {
    const other = await seedTFixture()
    const f = await seedTFixture()
    const email = `elsewhere-${randomUUID().slice(0, 6)}@test.dev`
    const c = await db.connect()
    try {
      await c.query('BEGIN')
      const t = await seedTenant(c, { email })
      const l = await seedLease(c, { unitId: other.unitId, landlordId: other.landlordId, status: 'active' })
      await seedLeaseTenant(c, { leaseId: l, tenantId: t, role: 'primary' })
      await c.query('COMMIT')
    } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
    const res = await draft(f, CANONICAL_HEADERS + '\n' + rowFor(f, { email }))
    expect(res.body.data.saved).toBe(1)
  })

  it('ids the browser sends about rows are ignored — the server re-reads the file', async () => {
    const victim = await seedTFixture()
    const f = await seedTFixture()
    const res = await draft(f, CANONICAL_HEADERS + '\n' + rowFor(f), {
      rows: [{ rowIndex: 0, resolvedUnitId: victim.unitId, email: 'x@y.z' }],
    })
    expect(res.status).toBe(200)
    expect((await db.query(`SELECT id FROM tenant_roster_drafts WHERE unit_id=$1`, [victim.unitId])).rows).toEqual([])
  })
})

describe('POST /api/landlords/me/onboard-tenants-csv/commit — retired', () => {
  it('answers 410 with the next step and writes nothing', async () => {
    const f = await seedTFixture()
    const email = `commit-${randomUUID().slice(0, 6)}@test.dev`
    const res = await request(buildApp())
      .post('/api/landlords/me/onboard-tenants-csv/commit')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ rows: [{ rowIndex: 0, firstName: 'A', lastName: 'B', email, resolvedUnitId: f.unitId, issues: [] }],
              source: 'generic', claimedPlatformName: 'TestPlatform' })
    expect(res.status).toBe(410)
    expect(res.body.error).toMatch(/draft roster/)
    expect((await db.query(`SELECT id FROM users WHERE email=$1`, [email])).rows).toEqual([])
    expect((await db.query(`SELECT id FROM leases WHERE unit_id=$1`, [f.unitId])).rows).toEqual([])
    expect(emailTenantOnboardedMock).not.toHaveBeenCalled()
    // Never logs a setup link either.
    void logger
  })
})
