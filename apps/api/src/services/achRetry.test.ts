/**
 * processAchRetries — NACHA-respecting retry cron.
 *
 * Daily job that walks `payments` rows where:
 *   - status='failed'
 *   - next_retry_at IS NOT NULL AND <= NOW()
 *   - retry_count < 2
 *   - stripe_payment_intent_id IS NOT NULL
 *
 * For each, optimistically claims (bumps retry_count, clears
 * next_retry_at, stamps last_retry_at) then fires
 * `stripe.paymentIntents.confirm`. Actual settlement comes via
 * webhook — we don't mutate status here.
 *
 * Pairs with S271 webhook tests:
 *   - charge → settle (S270)
 *   - charge → fail with retryable code (S271) — sets next_retry_at
 *   - retry cron fires (this suite) — calls confirm
 *
 * Stripe SDK mocked at lib/stripe module level. No real network
 * calls; tests assert on the confirm invocations + DB side effects.
 */

import { vi, describe, it, expect, beforeEach } from 'vitest'
import { db, getClient } from '../db'
import {
  cleanupAllSchema,
  seedLandlord, seedTenant,
  seedProperty, seedUnit,
  seedRentPayment,
} from '../test/dbHelpers'

// Mock the lib/stripe getStripe() factory. The service imports the
// helper directly; replacing it at module boundary keeps the
// fake-network surface tight.
const confirmFn = vi.fn<[string], Promise<{ id: string }>>(
  async () => ({ id: 'pi_mock' })
)
vi.mock('../lib/stripe', () => ({
  getStripe: () => ({ paymentIntents: { confirm: confirmFn } }),
}))

import { processAchRetries } from './achRetry'

beforeEach(async () => {
  await cleanupAllSchema()
  confirmFn.mockReset()
  confirmFn.mockResolvedValue({ id: 'pi_mock' } as any)
})

// ── Fixture builder ─────────────────────────────────────────────────────────

interface RetryablePaymentInput {
  paymentIntentId: string
  nextRetryAtOffsetSec?: number   // <0 = past, >0 = future, undefined = NULL
  retryCount?: number              // 0, 1, or 2
  status?: 'pending' | 'failed' | 'settled' | 'returned'
}

async function seedRetryablePayment(args: RetryablePaymentInput): Promise<string> {
  const client = await getClient()
  try {
    const { userId: ownerUserId, landlordId } = await seedLandlord(client)
    const tenantId = await seedTenant(client)
    const propertyId = await seedProperty(client, {
      landlordId, ownerUserId, managedByUserId: ownerUserId,
    })
    const unitId = await seedUnit(client, { propertyId, landlordId, rentAmount: 1000 })
    const paymentId = await seedRentPayment(client, {
      unitId, tenantId, landlordId,
      amount: 1000,
      status: args.status ?? 'failed',
      stripePaymentIntentId: args.paymentIntentId,
    })

    // Patch retry_count + next_retry_at after seed (seedRentPayment
    // doesn't expose these directly; this stays test-only so adding
    // params to the seeder for one test path isn't worth it).
    const offsetSec = args.nextRetryAtOffsetSec
    await client.query(
      `UPDATE payments
          SET retry_count   = $2,
              next_retry_at = CASE WHEN $3::int IS NULL THEN NULL
                                   ELSE NOW() + ($3 || ' seconds')::interval END
        WHERE id = $1`,
      [paymentId, args.retryCount ?? 0,
       offsetSec === undefined ? null : offsetSec]
    )
    return paymentId
  } finally {
    client.release()
  }
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('processAchRetries', () => {
  it('fires confirm for a due retry; bumps retry_count + clears next_retry_at', async () => {
    const paymentId = await seedRetryablePayment({
      paymentIntentId: 'pi_due_1',
      nextRetryAtOffsetSec: -60,  // due 60s ago
      retryCount: 0,
    })
    const res = await processAchRetries()
    expect(res.scanned).toBe(1)
    expect(res.fired).toBe(1)
    expect(res.succeeded).toBe(1)
    expect(res.failed).toBe(0)
    expect(confirmFn).toHaveBeenCalledWith('pi_due_1')

    const pay = await db.query<{
      retry_count: number
      next_retry_at: string | null
      last_retry_at: string | null
      status: string
    }>(
      `SELECT retry_count, next_retry_at, last_retry_at, status
         FROM payments WHERE id=$1`,
      [paymentId]
    )
    expect(pay.rows[0]).toMatchObject({
      retry_count: 1,
      next_retry_at: null,
      status: 'failed',  // status stays — actual settle lands via webhook
    })
    expect(pay.rows[0].last_retry_at).not.toBeNull()
  })

  it('skips not-yet-due payments (next_retry_at in future)', async () => {
    await seedRetryablePayment({
      paymentIntentId: 'pi_future_1',
      nextRetryAtOffsetSec: 3600,  // 1h from now
      retryCount: 0,
    })
    const res = await processAchRetries()
    expect(res.scanned).toBe(0)
    expect(confirmFn).not.toHaveBeenCalled()
  })

  it('skips payments with status != failed', async () => {
    await seedRetryablePayment({
      paymentIntentId: 'pi_settled_1',
      nextRetryAtOffsetSec: -60,
      retryCount: 0,
      status: 'settled',
    })
    const res = await processAchRetries()
    expect(res.scanned).toBe(0)
  })

  it('skips payments at the retry cap (retry_count >= 2)', async () => {
    await seedRetryablePayment({
      paymentIntentId: 'pi_cap_1',
      nextRetryAtOffsetSec: -60,
      retryCount: 2,
    })
    const res = await processAchRetries()
    expect(res.scanned).toBe(0)
    expect(confirmFn).not.toHaveBeenCalled()
  })

  it('skips payments without a Stripe PaymentIntent id', async () => {
    const client = await getClient()
    try {
      const { userId: ownerUserId, landlordId } = await seedLandlord(client)
      const tenantId = await seedTenant(client)
      const propertyId = await seedProperty(client, {
        landlordId, ownerUserId, managedByUserId: ownerUserId,
      })
      const unitId = await seedUnit(client, { propertyId, landlordId, rentAmount: 1000 })
      const paymentId = await seedRentPayment(client, {
        unitId, tenantId, landlordId, amount: 1000, status: 'failed',
        // intentionally no stripePaymentIntentId
      })
      await client.query(
        `UPDATE payments SET next_retry_at = NOW() - INTERVAL '1 minute' WHERE id=$1`,
        [paymentId]
      )
    } finally {
      client.release()
    }
    const res = await processAchRetries()
    expect(res.scanned).toBe(0)
  })

  it('confirm() rejection: failed++, admin notification fired, retry_count still claimed', async () => {
    confirmFn.mockRejectedValueOnce(new Error('Stripe API unavailable'))
    const paymentId = await seedRetryablePayment({
      paymentIntentId: 'pi_err_1',
      nextRetryAtOffsetSec: -60,
      retryCount: 0,
    })
    const res = await processAchRetries()
    expect(res.scanned).toBe(1)
    expect(res.fired).toBe(1)
    expect(res.succeeded).toBe(0)
    expect(res.failed).toBe(1)
    expect(res.errors).toHaveLength(1)
    expect(res.errors[0]).toMatchObject({ payment_id: paymentId })

    const pay = await db.query<{ retry_count: number; next_retry_at: string | null }>(
      `SELECT retry_count, next_retry_at FROM payments WHERE id=$1`,
      [paymentId]
    )
    // Claim runs before the confirm; retry_count is incremented even
    // when confirm throws. Prevents an infinite retry loop on a broken
    // Stripe API connection — the row exits the queue and waits for
    // the next webhook event.
    expect(pay.rows[0].retry_count).toBe(1)
    expect(pay.rows[0].next_retry_at).toBeNull()

    const notif = await db.query<{ category: string; title: string }>(
      `SELECT category, title FROM admin_notifications
        WHERE category='ach_retry_confirm_failure'`
    )
    expect(notif.rows).toHaveLength(1)
    expect(notif.rows[0].title).toMatch(/ach retry confirm failed/i)
  })

  it('processes multiple due retries in next_retry_at ASC order', async () => {
    // Two due payments, the older one first.
    const earlierId = await seedRetryablePayment({
      paymentIntentId: 'pi_first',
      nextRetryAtOffsetSec: -300,  // 5min ago
      retryCount: 0,
    })
    const laterId = await seedRetryablePayment({
      paymentIntentId: 'pi_second',
      nextRetryAtOffsetSec: -60,   // 1min ago
      retryCount: 0,
    })
    const res = await processAchRetries()
    expect(res.fired).toBe(2)
    expect(res.succeeded).toBe(2)

    // confirm called in order: earlier next_retry_at fires first
    const calls = confirmFn.mock.calls.map((c) => c[0])
    expect(calls).toEqual(['pi_first', 'pi_second'])

    const counts = await db.query<{ id: string; retry_count: number }>(
      `SELECT id, retry_count FROM payments
        WHERE id = ANY($1::uuid[])
        ORDER BY id`,
      [[earlierId, laterId]]
    )
    expect(counts.rows.every((r) => r.retry_count === 1)).toBe(true)
  })

  it('idempotent: re-running after a successful pass picks up zero rows (next_retry_at cleared)', async () => {
    await seedRetryablePayment({
      paymentIntentId: 'pi_idem_1',
      nextRetryAtOffsetSec: -60,
      retryCount: 0,
    })
    const r1 = await processAchRetries()
    expect(r1.fired).toBe(1)

    const r2 = await processAchRetries()
    expect(r2.scanned).toBe(0)
    expect(r2.fired).toBe(0)
    expect(confirmFn).toHaveBeenCalledTimes(1)  // not called again
  })
})
