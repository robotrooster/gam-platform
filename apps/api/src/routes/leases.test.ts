/**
 * Leases route — lease state machine + S201 material-change gate.
 *
 * Surfaces under test:
 *   - GET    /leases                  role-scoped list (landlord / tenant / team / admin)
 *   - GET    /leases/:id              tenant-on-lease vs landlord-scope read
 *   - PATCH  /leases/:id              the load-bearing edit endpoint
 *   - PATCH  /leases/:id/fees/:feeId  override_reason add
 *   - POST   /leases/:id/bill-fee     S180 / A2 admin-billed one-off charge
 *   - GET    /leases/:id/termination-quote
 *   - POST   /leases/:id/terminate-early             (tenant initiates)
 *   - POST   /leases/:id/terminate-early/cancel      (tenant cancels)
 *   - POST   /leases/:id/waive-early-termination     (landlord waives)
 *
 * High-leverage path: S201 material-change gate. Material edits
 * (rent, term, dates, leaseType, autoRenew) on an active/pending_signature
 * lease → 409 material_change_requires_new_lease. Non-material
 * (late-fee, notice days, security deposit) without
 * `confirmAddendum: true` → 409 addendum_confirmation_required.
 * With the confirm flag → applies + emits addendum credit event +
 * generates PDF. Pending leases bypass both gates entirely.
 *
 * Skipped here:
 *   - GET /addendums + /addendum-pdf — needs credit-ledger seed
 *   - Deposit-return endpoints — services/depositReturn has direct tests
 *
 * Mocks: leaseFeesSync, addendumPdf, creditLedger.appendEvent,
 * leaseTermination service.
 */

import { vi, describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { randomUUID } from 'crypto'
import { db } from '../db'
import {
  cleanupAllSchema,
  seedLandlord, seedTenant, seedProperty, seedUnit, seedLease, seedLeaseTenant,
} from '../test/dbHelpers'

const {
  syncSecurityDepositLeaseFeeMock,
  generateAddendumPdfMock,
  appendEventMock,
  quoteFeeMock,
  getActiveOrLatestRequestMock,
  requestEarlyTerminationMock,
  waiveFeeAndTerminateMock,
  cancelRequestMock,
} = vi.hoisted(() => ({
  syncSecurityDepositLeaseFeeMock: vi.fn(async () => {}),
  generateAddendumPdfMock:         vi.fn(async () => ({ filename: 'addendum_test.pdf' })),
  appendEventMock:                 vi.fn(async () => ({ id: 'ev_mock' })),
  quoteFeeMock:                    vi.fn(async () => ({ fee_amount: 1500, fee_basis: 'lease_specific' })),
  getActiveOrLatestRequestMock:    vi.fn(async () => null as any),
  requestEarlyTerminationMock:     vi.fn(async () => ({ status: 'requested', fee_amount: 1500 })),
  waiveFeeAndTerminateMock:        vi.fn(async () => ({ status: 'waived' })),
  cancelRequestMock:               vi.fn(async () => ({ status: 'cancelled' })),
}))
vi.mock('../services/leaseFeesSync', () => ({
  syncSecurityDepositLeaseFee: syncSecurityDepositLeaseFeeMock,
}))
vi.mock('../services/addendumPdf', () => ({
  generateAddendumPdf: generateAddendumPdfMock,
}))
vi.mock('../services/creditLedger', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, appendEvent: appendEventMock }
})
vi.mock('../services/leaseTermination', () => ({
  quoteFee:                quoteFeeMock,
  getActiveOrLatestRequest: getActiveOrLatestRequestMock,
  requestEarlyTermination: requestEarlyTerminationMock,
  waiveFeeAndTerminate:    waiveFeeAndTerminateMock,
  cancelRequest:           cancelRequestMock,
}))

import { leasesRouter } from './leases'
import { errorHandler } from '../middleware/errorHandler'

function buildApp() {
  const app = express()
  app.use(express.json({ limit: '2mb' }))
  app.use('/api/leases', leasesRouter)
  app.use(errorHandler)
  return app
}

beforeEach(async () => {
  await cleanupAllSchema()
  syncSecurityDepositLeaseFeeMock.mockClear()
  generateAddendumPdfMock.mockClear()
  appendEventMock.mockClear()
  quoteFeeMock.mockClear()
  getActiveOrLatestRequestMock.mockClear()
  requestEarlyTerminationMock.mockClear()
  waiveFeeAndTerminateMock.mockClear()
  cancelRequestMock.mockClear()
  getActiveOrLatestRequestMock.mockResolvedValue(null)
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_leases'
})

interface SeedFixture {
  landlordUserId: string
  landlordId:     string
  tenantUserId:   string
  tenantId:       string
  unitId:         string
  propertyId:     string
  leaseId:        string
  landlordToken:  string
  tenantToken:    string
}

async function seedFixture(opts: {
  leaseStatus?: 'pending' | 'pending_signature' | 'active' | 'expired' | 'terminated'
  leaseType?:   'fixed_term' | 'month_to_month'
  endDate?:     string | null
  rentAmount?:  number
} = {}): Promise<SeedFixture> {
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    const { userId: landlordUserId, landlordId } = await seedLandlord(client)
    const tenantId = await seedTenant(client)
    const tu = await client.query<{ user_id: string }>(
      `SELECT user_id FROM tenants WHERE id = $1`, [tenantId],
    )
    const tenantUserId = tu.rows[0].user_id
    const propertyId = await seedProperty(client, { landlordId, ownerUserId: landlordUserId, managedByUserId: landlordUserId })
    const unitId     = await seedUnit(client, { propertyId, landlordId })
    const leaseId    = await seedLease(client, {
      unitId, landlordId,
      leaseType:  opts.leaseType  ?? 'fixed_term',
      status:     opts.leaseStatus as any ?? 'active',
      rentAmount: opts.rentAmount ?? 1500,
    })
    // seedLease defaults end_date to NULL; for fixed_term we need one.
    if ((opts.leaseType ?? 'fixed_term') === 'fixed_term') {
      await client.query(
        `UPDATE leases SET end_date = $1 WHERE id = $2`,
        [opts.endDate ?? '2026-12-31', leaseId],
      )
    }
    await seedLeaseTenant(client, { leaseId, tenantId })
    await client.query('COMMIT')

    const landlordToken = jwt.sign(
      { userId: landlordUserId, role: 'landlord', email: 'll@test.dev', profileId: landlordId, permissions: {} },
      process.env.JWT_SECRET!, { expiresIn: '1h' },
    )
    const tenantToken = jwt.sign(
      { userId: tenantUserId, role: 'tenant', email: 't@test.dev', profileId: tenantId, permissions: {} },
      process.env.JWT_SECRET!, { expiresIn: '1h' },
    )
    return { landlordUserId, landlordId, tenantUserId, tenantId, unitId, propertyId, leaseId, landlordToken, tenantToken }
  } catch (e) { await client.query('ROLLBACK'); throw e }
  finally { client.release() }
}

// ─── GET /leases — list scoping ─────────────────────────────────

describe('GET /leases — list scoping', () => {
  it('landlord sees own leases with tenants attached', async () => {
    const f = await seedFixture()
    const res = await request(buildApp())
      .get('/api/leases')
      .set('Authorization', `Bearer ${f.landlordToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(1)
    expect(res.body.data[0].id).toBe(f.leaseId)
    expect(res.body.data[0].tenants).toHaveLength(1)
    expect(res.body.data[0].tenants[0].tenant_id).toBe(f.tenantId)
  })

  it('tenant sees leases they are on', async () => {
    const f = await seedFixture()
    const res = await request(buildApp())
      .get('/api/leases')
      .set('Authorization', `Bearer ${f.tenantToken}`)
    expect(res.status).toBe(200)
    expect((res.body.data as any[]).map(l => l.id)).toEqual([f.leaseId])
  })

  it('unrelated landlord sees empty list', async () => {
    await seedFixture()
    const otherToken = jwt.sign(
      { userId: randomUUID(), role: 'landlord', email: 'o@test.dev', profileId: randomUUID(), permissions: {} },
      process.env.JWT_SECRET!, { expiresIn: '1h' },
    )
    const res = await request(buildApp())
      .get('/api/leases')
      .set('Authorization', `Bearer ${otherToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data).toEqual([])
  })

  it('unknown role (bookkeeper) gets empty list, not 500', async () => {
    await seedFixture()
    const bkToken = jwt.sign(
      { userId: randomUUID(), role: 'bookkeeper', email: 'bk@test.dev', profileId: randomUUID(), permissions: {} },
      process.env.JWT_SECRET!, { expiresIn: '1h' },
    )
    const res = await request(buildApp())
      .get('/api/leases')
      .set('Authorization', `Bearer ${bkToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data).toEqual([])
  })
})

// ─── GET /leases/:id ───────────────────────────────────────────

describe('GET /leases/:id', () => {
  it('landlord can read own', async () => {
    const f = await seedFixture()
    const res = await request(buildApp())
      .get(`/api/leases/${f.leaseId}`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data.id).toBe(f.leaseId)
    expect(res.body.data.tenants).toHaveLength(1)
  })

  it('tenant on lease can read', async () => {
    const f = await seedFixture()
    const res = await request(buildApp())
      .get(`/api/leases/${f.leaseId}`)
      .set('Authorization', `Bearer ${f.tenantToken}`)
    expect(res.status).toBe(200)
  })

  it('tenant not on lease → 403', async () => {
    const f = await seedFixture()
    const client = await db.connect()
    let otherTenantToken = ''
    try {
      await client.query('BEGIN')
      const otherTenantId = await seedTenant(client, { email: `o-${randomUUID()}@test.dev` })
      const tu = await client.query<{ user_id: string }>(`SELECT user_id FROM tenants WHERE id = $1`, [otherTenantId])
      await client.query('COMMIT')
      otherTenantToken = jwt.sign(
        { userId: tu.rows[0].user_id, role: 'tenant', email: 'o@test.dev', profileId: otherTenantId, permissions: {} },
        process.env.JWT_SECRET!, { expiresIn: '1h' },
      )
    } finally { client.release() }
    const res = await request(buildApp())
      .get(`/api/leases/${f.leaseId}`)
      .set('Authorization', `Bearer ${otherTenantToken}`)
    expect(res.status).toBe(403)
  })

  it('404 for unknown id', async () => {
    const f = await seedFixture()
    const res = await request(buildApp())
      .get(`/api/leases/${randomUUID()}`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
    expect(res.status).toBe(404)
  })
})

// ─── PATCH /leases/:id — S201 material-change gate ─────────────

describe('PATCH /leases/:id — S201 material-change gate', () => {
  it('material change (rent) on active lease → 409 material_change_requires_new_lease', async () => {
    const f = await seedFixture({ leaseStatus: 'active' })
    const res = await request(buildApp())
      .patch(`/api/leases/${f.leaseId}`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ rentAmount: 2000 })
    expect(res.status).toBe(409)
    expect(res.body.error).toBe('material_change_requires_new_lease')
    expect(res.body.changes).toEqual([{ field: 'rent_amount', from: '1500', to: '2000' }])
  })

  it('material change (endDate) on active lease → 409', async () => {
    const f = await seedFixture({ leaseStatus: 'active', endDate: '2026-12-31' })
    const res = await request(buildApp())
      .patch(`/api/leases/${f.leaseId}`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ endDate: '2027-12-31' })
    expect(res.status).toBe(409)
    expect(res.body.error).toBe('material_change_requires_new_lease')
  })

  it('non-material change (lateFeeGraceDays) on active without confirmAddendum → 409 addendum_confirmation_required', async () => {
    const f = await seedFixture({ leaseStatus: 'active' })
    const res = await request(buildApp())
      .patch(`/api/leases/${f.leaseId}`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ lateFeeGraceDays: 7 })
    expect(res.status).toBe(409)
    expect(res.body.error).toBe('addendum_confirmation_required')
    expect(res.body.changes).toEqual([{ field: 'late_fee_grace_days', from: '5', to: '7' }])
    // Nothing applied — no addendum PDF, no event.
    expect(generateAddendumPdfMock).not.toHaveBeenCalled()
    expect(appendEventMock).not.toHaveBeenCalled()
  })

  it('non-material change with confirmAddendum=true → applies + emits credit event + generates PDF', async () => {
    const f = await seedFixture({ leaseStatus: 'active' })
    const res = await request(buildApp())
      .patch(`/api/leases/${f.leaseId}`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ lateFeeGraceDays: 7, confirmAddendum: true })
    expect(res.status).toBe(200)
    expect(generateAddendumPdfMock).toHaveBeenCalledTimes(1)
    expect(appendEventMock).toHaveBeenCalledTimes(1)
    const appendArgs = (appendEventMock.mock.calls[0] as unknown as any[])[0]
    expect(appendArgs.eventType).toBe('lease_addendum_recorded')
    expect(appendArgs.eventData.lease_id).toBe(f.leaseId)
    expect(appendArgs.eventData.pdf_filename).toBe('addendum_test.pdf')
    expect(appendArgs.eventData.changes).toEqual([{ field: 'late_fee_grace_days', from: '5', to: '7' }])
    // Lease actually updated
    const row = await db.query<{ late_fee_grace_days: number }>(
      `SELECT late_fee_grace_days FROM leases WHERE id = $1`, [f.leaseId],
    )
    expect(row.rows[0].late_fee_grace_days).toBe(7)
  })

  it('pending lease bypasses BOTH gates — material change applies freely', async () => {
    const f = await seedFixture({ leaseStatus: 'pending' })
    const res = await request(buildApp())
      .patch(`/api/leases/${f.leaseId}`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ rentAmount: 2000, lateFeeGraceDays: 10 })
    expect(res.status).toBe(200)
    expect(generateAddendumPdfMock).not.toHaveBeenCalled()
    expect(appendEventMock).not.toHaveBeenCalled()
    const row = await db.query<{ rent_amount: string; late_fee_grace_days: number }>(
      `SELECT rent_amount, late_fee_grace_days FROM leases WHERE id = $1`, [f.leaseId],
    )
    expect(Number(row.rows[0].rent_amount)).toBe(2000)
    expect(row.rows[0].late_fee_grace_days).toBe(10)
  })

  it('status-only workflow op (terminate) bypasses gates', async () => {
    const f = await seedFixture({ leaseStatus: 'active' })
    const res = await request(buildApp())
      .patch(`/api/leases/${f.leaseId}`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ status: 'terminated', terminationReason: 'mutual agreement' })
    expect(res.status).toBe(200)
    // Cascade: lease_tenants → removed, units → vacant
    const lt = await db.query<{ status: string; removed_reason: string }>(
      `SELECT status, removed_reason FROM lease_tenants WHERE lease_id = $1`, [f.leaseId],
    )
    expect(lt.rows[0].status).toBe('removed')
    expect(lt.rows[0].removed_reason).toBe('lease_ended')
    const unit = await db.query<{ status: string }>(
      `SELECT status FROM units WHERE id = $1`, [f.unitId],
    )
    expect(unit.rows[0].status).toBe('vacant')
  })

  it('rejects mismatch: month_to_month + end_date → 400', async () => {
    const f = await seedFixture({ leaseStatus: 'pending' })
    const res = await request(buildApp())
      .patch(`/api/leases/${f.leaseId}`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ leaseType: 'month_to_month' })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/month-to-month/i)
  })

  it('rejects mismatch: fixed_term + no end_date → 400', async () => {
    const f = await seedFixture({ leaseStatus: 'pending', leaseType: 'month_to_month', endDate: null })
    const res = await request(buildApp())
      .patch(`/api/leases/${f.leaseId}`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ leaseType: 'fixed_term' })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/require an end date/i)
  })

  it('rejects auto_renew=true with no mode → 400', async () => {
    const f = await seedFixture({ leaseStatus: 'pending' })
    const res = await request(buildApp())
      .patch(`/api/leases/${f.leaseId}`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ autoRenew: true })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/auto_renew_mode/)
  })
})

// ─── PATCH /leases/:id — cross-field validation (S226) ─────────

describe('PATCH /leases/:id — accrual + cap cross-field validation', () => {
  it('accrual triple all-or-none: amount alone rejected (no type/period)', async () => {
    const f = await seedFixture({ leaseStatus: 'pending' })
    const res = await request(buildApp())
      .patch(`/api/leases/${f.leaseId}`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ lateFeeAccrualAmount: 5 })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/accrual requires all of/i)
  })

  it('accrual triple all-or-none: amount+type but missing period rejected', async () => {
    const f = await seedFixture({ leaseStatus: 'pending' })
    const res = await request(buildApp())
      .patch(`/api/leases/${f.leaseId}`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ lateFeeAccrualAmount: 5, lateFeeAccrualType: 'flat' })
    expect(res.status).toBe(400)
  })

  it('accrual all three set → applies', async () => {
    const f = await seedFixture({ leaseStatus: 'pending' })
    const res = await request(buildApp())
      .patch(`/api/leases/${f.leaseId}`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ lateFeeAccrualAmount: 5, lateFeeAccrualType: 'flat', lateFeeAccrualPeriod: 'daily' })
    expect(res.status).toBe(200)
  })

  it('cap pair both-or-neither: amount alone rejected', async () => {
    const f = await seedFixture({ leaseStatus: 'pending' })
    const res = await request(buildApp())
      .patch(`/api/leases/${f.leaseId}`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ lateFeeCapAmount: 50 })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/cap requires/i)
  })

  it('cap both set → applies', async () => {
    const f = await seedFixture({ leaseStatus: 'pending' })
    const res = await request(buildApp())
      .patch(`/api/leases/${f.leaseId}`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ lateFeeCapAmount: 50, lateFeeCapType: 'flat' })
    expect(res.status).toBe(200)
  })
})

// ─── PATCH /leases/:id — auth + zod strictness ─────────────────

describe('PATCH /leases/:id — auth + validation', () => {
  it('cross-landlord rejected', async () => {
    const f = await seedFixture({ leaseStatus: 'pending' })
    const otherToken = jwt.sign(
      { userId: randomUUID(), role: 'landlord', email: 'o@test.dev', profileId: randomUUID(), permissions: {} },
      process.env.JWT_SECRET!, { expiresIn: '1h' },
    )
    const res = await request(buildApp())
      .patch(`/api/leases/${f.leaseId}`)
      .set('Authorization', `Bearer ${otherToken}`)
      .send({ status: 'terminated' })
    expect(res.status).toBe(403)
  })

  it('strict zod rejects unknown fields', async () => {
    const f = await seedFixture({ leaseStatus: 'pending' })
    const res = await request(buildApp())
      .patch(`/api/leases/${f.leaseId}`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ rentAmount: 1500, sneakyField: 'value' })
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(res.status).toBeLessThan(500)
  })

  it('securityDeposit hits leaseFeesSync (S195 dual-write)', async () => {
    const f = await seedFixture({ leaseStatus: 'pending' })
    const res = await request(buildApp())
      .patch(`/api/leases/${f.leaseId}`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ securityDeposit: 1800 })
    expect(res.status).toBe(200)
    expect(syncSecurityDepositLeaseFeeMock).toHaveBeenCalledWith(f.leaseId, 1800)
  })

  // ─────────────────────────────────────────────────────────────
  //  S476: state-law warning surfacing on PATCH response
  // ─────────────────────────────────────────────────────────────

  // schema.sql is schema-only — state_law seed migrations INSERT data
  // (skipped by the snapshot). Seed AZ residential deposit_max_months
  // inline.
  async function seedAzDepositCap(): Promise<void> {
    const { rows: [a] } = await db.query<{ id: string }>(
      `INSERT INTO state_landlord_tenant_acts
         (state_code, act_key, act_name, unit_types, source_date, effective_year)
       VALUES ('AZ', 'residential', 'AZ Residential Landlord-Tenant Act',
               ARRAY['apartment','single_family']::text[], '2026-06-09', 2026)
       ON CONFLICT DO NOTHING
       RETURNING id`)
    const actId = a?.id ?? (await db.query<{ id: string }>(
      `SELECT id FROM state_landlord_tenant_acts WHERE state_code='AZ' AND act_key='residential' AND effective_year=2026 LIMIT 1`)).rows[0].id
    await db.query(
      `INSERT INTO state_law_provisions
         (act_id, state_code, topic, rule_kind, threshold_numeric, threshold_unit,
          summary, statute_citation, source_url, source_date, effective_year)
       VALUES ($1, 'AZ', 'deposit_max_months', 'max', 1.5, 'months of rent',
               'Security deposit may not exceed 1.5 months of rent',
               'A.R.S. § 33-1321', 'https://www.azleg.gov/ars/33/01321.htm',
               '2026-06-09', 2026)
       ON CONFLICT DO NOTHING`, [actId])
  }

  it('S476: AZ deposit 2.0× rent (above 1.5mo cap) → state_law_warnings has flag', async () => {
    const f = await seedFixture({ leaseStatus: 'pending', rentAmount: 1500 })
    await seedAzDepositCap()
    const res = await request(buildApp())
      .patch(`/api/leases/${f.leaseId}`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ securityDeposit: 3000 })  // 2.0 months of 1500 rent
    expect(res.status).toBe(200)
    expect(Array.isArray(res.body.data.state_law_warnings)).toBe(true)
    expect(res.body.data.state_law_warnings.length).toBe(1)
    const flag = res.body.data.state_law_warnings[0]
    expect(flag.topic).toBe('deposit_max_months')
    expect(flag.message).toMatch(/above the 1\.5/)
    expect(flag.message).toMatch(/AZ/)
  })

  it('S476: AZ deposit 1.0× rent (within 1.5mo cap) → state_law_warnings empty', async () => {
    const f = await seedFixture({ leaseStatus: 'pending', rentAmount: 1500 })
    await seedAzDepositCap()
    const res = await request(buildApp())
      .patch(`/api/leases/${f.leaseId}`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ securityDeposit: 1500 })
    expect(res.status).toBe(200)
    expect(res.body.data.state_law_warnings).toEqual([])
  })

  it('S476: PATCH that does NOT touch deposit → no deposit check fires', async () => {
    const f = await seedFixture({ leaseStatus: 'pending', rentAmount: 1500 })
    const res = await request(buildApp())
      .patch(`/api/leases/${f.leaseId}`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ needsReview: true })
    expect(res.status).toBe(200)
    expect(res.body.data.state_law_warnings).toEqual([])
  })

  it('S476: uncatalogued state → state_law_warnings empty', async () => {
    const f = await seedFixture({ leaseStatus: 'pending', rentAmount: 1500 })
    await db.query(`UPDATE properties SET state = 'XX' WHERE id = $1`, [f.propertyId])
    const res = await request(buildApp())
      .patch(`/api/leases/${f.leaseId}`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ securityDeposit: 5000 })  // would flag in catalogued state
    expect(res.status).toBe(200)
    expect(res.body.data.state_law_warnings).toEqual([])
  })

  it('S476: lateFeeInitial percent of 10% > AZ catalog (no late_fee_max_pct on AZ residential) → empty', async () => {
    // AZ does NOT have a late_fee_max_pct provision; checkAgainstStatute
    // returns null when the topic is uncatalogued. Confirms no false
    // alarm on a topic that doesn't have a state figure.
    const f = await seedFixture({ leaseStatus: 'pending', rentAmount: 1500 })
    const res = await request(buildApp())
      .patch(`/api/leases/${f.leaseId}`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ lateFeeInitialAmount: 10, lateFeeInitialType: 'percent_of_rent' })
    expect(res.status).toBe(200)
    expect(res.body.data.state_law_warnings).toEqual([])
  })

  it('S476: lateFeeInitial flat-dollar type (not percent) → no late_fee check fires', async () => {
    const f = await seedFixture({ leaseStatus: 'pending', rentAmount: 1500 })
    const res = await request(buildApp())
      .patch(`/api/leases/${f.leaseId}`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ lateFeeInitialAmount: 75, lateFeeInitialType: 'flat' })
    expect(res.status).toBe(200)
    expect(res.body.data.state_law_warnings).toEqual([])
  })
})

// ─── PATCH /leases/:id/fees/:feeId ─────────────────────────────

describe('PATCH /leases/:id/fees/:feeId', () => {
  it('landlord adds override_reason to a fee', async () => {
    const f = await seedFixture()
    const feeRes = await db.query<{ id: string }>(
      `INSERT INTO lease_fees (lease_id, fee_type, amount, is_refundable, due_timing, is_override)
       VALUES ($1, 'pet_fee', 25, FALSE, 'monthly_ongoing', TRUE) RETURNING id`,
      [f.leaseId],
    )
    const feeId = feeRes.rows[0].id
    const res = await request(buildApp())
      .patch(`/api/leases/${f.leaseId}/fees/${feeId}`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ override_reason: 'Court-ordered cap reduction' })
    expect(res.status).toBe(200)
    expect(res.body.data.override_reason).toBe('Court-ordered cap reduction')
  })

  it('404 when fee not on this lease', async () => {
    const f = await seedFixture()
    const res = await request(buildApp())
      .patch(`/api/leases/${f.leaseId}/fees/${randomUUID()}`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ override_reason: 'X' })
    expect(res.status).toBe(404)
  })
})

// ─── POST /leases/:id/bill-fee ─────────────────────────────────

describe('POST /leases/:id/bill-fee', () => {
  it('landlord can bill an early-termination fee — payments row created', async () => {
    const f = await seedFixture()
    const res = await request(buildApp())
      .post(`/api/leases/${f.leaseId}/bill-fee`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ feeType: 'early_termination_fee', amount: 1500, description: 'Per § 7 of lease' })
    expect(res.status).toBe(201)
    expect(res.body.data.fee_type).toBe('early_termination_fee')
    expect(res.body.data.amount).toBe(1500)
    const row = await db.query<{ status: string; type: string; entry_description: string; amount: string }>(
      `SELECT status, type, entry_description, amount FROM payments WHERE id = $1`,
      [res.body.data.payment_id],
    )
    expect(row.rows[0].status).toBe('pending')
    expect(row.rows[0].type).toBe('fee')
    expect(row.rows[0].entry_description).toBe('SUBSCRIP')
    expect(Number(row.rows[0].amount)).toBe(1500)
  })

  it('defaults dueDate to today when not provided', async () => {
    const f = await seedFixture()
    const today = new Date().toISOString().slice(0, 10)
    const res = await request(buildApp())
      .post(`/api/leases/${f.leaseId}/bill-fee`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ feeType: 'other_fee', amount: 100 })
    expect(res.status).toBe(201)
    expect(res.body.data.due_date).toBe(today)
  })

  it('409 when lease has no active primary tenant', async () => {
    const f = await seedFixture()
    // Remove the primary tenant.
    await db.query(
      `UPDATE lease_tenants SET status = 'removed', removed_reason = 'lease_ended' WHERE lease_id = $1`,
      [f.leaseId],
    )
    const res = await request(buildApp())
      .post(`/api/leases/${f.leaseId}/bill-fee`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ feeType: 'other_fee', amount: 100 })
    expect(res.status).toBe(409)
  })

  it('cross-landlord rejected', async () => {
    const f = await seedFixture()
    const otherToken = jwt.sign(
      { userId: randomUUID(), role: 'landlord', email: 'o@test.dev', profileId: randomUUID(), permissions: {} },
      process.env.JWT_SECRET!, { expiresIn: '1h' },
    )
    const res = await request(buildApp())
      .post(`/api/leases/${f.leaseId}/bill-fee`)
      .set('Authorization', `Bearer ${otherToken}`)
      .send({ feeType: 'other_fee', amount: 100 })
    expect(res.status).toBe(403)
  })

  it('rejects invalid feeType enum', async () => {
    const f = await seedFixture()
    const res = await request(buildApp())
      .post(`/api/leases/${f.leaseId}/bill-fee`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ feeType: 'rent_makeup', amount: 100 })
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(res.status).toBeLessThan(500)
  })
})

// ─── Early termination ────────────────────────────────────────

describe('GET /leases/:id/termination-quote', () => {
  it('tenant on lease can fetch quote', async () => {
    const f = await seedFixture()
    const res = await request(buildApp())
      .get(`/api/leases/${f.leaseId}/termination-quote`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data.fee_amount).toBe(1500)
    expect(quoteFeeMock).toHaveBeenCalledWith(f.leaseId)
  })

  it('cross-landlord rejected', async () => {
    const f = await seedFixture()
    const otherToken = jwt.sign(
      { userId: randomUUID(), role: 'landlord', email: 'o@test.dev', profileId: randomUUID(), permissions: {} },
      process.env.JWT_SECRET!, { expiresIn: '1h' },
    )
    const res = await request(buildApp())
      .get(`/api/leases/${f.leaseId}/termination-quote`)
      .set('Authorization', `Bearer ${otherToken}`)
    expect(res.status).toBe(403)
  })
})

describe('POST /leases/:id/terminate-early', () => {
  it('tenant initiates termination', async () => {
    const f = await seedFixture()
    const res = await request(buildApp())
      .post(`/api/leases/${f.leaseId}/terminate-early`)
      .set('Authorization', `Bearer ${f.tenantToken}`)
      .send({ reason: 'Job relocation' })
    expect(res.status).toBe(200)
    expect(requestEarlyTerminationMock).toHaveBeenCalledTimes(1)
    const args = (requestEarlyTerminationMock.mock.calls[0] as unknown as any[])[0]
    expect(args.leaseId).toBe(f.leaseId)
    expect(args.tenantId).toBe(f.tenantId)
    expect(args.reason).toBe('Job relocation')
  })

  it('landlord cannot initiate (tenant-only)', async () => {
    const f = await seedFixture()
    const res = await request(buildApp())
      .post(`/api/leases/${f.leaseId}/terminate-early`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({})
    expect(res.status).toBe(403)
  })

  it('tenant not on lease rejected', async () => {
    const f = await seedFixture()
    const client = await db.connect()
    let otherToken = ''
    try {
      await client.query('BEGIN')
      const otherTenantId = await seedTenant(client, { email: `o-${randomUUID()}@test.dev` })
      const tu = await client.query<{ user_id: string }>(`SELECT user_id FROM tenants WHERE id = $1`, [otherTenantId])
      await client.query('COMMIT')
      otherToken = jwt.sign(
        { userId: tu.rows[0].user_id, role: 'tenant', email: 'o@test.dev', profileId: otherTenantId, permissions: {} },
        process.env.JWT_SECRET!, { expiresIn: '1h' },
      )
    } finally { client.release() }
    const res = await request(buildApp())
      .post(`/api/leases/${f.leaseId}/terminate-early`)
      .set('Authorization', `Bearer ${otherToken}`)
      .send({})
    expect(res.status).toBe(403)
  })
})

describe('POST /leases/:id/terminate-early/cancel', () => {
  it('tenant cancels their own request', async () => {
    const f = await seedFixture()
    getActiveOrLatestRequestMock.mockResolvedValueOnce({ id: 'req-1', tenant_id: f.tenantId, status: 'requested' } as any)
    const res = await request(buildApp())
      .post(`/api/leases/${f.leaseId}/terminate-early/cancel`)
      .set('Authorization', `Bearer ${f.tenantToken}`)
    expect(res.status).toBe(200)
    expect(cancelRequestMock).toHaveBeenCalledWith('req-1')
  })

  it('404 when no active request', async () => {
    const f = await seedFixture()
    // getActiveOrLatestRequestMock default returns null
    const res = await request(buildApp())
      .post(`/api/leases/${f.leaseId}/terminate-early/cancel`)
      .set('Authorization', `Bearer ${f.tenantToken}`)
    expect(res.status).toBe(404)
  })

  it("tenant cannot cancel another tenant's request", async () => {
    const f = await seedFixture()
    getActiveOrLatestRequestMock.mockResolvedValueOnce({ id: 'req-1', tenant_id: 'someone_else', status: 'requested' } as any)
    const res = await request(buildApp())
      .post(`/api/leases/${f.leaseId}/terminate-early/cancel`)
      .set('Authorization', `Bearer ${f.tenantToken}`)
    expect(res.status).toBe(403)
  })

  it('landlord cannot cancel (tenant-only)', async () => {
    const f = await seedFixture()
    const res = await request(buildApp())
      .post(`/api/leases/${f.leaseId}/terminate-early/cancel`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
    expect(res.status).toBe(403)
  })
})

describe('POST /leases/:id/waive-early-termination', () => {
  it('landlord waives an active request', async () => {
    const f = await seedFixture()
    getActiveOrLatestRequestMock.mockResolvedValueOnce({ id: 'req-1', tenant_id: f.tenantId, status: 'requested' } as any)
    const res = await request(buildApp())
      .post(`/api/leases/${f.leaseId}/waive-early-termination`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ reason: 'Hardship — military deployment' })
    expect(res.status).toBe(200)
    expect(waiveFeeAndTerminateMock).toHaveBeenCalledTimes(1)
    const args = (waiveFeeAndTerminateMock.mock.calls[0] as unknown as any[])[0]
    expect(args.requestId).toBe('req-1')
    expect(args.reason).toBe('Hardship — military deployment')
  })

  it('409 when no waive-able request', async () => {
    const f = await seedFixture()
    // Default null
    const res = await request(buildApp())
      .post(`/api/leases/${f.leaseId}/waive-early-termination`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({})
    expect(res.status).toBe(409)
  })

  it('409 when request is in a non-waive-able status', async () => {
    const f = await seedFixture()
    getActiveOrLatestRequestMock.mockResolvedValueOnce({ id: 'req-1', tenant_id: f.tenantId, status: 'paid' } as any)
    const res = await request(buildApp())
      .post(`/api/leases/${f.leaseId}/waive-early-termination`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({})
    expect(res.status).toBe(409)
  })

  it('cross-landlord rejected', async () => {
    const f = await seedFixture()
    const otherToken = jwt.sign(
      { userId: randomUUID(), role: 'landlord', email: 'o@test.dev', profileId: randomUUID(), permissions: {} },
      process.env.JWT_SECRET!, { expiresIn: '1h' },
    )
    const res = await request(buildApp())
      .post(`/api/leases/${f.leaseId}/waive-early-termination`)
      .set('Authorization', `Bearer ${otherToken}`)
      .send({})
    expect(res.status).toBe(403)
  })
})
