/**
 * admin.ts deposit-portability + connect-readiness + landlord-
 * banking-nudges slice — S371 (admin.ts slice 5 of N).
 *
 * Admin operational tools (~6 routes):
 *   - GET /deposit-portability/pending — list pending_transfer
 *     security_deposits with prev/new landlord context
 *   - POST /deposit-portability/:depositId/mark-transferred —
 *     status flip from pending_transfer → carried_forward
 *   - POST /connect-readiness/backfill — Stripe-call-per-row
 *     refresh of cached Connect flags across users + pm_companies
 *   - GET /connect-readiness/accounts — union of users +
 *     pm_companies with Connect accounts
 *   - GET /landlord-banking-nudges — read-only nudge audit
 *   - POST /connect-readiness/refresh/:entity/:id — single-row
 *     Stripe refresh
 *
 * fetchAccountStatus is mocked — its Stripe boundary has its own
 * coverage; this slice tests the route contract + DB updates.
 */

import { vi, describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { randomUUID } from 'crypto'
import { db } from '../db'
import {
  cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedTenant,
  seedLease, seedSecurityDeposit,
} from '../test/dbHelpers'

const { fetchAccountStatusMock } = vi.hoisted(() => ({
  fetchAccountStatusMock: vi.fn(async (..._args: any[]) => ({
    charges_enabled: true, payouts_enabled: true, details_submitted: true,
  })),
}))
vi.mock('../services/stripeConnect', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, fetchAccountStatus: fetchAccountStatusMock }
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
  fetchAccountStatusMock.mockClear()
  fetchAccountStatusMock.mockResolvedValue({
    charges_enabled: true, payouts_enabled: true, details_submitted: true,
  } as any)
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_admin_dep'
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

async function seedPortableDeposit(f: AFixture): Promise<string> {
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
    const depositId = await seedSecurityDeposit(client, {
      unitId, leaseId, tenantId, totalAmount: 1500,
    })
    // Flip portability_status to pending_transfer; route only lists that state
    await client.query(
      `UPDATE security_deposits SET portability_status='pending_transfer',
                                    portability_authorized_at=NOW()
        WHERE id=$1`, [depositId])
    await client.query('COMMIT')
    return depositId
  } catch (e) { await client.query('ROLLBACK'); throw e } finally { client.release() }
}

describe('GET /api/admin/deposit-portability/pending', () => {
  it('returns rows with portability_status=pending_transfer + joined landlord/tenant context', async () => {
    const f = await seedAFixture()
    const depositId = await seedPortableDeposit(f)
    const res = await request(buildApp())
      .get('/api/admin/deposit-portability/pending')
      .set('Authorization', `Bearer ${f.adminToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data.length).toBe(1)
    expect(res.body.data[0].id).toBe(depositId)
    expect(Number(res.body.data[0].total_amount)).toBe(1500)
    expect(res.body.data[0].tenant_email).toBeDefined()
    expect(res.body.data[0].new_landlord_name).toBeDefined()
  })
})

describe('POST /api/admin/deposit-portability/:id/mark-transferred', () => {
  it('not found → 404', async () => {
    const f = await seedAFixture()
    const res = await request(buildApp())
      .post(`/api/admin/deposit-portability/${randomUUID()}/mark-transferred`)
      .set('Authorization', `Bearer ${f.adminToken}`).send({})
    expect(res.status).toBe(404)
  })

  it('wrong status (not pending_transfer) → 409', async () => {
    const f = await seedAFixture()
    const depositId = await seedPortableDeposit(f)
    // Flip to a non-pending state
    await db.query(`UPDATE security_deposits SET portability_status='carried_forward' WHERE id=$1`, [depositId])
    const res = await request(buildApp())
      .post(`/api/admin/deposit-portability/${depositId}/mark-transferred`)
      .set('Authorization', `Bearer ${f.adminToken}`).send({})
    expect(res.status).toBe(409)
    expect(res.body.error).toMatch(/can only mark-transferred from 'pending_transfer'/)
  })

  it('happy: flips to carried_forward + appends admin timestamp to notes', async () => {
    const f = await seedAFixture()
    const depositId = await seedPortableDeposit(f)
    const res = await request(buildApp())
      .post(`/api/admin/deposit-portability/${depositId}/mark-transferred`)
      .set('Authorization', `Bearer ${f.adminToken}`)
      .send({ notes: 'wire confirmed' })
    expect(res.status).toBe(200)
    expect(res.body.data.status).toBe('carried_forward')

    const row = await db.query<{ portability_status: string; notes: string }>(
      `SELECT portability_status, notes FROM security_deposits WHERE id=$1`, [depositId])
    expect(row.rows[0].portability_status).toBe('carried_forward')
    expect(row.rows[0].notes).toMatch(/Admin transfer confirmed by user/)
    expect(row.rows[0].notes).toMatch(/wire confirmed/)
  })
})

describe('POST /api/admin/connect-readiness/backfill', () => {
  it('empty (no Connect accounts) → 0/0 counts; no Stripe calls; audit log row written', async () => {
    const f = await seedAFixture()
    const res = await request(buildApp())
      .post('/api/admin/connect-readiness/backfill')
      .set('Authorization', `Bearer ${f.adminToken}`).send({})
    expect(res.status).toBe(200)
    expect(res.body.data.users.scanned).toBe(0)
    expect(res.body.data.pm_companies.scanned).toBe(0)
    expect(fetchAccountStatusMock).not.toHaveBeenCalled()

    const log = await db.query<{ action_type: string }>(
      `SELECT action_type FROM admin_action_log WHERE admin_user_id=$1`, [f.adminUserId])
    expect(log.rows.length).toBe(1)
    expect(log.rows[0].action_type).toBe('connect_readiness_backfill')
  })

  it('seeded user + pm_company with stripe_connect_account_id → Stripe called + flags updated', async () => {
    const f = await seedAFixture()
    // Seed a user with a Connect account but unset flags
    await db.query(
      `UPDATE users SET stripe_connect_account_id='acct_user_1',
                        connect_payouts_enabled=FALSE, connect_details_submitted=FALSE
        WHERE id=$1`, [f.landlordUserId])
    // Seed a pm_company likewise
    await db.query(
      `INSERT INTO pm_companies (name, status, stripe_connect_account_id, connect_payouts_enabled, connect_details_submitted)
       VALUES ('PMx', 'active', 'acct_pm_1', FALSE, FALSE)`)

    fetchAccountStatusMock.mockResolvedValue({
      charges_enabled: true, payouts_enabled: true, details_submitted: true,
    } as any)

    const res = await request(buildApp())
      .post('/api/admin/connect-readiness/backfill')
      .set('Authorization', `Bearer ${f.adminToken}`).send({})
    expect(res.status).toBe(200)
    expect(res.body.data.users.scanned).toBe(1)
    expect(res.body.data.users.updated).toBe(1)
    expect(res.body.data.pm_companies.scanned).toBe(1)
    expect(res.body.data.pm_companies.updated).toBe(1)
    expect(fetchAccountStatusMock).toHaveBeenCalledTimes(2)

    const u = await db.query<{ connect_payouts_enabled: boolean; stripe_connect_status_synced_at: string }>(
      `SELECT connect_payouts_enabled, stripe_connect_status_synced_at FROM users WHERE id=$1`,
      [f.landlordUserId])
    expect(u.rows[0].connect_payouts_enabled).toBe(true)
    expect(u.rows[0].stripe_connect_status_synced_at).not.toBeNull()
  })

  it('Stripe throws for one row → increments errors[], scan continues; request stays 200', async () => {
    const f = await seedAFixture()
    await db.query(
      `UPDATE users SET stripe_connect_account_id='acct_bad',
                        connect_payouts_enabled=FALSE, connect_details_submitted=FALSE
        WHERE id=$1`, [f.landlordUserId])
    fetchAccountStatusMock.mockRejectedValueOnce(new Error('Stripe 500'))

    const res = await request(buildApp())
      .post('/api/admin/connect-readiness/backfill')
      .set('Authorization', `Bearer ${f.adminToken}`).send({})
    expect(res.status).toBe(200)
    expect(res.body.data.users.scanned).toBe(1)
    expect(res.body.data.users.updated).toBe(0)
    expect(res.body.data.users.errors).toBe(1)
    expect(res.body.data.errors.length).toBe(1)
    expect(res.body.data.errors[0].entity).toBe('user')
    expect(res.body.data.errors[0].message).toBe('Stripe 500')
  })
})

describe('GET /api/admin/connect-readiness/accounts', () => {
  it('returns union of users + pm_companies with stripe_connect_account_id set', async () => {
    const f = await seedAFixture()
    await db.query(
      `UPDATE users SET stripe_connect_account_id='acct_user_z' WHERE id=$1`,
      [f.landlordUserId])
    await db.query(
      `INSERT INTO pm_companies (name, status, stripe_connect_account_id)
       VALUES ('Acme PM', 'active', 'acct_pm_z')`)

    const res = await request(buildApp())
      .get('/api/admin/connect-readiness/accounts')
      .set('Authorization', `Bearer ${f.adminToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data.length).toBe(2)
    const types = res.body.data.map((r: any) => r.entity_type).sort()
    expect(types).toEqual(['pm_company', 'user'])
  })
})

describe('GET /api/admin/landlord-banking-nudges', () => {
  it('returns rows filtered to category=landlord_banking_nudge', async () => {
    const f = await seedAFixture()
    await db.query(
      `INSERT INTO email_send_log (to_email, subject, category, status) VALUES
         ('ll@x.dev', 'finish onboarding', 'landlord_banking_nudge', 'sent'),
         ('ll@x.dev', 'unrelated', 'tx', 'sent')`)
    const res = await request(buildApp())
      .get('/api/admin/landlord-banking-nudges')
      .set('Authorization', `Bearer ${f.adminToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data.length).toBe(1)
    expect(res.body.data[0].landlord_email).toBe('ll@x.dev')
  })
})

describe('POST /api/admin/connect-readiness/refresh/:entity/:id', () => {
  it('invalid entity → 400', async () => {
    const f = await seedAFixture()
    const res = await request(buildApp())
      .post(`/api/admin/connect-readiness/refresh/widget/${randomUUID()}`)
      .set('Authorization', `Bearer ${f.adminToken}`).send({})
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/entity must be 'user' or 'pm_company'/)
  })

  it('happy: refreshes user row + writes audit log', async () => {
    const f = await seedAFixture()
    await db.query(
      `UPDATE users SET stripe_connect_account_id='acct_user_refresh',
                        connect_payouts_enabled=FALSE WHERE id=$1`, [f.landlordUserId])
    fetchAccountStatusMock.mockResolvedValueOnce({
      charges_enabled: true, payouts_enabled: true, details_submitted: true,
    } as any)

    const res = await request(buildApp())
      .post(`/api/admin/connect-readiness/refresh/user/${f.landlordUserId}`)
      .set('Authorization', `Bearer ${f.adminToken}`).send({})
    expect(res.status).toBe(200)
    expect(res.body.data.payouts_enabled).toBe(true)
    const log = await db.query<{ action_type: string; target_id: string }>(
      `SELECT action_type, target_id FROM admin_action_log
        WHERE admin_user_id=$1 AND target_type='user'`, [f.adminUserId])
    expect(log.rows.length).toBe(1)
    expect(log.rows[0].action_type).toBe('connect_readiness_refresh')
    expect(log.rows[0].target_id).toBe(f.landlordUserId)
  })
})
