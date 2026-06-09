/**
 * tenants.ts Flex slice — S375 (tenants.ts slice 2 of N).
 *
 * Covers all tenant-side Flex product routes (13):
 *   - FlexCharge: GET + dispute (2)
 *   - FlexPay: GET + enroll + terms + DELETE (4)
 *   - FlexSuite re-acceptance: status + preview + accept (3)
 *   - FlexDeposit: GET + enroll + terms + retry + DELETE (5)
 *   - Deposit portability: eligibility + authorize + decline (3)
 *
 * All routes delegate to services (flexCharge, flexpay, flexDeposit,
 * flexsuiteAcceptance, depositPortability). Services mocked; the
 * slice tests route contracts (validation, gating, pass-through).
 *
 * Out of slice (next tenants.ts session): OTP/credit enrollment,
 * payments history, invite + accept-invite + invite-info, admin-
 * facing /:id/profile + /:id/transfer + /:id/available-units,
 * profile patch + avatar + password, lease views, work-trade,
 * charge-account.
 */

import { vi, describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { randomUUID } from 'crypto'
import { db } from '../db'
import {
  cleanupAllSchema, seedTenant, seedLandlord, seedProperty, seedUnit,
  seedLease, seedLeaseTenant, seedSecurityDeposit,
} from '../test/dbHelpers'

const {
  isFlexChargeVisibleMock, getFlexChargeAccountsForTenantMock, disputeFlexChargeTransactionMock,
  isFlexPayVisibleMock, getFlexPayEligibilityMock, calculateFlexPayFeeMock,
  enrollFlexPayMock, cancelFlexPayMock,
  isFlexDepositVisibleMock, getFlexDepositEligibilityMock,
  enrollFlexDepositMock, retryFlexDepositAccelerationMock, cancelFlexDepositMock,
  previewFlexDepositScheduleMock,
  getPendingReAcceptancesMock, renderReAcceptanceTermsMock, commitReAcceptanceMock,
  renderFlexPayAcceptanceTextMock, renderFlexDepositAcceptanceTextMock,
  detectPortabilityEligibleMock, authorizeDepositPortabilityMock, declineDepositPortabilityMock,
} = vi.hoisted(() => ({
  isFlexChargeVisibleMock:           vi.fn(async () => true),
  getFlexChargeAccountsForTenantMock: vi.fn(async (..._a: any[]) => [] as any[]),
  disputeFlexChargeTransactionMock:  vi.fn(async (..._a: any[]) => ({ ok: true, status: 'disputed' })),
  isFlexPayVisibleMock:              vi.fn(async () => true),
  getFlexPayEligibilityMock:         vi.fn(async (..._a: any[]) => ({ eligible: true, reasons: [] })),
  calculateFlexPayFeeMock:           vi.fn((day: number) => 5 + day),
  enrollFlexPayMock:                 vi.fn<any[], Promise<{ ok: boolean; fee?: number; acceptanceId?: string; reason?: string }>>(
    async () => ({ ok: true, fee: 20, acceptanceId: 'acc_mock' })),
  cancelFlexPayMock:                 vi.fn(async (..._a: any[]) => undefined),
  isFlexDepositVisibleMock:          vi.fn(async () => true),
  getFlexDepositEligibilityMock:     vi.fn(async (..._a: any[]) => ({ eligible: true })),
  enrollFlexDepositMock:             vi.fn<any[], Promise<{ ok: boolean; plan?: any; acceptanceId?: string; reason?: string }>>(
    async () => ({ ok: true, plan: { installmentCount: 3 }, acceptanceId: 'acc_dep' })),
  retryFlexDepositAccelerationMock:  vi.fn<any[], Promise<{ ok: boolean; reason?: string }>>(
    async () => ({ ok: true })),
  cancelFlexDepositMock:             vi.fn<any[], Promise<{ ok: boolean; reason?: string }>>(
    async () => ({ ok: true })),
  previewFlexDepositScheduleMock:    vi.fn<any[], Promise<any>>(
    async () => ({ ok: true, depositId: 'dep_mock',
      schedule: { installments: [], gamAdvanceAmount: 1000, totalInstallmentAmount: 1500, startDate: '2026-06-01' } })),
  getPendingReAcceptancesMock:       vi.fn(async (..._a: any[]) => [] as any[]),
  renderReAcceptanceTermsMock:       vi.fn(async (..._a: any[]) => ({ renderedText: 'terms text' })),
  commitReAcceptanceMock:            vi.fn(async (..._a: any[]) => 'acc_reaccept'),
  renderFlexPayAcceptanceTextMock:   vi.fn(async (..._a: any[]) => ({ renderedText: 'flexpay terms' })),
  renderFlexDepositAcceptanceTextMock: vi.fn(async (..._a: any[]) => ({ renderedText: 'deposit terms' })),
  detectPortabilityEligibleMock:     vi.fn(async (..._a: any[]) => ({ eligible: false, reason: 'no_lease' })),
  authorizeDepositPortabilityMock:   vi.fn(async (..._a: any[]) => ({ ok: true })),
  declineDepositPortabilityMock:     vi.fn(async (..._a: any[]) => undefined),
}))
vi.mock('../services/flexCharge', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    isFlexChargeVisible:            isFlexChargeVisibleMock,
    getFlexChargeAccountsForTenant: getFlexChargeAccountsForTenantMock,
    disputeFlexChargeTransaction:   disputeFlexChargeTransactionMock,
  }
})
vi.mock('../services/flexpay', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    isFlexPayVisible:      isFlexPayVisibleMock,
    getFlexPayEligibility: getFlexPayEligibilityMock,
    calculateFlexPayFee:   calculateFlexPayFeeMock,
    enrollFlexPay:         enrollFlexPayMock,
    cancelFlexPay:         cancelFlexPayMock,
  }
})
vi.mock('../services/flexDeposit', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    isFlexDepositVisible:         isFlexDepositVisibleMock,
    getFlexDepositEligibility:    getFlexDepositEligibilityMock,
    enrollFlexDeposit:            enrollFlexDepositMock,
    retryFlexDepositAcceleration: retryFlexDepositAccelerationMock,
    cancelFlexDeposit:            cancelFlexDepositMock,
    previewFlexDepositSchedule:   previewFlexDepositScheduleMock,
  }
})
vi.mock('../services/flexsuiteAcceptance', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    getPendingReAcceptances:      getPendingReAcceptancesMock,
    renderReAcceptanceTerms:      renderReAcceptanceTermsMock,
    commitReAcceptance:           commitReAcceptanceMock,
    renderFlexPayAcceptanceText:  renderFlexPayAcceptanceTextMock,
    renderFlexDepositAcceptanceText: renderFlexDepositAcceptanceTextMock,
    FLEXPAY_TEMPLATE_VERSION:     'v1.0',
    FLEXDEPOSIT_TEMPLATE_VERSION: 'v1.0',
  }
})
vi.mock('../services/depositPortability', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    detectPortabilityEligible:    detectPortabilityEligibleMock,
    authorizeDepositPortability:  authorizeDepositPortabilityMock,
    declineDepositPortability:    declineDepositPortabilityMock,
  }
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
  // Clear + arm default mocks
  isFlexChargeVisibleMock.mockClear(); isFlexChargeVisibleMock.mockResolvedValue(true)
  getFlexChargeAccountsForTenantMock.mockClear(); getFlexChargeAccountsForTenantMock.mockResolvedValue([])
  disputeFlexChargeTransactionMock.mockClear(); disputeFlexChargeTransactionMock.mockResolvedValue({ ok: true, status: 'disputed' } as any)
  isFlexPayVisibleMock.mockClear(); isFlexPayVisibleMock.mockResolvedValue(true)
  getFlexPayEligibilityMock.mockClear(); getFlexPayEligibilityMock.mockResolvedValue({ eligible: true, reasons: [] } as any)
  calculateFlexPayFeeMock.mockClear(); calculateFlexPayFeeMock.mockImplementation((day: number) => 5 + day)
  enrollFlexPayMock.mockClear(); enrollFlexPayMock.mockResolvedValue({ ok: true, fee: 20, acceptanceId: 'acc_mock' })
  cancelFlexPayMock.mockClear(); cancelFlexPayMock.mockResolvedValue(undefined as any)
  isFlexDepositVisibleMock.mockClear(); isFlexDepositVisibleMock.mockResolvedValue(true)
  getFlexDepositEligibilityMock.mockClear(); getFlexDepositEligibilityMock.mockResolvedValue({ eligible: true } as any)
  enrollFlexDepositMock.mockClear(); enrollFlexDepositMock.mockResolvedValue({ ok: true, plan: { installmentCount: 3 }, acceptanceId: 'acc_dep' })
  retryFlexDepositAccelerationMock.mockClear(); retryFlexDepositAccelerationMock.mockResolvedValue({ ok: true })
  cancelFlexDepositMock.mockClear(); cancelFlexDepositMock.mockResolvedValue({ ok: true })
  previewFlexDepositScheduleMock.mockClear()
  previewFlexDepositScheduleMock.mockResolvedValue({ ok: true, depositId: 'dep_mock',
    schedule: { installments: [], gamAdvanceAmount: 1000, totalInstallmentAmount: 1500, startDate: '2026-06-01' } } as any)
  getPendingReAcceptancesMock.mockClear(); getPendingReAcceptancesMock.mockResolvedValue([])
  renderReAcceptanceTermsMock.mockClear(); renderReAcceptanceTermsMock.mockResolvedValue({ renderedText: 'terms text' } as any)
  commitReAcceptanceMock.mockClear(); commitReAcceptanceMock.mockResolvedValue('acc_reaccept' as any)
  renderFlexPayAcceptanceTextMock.mockClear(); renderFlexPayAcceptanceTextMock.mockResolvedValue({ renderedText: 'flexpay terms' } as any)
  renderFlexDepositAcceptanceTextMock.mockClear(); renderFlexDepositAcceptanceTextMock.mockResolvedValue({ renderedText: 'deposit terms' } as any)
  detectPortabilityEligibleMock.mockClear(); detectPortabilityEligibleMock.mockResolvedValue({ eligible: false, reason: 'no_lease' } as any)
  authorizeDepositPortabilityMock.mockClear(); authorizeDepositPortabilityMock.mockResolvedValue({ ok: true } as any)
  declineDepositPortabilityMock.mockClear(); declineDepositPortabilityMock.mockResolvedValue(undefined as any)
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_tenants_flex'
})

async function seedTenantFixture(): Promise<{ tenantId: string; tenantUserId: string; token: string }> {
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    const tenantId = await seedTenant(client)
    const tu = await client.query<{ user_id: string }>(
      `SELECT user_id FROM tenants WHERE id=$1`, [tenantId])
    await client.query('COMMIT')
    const token = jwt.sign(
      { userId: tu.rows[0].user_id, role: 'tenant', email: 't@test.dev',
        profileId: tenantId, permissions: {} },
      process.env.JWT_SECRET!, { expiresIn: '1h' },
    )
    return { tenantId, tenantUserId: tu.rows[0].user_id, token }
  } catch (e) { await client.query('ROLLBACK'); throw e }
  finally { client.release() }
}

describe('FlexCharge — GET + dispute', () => {
  it('GET /flexcharge visible=false → {visible:false}; service NOT called', async () => {
    const f = await seedTenantFixture()
    isFlexChargeVisibleMock.mockResolvedValueOnce(false)
    const res = await request(buildApp())
      .get('/api/tenants/flexcharge')
      .set('Authorization', `Bearer ${f.token}`)
    expect(res.status).toBe(200)
    expect(res.body.data).toEqual({ visible: false })
    expect(getFlexChargeAccountsForTenantMock).not.toHaveBeenCalled()
  })

  it('POST /flexcharge/dispute/:txId missing reason → 400; happy passes args', async () => {
    const f = await seedTenantFixture()
    const txId = randomUUID()

    const r1 = await request(buildApp())
      .post(`/api/tenants/flexcharge/dispute/${txId}`)
      .set('Authorization', `Bearer ${f.token}`)
      .send({ reason: 'no' })
    expect(r1.status).toBe(400)
    expect(r1.body.error).toMatch(/min 3 chars/)
    expect(disputeFlexChargeTransactionMock).not.toHaveBeenCalled()

    const r2 = await request(buildApp())
      .post(`/api/tenants/flexcharge/dispute/${txId}`)
      .set('Authorization', `Bearer ${f.token}`)
      .send({ reason: 'unauthorized charge — disputed at POS' })
    expect(r2.status).toBe(200)
    expect(disputeFlexChargeTransactionMock).toHaveBeenCalledWith({
      transactionId: txId,
      disputerTenantId: f.tenantId,
      reason: 'unauthorized charge — disputed at POS',
    })
  })
})

describe('FlexPay — GET + enroll + terms + DELETE', () => {
  it('GET /flexpay visible=false → {visible:false}', async () => {
    const f = await seedTenantFixture()
    isFlexPayVisibleMock.mockResolvedValueOnce(false)
    const res = await request(buildApp())
      .get('/api/tenants/flexpay')
      .set('Authorization', `Bearer ${f.token}`)
    expect(res.status).toBe(200)
    expect(res.body.data).toEqual({ visible: false })
  })

  it('GET /flexpay happy: returns enrollment row + eligibility + previewFee when pullDay set', async () => {
    const f = await seedTenantFixture()
    await db.query(
      `UPDATE tenants SET flexpay_enrolled=TRUE, flexpay_pull_day=15,
                          flexpay_monthly_fee=20.00, flexpay_enrolled_at=NOW()
        WHERE id=$1`, [f.tenantId])
    const res = await request(buildApp())
      .get('/api/tenants/flexpay')
      .set('Authorization', `Bearer ${f.token}`)
    expect(res.status).toBe(200)
    expect(res.body.data.visible).toBe(true)
    expect(res.body.data.flexpay_enrolled).toBe(true)
    expect(res.body.data.flexpay_pull_day).toBe(15)
    expect(res.body.data.previewFee).toBe(20)  // calculateFlexPayFee(15) = 5+15
    expect(res.body.data.eligibility).toMatchObject({ eligible: true })
  })

  it('POST /flexpay/enroll service ok:false → 400 with reason; happy returns acceptanceId', async () => {
    const f = await seedTenantFixture()
    enrollFlexPayMock.mockResolvedValueOnce({ ok: false, reason: 'no active lease' })
    const fail = await request(buildApp())
      .post('/api/tenants/flexpay/enroll')
      .set('Authorization', `Bearer ${f.token}`)
      .send({ pullDay: 10, acceptedTerms: true })
    expect(fail.status).toBe(400)
    expect(fail.body.error).toBe('no active lease')

    const ok = await request(buildApp())
      .post('/api/tenants/flexpay/enroll')
      .set('Authorization', `Bearer ${f.token}`)
      .send({ pullDay: 10, acceptedTerms: true })
    expect(ok.status).toBe(200)
    expect(ok.body.data).toMatchObject({ pullDay: 10, fee: 20, acceptanceId: 'acc_mock' })
    expect(enrollFlexPayMock.mock.calls[1]![0]).toMatchObject({
      tenantId: f.tenantId, userId: f.tenantUserId, pullDay: 10, acceptedTerms: true,
    })
  })

  it('GET /flexpay/terms pullDay out of range → 400; happy returns rendered text', async () => {
    const f = await seedTenantFixture()
    const bad = await request(buildApp())
      .get('/api/tenants/flexpay/terms?pullDay=29')
      .set('Authorization', `Bearer ${f.token}`)
    expect(bad.status).toBe(400)
    expect(bad.body.error).toMatch(/pullDay must be an integer 1\.\.28/)

    const ok = await request(buildApp())
      .get('/api/tenants/flexpay/terms?pullDay=15')
      .set('Authorization', `Bearer ${f.token}`)
    expect(ok.status).toBe(200)
    expect(ok.body.data).toMatchObject({
      version: 'v1.0', pullDay: 15, fee: 20, renderedText: 'flexpay terms',
    })
  })

  it('DELETE /flexpay calls cancelFlexPay with tenantId', async () => {
    const f = await seedTenantFixture()
    const res = await request(buildApp())
      .delete('/api/tenants/flexpay')
      .set('Authorization', `Bearer ${f.token}`)
    expect(res.status).toBe(200)
    expect(cancelFlexPayMock).toHaveBeenCalledWith(f.tenantId)
  })
})

describe('FlexSuite re-acceptance — status + preview + accept', () => {
  it('GET /re-acceptance-status returns pending array from service', async () => {
    const f = await seedTenantFixture()
    getPendingReAcceptancesMock.mockResolvedValueOnce(['flexpay', 'flexdeposit'])
    const res = await request(buildApp())
      .get('/api/tenants/flexsuite/re-acceptance-status')
      .set('Authorization', `Bearer ${f.token}`)
    expect(res.status).toBe(200)
    expect(res.body.data.pending).toEqual(['flexpay', 'flexdeposit'])
  })

  it('POST /re-accept invalid product → 400; missing acceptedTerms → 400; happy returns acceptanceId', async () => {
    const f = await seedTenantFixture()
    const r1 = await request(buildApp())
      .post('/api/tenants/flexsuite/re-accept')
      .set('Authorization', `Bearer ${f.token}`)
      .send({ product: 'flexcredit', acceptedTerms: true })
    expect(r1.status).toBe(400)
    expect(r1.body.error).toMatch(/product must be flexpay or flexdeposit/)

    const r2 = await request(buildApp())
      .post('/api/tenants/flexsuite/re-accept')
      .set('Authorization', `Bearer ${f.token}`)
      .send({ product: 'flexpay' })  // missing acceptedTerms
    expect(r2.status).toBe(400)
    expect(r2.body.error).toMatch(/acceptedTerms must be true/)

    const ok = await request(buildApp())
      .post('/api/tenants/flexsuite/re-accept')
      .set('Authorization', `Bearer ${f.token}`)
      .send({ product: 'flexpay', acceptedTerms: true })
    expect(ok.status).toBe(200)
    expect(ok.body.data).toEqual({ acceptanceId: 'acc_reaccept', product: 'flexpay' })
  })
})

describe('FlexDeposit — GET + enroll + terms + retry + DELETE', () => {
  it('GET /flexdeposit visible=false → {visible:false}', async () => {
    const f = await seedTenantFixture()
    isFlexDepositVisibleMock.mockResolvedValueOnce(false)
    const res = await request(buildApp())
      .get('/api/tenants/flexdeposit')
      .set('Authorization', `Bearer ${f.token}`)
    expect(res.status).toBe(200)
    expect(res.body.data).toEqual({ visible: false })
  })

  it('GET /flexdeposit happy: returns eligibility + plan rows + deposit context', async () => {
    const f = await seedTenantFixture()
    // Seed proper landlord/property/unit/lease chain for FK satisfaction
    const client = await db.connect()
    let depositId = ''
    try {
      await client.query('BEGIN')
      const { userId: landlordUserId, landlordId } = await seedLandlord(client)
      const propertyId = await seedProperty(client, {
        landlordId, ownerUserId: landlordUserId, managedByUserId: landlordUserId,
      })
      const unitId = await seedUnit(client, { propertyId, landlordId })
      const leaseId = await seedLease(client, { unitId, landlordId })
      await seedLeaseTenant(client, { leaseId, tenantId: f.tenantId, role: 'primary' })
      depositId = await seedSecurityDeposit(client, {
        unitId, leaseId, tenantId: f.tenantId, totalAmount: 1500,
      })
      // Flip the flex flags after creation (seedSecurityDeposit doesn't expose them)
      await client.query(
        `UPDATE security_deposits SET flex_deposit_enabled=TRUE,
                                       flex_deposit_plan_status='active'
          WHERE id=$1`, [depositId])
      await client.query(
        `INSERT INTO flex_deposit_installments
           (security_deposit_id, tenant_id, installment_number, installment_count,
            amount, due_date, status)
         VALUES ($1, $2, 1, 3, 500, CURRENT_DATE, 'pending')`,
        [depositId, f.tenantId])
      await client.query('COMMIT')
    } catch (e) { await client.query('ROLLBACK'); throw e } finally { client.release() }

    const res = await request(buildApp())
      .get('/api/tenants/flexdeposit')
      .set('Authorization', `Bearer ${f.token}`)
    expect(res.status).toBe(200)
    expect(res.body.data.visible).toBe(true)
    expect(res.body.data.eligibility).toMatchObject({ eligible: true })
    expect(res.body.data.plan.length).toBe(1)
    expect(res.body.data.plan[0].installment_number).toBe(1)
    expect(res.body.data.deposit.flex_deposit_plan_status).toBe('active')
  })

  it('POST /flexdeposit/enroll service ok:false → 400; happy passes through', async () => {
    const f = await seedTenantFixture()
    enrollFlexDepositMock.mockResolvedValueOnce({ ok: false, reason: 'no eligible deposit' })
    const fail = await request(buildApp())
      .post('/api/tenants/flexdeposit/enroll')
      .set('Authorization', `Bearer ${f.token}`)
      .send({ installmentCount: 3, acceptedTerms: true })
    expect(fail.status).toBe(400)
    expect(fail.body.error).toBe('no eligible deposit')

    const ok = await request(buildApp())
      .post('/api/tenants/flexdeposit/enroll')
      .set('Authorization', `Bearer ${f.token}`)
      .send({ installmentCount: 3, acceptedTerms: true })
    expect(ok.status).toBe(200)
    expect(ok.body.data).toMatchObject({ installmentCount: 3, acceptanceId: 'acc_dep' })
  })

  it('GET /flexdeposit/terms installmentCount out of range → 400; happy returns rendered terms', async () => {
    const f = await seedTenantFixture()
    const bad = await request(buildApp())
      .get('/api/tenants/flexdeposit/terms?installmentCount=5')
      .set('Authorization', `Bearer ${f.token}`)
    expect(bad.status).toBe(400)
    expect(bad.body.error).toMatch(/installmentCount must be an integer 2\.\.4/)

    const ok = await request(buildApp())
      .get('/api/tenants/flexdeposit/terms?installmentCount=3')
      .set('Authorization', `Bearer ${f.token}`)
    expect(ok.status).toBe(200)
    expect(ok.body.data).toMatchObject({
      version: 'v1.0', installmentCount: 3, gamAdvanceAmount: 1000, renderedText: 'deposit terms',
    })
  })

  it('POST /flexdeposit/retry-acceleration: service ok:false → 400; happy passes through', async () => {
    const f = await seedTenantFixture()
    retryFlexDepositAccelerationMock.mockResolvedValueOnce({ ok: false, reason: 'no in_default plan' })
    const fail = await request(buildApp())
      .post('/api/tenants/flexdeposit/retry-acceleration')
      .set('Authorization', `Bearer ${f.token}`).send({})
    expect(fail.status).toBe(400)
    expect(fail.body.error).toBe('no in_default plan')

    const ok = await request(buildApp())
      .post('/api/tenants/flexdeposit/retry-acceleration')
      .set('Authorization', `Bearer ${f.token}`).send({})
    expect(ok.status).toBe(200)
  })
})

describe('Deposit portability — eligibility + authorize + decline', () => {
  it('GET /me/deposit/portability/eligibility missing leaseId → 400; happy passes through', async () => {
    const f = await seedTenantFixture()
    const bad = await request(buildApp())
      .get('/api/tenants/me/deposit/portability/eligibility')
      .set('Authorization', `Bearer ${f.token}`)
    expect(bad.status).toBe(400)
    expect(bad.body.error).toMatch(/leaseId required/)

    const leaseId = randomUUID()
    const ok = await request(buildApp())
      .get(`/api/tenants/me/deposit/portability/eligibility?leaseId=${leaseId}`)
      .set('Authorization', `Bearer ${f.token}`)
    expect(ok.status).toBe(200)
    expect(detectPortabilityEligibleMock).toHaveBeenCalledWith({
      leaseId, tenantId: f.tenantId,
    })
  })

  it('POST /portability/authorize missing fields → 400; happy passes through', async () => {
    const f = await seedTenantFixture()
    const bad = await request(buildApp())
      .post('/api/tenants/me/deposit/portability/authorize')
      .set('Authorization', `Bearer ${f.token}`)
      .send({ depositId: randomUUID() })  // missing targetLeaseId + signature
    expect(bad.status).toBe(400)
    expect(bad.body.error).toMatch(/depositId, targetLeaseId, signature required/)

    const ok = await request(buildApp())
      .post('/api/tenants/me/deposit/portability/authorize')
      .set('Authorization', `Bearer ${f.token}`)
      .send({ depositId: 'd1', targetLeaseId: 'l1', signature: 'sig' })
    expect(ok.status).toBe(200)
    expect(authorizeDepositPortabilityMock).toHaveBeenCalledWith({
      tenantId: f.tenantId, depositId: 'd1', targetLeaseId: 'l1',
      signature: 'sig', ip: expect.anything(),
    })
  })
})
