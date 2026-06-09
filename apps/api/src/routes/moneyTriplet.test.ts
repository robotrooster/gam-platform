/**
 * S449 route-test slice — money-flow triplet:
 *   - withdrawals.ts (181 lines): Stripe Payouts manual on-demand
 *     (GET /me/withdrawals/preview + POST /me/withdrawals)
 *   - finances.ts   (138 lines): per-user balance + ledger entries
 *     (GET /me/finances)
 *   - disbursements.ts (45 lines): disbursement list
 *     (GET /api/disbursements)
 *
 * All three intertwine on Stripe Connect balance / Payout audit rows.
 * Mocking strategy: stub `services/connectPayouts` so getConnectBalance
 * + firePayoutForConnectAccount return fixture values; we exercise the
 * route's gating + scoping + audit-write logic, not the Stripe-call
 * internals (which `s438Triplet.test.ts` already covers).
 *
 * Bug-sweep angle: these routes have NEVER had .test.ts coverage and
 * carry real-money flows (Stripe Payouts, balance display). Authoring
 * pins behavior + surfaces any sloppy gates.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

const {
  getConnectBalanceMock,
  firePayoutMock,
} = vi.hoisted(() => ({
  getConnectBalanceMock: vi.fn(async () => ({
    available:         [{ currency: 'usd', amount: 0 }],
    pending:           [{ currency: 'usd', amount: 0 }],
    instant_available: [{ currency: 'usd', amount: 0 }],
  } as any)),
  firePayoutMock: vi.fn(async () => ({ id: 'po_default_mock' } as any)),
}))

vi.mock('../services/connectPayouts', () => ({
  getConnectBalance:           getConnectBalanceMock,
  firePayoutForConnectAccount: firePayoutMock,
  // The service exports a few more helpers (s438Triplet covers them);
  // unused here, stub to keep the module shape complete in case any
  // incidental import chain uses them.
  getAvailableUsdBalance:        vi.fn(),
  getInstantAvailableUsdBalance: vi.fn(),
}))

import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { randomUUID } from 'crypto'
import { db } from '../db'
import { errorHandler } from '../middleware/errorHandler'
import { withdrawalsRouter } from './withdrawals'
import { financesRouter } from './finances'
import { disbursementsRouter } from './disbursements'
import {
  cleanupAllSchema, seedLandlord, seedProperty,
} from '../test/dbHelpers'

beforeEach(async () => {
  await cleanupAllSchema()
  getConnectBalanceMock.mockReset()
  firePayoutMock.mockReset()
  getConnectBalanceMock.mockResolvedValue({
    available:         [{ currency: 'usd', amount: 0 }],
    pending:           [{ currency: 'usd', amount: 0 }],
    instant_available: [{ currency: 'usd', amount: 0 }],
  } as any)
  firePayoutMock.mockResolvedValue({ id: 'po_default_mock' } as any)
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_money_triplet'
})

const sign = (claims: any) =>
  jwt.sign(claims, process.env.JWT_SECRET!, { expiresIn: '1h' })

function buildApp() {
  const app = express()
  app.use(express.json({ limit: '2mb' }))
  app.use('/api',                withdrawalsRouter)
  app.use('/api',                financesRouter)
  app.use('/api/disbursements',  disbursementsRouter)
  app.use(errorHandler)
  return app
}

interface UserFixture {
  userId:     string
  landlordId: string
  token:      string
}

async function seedUser(opts: {
  role?: 'landlord' | 'admin' | 'super_admin'
  hasConnect?: boolean
  connectReady?: boolean
} = {}): Promise<UserFixture> {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const { userId, landlordId } = await seedLandlord(c)
    const role = opts.role ?? 'landlord'
    if (role !== 'landlord') {
      await c.query(`UPDATE users SET role = $1 WHERE id = $2`, [role, userId])
    }
    if (opts.hasConnect !== false) {
      await c.query(
        `UPDATE users
            SET stripe_connect_account_id    = $2,
                connect_payouts_enabled      = $3,
                connect_details_submitted    = $3
          WHERE id = $1`,
        [userId, `acct_test_${userId.slice(0, 8)}`, opts.connectReady !== false])
    }
    await c.query('COMMIT')
    return {
      userId, landlordId,
      token: sign({ userId, role, email: `${userId}@test.dev`, profileId: landlordId, permissions: {} }),
    }
  } catch (e) { await c.query('ROLLBACK'); throw e }
  finally { c.release() }
}

// ═══════════════════════════════════════════════════════════════
//  GET /me/withdrawals/preview
// ═══════════════════════════════════════════════════════════════

describe('GET /me/withdrawals/preview', () => {
  it('no Stripe Connect account → 409 onboarding-incomplete', async () => {
    const u = await seedUser({ hasConnect: false })
    const res = await request(buildApp())
      .get('/api/me/withdrawals/preview')
      .set('Authorization', `Bearer ${u.token}`)
    expect(res.status).toBe(409)
    expect(res.body.error).toMatch(/onboarding incomplete/i)
  })

  it('connect_payouts_enabled=false → 409 (KYC not complete)', async () => {
    const u = await seedUser({ connectReady: false })
    const res = await request(buildApp())
      .get('/api/me/withdrawals/preview')
      .set('Authorization', `Bearer ${u.token}`)
    expect(res.status).toBe(409)
  })

  it('happy: $100 standard + $50 instant → shape with fee math', async () => {
    const u = await seedUser()
    getConnectBalanceMock.mockResolvedValueOnce({
      available:         [{ currency: 'usd', amount: 100 }],
      pending:           [{ currency: 'usd', amount: 0 }],
      instant_available: [{ currency: 'usd', amount: 50 }],
    } as any)
    const res = await request(buildApp())
      .get('/api/me/withdrawals/preview')
      .set('Authorization', `Bearer ${u.token}`)
    expect(res.status).toBe(200)
    expect(res.body.data.standard).toEqual({ available: 100, eligible: true })
    // instant fee = max(50 * 0.015, 0.50) = max(0.75, 0.50) = 0.75
    expect(res.body.data.instant.available).toBe(50)
    expect(res.body.data.instant.fee).toBe(0.75)
    expect(res.body.data.instant.net).toBe(49.25)
    expect(res.body.data.instant.eligible).toBe(true)
  })

  it('instant fee MIN $0.50 floor: small balance ($10) → fee = $0.50', async () => {
    const u = await seedUser()
    getConnectBalanceMock.mockResolvedValueOnce({
      available:         [{ currency: 'usd', amount: 0 }],
      pending:           [{ currency: 'usd', amount: 0 }],
      instant_available: [{ currency: 'usd', amount: 10 }],
    } as any)
    const res = await request(buildApp())
      .get('/api/me/withdrawals/preview')
      .set('Authorization', `Bearer ${u.token}`)
    expect(res.body.data.instant.fee).toBe(0.5)   // floor wins over 10*0.015=0.15
    expect(res.body.data.instant.net).toBe(9.5)
  })

  it('zero balance → both channels ineligible, no fee on instant', async () => {
    const u = await seedUser()
    // Default mock returns zeros.
    const res = await request(buildApp())
      .get('/api/me/withdrawals/preview')
      .set('Authorization', `Bearer ${u.token}`)
    expect(res.status).toBe(200)
    expect(res.body.data.standard.eligible).toBe(false)
    expect(res.body.data.instant.eligible).toBe(false)
    expect(res.body.data.instant.fee).toBe(0)
  })

  it('no auth header → 401', async () => {
    const res = await request(buildApp()).get('/api/me/withdrawals/preview')
    expect(res.status).toBe(401)
  })
})

// ═══════════════════════════════════════════════════════════════
//  POST /me/withdrawals
// ═══════════════════════════════════════════════════════════════

describe('POST /me/withdrawals', () => {
  it('no Connect → 409', async () => {
    const u = await seedUser({ hasConnect: false })
    const res = await request(buildApp())
      .post('/api/me/withdrawals')
      .set('Authorization', `Bearer ${u.token}`)
      .send({})
    expect(res.status).toBe(409)
  })

  it('connect_details_submitted=false → 409', async () => {
    const u = await seedUser({ connectReady: false })
    const res = await request(buildApp())
      .post('/api/me/withdrawals')
      .set('Authorization', `Bearer ${u.token}`)
      .send({})
    expect(res.status).toBe(409)
  })

  it('zero available balance → 400', async () => {
    const u = await seedUser()
    const res = await request(buildApp())
      .post('/api/me/withdrawals')
      .set('Authorization', `Bearer ${u.token}`)
      .send({})
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/No standard balance available/)
    expect(firePayoutMock).not.toHaveBeenCalled()
  })

  it('happy standard: fires payout with method=standard + audit row + 0 fee', async () => {
    const u = await seedUser()
    getConnectBalanceMock.mockResolvedValueOnce({
      available:         [{ currency: 'usd', amount: 250 }],
      pending:           [],
      instant_available: [{ currency: 'usd', amount: 100 }],
    } as any)
    firePayoutMock.mockResolvedValueOnce({ id: 'po_std_xyz' } as any)

    const res = await request(buildApp())
      .post('/api/me/withdrawals')
      .set('Authorization', `Bearer ${u.token}`)
      .send({ method: 'standard' })
    expect(res.status).toBe(201)
    expect(res.body.data.stripe_payout_id).toBe('po_std_xyz')
    expect(res.body.data.amount).toBe(250)
    expect(res.body.data.method).toBe('standard')
    expect(res.body.data.fee_charged).toBe(0)
    expect(res.body.data.net_to_user).toBe(250)

    expect(firePayoutMock).toHaveBeenCalledTimes(1)
    const call = (firePayoutMock.mock.calls[0] as any[])[0] as any
    expect(call.method).toBe('standard')
    expect(call.amount).toBe(250)
    expect(call.metadata.gam_entity_id).toBe(u.userId)
    expect(call.idempotencyKey).toMatch(/^manual_standard_acct_test_/)

    // Audit row in disbursements
    const { rows } = await db.query<any>(
      `SELECT * FROM disbursements WHERE id = $1`, [res.body.data.disbursement_id])
    expect(rows).toHaveLength(1)
    expect(rows[0].trigger_type).toBe('manual_on_demand')
    expect(rows[0].status).toBe('processing')
    expect(rows[0].stripe_payout_id).toBe('po_std_xyz')
    expect(rows[0].fee_charged).toBe('0.00')
    expect(rows[0].amount).toBe('250.00')
  })

  it('happy instant: pulls instant_available, stamps projected fee, net subtracts', async () => {
    const u = await seedUser()
    getConnectBalanceMock.mockResolvedValueOnce({
      available:         [{ currency: 'usd', amount: 250 }],
      pending:           [],
      instant_available: [{ currency: 'usd', amount: 100 }],
    } as any)
    firePayoutMock.mockResolvedValueOnce({ id: 'po_inst_xyz' } as any)

    const res = await request(buildApp())
      .post('/api/me/withdrawals')
      .set('Authorization', `Bearer ${u.token}`)
      .send({ method: 'instant' })
    expect(res.status).toBe(201)
    expect(res.body.data.amount).toBe(100)        // instant_available, not available
    // fee = max(100 * 0.015, 0.50) = max(1.5, 0.5) = 1.5
    expect(res.body.data.fee_charged).toBe(1.5)
    expect(res.body.data.net_to_user).toBe(98.5)
    expect(res.body.data.method).toBe('instant')

    const call = (firePayoutMock.mock.calls[0] as any[])[0] as any
    expect(call.method).toBe('instant')
    expect(call.amount).toBe(100)

    const { rows } = await db.query<any>(
      `SELECT amount, fee_charged FROM disbursements WHERE id = $1`,
      [res.body.data.disbursement_id])
    expect(rows[0].amount).toBe('100.00')
    expect(rows[0].fee_charged).toBe('1.50')
  })

  it('default method (omitted) → standard', async () => {
    const u = await seedUser()
    getConnectBalanceMock.mockResolvedValueOnce({
      available:         [{ currency: 'usd', amount: 50 }],
      pending:           [],
      instant_available: [{ currency: 'usd', amount: 50 }],
    } as any)
    const res = await request(buildApp())
      .post('/api/me/withdrawals')
      .set('Authorization', `Bearer ${u.token}`)
      .send({})
    expect(res.status).toBe(201)
    expect(res.body.data.method).toBe('standard')
  })

  it('invalid method → 400 (zod)', async () => {
    const u = await seedUser()
    const res = await request(buildApp())
      .post('/api/me/withdrawals')
      .set('Authorization', `Bearer ${u.token}`)
      .send({ method: 'overnight' })
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(res.status).toBeLessThan(500)
    expect(firePayoutMock).not.toHaveBeenCalled()
  })

  it('idempotency key embeds method + connect account id (so double-click within same second dedupes)', async () => {
    const u = await seedUser()
    getConnectBalanceMock.mockResolvedValue({
      available:         [{ currency: 'usd', amount: 100 }],
      pending:           [],
      instant_available: [{ currency: 'usd', amount: 100 }],
    } as any)
    await request(buildApp())
      .post('/api/me/withdrawals')
      .set('Authorization', `Bearer ${u.token}`)
      .send({ method: 'standard' })
    await request(buildApp())
      .post('/api/me/withdrawals')
      .set('Authorization', `Bearer ${u.token}`)
      .send({ method: 'instant' })
    const callA = (firePayoutMock.mock.calls[0] as any[])[0] as any
    const callB = (firePayoutMock.mock.calls[1] as any[])[0] as any
    expect(callA.idempotencyKey).toMatch(/^manual_standard_/)
    expect(callB.idempotencyKey).toMatch(/^manual_instant_/)
    expect(callA.idempotencyKey).not.toBe(callB.idempotencyKey)
  })
})

// ═══════════════════════════════════════════════════════════════
//  GET /me/finances
// ═══════════════════════════════════════════════════════════════

describe('GET /me/finances', () => {
  it('no Connect → current_balance=0, connect_ready=false, no Stripe call', async () => {
    const u = await seedUser({ hasConnect: false })
    const res = await request(buildApp())
      .get('/api/me/finances')
      .set('Authorization', `Bearer ${u.token}`)
    expect(res.status).toBe(200)
    expect(res.body.data.current_balance).toBe(0)
    expect(res.body.data.pending_balance).toBe(0)
    expect(res.body.data.connect_ready).toBe(false)
    expect(getConnectBalanceMock).not.toHaveBeenCalled()
  })

  it('Stripe balance call surfaces available+pending; connect_ready reflects flags', async () => {
    const u = await seedUser()
    getConnectBalanceMock.mockResolvedValueOnce({
      available:         [{ currency: 'usd', amount: 1234.56 }],
      pending:           [{ currency: 'usd', amount: 78.90 }],
      instant_available: [],
    } as any)
    const res = await request(buildApp())
      .get('/api/me/finances')
      .set('Authorization', `Bearer ${u.token}`)
    expect(res.status).toBe(200)
    expect(res.body.data.current_balance).toBe(1234.56)
    expect(res.body.data.pending_balance).toBe(78.90)
    expect(res.body.data.connect_ready).toBe(true)
  })

  it('Stripe balance call throws → endpoint still 200, balances default to 0 (does not 500)', async () => {
    const u = await seedUser()
    getConnectBalanceMock.mockRejectedValueOnce(new Error('Stripe down'))
    const res = await request(buildApp())
      .get('/api/me/finances')
      .set('Authorization', `Bearer ${u.token}`)
    expect(res.status).toBe(200)
    expect(res.body.data.current_balance).toBe(0)
    expect(res.body.data.connect_ready).toBe(true)  // toggle reflects DB, not Stripe call
  })

  it('entries: returns only own user_id rows', async () => {
    const u = await seedUser()
    const other = await seedUser()
    await db.query(
      `INSERT INTO user_balance_ledger (user_id, type, amount, balance_after, notes)
       VALUES ($1, 'allocation_owner_share', 100, 100, 'mine')`, [u.userId])
    await db.query(
      `INSERT INTO user_balance_ledger (user_id, type, amount, balance_after, notes)
       VALUES ($1, 'allocation_owner_share', 200, 200, 'theirs')`, [other.userId])

    const res = await request(buildApp())
      .get('/api/me/finances')
      .set('Authorization', `Bearer ${u.token}`)
    const notes = (res.body.data.entries as any[]).map(e => e.notes)
    expect(notes).toContain('mine')
    expect(notes).not.toContain('theirs')
  })

  it('propertyId filter: passing owned property → entries narrowed', async () => {
    const u = await seedUser()
    const c = await db.connect()
    let propertyId = ''
    try {
      await c.query('BEGIN')
      propertyId = await seedProperty(c, {
        landlordId: u.landlordId, ownerUserId: u.userId, managedByUserId: u.userId,
      })
      await c.query('COMMIT')
    } finally { c.release() }
    await db.query(
      `INSERT INTO user_balance_ledger (user_id, type, amount, balance_after, property_id, notes)
       VALUES ($1, 'allocation_owner_share', 100, 100, $2, 'same prop')`,
      [u.userId, propertyId])
    await db.query(
      `INSERT INTO user_balance_ledger (user_id, type, amount, balance_after, notes)
       VALUES ($1, 'allocation_owner_share', 50, 150, 'other prop')`, [u.userId])

    const res = await request(buildApp())
      .get(`/api/me/finances?propertyId=${propertyId}`)
      .set('Authorization', `Bearer ${u.token}`)
    const notes = (res.body.data.entries as any[]).map(e => e.notes)
    expect(notes).toContain('same prop')
    expect(notes).not.toContain('other prop')
  })

  it('propertyId filter: non-owned, non-managed property → 403', async () => {
    const u = await seedUser()
    const otherOwner = await seedUser()
    const c = await db.connect()
    let foreignPropertyId = ''
    try {
      await c.query('BEGIN')
      foreignPropertyId = await seedProperty(c, {
        landlordId: otherOwner.landlordId,
        ownerUserId: otherOwner.userId,
        managedByUserId: otherOwner.userId,
      })
      await c.query('COMMIT')
    } finally { c.release() }
    const res = await request(buildApp())
      .get(`/api/me/finances?propertyId=${foreignPropertyId}`)
      .set('Authorization', `Bearer ${u.token}`)
    expect(res.status).toBe(403)
  })

  it('propertyId filter: unknown property → 404', async () => {
    const u = await seedUser()
    const res = await request(buildApp())
      .get(`/api/me/finances?propertyId=${randomUUID()}`)
      .set('Authorization', `Bearer ${u.token}`)
    expect(res.status).toBe(404)
  })

  it('admin can pull any property without authz check', async () => {
    const admin = await seedUser({ role: 'admin' })
    const owner = await seedUser()
    const c = await db.connect()
    let propertyId = ''
    try {
      await c.query('BEGIN')
      propertyId = await seedProperty(c, {
        landlordId: owner.landlordId, ownerUserId: owner.userId,
        managedByUserId: owner.userId,
      })
      await c.query('COMMIT')
    } finally { c.release() }
    const res = await request(buildApp())
      .get(`/api/me/finances?propertyId=${propertyId}`)
      .set('Authorization', `Bearer ${admin.token}`)
    expect(res.status).toBe(200)
  })

  it('limit query coercion: ?limit=5 narrows entries to 5', async () => {
    const u = await seedUser()
    for (let i = 0; i < 10; i++) {
      await db.query(
        `INSERT INTO user_balance_ledger (user_id, type, amount, balance_after, notes)
         VALUES ($1, 'allocation_owner_share', 1, ${i + 1}, $2)`,
        [u.userId, `r${i}`])
    }
    const res = await request(buildApp())
      .get('/api/me/finances?limit=5')
      .set('Authorization', `Bearer ${u.token}`)
    expect(res.body.data.entries).toHaveLength(5)
  })

  it('back-compat: unrouted_balance=0 + per_bank=[] always returned', async () => {
    const u = await seedUser()
    const res = await request(buildApp())
      .get('/api/me/finances')
      .set('Authorization', `Bearer ${u.token}`)
    expect(res.body.data.unrouted_balance).toBe(0)
    expect(res.body.data.per_bank).toEqual([])
  })
})

// ═══════════════════════════════════════════════════════════════
//  GET /api/disbursements
// ═══════════════════════════════════════════════════════════════

describe('GET /api/disbursements', () => {
  async function seedDisbursement(args: {
    userId: string
    amount?: number
    status?: 'pending' | 'processing' | 'settled' | 'failed'
    stripePayoutId?: string
  }): Promise<string> {
    const { rows: [d] } = await db.query<{ id: string }>(
      `INSERT INTO disbursements
         (user_id, trigger_type, amount, status, stripe_payout_id)
       VALUES ($1, 'manual_on_demand', $2, $3, $4)
       RETURNING id`,
      [args.userId, args.amount ?? 100, args.status ?? 'processing',
       args.stripePayoutId ?? null])
    return d.id
  }

  it('non-admin: returns only own user_id disbursements', async () => {
    const u = await seedUser()
    const other = await seedUser()
    const mineId = await seedDisbursement({ userId: u.userId, amount: 100 })
    await seedDisbursement({ userId: other.userId, amount: 200 })

    const res = await request(buildApp())
      .get('/api/disbursements')
      .set('Authorization', `Bearer ${u.token}`)
    expect(res.status).toBe(200)
    const ids = (res.body.data as any[]).map(d => d.id)
    expect(ids).toEqual([mineId])
  })

  it('admin sees all disbursements regardless of user_id', async () => {
    const admin = await seedUser({ role: 'admin' })
    const owner = await seedUser()
    await seedDisbursement({ userId: admin.userId, amount: 100 })
    await seedDisbursement({ userId: owner.userId, amount: 200 })
    const res = await request(buildApp())
      .get('/api/disbursements')
      .set('Authorization', `Bearer ${admin.token}`)
    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(2)
  })

  it('super_admin sees all (same as admin)', async () => {
    const su = await seedUser({ role: 'super_admin' })
    const owner = await seedUser()
    await seedDisbursement({ userId: owner.userId, amount: 50 })
    const res = await request(buildApp())
      .get('/api/disbursements')
      .set('Authorization', `Bearer ${su.token}`)
    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(1)
  })

  it('orders by created_at DESC', async () => {
    const u = await seedUser()
    const older = await seedDisbursement({ userId: u.userId, amount: 50 })
    const newer = await seedDisbursement({ userId: u.userId, amount: 75 })
    // Force the timestamps to be ordered explicitly so we don't rely on
    // sub-millisecond timing.
    await db.query(
      `UPDATE disbursements SET created_at = NOW() - INTERVAL '1 hour' WHERE id = $1`,
      [older])
    const res = await request(buildApp())
      .get('/api/disbursements')
      .set('Authorization', `Bearer ${u.token}`)
    expect(res.body.data[0].id).toBe(newer)
    expect(res.body.data[1].id).toBe(older)
  })

  it('joins user shape + bank info (LEFT JOIN tolerates null bank_account_id)', async () => {
    const u = await seedUser()
    await seedDisbursement({ userId: u.userId, amount: 100 })
    const res = await request(buildApp())
      .get('/api/disbursements')
      .set('Authorization', `Bearer ${u.token}`)
    const row = res.body.data[0]
    expect(row.first_name).toBe('Test')   // from seedLandlord helper
    expect(row.last_name).toBe('Landlord')
    expect(row.bank_nickname).toBeNull()  // no bank_account_id seeded
    expect(row.bank_last4).toBeNull()
  })

  it('limit cap of 50 — adding more rows still returns ≤50', async () => {
    const u = await seedUser()
    for (let i = 0; i < 55; i++) {
      await seedDisbursement({ userId: u.userId, amount: 10 + i })
    }
    const res = await request(buildApp())
      .get('/api/disbursements')
      .set('Authorization', `Bearer ${u.token}`)
    expect(res.body.data).toHaveLength(50)
  })

  it('no auth → 401', async () => {
    const res = await request(buildApp()).get('/api/disbursements')
    expect(res.status).toBe(401)
  })
})
