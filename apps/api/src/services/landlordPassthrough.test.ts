/**
 * S428 services-audit slice 5c (of 3): landlordPassthrough.ts.
 *
 * `reconcilePlatformHeldPayments(landlordUserId)` aggregates unfired
 * `allocation_owner_share` ledger rows for a landlord and fires a
 * Stripe Connect Transfer to their Connect account, then flips
 * payments.platform_held=FALSE.
 *
 * Tests focus on the no-op edge cases and the happy path (with a
 * mocked Stripe Transfer). Failure-rollback path is implicitly
 * covered — if the transaction fails, the function throws and the
 * caller (Stripe webhook) decides how to handle.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

const transferMock = vi.hoisted(() =>
  vi.fn(async () => ({ id: 'tr_mock_' + Math.random().toString(36).slice(2, 8) }))
)
const adminNotifyMock = vi.hoisted(() => vi.fn(async () => undefined))

vi.mock('./stripeConnect', () => ({
  createPmCompanyTransfer: transferMock,
}))
vi.mock('./adminNotifications', () => ({
  createAdminNotification: adminNotifyMock,
}))

import { db } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedTenant } from '../test/dbHelpers'
import { reconcilePlatformHeldPayments, tryReconcileForLandlordUserId } from './landlordPassthrough'

beforeEach(async () => {
  await cleanupAllSchema()
  transferMock.mockClear()
  adminNotifyMock.mockClear()
  transferMock.mockResolvedValue({ id: 'tr_mock_default' } as any)
})

interface Ctx {
  landlordUserId: string
  landlordId:     string
  unitId:         string
  tenantId:       string
  paymentId:      string
}

async function seedCtx(opts: { connectAccount?: string | null } = {}): Promise<Ctx> {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const { userId: landlordUserId, landlordId } = await seedLandlord(c)
    const propertyId = await seedProperty(c, {
      landlordId, ownerUserId: landlordUserId, managedByUserId: landlordUserId,
    })
    const unitId = await seedUnit(c, { propertyId, landlordId })
    const tenantId = await seedTenant(c)
    await c.query(
      `UPDATE users SET stripe_connect_account_id=$1 WHERE id=$2`,
      [opts.connectAccount === undefined ? 'acct_test_s428' : opts.connectAccount,
       landlordUserId])
    // Seed a settled, platform_held rent payment.
    const { rows: [{ id: paymentId }] } = await c.query<{ id: string }>(
      `INSERT INTO payments
         (unit_id, tenant_id, landlord_id, type, amount, status,
          entry_description, due_date, platform_held, settled_at)
       VALUES ($1, $2, $3, 'rent', 1000, 'settled', 'RENT', CURRENT_DATE,
               TRUE, NOW()) RETURNING id`,
      [unitId, tenantId, landlordId])
    await c.query('COMMIT')
    return { landlordUserId, landlordId, unitId, tenantId, paymentId }
  } catch (e) { await c.query('ROLLBACK'); throw e }
  finally { c.release() }
}

async function seedOwnerShareLedger(ctx: Ctx, amount: number): Promise<void> {
  await db.query(
    `INSERT INTO user_balance_ledger
       (user_id, type, amount, balance_after, reference_id, reference_type, notes)
     VALUES ($1, 'allocation_owner_share', $2, $2, $3, 'payment',
             'S428 test allocation')`,
    [ctx.landlordUserId, amount, ctx.paymentId])
}

describe('reconcilePlatformHeldPayments', () => {
  it('unknown user (no landlords row) → noop, no Stripe call', async () => {
    const res = await reconcilePlatformHeldPayments(
      '00000000-0000-0000-0000-000000000000')
    expect(res).toEqual({ attempted: false, payments_settled: 0, transfer_id: null, amount: 0 })
    expect(transferMock).not.toHaveBeenCalled()
  })

  it('landlord with no Connect account → noop', async () => {
    const ctx = await seedCtx({ connectAccount: null })
    await seedOwnerShareLedger(ctx, 950)
    const res = await reconcilePlatformHeldPayments(ctx.landlordUserId)
    expect(res.attempted).toBe(false)
    expect(transferMock).not.toHaveBeenCalled()
  })

  it('no unfired owner_share rows → noop', async () => {
    const ctx = await seedCtx()
    // No ledger rows seeded.
    const res = await reconcilePlatformHeldPayments(ctx.landlordUserId)
    expect(res.attempted).toBe(false)
    expect(transferMock).not.toHaveBeenCalled()
    // Payment.platform_held stays TRUE.
    const { rows: [p] } = await db.query<any>(
      `SELECT platform_held FROM payments WHERE id=$1`, [ctx.paymentId])
    expect(p.platform_held).toBe(true)
  })

  it('happy: aggregates owed + fires Transfer + flips platform_held + stamps stripe_transfer_id', async () => {
    const ctx = await seedCtx()
    await seedOwnerShareLedger(ctx, 950)
    transferMock.mockResolvedValueOnce({ id: 'tr_happy_path_test' } as any)
    const res = await reconcilePlatformHeldPayments(ctx.landlordUserId)
    expect(res.attempted).toBe(true)
    expect(res.amount).toBe(950)
    expect(res.transfer_id).toBe('tr_happy_path_test')
    expect(res.payments_settled).toBe(1)
    // Stripe was called with the owed amount + correct destination + metadata.
    expect(transferMock).toHaveBeenCalledWith(expect.objectContaining({
      amount: 950,
      destinationConnectAccountId: 'acct_test_s428',
      metadata: expect.objectContaining({
        gam_kind: 'platform_held_passthrough',
        gam_landlord_id: ctx.landlordId,
        gam_landlord_user_id: ctx.landlordUserId,
      }),
    }))
    // Ledger row stamped with the transfer id.
    const { rows: [l] } = await db.query<any>(
      `SELECT stripe_transfer_id FROM user_balance_ledger
        WHERE user_id=$1 AND type='allocation_owner_share'`,
      [ctx.landlordUserId])
    expect(l.stripe_transfer_id).toBe('tr_happy_path_test')
    // Payment row flipped to platform_held=FALSE.
    const { rows: [p] } = await db.query<any>(
      `SELECT platform_held FROM payments WHERE id=$1`, [ctx.paymentId])
    expect(p.platform_held).toBe(false)
  })

  it('already-fired ledger row (stripe_transfer_id NOT NULL) is excluded from sum', async () => {
    const ctx = await seedCtx()
    // Seed a second platform_held payment so the two ledger rows have
    // distinct (reference_id, reference_type, type) tuples — the
    // ux_user_balance_ledger_idempotent UNIQUE blocks duplicates.
    // Different due_date to dodge the S414 partial UNIQUE on
    // (unit_id, due_date) WHERE type='rent' AND status NOT IN ('failed','returned').
    const { rows: [{ id: paymentId2 }] } = await db.query<{ id: string }>(
      `INSERT INTO payments
         (unit_id, tenant_id, landlord_id, type, amount, status,
          entry_description, due_date, platform_held, settled_at)
       VALUES ($1, $2, $3, 'rent', 500, 'settled', 'RENT',
               CURRENT_DATE - INTERVAL '1 month',
               TRUE, NOW()) RETURNING id`,
      [ctx.unitId, ctx.tenantId, ctx.landlordId])
    // Already-fired row → distinct payment_id; should NOT count.
    await db.query(
      `INSERT INTO user_balance_ledger
         (user_id, type, amount, balance_after, reference_id, reference_type, notes, stripe_transfer_id)
       VALUES ($1, 'allocation_owner_share', 500, 500, $2, 'payment',
               'already fired', 'tr_prior')`,
      [ctx.landlordUserId, paymentId2])
    await seedOwnerShareLedger(ctx, 450)  // unfired against ctx.paymentId
    transferMock.mockResolvedValueOnce({ id: 'tr_just_the_450' } as any)
    const res = await reconcilePlatformHeldPayments(ctx.landlordUserId)
    expect(res.amount).toBe(450)  // not 950
    expect(transferMock).toHaveBeenCalledWith(expect.objectContaining({ amount: 450 }))
  })

  it('Stripe Transfer failure → admin-notification + re-throw', async () => {
    const ctx = await seedCtx()
    await seedOwnerShareLedger(ctx, 950)
    transferMock.mockRejectedValueOnce(new Error('Stripe is down'))
    await expect(reconcilePlatformHeldPayments(ctx.landlordUserId))
      .rejects.toThrow(/Stripe is down/)
    expect(adminNotifyMock).toHaveBeenCalledWith(expect.objectContaining({
      severity: 'critical',
      category: 'platform_held_reconciliation_failed',
    }))
    // payments.platform_held stays TRUE because the transaction rolled back.
    const { rows: [p] } = await db.query<any>(
      `SELECT platform_held FROM payments WHERE id=$1`, [ctx.paymentId])
    expect(p.platform_held).toBe(true)
  })
})

describe('tryReconcileForLandlordUserId', () => {
  it('swallows errors (best-effort hook)', async () => {
    const ctx = await seedCtx()
    await seedOwnerShareLedger(ctx, 100)
    transferMock.mockRejectedValueOnce(new Error('Stripe down'))
    // Should NOT throw — the function is the webhook entry point.
    await expect(tryReconcileForLandlordUserId(ctx.landlordUserId))
      .resolves.toBeUndefined()
  })
})
