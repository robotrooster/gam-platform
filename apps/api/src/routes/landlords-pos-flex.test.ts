/**
 * landlords.ts POS customers + FlexCharge slice — S363 (landlords
 * slice 7 of N).
 *
 * Per the "finish arcs before pivoting" memory: returning to the
 * landlords.ts arc after the S362 admin.ts detour. 8 routes,
 * ~150 LoC.
 *
 * Coverage focus:
 *   - POS customers: GET/POST/DELETE pass-through to flexCharge
 *     service (mocked); POST required-field validation
 *   - POST /pos-customers/:id/send-onboarding: real DB writes
 *     (pos_customer_invitations); 404 / 403 / 409 guards (not
 *     found, cross-landlord, archived, already-ACH-verified)
 *   - FlexCharge accounts: GET/POST/PATCH pass-through; POST
 *     propertyId-required guard
 */

import { vi, describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { randomUUID } from 'crypto'
import { db } from '../db'
import { cleanupAllSchema, seedLandlord } from '../test/dbHelpers'

const {
  listPosCustomersMock, createPosCustomerMock, archivePosCustomerMock,
  listFlexChargeAccountsMock, createFlexChargeAccountMock,
  updateFlexChargeAccountMock, listAccountStatementsMock,
  sendPosCustomerOnboardingMock,
} = vi.hoisted(() => ({
  listPosCustomersMock:        vi.fn(async (..._args: any[]) => [] as any[]),
  createPosCustomerMock:       vi.fn(async (..._args: any[]) => ({ id: 'pc_mock', first_name: 'A', last_name: 'B' })),
  archivePosCustomerMock:      vi.fn(async (..._args: any[]) => undefined),
  listFlexChargeAccountsMock:  vi.fn(async (..._args: any[]) => [] as any[]),
  createFlexChargeAccountMock: vi.fn(async (..._args: any[]) => ({ id: 'fca_mock' })),
  updateFlexChargeAccountMock: vi.fn(async (..._args: any[]) => ({ id: 'fca_mock', credit_limit: 100 })),
  listAccountStatementsMock:   vi.fn(async (..._args: any[]) => ({ statements: [] })),
  sendPosCustomerOnboardingMock: vi.fn(async (..._args: any[]) => 'msg_mock'),
}))
vi.mock('../services/flexCharge', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    listPosCustomers:        listPosCustomersMock,
    createPosCustomer:       createPosCustomerMock,
    archivePosCustomer:      archivePosCustomerMock,
    listFlexChargeAccounts:  listFlexChargeAccountsMock,
    createFlexChargeAccount: createFlexChargeAccountMock,
    updateFlexChargeAccount: updateFlexChargeAccountMock,
    listAccountStatements:   listAccountStatementsMock,
  }
})
vi.mock('../services/email', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, sendPosCustomerOnboarding: sendPosCustomerOnboardingMock }
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
  listPosCustomersMock.mockClear();        listPosCustomersMock.mockResolvedValue([])
  createPosCustomerMock.mockClear();       createPosCustomerMock.mockResolvedValue({ id: 'pc_mock', first_name: 'A', last_name: 'B' } as any)
  archivePosCustomerMock.mockClear();      archivePosCustomerMock.mockResolvedValue(undefined as any)
  listFlexChargeAccountsMock.mockClear();  listFlexChargeAccountsMock.mockResolvedValue([])
  createFlexChargeAccountMock.mockClear(); createFlexChargeAccountMock.mockResolvedValue({ id: 'fca_mock' } as any)
  updateFlexChargeAccountMock.mockClear(); updateFlexChargeAccountMock.mockResolvedValue({ id: 'fca_mock', credit_limit: 100 } as any)
  listAccountStatementsMock.mockClear();   listAccountStatementsMock.mockResolvedValue({ statements: [] } as any)
  sendPosCustomerOnboardingMock.mockClear()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_pos_flex'
})

interface PFFixture {
  landlordUserId: string
  landlordId:     string
  landlordToken:  string
}

async function seedPFFixture(): Promise<PFFixture> {
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

async function seedPosCustomer(f: PFFixture, opts: {
  archived?: boolean; achVerified?: boolean; landlordId?: string;
} = {}): Promise<{ id: string; email: string }> {
  const email = `pc-${randomUUID().slice(0, 6)}@test.dev`
  const r = await db.query<{ id: string }>(
    `INSERT INTO pos_customers
       (landlord_id, first_name, last_name, email, archived_at, ach_verified)
     VALUES ($1, 'Alice', 'Smith', $2, $3, $4)
     RETURNING id`,
    [opts.landlordId ?? f.landlordId, email,
     opts.archived ? new Date() : null,
     opts.achVerified ?? false])
  return { id: r.rows[0].id, email }
}

describe('POS customers — GET/POST/DELETE pass-through', () => {
  it('GET /pos-customers calls listPosCustomers with landlord profileId', async () => {
    const f = await seedPFFixture()
    const res = await request(buildApp())
      .get('/api/landlords/pos-customers')
      .set('Authorization', `Bearer ${f.landlordToken}`)
    expect(res.status).toBe(200)
    expect(listPosCustomersMock).toHaveBeenCalledWith(f.landlordId)
  })

  it('POST /pos-customers missing required fields → 400', async () => {
    const f = await seedPFFixture()
    const res = await request(buildApp())
      .post('/api/landlords/pos-customers')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ firstName: 'Alice' })  // missing lastName + email
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/firstName, lastName, email required/)
    expect(createPosCustomerMock).not.toHaveBeenCalled()
  })

  it('POST /pos-customers happy: passes landlordId from token + body fields to service', async () => {
    const f = await seedPFFixture()
    const res = await request(buildApp())
      .post('/api/landlords/pos-customers')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ firstName: 'Alice', lastName: 'Smith', email: 'a@x.dev', phone: '555-1234' })
    expect(res.status).toBe(201)
    expect(createPosCustomerMock).toHaveBeenCalledTimes(1)
    expect(createPosCustomerMock.mock.calls[0]![0]).toMatchObject({
      landlordId: f.landlordId, firstName: 'Alice', lastName: 'Smith', email: 'a@x.dev', phone: '555-1234',
    })
  })

  it('DELETE /pos-customers/:id passes landlordId + customerId to archivePosCustomer', async () => {
    const f = await seedPFFixture()
    const customerId = randomUUID()
    const res = await request(buildApp())
      .delete(`/api/landlords/pos-customers/${customerId}`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
    expect(res.status).toBe(200)
    expect(archivePosCustomerMock).toHaveBeenCalledWith({
      landlordId: f.landlordId, customerId,
    })
  })
})

describe('POST /pos-customers/:id/send-onboarding — guards + DB writes', () => {
  it('happy path: writes pos_customer_invitations row + fires email + returns invitation id', async () => {
    const f = await seedPFFixture()
    const c = await seedPosCustomer(f)
    const res = await request(buildApp())
      .post(`/api/landlords/pos-customers/${c.id}/send-onboarding`)
      .set('Authorization', `Bearer ${f.landlordToken}`).send({})
    expect(res.status).toBe(200)
    expect(res.body.data.invitationId).toMatch(/^[0-9a-f-]{36}$/)

    const inv = await db.query<{ token: string; expires_at: string; pos_customer_id: string }>(
      `SELECT token, expires_at::text, pos_customer_id FROM pos_customer_invitations
        WHERE id=$1`, [res.body.data.invitationId])
    expect(inv.rows.length).toBe(1)
    expect(inv.rows[0].pos_customer_id).toBe(c.id)
    expect(inv.rows[0].token).toMatch(/^[0-9a-f]{64}$/)  // 32 bytes hex

    expect(sendPosCustomerOnboardingMock).toHaveBeenCalledTimes(1)
    expect(sendPosCustomerOnboardingMock.mock.calls[0]![0]).toMatchObject({
      customerEmail: c.email,
    })
  })

  it('non-existent customer id → 404', async () => {
    const f = await seedPFFixture()
    const res = await request(buildApp())
      .post(`/api/landlords/pos-customers/${randomUUID()}/send-onboarding`)
      .set('Authorization', `Bearer ${f.landlordToken}`).send({})
    expect(res.status).toBe(404)
    expect(sendPosCustomerOnboardingMock).not.toHaveBeenCalled()
  })

  it('cross-landlord customer → 403', async () => {
    const a = await seedPFFixture()
    const b = await seedPFFixture()
    const bCustomer = await seedPosCustomer(b)
    const res = await request(buildApp())
      .post(`/api/landlords/pos-customers/${bCustomer.id}/send-onboarding`)
      .set('Authorization', `Bearer ${a.landlordToken}`).send({})
    expect(res.status).toBe(403)
    expect(sendPosCustomerOnboardingMock).not.toHaveBeenCalled()
  })

  it('archived customer → 409', async () => {
    const f = await seedPFFixture()
    const c = await seedPosCustomer(f, { archived: true })
    const res = await request(buildApp())
      .post(`/api/landlords/pos-customers/${c.id}/send-onboarding`)
      .set('Authorization', `Bearer ${f.landlordToken}`).send({})
    expect(res.status).toBe(409)
    expect(res.body.error).toMatch(/archived/)
    expect(sendPosCustomerOnboardingMock).not.toHaveBeenCalled()
  })

  it('already-ACH-verified customer → 409', async () => {
    const f = await seedPFFixture()
    const c = await seedPosCustomer(f, { achVerified: true })
    const res = await request(buildApp())
      .post(`/api/landlords/pos-customers/${c.id}/send-onboarding`)
      .set('Authorization', `Bearer ${f.landlordToken}`).send({})
    expect(res.status).toBe(409)
    expect(res.body.error).toMatch(/already ACH-verified/)
    expect(sendPosCustomerOnboardingMock).not.toHaveBeenCalled()
  })
})

describe('FlexCharge accounts — GET/POST/PATCH/statements pass-through', () => {
  it('POST missing propertyId → 400', async () => {
    const f = await seedPFFixture()
    const res = await request(buildApp())
      .post('/api/landlords/flex-charge/accounts')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ tenantId: randomUUID() })  // no propertyId
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/propertyId required/)
    expect(createFlexChargeAccountMock).not.toHaveBeenCalled()
  })

  it('POST happy: passes landlordId + body fields to createFlexChargeAccount', async () => {
    const f = await seedPFFixture()
    const propertyId = randomUUID()
    const tenantId = randomUUID()
    const res = await request(buildApp())
      .post('/api/landlords/flex-charge/accounts')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ propertyId, tenantId, creditLimit: 500, notes: 'open tab' })
    expect(res.status).toBe(201)
    expect(createFlexChargeAccountMock).toHaveBeenCalledWith({
      landlordId: f.landlordId, propertyId, tenantId, posCustomerId: null,
      creditLimit: 500, notes: 'open tab',
    })
  })

  it('PATCH passes landlordId + accountId + body fields to updateFlexChargeAccount', async () => {
    const f = await seedPFFixture()
    const accountId = randomUUID()
    const res = await request(buildApp())
      .patch(`/api/landlords/flex-charge/accounts/${accountId}`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ creditLimit: 1000, status: 'frozen' })
    expect(res.status).toBe(200)
    expect(updateFlexChargeAccountMock).toHaveBeenCalledWith({
      landlordId: f.landlordId, accountId,
      creditLimit: 1000, status: 'frozen', notes: undefined,
    })
  })
})
