/**
 * S449 route-test slice — money-flow pair:
 *   (S604: withdrawals.ts was DELETED — the manual on-demand payout route had
 *   had no UI since S574 and let a landlord pull their Connect balance outside
 *   the Tuesday batch. Its tests went with it.)
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
  transfersCreateMock,
} = vi.hoisted(() => ({
  transfersCreateMock: vi.fn(async () => ({ id: 'tr_margin_mock' } as any)),
  getConnectBalanceMock: vi.fn(async () => ({
    available:         [{ currency: 'usd', amount: 0 }],
    pending:           [{ currency: 'usd', amount: 0 }],
    instant_available: [{ currency: 'usd', amount: 0 }],
  } as any)),
  firePayoutMock: vi.fn(async () => ({ id: 'po_default_mock' } as any)),
}))

// S553: the W-32 (S531) instant-margin path calls the real Stripe SDK
// (transfers.create + accounts.retrieve) — unmocked, these tests hit LIVE
// Stripe with .env keys and 403'd. Mock the SDK surface the route touches.
vi.mock('../lib/stripe', () => ({
  getStripe: () => ({
    transfers: { create: transfersCreateMock, createReversal: vi.fn(async () => ({ id: 'trr_mock' })) },
    accounts:  { retrieve: vi.fn(async () => ({ id: 'acct_platform_mock' })) },
  }),
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

  it('S567: a regular admin sees ONLY disbursements to landlords they manage, not all', async () => {
    // S567 (portfolio-manager scoping): a regular admin is a portfolio/service
    // manager who sees only payouts to landlords they close or service — super
    // sees all (covered by the next test). This supersedes the pre-S567 "admin
    // sees every disbursement" behavior this test used to assert.
    const admin = await seedUser({ role: 'admin' })
    const managed = await seedUser()     // a landlord this admin manages
    const unrelated = await seedUser()   // a landlord this admin does NOT manage
    await db.query(`UPDATE landlords SET portfolio_manager_id = $1 WHERE id = $2`,
      [admin.userId, managed.landlordId])
    const managedDisb = await seedDisbursement({ userId: managed.userId, amount: 100 })
    await seedDisbursement({ userId: unrelated.userId, amount: 200 })

    const res = await request(buildApp())
      .get('/api/disbursements')
      .set('Authorization', `Bearer ${admin.token}`)
    expect(res.status).toBe(200)
    const ids = (res.body.data as any[]).map(d => d.id)
    expect(ids).toEqual([managedDisb])   // the managed landlord's payout only
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
