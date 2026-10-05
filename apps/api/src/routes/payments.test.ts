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

import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from 'vitest'

vi.mock('../services/supersedence', () => ({
  computeTenantGamOutstandingTotal: vi.fn(async () => 0),
}))

vi.mock('../services/adminNotifications', () => ({
  createAdminNotification: vi.fn(async () => undefined),
}))

vi.mock('../services/stripeConnect', async () => {
  const computePlatformCut = vi.fn(() => 5.00)
  const createRentDestinationCharge = vi.fn(async () => ({
    id: 'pi_dest_mock', status: 'processing',
  }))
  const createRentPlatformCharge = vi.fn(async () => ({
    id: 'pi_plat_mock', status: 'processing',
  }))
  return {
    computePlatformCut,
    createRentDestinationCharge,
    createRentPlatformCharge,
  }
})

const { paymentIntentsCancelMock, paymentIntentsRetrieveMock } = vi.hoisted(() => ({
  paymentIntentsCancelMock: vi.fn(async (id: string) => ({ id, status: 'canceled' })),
  // decisions.md #48.4: what Stripe says a charge is now (default: on its way).
  paymentIntentsRetrieveMock: vi.fn(async (id: string): Promise<any> => ({ id, status: 'processing' })),
}))
vi.mock('../lib/stripe', () => {
  const paymentMethodsRetrieve = vi.fn(async () => ({
    id: 'pm_x',
    card: { brand: 'visa', last4: '1111', country: 'US' },
  }))
  return {
    getStripe: () => ({ paymentMethods: { retrieve: paymentMethodsRetrieve },
      paymentIntents: { cancel: paymentIntentsCancelMock, retrieve: paymentIntentsRetrieveMock } }),
    createTenantAchSetup: vi.fn(),
  }
})

import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { randomUUID } from 'crypto'
import { db } from '../db'
// S624: assert the FEE, not a figure — bind to the constant so a repricing never
// leaves a stale literal behind. Same rule the fee-label copy follows
// (PROCESSING_FEES → derived labels).
import { PROCESSING_FEES, processingFeeFor } from '@gam/shared'
import {
  cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedTenant,
  seedLease, seedLeaseTenant, seedUserBankAccount,
} from '../test/dbHelpers'
import { resolveTargetLease } from '../services/rentCharge'
import { paymentsRouter } from './payments'
import { errorHandler } from '../middleware/errorHandler'
import * as stripeConnect from '../services/stripeConnect'
import { createAdminNotification } from '../services/adminNotifications'
import { camelCaseKeys } from '../lib/caseConversion'
import fs from 'fs'
import path from 'path'

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
  ;(stripeConnect.computePlatformCut as ReturnType<typeof vi.fn>).mockClear()
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

/**
 * A staff member of landlord A with a property scope row (S655: the payments
 * list follows getScopedPropertyIds, as the balances list does).
 */
async function staffToken(
  f: Fixture,
  role: 'property_manager' | 'onsite_manager',
  o: { propertyIds?: string[]; all?: boolean; perms: Record<string, boolean> },
): Promise<string> {
  const { rows: [u] } = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
     VALUES ($1,'x',$2,'Staff','Member',TRUE) RETURNING id`, [`staff-${randomUUID()}@t.dev`, role])
  const table = role === 'property_manager' ? 'property_manager_scopes' : 'onsite_manager_scopes'
  await db.query(
    `INSERT INTO ${table} (user_id, landlord_id, property_ids, all_properties, permissions)
     VALUES ($1,$2,$3,$4,$5::jsonb)`,
    [u.id, f.aLid, o.propertyIds ?? [], o.all === true, JSON.stringify(o.perms)])
  return sign({ userId: u.id, role, email: 'staff@t.dev', profileId: null, landlordId: f.aLid, permissions: o.perms })
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
  leaseId?: string | null
}): Promise<string> {
  const offset = opts.dueOffsetMonths ?? (__seedPaymentCounter++)
  const { rows: [{ id }] } = await db.query<{ id: string }>(
    `INSERT INTO payments
       (unit_id, tenant_id, landlord_id, type, amount, status,
        entry_description, due_date, lease_id)
     VALUES ($1,$2,$3,$4,$5,$6,'RENT',CURRENT_DATE + ($7 || ' months')::interval, $8)
     RETURNING id`,
    [opts.unitId, opts.tenantId, opts.landlordId,
     opts.type ?? 'rent', opts.amount ?? 1000, opts.status ?? 'pending', offset, opts.leaseId ?? null])
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
    // S655: what a staffer sees follows their property scope; this one has every property.
    const teamWithPerm = await staffToken(f, 'property_manager', { all: true, perms: { 'payments.view_all': true } })
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
  // A return reopens every row its debit paid: one payment_reversals record per
  // row. Contract step C0 drops the old UNIQUE(stripe_event_id) that allowed only
  // one; it is dropped for this block only and put back after only if it was
  // there (as paymentReversal.test.ts does), so later suites see the schema this
  // block found — before C0 on a plain run, after C0 on the final run.
  let hadOldConstraint = false
  beforeAll(async () => {
    hadOldConstraint = (await db.query(
      `SELECT 1 FROM pg_constraint WHERE conname = 'payment_reversals_stripe_event_id_key'`)).rowCount === 1
    await db.query(`ALTER TABLE payment_reversals DROP CONSTRAINT IF EXISTS payment_reversals_stripe_event_id_key`)
  })
  afterAll(async () => {
    if (!hadOldConstraint) return
    await cleanupAllSchema()
    await db.query(`ALTER TABLE payment_reversals ADD CONSTRAINT payment_reversals_stripe_event_id_key UNIQUE (stripe_event_id)`)
  })

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

  // Fix pass (Step 8): a settled bank debit the bank sent back. Its rent and
  // utility settled on one ACH debit; the return reopens both through
  // paymentReversal (money plan §3 two-row model).
  async function seedSettledDebit(f: Fixture, pi: string, opts: { method?: 'ach' | 'card'; manual?: string | null } = {}) {
    const rent = await seedPayment({ unitId: f.aUnitId, tenantId: f.tenant1Id, landlordId: f.aLid, leaseId: f.lease1Id,
                                     amount: 1000, dueOffsetMonths: -1 })
    const util = await seedPayment({ unitId: f.aUnitId, tenantId: f.tenant1Id, landlordId: f.aLid, leaseId: f.lease1Id,
                                     type: 'utility', amount: 50, dueOffsetMonths: -1 })
    const { rows: [rem] } = await db.query<{ id: string }>(
      `INSERT INTO tenant_remittances (tenant_id, lease_id, landlord_id, amount, applied_amount, unapplied_amount,
                                       payment_method, stripe_payment_intent_id, status, gross_amount, processing_fee_amount)
       VALUES ($1,$2,$3,1050,1050,0,$4,$5,'settled',1056,6) RETURNING id`,
      [f.tenant1Id, f.lease1Id, f.aLid, opts.method ?? 'ach', pi])
    for (const [id, amt] of [[rent, 1000], [util, 50]] as const) {
      await db.query(`INSERT INTO remittance_applications (remittance_id, payment_id, amount_applied) VALUES ($1,$2,$3)`, [rem.id, id, amt])
    }
    await db.query(
      `UPDATE payments SET status='settled', settled_at=NOW(), platform_held=TRUE, stripe_payment_intent_id=$2,
              manual_method=$3
        WHERE id = ANY($1::uuid[])`, [[rent, util], pi, opts.manual ?? null])
    return { rent, util, remittanceId: rem.id }
  }
  const owedOnce = async (f: Fixture) => {
    const { listOpenTenantBalances } = await import('../services/openBalances')
    const { getMyPayments } = await import('../services/agents/tools/getMyPayments')
    const list = await listOpenTenantBalances({ landlordIds: [f.aLid] })
    const outstanding = list.reduce((s, r) => s + Number(r.balance), 0)
    const agent: any = await getMyPayments.execute({}, { userId: f.tenant1UserId, role: 'tenant', profileId: f.tenant1Id, landlordIds: [] } as any)
    return { list, outstanding, agent: agent.outstandingBalance as number }
  }

  it('a return on a settled bank debit reopens every row it paid, owed exactly once on Outstanding and in get_my_payment_status', async () => {
    const f = await seed()
    const d = await seedSettledDebit(f, 'pi_ret_settled')
    const res = await request(buildApp()).post(`/api/payments/${d.rent}/handle-return`)
      .set('Authorization', `Bearer ${f.tokenAdmin}`)
      .send({ returnCode: 'R01', returnFee: 4 })
    expect(res.status).toBe(200)
    expect(res.body.data.outcome).toBe('reopened')
    expect(res.body.data.zeroTolerance).toBe(false)
    expect(res.body.data.owedAgain).toBe(1050)
    expect(res.body.data.reopened).toHaveLength(2)
    // The originals are 'returned' with the bank's code; nothing is owed on them.
    const { rows: orig } = await db.query<any>(
      `SELECT status, return_code, zero_tolerance_flag FROM payments WHERE id = ANY($1::uuid[]) ORDER BY amount`, [[d.rent, d.util]])
    expect(orig).toEqual([
      { status: 'returned', return_code: 'R01', zero_tolerance_flag: false },
      { status: 'returned', return_code: 'R01', zero_tolerance_flag: false },
    ])
    // A fresh owed row per original, at its money part.
    const { rows: fresh } = await db.query<any>(
      `SELECT p.type, p.amount::float AS amount, p.status FROM payments p
         JOIN payment_reversals pr ON pr.id = p.reversal_id
        WHERE pr.stripe_event_id = 'manual_return:pi_ret_settled' ORDER BY p.amount`)
    expect(fresh).toEqual([
      { type: 'utility', amount: 50, status: 'pending' },
      { type: 'rent', amount: 1000, status: 'pending' },
    ])
    const { rows: rv } = await db.query<any>(
      `SELECT reversal_type FROM payment_reversals WHERE stripe_event_id = 'manual_return:pi_ret_settled'`)
    expect(rv.every((r: any) => r.reversal_type === 'ach_return')).toBe(true)
    // Owed once: the reopened $1,050 plus the $4 return fee passed to the
    // tenant at cost — never the originals as well.
    const { rows: [fee] } = await db.query<{ amt: string | null }>(
      `SELECT SUM(amount)::text AS amt FROM payments
        WHERE tenant_id = $1 AND status = 'pending' AND reversal_id IS NULL AND id <> ALL($2::uuid[])`,
      [f.tenant1Id, [d.rent, d.util]])
    const feeOwed = Number(fee.amt ?? 0)
    expect(feeOwed).toBe(4)
    const o = await owedOnce(f)
    expect(o.agent).toBeCloseTo(1054, 2)
    expect(o.list).toHaveLength(1)
    expect(o.outstanding).toBeCloseTo(1054, 2)
    // NACHA log, and no bank-payment block for a retryable code.
    const { rows: logs } = await db.query<any>(`SELECT event_type, amount::float AS amount FROM ach_monitoring_log WHERE payment_id=$1`, [d.rent])
    // The whole debit the bank pulled ($1,050 of charges + the $6 fee on top), not the pressed row's $1,000.
    expect(logs).toEqual([{ event_type: 'return_received', amount: 1056 }])
    const { rows: [t] } = await db.query<any>(`SELECT ach_suspended_at FROM tenants WHERE id=$1`, [f.tenant1Id])
    expect(t.ach_suspended_at).toBeNull()
  })

  // Fix pass (rev8): the same as the dispute webhook (webhooks.ts) — a bank
  // return of a move-out balance charge recorded here marks the move-out as
  // not collected, so the owner's move-out page says it is owed again.
  it('a bank return recorded by hand on a move-out balance charge marks the move-out as came back unpaid, as the webhook does', async () => {
    const f = await seed()
    const d = await seedSettledDebit(f, 'pi_ret_gap')
    const c = await db.connect()
    let draftId: string
    try {
      const { seedDepositReturnDraft } = await import('../test/dbHelpers')
      draftId = await seedDepositReturnDraft(c as any, {
        leaseId: f.lease1Id, tenantId: f.tenant1Id, landlordId: f.aLid, totalDeposit: 0,
        damageLines: [{ description: 'Broken window', amount: 1000 }],
      })
    } finally { c.release() }
    await db.query(`UPDATE deposit_returns SET gap_payment_id = $2, finalized_at = NOW() WHERE id = $1`, [draftId!, d.rent])
    const res = await request(buildApp()).post(`/api/payments/${d.rent}/handle-return`)
      .set('Authorization', `Bearer ${f.tokenAdmin}`).send({ returnCode: 'R01', returnFee: 4 })
    expect(res.status).toBe(200)
    expect(res.body.data.outcome).toBe('reopened')
    const { GAP_CHARGE_REASON } = await import('../services/depositReturn')
    const { rows: [dr] } = await db.query<any>(
      `SELECT gap_charge_failed, gap_charge_failure_reason FROM deposit_returns WHERE id = $1`, [draftId!])
    expect(dr).toEqual({ gap_charge_failed: true, gap_charge_failure_reason: GAP_CHARGE_REASON.cameBack('ach') })
  })

  it('a bank return recorded by hand on an ordinary bill leaves every move-out alone', async () => {
    const f = await seed()
    const d = await seedSettledDebit(f, 'pi_ret_nogap')
    const c = await db.connect()
    let draftId: string
    try {
      const { seedDepositReturnDraft } = await import('../test/dbHelpers')
      draftId = await seedDepositReturnDraft(c as any, { leaseId: f.lease1Id, tenantId: f.tenant1Id, landlordId: f.aLid, totalDeposit: 0 })
    } finally { c.release() }
    const res = await request(buildApp()).post(`/api/payments/${d.rent}/handle-return`)
      .set('Authorization', `Bearer ${f.tokenAdmin}`).send({ returnCode: 'R01', returnFee: 4 })
    expect(res.status).toBe(200)
    const { rows: [dr] } = await db.query<any>(`SELECT gap_charge_failed FROM deposit_returns WHERE id = $1`, [draftId!])
    expect(dr.gap_charge_failed).toBe(false)
  })

  it('the NACHA log records the whole debit whichever of its rows is pressed', async () => {
    const f = await seed()
    const d = await seedSettledDebit(f, 'pi_ret_util_press')
    const res = await request(buildApp()).post(`/api/payments/${d.util}/handle-return`)
      .set('Authorization', `Bearer ${f.tokenAdmin}`).send({ returnCode: 'R01', returnFee: 4 })
    expect(res.status).toBe(200)
    const { rows: logs } = await db.query<any>(
      `SELECT payment_id, amount::float AS amount FROM ach_monitoring_log WHERE event_type = 'return_received'`)
    expect(logs).toEqual([{ payment_id: d.util, amount: 1056 }])
  })

  it('before contract step C0, a return on a debit that paid two charges is refused in plain words and changes nothing', async () => {
    const f = await seed()
    const d = await seedSettledDebit(f, 'pi_ret_prec0')
    await db.query(`ALTER TABLE payment_reversals ADD CONSTRAINT payment_reversals_stripe_event_id_key UNIQUE (stripe_event_id)`)
    try {
      const res = await request(buildApp()).post(`/api/payments/${d.rent}/handle-return`)
        .set('Authorization', `Bearer ${f.tokenAdmin}`).send({ returnCode: 'R01', returnFee: 4 })
      expect(res.status).toBe(409)
      expect(res.body.error).toMatch(/C0/)
    } finally {
      await db.query(`ALTER TABLE payment_reversals DROP CONSTRAINT IF EXISTS payment_reversals_stripe_event_id_key`)
    }
    const { rows } = await db.query<any>(`SELECT status, return_code FROM payments WHERE id = ANY($1::uuid[])`, [[d.rent, d.util]])
    expect(rows).toEqual([{ status: 'settled', return_code: null }, { status: 'settled', return_code: null }])
    const { rows: [n] } = await db.query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM payment_reversals`)
    expect(Number(n.n)).toBe(0)
    const { rows: logs } = await db.query<any>(`SELECT 1 FROM ach_monitoring_log WHERE payment_id=$1`, [d.rent])
    expect(logs).toHaveLength(0)
  })

  it('a return recorded twice is refused the second time and nothing is reopened again', async () => {
    const f = await seed()
    const d = await seedSettledDebit(f, 'pi_ret_twice')
    const first = await request(buildApp()).post(`/api/payments/${d.rent}/handle-return`)
      .set('Authorization', `Bearer ${f.tokenAdmin}`).send({ returnCode: 'R01', returnFee: 4 })
    expect(first.status).toBe(200)
    for (const id of [d.rent, d.util]) {
      const again = await request(buildApp()).post(`/api/payments/${id}/handle-return`)
        .set('Authorization', `Bearer ${f.tokenAdmin}`).send({ returnCode: 'R01', returnFee: 4 })
      expect(again.status).toBe(409)
      expect(again.body.error).toMatch(/already recorded/)
    }
    const { rows: [n] } = await db.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM payments WHERE reversal_id IS NOT NULL`)
    expect(Number(n.n)).toBe(2)
  })

  it('a settled debit needs the return fee Stripe charged, and nothing changes without it', async () => {
    const f = await seed()
    const d = await seedSettledDebit(f, 'pi_ret_nofee')
    const res = await request(buildApp()).post(`/api/payments/${d.rent}/handle-return`)
      .set('Authorization', `Bearer ${f.tokenAdmin}`).send({ returnCode: 'R01' })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/returnFee/)
    const { rows: [p] } = await db.query<any>(`SELECT status FROM payments WHERE id=$1`, [d.rent])
    expect(p.status).toBe('settled')
    const { rows: [n] } = await db.query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM payment_reversals`)
    expect(Number(n.n)).toBe(0)
  })

  it('zero-tolerance R10 on a settled debit: reopened as unauthorized, bank payments suspended, extra log row', async () => {
    const f = await seed()
    await db.query(`UPDATE tenants SET ach_verified=TRUE WHERE id=$1`, [f.tenant1Id])
    const d = await seedSettledDebit(f, 'pi_ret_r10')
    const res = await request(buildApp()).post(`/api/payments/${d.rent}/handle-return`)
      .set('Authorization', `Bearer ${f.tokenAdmin}`)
      .send({ returnCode: 'R10', returnFee: 0 })
    expect(res.status).toBe(200)
    expect(res.body.data.zeroTolerance).toBe(true)
    expect(res.body.data.action).toMatch(/suspended/)
    // S655: the NACHA block is its own column; ach_verified keeps meaning
    // "has a verified bank", and every bank charge is refused while suspended.
    const { rows: [t] } = await db.query<any>(
      `SELECT ach_verified, ach_suspended_at FROM tenants WHERE id=$1`, [f.tenant1Id])
    expect(t.ach_suspended_at).not.toBeNull()
    expect(t.ach_verified).toBe(true)
    const { rows: logs } = await db.query<any>(
      `SELECT event_type FROM ach_monitoring_log WHERE payment_id=$1 ORDER BY event_type`, [d.rent])
    expect(logs.map(l => l.event_type)).toEqual(['return_received', 'zero_tolerance_block'])
    const { rows: rv } = await db.query<any>(
      `SELECT DISTINCT reversal_type FROM payment_reversals WHERE stripe_event_id = 'manual_return:pi_ret_r10'`)
    expect(rv).toEqual([{ reversal_type: 'ach_unauthorized' }])
    const { rows: [p] } = await db.query<any>(`SELECT zero_tolerance_flag FROM payments WHERE id=$1`, [d.rent])
    expect(p.zero_tolerance_flag).toBe(true)
  })

  it('a return whose second step did not finish is finished when it is recorded again', async () => {
    const f = await seed()
    const d = await seedSettledDebit(f, 'pi_ret_resume')
    // The reversal ran (as the route runs it) but the codes were never written.
    const { handlePaymentReversal } = await import('../services/paymentReversal')
    await handlePaymentReversal({
      paymentIntentId: 'pi_ret_resume', reversalType: 'ach_return', reversalFee: 0,
      stripeEventId: 'manual_return:pi_ret_resume', rawEvent: {},
    })
    const res = await request(buildApp()).post(`/api/payments/${d.rent}/handle-return`)
      .set('Authorization', `Bearer ${f.tokenAdmin}`).send({ returnCode: 'R01', returnFee: 0 })
    expect(res.status).toBe(200)
    const { rows } = await db.query<any>(
      `SELECT return_code FROM payments WHERE id = ANY($1::uuid[])`, [[d.rent, d.util]])
    expect(rows.map(r => r.return_code)).toEqual(['R01', 'R01'])
    const { rows: [n] } = await db.query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM payments WHERE reversal_id IS NOT NULL`)
    expect(Number(n.n)).toBe(2)
  })

  it('a card payment is refused — a chargeback arrives from Stripe as a dispute', async () => {
    const f = await seed()
    const d = await seedSettledDebit(f, 'pi_ret_card', { method: 'card' })
    const res = await request(buildApp()).post(`/api/payments/${d.rent}/handle-return`)
      .set('Authorization', `Bearer ${f.tokenAdmin}`).send({ returnCode: 'R01', returnFee: 4 })
    expect(res.status).toBe(409)
    expect(res.body.error).toMatch(/card payment/)
    const { rows: [p] } = await db.query<any>(`SELECT status FROM payments WHERE id=$1`, [d.rent])
    expect(p.status).toBe('settled')
  })

  it('money recorded by hand is refused — there is no bank debit to return', async () => {
    const f = await seed()
    const d = await seedSettledDebit(f, 'pi_ret_manual', { manual: 'cash' })
    const res = await request(buildApp()).post(`/api/payments/${d.rent}/handle-return`)
      .set('Authorization', `Bearer ${f.tokenAdmin}`).send({ returnCode: 'R01', returnFee: 0 })
    expect(res.status).toBe(409)
    expect(res.body.error).toMatch(/recorded by hand/)
  })

  it('a debit still on its way is refused — Stripe reports its own failure', async () => {
    const f = await seed()
    const pid = await seedPayment({ unitId: f.aUnitId, tenantId: f.tenant1Id, landlordId: f.aLid, leaseId: f.lease1Id })
    await db.query(`UPDATE payments SET status='processing', stripe_payment_intent_id='pi_ret_inflight' WHERE id=$1`, [pid])
    const res = await request(buildApp()).post(`/api/payments/${pid}/handle-return`)
      .set('Authorization', `Bearer ${f.tokenAdmin}`).send({ returnCode: 'R01' })
    expect(res.status).toBe(409)
    expect(res.body.error).toMatch(/still on its way/)
    const { rows: [p] } = await db.query<any>(`SELECT status, return_code FROM payments WHERE id=$1`, [pid])
    expect(p).toEqual({ status: 'processing', return_code: null })
  })

  it('a charge never sent to the bank is refused and stays owed as it is', async () => {
    const f = await seed()
    const pid = await seedPayment({ unitId: f.aUnitId, tenantId: f.tenant1Id, landlordId: f.aLid })
    const res = await request(buildApp()).post(`/api/payments/${pid}/handle-return`)
      .set('Authorization', `Bearer ${f.tokenAdmin}`).send({ returnCode: 'R01' })
    expect(res.status).toBe(409)
    expect(res.body.error).toMatch(/never sent to the bank/)
    const { rows: [p] } = await db.query<any>(`SELECT status FROM payments WHERE id=$1`, [pid])
    expect(p.status).toBe('pending')
  })

  it('a failed debit keeps owing on its own row with the code written; a retryable code keeps its retry', async () => {
    const f = await seed()
    const pid = await seedPayment({ unitId: f.aUnitId, tenantId: f.tenant1Id, landlordId: f.aLid, leaseId: f.lease1Id })
    await db.query(`UPDATE payments SET status='failed', stripe_payment_intent_id='pi_ret_failed_r01',
                           next_retry_at = NOW() + INTERVAL '2 days' WHERE id=$1`, [pid])
    paymentIntentsCancelMock.mockClear()
    const res = await request(buildApp()).post(`/api/payments/${pid}/handle-return`)
      .set('Authorization', `Bearer ${f.tokenAdmin}`).send({ returnCode: 'R01' })
    expect(res.status).toBe(200)
    expect(res.body.data.outcome).toBe('failed')
    expect(res.body.data.action).toMatch(/a scheduled retry still runs/)
    const { rows: [p] } = await db.query<any>(`SELECT status, return_code, next_retry_at FROM payments WHERE id=$1`, [pid])
    expect(p.status).toBe('failed')
    expect(p.return_code).toBe('R01')
    expect(p.next_retry_at).not.toBeNull()
    expect(paymentIntentsCancelMock).not.toHaveBeenCalled()
    const o = await owedOnce(f)
    expect(o.agent).toBe(1000)
  })

  it('a do-not-retry code on a failed debit cancels its scheduled retry and gives back the credit it set aside', async () => {
    const f = await seed()
    const pid = await seedPayment({ unitId: f.aUnitId, tenantId: f.tenant1Id, landlordId: f.aLid, leaseId: f.lease1Id })
    const { rows: [credit] } = await db.query<{ id: string }>(
      `INSERT INTO tenant_credits (landlord_id, tenant_id, lease_id, amount_original, amount_remaining, category)
       VALUES ($1,$2,$3,100,100,'goodwill') RETURNING id`, [f.aLid, f.tenant1Id, f.lease1Id])
    const { rows: [rem] } = await db.query<{ id: string }>(
      `INSERT INTO tenant_remittances (tenant_id, lease_id, landlord_id, amount, applied_amount, unapplied_amount,
                                       payment_method, stripe_payment_intent_id, status)
       VALUES ($1,$2,$3,900,900,0,'ach','pi_ret_failed_r02','processing') RETURNING id`, [f.tenant1Id, f.lease1Id, f.aLid])
    await db.query(`UPDATE payments SET status='failed', stripe_payment_intent_id='pi_ret_failed_r02',
                           next_retry_at = NOW() + INTERVAL '2 days' WHERE id=$1`, [pid])
    await db.query(
      `INSERT INTO credit_uses (tenant_credit_id, payment_id, remittance_id, lease_id, amount, billing_month, source, status)
       VALUES ($1,$2,$3,$4,100,date_trunc('month', CURRENT_DATE)::date,'portal','held')`, [credit.id, pid, rem.id, f.lease1Id])
    paymentIntentsCancelMock.mockClear()
    const res = await request(buildApp()).post(`/api/payments/${pid}/handle-return`)
      .set('Authorization', `Bearer ${f.tokenAdmin}`).send({ returnCode: 'R02' })
    expect(res.status).toBe(200)
    expect(res.body.data.action).toMatch(/no retry/)
    const { rows: [p] } = await db.query<any>(`SELECT status, return_code, next_retry_at FROM payments WHERE id=$1`, [pid])
    expect(p).toEqual({ status: 'failed', return_code: 'R02', next_retry_at: null })
    expect(paymentIntentsCancelMock).toHaveBeenCalledWith('pi_ret_failed_r02')
    const { rows: uses } = await db.query<any>(`SELECT status, release_reason FROM credit_uses`)
    expect(uses).toEqual([{ status: 'released', release_reason: 'superseded' }])
    const { rows: [c] } = await db.query<any>(`SELECT amount_remaining::float AS left FROM tenant_credits WHERE id=$1`, [credit.id])
    expect(c.left).toBe(100)
  })

  // S655: credit a payment set aside goes back through the payment's own
  // failure or return event. Marking the row returned here would strand it.
  it('a payment with account credit set aside on it is refused, and nothing changes', async () => {
    const f = await seed()
    const pid = await seedPayment({ unitId: f.aUnitId, tenantId: f.tenant1Id, landlordId: f.aLid, leaseId: f.lease1Id })
    const { rows: [credit] } = await db.query<{ id: string }>(
      `INSERT INTO tenant_credits (landlord_id, tenant_id, lease_id, amount_original, amount_remaining, category)
       VALUES ($1,$2,$3,100,100,'goodwill') RETURNING id`, [f.aLid, f.tenant1Id, f.lease1Id])
    const { rows: [rem] } = await db.query<{ id: string }>(
      `INSERT INTO tenant_remittances (tenant_id, lease_id, landlord_id, amount, applied_amount, unapplied_amount,
                                       payment_method, status)
       VALUES ($1,$2,$3,900,900,0,'ach','processing') RETURNING id`, [f.tenant1Id, f.lease1Id, f.aLid])
    await db.query(
      `INSERT INTO credit_uses (tenant_credit_id, payment_id, remittance_id, lease_id, amount, billing_month, source, status)
       VALUES ($1,$2,$3,$4,100,date_trunc('month', CURRENT_DATE)::date,'portal','held')`, [credit.id, pid, rem.id, f.lease1Id])
    await db.query(`UPDATE payments SET status='processing', stripe_payment_intent_id='pi_held_return' WHERE id=$1`, [pid])
    await db.query(`UPDATE tenant_remittances SET stripe_payment_intent_id='pi_held_return' WHERE id=$1`, [rem.id])
    const res = await request(buildApp()).post(`/api/payments/${pid}/handle-return`)
      .set('Authorization', `Bearer ${f.tokenAdmin}`).send({ returnCode: 'R10' })
    expect(res.status).toBe(409)
    expect(res.body.error).toMatch(/credit set aside/)
    const { rows: [p] } = await db.query<any>(`SELECT status FROM payments WHERE id=$1`, [pid])
    expect(p.status).toBe('processing')
    const { rows: [t] } = await db.query<any>(`SELECT ach_suspended_at FROM tenants WHERE id=$1`, [f.tenant1Id])
    expect(t.ach_suspended_at).toBeNull()
  })

  // Fix pass 2: two presses at the same moment are one return. The money was
  // already safe (one reopen, one fee); now the NACHA log counts it once too
  // and the second press is told plainly.
  it('two presses of handle-return at the same moment: one 200, one 409, one NACHA log row, one reopen, one return fee', async () => {
    const f = await seed()
    const d = await seedSettledDebit(f, 'pi_ret_race')
    const press = (id: string) => request(buildApp()).post(`/api/payments/${id}/handle-return`)
      .set('Authorization', `Bearer ${f.tokenAdmin}`).send({ returnCode: 'R01', returnFee: 4 })
    const answers = await Promise.all([press(d.rent), press(d.rent)])
    expect(answers.map(a => a.status).sort()).toEqual([200, 409])
    const lost = answers.find(a => a.status === 409)!
    expect(lost.body.error).toBe('This return is already recorded. The amount is owed again on its reopened charge.')
    const won = answers.find(a => a.status === 200)!
    expect(won.body.data.reopened).toHaveLength(2)
    const { rows: logs } = await db.query<any>(
      `SELECT notes FROM ach_monitoring_log WHERE event_type = 'return_received'`)
    expect(logs).toEqual([{ notes: 'manual_return:pi_ret_race' }])
    const { rows: [n] } = await db.query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM payments WHERE reversal_id IS NOT NULL`)
    expect(Number(n.n)).toBe(2)
    const { rows: [fees] } = await db.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM payments WHERE entry_description = 'RETURNFEE'`)
    expect(Number(fees.n)).toBe(1)
    const { rows: codes } = await db.query<any>(`SELECT return_code FROM payments WHERE id = ANY($1::uuid[])`, [[d.rent, d.util]])
    expect(codes.map(r => r.return_code)).toEqual(['R01', 'R01'])
  })

  it('a press whose return another press recorded while it waited is refused, and writes no code and no NACHA log', async () => {
    const f = await seed()
    const d = await seedSettledDebit(f, 'pi_ret_waited')
    // The other press's record landed after this press saw the rows settled.
    await db.query(
      `INSERT INTO payment_reversals (payment_id, reversal_type, reversed_amount, stripe_event_id, raw_event)
       VALUES ($1,'ach_return',0,'manual_return:pi_ret_waited','{}'::jsonb)`, [d.util])
    const res = await request(buildApp()).post(`/api/payments/${d.rent}/handle-return`)
      .set('Authorization', `Bearer ${f.tokenAdmin}`).send({ returnCode: 'R10', returnFee: 4 })
    expect(res.status).toBe(409)
    expect(res.body.error).toBe('This return is already recorded. The amount is owed again on its reopened charge.')
    const { rows } = await db.query<any>(
      `SELECT status, return_code FROM payments WHERE id = ANY($1::uuid[])`, [[d.rent, d.util]])
    expect(rows).toEqual([{ status: 'settled', return_code: null }, { status: 'settled', return_code: null }])
    const { rows: logs } = await db.query<any>(`SELECT 1 FROM ach_monitoring_log`)
    expect(logs).toHaveLength(0)
    const { rows: [t] } = await db.query<any>(`SELECT ach_suspended_at FROM tenants WHERE id=$1`, [f.tenant1Id])
    expect(t.ach_suspended_at).toBeNull()
  })

  it('finishing a half-recorded return names the charges it reopened and what is owed on them', async () => {
    const f = await seed()
    await seedSettledDebit(f, 'pi_ret_resume_named')
    const { handlePaymentReversal } = await import('../services/paymentReversal')
    await handlePaymentReversal({
      paymentIntentId: 'pi_ret_resume_named', reversalType: 'ach_return', reversalFee: 0,
      stripeEventId: 'manual_return:pi_ret_resume_named', rawEvent: {},
    })
    const { rows: [rent] } = await db.query<{ id: string }>(
      `SELECT id FROM payments WHERE stripe_payment_intent_id = 'pi_ret_resume_named' AND type = 'rent' AND reversal_id IS NULL`)
    const res = await request(buildApp()).post(`/api/payments/${rent.id}/handle-return`)
      .set('Authorization', `Bearer ${f.tokenAdmin}`).send({ returnCode: 'R01', returnFee: 0 })
    expect(res.status).toBe(200)
    expect(res.body.data.reopened).toHaveLength(2)
    expect(res.body.data.owedAgain).toBe(1050)
    expect(res.body.data.action).toMatch(/^Reopened — \$1050\.00 is owed again on 2 new charges\./)
  })

  it('a failed debit with no retry scheduled says no retry is scheduled, even for a retryable code', async () => {
    const f = await seed()
    const pid = await seedPayment({ unitId: f.aUnitId, tenantId: f.tenant1Id, landlordId: f.aLid, leaseId: f.lease1Id })
    await db.query(`UPDATE payments SET status='failed', stripe_payment_intent_id='pi_ret_failed_final',
                           retry_count = 2, next_retry_at = NULL WHERE id=$1`, [pid])
    const res = await request(buildApp()).post(`/api/payments/${pid}/handle-return`)
      .set('Authorization', `Bearer ${f.tokenAdmin}`).send({ returnCode: 'R01' })
    expect(res.status).toBe(200)
    expect(res.body.data.action).toBe('The payment stays failed and is still owed on its own charge (no retry is scheduled).')
    expect(res.body.data.action).not.toMatch(/still runs/)
  })

  it('a failed debit with a retry scheduled says the retry still runs', async () => {
    const f = await seed()
    const pid = await seedPayment({ unitId: f.aUnitId, tenantId: f.tenant1Id, landlordId: f.aLid, leaseId: f.lease1Id })
    await db.query(`UPDATE payments SET status='failed', stripe_payment_intent_id='pi_ret_failed_next',
                           next_retry_at = NOW() + INTERVAL '1 day' WHERE id=$1`, [pid])
    const res = await request(buildApp()).post(`/api/payments/${pid}/handle-return`)
      .set('Authorization', `Bearer ${f.tokenAdmin}`).send({ returnCode: 'R01' })
    expect(res.status).toBe(200)
    expect(res.body.data.action).toBe('The payment stays failed and is still owed on its own charge (a scheduled retry still runs).')
  })

  it('a failed card payment is refused like a settled one: no bank code, no NACHA log, no bank-payment block', async () => {
    const f = await seed()
    const pid = await seedPayment({ unitId: f.aUnitId, tenantId: f.tenant1Id, landlordId: f.aLid, leaseId: f.lease1Id })
    await db.query(
      `INSERT INTO tenant_remittances (tenant_id, lease_id, landlord_id, amount, applied_amount, unapplied_amount,
                                       payment_method, stripe_payment_intent_id, status)
       VALUES ($1,$2,$3,1000,1000,0,'card','pi_ret_failed_card','failed')`, [f.tenant1Id, f.lease1Id, f.aLid])
    await db.query(`UPDATE payments SET status='failed', stripe_payment_intent_id='pi_ret_failed_card' WHERE id=$1`, [pid])
    const res = await request(buildApp()).post(`/api/payments/${pid}/handle-return`)
      .set('Authorization', `Bearer ${f.tokenAdmin}`).send({ returnCode: 'R10' })
    expect(res.status).toBe(409)
    expect(res.body.error).toBe(
      'This was a card payment. A card chargeback comes from Stripe as a dispute and is handled there, not recorded here.')
    const { rows: [p] } = await db.query<any>(`SELECT return_code, zero_tolerance_flag FROM payments WHERE id=$1`, [pid])
    expect(p).toEqual({ return_code: null, zero_tolerance_flag: false })
    const { rows: logs } = await db.query<any>(`SELECT 1 FROM ach_monitoring_log`)
    expect(logs).toHaveLength(0)
    const { rows: [t] } = await db.query<any>(`SELECT ach_suspended_at FROM tenants WHERE id=$1`, [f.tenant1Id])
    expect(t.ach_suspended_at).toBeNull()
  })

  it('a failed row with no bank debit behind it is refused: no code, no NACHA log, no bank-payment block', async () => {
    const f = await seed()
    const pid = await seedPayment({ unitId: f.aUnitId, tenantId: f.tenant1Id, landlordId: f.aLid, leaseId: f.lease1Id })
    await db.query(`UPDATE payments SET status='failed' WHERE id=$1`, [pid])
    const res = await request(buildApp()).post(`/api/payments/${pid}/handle-return`)
      .set('Authorization', `Bearer ${f.tokenAdmin}`).send({ returnCode: 'R10' })
    expect(res.status).toBe(409)
    expect(res.body.error).toBe('This charge was never sent to the bank, so there is no return to record. It is still owed as it is.')
    const { rows: [p] } = await db.query<any>(`SELECT status, return_code, zero_tolerance_flag FROM payments WHERE id=$1`, [pid])
    expect(p).toEqual({ status: 'failed', return_code: null, zero_tolerance_flag: false })
    const { rows: logs } = await db.query<any>(`SELECT 1 FROM ach_monitoring_log`)
    expect(logs).toHaveLength(0)
    const { rows: [t] } = await db.query<any>(`SELECT ach_suspended_at FROM tenants WHERE id=$1`, [f.tenant1Id])
    expect(t.ach_suspended_at).toBeNull()
  })

  it('a failed row recorded by hand is refused: no code, no NACHA log, no bank-payment block', async () => {
    const f = await seed()
    const pid = await seedPayment({ unitId: f.aUnitId, tenantId: f.tenant1Id, landlordId: f.aLid, leaseId: f.lease1Id })
    await db.query(`UPDATE payments SET status='failed', manual_method='check', stripe_payment_intent_id='pi_ret_failed_check' WHERE id=$1`, [pid])
    const res = await request(buildApp()).post(`/api/payments/${pid}/handle-return`)
      .set('Authorization', `Bearer ${f.tokenAdmin}`).send({ returnCode: 'R10' })
    expect(res.status).toBe(409)
    expect(res.body.error).toMatch(/recorded by hand/)
    const { rows: [p] } = await db.query<any>(`SELECT return_code, zero_tolerance_flag FROM payments WHERE id=$1`, [pid])
    expect(p).toEqual({ return_code: null, zero_tolerance_flag: false })
    const { rows: logs } = await db.query<any>(`SELECT 1 FROM ach_monitoring_log`)
    expect(logs).toHaveLength(0)
    const { rows: [t] } = await db.query<any>(`SELECT ach_suspended_at FROM tenants WHERE id=$1`, [f.tenant1Id])
    expect(t.ach_suspended_at).toBeNull()
  })

  it('a failed debit recorded twice is refused the second time, with one NACHA log row; its code is on every row of the debit', async () => {
    const f = await seed()
    const rent = await seedPayment({ unitId: f.aUnitId, tenantId: f.tenant1Id, landlordId: f.aLid, leaseId: f.lease1Id })
    const util = await seedPayment({ unitId: f.aUnitId, tenantId: f.tenant1Id, landlordId: f.aLid, leaseId: f.lease1Id,
                                     type: 'utility', amount: 50 })
    await db.query(`UPDATE payments SET status='failed', stripe_payment_intent_id='pi_ret_failed_twice',
                           next_retry_at = NOW() + INTERVAL '2 days' WHERE id = ANY($1::uuid[])`, [[rent, util]])
    const first = await request(buildApp()).post(`/api/payments/${rent}/handle-return`)
      .set('Authorization', `Bearer ${f.tokenAdmin}`).send({ returnCode: 'R01' })
    expect(first.status).toBe(200)
    const again = await request(buildApp()).post(`/api/payments/${util}/handle-return`)
      .set('Authorization', `Bearer ${f.tokenAdmin}`).send({ returnCode: 'R01' })
    expect(again.status).toBe(409)
    expect(again.body.error).toBe('This return is already recorded on this failed payment. It is still owed on its own charge.')
    // No receipt on this debit: the log falls back to its rows' money ($1,000 rent + $50 utility).
    const { rows: logs } = await db.query<any>(
      `SELECT notes, amount::float AS amount FROM ach_monitoring_log WHERE event_type = 'return_received'`)
    expect(logs).toEqual([{ notes: 'manual_return:pi_ret_failed_twice:attempt0', amount: 1050 }])
    const { rows: codes } = await db.query<any>(`SELECT return_code FROM payments WHERE id = ANY($1::uuid[])`, [[rent, util]])
    expect(codes.map(r => r.return_code)).toEqual(['R01', 'R01'])
  })

  it('a retry of a failed debit that fails again is a new return and can be recorded', async () => {
    const f = await seed()
    const pid = await seedPayment({ unitId: f.aUnitId, tenantId: f.tenant1Id, landlordId: f.aLid, leaseId: f.lease1Id })
    await db.query(`UPDATE payments SET status='failed', stripe_payment_intent_id='pi_ret_failed_retry',
                           next_retry_at = NOW() + INTERVAL '2 days' WHERE id=$1`, [pid])
    const first = await request(buildApp()).post(`/api/payments/${pid}/handle-return`)
      .set('Authorization', `Bearer ${f.tokenAdmin}`).send({ returnCode: 'R01' })
    expect(first.status).toBe(200)
    // The retry confirms the same intent again (achRetry), and the bank sends it back too.
    await db.query(`UPDATE payments SET retry_count = 1, next_retry_at = NULL WHERE id=$1`, [pid])
    const second = await request(buildApp()).post(`/api/payments/${pid}/handle-return`)
      .set('Authorization', `Bearer ${f.tokenAdmin}`).send({ returnCode: 'R01' })
    expect(second.status).toBe(200)
    const { rows: logs } = await db.query<any>(
      `SELECT notes FROM ach_monitoring_log WHERE event_type = 'return_received' ORDER BY notes`)
    expect(logs).toEqual([
      { notes: 'manual_return:pi_ret_failed_retry:attempt0' },
      { notes: 'manual_return:pi_ret_failed_retry:attempt1' },
    ])
  })

  // A later bill paid with a bank debit and paid-ahead credit; the charge that
  // funded the credit is disputed first, so the bill's row goes 'returned' for
  // the credit part only. Its own bank money still stands, and the bank's
  // return of that debit reopens it (paymentReversal reopens such a row).
  it('a row returned only for its paid-ahead part reopens for its own money when its bank debit comes back', async () => {
    const f = await seed()
    const { createPaidAhead } = await import('../services/creditUse')
    const { handlePaymentReversal } = await import('../services/paymentReversal')
    // The funding card payment: nothing owed, all of it paid ahead.
    const { rows: [fund] } = await db.query<{ id: string }>(
      `INSERT INTO tenant_remittances (tenant_id, lease_id, landlord_id, amount, applied_amount, unapplied_amount,
                                       payment_method, stripe_payment_intent_id, status)
       VALUES ($1,$2,$3,200,0,200,'card','pi_fund_for_return','settled') RETURNING id`, [f.tenant1Id, f.lease1Id, f.aLid])
    const c = await db.connect()
    let credit: string
    try {
      credit = await createPaidAhead(c as any, { leaseId: f.lease1Id, tenantId: f.tenant1Id, amount: 200, fundedBy: 'gam',
                                                 receivedAt: new Date(), sourceRemittanceId: fund.id })
    } finally { c.release() }
    // The bill: $1,000 rent paid $800 by bank debit and $200 of the credit.
    const rent = await seedPayment({ unitId: f.aUnitId, tenantId: f.tenant1Id, landlordId: f.aLid, leaseId: f.lease1Id,
                                     dueOffsetMonths: -1 })
    const { rows: [rem] } = await db.query<{ id: string }>(
      `INSERT INTO tenant_remittances (tenant_id, lease_id, landlord_id, amount, applied_amount, unapplied_amount,
                                       payment_method, stripe_payment_intent_id, status, gross_amount, processing_fee_amount)
       VALUES ($1,$2,$3,800,800,0,'ach','pi_ret_after_spend','settled',806,6) RETURNING id`, [f.tenant1Id, f.lease1Id, f.aLid])
    await db.query(`INSERT INTO remittance_applications (remittance_id, payment_id, amount_applied) VALUES ($1,$2,800)`, [rem.id, rent])
    await db.query(
      `INSERT INTO credit_uses (prepaid_credit_id, payment_id, lease_id, remittance_id, amount, billing_month, source, status, applied_at)
       VALUES ($1,$2,$3,$4,200,date_trunc('month', CURRENT_DATE - INTERVAL '1 month')::date,'portal','applied',NOW())`,
      [credit!, rent, f.lease1Id, rem.id])
    await db.query(
      `UPDATE payments SET status='settled', settled_at=NOW(), platform_held=TRUE, stripe_payment_intent_id='pi_ret_after_spend'
        WHERE id=$1`, [rent])
    // The funding charge is disputed: the $200 spend is undone and the row goes 'returned' for it.
    const rev = await handlePaymentReversal({ paymentIntentId: 'pi_fund_for_return', reversalType: 'card_dispute',
                                              reversalFee: 0, stripeEventId: 'evt_fund_for_return', rawEvent: {} })
    expect(rev.handled).toBe(true)
    const { rows: [before] } = await db.query<any>(`SELECT status, return_code FROM payments WHERE id=$1`, [rent])
    expect(before.status).toBe('returned')

    const res = await request(buildApp()).post(`/api/payments/${rent}/handle-return`)
      .set('Authorization', `Bearer ${f.tokenAdmin}`).send({ returnCode: 'R01', returnFee: 4 })
    expect(res.status).toBe(200)
    expect(res.body.data.outcome).toBe('reopened')
    expect(res.body.data.reopened).toEqual([expect.objectContaining({ paymentId: rent, owedAgain: 800 })])
    expect(res.body.data.owedAgain).toBe(800)
    const { rows: [after] } = await db.query<any>(`SELECT status, return_code FROM payments WHERE id=$1`, [rent])
    expect(after).toEqual({ status: 'returned', return_code: 'R01' })
    // Owed again once each: the $200 the dispute undid and the $800 the bank took back, plus the $4 fee.
    const { rows: owed } = await db.query<any>(
      `SELECT amount::float AS amount FROM payments WHERE tenant_id = $1 AND status = 'pending' ORDER BY amount`, [f.tenant1Id])
    expect(owed.map(r => r.amount)).toEqual([4, 200, 800])
    const { rows: logs } = await db.query<any>(`SELECT notes FROM ach_monitoring_log WHERE event_type = 'return_received'`)
    expect(logs).toEqual([{ notes: 'manual_return:pi_ret_after_spend' }])
  })

  it('a row returned by another event with no reversed paid-ahead credit is refused as already recorded, and nothing is logged', async () => {
    const f = await seed()
    const pid = await seedPayment({ unitId: f.aUnitId, tenantId: f.tenant1Id, landlordId: f.aLid, leaseId: f.lease1Id })
    // An earlier return of another kind: no reversed credit use, so no money of its own is left to reopen here.
    await db.query(`UPDATE payments SET status='returned', return_code='card_dispute', stripe_payment_intent_id='pi_ret_other' WHERE id=$1`, [pid])
    const res = await request(buildApp()).post(`/api/payments/${pid}/handle-return`)
      .set('Authorization', `Bearer ${f.tokenAdmin}`).send({ returnCode: 'R01', returnFee: 4 })
    expect(res.status).toBe(409)
    expect(res.body.error).toMatch(/already recorded/)
    const { rows: logs } = await db.query<any>(`SELECT 1 FROM ach_monitoring_log`)
    expect(logs).toHaveLength(0)
  })
})

// ─── POST /api/payments/pay-balance — the one way a tenant pays ─────────────
// S655: the per-row POST /:id/pay is retired; every rule it carried (the fee on
// top, the passthrough, the eviction hold, the platform charge) is checked here
// on the whole-bill charge.

describe('POST /api/payments/pay-balance', () => {
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
  const bill = (f: Fixture, amount = 1000) =>
    seedPayment({ unitId: f.aUnitId, tenantId: f.tenant1Id, landlordId: f.aLid, amount, leaseId: f.lease1Id })
  const pay = (f: Fixture, body: any, token = f.tokenTenant1) =>
    request(buildApp()).post('/api/payments/pay-balance').set('Authorization', `Bearer ${token}`).send(body)
  const sent = () => (stripeConnect.createRentPlatformCharge as any).mock.calls.map((c: any[]) => c[0].amount)

  // Fix pass (Step 8): one key per press of Pay, and a card its bank wants confirmed.
  it('pay-balance passes the press key to Stripe, scoped to the tenant and the lease', async () => {
    const f = await seed()
    await setupTenantForPay(f, { connectReady: true })
    await setFeePayer(f.aPropId, 'tenant', 'tenant')
    await bill(f)
    const res = await pay(f, { amount: 1000, paymentMethodId: 'pm_x', paymentMethodType: 'ach', idempotencyKey: 'press_route_0001' })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect((stripeConnect.createRentPlatformCharge as any).mock.calls[0][0].idempotencyKey)
      .toBe(`gam_balance_${f.tenant1Id}_${f.lease1Id}_press_route_0001`)
  })

  it('pay-balance refuses a malformed press key and charges nothing', async () => {
    const f = await seed()
    await setupTenantForPay(f, { connectReady: true })
    await bill(f)
    const res = await pay(f, { amount: 1000, paymentMethodId: 'pm_x', paymentMethodType: 'ach', idempotencyKey: 'bad key!' })
    expect(res.status).toBe(400)
    expect(sent()).toEqual([])
  })

  // decisions.md #48.4: renamed — only a payer who cannot see the bank's
  // window (no confirmOnScreen: the tenant assistant) gets the charge canceled;
  // the pay screen confirms it on the spot (below).
  it('pay-balance without the pay screen answers 402 in plain words for a card its bank wants confirmed, points to the Payments page, and the bill stays open', async () => {
    const f = await seed()
    await setupTenantForPay(f, { connectReady: true })
    await setFeePayer(f.aPropId, 'tenant', 'tenant')
    const pid = await bill(f)
    ;(stripeConnect.createRentPlatformCharge as any).mockImplementationOnce(async () => ({ id: 'pi_route_3ds', status: 'requires_action' }))
    paymentIntentsCancelMock.mockClear()
    const res = await pay(f, { amount: 1000, paymentMethodId: 'pm_x', paymentMethodType: 'card' })
    expect(res.status).toBe(402)
    expect(res.body.error).toMatch(/Nothing was charged/)
    expect(res.body.error).toMatch(/Payments page, where you can confirm it/)
    expect(paymentIntentsCancelMock).toHaveBeenCalledWith('pi_route_3ds')
    const { rows: [p] } = await db.query<any>(`SELECT status, stripe_payment_intent_id FROM payments WHERE id=$1`, [pid])
    expect(p).toEqual({ status: 'pending', stripe_payment_intent_id: null })
  })

  // S562: the processing fee (mock computePlatformCut → $5) is ADDED to the
  // charge when the tenant is the fee payer, so GAM never eats Stripe's cost.
  it('S562: tenant pays ACH fee → charge = bill + processing fee', async () => {
    const f = await seed()
    await setupTenantForPay(f, { connectReady: true })
    await setFeePayer(f.aPropId, 'tenant', 'tenant')
    await bill(f)
    const res = await pay(f, { amount: 1000, paymentMethodId: 'pm_x', paymentMethodType: 'ach' })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(sent()).toEqual([1005])
  })

  it('S562: landlord pays ACH fee → charge = the bill only (landlord absorbs at settle)', async () => {
    const f = await seed()
    await setupTenantForPay(f, { connectReady: true })
    await setFeePayer(f.aPropId, 'landlord', 'tenant')
    await bill(f)
    const res = await pay(f, { amount: 1000, paymentMethodId: 'pm_x', paymentMethodType: 'ach' })
    expect(res.status).toBe(200)
    expect(sent()).toEqual([1000])
  })

  // 10/5 (Nic): card and bank fees are ONE choice per property (supersedes the
  // S512/S562 "card is always the tenant's"). A property that covers the fees
  // covers card too: the card charge is the bill only.
  it('10/5: a property that covers the fees covers card too → card charge = the bill only', async () => {
    const f = await seed()
    await setupTenantForPay(f, { connectReady: true })
    await setFeePayer(f.aPropId, 'landlord', 'landlord')
    await bill(f)
    const res = await pay(f, { amount: 1000, paymentMethodId: 'pm_x', paymentMethodType: 'card' })
    expect(res.status).toBe(200)
    expect(sent()).toEqual([1000])
  })

  it('10/5: the two payers can never be stored apart — setting the bank fee to covered covers card', async () => {
    const f = await seed()
    await setFeePayer(f.aPropId, 'landlord', 'tenant')
    const { rows: [r] } = await db.query(
      `SELECT ach_fee_payer, card_fee_payer FROM property_allocation_rules WHERE property_id=$1`, [f.aPropId])
    expect(r).toEqual({ ach_fee_payer: 'landlord', card_fee_payer: 'landlord' })
    const { rows: [p] } = await db.query(
      `SELECT register_card_fee_payer, booking_card_fee_payer FROM properties WHERE id=$1`, [f.aPropId])
    expect(p).toEqual({ register_card_fee_payer: 'landlord', booking_card_fee_payer: 'landlord' })
  })

  it('S562: tenant-payer platform-fee passthrough is added to the charge', async () => {
    const f = await seed()
    await setupTenantForPay(f, { connectReady: true })
    await setFeePayer(f.aPropId, 'landlord', 'tenant')
    await db.query(
      `INSERT INTO platform_fee_accruals
         (landlord_id, property_id, accrual_month, rate_per_unit, min_per_connect_account, total_amount, payer)
       VALUES ($1, $2, CURRENT_DATE, 2, 10, 20, 'tenant')`,
      [f.aLid, f.aPropId])
    await bill(f)
    const res = await pay(f, { amount: 1000, paymentMethodId: 'pm_x', paymentMethodType: 'ach' })
    expect(res.status).toBe(200)
    expect(sent()).toEqual([1020])                       // 1000 + 0 processing + 20 passthrough
  })

  // Review fix pass 2: the charge adds an unpaid tenant-payer platform fee on
  // top; the quote read back (the pay screen, the assistant) used to leave it
  // out, so the tenant was charged more than they were told.
  it('a tenant-payer platform fee is in the quote, and the quote total equals the charge', async () => {
    const f = await seed()
    await setupTenantForPay(f, { connectReady: true })
    await setFeePayer(f.aPropId, 'tenant', 'tenant')
    await db.query(
      `INSERT INTO platform_fee_accruals
         (landlord_id, property_id, accrual_month, rate_per_unit, min_per_connect_account, total_amount, payer)
       VALUES ($1, $2, CURRENT_DATE, 2, 10, 20, 'tenant')`,
      [f.aLid, f.aPropId])
    await bill(f)
    const quote = (body: any) => request(buildApp()).post('/api/payments/quote')
      .set('Authorization', `Bearer ${f.tokenTenant1}`).send(body)

    const q = await quote({ method: 'ach' })
    expect(q.status, JSON.stringify(q.body)).toBe(200)
    expect(q.body.data).toMatchObject({ base: 1000, fee: 25, total: 1025 })   // mock $5 + $20
    // Paying ahead moves the processing fee to the larger amount; the platform fee still rides on top.
    const ahead = await quote({ method: 'ach', amount: 1200 })
    expect(ahead.body.data).toMatchObject({ base: 1200, fee: 25, total: 1225 })

    const res = await pay(f, { amount: 1000, paymentMethodId: 'pm_x', paymentMethodType: 'ach' })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(sent()).toEqual([q.body.data.total])
    expect(res.body.data.chargeAmount).toBe(q.body.data.total)
    // Charged once: the next quote no longer carries it.
    const { rows: [acc] } = await db.query<any>(
      `SELECT tenant_charge_id FROM platform_fee_accruals WHERE property_id = $1`, [f.aPropId])
    expect(acc.tenant_charge_id).not.toBeNull()
  })

  it('a bill the credit pays whole is quoted with no fee of any kind, a waiting platform fee included', async () => {
    const f = await seed()
    await setFeePayer(f.aPropId, 'tenant', 'tenant')
    await db.query(
      `INSERT INTO platform_fee_accruals
         (landlord_id, property_id, accrual_month, rate_per_unit, min_per_connect_account, total_amount, payer)
       VALUES ($1, $2, CURRENT_DATE, 2, 10, 20, 'tenant')`,
      [f.aLid, f.aPropId])
    await bill(f, 300)
    await db.query(
      `INSERT INTO tenant_credits (landlord_id, tenant_id, lease_id, amount_original, amount_remaining, category)
       VALUES ($1,$2,$3,300,300,'goodwill')`, [f.aLid, f.tenant1Id, f.lease1Id])
    const q = await request(buildApp()).post('/api/payments/quote')
      .set('Authorization', `Bearer ${f.tokenTenant1}`).send({ method: 'ach', useCredit: true })
    expect(q.body.data).toMatchObject({ base: 0, fee: 0, total: 0, payWithCreditNothingCharged: true })
    const res = await pay(f, { amount: 0, useCredit: true, expectedCredit: 300 })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.data.chargeAmount).toBe(0)
  })

  it('non-tenant → 403', async () => {
    const f = await seed()
    await bill(f)
    const res = await pay(f, { amount: 1000, paymentMethodId: 'pm_x', paymentMethodType: 'ach' }, f.tokenLandlordA)
    expect(res.status).toBe(403)
  })

  it('S511 #8b: eviction mode (payment_block) blocks the landlord-bound payment → 409, nothing charged', async () => {
    const f = await seed()
    await setupTenantForPay(f, { connectReady: true })
    await bill(f)
    await db.query(`UPDATE units SET payment_block=TRUE WHERE id=$1`, [f.aUnitId])
    const res = await pay(f, { amount: 1000, paymentMethodId: 'pm_x', paymentMethodType: 'ach' })
    expect(res.status).toBe(409)
    expect(res.body.message || res.body.error).toMatch(/eviction/i)
    expect(stripeConnect.createRentPlatformCharge).not.toHaveBeenCalled()
  })

  it('tenant without stripe_customer_id → 409 "complete ACH setup first"', async () => {
    const f = await seed()
    await bill(f)
    const res = await pay(f, { amount: 1000, paymentMethodId: 'pm_x', paymentMethodType: 'ach' })
    expect(res.status).toBe(409)
  })

  it('S560: a PLATFORM charge, held, rows processing until the webhook settles them', async () => {
    const f = await seed()
    await setupTenantForPay(f, { connectReady: false })
    const pid = await bill(f)
    const res = await pay(f, { amount: 1000, paymentMethodId: 'pm_x', paymentMethodType: 'card' })
    expect(res.status).toBe(200)
    expect(stripeConnect.createRentDestinationCharge).not.toHaveBeenCalled()
    expect(res.body.data.paymentIntentId).toBe('pi_plat_mock')
    const { rows: [p] } = await db.query<any>(
      `SELECT status, stripe_payment_intent_id, platform_held FROM payments WHERE id=$1`, [pid])
    expect(p).toEqual({ status: 'processing', stripe_payment_intent_id: 'pi_plat_mock', platform_held: true })
  })

  // Fix pass 1: replaces the retired /:id/pay test 'S113-PhaseA: landlord NOT
  // Connect-ready → platform charge + platform_held=TRUE' on the whole-bill path.
  it('a landlord not Connect-ready still gets a platform charge: rows processing and platform_held, and one platform_held_rent_charge notice to GAM', async () => {
    const notify = createAdminNotification as unknown as ReturnType<typeof vi.fn>
    notify.mockClear()
    const f = await seed()
    await setupTenantForPay(f, { connectReady: false })
    const rent = await bill(f, 600)
    const res = await pay(f, { amount: 600, paymentMethodId: 'pm_x', paymentMethodType: 'ach' })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(stripeConnect.createRentPlatformCharge).toHaveBeenCalledTimes(1)
    expect(stripeConnect.createRentDestinationCharge).not.toHaveBeenCalled()
    const { rows } = await db.query<any>(
      `SELECT status, platform_held, stripe_payment_intent_id FROM payments WHERE id = $1`, [rent])
    expect(rows).toEqual([{ status: 'processing', platform_held: true, stripe_payment_intent_id: 'pi_plat_mock' }])
    const held = notify.mock.calls.filter((c: any[]) => c[0]?.category === 'platform_held_rent_charge')
    expect(held).toHaveLength(1)
    expect(held[0][0].context).toMatchObject({ remittance_id: res.body.data.remittanceId, landlord_id: f.aLid })
  })

  it('a Connect-ready landlord raises no platform_held_rent_charge notice', async () => {
    const notify = createAdminNotification as unknown as ReturnType<typeof vi.fn>
    notify.mockClear()
    const f = await seed()
    await setupTenantForPay(f, { connectReady: true })
    await bill(f)
    const res = await pay(f, { amount: 1000, paymentMethodId: 'pm_x', paymentMethodType: 'ach' })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(notify.mock.calls.filter((c: any[]) => c[0]?.category === 'platform_held_rent_charge')).toHaveLength(0)
  })

  it('invalid paymentMethodType enum → 400', async () => {
    const f = await seed()
    await setupTenantForPay(f)
    await bill(f)
    const res = await pay(f, { amount: 1000, paymentMethodId: 'pm_x', paymentMethodType: 'crypto' })
    expect(res.status).toBe(400)
  })

  // S655 (Nic, 10/2): the screen's "Use all $X — pay $Y" / "Save it for later — pay $Z".
  it('carries the credit choice: Use all charges the bill less the credit; a moved figure is a 409', async () => {
    const f = await seed()
    await setupTenantForPay(f, { connectReady: true })
    await bill(f)
    await db.query(
      `INSERT INTO tenant_credits (landlord_id, tenant_id, lease_id, amount_original, amount_remaining, category)
       VALUES ($1,$2,$3,300,300,'goodwill')`, [f.aLid, f.tenant1Id, f.lease1Id])
    const noChoice = await pay(f, { amount: 1000, paymentMethodId: 'pm_x', paymentMethodType: 'ach' })
    expect(noChoice.status).toBe(422)
    expect(noChoice.body.error).toMatch(/Use all \$300\.00.*Save it for later/)
    const moved = await pay(f, { amount: 700, paymentMethodId: 'pm_x', paymentMethodType: 'ach', useCredit: true, expectedCredit: 250 })
    expect(moved.status).toBe(409)
    expect(moved.body.error).toMatch(/it's now \$300\.00/)
    expect(sent()).toEqual([])
    const used = await pay(f, { amount: 700, paymentMethodId: 'pm_x', paymentMethodType: 'ach', useCredit: true, expectedCredit: 300 })
    expect(used.status).toBe(200)
    expect(sent()).toEqual([705])
    expect(used.body.data.creditUsed).toBe(300)
  })

  // Fix round 1 (shelved 8): an answer without the figure it answered could
  // spend whatever the credit is by then — refused, nothing charged.
  it('useCredit without expectedCredit is refused and nothing is charged', async () => {
    const f = await seed()
    await setupTenantForPay(f, { connectReady: true })
    await bill(f)
    await db.query(
      `INSERT INTO tenant_credits (landlord_id, tenant_id, lease_id, amount_original, amount_remaining, category)
       VALUES ($1,$2,$3,300,300,'goodwill')`, [f.aLid, f.tenant1Id, f.lease1Id])
    for (const useCredit of [true, false]) {
      const res = await pay(f, { amount: useCredit ? 700 : 1000, paymentMethodId: 'pm_x', paymentMethodType: 'ach', useCredit })
      expect(res.status).toBe(422)
      expect(res.body.error).toMatch(/expectedCredit/)
    }
    expect(sent()).toEqual([])
    expect((await db.query(`SELECT 1 FROM tenant_remittances`)).rowCount).toBe(0)
  })

  // Fix pass 2: "Pay with credit — nothing charged" never reads a method, so a
  // tenant with no bank or card on file (no Stripe customer at all) may still
  // pay a bill their credit covers in full — no placeholder method needed.
  it('a credit-only pay-balance with no method succeeds, and nothing is charged', async () => {
    const f = await seed()
    await bill(f, 300)
    await db.query(
      `INSERT INTO tenant_credits (landlord_id, tenant_id, lease_id, amount_original, amount_remaining, category)
       VALUES ($1,$2,$3,300,300,'goodwill')`, [f.aLid, f.tenant1Id, f.lease1Id])
    const res = await pay(f, { amount: 0, useCredit: true, expectedCredit: 300 })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.data).toMatchObject({ status: 'settled', paidWithCredit: true, chargeAmount: 0, creditUsed: 300 })
    expect(sent()).toEqual([])
    const { rows } = await db.query<any>(`SELECT status FROM payments WHERE lease_id = $1`, [f.lease1Id])
    expect(rows.map((r: any) => r.status)).toEqual(['settled'])
  })

  it('a payment with money in it and no method is refused plainly, and nothing is charged', async () => {
    const f = await seed()
    await setupTenantForPay(f, { connectReady: true })
    await bill(f, 1000)
    await db.query(
      `INSERT INTO tenant_credits (landlord_id, tenant_id, lease_id, amount_original, amount_remaining, category)
       VALUES ($1,$2,$3,300,300,'goodwill')`, [f.aLid, f.tenant1Id, f.lease1Id])
    for (const body of [
      { amount: 700, useCredit: true, expectedCredit: 300 },
      { amount: 1000, useCredit: false, expectedCredit: 300 },
      { amount: 0, useCredit: true, expectedCredit: 300 },          // the credit does not cover the bill
      { amount: 700, paymentMethodType: 'ach', useCredit: true, expectedCredit: 300 },
    ]) {
      const res = await pay(f, body)
      expect(res.status, JSON.stringify(body)).toBe(422)
      expect(res.body.error).toBe('Choose a saved bank account or card to pay with.')
    }
    expect(sent()).toEqual([])
    expect((await db.query(`SELECT 1 FROM tenant_remittances`)).rowCount).toBe(0)
    const { rows } = await db.query<any>(`SELECT status, stripe_payment_intent_id FROM payments WHERE lease_id = $1`, [f.lease1Id])
    expect(rows).toEqual([{ status: 'pending', stripe_payment_intent_id: null }])
    expect((await db.query(`SELECT 1 FROM credit_uses`)).rowCount).toBe(0)
  })
})

describe('POST /api/payments/:id/pay', () => {
  it('POST /:id/pay is gone: 410 pointing to pay-balance, and nothing is charged', async () => {
    const f = await seed()
    await db.query(`UPDATE tenants SET stripe_customer_id='cus_t1' WHERE id=$1`, [f.tenant1Id])
    const pid = await seedPayment({ unitId: f.aUnitId, tenantId: f.tenant1Id, landlordId: f.aLid, leaseId: f.lease1Id })
    const res = await request(buildApp()).post(`/api/payments/${pid}/pay`)
      .set('Authorization', `Bearer ${f.tokenTenant1}`)
      .send({ paymentMethodId: 'pm_x', paymentMethodType: 'ach' })
    expect(res.status).toBe(410)
    expect(res.body.error).toMatch(/pay-balance/)
    expect(stripeConnect.createRentPlatformCharge).not.toHaveBeenCalled()
    const { rows: [p] } = await db.query<any>(`SELECT status FROM payments WHERE id=$1`, [pid])
    expect(p.status).toBe('pending')
  })
})

describe('POST /api/payments/:id/record-manual', () => {
  // S652 (Nic): the credit ledger only heard about Stripe settlements. A check
  // recorded at the desk three weeks late is a late payment too — same event,
  // same tier, landlord-attested with the check number as evidence.
  it('a check recorded late writes the same ledger event a card payment would', async () => {
    const f = await seed()
    // due a month ago, paid today: well past any grace. The bill was written
    // on its due date — a bill written late counts lateness from the day it
    // was written (S655 credit-history rules), which is not this case.
    const pid = await seedPayment({ unitId: f.aUnitId, tenantId: f.tenant1Id, landlordId: f.aLid, amount: 700, dueOffsetMonths: -1 })
    await db.query(`UPDATE payments SET created_at = due_date::timestamptz WHERE id = $1`, [pid])
    const res = await request(buildApp()).post(`/api/payments/${pid}/record-manual`)
      .set('Authorization', `Bearer ${f.tokenLandlordA}`)
      .send({ method: 'check', reference: 'CHK-77', amountTendered: 700 })
    expect(res.status).toBe(200)
    const { rows } = await db.query<any>(
      `SELECT ce.event_type, ce.attestation_source, ce.attestation_evidence, ce.event_data
         FROM credit_events ce JOIN credit_subjects cs ON cs.id = ce.subject_id
        WHERE cs.subject_type = 'tenant' AND cs.subject_ref_id = $1`, [f.tenant1Id])
    expect(rows).toHaveLength(1)
    expect(rows[0].event_type).toBe('payment_received_late_severe')
    expect(rows[0].attestation_source).toBe('landlord_self_reported_with_evidence')
    expect(rows[0].attestation_evidence).toMatchObject({ manual_method: 'check', reference: 'CHK-77' })
    expect(rows[0].event_data.payment_id).toBe(pid)
  })

  it('a check is recorded settled (no disbursement) and the response carries no fee fields', async () => {
    const f = await seed()
    const pid = await seedPayment({ unitId: f.aUnitId, tenantId: f.tenant1Id, landlordId: f.aLid, amount: 1000 })
    const res = await request(buildApp()).post(`/api/payments/${pid}/record-manual`)
      .set('Authorization', `Bearer ${f.tokenLandlordA}`)
      .send({ method: 'check', reference: 'CHK-1234', amountTendered: 1000 })
    expect(res.status).toBe(200)
    // S654 API contract: the fee machinery is gone, so are its response fields.
    for (const k of ['feeWaived', 'feeAmount', 'feeBilledTo', 'feePaymentId', 'firstPayment', 'coveredByLandlord']) {
      expect(res.body.data, k).not.toHaveProperty(k)
    }
    const { rows: [p] } = await db.query<any>(
      `SELECT status, manual_method, platform_held, stripe_payment_intent_id FROM payments WHERE id=$1`, [pid])
    expect(p.status).toBe('settled')            // paid everywhere that treats settled as paid
    expect(p.manual_method).toBe('check')
    expect(p.platform_held).toBe(false)         // ← batch skips it; landlord not double-paid
    expect(p.stripe_payment_intent_id).toBeNull()
    const { rows: fees } = await db.query<any>(
      `SELECT id FROM payments WHERE type='fee' AND tenant_id=$1`, [f.tenant1Id])
    expect(fees.length).toBe(0)
  })

  // S654 DIRECTIVE (Nic): "No charge for cash or checks anywhere in the
  // platform... There's no fee. Paying cash or check is free." Every payment,
  // every method, whoever the tenant is — nothing on either side.
  it('every manual payment is free — no fee row, no GAM revenue, no landlord charge', async () => {
    const f = await seed()
    // A prior settled rent, so this is not the tenant's first payment.
    await seedPayment({ unitId: f.aUnitId, tenantId: f.tenant1Id, landlordId: f.aLid, amount: 1000, status: 'settled', dueOffsetMonths: 0 })
    const methods = ['cash', 'check', 'money_order'] as const
    for (const [i, method] of methods.entries()) {
      const pid = await seedPayment({ unitId: f.aUnitId, tenantId: f.tenant1Id, landlordId: f.aLid, amount: 1000, dueOffsetMonths: i + 1 })
      const res = await request(buildApp()).post(`/api/payments/${pid}/record-manual`)
        .set('Authorization', `Bearer ${f.tokenLandlordA}`)
        .send({ method, amountTendered: 1000 })
      expect(res.status, method).toBe(200)
      expect(res.body.data.amountSettled, method).toBe(1000)
      const ledger = await db.query<any>(
        `SELECT id FROM platform_revenue_ledger WHERE reference_id=$1`, [pid])
      expect(ledger.rows, method).toHaveLength(0)
    }
    const fees = await db.query<any>(
      `SELECT id FROM payments WHERE type='fee' AND tenant_id=$1`, [f.tenant1Id])
    expect(fees.rows).toHaveLength(0)
    const charges = await db.query<any>(
      `SELECT id FROM landlord_gam_charges WHERE landlord_id=$1`, [f.aLid])
    expect(charges.rows).toHaveLength(0)
  })

  // S649 (Nic): "we need to be able to settle any outstanding balances at any
  // time." A household owing only a utility must still be recordable.
  it('a lone utility charge can be recorded', async () => {
    const f = await seed()
    const pid = await seedPayment({ unitId: f.aUnitId, tenantId: f.tenant1Id, landlordId: f.aLid, type: 'utility', amount: 50 })
    const res = await request(buildApp()).post(`/api/payments/${pid}/record-manual`)
      .set('Authorization', `Bearer ${f.tokenLandlordA}`).send({ method: 'cash', amountTendered: 50 })
    expect(res.status).toBe(200)
    const { rows: [p] } = await db.query<any>(`SELECT status, manual_method FROM payments WHERE id = $1`, [pid])
    expect(p).toEqual({ status: 'settled', manual_method: 'cash' })
  })

  it('already-settled charge → 409', async () => {
    const f = await seed()
    const pid = await seedPayment({ unitId: f.aUnitId, tenantId: f.tenant1Id, landlordId: f.aLid, status: 'settled' })
    const res = await request(buildApp()).post(`/api/payments/${pid}/record-manual`)
      .set('Authorization', `Bearer ${f.tokenLandlordA}`).send({ method: 'cash', amountTendered: 1000 })
    expect(res.status).toBe(409)
  })

  it('different landlord cannot record on another landlord’s charge → 403', async () => {
    const f = await seed()
    const pid = await seedPayment({ unitId: f.aUnitId, tenantId: f.tenant1Id, landlordId: f.aLid })
    const res = await request(buildApp()).post(`/api/payments/${pid}/record-manual`)
      .set('Authorization', `Bearer ${f.tokenLandlordB}`).send({ method: 'cash', amountTendered: 1000 })
    expect(res.status).toBe(403)
  })

  it('eviction mode (payment_block) → 409', async () => {
    const f = await seed()
    const pid = await seedPayment({ unitId: f.aUnitId, tenantId: f.tenant1Id, landlordId: f.aLid })
    await db.query(`UPDATE units SET payment_block=TRUE WHERE id=$1`, [f.aUnitId])
    const res = await request(buildApp()).post(`/api/payments/${pid}/record-manual`)
      .set('Authorization', `Bearer ${f.tokenLandlordA}`).send({ method: 'cash', amountTendered: 1000 })
    expect(res.status).toBe(409)
    expect(res.body.message || res.body.error).toMatch(/eviction/i)
  })

  it('invalid method → 400', async () => {
    const f = await seed()
    const pid = await seedPayment({ unitId: f.aUnitId, tenantId: f.tenant1Id, landlordId: f.aLid })
    const res = await request(buildApp()).post(`/api/payments/${pid}/record-manual`)
      .set('Authorization', `Bearer ${f.tokenLandlordA}`).send({ method: 'venmo', amountTendered: 1000 })
    expect(res.status).toBe(400)
  })

  it('record-manual requires the amount handed over', async () => {
    const f = await seed()
    const pid = await seedPayment({ unitId: f.aUnitId, tenantId: f.tenant1Id, landlordId: f.aLid })
    const res = await request(buildApp()).post(`/api/payments/${pid}/record-manual`)
      .set('Authorization', `Bearer ${f.tokenLandlordA}`).send({ method: 'check', reference: '1042' })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/amountTendered/)
    const { rows: [p] } = await db.query<any>(`SELECT status FROM payments WHERE id=$1`, [pid])
    expect(p.status).toBe('pending')
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

describe('GET /payments/balance-context — per-method price breakdown', () => {
  // These figures are checked against the real fee formula, not the file's $5
  // stand-in, because the charge prices with the same one.
  beforeEach(() => {
    (stripeConnect.computePlatformCut as ReturnType<typeof vi.fn>).mockImplementation((o: any) => processingFeeFor(o))
  })
  afterEach(() => {
    (stripeConnect.computePlatformCut as ReturnType<typeof vi.fn>).mockImplementation(() => 5.00)
  })

  it('prices bank, card and cash for the outstanding balance', async () => {
    const f = await seed()
    const prior = await seedPayment({ unitId: f.aUnitId, tenantId: f.tenant1Id, landlordId: f.aLid, amount: 450, leaseId: f.lease1Id })
    await db.query(`UPDATE payments SET status='settled', settled_at=NOW() WHERE id=$1`, [prior])
    await seedPayment({ unitId: f.aUnitId, tenantId: f.tenant1Id, landlordId: f.aLid, amount: 450, leaseId: f.lease1Id })

    const res = await request(buildApp()).get('/api/payments/balance-context')
      .set('Authorization', `Bearer ${f.tokenTenant1}`)
    expect(res.status).toBe(200)
    const lease = res.body.data.leases[0]
    const by = Object.fromEntries(lease.methodCosts.map((m: any) => [m.method, m]))
    expect(by.ach.total).toBeCloseTo(450 + PROCESSING_FEES.ACH_FLAT, 2)
    expect(by.card.total).toBeCloseTo(466.30, 2)
    // S654 (Nic): "Paying cash or check is free." The quote is the balance and
    // nothing else — the cheapest option on the invoice.
    expect(by.manual.total).toBeCloseTo(450, 2)
    expect(by.manual.fee).toBe(0)
    expect(by.manual.label).toMatch(/free/i)
    expect(by.manual.total).toBeLessThan(by.ach.total)
    expect(by.manual.total).toBeLessThan(by.card.total)
  })

  it('cash is free on a first payment too, and no fee-payer fields are sent', async () => {
    const f = await seed()
    await seedPayment({ unitId: f.aUnitId, tenantId: f.tenant1Id, landlordId: f.aLid, amount: 450, leaseId: f.lease1Id })

    const res = await request(buildApp()).get('/api/payments/balance-context')
      .set('Authorization', `Bearer ${f.tokenTenant1}`)
    const lease = res.body.data.leases[0]
    const manual = lease.methodCosts.find((m: any) => m.method === 'manual')
    expect(manual.fee).toBe(0)
    expect(manual.total).toBeCloseTo(450, 2)
    for (const k of ['manualFeePayer', 'manualFirstFree', 'manualFeeCoveredByLandlord', 'manualFeeFirstFree', 'manualFeeAbsorbed']) {
      expect(lease, k).not.toHaveProperty(k)
    }
  })

  // Review fix pass 2: each way to pay is priced as /pay-balance charges it.
  // 10/5: covering is one choice — bank AND card show no processing fee.
  it('fees the landlord covers show as none on bank and card, and a waiting tenant-payer platform fee is on top of both, never cash', async () => {
    const f = await seed()
    await db.query(
      `INSERT INTO property_allocation_rules (property_id, ach_fee_payer, card_fee_payer)
       VALUES ($1,'landlord','landlord')
       ON CONFLICT (property_id) DO UPDATE SET ach_fee_payer='landlord', card_fee_payer='landlord'`, [f.aPropId])
    await db.query(
      `INSERT INTO platform_fee_accruals
         (landlord_id, property_id, accrual_month, rate_per_unit, min_per_connect_account, total_amount, payer)
       VALUES ($1, $2, CURRENT_DATE, 2, 10, 20, 'tenant')`,
      [f.aLid, f.aPropId])
    await seedPayment({ unitId: f.aUnitId, tenantId: f.tenant1Id, landlordId: f.aLid, amount: 450, leaseId: f.lease1Id })

    const res = await request(buildApp()).get('/api/payments/balance-context')
      .set('Authorization', `Bearer ${f.tokenTenant1}`)
    expect(res.status).toBe(200)
    const by = Object.fromEntries(res.body.data.leases[0].methodCosts.map((m: any) => [m.method, m]))
    expect(by.ach).toMatchObject({ fee: 20, total: 470 })
    expect(by.card).toMatchObject({ fee: 20, total: 470 })
    expect(by.manual).toMatchObject({ fee: 0, total: 450 })

    // The bank figure shown is the bank figure the quote reads back.
    const q = await request(buildApp()).post('/api/payments/quote')
      .set('Authorization', `Bearer ${f.tokenTenant1}`).send({ method: 'ach' })
    expect(q.body.data.total).toBe(by.ach.total)
  })

  it('when the credit pays the whole bill, the used-credit prices carry no fee', async () => {
    const f = await seed()
    await seedPayment({ unitId: f.aUnitId, tenantId: f.tenant1Id, landlordId: f.aLid, amount: 300, leaseId: f.lease1Id })
    await db.query(
      `INSERT INTO tenant_credits (landlord_id, tenant_id, lease_id, amount_original, amount_remaining, category)
       VALUES ($1,$2,$3,300,300,'goodwill')`, [f.aLid, f.tenant1Id, f.lease1Id])
    const res = await request(buildApp()).get('/api/payments/balance-context')
      .set('Authorization', `Bearer ${f.tokenTenant1}`)
    const lease = res.body.data.leases[0]
    expect(lease.payIfUsed).toBe(0)
    for (const m of lease.methodCostsIfUsed) expect(m, m.method).toMatchObject({ fee: 0, total: 0 })
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
      `INSERT INTO property_allocation_rules (property_id, ach_fee_payer, card_fee_payer)
       VALUES ($1,'landlord','tenant')
       ON CONFLICT (property_id) DO UPDATE SET ach_fee_payer='landlord'`, [f.aPropId])

    // A SECOND tenant, in a second unit, at the SAME property.
    const c = await db.connect()
    let tenant2Id = '', tenant2UserId = '', unit2Id = '', lease2 = ''
    try {
      await c.query('BEGIN')
      unit2Id = await seedUnit(c, { propertyId: f.aPropId, landlordId: f.aLid })
      tenant2Id = await seedTenant(c)
      const r = await c.query<{ user_id: string }>(`SELECT user_id FROM tenants WHERE id=$1`, [tenant2Id])
      tenant2UserId = r.rows[0].user_id
      lease2 = await seedLease(c, { unitId: unit2Id, landlordId: f.aLid })
      await seedLeaseTenant(c, { leaseId: lease2, tenantId: tenant2Id, role: 'primary' })
      await c.query('COMMIT')
    } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
    const tokenTenant2 = sign({ userId: tenant2UserId, role: 'tenant', email: 't2@t.dev', profileId: tenant2Id })

    await seedPayment({ unitId: f.aUnitId, tenantId: f.tenant1Id, landlordId: f.aLid, amount: 450, leaseId: f.lease1Id })
    await seedPayment({ unitId: unit2Id,   tenantId: tenant2Id,   landlordId: f.aLid, amount: 450, leaseId: lease2 })

    const one = await request(buildApp()).get('/api/payments/balance-context')
      .set('Authorization', `Bearer ${f.tokenTenant1}`)
    const two = await request(buildApp()).get('/api/payments/balance-context')
      .set('Authorization', `Bearer ${tokenTenant2}`)

    expect(one.body.data.leases[0].methodCosts).toEqual(two.body.data.leases[0].methodCosts)
  })

  it('there is nowhere to store a per-tenant or per-lease fee setting', async () => {
    const cols = await db.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.columns
        WHERE column_name IN ('ach_fee_payer','card_fee_payer','platform_fee_payer')`)
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

// S622 (Nic, double-checking): "they definitely cannot in any way, shape, or
// form pay a partial amount on a current new charge. All new charges are paid in
// full, and that's that."
//
// The balance endpoint feeds the tenant's pay screen, and the screen disables
// its button below the floor it is given. If that floor is the WHOLE ledger, a
// tenant $1,000 behind can never attempt their rent — the server would take it,
// the screen never offers it. So the two figures have to be reported separately.
describe('S622: the balance endpoint separates arrears from what is due now', () => {
  it('reports requiredNow (the lease’s own charges) apart from the carried balance', async () => {
    const f = await seed()
    await db.query(
      `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description)
       VALUES ($1,$2,$3,$4,'rent',800,'pending','2026-09-01','RENT')`,
      [f.aUnitId, f.lease1Id, f.tenant1Id, f.aLid])
    await db.query(
      `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description)
       VALUES ($1,$2,$3,$4,'carried_balance',1000,'pending','2026-01-01','BALANCE')`,
      [f.aUnitId, f.lease1Id, f.tenant1Id, f.aLid])

    const res = await request(buildApp())
      .get('/api/payments/balance-context')
      .set('Authorization', `Bearer ${f.tokenTenant1}`)
    expect(res.status).toBe(200)

    const lease = (res.body.data.leases || []).find((l: any) => l.leaseId === f.lease1Id)
    expect(lease).toBeTruthy()
    expect(lease.outstanding).toBeCloseTo(1800, 2)   // everything owed
    expect(lease.carriedBalance).toBeCloseTo(1000, 2)
    // The floor the screen enforces — rent only. This is the number that decides
    // whether the tenant can pay their rent at all.
    expect(lease.requiredNow).toBeCloseTo(800, 2)
  })

  it('requiredNow equals outstanding when there are no arrears — unchanged for everyone else', async () => {
    const f = await seed()
    await db.query(
      `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description)
       VALUES ($1,$2,$3,$4,'rent',800,'pending','2026-09-01','RENT')`,
      [f.aUnitId, f.lease1Id, f.tenant1Id, f.aLid])

    const res = await request(buildApp())
      .get('/api/payments/balance-context')
      .set('Authorization', `Bearer ${f.tokenTenant1}`)
    const lease = (res.body.data.leases || []).find((l: any) => l.leaseId === f.lease1Id)
    expect(lease.requiredNow).toBeCloseTo(lease.outstanding, 2)
    expect(lease.carriedBalance).toBeCloseTo(0, 2)
  })
})

// S622 (Nic): "I've got three people in Oak Park that each have two spaces
// occupied, and I don't wanna just total it onto one lease because it is a
// completely separate unit... if somebody's behind on one and not on the other,
// I just wanna make sure how that flow goes."
//
// One tenant, two units under the SAME landlord, is deliberately allowed
// (S553 — space rent on two mobile homes). What matters here is that the two
// tenancies never bleed into each other: separate balances, separate floors, and
// a payment on one that cannot be swallowed by the other's arrears.
describe('S622: one tenant, two units, separate ledgers', () => {
  async function secondLease(f: any) {
    const c = await db.connect()
    try {
      await c.query('BEGIN')
      const unit2 = await seedUnit(c, { propertyId: f.aPropId, landlordId: f.aLid })
      const lease2 = await seedLease(c, { unitId: unit2, landlordId: f.aLid })
      await seedLeaseTenant(c, { leaseId: lease2, tenantId: f.tenant1Id, role: 'primary' })
      await c.query('COMMIT')
      return { unit2, lease2 }
    } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
  }

  it('reports each lease on its own, with its own floor', async () => {
    const f = await seed()
    const { unit2, lease2 } = await secondLease(f)

    // Space A: current on rent. Space B: behind, with imported arrears.
    await db.query(
      `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description)
       VALUES ($1,$2,$3,$4,'rent',500,'pending','2026-09-01','RENT')`,
      [f.aUnitId, f.lease1Id, f.tenant1Id, f.aLid])
    await db.query(
      `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description)
       VALUES ($1,$2,$3,$4,'rent',300,'pending','2026-09-01','RENT')`,
      [unit2, lease2, f.tenant1Id, f.aLid])
    await db.query(
      `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description)
       VALUES ($1,$2,$3,$4,'carried_balance',1000,'pending','2026-01-01','BALANCE')`,
      [unit2, lease2, f.tenant1Id, f.aLid])

    const res = await request(buildApp())
      .get('/api/payments/balance-context')
      .set('Authorization', `Bearer ${f.tokenTenant1}`)
    expect(res.status).toBe(200)

    const leases = res.body.data.leases || []
    const a = leases.find((l: any) => l.leaseId === f.lease1Id)
    const b = leases.find((l: any) => l.leaseId === lease2)
    expect(a).toBeTruthy()
    expect(b).toBeTruthy()

    // The clean space is untouched by the other's arrears.
    expect(a.outstanding).toBeCloseTo(500, 2)
    expect(a.requiredNow).toBeCloseTo(500, 2)
    expect(a.carriedBalance).toBeCloseTo(0, 2)

    // The behind one carries its own history, and its own floor.
    expect(b.outstanding).toBeCloseTo(1300, 2)
    expect(b.requiredNow).toBeCloseTo(300, 2)
    expect(b.carriedBalance).toBeCloseTo(1000, 2)
  })

  it('refuses to guess which lease a payment is for', async () => {
    const f = await seed()
    const { unit2, lease2 } = await secondLease(f)
    for (const [u, l] of [[f.aUnitId, f.lease1Id], [unit2, lease2]] as const) {
      await db.query(
        `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description)
         VALUES ($1,$2,$3,$4,'rent',500,'pending','2026-09-01','RENT')`,
        [u, l, f.tenant1Id, f.aLid])
    }
    // Two open balances and no lease named: paying "the balance" is ambiguous,
    // and guessing would silently pay the wrong space's rent.
    await expect(resolveTargetLease(f.tenant1Id, null))
      .rejects.toMatchObject({ statusCode: 400 })
    // Named explicitly, each resolves to itself.
    await expect(resolveTargetLease(f.tenant1Id, f.lease1Id)).resolves.toBe(f.lease1Id)
    await expect(resolveTargetLease(f.tenant1Id, lease2)).resolves.toBe(lease2)
  })
})


// ─── S636: cash pays the balance, not a line ─────────────────────────────────
//
// Nic (DIRECTIVE): "When I apply a manual payment, it needs to be the same as a
// card payment. It applies to the entire balance. Those need to not be
// separated... I can't apply cash to one or the other. That also makes it so a
// landlord could pick and choose and apply it only to, you know, not the most
// outstanding thing."
//
// record-manual settled `WHERE id = $1`, so a landlord holding a resident's cash
// picked which of their charges it cleared — and could leave the oldest one
// standing while marking a newer one paid.
// ── S637: the settle covers the WHOLE balance, whichever charge carries it ─
//
// Nic: "submit button to record payment doesnt click and do anything." The UI
// posted an arbitrary first charge and the route refused anything but rent.
// S649 (Nic): any open charge may carry it now — "if it's outstanding, we
// should be able to reconcile it" — and it still clears the whole balance.
describe('S637 record-manual settles the whole balance from any charge', () => {
  it('a utility charge carries the payment and clears the rent with it', async () => {
    const f = await seed()
    const { rows: [{ id }] } = await db.query<{ id: string }>(
      `INSERT INTO payments (unit_id, tenant_id, landlord_id, lease_id, type, amount,
                             status, entry_description, due_date)
       VALUES ($1,$2,$3,$4,'utility',84,'pending','UTILITY',CURRENT_DATE) RETURNING id`,
      [f.aUnitId, f.tenant1Id, f.aLid, f.lease1Id])
    const { rows: [{ id: rentId }] } = await db.query<{ id: string }>(
      `INSERT INTO payments (unit_id, tenant_id, landlord_id, lease_id, type, amount,
                             status, entry_description, due_date)
       VALUES ($1,$2,$3,$4,'rent',440,'pending','RENT',CURRENT_DATE) RETURNING id`,
      [f.aUnitId, f.tenant1Id, f.aLid, f.lease1Id])
    const res = await request(buildApp())
      .post(`/api/payments/${id}/record-manual`)
      .set('Authorization', `Bearer ${f.tokenLandlordA}`)
      .send({ method: 'cash', amountTendered: 524 })
    expect(res.status).toBe(200)
    const { rows: [r] } = await db.query<any>(`SELECT status FROM payments WHERE id = $1`, [rentId])
    expect(r.status).toBe('settled')
  })

  it('accepts the rent charge and clears the utilities with it', async () => {
    const f = await seed()
    const { rows: [{ id: rentId }] } = await db.query<{ id: string }>(
      `INSERT INTO payments (unit_id, tenant_id, landlord_id, lease_id, type, amount,
                             status, entry_description, due_date)
       VALUES ($1,$2,$3,$4,'rent',440,'pending','RENT',CURRENT_DATE) RETURNING id`,
      [f.aUnitId, f.tenant1Id, f.aLid, f.lease1Id])
    await db.query(
      `INSERT INTO payments (unit_id, tenant_id, landlord_id, lease_id, type, amount,
                             status, entry_description, due_date)
       VALUES ($1,$2,$3,$4,'utility',84,'pending','UTILITY',CURRENT_DATE)`,
      [f.aUnitId, f.tenant1Id, f.aLid, f.lease1Id])
    const res = await request(buildApp())
      .post(`/api/payments/${rentId}/record-manual`)
      .set('Authorization', `Bearer ${f.tokenLandlordA}`)
      .send({ method: 'cash', amountTendered: 524 })
    expect(res.status).toBe(200)
    const { rows } = await db.query<any>(
      `SELECT type, status FROM payments WHERE lease_id=$1 AND type IN ('rent','utility')`,
      [f.lease1Id])
    expect(rows.every((r: any) => r.status === 'settled')).toBe(true)
  })
})

describe('S636 a manual payment settles the whole balance', () => {
  /** One lease carrying rent + two utility charges, the shape Nic was looking at. */
  async function seedBalance(f: any, opts: { suspendUtilities?: boolean } = {}) {
    const mk = async (type: string, amount: number, suspended = false) => {
      const { rows: [{ id }] } = await db.query<{ id: string }>(
        `INSERT INTO payments (unit_id, tenant_id, landlord_id, lease_id, type, amount,
                               status, entry_description, due_date, work_trade_suspended_at)
         VALUES ($1,$2,$3,$4,$5,$6,'pending',$7,CURRENT_DATE,$8) RETURNING id`,
        [f.aUnitId, f.tenant1Id, f.aLid, f.lease1Id, type, amount,
         type.toUpperCase(), suspended ? new Date().toISOString() : null])
      return id
    }
    const rentPaymentId = await mk('rent', 1000)
    await mk('utility', 120, !!opts.suspendUtilities)
    await mk('utility', 45, !!opts.suspendUtilities)
    return { rentPaymentId, leaseId: f.lease1Id }
  }

  it('clears every outstanding charge on the lease, not just the one clicked', async () => {
    const f = await seed()
    const b = await seedBalance(f)
    const res = await request(buildApp())
      .post(`/api/payments/${b.rentPaymentId}/record-manual`)
      .set('Authorization', `Bearer ${f.tokenLandlordA}`)
      .send({ method: 'cash', amountTendered: 1165 })
    expect(res.status).toBe(200)

    const { rows } = await db.query<{ status: string; type: string }>(
      `SELECT status, type FROM payments WHERE lease_id = $1 AND type <> 'fee'`, [b.leaseId])
    const unpaid = rows.filter(r => r.status !== 'settled')
    expect(unpaid, `these were left outstanding after cash was taken: ${JSON.stringify(unpaid)}`)
      .toEqual([])
  })

  it('leaves work-trade suspended charges alone — labor already covers them', async () => {
    const f = await seed()
    const b = await seedBalance(f, { suspendUtilities: true })
    await request(buildApp())
      .post(`/api/payments/${b.rentPaymentId}/record-manual`)
      .set('Authorization', `Bearer ${f.tokenLandlordA}`)
      .send({ method: 'cash', amountTendered: 1000 }).expect(200)

    const { rows } = await db.query<{ status: string }>(
      `SELECT status FROM payments
        WHERE lease_id = $1 AND work_trade_suspended_at IS NOT NULL`, [b.leaseId])
    expect(rows.length).toBeGreaterThan(0)
    // Collecting these would take rent the resident's hours already paid.
    expect(rows.every(r => r.status === 'pending')).toBe(true)
  })
})

// ─── S637: a cash overpayment can be kept as credit ──────────────────────────
//
// Nic: "If somebody were to come in with five hundred dollars for four hundred
// and sixty dollar rent, they would probably expect forty dollar change. But if
// they wanted to leave it as credit for the future, that should also be a 'hey,
// I'm clicking that I didn't give them change, add forty dollar credit to their
// account' sort of thing."
//
// The desk already had a tendered box and computed change on screen, but the
// number never reached the server — so cash was the one way into the ledger
// that could not pay ahead, while a card overpayment banked a credit and next
// month's rent ate it automatically.
describe('S637 manual cash overpayment', () => {
  async function openRent(f: any, amount = 1000) {
    const { rows: [{ id }] } = await db.query<{ id: string }>(
      `INSERT INTO payments (unit_id, tenant_id, landlord_id, lease_id, type, amount, status, entry_description, due_date)
       VALUES ($1,$2,$3,$4,'rent',$5,'pending','RENT',CURRENT_DATE) RETURNING id`,
      [f.aUnitId, f.tenant1Id, f.aLid, f.lease1Id, amount])
    return id
  }
  const creditsFor = async (leaseId: string) => (await db.query<{ total: string }>(
    `SELECT COALESCE(SUM(amount_remaining),0)::text AS total
       FROM lease_prepaid_credits WHERE lease_id = $1`, [leaseId])).rows[0].total

  it('keeps the surplus as a credit when the landlord says they gave no change', async () => {
    const f = await seed()
    const pid = await openRent(f, 460)
    const res = await request(buildApp()).post(`/api/payments/${pid}/record-manual`)
      .set('Authorization', `Bearer ${f.tokenLandlordA}`)
      .send({ method: 'cash', amountTendered: 500, surplusHandling: 'credit' })
    expect(res.status).toBe(200)
    expect(res.body.data.amountSettled).toBe(460)
    expect(res.body.data.surplus).toBe(40)
    expect(res.body.data.creditId).toBeTruthy()
    expect(Number(await creditsFor(f.lease1Id))).toBe(40)
  })

  // S637 (Nic, DIRECTIVE): "It needs to be manually clicked by the person taking
  // the cash. That way no mistakes could happen." A surplus with no answer is
  // refused outright — the server does not pick a side on the desk's behalf.
  it('refuses a surplus with no stated answer, and settles nothing', async () => {
    const f = await seed()
    const pid = await openRent(f, 460)
    const res = await request(buildApp()).post(`/api/payments/${pid}/record-manual`)
      .set('Authorization', `Bearer ${f.tokenLandlordA}`)
      .send({ method: 'cash', amountTendered: 500 })      // no surplusHandling
    expect(res.status).toBe(422)
    expect(res.body.error).toMatch(/Give \$40\.00 change.*Keep \$40\.00 as credit/i)
    const { rows: [p] } = await db.query<any>(`SELECT status FROM payments WHERE id=$1`, [pid])
    expect(p.status).toBe('pending')
    expect(Number(await creditsFor(f.lease1Id))).toBe(0)
  })

  // Exact money is not a surplus, so it needs no answer.
  it('does not ask when the cash is exact', async () => {
    const f = await seed()
    const pid = await openRent(f, 460)
    const res = await request(buildApp()).post(`/api/payments/${pid}/record-manual`)
      .set('Authorization', `Bearer ${f.tokenLandlordA}`)
      .send({ method: 'cash', amountTendered: 460 })
    expect(res.status).toBe(200)
    expect(res.body.data.surplus).toBe(0)
  })

  it('records nothing when the change was handed back', async () => {
    const f = await seed()
    const pid = await openRent(f, 460)
    const res = await request(buildApp()).post(`/api/payments/${pid}/record-manual`)
      .set('Authorization', `Bearer ${f.tokenLandlordA}`)
      .send({ method: 'cash', amountTendered: 500, surplusHandling: 'change' })
    expect(res.status).toBe(200)
    expect(res.body.data.surplus).toBe(40)
    expect(res.body.data.creditId).toBeNull()
    expect(Number(await creditsFor(f.lease1Id))).toBe(0)   // it left with them
  })

  // The surplus is measured against the LEDGER, not against whatever the desk
  // believes is due — a stale screen must not be able to invent a credit.
  it('derives the surplus from what is owed, not from the caller', async () => {
    const f = await seed()
    const pid = await openRent(f, 460)
    // A utility on the same lease — cash sweeps the whole balance (S636), and
    // rent is one-per-due-date, so this is the realistic second row.
    await db.query(
      `INSERT INTO payments (unit_id, tenant_id, landlord_id, lease_id, type, amount, status, entry_description, due_date)
       VALUES ($1,$2,$3,$4,'utility',100,'pending','UTILITY',CURRENT_DATE)`,
      [f.aUnitId, f.tenant1Id, f.aLid, f.lease1Id])
    const res = await request(buildApp()).post(`/api/payments/${pid}/record-manual`)
      .set('Authorization', `Bearer ${f.tokenLandlordA}`)
      .send({ method: 'cash', amountTendered: 600, surplusHandling: 'credit' })
    expect(res.status).toBe(200)
    expect(res.body.data.amountSettled).toBe(560)   // both charges
    expect(res.body.data.surplus).toBe(40)          // not 140
    expect(Number(await creditsFor(f.lease1Id))).toBe(40)
  })

  it('refuses a short cash entry — rent is paid in full', async () => {
    const f = await seed()
    const pid = await openRent(f, 460)
    const res = await request(buildApp()).post(`/api/payments/${pid}/record-manual`)
      .set('Authorization', `Bearer ${f.tokenLandlordA}`)
      .send({ method: 'cash', amountTendered: 420 })
    expect(res.status).toBe(422)
    expect(res.body.error).toMatch(/short|paid in full/i)
    const { rows: [p] } = await db.query<any>(`SELECT status FROM payments WHERE id=$1`, [pid])
    expect(p.status).toBe('pending')                // nothing settled
  })

  // S637 (Nic): "A check or money order, it is possible that they wrote it for
  // more than they owe, which is my exact situation right now — a $920 check
  // written on a $460 rent." Two months paid ahead, on paper.
  it('a check written over the balance banks the remainder, once the written amount is confirmed', async () => {
    const f = await seed()
    const pid = await openRent(f, 460)
    // 10/3 (Kim Harland's $0.55): the desk first confirms what is written on it.
    const ask = await request(buildApp()).post(`/api/payments/${pid}/record-manual`)
      .set('Authorization', `Bearer ${f.tokenLandlordA}`)
      .send({ method: 'check', reference: '1042', amountTendered: 920, surplusHandling: 'credit' })
    expect(ask.status).toBe(422)
    expect(ask.body.error).toMatch(/You typed \$920\.00 against \$460\.00 owed — is the check really \$920\.00\?/)
    expect(Number(await creditsFor(f.lease1Id))).toBe(0)
    const res = await request(buildApp()).post(`/api/payments/${pid}/record-manual`)
      .set('Authorization', `Bearer ${f.tokenLandlordA}`)
      .send({ method: 'check', reference: '1042', amountTendered: 920, surplusHandling: 'credit', confirmWrittenAmount: true })
    expect(res.status).toBe(200)
    expect(res.body.data.amountSettled).toBe(460)
    expect(res.body.data.surplus).toBe(460)          // exactly next month
    expect(Number(await creditsFor(f.lease1Id))).toBe(460)
    // The check number survives as the receipt.
    const { rows: [p] } = await db.query<any>(`SELECT notes FROM payments WHERE id=$1`, [pid])
    expect(p.notes).toMatch(/1042/)
  })

  // S655: the paid-ahead money is the landlord's (they hold the check), dated
  // the day it was taken, and tied to the desk receipt.
  it('the credit kept from cash is landlord-held paid-ahead money linked to the receipt', async () => {
    const f = await seed()
    const pid = await openRent(f, 460)
    const res = await request(buildApp()).post(`/api/payments/${pid}/record-manual`)
      .set('Authorization', `Bearer ${f.tokenLandlordA}`)
      .send({ method: 'cash', amountTendered: 500, surplusHandling: 'credit' })
    expect(res.status).toBe(200)
    const { rows: [c] } = await db.query<any>(
      `SELECT funded_by, received_at IS NOT NULL AS dated, source_remittance_id FROM lease_prepaid_credits WHERE id=$1`,
      [res.body.data.creditId])
    expect(c).toEqual({ funded_by: 'landlord', dated: true, source_remittance_id: res.body.data.receiptId })
    const { rows: [r] } = await db.query<any>(
      `SELECT amount::float AS amount, applied_amount::float AS applied, unapplied_amount::float AS unapplied,
              gross_amount, payment_method FROM tenant_remittances WHERE id=$1`, [res.body.data.receiptId])
    expect(r).toEqual({ amount: 500, applied: 460, unapplied: 40, gross_amount: null, payment_method: 'cash' })
  })

  it('change handed back is not in the drawer: the receipt is what was kept', async () => {
    const f = await seed()
    const pid = await openRent(f, 460)
    const res = await request(buildApp()).post(`/api/payments/${pid}/record-manual`)
      .set('Authorization', `Bearer ${f.tokenLandlordA}`)
      .send({ method: 'cash', amountTendered: 500, surplusHandling: 'change' })
    expect(res.status).toBe(200)
    expect(res.body.data.changeGiven).toBe(40)
    const { rows: [r] } = await db.query<any>(
      `SELECT amount::float AS amount, notes FROM tenant_remittances WHERE id=$1`, [res.body.data.receiptId])
    expect(r.amount).toBe(460)
    expect(r.notes).toMatch(/Handed over \$500\.00; \$40\.00 given back as change/)
  })
})

// ─── S637: the question Nic asked ────────────────────────────────────────────
//
//   "Say they pay five hundred now and get a forty dollar credit. Well, next
//    month, they would technically owe four twenty instead of the four sixty
//    normally applied. If they came in with the four twenty, is it gonna try to
//    say that that's a partial payment because the lease says four sixty, or
//    does it calculate it off of what's actually outstanding?"
//
// It calculates off what is outstanding: rentCharge nets BOTH credit tables
// before the pay-in-full gate. This proves the whole round trip — cash surplus
// in, reduced amount accepted next month — because the two halves live in
// different files and only meet in production.
describe('S637 a credit reduces what is owed next month', () => {
  it('cash surplus becomes a credit, and the reduced amount is not a partial', async () => {
    const f = await seed()
    const { rows: [{ id: septRent }] } = await db.query<{ id: string }>(
      `INSERT INTO payments (unit_id, tenant_id, landlord_id, lease_id, type, amount, status, entry_description, due_date)
       VALUES ($1,$2,$3,$4,'rent',460,'pending','RENT',CURRENT_DATE) RETURNING id`,
      [f.aUnitId, f.tenant1Id, f.aLid, f.lease1Id])

    // $500 cash against $460, kept as credit.
    const paid = await request(buildApp()).post(`/api/payments/${septRent}/record-manual`)
      .set('Authorization', `Bearer ${f.tokenLandlordA}`)
      .send({ method: 'cash', amountTendered: 500, surplusHandling: 'credit' })
    expect(paid.status).toBe(200)
    expect(paid.body.data.surplus).toBe(40)

    // Next month's rent, at the lease's full face amount.
    const { rows: [{ id: octRent }] } = await db.query<{ id: string }>(
      `INSERT INTO payments (unit_id, tenant_id, landlord_id, lease_id, type, amount, status, entry_description, due_date)
       VALUES ($1,$2,$3,$4,'rent',460,'pending','RENT',CURRENT_DATE + 31) RETURNING id`,
      [f.aUnitId, f.tenant1Id, f.aLid, f.lease1Id])
    expect(octRent).toBeTruthy()

    // The credit is live and worth exactly the surplus — this is the figure
    // rentCharge subtracts before it tests for a partial payment.
    const { rows: [c] } = await db.query<{ total: string }>(
      `SELECT COALESCE(SUM(amount_remaining),0)::text AS total
         FROM lease_prepaid_credits WHERE lease_id=$1`, [f.lease1Id])
    expect(Number(c.total)).toBe(40)
  })
})

// ─── S637: work-trade suspended charges are not a balance ────────────────────
//
// Nic: "Work trade is still showing people they owe a full balance."
//
// A suspended row settles at month close against approved hours — it is never
// money the resident hands over. Four places already knew that (the settlement
// job, the move-in bundle, the manual settle, utility billing); the two the
// TENANT actually sees did not. Tyler Rhoades was shown $687.57 owing on Oak
// Park RV 03 and Matthew Conklin $776.11, every dollar of it covered by labor.
describe('S637 work-trade suspended charges', () => {
  it('are left out of the balance the tenant is shown', async () => {
    const f = await seed()
    const { rows: [rent] } = await db.query<{ id: string }>(
      `INSERT INTO payments (unit_id, tenant_id, landlord_id, lease_id, type, amount, status, entry_description, due_date)
       VALUES ($1,$2,$3,$4,'rent',440,'pending','RENT',CURRENT_DATE) RETURNING id`,
      [f.aUnitId, f.tenant1Id, f.aLid, f.lease1Id])
    await db.query(
      `INSERT INTO payments (unit_id, tenant_id, landlord_id, lease_id, type, amount, status, entry_description, due_date, work_trade_suspended_at)
       VALUES ($1,$2,$3,$4,'utility',247.57,'pending','UTILITY',CURRENT_DATE, NOW())`,
      [f.aUnitId, f.tenant1Id, f.aLid, f.lease1Id])

    // The ledger groups by lease; sum what each group says is outstanding.
    const owed = async () => {
      const r = await request(buildApp()).get('/api/payments/balance-context')
        .set('Authorization', `Bearer ${f.tokenTenant1}`)
      expect(r.status).toBe(200)
      const groups = (r.body.data.leases ?? r.body.data.groups ?? []) as any[]
      return groups.reduce((s, g) => s + Number(g.outstanding || 0), 0)
    }

    // The suspended utility is absent; only the cash-owed rent counts.
    expect(await owed()).toBe(440)

    // And with the rent suspended too, they owe nothing at all.
    await db.query(`UPDATE payments SET work_trade_suspended_at = NOW() WHERE id = $1`, [rent.id])
    expect(await owed()).toBe(0)
  })
})

// ─── S638: the desk asks for what is owed, credit already off ────────────────
//
// Nic, with the resident standing at the counter: "The outstanding balances page
// is correctly showing $485.45, but on the payments page it's still showing
// $935.45... When I go to record payment, it still thinks she owes the full
// amount, and the payments page does not take partial payments."
//
// Kim Harland held a $450 credit against a $935.45 bill. record-manual computed
// what was owed from the charge rows alone, so it wanted the gross — and since
// rent is pay-in-full, $485.45 came back as short. She could not pay.
describe('S638 a credit reduces what the desk collects', () => {
  it('accepts the net and spends the credit', async () => {
    const f = await seed()
    const { rows: [rent] } = await db.query<{ id: string }>(
      `INSERT INTO payments (unit_id, tenant_id, landlord_id, lease_id, type, amount, status, entry_description, due_date)
       VALUES ($1,$2,$3,$4,'rent',900,'pending','RENT',CURRENT_DATE) RETURNING id`,
      [f.aUnitId, f.tenant1Id, f.aLid, f.lease1Id])
    await db.query(
      `INSERT INTO tenant_credits (landlord_id, tenant_id, lease_id, amount_original, amount_remaining, category)
       VALUES ($1,$2,$3,450,450,'goodwill')`, [f.aLid, f.tenant1Id, f.lease1Id])

    // S655 (Nic, 10/2): the desk is ASKED — "credit available $450" — and
    // must answer Use or Save; the credit is never netted by itself (bug 2).
    const unasked = await request(buildApp()).post(`/api/payments/${rent.id}/record-manual`)
      .set('Authorization', `Bearer ${f.tokenLandlordA}`)
      .send({ method: 'cash', amountTendered: 450 })
    expect(unasked.status).toBe(422)
    expect(unasked.body.error).toMatch(/Use \$450\.00 or Save/)
    const res = await request(buildApp()).post(`/api/payments/${rent.id}/record-manual`)
      .set('Authorization', `Bearer ${f.tokenLandlordA}`)
      .send({ method: 'cash', amountTendered: 450, creditToUse: 450 })
    expect(res.status).toBe(200)
    expect(res.body.data.amountSettled).toBe(450)   // 900 less the 450 credit
    expect(res.body.data.creditUsed).toBe(450)

    const { rows: [c] } = await db.query<{ amount_remaining: string }>(
      `SELECT amount_remaining::text FROM tenant_credits WHERE tenant_id=$1`,
      [f.tenant1Id])
    expect(Number(c.amount_remaining)).toBe(0)     // spent, once, against the total
    const { rows: [p] } = await db.query<{ status: string }>(
      `SELECT status FROM payments WHERE id=$1`, [rent.id])
    expect(p.status).toBe('settled')
  })

  it('still refuses a genuinely short payment, credit and all', async () => {
    const f = await seed()
    const { rows: [rent] } = await db.query<{ id: string }>(
      `INSERT INTO payments (unit_id, tenant_id, landlord_id, lease_id, type, amount, status, entry_description, due_date)
       VALUES ($1,$2,$3,$4,'rent',900,'pending','RENT',CURRENT_DATE) RETURNING id`,
      [f.aUnitId, f.tenant1Id, f.aLid, f.lease1Id])
    await db.query(
      `INSERT INTO tenant_credits (landlord_id, tenant_id, lease_id, amount_original, amount_remaining, category)
       VALUES ($1,$2,$3,450,450,'goodwill')`, [f.aLid, f.tenant1Id, f.lease1Id])

    const res = await request(buildApp()).post(`/api/payments/${rent.id}/record-manual`)
      .set('Authorization', `Bearer ${f.tokenLandlordA}`)
      .send({ method: 'cash', amountTendered: 400, creditToUse: 450 })   // net owed is 450
    expect(res.status).toBe(422)
    const { rows: [p] } = await db.query<{ status: string }>(
      `SELECT status FROM payments WHERE id=$1`, [rent.id])
    expect(p.status).toBe('pending')
  })
})

// ─── S639: A TIE IS NOT AN ORDER ────────────────────────────────────────────
//
// Nic: "on the outstanding balances tab six leases that are all overdue, and on
// the payments tab it's only showing five... The outstanding balance still has
// Steven Starr. The payments tab, his name is removed from."
//
// Rent and utilities are all billed on the 1st, so every one of Nic's 52
// payments carried the SAME due_date. `ORDER BY due_date DESC` was therefore one
// flat tie, LIMIT 50 dropped an arbitrary two of them, and Steven Starr's $589
// rent and $264.39 utilities were missing from the screen the desk collects
// money from — with nothing on the page to say so.
describe('S639 GET /api/payments — paging is stable when every due_date ties', () => {
  it('never loses or repeats a row across pages', async () => {
    const f = await seed()
    // Nic's real shape: everything due the same day. Utilities, because one
    // active RENT charge per unit per due date is uniquely constrained — which
    // is correct, and is not what broke.
    const ids = new Set<string>()
    for (let i = 0; i < 12; i++) {
      ids.add(await seedPayment({
        unitId: f.aUnitId, tenantId: f.tenant1Id, landlordId: f.aLid,
        type: 'utility', amount: 100 + i, dueOffsetMonths: 0,
      }))
    }
    const app = buildApp()
    const p1 = await request(app).get('/api/payments?limit=5&page=1')
      .set('Authorization', `Bearer ${f.tokenLandlordA}`)
    const p2 = await request(app).get('/api/payments?limit=5&page=2')
      .set('Authorization', `Bearer ${f.tokenLandlordA}`)
    const p3 = await request(app).get('/api/payments?limit=5&page=3')
      .set('Authorization', `Bearer ${f.tokenLandlordA}`)
    expect(p1.status).toBe(200)
    expect(p1.body.total).toBe(12)

    const seen = [...p1.body.data, ...p2.body.data, ...p3.body.data].map((r: any) => r.id)
    // Nothing shown twice…
    expect(new Set(seen).size).toBe(seen.length)
    // …and nothing missed. This is the assertion that was false before: two of
    // Nic's rows existed and appeared on no page at all.
    for (const id of ids) expect(seen).toContain(id)
  })

  it('the same request twice returns the same order', async () => {
    const f = await seed()
    for (let i = 0; i < 8; i++) {
      await seedPayment({ unitId: f.aUnitId, tenantId: f.tenant1Id, landlordId: f.aLid,
                          type: 'utility', amount: 200 + i, dueOffsetMonths: 0 })
    }
    const app = buildApp()
    const a = await request(app).get('/api/payments?limit=4&page=1')
      .set('Authorization', `Bearer ${f.tokenLandlordA}`)
    const b = await request(app).get('/api/payments?limit=4&page=1')
      .set('Authorization', `Bearer ${f.tokenLandlordA}`)
    expect(a.body.data.map((r: any) => r.id)).toEqual(b.body.data.map((r: any) => r.id))
  })

  it('reports the true total so the page can tell it is not showing everything', async () => {
    const f = await seed()
    for (let i = 0; i < 7; i++) {
      await seedPayment({ unitId: f.aUnitId, tenantId: f.tenant1Id, landlordId: f.aLid,
                          type: 'utility', amount: 300 + i, dueOffsetMonths: 0 })
    }
    const res = await request(buildApp()).get('/api/payments?limit=3')
      .set('Authorization', `Bearer ${f.tokenLandlordA}`)
    expect(res.body.data.length).toBe(3)
    expect(res.body.total).toBe(7)
    expect(res.body.totalPages).toBe(3)
  })

  it('a caller can ask for the whole set, and the limit is clamped', async () => {
    const f = await seed()
    for (let i = 0; i < 6; i++) {
      await seedPayment({ unitId: f.aUnitId, tenantId: f.tenant1Id, landlordId: f.aLid,
                          type: 'utility', amount: 400 + i, dueOffsetMonths: 0 })
    }
    const app = buildApp()
    const all = await request(app).get('/api/payments?limit=1000')
      .set('Authorization', `Bearer ${f.tokenLandlordA}`)
    expect(all.body.data.length).toBe(6)
    // A query string must not be able to turn this into an unbounded scan.
    const huge = await request(app).get('/api/payments?limit=999999')
      .set('Authorization', `Bearer ${f.tokenLandlordA}`)
    expect(huge.status).toBe(200)
    expect(huge.body.totalPages).toBe(1)
  })
})

// S654: the date the desk types is the date that lands, on any host. A bare
// 'YYYY-MM-DDT12:00:00' was read in the HOST's zone; noon UTC is the same
// calendar day in every US zone.
describe('S654 POST /post-payment — receivedAt keeps its calendar day', () => {
  // The host clock is pinned far from UTC for this test, so it fails the old
  // host-local parse on ANY machine — on a UTC host the bug was invisible.
  let hostTz: string | undefined
  beforeEach(() => { hostTz = process.env.TZ; process.env.TZ = 'Pacific/Kiritimati' })   // UTC+14
  afterEach(() => { if (hostTz === undefined) delete process.env.TZ; else process.env.TZ = hostTz })

  it('a check received 2026-09-09 is dated 2026-09-09, noon UTC', async () => {
    expect(new Date('2026-09-09T12:00:00').toISOString()).not.toBe('2026-09-09T12:00:00.000Z')
    const f = await seed()
    const token = sign({ userId: f.aUid, role: 'landlord', email: 'a@t.dev',
                         profileId: null, landlordIds: [f.aLid], permissions: {} })
    const res = await request(buildApp()).post('/api/payments/post-payment')
      .set('Authorization', `Bearer ${token}`)
      .send({ tenantId: f.tenant1Id, method: 'check', amount: 100, receivedAt: '2026-09-09' })
    expect(res.status).toBe(200)
    const { rows: [r] } = await db.query<{ phx: string; utc: string }>(
      `SELECT (settled_at AT TIME ZONE 'America/Phoenix')::date::text AS phx,
              to_char(settled_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI') AS utc
         FROM tenant_remittances WHERE id = $1`, [res.body.data.remittanceId])
    expect(r.phx).toBe('2026-09-09')
    expect(r.utc).toBe('2026-09-09 12:00')
  })
})

// ─── S655 (money plan Step 8): the full balance, credit beside it ────────────
describe('S655 the credit prompt on the tenant and desk screens', () => {
  async function seedBill(f: Fixture) {
    const rent = await seedPayment({ unitId: f.aUnitId, tenantId: f.tenant1Id, landlordId: f.aLid, amount: 900, leaseId: f.lease1Id })
    // GAM's own charge on the same bill (an ACH return fee) — paid online, never by credit.
    await db.query(
      `INSERT INTO payments (unit_id, tenant_id, landlord_id, lease_id, type, amount, status, entry_description, due_date, revenue_owner)
       VALUES ($1,$2,$3,$4,'fee',15,'pending','RETURNFEE',CURRENT_DATE,'gam')`,
      [f.aUnitId, f.tenant1Id, f.aLid, f.lease1Id])
    // $100 the landlord gave and $50 paid ahead at the desk.
    await db.query(
      `INSERT INTO tenant_credits (landlord_id, tenant_id, lease_id, amount_original, amount_remaining, category)
       VALUES ($1,$2,$3,100,100,'goodwill')`, [f.aLid, f.tenant1Id, f.lease1Id])
    await db.query(
      `INSERT INTO lease_prepaid_credits (lease_id, tenant_id, amount_original, amount_remaining, funded_by, received_at)
       VALUES ($1,$2,50,50,'landlord',NOW())`, [f.lease1Id, f.tenant1Id])
    return rent
  }

  it('balance-context shows the full balance, usable credit including paid-ahead, and GAM charges separately', async () => {
    const f = await seed()
    await seedBill(f)
    const res = await request(buildApp()).get('/api/payments/balance-context')
      .set('Authorization', `Bearer ${f.tokenTenant1}`)
    expect(res.status).toBe(200)
    const lease = res.body.data.leases.find((l: any) => l.leaseId === f.lease1Id)
    expect(lease.outstanding).toBe(915)                 // the whole bill, nothing netted
    expect(lease.usableCredit).toBe(150)                // $100 given + $50 paid ahead
    expect(lease.expectedCredit).toBe(150)
    expect(lease.payIfSaved).toBe(915)
    expect(lease.payIfUsed).toBe(765)
    expect(lease.coversWholeBill).toBe(false)
    expect(lease.gamCharges).toBe(15)
    expect(lease.creditOnFile).toBe(150)
  })

  it('the tenant quote prices both answers and says what to send back', async () => {
    const f = await seed()
    await seedBill(f)
    const save = await request(buildApp()).post('/api/payments/quote')
      .set('Authorization', `Bearer ${f.tokenTenant1}`).send({ method: 'ach' })
    expect(save.status).toBe(200)
    expect(save.body.data).toMatchObject({ outstanding: 915, usableCredit: 150, expectedCredit: 150, base: 915, useCredit: false })
    const use = await request(buildApp()).post('/api/payments/quote')
      .set('Authorization', `Bearer ${f.tokenTenant1}`).send({ method: 'ach', useCredit: true })
    expect(use.body.data).toMatchObject({ base: 765, creditUsed: 150, useCredit: true })
    expect(use.body.data.total).toBe(770)               // the mock's $5 fee, on the money only
  })

  it('record-manual requires a credit choice when credit is usable', async () => {
    const f = await seed()
    const rent = await seedBill(f)
    const res = await request(buildApp()).post(`/api/payments/${rent}/record-manual`)
      .set('Authorization', `Bearer ${f.tokenLandlordA}`)
      .send({ method: 'cash', amountTendered: 900 })
    expect(res.status).toBe(422)
    expect(res.body.error).toMatch(/\$150\.00 of credit.*Use \$150\.00 or Save/)
    const moved = await request(buildApp()).post(`/api/payments/${rent}/record-manual`)
      .set('Authorization', `Bearer ${f.tokenLandlordA}`)
      .send({ method: 'cash', amountTendered: 800, creditToUse: 100 })
    expect(moved.status).toBe(409)
    expect(moved.body.error).toMatch(/now \$150\.00/)
    const { rows: [p] } = await db.query<any>(`SELECT status FROM payments WHERE id=$1`, [rent])
    expect(p.status).toBe('pending')
    const saved = await request(buildApp()).post(`/api/payments/${rent}/record-manual`)
      .set('Authorization', `Bearer ${f.tokenLandlordA}`)
      .send({ method: 'cash', amountTendered: 900, creditToUse: 0 })
    expect(saved.status).toBe(200)
    expect(saved.body.data.creditUsed).toBe(0)
  })

  it('the desk window quote: the bill the desk takes, credit beside it, GAM charges as a Pay online line', async () => {
    const f = await seed()
    const rent = await seedBill(f)
    const res = await request(buildApp()).get(`/api/payments/${rent}/record-manual/quote`)
      .set('Authorization', `Bearer ${f.tokenLandlordA}`)
    expect(res.status).toBe(200)
    expect(res.body.data).toMatchObject({
      currentTotal: 900, creditAvailable: 150, owedIfUsed: 750, owedIfSaved: 900,
      payOnlineTotal: 15, fullBalance: 915, oldBalanceTotal: 0,
    })
    expect(res.body.data.payOnline).toHaveLength(1)
    expect(res.body.data.creditSetAsideElsewhere).toBe(0)
    expect(res.body.data.surplusOptions.map((o: any) => o.value)).toEqual(['change', 'credit'])
    const other = await request(buildApp()).get(`/api/payments/${rent}/record-manual/quote`)
      .set('Authorization', `Bearer ${f.tokenLandlordB}`)
    expect(other.status).toBe(403)
  })

  it('GET / shows the credit on file beside each charge, never netted', async () => {
    const f = await seed()
    const rent = await seedBill(f)
    const res = await request(buildApp()).get('/api/payments?status=pending')
      .set('Authorization', `Bearer ${f.tokenLandlordA}`)
    const row = res.body.data.find((p: any) => p.id === rent)
    expect(Number(row.amount)).toBe(900)
    expect(Number(row.credit_on_file)).toBe(150)
    expect(row).not.toHaveProperty('credit_pool')
  })

  // Fix round 2: paid-ahead money a dispute or return of its own Stripe
  // funding still claims is not the tenant's — not on file on the landlord's
  // list, not on the tenant's "paid ahead" figure (creditUse.usablePaidAheadSql).
  it('GET / and the tenant\'s paid-ahead figure leave out paid-ahead money a dispute of its own funding claims', async () => {
    const f = await seed()
    const rent = await seedBill(f)                               // $100 given + $50 paid ahead at the desk
    const { rows: [rem] } = await db.query<{ id: string }>(
      `INSERT INTO tenant_remittances (tenant_id, lease_id, landlord_id, amount, gross_amount, applied_amount, unapplied_amount,
                                       payment_method, stripe_payment_intent_id, status)
       VALUES ($1,$2,$3,300,300,100,200,'card','pi_disputed_funding','settled') RETURNING id`,
      [f.tenant1Id, f.lease1Id, f.aLid])
    await db.query(
      `INSERT INTO lease_prepaid_credits (lease_id, tenant_id, amount_original, amount_remaining, funded_by, received_at, source_remittance_id)
       VALUES ($1,$2,200,200,'gam',NOW(),$3)`, [f.lease1Id, f.tenant1Id, rem.id])
    const onFile = async () => {
      const res = await request(buildApp()).get('/api/payments?status=pending').set('Authorization', `Bearer ${f.tokenLandlordA}`)
      return Number(res.body.data.find((p: any) => p.id === rent).credit_on_file)
    }
    const paidAhead = async () => {
      const res = await request(buildApp()).get('/api/payments/remittances').set('Authorization', `Bearer ${f.tokenTenant1}`)
      expect(res.status).toBe(200)
      return res.body.data.prepaidRemaining
    }
    expect([await onFile(), await paidAhead()]).toEqual([350, 250])
    // The whole $300 card payment is disputed: none of the $200 it banked is theirs.
    const { rows: [d] } = await db.query<{ id: string }>(
      `INSERT INTO connect_disputes (stripe_dispute_id, stripe_charge_id, stripe_payment_intent_id, amount, status)
       VALUES ('dp_fund','ch_fund','pi_disputed_funding',300,'needs_response') RETURNING id`)
    expect([await onFile(), await paidAhead()]).toEqual([150, 50])
    // $120 of it disputed: $80 is still theirs.
    await db.query(`UPDATE connect_disputes SET amount = 120 WHERE id = $1`, [d.id])
    expect([await onFile(), await paidAhead()]).toEqual([230, 130])
    // A dispute GAM won takes nothing.
    await db.query(`UPDATE connect_disputes SET status = 'won' WHERE id = $1`, [d.id])
    expect([await onFile(), await paidAhead()]).toEqual([350, 250])
  })

  // Fix round 1: a bank pull that bounced paid nothing. A row it was on that
  // account credit paid later is not "Paid by Bank (ACH)".
  it('GET / never names a failed pull as what paid a row', async () => {
    const f = await seed()
    const byCredit = await seedPayment({ unitId: f.aUnitId, tenantId: f.tenant1Id, landlordId: f.aLid, leaseId: f.lease1Id, status: 'settled' })
    const byBank = await seedPayment({ unitId: f.aUnitId, tenantId: f.tenant1Id, landlordId: f.aLid, leaseId: f.lease1Id, status: 'settled' })
    await db.query(
      `INSERT INTO tenant_remittances (tenant_id, lease_id, landlord_id, amount, applied_amount, unapplied_amount,
                                       payment_method, stripe_payment_intent_id, status)
       VALUES ($1,$2,$3,1000,1000,0,'ach','pi_bounced','failed'), ($1,$2,$3,1000,1000,0,'ach','pi_cleared','settled')`,
      [f.tenant1Id, f.lease1Id, f.aLid])
    await db.query(`UPDATE payments SET stripe_payment_intent_id = 'pi_bounced' WHERE id = $1`, [byCredit])
    await db.query(`UPDATE payments SET stripe_payment_intent_id = 'pi_cleared' WHERE id = $1`, [byBank])
    const res = await request(buildApp()).get('/api/payments?status=settled').set('Authorization', `Bearer ${f.tokenLandlordA}`)
    const paidBy = (id: string) => res.body.data.find((p: any) => p.id === id)?.paid_by
    expect(paidBy(byCredit)).toBeNull()
    expect(paidBy(byBank)).toBe('ach')
  })
})

// ─── S655 (10/3): staff see and take money only at their own properties ──────
describe('S655 GET /payments and the desk follow a staffer\'s property scope', () => {
  async function secondProperty(f: Fixture) {
    const c = await db.connect()
    try {
      await c.query('BEGIN')
      const propId = await seedProperty(c, { landlordId: f.aLid, ownerUserId: f.aUid, managedByUserId: f.aUid })
      const unitId = await seedUnit(c, { propertyId: propId, landlordId: f.aLid })
      await c.query('COMMIT')
      return { propId, unitId }
    } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
  }
  const ids = (res: any) => (res.body.data as any[]).map(p => p.id).sort()

  it('a one-property staffer sees only that property\'s rows; an all-properties staffer and the owner see all', async () => {
    const f = await seed()
    const other = await secondProperty(f)
    const here = await seedPayment({ unitId: f.aUnitId, tenantId: f.tenant1Id, landlordId: f.aLid })
    const there = await seedPayment({ unitId: other.unitId, tenantId: f.tenant1Id, landlordId: f.aLid })
    const perms = { 'payments.view_all': true }
    const oneProperty = await staffToken(f, 'onsite_manager', { propertyIds: [f.aPropId], perms })
    const everyProperty = await staffToken(f, 'property_manager', { all: true, perms })
    const noScope = sign({ userId: randomUUID(), role: 'onsite_manager', email: 'x@t.dev', profileId: null,
                           landlordId: f.aLid, permissions: perms })

    const one = await request(buildApp()).get('/api/payments').set('Authorization', `Bearer ${oneProperty}`)
    expect(one.status).toBe(200)
    expect(ids(one)).toEqual([here])
    expect(one.body.total).toBe(1)
    const all = await request(buildApp()).get('/api/payments').set('Authorization', `Bearer ${everyProperty}`)
    expect(ids(all)).toEqual([here, there].sort())
    const owner = await request(buildApp()).get('/api/payments').set('Authorization', `Bearer ${f.tokenLandlordA}`)
    expect(ids(owner)).toEqual([here, there].sort())
    // A staffer with no scope row is assigned nowhere: nothing comes back.
    const none = await request(buildApp()).get('/api/payments').set('Authorization', `Bearer ${noScope}`)
    expect(none.body.data).toEqual([])
  })

  it('a one-property staffer cannot open the desk window or record a payment on another property\'s charge', async () => {
    const f = await seed()
    const other = await secondProperty(f)
    const there = await seedPayment({ unitId: other.unitId, tenantId: f.tenant1Id, landlordId: f.aLid, amount: 500 })
    const desk = await staffToken(f, 'onsite_manager', { propertyIds: [f.aPropId], perms: { take_payment: true } })
    const quote = await request(buildApp()).get(`/api/payments/${there}/record-manual/quote`).set('Authorization', `Bearer ${desk}`)
    expect(quote.status).toBe(403)
    const rec = await request(buildApp()).post(`/api/payments/${there}/record-manual`)
      .set('Authorization', `Bearer ${desk}`).send({ method: 'cash', amountTendered: 500 })
    expect(rec.status).toBe(403)
    expect(rec.body.error).toMatch(/not assigned/)
    const { rows: [p] } = await db.query<any>(`SELECT status FROM payments WHERE id=$1`, [there])
    expect(p.status).toBe('pending')
    // Their own property: recorded.
    const here = await seedPayment({ unitId: f.aUnitId, tenantId: f.tenant1Id, landlordId: f.aLid, amount: 500, leaseId: f.lease1Id })
    const ok = await request(buildApp()).post(`/api/payments/${here}/record-manual`)
      .set('Authorization', `Bearer ${desk}`).send({ method: 'cash', amountTendered: 1000 })
    expect(ok.status, JSON.stringify(ok.body)).toBe(200)
  })
})

// ─── S655 (10/3): FlexPay never appears in the landlord portal ───────────────
describe('S655 GET /payments never shows FlexPay to the landlord or their staff', () => {
  async function flexpayMonth(f: Fixture) {
    const { rows: [adv] } = await db.query<{ id: string }>(
      `INSERT INTO flexpay_advances (cycle_month, tenant_id, landlord_id, unit_id, lease_id, rent_amount, tenant_fee_amount, pull_day)
       VALUES (date_trunc('month', CURRENT_DATE)::date, $1, $2, $3, $4, 1000, 25, 10) RETURNING id`,
      [f.tenant1Id, f.aLid, f.aUnitId, f.lease1Id])
    // The bill line FlexPay covered: the landlord's rent, paid on time.
    const { rows: [rent] } = await db.query<{ id: string }>(
      `INSERT INTO payments (unit_id, tenant_id, landlord_id, lease_id, type, amount, status, entry_description,
                             due_date, settled_at, platform_held, flexpay_advance_id, notes)
       VALUES ($1,$2,$3,$4,'rent',1000,'settled','RENT',CURRENT_DATE,NOW(),TRUE,$5,'Paid on time') RETURNING id`,
      [f.aUnitId, f.tenant1Id, f.aLid, f.lease1Id, adv.id])
    // GAM's pull from the tenant: GAM's own row.
    const { rows: [pull] } = await db.query<{ id: string }>(
      `INSERT INTO payments (unit_id, tenant_id, landlord_id, lease_id, type, amount, status, entry_description,
                             due_date, revenue_owner, flexpay_advance_id)
       VALUES ($1,$2,$3,$4,'fee',1025,'pending','FLEXPAY',CURRENT_DATE + 10,'gam',$5) RETURNING id`,
      [f.aUnitId, f.tenant1Id, f.aLid, f.lease1Id, adv.id])
    return { rent: rent.id, pull: pull.id }
  }

  it('the landlord and a staffer see the covered rent as paid, never the pull or the advance', async () => {
    const f = await seed()
    const m = await flexpayMonth(f)
    const staff = await staffToken(f, 'property_manager', { all: true, perms: { 'payments.view_all': true } })
    for (const token of [f.tokenLandlordA, staff]) {
      const res = await request(buildApp()).get('/api/payments?limit=1000').set('Authorization', `Bearer ${token}`)
      expect(res.status).toBe(200)
      const rows = res.body.data as any[]
      expect(rows.map(r => r.id)).toEqual([m.rent])
      expect(res.body.total).toBe(1)
      expect(rows[0]).not.toHaveProperty('flexpay_advance_id')
      expect(JSON.stringify(rows)).not.toMatch(/flexpay/i)
    }
  })

  it('the tenant and GAM still see the FlexPay pull', async () => {
    const f = await seed()
    const m = await flexpayMonth(f)
    const tenant = await request(buildApp()).get('/api/payments?limit=1000').set('Authorization', `Bearer ${f.tokenTenant1}`)
    expect((tenant.body.data as any[]).map(r => r.id).sort()).toEqual([m.rent, m.pull].sort())
    const admin = await request(buildApp()).get('/api/payments?limit=1000').set('Authorization', `Bearer ${f.tokenAdmin}`)
    const pull = (admin.body.data as any[]).find(r => r.id === m.pull)
    expect(pull.flexpay_advance_id).toBeTruthy()
  })
})

// ─── S655: prior arrangement takes the household lock and replaces a retry ──
describe('S655 POST /:id/record-prior-arrangement', () => {
  it('a bank retry scheduled on the charge is replaced: its held credit given back, its pull canceled', async () => {
    const f = await seed()
    await db.query(`UPDATE landlords SET reconciliation_until = NOW() + INTERVAL '10 days' WHERE id = $1`, [f.aLid])
    const rent = await seedPayment({ unitId: f.aUnitId, tenantId: f.tenant1Id, landlordId: f.aLid, leaseId: f.lease1Id, amount: 1000 })
    const { rows: [credit] } = await db.query<{ id: string }>(
      `INSERT INTO tenant_credits (landlord_id, tenant_id, lease_id, amount_original, amount_remaining, category)
       VALUES ($1,$2,$3,100,100,'goodwill') RETURNING id`, [f.aLid, f.tenant1Id, f.lease1Id])
    const { rows: [rem] } = await db.query<{ id: string }>(
      `INSERT INTO tenant_remittances (tenant_id, lease_id, landlord_id, amount, applied_amount, unapplied_amount,
                                       payment_method, stripe_payment_intent_id, status)
       VALUES ($1,$2,$3,900,900,0,'ach','pi_prior_retry','processing') RETURNING id`, [f.tenant1Id, f.lease1Id, f.aLid])
    await db.query(
      `UPDATE payments SET status='failed', stripe_payment_intent_id='pi_prior_retry', next_retry_at = NOW() + INTERVAL '2 days'
        WHERE id=$1`, [rent])
    await db.query(
      `INSERT INTO credit_uses (tenant_credit_id, payment_id, remittance_id, lease_id, amount, billing_month, source, status)
       VALUES ($1,$2,$3,$4,100,date_trunc('month', CURRENT_DATE)::date,'portal','held')`, [credit.id, rent, rem.id, f.lease1Id])

    const res = await request(buildApp()).post(`/api/payments/${rent}/record-prior-arrangement`)
      .set('Authorization', `Bearer ${f.tokenLandlordA}`).send({})
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    const { rows: [p] } = await db.query<any>(`SELECT status, next_retry_at FROM payments WHERE id=$1`, [rent])
    expect(p).toEqual({ status: 'settled', next_retry_at: null })
    const { rows: [u] } = await db.query<any>(`SELECT status, release_reason FROM credit_uses`)
    expect(u).toEqual({ status: 'released', release_reason: 'superseded' })
    const { rows: [c] } = await db.query<any>(`SELECT amount_remaining::float AS r FROM tenant_credits WHERE id=$1`, [credit.id])
    expect(c.r).toBe(100)
    expect(paymentIntentsCancelMock).toHaveBeenCalledWith('pi_prior_retry')
  })

  it('a charge with a payment already on its way is refused', async () => {
    const f = await seed()
    await db.query(`UPDATE landlords SET reconciliation_until = NOW() + INTERVAL '10 days' WHERE id = $1`, [f.aLid])
    const rent = await seedPayment({ unitId: f.aUnitId, tenantId: f.tenant1Id, landlordId: f.aLid, leaseId: f.lease1Id })
    await db.query(`UPDATE payments SET stripe_payment_intent_id='pi_on_its_way' WHERE id=$1`, [rent])
    const res = await request(buildApp()).post(`/api/payments/${rent}/record-prior-arrangement`)
      .set('Authorization', `Bearer ${f.tokenLandlordA}`).send({})
    expect(res.status).toBe(409)
    expect(res.body.error).toMatch(/on its way/)
  })
})

// ─── 10/4: credit another bank payment holds, and "Pay all" with "Use all" ──
// The renewal case: an $80 move-in special moved to the renewal while the old
// lease's September bank payment still held $50 of it; that payment bounced
// and its retry is scheduled, still holding the $50. October's $480 is open
// on the renewal.
describe('credit another bank payment holds, and Pay all (10/4)', () => {
  const WAITING_50 = '$50.00 of your credit is set aside for an earlier bank payment that has not cleared yet. If that payment clears, the credit goes toward that earlier bill. If it does not, the credit comes back to your account.'

  async function movedCreditHeldByOldRetry(f: Fixture) {
    const { holdCredit } = await import('../services/creditUse')
    const oldLeaseId = (await db.query<{ id: string }>(
      `INSERT INTO leases (unit_id, landlord_id, rent_amount, lease_type, status, start_date, end_date)
       VALUES ($1,$2,460,'fixed_term','expired','2025-10-01','2026-09-30') RETURNING id`, [f.aUnitId, f.aLid])).rows[0].id
    await db.query(`INSERT INTO lease_tenants (lease_id, tenant_id, role) VALUES ($1,$2,'primary')`, [oldLeaseId, f.tenant1Id])
    await db.query(`UPDATE leases SET supersedes_lease_id = $2, rent_amount = 480 WHERE id = $1`, [f.lease1Id, oldLeaseId])
    const special = (await db.query<{ id: string }>(
      `INSERT INTO tenant_credits (landlord_id, tenant_id, lease_id, amount_original, amount_remaining, category)
       VALUES ($1,$2,$3,80,80,'goodwill') RETURNING id`, [f.aLid, f.tenant1Id, oldLeaseId])).rows[0].id
    const sept = (await db.query<{ id: string }>(
      `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description, stripe_payment_intent_id)
       VALUES ($1,$2,$3,$4,'rent',460,'processing','2026-09-01','RENT','pi_sept_retry') RETURNING id`,
      [f.aUnitId, oldLeaseId, f.tenant1Id, f.aLid])).rows[0].id
    const rem = (await db.query<{ id: string }>(
      `INSERT INTO tenant_remittances (tenant_id, lease_id, landlord_id, amount, applied_amount, unapplied_amount,
                                       status, payment_method, stripe_payment_intent_id, processing_fee_amount)
       VALUES ($1,$2,$3,410,410,0,'processing','ach','pi_sept_retry',0) RETURNING id`,
      [f.tenant1Id, oldLeaseId, f.aLid])).rows[0].id
    const c = await db.connect()
    try {
      await c.query('BEGIN')
      await holdCredit(c, [{ creditKind: 'issued', creditId: special, paymentId: sept, leaseId: oldLeaseId, amount: 50, billingMonth: '2026-09-01' }],
        { remittanceId: rem, source: 'portal' })
      await c.query('COMMIT')
    } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
    // The hand-off moves the credit to the renewal; the bank bounces September and a retry is scheduled.
    await db.query(`UPDATE tenant_credits SET lease_id = $2 WHERE id = $1`, [special, f.lease1Id])
    await db.query(`UPDATE payments SET status = 'failed', next_retry_at = now() + interval '3 days' WHERE id = $1`, [sept])
    const oct = (await db.query<{ id: string }>(
      `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description)
       VALUES ($1,$2,$3,$4,'rent',480,'pending','2026-10-01','RENT') RETURNING id`,
      [f.aUnitId, f.lease1Id, f.tenant1Id, f.aLid])).rows[0].id
    await db.query(`UPDATE tenants SET stripe_customer_id = 'cus_t1' WHERE id = $1`, [f.tenant1Id])
    return { oldLeaseId, special, sept, oct }
  }
  const context = (f: Fixture) => request(buildApp()).get('/api/payments/balance-context').set('Authorization', `Bearer ${f.tokenTenant1}`)
  const quote = (f: Fixture, body: any) => request(buildApp()).post('/api/payments/quote').set('Authorization', `Bearer ${f.tokenTenant1}`).send(body)

  it('the pay screen says, in plain words, why only part of the credit on file can pay the renewal', async () => {
    const f = await seed()
    const { oldLeaseId } = await movedCreditHeldByOldRetry(f)
    const res = await context(f)
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    const renewal = res.body.data.leases.find((l: any) => l.leaseId === f.lease1Id)
    expect(renewal.creditOnFile).toBe(80)
    expect(renewal.usableCredit).toBe(30)
    expect(renewal.payIfUsed).toBe(450)
    expect(renewal.creditWaiting).toBe(50)
    expect(renewal.creditWaitingNote).toBe(WAITING_50)
    expect(renewal.creditWaitingHeldBy).toEqual([oldLeaseId])
    const old = res.body.data.leases.find((l: any) => l.leaseId === oldLeaseId)
    expect(old.usableCredit).toBe(0)
    expect(old.creditWaiting).toBe(0)
    expect(old.creditWaitingNote).toBeNull()
  })

  it('the tenant quote carries the same waiting sentence for the agent and the pay screen', async () => {
    const f = await seed()
    await movedCreditHeldByOldRetry(f)
    const q = await quote(f, { method: 'ach', leaseId: f.lease1Id, useCredit: true })
    expect(q.status, JSON.stringify(q.body)).toBe(200)
    expect(q.body.data).toMatchObject({ usableCredit: 30, base: 450, creditWaiting: 50, creditWaitingNote: WAITING_50 })
  })

  it('Pay all figures: the old lease first (its retry is replaced), then the renewal with the $80 the replaced retry frees', async () => {
    const f = await seed()
    const { oldLeaseId } = await movedCreditHeldByOldRetry(f)
    const res = await context(f)
    const renewal = res.body.data.leases.find((l: any) => l.leaseId === f.lease1Id)
    const old = res.body.data.leases.find((l: any) => l.leaseId === oldLeaseId)
    expect(old.payAll).toMatchObject({ order: [oldLeaseId, f.lease1Id], usableCredit: 0, payIfUsed: 460 })
    expect(renewal.payAll).toMatchObject({ order: [oldLeaseId, f.lease1Id], usableCredit: 80, expectedCredit: 80, payIfUsed: 400, creditWaiting: 0, creditWaitingNote: null })
    // The run's own first charge replaces the retry that held the $50, so the run has nothing waiting.
    expect(old.payAll).toMatchObject({ runCreditWaiting: 0, runCreditWaitingNote: null })
    expect(renewal.payAll).toMatchObject({ runCreditWaiting: 0, runCreditWaitingNote: null })
    // The quote asked with the same order is the same figure.
    const q = await quote(f, { method: 'ach', leaseId: f.lease1Id, useCredit: true, afterLeaseIds: [oldLeaseId] })
    expect(q.body.data).toMatchObject({ usableCredit: 80, base: 400, creditWaiting: 0, creditWaitingNote: null })
  })

  it('Pay all with Use all charges the old lease and then the renewal in one go — no "Your credit changed"', async () => {
    const f = await seed()
    const { oldLeaseId, special, sept, oct } = await movedCreditHeldByOldRetry(f)
    const ctx = (await context(f)).body.data.leases
    const old = ctx.find((l: any) => l.leaseId === oldLeaseId)
    const renewal = ctx.find((l: any) => l.leaseId === f.lease1Id)
    ;(stripeConnect.createRentPlatformCharge as any)
      .mockImplementationOnce(async () => ({ id: 'pi_payall_old', status: 'processing' }))
      .mockImplementationOnce(async () => ({ id: 'pi_payall_renewal', status: 'processing' }))
    const pay = (body: any) => request(buildApp()).post('/api/payments/pay-balance').set('Authorization', `Bearer ${f.tokenTenant1}`).send(body)
    // What the pay screen sends (lib/payCredit planCharges with the payAll figures).
    const first = await pay({ leaseId: oldLeaseId, amount: old.payAll.payIfUsed, paymentMethodId: 'pm_x', paymentMethodType: 'ach',
      useCredit: false, expectedCredit: 0 })
    expect(first.status, JSON.stringify(first.body)).toBe(200)
    const second = await pay({ leaseId: f.lease1Id, amount: renewal.payAll.payIfUsed, paymentMethodId: 'pm_x', paymentMethodType: 'ach',
      useCredit: true, expectedCredit: renewal.payAll.expectedCredit })
    expect(second.status, JSON.stringify(second.body)).toBe(200)
    expect(second.body.data.creditUsed).toBe(80)
    const st = (await db.query<{ id: string; status: string }>(`SELECT id, status FROM payments WHERE id = ANY($1::uuid[])`, [[sept, oct]])).rows
    expect(new Map(st.map(r => [r.id, r.status]))).toEqual(new Map([[sept, 'processing'], [oct, 'processing']]))
    const held = (await db.query<{ payment_id: string; amount: string }>(
      `SELECT payment_id, amount::text AS amount FROM credit_uses WHERE tenant_credit_id = $1 AND status = 'held'`, [special])).rows
    expect(held).toEqual([{ payment_id: oct, amount: '80.00' }])
    expect((stripeConnect.createRentPlatformCharge as any).mock.calls.map((c: any[]) => c[0].amount)).toEqual([465, 405])
  })

  // Fix pass 2: a paused lease's bank retry holds the whole $50 general
  // credit. Pay all of the two other bills: each bill alone could use the
  // same $50, so adding the bills' figures said "$100.00 set aside" with
  // $50.00 on file. The run carries one figure, the same on every bill.
  it('Pay all says the credit a paused lease\'s retry holds once for the run, never once per bill', async () => {
    const f = await seed()
    const { holdCredit } = await import('../services/creditUse')
    const c = await db.connect()
    let pausedLeaseId = '', otherLeaseId = ''
    try {
      await c.query('BEGIN')
      const pausedUnit = await seedUnit(c, { propertyId: f.aPropId, landlordId: f.aLid })
      pausedLeaseId = await seedLease(c, { unitId: pausedUnit, landlordId: f.aLid })
      await seedLeaseTenant(c, { leaseId: pausedLeaseId, tenantId: f.tenant1Id, role: 'primary' })
      const otherUnit = await seedUnit(c, { propertyId: f.aPropId, landlordId: f.aLid })
      otherLeaseId = await seedLease(c, { unitId: otherUnit, landlordId: f.aLid })
      await seedLeaseTenant(c, { leaseId: otherLeaseId, tenantId: f.tenant1Id, role: 'primary' })
      const general = (await c.query<{ id: string }>(
        `INSERT INTO tenant_credits (landlord_id, tenant_id, lease_id, amount_original, amount_remaining, category)
         VALUES ($1,$2,NULL,50,50,'goodwill') RETURNING id`, [f.aLid, f.tenant1Id])).rows[0].id
      const aug = (await c.query<{ id: string }>(
        `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description, stripe_payment_intent_id)
         VALUES ($1,$2,$3,$4,'rent',200,'processing','2026-08-01','RENT','pi_paused_retry') RETURNING id`,
        [pausedUnit, pausedLeaseId, f.tenant1Id, f.aLid])).rows[0].id
      const rem = (await c.query<{ id: string }>(
        `INSERT INTO tenant_remittances (tenant_id, lease_id, landlord_id, amount, applied_amount, unapplied_amount,
                                         status, payment_method, stripe_payment_intent_id, processing_fee_amount)
         VALUES ($1,$2,$3,150,150,0,'processing','ach','pi_paused_retry',0) RETURNING id`,
        [f.tenant1Id, pausedLeaseId, f.aLid])).rows[0].id
      await holdCredit(c, [{ creditKind: 'issued', creditId: general, paymentId: aug, leaseId: pausedLeaseId, amount: 50, billingMonth: '2026-08-01' }],
        { remittanceId: rem, source: 'portal' })
      await c.query(`UPDATE payments SET status = 'failed', next_retry_at = now() + interval '3 days' WHERE id = $1`, [aug])
      await c.query(`UPDATE units SET payment_block = TRUE WHERE id = $1`, [pausedUnit])
      // The run is charged in the list's order (lease ids sorted): the first
      // bill of the run is the older one, so each bill at its turn is the
      // oldest still open — the case where every bill reported the same $50.
      const [firstId] = [f.lease1Id, otherLeaseId].sort()
      const bills: [string, string][] = [[f.aUnitId, f.lease1Id], [otherUnit, otherLeaseId]]
      for (const [unit, lease] of bills) {
        const due = lease === firstId ? '2026-09-01' : '2026-10-01'
        await c.query(
          `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description)
           VALUES ($1,$2,$3,$4,'rent',200,'pending',$5,'RENT')`, [unit, lease, f.tenant1Id, f.aLid, due])
      }
      await c.query('COMMIT')
    } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }

    const res = await context(f)
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    const leases = res.body.data.leases
    const paused = leases.find((l: any) => l.leaseId === pausedLeaseId)
    expect(paused.paymentBlocked).toBe(true)
    expect(paused.payAll).toBeNull()
    const run = [f.lease1Id, otherLeaseId].sort().map(id => leases.find((l: any) => l.leaseId === id))
    expect(run[0].payAll.order).toEqual([f.lease1Id, otherLeaseId].sort())
    // Alone, the older bill is the one the $50 would pay (oldest bill first).
    expect(run.map(l => [l.usableCredit, l.creditWaiting])).toEqual([[0, 50], [0, 0]])
    // In the run each bill, at its turn, could use those same $50: the bills'
    // own figures add up to $100 — the double count the screen used to say.
    expect(run.reduce((s: number, l: any) => s + l.payAll.creditWaiting, 0)).toBe(100)
    for (const l of run) {
      expect(l.creditOnFile).toBe(50)
      // The run: one figure, the same on every bill, never more than is on file.
      expect(l.payAll).toMatchObject({ runCreditWaiting: 50, runCreditWaitingNote: WAITING_50, usableCredit: 0 })
    }
    expect(run[0].payAll.order).toEqual(run[1].payAll.order)
  })

  // Fix pass 3: every dollar of the credit on file is explained on one bill.
  it('one bill: the rest of the credit on file is said in plain words, on the pay screen and in the quote', async () => {
    const f = await seed()
    const { oldLeaseId } = await movedCreditHeldByOldRetry(f)
    // $20 tied to the old lease: its only bill is the retrying one.
    await db.query(
      `INSERT INTO tenant_credits (landlord_id, tenant_id, lease_id, amount_original, amount_remaining, category)
       VALUES ($1,$2,$3,20,20,'goodwill')`, [f.aLid, f.tenant1Id, oldLeaseId])
    const REST_20 = '$20.00 of your credit is kept for a bill on another lease.'
    const renewal = (await context(f)).body.data.leases.find((l: any) => l.leaseId === f.lease1Id)
    expect(renewal).toMatchObject({ creditOnFile: 100, usableCredit: 30, creditWaiting: 50, creditKeptElsewhere: 20, creditKeptForLater: 0, creditAlsoHeld: 0, creditRestNote: REST_20 })
    const q = await quote(f, { method: 'ach', leaseId: f.lease1Id, useCredit: true })
    expect(q.body.data).toMatchObject({ creditOnFile: 100, usableCredit: 30, creditWaiting: 50, creditRestNote: REST_20 })
  })

  it('a bill with nothing left over says no rest sentence', async () => {
    const f = await seed()
    await movedCreditHeldByOldRetry(f)
    const renewal = (await context(f)).body.data.leases.find((l: any) => l.leaseId === f.lease1Id)
    expect(renewal).toMatchObject({ creditOnFile: 80, usableCredit: 30, creditWaiting: 50, creditRestNote: null })
  })

  // Fix pass 3: bills the screen pays together that are not balance-context's
  // run get the run's one held-credit figure from the server.
  it('the quote answers the held-credit figure for any run of the tenant\'s bills, and nothing for leases that are not theirs', async () => {
    const f = await seed()
    const { oldLeaseId } = await movedCreditHeldByOldRetry(f)
    const alone = await quote(f, { method: 'ach', runLeaseIds: [f.lease1Id] })
    expect(alone.status, JSON.stringify(alone.body)).toBe(200)
    expect(alone.body.data).toEqual({ runLeaseIds: [f.lease1Id], runCreditWaiting: 50, runCreditWaitingNote: WAITING_50 })
    // The old lease first replaces its retry: nothing waits.
    const both = await quote(f, { method: 'ach', runLeaseIds: [oldLeaseId, f.lease1Id] })
    expect(both.body.data).toMatchObject({ runCreditWaiting: 0, runCreditWaitingNote: null })
    const stranger = await quote(f, { method: 'ach', runLeaseIds: ['00000000-0000-4000-8000-000000000001'] })
    expect(stranger.body.data).toMatchObject({ runCreditWaiting: 0, runCreditWaitingNote: null })
  })

  it('one bill alone gets no Pay all figures', async () => {
    const f = await seed()
    await seedPayment({ unitId: f.aUnitId, tenantId: f.tenant1Id, landlordId: f.aLid, amount: 900, leaseId: f.lease1Id })
    const res = await context(f)
    expect(res.body.data.leases.find((l: any) => l.leaseId === f.lease1Id).payAll).toBeNull()
  })
})

// ─── decisions.md #48.4: a card its bank wants confirmed (3-D Secure) ─────────
// On the pay screen the tenant confirms on the spot; the bill is held for up to
// CARD_CONFIRM_HOLD_MINUTES, then released.
describe('3-D Secure on the pay screen', () => {
  // What services/rentCharge stamps on a pay-screen card charge (the only
  // kind #48.4 holds, releases and shows as waiting on the bank).
  const ON_SCREEN = { gam_confirm_on_screen: 'true' }
  async function ready(f: Fixture) {
    await db.query(`UPDATE tenants SET stripe_customer_id='cus_t1' WHERE id=$1`, [f.tenant1Id])
    await db.query(
      `UPDATE users SET stripe_connect_account_id='acct_l1', connect_charges_enabled=TRUE, connect_details_submitted=TRUE WHERE id=$1`, [f.aUid])
  }
  const bill = (f: Fixture, amount = 1000) =>
    seedPayment({ unitId: f.aUnitId, tenantId: f.tenant1Id, landlordId: f.aLid, amount, leaseId: f.lease1Id })
  const post = (f: Fixture, path: string, body: any, token = f.tokenTenant1) =>
    request(buildApp()).post(`/api/payments${path}`).set('Authorization', `Bearer ${token}`).send(body)
  const context = (f: Fixture) => request(buildApp()).get('/api/payments/balance-context').set('Authorization', `Bearer ${f.tokenTenant1}`)
  const row = async (id: string) => (await db.query<any>(`SELECT status, stripe_payment_intent_id FROM payments WHERE id=$1`, [id])).rows[0]
  const needsConfirm = () => (stripeConnect.createRentPlatformCharge as any)
    .mockImplementationOnce(async () => ({ id: 'pi_screen', status: 'requires_action', client_secret: 'pi_screen_secret_1' }))
  beforeEach(async () => {
    paymentIntentsCancelMock.mockClear()
    paymentIntentsRetrieveMock.mockReset()
    paymentIntentsRetrieveMock.mockImplementation(async (id: string) => ({ id, metadata: ON_SCREEN, status: 'processing' }))
    // Every case reuses the id pi_screen: the sweep's memory of what it has
    // seen (a real intent id is never reused) starts empty for each.
    ;(await import('../jobs/paymentReconcile')).forgetSweptCardCharges()
  })
  const waitingOnBank = () => paymentIntentsRetrieveMock.mockImplementation(async (id: string) =>
    ({ id, metadata: ON_SCREEN, status: 'requires_action', client_secret: `${id}_secret_1` }))

  it('the pay screen keeps the charge: the bill is held for it and the screen gets what the bank\'s window needs', async () => {
    const f = await seed(); await ready(f)
    const pid = await bill(f)
    needsConfirm()
    const before = Date.now()
    const res = await post(f, '/pay-balance', { amount: 1000, paymentMethodId: 'pm_x', paymentMethodType: 'card', confirmOnScreen: true })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.data).toMatchObject({ status: 'requires_action', paymentIntentId: 'pi_screen', clientSecret: 'pi_screen_secret_1' })
    const by = new Date(res.body.data.confirmBy).getTime()
    expect(by - before).toBeGreaterThanOrEqual(30 * 60_000 - 5_000)
    expect(by - before).toBeLessThanOrEqual(30 * 60_000 + 5_000)
    expect(paymentIntentsCancelMock).not.toHaveBeenCalled()
    expect(await row(pid)).toEqual({ status: 'processing', stripe_payment_intent_id: 'pi_screen' })
  })

  it('while it waits the bill is listed as waiting on the bank — never as clearing — and is not charged twice', async () => {
    const f = await seed(); await ready(f)
    await bill(f)
    needsConfirm()
    await post(f, '/pay-balance', { amount: 1000, paymentMethodId: 'pm_x', paymentMethodType: 'card', confirmOnScreen: true })
    waitingOnBank()
    const ctx = await context(f)
    expect(ctx.status, JSON.stringify(ctx.body)).toBe(200)
    const l = ctx.body.data.leases.find((x: any) => x.leaseId === f.lease1Id)
    expect(l.clearing).toBe(0)
    expect(l.awaitingConfirmation).toEqual([expect.objectContaining({ paymentIntentId: 'pi_screen', canConfirm: true })])
    expect(l.awaitingConfirmation[0].amount).toBeGreaterThan(1000)
    const again = await post(f, '/pay-balance', { amount: 1000, paymentMethodId: 'pm_x', paymentMethodType: 'ach' })
    expect(again.status).toBe(409)
  })

  it('release: the bank did not confirm — the charge is canceled at once and the bill opens again as it was (open, not Failed)', async () => {
    const f = await seed(); await ready(f)
    const pid = await bill(f)
    needsConfirm()
    await post(f, '/pay-balance', { amount: 1000, paymentMethodId: 'pm_x', paymentMethodType: 'card', confirmOnScreen: true })
    paymentIntentsRetrieveMock.mockImplementation(async (id: string) => ({ id, metadata: ON_SCREEN, status: 'requires_payment_method' }))
    const rel = await post(f, '/pay-balance/release', { paymentIntentId: 'pi_screen' })
    expect(rel.status, JSON.stringify(rel.body)).toBe(200)
    expect(rel.body.data).toEqual({ outcome: 'released', declined: false })
    expect(paymentIntentsCancelMock).toHaveBeenCalledWith('pi_screen')
    expect(await row(pid)).toEqual({ status: 'pending', stripe_payment_intent_id: null })
    expect((await db.query<any>(`SELECT platform_held, payment_channel FROM payments WHERE id=$1`, [pid])).rows[0])
      .toEqual({ platform_held: false, payment_channel: null })
    const rem = (await db.query<any>(`SELECT status FROM tenant_remittances WHERE stripe_payment_intent_id='pi_screen'`)).rows[0]
    expect(rem.status).toBe('failed')
    const again = await post(f, '/pay-balance', { amount: 1000, paymentMethodId: 'pm_x', paymentMethodType: 'ach' })
    expect(again.status, JSON.stringify(again.body)).toBe(200)
  })

  it('release leaves a payment the bank confirmed alone', async () => {
    const f = await seed(); await ready(f)
    const pid = await bill(f)
    needsConfirm()
    await post(f, '/pay-balance', { amount: 1000, paymentMethodId: 'pm_x', paymentMethodType: 'card', confirmOnScreen: true })
    paymentIntentsRetrieveMock.mockImplementation(async (id: string) => ({ id, metadata: ON_SCREEN, status: 'succeeded' }))
    const rel = await post(f, '/pay-balance/release', { paymentIntentId: 'pi_screen' })
    expect(rel.body.data).toEqual({ outcome: 'went_through', declined: false })
    expect(paymentIntentsCancelMock).not.toHaveBeenCalled()
    expect((await row(pid)).status).toBe('processing')
  })

  it('release and resume refuse a payment that is not this tenant\'s', async () => {
    const f = await seed(); await ready(f)
    await bill(f)
    needsConfirm()
    await post(f, '/pay-balance', { amount: 1000, paymentMethodId: 'pm_x', paymentMethodType: 'card', confirmOnScreen: true })
    const c = await db.connect()
    let otherToken: string
    try {
      const otherId = await seedTenant(c)
      const uid = (await c.query<{ user_id: string }>(`SELECT user_id FROM tenants WHERE id=$1`, [otherId])).rows[0].user_id
      otherToken = sign({ userId: uid, role: 'tenant', email: 'o@t.dev', profileId: otherId })
    } finally { c.release() }
    waitingOnBank()
    expect((await post(f, '/pay-balance/release', { paymentIntentId: 'pi_screen' }, otherToken)).status).toBe(404)
    expect((await post(f, '/pay-balance/resume', { paymentIntentId: 'pi_screen' }, otherToken)).status).toBe(404)
    expect(paymentIntentsCancelMock).not.toHaveBeenCalled()
  })

  it('resume hands the bank\'s window back only while the payment can still be confirmed', async () => {
    const f = await seed(); await ready(f)
    await bill(f)
    needsConfirm()
    await post(f, '/pay-balance', { amount: 1000, paymentMethodId: 'pm_x', paymentMethodType: 'card', confirmOnScreen: true })
    waitingOnBank()
    const r1 = await post(f, '/pay-balance/resume', { paymentIntentId: 'pi_screen' })
    expect(r1.body.data).toMatchObject({ status: 'requires_action', clientSecret: 'pi_screen_secret_1' })
    paymentIntentsRetrieveMock.mockImplementation(async (id: string) => ({ id, metadata: ON_SCREEN, status: 'requires_payment_method', client_secret: 'x' }))
    const r2 = await post(f, '/pay-balance/resume', { paymentIntentId: 'pi_screen' })
    expect(r2.body.data).toMatchObject({ status: 'requires_payment_method', clientSecret: null })
  })

  it('resume inside the 30 minutes on a payment that went through says so — never "can no longer be confirmed"', async () => {
    const f = await seed(); await ready(f)
    const pid = await bill(f)
    needsConfirm()
    await post(f, '/pay-balance', { amount: 1000, paymentMethodId: 'pm_x', paymentMethodType: 'card', confirmOnScreen: true })
    // The payer confirmed in another tab; Stripe says it went through, the webhook has not landed.
    paymentIntentsRetrieveMock.mockImplementation(async (id: string) => ({ id, metadata: ON_SCREEN, status: 'succeeded', client_secret: 'x' }))
    const r1 = await post(f, '/pay-balance/resume', { paymentIntentId: 'pi_screen' })
    expect(r1.status, JSON.stringify(r1.body)).toBe(200)
    expect(r1.body.data).toMatchObject({ status: 'succeeded', outcome: 'went_through', clientSecret: null })
    paymentIntentsRetrieveMock.mockImplementation(async (id: string) => ({ id, metadata: ON_SCREEN, status: 'processing', client_secret: 'x' }))
    expect((await post(f, '/pay-balance/resume', { paymentIntentId: 'pi_screen' })).body.data).toMatchObject({ outcome: 'went_through', clientSecret: null })
    // The webhook settled the receipt: said from GAM's own record, Stripe not asked.
    await db.query(`UPDATE tenant_remittances SET status = 'settled' WHERE stripe_payment_intent_id = 'pi_screen'`)
    paymentIntentsRetrieveMock.mockClear()
    expect((await post(f, '/pay-balance/resume', { paymentIntentId: 'pi_screen' })).body.data).toMatchObject({ outcome: 'went_through', clientSecret: null })
    expect(paymentIntentsRetrieveMock).not.toHaveBeenCalled()
    expect(paymentIntentsCancelMock).not.toHaveBeenCalled()
    expect((await row(pid)).status).toBe('processing')
  })

  it('resume inside the 30 minutes on a payment already canceled (another tab, the sweep) says it was released', async () => {
    const f = await seed(); await ready(f)
    await bill(f)
    needsConfirm()
    await post(f, '/pay-balance', { amount: 1000, paymentMethodId: 'pm_x', paymentMethodType: 'card', confirmOnScreen: true })
    // Canceled in Stripe, the receipt not yet closed here.
    paymentIntentsRetrieveMock.mockImplementation(async (id: string) => ({ id, metadata: ON_SCREEN, status: 'canceled', client_secret: 'x' }))
    const r1 = await post(f, '/pay-balance/resume', { paymentIntentId: 'pi_screen' })
    expect(r1.body.data).toMatchObject({ status: 'canceled', outcome: 'released', clientSecret: null })
    // Released here too (the other tab's Cancel): the receipt says so.
    await post(f, '/pay-balance/release', { paymentIntentId: 'pi_screen' })
    paymentIntentsRetrieveMock.mockClear()
    const r2 = await post(f, '/pay-balance/resume', { paymentIntentId: 'pi_screen' })
    expect(r2.body.data).toMatchObject({ status: 'canceled', outcome: 'released', expired: false, declined: false, clientSecret: null })
    expect(paymentIntentsRetrieveMock).not.toHaveBeenCalled()
  })

  // Review (pay8 fix pass 2): "released" is said only once the bill is open.
  it('resume on a payment canceled in Stripe whose bill side never ran opens the bill before saying it was released', async () => {
    const f = await seed(); await ready(f)
    const pid = await bill(f)
    needsConfirm()
    await post(f, '/pay-balance', { amount: 1000, paymentMethodId: 'pm_x', paymentMethodType: 'card', confirmOnScreen: true })
    paymentIntentsRetrieveMock.mockImplementation(async (id: string) => ({ id, metadata: ON_SCREEN, status: 'canceled', client_secret: 'x' }))
    const r = await post(f, '/pay-balance/resume', { paymentIntentId: 'pi_screen' })
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    expect(r.body.data).toMatchObject({ status: 'canceled', outcome: 'released', declined: false, expired: false, clientSecret: null })
    expect(await row(pid)).toEqual({ status: 'pending', stripe_payment_intent_id: null })
    expect((await db.query<any>(`SELECT status FROM tenant_remittances WHERE stripe_payment_intent_id='pi_screen'`)).rows[0].status).toBe('failed')
    expect(paymentIntentsCancelMock).not.toHaveBeenCalled()
    // The bill is payable at once.
    const again = await post(f, '/pay-balance', { amount: 1000, paymentMethodId: 'pm_x', paymentMethodType: 'ach' })
    expect(again.status, JSON.stringify(again.body)).toBe(200)
  })

  it('a payment still waiting on the bank is resumed with no outcome, only the bank\'s window', async () => {
    const f = await seed(); await ready(f)
    await bill(f)
    needsConfirm()
    await post(f, '/pay-balance', { amount: 1000, paymentMethodId: 'pm_x', paymentMethodType: 'card', confirmOnScreen: true })
    waitingOnBank()
    const r = await post(f, '/pay-balance/resume', { paymentIntentId: 'pi_screen' })
    expect(r.body.data.outcome).toBeUndefined()
    expect(r.body.data.clientSecret).toBe('pi_screen_secret_1')
  })

  it('a co-tenant is sent no made-up name for a payer with no name on file (the screen words it)', async () => {
    const f = await seed(); await ready(f)
    await bill(f)
    needsConfirm()
    await post(f, '/pay-balance', { amount: 1000, paymentMethodId: 'pm_x', paymentMethodType: 'card', confirmOnScreen: true })
    await db.query(`UPDATE users SET first_name = '', last_name = '' WHERE id = (SELECT user_id FROM tenants WHERE id = $1)`, [f.tenant1Id])
    const c = await db.connect()
    let coToken: string
    try {
      const coId = await seedTenant(c)
      await seedLeaseTenant(c, { leaseId: f.lease1Id, tenantId: coId })
      const uid = (await c.query<{ user_id: string }>(`SELECT user_id FROM tenants WHERE id=$1`, [coId])).rows[0].user_id
      coToken = sign({ userId: uid, role: 'tenant', email: 'co2@t.dev', profileId: coId })
    } finally { c.release() }
    waitingOnBank()
    const ctx = await request(buildApp()).get('/api/payments/balance-context').set('Authorization', `Bearer ${coToken}`)
    expect(ctx.status, JSON.stringify(ctx.body)).toBe(200)
    expect(ctx.body.data.awaitingCardConfirmations).toEqual([expect.objectContaining({ mine: false, payerName: null })])
  })

  it('a payment nobody confirmed within 30 minutes is released before a new payment, so the tenant can pay', async () => {
    const f = await seed(); await ready(f)
    const pid = await bill(f)
    needsConfirm()
    await post(f, '/pay-balance', { amount: 1000, paymentMethodId: 'pm_x', paymentMethodType: 'card', confirmOnScreen: true })
    await db.query(`UPDATE tenant_remittances SET created_at = now() - interval '31 minutes' WHERE stripe_payment_intent_id='pi_screen'`)
    waitingOnBank()
    const res = await post(f, '/pay-balance', { amount: 1000, paymentMethodId: 'pm_x', paymentMethodType: 'ach' })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(paymentIntentsCancelMock).toHaveBeenCalledWith('pi_screen')
    expect((await row(pid)).stripe_payment_intent_id).toBe('pi_plat_mock')
  })

  it('the pay screen\'s card charge is marked as confirmed on screen (so its bank\'s refusal is a release, not a decline); others are not', async () => {
    const f = await seed(); await ready(f)
    await bill(f)
    const md = () => (stripeConnect.createRentPlatformCharge as any).mock.calls.map((c: any[]) => c[0].metadata?.gam_confirm_on_screen ?? null)
    ;(stripeConnect.createRentPlatformCharge as any).mockClear()
    const r1 = await post(f, '/pay-balance', { amount: 1000, paymentMethodId: 'pm_x', paymentMethodType: 'card', confirmOnScreen: true })
    expect(r1.status, JSON.stringify(r1.body)).toBe(200)
    expect(md()).toEqual(['true'])
  })

  it('a card charge without the pay screen (the assistant) is not marked', async () => {
    const f = await seed(); await ready(f)
    await bill(f)
    ;(stripeConnect.createRentPlatformCharge as any).mockClear()
    await post(f, '/pay-balance', { amount: 1000, paymentMethodId: 'pm_x', paymentMethodType: 'card' })
    expect((stripeConnect.createRentPlatformCharge as any).mock.calls[0][0].metadata.gam_confirm_on_screen).toBeUndefined()
  })

  it('any look at the bill after 30 minutes opens it again — the tenant who closed the page is never left with a hidden bill', async () => {
    const f = await seed(); await ready(f)
    const pid = await bill(f)
    needsConfirm()
    await post(f, '/pay-balance', { amount: 1000, paymentMethodId: 'pm_x', paymentMethodType: 'card', confirmOnScreen: true })
    await db.query(`UPDATE tenant_remittances SET created_at = now() - interval '31 minutes' WHERE stripe_payment_intent_id='pi_screen'`)
    waitingOnBank()
    const ctx = await context(f)
    expect(ctx.status, JSON.stringify(ctx.body)).toBe(200)
    expect(paymentIntentsCancelMock).toHaveBeenCalledWith('pi_screen')
    expect((await row(pid)).status).toBe('pending')
    const l = ctx.body.data.leases.find((x: any) => x.leaseId === f.lease1Id)
    expect(l.requiredNow).toBe(1000)
    expect(l.awaitingConfirmation).toEqual([])
    expect(ctx.body.data.awaitingCardConfirmations).toEqual([])
  })

  it('the page gets every held card payment in one list, so a bill held whole can still be confirmed or canceled', async () => {
    const f = await seed(); await ready(f)
    await bill(f)
    needsConfirm()
    await post(f, '/pay-balance', { amount: 1000, paymentMethodId: 'pm_x', paymentMethodType: 'card', confirmOnScreen: true })
    waitingOnBank()
    const ctx = await context(f)
    const l = ctx.body.data.leases.find((x: any) => x.leaseId === f.lease1Id)
    expect(l.requiredNow).toBe(0)
    expect(ctx.body.data.awaitingCardConfirmations).toEqual([expect.objectContaining({
      paymentIntentId: 'pi_screen', leaseId: f.lease1Id, serviceAgreementId: null, canConfirm: true, mine: true, payerName: null,
    })])
  })

  it('resume after the time the screen showed: never offered again — released, and the bill opens', async () => {
    const f = await seed(); await ready(f)
    const pid = await bill(f)
    needsConfirm()
    await post(f, '/pay-balance', { amount: 1000, paymentMethodId: 'pm_x', paymentMethodType: 'card', confirmOnScreen: true })
    await db.query(`UPDATE tenant_remittances SET created_at = now() - interval '31 minutes' WHERE stripe_payment_intent_id='pi_screen'`)
    waitingOnBank()
    const r = await post(f, '/pay-balance/resume', { paymentIntentId: 'pi_screen' })
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    expect(r.body.data).toMatchObject({ outcome: 'released', clientSecret: null, status: 'canceled', expired: true, declined: false })
    expect(paymentIntentsCancelMock).toHaveBeenCalledWith('pi_screen')
    expect((await row(pid)).status).toBe('pending')
  })

  it('resume after the time ran out on a payment already canceled in Stripe says it was canceled, not that the time ran out', async () => {
    const f = await seed(); await ready(f)
    const pid = await bill(f)
    needsConfirm()
    await post(f, '/pay-balance', { amount: 1000, paymentMethodId: 'pm_x', paymentMethodType: 'card', confirmOnScreen: true })
    await db.query(`UPDATE tenant_remittances SET created_at = now() - interval '31 minutes' WHERE stripe_payment_intent_id='pi_screen'`)
    // Canceled in the Stripe dashboard; the receipt here still holds the bill.
    paymentIntentsRetrieveMock.mockImplementation(async (id: string) => ({ id, metadata: ON_SCREEN, status: 'canceled', client_secret: 'x' }))
    const r = await post(f, '/pay-balance/resume', { paymentIntentId: 'pi_screen' })
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    expect(r.body.data).toMatchObject({ outcome: 'released', status: 'canceled', expired: false, declined: false, clientSecret: null })
    // The money handling is the same either way: the bill is open, nothing charged.
    expect(await row(pid)).toEqual({ status: 'pending', stripe_payment_intent_id: null })
  })

  it('resume says why a payment is already released — declined by its bank, from the receipt — so the screen never guesses from the clock', async () => {
    const f = await seed(); await ready(f)
    await bill(f)
    needsConfirm()
    await post(f, '/pay-balance', { amount: 1000, paymentMethodId: 'pm_x', paymentMethodType: 'card', confirmOnScreen: true })
    paymentIntentsRetrieveMock.mockImplementation(async (id: string) => ({
      id, metadata: ON_SCREEN, status: 'requires_payment_method',
      last_payment_error: { type: 'card_error', code: 'card_declined', decline_code: 'insufficient_funds' },
    }))
    expect((await post(f, '/pay-balance/release', { paymentIntentId: 'pi_screen' })).body.data).toMatchObject({ outcome: 'released', declined: true })
    const r = await post(f, '/pay-balance/resume', { paymentIntentId: 'pi_screen' })
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    expect(r.body.data).toMatchObject({ outcome: 'released', declined: true, expired: false, clientSecret: null })
  })

  it('a co-tenant sees the held payment as waiting on the payer\'s card bank, by name — not clearing, and cannot confirm or cancel it', async () => {
    const f = await seed(); await ready(f)
    await bill(f)
    needsConfirm()
    await post(f, '/pay-balance', { amount: 1000, paymentMethodId: 'pm_x', paymentMethodType: 'card', confirmOnScreen: true })
    const c = await db.connect()
    let coToken: string
    try {
      const coId = await seedTenant(c)
      await seedLeaseTenant(c, { leaseId: f.lease1Id, tenantId: coId })
      const uid = (await c.query<{ user_id: string }>(`SELECT user_id FROM tenants WHERE id=$1`, [coId])).rows[0].user_id
      coToken = sign({ userId: uid, role: 'tenant', email: 'co@t.dev', profileId: coId })
    } finally { c.release() }
    const payer = (await db.query<any>(
      `SELECT u.first_name, u.last_name FROM tenants t JOIN users u ON u.id = t.user_id WHERE t.id = $1`, [f.tenant1Id])).rows[0]
    waitingOnBank()
    const ctx = await request(buildApp()).get('/api/payments/balance-context').set('Authorization', `Bearer ${coToken}`)
    expect(ctx.status, JSON.stringify(ctx.body)).toBe(200)
    const l = ctx.body.data.leases.find((x: any) => x.leaseId === f.lease1Id)
    expect(l.clearing).toBe(0)
    expect(l.awaitingConfirmation).toEqual([expect.objectContaining({
      paymentIntentId: 'pi_screen', mine: false, canConfirm: false, payerName: `${payer.first_name} ${payer.last_name}`.trim(),
    })])
    expect((await post(f, '/pay-balance/release', { paymentIntentId: 'pi_screen' }, coToken)).status).toBe(404)
    expect((await post(f, '/pay-balance/resume', { paymentIntentId: 'pi_screen' }, coToken)).status).toBe(404)
  })

  it('a payer with no lease (a service agreement) who leaves before confirming still gets the waiting block for that bill', async () => {
    const f = await seed(); await ready(f)
    const c = await db.connect()
    let agreementId: string
    try {
      agreementId = (await c.query<{ id: string }>(
        `INSERT INTO utility_service_agreements (landlord_id, unit_id, tenant_id, start_date)
         VALUES ($1,$2,$3,'2026-01-01') RETURNING id`, [f.aLid, f.aUnitId, f.tenant1Id])).rows[0].id
      const inv = (await c.query<{ id: string }>(
        `INSERT INTO invoices (landlord_id, unit_id, service_agreement_id, invoice_number, due_date, total_amount, subtotal_utilities)
         VALUES ($1,$2,$3,'SA-1',CURRENT_DATE,80,80) RETURNING id`, [f.aLid, f.aUnitId, agreementId])).rows[0].id
      await c.query(
        `INSERT INTO payments (unit_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description, invoice_id)
         VALUES ($1,$2,$3,'utility',80,'pending',CURRENT_DATE,'UTILITY',$4)`, [f.aUnitId, f.tenant1Id, f.aLid, inv])
    } finally { c.release() }
    needsConfirm()
    const res = await post(f, '/pay-balance', { amount: 80, serviceAgreementId: agreementId!, paymentMethodId: 'pm_x', paymentMethodType: 'card', confirmOnScreen: true })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.data).toMatchObject({ status: 'requires_action', clientSecret: 'pi_screen_secret_1' })
    waitingOnBank()
    const ctx = await context(f)
    expect(ctx.body.data.awaitingCardConfirmations).toEqual([expect.objectContaining({
      paymentIntentId: 'pi_screen', leaseId: null, serviceAgreementId: agreementId!, canConfirm: true,
    })])
    // cleanupAllSchema deletes a service agreement's payment rows before their
    // receipt lines (test helper, not this step's file): cleared here.
    await db.query(`DELETE FROM remittance_applications WHERE payment_id IN
                      (SELECT p.id FROM payments p JOIN invoices i ON i.id = p.invoice_id WHERE i.service_agreement_id = $1)`, [agreementId!])
  })

  it('a payment still inside its 30 minutes is not released by a new payment (the bill stays held)', async () => {
    const f = await seed(); await ready(f)
    await bill(f)
    needsConfirm()
    await post(f, '/pay-balance', { amount: 1000, paymentMethodId: 'pm_x', paymentMethodType: 'card', confirmOnScreen: true })
    waitingOnBank()
    const res = await post(f, '/pay-balance', { amount: 1000, paymentMethodId: 'pm_x', paymentMethodType: 'ach' })
    expect(res.status).toBe(409)
    expect(paymentIntentsCancelMock).not.toHaveBeenCalled()
  })

  // Review (pay6 fix pass): staff screens never read a hold that ran out.
  const heldOver = async (f: Fixture) => {
    const pid = await bill(f)
    needsConfirm()
    await post(f, '/pay-balance', { amount: 1000, paymentMethodId: 'pm_x', paymentMethodType: 'card', confirmOnScreen: true })
    await db.query(`UPDATE tenant_remittances SET created_at = now() - interval '31 minutes' WHERE stripe_payment_intent_id='pi_screen'`)
    waitingOnBank()
    return pid
  }
  const deskQuoteOf = (f: Fixture, pid: string) =>
    request(buildApp()).get(`/api/payments/${pid}/record-manual/quote`).set('Authorization', `Bearer ${f.tokenLandlordA}`)

  it('the desk quote releases a card hold that ran out before reading the bill: staff see it owed, not clearing', async () => {
    const f = await seed(); await ready(f)
    const pid = await heldOver(f)
    const q = await deskQuoteOf(f, pid)
    expect(q.status, JSON.stringify(q.body)).toBe(200)
    expect(paymentIntentsCancelMock).toHaveBeenCalledWith('pi_screen')
    expect(q.body.data).toMatchObject({ anchorOpen: true, currentTotal: 1000, clearing: 0, awaitingCard: [] })
    expect((await row(pid)).status).toBe('pending')
  })

  it('the desk quote keeps a card hold inside its 30 minutes in what is clearing and names it as waiting on the payer\'s card bank, by name and with the time it opens on the park\'s clock — nothing canceled', async () => {
    const f = await seed(); await ready(f)
    const pid = await bill(f)
    needsConfirm()
    await post(f, '/pay-balance', { amount: 1000, paymentMethodId: 'pm_x', paymentMethodType: 'card', confirmOnScreen: true })
    waitingOnBank()
    const payer = (await db.query<any>(
      `SELECT u.first_name, u.last_name FROM tenants t JOIN users u ON u.id = t.user_id WHERE t.id = $1`, [f.tenant1Id])).rows[0]
    const madeAt = (await db.query<any>(`SELECT created_at FROM tenant_remittances WHERE stripe_payment_intent_id='pi_screen'`)).rows[0].created_at
    const q = await deskQuoteOf(f, pid)
    expect(q.status, JSON.stringify(q.body)).toBe(200)
    expect(paymentIntentsCancelMock).not.toHaveBeenCalled()
    // The held amount stays on the desk window's screen ("Already on its way"),
    // with awaitingCard saying which part of it waits on the card's bank.
    expect(q.body.data).toMatchObject({ anchorOpen: false, currentTotal: 0, clearing: 1000 })
    // The park's own time zone rides along so the desk says the hour on the
    // park's clock, not the browser's (camelCase on the wire, always present).
    const tz = (await db.query<{ timezone: string }>(
      `SELECT pr.timezone FROM payments p JOIN units un ON un.id = p.unit_id JOIN properties pr ON pr.id = un.property_id
        WHERE p.id = $1`, [pid])).rows[0].timezone
    expect(q.body.data.awaitingCard).toEqual([{
      amount: expect.any(Number), heldAmount: 1000,
      confirmBy: new Date(new Date(madeAt).getTime() + 30 * 60_000).toISOString(),
      payerName: `${payer.first_name} ${payer.last_name}`.trim(),
      timezone: tz,
    }])
    expect(Object.keys(q.body.data.awaitingCard[0])).toContain('timezone')
    expect(q.body.data.awaitingCard[0].amount).toBeGreaterThan(1000)
    expect((await row(pid)).status).toBe('processing')
  })

  it('the desk quote gives a held card payment the time zone of the park its bill is on (a Chicago park says Chicago, never the server\'s or a default)', async () => {
    const f = await seed(); await ready(f)
    const pid = await bill(f)
    await db.query(
      `UPDATE properties SET timezone = 'America/Chicago'
        WHERE id = (SELECT un.property_id FROM payments p JOIN units un ON un.id = p.unit_id WHERE p.id = $1)`, [pid])
    needsConfirm()
    await post(f, '/pay-balance', { amount: 1000, paymentMethodId: 'pm_x', paymentMethodType: 'card', confirmOnScreen: true })
    waitingOnBank()
    const q = await deskQuoteOf(f, pid)
    expect(q.status, JSON.stringify(q.body)).toBe(200)
    expect(q.body.data.awaitingCard).toEqual([expect.objectContaining({ heldAmount: 1000, timezone: 'America/Chicago' })])
  })

  it('the desk quote never lists another company\'s held card payment for the same person', async () => {
    const f = await seed(); await ready(f)
    const pid = await bill(f)
    needsConfirm()
    await post(f, '/pay-balance', { amount: 1000, paymentMethodId: 'pm_x', paymentMethodType: 'card', confirmOnScreen: true })
    waitingOnBank()
    // Company B bills the same person: its desk sees nothing of company A's card payment.
    const bPid = await seedPayment({ unitId: f.bUnitId, tenantId: f.tenant1Id, landlordId: f.bLid, amount: 50 })
    const q = await request(buildApp()).get(`/api/payments/${bPid}/record-manual/quote`).set('Authorization', `Bearer ${f.tokenLandlordB}`)
    expect(q.status, JSON.stringify(q.body)).toBe(200)
    expect(q.body.data.awaitingCard).toEqual([])
    expect((await row(pid)).status).toBe('processing')
  })

  it('release: the card\'s bank confirmed the cardholder and then declined the payment — said as declined, the bill opens again, no decline fee', async () => {
    const f = await seed(); await ready(f)
    const pid = await bill(f)
    needsConfirm()
    await post(f, '/pay-balance', { amount: 1000, paymentMethodId: 'pm_x', paymentMethodType: 'card', confirmOnScreen: true })
    paymentIntentsRetrieveMock.mockImplementation(async (id: string) => ({
      id, metadata: ON_SCREEN, status: 'requires_payment_method',
      last_payment_error: { type: 'card_error', code: 'card_declined', decline_code: 'insufficient_funds' },
    }))
    const rel = await post(f, '/pay-balance/release', { paymentIntentId: 'pi_screen' })
    expect(rel.status, JSON.stringify(rel.body)).toBe(200)
    expect(rel.body.data).toEqual({ outcome: 'released', declined: true })
    expect((await row(pid)).status).toBe('pending')
    expect((await db.query(`SELECT 1 FROM payments WHERE entry_description = 'DECLINEFEE'`)).rows).toEqual([])
  })

  it('release: a 3-D Secure confirmation that failed is not called a decline', async () => {
    const f = await seed(); await ready(f)
    await bill(f)
    needsConfirm()
    await post(f, '/pay-balance', { amount: 1000, paymentMethodId: 'pm_x', paymentMethodType: 'card', confirmOnScreen: true })
    paymentIntentsRetrieveMock.mockImplementation(async (id: string) => ({
      id, metadata: ON_SCREEN, status: 'requires_payment_method',
      last_payment_error: { type: 'card_error', code: 'payment_intent_authentication_failure' },
    }))
    const rel = await post(f, '/pay-balance/release', { paymentIntentId: 'pi_screen' })
    expect(rel.body.data).toEqual({ outcome: 'released', declined: false })
  })

  // Fix pass 3: why a card payment was released is recorded on its receipt when
  // it is released (CARD_RELEASE_NOTE) — never inferred from whether a decline
  // fee row exists. The tenant Payments page reads this answer, as the wire
  // carries it, from one fixture.
  it('payment history: a card payment canceled before anything was charged, and one declined by its bank, are each marked so from what was recorded; an ordinary failed card payment is neither', async () => {
    const f = await seed(); await ready(f)
    await bill(f)
    needsConfirm()
    await post(f, '/pay-balance', { amount: 1000, paymentMethodId: 'pm_x', paymentMethodType: 'card', confirmOnScreen: true })
    waitingOnBank()
    await post(f, '/pay-balance/release', { paymentIntentId: 'pi_screen' })
    // The bill is open again: a second card payment its bank declines after the cardholder confirmed it.
    ;(stripeConnect.createRentPlatformCharge as any)
      .mockImplementationOnce(async () => ({ id: 'pi_screen_2', status: 'requires_action', client_secret: 'pi_screen_2_secret_1' }))
    const second = await post(f, '/pay-balance', { amount: 1000, paymentMethodId: 'pm_x', paymentMethodType: 'card', confirmOnScreen: true })
    expect(second.status, JSON.stringify(second.body)).toBe(200)
    paymentIntentsRetrieveMock.mockImplementation(async (id: string) => ({
      id, metadata: ON_SCREEN, status: 'requires_payment_method',
      last_payment_error: { type: 'card_error', code: 'card_declined', decline_code: 'insufficient_funds' },
    }))
    const rel = await post(f, '/pay-balance/release', { paymentIntentId: 'pi_screen_2' })
    expect(rel.body.data).toEqual({ outcome: 'released', declined: true })
    // A card payment the normal failure path closed (no on-screen confirmation, nothing recorded on it).
    await db.query(
      `INSERT INTO tenant_remittances (tenant_id, lease_id, landlord_id, amount, applied_amount, payment_method, status, stripe_payment_intent_id, created_at)
       VALUES ($1,$2,$3,25,25,'card','failed','pi_failed_plain', now() - interval '1 day')`,
      [f.tenant1Id, f.lease1Id, f.aLid])
    const res = await request(buildApp()).get('/api/payments/remittances').set('Authorization', `Bearer ${f.tokenTenant1}`)
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    // (Raw route columns here; the API's response transformer camelizes them on the wire.)
    const byPi = async (pi: string) => {
      const id = (await db.query<{ id: string }>(`SELECT id FROM tenant_remittances WHERE stripe_payment_intent_id = $1`, [pi])).rows[0].id
      return res.body.data.remittances.find((r: any) => r.id === id)
    }
    expect(await byPi('pi_screen')).toMatchObject({ status: 'failed', payment_method: 'card', canceled_before_charge: true, declined_before_charge: false })
    expect(await byPi('pi_screen_2')).toMatchObject({ status: 'failed', payment_method: 'card', canceled_before_charge: false, declined_before_charge: true })
    expect(await byPi('pi_failed_plain')).toMatchObject({ status: 'failed', canceled_before_charge: false, declined_before_charge: false })
    // The wire's answer (camelized) is the tenant Payments page's history fixture.
    const ids = new Map<string, string>()
    const stable = JSON.stringify(camelCaseKeys(res.body.data), null, 2)
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, (u) => {
        if (!ids.has(u)) ids.set(u, `00000000-0000-4000-8000-${String(ids.size + 1).padStart(12, '0')}`)
        return ids.get(u)!
      })
      .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g, '2026-10-04T18:30:00.000Z')
      .replace(/"\d{4}-\d{2}-\d{2}"/g, '"2026-10-04"') + '\n'
    const file = path.join(__dirname, '../../../tenant/src/pages/__fixtures__/remittances.cardReleased.real.json')
    if (process.env.PAYMENTS_FIXTURE_UPDATE === '1' || !fs.existsSync(file)) {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, stable)
    }
    expect(fs.readFileSync(file, 'utf8'), 'GET /remittances\'s answer for released card payments changed: run this test with PAYMENTS_FIXTURE_UPDATE=1, then the tenant PaymentsPage.awaiting test').toBe(stable)
  })

  it('release after the failure webhook already recorded a decline still says declined (Stripe has cleared the error by then)', async () => {
    const f = await seed(); await ready(f)
    const pid = await bill(f)
    needsConfirm()
    await post(f, '/pay-balance', { amount: 1000, paymentMethodId: 'pm_x', paymentMethodType: 'card', confirmOnScreen: true })
    // The webhook got there first, from the event's own copy of the charge.
    const { releaseFailedOnScreenConfirmation } = await import('../jobs/paymentReconcile')
    let now = 'requires_payment_method'
    paymentIntentsRetrieveMock.mockImplementation(async (id: string) => ({ id, metadata: ON_SCREEN, status: now }))
    paymentIntentsCancelMock.mockImplementationOnce(async (id: string) => { now = 'canceled'; return { id, status: 'canceled' } })
    const { getStripe } = await import('../lib/stripe')
    expect(await releaseFailedOnScreenConfirmation(getStripe(), {
      id: 'pi_screen', status: 'requires_payment_method', metadata: { gam_confirm_on_screen: 'true' },
      last_payment_error: { type: 'card_error', code: 'card_declined' },
    } as any)).toBe(true)
    expect((await row(pid)).status).toBe('pending')
    // The screen's release lands after: Stripe now shows no error, the receipt still says declined.
    const rel = await post(f, '/pay-balance/release', { paymentIntentId: 'pi_screen' })
    expect(rel.body.data).toEqual({ outcome: 'released', declined: true })
  })

  it('balance-context names the receipt of a held card payment, so the history can say it waits on the bank', async () => {
    const f = await seed(); await ready(f)
    await bill(f)
    needsConfirm()
    const paid = await post(f, '/pay-balance', { amount: 1000, paymentMethodId: 'pm_x', paymentMethodType: 'card', confirmOnScreen: true })
    waitingOnBank()
    const ctx = await context(f)
    expect(ctx.body.data.awaitingCardConfirmations).toEqual([expect.objectContaining({ remittanceId: paid.body.data.remittanceId })])
  })

  it('cash at the desk on a bill held by a card still inside its 30 minutes is refused in plain words, with when it opens', async () => {
    const f = await seed(); await ready(f)
    const pid = await bill(f)
    needsConfirm()
    await post(f, '/pay-balance', { amount: 1000, paymentMethodId: 'pm_x', paymentMethodType: 'card', confirmOnScreen: true })
    waitingOnBank()
    const res = await request(buildApp()).post(`/api/payments/${pid}/record-manual`)
      .set('Authorization', `Bearer ${f.tokenLandlordA}`)
      .send({ method: 'cash', amountTendered: 1000 })
    expect(res.status).toBe(409)
    const msg = JSON.stringify(res.body)
    expect(msg).toContain('waiting on the resident\'s card payment to be confirmed by their card\'s bank')
    expect(msg).toMatch(/opens here by itself at \d{1,2}:\d{2} [AP]M/)
    // The next step for a resident standing at the desk who wants to pay another way now.
    expect(msg).toContain('If they want to pay another way now, whoever made the card payment can tap \'Cancel it and pay another way\' on their Payments page, and the bill opens here.')
    expect(msg).not.toMatch(/close this window|open it again/i)
    expect(msg).not.toContain('status:')
    expect(msg).not.toContain('processing')
    expect(paymentIntentsCancelMock).not.toHaveBeenCalled()
  })

  it('cash at the desk on a held charge with no space (so no park clock) says when it opens without guessing a clock time', async () => {
    const f = await seed(); await ready(f)
    const pid = await bill(f)
    needsConfirm()
    await post(f, '/pay-balance', { amount: 1000, paymentMethodId: 'pm_x', paymentMethodType: 'card', confirmOnScreen: true })
    waitingOnBank()
    await db.query(`UPDATE payments SET unit_id = NULL WHERE id = $1`, [pid])
    const res = await request(buildApp()).post(`/api/payments/${pid}/record-manual`)
      .set('Authorization', `Bearer ${f.tokenLandlordA}`)
      .send({ method: 'cash', amountTendered: 1000 })
    expect(res.status).toBe(409)
    const msg = JSON.stringify(res.body)
    expect(msg).toContain('It opens here by itself within 30 minutes of when they paid if they don\'t confirm it.')
    expect(msg).not.toMatch(/\d{1,2}:\d{2} [AP]M/)
  })

  it('cash at the desk on a bill whose card went through but whose success has not landed says it was just paid — never "nothing has been charged"', async () => {
    const f = await seed(); await ready(f)
    const pid = await bill(f)
    needsConfirm()
    await post(f, '/pay-balance', { amount: 1000, paymentMethodId: 'pm_x', paymentMethodType: 'card', confirmOnScreen: true })
    // The cardholder confirmed; Stripe has the money, the webhook has not landed.
    paymentIntentsRetrieveMock.mockImplementation(async (id: string) => ({ id, metadata: ON_SCREEN, status: 'succeeded' }))
    const res = await request(buildApp()).post(`/api/payments/${pid}/record-manual`)
      .set('Authorization', `Bearer ${f.tokenLandlordA}`)
      .send({ method: 'cash', amountTendered: 1000 })
    expect(res.status).toBe(409)
    const msg = JSON.stringify(res.body)
    expect(msg).toContain('This charge was just paid or is on its way — the bill above was read again.')
    expect(msg).not.toContain('nothing has been charged')
    expect(paymentIntentsCancelMock).not.toHaveBeenCalled()
  })

  it('cash at the desk when Stripe cannot be read says a card payment is in progress and to try again — never that nothing was charged', async () => {
    const f = await seed(); await ready(f)
    const pid = await bill(f)
    needsConfirm()
    await post(f, '/pay-balance', { amount: 1000, paymentMethodId: 'pm_x', paymentMethodType: 'card', confirmOnScreen: true })
    paymentIntentsRetrieveMock.mockImplementation(async () => { throw new Error('Stripe unreachable') })
    const res = await request(buildApp()).post(`/api/payments/${pid}/record-manual`)
      .set('Authorization', `Bearer ${f.tokenLandlordA}`)
      .send({ method: 'cash', amountTendered: 1000 })
    expect(res.status).toBe(409)
    const msg = JSON.stringify(res.body)
    expect(msg).toContain('This charge has a card payment in progress that could not be checked just now — the bill above was read again. Try again in a minute.')
    expect(msg).not.toContain('nothing has been charged')
    expect((await row(pid)).status).toBe('processing')
  })

  // Review (pay8 fix pass 2): the desk asks Stripe about a held card however
  // old it is — a hold whose release failed is still a hold, never "just paid".
  const heldMinutesAgo = async (f: Fixture, minutes: number) => {
    const pid = await bill(f)
    needsConfirm()
    await post(f, '/pay-balance', { amount: 1000, paymentMethodId: 'pm_x', paymentMethodType: 'card', confirmOnScreen: true })
    await db.query(`UPDATE tenant_remittances SET created_at = now() - ($1 || ' minutes')::interval WHERE stripe_payment_intent_id='pi_screen'`, [String(minutes)])
    return pid
  }
  const cashAtDesk = (f: Fixture, pid: string) => request(buildApp()).post(`/api/payments/${pid}/record-manual`)
    .set('Authorization', `Bearer ${f.tokenLandlordA}`)
    .send({ method: 'cash', amountTendered: 1000 })

  it('cash at the desk on a 35-minute-old card hold while Stripe is down says a card payment is in progress — never "just paid"', async () => {
    const f = await seed(); await ready(f)
    const pid = await heldMinutesAgo(f, 35)
    paymentIntentsRetrieveMock.mockImplementation(async () => { throw new Error('Stripe unreachable') })
    const res = await cashAtDesk(f, pid)
    expect(res.status).toBe(409)
    const msg = JSON.stringify(res.body)
    expect(msg).toContain('This charge has a card payment in progress that could not be checked just now — the bill above was read again. Try again in a minute.')
    expect(msg).not.toContain('just paid')
    expect((await row(pid)).status).toBe('processing')
  })

  it('cash at the desk on a 35-minute-old card hold the sweep could not cancel: the desk cancels it now and says the bill is open', async () => {
    const f = await seed(); await ready(f)
    const pid = await heldMinutesAgo(f, 35)
    waitingOnBank()
    // The release before the desk reads the bill fails once (Stripe hiccup); the desk's own try works.
    paymentIntentsCancelMock.mockImplementationOnce(async () => { throw new Error('Stripe hiccup') })
    const res = await cashAtDesk(f, pid)
    expect(res.status).toBe(409)
    const msg = JSON.stringify(res.body)
    expect(msg).toContain('The resident\'s card payment on this bill was canceled before anything was charged, so the bill is open again — the bill above was read again. Take the payment now.')
    expect(msg).not.toContain('just paid')
    expect(await row(pid)).toEqual({ status: 'pending', stripe_payment_intent_id: null })
    const again = await cashAtDesk(f, pid)
    expect(again.status, JSON.stringify(again.body)).toBe(200)
  })

  it('cash at the desk on a 35-minute-old card hold Stripe will not cancel says nothing was charged and it opens here in a few minutes', async () => {
    const f = await seed(); await ready(f)
    const pid = await heldMinutesAgo(f, 35)
    waitingOnBank()
    paymentIntentsCancelMock.mockImplementationOnce(async () => { throw new Error('Stripe hiccup') })
    paymentIntentsCancelMock.mockImplementationOnce(async () => { throw new Error('Stripe hiccup') })
    const res = await cashAtDesk(f, pid)
    expect(res.status).toBe(409)
    const msg = JSON.stringify(res.body)
    expect(msg).toContain('nothing has been charged and the bill is opening again. It opens here in a few minutes — try again then.')
    expect(msg).not.toContain('just paid')
    expect((await row(pid)).status).toBe('processing')
  })

  it('cash at the desk on a bill whose card was canceled in Stripe while its rows still wait: the bill opens now and the desk says nothing was charged', async () => {
    const f = await seed(); await ready(f)
    const pid = await heldMinutesAgo(f, 5)
    // Canceled in the Stripe dashboard; the canceled webhook has not landed.
    paymentIntentsRetrieveMock.mockImplementation(async (id: string) => ({ id, metadata: ON_SCREEN, status: 'canceled' }))
    const res = await cashAtDesk(f, pid)
    expect(res.status).toBe(409)
    const msg = JSON.stringify(res.body)
    expect(msg).toContain('canceled before anything was charged, so the bill is open again')
    expect(msg).not.toContain('just paid')
    expect(await row(pid)).toEqual({ status: 'pending', stripe_payment_intent_id: null })
    expect((await db.query<any>(`SELECT status FROM tenant_remittances WHERE stripe_payment_intent_id='pi_screen'`)).rows[0].status).toBe('failed')
    expect(paymentIntentsCancelMock).not.toHaveBeenCalled()
  })

  it('the reader on a bill whose card was canceled in Stripe while its rows still wait opens the bill and says nothing was charged', async () => {
    const f = await seed(); await ready(f)
    const pid = await heldMinutesAgo(f, 5)
    paymentIntentsRetrieveMock.mockImplementation(async (id: string) => ({ id, metadata: ON_SCREEN, status: 'canceled' }))
    const res = await request(buildApp()).get(`/api/payments/${pid}/reader/readers`).set('Authorization', `Bearer ${f.tokenLandlordA}`)
    expect(res.status).toBe(409)
    expect(JSON.stringify(res.body)).toContain('canceled before anything was charged, so the bill is open again')
    expect((await row(pid)).status).toBe('pending')
  })

  // Review (pay7 money-3): only the pay screen's own card charge is held for
  // its cardholder. A card charge made some other way that waits in Stripe —
  // a move-out balance charge GAM saved but could not confirm yet
  // (depositReturn attemptGapAutoCharge, gam_kind 'deposit_return_gap', left
  // in requires_confirmation for finishPendingGapCharges) — is GAM's to finish.
  describe('a card charge the pay screen did not make (a move-out balance charge GAM is finishing)', () => {
    async function gapWaiting(f: Fixture, minutesOld: number) {
      const pid = await bill(f)
      needsConfirm()
      await post(f, '/pay-balance', { amount: 1000, paymentMethodId: 'pm_x', paymentMethodType: 'card', confirmOnScreen: true })
      await db.query(`UPDATE tenant_remittances SET created_at = now() - ($1 || ' minutes')::interval WHERE stripe_payment_intent_id='pi_screen'`, [String(minutesOld)])
      paymentIntentsRetrieveMock.mockImplementation(async (id: string) => ({
        id, status: 'requires_confirmation', metadata: { gam_kind: 'deposit_return_gap', gam_payment_id: pid },
      }))
      return pid
    }
    const noteOn = async () => (await db.query<any>(
      `SELECT status, notes FROM tenant_remittances WHERE stripe_payment_intent_id='pi_screen'`)).rows[0]

    it('left waiting 40 minutes, it is not canceled by any look at the bill and is never shown as waiting on the tenant\'s bank', async () => {
      const f = await seed(); await ready(f)
      const pid = await gapWaiting(f, 40)
      const ctx = await context(f)
      expect(ctx.status, JSON.stringify(ctx.body)).toBe(200)
      expect(ctx.body.data.awaitingCardConfirmations).toEqual([])
      expect(ctx.body.data.leases.find((l: any) => l.leaseId === f.lease1Id).awaitingConfirmation ?? []).toEqual([])
      expect(paymentIntentsCancelMock).not.toHaveBeenCalled()
      expect(await row(pid)).toEqual({ status: 'processing', stripe_payment_intent_id: 'pi_screen' })
      expect(await noteOn()).toEqual({ status: 'processing', notes: null })
    })

    it('the tenant cannot cancel or confirm it from the Payments page: refused in plain words, nothing done', async () => {
      const f = await seed(); await ready(f)
      const pid = await gapWaiting(f, 40)
      for (const path of ['/pay-balance/release', '/pay-balance/resume']) {
        const r = await post(f, path, { paymentIntentId: 'pi_screen' })
        expect(r.status, `${path} ${JSON.stringify(r.body)}`).toBe(409)
        expect(JSON.stringify(r.body)).toContain('That card payment isn\'t waiting on your card\'s bank, so there is nothing to confirm or cancel here.')
      }
      expect(paymentIntentsCancelMock).not.toHaveBeenCalled()
      expect((await row(pid)).status).toBe('processing')
      expect(await noteOn()).toEqual({ status: 'processing', notes: null })
    })

    it('the desk quote leaves it alone and never names it as waiting on the resident\'s card bank', async () => {
      const f = await seed(); await ready(f)
      const pid = await gapWaiting(f, 40)
      const q = await deskQuoteOf(f, pid)
      expect(q.status, JSON.stringify(q.body)).toBe(200)
      expect(q.body.data.awaitingCard).toEqual([])
      expect(paymentIntentsCancelMock).not.toHaveBeenCalled()
      expect((await row(pid)).status).toBe('processing')
    })

    it('cash at the desk on it inside 30 minutes is never told "nothing has been charged" by the resident\'s bank', async () => {
      const f = await seed(); await ready(f)
      const pid = await gapWaiting(f, 5)
      const res = await request(buildApp()).post(`/api/payments/${pid}/record-manual`)
        .set('Authorization', `Bearer ${f.tokenLandlordA}`)
        .send({ method: 'cash', amountTendered: 1000 })
      expect(res.status).toBe(409)
      expect(JSON.stringify(res.body)).not.toContain('waiting on the resident')
      expect(paymentIntentsCancelMock).not.toHaveBeenCalled()
    })
  })

  it('cash at the desk on a charge already paid says so in plain words — never asks staff to close or reopen the window, which reads the bill again by itself', async () => {
    const f = await seed(); await ready(f)
    const pid = await bill(f)
    await db.query(`UPDATE payments SET status = 'settled' WHERE id = $1`, [pid])
    const res = await request(buildApp()).post(`/api/payments/${pid}/record-manual`)
      .set('Authorization', `Bearer ${f.tokenLandlordA}`)
      .send({ method: 'cash', amountTendered: 1000 })
    expect(res.status).toBe(409)
    expect(JSON.stringify(res.body)).toContain('This charge was just paid or is on its way — the bill above was read again.')
    expect(JSON.stringify(res.body)).not.toContain('status:')
    expect(JSON.stringify(res.body)).not.toMatch(/close this window|open it again/i)
  })

  it('another company\'s desk cannot release this household\'s expired card hold: refused first, nothing canceled', async () => {
    const f = await seed(); await ready(f)
    const pid = await heldOver(f)
    const res = await request(buildApp()).post(`/api/payments/${pid}/record-manual`)
      .set('Authorization', `Bearer ${f.tokenLandlordB}`)
      .send({ method: 'cash', amountTendered: 1000 })
    expect(res.status).toBe(403)
    expect(paymentIntentsCancelMock).not.toHaveBeenCalled()
    expect((await row(pid)).status).toBe('processing')
  })

  // Review (pay7 fix pass 2): the Payments page's held-payment test reads this
  // route's real answer, as the wire carries it (camelized), from one fixture —
  // never a hand-written shape each side assumes.
  it('balance-context for a held card payment, as the payer and as a co-tenant, is the Payments page\'s fixture', async () => {
    const f = await seed(); await ready(f)
    await bill(f)
    needsConfirm()
    await post(f, '/pay-balance', { amount: 1000, paymentMethodId: 'pm_x', paymentMethodType: 'card', confirmOnScreen: true })
    await db.query(`UPDATE users SET first_name = 'Jane', last_name = 'Doe' WHERE id = (SELECT user_id FROM tenants WHERE id = $1)`, [f.tenant1Id])
    const c = await db.connect()
    let coToken: string
    try {
      const coId = await seedTenant(c)
      await seedLeaseTenant(c, { leaseId: f.lease1Id, tenantId: coId })
      const uid = (await c.query<{ user_id: string }>(`SELECT user_id FROM tenants WHERE id=$1`, [coId])).rows[0].user_id
      coToken = sign({ userId: uid, role: 'tenant', email: 'cofix@t.dev', profileId: coId })
    } finally { c.release() }
    await db.query(`UPDATE properties SET name = 'Oak Park' WHERE id = $1`, [f.aPropId])
    await db.query(`UPDATE units SET unit_number = 'MH 09' WHERE id = $1`, [f.aUnitId])
    waitingOnBank()
    const payer = await context(f)
    const co = await request(buildApp()).get('/api/payments/balance-context').set('Authorization', `Bearer ${coToken!}`)
    expect(payer.status, JSON.stringify(payer.body)).toBe(200)
    expect(co.status, JSON.stringify(co.body)).toBe(200)
    const ids = new Map<string, string>()
    const stable = JSON.stringify(camelCaseKeys({ payer: payer.body.data, coTenant: co.body.data }), null, 2)
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, (u) => {
        if (!ids.has(u)) ids.set(u, `00000000-0000-4000-8000-${String(ids.size + 1).padStart(12, '0')}`)
        return ids.get(u)!
      })
      .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g, '2026-10-04T18:30:00.000Z')
      .replace(/"\d{4}-\d{2}-\d{2}"/g, '"2026-10-04"') + '\n'
    const file = path.join(__dirname, '../../../tenant/src/pages/__fixtures__/balanceContext.awaiting.real.json')
    if (process.env.PAYMENTS_FIXTURE_UPDATE === '1' || !fs.existsSync(file)) {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, stable)
    }
    expect(fs.readFileSync(file, 'utf8'), 'balance-context\'s answer for a held card payment changed: run this test with PAYMENTS_FIXTURE_UPDATE=1, then the tenant PaymentsPage.awaiting test').toBe(stable)
  })

  it('a check posted by another company for the same person never releases this company\'s card hold', async () => {
    const f = await seed(); await ready(f)
    const pid = await heldOver(f)
    await request(buildApp()).post('/api/payments/post-payment')
      .set('Authorization', `Bearer ${f.tokenLandlordB}`)
      .send({ tenantId: f.tenant1Id, method: 'check', amount: 1000 })
    expect(paymentIntentsCancelMock).not.toHaveBeenCalled()
    expect((await row(pid)).status).toBe('processing')
  })

  it('cash at the desk on a bill whose card hold ran out is taken: the hold is released first, then the bill settled', async () => {
    const f = await seed(); await ready(f)
    const pid = await heldOver(f)
    const res = await request(buildApp()).post(`/api/payments/${pid}/record-manual`)
      .set('Authorization', `Bearer ${f.tokenLandlordA}`)
      .send({ method: 'cash', amountTendered: 1000 })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(paymentIntentsCancelMock).toHaveBeenCalledWith('pi_screen')
    expect((await row(pid)).status).toBe('settled')
    expect((await db.query<any>(`SELECT status FROM tenant_remittances WHERE stripe_payment_intent_id='pi_screen'`)).rows[0].status).toBe('failed')
  })

  it('a check posted for the household releases a card hold that ran out first, so it pays that bill', async () => {
    const f = await seed(); await ready(f)
    const pid = await heldOver(f)
    const res = await request(buildApp()).post('/api/payments/post-payment')
      .set('Authorization', `Bearer ${f.tokenLandlordA}`)
      .send({ tenantId: f.tenant1Id, method: 'check', amount: 1000 })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(paymentIntentsCancelMock).toHaveBeenCalledWith('pi_screen')
    expect((await row(pid)).status).toBe('settled')
    expect(res.body.data.paidAhead ?? 0).toBe(0)
  })
})

// autopaycredit2 review problem 3: "Pay all" explained only the credit the
// bills use. The run now carries the credit on file and where the rest goes.
describe('Pay all: every dollar of the credit on file is explained', () => {
  const context = (f: Fixture) => request(buildApp()).get('/api/payments/balance-context').set('Authorization', `Bearer ${f.tokenTenant1}`)
  async function secondLease(f: Fixture): Promise<{ leaseId: string; unitId: string }> {
    const c = await db.connect()
    try {
      const unitId = await seedUnit(c, { propertyId: f.aPropId, landlordId: f.aLid })
      const leaseId = await seedLease(c, { unitId, landlordId: f.aLid })
      await seedLeaseTenant(c, { leaseId, tenantId: f.tenant1Id, role: 'primary' })
      return { leaseId, unitId }
    } finally { c.release() }
  }
  const credit = async (f: Fixture, amount: number, leaseId: string | null) => db.query(
    `INSERT INTO tenant_credits (landlord_id, tenant_id, lease_id, amount_original, amount_remaining, category)
     VALUES ($1,$2,$3,$4,$4,'other')`, [f.aLid, f.tenant1Id, leaseId, amount.toFixed(2)])

  it('two bills of $300 and $400 with $1,000 of credit: $700 pays them, $300 stays for a later bill', async () => {
    const f = await seed()
    const two = await secondLease(f)
    await seedPayment({ unitId: f.aUnitId, tenantId: f.tenant1Id, landlordId: f.aLid, amount: 300, leaseId: f.lease1Id })
    await seedPayment({ unitId: two.unitId, tenantId: f.tenant1Id, landlordId: f.aLid, amount: 400, leaseId: two.leaseId })
    await credit(f, 1000, null)
    const res = await context(f)
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    const run = res.body.data.leases.map((l: any) => l.payAll)
    expect(run.reduce((s: number, p: any) => s + p.usableCredit, 0)).toBe(700)
    for (const p of run) {
      expect(p).toMatchObject({
        runCreditOnFile: 1000, runCreditKeptForLater: 300, runCreditKeptElsewhere: 0, runCreditAlsoHeld: 0,
        runCreditRestNote: '$300.00 of your credit stays on your account for a later bill.',
      })
    }
  })

  it('credit tied to a lease outside the run is said to be kept for that lease, and the parts add up to the credit on file', async () => {
    const f = await seed()
    const two = await secondLease(f)
    const three = await secondLease(f)
    await seedPayment({ unitId: f.aUnitId, tenantId: f.tenant1Id, landlordId: f.aLid, amount: 1300, leaseId: f.lease1Id })
    await seedPayment({ unitId: two.unitId, tenantId: f.tenant1Id, landlordId: f.aLid, amount: 1400, leaseId: two.leaseId })
    await credit(f, 1000, null)
    await credit(f, 270, three.leaseId)
    const res = await context(f)
    const p = res.body.data.leases.find((l: any) => l.leaseId === f.lease1Id).payAll
    const usable = res.body.data.leases.reduce((s: number, l: any) => s + (l.payAll?.usableCredit ?? 0), 0)
    expect(p.runCreditOnFile).toBe(1270)
    expect(usable).toBe(1000)
    expect(p.runCreditKeptElsewhere).toBe(270)
    expect(Math.round((usable + p.runCreditKeptElsewhere + p.runCreditKeptForLater + p.runCreditAlsoHeld) * 100) / 100).toBe(1270)
    expect(p.runCreditRestNote).toBe('$270.00 of your credit is kept for a bill on another lease.')
  })
})
