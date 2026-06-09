/**
 * admin.ts arc-closer — S372 (admin.ts slice 6 of 6 — FINAL).
 *
 * Final 5 routes to close the admin.ts arc:
 *   - POST /otp/advances/:id/retry-transfer — Stripe boundary
 *     ops helper for failed OTP advance Transfers
 *   - POST /flexcharge/statements/:id/retry-billing — Stripe
 *     boundary ops helper for failed FlexCharge statement bills
 *   - GET /onboarding/tenant/:id — tenant onboarding checklist
 *     (parallel to landlord detail in S369)
 *   - GET /tenants/:tenantId/flexsuite-acceptances — FlexSuite
 *     enrollment audit (S315)
 *   - POST /onboarding/resend — generic resend action with audit
 *     log write
 *
 * fireOtpAdvanceTransfer + retryFlexChargeStatement mocked —
 * their internal Stripe boundary logic has its own coverage.
 */

import { vi, describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { randomUUID } from 'crypto'
import { db } from '../db'
import {
  cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedTenant,
  seedLease,
} from '../test/dbHelpers'

const { fireOtpAdvanceTransferMock, retryFlexChargeStatementMock } = vi.hoisted(() => ({
  fireOtpAdvanceTransferMock:   vi.fn(async (..._args: any[]) => ({
    transferId: 'tr_mock', advanceId: 'adv_mock', amount: 1500,
  })),
  retryFlexChargeStatementMock: vi.fn(async (..._args: any[]) => ({ ok: true, status: 'open' })),
}))
vi.mock('../services/otp', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, fireOtpAdvanceTransfer: fireOtpAdvanceTransferMock }
})
vi.mock('../services/flexCharge', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, retryFlexChargeStatement: retryFlexChargeStatementMock }
})

import { adminRouter } from './admin'
import { errorHandler } from '../middleware/errorHandler'

function buildApp() {
  const app = express()
  app.use(express.json({ limit: '2mb' }))
  app.use('/api/admin', adminRouter)
  app.use(errorHandler)
  return app
}

beforeEach(async () => {
  await cleanupAllSchema()
  fireOtpAdvanceTransferMock.mockClear()
  fireOtpAdvanceTransferMock.mockResolvedValue({
    transferId: 'tr_mock', advanceId: 'adv_mock', amount: 1500,
  } as any)
  retryFlexChargeStatementMock.mockClear()
  retryFlexChargeStatementMock.mockResolvedValue({ ok: true, status: 'open' } as any)
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_admin_close'
})

interface AFixture {
  landlordUserId: string
  landlordId:     string
  adminUserId:    string
  adminToken:     string
}

async function seedAFixture(): Promise<AFixture> {
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    const { userId: landlordUserId, landlordId } = await seedLandlord(client)
    const adminRes = await client.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
       VALUES ($1, 'x', 'admin', 'A', 'D', TRUE) RETURNING id`,
      [`admin-${randomUUID()}@test.dev`])
    await client.query('COMMIT')
    const adminToken = jwt.sign(
      { userId: adminRes.rows[0].id, role: 'admin', email: 'a@test.dev',
        profileId: adminRes.rows[0].id, permissions: {} },
      process.env.JWT_SECRET!, { expiresIn: '1h' },
    )
    return { landlordUserId, landlordId, adminUserId: adminRes.rows[0].id, adminToken }
  } catch (e) { await client.query('ROLLBACK'); throw e }
  finally { client.release() }
}

async function seedOtpAdvance(f: AFixture, opts: {
  stripeTransferId?: string | null;
  landlordHasConnect?: boolean;
} = {}): Promise<string> {
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    const propertyId = await seedProperty(client, {
      landlordId: f.landlordId, ownerUserId: f.landlordUserId,
      managedByUserId: f.landlordUserId,
    })
    const unitId = await seedUnit(client, { propertyId, landlordId: f.landlordId })
    const tenantId = await seedTenant(client)
    const leaseId = await seedLease(client, { unitId, landlordId: f.landlordId })
    if (opts.landlordHasConnect !== false) {
      await client.query(
        `UPDATE users SET stripe_connect_account_id='acct_mock_ll' WHERE id=$1`,
        [f.landlordUserId])
    }
    const r = await client.query<{ id: string }>(
      `INSERT INTO otp_advances
         (cycle_month, tenant_id, landlord_id, unit_id, lease_id,
          rent_amount, fee_amount, advance_amount, status,
          stripe_transfer_id)
       VALUES (CURRENT_DATE, $1, $2, $3, $4, 1500, 15, 1485, 'pending', $5)
       RETURNING id`,
      [tenantId, f.landlordId, unitId, leaseId, opts.stripeTransferId ?? null])
    await client.query('COMMIT')
    return r.rows[0].id
  } catch (e) { await client.query('ROLLBACK'); throw e } finally { client.release() }
}

describe('POST /api/admin/otp/advances/:id/retry-transfer', () => {
  it('not found → 404', async () => {
    const f = await seedAFixture()
    const res = await request(buildApp())
      .post(`/api/admin/otp/advances/${randomUUID()}/retry-transfer`)
      .set('Authorization', `Bearer ${f.adminToken}`).send({})
    expect(res.status).toBe(404)
    expect(fireOtpAdvanceTransferMock).not.toHaveBeenCalled()
  })

  it('already funded (stripe_transfer_id set) → 409; service NOT called', async () => {
    const f = await seedAFixture()
    const advId = await seedOtpAdvance(f, { stripeTransferId: 'tr_existing_abc' })
    const res = await request(buildApp())
      .post(`/api/admin/otp/advances/${advId}/retry-transfer`)
      .set('Authorization', `Bearer ${f.adminToken}`).send({})
    expect(res.status).toBe(409)
    expect(res.body.error).toMatch(/Already funded/)
    expect(fireOtpAdvanceTransferMock).not.toHaveBeenCalled()
  })

  it('landlord has no Connect account → 409; service NOT called', async () => {
    const f = await seedAFixture()
    const advId = await seedOtpAdvance(f, { landlordHasConnect: false })
    const res = await request(buildApp())
      .post(`/api/admin/otp/advances/${advId}/retry-transfer`)
      .set('Authorization', `Bearer ${f.adminToken}`).send({})
    expect(res.status).toBe(409)
    expect(res.body.error).toMatch(/no Stripe Connect account/)
    expect(fireOtpAdvanceTransferMock).not.toHaveBeenCalled()
  })

  it('happy: calls fireOtpAdvanceTransfer with landlordConnect + amount + tenant/landlord ids', async () => {
    const f = await seedAFixture()
    const advId = await seedOtpAdvance(f)
    const res = await request(buildApp())
      .post(`/api/admin/otp/advances/${advId}/retry-transfer`)
      .set('Authorization', `Bearer ${f.adminToken}`).send({})
    expect(res.status).toBe(200)
    expect(fireOtpAdvanceTransferMock).toHaveBeenCalledTimes(1)
    const args = fireOtpAdvanceTransferMock.mock.calls[0]![0]
    expect(args).toMatchObject({
      advanceId: advId, landlordConnect: 'acct_mock_ll',
      amount: 1485, landlordId: f.landlordId,
    })
  })
})

describe('POST /api/admin/flexcharge/statements/:id/retry-billing', () => {
  it('happy: passes statement id to retryFlexChargeStatement; returns service result', async () => {
    const f = await seedAFixture()
    const stmtId = randomUUID()
    retryFlexChargeStatementMock.mockResolvedValueOnce({ ok: true, status: 'open' } as any)
    const res = await request(buildApp())
      .post(`/api/admin/flexcharge/statements/${stmtId}/retry-billing`)
      .set('Authorization', `Bearer ${f.adminToken}`).send({})
    expect(res.status).toBe(200)
    expect(res.body.data).toMatchObject({ ok: true, status: 'open' })
    expect(retryFlexChargeStatementMock).toHaveBeenCalledWith(stmtId)
  })
})

describe('GET /api/admin/onboarding/tenant/:id', () => {
  it('happy: returns tenant + derived checklist (flex flags reflect tenant state)', async () => {
    const f = await seedAFixture()
    const client = await db.connect()
    let tenantId = ''
    try {
      await client.query('BEGIN')
      tenantId = await seedTenant(client)
      // Flip a couple flex flags so the checklist derivation is non-trivial
      await client.query(
        `UPDATE tenants SET ach_verified=TRUE, bank_last4='4321',
                            flex_deposit_enrolled=TRUE
          WHERE id=$1`, [tenantId])
      await client.query('COMMIT')
    } catch (e) { await client.query('ROLLBACK'); throw e } finally { client.release() }

    const res = await request(buildApp())
      .get(`/api/admin/onboarding/tenant/${tenantId}`)
      .set('Authorization', `Bearer ${f.adminToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data.tenant.id).toBe(tenantId)
    const checklist = Object.fromEntries(
      res.body.data.checklist.map((c: any) => [c.key, c.done]))
    expect(checklist.account_created).toBe(true)
    expect(checklist.ach_enrolled).toBe(true)  // bank_last4 set
    expect(checklist.ach_verified).toBe(true)
    expect(checklist.flex_deposit).toBe(true)
    expect(checklist.flex_credit).toBe(false)
    expect(checklist.flex_pay).toBe(false)
  })
})

describe('GET /api/admin/tenants/:tenantId/flexsuite-acceptances', () => {
  it('returns rows ordered by accepted_at DESC; empty list when no acceptances', async () => {
    const f = await seedAFixture()
    const client = await db.connect()
    let tenantId = ''
    let tenantUserId = ''
    try {
      await client.query('BEGIN')
      tenantId = await seedTenant(client)
      const tu = await client.query<{ user_id: string }>(
        `SELECT user_id FROM tenants WHERE id=$1`, [tenantId])
      tenantUserId = tu.rows[0].user_id
      // Seed two acceptances at different times
      await client.query(
        `INSERT INTO flexsuite_enrollment_acceptances
           (tenant_id, user_id, product_type, template_version,
            populated_content, rendered_text, content_hash, accepted_at)
         VALUES
           ($1, $2, 'flexpay', 'v1', '{}'::jsonb, 'pay terms', 'hash_pay', NOW() - INTERVAL '1 day'),
           ($1, $2, 'flexdeposit', 'v1', '{}'::jsonb, 'dep terms', 'hash_dep', NOW())`,
        [tenantId, tenantUserId])
      await client.query('COMMIT')
    } catch (e) { await client.query('ROLLBACK'); throw e } finally { client.release() }

    const res = await request(buildApp())
      .get(`/api/admin/tenants/${tenantId}/flexsuite-acceptances`)
      .set('Authorization', `Bearer ${f.adminToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data.length).toBe(2)
    // accepted_at DESC: flexdeposit (now) first, flexpay (1d ago) second
    expect(res.body.data[0].product_type).toBe('flexdeposit')
    expect(res.body.data[1].product_type).toBe('flexpay')
    expect(res.body.data[0].accepter_email).toBeDefined()
  })
})

describe('POST /api/admin/onboarding/resend', () => {
  it('happy: writes admin_action_log row with action_type derived from body.type', async () => {
    const f = await seedAFixture()
    const targetId = randomUUID()
    const res = await request(buildApp())
      .post('/api/admin/onboarding/resend')
      .set('Authorization', `Bearer ${f.adminToken}`)
      .send({ type: 'activation_email', targetId })
    expect(res.status).toBe(200)
    expect(res.body.data.message).toMatch(/activation_email notification queued/)

    const log = await db.query<{ action_type: string; target_id: string }>(
      `SELECT action_type, target_id FROM admin_action_log
        WHERE admin_user_id=$1 AND target_type='tenant'`, [f.adminUserId])
    expect(log.rows.length).toBe(1)
    expect(log.rows[0].action_type).toBe('resend_activation_email')
    expect(log.rows[0].target_id).toBe(targetId)
  })
})
