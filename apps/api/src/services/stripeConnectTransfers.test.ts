/**
 * Stripe Transfer-firing helpers — `fireManagerTransfersForReference`.
 *
 * Mocks the Stripe SDK at module level so transfers.create is a vi.fn()
 * we can configure per-test. Exercises the three branches:
 *   - happy: manager with Connect account → Stripe call succeeds →
 *     ledger row gets `stripe_transfer_id` stamped
 *   - no Connect account: manager hasn't onboarded → silent skip
 *     (no Stripe call, no admin notification, no ledger update)
 *   - Stripe API error: transfer.create throws → admin notification
 *     created, ledger row stays unfired for reconciliation to retry
 *
 * The S113 PM company path (`firePmTransfersForReference`) follows the
 * same shape; the patterns here transfer directly if/when we extend
 * coverage to that helper.
 */

import { vi, describe, it, expect, beforeEach } from 'vitest'

vi.mock('stripe', () => {
  const transfersCreate = vi.fn(async () => ({ id: 'tr_mock' }))
  function FakeStripe(this: any) {
    this.transfers = { create: transfersCreate }
    // The module also reads accounts / payouts via Stripe in other
    // helpers; stub them with no-op vi.fns so any incidental import
    // chain doesn't blow up.
    this.accounts = { create: vi.fn(), retrieve: vi.fn() }
    this.accountSessions = { create: vi.fn() }
    this.payouts = { list: vi.fn(), retrieve: vi.fn() }
  }
  ;(FakeStripe as any).__mocks = { transfersCreate }
  return { default: FakeStripe }
})

import Stripe from 'stripe'
import { db, getClient } from '../db'
import { fireManagerTransfersForReference } from './stripeConnect'
import {
  cleanupAllSchema,
  seedLandlord, seedManager,
  seedProperty,
} from '../test/dbHelpers'

const stripeMocks: { transfersCreate: ReturnType<typeof vi.fn> } =
  (Stripe as any).__mocks

beforeEach(async () => {
  await cleanupAllSchema()
  stripeMocks.transfersCreate.mockReset()
  stripeMocks.transfersCreate.mockResolvedValue({ id: 'tr_mock' } as any)
  // The Stripe SDK constructor reads STRIPE_SECRET_KEY in lib/stripe.ts
  // via getStripe(); the mock doesn't actually read it but the FakeStripe
  // constructor body does run, so keep a value present.
  process.env.STRIPE_SECRET_KEY = 'sk_test_mocked'
})

/**
 * Seed an unfired `allocation_manager_fee` ledger row tagged to the
 * given reference_type / reference_id. Returns the ledger row id +
 * the manager user id (caller may UPDATE stripe_connect_account_id
 * on it to flip into the happy or error branches).
 */
async function seedManagerFeeLedgerRow(args: {
  referenceType: 'monthly_fee_accrual' | 'payment'
  amount?: number
}): Promise<{ ledgerId: string; managerUserId: string; referenceId: string }> {
  const client = await getClient()
  try {
    const { userId: ownerUserId, landlordId } = await seedLandlord(client)
    const managerUserId = await seedManager(client)
    const propertyId = await seedProperty(client, {
      landlordId, ownerUserId, managedByUserId: managerUserId,
    })

    // Reference row — either a monthly_fee_accruals row (when type=
    // 'monthly_fee_accrual') or a payments row (when type='payment').
    // Tests use 'monthly_fee_accrual' so funds source from platform
    // balance (no charge id lookup).
    let referenceId: string
    if (args.referenceType === 'monthly_fee_accrual') {
      const r = await client.query<{ id: string }>(
        `INSERT INTO monthly_fee_accruals
           (property_id, accrual_month, flat_monthly_fee, per_unit_fee,
            occupied_unit_count, total_amount, manager_user_id)
         VALUES ($1, '2026-05-01', $2, 0, 1, $2, $3)
         RETURNING id`,
        [propertyId, args.amount ?? 60, managerUserId]
      )
      referenceId = r.rows[0].id
    } else {
      throw new Error('payment branch not used in these tests')
    }

    const ledgerRes = await client.query<{ id: string }>(
      `INSERT INTO user_balance_ledger
         (user_id, type, amount, balance_after, reference_id, reference_type,
          property_id, notes)
       VALUES ($1, 'allocation_manager_fee', $2, $2, $3, $4, $5,
               'Test manager fee')
       RETURNING id`,
      [managerUserId, args.amount ?? 60, referenceId,
       args.referenceType, propertyId]
    )
    return {
      ledgerId:      ledgerRes.rows[0].id,
      managerUserId,
      referenceId,
    }
  } finally {
    client.release()
  }
}

describe('fireManagerTransfersForReference', () => {
  it('happy: manager with Connect account → Stripe call succeeds, stripe_transfer_id stamped', async () => {
    const seed = await seedManagerFeeLedgerRow({
      referenceType: 'monthly_fee_accrual', amount: 60,
    })
    await db.query(
      `UPDATE users SET stripe_connect_account_id = $1 WHERE id = $2`,
      ['acct_manager_happy_1', seed.managerUserId]
    )
    stripeMocks.transfersCreate.mockResolvedValueOnce({ id: 'tr_happy_1' } as any)

    const result = await fireManagerTransfersForReference(
      'monthly_fee_accrual', seed.referenceId
    )
    expect(result).toEqual({ fired: 1, failed: 0 })

    expect(stripeMocks.transfersCreate).toHaveBeenCalledTimes(1)
    const call = stripeMocks.transfersCreate.mock.calls[0][0]
    expect(call).toMatchObject({
      amount:      6000,  // $60 → 6000 cents
      currency:    'usd',
      destination: 'acct_manager_happy_1',
    })
    expect(call.metadata).toMatchObject({
      gam_ledger_id:      seed.ledgerId,
      gam_reference_id:   seed.referenceId,
      gam_reference_type: 'monthly_fee_accrual',
      gam_fee_kind:       'in_house_manager_fee',
    })

    // Ledger row stamped.
    const row = await db.query<{ stripe_transfer_id: string | null }>(
      `SELECT stripe_transfer_id FROM user_balance_ledger WHERE id=$1`,
      [seed.ledgerId]
    )
    expect(row.rows[0].stripe_transfer_id).toBe('tr_happy_1')
  })

  it('no Connect account: skip silently, no Stripe call, no admin notification', async () => {
    const seed = await seedManagerFeeLedgerRow({
      referenceType: 'monthly_fee_accrual', amount: 50,
    })
    // Leave stripe_connect_account_id NULL (default from seedManager).

    const result = await fireManagerTransfersForReference(
      'monthly_fee_accrual', seed.referenceId
    )
    // The function continues the loop without incrementing either
    // counter on this branch — `fired` and `failed` both stay 0.
    expect(result).toEqual({ fired: 0, failed: 0 })
    expect(stripeMocks.transfersCreate).not.toHaveBeenCalled()

    // Ledger row untouched — reconciliation cron will retry.
    const row = await db.query<{ stripe_transfer_id: string | null }>(
      `SELECT stripe_transfer_id FROM user_balance_ledger WHERE id=$1`,
      [seed.ledgerId]
    )
    expect(row.rows[0].stripe_transfer_id).toBeNull()

    // No admin notification — this is a benign skip, not a failure.
    const notif = await db.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM admin_notifications
        WHERE category = 'manager_transfer_failed'`
    )
    expect(notif.rows[0].n).toBe('0')
  })

  it('Stripe API error: admin notification fired, ledger row stays unfired, failed++', async () => {
    const seed = await seedManagerFeeLedgerRow({
      referenceType: 'monthly_fee_accrual', amount: 75,
    })
    await db.query(
      `UPDATE users SET stripe_connect_account_id = $1 WHERE id = $2`,
      ['acct_manager_err_1', seed.managerUserId]
    )
    stripeMocks.transfersCreate.mockRejectedValueOnce(
      new Error('Stripe insufficient funds')
    )

    const result = await fireManagerTransfersForReference(
      'monthly_fee_accrual', seed.referenceId
    )
    expect(result).toEqual({ fired: 0, failed: 1 })

    // Ledger row stays without a transfer id — reconciliation retries.
    const row = await db.query<{ stripe_transfer_id: string | null }>(
      `SELECT stripe_transfer_id FROM user_balance_ledger WHERE id=$1`,
      [seed.ledgerId]
    )
    expect(row.rows[0].stripe_transfer_id).toBeNull()

    // Admin notification surfaces the failure with the ledger context.
    const notif = await db.query<{
      severity: string; category: string; title: string; body: string
    }>(
      `SELECT severity, category, title, body FROM admin_notifications
        WHERE category = 'manager_transfer_failed'`
    )
    expect(notif.rows).toHaveLength(1)
    expect(notif.rows[0]).toMatchObject({
      severity: 'warn',
      category: 'manager_transfer_failed',
    })
    expect(notif.rows[0].title).toContain(seed.ledgerId)
    expect(notif.rows[0].body).toMatch(/insufficient funds/i)
  })

  it('idempotent: already-fired rows (stripe_transfer_id set) get skipped', async () => {
    const seed = await seedManagerFeeLedgerRow({
      referenceType: 'monthly_fee_accrual', amount: 60,
    })
    await db.query(
      `UPDATE users SET stripe_connect_account_id = $1 WHERE id = $2`,
      ['acct_manager_idem_1', seed.managerUserId]
    )
    // Pre-stamp the ledger row — first fire is a no-op, second confirms
    // the SELECT filter excludes rows that already have a transfer id.
    await db.query(
      `UPDATE user_balance_ledger SET stripe_transfer_id = 'tr_prefired'
        WHERE id = $1`,
      [seed.ledgerId]
    )

    const result = await fireManagerTransfersForReference(
      'monthly_fee_accrual', seed.referenceId
    )
    expect(result).toEqual({ fired: 0, failed: 0 })
    expect(stripeMocks.transfersCreate).not.toHaveBeenCalled()

    // Original transfer id preserved.
    const row = await db.query<{ stripe_transfer_id: string | null }>(
      `SELECT stripe_transfer_id FROM user_balance_ledger WHERE id=$1`,
      [seed.ledgerId]
    )
    expect(row.rows[0].stripe_transfer_id).toBe('tr_prefired')
  })
})
