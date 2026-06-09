/**
 * Payment History CSV endpoints (S29X / Phase B).
 *
 * Covers:
 *   - Validate happy path resolves email → active lease in this landlord's
 *     portfolio.
 *   - Validate blocks when no active lease found for the email.
 *   - Validate blocks negative amounts (refunds/credits out of scope).
 *   - Validate normalizes platform-specific payment_type vocab
 *     ("Rent Payment" → rent, "Late Fee" → late_fee).
 *   - Validate blocks unknown payment_type strings.
 *   - Ambiguity (multiple active leases for one email) blocks unless
 *     disambiguated via property_name + unit_number columns.
 *   - Commit writes payments rows with status='settled',
 *     import_source=<platform>, settled_at = payment_date.
 *   - Commit refuses any row with a blocker.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { db } from '../db'
import { cleanupAllSchema } from '../test/dbHelpers'
import { landlordsRouter } from './landlords'
import { errorHandler } from '../middleware/errorHandler'

function buildApp() {
  const app = express()
  app.use(express.json({ limit: '10mb' }))
  app.use('/api/landlords', landlordsRouter)
  app.use(errorHandler)
  return app
}

interface SeedResult {
  landlordId: string
  userId:     string
  propertyId: string
  unitId:     string
  tenantId:   string
  leaseId:    string
  tenantEmail: string
  token:      string
}

async function seedLandlordWithActiveLease(
  opts: {
    tenantEmail?: string
    propertyName?: string
    unitNumber?: string
    tenantFirstName?: string
    tenantLastName?: string
  } = {}
): Promise<SeedResult> {
  const llEmail = `ll-${Math.random().toString(36).slice(2)}@test.dev`
  const tenantEmail = opts.tenantEmail || `tenant-${Math.random().toString(36).slice(2)}@test.dev`

  const llU = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
     VALUES ($1, 'x', 'landlord', 'Test', 'LL', TRUE) RETURNING id`,
    [llEmail],
  )
  const userId = llU.rows[0].id
  const ll = await db.query<{ id: string }>(
    `INSERT INTO landlords (user_id) VALUES ($1) RETURNING id`,
    [userId],
  )
  const landlordId = ll.rows[0].id

  const p = await db.query<{ id: string }>(
    `INSERT INTO properties (landlord_id, name, street1, city, state, zip,
                             owner_user_id, managed_by_user_id)
     VALUES ($1, $2, '100 Main St', 'Phoenix', 'AZ', '85001', $3, $3)
     RETURNING id`,
    [landlordId, opts.propertyName || 'Sunset Apartments', userId],
  )
  const propertyId = p.rows[0].id

  const un = await db.query<{ id: string }>(
    `INSERT INTO units (property_id, landlord_id, unit_number, rent_amount)
     VALUES ($1, $2, $3, 1850) RETURNING id`,
    [propertyId, landlordId, opts.unitNumber || '4B'],
  )
  const unitId = un.rows[0].id

  const tU = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
     VALUES ($1, 'x', 'tenant', $2, $3, TRUE) RETURNING id`,
    [tenantEmail, opts.tenantFirstName || 'Test', opts.tenantLastName || 'Tenant'],
  )
  const tenantUserId = tU.rows[0].id

  const t = await db.query<{ id: string }>(
    `INSERT INTO tenants (user_id) VALUES ($1) RETURNING id`,
    [tenantUserId],
  )
  const tenantId = t.rows[0].id

  const lease = await db.query<{ id: string }>(
    `INSERT INTO leases (unit_id, landlord_id, status, start_date, rent_amount,
                         lease_type, needs_review, lease_source)
     VALUES ($1, $2, 'active', '2024-06-01', 1850, 'month_to_month', FALSE, 'imported')
     RETURNING id`,
    [unitId, landlordId],
  )
  const leaseId = lease.rows[0].id

  await db.query(
    `INSERT INTO lease_tenants (lease_id, tenant_id, role, status, added_at, added_reason, financial_responsibility)
     VALUES ($1, $2, 'primary', 'active', NOW(), 'original', 'joint_several')`,
    [leaseId, tenantId],
  )

  const token = jwt.sign(
    { userId, role: 'landlord', email: llEmail, profileId: landlordId, permissions: {} },
    process.env.JWT_SECRET!,
    { expiresIn: '1h' },
  )
  return { landlordId, userId, propertyId, unitId, tenantId, leaseId, tenantEmail, token }
}

beforeEach(async () => {
  await cleanupAllSchema()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_csv_payment_history'
})

describe('GET /api/landlords/me/onboard-payment-history-csv/template', () => {
  it('returns generic template with canonical headers', async () => {
    const { token } = await seedLandlordWithActiveLease()
    const res = await request(buildApp())
      .get('/api/landlords/me/onboard-payment-history-csv/template?source=generic')
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    expect(res.text).toContain('tenant_email')
    expect(res.text).toContain('payment_date')
    expect(res.text).toContain('amount')
  })
})

describe('POST /api/landlords/me/onboard-payment-history-csv/validate', () => {
  it('happy path — resolves email to active lease in landlord portfolio', async () => {
    const { tenantEmail, leaseId, token } = await seedLandlordWithActiveLease()
    const csv = [
      'tenant_email,payment_date,amount,payment_type',
      `${tenantEmail},2025-06-01,1850,rent`,
    ].join('\n')

    const res = await request(buildApp())
      .post('/api/landlords/me/onboard-payment-history-csv/validate')
      .set('Authorization', `Bearer ${token}`)
      .send({ csv, source: 'generic' })

    expect(res.status).toBe(200)
    expect(res.body.data.summary.blockers).toBe(0)
    expect(res.body.data.rows[0].resolvedLeaseId).toBe(leaseId)
  })

  it('blocks when no active lease found for the email', async () => {
    const { token } = await seedLandlordWithActiveLease()
    const csv = [
      'tenant_email,payment_date,amount,payment_type',
      'someone-unknown@x.com,2025-06-01,1850,rent',
    ].join('\n')

    const res = await request(buildApp())
      .post('/api/landlords/me/onboard-payment-history-csv/validate')
      .set('Authorization', `Bearer ${token}`)
      .send({ csv, source: 'generic' })

    expect(res.status).toBe(200)
    const issues = res.body.data.rows[0].issues
      .filter((i: any) => i.field === 'tenant_email' && i.severity === 'block')
    expect(issues.length).toBe(1)
    expect(issues[0].message).toMatch(/No active lease/i)
  })

  it('blocks negative amount (refunds out of scope)', async () => {
    const { tenantEmail, token } = await seedLandlordWithActiveLease()
    const csv = [
      'tenant_email,payment_date,amount,payment_type',
      `${tenantEmail},2025-06-01,-500,rent`,
    ].join('\n')

    const res = await request(buildApp())
      .post('/api/landlords/me/onboard-payment-history-csv/validate')
      .set('Authorization', `Bearer ${token}`)
      .send({ csv, source: 'generic' })

    expect(res.status).toBe(200)
    const issues = res.body.data.rows[0].issues
      .filter((i: any) => i.field === 'amount' && i.severity === 'block')
    expect(issues.length).toBe(1)
  })

  it('blocks zero amount', async () => {
    const { tenantEmail, token } = await seedLandlordWithActiveLease()
    const csv = [
      'tenant_email,payment_date,amount,payment_type',
      `${tenantEmail},2025-06-01,0,rent`,
    ].join('\n')

    const res = await request(buildApp())
      .post('/api/landlords/me/onboard-payment-history-csv/validate')
      .set('Authorization', `Bearer ${token}`)
      .send({ csv, source: 'generic' })

    expect(res.status).toBe(200)
    const issues = res.body.data.rows[0].issues
      .filter((i: any) => i.field === 'amount' && i.severity === 'block')
    expect(issues.length).toBe(1)
  })

  it('blocks invalid date', async () => {
    const { tenantEmail, token } = await seedLandlordWithActiveLease()
    const csv = [
      'tenant_email,payment_date,amount,payment_type',
      `${tenantEmail},not-a-date,1850,rent`,
    ].join('\n')

    const res = await request(buildApp())
      .post('/api/landlords/me/onboard-payment-history-csv/validate')
      .set('Authorization', `Bearer ${token}`)
      .send({ csv, source: 'generic' })

    const issues = res.body.data.rows[0].issues
      .filter((i: any) => i.field === 'payment_date' && i.severity === 'block')
    expect(issues.length).toBe(1)
  })

  it('normalizes payment_type vocabulary ("Rent Payment" → rent, "Late Fee" → late_fee)', async () => {
    const { tenantEmail, token } = await seedLandlordWithActiveLease()
    const csv = [
      'tenant_email,payment_date,amount,payment_type',
      `${tenantEmail},2025-06-01,1850,Rent Payment`,
      `${tenantEmail},2025-06-02,50,Late Fee`,
      `${tenantEmail},2025-06-03,100,Pet Fee`,    // → fee
      `${tenantEmail},2025-06-04,500,Security Deposit`, // → deposit
      `${tenantEmail},2025-06-05,75,water`,        // → utility
    ].join('\n')

    const res = await request(buildApp())
      .post('/api/landlords/me/onboard-payment-history-csv/validate')
      .set('Authorization', `Bearer ${token}`)
      .send({ csv, source: 'generic' })

    expect(res.status).toBe(200)
    expect(res.body.data.summary.blockers).toBe(0)
  })

  it('blocks unknown payment_type strings', async () => {
    const { tenantEmail, token } = await seedLandlordWithActiveLease()
    const csv = [
      'tenant_email,payment_date,amount,payment_type',
      `${tenantEmail},2025-06-01,1850,fizzbuzz`,
    ].join('\n')

    const res = await request(buildApp())
      .post('/api/landlords/me/onboard-payment-history-csv/validate')
      .set('Authorization', `Bearer ${token}`)
      .send({ csv, source: 'generic' })

    const issues = res.body.data.rows[0].issues
      .filter((i: any) => i.field === 'payment_type' && i.severity === 'block')
    expect(issues.length).toBe(1)
  })

  it('translates Buildium "Tenant Email", "Date", "Amount" columns via applyPaymentMapping', async () => {
    const { tenantEmail, token } = await seedLandlordWithActiveLease()
    const csv = [
      'Tenant Email,Date,Amount,Type',
      `${tenantEmail},2025-06-01,1850,Rent Payment`,
    ].join('\n')

    const res = await request(buildApp())
      .post('/api/landlords/me/onboard-payment-history-csv/validate')
      .set('Authorization', `Bearer ${token}`)
      .send({ csv, source: 'buildium' })

    expect(res.status).toBe(200)
    expect(res.body.data.summary.blockers).toBe(0)
    expect(res.body.data.rows[0].tenantEmail).toBe(tenantEmail)
    expect(res.body.data.rows[0].amount).toBe('1850')
  })

  // ── S29X-round-3: tenant_name fallback resolution ──────────────────────

  it('falls back to tenant_name when email is missing (DoorLoop pattern)', async () => {
    const { leaseId, token } = await seedLandlordWithActiveLease({
      tenantFirstName: 'Josh',
      tenantLastName:  'Roby',
    })
    // DoorLoop transactions CSV: no email, Lease column carries name.
    const csv = [
      'Date,Type,Property,Lease,Amount',
      `2026-05-10,Payment,Sunset Apartments,Josh R. Roby,500`,
    ].join('\n')

    const res = await request(buildApp())
      .post('/api/landlords/me/onboard-payment-history-csv/validate')
      .set('Authorization', `Bearer ${token}`)
      .send({ csv, source: 'doorloop' })

    expect(res.status).toBe(200)
    expect(res.body.data.summary.blockers).toBe(0)
    expect(res.body.data.rows[0].resolvedLeaseId).toBe(leaseId)
    expect(res.body.data.rows[0].resolvedVia).toBe('name')
  })

  it('resolves combined-name strings on the first matching tenant ("Kim & Zach")', async () => {
    const { leaseId, token } = await seedLandlordWithActiveLease({
      tenantFirstName: 'Kim',
      tenantLastName:  'Harland',
    })
    // DoorLoop's Lease column bundles co-tenants with " & ".
    const csv = [
      'Date,Lease,Amount',
      `2026-05-10,Kim Harland & Zach Harland,1850`,
    ].join('\n')

    const res = await request(buildApp())
      .post('/api/landlords/me/onboard-payment-history-csv/validate')
      .set('Authorization', `Bearer ${token}`)
      .send({ csv, source: 'doorloop' })

    expect(res.status).toBe(200)
    expect(res.body.data.summary.blockers).toBe(0)
    expect(res.body.data.rows[0].resolvedLeaseId).toBe(leaseId)
    expect(res.body.data.rows[0].resolvedVia).toBe('name')
  })

  it('handles "Last, First" comma-inversion on the name lookup', async () => {
    const { leaseId, token } = await seedLandlordWithActiveLease({
      tenantFirstName: 'John',
      tenantLastName:  'Smith',
    })
    const csv = [
      'tenant_name,payment_date,amount,payment_type',
      `"Smith, John",2025-06-01,1850,rent`,
    ].join('\n')

    const res = await request(buildApp())
      .post('/api/landlords/me/onboard-payment-history-csv/validate')
      .set('Authorization', `Bearer ${token}`)
      .send({ csv, source: 'generic' })

    expect(res.status).toBe(200)
    expect(res.body.data.summary.blockers).toBe(0)
    expect(res.body.data.rows[0].resolvedLeaseId).toBe(leaseId)
  })

  it('blocks when neither tenant_email nor tenant_name is provided', async () => {
    const { token } = await seedLandlordWithActiveLease()
    const csv = [
      'tenant_email,tenant_name,payment_date,amount,payment_type',
      `,,2025-06-01,1850,rent`,
    ].join('\n')

    const res = await request(buildApp())
      .post('/api/landlords/me/onboard-payment-history-csv/validate')
      .set('Authorization', `Bearer ${token}`)
      .send({ csv, source: 'generic' })

    expect(res.status).toBe(200)
    const blockers = res.body.data.rows[0].issues.filter((i: any) => i.severity === 'block')
    expect(blockers.length).toBeGreaterThan(0)
    expect(blockers[0].message).toMatch(/Either tenant_email or tenant_name/)
  })

  it('blocks when tenant_name matches no tenant in the landlord portfolio', async () => {
    const { token } = await seedLandlordWithActiveLease({
      tenantFirstName: 'Real',
      tenantLastName:  'Tenant',
    })
    const csv = [
      'tenant_name,payment_date,amount,payment_type',
      `Unknown Person,2025-06-01,1850,rent`,
    ].join('\n')

    const res = await request(buildApp())
      .post('/api/landlords/me/onboard-payment-history-csv/validate')
      .set('Authorization', `Bearer ${token}`)
      .send({ csv, source: 'generic' })

    expect(res.status).toBe(200)
    const blockers = res.body.data.rows[0].issues.filter((i: any) => i.severity === 'block')
    expect(blockers.length).toBe(1)
    expect(blockers[0].message).toMatch(/No active lease/)
  })

  // ── Square preprocessor ───────────────────────────────────────────────

  it('Square preprocessor filters Event Type != Payment + derives method from Card/Cash columns', async () => {
    const { leaseId, token } = await seedLandlordWithActiveLease({
      tenantFirstName: 'Steve',
      tenantLastName:  'Hess',
    })
    // Mini Square export: 3 rows — one card payment, one cash payment,
    // one refund (should be dropped).
    const csv = [
      'Date,Time,Event Type,Card,Cash,Other Tender,Other Tender Type,Total Collected,Customer Name,Description,Transaction ID',
      '2026-05-10,10:00,Payment,1850,0,0,,1850,Steve Hess,Monthly rent,TX1',
      '2026-05-11,11:00,Payment,0,500,0,,500,Steve Hess,Cash payment,TX2',
      '2026-05-12,12:00,Refund,0,0,0,,-100,Steve Hess,Partial refund,TX3',
    ].join('\n')

    const res = await request(buildApp())
      .post('/api/landlords/me/onboard-payment-history-csv/validate')
      .set('Authorization', `Bearer ${token}`)
      .send({ csv, source: 'square' })

    expect(res.status).toBe(200)
    // Refund row dropped by preprocessor — only 2 rows survive.
    expect(res.body.data.rows.length).toBe(2)
    expect(res.body.data.summary.blockers).toBe(0)
    expect(res.body.data.rows[0].paymentMethod).toBe('card')
    expect(res.body.data.rows[0].resolvedLeaseId).toBe(leaseId)
    expect(res.body.data.rows[1].paymentMethod).toBe('cash')
  })

  it('Square preprocessor derives payment_type from Description (utility detection)', async () => {
    const { token } = await seedLandlordWithActiveLease({
      tenantFirstName: 'Meryl',
      tenantLastName:  'Rhoades',
    })
    const csv = [
      'Date,Event Type,Card,Cash,Other Tender,Other Tender Type,Total Collected,Customer Name,Description,Transaction ID',
      '2026-05-14,Payment,717.95,0,0,,717.95,Meryl Rhoades,Monthly (RV (Monthly)) + 916 kw x Electricity,TX1',
    ].join('\n')

    const res = await request(buildApp())
      .post('/api/landlords/me/onboard-payment-history-csv/validate')
      .set('Authorization', `Bearer ${token}`)
      .send({ csv, source: 'square' })

    expect(res.status).toBe(200)
    // Description contains "Electricity" + "kw" — derived type = utility.
    expect(res.body.data.rows[0].paymentType).toBe('utility')
  })

  it('Square preprocessor maps Other Tender Type=CHECK to method=check', async () => {
    const { token } = await seedLandlordWithActiveLease({
      tenantFirstName: 'Bob',
      tenantLastName:  'Builder',
    })
    const csv = [
      'Date,Event Type,Card,Cash,Other Tender,Other Tender Type,Total Collected,Customer Name,Description,Transaction ID',
      '2026-05-01,Payment,0,0,500,CHECK,500,Bob Builder,Rent,TX1',
    ].join('\n')

    const res = await request(buildApp())
      .post('/api/landlords/me/onboard-payment-history-csv/validate')
      .set('Authorization', `Bearer ${token}`)
      .send({ csv, source: 'square' })

    expect(res.status).toBe(200)
    expect(res.body.data.rows[0].paymentMethod).toBe('check')
  })

  it('Square row with no matching tenant blocks with name-not-found', async () => {
    const { token } = await seedLandlordWithActiveLease({
      tenantFirstName: 'OnlyTenant',
      tenantLastName:  'Here',
    })
    // POS sale to non-tenant guest — should fail name resolution.
    const csv = [
      'Date,Event Type,Card,Cash,Other Tender,Other Tender Type,Total Collected,Customer Name,Description,Transaction ID',
      '2026-05-15,Payment,20,0,0,,20,Walk-In Customer,Dump Station,TX99',
    ].join('\n')

    const res = await request(buildApp())
      .post('/api/landlords/me/onboard-payment-history-csv/validate')
      .set('Authorization', `Bearer ${token}`)
      .send({ csv, source: 'square' })

    expect(res.status).toBe(200)
    const blockers = res.body.data.rows[0].issues.filter((i: any) => i.severity === 'block')
    expect(blockers.length).toBeGreaterThan(0)
  })
})

describe('POST /api/landlords/me/onboard-payment-history-csv/commit', () => {
  it('writes payments rows with status=settled and import_source set', async () => {
    const { landlordId, leaseId, unitId, tenantId, tenantEmail, token } =
      await seedLandlordWithActiveLease()
    // Buildium-shaped column headers so applyPaymentMapping translates
    // them to canonical headers under source='buildium'.
    const csv = [
      'Tenant Email,Date,Amount,Type,Method,Reference',
      `${tenantEmail},2025-06-01,1850,Rent Payment,ACH,June rent`,
      `${tenantEmail},2025-06-15,50,Late Fee,ACH,Late fee`,
    ].join('\n')

    const val = await request(buildApp())
      .post('/api/landlords/me/onboard-payment-history-csv/validate')
      .set('Authorization', `Bearer ${token}`)
      .send({ csv, source: 'buildium' })

    const commit = await request(buildApp())
      .post('/api/landlords/me/onboard-payment-history-csv/commit')
      .set('Authorization', `Bearer ${token}`)
      .send({ rows: val.body.data.rows, source: 'buildium' })

    expect(commit.status).toBe(200)
    expect(commit.body.data.committed).toBe(2)

    const pays = await db.query<any>(
      `SELECT type, amount, status, import_source, settled_at::text AS settled_at_str,
              tenant_id, lease_id, unit_id, notes
         FROM payments WHERE landlord_id = $1
         ORDER BY settled_at`,
      [landlordId],
    )
    expect(pays.rows).toHaveLength(2)
    for (const p of pays.rows) {
      expect(p.status).toBe('settled')
      expect(p.import_source).toBe('buildium')
      expect(p.tenant_id).toBe(tenantId)
      expect(p.lease_id).toBe(leaseId)
      expect(p.unit_id).toBe(unitId)
      expect(p.notes).toMatch(/Imported from buildium/)
    }
    expect(pays.rows[0].type).toBe('rent')
    expect(parseFloat(pays.rows[0].amount)).toBe(1850)
    expect(pays.rows[1].type).toBe('late_fee')
    expect(parseFloat(pays.rows[1].amount)).toBe(50)
  })

  it('payments.imported_at is set to NOW() on commit; settled_at uses payment_date', async () => {
    const { landlordId, tenantEmail, token } = await seedLandlordWithActiveLease()
    const csv = [
      'tenant_email,payment_date,amount,payment_type',
      `${tenantEmail},2024-01-15,1850,rent`,
    ].join('\n')

    const val = await request(buildApp())
      .post('/api/landlords/me/onboard-payment-history-csv/validate')
      .set('Authorization', `Bearer ${token}`)
      .send({ csv, source: 'generic' })

    const commit = await request(buildApp())
      .post('/api/landlords/me/onboard-payment-history-csv/commit')
      .set('Authorization', `Bearer ${token}`)
      .send({ rows: val.body.data.rows, source: 'generic', claimedPlatformName: 'TestPlatform' })
    expect(commit.status).toBe(200)

    const p = await db.query<any>(
      `SELECT settled_at::text AS settled_at_str,
              imported_at::text AS imported_at_str
         FROM payments WHERE landlord_id = $1`,
      [landlordId],
    )
    expect(p.rows[0].settled_at_str).toMatch(/^2024-01-15/)
    const importedAt = new Date(p.rows[0].imported_at_str)
    expect(Date.now() - importedAt.getTime()).toBeLessThan(60_000)
  })

  it('refuses commit when any row carries a blocker', async () => {
    const { tenantEmail, token } = await seedLandlordWithActiveLease()
    const fakeRow = {
      rowIndex: 0,
      tenantEmail, paymentDate: '2025-06-01', amount: '1850',
      paymentType: 'rent', paymentMethod: '', propertyName: '',
      unitNumber: '', reference: '',
      resolvedTenantId: undefined,    // missing — would be set on validate
      resolvedLeaseId:  undefined,
      resolvedUnitId:   undefined,
      issues: [
        { severity: 'block', field: 'tenant_email', message: 'Required' },
      ],
    }
    const res = await request(buildApp())
      .post('/api/landlords/me/onboard-payment-history-csv/commit')
      .set('Authorization', `Bearer ${token}`)
      .send({ rows: [fakeRow], source: 'generic', claimedPlatformName: 'TestPlatform' })
    expect(res.status).toBe(400)
  })

  it('refuses commit when a row references a lease not owned by this landlord', async () => {
    // Seed two landlords with their own active leases; try to write a
    // payment against landlord A using a resolved lease ID from
    // landlord B.
    const a = await seedLandlordWithActiveLease()
    const b = await seedLandlordWithActiveLease()
    const fakeRow = {
      rowIndex: 0,
      tenantEmail: b.tenantEmail, paymentDate: '2025-06-01', amount: '1850',
      paymentType: 'rent', paymentMethod: '', propertyName: '',
      unitNumber: '', reference: '',
      resolvedTenantId: b.tenantId,
      resolvedLeaseId:  b.leaseId,
      resolvedUnitId:   b.unitId,
      issues: [],
    }
    const res = await request(buildApp())
      .post('/api/landlords/me/onboard-payment-history-csv/commit')
      .set('Authorization', `Bearer ${a.token}`)  // landlord A
      .send({ rows: [fakeRow], source: 'generic', claimedPlatformName: 'TestPlatform' })
    expect(res.status).toBe(403)
  })
})
