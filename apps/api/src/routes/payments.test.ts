/**
 * payments.ts gap-close slice — S407. Closes the file at 4/4 (100%).
 *
 * Covered routes (4):
 *   - GET  /api/payments
 *   - POST /api/payments/initiate-rent-collection   (S407 fix)
 *   - POST /api/payments/:id/handle-return
 *   - POST /api/payments/:id/pay
 *
 * Production bugs fixed in this slice (1):
 *   - **POST /initiate-rent-collection idempotency.** Pre-fix the route
 *     INSERT'd a rent payment row for every eligible unit without
 *     checking for existing rows. Two cron firings (scheduler misfire,
 *     admin double-click) duplicated EVERY tenant's rent bill for the
 *     target month — no UNIQUE constraint on
 *     payments(unit_id, type, due_date) to catch it. Added a
 *     SELECT-then-skip guard inside the loop; response now includes
 *     `skipped` count.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('../services/supersedence', () => ({
  computeTenantGamOutstandingTotal: vi.fn(async () => 0),
}))

vi.mock('../services/adminNotifications', () => ({
  createAdminNotification: vi.fn(async () => undefined),
}))

vi.mock('../services/stripeConnect', async () => {
  const computeApplicationFee = vi.fn(() => 5.00)
  const createRentDestinationCharge = vi.fn(async () => ({
    id: 'pi_dest_mock', status: 'processing',
  }))
  const createRentPlatformCharge = vi.fn(async () => ({
    id: 'pi_plat_mock', status: 'processing',
  }))
  return {
    computeApplicationFee,
    createRentDestinationCharge,
    createRentPlatformCharge,
  }
})

vi.mock('../lib/stripe', () => {
  const paymentMethodsRetrieve = vi.fn(async () => ({
    id: 'pm_x',
    card: { brand: 'visa', last4: '1111', country: 'US' },
  }))
  return {
    getStripe: () => ({ paymentMethods: { retrieve: paymentMethodsRetrieve } }),
    createTenantAchSetup: vi.fn(),
  }
})

import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { randomUUID } from 'crypto'
import { db } from '../db'
import {
  cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedTenant,
  seedLease, seedLeaseTenant, seedUserBankAccount,
} from '../test/dbHelpers'
import { paymentsRouter } from './payments'
import { errorHandler } from '../middleware/errorHandler'
import * as stripeConnect from '../services/stripeConnect'

function buildApp() {
  const app = express()
  app.use(express.json({ limit: '2mb' }))
  app.use('/api/payments', paymentsRouter)
  app.use(errorHandler)
  return app
}

beforeEach(async () => {
  await cleanupAllSchema()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_payments'
  ;(stripeConnect.computeApplicationFee as ReturnType<typeof vi.fn>).mockClear()
  ;(stripeConnect.createRentDestinationCharge as ReturnType<typeof vi.fn>).mockClear()
  ;(stripeConnect.createRentPlatformCharge as ReturnType<typeof vi.fn>).mockClear()
})

const sign = (claims: any) =>
  jwt.sign(claims, process.env.JWT_SECRET!, { expiresIn: '1h' })

interface Fixture {
  aUid: string; aLid: string; aPropId: string; aUnitId: string
  bUid: string; bLid: string; bPropId: string; bUnitId: string
  tenant1Id: string; tenant1UserId: string; lease1Id: string
  tokenLandlordA: string; tokenLandlordB: string
  tokenTenant1: string; tokenAdmin: string
}

async function seed(): Promise<Fixture> {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const { userId: aUid, landlordId: aLid } = await seedLandlord(c)
    const { userId: bUid, landlordId: bLid } = await seedLandlord(c)
    const aPropId = await seedProperty(c, { landlordId: aLid, ownerUserId: aUid, managedByUserId: aUid })
    const bPropId = await seedProperty(c, { landlordId: bLid, ownerUserId: bUid, managedByUserId: bUid })
    const aUnitId = await seedUnit(c, { propertyId: aPropId, landlordId: aLid })
    const bUnitId = await seedUnit(c, { propertyId: bPropId, landlordId: bLid })
    const tenant1Id = await seedTenant(c)
    const { rows: [{ user_id: tenant1UserId }] } = await c.query<{ user_id: string }>(
      `SELECT user_id FROM tenants WHERE id=$1`, [tenant1Id])
    const lease1Id = await seedLease(c, { unitId: aUnitId, landlordId: aLid })
    await seedLeaseTenant(c, { leaseId: lease1Id, tenantId: tenant1Id, role: 'primary' })
    await c.query('COMMIT')
    return {
      aUid, aLid, aPropId, aUnitId,
      bUid, bLid, bPropId, bUnitId,
      tenant1Id, tenant1UserId, lease1Id,
      tokenLandlordA: sign({ userId: aUid, role: 'landlord', email: 'a@t.dev',
                              profileId: aLid, permissions: {} }),
      tokenLandlordB: sign({ userId: bUid, role: 'landlord', email: 'b@t.dev',
                              profileId: bLid, permissions: {} }),
      tokenTenant1: sign({ userId: tenant1UserId, role: 'tenant', email: 't1@t.dev',
                            profileId: tenant1Id }),
      tokenAdmin: sign({ userId: randomUUID(), role: 'admin', email: 'admin@t.dev',
                          profileId: randomUUID() }),
    }
  } catch (e) { await c.query('ROLLBACK'); throw e }
  finally { c.release() }
}

// S414: dueOffsetMonths lets a test seed multiple payments per unit/type
// without colliding on the ux_payments_unit_type_due_date_active UNIQUE
// constraint (added in S414 to bulletproof /initiate-rent-collection).
// Defaults to 0 for the single-payment-per-test cases.
let __seedPaymentCounter = 0
async function seedPayment(opts: {
  unitId: string; tenantId: string; landlordId: string
  type?: string; amount?: number; status?: string
  dueOffsetMonths?: number
}): Promise<string> {
  const offset = opts.dueOffsetMonths ?? (__seedPaymentCounter++)
  const { rows: [{ id }] } = await db.query<{ id: string }>(
    `INSERT INTO payments
       (unit_id, tenant_id, landlord_id, type, amount, status,
        entry_description, due_date)
     VALUES ($1,$2,$3,$4,$5,$6,'RENT',CURRENT_DATE + ($7 || ' months')::interval)
     RETURNING id`,
    [opts.unitId, opts.tenantId, opts.landlordId,
     opts.type ?? 'rent', opts.amount ?? 1000, opts.status ?? 'pending', offset])
  return id
}
beforeEach(() => { __seedPaymentCounter = 0 })

// ─── GET /api/payments ──────────────────────────────────────

describe('GET /api/payments', () => {
  it('landlord sees only own payments (cross-tenant filtered)', async () => {
    const f = await seed()
    const pA = await seedPayment({ unitId: f.aUnitId, tenantId: f.tenant1Id, landlordId: f.aLid })
    const pB = await seedPayment({ unitId: f.bUnitId, tenantId: f.tenant1Id, landlordId: f.bLid })
    const res = await request(buildApp()).get('/api/payments')
      .set('Authorization', `Bearer ${f.tokenLandlordA}`)
    expect(res.status).toBe(200)
    const ids = (res.body.data as any[]).map(p => p.id)
    expect(ids).toContain(pA)
    expect(ids).not.toContain(pB)
    expect(res.body.total).toBe(1)
  })

  it('tenant sees only own payments', async () => {
    const f = await seed()
    const tenant2Id = await (async () => {
      const c = await db.connect()
      try {
        await c.query('BEGIN')
        const id = await seedTenant(c)
        await c.query('COMMIT')
        return id
      } finally { c.release() }
    })()
    const pOwn = await seedPayment({ unitId: f.aUnitId, tenantId: f.tenant1Id, landlordId: f.aLid })
    const pOther = await seedPayment({ unitId: f.aUnitId, tenantId: tenant2Id, landlordId: f.aLid })
    const res = await request(buildApp()).get('/api/payments')
      .set('Authorization', `Bearer ${f.tokenTenant1}`)
    expect(res.status).toBe(200)
    const ids = (res.body.data as any[]).map(p => p.id)
    expect(ids).toContain(pOwn)
    expect(ids).not.toContain(pOther)
  })

  it('admin sees all', async () => {
    const f = await seed()
    await seedPayment({ unitId: f.aUnitId, tenantId: f.tenant1Id, landlordId: f.aLid })
    await seedPayment({ unitId: f.bUnitId, tenantId: f.tenant1Id, landlordId: f.bLid })
    const res = await request(buildApp()).get('/api/payments')
      .set('Authorization', `Bearer ${f.tokenAdmin}`)
    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(2)
  })

  it('team-role without landlordId → empty (no leak)', async () => {
    const f = await seed()
    await seedPayment({ unitId: f.aUnitId, tenantId: f.tenant1Id, landlordId: f.aLid })
    const teamNoScope = sign({ userId: randomUUID(), role: 'property_manager',
                                email: 'pm@t.dev', profileId: randomUUID(),
                                permissions: { 'payments.view_all': true } })
    const res = await request(buildApp()).get('/api/payments')
      .set('Authorization', `Bearer ${teamNoScope}`)
    expect(res.status).toBe(200)
    expect(res.body.data).toEqual([])
  })

  it('team-role with landlordId but no payments.view_all → empty', async () => {
    const f = await seed()
    await seedPayment({ unitId: f.aUnitId, tenantId: f.tenant1Id, landlordId: f.aLid })
    const teamNoPerm = sign({ userId: randomUUID(), role: 'onsite_manager',
                               email: 'om@t.dev', profileId: randomUUID(),
                               landlordId: f.aLid, permissions: {} })
    const res = await request(buildApp()).get('/api/payments')
      .set('Authorization', `Bearer ${teamNoPerm}`)
    expect(res.status).toBe(200)
    expect(res.body.data).toEqual([])
  })

  it('team-role with landlordId + payments.view_all → sees landlord payments', async () => {
    const f = await seed()
    const pA = await seedPayment({ unitId: f.aUnitId, tenantId: f.tenant1Id, landlordId: f.aLid })
    const teamWithPerm = sign({ userId: randomUUID(), role: 'property_manager',
                                  email: 'pm@t.dev', profileId: randomUUID(),
                                  landlordId: f.aLid,
                                  permissions: { 'payments.view_all': true } })
    const res = await request(buildApp()).get('/api/payments')
      .set('Authorization', `Bearer ${teamWithPerm}`)
    expect(res.status).toBe(200)
    expect((res.body.data as any[]).map(p => p.id)).toEqual([pA])
  })

  it('status + type filters narrow results', async () => {
    const f = await seed()
    await seedPayment({ unitId: f.aUnitId, tenantId: f.tenant1Id, landlordId: f.aLid,
                       type: 'rent', status: 'settled' })
    await seedPayment({ unitId: f.aUnitId, tenantId: f.tenant1Id, landlordId: f.aLid,
                       type: 'late_fee', status: 'pending' })
    const res = await request(buildApp()).get('/api/payments?type=rent&status=settled')
      .set('Authorization', `Bearer ${f.tokenLandlordA}`)
    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(1)
    expect(res.body.data[0].type).toBe('rent')
    expect(res.body.data[0].status).toBe('settled')
  })

  it('pagination: page=1 limit=1 returns 1 row, total reflects full count', async () => {
    const f = await seed()
    await seedPayment({ unitId: f.aUnitId, tenantId: f.tenant1Id, landlordId: f.aLid })
    await seedPayment({ unitId: f.aUnitId, tenantId: f.tenant1Id, landlordId: f.aLid })
    await seedPayment({ unitId: f.aUnitId, tenantId: f.tenant1Id, landlordId: f.aLid })
    const res = await request(buildApp()).get('/api/payments?page=1&limit=1')
      .set('Authorization', `Bearer ${f.tokenLandlordA}`)
    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(1)
    expect(res.body.total).toBe(3)
    expect(res.body.totalPages).toBe(3)
  })
})

// ─── POST /api/payments/initiate-rent-collection ────────────

describe('POST /api/payments/initiate-rent-collection', () => {
  async function setupEligibleUnit(f: Fixture) {
    // Activate the unit, verify the tenant's ACH, give landlord A an
    // active bank account row so the eligibility query matches.
    await db.query(`UPDATE units SET status='active' WHERE id=$1`, [f.aUnitId])
    await db.query(`UPDATE tenants SET ach_verified=TRUE WHERE id=$1`, [f.tenant1Id])
    const c = await db.connect()
    try {
      await c.query('BEGIN')
      await seedUserBankAccount(c, { userId: f.aUid })
      await c.query('COMMIT')
    } finally { c.release() }
  }

  it('non-admin → 403', async () => {
    const f = await seed()
    const res = await request(buildApp()).post('/api/payments/initiate-rent-collection')
      .set('Authorization', `Bearer ${f.tokenLandlordA}`)
      .send({ targetMonth: '2026-07' })
    expect(res.status).toBe(403)
  })

  it('bad targetMonth format → 400', async () => {
    const f = await seed()
    const res = await request(buildApp()).post('/api/payments/initiate-rent-collection')
      .set('Authorization', `Bearer ${f.tokenAdmin}`)
      .send({ targetMonth: 'July 2026' })
    expect(res.status).toBe(400)
  })

  it('happy: creates pending rent payments for eligible units', async () => {
    const f = await seed()
    await setupEligibleUnit(f)
    const res = await request(buildApp()).post('/api/payments/initiate-rent-collection')
      .set('Authorization', `Bearer ${f.tokenAdmin}`)
      .send({ targetMonth: '2026-07' })
    expect(res.status).toBe(200)
    expect(res.body.data.initiated).toBe(1)
    expect(res.body.data.skipped).toBe(0)
    const { rows } = await db.query<any>(
      `SELECT type, status, amount FROM payments WHERE unit_id=$1 AND type='rent'`,
      [f.aUnitId])
    expect(rows).toHaveLength(1)
    expect(rows[0].status).toBe('pending')
  })

  it('S407 fix: second call for same targetMonth skips instead of duplicating', async () => {
    const f = await seed()
    await setupEligibleUnit(f)
    const first = await request(buildApp()).post('/api/payments/initiate-rent-collection')
      .set('Authorization', `Bearer ${f.tokenAdmin}`)
      .send({ targetMonth: '2026-07' })
    expect(first.body.data.initiated).toBe(1)
    const second = await request(buildApp()).post('/api/payments/initiate-rent-collection')
      .set('Authorization', `Bearer ${f.tokenAdmin}`)
      .send({ targetMonth: '2026-07' })
    expect(second.status).toBe(200)
    expect(second.body.data.initiated).toBe(0)
    expect(second.body.data.skipped).toBe(1)
    // Verify NO duplicate row was created.
    const { rows } = await db.query<any>(
      `SELECT id FROM payments WHERE unit_id=$1 AND type='rent'`, [f.aUnitId])
    expect(rows).toHaveLength(1)
  })

  it('different targetMonth creates a separate row (idempotency is per-month)', async () => {
    const f = await seed()
    await setupEligibleUnit(f)
    await request(buildApp()).post('/api/payments/initiate-rent-collection')
      .set('Authorization', `Bearer ${f.tokenAdmin}`)
      .send({ targetMonth: '2026-07' })
    await request(buildApp()).post('/api/payments/initiate-rent-collection')
      .set('Authorization', `Bearer ${f.tokenAdmin}`)
      .send({ targetMonth: '2026-08' })
    const { rows } = await db.query<any>(
      `SELECT due_date FROM payments WHERE unit_id=$1 AND type='rent' ORDER BY due_date`,
      [f.aUnitId])
    expect(rows).toHaveLength(2)
  })

  it('unit with payment_block=TRUE is excluded (eviction-mode units don\'t get charged)', async () => {
    const f = await seed()
    await setupEligibleUnit(f)
    await db.query(`UPDATE units SET payment_block=TRUE WHERE id=$1`, [f.aUnitId])
    const res = await request(buildApp()).post('/api/payments/initiate-rent-collection')
      .set('Authorization', `Bearer ${f.tokenAdmin}`)
      .send({ targetMonth: '2026-07' })
    expect(res.status).toBe(200)
    expect(res.body.data.initiated).toBe(0)
  })

  it('tenant without ach_verified is excluded', async () => {
    const f = await seed()
    await setupEligibleUnit(f)
    await db.query(`UPDATE tenants SET ach_verified=FALSE WHERE id=$1`, [f.tenant1Id])
    const res = await request(buildApp()).post('/api/payments/initiate-rent-collection')
      .set('Authorization', `Bearer ${f.tokenAdmin}`)
      .send({ targetMonth: '2026-07' })
    expect(res.body.data.initiated).toBe(0)
  })
})

// ─── POST /api/payments/:id/handle-return ───────────────────

describe('POST /api/payments/:id/handle-return', () => {
  it('non-admin → 403', async () => {
    const f = await seed()
    const pid = await seedPayment({ unitId: f.aUnitId, tenantId: f.tenant1Id,
                                     landlordId: f.aLid })
    const res = await request(buildApp()).post(`/api/payments/${pid}/handle-return`)
      .set('Authorization', `Bearer ${f.tokenLandlordA}`)
      .send({ returnCode: 'R01' })
    expect(res.status).toBe(403)
  })

  it('unknown returnCode → 400', async () => {
    const f = await seed()
    const pid = await seedPayment({ unitId: f.aUnitId, tenantId: f.tenant1Id,
                                     landlordId: f.aLid })
    const res = await request(buildApp()).post(`/api/payments/${pid}/handle-return`)
      .set('Authorization', `Bearer ${f.tokenAdmin}`)
      .send({ returnCode: 'R99' })
    expect(res.status).toBe(400)
  })

  it('unknown payment id → 404', async () => {
    const f = await seed()
    const res = await request(buildApp()).post(`/api/payments/${randomUUID()}/handle-return`)
      .set('Authorization', `Bearer ${f.tokenAdmin}`)
      .send({ returnCode: 'R01' })
    expect(res.status).toBe(404)
  })

  it('non-zero-tolerance R01: status→returned, monitoring log, no ACH suspension', async () => {
    const f = await seed()
    const pid = await seedPayment({ unitId: f.aUnitId, tenantId: f.tenant1Id,
                                     landlordId: f.aLid })
    const res = await request(buildApp()).post(`/api/payments/${pid}/handle-return`)
      .set('Authorization', `Bearer ${f.tokenAdmin}`)
      .send({ returnCode: 'R01' })
    expect(res.status).toBe(200)
    expect(res.body.data.zeroTolerance).toBe(false)
    const { rows: [p] } = await db.query<any>(
      `SELECT status, return_code, zero_tolerance_flag FROM payments WHERE id=$1`, [pid])
    expect(p.status).toBe('returned')
    expect(p.return_code).toBe('R01')
    expect(p.zero_tolerance_flag).toBe(false)
    const { rows: [t] } = await db.query<any>(
      `SELECT ach_verified FROM tenants WHERE id=$1`, [f.tenant1Id])
    // Pre-existing default is FALSE; setupEligible wasn't called, so we
    // pin "not flipped" relative to its pre-call value.
    expect(t.ach_verified).toBe(false)
  })

  it('zero-tolerance R10: status→returned + tenant ach_verified flipped FALSE + extra log row', async () => {
    const f = await seed()
    await db.query(`UPDATE tenants SET ach_verified=TRUE WHERE id=$1`, [f.tenant1Id])
    const pid = await seedPayment({ unitId: f.aUnitId, tenantId: f.tenant1Id,
                                     landlordId: f.aLid })
    const res = await request(buildApp()).post(`/api/payments/${pid}/handle-return`)
      .set('Authorization', `Bearer ${f.tokenAdmin}`)
      .send({ returnCode: 'R10' })
    expect(res.status).toBe(200)
    expect(res.body.data.zeroTolerance).toBe(true)
    expect(res.body.data.action).toMatch(/suspended/)
    const { rows: [t] } = await db.query<any>(
      `SELECT ach_verified FROM tenants WHERE id=$1`, [f.tenant1Id])
    expect(t.ach_verified).toBe(false)
    const { rows: logs } = await db.query<any>(
      `SELECT event_type FROM ach_monitoring_log WHERE payment_id=$1 ORDER BY event_type`,
      [pid])
    expect(logs.map(l => l.event_type)).toEqual(['return_received', 'zero_tolerance_block'])
  })
})

// ─── POST /api/payments/:id/pay ─────────────────────────────

describe('POST /api/payments/:id/pay', () => {
  async function setupTenantForPay(f: Fixture, opts: { connectReady?: boolean } = {}) {
    await db.query(`UPDATE tenants SET stripe_customer_id='cus_t1' WHERE id=$1`, [f.tenant1Id])
    if (opts.connectReady) {
      await db.query(
        `UPDATE users SET stripe_connect_account_id='acct_l1',
                          connect_charges_enabled=TRUE,
                          connect_details_submitted=TRUE WHERE id=$1`, [f.aUid])
    }
  }

  it('non-tenant → 403', async () => {
    const f = await seed()
    const pid = await seedPayment({ unitId: f.aUnitId, tenantId: f.tenant1Id, landlordId: f.aLid })
    const res = await request(buildApp()).post(`/api/payments/${pid}/pay`)
      .set('Authorization', `Bearer ${f.tokenLandlordA}`)
      .send({ paymentMethodId: 'pm_x', paymentMethodType: 'ach' })
    expect(res.status).toBe(403)
  })

  it('cross-tenant payment id → 403 "Not your payment"', async () => {
    const f = await seed()
    const otherTenantId = await (async () => {
      const c = await db.connect()
      try {
        await c.query('BEGIN')
        const id = await seedTenant(c)
        await c.query('COMMIT')
        return id
      } finally { c.release() }
    })()
    const pid = await seedPayment({ unitId: f.aUnitId, tenantId: otherTenantId,
                                     landlordId: f.aLid })
    const res = await request(buildApp()).post(`/api/payments/${pid}/pay`)
      .set('Authorization', `Bearer ${f.tokenTenant1}`)
      .send({ paymentMethodId: 'pm_x', paymentMethodType: 'ach' })
    expect(res.status).toBe(403)
  })

  it('unknown payment id → 404', async () => {
    const f = await seed()
    const res = await request(buildApp()).post(`/api/payments/${randomUUID()}/pay`)
      .set('Authorization', `Bearer ${f.tokenTenant1}`)
      .send({ paymentMethodId: 'pm_x', paymentMethodType: 'ach' })
    expect(res.status).toBe(404)
  })

  it('payment already settled → 409', async () => {
    const f = await seed()
    await setupTenantForPay(f, { connectReady: true })
    const pid = await seedPayment({ unitId: f.aUnitId, tenantId: f.tenant1Id,
                                     landlordId: f.aLid, status: 'settled' })
    const res = await request(buildApp()).post(`/api/payments/${pid}/pay`)
      .set('Authorization', `Bearer ${f.tokenTenant1}`)
      .send({ paymentMethodId: 'pm_x', paymentMethodType: 'ach' })
    expect(res.status).toBe(409)
  })

  it('S511 #8b: eviction mode (payment_block) blocks the landlord-bound payment → 409', async () => {
    const f = await seed()
    await setupTenantForPay(f, { connectReady: true })
    const pid = await seedPayment({ unitId: f.aUnitId, tenantId: f.tenant1Id, landlordId: f.aLid })
    await db.query(`UPDATE units SET payment_block=TRUE WHERE id=$1`, [f.aUnitId])
    const res = await request(buildApp()).post(`/api/payments/${pid}/pay`)
      .set('Authorization', `Bearer ${f.tokenTenant1}`)
      .send({ paymentMethodId: 'pm_x', paymentMethodType: 'ach' })
    expect(res.status).toBe(409)
    expect(res.body.message || res.body.error).toMatch(/eviction/i)
    // No charge attempted.
    expect(stripeConnect.createRentDestinationCharge).not.toHaveBeenCalled()
    expect(stripeConnect.createRentPlatformCharge).not.toHaveBeenCalled()
  })

  it('payment already processing (with PI id) → 409', async () => {
    const f = await seed()
    await setupTenantForPay(f, { connectReady: true })
    const pid = await seedPayment({ unitId: f.aUnitId, tenantId: f.tenant1Id,
                                     landlordId: f.aLid, status: 'processing' })
    await db.query(`UPDATE payments SET stripe_payment_intent_id='pi_x' WHERE id=$1`, [pid])
    const res = await request(buildApp()).post(`/api/payments/${pid}/pay`)
      .set('Authorization', `Bearer ${f.tokenTenant1}`)
      .send({ paymentMethodId: 'pm_x', paymentMethodType: 'ach' })
    expect(res.status).toBe(409)
  })

  it('tenant without stripe_customer_id → 409 "complete ACH setup first"', async () => {
    const f = await seed()
    const pid = await seedPayment({ unitId: f.aUnitId, tenantId: f.tenant1Id, landlordId: f.aLid })
    const res = await request(buildApp()).post(`/api/payments/${pid}/pay`)
      .set('Authorization', `Bearer ${f.tokenTenant1}`)
      .send({ paymentMethodId: 'pm_x', paymentMethodType: 'ach' })
    expect(res.status).toBe(409)
  })

  it('happy: Connect-ready landlord → destination charge, status→processing', async () => {
    const f = await seed()
    await setupTenantForPay(f, { connectReady: true })
    const pid = await seedPayment({ unitId: f.aUnitId, tenantId: f.tenant1Id, landlordId: f.aLid })
    const res = await request(buildApp()).post(`/api/payments/${pid}/pay`)
      .set('Authorization', `Bearer ${f.tokenTenant1}`)
      .send({ paymentMethodId: 'pm_x', paymentMethodType: 'ach' })
    expect(res.status).toBe(200)
    expect(stripeConnect.createRentDestinationCharge).toHaveBeenCalledTimes(1)
    expect(stripeConnect.createRentPlatformCharge).not.toHaveBeenCalled()
    expect(res.body.data.paymentIntentId).toBe('pi_dest_mock')
    const { rows: [p] } = await db.query<any>(
      `SELECT status, stripe_payment_intent_id, platform_held FROM payments WHERE id=$1`, [pid])
    expect(p.status).toBe('processing')
    expect(p.stripe_payment_intent_id).toBe('pi_dest_mock')
    expect(p.platform_held).toBe(false)
  })

  it('S113-PhaseA: landlord NOT Connect-ready → platform charge + platform_held=TRUE', async () => {
    const f = await seed()
    await setupTenantForPay(f, { connectReady: false })
    const pid = await seedPayment({ unitId: f.aUnitId, tenantId: f.tenant1Id, landlordId: f.aLid })
    const res = await request(buildApp()).post(`/api/payments/${pid}/pay`)
      .set('Authorization', `Bearer ${f.tokenTenant1}`)
      .send({ paymentMethodId: 'pm_x', paymentMethodType: 'ach' })
    expect(res.status).toBe(200)
    expect(stripeConnect.createRentPlatformCharge).toHaveBeenCalledTimes(1)
    expect(stripeConnect.createRentDestinationCharge).not.toHaveBeenCalled()
    expect(res.body.data.paymentIntentId).toBe('pi_plat_mock')
    const { rows: [p] } = await db.query<any>(
      `SELECT platform_held FROM payments WHERE id=$1`, [pid])
    expect(p.platform_held).toBe(true)
  })

  it('card payment: status→settled immediately (no webhook needed)', async () => {
    const f = await seed()
    await setupTenantForPay(f, { connectReady: true })
    const pid = await seedPayment({ unitId: f.aUnitId, tenantId: f.tenant1Id, landlordId: f.aLid })
    const res = await request(buildApp()).post(`/api/payments/${pid}/pay`)
      .set('Authorization', `Bearer ${f.tokenTenant1}`)
      .send({ paymentMethodId: 'pm_x', paymentMethodType: 'card' })
    expect(res.status).toBe(200)
    const { rows: [p] } = await db.query<any>(
      `SELECT status FROM payments WHERE id=$1`, [pid])
    expect(p.status).toBe('settled')
  })

  it('invalid paymentMethodType enum → 400', async () => {
    const f = await seed()
    await setupTenantForPay(f, { connectReady: true })
    const pid = await seedPayment({ unitId: f.aUnitId, tenantId: f.tenant1Id, landlordId: f.aLid })
    const res = await request(buildApp()).post(`/api/payments/${pid}/pay`)
      .set('Authorization', `Bearer ${f.tokenTenant1}`)
      .send({ paymentMethodId: 'pm_x', paymentMethodType: 'crypto' })
    expect(res.status).toBe(400)
  })
})
