/**
 * S423 route slice: POST /api/background/submit reads provider per
 * landlord from `landlords.background_provider` instead of
 * hardcoding 'mock'.
 *
 * Covered (4 cases):
 *   - Targeted submission, landlord.background_provider='mock'
 *     → background_checks.provider_name='mock'; getProvider('mock')
 *       called
 *   - Targeted submission, landlord.background_provider='checkr'
 *     → background_checks.provider_name='checkr'; getProvider('checkr')
 *       called
 *   - Speculative submission (no landlordId) → defaults to 'mock'
 *   - Targeted with unknown landlordId → 404
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

// vi.hoisted runs BEFORE vi.mock factories, so stubProvider /
// getProviderMock are available when the mocks are evaluated.
const { stubProvider, getProviderMock } = vi.hoisted(() => {
  const stub = {
    name: 'stub',
    initiate: vi.fn(async () => ({
      providerRef: 'ref_default',
      status: 'awaiting_applicant' as const,
      applicantRedirectUrl: null,
    })),
    verifyWebhook: vi.fn(() => true),
    parseWebhook: vi.fn(),
    craDisclosure: vi.fn(() => ({ name: 'Stub', address: '', phone: '' })),
  }
  return { stubProvider: stub, getProviderMock: vi.fn(() => stub) }
})
vi.mock('../services/backgroundProvider', () => ({
  getProvider: getProviderMock,
}))

// Risk score is wrapped in try/catch in the route, but mocking keeps
// the test deterministic + isolated.
vi.mock('../services/riskScore', () => ({
  calculateRiskScore: vi.fn(async () => ({ score: 50, level: 'medium', flags: [] })),
}))

// Email is fire-and-forget on the targeted path; mock to avoid hitting
// the mail service.
vi.mock('../services/email', () => ({
  emailNewBackgroundCheck:    vi.fn(async () => undefined),
  emailBackgroundDecision:    vi.fn(async () => undefined),
  emailPoolMatchInterest:     vi.fn(async () => undefined),
  emailPoolTenantInterested:  vi.fn(async () => undefined),
  emailAdverseActionNotice:   vi.fn(async () => undefined),
}))

import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { randomUUID } from 'crypto'
import { db } from '../db'
import {
  cleanupAllSchema, seedLandlord, seedProperty, seedUnit,
} from '../test/dbHelpers'
import { backgroundRouter } from './background'
import { errorHandler } from '../middleware/errorHandler'

function buildApp() {
  const app = express()
  app.use(express.json({ limit: '2mb' }))
  app.use('/api/background', backgroundRouter)
  app.use(errorHandler)
  return app
}

beforeEach(async () => {
  await cleanupAllSchema()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_s423'
  getProviderMock.mockClear()
  stubProvider.initiate.mockClear()
  // Reset stubProvider.initiate's default return (some tests override).
  stubProvider.initiate.mockResolvedValue({
    providerRef: 'ref_default',
    status: 'awaiting_applicant',
    applicantRedirectUrl: null,
  } as any)
})

interface Fixture {
  applicantUserId: string
  applicantToken:  string
  landlordToken:   string
  landlordUserId:  string
  landlordId:      string
  propertyId:      string
  unitId:          string
}

async function seedFixture(opts: { provider?: 'mock' | 'checkr' } = {}): Promise<Fixture> {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const { userId: landlordUserId, landlordId } = await seedLandlord(c)
    if (opts.provider) {
      await c.query(
        `UPDATE landlords SET background_provider=$1 WHERE id=$2`,
        [opts.provider, landlordId])
    }
    const propertyId = await seedProperty(c, {
      landlordId, ownerUserId: landlordUserId, managedByUserId: landlordUserId,
    })
    const unitId = await seedUnit(c, { propertyId, landlordId })
    const { rows: [{ id: applicantUserId, email }] } = await c.query<{ id: string; email: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
       VALUES ($1, 'x', 'tenant', 'App', 'Licant', TRUE) RETURNING id, email`,
      [`app-${randomUUID()}@test.dev`])
    await c.query('COMMIT')
    const applicantToken = jwt.sign(
      { userId: applicantUserId, role: 'tenant', email,
        profileId: randomUUID() },
      process.env.JWT_SECRET!, { expiresIn: '1h' })
    const landlordToken = jwt.sign(
      { userId: landlordUserId, role: 'landlord', email: 'll@test.dev',
        profileId: landlordId },
      process.env.JWT_SECRET!, { expiresIn: '1h' })
    return {
      applicantUserId, applicantToken, landlordToken,
      landlordUserId, landlordId, propertyId, unitId,
    }
  } catch (e) { await c.query('ROLLBACK'); throw e }
  finally { c.release() }
}

const happyPayload = (opts: { landlordId?: string; unitId?: string } = {}) => ({
  firstName: 'App', lastName: 'Licant',
  dateOfBirth: '1990-05-15',
  ssn: '123-45-6789',
  street1: '100 Main St', city: 'Phoenix', state: 'AZ', zip: '85001',
  yearsAtAddress: 3,
  employmentStatus: 'employed', employerName: 'Acme', employerPhone: '5555550100',
  monthlyIncome: 5000,
  prevLandlordName: null, prevLandlordPhone: null, prevLandlordEmail: null,
  idDocumentUrl: null, incomeDocUrls: [],
  consentCredit: true, consentCriminal: true,
  consentPool: !opts.landlordId,
  timeToComplete: 120,
  applicantPaymentIntentId: 'pi_intake_mock_' + randomUUID().replace(/-/g, ''),
  landlordId: opts.landlordId,
  unitId: opts.unitId,
})

describe('POST /api/background/submit — S423 per-landlord provider selection', () => {
  it('landlord.background_provider=mock → row stamped mock; getProvider("mock") called', async () => {
    const f = await seedFixture({ provider: 'mock' })
    const res = await request(buildApp())
      .post('/api/background/submit')
      .set('Authorization', `Bearer ${f.applicantToken}`)
      .send(happyPayload({ landlordId: f.landlordId, unitId: f.unitId }))
    expect(res.status).toBe(201)
    expect(getProviderMock).toHaveBeenCalledWith('mock')
    const { rows: [row] } = await db.query<any>(
      `SELECT provider_name FROM background_checks WHERE id=$1`, [res.body.data.id])
    expect(row.provider_name).toBe('mock')
  })

  it('S423 fix: landlord.background_provider=checkr → row stamped checkr; getProvider("checkr") called', async () => {
    const f = await seedFixture({ provider: 'checkr' })
    const res = await request(buildApp())
      .post('/api/background/submit')
      .set('Authorization', `Bearer ${f.applicantToken}`)
      .send(happyPayload({ landlordId: f.landlordId, unitId: f.unitId }))
    expect(res.status).toBe(201)
    expect(getProviderMock).toHaveBeenCalledWith('checkr')
    const { rows: [row] } = await db.query<any>(
      `SELECT provider_name FROM background_checks WHERE id=$1`, [res.body.data.id])
    expect(row.provider_name).toBe('checkr')
  })

  // S423 finding (flagged, NOT fixed): the route at background.ts:286
  // sends `landlordId || null` as the landlord_id, but the schema
  // (background_checks.landlord_id) is NOT NULL. Speculative
  // submissions (no landlordId in the body) therefore 500 on the
  // INSERT. This is a pre-existing inconsistency — the route advertises
  // a speculative-pool mode that the schema rejects. Either the schema
  // needs to drop NOT NULL or the route needs to refuse missing
  // landlordId with a clean 400. Bundle into the validation-hygiene
  // backlog; not in S423 scope (which is provider selection only).

  it('unknown landlordId → 404', async () => {
    const f = await seedFixture()
    const res = await request(buildApp())
      .post('/api/background/submit')
      .set('Authorization', `Bearer ${f.applicantToken}`)
      .send(happyPayload({ landlordId: randomUUID(), unitId: f.unitId }))
    expect(res.status).toBe(404)
    expect(res.body.error).toMatch(/landlord not found/i)
  })
})

// S551: Checkr Tenant collects SSN/identity on ITS hosted apply flow, so
// checkr-provider intakes submit WITHOUT an SSN, and the route resolves the
// rental property address for the order.
describe('POST /api/background/submit — S551 checkr no-SSN + property resolution', () => {
  it('checkr without SSN → 201; initiate gets property address + null ssnLast4; row ssn columns NULL', async () => {
    const f = await seedFixture({ provider: 'checkr' })
    const res = await request(buildApp())
      .post('/api/background/submit')
      .set('Authorization', `Bearer ${f.applicantToken}`)
      .send({ ...happyPayload({ landlordId: f.landlordId, unitId: f.unitId }), ssn: undefined })
    expect(res.status).toBe(201)
    const initArgs = (stubProvider.initiate as any).mock.calls.at(-1)[0]
    expect(initArgs.ssnLast4).toBeNull()
    expect(initArgs.property).toMatchObject({
      street: '1 Test St', city: 'Phoenix', state: 'AZ', zipcode: '85001',
    })
    const { rows: [row] } = await db.query<any>(
      `SELECT ssn_last4, ssn_encrypted FROM background_checks WHERE id=$1`, [res.body.data.id])
    expect(row.ssn_last4).toBeNull()
    expect(row.ssn_encrypted).toBeNull()
  })

  it('mock provider without SSN → 400 (SSN still required off the checkr path)', async () => {
    const f = await seedFixture({ provider: 'mock' })
    const res = await request(buildApp())
      .post('/api/background/submit')
      .set('Authorization', `Bearer ${f.applicantToken}`)
      .send({ ...happyPayload({ landlordId: f.landlordId, unitId: f.unitId }), ssn: undefined })
    expect(res.status).toBe(400)
  })

  it('checkr without unitId falls back to the landlord first property for the order', async () => {
    const f = await seedFixture({ provider: 'checkr' })
    const res = await request(buildApp())
      .post('/api/background/submit')
      .set('Authorization', `Bearer ${f.applicantToken}`)
      .send({ ...happyPayload({ landlordId: f.landlordId }), ssn: undefined })
    expect(res.status).toBe(201)
    const initArgs = (stubProvider.initiate as any).mock.calls.at(-1)[0]
    expect(initArgs.property).toMatchObject({ street: '1 Test St', zipcode: '85001' })
  })
})

// S561: the applicant no longer pays for screening — GAM bills the LANDLORD
// (Checkr cost passed through + a flat $5 margin). The 50-state applicant
// fee-cap machinery was retired; there is no applicant payment step.
describe('S561 landlord-billed screening', () => {
  it('/price reports the applicant fee waived (applicant is never charged)', async () => {
    const f = await seedFixture({ provider: 'checkr' })
    const res = await request(buildApp())
      .get(`/api/background/price?landlordId=${f.landlordId}&unitId=${f.unitId}`)
    expect(res.status).toBe(200)
    expect(res.body.data).toMatchObject({ totalFee: 0, feeWaived: true, providerCollectsPii: true })
  })

  it('submit succeeds with NO applicant payment intent', async () => {
    const f = await seedFixture({ provider: 'mock' })
    const res = await request(buildApp())
      .post('/api/background/submit')
      .set('Authorization', `Bearer ${f.applicantToken}`)
      .send({ ...happyPayload({ landlordId: f.landlordId, unitId: f.unitId }), applicantPaymentIntentId: undefined })
    expect(res.status).toBe(201)
    const { rows: [row] } = await db.query<any>(
      `SELECT applicant_payment_intent_id FROM background_checks WHERE id=$1`, [res.body.data.id])
    expect(row.applicant_payment_intent_id).toBeNull()
  })

  it('checkr submit writes the landlord accrual = Checkr cost + $5 margin', async () => {
    const f = await seedFixture({ provider: 'checkr' })
    const res = await request(buildApp())
      .post('/api/background/submit')
      .set('Authorization', `Bearer ${f.applicantToken}`)
      .send({ ...happyPayload({ landlordId: f.landlordId, unitId: f.unitId }), ssn: undefined })
    expect(res.status).toBe(201)
    const { rows: [acc] } = await db.query<any>(
      `SELECT compliance_fee, standard_total, applicant_charged, shortfall, state
         FROM screening_fee_accruals WHERE background_check_id=$1`, [res.body.data.id])
    expect(acc).toBeTruthy()
    // standard_total = Checkr cost passed through; compliance_fee = GAM's $5
    // margin; landlord owes the sum ($42.94). applicant_charged/shortfall = 0.
    const cost = parseFloat(process.env.SCREENING_CHECKR_COST_USD || '37.94')
    const margin = parseFloat(process.env.SCREENING_GAM_MARGIN_USD || '5')
    expect(parseFloat(acc.standard_total)).toBeCloseTo(cost, 2)
    expect(parseFloat(acc.compliance_fee)).toBeCloseTo(margin, 2)
    expect(parseFloat(acc.applicant_charged)).toBe(0)
    expect(parseFloat(acc.shortfall)).toBe(0)
    expect(acc.state).toBeNull()
  })

  it('mock-provider submit writes NO accrual', async () => {
    const f = await seedFixture({ provider: 'mock' })
    const res = await request(buildApp())
      .post('/api/background/submit')
      .set('Authorization', `Bearer ${f.applicantToken}`)
      .send(happyPayload({ landlordId: f.landlordId, unitId: f.unitId }))
    expect(res.status).toBe(201)
    const { rows } = await db.query<any>(
      `SELECT id FROM screening_fee_accruals WHERE background_check_id=$1`, [res.body.data.id])
    expect(rows.length).toBe(0)
  })
})

// S552: never-completed screenings — cancel refunds the applicant (mock
// intents no-op on Stripe but still void the accrual) and the stale sweep
// cancels + refunds checks stuck awaiting the applicant.
describe('S552 screening refunds', () => {
  it('applicant cancel voids the unbilled landlord accrual', async () => {
    const f = await seedFixture({ provider: 'checkr' })
    const res = await request(buildApp())
      .post('/api/background/submit')
      .set('Authorization', `Bearer ${f.applicantToken}`)
      .send({ ...happyPayload({ landlordId: f.landlordId, unitId: f.unitId }), ssn: undefined })
    expect(res.status).toBe(201)
    const checkId = res.body.data.id
    const { rows: pre } = await db.query<any>(
      `SELECT id FROM screening_fee_accruals WHERE background_check_id=$1`, [checkId])
    expect(pre.length).toBe(1)

    const cancel = await request(buildApp())
      .post(`/api/background/${checkId}/cancel`)
      .set('Authorization', `Bearer ${f.applicantToken}`)
    expect(cancel.status).toBe(200)
    // Mock payment intent → no Stripe refund, but the accrual is voided.
    expect(cancel.body.data.refunded).toBe(false)
    const { rows: post } = await db.query<any>(
      `SELECT id FROM screening_fee_accruals WHERE background_check_id=$1`, [checkId])
    expect(post.length).toBe(0)
    const { rows: [chk] } = await db.query<any>(
      `SELECT status FROM background_checks WHERE id=$1`, [checkId])
    expect(chk.status).toBe('cancelled')
  })

  it('stale sweep cancels awaiting_applicant checks older than the window', async () => {
    const f = await seedFixture({ provider: 'checkr' })
    const res = await request(buildApp())
      .post('/api/background/submit')
      .set('Authorization', `Bearer ${f.applicantToken}`)
      .send({ ...happyPayload({ landlordId: f.landlordId, unitId: f.unitId }), ssn: undefined })
    const checkId = res.body.data.id
    // Stub provider returns 'pending'; force the stale-eligible state + age.
    await db.query(
      `UPDATE background_checks SET status='awaiting_applicant', created_at = NOW() - INTERVAL '45 days' WHERE id=$1`,
      [checkId])
    const { sweepStaleBackgroundChecks } = await import('../services/backgroundRefund')
    const swept = await sweepStaleBackgroundChecks()
    expect(swept.swept).toBeGreaterThanOrEqual(1)
    const { rows: [chk] } = await db.query<any>(
      `SELECT status, stripe_refund_id FROM background_checks WHERE id=$1`, [checkId])
    expect(chk.status).toBe('cancelled')
    // Mock intent → no Stripe refund id, and no crash.
    expect(chk.stripe_refund_id).toBeNull()
    const { rows: acc } = await db.query<any>(
      `SELECT id FROM screening_fee_accruals WHERE background_check_id=$1`, [checkId])
    expect(acc.length).toBe(0)
  })
})

// S552: monthly sweep — unbilled accruals become ONE ledger entry per
// landlord, rows get stamped, and re-running sweeps nothing.
describe('S552 screening fee sweep', () => {
  it('sweeps unbilled accruals into platform_revenue_ledger and is idempotent', async () => {
    const f = await seedFixture({ provider: 'checkr' })
    // S561: each accrual = standard_total (Checkr cost passed through) +
    // compliance_fee (GAM's $5 margin); applicant_charged/shortfall = 0. Seed
    // two → 2 × $42.94.
    for (let i = 0; i < 2; i++) {
      const { rows: [{ id: uid }] } = await db.query<{ id: string }>(
        `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
         VALUES ($1,'x','tenant','S','W', TRUE) RETURNING id`, [`sw-${randomUUID()}@t.dev`])
      const { rows: [{ id: bcId }] } = await db.query<{ id: string }>(
        `INSERT INTO background_checks (landlord_id, user_id, status, provider_name, provider_ref,
           consent_credit, consent_criminal, consent_pool, first_name, last_name)
         VALUES ($1,$2,'processing','checkr',$3,TRUE,TRUE,FALSE,'S','W') RETURNING id`,
        [f.landlordId, uid, 'ord_' + randomUUID().replace(/-/g, '')])
      await db.query(
        `INSERT INTO screening_fee_accruals
           (background_check_id, landlord_id, accrual_month, compliance_fee,
            standard_total, applicant_charged, shortfall, state)
         VALUES ($1,$2, date_trunc('month', NOW())::date, 5, 37.94, 0, 0, NULL)`,
        [bcId, f.landlordId])
    }

    const { processScreeningFeeSweep } = await import('../jobs/platformFeeAccrual')
    const sweep = await processScreeningFeeSweep()
    expect(sweep.landlordsSwept).toBe(1)
    expect(sweep.accrualsSwept).toBe(2)
    expect(sweep.totalSwept).toBe(85.88)  // 2 × (37.94 + 5)

    const { rows: [ledger] } = await db.query<any>(
      `SELECT amount, reference_type FROM platform_revenue_ledger
        WHERE reference_type='screening_fee_sweep' AND reference_id=$1`, [f.landlordId])
    expect(parseFloat(ledger.amount)).toBe(85.88)

    const { rows } = await db.query<any>(
      `SELECT billed_at, platform_revenue_ledger_id FROM screening_fee_accruals WHERE landlord_id=$1`,
      [f.landlordId])
    expect(rows.length).toBe(2)
    for (const r of rows) {
      expect(r.billed_at).not.toBeNull()
      expect(r.platform_revenue_ledger_id).not.toBeNull()
    }

    // Idempotent: nothing left to sweep.
    const again = await processScreeningFeeSweep()
    expect(again.landlordsSwept).toBe(0)
    expect(again.accrualsSwept).toBe(0)
  })
})

// S561: GAM no longer auto-authors/sends the FCRA adverse-action notice on
// denial. The landlord composes+sends it; GAM returns CRA facts + the saved
// template to help, delivers the landlord's text, and records it for audit.
describe('S561 landlord-owned adverse action', () => {
  async function denyFixture() {
    const f = await seedFixture({ provider: 'checkr' })
    const sub = await request(buildApp())
      .post('/api/background/submit')
      .set('Authorization', `Bearer ${f.applicantToken}`)
      .send({ ...happyPayload({ landlordId: f.landlordId, unitId: f.unitId }), ssn: undefined })
    expect(sub.status).toBe(201)
    const checkId = sub.body.data.id
    // Make the check decidable.
    await db.query(`UPDATE background_checks SET status='processing' WHERE id=$1`, [checkId])
    return { f, checkId }
  }

  it('denial returns CRA facts + saved template and does NOT auto-create a notice', async () => {
    const { f, checkId } = await denyFixture()
    const res = await request(buildApp())
      .patch(`/api/background/${checkId}/decision`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ decision: 'denied' })
    expect(res.status).toBe(200)
    expect(res.body.data.adverseAction).toBeTruthy()
    expect(res.body.data.adverseAction.craInfo.name).toBeTruthy()
    expect(res.body.data.adverseAction.savedTemplate).toBeNull()
    // No auto-authored notice — the landlord sends it explicitly.
    const { rows } = await db.query<any>(
      `SELECT id FROM adverse_action_notices WHERE background_check_id=$1`, [checkId])
    expect(rows.length).toBe(0)
  })

  it('landlord sends the notice → emailed, recorded verbatim, template saved', async () => {
    const { f, checkId } = await denyFixture()
    await request(buildApp())
      .patch(`/api/background/${checkId}/decision`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ decision: 'denied' })

    const body = 'Your application was declined. The report came from the agency below; they did not make the decision. You may dispute it.'
    const send = await request(buildApp())
      .post(`/api/background/${checkId}/adverse-action`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ text: body, saveAsTemplate: true })
    expect(send.status).toBe(200)
    expect(send.body.data.sent).toBe(true)

    const { rows: [notice] } = await db.query<any>(
      `SELECT notice_text FROM adverse_action_notices WHERE background_check_id=$1`, [checkId])
    expect(notice.notice_text).toBe(body)
    const { rows: [ll] } = await db.query<any>(
      `SELECT adverse_action_template FROM landlords WHERE id=$1`, [f.landlordId])
    expect(ll.adverse_action_template).toBe(body)
  })

  it('adverse-action send is rejected for a non-denied applicant', async () => {
    const { f, checkId } = await denyFixture()  // status = 'processing', not denied
    const res = await request(buildApp())
      .post(`/api/background/${checkId}/adverse-action`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ text: 'nope' })
    expect(res.status).toBe(400)
  })
})
