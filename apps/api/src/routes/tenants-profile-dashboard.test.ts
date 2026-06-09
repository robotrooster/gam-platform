/**
 * tenants.ts profile + dashboard slice — S374 (tenants.ts slice
 * 1 of N). Opens the tenants.ts arc.
 *
 * Covered routes (5):
 *   - GET /me — full tenant profile + active-lease + deposit summary
 *   - GET /me/landlord-banking-status — Connect-readiness for paying
 *   - POST /me/nudge-landlord-banking — rate-limited landlord nudge
 *   - GET /me/deposit-interest — statutory rate + accruals
 *   - POST /verify-ach — mock ACH verification + OTP-qualified stamp
 *
 * Out of slice (future sessions):
 *   - FlexCharge / FlexPay / FlexDeposit / FlexSuite re-acceptance
 *   - Portability authorize/decline
 *   - Invite + accept-invite + invite-info
 *   - Admin-facing /:id/profile + /:id/transfer + /:id/available-units
 *   - Profile patch + avatar + password + lease + work-trade +
 *     charge-account
 */

import { vi, describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { randomUUID } from 'crypto'
import { db } from '../db'
import {
  cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedTenant,
  seedLease, seedLeaseTenant, seedSecurityDeposit,
} from '../test/dbHelpers'

const { emailLandlordBankingNudgeMock, getAccrualHistoryMock } = vi.hoisted(() => ({
  emailLandlordBankingNudgeMock: vi.fn(async (..._args: any[]) => 'msg_mock'),
  getAccrualHistoryMock:         vi.fn(async (..._args: any[]) => [] as any[]),
}))
vi.mock('../services/email', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, emailLandlordBankingNudge: emailLandlordBankingNudgeMock }
})
vi.mock('../services/depositInterest', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, getAccrualHistory: getAccrualHistoryMock }
})

import { tenantsRouter } from './tenants'
import { errorHandler } from '../middleware/errorHandler'

function buildApp() {
  const app = express()
  app.use(express.json({ limit: '2mb' }))
  app.use('/api/tenants', tenantsRouter)
  app.use(errorHandler)
  return app
}

beforeEach(async () => {
  await cleanupAllSchema()
  emailLandlordBankingNudgeMock.mockClear()
  getAccrualHistoryMock.mockClear()
  getAccrualHistoryMock.mockResolvedValue([])
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_tenants_profile'
})

interface TFixture {
  landlordUserId: string
  landlordId:     string
  propertyId:     string
  unitId:         string
  tenantId:       string
  tenantUserId:   string
  tenantToken:    string
  leaseId?:       string
}

async function seedTFixture(opts: {
  withActiveLease?: boolean;
  landlordConnectReady?: boolean;
  propertyState?: string;
} = {}): Promise<TFixture> {
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    const { userId: landlordUserId, landlordId } = await seedLandlord(client)
    const propertyId = await seedProperty(client, {
      landlordId, ownerUserId: landlordUserId, managedByUserId: landlordUserId,
      state: opts.propertyState,
    })
    await client.query(`UPDATE properties SET name='Sunset Apts' WHERE id=$1`, [propertyId])
    const unitId = await seedUnit(client, { propertyId, landlordId })
    const tenantId = await seedTenant(client)
    const tu = await client.query<{ user_id: string }>(
      `SELECT user_id FROM tenants WHERE id=$1`, [tenantId])
    const tenantUserId = tu.rows[0].user_id

    if (opts.landlordConnectReady) {
      await client.query(
        `UPDATE users SET connect_payouts_enabled=TRUE, connect_details_submitted=TRUE WHERE id=$1`,
        [landlordUserId])
    }

    let leaseId: string | undefined
    if (opts.withActiveLease !== false) {
      leaseId = await seedLease(client, { unitId, landlordId, rentAmount: 1500 })
      await seedLeaseTenant(client, { leaseId, tenantId, role: 'primary' })
    }

    await client.query('COMMIT')
    const tenantToken = jwt.sign(
      { userId: tenantUserId, role: 'tenant', email: 't@test.dev',
        profileId: tenantId, permissions: {} },
      process.env.JWT_SECRET!, { expiresIn: '1h' },
    )
    return { landlordUserId, landlordId, propertyId, unitId, tenantId,
             tenantUserId, tenantToken, leaseId }
  } catch (e) { await client.query('ROLLBACK'); throw e }
  finally { client.release() }
}

describe('GET /api/tenants/me/landlord-banking-status', () => {
  it('tenant with no active lease → ready:false (degenerate state, same blocked UI)', async () => {
    const f = await seedTFixture({ withActiveLease: false })
    const res = await request(buildApp())
      .get('/api/tenants/me/landlord-banking-status')
      .set('Authorization', `Bearer ${f.tenantToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data.ready).toBe(false)
  })

  it('tenant with active lease + landlord Connect ready → ready:true', async () => {
    const f = await seedTFixture({ landlordConnectReady: true })
    const res = await request(buildApp())
      .get('/api/tenants/me/landlord-banking-status')
      .set('Authorization', `Bearer ${f.tenantToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data.ready).toBe(true)
  })
})

describe('POST /api/tenants/me/nudge-landlord-banking', () => {
  it('happy: fires email nudge with landlord/tenant/property context', async () => {
    const f = await seedTFixture()
    const res = await request(buildApp())
      .post('/api/tenants/me/nudge-landlord-banking')
      .set('Authorization', `Bearer ${f.tenantToken}`).send({})
    expect(res.status).toBe(200)
    expect(emailLandlordBankingNudgeMock).toHaveBeenCalledTimes(1)
    const args = emailLandlordBankingNudgeMock.mock.calls[0]![0]
    expect(args.propertyName).toBe('Sunset Apts')
    expect(args.ctx).toMatchObject({ landlordId: f.landlordId, tenantId: f.tenantId })
  })

  it('recent nudge in last 24h → 429 rate limit', async () => {
    const f = await seedTFixture()
    // Seed a recent nudge entry in email_send_log
    await db.query(
      `INSERT INTO email_send_log (to_email, subject, category, status,
                                   related_entity_type, related_entity_id, created_at)
       VALUES ('ll@x.dev', 'nudge', 'landlord_banking_nudge', 'sent',
               'tenant_landlord_nudge', $1, NOW() - INTERVAL '1 hour')`,
      [f.tenantId])

    const res = await request(buildApp())
      .post('/api/tenants/me/nudge-landlord-banking')
      .set('Authorization', `Bearer ${f.tenantToken}`).send({})
    expect(res.status).toBe(429)
    expect(res.body.error).toMatch(/another nudge in 24 hours/)
    expect(emailLandlordBankingNudgeMock).not.toHaveBeenCalled()
  })

  it('landlord banking already complete → 409 "no nudge needed"', async () => {
    const f = await seedTFixture({ landlordConnectReady: true })
    const res = await request(buildApp())
      .post('/api/tenants/me/nudge-landlord-banking')
      .set('Authorization', `Bearer ${f.tenantToken}`).send({})
    expect(res.status).toBe(409)
    expect(res.body.error).toMatch(/already complete/)
    expect(emailLandlordBankingNudgeMock).not.toHaveBeenCalled()
  })
})

describe('GET /api/tenants/me', () => {
  it('happy: full shape with property + unit + deposit summary', async () => {
    const f = await seedTFixture()
    const client = await db.connect()
    try {
      await seedSecurityDeposit(client, {
        unitId: f.unitId, leaseId: f.leaseId!, tenantId: f.tenantId,
        totalAmount: 1500, collectedAmount: 1500,
      })
    } finally { client.release() }

    const res = await request(buildApp())
      .get('/api/tenants/me')
      .set('Authorization', `Bearer ${f.tenantToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data.id).toBe(f.tenantId)
    expect(res.body.data.property_name).toBe('Sunset Apts')
    expect(res.body.data.unit_id).toBe(f.unitId)
    expect(Number(res.body.data.deposit_total)).toBe(1500)
    expect(res.body.data.deposit_fully_funded).toBe(true)
  })
})

describe('GET /api/tenants/me/deposit-interest', () => {
  it('no deposit → deposit:null, rate:null, accruals:[]', async () => {
    const f = await seedTFixture()
    const res = await request(buildApp())
      .get('/api/tenants/me/deposit-interest')
      .set('Authorization', `Bearer ${f.tenantToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data).toEqual({ deposit: null, rate: null, accruals: [] })
    expect(getAccrualHistoryMock).not.toHaveBeenCalled()
  })

  it('statutory state (MA 2026) → rate.source=statutory; accruals from service', async () => {
    const f = await seedTFixture({ propertyState: 'MA' })
    const client = await db.connect()
    try {
      await seedSecurityDeposit(client, {
        unitId: f.unitId, leaseId: f.leaseId!, tenantId: f.tenantId,
        totalAmount: 1500, collectedAmount: 1500,
      })
    } finally { client.release() }
    // Seed the statutory MA rate for this year (test DB is schema-only)
    const currentYear = new Date().getUTCFullYear()
    await db.query(
      `INSERT INTO state_deposit_interest_rates
         (state_code, effective_year, annual_rate_pct, statute_citation)
       VALUES ('MA', $1, 5.0000, 'Mass. Gen. Laws Ch. 186 § 15B(2)(a)')
       ON CONFLICT DO NOTHING`,
      [currentYear])
    getAccrualHistoryMock.mockResolvedValueOnce([
      { month: '2026-01', amount: '6.25' },
      { month: '2026-02', amount: '6.25' },
    ] as any)

    const res = await request(buildApp())
      .get('/api/tenants/me/deposit-interest')
      .set('Authorization', `Bearer ${f.tenantToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data.deposit.state).toBe('MA')
    expect(res.body.data.rate.source).toBe('statutory')
    expect(res.body.data.rate.state_code).toBe('MA')
    expect(Number(res.body.data.rate.annual_rate_pct)).toBe(5)
    expect(res.body.data.accruals.length).toBe(2)
  })

  it('non-statutory state with landlord override → rate.source=landlord_override', async () => {
    const f = await seedTFixture({ propertyState: 'AK' })
    const client = await db.connect()
    try {
      await seedSecurityDeposit(client, {
        unitId: f.unitId, leaseId: f.leaseId!, tenantId: f.tenantId,
        totalAmount: 1500, collectedAmount: 1500,
      })
    } finally { client.release() }
    const currentYear = new Date().getUTCFullYear()
    // No statutory rate for AK; seed a landlord override
    await db.query(
      `INSERT INTO landlord_deposit_interest_rate_overrides
         (landlord_id, state_code, effective_year, annual_rate_pct, source_notes)
       VALUES ($1, 'AK', $2, 0.5, 'bank passbook')`,
      [f.landlordId, currentYear])

    const res = await request(buildApp())
      .get('/api/tenants/me/deposit-interest')
      .set('Authorization', `Bearer ${f.tenantToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data.rate.source).toBe('landlord_override')
    expect(res.body.data.rate.state_code).toBe('AK')
    expect(Number(res.body.data.rate.annual_rate_pct)).toBe(0.5)
    expect(res.body.data.rate.statute_citation).toBeNull()
  })
})

describe('POST /api/tenants/verify-ach', () => {
  it('invalid last4 (not 4 chars) → 400', async () => {
    const f = await seedTFixture()
    const res = await request(buildApp())
      .post('/api/tenants/verify-ach')
      .set('Authorization', `Bearer ${f.tenantToken}`)
      .send({ bankName: 'Chase', last4: '123' })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/Valid bank last 4/)
  })

  it('S374 F1 regression pin: deposit fully funded → ach_verified=true + qualified message', async () => {
    // Pre-S374 this path 500\'d with "column otp_qualified_at does
    // not exist." Post-fix: ach_verified flips, deposit_fully_funded
    // reflects state, message reflects qualification. OTP qualification
    // is now a dynamic check via services/otp.getQualificationStatus
    // (per S365), not a persisted timestamp on tenants.
    const f = await seedTFixture()
    const client = await db.connect()
    try {
      await seedSecurityDeposit(client, {
        unitId: f.unitId, leaseId: f.leaseId!, tenantId: f.tenantId,
        totalAmount: 1500, collectedAmount: 1500,
      })
    } finally { client.release() }

    const res = await request(buildApp())
      .post('/api/tenants/verify-ach')
      .set('Authorization', `Bearer ${f.tenantToken}`)
      .send({ bankName: 'Chase', last4: '4321' })
    expect(res.status).toBe(200)
    expect(res.body.data.ach_verified).toBe(true)
    expect(res.body.data.deposit_fully_funded).toBe(true)
    expect(res.body.data.message).toMatch(/OTP qualified/)

    const row = await db.query<{ ach_verified: boolean; bank_last4: string }>(
      `SELECT ach_verified, bank_last4 FROM tenants WHERE id=$1`, [f.tenantId])
    expect(row.rows[0].ach_verified).toBe(true)
    expect(row.rows[0].bank_last4).toBe('4321')
  })

  it('deposit NOT fully funded → ach_verified=true + activation-pending message', async () => {
    const f = await seedTFixture()
    const client = await db.connect()
    try {
      await seedSecurityDeposit(client, {
        unitId: f.unitId, leaseId: f.leaseId!, tenantId: f.tenantId,
        totalAmount: 1500, collectedAmount: 500,  // partial
      })
    } finally { client.release() }

    const res = await request(buildApp())
      .post('/api/tenants/verify-ach')
      .set('Authorization', `Bearer ${f.tenantToken}`)
      .send({ bankName: 'Chase', last4: '4321' })
    expect(res.status).toBe(200)
    expect(res.body.data.ach_verified).toBe(true)
    expect(res.body.data.deposit_fully_funded).toBe(false)
    expect(res.body.data.message).toMatch(/OTP will activate once your deposit is fully funded/)
  })
})
