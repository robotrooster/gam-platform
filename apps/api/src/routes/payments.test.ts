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
      // super_admin: GET /api/payments is portfolio-scoped for REGULAR admins
      // (S567) — a plain admin only sees payments of landlords they close/service.
      // These tests assert the full/unscoped view, which is the super_admin lens.
      tokenAdmin: sign({ userId: randomUUID(), role: 'super_admin', email: 'admin@t.dev',
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

  async function setFeePayer(propId: string, ach: 'tenant' | 'landlord', card: 'tenant' | 'landlord') {
    await db.query(
      `INSERT INTO property_allocation_rules (property_id, ach_fee_payer, card_fee_payer)
       VALUES ($1, $2, $3)
       ON CONFLICT (property_id) DO UPDATE SET ach_fee_payer=$2, card_fee_payer=$3`,
      [propId, ach, card])
  }

  // S562: the processing fee (mock computeApplicationFee → $5) must be ADDED to
  // the charge when the tenant is the fee payer, so GAM doesn't eat Stripe's
  // cost. When the landlord pays it, the charge stays pure rent and the
  // landlord absorbs the fee via the settle-time allocation split.
  it('S562: tenant pays ACH fee → charge = rent + processing fee', async () => {
    const f = await seed()
    await setupTenantForPay(f, { connectReady: true })
    await setFeePayer(f.aPropId, 'tenant', 'tenant')
    const pid = await seedPayment({ unitId: f.aUnitId, tenantId: f.tenant1Id, landlordId: f.aLid, amount: 1000 })
    const res = await request(buildApp()).post(`/api/payments/${pid}/pay`)
      .set('Authorization', `Bearer ${f.tokenTenant1}`)
      .send({ paymentMethodId: 'pm_x', paymentMethodType: 'ach' })
    expect(res.status).toBe(200)
    expect(stripeConnect.createRentPlatformCharge).toHaveBeenCalledTimes(1)
    expect((stripeConnect.createRentPlatformCharge as any).mock.calls[0][0].amount).toBe(1005)
  })

  it('S562: landlord pays ACH fee → charge = rent only (landlord absorbs at settle)', async () => {
    const f = await seed()
    await setupTenantForPay(f, { connectReady: true })
    await setFeePayer(f.aPropId, 'landlord', 'tenant')
    const pid = await seedPayment({ unitId: f.aUnitId, tenantId: f.tenant1Id, landlordId: f.aLid, amount: 1000 })
    const res = await request(buildApp()).post(`/api/payments/${pid}/pay`)
      .set('Authorization', `Bearer ${f.tokenTenant1}`)
      .send({ paymentMethodId: 'pm_x', paymentMethodType: 'ach' })
    expect(res.status).toBe(200)
    expect((stripeConnect.createRentPlatformCharge as any).mock.calls[0][0].amount).toBe(1000)
  })

  it('S562: card is always tenant-borne → charge = rent + fee even when ACH is landlord', async () => {
    const f = await seed()
    await setupTenantForPay(f, { connectReady: true })
    await setFeePayer(f.aPropId, 'landlord', 'tenant')
    const pid = await seedPayment({ unitId: f.aUnitId, tenantId: f.tenant1Id, landlordId: f.aLid, amount: 1000 })
    const res = await request(buildApp()).post(`/api/payments/${pid}/pay`)
      .set('Authorization', `Bearer ${f.tokenTenant1}`)
      .send({ paymentMethodId: 'pm_x', paymentMethodType: 'card' })
    expect(res.status).toBe(200)
    expect((stripeConnect.createRentPlatformCharge as any).mock.calls[0][0].amount).toBe(1005)
  })

  it('S562: tenant-payer platform-fee passthrough is added to the charge', async () => {
    const f = await seed()
    await setupTenantForPay(f, { connectReady: true })
    // Landlord pays the ACH processing fee → isolates the passthrough on top.
    await setFeePayer(f.aPropId, 'landlord', 'tenant')
    await db.query(
      `INSERT INTO platform_fee_accruals
         (landlord_id, property_id, accrual_month, rate_per_unit, min_per_property, total_amount, payer)
       VALUES ($1, $2, CURRENT_DATE, 2, 10, 20, 'tenant')`,
      [f.aLid, f.aPropId])
    const pid = await seedPayment({ unitId: f.aUnitId, tenantId: f.tenant1Id, landlordId: f.aLid, amount: 1000 })
    const res = await request(buildApp()).post(`/api/payments/${pid}/pay`)
      .set('Authorization', `Bearer ${f.tokenTenant1}`)
      .send({ paymentMethodId: 'pm_x', paymentMethodType: 'ach' })
    expect(res.status).toBe(200)
    // 1000 rent + 0 processing (landlord pays) + 20 passthrough = 1020
    expect((stripeConnect.createRentPlatformCharge as any).mock.calls[0][0].amount).toBe(1020)
  })

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

  it('S560: even a Connect-ready landlord → PLATFORM charge + held (no destination charge)', async () => {
    // Money-flow rebuild Phase 1: rent always lands on the platform balance and
    // is batched out on the weekly run — no destination charge, ever.
    const f = await seed()
    await setupTenantForPay(f, { connectReady: true })
    const pid = await seedPayment({ unitId: f.aUnitId, tenantId: f.tenant1Id, landlordId: f.aLid })
    const res = await request(buildApp()).post(`/api/payments/${pid}/pay`)
      .set('Authorization', `Bearer ${f.tokenTenant1}`)
      .send({ paymentMethodId: 'pm_x', paymentMethodType: 'ach' })
    expect(res.status).toBe(200)
    expect(stripeConnect.createRentPlatformCharge).toHaveBeenCalledTimes(1)
    expect(stripeConnect.createRentDestinationCharge).not.toHaveBeenCalled()
    expect(res.body.data.paymentIntentId).toBe('pi_plat_mock')
    const { rows: [p] } = await db.query<any>(
      `SELECT status, stripe_payment_intent_id, platform_held FROM payments WHERE id=$1`, [pid])
    expect(p.status).toBe('processing')
    expect(p.stripe_payment_intent_id).toBe('pi_plat_mock')
    expect(p.platform_held).toBe(true)
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

  it('card payment: status→processing (webhook settles + allocates, like ACH) — S560', async () => {
    // Pre-S560 this stamped 'settled' at charge time, which made the webhook's
    // settle path (gated on status != 'settled') skip allocation, supersedence,
    // Flex crediting, and PM/manager transfers for every card payment.
    const f = await seed()
    await setupTenantForPay(f, { connectReady: true })
    const pid = await seedPayment({ unitId: f.aUnitId, tenantId: f.tenant1Id, landlordId: f.aLid })
    const res = await request(buildApp()).post(`/api/payments/${pid}/pay`)
      .set('Authorization', `Bearer ${f.tokenTenant1}`)
      .send({ paymentMethodId: 'pm_x', paymentMethodType: 'card' })
    expect(res.status).toBe(200)
    const { rows: [p] } = await db.query<any>(
      `SELECT status FROM payments WHERE id=$1`, [pid])
    expect(p.status).toBe('processing')
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

// ─── POST /api/payments/:id/record-manual (S562) ──────────────
describe('POST /api/payments/:id/record-manual', () => {
  it('first rent payment → recorded settled (no disbursement), fee WAIVED', async () => {
    const f = await seed()
    const pid = await seedPayment({ unitId: f.aUnitId, tenantId: f.tenant1Id, landlordId: f.aLid, amount: 1000 })
    const res = await request(buildApp()).post(`/api/payments/${pid}/record-manual`)
      .set('Authorization', `Bearer ${f.tokenLandlordA}`)
      .send({ method: 'check', reference: 'CHK-1234' })
    expect(res.status).toBe(200)
    expect(res.body.data.feeWaived).toBe(true)
    expect(res.body.data.feeAmount).toBe(0)
    expect(res.body.data.feePaymentId).toBeNull()
    const { rows: [p] } = await db.query<any>(
      `SELECT status, manual_method, platform_held, stripe_payment_intent_id FROM payments WHERE id=$1`, [pid])
    expect(p.status).toBe('settled')            // paid everywhere that treats settled as paid
    expect(p.manual_method).toBe('check')
    expect(p.platform_held).toBe(false)         // ← batch skips it; landlord not double-paid
    expect(p.stripe_payment_intent_id).toBeNull()
    const { rows: fees } = await db.query<any>(
      `SELECT id FROM payments WHERE entry_description='MANUALPAY' AND tenant_id=$1`, [f.tenant1Id])
    expect(fees.length).toBe(0)
  })

  it('second rent payment → $10 MANUALPAY fee row created (GAM revenue)', async () => {
    const f = await seed()
    // prior satisfied rent = the tenant already made their first payment
    await seedPayment({ unitId: f.aUnitId, tenantId: f.tenant1Id, landlordId: f.aLid, amount: 1000, status: 'settled', dueOffsetMonths: 0 })
    const pid = await seedPayment({ unitId: f.aUnitId, tenantId: f.tenant1Id, landlordId: f.aLid, amount: 1000, dueOffsetMonths: 1 })
    const res = await request(buildApp()).post(`/api/payments/${pid}/record-manual`)
      .set('Authorization', `Bearer ${f.tokenLandlordA}`)
      .send({ method: 'cash' })
    expect(res.status).toBe(200)
    expect(res.body.data.feeWaived).toBe(false)
    expect(res.body.data.feeAmount).toBe(10)
    expect(res.body.data.feePaymentId).toBeTruthy()
    const { rows: [fee] } = await db.query<any>(
      `SELECT type, amount::float AS amount, status, entry_description FROM payments WHERE id=$1`,
      [res.body.data.feePaymentId])
    expect(fee.type).toBe('fee')
    expect(fee.amount).toBe(10)
    expect(fee.status).toBe('pending')
    expect(fee.entry_description).toBe('MANUALPAY')
  })

  // S607 (Nic) — the S570 21-day property-creation gate is GONE. It counted from
  // properties.created_at, so it burned down while the landlord was still setting
  // the park up and tenants inherited the remainder (four days, at Oak Park).
  // The free pass belongs to each TENANT'S first payment, on any property, at any
  // age. Nic: "the anchor is wrong."
  it('first manual payment is free however old the property is', async () => {
    const f = await seed()
    await db.query(`UPDATE properties SET created_at = NOW() - INTERVAL '400 days' WHERE id=$1`, [f.aPropId])
    const pid = await seedPayment({ unitId: f.aUnitId, tenantId: f.tenant1Id, landlordId: f.aLid, amount: 1000 })
    const res = await request(buildApp()).post(`/api/payments/${pid}/record-manual`)
      .set('Authorization', `Bearer ${f.tokenLandlordA}`)
      .send({ method: 'check' })
    expect(res.status).toBe(200)
    expect(res.body.data.feeWaived).toBe(true)
    expect(res.body.data.feePaymentId).toBeFalsy()
  })

  // Nic: "I like not gating it because I specifically have people at Oak Park
  // that come in on the fifth because of the grace period." Paying late does not
  // forfeit the free manual payment — late FEES are a separate charge on a
  // separate clock, and this fee is not one of them.
  it('paying well past the due date still gets the free first manual payment', async () => {
    const f = await seed()
    const pid = await seedPayment({ unitId: f.aUnitId, tenantId: f.tenant1Id, landlordId: f.aLid, amount: 1000 })
    await db.query(`UPDATE payments SET due_date = CURRENT_DATE - INTERVAL '10 days' WHERE id=$1`, [pid])
    const res = await request(buildApp()).post(`/api/payments/${pid}/record-manual`)
      .set('Authorization', `Bearer ${f.tokenLandlordA}`)
      .send({ method: 'money_order' })
    expect(res.status).toBe(200)
    expect(res.body.data.feeWaived).toBe(true)
  })

  // "If they pay card the first time, they lose that freebie." The waiver is the
  // first PAYMENT being manual, not the first MANUAL payment.
  it('a card payment first burns the freebie — a later manual payment is charged', async () => {
    const f = await seed()
    const paidByCard = await seedPayment({ unitId: f.aUnitId, tenantId: f.tenant1Id, landlordId: f.aLid, amount: 1000 })
    await db.query(`UPDATE payments SET status='settled', settled_at=NOW() WHERE id=$1`, [paidByCard])
    const pid = await seedPayment({ unitId: f.aUnitId, tenantId: f.tenant1Id, landlordId: f.aLid, amount: 1000 })
    const res = await request(buildApp()).post(`/api/payments/${pid}/record-manual`)
      .set('Authorization', `Bearer ${f.tokenLandlordA}`)
      .send({ method: 'cash' })
    expect(res.status).toBe(200)
    expect(res.body.data.feeWaived).toBe(false)
    expect(res.body.data.feeAmount).toBe(10)
  })

  it('non-rent charge → 409', async () => {
    const f = await seed()
    const pid = await seedPayment({ unitId: f.aUnitId, tenantId: f.tenant1Id, landlordId: f.aLid, type: 'utility', amount: 50 })
    const res = await request(buildApp()).post(`/api/payments/${pid}/record-manual`)
      .set('Authorization', `Bearer ${f.tokenLandlordA}`).send({ method: 'cash' })
    expect(res.status).toBe(409)
  })

  it('already-settled charge → 409', async () => {
    const f = await seed()
    const pid = await seedPayment({ unitId: f.aUnitId, tenantId: f.tenant1Id, landlordId: f.aLid, status: 'settled' })
    const res = await request(buildApp()).post(`/api/payments/${pid}/record-manual`)
      .set('Authorization', `Bearer ${f.tokenLandlordA}`).send({ method: 'cash' })
    expect(res.status).toBe(409)
  })

  it('different landlord cannot record on another landlord’s charge → 403', async () => {
    const f = await seed()
    const pid = await seedPayment({ unitId: f.aUnitId, tenantId: f.tenant1Id, landlordId: f.aLid })
    const res = await request(buildApp()).post(`/api/payments/${pid}/record-manual`)
      .set('Authorization', `Bearer ${f.tokenLandlordB}`).send({ method: 'cash' })
    expect(res.status).toBe(403)
  })

  it('eviction mode (payment_block) → 409', async () => {
    const f = await seed()
    const pid = await seedPayment({ unitId: f.aUnitId, tenantId: f.tenant1Id, landlordId: f.aLid })
    await db.query(`UPDATE units SET payment_block=TRUE WHERE id=$1`, [f.aUnitId])
    const res = await request(buildApp()).post(`/api/payments/${pid}/record-manual`)
      .set('Authorization', `Bearer ${f.tokenLandlordA}`).send({ method: 'cash' })
    expect(res.status).toBe(409)
    expect(res.body.message || res.body.error).toMatch(/eviction/i)
  })

  it('invalid method → 400', async () => {
    const f = await seed()
    const pid = await seedPayment({ unitId: f.aUnitId, tenantId: f.tenant1Id, landlordId: f.aLid })
    const res = await request(buildApp()).post(`/api/payments/${pid}/record-manual`)
      .set('Authorization', `Bearer ${f.tokenLandlordA}`).send({ method: 'venmo' })
    expect(res.status).toBe(400)
  })
})

// ─── POST /api/payments/:id/record-prior-arrangement (S568) ──────────────
// Onboarding reconciliation: FIRST rent charge of a lease, while the LANDLORD is
// still inside their reconciliation window, paid off-platform (old-system autopay
// overlap). Fee-free, one-time. New-vs-imported lease is irrelevant.
describe('POST /api/payments/:id/record-prior-arrangement', () => {
  // Set the landlord's reconciliation window open/closed, and insert a
  // lease-linked rent payment on the fixture's lease.
  async function seedLeaseRent(f: any, opts: { windowOpen?: boolean } = {}) {
    await db.query(
      `UPDATE landlords SET reconciliation_until = NOW() + ($2::int) * INTERVAL '1 day' WHERE id = $1`,
      [f.aLid, opts.windowOpen === false ? -1 : 10])
    const { rows: [{ id }] } = await db.query<{ id: string }>(
      `INSERT INTO payments (unit_id, tenant_id, landlord_id, lease_id, type, amount, status, entry_description, due_date)
       VALUES ($1,$2,$3,$4,'rent',1000,'pending','RENT',CURRENT_DATE) RETURNING id`,
      [f.aUnitId, f.tenant1Id, f.aLid, f.lease1Id])
    return id
  }

  it('first rent while reconciliation window open → settled off-platform, NO fee', async () => {
    const f = await seed()
    const pid = await seedLeaseRent(f, { windowOpen: true })
    const res = await request(buildApp()).post(`/api/payments/${pid}/record-prior-arrangement`)
      .set('Authorization', `Bearer ${f.tokenLandlordA}`).send({})
    expect(res.status).toBe(200)
    expect(res.body.data.feeCharged).toBe(false)
    const { rows: [p] } = await db.query<any>(
      `SELECT status, manual_method, platform_held FROM payments WHERE id=$1`, [pid])
    expect(p.status).toBe('settled')
    expect(p.manual_method).toBe('prior_arrangement')
    expect(p.platform_held).toBe(false)
    const { rows: fees } = await db.query<any>(
      `SELECT id FROM payments WHERE type='fee' AND tenant_id=$1`, [f.tenant1Id])
    expect(fees.length).toBe(0)   // never a fee
  })

  it('works regardless of lease_source (new e-signed lease still eligible)', async () => {
    const f = await seed()
    await db.query(`UPDATE leases SET lease_source='esigned' WHERE id=$1`, [f.lease1Id])
    const pid = await seedLeaseRent(f, { windowOpen: true })
    const res = await request(buildApp()).post(`/api/payments/${pid}/record-prior-arrangement`)
      .set('Authorization', `Bearer ${f.tokenLandlordA}`).send({})
    expect(res.status).toBe(200)
  })

  it('landlord reconciliation window closed → 409', async () => {
    const f = await seed()
    const pid = await seedLeaseRent(f, { windowOpen: false })
    const res = await request(buildApp()).post(`/api/payments/${pid}/record-prior-arrangement`)
      .set('Authorization', `Bearer ${f.tokenLandlordA}`).send({})
    expect(res.status).toBe(409)
    expect(res.body.message || res.body.error).toMatch(/reconciliation window has closed/i)
  })

  it('not the first rent (a later rent already paid) → 409', async () => {
    const f = await seed()
    await db.query(
      `INSERT INTO payments (unit_id, tenant_id, landlord_id, lease_id, type, amount, status, entry_description, due_date, settled_at)
       VALUES ($1,$2,$3,$4,'rent',1000,'settled','RENT',CURRENT_DATE - INTERVAL '1 month', NOW())`,
      [f.aUnitId, f.tenant1Id, f.aLid, f.lease1Id])
    const pid = await seedLeaseRent(f, { windowOpen: true })
    const res = await request(buildApp()).post(`/api/payments/${pid}/record-prior-arrangement`)
      .set('Authorization', `Bearer ${f.tokenLandlordA}`).send({})
    expect(res.status).toBe(409)
    expect(res.body.message || res.body.error).toMatch(/first rent/i)
  })

  it('GET /payments exposes priorArrangementEligible on the eligible first rent', async () => {
    const f = await seed()
    const pid = await seedLeaseRent(f, { windowOpen: true })
    const res = await request(buildApp()).get('/api/payments')
      .set('Authorization', `Bearer ${f.tokenLandlordA}`)
    expect(res.status).toBe(200)
    // buildApp() here does NOT mount the global camel-case middleware (that's on
    // the real app in index.ts), so the key is snake_case in this test. In prod
    // the response is camelized → priorArrangementEligible, which the UI reads.
    const row = res.body.data.find((r: any) => r.id === pid)
    expect(row.prior_arrangement_eligible).toBe(true)
  })
})

// S607 (Nic): the landlord may elect to absorb the manual-payment fee at the
// property. "If they aren't covering it, it's still charged out of their collect
// account, but the tenant gets invoiced. So the landlord isn't out any money."
describe('POST /payments/:id/record-manual — landlord covers the manual fee', () => {
  it('raises no tenant charge when the property has the landlord covering', async () => {
    const f = await seed()
    await db.query(
      `INSERT INTO property_allocation_rules (property_id, ach_fee_payer, card_fee_payer, manual_fee_payer)
       VALUES ($1,'tenant','tenant','landlord')
       ON CONFLICT (property_id) DO UPDATE SET manual_fee_payer='landlord'`, [f.aPropId])
    // Burn the free first payment so the waiver cannot be what we are observing.
    const first = await seedPayment({ unitId: f.aUnitId, tenantId: f.tenant1Id, landlordId: f.aLid, amount: 1000 })
    await db.query(`UPDATE payments SET status='settled', settled_at=NOW() WHERE id=$1`, [first])

    const pid = await seedPayment({ unitId: f.aUnitId, tenantId: f.tenant1Id, landlordId: f.aLid, amount: 1000 })
    const res = await request(buildApp()).post(`/api/payments/${pid}/record-manual`)
      .set('Authorization', `Bearer ${f.tokenLandlordA}`)
      .send({ method: 'cash' })
    expect(res.status).toBe(200)
    expect(res.body.data.coveredByLandlord).toBe(true)
    expect(res.body.data.firstPayment).toBe(false)   // NOT the free-first reason
    expect(res.body.data.feeBilledTo).toBe('landlord')
    expect(res.body.data.feePaymentId).toBeFalsy()

    // No TENANT charge...
    const fees = await db.query(
      `SELECT id FROM payments WHERE entry_description='MANUALPAY' AND tenant_id=$1`, [f.tenant1Id])
    expect(fees.rows).toHaveLength(0)

    // ...but GAM is still paid. Nic: "if they use cash the second month and the
    // landlord covers, that means the LANDLORD gets charged."
    const rev = await db.query<{ amount: string }>(
      `SELECT amount::text FROM platform_revenue_ledger
        WHERE reference_type='manual_payment_fee'`)
    expect(rev.rows).toHaveLength(1)
    expect(Number(rev.rows[0].amount)).toBeCloseTo(10, 2)
  })

  it('defaults to billing the tenant when the property says nothing', async () => {
    const f = await seed()
    const first = await seedPayment({ unitId: f.aUnitId, tenantId: f.tenant1Id, landlordId: f.aLid, amount: 1000 })
    await db.query(`UPDATE payments SET status='settled', settled_at=NOW() WHERE id=$1`, [first])

    const pid = await seedPayment({ unitId: f.aUnitId, tenantId: f.tenant1Id, landlordId: f.aLid, amount: 1000 })
    const res = await request(buildApp()).post(`/api/payments/${pid}/record-manual`)
      .set('Authorization', `Bearer ${f.tokenLandlordA}`)
      .send({ method: 'check' })
    expect(res.status).toBe(200)
    expect(res.body.data.coveredByLandlord).toBe(false)
    expect(res.body.data.feeAmount).toBe(10)
    expect(res.body.data.feePaymentId).toBeTruthy()
  })

  // The two reasons must stay distinguishable: one expires, the other does not.
  it('reports first-payment and landlord-covered as separate reasons', async () => {
    const f = await seed()
    const pid = await seedPayment({ unitId: f.aUnitId, tenantId: f.tenant1Id, landlordId: f.aLid, amount: 1000 })
    const res = await request(buildApp()).post(`/api/payments/${pid}/record-manual`)
      .set('Authorization', `Bearer ${f.tokenLandlordA}`)
      .send({ method: 'cash' })
    expect(res.body.data.firstPayment).toBe(true)
    expect(res.body.data.coveredByLandlord).toBe(false)
  })
})

// S607 (Nic): the invoice shows every avenue and its price. "Here's your $450
// rent. ACH makes that $456. $450 with a debit card is $466.30. $450 with cash
// is $460. That way they see all the avenues and the price at the point the
// invoice comes out."
describe('GET /payments/balance-context — per-method price breakdown', () => {
  it('prices bank, card and cash for the outstanding balance', async () => {
    const f = await seed()
    // Burn the free first payment so the cash row reflects the real $10.
    const prior = await seedPayment({ unitId: f.aUnitId, tenantId: f.tenant1Id, landlordId: f.aLid, amount: 450 })
    await db.query(`UPDATE payments SET status='settled', settled_at=NOW() WHERE id=$1`, [prior])
    await seedPayment({ unitId: f.aUnitId, tenantId: f.tenant1Id, landlordId: f.aLid, amount: 450 })

    const res = await request(buildApp()).get('/api/payments/balance-context')
      .set('Authorization', `Bearer ${f.tokenTenant1}`)
    expect(res.status).toBe(200)
    const lease = res.body.data.leases[0]
    const by = Object.fromEntries(lease.methodCosts.map((m: any) => [m.method, m]))
    expect(by.ach.total).toBeCloseTo(456, 2)
    expect(by.card.total).toBeCloseTo(466.30, 2)
    expect(by.manual.total).toBeCloseTo(460, 2)
  })

  it('shows cash at no extra cost while the first payment is still free', async () => {
    const f = await seed()
    await seedPayment({ unitId: f.aUnitId, tenantId: f.tenant1Id, landlordId: f.aLid, amount: 450 })

    const res = await request(buildApp()).get('/api/payments/balance-context')
      .set('Authorization', `Bearer ${f.tokenTenant1}`)
    const lease = res.body.data.leases[0]
    const manual = lease.methodCosts.find((m: any) => m.method === 'manual')
    expect(lease.manualFeeFirstFree).toBe(true)
    expect(manual.fee).toBe(0)
    expect(manual.total).toBeCloseTo(450, 2)
  })

  // Nic: the tenant must see the landlord is ACTIVELY covering it, "and that
  // they may choose to stop covering that at any time" — so a later $10 on their
  // bill is recognisable as a change of policy, not a new surprise charge.
  it('reports the landlord covering it, with the amount being absorbed', async () => {
    const f = await seed()
    await db.query(
      `INSERT INTO property_allocation_rules (property_id, ach_fee_payer, card_fee_payer, manual_fee_payer)
       VALUES ($1,'tenant','tenant','landlord')
       ON CONFLICT (property_id) DO UPDATE SET manual_fee_payer='landlord'`, [f.aPropId])
    const prior = await seedPayment({ unitId: f.aUnitId, tenantId: f.tenant1Id, landlordId: f.aLid, amount: 450 })
    await db.query(`UPDATE payments SET status='settled', settled_at=NOW() WHERE id=$1`, [prior])
    await seedPayment({ unitId: f.aUnitId, tenantId: f.tenant1Id, landlordId: f.aLid, amount: 450 })

    const res = await request(buildApp()).get('/api/payments/balance-context')
      .set('Authorization', `Bearer ${f.tokenTenant1}`)
    const lease = res.body.data.leases[0]
    expect(lease.manualFeeCoveredByLandlord).toBe(true)
    expect(lease.manualFeeAbsorbed).toBeCloseTo(10, 2)
    const manual = lease.methodCosts.find((m: any) => m.method === 'manual')
    expect(manual.total).toBeCloseTo(450, 2)   // $450, not $460
  })
})

// S607 (Nic): "it's free for the landlord the first time, and that first time is
// used up. The tenant doesn't get to assume a first time freebie if the landlord
// stops covering it. That's used up on the first cash payment no matter who's
// covering."
describe('POST /payments/:id/record-manual — the free first payment is spent once', () => {
  it('a landlord-covered first payment consumes the freebie for good', async () => {
    const f = await seed()
    await db.query(
      `INSERT INTO property_allocation_rules (property_id, ach_fee_payer, card_fee_payer, manual_fee_payer)
       VALUES ($1,'tenant','tenant','landlord')
       ON CONFLICT (property_id) DO UPDATE SET manual_fee_payer='landlord'`, [f.aPropId])

    // 1st manual payment — landlord covering, and it is also the tenant's first.
    // Nobody is charged, and the rent settles, which is what spends the freebie.
    const p1 = await seedPayment({ unitId: f.aUnitId, tenantId: f.tenant1Id, landlordId: f.aLid, amount: 1000 })
    const r1 = await request(buildApp()).post(`/api/payments/${p1}/record-manual`)
      .set('Authorization', `Bearer ${f.tokenLandlordA}`).send({ method: 'cash' })
    expect(r1.body.data.firstPayment).toBe(true)
    expect(r1.body.data.feePaymentId).toBeFalsy()

    // The landlord stops covering.
    await db.query(`UPDATE property_allocation_rules SET manual_fee_payer='tenant' WHERE property_id=$1`, [f.aPropId])

    // 2nd manual payment — the tenant cannot claim an unused freebie.
    const p2 = await seedPayment({ unitId: f.aUnitId, tenantId: f.tenant1Id, landlordId: f.aLid, amount: 1000 })
    const r2 = await request(buildApp()).post(`/api/payments/${p2}/record-manual`)
      .set('Authorization', `Bearer ${f.tokenLandlordA}`).send({ method: 'cash' })
    expect(r2.body.data.firstPayment).toBe(false)
    expect(r2.body.data.coveredByLandlord).toBe(false)
    expect(r2.body.data.feeAmount).toBe(10)
    expect(r2.body.data.feePaymentId).toBeTruthy()
  })

  it('the tenant quote agrees — no free-first once it has been spent', async () => {
    const f = await seed()
    const p1 = await seedPayment({ unitId: f.aUnitId, tenantId: f.tenant1Id, landlordId: f.aLid, amount: 450 })
    await request(buildApp()).post(`/api/payments/${p1}/record-manual`)
      .set('Authorization', `Bearer ${f.tokenLandlordA}`).send({ method: 'cash' })

    await seedPayment({ unitId: f.aUnitId, tenantId: f.tenant1Id, landlordId: f.aLid, amount: 450 })
    const res = await request(buildApp()).get('/api/payments/balance-context')
      .set('Authorization', `Bearer ${f.tokenTenant1}`)
    const lease = res.body.data.leases[0]
    expect(lease.manualFeeFirstFree).toBe(false)
    expect(lease.methodCosts.find((m: any) => m.method === 'manual').total).toBeCloseTo(460, 2)
  })
})

// S607 (Nic): "it's only free the first payment and only if they do cash."
// The landlord's toggle MOVES the fee, it does not erase it.
describe('POST /payments/:id/record-manual — landlord-covered fee still reaches GAM', () => {
  const coverProperty = (propId: string) => db.query(
    `INSERT INTO property_allocation_rules (property_id, ach_fee_payer, card_fee_payer, manual_fee_payer)
     VALUES ($1,'tenant','tenant','landlord')
     ON CONFLICT (property_id) DO UPDATE SET manual_fee_payer='landlord'`, [propId])

  it('a covered FIRST cash payment charges nobody — that one really is free', async () => {
    const f = await seed()
    await coverProperty(f.aPropId)
    const pid = await seedPayment({ unitId: f.aUnitId, tenantId: f.tenant1Id, landlordId: f.aLid, amount: 1000 })
    const res = await request(buildApp()).post(`/api/payments/${pid}/record-manual`)
      .set('Authorization', `Bearer ${f.tokenLandlordA}`).send({ method: 'cash' })
    expect(res.body.data.feeBilledTo).toBe('none')
    const rev = await db.query(`SELECT id FROM platform_revenue_ledger WHERE reference_type='manual_payment_fee'`)
    expect(rev.rows).toHaveLength(0)
  })

  it('a card first payment leaves nothing to cover, and burns the freebie', async () => {
    const f = await seed()
    await coverProperty(f.aPropId)
    // First rent settled by card — no manual fee arises at all.
    const byCard = await seedPayment({ unitId: f.aUnitId, tenantId: f.tenant1Id, landlordId: f.aLid, amount: 1000 })
    await db.query(`UPDATE payments SET status='settled', settled_at=NOW() WHERE id=$1`, [byCard])
    // Second month, cash, landlord covering → the LANDLORD is charged.
    const pid = await seedPayment({ unitId: f.aUnitId, tenantId: f.tenant1Id, landlordId: f.aLid, amount: 1000 })
    const res = await request(buildApp()).post(`/api/payments/${pid}/record-manual`)
      .set('Authorization', `Bearer ${f.tokenLandlordA}`).send({ method: 'cash' })
    expect(res.body.data.feeBilledTo).toBe('landlord')
    const rev = await db.query<{ amount: string }>(
      `SELECT amount::text FROM platform_revenue_ledger WHERE reference_type='manual_payment_fee'`)
    expect(rev.rows).toHaveLength(1)
    expect(Number(rev.rows[0].amount)).toBeCloseTo(10, 2)
  })

  it('re-recording the same payment cannot post the fee twice', async () => {
    const f = await seed()
    await coverProperty(f.aPropId)
    const prior = await seedPayment({ unitId: f.aUnitId, tenantId: f.tenant1Id, landlordId: f.aLid, amount: 1000 })
    await db.query(`UPDATE payments SET status='settled', settled_at=NOW() WHERE id=$1`, [prior])
    const pid = await seedPayment({ unitId: f.aUnitId, tenantId: f.tenant1Id, landlordId: f.aLid, amount: 1000 })
    await request(buildApp()).post(`/api/payments/${pid}/record-manual`)
      .set('Authorization', `Bearer ${f.tokenLandlordA}`).send({ method: 'cash' })
    // Second attempt 409s (already settled), and must not double-post revenue.
    await request(buildApp()).post(`/api/payments/${pid}/record-manual`)
      .set('Authorization', `Bearer ${f.tokenLandlordA}`).send({ method: 'cash' })
    const rev = await db.query(`SELECT id FROM platform_revenue_ledger WHERE reference_type='manual_payment_fee'`)
    expect(rev.rows).toHaveLength(1)
  })
})

// S607 (Nic): "If the landlord is covering the ten dollars, it needs to be
// visible to them so they can track it. If the landlord is not covering the ten
// dollars, it doesn't need to be visible to them."
describe('GET /payments/absorbed-manual-fees', () => {
  const coverProperty = (propId: string) => db.query(
    `INSERT INTO property_allocation_rules (property_id, ach_fee_payer, card_fee_payer, manual_fee_payer)
     VALUES ($1,'tenant','tenant','landlord')
     ON CONFLICT (property_id) DO UPDATE SET manual_fee_payer='landlord'`, [propId])

  /** Settle one prior rent (burning the freebie), then record a manual payment. */
  async function absorbOne(f: any) {
    const prior = await seedPayment({ unitId: f.aUnitId, tenantId: f.tenant1Id, landlordId: f.aLid, amount: 1000 })
    await db.query(`UPDATE payments SET status='settled', settled_at=NOW() WHERE id=$1`, [prior])
    const pid = await seedPayment({ unitId: f.aUnitId, tenantId: f.tenant1Id, landlordId: f.aLid, amount: 1000 })
    await request(buildApp()).post(`/api/payments/${pid}/record-manual`)
      .set('Authorization', `Bearer ${f.tokenLandlordA}`).send({ method: 'cash' })
  }

  it('shows the landlord what they absorbed, with the property and unit', async () => {
    const f = await seed()
    await coverProperty(f.aPropId)
    await absorbOne(f)

    const res = await request(buildApp()).get('/api/payments/absorbed-manual-fees')
      .set('Authorization', `Bearer ${f.tokenLandlordA}`)
    expect(res.status).toBe(200)
    expect(res.body.data.total).toBeCloseTo(10, 2)
    expect(res.body.data.count).toBe(1)
    // NOTE: buildApp() mounts the router WITHOUT index.ts's camelize middleware,
    // so DB-derived columns arrive snake_case here. In production the response is
    // camelized (unitNumber / propertyName) — which is what the UI reads, and
    // what wireContract.test.ts enforces.
    expect(res.body.data.rows[0].unit_number).toBeTruthy()
    expect(res.body.data.rows[0].property_name).toBeTruthy()
  })

  it('shows nothing when the tenant is the one reimbursing it', async () => {
    const f = await seed()
    // manual_fee_payer defaults to 'tenant' — no allocation rule needed.
    await absorbOne(f)

    const res = await request(buildApp()).get('/api/payments/absorbed-manual-fees')
      .set('Authorization', `Bearer ${f.tokenLandlordA}`)
    expect(res.status).toBe(200)
    expect(res.body.data.total).toBe(0)
    expect(res.body.data.rows).toHaveLength(0)
  })

  it('never leaks another landlord\'s absorbed fees', async () => {
    const f = await seed()
    await coverProperty(f.aPropId)
    await absorbOne(f)

    const res = await request(buildApp()).get('/api/payments/absorbed-manual-fees')
      .set('Authorization', `Bearer ${f.tokenLandlordB}`)
    expect(res.status).toBe(200)
    expect(res.body.data.rows).toHaveLength(0)
  })

  it('refuses a caller with no landlord scope', async () => {
    const f = await seed()
    const res = await request(buildApp()).get('/api/payments/absorbed-manual-fees')
      .set('Authorization', `Bearer ${f.tokenTenant1}`)
    expect(res.status).toBe(403)
  })
})

// S607 (Nic): "we need to make sure that all the toggles are scoped per property,
// not actually able to be changed per tenant. You can't have a tenant getting the
// ten dollar fee covered by a landlord and another tenant not getting the fee
// covered. It needs to be scoped to prevent discrimination."
//
// This is guaranteed by the SHAPE of the data — the fee settings live in a single
// row per property (property_allocation_rules, primary key property_id) and there
// is no lease-level or tenant-level column anywhere to override them. These tests
// hold that guarantee in place, because a future "just this one tenant" column
// would break them rather than shipping quietly.
describe('fee settings are per-property and cannot single out a tenant', () => {
  it('two tenants in the same property are quoted identically', async () => {
    const f = await seed()
    await db.query(
      `INSERT INTO property_allocation_rules (property_id, ach_fee_payer, card_fee_payer, manual_fee_payer)
       VALUES ($1,'tenant','tenant','landlord')
       ON CONFLICT (property_id) DO UPDATE SET manual_fee_payer='landlord'`, [f.aPropId])

    // A SECOND tenant, in a second unit, at the SAME property.
    const c = await db.connect()
    let tenant2Id = '', tenant2UserId = '', unit2Id = ''
    try {
      await c.query('BEGIN')
      unit2Id = await seedUnit(c, { propertyId: f.aPropId, landlordId: f.aLid })
      tenant2Id = await seedTenant(c)
      const r = await c.query<{ user_id: string }>(`SELECT user_id FROM tenants WHERE id=$1`, [tenant2Id])
      tenant2UserId = r.rows[0].user_id
      const lease2 = await seedLease(c, { unitId: unit2Id, landlordId: f.aLid })
      await seedLeaseTenant(c, { leaseId: lease2, tenantId: tenant2Id, role: 'primary' })
      await c.query('COMMIT')
    } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
    const tokenTenant2 = sign({ userId: tenant2UserId, role: 'tenant', email: 't2@t.dev', profileId: tenant2Id })

    await seedPayment({ unitId: f.aUnitId, tenantId: f.tenant1Id, landlordId: f.aLid, amount: 450 })
    await seedPayment({ unitId: unit2Id,   tenantId: tenant2Id,   landlordId: f.aLid, amount: 450 })

    const one = await request(buildApp()).get('/api/payments/balance-context')
      .set('Authorization', `Bearer ${f.tokenTenant1}`)
    const two = await request(buildApp()).get('/api/payments/balance-context')
      .set('Authorization', `Bearer ${tokenTenant2}`)

    expect(one.body.data.leases[0].manualFeeCoveredByLandlord)
      .toBe(two.body.data.leases[0].manualFeeCoveredByLandlord)
    expect(one.body.data.leases[0].manualFeeCoveredByLandlord).toBe(true)
  })

  it('there is nowhere to store a per-tenant or per-lease fee setting', async () => {
    const cols = await db.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.columns
        WHERE column_name IN ('manual_fee_payer','ach_fee_payer','card_fee_payer','platform_fee_payer')`)
    const tables = [...new Set(cols.rows.map(r => r.table_name))]
    // Exactly one home, and it is keyed by property.
    expect(tables).toEqual(['property_allocation_rules'])

    const pk = await db.query<{ column_name: string }>(
      `SELECT kcu.column_name
         FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage kcu
           ON kcu.constraint_name = tc.constraint_name
        WHERE tc.table_name = 'property_allocation_rules' AND tc.constraint_type = 'PRIMARY KEY'`)
    expect(pk.rows.map(r => r.column_name)).toEqual(['property_id'])
  })
})
